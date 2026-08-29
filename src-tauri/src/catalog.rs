use crate::metadata::{
    self, NormalizedMetadata, ParsedMetadataSource, ParserDiagnostic, ScopedTag,
};
use crate::state::ComicItem;
use rayon::prelude::*;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

const FINGERPRINT_VERSION: &str = "blake3-sampled-v1";
const ARCHIVE_SAMPLE_BYTES: usize = 256 * 1024;
const DIRECTORY_SAMPLE_BYTES: usize = 64 * 1024;
const PAGE_SIZE_MAX: usize = 200;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub creators: BTreeMap<String, Vec<String>>,
    pub tags: Vec<ScopedTag>,
    pub candidates: Vec<MetadataCandidate>,
    pub locked_fields: Vec<String>,
    pub diagnostics: Vec<ImportDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchEditRequest {
    pub comic_ids: Vec<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub add_tags: Vec<ScopedTag>,
    #[serde(default)]
    pub exclude_tags: Vec<ScopedTag>,
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
pub struct TagSuggestion {
    pub tag: ScopedTag,
    pub shared_comics: usize,
    pub reason: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReimportResult {
    pub imported: usize,
    pub diagnostics: usize,
}

fn default_page_size() -> usize {
    100
}
fn default_true() -> bool {
    true
}

impl CatalogStore {
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let store = Self { path };
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
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| error.to_string())?;
        migrate(&mut connection)?;
        operation(&mut connection)
    }

    pub fn sync_library(&self, comics: &[ComicItem]) -> Result<usize, String> {
        let known = self.with_connection(load_location_signatures)?;
        // Fingerprinting and sidecar/ZIP metadata probing are independent and mostly
        // latency-bound on NAS volumes. Keep the pool deliberately small so a large
        // library finishes promptly without flooding the SMB server.
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .thread_name(|index| format!("comic-metadata-{index}"))
            .build()
            .map_err(|error| error.to_string())?;
        let prepared = pool.install(|| {
            comics
                .par_iter()
                .map(|comic| {
                    let path = comic.source_path.as_deref().map(Path::new);
                    let signature = path.and_then(file_signature);
                    let key = (comic.source_id.clone(), comic.relative_path.clone());
                    let previous = known.get(&key);
                    let unchanged = previous.is_some_and(|item| {
                        item.fingerprint_version.as_deref() == Some(FINGERPRINT_VERSION)
                            && item.size == signature.as_ref().and_then(|value| value.0)
                            && item.mtime == signature.as_ref().and_then(|value| value.1.clone())
                    });
                    let fingerprint = if unchanged {
                        previous.and_then(|item| item.fingerprint.clone())
                    } else {
                        path.and_then(|item| sampled_fingerprint(item).ok())
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
                                }),
                        )
                    };
                    (comic.clone(), signature, fingerprint, parse)
                })
                .collect::<Vec<_>>()
        });
        self.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            let source_ids = prepared
                .iter()
                .map(|(comic, _, _, _)| comic.source_id.clone())
                .collect::<BTreeSet<_>>();
            if source_ids.iter().any(|source_id| source_id.starts_with("local:")) {
                // The app has one active local library root. When macOS remounts the
                // same NAS under a different path, retire every previous root before
                // the current locations are upserted below. Historical locations stay
                // in SQLite, so metadata/progress are never discarded.
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
            let mut affected = BTreeSet::new();
            for (comic, signature, fingerprint, parse) in prepared {
                let (comic_id, fingerprint_collision) =
                    upsert_location(&tx, &comic, signature, fingerprint.as_deref())?;
                affected.insert(comic_id.clone());
                if let Some(outcome) = parse { replace_imports(&tx, &comic_id, outcome.sources, outcome.diagnostics)?; }
                if fingerprint_collision {
                    tx.execute(
                        "INSERT INTO import_diagnostics(comic_id,parser_id,source_path,severity,message) VALUES(?1,NULL,?2,'warning','指紋符合多本既有漫畫，已保留為獨立項目，請手動確認')",
                        params![comic_id, comic.relative_path],
                    ).map_err(|error| error.to_string())?;
                }
                resolve_effective_metadata(&tx, &comic_id)?;
            }
            refresh_fts_batch(&tx, &affected)?;
            tx.execute(
                "UPDATE comics SET offline = CASE WHEN EXISTS (SELECT 1 FROM comic_locations l WHERE l.comic_id = comics.id AND l.online = 1) THEN 0 ELSE 1 END",
                [],
            ).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(affected.len())
        })
    }

    pub fn get_metadata(&self, identifier: &str) -> Result<ComicMetadataView, String> {
        self.with_connection(|connection| {
            let comic_id = resolve_comic_id(connection, identifier)?
                .ok_or_else(|| "找不到漫畫 metadata".to_string())?;
            build_view(connection, &comic_id)
        })
    }

    pub fn overlay_library(
        &self,
        mut items: Vec<ComicItem>,
        catalog_only_sources: &BTreeSet<String>,
    ) -> Result<Vec<ComicItem>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id
                 FROM comic_locations l JOIN comics c ON c.id=l.comic_id
                 WHERE l.runtime_id IS NOT NULL
                 ORDER BY l.runtime_id,l.online DESC,l.last_seen_at DESC"
            ).map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| Ok((
                row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)? != 0, row.get::<_, String>(4)?, row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?, row.get::<_, String>(7)?, row.get::<_, String>(8)?,
            ))).map_err(|error| error.to_string())?;
            let mut metadata = HashMap::new();
            for row in rows {
                let row = row.map_err(|error| error.to_string())?;
                metadata.entry(row.0.clone()).or_insert(row);
            }
            let mut present = BTreeSet::new();
            for item in &mut items {
                present.insert(item.id.clone());
                if let Some((_, title, series, _, _, _, _, _, _)) = metadata.get(&item.id) {
                    item.title.clone_from(title);
                    if let Some(series) = series { item.series.clone_from(series); }
                }
            }
            for (runtime_id, title, series, online, last_seen_at, relative_path, actual_path, kind, source_id) in metadata.into_values() {
                if present.contains(&runtime_id) { continue; }
                if !catalog_only_sources.contains(&source_id) { continue; }
                let Some(actual_path) = actual_path else { continue };
                let ext = Path::new(&actual_path).extension().and_then(|value| value.to_str()).map(|value| format!(".{value}")).unwrap_or_default();
                let item_type = if online {
                    if kind == "folder" { "external-folder" } else { "external-archive" }
                } else {
                    "offline"
                };
                items.push(ComicItem {
                    id: runtime_id,
                    r#type: item_type.into(),
                    relative_path,
                    ext,
                    title,
                    series: series.unwrap_or_else(|| "未分類".into()),
                    updated_at: last_seen_at,
                    page_count: 0,
                    progress: crate::state::Progress { current_page: 0, total_pages: 0, percent: 0.0, updated_at: None },
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
            connection
                .query_row(
                    "SELECT l.runtime_id,c.title,c.series,l.online,l.last_seen_at,l.relative_path,l.actual_path,l.kind,l.source_id
                     FROM comic_locations l JOIN comics c ON c.id=l.comic_id
                     WHERE l.runtime_id=?1 OR l.comic_id=?1
                     ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1",
                    [identifier],
                    |row| {
                        let runtime_id = row.get::<_, String>(0)?;
                        let title = row.get::<_, String>(1)?;
                        let series = row.get::<_, Option<String>>(2)?;
                        let online = row.get::<_, i64>(3)? != 0;
                        let updated_at = row.get::<_, String>(4)?;
                        let relative_path = row.get::<_, String>(5)?;
                        let actual_path = row.get::<_, Option<String>>(6)?;
                        let kind = row.get::<_, String>(7)?;
                        let source_id = row.get::<_, String>(8)?;
                        let ext = actual_path
                            .as_deref()
                            .and_then(|path| Path::new(path).extension())
                            .and_then(|value| value.to_str())
                            .map(|value| format!(".{value}"))
                            .unwrap_or_default();
                        let item_type = if online {
                            if kind == "folder" {
                                "external-folder"
                            } else {
                                "external-archive"
                            }
                        } else {
                            "offline"
                        };
                        Ok(ComicItem {
                            id: runtime_id,
                            r#type: item_type.into(),
                            relative_path,
                            ext,
                            title,
                            series: series.unwrap_or_else(|| "未分類".into()),
                            updated_at,
                            page_count: 0,
                            progress: crate::state::Progress {
                                current_page: 0,
                                total_pages: 0,
                                percent: 0.0,
                                updated_at: None,
                            },
                            source_id,
                            source_path: actual_path,
                            external_bookmark: None,
                        })
                    },
                )
                .optional()
                .map_err(|error| error.to_string())
        })
    }

    pub fn search(&self, query: CatalogQuery) -> Result<CatalogSearchResult, String> {
        self.with_connection(|connection| search_catalog(connection, query))
    }

    pub fn apply_batch(&self, request: BatchEditRequest) -> Result<BatchEditResult, String> {
        if request.comic_ids.is_empty() {
            return Err("請至少選取一本漫畫".into());
        }
        if request.comic_ids.len() > 10_000 {
            return Err("單次批次操作上限為 10,000 本".into());
        }
        for field in request.fields.keys() {
            if !allowed_user_field(field) {
                return Err(format!("不支援修改欄位：{field}"));
            }
        }
        self.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            let comic_ids = request.comic_ids.iter().map(|id| resolve_comic_id_tx(&tx, id)).collect::<Result<BTreeSet<_>, _>>()?;
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
                for tag in &request.add_tags { set_tag_override(&tx, comic_id, tag, "include")?; }
                for tag in &request.exclude_tags { set_tag_override(&tx, comic_id, tag, "exclude")?; }
                resolve_effective_metadata(&tx, comic_id)?;
                refresh_fts(&tx, comic_id)?;
            }
            let undo_token = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO batch_operations(token, snapshot_json, created_at) VALUES(?1, ?2, CURRENT_TIMESTAMP)", params![undo_token, before.to_string()]).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(BatchEditResult { updated: comic_ids.len(), undo_token })
        })
    }

    pub fn undo_batch(&self, token: &str) -> Result<usize, String> {
        self.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
            let snapshot: String = tx.query_row("SELECT snapshot_json FROM batch_operations WHERE token = ?1", [token], |row| row.get(0)).optional().map_err(|error| error.to_string())?.ok_or("找不到可撤銷的批次操作")?;
            let value: Value = serde_json::from_str(&snapshot).map_err(|error| error.to_string())?;
            let comics = value.as_object().ok_or("撤銷快照格式錯誤")?;
            for (comic_id, snapshot) in comics {
                tx.execute("DELETE FROM user_field_overrides WHERE comic_id = ?1", [comic_id]).map_err(|error| error.to_string())?;
                tx.execute("DELETE FROM comic_tag_overrides WHERE comic_id = ?1", [comic_id]).map_err(|error| error.to_string())?;
                if let Some(fields) = snapshot.get("fields").and_then(Value::as_object) {
                    for (field, value) in fields {
                        tx.execute("INSERT INTO user_field_overrides(comic_id, field_key, value_json, updated_at) VALUES(?1, ?2, ?3, CURRENT_TIMESTAMP)", params![comic_id, field, value.as_str().unwrap_or("null")]).map_err(|error| error.to_string())?;
                    }
                }
                if let Some(tags) = snapshot.get("tags").and_then(Value::as_array) {
                    for item in tags {
                        tx.execute("INSERT INTO comic_tag_overrides(comic_id, tag_id, action) VALUES(?1, ?2, ?3)", params![comic_id, item["tagId"].as_i64(), item["action"].as_str()]).map_err(|error| error.to_string())?;
                    }
                }
                resolve_effective_metadata(&tx, comic_id)?;
                refresh_fts(&tx, comic_id)?;
            }
            tx.execute("DELETE FROM batch_operations WHERE token = ?1", [token]).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(comics.len())
        })
    }

    pub fn upsert_folder_rule(&self, rule: FolderTagRule) -> Result<FolderTagRule, String> {
        if rule.source_id.trim().is_empty() {
            return Err("資料夾規則缺少來源".into());
        }
        self.with_connection(|connection| {
            let tx = connection.transaction().map_err(|error| error.to_string())?;
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
        let targets = self.with_connection(|connection| {
            let mut targets = Vec::new();
            if request.comic_ids.is_empty() {
                let mut statement = connection.prepare("SELECT comic_id, actual_path FROM comic_locations WHERE online = 1 AND actual_path IS NOT NULL").map_err(|error| error.to_string())?;
                let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).map_err(|error| error.to_string())?;
                for row in rows { targets.push(row.map_err(|error| error.to_string())?); }
            } else {
                for identifier in &request.comic_ids {
                    let comic_id = resolve_comic_id(connection, identifier)?.ok_or_else(|| format!("找不到漫畫：{identifier}"))?;
                    let path = connection.query_row("SELECT actual_path FROM comic_locations WHERE comic_id = ?1 AND online = 1 AND actual_path IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1", [comic_id.as_str()], |row| row.get(0)).optional().map_err(|error| error.to_string())?;
                    if let Some(path) = path { targets.push((comic_id, path)); }
                }
            }
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
                .map(|(comic_id, path)| {
                    (
                        comic_id,
                        path.clone(),
                        metadata::parse_metadata_for_path(Path::new(&path)),
                    )
                })
                .collect::<Vec<_>>()
        });
        self.with_connection(|connection| {
            let tx = connection
                .transaction()
                .map_err(|error| error.to_string())?;
            let mut diagnostics = 0;
            for (comic_id, _, outcome) in parsed.iter() {
                diagnostics += outcome.diagnostics.len();
                replace_imports(
                    &tx,
                    comic_id,
                    outcome.sources.clone(),
                    outcome.diagnostics.clone(),
                )?;
                resolve_effective_metadata(&tx, comic_id)?;
                refresh_fts(&tx, comic_id)?;
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
                    params![resolved, source_id, &field, value.to_string(), 5_i64, confidence],
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
            let changed = tx.execute(
                "UPDATE comic_locations SET online=0 WHERE source_id=?1 AND online=1",
                [source_id],
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE comics SET offline = CASE WHEN EXISTS (SELECT 1 FROM comic_locations l WHERE l.comic_id=comics.id AND l.online=1) THEN 0 ELSE 1 END",
                [],
            ).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(changed)
        })
    }

    pub fn upsert_tag_alias(&self, alias: TagAlias) -> Result<TagAlias, String> {
        let alias = normalize_tag_alias(alias)?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO tag_aliases(namespace,alias,normalized_alias,canonical_value,updated_at) VALUES(?1,?2,?3,?4,CURRENT_TIMESTAMP) ON CONFLICT(namespace,normalized_alias) DO UPDATE SET alias=excluded.alias,canonical_value=excluded.canonical_value,updated_at=CURRENT_TIMESTAMP",
                params![alias.namespace, alias.alias, alias.alias.to_lowercase(), alias.canonical_value],
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

fn migrate(connection: &mut Connection) -> Result<(), String> {
    connection.execute_batch(
        "BEGIN;
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
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
        CREATE TABLE IF NOT EXISTS tag_aliases(
          id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, alias TEXT NOT NULL, normalized_alias TEXT NOT NULL,
          canonical_value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(namespace, normalized_alias)
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
        CREATE VIRTUAL TABLE IF NOT EXISTS catalog_fts USING fts5(comic_id UNINDEXED, title, series, path, creators, tags, language, tokenize='unicode61');
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, CURRENT_TIMESTAMP);
        INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, CURRENT_TIMESTAMP);
        COMMIT;"
    ).map_err(|error| format!("SQLite migration 失敗：{error}"))
}

fn load_location_signatures(
    connection: &mut Connection,
) -> Result<HashMap<(String, String), LocationSignature>, String> {
    let mut statement = connection
        .prepare("SELECT source_id,relative_path,size,mtime,fingerprint,fingerprint_version FROM comic_locations")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
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

fn file_signature(path: &Path) -> Option<(Option<i64>, Option<String>)> {
    std::fs::metadata(path).ok().map(|metadata| {
        (
            Some(metadata.len() as i64),
            metadata
                .modified()
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()),
        )
    })
}

fn upsert_location(
    tx: &Transaction<'_>,
    comic: &ComicItem,
    signature: Option<(Option<i64>, Option<String>)>,
    fingerprint: Option<&str>,
) -> Result<(String, bool), String> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT comic_id FROM comic_locations WHERE source_id = ?1 AND relative_path = ?2",
            params![comic.source_id, comic.relative_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
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
         kind=excluded.kind, size=excluded.size, mtime=excluded.mtime, fingerprint=COALESCE(excluded.fingerprint, comic_locations.fingerprint),
         fingerprint_version=COALESCE(excluded.fingerprint_version, comic_locations.fingerprint_version), online=1, last_seen_at=CURRENT_TIMESTAMP",
        params![comic_id, comic.id, comic.source_id, comic.relative_path, comic.source_path, comic.r#type, size, mtime, fingerprint, fingerprint.map(|_| FINGERPRINT_VERSION)],
    ).map_err(|error| error.to_string())?;
    Ok((comic_id, fingerprint_collision))
}

fn replace_imports(
    tx: &Transaction<'_>,
    comic_id: &str,
    sources: Vec<ParsedMetadataSource>,
    diagnostics: Vec<ParserDiagnostic>,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM metadata_sources WHERE comic_id = ?1 AND parser_id NOT LIKE 'ai:%'",
        [comic_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM import_diagnostics WHERE comic_id = ?1",
        [comic_id],
    )
    .map_err(|error| error.to_string())?;
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

fn build_view(connection: &Connection, comic_id: &str) -> Result<ComicMetadataView, String> {
    let mut view = connection.query_row(
        "SELECT c.id,c.title,c.series,c.volume,c.number,c.summary,c.language,c.reading_direction,c.published_at,c.offline,
          l.runtime_id,l.relative_path,l.source_id FROM comics c LEFT JOIN comic_locations l ON l.comic_id=c.id WHERE c.id=?1 ORDER BY l.online DESC,l.last_seen_at DESC LIMIT 1",
        [comic_id],
        |row| Ok(ComicMetadataView {
            comic_id: row.get(0)?, title: row.get(1)?, series: row.get(2)?, volume: row.get(3)?, number: row.get(4)?, summary: row.get(5)?,
            language: row.get(6)?, reading_direction: row.get(7)?, published_at: row.get(8)?, offline: row.get::<_, i64>(9)? != 0,
            runtime_id: row.get(10)?, relative_path: row.get(11)?, source_id: row.get(12)?, creators: BTreeMap::new(), tags: vec![], candidates: vec![], locked_fields: vec![], diagnostics: vec![],
        }),
    ).map_err(|error| error.to_string())?;
    view.creators = effective_creators(connection, comic_id)?;
    view.tags = effective_tags(connection, comic_id)?;
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
    Ok(view)
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

fn effective_tags(connection: &Connection, comic_id: &str) -> Result<Vec<ScopedTag>, String> {
    let mut tags: BTreeMap<i64, ScopedTag> = BTreeMap::new();
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
        tags.insert(id, tag);
    }
    let location: Option<(String, String)> = connection.query_row("SELECT source_id,relative_path FROM comic_locations WHERE comic_id=?1 ORDER BY online DESC,last_seen_at DESC LIMIT 1", [comic_id], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|error| error.to_string())?;
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
                tags.insert(id, tag);
            }
        }
    }
    let mut statement = connection.prepare("SELECT o.tag_id,o.action,t.namespace,t.value FROM comic_tag_overrides o JOIN tags t ON t.id=o.tag_id WHERE o.comic_id=?1").map_err(|error| error.to_string())?;
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
        let (id, action, tag) = row.map_err(|error| error.to_string())?;
        if action == "exclude" {
            tags.remove(&id);
        } else {
            tags.insert(id, tag);
        }
    }
    Ok(tags.into_values().collect())
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
    let mut insert = connection
        .prepare("INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES(?1,?2,?3,?4,?5,?6,?7)")
        .map_err(|error| error.to_string())?;
    for comic_id in comic_ids {
        let view = build_view(connection, comic_id)?;
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
        insert
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
    }
    Ok(())
}

fn refresh_fts_inner(connection: &Connection, comic_id: &str) -> Result<(), String> {
    let view = build_view(connection, comic_id)?;
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
    connection
        .execute("DELETE FROM catalog_fts WHERE comic_id=?1", [comic_id])
        .map_err(|error| error.to_string())?;
    connection.execute("INSERT INTO catalog_fts(comic_id,title,series,path,creators,tags,language) VALUES(?1,?2,?3,?4,?5,?6,?7)", params![comic_id, view.title, view.series, view.relative_path, creators, tags, view.language]).map_err(|error| error.to_string())?;
    Ok(())
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
    if seed_terms.is_empty() && parsed.exclude.is_empty() {
        let total = connection
            .query_row("SELECT COUNT(*) FROM comics", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| error.to_string())? as usize;
        let limit = query.limit.clamp(1, PAGE_SIZE_MAX);
        let mut statement = connection
            .prepare("SELECT id FROM comics ORDER BY updated_at DESC,title COLLATE NOCASE LIMIT ?1 OFFSET ?2")
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
        let items = ids
            .iter()
            .map(|id| build_view(connection, id))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(CatalogSearchResult {
            items,
            total,
            facets: BTreeMap::new(),
        });
    }
    let ids = if seed_terms.is_empty() {
        let mut statement = connection
            .prepare("SELECT id FROM comics ORDER BY updated_at DESC,title COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        let fts = seed_terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let mut statement = connection
            .prepare("SELECT comic_id FROM catalog_fts WHERE catalog_fts MATCH ?1 ORDER BY rank")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([fts], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())?
    };
    let offset = query.offset;
    let limit = query.limit.clamp(1, PAGE_SIZE_MAX);
    let mut total = 0usize;
    let mut items = Vec::with_capacity(limit);
    let mut facets: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
    for id in ids {
        let view = build_view(connection, &id)?;
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
                items.push(view);
            }
        }
    }
    Ok(CatalogSearchResult {
        items,
        total,
        facets,
    })
}

fn normalize_tag_alias(alias: TagAlias) -> Result<TagAlias, String> {
    let alias = TagAlias {
        namespace: alias.namespace.trim().to_ascii_lowercase(),
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
            params![namespace, value.to_lowercase()],
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
        self.include
            .iter()
            .all(|term| query_term_matches(view, term))
            && self
                .exclude
                .iter()
                .all(|term| !query_term_matches(view, term))
    }
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
    connection.query_row("SELECT id FROM comics WHERE id=?1 UNION SELECT comic_id FROM comic_locations WHERE runtime_id=?1 LIMIT 1", [identifier], |row| row.get(0)).optional().map_err(|error| error.to_string())
}
fn resolve_comic_id_tx(tx: &Transaction<'_>, identifier: &str) -> Result<String, String> {
    resolve_comic_id(tx, identifier)?.ok_or_else(|| format!("找不到漫畫：{identifier}"))
}

fn ensure_tag(connection: &Connection, tag: &ScopedTag) -> Result<i64, String> {
    let namespace = tag.namespace.trim().to_ascii_lowercase();
    let value = tag.value.trim();
    if namespace.is_empty() || value.is_empty() {
        return Err("標籤 namespace 與內容不可為空".into());
    }
    connection
        .execute(
            "INSERT OR IGNORE INTO tags(namespace,value,normalized_value) VALUES(?1,?2,?3)",
            params![namespace, value, value.to_lowercase()],
        )
        .map_err(|error| error.to_string())?;
    connection
        .query_row(
            "SELECT id FROM tags WHERE namespace=?1 AND normalized_value=?2",
            params![namespace, value.to_lowercase()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}
fn ensure_tag_tx(tx: &Transaction<'_>, tag: &ScopedTag) -> Result<i64, String> {
    ensure_tag(tx, tag)
}
fn set_tag_override(
    tx: &Transaction<'_>,
    comic_id: &str,
    tag: &ScopedTag,
    action: &str,
) -> Result<(), String> {
    let tag_id = ensure_tag_tx(tx, tag)?;
    tx.execute("INSERT INTO comic_tag_overrides(comic_id,tag_id,action) VALUES(?1,?2,?3) ON CONFLICT(comic_id,tag_id) DO UPDATE SET action=excluded.action", params![comic_id, tag_id, action]).map_err(|error| error.to_string())?;
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
    let undo_token = uuid::Uuid::new_v4().to_string();
    tx.execute("INSERT INTO batch_operations(token,snapshot_json,created_at) VALUES(?1,?2,CURRENT_TIMESTAMP)", params![undo_token, before.to_string()]).map_err(|error| error.to_string())?;
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

fn sampled_fingerprint(path: &Path) -> Result<String, String> {
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
        let mut file = File::open(path).map_err(|error| error.to_string())?;
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
    }
    Ok(hasher.finalize().to_hex().to_string())
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

    fn store(name: &str) -> CatalogStore {
        let path = std::env::temp_dir().join(format!(
            "comic_catalog_{name}_{}_{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        CatalogStore::new(path).unwrap()
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
    fn migrations_are_idempotent_and_offline_rows_survive() {
        let store = store("migration");
        store.sync_library(&[comic("runtime", "a.zip")]).unwrap();
        CatalogStore::new(store.path().to_path_buf()).unwrap();
        assert_eq!(store.mark_source_offline("local").unwrap(), 1);
        let view = store.get_metadata("runtime").unwrap();
        assert!(view.offline);
        assert_eq!(view.title, "a");
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
                fields: BTreeMap::new(),
                add_tags: vec![],
                exclude_tags: vec![tag.clone()],
            })
            .unwrap();
        assert!(!store.get_metadata("runtime").unwrap().tags.contains(&tag));
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
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
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
            })
            .unwrap();
        let view = store.get_metadata("runtime").unwrap();
        assert_eq!(view.title, "人工標題");
        assert_eq!(view.summary.as_deref(), Some("第二版摘要"));
        std::fs::remove_dir_all(folder).unwrap();
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
        }
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
    fn tag_alias_expands_search_without_rewriting_original_tag() {
        let store = store("tag_alias");
        store
            .sync_library(&[comic("runtime", "alias.zip")])
            .unwrap();
        store
            .apply_batch(BatchEditRequest {
                comic_ids: vec!["runtime".into()],
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
        assert!(store.get_metadata("one").is_ok());
        assert!(store.get_metadata("two").is_ok());
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
}
