# Installing daily-briefing

Every download is on the [latest release](https://github.com/themarigold/daily-briefing/releases/latest)
page. Pick one row:

| You have | Get | Section |
| --- | --- | --- |
| A Mac, and want the desktop app | `daily-briefing-<version>-darwin-arm64.dmg` (Apple silicon) or `daily-briefing-<version>-darwin-x64.dmg` (Intel) | [macOS: the desktop app](#macos-the-desktop-app) |
| Linux (x86_64), and want the desktop app | `daily-briefing-<version>-linux-x86_64.AppImage`, or `daily-briefing_<version>_amd64.deb` for Debian and Ubuntu | [Linux: the AppImage](#linux-the-appimage), [Linux: the .deb](#linux-the-deb) |
| Homebrew, and want the command-line tool | `brew install themarigold/tap/daily-briefing` | [Homebrew](#homebrew-macos-and-linux) |
| Any platform, and want just the command-line tool | `daily-briefing-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64` or `-windows-x64.exe` | [The command-line binary](#the-command-line-binary) |
| Windows | the command-line binary only, experimental | [Windows](#windows-command-line-binary-only-experimental) |

`<version>` is the release number without its `v`, for example `0.2.0`. The desktop app and the
command-line tool are the same engine: the app bundles it, and both read the same config. You do not
need both.

## Requirements

- **git**, on your `PATH`. The briefing is built from your local git history.
- **An AI to write the briefing**, one of:
  - an installed, logged-in AI coding command-line tool: `claude` (the default) or `codex`;
  - an API key for Anthropic or for an OpenAI-compatible service. The desktop app's setup offers
    the Anthropic key only; an OpenAI-compatible service is set up from the command line
    on a first install
    (`daily-briefing init --provider openai-compatible --model <id> --base-url <url>`) or in the config file;
  - a local model behind an OpenAI-compatible endpoint (Ollama, LM Studio). On this path the
    prompt never leaves your machine.

  [docs/PROVIDERS.md](PROVIDERS.md) says what each path needs.
- **macOS:** the desktop app has been tested on macOS 26 (Tahoe). The first-open steps below cover
  macOS 15 and later; earlier versions are untested.
- **Linux:** x86_64 for the desktop app. It is built on Ubuntu 22.04, so it needs that release's glibc
  and WebKitGTK 4.1 or newer. The command-line binary also ships for arm64.

## Verify the download

Every release asset is listed in `SHA256SUMS`. Download it into the same folder, then:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing     # macOS
sha256sum -c SHA256SUMS --ignore-missing         # Linux
```

Every file you downloaded must report `OK`. Do not run one that does not.

## macOS: the desktop app

1. Open the `.dmg` and drag **Daily Briefing** into **Applications**.
2. Open Daily Briefing from Applications. The first time, macOS refuses with a dialog titled
   **"Daily Briefing" Not Opened**, saying Apple could not verify it is free of malware. Click **Done**.
3. Open **System Settings › Privacy & Security**, scroll down to the message about Daily Briefing, and
   click **Open Anyway**. Confirm, entering your password if asked. The app opens, and from then on it
   opens normally.

On macOS 14 and earlier (untested here), Apple documents right-clicking the app and choosing **Open**
as the way past this check. On macOS 15 and later that shortcut no longer bypasses it, so use
**Open Anyway**.

If **Open Anyway** does not appear, or macOS says the app "is damaged and can't be opened", clear the
download's quarantine flag in Terminal (after checking the download, above):

```sh
xattr -dr com.apple.quarantine "/Applications/Daily Briefing.app"
```

**Why this happens.** The app is ad-hoc signed and not notarized. Notarization needs an Apple
Developer Program membership, and enrolling was deferred on 2026-09-29, so this release ships without
it. `spctl --assess` reports the app as `rejected`; that is expected for an app that is not notarized.
Two consequences are covered in [TROUBLESHOOTING](TROUBLESHOOTING.md):

- macOS asks for folder access again after each app update
  ([the per-update re-grant](TROUBLESHOOTING.md#macos-asks-for-folder-access-again-after-an-update));
- the app's login item, which its setup turns on by default, should be listed as "Daily Briefing";
  one created by an earlier version of the app is listed as "daily-briefing-gui" from an unidentified
  developer ([the login item](TROUBLESHOOTING.md#the-apps-login-item)).

**First run.** The app opens a short setup: which AI to use, which repositories, folder access (only
when a repository is in a protected folder such as Documents), whether to check GitHub for new versions
(No by default), the morning time, and background delivery, which installs the scheduler that writes the briefing each morning. Its last step also asks
whether the app should start when you log in (ticked by default; nothing is registered until you
press Finish). To use the same engine
from a terminal, open **Settings › This app › Command-line tool**; it links `daily-briefing` in
`/usr/local/bin` to the engine copy the scheduler runs.

## Homebrew (macOS and Linux)

Homebrew installs the command-line tool, not the desktop app:

```sh
brew install themarigold/tap/daily-briefing
daily-briefing init               # writes the config; see "First run" in the README
daily-briefing schedule install   # optional: deliver it every morning
```

## The command-line binary

Download your platform's binary and `SHA256SUMS`, check it, and run it. For example, on an Apple
silicon Mac (substitute your platform's asset name throughout), in `bash` or `zsh` (the `<(...)` below
is not POSIX `sh`):

```bash
curl -fsSLO https://github.com/themarigold/daily-briefing/releases/latest/download/daily-briefing-darwin-arm64
curl -fsSLO https://github.com/themarigold/daily-briefing/releases/latest/download/SHA256SUMS
shasum -a 256 -c <(grep ' daily-briefing-darwin-arm64$' SHA256SUMS)     # verify before running
chmod +x daily-briefing-darwin-arm64
./daily-briefing-darwin-arm64 init                    # writes the config template — edit it, then:
./daily-briefing-darwin-arm64 run
```

(The `grep` pattern, a leading space and a trailing `$`, matches that one file's line exactly and never a
longer asset name that contains it, so `shasum -c` checks just the file you downloaded.)

- **macOS quarantine:** a binary downloaded through a *browser* is quarantined and Gatekeeper will
  refuse it (the binaries are not notarized) — after verifying it against `SHA256SUMS` as above, clear
  it with `xattr -d com.apple.quarantine daily-briefing-darwin-arm64`. A `curl` download has no quarantine
  attribute, so the commands above run as-is.
- **Scheduled delivery** works from this binary too: `./daily-briefing-darwin-arm64 schedule install`
  copies the engine to a managed location and points the system scheduler at that copy, so you can
  move or delete the downloaded file afterwards.
- On Linux, config lives at `~/.config/daily-briefing/` and output at
  `~/.local/state/daily-briefing/` (`XDG_CONFIG_HOME` / `XDG_STATE_HOME` respected); on macOS, output
  is under `~/Library/Application Support/daily-briefing/` (the `run` output names the exact file).

### Scheduling it yourself

`daily-briefing schedule install` is the supported way to get a morning briefing. If you would rather
use your own scheduler (a `cron` job, a `systemd` user timer, Task Scheduler), call
`daily-briefing run` from it at or after your `morningTime`. `run` is a cheap no-op after the day's
briefing is delivered, so an aggressive schedule is safe; set `networkProbeHosts: []` if your provider
is local/offline.

## Linux: the AppImage

```sh
chmod +x daily-briefing-<version>-linux-x86_64.AppImage
./daily-briefing-<version>-linux-x86_64.AppImage
```

**FUSE.** An AppImage mounts itself with FUSE 2. If it exits with an error about FUSE or
`libfuse.so.2`, install the library (`sudo apt install libfuse2`; on Ubuntu 24.04 and later the
package is `libfuse2t64`), or run it without mounting:

```sh
./daily-briefing-<version>-linux-x86_64.AppImage --appimage-extract-and-run
```

The AppImage carries the engine as well as the app. Because its mount path changes on every launch,
the app's background delivery copies the engine to `~/.local/share/daily-briefing/bin/daily-briefing`
and schedules that copy, never a path inside the AppImage.

## Linux: the .deb

```sh
sudo apt install ./daily-briefing_<version>_amd64.deb
```

The `./` matters: without it, `apt` looks for a package of that name in its repositories. The package
installs the app as `daily-briefing-gui` and the engine as `daily-briefing`, both in `/usr/bin`, plus a
**Daily Briefing** entry in your applications menu.

## Windows (command-line binary only, experimental)

The command-line binary `daily-briefing-windows-x64.exe` is attached to the release, and it is
**experimental and untested**. There is no Windows desktop app in any release: its installer is built
in CI for information only and is never attached. `daily-briefing schedule install` on Windows writes
the Task Scheduler definition and prints the command, and registers it only with
`--confirm-experimental`.

## From a source checkout

You need [Bun](https://bun.sh) 1.3.14 or newer. From a source checkout (no build needed),
`daily-briefing` means `bun run src/main.ts`:

```sh
bun install --frozen-lockfile
bun run src/main.ts init
bun run src/main.ts run
```

On macOS, a source checkout can also install the morning agent itself:

- **Install the morning agent:** `bash scripts/install.sh` — builds a compiled binary into
  `~/Library/Application Support/daily-briefing/daily-briefing`, code-signs it with a **stable
  local self-signed identity** (created on demand into your login keychain, `Daily Briefing (local)
  Signing`) so macOS Gatekeeper doesn't block the unattended scheduled run **and** the folder-access
  grant persists across rebuilds, and loads a `launchd` agent that ticks every 10 minutes
  (`StartInterval` + `RunAtLoad`) and delivers on the first tick past your morning time (`morningTime`,
  default 07:20 — see [delivery timing](CONFIG.md#delivery-timing-in-full)). Re-run the script any
  time to rebuild and reload — the grant survives. (If no real `openssl` is available it degrades to an
  ad-hoc signature with a warning; hermetic/CI installs still succeed.)
- **Running the installed binary directly** (e.g. to re-run `init` or trigger a manual briefing
  after installing): it is **not** put on your `PATH` automatically, so either invoke it by full
  path — `"$HOME/Library/Application Support/daily-briefing/daily-briefing" init` /
  `... run --force` — or add `~/Library/Application\ Support/daily-briefing` to your `PATH` and
  use the bare `daily-briefing` command shown above.

Development setup, tests and the contribution rules are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## The desktop app and the command-line tool together

The desktop app is built **around** the command-line tool, not instead of it:

- **The app is optional, and the CLI is the engine.** The app bundles this same binary as a
  sidecar and speaks to it over argv + stdout; there is no second implementation of anything.
- **Same config, same state.** Both read `~/.config/daily-briefing/config.json` and share the
  state directory (`~/Library/Application Support/daily-briefing` on macOS). Installing the app
  changes neither path.
- **Nothing the app does changes briefing content.** With the app's files on disk,
  `daily-briefing run --force` output is byte-identical to a machine that never installed it,
  `briefing.log` still accumulates in the format the audit reads, and `bun run audit` still
  grades the latest briefing — all asserted by a regression suite
  (`gui/tests-web/coexistence.check.ts`), not promised.
- **The once-per-day marker has exactly one writer: the engine**, inside `stampToday`, on a
  successful delivery only — never the app, never the installer, never the tray.
- **One scheduler at a time.** `<state>/schedule.json` records who owns the trigger; the app
  respects a CLI-owned schedule (and offers an explicit take-over rather than replacing it).
- **The app's uninstall removes the background scheduler first, and is otherwise bounded.** Its
  first step asks the engine to remove the background scheduler, the same way
  `daily-briefing schedule uninstall` does: the engine unregisters the job by its label, and deletes
  the scheduler's files and its `schedule.json` record only once its own check finds the job gone.
  A scheduler the app did not set up (one installed from the terminal, or one with no readable
  record of who set it up) is removed only if you choose **Remove it**. **Keep it running** is the
  default, and then the engine's data and your settings stay too, because a kept scheduler still
  runs the engine and needs them. After the scheduler, Uninstall removes the app's own login item
  and its own files. The engine's data goes only behind an explicit consent box that names the
  briefing archive, and the files it may remove there are the same list `bash scripts/uninstall.sh`
  deletes from the state directory (a test pins the two lists together); your settings go only
  behind a second box. If a scheduler's record or unit file is still there when those two steps
  run, they remove nothing, and the app says what is left and how to remove it. One scheduler the
  app cannot remove itself: on Linux, one installed from a terminal with `XDG_CONFIG_HOME` set keeps
  its `daily-briefing.service` and `.timer` under `$XDG_CONFIG_HOME/systemd/user`, and the engine
  the app runs looks only under `~/.config/systemd/user`. The app then names the unit file and the
  command that removes it: `daily-briefing schedule uninstall`, run with that `XDG_CONFIG_HOME`.

The developer-facing contract lives in [docs/gui-seam.md](gui-seam.md) (§16 for
coexistence and uninstall).

## Where things live

| What | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Config | `~/.config/daily-briefing/config.json` | `~/.config/daily-briefing/config.json` (`$XDG_CONFIG_HOME`) | `%USERPROFILE%\.config\daily-briefing\config.json` |
| State: briefings, logs, the day's record | `~/Library/Application Support/daily-briefing/` | `~/.local/state/daily-briefing/` (`$XDG_STATE_HOME`) | `%LOCALAPPDATA%\daily-briefing\` |
| The latest briefing | `<state>/briefing-latest.md` | `<state>/briefing-latest.md` | `<state>\briefing-latest.md` |
| The engine copy the scheduler runs | `<state>/daily-briefing` | `~/.local/share/daily-briefing/bin/daily-briefing` (`$XDG_DATA_HOME`) | `<state>\daily-briefing.exe` |
| The scheduler | `~/Library/LaunchAgents/local.daily-briefing.plist` | `~/.config/systemd/user/daily-briefing.service` and `.timer` | the `DailyBriefing` task |
| The app's login item | `~/Library/LaunchAgents/Daily Briefing.plist` | `~/.config/autostart/Daily Briefing.desktop` | — |
| The app's own files | `~/Library/Application Support/com.themarigold.daily-briefing/` | `~/.local/share/com.themarigold.daily-briefing/` and `~/.config/com.themarigold.daily-briefing/` | — |

`DAILY_BRIEFING_STATE_DIR`, when set, replaces the state folder everywhere.

## Uninstall

Remove the schedule first, then the program, then (if you want) your data. The desktop app's
Uninstall does the first step itself.

1. **The schedule.** In the app: the Schedule screen's **Remove background scheduler…**, or let
   Uninstall (step 2) remove it. From a terminal: `daily-briefing schedule uninstall`. Either way the
   engine unregisters the job by its label, checks that it is gone, and only then deletes the
   scheduler's files and its `schedule.json` record, so it reports "Removed the background
   scheduler." only once the job is gone. It leaves the engine copy in place. From a terminal it also
   removes a schedule with no readable record of who set it up, and it refuses one the desktop app set
   up unless you add `--take-over`. When it cannot finish — the job is still registered, or the check
   cannot run (over SSH, with no desktop session; on Linux, with your user's systemd manager out of
   reach) — it deletes nothing more, says why and what, if anything, it removed, and prints the
   steps to finish by hand
   ([Removing the background scheduler by hand](TROUBLESHOOTING.md#removing-the-background-scheduler-by-hand)).
2. **The program.**
   - **Desktop app (macOS and Linux):** **Settings › This app › Uninstall** shows what it will do,
     then removes, in this order: the background scheduler the app set up; the app's login item; with
     the first box ticked, the engine's data (your whole briefing archive and its log, and the
     background engine copy, which on Linux is `~/.local/share/daily-briefing/bin/daily-briefing`);
     with the second box ticked, your settings (the API key file they name when it sits in the
     settings folder, then `config.json` and its backup `config.json.bak`, then the folder itself if
     that leaves it empty); and the app's own files. Both boxes are off by default. It usually takes
     under a minute, and at most about two.
     - A scheduler the app did not set up (from the terminal, or with nothing recording who set it
       up) is removed only if you choose **Remove it**. **Keep it running** is preselected, and keeping
       it also keeps the engine's data and your settings, which that scheduler still needs.
     - If the scheduler cannot be removed or checked, Uninstall goes no further and shows the
       engine's message, which says what, if anything, it removed, with **Try again** and
       **Uninstall anyway**. **Uninstall anyway** returns to the Uninstall screen with the scheduler
       kept and says what that keeps; press the Uninstall button there to go ahead. If another
       engine task is running, it removes nothing and offers **Try again**.
     - The last screen lists what was removed and, under **Still on this machine**, what stays: a
       kept scheduler with the steps to remove it yourself, the settings folder when its box was not
       ticked, and anything that could not be removed.

     Then remove the app itself: on macOS, move Daily Briefing from Applications to the Trash; on
     Linux, the .deb or AppImage step below.
   - **The command-line link, if you made one** (**Settings › This app › Command-line tool**):
     Uninstall does not remove `/usr/local/bin/daily-briefing`, and once the engine copy is gone the
     link points at nothing. Remove it first with **Remove command-line tool** in the same place; when
     that needs administrator rights, the app shows the `sudo rm` command to run. If the app is already
     gone, `ls -l /usr/local/bin/daily-briefing` shows where the link points; when that is the engine
     copy (in the state folder on macOS, under `~/.local/share/daily-briefing/` on Linux), delete the
     link with `sudo rm /usr/local/bin/daily-briefing`.
   - **Homebrew:** `brew uninstall daily-briefing`.
   - **The command-line binary:** delete the file you downloaded.
   - **The .deb:** `sudo apt remove daily-briefing`.
   - **The AppImage:** delete the `.AppImage` file.
   - **After the .deb or AppImage:** neither step touches your home folder. If you did not run the
     app's Uninstall first, delete its login item, `~/.config/autostart/Daily Briefing.desktop`, or it
     stays behind pointing at a program that is gone. The Uninstall leaves the app's two folders in
     place either way: delete `~/.local/share/com.themarigold.daily-briefing/` and
     `~/.config/com.themarigold.daily-briefing/` too if you want nothing of the app left.
   - **A source checkout on macOS:** see below.
3. **Your data, if you want it gone too:** delete the state folder and `~/.config/daily-briefing/`.
   The state folder holds your past briefings and the logs, and on macOS and Windows also the engine
   copy the scheduler ran. On Linux that copy is outside it, in `~/.local/share/daily-briefing/`
   (`$XDG_DATA_HOME`): delete that folder as well. Paths are in the table above.

### A source checkout on macOS

Run `bash scripts/uninstall.sh`. It deals with the background scheduler first, and only then
removes the installed binary, the log, the latest-briefing file and the rest of the engine's files
in the state folder (the same list as the desktop app's engine-data box). It never unregisters the
scheduler or deletes its files itself: it asks the installed engine to, and when that cannot be
done it **stops, having removed nothing itself**.

- **With an engine new enough to remove its own scheduler** (the installed `daily-briefing` is an
  executable file that contains the text `removeSteps`, and its `schedule status --json` reports
  `removeSteps`), the script runs that engine's `schedule uninstall`, with or without a schedule
  record. It carries on when the engine removed the scheduler, or reported nothing installed with
  nothing on disk saying otherwise. If the desktop app owns the scheduler, it refuses, because the
  app's scheduler runs the very binary the script would delete: remove it on the app's Schedule
  screen (**Remove background scheduler…**), then run the script again; if the app is already gone,
  the message gives the `schedule uninstall --take-over` command to run first. If the engine cannot
  finish, the script prints the engine's message, which ends with the steps to finish by hand, and
  stops.
- **Without one** (the installed engine is missing, not executable, too old, or could not report its
  status), the script never asks it to remove anything: an older engine's `schedule uninstall` does
  not check that the job is gone. With a schedule record or the `launchd` agent file on disk, the
  script stops and prints the steps to remove the scheduler by hand (for a record the desktop app set
  up, it first points you to the app's Schedule screen). Updating the engine with
  `scripts/install.sh` also gets you past this, but that re-installs the background schedule and may
  generate a briefing. With neither on disk, it asks `launchd` once, read-only, whether
  `local.daily-briefing` is still loaded, and carries on only when `launchd` says it is not.

The script keeps your settings folder, `~/.config/daily-briefing`, and says so: it may hold your API
key file. Removing it is the desktop app's settings box, or yours by hand (step 3 above).

`bash scripts/uninstall.sh --remove-signing-identity` also deletes the `Daily Briefing (local) Signing`
identity from your login keychain. It is opt-in, and it refuses while a schedule record still exists,
because the scheduled engine is signed with that identity.

> **Upgrading from a pre-StartInterval build?** An early build used a repeating `pmset` wake for
> delivery (since replaced by the interval agent). If you ran that, an orphaned daily wake may still be
> armed — check with `pmset -g sched` and clear it with `sudo pmset repeat cancel`. Install/uninstall
> now detect a repeating schedule and remind you (they don't auto-cancel it — that needs `sudo` and
> would clear *all* your repeat schedules).
