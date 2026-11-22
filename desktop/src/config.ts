import type { PetSize } from "./layout.ts";
import { DEFAULT_MAILBOX, validateMailboxUrl } from "./net.ts";

// App configuration: shipped defaults (public/deskpet.config.json) + local overrides from the
// settings panel (localStorage). In dev builds the idle->sleeping timeout is short.
// Keep Pets on Top is not here: the Rust side owns it (the menu bar toggles it too).

export interface DeskPetConfig {
  /** v2 mailbox base URL used for the next new code (ntfy.sh or a self-hosted ntfy). */
  mailboxUrl: string;
  accents: Record<string, string>;
  sleepAfterMs: number;
  staleActiveMs: number;
  toastMs: number;
  /** Pet size (persisted); each bot's window is sized for it (layout.ts petWindowSize). */
  petSize: PetSize;
  /** A macOS notification when a bot starts waiting for you (needs_you). */
  notifyNeedsYou: boolean;
  /** Off: idle and sleeping pets hold still (no breathing, blinking or drifting z's). */
  animateResting: boolean;
}

const SETTINGS_KEY = "deskpet.settings";

export const DEFAULTS: DeskPetConfig = {
  mailboxUrl: DEFAULT_MAILBOX,
  accents: {},
  sleepAfterMs: import.meta.env.DEV ? 30_000 : 5 * 60_000,
  staleActiveMs: 10 * 60_000,
  toastMs: 5000,
  petSize: "large",
  notifyNeedsYou: true,
  animateResting: true,
};

export type Settings = Partial<Pick<DeskPetConfig, "mailboxUrl" | "petSize" | "notifyNeedsYou" | "animateResting">>;

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
    accents: { ...(file.accents ?? {}) },
  };
  if (import.meta.env.DEV) cfg.sleepAfterMs = Math.min(cfg.sleepAfterMs, DEFAULTS.sleepAfterMs);
  const s = readSettings();
  if (s.mailboxUrl) cfg.mailboxUrl = s.mailboxUrl;
  if (s.petSize === "large" || s.petSize === "small") cfg.petSize = s.petSize;
  if (typeof s.notifyNeedsYou === "boolean") cfg.notifyNeedsYou = s.notifyNeedsYou;
  if (typeof s.animateResting === "boolean") cfg.animateResting = s.animateResting;
  const mb = validateMailboxUrl(cfg.mailboxUrl);
  cfg.mailboxUrl = mb.ok ? mb.url : DEFAULTS.mailboxUrl;
  return cfg;
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
