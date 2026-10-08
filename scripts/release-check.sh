#!/usr/bin/env bash
# release-check.sh — the local pre-release gate (Phase E, E7). Run it on the commit you are about to
# release, before any export, push or tag. docs/RELEASE.md says where it sits in the sequence.
#
# Usage: bash scripts/release-check.sh <version> [--soft-ok]
#   <version>  plain X.Y.Z, the tag without its leading v
#   --soft-ok  accept the export's SOFT residuals after reading them (they are printed either way)
#
# ⚠ EVAL-INTEGRITY: WIRING ONLY. Check 6 consumes the EXISTING contract of `bun run eval --json` — its exit
# code (exactly 0; scripts/eval.ts exits 1 when a gold case fails and 2 on an unknown --case filter) and
# the payload's `pass`, `posture` and `truncated` fields — and the accepted posture set is the literal
# {"full"}. No gold case, check, threshold, rubric or counted-flag semantic is touched here.
# (User-directed: the Phase E plan's release-gate changes, approved 2026-10-01.)
#
# It runs EVERY check — a FAIL never stops the later ones — prints PASS/FAIL per check, exits 1 if any
# failed, and on an all-PASS run prints the exact next commands. The checks, in order:
#   1. On the INVOKING checkout: the project's tree is clean (`git status --porcelain
#      --untracked-files=all -- .`, so untracked files count whatever status.showUntrackedFiles says; a
#      monorepo sibling's state is not this project's) and its HEAD is recorded. There is no --allow-dirty:
#      export copies tracked files from the WORKING TREE, so a dirty tree would gate one thing and ship
#      another. A NOTE (never a FAIL) says when that HEAD is not in origin/main as this checkout last
#      fetched it (docs/RELEASE.md releases the merged main commit), or that origin/main is not there.
#      Checks 2-9 then run in a DETACHED WORKTREE of that HEAD (`git worktree add --detach`, in a fresh
#      directory under /private/tmp, or $TMPDIR where that does not exist), after a
#      `bun install --frozen-lockfile` there. The invoking checkout is never touched, and the worktree is
#      removed on exit, pass or fail.
#   2. bunx tsc --noEmit
#   3. bun test
#   4. bash scripts/check-versions.sh <version>       (the four version carriers + the size-budget paths)
#   5. The GUI gates, from gui/: bun install --frozen-lockfile; bash scripts/build-sidecar.sh (the shell
#      crate does not compile without the host sidecar); then bun run test, bun run check (svelte-check)
#      and cargo test --locked --no-fail-fast, all three run even when one fails. --locked: a resolution
#      change must fail here, not rewrite Cargo.lock in the worktree that check 7 then exports. Unskipped,
#      so this is a macOS gate: the size-budget stale-row test (gui/src-tauri/tests/packaging.rs) cannot
#      hold on Linux.
#   6. bun run eval --json — exit exactly 0, and stdout (parsed with `bun -e`; no jq) is a JSON object
#      with pass === true, posture === "full" and truncated === false. Empty or non-JSON stdout is a FAIL.
#      It also counts the eval's `parse-info [recap-evidence-…]` stderr lines for a report-only note;
#      that count sits outside the contract the EVAL-INTEGRITY paragraph describes (check 6 consumes the
#      eval's exit code and its `pass`, `posture` and `truncated` fields) and never reaches the verdict
#      (user-directed, 2026-10-06).
#      ⚠ This calls your configured provider for real, several times per gold case.
#   7. bash scripts/export-public.sh into a fresh directory (it refuses an existing one) — but first the
#      worktree's tracked files must still be exactly HEAD's (as in 9): the export copies them from disk,
#      so a check that rewrote one would ship a tree that is not the commit being certified. A failed HARD
#      sweep (or a sweep that could not run) is a FAIL. Its SOFT residual list — anything but its "(none)"
#      line — is a FAIL unless --soft-ok was passed, and is printed either way.
#   8. bun install --frozen-lockfile && bunx tsc --noEmit && bun test, INSIDE that export — only when
#      export-public.sh itself exited 0. A failed export can leave a populated target whose sweep failed
#      or never ran, and that tree is never gated as if it were the export.
#   The exported tree has no scripts/export-public.sh (the export excludes itself), so there 7-8 are
#   skipped with a note.
#   9. The worktree's tracked files are still exactly HEAD's (`git status --porcelain
#      --untracked-files=no` is empty), in both layouts: checks 2-8 must have tested the commit itself.
#
# Each check's whole output goes to a log; a FAIL prints the log's tail, and the logs are kept when
# anything failed. RELEASE_CHECK_TMPDIR moves the run directory (worktree, export, logs) elsewhere; the
# tests use it. Every command above is called by name from PATH, which is how test/release-check.test.ts
# stubs them; nothing in this file switches a check off.
set -uo pipefail   # deliberately not -e: every check runs, and each is judged by its own exit code

usage() { echo "usage: bash scripts/release-check.sh <version> [--soft-ok]" >&2; exit 2; }
VERSION=""
SOFT_OK=""
for arg in "$@"; do
  case "$arg" in
    --soft-ok) SOFT_OK=1 ;;
    -*) usage ;;
    *) [ -z "$VERSION" ] || usage; VERSION="$arg" ;;
  esac
done
[ -n "$VERSION" ] || usage

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [ -n "${RELEASE_CHECK_TMPDIR:-}" ]; then
  TMP_PARENT="$RELEASE_CHECK_TMPDIR"
elif [ -d /private/tmp ]; then
  TMP_PARENT=/private/tmp
else
  TMP_PARENT="${TMPDIR:-/tmp}"
fi
RUN_DIR="$(mktemp -d "$TMP_PARENT/dba-release-check.XXXXXX")" || { echo "release-check: could not create a run directory under $TMP_PARENT" >&2; exit 1; }
LOGS="$RUN_DIR/logs"
WT="$RUN_DIR/worktree"
EXPORT="$RUN_DIR/export"
mkdir -p "$LOGS"

FAILED=0
FINISHED=""
WT_CREATED=""
TOPLEVEL=""
cleanup() {
  if [ -n "$WT_CREATED" ]; then
    git -C "$TOPLEVEL" worktree remove --force "$WT" >/dev/null 2>&1 \
      || { rm -rf "$WT"; git -C "$TOPLEVEL" worktree prune >/dev/null 2>&1; }
  fi
  rm -rf "$EXPORT"
  if [ -n "$FINISHED" ] && [ "$FAILED" -eq 0 ]; then
    rm -rf "$RUN_DIR"
  else
    echo "release-check: logs kept in $LOGS"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
trap 'exit 129' HUP

# ── reporting ───────────────────────────────────────────────────────────────────────────────────────────
CUR=""
# A short line printed under the current check's PASS/FAIL (the full output goes to its log).
note() { printf '%s\n' "$*" >>"$LOGS/$CUR.notes"; }
print_notes() { [ -f "$LOGS/$1.notes" ] && sed 's/^/      /' "$LOGS/$1.notes"; return 0; }
report() {   # <id> <title> <PASS|FAIL|SKIP>
  printf '[%s] %-50s %s\n' "$1" "$2" "$3"
  print_notes "$1"
  if [ "$3" = FAIL ]; then
    FAILED=$((FAILED + 1))
    if [ -s "$LOGS/$1.log" ]; then
      # bun's "(fail) <name>" and cargo's "test <name> ... FAILED" lines, when there are any: a suite's
      # tail is its summary, which says how many failed but not which.
      if grep -qE '^\(fail\) |^test .* \.\.\. FAILED$' "$LOGS/$1.log"; then
        echo "      failing tests:"
        grep -E '^\(fail\) |^test .* \.\.\. FAILED$' "$LOGS/$1.log" | head -n 15 | sed 's/^/      | /'
      fi
      echo "      last lines of $LOGS/$1.log:"
      tail -n 20 "$LOGS/$1.log" | sed 's/^/      | /'
    fi
  fi
}
run_check() {   # <id> <title> <function> [args...]
  CUR="$1"
  local title="$2" rc=0
  shift 2
  "$@" >"$LOGS/$CUR.log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then report "$CUR" "$title" PASS; else report "$CUR" "$title" FAIL; fi
}
not_run() {   # <id> <title> <why> — a check that could not run is a FAIL, never a pass
  CUR="$1"
  note "not run: $3"
  report "$1" "$2" FAIL
}
skip_check() {   # <id> <title> <why>
  CUR="$1"
  note "$3"
  report "$1" "$2" SKIP
}

# ── 1. the invoking checkout ────────────────────────────────────────────────────────────────────────────
HEAD_SHA="$(git -C "$PROJECT" rev-parse --verify HEAD 2>/dev/null || true)"
TOPLEVEL="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null || true)"
# "" in the exported tree (the project IS the repo), "<project>/" inside a monorepo.
PREFIX="$(git -C "$PROJECT" rev-parse --show-prefix 2>/dev/null || true)"
WD="$WT/$PREFIX"   # where checks 2-9 run

echo "release-check $VERSION — $PROJECT @ ${HEAD_SHA:-<no HEAD>}"

# A NOTE only, never part of the verdict: RELEASE.md releases the MERGED main commit, and this says when
# HEAD is not in origin/main as the checkout last fetched it (nothing is fetched here).
main_note() {
  local arc=0
  if ! git -C "$PROJECT" rev-parse --verify -q 'origin/main^{commit}' >/dev/null 2>&1; then
    note "NOTE: there is no origin/main here, so whether HEAD is the merged main commit was not checked"
    return 0
  fi
  git -C "$PROJECT" merge-base --is-ancestor "$HEAD_SHA" origin/main >/dev/null 2>&1 || arc=$?
  case "$arc" in
    0) ;;
    1) note "NOTE: HEAD is not in origin/main (as last fetched); docs/RELEASE.md releases the merged main commit" ;;
    *) note "NOTE: could not tell whether HEAD is in origin/main (git merge-base exited $arc)" ;;
  esac
  return 0
}
check_clean() {
  if [ -z "$HEAD_SHA" ] || [ -z "$TOPLEVEL" ]; then
    note "no git HEAD here: release-check must run inside a git checkout of the release commit"
    return 1
  fi
  local dirty
  dirty="$(git -C "$PROJECT" status --porcelain --untracked-files=all -- . 2>&1)" || { echo "$dirty"; note "git status failed"; return 1; }
  if [ -n "$dirty" ]; then
    printf '%s\n' "$dirty"
    note "the tree is not clean ($(printf '%s\n' "$dirty" | wc -l | tr -d ' ') entries) — commit or remove them; export ships the working tree"
    printf '%s\n' "$dirty" | head -n 5 | while IFS= read -r line; do note "  $line"; done
    main_note
    return 1
  fi
  note "HEAD $HEAD_SHA"
  main_note
}
run_check 1 "clean tree, HEAD recorded" check_clean

setup_worktree() {
  [ -n "$HEAD_SHA" ] && [ -n "$TOPLEVEL" ] || { note "no HEAD to check out"; return 1; }
  git -C "$TOPLEVEL" worktree add --detach "$WT" "$HEAD_SHA" || { note "git worktree add failed"; return 1; }
  WT_CREATED=1
  ( cd "$WD" && bun install --frozen-lockfile ) || { note "bun install --frozen-lockfile failed in the worktree"; return 1; }
  note "$WD"
}
run_check setup "worktree at HEAD + bun install --frozen-lockfile" setup_worktree

# ── 2-8, inside the worktree ────────────────────────────────────────────────────────────────────────────
check_tsc() { ( cd "$WD" && bunx tsc --noEmit ); }
check_tests() { ( cd "$WD" && bun test ); }
check_versions() { ( cd "$WD" && bash scripts/check-versions.sh "$VERSION" ); }

check_gui() {
  local failed=""
  ( cd "$WD/gui" && bun install --frozen-lockfile ) || { note "gui: bun install --frozen-lockfile failed"; return 1; }
  ( cd "$WD/gui" && bash scripts/build-sidecar.sh ) || { note "gui: scripts/build-sidecar.sh failed (cargo test cannot compile without the host sidecar)"; return 1; }
  ( cd "$WD/gui" && bun run test ) || failed="$failed 'bun run test'"
  ( cd "$WD/gui" && bun run check ) || failed="$failed 'bun run check' (svelte-check)"
  ( cd "$WD/gui" && cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast ) || failed="$failed 'cargo test'"
  if [ -n "$failed" ]; then note "failed:$failed"; return 1; fi
}

# The predicate. Strict: pass must be the boolean true, posture the literal "full", truncated the boolean
# false — exactly the payload scripts/eval.ts prints, and nothing else counts.
# shellcheck disable=SC2016  # JavaScript, single-quoted on purpose: its ${…} are template literals, not bash
EVAL_PREDICATE='
const text = await Bun.file(process.argv[1]).text();
let j;
try { j = JSON.parse(text); } catch {
  console.log(text.trim() === "" ? "eval printed nothing on stdout" : "eval stdout is not JSON");
  process.exit(1);
}
if (j === null || typeof j !== "object" || Array.isArray(j)) { console.log("eval stdout is not a JSON object"); process.exit(1); }
const why = [];
if (j.pass !== true) why.push(`pass is ${JSON.stringify(j.pass)}, not true`);
if (j.posture !== "full") why.push(`posture is ${JSON.stringify(j.posture)}, not "full"`);
if (j.truncated !== false) why.push(`truncated is ${JSON.stringify(j.truncated)}, not false`);
if (why.length) { console.log(why.join("; ")); process.exit(1); }
console.log("pass: true, posture: \"full\", truncated: false");
'
check_eval() {
  local out="$LOGS/6.stdout" rc=0 verdict prc=0
  # stdout to its own file (the payload); stderr (diagnostics, the per-case lines) to the log
  ( cd "$WD" && bun run eval --json ) >"$out" || rc=$?
  local n; n="$(grep -c 'parse-info \[recap-evidence-' "$LOGS/6.log" || true)"
  note "recap evidence recoveries during eval: ${n} line(s) (report only; never changes the verdict)"
  if [ "$rc" -ne 0 ]; then
    note "bun run eval --json exited $rc; only 0 counts (1 = a gold case failed, 2 = an unknown --case filter)"
    return 1
  fi
  verdict="$(bun -e "$EVAL_PREDICATE" "$out" 2>&1)" || prc=$?
  note "$verdict"
  return "$prc"
}

# Fails, naming them, when any TRACKED file in the worktree no longer matches HEAD (a check rewrote it).
# Untracked files do not count: the export ships tracked names only, and the checks' build products
# (node_modules, target/, the sidecar) are untracked.
require_pristine_worktree() {   # <what the dirt would mean>
  local dirt
  dirt="$(git -C "$WD" status --porcelain --untracked-files=no 2>&1)" || { echo "$dirt"; note "git status failed in the worktree"; return 1; }
  [ -z "$dirt" ] && return 0
  printf '%s\n' "$dirt"
  note "the worktree's tracked files no longer match HEAD — $1:"
  printf '%s\n' "$dirt" | head -n 10 | while IFS= read -r line; do note "  $line"; done
  return 1
}

EXPORT_OK=""   # set only when export-public.sh ran to completion and exited 0; check 8 gates nothing else
check_export() {
  local out="$LOGS/7.stdout" rc=0 soft arc=0
  require_pristine_worktree "an earlier check rewrote them, and the export would ship that tree instead of HEAD; not exported" || return 1
  ( cd "$WD" && bash scripts/export-public.sh "$EXPORT" ) >"$out" || rc=$?
  cat "$out"
  if [ "$rc" -ne 0 ]; then
    note "export-public.sh exited $rc (a HARD residual, or a sweep that could not run — see the log)"
    return 1
  fi
  EXPORT_OK=1
  # The SOFT section: the lines after its "— soft residuals" header, up to the next "— " line.
  soft="$(awk '/^— soft residuals/ { inside = 1; seen = 1; next } inside && /^— / { inside = 0 } inside { print } END { if (!seen) exit 3 }' "$out")" || arc=$?
  if [ "$arc" -ne 0 ]; then note "could not find the soft-residual section in export-public.sh's output"; return 1; fi
  if [ -z "$soft" ]; then note "the soft-residual section is empty (expected its \"(none)\" line or a list)"; return 1; fi
  if [ "$(printf '%s' "$soft" | tr -d ' \t')" = "(none)" ]; then note "soft residuals: (none)"; return 0; fi
  note "soft residuals (files naming private projects):"
  printf '%s\n' "$soft" | while IFS= read -r line; do note "  ${line#"$EXPORT"/}"; done
  if [ -n "$SOFT_OK" ]; then note "accepted with --soft-ok"; return 0; fi
  note "FAIL without --soft-ok: read them, then re-run with --soft-ok if they are acceptable"
  return 1
}
check_export_gates() {
  # Gated on check 7's outcome, not on the directory: a failed export-public.sh can leave a populated
  # target behind (it writes the tree before its sweeps run), and that tree was never swept clean.
  [ -n "$EXPORT_OK" ] || { note "not run: check 7 produced no export that passed its sweep (export-public.sh failed, or was not run)"; return 1; }
  ( cd "$EXPORT" && bun install --frozen-lockfile && bunx tsc --noEmit && bun test )
}
check_worktree_unchanged() {
  require_pristine_worktree "a check rewrote them, so the checks above did not test HEAD itself"
}

if [ -z "$WT_CREATED" ]; then
  for c in "2|bunx tsc --noEmit" "3|bun test" "4|scripts/check-versions.sh $VERSION" \
           "5|GUI gates (test, svelte-check, cargo test)" "6|bun run eval --json" \
           "7|export-public.sh + soft residuals" "8|gates inside the export" \
           "9|worktree still at HEAD (tracked files)"; do
    not_run "${c%%|*}" "${c#*|}" "there is no worktree at a recorded HEAD"
  done
else
  run_check 2 "bunx tsc --noEmit" check_tsc
  run_check 3 "bun test" check_tests
  run_check 4 "scripts/check-versions.sh $VERSION" check_versions
  run_check 5 "GUI gates (test, svelte-check, cargo test)" check_gui
  run_check 6 "bun run eval --json" check_eval
  if [ -f "$WD/scripts/export-public.sh" ]; then
    run_check 7 "export-public.sh + soft residuals" check_export
    run_check 8 "gates inside the export" check_export_gates
  else
    skip_check 7 "export-public.sh + soft residuals" "scripts/export-public.sh is absent: this is the exported tree (the export excludes itself)"
    skip_check 8 "gates inside the export" "skipped with check 7"
  fi
  run_check 9 "worktree still at HEAD (tracked files)" check_worktree_unchanged
fi
FINISHED=1

if [ "$FAILED" -ne 0 ]; then
  echo "release-check: FAIL — $FAILED check(s) failed for $VERSION. Nothing is released from this commit."
  exit 1
fi

SHORT="${HEAD_SHA:0:12}"
echo "release-check: PASS — every check passed for $VERSION at $HEAD_SHA."
echo "Next, per docs/RELEASE.md (each push needs its own yes):"
if [ -f "$WD/scripts/export-public.sh" ]; then
  REL="$TMP_PARENT/dba-release-$VERSION-$SHORT"
  OUT="$TMP_PARENT/dba-export-$VERSION-$SHORT"
  echo "  git -C \"$TOPLEVEL\" worktree add --detach \"$REL\" $HEAD_SHA"
  echo "  bash \"$REL/${PREFIX}scripts/export-public.sh\" \"$OUT\""
  echo "  (cd \"$OUT\" && bun install --frozen-lockfile && bunx tsc --noEmit && bun test)"
  echo "  git -C \"$TOPLEVEL\" worktree remove \"$REL\""
  echo "  then sync \"$OUT\" into the public repo checkout, commit, check the commit's tree and record its sha"
  echo "  (docs/RELEASE.md, step 5), push it (yes), and tag that sha: git tag v$VERSION <sha>; git push --no-follow-tags origin v$VERSION (yes)"
else
  # The exported tree has no identity sweep (export-public.sh does not ship), so a commit made here is
  # never tagged: only the commit step 5 builds from a monorepo export is (docs/RELEASE.md step 5).
  echo "  this checkout is the exported tree: do not tag it. Never tag a commit made directly in the public repo:"
  echo "  tag only the sha docs/RELEASE.md step 5 recorded for the monorepo export of v$VERSION, following"
  echo "  steps 5-7 there (sync the export, commit, check the commit's tree, push, then tag that sha; each push its own yes)."
fi
