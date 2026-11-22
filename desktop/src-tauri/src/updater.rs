//! In-place updates (tauri-plugin-updater). Each release publishes `latest.json` on GitHub
//! (.github/workflows/release.yml), pointing at the app as a `.tar.gz` signed with the update
//! key; the public half is in tauri.conf.json (plugins.updater). An update whose signature
//! doesn't match is refused.
//!
//! - A quiet check soon after start-up and every few hours; when it finds a newer version the
//!   menu's Check for Updates… becomes "Update to X…" (pet_windows::set_update).
//! - The menu item opens Settings, which calls `update_check` and shows the answer;
//!   `update_install` downloads, verifies, replaces the app and relaunches it, reporting
//!   progress to the main window ("update:progress").

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::lock::Locked;
use crate::log_line;
use crate::pet_windows::{require_main, set_update};

const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct UpdateState {
    /// The newest update found, ready to install.
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

/// What Settings shows.
#[derive(Serialize)]
pub struct Found {
    version: String,
    current: String,
}

async fn check(app: &AppHandle) -> Result<Option<Found>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    let found = update.as_ref().map(|u| Found { version: u.version.clone(), current: u.current_version.clone() });
    set_update(app, found.as_ref().map(|f| f.version.clone()));
    *app.state::<UpdateState>().pending.locked() = update;
    let _ = app.emit_to("main", "update:found", &found); // Settings shows it if open
    Ok(found)
}

/// Quiet background checks (release builds only: a dev build isn't an installed app).
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            match check(&app).await {
                Ok(Some(f)) => log_line(&app, &format!("update available: {} (running {})", f.version, f.current)),
                Ok(None) => {}
                Err(e) => log_line(&app, &format!("update check failed: {e}")),
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Settings → Updates: is there a newer version? None when this one is the newest.
#[tauri::command]
pub async fn update_check(app: AppHandle, window: WebviewWindow) -> Result<Option<Found>, String> {
    require_main(&window)?;
    check(&app).await.inspect_err(|e| log_line(&app, &format!("update check failed: {e}")))
}

/// Download, verify and install the update found by the last check, then relaunch.
#[tauri::command]
pub async fn update_install(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    if cfg!(debug_assertions) {
        return Err("updates install only into a built app".into());
    }
    let st = app.state::<UpdateState>();
    if st.installing.swap(true, Ordering::SeqCst) {
        return Err("already installing".into());
    }
    let r = install(&app).await;
    st.installing.store(false, Ordering::SeqCst);
    if let Err(e) = &r {
        log_line(&app, &format!("update install failed: {e}"));
    }
    r?;
    log_line(&app, "update installed; relaunching");
    app.restart();
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let pending = app.state::<UpdateState>().pending.locked().clone();
    let update = match pending {
        Some(u) => u,
        None => {
            check(app).await?;
            app.state::<UpdateState>().pending.locked().clone().ok_or("no update available")?
        }
    };
    log_line(app, &format!("installing update {} (from {})", update.version, update.current_version));
    let (mut done, mut shown) = (0u64, u64::MAX);
    update
        .download_and_install(
            |chunk, total| {
                done += chunk as u64;
                // One event per percent (or per 256 KiB without a length), not per chunk.
                let step = total.map(|t| done * 100 / t.max(1)).unwrap_or(done >> 18);
                if step != shown {
                    shown = step;
                    let _ = app.emit_to("main", "update:progress", json!({"done": done, "total": total}));
                }
            },
            || {
                let _ = app.emit_to("main", "update:progress", json!({"installing": true}));
            },
        )
        .await
        .map_err(|e| e.to_string())
}
