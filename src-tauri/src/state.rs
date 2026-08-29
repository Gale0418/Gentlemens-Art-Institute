use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::Mutex;

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
            ram_cache_pool: std::sync::Mutex::new(HashMap::new()),
            opened_comic_files: std::sync::RwLock::new(HashMap::new()),
            smb_config: std::sync::RwLock::new(None),
            external_bookmarks: std::sync::RwLock::new(Vec::new()),
            progress_file_lock: tokio::sync::Mutex::new(()),
            active_bookmarks: std::sync::Mutex::new(HashMap::new()),
            active_comic_id: std::sync::Mutex::new(None),
            pending_open_id: std::sync::Mutex::new(None),
            comic_lifecycle: std::sync::Mutex::new(()),
            reader_generation: std::sync::atomic::AtomicU64::new(0),
            catalog: std::sync::RwLock::new(None),
            catalog_sync: tokio::sync::Mutex::new(()),
            online_services: std::sync::RwLock::new(OnlineServicesConfig::default()),
            ai_session: std::sync::RwLock::new(None),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::OnlineServicesConfig;

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
}
