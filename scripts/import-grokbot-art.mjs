#!/usr/bin/env node
// Copies the Grok Bot avatar art (the 26 tray face strips, @2x and @1x) and the avatar colour palette out of the
// locally installed Grok Bot app into desktop/public/grokbot-art/ for the BROWSER PREVIEW
// (`npm run dev`, preview.html). The app itself copies the art at runtime from the user's own
// Grok Bot (desktop/src-tauri/src/grokbot_art.rs, same logic); builds never contain it.
//
// The copied art and palette are Grok Bot's, not ours: the output directory is gitignored and
// must never be committed or redistributed. The desk pet works without it (bots fall back to the
// original robot art), so this script never fails a build unless --strict is given.
//
// Reads app.asar read-only (no extraction, no dependencies) and checks each file's SHA-256
// against the asar integrity record.
//
// Usage:
//   node scripts/import-grokbot-art.mjs [--app "/Applications/Grok Bot.app"] [--out dir]
//                                       [--from-dir <extracted asar root>] [--strict] [--quiet]
//   env GROKBOT_APP overrides the default app path.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const SHAPES = [
  "arch", "bean", "blob", "capsule", "cloud", "clover", "crystal", "cylinder", "dome", "egg", "flower", "gem", "heart",
  "hex", "house", "leaf", "pebble", "pumpkin", "shield", "sparkle", "square", "squircle", "star", "tablet", "teardrop",
  "wedge",
];
export const COLORS = ["black", "brown", "red", "orange", "yellow", "green", "cyan", "blue", "violet", "magenta", "gray"];
const TRAY = "dist/electron-main/menubar-tray/assets";
const RENDERER = "dist/renderer/assets";

function parseArgs(argv) {
  const a = { app: process.env.GROKBOT_APP || "/Applications/Grok Bot.app", out: join(ROOT, "desktop/public/grokbot-art"), fromDir: null, strict: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--app") a.app = argv[++i];
    else if (k === "--out") a.out = resolve(argv[++i]);
    else if (k === "--from-dir") a.fromDir = resolve(argv[++i]);
    else if (k === "--strict") a.strict = true;
    else if (k === "--quiet") a.quiet = true;
    else if (k === "-h" || k === "--help") {
      console.log("usage: import-grokbot-art.mjs [--app <Grok Bot.app>] [--out <dir>] [--from-dir <asar root>] [--strict] [--quiet]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

// ---------- asar reader (read-only) ----------
// Layout: [u32 4][u32 headerPickleSize] [u32 payload][u32 jsonLen][json...] then file data at
// 8 + headerPickleSize + offset. Files marked "unpacked" live in app.asar.unpacked/.
export function openAsar(path) {
  const fd = openSync(path, "r");
  const pre = Buffer.alloc(16);
  readSync(fd, pre, 0, 16, 0);
  const headerPickle = pre.readUInt32LE(4);
  const jsonLen = pre.readUInt32LE(12);
  if (pre.readUInt32LE(0) !== 4 || jsonLen > headerPickle || jsonLen > 64 * 1024 * 1024) {
    closeSync(fd);
    throw new Error("not an asar archive");
  }
  const json = Buffer.alloc(jsonLen);
  readSync(fd, json, 0, jsonLen, 16);
  const header = JSON.parse(json.toString("utf8"));
  const base = 8 + headerPickle;
  const node = (p) => {
    let n = header;
    for (const part of p.split("/")) {
      n = n?.files?.[part];
      if (!n) return null;
    }
    return n;
  };
  return {
    list(dir) {
      const n = node(dir);
      return n?.files ? Object.keys(n.files) : [];
    },
    read(p) {
      const n = node(p);
      if (!n || n.files || n.link) return null;
      let buf;
      if (n.unpacked) buf = readFileSync(join(`${path}.unpacked`, p));
      else {
        buf = Buffer.alloc(n.size);
        readSync(fd, buf, 0, n.size, base + Number(n.offset));
      }
      const want = n.integrity?.hash;
      if (want && n.integrity.algorithm === "SHA256" && createHash("sha256").update(buf).digest("hex") !== want) {
        throw new Error(`integrity check failed for ${p}`);
      }
      return buf;
    },
    close() {
      closeSync(fd);
    },
  };
}

function openDir(root) {
  return {
    list: (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : []),
    read: (p) => (existsSync(join(root, p)) && statSync(join(root, p)).isFile() ? readFileSync(join(root, p)) : null),
    close() {},
  };
}

// ---------- palette ----------
function normHex(v) {
  const h = v.replace(/^#/, "");
  const six = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(six) ? `#${six.toUpperCase()}` : null;
}

/**
 * The app's avatar colour list: `[{id:"black",label:"Black",value:"#000"}, ...]` (any quote
 * style). It's what the app uses both to tint the tray face strips and for avatar colours in the
 * renderer. Returns {colors: {id: "#RRGGBB"}} or null.
 */
export function findAvatarPalette(src) {
  const q = "[\"'`]";
  const item = (id, hex) => `\\{id:${q}${id}${q},label:${q}[^"'\`]{0,40}${q},value:${q}${hex}${q}\\}`;
  const entry = item("([a-z]+)", "(#[0-9A-Fa-f]{3,8})");
  const any = item("[a-z]+", "#[0-9A-Fa-f]{3,8}");
  // The list starts with black (the default avatar colour) and has at least one more entry.
  const list = new RegExp(`\\[${item("black", "#[0-9A-Fa-f]{3,8}")}(?:,${any})+\\]`);
  const m = list.exec(src);
  if (!m) return null;
  const colors = {};
  for (const e of m[0].matchAll(new RegExp(entry, "g"))) {
    const hex = normHex(e[2]);
    if (hex) colors[e[1]] = hex;
  }
  return Object.keys(colors).length >= 2 ? { colors } : null;
}

/** Fallback only: `--x-<color>-500: #hex` design tokens from the renderer CSS. */
export function findCssVarPalette(src) {
  const colors = {};
  for (const c of COLORS) {
    const m = new RegExp(`--x-${c}-500\\s*:\\s*(#[0-9A-Fa-f]{3,8})`).exec(src);
    if (m && normHex(m[1])) colors[c] = normHex(m[1]);
  }
  if (!colors.black) colors.black = "#000000";
  return Object.keys(colors).length > 1 ? { colors } : null;
}

function extractPalette(src, log) {
  const files = src.list(RENDERER);
  const js = files.filter((f) => f.endsWith(".js"));
  // Most likely homes first (the eager bundles and avatar chunks), then everything else.
  const rank = (f) => (/^index\.eager/.test(f) ? 0 : /avatar|brand-marks/.test(f) ? 1 : 2);
  js.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const f of js) {
    const buf = src.read(`${RENDERER}/${f}`);
    if (!buf || !buf.includes("label:")) continue;
    const p = findAvatarPalette(buf.toString("utf8"));
    if (p) return { ...p, source: "avatar-color-list", file: `${RENDERER}/${f}` };
  }
  // Same list as used by the tray tinting code in the main process.
  for (const f of src.list("dist/electron-main").filter((x) => x.endsWith(".cjs"))) {
    const buf = src.read(`dist/electron-main/${f}`);
    const p = buf && findAvatarPalette(buf.toString("utf8"));
    if (p) return { ...p, source: "avatar-color-list", file: `dist/electron-main/${f}` };
  }
  log("avatar colour list not found; falling back to --x-<color>-500 CSS variables");
  for (const f of files.filter((x) => x.endsWith(".css"))) {
    const buf = src.read(`${RENDERER}/${f}`);
    const p = buf && findCssVarPalette(buf.toString("utf8"));
    if (p) return { ...p, source: "css-var-500", file: `${RENDERER}/${f}` };
  }
  return null;
}

// ---------- PNG header ----------
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------- main ----------
export function importArt(opts, log = console.log) {
  let src;
  let appVersion = null;
  if (opts.fromDir) {
    src = openDir(opts.fromDir);
  } else {
    const asar = join(opts.app, "Contents/Resources/app.asar");
    if (!existsSync(asar)) return { ok: false, reason: `Grok Bot app not found at ${opts.app}` };
    src = openAsar(asar);
    try {
      const plist = readFileSync(join(opts.app, "Contents/Info.plist"), "utf8");
      appVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,32})<\/string>/.exec(plist)?.[1] ?? null;
    } catch {
      /* version is informational */
    }
  }
  try {
    const files = {};
    const shapes = {};
    for (const shape of SHAPES) {
      const entry = {};
      for (const [res, name] of [["2x", `bot-${shape}-face@2x.png`], ["1x", `bot-${shape}-face.png`]]) {
        const buf = src.read(`${TRAY}/${name}`);
        const size = buf && pngSize(buf);
        // A strip is N square frames side by side.
        if (!size || size.height < 8 || size.width % size.height !== 0) continue;
        files[name] = buf;
        entry[res] = { file: name, frameSize: size.height, frames: size.width / size.height };
      }
      if (entry["2x"] || entry["1x"]) shapes[shape] = entry;
      else log(`  missing strip for ${shape}`);
    }
    if (Object.keys(shapes).length === 0) return { ok: false, reason: "no avatar strips found in the app" };
    const palette = extractPalette(src, log);
    if (!palette) log("  no palette found; the desk pet will use its own approximate colours");

    rmSync(opts.out, { recursive: true, force: true });
    mkdirSync(opts.out, { recursive: true });
    for (const [name, buf] of Object.entries(files)) writeFileSync(join(opts.out, name), buf);
    const manifest = {
      version: 1,
      note: "Copied from the locally installed Grok Bot app by scripts/import-grokbot-art.mjs. Not ours: do not commit or redistribute.",
      appVersion,
      importedAt: new Date().toISOString(),
      // Frame order of every strip (the app's tray face table).
      frameOrder: [
        "rest", "blink-close", "blink-close(half)", "blink-close", "blink-close(closed)", "blink-open", "blink-open", "blink-open(overshoot)",
        "glance-left-in x3", "glance-left-hold", "glance-left-out x3",
        "glance-right-in x3", "glance-right-hold", "glance-right-out x3",
        "glance-up-in x3", "glance-up-hold", "glance-up-out x3",
      ],
      shapes,
      palette: palette ? { source: palette.source, file: palette.file, colors: palette.colors } : null,
    };
    writeFileSync(join(opts.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true, shapes: Object.keys(shapes).length, files: Object.keys(files).length, palette: manifest.palette, out: opts.out };
  } finally {
    src.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const log = opts.quiet ? () => {} : (m) => console.log(m);
  let r;
  try {
    r = importArt(opts, log);
  } catch (e) {
    r = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (r.ok) {
    log(`grokbot-art: ${r.shapes} shapes, ${r.files} files -> ${r.out}`);
    log(`grokbot-art: palette ${r.palette ? `${Object.keys(r.palette.colors).length} colours from ${r.palette.source} (${r.palette.file})` : "missing"}`);
  } else {
    console.warn(`grokbot-art: skipped (${r.reason}). The desk pet will use its fallback robot art.`);
    if (opts.strict) process.exit(1);
  }
}
