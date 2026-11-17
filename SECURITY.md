# Security

Desk Pet carries your bots' status over a public mailbox, protected by its own encryption
([docs/PROTOCOL.md](docs/PROTOCOL.md)). If you find a way around that, please tell us
privately first.

## Reporting a problem

Use GitHub's private reporting: **[Report a vulnerability](https://github.com/junlee30/grokbot-deskpet/security/advisories/new)**
(the **Security** tab → **Report a vulnerability**). Please don't open a public issue for it.

Helpful to include: what an attacker needs (for example: the topic name only, network
access to the Mac, a bot computer), what they can do, and steps to reproduce. Never include
a real pairing code (`dp2.…`) or access token: make a throwaway one with **New code**.

You'll get an answer within a week. Fixes ship in a new release, with credit if you want it.

## In scope

- Reading, forging or replaying a status without the pairing code (the envelope, the
  XChaCha20-Poly1305 use, the replay and time checks).
- The pairing code, ntfy access token or key leaking: into logs, command lines, the
  webview, crash output or the mailbox.
- `skill/deskpet-publish` installing or running something other than the pinned, verified
  publisher.
- A bot's text doing more than appear as text: script or HTML in a pet window, a pet click
  opening anything but `grokbot://`, a pet window reaching main-window commands.
- Desk Pet reading or serving files beyond Grok Bot's avatar strips.

## Out of scope

- Someone who has the pairing code posting as your bots: the code is the key. Rotate it with
  **New code**.
- What any mailbox operator can always see: the topic name, message sizes and timing, IP
  addresses (documented in [docs/PROTOCOL.md](docs/PROTOCOL.md)).
- ntfy.sh rate limits, and the unsigned macOS build's first-launch warning.

## Supported versions

Only the [latest release](https://github.com/junlee30/grokbot-deskpet/releases/latest) and
the newest skill (`skill-v…` tag) get fixes.
