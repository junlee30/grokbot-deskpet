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

/**
 * Where bots get the Desk Pet skill: SKILL.md on GitHub at the tag for this publisher version.
 * The skill pins the publisher's SHA-256 and downloads it from the same tag. Tests check this
 * matches protocol/v2.json and skill/SKILL.md; push the tag `skill-v<version>` with a release.
 */
export const SKILL_REPO = "junlee30/grokbot-deskpet";
export const SKILL_VERSION = "2.1.0";
export const SKILL_URL = `https://raw.githubusercontent.com/${SKILL_REPO}/skill-v${SKILL_VERSION}/skill/SKILL.md`;

/**
 * The one line the user pastes to a Grok Bot: where the skill is and the dp2 code. A bot
 * without the skill reads it from the link and sets itself up; one with it just pairs.
 */
export function pasteLineV2(code: string): string {
  return `Install the Desk Pet skill from ${SKILL_URL} and pair with code ${code}`;
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
