# Desk Pet for Grok Bot

*Working title. Unofficial side project, not affiliated with or endorsed by xAI.*

A tiny always-on-top desktop pet that shows **one pixel-art Grok Bot per bot** and animates it
from the bots' lifecycle status: thinking, working, juggling helpers, waiting on you, done,
error, sleeping. Click a pet to open its link (default `https://grok.com`).

Status: **M1**. The relay is production-ready but **not deployed**. The native macOS app keeps
its token in the Keychain. Original code and art, Apache-2.0 (see `LICENSE`).

What M1 adds:

- **Persistent relay**: SQLite. Pairings survive a restart and catch-up works after one.
- **Hardened relay**:
  - production refuses to start without a strong pepper
  - global pairing brute-force lock
  - CORS off by default
  - structured JSON logs
  - SSE event ids with `Last-Event-ID` resume
  - graceful shutdown
- **Rust relay client** in the desktop app: the token lives in the macOS Keychain and never
  enters the webview.
- **Desktop**: toasts that never overlap or clip, a relay URL setting (Local / Hosted), and the
  window position remembered across restarts.
- **Art**: a new original pixel-art robot.
- **Deploy**: a reviewed deploy plan for the future hosted relay (`.runs/m1-deploy-plan.md`).

## Architecture

```
 Grok Bot (cloud)                    relay (Node 24)                  desktop (Tauri v2, macOS)
 ────────────────                    ───────────────                  ─────────────────────────
 skill/SKILL.md      POST /v1/pair   pairing codes (15 min, 1 use)    Rust: POST /v1/pair/start
   pair once  ────────────────────▶  token = HMAC-hashed at rest  ◀── token → macOS Keychain
   post status ──── POST /v1/events ▶ validate · rate-limit ·         Rust: GET /v1/stream (SSE)
                    Bearer token      SQLite: last state per bot ────▶  Tauri events → webview
                                                                       one pet per agent_id
```

Bots run in the cloud and can't reach `localhost`, so both sides talk to a **relay**. The
desktop's Rust side opens a long-lived SSE stream (`reqwest`, token in the `Authorization`
header, never in a URL) and forwards events to the webview. Bots `POST` small JSON status
events.

```
relay/      Node 24 + TypeScript, no runtime deps (node:http, node:crypto, node:sqlite)
desktop/    Tauri v2 app; frontend is Vite + TypeScript, no framework
  art/build-sprites.mjs   generates the pixel-art spritesheets (no deps)
  public/sprites/         grokbot_<state>.png + _accent.png + manifest.json (see its README)
  src/layout.ts           pure pet/toast layout (unit-tested in test/)
  src-tauri/src/relay.rs  relay HTTP + SSE client (backoff, Last-Event-ID, wake detection)
  src-tauri/src/secrets.rs  Keychain (keyring crate)
  src-tauri/src/window_state.rs  window position memory
skill/SKILL.md            draft Grok Bot skill: pairing + when/how to post status
scripts/demo.sh           fake bots (Jarvis, Claude, Scout) cycling through states
scripts/dev.sh            start relay / web prototype / tauri dev / tests
```

## Pairing flow

Two steps. The relay only creates codes in step 1.

1. **Desktop**: the user clicks **Connect your Grok Bot**. The app's Rust side calls
   `POST /v1/pair/start` and gets `{code, token, expires_at}`. It stores the token in the
   Keychain, passes only the code to the UI, and shows one line to paste to the bot (with a
   Copy button):
   `Install the Desk Pet skill and pair with code K7Q-42M`.
   When the app isn't on the hosted relay, the line adds `using relay <url>`.
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

### Relay configuration (env)

| var | default | |
| --- | ------- | - |
| `NODE_ENV` / `DESKPET_ENV` | | `production` turns on the production rules below |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | |
| `DESKPET_DB` | dev `./data/deskpet.sqlite`, prod `/data/deskpet.sqlite` | SQLite file (`:memory:` for none) |
| `DESKPET_PEPPER` | see below | HMAC pepper. **Production: required, ≥ 32 chars, or the relay refuses to start** (exit 78, the value is never echoed) |
| `DESKPET_PUBLIC_URL` | request `Host` | `relay_url` returned to bots (prod: `https://grokbot-deskpet-relay.fly.dev`) |
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

### CORS model

The relay sends **no** `Access-Control-*` headers unless `DESKPET_CORS_ORIGINS` lists an
origin. The native app doesn't need CORS, because all relay HTTP and SSE runs in Rust and the
webview only talks to Rust over Tauri IPC. Its CSP `connect-src` is IPC-only. The only client
that needs CORS is the **browser prototype** (vite on `:1420`). `scripts/dev.sh` (relay) allows
exactly `http://localhost:1420` and `http://127.0.0.1:1420`, and production leaves it unset.

## Running it

Requirements: Node 24, and for the native app Rust + `cargo install tauri-cli --version ^2`.

```bash
# 1. relay (foreground, Ctrl-C to stop)
scripts/dev.sh                 # relay → http://127.0.0.1:8787 (SQLite + dev pepper in relay/data/)

# 2a. desktop app (native, macOS)
scripts/dev.sh tauri           # = cd desktop && npm install && cargo tauri dev
#     or build a debug .app:
cd desktop && cargo tauri build --debug
open "desktop/src-tauri/target/debug/bundle/macos/Desk Pet for Grok Bot.app"

# 2b. or the same UI as a plain web prototype (no Rust needed; token in memory only,
#     so a page reload means pairing again)
scripts/dev.sh web             # = cd desktop && npm run dev → http://localhost:1420

# 3. click "Connect your Grok Bot", note the code, then play the bots:
scripts/demo.sh K7Q-42M        # or DESKPET_CODE=K7Q-42M scripts/demo.sh ; add --fast for short sleeps
```

`scripts/demo.sh` with **no code** creates a pairing itself, keeps the token in a shell variable,
prints **only the code** (plus a ready `curl` line to redeem it by hand and test the bot
side), and runs the demo on its own token. `RELAY_URL` overrides the relay address.

Tests:

```bash
cd relay && npm test           # tsc + node:test: auth, schema, limits, pairing, persistence, migrations,
                               #   SSE ids/resume, health, CORS, logs, config
cd desktop && npm test         # node:test: toast/pet layout, relay URL validation, backoff
cd desktop && npm run build    # tsc + vite build
cd desktop/src-tauri && cargo test   # SSE parser, backoff, URL validation, keychain naming, window clamp
```

Production-like relay locally (CORS off, pepper never echoed):

```bash
cd relay
NODE_ENV=production DESKPET_PEPPER="$(openssl rand -base64 48)" DESKPET_DB="$(mktemp -d)/deskpet.sqlite" npm start
```

Regenerate sprites: `cd desktop && npm run sprites` (writes `public/sprites/*`,
`art/preview.png`, `art/icon-1024.png`; re-run `cargo tauri icon art/icon-1024.png -o src-tauri/icons`
for app icons).

## Desktop behaviour

- Transparent, frameless, always-on-top 360×200 window. Drag anywhere (background or a pet) to
  move it. **The position is remembered** across restarts in the app config dir
  (`window.json`). On launch it's restored only if it is on a connected monitor, and clamped
  fully onto that monitor. Otherwise the window is centred. There is no Dock icon on macOS, so
  quit from the ⚙ settings panel (hover the window).
- One pet per `agent_id`, each in its own column, name under it, accent colour per bot (Jarvis
  teal, Claude orange, Scout violet, others hashed into a fixed palette). Frames are 32×32 at
  integer 3×, 2× or 1×, whichever fits; ⚙ **Pet size** caps it at Large (3×) or Small (2×).
  Up to 9 pets fit side by side and the rest show as "+N more". The left-to-right order is
  remembered.
- **Toasts** (`message`, 5 s): one per pet, the newest replaces the previous one. A toast sits
  above its own pet inside that pet's column and is clamped inside the window, so toasts
  never overlap each other or clip at the edge. Text is at most 2 lines with an ellipsis (full
  text in the tooltip). The layout is a pure function in `src/layout.ts`, unit-tested for 1–16
  pets.
- Multiple sessions per bot: the highest-priority state wins:
  `needs_you > error > juggling > working > thinking > done > idle`. Active states with no
  update for 10 min count as idle (bots send heartbeats every 60 s in long turns).
- `done` plays once, then idle. Idle for 5 min (30 s in `vite` dev) → sleeping.
- **Connection**:
  - Relay down: pets dim to the offline sprite with "offline · retrying".
  - Reconnect: exponential backoff, 0.5–1 s doubling up to 30 s, with jitter. A 45 s silence
    watchdog catches dead connections. Resuming sends `Last-Event-ID`.
  - Reconnects immediately on wake from sleep (the Rust side detects the wall-clock jump), on
    the `online` event and when the window becomes visible.
  - 401 or `revoked`: the token is deleted from the Keychain and the app returns to the
    pairing screen.
- **Relay URL** (⚙): defaults to `http://127.0.0.1:8787`.
  - Presets: **Local**, and **Hosted (not deployed yet)** = `https://grokbot-deskpet-relay.fly.dev`.
  - Validation: https is required, except plain http for localhost. No path, query or
    credentials.
  - **Changing the relay means pairing again**, because a token belongs to one relay host. The
    old token is revoked at the old relay (best effort) and removed from the Keychain.
- Click (not drag) a pet → opens its URL via `tauri-plugin-opener` (capability allows only
  `http(s)://*`). Configure in `desktop/public/deskpet.config.json`
  (`openUrls.default`, `openUrls.agents.{agent_id}`) or in the settings panel. Default
  fallback is `https://grok.com`. There are no invented per-bot deep links.

### Keychain

- The token is stored as service `com.grokbot.deskpet`, account
  `relay-token:<relay host[:port]>`, for example `relay-token:127.0.0.1:8787`. You can see it in
  Keychain Access.
- The Rust side reads it to authenticate pairing, the stream and unpair. It is never sent to
  the webview, logged, or put in an error message.
- **Upgrading from M0.** On first launch, a token still in webview `localStorage` is moved into
  the Keychain and deleted from `localStorage`. The M0 relay kept pairings in memory only, so
  that token is almost certainly dead. The first 401 then clears it and shows **Connect your
  Grok Bot**: click it and give the bot the new code (a one-time re-pair).
- Unsigned debug builds get a new code signature on every rebuild. macOS may then ask once
  per build whether the app may use its Keychain item ("Always Allow").

## Security notes

- Tokens: 32 random bytes, base64url. The relay stores only `HMAC-SHA-256(pepper, token)` and
  compares in constant time. Until a code is redeemed, the token is held only **encrypted**
  (AES-256-GCM, key derived from pepper + code), and the ciphertext is deleted on redemption
  or expiry. Tests assert the raw token never appears in the in-memory store or the SQLite file.
- Tokens travel only in `Authorization: Bearer`, never in query strings (the stream ignores
  `?token=`). The relay never logs headers, bodies, query strings or raw client IPs.
- The relay fails closed: in production it won't start without a pepper of at least 32
  characters. Changing the pepper invalidates every token.
- Desktop: the token lives in the macOS Keychain and in the Rust process only, so the webview
  (and any script in it) can't read it.
- `message` bodies are forwarded live and never stored. Last-known state drops after 24 h.
- `scripts/demo.sh` keeps the token in a variable, never echoes it, and passes the header to
  curl through a process substitution so it doesn't show up in `ps`.
- CORS is off unless explicitly configured (see "CORS model"). The Tauri CSP limits
  `connect-src` to IPC.
- Pairing brute force: 31⁶ ≈ 887M codes, each living 15 min. Attempts are throttled per IP and
  by a global failed-attempt lock.
- Unpair (settings) revokes the token server-side immediately and closes its streams.

## Deploy (not done)

`relay/Dockerfile` and `relay/fly.toml` are for a *future, standalone* Fly app,
`grokbot-deskpet-relay`.

- **It is NOT deployed, and deploying requires Jun's explicit approval.**
- It shares nothing with `jarvis-scheduler`, and nothing in this repo runs `fly`.
- It is a single machine (`--ha=false`), because state is SQLite on one volume.

The exact, reviewed command list, cost estimate (about $2–3/month) and teardown are in
`.runs/m1-deploy-plan.md`. Until it is deployed, the **Hosted** preset and the skill's default
relay won't answer.

## Known gaps

- **Signing / notarization**: the debug `.app` is unsigned (Keychain may prompt after each
  rebuild); only the `app` bundle target is built (no dmg).
- The Docker image hasn't been built locally (no Docker here). Fly's remote builder will
  build it, and the build runs the test suite.
- macOS only so far (keyring is built with `apple-native`). Windows/Linux untested. No tray
  icon, no autostart.
- The browser prototype keeps its token in memory only, so a reload means pairing again.

## License

Apache-2.0. See [LICENSE](LICENSE).
