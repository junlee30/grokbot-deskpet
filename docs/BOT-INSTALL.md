# Install Desk Pet (instructions for a Grok Bot)

The user asked you to install **Desk Pet** on their Mac: a small menu bar app that shows a
pixel-art pet on the desktop for each of their Grok Bots (unofficial, not made by xAI;
<https://github.com/junlee30/grokbot-deskpet>). Reply in the language the user is using.

You install the app and open it. You can't pair by yourself: the pairing code is made inside
the app, so the user copies it from there and pastes it to you (step 3).

## 1. Can you run commands on this Mac?

Run `uname -s` and `ls -d /Applications`. If you get `Darwin` and `/Applications`, you are on
the user's Mac: go to step 2.

Otherwise (a Linux sandbox, a remote computer, or no shell), you can't install a Mac app for
them. Tell the user to install it themselves, then go to step 3:

- With Homebrew: `brew install --cask junlee30/tap/desk-pet`
- Or download the `.dmg` from <https://github.com/junlee30/grokbot-deskpet/releases/latest>,
  open it and drag **Desk Pet** to Applications.

## 2. Install and open it

This uses Homebrew when it's there. Otherwise it downloads the version and SHA-256 that the
Homebrew cask pins, checks the download against that SHA-256, and copies the app to
/Applications. It does nothing if Desk Pet is already installed.

```bash
DP_APP="/Applications/Desk Pet.app"
if [ -d "$DP_APP" ]; then
  echo "Desk Pet is already installed"
elif command -v brew >/dev/null 2>&1; then
  brew install --cask junlee30/tap/desk-pet
else
  dp_tmp="$(mktemp -d)"
  dp_cask="$(curl -fsSL --max-time 30 https://raw.githubusercontent.com/junlee30/homebrew-tap/main/Casks/desk-pet.rb)"
  dp_ver="$(printf '%s\n' "$dp_cask" | sed -nE 's/^  version "([0-9.]+)"$/\1/p')"
  dp_sha="$(printf '%s\n' "$dp_cask" | sed -nE 's/^  sha256 "([0-9a-f]{64})"$/\1/p')"
  dp_dmg="$dp_tmp/DeskPet.dmg"
  if [ -n "$dp_ver" ] && [ -n "$dp_sha" ] &&
     curl -fsSL --max-time 300 -o "$dp_dmg" "https://github.com/junlee30/grokbot-deskpet/releases/download/v$dp_ver/Desk.Pet_${dp_ver}_universal.dmg" &&
     [ "$(shasum -a 256 "$dp_dmg" | cut -d' ' -f1)" = "$dp_sha" ] &&
     hdiutil attach -nobrowse -readonly -mountpoint "$dp_tmp/mnt" "$dp_dmg" >/dev/null; then
    cp -R "$dp_tmp/mnt/Desk Pet.app" /Applications/ && echo "Desk Pet $dp_ver installed"
    hdiutil detach "$dp_tmp/mnt" >/dev/null
  else
    echo "Couldn't download a verified Desk Pet; nothing installed" >&2
  fi
  rm -rf "$dp_tmp"
fi
open -a "Desk Pet"
```

If it fails, tell the user what failed and point them to the download link in step 1.
Don't use `sudo`, and don't change any macOS security setting.

Desk Pet isn't signed with an Apple Developer ID yet, so macOS may refuse to open it the
first time. If the user says so, tell them: **System Settings → Privacy & Security → Open
Anyway** (or right-click Desk Pet in Applications → **Open**). Don't try to get around it
yourself.

## 3. Ask for the pairing line

Tell the user, in their language, something like:

> Desk Pet is open. Click **Connect your Grok Bot** in its window (or the Desk Pet icon in the
> menu bar → **Settings…**), then **Copy**, and paste the line here.

The line they paste starts `Install the Desk Pet skill from https://…/SKILL.md and pair with
code dp2.…`. When it arrives, do exactly what it says: read SKILL.md from that link and follow
it. The `dp2.` code is a secret: never repeat it back.
