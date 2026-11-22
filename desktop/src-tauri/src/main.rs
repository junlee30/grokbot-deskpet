// Desk Pet, for Grok Bot (unofficial; not affiliated with xAI).
//
// Rust side: the main (pairing + settings) window and its position memory, one transparent
// window per bot (pet_windows.rs, pets.rs), the menu bar icon, in-place updates (updater.rs),
// the opener plugin and the v2 private-mailbox client (ntfy SSE + XChaCha20-Poly1305, pairing in the macOS
// Keychain). The webviews get status/state events; only the main window sees the pairing
// string, and only to show/copy the paste line.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod grokbot;
mod grokbot_art;
mod lock;
mod mailbox;
mod pet_windows;
mod pets;
mod secrets;
mod stream;
mod updater;
mod v2;
mod window_state;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use stream::StreamHandle;
use tauri::{AppHandle, Emitter, Manager, State};
use crate::lock::Locked;

/// The v2 mailbox subscription.
#[derive(Default)]
struct MailboxState(Mutex<Option<StreamHandle>>);

/// Shared HTTP client (connection pool, TLS via the OS).
struct Http(reqwest::Client);

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| "internal error".to_string())?
}

// ---------------------------------------------------------------- v2 (mailbox) commands

#[derive(Serialize)]
struct V2Status {
    paired: bool,
    /// Mailbox host (not secret), e.g. "ntfy.sh".
    mailbox: Option<String>,
}

fn host_of(base: &str) -> Option<String> {
    url::Url::parse(base).ok().and_then(|u| u.host_str().map(str::to_string))
}

/// Validate a mailbox base URL; returns its normalised form.
#[tauri::command]
fn v2_normalize_url(mailbox_url: String) -> Result<String, String> {
    v2::normalize_mailbox_url(&mailbox_url)
}

#[tauri::command]
async fn v2_status(window: tauri::WebviewWindow) -> Result<V2Status, String> {
    pet_windows::require_main(&window)?;
    let p = blocking(secrets::v2_get).await?;
    Ok(V2Status { paired: p.is_some(), mailbox: p.and_then(|p| host_of(&p.base)) })
}

fn start_mailbox(app: &AppHandle, http: &reqwest::Client, st: &MailboxState, p: v2::Pairing) {
    let a = app.clone();
    let sink: mailbox::Sink = Arc::new(move |o| match o {
        mailbox::Out::Status { status, detail } => {
            let s = mailbox::status_json(status, detail);
            pet_windows::set_status(&a, s.clone());
            let _ = a.emit("mailbox:status", s); // every window: pets dim when offline
        }
        mailbox::Out::State(v) => {
            // The main window only counts bots; each bot's own window draws it.
            let _ = a.emit_to("main", "mailbox:state", v.clone());
            pet_windows::on_state(&a, v);
        }
    });
    let mut slot = st.0.locked();
    if let Some(h) = slot.take() {
        h.stop();
    }
    *slot = Some(mailbox::start(http.clone(), p, sink));
}

/// New v2 pairing: fresh random topic + key, stored in the keychain (replacing any old one),
/// subscription started immediately. Returns the pairing string for the paste line.
#[tauri::command]
async fn v2_pair_new(
    window: tauri::WebviewWindow,
    app: AppHandle,
    http: State<'_, Http>,
    st: State<'_, MailboxState>,
    mailbox_url: String,
) -> Result<String, String> {
    pet_windows::require_main(&window)?;
    let p = v2::Pairing::generate(&mailbox_url)?;
    let p2 = p.clone();
    blocking(move || secrets::v2_set(&p2)).await?;
    start_mailbox(&app, &http.0, &st, p.clone());
    Ok(p.encode())
}

/// The current pairing string (to show the paste line again, e.g. for another bot computer).
#[tauri::command]
async fn v2_pairing_code(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    pet_windows::require_main(&window)?;
    Ok(blocking(secrets::v2_get).await?.map(|p| p.encode()))
}

/// Start (or restart) the subscription. Ok(false) if there is no v2 pairing.
#[tauri::command]
async fn v2_stream_start(window: tauri::WebviewWindow, app: AppHandle, http: State<'_, Http>, st: State<'_, MailboxState>) -> Result<bool, String> {
    pet_windows::require_main(&window)?;
    let Some(p) = blocking(secrets::v2_get).await? else {
        return Ok(false);
    };
    start_mailbox(&app, &http.0, &st, p);
    Ok(true)
}

#[tauri::command]
fn v2_stream_stop(window: tauri::WebviewWindow, st: State<'_, MailboxState>) -> Result<(), String> {
    pet_windows::require_main(&window)?;
    if let Some(h) = st.0.locked().take() {
        h.stop();
    }
    Ok(())
}

/// Unpair v2: stop and delete topic + key. Bots still holding the old code publish into a
/// topic nobody reads any more; a new code is a new topic and key.
#[tauri::command]
async fn v2_unpair(window: tauri::WebviewWindow, st: State<'_, MailboxState>) -> Result<(), String> {
    pet_windows::require_main(&window)?;
    if let Some(h) = st.0.locked().take() {
        h.stop();
    }
    blocking(secrets::v2_delete).await
}

#[tauri::command]
fn v2_reconnect_now(window: tauri::WebviewWindow, st: State<'_, MailboxState>) -> Result<(), String> {
    pet_windows::require_main(&window)?;
    if let Some(h) = st.0.locked().as_ref() {
        h.kick();
    }
    Ok(())
}

/// One line in `~/Library/Logs/<identifier>/deskpet.log` (and stderr). Never pass secrets here.
fn log_line(app: &AppHandle, msg: &str) {
    use std::io::Write;
    eprintln!("deskpet: {msg}");
    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("deskpet.log")) {
        let _ = writeln!(f, "{ts} {msg}");
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Http(stream::http_client()))
        .manage(MailboxState::default())
        .manage(pet_windows::PetWindows::default())
        .manage(grokbot_art::ArtState::default())
        .manage(updater::UpdateState::default())
        .on_menu_event(|app, ev| pet_windows::on_menu(app, ev.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            v2_normalize_url,
            v2_status,
            v2_pair_new,
            v2_pairing_code,
            v2_stream_start,
            v2_stream_stop,
            v2_unpair,
            v2_reconnect_now,
            pet_windows::pet_init,
            pet_windows::pets_set_size,
            pet_windows::pets_close_all,
            pet_windows::pets_reset_positions,
            pet_windows::pets_on_top,
            pet_windows::pets_set_on_top,
            pet_windows::open_settings_window,
            pet_windows::pet_menu,
            pet_windows::pet_attention,
            pet_windows::set_ui_strings,
            pet_windows::app_quit,
            grokbot::grokbot_installed,
            grokbot_art::grokbot_art_manifest,
            grokbot_art::grokbot_art_file,
            updater::update_check,
            updater::update_install,
        ])
        .setup(|app| {
            // A desk pet should not take a Dock slot or the app switcher on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            grokbot_art::init(app.handle());
            pet_windows::init(app.handle());
            if let Err(e) = pet_windows::tray(app.handle()) {
                log_line(app.handle(), &format!("menu bar icon unavailable: {e}"));
            }
            if let Some(w) = app.get_webview_window("main") {
                window_state::restore(&w);
                window_state::track(&w);
                let _ = w.show();
            }
            updater::start(app.handle());
            pet_windows::selftest(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Desk Pet");
}
