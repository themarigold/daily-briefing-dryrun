#!/usr/bin/env bash
# Usage: bash scripts/uninstall.sh [--remove-signing-identity]
set -euo pipefail
SUPPORT="${DBA_TEST_DIR:-$HOME/Library/Application Support/daily-briefing}"
# PLIST is test-overridable too (else `bun test` would launchctl-unload + rm the REAL installed plist).
PLIST="${DBA_TEST_PLIST:-$HOME/Library/LaunchAgents/local.daily-briefing.plist}"
BIN="$SUPPORT/daily-briefing"
RECORD="$SUPPORT/schedule.json"
# The identity scripts/install.sh creates, and the engine's `schedule install` re-signs its managed copy
# with (src/schedule/install.ts DEFAULT_SIGN_IDENTITY).
SIGN_ID="Daily Briefing (local) Signing"

REMOVE_IDENTITY=""
for arg in "$@"; do
  case "$arg" in
    --remove-signing-identity) REMOVE_IDENTITY=1 ;;
    *) echo "usage: bash scripts/uninstall.sh [--remove-signing-identity]" >&2; exit 2 ;;
  esac
done

# Test interlock (c): DBA_TEST_KEYCHAIN is a TEST override, read only under DBA_TEST_DIR, and it becomes the
# keychain OPERAND of `security delete-identity` below, where a value like `-t` would parse as an option
# and leave no operand at all, and with none `security` searches the default list, login keychain included
# (`man security`, delete-identity). So: set without DBA_TEST_DIR → refuse; under DBA_TEST_DIR it must be an
# absolute path inside DBA_TEST_DIR (which can never begin with "-") with no ".." segment. Checked before
# anything runs; nothing is removed.
if [ -n "${DBA_TEST_KEYCHAIN+set}" ] && [ -z "${DBA_TEST_DIR:-}" ]; then
  echo "refusing: DBA_TEST_KEYCHAIN is set but DBA_TEST_DIR is not (it is a test-only override). Nothing was removed." >&2
  exit 1
fi
if [ -n "${DBA_TEST_KEYCHAIN:-}" ]; then
  KC_OK=""
  case "$DBA_TEST_KEYCHAIN" in
    */../*|*/..) ;;
    /*) case "$DBA_TEST_KEYCHAIN" in "$DBA_TEST_DIR"/?*) KC_OK=1 ;; esac ;;
  esac
  if [ -z "$KC_OK" ]; then
    echo "refusing: DBA_TEST_KEYCHAIN must be an absolute path inside DBA_TEST_DIR (\"$DBA_TEST_DIR/...\", no \"..\")," >&2
    echo "       got \"$DBA_TEST_KEYCHAIN\". Nothing was removed." >&2
    exit 1
  fi
fi
# Test interlock (a): under DBA_TEST_DIR the identity flag needs DBA_TEST_KEYCHAIN too, so a test can
# never reach the login keychain. Checked before anything runs; nothing is removed.
if [ -n "$REMOVE_IDENTITY" ] && [ -n "${DBA_TEST_DIR:-}" ] && [ -z "${DBA_TEST_KEYCHAIN:-}" ]; then
  echo "refusing --remove-signing-identity: DBA_TEST_DIR is set without DBA_TEST_KEYCHAIN (a test must name a scratch keychain). Nothing was removed." >&2
  exit 1
fi
if [ -n "${DBA_TEST_DIR:-}" ]; then
  KEYCHAIN="${DBA_TEST_KEYCHAIN:-}"
else
  KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
fi

# ── The schedule record (Phase E, E10). install.sh delegates to `schedule install --invoker cli`, which
# writes the record, and nothing here used to remove it, so a plain uninstall left a stale record behind.
# The engine is the record's single owner (R4), and the trigger the record describes may be the desktop
# app's, running the very managed binary this script deletes (src/schedule/install.ts managedBinPath). So
# while a record exists NOTHING below runs until the engine has removed its own schedule:
#   no record             → a pre-schedule install: the raw path below is all there is;
#   record, BIN not -x    → REFUSE: the owner cannot be asked (the binary is gone, or not runnable), and the
#                           raw path would unload and delete a trigger that may be the app's;
#   record, BIN -x        → `schedule uninstall`, its exit code (src/schedule/install.ts EXIT_*) captured
#                           rather than left to `set -e`:
#     0 removed → carry on;
#     1 nothing installed → carry on only if the record is gone. The engine returns 1 only when it found
#       no record (uninstallSchedule), so 1 with the record still on disk means the engine never really ran
#       (bash 3.2 reports a permission-denied exec as 1 when run bare, though as 126 inside the capture used
#       here; both measured) or could not read the record → stop;
#     2 another principal (typically the desktop app) owns the trigger → REFUSE: carrying on would delete
#       the binary that trigger runs and leave the app's schedule pointing at nothing. (An old engine with
#       no `schedule` command also exits 2, as an unknown command; then the record is stale, and the
#       message says how to clear it.)
#     anything else (3 = error; 126/127 = the binary could not be run at all) → stop.
#   Every stop and refusal exits non-zero having removed nothing. The engine's stderr is captured and
#   printed back, so its own reason stands beside ours.
# Test interlock (b): under DBA_TEST_DIR the binary runs with a scratch HOME, so even a real engine copy
# resolves its unit paths there and can never unload or unlink the live LaunchAgents plist.
stale_record_hint() {
  echo "       If nothing is scheduled, the record is stale: delete $RECORD and re-run." >&2
}
if [ -f "$RECORD" ]; then
  if [ ! -x "$BIN" ]; then
    echo "refusing: a schedule record exists ($RECORD), but the managed binary that owns it is missing or" >&2
    echo "       not executable ($BIN), so it cannot be asked to remove its schedule, and the trigger may be" >&2
    echo "       the desktop app's. Nothing was removed. If the app owns the schedule, remove it from the app's" >&2
    echo "       Schedule screen (or uninstall the app) and re-run." >&2
    stale_record_hint
    exit 1
  fi
  rc=0
  ENGINE_ERR=""
  if [ -n "${DBA_TEST_DIR:-}" ]; then
    { ENGINE_ERR="$(HOME="$DBA_TEST_DIR/home" DAILY_BRIEFING_STATE_DIR="$SUPPORT" "$BIN" schedule uninstall 2>&1 1>&3 3>&-)" || rc=$?; } 3>&1
  else
    { ENGINE_ERR="$(DAILY_BRIEFING_STATE_DIR="$SUPPORT" "$BIN" schedule uninstall 2>&1 1>&3 3>&-)" || rc=$?; } 3>&1
  fi
  if [ -n "$ENGINE_ERR" ]; then printf '%s\n' "$ENGINE_ERR" >&2; fi
  case "$rc" in
    0) ;;
    1)
      if [ -f "$RECORD" ]; then
        echo "ERROR: \"$BIN\" schedule uninstall reported nothing installed (exit 1), yet the record is still" >&2
        echo "       there, and the engine returns 1 only when it finds no record: it did not run, or could not" >&2
        echo "       read the record. Nothing was removed." >&2
        stale_record_hint
        exit 1
      fi
      ;;
    2)
      echo "refusing: the schedule is owned by another principal (typically the desktop app), and its trigger" >&2
      echo "       runs $BIN, so uninstalling now would leave it pointing at a deleted binary. Nothing was" >&2
      echo "       removed. Remove the schedule from the app's Schedule screen (or uninstall the app) and re-run." >&2
      echo "       An old engine without a \`schedule\` command exits 2 as well, as an unknown command:" >&2
      stale_record_hint
      exit 1
      ;;
    *)
      echo "ERROR: \"$BIN\" schedule uninstall failed (exit $rc). Nothing was removed." >&2
      echo "       If that binary is broken and nothing is scheduled, delete $RECORD and re-run." >&2
      exit "$rc"
      ;;
  esac
fi

# The identity is what the scheduled engine copy is signed with, and that copy's folder-access grant is
# keyed to it (R1's delegated principal). While a schedule record exists it is not ours to delete. After
# the block above this is reached with a record only if the engine reported success (0) yet left the
# record behind, or one appeared meanwhile; it stays as the identity's own guard.
if [ -n "$REMOVE_IDENTITY" ] && [ -f "$RECORD" ]; then
  echo "refusing --remove-signing-identity: a schedule record still exists ($RECORD), and the scheduled" >&2
  echo "engine is signed with '$SIGN_ID'. Nothing was removed. Remove the schedule first (the desktop" >&2
  echo "app's Schedule screen if the app owns it, else: \"$BIN\" schedule uninstall), then re-run." >&2
  echo "If the managed binary is already gone and nothing is scheduled, the record is stale: delete" >&2
  echo "$RECORD yourself and re-run." >&2
  exit 1
fi

# proceed: unload the agent (match install.sh's verb for cross-version parity) + remove our files.
# wake-schedule.json is no longer written (the pmset-wake mechanism was replaced by the StartInterval
# agent) but is still rm'd here to clean up the artifact a pre-#81 pmset-wake install left behind.
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$SUPPORT"/daily-briefing "$SUPPORT"/wake-schedule.json "$SUPPORT"/briefing.log "$SUPPORT"/briefing-latest.md 2>/dev/null || true
# Slice 1.5 T4.7 — three artifacts uninstall never removed, so "uninstall" left the user's own
# briefing text, their audit history AND the transcript telemetry on disk indefinitely:
#   briefing.log.1        the rotated log (rotation predates this; removal was never added)
#   audit-*.md            every self-audit report ever written
#   transcript-health.json the day-record telemetry (counts and codes only, but still ours to clean)
rm -f "$SUPPORT"/briefing.log.1 "$SUPPORT"/transcript-health.json 2>/dev/null || true
rm -f "$SUPPORT"/audit-*.md 2>/dev/null || true
# The dated briefing archive (added 2026-08-14). A DIRECTORY, so `rm -f` on a glob would not clear it
# and uninstall would silently leave the user's whole briefing history on disk — the same "removal was
# never added" defect the comment above records for briefing.log.1. Bounded to the one directory this
# tool owns; never a bare recursive delete of $SUPPORT, which is test-overridable.
rm -rf "$SUPPORT"/briefings 2>/dev/null || true
rm -f "$PLIST" 2>/dev/null || true
# (test mode) remove the sentinel so the test can assert deletion
[ -n "${DBA_TEST_DIR:-}" ] && rm -f "$DBA_TEST_DIR/sentinel" 2>/dev/null || true

# --remove-signing-identity (opt-in, T19): delete the identity's certificate and private key from the login
# keychain (DBA_TEST_KEYCHAIN in tests). `security` is called by NAME, never by absolute path, so a PATH
# stub intercepts it; test/uninstall.test.ts asserts both. No -t: install.sh never sets trust on it.
ID_FAILED=""
if [ -n "$REMOVE_IDENTITY" ]; then
  if security delete-identity -c "$SIGN_ID" "$KEYCHAIN"; then
    echo "Removed the '$SIGN_ID' code-signing identity from $KEYCHAIN."
  else
    echo "WARN: could not delete the '$SIGN_ID' identity from $KEYCHAIN (it may already be gone)." >&2
    ID_FAILED=1
  fi
fi

# A pre-StartInterval build may have left a repeating pmset wake armed that no CLI here disarms — flag
# it so the user can finish the cleanup (needs sudo; clears all repeat schedules, so we don't auto-run it).
if pmset -g sched 2>/dev/null | grep -qi "repeating power"; then
  echo "NOTE: a repeating power schedule is still set — if it's an orphaned daily-briefing wake, clear it with: sudo pmset repeat cancel" >&2
fi
if [ -n "$ID_FAILED" ]; then
  echo "Uninstalled, except the '$SIGN_ID' identity, which could not be deleted (see the WARN above)."
  exit 1
fi
echo "Uninstalled."
