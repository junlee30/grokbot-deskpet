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
  received_at: string;
  /** Grok Bot profile avatar names; validated again by parseAvatar. */
  avatar?: { shape: string; color: string };
}

export type ConnStatus = "connecting" | "online" | "offline";

const STATES = new Set(["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping"]);

export function isStateEvent(p: unknown): p is StateEvent {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.agent_id === "string" && typeof o.session === "string" && typeof o.state === "string" && STATES.has(o.state);
}
