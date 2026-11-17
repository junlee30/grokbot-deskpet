# Developing Desk Pet

Architecture, building, testing and releasing. The protocol is in [PROTOCOL.md](PROTOCOL.md), the look and behaviour in [DESIGN.md](DESIGN.md).

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
  src/petwin.ts           pet-window helpers: labels, event de-dup, main window visibility, frame schedule (pure, tested)
  src/layout.ts           pure pet/toast layout and the pet window size (unit-tested in test/)
  src/avatar.ts           avatar logic: strip tinting, face cadence, state cues, geometry (pure, tested)
  src/avatar-bank.ts      loads the avatar art (IPC in the app, public/grokbot-art/ in the preview),
                          keeps tinted pixels for self-healing canvases, draws avatars
  src/presence.ts         what the pet bubble shows (toast, working label, setup notes), needs_you tracking (pure, tested)
  src/connections.ts      status line, boot view, paste line, skill link (pure, tested)
  src/i18n.ts             every string, per language; UI and per-bot language rules (pure, tested)
  src-tauri/src/v2.rs     v2 pairing string, XChaCha20-Poly1305 envelope, validation, replay guard
  src-tauri/src/mailbox.rs  v2 ntfy SSE client (since=, backoff, wake detection)
  src-tauri/src/secrets.rs  Keychain (keyring crate)
  src-tauri/src/stream.rs  HTTP client, SSE parser, backoff, wake detection
  src-tauri/src/window_state.rs  main window position memory
  src-tauri/src/pets.rs   pet windows, pure: labels, routing, position store, cascade, clamp (tested)
  src-tauri/src/pet_windows.rs  pet windows: open/route/move/close, menu bar icon + count, right-click menu,
                          needs_you notifications
  src-tauri/src/lock.rs   Mutex locking that survives a poisoned lock
  src-tauri/src/grokbot_art.rs  copies Grok Bot's avatar art from the user's own install at runtime
skill/SKILL.md            Grok Bot skill: pairing, init, when/how to post status
skill/deskpet-publish     bot-side publisher (Node stdlib; tests in skill/test/, compat.cjs for Node 12)
protocol/v2.json          shared protocol constants + test cases (publisher, Rust and frontend test against it)
scripts/fake-ntfy.mjs     local stand-in for ntfy (tests, e2e)
scripts/e2e-v2.sh         publisher → mailbox → Rust pet client, local fake or --real ntfy.sh
scripts/import-grokbot-art.mjs  copies Grok Bot avatar art into public/ for the browser preview only
scripts/demo.sh           fake bots (Jarvis, Claude, Scout) cycling through states
scripts/dev.sh            tauri dev / web prototype / every test suite
.github/workflows/        CI (tests, clippy, Node 12 publisher check) and the release build
```

## Running it

Requirements: Node 22 or newer, and for the native app Rust (with clippy) +
`cargo install tauri-cli --version ^2`.
No server to run: the app talks to ntfy.sh directly.

```bash
# desktop app (native, macOS)
scripts/dev.sh tauri           # = cd desktop && npm install && cargo tauri dev
#   or build a debug .app:
cd desktop && cargo tauri build --debug
open "desktop/src-tauri/target/debug/bundle/macos/Desk Pet.app"

# the same UI as a plain web prototype (no Rust; no v2 there: keys and decryption live in Rust)
scripts/dev.sh web             # = cd desktop && npm run dev → http://localhost:1420

# click "Connect your Grok Bot", Copy, then play three fake bots with that code:
pbpaste | scripts/demo.sh -    # the dp2.… code (or the whole paste line) on stdin; add --fast for short sleeps
```

`scripts/demo.sh` uses a throwaway home directory for the publisher and never prints the code.
On ntfy.sh it uses about 17 of the day's ~250 messages for your IP.

Tests (`scripts/dev.sh test` runs the first five; CI runs all of them plus clippy):

```bash
cd desktop && npm test         # node:test: layout, pet window size, mailbox URL validation, avatar
                               #   states, working label, setup notes, needs_you tracking, frame
                               #   schedule, connection status, pet-window helpers, protocol file
cd desktop && npm run build    # tsc + vite build
cd desktop/src-tauri && cargo test   # v2 pairing/envelope/replay/validation, protocol file cases,
                                     #   publisher versions, mailbox client + reconnect, SSE parser,
                                     #   backoff, window clamp, pet windows, tray text, poisoned locks
node --test skill/test/*.test.mjs    # publisher: crypto vectors, protocol file, pairing, init/--bot,
                                     #   token, throttling, dropped count, CLI vs fake ntfy
node skill/test/compat.cjs           # publisher smoke test that runs on Node 12 (CI: 12 and 20)
scripts/e2e-v2.sh                    # two bots: publisher → fake ntfy → Rust pet client → one window
                                     #   each (add --real for ntfy.sh)
cd desktop/src-tauri && cargo clippy --all-targets -- -D warnings
```

Regenerate sprites: `cd desktop && npm run sprites` (writes `public/sprites/*` and
`art/preview.png`). Regenerate icons: `scripts/build-icons.sh` (every app icon size and the
menu bar template from the SVGs in `desktop/icons-src/`). UI preview without a bot:
`cd desktop && npm run dev`, then `http://localhost:1420/preview.html` (every pet state with
sample bubbles) or `preview.html?controls` (the control window's views, with a fake code).

## README images

`docs/images/` holds the README banner (`hero.png`), the animation (`demo.gif`) and the
GitHub social preview (`social-preview.jpg`, uploaded by hand in the repo's Settings →
Social preview). They come from a dev-only scene, `desktop/showcase.html`
(`npm run dev`, then `/showcase.html?mode=hero|social|gif`), with real `Pet`s. Every
pet wears a Grok Bot avatar (from `public/grokbot-art/`: run `npm run art` first; Jarvis has
the default blob/black). Showing that art was the owner's choice, and the README captions
it as Grok Bot's art that Desk Pet doesn't include. The app and its release builds still
never contain it.

- Screenshot `hero` and `social` at 1280×640 with a device pixel ratio of 2 (Chrome DevTools
  device toolbar); save `social` as a 1280×640 JPEG under 1 MB.
- Screen-record `gif` for one 9-second loop, crop to the row of pets (at 1× that's
  `crop=980:222:300:418`), then:
  `ffmpeg -i demo.mp4 -vf "crop=…,fps=15,scale=980:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 demo.gif`

## Releasing

1. Bump the version in `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` and
   `desktop/package.json`.
   **If `skill/` changed** (the publisher or SKILL.md), bump the skill version everywhere it
   appears, and the tests fail until they all agree: `VERSION` in `skill/deskpet-publish`,
   `publisher_version` in `protocol/v2.json`, `DP_VERSION` and `DP_SHA256`
   (`shasum -a 256 skill/deskpet-publish`) in `skill/SKILL.md`, and `SKILL_VERSION` in
   `desktop/src/connections.ts`. After merging, push the tag `skill-v<version>`: bots
   download SKILL.md and the publisher from that tag, and the app's paste line and
   **Copy Skill Link** point at it. Never move an existing `skill-v…` tag. Pets ask bots on an
   older publisher to update.
2. Push a tag `v<version>`. `.github/workflows/release.yml` checks the tag matches, builds a
   universal (Apple silicon + Intel) `.app` and `.dmg` with no Grok Bot art (the app copies it
   from the user's Grok Bot at runtime; the workflow fails if any reaches the bundle), and attaches the `.dmg` to a **draft** GitHub release. Publish the
   draft by hand. A manual run (`workflow_dispatch`) keeps the `.dmg` as a workflow artifact.

**Unsigned (today).** Without signing secrets the app is ad-hoc signed. The first time,
people right-click **Desk Pet.app → Open** (or allow it in System Settings → Privacy &
Security). Each new version gets a new signature, so macOS may ask once more for the Keychain
item ("Always Allow").

**Signed and notarized.** With an Apple Developer ID, add these repository secrets and the
same workflow signs and notarizes instead:

| secret | what |
| ------ | ---- |
| `APPLE_CERTIFICATE` | the Developer ID Application certificate, exported as .p12, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | the .p12 password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization: Apple ID, an app-specific password, team id |

**Auto-update (not wired yet).** `tauri-plugin-updater` needs an update signing key pair whose
public key is built into the app, so it is a one-time decision: run `cargo tauri signer
generate -w ~/.tauri/deskpet.key`, keep the private key safe, add it as the
`TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) secrets, put the public key and a
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json` endpoint under
`plugins.updater` in `tauri.conf.json`, set `bundle.createUpdaterArtifacts`, and upload the
generated `latest.json` with each release. Updating works best on signed builds.

## Known gaps

- macOS only so far (keyring is built with `apple-native`). Windows/Linux untested. No
  autostart.
- A pet window's transparent area (above and beside the pet) still takes clicks; the windows
  are kept small for that reason.
- Debug builds have a self-test: `open --env DESKPET_SELFTEST_AGENTS=a,b "<the .app>"` opens a
  window for each of those local fake bots (no network; positions in `pets-selftest.json`)
  and logs where the windows really are to `~/Library/Logs/dev.deskpet.grokbot/deskpet.log`.
- The browser prototype has no v2 (decryption and keys live in the Rust side).
- No "bot paired" signal: the pet knows a bot is there when its first encrypted event
  arrives. A bot whose code was replaced keeps posting into a topic nobody reads.
- Status depends on the bot following `skill/SKILL.md` each turn; Grok Bot has no lifecycle
  hooks a skill could use instead.
- Node is required on the bot computer (no Python fallback); without it, `desk_pet()` does
  nothing (fail-open).
