#!/usr/bin/env bash
# Desk Pet demo: plays three fake Grok Bots (Jarvis, Claude, Scout) through the private mailbox.
#
#   pbpaste | scripts/demo.sh -    # read the dp2.… code (or the whole paste line) from stdin
#   scripts/demo.sh --fast -       # short sleeps (CI / smoke test)
#   scripts/demo.sh --no-avatars - # send no avatars (robots only)
#
# Posts through skill/deskpet-publish into the private mailbox (ntfy), with a throwaway
# DESK_PET_HOME that is deleted afterwards. A dp2 code also works as an argument or in
# DESKPET_CODE, but stdin keeps it out of `ps`. Note ntfy.sh's free tier: ~250 messages/day per IP.
# Each bot sends its Grok Bot avatar: Jarvis blob/black, Claude clover/orange, Scout heart/red.
#
# DEPRECATED v1 relay (self-hosted only), explicitly:
#   RELAY_URL=https://your-relay.example scripts/demo.sh --v1 K7Q-42M   # bot side for that code
#   RELAY_URL=http://127.0.0.1:8787 scripts/demo.sh --v1                # no code: pair here, print only the CODE
#
# Secrets (the v1 token, the dp2 code) are never printed, never put on a command line by this
# script (curl reads the header from a process substitution; the publisher reads the dp2 code
# from stdin), and this script never enables `set -x`.
set -euo pipefail
set +x

RELAY_URL="${RELAY_URL:-}"
RELAY_URL="${RELAY_URL%/}"
CODE="${DESKPET_CODE:-}"
STEP=1.5
AVATARS=1
V1=0

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --fast) STEP=0.4 ;;
    --no-avatars) AVATARS=0 ;;
    --v1) V1=1 ;;
    -h | --help) usage 0 ;;
    -) IFS= read -r CODE || true ;;
    -*) echo "unknown flag: $arg" >&2; usage 2 ;;
    *) CODE="$arg" ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required (for JSON parsing)" >&2; exit 1; }

posted=0
failed=0
skipped=0
V2=0
case "$CODE" in *dp2.*) V2=1 ;; esac

if [[ "$V1" == 1 ]]; then
  [[ "$V2" == 0 ]] || { echo "--v1 is for old relay codes; a dp2 code needs no flag" >&2; exit 2; }
  [[ -n "$RELAY_URL" ]] || { echo "--v1 needs RELAY_URL (your own relay; there is no hosted relay any more)" >&2; exit 2; }
  echo "note: v1 (relay) is deprecated; v2 needs no relay: pbpaste | scripts/demo.sh -" >&2
elif [[ "$V2" == 0 ]]; then
  if [[ -z "$CODE" ]]; then
    echo "no code: copy one in Desk Pet (⚙ → Pair / Show code), then: pbpaste | scripts/demo.sh -" >&2
  elif [[ "$CODE" =~ ^[[:space:]]*[A-Za-z0-9]{3}-?[A-Za-z0-9]{3}[[:space:]]*$ ]]; then
    echo "that looks like an old v1 relay code; v1 is deprecated. Make a dp2 code (⚙ → Pair)," >&2
    echo "or for your own relay: RELAY_URL=<url> scripts/demo.sh --v1 <code>" >&2
  else
    echo "that is not a dp2 code (cut off?)" >&2
  fi
  exit 2
fi

# avatar_json <agent_id>: the bot's Grok Bot avatar ({shape, color}), as in its profile.json.
avatar_json() {
  [[ "$AVATARS" == 1 ]] || return 0
  case "$1" in
    jarvis) printf '{"shape":"blob","color":"black"}' ;;
    claude) printf '{"shape":"clover","color":"orange"}' ;;
    scout) printf '{"shape":"heart","color":"red"}' ;;
  esac
}

if [[ "$V2" == 1 ]]; then
  # ---- v2: private mailbox via the bot-side publisher (no relay involved) ----
  PUBLISH="$(cd "$(dirname "$0")/.." && pwd)/skill/deskpet-publish"
  DESK_PET_HOME="$(mktemp -d)"
  export DESK_PET_HOME
  trap 'rm -rf "$DESK_PET_HOME"' EXIT
  # The code goes to the publisher on stdin; it validates the checksum and stores it 0600.
  printf '%s\n' "$CODE" | "$PUBLISH" pair || { echo "that is not a valid dp2 code (cut off?)" >&2; exit 1; }
  CODE=""

  # post <agent_id> <agent_name> <session> <state> <event> [message]
  post() {
    local id="$1" name="$2" session="$3" state="$4" event="$5" msg="${6:-}" out result
    out="$(DESK_PET_DEBUG=1 DESK_PET_SESSION="$session" DESK_PET_AVATAR="$(avatar_json "$id")" \
      "$PUBLISH" "$id" "$name" "$state" "$event" ${msg:+"$msg"} 2>&1 >/dev/null)" || true
    case "$out" in
      *sent*) posted=$((posted + 1)); result="sent" ;;
      *skipped*) skipped=$((skipped + 1)); result="${out#*skipped: }" ;;
      *) failed=$((failed + 1)); result="${out#*deskpet-publish: }" ;;
    esac
    printf '  %-7s %-10s %-13s %s%s\n' "$id" "$state" "$event" "$result" "${msg:+  \"$msg\"}"
  }
  echo "demo (v2 private mailbox): Jarvis, Claude and Scout (step ${STEP}s)"
fi

# json_field <name>: read JSON on stdin, print one string field (used only inside $(...)).
json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s)[process.argv[1]];if(typeof v==="string")process.stdout.write(v)}catch{}})' "$1"
}

if [[ "$V1" == 1 ]]; then
HEALTH="$(curl -fsS -m 5 "$RELAY_URL/health" 2>/dev/null)" || {
  echo "relay not reachable at $RELAY_URL (a local one: scripts/dev.sh relay)" >&2
  exit 1
}
# Relays before 0.3.0 reject the avatar field (unknown fields are a 400): don't send it there.
RELAY_VERSION="$(printf '%s' "$HEALTH" | json_field version)"
if [[ "$AVATARS" == 1 ]] && ! printf '%s\n0.3.0\n' "${RELAY_VERSION:-0}" | sort -V -C -r 2>/dev/null; then
  echo "relay $RELAY_URL is ${RELAY_VERSION:-unknown} (< 0.3.0): sending no avatars"
  AVATARS=0
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

# post <agent_id> <agent_name> <session> <state> <event> [message]
post() {
  local id="$1" name="$2" session="$3" state="$4" event="$5" msg="${6:-}" ts body code avatar
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  avatar="$(avatar_json "$id")"
  body="{\"agent_id\":\"$id\",\"agent_name\":\"$name\",\"session\":\"$session\",\"state\":\"$state\",\"event\":\"$event\",\"ts\":\"$ts\"${msg:+,\"message\":\"$msg\"}${avatar:+,\"avatar\":$avatar}}"
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

echo "demo (deprecated v1 relay): Jarvis, Claude and Scout -> $RELAY_URL (step ${STEP}s)"
fi

pause() { sleep "$STEP"; }

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

extra=""
[[ "$skipped" -gt 0 ]] && extra=", $skipped skipped (publisher throttling)"
echo "demo finished: $posted accepted, $failed failed$extra"
TOKEN=""
[[ "$failed" == 0 ]]
