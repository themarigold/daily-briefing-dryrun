#!/usr/bin/env bash
# spk2-scratch-build.sh — SPK-2's scratch signing variants, and the read-only measurements over them.
#
# Takes a BUILT `.app` (from `cargo tauri build --bundles app`) and produces five throwaway copies
# under an output directory you name, then measures each one with tools that only ever read:
#
#   unsigned/   `codesign --remove-signature` — the "what a stranger downloads if CI never signs" case
#   adhoc-1/    `codesign -s -`                — what `cargo tauri build` effectively ships today
#   adhoc-2/    the same, over a bundle whose content differs — the REBUILD case
#   stable-1/   a stable self-signed identity + hardened runtime + entitlements
#   stable-2/   the same identity, over the differing bundle — the REBUILD case again
#
# The 1/2 pairs exist to answer the one question SPK-2 is actually for: plan R1 (delta-verify H)
# asserts that an ad-hoc-signed `.app` has a **cdhash-bound designated requirement**, so every
# rebuild revokes the macOS TCC grant, while a stable identity gives a DR that survives. That is a
# claim about the DR STRING, so the script diffs the DR string across the pair rather than arguing
# about it. `docs/spikes/spk-2-gatekeeper-signing.md` carries the results and the protocol.
#
# ── WHAT "a bundle whose content differs" MEANS, stated plainly ─────────────────────────────────
# Variant 2 is NOT a second `cargo tauri build`. It is variant 1's input with one extra file under
# `Contents/Resources/`, added BEFORE signing. A bundle signature seals its resource directory into
# the CodeDirectory, so that is a genuine cdhash change arriving the same way a rebuild's would —
# and unlike a second `cargo build`, it is guaranteed to differ rather than merely likely to. The
# DR comparison is the measurement; the mechanism that moves the cdhash is scaffolding. A real
# two-rebuild leg belongs in the VM/CI register with the rest of SPK-2.
#
# ── SAFETY, because this runs on a live machine ─────────────────────────────────────────────────
#   • Nothing is installed, launched, opened or registered. `spctl --assess` EVALUATES; it changes
#     no state, adds no approval and is the only Gatekeeper tool used here.
#   • The output directory must be outside the GIT WORKTREE ROOT — enforced, not documented. Stated
#     as the worktree root rather than "the repository" because this project is one directory of a
#     monorepo: an earlier version resolved the guard against the PROJECT directory, which accepted
#     the monorepo root itself (MEASURED). `git rev-parse --show-toplevel` is the prefix now, with
#     the project directory as the fallback when the script is run outside a git checkout.
#     Both sides of that comparison are resolved with `pwd -P` — the PHYSICAL path. `pwd` alone is
#     bash's LOGICAL path, which is the string you typed with `..` folded out and every symlink
#     left standing, and two cases got past the guard on it (both MEASURED, both landing bundles
#     inside the worktree): an out-dir naming a SYMLINK that points into the worktree, and an
#     out-dir typed `/tmp/…` for a worktree that lives under `/private/tmp/…` — the alias a human
#     on macOS actually types. `pwd -P` collapses both to the same string the prefix is built from.
#   • The signing identity, when one is made, lives in a keychain FILE under the output directory,
#     is referenced only by explicit `--keychain`, and is deleted on exit (including on failure).
#     The login keychain is never imported into, never added to a search list, never made default.
#   • The login keychain's own identities are never used: a scratch bundle signed with the author's
#     `Daily Briefing (local) Signing` would inherit that identity's designated requirement, and
#     with it whatever TCC grants are keyed to it.
#
# ── WHAT IS LEFT BEHIND, deliberately ───────────────────────────────────────────────────────────
# The variant bundles (`unsigned/`, `adhoc-1/`, `adhoc-2/`, and `stable-1/`, `stable-2/` when they
# can be produced), `measurements.txt`, and the two `entitlements-*.plist` files STAY in the output
# directory after the run. They are the script's OUTPUT — the bundles are what a VM leg is fed and
# the report is the transcript the spike doc cites — so deleting them would delete the deliverable.
# What the exit trap removes is exactly the secret material: the scratch keychain and `.identity/`
# (the PEM private key and the p12). Delete the output directory yourself when you are done with it.
#
# Usage:
#   bash gui/scripts/spk2-scratch-build.sh <output-dir> [path/to/Some.app]
#
# Environment:
#   SPK2_ALLOW_JIT=app|sidecar|both   add `com.apple.security.cs.allow-jit` (and
#                                     `…allow-unsigned-executable-memory`) to that target's
#                                     entitlements. DEFAULT: neither. See the doc — whether the
#                                     WKWebView shell needs it is UNVERIFIED and cannot be settled
#                                     without launching the app, which is a VM leg.
#   SPK2_IDENTITY=<name>              sign the `stable-*` variants with an identity reachable
#                                     through the AMBIENT keychain search list instead of creating
#                                     a scratch one. This is the CI path (a p12 imported into a
#                                     temporary keychain that CI has put on the search list); it is
#                                     NOT for a developer machine, where it would reach the login
#                                     keychain.

set -euo pipefail

BUNDLE_ID="com.themarigold.daily-briefing"
SCRATCH_IDENTITY="SPK2 Scratch Signing"
SCRATCH_KEYCHAIN_PW="spk2-scratch-$$"

# `pwd -P` everywhere a path is resolved for the guard — see the SAFETY note above. These two feed
# the guard through `REPO_DIR`'s fallback, so they are physical too rather than only the two places
# the comparison reads.
GUI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROJECT_DIR="$(cd "$GUI_DIR/.." && pwd -P)"
# The guard prefix. MEASURED: `$PROJECT_DIR` alone is not it — this project is one directory of a
# monorepo, so `<monorepo-root>/spk2-out` is outside the project directory and inside the git
# worktree, and the earlier check accepted it. The worktree root is the honest boundary. The
# fallback keeps the script usable from an exported tarball with no `.git` at all, where the
# project directory is the most that can be known.
REPO_DIR="$(git -C "$PROJECT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_DIR" ] && [ -d "$REPO_DIR" ] || REPO_DIR="$PROJECT_DIR"
# Resolved the same way `$OUT_DIR` is below — PHYSICALLY, with `pwd -P` — so the prefix comparison
# compares like with like. `git rev-parse --show-toplevel` already returns a physical path; this
# line exists for the fallback, which does not.
REPO_DIR="$(cd "$REPO_DIR" && pwd -P)"
DEFAULT_APP="$GUI_DIR/src-tauri/target/debug/bundle/macos/Daily Briefing.app"

[ "$(uname -s)" = "Darwin" ] || { echo "spk2: macOS only (uname=$(uname -s))" >&2; exit 1; }

OUT_DIR="${1:-}"
SRC_APP="${2:-$DEFAULT_APP}"
[ -n "$OUT_DIR" ] || { echo "usage: bash gui/scripts/spk2-scratch-build.sh <output-dir> [path/to/Some.app]" >&2; exit 2; }
[ -d "$SRC_APP" ] || { echo "spk2: no .app at $SRC_APP — run 'cargo tauri build --debug --bundles app' first" >&2; exit 1; }

# Record which directories `mkdir -p` is about to create, deepest first, so a refusal can remove
# exactly what THIS script made and nothing that was already there. `rmdir "$OUT_DIR"` alone was
# not enough: for a refused `a/b/c` it removed the leaf and left `a/` and `a/b/` behind, inside the
# very tree it had just declined to write to (MEASURED).
CREATED_DIRS=()
probe_dir="$OUT_DIR"
while [ -n "$probe_dir" ] && [ "$probe_dir" != "/" ] && [ "$probe_dir" != "." ] && [ ! -d "$probe_dir" ]; do
  CREATED_DIRS+=("$probe_dir")
  probe_dir="$(dirname "$probe_dir")"
done

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd -P)"

# The output must not be inside the git worktree. Checked by path prefix on the PHYSICALLY resolved
# directory — `pwd -P`, not `pwd` — which is why the check has to come after the `mkdir` that makes
# resolution possible, and why it undoes that `mkdir` on the way out rather than leaving empty
# directories in the tree it just refused to write to. `$CREATED_DIRS` is unwound deepest-first and
# each `rmdir` is non-recursive, so a directory that already had contents — or that existed before
# this run — survives.
#
# What `-P` buys, stated as what is now ENFORCED rather than as what was once claimed: this line
# read `pwd` until review, and `pwd` reports bash's LOGICAL cwd — `..` folded out, symlinks intact.
# So a `../` could indeed not smuggle a path back in, but two other things could, and both were
# MEASURED getting through with the bundles landing inside the worktree:
#   • an out-dir naming a symlink that lives outside the worktree and points into it;
#   • an out-dir typed `/tmp/…` against a worktree under `/private/tmp/…` (`/tmp` is a symlink to
#     `/private/tmp` on macOS, and `/tmp/…` is the spelling a human types).
# `-P` resolves every symlink component on both sides, so the prefix test now sees one canonical
# spelling of each path. It is NOT a defence against a bind mount, a hard link, or a second
# filesystem path to the same inode; the claim is exactly "symlinks and `..` are canonicalised".
case "$OUT_DIR/" in
  "$REPO_DIR"/*)
    for created in ${CREATED_DIRS[@]+"${CREATED_DIRS[@]}"}; do
      rmdir "$created" 2>/dev/null || true
    done
    echo "spk2: refusing to write scratch bundles inside the git worktree $REPO_DIR ($OUT_DIR)" >&2
    exit 1
    ;;
esac

KEYCHAIN="$OUT_DIR/spk2-scratch.keychain-db"
REPORT="$OUT_DIR/measurements.txt"
IDENTITY="${SPK2_IDENTITY:-}"
USE_SCRATCH_KEYCHAIN=0
[ -n "$IDENTITY" ] || USE_SCRATCH_KEYCHAIN=1

cleanup() {
  if [ "$USE_SCRATCH_KEYCHAIN" = "1" ] && [ -e "$KEYCHAIN" ]; then
    security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
    rm -f "$KEYCHAIN"
    echo "spk2: deleted the scratch keychain $KEYCHAIN"
  fi
  # The PEM key and the p12 live here. Removed from the trap rather than at the end of the happy
  # path, so an early exit cannot leave a private key on disk.
  rm -rf "$OUT_DIR/.identity"
}
trap cleanup EXIT

say() { printf '%s\n' "$*" | tee -a "$REPORT"; }
: > "$REPORT"

say "# SPK-2 scratch signing measurements"
say "# date            $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
say "# host macOS      $(sw_vers -productVersion) ($(sw_vers -buildVersion)), $(uname -m)"
say "# source .app     $SRC_APP"
say "# output          $OUT_DIR"
say "# SPK2_ALLOW_JIT  ${SPK2_ALLOW_JIT:-<unset>}"
say ""

# ── entitlements ────────────────────────────────────────────────────────────────────────────────
# Two files, because under hardened runtime there are TWO Mach-O principals in this bundle and the
# JIT question is different for each:
#
#   the shell  — Tauri renders through WKWebView, whose JavaScript runs in Apple's own
#                out-of-process `com.apple.WebKit.WebContent`, signed by Apple with its own
#                entitlements. The appendix's allow-jit/allow-unsigned-executable-memory pair
#                (appendix:191) is from the ELECTRON approach and is attributed there to
#                "(Chromium)", which embeds its JIT IN-PROCESS. Whether the Tauri shell needs
#                either is UNVERIFIED and not decidable without rendering a window.
#   the engine — a `bun build --compile` binary, i.e. JavaScriptCore JIT IN its own process.
#                appendix:713 measured only that such a binary ACCEPTS `--options runtime` and
#                still answers `--version`; a full run under hardened runtime is appendix T3a and
#                is unmeasured.
#
# So both default to EMPTY and the toggle is explicit. An entitlement added on a guess is worse
# than one absent: it is a permanent widening nobody can later argue down without re-running this.
write_entitlements() {
  local path="$1" want_jit="$2"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    if [ "$want_jit" = "1" ]; then
      echo '  <key>com.apple.security.cs.allow-jit</key><true/>'
      echo '  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>'
    fi
    echo '</dict>'
    echo '</plist>'
  } > "$path"
  plutil -lint "$path" >/dev/null
}

APP_JIT=0; SIDECAR_JIT=0
case "${SPK2_ALLOW_JIT:-}" in
  app) APP_JIT=1 ;;
  sidecar) SIDECAR_JIT=1 ;;
  both) APP_JIT=1; SIDECAR_JIT=1 ;;
  ""|none) ;;
  *) echo "spk2: SPK2_ALLOW_JIT must be one of app|sidecar|both|none" >&2; exit 2 ;;
esac
ENT_APP="$OUT_DIR/entitlements-app.plist"
ENT_SIDECAR="$OUT_DIR/entitlements-sidecar.plist"
write_entitlements "$ENT_APP" "$APP_JIT"
write_entitlements "$ENT_SIDECAR" "$SIDECAR_JIT"

# ── copies ──────────────────────────────────────────────────────────────────────────────────────
APP_NAME="$(basename "$SRC_APP")"
MAIN_EXE_NAME="$(plutil -extract CFBundleExecutable raw -o - "$SRC_APP/Contents/Info.plist")"

# Every Mach-O inside the bundle that is not the main executable. Tauri drops `externalBin`
# sidecars into Contents/MacOS next to the shell, and a nested Mach-O has to be signed BEFORE its
# container or the container's seal covers an unsigned inner binary.
nested_machos() {
  local app="$1"
  find "$app/Contents" -type f -perm -111 ! -name "$MAIN_EXE_NAME" -print0 \
    | xargs -0 -I{} sh -c 'file -b "$1" | grep -q "Mach-O" && printf "%s\n" "$1"' _ {} || true
}

make_copy() {
  local dest="$1" perturb="$2"
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$SRC_APP" "$dest"
  # Remove every existing signature first, so each variant is signed from the same baseline rather
  # than layered over whatever the linker left behind.
  local m
  while IFS= read -r m; do [ -n "$m" ] && codesign --remove-signature "$m" 2>/dev/null || true; done < <(nested_machos "$dest")
  codesign --remove-signature "$dest" 2>/dev/null || true
  if [ "$perturb" = "1" ]; then
    # The controlled content delta — see the header. A sealed resource, so it moves the cdhash.
    printf 'spk2 rebuild marker\n' > "$dest/Contents/Resources/spk2-rebuild-marker.txt"
  fi
}

sign_variant() {
  local dest="$1"; shift   # remaining args: the codesign flags common to both Mach-O levels
  local m
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    codesign --force "$@" --entitlements "$ENT_SIDECAR" "$m"
  done < <(nested_machos "$dest")
  codesign --force "$@" --identifier "$BUNDLE_ID" --entitlements "$ENT_APP" "$dest"
}

# ── the scratch identity ────────────────────────────────────────────────────────────────────────
# Mirrors scripts/install.sh:25-60 and src/schedule/install.ts:320-346 — the same openssl recipe the
# project already uses for `Daily Briefing (local) Signing` — with one difference that is the whole
# point: the keychain is a FILE under the output directory, not the login keychain.
STABLE_AVAILABLE=0
STABLE_BLOCKED_REASON=""
ensure_scratch_identity() {
  local openssl=openssl
  [ -x /usr/local/bin/openssl ] && openssl=/usr/local/bin/openssl
  [ -x /opt/homebrew/bin/openssl ] && openssl=/opt/homebrew/bin/openssl
  local dir; dir="$OUT_DIR/.identity"; rm -rf "$dir"; mkdir -p "$dir"

  security create-keychain -p "$SCRATCH_KEYCHAIN_PW" "$KEYCHAIN" || return 1
  security set-keychain-settings -lut 7200 "$KEYCHAIN" || return 1
  security unlock-keychain -p "$SCRATCH_KEYCHAIN_PW" "$KEYCHAIN" || return 1
  # keyUsage=digitalSignature + codeSigning EKU + CA:FALSE, or codesign rejects the identity even
  # though it lists (install.sh:29-32). `-addext` needs a real OpenSSL, not LibreSSL.
  "$openssl" req -x509 -newkey rsa:2048 -keyout "$dir/key.pem" -out "$dir/cert.pem" \
    -days 3650 -nodes -subj "/CN=$SCRATCH_IDENTITY" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1 || return 1
  # -legacy + sha1 MAC + a non-empty password, or `security import` fails with a misleading
  # "MAC verification failed" (install.sh:38-40).
  "$openssl" pkcs12 -export -legacy -macalg sha1 -inkey "$dir/key.pem" -in "$dir/cert.pem" \
    -out "$dir/id.p12" -passout "pass:$SCRATCH_KEYCHAIN_PW" >/dev/null 2>&1 \
    || "$openssl" pkcs12 -export -macalg sha1 -inkey "$dir/key.pem" -in "$dir/cert.pem" \
      -out "$dir/id.p12" -passout "pass:$SCRATCH_KEYCHAIN_PW" >/dev/null 2>&1 || return 1
  security import "$dir/id.p12" -k "$KEYCHAIN" -P "$SCRATCH_KEYCHAIN_PW" -A >/dev/null 2>&1 || return 1
  # The partition list is what lets codesign use the key without a GUI prompt. It is settable here
  # only because we chose this keychain's password — which is exactly why install.sh:52-56 records
  # that it CANNOT do this for the login keychain.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$SCRATCH_KEYCHAIN_PW" "$KEYCHAIN" >/dev/null 2>&1 || return 1

  # BOTH listings go in the report, and the distinction is the whole reason the blocker section of
  # the doc had to be rewritten. `-p codesigning` lists MATCHING identities — the scratch one shows
  # up here, tagged CSSMERR_TP_NOT_TRUSTED. `-v` lists VALID ones, and reports **0**. So the tidy
  # framing "codesign cannot find what find-identity lists" was doing real work with an ambiguity:
  # find-identity lists it as matching, never as valid.
  #
  # `-v` is recorded, NOT used as the gate. Gating on it would make every run report "could not
  # create a scratch signing identity", which is false — the identity is created, imported and
  # listed; it is the codesign lookup that fails, and that is the finding. The gate therefore stays
  # on presence, and the probe sign below is what decides usability.
  say "identity: security find-identity -p codesigning <scratch> →"
  security find-identity -p codesigning "$KEYCHAIN" 2>&1 | sed 's/^/     /' | tee -a "$REPORT"
  say "identity: security find-identity -v -p codesigning <scratch> →"
  security find-identity -v -p codesigning "$KEYCHAIN" 2>&1 | sed 's/^/     /' | tee -a "$REPORT"
  security find-identity -p codesigning "$KEYCHAIN" | grep -q "$SCRATCH_IDENTITY"
}

if [ -n "$IDENTITY" ]; then
  STABLE_AVAILABLE=1
  say "identity: SPK2_IDENTITY='$IDENTITY' (ambient keychain search list — the CI path)"
  STABLE_SIGN_FLAGS=(--sign "$IDENTITY" --options runtime --timestamp=none)
elif ensure_scratch_identity; then
  say "identity: created '$SCRATCH_IDENTITY' in the scratch keychain $KEYCHAIN"
  STABLE_SIGN_FLAGS=(--keychain "$KEYCHAIN" --sign "$SCRATCH_IDENTITY" --options runtime --timestamp=none)
  # Probe the identity on a throwaway copy of /bin/echo before committing a 60 MB bundle to it.
  # codesign's STDERR is captured and recorded rather than discarded: it carries the only sentence
  # that says what actually went wrong ("no identity found"), and an earlier version of this script
  # threw it away and left the doc to paraphrase it from memory.
  cp /bin/echo "$OUT_DIR/.identity/probe-bin"
  set +e
  PROBE_SIGN_ERR="$(codesign --force --keychain "$KEYCHAIN" --sign "$SCRATCH_IDENTITY" --identifier spk2.probe "$OUT_DIR/.identity/probe-bin" 2>&1 >/dev/null)"
  PROBE_SIGN_RC=$?
  set -e
  say "identity: codesign --keychain <scratch> --sign '$SCRATCH_IDENTITY' <throwaway binary> → exit $PROBE_SIGN_RC"
  say "identity: codesign stderr → ${PROBE_SIGN_ERR:-<empty>}"
  if [ "$PROBE_SIGN_RC" = "0" ]; then
    STABLE_AVAILABLE=1
  else
    STABLE_BLOCKED_REASON="codesign --keychain <scratch> (exit $PROBE_SIGN_RC: ${PROBE_SIGN_ERR:-<no stderr>}) could not use the identity that 'security find-identity -p codesigning <scratch>' lists as MATCHING — and which '-v' lists as 0 VALID (see the doc: MEASURED on macOS $(sw_vers -productVersion))"
  fi
else
  STABLE_BLOCKED_REASON="could not create a scratch signing identity (openssl/security failed)"
fi
[ "$STABLE_AVAILABLE" = "1" ] || say "identity: UNAVAILABLE — $STABLE_BLOCKED_REASON"
say ""

# ── measurement (read-only) ─────────────────────────────────────────────────────────────────────
measure() {
  local label="$1" app="$2"
  say "── $label  ($app)"
  if [ ! -d "$app" ]; then say "   NOT PRODUCED"; say ""; return; fi

  local dvv rc
  dvv="$(codesign -dvv "$app" 2>&1 || true)"
  say "   codesign -dvv:"
  printf '%s\n' "$dvv" | sed 's/^/     /' | tee -a "$REPORT"

  # `-dvv` does NOT print the cdhash — it needs verbosity 4 — and the cdhash is half of what this
  # spike is about, so it is pulled out explicitly rather than left to whoever reads the block.
  say "   CDHash (codesign -d --verbose=4): $(cdhash_of "$app")"

  say "   designated requirement:"
  codesign -d --requirements - "$app" 2>&1 | grep -v '^Executable=' | sed 's/^/     /' | tee -a "$REPORT" || true

  set +e; codesign --verify --deep --strict --verbose=2 "$app" >"$OUT_DIR/.verify.out" 2>&1; rc=$?; set -e
  say "   codesign --verify --deep --strict → exit $rc"
  sed 's/^/     /' "$OUT_DIR/.verify.out" | tee -a "$REPORT"

  set +e; spctl --assess --type execute --verbose=4 "$app" >"$OUT_DIR/.spctl.out" 2>&1; rc=$?; set -e
  say "   spctl --assess --type execute → exit $rc"
  sed 's/^/     /' "$OUT_DIR/.spctl.out" | tee -a "$REPORT"

  say "   xattr -l (quarantine present?):"
  { xattr -l "$app" 2>&1 || true; } | sed 's/^/     /' | tee -a "$REPORT"
  say ""
}

# `--verbose=4`, not `-dvv`: the CDHash line only appears at verbosity 4. Caught by the guard in
# `compare_pair` below, which refused to read a DR comparison off two empty strings.
cdhash_of()  { codesign -d --verbose=4 "$1" 2>&1 | sed -n 's/^CDHash=//p'; }
dr_of()      { codesign -d --requirements - "$1" 2>&1 | grep -v '^Executable=' || true; }

# Variant (0) is the SOURCE bundle, measured where it lies and never copied or modified. It is not
# one of SPK-2's three, and it is here because measuring the three without it invites the reader to
# assume the shipped artifact is the ad-hoc one. It is not: `cargo tauri build` leaves only the
# LINKER's ad-hoc signature, which seals no resources and binds no Info.plist.
say "═══ VARIANT (0) as built by 'cargo tauri build' — measured in place, not copied ═══"
measure "as-built" "$SRC_APP"

say "═══ VARIANT (a) unsigned ═══"
make_copy "$OUT_DIR/unsigned/$APP_NAME" 0
measure "unsigned" "$OUT_DIR/unsigned/$APP_NAME"

say "═══ VARIANT (b) ad-hoc, two builds ═══"
for n in 1 2; do
  perturb=0; [ "$n" = "2" ] && perturb=1
  make_copy "$OUT_DIR/adhoc-$n/$APP_NAME" "$perturb"
  sign_variant "$OUT_DIR/adhoc-$n/$APP_NAME" --sign -
  measure "adhoc-$n" "$OUT_DIR/adhoc-$n/$APP_NAME"
done

say "═══ VARIANT (c) stable self-signed identity + hardened runtime ═══"
if [ "$STABLE_AVAILABLE" = "1" ]; then
  for n in 1 2; do
    perturb=0; [ "$n" = "2" ] && perturb=1
    make_copy "$OUT_DIR/stable-$n/$APP_NAME" "$perturb"
    sign_variant "$OUT_DIR/stable-$n/$APP_NAME" "${STABLE_SIGN_FLAGS[@]}"
    measure "stable-$n" "$OUT_DIR/stable-$n/$APP_NAME"
  done
else
  say "── stable-1 / stable-2  NOT PRODUCED — $STABLE_BLOCKED_REASON"
  say "   This leg moves to the VM/CI register in docs/spikes/spk-2-gatekeeper-signing.md."
  say ""
fi

# ── the comparison SPK-2 exists for ─────────────────────────────────────────────────────────────
say "═══ DR STABILITY ACROSS TWO BUILDS ═══"
compare_pair() {
  local label="$1" a="$2" b="$3"
  if [ ! -d "$a" ] || [ ! -d "$b" ]; then say "$label: NOT MEASURED (a variant was not produced)"; return; fi
  local ca cb da db
  ca="$(cdhash_of "$a")"; cb="$(cdhash_of "$b")"
  da="$(dr_of "$a")";     db="$(dr_of "$b")"
  say "$label cdhash build-1: $ca"
  say "$label cdhash build-2: $cb"
  if [ "$ca" = "$cb" ]; then
    say "$label cdhash: IDENTICAL — the content delta did not move it; the DR comparison below proves nothing"
  else
    say "$label cdhash: DIFFERENT (as a rebuild would be)"
  fi
  say "$label DR build-1: $da"
  say "$label DR build-2: $db"
  if [ "$da" = "$db" ]; then
    say "$label DR: STABLE across the two builds → a TCC grant keyed on it SURVIVES"
  else
    say "$label DR: CHANGED across the two builds → a TCC grant keyed on it is REVOKED"
  fi
  say ""
}
compare_pair "adhoc " "$OUT_DIR/adhoc-1/$APP_NAME"  "$OUT_DIR/adhoc-2/$APP_NAME"
compare_pair "stable" "$OUT_DIR/stable-1/$APP_NAME" "$OUT_DIR/stable-2/$APP_NAME"

rm -f "$OUT_DIR/.verify.out" "$OUT_DIR/.spctl.out"
say "spk2: measurements written to $REPORT"
