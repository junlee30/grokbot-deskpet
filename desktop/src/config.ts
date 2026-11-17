import type { PetSize } from "./layout.ts";
import { migrateSettings, OLD_V1_KEYS } from "./connections.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "./net.ts";

// App configuration: shipped defaults (public/deskpet.config.json) + local overrides from the
// settings panel (localStorage). In dev builds the idle->sleeping timeout is short.

export interface DeskPetConfig {
  /** v2 mailbox base URL used for the next new code (ntfy.sh or a self-hosted ntfy). */
  mailboxUrl: string;
  openUrls: { default: string; agents: Record<string, string> };
  accents: Record<string, string>;
  sleepAfterMs: number;
  staleActiveMs: number;
  toastMs: number;
  /** Pet size (persisted); each bot's window is sized for it (layout.ts petWindowSize). */
  petSize: PetSize;
}

const SETTINGS_KEY = "deskpet.settings";

export const DEFAULTS: DeskPetConfig = {
  mailboxUrl: DEFAULT_MAILBOX,
  openUrls: { default: "https://grok.com", agents: {} },
  accents: {},
  sleepAfterMs: import.meta.env.DEV ? 30_000 : 5 * 60_000,
  staleActiveMs: 10 * 60_000,
  toastMs: 5000,
  petSize: "large",
};

export type Settings = Partial<Pick<DeskPetConfig, "mailboxUrl" | "openUrls" | "petSize">>;

function readSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Settings;
  } catch {
    return {};
  }
}

/**
 * Forget what older versions stored for v1 (the relay): its saved settings fields and its
 * pairing state. (The Rust side deletes leftover v1 tokens from the Keychain.)
 */
function dropOldV1State(): void {
  const m = migrateSettings(readSettings() as Record<string, unknown>);
  if (m) localStorage.setItem(SETTINGS_KEY, JSON.stringify(m));
  for (const k of OLD_V1_KEYS) localStorage.removeItem(k);
}

/** Merge into the saved settings (only non-secret preferences live here). */
export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...s }));
}

export async function loadConfig(): Promise<DeskPetConfig> {
  dropOldV1State();
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
  if (s.mailboxUrl) cfg.mailboxUrl = s.mailboxUrl;
  if (s.openUrls) cfg.openUrls = { default: s.openUrls.default || cfg.openUrls.default, agents: { ...cfg.openUrls.agents, ...s.openUrls.agents } };
  if (s.petSize === "large" || s.petSize === "small") cfg.petSize = s.petSize;
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
