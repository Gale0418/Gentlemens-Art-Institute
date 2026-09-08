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

fn mark_external_sources_offline(store: &crate::catalog::CatalogStore) -> Result<usize, String> {
    let mut connection =
        Connection::open(store.path()).map_err(|error| format!("無法開啟外部來源目錄：{error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let changed = tx
        .execute(
            "UPDATE comic_locations SET online = 0 WHERE source_id LIKE 'external:%' AND online = 1",
            [],
        )
        .map_err(|error| format!("無法標記舊外部來源離線：{error}"))?;
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

async fn mark_external_catalog_sources_offline(state: &Arc<AppState>, generation: u64) -> bool {
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
    match tokio::task::spawn_blocking(move || mark_external_sources_offline(&store)).await {
        Ok(Ok(count)) => {
            if count > 0 {
                println!("📴 先將 {count} 個既有外部位置標成離線，等待本輪掃描重新確認");
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

async fn schedule_catalog_sync(
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    source_id: String,
    comics: Vec<ComicItem>,
) {
    if state.scan_generation.load(Ordering::Acquire) != generation {
        return;
    }
    let store = state
        .catalog
        .read()
        .ok()
        .and_then(|catalog| catalog.clone());
    if let Some(store) = store {
        let _catalog_sync = state.catalog_sync.lock().await;
        if state.scan_generation.load(Ordering::Acquire) != generation {
            return;
        }
        let result = tokio::task::spawn_blocking(move || {
            // Mark first even when the authoritative scan found zero books.
            // Otherwise an empty NAS/folder leaves its previous rows online.
            store.mark_source_offline(&source_id)?;
            if comics.is_empty() {
                Ok(0)
            } else {
                store.sync_library(&comics)
            }
        })
        .await;
        match result {
            Ok(Ok(count)) => {
                if state.scan_generation.load(Ordering::Acquire) != generation {
                    return;
                }
                println!("🗂️ 漫畫目錄已同步 {count} 本");
                use tauri::Emitter;
                let _ = app_handle.emit("catalog-changed", count);
            }
            Ok(Err(error)) => eprintln!("⚠️ 漫畫目錄同步失敗：{error}"),
            Err(error) => eprintln!("⚠️ 漫畫目錄背景工作失敗：{error}"),
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
        ) {
            if state.scan_generation.load(Ordering::Relaxed) != my_gen {
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
            let mut subdirs = Vec::new();
            for entry in entries {
                if state.scan_generation.load(Ordering::Acquire) != my_gen {
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
                if name_str.starts_with('.') || name_str == "__MACOSX" || name_str == "node_modules"
                {
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
                publish_partial_library(
                    results,
                    state,
                    app_handle,
                    my_gen,
                    published,
                    published_at,
                );
            }

            if has_images {
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
                let actual_path_str = if is_external {
                    dir.to_string_lossy().to_string()
                } else {
                    rel_path.to_string()
                };
                if !rel_path.is_empty() || is_external {
                    let id = general_purpose::URL_SAFE_NO_PAD.encode(actual_path_str.as_bytes());
                    let virtual_path = if let Some(prefix) = virtual_prefix {
                        if rel_path.is_empty() {
                            format!("📁 外部裝置/{prefix}")
                        } else {
                            format!("📁 外部裝置/{prefix}/{rel_path}")
                        }
                    } else {
                        rel_path.to_string()
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
                        page_count: 0,
                        progress: saved_progress,
                        source_id: external_bookmark
                            .map(external_source_id)
                            .unwrap_or_else(|| local_source_id(root_dir)),
                        source_path: Some(dir.to_string_lossy().to_string()),
                        external_bookmark: external_bookmark.map(str::to_owned),
                    });
                    publish_partial_library(
                        results,
                        state,
                        app_handle,
                        my_gen,
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
                );
            }
        }

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
            }

            if external_complete {
                if mark_external_catalog_sources_offline(&state, my_gen).await {
                    for source_id in external_source_ids {
                        schedule_catalog_sync(
                            &state,
                            &app_handle,
                            my_gen,
                            source_id.clone(),
                            source_items(&discovered, &source_id),
                        )
                        .await;
                    }
                }
            } else {
                eprintln!("⚠️ 本輪外部資料夾掃描不完整；保留未確認的外部書架／SQLite 狀態");
            }

            let smb_cfg = state.smb_config.read().unwrap().clone();
            if let Some(cfg) = smb_cfg {
                let state_clone = state.clone();
                let handle = app_handle.clone();
                tokio::spawn(async move {
                    println!("🌐 開始掃描 SMB NAS...");
                    if let Err(error) = crate::smb_scanner::scan_smb(
                        cfg,
                        state_clone.clone(),
                        my_gen,
                        handle.clone(),
                    )
                    .await
                    {
                        eprintln!("❌ SMB 掃描錯誤: {error}");
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
            finish_scan_if_current(&state, &app_handle, my_gen, None).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
