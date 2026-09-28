#[cfg(target_os = "macos")]
use objc2::rc::Retained;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime};

use crate::models::*;

const BOOKMARK_ALIASES_FILE: &str = "external-bookmark-aliases.json";

#[cfg(target_os = "macos")]
type ActiveUrl = Retained<objc2_foundation::NSURL>;
#[cfg(not(target_os = "macos"))]
type ActiveUrl = ();

fn native_error(code: &'static str) -> crate::Error {
    crate::Error::Io(std::io::Error::new(std::io::ErrorKind::Other, code))
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<TauriPluginIosFolder<R>> {
    Ok(TauriPluginIosFolder {
        app: app.clone(),
        active_accesses: Arc::new(Mutex::new(HashMap::new())),
    })
}

/// Access to the tauri-plugin-ios-folder APIs.
pub struct TauriPluginIosFolder<R: Runtime> {
    app: AppHandle<R>,
    // Keep the resolved NSURL until stop_accessing so the same security scope
    // object is used for the balanced start/stop calls.
    active_accesses: Arc<Mutex<HashMap<String, (String, ActiveUrl)>>>,
}

impl<R: Runtime> TauriPluginIosFolder<R> {
    fn run_on_main_thread<T: Send + 'static>(
        &self,
        task: impl FnOnce() -> crate::Result<T> + Send + 'static,
    ) -> crate::Result<T> {
        #[cfg(target_os = "macos")]
        if objc2::MainThreadMarker::new().is_some() {
            return task();
        }

        let (sender, receiver) = mpsc::sync_channel(1);
        self.app
            .run_on_main_thread(move || {
                let _ = sender.send(task());
            })
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        receiver
            .recv()
            .map_err(|error| std::io::Error::other(error.to_string()))?
    }

    fn aliases_path(&self) -> crate::Result<PathBuf> {
        self.app
            .path()
            .app_local_data_dir()
            .map(|path| path.join(BOOKMARK_ALIASES_FILE))
            .map_err(|error| std::io::Error::other(error.to_string()).into())
    }

    fn load_alias(&self, bookmark: &str) -> Option<String> {
        let path = self.aliases_path().ok()?;
        let aliases = std::fs::read_to_string(path).ok()?;
        let aliases = serde_json::from_str::<HashMap<String, String>>(&aliases).ok()?;
        aliases.get(bookmark).cloned()
    }

    fn save_alias(&self, bookmark: &str, alias: &str) {
        let Ok(path) = self.aliases_path() else {
            return;
        };
        let mut aliases = std::fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str::<HashMap<String, String>>(&data).ok())
            .unwrap_or_default();
        aliases.insert(bookmark.to_owned(), alias.to_owned());
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(
            path,
            serde_json::to_vec(&aliases).unwrap_or_else(|_| b"{}".to_vec()),
        );
    }

    fn remove_alias(&self, bookmark: &str) {
        let Ok(path) = self.aliases_path() else {
            return;
        };
        let Some(mut aliases) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str::<HashMap<String, String>>(&data).ok())
        else {
            return;
        };
        aliases.remove(bookmark);
        let _ = std::fs::write(
            path,
            serde_json::to_vec(&aliases).unwrap_or_else(|_| b"{}".to_vec()),
        );
    }

    pub fn pick_folder(&self) -> crate::Result<PickFolderResponse> {
        #[cfg(target_os = "macos")]
        {
            use base64::{engine::general_purpose, Engine as _};
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
            use objc2_foundation::NSURLBookmarkCreationOptions;

            return self.run_on_main_thread(move || {
                let mtm = MainThreadMarker::new()
                    .ok_or_else(|| native_error("FOLDER_MAIN_THREAD_UNAVAILABLE"))?;
                let panel = NSOpenPanel::openPanel(mtm);
                panel.setCanChooseFiles(false);
                panel.setCanChooseDirectories(true);
                panel.setAllowsMultipleSelection(false);
                if panel.runModal() != NSModalResponseOK {
                    return Err(native_error("FOLDER_PICKER_CANCELLED"));
                }
                let url = panel
                    .URLs()
                    .firstObject()
                    .ok_or_else(|| native_error("FOLDER_SELECTION_EMPTY"))?;
                if !unsafe { url.startAccessingSecurityScopedResource() } {
                    return Err(native_error("FOLDER_SECURITY_SCOPE_ACCESS_FAILED"));
                }
                let result = (|| {
                    let bookmark = url
                        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                            NSURLBookmarkCreationOptions::WithSecurityScope,
                            None,
                            None,
                        )
                        .map_err(|_| native_error("FOLDER_BOOKMARK_CREATE_FAILED"))?;
                    let encoded = general_purpose::STANDARD.encode(bookmark.to_vec());
                    let path = url
                        .path()
                        .ok_or_else(|| native_error("FOLDER_SELECTION_EMPTY"))?
                        .to_string();
                    let name = std::path::Path::new(&path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .filter(|name| !name.is_empty())
                        .unwrap_or(&path)
                        .to_owned();
                    Ok(PickFolderResponse {
                        bookmark: encoded,
                        name,
                    })
                })();
                unsafe { url.stopAccessingSecurityScopedResource() };
                result
            });
        }

        #[cfg(not(target_os = "macos"))]
        Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
    }

    pub fn start_accessing(
        &self,
        payload: StartAccessingRequest,
    ) -> crate::Result<StartAccessingResponse> {
        #[cfg(target_os = "macos")]
        {
            use base64::{engine::general_purpose, Engine as _};
            use objc2_foundation::{
                NSData, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions,
            };

            {
                let active = self
                    .active_accesses
                    .lock()
                    .map_err(|_| native_error("FOLDER_ACCESS_START_FAILED"))?;
                if let Some((path, _)) = active.get(&payload.bookmark) {
                    return Ok(StartAccessingResponse { path: path.clone() });
                }
            }

            let original = payload.bookmark.clone();
            let alias = self.load_alias(&original);
            let result = self.run_on_main_thread(move || {
                let candidates = [alias, Some(original.clone())]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>();
                let mut last_error = "FOLDER_BOOKMARK_ACCESS_FAILED";
                for candidate in candidates {
                    let Ok(bytes) = general_purpose::STANDARD.decode(&candidate) else {
                        last_error = "FOLDER_BOOKMARK_INVALID_BASE64";
                        continue;
                    };
                    let data = NSData::with_bytes(&bytes);
                    let mut stale = objc2::runtime::Bool::NO;
                    let url = match unsafe {
                        objc2_foundation::NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                            &data,
                            NSURLBookmarkResolutionOptions::WithSecurityScope
                                | NSURLBookmarkResolutionOptions::WithoutUI,
                            None,
                            std::ptr::addr_of_mut!(stale),
                        )
                    } {
                        Ok(url) => url,
                        Err(_) => {
                            last_error = "FOLDER_BOOKMARK_RESOLVE_FAILED";
                            continue;
                        }
                    };
                    if !unsafe { url.startAccessingSecurityScopedResource() } {
                        last_error = "FOLDER_BOOKMARK_ACCESS_FAILED";
                        continue;
                    }
                    let Some(path) = url.path().map(|path| path.to_string()) else {
                        unsafe { url.stopAccessingSecurityScopedResource() };
                        last_error = "FOLDER_BOOKMARK_RESOLVE_FAILED";
                        continue;
                    };
                    let refreshed = if stale.as_bool() {
                        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                            NSURLBookmarkCreationOptions::WithSecurityScope,
                            None,
                            None,
                        )
                        .ok()
                        .map(|data| general_purpose::STANDARD.encode(data.to_vec()))
                    } else {
                        None
                    };
                    return Ok((path, refreshed, url));
                }
                Err(native_error(last_error))
            })?;
            let (path, refreshed, url) = result;
            if let Some(refreshed) = refreshed {
                self.save_alias(&payload.bookmark, &refreshed);
            }
            let mut active = self
                .active_accesses
                .lock()
                .map_err(|_| native_error("FOLDER_ACCESS_START_FAILED"))?;
            if let Some((existing_path, _)) = active.get(&payload.bookmark) {
                let existing_path = existing_path.clone();
                drop(active);
                self.run_on_main_thread(move || {
                    unsafe { url.stopAccessingSecurityScopedResource() };
                    Ok(())
                })?;
                return Ok(StartAccessingResponse {
                    path: existing_path,
                });
            }
            active.insert(payload.bookmark, (path.clone(), url));
            Ok(StartAccessingResponse { path })
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = payload;
            Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
        }
    }

    pub fn stop_accessing(&self, payload: StopAccessingRequest) -> crate::Result<()> {
        #[cfg(target_os = "macos")]
        {
            let active_url = self
                .active_accesses
                .lock()
                .map_err(|_| native_error("FOLDER_ACCESS_STOP_FAILED"))?
                .remove(&payload.bookmark)
                .map(|(_, url)| url);
            if let Some(url) = active_url {
                self.run_on_main_thread(move || {
                    unsafe { url.stopAccessingSecurityScopedResource() };
                    Ok(())
                })?;
            }
            self.remove_alias(&payload.bookmark);
            Ok(())
        }

        #[cfg(not(target_os = "macos"))]
        {
            let _ = payload;
            Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
        }
    }

    pub fn ensure_available(
        &self,
        _payload: EnsureAvailableRequest,
    ) -> crate::Result<EnsureAvailableResponse> {
        Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
    }

    pub fn photo_library_status(
        &self,
        _payload: PhotoLibraryStatusRequest,
    ) -> crate::Result<PhotoLibraryStatusResponse> {
        Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
    }

    pub fn set_linked_photo_albums(
        &self,
        _payload: SetLinkedPhotoAlbumsRequest,
    ) -> crate::Result<SetLinkedPhotoAlbumsResponse> {
        Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
    }

    pub fn linked_photo_album_snapshots(&self) -> crate::Result<LinkedPhotoAlbumSnapshotsResponse> {
        Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
    }

    pub fn photo_asset_image(
        &self,
        _payload: PhotoAssetImageRequest,
    ) -> crate::Result<PhotoAssetImageResponse> {
        Err(native_error("IOS_FOLDER_DESKTOP_UNSUPPORTED"))
    }
}
