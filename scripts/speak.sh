#!/usr/bin/env bash
# Speak text through a local Kokoro server and play it with paplay.
#
# Usage: speak.sh [--tag <tag>] <voice> [text-file]   (text read from stdin when no file)
# --tag is ignored: it lets the caller find (and stop) this process by its argv.
# Environment: KOKORO_URL (default http://127.0.0.1:8880/v1/audio/speech);
# KOKORO_RETRY_S (default 40): how long to keep trying while Kokoro refuses
# connections, as it does while it restarts (VoiceMode's Kokoro restarts itself
# every 25 requests and takes about 30 s to come back).
# Exits non-zero when the text is empty, synthesis fails or playback fails,
# with one line on stderr saying why. Text with no letter or digit (".",
# "**") is skipped: exit 0, nothing played.
# SIGTERM stops playback at once and removes the temporary files.
set -u

if [ "${1:-}" = "--tag" ]; then
  shift 2 || shift $#
fi
voice="${1:-ef_dora}"
url="${KOKORO_URL:-http://127.0.0.1:8880/v1/audio/speech}"
retry_s="${KOKORO_RETRY_S:-40}"

if [ $# -ge 2 ]; then
  text="$(cat -- "$2")" || exit 2
else
  text="$(cat)"
fi
if [ -z "${text//[[:space:]]/}" ]; then
  echo "speak.sh: no text to speak" >&2
  exit 2
fi

# The request body; exit 3 when the text holds nothing a voice can say.
body="$(python3 -I -c '
import json, sys
text, voice = sys.argv[1], sys.argv[2]
if not any(char.isalnum() for char in text):
    sys.exit(3)
print(json.dumps({"model": "kokoro", "input": text, "voice": voice, "response_format": "wav"}))
' "$text" "$voice")"
case $? in
  0) ;;
  3) exit 0 ;;
  *) echo "speak.sh: could not build the request (python3 failed)" >&2; exit 1 ;;
esac

tmpdir="${TMPDIR:-/tmp}"
tmp="$(mktemp --suffix=.wav "$tmpdir/live-voice-speak.XXXXXX" 2>/dev/null)" || {
  echo "speak.sh: cannot create a temporary file in $tmpdir" >&2
  exit 1
}
child=""
cleanup() { rm -f -- "$tmp" "$tmp.code" "$tmp.err"; }
stop() {
  [ -n "$child" ] && kill "$child" 2>/dev/null
  cleanup
  exit 143
}
trap stop TERM INT
trap cleanup EXIT

# First line of a file, on one line, at most 200 characters.
first_line() { head -c 2000 -- "$1" 2>/dev/null | tr '\r\n' '  ' | cut -c1-200; }

retries=0
[ "$retry_s" -gt 0 ] 2>/dev/null && retries=$((retry_s / 2 + 1))
curl -sS --max-time 60 --retry "$retries" --retry-connrefused --retry-delay 2 --retry-max-time "$retry_s" \
  -H 'Content-Type: application/json' -d "$body" -o "$tmp" -w '%{http_code}' "$url" >"$tmp.code" 2>"$tmp.err" &
child=$!
if ! wait "$child"; then
  echo "speak.sh: Kokoro is not answering at $url: $(first_line "$tmp.err")" >&2
  exit 1
fi
code="$(cat -- "$tmp.code")"
if [ "$code" != "200" ]; then
  echo "speak.sh: Kokoro answered HTTP $code: $(first_line "$tmp")" >&2
  exit 1
fi
if [ ! -s "$tmp" ]; then
  echo "speak.sh: Kokoro returned no audio for the text" >&2
  exit 1
fi

paplay "$tmp" 2>"$tmp.err" &
child=$!
if ! wait "$child"; then
  echo "speak.sh: playback failed: $(first_line "$tmp.err")" >&2
  exit 1
fi
