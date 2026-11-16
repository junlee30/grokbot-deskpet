#!/usr/bin/env bash
# Dev helpers.
#   scripts/dev.sh            # start the relay on 127.0.0.1:8787 (foreground, Ctrl-C to stop)
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
    cd "$ROOT/relay" && PORT="${PORT:-8787}" exec npm start --silent
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
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
