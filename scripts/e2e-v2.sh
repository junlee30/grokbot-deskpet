#!/usr/bin/env bash
# Desk Pet v2 end-to-end: skill/deskpet-publish -> mailbox -> the pet's Rust mailbox client.
#
#   scripts/e2e-v2.sh            local fake ntfy (scripts/fake-ntfy.mjs) on a random port
#   scripts/e2e-v2.sh --real     the real https://ntfy.sh with a throwaway random topic
#   EVENTS=5 scripts/e2e-v2.sh   number of events to publish (default 5)
#
# The Rust test (desktop/src-tauri/src/mailbox.rs, e2e_publish_script_to_pet_client) generates a
# fresh pairing in-process, starts the pet client, pairs the publish script through stdin, then
# publishes and decrypts. No secret is printed: only agent/state/event/message summaries.
set -euo pipefail
set +x
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EVENTS="${EVENTS:-5}"
FAKE_PID=""
cleanup() { [[ -n "$FAKE_PID" ]] && kill "$FAKE_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [[ "${1:-}" == "--real" ]]; then
  MAILBOX="https://ntfy.sh"
  echo "e2e v2: real mailbox $MAILBOX (throwaway random topic), $EVENTS events"
else
  OUT="$(mktemp)"
  node "$ROOT/scripts/fake-ntfy.mjs" --port 0 --keepalive 5 >"$OUT" &
  FAKE_PID=$!
  for _ in $(seq 50); do grep -q '^listening' "$OUT" && break; sleep 0.1; done
  MAILBOX="$(sed -n 's/^listening //p' "$OUT")"
  rm -f "$OUT"
  [[ -n "$MAILBOX" ]] || { echo "fake ntfy did not start" >&2; exit 1; }
  echo "e2e v2: local fake ntfy at $MAILBOX, $EVENTS events"
fi

cd "$ROOT/desktop/src-tauri"
LOG="$(mktemp)"
set +e
DESKPET_E2E_MAILBOX="$MAILBOX" DESKPET_E2E_EVENTS="$EVENTS" \
  cargo test --quiet e2e_publish_script_to_pet_client -- --ignored --nocapture >"$LOG" 2>&1
STATUS=$?
set -e
grep -E '^e2e|test result|panicked|assertion|left:|right:' "$LOG" || tail -20 "$LOG"
rm -f "$LOG"
exit "$STATUS"
