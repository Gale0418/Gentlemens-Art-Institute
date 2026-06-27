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
  pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
    Ok(PingResponse {
      value: payload.value,
    })
  }
}
