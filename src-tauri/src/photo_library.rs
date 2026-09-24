use crate::state::{AppState, ComicItem, Progress};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::AppHandle;

pub const PHOTO_ID_PREFIX: &str = "photos:";
const PHOTO_PROGRESS_FILE: &str = "photo-library-progress.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAlbumDescriptor {
    pub id: String,
    pub title: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAlbumSnapshot {
    pub id: String,
    pub title: String,
    pub available: bool,
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoLibraryStatusView {
    pub supported: bool,
    pub authorization: String,
    pub albums: Vec<PhotoAlbumDescriptor>,
    pub linked_album_ids: Vec<String>,
    pub allow_network: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoMutationResult {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoNetworkPolicy {
    pub allowed: bool,
}

pub fn photo_album_id(album_id: &str) -> String {
    format!(
        "{PHOTO_ID_PREFIX}{}",
        general_purpose::URL_SAFE_NO_PAD.encode(album_id.as_bytes())
    )
}

pub fn album_id_from_photo_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(PHOTO_ID_PREFIX)?;
    let bytes = general_purpose::URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let album_id = String::from_utf8(bytes).ok()?;
    (!album_id.trim().is_empty()).then_some(album_id)
}

pub fn is_photo_album_id(id: &str) -> bool {
    album_id_from_photo_id(id).is_some()
}

fn item_for_snapshot(snapshot: &PhotoAlbumSnapshot, progress: Option<&Progress>) -> ComicItem {
    ComicItem {
        id: photo_album_id(&snapshot.id),
        r#type: "photo-album".into(),
        // The album identifier is only consumed by Rust. It is never put in
        // a WebView URL; page URLs use the opaque virtual comic id and index.
        relative_path: photo_album_id(&snapshot.id),
        ext: ".jpg".into(),
        title: snapshot.title.clone(),
        series: "照片圖庫".into(),
        updated_at: String::new(),
        page_count: if snapshot.available {
            snapshot.asset_ids.len()
        } else {
            0
        },
        progress: progress.cloned().unwrap_or(Progress {
            current_page: 0,
            total_pages: 0,
            percent: 0.0,
            updated_at: None,
        }),
        source_id: "photos:".into(),
        source_path: None,
        external_bookmark: None,
    }
}

pub async fn items(state: &Arc<AppState>) -> Vec<ComicItem> {
    let snapshots = state.photo_albums.lock().await.clone();
    let progress = state.photo_progress.lock().await;
    snapshots
        .iter()
        .map(|snapshot| item_for_snapshot(snapshot, progress.get(&photo_album_id(&snapshot.id))))
        .collect()
}

pub async fn find_item(state: &Arc<AppState>, id: &str) -> Option<ComicItem> {
    items(state).await.into_iter().find(|item| item.id == id)
}

pub fn item_for_id(state: &AppState, id: &str) -> Option<ComicItem> {
    let album_id = album_id_from_photo_id(id)?;
    let snapshot = state
        .photo_albums
        .blocking_lock()
        .iter()
        .find(|snapshot| snapshot.id == album_id)
        .cloned()?;
    let progress = state.photo_progress.blocking_lock().get(id).cloned();
    Some(item_for_snapshot(&snapshot, progress.as_ref()))
}

pub fn load_progress(directory: &Path) -> Result<HashMap<String, Progress>, String> {
    let path = directory.join(PHOTO_PROGRESS_FILE);
    match std::fs::read_to_string(path) {
        Ok(content) => {
            serde_json::from_str(&content).map_err(|error| format!("照片進度格式無效：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(format!("無法讀取照片進度：{error}")),
    }
}

pub fn persist_progress(
    directory: &Path,
    progress: &HashMap<String, Progress>,
) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|error| format!("無法建立照片進度目錄：{error}"))?;
    let path = directory.join(PHOTO_PROGRESS_FILE);
    let temporary = directory.join(format!("{PHOTO_PROGRESS_FILE}.tmp-{}", std::process::id()));
    let bytes =
        serde_json::to_vec(progress).map_err(|error| format!("無法序列化照片進度：{error}"))?;
    std::fs::write(&temporary, bytes).map_err(|error| format!("無法寫入照片進度：{error}"))?;
    if let Err(error) = std::fs::rename(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("無法提交照片進度：{error}"));
    }
    Ok(())
}

/// Return the immutable order captured by `open_comic`. A stale snapshot is
/// deliberately rejected after unlink/revocation, even if the native cache
/// file still exists on disk.
pub fn page_asset(state: &AppState, comic_id: &str, index: usize) -> Option<(String, String)> {
    let album_id = album_id_from_photo_id(comic_id)?;
    let snapshot = state
        .photo_albums
        .blocking_lock()
        .iter()
        .find(|snapshot| snapshot.id == album_id && snapshot.available)?
        .clone();
    let asset_id = {
        let opened = state.opened_comic_files.read().ok()?;
        match opened.get(comic_id) {
            Some(pages) => pages.get(index)?.clone(),
            None => snapshot.asset_ids.get(index)?.clone(),
        }
    };
    snapshot
        .asset_ids
        .iter()
        .any(|id| id == &asset_id)
        .then_some((album_id, asset_id))
}

pub async fn refresh(app_handle: &AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let handle = app_handle.clone();
        let status = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            handle
                .tauri_plugin_ios_folder()
                .photo_library_status(tauri_plugin_ios_folder::PhotoLibraryStatusRequest {
                    request_authorization: false,
                })
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("照片圖庫狀態工作失敗：{error}"))??;

        let handle = app_handle.clone();
        let snapshots = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            handle
                .tauri_plugin_ios_folder()
                .linked_photo_album_snapshots()
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("照片相簿快照工作失敗：{error}"))??;

        *state
            .photo_authorization
            .write()
            .map_err(|_| "照片權限狀態鎖定失敗".to_string())? = snapshots.authorization.clone();
        *state
            .photo_linked_album_ids
            .write()
            .map_err(|_| "照片相簿連結狀態鎖定失敗".to_string())? = status.linked_album_ids;
        *state.photo_albums.lock().await = snapshots
            .albums
            .into_iter()
            .map(|album| PhotoAlbumSnapshot {
                id: album.id,
                title: album.title,
                available: album.available,
                asset_ids: album.asset_ids,
            })
            .collect();
        return Ok(());
    }

    let _ = app_handle;
    let _ = state;
    Ok(())
}

pub async fn mark_unavailable(state: &Arc<AppState>) {
    let mut albums = state.photo_albums.lock().await;
    for album in &mut *albums {
        album.available = false;
        album.title = "相簿目前不可用".into();
        album.asset_ids.clear();
    }
}

pub async fn status(
    app_handle: &AppHandle,
    state: &Arc<AppState>,
    request_authorization: bool,
) -> Result<PhotoLibraryStatusView, String> {
    #[cfg(target_os = "ios")]
    {
        let handle = app_handle.clone();
        let native = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            handle
                .tauri_plugin_ios_folder()
                .photo_library_status(tauri_plugin_ios_folder::PhotoLibraryStatusRequest {
                    request_authorization,
                })
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("照片圖庫狀態工作失敗：{error}"))??;
        *state
            .photo_authorization
            .write()
            .map_err(|_| "照片權限狀態鎖定失敗".to_string())? = native.authorization.clone();
        *state
            .photo_linked_album_ids
            .write()
            .map_err(|_| "照片相簿連結狀態鎖定失敗".to_string())? = native.linked_album_ids.clone();
        return Ok(PhotoLibraryStatusView {
            supported: true,
            authorization: native.authorization,
            albums: native
                .albums
                .into_iter()
                .map(|album| PhotoAlbumDescriptor {
                    id: album.id,
                    title: album.title,
                    count: album.count,
                })
                .collect(),
            linked_album_ids: native.linked_album_ids,
            allow_network: state
                .photo_network_allowed
                .load(std::sync::atomic::Ordering::Acquire),
        });
    }

    let _ = (app_handle, request_authorization);
    Ok(PhotoLibraryStatusView {
        supported: false,
        authorization: "unsupported".into(),
        albums: Vec::new(),
        linked_album_ids: Vec::new(),
        allow_network: state
            .photo_network_allowed
            .load(std::sync::atomic::Ordering::Acquire),
    })
}

pub async fn set_linked_albums(
    app_handle: &AppHandle,
    state: &Arc<AppState>,
    album_ids: Vec<String>,
) -> Result<PhotoMutationResult, String> {
    #[cfg(target_os = "ios")]
    {
        let handle = app_handle.clone();
        let linked = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
            handle
                .tauri_plugin_ios_folder()
                .set_linked_photo_albums(tauri_plugin_ios_folder::SetLinkedPhotoAlbumsRequest {
                    album_ids,
                })
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| format!("照片相簿連結工作失敗：{error}"))??;
        *state
            .photo_authorization
            .write()
            .map_err(|_| "照片權限狀態鎖定失敗".to_string())? = linked.authorization;
        *state
            .photo_linked_album_ids
            .write()
            .map_err(|_| "照片相簿連結狀態鎖定失敗".to_string())? = linked.linked_album_ids;
        if let Err(error) = refresh(app_handle, state).await {
            eprintln!("⚠️ 照片相簿連結後刷新失敗：{error}");
            mark_unavailable(state).await;
        }
        return Ok(PhotoMutationResult { success: true });
    }

    let _ = (app_handle, state, album_ids);
    Err("照片圖庫僅支援 iOS".into())
}

pub fn set_network_allowed(state: &AppState, allowed: bool) -> PhotoNetworkPolicy {
    state
        .photo_network_allowed
        .store(allowed, std::sync::atomic::Ordering::Release);
    PhotoNetworkPolicy { allowed }
}

pub fn native_image_error_status(error: &str) -> tauri::http::StatusCode {
    if error.contains("authorization") || error.contains("album") || error.contains("asset") {
        tauri::http::StatusCode::FORBIDDEN
    } else {
        tauri::http::StatusCode::SERVICE_UNAVAILABLE
    }
}

pub fn request_image(
    app_handle: &AppHandle,
    album_id: String,
    asset_id: String,
    thumbnail: bool,
    allow_network: bool,
) -> impl std::future::Future<Output = Result<(String, String), String>> + Send + 'static {
    let handle = app_handle.clone();
    async move {
        #[cfg(target_os = "ios")]
        {
            let response = tauri::async_runtime::spawn_blocking(move || {
                use tauri_plugin_ios_folder::TauriPluginIosFolderExt;
                handle
                    .tauri_plugin_ios_folder()
                    .photo_asset_image(tauri_plugin_ios_folder::PhotoAssetImageRequest {
                        album_id,
                        asset_id,
                        thumbnail,
                        allow_network,
                    })
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|error| format!("照片讀取工作失敗：{error}"))??;
            return Ok((response.path, response.mime_type));
        }

        let _ = (handle, album_id, asset_id, thumbnail, allow_network);
        Err("照片圖庫僅支援 iOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        album_id_from_photo_id, is_photo_album_id, load_progress, page_asset, persist_progress,
        photo_album_id, PhotoAlbumSnapshot,
    };
    use crate::state::AppState;

    #[test]
    fn photo_album_ids_are_opaque_and_stable() {
        let id = photo_album_id("A1B2/local-id");
        assert_eq!(id, photo_album_id("A1B2/local-id"));
        assert_eq!(
            album_id_from_photo_id(&id).as_deref(),
            Some("A1B2/local-id")
        );
        assert!(is_photo_album_id(&id));
        assert!(!is_photo_album_id("book-id"));
    }

    #[test]
    fn progress_sidecar_round_trips_without_touching_photo_files() {
        let directory = std::env::temp_dir().join(format!(
            "gai-photo-progress-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let id = photo_album_id("album");
        let progress = std::collections::HashMap::from([(
            id.clone(),
            crate::state::Progress {
                current_page: 2,
                total_pages: 4,
                percent: 75.0,
                updated_at: Some("2026-09-09T00:00:00Z".into()),
            },
        )]);
        persist_progress(&directory, &progress).unwrap();
        assert_eq!(load_progress(&directory).unwrap()[&id].current_page, 2);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unlink_or_invalid_index_cannot_read_frozen_photo_asset() {
        let state = AppState::new();
        let album_id = "album";
        let comic_id = photo_album_id(album_id);
        *state.photo_albums.blocking_lock() = vec![PhotoAlbumSnapshot {
            id: album_id.into(),
            title: "相簿".into(),
            available: true,
            asset_ids: vec!["new".into(), "old".into(), "added-after-open".into()],
        }];
        state
            .opened_comic_files
            .write()
            .unwrap()
            .insert(comic_id.clone(), vec!["old".into(), "new".into()]);
        assert_eq!(page_asset(&state, &comic_id, 0).unwrap().1, "old");
        assert!(page_asset(&state, &comic_id, 2).is_none());
        state.photo_albums.blocking_lock()[0].available = false;
        assert!(page_asset(&state, &comic_id, 0).is_none());
    }
}
