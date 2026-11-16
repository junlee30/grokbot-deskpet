// App configuration: shipped defaults (public/deskpet.config.json) + local overrides from the
// settings panel (localStorage). In dev builds the idle->sleeping timeout is short.

export interface DeskPetConfig {
  relayUrl: string;
  openUrls: { default: string; agents: Record<string, string> };
  accents: Record<string, string>;
  sleepAfterMs: number;
  staleActiveMs: number;
  toastMs: number;
}

const SETTINGS_KEY = "deskpet.settings";

export const DEFAULTS: DeskPetConfig = {
  relayUrl: "http://127.0.0.1:8787",
  openUrls: { default: "https://grok.com", agents: {} },
  accents: {},
  sleepAfterMs: import.meta.env.DEV ? 30_000 : 5 * 60_000,
  staleActiveMs: 10 * 60_000,
  toastMs: 5000,
};

export type Settings = Partial<Pick<DeskPetConfig, "relayUrl" | "openUrls">>;

function readSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Settings;
  } catch {
    return {};
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
  if (s.openUrls) cfg.openUrls = { default: s.openUrls.default || cfg.openUrls.default, agents: { ...cfg.openUrls.agents, ...s.openUrls.agents } };
  cfg.relayUrl = cfg.relayUrl.replace(/\/+$/, "");
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

// ---- local secrets / pairing state ----
// TODO(M1): move the token to the OS keychain (e.g. a Tauri keyring plugin). For M0 it lives in
// localStorage, which is scoped to the app's webview origin.
const TOKEN_KEY = "deskpet.token";
const PENDING_KEY = "deskpet.pending";
const PAIRED_KEY = "deskpet.paired";

export const secrets = {
  token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  setToken(t: string): void {
    localStorage.setItem(TOKEN_KEY, t);
  },
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
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(PAIRED_KEY);
  },
};
