#!/usr/bin/env bash
# Dev helpers.
#   scripts/dev.sh            # start the relay on 127.0.0.1:8787 (foreground, Ctrl-C to stop)
#                             #   SQLite in relay/data/, dev pepper in relay/data/dev-pepper (0600)
#                             #   CORS allowed only for the vite web prototype on :1420
#   scripts/dev.sh relay      # same
#   scripts/dev.sh web        # desktop frontend as a plain web prototype (vite, http://localhost:1420)
#   scripts/dev.sh tauri      # desktop app with cargo tauri dev (starts vite itself)
#   scripts/dev.sh test       # relay tests
set -euo pipefail
set +x
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

need_deps() { [[ -d "$1/node_modules" ]] || (cd "$1" && npm install --no-audit --no-fund); }

case "${1:-relay}" in
  relay)
    need_deps "$ROOT/relay"
    # The native app talks to the relay from Rust (no CORS needed). Only the browser prototype
    # (vite on :1420) needs CORS, so dev allows exactly that origin.
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
