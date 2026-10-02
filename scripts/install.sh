#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT="$HOME/Library/Application Support/daily-briefing"
BIN="$SUPPORT/daily-briefing"
# LOG and PLIST are gone with the `sed` that consumed them — `schedule install` derives both from the
# same state-dir helpers the engine itself uses, and creates ~/Library/LaunchAgents if it is missing.

mkdir -p "$SUPPORT"
echo "Building single binary…"
( cd "$ROOT" && bun build src/main.ts --compile --outfile "$BIN" )

# Code-sign the binary so its macOS TCC grant (Files-&-Folders / Full Disk Access, needed to read
# repos under ~/Desktop etc.) PERSISTS across rebuilds. An ad-hoc signature (codesign -s -) changes
# the binary's cdhash on every rebuild, so macOS treats each `install.sh` run as a brand-new program
# and re-prompts for folder access. A stable local self-signed identity gives a fixed designated
# requirement (identity + identifier), so the grant survives re-installs. The cert never leaves this
# machine and is created on demand; if anything about it fails we degrade to ad-hoc + a warning so
# hermetic/CI installs (no keychain) still succeed.
SIGN_ID="Daily Briefing (local) Signing"
OPENSSL=openssl
[ -x /usr/local/bin/openssl ] && OPENSSL=/usr/local/bin/openssl
[ -x /opt/homebrew/bin/openssl ] && OPENSSL=/opt/homebrew/bin/openssl

ensure_identity() {
  security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_ID" && return 0
  echo "Creating a one-time local code-signing identity ($SIGN_ID)…"
  local dir pw; dir="$(mktemp -d)"; pw="dba-local"; trap 'rm -rf "$dir"' RETURN
  # Self-signed leaf cert with EXACTLY the extensions macOS codesign requires: Digital Signature key
  # usage + the codeSigning EKU + CA:FALSE. Omitting keyUsage (or leaving the -x509 default CA:TRUE)
  # makes codesign reject the identity with "no identity found" even though it lists. On the homebrew
  # preference above: macOS's /usr/bin/openssl is LibreSSL, whose req DOES have -addext but whose pkcs12
  # has no -legacy (measured with LibreSSL 3.3.6, 2026-10-01); the p12 step below retries without it.
  "$OPENSSL" req -x509 -newkey rsa:2048 -keyout "$dir/key.pem" -out "$dir/cert.pem" \
    -days 3650 -nodes -subj "/CN=$SIGN_ID" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1 || return 1
  # Bundle key+cert as PKCS#12. -legacy (OpenSSL 3's modern ciphers won't import) + -macalg sha1 and a
  # NON-empty password: macOS `security import` rejects a SHA-256-MAC / empty-password p12 with a
  # bogus "MAC verification failed (wrong password?)". The password never leaves this function.
  "$OPENSSL" pkcs12 -export -legacy -macalg sha1 -inkey "$dir/key.pem" -in "$dir/cert.pem" \
    -out "$dir/id.p12" -passout "pass:$pw" >/dev/null 2>&1 \
    || "$OPENSSL" pkcs12 -export -macalg sha1 -inkey "$dir/key.pem" -in "$dir/cert.pem" \
      -out "$dir/id.p12" -passout "pass:$pw" >/dev/null 2>&1 || return 1
  # Import into the login keychain with `-A` so the install-time `codesign` below can use the key
  # non-interactively. KNOWN LIMITATION (review #15): `-A` opens the key's ACL to ANY application — a
  # needless local privilege surface (any process could use this key, inheriting the Files-&-Folders/FDA
  # grant tied to the signed binary). The tighter `-T /usr/bin/codesign` is NOT a safe drop-in here:
  # since macOS Sierra, code-signing ALSO enforces a keychain PARTITION LIST, and `-A` is what sets a
  # permissive one; `-T` alone leaves the default partition list, so `codesign` then either prompts per
  # run or fails (errSecInternalComponent) and we degrade to an ad-hoc signature — losing the persistent
  # TCC grant this whole block exists for. Setting the partition list (`security set-key-partition-list`)
  # needs the LOGIN keychain password, which this non-interactive installer can't supply. Properly
  # scoping the ACL therefore requires a DEDICATED keychain (created with a known password → import →
  # set-key-partition-list → reference it at sign time → clean up on uninstall) — a distribution-hardening
  # step that is NOT done here: on the backlog since 2026-10-01 (Phase E, T19). Why it stays open: this
  # source install remains a supported path as-is; the release pipeline already signs the app in CI
  # through exactly that dedicated-keychain pattern (publish/.github/workflows/release.yml); and the
  # residue an uninstall could not clean — this identity in the login keychain — is now removable with
  # `bash scripts/uninstall.sh --remove-signing-identity`. Reopen it if this local identity ever signs
  # anything that leaves this machine. T19's closure (a) — this script printing that it is the legacy
  # developer path and the app bundle the supported install — is deliberately a NO-OP under the Phase E
  # plan §1: the source install stays supported, so it prints no such line. (The p12 lives briefly in a
  # mktemp dir with a non-empty password, removed on exit.)
  security import "$dir/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$pw" -A >/dev/null 2>&1 \
    || security import "$dir/id.p12" -P "$pw" -A >/dev/null 2>&1 || return 1
  security find-identity -p codesigning 2>/dev/null | grep -q "$SIGN_ID"
}

if ensure_identity; then
  # --identifier pins the designated requirement so the TCC grant is stable across rebuilds.
  # Guarded: a signing hiccup must not abort the install under set -e — the unsigned binary still
  # runs and the launchd load below matters more (the TCC grant just may need re-adding).
  if codesign --force --sign "$SIGN_ID" --identifier local.daily-briefing "$BIN"; then
    echo "Signed with local identity '$SIGN_ID' — the macOS folder-access grant will persist across re-installs."
  else
    echo "WARN: codesign with '$SIGN_ID' failed — falling back to an ad-hoc signature; the grant may not persist." >&2
    codesign -s - -f "$BIN" || true
  fi
else
  echo "WARN: could not create/find a stable signing identity — falling back to an ad-hoc signature." >&2
  echo "      macOS may re-prompt for folder access after each rebuild. Install a real 'openssl'" >&2
  echo "      (e.g. \`brew install openssl\`) and re-run to get a persistent grant." >&2
  codesign -s - -f "$BIN" || true
fi

# ── THE PLIST HALF IS DELEGATED TO THE BINARY (Slice 4 T2).
#
# This used to `sed` three placeholders into a checked-in `install/local.daily-briefing.plist` and
# then launchctl-load the result. That template is GONE, and the substitution with it, because it was
# a SECOND spelling of the unit: a downloaded artifact has no checkout, no `install/` directory and no
# `sed`, so the binary had to be able to write its own unit — and once it can, two spellings is just
# an invitation to drift. `src/schedule/units.ts` is now the only source, and this script delegates to
# it rather than keeping a copy in step by hand.
#
# What stays here is exactly what a binary genuinely cannot do for itself: compile from source, and
# bootstrap the local signing identity before a binary exists. `schedule install` re-signs its managed
# copy with the same identity (idempotent — `codesign --force`), writes the plist, loads the agent and
# runs a verification kickstart as its final step.
#
# ⚠ THE UNIT IT WRITES IS BYTE-IDENTICAL TO WHAT THE OLD `sed` PRODUCED, except for one added
# `StartCalendarInterval` block (the second trigger — see EVAL.md's delivery-mechanism note). That was
# verified by generating into a scratch directory and diffing against a read-only capture of the
# installed plist, because this script is the author's live deploy path and a mistake here silently
# stops the daily briefing.
#
# ⚠ rc IS CAPTURED, NOT ASSUMED. This script runs under `set -euo pipefail`, so a bare invocation
# would ABORT here on the delegated installer's exit 2 — the FOREIGN-OWNER code, which is not a
# failure of this script but a coexistence fact (the desktop app installed the trigger). Aborting
# swallowed both of the steps below: the config hint and the orphaned-pmset-wake migration, the
# second of which exists precisely for machines carrying old state. So: 2 prints the take-over
# instruction and CONTINUES; anything else non-zero still fails the install, loudly.
rc=0
"$BIN" schedule install --invoker cli || rc=$?
if [ "$rc" -eq 2 ]; then
  echo "NOTE: the OS trigger is owned by another principal (typically the desktop app), so this" >&2
  echo "      install left it alone. To claim it for the CLI, run:" >&2
  echo "        \"$BIN\" schedule install --invoker cli --take-over" >&2
  echo "      Everything else below still applies." >&2
elif [ "$rc" -ne 0 ]; then
  echo "ERROR: \"$BIN\" schedule install failed (exit $rc)." >&2
  exit "$rc"
fi
echo "Config: run \"$BIN\" init  (if you haven't already)."

# Migration: a pre-StartInterval build may have armed a repeating `pmset` wake (the old pmset-wake
# delivery, since replaced by this interval agent) that nothing here disarms — the RTC wake then fires
# daily forever. Detect and advise; do NOT auto-cancel (it needs sudo, and `pmset repeat cancel` clears
# ALL repeat schedules, including any the user set for other reasons).
if pmset -g sched 2>/dev/null | grep -qi "repeating power"; then
  echo "NOTE: a repeating power schedule is set. If it's an orphaned wake from a pre-StartInterval" >&2
  echo "      daily-briefing build, clear it with: sudo pmset repeat cancel" >&2
fi
