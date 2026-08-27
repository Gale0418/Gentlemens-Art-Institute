use crate::state::{AppState, ComicItem, Progress};
use base64::{engine::general_purpose, Engine as _};
use std::path::Path;
use std::sync::Arc;

pub const IMAGE_EXTENSIONS: [&str; 6] = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"];

fn local_source_id(root: &Path) -> String {
    format!(
        "local:{}",
        general_purpose::URL_SAFE_NO_PAD.encode(root.to_string_lossy().as_bytes())
    )
}

async fn schedule_catalog_sync(
    state: &Arc<AppState>,
    app_handle: &tauri::AppHandle,
    generation: u64,
) {
    let store = state
        .catalog
        .read()
        .ok()
        .and_then(|catalog| catalog.clone());
    let comics = state.comics.lock().await.clone();
    if let Some(store) = store {
        let handle = app_handle.clone();
        let state = state.clone();
        tokio::spawn(async move {
            let _catalog_sync = state.catalog_sync.lock().await;
            if state
                .scan_generation
                .load(std::sync::atomic::Ordering::Acquire)
                != generation
            {
                return;
            }
            match tokio::task::spawn_blocking(move || store.sync_library(&comics)).await {
                Ok(Ok(count)) => {
                    println!("🗂️ 漫畫目錄已同步 {count} 本");
                    use tauri::Emitter;
                    let _ = handle.emit("catalog-changed", count);
                }
                Ok(Err(error)) => eprintln!("⚠️ 漫畫目錄同步失敗：{error}"),
                Err(error) => eprintln!("⚠️ 漫畫目錄背景工作失敗：{error}"),
            }
        });
    }
}

pub async fn start_background_scan(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    // Serialize only scan generation/state coordination; filesystem scanning stays outside this lock.
    let (scan_dir, my_gen) = {
        let _scan_lifecycle = state.scan_lifecycle.lock().await;
        let scan_dir = { state.scan_dir.read().unwrap().clone() };
        if scan_dir.is_empty() || !Path::new(&scan_dir).exists() {
            return;
        }
        let my_gen = state
            .scan_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let mut progress = state.scan_progress.lock().await;
        progress.is_scanning = true;
        progress.found = 0;
        progress.current_path = scan_dir.clone();
        progress.started_at = Some(chrono::Utc::now().to_rfc3339());
        progress.completed_at = None;
        (scan_dir, my_gen)
    };

    println!("⏳ 掃描漫畫庫: {}", scan_dir);

    // 讀取進度檔
    let mut all_progress: std::collections::HashMap<String, Progress> =
        std::collections::HashMap::new();
    let progress_file = Path::new(&scan_dir).join(".comic_progress.json");
    if let Ok(content) = std::fs::read_to_string(&progress_file) {
        if let Ok(parsed) = serde_json::from_str(&content) {
            all_progress = parsed;
        }
    }
    let all_progress = Arc::new(all_progress);
    // TODO: 發送 Tauri 事件給前端通知掃描開始
    // app_handle.emit("scan-progress", ...);

    // 平行或遞迴掃描
    let _root_path = Path::new(&scan_dir);

    // 這裡我們用同步的 walkdir 來遍歷，雖然會稍微 block 但對於一般書庫還行
    // 更好的做法是丟進 tokio::task::spawn_blocking
    let scan_dir_clone = scan_dir.clone();
    let app_handle_clone = app_handle.clone();
    let state_clone_for_spawn = state.clone();

    let scanned_comics_task = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        #[allow(clippy::too_many_arguments, clippy::manual_flatten)]
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
        ) {
            if depth > 100 {
                return;
            }
            if state
                .scan_generation
                .load(std::sync::atomic::Ordering::Relaxed)
                != my_gen
            {
                return;
            }

            let entries = match std::fs::read_dir(dir) {
                Ok(e) => e,
                Err(_) => return,
            };

            let mut has_images = false;
            let mut subdirs = Vec::new();

            // Emit only while holding the short coordination section so a stale scan
            // cannot pass the generation check and emit after invalidation.
            {
                let _scan_lifecycle = state.scan_lifecycle.blocking_lock();
                if state
                    .scan_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != my_gen
                {
                    return;
                }
                use tauri::Emitter;
                let _ = app_handle.emit("scan-progress", dir.to_string_lossy().into_owned());
            }

            for entry_res in entries {
                if let Ok(entry) = entry_res {
                    let file_name = entry.file_name();
                    let name_str = file_name.to_string_lossy();

                    if name_str.starts_with('.')
                        || name_str == "__MACOSX"
                        || name_str == "node_modules"
                    {
                        continue;
                    }

                    let path = entry.path();
                    let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

                    if is_dir {
                        subdirs.push(path);
                    } else {
                        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                            let ext_lower = format!(".{}", ext.to_lowercase());
                            if crate::scanner::IMAGE_EXTENSIONS.contains(&ext_lower.as_str()) {
                                has_images = true;
                            } else if ext_lower == ".cbz" || ext_lower == ".zip" {
                                if let Some(rel_path) =
                                    path.strip_prefix(root_dir).ok().and_then(|p| p.to_str())
                                {
                                    let is_external = virtual_prefix.is_some();
                                    let actual_path_str = if is_external {
                                        path.to_string_lossy().to_string()
                                    } else {
                                        rel_path.to_string()
                                    };
                                    let id = general_purpose::URL_SAFE_NO_PAD
                                        .encode(actual_path_str.as_bytes());

                                    let virtual_path = if let Some(prefix) = virtual_prefix {
                                        if rel_path.is_empty() {
                                            format!("📁 外部裝置/{}", prefix)
                                        } else {
                                            format!("📁 外部裝置/{}/{}", prefix, rel_path)
                                        }
                                    } else {
                                        rel_path.to_string()
                                    };

                                    let title = path
                                        .file_stem()
                                        .and_then(|s| s.to_str())
                                        .unwrap_or("Unknown")
                                        .to_string();
                                    let series = path
                                        .parent()
                                        .and_then(|p| p.file_name())
                                        .and_then(|s| s.to_str())
                                        .unwrap_or("未分類")
                                        .to_string();
                                    let updated_at = std::fs::metadata(&path)
                                        .and_then(|m| m.modified())
                                        .map(|t| {
                                            chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()
                                        })
                                        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

                                    let saved_progress =
                                        all_progress.get(&id).cloned().unwrap_or(Progress {
                                            current_page: 0,
                                            total_pages: 0,
                                            percent: 0.0,
                                            updated_at: None,
                                        });

                                    let c_type = if is_external {
                                        "external-archive".to_string()
                                    } else {
                                        "archive".to_string()
                                    };
                                    results.push(ComicItem {
                                        id,
                                        r#type: c_type,
                                        relative_path: virtual_path,
                                        ext: ext_lower,
                                        title,
                                        series,
                                        updated_at,
                                        page_count: 0,
                                        progress: saved_progress,
                                        source_id: virtual_prefix
                                            .map(|prefix| format!("external:{prefix}"))
                                            .unwrap_or_else(|| local_source_id(root_dir)),
                                        source_path: Some(path.to_string_lossy().to_string()),
                                        external_bookmark: external_bookmark.map(str::to_owned),
                                    });
                                }
                            }
                        }
                    }
                }
            }

            if has_images {
                if let Some(rel_path) = dir.strip_prefix(root_dir).ok().and_then(|p| p.to_str()) {
                    let is_external = virtual_prefix.is_some();
                    let actual_path_str = if is_external {
                        dir.to_string_lossy().to_string()
                    } else {
                        rel_path.to_string()
                    };
                    // 如果是 is_external，即使 rel_path 是空字串（代表選到的就是包含圖片的根目錄），我們也要允許加入
                    if !rel_path.is_empty() || is_external {
                        let id =
                            general_purpose::URL_SAFE_NO_PAD.encode(actual_path_str.as_bytes());
                        let virtual_path = if let Some(prefix) = virtual_prefix {
                            if rel_path.is_empty() {
                                format!("📁 外部裝置/{}", prefix)
                            } else {
                                format!("📁 外部裝置/{}/{}", prefix, rel_path)
                            }
                        } else {
                            rel_path.to_string()
                        };

                        let title = dir
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("Unknown")
                            .to_string();
                        let series = dir
                            .parent()
                            .and_then(|p| p.file_name())
                            .and_then(|s| s.to_str())
                            .unwrap_or("未分類")
                            .to_string();
                        let updated_at = std::fs::metadata(dir)
                            .and_then(|m| m.modified())
                            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
                            .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

                        let saved_progress = all_progress.get(&id).cloned().unwrap_or(Progress {
                            current_page: 0,
                            total_pages: 0,
                            percent: 0.0,
                            updated_at: None,
                        });

                        let c_type = if is_external {
                            "external-folder".to_string()
                        } else {
                            "folder".to_string()
                        };
                        results.push(ComicItem {
                            id,
                            r#type: c_type,
                            relative_path: virtual_path,
                            ext: "".to_string(),
                            title,
                            series,
                            updated_at,
                            page_count: 0,
                            progress: saved_progress,
                            source_id: virtual_prefix
                                .map(|prefix| format!("external:{prefix}"))
                                .unwrap_or_else(|| local_source_id(root_dir)),
                            source_path: Some(dir.to_string_lossy().to_string()),
                            external_bookmark: external_bookmark.map(str::to_owned),
                        });
                    }
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
                );
            }
        }

        let root_path = Path::new(&scan_dir_clone);
        let state_clone2 = state_clone_for_spawn.clone();
        scan_recursive(
            root_path,
            root_path,
            0,
            &mut results,
            &app_handle_clone,
            &state_clone2,
            my_gen,
            &all_progress,
            None,
            None,
        );

        // Scan external bookmarks
        let external_bookmarks = { state_clone2.external_bookmarks.read().unwrap().clone() };
        #[allow(unused_variables)]
        for bookmark_entry in external_bookmarks {
            #[cfg(target_os = "ios")]
            {
                use tauri_plugin_ios_folder::StartAccessingRequest;
                use tauri_plugin_ios_folder::StopAccessingRequest;
                use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
                if state_clone2
                    .scan_generation
                    .load(std::sync::atomic::Ordering::Acquire)
                    != my_gen
                {
                    break;
                }
                if let Ok(res) = app_handle_clone.tauri_plugin_ios_folder().start_accessing(
                    StartAccessingRequest {
                        bookmark: bookmark_entry.bookmark.clone(),
                    },
                ) {
                    if state_clone2
                        .scan_generation
                        .load(std::sync::atomic::Ordering::Acquire)
                        != my_gen
                    {
                        let still_configured = state_clone2
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
                    {
                        let mut active = state_clone2.active_bookmarks.lock().unwrap();
                        active.insert(bookmark_entry.bookmark.clone(), res.path.clone());
                    }
                    scan_recursive(
                        resolved_path,
                        resolved_path,
                        0,
                        &mut results,
                        &app_handle_clone,
                        &state_clone2,
                        my_gen,
                        &all_progress,
                        Some(&bookmark_entry.name),
                        Some(&bookmark_entry.bookmark),
                    );
                }
            }
        }

        results
    })
    .await;

    match scanned_comics_task {
        Ok(comics) => {
            // Serialize the final generation check, library write, and completion decision.
            // The filesystem/SMB scan itself remains outside this short coordination lock.
            let scan_lifecycle = state.scan_lifecycle.lock().await;
            if state
                .scan_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != my_gen
            {
                return;
            }

            let mut state_comics = state.comics.lock().await;
            *state_comics = comics;
            let count = state_comics.len();
            drop(state_comics);
            drop(scan_lifecycle);
            schedule_catalog_sync(&state, &app_handle, my_gen).await;

            let smb_cfg = { state.smb_config.read().unwrap().clone() };
            if let Some(cfg) = smb_cfg {
                let state_clone3 = state.clone();
                let ah = app_handle.clone();
                tokio::spawn(async move {
                    println!("🌐 開始掃描 SMB NAS...");
                    if let Err(e) =
                        crate::smb_scanner::scan_smb(cfg, state_clone3.clone(), my_gen).await
                    {
                        eprintln!("❌ SMB 掃描錯誤: {}", e);
                        let scan_lifecycle = state_clone3.scan_lifecycle.lock().await;
                        if state_clone3
                            .scan_generation
                            .load(std::sync::atomic::Ordering::SeqCst)
                            != my_gen
                        {
                            return;
                        }
                        drop(scan_lifecycle);
                        let catalog = state_clone3
                            .catalog
                            .read()
                            .ok()
                            .and_then(|store| store.clone());
                        if let Some(catalog) = catalog {
                            let _catalog_sync = state_clone3.catalog_sync.lock().await;
                            match tokio::task::spawn_blocking(move || {
                                catalog.mark_source_offline("smb")
                            })
                            .await
                            {
                                Ok(Ok(changed)) => {
                                    println!("📴 NAS 離線，保留 {changed} 個目錄位置")
                                }
                                Ok(Err(error)) => eprintln!("⚠️ 無法更新 NAS 離線狀態：{error}"),
                                Err(error) => eprintln!("⚠️ NAS 離線背景工作失敗：{error}"),
                            }
                        }
                        let mut p = state_clone3.scan_progress.lock().await;
                        p.is_scanning = false;
                        p.completed_at = Some(chrono::Utc::now().to_rfc3339());
                        use tauri::Emitter;
                        let _ = ah.emit("library-changed", ());
                    } else {
                        let scan_lifecycle = state_clone3.scan_lifecycle.lock().await;
                        if state_clone3
                            .scan_generation
                            .load(std::sync::atomic::Ordering::SeqCst)
                            != my_gen
                        {
                            return;
                        }
                        let count = state_clone3.comics.lock().await.len();
                        drop(scan_lifecycle);
                        schedule_catalog_sync(&state_clone3, &ah, my_gen).await;
                        println!("✅ SMB 掃描完成，總共 {} 本漫畫", count);
                        let mut p = state_clone3.scan_progress.lock().await;
                        p.found = count;
                        p.is_scanning = false;
                        p.completed_at = Some(chrono::Utc::now().to_rfc3339());
                        use tauri::Emitter;
                        let _ = ah.emit("library-changed", ());
                    }
                });
            } else {
                // BUG-05 修正： 無 SMB 時也要設置 found 和 completed_at
                let mut progress = state.scan_progress.lock().await;
                progress.is_scanning = false;
                progress.found = count;
                progress.completed_at = Some(chrono::Utc::now().to_rfc3339());
                use tauri::Emitter;
                let _ = app_handle.emit("library-changed", ());
            }
        }
        Err(e) => {
            let _scan_lifecycle = state.scan_lifecycle.lock().await;
            if state
                .scan_generation
                .load(std::sync::atomic::Ordering::SeqCst)
                != my_gen
            {
                return;
            }
            let mut progress = state.scan_progress.lock().await;
            progress.is_scanning = false;
            eprintln!("❌ 掃描失敗: {:?}", e);
            use tauri::Emitter;
            let _ = app_handle.emit("library-changed", ());
        }
    }
}
