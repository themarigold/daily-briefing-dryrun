#!/usr/bin/env bash
# stage-bundles.sh — copy Tauri's bundle outputs into the FROZEN release asset names (Phase E, E2).
#
# Tauri names its artifacts `<productName>_<version>_<arch>.<ext>` ("Daily Briefing_0.1.1_aarch64.dmg"):
# a space, capitals, and Tauri's own arch words. The release attaches lowercase hyphenated names
# instead (docs/RELEASE.md §Assets is the frozen table), so this script is the ONE place the two
# vocabularies meet. It copies (never moves): the bundle tree stays as Tauri left it, so the size gate
# and the smoke step can still read the .app beside the DMG.
#
# Usage: bash scripts/stage-bundles.sh <bundle-dir> <version> <out-dir> <kinds>
#   <bundle-dir>  Tauri's bundle root, e.g. src-tauri/target/<triple>/release/bundle
#                 (tauri-cli `get_target_dir`: target/<triple>/<profile>; the bundler then writes
#                 bundle/{dmg,macos,deb,appimage}/)
#   <version>     plain semver (X.Y.Z), the version the bundle was built at
#   <out-dir>     created if absent; an existing file of the same frozen name is refused
#   <kinds>       a comma list of dmg | appimage | deb (the macOS legs pass `dmg`, Linux `appimage,deb`)
#
# For each kind the glob is BY VERSION (`dmg/*_<version>_*.dmg`), so stale outputs of another version
# in a reused tree never count. Exactly one match per kind, else exit 1 naming the kind: zero means the
# build did not produce it, two means the tree is ambiguous and guessing would ship the wrong file.
#
# Arch mapping, from the bundler sources (tauri-bundler 2.9.4):
#   dmg       macos/dmg/mod.rs          aarch64 -> arm64, x64 -> x64   (universal: refused)
#   appimage  linux/appimage/*.rs       amd64   -> x86_64              (others: refused)
#   deb       linux/debian.rs           amd64   -> amd64               (others: refused)
# Only the arches this release ships are mapped; anything else is an error, never a passthrough.
set -euo pipefail

die() { echo "stage-bundles: $*" >&2; exit 1; }

[ "$#" -eq 4 ] || die "usage: stage-bundles.sh <bundle-dir> <version> <out-dir> <kinds>"
BUNDLE_DIR="$1"
VERSION="$2"
OUT_DIR="$3"
KINDS="$4"

# Plain semver only. There is no RC form (docs/RELEASE.md), and the value is spliced into a glob.
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "version '$VERSION' is not plain semver X.Y.Z (no leading v, no suffix)"
[ -d "$BUNDLE_DIR" ] || die "bundle dir '$BUNDLE_DIR' does not exist"
[ -n "$KINDS" ] || die "no kinds given (expected dmg, appimage, deb, comma-separated)"

# Validate every kind before copying anything, so a typo cannot leave a half-staged out-dir.
IFS=',' read -r -a KIND_LIST <<<"$KINDS"
SEEN=","
for kind in "${KIND_LIST[@]}"; do
  case "$kind" in
    dmg|appimage|deb) ;;
    *) die "unknown kind '$kind' (expected dmg, appimage, deb)" ;;
  esac
  case "$SEEN" in *",$kind,"*) die "kind '$kind' given twice" ;; esac
  SEEN="$SEEN$kind,"
done

# kind -> subdirectory and extension in Tauri's bundle tree.
subdir_for() { case "$1" in dmg) echo dmg ;; appimage) echo appimage ;; deb) echo deb ;; esac; }
ext_for() { case "$1" in dmg) echo dmg ;; appimage) echo AppImage ;; deb) echo deb ;; esac; }

# kind + Tauri arch word -> frozen asset name; non-zero for an arch this release does not ship.
frozen_name() {
  local kind="$1" arch="$2"
  case "$kind:$arch" in
    dmg:aarch64)     echo "daily-briefing-${VERSION}-darwin-arm64.dmg" ;;
    dmg:x64)         echo "daily-briefing-${VERSION}-darwin-x64.dmg" ;;
    appimage:amd64)  echo "daily-briefing-${VERSION}-linux-x86_64.AppImage" ;;
    deb:amd64)       echo "daily-briefing_${VERSION}_amd64.deb" ;;
    *) return 1 ;;
  esac
}

mkdir -p "$OUT_DIR"

# Resolve every kind first (exactly one source, a mapped arch, a free destination), then copy, so a
# failure on the second kind never leaves the first one staged.
SOURCES=()
DESTS=()
for kind in "${KIND_LIST[@]}"; do
  sub="$(subdir_for "$kind")"
  ext="$(ext_for "$kind")"
  matches=()
  shopt -s nullglob
  for f in "$BUNDLE_DIR/$sub/"*"_${VERSION}_"*".$ext"; do
    [ -f "$f" ] && matches+=("$f")
  done
  shopt -u nullglob
  [ "${#matches[@]}" -ne 0 ] || die "$kind: no $sub/*_${VERSION}_*.$ext under $BUNDLE_DIR"
  [ "${#matches[@]}" -eq 1 ] || die "$kind: ${#matches[@]} files match $sub/*_${VERSION}_*.$ext under $BUNDLE_DIR (expected exactly 1): ${matches[*]}"
  src="${matches[0]}"
  base="$(basename "$src" ".$ext")"
  arch="${base##*_"${VERSION}"_}"
  dest_name="$(frozen_name "$kind" "$arch")" \
    || die "$kind: arch '$arch' in '$(basename "$src")' is not one this release ships"
  [ ! -e "$OUT_DIR/$dest_name" ] || die "$kind: $OUT_DIR/$dest_name already exists (refusing to overwrite)"
  SOURCES+=("$src")
  DESTS+=("$OUT_DIR/$dest_name")
done

i=0
while [ "$i" -lt "${#SOURCES[@]}" ]; do
  cp "${SOURCES[$i]}" "${DESTS[$i]}"
  echo "stage-bundles: ${SOURCES[$i]} -> ${DESTS[$i]}"
  i=$((i + 1))
done
