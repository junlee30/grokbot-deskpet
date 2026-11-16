import { loadConfig, type RelayConfig } from "../src/config.ts";
import { createRelay, type Relay } from "../src/server.ts";
import { Store } from "../src/store.ts";

export interface Clock {
  t: number;
  advance(ms: number): void;
}

export interface Harness {
  relay: Relay;
  base: string;
  clock: Clock;
  /** Every JSON log line the relay wrote. */
  logs: string[];
  close(): Promise<void>;
}

export function newClock(): Clock {
  return {
    t: Date.parse("2026-01-01T00:00:00Z"),
    advance(ms: number) {
      this.t += ms;
    },
  };
}

/** Start a relay on a random port. `dbPath` defaults to an in-memory database. */
export async function startRelay(
  over: Partial<RelayConfig> = {},
  opts: { dbPath?: string; clock?: Clock; env?: NodeJS.ProcessEnv } = {},
): Promise<Harness> {
  const clock = opts.clock ?? newClock();
  const logs: string[] = [];
  const cfg = loadConfig(
    { DESKPET_DB: ":memory:", ...opts.env },
    { log: true, logger: (l) => logs.push(l), now: () => clock.t, ...over },
  );
  const store = Store.open(opts.dbPath ?? ":memory:", cfg.now);
  const relay = createRelay(cfg, store);
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, base: `http://127.0.0.1:${port}`, clock, logs, close: () => relay.close() };
}

export async function pairStart(base: string): Promise<{ code: string; token: string; expires_at: string }> {
  const r = await fetch(`${base}/v1/pair/start`, { method: "POST" });
  if (r.status !== 201) throw new Error(`pair/start ${r.status}`);
  return (await r.json()) as { code: string; token: string; expires_at: string };
}

export function goodEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "jarvis",
    agent_name: "Jarvis",
    session: "s1",
    state: "working",
    event: "tool_start",
    ts: "2026-01-01T00:00:00Z",
    ...over,
  };
}

export function postEvent(base: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { "content-type": "application/json", ...headers };
  if (token !== null) h.authorization = `Bearer ${token}`;
  return fetch(`${base}/v1/events`, {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export interface SseEvent {
  event: string;
  data: any;
  id?: string;
}

export interface SseClient {
  status: number;
  /** "retry:" value seen on the stream, if any. */
  retry: number | null;
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  close(): void;
}

/** Minimal SSE client over fetch so we can send the Authorization header. */
export async function openStream(base: string, token: string, headers: Record<string, string> = {}): Promise<SseClient> {
  const ac = new AbortController();
  const r = await fetch(`${base}/v1/stream`, { headers: { authorization: `Bearer ${token}`, ...headers }, signal: ac.signal });
  const events: SseEvent[] = [];
  const meta = { retry: null as number | null };
  const waiters: Array<() => void> = [];
  if (r.ok && r.body) {
    (async () => {
      const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            let id: string | undefined;
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
              else if (line.startsWith("id: ")) id = line.slice(4);
              else if (line.startsWith("retry: ")) meta.retry = Number(line.slice(7));
            }
            if (data.length) {
              events.push({ event, data: JSON.parse(data.join("\n")), ...(id ? { id } : {}) });
              waiters.splice(0).forEach((w) => w());
            }
          }
        }
      } catch {
        /* aborted */
      }
      events.push({ event: "__closed__", data: null });
      waiters.splice(0).forEach((w) => w());
    })();
  } else {
    await r.body?.cancel();
  }
  return {
    status: r.status,
    get retry() {
      return meta.retry;
    },
    events,
    waitFor(pred, ms = 2000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for SSE event")), ms);
        const check = () => {
          const hit = events.find(pred);
          if (hit) {
            clearTimeout(timer);
            resolve(hit);
          } else waiters.push(check);
        };
        check();
      });
    },
    close() {
      ac.abort();
    },
  };
}
