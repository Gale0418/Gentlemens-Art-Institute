use crate::state::{AppState, ComicItem, Progress};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const IMAGE_EXTENSIONS: [&str; 6] = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"];
const PARTIAL_LIBRARY_BATCH: usize = 64;
const PARTIAL_LIBRARY_INTERVAL: Duration = Duration::from_millis(400);
const MAX_LOCAL_SCAN_DEPTH: usize = 100;
pub(crate) const MAX_PROGRESS_FILE_BYTES: usize = 16 * 1024 * 1024;

struct ScanOutcome {
    comics: Vec<ComicItem>,
    local_source_id: Option<String>,
    local_source_available: bool,
    local_complete: bool,
    external_source_ids: BTreeSet<String>,
    external_complete: bool,
}

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryBatch {
    pub(crate) generation: u64,
    pub(crate) items: Vec<ComicItem>,
    pub(crate) found: usize,
}

fn should_publish_partial(discovered: usize, published: usize, elapsed: Duration) -> bool {
    discovered > published
        && (published == 0
            || discovered.saturating_sub(published) >= PARTIAL_LIBRARY_BATCH
            || elapsed >= PARTIAL_LIBRARY_INTERVAL)
}

pub(crate) fn load_progress_file(
    path: &Path,
) -> Result<std::collections::HashMap<String, Progress>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(std::collections::HashMap::new())
        }
        Err(error) => return Err(format!("無法讀取進度檔：{error}")),
    };
    let mut bytes = Vec::new();
    file.take((MAX_PROGRESS_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("無法讀取進度檔：{error}"))?;
    if bytes.len() > MAX_PROGRESS_FILE_BYTES {
        return Err(format!(
            "進度檔超過 {} MiB 大小上限",
            MAX_PROGRESS_FILE_BYTES / (1024 * 1024)
        ));
    }
    let content =
        String::from_utf8(bytes).map_err(|error| format!("進度檔不是有效 UTF-8：{error}"))?;
    serde_json::from_str(&content).map_err(|error| format!("進度檔格式無效：{error}"))
}

pub(crate) fn merge_discovered_comics(library: &mut Vec<ComicItem>, discovered: &[ComicItem]) {
    let mut positions = library
        .iter()
        .enumerate()
        .map(|(index, comic)| (comic.id.clone(), index))
        .collect::<std::collections::HashMap<_, _>>();
    for comic in discovered {
        if let Some(index) = positions.get(&comic.id).copied() {
            library[index] = comic.clone();
        } else {
            positions.insert(comic.id.clone(), library.len());
            library.push(comic.clone());
        }
    }
}

fn apply_scan_outcome(library: &mut Vec<ComicItem>, outcome: &ScanOutcome) {
    // SMB has a separate authoritative scanner. Remove its previous runtime
    // snapshot here so that scanner can replace it or load an offline SQLite
    // snapshot without duplicate identities.
    library.retain(|comic| comic.source_id != "smb");

    if let Some(local_source_id) = outcome.local_source_id.as_deref() {
        if outcome.local_complete {
            library.retain(|comic| comic.source_id != local_source_id);
        } else if !outcome.local_source_available {
            for comic in library
                .iter_mut()
                .filter(|comic| comic.source_id == local_source_id)
            {
                comic.r#type = "offline".to_string();
            }
        }
    }
    if outcome.external_complete {
        library.retain(|comic| !comic.source_id.starts_with("external:"));
    }

    // Discoveries from an incomplete source are still useful, but absence from
    // that source is not authoritative and therefore never deletes old items.
    merge_discovered_comics(library, &outcome.comics);
}

fn source_items(comics: &[ComicItem], source_id: &str) -> Vec<ComicItem> {
    comics
        .iter()
        .filter(|comic| comic.source_id == source_id)
        .cloned()
        .collect()
}

fn publish_partial_library(
    results: &[ComicItem],
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    published: &mut usize,
    published_at: &mut Instant,
) {
    if !should_publish_partial(results.len(), *published, published_at.elapsed()) {
        return;
    }
    let status = {
        let _scan_lifecycle = state.scan_lifecycle.blocking_lock();
        if state.scan_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let newly_discovered = &results[*published..];
        merge_discovered_comics(&mut state.comics.blocking_lock(), newly_discovered);
        let mut progress = state.scan_progress.blocking_lock();
        progress.found = results.len();
        progress.phase = "discovering".into();
        if let Some(path) = results.last().and_then(|comic| comic.source_path.as_ref()) {
            progress.current_path = path.clone();
        }
        let batch = LibraryBatch {
            generation,
            items: newly_discovered.to_vec(),
            found: results.len(),
        };
        *published = results.len();
        *published_at = Instant::now();
        (progress.clone(), batch)
    };
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return;
    }
    use tauri::Emitter;
    let (status, batch) = status;
    let _ = app_handle.emit("scan-progress", status);
    let _ = app_handle.emit("library-changed", batch);
}

fn publish_visible_library(
    results: &[ComicItem],
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    visible_generation: u64,
    published: &mut usize,
    published_at: &mut Instant,
) {
    let batch = {
        let _scan_lifecycle = state.scan_lifecycle.blocking_lock();
        if state.scan_generation.load(Ordering::Acquire) != generation
            || state.visible_scan_generation.load(Ordering::Acquire) != visible_generation
        {
            return;
        }
        let items = results[*published..].to_vec();
        if items.is_empty() {
            return;
        }
        merge_discovered_comics(&mut state.comics.blocking_lock(), &items);
        *published = results.len();
        *published_at = Instant::now();
        LibraryBatch {
            generation,
            items,
            found: results.len(),
        }
    };
    use tauri::Emitter;
    let _ = app_handle.emit("library-changed", batch);
}

#[allow(clippy::too_many_arguments)]
fn publish_discovery(
    results: &[ComicItem],
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    visible_generation: Option<u64>,
    published: &mut usize,
    published_at: &mut Instant,
) {
    if let Some(visible_generation) = visible_generation {
        if !should_publish_partial(results.len(), *published, published_at.elapsed()) {
            return;
        }
        publish_visible_library(
            results,
            state,
            app_handle,
            generation,
            visible_generation,
            published,
            published_at,
        );
    } else {
        publish_partial_library(
            results,
            state,
            app_handle,
            generation,
            published,
            published_at,
        );
    }
}

async fn record_scan_error(state: &Arc<AppState>, generation: u64) {
    let mut progress = state.scan_progress.lock().await;
    if progress.generation == generation {
        progress.error = Some("部分書架資料未能更新，請稍後重新掃描".into());
    }
}

async fn finish_scan_if_current(
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    found: Option<usize>,
) -> bool {
    let status = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        if state.scan_generation.load(Ordering::Acquire) != generation {
            return false;
        }
        let mut progress = state.scan_progress.lock().await;
        if let Some(found) = found {
            progress.found = found;
        }
        progress.is_scanning = false;
        progress.phase = if progress.error.is_some() {
            "error"
        } else {
            "complete"
        }
        .into();
        progress.completed_at = Some(chrono::Utc::now().to_rfc3339());
        progress.clone()
    };
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    use tauri::Emitter;
    let _ = app_handle.emit("scan-progress", status);
    let _ = app_handle.emit("library-changed", ());
    true
}

pub(crate) fn local_source_id(root: &Path) -> String {
    // Keep the configured root string as the durable source identity. A
    // dynamically canonicalized path is not reproducible while a removable or
    // NAS-backed source is offline.
    format!(
        "local:{}",
        general_purpose::URL_SAFE_NO_PAD.encode(root.to_string_lossy().as_bytes())
    )
}

fn local_item_relative_path(relative_path: &str) -> String {
    // The configured scan directory can itself be an image folder. A dot is
    // the canonical safe path for that directory and remains compatible with
    // Path::join, protocol path validation, and the folder reader.
    if relative_path.is_empty() {
        ".".to_string()
    } else {
        relative_path.to_string()
    }
}

fn loose_root_image_item(
    path: &Path,
    root_dir: &Path,
    ext: &str,
    all_progress: &std::collections::HashMap<String, Progress>,
    virtual_prefix: Option<&str>,
    external_bookmark: Option<&str>,
) -> Option<ComicItem> {
    let relative_path = path.strip_prefix(root_dir).ok()?.to_str()?;
    let is_external = virtual_prefix.is_some();
    let capability_path = if is_external {
        path.to_string_lossy().into_owned()
    } else {
        relative_path.to_string()
    };
    let id = general_purpose::URL_SAFE_NO_PAD.encode(capability_path.as_bytes());
    let shelf_path = virtual_prefix
        .map(|prefix| format!("📁 外部裝置/{prefix}/{relative_path}"))
        .unwrap_or_else(|| relative_path.to_string());
    let title = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Unknown")
        .to_string();
    let series = root_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("未分類")
        .to_string();
    let updated_at = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
    let saved_progress = all_progress.get(&id).cloned().unwrap_or(Progress {
        current_page: 0,
        total_pages: 0,
        percent: 0.0,
        updated_at: None,
    });

    Some(ComicItem {
        id,
        r#type: if is_external {
            "external-image"
        } else {
            "image"
        }
        .to_string(),
        relative_path: shelf_path,
        ext: ext.to_string(),
        title,
        series,
        updated_at,
        page_count: 1,
        progress: saved_progress,
        source_id: external_bookmark
            .map(external_source_id)
            .unwrap_or_else(|| local_source_id(root_dir)),
        source_path: Some(path.to_string_lossy().into_owned()),
        external_bookmark: external_bookmark.map(str::to_owned),
    })
}

pub(crate) fn external_source_id(bookmark: &str) -> String {
    format!(
        "external:{}",
        general_purpose::URL_SAFE_NO_PAD.encode(bookmark.as_bytes())
    )
}

fn smb_runtime_id(relative_path: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(format!("./{relative_path}").as_bytes())
}

fn offline_smb_snapshot(store: &crate::catalog::CatalogStore) -> Result<Vec<ComicItem>, String> {
    let connection = Connection::open(store.path())
        .map_err(|error| format!("無法開啟離線 NAS 目錄：{error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT c.title, c.series, l.relative_path, l.last_seen_at,
                    COALESCE(p.current_page, 0), COALESCE(p.total_pages, 0),
                    COALESCE(p.percent, 0), p.updated_at
             FROM comic_locations l
             JOIN comics c ON c.id = l.comic_id
             LEFT JOIN reading_progress p ON p.comic_id = c.id
             WHERE l.source_id = 'smb'
             ORDER BY lower(c.title), l.relative_path",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let relative_path: String = row.get(2)?;
            let id = smb_runtime_id(&relative_path);
            let current_page = usize::try_from(row.get::<_, i64>(4)?).unwrap_or(0);
            let total_pages = usize::try_from(row.get::<_, i64>(5)?).unwrap_or(0);
            let ext = Path::new(&relative_path)
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| format!(".{}", value.to_ascii_lowercase()))
                .unwrap_or_default();
            Ok(ComicItem {
                id,
                r#type: "offline".to_string(),
                relative_path,
                ext,
                title: row.get(0)?,
                series: row
                    .get::<_, Option<String>>(1)?
                    .unwrap_or_else(|| "未分類".to_string()),
                updated_at: row.get(3)?,
                page_count: total_pages,
                progress: Progress {
                    current_page,
                    total_pages,
                    percent: row.get(6)?,
                    updated_at: row.get(7)?,
                },
                source_id: "smb".to_string(),
                source_path: None,
                external_bookmark: None,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn mark_external_sources_offline(
    store: &crate::catalog::CatalogStore,
    active: &BTreeSet<String>,
) -> Result<usize, String> {
    let mut connection =
        Connection::open(store.path()).map_err(|error| format!("無法開啟外部來源目錄：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    // 只有整輪成功後才退休已移除的來源；目前批次未見不代表離線。
    let sources = {
        let mut statement = tx.prepare("SELECT DISTINCT source_id FROM comic_locations WHERE source_id LIKE 'external:%' AND online = 1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut changed = 0;
    for source in sources
        .into_iter()
        .filter(|source| !active.contains(source))
    {
        changed += tx
            .execute(
                "UPDATE comic_locations SET online = 0 WHERE source_id = ?1",
                [source],
            )
            .map_err(|error| error.to_string())?;
    }
    tx.execute(
        "UPDATE comics SET offline = CASE WHEN EXISTS (
           SELECT 1 FROM comic_locations l WHERE l.comic_id = comics.id AND l.online = 1
         ) THEN 0 ELSE 1 END",
        [],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

async fn mark_external_catalog_sources_offline(
    state: &Arc<AppState>,
    generation: u64,
    active: BTreeSet<String>,
) -> bool {
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    let store = state
        .catalog
        .read()
        .ok()
        .and_then(|catalog| catalog.clone());
    let Some(store) = store else {
        return false;
    };
    let _catalog_sync = state.catalog_sync.lock().await;
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    match tokio::task::spawn_blocking(move || mark_external_sources_offline(&store, &active)).await
    {
        Ok(Ok(count)) => {
            if count > 0 {
                println!("📴 將已移除來源的 {count} 個外部位置標成離線");
            }
            true
        }
        Ok(Err(error)) => {
            eprintln!("⚠️ 外部來源 migration 失敗：{error}");
            false
        }
        Err(error) => {
            eprintln!("⚠️ 外部來源 migration 背景工作失敗：{error}");
            false
        }
    }
}

fn apply_catalog_progress(
    progress: &mut crate::state::ScanProgress,
    generation: u64,
    done: usize,
    total: usize,
    deferred: bool,
) -> bool {
    if progress.generation != generation || !progress.is_scanning {
        return false;
    }
    progress.phase = "catalog".into();
    progress.processed = done.min(total);
    progress.total = total;
    progress.detail_deferred |= deferred;
    true
}

async fn schedule_catalog_sync(
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    source_id: String,
    comics: Vec<ComicItem>,
) -> bool {
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    let store = state
        .catalog
        .read()
        .ok()
        .and_then(|catalog| catalog.clone());
    let Some(store) = store else {
        return true;
    };
    let _catalog_sync = state.catalog_sync.lock().await;
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    // 外部 Files provider 的內容讀取可能觸發下載；自動書架索引只用已知資料。
    let discovery_only = cfg!(target_os = "ios") && source_id.starts_with("external:");
    let progress_state = state.clone();
    let current_state = state.clone();
    let progress_handle = app_handle.clone();
    let result = tokio::task::spawn_blocking(move || {
        if current_state.scan_generation.load(Ordering::Acquire) != generation {
            return Err("掃描已被新工作取代".into());
        }
        if comics.is_empty() {
            return store.mark_source_offline(&source_id).map(|_| 0);
        }
        store.sync_library_with_progress(
            &comics,
            discovery_only,
            |done, total| {
                let status = {
                    let mut progress = progress_state.scan_progress.blocking_lock();
                    if progress_state.scan_generation.load(Ordering::Acquire) != generation
                        || !apply_catalog_progress(
                            &mut progress,
                            generation,
                            done,
                            total,
                            discovery_only,
                        )
                    {
                        return;
                    }
                    progress.clone()
                };
                use tauri::Emitter;
                let _ = progress_handle.emit("scan-progress", status);
            },
            || current_state.scan_generation.load(Ordering::Acquire) == generation,
        )
    })
    .await;
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    match result {
        Ok(Ok(count)) => {
            use tauri::Emitter;
            let _ = app_handle.emit("catalog-changed", count);
            true
        }
        failure => {
            eprintln!("⚠️ 漫畫目錄同步失敗：{failure:?}");
            let mut progress = state.scan_progress.lock().await;
            if progress.generation == generation {
                progress.error = Some("書架整理未完成，請稍後重新掃描".into());
            }
            false
        }
    }
}

async fn mark_catalog_source_offline(state: &Arc<AppState>, source_id: String) {
    let store = state
        .catalog
        .read()
        .ok()
        .and_then(|catalog| catalog.clone());
    let Some(store) = store else {
        return;
    };
    let _catalog_sync = state.catalog_sync.lock().await;
    match tokio::task::spawn_blocking(move || store.mark_source_offline(&source_id)).await {
        Ok(Ok(count)) => println!("📴 來源離線，保留 {count} 個目錄位置"),
        Ok(Err(error)) => eprintln!("⚠️ 標記離線來源失敗：{error}"),
        Err(error) => eprintln!("⚠️ 離線來源背景工作失敗：{error}"),
    }
}

#[allow(clippy::too_many_arguments)]
fn scan_recursive(
    dir: &Path,
    root_dir: &Path,
    depth: usize,
    results: &mut Vec<ComicItem>,
    app_handle: &tauri::AppHandle,
    state: &Arc<AppState>,
    my_gen: u64,
    all_progress: &std::collections::HashMap<String, Progress>,
    virtual_prefix: Option<&str>,
    external_bookmark: Option<&str>,
    published: &mut usize,
    published_at: &mut Instant,
    incomplete: &AtomicBool,
    visible_generation: Option<u64>,
) {
    if state.scan_generation.load(Ordering::Relaxed) != my_gen
        || visible_generation
            .is_some_and(|visible| state.visible_scan_generation.load(Ordering::Relaxed) != visible)
    {
        return;
    }
    if depth > MAX_LOCAL_SCAN_DEPTH {
        incomplete.store(true, Ordering::Release);
        eprintln!(
            "⚠️ 漫畫掃描超過 {MAX_LOCAL_SCAN_DEPTH} 層，未將該來源視為完整刪除快照：{}",
            dir.display()
        );
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => {
            incomplete.store(true, Ordering::Release);
            eprintln!("⚠️ 無法讀取漫畫目錄 {}：{error}", dir.display());
            return;
        }
    };
    let mut has_images = false;
    let mut image_count = 0usize;
    let mut subdirs = Vec::new();
    for entry in entries {
        if state.scan_generation.load(Ordering::Acquire) != my_gen
            || visible_generation.is_some_and(|visible| {
                state.visible_scan_generation.load(Ordering::Acquire) != visible
            })
        {
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                incomplete.store(true, Ordering::Release);
                eprintln!("⚠️ 漫畫目錄項目無法讀取 {}：{error}", dir.display());
                continue;
            }
        };
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "__MACOSX" || name_str == "node_modules" {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                incomplete.store(true, Ordering::Release);
                eprintln!(
                    "⚠️ 無法判斷漫畫項目類型 {}：{error}",
                    entry.path().display()
                );
                continue;
            }
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            subdirs.push(path);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        let ext_lower = format!(".{}", ext.to_lowercase());
        if IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) {
            has_images = true;
            image_count += 1;
            // The selected scan root behaves like an inbox: loose image
            // files must be visible individually on the shelf. Nested
            // image directories remain one readable comic so a large
            // library does not explode into page-level catalog rows.
            if depth == 0 {
                if let Some(item) = loose_root_image_item(
                    &path,
                    root_dir,
                    &ext_lower,
                    all_progress,
                    virtual_prefix,
                    external_bookmark,
                ) {
                    results.push(item);
                    publish_discovery(
                        results,
                        state,
                        app_handle,
                        my_gen,
                        visible_generation,
                        published,
                        published_at,
                    );
                } else {
                    incomplete.store(true, Ordering::Release);
                    eprintln!("⚠️ 根目錄圖片無法安全轉為書庫項目：{}", path.display());
                }
            }
            continue;
        }
        if ext_lower != ".cbz" && ext_lower != ".zip" {
            continue;
        }
        let Some(rel_path) = path
            .strip_prefix(root_dir)
            .ok()
            .and_then(|value| value.to_str())
        else {
            incomplete.store(true, Ordering::Release);
            eprintln!("⚠️ 漫畫路徑無法安全轉為書庫相對路徑：{}", path.display());
            continue;
        };
        let is_external = virtual_prefix.is_some();
        let actual_path_str = if is_external {
            path.to_string_lossy().to_string()
        } else {
            rel_path.to_string()
        };
        let id = general_purpose::URL_SAFE_NO_PAD.encode(actual_path_str.as_bytes());
        let virtual_path = if let Some(prefix) = virtual_prefix {
            format!("📁 外部裝置/{prefix}/{rel_path}")
        } else {
            rel_path.to_string()
        };
        let title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Unknown")
            .to_string();
        let series = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|value| value.to_str())
            .unwrap_or("未分類")
            .to_string();
        let updated_at = std::fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
            .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
        let saved_progress = all_progress.get(&id).cloned().unwrap_or(Progress {
            current_page: 0,
            total_pages: 0,
            percent: 0.0,
            updated_at: None,
        });
        results.push(ComicItem {
            id,
            r#type: if is_external {
                "external-archive"
            } else {
                "archive"
            }
            .to_string(),
            relative_path: virtual_path,
            ext: ext_lower,
            title,
            series,
            updated_at,
            page_count: 0,
            progress: saved_progress,
            source_id: external_bookmark
                .map(external_source_id)
                .unwrap_or_else(|| local_source_id(root_dir)),
            source_path: Some(path.to_string_lossy().to_string()),
            external_bookmark: external_bookmark.map(str::to_owned),
        });
        publish_discovery(
            results,
            state,
            app_handle,
            my_gen,
            visible_generation,
            published,
            published_at,
        );
    }

    if has_images && depth > 0 {
        let Some(rel_path) = dir
            .strip_prefix(root_dir)
            .ok()
            .and_then(|value| value.to_str())
        else {
            incomplete.store(true, Ordering::Release);
            eprintln!("⚠️ 漫畫資料夾無法安全轉為書庫相對路徑：{}", dir.display());
            return;
        };
        let is_external = virtual_prefix.is_some();
        let local_relative_path = if is_external {
            rel_path.to_string()
        } else {
            local_item_relative_path(rel_path)
        };
        let actual_path_str = if is_external {
            dir.to_string_lossy().to_string()
        } else {
            local_relative_path.clone()
        };
        if !local_relative_path.is_empty() || is_external {
            let id = general_purpose::URL_SAFE_NO_PAD.encode(actual_path_str.as_bytes());
            let virtual_path = if let Some(prefix) = virtual_prefix {
                if rel_path.is_empty() {
                    format!("📁 外部裝置/{prefix}")
                } else {
                    format!("📁 外部裝置/{prefix}/{rel_path}")
                }
            } else {
                local_relative_path.clone()
            };
            let title = dir
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Unknown")
                .to_string();
            let series = dir
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|value| value.to_str())
                .unwrap_or("未分類")
                .to_string();
            let updated_at = std::fs::metadata(dir)
                .and_then(|metadata| metadata.modified())
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
                .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
            let saved_progress = all_progress.get(&id).cloned().unwrap_or(Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            });
            results.push(ComicItem {
                id,
                r#type: if is_external {
                    "external-folder"
                } else {
                    "folder"
                }
                .to_string(),
                relative_path: virtual_path,
                ext: String::new(),
                title,
                series,
                updated_at,
                page_count: image_count,
                progress: saved_progress,
                source_id: external_bookmark
                    .map(external_source_id)
                    .unwrap_or_else(|| local_source_id(root_dir)),
                source_path: Some(dir.to_string_lossy().to_string()),
                external_bookmark: external_bookmark.map(str::to_owned),
            });
            publish_discovery(
                results,
                state,
                app_handle,
                my_gen,
                visible_generation,
                published,
                published_at,
            );
        }
    }

    for subdir in subdirs {
        scan_recursive(
            &subdir,
            root_dir,
            depth + 1,
            results,
            app_handle,
            state,
            my_gen,
            all_progress,
            virtual_prefix,
            external_bookmark,
            published,
            published_at,
            incomplete,
            visible_generation,
        );
    }
}

fn safe_visible_relative_path(relative_path: &str) -> Option<&str> {
    if relative_path.starts_with('/')
        || relative_path.contains('\\')
        || (!relative_path.is_empty()
            && relative_path.split('/').any(|part| {
                part.is_empty() || part == "." || part == ".." || part.starts_with('.')
            }))
    {
        None
    } else {
        Some(relative_path)
    }
}

pub async fn scan_visible_directory(
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
    relative_path: String,
) -> Result<(), String> {
    let visible_generation = state.visible_scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
    if relative_path.is_empty() || relative_path == "📁 外部裝置" {
        return Ok(());
    }
    let generation = state.scan_generation.load(Ordering::Acquire);
    if !state.scan_progress.lock().await.is_scanning {
        return Ok(());
    }
    let (smb_task, run_local) = if relative_path.starts_with("📁 外部裝置/") {
        (None, true)
    } else {
        let prefix = format!("{relative_path}/");
        let (known_smb, known_local) = {
            let comics = state.comics.lock().await;
            let sources = comics
                .iter()
                .filter(|comic| {
                    comic.relative_path == relative_path || comic.relative_path.starts_with(&prefix)
                })
                .map(|comic| comic.source_id.as_str())
                .collect::<Vec<_>>();
            (
                sources.contains(&"smb"),
                sources.iter().any(|source| *source != "smb"),
            )
        };
        let config = state.smb_config.read().unwrap().clone();
        if let Some(config) = config.filter(|_| known_smb || !known_local) {
            let smb_state = state.clone();
            let smb_handle = app_handle.clone();
            let smb_path = relative_path.clone();
            let task = tokio::spawn(async move {
                crate::smb_scanner::scan_visible_smb(
                    config,
                    smb_state,
                    generation,
                    visible_generation,
                    smb_handle,
                    smb_path,
                )
                .await
            });
            (Some(task), !known_smb || known_local)
        } else {
            (None, true)
        }
    };
    if !run_local {
        return smb_task
            .expect("SMB only when no local source")
            .await
            .map_err(|error| error.to_string())?;
    }
    let (root, subpath, virtual_prefix, bookmark) = if let Some(external_path) =
        relative_path.strip_prefix("📁 外部裝置/")
    {
        let bookmarks = state.external_bookmarks.read().unwrap().clone();
        let Some(entry) = bookmarks.iter().find(|entry| {
            external_path == entry.name || external_path.starts_with(&format!("{}/", entry.name))
        }) else {
            return Err("找不到目前外部漫畫來源".into());
        };
        let subpath = external_path
            .strip_prefix(&format!("{}/", entry.name))
            .unwrap_or("")
            .to_string();
        let active_root = state
            .active_bookmarks
            .lock()
            .unwrap()
            .get(&entry.bookmark)
            .cloned();
        let root = if let Some(root) = active_root {
            root
        } else {
            #[cfg(target_os = "ios")]
            {
                use tauri_plugin_ios_folder::{StartAccessingRequest, TauriPluginIosFolderExt};
                let path = app_handle
                    .tauri_plugin_ios_folder()
                    .start_accessing(StartAccessingRequest {
                        bookmark: entry.bookmark.clone(),
                    })
                    .map_err(|error| format!("無法存取外部漫畫來源：{error}"))?
                    .path;
                state
                    .active_bookmarks
                    .lock()
                    .unwrap()
                    .insert(entry.bookmark.clone(), path.clone());
                path
            }
            #[cfg(not(target_os = "ios"))]
            {
                return Ok(());
            }
        };
        (
            root,
            subpath,
            Some(entry.name.clone()),
            Some(entry.bookmark.clone()),
        )
    } else {
        (
            state.scan_dir.read().unwrap().clone(),
            relative_path,
            None,
            None,
        )
    };
    let subpath =
        safe_visible_relative_path(&subpath).ok_or_else(|| "漫畫目錄路徑無效".to_string())?;
    if root.is_empty() {
        if let Some(task) = smb_task {
            return task.await.map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    let root_path = std::path::PathBuf::from(root);
    let subpath = subpath.to_string();
    let local_result = tokio::task::spawn_blocking(move || {
        let root_canonical = root_path
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut target = root_path.clone();
        for part in subpath.split('/').filter(|part| !part.is_empty()) {
            target.push(part);
            if std::fs::symlink_metadata(&target)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("漫畫目錄不可經過符號連結".to_string());
            }
        }
        let target_canonical = target.canonicalize().map_err(|error| error.to_string())?;
        if !target_canonical.starts_with(&root_canonical) || !target_canonical.is_dir() {
            return Err("漫畫目錄超出來源範圍".to_string());
        }
        let progress_file = root_path.join(".comic_progress.json");
        let progress = load_progress_file(&progress_file).unwrap_or_default();
        let mut results = Vec::new();
        let mut published = 0;
        let mut published_at = Instant::now();
        let incomplete = AtomicBool::new(false);
        scan_recursive(
            &target,
            &root_path,
            if subpath.is_empty() {
                0
            } else {
                subpath.split('/').count()
            },
            &mut results,
            &app_handle,
            &state,
            generation,
            &progress,
            virtual_prefix.as_deref(),
            bookmark.as_deref(),
            &mut published,
            &mut published_at,
            &incomplete,
            Some(visible_generation),
        );
        publish_visible_library(
            &results,
            &state,
            &app_handle,
            generation,
            visible_generation,
            &mut published,
            &mut published_at,
        );
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Some(task) = smb_task {
        let smb_result = task.await.map_err(|error| error.to_string())?;
        if local_result.is_ok() {
            return Ok(());
        }
        return smb_result;
    }
    local_result
}

pub async fn start_background_scan(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    let requested_dir = state.scan_dir.read().unwrap().clone();
    let probe_dir = requested_dir.clone();
    let source_exists = tokio::task::spawn_blocking(move || {
        !probe_dir.is_empty() && Path::new(&probe_dir).exists()
    })
    .await
    .unwrap_or(false);
    let unavailable = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let configured_dir = state.scan_dir.read().unwrap().clone();
        if configured_dir != requested_dir {
            return;
        }
        let has_external_sources = !state.external_bookmarks.read().unwrap().is_empty();
        let has_smb_source = state.smb_config.read().unwrap().is_some();
        let has_other_sources = has_external_sources || has_smb_source;
        if configured_dir.is_empty() {
            if has_other_sources {
                None
            } else {
                return;
            }
        } else if source_exists || has_other_sources {
            None
        } else {
            let generation = state.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
            state.comics.lock().await.clear();
            {
                let mut progress = state.scan_progress.lock().await;
                progress.generation = generation;
                progress.is_scanning = false;
                progress.phase = "error".into();
                progress.processed = 0;
                progress.total = 0;
                progress.detail_deferred = false;
                progress.error = Some("漫畫來源目前無法存取".into());
                progress.found = 0;
                progress.current_path = configured_dir.clone();
                progress.started_at = Some(chrono::Utc::now().to_rfc3339());
                progress.completed_at = Some(chrono::Utc::now().to_rfc3339());
            }
            Some((configured_dir, generation))
        }
    };
    if let Some((configured_dir, generation)) = unavailable {
        mark_catalog_source_offline(&state, local_source_id(Path::new(&configured_dir))).await;
        if state.scan_generation.load(Ordering::Acquire) == generation {
            use tauri::Emitter;
            let _ = app_handle.emit("library-changed", 0usize);
            let _ = app_handle.emit("catalog-changed", 0usize);
        }
        return;
    }

    let (scan_dir, my_gen, local_source_available) = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let scan_dir = state.scan_dir.read().unwrap().clone();
        if scan_dir != requested_dir {
            return;
        }
        let external_source_name = state
            .external_bookmarks
            .read()
            .unwrap()
            .first()
            .map(|source| source.name.clone());
        let has_smb_source = state.smb_config.read().unwrap().is_some();
        let local_source_available = source_exists;
        if !local_source_available && external_source_name.is_none() && !has_smb_source {
            return;
        }
        let my_gen = state.scan_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut progress = state.scan_progress.lock().await;
        progress.generation = my_gen;
        progress.is_scanning = true;
        progress.phase = "discovering".into();
        progress.processed = 0;
        progress.total = 0;
        progress.detail_deferred = false;
        progress.error = None;
        progress.found = 0;
        progress.current_path = if local_source_available {
            scan_dir.clone()
        } else if let Some(name) = external_source_name {
            name
        } else {
            "SMB NAS".to_string()
        };
        progress.started_at = Some(chrono::Utc::now().to_rfc3339());
        progress.completed_at = None;
        (scan_dir, my_gen, local_source_available)
    };

    // Publish the new scan generation before the first batch. This lets the
    // renderer reject late events from a cancelled/previous source scan.
    if state.scan_generation.load(Ordering::Acquire) == my_gen {
        let progress = state.scan_progress.lock().await.clone();
        use tauri::Emitter;
        let _ = app_handle.emit("scan-progress", progress);
    }

    let configured_local_source =
        (!scan_dir.is_empty()).then(|| local_source_id(Path::new(&scan_dir)));
    if !scan_dir.is_empty() && !local_source_available {
        if let Some(source_id) = configured_local_source.clone() {
            mark_catalog_source_offline(&state, source_id).await;
        }
    }

    println!("⏳ 掃描漫畫庫: {scan_dir}");
    let all_progress = if local_source_available {
        let progress_file = Path::new(&scan_dir).join(".comic_progress.json");
        match tokio::task::spawn_blocking(move || load_progress_file(&progress_file)).await {
            Ok(Ok(progress)) => progress,
            Ok(Err(error)) => {
                eprintln!("⚠️ 忽略漫畫進度檔：{error}");
                std::collections::HashMap::new()
            }
            Err(error) => {
                eprintln!("⚠️ 進度檔背景工作失敗：{error}");
                std::collections::HashMap::new()
            }
        }
    } else {
        std::collections::HashMap::new()
    };
    let all_progress = Arc::new(all_progress);

    let scan_dir_clone = scan_dir.clone();
    let app_handle_clone = app_handle.clone();
    let state_clone_for_spawn = state.clone();
    let scanned_comics_task = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let local_incomplete = AtomicBool::new(false);
        let external_incomplete = AtomicBool::new(false);

        let state_clone = state_clone_for_spawn.clone();
        let mut published = 0usize;
        let mut published_at = Instant::now();
        if local_source_available {
            let root_path = Path::new(&scan_dir_clone);
            scan_recursive(
                root_path,
                root_path,
                0,
                &mut results,
                &app_handle_clone,
                &state_clone,
                my_gen,
                &all_progress,
                None,
                None,
                &mut published,
                &mut published_at,
                &local_incomplete,
                None,
            );
        }

        let external_bookmarks = state_clone.external_bookmarks.read().unwrap().clone();
        let external_source_ids = external_bookmarks
            .iter()
            .map(|entry| external_source_id(&entry.bookmark))
            .collect::<BTreeSet<_>>();
        #[cfg(not(target_os = "ios"))]
        if !external_bookmarks.is_empty() {
            external_incomplete.store(true, Ordering::Release);
        }
        #[allow(unused_variables)]
        for bookmark_entry in external_bookmarks {
            #[cfg(target_os = "ios")]
            {
                use tauri_plugin_ios_folder::StartAccessingRequest;
                use tauri_plugin_ios_folder::StopAccessingRequest;
                use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
                if state_clone.scan_generation.load(Ordering::Acquire) != my_gen {
                    break;
                }
                match app_handle_clone.tauri_plugin_ios_folder().start_accessing(
                    StartAccessingRequest {
                        bookmark: bookmark_entry.bookmark.clone(),
                    },
                ) {
                    Ok(res) => {
                        if state_clone.scan_generation.load(Ordering::Acquire) != my_gen {
                            let still_configured = state_clone
                                .external_bookmarks
                                .read()
                                .unwrap()
                                .iter()
                                .any(|entry| entry.bookmark == bookmark_entry.bookmark);
                            if !still_configured {
                                let _ = app_handle_clone.tauri_plugin_ios_folder().stop_accessing(
                                    StopAccessingRequest {
                                        bookmark: bookmark_entry.bookmark.clone(),
                                    },
                                );
                            }
                            continue;
                        }
                        let resolved_path = Path::new(&res.path);
                        state_clone
                            .active_bookmarks
                            .lock()
                            .unwrap()
                            .insert(bookmark_entry.bookmark.clone(), res.path.clone());
                        scan_recursive(
                            resolved_path,
                            resolved_path,
                            0,
                            &mut results,
                            &app_handle_clone,
                            &state_clone,
                            my_gen,
                            &all_progress,
                            Some(&bookmark_entry.name),
                            Some(&bookmark_entry.bookmark),
                            &mut published,
                            &mut published_at,
                            &external_incomplete,
                            None,
                        );
                    }
                    Err(error) => {
                        external_incomplete.store(true, Ordering::Release);
                        eprintln!(
                            "⚠️ 無法啟用外部資料夾 {} 的安全存取權限：{error}",
                            bookmark_entry.name
                        );
                    }
                }
            }
        }
        ScanOutcome {
            comics: results,
            local_source_id: configured_local_source,
            local_source_available,
            local_complete: local_source_available && !local_incomplete.load(Ordering::Acquire),
            external_source_ids,
            external_complete: !external_incomplete.load(Ordering::Acquire),
        }
    })
    .await;

    match scanned_comics_task {
        Ok(outcome) => {
            let scan_lifecycle = state.scan_lifecycle.lock().await;
            if state.scan_generation.load(Ordering::SeqCst) != my_gen {
                return;
            }
            let local_complete = outcome.local_complete;
            let external_complete = outcome.external_complete;
            let local_source_id = outcome.local_source_id.clone();
            let external_source_ids = outcome.external_source_ids.clone();
            let discovered = outcome.comics.clone();
            let mut state_comics = state.comics.lock().await;
            apply_scan_outcome(&mut state_comics, &outcome);
            let local_count = state_comics.len();
            drop(state_comics);
            drop(scan_lifecycle);

            if local_complete {
                if let Some(source_id) = local_source_id {
                    schedule_catalog_sync(
                        &state,
                        &app_handle,
                        my_gen,
                        source_id.clone(),
                        source_items(&discovered, &source_id),
                    )
                    .await;
                }
            } else if outcome.local_source_available {
                eprintln!("⚠️ 本輪本機檔案系統掃描不完整；保留未確認的本機書架／SQLite 狀態");
                record_scan_error(&state, my_gen).await;
            }

            if external_complete {
                let mut all_synced = true;
                for source_id in &external_source_ids {
                    all_synced &= schedule_catalog_sync(
                        &state,
                        &app_handle,
                        my_gen,
                        source_id.clone(),
                        source_items(&discovered, source_id),
                    )
                    .await;
                    if state.scan_generation.load(Ordering::Acquire) != my_gen {
                        return;
                    }
                }
                if all_synced
                    && !mark_external_catalog_sources_offline(&state, my_gen, external_source_ids)
                        .await
                {
                    record_scan_error(&state, my_gen).await;
                }
            } else {
                eprintln!("⚠️ 本輪外部資料夾掃描不完整；保留未確認的外部書架／SQLite 狀態");
                record_scan_error(&state, my_gen).await;
            }

            let smb_cfg = state.smb_config.read().unwrap().clone();
            if let Some(cfg) = smb_cfg {
                let state_clone = state.clone();
                let handle = app_handle.clone();
                tokio::spawn(async move {
                    println!("🌐 開始掃描 SMB NAS...");
                    {
                        let mut progress = state_clone.scan_progress.lock().await;
                        if progress.generation != my_gen {
                            return;
                        }
                        progress.phase = "discovering".into();
                        progress.processed = 0;
                        progress.total = 0;
                    }
                    if let Err(error) = crate::smb_scanner::scan_smb(
                        cfg,
                        state_clone.clone(),
                        my_gen,
                        handle.clone(),
                    )
                    .await
                    {
                        eprintln!("❌ SMB 掃描錯誤: {error}");
                        record_scan_error(&state_clone, my_gen).await;
                        if state_clone.scan_generation.load(Ordering::SeqCst) != my_gen {
                            return;
                        }
                        let catalog = state_clone
                            .catalog
                            .read()
                            .ok()
                            .and_then(|store| store.clone());
                        if let Some(catalog) = catalog {
                            let _catalog_sync = state_clone.catalog_sync.lock().await;
                            let catalog_for_mark = catalog.clone();
                            match tokio::task::spawn_blocking(move || {
                                catalog_for_mark.mark_source_offline("smb")
                            })
                            .await
                            {
                                Ok(Ok(changed)) => {
                                    println!("📴 NAS 離線，保留 {changed} 個目錄位置")
                                }
                                Ok(Err(mark_error)) => {
                                    eprintln!("⚠️ 無法更新 NAS 離線狀態：{mark_error}")
                                }
                                Err(join_error) => {
                                    eprintln!("⚠️ NAS 離線背景工作失敗：{join_error}")
                                }
                            }
                            if state_clone.scan_generation.load(Ordering::SeqCst) != my_gen {
                                return;
                            }
                            let snapshot_result = tokio::task::spawn_blocking({
                                let catalog = catalog.clone();
                                move || offline_smb_snapshot(&catalog)
                            })
                            .await;
                            match snapshot_result {
                                Ok(Ok(snapshot)) => {
                                    let _scan_lifecycle = state_clone.scan_lifecycle.lock().await;
                                    if state_clone.scan_generation.load(Ordering::SeqCst) != my_gen
                                    {
                                        return;
                                    }
                                    let mut comics = state_clone.comics.lock().await;
                                    comics.retain(|comic| comic.source_id != "smb");
                                    comics.extend(snapshot);
                                }
                                Ok(Err(snapshot_error)) => {
                                    eprintln!("⚠️ 無法載入離線 NAS 書架：{snapshot_error}")
                                }
                                Err(join_error) => {
                                    eprintln!("⚠️ 離線 NAS 書架背景工作失敗：{join_error}")
                                }
                            }
                        }
                        let count = state_clone.comics.lock().await.len();
                        finish_scan_if_current(&state_clone, &handle, my_gen, Some(count)).await;
                    } else {
                        let scan_lifecycle = state_clone.scan_lifecycle.lock().await;
                        if state_clone.scan_generation.load(Ordering::SeqCst) != my_gen {
                            return;
                        }
                        let smb_items = state_clone
                            .comics
                            .lock()
                            .await
                            .iter()
                            .filter(|comic| comic.source_id == "smb")
                            .cloned()
                            .collect::<Vec<_>>();
                        let count = state_clone.comics.lock().await.len();
                        drop(scan_lifecycle);
                        schedule_catalog_sync(
                            &state_clone,
                            &handle,
                            my_gen,
                            "smb".to_string(),
                            smb_items,
                        )
                        .await;
                        println!("✅ SMB 掃描完成，總共 {count} 本漫畫");
                        finish_scan_if_current(&state_clone, &handle, my_gen, Some(count)).await;
                    }
                });
            } else {
                mark_catalog_source_offline(&state, "smb".to_string()).await;
                finish_scan_if_current(&state, &app_handle, my_gen, Some(local_count)).await;
            }
        }
        Err(error) => {
            eprintln!("❌ 掃描失敗: {error:?}");
            record_scan_error(&state, my_gen).await;
            finish_scan_if_current(&state, &app_handle, my_gen, None).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_scan_paths_stay_within_selected_source() {
        assert_eq!(
            safe_visible_relative_path("Series/Volume 2"),
            Some("Series/Volume 2")
        );
        assert_eq!(safe_visible_relative_path(""), Some(""));
        for unsafe_path in [
            "/tmp",
            "../Other",
            "Series/../Other",
            "Series//Other",
            "Series\\Other",
            ".hidden",
        ] {
            assert_eq!(safe_visible_relative_path(unsafe_path), None);
        }
    }

    fn comic(id: &str, title: &str, source_id: &str) -> ComicItem {
        ComicItem {
            id: id.to_string(),
            r#type: "archive".to_string(),
            relative_path: format!("{id}.cbz"),
            ext: ".cbz".to_string(),
            title: title.to_string(),
            series: "測試".to_string(),
            updated_at: "2026-08-31T00:00:00Z".to_string(),
            page_count: 0,
            progress: Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            },
            source_id: source_id.to_string(),
            source_path: None,
            external_bookmark: None,
        }
    }

    fn outcome(
        comics: Vec<ComicItem>,
        local_complete: bool,
        external_complete: bool,
    ) -> ScanOutcome {
        ScanOutcome {
            comics,
            local_source_id: Some("local:test".into()),
            local_source_available: true,
            local_complete,
            external_source_ids: BTreeSet::from(["external:one".into()]),
            external_complete,
        }
    }

    #[test]
    fn legacy_scan_progress_remains_readable() {
        let progress: crate::state::ScanProgress = serde_json::from_value(serde_json::json!({
            "isScanning": true, "generation": 1, "found": 5620, "currentPath": "",
            "startedAt": null, "completedAt": null
        }))
        .unwrap();
        assert_eq!(progress.processed, 0);
        assert_eq!(progress.total, 0);
        assert!(!progress.detail_deferred);
        assert!(progress.error.is_none());
    }

    #[test]
    fn catalog_progress_preserves_generation_and_real_scan_state() {
        let state = AppState::new();
        let mut progress = state.scan_progress.blocking_lock();
        progress.generation = 7;
        progress.is_scanning = true;
        progress.found = 5620;
        assert!(!apply_catalog_progress(&mut progress, 6, 64, 5620, true));
        assert!(apply_catalog_progress(&mut progress, 7, 64, 5620, true));
        assert_eq!(progress.phase, "catalog");
        assert_eq!(progress.processed, 64);
        assert_eq!(progress.found, 5620);
        assert!(progress.is_scanning);
        assert!(progress.detail_deferred);
        assert!(apply_catalog_progress(&mut progress, 7, 0, 8, false));
        assert!(progress.detail_deferred);
        progress.is_scanning = false;
        assert!(!apply_catalog_progress(&mut progress, 7, 8, 8, false));
    }

    #[test]
    fn first_discovered_comic_publishes_immediately() {
        assert!(should_publish_partial(1, 0, Duration::ZERO));
    }

    #[test]
    fn partial_publication_is_batched_or_time_bounded() {
        assert!(!should_publish_partial(
            PARTIAL_LIBRARY_BATCH,
            1,
            PARTIAL_LIBRARY_INTERVAL - Duration::from_millis(1)
        ));
        assert!(should_publish_partial(
            PARTIAL_LIBRARY_BATCH + 1,
            1,
            Duration::ZERO
        ));
        assert!(should_publish_partial(2, 1, PARTIAL_LIBRARY_INTERVAL));
    }

    #[test]
    fn unchanged_library_does_not_publish_again() {
        assert!(!should_publish_partial(
            12,
            12,
            PARTIAL_LIBRARY_INTERVAL * 2
        ));
    }

    #[test]
    fn incomplete_local_scan_does_not_block_complete_external_replacement() {
        let mut library = vec![
            comic("local-old", "本機舊書", "local:test"),
            comic("external-old", "外部舊書", "external:one"),
        ];
        let result = outcome(
            vec![comic("external-new", "外部新書", "external:one")],
            false,
            true,
        );
        apply_scan_outcome(&mut library, &result);
        assert!(library.iter().any(|comic| comic.id == "local-old"));
        assert!(!library.iter().any(|comic| comic.id == "external-old"));
        assert!(library.iter().any(|comic| comic.id == "external-new"));
    }

    #[test]
    fn incomplete_external_scan_does_not_block_complete_local_replacement() {
        let mut library = vec![
            comic("local-old", "本機舊書", "local:test"),
            comic("external-old", "外部舊書", "external:one"),
        ];
        let result = outcome(
            vec![comic("local-new", "本機新書", "local:test")],
            true,
            false,
        );
        apply_scan_outcome(&mut library, &result);
        assert!(!library.iter().any(|comic| comic.id == "local-old"));
        assert!(library.iter().any(|comic| comic.id == "local-new"));
        assert!(library.iter().any(|comic| comic.id == "external-old"));
    }

    #[test]
    fn missing_local_source_is_retained_as_offline_until_remounted() {
        let mut library = vec![comic("local-old", "本機舊書", "local:test")];
        let mut result = outcome(vec![], false, true);
        result.local_source_available = false;
        apply_scan_outcome(&mut library, &result);
        assert_eq!(library[0].r#type, "offline");
    }

    #[test]
    fn scan_outcome_always_removes_stale_smb_runtime_state() {
        let mut library = vec![
            comic("local", "本機", "local:test"),
            comic("smb", "NAS", "smb"),
        ];
        apply_scan_outcome(&mut library, &outcome(vec![], false, false));
        assert_eq!(library.len(), 1);
        assert_eq!(library[0].id, "local");
    }

    #[test]
    fn source_filters_include_empty_authoritative_sources() {
        let comics = vec![comic("one", "一", "local:test")];
        assert_eq!(source_items(&comics, "local:test").len(), 1);
        assert!(source_items(&comics, "smb").is_empty());
    }

    #[test]
    fn smb_runtime_id_is_source_scoped() {
        let relative = "series/book.cbz";
        assert_ne!(
            smb_runtime_id(relative),
            general_purpose::URL_SAFE_NO_PAD.encode(relative.as_bytes())
        );
    }

    #[test]
    fn local_source_id_is_reproducible_for_an_offline_configured_path() {
        let configured = Path::new("/Volumes/ComicsNAS/Library");
        assert_eq!(local_source_id(configured), local_source_id(configured));
    }

    #[test]
    fn local_scan_root_image_folder_uses_dot_relative_path() {
        assert_eq!(local_item_relative_path(""), ".");
        assert_eq!(local_item_relative_path("series/book"), "series/book");
    }

    #[test]
    fn loose_root_image_becomes_a_single_page_shelf_item() {
        let root = Path::new("/library");
        let image = root.join("下載圖片.png");
        let item = loose_root_image_item(
            &image,
            root,
            ".png",
            &std::collections::HashMap::new(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(item.r#type, "image");
        assert_eq!(item.relative_path, "下載圖片.png");
        assert_eq!(item.title, "下載圖片");
        assert_eq!(item.series, "library");
        assert_eq!(item.page_count, 1);
        assert_eq!(
            item.id,
            general_purpose::URL_SAFE_NO_PAD.encode("下載圖片.png".as_bytes())
        );
    }

    #[test]
    fn progress_file_size_is_bounded_before_json_parse() {
        let path = std::env::temp_dir().join(format!(
            "gai-progress-limit-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::write(&path, vec![b'0'; MAX_PROGRESS_FILE_BYTES + 1]).unwrap();
        let result = load_progress_file(&path);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err());
    }
}
