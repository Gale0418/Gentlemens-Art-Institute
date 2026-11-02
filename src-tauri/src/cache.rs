use crate::cache_policy::select_pages_for_budget;
use crate::state::{AppState, SourceRevision};
use base64::{engine::general_purpose, Engine as _};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read};
#[cfg(test)]
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Manager};

const MAX_PRELOAD_PAGE_BYTES: usize = 64 * 1024 * 1024;
const PRELOAD_READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_PRELOAD_BATCH_PAGES: usize = 4;
const MAX_PRELOAD_BATCH_BYTES: usize = 8 * 1024 * 1024;
const PRELOAD_WORKER_LIMIT: usize = 1;

static PRELOAD_WORKER: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn preload_worker() -> &'static Arc<tokio::sync::Semaphore> {
    PRELOAD_WORKER.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(PRELOAD_WORKER_LIMIT)))
}

fn preload_batch_would_exceed(
    pending_pages: usize,
    pending_bytes: usize,
    next_page_bytes: usize,
) -> bool {
    pending_pages > 0
        && (pending_pages >= MAX_PRELOAD_BATCH_PAGES
            || pending_bytes.saturating_add(next_page_bytes) > MAX_PRELOAD_BATCH_BYTES)
}

/// Read one decompressed page in bounded chunks so a cancelled preload does
/// not remain inside one uninterruptible `read_to_end` call. The extra byte
/// is intentional: callers use it to preserve the existing oversize check.
fn read_preload_page<R, F>(
    reader: &mut R,
    page_limit: usize,
    mut is_current: F,
) -> io::Result<Option<Vec<u8>>>
where
    R: Read,
    F: FnMut() -> bool,
{
    let max_bytes = page_limit.saturating_add(1);
    let mut bytes = Vec::with_capacity(page_limit.min(PRELOAD_READ_CHUNK_BYTES));
    let mut chunk = vec![0u8; PRELOAD_READ_CHUNK_BYTES];

    while bytes.len() < max_bytes {
        if !is_current() {
            return Ok(None);
        }
        let read_len = (max_bytes - bytes.len()).min(chunk.len());
        let read = reader.read(&mut chunk[..read_len])?;
        if read == 0 {
            break;
        }
        if !is_current() {
            return Ok(None);
        }
        bytes.extend_from_slice(&chunk[..read]);
    }

    if !is_current() {
        return Ok(None);
    }
    Ok(Some(bytes))
}

/// Fast path for reader-window requests. The index and cache revisions are
/// checked under the lifecycle lock; protocol requests still validate the
/// live descriptor revision before serving any bytes.
pub fn whole_book_cache_matches_index(state: &AppState, id: &str, source_id: &str) -> bool {
    let Ok(_lifecycle) = state.comic_lifecycle.lock() else {
        return false;
    };
    if !state.active_reader_matches_locked(id, source_id) {
        return false;
    }
    let Some(total_pages) = state
        .opened_comic_files
        .read()
        .ok()
        .and_then(|opened| opened.get(id).map(Vec::len))
        .filter(|total| *total > 0)
    else {
        return false;
    };
    let Some(index_revision) = state
        .opened_comic_revisions
        .read()
        .ok()
        .and_then(|revisions| revisions.get(id).cloned())
    else {
        return false;
    };
    let Ok(pool) = state.ram_cache_pool.lock() else {
        return false;
    };
    let Some(cache_revision) = state
        .ram_cache_revisions
        .lock()
        .ok()
        .and_then(|revisions| revisions.get(id).cloned())
    else {
        return false;
    };
    cache_revision == index_revision
        && pool.get(id).is_some_and(|pages| {
            pages.len() == total_pages && pages.keys().all(|index| *index < total_pages)
        })
}

fn comic_source_revision(state: &AppState, comic: &crate::state::ComicItem) -> String {
    let scan_root = state.scan_dir.read().unwrap().clone();
    let bookmark_root = comic.external_bookmark.as_ref().and_then(|bookmark| {
        state
            .active_bookmarks
            .lock()
            .unwrap()
            .get(bookmark)
            .cloned()
    });
    serde_json::json!({
        "sourceId": comic.source_id,
        "relativePath": comic.relative_path,
        "sourcePath": comic.source_path,
        "externalBookmark": comic.external_bookmark,
        "scanRoot": scan_root,
        "bookmarkRoot": bookmark_root,
        "type": comic.r#type,
    })
    .to_string()
}

fn unique_preload_comic(
    comics: &[crate::state::ComicItem],
    id: &str,
    source_id: &str,
) -> Option<crate::state::ComicItem> {
    let matching = comics
        .iter()
        .filter(|comic| comic.id == id && comic.source_id == source_id)
        .collect::<Vec<_>>();
    let online_exists = matching.iter().any(|comic| comic.r#type != "offline");
    let mut matches = matching
        .into_iter()
        .filter(|comic| !online_exists || comic.r#type != "offline");
    let first = matches.next()?;
    let source_id = first.source_id.as_str();
    let relative_path = first.relative_path.as_str();
    if matches.any(|comic| comic.source_id != source_id || comic.relative_path != relative_path) {
        return None;
    }
    Some(first.clone())
}

fn source_revision_is_current(state: &AppState, id: &str, source_id: &str, expected: &str) -> bool {
    state
        .comics
        .try_lock()
        .ok()
        .and_then(|comics| {
            comics
                .iter()
                .find(|comic| comic.id == id && comic.source_id == source_id)
                .cloned()
        })
        .is_some_and(|comic| comic_source_revision(state, &comic) == expected)
}

#[derive(Debug)]
struct PreloadError {
    message: String,
    loaded: usize,
    total: usize,
}

#[derive(Debug)]
struct PreloadResult {
    loaded: usize,
    total: usize,
    budget_bytes: usize,
    cached_bytes: usize,
    whole_book: bool,
}

impl PreloadError {
    fn new(message: String) -> Self {
        Self {
            message,
            loaded: 0,
            total: 0,
        }
    }

    fn with_progress(message: String, loaded: usize, total: usize) -> Self {
        Self {
            message,
            loaded,
            total,
        }
    }
}

#[cfg(test)]
fn resolve_preload_path(
    comic_type: Option<&str>,
    scan_dir: &Path,
    smb_temp_dir: &Path,
    relative_path: &str,
) -> PathBuf {
    match comic_type {
        Some("smb-archive") => smb_temp_dir.join(relative_path),
        Some(kind) if kind.starts_with("external-") => PathBuf::from(relative_path),
        _ => scan_dir.join(relative_path),
    }
}

pub async fn preload_comic(
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
    id: String,
    source_id: String,
    generation: u64,
) {
    let (current_page, comic) = {
        let comics = state.comics.lock().await;
        let comic = unique_preload_comic(&comics, &id, &source_id);
        (
            comic
                .as_ref()
                .map(|item| item.progress.current_page)
                .unwrap_or(0),
            comic,
        )
    };
    preload_comic_window_with_item(
        state,
        app_handle,
        id,
        source_id,
        current_page,
        generation,
        comic,
    )
    .await;
}

pub async fn preload_comic_window(
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
    id: String,
    source_id: String,
    current_page: usize,
    generation: u64,
) {
    let comic = {
        let comics = state.comics.lock().await;
        unique_preload_comic(&comics, &id, &source_id)
    };
    preload_comic_window_with_item(
        state,
        app_handle,
        id,
        source_id,
        current_page,
        generation,
        comic,
    )
    .await;
}

async fn preload_comic_window_with_item(
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
    id: String,
    source_id: String,
    current_page: usize,
    generation: u64,
    comic: Option<crate::state::ComicItem>,
) {
    let relative_path_bytes = match general_purpose::URL_SAFE_NO_PAD.decode(&id) {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    if String::from_utf8(relative_path_bytes).is_err() {
        return;
    }

    let comic_type = comic.as_ref().map(|item| item.r#type.as_str());
    if comic_type.is_some_and(|kind| kind.contains("image")) {
        let _ = app_handle.emit(
            "ram-cache-progress",
            serde_json::json!({
                "id": id, "sourceId": source_id, "generation": generation, "pageIndex": current_page,
                "loaded": 0, "total": 0, "finished": true
            }),
        );
        return;
    }
    let smb_temp_dir = app_handle
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("ComicTemp");
    let Some(comic) = comic else {
        return;
    };
    let source_revision = comic_source_revision(&state, &comic);
    let (capability_root, capability_relative, full_path) = match crate::protocol::comic_capability(
        &comic,
        &state,
        Some(&smb_temp_dir),
    ) {
        Ok(value) => value,
        Err(_) => {
            let _ = app_handle.emit(
                    "ram-cache-progress",
                    serde_json::json!({
                        "id": id, "sourceId": source_id, "generation": generation, "pageIndex": current_page,
                        "loaded": 0, "total": 0, "finished": true
                    }),
                );
            return;
        }
    };

    if capability_root.is_dir(&capability_relative) {
        let _ = app_handle.emit(
            "ram-cache-progress",
            serde_json::json!({
                "id": id, "sourceId": source_id, "generation": generation, "pageIndex": current_page,
                "loaded": 0, "total": 0, "finished": true
            }),
        );
        return;
    }

    // RAR/7z readers are sequential. A ZIP-style random-access preload would
    // repeatedly decode solid blocks and stall reading, so page requests load
    // them on demand until they have a dedicated streaming preload worker.
    let extension = full_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if matches!(
        extension.to_ascii_lowercase().as_str(),
        "rar" | "cbr" | "7z" | "cb7"
    ) {
        let _ = app_handle.emit(
            "ram-cache-progress",
            serde_json::json!({
                "id": id, "sourceId": source_id, "generation": generation, "pageIndex": current_page,
                "loaded": 0, "total": 0, "finished": true
            }),
        );
        return;
    }

    let completion_handle = app_handle.clone();
    let completion_state = state.clone();
    let completion_id = id.clone();
    let completion_source_id = source_id.clone();
    let worker_permit = match preload_worker().clone().acquire_owned().await {
        Ok(permit) => permit,
        Err(_) => return,
    };
    // A request can wait behind a large, non-interruptible archive read. Do
    // not start stale work after the permit becomes available.
    if completion_state
        .preload_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != generation
    {
        return;
    }
    let task =
        tokio::task::spawn_blocking(move || -> Result<Option<PreloadResult>, PreloadError> {
            let _worker_permit = worker_permit;
            let file = capability_root
                .open(&capability_relative)
                .map_err(|error| PreloadError::new(format!("無法讀取預載 ZIP：{error}")))?;
            let source_file_revision =
                SourceRevision::from_cap_metadata(&file.metadata().map_err(|error| {
                    PreloadError::new(format!("無法讀取預載 ZIP metadata：{error}"))
                })?);
            let file = file.into_std();
            let mut archive = crate::utils::open_zip_archive_from_file(file)
                .map_err(|error| PreloadError::new(format!("預載 ZIP 格式無效：{error}")))?;
            let (entry_names, indexed_revision) =
                match state.opened_archive_snapshot(&id, &source_id) {
                    Some(snapshot) => snapshot,
                    None => return Ok(None),
                };
            if indexed_revision != source_file_revision {
                return Ok(None);
            }

            let page_sizes = {
                // Match by_name's last-entry-wins behavior for duplicate names.
                // Metadata lives in the already-read central directory, so
                // calculating the preload budget does not seek once per page.
                let sizes: HashMap<_, _> = archive.entry_metadata().collect();
                entry_names
                    .iter()
                    .map(|entry_name| {
                        sizes.get(entry_name.as_str()).copied().ok_or_else(|| {
                            PreloadError::new(format!("預載找不到 ZIP 頁面 {entry_name}"))
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?
            };
            let budget_bytes = state.refresh_cache_budget();
            let selection = select_pages_for_budget(&page_sizes, current_page, budget_bytes);
            let selected_indices = selection
                .indices
                .iter()
                .copied()
                .filter(|index| page_sizes[*index] <= MAX_PRELOAD_PAGE_BYTES as u64)
                .collect::<Vec<_>>();
            let selected_pages: HashSet<_> = selected_indices.iter().copied().collect();
            let preload_count = selected_indices.len();
            let can_cache_whole_book = selection.whole_book && preload_count == entry_names.len();

            let (mut cached_bytes, mut loaded_count): (usize, usize) = {
                let _lifecycle = state.comic_lifecycle.lock().unwrap();
                if state
                    .preload_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != generation
                    || !state.active_reader_matches_locked(&id, &source_id)
                    || !source_revision_is_current(&state, &id, &source_id, &source_revision)
                {
                    return Ok(None);
                }
                let mut pool = state.ram_cache_pool.lock().unwrap();
                let book = pool.entry(id.clone()).or_default();
                let mut revisions = state.ram_cache_revisions.lock().unwrap();
                if revisions.get(&id) != Some(&source_file_revision) {
                    book.clear();
                    revisions.insert(id.clone(), source_file_revision.clone());
                }
                book.retain(|page_index, _| selected_pages.contains(page_index));
                (book.values().map(Vec::len).sum(), book.len())
            };

            let mut pending_pages = Vec::new();
            let mut pending_bytes = 0usize;

            let commit_batch = |pending_pages: &mut Vec<(usize, Vec<u8>)>,
                                pending_bytes: &mut usize,
                                cached_bytes: &mut usize,
                                loaded_count: &mut usize|
             -> bool {
                if pending_pages.is_empty() {
                    return true;
                }
                // Validate once per small batch, before publishing any page.
                let live_revision = capability_root
                    .open(&capability_relative)
                    .and_then(|file| file.metadata())
                    .map(|metadata| SourceRevision::from_cap_metadata(&metadata));
                if live_revision.ok().as_ref() != Some(&source_file_revision) {
                    let _lifecycle = state.comic_lifecycle.lock().unwrap();
                    if state
                        .preload_generation
                        .load(std::sync::atomic::Ordering::Acquire)
                        == generation
                    {
                        state.ram_cache_pool.lock().unwrap().remove(&id);
                        state.ram_cache_revisions.lock().unwrap().remove(&id);
                    }
                    return false;
                }

                let id_clone = id.clone();
                let mut committed_count = 0usize;
                {
                    let _lifecycle = state.comic_lifecycle.lock().unwrap();
                    if state
                        .preload_generation
                        .load(std::sync::atomic::Ordering::Acquire)
                        != generation
                        || !state.active_reader_matches_locked(&id, &source_id)
                        || !source_revision_is_current(&state, &id, &source_id, &source_revision)
                    {
                        return false;
                    }
                    let mut pool = state.ram_cache_pool.lock().unwrap();
                    let mut revisions = state.ram_cache_revisions.lock().unwrap();
                    if revisions.get(&id) != Some(&source_file_revision) {
                        pool.remove(&id);
                        revisions.insert(id.clone(), source_file_revision.clone());
                    }
                    let book = pool.entry(id_clone.clone()).or_default();
                    let live_budget = state.current_cache_budget_bytes();
                    let mut current_bytes: usize = book.values().map(Vec::len).sum();
                    *cached_bytes = current_bytes;
                    for (page_index, buf) in pending_pages.drain(..) {
                        if book.contains_key(&page_index) {
                            continue;
                        }
                        if buf.len() > live_budget.saturating_sub(current_bytes) {
                            continue;
                        }
                        current_bytes = current_bytes.saturating_add(buf.len());
                        *cached_bytes = current_bytes;
                        book.insert(page_index, buf);
                        *loaded_count += 1;
                        committed_count += 1;
                    }
                }
                *pending_bytes = 0;
                if committed_count > 0 {
                    let _ = app_handle.emit(
                        "ram-cache-progress",
                        serde_json::json!({
                            "id": id_clone,
                            "sourceId": source_id,
                            "generation": generation,
                            "pageIndex": current_page,
                            "loaded": *loaded_count,
                            "total": preload_count,
                            "budgetBytes": state.current_cache_budget_bytes(),
                            "cachedBytes": *cached_bytes,
                            "wholeBook": can_cache_whole_book && *loaded_count == entry_names.len(),
                            "finished": false
                        }),
                    );
                }
                true
            };

            for page_index in selected_indices {
                let mut budget_bytes = state.refresh_cache_budget();
                if budget_bytes <= cached_bytes.saturating_add(pending_bytes) {
                    break;
                }
                let target_name = &entry_names[page_index];
                if state
                    .preload_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != generation
                {
                    return Ok(None);
                }
                let already_cached = {
                    let pool = state.ram_cache_pool.lock().unwrap();
                    pool.get(&id)
                        .is_some_and(|pages| pages.contains_key(&page_index))
                };
                if already_cached {
                    continue;
                }

                let mut file = archive.by_name(target_name).map_err(|error| {
                    PreloadError::with_progress(
                        format!("預載找不到 ZIP 頁面 {target_name}：{error}"),
                        loaded_count,
                        preload_count,
                    )
                })?;
                let mut expected_size = usize::try_from(file.size()).unwrap_or(usize::MAX);
                let batch_would_exceed =
                    preload_batch_would_exceed(pending_pages.len(), pending_bytes, expected_size);
                if batch_would_exceed {
                    drop(file);
                    if !commit_batch(
                        &mut pending_pages,
                        &mut pending_bytes,
                        &mut cached_bytes,
                        &mut loaded_count,
                    ) {
                        return Ok(None);
                    }
                    budget_bytes = state.refresh_cache_budget();
                    if budget_bytes <= cached_bytes {
                        break;
                    }
                    file = archive.by_name(target_name).map_err(|error| {
                        PreloadError::with_progress(
                            format!("預載找不到 ZIP 頁面 {target_name}：{error}"),
                            loaded_count,
                            preload_count,
                        )
                    })?;
                    expected_size = usize::try_from(file.size()).unwrap_or(usize::MAX);
                }
                let remaining =
                    budget_bytes.saturating_sub(cached_bytes.saturating_add(pending_bytes));
                let page_limit = remaining.min(MAX_PRELOAD_PAGE_BYTES);
                if expected_size > page_limit {
                    continue;
                }

                let Some(buf) = read_preload_page(&mut file, page_limit, || {
                    state
                        .preload_generation
                        .load(std::sync::atomic::Ordering::Acquire)
                        == generation
                })
                .map_err(|error| {
                    PreloadError::with_progress(
                        format!("預載解壓 ZIP 頁面失敗：{error}"),
                        loaded_count,
                        preload_count,
                    )
                })?
                else {
                    // Cancellation deliberately drops the partially read
                    // page before it can enter the pending batch.
                    return Ok(None);
                };
                if buf.len() > page_limit {
                    continue;
                }
                if state
                    .preload_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != generation
                {
                    return Ok(None);
                }
                pending_bytes = pending_bytes.saturating_add(buf.len());
                pending_pages.push((page_index, buf));
            }
            if !commit_batch(
                &mut pending_pages,
                &mut pending_bytes,
                &mut cached_bytes,
                &mut loaded_count,
            ) {
                return Ok(None);
            }

            Ok(Some(PreloadResult {
                loaded: loaded_count,
                total: preload_count,
                budget_bytes: state.current_cache_budget_bytes(),
                cached_bytes,
                whole_book: can_cache_whole_book && loaded_count == entry_names.len(),
            }))
        })
        .await;

    if completion_state
        .preload_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != generation
    {
        return;
    }
    match task {
        Ok(Ok(Some(result))) => {
            let _ = completion_handle.emit(
                "ram-cache-progress",
                serde_json::json!({
                    "id": completion_id, "sourceId": completion_source_id, "generation": generation, "pageIndex": current_page,
                    "loaded": result.loaded, "total": result.total,
                    "budgetBytes": result.budget_bytes, "cachedBytes": result.cached_bytes,
                    "wholeBook": result.whole_book, "finished": true
                }),
            );
        }
        Ok(Ok(None)) => {}
        Ok(Err(error)) => {
            let _ = completion_handle.emit(
                "ram-cache-progress",
                serde_json::json!({
                    "id": completion_id, "sourceId": completion_source_id, "generation": generation, "pageIndex": current_page,
                    "loaded": error.loaded, "total": error.total, "finished": true,
                    "error": error.message
                }),
            );
        }
        Err(error) => {
            let _ = completion_handle.emit(
                "ram-cache-progress",
                serde_json::json!({
                    "id": completion_id, "sourceId": completion_source_id, "generation": generation, "pageIndex": current_page,
                    "loaded": 0, "total": 0, "finished": true,
                    "error": format!("預載背景工作失敗：{error}")
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        preload_batch_would_exceed, read_preload_page, resolve_preload_path, unique_preload_comic,
        whole_book_cache_matches_index, MAX_PRELOAD_BATCH_BYTES, MAX_PRELOAD_BATCH_PAGES,
        MAX_PRELOAD_PAGE_BYTES, PRELOAD_READ_CHUNK_BYTES, PRELOAD_WORKER_LIMIT,
    };
    use crate::state::{AppState, SourceRevision};
    use std::collections::HashMap;
    use std::path::Path;

    #[test]
    fn preload_path_uses_smb_download_cache() {
        let resolved = resolve_preload_path(
            Some("smb-archive"),
            Path::new("/library"),
            Path::new("/app-data/ComicTemp"),
            "series/book.zip",
        );
        assert_eq!(resolved, Path::new("/app-data/ComicTemp/series/book.zip"));
    }

    #[test]
    fn preload_path_preserves_source_scoped_smb_relative_path() {
        let resolved = resolve_preload_path(
            Some("smb-archive"),
            Path::new("/library"),
            Path::new("/app-data/ComicTemp"),
            "./series/book.zip",
        );
        assert_eq!(resolved, Path::new("/app-data/ComicTemp/series/book.zip"));
    }

    #[test]
    fn preload_path_preserves_external_absolute_path() {
        let resolved = resolve_preload_path(
            Some("external-archive"),
            Path::new("/library"),
            Path::new("/app-data/ComicTemp"),
            "/external/book.zip",
        );
        assert_eq!(resolved, Path::new("/external/book.zip"));
    }

    #[test]
    fn preload_page_limit_matches_protocol_limit() {
        assert_eq!(MAX_PRELOAD_PAGE_BYTES, 64 * 1024 * 1024);
        assert_eq!(MAX_PRELOAD_BATCH_PAGES, 4);
        assert_eq!(MAX_PRELOAD_BATCH_BYTES, 8 * 1024 * 1024);
        assert_eq!(PRELOAD_WORKER_LIMIT, 1);
        assert!(preload_batch_would_exceed(
            1,
            7 * 1024 * 1024,
            60 * 1024 * 1024
        ));
        assert!(!preload_batch_would_exceed(0, 0, 60 * 1024 * 1024));
        assert!(preload_batch_would_exceed(4, 1, 1));
    }

    #[test]
    fn preload_page_reader_keeps_one_byte_overflow_check() {
        let page_limit = PRELOAD_READ_CHUNK_BYTES + 17;
        let mut reader = std::io::Cursor::new(vec![7u8; page_limit + 32]);
        let bytes = read_preload_page(&mut reader, page_limit, || true)
            .unwrap()
            .expect("active preload should return the bounded page");
        assert_eq!(bytes.len(), page_limit + 1);
    }

    #[test]
    fn preload_page_reader_discards_partial_page_when_generation_changes() {
        let mut reader = std::io::Cursor::new(vec![9u8; PRELOAD_READ_CHUNK_BYTES * 2]);
        let mut checks = 0usize;
        let result = read_preload_page(&mut reader, PRELOAD_READ_CHUNK_BYTES * 2, || {
            checks += 1;
            checks < 3
        })
        .unwrap();
        assert!(result.is_none());
        assert!(checks >= 3, "the read loop must check generation again");
    }

    #[test]
    fn preload_lookup_rejects_runtime_id_ambiguity() {
        let mut first = crate::state::ComicItem {
            id: "same".into(),
            r#type: "archive".into(),
            relative_path: "a.cbz".into(),
            ext: ".cbz".into(),
            title: "A".into(),
            series: String::new(),
            updated_at: String::new(),
            page_count: 1,
            progress: crate::state::Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            source_id: "local:a".into(),
            source_path: None,
            external_bookmark: None,
        };
        let mut second = first.clone();
        second.source_id = "local:b".into();
        assert_eq!(
            unique_preload_comic(&[first.clone(), second], "same", "local:a")
                .unwrap()
                .source_id,
            "local:a"
        );
        let mut different_path = first.clone();
        different_path.relative_path = "other.cbz".into();
        assert!(
            unique_preload_comic(&[first.clone(), different_path], "same", "local:a").is_none()
        );
        first.title = "duplicate same source".into();
        assert!(unique_preload_comic(&[first], "same", "local:a").is_some());
    }

    #[test]
    fn preload_lookup_prefers_online_over_retired_offline_location() {
        let offline = crate::state::ComicItem {
            id: "same".into(),
            r#type: "offline".into(),
            relative_path: "old.cbz".into(),
            ext: ".cbz".into(),
            title: "old".into(),
            series: String::new(),
            updated_at: String::new(),
            page_count: 1,
            progress: crate::state::Progress {
                current_page: 0,
                total_pages: 1,
                percent: 0.0,
                updated_at: None,
            },
            source_id: "local:old".into(),
            source_path: None,
            external_bookmark: None,
        };
        let mut online = offline.clone();
        online.r#type = "archive".into();
        online.source_id = "local:new".into();
        online.relative_path = "new.cbz".into();
        assert_eq!(
            unique_preload_comic(&[offline, online], "same", "local:new")
                .unwrap()
                .source_id,
            "local:new"
        );
    }

    #[test]
    fn whole_book_fast_path_requires_matching_index_revision() {
        let state = AppState::new();
        let revision = SourceRevision {
            len: 10,
            modified: None,
            ctime: None,
            file_id: Some((1, 2)),
        };
        state
            .opened_comic_files
            .write()
            .unwrap()
            .insert("book".into(), vec!["001.jpg".into(), "002.jpg".into()]);
        state
            .opened_comic_revisions
            .write()
            .unwrap()
            .insert("book".into(), revision.clone());
        state
            .ram_cache_pool
            .lock()
            .unwrap()
            .insert("book".into(), HashMap::from([(0, vec![1]), (1, vec![2])]));
        state
            .ram_cache_revisions
            .lock()
            .unwrap()
            .insert("book".into(), revision.clone());
        *state.active_comic_id.lock().unwrap() = Some("book".into());
        *state.active_comic_source_id.lock().unwrap() = Some("local:test".into());
        assert!(whole_book_cache_matches_index(&state, "book", "local:test"));

        state
            .ram_cache_pool
            .lock()
            .unwrap()
            .get_mut("book")
            .unwrap()
            .insert(9, vec![3]);
        assert!(!whole_book_cache_matches_index(
            &state,
            "book",
            "local:test"
        ));
        state
            .ram_cache_pool
            .lock()
            .unwrap()
            .get_mut("book")
            .unwrap()
            .remove(&9);

        state.ram_cache_revisions.lock().unwrap().insert(
            "book".into(),
            SourceRevision {
                ctime: None,
                file_id: Some((1, 3)),
                ..revision
            },
        );
        assert!(!whole_book_cache_matches_index(
            &state,
            "book",
            "local:test"
        ));
    }
}
