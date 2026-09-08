use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<TauriPluginIosFolder<R>> {
    Ok(TauriPluginIosFolder(app.clone()))
}

/// Access to the tauri-plugin-ios-folder APIs.
pub struct TauriPluginIosFolder<R: Runtime>(AppHandle<R>);

impl<R: Runtime> TauriPluginIosFolder<R> {
    pub fn pick_folder(&self) -> crate::Result<PickFolderResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn start_accessing(
        &self,
        _payload: StartAccessingRequest,
    ) -> crate::Result<StartAccessingResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn stop_accessing(&self, _payload: StopAccessingRequest) -> crate::Result<()> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn ensure_available(
        &self,
        _payload: EnsureAvailableRequest,
    ) -> crate::Result<EnsureAvailableResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn photo_library_status(
        &self,
        _payload: PhotoLibraryStatusRequest,
    ) -> crate::Result<PhotoLibraryStatusResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn set_linked_photo_albums(
        &self,
        _payload: SetLinkedPhotoAlbumsRequest,
    ) -> crate::Result<SetLinkedPhotoAlbumsResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn linked_photo_album_snapshots(
        &self,
    ) -> crate::Result<LinkedPhotoAlbumSnapshotsResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }

    pub fn photo_asset_image(
        &self,
        _payload: PhotoAssetImageRequest,
    ) -> crate::Result<PhotoAssetImageResponse> {
        Err(crate::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Not supported on desktop",
        )))
    }
}
