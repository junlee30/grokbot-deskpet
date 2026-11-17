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
# The dp2 code is never printed, never put on a command line by this script (the publisher
# reads it from stdin), and this script never enables `set -x`.
set -euo pipefail
set +x

CODE="${DESKPET_CODE:-}"
STEP=1.5
AVATARS=1

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --fast) STEP=0.4 ;;
    --no-avatars) AVATARS=0 ;;
    -h | --help) usage 0 ;;
    -) IFS= read -r CODE || true ;;
    -*) echo "unknown flag: $arg" >&2; usage 2 ;;
    *) CODE="$arg" ;;
  esac
done

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

posted=0
failed=0
skipped=0
case "$CODE" in
  *dp2.*) ;;
  "") echo "no code: copy one in Desk Pet (⚙ → Pair / Show code), then: pbpaste | scripts/demo.sh -" >&2; exit 2 ;;
  *) echo "that is not a dp2 code (cut off?)" >&2; exit 2 ;;
esac

# avatar_json <agent_id>: the bot's Grok Bot avatar ({shape, color}), as in its profile.json.
avatar_json() {
  [[ "$AVATARS" == 1 ]] || return 0
  case "$1" in
    jarvis) printf '{"shape":"blob","color":"black"}' ;;
    claude) printf '{"shape":"clover","color":"orange"}' ;;
    scout) printf '{"shape":"heart","color":"red"}' ;;
  esac
}

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
echo "demo: Jarvis, Claude and Scout through the private mailbox (step ${STEP}s)"

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
[[ "$failed" == 0 ]]
