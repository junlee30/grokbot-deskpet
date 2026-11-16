---
name: desk-pet
description: Show this Grok Bot as a pixel-art pet on the user's desktop. Use when the user says "Install the Desk Pet skill and pair with code XXX-XXX" (pair once), and during every turn to post short lifecycle status (thinking, working, juggling, needs_you, done, error) to the Desk Pet relay. Never sends prompts, replies, tool arguments, file contents or secrets.
---

# Desk Pet

The user runs a small desktop app ("Desk Pet for Grok Bot", unofficial, working title) that
shows one pixel-art bot per Grok Bot and animates it from status updates. You can't reach the
user's machine, so you post status to a **relay** and the desktop app subscribes to it.

Status is best-effort decoration. **It must never slow down, block or break your real work.**
Every call has a 3-second timeout and ignores failures.

## 1. Pairing (once)

Trigger: the user says something like
`Install the Desk Pet skill and pair with code K7Q-42M`, optionally followed by
`using relay <url>` (the desktop app adds this when it is not on the hosted relay).

1. Take the code (format `XXX-XXX`, letters and digits; case and a missing dash are fine).
2. Pick a stable `agent_id` for yourself: lowercase `[a-z0-9_-]`, max 64 characters, e.g.
   `jarvis`. Use your display name as `agent_name` (max 64), e.g. `Jarvis`.
3. Pick the relay URL, first match wins:
   1. the `using relay <url>` part of the user's message, if present;
   2. the `DESK_PET_RELAY_URL` environment variable, if set;
   3. the hosted relay `https://grokbot-deskpet-relay.fly.dev`.

   **The hosted relay is not live yet.** It only works once Jun deploys it. Until then,
   pairing against it fails (connection error or 404). Say so plainly and carry on with your
   work. For local development the relay is `http://127.0.0.1:8787`.

   Only use `https://` URLs, or `http://` for `localhost`/`127.0.0.1`. Exchange the code:

   ```bash
   RELAY="${DESK_PET_RELAY_URL:-https://grokbot-deskpet-relay.fly.dev}"   # or the URL the user gave
   RESP="$(curl -sS -m 5 -X POST "$RELAY/v1/pair" \
     -H 'Content-Type: application/json' \
     -d '{"code":"K7Q-42M","agent_id":"jarvis","agent_name":"Jarvis"}')"
   ```

   Success is HTTP 200 with `{"token": "...", "relay_url": "...", "agent_id": "..."}`.
   Errors: `400` malformed code, `404` unknown code, `410` code already used or expired
   (codes are single use and expire after 15 minutes), `429` slow down (too many attempts,
   including a short global lock after many failed codes; wait a minute, don't loop).
4. Save the result as **secrets**, without printing them:
   - `DESK_PET_TOKEN` = `token`
   - `DESK_PET_RELAY_URL` = `relay_url` from the response. It is the relay's canonical public
     URL (for the hosted relay, `https://grokbot-deskpet-relay.fly.dev`). Use it for every
     later call instead of the URL you paired with.

   Use your platform's secret / environment-variable store. Do not write the token into
   files in the user's repository, into memory notes, or into chat. Parse the JSON without
   echoing it (for example `jq -r .token <<<"$RESP"` captured straight into the secret store),
   and `unset RESP` afterwards.
5. Confirm to the user **without echoing the token**, e.g.
   "Paired with Desk Pet. I'll show up on your desktop as Jarvis." If pairing failed, say
   so plainly (for example "that code expired, please click Connect again for a new one").

## 2. When to post which state

Post at these moments. `session` is an id for the current conversation/task (stable across
the turn, max 128 characters, no personal data). Something like `chat-<short random id>` is fine.

| moment                                              | `state`     | `event`        |
| --------------------------------------------------- | ----------- | -------------- |
| a new user turn starts, you begin reasoning         | `thinking`  | `turn_start`   |
| you start using a tool (search, code, browse, ...)  | `working`   | `tool_start`   |
| you start helpers / sub-agents running in parallel  | `juggling`  | `helper_start` |
| you are blocked waiting on the user (question, approval, login) | `needs_you` | `waiting` |
| the turn finished                                   | `done`      | `turn_end`     |
| a visible failure the user should know about        | `error`     | `error`        |
| long turn: re-post the current state every ~60s     | (current)   | `heartbeat`    |

Notes:

- Don't post for every tiny step. One post per state change, plus a heartbeat every 60
  seconds during long turns, is plenty. The relay rate-limits to 60/min (burst 20) per pairing.
- A `working`/`thinking`/`juggling` state with no update for 10 minutes is shown as idle, so
  send heartbeats during long work.
- After `done`, the pet celebrates once and settles to idle. It falls asleep by itself later,
  so you don't need to post `idle` or `sleeping`.

## 3. The exact call

```bash
desk_pet() {  # usage: desk_pet <state> <event> [message]
  [ -n "${DESK_PET_TOKEN:-}" ] && [ -n "${DESK_PET_RELAY_URL:-}" ] || return 0
  curl -sS -m 3 -o /dev/null -X POST "$DESK_PET_RELAY_URL/v1/events" \
    -H "Authorization: Bearer $DESK_PET_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"agent_id\":\"jarvis\",\"agent_name\":\"Jarvis\",\"session\":\"$DESK_PET_SESSION\",\"state\":\"$1\",\"event\":\"$2\",${3:+\"message\":\"$3\",}\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    >/dev/null 2>&1 || true
}

desk_pet thinking turn_start
desk_pet working tool_start "Running the test suite"
desk_pet needs_you waiting "Need your approval to continue"
desk_pet done turn_end
```

Rules for this call:

- **Timeout `-m 3` and `|| true`: always fail open.** If the relay is slow or down, carry on
  as if nothing happened. Never retry in a loop and never tell the user about Desk Pet
  failures unless they ask.
- **Token from the environment variable only.** Never inline the token, never print it,
  never log it, never put it in a URL or query string.
- **Never run with `set -x`** (or any shell tracing or verbose curl, `-v`). Tracing would
  print the Authorization header.
- Body must be JSON with exactly these fields: `agent_id`, `agent_name` (optional),
  `session`, `state`, `event`, `message` (optional), `ts` (ISO-8601). Unknown fields are
  rejected. Max body 4 KiB. Escape quotes if you build JSON by hand, or build it with a JSON
  tool.

## 4. The `message` field: privacy rules

`message` is an optional, at most **160 characters**, one-line hint shown as a small bubble
on the user's desktop for a few seconds. The relay doesn't store it.

Only put a short, generic status there, e.g. `Running tests`, `Waiting for your approval`,
`Build failed, see chat`, `Done: 3 files changed`.

**Never** include:

- the user's prompt or your reply text
- tool arguments, commands, queries, URLs with parameters, or file paths that reveal private info
- file contents, code, logs, stack traces
- secrets, tokens, keys, passwords, personal data (names, emails, addresses)

When in doubt, omit `message`.

## 5. Unpairing, re-pairing and privacy

- The user can unpair from the desktop app (Settings, then Unpair). That revokes the token
  immediately and later posts get `401`. When you get `401`, stop posting, delete
  `DESK_PET_TOKEN` / `DESK_PET_RELAY_URL`, and wait for a new pairing code from the user.
- To unpair from your side (only if the user asks):
  `curl -sS -m 3 -X POST "$DESK_PET_RELAY_URL/v1/unpair" -H "Authorization: Bearer $DESK_PET_TOKEN" >/dev/null 2>&1 || true`,
  then delete both secrets.
- If the user switches the desktop app to a different relay (for example from local to
  hosted), the old token stops working there; they will give you a new code. Pair again and
  replace both secrets.
- The relay keeps only a keyed hash of the token and the last state per bot/session (no
  message bodies), in a small database that survives relay restarts. Silent bots are
  forgotten after 24 hours. The desktop app keeps its copy of the token in the macOS
  Keychain.
- Desk Pet is an unofficial side project, not an xAI product.
