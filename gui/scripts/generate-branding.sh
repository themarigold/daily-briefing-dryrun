#!/usr/bin/env bash
# T22 — regenerate EVERYTHING derived from the three hand-authored SVG sources
# (src-tauri/branding/{master,tray-template,dmg-background}.svg), deterministically:
# running this twice produces byte-identical output, and `--check` regenerates into a scratch
# directory and byte-compares against the committed files without touching them — the
# floor-runnable (macOS) idempotence/derivation check, wired into the default `cargo test`
# floor as tests/icons.rs::regeneration_check_gate. macOS-only by design (sips ships nowhere
# else), and CI is ubuntu-only and runs no cargo — so the floor test is the ONLY caller.
# See docs/gui-seam.md §14a for the pipeline's design record.
#
# Renderers, both pinned or OS-shipped, both required (fail loudly, never silently skip):
#   * @tauri-apps/cli 2.11.4 (node_modules/.bin/tauri, pinned in gui/package.json) rasterises
#     every SQUARE asset — the full icon set from master.svg, the 1024 branding raster, and the
#     tray templates at the measured 18pt (18/36px; docs/gui-seam.md §14b dev 146).
#   * macOS `sips` rasterises the NON-square DMG background (the tauri CLI only renders squares);
#     measured deterministic: byte-identical across runs, and its eXIf chunk carries pixel
#     dimensions only, no timestamp. The @2x is rendered from the SAME svg with width/height
#     doubled (the viewBox pins the geometry), so the two PNGs cannot drift.
#   * `tauri icon`'s ICNS writer emits elements in hash-map order; icns-canonical.ts sorts them
#     by type code so the container is byte-stable (§14a).
#
# Asset generation is LOCAL-ONLY: nothing here fetches fonts, images or anything else.

set -euo pipefail

GUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRAND="$GUI/src-tauri/branding"
ICONS="$GUI/src-tauri/icons"
TAURI="$GUI/node_modules/.bin/tauri"

MODE="${1:-write}"
case "$MODE" in
  write | --check) ;;
  *)
    echo "usage: generate-branding.sh [--check]" >&2
    exit 2
    ;;
esac

die() {
  echo "generate-branding: $*" >&2
  exit 1
}

[ -x "$TAURI" ] || die "tauri CLI not found at $TAURI — run 'bun install' in gui/ first"
command -v node >/dev/null 2>&1 || die "node not found on PATH (node_modules/.bin/tauri is a '#!/usr/bin/env node' script)"
command -v bun >/dev/null 2>&1 || die "bun not found on PATH (runs icns-canonical.ts)"
command -v sips >/dev/null 2>&1 || die "sips not found — this pipeline renders the non-square DMG background with macOS sips"
for src in master.svg tray-template.svg dmg-background.svg; do
  [ -f "$BRAND/$src" ] || die "source $BRAND/$src is missing"
done

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/b22-branding.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# 1. The full icon set from the master. The CLI also emits android/ and ios/ trees; they are
#    generated into scratch and deliberately never shipped (no mobile target exists). Every
#    renderer call captures stderr and surfaces it on failure — a swallowed tool error would
#    leave only "failed" with the actual cause discarded.
"$TAURI" icon "$BRAND/master.svg" -o "$SCRATCH/set" >/dev/null 2>"$SCRATCH/render-err" ||
  die "tauri icon failed on master.svg: $(cat "$SCRATCH/render-err")"

# 2. Canonicalise the ICNS element order (fails loudly on any shape it does not understand).
bun "$GUI/scripts/icns-canonical.ts" "$SCRATCH/set/icon.icns"

# 3. The 1024 master raster — the committed branding/about asset.
"$TAURI" icon "$BRAND/master.svg" -o "$SCRATCH/m" -p 1024 >/dev/null 2>"$SCRATCH/render-err" ||
  die "tauri icon failed rendering the 1024 master raster: $(cat "$SCRATCH/render-err")"

# 4. The menubar TEMPLATE icons at the measured 18pt: 18px @1x, 36px @2x (§14b dev 146).
"$TAURI" icon "$BRAND/tray-template.svg" -o "$SCRATCH/tray" -p 18 -p 36 >/dev/null 2>"$SCRATCH/render-err" ||
  die "tauri icon failed rendering the tray templates: $(cat "$SCRATCH/render-err")"

# 5. The DMG background: @1x at the SVG's declared 660×400, @2x from the same file with the
#    HEADER's width/height doubled — line 1 only. The same tokens also appear on the background
#    rect, which stays in the 660×400 user-unit space the viewBox pins (measured: the render is
#    byte-identical whether or not the rect is doubled). Rewrite and guard are BOTH anchored to
#    the header: the guard proves the CANVAS declaration was rewritten, where an unanchored
#    whole-file cmp passed as long as ANY occurrence changed — a reordered header would have
#    shipped a 660×400 render as "@2x".
sips -s format png "$BRAND/dmg-background.svg" --out "$SCRATCH/dmg.png" >/dev/null 2>"$SCRATCH/render-err" ||
  die "sips failed on dmg-background.svg: $(cat "$SCRATCH/render-err")"
sed '1s/width="660" height="400"/width="1320" height="800"/' "$BRAND/dmg-background.svg" \
  >"$SCRATCH/dmg2x.svg"
head -n 1 "$SCRATCH/dmg2x.svg" | grep -q 'width="1320" height="800"' ||
  die "dmg-background.svg's header (line 1) no longer declares width=\"660\" height=\"400\" — update the @2x rewrite together with the canvas"
sips -s format png "$SCRATCH/dmg2x.svg" --out "$SCRATCH/dmg@2x.png" >/dev/null 2>"$SCRATCH/render-err" ||
  die "sips failed on the doubled dmg-background svg: $(cat "$SCRATCH/render-err")"

# The full derived set, enumerated (no globs: a CLI update that changes its output set must be
# SEEN here, not silently shipped). source-in-scratch → committed destination.
PAIRS=(
  "set/32x32.png:$ICONS/32x32.png"
  "set/64x64.png:$ICONS/64x64.png"
  "set/128x128.png:$ICONS/128x128.png"
  "set/128x128@2x.png:$ICONS/128x128@2x.png"
  "set/icon.png:$ICONS/icon.png"
  "set/StoreLogo.png:$ICONS/StoreLogo.png"
  "set/Square30x30Logo.png:$ICONS/Square30x30Logo.png"
  "set/Square44x44Logo.png:$ICONS/Square44x44Logo.png"
  "set/Square71x71Logo.png:$ICONS/Square71x71Logo.png"
  "set/Square89x89Logo.png:$ICONS/Square89x89Logo.png"
  "set/Square107x107Logo.png:$ICONS/Square107x107Logo.png"
  "set/Square142x142Logo.png:$ICONS/Square142x142Logo.png"
  "set/Square150x150Logo.png:$ICONS/Square150x150Logo.png"
  "set/Square284x284Logo.png:$ICONS/Square284x284Logo.png"
  "set/Square310x310Logo.png:$ICONS/Square310x310Logo.png"
  "set/icon.icns:$ICONS/icon.icns"
  "set/icon.ico:$ICONS/icon.ico"
  "tray/18x18.png:$ICONS/tray-template.png"
  "tray/36x36.png:$ICONS/tray-template@2x.png"
  "m/1024x1024.png:$BRAND/icon-1024.png"
  "dmg.png:$BRAND/dmg-background.png"
  "dmg@2x.png:$BRAND/dmg-background@2x.png"
)

# EVERY source must exist before ANY destination is rewritten — a missing source (a CLI whose
# output set changed) must leave zero committed files touched, not a half-rewritten icons/
# tree that looks regenerated.
for pair in "${PAIRS[@]}"; do
  src="$SCRATCH/${pair%%:*}"
  [ -f "$src" ] || die "expected generated file $src is missing — the tauri CLI's output set changed; update PAIRS deliberately"
done

FAILED=0
for pair in "${PAIRS[@]}"; do
  src="$SCRATCH/${pair%%:*}"
  dest="${pair#*:}"
  if [ "$MODE" = "--check" ]; then
    if ! cmp -s "$src" "$dest"; then
      echo "generate-branding --check: MISMATCH: $dest" >&2
      FAILED=1
    fi
  else
    cp "$src" "$dest"
  fi
done

if [ "$MODE" = "--check" ]; then
  [ "$FAILED" -eq 0 ] || die "--check failed: committed assets differ from what the sources regenerate"
  echo "generate-branding --check: all ${#PAIRS[@]} derived assets are byte-identical to a fresh regeneration"
else
  echo "generate-branding: wrote ${#PAIRS[@]} derived assets"
fi
