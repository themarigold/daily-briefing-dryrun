#!/usr/bin/env bash
# reader/build.sh — build "Daily Briefing Calendar Reader.app" (v0.3.0 calendar connection, plan p4 M10a/M11).
#
# Usage: bash reader/build.sh [<output folder>]      (default: reader/build)
#
# macOS only (Xcode command-line tools). Builds the helper UNIVERSAL — arm64 and x86_64, macOS 14 or later — and
# fails unless `lipo -archs` reports both. The bundle is ad-hoc signed here so it is never unsigned nested code
# inside the desktop app; the engine re-signs its installed copy with the stable local identity
# (`calendar connect mac`), and that copy's signature is the one macOS's Calendars permission is tied to.
#
# Run by the public ci.yml's macOS job, by hand on a Mac (the private monorepo CI has no macOS job: user decision
# 2026-10-12), and by every macOS bundle leg of the release workflow before `tauri build`, which ships the result in the app's Contents/Resources
# (gui/src-tauri/tauri.macos.conf.json `bundle.macOS.files`).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/build}"
NAME="Daily Briefing Calendar Reader"
APP="$OUT/$NAME.app"
MIN_OS="14.0"

[ "$(uname -s)" = "Darwin" ] || { echo "reader/build.sh: macOS only" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for arch in arm64 x86_64; do
  xcrun --sdk macosx swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN_OS" \
    -framework EventKit -o "$WORK/$arch" "$HERE"/Sources/*.swift
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
lipo -create -output "$APP/Contents/MacOS/$NAME" "$WORK/arm64" "$WORK/x86_64"
chmod 755 "$APP/Contents/MacOS/$NAME"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

archs="$(lipo -archs "$APP/Contents/MacOS/$NAME")"
case " $archs " in *" arm64 "*) ;; *) echo "reader/build.sh: no arm64 slice (lipo -archs: $archs)" >&2; exit 1 ;; esac
case " $archs " in *" x86_64 "*) ;; *) echo "reader/build.sh: no x86_64 slice (lipo -archs: $archs)" >&2; exit 1 ;; esac

codesign --force --sign - --timestamp=none --identifier local.daily-briefing.calendar "$APP"
codesign --verify --strict "$APP"
echo "built $APP ($archs)"
