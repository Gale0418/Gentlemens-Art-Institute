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
    #[serde(skip)]
    pub external_bookmark: Option<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExternalBookmark {
    pub bookmark: String,
    pub name: String,
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
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
