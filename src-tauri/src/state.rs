use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use tokio::sync::Mutex;

pub const GIB: u64 = 1024 * 1024 * 1024;
pub const MAX_COMPRESSED_PAGE_CACHE_BYTES: usize = GIB as usize;
const MIB: u64 = 1024 * 1024;
const MEMORY_SAFE_RATIO_NUMERATOR: u64 = 1;
const MEMORY_SAFE_RATIO_DENOMINATOR: u64 = 2;
const NORMAL_RECOVERY_STEP_BYTES: usize = 64 * 1024 * 1024;

/// OS memory pressure is deliberately kept separate from the free-memory
/// probe.  The latter is only an input to the budget, never the sole signal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MemoryPressure {
    Normal = 0,
    Warning = 1,
    Critical = 2,
}

impl MemoryPressure {
    pub fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Warning,
            2 => Self::Critical,
            _ => Self::Normal,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryBudgetInputs {
    pub physical_memory_bytes: u64,
    pub process_available_memory_bytes: u64,
    pub pressure: MemoryPressure,
}

/// Device tier is a limit, not a promise to consume that amount of RAM.
/// Keeping the 8 GiB tier at the 1 GiB ceiling prevents a large preload from
/// becoming an OOM vector on iOS while still allowing larger devices to use it.
pub const fn device_cache_budget(physical_memory_bytes: u64) -> usize {
    let budget = if physical_memory_bytes < 6 * GIB {
        256 * MIB
    } else if physical_memory_bytes < 8 * GIB {
        512 * MIB
    } else {
        MAX_COMPRESSED_PAGE_CACHE_BYTES as u64
    };
    if budget > MAX_COMPRESSED_PAGE_CACHE_BYTES as u64 {
        MAX_COMPRESSED_PAGE_CACHE_BYTES
    } else {
        budget as usize
    }
}

pub const fn pressure_cache_budget(device_budget: usize, pressure: MemoryPressure) -> usize {
    match pressure {
        MemoryPressure::Normal => device_budget,
        MemoryPressure::Warning => device_budget / 2,
        MemoryPressure::Critical => 0,
    }
}

/// Pure budget policy.  A process-level advisory signal is reduced by half
/// to leave room for WebKit, decoding and the rest of the application.
pub fn calculate_memory_budget(inputs: MemoryBudgetInputs) -> usize {
    let device_budget = device_cache_budget(inputs.physical_memory_bytes);
    let process_safe_budget = inputs
        .process_available_memory_bytes
        .saturating_mul(MEMORY_SAFE_RATIO_NUMERATOR)
        / MEMORY_SAFE_RATIO_DENOMINATOR;
    let process_safe_budget = if process_safe_budget > usize::MAX as u64 {
        usize::MAX
    } else {
        process_safe_budget as usize
    };
    std::cmp::min(
        std::cmp::min(device_budget, process_safe_budget),
        std::cmp::min(
            pressure_cache_budget(device_budget, inputs.pressure),
            MAX_COMPRESSED_PAGE_CACHE_BYTES,
        ),
    )
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn physical_memory_bytes() -> Option<u64> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_void};

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }

    let name = CString::new("hw.memsize").ok()?;
    let mut value = 0_u64;
    let mut length = std::mem::size_of::<u64>();
    let result = unsafe {
        sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    (result == 0 && length == std::mem::size_of::<u64>() && value > 0).then_some(value)
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn physical_memory_bytes() -> Option<u64> {
    // Total RAM is used only for tier selection.  We intentionally do not use
    // MemAvailable/free RAM as the process budget on non-Apple platforms.
    let total = std::fs::read_to_string("/proc/meminfo")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:")?.split_whitespace().next())?
        .parse::<u64>()
        .ok()?;
    total.checked_mul(1024)
}

#[cfg(any(target_os = "ios", target_os = "macos"))]
fn process_available_memory_bytes() -> Option<u64> {
    // Apple documents this as an advisory estimate of the bytes the process
    // can allocate before hitting its memory limit; unlike free RAM it is
    // process-scoped and accounts for the platform's memory policy.
    unsafe extern "C" {
        fn os_proc_available_memory() -> usize;
    }
    let available = unsafe { os_proc_available_memory() as u64 };
    // A zero result means that the advisory is unavailable on this OS/build;
    // use the conservative non-Apple-style fallback rather than permanently
    // disabling preload.  A real low-memory notification still enters the
    // critical path through the native pressure bridge.
    (available > 0).then_some(available)
}

#[cfg(not(any(target_os = "ios", target_os = "macos")))]
fn process_available_memory_bytes() -> Option<u64> {
    // A cgroup limit/current pair is the closest process/container-scoped
    // signal available without adding a platform dependency.  If unavailable
    // we fall back to a deliberately conservative quarter of total RAM.
    let max = std::fs::read_to_string("/sys/fs/cgroup/memory.max").ok()?;
    let max = max.trim().parse::<u64>().ok()?;
    let current = std::fs::read_to_string("/sys/fs/cgroup/memory.current")
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(max.saturating_sub(current))
}

pub fn measured_memory_budget(pressure: MemoryPressure) -> usize {
    let physical = physical_memory_bytes().unwrap_or(4 * GIB);
    let available = process_available_memory_bytes().unwrap_or(physical / 4);
    calculate_memory_budget(MemoryBudgetInputs {
        physical_memory_bytes: physical,
        process_available_memory_bytes: available,
        pressure,
    })
}

static APP_STATE: OnceLock<StdMutex<Weak<AppState>>> = OnceLock::new();

/// Installs the process state used by the iOS memory-pressure callback.
pub fn register_process_state(state: &Arc<AppState>) {
    let slot = APP_STATE.get_or_init(|| StdMutex::new(Weak::new()));
    if let Ok(mut registered) = slot.lock() {
        *registered = Arc::downgrade(state);
    }
}

/// Called by the native iOS Dispatch memory-pressure bridge.
#[no_mangle]
pub extern "C" fn gai_memory_pressure(level: u8) {
    let Some(slot) = APP_STATE.get() else { return };
    let Ok(registered) = slot.lock() else { return };
    if let Some(state) = registered.upgrade() {
        state.set_memory_pressure(MemoryPressure::from_raw(level));
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub current_page: usize,
    pub total_pages: usize,
    pub percent: f64,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComicItem {
    pub id: String,
    pub r#type: String, // "folder" or "archive"
    pub relative_path: String,
    pub ext: String,
    pub title: String,
    pub series: String,
    pub updated_at: String, // ISO8601 String
    pub page_count: usize,
    pub progress: Progress,
    #[serde(default = "default_source_id")]
    pub source_id: String,
    #[serde(skip)]
    pub source_path: Option<String>,
    #[serde(skip)]
    pub external_bookmark: Option<String>,
}

fn default_source_id() -> String {
    "local".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub is_scanning: bool,
    pub found: usize,
    pub current_path: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SmbConfig {
    pub host: String,
    pub share: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl std::fmt::Debug for SmbConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmbConfig")
            .field("host", &self.host)
            .field("share", &self.share)
            .field("username", &self.username.as_ref().map(|_| "***"))
            .field("password", &self.password.as_ref().map(|_| "***"))
            .finish()
    }
}

#[derive(Debug, Default, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineServicesConfig {
    #[serde(default)]
    pub source_matching_enabled: bool,
    #[serde(default)]
    pub translation_enabled: bool,
    #[serde(default)]
    pub sync_enabled: bool,
    #[serde(default)]
    pub opds_server_enabled: bool,
    pub endpoint: Option<String>,
    #[serde(default)]
    pub disclosure_accepted: bool,
}

impl OnlineServicesConfig {
    pub fn validate(self) -> Result<Self, String> {
        let enabled = self.source_matching_enabled
            || self.translation_enabled
            || self.sync_enabled
            || self.opds_server_enabled;
        if enabled && !self.disclosure_accepted {
            return Err("啟用線上服務前必須明確同意資料揭露".into());
        }
        if (self.source_matching_enabled || self.translation_enabled || self.sync_enabled)
            && self.endpoint.as_deref().is_none_or(str::is_empty)
        {
            return Err("線上比對、翻譯或同步服務必須指定 endpoint".into());
        }
        Ok(self)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExternalBookmark {
    pub bookmark: String,
    pub name: String,
}

#[derive(Clone)]
pub struct AiSessionConfig {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub google_content_disclosure: bool,
}

pub struct AppState {
    pub scan_dir: std::sync::RwLock<String>,
    pub comics: Mutex<Vec<ComicItem>>,
    // BUG-13 修正：移除從未使用的 progress_data 欄位，避免混淆維護者
    pub scan_progress: Mutex<ScanProgress>,
    pub scan_generation: std::sync::atomic::AtomicU64,
    pub scan_lifecycle: Mutex<()>,
    pub preload_generation: std::sync::atomic::AtomicU64,
    /// Native memory pressure is an independent signal from available bytes.
    pub memory_pressure: AtomicU8,
    /// Effective budget is ramped up after normal pressure to avoid a burst
    /// allocation immediately after an iOS warning.
    pub cache_budget_bytes: AtomicUsize,
    // (comic_id, page_index) -> byte array
    pub ram_cache_pool: std::sync::Mutex<HashMap<String, HashMap<usize, Vec<u8>>>>,
    // (comic_id) -> list of entry paths (for folder) or names (for archive)
    pub opened_comic_files: std::sync::RwLock<HashMap<String, Vec<String>>>,
    pub smb_config: std::sync::RwLock<Option<SmbConfig>>,
    pub external_bookmarks: std::sync::RwLock<Vec<ExternalBookmark>>,
    pub progress_file_lock: tokio::sync::Mutex<()>,
    pub active_bookmarks: std::sync::Mutex<HashMap<String, String>>,
    pub active_comic_id: std::sync::Mutex<Option<String>>,
    pub pending_open_id: std::sync::Mutex<Option<String>>,
    pub comic_lifecycle: std::sync::Mutex<()>,
    pub file_lifecycle: tokio::sync::Mutex<()>,
    pub reader_generation: std::sync::atomic::AtomicU64,
    pub catalog: std::sync::RwLock<Option<crate::catalog::CatalogStore>>,
    pub catalog_sync: tokio::sync::Mutex<()>,
    pub online_services: std::sync::RwLock<OnlineServicesConfig>,
    /// Session-only by design: API keys never enter SQLite, localStorage, logs, or exports.
    pub ai_session: std::sync::RwLock<Option<AiSessionConfig>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            scan_dir: std::sync::RwLock::new(String::new()),
            comics: Mutex::new(Vec::new()),
            scan_progress: Mutex::new(ScanProgress {
                is_scanning: false,
                found: 0,
                current_path: String::new(),
                started_at: None,
                completed_at: None,
            }),
            scan_generation: std::sync::atomic::AtomicU64::new(0),
            scan_lifecycle: Mutex::new(()),
            preload_generation: std::sync::atomic::AtomicU64::new(0),
            memory_pressure: AtomicU8::new(MemoryPressure::Normal as u8),
            // Start with the live device/process budget. Only recovery after
            // a pressure event ramps in 64 MiB steps.
            cache_budget_bytes: AtomicUsize::new(measured_memory_budget(MemoryPressure::Normal)),
            ram_cache_pool: std::sync::Mutex::new(HashMap::new()),
            opened_comic_files: std::sync::RwLock::new(HashMap::new()),
            smb_config: std::sync::RwLock::new(None),
            external_bookmarks: std::sync::RwLock::new(Vec::new()),
            progress_file_lock: tokio::sync::Mutex::new(()),
            active_bookmarks: std::sync::Mutex::new(HashMap::new()),
            active_comic_id: std::sync::Mutex::new(None),
            pending_open_id: std::sync::Mutex::new(None),
            comic_lifecycle: std::sync::Mutex::new(()),
            file_lifecycle: tokio::sync::Mutex::new(()),
            reader_generation: std::sync::atomic::AtomicU64::new(0),
            catalog: std::sync::RwLock::new(None),
            catalog_sync: tokio::sync::Mutex::new(()),
            online_services: std::sync::RwLock::new(OnlineServicesConfig::default()),
            ai_session: std::sync::RwLock::new(None),
        }
    }

    pub fn memory_pressure_level(&self) -> MemoryPressure {
        MemoryPressure::from_raw(self.memory_pressure.load(Ordering::Acquire))
    }

    pub fn current_cache_budget_bytes(&self) -> usize {
        self.cache_budget_bytes.load(Ordering::Acquire)
    }

    /// Refreshes the budget from live platform signals.  Downward changes are
    /// immediate; recovery is deliberately capped to a small step per call.
    pub fn refresh_cache_budget(&self) -> usize {
        let pressure = self.memory_pressure_level();
        let desired = measured_memory_budget(pressure);
        let current = self.current_cache_budget_bytes();
        let next = match pressure {
            MemoryPressure::Critical => 0,
            MemoryPressure::Warning => desired,
            MemoryPressure::Normal if desired > current => current
                .saturating_add(NORMAL_RECOVERY_STEP_BYTES)
                .min(desired),
            MemoryPressure::Normal => desired,
        };
        self.cache_budget_bytes.store(next, Ordering::Release);
        if next < current {
            let _lifecycle = self.comic_lifecycle.lock().unwrap();
            self.trim_cache_to_budget_locked(next);
        }
        next
    }

    pub fn set_memory_pressure(&self, pressure: MemoryPressure) {
        let previous = self.memory_pressure.swap(pressure as u8, Ordering::AcqRel);
        let desired = measured_memory_budget(pressure);
        let current = self.current_cache_budget_bytes();
        let next = match pressure {
            MemoryPressure::Critical => 0,
            // Do not jump back to the full budget on a normal notification;
            // refresh_cache_budget will add one recovery step at a time.
            MemoryPressure::Normal => current.min(desired),
            MemoryPressure::Warning => desired,
        };
        self.cache_budget_bytes.store(next, Ordering::Release);

        if pressure == MemoryPressure::Critical
            && MemoryPressure::from_raw(previous) != MemoryPressure::Critical
        {
            // Take the same lifecycle lock as open/close/preload insertion so
            // an in-flight preload cannot repopulate a cache after cleanup.
            let _lifecycle = self.comic_lifecycle.lock().unwrap();
            self.ram_cache_pool.lock().unwrap().clear();
            self.preload_generation.fetch_add(1, Ordering::SeqCst);
        } else if next < current {
            let _lifecycle = self.comic_lifecycle.lock().unwrap();
            self.trim_cache_to_budget_locked(next);
        }
    }

    fn trim_cache_to_budget_locked(&self, budget: usize) {
        let mut pool = self.ram_cache_pool.lock().unwrap();
        let mut total = pool
            .values()
            .flat_map(|pages| pages.values())
            .map(Vec::len)
            .sum::<usize>();
        while total > budget {
            let candidate = pool
                .iter()
                .flat_map(|(id, pages)| {
                    pages
                        .iter()
                        .map(move |(page_index, bytes)| (bytes.len(), id.clone(), *page_index))
                })
                .max_by_key(|(bytes, _, _)| *bytes);
            let Some((bytes, id, page_index)) = candidate else {
                break;
            };
            if pool
                .get_mut(&id)
                .and_then(|pages| pages.remove(&page_index))
                .is_some()
            {
                total = total.saturating_sub(bytes);
            } else {
                break;
            }
        }
        pool.retain(|_, pages| !pages.is_empty());
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        calculate_memory_budget, device_cache_budget, MemoryBudgetInputs, MemoryPressure,
        OnlineServicesConfig, GIB, MAX_COMPRESSED_PAGE_CACHE_BYTES,
    };

    #[test]
    fn online_services_are_off_by_default_and_require_disclosure() {
        let defaults = OnlineServicesConfig::default();
        assert!(!defaults.source_matching_enabled);
        assert!(!defaults.translation_enabled);
        assert!(!defaults.sync_enabled);
        assert!(!defaults.opds_server_enabled);
        let invalid = OnlineServicesConfig {
            source_matching_enabled: true,
            endpoint: Some("https://example.invalid".into()),
            ..Default::default()
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn device_tiers_grow_monotonically_and_never_exceed_one_gib() {
        assert_eq!(device_cache_budget(4 * GIB), 256 * 1024 * 1024);
        assert_eq!(device_cache_budget(6 * GIB), 512 * 1024 * 1024);
        assert_eq!(
            device_cache_budget(8 * GIB),
            MAX_COMPRESSED_PAGE_CACHE_BYTES
        );
        assert_eq!(
            device_cache_budget(16 * GIB),
            MAX_COMPRESSED_PAGE_CACHE_BYTES
        );
    }

    #[test]
    fn budget_uses_the_minimum_of_device_process_and_pressure_limits() {
        let ample = |pressure| {
            calculate_memory_budget(MemoryBudgetInputs {
                physical_memory_bytes: 8 * GIB,
                process_available_memory_bytes: 8 * GIB,
                pressure,
            })
        };
        assert_eq!(ample(MemoryPressure::Normal), 1_024 * 1024 * 1024);
        assert_eq!(ample(MemoryPressure::Warning), 512 * 1024 * 1024);
        assert_eq!(ample(MemoryPressure::Critical), 0);

        let process_limited = calculate_memory_budget(MemoryBudgetInputs {
            physical_memory_bytes: 16 * GIB,
            process_available_memory_bytes: 100 * 1024 * 1024,
            pressure: MemoryPressure::Normal,
        });
        assert_eq!(process_limited, 50 * 1024 * 1024);
    }
}
