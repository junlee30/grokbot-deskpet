// Desk Pet relay: bots POST status, the desktop pet subscribes over SSE.
// Plain node:http, no runtime dependencies.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RelayConfig } from "./config.ts";
import {
  bearer,
  hashCode,
  hashToken,
  newPairCode,
  newToken,
  normalizeCode,
  openForCode,
  sealForCode,
} from "./crypto.ts";
import { RateLimiter } from "./ratelimit.ts";
import { Store, type StoredState, type TokenPersistence } from "./store.ts";
import { validateEvent, validatePairRequest } from "./validate.ts";

export const VERSION = "0.1.0";

interface Subscriber {
  res: ServerResponse;
  ping: NodeJS.Timeout;
}

export interface Relay {
  server: Server;
  store: Store;
  config: RelayConfig;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
  subscriberCount(tokenHash?: string): number;
}

class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(data);
}

function isJson(req: IncomingMessage): boolean {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  return /^application\/json\s*(;|$)/.test(ct);
}

/** Read a request body with a hard byte cap enforced while streaming (never buffers past max). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const cl = req.headers["content-length"];
  if (cl !== undefined && Number(cl) > max) {
    return Promise.reject(new HttpError(413, "payload too large", { connection: "close" }));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      if (err) reject(err);
      else resolve(buf!);
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > max) {
        chunks.length = 0;
        req.pause();
        finish(new HttpError(413, "payload too large", { connection: "close" }));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.once("end", () => finish(null, Buffer.concat(chunks)));
    req.once("error", (e) => finish(e));
  });
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  if (!isJson(req)) throw new HttpError(415, "content-type must be application/json");
  const buf = await readBody(req, max);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createRelay(config: RelayConfig, persistence: TokenPersistence | null = null): Relay {
  const now = config.now;
  const store = new Store(now, persistence);
  const eventLimiter = new RateLimiter(config.ratePerMin, config.rateBurst, now);
  const pairLimiter = new RateLimiter(config.pairRatePerMin, config.pairRateBurst, now);
  const subs = new Map<string, Set<Subscriber>>();
  const isoNow = () => new Date(now()).toISOString();

  function authenticate(req: IncomingMessage): string {
    const token = bearer(req.headers.authorization);
    if (!token) throw new HttpError(401, "missing or malformed bearer token", { "www-authenticate": "Bearer" });
    const h = hashToken(config.pepper, token);
    if (!store.findToken(h)) throw new HttpError(401, "invalid or revoked token", { "www-authenticate": "Bearer" });
    return h;
  }

  function broadcast(tokenHash: string, event: string, data: unknown): void {
    for (const s of subs.get(tokenHash) ?? []) sse(s.res, event, data);
  }

  function closeStreams(tokenHash: string, event: string): void {
    const set = subs.get(tokenHash);
    if (!set) return;
    for (const s of set) {
      clearInterval(s.ping);
      sse(s.res, event, {});
      s.res.end();
    }
    subs.delete(tokenHash);
  }

  function clientKey(req: IncomingMessage): string {
    return `ip:${req.socket.remoteAddress ?? "unknown"}`;
  }

  function limitPair(req: IncomingMessage): void {
    const wait = pairLimiter.take(clientKey(req));
    if (wait) throw new HttpError(429, "rate limited", { "retry-after": String(wait) });
  }

  // POST /v1/pair/start — desktop asks for a pairing code + its own copy of the token.
  function pairStart(req: IncomingMessage, res: ServerResponse): void {
    limitPair(req);
    const token = newToken();
    const tokenHash = hashToken(config.pepper, token);
    let code = newPairCode();
    while (store.pairings.has(hashCode(config.pepper, code))) code = newPairCode();
    const expires = now() + config.codeTtlMs;
    store.addToken(tokenHash);
    store.addPairing(hashCode(config.pepper, code), {
      sealed: sealForCode(config.pepper, code, token),
      token_hash: tokenHash,
      expires_at: expires,
      used_at: null,
    });
    sendJson(res, 201, { code, token, expires_at: new Date(expires).toISOString() });
  }

  // POST /v1/pair — the bot exchanges the human code for the token.
  async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    limitPair(req);
    const body = await readJson(req, config.maxBodyBytes);
    const v = validatePairRequest(body);
    if (!v.ok) throw new HttpError(400, v.error);
    const code = normalizeCode(v.value.code);
    if (!code) throw new HttpError(400, "code must look like ABC-234");
    const key = hashCode(config.pepper, code);
    const p = store.pairings.get(key);
    if (!p) throw new HttpError(404, "unknown pairing code");
    if (p.used_at !== null || !p.sealed) throw new HttpError(410, "pairing code already used");
    if (p.expires_at <= now()) {
      store.pairings.delete(key);
      throw new HttpError(410, "pairing code expired");
    }
    if (!store.findToken(p.token_hash)) {
      store.pairings.delete(key);
      throw new HttpError(410, "pairing was cancelled");
    }
    const token = openForCode(config.pepper, code, p.sealed);
    if (!token) throw new HttpError(404, "unknown pairing code");
    // Single use: drop the ciphertext, keep a tombstone until expiry so reuse gets 410.
    p.sealed = null;
    p.used_at = now();
    const relayUrl = config.publicUrl ?? `http://${req.headers.host ?? `${config.host}:${config.port}`}`;
    broadcast(p.token_hash, "paired", {
      agent_id: v.value.agent_id ?? null,
      agent_name: v.value.agent_name ?? v.value.agent_id ?? null,
      ts: isoNow(),
    });
    sendJson(res, 200, { token, relay_url: relayUrl, agent_id: v.value.agent_id ?? null });
  }

  async function postEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const tokenHash = authenticate(req);
    if (!isJson(req)) throw new HttpError(415, "content-type must be application/json");
    const wait = eventLimiter.take(tokenHash);
    if (wait) throw new HttpError(429, "rate limited", { "retry-after": String(wait) });
    const body = await readJson(req, config.maxBodyBytes);
    const v = validateEvent(body);
    if (!v.ok) throw new HttpError(400, v.error);
    const received_at = isoNow();
    const { message, ...rest } = v.value;
    const stored: StoredState = { ...rest, received_at };
    store.putState(tokenHash, stored, config.maxAgentsPerToken, config.maxSessionsPerAgent);
    store.touchToken(tokenHash);
    // The message goes out live only; it is never stored.
    broadcast(tokenHash, "state", message ? { ...stored, message } : stored);
    sendJson(res, 202, { ok: true });
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    const tokenHash = authenticate(req);
    let set = subs.get(tokenHash);
    if (set && set.size >= config.maxSubscribers) {
      throw new HttpError(429, "too many subscribers for this token", { "retry-after": "30" });
    }
    if (!set) subs.set(tokenHash, (set = new Set()));
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write("retry: 3000\n\n");
    for (const s of store.snapshot(tokenHash)) sse(res, "state", s);
    const sub: Subscriber = {
      res,
      ping: setInterval(() => sse(res, "ping", { ts: isoNow() }), config.pingMs),
    };
    set.add(sub);
    const cleanup = () => {
      clearInterval(sub.ping);
      const cur = subs.get(tokenHash);
      cur?.delete(sub);
      if (cur && cur.size === 0) subs.delete(tokenHash);
    };
    res.once("close", cleanup);
  }

  function unpair(req: IncomingMessage, res: ServerResponse): void {
    const tokenHash = authenticate(req);
    store.revokeToken(tokenHash);
    eventLimiter.forget(tokenHash);
    closeStreams(tokenHash, "revoked");
    sendJson(res, 200, { ok: true });
  }

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-max-age", "600");
    }
    res.setHeader("vary", "Origin");
  }

  type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  const routes: Record<string, Record<string, Handler>> = {
    "/health": { GET: (_req, res) => sendJson(res, 200, { ok: true, name: "grokbot-deskpet-relay", version: VERSION }) },
    "/v1/pair/start": { POST: pairStart },
    "/v1/pair": { POST: pair },
    "/v1/events": { POST: postEvent },
    "/v1/stream": { GET: stream },
    "/v1/unpair": { POST: unpair },
  };

  const server = createServer(async (req, res) => {
    const started = now();
    // Only method + path are logged: never headers, never query strings, never bodies.
    const path = (req.url ?? "/").split("?")[0]!.slice(0, 64);
    if (config.log) {
      res.once("finish", () => console.log(`${req.method} ${path} ${res.statusCode} ${now() - started}ms`));
    }
    try {
      cors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const route = routes[path];
      if (!route) throw new HttpError(404, "not found");
      const h = route[req.method ?? ""];
      if (!h) throw new HttpError(405, "method not allowed", { allow: Object.keys(route).join(", ") });
      await h(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) res.once("finish", () => req.destroy());
        sendJson(res, e.status, { ok: false, error: e.message }, e.headers);
      } else {
        console.error(`error handling ${req.method} ${path}: ${(e as Error)?.name ?? "Error"}`);
        sendJson(res, 500, { ok: false, error: "internal error" });
      }
    }
  });

  const sweeper = setInterval(() => {
    store.sweep(config.stateTtlMs);
    eventLimiter.sweep();
    pairLimiter.sweep();
  }, 60_000);
  sweeper.unref();

  return {
    server,
    store,
    config,
    subscriberCount(tokenHash?: string) {
      if (tokenHash) return subs.get(tokenHash)?.size ?? 0;
      let n = 0;
      for (const s of subs.values()) n += s.size;
      return n;
    },
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },
    close() {
      clearInterval(sweeper);
      for (const set of subs.values()) {
        for (const s of set) {
          clearInterval(s.ping);
          s.res.end();
        }
      }
      subs.clear();
      store.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
