# Changelog

Desk Pet app releases (`v…` tags, [GitHub releases](https://github.com/junlee30/grokbot-deskpet/releases)).
The bot skill has its own versions (`skill-v…` tags); the skill version each app expects is noted.

## Unreleased

- **Updates from the menu bar:** **Check for Updates…** (it becomes **Update to X…** when
  Desk Pet's own check, every few hours, finds one) and Settings → **Updates** download the
  new version, check its signature, install it and relaunch. 0.4.0 has no updater, so
  updating to this version is still a manual download or `brew upgrade`.
- **Pets behind your windows:** turn off **Keep Pets on Top** (menu bar menu or Settings →
  Pets). Pets then stay behind other windows and come forward only while their bot needs you.
- **Calmer resting pets:** turn off Settings → Pets → **Move while resting or asleep** to hold
  idle and sleeping pets still (no breathing, blinking or drifting z's). Busy states still
  move.
- **Security:** the mailbox connection no longer follows a redirect from `https` to plain
  `http`, which would have sent the topic name unencrypted.
- **Ask your Grok Bot to install it:** paste one line from the README; the bot follows
  [docs/BOT-INSTALL.md](docs/BOT-INSTALL.md), installs and opens Desk Pet, then asks for the
  pairing line.
- **Homebrew:** `brew install --cask junlee30/tap/desk-pet`. The cask follows each published
  release.
- **npm:** the bot publisher is on npm as `deskpet-publish` (same file the skill pins by
  SHA-256), for driving a pet from anything that can run a command.

## 0.4.0 · 2026-11-17

Expects skill **2.2.0**.

- **Languages.** Bots write their status in the language you talk to them in and tag it
  (`lang`); each pet's own text (tooltip, notes, its "needs you" notification) follows its
  bot. The app's windows and menus follow your Mac's first language, like Grok Bot. English
  and Korean.
- **One-paste setup.** The pairing line links to the skill on GitHub; bots download the
  publisher from a pinned tag and check its SHA-256 before installing. Settings →
  **Copy Skill Link**.
- **Hide a pet:** right-click → **Hide <name>**, back when its bot does something new or with
  **Show Hidden Pets**.
- **Profile pictures without shipping Grok Bot's art:** copied at start-up from your own
  Grok Bot install, re-copied when Grok Bot updates.
- **"Needs you" notifications** and a count on the menu bar icon (Settings → **Alerts**).
- Pets no longer vanish to just their name tag: cached canvases rebuild themselves.
- Resting pets draw only when something changes (much less CPU).
- Setup notes on a pet: "Missed N updates" after a mailbox rate limit, and "my skill is out
  of date".
- First public release: universal `.dmg` (Apple silicon and Intel), ad-hoc signed.
