//! One transparent, always-on-top, frameless window per bot (agent_id): the Tauri glue.
//! The decisions (labels, routing, the position store, placement) are pure, in pets.rs.
//!
//! - The mailbox sink calls `on_state` for every decrypted event. The first event of an agent
//!   opens its window (`pet.html`); later ones are sent to that window only ("pet:state").
//!   Recent events are buffered per agent so a window that is still loading gets them from
//!   `pet_init`.
//! - Each window's position is saved (debounced) when it is moved, keyed by agent_id, in
//!   app config dir / pets.json, and restored (clamped onto a connected monitor) next time.
//! - Unpair / new code: `pets_close_all`. The menu (tray icon and right-click on a pet) has
//!   Settings…, Reset pet positions and Quit.
//!
//! Locking rule: never call a window method while holding the lock. Window methods can run
//! window-event handlers synchronously on the main thread, and those lock it too.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

use crate::log_line;
use crate::pets::{self, agent_of, label_for, place_new, reset_layout, resize_anchor, route_event, sane_size, Rect, Route, Store};

/// Events kept per agent for a window that is still loading (and for a reloaded one).
const BUFFER: usize = 32;
/// Default pet window size (logical px): Large pets. The UI sets the real one at boot.
const DEFAULT_SIZE: (i32, i32) = (184, 166);

pub struct Inner {
    store: Store,
    path: Option<PathBuf>,
    size: (i32, i32),
    /// Agents with a window (or one being created), in the order they appeared.
    open: Vec<String>,
    buffers: HashMap<String, VecDeque<Value>>,
    /// The last mailbox status, for windows that open later.
    status: Value,
    save_gen: u64,
    /// Agents already logged as over the window cap (logged once each).
    dropped: HashSet<String>,
}

pub struct PetWindows(Mutex<Inner>);

impl Default for PetWindows {
    fn default() -> Self {
        PetWindows(Mutex::new(Inner {
            store: Store::default(),
            path: None,
            size: DEFAULT_SIZE,
            open: Vec::new(),
            buffers: HashMap::new(),
            status: json!({"status": "connecting"}),
            save_gen: 0,
            dropped: HashSet::new(),
        }))
    }
}

fn state(app: &AppHandle) -> &PetWindows {
    app.state::<PetWindows>().inner()
}

/// Load the position store. (Debug builds in self-test mode use a separate file.)
pub fn init(app: &AppHandle) {
    let name = if selftest_agents().is_some() { "pets-selftest.json" } else { "pets.json" };
    let path = app.path().app_config_dir().ok().map(|d| d.join(name));
    let store = path.as_ref().and_then(|p| std::fs::read(p).ok()).map(|b| Store::from_json(&b)).unwrap_or_default();
    let mut g = state(app).0.lock().unwrap();
    g.store = store;
    g.path = path;
}

fn write_store(path: Option<PathBuf>, bytes: Vec<u8>) {
    let Some(path) = path else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn save_now(app: &AppHandle) {
    let (path, bytes) = {
        let g = state(app).0.lock().unwrap();
        (g.path.clone(), g.store.to_json())
    };
    write_store(path, bytes);
}

/// Write the store 400 ms after the last change (a drag moves the window many times).
fn schedule_save(app: &AppHandle) {
    let gen = {
        let mut g = state(app).0.lock().unwrap();
        g.save_gen += 1;
        g.save_gen
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if state(&app).0.lock().unwrap().save_gen == gen {
            save_now(&app);
        }
    });
}

/// Connected monitors in logical points, primary first: (full bounds, work areas).
fn monitors(app: &AppHandle) -> (Vec<Rect>, Vec<Rect>) {
    let mut all = app.available_monitors().unwrap_or_default();
    if let Some(p) = app.primary_monitor().ok().flatten() {
        if let Some(i) = all.iter().position(|m| m.position() == p.position() && m.size() == p.size()) {
            let m = all.remove(i);
            all.insert(0, m);
        }
    }
    let l = |v: i64, sf: f64| (v as f64 / sf).round() as i32;
    let bounds = all
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            Rect::new(l(m.position().x as i64, sf), l(m.position().y as i64, sf), l(m.size().width as i64, sf), l(m.size().height as i64, sf))
        })
        .collect();
    let work = all
        .iter()
        .map(|m| {
            let (sf, wa) = (m.scale_factor(), m.work_area());
            Rect::new(l(wa.position.x as i64, sf), l(wa.position.y as i64, sf), l(wa.size.width as i64, sf), l(wa.size.height as i64, sf))
        })
        .collect();
    (bounds, work)
}

/// For commands only the main (pairing + settings) window may use: pet windows show
/// bot-supplied text.
pub fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("not allowed from this window".into())
    }
}

// ---------------------------------------------------------------- events

/// Mailbox status (online/offline/connecting): kept for windows that open later. The event
/// itself is broadcast to every window by the caller.
pub fn set_status(app: &AppHandle, status: Value) {
    state(app).0.lock().unwrap().status = status;
}

/// A decrypted, validated state event: open the agent's window or send it there.
pub fn on_state(app: &AppHandle, v: Value) {
    let Some(agent) = v.get("agent_id").and_then(Value::as_str).map(str::to_owned) else { return };
    let route = {
        let mut g = state(app).0.lock().unwrap();
        let r = route_event(&g.open, &agent, pets::MAX_PET_WINDOWS);
        match r {
            Route::Ignore => {
                if pets::agent_id_ok(&agent) && g.dropped.insert(agent.clone()) {
                    drop(g);
                    log_line(app, &format!("pet windows: {} open (the maximum); not opening one for agent={agent}", pets::MAX_PET_WINDOWS));
                }
                return;
            }
            Route::Create => g.open.push(agent.clone()),
            Route::Deliver => {}
        }
        let buf = g.buffers.entry(agent.clone()).or_default();
        if buf.len() >= BUFFER {
            buf.pop_front();
        }
        buf.push_back(v.clone());
        r
    };
    match route {
        Route::Create => create(app, &agent),
        Route::Deliver => {
            if let Some(label) = label_for(&agent) {
                let _ = app.emit_to(label.as_str(), "pet:state", v);
            }
        }
        Route::Ignore => {}
    }
}

fn create(app: &AppHandle, agent: &str) {
    let Some(label) = label_for(agent) else { return };
    let (bounds, work) = monitors(app);
    let (pos, size) = {
        let mut g = state(app).0.lock().unwrap();
        let size = g.size;
        let pos = place_new(g.store.get(agent), size, &bounds, &work, &g.store.others(agent, size));
        g.store.set(agent, pos);
        (pos, size)
    };
    schedule_save(app);
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("pet.html".into()))
        .title(format!("Desk Pet: {agent}"))
        .inner_size(size.0 as f64, size.1 as f64)
        .position(pos.0 as f64, pos.1 as f64)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        // Never take keyboard focus from the app you are working in.
        .focused(false)
        .focusable(false)
        .visible(true)
        .build();
    match built {
        Ok(w) => {
            track(&w, agent.to_string());
            let n = state(app).0.lock().unwrap().open.len();
            log_line(app, &format!("pet window opened: agent={agent} at ({},{}) {}x{} (open: {n})", pos.0, pos.1, size.0, size.1));
        }
        Err(e) => {
            {
                let mut g = state(app).0.lock().unwrap();
                g.open.retain(|a| a != agent);
                g.buffers.remove(agent);
            }
            log_line(app, &format!("pet window for agent={agent} failed to open: {e}"));
        }
    }
}

/// Remember where the user drags the window; forget the window when it is gone.
fn track(w: &WebviewWindow, agent: String) {
    let app = w.app_handle().clone();
    let label = w.label().to_string();
    w.on_window_event(move |ev| match ev {
        WindowEvent::Moved(p) => {
            let sf = app.get_webview_window(&label).and_then(|w| w.scale_factor().ok()).unwrap_or(1.0);
            let pos = ((p.x as f64 / sf).round() as i32, (p.y as f64 / sf).round() as i32);
            state(&app).0.lock().unwrap().store.set(&agent, pos);
            schedule_save(&app);
        }
        WindowEvent::Destroyed => {
            {
                let mut g = state(&app).0.lock().unwrap();
                g.open.retain(|a| a != &agent);
                g.buffers.remove(&agent);
            }
            save_now(&app);
        }
        _ => {}
    });
}

/// Close every pet window (unpair, new code). Saved positions stay.
pub fn close_all(app: &AppHandle) {
    let agents: Vec<String> = {
        let mut g = state(app).0.lock().unwrap();
        g.buffers.clear();
        g.dropped.clear();
        g.open.drain(..).collect()
    };
    for a in &agents {
        if let Some(w) = label_for(a).and_then(|l| app.get_webview_window(&l)) {
            let _ = w.destroy();
        }
    }
    save_now(app);
    if !agents.is_empty() {
        log_line(app, &format!("pet windows closed: {}", agents.len()));
    }
}

/// Forget every saved position and line the open pets up along the bottom-right again.
pub fn reset_positions(app: &AppHandle) {
    let (agents, size) = {
        let mut g = state(app).0.lock().unwrap();
        g.store.clear();
        (g.open.clone(), g.size)
    };
    let (_, work) = monitors(app);
    for (agent, pos) in reset_layout(&agents, size, &work) {
        if let Some(w) = label_for(&agent).and_then(|l| app.get_webview_window(&l)) {
            let _ = w.set_position(LogicalPosition::new(pos.0, pos.1));
        }
        state(app).0.lock().unwrap().store.set(&agent, pos);
    }
    save_now(app);
    log_line(app, &format!("pet positions reset ({} open)", agents.len()));
}

/// Show the main window with the settings card.
pub fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("main", "ui:open-settings", ());
    }
}

// ---------------------------------------------------------------- menu + tray

/// The menu bar / right-click menu, in macOS order: settings first, app-wide actions after it,
/// Quit last in its own group. Title case; an ellipsis only where a window opens.
pub const MENU_ITEMS: [(&str, &str); 3] = [("settings", "Settings…"), ("reset-positions", "Reset Pet Positions"), ("quit", "Quit Desk Pet")];

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |i: usize| MenuItem::with_id(app, MENU_ITEMS[i].0, MENU_ITEMS[i].1, true, None::<&str>);
    Menu::with_items(app, &[&item(0)?, &item(1)?, &PredefinedMenuItem::separator(app)?, &item(2)?])
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "settings" => open_settings(app),
        "reset-positions" => reset_positions(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// The menu bar icon: a black + alpha template image (icons-src/tray-template.svg, 36 px drawn at
/// 18 pt), so macOS tints it for light, dark and highlighted menu bars.
const TRAY_TEMPLATE: &[u8] = include_bytes!("../icons/tray-template@2x.png");

/// Menu bar icon: the way back to settings when every window is a pet.
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let mut b = TrayIconBuilder::with_id("deskpet").tooltip("Desk Pet").menu(&menu(app)?).show_menu_on_left_click(true);
    match tauri::image::Image::from_bytes(TRAY_TEMPLATE) {
        Ok(icon) => b = b.icon(icon).icon_as_template(true),
        Err(e) => {
            log_line(app, &format!("menu bar template icon unreadable ({e}); using the app icon"));
            if let Some(icon) = app.default_window_icon() {
                b = b.icon(icon.clone());
            }
        }
    }
    b.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- commands

/// A pet window starting up: which agent it is, the events so far, the mailbox status.
#[tauri::command]
pub fn pet_init(window: WebviewWindow, st: State<'_, PetWindows>) -> Result<Value, String> {
    let agent = agent_of(window.label()).ok_or("not a pet window")?.to_string();
    let g = st.0.lock().unwrap();
    let events: Vec<Value> = g.buffers.get(&agent).map(|b| b.iter().cloned().collect()).unwrap_or_default();
    Ok(json!({"agent_id": agent, "events": events, "status": g.status}))
}

/// The pet window size for the chosen pet size (layout.ts petWindowSize). Open windows are
/// resized in place, keeping each pet's feet where they were.
#[tauri::command]
pub fn pets_set_size(app: AppHandle, window: WebviewWindow, width: i32, height: i32) -> Result<(), String> {
    require_main(&window)?;
    let size = sane_size(width, height);
    let moves: Vec<(String, (i32, i32))> = {
        let mut g = state(&app).0.lock().unwrap();
        if g.size == size {
            return Ok(());
        }
        let old = g.size;
        g.size = size;
        g.open.iter().filter_map(|a| g.store.get(a).map(|p| (a.clone(), resize_anchor(p, old, size)))).collect()
    };
    if moves.is_empty() {
        return Ok(());
    }
    let (bounds, _) = monitors(&app);
    for (agent, pos) in moves {
        let pos = pets::clamp_saved(pos, size, &bounds).unwrap_or(pos);
        if let Some(w) = label_for(&agent).and_then(|l| app.get_webview_window(&l)) {
            let _ = w.set_size(LogicalSize::new(size.0, size.1));
            let _ = w.set_position(LogicalPosition::new(pos.0, pos.1));
        }
        state(&app).0.lock().unwrap().store.set(&agent, pos);
    }
    schedule_save(&app);
    Ok(())
}

#[tauri::command]
pub fn pets_close_all(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    close_all(&app);
    Ok(())
}

#[tauri::command]
pub fn pets_reset_positions(app: AppHandle) {
    reset_positions(&app);
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

/// Right-click on a pet: the same menu as the tray icon, at the pointer.
#[tauri::command]
pub fn pet_menu(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let m = menu(&app).map_err(|e| e.to_string())?;
    window.popup_menu(&m).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------- self-test (debug builds)

/// `DESKPET_SELFTEST_AGENTS=a,b` (debug builds only): after start-up, feed one local event per
/// agent through the same path as mailbox events (no network, nothing sent to the main window),
/// log where their windows really are, then send each a `done`. Positions go to
/// pets-selftest.json, not pets.json.
fn selftest_agents() -> Option<Vec<String>> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let v = std::env::var("DESKPET_SELFTEST_AGENTS").ok()?;
    let list: Vec<String> = v.split(',').map(str::trim).filter(|a| pets::agent_id_ok(a)).take(4).map(String::from).collect();
    (!list.is_empty()).then_some(list)
}

pub fn selftest(app: &AppHandle) {
    let Some(agents) = selftest_agents() else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        log_line(&app, &format!("selftest: opening {} pet windows", agents.len()));
        std::thread::sleep(Duration::from_secs(2));
        for (i, a) in agents.iter().enumerate() {
            let now = crate::v2::now_ms();
            let (state, msg) = if i % 2 == 0 { ("working", "Self-test: working") } else { ("thinking", "Self-test: thinking") };
            on_state(
                &app,
                json!({"agent_id": a, "agent_name": format!("Test {}", i + 1), "session": "selftest", "state": state,
                       "event": "selftest", "message": msg, "ts": crate::v2::iso_from_ms(now), "seq": now,
                       "received_at": crate::v2::iso_from_ms(now), "via": "selftest"}),
            );
        }
        std::thread::sleep(Duration::from_secs(4));
        log_windows(&app, "selftest");
        // Then each bot finishes (sent to its open window), so its pet rests: done, then idle.
        for (i, a) in agents.iter().enumerate() {
            let now = crate::v2::now_ms();
            on_state(
                &app,
                json!({"agent_id": a, "agent_name": format!("Test {}", i + 1), "session": "selftest", "state": "done",
                       "event": "selftest_end", "ts": crate::v2::iso_from_ms(now), "seq": now,
                       "received_at": crate::v2::iso_from_ms(now), "via": "selftest"}),
            );
        }
        log_line(&app, "selftest: sent done to each pet window");
    });
}

/// One log line per pet window with where the OS says it is (logical points).
fn log_windows(app: &AppHandle, tag: &str) {
    let agents = state(app).0.lock().unwrap().open.clone();
    for a in &agents {
        let Some(w) = label_for(a).and_then(|l| app.get_webview_window(&l)) else {
            log_line(app, &format!("{tag}: agent={a} has no window"));
            continue;
        };
        let sf = w.scale_factor().unwrap_or(1.0);
        let p = w.outer_position().map(|p| p.to_logical::<i32>(sf)).ok();
        let s = w.outer_size().map(|s| s.to_logical::<i32>(sf)).ok();
        let (x, y) = p.map(|p| (p.x, p.y)).unwrap_or_default();
        let (ww, wh) = s.map(|s| (s.width, s.height)).unwrap_or_default();
        log_line(app, &format!("{tag}: window {} agent={a} at ({x},{y}) {ww}x{wh} visible={}", w.label(), w.is_visible().unwrap_or(false)));
    }
    let total = app.webview_windows().len();
    log_line(app, &format!("{tag}: {} pet windows, {total} windows in all", agents.len()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_icon_is_a_black_template_at_18pt_2x() {
        let img = tauri::image::Image::from_bytes(TRAY_TEMPLATE).expect("tray-template@2x.png decodes");
        assert_eq!((img.width(), img.height()), (36, 36));
        let px: Vec<&[u8]> = img.rgba().chunks(4).collect();
        assert!(px.iter().all(|p| p[0] == 0 && p[1] == 0 && p[2] == 0), "template images are black + alpha only");
        let opaque = px.iter().filter(|p| p[3] > 200).count();
        let clear = px.iter().filter(|p| p[3] == 0).count();
        assert!(opaque > 200 && clear > 300, "a silhouette, not a block: {opaque} opaque, {clear} clear");
    }

    #[test]
    fn menu_is_in_macos_order_and_title_case() {
        let labels: Vec<&str> = MENU_ITEMS.iter().map(|(_, l)| *l).collect();
        assert_eq!(labels, ["Settings…", "Reset Pet Positions", "Quit Desk Pet"]);
        // Every id is handled by on_menu.
        let ids: Vec<&str> = MENU_ITEMS.iter().map(|(i, _)| *i).collect();
        assert_eq!(ids, ["settings", "reset-positions", "quit"]);
    }
}
