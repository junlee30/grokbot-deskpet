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
use crate::lock::Locked;

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
    /// Agents whose pet is showing needs_you (the menu bar icon shows how many).
    needing: HashSet<String>,
    /// Pets the user hid (right-click → Hide), with their recent events, until the bot does
    /// something new or the user picks Show Hidden Pets.
    hidden: HashMap<String, VecDeque<Value>>,
    /// The menu and menu bar labels in the app's UI language (set by the main window).
    ui: UiStrings,
}

/// Menu and menu bar labels in the app's UI language. The main window sends them
/// (src/i18n.ts) at start-up; until then, and for anything it leaves out, English.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(default)]
pub struct UiStrings {
    pub settings: String,
    pub reset_positions: String,
    pub show_hidden: String,
    pub quit: String,
    /// Menu bar tooltip with one bot waiting, and with several (`{n}` = how many).
    pub tray_needs_one: String,
    pub tray_needs_many: String,
}

impl Default for UiStrings {
    fn default() -> Self {
        Self {
            settings: MENU_ITEMS[0].1.into(),
            reset_positions: MENU_ITEMS[1].1.into(),
            show_hidden: MENU_ITEMS[2].1.into(),
            quit: MENU_ITEMS[3].1.into(),
            tray_needs_one: "Desk Pet · 1 bot needs you".into(),
            tray_needs_many: "Desk Pet · {n} bots need you".into(),
        }
    }
}

impl UiStrings {
    /// Labels from a webview: one line each, capped; an empty one keeps the English default.
    fn sanitized(self) -> Self {
        let d = Self::default();
        let fix = |v: String, def: String| {
            let v = one_line(&v, 64);
            if v.is_empty() {
                def
            } else {
                v
            }
        };
        Self {
            settings: fix(self.settings, d.settings),
            reset_positions: fix(self.reset_positions, d.reset_positions),
            show_hidden: fix(self.show_hidden, d.show_hidden),
            quit: fix(self.quit, d.quit),
            tray_needs_one: fix(self.tray_needs_one, d.tray_needs_one),
            tray_needs_many: fix(self.tray_needs_many, d.tray_needs_many),
        }
    }
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
            needing: HashSet::new(),
            hidden: HashMap::new(),
            ui: UiStrings::default(),
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
    let mut g = state(app).0.locked();
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
        let g = state(app).0.locked();
        (g.path.clone(), g.store.to_json())
    };
    write_store(path, bytes);
}

/// Write the store 400 ms after the last change (a drag moves the window many times).
fn schedule_save(app: &AppHandle) {
    let gen = {
        let mut g = state(app).0.locked();
        g.save_gen += 1;
        g.save_gen
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if state(&app).0.locked().save_gen == gen {
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
/// bot-supplied text, so they get only what a pet needs (pet_init, pet_menu, pet_attention,
/// open_settings_window, grokbot_installed).
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
    state(app).0.locked().status = status;
}

/// A decrypted, validated state event: open the agent's window or send it there.
pub fn on_state(app: &AppHandle, v: Value) {
    let Some(agent) = v.get("agent_id").and_then(Value::as_str).map(str::to_owned) else { return };
    // A hidden pet: keep its events; come back only when the bot does something new.
    let unhid = {
        let mut g = state(app).0.locked();
        match g.hidden.get_mut(&agent) {
            Some(buf) if pets::stays_hidden(&v) => {
                if buf.len() >= BUFFER {
                    buf.pop_front();
                }
                buf.push_back(v);
                return;
            }
            Some(_) => {
                let buf = g.hidden.remove(&agent).unwrap_or_default();
                g.buffers.insert(agent.clone(), buf);
                true
            }
            None => false,
        }
    };
    if unhid {
        sync_tray_menu(app);
        log_line(app, &format!("pet shown again: agent={agent} posted"));
    }
    let route = {
        let mut g = state(app).0.locked();
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
        let mut g = state(app).0.locked();
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
            let n = state(app).0.locked().open.len();
            log_line(app, &format!("pet window opened: agent={agent} at ({},{}) {}x{} (open: {n})", pos.0, pos.1, size.0, size.1));
        }
        Err(e) => {
            {
                let mut g = state(app).0.locked();
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
            state(&app).0.locked().store.set(&agent, pos);
            schedule_save(&app);
        }
        WindowEvent::Destroyed => {
            {
                let mut g = state(&app).0.locked();
                g.open.retain(|a| a != &agent);
                g.buffers.remove(&agent);
                g.needing.remove(&agent);
            }
            sync_tray_count(&app);
            save_now(&app);
        }
        _ => {}
    });
}

/// Close every pet window (unpair, new code). Saved positions stay.
pub fn close_all(app: &AppHandle) {
    let agents: Vec<String> = {
        let mut g = state(app).0.locked();
        g.buffers.clear();
        g.dropped.clear();
        g.needing.clear();
        g.hidden.clear();
        std::mem::take(&mut g.open)
    };
    sync_tray_count(app);
    sync_tray_menu(app);
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
        let mut g = state(app).0.locked();
        g.store.clear();
        (g.open.clone(), g.size)
    };
    let (_, work) = monitors(app);
    for (agent, pos) in reset_layout(&agents, size, &work) {
        if let Some(w) = label_for(&agent).and_then(|l| app.get_webview_window(&l)) {
            let _ = w.set_position(LogicalPosition::new(pos.0, pos.1));
        }
        state(app).0.locked().store.set(&agent, pos);
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
pub const MENU_ITEMS: [(&str, &str); 4] =
    [("settings", "Settings…"), ("reset-positions", "Reset Pet Positions"), ("show-hidden", "Show Hidden Pets"), ("quit", "Quit Desk Pet")];

/// The menu. On a pet (right-click) it starts with "Hide <name>" for that pet. Show Hidden
/// Pets is enabled only while some pet is hidden.
fn menu(app: &AppHandle, pet: Option<(&str, String)>) -> tauri::Result<Menu<Wry>> {
    let (any_hidden, ui) = {
        let g = state(app).0.locked();
        (!g.hidden.is_empty(), g.ui.clone())
    };
    let labels = [ui.settings, ui.reset_positions, ui.show_hidden, ui.quit];
    let item = |i: usize, enabled: bool| MenuItem::with_id(app, MENU_ITEMS[i].0, &labels[i], enabled, None::<&str>);
    let m = Menu::new(app)?;
    if let Some((agent, hide_label)) = pet {
        if let Some(id) = pets::hide_menu_id(agent) {
            m.append(&MenuItem::with_id(app, id, hide_label, true, None::<&str>)?)?;
            m.append(&PredefinedMenuItem::separator(app)?)?;
        }
    }
    m.append(&item(0, true)?)?;
    m.append(&item(1, true)?)?;
    m.append(&item(2, any_hidden)?)?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&item(3, true)?)?;
    Ok(m)
}

/// The menu bar menu follows whether anything is hidden.
fn sync_tray_menu(app: &AppHandle) {
    if let (Some(tray), Ok(m)) = (app.tray_by_id("deskpet"), menu(app, None)) {
        let _ = tray.set_menu(Some(m));
    }
}

pub fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "settings" => open_settings(app),
        "reset-positions" => reset_positions(app),
        "show-hidden" => show_hidden(app),
        "quit" => app.exit(0),
        _ => {
            if let Some(agent) = pets::agent_of_hide_id(id) {
                hide(app, agent);
            }
        }
    }
}

/// Close one bot's pet until it does something new (or Show Hidden Pets). Its recent events
/// are kept, so it comes back as it was.
pub fn hide(app: &AppHandle, agent: &str) {
    {
        let mut g = state(app).0.locked();
        if !g.open.iter().any(|a| a == agent) {
            return;
        }
        let buf = g.buffers.remove(agent).unwrap_or_default();
        g.hidden.insert(agent.to_string(), buf);
    }
    if let Some(w) = label_for(agent).and_then(|l| app.get_webview_window(&l)) {
        let _ = w.destroy(); // Destroyed: drops it from the open list and the needs-you count
    }
    sync_tray_menu(app);
    log_line(app, &format!("pet hidden: agent={agent}"));
}

/// Bring every hidden pet back now, where it was.
pub fn show_hidden(app: &AppHandle) {
    let agents: Vec<String> = {
        let mut g = state(app).0.locked();
        let hidden: Vec<(String, VecDeque<Value>)> = g.hidden.drain().collect();
        let mut back = Vec::new();
        for (agent, buf) in hidden {
            if g.open.len() >= pets::MAX_PET_WINDOWS {
                g.hidden.insert(agent, buf); // still over the cap: stays hidden
                continue;
            }
            g.buffers.insert(agent.clone(), buf);
            g.open.push(agent.clone());
            back.push(agent);
        }
        back
    };
    for agent in &agents {
        create(app, agent);
    }
    sync_tray_menu(app);
    if !agents.is_empty() {
        log_line(app, &format!("hidden pets shown: {}", agents.len()));
    }
}

/// The menu bar icon: a black + alpha template image (icons-src/tray-template.svg, 36 px drawn at
/// 18 pt), so macOS tints it for light, dark and highlighted menu bars.
const TRAY_TEMPLATE: &[u8] = include_bytes!("../icons/tray-template@2x.png");

/// Menu bar icon: the way back to settings when every window is a pet.
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let mut b = TrayIconBuilder::with_id("deskpet").tooltip("Desk Pet").menu(&menu(app, None)?).show_menu_on_left_click(true);
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

/// The menu bar icon's title and tooltip: how many bots need you (nothing when none do).
pub fn tray_count_text(n: usize, ui: &UiStrings) -> (Option<String>, String) {
    match n {
        0 => (None, "Desk Pet".into()),
        1 => (Some("1".into()), ui.tray_needs_one.clone()),
        n => (Some(n.to_string()), ui.tray_needs_many.replace("{n}", &n.to_string())),
    }
}

fn sync_tray_count(app: &AppHandle) {
    let (n, ui) = {
        let g = state(app).0.locked();
        (g.needing.len(), g.ui.clone())
    };
    if let Some(tray) = app.tray_by_id("deskpet") {
        let (title, tip) = tray_count_text(n, &ui);
        let _ = tray.set_title(title);
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// One line of bot-supplied text, cut to `max` characters, for a notification.
fn one_line(s: &str, max: usize) -> String {
    let t: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > max {
        t.chars().take(max - 1).chain(std::iter::once('…')).collect()
    } else {
        t
    }
}

/// The pet window writes the notification in its bot's language (src/i18n.ts); here it's
/// only made one line and capped.
fn notify_needs_you(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let title = Some(one_line(title, 80)).filter(|t| !t.is_empty()).unwrap_or_else(|| "Desk Pet".into());
    let body = one_line(body, 160);
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        log_line(app, &format!("notification failed: {e}"));
    }
}

// ---------------------------------------------------------------- commands

/// A pet started or stopped showing needs_you. `notify`: the pet window decided this one is
/// fresh and the user wants notifications (Settings). Counts feed the menu bar icon.
#[tauri::command]
pub fn pet_attention(app: AppHandle, window: WebviewWindow, needs: bool, notify: bool, title: String, body: String) -> Result<(), String> {
    let agent = agent_of(window.label()).ok_or("not a pet window")?.to_string();
    let changed = {
        let mut g = state(&app).0.locked();
        if needs {
            g.needing.insert(agent)
        } else {
            g.needing.remove(&agent)
        }
    };
    if changed {
        sync_tray_count(&app);
    }
    if needs && notify {
        notify_needs_you(&app, &title, &body);
    }
    Ok(())
}

/// A pet window starting up: which agent it is, the events so far, the mailbox status.
#[tauri::command]
pub fn pet_init(window: WebviewWindow, st: State<'_, PetWindows>) -> Result<Value, String> {
    let agent = agent_of(window.label()).ok_or("not a pet window")?.to_string();
    let g = st.0.locked();
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
        let mut g = state(&app).0.locked();
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
        state(&app).0.locked().store.set(&agent, pos);
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
pub fn pets_reset_positions(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    reset_positions(&app);
    Ok(())
}

#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

/// Right-click on a pet: the same menu as the tray icon, at the pointer.
#[tauri::command]
pub fn pet_menu(app: AppHandle, window: WebviewWindow, name: Option<String>, hide_label: Option<String>) -> Result<(), String> {
    let agent = agent_of(window.label()).map(str::to_owned);
    let pet = agent.as_deref().map(|a| {
        // "Hide <name>" in the UI language, from the pet window; English if it didn't say.
        let label = hide_label.map(|l| one_line(&l, 48)).filter(|l| !l.is_empty());
        (a, label.unwrap_or_else(|| pets::hide_label(name.as_deref().unwrap_or(a))))
    });
    let m = menu(&app, pet).map_err(|e| e.to_string())?;
    window.popup_menu(&m).map_err(|e| e.to_string())
}

/// The main window's labels for the menus and the menu bar tooltip (its UI language).
#[tauri::command]
pub fn set_ui_strings(app: AppHandle, window: WebviewWindow, strings: UiStrings) -> Result<(), String> {
    require_main(&window)?;
    state(&app).0.locked().ui = strings.sanitized();
    sync_tray_menu(&app);
    sync_tray_count(&app);
    Ok(())
}

#[tauri::command]
pub fn app_quit(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    app.exit(0);
    Ok(())
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
        // Hide: the first pet hides (through the menu's own path), stays hidden through a
        // heartbeat, comes back on a new turn; hidden again, Show Hidden Pets brings it back.
        let a = agents[0].clone();
        let post = |event: &str, state: &str| {
            let now = crate::v2::now_ms();
            on_state(
                &app,
                json!({"agent_id": a, "agent_name": "Test 1", "session": "selftest", "state": state, "event": event,
                       "ts": crate::v2::iso_from_ms(now), "seq": now, "received_at": crate::v2::iso_from_ms(now), "via": "selftest"}),
            );
        };
        let step = |what: &str| {
            std::thread::sleep(Duration::from_millis(1500));
            let g = state(&app).0.locked();
            let window = label_for(&a).and_then(|l| app.get_webview_window(&l)).is_some();
            let line = format!("selftest hide: {what}: open={} hidden={} window={window}", g.open.contains(&a), g.hidden.contains_key(&a));
            drop(g);
            log_line(&app, &line);
        };
        on_menu(&app, &pets::hide_menu_id(&a).unwrap_or_default());
        step("after Hide");
        post("heartbeat", "done");
        step("after a heartbeat");
        post("turn_start", "thinking");
        step("after a new turn");
        on_menu(&app, &pets::hide_menu_id(&a).unwrap_or_default());
        step("hidden again");
        on_menu(&app, "show-hidden");
        step("after Show Hidden Pets");
    });
}

/// One log line per pet window with where the OS says it is (logical points).
fn log_windows(app: &AppHandle, tag: &str) {
    let agents = state(app).0.locked().open.clone();
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
    fn tray_count_and_notification_text() {
        let en = UiStrings::default();
        assert_eq!(tray_count_text(0, &en), (None, "Desk Pet".to_string()));
        assert_eq!(tray_count_text(1, &en), (Some("1".into()), "Desk Pet · 1 bot needs you".into()));
        assert!(tray_count_text(3, &en).1.ends_with("3 bots need you"));
        let ko: UiStrings = serde_json::from_value(json!({"tray_needs_one": "Desk Pet · 봇 1개가 기다리는 중", "tray_needs_many": "Desk Pet · 봇 {n}개가 기다리는 중", "quit": "Desk Pet 종료"})).unwrap();
        let ko = ko.sanitized();
        assert_eq!(tray_count_text(2, &ko).1, "Desk Pet · 봇 2개가 기다리는 중");
        assert_eq!(ko.quit, "Desk Pet 종료");
        assert_eq!(ko.settings, "Settings…", "a label left out stays English");
        let messy: UiStrings = serde_json::from_value(json!({"settings": "  Set\ntings  ", "quit": ""})).unwrap();
        let messy = messy.sanitized();
        assert_eq!((messy.settings.as_str(), messy.quit.as_str()), ("Set tings", "Quit Desk Pet"));
        assert_eq!(one_line("  a\n\tb  ", 10), "a b");
        assert_eq!(one_line(&"é".repeat(200), 160).chars().count(), 160);
    }

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
        assert_eq!(labels, ["Settings…", "Reset Pet Positions", "Show Hidden Pets", "Quit Desk Pet"]);
        // Every id is handled by on_menu.
        let ids: Vec<&str> = MENU_ITEMS.iter().map(|(i, _)| *i).collect();
        assert_eq!(ids, ["settings", "reset-positions", "show-hidden", "quit"]);
        assert!(ids.iter().all(|i| pets::agent_of_hide_id(i).is_none()), "no clash with hide:<agent>");
    }
}
