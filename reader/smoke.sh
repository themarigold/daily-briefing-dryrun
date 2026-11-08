#!/usr/bin/env bash
# reader/smoke.sh — run a BUILT reader directly against a real FIFO (v0.3.0 plan M10a). macOS only.
#
# Usage: bash reader/smoke.sh "<folder>/Daily Briefing Calendar Reader.app"
#
# Starts the executable directly (not through LaunchServices) in `status` mode, which reads only the
# authorization status (a class method: no event store, no dialog, no calendar data), and checks:
#   1. a usage error exits 2;
#   2. a REGULAR FILE where the FIFO should be is refused (exit 1) and stays empty;
#   3. a FIFO in a folder other than <bundle>/../run is refused (exit 1);
#   4. a symlink where the FIFO should be is refused (exit 1);
#   5. the real FIFO receives one JSON document with the invocation id, a status and the helper version.
# Run by the public ci.yml's macOS job and by hand on a Mac (the private CI has no macOS job, user decision
# 2026-10-12). It never runs `read`, `list` or `request`.
set -euo pipefail

APP="${1:?usage: smoke.sh <path to Daily Briefing Calendar Reader.app>}"
EXE="$APP/Contents/MacOS/Daily Briefing Calendar Reader"
RUN="$(dirname "$APP")/run"
ID="0123456789abcdef0123456789abcdef"
fail() { echo "reader smoke: FAIL — $*" >&2; exit 1; }

[ -x "$EXE" ] || fail "no executable at $EXE"
mkdir -p "$RUN" && chmod 700 "$RUN"
OTHER="$(mktemp -d)"
reader=""
trap '[ -n "$reader" ] && kill "$reader" 2>/dev/null; rm -rf "$OTHER" "$RUN/$ID.fifo"' EXIT

set +e
"$EXE" status; code=$?
set -e
[ "$code" = 2 ] || fail "a usage error exited $code, not 2"

: > "$RUN/$ID.fifo"
set +e
"$EXE" status --fifo "$RUN/$ID.fifo" --id "$ID"; code=$?
set -e
[ "$code" = 1 ] || fail "a regular file was not refused (exit $code)"
[ ! -s "$RUN/$ID.fifo" ] || fail "the helper wrote into a regular file"
rm -f "$RUN/$ID.fifo"

mkfifo -m 600 "$OTHER/$ID.fifo"
set +e
"$EXE" status --fifo "$OTHER/$ID.fifo" --id "$ID"; code=$?
set -e
[ "$code" = 1 ] || fail "a FIFO outside <bundle>/../run was not refused (exit $code)"

ln -s "$OTHER/$ID.fifo" "$RUN/$ID.fifo"
set +e
"$EXE" status --fifo "$RUN/$ID.fifo" --id "$ID"; code=$?
set -e
[ "$code" = 1 ] || fail "a symlink in place of the FIFO was not refused (exit $code)"
rm -f "$RUN/$ID.fifo"

mkfifo -m 600 "$RUN/$ID.fifo"
OUT="$OTHER/out.json"
cat "$RUN/$ID.fifo" > "$OUT" &
reader=$!
"$EXE" status --fifo "$RUN/$ID.fifo" --id "$ID" || fail "status mode exited non-zero with a reader connected"
wait "$reader"
reader=""
grep -q "\"id\":\"$ID\"" "$OUT" || fail "the document lacks the invocation id: $(head -c 300 "$OUT")"
grep -Eq '"status":"(ok|not-granted|denied|restricted|write-only)"' "$OUT" || fail "no known status: $(head -c 300 "$OUT")"
grep -q '"helperVersion":"' "$OUT" || fail "no helperVersion: $(head -c 300 "$OUT")"
echo "reader smoke: ok ($(head -c 200 "$OUT"))"
