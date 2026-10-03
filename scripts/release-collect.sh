#!/usr/bin/env bash
# release-collect.sh — the release job's last gate before `gh release create` (Phase E, E3).
#
# Usage: bash scripts/release-collect.sh <dist> <markers> <version> <signed|unsigned> <dl-bundles-outcome> <notes-out>
#
#   <dist>                the flat attach set the release job downloaded into (cli-binaries + bundle-*)
#   <markers>             the directory the marker-* artifacts were merged into (<leg>.status files)
#   <version>             plain semver X.Y.Z (the tag without its leading v)
#   <signed|unsigned>     the gate job's signing mode, exactly one of the two words
#   <dl-bundles-outcome>  the `outcome` of the bundle-* download step: success|failure|cancelled|skipped
#   <notes-out>           the FILE the rendered release notes go to (never a directory); must lie OUTSIDE <dist>
#
# It implements the bundle-status contract frozen in docs/RELEASE.md §Assets (plan §3a) and FAILS
# CLOSED: every check runs, every failure is printed, and the exit is 1 if any failed. Only on a
# full pass does it write <dist>/SHA256SUMS and <notes-out>, and a failed collect also removes a
# SHA256SUMS an earlier run left in <dist>, so it leaves nothing a later step could mistake for a
# finished release.
#
# Collect rules (§3a):
#   - required legs macos-arm64, macos-x64, linux-x86_64: marker absent, or body not byte-for-byte
#     one of `built` / `build-failed` / `size-rejected` plus a newline -> FAIL; `size-rejected` -> FAIL;
#   - `built` => that leg's frozen names are in <dist>, else FAIL;
#   - `build-failed` => that leg's names are absent (present -> FAIL), and the notes name the leg;
#   - no required leg `built` -> FAIL: a release with zero desktop bundles (CLI only) is refused
#     (user-directed 2026-10-02). One or two `build-failed` legs still ship, named in the notes;
#   - <dl-bundles-outcome> other than `success` while any marker says `built` -> FAIL (a truncated or
#     partial download never ships). Any value outside the four GitHub step outcomes -> FAIL;
#   - the windows-x64 marker is read for the notes only; its absence or body is never a FAIL, and it
#     never counts as a desktop bundle;
#   - any other file in <markers>, or a known leg's marker that is not a regular file -> FAIL (the
#     contract is a closed set).
# Plus:
#   - <dist> is a directory, flat (a subdirectory or any non-regular entry -> FAIL) and holds only
#     frozen names for <version> (anything else -> FAIL, named); a Windows installer (*setup*.exe,
#     *.msi) -> FAIL with its own message (C3: the NSIS artifact is never attached);
#   - the CLI floor: all 5 CLI binaries present;
#   - a version that is not plain semver X.Y.Z -> FAIL;
#   - a signing argument other than exactly `signed` or `unsigned` -> FAIL;
#   - <notes-out> a directory, in a directory that does not exist, or inside <dist> (judged by
#     canonical physical path, /bin/pwd -P), or either side of that judgement unresolvable -> FAIL;
#     the notes template missing -> FAIL.
# After every check passed, these still refuse (exit 1, nothing written): the template does not
# render (an unknown, nested or unbalanced block, or a placeholder left unsubstituted); hashing any
# asset fails; SHA256SUMS would not list exactly the CLI floor plus every built leg's names; moving
# SHA256SUMS or the notes into place fails.
#
# SHA256SUMS is computed from INSIDE <dist>, so its lines carry bare basenames and
# `shasum -a 256 -c SHA256SUMS` works in a download folder; LC_ALL=C sorted; it never lists itself.
# A SHA256SUMS already in <dist> is replaced on a pass, never listed, and removed on a FAIL.
#
# Portable: macOS (bash 3.2, BSD tools) and ubuntu. No GNU-only flags. sha256sum when present,
# else `shasum -a 256`; both print `<hex>  <name>`.
set -uo pipefail
export LC_ALL=C
# Every `cd` below resolves PHYSICALLY (a symlinked component followed by `..` means the symlink
# target's parent, as the kernel resolves it for the later `mv`), and no CDPATH entry can redirect a
# relative `cd` or make it print the directory it chose into a captured path.
unset CDPATH
set -o physical

SELF_DIR="$(cd -P "$(dirname "$0")" && pwd -P)"
TEMPLATE="$SELF_DIR/../docs/release-notes.template.md"

REQUIRED_LEGS="macos-arm64 macos-x64 linux-x86_64"
CLI_NAMES="daily-briefing-darwin-arm64 daily-briefing-darwin-x64 daily-briefing-linux-x64 daily-briefing-linux-arm64 daily-briefing-windows-x64.exe"

if [ "$#" -ne 6 ]; then
  echo "usage: release-collect.sh <dist> <markers> <version> <signed|unsigned> <dl-bundles-outcome> <notes-out>" >&2
  exit 1
fi
DIST="$1"
MARKERS="$2"
VERSION="$3"
SIGNING="$4"
DL_OUTCOME="$5"
NOTES_OUT="$6"

FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }
ok() { echo "ok:   $*"; }
DIST_OK=0
# A refused collect leaves no SHA256SUMS in dist: one an earlier run wrote describes an attach set
# this run did not certify, and would read as a finished release. Only a regular file is removed (a
# SHA256SUMS that is a link or a directory already FAILs the flat-dist check, and is left alone).
drop_stale_sums() {
  if [ "$DIST_OK" = 1 ] && [ -f "$DIST/SHA256SUMS" ] && [ ! -L "$DIST/SHA256SUMS" ]; then
    rm -f "$DIST/SHA256SUMS" && echo "release-collect: removed dist/SHA256SUMS left by an earlier run (it does not describe this refused attach set)" >&2
  fi
}

# ── arguments ────────────────────────────────────────────────────────────────────────────────────
if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  fail "version '$VERSION' is not plain semver X.Y.Z (pass the tag without its leading v)"
fi
case "$SIGNING" in
  signed|unsigned) ok "signing mode: $SIGNING" ;;
  *) fail "signing mode '$SIGNING' is not exactly 'signed' or 'unsigned' (an empty value means the gate job's output was lost)" ;;
esac
case "$DL_OUTCOME" in
  success|failure|cancelled|skipped) ok "bundle download outcome: $DL_OUTCOME" ;;
  *) fail "bundle download outcome '$DL_OUTCOME' is not a step outcome (success|failure|cancelled|skipped)" ;;
esac

# Frozen names per leg (docs/RELEASE.md §Assets). Empty for windows-x64: it never attaches anything.
leg_names() {
  case "$1" in
    macos-arm64)  echo "daily-briefing-${VERSION}-darwin-arm64.dmg" ;;
    macos-x64)    echo "daily-briefing-${VERSION}-darwin-x64.dmg" ;;
    linux-x86_64) echo "daily-briefing-${VERSION}-linux-x86_64.AppImage daily-briefing_${VERSION}_amd64.deb" ;;
    *) echo "" ;;
  esac
}
leg_title() {
  case "$1" in
    macos-arm64)  echo "macOS Apple Silicon DMG" ;;
    macos-x64)    echo "macOS Intel DMG" ;;
    linux-x86_64) echo "Linux x86_64 AppImage and .deb" ;;
  esac
}
file_title() {
  case "$1" in
    *-darwin-arm64.dmg) echo "macOS, Apple Silicon" ;;
    *-darwin-x64.dmg)   echo "macOS, Intel" ;;
    *.AppImage)         echo "Linux x86_64, AppImage" ;;
    *.deb)              echo "Linux x86_64, Debian/Ubuntu package" ;;
  esac
}
ALL_BUNDLE_NAMES="$(leg_names macos-arm64) $(leg_names macos-x64) $(leg_names linux-x86_64)"

# ── dist: exists, flat, only frozen names ────────────────────────────────────────────────────────
if [ ! -d "$DIST" ]; then
  fail "dist '$DIST' is not a directory"
else
  DIST_OK=1
  for entry in "$DIST"/* "$DIST"/.[!.]* "$DIST"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    if [ -L "$entry" ] || [ ! -f "$entry" ]; then
      fail "dist/$name is not a regular file (dist must be flat: no subdirectories, no links)"
      continue
    fi
    [ "$name" = "SHA256SUMS" ] && continue
    case "$name" in
      *setup*.exe|*.msi) fail "dist/$name is a Windows installer — the NSIS build is never attached (C3)"; continue ;;
    esac
    known=0
    for n in $CLI_NAMES $ALL_BUNDLE_NAMES; do
      [ "$name" = "$n" ] && known=1 && break
    done
    [ "$known" = 1 ] || fail "dist/$name is not a frozen release asset name for version $VERSION"
  done
fi

# ── the CLI floor ────────────────────────────────────────────────────────────────────────────────
for n in $CLI_NAMES; do
  if [ "$DIST_OK" = 1 ] && [ -f "$DIST/$n" ]; then ok "CLI floor: $n"; else fail "CLI floor: $n is missing from dist"; fi
done

# ── markers ──────────────────────────────────────────────────────────────────────────────────────
# Reads <markers>/<leg>.status; prints the token, or `absent`, or `invalid`. The body must be EXACTLY
# one token and a newline, compared byte-for-byte with `cmp` (a `$(...)` read drops NUL bytes, so
# `built<NUL><newline>` once read as built): a missing newline, a trailing space, a second line or
# a NUL all read as invalid.
marker_body() {
  local f="$MARKERS/$1.status" tok
  [ -f "$f" ] || { echo absent; return; }
  for tok in built build-failed size-rejected; do
    if printf '%s\n' "$tok" | cmp -s - "$f"; then echo "$tok"; return; fi
  done
  echo invalid
}

if [ ! -d "$MARKERS" ]; then
  echo "note: markers directory '$MARKERS' does not exist — every required marker is absent" >&2
else
  for entry in "$MARKERS"/* "$MARKERS"/.[!.]* "$MARKERS"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
      macos-arm64.status|macos-x64.status|linux-x86_64.status|windows-x64.status)
        [ -f "$entry" ] && [ ! -L "$entry" ] || fail "markers/$name is not a regular file" ;;
      *) fail "markers/$name is not a marker of a known leg (macos-arm64, macos-x64, linux-x86_64, windows-x64)" ;;
    esac
  done
fi

ANY_BUILT=0
FAILED_LEGS=""
BUILT_LEGS=""
for leg in $REQUIRED_LEGS; do
  status="$(marker_body "$leg")"
  case "$status" in
    absent)  fail "$leg: required marker $leg.status is absent" ;;
    invalid) fail "$leg: marker body is not exactly one of built / build-failed / size-rejected plus a newline" ;;
    size-rejected) fail "$leg: the bundle exceeded its size budget (size-rejected)" ;;
    built)
      ANY_BUILT=1
      BUILT_LEGS="$BUILT_LEGS $leg"
      for n in $(leg_names "$leg"); do
        if [ "$DIST_OK" = 1 ] && [ -f "$DIST/$n" ]; then ok "$leg built: $n"; else fail "$leg: marker says built but dist/$n is missing"; fi
      done ;;
    build-failed)
      FAILED_LEGS="$FAILED_LEGS $leg"
      echo "note: $leg did not build; it will be named in the notes"
      for n in $(leg_names "$leg"); do
        [ "$DIST_OK" = 1 ] && [ -e "$DIST/$n" ] && fail "$leg: marker says build-failed but dist/$n is present"
      done ;;
  esac
done

# Zero desktop bundles is refused (user-directed 2026-10-02): the CLI floor alone is not a release.
# Whatever else the markers said (absent, invalid, size-rejected) is reported above as well.
if [ "$ANY_BUILT" = 0 ]; then
  fail "no desktop bundle built: none of macos-arm64, macos-x64, linux-x86_64 has marker 'built' — a CLI-only release is refused"
fi

if [ "$ANY_BUILT" = 1 ] && [ "$DL_OUTCOME" != "success" ]; then
  fail "the bundle download step's outcome is '$DL_OUTCOME' while a marker says built — a partial download never ships"
fi

# Windows: informational only. Never a FAIL, whatever the marker says.
case "$(marker_body windows-x64)" in
  built)        WINDOWS_STATUS="the CI build succeeded; its installer is a workflow artifact only, kept for one day" ;;
  build-failed|size-rejected) WINDOWS_STATUS="the informational CI build did not succeed" ;;
  absent)       WINDOWS_STATUS="the informational CI build reported no status" ;;
  *)            WINDOWS_STATUS="the informational CI build reported an unreadable status" ;;
esac

# ── notes-out: a file path (not a directory), outside dist, parent exists ────────────────────────
# A directory is refused outright: `mv <tmp> <dir>` would move the notes INTO it under the temp
# name — into dist itself when <notes-out> is <dist> or <dist>/. The temp files are created in the
# RESOLVED parent of <notes-out> (NOTES_DIR_ABS), which this block proves is not dist, so no temp
# file can ever land inside dist.
# Both sides are CANONICAL: printed by /bin/pwd -P (getcwd), never by the builtin `pwd -P`, which
# keeps a typed case variant and macOS's /System/Volumes/Data firmlink spelling (measured, bash 3.2 on
# macOS, 2026-10-02) — so an alias of dist compared unequal, and a dot-named notes file landed in dist,
# where the `for f in *` checksum pass below never sees it. A side that cannot be resolved FAILS.
NOTES_PARENT="$(dirname "$NOTES_OUT")"
NOTES_DIR_ABS=""
if [ -d "$NOTES_OUT" ]; then
  fail "notes-out '$NOTES_OUT' is a directory — pass a file path outside dist (the notes would be moved into the directory)"
elif [ ! -d "$NOTES_PARENT" ]; then
  fail "notes-out's directory '$NOTES_PARENT' does not exist"
else
  NOTES_DIR_ABS="$(cd -P "$NOTES_PARENT" 2>/dev/null && /bin/pwd -P)" || NOTES_DIR_ABS=""
  case "$NOTES_DIR_ABS" in /*) ;; *) NOTES_DIR_ABS="" ;; esac
  if [ -z "$NOTES_DIR_ABS" ]; then
    fail "notes-out's directory '$NOTES_PARENT' could not be resolved to a canonical path, so the notes cannot be proven outside dist"
  elif [ "$DIST_OK" = 1 ]; then
    notes_abs="$NOTES_DIR_ABS/$(basename "$NOTES_OUT")"
    dist_abs="$(cd -P "$DIST" 2>/dev/null && /bin/pwd -P)" || dist_abs=""
    case "$dist_abs" in
      /*)
        case "$notes_abs" in
          "$dist_abs"|"$dist_abs"/*) fail "notes-out '$NOTES_OUT' lies inside dist — the notes would be attached as an asset" ;;
        esac ;;
      *) fail "dist '$DIST' could not be resolved to a canonical path, so notes-out cannot be proven outside it" ;;
    esac
  fi
fi
[ -f "$TEMPLATE" ] || fail "release notes template missing: $TEMPLATE"

if [ "$FAILS" -ne 0 ]; then
  echo "release-collect: $FAILS check(s) FAILED — nothing written" >&2
  drop_stale_sums
  exit 1
fi

# ── render the notes (into a temp file first; moved into place only once complete) ──────────────
CLI_ASSETS="- \`daily-briefing-darwin-arm64\` (macOS, Apple Silicon)
- \`daily-briefing-darwin-x64\` (macOS, Intel)
- \`daily-briefing-linux-x64\` (Linux, x86_64)
- \`daily-briefing-linux-arm64\` (Linux, arm64)
- \`daily-briefing-windows-x64.exe\` (Windows, x64, experimental)"
DESKTOP_ASSETS=""
for leg in $BUILT_LEGS; do
  for n in $(leg_names "$leg"); do
    DESKTOP_ASSETS="$DESKTOP_ASSETS- \`$n\` ($(file_title "$n"))
"
  done
done
# Never empty here: a run with no `built` leg was refused above.
DESKTOP_ASSETS="${DESKTOP_ASSETS%
}"
FAILED_LIST=""
for leg in $FAILED_LEGS; do
  FAILED_LIST="$FAILED_LIST- $(leg_title "$leg") (\`$leg\`)
"
done
FAILED_LIST="${FAILED_LIST%
}"
if [ "$SIGNING" = signed ]; then
  SIGNING_STATUS="signed with the project's stable self-signed release identity; not notarized."
else
  SIGNING_STATUS="UNSIGNED (ad-hoc). The macOS app carries an ad-hoc signature only and is not notarized."
fi
HAS_FAILED=0
[ -n "$FAILED_LEGS" ] && HAS_FAILED=1

NOTES_BASE="$NOTES_DIR_ABS/$(basename "$NOTES_OUT")"
NOTES_TMP="$(mktemp "${NOTES_BASE}.XXXXXX")" || { echo "FAIL: cannot create a temp file beside $NOTES_OUT" >&2; drop_stale_sums; exit 1; }
if ! R_VERSION="$VERSION" R_SIGNING_STATUS="$SIGNING_STATUS" R_CLI_ASSETS="$CLI_ASSETS" \
  R_DESKTOP_ASSETS="$DESKTOP_ASSETS" R_FAILED_LEGS="$FAILED_LIST" R_WINDOWS_STATUS="$WINDOWS_STATUS" \
  R_MODE="$SIGNING" R_HAS_FAILED="$HAS_FAILED" \
  awk '
    function active(name) {
      if (name == "signed")   return ENVIRON["R_MODE"] == "signed"
      if (name == "unsigned") return ENVIRON["R_MODE"] == "unsigned"
      if (name == "failed")   return ENVIRON["R_HAS_FAILED"] == "1"
      printf "unknown template block %s\n", name > "/dev/stderr"; bad = 1; return 0
    }
    BEGIN { skip = 0; depth = 0; bad = 0 }
    /^<!--#/ { next }
    /^<!-- if:[a-z]+ -->$/ {
      name = $0; sub(/^<!-- if:/, "", name); sub(/ -->$/, "", name)
      if (depth > 0) { printf "nested template block %s\n", name > "/dev/stderr"; bad = 1 }
      depth++; open = name; skip = !active(name); next
    }
    /^<!-- end:[a-z]+ -->$/ {
      name = $0; sub(/^<!-- end:/, "", name); sub(/ -->$/, "", name)
      if (depth == 0 || name != open) { printf "unbalanced template block end:%s\n", name > "/dev/stderr"; bad = 1 }
      depth = 0; skip = 0; next
    }
    skip { next }
    {
      line = $0
      n = split("VERSION SIGNING_STATUS CLI_ASSETS DESKTOP_ASSETS FAILED_LEGS WINDOWS_STATUS", keys, " ")
      for (i = 1; i <= n; i++) {
        ph = "{{" keys[i] "}}"
        while ((p = index(line, ph)) > 0) {
          line = substr(line, 1, p - 1) ENVIRON["R_" keys[i]] substr(line, p + length(ph))
        }
      }
      if (index(line, "{{") > 0) { printf "unsubstituted placeholder in: %s\n", line > "/dev/stderr"; bad = 1 }
      print line
    }
    END { if (depth != 0) { print "unterminated template block" > "/dev/stderr"; bad = 1 } exit bad }
  ' "$TEMPLATE" > "$NOTES_TMP"; then
  rm -f "$NOTES_TMP"
  echo "FAIL: the release notes template did not render — nothing written" >&2
  drop_stale_sums
  exit 1
fi

# ── SHA256SUMS, from inside dist ─────────────────────────────────────────────────────────────────
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
else
  SHA_CMD="shasum -a 256"
fi
SUMS_TMP="$(mktemp "${NOTES_BASE}.sums.XXXXXX")" || { rm -f "$NOTES_TMP"; echo "FAIL: cannot create a temp file" >&2; drop_stale_sums; exit 1; }
# Names were validated above: frozen names only, no spaces, no leading dash, no dotfiles. The glob
# expands in C order (LC_ALL=C above), the order `sort` would give.
# Every file is hashed in its own command whose status is checked: a pipeline into a `while` loop
# reports only the LAST hash's status, so an unreadable earlier asset would vanish from SHA256SUMS
# while collect printed PASS.
# shellcheck disable=SC2086
if ! ( cd -P "$DIST" || exit 1
       rc=0
       for f in *; do
         [ "$f" = SHA256SUMS ] && continue
         [ -e "$f" ] || continue
         $SHA_CMD "$f" || { echo "FAIL: checksumming dist/$f failed" >&2; rc=1; }
       done
       exit "$rc" ) > "$SUMS_TMP"; then
  rm -f "$NOTES_TMP" "$SUMS_TMP"
  echo "FAIL: checksumming dist failed — nothing written" >&2
  drop_stale_sums
  exit 1
fi
# Independent cross-check, by NAME: the CLI floor plus every built leg's frozen names is exactly the
# attach set (dist was proven to hold nothing else), so SHA256SUMS must carry exactly those names,
# each once, in C order, each on a well-formed `<64 hex>  <name>` line — and no other line.
EXPECTED_NAMES="$( { for n in $CLI_NAMES; do echo "$n"; done
                     for leg in $BUILT_LEGS; do for n in $(leg_names "$leg"); do echo "$n"; done; done; } | sort)"
EXPECTED_ASSETS="$(printf '%s\n' "$EXPECTED_NAMES" | wc -l | tr -d ' ')"
SUMS_NAMES="$(sed -n 's/^[0-9a-f]\{64\}  \(.*\)$/\1/p' "$SUMS_TMP")"
SUMS_LINES="$(wc -l < "$SUMS_TMP" | tr -d ' ')"
if [ "$SUMS_LINES" != "$EXPECTED_ASSETS" ] || [ "$SUMS_NAMES" != "$EXPECTED_NAMES" ]; then
  rm -f "$NOTES_TMP" "$SUMS_TMP"
  echo "FAIL: SHA256SUMS would list $SUMS_LINES line(s), not exactly the $EXPECTED_ASSETS asset name(s) of the attach set — nothing written" >&2
  drop_stale_sums
  exit 1
fi
if ! mv "$SUMS_TMP" "$DIST/SHA256SUMS"; then
  rm -f "$NOTES_TMP" "$SUMS_TMP"
  echo "FAIL: could not move SHA256SUMS into dist — nothing written" >&2
  drop_stale_sums
  exit 1
fi
if ! mv "$NOTES_TMP" "$NOTES_OUT"; then
  rm -f "$NOTES_TMP" "$DIST/SHA256SUMS"
  echo "FAIL: could not move the notes to $NOTES_OUT — nothing written" >&2
  exit 1
fi
echo "release-collect: PASS — wrote $DIST/SHA256SUMS ($(wc -l < "$DIST/SHA256SUMS" | tr -d ' ') assets) and $NOTES_OUT (signing: $SIGNING)"
