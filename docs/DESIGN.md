# Desk Pet design

How Desk Pet looks and behaves on the desktop, and where Grok Bot's avatar art comes from.

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
    rules are in `pets.rs`. Each pet only touches its canvas when a pixel changes, and its
    render loop sleeps until the next frame that can differ (`nextChangeAt` in
    `src/petwin.ts`): robot sprites at their fps, resting avatars until the next blink, breath
    or z (at most 1 s). Busy pets tick every 32 ms; a new event draws at once.
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
  - **Pet size** (Large / Small), **Notifications** (on by default), **Reset Pet Positions**;
    **Quit Desk Pet** and the version at the bottom.
- **Needs you.** When a pet starts showing `needs_you` from a fresh event, macOS shows a
  notification ("Jarvis needs you" and the bot's message), and the menu bar icon shows how
  many bots are waiting ("2"). Catch-up events at start-up count but don't notify. The logic
  is `Attention` in `src/presence.ts`; Rust keeps the count (`pet_attention`).
- **Setup notes.** A pet whose bot runs an older publisher says so once ("My Desk Pet skill
  is out of date: ask me to update it") and keeps it in its tooltip; after a rate limit it
  says how many updates were missed.
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
  must not be committed or redistributed. A local build contains them, so keep local builds
  to yourself. Release builds are made on CI, where Grok Bot isn't installed; the release
  workflow also fails if any of the art reaches the bundle. Released apps therefore draw
  every bot as the robot (in its avatar colour).
