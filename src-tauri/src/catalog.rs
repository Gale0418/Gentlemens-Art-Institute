use crate::metadata::{
    self, NormalizedMetadata, ParsedMetadataSource, ParserDiagnostic, ScopedTag,
};
use crate::state::{ComicItem, ReaderPriority};
use base64::{engine::general_purpose, Engine as _};
use cap_fs_ext::DirExt;
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use unicode_normalization::UnicodeNormalization;

fn wait_for_catalog_scan_turn<C, P>(is_current: &C, priority: &P) -> Result<(), String>
where
    C: Fn() -> bool + Sync,
    P: Fn() -> ReaderPriority,
{
    while priority() == ReaderPriority::Opening {
        ensure_sync_current(is_current)?;
        std::thread::sleep(Duration::from_millis(50));
    }
    ensure_sync_current(is_current)
}

struct MetadataIoGate {
    occupied: Mutex<bool>,
    available: Condvar,
}

impl MetadataIoGate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            occupied: Mutex::new(false),
            available: Condvar::new(),
        })
    }
}

struct MetadataIoPermit(Arc<MetadataIoGate>);

impl Drop for MetadataIoPermit {
    fn drop(&mut self) {
        if let Ok(mut occupied) = self.0.occupied.lock() {
            *occupied = false;
            self.0.available.notify_one();
        }
    }
}

fn acquire_active_metadata_permit<C, P>(
    gate: &Arc<MetadataIoGate>,
    is_current: &C,
    priority: &P,
) -> Result<Option<MetadataIoPermit>, String>
where
    C: Fn() -> bool + Sync,
    P: Fn() -> ReaderPriority + Sync,
{
    loop {
        wait_for_catalog_scan_turn(is_current, priority)?;
        if priority() != ReaderPriority::Active {
            return Ok(None);
        }

        let mut occupied = gate
            .occupied
            .lock()
            .map_err(|_| "metadata I/O gate 鎖定失敗".to_string())?;
        if !*occupied {
            *occupied = true;
            drop(occupied);
            let permit = MetadataIoPermit(Arc::clone(gate));
            // Priority may change while this worker was acquiring the permit.
            // Never hold the gate while waiting through Opening.
            match priority() {
                ReaderPriority::Active => return Ok(Some(permit)),
                ReaderPriority::Idle => return Ok(None),
                ReaderPriority::Opening => {
                    drop(permit);
                    wait_for_catalog_scan_turn(is_current, priority)?;
                }
            }
        } else {
            let (occupied, _) = gate
                .available
                .wait_timeout(occupied, Duration::from_millis(50))
                .map_err(|_| "metadata I/O gate 等待失敗".to_string())?;
            drop(occupied);
        }
    }
}

const FINGERPRINT_VERSION: &str = "blake3-sampled-v1";
const FILE_SIGNATURE_VERSION: &str = "file-signature-v2";
const ARCHIVE_SAMPLE_BYTES: usize = 256 * 1024;
const DIRECTORY_SAMPLE_BYTES: usize = 64 * 1024;
const PAGE_SIZE_MAX: usize = 200;
const RUNTIME_ITEM_IDS_MAX: usize = 10_000;
const RUNTIME_ITEM_QUERY: &str = "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
        p.current_page,p.total_pages,p.percent,p.updated_at
 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
 LEFT JOIN reading_progress p ON p.comic_id=c.id
 WHERE (l.runtime_id=?1 OR l.comic_id=?1)
 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1";
const RUNTIME_ITEMS_QUERY: &str = "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
        p.current_page,p.total_pages,p.percent,p.updated_at
 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
 LEFT JOIN reading_progress p ON p.comic_id=c.id
 WHERE (l.runtime_id=?1 OR l.comic_id=?1)
 AND (l.online=1 OR NOT EXISTS (
     SELECT 1 FROM comic_locations newer
     WHERE (newer.runtime_id=?1 OR newer.comic_id=?1) AND newer.online=1
 ))
 GROUP BY l.source_id,l.relative_path
 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 2";
const RUNTIME_ITEMS_SOURCE_QUERY: &str = "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
        p.current_page,p.total_pages,p.percent,p.updated_at
 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
 LEFT JOIN reading_progress p ON p.comic_id=c.id
 WHERE (l.runtime_id=?1 OR l.comic_id=?1) AND l.source_id=?2
 AND (l.online=1 OR NOT EXISTS (
     SELECT 1 FROM comic_locations newer
     WHERE (newer.runtime_id=?1 OR newer.comic_id=?1)
       AND newer.source_id=?2 AND newer.online=1
 ))
 GROUP BY l.source_id,l.relative_path
 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 2";
const RUNTIME_ITEM_SOURCE_QUERY: &str = "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
        p.current_page,p.total_pages,p.percent,p.updated_at
 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
 LEFT JOIN reading_progress p ON p.comic_id=c.id
 WHERE (l.runtime_id=?1 OR l.comic_id=?1) AND l.source_id=?2
 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1";
const RUNTIME_ITEM_SOURCE_PATH_QUERY: &str = "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
        p.current_page,p.total_pages,p.percent,p.updated_at
 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
 LEFT JOIN reading_progress p ON p.comic_id=c.id
 WHERE (l.runtime_id=?1 OR l.comic_id=?1) AND l.source_id=?2 AND l.relative_path=?3
 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1";
fn visible_location_predicate(alias: &str) -> String {
    format!(
        "NOT (replace({alias}.relative_path,char(92),'/') = '.gai-quarantine'
           OR replace({alias}.relative_path,char(92),'/') LIKE '.gai-quarantine/%'
           OR replace({alias}.relative_path,char(92),'/') = './.gai-quarantine'
           OR replace({alias}.relative_path,char(92),'/') LIKE './.gai-quarantine/%')"
    )
}

fn primary_location_order(alias: &str) -> String {
    format!(
        "{alias}.online DESC,{alias}.last_seen_at DESC,{alias}.source_id ASC,{alias}.relative_path ASC,{alias}.id ASC"
    )
}

/// Capture the location fields that feed the FTS path and folder-tag
/// projection. Only the supplied comics are ranked, using the same ordering
/// as `build_search_view`.
fn primary_location_keys_for_comics(
    connection: &Connection,
    comic_ids: &BTreeSet<String>,
) -> Result<HashMap<String, (String, String)>, String> {
    if comic_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let comic_ids = serde_json::to_string(comic_ids).map_err(|error| error.to_string())?;
    let visible_location = visible_location_predicate("l");
    let primary_order = primary_location_order("l");
    let mut statement = connection
        .prepare(&format!(
            "WITH affected AS (
               SELECT value AS comic_id FROM json_each(?1)
             ), ranked AS (
               SELECT l.comic_id,l.source_id,l.relative_path,
                      ROW_NUMBER() OVER (
                        PARTITION BY l.comic_id
                        ORDER BY {primary_order}
                      ) AS location_rank
               FROM comic_locations l
               JOIN affected a ON a.comic_id=l.comic_id
               WHERE {visible_location}
             )
             SELECT comic_id,source_id,relative_path
             FROM ranked WHERE location_rank=1"
        ))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([comic_ids], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn is_quarantine_relative_path(relative_path: &str) -> bool {
    let normalized = relative_path.replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    normalized == ".gai-quarantine" || normalized.starts_with(".gai-quarantine/")
}

fn runtime_type_for_location(online: bool, kind: &str, _source_id: &str) -> String {
    if !online {
        return "offline".into();
    }
    if kind.contains("folder") {
        "external-folder".into()
    } else if kind.contains("image") {
        "external-image".into()
    } else {
        "external-archive".into()
    }
}

#[derive(Clone)]
struct LocationSignature {
    size: Option<i64>,
    mtime: Option<String>,
    fingerprint: Option<String>,
    fingerprint_version: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CatalogStore {
    path: PathBuf,
    schema_ready: Arc<OnceLock<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetadataCandidate {
    pub field: String,
    pub value: Value,
    pub parser_id: String,
    pub priority: i64,
    pub confidence: f64,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDiagnostic {
    pub id: i64,
    pub comic_id: String,
    pub parser_id: Option<String>,
    pub source_path: String,
    pub severity: String,
    pub message: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLocationView {
    pub runtime_id: Option<String>,
    pub source_id: String,
    pub relative_path: String,
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicMetadataView {
    pub comic_id: String,
    pub runtime_id: Option<String>,
    pub title: String,
    pub series: Option<String>,
    pub volume: Option<String>,
    pub number: Option<String>,
    pub summary: Option<String>,
    pub language: Option<String>,
    pub reading_direction: Option<String>,
    pub published_at: Option<String>,
    pub relative_path: Option<String>,
    pub source_id: Option<String>,
    pub offline: bool,
    /// All source/path locations are populated for catalog search results.
    /// Non-search metadata views leave this empty and omit it from JSON.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub locations: Vec<CatalogLocationView>,
    pub creators: BTreeMap<String, Vec<String>>,
    pub tags: Vec<ScopedTag>,
    pub candidates: Vec<MetadataCandidate>,
    pub locked_fields: Vec<String>,
    pub diagnostics: Vec<ImportDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogQuery {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_page_size")]
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSearchResult {
    pub items: Vec<ComicMetadataView>,
    pub total: usize,
    pub facets: BTreeMap<String, BTreeMap<String, usize>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryTagGroup {
    pub namespace: String,
    pub value: String,
    pub comic_ids: Vec<String>,
    /// Source-qualified identities. `comic_ids` remains for older bridges.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub targets: Vec<BatchEditTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditRequest {
    /// Legacy stable catalog IDs. Runtime IDs are rejected here unless the
    /// caller uses `targets`, because a source disappearing can make the
    /// same runtime ID resolve to a different work.
    pub comic_ids: Vec<String>,
    /// Source-qualified organizer targets. Every target is resolved inside
    /// the same immediate SQLite transaction as the metadata writes.
    #[serde(default)]
    pub targets: Vec<BatchEditTarget>,
    #[serde(default)]
    pub fields: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub add_tags: Vec<ScopedTag>,
    #[serde(default)]
    pub exclude_tags: Vec<ScopedTag>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditTarget {
    pub runtime_id: String,
    pub source_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditResult {
    pub updated: usize,
    pub undo_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTagRule {
    pub id: Option<i64>,
    pub source_id: String,
    pub folder_path: String,
    pub tag: ScopedTag,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagAlias {
    pub namespace: String,
    pub alias: String,
    pub canonical_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerInboxItem {
    pub comic_id: String,
    pub title: String,
    pub parser_id: Option<String>,
    pub source_path: String,
    pub confidence: Option<f64>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateCandidate {
    pub fingerprint: String,
    pub comic_ids: Vec<String>,
    pub locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicLocationView {
    pub id: i64,
    pub comic_id: String,
    pub runtime_id: Option<String>,
    pub source_id: String,
    pub relative_path: String,
    pub actual_path: Option<String>,
    pub kind: String,
    pub size: Option<i64>,
    pub mtime: Option<String>,
    pub fingerprint: Option<String>,
    pub fingerprint_collision: bool,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationRecord {
    pub id: String,
    pub undo_token: String,
    pub comic_id: String,
    pub location_id: i64,
    pub action: String,
    pub source_id: String,
    pub before_relative_path: String,
    pub before_actual_path: Option<String>,
    pub after_relative_path: Option<String>,
    pub after_actual_path: Option<String>,
    pub expected_fingerprint: Option<String>,
    pub status: String,
    #[serde(skip)]
    pub(crate) undo_pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileReconcileResult {
    pub completed: usize,
    pub rolled_back: usize,
    pub needs_attention: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSuggestion {
    pub tag: ScopedTag,
    pub shared_comics: usize,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInventoryQuery {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_page_size")]
    pub limit: usize,
}

impl Default for TagInventoryQuery {
    fn default() -> Self {
        Self {
            query: String::new(),
            offset: 0,
            limit: default_page_size(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInventoryItem {
    pub id: i64,
    pub namespace: String,
    pub display_value: String,
    pub normalized_value: String,
    pub work_count: usize,
    pub pinned: bool,
    pub usage_count: usize,
    pub last_used_at: Option<String>,
    pub color_key: Option<String>,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInventoryResult {
    pub items: Vec<TagInventoryItem>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStateUpdate {
    pub tag_id: i64,
    pub pinned: bool,
    pub color_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagMutationResult {
    pub affected_works: usize,
    pub undo_token: String,
}

/// Trusted native evidence captured by a successful `open_comic` publication.
pub struct ProgressRecoveryProof<'a> {
    pub identifier: &'a str,
    pub source_id: &'a str,
    pub relative_path: &'a str,
    pub token: &'a str,
    pub total_pages: usize,
    pub revision: &'a crate::state::SourceRevision,
    pub smb_content_hash: Option<[u8; 32]>,
}

/// A recovery request after filesystem identity verification has completed.
pub struct ProgressRecoveryCommit<'a> {
    pub identifier: &'a str,
    pub source_id: &'a str,
    pub relative_path: &'a str,
    pub token: &'a str,
    pub revision: &'a crate::state::SourceRevision,
    pub smb_content_hash: Option<[u8; 32]>,
    pub total_pages: usize,
    pub current_page: usize,
    pub intent_sequence: u64,
    pub progress: &'a crate::state::Progress,
}

pub const MAX_SAFE_INTENT_SEQUENCE: u64 = 9_007_199_254_740_991;

pub(crate) fn validate_intent_sequence(sequence: u64) -> Result<(), String> {
    if sequence > MAX_SAFE_INTENT_SEQUENCE {
        return Err("閱讀意圖序號超出安全整數上限".into());
    }
    Ok(())
}

struct PersistedProgressRecoveryProof {
    comic_id: String,
    source_id: String,
    relative_path: String,
    total_pages: i64,
    revision_json: String,
    smb_content_hash: Option<Vec<u8>>,
    baseline_page: i64,
    baseline_total: i64,
    baseline_updated_at: Option<String>,
    intent_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogExchange {
    pub schema_version: u32,
    pub exported_at: String,
    pub comics: Vec<ExchangeComic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeComic {
    pub comic_id: String,
    pub fingerprint: Option<String>,
    pub field_overrides: BTreeMap<String, Value>,
    pub tag_overrides: Vec<ExchangeTagOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeTagOverride {
    pub tag: ScopedTag,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImportConflict {
    pub key: String,
    pub comic_id: String,
    pub field: String,
    pub local_value: Value,
    pub incoming_value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImportPreview {
    pub matched: usize,
    pub unmatched: Vec<String>,
    pub conflicts: Vec<CatalogImportConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImportRequest {
    pub payload: String,
    #[serde(default)]
    pub resolutions: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogImportResult {
    pub updated: usize,
    pub skipped_conflicts: usize,
    pub undo_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportRequest {
    #[serde(default)]
    pub comic_ids: Vec<String>,
    /// Optional source-qualified locations captured by the organizer. These
    /// are revalidated in the final write transaction after parsing.
    #[serde(default)]
    pub targets: Vec<BatchEditTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportResult {
    pub imported: usize,
    pub diagnostics: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistoryComic {
    pub id: String,
    pub source_id: String,
    pub relative_path: String,
    pub title: String,
    pub page_count: usize,
    pub progress: crate::state::Progress,
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistoryItem {
    pub id: String,
    pub opened_at: String,
    pub comic: ReadingHistoryComic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHistoryPage {
    pub items: Vec<ReadingHistoryItem>,
    pub total: usize,
}

fn default_page_size() -> usize {
    100
}

fn normalize_history_timestamp(value: &str) -> Result<String, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        })
        .map_err(|error| format!("閱讀紀錄時間格式無效：{error}"))
}

fn history_local_day_modifier(client_offset_minutes: i32, native_offset_minutes: i32) -> String {
    if client_offset_minutes == native_offset_minutes {
        "localtime".to_string()
    } else {
        format!("{client_offset_minutes:+} minutes")
    }
}

fn default_true() -> bool {
    true
}

impl CatalogStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let store = Self {
            path,
            schema_ready: Arc::new(OnceLock::new()),
        };
        store.with_connection(|_| Ok(()))?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("無法建立目錄資料庫資料夾：{error}"))?;
        }
        let mut connection = Connection::open(&self.path)
            .map_err(|error| format!("無法開啟漫畫目錄資料庫：{error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        // new() initializes the schema before sharing this store. WAL and
        // migrations are database-wide; repeating them on every connection can
        // race with an active library scan and fail without waiting for its writer.
        if self.schema_ready.get().is_none() {
            connection
                .pragma_update(None, "journal_mode", "WAL")
                .map_err(|error| error.to_string())?;
            migrate(&mut connection, true)?;
            self.schema_ready.get_or_init(|| ());
        }
        operation(&mut connection)
    }

    pub fn sync_library(&self, comics: &[ComicItem]) -> Result<usize, String> {
        self.sync_library_with_progress(comics, false, |_, _| {}, || true)
    }

    pub fn sync_library_with_progress<F, C>(
        &self,
        comics: &[ComicItem],
        discovery_only: bool,
        progress: F,
        is_current: C,
    ) -> Result<usize, String>
    where
        F: FnMut(usize, usize),
        C: Fn() -> bool + Sync,
    {
        self.sync_library_with_reader_priority(comics, discovery_only, progress, is_current, || {
            ReaderPriority::Idle
        })
    }

    pub fn sync_library_with_reader_priority<F, C, P>(
        &self,
        comics: &[ComicItem],
        discovery_only: bool,
        mut progress: F,
        is_current: C,
        reader_priority: P,
    ) -> Result<usize, String>
    where
        F: FnMut(usize, usize),
        C: Fn() -> bool + Sync,
        P: Fn() -> ReaderPriority + Sync,
    {
        let total = comics.len();
        progress(0, total);
        let source_ids = comics
            .iter()
            .map(|comic| comic.source_id.clone())
            .collect::<BTreeSet<_>>();
        let known =
            self.with_connection(|connection| load_location_signatures(connection, &source_ids))?;
        let current_locations = comics
            .iter()
            .map(|comic| (comic.source_id.clone(), comic.relative_path.clone()))
            .collect::<Vec<_>>();

        // Fingerprinting and sidecar/ZIP metadata probing are independent and mostly
        // latency-bound on NAS volumes. Keep the normal path deliberately small so a
        // large library does not flood the SMB server. Discovery-only never touches
        // the filesystem, so it does not need a worker pool at all.
        let pool = if discovery_only {
            None
        } else {
            Some(
                rayon::ThreadPoolBuilder::new()
                    .num_threads(4)
                    .thread_name(|index| format!("comic-metadata-{index}"))
                    .build()
                    .map_err(|error| error.to_string())?,
            )
        };
        // One gate per serialized source sync is enough: the catalog scan
        // lane owns a single sync at a time, and its Rayon workers share this
        // one-permit limiter when the reader becomes active.
        let metadata_gate = MetadataIoGate::new();
        let mut affected_total = BTreeSet::new();
        let mut done = 0;
        while done < total {
            wait_for_catalog_scan_turn(&is_current, &reader_priority)?;
            let reading = reader_priority() == ReaderPriority::Active;
            // Limit SQLite writer ownership and metadata concurrency while a
            // reader is active. No transaction is held during the throttle.
            let batch = &comics[done..(done + if reading { 8 } else { 64 }).min(total)];
            ensure_sync_current(&is_current)?;
            let prepared = if discovery_only {
                batch
                    .iter()
                    .map(|comic| {
                        wait_for_catalog_scan_turn(&is_current, &reader_priority)?;
                        let key = (comic.source_id.clone(), comic.relative_path.clone());
                        let previous = known.get(&key);
                        let signature = previous.map(|item| (item.size, item.mtime.clone()));
                        let fingerprint = previous.and_then(|item| item.fingerprint.clone());
                        let fingerprint_version =
                            previous.and_then(|item| item.fingerprint_version.clone());
                        // Files-app discovery has no permission to probe paths. Existing
                        // locations retain every imported source; only a new location gets
                        // the filename fallback.
                        let parse = previous.is_none().then(|| metadata::ParseOutcome {
                            sources: vec![metadata::filename_metadata_for_discovered_path(
                                Path::new(&comic.relative_path),
                                matches!(comic.r#type.as_str(), "folder" | "external-folder"),
                            )],
                            diagnostics: vec![],
                            failures: vec![],
                        });
                        Ok((
                            comic.clone(),
                            signature,
                            fingerprint,
                            fingerprint_version,
                            comic.relative_path.clone(),
                            parse,
                        ))
                    })
                    .collect::<Result<Vec<_>, String>>()?
            } else {
                let prepare = |comic: &ComicItem| {
                    // Re-check at every metadata work boundary. An Idle batch
                    // can outlive a reader-priority transition; work not yet
                    // entered into filesystem I/O must then use the shared
                    // single-lane gate. Already-running OS I/O is not preempted.
                    let _active_permit = acquire_active_metadata_permit(
                        &metadata_gate,
                        &is_current,
                        &reader_priority,
                    )?;
                    let path = comic.source_path.as_deref().map(Path::new);
                    let signature = path.and_then(file_signature);
                    let key = (comic.source_id.clone(), comic.relative_path.clone());
                    let previous = known.get(&key);
                    let signature_is_complete = signature
                        .as_ref()
                        .is_some_and(|value| value.0.is_some() && value.1.is_some());
                    let unchanged = signature_is_complete
                        && previous.is_some_and(|item| {
                            item.fingerprint_version.as_deref() == Some(FINGERPRINT_VERSION)
                                && item.size == signature.as_ref().and_then(|value| value.0)
                                && item.mtime
                                    == signature.as_ref().and_then(|value| value.1.clone())
                        });
                    let fingerprint = if unchanged {
                        previous.and_then(|item| item.fingerprint.clone())
                    } else {
                        path.and_then(|item| sampled_fingerprint(item).ok())
                    };
                    let fingerprint_version = if unchanged {
                        previous.and_then(|item| item.fingerprint_version.clone())
                    } else {
                        fingerprint
                            .as_ref()
                            .map(|_| FINGERPRINT_VERSION.to_string())
                    };
                    let parse = if unchanged {
                        None
                    } else {
                        Some(
                            path.filter(|item| item.exists())
                                .map(metadata::parse_metadata_for_path)
                                .unwrap_or_else(|| metadata::ParseOutcome {
                                    sources: vec![metadata::filename_metadata_for_path(Path::new(
                                        &comic.relative_path,
                                    ))],
                                    diagnostics: vec![],
                                    failures: vec![],
                                }),
                        )
                    };
                    let scope_path = path
                        .filter(|item| item.exists())
                        .map(|item| item.to_string_lossy().into_owned())
                        .unwrap_or_else(|| comic.relative_path.clone());
                    Ok((
                        comic.clone(),
                        signature,
                        fingerprint,
                        fingerprint_version,
                        scope_path,
                        parse,
                    ))
                };
                let result: Result<Vec<_>, String> = if reading {
                    batch.iter().map(prepare).collect()
                } else {
                    pool.as_ref()
                        .expect("normal sync has a metadata pool")
                        .install(|| batch.par_iter().map(prepare).collect())
                };
                result?
            };
            ensure_sync_current(&is_current)?;
            // Metadata work may finish while a reader is Opening. Recheck
            // before taking the catalog connection/transaction; never sleep
            // while holding either SQLite writer ownership or the connection
            // mutex. This is cooperative scheduling, not OS-I/O preemption.
            wait_for_catalog_scan_turn(&is_current, &reader_priority)?;
            ensure_sync_current(&is_current)?;

            let is_last = done + batch.len() == total;
            let affected_batch = self.with_connection(|connection| {
                ensure_sync_current(&is_current)?;
                let tx = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| error.to_string())?;
                let mut affected = BTreeSet::new();
                for (comic, signature, fingerprint, fingerprint_version, scope_path, parse) in prepared {
                    let (comic_id, fingerprint_collision) = upsert_location(
                        &tx,
                        &comic,
                        signature,
                        fingerprint.as_deref(),
                        fingerprint_version.as_deref(),
                    )?;
                    import_runtime_progress(&tx, &comic_id, &comic.progress)?;
                    affected.insert(comic_id.clone());
                    if let Some(outcome) = parse {
                        replace_imports(
                            &tx,
                            &comic_id,
                            &scope_path,
                            outcome.sources,
                            outcome.diagnostics,
                            outcome.failures,
                        )?;
                    }
                    if fingerprint_collision {
                        tx.execute(
                            "INSERT INTO import_diagnostics(comic_id,parser_id,source_path,severity,message) VALUES(?1,NULL,?2,'warning','指紋符合多本既有漫畫，已保留為獨立項目，請手動確認')",
                            params![comic_id, comic.relative_path],
                        )
                        .map_err(|error| error.to_string())?;
                    }
                    resolve_effective_metadata(&tx, &comic_id)?;
                }
                for comic_id in &affected {
                    tx.execute(
                        "UPDATE comics SET offline = CASE WHEN EXISTS (SELECT 1 FROM comic_locations l WHERE l.comic_id = comics.id AND l.online = 1) THEN 0 ELSE 1 END WHERE id = ?1",
                        [comic_id],
                    )
                    .map_err(|error| error.to_string())?;
                }
                if is_last {
                    affected.extend(retire_unseen_sources(
                        &tx,
                        &source_ids,
                        &current_locations,
                    )?);
                    tx.execute(
                        "UPDATE comics SET offline = CASE WHEN EXISTS (SELECT 1 FROM comic_locations l WHERE l.comic_id = comics.id AND l.online = 1) THEN 0 ELSE 1 END",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                }
                refresh_fts_batch(&tx, &affected)?;
                // A cancellation observed here drops the transaction and leaves the
                // already committed batches plus previously unconfirmed books intact.
                ensure_sync_current(&is_current)?;
                tx.commit().map_err(|error| error.to_string())?;
                Ok(affected)
            })?;
            affected_total.extend(affected_batch);
            done += batch.len();
            progress(done, total);
            if reader_priority() == ReaderPriority::Active {
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        // Empty scans have no current source to retire. Keep existing catalog rows
        // unchanged, matching the historical sync_library behaviour.
        Ok(affected_total.len())
    }

    pub fn get_metadata(&self, identifier: &str) -> Result<ComicMetadataView, String> {
        self.with_connection(|connection| {
            let comic_id = resolve_comic_id(connection, identifier)?
                .ok_or_else(|| "找不到漫畫 metadata".to_string())?;
            build_view(connection, &comic_id)
        })
    }

    pub fn get_metadata_for_source(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
    ) -> Result<ComicMetadataView, String> {
        if source_id.trim().is_empty() || relative_path.trim().is_empty() {
            return Err("漫畫來源位置資訊不完整，已拒絕 metadata 查詢".into());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT DISTINCT l.comic_id
                     FROM comic_locations l
                     WHERE (l.runtime_id=?1 OR l.comic_id=?1)
                       AND l.source_id=?2
                       AND l.relative_path=?3
                     LIMIT 2",
                )
                .map_err(|error| error.to_string())?;
            let comic_ids = statement
                .query_map(params![identifier, source_id, relative_path], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let comic_id = match comic_ids.as_slice() {
                [comic_id] => comic_id,
                [] => return Err("找不到指定來源位置的漫畫 metadata".into()),
                _ => return Err("漫畫來源位置不唯一，已拒絕 metadata 查詢".into()),
            };
            build_view_for_location(connection, comic_id, source_id, relative_path)
        })
    }

    pub fn get_location(&self, identifier: &str) -> Result<ComicLocationView, String> {
        self.with_connection(|connection| {
            let comic_id = resolve_comic_id(connection, identifier)?
                .ok_or_else(|| "找不到已登記的漫畫位置".to_string())?;
            let location_count: i64 = connection
                .query_row(
                    "SELECT COUNT(DISTINCT source_id || char(0) || relative_path)
                     FROM comic_locations WHERE comic_id=?1",
                    [&comic_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if location_count > 1 {
                return Err("漫畫有多個來源位置，為避免誤操作，暫時無法管理檔案".into());
            }
            connection.query_row(
                "SELECT l.id,l.comic_id,l.runtime_id,l.source_id,l.relative_path,l.actual_path,l.kind,l.size,l.mtime,l.fingerprint,
                        CASE WHEN l.fingerprint IS NOT NULL AND EXISTS(
                          SELECT 1 FROM comic_locations other
                           WHERE other.fingerprint=l.fingerprint
                             AND other.fingerprint_version=l.fingerprint_version
                             AND other.comic_id<>l.comic_id
                        ) THEN 1 ELSE 0 END,l.online
                 FROM comic_locations l WHERE l.comic_id=?1 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1",
                [comic_id],
                |row| Ok(ComicLocationView {
                    id: row.get(0)?, comic_id: row.get(1)?, runtime_id: row.get(2)?, source_id: row.get(3)?,
                    relative_path: row.get(4)?, actual_path: row.get(5)?, kind: row.get(6)?,
                    size: row.get(7)?, mtime: row.get(8)?, fingerprint: row.get(9)?,
                    fingerprint_collision: row.get::<_, i64>(10)? != 0,
                    online: row.get::<_, i64>(11)? != 0,
                }),
            ).map_err(|error| error.to_string())
        })
    }

    pub fn get_location_for_source(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
    ) -> Result<ComicLocationView, String> {
        if source_id.trim().is_empty() || relative_path.is_empty() {
            return Err("漫畫來源位置資訊不完整，已拒絕檔案操作".into());
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT DISTINCT comic_id FROM comic_locations
                     WHERE (runtime_id=?1 OR comic_id=?1)
                       AND source_id=?2 AND relative_path=?3 LIMIT 2",
                )
                .map_err(|error| error.to_string())?;
            let comic_ids = statement
                .query_map(params![identifier, source_id, relative_path], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let comic_id = match comic_ids.as_slice() {
                [comic_id] => comic_id,
                [] => return Err("找不到指定來源位置的漫畫".into()),
                _ => return Err("漫畫來源位置不唯一，已拒絕檔案操作".into()),
            };
            connection
                .query_row(
                    "SELECT l.id,l.comic_id,l.runtime_id,l.source_id,l.relative_path,l.actual_path,l.kind,l.size,l.mtime,l.fingerprint,
                            CASE WHEN l.fingerprint IS NOT NULL AND EXISTS(
                              SELECT 1 FROM comic_locations other
                               WHERE other.fingerprint=l.fingerprint
                                 AND other.fingerprint_version=l.fingerprint_version
                                 AND other.comic_id<>l.comic_id
                            ) THEN 1 ELSE 0 END,l.online
                     FROM comic_locations l
                     WHERE l.comic_id=?1 AND l.source_id=?2 AND l.relative_path=?3
                     ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1",
                    params![comic_id, source_id, relative_path],
                    |row| Ok(ComicLocationView {
                        id: row.get(0)?, comic_id: row.get(1)?, runtime_id: row.get(2)?, source_id: row.get(3)?,
                        relative_path: row.get(4)?, actual_path: row.get(5)?, kind: row.get(6)?,
                        size: row.get(7)?, mtime: row.get(8)?, fingerprint: row.get(9)?,
                        fingerprint_collision: row.get::<_, i64>(10)? != 0,
                        online: row.get::<_, i64>(11)? != 0,
                    }),
                )
                .map_err(|error| error.to_string())
        })
    }

    pub fn begin_file_operation(
        &self,
        location: &ComicLocationView,
        action: &str,
        after_relative_path: Option<&str>,
        after_actual_path: Option<&str>,
    ) -> Result<FileOperationRecord, String> {
        let record = FileOperationRecord {
            id: uuid::Uuid::new_v4().to_string(),
            undo_token: uuid::Uuid::new_v4().to_string(),
            comic_id: location.comic_id.clone(),
            location_id: location.id,
            action: action.to_string(),
            source_id: location.source_id.clone(),
            before_relative_path: location.relative_path.clone(),
            before_actual_path: location.actual_path.clone(),
            after_relative_path: after_relative_path.map(str::to_owned),
            after_actual_path: after_actual_path.map(str::to_owned),
            expected_fingerprint: location.fingerprint.clone(),
            status: "pending".into(),
            undo_pending: false,
        };
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO file_operations(id,undo_token,comic_id,location_id,action,source_id,before_relative_path,before_actual_path,after_relative_path,after_actual_path,expected_fingerprint,status)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'pending')",
                params![record.id, record.undo_token, record.comic_id, record.location_id, record.action,
                    record.source_id, record.before_relative_path, record.before_actual_path,
                    record.after_relative_path, record.after_actual_path, record.expected_fingerprint],
            ).map_err(|error| error.to_string())?;
            Ok(record.clone())
        })
    }

    pub fn complete_file_operation(
        &self,
        operation_id: &str,
        runtime_id: Option<&str>,
        online: bool,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let record = load_file_operation(&tx, operation_id, false)?;
            if record.status != "pending" { return Err("檔案操作狀態已改變".into()); }
            tx.execute(
                "UPDATE comic_locations SET runtime_id=COALESCE(?2,runtime_id),relative_path=COALESCE(?3,relative_path),actual_path=?4,online=?5,last_seen_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![record.location_id, runtime_id, record.after_relative_path, record.after_actual_path, i64::from(online)],
            ).map_err(|error| error.to_string())?;
            tx.execute("UPDATE file_operations SET status='succeeded',completed_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='pending'", [operation_id]).map_err(|error| error.to_string())?;
            tx.execute("UPDATE comics SET offline=CASE WHEN EXISTS(SELECT 1 FROM comic_locations WHERE comic_id=?1 AND online=1) THEN 0 ELSE 1 END WHERE id=?1", [&record.comic_id]).map_err(|error| error.to_string())?;
            refresh_fts(&tx, &record.comic_id)?;
            tx.commit().map_err(|error| error.to_string())
        })
    }

    pub fn set_file_operation_destination(
        &self,
        operation_id: &str,
        relative_path: &str,
        actual_path: Option<&str>,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let changed = connection.execute(
                "UPDATE file_operations SET after_relative_path=?2,after_actual_path=?3 WHERE id=?1 AND status='pending'",
                params![operation_id, relative_path, actual_path],
            ).map_err(|error| error.to_string())?;
            if changed != 1 { return Err("檔案操作紀錄已改變".into()); }
            Ok(())
        })
    }

    pub fn set_file_operation_expected_fingerprint(
        &self,
        operation_id: &str,
        expected_fingerprint: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE file_operations SET expected_fingerprint=?2 WHERE id=?1 AND status='pending'",
                    params![operation_id, expected_fingerprint],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err("檔案操作紀錄已改變".into());
            }
            Ok(())
        })
    }

    pub fn fail_file_operation(&self, operation_id: &str, message: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            connection.execute("UPDATE file_operations SET status='failed',error_message=?2,completed_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='pending'", params![operation_id, message]).map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn mark_file_operation_needs_reconcile(
        &self,
        operation_id: &str,
        message: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE file_operations SET status='needs_reconcile',error_message=?2,completed_at=CURRENT_TIMESTAMP WHERE id=?1 AND status IN ('pending','succeeded')",
                    params![operation_id, message],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err("檔案操作無法標記為待人工調和".into());
            }
            Ok(())
        })
    }

    #[cfg(test)]
    pub(crate) fn test_set_location_relative_path(
        &self,
        location_id: i64,
        relative_path: &str,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE comic_locations SET relative_path=?2 WHERE id=?1",
                    params![location_id, relative_path],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn file_operation_for_undo(&self, token: &str) -> Result<FileOperationRecord, String> {
        self.with_connection(|connection| load_file_operation(connection, token, true))
    }

    /// 記錄 undo 意圖後才允許呼叫端改動檔案系統，讓啟動復原能辨認方向。
    pub fn begin_file_operation_undo(&self, operation_id: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE file_operations SET status='pending',error_message='undo_pending' WHERE id=?1 AND status='succeeded'",
                    [operation_id],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err("此檔案操作目前不可撤銷".into());
            }
            Ok(())
        })
    }

    /// 檔案系統步驟失敗且未發生時，保留原有 undo 能力供使用者重試。
    pub fn cancel_file_operation_undo(&self, operation_id: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "UPDATE file_operations SET status='succeeded',error_message=NULL WHERE id=?1 AND status='pending' AND error_message='undo_pending'",
                    [operation_id],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err("檔案還原紀錄已改變，需人工確認".into());
            }
            Ok(())
        })
    }

    pub fn complete_file_operation_undo(
        &self,
        operation_id: &str,
        runtime_id: Option<&str>,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let record = load_file_operation(&tx, operation_id, false)?;
            if record.status != "pending" || !record.undo_pending {
                return Err("檔案還原紀錄未處於可完成的狀態".into());
            }
            let changed = tx.execute(
                "UPDATE comic_locations SET runtime_id=COALESCE(?2,runtime_id),relative_path=?3,actual_path=?4,online=1,last_seen_at=CURRENT_TIMESTAMP WHERE id=?1 AND relative_path=COALESCE(?5,relative_path)",
                params![record.location_id, runtime_id, record.before_relative_path, record.before_actual_path, record.after_relative_path],
            ).map_err(|error| error.to_string())?;
            if changed != 1 { return Err("漫畫位置在操作後又被修改，已停止撤銷以避免覆寫".into()); }
            tx.execute("UPDATE file_operations SET status='undone',error_message=NULL,undone_at=CURRENT_TIMESTAMP WHERE id=?1 AND status='pending' AND error_message='undo_pending'", [operation_id]).map_err(|error| error.to_string())?;
            tx.execute("UPDATE comics SET offline=0 WHERE id=?1", [&record.comic_id]).map_err(|error| error.to_string())?;
            refresh_fts(&tx, &record.comic_id)?;
            tx.commit().map_err(|error| error.to_string())
        })
    }

    pub fn reconcile_file_operations(&self) -> Result<FileReconcileResult, String> {
        let pending = self.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT id,undo_token,comic_id,location_id,action,source_id,before_relative_path,before_actual_path,after_relative_path,after_actual_path,expected_fingerprint,status,COALESCE(error_message='undo_pending',0) FROM file_operations WHERE status IN ('pending','needs_reconcile') ORDER BY created_at").map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| Ok(FileOperationRecord {
                id: row.get(0)?, undo_token: row.get(1)?, comic_id: row.get(2)?, location_id: row.get(3)?, action: row.get(4)?, source_id: row.get(5)?,
                before_relative_path: row.get(6)?, before_actual_path: row.get(7)?, after_relative_path: row.get(8)?, after_actual_path: row.get(9)?, expected_fingerprint: row.get(10)?, status: row.get(11)?, undo_pending: row.get(12)?,
            })).map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            Ok(rows)
        })?;
        let mut result = FileReconcileResult::default();
        for operation in pending {
            if operation.status == "needs_reconcile" {
                result.needs_attention += 1;
                continue;
            }
            let is_local =
                operation.source_id == "local" || operation.source_id.starts_with("local:");
            if !is_local {
                self.with_connection(|connection| {
                    connection.execute("UPDATE file_operations SET status='needs_reconcile',error_message='遠端操作需重新連線後人工確認' WHERE id=?1 AND status='pending'", [&operation.id]).map_err(|error| error.to_string())?;
                    Ok(())
                })?;
                result.needs_attention += 1;
                continue;
            }
            if operation.undo_pending {
                let before_exists = operation
                    .before_actual_path
                    .as_deref()
                    .is_some_and(|path| Path::new(path).symlink_metadata().is_ok());
                let after_exists = operation
                    .after_actual_path
                    .as_deref()
                    .is_some_and(|path| Path::new(path).symlink_metadata().is_ok());
                let before_matches = before_exists
                    && local_operation_path_matches_fingerprint(
                        &operation,
                        &operation.before_relative_path,
                    );
                let after_matches = after_exists
                    && operation
                        .after_relative_path
                        .as_deref()
                        .is_some_and(|relative| {
                            local_operation_path_matches_fingerprint(&operation, relative)
                        });
                match (before_matches, after_matches, before_exists, after_exists) {
                    (true, false, true, false) => {
                        let runtime_id = general_purpose::URL_SAFE_NO_PAD
                            .encode(operation.before_relative_path.as_bytes());
                        self.complete_file_operation_undo(&operation.id, Some(&runtime_id))?;
                        result.completed += 1;
                    }
                    (false, true, false, true) => {
                        self.cancel_file_operation_undo(&operation.id)?;
                        result.rolled_back += 1;
                    }
                    _ => {
                        self.with_connection(|connection| {
                            connection.execute(
                                "UPDATE file_operations SET status='needs_reconcile',error_message='還原中斷後來源／目的地或檔案版本不唯一，已停止自動處理' WHERE id=?1 AND status='pending' AND error_message='undo_pending'",
                                [&operation.id],
                            ).map_err(|error| error.to_string())?;
                            Ok(())
                        })?;
                        result.needs_attention += 1;
                    }
                }
                continue;
            }
            let before_exists = operation
                .before_actual_path
                .as_deref()
                .is_some_and(|path| Path::new(path).symlink_metadata().is_ok());
            let after_exists = operation
                .after_actual_path
                .as_deref()
                .is_some_and(|path| Path::new(path).symlink_metadata().is_ok());
            let after_matches = after_exists
                && operation
                    .after_relative_path
                    .as_deref()
                    .is_some_and(|relative| {
                        local_operation_path_matches_fingerprint(&operation, relative)
                    });
            match (before_exists, after_exists, after_matches) {
                (false, true, true) => {
                    let runtime_id = operation
                        .after_relative_path
                        .as_deref()
                        .map(|path| general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes()));
                    self.complete_file_operation(
                        &operation.id,
                        runtime_id.as_deref(),
                        operation.action != "trash",
                    )?;
                    result.completed += 1;
                }
                (true, false, _) => {
                    self.fail_file_operation(&operation.id, "啟動復原：檔案系統操作尚未發生")?;
                    result.rolled_back += 1;
                }
                _ => {
                    self.with_connection(|connection| {
                        connection.execute("UPDATE file_operations SET status='needs_reconcile',error_message='來源／目的地狀態或目的地檔案版本不唯一，已停止自動處理' WHERE id=?1 AND status='pending'", [&operation.id]).map_err(|error| error.to_string())?;
                        Ok(())
                    })?;
                    result.needs_attention += 1;
                }
            }
        }
        Ok(result)
    }

    pub fn overlay_library(
        &self,
        items: Vec<ComicItem>,
        catalog_only_sources: &BTreeSet<String>,
    ) -> Result<Vec<ComicItem>, String> {
        self.overlay_library_with_options(items, catalog_only_sources, false)
    }

    /// Rehydrates catalog rows that are not currently scanned. When the
    /// external bookmark file is unreadable, those rows are deliberately
    /// exposed as offline only; callers must not treat them as authorized.
    pub fn overlay_library_with_options(
        &self,
        mut items: Vec<ComicItem>,
        catalog_only_sources: &BTreeSet<String>,
        include_unreadable_external_sources: bool,
    ) -> Result<Vec<ComicItem>, String> {
        items.retain(|item| !is_quarantine_relative_path(&item.relative_path));
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
                        p.current_page,p.total_pages,p.percent,p.updated_at
                 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
                 LEFT JOIN reading_progress p ON p.comic_id=c.id
                 WHERE l.runtime_id IS NOT NULL
                 ORDER BY l.runtime_id,l.online DESC,l.last_seen_at DESC"
            ).map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)? != 0, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
                row.get::<_, Option<i64>>(9)?, row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<f64>>(11)?, row.get::<_, Option<String>>(12)?,
            ))).map_err(|error| error.to_string())?;
            let mut metadata = HashMap::new();
            for row in rows {
                let row = row.map_err(|error| error.to_string())?;
                metadata
                    .entry((row.0.clone(), row.8.clone()))
                    .or_insert(row);
            }
            let mut present = BTreeSet::new();
            for item in &mut items {
                let identity = (item.id.clone(), item.source_id.clone());
                present.insert(identity.clone());
                if let Some((_, title, series, _, _, _, _, _, _, current_page, total_pages, percent, progress_updated_at)) = metadata.get(&identity) {
                    item.title.clone_from(title);
                    if let Some(series) = series { item.series.clone_from(series); }
                    if include_unreadable_external_sources && item.source_id.starts_with("external:") {
                        item.r#type = "offline".into();
                    }
                    if let Some(current_page) = current_page {
                        item.progress = crate::state::Progress {
                            current_page: (*current_page).max(0) as usize,
                            total_pages: total_pages.unwrap_or_default().max(0) as usize,
                            percent: percent.unwrap_or_default(),
                            updated_at: progress_updated_at.clone(),
                        };
                    }
                }
            }
            for (runtime_id, title, series, online, last_seen_at, relative_path, actual_path, kind, source_id, current_page, total_pages, percent, progress_updated_at) in metadata.into_values() {
                if is_quarantine_relative_path(&relative_path) {
                    continue;
                }
                if present.contains(&(runtime_id.clone(), source_id.clone())) { continue; }
                let include_as_unreadable_external = include_unreadable_external_sources
                    && source_id.starts_with("external:");
                if !catalog_only_sources.contains(&source_id) && !include_as_unreadable_external { continue; }
                let Some(actual_path) = actual_path else { continue };
                let ext = Path::new(&actual_path).extension().and_then(|value| value.to_str()).map(|value| format!(".{value}")).unwrap_or_default();
                let item_type = if include_as_unreadable_external {
                    "offline".to_string()
                } else {
                    runtime_type_for_location(online, &kind, &source_id)
                };
                items.push(ComicItem {
                    id: runtime_id,
                    r#type: item_type,
                    relative_path,
                    ext,
                    title,
                    series: series.unwrap_or_else(|| "未分類".into()),
                    updated_at: last_seen_at,
                    page_count: 0,
                    progress: crate::state::Progress {
                        current_page: current_page.unwrap_or_default().max(0) as usize,
                        total_pages: total_pages.unwrap_or_default().max(0) as usize,
                        percent: percent.unwrap_or_default(),
                        updated_at: progress_updated_at,
                    },
                    source_id,
                    source_path: Some(actual_path),
                    external_bookmark: None,
                });
            }
            Ok(items)
        })
    }

    pub fn get_runtime_item(&self, identifier: &str) -> Result<Option<ComicItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(RUNTIME_ITEM_QUERY)
                .map_err(|error| error.to_string())?;
            load_runtime_item_from_statement(&mut statement, identifier)
        })
    }

    pub fn get_runtime_items_for_id(&self, identifier: &str) -> Result<Vec<ComicItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(RUNTIME_ITEMS_QUERY)
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([identifier], comic_item_from_row)
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        })
    }

    pub fn get_runtime_items_for_source(
        &self,
        identifier: &str,
        source_id: &str,
    ) -> Result<Vec<ComicItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(RUNTIME_ITEMS_SOURCE_QUERY)
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![identifier, source_id], comic_item_from_row)
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        })
    }

    pub fn get_runtime_item_for_source(
        &self,
        identifier: &str,
        source_id: &str,
    ) -> Result<Option<ComicItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(RUNTIME_ITEM_SOURCE_QUERY)
                .map_err(|error| error.to_string())?;
            load_runtime_item_from_statement_for_source(&mut statement, identifier, source_id)
        })
    }

    pub fn get_runtime_item_for_source_path(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
    ) -> Result<Option<ComicItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(RUNTIME_ITEM_SOURCE_PATH_QUERY)
                .map_err(|error| error.to_string())?;
            statement
                .query_row(
                    params![identifier, source_id, relative_path],
                    comic_item_from_row,
                )
                .optional()
                .map_err(|error| error.to_string())
        })
    }

    pub fn record_reading_history(
        &self,
        session_key: &str,
        comic: &ReadingHistoryComic,
        opened_at: &str,
    ) -> Result<bool, String> {
        if session_key.is_empty() || session_key.len() > 160 || comic.page_count == 0 {
            return Err("閱讀紀錄資料無效".into());
        }
        let opened_at = normalize_history_timestamp(opened_at)?;
        self.with_connection(|connection| {
            let changed = connection
                .execute(
                    "INSERT OR IGNORE INTO reading_history(
                   session_key,comic_id,source_id,relative_path,opened_at,title,page_count,
                   offline,progress_page,progress_total,progress_percent,progress_updated_at
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    params![
                        session_key,
                        comic.id,
                        comic.source_id,
                        comic.relative_path,
                        opened_at,
                        comic.title,
                        comic.page_count as i64,
                        comic.offline as i64,
                        comic.progress.current_page as i64,
                        comic.progress.total_pages as i64,
                        comic.progress.percent,
                        comic.progress.updated_at
                    ],
                )
                .map_err(|error| format!("無法寫入閱讀紀錄：{error}"))?;
            Ok(changed > 0)
        })
    }

    pub fn get_reading_history(
        &self,
        period: &str,
        offset: usize,
        limit: usize,
        time_zone_offset_minutes: i32,
    ) -> Result<ReadingHistoryPage, String> {
        self.get_reading_history_inner(period, offset, limit, time_zone_offset_minutes, None)
    }

    /// iOS-only view of history with old UUIDs for this app's Documents root
    /// treated as read-time aliases. History rows are never rewritten.
    #[cfg(any(target_os = "ios", test))]
    pub(crate) fn get_reading_history_for_ios_documents(
        &self,
        period: &str,
        offset: usize,
        limit: usize,
        time_zone_offset_minutes: i32,
        documents: &Path,
    ) -> Result<ReadingHistoryPage, String> {
        let current_source_id = crate::ios_documents::current_documents_source_id(documents)
            .ok_or_else(|| "iOS Documents 位置無效".to_string())?;
        self.get_reading_history_inner(
            period,
            offset,
            limit,
            time_zone_offset_minutes,
            Some((documents, current_source_id)),
        )
    }

    fn get_reading_history_inner(
        &self,
        period: &str,
        offset: usize,
        limit: usize,
        time_zone_offset_minutes: i32,
        ios_documents: Option<(&Path, String)>,
    ) -> Result<ReadingHistoryPage, String> {
        if !matches!(period, "month" | "year" | "all") {
            return Err("閱讀紀錄期間無效".into());
        }
        if !(-840..=840).contains(&time_zone_offset_minutes) {
            return Err("時區偏移分鐘數無效".into());
        }
        let limit = limit.clamp(1, 100);
        let offset = offset.min(i64::MAX as usize) as i64;
        let cutoff = match period {
            "month" => normalize_history_timestamp(
                &(chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339(),
            )?,
            "year" => normalize_history_timestamp(
                &(chrono::Utc::now() - chrono::Duration::days(365)).to_rfc3339(),
            )?,
            _ => "0000-01-01T00:00:00Z".to_string(),
        };
        let native_offset_minutes = chrono::Local::now().offset().local_minus_utc() / 60;
        let local_day_modifier =
            history_local_day_modifier(time_zone_offset_minutes, native_offset_minutes);

        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .map_err(|error| format!("無法開始閱讀紀錄查詢快照：{error}"))?;

            let aliases = if let Some((documents, current_source_id)) = ios_documents.as_ref() {
                // Discover only the source IDs which can affect this period.
                // Desktop callers skip this query and retain the legacy identity.
                let mut statement = tx
                    .prepare("SELECT DISTINCT source_id FROM reading_history WHERE opened_at>=?1")
                    .map_err(|error| format!("無法準備閱讀紀錄來源查詢：{error}"))?;
                let source_rows = statement
                    .query_map([&cutoff], |row| row.get::<_, String>(0))
                    .map_err(|error| format!("無法查詢閱讀紀錄來源：{error}"))?;
                let mut aliases = BTreeMap::new();
                for source in source_rows {
                    let source = source.map_err(|error| error.to_string())?;
                    if crate::ios_documents::is_previous_documents_source_id(&source, documents) {
                        aliases.insert(source, current_source_id.clone());
                    }
                }
                serde_json::to_string(&aliases)
                    .map_err(|error| format!("無法編碼閱讀紀錄來源別名：{error}"))?
            } else {
                "{}".to_string()
            };

            let total: i64 = tx
                .query_row(
                    "WITH source_aliases AS (
                       SELECT key AS old_source_id,value AS logical_source_id FROM json_each(?1)
                     ), logical_rows AS (
                       SELECT h.source_id,h.relative_path,
                              COALESCE(a.logical_source_id,h.source_id) AS logical_source_id,
                              date(datetime(h.opened_at,?2)) AS local_day
                       FROM reading_history h
                       LEFT JOIN source_aliases a ON a.old_source_id=h.source_id
                       WHERE h.opened_at>=?3
                     ), grouped AS (
                       SELECT logical_source_id,relative_path,local_day FROM logical_rows
                       GROUP BY logical_source_id,relative_path,local_day
                     ) SELECT COUNT(*) FROM grouped",
                    params![aliases, local_day_modifier, cutoff],
                    |row| row.get(0),
                )
                .map_err(|error| format!("無法計算閱讀紀錄數量：{error}"))?;

            let mut statement = tx
                .prepare(
                     "WITH source_aliases AS (
                       SELECT key AS old_source_id,value AS logical_source_id FROM json_each(?1)
                     ), previous_progress_ranked AS (
                       SELECT l.source_id,l.relative_path,p.current_page,p.total_pages,p.percent,p.updated_at,
                              ROW_NUMBER() OVER (
                                PARTITION BY l.source_id,l.relative_path
                                ORDER BY p.updated_at DESC,l.id DESC
                              ) AS progress_rank
                       FROM comic_locations l
                       JOIN source_aliases a ON a.old_source_id=l.source_id
                       JOIN reading_progress p ON p.comic_id=l.comic_id
                     ), previous_progress AS (
                       SELECT source_id,relative_path,current_page,total_pages,percent,updated_at
                       FROM previous_progress_ranked WHERE progress_rank=1
                     ), logical_rows AS (
                       SELECT h.*,
                              COALESCE(a.logical_source_id,h.source_id) AS logical_source_id
                       FROM reading_history h
                       LEFT JOIN source_aliases a ON a.old_source_id=h.source_id
                       WHERE h.opened_at>=?2
                     ), ranked AS (
                       SELECT logical_rows.*,ROW_NUMBER() OVER (
                         PARTITION BY logical_source_id,relative_path,
                                      date(datetime(opened_at,?3))
                         ORDER BY opened_at DESC,session_key DESC
                       ) AS day_rank
                       FROM logical_rows
                     )
                     SELECT ranked.session_key,COALESCE(l.runtime_id,ranked.comic_id),
                            CASE WHEN l.id IS NOT NULL THEN ranked.logical_source_id
                                 ELSE ranked.source_id END,
                            ranked.relative_path,ranked.opened_at,
                            COALESCE(c.title,ranked.title),ranked.page_count,
                            CASE WHEN l.id IS NULL OR l.online=0 THEN 1 ELSE 0 END,
                            COALESCE(p.current_page,previous_progress.current_page,ranked.progress_page),
                            COALESCE(p.total_pages,previous_progress.total_pages,ranked.progress_total),
                            COALESCE(p.percent,previous_progress.percent,ranked.progress_percent),
                            COALESCE(p.updated_at,previous_progress.updated_at,ranked.progress_updated_at)
                     FROM ranked
                     LEFT JOIN comic_locations l
                       ON l.source_id=ranked.logical_source_id
                      AND l.relative_path=ranked.relative_path
                     LEFT JOIN comics c ON c.id=l.comic_id
                     LEFT JOIN reading_progress p ON p.comic_id=l.comic_id
                     LEFT JOIN previous_progress
                       ON previous_progress.source_id=ranked.source_id
                      AND previous_progress.relative_path=ranked.relative_path
                     WHERE ranked.day_rank=1
                     ORDER BY ranked.opened_at DESC,ranked.session_key DESC LIMIT ?4 OFFSET ?5",
                )
                .map_err(|error| format!("無法準備閱讀紀錄查詢：{error}"))?;
            let rows = statement
                .query_map(
                    params![aliases, cutoff, local_day_modifier, limit as i64, offset],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                            row.get::<_, i64>(8)?,
                            row.get::<_, i64>(9)?,
                            row.get::<_, f64>(10)?,
                            row.get::<_, Option<String>>(11)?,
                        ))
                    },
                )
                .map_err(|error| format!("無法查詢閱讀紀錄：{error}"))?;
            let rows = rows
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            drop(statement);
            tx.commit()
                .map_err(|error| format!("無法完成閱讀紀錄查詢快照：{error}"))?;
            let items = rows
                .into_iter()
                .map(|row| {
                    let (
                        session,
                        id,
                        source_id,
                        relative_path,
                        opened_at,
                        title,
                        page_count,
                        offline,
                        progress_page,
                        progress_total,
                        progress_percent,
                        progress_updated_at,
                    ) = row;
                    ReadingHistoryItem {
                        id: session,
                        opened_at,
                        comic: ReadingHistoryComic {
                            id,
                            source_id,
                            relative_path,
                            title,
                            page_count: page_count.max(0) as usize,
                            progress: crate::state::Progress {
                                current_page: progress_page.max(0) as usize,
                                total_pages: progress_total.max(0) as usize,
                                percent: progress_percent,
                                updated_at: progress_updated_at,
                            },
                            offline: offline != 0,
                        },
                    }
                })
                .collect();
            Ok(ReadingHistoryPage {
                items,
                total: total.max(0) as usize,
            })
        })
    }

    /// Registers one already-authorized and successfully opened location.
    /// Unlike a library sync, this never retires any other source or location.
    pub(crate) fn register_opened_location(
        &self,
        comic: &ComicItem,
        verified_pages: usize,
        is_directory: bool,
    ) -> Result<crate::state::Progress, String> {
        if comic.id.trim().is_empty()
            || comic.source_id.trim().is_empty()
            || comic.relative_path.trim().is_empty()
            || verified_pages == 0
            || is_quarantine_relative_path(&comic.relative_path)
        {
            return Err("已驗證漫畫來源位置資訊不完整，拒絕登記目錄".into());
        }
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let conflicting_identity: bool = tx
                .query_row(
                    "SELECT EXISTS(
                       SELECT 1 FROM comic_locations
                       WHERE source_id=?1 AND (runtime_id=?2 OR comic_id=?2)
                         AND relative_path<>?3
                     )",
                    params![comic.source_id, comic.id, comic.relative_path],
                    |row| row.get::<_, i64>(0).map(|value| value != 0),
                )
                .map_err(|error| error.to_string())?;
            if conflicting_identity {
                return Err("此來源的漫畫識別碼已綁定其他位置，拒絕登記".into());
            }
            let location_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM comic_locations WHERE source_id=?1 AND relative_path=?2)",
                    params![comic.source_id, comic.relative_path],
                    |row| row.get::<_, i64>(0).map(|value| value != 0),
                )
                .map_err(|error| error.to_string())?;
            #[cfg(test)]
            tests::run_opened_location_read_hook();
            let (comic_id, _) = upsert_location(&tx, comic, None, None, None)?;
            if !location_exists {
                let filename_source = metadata::filename_metadata_for_discovered_path(
                    Path::new(&comic.relative_path),
                    is_directory,
                );
                replace_imports(
                    &tx,
                    &comic_id,
                    &comic.relative_path,
                    vec![filename_source],
                    vec![],
                    vec![],
                )?;
                resolve_effective_metadata(&tx, &comic_id)?;
                if comic.progress.total_pages == verified_pages
                    && comic.progress.current_page < verified_pages
                    && comic.progress.percent.is_finite()
                    && (0.0..=100.0).contains(&comic.progress.percent)
                {
                    import_runtime_progress(&tx, &comic_id, &comic.progress)?;
                }
            }
            tx.execute(
                "UPDATE comics SET offline=0 WHERE id=?1",
                [&comic_id],
            )
            .map_err(|error| error.to_string())?;
            refresh_fts(&tx, &comic_id)?;
            let progress = tx
                .query_row(
                    "SELECT current_page,total_pages,percent,updated_at FROM reading_progress WHERE comic_id=?1",
                    [&comic_id],
                    |row| {
                        Ok(crate::state::Progress {
                            current_page: row.get::<_, i64>(0)?.max(0) as usize,
                            total_pages: row.get::<_, i64>(1)?.max(0) as usize,
                            percent: row.get(2)?,
                            updated_at: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(|error| error.to_string())?
                .unwrap_or(crate::state::Progress {
                    current_page: 0,
                    total_pages: 0,
                    percent: 0.0,
                    updated_at: None,
                });
            tx.commit().map_err(|error| error.to_string())?;
            Ok(progress)
        })
    }

    pub fn get_runtime_items_by_ids(&self, ids: &[String]) -> Result<Vec<ComicItem>, String> {
        if ids.len() > RUNTIME_ITEM_IDS_MAX {
            return Err(format!(
                "漫畫批次查詢最多支援 {RUNTIME_ITEM_IDS_MAX} 個識別碼"
            ));
        }
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(RUNTIME_ITEM_QUERY)
                .map_err(|error| error.to_string())?;
            let mut seen = HashSet::with_capacity(ids.len());
            let mut items = Vec::with_capacity(ids.len());
            for identifier in ids {
                if !seen.insert(identifier.as_str()) {
                    continue;
                }
                if let Some(item) = load_runtime_item_from_statement(&mut statement, identifier)? {
                    items.push(item);
                }
            }
            Ok(items)
        })
    }

    pub fn get_recent_reading_runtime_item(&self) -> Result<Option<ComicItem>, String> {
        self.with_connection(|connection| {
            let visible_location = visible_location_predicate("l");
            let query = format!(
                "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id,
                        p.current_page,p.total_pages,p.percent,p.updated_at
                 FROM reading_progress p
                 JOIN comic_locations l ON l.comic_id=p.comic_id
                 JOIN comics c ON c.id=l.comic_id
                 WHERE (p.current_page > 0 OR p.total_pages = 1)
                   AND p.updated_at IS NOT NULL
                   AND trim(p.updated_at) <> ''
                   AND l.runtime_id IS NOT NULL
                   AND trim(l.runtime_id) <> ''
                   AND {visible_location}
                 ORDER BY datetime(p.updated_at) DESC,p.updated_at DESC,
                          l.online DESC,l.last_seen_at DESC
                 LIMIT 1"
            );
            connection
                .query_row(&query, [], comic_item_from_row)
                .optional()
                .map_err(|error| error.to_string())
        })
    }

    pub fn search(&self, query: CatalogQuery) -> Result<CatalogSearchResult, String> {
        self.with_connection(|connection| {
            // Keep candidate selection and view hydration on one SQLite
            // snapshot. Otherwise a source cleanup between the EXISTS query
            // and build_view could turn a valid candidate into a locationless
            // orphan (or vice versa).
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Deferred)
                .map_err(|error| error.to_string())?;
            match search_catalog(&tx, query) {
                Ok(result) => {
                    tx.commit().map_err(|error| error.to_string())?;
                    Ok(result)
                }
                Err(error) => Err(error),
            }
        })
    }

    pub fn discovery_tags(&self, runtime_ids: &[String]) -> Result<Vec<DiscoveryTagGroup>, String> {
        if runtime_ids.len() > RUNTIME_ITEM_IDS_MAX {
            return Err("一次探索的作品數量超過限制".into());
        }
        if runtime_ids.iter().any(|id| id.len() > 4096) {
            return Err("探索作品識別碼過長".into());
        }
        if runtime_ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| discovery_tag_groups(connection, runtime_ids, &[]))
    }

    pub fn discovery_tags_for_targets(
        &self,
        targets: &[BatchEditTarget],
    ) -> Result<Vec<DiscoveryTagGroup>, String> {
        if targets.len() > RUNTIME_ITEM_IDS_MAX {
            return Err("一次探索的作品數量超過限制".into());
        }
        if targets.iter().any(|target| {
            target.runtime_id.len() > 4096
                || target.source_id.len() > 4096
                || target.relative_path.len() > 4096
        }) {
            return Err("探索作品來源識別碼過長".into());
        }
        if targets.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| discovery_tag_groups(connection, &[], targets))
    }

    pub fn tag_inventory(&self, query: TagInventoryQuery) -> Result<TagInventoryResult, String> {
        self.with_connection(|connection| load_tag_inventory(connection, query))
    }

    pub fn update_tag_state(&self, update: TagStateUpdate) -> Result<(), String> {
        let allowed_colors = [
            "rose", "amber", "lime", "cyan", "blue", "violet", "fuchsia", "slate", "none",
        ];
        if update
            .color_key
            .as_deref()
            .is_some_and(|color| !allowed_colors.contains(&color))
        {
            return Err("不支援的標籤色票".into());
        }
        self.with_connection(|connection| {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM canonical_tags WHERE id=?1)",
                    [update.tag_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !exists {
                return Err("找不到標籤".into());
            }
            connection
                .execute(
                    "INSERT INTO tag_user_state(tag_id,pinned,color_key) VALUES(?1,?2,?3)
                     ON CONFLICT(tag_id) DO UPDATE SET pinned=excluded.pinned,color_key=excluded.color_key",
                    params![update.tag_id, update.pinned, update.color_key],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        })
    }

    pub fn rename_tag(
        &self,
        tag_id: i64,
        display_value: &str,
    ) -> Result<TagMutationResult, String> {
        let display_value = display_value.trim();
        if display_value.is_empty() {
            return Err("標籤名稱不可為空".into());
        }
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let (namespace, old_display, old_normalized, disabled): (String, String, String, i64) = tx
                .query_row(
                    "SELECT namespace,display_value,normalized_value,disabled FROM canonical_tags WHERE id=?1",
                    [tag_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(|error| format!("找不到標籤：{error}"))?;
            let normalized = normalize_tag_key(display_value);
            let collision: Option<i64> = tx
                .query_row(
                    "SELECT id FROM canonical_tags WHERE namespace=?1 AND normalized_value=?2 AND id<>?3",
                    params![namespace, normalized, tag_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if collision.is_some() {
                return Err("新名稱已存在；請使用合併標籤以保留來源證據".into());
            }
            let affected_works = tag_work_count(&tx, tag_id)?;
            tx.execute(
                "UPDATE canonical_tags SET display_value=?2,normalized_value=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![tag_id, display_value, normalized],
            )
            .map_err(|error| error.to_string())?;
            let token = uuid::Uuid::new_v4().to_string();
            let snapshot = json!({
                "version": 1,
                "kind": "rename",
                "tagId": tag_id,
                "before": {"display": old_display, "normalized": old_normalized, "disabled": disabled},
                "after": {"display": display_value, "normalized": normalized, "disabled": disabled}
            });
            tx.execute(
                "INSERT INTO tag_operations(token,snapshot_json) VALUES(?1,?2)",
                params![token, snapshot.to_string()],
            )
            .map_err(|error| error.to_string())?;
            refresh_fts_for_canonical_tags(&tx, &[tag_id])?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(TagMutationResult { affected_works, undo_token: token })
        })
    }

    pub fn merge_tags(
        &self,
        source_tag_id: i64,
        target_tag_id: i64,
    ) -> Result<TagMutationResult, String> {
        if source_tag_id == target_tag_id {
            return Err("來源與目標標籤不可相同".into());
        }
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let final_target = final_canonical_tag_id(&tx, target_tag_id)?;
            if final_target == source_tag_id {
                return Err("標籤合併會形成循環，已拒絕".into());
            }
            let source_disabled: i64 = tx
                .query_row("SELECT disabled FROM canonical_tags WHERE id=?1", [source_tag_id], |row| row.get(0))
                .map_err(|error| format!("找不到來源標籤：{error}"))?;
            let previous_target: Option<i64> = tx
                .query_row("SELECT target_tag_id FROM tag_redirects WHERE source_tag_id=?1", [source_tag_id], |row| row.get(0))
                .optional().map_err(|error| error.to_string())?;
            let incoming = {
                let mut statement = tx.prepare("SELECT source_tag_id FROM tag_redirects WHERE target_tag_id=?1 AND source_tag_id<>?1 ORDER BY source_tag_id").map_err(|error| error.to_string())?;
                let rows = statement.query_map([source_tag_id], |row| row.get::<_, i64>(0)).map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
                rows
            };
            let affected_works = tag_work_count(&tx, source_tag_id)?;
            tx.execute(
                "UPDATE tag_redirects SET target_tag_id=?2 WHERE target_tag_id=?1",
                params![source_tag_id, final_target],
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO tag_redirects(source_tag_id,target_tag_id) VALUES(?1,?2)
                 ON CONFLICT(source_tag_id) DO UPDATE SET target_tag_id=excluded.target_tag_id,created_at=CURRENT_TIMESTAMP",
                params![source_tag_id, final_target],
            ).map_err(|error| error.to_string())?;
            tx.execute("UPDATE canonical_tags SET disabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=?1", [source_tag_id])
                .map_err(|error| error.to_string())?;
            let token = uuid::Uuid::new_v4().to_string();
            let snapshot = json!({
                "version": 1, "kind": "merge", "sourceTagId": source_tag_id,
                "before": {"target": previous_target, "disabled": source_disabled, "incoming": incoming},
                "after": {"target": final_target, "disabled": 1}
            });
            tx.execute("INSERT INTO tag_operations(token,snapshot_json) VALUES(?1,?2)", params![token, snapshot.to_string()])
                .map_err(|error| error.to_string())?;
            refresh_fts_for_canonical_tags(&tx, &[source_tag_id, final_target])?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(TagMutationResult { affected_works, undo_token: token })
        })
    }

    pub fn set_tag_disabled(
        &self,
        tag_id: i64,
        disabled: bool,
    ) -> Result<TagMutationResult, String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let before: i64 = tx
                .query_row(
                    "SELECT disabled FROM canonical_tags WHERE id=?1",
                    [tag_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("找不到標籤：{error}"))?;
            let after = i64::from(disabled);
            let affected_works = tag_work_count(&tx, tag_id)?;
            tx.execute(
                "UPDATE canonical_tags SET disabled=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![tag_id, after],
            )
            .map_err(|error| error.to_string())?;
            let token = uuid::Uuid::new_v4().to_string();
            let snapshot =
                json!({"version":1,"kind":"disable","tagId":tag_id,"before":before,"after":after});
            tx.execute(
                "INSERT INTO tag_operations(token,snapshot_json) VALUES(?1,?2)",
                params![token, snapshot.to_string()],
            )
            .map_err(|error| error.to_string())?;
            refresh_fts_for_canonical_tags(&tx, &[tag_id])?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(TagMutationResult {
                affected_works,
                undo_token: token,
            })
        })
    }

    pub fn undo_tag_operation(&self, token: &str) -> Result<bool, String> {
        self.with_connection(|connection| undo_tag_mutation(connection, token))
    }

    pub fn save_progress(
        &self,
        identifier: &str,
        progress: &crate::state::Progress,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let comic_id = resolve_progress_comic_id(&tx, identifier, None)?
                .ok_or_else(|| format!("找不到漫畫進度身分：{identifier}"))?;
            persist_progress_write(&tx, &comic_id, progress, None)?;
            tx.commit().map_err(|error| error.to_string())
        })
    }

    /// Saves progress only when `identifier` and `source_id` identify exactly
    /// one catalog location. Runtime IDs are source-scoped, so this must be
    /// used by clients that have the source identity returned by `open_comic`.
    pub fn save_progress_for_source(
        &self,
        identifier: &str,
        source_id: &str,
        progress: &crate::state::Progress,
    ) -> Result<(), String> {
        self.save_progress_for_source_with_intent(identifier, source_id, progress, None)
    }

    pub fn save_progress_for_source_with_intent(
        &self,
        identifier: &str,
        source_id: &str,
        progress: &crate::state::Progress,
        intent_sequence: Option<u64>,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let comic_id = resolve_progress_comic_id(&tx, identifier, Some(source_id))?
                .ok_or_else(|| format!("找不到來源漫畫進度身分：{identifier} ({source_id})"))?;
            persist_progress_write(&tx, &comic_id, progress, intent_sequence)?;
            tx.commit().map_err(|error| error.to_string())
        })
    }

    /// Saves progress only if runtime ID, source, and relative path still name
    /// one exact catalog location in the same SQLite write transaction.
    pub fn save_progress_for_source_location(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
        progress: &crate::state::Progress,
    ) -> Result<(), String> {
        self.save_progress_for_source_location_with_intent(
            identifier,
            source_id,
            relative_path,
            progress,
            None,
        )
    }

    pub fn save_progress_for_source_location_with_intent(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
        progress: &crate::state::Progress,
        intent_sequence: Option<u64>,
    ) -> Result<(), String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let mut statement = tx
                .prepare(
                    "SELECT comic_id,relative_path FROM comic_locations
                     WHERE source_id=?2 AND (runtime_id=?1 OR comic_id=?1)",
                )
                .map_err(|error| error.to_string())?;
            let matches = statement
                .query_map(params![identifier, source_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            drop(statement);
            let comic_id = match matches.as_slice() {
                [(comic_id, path)] if path == relative_path => comic_id,
                [] => return Err("來源漫畫位置已變更，已拒絕寫入進度".into()),
                [_] => return Err("來源漫畫位置已變更，已拒絕寫入進度".into()),
                _ => return Err("來源漫畫位置不唯一，已拒絕寫入進度".into()),
            };
            persist_progress_write(&tx, comic_id, progress, intent_sequence)?;
            tx.commit().map_err(|error| error.to_string())
        })
    }

    /// Persist a native open proof together with the current progress baseline.
    /// The source location must resolve uniquely at the time the proof is issued.
    pub fn register_progress_recovery_proof(
        &self,
        proof: ProgressRecoveryProof<'_>,
    ) -> Result<u64, String> {
        if proof.token.is_empty() || proof.total_pages == 0 {
            return Err("原生開書憑證格式不正確".into());
        }
        let persisted_revision = if proof.smb_content_hash.is_some() {
            crate::state::SourceRevision {
                len: proof.revision.len,
                modified: None,
                ctime: None,
                file_id: None,
            }
        } else {
            proof.revision.clone()
        };
        let revision_json =
            serde_json::to_string(&persisted_revision).map_err(|error| error.to_string())?;
        self.with_connection(|connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            let comic_id = exact_progress_comic_id(&tx, proof.identifier, proof.source_id, proof.relative_path)?;
            let (page,total,updated): (i64,i64,Option<String>) = tx.query_row(
                "SELECT current_page,total_pages,updated_at FROM reading_progress WHERE comic_id=?1",
                [&comic_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))
            ).optional().map_err(|error| error.to_string())?.unwrap_or((0,0,None));
            let fence: i64 = tx.query_row("SELECT intent_sequence FROM progress_intent_fences WHERE comic_id=?1", [&comic_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.unwrap_or(0);
            tx.execute(
                "DELETE FROM progress_recovery_proofs WHERE comic_id=?1 AND source_id=?2 AND relative_path=?3",
                params![comic_id, proof.source_id, proof.relative_path],
            ).map_err(|error| error.to_string())?;
            tx.execute("INSERT OR REPLACE INTO progress_recovery_proofs(token,comic_id,source_id,relative_path,total_pages,revision_json,smb_content_hash,baseline_page,baseline_total,baseline_updated_at,intent_sequence)
                        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![proof.token,comic_id,proof.source_id,proof.relative_path,proof.total_pages as i64,revision_json,proof.smb_content_hash.map(|hash| hash.to_vec()),page,total,updated,fence])
                .map_err(|error| error.to_string())?;
            tx.execute("DELETE FROM progress_recovery_proofs WHERE token IN (SELECT token FROM progress_recovery_proofs ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 64)", []).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(fence as u64)
        })
    }

    pub fn progress_intent_floor(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
    ) -> Result<u64, String> {
        self.with_connection(|connection| {
            let comic_id =
                exact_progress_comic_id(connection, identifier, source_id, relative_path)?;
            let fence: Option<i64> = connection
                .query_row(
                    "SELECT intent_sequence FROM progress_intent_fences WHERE comic_id=?1",
                    [&comic_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            Ok(fence.unwrap_or(0).max(0) as u64)
        })
    }

    pub fn progress_for_source_location(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
    ) -> Result<Option<crate::state::Progress>, String> {
        self.with_connection(|connection| {
            let comic_id = exact_progress_comic_id(connection, identifier, source_id, relative_path)?;
            connection.query_row("SELECT current_page,total_pages,percent,updated_at FROM reading_progress WHERE comic_id=?1", [&comic_id], |row| {
                Ok(crate::state::Progress { current_page: row.get::<_,i64>(0)?.max(0) as usize, total_pages: row.get::<_,i64>(1)?.max(0) as usize, percent: row.get(2)?, updated_at: row.get(3)? })
            }).optional().map_err(|error| error.to_string())
        })
    }

    pub fn load_progress_recovery_evidence(
        &self,
        identifier: &str,
        source_id: &str,
        relative_path: &str,
        token: &str,
    ) -> Result<Option<crate::state::ProgressRecoveryEvidence>, String> {
        self.with_connection(|connection| {
            let comic_id = exact_progress_comic_id(connection, identifier, source_id, relative_path)?;
            let proof: Option<(i64,String,Option<Vec<u8>>,i64)> = connection.query_row(
                "SELECT total_pages,revision_json,smb_content_hash,intent_sequence FROM progress_recovery_proofs WHERE token=?1 AND comic_id=?2 AND source_id=?3 AND relative_path=?4",
                params![token,comic_id,source_id,relative_path],
                |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))
            ).optional().map_err(|error| error.to_string())?;
            let Some((pages,revision_json,hash,intent_sequence)) = proof else { return Ok(None); };
            let revision: crate::state::SourceRevision = serde_json::from_str(&revision_json).map_err(|error| error.to_string())?;
            let smb_content_hash = hash.map(|bytes| {
                let mut digest = [0u8;32];
                if bytes.len() == 32 { digest.copy_from_slice(&bytes); }
                digest
            });
            Ok(Some(crate::state::ProgressRecoveryEvidence {
                source_id: source_id.to_owned(), relative_path: relative_path.to_owned(), total_pages: pages.max(0) as usize,
                generation: intent_sequence.max(0) as u64, revision: Some(revision), smb_content_hash, token: token.to_owned(),
            }))
        })
    }

    pub fn recover_progress_for_source_location(
        &self,
        request: ProgressRecoveryCommit<'_>,
    ) -> Result<(), String> {
        validate_intent_sequence(request.intent_sequence)?;
        self.with_connection(|connection| {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            let comic_id = exact_progress_comic_id(&tx, request.identifier, request.source_id, request.relative_path)?;
            let proof: Option<PersistedProgressRecoveryProof> = tx.query_row(
                "SELECT comic_id,source_id,relative_path,total_pages,revision_json,smb_content_hash,baseline_page,baseline_total,baseline_updated_at,intent_sequence FROM progress_recovery_proofs WHERE token=?1",
                [request.token], |row| Ok(PersistedProgressRecoveryProof {
                    comic_id: row.get(0)?, source_id: row.get(1)?, relative_path: row.get(2)?,
                    total_pages: row.get(3)?, revision_json: row.get(4)?, smb_content_hash: row.get(5)?,
                    baseline_page: row.get(6)?, baseline_total: row.get(7)?, baseline_updated_at: row.get(8)?,
                    intent_sequence: row.get(9)?,
                })
            ).optional().map_err(|error| error.to_string())?;
            let Some(proof) = proof else { return Err("原生開書憑證不存在，已保留待復原紀錄".into()); };
            let observed_hash = request.smb_content_hash.map(|hash| hash.to_vec());
            let persisted_revision = if request.smb_content_hash.is_some() { crate::state::SourceRevision { len: request.revision.len, modified: None, ctime: None, file_id: None } } else { request.revision.clone() };
            if proof.comic_id != comic_id || proof.source_id != request.source_id || proof.relative_path != request.relative_path || proof.total_pages != request.total_pages as i64 || proof.revision_json != serde_json::to_string(&persisted_revision).map_err(|error| error.to_string())? || proof.smb_content_hash != observed_hash {
                return Err("原生開書憑證與來源版本不符，已保留待復原紀錄".into());
            }
            let (page,total,updated): (i64,i64,Option<String>) = tx.query_row("SELECT current_page,total_pages,updated_at FROM reading_progress WHERE comic_id=?1", [&comic_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|error| error.to_string())?.unwrap_or((0,0,None));
            let canonical_fence: i64 = tx.query_row("SELECT intent_sequence FROM progress_intent_fences WHERE comic_id=?1", [&comic_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?.unwrap_or(0);
            let same_saved = page == request.current_page as i64 && total == request.total_pages as i64 && canonical_fence == request.intent_sequence as i64;
            if !(same_saved && proof.intent_sequence == canonical_fence) {
                if (page,total,updated) != (proof.baseline_page,proof.baseline_total,proof.baseline_updated_at) || proof.intent_sequence != canonical_fence || request.intent_sequence as i64 <= canonical_fence {
                    return Err("目錄進度或閱讀意圖已改變，已保留待復原紀錄".into());
                }
                save_progress_row(&tx, &comic_id, request.progress)?;
                tx.execute("INSERT INTO progress_intent_fences(comic_id,intent_sequence) VALUES(?1,?2) ON CONFLICT(comic_id) DO UPDATE SET intent_sequence=excluded.intent_sequence", params![comic_id,request.intent_sequence as i64]).map_err(|error| error.to_string())?;
                update_recovery_proof_baselines(&tx, &comic_id, request.progress, request.intent_sequence)?;
            }
            tx.commit().map_err(|error| error.to_string())
        })
    }

    pub fn apply_batch(&self, request: BatchEditRequest) -> Result<BatchEditResult, String> {
        if request.comic_ids.is_empty() && request.targets.is_empty() {
            return Err("請至少選取一本漫畫".into());
        }
        let target_count = if request.targets.is_empty() {
            request.comic_ids.len()
        } else {
            request.targets.len()
        };
        if target_count > 10_000 {
            return Err("單次批次操作上限為 10,000 本".into());
        }
        if !request.targets.is_empty()
            && !request.comic_ids.is_empty()
            && request.targets.len() != request.comic_ids.len()
        {
            return Err("批次 comicIds 與 targets 數量不一致".into());
        }
        for field in request.fields.keys() {
            if !allowed_user_field(field) {
                return Err(format!("不支援修改欄位：{field}"));
            }
        }
        self.with_connection(|connection| {
            // Take the write lock before resolving any target. A concurrent
            // forget/reimport must wait for this complete batch, so the
            // source-qualified lookup and all writes share one snapshot.
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let resolved_ids = if request.targets.is_empty() {
                request
                    .comic_ids
                    .iter()
                    .map(|id| resolve_legacy_batch_id_tx(&tx, id))
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                if !request.comic_ids.is_empty()
                    && request
                        .comic_ids
                        .iter()
                        .zip(&request.targets)
                        .any(|(id, target)| id != &target.runtime_id)
                {
                    return Err("批次 comicIds 與 targets runtimeId 不一致".into());
                }
                request
                    .targets
                    .iter()
                    .map(|target| resolve_batch_target_tx(&tx, target))
                    .collect::<Result<Vec<_>, _>>()?
            };
            let comic_ids = resolved_ids.into_iter().collect::<BTreeSet<_>>();
            if comic_ids.is_empty() {
                return Err("請至少選取一本漫畫".into());
            }
            let before = snapshot_overrides(&tx, &comic_ids)?;
            for comic_id in &comic_ids {
                for (field, value) in &request.fields {
                    let value_json = if field == "creators" {
                        match value.as_ref() {
                            Some(item) => {
                                let creators = serde_json::from_str::<BTreeMap<String, Vec<String>>>(item)
                                    .map_err(|error| format!("creators 欄位 JSON 格式錯誤：{error}"))?;
                                serde_json::to_string(&creators)
                                    .map_err(|error| format!("creators 欄位無法序列化：{error}"))?
                            }
                            None => Value::Null.to_string(),
                        }
                    } else {
                        serde_json::to_string(value).map_err(|error| error.to_string())?
                    };
                    tx.execute(
                        "INSERT INTO user_field_overrides(comic_id, field_key, value_json, updated_at) VALUES(?1, ?2, ?3, CURRENT_TIMESTAMP) ON CONFLICT(comic_id, field_key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP",
                        params![comic_id, field, value_json],
                    ).map_err(|error| error.to_string())?;
                }
                for tag in &request.add_tags {
                    let raw_tag_id = set_tag_override(&tx, comic_id, tag, "include")?;
                    mark_tag_used(&tx, raw_tag_id)?;
                }
                for tag in &request.exclude_tags { set_tag_override(&tx, comic_id, tag, "exclude")?; }
                resolve_effective_metadata(&tx, comic_id)?;
                refresh_fts(&tx, comic_id)?;
            }
            let after = snapshot_overrides(&tx, &comic_ids)?;
            let undo_token = uuid::Uuid::new_v4().to_string();
            let undo_snapshot = json!({"version": 2, "before": before, "after": after});
            tx.execute("INSERT INTO batch_operations(token, snapshot_json, created_at) VALUES(?1, ?2, CURRENT_TIMESTAMP)", params![undo_token, undo_snapshot.to_string()]).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(BatchEditResult { updated: comic_ids.len(), undo_token })
        })
    }

    pub fn undo_batch(&self, token: &str) -> Result<usize, String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let snapshot: String = tx
                .query_row(
                    "SELECT snapshot_json FROM batch_operations WHERE token = ?1",
                    [token],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or("找不到可撤銷的批次操作")?;
            let value: Value =
                serde_json::from_str(&snapshot).map_err(|error| error.to_string())?;
            if value.get("version").and_then(Value::as_i64) != Some(2) {
                return Err("這筆撤銷來自舊版格式；為避免刪除後續編輯，已安全拒絕".into());
            }
            let before = value
                .get("before")
                .and_then(Value::as_object)
                .ok_or("撤銷快照缺少 before")?;
            let after = value
                .get("after")
                .and_then(Value::as_object)
                .ok_or("撤銷快照缺少 after")?;
            let comic_ids = before
                .keys()
                .chain(after.keys())
                .cloned()
                .collect::<BTreeSet<_>>();
            let mut reverted = 0;
            for comic_id in &comic_ids {
                let ids = BTreeSet::from([comic_id.clone()]);
                let current = snapshot_overrides(&tx, &ids)?;
                let current = current
                    .get(comic_id)
                    .cloned()
                    .unwrap_or_else(empty_override_snapshot);
                let before_comic = before
                    .get(comic_id)
                    .cloned()
                    .unwrap_or_else(empty_override_snapshot);
                let after_comic = after
                    .get(comic_id)
                    .cloned()
                    .unwrap_or_else(empty_override_snapshot);
                if revert_override_delta(&tx, comic_id, &before_comic, &after_comic, &current)? {
                    resolve_effective_metadata(&tx, comic_id)?;
                    refresh_fts(&tx, comic_id)?;
                    reverted += 1;
                }
            }
            tx.execute("DELETE FROM batch_operations WHERE token = ?1", [token])
                .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(reverted)
        })
    }

    pub fn upsert_folder_rule(&self, rule: FolderTagRule) -> Result<FolderTagRule, String> {
        if rule.source_id.trim().is_empty() {
            return Err("資料夾規則缺少來源".into());
        }
        self.with_connection(|connection| {
            let tx = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let tag_id = ensure_tag_tx(&tx, &rule.tag)?;
            let folder_path = normalize_path(&rule.folder_path);
            tx.execute(
                "INSERT INTO folder_tag_rules(source_id, folder_path, tag_id, enabled, updated_at) VALUES(?1, ?2, ?3, ?4, CURRENT_TIMESTAMP) ON CONFLICT(source_id, folder_path, tag_id) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP",
                params![rule.source_id, folder_path, tag_id, rule.enabled],
            ).map_err(|error| error.to_string())?;
            let id = tx.query_row("SELECT id FROM folder_tag_rules WHERE source_id = ?1 AND folder_path = ?2 AND tag_id = ?3", params![rule.source_id, folder_path, tag_id], |row| row.get(0)).map_err(|error| error.to_string())?;
            let comic_ids = comic_ids_for_source(&tx, &rule.source_id)?;
            for comic_id in comic_ids { refresh_fts(&tx, &comic_id)?; }
            tx.commit().map_err(|error| error.to_string())?;
            Ok(FolderTagRule { id: Some(id), folder_path, ..rule })
        })
    }

    pub fn reimport(&self, request: ReimportRequest) -> Result<ReimportResult, String> {
        if request.comic_ids.len() > 10_000 || request.targets.len() > 10_000 {
            return Err("單次指定重新匯入上限為 10,000 本".into());
        }
        if request.comic_ids.is_empty() && request.targets.is_empty() {
            // Empty means reimport the whole currently online catalog.
        } else if !request.targets.is_empty()
            && !request.comic_ids.is_empty()
            && request.targets.len() != request.comic_ids.len()
        {
            return Err("重匯 comicIds 與 targets 數量不一致".into());
        }
        let targets = self.with_connection(|connection| {
            let tx = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let mut targets = Vec::new();
            if request.comic_ids.is_empty() && request.targets.is_empty() {
                let rows = {
                    let mut statement = tx
                        .prepare("SELECT comic_id, actual_path FROM comic_locations WHERE online = 1 AND actual_path IS NOT NULL")
                        .map_err(|error| error.to_string())?;
                    let rows = statement
                        .query_map([], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        })
                        .map_err(|error| error.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| error.to_string())?;
                    rows
                };
                for (comic_id, path) in rows {
                    targets.push(ReimportResolvedTarget {
                        comic_id,
                        path,
                        identity: None,
                    });
                }
            } else if !request.targets.is_empty() {
                if !request.comic_ids.is_empty()
                    && request
                        .comic_ids
                        .iter()
                        .zip(&request.targets)
                        .any(|(id, target)| id != &target.runtime_id)
                {
                    return Err("重匯 comicIds 與 targets runtimeId 不一致".into());
                }
                for target in &request.targets {
                    targets.push(resolve_reimport_target_tx(&tx, target)?);
                }
            } else {
                for identifier in &request.comic_ids {
                    let comic_id = resolve_legacy_batch_id_tx(&tx, identifier)?;
                    let mut statement = tx
                        .prepare("SELECT actual_path FROM comic_locations WHERE comic_id = ?1 AND online = 1 AND actual_path IS NOT NULL ORDER BY last_seen_at DESC")
                        .map_err(|error| error.to_string())?;
                    let rows = statement
                        .query_map([comic_id.as_str()], |row| row.get::<_, String>(0))
                        .map_err(|error| error.to_string())?;
                    for path in rows {
                        targets.push(ReimportResolvedTarget {
                            comic_id: comic_id.clone(),
                            path: path.map_err(|error| error.to_string())?,
                            identity: None,
                        });
                    }
                }
            }
            tx.commit().map_err(|error| error.to_string())?;
            Ok(targets)
        })?;
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .thread_name(|index| format!("comic-reimport-{index}"))
            .build()
            .map_err(|error| error.to_string())?;
        let parsed = pool.install(|| {
            targets
                .into_par_iter()
                .map(|target| {
                    let outcome = metadata::parse_metadata_for_path(Path::new(&target.path));
                    (target, outcome)
                })
                .collect::<Vec<_>>()
        });
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let mut diagnostics = 0;
            for (target, outcome) in parsed.iter() {
                if let Some(identity) = target.identity.as_ref() {
                    let current: Option<(String, String)> = tx
                        .query_row(
                            "SELECT comic_id,actual_path
                             FROM comic_locations
                             WHERE runtime_id=?1 AND source_id=?2 AND relative_path=?3
                               AND online=1 AND actual_path IS NOT NULL
                             LIMIT 1",
                            params![
                                identity.runtime_id,
                                identity.source_id,
                                identity.relative_path
                            ],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )
                        .optional()
                        .map_err(|error| error.to_string())?;
                    if current.as_ref().map(|(_, path)| path.as_str()) != Some(target.path.as_str())
                        || current.as_ref().map(|(comic_id, _)| comic_id.as_str())
                            != Some(target.comic_id.as_str())
                    {
                        return Err(format!(
                            "重匯期間來源位置已變更：{} / {} / {}",
                            identity.runtime_id, identity.source_id, identity.relative_path
                        ));
                    }
                }
                diagnostics += outcome.diagnostics.len();
                replace_imports(
                    &tx,
                    &target.comic_id,
                    &target.path,
                    outcome.sources.clone(),
                    outcome.diagnostics.clone(),
                    outcome.failures.clone(),
                )?;
                resolve_effective_metadata(&tx, &target.comic_id)?;
                refresh_fts(&tx, &target.comic_id)?;
            }
            tx.commit().map_err(|error| error.to_string())?;
            Ok(ReimportResult {
                imported: parsed.len(),
                diagnostics,
            })
        })
    }

    pub fn store_ai_candidates(
        &self,
        comic_id: &str,
        provider: &str,
        model: &str,
        raw_response: &str,
        candidates: Vec<(String, Value, f64)>,
    ) -> Result<(), String> {
        if !matches!(provider, "openai" | "google") || model.trim().is_empty() {
            return Err("艦載 AI 候選來源不受支援".into());
        }
        if candidates.is_empty() {
            return Ok(());
        }
        // A library scan writes batches in separate transactions. Keep the already
        // paid-for AI result and retry its short metadata write across a busy batch.
        let started = std::time::Instant::now();
        loop {
            let result =
                self.store_ai_candidates_once(comic_id, provider, model, raw_response, &candidates);
            match result {
                Err(error)
                    if started.elapsed() < Duration::from_secs(20)
                        && (error.contains("database is locked")
                            || error.contains("database table is locked")) =>
                {
                    std::thread::sleep(Duration::from_millis(500));
                }
                other => return other,
            }
        }
    }

    fn store_ai_candidates_once(
        &self,
        comic_id: &str,
        provider: &str,
        model: &str,
        raw_response: &str,
        candidates: &[(String, Value, f64)],
    ) -> Result<(), String> {
        let raw_digest = blake3::hash(raw_response.as_bytes()).to_hex().to_string();
        let source_path = format!("ai://{provider}/session/{raw_digest}");
        self.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            let resolved = resolve_comic_id_tx(&tx, comic_id)?;
            let parser_id = format!("ai:{provider}");
            tx.execute(
                "DELETE FROM metadata_sources WHERE comic_id=?1 AND parser_id=?2",
                params![resolved, parser_id],
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO metadata_sources(comic_id, parser_id, parser_version, source_path, source_digest, confidence, raw_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![resolved, parser_id, model, source_path, raw_digest, 0.0_f64, raw_response],
            ).map_err(|error| error.to_string())?;
            let source_id = tx.last_insert_rowid();
            for (field, value, confidence) in candidates {
                tx.execute(
                    "INSERT INTO metadata_candidates(comic_id, source_id, field_key, value_json, priority, confidence) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                    params![resolved, source_id, field, value.to_string(), 5_i64, confidence],
                ).map_err(|error| error.to_string())?;
                if field == "tags" {
                    if let Some(tags) = value.as_array() {
                        for tag in tags {
                            let scoped: ScopedTag = serde_json::from_value(tag.clone())
                                .map_err(|error| format!("艦載 AI 標籤格式錯誤：{error}"))?;
                            let tag_id = ensure_tag_tx(&tx, &scoped)?;
                            tx.execute(
                                "INSERT OR IGNORE INTO comic_tag_candidates(comic_id, tag_id, source_id) VALUES(?1, ?2, ?3)",
                                params![resolved, tag_id, source_id],
                            ).map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
            tx.commit().map_err(|error| error.to_string())
        })
    }

    pub fn diagnostics(&self, limit: usize) -> Result<Vec<ImportDiagnostic>, String> {
        self.with_connection(|connection| load_diagnostics(connection, None, limit.clamp(1, 1000)))
    }

    pub fn mark_source_offline(&self, source_id: &str) -> Result<usize, String> {
        self.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            let comic_ids = {
                let mut statement = tx
                    .prepare(
                        "SELECT DISTINCT comic_id FROM comic_locations
                         WHERE source_id=?1 AND online=1",
                    )
                    .map_err(|error| error.to_string())?;
                let rows = statement
                    .query_map([source_id], |row| row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?;
                rows.collect::<Result<BTreeSet<_>, _>>()
                    .map_err(|error| error.to_string())?
            };
            let primary_before = primary_location_keys_for_comics(&tx, &comic_ids)?;
            let changed = tx.execute(
                "UPDATE comic_locations SET online=0 WHERE source_id=?1 AND online=1",
                [source_id],
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE comics SET offline = CASE WHEN EXISTS (SELECT 1 FROM comic_locations l WHERE l.comic_id=comics.id AND l.online=1) THEN 0 ELSE 1 END",
                [],
            ).map_err(|error| error.to_string())?;
            let primary_after = primary_location_keys_for_comics(&tx, &comic_ids)?;
            let changed_primary = primary_before
                .iter()
                .filter(|(comic_id, old_key)| primary_after.get(*comic_id) != Some(*old_key))
                .map(|(comic_id, _)| comic_id.clone())
                .collect::<BTreeSet<_>>();
            refresh_fts_batch(&tx, &changed_primary)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(changed)
        })
    }

    /// Reconcile against the committed bookmark list, including prior failed
    /// removals. Each successful source cleanup is durable; a later retry
    /// discovers any remaining locations directly from the catalog.
    pub fn reconcile_external_source_locations(
        &self,
        selected: &BTreeSet<String>,
    ) -> Result<usize, String> {
        let sources = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT DISTINCT source_id FROM comic_locations WHERE source_id LIKE 'external:%'"
            ).map_err(|error| error.to_string())?;
            let sources = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(sources)
        })?;
        sources
            .into_iter()
            .filter(|source| !selected.contains(source))
            .try_fold(0, |removed, source| {
                self.forget_source_locations(&source)
                    .map(|count| removed + count)
            })
    }

    pub fn forget_source_locations(&self, source_id: &str) -> Result<usize, String> {
        self.with_connection(|connection| {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let comic_ids = {
                let mut statement = tx
                    .prepare("SELECT DISTINCT comic_id FROM comic_locations WHERE source_id=?1")
                    .map_err(|error| error.to_string())?;
                let rows = statement
                    .query_map([source_id], |row| row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?
                    .collect::<Result<BTreeSet<_>, _>>()
                    .map_err(|error| error.to_string())?;
                rows
            };
            let removed = tx
                .execute(
                    "DELETE FROM comic_locations WHERE source_id=?1",
                    [source_id],
                )
                .map_err(|error| error.to_string())?;
            for comic_id in &comic_ids {
                tx.execute(
                    "UPDATE comics SET offline = CASE WHEN EXISTS (
                       SELECT 1 FROM comic_locations l WHERE l.comic_id = comics.id AND l.online = 1
                     ) THEN 0 ELSE 1 END WHERE id=?1",
                    [comic_id],
                )
                .map_err(|error| error.to_string())?;
            }
            refresh_fts_batch(&tx, &comic_ids)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(removed)
        })
    }

    pub fn upsert_tag_alias(&self, alias: TagAlias) -> Result<TagAlias, String> {
        let alias = normalize_tag_alias(alias)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO tag_aliases(namespace,alias,normalized_alias,canonical_value,updated_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP) ON CONFLICT(namespace,normalized_alias) DO UPDATE SET alias=excluded.alias,canonical_value=excluded.canonical_value,updated_at=CURRENT_TIMESTAMP",
                params![alias.namespace, alias.alias, normalize_tag_key(&alias.alias), alias.canonical_value],
            ).map_err(|error| error.to_string())?;
            Ok(alias)
        })
    }

    pub fn tag_aliases(&self) -> Result<Vec<TagAlias>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare("SELECT namespace,alias,canonical_value FROM tag_aliases ORDER BY namespace,normalized_alias").map_err(|error| error.to_string())?;
            let aliases = statement.query_map([], |row| Ok(TagAlias { namespace: row.get(0)?, alias: row.get(1)?, canonical_value: row.get(2)? }))
                .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            Ok(aliases)
        })
    }

    pub fn organizer_inbox(&self, limit: usize) -> Result<Vec<OrganizerInboxItem>, String> {
        self.with_connection(|connection| load_organizer_inbox(connection, limit.clamp(1, 1000)))
    }

    pub fn duplicate_candidates(&self, limit: usize) -> Result<Vec<DuplicateCandidate>, String> {
        self.with_connection(|connection| {
            load_duplicate_candidates(connection, limit.clamp(1, 1000))
        })
    }

    pub fn related_tags(
        &self,
        identifier: &str,
        limit: usize,
    ) -> Result<Vec<TagSuggestion>, String> {
        self.with_connection(|connection| {
            let comic_id = resolve_comic_id(connection, identifier)?
                .ok_or_else(|| "找不到漫畫".to_string())?;
            load_related_tags(connection, &comic_id, limit.clamp(1, 50))
        })
    }

    pub fn export_exchange_json(&self) -> Result<String, String> {
        self.with_connection(|connection| {
            let envelope = load_exchange(connection)?;
            serde_json::to_string_pretty(&envelope).map_err(|error| error.to_string())
        })
    }

    pub fn preview_exchange_json(&self, payload: &str) -> Result<CatalogImportPreview, String> {
        let envelope = parse_exchange(payload)?;
        self.with_connection(|connection| preview_exchange(connection, &envelope))
    }

    pub fn apply_exchange(
        &self,
        request: CatalogImportRequest,
    ) -> Result<CatalogImportResult, String> {
        let envelope = parse_exchange(&request.payload)?;
        self.with_connection(|connection| {
            apply_exchange(connection, &envelope, &request.resolutions)
        })
    }
}

fn load_runtime_item_from_statement(
    statement: &mut rusqlite::Statement<'_>,
    identifier: &str,
) -> Result<Option<ComicItem>, String> {
    statement
        .query_row([identifier], comic_item_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn load_runtime_item_from_statement_for_source(
    statement: &mut rusqlite::Statement<'_>,
    identifier: &str,
    source_id: &str,
) -> Result<Option<ComicItem>, String> {
    statement
        .query_row(params![identifier, source_id], comic_item_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn comic_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ComicItem> {
    let runtime_id = row.get::<_, String>(0)?;
    let title = row.get::<_, String>(1)?;
    let series = row.get::<_, Option<String>>(2)?;
    let online = row.get::<_, i64>(3)? != 0;
    let updated_at = row.get::<_, String>(4)?;
    let relative_path = row.get::<_, String>(5)?;
    let actual_path = row.get::<_, Option<String>>(6)?;
    let kind = row.get::<_, String>(7)?;
    let source_id = row.get::<_, String>(8)?;
    let current_page = row.get::<_, Option<i64>>(9)?.unwrap_or_default();
    let total_pages = row.get::<_, Option<i64>>(10)?.unwrap_or_default();
    let percent = row.get::<_, Option<f64>>(11)?.unwrap_or_default();
    let progress_updated_at = row.get::<_, Option<String>>(12)?;
    let ext = actual_path
        .as_deref()
        .and_then(|path| Path::new(path).extension())
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let item_type = runtime_type_for_location(online, &kind, &source_id);
    Ok(ComicItem {
        id: runtime_id,
        r#type: item_type,
        relative_path,
        ext,
        title,
        series: series.unwrap_or_else(|| "未分類".into()),
        updated_at,
        page_count: 0,
        progress: crate::state::Progress {
            current_page: current_page.max(0) as usize,
            total_pages: total_pages.max(0) as usize,
            percent,
            updated_at: progress_updated_at,
        },
        source_id,
        source_path: actual_path,
        external_bookmark: None,
    })
}

const MIGRATION_1: &str = "
        CREATE TABLE IF NOT EXISTS comics(
          id TEXT PRIMARY KEY, title TEXT NOT NULL, series TEXT, volume TEXT, number TEXT, summary TEXT,
          language TEXT, reading_direction TEXT, published_at TEXT, offline INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS comic_locations(
          id INTEGER PRIMARY KEY, comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
          runtime_id TEXT, source_id TEXT NOT NULL, relative_path TEXT NOT NULL, actual_path TEXT, kind TEXT NOT NULL,
          size INTEGER, mtime TEXT, fingerprint TEXT, fingerprint_version TEXT, online INTEGER NOT NULL DEFAULT 1,
          last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(source_id, relative_path)
        );
        CREATE INDEX IF NOT EXISTS idx_locations_runtime ON comic_locations(runtime_id);
        CREATE INDEX IF NOT EXISTS idx_locations_fingerprint ON comic_locations(fingerprint, fingerprint_version);
        CREATE TABLE IF NOT EXISTS metadata_sources(
          id INTEGER PRIMARY KEY, comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
          parser_id TEXT NOT NULL, parser_version TEXT NOT NULL, source_path TEXT NOT NULL, source_digest TEXT NOT NULL,
          confidence REAL NOT NULL, raw_json TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(comic_id, parser_id, source_path)
        );
        CREATE TABLE IF NOT EXISTS metadata_candidates(
          id INTEGER PRIMARY KEY, comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
          source_id INTEGER NOT NULL REFERENCES metadata_sources(id) ON DELETE CASCADE,
          field_key TEXT NOT NULL, value_json TEXT NOT NULL, priority INTEGER NOT NULL, confidence REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_candidates_effective ON metadata_candidates(comic_id, field_key, priority DESC);
        CREATE TABLE IF NOT EXISTS user_field_overrides(
          comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE, field_key TEXT NOT NULL,
          value_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(comic_id, field_key)
        );
        CREATE TABLE IF NOT EXISTS tags(
          id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL,
          UNIQUE(namespace, normalized_value)
        );
        CREATE TABLE IF NOT EXISTS comic_tag_candidates(
          comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          source_id INTEGER NOT NULL REFERENCES metadata_sources(id) ON DELETE CASCADE, PRIMARY KEY(comic_id, tag_id, source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_tag_candidates_tag ON comic_tag_candidates(tag_id,comic_id);
        CREATE TABLE IF NOT EXISTS comic_tag_overrides(
          comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK(action IN ('include','exclude')), PRIMARY KEY(comic_id, tag_id)
        );
        CREATE TABLE IF NOT EXISTS folder_tag_rules(
          id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, folder_path TEXT NOT NULL, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source_id, folder_path, tag_id)
        );
        CREATE TABLE IF NOT EXISTS import_diagnostics(
          id INTEGER PRIMARY KEY, comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE, parser_id TEXT,
          source_path TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS batch_operations(token TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(comic_id UNINDEXED, title, series, path, creators, tags, language, tokenize='unicode61');";

const MIGRATION_2: &str = "
        CREATE TABLE IF NOT EXISTS tag_aliases(
          id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL,
          canonical_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(namespace, normalized_alias)
        );";

const MIGRATION_3: &str = "
        CREATE TABLE IF NOT EXISTS reading_progress(
          comic_id TEXT PRIMARY KEY REFERENCES comics(id) ON DELETE CASCADE,
          current_page INTEGER NOT NULL DEFAULT 0,
          total_pages INTEGER NOT NULL DEFAULT 0,
          percent REAL NOT NULL DEFAULT 0,
          updated_at TEXT
        );";

const MIGRATION_4: &str = "
        CREATE TABLE IF NOT EXISTS canonical_tags(
          id INTEGER PRIMARY KEY,
          namespace TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          display_value TEXT NOT NULL,
          disabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(namespace, normalized_value)
        );
        CREATE TABLE IF NOT EXISTS tag_redirects(
          source_tag_id INTEGER PRIMARY KEY REFERENCES canonical_tags(id) ON DELETE CASCADE,
          target_tag_id INTEGER NOT NULL REFERENCES canonical_tags(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK(source_tag_id <> target_tag_id)
        );
        CREATE TABLE IF NOT EXISTS tag_user_state(
          tag_id INTEGER PRIMARY KEY REFERENCES canonical_tags(id) ON DELETE CASCADE,
          pinned INTEGER NOT NULL DEFAULT 0,
          usage_count INTEGER NOT NULL DEFAULT 0,
          last_used_at TEXT,
          color_key TEXT,
          CHECK(color_key IS NULL OR color_key IN ('rose','amber','lime','cyan','blue','violet','fuchsia','slate','none'))
        );
        ALTER TABLE tags ADD COLUMN canonical_tag_id INTEGER REFERENCES canonical_tags(id);
        CREATE INDEX IF NOT EXISTS idx_tags_canonical ON tags(canonical_tag_id);";

const MIGRATION_5: &str = "
        CREATE TABLE IF NOT EXISTS tag_operations(
          token TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );";

const MIGRATION_6: &str = "
        CREATE TABLE IF NOT EXISTS file_operations(
          id TEXT PRIMARY KEY,
          undo_token TEXT NOT NULL UNIQUE,
          comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
          location_id INTEGER NOT NULL REFERENCES comic_locations(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK(action IN ('rename','move','trash')),
          source_id TEXT NOT NULL,
          before_relative_path TEXT NOT NULL,
          before_actual_path TEXT,
          after_relative_path TEXT,
          after_actual_path TEXT,
          expected_fingerprint TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','undone','needs_reconcile')),
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at TEXT,
          undone_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_file_operations_comic ON file_operations(comic_id,created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_file_operations_status ON file_operations(status);";

// Online reconciliation and location lookups run per comic. Without this
// index the final EXISTS query scans the entire location table per book.
const MIGRATION_7: &str = "
        CREATE INDEX IF NOT EXISTS idx_locations_comic_online ON comic_locations(comic_id, online);
";

// unicode61 indexes an entire run of CJK characters as one token, so a query
// for a substring such as "漫畫" cannot match "測試漫畫".  FTS5's trigram
// tokenizer keeps substring search while preserving the existing catalog_fts
// columns.  The index is repopulated after this migration because the FTS
// table is intentionally contentless from the catalog tables' perspective.
const MIGRATION_8: &str = "
        DROP TABLE IF EXISTS catalog_fts;
        CREATE VIRTUAL TABLE catalog_fts USING fts5(comic_id UNINDEXED, title, series, path, creators, tags, language, tokenize='trigram');
";

// build_view loads the most recent diagnostics for each comic while rebuilding
// the FTS table. Keep both the per-comic filter and its descending id order in
// the index so a large catalog does not rescan or sort all diagnostics per row.
const MIGRATION_9: &str = "
        CREATE INDEX IF NOT EXISTS idx_import_diagnostics_comic_id
          ON import_diagnostics(comic_id, id DESC);
";

// A leading-wildcard LIKE cannot use a normal SQLite index. Keep one- and
// two-codepoint grams in an equality-searchable side index for short queries;
// the existing ParsedQuery matcher still performs the final field-aware check.
const MIGRATION_10: &str = "
        CREATE TABLE IF NOT EXISTS catalog_short_ngrams(
          comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
          gram TEXT NOT NULL,
          PRIMARY KEY(comic_id, gram)
        );
        CREATE INDEX IF NOT EXISTS idx_catalog_short_ngrams_gram
          ON catalog_short_ngrams(gram, comic_id);
";

const MIGRATION_11: &str = "
        CREATE TABLE IF NOT EXISTS progress_intent_fences(
          comic_id TEXT PRIMARY KEY REFERENCES comics(id) ON DELETE CASCADE,
          intent_sequence INTEGER NOT NULL CHECK(intent_sequence >= 0)
        );
        CREATE TABLE IF NOT EXISTS progress_recovery_proofs(
          token TEXT PRIMARY KEY,
          comic_id TEXT NOT NULL REFERENCES comics(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          total_pages INTEGER NOT NULL CHECK(total_pages > 0),
          revision_json TEXT NOT NULL,
          smb_content_hash BLOB,
          baseline_page INTEGER NOT NULL,
          baseline_total INTEGER NOT NULL,
          baseline_updated_at TEXT,
          intent_sequence INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_progress_recovery_proofs_comic
          ON progress_recovery_proofs(comic_id, created_at DESC);
";

const MIGRATION_12: &str = "
        CREATE TABLE IF NOT EXISTS reading_history(
          session_key TEXT PRIMARY KEY,
          comic_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          opened_at TEXT NOT NULL,
          title TEXT NOT NULL,
          page_count INTEGER NOT NULL CHECK(page_count > 0),
          offline INTEGER NOT NULL DEFAULT 0,
          progress_page INTEGER NOT NULL DEFAULT 0,
          progress_total INTEGER NOT NULL DEFAULT 0,
          progress_percent REAL NOT NULL DEFAULT 0,
          progress_updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reading_history_opened_at
          ON reading_history(opened_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reading_history_group
          ON reading_history(source_id, relative_path, opened_at DESC);
";

const MIGRATIONS: &[(i64, &str)] = &[
    (1, MIGRATION_1),
    (2, MIGRATION_2),
    (3, MIGRATION_3),
    (4, MIGRATION_4),
    (5, MIGRATION_5),
    (6, MIGRATION_6),
    (7, MIGRATION_7),
    (8, MIGRATION_8),
    (9, MIGRATION_9),
    (10, MIGRATION_10),
    (11, MIGRATION_11),
    (12, MIGRATION_12),
];

fn local_operation_path_matches_fingerprint(
    operation: &FileOperationRecord,
    relative_path: &str,
) -> bool {
    let Some(expected) = operation.expected_fingerprint.as_deref() else {
        return false;
    };
    let Some(root_encoded) = operation.source_id.strip_prefix("local:") else {
        return false;
    };
    let Ok(root_bytes) = general_purpose::URL_SAFE_NO_PAD.decode(root_encoded) else {
        return false;
    };
    let Ok(configured_root) = String::from_utf8(root_bytes) else {
        return false;
    };
    let configured_root = PathBuf::from(configured_root);
    let Some(root_name) = configured_root.file_name() else {
        return false;
    };
    let root_parent = configured_root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let Ok(root_parent) = root_parent.canonicalize() else {
        return false;
    };
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return false;
    }

    let Ok(parent_dir) =
        cap_std::fs::Dir::open_ambient_dir(root_parent, cap_std::ambient_authority())
    else {
        return false;
    };
    let Ok(root_dir) = parent_dir.open_dir_nofollow(root_name) else {
        return false;
    };
    let mut current = root_dir;
    let Some(name) = relative.file_name() else {
        return false;
    };
    let name = Path::new(name);
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            let Component::Normal(component) = component else {
                return false;
            };
            let Ok(next) = current.open_dir_nofollow(component) else {
                return false;
            };
            current = next;
        }
    }
    let Ok(metadata) = current.symlink_metadata(name) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }

    if expected.starts_with("location-revision-v1:") {
        let Some((size, mtime)) = file_signature_from_dir(&current, name) else {
            return false;
        };
        location_revision(
            &operation.source_id,
            &operation.before_relative_path,
            size,
            mtime.as_deref(),
        )
        .is_some_and(|fingerprint| fingerprint == expected)
    } else {
        sampled_fingerprint_from_dir(&current, name)
            .is_ok_and(|fingerprint| fingerprint == expected)
    }
}

fn load_file_operation(
    connection: &Connection,
    identifier: &str,
    by_undo_token: bool,
) -> Result<FileOperationRecord, String> {
    let predicate = if by_undo_token {
        "undo_token=?1"
    } else {
        "id=?1"
    };
    connection.query_row(
        &format!("SELECT id,undo_token,comic_id,location_id,action,source_id,before_relative_path,before_actual_path,after_relative_path,after_actual_path,expected_fingerprint,status,COALESCE(error_message='undo_pending',0) FROM file_operations WHERE {predicate}"),
        [identifier],
        |row| Ok(FileOperationRecord {
            id: row.get(0)?, undo_token: row.get(1)?, comic_id: row.get(2)?, location_id: row.get(3)?,
            action: row.get(4)?, source_id: row.get(5)?, before_relative_path: row.get(6)?, before_actual_path: row.get(7)?,
                after_relative_path: row.get(8)?, after_actual_path: row.get(9)?, expected_fingerprint: row.get(10)?, status: row.get(11)?, undo_pending: row.get(12)?,
        }),
    ).map_err(|error| error.to_string())
}

fn migrate(connection: &mut Connection, check_fts: bool) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations(
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("無法建立 migration ledger：{error}"))?;

    let applied = {
        let mut statement = connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .map_err(|error| format!("無法讀取 migration ledger：{error}"))?;
        let versions = statement
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|error| format!("無法查詢 migration ledger：{error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("無法解析 migration ledger：{error}"))?;
        versions
    };

    let latest = MIGRATIONS.last().map_or(0, |(version, _)| *version);
    if let Some(version) = applied.iter().copied().find(|version| *version > latest) {
        return Err(format!(
            "漫畫目錄資料庫版本 {version} 比此 App 支援的 {latest} 新，已停止以避免損壞資料"
        ));
    }
    for (index, version) in applied.iter().copied().enumerate() {
        let expected = index as i64 + 1;
        if version != expected {
            return Err(format!(
                "migration ledger 不連續：預期版本 {expected}，實際為 {version}"
            ));
        }
    }

    let mut fts_rebuild_required = false;
    for (version, sql) in MIGRATIONS
        .iter()
        .filter(|(version, _)| !applied.contains(version))
    {
        let tx = connection
            .transaction()
            .map_err(|error| format!("無法開始 SQLite migration {version}：{error}"))?;
        tx.execute_batch(sql)
            .map_err(|error| format!("SQLite migration {version} 失敗：{error}"))?;
        tx.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES(?1, CURRENT_TIMESTAMP)",
            [version],
        )
        .map_err(|error| format!("無法記錄 SQLite migration {version}：{error}"))?;
        tx.pragma_update(None, "user_version", version)
            .map_err(|error| format!("無法更新 SQLite user_version {version}：{error}"))?;
        tx.commit()
            .map_err(|error| format!("無法提交 SQLite migration {version}：{error}"))?;
        if *version == 8 || *version == 10 {
            fts_rebuild_required = true;
        }
    }
    backfill_canonical_tags(connection)?;
    if fts_rebuild_required || (check_fts && catalog_fts_needs_rebuild(connection)?) {
        rebuild_catalog_fts(connection)?;
    }
    Ok(())
}

fn catalog_fts_needs_rebuild(connection: &Connection) -> Result<bool, String> {
    let comic_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM comics", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let fts_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM catalog_fts", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let short_gram_missing: i64 = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM comics c
               WHERE NOT EXISTS(
                 SELECT 1 FROM catalog_short_ngrams grams
                 WHERE grams.comic_id=c.id
               )
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(comic_count != fts_count || short_gram_missing != 0)
}

fn normalize_tag_key(value: &str) -> String {
    value.nfkc().collect::<String>().trim().to_lowercase()
}

fn backfill_canonical_tags(connection: &mut Connection) -> Result<(), String> {
    let missing: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM tags WHERE canonical_tag_id IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("無法檢查 canonical tags：{error}"))?;
    if missing == 0 {
        return Ok(());
    }
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT id,namespace,value FROM tags WHERE canonical_tag_id IS NULL ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for (raw_id, namespace, display_value) in rows {
        let namespace = normalize_tag_key(&namespace);
        let normalized = normalize_tag_key(&display_value);
        tx.execute(
            "INSERT OR IGNORE INTO canonical_tags(namespace,normalized_value,display_value) VALUES(?1,?2,?3)",
            params![namespace, normalized, display_value],
        )
        .map_err(|error| error.to_string())?;
        let canonical_id: i64 = tx
            .query_row(
                "SELECT id FROM canonical_tags WHERE namespace=?1 AND normalized_value=?2",
                params![namespace, normalized],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE tags SET canonical_tag_id=?2 WHERE id=?1",
            params![raw_id, canonical_id],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn load_location_signatures(
    connection: &mut Connection,
    source_ids: &BTreeSet<String>,
) -> Result<HashMap<(String, String), LocationSignature>, String> {
    if source_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (1..=source_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT source_id,relative_path,size,mtime,fingerprint,fingerprint_version \
         FROM comic_locations WHERE source_id IN ({placeholders})"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(source_ids.iter()), |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                LocationSignature {
                    size: row.get(2)?,
                    mtime: row.get(3)?,
                    fingerprint: row.get(4)?,
                    fingerprint_version: row.get(5)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn file_signature(path: &Path) -> Option<(Option<i64>, Option<String>)> {
    let metadata = std::fs::metadata(path).ok()?;
    let mut components = vec![format!(
        "root|{}|{}",
        metadata.len(),
        modified_stamp(&metadata)?
    )];
    if metadata.is_dir() {
        let mut entries = std::fs::read_dir(path)
            .ok()?
            .map(|entry| {
                let entry = entry.ok()?;
                let entry_path = entry.path();
                let entry_name = entry.file_name();
                let entry_name_text = entry_name.to_string_lossy();
                if !is_folder_signature_artifact(&entry_name_text) && !is_image(&entry_path) {
                    return Some(None);
                }
                let child_metadata = entry.metadata().ok()?;
                let kind = if child_metadata.is_dir() {
                    "dir"
                } else if child_metadata.is_file() {
                    "file"
                } else {
                    "other"
                };
                Some(Some(format!(
                    "child|{}|{}|{}|{}",
                    entry_name_text,
                    kind,
                    child_metadata.len(),
                    modified_stamp(&child_metadata)?
                )))
            })
            .collect::<Option<Vec<Option<_>>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        entries.sort();
        components.extend(entries);
    } else {
        for sidecar in metadata_sidecar_paths(path) {
            let component = match std::fs::metadata(&sidecar) {
                Ok(sidecar_metadata) if sidecar_metadata.is_file() => format!(
                    "sidecar|{}|file|{}|{}",
                    sidecar.file_name()?.to_string_lossy(),
                    sidecar_metadata.len(),
                    modified_stamp(&sidecar_metadata)?
                ),
                Ok(_) => format!(
                    "sidecar|{}|non-file",
                    sidecar.file_name()?.to_string_lossy()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    format!("sidecar|{}|missing", sidecar.file_name()?.to_string_lossy())
                }
                Err(_) => return None,
            };
            components.push(component);
        }
    }
    let root = components.remove(0);
    components.sort();
    components.insert(0, root);
    let mut hasher = blake3::Hasher::new();
    hasher.update(FILE_SIGNATURE_VERSION.as_bytes());
    for component in components {
        hasher.update(component.as_bytes());
        hasher.update(&[0]);
    }
    Some((
        Some(metadata.len() as i64),
        Some(format!(
            "{FILE_SIGNATURE_VERSION}:{}",
            hasher.finalize().to_hex()
        )),
    ))
}

pub(crate) fn file_signature_from_dir(
    parent: &cap_std::fs::Dir,
    name: &Path,
) -> Option<(Option<i64>, Option<String>)> {
    let metadata = parent.symlink_metadata(name).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    let mut components = vec![format!(
        "root|{}|{}",
        metadata.len(),
        modified_stamp_cap(&metadata)?
    )];
    if metadata.is_dir() {
        let child_dir = parent.open_dir_nofollow(name).ok()?;
        let mut entries = child_dir
            .entries()
            .ok()?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let entry_name = entry.file_name();
                let entry_name_text = entry_name.to_string_lossy();
                if !is_folder_signature_artifact(&entry_name_text)
                    && !is_image(Path::new(&entry_name))
                {
                    return Some(None);
                }
                let child_metadata = entry.metadata().ok()?;
                let kind = if child_metadata.is_dir() {
                    "dir"
                } else if child_metadata.is_file() {
                    "file"
                } else {
                    "other"
                };
                Some(Some(format!(
                    "child|{}|{}|{}|{}",
                    entry_name_text,
                    kind,
                    child_metadata.len(),
                    modified_stamp_cap(&child_metadata)?
                )))
            })
            .flatten()
            .collect::<Vec<_>>();
        entries.sort();
        components.extend(entries);
    } else {
        for sidecar in metadata_sidecar_paths(name) {
            let component = match parent.metadata(&sidecar) {
                Ok(sidecar_metadata) if sidecar_metadata.is_file() => format!(
                    "sidecar|{}|file|{}|{}",
                    sidecar.file_name()?.to_string_lossy(),
                    sidecar_metadata.len(),
                    modified_stamp_cap(&sidecar_metadata)?
                ),
                Ok(_) => format!(
                    "sidecar|{}|non-file",
                    sidecar.file_name()?.to_string_lossy()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    format!("sidecar|{}|missing", sidecar.file_name()?.to_string_lossy())
                }
                Err(_) => return None,
            };
            components.push(component);
        }
    }
    let root = components.remove(0);
    components.sort();
    components.insert(0, root);
    let mut hasher = blake3::Hasher::new();
    hasher.update(FILE_SIGNATURE_VERSION.as_bytes());
    for component in components {
        hasher.update(component.as_bytes());
        hasher.update(&[0]);
    }
    Some((
        Some(metadata.len() as i64),
        Some(format!(
            "{FILE_SIGNATURE_VERSION}:{}",
            hasher.finalize().to_hex()
        )),
    ))
}

fn modified_stamp(metadata: &std::fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
}

fn modified_stamp_cap(metadata: &cap_std::fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time.into_std()).to_rfc3339())
}

fn metadata_sidecar_paths(path: &Path) -> Vec<std::path::PathBuf> {
    let mut paths = BTreeSet::new();
    paths.insert(path.with_extension("json"));
    if let Some(name) = path.file_name() {
        paths.insert(path.with_file_name(format!("{}.json", name.to_string_lossy())));
    }
    paths.into_iter().collect()
}

fn is_folder_signature_artifact(name: &str) -> bool {
    matches!(
        name.trim_matches('/').to_ascii_lowercase().as_str(),
        "comicinfo.xml" | "info.json" | "info.txt" | "galleryinfo.txt"
    )
}

fn ensure_sync_current<C>(is_current: &C) -> Result<(), String>
where
    C: Fn() -> bool + Sync,
{
    if is_current() {
        Ok(())
    } else {
        Err("目錄同步已取消：目前掃描世代已不是最新世代".into())
    }
}

fn retire_unseen_sources(
    tx: &Transaction<'_>,
    source_ids: &BTreeSet<String>,
    current_locations: &[(String, String)],
) -> Result<BTreeSet<String>, String> {
    let mut candidate_comics = BTreeSet::new();
    if source_ids
        .iter()
        .any(|source_id| source_id == "local" || source_id.starts_with("local:"))
    {
        {
            let mut statement = tx
                .prepare(
                    "SELECT DISTINCT comic_id FROM comic_locations
                     WHERE online=1 AND (source_id='local' OR source_id LIKE 'local:%')",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            candidate_comics.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?,
            );
        }
    }
    for source_id in source_ids
        .iter()
        .filter(|source_id| *source_id != "local" && !source_id.starts_with("local:"))
    {
        {
            let mut statement = tx
                .prepare(
                    "SELECT DISTINCT comic_id FROM comic_locations
                     WHERE source_id=?1 AND online=1",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([source_id], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            candidate_comics.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?,
            );
        }
    }
    let primary_before = primary_location_keys_for_comics(tx, &candidate_comics)?;
    if source_ids
        .iter()
        .any(|source_id| source_id == "local" || source_id.starts_with("local:"))
    {
        tx.execute(
            "UPDATE comic_locations SET online = 0 WHERE source_id = 'local' OR source_id LIKE 'local:%'",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    for source_id in source_ids
        .iter()
        .filter(|source_id| *source_id != "local" && !source_id.starts_with("local:"))
    {
        tx.execute(
            "UPDATE comic_locations SET online = 0 WHERE source_id = ?1",
            [source_id],
        )
        .map_err(|error| error.to_string())?;
    }
    // Locations were upserted in earlier batches. Restore online only for entries
    // present in this complete scan, so a remounted local root keeps its stable IDs
    // while paths omitted from the scan become offline at the very end.
    for (source_id, relative_path) in current_locations {
        tx.execute(
            "UPDATE comic_locations SET online = 1 WHERE source_id = ?1 AND relative_path = ?2",
            params![source_id, relative_path],
        )
        .map_err(|error| error.to_string())?;
    }
    let primary_after = primary_location_keys_for_comics(tx, &candidate_comics)?;
    Ok(primary_before
        .iter()
        .filter(|(comic_id, old_key)| primary_after.get(*comic_id) != Some(*old_key))
        .map(|(comic_id, _)| comic_id.clone())
        .collect())
}

/// A metadata revision token is deliberately not called a content hash: it only
/// proves that the registered location's size and modification time are the same.
pub(crate) fn location_revision(
    source_id: &str,
    relative_path: &str,
    size: Option<i64>,
    mtime: Option<&str>,
) -> Option<String> {
    let (Some(size), Some(mtime)) = (size, mtime) else {
        return None;
    };
    Some(format!(
        "location-revision-v1:{}",
        serde_json::json!({
            "source": source_id,
            "path": relative_path,
            "size": size,
            "mtime": mtime,
        })
    ))
}

fn import_runtime_progress(
    tx: &Transaction<'_>,
    comic_id: &str,
    progress: &crate::state::Progress,
) -> Result<(), String> {
    let Some(updated_at) = progress.updated_at.as_deref() else {
        return Ok(());
    };
    let Ok(incoming) = chrono::DateTime::parse_from_rfc3339(updated_at) else {
        // A damaged legacy sidecar must not abort the remaining catalog import.
        return Ok(());
    };
    let incoming = incoming.with_timezone(&chrono::Utc);
    let normalized_incoming = incoming.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let existing: Option<String> = tx
        .query_row(
            "SELECT updated_at FROM reading_progress WHERE comic_id=?1",
            [comic_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(existing) = existing {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&existing) {
            let parsed = parsed.with_timezone(&chrono::Utc);
            let normalized_existing = parsed.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            if normalized_existing != existing {
                tx.execute(
                    "UPDATE reading_progress SET updated_at=?2 WHERE comic_id=?1",
                    params![comic_id, normalized_existing],
                )
                .map_err(|error| error.to_string())?;
            }
            if incoming < parsed {
                return Ok(());
            }
        }
    }
    tx.execute(
        "INSERT INTO reading_progress(comic_id,current_page,total_pages,percent,updated_at)
         VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(comic_id) DO UPDATE SET
           current_page=excluded.current_page,total_pages=excluded.total_pages,
           percent=excluded.percent,updated_at=excluded.updated_at
         ",
        params![
            comic_id,
            progress.current_page as i64,
            progress.total_pages as i64,
            progress.percent,
            normalized_incoming
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_location(
    tx: &Transaction<'_>,
    comic: &ComicItem,
    signature: Option<(Option<i64>, Option<String>)>,
    fingerprint: Option<&str>,
    fingerprint_version: Option<&str>,
) -> Result<(String, bool), String> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT comic_id FROM comic_locations WHERE source_id = ?1 AND relative_path = ?2",
            params![comic.source_id, comic.relative_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    #[cfg(test)]
    tests::run_sync_batch_read_hook();
    let mut fingerprint_collision = false;
    let comic_id = if let Some(id) = existing {
        id
    } else if let Some(fingerprint) = fingerprint {
        let mut statement = tx.prepare("SELECT DISTINCT comic_id FROM comic_locations WHERE fingerprint = ?1 AND fingerprint_version = ?2").map_err(|error| error.to_string())?;
        let matches = statement
            .query_map(params![fingerprint, FINGERPRINT_VERSION], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if matches.len() == 1 {
            matches[0].clone()
        } else {
            fingerprint_collision = matches.len() > 1;
            uuid::Uuid::new_v4().to_string()
        }
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    tx.execute(
        "INSERT OR IGNORE INTO comics(id, title, series) VALUES(?1, ?2, ?3)",
        params![comic_id, comic.title, comic.series],
    )
    .map_err(|error| error.to_string())?;
    let (size, mtime) = signature.unwrap_or((None, None));
    tx.execute(
        "INSERT INTO comic_locations(comic_id, runtime_id, source_id, relative_path, actual_path, kind, size, mtime, fingerprint, fingerprint_version, online, last_seen_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, CURRENT_TIMESTAMP)
         ON CONFLICT(source_id, relative_path) DO UPDATE SET comic_id=excluded.comic_id, runtime_id=excluded.runtime_id, actual_path=excluded.actual_path,
         kind=excluded.kind, size=COALESCE(excluded.size, comic_locations.size), mtime=COALESCE(excluded.mtime, comic_locations.mtime), fingerprint=COALESCE(excluded.fingerprint, comic_locations.fingerprint),
         fingerprint_version=COALESCE(excluded.fingerprint_version, comic_locations.fingerprint_version), online=1, last_seen_at=CURRENT_TIMESTAMP",
        params![comic_id, comic.id, comic.source_id, comic.relative_path, comic.source_path, comic.r#type, size, mtime, fingerprint, fingerprint_version],
    ).map_err(|error| error.to_string())?;
    Ok((comic_id, fingerprint_collision))
}

fn replace_imports(
    tx: &Transaction<'_>,
    comic_id: &str,
    location_path: &str,
    sources: Vec<ParsedMetadataSource>,
    diagnostics: Vec<ParserDiagnostic>,
    failures: Vec<metadata::ParseFailure>,
) -> Result<(), String> {
    let existing_sources = {
        let mut statement = tx
            .prepare(
                "SELECT id,source_path FROM metadata_sources WHERE comic_id = ?1 AND parser_id NOT LIKE 'ai:%'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([comic_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (source_id, source_path) in existing_sources {
        if source_path_matches_location(&source_path, location_path)
            && !source_path_matches_failure(&source_path, &failures)
        {
            tx.execute("DELETE FROM metadata_sources WHERE id = ?1", [source_id])
                .map_err(|error| error.to_string())?;
        }
    }
    let existing_diagnostics = {
        let mut statement = tx
            .prepare("SELECT id,source_path FROM import_diagnostics WHERE comic_id = ?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([comic_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (diagnostic_id, source_path) in existing_diagnostics {
        if source_path_matches_location(&source_path, location_path) {
            tx.execute(
                "DELETE FROM import_diagnostics WHERE id = ?1",
                [diagnostic_id],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    for source in sources {
        tx.execute(
            "INSERT INTO metadata_sources(comic_id, parser_id, parser_version, source_path, source_digest, confidence, raw_json) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![comic_id, source.parser_id, source.parser_version, source.source_path, source.source_digest, source.confidence, source.raw_json.to_string()],
        ).map_err(|error| error.to_string())?;
        let source_id = tx.last_insert_rowid();
        for (field, value) in metadata_fields(&source.metadata) {
            tx.execute("INSERT INTO metadata_candidates(comic_id, source_id, field_key, value_json, priority, confidence) VALUES(?1, ?2, ?3, ?4, ?5, ?6)", params![comic_id, source_id, field, value.to_string(), source.priority, source.confidence]).map_err(|error| error.to_string())?;
        }
        for tag in &source.metadata.tags {
            let tag_id = ensure_tag_tx(tx, tag)?;
            tx.execute("INSERT OR IGNORE INTO comic_tag_candidates(comic_id, tag_id, source_id) VALUES(?1, ?2, ?3)", params![comic_id, tag_id, source_id]).map_err(|error| error.to_string())?;
        }
    }
    for diagnostic in diagnostics {
        tx.execute("INSERT INTO import_diagnostics(comic_id, parser_id, source_path, severity, message) VALUES(?1, ?2, ?3, ?4, ?5)", params![comic_id, diagnostic.parser_id, diagnostic.source_path, diagnostic.severity, diagnostic.message]).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn source_path_matches_failure(path: &str, failures: &[metadata::ParseFailure]) -> bool {
    failures.iter().any(|failure| match failure {
        metadata::ParseFailure::Artifact { source_path } => path == source_path,
        metadata::ParseFailure::Scope { source_prefix } => path.starts_with(source_prefix),
    })
}

fn source_path_matches_location(source_path: &str, location_path: &str) -> bool {
    if source_path == location_path {
        return true;
    }

    let location = Path::new(location_path);
    if location.is_dir() {
        let trimmed = location_path.trim_end_matches(['/', '\\']);
        return source_path.starts_with(&format!("{trimmed}/"))
            || source_path.starts_with(&format!("{trimmed}\\"));
    }

    if is_archive_location(location_path)
        && source_path.starts_with(&format!(
            "{}::",
            location_path.trim_end_matches(['/', '\\'])
        ))
    {
        return true;
    }

    [
        Some(location.with_extension("json")),
        location
            .file_name()
            .map(|name| location.with_file_name(format!("{}.json", name.to_string_lossy()))),
    ]
    .into_iter()
    .flatten()
    .any(|sibling| sibling.to_string_lossy() == source_path)
}

fn is_archive_location(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|item| item.to_str())
        .is_some_and(|item| matches!(item.to_ascii_lowercase().as_str(), "zip" | "cbz"))
}

fn metadata_fields(metadata: &NormalizedMetadata) -> Vec<(&'static str, Value)> {
    let mut fields = Vec::new();
    for (field, value) in [
        ("title", metadata.title.as_ref()),
        ("series", metadata.series.as_ref()),
        ("volume", metadata.volume.as_ref()),
        ("number", metadata.number.as_ref()),
        ("summary", metadata.summary.as_ref()),
        ("language", metadata.language.as_ref()),
        ("reading_direction", metadata.reading_direction.as_ref()),
        ("published_at", metadata.published_at.as_ref()),
    ] {
        if let Some(value) = value {
            fields.push((field, json!(value)));
        }
    }
    if !metadata.creators.is_empty() {
        fields.push(("creators", json!(metadata.creators)));
    }
    fields
}

fn resolve_effective_metadata(tx: &Transaction<'_>, comic_id: &str) -> Result<(), String> {
    let mut values = HashMap::new();
    for field in [
        "title",
        "series",
        "volume",
        "number",
        "summary",
        "language",
        "reading_direction",
        "published_at",
    ] {
        let override_value: Option<String> = tx.query_row("SELECT value_json FROM user_field_overrides WHERE comic_id = ?1 AND field_key = ?2", params![comic_id, field], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        let candidate: Option<String> = tx.query_row("SELECT mc.value_json FROM metadata_candidates mc JOIN metadata_sources ms ON ms.id=mc.source_id WHERE mc.comic_id = ?1 AND mc.field_key = ?2 AND ms.parser_id NOT LIKE 'ai:%' ORDER BY mc.priority DESC, mc.confidence DESC, mc.id ASC LIMIT 1", params![comic_id, field], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
        let value = override_value.or(candidate).and_then(|item| {
            serde_json::from_str::<Option<String>>(&item)
                .ok()
                .flatten()
                .or_else(|| serde_json::from_str::<String>(&item).ok())
        });
        values.insert(field, value);
    }
    let title = values
        .remove("title")
        .flatten()
        .unwrap_or_else(|| "未命名漫畫".into());
    tx.execute(
        "UPDATE comics SET title=?2, series=?3, volume=?4, number=?5, summary=?6, language=?7, reading_direction=?8, published_at=?9, updated_at=CURRENT_TIMESTAMP WHERE id=?1",
        params![comic_id, title, values.remove("series").flatten(), values.remove("volume").flatten(), values.remove("number").flatten(), values.remove("summary").flatten(), values.remove("language").flatten(), values.remove("reading_direction").flatten(), values.remove("published_at").flatten()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn build_search_view(connection: &Connection, comic_id: &str) -> Result<ComicMetadataView, String> {
    let visible_location = visible_location_predicate("l");
    let primary_order = primary_location_order("l");
    let mut view = connection.query_row(
        &format!(
            "SELECT c.id,c.title,c.series,c.volume,c.number,c.summary,c.language,c.reading_direction,c.published_at,c.offline,
              l.runtime_id,l.relative_path,l.source_id FROM comics c
              LEFT JOIN comic_locations l ON l.comic_id=c.id AND {visible_location}
              WHERE c.id=?1 ORDER BY {primary_order} LIMIT 1"
        ),
        [comic_id],
        |row| Ok(ComicMetadataView {
            comic_id: row.get(0)?, title: row.get(1)?, series: row.get(2)?, volume: row.get(3)?, number: row.get(4)?, summary: row.get(5)?,
            language: row.get(6)?, reading_direction: row.get(7)?, published_at: row.get(8)?, offline: row.get::<_, i64>(9)? != 0,
            runtime_id: row.get(10)?, relative_path: row.get(11)?, source_id: row.get(12)?, creators: BTreeMap::new(), tags: vec![], candidates: vec![], locked_fields: vec![], diagnostics: vec![],
            locations: Vec::new(),
        }),
    ).map_err(|error| error.to_string())?;
    view.creators = effective_creators(connection, comic_id)?;
    view.tags = effective_tags(connection, comic_id)?;
    Ok(view)
}

fn build_search_views_batch(
    connection: &Connection,
) -> Result<HashMap<String, ComicMetadataView>, String> {
    let mut views = HashMap::new();
    let primary_order = primary_location_order("l");
    let mut statement = connection
        .prepare(&format!(
            "WITH ranked_locations AS (
               SELECT l.*,
                      ROW_NUMBER() OVER (
                        PARTITION BY l.comic_id
                        ORDER BY {primary_order}
                      ) AS location_rank
               FROM comic_locations l
               WHERE {visible_location}
             )
             SELECT c.id,c.title,c.series,c.volume,c.number,c.summary,c.language,
                    c.reading_direction,c.published_at,c.offline,
                    l.runtime_id,l.relative_path,l.source_id
             FROM comics c
             LEFT JOIN ranked_locations l
               ON l.comic_id=c.id AND l.location_rank=1
             WHERE EXISTS (SELECT 1 FROM comic_locations visible
                            WHERE visible.comic_id=c.id
                              AND {visible_location_predicate})",
            visible_location = visible_location_predicate("l"),
            visible_location_predicate = visible_location_predicate("visible"),
        ))
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok(ComicMetadataView {
                comic_id: row.get(0)?,
                title: row.get(1)?,
                series: row.get(2)?,
                volume: row.get(3)?,
                number: row.get(4)?,
                summary: row.get(5)?,
                language: row.get(6)?,
                reading_direction: row.get(7)?,
                published_at: row.get(8)?,
                offline: row.get::<_, i64>(9)? != 0,
                runtime_id: row.get(10)?,
                relative_path: row.get(11)?,
                source_id: row.get(12)?,
                creators: BTreeMap::new(),
                tags: Vec::new(),
                candidates: Vec::new(),
                locked_fields: Vec::new(),
                diagnostics: Vec::new(),
                locations: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?
    {
        let view = row.map_err(|error| error.to_string())?;
        views.insert(view.comic_id.clone(), view);
    }
    drop(statement);

    let mut creator_values = HashMap::<String, String>::new();
    let mut statement = connection
        .prepare(
            "SELECT comic_id,value_json FROM user_field_overrides
             WHERE field_key='creators'",
        )
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
    {
        let (comic_id, value) = row.map_err(|error| error.to_string())?;
        creator_values.insert(comic_id, value);
    }
    drop(statement);
    let mut statement = connection
        .prepare(
            "SELECT mc.comic_id,mc.value_json
             FROM metadata_candidates mc
             JOIN metadata_sources ms ON ms.id=mc.source_id
             WHERE mc.field_key='creators' AND ms.parser_id NOT LIKE 'ai:%'
             ORDER BY mc.comic_id,mc.priority DESC,mc.confidence DESC,mc.id ASC",
        )
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
    {
        let (comic_id, value) = row.map_err(|error| error.to_string())?;
        creator_values.entry(comic_id).or_insert(value);
    }
    drop(statement);
    for (comic_id, value) in creator_values {
        if let Some(view) = views.get_mut(&comic_id) {
            view.creators = serde_json::from_str(&value).unwrap_or_default();
        }
    }

    let mut projected_tags = HashMap::<i64, (i64, ScopedTag)>::new();
    let mut statement = connection
        .prepare(
            "SELECT raw.id,final.id,final.namespace,final.display_value,final.disabled
             FROM tags raw
             JOIN canonical_tags source ON source.id=raw.canonical_tag_id
             LEFT JOIN tag_redirects redirect ON redirect.source_tag_id=source.id
             JOIN canonical_tags final ON final.id=COALESCE(redirect.target_tag_id,source.id)",
        )
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                ScopedTag {
                    namespace: row.get(2)?,
                    value: row.get(3)?,
                },
                row.get::<_, i64>(4)? != 0,
            ))
        })
        .map_err(|error| error.to_string())?
    {
        let (raw_id, canonical_id, tag, disabled) = row.map_err(|error| error.to_string())?;
        if !disabled {
            projected_tags.insert(raw_id, (canonical_id, tag));
        }
    }
    drop(statement);

    let mut raw_tags = HashMap::<String, BTreeSet<i64>>::new();
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT c.comic_id,c.tag_id
             FROM comic_tag_candidates c
             JOIN metadata_sources s ON s.id=c.source_id
             WHERE s.parser_id NOT LIKE 'ai:%'",
        )
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?
    {
        let (comic_id, tag_id) = row.map_err(|error| error.to_string())?;
        raw_tags.entry(comic_id).or_default().insert(tag_id);
    }
    drop(statement);

    let mut folder_rules = HashMap::<String, Vec<(String, i64)>>::new();
    let mut statement = connection
        .prepare(
            "SELECT source_id,folder_path,tag_id
             FROM folder_tag_rules WHERE enabled=1",
        )
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
    {
        let (source_id, folder_path, tag_id) = row.map_err(|error| error.to_string())?;
        folder_rules
            .entry(source_id)
            .or_default()
            .push((folder_path, tag_id));
    }
    drop(statement);
    for view in views.values() {
        let (Some(source_id), Some(path)) = (&view.source_id, &view.relative_path) else {
            continue;
        };
        let normalized = normalize_path(path);
        for (folder_path, tag_id) in folder_rules.get(source_id).into_iter().flatten() {
            if path_is_within(&normalized, folder_path) {
                raw_tags
                    .entry(view.comic_id.clone())
                    .or_default()
                    .insert(*tag_id);
            }
        }
    }

    let mut tag_overrides = HashMap::<String, Vec<(i64, String)>>::new();
    let mut statement = connection
        .prepare("SELECT comic_id,tag_id,action FROM comic_tag_overrides ORDER BY rowid")
        .map_err(|error| error.to_string())?;
    for row in statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
    {
        let (comic_id, tag_id, action) = row.map_err(|error| error.to_string())?;
        tag_overrides
            .entry(comic_id)
            .or_default()
            .push((tag_id, action));
    }
    drop(statement);

    for (comic_id, view) in views.iter_mut() {
        let mut tags = BTreeMap::new();
        if let Some(raw_ids) = raw_tags.get(comic_id) {
            for raw_id in raw_ids {
                if let Some((canonical_id, tag)) = projected_tags.get(raw_id) {
                    tags.insert(*canonical_id, tag.clone());
                }
            }
        }
        if let Some(overrides) = tag_overrides.get(comic_id) {
            for (raw_id, action) in overrides {
                let Some((canonical_id, tag)) = projected_tags.get(raw_id) else {
                    continue;
                };
                if action == "exclude" {
                    tags.remove(canonical_id);
                } else {
                    tags.insert(*canonical_id, tag.clone());
                }
            }
        }
        view.tags = tags.into_values().collect();
    }

    Ok(views)
}

fn hydrate_full_view(connection: &Connection, view: &mut ComicMetadataView) -> Result<(), String> {
    let comic_id = view.comic_id.as_str();
    let mut statement = connection.prepare(
        "SELECT mc.field_key,mc.value_json,ms.parser_id,mc.priority,mc.confidence,ms.source_path FROM metadata_candidates mc JOIN metadata_sources ms ON ms.id=mc.source_id WHERE mc.comic_id=?1 ORDER BY mc.field_key,mc.priority DESC"
    ).map_err(|error| error.to_string())?;
    view.candidates = statement
        .query_map([comic_id], |row| {
            let raw: String = row.get(1)?;
            Ok(MetadataCandidate {
                field: row.get(0)?,
                value: serde_json::from_str(&raw).unwrap_or(Value::Null),
                parser_id: row.get(2)?,
                priority: row.get(3)?,
                confidence: row.get(4)?,
                source_path: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare("SELECT field_key FROM user_field_overrides WHERE comic_id=?1 ORDER BY field_key")
        .map_err(|error| error.to_string())?;
    view.locked_fields = statement
        .query_map([comic_id], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    view.diagnostics = load_diagnostics(connection, Some(comic_id), 100)?;
    Ok(())
}

fn build_view(connection: &Connection, comic_id: &str) -> Result<ComicMetadataView, String> {
    let mut view = build_search_view(connection, comic_id)?;
    hydrate_full_view(connection, &mut view)?;
    Ok(view)
}

fn build_view_for_location(
    connection: &Connection,
    comic_id: &str,
    source_id: &str,
    relative_path: &str,
) -> Result<ComicMetadataView, String> {
    let mut view = build_view(connection, comic_id)?;
    let location = connection
        .query_row(
            &format!(
                "SELECT l.runtime_id,l.relative_path,l.source_id,l.online
             FROM comic_locations l
             WHERE l.comic_id=?1 AND l.source_id=?2
                       AND l.relative_path=?3
                       AND {visible_location}
             ORDER BY l.online DESC,l.last_seen_at DESC
             LIMIT 1",
                visible_location = visible_location_predicate("l")
            ),
            params![comic_id, source_id, relative_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    view.runtime_id = Some(location.0);
    view.relative_path = Some(location.1);
    view.source_id = Some(location.2);
    view.offline = !location.3;
    Ok(view)
}

fn attach_search_locations(
    connection: &Connection,
    items: &mut [ComicMetadataView],
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let placeholders = (1..=items.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT l.comic_id,l.runtime_id,l.source_id,l.relative_path,l.online
         FROM comic_locations l
         WHERE l.comic_id IN ({placeholders})
           AND {visible_location}
         ORDER BY l.comic_id,l.online DESC,l.last_seen_at DESC,l.source_id,l.relative_path",
        visible_location = visible_location_predicate("l")
    );
    let ids = items
        .iter()
        .map(|item| item.comic_id.as_str())
        .collect::<Vec<_>>();
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(ids), |row| {
            Ok((
                row.get::<_, String>(0)?,
                CatalogLocationView {
                    runtime_id: row.get(1)?,
                    source_id: row.get(2)?,
                    relative_path: row.get(3)?,
                    offline: row.get::<_, i64>(4)? == 0,
                },
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut locations_by_comic = HashMap::<String, Vec<CatalogLocationView>>::new();
    for row in rows {
        let (comic_id, location) = row.map_err(|error| error.to_string())?;
        locations_by_comic
            .entry(comic_id)
            .or_default()
            .push(location);
    }
    drop(statement);
    for item in items {
        item.locations = locations_by_comic
            .remove(&item.comic_id)
            .unwrap_or_default();
    }
    Ok(())
}

fn effective_creators(
    connection: &Connection,
    comic_id: &str,
) -> Result<BTreeMap<String, Vec<String>>, String> {
    let override_value: Option<String> = connection.query_row("SELECT value_json FROM user_field_overrides WHERE comic_id=?1 AND field_key='creators'", [comic_id], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
    let candidate = connection.query_row("SELECT mc.value_json FROM metadata_candidates mc JOIN metadata_sources ms ON ms.id=mc.source_id WHERE mc.comic_id=?1 AND mc.field_key='creators' AND ms.parser_id NOT LIKE 'ai:%' ORDER BY mc.priority DESC,mc.confidence DESC,mc.id ASC LIMIT 1", [comic_id], |row| row.get::<_, String>(0)).optional().map_err(|error| error.to_string())?;
    Ok(override_value
        .or(candidate)
        .and_then(|item| serde_json::from_str(&item).ok())
        .unwrap_or_default())
}

// Read indexed metadata for the visible discovery scope. No filesystem access,
// per-comic metadata hydration, or persistent catalog mutation is needed.
fn discovery_tag_groups(
    connection: &Connection,
    runtime_ids: &[String],
    targets: &[BatchEditTarget],
) -> Result<Vec<DiscoveryTagGroup>, String> {
    let ids = serde_json::to_string(runtime_ids).map_err(|error| error.to_string())?;
    let targets_json = serde_json::to_string(targets).map_err(|error| error.to_string())?;
    let source_qualified = if targets.is_empty() { 0 } else { 1 };
    let mut statement = connection
        .prepare(
            "WITH selected AS (
           SELECT DISTINCT l.runtime_id,l.comic_id,l.source_id,
                  l.relative_path,
                  trim(replace(l.relative_path,char(92),'/'),'/') AS normalized_relative_path
           FROM comic_locations l
           WHERE l.online=1 AND (
             (?2=0 AND l.runtime_id IN (SELECT value FROM json_each(?1)))
             OR (?2=1 AND EXISTS (
               SELECT 1 FROM json_each(?3) requested
               WHERE json_extract(requested.value,'$.runtimeId')=l.runtime_id
                 AND json_extract(requested.value,'$.sourceId')=l.source_id
                 AND json_extract(requested.value,'$.relativePath')=l.relative_path
             ))
           )
         ), projected AS (
           SELECT raw.id AS raw_id,final.id AS canonical_id,
                  final.namespace,final.display_value
           FROM tags raw
           JOIN canonical_tags source ON source.id=raw.canonical_tag_id
           LEFT JOIN tag_redirects redirect ON redirect.source_tag_id=source.id
           JOIN canonical_tags final ON final.id=COALESCE(redirect.target_tag_id,source.id)
           WHERE final.disabled=0
         ), folder_rules AS (
           SELECT source_id,tag_id,trim(replace(folder_path,char(92),'/'),'/') AS folder_path
           FROM folder_tag_rules WHERE enabled=1
         ), seeds AS (
           SELECT s.runtime_id,s.source_id,s.relative_path,c.tag_id FROM selected s
           JOIN comic_tag_candidates c ON c.comic_id=s.comic_id
           JOIN metadata_sources m ON m.id=c.source_id
           WHERE m.parser_id NOT LIKE 'ai:%'
           UNION
           SELECT s.runtime_id,s.source_id,s.relative_path,r.tag_id FROM selected s
           JOIN folder_rules r ON r.source_id=s.source_id
           WHERE r.folder_path='' OR s.normalized_relative_path=r.folder_path
              OR substr(s.normalized_relative_path,1,length(r.folder_path)+1)=r.folder_path||'/'
         ), inherited AS (
           SELECT DISTINCT s.runtime_id,s.source_id,s.relative_path,p.canonical_id FROM seeds s
           JOIN projected p ON p.raw_id=s.tag_id
         ), overrides AS (
           SELECT s.runtime_id,s.source_id,s.relative_path,p.canonical_id,o.action,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.runtime_id,s.source_id,s.relative_path,p.canonical_id
                    ORDER BY o.rowid DESC
                  ) AS precedence
           FROM selected s JOIN comic_tag_overrides o ON o.comic_id=s.comic_id
           JOIN projected p ON p.raw_id=o.tag_id
         ), effective AS (
           SELECT i.runtime_id,i.source_id,i.relative_path,i.canonical_id FROM inherited i
           WHERE NOT EXISTS (
             SELECT 1 FROM overrides o WHERE o.runtime_id=i.runtime_id
               AND o.source_id=i.source_id AND o.relative_path=i.relative_path
               AND o.canonical_id=i.canonical_id AND o.precedence=1 AND o.action='exclude'
           )
           UNION
           SELECT runtime_id,source_id,relative_path,canonical_id FROM overrides
             WHERE precedence=1 AND action='include'
         )
         SELECT DISTINCT p.namespace,p.display_value,e.runtime_id,e.source_id,e.relative_path
         FROM effective e JOIN projected p ON p.canonical_id=e.canonical_id
         ORDER BY p.namespace,p.display_value,e.runtime_id,e.source_id,e.relative_path",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![ids, source_qualified, targets_json], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    type TagKey = (String, String);
    type DiscoveryLocation = (String, String, String);
    let mut groups: BTreeMap<TagKey, BTreeSet<DiscoveryLocation>> = BTreeMap::new();
    for row in rows {
        let (namespace, value, runtime_id, source_id, relative_path) =
            row.map_err(|error| error.to_string())?;
        groups.entry((namespace, value)).or_default().insert((
            runtime_id,
            source_id,
            relative_path,
        ));
    }
    Ok(groups
        .into_iter()
        .map(|((namespace, value), targets)| {
            let comic_ids = targets
                .iter()
                .map(|(runtime_id, _, _)| runtime_id.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let targets = targets
                .into_iter()
                .map(|(runtime_id, source_id, relative_path)| BatchEditTarget {
                    runtime_id,
                    source_id,
                    relative_path,
                })
                .collect();
            DiscoveryTagGroup {
                namespace,
                value,
                comic_ids,
                targets,
            }
        })
        .collect())
}

fn effective_tags(connection: &Connection, comic_id: &str) -> Result<Vec<ScopedTag>, String> {
    let mut raw_tags: BTreeMap<i64, ScopedTag> = BTreeMap::new();
    let mut statement = connection.prepare("SELECT DISTINCT t.id,t.namespace,t.value FROM comic_tag_candidates c JOIN tags t ON t.id=c.tag_id JOIN metadata_sources s ON s.id=c.source_id WHERE c.comic_id=?1 AND s.parser_id NOT LIKE 'ai:%'").map_err(|error| error.to_string())?;
    for row in statement
        .query_map([comic_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                ScopedTag {
                    namespace: row.get(1)?,
                    value: row.get(2)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?
    {
        let (id, tag) = row.map_err(|error| error.to_string())?;
        raw_tags.insert(id, tag);
    }
    let visible_location = visible_location_predicate("l");
    let primary_order = primary_location_order("l");
    let location: Option<(String, String)> = connection
        .query_row(
            &format!(
                "SELECT l.source_id,l.relative_path FROM comic_locations l
             WHERE l.comic_id=?1 AND {visible_location}
             ORDER BY {primary_order} LIMIT 1"
            ),
            [comic_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((source_id, path)) = location {
        let normalized = normalize_path(&path);
        let mut statement = connection.prepare("SELECT t.id,t.namespace,t.value,r.folder_path FROM folder_tag_rules r JOIN tags t ON t.id=r.tag_id WHERE r.source_id=?1 AND r.enabled=1").map_err(|error| error.to_string())?;
        for row in statement
            .query_map([source_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    ScopedTag {
                        namespace: row.get(1)?,
                        value: row.get(2)?,
                    },
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
        {
            let (id, tag, folder) = row.map_err(|error| error.to_string())?;
            if path_is_within(&normalized, &folder) {
                raw_tags.insert(id, tag);
            }
        }
    }
    let mut tags = BTreeMap::new();
    for raw_id in raw_tags.keys() {
        if let Some((canonical_id, tag)) = project_tag(connection, *raw_id)? {
            tags.insert(canonical_id, tag);
        }
    }
    let mut statement = connection.prepare("SELECT o.tag_id,o.action,t.namespace,t.value FROM comic_tag_overrides o JOIN tags t ON t.id=o.tag_id WHERE o.comic_id=?1 ORDER BY o.rowid").map_err(|error| error.to_string())?;
    for row in statement
        .query_map([comic_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                ScopedTag {
                    namespace: row.get(2)?,
                    value: row.get(3)?,
                },
            ))
        })
        .map_err(|error| error.to_string())?
    {
        let (raw_id, action, _) = row.map_err(|error| error.to_string())?;
        let Some((id, tag)) = project_tag(connection, raw_id)? else {
            continue;
        };
        if action == "exclude" {
            tags.remove(&id);
        } else {
            tags.insert(id, tag);
        }
    }
    Ok(tags.into_values().collect())
}

fn project_tag(
    connection: &Connection,
    raw_tag_id: i64,
) -> Result<Option<(i64, ScopedTag)>, String> {
    connection
        .query_row(
            "SELECT final.id,final.namespace,final.display_value,final.disabled
               FROM tags raw
               JOIN canonical_tags source ON source.id=raw.canonical_tag_id
               LEFT JOIN tag_redirects redirect ON redirect.source_tag_id=source.id
               JOIN canonical_tags final ON final.id=COALESCE(redirect.target_tag_id,source.id)
              WHERE raw.id=?1",
            [raw_tag_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    ScopedTag {
                        namespace: row.get(1)?,
                        value: row.get(2)?,
                    },
                    row.get::<_, i64>(3)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
        .map(|result| result.and_then(|(id, tag, disabled)| (!disabled).then_some((id, tag))))
}

fn refresh_fts(tx: &Transaction<'_>, comic_id: &str) -> Result<(), String> {
    refresh_fts_inner(tx, comic_id)
}

fn refresh_fts_batch(connection: &Connection, comic_ids: &BTreeSet<String>) -> Result<(), String> {
    if comic_ids.is_empty() {
        return Ok(());
    }
    let placeholders = (1..=comic_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let delete_sql = format!("DELETE FROM catalog_fts WHERE comic_id IN ({placeholders})");
    connection
        .execute(&delete_sql, rusqlite::params_from_iter(comic_ids.iter()))
        .map_err(|error| error.to_string())?;
    let delete_short_sql =
        format!("DELETE FROM catalog_short_ngrams WHERE comic_id IN ({placeholders})");
    connection
        .execute(
            &delete_short_sql,
            rusqlite::params_from_iter(comic_ids.iter()),
        )
        .map_err(|error| error.to_string())?;
    let mut insert = connection
        .prepare("INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES(?1,?2,?3,?4,?5,?6,?7)")
        .map_err(|error| error.to_string())?;
    let mut short_insert = connection
        .prepare("INSERT OR IGNORE INTO catalog_short_ngrams(comic_id,gram) VALUES(?1,?2)")
        .map_err(|error| error.to_string())?;
    for comic_id in comic_ids {
        let view = build_search_view(connection, comic_id)?;
        insert_fts_view(&mut insert, comic_id, &view)?;
        insert_short_ngrams(&mut short_insert, comic_id, &view)?;
    }
    Ok(())
}

fn refresh_fts_inner(connection: &Connection, comic_id: &str) -> Result<(), String> {
    let view = build_search_view(connection, comic_id)?;
    connection
        .execute("DELETE FROM catalog_fts WHERE comic_id=?1", [comic_id])
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM catalog_short_ngrams WHERE comic_id=?1",
            [comic_id],
        )
        .map_err(|error| error.to_string())?;
    let mut insert = connection
        .prepare("INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES(?1,?2,?3,?4,?5,?6,?7)")
        .map_err(|error| error.to_string())?;
    insert_fts_view(&mut insert, comic_id, &view)?;
    let mut short_insert = connection
        .prepare("INSERT OR IGNORE INTO catalog_short_ngrams(comic_id,gram) VALUES(?1,?2)")
        .map_err(|error| error.to_string())?;
    insert_short_ngrams(&mut short_insert, comic_id, &view)
}

fn insert_fts_view(
    statement: &mut rusqlite::Statement<'_>,
    comic_id: &str,
    view: &ComicMetadataView,
) -> Result<(), String> {
    let creators = view
        .creators
        .values()
        .flatten()
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    let tags = view
        .tags
        .iter()
        .map(|tag| format!("{}:{} {}", tag.namespace, tag.value, tag.value))
        .collect::<Vec<_>>()
        .join(" ");
    statement
        .execute(params![
            comic_id,
            view.title,
            view.series,
            view.relative_path,
            creators,
            tags,
            view.language
        ])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn add_short_ngrams(grams: &mut HashSet<String>, value: &str) {
    let chars = value.to_lowercase().chars().collect::<Vec<_>>();
    for &character in &chars {
        grams.insert(encode_short_gram(&[character]));
    }
    for pair in chars.windows(2) {
        grams.insert(encode_short_gram(pair));
    }
}

fn encode_short_gram(chars: &[char]) -> String {
    let prefix = match chars.len() {
        1 => "g1",
        2 => "g2",
        _ => unreachable!("short grams contain one or two codepoints"),
    };
    let mut encoded = String::with_capacity(prefix.len() + chars.len() * 6);
    encoded.push_str(prefix);
    for character in chars {
        encoded.push_str(&format!("{:06x}", *character as u32));
    }
    encoded
}

fn insert_short_ngrams(
    statement: &mut rusqlite::Statement<'_>,
    comic_id: &str,
    view: &ComicMetadataView,
) -> Result<(), String> {
    let mut grams = HashSet::new();
    add_short_ngrams(&mut grams, &view.title);
    if let Some(series) = view.series.as_deref() {
        add_short_ngrams(&mut grams, series);
    }
    if let Some(path) = view.relative_path.as_deref() {
        add_short_ngrams(&mut grams, path);
    }
    for creator in view.creators.values().flatten() {
        add_short_ngrams(&mut grams, creator);
    }
    for tag in &view.tags {
        add_short_ngrams(&mut grams, &tag.namespace);
        add_short_ngrams(&mut grams, &tag.value);
    }
    if let Some(language) = view.language.as_deref() {
        add_short_ngrams(&mut grams, language);
    }
    for gram in grams {
        statement
            .execute(params![comic_id, gram])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn rebuild_catalog_fts(connection: &mut Connection) -> Result<(), String> {
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM catalog_fts", [])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM catalog_short_ngrams", [])
        .map_err(|error| error.to_string())?;
    let comic_ids = {
        let mut statement = tx
            .prepare("SELECT id FROM comics ORDER BY id")
            .map_err(|error| error.to_string())?;
        let comic_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        comic_ids
    };
    let mut insert = tx
        .prepare("INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES(?1,?2,?3,?4,?5,?6,?7)")
        .map_err(|error| error.to_string())?;
    let mut short_insert = tx
        .prepare("INSERT OR IGNORE INTO catalog_short_ngrams(comic_id,gram) VALUES(?1,?2)")
        .map_err(|error| error.to_string())?;
    for comic_id in comic_ids {
        let view = build_search_view(&tx, &comic_id)?;
        insert_fts_view(&mut insert, &comic_id, &view)?;
        insert_short_ngrams(&mut short_insert, &comic_id, &view)?;
    }
    drop(insert);
    drop(short_insert);
    tx.commit().map_err(|error| error.to_string())
}

fn search_catalog(
    connection: &Connection,
    query: CatalogQuery,
) -> Result<CatalogSearchResult, String> {
    let mut parsed = ParsedQuery::parse(&query.query);
    resolve_query_aliases(connection, &mut parsed)?;
    let seed_terms = parsed
        .free
        .iter()
        .cloned()
        .chain(parsed.include.iter().map(|(_, value)| value.clone()))
        .collect::<Vec<_>>();
    let visible_location = visible_location_predicate("l");
    if seed_terms.is_empty() && parsed.exclude.is_empty() {
        let total = connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM comics c
                     WHERE EXISTS (SELECT 1 FROM comic_locations l
                                    WHERE l.comic_id=c.id AND {visible_location})"
                ),
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())? as usize;
        let limit = query.limit.clamp(1, PAGE_SIZE_MAX);
        let mut statement = connection
            .prepare(&format!(
                "SELECT c.id FROM comics c
                 WHERE EXISTS (SELECT 1 FROM comic_locations l
                                WHERE l.comic_id=c.id AND {visible_location})
                 ORDER BY c.updated_at DESC,c.title COLLATE NOCASE
                 LIMIT ?1 OFFSET ?2"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![limit as i64, query.offset.min(total) as i64],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        let ids = rows
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        let mut items = ids
            .iter()
            .map(|id| build_view(connection, id))
            .collect::<Result<Vec<_>, _>>()?;
        attach_search_locations(connection, &mut items)?;
        return Ok(CatalogSearchResult {
            items,
            total,
            facets: BTreeMap::new(),
        });
    }
    let offset = query.offset;
    let limit = query.limit.clamp(1, PAGE_SIZE_MAX);
    let mut total = 0usize;
    let mut items = Vec::with_capacity(limit);
    let mut facets: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    let mut process_view = |mut view: ComicMetadataView| -> Result<(), String> {
        // Matching and facet counting only need the effective searchable fields.
        // Candidates, locks, and diagnostics are hydrated for the page returned
        // to the caller, avoiding several queries for every matching row.
        if parsed.matches(&view) {
            total += 1;
            if let Some(language) = &view.language {
                *facets
                    .entry("language".into())
                    .or_default()
                    .entry(language.clone())
                    .or_default() += 1;
            }
            for tag in &view.tags {
                *facets
                    .entry(tag.namespace.clone())
                    .or_default()
                    .entry(tag.value.clone())
                    .or_default() += 1;
            }
            if total > offset && items.len() < limit {
                hydrate_full_view(connection, &mut view)?;
                items.push(view);
            }
        }
        Ok(())
    };
    let mut process_id =
        |id: String| -> Result<(), String> { process_view(build_search_view(connection, &id)?) };
    if seed_terms.is_empty() {
        // Effective searchable fields are loaded in batches so exclusion-only
        // searches do not prepare and execute several statements per comic.
        let mut search_views = build_search_views_batch(connection)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT c.id FROM comics c
                 WHERE EXISTS (SELECT 1 FROM comic_locations l
                                WHERE l.comic_id=c.id AND {visible_location})
                 ORDER BY c.updated_at DESC,c.title COLLATE NOCASE",
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            let id = row.map_err(|error| error.to_string())?;
            let view = search_views
                .remove(&id)
                .ok_or_else(|| format!("找不到漫畫搜尋資料: {id}"))?;
            process_view(view)?;
        }
    } else {
        let long_terms = seed_terms
            .iter()
            .filter(|term| term.chars().count() >= 3)
            .collect::<Vec<_>>();
        let short_terms = seed_terms
            .iter()
            .filter(|term| term.chars().count() < 3)
            .collect::<Vec<_>>();
        let short_grams = short_terms
            .iter()
            .map(|term| short_query_grams(term))
            .collect::<Vec<_>>();
        if long_terms.is_empty() {
            // Short-only searches must stay on the gram index. Selecting from
            // catalog_fts by its UNINDEXED comic_id would still scan FTS rows.
            let mut bind_values = Vec::new();
            let mut predicates = Vec::new();
            for (index, grams) in short_grams.iter().enumerate() {
                let placeholders = (0..grams.len())
                    .map(|_| "?".to_string())
                    .collect::<Vec<_>>()
                    .join(",");
                bind_values.extend(grams.iter().cloned());
                if index == 0 {
                    predicates.push(format!("base.gram IN ({placeholders})"));
                } else {
                    predicates.push(format!(
                        "EXISTS (SELECT 1 FROM catalog_short_ngrams gram_{index}
                                 WHERE gram_{index}.comic_id=base.comic_id
                                   AND gram_{index}.gram IN ({placeholders}))"
                    ));
                }
            }
            let sql = format!(
                "SELECT DISTINCT base.comic_id FROM catalog_short_ngrams base
                 JOIN comics c ON c.id=base.comic_id
                 WHERE EXISTS (SELECT 1 FROM comic_locations l
                                WHERE l.comic_id=c.id AND {visible_location})
                   AND {} ORDER BY c.updated_at DESC,c.title COLLATE NOCASE,base.comic_id",
                predicates.join(" AND ")
            );
            let mut statement = connection
                .prepare(&sql)
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(bind_values.iter()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())?;
            for row in rows {
                process_id(row.map_err(|error| error.to_string())?)?;
            }
            attach_search_locations(connection, &mut items)?;
            return Ok(CatalogSearchResult {
                items,
                total,
                facets,
            });
        }
        let mut predicates = Vec::new();
        let mut bind_values = Vec::new();
        if !long_terms.is_empty() {
            let fts = long_terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" AND ");
            predicates.push("catalog_fts MATCH ?".to_string());
            bind_values.push(fts);
        }
        for grams in short_grams {
            if grams.is_empty() {
                continue;
            }
            let placeholders = (0..grams.len())
                .map(|_| "?".to_string())
                .collect::<Vec<_>>()
                .join(",");
            predicates.push(format!(
                "comic_id IN (SELECT comic_id FROM catalog_short_ngrams WHERE gram IN ({placeholders}))"
            ));
            bind_values.extend(grams);
        }
        let sql = format!(
            "SELECT catalog_fts.comic_id FROM catalog_fts
             JOIN comics c ON c.id=catalog_fts.comic_id
             WHERE EXISTS (SELECT 1 FROM comic_locations l
                            WHERE l.comic_id=c.id AND {visible_location})
               AND {} ORDER BY rank",
            predicates.join(" AND ")
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(bind_values.iter()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            process_id(row.map_err(|error| error.to_string())?)?;
        }
    }
    attach_search_locations(connection, &mut items)?;
    Ok(CatalogSearchResult {
        items,
        total,
        facets,
    })
}

fn short_query_grams(value: &str) -> Vec<String> {
    let chars = value.to_lowercase().chars().collect::<Vec<_>>();
    if chars.is_empty() {
        return Vec::new();
    }
    if chars.len() == 1 {
        return vec![encode_short_gram(&chars)];
    }
    chars.windows(2).map(encode_short_gram).collect::<Vec<_>>()
}

const TAG_INVENTORY_CTE: &str = "
WITH effective_ids(tag_id,comic_id) AS (
  SELECT COALESCE(r.target_tag_id,t.canonical_tag_id),c.comic_id
    FROM comic_tag_candidates c
    JOIN metadata_sources s ON s.id=c.source_id AND s.parser_id NOT LIKE 'ai:%'
    JOIN tags t ON t.id=c.tag_id
    LEFT JOIN tag_redirects r ON r.source_tag_id=t.canonical_tag_id
  UNION
  SELECT COALESCE(r.target_tag_id,t.canonical_tag_id),o.comic_id
    FROM comic_tag_overrides o
    JOIN tags t ON t.id=o.tag_id
    LEFT JOIN tag_redirects r ON r.source_tag_id=t.canonical_tag_id
   WHERE o.action='include'
  UNION
  SELECT COALESCE(rd.target_tag_id,t.canonical_tag_id),l.comic_id
    FROM folder_tag_rules f
    JOIN tags t ON t.id=f.tag_id
    LEFT JOIN tag_redirects rd ON rd.source_tag_id=t.canonical_tag_id
    JOIN comic_locations l ON l.source_id=f.source_id
     AND (l.relative_path=f.folder_path OR l.relative_path LIKE f.folder_path || '/%')
   WHERE f.enabled=1
), excluded_ids(tag_id,comic_id) AS (
  SELECT COALESCE(r.target_tag_id,t.canonical_tag_id),o.comic_id
    FROM comic_tag_overrides o
    JOIN tags t ON t.id=o.tag_id
    LEFT JOIN tag_redirects r ON r.source_tag_id=t.canonical_tag_id
   WHERE o.action='exclude'
), counts(tag_id,work_count) AS (
  SELECT e.tag_id,COUNT(DISTINCT e.comic_id)
    FROM effective_ids e
   WHERE e.tag_id IS NOT NULL
     AND NOT EXISTS(
       SELECT 1 FROM excluded_ids x WHERE x.tag_id=e.tag_id AND x.comic_id=e.comic_id
     )
   GROUP BY e.tag_id
) ";

fn load_tag_inventory(
    connection: &Connection,
    query: TagInventoryQuery,
) -> Result<TagInventoryResult, String> {
    let normalized_query = normalize_tag_key(&query.query);
    let pattern = format!("%{normalized_query}%");
    let limit = query.limit.clamp(1, PAGE_SIZE_MAX);
    let total_sql = format!(
        "{TAG_INVENTORY_CTE}
         SELECT COUNT(*) FROM canonical_tags c
          WHERE ?1='' OR c.namespace LIKE ?2 OR c.normalized_value LIKE ?2"
    );
    let total: i64 = connection
        .query_row(&total_sql, params![normalized_query, pattern], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    let sql = format!(
        "{TAG_INVENTORY_CTE}
         SELECT c.id,c.namespace,c.display_value,c.normalized_value,
                COALESCE(n.work_count,0),COALESCE(u.pinned,0),COALESCE(u.usage_count,0),
                u.last_used_at,u.color_key,c.disabled
           FROM canonical_tags c
           LEFT JOIN counts n ON n.tag_id=c.id
           LEFT JOIN tag_user_state u ON u.tag_id=c.id
          WHERE ?1='' OR c.namespace LIKE ?2 OR c.normalized_value LIKE ?2
          ORDER BY COALESCE(u.pinned,0) DESC,COALESCE(u.usage_count,0) DESC,
                   COALESCE(n.work_count,0) DESC,c.namespace,c.normalized_value
          LIMIT ?3 OFFSET ?4"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let items = statement
        .query_map(
            params![normalized_query, pattern, limit as i64, query.offset as i64],
            |row| {
                Ok(TagInventoryItem {
                    id: row.get(0)?,
                    namespace: row.get(1)?,
                    display_value: row.get(2)?,
                    normalized_value: row.get(3)?,
                    work_count: row.get::<_, i64>(4)?.max(0) as usize,
                    pinned: row.get::<_, i64>(5)? != 0,
                    usage_count: row.get::<_, i64>(6)?.max(0) as usize,
                    last_used_at: row.get(7)?,
                    color_key: row.get(8)?,
                    disabled: row.get::<_, i64>(9)? != 0,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(TagInventoryResult {
        items,
        total: total.max(0) as usize,
    })
}

fn tag_work_count(connection: &Connection, tag_id: i64) -> Result<usize, String> {
    let sql = format!(
        "{TAG_INVENTORY_CTE} SELECT COALESCE((SELECT work_count FROM counts WHERE tag_id=?1),0)"
    );
    connection
        .query_row(&sql, [tag_id], |row| row.get::<_, i64>(0))
        .map(|count| count.max(0) as usize)
        .map_err(|error| error.to_string())
}

fn final_canonical_tag_id(connection: &Connection, start: i64) -> Result<i64, String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM canonical_tags WHERE id=?1)",
            [start],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exists {
        return Err("找不到目標標籤".into());
    }
    let mut current = start;
    let mut seen = BTreeSet::new();
    for _ in 0..32 {
        if !seen.insert(current) {
            return Err("標籤 redirect 已形成循環".into());
        }
        let next: Option<i64> = connection
            .query_row(
                "SELECT target_tag_id FROM tag_redirects WHERE source_tag_id=?1",
                [current],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        match next {
            Some(next) => current = next,
            None => return Ok(current),
        }
    }
    Err("標籤 redirect 鏈過深".into())
}

fn refresh_fts_for_canonical_tags(connection: &Connection, tag_ids: &[i64]) -> Result<(), String> {
    if tag_ids.is_empty() {
        return Ok(());
    }
    let placeholders = (1..=tag_ids.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT DISTINCT comic_id FROM (
           SELECT c.comic_id FROM comic_tag_candidates c JOIN tags t ON t.id=c.tag_id
            LEFT JOIN tag_redirects r ON r.source_tag_id=t.canonical_tag_id
            WHERE t.canonical_tag_id IN ({placeholders}) OR r.target_tag_id IN ({placeholders})
           UNION
           SELECT o.comic_id FROM comic_tag_overrides o JOIN tags t ON t.id=o.tag_id
            LEFT JOIN tag_redirects r ON r.source_tag_id=t.canonical_tag_id
            WHERE t.canonical_tag_id IN ({placeholders}) OR r.target_tag_id IN ({placeholders})
           UNION
           SELECT l.comic_id FROM folder_tag_rules f JOIN tags t ON t.id=f.tag_id
            LEFT JOIN tag_redirects r ON r.source_tag_id=t.canonical_tag_id
            JOIN comic_locations l ON l.source_id=f.source_id
             AND (l.relative_path=f.folder_path OR l.relative_path LIKE f.folder_path || '/%')
            WHERE t.canonical_tag_id IN ({placeholders}) OR r.target_tag_id IN ({placeholders})
         )"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let comic_ids = statement
        .query_map(rusqlite::params_from_iter(tag_ids.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for comic_id in comic_ids {
        refresh_fts_inner(connection, &comic_id)?;
    }
    Ok(())
}

fn undo_tag_mutation(connection: &mut Connection, token: &str) -> Result<bool, String> {
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let raw: String = tx
        .query_row(
            "SELECT snapshot_json FROM tag_operations WHERE token=?1",
            [token],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("找不到可撤銷的標籤操作")?;
    let snapshot: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    if snapshot.get("version").and_then(Value::as_i64) != Some(1) {
        return Err("不支援的標籤撤銷格式".into());
    }
    let kind = snapshot
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("標籤撤銷缺少 kind")?;
    let mut refresh_ids = Vec::new();
    match kind {
        "rename" => {
            let tag_id = snapshot["tagId"].as_i64().ok_or("rename 缺少 tagId")?;
            let current: (String, String, i64) = tx.query_row(
                "SELECT display_value,normalized_value,disabled FROM canonical_tags WHERE id=?1",
                [tag_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
            ).map_err(|error| error.to_string())?;
            let after = &snapshot["after"];
            if current.0 != after["display"].as_str().unwrap_or_default()
                || current.1 != after["normalized"].as_str().unwrap_or_default()
                || current.2 != after["disabled"].as_i64().unwrap_or_default()
            {
                return Err("標籤在此操作後又被修改；為避免覆蓋新變更，已拒絕撤銷".into());
            }
            let before = &snapshot["before"];
            tx.execute(
                "UPDATE canonical_tags SET display_value=?2,normalized_value=?3,disabled=?4,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![tag_id,before["display"].as_str(),before["normalized"].as_str(),before["disabled"].as_i64()],
            ).map_err(|error| error.to_string())?;
            refresh_ids.push(tag_id);
        }
        "disable" => {
            let tag_id = snapshot["tagId"].as_i64().ok_or("disable 缺少 tagId")?;
            let current: i64 = tx
                .query_row(
                    "SELECT disabled FROM canonical_tags WHERE id=?1",
                    [tag_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if current != snapshot["after"].as_i64().unwrap_or_default() {
                return Err("標籤停用狀態已有新變更，已拒絕撤銷".into());
            }
            tx.execute(
                "UPDATE canonical_tags SET disabled=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![tag_id, snapshot["before"].as_i64()],
            )
            .map_err(|error| error.to_string())?;
            refresh_ids.push(tag_id);
        }
        "merge" => {
            let source = snapshot["sourceTagId"]
                .as_i64()
                .ok_or("merge 缺少 sourceTagId")?;
            let after_target = snapshot["after"]["target"]
                .as_i64()
                .ok_or("merge 缺少 target")?;
            let current_target: Option<i64> = tx
                .query_row(
                    "SELECT target_tag_id FROM tag_redirects WHERE source_tag_id=?1",
                    [source],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let current_disabled: i64 = tx
                .query_row(
                    "SELECT disabled FROM canonical_tags WHERE id=?1",
                    [source],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if current_target != Some(after_target) || current_disabled != 1 {
                return Err("合併後標籤已有新變更，已拒絕撤銷".into());
            }
            tx.execute("DELETE FROM tag_redirects WHERE source_tag_id=?1", [source])
                .map_err(|error| error.to_string())?;
            if let Some(previous) = snapshot["before"]["target"].as_i64() {
                tx.execute(
                    "INSERT INTO tag_redirects(source_tag_id,target_tag_id) VALUES(?1,?2)",
                    params![source, previous],
                )
                .map_err(|error| error.to_string())?;
            }
            tx.execute(
                "UPDATE canonical_tags SET disabled=?2,updated_at=CURRENT_TIMESTAMP WHERE id=?1",
                params![source, snapshot["before"]["disabled"].as_i64()],
            )
            .map_err(|error| error.to_string())?;
            if let Some(incoming) = snapshot["before"]["incoming"].as_array() {
                for incoming_source in incoming.iter().filter_map(Value::as_i64) {
                    tx.execute("UPDATE tag_redirects SET target_tag_id=?2 WHERE source_tag_id=?1 AND target_tag_id=?3", params![incoming_source,source,after_target]).map_err(|error| error.to_string())?;
                }
            }
            refresh_ids.extend([source, after_target]);
        }
        _ => return Err("未知標籤操作".into()),
    }
    refresh_fts_for_canonical_tags(&tx, &refresh_ids)?;
    tx.execute("DELETE FROM tag_operations WHERE token=?1", [token])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn normalize_tag_alias(alias: TagAlias) -> Result<TagAlias, String> {
    let alias = TagAlias {
        namespace: normalize_tag_key(&alias.namespace),
        alias: alias.alias.trim().to_string(),
        canonical_value: alias.canonical_value.trim().to_string(),
    };
    if alias.namespace.is_empty() || alias.alias.is_empty() || alias.canonical_value.is_empty() {
        return Err("tag alias 的 namespace、alias 與 canonicalValue 不可為空".into());
    }
    Ok(alias)
}

fn resolve_query_aliases(connection: &Connection, parsed: &mut ParsedQuery) -> Result<(), String> {
    for (field, value) in parsed.include.iter_mut().chain(parsed.exclude.iter_mut()) {
        let namespace = if field == "tag" {
            "general"
        } else {
            field.as_str()
        };
        if let Some(canonical) = connection.query_row(
            "SELECT canonical_value FROM tag_aliases WHERE namespace=?1 AND normalized_alias=?2",
            params![namespace, normalize_tag_key(value)],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|error| error.to_string())? {
            *value = canonical.to_lowercase();
        }
    }
    Ok(())
}

#[derive(Default)]
struct ParsedQuery {
    free: Vec<String>,
    include: Vec<(String, String)>,
    exclude: Vec<(String, String)>,
}
impl ParsedQuery {
    fn parse(query: &str) -> Self {
        let mut parsed = Self::default();
        for token in tokenize(query) {
            let (negative, token) = token
                .strip_prefix('-')
                .map(|item| (true, item))
                .unwrap_or((false, token.as_str()));
            if let Some((field, value)) = token.split_once(':') {
                let target = if negative {
                    &mut parsed.exclude
                } else {
                    &mut parsed.include
                };
                target.push((field.to_ascii_lowercase(), value.to_lowercase()));
            } else if !negative && !token.is_empty() {
                parsed.free.push(token.to_string());
            }
        }
        parsed
    }
    fn matches(&self, view: &ComicMetadataView) -> bool {
        self.free.iter().all(|term| free_text_matches(view, term))
            && self
                .include
                .iter()
                .all(|term| query_term_matches(view, term))
            && self
                .exclude
                .iter()
                .all(|term| !query_term_matches(view, term))
    }
}

fn free_text_matches(view: &ComicMetadataView, value: &str) -> bool {
    let value = value.to_lowercase();
    view.title.to_lowercase().contains(&value)
        || view
            .series
            .as_deref()
            .is_some_and(|item| item.to_lowercase().contains(&value))
        || view
            .relative_path
            .as_deref()
            .is_some_and(|item| item.to_lowercase().contains(&value))
        || view
            .creators
            .values()
            .flatten()
            .any(|item| item.to_lowercase().contains(&value))
        || view.tags.iter().any(|tag| {
            tag.namespace.to_lowercase().contains(&value)
                || tag.value.to_lowercase().contains(&value)
        })
        || view
            .language
            .as_deref()
            .is_some_and(|item| item.to_lowercase().contains(&value))
}

fn query_term_matches(view: &ComicMetadataView, (field, value): &(String, String)) -> bool {
    match field.as_str() {
        "artist" | "author" => view
            .creators
            .values()
            .flatten()
            .any(|item| item.to_lowercase().contains(value)),
        "series" => view
            .series
            .as_ref()
            .is_some_and(|item| item.to_lowercase().contains(value)),
        "language" | "lang" => view
            .language
            .as_ref()
            .is_some_and(|item| item.to_lowercase().contains(value)),
        "tag" => view
            .tags
            .iter()
            .any(|tag| tag.value.to_lowercase().contains(value)),
        namespace => view
            .tags
            .iter()
            .any(|tag| tag.namespace == namespace && tag.value.to_lowercase().contains(value)),
    }
}

fn tokenize(query: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for ch in query.chars() {
        match ch {
            '"' => quoted = !quoted,
            ch if ch.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn resolve_comic_id(connection: &Connection, identifier: &str) -> Result<Option<String>, String> {
    // A runtime ID is not globally unique. Bound the lookup at two distinct
    // comic IDs so normal multi-location rows remain valid while callers can
    // fail closed instead of inheriting SQLite's arbitrary LIMIT 1 choice.
    let mut statement = connection
        .prepare(
            "SELECT id FROM comics WHERE id=?1
             UNION SELECT comic_id FROM comic_locations WHERE runtime_id=?1
             LIMIT 2",
        )
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([identifier], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    match ids.as_slice() {
        [] => Ok(None),
        [comic_id] => Ok(Some(comic_id.clone())),
        _ => Err(format!("漫畫識別碼不唯一，已拒絕任選：{identifier}")),
    }
}

fn resolve_progress_comic_id(
    connection: &Connection,
    identifier: &str,
    source_id: Option<&str>,
) -> Result<Option<String>, String> {
    let mut statement = if source_id.is_some() {
        connection
            .prepare(
                "SELECT DISTINCT l.comic_id
                 FROM comic_locations l
                 JOIN comics c ON c.id=l.comic_id
                 WHERE l.source_id=?2 AND (l.runtime_id=?1 OR l.comic_id=?1)",
            )
            .map_err(|error| error.to_string())?
    } else {
        connection
            .prepare(
                "SELECT id FROM comics WHERE id=?1
                 UNION SELECT comic_id FROM comic_locations WHERE runtime_id=?1",
            )
            .map_err(|error| error.to_string())?
    };
    let rows = if let Some(source_id) = source_id {
        statement
            .query_map(params![identifier, source_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        statement
            .query_map([identifier], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    match rows.as_slice() {
        [] => Ok(None),
        [comic_id] => Ok(Some(comic_id.clone())),
        _ => Err(format!("漫畫進度識別碼不唯一，已拒絕寫入：{identifier}")),
    }
}

fn exact_progress_comic_id(
    connection: &Connection,
    identifier: &str,
    source_id: &str,
    relative_path: &str,
) -> Result<String, String> {
    let mut statement = connection
        .prepare(
            "SELECT comic_id FROM comic_locations WHERE source_id=?2 AND relative_path=?3
         AND (runtime_id=?1 OR comic_id=?1)",
        )
        .map_err(|error| error.to_string())?;
    let matches = statement
        .query_map(params![identifier, source_id, relative_path], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    match matches.as_slice() {
        [comic_id] => Ok(comic_id.clone()),
        [] => Err("來源漫畫位置已變更，已拒絕寫入進度".into()),
        _ => Err("來源漫畫位置不唯一，已拒絕寫入進度".into()),
    }
}

fn update_recovery_proof_baselines(
    connection: &Connection,
    comic_id: &str,
    progress: &crate::state::Progress,
    intent_sequence: u64,
) -> Result<(), String> {
    validate_intent_sequence(intent_sequence)?;
    connection.execute(
        "UPDATE progress_recovery_proofs SET baseline_page=?2,baseline_total=?3,baseline_updated_at=?4,intent_sequence=?5 WHERE comic_id=?1",
        params![comic_id,progress.current_page as i64,progress.total_pages as i64,progress.updated_at,intent_sequence as i64],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn persist_progress_write(
    tx: &Transaction<'_>,
    comic_id: &str,
    progress: &crate::state::Progress,
    intent_sequence: Option<u64>,
) -> Result<(), String> {
    if let Some(intent) = intent_sequence {
        validate_intent_sequence(intent)?;
        let fence: Option<i64> = tx
            .query_row(
                "SELECT intent_sequence FROM progress_intent_fences WHERE comic_id=?1",
                [comic_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if fence.is_some_and(|value| intent as i64 <= value) {
            return Err("閱讀意圖已過期，已保留較新的進度".into());
        }
        save_progress_row(tx, comic_id, progress)?;
        tx.execute("INSERT INTO progress_intent_fences(comic_id,intent_sequence) VALUES(?1,?2) ON CONFLICT(comic_id) DO UPDATE SET intent_sequence=excluded.intent_sequence", params![comic_id,intent as i64]).map_err(|error| error.to_string())?;
        update_recovery_proof_baselines(tx, comic_id, progress, intent)?;
    } else {
        // Legacy writes have no comparable intent order. Discard proofs in the
        // same transaction so a later recovery cannot mistake this write for its baseline.
        tx.execute(
            "DELETE FROM progress_recovery_proofs WHERE comic_id=?1",
            [comic_id],
        )
        .map_err(|error| error.to_string())?;
        save_progress_row(tx, comic_id, progress)?;
    }
    Ok(())
}

fn save_progress_row(
    connection: &Connection,
    comic_id: &str,
    progress: &crate::state::Progress,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO reading_progress(comic_id,current_page,total_pages,percent,updated_at)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(comic_id) DO UPDATE SET
               current_page=excluded.current_page,total_pages=excluded.total_pages,
               percent=excluded.percent,updated_at=excluded.updated_at",
            params![
                comic_id,
                progress.current_page as i64,
                progress.total_pages as i64,
                progress.percent,
                progress.updated_at
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn resolve_comic_id_tx(tx: &Transaction<'_>, identifier: &str) -> Result<String, String> {
    resolve_comic_id(tx, identifier)?.ok_or_else(|| format!("找不到漫畫：{identifier}"))
}

fn resolve_batch_target_tx(
    tx: &Transaction<'_>,
    target: &BatchEditTarget,
) -> Result<String, String> {
    if target.runtime_id.trim().is_empty()
        || target.source_id.trim().is_empty()
        || target.relative_path.trim().is_empty()
        || target.runtime_id.len() > 4096
        || target.source_id.len() > 4096
        || target.relative_path.len() > 4096
    {
        return Err("批次目標的 runtimeId、sourceId、relativePath 格式不正確".into());
    }
    let mut statement = tx
        .prepare(
            "SELECT DISTINCT comic_id
             FROM comic_locations
             WHERE runtime_id=?1 AND source_id=?2 AND relative_path=?3
             LIMIT 2",
        )
        .map_err(|error| error.to_string())?;
    let comic_ids = statement
        .query_map(
            params![target.runtime_id, target.source_id, target.relative_path],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    match comic_ids.as_slice() {
        [comic_id] => Ok(comic_id.clone()),
        [] => Err(format!(
            "找不到批次目標：{} / {} / {}",
            target.runtime_id, target.source_id, target.relative_path
        )),
        _ => Err(format!(
            "批次目標位置不唯一：{} / {} / {}",
            target.runtime_id, target.source_id, target.relative_path
        )),
    }
}

fn resolve_legacy_batch_id_tx(tx: &Transaction<'_>, identifier: &str) -> Result<String, String> {
    // Only a canonical comics.id is safe without source/path evidence. A
    // runtime-only identifier cannot distinguish an old forgotten source
    // from a newly visible work with the same runtime ID.
    let canonical: Option<String> = tx
        .query_row("SELECT id FROM comics WHERE id=?1", [identifier], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(canonical) = canonical else {
        return Err(format!(
            "舊版 id-only 批次目標缺少來源位置，請改用 targets：{identifier}"
        ));
    };
    let mut statement = tx
        .prepare("SELECT DISTINCT comic_id FROM comic_locations WHERE runtime_id=?1 LIMIT 2")
        .map_err(|error| error.to_string())?;
    let runtime_matches = statement
        .query_map([identifier], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if runtime_matches
        .iter()
        .any(|comic_id| comic_id != &canonical)
    {
        return Err(format!(
            "漫畫識別碼不唯一，已拒絕舊版 id-only 批次目標：{identifier}"
        ));
    }
    Ok(canonical)
}

#[derive(Debug, Clone)]
struct ReimportResolvedTarget {
    comic_id: String,
    path: String,
    identity: Option<BatchEditTarget>,
}

fn resolve_reimport_target_tx(
    tx: &Transaction<'_>,
    target: &BatchEditTarget,
) -> Result<ReimportResolvedTarget, String> {
    let comic_id = resolve_batch_target_tx(tx, target)?;
    let path: Option<String> = tx
        .query_row(
            "SELECT actual_path
             FROM comic_locations
             WHERE comic_id=?1 AND runtime_id=?2 AND source_id=?3
               AND relative_path=?4 AND online=1 AND actual_path IS NOT NULL
             LIMIT 1",
            params![
                comic_id,
                target.runtime_id,
                target.source_id,
                target.relative_path
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(path) = path else {
        return Err(format!(
            "批次重匯目標已離線或缺少實際路徑：{} / {} / {}",
            target.runtime_id, target.source_id, target.relative_path
        ));
    };
    Ok(ReimportResolvedTarget {
        comic_id,
        path,
        identity: Some(target.clone()),
    })
}

fn ensure_tag(connection: &Connection, tag: &ScopedTag) -> Result<i64, String> {
    let namespace = normalize_tag_key(&tag.namespace);
    let value = tag.value.trim();
    if namespace.is_empty() || value.is_empty() {
        return Err("標籤 namespace 與內容不可為空".into());
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO tags(namespace,value,normalized_value) VALUES(?1,?2,?3)",
            params![namespace, value, normalize_tag_key(value)],
        )
        .map_err(|error| error.to_string())?;
    let raw_id: i64 = connection
        .query_row(
            "SELECT id FROM tags WHERE namespace=?1 AND normalized_value=?2",
            params![namespace, normalize_tag_key(value)],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let existing_canonical: Option<i64> = connection
        .query_row(
            "SELECT canonical_tag_id FROM tags WHERE id=?1",
            [raw_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if existing_canonical.is_some() {
        return Ok(raw_id);
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO canonical_tags(namespace,normalized_value,display_value) VALUES(?1,?2,?3)",
            params![namespace, normalize_tag_key(value), value],
        )
        .map_err(|error| error.to_string())?;
    let canonical_id: i64 = connection
        .query_row(
            "SELECT id FROM canonical_tags WHERE namespace=?1 AND normalized_value=?2",
            params![namespace, normalize_tag_key(value)],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "UPDATE tags SET canonical_tag_id=?2 WHERE id=?1 AND canonical_tag_id IS NULL",
            params![raw_id, canonical_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(raw_id)
}
fn ensure_tag_tx(tx: &Transaction<'_>, tag: &ScopedTag) -> Result<i64, String> {
    ensure_tag(tx, tag)
}
fn set_tag_override(
    tx: &Transaction<'_>,
    comic_id: &str,
    tag: &ScopedTag,
    action: &str,
) -> Result<i64, String> {
    let tag_id = ensure_tag_tx(tx, tag)?;
    tx.execute("INSERT INTO comic_tag_overrides(comic_id,tag_id,action) VALUES(?1,?2,?3) ON CONFLICT(comic_id,tag_id) DO UPDATE SET action=excluded.action", params![comic_id, tag_id, action]).map_err(|error| error.to_string())?;
    Ok(tag_id)
}

fn mark_tag_used(connection: &Connection, raw_tag_id: i64) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO tag_user_state(tag_id,usage_count,last_used_at)
             SELECT canonical_tag_id,1,CURRENT_TIMESTAMP FROM tags WHERE id=?1
             ON CONFLICT(tag_id) DO UPDATE SET
               usage_count=tag_user_state.usage_count+1,last_used_at=CURRENT_TIMESTAMP",
            [raw_tag_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn snapshot_overrides(tx: &Transaction<'_>, comic_ids: &BTreeSet<String>) -> Result<Value, String> {
    let mut snapshot = serde_json::Map::new();
    for comic_id in comic_ids {
        let mut fields = serde_json::Map::new();
        let mut statement = tx
            .prepare("SELECT field_key,value_json FROM user_field_overrides WHERE comic_id=?1")
            .map_err(|error| error.to_string())?;
        for row in statement
            .query_map([comic_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
        {
            let (field, value) = row.map_err(|error| error.to_string())?;
            fields.insert(field, Value::String(value));
        }
        let mut tags = Vec::new();
        let mut statement = tx
            .prepare("SELECT tag_id,action FROM comic_tag_overrides WHERE comic_id=?1")
            .map_err(|error| error.to_string())?;
        for row in statement
            .query_map([comic_id], |row| {
                Ok(json!({"tagId":row.get::<_,i64>(0)?,"action":row.get::<_,String>(1)?}))
            })
            .map_err(|error| error.to_string())?
        {
            tags.push(row.map_err(|error| error.to_string())?);
        }
        snapshot.insert(comic_id.clone(), json!({"fields":fields,"tags":tags}));
    }
    Ok(Value::Object(snapshot))
}

fn empty_override_snapshot() -> Value {
    json!({"fields": {}, "tags": []})
}

fn snapshot_tags(snapshot: &Value) -> BTreeMap<i64, String> {
    snapshot
        .get("tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some((
                item.get("tagId")?.as_i64()?,
                item.get("action")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

fn revert_override_delta(
    tx: &Transaction<'_>,
    comic_id: &str,
    before: &Value,
    after: &Value,
    current: &Value,
) -> Result<bool, String> {
    let empty_fields = serde_json::Map::new();
    let before_fields = before
        .get("fields")
        .and_then(Value::as_object)
        .unwrap_or(&empty_fields);
    let after_fields = after
        .get("fields")
        .and_then(Value::as_object)
        .unwrap_or(&empty_fields);
    let current_fields = current
        .get("fields")
        .and_then(Value::as_object)
        .unwrap_or(&empty_fields);
    let field_keys = before_fields
        .keys()
        .chain(after_fields.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut changed = false;
    for field in field_keys {
        let before_value = before_fields.get(&field);
        let after_value = after_fields.get(&field);
        if before_value == after_value || current_fields.get(&field) != after_value {
            continue;
        }
        match before_value.and_then(Value::as_str) {
            Some(value) => {
                tx.execute(
                    "INSERT INTO user_field_overrides(comic_id,field_key,value_json,updated_at) VALUES(?1,?2,?3,CURRENT_TIMESTAMP) ON CONFLICT(comic_id,field_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP",
                    params![comic_id, field, value],
                )
                .map_err(|error| error.to_string())?;
            }
            None => {
                tx.execute(
                    "DELETE FROM user_field_overrides WHERE comic_id=?1 AND field_key=?2",
                    params![comic_id, field],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        changed = true;
    }

    let before_tags = snapshot_tags(before);
    let after_tags = snapshot_tags(after);
    let current_tags = snapshot_tags(current);
    let tag_ids = before_tags
        .keys()
        .chain(after_tags.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    for tag_id in tag_ids {
        let before_action = before_tags.get(&tag_id);
        let after_action = after_tags.get(&tag_id);
        if before_action == after_action || current_tags.get(&tag_id) != after_action {
            continue;
        }
        match before_action {
            Some(action) => {
                tx.execute(
                    "INSERT INTO comic_tag_overrides(comic_id,tag_id,action) VALUES(?1,?2,?3) ON CONFLICT(comic_id,tag_id) DO UPDATE SET action=excluded.action",
                    params![comic_id, tag_id, action],
                )
                .map_err(|error| error.to_string())?;
            }
            None => {
                tx.execute(
                    "DELETE FROM comic_tag_overrides WHERE comic_id=?1 AND tag_id=?2",
                    params![comic_id, tag_id],
                )
                .map_err(|error| error.to_string())?;
            }
        }
        changed = true;
    }
    Ok(changed)
}

fn load_diagnostics(
    connection: &Connection,
    comic_id: Option<&str>,
    limit: usize,
) -> Result<Vec<ImportDiagnostic>, String> {
    let sql = if comic_id.is_some() {
        "SELECT id,comic_id,parser_id,source_path,severity,message,created_at FROM import_diagnostics WHERE comic_id=?1 ORDER BY id DESC LIMIT ?2"
    } else {
        "SELECT id,comic_id,parser_id,source_path,severity,message,created_at FROM import_diagnostics ORDER BY id DESC LIMIT ?1"
    };
    let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
    let map_row = |row: &rusqlite::Row<'_>| {
        Ok(ImportDiagnostic {
            id: row.get(0)?,
            comic_id: row.get(1)?,
            parser_id: row.get(2)?,
            source_path: row.get(3)?,
            severity: row.get(4)?,
            message: row.get(5)?,
            created_at: row.get(6)?,
        })
    };
    let rows = if let Some(comic_id) = comic_id {
        statement.query_map(params![comic_id, limit as i64], map_row)
    } else {
        statement.query_map(params![limit as i64], map_row)
    }
    .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_organizer_inbox(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<OrganizerInboxItem>, String> {
    let mut statement = connection.prepare(
        "SELECT c.id,c.title,s.parser_id,s.source_path,s.confidence,'metadata 信心低於 0.75' AS reason
         FROM metadata_sources s JOIN comics c ON c.id=s.comic_id WHERE s.confidence < 0.75
         UNION ALL
         SELECT c.id,c.title,d.parser_id,d.source_path,NULL,d.message
         FROM import_diagnostics d JOIN comics c ON c.id=d.comic_id
         ORDER BY title LIMIT ?1"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([limit as i64], |row| {
            Ok(OrganizerInboxItem {
                comic_id: row.get(0)?,
                title: row.get(1)?,
                parser_id: row.get(2)?,
                source_path: row.get(3)?,
                confidence: row.get(4)?,
                reason: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn load_duplicate_candidates(
    connection: &Connection,
    limit: usize,
) -> Result<Vec<DuplicateCandidate>, String> {
    let mut groups = connection.prepare(
        "SELECT fingerprint FROM comic_locations WHERE fingerprint IS NOT NULL GROUP BY fingerprint HAVING COUNT(DISTINCT comic_id) > 1 ORDER BY MAX(last_seen_at) DESC LIMIT ?1"
    ).map_err(|error| error.to_string())?;
    let fingerprints = groups
        .query_map([limit as i64], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut result = Vec::new();
    for fingerprint in fingerprints {
        let mut rows = connection.prepare("SELECT comic_id,source_id || ':' || relative_path FROM comic_locations WHERE fingerprint=?1 ORDER BY online DESC,last_seen_at DESC").map_err(|error| error.to_string())?;
        let entries = rows
            .query_map([&fingerprint], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        result.push(DuplicateCandidate {
            fingerprint,
            comic_ids: entries
                .iter()
                .map(|entry| entry.0.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            locations: entries.into_iter().map(|entry| entry.1).collect(),
        });
    }
    Ok(result)
}

fn load_related_tags(
    connection: &Connection,
    comic_id: &str,
    limit: usize,
) -> Result<Vec<TagSuggestion>, String> {
    let mut statement = connection.prepare(
        "SELECT t.namespace,t.value,COUNT(DISTINCT peer.comic_id) AS shared
         FROM comic_tag_candidates base
         JOIN comic_tag_candidates peer ON peer.tag_id=base.tag_id AND peer.comic_id<>base.comic_id
         JOIN comic_tag_candidates suggested ON suggested.comic_id=peer.comic_id
         JOIN tags t ON t.id=suggested.tag_id
         WHERE base.comic_id=?1
           AND suggested.tag_id NOT IN (SELECT tag_id FROM comic_tag_candidates WHERE comic_id=?1)
           AND suggested.tag_id NOT IN (SELECT tag_id FROM comic_tag_overrides WHERE comic_id=?1 AND action='exclude')
         GROUP BY suggested.tag_id,t.namespace,t.value
         ORDER BY shared DESC,t.namespace,t.value LIMIT ?2"
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![comic_id, limit as i64], |row| {
            let shared = row.get::<_, i64>(2)? as usize;
            Ok(TagSuggestion {
                tag: ScopedTag {
                    namespace: row.get(0)?,
                    value: row.get(1)?,
                },
                shared_comics: shared,
                reason: format!("與目前標籤共同出現在 {shared} 本漫畫"),
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn parse_exchange(payload: &str) -> Result<CatalogExchange, String> {
    if payload.len() > 32 * 1024 * 1024 {
        return Err("metadata 交換檔超過 32 MiB 安全上限".into());
    }
    let envelope: CatalogExchange =
        serde_json::from_str(payload).map_err(|error| format!("交換檔 JSON 無效：{error}"))?;
    if envelope.schema_version != 1 {
        return Err(format!(
            "不支援的 metadata 交換版本：{}",
            envelope.schema_version
        ));
    }
    if envelope.comics.len() > 100_000 {
        return Err("metadata 交換檔超過 100,000 本安全上限".into());
    }
    for comic in &envelope.comics {
        for field in comic.field_overrides.keys() {
            if !allowed_user_field(field) {
                return Err(format!("交換檔包含不支援欄位：{field}"));
            }
        }
        for (field, value) in &comic.field_overrides {
            validate_exchange_field_value(field, value)?;
        }
        for tag in &comic.tag_overrides {
            if !matches!(tag.action.as_str(), "include" | "exclude") {
                return Err(format!("交換檔包含不支援 tag 動作：{}", tag.action));
            }
        }
    }
    Ok(envelope)
}

fn validate_exchange_field_value(field: &str, value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    if field == "creators" {
        serde_json::from_value::<BTreeMap<String, Vec<String>>>(value.clone())
            .map(|_| ())
            .map_err(|error| format!("交換檔 creators 欄位格式錯誤：{error}"))
    } else if value.is_string() {
        Ok(())
    } else {
        Err(format!("交換檔欄位 {field} 必須是字串或 null"))
    }
}

fn load_exchange(connection: &Connection) -> Result<CatalogExchange, String> {
    let mut ids = connection
        .prepare(
            "SELECT id FROM comics WHERE EXISTS(SELECT 1 FROM user_field_overrides u WHERE u.comic_id=comics.id) OR EXISTS(SELECT 1 FROM comic_tag_overrides o WHERE o.comic_id=comics.id) ORDER BY id",
        )
        .map_err(|error| error.to_string())?;
    let comic_ids = ids
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut comics = Vec::with_capacity(comic_ids.len());
    for comic_id in comic_ids {
        let fingerprint = connection
            .query_row(
                "SELECT fingerprint FROM comic_locations WHERE comic_id=?1 AND fingerprint IS NOT NULL ORDER BY online DESC,last_seen_at DESC LIMIT 1",
                [&comic_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let field_overrides = load_field_overrides(connection, &comic_id)?;
        let tag_overrides = load_exchange_tag_overrides(connection, &comic_id)?;
        comics.push(ExchangeComic {
            comic_id,
            fingerprint,
            field_overrides,
            tag_overrides,
        });
    }
    Ok(CatalogExchange {
        schema_version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        comics,
    })
}

fn load_field_overrides(
    connection: &Connection,
    comic_id: &str,
) -> Result<BTreeMap<String, Value>, String> {
    let mut statement = connection
        .prepare("SELECT field_key,value_json FROM user_field_overrides WHERE comic_id=?1 ORDER BY field_key")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([comic_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut fields = BTreeMap::new();
    for row in rows {
        let (field, raw) = row.map_err(|error| error.to_string())?;
        fields.insert(field, serde_json::from_str(&raw).unwrap_or(Value::Null));
    }
    Ok(fields)
}

fn load_exchange_tag_overrides(
    connection: &Connection,
    comic_id: &str,
) -> Result<Vec<ExchangeTagOverride>, String> {
    let mut statement = connection
        .prepare("SELECT t.namespace,t.value,o.action FROM comic_tag_overrides o JOIN tags t ON t.id=o.tag_id WHERE o.comic_id=?1 ORDER BY t.namespace,t.normalized_value")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([comic_id], |row| {
            Ok(ExchangeTagOverride {
                tag: ScopedTag {
                    namespace: row.get(0)?,
                    value: row.get(1)?,
                },
                action: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn match_exchange_comic(
    connection: &Connection,
    comic: &ExchangeComic,
) -> Result<Option<String>, String> {
    if connection
        .query_row(
            "SELECT id FROM comics WHERE id=?1",
            [&comic.comic_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(Some(comic.comic_id.clone()));
    }
    let Some(fingerprint) = comic.fingerprint.as_deref() else {
        return Ok(None);
    };
    let mut statement = connection
        .prepare("SELECT DISTINCT comic_id FROM comic_locations WHERE fingerprint=?1 ORDER BY comic_id LIMIT 2")
        .map_err(|error| error.to_string())?;
    let matches = statement
        .query_map([fingerprint], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok((matches.len() == 1).then(|| matches[0].clone()))
}

fn conflict_key(comic_id: &str, field: &str) -> String {
    format!("{comic_id}:{field}")
}

fn preview_exchange(
    connection: &Connection,
    envelope: &CatalogExchange,
) -> Result<CatalogImportPreview, String> {
    let mut preview = CatalogImportPreview {
        matched: 0,
        unmatched: Vec::new(),
        conflicts: Vec::new(),
    };
    for incoming in &envelope.comics {
        let Some(comic_id) = match_exchange_comic(connection, incoming)? else {
            preview.unmatched.push(incoming.comic_id.clone());
            continue;
        };
        preview.matched += 1;
        let local_fields = load_field_overrides(connection, &comic_id)?;
        for (field, incoming_value) in &incoming.field_overrides {
            if let Some(local_value) = local_fields
                .get(field)
                .filter(|value| *value != incoming_value)
            {
                preview.conflicts.push(CatalogImportConflict {
                    key: conflict_key(&comic_id, &format!("field:{field}")),
                    comic_id: comic_id.clone(),
                    field: field.clone(),
                    local_value: local_value.clone(),
                    incoming_value: incoming_value.clone(),
                });
            }
        }
        let local_tags = load_exchange_tag_overrides(connection, &comic_id)?
            .into_iter()
            .map(|item| ((item.tag.namespace, item.tag.value), item.action))
            .collect::<BTreeMap<_, _>>();
        for tag in &incoming.tag_overrides {
            if let Some(local_action) = local_tags
                .get(&(tag.tag.namespace.clone(), tag.tag.value.clone()))
                .filter(|action| *action != &tag.action)
            {
                let field = format!("tag:{}:{}", tag.tag.namespace, tag.tag.value);
                preview.conflicts.push(CatalogImportConflict {
                    key: conflict_key(&comic_id, &field),
                    comic_id: comic_id.clone(),
                    field,
                    local_value: Value::String(local_action.clone()),
                    incoming_value: Value::String(tag.action.clone()),
                });
            }
        }
    }
    Ok(preview)
}

fn apply_exchange(
    connection: &mut Connection,
    envelope: &CatalogExchange,
    resolutions: &BTreeMap<String, String>,
) -> Result<CatalogImportResult, String> {
    let matches = envelope
        .comics
        .iter()
        .map(|comic| Ok((comic, match_exchange_comic(connection, comic)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let comic_ids = matches
        .iter()
        .filter_map(|(_, id)| id.clone())
        .collect::<BTreeSet<_>>();
    if comic_ids.is_empty() {
        return Err("交換檔沒有可安全配對的漫畫".into());
    }
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let before = snapshot_overrides(&tx, &comic_ids)?;
    let mut skipped_conflicts = 0;
    for (incoming, comic_id) in matches {
        let Some(comic_id) = comic_id else {
            continue;
        };
        let local_fields = load_field_overrides(&tx, &comic_id)?;
        for (field, incoming_value) in &incoming.field_overrides {
            let conflict = local_fields
                .get(field)
                .is_some_and(|value| value != incoming_value);
            let key = conflict_key(&comic_id, &format!("field:{field}"));
            if conflict && resolutions.get(&key).map(String::as_str) != Some("useIncoming") {
                skipped_conflicts += 1;
                continue;
            }
            tx.execute(
                "INSERT INTO user_field_overrides(comic_id,field_key,value_json,updated_at) VALUES(?1,?2,?3,CURRENT_TIMESTAMP) ON CONFLICT(comic_id,field_key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP",
                params![comic_id, field, incoming_value.to_string()],
            ).map_err(|error| error.to_string())?;
        }
        let local_tags = load_exchange_tag_overrides(&tx, &comic_id)?
            .into_iter()
            .map(|item| ((item.tag.namespace, item.tag.value), item.action))
            .collect::<BTreeMap<_, _>>();
        for tag in &incoming.tag_overrides {
            let local = local_tags.get(&(tag.tag.namespace.clone(), tag.tag.value.clone()));
            let conflict = local.is_some_and(|action| action != &tag.action);
            let key = conflict_key(
                &comic_id,
                &format!("tag:{}:{}", tag.tag.namespace, tag.tag.value),
            );
            if conflict && resolutions.get(&key).map(String::as_str) != Some("useIncoming") {
                skipped_conflicts += 1;
                continue;
            }
            set_tag_override(&tx, &comic_id, &tag.tag, &tag.action)?;
        }
        resolve_effective_metadata(&tx, &comic_id)?;
        refresh_fts(&tx, &comic_id)?;
    }
    let after = snapshot_overrides(&tx, &comic_ids)?;
    let undo_token = uuid::Uuid::new_v4().to_string();
    let undo_snapshot = json!({"version": 2, "before": before, "after": after});
    tx.execute("INSERT INTO batch_operations(token,snapshot_json,created_at) VALUES(?1,?2,CURRENT_TIMESTAMP)", params![undo_token, undo_snapshot.to_string()]).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(CatalogImportResult {
        updated: comic_ids.len(),
        skipped_conflicts,
        undo_token,
    })
}

fn comic_ids_for_source(connection: &Connection, source_id: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT DISTINCT comic_id FROM comic_locations WHERE source_id=?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([source_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn allowed_user_field(field: &str) -> bool {
    matches!(
        field,
        "title"
            | "series"
            | "volume"
            | "number"
            | "summary"
            | "language"
            | "reading_direction"
            | "published_at"
            | "creators"
    )
}
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_matches('/').to_string()
}
fn path_is_within(path: &str, folder: &str) -> bool {
    let folder = normalize_path(folder);
    folder.is_empty() || path == folder || path.starts_with(&format!("{folder}/"))
}

pub(crate) fn sampled_fingerprint(path: &Path) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(FINGERPRINT_VERSION.as_bytes());
    if path.is_dir() {
        let mut pages = std::fs::read_dir(path)
            .map_err(|error| error.to_string())?
            .flatten()
            .filter(|entry| entry.path().is_file() && is_image(&entry.path()))
            .collect::<Vec<_>>();
        pages.sort_by_key(|entry| entry.file_name());
        for entry in &pages {
            hasher.update(entry.file_name().to_string_lossy().as_bytes());
            if let Ok(metadata) = entry.metadata() {
                hasher.update(&metadata.len().to_le_bytes());
            }
        }
        if let Some(first) = pages.first() {
            hash_prefix(&mut hasher, &first.path(), DIRECTORY_SAMPLE_BYTES)?;
        }
        if let Some(last) = pages
            .last()
            .filter(|last| pages.first().map(|first| first.path()) != Some(last.path()))
        {
            hash_prefix(&mut hasher, &last.path(), DIRECTORY_SAMPLE_BYTES)?;
        }
    } else {
        let file = File::open(path).map_err(|error| error.to_string())?;
        return sampled_fingerprint_from_open_file(file);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn sampled_fingerprint_from_open_file(mut file: File) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(FINGERPRINT_VERSION.as_bytes());
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    hasher.update(&len.to_le_bytes());
    let mut buffer = vec![0; ARCHIVE_SAMPLE_BYTES.min(len as usize)];
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    hasher.update(&buffer);
    if len as usize > ARCHIVE_SAMPLE_BYTES {
        file.seek(SeekFrom::End(
            -(ARCHIVE_SAMPLE_BYTES.min(len as usize) as i64),
        ))
        .map_err(|error| error.to_string())?;
        let mut tail = vec![0; ARCHIVE_SAMPLE_BYTES.min(len as usize)];
        file.read_exact(&mut tail)
            .map_err(|error| error.to_string())?;
        hasher.update(&tail);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

pub(crate) fn sampled_fingerprint_from_dir(
    parent: &cap_std::fs::Dir,
    name: &Path,
) -> Result<String, String> {
    let metadata = parent
        .symlink_metadata(name)
        .map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("檔案位置不可使用符號連結".into());
    }
    if !metadata.is_dir() {
        return sampled_fingerprint_from_open_file(
            parent
                .open(name)
                .map_err(|error| error.to_string())?
                .into_std(),
        );
    }
    let child_dir = parent
        .open_dir_nofollow(name)
        .map_err(|error| error.to_string())?;
    let mut pages = child_dir
        .entries()
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|file_type| file_type.is_file())
                && is_image(Path::new(&entry.file_name()))
        })
        .collect::<Vec<_>>();
    pages.sort_by_key(|entry| entry.file_name());

    let mut hasher = blake3::Hasher::new();
    hasher.update(FINGERPRINT_VERSION.as_bytes());
    for entry in &pages {
        hasher.update(entry.file_name().to_string_lossy().as_bytes());
        if let Ok(metadata) = entry.metadata() {
            hasher.update(&metadata.len().to_le_bytes());
        }
    }
    if let Some(first) = pages.first() {
        hash_prefix_open_file(
            &mut hasher,
            first.open().map_err(|error| error.to_string())?.into_std(),
            DIRECTORY_SAMPLE_BYTES,
        )?;
    }
    if let Some(last) = pages.last().filter(|last| {
        pages
            .first()
            .is_some_and(|first| first.file_name() != last.file_name())
    }) {
        hash_prefix_open_file(
            &mut hasher,
            last.open().map_err(|error| error.to_string())?.into_std(),
            DIRECTORY_SAMPLE_BYTES,
        )?;
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn hash_prefix_open_file(
    hasher: &mut blake3::Hasher,
    mut file: File,
    limit: usize,
) -> Result<(), String> {
    let mut buffer =
        vec![0; limit.min(file.metadata().map_err(|error| error.to_string())?.len() as usize)];
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    hasher.update(&buffer);
    Ok(())
}
fn hash_prefix(hasher: &mut blake3::Hasher, path: &Path, limit: usize) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut buffer =
        vec![0; limit.min(file.metadata().map_err(|error| error.to_string())?.len() as usize)];
    file.read_exact(&mut buffer)
        .map_err(|error| error.to_string())?;
    hasher.update(&buffer);
    Ok(())
}
fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|item| item.to_str())
        .is_some_and(|item| {
            matches!(
                item.to_ascii_lowercase().as_str(),
                "jpg" | "jpeg" | "png" | "gif" | "webp" | "avif"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Instant;

    thread_local! {
        static OPENED_LOCATION_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
            std::cell::RefCell::new(None);
        static SYNC_BATCH_READ_HOOK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
            std::cell::RefCell::new(None);
    }

    pub(super) fn run_opened_location_read_hook() {
        let hook = OPENED_LOCATION_READ_HOOK.with(|slot| slot.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
        }
    }

    pub(super) fn run_sync_batch_read_hook() {
        let hook = SYNC_BATCH_READ_HOOK.with(|slot| slot.borrow_mut().take());
        if let Some(hook) = hook {
            hook();
        }
    }

    #[cfg(unix)]
    #[test]
    fn local_operation_fingerprint_does_not_follow_root_symlink() {
        use std::os::unix::fs::symlink;

        let base =
            std::env::temp_dir().join(format!("comic_catalog_root_link_{}", uuid::Uuid::new_v4()));
        let target = base.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("book.cbz"), b"test archive bytes").unwrap();
        let root_link = base.join("library-link");
        symlink(&target, &root_link).unwrap();
        let expected = sampled_fingerprint(&target.join("book.cbz")).unwrap();
        let operation = |root: &Path| FileOperationRecord {
            id: "operation".into(),
            undo_token: "undo".into(),
            comic_id: "comic".into(),
            location_id: 1,
            action: "rename".into(),
            source_id: crate::scanner::local_source_id(root),
            before_relative_path: "book.cbz".into(),
            before_actual_path: Some(root.join("book.cbz").to_string_lossy().into_owned()),
            after_relative_path: None,
            after_actual_path: None,
            expected_fingerprint: Some(expected.clone()),
            status: "pending".into(),
            undo_pending: false,
        };

        assert!(local_operation_path_matches_fingerprint(
            &operation(&target),
            "book.cbz"
        ));
        assert!(!local_operation_path_matches_fingerprint(
            &operation(&root_link),
            "book.cbz"
        ));

        let _ = std::fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn pending_reconcile_rejects_replacement_bytes_and_retargeted_root_symlink() {
        use std::os::unix::fs::symlink;

        let store = store("pending_reconcile_exact_file");
        let base =
            std::env::temp_dir().join(format!("comic_pending_reconcile_{}", uuid::Uuid::new_v4()));
        let valid_root = base.join("valid-root");
        let replacement_root = base.join("replacement-root");
        let root_a = base.join("root-a");
        let root_b = base.join("root-b");
        std::fs::create_dir_all(&valid_root).unwrap();
        std::fs::create_dir_all(&replacement_root).unwrap();
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let root_link = base.join("library-link");
        symlink(&root_a, &root_link).unwrap();

        let valid_before = valid_root.join("book-valid.cbz");
        let replacement_before = replacement_root.join("book-replaced.cbz");
        let linked_before = root_a.join("book-linked.cbz");
        let expected_bytes = b"original archive bytes";
        std::fs::write(&valid_before, b"valid original archive bytes").unwrap();
        std::fs::write(&replacement_before, expected_bytes).unwrap();
        std::fs::write(&linked_before, b"linked original archive bytes").unwrap();

        let make_item = |runtime_id: &str, relative: &str, root: &Path, path: &Path| {
            let mut item = comic(runtime_id, relative);
            item.source_id = crate::scanner::local_source_id(root);
            item.source_path = Some(path.to_string_lossy().into_owned());
            item
        };
        store
            .sync_library(&[
                make_item(
                    "pending-valid",
                    "book-valid.cbz",
                    &valid_root,
                    &valid_before,
                ),
                make_item(
                    "pending-replaced",
                    "book-replaced.cbz",
                    &replacement_root,
                    &replacement_before,
                ),
                make_item(
                    "pending-linked",
                    "book-linked.cbz",
                    &root_link,
                    &root_link.join("book-linked.cbz"),
                ),
            ])
            .unwrap();

        let begin_pending =
            |runtime_id: &str, destination_relative: &str, destination_path: &Path| {
                let location = store.get_location(runtime_id).unwrap();
                let destination_path = destination_path.to_string_lossy().into_owned();
                let operation = store
                    .begin_file_operation(
                        &location,
                        "rename",
                        Some(destination_relative),
                        Some(&destination_path),
                    )
                    .unwrap();
                store
                    .set_file_operation_expected_fingerprint(
                        &operation.id,
                        location.fingerprint.as_deref().unwrap(),
                    )
                    .unwrap();
                operation
            };

        let valid_after = valid_root.join("moved-valid.cbz");
        let valid_operation = begin_pending("pending-valid", "moved-valid.cbz", &valid_after);
        std::fs::rename(&valid_before, &valid_after).unwrap();

        let replacement_after = replacement_root.join("moved-replaced.cbz");
        let replacement_operation =
            begin_pending("pending-replaced", "moved-replaced.cbz", &replacement_after);
        std::fs::rename(&replacement_before, &replacement_after).unwrap();
        // Same length but different bytes ensures the sampled fingerprint
        // rejects the replacement itself, rather than only a size mismatch.
        let replacement_bytes = b"replaced archive bytes";
        assert_eq!(expected_bytes.len(), replacement_bytes.len());
        std::fs::write(&replacement_after, replacement_bytes).unwrap();

        let linked_after = root_a.join("moved-linked.cbz");
        let linked_operation = begin_pending(
            "pending-linked",
            "moved-linked.cbz",
            &root_link.join("moved-linked.cbz"),
        );
        std::fs::rename(&linked_before, &linked_after).unwrap();
        std::fs::write(
            root_b.join("moved-linked.cbz"),
            b"linked original archive bytes",
        )
        .unwrap();
        std::fs::remove_file(&root_link).unwrap();
        symlink(&root_b, &root_link).unwrap();

        let reconciled = store.reconcile_file_operations().unwrap();
        assert_eq!(reconciled.completed, 1);
        assert_eq!(reconciled.needs_attention, 2);
        assert_eq!(
            store
                .file_operation_for_undo(&valid_operation.undo_token)
                .unwrap()
                .status,
            "succeeded"
        );
        for operation in [&replacement_operation, &linked_operation] {
            assert_eq!(
                store
                    .file_operation_for_undo(&operation.undo_token)
                    .unwrap()
                    .status,
                "needs_reconcile"
            );
        }
        assert_eq!(
            store
                .get_location(&valid_operation.comic_id)
                .unwrap()
                .relative_path,
            "moved-valid.cbz"
        );
        assert_eq!(
            store
                .get_location("pending-replaced")
                .unwrap()
                .relative_path,
            "book-replaced.cbz"
        );
        assert_eq!(
            store.get_location("pending-linked").unwrap().relative_path,
            "book-linked.cbz"
        );
        assert_eq!(std::fs::read(replacement_after).unwrap(), replacement_bytes);

        drop(store);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn location_kind_preserves_loose_image_runtime_types() {
        assert_eq!(
            runtime_type_for_location(true, "image", "local:library"),
            "external-image"
        );
        assert_eq!(
            runtime_type_for_location(true, "external-image", "external:bookmark"),
            "external-image"
        );
        assert_eq!(
            runtime_type_for_location(false, "image", "local:library"),
            "offline"
        );
    }

    fn store(name: &str) -> CatalogStore {
        let path = std::env::temp_dir().join(format!(
            "comic_catalog_{name}_{}_{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        CatalogStore::new(path).unwrap()
    }

    fn batch_target(store: &CatalogStore, runtime_id: &str) -> BatchEditTarget {
        let item = store
            .get_runtime_item(runtime_id)
            .unwrap()
            .expect("test runtime item exists");
        BatchEditTarget {
            runtime_id: item.id,
            source_id: item.source_id,
            relative_path: item.relative_path,
        }
    }

    fn comic(id: &str, path: &str) -> ComicItem {
        ComicItem {
            id: id.into(),
            r#type: "archive".into(),
            relative_path: path.into(),
            ext: ".zip".into(),
            title: "檔名標題".into(),
            series: "系列".into(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            page_count: 0,
            progress: crate::state::Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            },
            external_bookmark: None,
            source_id: "local".into(),
            source_path: None,
        }
    }

    #[test]
    fn reader_background_sync_finishes_and_restores_shelf_batches() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let store = store("reader_background_sync");
        let comics = (0..80)
            .map(|index| comic(&format!("reader-{index}"), &format!("book-{index}.cbz")))
            .collect::<Vec<_>>();
        let stage = AtomicUsize::new(0);
        let mut batches = Vec::new();
        store
            .sync_library_with_reader_priority(
                &comics,
                true,
                |done, _| {
                    batches.push(done);
                    if done == 8 {
                        stage.store(1, Ordering::Release);
                    }
                },
                || true,
                || {
                    if stage.load(Ordering::Acquire) == 0 {
                        ReaderPriority::Active
                    } else {
                        ReaderPriority::Idle
                    }
                },
            )
            .unwrap();
        assert_eq!(batches, vec![0, 8, 72, 80]);
        assert!(store.get_runtime_item("reader-79").unwrap().is_some());
        let mut done = Vec::new();
        store
            .sync_library_with_reader_priority(
                &comics[..17],
                true,
                |count, _| done.push(count),
                || true,
                || ReaderPriority::Active,
            )
            .unwrap();
        assert_eq!(done, vec![0, 8, 16, 17]);
    }

    #[test]
    fn active_metadata_gate_limits_shared_workers_to_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let gate = MetadataIoGate::new();
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let workers = (0..8)
            .map(|_| {
                let gate = Arc::clone(&gate);
                let active = Arc::clone(&active);
                let maximum = Arc::clone(&maximum);
                std::thread::spawn(move || {
                    let _permit =
                        acquire_active_metadata_permit(&gate, &|| true, &|| ReaderPriority::Active)
                            .unwrap()
                            .unwrap();
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(5));
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect::<Vec<_>>();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn real_metadata_sync_handles_idle_active_idle_transition() {
        use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};

        let store = store("real_metadata_reader_transition");
        let root =
            std::env::temp_dir().join(format!("comic_reader_metadata_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut comics = Vec::new();
        for index in 0..160 {
            let folder = root.join(format!("book-{index}"));
            std::fs::create_dir_all(&folder).unwrap();
            // Distinct image names make these distinct folder fingerprints;
            // metadata-only empty image folders intentionally deduplicate.
            std::fs::write(folder.join(format!("page-{index}.png")), [index as u8]).unwrap();
            std::fs::write(
                folder.join("ComicInfo.xml"),
                format!(
                    "<ComicInfo><Title>實檔 metadata {index}</Title><Summary>{}</Summary></ComicInfo>",
                    "內容".repeat(4096)
                ),
            )
            .unwrap();
            let mut item = comic(&format!("real-reader-{index}"), &format!("book-{index}"));
            item.r#type = "folder".into();
            item.source_path = Some(folder.to_string_lossy().into_owned());
            comics.push(item);
        }

        let stage = Arc::new(AtomicU8::new(0));
        let active_seen = Arc::new(AtomicBool::new(false));
        let priority_calls = AtomicUsize::new(0);
        let progress_stage = Arc::clone(&stage);
        let priority_stage = Arc::clone(&stage);
        let priority_seen = Arc::clone(&active_seen);
        let imported = store
            .sync_library_with_reader_priority(
                &comics,
                false,
                move |done, _| {
                    // An Active 8-item batch has completed; return to Idle so
                    // the remaining real-file metadata work can use the pool.
                    if done >= 72 {
                        progress_stage.store(2, Ordering::Release);
                    }
                },
                || true,
                || {
                    let call = priority_calls.fetch_add(1, Ordering::SeqCst);
                    let state_at_entry = priority_stage.load(Ordering::Acquire);
                    // The initial wait sees Idle; the batch-size decision also
                    // sees Idle, then flips priority before any of that 64-item
                    // batch begins metadata work.
                    if call == 1 {
                        priority_stage.store(1, Ordering::Release);
                    }
                    match state_at_entry {
                        1 => {
                            priority_seen.store(true, Ordering::Release);
                            ReaderPriority::Active
                        }
                        _ => ReaderPriority::Idle,
                    }
                },
            )
            .unwrap();

        assert_eq!(imported, 160);
        assert!(active_seen.load(Ordering::Acquire));
        assert_eq!(
            store.get_metadata("real-reader-0").unwrap().title,
            "實檔 metadata 0"
        );
        assert_eq!(
            store.get_metadata("real-reader-159").unwrap().title,
            "實檔 metadata 159"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    fn discovery_comics(count: usize, source_id: &str) -> Vec<ComicItem> {
        (0..count)
            .map(|index| {
                let mut item = comic(&format!("runtime-{index}"), &format!("資料夾/{index}.cbz"));
                item.source_id = source_id.into();
                item.source_path = Some(format!(
                    "/private/var/mobile/Containers/Data/Application/不存在/{index}.cbz"
                ));
                item
            })
            .collect()
    }

    #[test]
    fn resolve_comic_id_rejects_multiple_comic_ids_but_accepts_locations_of_one() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE comics(id TEXT PRIMARY KEY);
                 CREATE TABLE comic_locations(comic_id TEXT NOT NULL, runtime_id TEXT NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO comics(id) VALUES (?1), (?2)",
                ["comic-a", "comic-b"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO comic_locations(comic_id,runtime_id) VALUES (?1,?3), (?2,?3)",
                rusqlite::params!["comic-a", "comic-b", "shared-runtime"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO comic_locations(comic_id,runtime_id) VALUES (?1,?2)",
                ["comic-a", "shared-runtime"],
            )
            .unwrap();

        let error = resolve_comic_id(&connection, "shared-runtime").unwrap_err();
        assert!(error.contains("不唯一"));

        connection
            .execute("DELETE FROM comic_locations WHERE comic_id=?1", ["comic-b"])
            .unwrap();
        assert_eq!(
            resolve_comic_id(&connection, "shared-runtime").unwrap(),
            Some("comic-a".into())
        );
    }

    #[test]
    fn sync_batches_commit_before_later_progress_and_retire_removed_locations_at_end() {
        let store = store("sync_batches");
        let comics = discovery_comics(130, "external:files");
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed_for_progress = observed.clone();
        let observer_store = store.clone();
        let imported = store
            .sync_library_with_progress(
                &comics,
                true,
                move |done, total| {
                    let online = observer_store
                        .with_connection(|connection| {
                            connection
                                .query_row(
                                    "SELECT COUNT(*) FROM comic_locations WHERE online=1",
                                    [],
                                    |row| row.get::<_, i64>(0),
                                )
                                .map_err(|error| error.to_string())
                        })
                        .unwrap();
                    observed_for_progress
                        .lock()
                        .unwrap()
                        .push((done, total, online));
                },
                || true,
            )
            .unwrap();
        assert_eq!(imported, 130);
        assert_eq!(
            *observed.lock().unwrap(),
            vec![(0, 130, 0), (64, 130, 64), (128, 130, 128), (130, 130, 130)]
        );

        let mut retained = comics[0].clone();
        retained.title = "更新後標題".into();
        store
            .sync_library_with_progress(&[retained], true, |_, _| {}, || true)
            .unwrap();
        store
            .with_connection(|connection| {
                let online: i64 = connection
                    .query_row(
                        "SELECT online FROM comic_locations WHERE relative_path='資料夾/0.cbz'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let retired: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM comic_locations WHERE source_id='external:files' AND online=0",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(online, 1);
                assert_eq!(retired, 129);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn sync_cancellation_keeps_previous_online_locations() {
        let store = store("sync_cancel_keeps_online");
        let old = discovery_comics(1, "external:files");
        store
            .sync_library_with_progress(&old, true, |_, _| {}, || true)
            .unwrap();
        let mut incoming = discovery_comics(65, "external:files");
        incoming[0].relative_path = "新的一本.cbz".into();
        let current = Arc::new(AtomicBool::new(true));
        let current_for_progress = current.clone();
        let error = store
            .sync_library_with_progress(
                &incoming,
                true,
                move |done, _| {
                    if done == 64 {
                        current_for_progress.store(false, Ordering::Release);
                    }
                },
                move || current.load(Ordering::Acquire),
            )
            .unwrap_err();
        assert!(error.contains("目錄同步已取消"));
        store
            .with_connection(|connection| {
                let old_online: i64 = connection
                    .query_row(
                        "SELECT online FROM comic_locations WHERE relative_path='資料夾/0.cbz'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let online_count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM comic_locations WHERE online=1",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(old_online, 1);
                assert_eq!(online_count, 1 + 64);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn intermediate_batch_reactivates_offline_comic_for_catalog_readers() {
        let store = store("sync_batch_reactivates_offline");
        let mut old = discovery_comics(1, "external:files").remove(0);
        old.source_path = None;
        store.sync_library(&[old.clone()]).unwrap();
        let comic_id = store.get_metadata("runtime-0").unwrap().comic_id;
        store.mark_source_offline("external:files").unwrap();
        assert!(store.get_metadata(&comic_id).unwrap().offline);

        let incoming = discovery_comics(65, "external:files");
        let seen_online = Arc::new(std::sync::Mutex::new(false));
        let seen_online_for_progress = seen_online.clone();
        let observer_store = store.clone();
        store
            .sync_library_with_progress(
                &incoming,
                true,
                move |done, _| {
                    if done == 64 {
                        *seen_online_for_progress.lock().unwrap() =
                            !observer_store.get_metadata(&comic_id).unwrap().offline;
                    }
                },
                || true,
            )
            .unwrap();
        assert!(*seen_online.lock().unwrap());
    }

    #[test]
    fn discovery_external_folder_keeps_dots_in_title() {
        let store = store("external_folder_dots");
        let mut comics = discovery_comics(1, "external:files");
        comics[0].r#type = "external-folder".into();
        comics[0].relative_path = "series/Volume.2".into();
        store
            .sync_library_with_progress(&comics, true, |_, _| {}, || true)
            .unwrap();
        let title: String = store
            .with_connection(|connection| {
                connection
                    .query_row("SELECT title FROM comics", [], |row| row.get(0))
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(title, "Volume.2");
    }

    #[test]
    fn discovery_only_preserves_id_metadata_progress_and_signatures_without_filesystem_probe() {
        let store = store("discovery_only_preserves");
        let mut initial = comic("runtime-old", "特殊路徑/同一本.cbz");
        initial.source_id = "external:files".into();
        store.sync_library(&[initial]).unwrap();
        let stable_id = store.get_metadata("runtime-old").unwrap().comic_id;
        store
            .save_progress(
                &stable_id,
                &crate::state::Progress {
                    current_page: 7,
                    total_pages: 20,
                    percent: 35.0,
                    updated_at: Some("2026-09-01T00:00:00Z".into()),
                },
            )
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec![stable_id.clone()],
                targets: vec![],
                fields: BTreeMap::from([(String::from("title"), Some(String::from("手動標題")))]),
                ..Default::default()
            })
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET size=321,mtime='old-mtime',fingerprint='old-fingerprint',fingerprint_version='legacy' WHERE comic_id=?1",
                        [&stable_id],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let mut discovered = comic("runtime-new", "特殊路徑/同一本.cbz");
        discovered.source_id = "external:files".into();
        discovered.source_path = Some("/這個路徑不應被碰.cbz".into());
        discovered.title = "外部掃描暫時標題".into();
        store
            .sync_library_with_progress(&[discovered], true, |_, _| {}, || true)
            .unwrap();

        let metadata = store.get_metadata("runtime-new").unwrap();
        assert_eq!(metadata.comic_id, stable_id);
        assert_eq!(metadata.title, "手動標題");
        assert_eq!(
            metadata.relative_path.as_deref(),
            Some("特殊路徑/同一本.cbz")
        );
        let loaded = store.get_runtime_item("runtime-new").unwrap().unwrap();
        assert_eq!(loaded.progress.current_page, 7);
        store
            .with_connection(|connection| {
                let signature: (i64, String, String, String) = connection
                    .query_row(
                        "SELECT size,mtime,fingerprint,fingerprint_version FROM comic_locations WHERE comic_id=?1",
                        [&stable_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(signature, (321, "old-mtime".into(), "old-fingerprint".into(), "legacy".into()));
                let imported_sources: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM metadata_sources WHERE comic_id=?1",
                        [&stable_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(imported_sources, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn source_aware_progress_keeps_same_runtime_id_isolated() {
        let store = store("source_aware_progress");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-a','A'),('comic-b','B');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind)
                         VALUES('comic-a','same-runtime','local:root-a','a.cbz','archive'),
                               ('comic-b','same-runtime','local:root-b','b.cbz','archive');",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let progress = crate::state::Progress {
            current_page: 7,
            total_pages: 20,
            percent: 35.0,
            updated_at: Some("2026-09-01T00:00:00Z".into()),
        };
        store
            .save_progress_for_source("same-runtime", "local:root-b", &progress)
            .unwrap();

        store
            .with_connection(|connection| {
                let saved: (i64, i64) = connection
                    .query_row(
                        "SELECT current_page,total_pages FROM reading_progress WHERE comic_id='comic-b'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(saved, (7, 20));
                let comic_a_progress: Option<i64> = connection
                    .query_row(
                        "SELECT current_page FROM reading_progress WHERE comic_id='comic-a'",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                assert!(comic_a_progress.is_none());
                Ok(())
            })
            .unwrap();

        assert!(store
            .save_progress_for_source("same-runtime", "local:missing", &progress)
            .is_err());
    }

    #[test]
    fn location_scoped_progress_rejects_path_replaced_after_catalog_lookup() {
        let store = store("location_scoped_progress");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-a','A');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind)
                         VALUES('comic-a','runtime-a','local:root','old/book.cbz','archive');",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let progress = crate::state::Progress {
            current_page: 2,
            total_pages: 8,
            percent: 37.5,
            updated_at: Some("2026-11-08T00:00:00Z".into()),
        };
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET relative_path='new/book.cbz' WHERE runtime_id='runtime-a'",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(
            store
                .save_progress_for_source_location(
                    "runtime-a",
                    "local:root",
                    "old/book.cbz",
                    &progress,
                )
                .is_err()
        );
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-b','B');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind)
                         VALUES('comic-b','runtime-a','local:root','another/book.cbz','archive');",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(store
            .save_progress_for_source_location("runtime-a", "local:root", "new/book.cbz", &progress)
            .is_err());
        store
            .with_connection(|connection| {
                connection
                    .execute("DELETE FROM comic_locations WHERE comic_id='comic-b'", [])
                    .map_err(|error| error.to_string())?;
                connection
                    .execute("DELETE FROM comics WHERE id='comic-b'", [])
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        store
            .save_progress_for_source_location("runtime-a", "local:root", "new/book.cbz", &progress)
            .unwrap();
        let saved = store
            .get_runtime_item_for_source("runtime-a", "local:root")
            .unwrap()
            .unwrap();
        assert_eq!(saved.relative_path, "new/book.cbz");
        assert_eq!(saved.progress.current_page, 2);
    }

    #[test]
    fn legacy_progress_rejects_ambiguous_runtime_id() {
        let store = store("legacy_progress_ambiguous");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-a','A'),('comic-b','B');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind)
                         VALUES('comic-a','same-runtime','local:root-a','a.cbz','archive'),
                               ('comic-b','same-runtime','local:root-b','b.cbz','archive');",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let error = store
            .save_progress(
                "same-runtime",
                &crate::state::Progress {
                    current_page: 1,
                    total_pages: 2,
                    percent: 50.0,
                    updated_at: None,
                },
            )
            .unwrap_err();
        assert!(error.contains("不唯一") || error.contains("ambiguous"));
    }

    #[test]
    #[ignore = "5620 本 discovery-only 回歸基準，主代理指定時執行"]
    fn discovery_only_5620_books_reports_batches_and_elapsed_time() {
        let store = store("discovery_only_5620");
        let comics = discovery_comics(5620, "external:files");
        let started = Instant::now();
        let callbacks = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callbacks_for_progress = callbacks.clone();
        let observer_store = store.clone();
        store
            .sync_library_with_progress(
                &comics,
                true,
                move |done, total| {
                    let online = observer_store
                        .with_connection(|connection| {
                            connection
                                .query_row(
                                    "SELECT COUNT(*) FROM comic_locations WHERE online=1",
                                    [],
                                    |row| row.get::<_, i64>(0),
                                )
                                .map_err(|error| error.to_string())
                        })
                        .unwrap();
                    callbacks_for_progress
                        .lock()
                        .unwrap()
                        .push((done, total, online));
                },
                || true,
            )
            .unwrap();
        let callbacks = callbacks.lock().unwrap();
        assert_eq!(callbacks.last().copied(), Some((5620, 5620, 5620)));
        assert_eq!(callbacks.len(), 1 + 5620usize.div_ceil(64));
        println!(
            "discovery-only 5620 elapsed: {:?}, callbacks: {}",
            started.elapsed(),
            callbacks.len()
        );
    }

    #[test]
    fn location_revision_is_explicitly_metadata_only_and_requires_size_and_mtime() {
        let revision = location_revision(
            "smb",
            "folder/book.cbz",
            Some(123),
            Some("2026-09-01T00:00:00Z"),
        )
        .unwrap();
        assert!(revision.starts_with("location-revision-v1:"));
        assert!(revision.contains("\"size\":123"));
        assert!(location_revision("smb", "book.cbz", None, Some("mtime")).is_none());
        assert!(location_revision("smb", "book.cbz", Some(123), None).is_none());
    }

    #[test]
    fn migrations_are_idempotent_and_offline_rows_survive() {
        let store = store("migration");
        store.sync_library(&[comic("runtime", "a.zip")]).unwrap();
        CatalogStore::new(store.path().to_path_buf()).unwrap();
        store
            .with_connection(|connection| {
                let versions = connection
                    .prepare("SELECT version FROM schema_migrations ORDER BY version")
                    .map_err(|error| error.to_string())?
                    .query_map([], |row| row.get::<_, i64>(0))
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                assert_eq!(versions, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
                assert_eq!(
                    connection
                        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                        .map_err(|error| error.to_string())?,
                    12
                );
                let fts_sql: String = connection
                    .query_row(
                        "SELECT sql FROM sqlite_master WHERE type='table' AND name='catalog_fts'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert!(fts_sql.contains("trigram"), "{fts_sql}");
                let mut query = connection
                    .prepare(
                        "EXPLAIN QUERY PLAN SELECT id,comic_id,parser_id,source_path,severity,message,created_at
                         FROM import_diagnostics WHERE comic_id='runtime' ORDER BY id DESC LIMIT 100",
                    )
                    .map_err(|error| error.to_string())?;
                let details = query
                    .query_map([], |row| row.get::<_, String>(3))
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                assert!(
                    details.iter().any(|detail| detail
                        .contains("idx_import_diagnostics_comic_id")),
                    "{details:?}"
                );
                let mut short_query = connection
                    .prepare(
                        "EXPLAIN QUERY PLAN SELECT DISTINCT base.comic_id
                         FROM catalog_short_ngrams base
                         WHERE base.gram IN ('g2006f2b00756b')",
                    )
                    .map_err(|error| error.to_string())?;
                let short_details = short_query
                    .query_map([], |row| row.get::<_, String>(3))
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                assert!(
                    short_details
                        .iter()
                        .any(|detail| detail.contains("idx_catalog_short_ngrams_gram")),
                    "{short_details:?}"
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(store.mark_source_offline("local").unwrap(), 1);
        let view = store.get_metadata("runtime").unwrap();
        assert!(view.offline);
        assert_eq!(view.title, "a");
    }

    #[test]
    fn reading_history_is_idempotent_grouped_by_local_day_and_source() {
        let store = store("reading_history");
        let snapshot = ReadingHistoryComic {
            id: "runtime-book".into(),
            source_id: "local:root".into(),
            relative_path: "series/book.cbz".into(),
            title: "Book".into(),
            page_count: 12,
            progress: crate::state::Progress {
                current_page: 3,
                total_pages: 12,
                percent: 25.0,
                updated_at: Some("2020-01-01T00:00:00Z".into()),
            },
            offline: false,
        };
        assert!(store
            .record_reading_history("session-1", &snapshot, "2020-01-01T16:30:00Z")
            .unwrap());
        assert!(!store
            .record_reading_history("session-1", &snapshot, "2020-01-01T16:30:01Z")
            .unwrap());
        let mut newer = snapshot.clone();
        newer.title = "Latest title snapshot".into();
        assert!(store
            .record_reading_history("session-2", &newer, "2020-01-02T01:00:00Z")
            .unwrap());
        // UTC dates differ, but +08:00 places both opens on the same local day.
        assert!(store
            .record_reading_history("session-3", &snapshot, "2020-01-02T02:00:00Z")
            .unwrap());
        let mut other_source = snapshot.clone();
        other_source.source_id = "smb:v1:other".into();
        assert!(store
            .record_reading_history("session-4", &other_source, "2020-01-02T02:30:00Z")
            .unwrap());

        let page = store.get_reading_history("all", 0, 40, 480).unwrap();
        assert_eq!(
            page.total, 2,
            "same path/day should merge while another source remains distinct"
        );
        assert_eq!(page.items[0].id, "session-4");
        assert_eq!(page.items[1].id, "session-3");
        assert_eq!(page.items[1].comic.title, "Book");
        assert_eq!(page.items[1].comic.progress.current_page, 3);

        let first = store.get_reading_history("all", 0, 1, 480).unwrap();
        let second = store.get_reading_history("all", 1, 1, 480).unwrap();
        assert_eq!(first.total, 2);
        assert_eq!(first.items.len(), 1);
        assert_eq!(second.items.len(), 1);
        assert!(store.get_reading_history("invalid", 0, 20, 480).is_err());
        assert!(store.get_reading_history("all", 0, 20, 900).is_err());
        assert_eq!(
            store
                .get_reading_history("all", 0, 500, 480)
                .unwrap()
                .items
                .len(),
            2
        );
    }

    #[test]
    fn reading_history_hydrates_exact_location_and_never_borrows_other_source_progress() {
        let store = store("reading_history_hydrate");
        let first = comic("runtime-old", "same/book.cbz");
        store.sync_library(std::slice::from_ref(&first)).unwrap();
        let snapshot = ReadingHistoryComic {
            id: first.id.clone(),
            source_id: first.source_id.clone(),
            relative_path: first.relative_path.clone(),
            title: "Title at open".into(),
            page_count: 10,
            progress: crate::state::Progress {
                current_page: 1,
                total_pages: 10,
                percent: 10.0,
                updated_at: Some("2020-01-01T00:00:00Z".into()),
            },
            offline: false,
        };
        store
            .record_reading_history("history-hydrate", &snapshot, "2020-01-01T00:00:00Z")
            .unwrap();
        store
            .save_progress_for_source_location(
                "runtime-old",
                "local",
                "same/book.cbz",
                &crate::state::Progress {
                    current_page: 6,
                    total_pages: 10,
                    percent: 60.0,
                    updated_at: Some("2020-01-02T00:00:00Z".into()),
                },
            )
            .unwrap();
        store.with_connection(|connection| {
            connection.execute(
                "UPDATE comic_locations SET runtime_id='runtime-new' WHERE source_id='local' AND relative_path='same/book.cbz'", [],
            ).map_err(|error| error.to_string())?;
            connection.execute("UPDATE comics SET title='Current catalog title' WHERE id=(
                SELECT comic_id FROM comic_locations WHERE source_id='local' AND relative_path='same/book.cbz'
            )", [])
                .map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();

        let online = store.get_reading_history("all", 0, 10, 480).unwrap();
        let item = &online.items[0].comic;
        assert_eq!(item.id, "runtime-new");
        assert_eq!(item.title, "Current catalog title");
        assert!(!item.offline);
        assert_eq!(item.progress.current_page, 6);

        let mut other = comic("other-canonical", "same/book.cbz");
        other.source_id = "local:other".into();
        store.sync_library(&[other]).unwrap();
        store.with_connection(|connection| {
            connection.execute(
                "UPDATE comic_locations SET online=0 WHERE source_id='local' AND relative_path='same/book.cbz'", [],
            ).map_err(|error| error.to_string())?;
            connection.execute("UPDATE comics SET offline=1 WHERE id=(
                SELECT comic_id FROM comic_locations WHERE source_id='local' AND relative_path='same/book.cbz'
            )", [])
                .map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        let offline = store.get_reading_history("all", 0, 10, 480).unwrap();
        assert!(offline.items[0].comic.offline);
        assert_eq!(offline.items[0].comic.progress.current_page, 6);

        store.with_connection(|connection| {
            connection.execute(
                "DELETE FROM comic_locations WHERE source_id='local' AND relative_path='same/book.cbz'", [],
            ).map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        let removed = store.get_reading_history("all", 0, 10, 480).unwrap();
        assert_eq!(removed.items[0].comic.id, "runtime-old");
        assert_eq!(removed.items[0].comic.title, "Title at open");
        assert_eq!(removed.items[0].comic.progress.current_page, 1);
        assert!(removed.items[0].comic.offline);
    }

    #[test]
    fn ios_documents_history_aliases_old_container_inside_grouping_and_paging() {
        let store = store("ios_documents_history_alias");
        let documents = Path::new(
            "/private/var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents",
        );
        let old_source = crate::scanner::local_source_id(Path::new(
            "/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents",
        ));
        let current_source = crate::scanner::local_source_id(documents);
        let mut current = comic("runtime-current", "same/book.cbz");
        current.source_id = current_source.clone();
        current.title = "Current catalog title".into();
        current.page_count = 12;
        store.sync_library(std::slice::from_ref(&current)).unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comics SET title='Current catalog title' WHERE id=(
                           SELECT comic_id FROM comic_locations
                           WHERE runtime_id=?1 AND source_id=?2 AND relative_path=?3
                         )",
                        params![current.id, current_source, current.relative_path],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        store
            .save_progress_for_source_location(
                &current.id,
                &current_source,
                &current.relative_path,
                &crate::state::Progress {
                    current_page: 9,
                    total_pages: 12,
                    percent: 75.0,
                    updated_at: Some("2020-01-02T00:00:00Z".into()),
                },
            )
            .unwrap();

        let snapshot = |source_id: String| ReadingHistoryComic {
            id: "old-runtime-id".into(),
            source_id,
            relative_path: "same/book.cbz".into(),
            title: "Title at open".into(),
            page_count: 12,
            progress: crate::state::Progress {
                current_page: 2,
                total_pages: 12,
                percent: 16.7,
                updated_at: Some("2020-01-01T00:00:00Z".into()),
            },
            offline: true,
        };
        store
            .record_reading_history(
                "ios-old-session",
                &snapshot(old_source.clone()),
                "2020-01-02T01:00:00Z",
            )
            .unwrap();
        let mut current_snapshot = snapshot(current_source.clone());
        current_snapshot.id = current.id.clone();
        store
            .record_reading_history(
                "ios-current-session",
                &current_snapshot,
                "2020-01-02T02:00:00Z",
            )
            .unwrap();

        // An external/NAS source at the same relative path remains independent.
        let mut external = snapshot("smb:v1:nas".into());
        external.id = "nas-runtime".into();
        store
            .record_reading_history("ios-nas-session", &external, "2020-01-02T03:00:00Z")
            .unwrap();

        let raw_before = store
            .with_connection(|connection| {
                connection
                    .prepare("SELECT session_key,source_id,relative_path,opened_at,title,progress_page FROM reading_history ORDER BY session_key")
                    .map_err(|error| error.to_string())?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let first = store
            .get_reading_history_for_ios_documents("all", 0, 1, 480, documents)
            .unwrap();
        let second = store
            .get_reading_history_for_ios_documents("all", 1, 1, 480, documents)
            .unwrap();
        assert_eq!(
            first.total, 2,
            "old/current own-container rows group once; NAS stays separate"
        );
        assert_eq!(second.total, 2);
        assert_eq!(first.items.len(), 1);
        assert_eq!(second.items.len(), 1);
        let own_container = [&first.items[0], &second.items[0]]
            .into_iter()
            .find(|item| item.id == "ios-current-session")
            .unwrap();
        assert_eq!(own_container.comic.id, current.id);
        assert_eq!(own_container.comic.source_id, current_source);
        assert_eq!(own_container.comic.progress.current_page, 9);
        assert_eq!(own_container.comic.title, "Current catalog title");
        assert!(!own_container.comic.offline);

        let raw_after = store
            .with_connection(|connection| {
                connection
                    .prepare("SELECT session_key,source_id,relative_path,opened_at,title,progress_page FROM reading_history ORDER BY session_key")
                    .map_err(|error| error.to_string())?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, i64>(5)?,
                        ))
                    })
                    .map_err(|error| error.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(
            raw_after, raw_before,
            "query never rewrites raw history events"
        );

        // The same old source with no current exact location stays offline and
        // keeps its original source ID, even if a NAS location exists.
        let mut missing = snapshot(old_source.clone());
        missing.relative_path = "missing/book.cbz".into();
        store
            .record_reading_history("ios-missing-session", &missing, "2020-01-03T01:00:00Z")
            .unwrap();
        let mut nas_location = comic("nas-comic", "missing/book.cbz");
        nas_location.source_id = "smb:v1:nas".into();
        store
            .sync_library(std::slice::from_ref(&nas_location))
            .unwrap();
        let missing = store
            .get_reading_history_for_ios_documents("all", 0, 10, 480, documents)
            .unwrap()
            .items
            .into_iter()
            .find(|item| item.id == "ios-missing-session")
            .unwrap();
        assert!(missing.comic.offline);
        assert_eq!(missing.comic.source_id, old_source);

        store
            .with_connection(|connection| {
                connection
                    .pragma_update(None, "query_only", true)
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(store
            .get_reading_history_for_ios_documents("all", 0, 10, 480, documents)
            .is_ok());
    }

    #[test]
    fn ios_documents_history_falls_back_to_exact_old_location_progress() {
        let store = store("ios_documents_history_old_progress");
        let documents = Path::new(
            "/private/var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents",
        );
        let old_source = crate::scanner::local_source_id(Path::new(
            "/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents",
        ));
        let mut old_location = comic("old-runtime", "same/book.cbz");
        old_location.source_id = old_source.clone();
        store
            .sync_library(std::slice::from_ref(&old_location))
            .unwrap();
        store
            .save_progress_for_source_location(
                &old_location.id,
                &old_source,
                &old_location.relative_path,
                &crate::state::Progress {
                    current_page: 8,
                    total_pages: 12,
                    percent: 66.7,
                    updated_at: Some("2026-11-08T10:00:00Z".into()),
                },
            )
            .unwrap();

        let mut foreign = comic("foreign-runtime", "same/book.cbz");
        foreign.source_id = "smb:v1:foreign".into();
        store.sync_library(std::slice::from_ref(&foreign)).unwrap();
        store
            .save_progress_for_source_location(
                &foreign.id,
                &foreign.source_id,
                &foreign.relative_path,
                &crate::state::Progress {
                    current_page: 11,
                    total_pages: 12,
                    percent: 91.7,
                    updated_at: Some("2026-11-09T10:00:00Z".into()),
                },
            )
            .unwrap();

        let snapshot = ReadingHistoryComic {
            id: old_location.id,
            source_id: old_source.clone(),
            relative_path: "same/book.cbz".into(),
            title: "Title at open".into(),
            page_count: 12,
            progress: crate::state::Progress {
                current_page: 2,
                total_pages: 12,
                percent: 16.7,
                updated_at: Some("2026-11-07T10:00:00Z".into()),
            },
            offline: true,
        };
        store
            .record_reading_history("old-container-session", &snapshot, "2026-11-08T11:00:00Z")
            .unwrap();

        let page = store
            .get_reading_history_for_ios_documents("all", 0, 10, 480, documents)
            .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items.len(), 1);
        let history = &page.items[0].comic;
        assert!(
            history.offline,
            "old catalog location is not current online state"
        );
        assert_eq!(history.source_id, old_source);
        assert_eq!(history.relative_path, "same/book.cbz");
        assert_eq!(history.progress.current_page, 8);
        assert_eq!(
            history.progress.updated_at.as_deref(),
            Some("2026-11-08T10:00:00Z")
        );
    }

    #[test]
    fn reading_history_month_and_year_use_normalized_utc_cutoffs() {
        let store = store("reading_history_periods");
        let snapshot = ReadingHistoryComic {
            id: "period-book".into(),
            source_id: "local".into(),
            relative_path: "period/book.cbz".into(),
            title: "Period".into(),
            page_count: 1,
            progress: crate::state::Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            offline: false,
        };
        let now = chrono::Utc::now();
        for (key, days) in [("one-day", 1), ("31-day", 31), ("366-day", 366)] {
            let opened = (now - chrono::Duration::days(days)).to_rfc3339();
            store
                .record_reading_history(key, &snapshot, &opened)
                .unwrap();
        }
        assert_eq!(
            store
                .get_reading_history("month", 0, 10, 480)
                .unwrap()
                .total,
            1
        );
        assert_eq!(
            store.get_reading_history("year", 0, 10, 480).unwrap().total,
            2
        );
        assert_eq!(
            store.get_reading_history("all", 0, 10, 480).unwrap().total,
            3
        );
    }

    #[test]
    fn reading_history_normalizes_offset_timestamps_to_utc_millis() {
        let store = store("reading_history_timestamp");
        let snapshot = ReadingHistoryComic {
            id: "offset-book".into(),
            source_id: "local".into(),
            relative_path: "offset/book.cbz".into(),
            title: "Offset".into(),
            page_count: 1,
            progress: crate::state::Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            offline: false,
        };
        store
            .record_reading_history("offset-session", &snapshot, "2020-01-02T02:00:00+08:00")
            .unwrap();
        let page = store.get_reading_history("all", 0, 10, 480).unwrap();
        assert_eq!(page.items[0].opened_at, "2020-01-01T18:00:00.000Z");
    }

    #[cfg(unix)]
    #[test]
    fn reading_history_dst_uses_os_historical_timezone_in_child_process() {
        let executable = std::env::current_exe().unwrap();
        let listing = std::process::Command::new(&executable)
            .arg("--list")
            .output()
            .unwrap();
        assert!(listing.status.success());
        let test_name = String::from_utf8_lossy(&listing.stdout)
            .lines()
            .find_map(|line| {
                let (name, _) = line.split_once(": test")?;
                name.ends_with("reading_history_dst_child_process")
                    .then(|| name.to_string())
            })
            .expect("find isolated DST child test");
        let result = std::process::Command::new(executable)
            .args(["--exact", test_name.as_str(), "--nocapture"])
            .env("TZ", "America/New_York")
            .env("G_AI_READING_HISTORY_DST_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "DST child failed: {}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[cfg(unix)]
    #[test]
    fn reading_history_dst_child_process() {
        if std::env::var_os("G_AI_READING_HISTORY_DST_CHILD").is_none() {
            return;
        }
        let store = store("reading_history_dst_child");
        let snapshot = ReadingHistoryComic {
            id: "dst-book".into(),
            source_id: "local".into(),
            relative_path: "dst/book.cbz".into(),
            title: "DST".into(),
            page_count: 1,
            progress: crate::state::Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            offline: false,
        };
        let native_offset = chrono::Local::now().offset().local_minus_utc() / 60;
        assert!(matches!(native_offset, -300 | -240), "{native_offset}");
        let (first, second) = if native_offset == -300 {
            ("2020-06-15T04:30:00Z", "2020-06-15T05:30:00Z")
        } else {
            ("2020-01-15T04:30:00Z", "2020-01-15T05:30:00Z")
        };
        store
            .record_reading_history("dst-first", &snapshot, first)
            .unwrap();
        store
            .record_reading_history("dst-second", &snapshot, second)
            .unwrap();
        let page = store
            .get_reading_history("all", 0, 10, native_offset)
            .unwrap();
        let (historical_days, fixed_offset_days): (i64, i64) = store
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(DISTINCT date(datetime(opened_at,'localtime'))),
                            COUNT(DISTINCT date(datetime(opened_at,?1)))
                     FROM reading_history",
                        [format!("{native_offset:+} minutes")],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_ne!(historical_days, fixed_offset_days);
        assert_eq!(page.total, historical_days as usize);
    }

    #[test]
    fn reading_history_migration_does_not_fabricate_legacy_events_and_is_indexed() {
        let store = store("reading_history_migration");
        store
            .sync_library(&[comic("legacy-book", "old.cbz")])
            .unwrap();
        store.with_connection(|connection| {
            let count: i64 = connection.query_row("SELECT COUNT(*) FROM reading_history", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            assert_eq!(count, 0);
            let plan = connection.prepare(
                "EXPLAIN QUERY PLAN SELECT session_key FROM reading_history ORDER BY opened_at DESC LIMIT 40",
            ).map_err(|error| error.to_string())?.query_map([], |row| row.get::<_, String>(3))
                .map_err(|error| error.to_string())?.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            assert!(plan.iter().any(|line| line.contains("idx_reading_history_opened_at")), "{plan:?}");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn fts_consistency_is_checked_on_store_open_only() {
        let store = store("fts_open_check");
        store
            .sync_library(&[comic("runtime", "knownbook.zip")])
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute("DELETE FROM catalog_fts", [])
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        let query = CatalogQuery {
            query: "known".into(),
            offset: 0,
            limit: 20,
        };
        assert_eq!(store.search(query.clone()).unwrap().total, 0);

        let reopened = CatalogStore::new(store.path().to_path_buf()).unwrap();
        assert_eq!(reopened.search(query).unwrap().total, 1);
    }

    #[test]
    fn mark_source_offline_refreshes_fts_when_primary_location_changes() {
        let store = store("mark_source_offline_refreshes_primary_fts");
        store
            .with_connection(|connection| {
                let tx = connection.transaction().map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comics(id,title) VALUES('shared-work','Shared Work')",
                    [],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at)
                     VALUES('shared-work','alpha-runtime','external:alpha','library/AlphaPrimaryMarker.cbz','archive',1,'2026-01-01 00:00:00'),
                           ('shared-work','beta-runtime','external:beta','library/BetaPrimaryMarker.cbz','archive',1,'2026-02-01 00:00:00')",
                    [],
                )
                .map_err(|error| error.to_string())?;
                refresh_fts(&tx, "shared-work")?;
                tx.commit().map_err(|error| error.to_string())
            })
            .unwrap();

        let query_total = |query: &str| {
            store
                .search(CatalogQuery {
                    query: query.into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap()
                .total
        };
        assert_eq!(query_total("BetaPrimaryMarker"), 1);
        assert_eq!(query_total("AlphaPrimaryMarker"), 0);

        store.mark_source_offline("external:beta").unwrap();

        assert_eq!(query_total("AlphaPrimaryMarker"), 1);
        assert_eq!(query_total("BetaPrimaryMarker"), 0);
    }

    #[test]
    fn final_sync_retirement_refreshes_unseen_primary_location_fts() {
        let store = store("sync_retirement_refreshes_primary_fts");
        store
            .with_connection(|connection| {
                let tx = connection.transaction().map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comics(id,title) VALUES('shared-work','Shared Work'),('current-work','Current Work')",
                    [],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at)
                     VALUES('shared-work','alpha-old','external:alpha','library/AlphaUnseenMarker.cbz','archive',1,'2026-02-01 00:00:00'),
                           ('shared-work','beta-kept','external:beta','library/BetaKeptMarker.cbz','archive',1,'2026-01-01 00:00:00')",
                    [],
                )
                .map_err(|error| error.to_string())?;
                refresh_fts(&tx, "shared-work")?;
                tx.commit().map_err(|error| error.to_string())
            })
            .unwrap();

        let query_total = |query: &str| {
            store
                .search(CatalogQuery {
                    query: query.into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap()
                .total
        };
        assert_eq!(query_total("AlphaUnseenMarker"), 1);
        assert_eq!(query_total("BetaKeptMarker"), 0);

        let mut current = comic("current-runtime", "library/current.cbz");
        current.source_id = "external:alpha".into();
        current.source_path = None;
        store
            .sync_library_with_progress(&[current], true, |_, _| {}, || true)
            .unwrap();

        assert_eq!(query_total("AlphaUnseenMarker"), 0);
        assert_eq!(query_total("BetaKeptMarker"), 1);
    }

    #[test]
    fn version_six_upgrade_preserves_books_and_indexes_online_reconciliation() {
        let store = store("location_index_upgrade");
        store.sync_library(&[comic("runtime", "a.zip")]).unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "DROP INDEX idx_locations_comic_online;
                DELETE FROM schema_migrations WHERE version>=7;
                PRAGMA user_version=6;",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        CatalogStore::new(store.path().to_path_buf()).unwrap();
        assert_eq!(store.get_metadata("runtime").unwrap().title, "a");
        store.with_connection(|connection| {
            let mut query = connection.prepare("EXPLAIN QUERY PLAN UPDATE comics SET offline = CASE WHEN EXISTS (SELECT 1 FROM comic_locations l WHERE l.comic_id = comics.id AND l.online = 1) THEN 0 ELSE 1 END").map_err(|error| error.to_string())?;
            let details = query.query_map([], |row| row.get::<_, String>(3))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            assert!(details.iter().any(|detail| detail.contains("idx_locations_comic_online")), "{details:?}");
            Ok(())
        }).unwrap();
    }

    #[test]
    fn reading_progress_survives_runtime_path_change() {
        let store = store("stable_progress");
        let mut item = comic("old-runtime", "舊資料夾/a.zip");
        item.progress = crate::state::Progress {
            current_page: 8,
            total_pages: 20,
            percent: 40.0,
            updated_at: Some("2026-08-30T00:00:00+08:00".into()),
        };
        store.sync_library(&[item]).unwrap();
        let loaded = store.get_runtime_item("old-runtime").unwrap().unwrap();
        assert_eq!(loaded.progress.current_page, 8);

        store
            .save_progress(
                "old-runtime",
                &crate::state::Progress {
                    current_page: 12,
                    total_pages: 20,
                    percent: 60.0,
                    updated_at: Some("2026-08-30T00:10:00+08:00".into()),
                },
            )
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET runtime_id='new-runtime', relative_path='新資料夾/a.zip' WHERE runtime_id='old-runtime'",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        let moved = store.get_runtime_item("new-runtime").unwrap().unwrap();
        assert_eq!(moved.progress.current_page, 12);
        assert_eq!(moved.progress.total_pages, 20);
        assert_eq!(moved.progress.percent, 60.0);
    }

    #[test]
    fn recent_reading_runtime_item_orders_progress_and_includes_saved_single_page() {
        let store = store("recent_reading");
        let mut older = comic("older-runtime", "older/a.zip");
        older.progress = crate::state::Progress {
            current_page: 2,
            total_pages: 10,
            percent: 20.0,
            updated_at: Some("2026-09-01T00:00:00Z".into()),
        };
        let mut newer = comic("newer-runtime", "newer/a.zip");
        newer.progress = crate::state::Progress {
            current_page: 4,
            total_pages: 10,
            percent: 40.0,
            updated_at: Some("2026-09-02T00:00:00Z".into()),
        };
        let mut unread = comic("unread-runtime", "unread/a.zip");
        unread.progress = crate::state::Progress {
            current_page: 0,
            total_pages: 10,
            percent: 0.0,
            updated_at: Some("2026-09-03T00:00:00Z".into()),
        };
        let mut single_page = comic("single-page-runtime", "single/a.zip");
        single_page.progress = crate::state::Progress {
            current_page: 0,
            total_pages: 1,
            percent: 100.0,
            updated_at: Some("2026-09-04T00:00:00Z".into()),
        };
        store
            .sync_library(&[older, newer, unread, single_page])
            .unwrap();

        let recent = store
            .get_recent_reading_runtime_item()
            .unwrap()
            .expect("已讀項目應可取得");
        assert_eq!(recent.id, "single-page-runtime");
        assert_eq!(recent.progress.current_page, 0);
    }

    #[test]
    fn recent_reading_runtime_item_keeps_the_source_of_selected_progress() {
        let store = store("recent_reading_source_qualified");
        let mut older_source = comic("shared-runtime", "A/book.cbz");
        older_source.source_id = "external:a".into();
        older_source.updated_at = "2026-09-01T00:00:00Z".into();
        older_source.progress = crate::state::Progress {
            current_page: 2,
            total_pages: 10,
            percent: 20.0,
            updated_at: Some("2026-09-01T00:00:00Z".into()),
        };
        let mut newer_source = comic("shared-runtime", "B/book.cbz");
        newer_source.source_id = "external:b".into();
        newer_source.updated_at = "2026-08-01T00:00:00Z".into();
        newer_source.progress = crate::state::Progress {
            current_page: 8,
            total_pages: 10,
            percent: 80.0,
            updated_at: Some("2026-09-02T00:00:00Z".into()),
        };
        store.sync_library(&[older_source, newer_source]).unwrap();

        let recent = store
            .get_recent_reading_runtime_item()
            .unwrap()
            .expect("已讀項目應可取得");
        assert_eq!(recent.id, "shared-runtime");
        assert_eq!(recent.source_id, "external:b");
        assert_eq!(recent.relative_path, "B/book.cbz");
        assert_eq!(recent.progress.current_page, 8);
    }

    #[test]
    fn quarantine_locations_are_excluded_from_search_and_recent_reading() {
        let store = store("quarantine_visibility");
        let mut normal = comic("normal-runtime", "library/book.cbz");
        normal.source_id = "local:normal".into();
        normal.progress = crate::state::Progress {
            current_page: 7,
            total_pages: 20,
            percent: 35.0,
            updated_at: Some("2026-09-05T00:00:00Z".into()),
        };
        store.sync_library(&[normal]).unwrap();
        let comic_id = store.get_metadata("normal-runtime").unwrap().comic_id;

        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO comic_locations(
                            comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at
                         ) VALUES(?1,?2,?3,?4,'archive',0,'2026-09-05T00:00:00Z')",
                        params![
                            comic_id,
                            "quarantine-runtime",
                            "local:quarantine",
                            ".gai-quarantine/operation/book.cbz"
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO comic_locations(
                            comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at
                         ) VALUES(?1,?2,?3,?4,'archive',0,'2026-09-05T00:00:00Z')",
                        params![
                            comic_id,
                            "lookalike-runtime",
                            "local:lookalike",
                            ".gai-quarantinex/book.cbz"
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute("UPDATE comics SET offline=0 WHERE id=?1", [&comic_id])
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(store
            .get_runtime_item_for_source_path(
                &comic_id,
                "local:quarantine",
                ".gai-quarantine/operation/book.cbz",
            )
            .unwrap()
            .is_some());

        for query in ["", "book"] {
            let result = store
                .search(CatalogQuery {
                    query: query.into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap();
            assert_eq!(result.total, 1, "query={query}");
            let item = &result.items[0];
            assert_eq!(item.relative_path.as_deref(), Some("library/book.cbz"));
            assert!(item
                .locations
                .iter()
                .all(|location| !is_quarantine_relative_path(&location.relative_path)));
            assert!(item
                .locations
                .iter()
                .any(|location| location.relative_path == ".gai-quarantinex/book.cbz"));
        }

        let recent = store
            .get_recent_reading_runtime_item()
            .unwrap()
            .expect("正常位置仍應可作為最近閱讀");
        assert_eq!(recent.relative_path, "library/book.cbz");
        assert_eq!(recent.progress.current_page, 7);

        let only_quarantine = self::store("quarantine_only_visibility");
        let mut isolated = comic("isolated-runtime", ".gai-quarantine/only.cbz");
        isolated.source_id = "local:isolated".into();
        isolated.progress = crate::state::Progress {
            current_page: 9,
            total_pages: 20,
            percent: 45.0,
            updated_at: Some("2026-09-06T00:00:00Z".into()),
        };
        only_quarantine.sync_library(&[isolated]).unwrap();
        only_quarantine
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET online=0 WHERE source_id=?1 AND relative_path=?2",
                        params!["local:isolated", ".gai-quarantine/only.cbz"],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "UPDATE comics SET offline=1 WHERE id=(
                            SELECT comic_id FROM comic_locations
                            WHERE source_id=?1 AND relative_path=?2
                        )",
                        params!["local:isolated", ".gai-quarantine/only.cbz"],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        for query in ["", "only"] {
            let result = only_quarantine
                .search(CatalogQuery {
                    query: query.into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap();
            assert_eq!(result.total, 0, "query={query}");
        }
        assert!(only_quarantine
            .get_recent_reading_runtime_item()
            .unwrap()
            .is_none());
    }

    #[test]
    fn search_primary_location_excludes_quarantine_and_breaks_timestamp_ties() {
        let store = store("search_primary_location_visibility_and_tie");
        let mut visible = comic("visible-runtime", "library/visible.cbz");
        visible.source_id = "local:visible".into();
        let mut tied = comic("tied-runtime", "Z/tied.cbz");
        tied.source_id = "external:z".into();
        store.sync_library(&[visible, tied]).unwrap();
        let visible_id = store.get_metadata("visible-runtime").unwrap().comic_id;
        let tied_id = store.get_metadata("tied-runtime").unwrap().comic_id;

        store
            .with_connection(|connection| {
                let tx = connection.transaction().map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at)
                     VALUES(?1,'hidden-runtime','local:hidden','.gai-quarantine/hidden/book.cbz','archive',1,'2026-11-01T00:00:00Z')",
                    [&visible_id],
                )
                .map_err(|error| error.to_string())?;
                let hidden_tag = ensure_tag_tx(
                    &tx,
                    &ScopedTag {
                        namespace: "general".into(),
                        value: "HiddenFolderMarker".into(),
                    },
                )?;
                tx.execute(
                    "INSERT INTO folder_tag_rules(source_id,folder_path,tag_id,enabled) VALUES('local:hidden','.gai-quarantine/hidden',?1,1)",
                    [hidden_tag],
                )
                .map_err(|error| error.to_string())?;

                let tied_seen_at: String = tx
                    .query_row(
                        "SELECT last_seen_at FROM comic_locations WHERE comic_id=?1 AND source_id='external:z'",
                        [&tied_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at)
                     VALUES(?1,'alpha-runtime','external:a','A/tied.cbz','archive',1,?2)",
                    params![&tied_id, tied_seen_at],
                )
                .map_err(|error| error.to_string())?;
                let alpha_tag = ensure_tag_tx(
                    &tx,
                    &ScopedTag {
                        namespace: "general".into(),
                        value: "AlphaTieMarker".into(),
                    },
                )?;
                let zeta_tag = ensure_tag_tx(
                    &tx,
                    &ScopedTag {
                        namespace: "general".into(),
                        value: "ZetaTieMarker".into(),
                    },
                )?;
                tx.execute(
                    "INSERT INTO folder_tag_rules(source_id,folder_path,tag_id,enabled) VALUES('external:a','A',?1,1),('external:z','Z',?2,1)",
                    params![alpha_tag, zeta_tag],
                )
                .map_err(|error| error.to_string())?;
                refresh_fts(&tx, &visible_id)?;
                refresh_fts(&tx, &tied_id)?;
                tx.commit().map_err(|error| error.to_string())
            })
            .unwrap();

        let query_total = |query: &str| {
            store
                .search(CatalogQuery {
                    query: query.into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap()
                .total
        };
        assert_eq!(query_total("HiddenFolderMarker"), 0);
        assert_eq!(store.get_metadata(&visible_id).unwrap().tags.len(), 0);
        store.mark_source_offline("local:hidden").unwrap();
        assert_eq!(query_total("HiddenFolderMarker"), 0);

        let tied_view = store.get_metadata(&tied_id).unwrap();
        assert_eq!(tied_view.source_id.as_deref(), Some("external:a"));
        assert_eq!(
            tied_view.tags,
            vec![ScopedTag {
                namespace: "general".into(),
                value: "AlphaTieMarker".into(),
            }]
        );
        assert_eq!(query_total("AlphaTieMarker"), 1);
        assert_eq!(query_total("ZetaTieMarker"), 0);
        store.mark_source_offline("external:a").unwrap();
        let switched_view = store.get_metadata(&tied_id).unwrap();
        assert_eq!(switched_view.source_id.as_deref(), Some("external:z"));
        assert_eq!(
            switched_view.tags,
            vec![ScopedTag {
                namespace: "general".into(),
                value: "ZetaTieMarker".into(),
            }]
        );
        assert_eq!(query_total("AlphaTieMarker"), 0);
        assert_eq!(query_total("ZetaTieMarker"), 1);
    }

    #[test]
    fn runtime_items_by_ids_preserves_requested_order_and_deduplicates() {
        let store = store("runtime_items_batch");
        store
            .sync_library(&[
                comic("first-runtime", "first/a.zip"),
                comic("second-runtime", "second/a.zip"),
            ])
            .unwrap();

        let ids = vec![
            "second-runtime".to_string(),
            "missing-runtime".to_string(),
            "first-runtime".to_string(),
            "second-runtime".to_string(),
        ];
        let items = store.get_runtime_items_by_ids(&ids).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["second-runtime", "first-runtime"]
        );
    }

    #[test]
    fn external_cleanup_retries_failed_removal_with_the_same_committed_selection() {
        let store = store("retry_external_cleanup");
        let mut removed = comic("removed-runtime", "removed/a.zip");
        removed.source_id = "external:removed".into();
        let mut kept = comic("kept-runtime", "kept/b.zip");
        kept.source_id = "external:kept".into();
        let local = comic("local-runtime", "local/c.zip");
        store.sync_library(&[removed, kept, local]).unwrap();
        let selected = BTreeSet::from(["external:kept".into()]);
        store.with_connection(|connection| {
            connection.execute_batch("CREATE TRIGGER fail_external_cleanup BEFORE DELETE ON comic_locations WHEN OLD.source_id='external:removed' BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;")
                .map_err(|error| error.to_string())
        }).unwrap();
        assert!(store
            .reconcile_external_source_locations(&selected)
            .is_err());
        assert!(store.get_runtime_item("removed-runtime").unwrap().is_some());
        store
            .with_connection(|connection| {
                connection
                    .execute_batch("DROP TRIGGER fail_external_cleanup")
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_eq!(
            store
                .reconcile_external_source_locations(&selected)
                .unwrap(),
            1
        );
        assert!(store.get_runtime_item("removed-runtime").unwrap().is_none());
        assert!(store.get_runtime_item("kept-runtime").unwrap().is_some());
        assert!(store.get_runtime_item("local-runtime").unwrap().is_some());
        assert_eq!(
            store
                .reconcile_external_source_locations(&selected)
                .unwrap(),
            0
        );
    }

    #[test]
    fn forgetting_source_locations_preserves_metadata_progress_and_other_online_locations() {
        let store = store("forget_source_keeps_location");
        let mut item = comic("removed-runtime", "舊來源/a.zip");
        item.source_id = "external:removed".into();
        item.source_path = Some("/private/var/old/a.zip".into());
        store.sync_library(&[item]).unwrap();
        let location = store.get_location("removed-runtime").unwrap();
        let comic_id = location.comic_id.clone();
        let progress = crate::state::Progress {
            current_page: 8,
            total_pages: 20,
            percent: 40.0,
            updated_at: Some("2026-09-01T00:00:00Z".into()),
        };
        store.save_progress("removed-runtime", &progress).unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comics SET title='保留標題' WHERE id=?1",
                        [&comic_id],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,actual_path,kind,online) VALUES(?1,'kept-runtime','external:kept','保留來源/a.zip','/private/var/kept/a.zip','archive',1)",
                        [&comic_id],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert_eq!(
            store.forget_source_locations("external:removed").unwrap(),
            1
        );
        store
            .with_connection(|connection| {
                let removed_count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM comic_locations WHERE source_id='external:removed'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(removed_count, 0);
                let remaining: (String, i64) = connection
                    .query_row(
                        "SELECT source_id,online FROM comic_locations WHERE comic_id=?1",
                        [&comic_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(remaining, ("external:kept".into(), 1));
                let saved: (i64, i64, f64) = connection
                    .query_row(
                        "SELECT current_page,total_pages,percent FROM reading_progress WHERE comic_id=?1",
                        [&comic_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(saved, (8, 20, 40.0));
                Ok(())
            })
            .unwrap();
        let metadata = store.get_metadata(&comic_id).unwrap();
        assert_eq!(metadata.title, "保留標題");
        assert!(!metadata.offline);
        assert_eq!(metadata.source_id.as_deref(), Some("external:kept"));
        assert!(store.get_runtime_item("removed-runtime").unwrap().is_none());
    }

    #[test]
    fn forgetting_last_source_location_preserves_metadata_and_marks_comic_offline() {
        let store = store("forget_last_source");
        let mut item = comic("last-runtime", "唯一來源/a.zip");
        item.source_id = "external:removed".into();
        store.sync_library(&[item]).unwrap();
        let location = store.get_location("last-runtime").unwrap();
        let comic_id = location.comic_id.clone();
        store
            .save_progress(
                "last-runtime",
                &crate::state::Progress {
                    current_page: 3,
                    total_pages: 10,
                    percent: 30.0,
                    updated_at: Some("2026-09-01T00:00:00Z".into()),
                },
            )
            .unwrap();

        assert_eq!(
            store.forget_source_locations("external:removed").unwrap(),
            1
        );
        let metadata = store.get_metadata(&comic_id).unwrap();
        assert!(metadata.offline);
        assert!(metadata.source_id.is_none());
        assert!(metadata.relative_path.is_none());
        assert_eq!(metadata.title, "a");
        store
            .with_connection(|connection| {
                let saved: (i64, i64, f64) = connection
                    .query_row(
                        "SELECT current_page,total_pages,percent FROM reading_progress WHERE comic_id=?1",
                        [&comic_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(saved, (3, 10, 30.0));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn runtime_progress_compares_rfc3339_as_utc_instants() {
        let store = store("progress_timezones");
        store.with_connection(|connection| {
            connection.execute("INSERT INTO comics(id,title) VALUES('stable','book')", []).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO reading_progress(comic_id,current_page,total_pages,percent,updated_at) VALUES('stable',1,10,10,'2026-08-30T00:30:00+08:00')", []).map_err(|error| error.to_string())?;
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            import_runtime_progress(&tx, "stable", &crate::state::Progress {
                current_page: 2,
                total_pages: 10,
                percent: 20.0,
                // This is later in UTC even though its calendar date sorts before the persisted offset string.
                updated_at: Some("2026-08-29T17:00:00Z".into()),
            })?;
            tx.commit().map_err(|error| error.to_string())?;
            let row: (i64, String) = connection.query_row("SELECT current_page,updated_at FROM reading_progress WHERE comic_id='stable'", [], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|error| error.to_string())?;
            assert_eq!(row, (2, "2026-08-29T17:00:00Z".into()));
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            import_runtime_progress(&tx, "stable", &crate::state::Progress {
                current_page: 9,
                total_pages: 10,
                percent: 90.0,
                updated_at: Some("damaged legacy timestamp".into()),
            })?;
            tx.commit().map_err(|error| error.to_string())?;
            let current_page: i64 = connection.query_row("SELECT current_page FROM reading_progress WHERE comic_id='stable'", [], |row| row.get(0)).map_err(|error| error.to_string())?;
            assert_eq!(current_page, 2);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn version_one_fixture_upgrades_sequentially() {
        let path = std::env::temp_dir().join(format!(
            "comic_catalog_v1_{}_{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
            )
            .unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES(1, CURRENT_TIMESTAMP)",
                [],
            )
            .unwrap();
        drop(connection);

        let store = CatalogStore::new(path).unwrap();
        store
            .with_connection(|connection| {
                let tag_aliases_exists: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_aliases'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let versions: i64 = connection
                    .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                assert_eq!(tag_aliases_exists, 1);
                assert_eq!(versions, 12);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn newer_database_version_is_rejected() {
        let path = std::env::temp_dir().join(format!(
            "comic_catalog_future_{}_{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES(1, CURRENT_TIMESTAMP);
                 INSERT INTO schema_migrations(version, applied_at) VALUES(2, CURRENT_TIMESTAMP);
                 INSERT INTO schema_migrations(version, applied_at) VALUES(99, CURRENT_TIMESTAMP);",
            )
            .unwrap();
        drop(connection);

        let error = CatalogStore::new(path).unwrap_err();
        assert!(error.contains("比此 App 支援"));
    }

    #[test]
    fn bundled_sqlite_contains_the_wal_reset_fix() {
        assert!(
            rusqlite::version_number() >= 3_053_002,
            "bundled SQLite {} is older than 3.53.2",
            rusqlite::version()
        );
    }

    #[test]
    fn unfiltered_diagnostics_honor_limit() {
        let store = store("diagnostics_limit");
        store
            .sync_library(&[comic("runtime", "diagnostics.zip")])
            .unwrap();
        let stable_id = store.get_metadata("runtime").unwrap().comic_id;
        store.with_connection(|connection| {
            for index in 0..25 {
                connection.execute(
                    "INSERT INTO import_diagnostics(comic_id,parser_id,source_path,severity,message) VALUES(?1,?2,?3,'warning',?4)",
                    params![&stable_id, "fixture", format!("fixture-{index}"), format!("warning-{index}")],
                ).map_err(|error| error.to_string())?;
            }
            Ok(())
        }).unwrap();
        assert_eq!(store.diagnostics(20).unwrap().len(), 20);
    }

    #[test]
    fn catalog_only_locations_are_added_to_the_runtime_shelf() {
        let store = store("overlay_catalog_only");
        let mut item = comic("relative-runtime", "作者/a.zip");
        item.source_id = "local:root-a".into();
        item.source_path = Some("/Volumes/Comics/作者/a.zip".into());
        store.sync_library(&[item]).unwrap();

        let active_sources = BTreeSet::from(["local:root-a".to_string()]);
        let shelf = store.overlay_library(Vec::new(), &active_sources).unwrap();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].id, "relative-runtime");
        assert_eq!(shelf[0].title, "a");
        assert_eq!(shelf[0].r#type, "external-archive");
        assert_eq!(
            shelf[0].source_path.as_deref(),
            Some("/Volumes/Comics/作者/a.zip")
        );
        let resolved = store.get_runtime_item("relative-runtime").unwrap().unwrap();
        assert_eq!(resolved.id, "relative-runtime");
        assert_eq!(resolved.r#type, "external-archive");
    }

    #[test]
    fn quarantine_locations_are_not_added_to_the_runtime_shelf() {
        let store = store("overlay_hides_quarantine");
        let mut item = comic(
            "quarantine-runtime",
            ".gai-quarantine/comics/operation/book.cbz",
        );
        item.source_id = "local:root-a".into();
        item.source_path = Some("/Volumes/Comics/.gai-quarantine/comics/operation/book.cbz".into());
        store.sync_library(&[item]).unwrap();

        let active_sources = BTreeSet::from(["local:root-a".to_string()]);
        let shelf = store.overlay_library(Vec::new(), &active_sources).unwrap();
        assert!(shelf.is_empty());
    }

    #[test]
    fn catalog_overlay_does_not_mix_inactive_library_roots() {
        let store = store("overlay_source_scope");
        let mut old = comic("old-runtime", "old/book.zip");
        old.source_id = "local:old-root".into();
        old.source_path = Some("/Volumes/Old/old/book.zip".into());
        store.sync_library(&[old]).unwrap();

        let mut current = comic("current-runtime", "current/book.zip");
        current.source_id = "local:current-root".into();
        current.source_path = Some("/Volumes/Current/current/book.zip".into());
        store.sync_library(&[current]).unwrap();

        let active_sources = BTreeSet::from(["local:current-root".to_string()]);
        let shelf = store.overlay_library(Vec::new(), &active_sources).unwrap();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].id, "current-runtime");
    }

    #[test]
    fn catalog_overlay_keeps_same_runtime_id_separate_by_source() {
        let store = store("overlay_same_runtime_sources");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-a','A'),('comic-b','B');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at)
                         VALUES('comic-a','same-runtime','local:root-a','a.cbz','archive',1,'2026-09-01T00:00:00Z'),
                               ('comic-b','same-runtime','local:root-b','b.cbz','archive',1,'2026-09-02T00:00:00Z');
                         INSERT INTO reading_progress(comic_id,current_page,total_pages,percent,updated_at)
                         VALUES('comic-a',1,10,20.0,'2026-09-01T00:00:00Z'),
                               ('comic-b',7,20,40.0,'2026-09-02T00:00:00Z');",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let mut first = comic("same-runtime", "a.cbz");
        first.source_id = "local:root-a".into();
        first.relative_path = "a.cbz".into();
        let mut second = comic("same-runtime", "b.cbz");
        second.source_id = "local:root-b".into();
        second.relative_path = "b.cbz".into();
        let shelf = store
            .overlay_library(vec![first, second], &BTreeSet::new())
            .unwrap();
        assert_eq!(shelf.len(), 2);
        assert_eq!(
            shelf
                .iter()
                .map(|item| (
                    item.source_id.as_str(),
                    item.title.as_str(),
                    item.progress.current_page
                ))
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([("local:root-a", "A", 1usize), ("local:root-b", "B", 7usize),])
        );
        let all = store.get_runtime_items_for_id("same-runtime").unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(
            all.iter()
                .map(|item| item.source_id.as_str())
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["local:root-a", "local:root-b"])
        );
    }

    #[test]
    fn runtime_lookup_bounds_and_exposes_same_source_path_ambiguity() {
        let store = store("runtime_same_source_paths");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-a','A'),('comic-b','B');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online)
                         VALUES('comic-a','same-runtime','local:root','a.cbz','archive',1),
                               ('comic-b','same-runtime','local:root','b.cbz','archive',1);",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let all = store.get_runtime_items_for_id("same-runtime").unwrap();
        assert_eq!(all.len(), 2);
        assert_ne!(all[0].relative_path, all[1].relative_path);
        assert_eq!(
            store
                .get_runtime_items_for_source("same-runtime", "local:root")
                .unwrap()
                .len(),
            2
        );
        let exact = store
            .get_runtime_item_for_source_path("same-runtime", "local:root", "b.cbz")
            .unwrap()
            .unwrap();
        assert_eq!(exact.relative_path, "b.cbz");
    }

    #[test]
    fn runtime_lookup_prefers_online_over_retired_offline_location() {
        let store = store("runtime_online_over_offline");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-old','Old'),('comic-new','New');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online)
                         VALUES('comic-old','same-runtime','local:old','old/book.cbz','archive',0),
                               ('comic-new','same-runtime','local:new','new/book.cbz','archive',1);",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let all = store.get_runtime_items_for_id("same-runtime").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].source_id, "local:new");
        assert_eq!(all[0].r#type, "external-archive");

        let offline = store
            .get_runtime_items_for_source("same-runtime", "local:old")
            .unwrap();
        assert_eq!(offline.len(), 1);
        assert_eq!(offline[0].r#type, "offline");
    }

    #[test]
    fn runtime_lookup_keeps_legacy_local_source_queryable_for_bound_fallback() {
        let store = store("runtime_legacy_local_source");
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO comics(id,title) VALUES('comic-legacy','Legacy');
                         INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online)
                         VALUES('comic-legacy','legacy-runtime','local','book.cbz','archive',1);",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        assert!(store
            .get_runtime_items_for_source("legacy-runtime", "local:captured-root")
            .unwrap()
            .is_empty());
        let legacy = store
            .get_runtime_items_for_source("legacy-runtime", "local")
            .unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].source_id, "local");
        assert_eq!(legacy[0].relative_path, "book.cbz");
    }

    #[test]
    fn unreadable_external_bookmarks_retain_offline_shelf_and_progress() {
        let store = store("unreadable_external_offline");
        store.with_connection(|connection| {
            connection.execute_batch(
                "INSERT INTO comics(id,title) VALUES('comic-a','A');
                 INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,actual_path,kind,online)
                 VALUES('comic-a','runtime-a','external:test','a.cbz','/external/a.cbz','external-archive',1);
                 INSERT INTO reading_progress(comic_id,current_page,total_pages,percent,updated_at)
                 VALUES('comic-a',7,20,35.0,'2026-09-01T00:00:00Z');"
            ).map_err(|error| error.to_string())
        }).unwrap();
        let shelf = store
            .overlay_library_with_options(Vec::new(), &BTreeSet::new(), true)
            .unwrap();
        assert_eq!(shelf.len(), 1);
        assert_eq!(shelf[0].r#type, "offline");
        assert_eq!(shelf[0].progress.current_page, 7);
        assert!(shelf[0].external_bookmark.is_none());
        assert!(store
            .overlay_library(Vec::new(), &BTreeSet::new())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn local_root_drift_rebinds_unique_fingerprint_and_retires_old_location() {
        let store = store("local_root_drift");
        let archive = std::env::temp_dir().join(format!(
            "comic_root_drift_{}_{}.zip",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&archive, b"same comic bytes across a remounted volume").unwrap();

        let mut old = comic("stable-runtime", "A1/book.zip");
        old.source_id = "local:old-root".into();
        old.source_path = Some(archive.to_string_lossy().into_owned());
        store.sync_library(&[old]).unwrap();

        let mut current = comic("stable-runtime", "A1/book.zip");
        current.source_id = "local:new-root".into();
        current.source_path = Some(archive.to_string_lossy().into_owned());
        store.sync_library(&[current]).unwrap();

        store
            .with_connection(|connection| {
                let comic_count: i64 = connection
                    .query_row("SELECT COUNT(*) FROM comics", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                let old_online: i64 = connection
                    .query_row(
                        "SELECT online FROM comic_locations WHERE source_id='local:old-root'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let new_online: i64 = connection
                    .query_row(
                        "SELECT online FROM comic_locations WHERE source_id='local:new-root'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(comic_count, 1);
                assert_eq!(old_online, 0);
                assert_eq!(new_online, 1);
                Ok(())
            })
            .unwrap();
        std::fs::remove_file(archive).unwrap();
    }

    #[test]
    fn mixed_local_and_external_sync_retires_stale_external_locations() {
        let store = store("mixed_source_retirement");
        let mut old_smb = comic("old-smb", "old.zip");
        old_smb.source_id = "smb".into();
        store.sync_library(&[old_smb]).unwrap();

        let mut local = comic("current-local", "local.zip");
        local.source_id = "local:current-root".into();
        let mut current_smb = comic("current-smb", "current.zip");
        current_smb.source_id = "smb".into();
        store.sync_library(&[local, current_smb]).unwrap();

        store
            .with_connection(|connection| {
                let old_online: i64 = connection
                    .query_row(
                        "SELECT online FROM comic_locations WHERE source_id='smb' AND relative_path='old.zip'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let current_online: i64 = connection
                    .query_row(
                        "SELECT online FROM comic_locations WHERE source_id='smb' AND relative_path='current.zip'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(old_online, 0);
                assert_eq!(current_online, 1);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn manual_field_and_tag_overrides_are_transactional_and_undoable() {
        let store = store("batch");
        store.sync_library(&[comic("runtime", "a.zip")]).unwrap();
        let result = store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::from([("title".into(), Some("人工標題".into()))]),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "百合".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        let view = store.get_metadata("runtime").unwrap();
        assert_eq!(view.title, "人工標題");
        assert!(view.tags.iter().any(|tag| tag.value == "百合"));
        store.undo_batch(&result.undo_token).unwrap();
        assert_eq!(store.get_metadata("runtime").unwrap().title, "a");
    }

    #[test]
    fn source_qualified_batch_targets_reject_stale_location_and_roll_back_all() {
        let store = store("batch_source_targets");
        let mut first = comic("shared-runtime", "A/book.cbz");
        first.source_id = "external:a".into();
        let mut second = comic("shared-runtime", "B/book.cbz");
        second.source_id = "external:b".into();
        store.sync_library(&[first, second]).unwrap();

        let stale = BatchEditTarget {
            runtime_id: "shared-runtime".into(),
            source_id: "external:a".into(),
            relative_path: "A/book.cbz".into(),
        };
        let current = BatchEditTarget {
            runtime_id: "shared-runtime".into(),
            source_id: "external:b".into(),
            relative_path: "B/book.cbz".into(),
        };
        let before = store.get_metadata("shared-runtime").err();
        assert!(before.is_some(), "兩個在線來源時 runtime ID 應保持歧義");
        store.forget_source_locations("external:a").unwrap();
        let before_current = store.get_metadata("shared-runtime").unwrap();

        let legacy_error = store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["shared-runtime".into()],
                targets: vec![],
                fields: BTreeMap::from([("title".into(), Some("舊 API 不應漂移".into()))]),
                ..Default::default()
            })
            .unwrap_err();
        assert!(legacy_error.contains("舊版 id-only"));
        assert_eq!(
            store.get_metadata("shared-runtime").unwrap().title,
            before_current.title
        );

        let error = store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["shared-runtime".into(), "shared-runtime".into()],
                targets: vec![stale, current],
                fields: BTreeMap::from([("title".into(), Some("不可部分套用".into()))]),
                ..Default::default()
            })
            .unwrap_err();
        assert!(error.contains("找不到批次目標"));
        assert_eq!(
            store.get_metadata("shared-runtime").unwrap().title,
            before_current.title,
            "stale target 應讓整批 rollback"
        );
    }

    #[test]
    fn source_qualified_batch_target_requires_exact_path_and_allows_same_work_locations() {
        let store = store("batch_source_path");
        let mut item = comic("runtime", "A/book.cbz");
        item.source_id = "external:a".into();
        store.sync_library(&[item]).unwrap();
        let comic_id = store.get_metadata("runtime").unwrap().comic_id;
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online) VALUES(?1,?2,?3,?4,'archive',1)",
                        params![comic_id, "runtime", "external:b", "B/book.cbz"],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let wrong_path = BatchEditTarget {
            runtime_id: "runtime".into(),
            source_id: "external:a".into(),
            relative_path: "A/renamed.cbz".into(),
        };
        assert!(store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![wrong_path],
                fields: BTreeMap::from([("title".into(), Some("不應套用".into()))]),
                ..Default::default()
            })
            .is_err());

        let result = store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into(), "runtime".into()],
                targets: vec![
                    BatchEditTarget {
                        runtime_id: "runtime".into(),
                        source_id: "external:a".into(),
                        relative_path: "A/book.cbz".into(),
                    },
                    BatchEditTarget {
                        runtime_id: "runtime".into(),
                        source_id: "external:b".into(),
                        relative_path: "B/book.cbz".into(),
                    },
                ],
                fields: BTreeMap::from([("title".into(), Some("同作品安全套用".into()))]),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(result.updated, 1);
        assert_eq!(
            store.get_metadata("runtime").unwrap().title,
            "同作品安全套用"
        );
    }

    #[test]
    fn legacy_batch_id_only_accepts_canonical_id_but_rejects_runtime_only_id() {
        let store = store("batch_legacy_id_only");
        store
            .sync_library(&[comic("runtime", "legacy.cbz")])
            .unwrap();
        let canonical_id = store.get_metadata("runtime").unwrap().comic_id;
        assert!(store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![],
                fields: BTreeMap::from([("title".into(), Some("拒絕漂移".into()))]),
                ..Default::default()
            })
            .is_err());
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec![canonical_id],
                fields: BTreeMap::from([("title".into(), Some("canonical 安全".into()))]),
                ..Default::default()
            })
            .unwrap();
    }

    #[test]
    fn version_seven_upgrade_rebuilds_cjk_trigram_fts() {
        let path = std::env::temp_dir().join(format!(
            "comic_catalog_v7_{}_{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
            )
            .unwrap();
        for (version, sql) in MIGRATIONS.iter().filter(|(version, _)| *version <= 7) {
            connection.execute_batch(sql).unwrap();
            connection
                .execute(
                    "INSERT INTO schema_migrations(version, applied_at) VALUES(?1, CURRENT_TIMESTAMP)",
                    [version],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO comics(id,title) VALUES('cjk','測試漫畫標題')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online) VALUES('cjk','cjk','local','測試漫畫標題.zip','archive',1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES('cjk','測試漫畫標題','','測試漫畫標題.zip','','','')",
                [],
            )
            .unwrap();
        drop(connection);

        let store = CatalogStore::new(path).unwrap();
        let result = store
            .search(CatalogQuery {
                query: "漫畫".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].comic_id, "cjk");
    }

    #[test]
    fn short_gram_index_handles_cjk_latin_punctuation_and_refreshes() {
        let store = store("short_gram_index");
        store
            .sync_library(&[comic("runtime", "short/book.zip")])
            .unwrap();
        let comic_id = store.get_metadata("runtime").unwrap().comic_id;
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec![comic_id.clone()],
                targets: vec![],
                fields: BTreeMap::from([("title".into(), Some("Ab!漫畫".into()))]),
                ..Default::default()
            })
            .unwrap();

        for query in ["A", "Ab", "漫", "漫畫", "!"] {
            let result = store
                .search(CatalogQuery {
                    query: query.into(),
                    offset: 0,
                    limit: 20,
                })
                .unwrap();
            assert_eq!(result.total, 1, "query={query}");
            assert_eq!(result.items[0].comic_id, comic_id, "query={query}");
        }

        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec![comic_id.clone()],
                fields: BTreeMap::from([("title".into(), Some("更新後!".into()))]),
                ..Default::default()
            })
            .unwrap();
        let removed = store
            .search(CatalogQuery {
                query: "漫畫".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(removed.total, 0);
        let refreshed = store
            .search(CatalogQuery {
                query: "!".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(refreshed.total, 1);
    }

    #[test]
    fn short_search_pagination_follows_catalog_recency_order() {
        let store = store("short_search_order");
        store
            .sync_library(&[
                comic("runtime-old", "old!.zip"),
                comic("runtime-new", "new!.zip"),
                comic("runtime-mid", "mid!.zip"),
            ])
            .unwrap();
        let old_id = store.get_metadata("runtime-old").unwrap().comic_id;
        let new_id = store.get_metadata("runtime-new").unwrap().comic_id;
        let mid_id = store.get_metadata("runtime-mid").unwrap().comic_id;
        store
            .with_connection(|connection| {
                for (id, updated_at) in [
                    (&old_id, "2026-01-01"),
                    (&new_id, "2026-03-01"),
                    (&mid_id, "2026-02-01"),
                ] {
                    connection
                        .execute(
                            "UPDATE comics SET updated_at=?2 WHERE id=?1",
                            params![id, updated_at],
                        )
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })
            .unwrap();
        let first = store
            .search(CatalogQuery {
                query: "!".into(),
                offset: 0,
                limit: 2,
            })
            .unwrap();
        let second = store
            .search(CatalogQuery {
                query: "!".into(),
                offset: 2,
                limit: 2,
            })
            .unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(
            first
                .items
                .iter()
                .map(|item| &item.comic_id)
                .collect::<Vec<_>>(),
            vec![&new_id, &mid_id]
        );
        assert_eq!(
            second
                .items
                .iter()
                .map(|item| &item.comic_id)
                .collect::<Vec<_>>(),
            vec![&old_id]
        );
    }

    #[test]
    fn undo_reverts_only_its_own_delta_and_preserves_later_edits() {
        let store = store("delta_safe_undo");
        store.sync_library(&[comic("runtime", "undo.zip")]).unwrap();
        let first = store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::from([("title".into(), Some("第一版標題".into()))]),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "第一批標籤".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::from([
                    ("title".into(), Some("後續標題".into())),
                    ("series".into(), Some("後續系列".into())),
                ]),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "後續標籤".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();

        assert_eq!(store.undo_batch(&first.undo_token).unwrap(), 1);
        let view = store.get_metadata("runtime").unwrap();
        assert_eq!(view.title, "後續標題");
        assert_eq!(view.series.as_deref(), Some("後續系列"));
        assert!(!view.tags.iter().any(|tag| tag.value == "第一批標籤"));
        assert!(view.tags.iter().any(|tag| tag.value == "後續標籤"));
    }

    #[test]
    fn legacy_undo_snapshot_is_rejected_without_mutation() {
        let store = store("legacy_undo");
        store
            .sync_library(&[comic("runtime", "legacy.zip")])
            .unwrap();
        let applied = store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::from([("title".into(), Some("保留標題".into()))]),
                add_tags: vec![],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE batch_operations SET snapshot_json='{}' WHERE token=?1",
                        [&applied.undo_token],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(store.undo_batch(&applied.undo_token).is_err());
        assert_eq!(store.get_metadata("runtime").unwrap().title, "保留標題");
    }

    #[test]
    fn folder_rules_accumulate_but_exclude_wins() {
        let store = store("rules");
        store
            .sync_library(&[comic("runtime", "父層/子層/a.zip")])
            .unwrap();
        let tag = ScopedTag {
            namespace: "general".into(),
            value: "百合".into(),
        };
        store
            .upsert_folder_rule(FolderTagRule {
                id: None,
                source_id: "local".into(),
                folder_path: "父層".into(),
                tag: tag.clone(),
                enabled: true,
            })
            .unwrap();
        assert!(store.get_metadata("runtime").unwrap().tags.contains(&tag));
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![],
                exclude_tags: vec![tag.clone()],
            })
            .unwrap();
        assert!(!store.get_metadata("runtime").unwrap().tags.contains(&tag));
    }

    #[test]
    fn reimport_rejects_oversized_explicit_requests_before_resolving_targets() {
        let store = store("reimport_limit");
        let target = BatchEditTarget {
            runtime_id: "runtime".into(),
            source_id: "local".into(),
            relative_path: "book.cbz".into(),
        };
        let result = store.reimport(ReimportRequest {
            comic_ids: vec![],
            targets: vec![target; 10_001],
        });
        assert!(result.unwrap_err().contains("10,000"));
    }

    #[test]
    fn reimport_updates_unlocked_fields_but_preserves_manual_title() {
        let store = store("reimport_lock");
        let folder = std::env::temp_dir().join(format!("comic_metadata_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join("ComicInfo.xml"),
            "<ComicInfo><Title>來源標題</Title><Summary>第一版摘要</Summary></ComicInfo>",
        )
        .unwrap();
        let mut item = comic("runtime", "測試漫畫");
        item.r#type = "folder".into();
        item.source_path = Some(folder.to_string_lossy().into_owned());
        store.sync_library(&[item]).unwrap();
        let stable_id = store.get_metadata("runtime").unwrap().comic_id;
        let reimport_target = BatchEditTarget {
            runtime_id: "runtime".into(),
            source_id: "local".into(),
            relative_path: "測試漫畫".into(),
        };
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec![stable_id.clone()],
                targets: vec![],
                fields: BTreeMap::from([("title".into(), Some("人工標題".into()))]),
                add_tags: vec![],
                exclude_tags: vec![],
            })
            .unwrap();
        std::fs::write(
            folder.join("ComicInfo.xml"),
            "<ComicInfo><Title>新版來源標題</Title><Summary>第二版摘要</Summary></ComicInfo>",
        )
        .unwrap();
        store
            .reimport(ReimportRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![reimport_target],
            })
            .unwrap();
        let view = store.get_metadata("runtime").unwrap();
        assert_eq!(view.title, "人工標題");
        assert_eq!(view.summary.as_deref(), Some("第二版摘要"));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn reimport_preserves_failed_metadata_and_clears_removed_metadata() {
        let store = store("reimport_failure_recovery");
        let folder =
            std::env::temp_dir().join(format!("comic_metadata_failure_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let metadata_path = folder.join("ComicInfo.xml");
        std::fs::write(
            &metadata_path,
            "<ComicInfo><Title>原始來源標題</Title><Summary>保留摘要</Summary></ComicInfo>",
        )
        .unwrap();
        let mut item = comic("runtime", "失敗恢復測試");
        item.r#type = "folder".into();
        item.source_path = Some(folder.to_string_lossy().into_owned());
        store.sync_library(&[item]).unwrap();
        let reimport_target = BatchEditTarget {
            runtime_id: "runtime".into(),
            source_id: "local".into(),
            relative_path: "失敗恢復測試".into(),
        };
        assert_eq!(
            store.get_metadata("runtime").unwrap().summary.as_deref(),
            Some("保留摘要")
        );

        std::fs::write(&metadata_path, "<ComicInfo><Title>未完成").unwrap();
        let failed = store
            .reimport(ReimportRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![reimport_target.clone()],
            })
            .unwrap();
        assert!(failed.diagnostics > 0);
        let preserved = store.get_metadata("runtime").unwrap();
        assert_eq!(preserved.title, "原始來源標題");
        assert_eq!(preserved.summary.as_deref(), Some("保留摘要"));

        std::fs::write(
            &metadata_path,
            "<ComicInfo><Title>恢復來源標題</Title><Summary>恢復摘要</Summary></ComicInfo>",
        )
        .unwrap();
        store
            .reimport(ReimportRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![reimport_target.clone()],
            })
            .unwrap();
        let recovered = store.get_metadata("runtime").unwrap();
        assert_eq!(recovered.title, "恢復來源標題");
        assert_eq!(recovered.summary.as_deref(), Some("恢復摘要"));

        std::fs::remove_file(metadata_path).unwrap();
        store
            .reimport(ReimportRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![reimport_target],
            })
            .unwrap();
        let removed = store.get_metadata("runtime").unwrap();
        assert_eq!(
            removed.title,
            folder.file_name().unwrap().to_string_lossy().into_owned()
        );
        assert!(removed.summary.is_none());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn metadata_refresh_is_scoped_to_each_shared_fingerprint_location() {
        let store = store("metadata_location_scope");
        let root = std::env::temp_dir().join(format!(
            "comic_metadata_locations_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let location_a = root.join("a");
        let location_b = root.join("b");
        std::fs::create_dir_all(&location_a).unwrap();
        std::fs::create_dir_all(&location_b).unwrap();
        let sidecar_a = location_a.join("ComicInfo.xml");
        let sidecar_b = location_b.join("ComicInfo.xml");
        std::fs::write(
            &sidecar_a,
            "<ComicInfo><Title>A 來源</Title><Tags>來源A</Tags></ComicInfo>",
        )
        .unwrap();
        std::fs::write(
            &sidecar_b,
            "<ComicInfo><Title>B 來源</Title><Tags>來源B</Tags></ComicInfo>",
        )
        .unwrap();

        let mut item_a = comic("runtime-a", "a");
        item_a.r#type = "folder".into();
        item_a.source_id = "local:a".into();
        item_a.source_path = Some(location_a.to_string_lossy().into_owned());
        let mut item_b = comic("runtime-b", "b");
        item_b.r#type = "folder".into();
        item_b.source_id = "local:b".into();
        item_b.source_path = Some(location_b.to_string_lossy().into_owned());

        store
            .sync_library(&[item_a.clone(), item_b.clone()])
            .unwrap();
        let shared_id = store.get_metadata("runtime-a").unwrap().comic_id;
        assert_eq!(
            shared_id,
            store.get_metadata("runtime-b").unwrap().comic_id,
            "同 fingerprint 的兩個 location 應共用 comic_id"
        );
        let initial_paths = store
            .with_connection(|connection| {
                let mut statement = connection
                    .prepare("SELECT source_path FROM metadata_sources WHERE comic_id=?1")
                    .map_err(|error| error.to_string())?;
                let rows = statement
                    .query_map([shared_id.as_str()], |row| row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(initial_paths
            .iter()
            .any(|path| path.ends_with("a/ComicInfo.xml")));
        assert!(initial_paths
            .iter()
            .any(|path| path.ends_with("b/ComicInfo.xml")));
        let initial_tags = store.get_metadata("runtime-a").unwrap().tags;
        assert!(initial_tags.iter().any(|tag| tag.value == "來源A"));
        assert!(initial_tags.iter().any(|tag| tag.value == "來源B"));

        std::fs::remove_file(&sidecar_b).unwrap();
        std::fs::write(&sidecar_b, "<ComicInfo><Title>未完成").unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET mtime='force-refresh' WHERE source_id='local:b'",
                        [],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        store
            .sync_library(&[item_a.clone(), item_b.clone()])
            .unwrap();
        let after_b_failure = store.get_metadata("runtime-a").unwrap();
        assert!(after_b_failure
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("a/ComicInfo.xml")));
        assert!(after_b_failure
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("b/ComicInfo.xml")));
        assert!(after_b_failure.tags.iter().any(|tag| tag.value == "來源A"));
        assert!(after_b_failure.tags.iter().any(|tag| tag.value == "來源B"));

        std::fs::remove_file(&sidecar_a).unwrap();
        std::fs::write(
            &sidecar_a,
            "<ComicInfo><Title>A 更新</Title><Tags>來源A更新</Tags></ComicInfo>",
        )
        .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET mtime='force-refresh' WHERE source_id='local:a'",
                        [],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        store.sync_library(std::slice::from_ref(&item_a)).unwrap();
        let after_partial_a = store.get_metadata("runtime-a").unwrap();
        assert!(after_partial_a
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("b/ComicInfo.xml")));

        std::fs::remove_file(&sidecar_a).unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET mtime='force-refresh' WHERE source_id='local:a'",
                        [],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        store.sync_library(std::slice::from_ref(&item_a)).unwrap();
        let after_a_removed = store.get_metadata("runtime-a").unwrap();
        assert!(!after_a_removed
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("a/ComicInfo.xml")));
        assert!(after_a_removed
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("b/ComicInfo.xml")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_scope_matches_archive_entries_and_json_siblings() {
        assert!(source_path_matches_location(
            "/library/book.cbz::ComicInfo.xml",
            "/library/book.cbz"
        ));
        assert!(source_path_matches_location(
            "/library/book.cbz.json",
            "/library/book.cbz"
        ));
        assert!(source_path_matches_location(
            "/library/book.json",
            "/library/book.cbz"
        ));
        assert!(!source_path_matches_location(
            "/library/other.cbz::ComicInfo.xml",
            "/library/book.cbz"
        ));
    }

    #[test]
    fn sync_rechecks_folder_and_archive_metadata_signatures() {
        let store = store("signature_refresh");
        let root = std::env::temp_dir().join(format!(
            "comic_signature_refresh_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let folder_path = root.join("folder-book");
        std::fs::create_dir_all(&folder_path).unwrap();
        let folder_metadata = folder_path.join("ComicInfo.xml");
        let folder_page = folder_path.join("page.jpg");
        std::fs::write(
            &folder_metadata,
            "<ComicInfo><Title>OldTitle</Title></ComicInfo>",
        )
        .unwrap();
        std::fs::write(&folder_page, vec![0_u8; 8192]).unwrap();
        let archive_path = root.join("archive-book.cbz");
        let archive_sidecar = root.join("archive-book.cbz.json");
        std::fs::write(&archive_path, vec![7_u8; 1024]).unwrap();
        std::fs::write(&archive_sidecar, r#"{"title":"Old","tags":["x"]}"#).unwrap();

        let mut folder_item = comic("folder-runtime", "folder-book");
        folder_item.r#type = "folder".into();
        folder_item.source_path = Some(folder_path.to_string_lossy().into_owned());
        let mut archive_item = comic("archive-runtime", "archive-book.cbz");
        archive_item.source_path = Some(archive_path.to_string_lossy().into_owned());
        store
            .sync_library(&[folder_item.clone(), archive_item.clone()])
            .unwrap();
        assert_eq!(
            store.get_metadata("folder-runtime").unwrap().title,
            "OldTitle"
        );
        assert_eq!(store.get_metadata("archive-runtime").unwrap().title, "Old");

        let folder_signature = file_signature(&folder_path).unwrap();
        assert_eq!(folder_signature, file_signature(&folder_path).unwrap());
        assert!(file_signature(&root.join("missing-location")).is_none());
        let archive_signature = file_signature(&archive_path).unwrap();
        assert_eq!(archive_signature, file_signature(&archive_path).unwrap());

        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &folder_metadata,
            "<ComicInfo><Title>NewTitle</Title></ComicInfo>",
        )
        .unwrap();
        let changed_folder_signature = file_signature(&folder_path).unwrap();
        assert_ne!(folder_signature, changed_folder_signature);
        store
            .sync_library(std::slice::from_ref(&folder_item))
            .unwrap();
        assert_eq!(
            store.get_metadata("folder-runtime").unwrap().title,
            "NewTitle"
        );

        let folder_fingerprint_before = store
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT fingerprint FROM comic_locations WHERE runtime_id='folder-runtime'",
                        [],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&folder_page, vec![1_u8; 8192]).unwrap();
        store
            .sync_library(std::slice::from_ref(&folder_item))
            .unwrap();
        let folder_fingerprint_after = store
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT fingerprint FROM comic_locations WHERE runtime_id='folder-runtime'",
                        [],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert_ne!(folder_fingerprint_before, folder_fingerprint_after);

        std::fs::remove_file(&folder_metadata).unwrap();
        store
            .sync_library(std::slice::from_ref(&folder_item))
            .unwrap();
        let folder_after_removal = store.get_metadata("folder-runtime").unwrap();
        assert_eq!(folder_after_removal.title, "folder-book");
        assert!(!folder_after_removal
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("ComicInfo.xml")));

        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&archive_sidecar, r#"{"title":"New","tags":["x"]}"#).unwrap();
        let changed_archive_signature = file_signature(&archive_path).unwrap();
        assert_ne!(archive_signature, changed_archive_signature);
        store
            .sync_library(std::slice::from_ref(&archive_item))
            .unwrap();
        assert_eq!(store.get_metadata("archive-runtime").unwrap().title, "New");

        std::fs::remove_file(&archive_sidecar).unwrap();
        store
            .sync_library(std::slice::from_ref(&archive_item))
            .unwrap();
        let archive_after_removal = store.get_metadata("archive-runtime").unwrap();
        assert_eq!(archive_after_removal.title, "archive-book");
        assert!(!archive_after_removal
            .candidates
            .iter()
            .any(|candidate| candidate.source_path.ends_with("archive-book.cbz.json")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn batch_search_views_match_individual_effective_metadata_matrix() {
        let store = store("batch_search_views_matrix");
        store
            .sync_library(&[
                comic("runtime-a", "library/a.zip"),
                comic("runtime-b", "folder/b.zip"),
                comic("runtime-c", "other/c.zip"),
                comic("runtime-d", "library/d.zip"),
            ])
            .unwrap();
        let ids = ["runtime-a", "runtime-b", "runtime-c", "runtime-d"]
            .into_iter()
            .map(|runtime_id| store.get_metadata(runtime_id).unwrap().comic_id)
            .collect::<Vec<_>>();

        store
            .with_connection(|connection| {
                let tx = connection.transaction().map_err(|error| error.to_string())?;
                let insert_source =
                    |tx: &Transaction<'_>, comic_id: &str, parser_id: &str| -> Result<i64, String> {
                        tx.execute(
                            "INSERT INTO metadata_sources(comic_id,parser_id,parser_version,source_path,source_digest,confidence,raw_json)
                             VALUES(?1,?2,'1','synthetic',?2,1.0,'{}')",
                            params![comic_id, parser_id],
                        )
                        .map_err(|error| error.to_string())?;
                        Ok(tx.last_insert_rowid())
                    };
                let insert_creator = |tx: &Transaction<'_>, comic_id: &str, source_id: i64, value: &str, priority: i64| {
                    tx.execute(
                        "INSERT INTO metadata_candidates(comic_id,source_id,field_key,value_json,priority,confidence)
                         VALUES(?1,?2,'creators',?3,?4,0.5)",
                        params![comic_id, source_id, value, priority],
                    )
                    .map_err(|error| error.to_string())
                };

                let a_low = insert_source(&tx, &ids[0], "synthetic:a-low")?;
                let a_high = insert_source(&tx, &ids[0], "synthetic:a-high")?;
                insert_creator(
                    &tx,
                    &ids[0],
                    a_low,
                    r#"{"artist":["candidate-low"]}"#,
                    10,
                )?;
                insert_creator(
                    &tx,
                    &ids[0],
                    a_high,
                    r#"{"artist":["candidate-high"]}"#,
                    20,
                )?;
                tx.execute(
                    "INSERT INTO user_field_overrides(comic_id,field_key,value_json) VALUES(?1,'creators',?2)",
                    params![&ids[0], r#"{"artist":["manual"]}"#],
                )
                .map_err(|error| error.to_string())?;

                let b_low = insert_source(&tx, &ids[1], "synthetic:b-low")?;
                let b_high = insert_source(&tx, &ids[1], "synthetic:b-high")?;
                insert_creator(
                    &tx,
                    &ids[1],
                    b_low,
                    r#"{"artist":["candidate-low"]}"#,
                    10,
                )?;
                insert_creator(
                    &tx,
                    &ids[1],
                    b_high,
                    r#"{"artist":["candidate-high"]}"#,
                    20,
                )?;

                let c_source = insert_source(&tx, &ids[2], "synthetic:c")?;
                let _d_source = insert_source(&tx, &ids[3], "synthetic:d")?;
                let raw_a = ensure_tag_tx(
                    &tx,
                    &ScopedTag {
                        namespace: "general".into(),
                        value: "raw-a".into(),
                    },
                )?;
                let raw_b = ensure_tag_tx(
                    &tx,
                    &ScopedTag {
                        namespace: "general".into(),
                        value: "raw-b".into(),
                    },
                )?;
                let raw_c = ensure_tag_tx(
                    &tx,
                    &ScopedTag {
                        namespace: "general".into(),
                        value: "raw-c".into(),
                    },
                )?;
                let canonical_a: i64 = tx
                    .query_row(
                        "SELECT canonical_tag_id FROM tags WHERE id=?1",
                        [raw_a],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let canonical_b: i64 = tx
                    .query_row(
                        "SELECT canonical_tag_id FROM tags WHERE id=?1",
                        [raw_b],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let canonical_c: i64 = tx
                    .query_row(
                        "SELECT canonical_tag_id FROM tags WHERE id=?1",
                        [raw_c],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE canonical_tags SET display_value='renamed-a' WHERE id=?1",
                    [canonical_a],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO tag_redirects(source_tag_id,target_tag_id) VALUES(?1,?2)",
                    params![canonical_b, canonical_a],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE canonical_tags SET disabled=1 WHERE id=?1",
                    [canonical_c],
                )
                .map_err(|error| error.to_string())?;

                tx.execute(
                    "INSERT INTO comic_tag_candidates(comic_id,tag_id,source_id) VALUES(?1,?2,?3)",
                    params![&ids[0], raw_a, a_low],
                )
                .map_err(|error| error.to_string())?;
                for raw_id in [raw_a, raw_b] {
                    tx.execute(
                        "INSERT INTO comic_tag_candidates(comic_id,tag_id,source_id) VALUES(?1,?2,?3)",
                        params![&ids[1], raw_id, b_low],
                    )
                    .map_err(|error| error.to_string())?;
                }
                tx.execute(
                    "INSERT INTO comic_tag_candidates(comic_id,tag_id,source_id) VALUES(?1,?2,?3)",
                    params![&ids[2], raw_c, c_source],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_tag_overrides(comic_id,tag_id,action) VALUES(?1,?2,'include')",
                    params![&ids[1], raw_a],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_tag_overrides(comic_id,tag_id,action) VALUES(?1,?2,'exclude')",
                    params![&ids[1], raw_b],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO folder_tag_rules(source_id,folder_path,tag_id,enabled) VALUES('local','library',?1,1)",
                    [raw_a],
                )
                .map_err(|error| error.to_string())?;

                tx.execute(
                    "UPDATE comic_locations SET runtime_id='d-old',relative_path='library/d-old.zip',last_seen_at='2026-01-01T00:00:00Z' WHERE comic_id=?1",
                    [&ids[3]],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online,last_seen_at)
                     VALUES(?1,'d-new','local','library/d-new.zip','archive',1,'2026-02-01T00:00:00Z')",
                    [&ids[3]],
                )
                .map_err(|error| error.to_string())?;
                tx.commit().map_err(|error| error.to_string())
            })
            .unwrap();

        store
            .with_connection(|connection| {
                let batch = build_search_views_batch(connection)?;
                for comic_id in &ids {
                    let expected = build_search_view(connection, comic_id)?;
                    let actual = batch
                        .get(comic_id)
                        .ok_or_else(|| format!("missing batch view for {comic_id}"))?;
                    assert_eq!(actual.runtime_id, expected.runtime_id, "runtime {comic_id}");
                    assert_eq!(
                        actual.relative_path, expected.relative_path,
                        "path {comic_id}"
                    );
                    assert_eq!(actual.source_id, expected.source_id, "source {comic_id}");
                    assert_eq!(actual.creators, expected.creators, "creators {comic_id}");
                    assert_eq!(actual.tags, expected.tags, "tags {comic_id}");
                }
                assert_eq!(batch[&ids[0]].creators["artist"], vec!["manual"]);
                assert_eq!(batch[&ids[1]].creators["artist"], vec!["candidate-high"]);
                assert_eq!(batch[&ids[1]].tags, Vec::<ScopedTag>::new());
                assert_eq!(batch[&ids[2]].tags, Vec::<ScopedTag>::new());
                assert_eq!(batch[&ids[3]].runtime_id.as_deref(), Some("d-new"));
                assert_eq!(
                    batch[&ids[3]].tags,
                    vec![ScopedTag {
                        namespace: "general".into(),
                        value: "renamed-a".into(),
                    }]
                );
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn selective_search_stays_fast_with_twenty_thousand_rows() {
        let store = store("search_20k");
        store.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            for index in 0..20_000 {
                let id = format!("comic-{index}");
                let title = format!("測試漫畫 needle{index}");
                tx.execute("INSERT INTO comics(id,title) VALUES(?1,?2)", params![id, title]).map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online) VALUES(?1,?1,'synthetic',?2,'archive',1)",
                    params![id, format!("{index}.zip")],
                ).map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES(?1,?2,'','', '', '', '')",
                    params![id, title],
                ).map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())
        }).unwrap();
        let mut samples = Vec::new();
        for _ in 0..20 {
            let started = std::time::Instant::now();
            let result = store
                .search(CatalogQuery {
                    query: "needle19999".into(),
                    offset: 0,
                    limit: 100,
                })
                .unwrap();
            assert_eq!(result.total, 1);
            samples.push(started.elapsed());
        }
        samples.sort();
        if std::env::var_os("GAI_PERF_TEST").is_some() {
            assert!(
                samples[18] < Duration::from_millis(200),
                "p95 was {:?}",
                samples[18]
            );
            let started = std::time::Instant::now();
            let exclusion_only = store
                .search(CatalogQuery {
                    query: "-tag:不存在基準標籤".into(),
                    offset: 0,
                    limit: 100,
                })
                .unwrap();
            println!(
                "exclusion-only 20k elapsed: {:?}, total: {}",
                started.elapsed(),
                exclusion_only.total
            );
        }
    }

    #[test]
    fn search_finds_short_cjk_substrings_with_cursor_fallback() {
        let store = store("search_cjk_substring");
        store
            .sync_library(&[comic("runtime", "測試漫畫標題.zip")])
            .unwrap();
        let result = store
            .search(CatalogQuery {
                query: "漫畫".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items[0].title, "測試漫畫標題");
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::from([("title".into(), Some("手動標題".into()))]),
                add_tags: vec![],
                exclude_tags: vec![],
            })
            .unwrap();
        let path_result = store
            .search(CatalogQuery {
                query: "漫畫".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(path_result.total, 1);
        assert_eq!(path_result.items[0].title, "手動標題");
        let trigram_result = store
            .search(CatalogQuery {
                query: "漫畫標".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(trigram_result.total, 1);
    }

    #[test]
    fn empty_search_paginates_without_materializing_the_full_catalog() {
        let store = store("empty_search_page");
        store
            .with_connection(|connection| {
                let tx = connection
                    .transaction()
                    .map_err(|error| error.to_string())?;
                for index in 0..500 {
                    tx.execute(
                        "INSERT INTO comics(id,title) VALUES(?1,?2)",
                        params![format!("comic-{index}"), format!("漫畫 {index}")],
                    )
                    .map_err(|error| error.to_string())?;
                    tx.execute(
                        "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind)
                         VALUES(?1,?2,'synthetic',?3,'archive')",
                        params![
                            format!("comic-{index}"),
                            format!("runtime-{index}"),
                            format!("book-{index}.cbz")
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                }
                tx.commit().map_err(|error| error.to_string())
            })
            .unwrap();
        let result = store
            .search(CatalogQuery {
                query: String::new(),
                offset: 240,
                limit: 25,
            })
            .unwrap();
        assert_eq!(result.total, 500);
        assert_eq!(result.items.len(), 25);
    }

    #[test]
    fn search_excludes_locationless_orphans_but_keeps_offline_locations() {
        let store = store("search_locationless_orphan");
        let mut orphan = comic("orphan-runtime", "orphan.cbz");
        orphan.source_id = "external:gone".into();
        let mut offline = comic("offline-runtime", "offline.cbz");
        offline.source_id = "external:kept".into();
        store.sync_library(&[orphan, offline]).unwrap();
        let (orphan_id, offline_id) = store
            .with_connection(|connection| {
                let orphan_id = connection
                    .query_row(
                        "SELECT comic_id FROM comic_locations WHERE runtime_id='orphan-runtime'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())?;
                let offline_id = connection
                    .query_row(
                        "SELECT comic_id FROM comic_locations WHERE runtime_id='offline-runtime'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())?;
                Ok((orphan_id, offline_id))
            })
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comics SET title='stabletitle' WHERE id IN (?1,?2)",
                        params![&orphan_id, &offline_id],
                    )
                    .map_err(|error| error.to_string())?;
                refresh_fts_batch(
                    connection,
                    &BTreeSet::from([orphan_id.clone(), offline_id.clone()]),
                )
            })
            .unwrap();
        store.forget_source_locations("external:gone").unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comics SET title='孤兒資料' WHERE id=?1",
                        [&orphan_id],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute("UPDATE comics SET offline=1 WHERE id=?1", [&offline_id])
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "UPDATE comic_locations SET online=0 WHERE runtime_id='offline-runtime'",
                        [],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let empty = store
            .search(CatalogQuery {
                query: String::new(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(empty.total, 1);
        assert_eq!(empty.items.len(), 1);
        assert_eq!(
            empty.items[0].runtime_id.as_deref(),
            Some("offline-runtime")
        );
        assert!(empty.items[0].offline);

        // The direct title update intentionally does not refresh FTS. The
        // stale indexed candidate must still be filtered by the location
        // predicate, while the remaining offline location is hydrated from
        // the same read snapshot with its current title.
        let stale_index_query = store
            .search(CatalogQuery {
                query: "stabletitle".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(stale_index_query.total, 1);
        assert_eq!(
            stale_index_query.items[0].runtime_id.as_deref(),
            Some("offline-runtime")
        );
        assert_eq!(stale_index_query.items[0].title, "stabletitle");
    }

    #[test]
    fn search_attaches_all_locations_for_one_work() {
        let store = store("search_all_locations");
        let mut item = comic("shared-runtime", "online/book.cbz");
        item.source_id = "external:online".into();
        store.sync_library(&[item]).unwrap();
        let comic_id = store
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT comic_id FROM comic_locations WHERE runtime_id='shared-runtime'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,online)
                         VALUES(?1,'retired-runtime','external:offline','offline/book.cbz','archive',0)",
                        [&comic_id],
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        let result = store
            .search(CatalogQuery {
                query: String::new(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.items.len(), 1);
        let locations = &result.items[0].locations;
        assert_eq!(locations.len(), 2);
        assert_eq!(locations[0].runtime_id.as_deref(), Some("shared-runtime"));
        assert_eq!(locations[0].source_id, "external:online");
        assert_eq!(locations[0].relative_path, "online/book.cbz");
        assert!(!locations[0].offline);
        assert_eq!(locations[1].runtime_id.as_deref(), Some("retired-runtime"));
        assert_eq!(locations[1].source_id, "external:offline");
        assert_eq!(locations[1].relative_path, "offline/book.cbz");
        assert!(locations[1].offline);

        let json = serde_json::to_value(&result.items[0]).unwrap();
        assert!(json["locations"][0].get("runtimeId").is_some());
        assert!(json["locations"][0].get("sourceId").is_some());
        assert!(json["locations"][0].get("relativePath").is_some());
        assert!(json["locations"][0].get("offline").is_some());
    }

    #[test]
    fn tag_alias_expands_search_without_rewriting_original_tag() {
        let store = store("tag_alias");
        store
            .sync_library(&[comic("runtime", "alias.zip")])
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "甜寵".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .upsert_tag_alias(TagAlias {
                namespace: " GENERAL ".into(),
                alias: " 甜文 ".into(),
                canonical_value: "甜寵".into(),
            })
            .unwrap();
        let result = store
            .search(CatalogQuery {
                query: "tag:甜文".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(result.total, 1);
        assert!(result.items[0].tags.iter().any(|tag| tag.value == "甜寵"));
        assert!(!result.items[0].tags.iter().any(|tag| tag.value == "甜文"));
        assert_eq!(store.tag_aliases().unwrap()[0].namespace, "general");
    }

    #[test]
    fn nfkc_lookup_unifies_compatible_forms_without_rewriting_display_text() {
        let store = store("nfkc_tags");
        store.sync_library(&[comic("runtime", "nfkc.zip")]).unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![ScopedTag {
                    namespace: "ＡＲＴＩＳＴ".into(),
                    value: "Ａｋａｍａｒｕ".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![ScopedTag {
                    namespace: "artist".into(),
                    value: "Akamaru".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .with_connection(|connection| {
                let canonical_count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM canonical_tags WHERE namespace='artist' AND normalized_value='akamaru'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                let display: String = connection
                    .query_row(
                        "SELECT display_value FROM canonical_tags WHERE namespace='artist' AND normalized_value='akamaru'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(canonical_count, 1);
                assert_eq!(display, "Ａｋａｍａｒｕ");
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn tag_inventory_counts_effective_works_and_ranks_user_state() {
        let store = store("tag_inventory");
        store
            .sync_library(&[comic("one", "one.zip"), comic("two", "two.zip")])
            .unwrap();
        let tag = ScopedTag {
            namespace: "type".into(),
            value: "HameCG".into(),
        };
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["one".into(), "two".into()],
                targets: vec![batch_target(&store, "one"), batch_target(&store, "two")],
                fields: BTreeMap::new(),
                add_tags: vec![tag.clone()],
                exclude_tags: vec![],
            })
            .unwrap();
        let initial = store
            .tag_inventory(TagInventoryQuery {
                query: "hame".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(initial.total, 1);
        assert_eq!(initial.items[0].work_count, 2);
        assert_eq!(initial.items[0].usage_count, 2);

        store
            .update_tag_state(TagStateUpdate {
                tag_id: initial.items[0].id,
                pinned: true,
                color_key: Some("fuchsia".into()),
            })
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["two".into()],
                targets: vec![batch_target(&store, "two")],
                fields: BTreeMap::new(),
                add_tags: vec![],
                exclude_tags: vec![tag],
            })
            .unwrap();
        let updated = store
            .tag_inventory(TagInventoryQuery {
                query: "hamecg".into(),
                offset: 0,
                limit: 20,
            })
            .unwrap();
        assert_eq!(updated.items[0].work_count, 1);
        assert!(updated.items[0].pinned);
        assert_eq!(updated.items[0].color_key.as_deref(), Some("fuchsia"));
    }

    #[test]
    fn tag_rename_merge_disable_and_undo_preserve_raw_evidence() {
        let store = store("tag_mutations");
        store
            .sync_library(&[comic("runtime", "mutations.zip")])
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![
                    ScopedTag {
                        namespace: "type".into(),
                        value: "Mange".into(),
                    },
                    ScopedTag {
                        namespace: "type".into(),
                        value: "Manga".into(),
                    },
                ],
                exclude_tags: vec![],
            })
            .unwrap();
        let inventory = store.tag_inventory(TagInventoryQuery::default()).unwrap();
        let source = inventory
            .items
            .iter()
            .find(|tag| tag.display_value == "Mange")
            .unwrap()
            .id;
        let target = inventory
            .items
            .iter()
            .find(|tag| tag.display_value == "Manga")
            .unwrap()
            .id;

        let merged = store.merge_tags(source, target).unwrap();
        let merged_view = store.get_metadata("runtime").unwrap();
        assert_eq!(
            merged_view
                .tags
                .iter()
                .filter(|tag| tag.namespace == "type")
                .count(),
            1
        );
        assert!(merged_view.tags.iter().any(|tag| tag.value == "Manga"));
        assert!(store.merge_tags(target, source).is_err());
        assert!(store.undo_tag_operation(&merged.undo_token).unwrap());
        let restored = store.get_metadata("runtime").unwrap();
        assert!(restored.tags.iter().any(|tag| tag.value == "Mange"));
        assert!(restored.tags.iter().any(|tag| tag.value == "Manga"));

        let renamed = store.rename_tag(target, "Manga 漫畫").unwrap();
        assert!(store
            .get_metadata("runtime")
            .unwrap()
            .tags
            .iter()
            .any(|tag| tag.value == "Manga 漫畫"));
        assert!(store.undo_tag_operation(&renamed.undo_token).unwrap());
        assert!(store
            .get_metadata("runtime")
            .unwrap()
            .tags
            .iter()
            .any(|tag| tag.value == "Manga"));

        let disabled = store.set_tag_disabled(source, true).unwrap();
        assert!(!store
            .get_metadata("runtime")
            .unwrap()
            .tags
            .iter()
            .any(|tag| tag.value == "Mange"));
        assert!(store.undo_tag_operation(&disabled.undo_token).unwrap());
        assert!(store
            .get_metadata("runtime")
            .unwrap()
            .tags
            .iter()
            .any(|tag| tag.value == "Mange"));

        store
            .with_connection(|connection| {
                let raw_tags: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM tags WHERE namespace='type' AND value IN ('Mange','Manga')",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(raw_tags, 2);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn ensure_tag_reuses_raw_tag_canonical_after_rename() {
        let store = store("tag_canonical_reuse");
        store
            .sync_library(&[comic("runtime", "canonical.zip")])
            .unwrap();
        let tag = ScopedTag {
            namespace: "type".into(),
            value: "原始標籤".into(),
        };
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![tag.clone()],
                exclude_tags: vec![],
            })
            .unwrap();
        let canonical_id: i64 = store
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT canonical_tag_id FROM tags WHERE namespace='type' AND normalized_value='原始標籤'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        store.rename_tag(canonical_id, "重新命名").unwrap();

        // The raw evidence still has the old spelling and points to the renamed
        // canonical row. Reusing it must not create an orphan canonical row.
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![tag],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .with_connection(|connection| {
                let canonical_count: i64 = connection
                    .query_row("SELECT COUNT(*) FROM canonical_tags", [], |row| row.get(0))
                    .map_err(|error| error.to_string())?;
                let current_canonical: i64 = connection
                    .query_row(
                        "SELECT canonical_tag_id FROM tags WHERE namespace='type' AND normalized_value='原始標籤'",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(canonical_count, 1);
                assert_eq!(current_canonical, canonical_id);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn ai_candidates_are_traceable_but_never_effective_until_manual_apply() {
        let store = store("ai_candidates");
        store.sync_library(&[comic("runtime", "ai.zip")]).unwrap();
        store
            .store_ai_candidates(
                "runtime",
                "openai",
                "gpt-5.6-luna",
                "[{\"field\":\"summary\"}]",
                vec![
                    ("summary".into(), json!("AI 摘要候選"), 0.82),
                    (
                        "tags".into(),
                        json!([{ "namespace": "general", "value": "百合" }]),
                        0.76,
                    ),
                ],
            )
            .unwrap();
        let view = store.get_metadata("runtime").unwrap();
        assert!(view
            .candidates
            .iter()
            .any(|candidate| candidate.parser_id == "ai:openai"));
        assert!(view.tags.is_empty());
        store
            .store_ai_candidates(
                "runtime",
                "openai",
                "gpt-5.6-luna",
                "[{\"field\":\"summary\"},{\"revision\":2}]",
                vec![("summary".into(), json!("第二版摘要"), 0.91)],
            )
            .unwrap();
        let refreshed = store.get_metadata("runtime").unwrap();
        assert_eq!(
            refreshed
                .candidates
                .iter()
                .filter(|candidate| candidate.parser_id == "ai:openai")
                .count(),
            1
        );
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
                targets: vec![batch_target(&store, "runtime")],
                fields: BTreeMap::new(),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "百合".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        assert!(store
            .get_metadata("runtime")
            .unwrap()
            .tags
            .iter()
            .any(|tag| tag.value == "百合"));
    }

    #[test]
    fn opened_location_registration_prevents_scan_commit_between_read_and_write() {
        let store = store("opened_location_busy_scan_writer");
        let retained = comic("retained-runtime", "retained.zip");
        store.sync_library(&[retained]).unwrap();
        let retained_title = store.get_metadata("retained-runtime").unwrap().title;
        let attempted = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&attempted);
        let database_path = store.path().to_owned();
        OPENED_LOCATION_READ_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                // Run exactly after registration reads its snapshot, before
                // its first write. A deferred transaction permits this other
                // connection's commit and then cannot upgrade its snapshot.
                let scan_connection = Connection::open(database_path).unwrap();
                scan_connection.busy_timeout(Duration::ZERO).unwrap();
                let result =
                    scan_connection.execute("UPDATE comics SET title='concurrent scan title'", []);
                assert!(matches!(result,
                    Err(rusqlite::Error::SqliteFailure(error, _))
                        if error.code == rusqlite::ErrorCode::DatabaseBusy));
                observed.store(true, Ordering::SeqCst);
            }));
        });
        let result = store.register_opened_location(&comic("new-runtime", "new.zip"), 2, false);
        OPENED_LOCATION_READ_HOOK.with(|slot| slot.borrow_mut().take());
        result.unwrap();
        assert!(attempted.load(Ordering::SeqCst));
        assert_eq!(
            store.get_metadata("retained-runtime").unwrap().title,
            retained_title
        );
        assert!(store.get_location("new-runtime").unwrap().online);
    }

    #[test]
    fn sync_batch_keeps_its_snapshot_against_a_competing_connection() {
        let store = store("sync_batch_immediate_race");
        store
            .sync_library(&[comic("old-runtime", "same.cbz")])
            .unwrap();
        let database_path = store.path().to_owned();
        let attempted = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&attempted);
        SYNC_BATCH_READ_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                // upsert_location has completed its initial SELECT. With a
                // deferred batch this write can commit, after which the
                // batch's snapshot upgrade fails with SQLITE_BUSY_SNAPSHOT.
                let concurrent = Connection::open(database_path).unwrap();
                concurrent.busy_timeout(Duration::ZERO).unwrap();
                let result = concurrent.execute(
                    "UPDATE comics SET title='racing writer' WHERE id=(SELECT comic_id FROM comic_locations WHERE source_id='local' AND relative_path='same.cbz')",
                    [],
                );
                assert!(matches!(result,
                    Err(rusqlite::Error::SqliteFailure(error, _))
                        if error.code == rusqlite::ErrorCode::DatabaseBusy));
                observed.store(true, Ordering::SeqCst);
            }));
        });

        let mut refreshed = comic("new-runtime", "same.cbz");
        refreshed.title = "Refreshed title".into();
        store.sync_library(&[refreshed]).unwrap();
        SYNC_BATCH_READ_HOOK.with(|slot| slot.borrow_mut().take());
        assert!(attempted.load(Ordering::SeqCst));
        let location = store.get_location("new-runtime").unwrap();
        assert!(location.online);
        assert_eq!(location.relative_path, "same.cbz");
    }

    #[test]
    fn ai_candidates_wait_for_a_busy_scan_writer() {
        let store = store("ai_busy_scan_writer");
        store.sync_library(&[comic("runtime", "ai.zip")]).unwrap();
        let mut scan_connection = Connection::open(store.path()).unwrap();
        let scan_tx = scan_connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        scan_tx
            .execute("UPDATE comics SET title=title WHERE id='runtime'", [])
            .unwrap();

        let ai_store = store.clone();
        let started = Instant::now();
        let ai_write = std::thread::spawn(move || {
            ai_store.store_ai_candidates(
                "runtime",
                "openai",
                "test-model",
                "busy-writer-response",
                vec![("summary".into(), json!("等待後的摘要"), 0.8)],
            )
        });
        std::thread::sleep(Duration::from_millis(5_500));
        scan_tx.commit().unwrap();
        ai_write.join().unwrap().unwrap();
        assert!(started.elapsed() >= Duration::from_secs(5));
        assert!(store
            .get_metadata("runtime")
            .unwrap()
            .candidates
            .iter()
            .any(|candidate| candidate.parser_id == "ai:openai"));
    }

    #[test]
    fn filename_fallback_is_visible_in_read_only_inbox() {
        let store = store("organizer_inbox");
        store
            .sync_library(&[comic("runtime", "低信心檔名.zip")])
            .unwrap();
        let inbox = store.organizer_inbox(20).unwrap();
        assert!(inbox.iter().any(|item| item.comic_id
            == store.get_metadata("runtime").unwrap().comic_id
            && item.confidence == Some(0.2)));
        assert_eq!(store.get_metadata("runtime").unwrap().title, "低信心檔名");
    }

    #[test]
    fn duplicate_candidates_never_merge_or_delete_locations() {
        let store = store("duplicates");
        store.with_connection(|connection| {
            connection.execute("INSERT INTO comics(id,title) VALUES('one','第一本'),('two','第二本')", []).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind,fingerprint,fingerprint_version) VALUES('one','one','local','a.zip','archive','same','blake3-sampled-v1'),('two','two','nas','b.zip','archive','same','blake3-sampled-v1')", []).map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        let candidates = store.duplicate_candidates(20).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].comic_ids.len(), 2);
        assert_eq!(candidates[0].locations.len(), 2);
        assert!(store.get_location("one").unwrap().fingerprint_collision);
        assert!(store.get_location("two").unwrap().fingerprint_collision);
        assert!(store.get_metadata("one").is_ok());
        assert!(store.get_metadata("two").is_ok());
    }

    #[test]
    fn discovery_tags_obey_scope_overrides_disabled_and_folder_rules() {
        let store = store("discovery_tags");
        store.with_connection(|connection| {
            connection.execute("INSERT INTO comics(id,title) VALUES('one','One'),('two','Two'),('three','Three')", []).map_err(|e| e.to_string())?;
            connection.execute("INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind) VALUES('one','runtime-one','local:a','Shelf/One','folder'),('two','runtime-two','local:b','Shelf/Two','folder'),('three','runtime-three','local:a','Other/Three','folder')", []).map_err(|e| e.to_string())?;
            Ok(())
        }).unwrap();
        let tag = ScopedTag {
            namespace: "general".into(),
            value: "Adventure".into(),
        };
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["one".into(), "two".into()],
                targets: vec![],
                fields: BTreeMap::new(),
                add_tags: vec![tag.clone()],
                exclude_tags: vec![],
            })
            .unwrap();
        let ids = vec![
            "runtime-one".into(),
            "runtime-two".into(),
            "runtime-three".into(),
        ];
        let groups = store.discovery_tags(&ids).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].comic_ids, vec!["runtime-one", "runtime-two"]);
        assert_eq!(
            store.discovery_tags(&["runtime-one".into()]).unwrap()[0].comic_ids,
            vec!["runtime-one"]
        );
        store
            .upsert_folder_rule(FolderTagRule {
                id: None,
                source_id: "local:a".into(),
                folder_path: "Shelf".into(),
                tag: ScopedTag {
                    namespace: "genre".into(),
                    value: "Nature".into(),
                },
                enabled: true,
            })
            .unwrap();
        store.with_connection(|connection| {
            connection.execute("UPDATE comic_locations SET relative_path='\\Shelf\\One\\' WHERE runtime_id='runtime-one'", []).map_err(|e| e.to_string())?;
            connection.execute("UPDATE folder_tag_rules SET folder_path='/Shelf/'", []).map_err(|e| e.to_string())?;
            Ok(())
        }).unwrap();
        let groups = store.discovery_tags(&ids).unwrap();
        assert_eq!(
            groups
                .iter()
                .find(|g| g.value == "Nature")
                .unwrap()
                .comic_ids,
            vec!["runtime-one"]
        );
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["one".into()],
                targets: vec![],
                fields: BTreeMap::new(),
                add_tags: vec![],
                exclude_tags: vec![tag],
            })
            .unwrap();
        assert_eq!(
            store
                .discovery_tags(&ids)
                .unwrap()
                .iter()
                .find(|g| g.value == "Adventure")
                .unwrap()
                .comic_ids,
            vec!["runtime-two"]
        );
        let tag_id = store
            .tag_inventory(TagInventoryQuery::default())
            .unwrap()
            .items
            .into_iter()
            .find(|t| t.display_value == "Adventure")
            .unwrap()
            .id;
        store.set_tag_disabled(tag_id, true).unwrap();
        assert!(!store
            .discovery_tags(&ids)
            .unwrap()
            .iter()
            .any(|g| g.value == "Adventure"));
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "UPDATE comic_locations SET online=0 WHERE runtime_id='runtime-one'",
                        [],
                    )
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .unwrap();
        assert!(store.discovery_tags(&ids).unwrap().is_empty());
        assert!(store.discovery_tags(&[]).unwrap().is_empty());
        assert!(store
            .discovery_tags(&vec!["x".into(); RUNTIME_ITEM_IDS_MAX + 1])
            .is_err());
        assert!(store.discovery_tags(&["x".repeat(4097)]).is_err());
    }

    #[test]
    fn discovery_tags_keep_duplicate_runtime_ids_source_qualified() {
        let store = store("discovery_tags_source_qualified");
        store
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO comics(id,title) VALUES('one','One'),('two','Two')",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind) VALUES
                         ('one','shared-runtime','external:a','A/book.cbz','archive'),
                         ('two','shared-runtime','external:b','B/book.cbz','archive')",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();
        let target_a = BatchEditTarget {
            runtime_id: "shared-runtime".into(),
            source_id: "external:a".into(),
            relative_path: "A/book.cbz".into(),
        };
        let target_b = BatchEditTarget {
            runtime_id: "shared-runtime".into(),
            source_id: "external:b".into(),
            relative_path: "B/book.cbz".into(),
        };
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["shared-runtime".into()],
                targets: vec![target_a.clone()],
                fields: BTreeMap::new(),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "Only A".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["shared-runtime".into()],
                targets: vec![target_b.clone()],
                fields: BTreeMap::new(),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "Only B".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();

        let groups_a = store.discovery_tags_for_targets(&[target_a]).unwrap();
        assert_eq!(groups_a.len(), 1);
        assert_eq!(groups_a[0].value, "Only A");
        assert_eq!(groups_a[0].comic_ids, vec!["shared-runtime"]);
        assert_eq!(
            groups_a[0].targets,
            vec![BatchEditTarget {
                runtime_id: "shared-runtime".into(),
                source_id: "external:a".into(),
                relative_path: "A/book.cbz".into(),
            }]
        );

        let groups_b = store.discovery_tags_for_targets(&[target_b]).unwrap();
        assert_eq!(groups_b.len(), 1);
        assert_eq!(groups_b[0].value, "Only B");
        assert_eq!(groups_b[0].targets[0].source_id, "external:b");
    }

    #[test]
    fn metadata_and_file_location_queries_do_not_choose_another_source() {
        let store = store("source_qualified_metadata");
        store
            .with_connection(|connection| {
                connection
                    .execute("INSERT INTO comics(id,title) VALUES('work','Work')", [])
                    .map_err(|error| error.to_string())?;
                connection
                    .execute(
                        "INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind) VALUES
                         ('work','runtime-a','external:a','A/book.cbz','archive'),
                         ('work','runtime-b','external:b','B/book.cbz','archive'),
                         ('work','runtime-a-slash','external:a','A//book.cbz','archive')",
                        [],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .unwrap();

        assert!(store
            .get_location("work")
            .unwrap_err()
            .contains("多個來源位置"));
        let metadata = store
            .get_metadata_for_source("runtime-b", "external:b", "B/book.cbz")
            .unwrap();
        assert_eq!(metadata.runtime_id.as_deref(), Some("runtime-b"));
        assert_eq!(metadata.source_id.as_deref(), Some("external:b"));
        assert_eq!(metadata.relative_path.as_deref(), Some("B/book.cbz"));
        let slash_metadata = store
            .get_metadata_for_source("runtime-a-slash", "external:a", "A//book.cbz")
            .unwrap();
        assert_eq!(
            slash_metadata.runtime_id.as_deref(),
            Some("runtime-a-slash")
        );
        assert_eq!(slash_metadata.relative_path.as_deref(), Some("A//book.cbz"));
        assert!(store
            .get_metadata_for_source("runtime-a", "external:a", "A//book.cbz")
            .is_err());
    }

    #[test]
    fn related_tags_are_read_only_ranked_suggestions_and_respect_excludes() {
        let store = store("related_tags");
        store.with_connection(|connection| {
            connection.execute("INSERT INTO comics(id,title) VALUES('one','第一本'),('two','第二本'),('three','第三本')", []).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind) VALUES('one','one','local','one.zip','archive'),('two','two','local','two.zip','archive'),('three','three','local','three.zip','archive')", []).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO tags(id,namespace,value,normalized_value) VALUES(1,'general','百合','百合'),(2,'general','校園','校園'),(3,'general','甜寵','甜寵')", []).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO metadata_sources(id,comic_id,parser_id,parser_version,source_path,source_digest,confidence,raw_json) VALUES(1,'one','fixture','1','one','one',1,'{}'),(2,'two','fixture','1','two','two',1,'{}'),(3,'three','fixture','1','three','three',1,'{}')", []).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO comic_tag_candidates(comic_id,tag_id,source_id) VALUES('one',1,1),('two',1,2),('two',2,2),('three',1,3),('three',2,3),('three',3,3)", []).map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        let suggestions = store.related_tags("one", 10).unwrap();
        assert_eq!(
            suggestions
                .iter()
                .map(|item| item.tag.value.as_str())
                .collect::<Vec<_>>(),
            vec!["校園", "甜寵"]
        );
        assert_eq!(suggestions[0].shared_comics, 2);
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["one".into()],
                targets: vec![],
                fields: BTreeMap::new(),
                add_tags: vec![],
                exclude_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "甜寵".into(),
                }],
            })
            .unwrap();
        assert_eq!(store.related_tags("one", 10).unwrap().len(), 1);
    }

    #[test]
    fn versioned_exchange_previews_conflicts_and_requires_explicit_resolution() {
        let source = store("exchange_source");
        source
            .sync_library(&[comic("runtime", "source.zip")])
            .unwrap();
        let stable_id = source.get_metadata("runtime").unwrap().comic_id;
        source
            .apply_batch(BatchEditRequest {
                comic_ids: vec![stable_id.clone()],
                targets: vec![],
                fields: BTreeMap::from([("title".into(), Some("來源人工標題".into()))]),
                add_tags: vec![ScopedTag {
                    namespace: "general".into(),
                    value: "百合".into(),
                }],
                exclude_tags: vec![],
            })
            .unwrap();
        let payload = source.export_exchange_json().unwrap();

        let target = store("exchange_target");
        target.with_connection(|connection| {
            connection.execute("INSERT INTO comics(id,title) VALUES(?1,'目標')", [&stable_id]).map_err(|error| error.to_string())?;
            connection.execute("INSERT INTO comic_locations(comic_id,runtime_id,source_id,relative_path,kind) VALUES(?1,'target','local','target.zip','archive')", [&stable_id]).map_err(|error| error.to_string())?;
            Ok(())
        }).unwrap();
        target
            .apply_batch(BatchEditRequest {
                comic_ids: vec![stable_id.clone()],
                targets: vec![],
                fields: BTreeMap::from([("title".into(), Some("本機人工標題".into()))]),
                add_tags: vec![],
                exclude_tags: vec![],
            })
            .unwrap();
        let preview = target.preview_exchange_json(&payload).unwrap();
        assert_eq!(preview.matched, 1);
        assert_eq!(preview.conflicts.len(), 1);
        let conflict_key = preview.conflicts[0].key.clone();
        let preserved = target
            .apply_exchange(CatalogImportRequest {
                payload: payload.clone(),
                resolutions: BTreeMap::new(),
            })
            .unwrap();
        assert_eq!(preserved.skipped_conflicts, 1);
        assert_eq!(
            target.get_metadata(&stable_id).unwrap().title,
            "本機人工標題"
        );
        let applied = target
            .apply_exchange(CatalogImportRequest {
                payload,
                resolutions: BTreeMap::from([(conflict_key, "useIncoming".into())]),
            })
            .unwrap();
        assert_eq!(
            target.get_metadata(&stable_id).unwrap().title,
            "來源人工標題"
        );
        target.undo_batch(&applied.undo_token).unwrap();
        assert_eq!(
            target.get_metadata(&stable_id).unwrap().title,
            "本機人工標題"
        );
    }

    #[test]
    fn exchange_rejects_unknown_schema_version_before_writing() {
        let store = store("exchange_version");
        let payload = serde_json::json!({"schemaVersion": 999, "exportedAt": "now", "comics": []})
            .to_string();
        assert!(store
            .preview_exchange_json(&payload)
            .unwrap_err()
            .contains("不支援"));
    }

    #[test]
    fn exchange_rejects_invalid_override_shapes_before_writing() {
        let store = store("exchange_shape");
        let payload = serde_json::json!({
            "schemaVersion": 1,
            "exportedAt": "now",
            "comics": [{
                "comicId": "missing",
                "fieldOverrides": {"title": 42},
                "tagOverrides": []
            }]
        })
        .to_string();
        assert!(store
            .preview_exchange_json(&payload)
            .unwrap_err()
            .contains("必須是字串或 null"));
    }

    #[test]
    fn persistent_progress_recovery_proof_survives_reopen_and_enforces_cas() {
        let store = store("progress_recovery_cas");
        let path = store.path().to_path_buf();
        store
            .sync_library(&[comic("proof-book", "book.cbz")])
            .unwrap();
        let revision = crate::state::SourceRevision {
            len: 100,
            modified: Some((10, 0)),
            ctime: Some((10, 0)),
            file_id: Some((1, 4)),
        };
        let progress = crate::state::Progress {
            current_page: 3,
            total_pages: 10,
            percent: 30.0,
            updated_at: Some("2026-11-08T00:00:00Z".into()),
        };
        let token = "native-proof-one";
        store
            .register_progress_recovery_proof(ProgressRecoveryProof {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token,
                total_pages: 10,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();

        // A fresh store models process restart; only the persisted native proof
        // is available to validate and recover the source.
        drop(store);
        let reopened = CatalogStore::new(path.clone()).unwrap();
        assert!(reopened
            .load_progress_recovery_evidence("proof-book", "local", "book.cbz", token,)
            .unwrap()
            .is_some());
        reopened
            .recover_progress_for_source_location(ProgressRecoveryCommit {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token,
                revision: &revision,
                smb_content_hash: None,
                total_pages: 10,
                current_page: 3,
                intent_sequence: 40,
                progress: &progress,
            })
            .unwrap();
        // A retry of the already committed intent/page is idempotent even if
        // its fresh native timestamp differs from the persisted row.
        let retry = crate::state::Progress {
            updated_at: Some("later retry".into()),
            ..progress.clone()
        };
        reopened
            .recover_progress_for_source_location(ProgressRecoveryCommit {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token,
                revision: &revision,
                smb_content_hash: None,
                total_pages: 10,
                current_page: 3,
                intent_sequence: 40,
                progress: &retry,
            })
            .unwrap();
        assert!(reopened
            .recover_progress_for_source_location(ProgressRecoveryCommit {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token,
                revision: &revision,
                smb_content_hash: None,
                total_pages: 10,
                current_page: 4,
                intent_sequence: 39,
                progress: &retry,
            },)
            .is_err());

        let next_token = "native-proof-two";
        reopened
            .register_progress_recovery_proof(ProgressRecoveryProof {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token: next_token,
                total_pages: 10,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();
        assert!(reopened
            .load_progress_recovery_evidence("proof-book", "other-source", "book.cbz", next_token,)
            .is_err());
        assert!(reopened
            .load_progress_recovery_evidence("proof-book", "local", "other.cbz", next_token,)
            .is_err());
        assert!(reopened
            .load_progress_recovery_evidence("proof-book", "local", "book.cbz", "unknown-token",)
            .unwrap()
            .is_none());
        let mut replaced_revision = revision.clone();
        replaced_revision.file_id = Some((1, 5));
        assert!(reopened
            .recover_progress_for_source_location(ProgressRecoveryCommit {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token: next_token,
                revision: &replaced_revision,
                smb_content_hash: None,
                total_pages: 10,
                current_page: 5,
                intent_sequence: 41,
                progress: &retry,
            },)
            .is_err());

        // Simulate a database writer that changed progress without going
        // through the intent API; the proof's captured baseline must fail CAS.
        reopened.with_connection(|connection| {
            let changed = connection.execute(
                "UPDATE reading_progress SET current_page=6,updated_at='external write' WHERE comic_id=(SELECT comic_id FROM progress_recovery_proofs WHERE token='native-proof-two')", [],
            ).map_err(|error| error.to_string())?;
            assert_eq!(changed, 1);
            Ok(())
        }).unwrap();
        assert!(reopened
            .recover_progress_for_source_location(ProgressRecoveryCommit {
                identifier: "proof-book",
                source_id: "local",
                relative_path: "book.cbz",
                token: next_token,
                revision: &revision,
                smb_content_hash: None,
                total_pages: 10,
                current_page: 5,
                intent_sequence: 41,
                progress: &retry,
            },)
            .is_err());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn progress_recovery_intent_sequence_rejects_unsafe_values_without_changing_fence() {
        let store = store("intent_safe_integer");
        store.sync_library(&[comic("runtime", "book.cbz")]).unwrap();
        let revision = crate::state::SourceRevision {
            len: 100,
            modified: Some((10, 0)),
            ctime: Some((10, 0)),
            file_id: Some((1, 4)),
        };
        let progress = crate::state::Progress {
            current_page: 2,
            total_pages: 10,
            percent: 20.0,
            updated_at: Some("before overflow".into()),
        };
        store
            .save_progress_for_source_with_intent(
                "runtime",
                "local",
                &progress,
                Some(MAX_SAFE_INTENT_SEQUENCE),
            )
            .unwrap();
        let before = store
            .progress_for_source_location("runtime", "local", "book.cbz")
            .unwrap()
            .unwrap();
        let unsafe_sequence = MAX_SAFE_INTENT_SEQUENCE + 1;
        assert!(store
            .save_progress_for_source_with_intent(
                "runtime",
                "local",
                &crate::state::Progress {
                    current_page: 8,
                    updated_at: Some("must not commit".into()),
                    ..progress.clone()
                },
                Some(unsafe_sequence),
            )
            .is_err());
        assert_eq!(
            store
                .progress_intent_floor("runtime", "local", "book.cbz")
                .unwrap(),
            MAX_SAFE_INTENT_SEQUENCE
        );
        let after_unsafe_save = store
            .progress_for_source_location("runtime", "local", "book.cbz")
            .unwrap()
            .unwrap();
        assert_eq!(after_unsafe_save.current_page, before.current_page);
        assert_eq!(after_unsafe_save.total_pages, before.total_pages);
        assert_eq!(after_unsafe_save.updated_at, before.updated_at);

        let token = "safe-boundary-proof";
        store
            .register_progress_recovery_proof(ProgressRecoveryProof {
                identifier: "runtime",
                source_id: "local",
                relative_path: "book.cbz",
                token,
                total_pages: 10,
                revision: &revision,
                smb_content_hash: None,
            })
            .unwrap();
        assert!(store
            .recover_progress_for_source_location(ProgressRecoveryCommit {
                identifier: "runtime",
                source_id: "local",
                relative_path: "book.cbz",
                token,
                revision: &revision,
                smb_content_hash: None,
                total_pages: 10,
                current_page: 3,
                intent_sequence: unsafe_sequence,
                progress: &progress,
            })
            .is_err());
        assert_eq!(
            store
                .progress_intent_floor("runtime", "local", "book.cbz")
                .unwrap(),
            MAX_SAFE_INTENT_SEQUENCE
        );
        let after_unsafe_recovery = store
            .progress_for_source_location("runtime", "local", "book.cbz")
            .unwrap()
            .unwrap();
        assert_eq!(after_unsafe_recovery.current_page, before.current_page);
        assert_eq!(after_unsafe_recovery.total_pages, before.total_pages);
        assert_eq!(after_unsafe_recovery.updated_at, before.updated_at);
    }
}
