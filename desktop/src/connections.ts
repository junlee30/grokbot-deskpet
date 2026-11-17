// Pure helpers for the connection kinds (no DOM, unit-tested):
//   v2  private mailbox (ntfy; end-to-end encrypted; topic + key in the Keychain). The default
//       and the only path in the normal UI.
//   v1  DEPRECATED relay: only a relay the user runs themselves (Settings → Legacy). The hosted
//       relay is gone. Token in the Keychain.
// When both run, pets are merged by agent_id in main.ts.
import { isRetiredRelay } from "./net.ts";
import type { ConnStatus } from "./relay.ts";

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

/**
 * v1 deprecation clean-up of saved settings. Drops the old "Connect with" choice (pairing is
 * always v2 now) and a relay URL pointing at the retired hosted relay. Returns null when
 * nothing needs to change.
 */
export function migrateSettings(s: Record<string, unknown>): { settings: Record<string, unknown>; droppedRetiredRelay: boolean } | null {
  const retired = typeof s.relayUrl === "string" && isRetiredRelay(s.relayUrl);
  if (!retired && !("pairMode" in s)) return null;
  const out: Record<string, unknown> = { ...s };
  delete out.pairMode;
  if (retired) delete out.relayUrl;
  return { settings: out, droppedRetiredRelay: retired };
}

/**
 * The deprecated v1 paste line: always names the user's own relay (there is no hosted default
 * any more). It doesn't point at the Desk Pet skill, which only pairs v2 codes; self-hosters
 * give their bot the manual steps in relay/README.md.
 */
export function pasteLineV1(code: string, relayUrl: string): string {
  return `Pair with my self-hosted Desk Pet relay ${relayUrl} using code ${code}`;
}
