// Desk Pet for Grok Bot (unofficial, working title).
//
// Rust side: the transparent always-on-top window, window-position memory, the opener plugin,
// the v2 mailbox client (ntfy SSE + XChaCha20-Poly1305, pairing in the Keychain; the default)
// and the deprecated v1 relay client (HTTP + SSE, token in the macOS Keychain; self-hosted
// relays only). The webview gets status/state
// events; it never sees the v1 token, and sees the v2 pairing string only to show/copy it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod mailbox;
mod relay;
mod secrets;
mod v2;
mod window_state;

use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use relay::{PairStartOut, RelayState, StreamHandle};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// The v2 mailbox subscription (independent of the v1 relay stream: both can run).
#[derive(Default)]
struct MailboxState(Mutex<Option<StreamHandle>>);

/// Shared HTTP client (connection pool, TLS via the OS).
struct Http(reqwest::Client);

fn parse(relay_url: &str) -> Result<url::Url, String> {
    relay::normalize_relay_url(relay_url)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| "internal error".to_string())?
}

/// Validate a relay URL; returns its normalised form (no trailing slash).
#[tauri::command]
fn relay_normalize_url(relay_url: String) -> Result<String, String> {
    Ok(parse(&relay_url)?.as_str().trim_end_matches('/').to_string())
}

#[tauri::command]
async fn relay_has_token(relay_url: String) -> Result<bool, String> {
    let u = parse(&relay_url)?;
    blocking(move || secrets::get(&u).map(|t| t.is_some())).await
}

/// One-time migration of an M0 token from webview localStorage into the keychain.
#[tauri::command]
async fn relay_import_token(relay_url: String, token: String) -> Result<(), String> {
    let u = parse(&relay_url)?;
    blocking(move || secrets::set(&u, &token)).await
}

/// New pairing: the token goes straight into the keychain; only the code is returned.
#[tauri::command]
async fn relay_pair_start(http: State<'_, Http>, relay_url: String) -> Result<PairStartOut, String> {
    let u = parse(&relay_url)?;
    relay::pair_start(&http.0, &u).await
}

/// Stop streaming, revoke the token at the relay (best effort) and forget it.
#[tauri::command]
async fn relay_unpair(http: State<'_, Http>, st: State<'_, RelayState>, relay_url: String) -> Result<(), String> {
    let u = parse(&relay_url)?;
    if let Some(h) = st.stream.lock().unwrap().take() {
        h.stop();
    }
    let u2 = u.clone();
    if let Some(token) = blocking(move || secrets::get(&u2)).await? {
        relay::revoke(&http.0, &u, &token).await;
    }
    blocking(move || secrets::delete(&u)).await
}

/// Forget the local token without calling the relay.
#[tauri::command]
async fn relay_forget(st: State<'_, RelayState>, relay_url: String) -> Result<(), String> {
    let u = parse(&relay_url)?;
    if let Some(h) = st.stream.lock().unwrap().take() {
        h.stop();
    }
    blocking(move || secrets::delete(&u)).await
}

/// (Re)start the SSE subscription for this relay. Ok(false) if there is no token.
#[tauri::command]
async fn relay_stream_start(
    app: AppHandle,
    http: State<'_, Http>,
    st: State<'_, RelayState>,
    relay_url: String,
) -> Result<bool, String> {
    let u = parse(&relay_url)?;
    let u2 = u.clone();
    let Some(token) = blocking(move || secrets::get(&u2)).await? else {
        return Ok(false);
    };
    let mut slot = st.stream.lock().unwrap();
    if let Some(h) = slot.take() {
        h.stop();
    }
    *slot = Some(relay::start_stream(app, http.0.clone(), u, token));
    Ok(true)
}

#[tauri::command]
fn relay_stream_stop(st: State<'_, RelayState>) {
    if let Some(h) = st.stream.lock().unwrap().take() {
        h.stop();
    }
}

/// Network came back / window became visible: reconnect now unless the stream is healthy.
#[tauri::command]
fn relay_reconnect_now(st: State<'_, RelayState>) {
    if let Some(h) = st.stream.lock().unwrap().as_ref() {
        h.kick();
    }
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
async fn v2_status() -> Result<V2Status, String> {
    let p = blocking(secrets::v2_get).await?;
    Ok(V2Status { paired: p.is_some(), mailbox: p.and_then(|p| host_of(&p.base)) })
}

fn start_mailbox(app: &AppHandle, http: &reqwest::Client, st: &MailboxState, p: v2::Pairing) {
    let a = app.clone();
    let sink: mailbox::Sink = Arc::new(move |o| match o {
        mailbox::Out::Status { status, detail } => {
            let _ = a.emit("mailbox:status", mailbox::status_json(status, detail));
        }
        mailbox::Out::State(v) => {
            let _ = a.emit("mailbox:state", v);
        }
    });
    let mut slot = st.0.lock().unwrap();
    if let Some(h) = slot.take() {
        h.stop();
    }
    *slot = Some(mailbox::start(http.clone(), p, sink));
}

/// New v2 pairing: fresh random topic + key, stored in the keychain (replacing any old one),
/// subscription started immediately. Returns the pairing string for the paste line.
#[tauri::command]
async fn v2_pair_new(
    app: AppHandle,
    http: State<'_, Http>,
    st: State<'_, MailboxState>,
    mailbox_url: String,
) -> Result<String, String> {
    let p = v2::Pairing::generate(&mailbox_url)?;
    let p2 = p.clone();
    blocking(move || secrets::v2_set(&p2)).await?;
    start_mailbox(&app, &http.0, &st, p.clone());
    Ok(p.encode())
}

/// The current pairing string (to show the paste line again, e.g. for another bot computer).
#[tauri::command]
async fn v2_pairing_code() -> Result<Option<String>, String> {
    Ok(blocking(secrets::v2_get).await?.map(|p| p.encode()))
}

/// Start (or restart) the subscription. Ok(false) if there is no v2 pairing.
#[tauri::command]
async fn v2_stream_start(app: AppHandle, http: State<'_, Http>, st: State<'_, MailboxState>) -> Result<bool, String> {
    let Some(p) = blocking(secrets::v2_get).await? else {
        return Ok(false);
    };
    start_mailbox(&app, &http.0, &st, p);
    Ok(true)
}

#[tauri::command]
fn v2_stream_stop(st: State<'_, MailboxState>) {
    if let Some(h) = st.0.lock().unwrap().take() {
        h.stop();
    }
}

/// Unpair v2: stop and delete topic + key. Bots still holding the old code publish into a
/// topic nobody reads any more; a new code is a new topic and key.
#[tauri::command]
async fn v2_unpair(st: State<'_, MailboxState>) -> Result<(), String> {
    if let Some(h) = st.0.lock().unwrap().take() {
        h.stop();
    }
    blocking(secrets::v2_delete).await
}

#[tauri::command]
fn v2_reconnect_now(st: State<'_, MailboxState>) {
    if let Some(h) = st.0.lock().unwrap().as_ref() {
        h.kick();
    }
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

/// v1 is deprecated and the hosted relay is gone: forget a token stored for it, so the app
/// stops trying to connect. Silent apart from one log line; the v2 pairing is not touched.
fn purge_retired_relay(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if secrets::purge_retired_relay_tokens() > 0 {
            log_line(&app, "removed the v1 token for the retired hosted relay (v1 is deprecated; v2 unaffected)");
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Http(relay::http_client()))
        .manage(RelayState::default())
        .manage(MailboxState::default())
        .invoke_handler(tauri::generate_handler![
            relay_normalize_url,
            relay_has_token,
            relay_import_token,
            relay_pair_start,
            relay_unpair,
            relay_forget,
            relay_stream_start,
            relay_stream_stop,
            relay_reconnect_now,
            v2_normalize_url,
            v2_status,
            v2_pair_new,
            v2_pairing_code,
            v2_stream_start,
            v2_stream_stop,
            v2_unpair,
            v2_reconnect_now,
        ])
        .setup(|app| {
            // A desk pet should not take a Dock slot or the app switcher on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            purge_retired_relay(app.handle());
            if let Some(w) = app.get_webview_window("main") {
                window_state::restore(&w);
                window_state::track(&w);
                let _ = w.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Desk Pet");
}
