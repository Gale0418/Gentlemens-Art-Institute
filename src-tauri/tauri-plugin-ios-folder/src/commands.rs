use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;
use crate::TauriPluginIosFolderExt;

#[command]
pub(crate) async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<PickFolderResponse> {
    app.tauri_plugin_ios_folder().pick_folder()
}

#[command]
pub(crate) async fn start_accessing<R: Runtime>(
    app: AppHandle<R>,
    payload: StartAccessingRequest,
) -> Result<StartAccessingResponse> {
    app.tauri_plugin_ios_folder().start_accessing(payload)
}

#[command]
pub(crate) async fn stop_accessing<R: Runtime>(
    app: AppHandle<R>,
    payload: StopAccessingRequest,
) -> Result<()> {
    app.tauri_plugin_ios_folder().stop_accessing(payload)
}
