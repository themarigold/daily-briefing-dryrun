#!/bin/sh
# /usr/bin/daily-briefing inside the AppImage ONLY: a launcher for the engine, which the AppImage
# carries at /usr/libexec/daily-briefing/daily-briefing (gui/src-tauri/tauri.linux.conf.json,
# bundle.linux.appimage.files). The .deb never uses this file; it ships the engine itself at
# /usr/bin/daily-briefing.
#
# Why it exists: linuxdeploy, which assembles the AppImage, sets an RPATH on every ELF file directly
# in usr/bin, and that rewrite broke the Bun-compiled engine (it segfaulted; M2b probe, 2026-10-01).
# linuxdeploy skips files that are not ELF and never looks in usr/libexec, so the engine stays
# byte-identical there, while the GUI still finds an executable beside its own binary, where it looks.
#
# readlink -f resolves every symlink, so a link to this file from anywhere still finds the engine.
# exec replaces this shell: the engine runs as itself, and its process.execPath is the real binary.
self=$(readlink -f -- "$0") || { echo "daily-briefing: cannot resolve $0" >&2; exit 127; }
exec "${self%/*}/../libexec/daily-briefing/daily-briefing" "$@"
