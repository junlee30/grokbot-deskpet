// Pure helpers for the v2 private-mailbox connection (no DOM, unit-tested).
import type { ConnStatus } from "./events.ts";

export interface Conn {
  status: ConnStatus;
  detail?: string;
}

/** The status line for the mailbox connection (empty when online or not paired). */
export function statusLine(c: Conn | null): { status: ConnStatus; text: string } {
  if (!c || c.status === "online") return { status: "online", text: "" };
  if (c.status === "connecting") return { status: "connecting", text: "connecting…" };
  return { status: "offline", text: `offline · ${c.detail ?? "retrying"}` };
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
 * Saved settings without the fields older versions kept for v1 (`relayUrl`, `pairMode`).
 * Returns null when nothing needs to change.
 */
export function migrateSettings(s: Record<string, unknown>): Record<string, unknown> | null {
  if (!("relayUrl" in s) && !("pairMode" in s)) return null;
  const out: Record<string, unknown> = { ...s };
  delete out.relayUrl;
  delete out.pairMode;
  return out;
}
