use crate::cache_policy::select_pages_for_budget;
use crate::state::AppState;
use base64::{engine::general_purpose, Engine as _};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager};

const MAX_PRELOAD_PAGE_BYTES: usize = 64 * 1024 * 1024;

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
    generation: u64,
) {
    let current_page = {
        let comics = state.comics.lock().await;
        comics
            .iter()
            .find(|comic| comic.id == id)
            .map(|comic| comic.progress.current_page)
            .unwrap_or(0)
    };
    preload_comic_window(state, app_handle, id, current_page, generation).await;
}

pub async fn preload_comic_window(
    state: Arc<AppState>,
    app_handle: tauri::AppHandle,
    id: String,
    current_page: usize,
    generation: u64,
) {
    let relative_path_bytes = match general_purpose::URL_SAFE_NO_PAD.decode(&id) {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let relative_path_str = match String::from_utf8(relative_path_bytes) {
        Ok(path) => path,
        Err(_) => return,
    };

    let comic_type = {
        let comics = state.comics.lock().await;
        comics
            .iter()
            .find(|comic| comic.id == id)
            .map(|comic| comic.r#type.clone())
    };
    if comic_type
        .as_deref()
        .is_some_and(|kind| kind.contains("image"))
    {
        let _ = app_handle.emit(
            "ram-cache-progress",
            serde_json::json!({
                "id": id, "generation": generation, "pageIndex": current_page,
                "loaded": 0, "total": 0, "finished": true
            }),
        );
        return;
    }
    let scan_dir = state.scan_dir.read().unwrap().clone();
    let smb_temp_dir = app_handle
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("ComicTemp");
    let full_path = resolve_preload_path(
        comic_type.as_deref(),
        Path::new(&scan_dir),
        &smb_temp_dir,
        &relative_path_str,
    );

    if !full_path.exists() || full_path.is_dir() {
        let _ = app_handle.emit(
            "ram-cache-progress",
            serde_json::json!({
                "id": id, "generation": generation, "pageIndex": current_page,
                "loaded": 0, "total": 0, "finished": true
            }),
        );
        return;
    }

    let completion_handle = app_handle.clone();
    let completion_state = state.clone();
    let completion_id = id.clone();
    let task =
        tokio::task::spawn_blocking(move || -> Result<Option<PreloadResult>, PreloadError> {
            let file = File::open(&full_path)
                .map_err(|error| PreloadError::new(format!("無法讀取預載 ZIP：{error}")))?;
            let mut archive = zip::ZipArchive::new(file)
                .map_err(|error| PreloadError::new(format!("預載 ZIP 格式無效：{error}")))?;
            let entry_names = {
                let opened = state.opened_comic_files.read().unwrap();
                opened.get(&id).cloned().unwrap_or_default()
            };

            let page_sizes = entry_names
                .iter()
                .map(|entry_name| {
                    archive
                        .by_name(entry_name)
                        .map(|entry| entry.size())
                        .map_err(|error| {
                            PreloadError::new(format!("預載找不到 ZIP 頁面 {entry_name}：{error}"))
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
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

            let (mut cached_bytes, mut loaded_count) = {
                let _lifecycle = state.comic_lifecycle.lock().unwrap();
                if state
                    .preload_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != generation
                {
                    return Ok(None);
                }
                let mut pool = state.ram_cache_pool.lock().unwrap();
                let book = pool.entry(id.clone()).or_default();
                book.retain(|page_index, _| selected_pages.contains(page_index));
                (book.values().map(Vec::len).sum(), book.len())
            };

            for page_index in selected_indices {
                let budget_bytes = state.refresh_cache_budget();
                if budget_bytes == 0 {
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
                let expected_size = usize::try_from(file.size()).unwrap_or(usize::MAX);
                let remaining = budget_bytes.saturating_sub(cached_bytes);
                let page_limit = remaining.min(MAX_PRELOAD_PAGE_BYTES);
                if expected_size > page_limit {
                    continue;
                }

                let mut buf = Vec::new();
                file.by_ref()
                    .take(page_limit.saturating_add(1) as u64)
                    .read_to_end(&mut buf)
                    .map_err(|error| {
                        PreloadError::with_progress(
                            format!("預載解壓 ZIP 頁面失敗：{error}"),
                            loaded_count,
                            preload_count,
                        )
                    })?;
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

                let id_clone = id.clone();
                {
                    let _lifecycle = state.comic_lifecycle.lock().unwrap();
                    if state
                        .preload_generation
                        .load(std::sync::atomic::Ordering::Acquire)
                        != generation
                    {
                        return Ok(None);
                    }
                    let mut pool = state.ram_cache_pool.lock().unwrap();
                    let book = pool.entry(id_clone.clone()).or_default();
                    if book.contains_key(&page_index) {
                        continue;
                    }
                    let current_bytes: usize = book.values().map(Vec::len).sum();
                    let live_budget = state.current_cache_budget_bytes();
                    if buf.len() > live_budget.saturating_sub(current_bytes) {
                        continue;
                    }
                    cached_bytes = current_bytes.saturating_add(buf.len());
                    book.insert(page_index, buf);
                }
                loaded_count += 1;
                let _ = app_handle.emit(
                    "ram-cache-progress",
                    serde_json::json!({
                        "id": id_clone,
                        "generation": generation,
                        "pageIndex": current_page,
                        "loaded": loaded_count,
                        "total": preload_count,
                        "budgetBytes": budget_bytes,
                        "cachedBytes": cached_bytes,
                        "wholeBook": can_cache_whole_book && loaded_count == entry_names.len(),
                        "finished": false
                    }),
                );
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
                    "id": completion_id, "generation": generation, "pageIndex": current_page,
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
                    "id": completion_id, "generation": generation, "pageIndex": current_page,
                    "loaded": error.loaded, "total": error.total, "finished": true,
                    "error": error.message
                }),
            );
        }
        Err(error) => {
            let _ = completion_handle.emit(
                "ram-cache-progress",
                serde_json::json!({
                    "id": completion_id, "generation": generation, "pageIndex": current_page,
                    "loaded": 0, "total": 0, "finished": true,
                    "error": format!("預載背景工作失敗：{error}")
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_preload_path, MAX_PRELOAD_PAGE_BYTES};
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
    }
}
