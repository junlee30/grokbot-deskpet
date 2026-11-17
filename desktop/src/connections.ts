// Pure helpers for running the two connection kinds side by side (no DOM, unit-tested):
//   v1  relay (Fly or local relay; token in the Keychain)
//   v2  private mailbox (ntfy; end-to-end encrypted; topic + key in the Keychain)
// Pets from both are merged by agent_id in main.ts.
import type { ConnStatus } from "./relay.ts";

export type PairMode = "v2" | "v1";

export interface Conn {
  status: ConnStatus;
  detail?: string;
}

/**
 * One status for the whole window. Pets are drawn "offline" only when every active connection
 * is offline; the status line names the one with trouble when both are active.
 */
export function combineStatus(v1: Conn | null, v2: Conn | null): { status: ConnStatus; text: string } {
  const active = [v1 && { tag: "relay", ...v1 }, v2 && { tag: "mailbox", ...v2 }].filter(Boolean) as Array<Conn & { tag: string }>;
  if (active.length === 0) return { status: "online", text: "" };
  const both = active.length === 2;
  const status: ConnStatus = active.some((c) => c.status === "online")
    ? "online"
    : active.some((c) => c.status === "connecting")
      ? "connecting"
      : "offline";
  const trouble = active.filter((c) => c.status !== "online");
  if (trouble.length === 0) return { status, text: "" };
  const parts = trouble.map((c) => {
    const what = c.status === "connecting" ? "connecting…" : `offline · ${c.detail ?? "retrying"}`;
    return both ? `${c.tag} ${what}` : what;
  });
  return { status, text: parts.join(" · ") };
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
 * - nothing paired: the Connect card
 * - a v2 code that no bot has used yet and no v1 pairing: show that code again
 * - otherwise pets (each connection settles itself once it connects)
 */
export function bootView(s: { v1: boolean; v1Pending: boolean; v2: boolean; v2Seen: boolean }): { view: View; code: "v1" | "v2" | null } {
  if (!s.v1 && !s.v2) return { view: "pair-start", code: null };
  if (s.v2 && !s.v2Seen && !s.v1) return { view: "pair-code", code: "v2" };
  if (s.v1 && s.v1Pending && !s.v2) return { view: "pair-code", code: "v1" };
  return { view: "pets", code: null };
}
