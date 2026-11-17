//! One window per bot: the pure part (no Tauri), unit-tested.
//!
//! - window labels: `pet-<agent_id>` (agent ids are `[a-z0-9_-]{1,64}`, as v2 validates them)
//! - which events open a window, which are delivered, which are dropped (`route_event`)
//! - the position store (app config dir / pets.json): each agent's last top-left corner, in
//!   logical points (macOS's global coordinate space, the same on every monitor)
//! - where a window goes: its saved spot clamped onto a connected monitor, or else the first
//!   free slot of a cascade along the bottom-right of the primary monitor's work area
//!
//! The Tauri glue (creating, moving and closing the windows) is in pet_windows.rs.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const LABEL_PREFIX: &str = "pet-";
/// At most this many pet windows at once; events of further agents are dropped.
pub const MAX_PET_WINDOWS: usize = 12;
/// The store forgets the least recently used agents beyond this.
pub const MAX_SAVED: usize = 128;
/// Distance of the default cascade from the work area's edges, and between pets.
pub const MARGIN: i32 = 16;
pub const GAP: i32 = 4;
/// Pet window size bounds (logical px); the UI asks for its size (layout.ts petWindowSize).
pub const MIN_SIZE: i32 = 64;
pub const MAX_SIZE: i32 = 480;

/// A rectangle in logical points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect { x, y, w, h }
    }
    pub fn at(pos: (i32, i32), size: (i32, i32)) -> Self {
        Rect::new(pos.0, pos.1, size.0, size.1)
    }
    pub fn intersects(&self, o: &Rect) -> bool {
        self.x < o.x + o.w && o.x < self.x + self.w && self.y < o.y + o.h && o.y < self.y + self.h
    }
}

pub fn agent_id_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// The window label of an agent's pet (None for ids v2 would never deliver).
pub fn label_for(agent: &str) -> Option<String> {
    agent_id_ok(agent).then(|| format!("{LABEL_PREFIX}{agent}"))
}

/// The agent a pet window label belongs to (None for "main" and anything else).
pub fn agent_of(label: &str) -> Option<&str> {
    label.strip_prefix(LABEL_PREFIX).filter(|a| agent_id_ok(a))
}

// ---------------------------------------------------------------- lifecycle

#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// The agent's window exists (or is being created): send the event to it.
    Deliver,
    /// First event of this agent: open its window.
    Create,
    /// Bad id, or already MAX_PET_WINDOWS windows: drop the event.
    Ignore,
}

pub fn route_event(open: &[String], agent: &str, max: usize) -> Route {
    if !agent_id_ok(agent) {
        Route::Ignore
    } else if open.iter().any(|a| a == agent) {
        Route::Deliver
    } else if open.len() >= max {
        Route::Ignore
    } else {
        Route::Create
    }
}

// ---------------------------------------------------------------- position store

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pos {
    pub x: i32,
    pub y: i32,
    /// Store clock at the last change (least recently used agents are forgotten first).
    #[serde(default)]
    pub used: u64,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
pub struct Store {
    #[serde(default)]
    pub positions: BTreeMap<String, Pos>,
    #[serde(default)]
    clock: u64,
}

impl Store {
    /// Parse pets.json; a missing or broken file is an empty store. Invalid ids are dropped.
    pub fn from_json(bytes: &[u8]) -> Store {
        let mut s: Store = serde_json::from_slice(bytes).unwrap_or_default();
        s.positions.retain(|k, _| agent_id_ok(k));
        s.clock = s.clock.max(s.positions.values().map(|p| p.used).max().unwrap_or(0));
        s.evict();
        s
    }

    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).unwrap_or_default()
    }

    pub fn get(&self, agent: &str) -> Option<(i32, i32)> {
        self.positions.get(agent).map(|p| (p.x, p.y))
    }

    pub fn set(&mut self, agent: &str, pos: (i32, i32)) {
        if !agent_id_ok(agent) {
            return;
        }
        if self.get(agent) == Some(pos) {
            return;
        }
        self.clock += 1;
        self.positions.insert(agent.to_string(), Pos { x: pos.0, y: pos.1, used: self.clock });
        self.evict();
    }

    pub fn clear(&mut self) {
        self.positions.clear();
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.positions.len()
    }

    fn evict(&mut self) {
        while self.positions.len() > MAX_SAVED {
            let oldest = self.positions.iter().min_by_key(|(_, p)| p.used).map(|(k, _)| k.clone());
            match oldest {
                Some(k) => self.positions.remove(&k),
                None => break,
            };
        }
    }

    /// Where the other agents' pets are (or will be when they come back).
    pub fn others(&self, agent: &str, size: (i32, i32)) -> Vec<Rect> {
        self.positions.iter().filter(|(k, _)| k.as_str() != agent).map(|(_, p)| Rect::at((p.x, p.y), size)).collect()
    }
}

// ---------------------------------------------------------------- placement

/// Keep a saved spot if it is visible: clamped fully onto the monitor showing most of it.
/// None when it is (nearly) off every connected monitor, e.g. that monitor was unplugged.
pub fn clamp_saved(pos: (i32, i32), size: (i32, i32), monitors: &[Rect]) -> Option<(i32, i32)> {
    let rects: Vec<crate::window_state::Rect> =
        monitors.iter().map(|m| (m.x, m.y, m.w.max(0) as u32, m.h.max(0) as u32)).collect();
    crate::window_state::clamp_to_monitors(pos, (size.0.max(0) as u32, size.1.max(0) as u32), &rects)
}

/// Default spot for a new pet: the first slot, right to left then bottom to top, along the
/// bottom-right of `work[0]` (the primary monitor's work area: no menu bar, no Dock) that
/// overlaps no `occupied` rect. When every slot is taken, a diagonal cascade from the corner.
pub fn cascade(work: &[Rect], size: (i32, i32), occupied: &[Rect]) -> (i32, i32) {
    let Some(a) = work.first() else { return (MARGIN, MARGIN) };
    let (w, h) = size;
    let right = a.x + a.w - MARGIN - w;
    let bottom = a.y + a.h - MARGIN - h;
    let (left, top) = (a.x + MARGIN, a.y + MARGIN);
    if right < left || bottom < top {
        return (a.x.max(right.min(a.x + a.w - w)), a.y.max(bottom.min(a.y + a.h - h)));
    }
    let mut y = bottom;
    while y >= top {
        let mut x = right;
        while x >= left {
            let r = Rect::at((x, y), size);
            if !occupied.iter().any(|o| o.intersects(&r)) {
                return (x, y);
            }
            x -= w + GAP;
        }
        y -= h + GAP;
    }
    let k = (occupied.len() % 8) as i32;
    ((right - k * 28).max(left), (bottom - k * 28).max(top))
}

/// Where a pet window opens: its saved spot (clamped), else the next free cascade slot.
pub fn place_new(saved: Option<(i32, i32)>, size: (i32, i32), monitors: &[Rect], work: &[Rect], occupied: &[Rect]) -> (i32, i32) {
    saved.and_then(|p| clamp_saved(p, size, monitors)).unwrap_or_else(|| cascade(work, size, occupied))
}

/// "Reset pet positions": the open pets, in the order they appeared, along the cascade.
pub fn reset_layout(agents: &[String], size: (i32, i32), work: &[Rect]) -> Vec<(String, (i32, i32))> {
    let mut taken: Vec<Rect> = Vec::new();
    agents
        .iter()
        .map(|a| {
            let p = cascade(work, size, &taken);
            taken.push(Rect::at(p, size));
            (a.clone(), p)
        })
        .collect()
}

/// New top-left after a resize that keeps the pet's feet where they were (bottom centre).
pub fn resize_anchor(pos: (i32, i32), old: (i32, i32), new: (i32, i32)) -> (i32, i32) {
    (pos.0 + (old.0 - new.0) / 2, pos.1 + (old.1 - new.1))
}

/// A requested window size, bounded.
pub fn sane_size(w: i32, h: i32) -> (i32, i32) {
    (w.clamp(MIN_SIZE, MAX_SIZE), h.clamp(MIN_SIZE, MAX_SIZE))
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 1512x982 laptop screen (menu bar 33, Dock 70 at the bottom) and a 1920x1080 monitor
    // above-left of it, in logical points.
    const MAIN: Rect = Rect { x: 0, y: 0, w: 1512, h: 982 };
    const MAIN_WORK: Rect = Rect { x: 0, y: 33, w: 1512, h: 879 };
    const TOP: Rect = Rect { x: -196, y: -1080, w: 1920, h: 1080 };
    const SIZE: (i32, i32) = (184, 160);

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn labels_round_trip_and_reject_bad_ids() {
        assert_eq!(label_for("jarvis").as_deref(), Some("pet-jarvis"));
        assert_eq!(agent_of("pet-jarvis"), Some("jarvis"));
        assert_eq!(agent_of(&label_for("a_b-9").unwrap()), Some("a_b-9"));
        assert_eq!(agent_of("main"), None);
        assert_eq!(agent_of("pet-"), None);
        assert_eq!(agent_of("pet-Jarvis"), None);
        assert_eq!(label_for("Jarvis"), None);
        assert_eq!(label_for("a/b"), None);
        assert_eq!(label_for(""), None);
        assert_eq!(label_for(&"x".repeat(65)), None);
    }

    #[test]
    fn first_event_creates_later_events_deliver() {
        let open = ids(&["jarvis"]);
        assert_eq!(route_event(&open, "claude", 12), Route::Create);
        assert_eq!(route_event(&open, "jarvis", 12), Route::Deliver);
        assert_eq!(route_event(&open, "Bad Id", 12), Route::Ignore);
    }

    #[test]
    fn window_cap_drops_new_agents_but_not_open_ones() {
        let open = ids(&["a", "b"]);
        assert_eq!(route_event(&open, "c", 2), Route::Ignore);
        assert_eq!(route_event(&open, "b", 2), Route::Deliver);
    }

    #[test]
    fn store_save_load_round_trip() {
        let mut s = Store::default();
        s.set("jarvis", (100, 200));
        s.set("claude", (-150, -900));
        let back = Store::from_json(&s.to_json());
        assert_eq!(back.get("jarvis"), Some((100, 200)));
        assert_eq!(back.get("claude"), Some((-150, -900)));
        assert_eq!(back, s);
        // a later set wins and survives another round trip
        let mut back = back;
        back.set("jarvis", (5, 6));
        assert_eq!(Store::from_json(&back.to_json()).get("jarvis"), Some((5, 6)));
    }

    #[test]
    fn store_tolerates_missing_broken_and_hostile_files() {
        assert_eq!(Store::from_json(b""), Store::default());
        assert_eq!(Store::from_json(b"{not json"), Store::default());
        assert_eq!(Store::from_json(b"[]"), Store::default());
        let s = Store::from_json(br#"{"positions":{"ok":{"x":1,"y":2},"Bad/../id":{"x":3,"y":4}}}"#);
        assert_eq!(s.get("ok"), Some((1, 2)));
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn store_forgets_least_recently_used_beyond_cap() {
        let mut s = Store::default();
        for i in 0..MAX_SAVED {
            s.set(&format!("a{i}"), (i as i32, 0));
        }
        s.set("a0", (9, 9)); // touch a0: a1 is now the oldest
        s.set("new", (1, 1));
        assert_eq!(s.len(), MAX_SAVED);
        assert_eq!(s.get("a1"), None);
        assert_eq!(s.get("a0"), Some((9, 9)));
        assert_eq!(s.get("new"), Some((1, 1)));
        // the clock survives a reload, so the order does too
        let mut r = Store::from_json(&s.to_json());
        r.set("newer", (2, 2));
        assert_eq!(r.get("a2"), None);
        assert_eq!(r.get("a0"), Some((9, 9)));
    }

    #[test]
    fn store_clear_and_others() {
        let mut s = Store::default();
        s.set("a", (0, 0));
        s.set("b", (200, 0));
        assert_eq!(s.others("a", SIZE), vec![Rect::new(200, 0, 184, 160)]);
        s.clear();
        assert_eq!(s.len(), 0);
        assert_eq!(s.get("a"), None);
    }

    #[test]
    fn saved_positions_are_kept_or_clamped_onto_a_monitor() {
        let mons = [MAIN, TOP];
        assert_eq!(clamp_saved((300, 400), SIZE, &mons), Some((300, 400)));
        assert_eq!(clamp_saved((100, -700), SIZE, &mons), Some((100, -700)), "on the second monitor");
        assert_eq!(clamp_saved((1450, 900), SIZE, &mons), Some((1512 - 184, 982 - 160)), "half off the right edge");
        assert_eq!(clamp_saved((5000, 5000), SIZE, &mons), None, "off every monitor");
        assert_eq!(clamp_saved((100, -700), SIZE, &[MAIN]), None, "monitor unplugged");
    }

    #[test]
    fn cascade_starts_bottom_right_and_never_overlaps() {
        let first = cascade(&[MAIN_WORK], SIZE, &[]);
        assert_eq!(first, (1512 - MARGIN - 184, 33 + 879 - MARGIN - 160));
        let mut taken = vec![];
        for _ in 0..10 {
            let p = cascade(&[MAIN_WORK], SIZE, &taken);
            let r = Rect::at(p, SIZE);
            assert!(!taken.iter().any(|t: &Rect| t.intersects(&r)), "{p:?} overlaps");
            assert!(r.x >= MAIN_WORK.x && r.x + r.w <= MAIN_WORK.x + MAIN_WORK.w, "{p:?} off screen");
            assert!(r.y >= MAIN_WORK.y && r.y + r.h <= MAIN_WORK.y + MAIN_WORK.h, "{p:?} off screen");
            taken.push(r);
        }
        // the second goes left of the first, on the same row
        assert_eq!(Rect::at(cascade(&[MAIN_WORK], SIZE, &taken[..1]), SIZE).y, taken[0].y);
        assert_eq!(taken[1].x, taken[0].x - 184 - GAP);
        // a row holds 7 pets of 184 (+4 gap) on 1512 - 2 * 16; the 8th starts the row above
        assert_eq!(taken[6].y, taken[0].y);
        assert_eq!(taken[7].x, taken[0].x);
        assert_eq!(taken[7].y, taken[0].y - 160 - GAP);
    }

    #[test]
    fn cascade_skips_spots_taken_by_saved_pets() {
        let first = cascade(&[MAIN_WORK], SIZE, &[]);
        // someone's pet was dragged onto the first slot, a bit off the grid
        let p = cascade(&[MAIN_WORK], SIZE, &[Rect::at((first.0 - 30, first.1 + 10), SIZE)]);
        assert_eq!(p, (first.0 - 2 * (184 + GAP), first.1));
    }

    #[test]
    fn cascade_full_screen_and_tiny_screen_fall_back_onscreen() {
        let small = Rect::new(0, 0, 400, 300);
        let full: Vec<Rect> = (0..20).map(|i| Rect::new(0, 0, 400, 300 + i)).collect();
        let (x, y) = cascade(&[small], SIZE, &full);
        assert!(x >= 0 && x + 184 <= 400 && y >= 0 && y + 160 <= 300, "({x},{y})");
        let tiny = Rect::new(10, 20, 100, 100);
        assert_eq!(cascade(&[tiny], SIZE, &[]), (10, 20));
        assert_eq!(cascade(&[], SIZE, &[]), (MARGIN, MARGIN));
    }

    #[test]
    fn place_new_prefers_the_saved_spot() {
        let mons = [MAIN, TOP];
        let work = [MAIN_WORK, TOP];
        assert_eq!(place_new(Some((100, -700)), SIZE, &mons, &work, &[]), (100, -700));
        let fresh = place_new(None, SIZE, &mons, &work, &[]);
        assert_eq!(fresh, cascade(&work, SIZE, &[]));
        // saved on an unplugged monitor: a fresh, free cascade slot instead
        let occupied = [Rect::at(fresh, SIZE)];
        let p = place_new(Some((100, -700)), SIZE, &[MAIN], &[MAIN_WORK], &occupied);
        assert!(!Rect::at(p, SIZE).intersects(&occupied[0]));
    }

    #[test]
    fn reset_lays_out_open_pets_in_order_without_overlap() {
        let out = reset_layout(&ids(&["jarvis", "claude", "scout"]), SIZE, &[MAIN_WORK]);
        assert_eq!(out.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>(), ["jarvis", "claude", "scout"]);
        assert_eq!(out[0].1, cascade(&[MAIN_WORK], SIZE, &[]));
        for i in 0..out.len() {
            for j in i + 1..out.len() {
                assert!(!Rect::at(out[i].1, SIZE).intersects(&Rect::at(out[j].1, SIZE)));
            }
        }
        assert!(reset_layout(&[], SIZE, &[MAIN_WORK]).is_empty());
    }

    #[test]
    fn resize_keeps_the_feet_in_place() {
        // large 184x160 -> small 152x128: centre x and bottom y unchanged
        let p = resize_anchor((1000, 700), (184, 160), (152, 128));
        assert_eq!(p, (1016, 732));
        assert_eq!(p.0 + 152 / 2, 1000 + 184 / 2);
        assert_eq!(p.1 + 128, 700 + 160);
        assert_eq!(resize_anchor(p, (152, 128), (184, 160)), (1000, 700));
    }

    #[test]
    fn sizes_are_bounded() {
        assert_eq!(sane_size(184, 160), (184, 160));
        assert_eq!(sane_size(0, -5), (MIN_SIZE, MIN_SIZE));
        assert_eq!(sane_size(100_000, 100_000), (MAX_SIZE, MAX_SIZE));
    }
}
