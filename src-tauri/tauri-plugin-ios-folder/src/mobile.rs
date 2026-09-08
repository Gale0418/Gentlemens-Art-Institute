use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_tauri_plugin_ios_folder);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<TauriPluginIosFolder<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("", "ExamplePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_tauri_plugin_ios_folder)?;
    Ok(TauriPluginIosFolder(handle))
}

/// Access to the tauri-plugin-ios-folder APIs.
pub struct TauriPluginIosFolder<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> TauriPluginIosFolder<R> {
    // 僅供 Rust 後端使用，不將任意 native method 暴露給 WebView。
    pub fn commerce(&self, method: &str) -> crate::Result<serde_json::Value> {
        self.0.run_mobile_plugin(method, ()).map_err(Into::into)
    }

    pub fn pick_folder(&self) -> crate::Result<PickFolderResponse> {
        self.0
            .run_mobile_plugin("pickFolder", ())
            .map_err(Into::into)
    }

    pub fn start_accessing(
        &self,
        payload: StartAccessingRequest,
    ) -> crate::Result<StartAccessingResponse> {
        self.0
            .run_mobile_plugin("startAccessing", payload)
            .map_err(Into::into)
    }

    pub fn stop_accessing(&self, payload: StopAccessingRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("stopAccessing", payload)
            .map_err(Into::into)
    }

    pub fn ensure_available(
        &self,
        payload: EnsureAvailableRequest,
    ) -> crate::Result<EnsureAvailableResponse> {
        self.0
            .run_mobile_plugin("ensureAvailable", payload)
            .map_err(Into::into)
    }

    pub fn photo_library_status(
        &self,
        payload: PhotoLibraryStatusRequest,
    ) -> crate::Result<PhotoLibraryStatusResponse> {
        self.0
            .run_mobile_plugin("photoLibraryStatus", payload)
            .map_err(Into::into)
    }

    pub fn set_linked_photo_albums(
        &self,
        payload: SetLinkedPhotoAlbumsRequest,
    ) -> crate::Result<SetLinkedPhotoAlbumsResponse> {
        self.0
            .run_mobile_plugin("setLinkedPhotoAlbums", payload)
            .map_err(Into::into)
    }

    pub fn linked_photo_album_snapshots(
        &self,
    ) -> crate::Result<LinkedPhotoAlbumSnapshotsResponse> {
        self.0
            .run_mobile_plugin("linkedPhotoAlbumSnapshots", ())
            .map_err(Into::into)
    }

    pub fn photo_asset_image(
        &self,
        payload: PhotoAssetImageRequest,
    ) -> crate::Result<PhotoAssetImageResponse> {
        self.0
            .run_mobile_plugin("photoAssetImage", payload)
            .map_err(Into::into)
    }
}
