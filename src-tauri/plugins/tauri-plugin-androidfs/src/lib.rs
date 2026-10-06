//! Local mobile plugin: Android Context APIs for MD Specpad.
//!
//! Tauri's `appDataDir()` only exposes the INTERNAL files dir, and pure-Rust JNI
//! can't reach the Android Context inside Tauri (`ndk-context` is unpopulated —
//! verified on-device). So the native work lives here, where the Kotlin plugin
//! class holds the Activity/Context. The app calls these APIs from Rust via the
//! [`AndroidfsExt`] trait; nothing is exposed to JS, so no permissions are needed.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Androidfs;
#[cfg(mobile)]
use mobile::Androidfs;

#[cfg(mobile)]
pub use mobile::{
    CapturedPhoto, ContentPayload, OcrLine, OcrLines, PickTreeResponse, SafEntry, SafList, SafRead,
    SafStat, SttResult,
};

/// Access the Android FS APIs from any [`tauri::Manager`] (App/AppHandle/Window).
pub trait AndroidfsExt<R: Runtime> {
    fn androidfs(&self) -> &Androidfs<R>;
}

impl<R: Runtime, T: Manager<R>> AndroidfsExt<R> for T {
    fn androidfs(&self) -> &Androidfs<R> {
        self.state::<Androidfs<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("androidfs")
        .setup(|app, api| {
            #[cfg(mobile)]
            let androidfs = mobile::init(app, api)?;
            #[cfg(desktop)]
            let androidfs = desktop::init(app, api)?;
            app.manage(androidfs);
            Ok(())
        })
        .build()
}
