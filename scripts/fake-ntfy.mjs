#!/usr/bin/env node
// A tiny local stand-in for ntfy (https://ntfy.sh), enough for Desk Pet v2 tests:
//   POST|PUT /<topic>             publish (body = message, max 4096 bytes like ntfy; bigger
//                                 bodies become an "attachment" as on ntfy.sh)
//   GET /<topic>/sse?since=...    SSE: "open", cached messages per since=, live, keepalives
//   GET /<topic>/json?poll=1      cached messages as JSON lines
// since= accepts all | <n>s/m/h | <unix seconds> | <message id> (unknown id: everything).
//
//   node scripts/fake-ntfy.mjs [--port 0] [--keepalive 45]   prints "listening http://127.0.0.1:<port>"
//
// It never logs message bodies. Programmatic use: import { startFakeNtfy } from "./fake-ntfy.mjs".
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
const MAX_MESSAGE = 4096;

const newId = () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join("");
};

export async function startFakeNtfy({ port = 0, keepaliveMs = 45_000 } = {}) {
  const topics = new Map(); // topic -> messages[]
  const subs = new Map(); // topic -> Set<res>
  const requests = []; // {method, path, headers} (no bodies)
  const state = { mode: "ok" }; // "ok" | "429" | "500"

  const list = (t) => topics.get(t) ?? topics.set(t, []).get(t);

  function sinceFilter(msgs, since) {
    if (since === undefined || since === "" || since === "none") return [];
    if (since === "all") return msgs;
    const d = /^(\d+)([smh])$/.exec(since);
    if (d) {
      const cut = Date.now() / 1000 - Number(d[1]) * { s: 1, m: 60, h: 3600 }[d[2]];
      return msgs.filter((m) => m.time >= cut);
    }
    if (/^\d{9,}$/.test(since)) return msgs.filter((m) => m.time >= Number(since));
    const i = msgs.findIndex((m) => m.id === since);
    return i >= 0 ? msgs.slice(i + 1) : msgs;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const parts = u.pathname.split("/").filter(Boolean);
    requests.push({ method: req.method, path: u.pathname, headers: { ...req.headers } });
    const topic = parts[0];
    if (!topic || !TOPIC_RE.test(topic)) {
      res.writeHead(404).end();
      return;
    }
    if ((req.method === "POST" || req.method === "PUT") && parts.length === 1) {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size <= 64 * 1024) chunks.push(c);
      });
      req.on("end", () => {
        if (state.mode !== "ok") {
          const code = Number(state.mode);
          res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify({ code, http: code, error: "fake" }));
          return;
        }
        const body = Buffer.concat(chunks);
        const time = Math.floor(Date.now() / 1000);
        const msg = { id: newId(), time, expires: time + 43200, event: "message", topic };
        if (body.length > MAX_MESSAGE) {
          msg.message = "You received a file: attachment.txt";
          msg.attachment = { name: "attachment.txt", size: body.length };
        } else {
          msg.message = body.toString("utf8");
        }
        list(topic).push(msg);
        for (const s of subs.get(topic) ?? []) s.write(`data: ${JSON.stringify(msg)}\n\n`);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg) + "\n");
      });
      return;
    }
    if (req.method === "GET" && parts[1] === "sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const open = { id: newId(), time: Math.floor(Date.now() / 1000), event: "open", topic };
      res.write(`event: open\ndata: ${JSON.stringify(open)}\n\n`);
      for (const m of sinceFilter(list(topic), u.searchParams.get("since") ?? undefined)) res.write(`data: ${JSON.stringify(m)}\n\n`);
      const set = subs.get(topic) ?? subs.set(topic, new Set()).get(topic);
      set.add(res);
      const ka = setInterval(() => {
        const k = { id: newId(), time: Math.floor(Date.now() / 1000), event: "keepalive", topic };
        res.write(`event: keepalive\ndata: ${JSON.stringify(k)}\n\n`);
      }, keepaliveMs);
      const done = () => {
        clearInterval(ka);
        set.delete(res);
      };
      req.on("close", done);
      res.on("close", done);
      return;
    }
    if (req.method === "GET" && parts[1] === "json") {
      const out = sinceFilter(list(topic), u.searchParams.get("since") ?? (u.searchParams.has("poll") ? "all" : undefined));
      res.writeHead(200, { "content-type": "application/x-ndjson" }).end(out.map((m) => JSON.stringify(m) + "\n").join(""));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const addr = server.address();
  return {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    topics,
    requests,
    setMode(m) {
      state.mode = m;
    },
    /** End live streams (simulate a dropped connection). */
    dropStreams() {
      for (const set of subs.values()) for (const s of set) s.destroy();
    },
    close() {
      for (const set of subs.values()) for (const s of set) s.destroy();
      return new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : def;
  };
  const f = await startFakeNtfy({ port: Number(arg("--port", "0")), keepaliveMs: Number(arg("--keepalive", "45")) * 1000 });
  process.stdout.write(`listening ${f.url}\n`);
  const stop = () => f.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
