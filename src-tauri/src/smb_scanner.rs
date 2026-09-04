use crate::state::{AppState, ComicItem, Progress, SmbConfig};
use base64::{engine::general_purpose, Engine as _};
use std::sync::Arc;
use std::time::Duration;

const SMB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SMB_IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SMB_SCAN_DEPTH: usize = 32;
const UNKNOWN_SMB_TIME: &str = "1970-01-01T00:00:00+00:00";

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
) -> Result<(), String> {
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
        let progress_file = std::path::Path::new(&scan_dir).join(".comic_progress.json");
        std::fs::read_to_string(&progress_file)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
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

    let mut new_comics = Vec::new();
    scan_smb_dir(
        &mut client,
        &mut tree,
        "",
        &progress_map,
        &mut new_comics,
        scan_generation,
        &state,
        0,
    )
    .await?;

    let mut comics = state.comics.lock().await;
    if scan_generation
        != state
            .scan_generation
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(());
    }
    for comic in new_comics {
        if !comics.iter().any(|existing| existing.id == comic.id) {
            comics.push(comic);
        }
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
    scan_generation: u64,
    state: &Arc<AppState>,
    depth: usize,
) -> Result<(), String> {
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
            Box::pin(scan_smb_dir(
                client,
                tree,
                &full_rel_path,
                progress_map,
                results,
                scan_generation,
                state,
                depth + 1,
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
            relative_path: full_rel_path,
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
    }

    Ok(())
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
    fn smb_modified_time_is_stable_and_not_scan_time() {
        let file_time = smb2::pack::FileTime::from_system_time(
            UNIX_EPOCH + Duration::from_secs(1_704_067_200),
        );
        assert_eq!(smb_filetime_rfc3339(file_time), "2024-01-01T00:00:00+00:00");
        assert_eq!(
            smb_filetime_rfc3339(smb2::pack::FileTime::ZERO),
            UNKNOWN_SMB_TIME
        );
    }
}
