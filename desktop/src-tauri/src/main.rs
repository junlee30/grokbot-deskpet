// Desk Pet for Grok Bot (unofficial, working title).
//
// Rust side: the transparent always-on-top window, window-position memory, the opener plugin,
// and the relay client (HTTP + SSE) with the token kept in the macOS Keychain. The webview
// gets status/state events and never sees the token.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod relay;
mod secrets;
mod window_state;

use relay::{PairStartOut, RelayState};
use tauri::{AppHandle, Manager, State};

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Http(relay::http_client()))
        .manage(RelayState::default())
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
        ])
        .setup(|app| {
            // A desk pet should not take a Dock slot or the app switcher on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
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
