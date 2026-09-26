use crate::scanner::{merge_discovered_comics, LibraryBatch};
use crate::state::{AppState, ComicItem, Progress, SmbConfig};
use base64::{engine::general_purpose, Engine as _};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

const SMB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SMB_IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SMB_SCAN_DEPTH: usize = 32;
const UNKNOWN_SMB_TIME: &str = "1970-01-01T00:00:00+00:00";
const SMB_PROGRESS_BATCH: usize = 64;
const SMB_PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

fn smb_runtime_id(relative_path: &str) -> String {
    // Prefix the decoded capability path with "./" so an SMB item cannot
    // collide with a local item that has the same relative path. Existing
    // path consumers still resolve "./series/book.cbz" to the same temp file.
    general_purpose::URL_SAFE_NO_PAD.encode(format!("./{relative_path}").as_bytes())
}

fn legacy_runtime_id(relative_path: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(relative_path.as_bytes())
}

fn safe_smb_entry_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && !name.chars().any(char::is_control)
}

fn smb_scan_depth_exceeded(depth: usize) -> bool {
    depth > MAX_SMB_SCAN_DEPTH
}

fn should_publish_smb_progress(discovered: usize, published: usize, elapsed: Duration) -> bool {
    discovered > published
        && (published == 0
            || discovered.saturating_sub(published) >= SMB_PROGRESS_BATCH
            || elapsed >= SMB_PROGRESS_INTERVAL)
}

fn smb_filetime_rfc3339(file_time: smb2::pack::FileTime) -> String {
    file_time
        .to_system_time()
        .map(chrono::DateTime::<chrono::Utc>::from)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| UNKNOWN_SMB_TIME.to_string())
}

pub async fn scan_smb(
    config: SmbConfig,
    state: Arc<AppState>,
    scan_generation: u64,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    crate::commerce::require_pro(&app_handle).await?;
    let addr = format!("{}:445", config.host);
    let username = config.username.unwrap_or_else(|| "guest".to_string());
    let password = config.password.unwrap_or_default();
    let share = config.share;

    let scan_dir = state
        .scan_dir
        .read()
        .map_err(|_| "漫畫目錄鎖定失敗")?
        .clone();
    let progress_map: std::collections::HashMap<String, Progress> = if !scan_dir.is_empty() {
        let progress_file = Path::new(&scan_dir).join(".comic_progress.json");
        match tokio::task::spawn_blocking(move || {
            crate::scanner::load_progress_file(&progress_file)
        })
        .await
        {
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

    let mut client = tokio::time::timeout(
        SMB_CONNECT_TIMEOUT,
        smb2::connect(&addr, &username, &password),
    )
    .await
    .map_err(|_| "SMB 連線逾時（10 秒）".to_string())?
    .map_err(|error| format!("SMB 連線失敗：{error}"))?;

    let mut tree = tokio::time::timeout(SMB_CONNECT_TIMEOUT, client.connect_share(&share))
        .await
        .map_err(|_| "SMB 共用資料夾連線逾時（10 秒）".to_string())?
        .map_err(|error| format!("SMB 共用資料夾連線失敗：{error}"))?;

    let base_count = {
        let comics = state.comics.lock().await;
        comics
            .iter()
            .filter(|comic| comic.source_id != "smb")
            .count()
    };
    let mut new_comics = Vec::new();
    let mut directories = Vec::new();
    let mut published = 0usize;
    let mut published_at = Instant::now();
    scan_smb_dir(
        &mut client,
        &mut tree,
        "",
        &progress_map,
        &mut new_comics,
        &mut directories,
        scan_generation,
        &state,
        0,
        &app_handle,
        base_count,
        &mut published,
        &mut published_at,
        None,
    )
    .await?;

    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    let mut comics = state.comics.lock().await;
    if scan_generation
        != state
            .scan_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    let mut known_ids: std::collections::HashSet<String> =
        comics.iter().map(|comic| comic.id.clone()).collect();
    for comic in new_comics {
        if known_ids.insert(comic.id.clone()) {
            comics.push(comic);
        }
    }
    Ok(())
}

pub(crate) async fn scan_visible_smb(
    config: SmbConfig,
    state: Arc<AppState>,
    generation: u64,
    visible_generation: u64,
    app_handle: tauri::AppHandle,
    relative_path: String,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    if generation != state.scan_generation.load(Ordering::Acquire)
        || visible_generation != state.visible_scan_generation.load(Ordering::Acquire)
    {
        return Ok(());
    }
    if relative_path.starts_with('/')
        || (!relative_path.is_empty() && !relative_path.split('/').all(safe_smb_entry_name))
    {
        return Err("SMB 漫畫目錄路徑無效".to_string());
    }

    crate::commerce::require_pro(&app_handle).await?;

    let addr = format!("{}:445", config.host);
    let username = config.username.unwrap_or_else(|| "guest".to_string());
    let password = config.password.unwrap_or_default();
    let share = config.share;
    let mut client = tokio::time::timeout(
        SMB_CONNECT_TIMEOUT,
        smb2::connect(&addr, &username, &password),
    )
    .await
    .map_err(|_| "SMB 連線逾時（10 秒）".to_string())?
    .map_err(|error| format!("SMB 連線失敗：{error}"))?;
    let mut tree = tokio::time::timeout(SMB_CONNECT_TIMEOUT, client.connect_share(&share))
        .await
        .map_err(|_| "SMB 共用資料夾連線逾時（10 秒）".to_string())?
        .map_err(|error| format!("SMB 共用資料夾連線失敗：{error}"))?;
    if generation != state.scan_generation.load(Ordering::Acquire)
        || visible_generation != state.visible_scan_generation.load(Ordering::Acquire)
    {
        return Ok(());
    }

    let scan_dir = state
        .scan_dir
        .read()
        .map_err(|_| "漫畫目錄鎖定失敗")?
        .clone();
    let progress_map: std::collections::HashMap<String, Progress> = if !scan_dir.is_empty() {
        let progress_file = Path::new(&scan_dir).join(".comic_progress.json");
        match tokio::task::spawn_blocking(move || {
            crate::scanner::load_progress_file(&progress_file)
        })
        .await
        {
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

    let mut results = Vec::new();
    let mut directories = Vec::new();
    let mut published = 0usize;
    let mut published_at = Instant::now();
    scan_smb_dir(
        &mut client,
        &mut tree,
        &relative_path,
        &progress_map,
        &mut results,
        &mut directories,
        generation,
        &state,
        relative_path.split('/').count(),
        &app_handle,
        0,
        &mut published,
        &mut published_at,
        Some(visible_generation),
    )
    .await?;

    publish_smb_visible_progress(
        &state,
        &app_handle,
        generation,
        visible_generation,
        &results,
        results.len(),
        &mut published,
        &mut published_at,
        true,
    )
    .await;
    let _scan_lifecycle = state.scan_lifecycle.lock().await;
    if generation == state.scan_generation.load(Ordering::Acquire)
        && visible_generation == state.visible_scan_generation.load(Ordering::Acquire)
    {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "library-changed",
            LibraryBatch {
                generation,
                items: Vec::new(),
                found: 0,
                visible: true,
                visible_path: Some(relative_path),
                directories: Some(directories),
            },
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn scan_smb_dir(
    client: &mut smb2::SmbClient,
    tree: &mut smb2::Tree,
    dir_path: &str,
    progress_map: &std::collections::HashMap<String, Progress>,
    results: &mut Vec<ComicItem>,
    directories: &mut Vec<String>,
    scan_generation: u64,
    state: &Arc<AppState>,
    depth: usize,
    app_handle: &tauri::AppHandle,
    base_count: usize,
    published: &mut usize,
    published_at: &mut Instant,
    visible_generation: Option<u64>,
) -> Result<(), String> {
    if scan_generation
        != state
            .scan_generation
            .load(std::sync::atomic::Ordering::Acquire)
        || visible_generation.is_some_and(|generation| {
            generation
                != state
                    .visible_scan_generation
                    .load(std::sync::atomic::Ordering::Acquire)
        })
    {
        return Ok(());
    }
    if smb_scan_depth_exceeded(depth) {
        return Err(format!(
            "SMB 漫畫目錄超過 {MAX_SMB_SCAN_DEPTH} 層；為避免把未掃到的深層漫畫誤判刪除，本輪掃描已安全中止：{dir_path}"
        ));
    }

    let entries = tokio::time::timeout(SMB_IO_TIMEOUT, client.list_directory(tree, dir_path))
        .await
        .map_err(|_| format!("SMB 目錄讀取逾時（30 秒）：{dir_path}"))?
        .map_err(|error| format!("SMB 目錄讀取失敗：{error}"))?;

    for entry in entries {
        if scan_generation
            != state
                .scan_generation
                .load(std::sync::atomic::Ordering::Acquire)
            || visible_generation.is_some_and(|generation| {
                generation
                    != state
                        .visible_scan_generation
                        .load(std::sync::atomic::Ordering::Acquire)
            })
        {
            return Ok(());
        }

        let name = entry.name.clone();
        if !safe_smb_entry_name(&name) {
            continue;
        }

        let full_rel_path = if dir_path.is_empty() {
            name.clone()
        } else {
            format!("{dir_path}/{name}")
        };

        if entry.is_directory {
            if visible_generation.is_some() {
                directories.push(full_rel_path);
                continue;
            }
            Box::pin(scan_smb_dir(
                client,
                tree,
                &full_rel_path,
                progress_map,
                results,
                directories,
                scan_generation,
                state,
                depth + 1,
                app_handle,
                base_count,
                published,
                published_at,
                visible_generation,
            ))
            .await?;
            continue;
        }

        let ext = std::path::Path::new(&name)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext != "cbz" && ext != "zip" {
            continue;
        }

        let id = smb_runtime_id(&full_rel_path);
        let legacy_id = legacy_runtime_id(&full_rel_path);
        let title = std::path::Path::new(&name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&name)
            .to_string();
        let progress = progress_map
            .get(&id)
            .or_else(|| progress_map.get(&legacy_id))
            .cloned()
            .unwrap_or(Progress {
                current_page: 0,
                total_pages: 0,
                percent: 0.0,
                updated_at: None,
            });
        let series = if dir_path.is_empty() {
            "SMB Cloud".to_string()
        } else {
            format!("SMB: {dir_path}")
        };

        results.push(ComicItem {
            id,
            r#type: "smb-archive".to_string(),
            relative_path: full_rel_path.clone(),
            ext: format!(".{ext}"),
            title,
            series,
            updated_at: smb_filetime_rfc3339(entry.modified),
            page_count: 0,
            progress,
            source_id: "smb".to_string(),
            source_path: None,
            external_bookmark: None,
        });
        if let Some(visible_generation) = visible_generation {
            publish_smb_visible_progress(
                state,
                app_handle,
                scan_generation,
                visible_generation,
                results,
                results.len(),
                published,
                published_at,
                false,
            )
            .await;
        } else {
            publish_smb_progress(
                state,
                app_handle,
                scan_generation,
                base_count,
                results,
                results.len(),
                &full_rel_path,
                published,
                published_at,
            )
            .await;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn publish_smb_progress(
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    base_count: usize,
    results: &[ComicItem],
    discovered: usize,
    current_path: &str,
    published: &mut usize,
    published_at: &mut Instant,
) {
    if !should_publish_smb_progress(discovered, *published, published_at.elapsed()) {
        return;
    }
    let status = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        if state
            .scan_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
        {
            return;
        }
        let newly_discovered = results[*published..].to_vec();
        let mut comics = state.comics.lock().await;
        merge_discovered_comics(&mut comics, &newly_discovered);
        let mut progress = state.scan_progress.lock().await;
        progress.found = base_count.saturating_add(discovered);
        progress.current_path = format!("SMB: {current_path}");
        *published = discovered;
        *published_at = Instant::now();
        (
            progress.clone(),
            LibraryBatch {
                generation,
                items: newly_discovered,
                found: base_count.saturating_add(discovered),
                visible: false,
                visible_path: None,
                directories: None,
            },
        )
    };
    if state
        .scan_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != generation
    {
        return;
    }
    use tauri::Emitter;
    let (status, batch) = status;
    let _ = app_handle.emit("scan-progress", status);
    let _ = app_handle.emit("library-changed", batch);
}

#[allow(clippy::too_many_arguments)]
async fn publish_smb_visible_progress(
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
    visible_generation: u64,
    results: &[ComicItem],
    discovered: usize,
    published: &mut usize,
    published_at: &mut Instant,
    force: bool,
) {
    if !force && !should_publish_smb_progress(discovered, *published, published_at.elapsed()) {
        return;
    }
    let batch = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        if state
            .scan_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != generation
            || state
                .visible_scan_generation
                .load(std::sync::atomic::Ordering::Acquire)
                != visible_generation
        {
            return;
        }
        let newly_discovered = results[*published..].to_vec();
        if newly_discovered.is_empty() {
            return;
        }
        let mut comics = state.comics.lock().await;
        merge_discovered_comics(&mut comics, &newly_discovered);
        *published = discovered;
        *published_at = Instant::now();
        LibraryBatch {
            generation,
            items: newly_discovered,
            found: discovered,
            visible: true,
            visible_path: None,
            directories: None,
        }
    };
    if state
        .scan_generation
        .load(std::sync::atomic::Ordering::Acquire)
        != generation
        || state
            .visible_scan_generation
            .load(std::sync::atomic::Ordering::Acquire)
            != visible_generation
    {
        return;
    }
    use tauri::Emitter;
    let _ = app_handle.emit("library-changed", batch);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn smb_runtime_id_is_source_scoped_but_decodes_to_same_path() {
        let relative = "series/book.cbz";
        let smb_id = smb_runtime_id(relative);
        let local_id = legacy_runtime_id(relative);
        assert_ne!(smb_id, local_id);
        let decoded = general_purpose::URL_SAFE_NO_PAD.decode(smb_id).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "./series/book.cbz");
    }

    #[test]
    fn smb_names_reject_path_separators_and_controls() {
        assert!(safe_smb_entry_name("book.cbz"));
        assert!(!safe_smb_entry_name("../book.cbz"));
        assert!(!safe_smb_entry_name("a/b.cbz"));
        assert!(!safe_smb_entry_name("a\\b.cbz"));
        assert!(!safe_smb_entry_name("bad\nname.cbz"));
    }

    #[test]
    fn depth_limit_is_an_incomplete_scan_not_silent_success() {
        assert!(!smb_scan_depth_exceeded(MAX_SMB_SCAN_DEPTH));
        assert!(smb_scan_depth_exceeded(MAX_SMB_SCAN_DEPTH + 1));
    }

    #[test]
    fn smb_progress_is_batched_or_time_bounded() {
        assert!(should_publish_smb_progress(1, 0, Duration::ZERO));
        assert!(!should_publish_smb_progress(
            SMB_PROGRESS_BATCH,
            1,
            SMB_PROGRESS_INTERVAL - Duration::from_millis(1)
        ));
        assert!(should_publish_smb_progress(
            SMB_PROGRESS_BATCH + 1,
            1,
            Duration::ZERO
        ));
        assert!(should_publish_smb_progress(2, 1, SMB_PROGRESS_INTERVAL));
    }

    #[test]
    fn smb_modified_time_is_stable_and_not_scan_time() {
        let file_time =
            smb2::pack::FileTime::from_system_time(UNIX_EPOCH + Duration::from_secs(1_704_067_200));
        assert_eq!(smb_filetime_rfc3339(file_time), "2024-01-01T00:00:00+00:00");
        assert_eq!(
            smb_filetime_rfc3339(smb2::pack::FileTime::ZERO),
            UNKNOWN_SMB_TIME
        );
    }
}
