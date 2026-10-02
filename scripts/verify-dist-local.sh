#!/usr/bin/env bash
# verify-dist-local.sh — everything about a release's distribution that THIS Mac can prove (Phase E, E14).
#
# Usage: bash scripts/verify-dist-local.sh          (no arguments; run from anywhere)
#
# The version is gui/package.json's (the one Tauri names the bundles after); step 2 proves the other
# three carriers agree. Run it on an Apple-silicon Mac, after the bump and the size re-measure
# (docs/RELEASE.md step 1). What it cannot prove — the x64 DMG, the Linux and Windows bundles,
# notarization, a genuine Gatekeeper first-open — is CI-only or VM-only; docs/RELEASE.md says which.
#
# The steps, in order. EVERY step runs — a FAIL never stops the later ones — and each prints PASS or
# FAIL; there is no SKIP. A step whose input an earlier step failed to produce fails on its own,
# naming what is missing. Exit 1 if any step failed, else 0.
#    1. host       this is macOS on arm64 (a plain host `tauri build` makes the arm64 rows' artifacts)
#    2. versions   bash scripts/check-versions.sh <version>
#    3. cli        the 5 CLI cross-compiles, exactly as release.yml's `cli-binaries` job builds them,
#                  into a TEMPORARY dist (never the repo's dist/); the darwin-arm64 one's --version
#    4. build      `tauri build`, a plain host build (no --target), under the local `tauri build` rule
#                  (docs/RELEASE.md): every ambient APPLE_* variable and TAURI_BUNDLER_DMG_IGNORE_CI
#                  unset, CI=true, APPLE_SIGNING_IDENTITY=- (ad-hoc). Its outputs land at the untripled
#                  gui/src-tauri/target/release/bundle/ paths the arm64 rows of gui/size-budget.json record
#    5. stage      gui/scripts/stage-bundles.sh: the DMG under its frozen asset name, in a scratch dir
#    6. size       scripts/check-size-budget.ts: the staged DMG and the .app against their arm64 rows
#    7. dmg        hdiutil attach the staged DMG (-nobrowse -noautoopen -readonly, at a scratch mount
#                  point), copy the .app out, detach, then check the copy: both executables are arm64,
#                  and the copied sidecar's --version is the version. The .app is NEVER opened,
#                  launched or registered: nothing here runs `open`, and only the sidecar executes
#    8. runtime    the hardened runtime on the ad-hoc path, a --version regression of E4 (E4's full
#                  `run --force` legs were measured once, in M1b on 2026-10-01, and are re-proven in
#                  Phase F's VM walkthrough; this step proves only that the signed sidecar starts): the
#                  copied bundle verifies (--deep --strict) and is sealed; its main executable and its
#                  sidecar each carry flags with `runtime`, not `linker-signed`, `Signature=adhoc`, and
#                  entitlements equal (plutil-normalised) to gui/src-tauri/entitlements.plist; then a bare
#                  darwin-arm64 CLI binary, ad-hoc signed `--options runtime` in scratch, carries the same
#                  flags and still answers --version
#    9. collect    scripts/release-collect.sh over the temporary dist, args `unsigned` and `success`,
#                  with markers written here: macos-arm64 derived from steps 4-8 as release.yml derives
#                  it but stricter (`built` also needs step 8's bare-sidecar leg), and macos-x64 /
#                  linux-x86_64 holding exactly `build-failed` (they are not buildable here; that
#                  explanation goes to this step's log, never into a marker). The
#                  DMG joins the dist only when the marker says `built`, as the bundle upload does in
#                  CI. Then SHA256SUMS verifies inside the dist, and the notes name both unbuilt legs.
#                  When macos-arm64 is not `built` either, no leg is, and collect refuses a release
#                  with no desktop bundle (user-directed 2026-10-02): this step FAILs with it
#   10. drift      test/docs-config.test.ts (E16: docs/CONFIG.md against the Config type)
#   11. site       test/site.test.ts (E18: the landing page's links and its no-request rules)
#   12. tracked    no step rewrote a tracked file of this project (a local `tauri build` re-resolving
#                  Cargo.lock would): `git diff HEAD` over the project, before vs after; a git failure
#                  on either snapshot fails the step
#
# Steps 10-11 run with ANTHROPIC_API_KEY unset. The run directory (dist, markers, notes, mount point,
# scratch copies, logs) is a fresh `mktemp -d` under VERIFY_DIST_TMPDIR, else /private/tmp, else
# $TMPDIR, and never inside any working tree of this repository — this one, the primary checkout, every
# linked worktree, as `git worktree list` records them, and any tree git, asked from the parent, puts in
# this repository — nor in or below a directory holding a `.git` entry: the parent and every directory
# above it, up to /, must hold none (user-directed 2026-10-02: a working tree or repository of any kind,
# this one's or another's, moved or not, a bare repository named `.git` included, whose `.git` sits at
# or above the parent refuses it). All of it is judged by canonical physical path, before the run
# directory exists: exit 2 when the parent is refused, when it does not exist, or when git cannot name
# this repository's git directory or that of a working tree holding the parent, list those trees or
# locate the primary checkout. The run directory is removed after an all-PASS run (exit 1 if that
# removal fails) and kept, with its logs, when anything failed. The image is detached on exit whenever
# an attach was even attempted. Tools are called by name from PATH, except the Tauri CLI
# (TAURI_CMD, default gui/node_modules/.bin/tauri, as in gui/scripts/ci-tauri-build.sh), codesign
# (CODESIGN_CMD, default codesign) and /bin/pwd (the canonical path, below);
# test/verify-dist-local.test.ts stubs the first two that way. Nothing in this file switches a step off.
set -uo pipefail   # deliberately not -e: every step runs, and each is judged by its own exit code

[ "$#" -eq 0 ] || { echo "usage: bash scripts/verify-dist-local.sh   (no arguments)" >&2; exit 2; }

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GUI="$PROJECT/gui"
BUNDLE="$GUI/src-tauri/target/release/bundle"
APP_NAME="Daily Briefing.app"
TAURI_CMD="${TAURI_CMD:-$GUI/node_modules/.bin/tauri}"
CODESIGN_CMD="${CODESIGN_CMD:-codesign}"
ENTITLEMENTS="$GUI/src-tauri/entitlements.plist"

if [ -n "${VERIFY_DIST_TMPDIR:-}" ]; then
  TMP_PARENT="$VERIFY_DIST_TMPDIR"
elif [ -d /private/tmp ]; then
  TMP_PARENT=/private/tmp
else
  TMP_PARENT="${TMPDIR:-/tmp}"
fi
# The run directory is scratch: physically outside the working tree, so it can never be the repo's dist/
# or land anything among tracked files. Physical on both sides (cd -P), so a symlink cannot smuggle it in,
# and CANONICAL: every path judged here is printed by /bin/pwd -P (getcwd), never by the builtin
# `pwd -P`, which keeps a typed case variant (/PRIVATE/TMP on a case-insensitive volume) and the
# /System/Volumes/Data firmlink spelling, while git prints the canonical path — so a prefix test between
# the two could miss (measured, bash 3.2 on macOS, 2026-10-02: the builtin printed both aliases as typed,
# /bin/pwd -P printed /private/tmp for each).
TMP_PARENT_P="$(cd -P "$TMP_PARENT" 2>/dev/null && /bin/pwd -P)" \
  || { echo "verify-dist-local: the run-directory parent $TMP_PARENT does not exist" >&2; exit 2; }
WORKTREE="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null)" || WORKTREE="$PROJECT"
WORKTREE="$(cd -P "$WORKTREE" && /bin/pwd -P)" || WORKTREE="$PROJECT"
case "$TMP_PARENT_P/" in
  "$WORKTREE/"*)
    echo "verify-dist-local: the run-directory parent $TMP_PARENT is $TMP_PARENT_P, inside the working tree $WORKTREE (the repo's dist/ included); point VERIFY_DIST_TMPDIR outside it" >&2
    exit 2 ;;
esac
# Nor inside ANY other working tree of this repository: each holds a dist/ as real as this one's. The
# trees are git's own record of them (`git worktree list`), never inferred from what the git directory
# is called, and each is judged physically, as the parent is. A `bare` entry is a repository with no
# working tree, so its directory is nobody's tree and is skipped. The first entry is the primary
# checkout — except that for a SEPARATE git directory (`git init --separate-git-dir`) git records the git
# directory itself there, or, when that directory is literally named `.git`, the directory holding it
# (measured, git 2.50.1), and nothing about the checkout that uses it. In the first form, from a linked
# worktree of such a repository the primary checkout cannot be located, so the run is refused rather
# than judged against a tree this script cannot see; the second form reads as an ordinary tree (and is
# judged as one), so its real checkout is left to the two checks below (the parent-side probe and the
# `.git` ancestor walk) — as is a linked worktree moved without `git worktree repair`, which git records
# where it no longer is (`prunable`), or no longer records at all once its admin directory is pruned.
# A git that cannot list the trees refuses the run, and so does one that cannot name this repository's
# git directories — never a skipped guard: each lookup must print one absolute path. A git older than
# 2.31 does not know --path-format and prints it back on a line of its own before a path that may be
# relative (rev-parse echoes an option it does not recognise: measured with an unknown option, git
# 2.50), which is refused here like a failed lookup.
GIT_DIR_A="$(git -C "$PROJECT" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || GIT_DIR_A=""
COMMON_A="$(git -C "$PROJECT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || COMMON_A=""
case "$GIT_DIR_A" in /*) ;; *) GIT_DIR_A="" ;; esac
case "$COMMON_A" in /*) ;; *) COMMON_A="" ;; esac
[ -n "$GIT_DIR_A" ] && [ -n "$COMMON_A" ] \
  || { echo "verify-dist-local: git could not name this repository's git directory as an absolute path (rev-parse --path-format=absolute: not a git checkout, or a git older than 2.31), so the run-directory parent $TMP_PARENT cannot be proven outside its working trees" >&2; exit 2; }
GIT_DIR_P="$(cd -P "$GIT_DIR_A" 2>/dev/null && /bin/pwd -P)" || GIT_DIR_P=""
COMMON_P="$(cd -P "$COMMON_A" 2>/dev/null && /bin/pwd -P)" || COMMON_P=""
[ -n "$GIT_DIR_P" ] && [ -n "$COMMON_P" ] \
  || { echo "verify-dist-local: could not resolve this repository's git directory ($GIT_DIR_A, $COMMON_A)" >&2; exit 2; }
git -C "$PROJECT" worktree list --porcelain -z | {
  first=1 path="" bare=""
  judge() {   # the record just read: $path, $bare, and whether it is the $first (the primary checkout)
    local p what
    [ -n "$path" ] && [ -z "$bare" ] || return 0
    # Not where git recorded it (prunable): nothing there to land in. A tree MOVED elsewhere still exists,
    # and is left to the checks below: the parent-side probe while git still resolves it to this
    # repository, and the ancestor walk through the `.git` file it carries.
    p="$(cd -P "$path" 2>/dev/null && /bin/pwd -P)" || return 0
    [ "$p" = "$WORKTREE" ] && return 0                        # this tree: judged above
    if [ "$first" = 1 ] && [ "$p" = "$COMMON_P" ]; then
      [ "$GIT_DIR_P" = "$COMMON_P" ] && return 0              # run from that very checkout: judged above
      echo "verify-dist-local: this worktree's primary checkout cannot be located (git records only its separate git directory, $p), so the run-directory parent $TMP_PARENT cannot be proven outside it; run this from the primary checkout" >&2
      exit 2
    fi
    case "$TMP_PARENT_P/" in
      "$p/"*)
        if [ "$first" = 1 ]; then what="this worktree's primary checkout"; else what="another worktree of this repository"; fi
        echo "verify-dist-local: the run-directory parent $TMP_PARENT is $TMP_PARENT_P, inside the working tree $p ($what, its dist/ included); point VERIFY_DIST_TMPDIR outside it" >&2
        exit 2 ;;
    esac
  }
  while IFS= read -r -d '' field; do
    case "$field" in
      "worktree "*) path="${field#worktree }" ;;
      bare) bare=1 ;;
      "") judge; first=0 path="" bare="" ;;
    esac
  done
  judge
}
WT_RC=("${PIPESTATUS[@]}")
[ "${WT_RC[1]}" -eq 0 ] || exit 2   # the reader refused, and said why
[ "${WT_RC[0]}" -eq 0 ] \
  || { echo "verify-dist-local: git worktree list failed, so the run-directory parent $TMP_PARENT cannot be proven outside this repository's other working trees" >&2; exit 2; }
# The parent-side check: git, asked FROM the parent, names the repository whose working tree holds it.
# That catches trees the record above cannot show — a linked worktree moved without repair, and the
# checkout of a separate git directory named `.git` — but only while git, asked from the parent, still
# resolves them to this repository's common git directory. It cannot when that discovery fails (the
# moved tree's `.git` file unreadable, or its admin directory pruned) or stops at a nearer repository
# (one initialised inside the moved tree): each of those passes this check (measured, git 2.50.1), and
# the ancestor walk below refuses it. This check also sees a working tree with no `.git` above the
# parent (a parent inside a non-bare git directory whose core.worktree names a directory above it:
# measured, git 2.50.1, `--is-inside-work-tree` answers true there), which the walk cannot. Asked with
# none of GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR or GIT_CEILING_DIRECTORIES and with no
# filesystem-boundary stop, so nothing in this environment redirects or cuts short git's search from the
# parent. A parent this check finds in no working tree, in another repository's, or where git's
# discovery fails, goes on to the ancestor walk; one in a working tree whose git directory git cannot
# name is refused, like the lookups above.
parent_git() {
  ( unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CEILING_DIRECTORIES
    export GIT_DISCOVERY_ACROSS_FILESYSTEM=1
    git -C "$TMP_PARENT_P" "$@" 2>/dev/null )
}
if [ "$(parent_git rev-parse --is-inside-work-tree)" = true ]; then
  PARENT_COMMON_A="$(parent_git rev-parse --path-format=absolute --git-common-dir)" || PARENT_COMMON_A=""
  case "$PARENT_COMMON_A" in /*) ;; *) PARENT_COMMON_A="" ;; esac
  PARENT_COMMON_P=""
  [ -n "$PARENT_COMMON_A" ] && { PARENT_COMMON_P="$(cd -P "$PARENT_COMMON_A" 2>/dev/null && /bin/pwd -P)" || PARENT_COMMON_P=""; }
  [ -n "$PARENT_COMMON_P" ] \
    || { echo "verify-dist-local: the run-directory parent $TMP_PARENT is $TMP_PARENT_P, inside a working tree whose git directory git could not name, so it cannot be proven outside this repository; point VERIFY_DIST_TMPDIR outside it" >&2; exit 2; }
  if [ "$PARENT_COMMON_P" = "$COMMON_P" ]; then
    echo "verify-dist-local: the run-directory parent $TMP_PARENT is $TMP_PARENT_P, inside the working tree of a checkout of this repository that \`git worktree list\` does not show there (git, asked from the parent, names this repository's git directory $COMMON_P: a worktree moved without repair, or the checkout of a separate git directory named .git), its dist/ included; point VERIFY_DIST_TMPDIR outside it" >&2
    exit 2
  fi
fi
# The ancestor walk (user-directed 2026-10-02): the parent itself and every directory above it, up to /,
# must hold no `.git` entry of any kind — a directory, a file or a symlink, dangling included. Whatever
# that entry belongs to (this repository or another; a checkout, a linked worktree moved or not, its
# admin directory pruned or not; a bare repository named `.git`), no run directory goes in or below the
# directory that holds it. Plain existence tests over the canonical path's own prefixes, with no git, so
# this holds where the checks above rely on git's discovery from the parent. Each of these passes them
# (measured, git 2.50.1) and is refused here: a parent in a moved, unrepaired worktree whose `.git` file
# git cannot read, in one whose admin directory was then pruned, or in a repository initialised inside
# one. A prefix that is not a searchable directory cannot answer the test, and refuses too.
ANC="$TMP_PARENT_P"
while :; do
  [ -d "$ANC" ] && [ -x "$ANC" ] \
    || { echo "verify-dist-local: the run-directory parent $TMP_PARENT is $TMP_PARENT_P, and $ANC is not a searchable directory, so whether it holds a .git entry cannot be checked; point VERIFY_DIST_TMPDIR at a directory with no .git at or above it" >&2; exit 2; }
  if [ -e "${ANC%/}/.git" ] || [ -L "${ANC%/}/.git" ]; then
    echo "verify-dist-local: the run-directory parent $TMP_PARENT is $TMP_PARENT_P, and ${ANC%/}/.git exists at or above it: no run directory goes in or below a directory holding a .git entry (a working tree or a repository of any kind, this one's or another's, moved or not); point VERIFY_DIST_TMPDIR at a directory with no .git at or above it" >&2
    exit 2
  fi
  [ "$ANC" = / ] && break
  ANC="${ANC%/*}"
  ANC="${ANC:-/}"
done
# Under the canonical physical parent (above), so $MNT carries no typed case variant or firmlink alias
# for `hdiutil info` (the exit trap's check) to spell differently.
RUN_DIR="$(mktemp -d "$TMP_PARENT_P/dba-verify-dist.XXXXXX")" || { echo "verify-dist-local: could not create a run directory under $TMP_PARENT" >&2; exit 1; }
LOGS="$RUN_DIR/logs"
DIST="$RUN_DIR/dist"          # the attach set collect reads: the CLI binaries, plus the DMG when built
STAGE="$RUN_DIR/stage"        # stage-bundles.sh's output
MARKERS="$RUN_DIR/markers"
NOTES="$RUN_DIR/release-notes.md"
MNT="$RUN_DIR/mnt"            # the DMG's mount point
COPY="$RUN_DIR/copy"          # the .app copied out of the DMG
E4="$RUN_DIR/e4"              # the bare sidecar, ad-hoc signed --options runtime
mkdir -p "$LOGS" "$DIST" "$STAGE" "$MARKERS" "$MNT" "$COPY" "$E4"

FAILED=0
FINISHED=""
MOUNTED=""   # armed BEFORE the attach (step 7), so an interrupt during or just after it still detaches
# Whether the image may still be at $MNT: yes unless `hdiutil info` answers and does not name it.
still_attached() {
  local info
  info="$(hdiutil info 2>/dev/null)" || return 0
  printf '%s\n' "$info" | grep -Fq -- "$MNT"
}
cleanup() {
  if [ -n "$MOUNTED" ]; then
    # An attach that never completed leaves nothing to detach, so a failed detach is reported only when
    # the image may really still be there.
    if ! hdiutil detach "$MNT" -force >/dev/null 2>&1 && still_attached; then
      echo "verify-dist-local: could not detach $MNT — run: hdiutil detach \"$MNT\" -force" >&2
    fi
  fi
  if [ -n "$FINISHED" ] && [ "$FAILED" -eq 0 ]; then
    rm -rf "$RUN_DIR" || { echo "verify-dist-local: every step passed, but removing the run directory $RUN_DIR failed" >&2; exit 1; }
  else
    echo "verify-dist-local: run directory kept: $RUN_DIR (logs in $LOGS)"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'exit 129' HUP

# ── reporting (the shape of scripts/release-check.sh) ───────────────────────────────────────────────
CUR=""
declare -a RESULT_IDS=()
declare -a RESULT_VALS=()
note() { printf '%s\n' "$*" >>"$LOGS/$CUR.notes"; }
result_of() {   # <id> → PASS|FAIL, or nothing when that step has not run
  local i=0
  while [ "$i" -lt "${#RESULT_IDS[@]}" ]; do
    [ "${RESULT_IDS[$i]}" = "$1" ] && { echo "${RESULT_VALS[$i]}"; return 0; }
    i=$((i + 1))
  done
}
report() {   # <id> <title> <PASS|FAIL>
  printf '[%s] %-58s %s\n' "$1" "$2" "$3"
  [ -f "$LOGS/$1.notes" ] && sed 's/^/      /' "$LOGS/$1.notes"
  RESULT_IDS+=("$1")
  RESULT_VALS+=("$3")
  if [ "$3" = FAIL ]; then
    FAILED=$((FAILED + 1))
    if [ -s "$LOGS/$1.log" ]; then
      echo "      last lines of $LOGS/$1.log:"
      tail -n 20 "$LOGS/$1.log" | sed 's/^/      | /'
    fi
  fi
}
run_step() {   # <id> <title> <function>
  CUR="$1"
  local title="$2" rc=0
  "$3" >"$LOGS/$CUR.log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then report "$CUR" "$title" PASS; else report "$CUR" "$title" FAIL; fi
}

# The version Tauri names the bundles after. Empty when it cannot be read; every step that needs it
# then fails, naming the reason.
VERSION="$(bun -e 'const j = JSON.parse(await Bun.file(process.argv[1]).text()); if (typeof j.version !== "string") process.exit(3); console.log(j.version)' "$GUI/package.json" 2>/dev/null || true)"
if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "verify-dist-local: could not read a plain X.Y.Z version from $GUI/package.json (got '$VERSION')" >&2
  VERSION=""
fi
need_version() { [ -n "$VERSION" ] || { note "no version: gui/package.json carries no plain X.Y.Z version"; return 1; }; }

echo "verify-dist-local ${VERSION:-<no version>} — $PROJECT"
echo "run directory: $RUN_DIR"

# A digest of every tracked change in the project, against HEAD; step 12 compares before and after.
# pipefail makes git's failure the function's, so a failed diff can never pass as an unchanged digest.
# No external diff driver and no textconv: the raw bytes of the change, whatever the user's git config.
tracked_digest() { git -C "$PROJECT" diff --no-ext-diff --no-textconv --binary HEAD -- . | cksum; }
TRACKED_BEFORE=""
TRACKED_BEFORE_ERR=""
if git -C "$PROJECT" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  TRACKED_BEFORE="$(tracked_digest 2>"$LOGS/tracked-before.err")" \
    || { TRACKED_BEFORE=""; TRACKED_BEFORE_ERR="$(head -n 3 "$LOGS/tracked-before.err")"; TRACKED_BEFORE_ERR="${TRACKED_BEFORE_ERR:-git diff failed}"; }
fi

# ── 1. host ─────────────────────────────────────────────────────────────────────────────────────────
step_host() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  note "$os $arch"
  [ "$os" = Darwin ] || { note "not macOS: the DMG, the .app and codesign are macOS-only"; return 1; }
  [ "$arch" = arm64 ] || { note "not arm64: a plain host build here would not make the arm64 rows' artifacts"; return 1; }
}
run_step 1 "host is macOS arm64" step_host

# ── 2. versions ─────────────────────────────────────────────────────────────────────────────────────
step_versions() { need_version || return 1; ( cd "$PROJECT" && bash scripts/check-versions.sh "$VERSION" ); }
run_step 2 "scripts/check-versions.sh ${VERSION:-?}" step_versions

# ── 3. the 5 CLI cross-compiles (release.yml `cli-binaries`, into the temporary dist) ──────────────────
step_cli() {
  local t rc=0 got
  need_version || return 1
  for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
    ( cd "$PROJECT" && bun build --compile --target="bun-$t" --outfile "$DIST/daily-briefing-$t" src/main.ts ) \
      || { note "bun build --compile --target=bun-$t failed"; rc=1; }
  done
  ( cd "$PROJECT" && bun build --compile --target=bun-windows-x64 --outfile "$DIST/daily-briefing-windows-x64.exe" src/main.ts ) \
    || { note "bun build --compile --target=bun-windows-x64 failed"; rc=1; }
  for t in daily-briefing-darwin-arm64 daily-briefing-darwin-x64 daily-briefing-linux-x64 daily-briefing-linux-arm64 daily-briefing-windows-x64.exe; do
    [ -f "$DIST/$t" ] || { note "$t was not produced"; rc=1; }
  done
  # --version as the FIRST argument: the engine answers it before touching any state (src/main.ts).
  if [ -f "$DIST/daily-briefing-darwin-arm64" ] && [ -x "$DIST/daily-briefing-darwin-arm64" ]; then
    got="$("$DIST/daily-briefing-darwin-arm64" --version 2>&1)" || { note "daily-briefing-darwin-arm64 --version failed: $got"; rc=1; }
    if [ "$got" = "$VERSION" ]; then note "daily-briefing-darwin-arm64 --version: $got"; else note "daily-briefing-darwin-arm64 --version printed '$got', expected '$VERSION'"; rc=1; fi
  else
    note "daily-briefing-darwin-arm64 is missing or not executable, so its --version was not run"; rc=1
  fi
  return "$rc"
}
run_step 3 "5 CLI cross-compiles + darwin-arm64 --version" step_cli

# ── 4. tauri build, plain host, under the local `tauri build` rule ─────────────────────────────────────
step_build() {
  need_version || return 1
  [ -x "$TAURI_CMD" ] || { note "no Tauri CLI at $TAURI_CMD (run bun install --frozen-lockfile in gui/)"; return 1; }
  (
    # Every ambient APPLE_* variable goes, not just the ones the runbook lists: an exported certificate
    # variable makes the bundler create a keychain in the real ~/Library/Keychains. An ambient
    # TAURI_BUNDLER_DMG_IGNORE_CI=true would defeat CI=true and drive Finder with AppleScript.
    for name in $(compgen -e); do
      case "$name" in APPLE_*) unset "$name" ;; esac
    done
    unset TAURI_BUNDLER_DMG_IGNORE_CI
    export CI=true
    export APPLE_SIGNING_IDENTITY=-
    cd "$GUI" && "$TAURI_CMD" build
  ) || { note "tauri build failed"; return 1; }
  note "outputs: gui/src-tauri/target/release/bundle/{dmg,macos}/"
}
run_step 4 "tauri build (host, ad-hoc, CI=true, APPLE_* unset)" step_build

# ── 5. stage ────────────────────────────────────────────────────────────────────────────────────────
STAGED_DMG=""
step_stage() {
  need_version || return 1
  bash "$GUI/scripts/stage-bundles.sh" "$BUNDLE" "$VERSION" "$STAGE" dmg || return 1
  STAGED_DMG="$STAGE/daily-briefing-$VERSION-darwin-arm64.dmg"
  [ -f "$STAGED_DMG" ] || { note "stage-bundles.sh exited 0 but $STAGED_DMG is not there"; STAGED_DMG=""; return 1; }
  note "$(basename "$STAGED_DMG")"
}
run_step 5 "stage-bundles.sh (frozen DMG name)" step_stage

# ── 6. size gate ────────────────────────────────────────────────────────────────────────────────────
step_size() {
  local rc=0 out
  need_version || return 1
  out="$(cd "$PROJECT" && bun scripts/check-size-budget.ts "$STAGE/daily-briefing-$VERSION-darwin-arm64.dmg" dmg-aarch64-apple-darwin 2>&1)" || rc=1
  printf '%s\n' "$out"; printf '%s\n' "$out" | while IFS= read -r l; do note "$l"; done
  out="$(cd "$PROJECT" && bun scripts/check-size-budget.ts "$BUNDLE/macos/$APP_NAME" app-aarch64-apple-darwin 2>&1)" || rc=1
  printf '%s\n' "$out"; printf '%s\n' "$out" | while IFS= read -r l; do note "$l"; done
  return "$rc"
}
run_step 6 "size gate (dmg + app arm64 rows)" step_size

# ── 7. the DMG leg ──────────────────────────────────────────────────────────────────────────────────
APP_COPY="$COPY/$APP_NAME"
step_dmg() {
  local got archs bin
  need_version || return 1
  [ -n "$STAGED_DMG" ] && [ -f "$STAGED_DMG" ] || { note "no staged DMG (step 5)"; return 1; }
  # Armed first: an interrupt during the attach, or between its return and this line, must still detach.
  # A failed attach leaves it armed too (it may have half-mounted); the exit trap's detach tolerates that.
  MOUNTED=1
  hdiutil attach "$STAGED_DMG" -nobrowse -noautoopen -readonly -mountpoint "$MNT" || { note "hdiutil attach failed"; return 1; }
  local copied=1
  cp -R "$MNT/$APP_NAME" "$COPY/" || copied=""
  # Detached straight away, copy or no copy. A transient "resource busy" just after the copy gets ONE
  # forced retry (release.yml's smoke does the same); a second failure is left to the exit trap.
  if hdiutil detach "$MNT" || { sleep 2; hdiutil detach "$MNT" -force; }; then
    MOUNTED=""
  else
    note "hdiutil detach failed (the exit trap tries again)"; return 1
  fi
  [ -n "$copied" ] || { note "copying $APP_NAME out of the image failed"; return 1; }
  for bin in "$APP_COPY/Contents/MacOS/daily-briefing-gui" "$APP_COPY/Contents/MacOS/daily-briefing"; do
    archs="$(lipo -archs "$bin" 2>&1)" || { note "lipo -archs $(basename "$bin") failed: $archs"; return 1; }
    [ "$archs" = arm64 ] || { note "$(basename "$bin") is '$archs', expected 'arm64'"; return 1; }
  done
  # Only the sidecar executes, from the scratch copy, with --version as its first argument.
  got="$("$APP_COPY/Contents/MacOS/daily-briefing" --version 2>&1)" || { note "the copied sidecar's --version failed: $got"; return 1; }
  [ "$got" = "$VERSION" ] || { note "the copied sidecar's --version printed '$got', expected '$VERSION'"; return 1; }
  note "mounted, copied, detached; both executables arm64; sidecar --version: $got"
}
run_step 7 "DMG leg (attach, copy, detach, sidecar --version)" step_dmg

# ── 8. the hardened runtime on the ad-hoc path (a --version regression of E4) ─────────────────────────
# E4's full `run --force` legs (bare and bundled sidecar) were measured once, in M1b on 2026-10-01, and
# are re-proven in Phase F's VM walkthrough. Here the runtime-signed sidecar only has to START.
# Prints why <bin>'s signature is not Tauri's ad-hoc hardened-runtime one, or nothing when it is.
signature_problem() {   # <bin> <want-entitlements: 1|"">
  local bin="$1" info flags ents got want
  info="$("$CODESIGN_CMD" -dvv "$bin" 2>&1)" || { echo "codesign -dvv failed: $info"; return; }
  printf '%s\n' "$info" >&2
  flags="$(printf '%s\n' "$info" | sed -n 's/.*flags=0x[0-9a-fA-F]*(\([^)]*\)).*/\1/p' | head -n 1)"
  # linker-signed first: bun's build-time signature carries no runtime either, and this names the cause.
  case ",$flags," in *,linker-signed,*) echo "flags ($flags) are linker-signed (bun's build-time signature, not codesign's)"; return ;; esac
  case ",$flags," in *,runtime,*) ;; *) echo "flags ($flags) lack runtime"; return ;; esac
  printf '%s\n' "$info" | grep -Fxq "Signature=adhoc" || { echo "no 'Signature=adhoc' line"; return; }
  if [ -n "$2" ]; then
    # Exactly the bundler's entitlements, compared as plists: both sides through `plutil -convert xml1`,
    # which canonicalises formatting and sorts dictionary keys, so only a semantic difference differs.
    ents="$("$CODESIGN_CMD" -d --entitlements - --xml "$bin" 2>/dev/null)" || { echo "reading its entitlements failed"; return; }
    got="$(printf '%s' "$ents" | plutil -convert xml1 -o - - 2>&1)" || { echo "its entitlements are not a readable plist: $got"; return; }
    want="$(plutil -convert xml1 -o - "$ENTITLEMENTS" 2>&1)" || { echo "gui/src-tauri/entitlements.plist is not a readable plist: $want"; return; }
    if [ "$got" != "$want" ]; then
      printf 'entitlements signed in:\n%s\nexpected (gui/src-tauri/entitlements.plist):\n%s\n' "$got" "$want" >&2
      echo "its entitlements differ from gui/src-tauri/entitlements.plist"; return
    fi
  fi
}
step_runtime() {
  local rc=0 why bin got sidecar="$E4/daily-briefing"
  need_version || return 1
  if [ -d "$APP_COPY" ]; then
    "$CODESIGN_CMD" --verify --deep --strict "$APP_COPY" || { note "codesign --verify --deep --strict failed on the copied bundle"; rc=1; }
    [ -f "$APP_COPY/Contents/_CodeSignature/CodeResources" ] || { note "the bundle is not sealed (no Contents/_CodeSignature/CodeResources)"; rc=1; }
    for bin in "$APP_COPY/Contents/MacOS/daily-briefing-gui" "$APP_COPY/Contents/MacOS/daily-briefing"; do
      why="$(signature_problem "$bin" 1)"
      if [ -n "$why" ]; then note "bundle $(basename "$bin"): $why"; rc=1; else note "bundle $(basename "$bin"): adhoc, runtime, entitlements = gui/src-tauri/entitlements.plist"; fi
    done
  else
    note "no .app copied out of the DMG (step 7)"; rc=1
  fi
  # The bare sidecar leg: the CLI binary step 3 built, ad-hoc signed with the hardened runtime in scratch.
  if [ -f "$DIST/daily-briefing-darwin-arm64" ]; then
    cp "$DIST/daily-briefing-darwin-arm64" "$sidecar" || { note "copying the darwin-arm64 binary to scratch failed"; return 1; }
    if "$CODESIGN_CMD" --force --sign - --options runtime --timestamp=none "$sidecar"; then
      why="$(signature_problem "$sidecar" "")"
      if [ -n "$why" ]; then note "bare sidecar: $why"; rc=1; fi
      got="$("$sidecar" --version 2>&1)" || { note "the runtime-signed sidecar's --version failed: $got"; rc=1; }
      if [ "$got" = "$VERSION" ]; then note "bare sidecar, ad-hoc --options runtime: --version $got"; else note "the runtime-signed sidecar's --version printed '$got', expected '$VERSION'"; rc=1; fi
    else
      note "ad-hoc signing the bare sidecar --options runtime failed"; rc=1
    fi
  else
    note "no darwin-arm64 CLI binary (step 3)"; rc=1
  fi
  return "$rc"
}
run_step 8 "hardened runtime, ad-hoc (bundle + bare sidecar)" step_runtime

# ── 9. E3 collect over the temporary dist ─────────────────────────────────────────────────────────────
step_collect() {
  local arm64 rc=0 leg
  need_version || return 1
  # macos-arm64, derived from release.yml's marker step, but STRICTER: `built` here also requires step 8,
  # whose bare-sidecar leg CI's marker does not consult. CI's gui-tests input is not mirrored here at all:
  # the GUI's tests are release-check's.
  # In CI the size step runs only after a good build and stage, so a size failure there always means an
  # over-budget artifact; here every step runs, so `size-rejected` needs the build and the stage to have
  # passed, or a size gate that merely found nothing to measure would read as a budget rejection.
  if [ "$(result_of 4)" = PASS ] && [ "$(result_of 5)" = PASS ] && [ "$(result_of 6)" = FAIL ]; then
    arm64=size-rejected
  elif [ "$(result_of 4)" = PASS ] && [ "$(result_of 5)" = PASS ] && [ "$(result_of 6)" = PASS ] \
       && [ "$(result_of 7)" = PASS ] && [ "$(result_of 8)" = PASS ]; then
    arm64=built
  else
    arm64=build-failed
  fi
  printf '%s\n' "$arm64" >"$MARKERS/macos-arm64.status"
  # The one-token contract: the marker holds the token and nothing else.
  for leg in macos-x64 linux-x86_64; do
    printf '%s\n' build-failed >"$MARKERS/$leg.status"
    echo "$leg: not buildable on this Mac (CI-only: macos-x64 on an Intel runner, linux-x86_64 on ubuntu-22.04); marker build-failed"
  done
  note "markers: macos-arm64=$arm64, macos-x64=build-failed, linux-x86_64=build-failed (not buildable here)"
  if [ "$arm64" = built ]; then
    cp "$STAGED_DMG" "$DIST/" || { note "copying the staged DMG into the dist failed"; return 1; }
  fi
  bash "$PROJECT/scripts/release-collect.sh" "$DIST" "$MARKERS" "$VERSION" unsigned success "$NOTES" \
    || { note "release-collect.sh failed"; return 1; }
  ( cd "$DIST" && shasum -a 256 -c SHA256SUMS ) || { note "SHA256SUMS does not verify inside the dist"; rc=1; }
  for leg in macos-x64 linux-x86_64; do
    grep -Fq "\`$leg\`" "$NOTES" || { note "the notes do not name the unbuilt leg $leg"; rc=1; }
  done
  [ "$rc" -eq 0 ] && note "SHA256SUMS: $(wc -l <"$DIST/SHA256SUMS" | tr -d ' ') assets, verified; the notes name macos-x64 and linux-x86_64"
  return "$rc"
}
run_step 9 "release-collect.sh (temp dist, unsigned, success)" step_collect

# ── 10-11. the E16 drift guard and the E18 site test ──────────────────────────────────────────────────
step_drift() { ( cd "$PROJECT" && env -u ANTHROPIC_API_KEY bun test test/docs-config.test.ts ); }
run_step 10 "E16 drift guard (test/docs-config.test.ts)" step_drift
step_site() { ( cd "$PROJECT" && env -u ANTHROPIC_API_KEY bun test test/site.test.ts ); }
run_step 11 "E18 site test (test/site.test.ts)" step_site

# ── 12. no tracked file rewritten ───────────────────────────────────────────────────────────────────
step_tracked() {
  [ -z "$TRACKED_BEFORE_ERR" ] || { note "the before-run snapshot (git diff HEAD) failed: $TRACKED_BEFORE_ERR"; return 1; }
  [ -n "$TRACKED_BEFORE" ] || { note "not inside a git checkout with a HEAD, so a rewritten tracked file could not be detected"; return 1; }
  local after
  after="$(tracked_digest)" || { note "the after-run snapshot (git diff HEAD) failed, so a rewritten tracked file could not be ruled out"; return 1; }
  [ "$after" = "$TRACKED_BEFORE" ] && return 0
  git -C "$PROJECT" status --porcelain --untracked-files=no -- .
  note "a step rewrote tracked files of this project (git diff HEAD changed during the run):"
  git -C "$PROJECT" status --porcelain --untracked-files=no -- . | head -n 10 | while IFS= read -r line; do note "  $line"; done
  return 1
}
run_step 12 "no tracked file rewritten" step_tracked
FINISHED=1

if [ "$FAILED" -ne 0 ]; then
  echo "verify-dist-local: FAIL — $FAILED step(s) failed for ${VERSION:-<no version>}."
  exit 1
fi
echo "verify-dist-local: PASS — every step passed for $VERSION on this Mac. Still CI-only or VM-only: docs/RELEASE.md, \"What this Mac cannot prove\"."
