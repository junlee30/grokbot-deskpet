import { loadConfig, type RelayConfig } from "../src/config.ts";
import { createRelay, type Relay } from "../src/server.ts";
import type { TokenPersistence } from "../src/store.ts";

export interface Harness {
  relay: Relay;
  base: string;
  clock: { t: number; advance(ms: number): void };
  close(): Promise<void>;
}

export async function startRelay(over: Partial<RelayConfig> = {}, persistence: TokenPersistence | null = null): Promise<Harness> {
  const clock = {
    t: Date.parse("2026-01-01T00:00:00Z"),
    advance(ms: number) {
      this.t += ms;
    },
  };
  const cfg = loadConfig({}, { log: false, now: () => clock.t, ...over });
  const relay = createRelay(cfg, persistence);
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, base: `http://127.0.0.1:${port}`, clock, close: () => relay.close() };
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
}

export interface SseClient {
  status: number;
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
  close(): void;
}

/** Minimal SSE client over fetch so we can send the Authorization header. */
export async function openStream(base: string, token: string): Promise<SseClient> {
  const ac = new AbortController();
  const r = await fetch(`${base}/v1/stream`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  const events: SseEvent[] = [];
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
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("data: ")) data.push(line.slice(6));
            }
            if (data.length) {
              events.push({ event, data: JSON.parse(data.join("\n")) });
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
