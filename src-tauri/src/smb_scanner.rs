use crate::state::{AppState, ComicItem, Progress, SmbConfig};
use base64::{engine::general_purpose, Engine as _};
use std::sync::Arc;

pub async fn scan_smb(
    config: SmbConfig,
    state: Arc<AppState>,
    scan_generation: u64,
) -> Result<(), String> {
    let addr = format!("{}:445", config.host);
    let username = config.username.unwrap_or_else(|| "guest".to_string());
    let password = config.password.unwrap_or_default();
    let share = config.share;

    // BUG-07 修正：從本地 .comic_progress.json 讀取進度
    let scan_dir = {
        state
            .scan_dir
            .read()
            .map_err(|_| "Failed to acquire lock (Poisoned)")?
            .clone()
    };
    let progress_map: std::collections::HashMap<String, Progress> = if !scan_dir.is_empty() {
        let progress_file = std::path::Path::new(&scan_dir).join(".comic_progress.json");
        std::fs::read_to_string(&progress_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    };

    let mut client = smb2::connect(&addr, &username, &password)
        .await
        .map_err(|e| format!("SMB Connect Error: {}", e))?;

    let mut tree = client
        .connect_share(&share)
        .await
        .map_err(|e| format!("SMB Share Error: {}", e))?;

    let mut new_comics = Vec::new();

    // BUG-06 修正：遞迴掃描 SMB 子目錄
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

    // 更新到 State（已取消 early return，改用 gen 檢查）
    {
        let mut comics = state.comics.lock().await;
        if scan_generation
            != state
                .scan_generation
                .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Ok(());
        }
        for c in new_comics {
            if !comics.iter().any(|existing| existing.id == c.id) {
                comics.push(c);
            }
        }
    }

    Ok(())
}

// BUG-06 修正：遞迴掃描 SMB 子目錄（深度限制 5 層）
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
    if depth > 5 {
        return Ok(());
    }

    let entries = client
        .list_directory(tree, dir_path)
        .await
        .map_err(|e| e.to_string())?;

    for entry in entries {
        if scan_generation
            != state
                .scan_generation
                .load(std::sync::atomic::Ordering::Relaxed)
        {
            return Ok(());
        }

        let name = entry.name.clone();
        if name == "." || name == ".." || name.starts_with('.') {
            continue;
        }

        let full_rel_path = if dir_path.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", dir_path, name)
        };

        if entry.is_directory {
            // BUG-06 修正：遞迴進入子目錄
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
        } else {
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext == "cbz" || ext == "zip" {
                let id = general_purpose::URL_SAFE_NO_PAD.encode(full_rel_path.as_bytes());
                let title = std::path::Path::new(&name)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&name)
                    .to_string();

                // BUG-07 修正：從本地進度檔讀取此漫畫的進度
                let progress = progress_map.get(&id).cloned().unwrap_or(Progress {
                    current_page: 0,
                    total_pages: 0,
                    percent: 0.0,
                    updated_at: None,
                });

                // series 為目錄路徑，根目錄顯示 "SMB Cloud"
                let series = if dir_path.is_empty() {
                    "SMB Cloud".to_string()
                } else {
                    format!("SMB: {}", dir_path)
                };

                results.push(ComicItem {
                    id,
                    r#type: "smb-archive".to_string(),
                    relative_path: full_rel_path,
                    ext,
                    title,
                    series,
                    updated_at: chrono::Utc::now().to_rfc3339(),
                    page_count: 0,
                    progress,
                    source_id: "smb".to_string(),
                    source_path: None,
                    external_bookmark: None,
                });
            }
        }
    }

    Ok(())
}
