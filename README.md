# Desk Pet for Grok Bot

*Working title. Unofficial side project, not affiliated with or endorsed by xAI.*

A tiny always-on-top desktop pet that shows **one pixel-art Grok Bot per bot** and animates it
from the bots' lifecycle status: thinking, working, juggling helpers, waiting on you, done,
error, sleeping. Click a pet to open its link (default `https://grok.com`).

Status: **M0**, a local-dev prototype. Original code and art, Apache-2.0 (see `LICENSE`).

## Architecture

```
 Grok Bot (cloud)                    relay (Node 24)                  desktop (Tauri v2, macOS)
 ────────────────                    ───────────────                  ─────────────────────────
 skill/SKILL.md      POST /v1/pair   pairing codes (15 min, 1 use)    POST /v1/pair/start
   pair once  ────────────────────▶  token = HMAC-hashed at rest  ◀── shows "pair with code K7Q-42M"
   post status ──── POST /v1/events ▶ validate · rate-limit ·         GET /v1/stream (SSE, Bearer)
                    Bearer token      last-known state per bot  ────▶  one pet per agent_id
```

Bots run in the cloud and can't reach `localhost`, so both sides talk to a **relay**. The
desktop opens a long-lived SSE stream (with `fetch` + `ReadableStream` so the token goes in the
`Authorization` header, never in a URL). Bots `POST` small JSON status events.

```
relay/      Node 24 + TypeScript, no runtime deps (node:http, node:crypto, optional node:sqlite)
desktop/    Tauri v2 app; frontend is Vite + TypeScript, no framework
  art/build-sprites.mjs   generates the placeholder spritesheets (no deps)
  public/sprites/         grokbot_<state>.png + _accent.png + manifest.json (see its README)
  src-tauri/              Rust shell: transparent window + opener plugin
skill/SKILL.md            draft Grok Bot skill: pairing + when/how to post status
scripts/demo.sh           fake bots (Jarvis, Claude, Scout) cycling through states
scripts/dev.sh            start relay / web prototype / tauri dev / tests
```

## Pairing flow

Two steps. The relay only creates codes in step 1.

1. **Desktop**: the user clicks **Connect your Grok Bot**. The app calls
   `POST /v1/pair/start` and gets `{code, token, expires_at}`. It keeps its own copy of the
   token (it needs it for the stream) and shows one line to paste to the bot:
   `Install the Desk Pet skill and pair with code K7Q-42M` (with a Copy button).
2. **Bot**: `POST /v1/pair {code, agent_id?, agent_name?}` exchanges the code for the same
   token plus `relay_url`. The desktop gets an `event: paired` on its stream.

Codes use an unambiguous alphabet (`ABCDEFGHJKMNPQRSTUVWXYZ23456789`, no 0/O/1/I/L), are
**single use** and **expire after 15 minutes**. Responses: `400` malformed, `404` unknown,
`410` already used / expired / cancelled, `429` too many attempts (10/min per client IP).

## API

All bodies are JSON (`Content-Type: application/json`), max **4 KiB**.

| method & path         | auth   | purpose |
| --------------------- | ------ | ------- |
| `GET /health`         | none   | `{ok:true}` |
| `POST /v1/pair/start` | none   | desktop: new code + token → `201 {code, token, expires_at}` |
| `POST /v1/pair`       | none   | bot: `{code, agent_id?, agent_name?}` → `200 {token, relay_url, agent_id}` |
| `POST /v1/events`     | Bearer | bot status → `202 {ok:true}` |
| `GET /v1/stream`      | Bearer | SSE: `event: state` (catch-up, then live), `event: paired`, `event: ping` every 15s, `event: revoked` |
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

Stream: up to **3 subscribers per token** (the 4th gets `429`). On connect the relay replays
the last-known state of every (agent, session) on that token, without messages. State for a
bot silent for **24 h** is dropped.

### Relay configuration (env)

| var | default | |
| --- | ------- | - |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | |
| `DESKPET_PEPPER` | random per process | HMAC pepper (≥ 16 chars). Unset in dev means tokens die on restart |
| `DESKPET_PUBLIC_URL` | request `Host` | `relay_url` returned to bots |
| `DESKPET_DB` | unset (memory only) | optional SQLite file for **token hashes** |
| `DESKPET_RATE_PER_MIN` / `DESKPET_RATE_BURST` | `60` / `20` | event rate limit per token |
| `DESKPET_PAIR_RATE_PER_MIN` / `DESKPET_PAIR_RATE_BURST` | `10` / `10` | pairing attempts per IP |
| `DESKPET_PING_MS` | `15000` | SSE ping interval |
| `DESKPET_MAX_SUBSCRIBERS` | `3` | per token |
| `DESKPET_CORS_ORIGINS` | | extra comma-separated origins (defaults: vite `localhost:1420`, Tauri origins) |
| `DESKPET_LOG` | `1` | `0` silences the access log (method, path, status, ms only) |

## Running it

Requirements: Node 24, and for the native app Rust + `cargo install tauri-cli --version ^2`.

```bash
# 1. relay (foreground, Ctrl-C to stop)
scripts/dev.sh                 # = cd relay && npm install && npm start  → http://127.0.0.1:8787

# 2a. desktop app (native, macOS)
scripts/dev.sh tauri           # = cd desktop && npm install && cargo tauri dev
#     or build a debug .app:
cd desktop && cargo tauri build --debug
open "desktop/src-tauri/target/debug/bundle/macos/Desk Pet for Grok Bot.app"

# 2b. or the same UI as a plain web prototype (no Rust needed)
scripts/dev.sh web             # = cd desktop && npm run dev → http://localhost:1420

# 3. click "Connect your Grok Bot", note the code, then play the bots:
scripts/demo.sh K7Q-42M        # or DESKPET_CODE=K7Q-42M scripts/demo.sh ; add --fast for short sleeps
```

`scripts/demo.sh` with **no code** creates a pairing itself, keeps the token in a shell variable,
prints **only the code** (plus a ready `curl` line to redeem it by hand and test the bot
side), and runs the demo on its own token. `RELAY_URL` overrides the relay address.

Tests:

```bash
cd relay && npm test           # tsc type-check + node:test (auth, schema, 413, 429, pairing, hashing, SSE)
cd desktop && npm run build    # tsc + vite build
```

Regenerate sprites: `cd desktop && npm run sprites` (writes `public/sprites/*`,
`art/preview.png`, `art/icon-1024.png`; re-run `cargo tauri icon art/icon-1024.png -o src-tauri/icons`
for app icons).

## Desktop behaviour

- Transparent, frameless, always-on-top 360×200 window. Drag anywhere (background or a pet) to
  move it. It has no Dock icon on macOS, so quit from the ⚙ settings panel (hover the window).
- One pet per `agent_id`, side by side, name under it, accent colour per bot (Jarvis teal,
  Claude orange, Scout violet, others hashed into a fixed palette). Frames are 32×32 at integer
  3× (2× when more than 3 bots), nearest-neighbour.
- Multiple sessions per bot: the highest-priority state wins:
  `needs_you > error > juggling > working > thinking > done > idle`. Active states with no
  update for 10 min count as idle (bots send heartbeats every 60 s in long turns).
- `done` plays once, then idle. Idle for 5 min (30 s in `vite` dev) → sleeping.
- `message` shows as a toast bubble for 5 s.
- Relay down → pets dim to the offline sprite with "offline · retrying"; reconnects with
  exponential backoff (1 s → 30 s, jitter) and a 45 s silence watchdog. 401/`revoked` → back
  to the pairing screen.
- Click (not drag) a pet → opens its URL via `tauri-plugin-opener` (capability allows only
  `http(s)://*`). Configure in `desktop/public/deskpet.config.json`
  (`openUrls.default`, `openUrls.agents.{agent_id}`) or in the settings panel. Default
  fallback is `https://grok.com`. There are no invented per-bot deep links.

## Security notes

- Tokens: 32 random bytes, base64url. The relay stores only `HMAC-SHA-256(pepper, token)` and
  compares in constant time. Until a code is redeemed, the token is held only **encrypted**
  (AES-256-GCM, key derived from pepper + code), and the ciphertext is deleted on redemption
  or expiry. Tests assert the raw token never appears in the in-memory store or the SQLite file.
- Tokens travel only in `Authorization: Bearer`, never in query strings (the stream ignores
  `?token=`). The relay never logs headers, bodies or query strings.
- `message` bodies are forwarded live and never stored. Last-known state drops after 24 h.
- `scripts/demo.sh` keeps the token in a variable, never echoes it, and passes the header to
  curl through a process substitution so it doesn't show up in `ps`.
- CORS allows only the vite dev origin and Tauri origins. The Tauri CSP limits `connect-src` to
  localhost and https.
- Unpair (settings) revokes the token server-side immediately and closes its streams.

## Not done yet (M0 gaps)

- **Keychain**: the desktop keeps its token in webview `localStorage` (TODO M1: OS keychain).
- **Signing / notarization**: the debug `.app` is unsigned; only the `app` bundle target is
  built (no dmg).
- **Deploy**: `relay/Dockerfile` and `relay/fly.toml` are for a *future, separate* Fly app
  `grokbot-deskpet-relay`. **It is NOT deployed and requires Jun's explicit approval.** Never share secrets
  with `jarvis-scheduler`. Nothing in this repo runs `fly`.
- Relay state is in memory (single instance). SQLite persists only token hashes, and only
  makes sense with a fixed `DESKPET_PEPPER`.
- Pairing-code brute force is only throttled per IP (31⁶ ≈ 887M codes, 15 min lifetime).
  Add global throttling before going public.
- Windows/Linux untested. No tray icon, no autostart, no multi-monitor position memory.
- Art is programmatic placeholder art. Final art drops in under the same filenames
  (`desktop/public/sprites/README.md`).

## License

Apache-2.0. See [LICENSE](LICENSE).
