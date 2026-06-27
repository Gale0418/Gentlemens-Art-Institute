use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::TauriPluginIosFolder;
#[cfg(mobile)]
use mobile::TauriPluginIosFolder;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the tauri-plugin-ios-folder APIs.
pub trait TauriPluginIosFolderExt<R: Runtime> {
  fn tauri_plugin_ios_folder(&self) -> &TauriPluginIosFolder<R>;
}

impl<R: Runtime, T: Manager<R>> crate::TauriPluginIosFolderExt<R> for T {
  fn tauri_plugin_ios_folder(&self) -> &TauriPluginIosFolder<R> {
    self.state::<TauriPluginIosFolder<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("tauri-plugin-ios-folder")
    .invoke_handler(tauri::generate_handler![commands::ping])
    .setup(|app, api| {
      #[cfg(mobile)]
      let tauri_plugin_ios_folder = mobile::init(app, api)?;
      #[cfg(desktop)]
      let tauri_plugin_ios_folder = desktop::init(app, api)?;
      app.manage(tauri_plugin_ios_folder);
      Ok(())
    })
    .build()
}
