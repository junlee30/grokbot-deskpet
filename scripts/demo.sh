#!/usr/bin/env bash
# Desk Pet demo: plays three fake Grok Bots (Jarvis, Claude, Scout) against the relay.
#
#   scripts/demo.sh K7Q-42M        # act as the bot side for the code shown in the desktop app
#   DESKPET_CODE=K7Q-42M scripts/demo.sh
#   scripts/demo.sh                # no code: create a pairing here, print only the CODE
#   scripts/demo.sh --fast ...     # short sleeps (CI / smoke test)
#
# Env: RELAY_URL (default http://127.0.0.1:8787)
#
# The token is only ever held in a shell variable. It is never printed, never written to
# disk, never put on a command line (curl reads the header from a process substitution),
# and this script never enables `set -x`.
set -euo pipefail
set +x

RELAY_URL="${RELAY_URL:-http://127.0.0.1:8787}"
RELAY_URL="${RELAY_URL%/}"
CODE="${DESKPET_CODE:-}"
STEP=1.5

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --fast) STEP=0.4 ;;
    -h | --help) usage 0 ;;
    -*) echo "unknown flag: $arg" >&2; usage 2 ;;
    *) CODE="$arg" ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required (for JSON parsing)" >&2; exit 1; }

# json_field <name>: read JSON on stdin, print one string field (used only inside $(...)).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];if(typeof v==="string")process.stdout.write(v)}catch{}})' "$1"
}

if ! curl -fsS -m 3 "$RELAY_URL/health" >/dev/null 2>&1; then
  echo "relay not reachable at $RELAY_URL (start it with: scripts/dev.sh)" >&2
  exit 1
fi

TOKEN=""
if [[ -n "$CODE" ]]; then
  # Bot side: exchange the human code for the token.
  RESP="$(curl -sS -m 5 -X POST "$RELAY_URL/v1/pair" \
    -H 'Content-Type: application/json' \
    -d "{\"code\":\"$(printf '%s' "$CODE" | tr -cd 'A-Za-z0-9-')\",\"agent_id\":\"demo\",\"agent_name\":\"Demo\"}" \
    -w $'\n%{http_code}')" || { echo "pairing request failed" >&2; exit 1; }
  STATUS="${RESP##*$'\n'}"
  BODY="${RESP%$'\n'*}"
  if [[ "$STATUS" != "200" ]]; then
    echo "pairing failed: HTTP $STATUS $(printf '%s' "$BODY" | json_field error)" >&2
    exit 1
  fi
  TOKEN="$(printf '%s' "$BODY" | json_field token)"
  unset RESP BODY
  echo "paired with code $CODE"
else
  # No code: create a pairing here (desktop role), keep the token, show only the code.
  BODY="$(curl -fsS -m 5 -X POST "$RELAY_URL/v1/pair/start")" || { echo "pair/start failed" >&2; exit 1; }
  TOKEN="$(printf '%s' "$BODY" | json_field token)"
  NEW_CODE="$(printf '%s' "$BODY" | json_field code)"
  unset BODY
  echo "pairing code: $NEW_CODE  (single use, 15 min)"
  echo "  to test the bot side by hand:"
  echo "  curl -sS -X POST $RELAY_URL/v1/pair -H 'Content-Type: application/json' -d '{\"code\":\"$NEW_CODE\"}'"
fi
[[ -n "$TOKEN" ]] || { echo "no token received" >&2; exit 1; }

posted=0
failed=0

# post <agent_id> <agent_name> <session> <state> <event> [message]
post() {
  local id="$1" name="$2" session="$3" state="$4" event="$5" msg="${6:-}" ts body code
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  body="{\"agent_id\":\"$id\",\"agent_name\":\"$name\",\"session\":\"$session\",\"state\":\"$state\",\"event\":\"$event\",\"ts\":\"$ts\"${msg:+,\"message\":\"$msg\"}}"
  for attempt in 1 2; do
    code="$(curl -sS -m 3 -o /dev/null -w '%{http_code}' -X POST "$RELAY_URL/v1/events" \
      -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
      -H 'Content-Type: application/json' \
      --data-binary "$body" 2>/dev/null)" || code="000"
    [[ "$code" == "429" && "$attempt" == 1 ]] && { sleep 1.2; continue; }
    break
  done
  if [[ "$code" == "202" ]]; then posted=$((posted + 1)); else failed=$((failed + 1)); fi
  printf '  %-7s %-10s %-13s %s%s\n' "$id" "$state" "$event" "$code" "${msg:+  \"$msg\"}"
}

pause() { sleep "$STEP"; }

echo "demo: Jarvis, Claude and Scout -> $RELAY_URL (step ${STEP}s)"
post jarvis Jarvis j-1 thinking turn_start
post claude Claude c-1 thinking turn_start
pause
post jarvis Jarvis j-1 working tool_start "Reading the build log"
post scout Scout s-1 thinking turn_start
pause
post claude Claude c-1 working tool_start
post scout Scout s-1 working tool_start "Running tests"
pause
post jarvis Jarvis j-1 juggling helper_start "Spinning up 2 helpers"
pause
post claude Claude c-1 needs_you waiting "Need your OK to continue"
pause
post scout Scout s-1 error error "Tests failed, see chat"
pause
post jarvis Jarvis j-1 juggling heartbeat
post jarvis Jarvis j-2 working tool_start
pause
post jarvis Jarvis j-1 done turn_end "All done"
pause
post claude Claude c-1 thinking turn_start
post scout Scout s-1 working tool_start "Retrying"
pause
post jarvis Jarvis j-2 done turn_end
post claude Claude c-1 working tool_start
pause
post scout Scout s-1 done turn_end "Fixed on retry"
pause
post claude Claude c-1 done turn_end
pause

echo "demo finished: $posted accepted, $failed failed"
TOKEN=""
[[ "$failed" == 0 ]]
