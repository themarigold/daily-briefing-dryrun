#!/usr/bin/env bash
# ci-tauri-build.sh — the ONE way the release workflow runs `tauri build` (Phase E, E5).
#
# Usage: bash scripts/ci-tauri-build.sh <rust-target-triple> <signed|unsigned>
#   (run from gui/, as every bundle leg of publish/.github/workflows/release.yml does)
#
# Every bundle leg (macOS arm64 and x64, Linux, Windows) goes through this script, so the signing
# rules below hold on every leg by construction rather than by each leg remembering them.
#
# SIGNING. The mode is an explicit argument; nothing is defaulted, so a lost job output (an empty
# string) is refused rather than silently read as "unsigned".
#   unsigned, macOS   APPLE_SIGNING_IDENTITY=-   Tauri ad-hoc signs and seals the bundle, applying the
#                                                hardened runtime and entitlements.plist (tauri-bundler
#                                                macos/sign.rs `sign`). The DMG itself stays unsigned.
#   unsigned, other   APPLE_SIGNING_IDENTITY unset.
#   signed, macOS     APPLE_SIGNING_IDENTITY must arrive non-empty and not `-`: the workflow's import
#                     step writes it to $GITHUB_ENV after importing the identity into a dedicated
#                     keychain. A lost $GITHUB_ENV write therefore fails HERE, loudly.
#   signed, other     refused: there is nothing to sign with off macOS.
#
# REFUSED INPUTS. Tauri's own certificate import (APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD)
# accepts only Apple-issued certificates (tauri-macos-sign keychain/identity.rs `list`) and builds its
# keychain under the real ~/Library/Keychains (keychain.rs `with_certificate_file`), so it is never
# used. Any APPLE_CERTIFICATE*, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID or APPLE_API_* variable that
# arrives in this script's environment — set, or set to the empty string — is refused before
# anything runs: notarization input comes ONLY through the DBA_NOTARIZE_* names below.
#
# NOTARIZATION (parameterized and empty until Apple enrollment; user decision 2026-09-29). The
# workflow always defines all six DBA_NOTARIZE_* variables, empty when the secret is unset, so an
# empty value is treated as ABSENT:
#   AppleId set   DBA_NOTARIZE_APPLE_ID, DBA_NOTARIZE_APPLE_PASSWORD, DBA_NOTARIZE_APPLE_TEAM_ID
#                 -> APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#   API set       DBA_NOTARIZE_API_KEY, DBA_NOTARIZE_API_ISSUER, DBA_NOTARIZE_API_KEY_P8
#                 -> APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH (the .p8 written to a temp
#                    file, removed when this script exits)
# In BOTH modes, a partial set is refused and both sets complete is refused (one notarization path,
# no silent preference). In SIGNED mode only, the one complete set is exported (tauri-bundler
# macos/sign.rs `notarize_auth` reads these names); none exports nothing. In UNSIGNED mode nothing is
# exported, even a complete set: an ad-hoc signature cannot be notarized.
#
# The Tauri CLI is the @tauri-apps/cli devDependency (gui/package.json); nothing named `tauri` is on
# PATH on the runners. TAURI_CMD overrides it — the tests' only seam (a stub that records its
# environment), never set by the workflow.
set -euo pipefail

die() { echo "ci-tauri-build: $*" >&2; exit 1; }

[ "$#" -eq 2 ] || die "usage: ci-tauri-build.sh <rust-target-triple> <signed|unsigned>"
TRIPLE="$1"
MODE="$2"
[ -n "$TRIPLE" ] || die "empty target triple"
case "$MODE" in
  signed|unsigned) ;;
  *) die "signing mode '$MODE' is not exactly 'signed' or 'unsigned' (an empty value means the gate job's output was lost)" ;;
esac

TAURI_CMD="${TAURI_CMD:-"$(dirname "$0")/../node_modules/.bin/tauri"}"

# ── refused APPLE_* inputs: set at all, even empty ──────────────────────────────────────────────
# `compgen -e` lists every exported variable, so a name that is exported but empty is caught too.
REFUSED=""
for name in $(compgen -e); do
  case "$name" in
    APPLE_CERTIFICATE*|APPLE_ID|APPLE_PASSWORD|APPLE_TEAM_ID|APPLE_API_*) REFUSED="$REFUSED $name" ;;
  esac
done
[ -z "$REFUSED" ] || die "refusing:${REFUSED# } arrived in the environment. Signing uses APPLE_SIGNING_IDENTITY only, and notarization input comes only through DBA_NOTARIZE_* (see this script's header)"

# ── the signing identity ────────────────────────────────────────────────────────────────────────
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  if [ "$MODE" = "signed" ]; then
    IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
    [ -n "$IDENTITY" ] || die "signed mode, but APPLE_SIGNING_IDENTITY is empty or unset — the import step's \$GITHUB_ENV write was lost"
    [ "$IDENTITY" != "-" ] || die "signed mode, but APPLE_SIGNING_IDENTITY is '-' (ad-hoc) — that is the unsigned path"
    export APPLE_SIGNING_IDENTITY="$IDENTITY"
  else
    export APPLE_SIGNING_IDENTITY="-"
  fi
else
  [ "$MODE" = "unsigned" ] || die "signed mode on a non-macOS runner ($OS): there is nothing to sign with here"
  unset APPLE_SIGNING_IDENTITY
fi

# ── notarization: complete sets only (both modes), exported in signed mode only ─────────────────
APPLEID_N=0
for v in "${DBA_NOTARIZE_APPLE_ID:-}" "${DBA_NOTARIZE_APPLE_PASSWORD:-}" "${DBA_NOTARIZE_APPLE_TEAM_ID:-}"; do
  [ -z "$v" ] || APPLEID_N=$((APPLEID_N + 1))
done
API_N=0
for v in "${DBA_NOTARIZE_API_KEY:-}" "${DBA_NOTARIZE_API_ISSUER:-}" "${DBA_NOTARIZE_API_KEY_P8:-}"; do
  [ -z "$v" ] || API_N=$((API_N + 1))
done

KEY_FILE=""
cleanup() { [ -z "$KEY_FILE" ] || rm -f "$KEY_FILE"; }
trap cleanup EXIT

# The SHAPE of the input is checked in BOTH modes: a misconfigured set is a misconfiguration whether or
# not this run would have used it, and an unsigned run must not hide it until the first signed one.
case "$APPLEID_N" in 0|3) ;; *) die "partial AppleId notarization set ($APPLEID_N of DBA_NOTARIZE_APPLE_ID, DBA_NOTARIZE_APPLE_PASSWORD, DBA_NOTARIZE_APPLE_TEAM_ID non-empty) — set all three or none" ;; esac
case "$API_N" in 0|3) ;; *) die "partial API-key notarization set ($API_N of DBA_NOTARIZE_API_KEY, DBA_NOTARIZE_API_ISSUER, DBA_NOTARIZE_API_KEY_P8 non-empty) — set all three or none" ;; esac
if [ "$APPLEID_N" = 3 ] && [ "$API_N" = 3 ]; then
  die "both notarization sets are complete — keep exactly one (AppleId or API key); there is no silent preference"
fi

NOTARIZE="none"
if [ "$MODE" = "signed" ]; then
  if [ "$APPLEID_N" = 3 ]; then
    export APPLE_ID="$DBA_NOTARIZE_APPLE_ID"
    export APPLE_PASSWORD="$DBA_NOTARIZE_APPLE_PASSWORD"
    export APPLE_TEAM_ID="$DBA_NOTARIZE_APPLE_TEAM_ID"
    NOTARIZE="apple-id"
  elif [ "$API_N" = 3 ]; then
    KEY_FILE="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/dba-notarize-key.XXXXXX")"
    chmod 600 "$KEY_FILE"
    printf '%s\n' "$DBA_NOTARIZE_API_KEY_P8" > "$KEY_FILE"
    export APPLE_API_KEY="$DBA_NOTARIZE_API_KEY"
    export APPLE_API_ISSUER="$DBA_NOTARIZE_API_ISSUER"
    export APPLE_API_KEY_PATH="$KEY_FILE"
    NOTARIZE="api-key"
  fi
elif [ "$APPLEID_N" != 0 ] || [ "$API_N" != 0 ]; then
  echo "ci-tauri-build: notarization input present but not exported (unsigned mode: an ad-hoc signature cannot be notarized)"
fi
# The DBA_NOTARIZE_* copies are not Tauri's business; keep them out of its environment.
unset DBA_NOTARIZE_APPLE_ID DBA_NOTARIZE_APPLE_PASSWORD DBA_NOTARIZE_APPLE_TEAM_ID \
  DBA_NOTARIZE_API_KEY DBA_NOTARIZE_API_ISSUER DBA_NOTARIZE_API_KEY_P8

echo "signing: $MODE"
echo "notarization: $NOTARIZE"
# --verbose, always: without it tauri-bundler runs linuxdeploy at log level Error and DISCARDS its
# output, so a failed AppImage reports only "failed to run linuxdeploy" (measured, M2b release run,
# 2026-10-01; tauri-bundler 2.9.4 linux/appimage/linuxdeploy.rs:206-216). One -v sets the bundler's
# level to Info (tauri-cli 2.11.4 bundle.rs:213-217), which streams every subprocess line to the log.
# It also raises tauri-cli's own logger from Info to Debug (lib.rs:229-236 `verbosity_level`, which
# exports TAURI_CLI_VERBOSITY=1 to child processes), so the log is longer; nothing it changes alters
# what gets built. notarytool's credentials are never logged (tauri-macos-sign runs it with
# `.output()`, not the logging helper).
# `-- --locked` goes to the runner, cargo (tauri-cli 2.11.4 interface/rust/desktop.rs `cargo_command`
# appends these args to `cargo build`): a dependency-resolution change fails the build instead of
# rewriting Cargo.lock, as every workflow `cargo test` is --locked too.
echo "ci-tauri-build: $TAURI_CMD build --verbose --target $TRIPLE -- --locked"
# Not `exec`: the EXIT trap must still remove the API key file after the build.
"$TAURI_CMD" build --verbose --target "$TRIPLE" -- --locked
