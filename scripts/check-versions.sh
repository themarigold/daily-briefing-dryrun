#!/usr/bin/env bash
# check-versions.sh — the multi-file version guard (Phase E, E9).
#
# Usage: bash scripts/check-versions.sh <version>      (plain semver X.Y.Z, the tag without its v)
#
# The release's version lives in FOUR carriers, and every one must equal <version>:
#   package.json                    the engine; the CLI binaries report it (`--version`)
#   gui/package.json                the desktop app; Tauri bundle names take their version from it,
#                                   through gui/src-tauri/tauri.conf.json `"version": "../package.json"`
#   gui/src-tauri/Cargo.toml        the shell crate's [package] version
#   gui/src-tauri/Cargo.lock        the `daily-briefing-gui` package entry (tracked and exported)
# It also checks gui/size-budget.json: every non-null `path` that carries Tauri's `_<X.Y.Z>_` version
# segment (today only the arm64 DMG row) must carry `_<version>_`, so a bump cannot forget the
# re-measure. Version-free paths (the .app row, the sidecar) are exempt.
#
# Each mismatch is named by file; every check runs; exit 1 if any failed, else 0.
# This REPLACES the one-file guard in release.yml's gate (the wiring is the workflow's change), and
# the local release check calls it. Needs bun (JSON parsing; no jq) and POSIX awk.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }

[ "$#" -eq 1 ] || { echo "usage: check-versions.sh <version>" >&2; exit 1; }
WANT="$1"
if ! printf '%s\n' "$WANT" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "FAIL: '$WANT' is not plain semver X.Y.Z (pass the tag without its leading v; there is no RC form)" >&2
  exit 1
fi
command -v bun >/dev/null 2>&1 || { echo "FAIL: bun is not on PATH (needed to read the JSON carriers)" >&2; exit 1; }

# Prints the top-level "version" of a JSON file, or nothing (and a message) when it cannot.
json_version() {
  bun -e 'const j = JSON.parse(await Bun.file(process.argv[1]).text()); if (typeof j.version !== "string") process.exit(3); console.log(j.version)' "$1" 2>/dev/null
}

check() {
  local file="$1" got="$2"
  if [ -z "$got" ]; then
    fail "$file: no version found"
  elif [ "$got" != "$WANT" ]; then
    fail "$file: version $got != $WANT"
  else
    echo "ok:   $file $got"
  fi
}

check "package.json" "$(json_version "$ROOT/package.json")"
check "gui/package.json" "$(json_version "$ROOT/gui/package.json")"

# Cargo.toml: the first `version = "..."` inside the [package] table.
CARGO_TOML="$ROOT/gui/src-tauri/Cargo.toml"
toml_v=""
[ -f "$CARGO_TOML" ] && toml_v="$(awk '
  /^\[/ { in_pkg = ($0 ~ /^\[package\][ \t]*$/); next }
  in_pkg && /^version[ \t]*=/ {
    v = $0; sub(/^version[ \t]*=[ \t]*"/, "", v); sub(/".*$/, "", v); print v; exit
  }' "$CARGO_TOML")"
check "gui/src-tauri/Cargo.toml" "$toml_v"

# Cargo.lock: the version of the [[package]] entry named daily-briefing-gui; exactly one such entry.
CARGO_LOCK="$ROOT/gui/src-tauri/Cargo.lock"
lock_v=""
if [ -f "$CARGO_LOCK" ]; then
  lock_out="$(awk '
    /^\[\[package\]\]/ { in_gui = 0; next }
    /^name = "daily-briefing-gui"$/ { in_gui = 1; n++; next }
    in_gui && /^version = "/ { v = $0; sub(/^version = "/, "", v); sub(/"$/, "", v); print v; in_gui = 0 }
    END { if (n != 1) print "COUNT:" n + 0 }' "$CARGO_LOCK")"
  case "$lock_out" in
    *COUNT:*) fail "gui/src-tauri/Cargo.lock: expected exactly one daily-briefing-gui package entry (${lock_out##*COUNT:} found)"; lock_v="__counted__" ;;
    *) lock_v="$lock_out" ;;
  esac
fi
[ "$lock_v" = "__counted__" ] || check "gui/src-tauri/Cargo.lock (daily-briefing-gui)" "$lock_v"

# size-budget.json: versioned row paths must carry the release version.
BUDGET="$ROOT/gui/size-budget.json"
budget_out="$(bun -e '
  const want = process.argv[2];
  const b = JSON.parse(await Bun.file(process.argv[1]).text());
  const rows = [["sidecar", b.sidecar], ...Object.entries(b.artifacts ?? {})];
  for (const [name, row] of rows) {
    const p = row && row.path;
    if (typeof p !== "string") continue;
    const m = /_(\d+\.\d+\.\d+)_/.exec(p);
    if (!m) { console.log(`exempt ${name}`); continue; }
    console.log(m[1] === want ? `ok ${name} ${p}` : `stale ${name} ${p}`);
  }' "$BUDGET" "$WANT" 2>&1)" || { fail "gui/size-budget.json: could not be read ($budget_out)"; budget_out=""; }
while IFS= read -r line; do
  case "$line" in
    "ok "*)     echo "ok:   gui/size-budget.json row ${line#ok }" ;;
    "stale "*)  rest="${line#stale }"; fail "gui/size-budget.json: row ${rest%% *} path '${rest#* }' does not carry _${WANT}_ — re-measure the row in the same change as the bump" ;;
    "exempt "*) echo "ok:   gui/size-budget.json row ${line#exempt } (version-free path, exempt)" ;;
  esac
done <<EOF
$budget_out
EOF

if [ "$FAILS" -ne 0 ]; then
  echo "check-versions: $FAILS mismatch(es) against $WANT. Note: the desktop bundle names take their version from gui/package.json (tauri.conf.json \"version\": \"../package.json\")." >&2
  exit 1
fi
echo "check-versions: PASS — all four version carriers and the versioned size-budget paths are $WANT"
