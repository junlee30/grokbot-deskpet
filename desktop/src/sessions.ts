// Which of an agent's sessions decide what its pet shows. Pure logic only (no DOM): unit-tested
// in test/sessions.test.ts.
//
// Bots sometimes start a new session id every turn, so an agent can leave old sessions behind
// in any state. Rules:
//   - The agent's NEWEST event (by the bot's `ts`, then `seq`) is authoritative. Once a newer
//     event arrives in any session, the older sessions stop affecting the display; an older
//     needs_you or error never outranks a newer done.
//   - Exception: two or more sessions genuinely running at once (each in an active state and
//     heard from within CONCURRENT_MS) show "juggling", unless the newest event is itself a
//     needs_you or error (that is the latest news, so it shows).
//   - Any shown state that sits unrefreshed for staleMs (10 min by default), including
//     needs_you and error, fades to idle.
import type { PetState } from "./events.ts";

/** States a session is "running" in (can count towards juggling). */
export const ACTIVE: ReadonlySet<PetState> = new Set<PetState>(["thinking", "working", "juggling"]);
/** States that fade to idle once nothing has refreshed them for staleMs. */
export const FADES: ReadonlySet<PetState> = new Set<PetState>(["thinking", "working", "juggling", "needs_you", "error"]);
/** Sessions heard from within this window (and active) count as running at the same time. */
export const CONCURRENT_MS = 2 * 60_000;

export interface Session {
  state: PetState;
  /** When we got it (ms, never in the future): drives fading and concurrency. */
  at: number;
  /** The bot's own timestamp (ms) and sequence number: order events across sessions. */
  ts: number;
  seq: number;
  /** Arrival counter: the last tie-breaker, so a full tie goes to the later arrival. */
  n: number;
  /** Latest message for this session while it stays in the same state (working label). */
  message?: string;
}

/** a is newer than b (by ts, then seq, then arrival). */
export function newer(a: Session, b: Session): boolean {
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return a.n > b.n;
}

/** The session holding the agent's newest event. */
export function latestSession(sessions: Iterable<Session>): Session | null {
  let best: Session | null = null;
  for (const s of sessions) if (!best || newer(s, best)) best = s;
  return best;
}

/** The state a session shows by itself: stale fading states are idle. */
function shownState(s: Session, now: number, staleMs: number): PetState {
  return FADES.has(s.state) && now - s.at > staleMs ? "idle" : s.state;
}

export interface Display {
  state: PetState;
  /** The sessions behind it: the latest one, or every concurrent one when juggling. */
  sessions: Session[];
}

/** What the pet shows, and which sessions decide it. */
export function displayFor(sessions: Iterable<Session>, now: number, staleMs: number): Display {
  const all = [...sessions];
  const latest = latestSession(all);
  if (!latest) return { state: "idle", sessions: [] };
  const own = shownState(latest, now, staleMs);
  if (own === "needs_you" || own === "error") return { state: own, sessions: [latest] };
  const running = all.filter((s) => ACTIVE.has(s.state) && now - s.at <= Math.min(CONCURRENT_MS, staleMs));
  if (running.length >= 2) return { state: "juggling", sessions: running };
  return { state: own, sessions: [latest] };
}

export function effectiveState(sessions: Iterable<Session>, now: number, staleMs: number): PetState {
  return displayFor(sessions, now, staleMs).state;
}

/** Order key for an incoming event: the bot's ts (else when we got it) and seq (else 0). */
export function eventOrder(ts: unknown, seq: unknown, at: number): { ts: number; seq: number } {
  const t = typeof ts === "string" ? Date.parse(ts) : NaN;
  const q = typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
  return { ts: Number.isFinite(t) ? t : at, seq: q };
}
