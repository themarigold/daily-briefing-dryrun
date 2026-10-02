<!--# docs/release-notes.template.md: rendered by scripts/release-collect.sh into the GitHub release notes. -->
<!--# Syntax (the whole of it): lines starting with the four characters "<!--#" are template comments and are dropped; -->
<!--# an "if:NAME" / "end:NAME" HTML-comment pair on its own lines keeps or drops the lines between them -->
<!--# (NAME is signed, unsigned or failed); {{NAME}} placeholders are substituted. A placeholder left -->
<!--# unsubstituted fails the render, so a typo here cannot ship as literal braces. -->
<!-- if:unsigned -->
> **⚠ UNSIGNED (ad-hoc) RELEASE.** The macOS app in this release is ad-hoc signed, not signed with a stable identity, and it is not notarized.
> Until the stable signing identity exists, **each app update needs the macOS folder-access grant again**: after you install an update, grant the app access to your protected folders (Documents, Desktop, Downloads, iCloud Drive) again when it asks, or in System Settings → Privacy & Security → Files and Folders.
<!-- end:unsigned -->

# daily-briefing v{{VERSION}}

## Verify before you run anything

Every file in this release is listed in `SHA256SUMS`. In the folder you downloaded into, run:

    shasum -a 256 -c SHA256SUMS --ignore-missing

(on Linux: `sha256sum -c SHA256SUMS --ignore-missing`). Every file you downloaded must report `OK`. Do not run a file that does not.

**Signing:** {{SIGNING_STATUS}}

## Command-line binaries

The engine as a single binary. Installing from source is still supported: see [docs/INSTALL.md](https://github.com/themarigold/daily-briefing/blob/main/docs/INSTALL.md#from-a-source-checkout).

{{CLI_ASSETS}}

## Desktop app

{{DESKTOP_ASSETS}}
<!-- if:failed -->

**Not in this release:** these desktop bundles failed to build and are not attached. The command-line binaries above are unaffected.

{{FAILED_LEGS}}
<!-- end:failed -->

**macOS first open (Gatekeeper).** The app is not notarized, so macOS blocks its first open. On macOS 15 and later the Finder's right-click → Open shortcut no longer bypasses this: try to open the app once, then go to System Settings → Privacy & Security and click **Open Anyway**. Alternatively, after copying the app to Applications, clear the quarantine flag in Terminal: `xattr -dr com.apple.quarantine "/Applications/Daily Briefing.app"`.
<!-- if:signed -->

The macOS app is signed with the project's stable self-signed identity (not an Apple Developer ID).
<!-- end:signed -->

**Windows:** `daily-briefing-windows-x64.exe` is experimental. There is no Windows desktop installer in this release ({{WINDOWS_STATUS}}).
