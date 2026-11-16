// Relay client: pairing calls and an SSE subscriber built on fetch + ReadableStream so the token
// travels in the Authorization header (EventSource can't set headers, and the token must never
// go in a query string).

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
}

export interface PairStart {
  code: string;
  token: string;
  expires_at: string;
}

export async function pairStart(relayUrl: string): Promise<PairStart> {
  const r = await fetch(`${relayUrl}/v1/pair/start`, { method: "POST" });
  if (!r.ok) throw new Error(`relay answered ${r.status}`);
  return (await r.json()) as PairStart;
}

export async function unpair(relayUrl: string, token: string): Promise<void> {
  try {
    await fetch(`${relayUrl}/v1/unpair`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  } catch {
    /* best effort: we forget the token locally either way */
  }
}

export type ConnStatus = "connecting" | "online" | "offline";

export interface StreamHandlers {
  onState(e: StateEvent): void;
  onPaired(e: { agent_id: string | null; agent_name: string | null }): void;
  onStatus(s: ConnStatus, detail?: string): void;
  /** Token rejected (401) or revoked by the relay. */
  onUnauthorized(): void;
}

export class StreamClient {
  private ac: AbortController | null = null;
  private stopped = false;
  private attempt = 0;
  private watchdog: number | undefined;
  private retryTimer: number | undefined;
  private readonly relayUrl: string;
  private readonly token: string;
  private readonly h: StreamHandlers;

  constructor(relayUrl: string, token: string, handlers: StreamHandlers) {
    this.relayUrl = relayUrl;
    this.token = token;
    this.h = handlers;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retryTimer);
    this.ac?.abort();
  }

  private kick(): void {
    // No bytes (not even a ping) for 45s: assume the connection is dead and reconnect.
    clearTimeout(this.watchdog);
    this.watchdog = window.setTimeout(() => this.ac?.abort(), 45_000);
  }

  private scheduleRetry(minMs = 0): void {
    if (this.stopped) return;
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    const delay = Math.max(minMs, base / 2 + Math.random() * (base / 2));
    this.attempt++;
    this.retryTimer = window.setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.ac = new AbortController();
    this.h.onStatus(this.attempt === 0 ? "connecting" : "offline", this.attempt ? "reconnecting" : undefined);
    let res: Response;
    try {
      res = await fetch(`${this.relayUrl}/v1/stream`, {
        headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" },
        signal: this.ac.signal,
        cache: "no-store",
      });
    } catch {
      this.h.onStatus("offline", "relay unreachable");
      this.scheduleRetry();
      return;
    }
    if (res.status === 401) {
      this.stopped = true;
      this.h.onUnauthorized();
      return;
    }
    if (!res.ok || !res.body) {
      this.h.onStatus("offline", res.status === 429 ? "too many open windows" : `relay error ${res.status}`);
      void res.body?.cancel().catch(() => {});
      this.scheduleRetry(res.status === 429 ? 15_000 : 0);
      return;
    }
    this.attempt = 0;
    this.h.onStatus("online");
    this.kick();
    try {
      await this.read(res.body);
    } catch {
      /* aborted or network drop */
    }
    clearTimeout(this.watchdog);
    if (!this.stopped) {
      this.h.onStatus("offline", "connection lost");
      this.scheduleRetry();
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      this.kick();
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        this.dispatch(block);
      }
      if (buf.length > 64 * 1024) buf = ""; // never grow without bound on garbage
    }
  }

  private dispatch(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data.join("\n"));
    } catch {
      return;
    }
    if (event === "state" && isStateEvent(payload)) this.h.onState(payload);
    else if (event === "paired") this.h.onPaired(payload as { agent_id: string | null; agent_name: string | null });
    else if (event === "revoked") {
      this.stopped = true;
      this.ac?.abort();
      this.h.onUnauthorized();
    }
  }
}

const STATES = new Set(["idle", "thinking", "working", "juggling", "needs_you", "done", "error", "sleeping"]);

function isStateEvent(p: unknown): p is StateEvent {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return typeof o.agent_id === "string" && typeof o.session === "string" && typeof o.state === "string" && STATES.has(o.state);
}
