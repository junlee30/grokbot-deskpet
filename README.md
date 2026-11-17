# Desk Pet for Grok Bot

*Working title. Unofficial side project, not affiliated with or endorsed by xAI.*

A tiny always-on-top desktop pet that shows **one pixel-art Grok Bot per bot** and animates it
from the bots' lifecycle status: thinking, working, juggling helpers, waiting on you, done,
error, sleeping. Click a pet to open the Grok Bot desktop app on that bot's chat.

Status: **v2**: **local-first, zero server cost.** The pet and its bots talk through a free
public **ntfy.sh** topic (or your own ntfy) with **end-to-end encryption**: there is no Desk Pet
server at all. The native macOS app keeps its secret (the v2 topic + key) in the Keychain.
Original code and art, Apache-2.0 (see `LICENSE`). The Grok Bot avatar art is **not** in this
repo: it is copied from your installed Grok Bot app at build time (see below).

> The v1 relay is **deprecated** and the hosted relay has been shut down. See
> [Deprecated: self-hosted relay](#deprecated-self-hosted-relay).

## Quick start

1. Build and open the desktop app (see [Running it](#running-it)).
2. Click **Connect your Grok Bot** (or ⚙ → **Pair**). The app shows
   `Install the Desk Pet skill and pair with code dp2.…`. Click **Copy**.
3. Paste that line to your Grok Bot. It follows `skill/SKILL.md`: installs the bundled
   publisher, pairs, and says hello. The bot's pet appears within about a second.

The same code works for any number of bots and bot computers (⚙ → **Show code**). It is the
key to your pet: share it only with your bots.

## Features

- **Private mailbox pairing.** A `dp2.…` code (128-bit random ntfy topic + 256-bit key +
  optional self-hosted ntfy URL + checksum, base64url). The bot runs the bundled
  `skill/deskpet-publish` (one Node script, stdlib only), which encrypts each status with
  **XChaCha20-Poly1305** and POSTs it to the topic. The pet subscribes over SSE in Rust,
  decrypts, and drops forgeries, replays (per bot+session `seq`), events more than 10 minutes
  off and oversize bodies. Details: [Desk Pet v2](#desk-pet-v2-private-mailbox).
- **Each bot looks like its own Grok Bot profile picture.** Bots send an optional
  `avatar: {shape, color}` (their profile's `avatarShape` / `avatarColor`), checked against the
  26 shapes and 11 colours. The desktop draws that shape in that colour, animated with the app's
  own blink/glance frames and cadence, with state cues (badges, dots, juggling balls, hops,
  shakes, sparkles) around it. Bots without an avatar, or builds without the art, show the
  robot (accented in the avatar colour if known). `scripts/import-grokbot-art.mjs` copies the
  face strips and the avatar palette from `/Applications/Grok Bot.app` into
  `desktop/public/grokbot-art/` (gitignored) before every desktop build.
- **Desktop**: every bot in its own small window you can drag anywhere (any monitor), each
  bot's position remembered across restarts, toasts that never overlap or clip, a working
  label, a menu bar template icon, light and dark mode, and an original app icon (a pup peeking
  over a desk) plus an original pixel-art robot for bots without an avatar.
- `scripts/demo.sh` plays three fake bots from a dp2 code (`pbpaste | scripts/demo.sh -`);
  `scripts/e2e-v2.sh` runs publisher → mailbox → pet client against a local fake ntfy or the
  real ntfy.sh.

## Architecture

```
 Grok Bot computer                         ntfy.sh (or your ntfy)          desktop (Tauri v2, macOS)
 ─────────────────                         ──────────────────────          ─────────────────────────
 skill/SKILL.md                                                             Rust mailbox.rs
 ~/.deskpet/deskpet-publish ── POST /<topic> ──▶  only ciphertext  ──SSE──▶ decrypt · validate ·
   key in ~/.deskpet/pairing (0600)                                         replay guard → webview
                                                                            one pet per agent_id
```

Bots can't reach your Mac and your Mac can't reach them, so both use a mailbox both can reach
over outbound HTTPS. The desktop's Rust side holds the SSE subscription and forwards decrypted
events to the webview over Tauri IPC.

```
desktop/    Tauri v2 app; frontend is Vite + TypeScript, no framework
  art/build-sprites.mjs   generates the pixel-art spritesheets (no deps)
  public/sprites/         grokbot_<state>.png + _accent.png + manifest.json (see its README)
  index.html, src/main.ts  main window: pairing, settings, status, "waiting for your bot"
  pet.html, src/pet-main.ts  one bot's own window (opened by the Rust side, one per agent_id)
  src/petwin.ts           pet-window helpers: labels, event de-dup, main window visibility (pure, tested)
  src/layout.ts           pure pet/toast layout and the pet window size (unit-tested in test/)
  src/avatar.ts           avatar logic: strip tinting, face cadence, state cues, geometry (pure, tested)
  src/avatar-bank.ts      loads public/grokbot-art/ (gitignored, imported) and draws avatars
  src/presence.ts         what the pet bubble shows: toast vs persistent working label (pure, tested)
  src/connections.ts      status line, boot view, paste line, old-settings clean-up (pure, tested)
  src-tauri/src/v2.rs     v2 pairing string, XChaCha20-Poly1305 envelope, validation, replay guard
  src-tauri/src/mailbox.rs  v2 ntfy SSE client (since=, backoff, wake detection)
  src-tauri/src/secrets.rs  Keychain (keyring crate), one-time v1 token clean-up
  src-tauri/src/stream.rs  HTTP client, SSE parser, backoff, wake detection
  src-tauri/src/window_state.rs  main window position memory
  src-tauri/src/pets.rs   pet windows, pure: labels, routing, position store, cascade, clamp (tested)
  src-tauri/src/pet_windows.rs  pet windows: open/route/move/close, menu bar icon + right-click menu
skill/SKILL.md            Grok Bot skill: pairing, when/how to post status (+ avatar)
skill/deskpet-publish     bot-side publisher (Node stdlib; tests in skill/test/)
scripts/fake-ntfy.mjs     local stand-in for ntfy (tests, e2e)
scripts/e2e-v2.sh         publisher → mailbox → Rust pet client, local fake or --real ntfy.sh
scripts/import-grokbot-art.mjs  copies Grok Bot avatar art + palette from the installed app
scripts/demo.sh           fake bots (Jarvis, Claude, Scout) cycling through states
scripts/dev.sh            tauri dev / web prototype / (deprecated) relay
relay/                    DEPRECATED v1 relay, kept for self-hosters; the app no longer uses it
```

## Look and feel

The UI follows Apple's HIG for menu bar extras, app icons, Dark Mode, typography and motion.

- **App icon** (`desktop/icons-src/icon.svg`): an original pup peeking over a desk, in Grok
  Bot's family style (monochrome, chubby rounded shapes, two slanted pill eyes) with one
  accent, the orange desk. It's a few large shapes so it reads at 16 px and segments cleanly
  for macOS's dark and tinted icon styles.
- **Menu bar icon** (`desktop/icons-src/tray-template.svg`): the same pup simplified to a black
  + alpha **template** image at 18 pt, so macOS tints it for light, dark and highlighted menu
  bars.
- **Type and spacing:**
  - System font (SF Pro) at 13 px body, 15 px titles and 11 px captions; the rounded system
    font for the pets' own name tags and bubbles.
  - Spacing on a 4/8 pt grid.
  - Radii are 6 for inputs, 10 for buttons and bubbles, 12 for the panel.
  - One orange primary button per view, with dark text on it (7:1).
- **Light and dark:** every colour is a CSS variable with a light and a dark set
  (`prefers-color-scheme`), with stronger edges under Increase Contrast.
- **Reduced motion** (`prefers-reduced-motion`):
  - Bubbles only fade.
  - The working label's spinner becomes a dot.
  - The empty-state pup holds still.
  - Avatars keep their body still (no hops, squash, lean or shake). The state still reads from
    the cloud, ring, balls, badges and z's (`calmCue`, tested).
- **Hover:** a pet perks up by 2 px, its name tag gets a ring in the bot's colour, and the
  tooltip says "Open *name* in Grok Bot".

## Desk Pet v2: private mailbox

Both machines only have outbound HTTPS, so v2 uses a public pub/sub mailbox both can reach:
[ntfy](https://ntfy.sh). The mailbox is untrusted: it only relays ciphertext.

```
 Grok Bot computer (Linux)                 ntfy.sh (or your ntfy)          desktop (Tauri, macOS)
 ─────────────────────────                 ─────────────────────           ──────────────────────
 ~/.deskpet/deskpet-publish                                                 Rust mailbox.rs
   seal(event+seq) ── POST /<topic> ──▶   caches ≤12 h, sees only  ──SSE──▶ GET /<topic>/sse?since=
   key in ~/.deskpet/pairing (0600)       {v:2,n,c} + size/time/IP         open · validate · replay
                                                                           → one pet per bot
```

- **Pairing string** (pet generates; never logged): `dp2.` + base64url(`0x02 | topic[16] |
  key[32] | mailbox URL (omitted for https://ntfy.sh) | sha256[0..4]`), 75 characters for the
  default mailbox. The topic name is base64url(topic) (22 chars). Stored in the Keychain
  (account `mailbox-v2`). Paste line: `Install the Desk Pet skill and pair with code dp2.…`.
  It doesn't expire; **New code** makes a new topic and key (old bots go unheard), **Unpair**
  deletes them.
- **Envelope** (the ntfy message body, ≤ 4096 bytes): `{"v":2,"n":"<24-byte nonce>","c":"<ciphertext‖tag>"}`,
  XChaCha20-Poly1305 (= libsodium `crypto_aead_xchacha20poly1305_ietf`), AAD
  `deskpet-v2:<topic>`, random nonce per message. Plaintext: the [event JSON](#event-fields) plus `seq`
  (strictly increasing per `agent_id`+`session`) and `ts`, ≤ 2048 bytes.
- **Why this cipher**: it has to run from a plain bash environment on the bot computer where
  Python's `cryptography` may be missing and `openssl enc` has no AEAD modes. Node is there, and
  its built-in `crypto` has IETF ChaCha20-Poly1305; the publisher adds HChaCha20 (25 lines,
  checked against the IETF draft vector) to get the 192-bit-nonce XChaCha variant, so random
  nonces are safe for any number of messages. The pet uses the audited RustCrypto
  `chacha20poly1305` crate; both sides are tested against one shared fixed vector.
- **Pet checks**: the MAC (wrong key, tampering, another topic), envelope shape and size, event
  fields ([rules below](#event-fields)), `|ts − now| ≤ 10 min`, and `seq` > last seen for that bot+session.
  Rejected messages are counted, never shown or logged.
- **Catch-up**: the first connect asks `since=10m`, reconnects ask `since=<last message id>`.
  Catch-up events carry ntfy's receive time, so old messages don't toast or replay "done".
- **Publisher** (`skill/deskpet-publish`): `pair` (code on stdin, checksum-checked, written
  0600), `status`, `unpair`, and `<agent_id> <agent_name> <state> <event> [message]
  [--session id] [--avatar shape/color] [--grokbot-id uuid]` (or `DESK_PET_GROKBOT_ID`). Always exits 0 within ~3.5 s, prints nothing unless
  `DESK_PET_DEBUG=1`. It posts via `curl` with the URL on stdin (`-K -`), so nothing secret
  is on a command line, falling back to Node's `https`. Sends `X-Firebase: no`.
- **ntfy.sh limits**: anonymous use allows **250 messages/day per IP** (shared by every bot on
  that computer) and caches messages for 12 h. The publisher drops heartbeats closer than 4 min
  to the last post of the same state, drops exact repeats within 10 s, and stays quiet for
  15 min after a `429`. For heavy use, run your own ntfy and set **Mailbox URL** in Settings.

## Event fields

What a bot sends, inside the encryption (`deskpet-publish` builds and checks it):

| field        | type   | rules |
| ------------ | ------ | ----- |
| `agent_id`   | string | required, `[a-z0-9_-]{1,64}` |
| `agent_name` | string | optional, ≤ 64, defaults to `agent_id` |
| `session`    | string | required, ≤ 128 |
| `state`      | enum   | `idle thinking working juggling needs_you done error sleeping` |
| `event`      | string | required, `[A-Za-z0-9_.:-]{1,64}`, e.g. `turn_start tool_start helper_start waiting turn_end error heartbeat` |
| `message`    | string | optional, ≤ 160 chars, no control chars; shown as a toast |
| `ts`         | string | required, ISO-8601; within ±10 min of the pet's clock |
| `avatar`     | object | optional, exactly `{shape, color}`; `shape` one of `arch bean blob capsule cloud clover crystal cylinder dome egg flower gem heart hex house leaf pebble pumpkin shield sparkle square squircle star tablet teardrop wedge`, `color` one of `black brown red orange yellow green cyan blue violet magenta gray` (case-insensitive) |
| `grokbot_id` | string | optional, the bot's Grok Bot agent UUID, exactly `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` (lowercase); anything else is dropped from the event (the event itself still counts). `--grokbot-id <uuid>` or `DESK_PET_GROKBOT_ID` |
| `seq`        | int    | added by the publisher; strictly increasing per `agent_id` + `session` |

The pet keeps the latest avatar and `grokbot_id` per bot. An event that breaks a rule is
dropped (except a bad `grokbot_id`, which is only left out); unknown fields are ignored (they
are authenticated, so newer bots can add some) and never reach the UI.

## Running it

Requirements: Node 24, and for the native app Rust + `cargo install tauri-cli --version ^2`.
No server to run: the app talks to ntfy.sh directly.

```bash
# desktop app (native, macOS)
scripts/dev.sh tauri           # = cd desktop && npm install && cargo tauri dev
#   or build a debug .app:
cd desktop && cargo tauri build --debug
open "desktop/src-tauri/target/debug/bundle/macos/Desk Pet for Grok Bot.app"

# the same UI as a plain web prototype (no Rust; no v2 there: keys and decryption live in Rust)
scripts/dev.sh web             # = cd desktop && npm run dev → http://localhost:1420

# click "Connect your Grok Bot", Copy, then play three fake bots with that code:
pbpaste | scripts/demo.sh -    # the dp2.… code (or the whole paste line) on stdin; add --fast for short sleeps
```

`scripts/demo.sh` uses a throwaway home directory for the publisher and never prints the code.
On ntfy.sh it uses about 17 of the day's ~250 messages for your IP.

Tests:

```bash
cd desktop && npm test         # node:test: toast/pet layout, pet window size, mailbox URL validation,
                               #   avatar states, working label, connection status, old v1 settings
                               #   clean-up, pet-window helpers (labels, event de-dup, main visibility)
cd desktop && npm run build    # tsc + vite build
cd desktop/src-tauri && cargo test   # v2 pairing/envelope/replay/validation, mailbox client + reconnect,
                                     #   SSE parser, backoff, v1 clean-up never touches v2, window clamp,
                                     #   pet windows: routing, position store, cascade, reset, resize
node --test skill/test/*.test.mjs    # publisher: crypto vectors, pairing, throttling, CLI vs fake ntfy
scripts/e2e-v2.sh                    # two bots: publisher → fake ntfy → Rust pet client → one window
                                     #   each (add --real for ntfy.sh)
cd relay && npm test                 # deprecated v1 relay (self-hosting)
```

Regenerate sprites: `cd desktop && npm run sprites` (writes `public/sprites/*` and
`art/preview.png`). Regenerate icons: `scripts/build-icons.sh` (every app icon size and the
menu bar template from the SVGs in `desktop/icons-src/`). UI preview without a bot:
`cd desktop && npm run dev`, then `http://localhost:1420/preview.html` (every pet state with
sample bubbles) or `preview.html?controls` (the control window's views, with a fake code).

## Desktop behaviour

- **One window per bot.** Each `agent_id` gets its own transparent, frameless, always-on-top
  window (Large 184×166, Small 152×134), opened on that bot's first event and sized for the
  pet, its toast or working label above it, and its name below, so one bot's bubble never
  covers another bot. Pet windows never take keyboard focus.
  - **Drag** a pet (or the space around it) to move just that bot's window, anywhere, including
    onto another monitor. A click (no drag) opens Grok Bot on that bot's chat (below).
  - **Positions are remembered per bot** across restarts in the app config dir (`pets.json`,
    logical points, keyed by `agent_id`). A saved spot is restored only if it is on a connected
    monitor, clamped fully onto it; otherwise (and for new bots) the pet goes to the first free
    spot of a row along the bottom-right of the main screen (right to left, then the row
    above), never on top of another pet.
  - **Reset Pet Positions** (settings, menu bar icon, or right-click a pet) forgets them all and
    lines up the open pets bottom-right again.
  - Unpair or a new code closes every pet window (positions are kept for when the bots come back).
    At most 12 pet windows are open at once.
  - The Rust side sends each window only its own bot's events (`pet_windows.rs`); the pure
    rules are in `pets.rs`. Each pet redraws at most ~30 times a second and only touches its
    canvas when a pixel changes, so resting pets cost almost nothing.
- **The control window** (pairing, settings, connection status) is one frameless panel with
  macOS vibrancy behind it (`windowEffects: popover`). Its header shows the app icon, "Desk Pet"
  and the connection (a dot plus "Connected · ntfy.sh", "Connecting…", "Offline · …" or "Not
  paired"), and the window is resized to fit the current view. It shows while pairing, while no
  bot has posted yet (the empty state: "Waiting for your first bot…" with a **Show code**
  button) and for settings, and hides itself otherwise. Its position is remembered
  (`window.json`, restored only on a connected monitor). There is no Dock icon on macOS:
  **settings** are reachable from the menu bar icon (**Settings…**, **Reset Pet Positions**,
  then **Quit Desk Pet**), from the small settings button that appears next to a pet on hover,
  or by right-clicking a pet.
- **Grok Bot avatars** (M2): a bot that sends `avatar` is drawn as its own profile picture:
  the app's face strip for that shape, tinted to the avatar colour exactly like the app tints
  its menu-bar icon, eye holes filled white, and a 1 px outline (light for dark colours, dark
  for light ones) so it reads on any desktop. Rendering is nearest-neighbour at an integer
  scale: Large draws the @2x strip on a 48 px canvas at 2 CSS px per pixel, Small at 1, tiny
  columns use the @1x strip. Idle uses the app's own face cadence (blink every 2.8–5.5 s,
  sometimes double, or a glance left/right/up). States (M3, `avatarCue` in `src/avatar.ts`):
  - **working**: a squash-and-stretch hop (about 10 CSS px at Large), a tilted ring orbiting the
    waist with a bright comet spinning round it, eyes sweeping;
  - **thinking**: still, leaning back, eyes up, a thought cloud with dots filling in;
  - **juggling**: three balls in a high arc over the head, body swaying;
  - **needs_you**: two hops then an impatient wiggle, a `!` badge that pulses (never vanishes);
  - **error**: deflated (squashed flat), squinting, shudders now and then, red `×`;
  - **done** (once, 1.8 s): crouch, big leap with a confetti burst and `✓`, a little hop, then
    it settles and goes back to idle;
  - **sleeping**: eyes closed, rising z's; **offline**: dimmed.

  Squash/stretch and lean drop or repeat whole pixel rows/columns and are drawn as a few 1:1
  copies (`warpPlan`), so the art stays pixel-crisp. Without the imported art (or for bots
  without an avatar) the robot below is used, with the avatar colour as accent.
- One pet per `agent_id`, name under it, accent colour per bot (Jarvis teal, Claude orange,
  Scout violet, others hashed into a fixed palette). Frames are 32×32 at integer 3× (Large) or
  2× (Small): ⚙ **Pet size**, which also resizes every pet window in place (feet stay put).
- **Toasts** (`message`, 5 s): one per pet, the newest replaces the previous one. A toast is a
  rounded speech bubble with a soft shadow and a tail pointing at its pet (light or dark with
  the system; an amber or red edge for `needs_you` and `error`), fading in and out. It sits
  above its own pet inside that pet's window and is clamped inside it, so it never clips at
  the edge and never covers another bot. Text is at most 2 lines with an ellipsis (full text
  in the tooltip). The layout is a pure function in `src/layout.ts`, unit-tested.
- **Working label** (M3): while a pet shows `working` (or `juggling`), the latest message of
  that state stays above it as a small label with a spinning ring ("Reading the build log"),
  cut to 48 characters and at most 2 lines (full text in the tooltip), until the state ends. A
  fresh toast with different text shows on top for its 5 s, then the label returns. The logic
  is in `src/presence.ts` (pure, unit-tested).
- Multiple sessions per bot: the bot's **newest event decides** its pet (bot `ts`, then
  `seq`, then arrival order); an older session's state stops counting, so an old `needs_you`
  can't outrank a newer `done`. One exception: two or more sessions active
  (thinking/working/juggling) and heard from within 2 min show **juggling**, unless the newest
  event is `needs_you` or `error`. Active states, `needs_you` and `error` with no update for
  10 min fade to idle (bots send heartbeats about every 5 min in long turns). The rules are in
  `src/sessions.ts` (pure, unit-tested).
- `done` plays once, then idle. Idle for 5 min (30 s in `vite` dev) → sleeping.
- **Connection** (Rust, `mailbox.rs`):
  - Mailbox unreachable: pets dim to the offline sprite; the control window says "Offline · …".
  - Reconnect: exponential backoff, 0.5–1 s doubling up to 30 s, with jitter; a `429` waits at
    least 60 s. A 100 s silence watchdog catches dead connections (ntfy sends keepalives every
    45 s). Reconnects ask `since=<last message id>`.
  - Reconnects immediately on wake from sleep (the Rust side detects the wall-clock jump), on
    the `online` event and when the window becomes visible.
- **Settings** (⚙):
  - The pairing row: `Paired · ntfy.sh` (plus `· no bot yet` until a bot posts), **Show code** (for
    another bot computer), **New code** (needs a second click: new topic and key, old bots go
    unheard), **Unpair** (also a second click; deletes topic and key); **Pair** when nothing is
    paired.
  - **Mailbox**: `https://ntfy.sh` (button) or your own ntfy; it applies to the next new code.
  - **Pet size** (Large / Small), **Reset Pet Positions**; **Quit Desk Pet** and the version at
    the bottom.
- **Click (not drag) a pet → Grok Bot opens on that bot's chat.** The pet opens
  `grokbot://app/v1/agent?id=<grokbot_id>` through `tauri-plugin-opener`, using the bot's
  newest valid `grokbot_id`. A bot that hasn't sent one gets `grokbot://`, which just brings
  Grok Bot to the front.
  - The URL is built only from a validated UUID (`grokbotUrl` in `src/petwin.ts`, same rule as
    `v2::grokbot_id_ok` in Rust). The pet windows' capability (`capabilities/pets.json`) allows
    exactly `grokbot://` and `grokbot://app/v1/agent?id=<uuid>` and no other URL; a Rust test
    checks that pattern with the plugin's own matcher. The main window opens no links.
  - Before opening, the app asks macOS whether any app handles `grokbot:` links. If Grok Bot
    isn't installed, a click does nothing, and the log gets one line saying so.
  - Clicks used to open a web link (`openUrls`, default `https://grok.com`); that setting is
    gone and old saved values are cleared.

### Keychain

- The v2 pairing string (topic + key + mailbox URL) is stored as service `com.grokbot.deskpet`,
  account `mailbox-v2`. You can see it in Keychain Access.
- It reaches the webview only to show or copy the paste line. It is never put in localStorage,
  never logged, and never echoed in an error.
- Unsigned debug builds get a new code signature on every rebuild. macOS may then ask once
  per build whether the app may use its Keychain item ("Always Allow").
- **v1 clean-up.** The app no longer has any v1 (relay) code. Once, on the first launch of
  this version, it deletes every leftover v1 token (accounts `relay-token:*`) from the Keychain
  and drops the old v1 fields from its saved settings. If it removed anything it writes one
  line with a count to `~/Library/Logs/dev.deskpet.grokbot/deskpet.log` (nothing secret). When
  it has succeeded it leaves `v1-cleanup.done` in the app's data folder and never runs again.
  The v2 entry is not read, written or deleted.

## Security notes

- The mailbox is untrusted. It sees the random topic name, ciphertext, sizes, timing and IP
  addresses; never the key. Anyone who learns the topic but not the key can only post junk,
  which the pet drops.
- The code is the key: anyone with it can post as your bots (but can't read anything the pet
  shows elsewhere). **New code** or **Unpair** retires it.
- The pet rejects forged or tampered messages (MAC), replays (`seq`), events more than 10 min
  off its clock, bad fields and oversize bodies, silently (counted, never logged).
- Bot side: the code is passed on stdin, stored 0600 in `~/.deskpet/pairing`, and the
  publisher puts nothing secret on a command line or in its output.
- `message` is shown briefly and never stored by the pet; on ntfy.sh it sits encrypted in the
  12 h cache.
- Desktop: the webview's CSP limits `connect-src` to Tauri IPC; all network I/O is in Rust.

## Deprecated: self-hosted relay

v1 (a Desk Pet relay server with `XXX-XXX` pairing codes) is **deprecated**, and the hosted
relay has been shut down. The Grok Bot skill no longer pairs v1 codes; a bot given one tells
the user to make a new code in Desk Pet (⚙ → **Pair**).

The relay code stays in `relay/` for reference and for people who run their own, but the
desktop app no longer connects to any relay: it is v2 only. Setup, API and the bot-side
steps: [relay/README.md](relay/README.md).
`scripts/demo.sh --v1` with `RELAY_URL=<your relay>` still posts fake bots to a relay, for
testing the relay itself; the pet doesn't show them.

## Grok Bot avatar art (import, not committed)

```bash
node scripts/import-grokbot-art.mjs          # or: cd desktop && npm run art
#   --app "/Applications/Grok Bot.app"  (or env GROKBOT_APP)  --from-dir <extracted asar>
#   --out <dir>  --strict (exit 1 if nothing imported)  --quiet
```

- Runs automatically as `prebuild` of `desktop` (`npm run build`, so also `cargo tauri build`).
  Without the Grok Bot app it prints a warning and the build continues with robot art only.
- Reads `Contents/Resources/app.asar` read-only (no extraction, no dependencies) and checks
  each file's SHA-256 against the asar's integrity record.
- Copies `bot-<shape>-face@2x.png` and `bot-<shape>-face.png` (26 shapes, 29 frames each:
  rest, blink close ×4, blink open ×3, glance left/right/up ×7) and writes `manifest.json`
  with the frame sizes, the app version and the **palette**: the app's avatar colour list
  (`{id, label, value}` entries, found in the renderer bundle, the same list its tray uses to
  tint these strips). Only if that list is missing does it fall back to `--x-<color>-500` CSS
  variables, and the manifest records which source was used.
- `desktop/public/grokbot-art/` is gitignored: Grok Bot's art and palette are not ours and
  must not be committed or redistributed. A built `.app` contains them, so keep builds local.

## Known gaps

- **Signing / notarization**: the debug `.app` is unsigned (Keychain may prompt after each
  rebuild); only the `app` bundle target is built (no dmg).
- macOS only so far (keyring is built with `apple-native`). Windows/Linux untested. No
  autostart.
- A pet window's transparent area (above and beside the pet) still takes clicks, like the old
  single window did; the windows are kept small for that reason.
- Debug builds have a self-test: `open --env DESKPET_SELFTEST_AGENTS=a,b "<the .app>"` opens a
  window for each of those local fake bots (no network; positions in `pets-selftest.json`)
  and logs where the windows really are to `~/Library/Logs/dev.deskpet.grokbot/deskpet.log`.
- The browser prototype has no v2 (decryption and keys live in the Rust side).
- No "bot paired" signal: the pet knows a bot is there when its first encrypted event
  arrives. A bot whose code was replaced keeps posting into a topic nobody reads.
- ntfy.sh allows ~250 messages/day/IP, shared with anyone else posting from the same IP (e.g.
  other users of a shared bot computer). For heavy use, run your own ntfy (Mailbox URL).
- Node is required on the bot computer (no Python fallback); without it, `desk_pet()` does
  nothing (fail-open).

## License

Apache-2.0. See [LICENSE](LICENSE).
