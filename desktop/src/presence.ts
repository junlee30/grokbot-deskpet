// What the pet's bubble shows. Pure logic only (no DOM): unit-tested in test/presence.test.ts.
//
// Two kinds of text share one bubble per pet:
//   - toast: any fresh event message, shown for a few seconds;
//   - sticky label: while the pet is shown "working" (or "juggling"), the latest message of the
//     sessions in that state stays up as a short label ("Reading the build log").
// A toast wins while it lasts, unless it says the same as the label (then it is the label).
import type { PetState } from "./events.ts";

/** States whose message stays up as a persistent label. */
export const STICKY_STATES: ReadonlySet<string> = new Set<PetState>(["working", "juggling"]);
/** Longest label we put in the bubble (code points, incl. the ellipsis); CSS also clamps to 2 lines. */
export const LABEL_MAX = 48;

export interface SessionInfo {
  state: PetState;
  at: number;
  message?: string;
}

/**
 * Single-spaced, at most `max` code points: whitespace collapsed, cut at a word boundary when one is
 * reasonably close, with a trailing ellipsis when shortened.
 */
export function truncateLabel(text: string, max = LABEL_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const cps = Array.from(clean);
  if (cps.length <= max) return clean;
  const cut = cps.slice(0, Math.max(1, max - 1)).join("");
  const sp = cut.lastIndexOf(" ");
  const body = sp >= Math.floor(max * 0.6) ? cut.slice(0, sp) : cut;
  return body.replace(/[\s.,;:!?-]+$/, "") + "…";
}

/**
 * The persistent label for a pet whose displayed state is `shown`: the newest non-stale session
 * in that state that has a message. Null when the state has no label or nobody said anything.
 */
export function stickyLabel(shown: string, sessions: Iterable<SessionInfo>, now: number, staleMs: number): string | null {
  if (!STICKY_STATES.has(shown)) return null;
  let best: SessionInfo | null = null;
  for (const s of sessions) {
    if (s.state !== shown || !s.message || !s.message.trim() || now - s.at > staleMs) continue;
    if (!best || s.at >= best.at) best = s;
  }
  return best ? best.message!.replace(/\s+/g, " ").trim() : null;
}

export type BubbleView =
  | { mode: "hidden" }
  /** text: what to render (label is truncated); full: tooltip. */
  | { mode: "toast" | "sticky"; text: string; full: string };

/** Decide what the bubble shows right now. */
export function bubbleView(toast: { text: string; until: number } | null, sticky: string | null, now: number): BubbleView {
  const toastOn = toast !== null && now < toast.until && toast.text.trim() !== "";
  if (sticky && (!toastOn || toast!.text.replace(/\s+/g, " ").trim() === sticky)) return { mode: "sticky", text: truncateLabel(sticky), full: sticky };
  if (toastOn) return { mode: "toast", text: toast!.text, full: toast!.text };
  return { mode: "hidden" };
}

/** Same view? (so the DOM is only touched on change) */
export function sameView(a: BubbleView, b: BubbleView): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "hidden" || b.mode === "hidden") return true;
  return a.text === b.text && a.full === b.full;
}

/** Message a session keeps: the new one, else the old one if it stays in the same state. */
export function carryMessage(prev: SessionInfo | undefined, state: PetState, message: string | undefined): string | undefined {
  if (message && message.trim()) return message;
  return prev && prev.state === state ? prev.message : undefined;
}
