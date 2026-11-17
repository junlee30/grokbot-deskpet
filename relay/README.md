# Desk Pet relay (v1): DEPRECATED

> **Deprecated (2026-11-16).** Desk Pet v2 (the private, end-to-end encrypted ntfy mailbox) is
> the default and needs no Desk Pet server: see the [main README](../README.md). The hosted v1
> relay has been **shut down**; there is no public relay any more.
>
> This code stays for people who want to **run their own relay**. It still works, but it gets no
> new features, the Grok Bot skill (`skill/SKILL.md`) no longer pairs with v1 codes, and the
> desktop app only offers v1 under ⚙ → **Legacy: self-hosted relay (deprecated)**. New setups
> should use v2 (⚙ → **Pair**).

Node 24 + TypeScript, no runtime dependencies (`node:http`, `node:crypto`, `node:sqlite`).
Bots `POST` small JSON status events with a bearer token; the desktop app's Rust side holds a
long-lived SSE stream (token in the macOS Keychain, never in a URL) and draws one pet per bot.

```
 Grok Bot                            relay (Node 24)                  desktop (Tauri v2, macOS)
 ────────                            ───────────────                  ─────────────────────────
 pair once   POST /v1/pair    ────▶  pairing codes (15 min, 1 use)    Rust: POST /v1/pair/start
                                     token = HMAC-hashed at rest  ◀── token → macOS Keychain
 post status POST /v1/events  ────▶  validate · rate-limit ·          Rust: GET /v1/stream (SSE)
             Bearer token            SQLite: last state per bot ────▶  Tauri events → webview
```

## Running your own relay

Locally (SQLite + a dev pepper in `relay/data/`, CORS only for the browser prototype):

```bash
scripts/dev.sh relay           # → http://127.0.0.1:8787 (foreground, Ctrl-C to stop)
cd relay && npm test           # tsc + node:test: auth, schema, limits, pairing, persistence,
                               #   migrations, SSE ids/resume, health, CORS, logs, config
```

Production-like (CORS off, pepper never echoed):

```bash
cd relay
NODE_ENV=production DESKPET_PEPPER="$(openssl rand -base64 48)" DESKPET_DB="$(mktemp -d)/deskpet.sqlite" npm start
```

**Hosting it yourself.** `Dockerfile` builds a small image (the build runs the test suite; the
server runs as the unprivileged `node` user). `fly.toml` is an **example** for Fly.io with a
placeholder app name, `your-deskpet-relay`: change the app name and `DESKPET_PUBLIC_URL`, set a
fresh `DESKPET_PEPPER` (≥ 32 chars) as a secret, and keep it to **one machine** (state is SQLite
on one volume). Nothing in this repo deploys anything.

Then in the desktop app: ⚙ → **Legacy: self-hosted relay (deprecated)** → Relay URL (your
`https://` URL, or **Local** for `http://127.0.0.1:8787`) → **Pair**. The paste line it shows
always names your relay (`Pair with my self-hosted Desk Pet relay <url> using code K7Q-42M`). A token belongs to one
relay: changing the URL revokes the old token (best effort) and means pairing again.

## Pairing flow

Two steps. The relay only creates codes in step 1.

1. **Desktop**: in ⚙ → **Legacy: self-hosted relay (deprecated)**, the user enters their
   relay URL and clicks **Pair**. The app's Rust side calls
   `POST /v1/pair/start` and gets `{code, token, expires_at}`. It stores the token in the
   Keychain, passes only the code to the UI, and shows one line to paste to the bot (with a
   Copy button):
   `Pair with my self-hosted Desk Pet relay https://your-relay.example using code K7Q-42M`.
2. **Bot**: `POST /v1/pair {code, agent_id?, agent_name?}` exchanges the code for the same
   token plus `relay_url` (`DESKPET_PUBLIC_URL`). The desktop gets an `event: paired` on its
   stream.

Codes use an unambiguous alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, no 0/O/1/I/L), are
**single use** and **expire after 15 minutes**. Responses: `400` malformed, `404` unknown,
`410` already used / expired / cancelled, `429` too many attempts. Limits:

- **10/min per client IP**.
- **Global lock**: 30 failed redemptions from any IPs within 1 min lock `/v1/pair` for everyone
  for 1 min.
- **New pairings**: at most 120/min globally.

## API

All bodies are JSON (`Content-Type: application/json`), max **4 KiB**.

| method & path         | auth   | purpose |
| --------------------- | ------ | ------- |
| `GET /health`         | none   | `{ok, version, db:"ok"}`; `503` with `db:"error"` if the database check fails |
| `GET /livez`          | none   | `{ok:true}`, no dependencies |
| `POST /v1/pair/start` | none   | desktop: new code + token → `201 {code, token, expires_at}` |
| `POST /v1/pair`       | none   | bot: `{code, agent_id?, agent_name?}` → `200 {token, relay_url, agent_id}` |
| `POST /v1/events`     | Bearer | bot status → `202 {ok:true}` |
| `GET /v1/stream`      | Bearer | SSE: see below |
| `POST /v1/unpair`     | Bearer | revoke the token now and close its streams |

### Event schema (`POST /v1/events`)

| field        | type   | rules |
| ------------ | ------ | ----- |
| `agent_id`   | string | required, `[a-z0-9_-]{1,64}`; legacy alias `bot` accepted |
| `agent_name` | string | optional, ≤ 64, defaults to `agent_id` |
| `session`    | string | required, ≤ 128 |
| `state`      | enum   | `idle thinking working juggling needs_you done error sleeping` |
| `event`      | string | required, ≤ 64, e.g. `turn_start tool_start helper_start waiting turn_end error heartbeat` |
| `message`    | string | optional, ≤ 160 chars, no control chars; shown as a toast, **never stored** |
| `ts`         | string | required, ISO-8601 |
| `avatar`     | object | optional (relay ≥ 0.3.0), exactly `{shape, color}`; `shape` one of `arch bean blob capsule cloud clover crystal cylinder dome egg flower gem heart hex house leaf pebble pumpkin shield sparkle square squircle star tablet teardrop wedge`, `color` one of `black brown red orange yellow green cyan blue violet magenta gray` (case-insensitive, stored lowercase); `null` = not sent |

The relay keeps the **latest avatar per bot** (any session) and attaches it to every `state`
event for that bot, live and in catch-up, so the desktop gets it even from sessions that didn't
send it. It is forgotten with the bot's states (24 h silence, agent eviction) and on unpair.
Relays before 0.3.0 reject `avatar` as an unknown field; `scripts/demo.sh --v1` checks the
relay version and doesn't send it to them.

Unknown fields → `400`. Errors: `400` schema/JSON, `401` missing/bad/revoked token, `413` body
> 4 KiB (enforced while streaming), `415` not JSON, `429` rate limit (token bucket **60/min,
burst 20** per token; `Retry-After` header).

Stream: up to **3 subscribers per token** (the 4th gets `429`). Events:

- `retry: 3000`, then the **catch-up** `event: state` for each (agent, session), oldest first,
  without messages.
- `event: ready` `{resumed, states, paired, version}`.
- Then live `event: state`, `event: paired`, `event: ping` every 15 s, and `event: revoked`.

State events carry `id: <db-epoch>-<seq>`. With a matching `Last-Event-ID`, catch-up resends
only the states that changed since that id. With a foreign, future or garbage id it sends
everything. State for a bot silent for **24 h** is dropped.

## Configuration (env)

| var | default | |
| --- | ------- | - |
| `NODE_ENV` / `DESKPET_ENV` | | `production` turns on the production rules below |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | |
| `DESKPET_DB` | dev `./data/deskpet.sqlite`, prod `/data/deskpet.sqlite` | SQLite file (`:memory:` for none) |
| `DESKPET_PEPPER` | see below | HMAC pepper. **Production: required, ≥ 32 chars, or the relay refuses to start** (exit 78, the value is never echoed) |
| `DESKPET_PUBLIC_URL` | request `Host` | `relay_url` returned to bots (e.g. `https://your-deskpet-relay.fly.dev`) |
| `DESKPET_CORS_ORIGINS` | *(none: CORS off)* | exact origins, comma-separated. Only the browser prototype needs it |
| `DESKPET_TRUST_PROXY` | `0` | `1` = per-IP limits use `Fly-Client-IP` (only behind Fly's proxy) |
| `DESKPET_RATE_PER_MIN` / `DESKPET_RATE_BURST` | `60` / `20` | event rate limit per token |
| `DESKPET_PAIR_RATE_PER_MIN` / `DESKPET_PAIR_RATE_BURST` | `10` / `10` | pairing attempts per IP |
| `DESKPET_PAIR_GLOBAL_FAIL_MAX` / `_WINDOW_MS` / `_LOCK_MS` | `30` / `60000` / `60000` | global failed-code lock |
| `DESKPET_PAIR_START_GLOBAL_PER_MIN` | `120` | new pairings per minute, all IPs |
| `DESKPET_PING_MS` / `DESKPET_SWEEP_MS` | `15000` / `60000` | SSE heartbeat / cleanup interval |
| `DESKPET_MAX_SUBSCRIBERS` | `3` | per token |
| `DESKPET_LOG` | `1` | `0` silences the request log |

**Pepper in dev.** With no `DESKPET_PEPPER` and a database file, the relay creates a random
pepper on first start and keeps it in `data/dev-pepper`, next to the database. The file is
mode `0600` and gitignored, so tokens keep working across dev restarts. Delete `relay/data/`
to start fresh. Every existing pairing then dies, so re-pair.

**Persistence.** `tokens` holds the HMAC, created/paired/last-seen/revoked times. `pairings`
holds the code HMAC, the AES-GCM-sealed token (deleted on redemption) and the expiry. `states`
holds the last state per token/agent/session, never message bodies. `meta` holds the schema
version, the stream epoch and the event sequence. Migrations are ordered and idempotent
(`PRAGMA user_version`) and upgrade the M0 file in place. A sweep every minute does the
cleanup:

- drops expired pairings
- drops states silent for 24 h
- retires tokens whose code was never redeemed (after 1 h)
- purges revoked rows after 7 days

**Logs.** One JSON line per request: `ts, level, msg, method, path, status, ms, ip`.

- `path` is the route name, or `(unmatched)`, and never includes a query string.
- `ip` is a 12-hex keyed hash, not the address.
- Headers, tokens, codes and bodies are never logged. Tests assert this.

**Shutdown.** On `SIGTERM`/`SIGINT` the relay stops accepting connections and ends every SSE
stream (clients reconnect with `Last-Event-ID`). It then runs a final sweep, checkpoints the
WAL and closes the database.

## CORS model

The relay sends **no** `Access-Control-*` headers unless `DESKPET_CORS_ORIGINS` lists an
origin. The native app doesn't need CORS, because all relay HTTP and SSE runs in Rust and the
webview only talks to Rust over Tauri IPC. Its CSP `connect-src` is IPC-only. The only client
that needs CORS is the **browser prototype** (vite on `:1420`). `scripts/dev.sh` (relay) allows
exactly `http://localhost:1420` and `http://127.0.0.1:1420`, and production leaves it unset.

## Bot side (manual)

The Grok Bot skill no longer handles v1 codes (it tells the user to make a v2 code instead). If
you run your own relay and want a bot to post to it, give the bot these instructions yourself.

Exchange the code once (only `https://` URLs, or `http://` for `localhost`):

```bash
RELAY="https://your-relay.example"     # the URL from the paste line
RESP="$(curl -sS -m 5 -X POST "$RELAY/v1/pair" \
  -H 'Content-Type: application/json' \
  -d '{"code":"K7Q-42M","agent_id":"jarvis","agent_name":"Jarvis"}')"
```

`200 {token, relay_url, agent_id}` on success; `400` malformed code, `404` unknown, `410` used
or expired, `429` slow down. Store `token` as `DESK_PET_TOKEN` and `relay_url` as
`DESK_PET_RELAY_URL` in the bot's secret store, without printing them, then `unset RESP`.

Post status (fails open, 3 s max; the token comes from the environment only):

```bash
desk_pet() {  # usage: desk_pet <state> <event> [message]
  [ -n "${DESK_PET_TOKEN:-}" ] && [ -n "${DESK_PET_RELAY_URL:-}" ] || return 0
  local body
  body="$(jq -nc --arg s "${DESK_PET_SESSION:-default}" --arg st "$1" --arg ev "$2" --arg msg "${3:-}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson av "${DESK_PET_AVATAR:-null}" \
    '{agent_id: "jarvis", agent_name: "Jarvis", session: $s, state: $st, event: $ev, ts: $ts}
     + (if $msg != "" then {message: $msg} else {} end)
     + (if $av != null then {avatar: $av} else {} end)')" || return 0
  curl -sS -m 3 -o /dev/null -X POST "$DESK_PET_RELAY_URL/v1/events" \
    -H "Authorization: Bearer $DESK_PET_TOKEN" -H 'Content-Type: application/json' \
    --data-binary "$body" >/dev/null 2>&1 || true
}
```

States, events and the `message` privacy rules are the same as in `skill/SKILL.md`. A `401`
means the pairing was revoked (Unpair in the app): stop posting and delete both secrets. Bots
heartbeat every ~60 s during long turns; the relay allows 60 events/min (burst 20) per token.
`scripts/demo.sh --v1` plays three fake bots against your relay (`RELAY_URL` required).

## Security notes

- Tokens: 32 random bytes, base64url. The relay stores only `HMAC-SHA-256(pepper, token)` and
  compares in constant time. Until a code is redeemed, the token is held only **encrypted**
  (AES-256-GCM, key derived from pepper + code), and the ciphertext is deleted on redemption
  or expiry. Tests assert the raw token never appears in the in-memory store or the SQLite file.
- Tokens travel only in `Authorization: Bearer`, never in query strings (the stream ignores
  `?token=`). The relay never logs headers, bodies, query strings or raw client IPs.
- The relay fails closed: in production it won't start without a pepper of at least 32
  characters. Changing the pepper invalidates every token.
- Desktop: the token lives in the macOS Keychain (service `com.grokbot.deskpet`, account
  `relay-token:<relay host[:port]>`) and in the Rust process only; the webview never sees it.
- `message` bodies are forwarded live and never stored. Last-known state drops after 24 h.
- CORS is off unless explicitly configured (see "CORS model").
- Pairing brute force: 31⁶ ≈ 887M codes, each living 15 min. Attempts are throttled per IP and
  by a global failed-attempt lock.
- Unpair (Settings → Legacy) revokes the token server-side immediately and closes its streams.
