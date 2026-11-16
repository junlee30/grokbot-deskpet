//! Remember the pet window's position across restarts (app config dir / window.json), and
//! restore it clamped onto a monitor that is actually connected.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow, WindowEvent};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Saved {
    pub x: i32,
    pub y: i32,
}

/// A monitor rectangle in physical pixels: (x, y, width, height).
pub type Rect = (i32, i32, u32, u32);

fn overlap(a0: i32, a1: i32, b0: i32, b1: i32) -> i64 {
    (a1.min(b1) as i64 - a0.max(b0) as i64).max(0)
}

/// Pick the monitor that shows most of the window and clamp the window fully inside it.
/// Returns None when the saved position is not visible on any connected monitor.
pub fn clamp_to_monitors(pos: (i32, i32), size: (u32, u32), monitors: &[Rect]) -> Option<(i32, i32)> {
    let (x, y) = pos;
    let (w, h) = (size.0 as i32, size.1 as i32);
    let best = monitors
        .iter()
        .map(|m| {
            let (mx, my, mw, mh) = (m.0, m.1, m.2 as i32, m.3 as i32);
            (overlap(x, x + w, mx, mx + mw) * overlap(y, y + h, my, my + mh), m)
        })
        .filter(|(area, _)| *area >= 32 * 32)
        .max_by_key(|(area, _)| *area)?;
    let (mx, my, mw, mh) = (best.1 .0, best.1 .1, best.1 .2 as i32, best.1 .3 as i32);
    let cx = x.clamp(mx, (mx + mw - w).max(mx));
    let cy = y.clamp(my, (my + mh - h).max(my));
    Some((cx, cy))
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load(app: &AppHandle) -> Option<Saved> {
    let data = std::fs::read(file(app)?).ok()?;
    serde_json::from_slice(&data).ok()
}

fn save(app: &AppHandle, s: Saved) {
    let Some(path) = file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec(&s) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Move the (still hidden) window to its saved spot, if that spot is on a connected monitor.
pub fn restore(window: &WebviewWindow) {
    let Some(saved) = load(window.app_handle()) else { return };
    let Ok(size) = window.outer_size() else { return };
    let monitors: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height))
        .collect();
    if let Some((x, y)) = clamp_to_monitors((saved.x, saved.y), (size.width, size.height), &monitors) {
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

/// Save the position after the window stops moving (debounced) and once more on close.
pub fn track(window: &WebviewWindow) {
    let pending: Arc<Mutex<(Option<Saved>, u64)>> = Arc::new(Mutex::new((None, 0)));
    let app = window.app_handle().clone();
    window.on_window_event(move |ev| match ev {
        WindowEvent::Moved(p) => {
            let gen = {
                let mut g = pending.lock().unwrap();
                g.0 = Some(Saved { x: p.x, y: p.y });
                g.1 += 1;
                g.1
            };
            let (pending, app) = (pending.clone(), app.clone());
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                let s = {
                    let g = pending.lock().unwrap();
                    if g.1 != gen {
                        return; // moved again since; that move will save
                    }
                    g.0
                };
                if let Some(s) = s {
                    save(&app, s);
                }
            });
        }
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
            if let Some(s) = pending.lock().unwrap().0 {
                save(&app, s);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = (0, 0, 2880, 1800);
    const LEFT: Rect = (-1920, 200, 1920, 1080);

    #[test]
    fn keeps_a_visible_position() {
        assert_eq!(clamp_to_monitors((100, 100), (720, 400), &[MAIN]), Some((100, 100)));
        assert_eq!(clamp_to_monitors((-1000, 500), (720, 400), &[MAIN, LEFT]), Some((-1000, 500)));
    }

    #[test]
    fn clamps_partially_offscreen_windows_inside() {
        assert_eq!(clamp_to_monitors((2600, 1700), (720, 400), &[MAIN]), Some((2160, 1400)));
        assert_eq!(clamp_to_monitors((-50, -20), (720, 400), &[MAIN]), Some((0, 0)));
    }

    #[test]
    fn forgets_positions_on_unplugged_monitors() {
        assert_eq!(clamp_to_monitors((-1000, 500), (720, 400), &[MAIN]), None);
        assert_eq!(clamp_to_monitors((5000, 5000), (720, 400), &[MAIN, LEFT]), None);
        assert_eq!(clamp_to_monitors((0, 0), (720, 400), &[]), None);
    }

    #[test]
    fn picks_the_monitor_showing_most_of_the_window() {
        // straddles the edge, mostly on LEFT
        assert_eq!(clamp_to_monitors((-600, 300), (720, 400), &[MAIN, LEFT]), Some((-720, 300)));
    }
}
