#!/usr/bin/env bash
# Usage: bash scripts/uninstall.sh [--remove-signing-identity]
set -euo pipefail
SUPPORT="${DBA_TEST_DIR:-$HOME/Library/Application Support/daily-briefing}"
# PLIST is test-overridable too, so a test never judges the REAL agent file. Nothing here removes it or
# unregisters it: the plist is the engine's `schedule uninstall`'s to remove (Batch 2, spec 3.6.6).
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
# absolute path inside DBA_TEST_DIR (which can never begin with "-") with no ".." segment, inside it
# PHYSICALLY as well (its directory resolved, symlinks followed, must lie in DBA_TEST_DIR resolved the same
# way: a symlinked parent cannot carry it out) — and, since DBA_TEST_DIR could itself be an ancestor such
# as $HOME, never a real keychain: no login.keychain*, nothing under a Library/Keychains directory (judged
# as written AND with its directory resolved physically), and not a symlink. A directory that cannot be
# resolved refuses. Checked before anything runs; nothing is removed.
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
  if [ -n "$KC_OK" ]; then
    # Builtins and expansions only (no dirname/basename: the tests' PATH is stubs plus rm and grep), plus
    # /bin/pwd by absolute path: the path as written, then its directory physically — by the builtin
    # `pwd -P`, as before, and CANONICALLY by /bin/pwd -P (getcwd), since the builtin keeps a typed case
    # variant and the /System/Volumes/Data firmlink spelling (measured, bash 3.2 on macOS, 2026-10-02),
    # which a case-sensitive pattern below, or the inside-DBA_TEST_DIR prefix test, would read as another
    # path. Every spelling is judged, and each check only ever clears KC_OK, so each can only refuse more.
    KC_DIR="${DBA_TEST_KEYCHAIN%/*}"
    KC_DIR_P="$(cd -P "$KC_DIR" 2>/dev/null && pwd -P)" || KC_DIR_P=""
    KC_DIR_C="$(cd -P "$KC_DIR" 2>/dev/null && /bin/pwd -P)" || KC_DIR_C=""
    TEST_DIR_C="$(cd -P "$DBA_TEST_DIR" 2>/dev/null && /bin/pwd -P)" || TEST_DIR_C=""
    [ -n "$KC_DIR_P" ] && [ -n "$KC_DIR_C" ] && [ -n "$TEST_DIR_C" ] || KC_OK=""
    case "$KC_DIR_C/" in "$TEST_DIR_C/"*) ;; *) KC_OK="" ;; esac
    for kc in "$DBA_TEST_KEYCHAIN" "$KC_DIR_P/${DBA_TEST_KEYCHAIN##*/}" "$KC_DIR_C/${DBA_TEST_KEYCHAIN##*/}"; do
      case "$kc" in */Library/Keychains/*|*/login.keychain*) KC_OK="" ;; esac
    done
    [ ! -L "$DBA_TEST_KEYCHAIN" ] || KC_OK=""
  fi
  if [ -z "$KC_OK" ]; then
    echo "refusing: DBA_TEST_KEYCHAIN must be an absolute path inside DBA_TEST_DIR (\"$DBA_TEST_DIR/...\", no \"..\"," >&2
    echo "       its directory inside DBA_TEST_DIR once both are resolved physically, symlinks followed)," >&2
    echo "       and never a real keychain (login.keychain*, anything under Library/Keychains) or a symlink;" >&2
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

# ── The background scheduler (Batch 2, spec 3.6.6). Nothing below runs until the scheduler is dealt with,
# and this script never changes a registration and never deletes a scheduler file itself: the ENGINE removes
# its own scheduler, by label, and reports success only once its own check finds the job gone
# (src/schedule/install.ts uninstallSchedule). The job may be the desktop app's, running the very managed
# binary this script deletes, so a scheduler nothing here can remove stops the script with the manual steps.
#   A NEW ENOUGH engine — $BIN an executable regular file whose own text holds the word removeSteps (read,
#   never run), and whose `schedule status --json` then carries removeSteps — is ALWAYS asked, with or
#   without a record (its own first check finds a job loaded with no files), and its exit code (EXIT_*) is
#   captured rather than left to `set -e`:
#     0 removed → carry on;
#     1 nothing installed → carry on only when neither $RECORD nor $PLIST exists, it printed its line on
#       stdout, and the status read just made did not say "registered":true. A crash also exits 1, with
#       nothing on stdout. The app applies the same rule (spec 3.3.4.3) from another source of facts: its
#       status read taken BEFORE the call (no record file, no unit file, not registered), where this script
#       takes its own lstat of $RECORD and $PLIST AFTER the call, beside that read's "registered";
#     2 another principal (typically the desktop app) owns it → REFUSE: carrying on would delete the binary
#       its job runs. The way out is the app's Schedule screen, or a take-over once the app is gone;
#     anything else (3 = error, which carries the manual steps; 126/127 = it could not run) → stop.
#   NO new enough engine (missing, not executable, not a regular file, too old — its file lacks the word,
#   or its status does — or its status read failed: an older engine, v0.2.0 for one, still has the
#   unchecked uninstall, so it is never asked to remove anything):
#     a record → stop with the manual steps (the app's Schedule screen first, when the record names the app);
#     a plist and no record → stop with the manual steps;
#     neither → ONE read-only launchd check (`print` both domains, `list`; once each, no polling, nothing that
#       changes a registration), carrying on only if each answers not found by the engine's rule (spec
#       3.1.5). A job left loaded with no files is never mistaken for nothing scheduled.
#   Every stop exits non-zero having removed nothing itself. The engine's stderr is printed back line by
#   line, minus its " Re-run with --take-over" advice (this script takes no such flag) and with its own
#   closing line replaced, in its place, by this script's (spec 3.1.8).
# Test interlock (b): under DBA_TEST_DIR every "$BIN" call (the status read and the uninstall) runs with a
# scratch HOME AND DBA_TEST_UNIT_DIR="$DBA_TEST_DIR/units", so even a real engine copy resolves its unit
# paths there, and its default exec refuses every scheduler change (spec 3.1.3). The scratch HOME alone was
# not enough: launchd finds a job by label and acts by uid, whatever HOME says.
LABEL="local.daily-briefing"
SCRIPT_CLOSING="Then run this script again."
ENGINE_CLI_CLOSING='Then run `daily-briefing schedule uninstall` again.'

# Every "$BIN" call goes through here, so none can miss test interlock (b).
engine() {
  if [ -n "${DBA_TEST_DIR:-}" ]; then
    HOME="$DBA_TEST_DIR/home" DBA_TEST_UNIT_DIR="$DBA_TEST_DIR/units" DAILY_BRIEFING_STATE_DIR="$SUPPORT" "$BIN" "$@"
  else
    DAILY_BRIEFING_STATE_DIR="$SUPPORT" "$BIN" "$@"
  fi
}

# Present the way the engine looks (spec 3.1.2, lstat): a dangling symlink counts.
present() { [ -e "$1" ] || [ -L "$1" ]; }

# The engine's stderr, line by line as it arrives, with builtins only (the tests' PATH is stubs plus rm and
# grep): its closing line becomes this script's, in its place; its --take-over advice is dropped.
engine_message() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$line" = "$ENGINE_CLI_CLOSING" ]; then
      printf '%s\n' "$SCRIPT_CLOSING"
    else
      printf '%s\n' "${line%% Re-run with --take-over*}"
    fi
  done
}

# The manual steps (spec 3.1.8): the engine's own text for the default paths, which test/uninstall.test.ts
# pins against what this PRINTS, then this script's closing line. A quoted here-document: nothing in it is
# expanded or run here; "$HOME" and $(id -u) are for the user's own terminal.
manual_steps() {
  local line
  while IFS= read -r line; do printf '%s\n' "$line" >&2; done <<'EOF_STEPS'
Run these in a terminal (bash or zsh) inside your desktop session.
1. Unregister the job:
   launchctl bootout gui/$(id -u)/local.daily-briefing; launchctl bootout user/$(id -u)/local.daily-briefing
2. Wait a few seconds.
3. Confirm it is gone. Each of these must report not found: it prints "Could not find service", or its last line is "exit 113".
   launchctl print gui/$(id -u)/local.daily-briefing; echo "exit $?"
   launchctl print user/$(id -u)/local.daily-briefing; echo "exit $?"
   launchctl list local.daily-briefing; echo "exit $?"
   If the first one says "Could not find domain", this terminal is not in your desktop session (over SSH, for example): run these steps from a desktop session instead. The second one may say "Could not find domain"; that is fine.
   If the last one still finds the job (one loaded in another session), run this in the same terminal, wait a few seconds, and confirm again:
   launchctl remove local.daily-briefing
4. Delete the files:
   rm -f -- "$HOME"/'Library/LaunchAgents/local.daily-briefing.plist' "$HOME"/'Library/Application Support/daily-briefing/schedule.json'
EOF_STEPS
  printf '%s\n' "$SCRIPT_CLOSING" >&2
}

# The engine's not-found rule for launchd (spec 3.1.5; probeRegistration in src/schedule/install.ts).
domain_missing() { case "$1" in *"Could not find domain"*) return 0 ;; esac; return 1; }
service_missing() {   # $1: exit code, $2: stderr. Never the domain text, whatever the code.
  if domain_missing "$2"; then return 1; fi
  if [ "$1" = 113 ]; then return 0; fi
  case "$2" in *"Could not find service"*) return 0 ;; esac
  return 1
}

# The ONE read-only check, for when no engine can be asked (spec 3.6.6): each command once, reading its exit
# code and stderr. Gone only when `print gui` and `list` each report the service not found and `print user`
# does too or reports its domain missing; any exit 0 is a job still loaded, and `print gui`'s missing domain
# means this terminal is not in the desktop session. Sets LAUNCHD_FOUND to what stops the script.
LAUNCHD_FOUND=""
launchd_says_gone() {
  local gui_err="" user_err="" list_err="" gui_rc=0 user_rc=0 list_rc=0
  gui_err="$(launchctl print "gui/$UID/$LABEL" 2>&1 >/dev/null)" || gui_rc=$?
  user_err="$(launchctl print "user/$UID/$LABEL" 2>&1 >/dev/null)" || user_rc=$?
  list_err="$(launchctl list "$LABEL" 2>&1 >/dev/null)" || list_rc=$?
  if [ "$gui_rc" = 0 ] || [ "$user_rc" = 0 ] || [ "$list_rc" = 0 ]; then
    LAUNCHD_FOUND="it still has a job loaded as $LABEL"
  elif domain_missing "$gui_err"; then
    LAUNCHD_FOUND="it could not find your desktop session's domain, so this terminal is not in that session"
  elif service_missing "$gui_rc" "$gui_err" \
    && { service_missing "$user_rc" "$user_err" || domain_missing "$user_err"; } \
    && service_missing "$list_rc" "$list_err"; then
    return 0
  else
    LAUNCHD_FOUND="it did not answer that $LABEL is not loaded"
  fi
  return 1
}

ENGINE_REMOVED=""
NEW_ENOUGH=""
STATUS_JSON=""
# The status read RUNS $BIN, so the FILE is read first and run only when its own text holds the word
# removeSteps: a managed binary built from a checkout before 2026-07-15 treats every first argument but
# `init` as `run`, so asking it for its status (or its --help, or its --version) would generate a briefing.
# The compiled engine holds the word once and never in quotes, hence the bare word. A regular file only,
# so grep never blocks on a FIFO. A miss is the fail-safe direction: it takes the no-new-enough branches
# below, where a record or a plist stops the script with the manual steps and nothing on disk gets the
# read-only check. Both gates must pass: the word in the file, then removeSteps in the status it prints.
if [ -f "$BIN" ] && [ -x "$BIN" ] && grep -aqF removeSteps "$BIN" 2>/dev/null; then
  # Any failure of the status read (an unrunnable binary, an error exit, no output) reads as not new enough.
  STATUS_JSON="$(engine schedule status --json 2>/dev/null)" || STATUS_JSON=""
  # The status as JSON.stringify writes it: compact, as src/main.ts's status arm prints it (pinned in
  # test/uninstall.test.ts), or indented, where the key is still followed directly by its colon. A status
  # without the key reads as too old, which fails safe.
  case "$STATUS_JSON" in *'"removeSteps":'*) NEW_ENOUGH=1 ;; esac
fi
if [ -n "$NEW_ENOUGH" ]; then
  # stdout is captured (the exit-1 rule reads it) and printed back after; stderr goes through
  # engine_message as it arrives. The engine's own exit code is read from PIPESTATUS, with errexit off
  # inside the capture, so neither the filter nor `set -e` can stand in for it.
  rc=0
  ENGINE_OUT="$(
    set +e
    { engine schedule uninstall 2>&1 1>&3 3>&- | engine_message >&2 3>&-; s="${PIPESTATUS[0]}"; } 3>&1
    exit "$s"
  )" || rc=$?
  [ -z "$ENGINE_OUT" ] || printf '%s\n' "$ENGINE_OUT"
  case "$rc" in
    0) ENGINE_REMOVED=1 ;;
    1)
      # Its line, as Rust reads it: anything but whitespace. "registered":true as `JSON.stringify` writes it:
      # compact, as src/main.ts's status arm prints it (pinned in test/uninstall.test.ts), or indented
      # (one space after the colon). Missing it would lose this doubt (failing open), so both spellings count.
      case "$ENGINE_OUT" in *[![:space:]]*) PRINTED=1 ;; *) PRINTED="" ;; esac
      case "$STATUS_JSON" in *'"registered":true'*|*'"registered": true'*) REGISTERED=1 ;; *) REGISTERED="" ;; esac
      DOUBT=""
      if present "$RECORD"; then
        DOUBT="the schedule record is still there ($RECORD)"
      elif present "$PLIST"; then
        DOUBT="the launchd agent file is still there ($PLIST)"
      elif [ -z "$PRINTED" ]; then
        DOUBT="it printed nothing on stdout, which is how a crash exits 1"
      elif [ -n "$REGISTERED" ]; then
        DOUBT="its status read just before said the job is registered"
      fi
      if [ -n "$DOUBT" ]; then
        echo "ERROR: \"$BIN\" schedule uninstall exited 1 (nothing installed), but $DOUBT, so that" >&2
        echo "       answer cannot be trusted. Nothing was removed." >&2
        manual_steps
        exit 1
      fi
      ;;
    2)
      echo "refusing: the background scheduler is owned by another principal (typically the desktop app), and it" >&2
      echo "       runs $BIN, so uninstalling now would leave it pointing at a deleted binary. Nothing was" >&2
      echo "       removed. Remove it on the app's Schedule screen (\"Remove background scheduler…\"), then run" >&2
      echo "       this script again; \"$BIN\" schedule status shows who owns it." >&2
      echo "If the app is already gone, run \"$BIN\" schedule uninstall --take-over, then run this script again." >&2
      exit 1
      ;;
    *)
      # The engine's message above carries the manual steps and says what, if anything, it removed (spec 3.1.7).
      echo "ERROR: \"$BIN\" schedule uninstall failed (exit $rc). This script removed nothing; the engine's message above says what it removed, if anything." >&2
      exit "$rc"
      ;;
  esac
else
  if present "$RECORD"; then
    # Its owner, for the lead: writeScheduleRecord pretty-prints the record, hence the optional space. A
    # regular file only, so grep can never block on a FIFO.
    if [ -f "$RECORD" ] && grep -Eq '"owner":[[:space:]]*"app"' "$RECORD" 2>/dev/null; then
      echo "Remove it on the app's Schedule screen, if the app is still installed." >&2
    fi
    echo "refusing: a schedule record exists ($RECORD), but the engine that would remove its background" >&2
    echo "       scheduler, $BIN, is missing, not executable, too old, or could not report its status," >&2
    echo "       so it is not asked to. Nothing was removed." >&2
    manual_steps
    echo "Or update the engine with scripts/install.sh, which re-installs the background schedule and may generate a briefing, then run this again." >&2
    exit 1
  fi
  if present "$PLIST"; then
    echo "refusing: a launchd agent file is at $PLIST, with no schedule record, and no engine new enough" >&2
    echo "       to remove its background scheduler safely ($BIN is missing, not executable," >&2
    echo "       too old, or could not report its status). Nothing was removed." >&2
    manual_steps
    exit 1
  fi
  if ! launchd_says_gone; then
    echo "refusing: no schedule record or launchd agent file was found, and no engine new enough to check is" >&2
    echo "       installed, so launchd was asked directly: $LAUNCHD_FOUND. Nothing was removed." >&2
    manual_steps
    exit 1
  fi
fi

# The identity is what the scheduled engine copy is signed with, and that copy's folder-access grant is
# keyed to it (R1's delegated principal). While a schedule record exists it is not ours to delete. After
# the block above this is reached with a record only if the engine reported success (0) yet left the
# record behind, or one appeared meanwhile; it stays as the identity's own guard.
if [ -n "$REMOVE_IDENTITY" ] && [ -f "$RECORD" ]; then
  if [ -n "$ENGINE_REMOVED" ]; then
    # The engine exited 0 above: it has already removed the trigger, whatever its record says.
    removed="The engine has already removed the schedule's trigger (above); nothing else was removed."
  else
    removed="Nothing was removed."
  fi
  echo "refusing --remove-signing-identity: a schedule record still exists ($RECORD), and the scheduled" >&2
  echo "engine is signed with '$SIGN_ID'. $removed Remove the schedule first (the desktop" >&2
  echo "app's Schedule screen if the app owns it, else: \"$BIN\" schedule uninstall), then re-run." >&2
  exit 1
fi

# Carry on: the scheduler is dealt with — the engine removed it (exit 0), or found nothing installed with
# nothing on disk (exit 1), or launchd answered not found with nothing on disk — so nothing left registered
# runs the managed binary. Remove our files; the scheduler's own (the plist, the record) are the engine's.
# wake-schedule.json is no longer written (the pmset-wake mechanism was replaced by the StartInterval
# agent) but is still rm'd here to clean up the artifact a pre-#81 pmset-wake install left behind.
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
# Phase E (E11): the opt-in update check's last answer (src/updateCheck.ts). Mirrored by the desktop app's
# ENGINE_STATE_REMOVALS (gui/src-tauri/src/uninstall.rs), which gui/src-tauri/tests/uninstall.rs pins to
# this script's "$SUPPORT"-rooted list.
rm -f "$SUPPORT"/update-check.json 2>/dev/null || true
# Batch 2 (spec 3.5.1): the rest of what the engine owns at the state root (src/json.ts engineOwns): the
# day marker and tick, the skip record, the run lock, the account store and the recap-campaigns record.
# Mirrored token for token by the desktop app's ENGINE_STATE_REMOVALS, like every line above.
rm -f "$SUPPORT"/last-run "$SUPPORT"/last-tick "$SUPPORT"/last-skip.json "$SUPPORT"/run.lock 2>/dev/null || true
rm -f "$SUPPORT"/account-state.json "$SUPPORT"/recap-campaigns.jsonl 2>/dev/null || true
# The provider's scratch working folder (src/harden.ts): a DIRECTORY, removed with its contents the way
# briefings is, and bounded the same way — never a bare recursive delete of $SUPPORT.
rm -rf "$SUPPORT"/provider-cwd 2>/dev/null || true

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
# grep reads ALL of pmset's output (no -q): under pipefail, a `grep -q` that exits at its first match can
# leave pmset to die of SIGPIPE, failing the pipeline and hiding the note exactly when it matched.
if pmset -g sched 2>/dev/null | grep -i "repeating power" >/dev/null; then
  echo "NOTE: a repeating power schedule is still set — if it's an orphaned daily-briefing wake, clear it with: sudo pmset repeat cancel" >&2
fi
# The settings folder holds the settings and may hold the API key file they name. Removing it is the
# desktop app's alone (its Uninstall checkbox, which checks each key file first), so this script keeps it
# and says so (spec 3.5.3).
echo "Kept your settings folder, ~/.config/daily-briefing: this script never removes it, and it may hold your API key file."
if [ -n "$ID_FAILED" ]; then
  echo "Uninstalled, except the '$SIGN_ID' identity, which could not be deleted (see the WARN above)."
  exit 1
fi
echo "Uninstalled."
