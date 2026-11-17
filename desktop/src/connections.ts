// Pure helpers for the v2 private-mailbox connection (no DOM, unit-tested).
import type { ConnStatus } from "./events.ts";

export interface Conn {
  status: ConnStatus;
  detail?: string;
}

export type StatusTone = "none" | "online" | "connecting" | "offline";

/**
 * The control window's status line under "Desk Pet" (with a coloured dot): whether we are
 * paired and how the mailbox connection is doing.
 */
export function headerStatus(s: { paired: boolean; conn: Conn | null; host: string }): { tone: StatusTone; text: string } {
  if (!s.paired) return { tone: "none", text: "Not paired" };
  const via = s.host ? ` · ${s.host}` : "";
  const c = s.conn;
  if (!c || c.status === "connecting") return { tone: "connecting", text: `Connecting…${via}` };
  if (c.status === "online") return { tone: "online", text: `Connected${via}` };
  return { tone: "offline", text: `Offline · ${c.detail ?? "retrying"}` };
}

/** The line the user pastes to their Grok Bot for a v2 (dp2) code. */
export function pasteLineV2(code: string): string {
  return `Install the Desk Pet skill and pair with code ${code}`;
}

/** Copyable dp2 code shape (the Rust side does the real checksum validation). */
export function looksLikeDp2(code: unknown): code is string {
  return typeof code === "string" && /^dp2\.[A-Za-z0-9_-]{60,400}$/.test(code);
}

export type View = "pair-start" | "pair-code" | "pets";

/**
 * Which screen to show at boot.
 * - not paired: the Connect card
 * - a code that no bot has used yet: show that code again
 * - otherwise pets (the connection settles itself once it connects)
 */
export function bootView(s: { paired: boolean; seen: boolean }): View {
  if (!s.paired) return "pair-start";
  return s.seen ? "pets" : "pair-code";
}

/** localStorage keys older versions used for the v1 relay (pairing state, an M0 token). */
export const OLD_V1_KEYS: readonly string[] = ["deskpet.token", "deskpet.pending", "deskpet.paired"];

/**
 * Settings fields older versions saved that are gone: v1's `relayUrl` and `pairMode`, and
 * `openUrls` (a pet click used to open a web link; now it opens the bot's Grok Bot chat).
 */
const OLD_SETTINGS_FIELDS = ["relayUrl", "pairMode", "openUrls"];

/** Saved settings without the old fields. Returns null when nothing needs to change. */
export function migrateSettings(s: Record<string, unknown>): Record<string, unknown> | null {
  if (!OLD_SETTINGS_FIELDS.some((k) => k in s)) return null;
  const out: Record<string, unknown> = { ...s };
  for (const k of OLD_SETTINGS_FIELDS) delete out[k];
  return out;
}
