#!/usr/bin/env bash
# Dev helpers.
#   scripts/dev.sh tauri      # desktop app with cargo tauri dev (starts vite itself)
#   scripts/dev.sh web        # desktop frontend as a plain web prototype (vite, http://localhost:1420;
#                             #   no v2 there: the private mailbox needs the desktop app)
#   scripts/dev.sh relay      # DEPRECATED v1: your own relay on 127.0.0.1:8787 (foreground, Ctrl-C)
#                             #   SQLite + dev pepper in relay/data/; CORS only for the web prototype
#   scripts/dev.sh test       # relay tests
#   scripts/dev.sh            # = relay (kept for old habits; v2 needs no relay at all)
set -euo pipefail
set +x
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

need_deps() { [[ -d "$1/node_modules" ]] || (cd "$1" && npm install --no-audit --no-fund); }

case "${1:-relay}" in
  relay)
    need_deps "$ROOT/relay"
    # The Desk Pet app no longer connects to a relay (it is v2 only); this is for self-hosters.
    # CORS allows the old browser-prototype origins (vite on :1420) by default.
    cd "$ROOT/relay" && PORT="${PORT:-8787}" \
      DESKPET_CORS_ORIGINS="${DESKPET_CORS_ORIGINS:-http://localhost:1420,http://127.0.0.1:1420}" \
      exec npm start --silent
    ;;
  web)
    need_deps "$ROOT/desktop"
    cd "$ROOT/desktop" && exec npm run dev
    ;;
  tauri)
    need_deps "$ROOT/desktop"
    # shellcheck disable=SC1091
    [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
    cd "$ROOT/desktop" && exec cargo tauri dev
    ;;
  test)
    need_deps "$ROOT/relay"
    cd "$ROOT/relay" && exec npm test
    ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
