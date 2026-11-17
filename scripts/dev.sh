#!/usr/bin/env bash
# Dev helpers.
#   scripts/dev.sh tauri      # desktop app with cargo tauri dev (starts vite itself)
#   scripts/dev.sh web        # desktop frontend as a plain web prototype (vite, http://localhost:1420;
#                             #   no v2 there: the private mailbox needs the desktop app)
#   scripts/dev.sh test       # every test suite (frontend, Rust, publisher)
#   scripts/dev.sh            # = tauri
set -euo pipefail
set +x
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

need_deps() { [[ -d "$1/node_modules" ]] || (cd "$1" && npm install --no-audit --no-fund); }

case "${1:-tauri}" in
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
    need_deps "$ROOT/desktop"
    # shellcheck disable=SC1091
    [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
    (cd "$ROOT/desktop" && npm test && npx tsc --noEmit)
    (cd "$ROOT/desktop/src-tauri" && cargo test)
    (cd "$ROOT" && node --test skill/test/*.test.mjs)
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
