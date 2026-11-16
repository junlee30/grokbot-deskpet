// Desk Pet relay: bots POST status, the desktop pet subscribes over SSE.
// Plain node:http + node:sqlite, no runtime dependencies.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
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
import { ipTag, log } from "./log.ts";
import { GlobalFailureLock, RateLimiter } from "./ratelimit.ts";
import { Store, type StoredState } from "./store.ts";
import { validateEvent, validatePairRequest } from "./validate.ts";

export const VERSION = "0.2.0";

interface Subscriber {
  res: ServerResponse;
  ping: NodeJS.Timeout;
}

export interface Relay {
  server: Server;
  store: Store;
  config: RelayConfig;
  listen(port?: number, host?: string): Promise<number>;
  /** Graceful: end every stream, stop accepting, run a final sweep and close the database. */
  close(): Promise<void>;
  subscriberCount(tokenHash?: string): number;
  /** Run the periodic cleanup now (tests). */
  sweep(): void;
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

function sse(res: ServerResponse, event: string, data: unknown, id?: string): void {
  if (res.writableEnded) return;
  res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** `<epoch>-<seq>` → seq, if it belongs to this database and isn't from the future. */
export function parseLastEventId(header: string | undefined, epoch: string, currentSeq: number): number {
  if (!header) return 0;
  const m = /^([0-9a-f]{1,32})-(\d{1,15})$/.exec(header.trim());
  if (!m || m[1] !== epoch) return 0;
  const seq = Number(m[2]);
  return seq <= currentSeq ? seq : 0;
}

const KNOWN_FAILURE = new Set([400, 404, 410]);

export function createRelay(config: RelayConfig, store: Store = Store.open(":memory:", config.now)): Relay {
  const now = config.now;
  const eventLimiter = new RateLimiter(config.ratePerMin, config.rateBurst, now);
  const pairLimiter = new RateLimiter(config.pairRatePerMin, config.pairRateBurst, now);
  const pairStartGlobal = new RateLimiter(config.pairStartGlobalPerMin, config.pairStartGlobalPerMin, now);
  const pairLock = new GlobalFailureLock(config.pairGlobalFailMax, config.pairGlobalWindowMs, config.pairGlobalLockMs, now);
  const subs = new Map<string, Set<Subscriber>>();
  const isoNow = () => new Date(now()).toISOString();
  const eventId = (seq: number) => `${store.epoch}-${seq}`;
  let closing = false;

  function authenticate(req: IncomingMessage): string {
    const token = bearer(req.headers.authorization);
    if (!token) throw new HttpError(401, "missing or malformed bearer token", { "www-authenticate": "Bearer" });
    const h = hashToken(config.pepper, token);
    if (!store.findToken(h)) throw new HttpError(401, "invalid or revoked token", { "www-authenticate": "Bearer" });
    return h;
  }

  function broadcast(tokenHash: string, event: string, data: unknown, id?: string): void {
    for (const s of subs.get(tokenHash) ?? []) sse(s.res, event, data, id);
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

  /** Client IP: Fly-Client-IP only when explicitly trusted (behind Fly's proxy), else the socket. */
  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const h = req.headers["fly-client-ip"];
      const v = (Array.isArray(h) ? h[0] : h)?.trim();
      if (v && isIP(v)) return v;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function limitPerIp(req: IncomingMessage): void {
    const wait = pairLimiter.take(`ip:${clientIp(req)}`);
    if (wait) throw new HttpError(429, "rate limited", { "retry-after": String(wait) });
  }

  // POST /v1/pair/start — desktop asks for a pairing code + its own copy of the token.
  function pairStart(req: IncomingMessage, res: ServerResponse): void {
    limitPerIp(req);
    const g = pairStartGlobal.take("global");
    if (g) throw new HttpError(429, "busy, try again shortly", { "retry-after": String(g) });
    const token = newToken();
    const tokenHash = hashToken(config.pepper, token);
    let code = newPairCode();
    while (store.getPairing(hashCode(config.pepper, code))) code = newPairCode();
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
    const locked = pairLock.locked();
    if (locked) throw new HttpError(429, "too many failed pairing attempts, try again shortly", { "retry-after": String(locked) });
    limitPerIp(req);
    try {
      await redeem(req, res);
    } catch (e) {
      if (e instanceof HttpError && KNOWN_FAILURE.has(e.status)) pairLock.fail();
      throw e;
    }
  }

  async function redeem(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, config.maxBodyBytes);
    const v = validatePairRequest(body);
    if (!v.ok) throw new HttpError(400, v.error);
    const code = normalizeCode(v.value.code);
    if (!code) throw new HttpError(400, "code must look like ABC-234");
    const key = hashCode(config.pepper, code);
    const p = store.getPairing(key);
    if (!p) throw new HttpError(404, "unknown pairing code");
    if (p.used_at !== null || !p.sealed) throw new HttpError(410, "pairing code already used");
    if (p.expires_at <= now()) {
      store.deletePairing(key);
      throw new HttpError(410, "pairing code expired");
    }
    if (!store.findToken(p.token_hash)) {
      store.deletePairing(key);
      throw new HttpError(410, "pairing was cancelled");
    }
    const token = openForCode(config.pepper, code, p.sealed);
    if (!token) throw new HttpError(404, "unknown pairing code");
    // Single use: drop the ciphertext, keep a tombstone until expiry so reuse gets 410.
    if (!store.redeemPairing(key)) throw new HttpError(410, "pairing code already used");
    store.markPaired(p.token_hash);
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
    const seq = store.putState(tokenHash, stored, config.maxAgentsPerToken, config.maxSessionsPerAgent);
    store.touchToken(tokenHash);
    // The message goes out live only; it is never stored.
    broadcast(tokenHash, "state", message ? { ...stored, message } : stored, eventId(seq));
    sendJson(res, 202, { ok: true });
  }

  function stream(req: IncomingMessage, res: ServerResponse): void {
    if (closing) throw new HttpError(503, "shutting down", { "retry-after": "3" });
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
    // Catch-up. With a valid Last-Event-ID only the states that changed since are resent;
    // otherwise (first connect, other epoch, garbage) the full last-known state is sent.
    const after = parseLastEventId(req.headers["last-event-id"] as string | undefined, store.epoch, store.currentSeq());
    const catchup = store.snapshot(tokenHash, after);
    for (const s of catchup) sse(res, "state", s.state, eventId(s.seq));
    sse(res, "ready", {
      resumed: after > 0,
      states: catchup.length,
      paired: store.findToken(tokenHash)?.paired_at != null,
      version: VERSION,
    });
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

  function health(_req: IncomingMessage, res: ServerResponse): void {
    const ok = store.ping();
    sendJson(res, ok ? 200 : 503, { ok, version: VERSION, db: ok ? "ok" : "error" });
  }

  /** CORS is off unless DESKPET_CORS_ORIGINS lists exact origins (dev: vite on :1420). */
  function cors(req: IncomingMessage, res: ServerResponse): boolean {
    if (config.corsOrigins.length === 0) return false;
    res.setHeader("vary", "Origin");
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization, content-type, last-event-id");
      res.setHeader("access-control-max-age", "600");
    }
    return true;
  }

  type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  const routes: Record<string, Record<string, Handler>> = {
    "/health": { GET: health },
    "/livez": { GET: (_req, res) => sendJson(res, 200, { ok: true }) },
    "/v1/pair/start": { POST: pairStart },
    "/v1/pair": { POST: pair },
    "/v1/events": { POST: postEvent },
    "/v1/stream": { GET: stream },
    "/v1/unpair": { POST: unpair },
  };

  const server = createServer(async (req, res) => {
    const started = now();
    const rawPath = (req.url ?? "/").split("?")[0]!;
    // Only known route names are logged verbatim: an unknown path could carry anything.
    const route = Object.hasOwn(routes, rawPath) ? routes[rawPath]! : null;
    const path = route ? rawPath : "(unmatched)";
    if (config.log) {
      res.once("close", () =>
        log(config, res.statusCode >= 500 ? "error" : "info", "request", {
          method: (req.method ?? "?").slice(0, 8),
          path,
          status: res.statusCode,
          ms: now() - started,
          ip: ipTag(config.pepper, clientIp(req)),
        }),
      );
    }
    try {
      const corsOn = cors(req, res);
      if (req.method === "OPTIONS" && corsOn) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!route) throw new HttpError(404, "not found");
      const h = route[req.method ?? ""];
      if (!h) throw new HttpError(405, "method not allowed", { allow: Object.keys(route).join(", ") });
      await h(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 413) res.once("finish", () => req.destroy());
        sendJson(res, e.status, { ok: false, error: e.message }, e.headers);
      } else {
        log(config, "error", "handler error", { path, error: (e as Error)?.name ?? "Error" });
        sendJson(res, 500, { ok: false, error: "internal error" });
      }
    }
  });

  function sweep(): void {
    try {
      const r = store.sweep(config.stateTtlMs);
      if (config.log && (r.pairings || r.states || r.tokens)) log(config, "info", "sweep", r);
    } catch (e) {
      log(config, "error", "sweep failed", { error: (e as Error)?.name ?? "Error" });
    }
    eventLimiter.sweep();
    pairLimiter.sweep();
  }
  const sweeper = setInterval(sweep, config.sweepMs);
  sweeper.unref();

  return {
    server,
    store,
    config,
    sweep,
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
      closing = true;
      clearInterval(sweeper);
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const set of subs.values()) {
        for (const s of set) {
          clearInterval(s.ping);
          if (!s.res.writableEnded) s.res.end(": shutting down\n\n");
        }
      }
      subs.clear();
      server.closeIdleConnections();
      // Anything still open after a short grace (slow clients) is cut.
      const cut = setTimeout(() => server.closeAllConnections(), 500);
      cut.unref();
      return done.then(() => {
        clearTimeout(cut);
        if (store.db.isOpen) {
          sweep();
          store.close();
        }
      });
    },
  };
}
