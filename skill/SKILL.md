---
name: desk-pet
description: Show this Grok Bot as a pixel-art pet on the user's desktop, drawn as its own Grok Bot profile picture (avatarShape/avatarColor); clicking the pet opens this bot's chat in the Grok Bot app. Use when the user says "Install the Desk Pet skill and pair with code dp2.…" to pair once (private, end-to-end encrypted mailbox), and during every turn to post short lifecycle status (thinking, working, juggling, needs_you, done, error). Old v1 codes like "K7Q-42M" are deprecated: tell the user to make a new code in Desk Pet (⚙ → Pair). Never sends prompts, replies, tool arguments, file contents or secrets.
---

# Desk Pet

The user runs a small desktop app ("Desk Pet for Grok Bot", unofficial, working title) that
shows one pixel-art pet per Grok Bot and animates it from status updates. Each pet looks like
that bot's own Grok Bot profile picture (its avatar shape in its avatar colour) when the bot
sends its `avatar`; otherwise it is a generic robot. Clicking a pet opens the Grok Bot desktop
app on that bot's chat, when the bot sends its own Grok Bot id (`grokbot_id`, section 2). You can't reach the user's machine, and
it can't reach you, so status goes through a **private mailbox** both sides can reach over
HTTPS. Pairing codes look like `dp2.` followed by about 71 letters, digits, `-` and `_`. You
encrypt each status with a key from the code and post it to a random topic on
[ntfy.sh](https://ntfy.sh) (or the user's own ntfy server); the desktop app subscribes and
decrypts. There is no Desk Pet server; the mailbox only sees ciphertext.

Codes like `K7Q-42M` (`XXX-XXX`) are from the old **v1 relay, which is deprecated**. Don't pair
with them: see section 7.

Status is best-effort decoration. **It must never slow down, block or break your real work.**
Every post gives up after about 3 seconds and ignores failures.

## 1. Pairing (once): `dp2.` codes

Trigger: the user says something like
`Install the Desk Pet skill and pair with code dp2.AgAB…` (one long word starting `dp2.`).
If the code looks like `XXX-XXX` instead (e.g. `K7Q-42M`), it is a deprecated v1 code: don't
install or pair anything, follow section 7.

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
   ~/.deskpet/deskpet-publish jarvis Jarvis idle paired "Paired" \
     --avatar blob/black --grokbot-id 2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f >/dev/null 2>&1 || true
   ```

   (`--avatar` and `--grokbot-id`: see section 2, and use your own values; leave either out if
   you don't have it.)
5. Confirm to the user **without echoing the code**, e.g.
   "Paired with Desk Pet. I'll show up on your desktop as Jarvis."

`~/.deskpet/deskpet-publish status` prints `paired (mailbox <host>)` or `not paired`.

## 2. Your avatar (profile picture) and your Grok Bot id

Your Grok Bot profile is `/home/box/agent-data/agents/<uuid>/profile.json`. Two things come
from it; read them once per session and send them with **every** status post.

### Your Grok Bot id (`grokbot_id`): makes a click open your chat

The `<uuid>` folder that holds **your own** `profile.json` is your Grok Bot agent id, e.g.
`2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f`. When you send it, clicking your pet opens the Grok Bot
desktop app on your chat (`grokbot://app/v1/agent?id=<uuid>`). Without it, a click only brings
Grok Bot to the front.

```bash
# PROFILE = path to your own profile.json (/home/box/agent-data/agents/<uuid>/profile.json)
DESK_PET_GROKBOT_ID="$(basename "$(dirname "$PROFILE")" \
  | grep -ixE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || true)"
export DESK_PET_GROKBOT_ID
```

- Use **your own** folder, the one whose `profile.json` is yours (the same file you take your
  avatar from). Other bots on this computer have their own folders next to it; never send
  theirs, or a click on your pet would open another bot's chat. If you can't tell which folder
  is yours, send no id.
- `deskpet-publish` reads `DESK_PET_GROKBOT_ID` from the environment, or takes
  `--grokbot-id <uuid>`. It must be a UUID (it is lowercased); anything else is dropped and
  the status is sent without it. The desktop app checks it again.
- It is not a secret and not personal data, only the id of your bot. Never send the user's
  id, a session or chat id, or a URL here.

### Your avatar

`profile.json` has `avatarShape` and `avatarColor`, so the pet looks like you. Send the names
exactly as in your profile (lowercase), for example:

```bash
DESK_PET_AVATAR="$(jq -c '{shape: .avatarShape, color: .avatarColor}
  | select((.shape|type)=="string" and (.color|type)=="string")
  | {shape: (.shape|ascii_downcase), color: (.color|ascii_downcase)}' "$PROFILE" 2>/dev/null || true)"
```

`deskpet-publish` reads `DESK_PET_AVATAR` (this JSON) from the environment, or takes
`--avatar <shape>/<color>` (e.g. `--avatar blob/black`). Values not on the lists are dropped.

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
| long turn: re-post the current state every ~5 min   | (current)   | `heartbeat`    |

Notes:

- Don't post for every tiny step. One post per state change, plus heartbeats during long turns,
  is plenty.
- **Budget:** the free ntfy.sh mailbox allows about **250 messages per day per IP address**,
  shared by every bot on this computer. `deskpet-publish` helps: it drops a `heartbeat` that
  comes less than 4 minutes after the last post of the same state in that session, drops an
  exact repeat within 10 seconds, and after a `429` (limit reached) stays quiet for 15 minutes.
  Still, prefer fewer posts: state changes plus a heartbeat every ~5 minutes.
- A `working`/`thinking`/`juggling` state with no update for 10 minutes is shown as idle, so
  send heartbeats during long work.
- After `done`, the pet celebrates once and settles to idle. It falls asleep by itself later,
  so you don't need to post `idle` or `sleeping`.

## 4. The exact call

```bash
desk_pet() {  # usage: desk_pet <state> <event> [message]
  # Private mailbox (end-to-end encrypted; fails open, ~3 s max, prints nothing).
  [ -x "$HOME/.deskpet/deskpet-publish" ] && [ -f "$HOME/.deskpet/pairing" ] || return 0
  DESK_PET_SESSION="${DESK_PET_SESSION:-default}" DESK_PET_AVATAR="${DESK_PET_AVATAR:-}" \
  DESK_PET_GROKBOT_ID="${DESK_PET_GROKBOT_ID:-}" \
    "$HOME/.deskpet/deskpet-publish" jarvis Jarvis "$@" >/dev/null 2>&1 || true
  return 0
}

desk_pet thinking turn_start
desk_pet working tool_start "Running the test suite"
desk_pet needs_you waiting "Need your approval to continue"
desk_pet done turn_end
```

Replace `jarvis` / `Jarvis` with your own `agent_id` and `agent_name`, and set
`DESK_PET_AVATAR` and `DESK_PET_GROKBOT_ID` from your own profile first (section 2). The same
call with options instead of the environment:

```bash
~/.deskpet/deskpet-publish jarvis Jarvis working tool_start "Running the test suite" \
  --session "$DESK_PET_SESSION" --avatar blob/black \
  --grokbot-id 2f06d68c-1b2a-4c3d-8e9f-0a1b2c3d4e5f >/dev/null 2>&1 || true
```

Rules for this call:

- **Always fail open.** If the mailbox is slow or down, carry on as if nothing
  happened. Never retry in a loop and never tell the user about Desk Pet failures unless they
  ask. (`DESK_PET_DEBUG=1` makes `deskpet-publish` print a one-line outcome, e.g. `sent 200` or
  `skipped: heartbeat throttled`, to stderr; it never prints secrets.)
- **Secrets stay put.** The code lives only in `~/.deskpet/pairing`; `deskpet-publish` never
  prints it and passes nothing secret on a command line.
- **Never run with `set -x`** (or any shell tracing or verbose curl, `-v`).
- What gets sent, inside the encryption: `agent_id`, `agent_name`, `session`, `state`,
  `event`, `message` (optional), `ts` (ISO-8601), `avatar` (optional), `grokbot_id`
  (optional, your Grok Bot agent UUID) and `seq` (added by
  `deskpet-publish`; it rises with every post so the pet can drop replays).

## 5. The `message` field: privacy rules

`message` is an optional, at most **160 characters**, one-line hint shown as a small bubble
on the user's desktop for a few seconds (`deskpet-publish` collapses it to one line and cuts it
at 160). Nothing stores it except the mailbox's short-lived cache of the *encrypted* message.

Only put a short, generic status there, e.g. `Running tests`, `Waiting for your approval`,
`Build failed, see chat`, `Done: 3 files changed`.

**Never** include:

- the user's prompt or your reply text
- tool arguments, commands, queries, URLs with parameters, or file paths that reveal private info
- file contents, code, logs, stack traces
- secrets, tokens, keys, passwords, personal data (names, emails, addresses)

When in doubt, omit `message`.

## 6. Unpairing, re-pairing and privacy

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

Desk Pet is an unofficial side project, not an xAI product.

## 7. Old v1 codes (`XXX-XXX`): deprecated

The v1 relay is deprecated and the hosted relay has been shut down. If the user gives you a code
like `K7Q-42M` (three letters/digits, a dash, three more; case and a missing dash don't
matter), **don't** try to pair, don't call any relay, and don't install anything. Tell them,
for example:

> That's an old v1 Desk Pet code. v1 is deprecated and its relay is gone. In Desk Pet, click
> ⚙ → **Pair** to make a new code (it starts with `dp2.`), and send me that line.

If this computer still has v1 secrets from an earlier pairing (`DESK_PET_TOKEN`,
`DESK_PET_RELAY_URL`), delete them from your secret store and stop using them. (`deskpet-publish
pair` also refuses v1 codes with the same advice.)
