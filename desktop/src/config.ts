import type { PetSize } from "./layout.ts";
import type { PairMode } from "./connections.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl, validateRelayUrl } from "./net.ts";

// App configuration: shipped defaults (public/deskpet.config.json) + local overrides from the
// settings panel (localStorage). In dev builds the idle->sleeping timeout is short.

export interface DeskPetConfig {
  relayUrl: string;
  /** What "Connect your Grok Bot" creates: v2 private mailbox (default) or a v1 relay code. */
  pairMode: PairMode;
  /** v2 mailbox base URL used for the next new code (ntfy.sh or a self-hosted ntfy). */
  mailboxUrl: string;
  openUrls: { default: string; agents: Record<string, string> };
  accents: Record<string, string>;
  sleepAfterMs: number;
  staleActiveMs: number;
  toastMs: number;
  /** Layout prefs (persisted): preferred pet size and the remembered left-to-right order. */
  petSize: PetSize;
  petOrder: string[];
}

const SETTINGS_KEY = "deskpet.settings";

export const DEFAULTS: DeskPetConfig = {
  relayUrl: "http://127.0.0.1:8787",
  pairMode: "v2",
  mailboxUrl: DEFAULT_MAILBOX,
  openUrls: { default: "https://grok.com", agents: {} },
  accents: {},
  sleepAfterMs: import.meta.env.DEV ? 30_000 : 5 * 60_000,
  staleActiveMs: 10 * 60_000,
  toastMs: 5000,
  petSize: "large",
  petOrder: [],
};

export type Settings = Partial<Pick<DeskPetConfig, "relayUrl" | "pairMode" | "mailboxUrl" | "openUrls" | "petSize" | "petOrder">>;

function readSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Settings;
  } catch {
    return {};
  }
}

/** Merge into the saved settings (only non-secret preferences live here). */
export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...s }));
}

export async function loadConfig(): Promise<DeskPetConfig> {
  let file: Partial<DeskPetConfig> = {};
  try {
    const r = await fetch("deskpet.config.json", { cache: "no-store" });
    if (r.ok) file = (await r.json()) as Partial<DeskPetConfig>;
  } catch {
    /* use defaults */
  }
  const cfg: DeskPetConfig = {
    ...DEFAULTS,
    ...file,
    openUrls: { ...DEFAULTS.openUrls, ...(file.openUrls ?? {}) },
    accents: { ...(file.accents ?? {}) },
  };
  if (import.meta.env.DEV) cfg.sleepAfterMs = Math.min(cfg.sleepAfterMs, DEFAULTS.sleepAfterMs);
  const s = readSettings();
  if (s.relayUrl) cfg.relayUrl = s.relayUrl;
  if (s.pairMode === "v1" || s.pairMode === "v2") cfg.pairMode = s.pairMode;
  if (s.mailboxUrl) cfg.mailboxUrl = s.mailboxUrl;
  if (s.openUrls) cfg.openUrls = { default: s.openUrls.default || cfg.openUrls.default, agents: { ...cfg.openUrls.agents, ...s.openUrls.agents } };
  if (s.petSize === "large" || s.petSize === "small") cfg.petSize = s.petSize;
  if (Array.isArray(s.petOrder)) cfg.petOrder = s.petOrder.filter((x) => typeof x === "string").slice(0, 64);
  const v = validateRelayUrl(cfg.relayUrl);
  cfg.relayUrl = v.ok ? v.url : DEFAULTS.relayUrl;
  const mb = validateMailboxUrl(cfg.mailboxUrl);
  cfg.mailboxUrl = mb.ok ? mb.url : DEFAULTS.mailboxUrl;
  return cfg;
}

/** Only http(s) URLs are ever opened. */
export function safeUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch {
    return null;
  }
}

export function urlForAgent(cfg: DeskPetConfig, agentId: string): string {
  return safeUrl(cfg.openUrls.agents[agentId]) ?? safeUrl(cfg.openUrls.default) ?? "https://grok.com";
}

// ---- local pairing state (NOT the token) ----
// The relay token lives in the macOS Keychain, handled entirely by the Rust side (see
// src-tauri/src/secrets.rs); the webview never sees it. In the browser prototype (vite, no
// Tauri) it is held in memory only, so a reload means pairing again.
// Stored here: the pending code shown on screen (short-lived) and a "paired" hint for boot.
const LEGACY_TOKEN_KEY = "deskpet.token"; // M0 kept the token here; migrated + deleted on boot
const PENDING_KEY = "deskpet.pending";
const PAIRED_KEY = "deskpet.paired";

export const pairingState = {
  pending(): { code: string; expires_at: string } | null {
    try {
      return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
    } catch {
      return null;
    }
  },
  setPending(p: { code: string; expires_at: string } | null): void {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(PENDING_KEY);
  },
  paired(): boolean {
    return localStorage.getItem(PAIRED_KEY) === "1";
  },
  setPaired(v: boolean): void {
    if (v) localStorage.setItem(PAIRED_KEY, "1");
    else localStorage.removeItem(PAIRED_KEY);
  },
  clear(): void {
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(PAIRED_KEY);
  },
};

// ---- v2 (mailbox) pairing state, NOT the secret ----
// The dp2 pairing string (topic + key) lives in the Keychain (Rust, src-tauri/src/secrets.rs).
// Stored here only: whether a bot has posted on the current v2 pairing yet.
const V2_SEEN_KEY = "deskpet.v2.seen";

export const v2State = {
  seen(): boolean {
    return localStorage.getItem(V2_SEEN_KEY) === "1";
  },
  setSeen(v: boolean): void {
    if (v) localStorage.setItem(V2_SEEN_KEY, "1");
    else localStorage.removeItem(V2_SEEN_KEY);
  },
};

/** Remove and return an M0-era token from localStorage, if one is still there. */
export function takeLegacyToken(): string | null {
  const t = localStorage.getItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  return t && /^[A-Za-z0-9_-]{16,256}$/.test(t) ? t : null;
}
