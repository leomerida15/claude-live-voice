#!/usr/bin/env bash
# Speak text through a local Kokoro server and play it with paplay.
#
# Usage: speak.sh [--tag <tag>] <voice> [text-file]   (text read from stdin when no file)
# --tag is ignored: it lets the caller find (and stop) this process by its argv.
# Environment: KOKORO_URL (default http://127.0.0.1:8880/v1/audio/speech).
# Exits non-zero when the text is empty, synthesis fails or playback fails.
# SIGTERM stops playback at once and removes the temporary WAV.
set -u

if [ "${1:-}" = "--tag" ]; then
  shift 2 || shift $#
fi
voice="${1:-ef_dora}"
url="${KOKORO_URL:-http://127.0.0.1:8880/v1/audio/speech}"

if [ $# -ge 2 ]; then
  text="$(cat -- "$2")" || exit 2
else
  text="$(cat)"
fi
if [ -z "${text//[[:space:]]/}" ]; then
  echo "speak.sh: no text to speak" >&2
  exit 2
fi

tmp="$(mktemp --suffix=.wav "${TMPDIR:-/tmp}/live-voice-speak.XXXXXX")" || exit 1
child=""
cleanup() { rm -f -- "$tmp"; }
stop() {
  [ -n "$child" ] && kill "$child" 2>/dev/null
  cleanup
  exit 143
}
trap stop TERM INT
trap cleanup EXIT

body="$(python3 -I -c 'import json, sys; print(json.dumps({"model": "kokoro", "input": sys.argv[1], "voice": sys.argv[2], "response_format": "wav"}))' "$text" "$voice")" || exit 1

curl -sf --max-time 60 -H 'Content-Type: application/json' -d "$body" -o "$tmp" "$url" &
child=$!
wait "$child" || { echo "speak.sh: synthesis failed ($url)" >&2; exit 1; }

paplay "$tmp" &
child=$!
wait "$child" || { echo "speak.sh: playback failed" >&2; exit 1; }
