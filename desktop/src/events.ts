// The state events the pets are drawn from. The v2 mailbox client in Rust
// (src-tauri/src/mailbox.rs + v2.rs) decrypts and validates them; the webview checks the shape
// again before using one.

export type PetState = "idle" | "thinking" | "working" | "juggling" | "needs_you" | "done" | "error" | "sleeping";

export interface StateEvent {
  agent_id: string;
  agent_name: string;
  session: string;
  state: PetState;
  event: string;
  message?: string;
  ts: string;
  /** The bot's sequence number (rises with every post); orders events that share a ts. */
  seq?: number;
  received_at: string;
  /** Grok Bot profile avatar names; validated again by parseAvatar. */
  avatar?: { shape: string; color: string };
  /** The bot's Grok Bot agent UUID; a click opens its chat. Validated again by grokbotId. */
  grokbot_id?: string;
  /** The bot's publisher version, and whether it is older than the one this app ships with. */
  pv?: string;
  pv_outdated?: boolean;
  /** Posts the bot's computer couldn't deliver because the mailbox rate-limited it. */
  dropped?: number;
}

export type ConnStatus = "connecting" | "online" | "offline";

/** The bot states, in protocol order (checked against protocol/v2.json in test/protocol.test.ts). */
export const STATE_LIST: readonly PetState[] = ["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping"];
const STATES: ReadonlySet<string> = new Set(STATE_LIST);

export function isStateEvent(p: unknown): p is StateEvent {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.agent_id === "string" && typeof o.session === "string" && typeof o.state === "string" && STATES.has(o.state);
}
