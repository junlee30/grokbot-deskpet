# Desk Pet

**for Grok Bot** · *Unofficial side project, not affiliated with or endorsed by xAI.*

A tiny always-on-top desktop pet for each of your Grok Bots. Each pet shows what its bot is
up to (thinking, working, juggling helpers, waiting on you, done, error, sleeping) and looks
like that bot's own profile picture. Click a pet to open that bot's chat in the Grok Bot app.

There is no Desk Pet server. Your bots post their status, **end-to-end encrypted**, to a
private mailbox on the free public [ntfy.sh](https://ntfy.sh) (or your own ntfy). The pet
subscribes and decrypts. The mailbox only ever sees ciphertext.

macOS only for now. Apache-2.0 (see [LICENSE](LICENSE)).

## Install

- **Download** the `.dmg` from the latest GitHub release and drag **Desk Pet** to
  Applications. Release builds are not signed yet: the first time, right-click
  **Desk Pet.app → Open**.
- **Or build it yourself** (Node 22+, Rust, `cargo install tauri-cli --version ^2`):

  ```bash
  cd desktop && npm install && cargo tauri build
  open "src-tauri/target/release/bundle/macos/Desk Pet.app"
  ```

With Grok Bot installed on the same Mac, each pet is drawn as its bot's own profile picture:
Desk Pet copies that art from your Grok Bot when it starts (it's Grok Bot's art, so Desk Pet
never ships it). Without Grok Bot, pets are an original pixel-art robot in each bot's colour.

## Quick start

1. Open Desk Pet and click **Connect your Grok Bot**. It shows
   `Install the Desk Pet skill and pair with code dp2.…`. Click **Copy**.
2. Paste that line to your Grok Bot. It follows [`skill/SKILL.md`](skill/SKILL.md): installs
   a small publisher script, pairs, sets itself up from its Grok Bot profile, and says hello.
3. The bot's pet appears within about a second.

The same code works for any number of bots and bot computers (menu bar icon → **Settings…**
→ **Show code**). It is the key to your pets: share it only with your bots.

## What you get

- **One pet per bot**, in its own small window you can drag anywhere, on any monitor.
  Positions are remembered.
- **States you can read at a glance**: a thought cloud while thinking, a hop and spinning
  ring while working, juggling balls when helpers run in parallel, a pulsing `!` when the bot
  needs you, a red `×` on errors, confetti when done, z's when asleep.
- **Short status bubbles** ("Running tests", "Need your OK to continue") and a working label
  while a long task runs. Bots never send your prompts, their replies, tool arguments or file
  contents.
- **"Needs you" notifications**: a macOS notification when a bot starts waiting for you, and
  the menu bar icon shows how many bots are waiting. Turn it off in Settings.
- **Click a pet** to open that bot's chat in Grok Bot.
- **Light and dark mode, Reduced Motion, Increase Contrast**, and a menu bar icon instead of a
  Dock icon.

## Settings

Menu bar icon → **Settings…** (or right-click a pet, or the small ⚙ next to a pet on hover):

- **Pairing**: **Show code** (for another bot computer), **New code** (old bots go unheard),
  **Unpair**.
- **Mailbox**: `https://ntfy.sh` or your own ntfy server; used for the next new code.
- **Pet size**: Large or Small. **Notifications**: on or off. **Reset Pet Positions**.

## Privacy

- The mailbox sees a random topic name, encrypted messages, their size and timing, and IP
  addresses. It can't read or forge a status. ntfy.sh keeps messages for up to 12 hours.
- The pairing code lives in your macOS Keychain and in one 0600 file on each bot computer.
- The pet drops anything that fails to decrypt, is a replay, or is more than 10 minutes old.

Details: [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Limits and troubleshooting

- **ntfy.sh allows about 250 messages a day per IP address**, shared by every bot on that
  computer (and anyone else behind the same IP). The publisher is frugal and backs off when
  limited; a pet says "Missed N updates" afterwards. For heavy use, give your bots an ntfy
  access token (`deskpet-publish token`) or run your own ntfy and set **Mailbox**.
- **A pet says its skill is out of date**: ask that bot to update the Desk Pet skill (it
  re-installs the publisher).
- **A pet stays "working"**: bots post their own status, so a bot that forgets to post
  `done` leaves its pet busy. Busy states fade to idle after 10 minutes without an update.
- **Offline**: pets dim when the mailbox can't be reached and reconnect by themselves,
  including after sleep.
- Logs: `~/Library/Logs/dev.deskpet.grokbot/deskpet.log` (never contains secrets).

## More

- [docs/PROTOCOL.md](docs/PROTOCOL.md): pairing, encryption, event format, what the pet checks.
- [docs/DESIGN.md](docs/DESIGN.md): look and feel, desktop behaviour, Grok Bot avatar art.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): architecture, running, tests, releasing.
- [skill/SKILL.md](skill/SKILL.md): what your Grok Bot is told to do.

The older v1 relay server (`XXX-XXX` codes) is gone; it remains in git history.
