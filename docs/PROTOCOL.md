# Desk Pet protocol

How a bot's status gets from its computer to the pet: pairing, encryption, the event format, and what each side checks. For using the app, see the [README](../README.md).

## The private mailbox

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
- **Publisher** (`skill/deskpet-publish`, `--help` for everything):
  - `pair` (code on stdin, checksum-checked, written 0600), `status`, `unpair`.
  - `init <agent_id> [name] --profile <profile.json>` sets a bot up once in
    `~/.deskpet/bots/<agent_id>.json`: name, avatar and Grok Bot id come from its Grok Bot
    profile and are re-read on every post. `bots` lists them.
  - `--bot <agent_id> <state> <event> [message] [--session id]` posts for a set-up bot; the
    long form `<agent_id> <agent_name> <state> <event> [message] [--avatar shape/color]
    [--grokbot-id uuid]` still works.
  - `token` stores an ntfy access token (stdin, 0600), sent as `Authorization: Bearer`.
  - `--version`; every event carries it as `pv`. The pet compares it with
    `publisher_version` in `protocol/v2.json` and asks bots on an older one to update.
  - Always exits 0 within ~3.5 s, prints nothing unless `DESK_PET_DEBUG=1`. It posts via
    `curl` with its config on stdin (`-K -`), so nothing secret is on a command line, falling
    back to Node's `https`. Sends `X-Firebase: no`. Runs on Node 12 and newer (CI checks).
- **ntfy.sh limits**: anonymous use allows **250 messages/day per IP** (shared by every bot on
  that computer, and by anyone else behind the same IP) and caches messages for 12 h. The
  publisher drops heartbeats closer than 4 min to the last post of the same state, drops a
  busy state (`thinking`/`working`/`juggling`) repeated within 15 s, drops exact repeats within
  10 s, and stays quiet for 15 min after a `429`. Posts lost to a `429` are counted and sent as
  `dropped` with the next post that goes through; the pet says "Missed N updates". For heavy
  use, use an ntfy account (`deskpet-publish token`) or your own ntfy (**Mailbox** in Settings).

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
| `pv`         | string | added by the publisher: its version, `x.y.z`; anything else is dropped. Missing or older than `protocol/v2.json`'s `publisher_version`: the pet asks for an update |
| `dropped`    | int    | added by the publisher after a rate limit: posts lost (1 to 1,000,000); otherwise absent |
| `lang`       | string | optional, the language the bot is using with the user, BCP 47 (`ko`, `en-US`, `zh-Hant-TW`: a 2-3 letter language, up to three 1-8 character subtags); anything else is dropped. `--lang`, `DESK_PET_LANG` or `init --lang` |

The pet keeps the latest avatar and `grokbot_id` per bot. An event that breaks a rule is
dropped (except a bad `grokbot_id`, `pv`, `dropped` or `lang`, which are only left out); unknown
fields are ignored (they are authenticated, so newer bots can add some) and never reach the UI.

These rules, the avatar lists, the size limits and a fixed crypto vector live in
[`protocol/v2.json`](../protocol/v2.json) with valid and invalid example events. The
publisher's, the Rust side's and the frontend's tests all check against it, so a change made
on one side only fails CI.

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
  Pet windows (which show bot-supplied text, always as `textContent`) may only call the few
  commands a pet needs; pairing, the mailbox stream, positions and Quit are main-window only.

## Keychain

- The v2 pairing string (topic + key + mailbox URL) is stored as service `com.grokbot.deskpet`,
  account `mailbox-v2`. You can see it in Keychain Access.
- It reaches the webview only to show or copy the paste line. It is never put in localStorage,
  never logged, and never echoed in an error.
- Unsigned debug builds get a new code signature on every rebuild. macOS may then ask once
  per build whether the app may use its Keychain item ("Always Allow").
