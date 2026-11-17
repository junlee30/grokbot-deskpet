---
name: desk-pet
description: Show this Grok Bot as a pixel-art pet on the user's desktop, drawn as its own Grok Bot profile picture (avatarShape/avatarColor); clicking the pet opens this bot's chat in the Grok Bot app. Use when the user says "Install the Desk Pet skill and pair with code dp2.…" to pair once (private, end-to-end encrypted mailbox), and during every turn to post short lifecycle status (thinking, working, juggling, needs_you, done, error). Never sends prompts, replies, tool arguments, file contents or secrets.
---

# Desk Pet

The user runs a small desktop app ("Desk Pet", for Grok Bot; unofficial, not made by xAI) that
shows one pixel-art pet per Grok Bot and animates it from status updates. Each pet looks like
that bot's own Grok Bot profile picture (its avatar shape in its avatar colour) when the bot
sends its `avatar`; otherwise it is a generic robot. Clicking a pet opens the Grok Bot desktop
app on that bot's chat, when the bot sends its own Grok Bot id (`grokbot_id`, section 2). You can't reach the user's machine, and
it can't reach you, so status goes through a **private mailbox** both sides can reach over
HTTPS. Pairing codes look like `dp2.` followed by about 71 letters, digits, `-` and `_`. You
encrypt each status with a key from the code and post it to a random topic on
[ntfy.sh](https://ntfy.sh) (or the user's own ntfy server); the desktop app subscribes and
decrypts. There is no Desk Pet server; the mailbox only sees ciphertext.

Status is best-effort decoration. **It must never slow down, block or break your real work.**
Every post gives up after about 3 seconds and ignores failures.

## 1. Pairing (once): `dp2.` codes

Trigger: the user says something like
`Install the Desk Pet skill and pair with code dp2.AgAB…` (one long word starting `dp2.`).

**The dp2 code is a secret** (it contains the encryption key). Never echo it back, never put it
in a file other than the one below, in memory notes, in chat, or on a process command line.

1. Install (or update) the publisher. It is the file `deskpet-publish` next to this SKILL.md
   (a single Node.js script, standard library only; needs `node` 12 or newer and uses `curl`
   when present). All bots on this computer share it. Run this **at the start of every
   session** too, so a newer copy of this skill updates it:

   ```bash
   mkdir -p ~/.deskpet && chmod 700 ~/.deskpet
   cmp -s "<this skill's folder>/deskpet-publish" ~/.deskpet/deskpet-publish ||
     install -m 700 "<this skill's folder>/deskpet-publish" ~/.deskpet/deskpet-publish
   ```

2. Pair: give it the code on **stdin** (a shell builtin like `printf` doesn't show up in `ps`):

   ```bash
   printf '%s' 'dp2.PASTE-THE-CODE-HERE' | ~/.deskpet/deskpet-publish pair
   ```

   It checks the code's checksum and stores it in `~/.deskpet/pairing` (mode 0600). On success
   it prints `Paired with Desk Pet (mailbox ntfy.sh).` and nothing secret. A mistyped or cut-off
   code fails with exit code 1 and `pairing code checksum mismatch` (ask the user to copy it
   again). Pairing again with a new code replaces the old one for every bot on this computer.
3. Set yourself up (once, see section 2), then say hello so the pet appears right away:

   ```bash
   ~/.deskpet/deskpet-publish init jarvis --profile "$PROFILE"
   ~/.deskpet/deskpet-publish --bot jarvis idle paired "Paired" >/dev/null 2>&1 || true
   ```

4. Confirm to the user **without echoing the code**, e.g.
   "Paired with Desk Pet. I'll show up on your desktop as Jarvis."

`~/.deskpet/deskpet-publish status` prints `paired (mailbox <host>)` or `not paired`;
`~/.deskpet/deskpet-publish bots` lists the bots set up on this computer.

## 2. Setting yourself up: `init`

Pick a stable `agent_id` for yourself: lowercase `[a-z0-9_-]`, max 64 characters, e.g.
`jarvis`. It names your pet on this computer; other bots here pick their own.

Your Grok Bot profile is `/home/box/agent-data/agents/<uuid>/profile.json`. Pass **your own**
(the folder whose `profile.json` is yours; other bots on this computer have folders next to
it) to `init`:

```bash
~/.deskpet/deskpet-publish init jarvis --profile /home/box/agent-data/agents/<uuid>/profile.json
# Set up jarvis ("Jarvis", avatar blob/black, Grok Bot id 2f06d68c-…).
```

`init` takes from that profile, and re-reads on every post (so profile changes show up):

- your **name** (`name`): the pet's name tag. To use another, give it after the id:
  `init jarvis "J.A.R.V.I.S." --profile …`.
- your **avatar** (`avatarShape`, `avatarColor`): the pet is drawn as your profile picture.
  Only these names are sent, never an image or `avatarPngBase64`.
- your **Grok Bot id** (the `<uuid>` folder name): clicking your pet opens your chat in the
  Grok Bot app. It is only your bot's id: not a secret, not personal data.

If you can't tell which profile is yours, run `init jarvis Jarvis` without `--profile` (you
show up as a robot and a click only brings Grok Bot to the front). `--avatar <shape>/<color>`
and `--grokbot-id <uuid>` set those by hand; values that aren't valid are dropped.

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
  comes less than 4 minutes after the last post of the same state in that session, drops a
  busy state (`thinking`, `working`, `juggling`) repeated within 15 seconds, and after a `429`
  (limit reached) stays quiet for 15 minutes (the pet is told how many posts were lost).
  Still, prefer fewer posts: state changes plus a heartbeat every ~5 minutes. If the user
  gives you an ntfy access token for a paid or self-hosted ntfy, store it with
  `printf '%s' 'tk_…' | ~/.deskpet/deskpet-publish token` (never echo it).
- A `working`/`thinking`/`juggling` state with no update for 10 minutes is shown as idle, so
  send heartbeats during long work.
- After `done`, the pet celebrates once and settles to idle. It falls asleep by itself later,
  so you don't need to post `idle` or `sleeping`.

## 4. The exact call

```bash
desk_pet() {  # usage: desk_pet <state> <event> [message]
  # Private mailbox (end-to-end encrypted; fails open, ~3 s max, prints nothing).
  [ -x "$HOME/.deskpet/deskpet-publish" ] && [ -f "$HOME/.deskpet/pairing" ] || return 0
  DESK_PET_SESSION="${DESK_PET_SESSION:-default}" \
    "$HOME/.deskpet/deskpet-publish" --bot jarvis "$@" >/dev/null 2>&1 || true
  return 0
}

desk_pet thinking turn_start
desk_pet working tool_start "Running the test suite"
desk_pet needs_you waiting "Need your approval to continue"
desk_pet done turn_end
```

Replace `jarvis` with your own `agent_id` (the one you gave `init`). Everything else about you
(name, avatar, Grok Bot id) comes from your `init` profile.

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
  (optional, your Grok Bot agent UUID), `seq` (it rises with every post so the pet can drop
  replays), `pv` (the publisher's version, so the pet can ask for an update) and `dropped`
  (only after a rate limit: how many posts were lost). `deskpet-publish` adds the last three.

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

## 7. Updates and old codes

- If the pet says your publisher is out of date, run step 1 of section 1 again.
- Codes like `K7Q-42M` (`XXX-XXX`) are from an old version of Desk Pet that no longer works.
  Don't pair or install anything: ask the user to click ⚙ → **Pair** in Desk Pet for a new
  code (it starts with `dp2.`).
