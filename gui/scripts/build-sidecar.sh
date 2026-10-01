#!/usr/bin/env bash
# build-sidecar.sh — compile the ENGINE into the Tauri sidecar slot (T7).
#
# Tauri's `bundle.externalBin: ["binaries/daily-briefing"]` does not name a file. It names a
# PREFIX: at bundle time Tauri looks for `binaries/daily-briefing-<rust-target-triple>` and copies
# it in under the bare name. So the whole job of this script is (a) compile the engine and
# (b) land it under the triple-suffixed name Tauri will actually look for.
#
# ⚠ THE TRIPLE IS ASKED FOR, NEVER ASSUMED — and the HOST triple is the LAST resort, not the
# first. Hardcoding `aarch64-apple-darwin` produces a bundle that builds cleanly on the author's
# laptop and cannot find its own sidecar anywhere else; silently using the host triple during a
# CROSS build is the same defect wearing a `rustc` costume, because the bundle would then look for
# `daily-briefing-<target>` while this script compiled `daily-briefing-<host>`. Precedence:
#
#   1. an explicit argument                — a human cross-compiling on purpose
#   2. $TAURI_ENV_TARGET_TRIPLE            — what `tauri build --target <triple>` exports into
#                                            `beforeBuildCommand` (measured with an env-dumping
#                                            hook: Tauri sets it for every build, cross or not)
#   3. `rustc --print host-tuple`          — a plain host build, or a bare invocation from a shell
#
# Bun's `--target` names and Rust's triples are two different vocabularies for the same machines,
# so the mapping below is explicit in both directions rather than string-munged.
#
# Usage:
#   bash scripts/build-sidecar.sh                 # $TAURI_ENV_TARGET_TRIPLE, else the host triple
#   bash scripts/build-sidecar.sh <rust-triple>   # cross-compile one of the mapped triples
#
# Wired as `build.beforeBuildCommand` in src-tauri/tauri.conf.json, so `tauri build` cannot produce
# a bundle whose sidecar is MISSING — tauri_build refuses to compile the crate without it — and,
# with (2) above, cannot produce one whose sidecar is for the wrong machine. What it still cannot
# promise is a full cross-target BUNDLE: only the mapped triples compile here, and no cross-target
# `tauri build` has been run against this script (Phase E's platform matrix owns that).

set -euo pipefail

GUI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The engine lives one level ABOVE the gui package and is compiled from ITS OWN root: `bun build`
# resolves `src/main.ts`, the tsconfig and package.json relative to the cwd, and package.json is
# where the version the binary reports comes from (src/main.ts: `const VERSION = pkg.version`).
ENGINE_DIR="$(cd "$GUI_DIR/.." && pwd)"
OUT_DIR="$GUI_DIR/src-tauri/binaries"

command -v bun >/dev/null 2>&1 || { echo "build-sidecar: bun is not on PATH" >&2; exit 1; }
command -v rustc >/dev/null 2>&1 || { echo "build-sidecar: rustc is not on PATH (needed for the host triple)" >&2; exit 1; }

[ -f "$ENGINE_DIR/src/main.ts" ] || {
  echo "build-sidecar: no engine at $ENGINE_DIR/src/main.ts — is the gui package still inside the engine repo?" >&2
  exit 1
}

# ── Rust triple → bun --target ──────────────────────────────────────────────────────────────────
# Keep this the ONLY place the two vocabularies meet.
bun_target_for() {
  case "$1" in
    aarch64-apple-darwin)       echo "bun-darwin-arm64" ;;
    x86_64-apple-darwin)        echo "bun-darwin-x64" ;;
    x86_64-unknown-linux-gnu)   echo "bun-linux-x64" ;;
    aarch64-unknown-linux-gnu)  echo "bun-linux-arm64" ;;
    x86_64-pc-windows-msvc)     echo "bun-windows-x64" ;;
    *) return 1 ;;
  esac
}

# Windows is the only platform where the sidecar carries an extension; Tauri looks for
# `daily-briefing-x86_64-pc-windows-msvc.exe` there and for the bare name everywhere else.
exe_suffix_for() {
  case "$1" in
    *-pc-windows-*) echo ".exe" ;;
    *) echo "" ;;
  esac
}

# Precedence, in the order documented in the header: explicit argument, then the triple Tauri
# exports for the build in progress, then the host. `${VAR:-}` (not `${VAR-}`) so an empty
# TAURI_ENV_TARGET_TRIPLE falls through rather than winning with nothing.
TRIPLE="${1:-${TAURI_ENV_TARGET_TRIPLE:-$(rustc --print host-tuple)}}"
[ -n "$TRIPLE" ] || { echo "build-sidecar: rustc --print host-tuple returned nothing" >&2; exit 1; }

if [ -n "${1:-}" ]; then
  TRIPLE_SOURCE="argument"
elif [ -n "${TAURI_ENV_TARGET_TRIPLE:-}" ]; then
  TRIPLE_SOURCE="\$TAURI_ENV_TARGET_TRIPLE"
else
  TRIPLE_SOURCE="rustc --print host-tuple"
fi

# A cross build is worth saying out loud: the sidecar that lands will not run on this machine, so
# `open`ing the resulting bundle here fails at the first sidecar spawn rather than at build time.
HOST_TRIPLE="$(rustc --print host-tuple)"
if [ "$TRIPLE" != "$HOST_TRIPLE" ]; then
  echo "build-sidecar: CROSS build — target $TRIPLE, host $HOST_TRIPLE (via $TRIPLE_SOURCE)" >&2
fi

if ! BUN_TARGET="$(bun_target_for "$TRIPLE")"; then
  echo "build-sidecar: no bun --target mapped for rust triple '$TRIPLE'." >&2
  echo "  mapped triples: aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-pc-windows-msvc" >&2
  echo "  Add the pair to bun_target_for() rather than renaming the output by hand — Tauri resolves the sidecar BY the triple suffix." >&2
  exit 1
fi

SUFFIX="$(exe_suffix_for "$TRIPLE")"
OUT="$OUT_DIR/daily-briefing-${TRIPLE}${SUFFIX}"

mkdir -p "$OUT_DIR"
echo "build-sidecar: engine  $ENGINE_DIR"
echo "build-sidecar: triple  $TRIPLE  (bun --target $BUN_TARGET, via $TRIPLE_SOURCE)"
echo "build-sidecar: output  $OUT"

# ── bun's compile intermediate ──────────────────────────────────────────────────────────────────
# `bun build --compile` writes a temporary `.<hash>-00000000.bun-build` file into its CWD and never
# removes it. MEASURED on bun 1.3.14: one appears per invocation, each the full size of the
# compiled binary (61 MB), and eight had silently accumulated at the engine root — ~490 MB — before
# anyone noticed. They are gitignored (`.gitignore:31`), which is why they were invisible in
# `git status` rather than absent.
#
# The CWD cannot move away from the engine root: `bun build` resolves `src/main.ts`, the tsconfig,
# and the `package.json` the binary's version string comes from relative to it (see ENGINE_DIR).
# And bun 1.3.14 offers no flag to relocate or suppress the intermediate — `bun build --help` names
# neither the file nor a temp directory. So it is removed afterwards.
#
# By DIFFERENCE, not by wildcard: the set present before the compile is recorded and only what
# appeared during it is deleted, so a concurrent build's intermediate — or any pre-existing file
# that happens to end in `.bun-build` — is left where it is. `find` rather than a glob because
# these names begin with a dot, which `*.bun-build` does not match in a shell.
bun_build_intermediates() {
  find "$ENGINE_DIR" -maxdepth 1 -type f -name '*.bun-build' 2>/dev/null | sort
}
INTERMEDIATES_BEFORE="$(bun_build_intermediates)"

# `cd` into the ENGINE root, not the gui package: see ENGINE_DIR above.
( cd "$ENGINE_DIR" && bun build src/main.ts --compile --target "$BUN_TARGET" --outfile "$OUT" )

CLEANED=0
while IFS= read -r intermediate; do
  [ -n "$intermediate" ] || continue
  # Already there before this run? Then it is not ours to remove.
  case "
$INTERMEDIATES_BEFORE
" in
    *"
$intermediate
"*) continue ;;
  esac
  rm -f "$intermediate" && CLEANED=$((CLEANED + 1))
done <<EOF
$(bun_build_intermediates)
EOF
[ "$CLEANED" = "0" ] || echo "build-sidecar: removed $CLEANED bun compile intermediate(s) from $ENGINE_DIR"

[ -f "$OUT" ] || { echo "build-sidecar: bun reported success but $OUT does not exist" >&2; exit 1; }
chmod +x "$OUT"
[ -x "$OUT" ] || { echo "build-sidecar: $OUT is not executable" >&2; exit 1; }

echo "build-sidecar: ok — $(basename "$OUT") ($(wc -c <"$OUT" | tr -d ' ') bytes)"
