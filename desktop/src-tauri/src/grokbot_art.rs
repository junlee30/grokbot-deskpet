//! Grok Bot's avatar art, read at runtime from the user's own Grok Bot install.
//!
//! Each pet can be drawn as its bot's Grok Bot profile picture: the app's tray face strips (26
//! shapes, @2x and @1x) tinted with the app's avatar palette. That art is Grok Bot's, not ours,
//! so Desk Pet never ships it. Instead, on start-up, it reads the files out of the installed
//! app's `app.asar` (read-only, each checked against the archive's SHA-256 integrity record)
//! into `<app data>/grokbot-art/`, and pet windows load them over IPC (`grokbot_art_manifest`,
//! `grokbot_art_file`). The copy is redone when Grok Bot changes (its asar's size or mtime).
//! Without Grok Bot nothing is imported and every bot is drawn as the robot.
//!
//! (scripts/import-grokbot-art.mjs does the same for the browser preview during development.)

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock::Locked;
use crate::log_line;

pub const SHAPES: [&str; 26] = crate::v2::AVATAR_SHAPES;
pub const COLORS: [&str; 11] = crate::v2::AVATAR_COLORS;
const TRAY: &str = "dist/electron-main/menubar-tray/assets";
const RENDERER: &str = "dist/renderer/assets";
const MAIN: &str = "dist/electron-main";
const DIR: &str = "grokbot-art";
const MANIFEST: &str = "manifest.json";
/// No single file we read is anywhere near this; a bigger one means a broken archive.
const MAX_FILE: u64 = 64 * 1024 * 1024;
const DEFAULT_APP: &str = "/Applications/Grok Bot.app";

// ---------------------------------------------------------------- asar (read-only)

/// Read-only view of an Electron asar archive: `[u32 4][u32 header pickle size][u32 payload]
/// [u32 json length][json…]`, then file data at `8 + header pickle size + offset`. Files marked
/// `unpacked` live in `app.asar.unpacked/`.
pub struct Asar {
    file: File,
    path: PathBuf,
    header: Value,
    base: u64,
}

impl Asar {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|e| format!("can't open the archive ({})", e.kind()))?;
        let mut pre = [0u8; 16];
        file.read_exact(&mut pre).map_err(|_| "not an asar archive".to_string())?;
        let u = |i: usize| u32::from_le_bytes([pre[i], pre[i + 1], pre[i + 2], pre[i + 3]]) as u64;
        let (pickle, json_len) = (u(4), u(12));
        if u(0) != 4 || json_len > pickle || json_len > MAX_FILE {
            return Err("not an asar archive".into());
        }
        let mut json = vec![0u8; json_len as usize];
        file.read_exact(&mut json).map_err(|_| "truncated asar header".to_string())?;
        let header = serde_json::from_slice(&json).map_err(|_| "bad asar header".to_string())?;
        Ok(Self { file, path: path.to_path_buf(), header, base: 8 + pickle })
    }

    fn node(&self, p: &str) -> Option<&Value> {
        p.split('/').try_fold(&self.header, |n, part| n.get("files")?.get(part))
    }

    pub fn list(&self, dir: &str) -> Vec<String> {
        let mut v: Vec<String> = self.node(dir).and_then(|n| n.get("files")).and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        v.sort();
        v
    }

    /// The file's bytes (None if it isn't a regular file in the archive). Err on a failed
    /// integrity check or a broken archive.
    pub fn read(&mut self, p: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(n) = self.node(p).cloned() else { return Ok(None) };
        if n.get("files").is_some() || n.get("link").is_some() {
            return Ok(None);
        }
        let size = n.get("size").and_then(Value::as_u64).ok_or("bad asar entry")?;
        if size > MAX_FILE {
            return Err(format!("{p} is too big"));
        }
        let buf = if n.get("unpacked").and_then(Value::as_bool) == Some(true) {
            let mut unpacked = self.path.clone().into_os_string();
            unpacked.push(".unpacked");
            fs::read(Path::new(&unpacked).join(p)).map_err(|_| format!("can't read unpacked {p}"))?
        } else {
            // asar stores offsets as strings (they can exceed 2^53).
            let off: u64 = match n.get("offset") {
                Some(Value::String(s)) => s.parse().map_err(|_| "bad asar offset")?,
                Some(v) => v.as_u64().ok_or("bad asar offset")?,
                None => return Err("bad asar offset".into()),
            };
            let mut buf = vec![0u8; size as usize];
            self.file.seek(SeekFrom::Start(self.base + off)).map_err(|_| "bad asar offset")?;
            self.file.read_exact(&mut buf).map_err(|_| format!("truncated {p}"))?;
            buf
        };
        if let Some(i) = n.get("integrity") {
            if i.get("algorithm").and_then(Value::as_str) == Some("SHA256") {
                if let Some(want) = i.get("hash").and_then(Value::as_str) {
                    if !hex(&Sha256::digest(&buf)).eq_ignore_ascii_case(want) {
                        return Err(format!("integrity check failed for {p}"));
                    }
                }
            }
        }
        Ok(Some(buf))
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------- palette

fn norm_hex(v: &str) -> Option<String> {
    let h = v.trim_start_matches('#');
    let six: String = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect() } else { h.chars().take(6).collect() };
    (six.len() == 6 && six.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{}", six.to_ascii_uppercase()))
}

/// The app's avatar colour list, `[{id:"black",label:"Black",value:"#000"}, …]` (any quote
/// style): what it tints the tray face strips with. At least two colours, starting with black.
pub fn find_avatar_palette(src: &str) -> Option<Map<String, Value>> {
    let q = "[\"'`]";
    let item = |id: &str, hexp: &str| format!(r"\{{id:{q}{id}{q},label:{q}[^\x22'`]{{0,40}}{q},value:{q}{hexp}{q}\}}");
    let any = item("[a-z]+", "#[0-9A-Fa-f]{3,8}");
    let list = Regex::new(&format!(r"\[{}(?:,{any})+\]", item("black", "#[0-9A-Fa-f]{3,8}"))).ok()?;
    let entry = Regex::new(&item("([a-z]+)", "(#[0-9A-Fa-f]{3,8})")).ok()?;
    let m = list.find(src)?;
    let mut colors = Map::new();
    for c in entry.captures_iter(m.as_str()) {
        if let Some(h) = norm_hex(&c[2]) {
            colors.insert(c[1].to_string(), json!(h));
        }
    }
    (colors.len() >= 2).then_some(colors)
}

/// Fallback only: `--x-<color>-500: #hex` design tokens from the renderer CSS.
pub fn find_css_var_palette(src: &str) -> Option<Map<String, Value>> {
    let mut colors = Map::new();
    for c in COLORS {
        let re = Regex::new(&format!(r"--x-{c}-500\s*:\s*(#[0-9A-Fa-f]{{3,8}})")).ok()?;
        if let Some(h) = re.captures(src).and_then(|m| norm_hex(&m[1])) {
            colors.insert(c.to_string(), json!(h));
        }
    }
    colors.entry("black").or_insert(json!("#000000"));
    (colors.len() > 1).then_some(colors)
}

fn extract_palette(src: &mut Asar) -> Result<Option<Value>, String> {
    let files = src.list(RENDERER);
    let mut js: Vec<&String> = files.iter().filter(|f| f.ends_with(".js")).collect();
    // Most likely homes first (the eager bundles and avatar chunks), then everything else.
    let rank = |f: &str| if f.starts_with("index.eager") { 0 } else if f.contains("avatar") || f.contains("brand-marks") { 1 } else { 2 };
    js.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a.cmp(b)));
    let found = |colors, source: &str, file: String| Some(json!({"source": source, "file": file, "colors": colors}));
    for f in js {
        let p = format!("{RENDERER}/{f}");
        let Some(buf) = src.read(&p)? else { continue };
        let s = String::from_utf8_lossy(&buf);
        if !s.contains("label:") {
            continue;
        }
        if let Some(c) = find_avatar_palette(&s) {
            return Ok(found(c, "avatar-color-list", p));
        }
    }
    for f in src.list(MAIN).into_iter().filter(|f| f.ends_with(".cjs")) {
        let p = format!("{MAIN}/{f}");
        if let Some(c) = src.read(&p)?.and_then(|b| find_avatar_palette(&String::from_utf8_lossy(&b))) {
            return Ok(found(c, "avatar-color-list", p));
        }
    }
    for f in files.iter().filter(|f| f.ends_with(".css")) {
        let p = format!("{RENDERER}/{f}");
        if let Some(c) = src.read(&p)?.and_then(|b| find_css_var_palette(&String::from_utf8_lossy(&b))) {
            return Ok(found(c, "css-var-500", p));
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------- import

/// (width, height) from a PNG's IHDR.
pub fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || b[..8] != [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] || &b[12..16] != b"IHDR" {
        return None;
    }
    let be = |i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    Some((be(16), be(20)))
}

/// Names a pet window may ask for: the manifest's strips, nothing else.
pub fn file_name_ok(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("bot-") else { return false };
    let shape = rest.strip_suffix("-face@2x.png").or_else(|| rest.strip_suffix("-face.png"));
    shape.is_some_and(|s| SHAPES.contains(&s))
}

/// What the copy was made from; a different value means Grok Bot changed.
pub fn source_stamp(asar: &Path, app_version: Option<&str>) -> Option<Value> {
    let m = fs::metadata(asar).ok()?;
    let mtime = m.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some(json!({"size": m.len(), "modified": mtime, "appVersion": app_version}))
}

/// Copied files: (name, bytes).
pub type Files = Vec<(String, Vec<u8>)>;

/// Read the strips and palette out of an archive: (manifest, files).
pub fn import_from(src: &mut Asar, source: Value) -> Result<(Value, Files), String> {
    let mut files = Vec::new();
    let mut shapes = Map::new();
    for shape in SHAPES {
        let mut entry = Map::new();
        for (res, name) in [("2x", format!("bot-{shape}-face@2x.png")), ("1x", format!("bot-{shape}-face.png"))] {
            let Some(buf) = src.read(&format!("{TRAY}/{name}"))? else { continue };
            // A strip is N square frames side by side.
            let Some((w, h)) = png_size(&buf).filter(|&(w, h)| h >= 8 && w % h == 0) else { continue };
            entry.insert(res.into(), json!({"file": name, "frameSize": h, "frames": w / h}));
            files.push((name, buf));
        }
        if !entry.is_empty() {
            shapes.insert(shape.into(), Value::Object(entry));
        }
    }
    if shapes.is_empty() {
        return Err("no avatar strips found in Grok Bot".into());
    }
    let manifest = json!({
        "version": 1,
        "note": "Copied by Desk Pet from your own Grok Bot app. Grok Bot's art, not Desk Pet's: not for redistribution.",
        "source": source,
        "shapes": shapes,
        "palette": extract_palette(src)?,
    });
    Ok((manifest, files))
}

/// Write the copy into `dir` (replacing what was there), via a temporary sibling directory.
pub fn write_dir(dir: &Path, manifest: &Value, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    let tmp = dir.with_extension("tmp");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| format!("can't write the art ({})", e.kind()))?;
    for (name, buf) in files {
        fs::write(tmp.join(name), buf).map_err(|e| format!("can't write the art ({})", e.kind()))?;
    }
    fs::write(tmp.join(MANIFEST), format!("{manifest:#}\n")).map_err(|e| format!("can't write the art ({})", e.kind()))?;
    let _ = fs::remove_dir_all(dir);
    fs::rename(&tmp, dir).map_err(|e| format!("can't write the art ({})", e.kind()))
}

fn read_manifest(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(dir.join(MANIFEST)).ok()?).ok()
}

/// Where Grok Bot is: whatever app handles `grokbot:` links, else /Applications/Grok Bot.app.
/// `GROKBOT_APP` overrides it (tests, unusual installs).
fn grokbot_app() -> PathBuf {
    if let Some(p) = std::env::var_os("GROKBOT_APP") {
        return PathBuf::from(p);
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSString, NSURL};
        if let Some(url) = NSURL::URLWithString(&NSString::from_str(crate::grokbot::APP_URL)) {
            if let Some(app) = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&url) {
                if let Some(p) = app.path() {
                    return PathBuf::from(p.to_string());
                }
            }
        }
    }
    PathBuf::from(DEFAULT_APP)
}

fn app_version(app: &Path) -> Option<String> {
    let plist = fs::read_to_string(app.join("Contents/Info.plist")).ok()?;
    let re = Regex::new(r"<key>CFBundleShortVersionString</key>\s*<string>([^<]{1,32})</string>").ok()?;
    re.captures(&plist).map(|c| c[1].to_string())
}

pub enum Outcome {
    /// The copy matches the installed Grok Bot.
    UpToDate,
    Imported { shapes: usize, palette: bool },
    /// Grok Bot isn't installed: an older copy (if any) stays in use.
    NoGrokBot { cached: bool },
}

/// Make `<data dir>/grokbot-art` match the installed Grok Bot.
pub fn ensure(app_path: &Path, dir: &Path) -> Result<Outcome, String> {
    let asar = app_path.join("Contents/Resources/app.asar");
    let version = app_version(app_path);
    let Some(stamp) = source_stamp(&asar, version.as_deref()) else {
        return Ok(Outcome::NoGrokBot { cached: read_manifest(dir).is_some() });
    };
    if read_manifest(dir).is_some_and(|m| m.get("source") == Some(&stamp)) {
        return Ok(Outcome::UpToDate);
    }
    let mut src = Asar::open(&asar)?;
    let (manifest, files) = import_from(&mut src, stamp)?;
    write_dir(dir, &manifest, &files)?;
    Ok(Outcome::Imported {
        shapes: manifest["shapes"].as_object().map_or(0, |m| m.len()),
        palette: !manifest["palette"].is_null(),
    })
}

// ---------------------------------------------------------------- app glue

/// The art directory once it holds a usable copy.
#[derive(Default)]
pub struct ArtState(Mutex<Option<PathBuf>>);

/// Start-up: bring the copy up to date in the background, then tell every window.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Ok(dir) = app.path().app_data_dir().map(|d| d.join(DIR)) else { return };
        let grokbot = grokbot_app();
        let ready = match ensure(&grokbot, &dir) {
            Ok(Outcome::UpToDate) => true,
            Ok(Outcome::Imported { shapes, palette }) => {
                log_line(&app, &format!("avatar art: copied {shapes} shapes from Grok Bot (palette: {})", if palette { "yes" } else { "no" }));
                true
            }
            Ok(Outcome::NoGrokBot { cached }) => {
                log_line(&app, if cached { "avatar art: Grok Bot not found; using the earlier copy" } else { "avatar art: Grok Bot not found; bots are drawn as robots" });
                cached
            }
            Err(e) => {
                let cached = read_manifest(&dir).is_some();
                log_line(&app, &format!("avatar art: couldn't read Grok Bot ({e}){}", if cached { "; using the earlier copy" } else { "" }));
                cached
            }
        };
        if ready {
            *app.state::<ArtState>().0.locked() = Some(dir);
            let _ = app.emit("art:ready", ());
        }
    });
}

fn art_dir(st: &State<'_, ArtState>) -> Option<PathBuf> {
    st.0.locked().clone()
}

/// The art manifest (shapes, frame sizes, palette), or null while there is no copy.
#[tauri::command]
pub fn grokbot_art_manifest(st: State<'_, ArtState>) -> Option<Value> {
    art_dir(&st).and_then(|d| read_manifest(&d))
}

/// One strip's PNG bytes (an ArrayBuffer in the webview).
#[tauri::command]
pub fn grokbot_art_file(st: State<'_, ArtState>, name: String) -> Result<tauri::ipc::Response, String> {
    if !file_name_ok(&name) {
        return Err("not an avatar strip".into());
    }
    let dir = art_dir(&st).ok_or("no avatar art")?;
    fs::read(dir.join(&name)).map(tauri::ipc::Response::new).map_err(|_| "no such strip".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny PNG header: enough for png_size (the pixels are never decoded here).
    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    /// Build an asar: `files` are (path, bytes, integrity ok?).
    fn asar(dir: &Path, files: &[(&str, Vec<u8>, bool)]) -> PathBuf {
        let mut root = json!({"files": {}});
        let mut data = Vec::new();
        for (path, bytes, ok) in files {
            let mut n = &mut root;
            let parts: Vec<&str> = path.split('/').collect();
            for part in &parts[..parts.len() - 1] {
                n = n["files"].as_object_mut().unwrap().entry(*part).or_insert(json!({"files": {}}));
            }
            let hash = if *ok { hex(&Sha256::digest(bytes)) } else { "00".repeat(32) };
            n["files"][parts[parts.len() - 1]] =
                json!({"size": bytes.len(), "offset": data.len().to_string(), "integrity": {"algorithm": "SHA256", "hash": hash}});
            data.extend_from_slice(bytes);
        }
        let json = serde_json::to_vec(&root).unwrap();
        let padded = json.len().div_ceil(4) * 4;
        let pickle = 8 + padded as u32;
        let mut out = Vec::new();
        for v in [4u32, pickle, pickle - 4, json.len() as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&json);
        out.resize(8 + pickle as usize, 0);
        out.extend_from_slice(&data);
        let p = dir.join("app.asar");
        fs::write(&p, out).unwrap();
        p
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("deskpet-art-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    const PALETTE_JS: &str = r##"x=[{id:"black",label:"Black",value:"#000"},{id:'red',label:'Red',value:'#FF3B30'},{id:`gray`,label:`Gray`,value:`#8e8e93`}];"##;

    #[test]
    fn palette_from_the_avatar_colour_list_or_css_vars() {
        let c = find_avatar_palette(&format!("var a=1;{PALETTE_JS}")).unwrap();
        assert_eq!(c["black"], "#000000");
        assert_eq!(c["red"], "#FF3B30");
        assert_eq!(c["gray"], "#8E8E93");
        assert!(find_avatar_palette(r##"[{id:"red",label:"Red",value:"#f00"},{id:"black",label:"B",value:"#000"}]"##).is_none(), "must start with black");
        assert!(find_avatar_palette(r##"[{id:"black",label:"Black",value:"#000"}]"##).is_none(), "needs two");
        let css = find_css_var_palette(":root{--x-red-500: #ff0000;--x-blue-500:#00F}").unwrap();
        assert_eq!((css["red"].as_str(), css["blue"].as_str(), css["black"].as_str()), (Some("#FF0000"), Some("#0000FF"), Some("#000000")));
    }

    #[test]
    fn imports_strips_and_palette_and_checks_integrity() {
        let d = tmpdir("import");
        let mut files: Vec<(String, Vec<u8>, bool)> = vec![];
        for s in ["blob", "heart"] {
            files.push((format!("{TRAY}/bot-{s}-face@2x.png"), png(36 * 29, 36), true));
            files.push((format!("{TRAY}/bot-{s}-face.png"), png(18 * 29, 18), true));
        }
        files.push((format!("{TRAY}/bot-star-face@2x.png"), png(100, 36), true)); // not square frames: skipped
        files.push((format!("{RENDERER}/index.eager-abc.js"), format!("label:{PALETTE_JS}").into_bytes(), true));
        let refs: Vec<(&str, Vec<u8>, bool)> = files.iter().map(|(p, b, ok)| (p.as_str(), b.clone(), *ok)).collect();
        let a = asar(&d, &refs);
        let mut src = Asar::open(&a).unwrap();
        let (m, out) = import_from(&mut src, json!({"size": 1})).unwrap();
        assert_eq!(m["shapes"].as_object().unwrap().len(), 2);
        assert_eq!(m["shapes"]["blob"]["2x"], json!({"file": "bot-blob-face@2x.png", "frameSize": 36, "frames": 29}));
        assert_eq!(m["palette"]["source"], "avatar-color-list");
        assert_eq!(m["palette"]["colors"]["red"], "#FF3B30");
        assert_eq!(out.len(), 4);

        let art = d.join(DIR);
        write_dir(&art, &m, &out).unwrap();
        assert_eq!(read_manifest(&art).unwrap()["shapes"], m["shapes"]);
        assert!(art.join("bot-heart-face.png").exists());
        assert!(!art.with_extension("tmp").exists());

        // A tampered file fails the integrity check instead of being copied.
        let bad = asar(&d, &[(&format!("{TRAY}/bot-blob-face@2x.png"), png(36, 36), false)]);
        let e = import_from(&mut Asar::open(&bad).unwrap(), json!({})).unwrap_err();
        assert!(e.contains("integrity"), "{e}");
        assert!(Asar::open(&art.join("bot-heart-face.png")).is_err(), "a PNG is not an asar");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn ensure_imports_once_then_again_when_grokbot_changes() {
        let d = tmpdir("ensure");
        let app = d.join("Grok Bot.app");
        let res = app.join("Contents/Resources");
        fs::create_dir_all(&res).unwrap();
        fs::write(app.join("Contents/Info.plist"), "<key>CFBundleShortVersionString</key>\n<string>1.2.0</string>").unwrap();
        let tray = |n: u32| vec![(format!("{TRAY}/bot-blob-face@2x.png"), png(36 * n, 36), true)];
        let build = |files: Vec<(String, Vec<u8>, bool)>| {
            let refs: Vec<(&str, Vec<u8>, bool)> = files.iter().map(|(p, b, ok)| (p.as_str(), b.clone(), *ok)).collect();
            let a = asar(&d, &refs);
            fs::rename(a, res.join("app.asar")).unwrap();
        };
        build(tray(29));
        let art = d.join(DIR);
        assert!(matches!(ensure(&app, &art), Ok(Outcome::Imported { shapes: 1, palette: false })));
        assert!(matches!(ensure(&app, &art), Ok(Outcome::UpToDate)));
        assert_eq!(read_manifest(&art).unwrap()["source"]["appVersion"], "1.2.0");
        let mut update = tray(30); // Grok Bot updated: a different (and bigger) archive
        update.push((format!("{RENDERER}/index.eager-new.js"), b"label:none".to_vec(), true));
        build(update);
        assert!(matches!(ensure(&app, &art), Ok(Outcome::Imported { .. })));
        assert_eq!(read_manifest(&art).unwrap()["shapes"]["blob"]["2x"]["frames"], 30);
        // Uninstalled: the copy stays usable.
        fs::remove_dir_all(&app).unwrap();
        assert!(matches!(ensure(&app, &art), Ok(Outcome::NoGrokBot { cached: true })));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn only_strip_names_are_served() {
        assert!(file_name_ok("bot-blob-face@2x.png"));
        assert!(file_name_ok("bot-squircle-face.png"));
        for bad in ["manifest.json", "bot-dragon-face.png", "../bot-blob-face.png", "bot-blob-face.png/..", "bot-blob-face@3x.png", "/etc/passwd", "bot--face.png", ""] {
            assert!(!file_name_ok(bad), "{bad}");
        }
    }

    /// Against the real Grok Bot on this Mac: `cargo test real_grokbot -- --ignored`.
    #[test]
    #[ignore]
    fn real_grokbot_import() {
        let app = grokbot_app();
        let d = tmpdir("real");
        match ensure(&app, &d.join(DIR)).unwrap() {
            Outcome::Imported { shapes, palette } => {
                eprintln!("real Grok Bot at {}: {shapes} shapes, palette {palette}", app.display());
                assert_eq!(shapes, 26);
                assert!(palette);
                let m = read_manifest(&d.join(DIR)).unwrap();
                assert_eq!(m["palette"]["colors"].as_object().unwrap().len(), 11, "{}", m["palette"]);
                eprintln!("PALETTE {}", m["palette"]["colors"]);
            }
            _ => panic!("Grok Bot not found at {}", app.display()),
        }
        let _ = fs::remove_dir_all(&d);
    }
}
