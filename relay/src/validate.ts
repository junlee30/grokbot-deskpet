// Hand-rolled schema validation for POST /v1/events. No dependencies, unknown fields rejected.

export const STATES = ["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping"] as const;
export type PetState = (typeof STATES)[number];

export interface StatusEvent {
  agent_id: string;
  agent_name: string;
  session: string;
  state: PetState;
  event: string;
  message?: string;
  ts: string;
}

const ALLOWED = new Set(["agent_id", "bot", "agent_name", "session", "state", "event", "message", "ts"]);
const AGENT_ID_RE = /^[a-z0-9_-]{1,64}$/;
const EVENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function textField(v: unknown, name: string, max: number, required: boolean): Result<string | undefined> {
  if (v === undefined) return required ? { ok: false, error: `${name} is required` } : { ok: true, value: undefined };
  if (typeof v !== "string") return { ok: false, error: `${name} must be a string` };
  const len = [...v].length;
  if (len === 0 && required) return { ok: false, error: `${name} must not be empty` };
  if (len > max) return { ok: false, error: `${name} must be at most ${max} characters` };
  if (CONTROL_RE.test(v)) return { ok: false, error: `${name} must not contain control characters` };
  return { ok: true, value: v };
}

export function validateEvent(body: unknown): Result<StatusEvent> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED.has(k)) return { ok: false, error: `unknown field: ${k.slice(0, 32)}` };
  }

  // "bot" is a legacy alias for agent_id.
  if (o.agent_id !== undefined && o.bot !== undefined && o.agent_id !== o.bot) {
    return { ok: false, error: "agent_id and bot disagree" };
  }
  const agentId = o.agent_id ?? o.bot;
  if (agentId === undefined) return { ok: false, error: "agent_id is required" };
  if (typeof agentId !== "string" || !AGENT_ID_RE.test(agentId)) {
    return { ok: false, error: "agent_id must match [a-z0-9_-]{1,64}" };
  }

  const name = textField(o.agent_name, "agent_name", 64, false);
  if (!name.ok) return name;
  const session = textField(o.session, "session", 128, true);
  if (!session.ok) return session;
  const message = textField(o.message, "message", 160, false);
  if (!message.ok) return message;

  if (typeof o.state !== "string" || !(STATES as readonly string[]).includes(o.state)) {
    return { ok: false, error: `state must be one of ${STATES.join(", ")}` };
  }
  if (typeof o.event !== "string" || !EVENT_RE.test(o.event)) {
    return { ok: false, error: "event is required ([A-Za-z0-9_.:-], at most 64)" };
  }
  if (typeof o.ts !== "string" || !ISO_RE.test(o.ts) || Number.isNaN(Date.parse(o.ts))) {
    return { ok: false, error: "ts must be an ISO-8601 timestamp" };
  }

  const value: StatusEvent = {
    agent_id: agentId,
    agent_name: name.value && name.value.trim() ? name.value : agentId,
    session: session.value!,
    state: o.state as PetState,
    event: o.event,
    ts: o.ts,
  };
  if (message.value) value.message = message.value;
  return { ok: true, value };
}

export interface PairRequest {
  code: unknown;
  agent_id?: string;
  agent_name?: string;
}

export function validatePairRequest(body: unknown): Result<PairRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["code", "agent_id", "agent_name"].includes(k)) return { ok: false, error: `unknown field: ${k.slice(0, 32)}` };
  }
  if (o.agent_id !== undefined && (typeof o.agent_id !== "string" || !AGENT_ID_RE.test(o.agent_id))) {
    return { ok: false, error: "agent_id must match [a-z0-9_-]{1,64}" };
  }
  const name = textField(o.agent_name, "agent_name", 64, false);
  if (!name.ok) return name;
  const out: PairRequest = { code: o.code };
  if (typeof o.agent_id === "string") out.agent_id = o.agent_id;
  if (name.value) out.agent_name = name.value;
  return { ok: true, value: out };
}
