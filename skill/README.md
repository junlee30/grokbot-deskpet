# deskpet-publish

The bot-side half of [Desk Pet](https://github.com/junlee30/grokbot-deskpet): a pixel-art pet
on your Mac desktop for each of your Grok Bots. `deskpet-publish` encrypts a short status
(thinking, working, needs you, done…) with XChaCha20-Poly1305 and posts it to a private
[ntfy](https://ntfy.sh) topic; the Desk Pet app decrypts it and animates the bot's pet. One
file, Node 12+ standard library only, no dependencies.

Grok Bots normally don't need this package: pasting the line from Desk Pet's **Connect your
Grok Bot** window makes the bot install the same file (checked against a pinned SHA-256)
from [SKILL.md](https://github.com/junlee30/grokbot-deskpet/blob/main/skill/SKILL.md).
Use the npm package to drive a pet from anything else that can run a command.

```bash
npm install -g deskpet-publish@2.2.0     # or prefix each command with: npx -y deskpet-publish@2.2.0

# Once: the pairing code from Desk Pet → Settings → Show code. Read from stdin, never argv.
pbpaste | deskpet-publish pair
deskpet-publish init my-bot "My Bot" --avatar blob/black --lang en

# Then, as it works:
deskpet-publish --bot my-bot thinking turn_start "Reading the build log"
deskpet-publish --bot my-bot working tool_start "Running the tests"
deskpet-publish --bot my-bot done turn_end "All 87 tests pass"
```

States: `idle thinking working juggling needs_you done error`. Posting always fails open:
exit 0 within about 3 seconds, silent unless `DESK_PET_DEBUG=1`. Settings live in
`~/.deskpet` (`DESK_PET_HOME`), shared with the copy the skill installs. `deskpet-publish
--help` lists every command and environment variable.

The pairing code is the key to your pets: keep it out of command lines, logs and chats.
Protocol and threat model:
[docs/PROTOCOL.md](https://github.com/junlee30/grokbot-deskpet/blob/main/docs/PROTOCOL.md).
Unofficial side project, not affiliated with or endorsed by xAI. Apache-2.0.
