---
name: desk-pet
description: Show this Grok Bot as a pixel-art pet on the user's desktop, drawn as its own Grok Bot profile picture (avatarShape/avatarColor). Use when the user says "Install the Desk Pet skill and pair with code dp2.…" (v2, private mailbox, preferred) or "... with code XXX-XXX" (v1 relay), to pair once, and during every turn to post short lifecycle status (thinking, working, juggling, needs_you, done, error). Never sends prompts, replies, tool arguments, file contents or secrets.
---

# Desk Pet

The user runs a small desktop app ("Desk Pet for Grok Bot", unofficial, working title) that
shows one pixel-art pet per Grok Bot and animates it from status updates. Each pet looks like
that bot's own Grok Bot profile picture (its avatar shape in its avatar colour) when the bot
sends its `avatar`; otherwise it is a generic robot. You can't reach the user's machine, and
it can't reach you, so status goes through a **mailbox** both sides can reach over HTTPS:

- **v2 (preferred): private mailbox.** Codes look like `dp2.` followed by about 71 letters,
  digits, `-` and `_`. You encrypt each status with a key from the code and post it to a random
  topic on [ntfy.sh](https://ntfy.sh) (or the user's own ntfy server); the desktop app
  subscribes and decrypts. No Desk Pet server; the mailbox only sees ciphertext.
- **v1: relay.** Codes look like `K7Q-42M`. You exchange the code for a token at the Desk Pet
  relay and post plain JSON to it. Still supported; see section 7.

Status is best-effort decoration. **It must never slow down, block or break your real work.**
Every post gives up after about 3 seconds and ignores failures.

## 1. Pairing (once): v2 `dp2.` codes

Trigger: the user says something like
`Install the Desk Pet skill and pair with code dp2.AgAB…` (one long word starting `dp2.`).
If the code looks like `XXX-XXX` instead, follow section 7 (v1).

**The dp2 code is a secret** (it contains the encryption key). Never echo it back, never put it
in a file other than the one below, in memory notes, in chat, or on a process command line.

1. Pick a stable `agent_id` for yourself: lowercase `[a-z0-9_-]`, max 64 characters, e.g.
   `jarvis`. Use your display name as `agent_name` (max 64), e.g. `Jarvis`.
2. Install the publisher once per computer. It is the file `deskpet-publish` next to this
   SKILL.md (a single Node.js script, standard library only; needs `node` 12 or newer and
   uses `curl` when present). All bots on this computer share it:

   ```bash
   mkdir -p ~/.deskpet && chmod 700 ~/.deskpet
   install -m 700 "<this skill's folder>/deskpet-publish" ~/.deskpet/deskpet-publish
   ```

3. Pair: give it the code on **stdin** (a shell builtin like `printf` doesn't show up in `ps`):

   ```bash
   printf '%s' 'dp2.PASTE-THE-CODE-HERE' | ~/.deskpet/deskpet-publish pair
   ```

   It checks the code's checksum and stores it in `~/.deskpet/pairing` (mode 0600). On success
   it prints `Paired with Desk Pet (mailbox ntfy.sh).` and nothing secret. A mistyped or cut-off
   code fails with exit code 1 and `pairing code checksum mismatch` (ask the user to copy it
   again). Pairing again with a new code replaces the old one for every bot on this computer.
4. Say hello, so the pet appears right away:

   ```bash
   ~/.deskpet/deskpet-publish jarvis Jarvis idle paired "Paired" --avatar blob/black >/dev/null 2>&1 || true
   ```

   (`--avatar`: see section 2; leave it out if you have none.)
5. Confirm to the user **without echoing the code**, e.g.
   "Paired with Desk Pet. I'll show up on your desktop as Jarvis."

`~/.deskpet/deskpet-publish status` prints `paired (mailbox <host>)` or `not paired`.

## 2. Your avatar (profile picture)

Your Grok Bot profile (`profile.json`) has `avatarShape` and `avatarColor`. Read them once per
session and send them with every status post, so the pet looks like you. Send the names exactly
as in your profile (lowercase), for example:

```bash
# PROFILE = path to your own profile.json
DESK_PET_AVATAR="$(jq -c '{shape: .avatarShape, color: .avatarColor}
  | select((.shape|type)=="string" and (.color|type)=="string")
  | {shape: (.shape|ascii_downcase), color: (.color|ascii_downcase)}' "$PROFILE" 2>/dev/null || true)"
```

- v2: `deskpet-publish` reads `DESK_PET_AVATAR` (this JSON) from the environment, or take
  `--avatar <shape>/<color>` (e.g. `--avatar blob/black`). Values not on the lists are dropped.
- v1: the JSON goes in the body as `"avatar": {"shape": ..., "color": ...}` (section 4).

Allowed values (anything else is rejected):

- `shape`: `arch bean blob capsule cloud clover crystal cylinder dome egg flower gem heart hex
  house leaf pebble pumpkin shield sparkle square squircle star tablet teardrop wedge`
- `color`: `black brown red orange yellow green cyan blue violet magenta gray`

If your profile has no avatar, or a value that isn't on these lists, leave `DESK_PET_AVATAR`
empty and send no avatar (you show up as the robot). The avatar is not secret, but it is only
names: never send an image, a URL or `avatarPngBase64`. If the user changes your avatar, re-read
it; the pet keeps the latest one per bot.

## 3. When to post which state

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
| long turn: re-post the current state (v2: every ~5 min, v1: every ~60 s) | (current) | `heartbeat` |

Notes:

- Don't post for every tiny step. One post per state change, plus heartbeats during long turns,
  is plenty.
- **v2 budget:** the free ntfy.sh mailbox allows about **250 messages per day per IP address**,
  shared by every bot on this computer. `deskpet-publish` helps: it drops a `heartbeat` that
  comes less than 4 minutes after the last post of the same state in that session, drops an
  exact repeat within 10 seconds, and after a `429` (limit reached) stays quiet for 15 minutes.
  Still, prefer fewer posts: state changes plus a heartbeat every ~5 minutes.
- v1: the relay rate-limits to 60/min (burst 20) per pairing.
- A `working`/`thinking`/`juggling` state with no update for 10 minutes is shown as idle, so
  send heartbeats during long work.
- After `done`, the pet celebrates once and settles to idle. It falls asleep by itself later,
  so you don't need to post `idle` or `sleeping`.

## 4. The exact call

One function for both kinds of pairing. v2 wins when this computer has a v2 pairing:

```bash
desk_pet() {  # usage: desk_pet <state> <event> [message]
  # v2: private mailbox (end-to-end encrypted; fails open, ~3 s max, prints nothing).
  if [ -x "$HOME/.deskpet/deskpet-publish" ] && [ -f "$HOME/.deskpet/pairing" ]; then
    DESK_PET_SESSION="${DESK_PET_SESSION:-default}" DESK_PET_AVATAR="${DESK_PET_AVATAR:-}" \
      "$HOME/.deskpet/deskpet-publish" jarvis Jarvis "$@" >/dev/null 2>&1 || true
    return 0
  fi
  # v1: relay.
  [ -n "${DESK_PET_TOKEN:-}" ] && [ -n "${DESK_PET_RELAY_URL:-}" ] || return 0
  local body code
  body="$(jq -nc --arg s "$DESK_PET_SESSION" --arg st "$1" --arg ev "$2" --arg msg "${3:-}" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson av "${DESK_PET_AVATAR:-null}" \
    '{agent_id: "jarvis", agent_name: "Jarvis", session: $s, state: $st, event: $ev, ts: $ts}
     + (if $msg != "" then {message: $msg} else {} end)
     + (if $av != null then {avatar: $av} else {} end)')" || return 0
  code="$(curl -sS -m 3 -o /dev/null -w '%{http_code}' -X POST "$DESK_PET_RELAY_URL/v1/events" \
    -H "Authorization: Bearer $DESK_PET_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "$body" 2>/dev/null)" || return 0
  # Relays older than 0.3.0 reject the avatar field: drop it for this session and resend once.
  if [ "$code" = "400" ] && [ -n "${DESK_PET_AVATAR:-}" ]; then
    DESK_PET_AVATAR=""
    desk_pet "$@"
  fi
  return 0
}

desk_pet thinking turn_start
desk_pet working tool_start "Running the test suite"
desk_pet needs_you waiting "Need your approval to continue"
desk_pet done turn_end
```

Replace `jarvis` / `Jarvis` with your own `agent_id` and `agent_name`.

Rules for this call:

- **Always fail open.** If the mailbox or relay is slow or down, carry on as if nothing
  happened. Never retry in a loop and never tell the user about Desk Pet failures unless they
  ask. (`DESK_PET_DEBUG=1` makes `deskpet-publish` print a one-line outcome, e.g. `sent 200` or
  `skipped: heartbeat throttled`, to stderr; it never prints secrets.)
- **Secrets stay put.** v2: the code lives only in `~/.deskpet/pairing`; `deskpet-publish`
  never prints it and passes nothing secret on a command line. v1: the token comes from the
  environment variable only; never inline, print or log it, or put it in a URL.
- **Never run with `set -x`** (or any shell tracing or verbose curl, `-v`).
- What gets sent (v2: inside the encryption; v1: the JSON body): `agent_id`, `agent_name`,
  `session`, `state`, `event`, `message` (optional), `ts` (ISO-8601), `avatar` (optional), and
  for v2 also `seq` (added by `deskpet-publish`; it rises with every post so the pet can drop
  replays). v1 rejects unknown fields; build its JSON with a JSON tool (as above).
- v1: a `400` while sending an avatar means the relay is older than 0.3.0 or the avatar isn't
  on the allowlist: stop sending `avatar` for the session (the function above does this).

## 5. The `message` field: privacy rules

`message` is an optional, at most **160 characters**, one-line hint shown as a small bubble
on the user's desktop for a few seconds (`deskpet-publish` collapses it to one line and cuts it
at 160). Nothing stores it except, on v2, the mailbox's short-lived cache of the *encrypted*
message.

Only put a short, generic status there, e.g. `Running tests`, `Waiting for your approval`,
`Build failed, see chat`, `Done: 3 files changed`.

**Never** include:

- the user's prompt or your reply text
- tool arguments, commands, queries, URLs with parameters, or file paths that reveal private info
- file contents, code, logs, stack traces
- secrets, tokens, keys, passwords, personal data (names, emails, addresses)

When in doubt, omit `message`.

## 6. Unpairing, re-pairing and privacy

**v2 (private mailbox)**

- The user can unpair or make a new code in the desktop app. The old code then stops working
  silently: your posts still succeed but nobody reads them. There is no error to watch for, so
  when the user gives you a new `dp2.` code, pair again (step 3 of section 1); it replaces the
  old one for all bots on this computer.
- To unpair from your side (only if the user asks): `~/.deskpet/deskpet-publish unpair`.
- What the mailbox (ntfy.sh, or the user's own ntfy server) sees: the random topic name, the
  encrypted messages (XChaCha20-Poly1305), their size and timing, and this computer's IP
  address. ntfy.sh keeps messages for up to 12 hours. It never sees the key, so it can't read
  or forge a status. The desktop app keeps the code in the macOS Keychain and drops anything
  that fails to decrypt, is a replay or is more than 10 minutes old.

**v1 (relay)**

- The user can unpair from the desktop app (Settings, then Unpair). That revokes the token
  immediately and later posts get `401`. When you get `401`, stop posting, delete
  `DESK_PET_TOKEN` / `DESK_PET_RELAY_URL`, and wait for a new pairing code from the user.
- To unpair from your side (only if the user asks):
  `curl -sS -m 3 -X POST "$DESK_PET_RELAY_URL/v1/unpair" -H "Authorization: Bearer $DESK_PET_TOKEN" >/dev/null 2>&1 || true`,
  then delete both secrets.
- If the user switches the desktop app to a different relay (for example from local to
  hosted), the old token stops working there; they will give you a new code. Pair again and
  replace both secrets.
- The relay keeps only a keyed hash of the token, the last state per bot/session (no
  message bodies) and the latest avatar names per bot, in a small database that survives relay
  restarts. Silent bots are forgotten after 24 hours. The desktop app keeps its copy of the
  token in the macOS Keychain.

Desk Pet is an unofficial side project, not an xAI product.

## 7. v1 relay pairing (`XXX-XXX` codes)

Use this only for codes like `K7Q-42M` (v2 `dp2.` codes: section 1). Trigger: the user says
something like `Install the Desk Pet skill and pair with code K7Q-42M`, optionally followed by
`using relay <url>` (the desktop app adds this when it is not on the hosted relay).

1. Take the code (format `XXX-XXX`, letters and digits; case and a missing dash are fine).
2. Pick a stable `agent_id` for yourself: lowercase `[a-z0-9_-]`, max 64 characters, e.g.
   `jarvis`. Use your display name as `agent_name` (max 64), e.g. `Jarvis`.
3. Pick the relay URL, first match wins:
   1. the `using relay <url>` part of the user's message, if present;
   2. the `DESK_PET_RELAY_URL` environment variable, if set;
   3. the hosted relay `https://grokbot-deskpet-relay.fly.dev`.

   If pairing fails with a connection error, say so plainly and carry on with your work.
   For local development the relay is `http://127.0.0.1:8787`.

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
