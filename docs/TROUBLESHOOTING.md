# Troubleshooting

Two commands answer most questions. Neither generates a briefing.

```sh
daily-briefing schedule status     # is the scheduler installed, did it fire today, why did it skip?
daily-briefing doctor --json       # is the config valid, which repos can be read, is the AI found?
```

`doctor --json` prints JSON only. The fields to read first: `config.valid` and `config.errors`;
`repos` (each with `ok`, and `advice` when it is not; a partial clone also carries `partialClone`
and a note, because git may download missing file contents from that repository's own remote while
the tool reads it) and `discoveredCount`; `provider.found` and `provider.path`. It is built never to print an API key, but it is not anonymous: it lists the full path
of every repository it checked, which shows your username and the names of your repositories (private
ones included), and it prints `provider.path` and, for an API provider, the endpoint and where the key
is read from. Read it before you share it, and redact anything you would not post publicly.

In the desktop app the same checks run behind the Schedule screen and the setup's last step.

## The briefing is empty, or no repos were found

The briefing says `(no commits in the window)`, or `doctor --json` shows `discoveredCount: 0`.

- **No `repos` list, and nothing found under `discoverRoots`.** Discovery looks in each folder, its
  children and its grandchildren, and no deeper. `init` uses the folder you ran it from and your home
  folder, so repositories three or more levels down (for example `~/work/clients/acme/api`) are not
  found. List them under [`repos`](CONFIG.md#repos) instead; an explicit list is also faster.
- **A path that does not exist.** `init` and the run both print `skipped: path not found — …`. Paths
  must be absolute: a scheduled run does not start in your home folder, so a relative path resolves
  somewhere else.
- **Repositories in a protected folder on macOS** (Desktop, Documents, Downloads, iCloud Drive). See
  [the next section](#macos-repos-in-protected-folders-desktop--documents--downloads--icloud).
- **Commits made under another email.** Only your own commits count, matched by
  [`author`](CONFIG.md#author) or, when that is not set, by each repository's `git config user.email`.
  Add every email you commit with to `author.emails`.
- **Excluded on purpose.** [`excludeRepos`](CONFIG.md#excluderepos) drops repositories and
  [`excludeCommitPatterns`](CONFIG.md#excludecommitpatterns) drops commits by subject.
- **Nothing since the last working day.** The briefing looks back at most
  [`lookbackCapDays`](CONFIG.md#lookbackcapdays) days (default 4) for your last day with commits.

**Commits from this morning are missing.** "What you did" stops at midnight; today's commits are in
"Today so far". The day's briefing is generated once, so to pick up commits made after it, run
`daily-briefing run --force`.

## macOS: repos in protected folders (Desktop / Documents / Downloads / iCloud)

macOS gates reads of `~/Desktop`, `~/Documents`, `~/Downloads`, and iCloud Drive behind TCC
(Transparency, Consent & Control). If any of your repos live there, the **scheduled** run has
**no window to show a permission prompt** — it is denied silently, and those repos would just
appear empty. This tool guards against that:

- `daily-briefing init` runs a **preflight** that reports any repo — or `discoverRoots` folder — it
  can't read, so you can fix access before the first unattended run.
- If a repo it **tried to read** is blocked and nothing else turned up, the run does **not** mark
  the day done: it exits non-zero and prints the fix, so the next run retries once access is
  granted (it never silently "uses up" the day with an empty briefing). This covers any block —
  TCC *or* ordinary permissions — on a configured/discovered repo, even a partial one.
- A folder it was still **scanning** for repos (a `discoverRoots` entry with no explicit `repos`)
  is reported as a *warning* rather than blocking the day — otherwise a machine with no repos there
  would error every morning forever. When the briefing has no commits in the window, it names those
  folders and says where to allow access. The one exception: if **no repository is found at all** and
  a folder you **listed** in `discoverRoots` (Folders to search, in the app) itself can't be read or
  doesn't exist, the run does not mark the day done, so it delivers the same day once access is
  granted. A folder merely reached while scanning (`~/Desktop` under `~`) never holds the day. So if
  your repos live under a protected folder, either grant access or list them explicitly under `repos`
  (which `init` does for you once access is granted).

**To grant access:** System Settings → Privacy & Security → **Files & Folders** (enable the
folders for the `daily-briefing` binary), or **Full Disk Access** for the broad fix. Add the
**binary itself** (`~/Library/Application Support/daily-briefing/daily-briefing`) — granting your
terminal isn't enough for the scheduled `launchd` run, whose principal is the binary. Or simply
keep your repos outside those folders.

In the Full Disk Access list, click **+**, press **⌘⇧G**, paste the path above and choose the file.
The desktop app's folder-access step can reveal the file in Finder for you.

> **Grant persists across updates.** `scripts/install.sh` signs the binary with a **stable local
> self-signed identity** (`Daily Briefing (local) Signing`, created once into your login keychain),
> giving it a fixed designated requirement. macOS keys the Full Disk Access / Files-&-Folders grant
> to that identity, so re-running `install.sh` to rebuild **keeps** the grant — you grant access once.
> (If the identity can't be created — no real `openssl` — install falls back to an ad-hoc signature,
> and macOS may re-prompt after each rebuild until you install `openssl` and re-run.) A Developer ID
> signature would additionally clear Gatekeeper for redistribution, but this release has none:
> enrolling in the Apple Developer Program was deferred on 2026-09-29, so the desktop app ships
> ad-hoc signed and not notarized.

`daily-briefing schedule install` signs the engine copy it makes with the same local identity, so
the same holds whichever way you installed. If it printed `could not create/find a stable signing
identity`, install OpenSSL (`brew install openssl@3`) and run `schedule install` again.

### Two grants: the app, and the engine it schedules

With the desktop app, macOS sees two separate programs, and each needs its own grant:

| Who reads your repos | When | Grant it to |
| --- | --- | --- |
| The app, **Daily Briefing** | a briefing you start from the app's window | the app, when it asks, or under Files & Folders |
| The engine copy, `~/Library/Application Support/daily-briefing/daily-briefing` | every scheduled morning run | the engine copy, under Full Disk Access (or Files & Folders) |

The app's setup guides you through both whenever a repository is in a protected folder. Granting one
does not grant the other.

### The command-line tool has its own grants too

A run you start by typing `daily-briefing …` in a terminal reads your repos as your **terminal app**
(Terminal, iTerm, …), so it works once the terminal has access, while the scheduled run of the same
config still fails until the engine copy has its own grant. That is why a manual run can succeed and
the 07:20 run come back empty. Grant the engine copy as above.

### Starting over: resetting a grant

macOS sometimes keeps a stale entry that no longer matches the program. To clear the app's grants and
be asked again on next use:

```sh
tccutil reset All com.themarigold.daily-briefing
```

The engine copy is a plain program rather than an app bundle, so remove its entry from Full Disk Access
(select it, click **−**) and add it again. `tccutil reset SystemPolicyAllFiles` with no identifier
resets Full Disk Access for **every** app on your Mac; use it only if you are ready to re-grant them all.

## macOS asks for folder access again after an update

Expected while the app is ad-hoc signed. macOS ties an ad-hoc-signed app's folder-access grant to that
exact build, so every app update starts without it. After you install an update, grant the app access
to your protected folders again, when it asks or in **System Settings › Privacy & Security › Files and
Folders**. After an update the app checks whether a protected folder is in use and tells you if it
needs the grant again. This ends once releases are signed with a stable identity.

The scheduled engine copy is not affected the same way: it is re-signed with your local identity each
time `schedule install` refreshes it (see above). When `daily-briefing schedule status` shows
`engine skew`, refresh that copy from the side that owns the schedule (its `owner:` line): for `app`,
click **Update background engine** on the app's Schedule screen; for `cli`, run
`daily-briefing schedule install`. A `schedule install` from the terminal is refused for an app-owned
schedule.

## macOS: "Not Opened", "damaged", or "cannot be opened"

These come from Gatekeeper, which checks every app and program downloaded from the internet. Your
browser marks each download with a **quarantine** flag (`com.apple.quarantine`), and Gatekeeper
checks quarantined files on first open.

- **"Daily Briefing" Not Opened** (macOS 15 and later): the app is not notarized. Click **Done**, then
  **System Settings › Privacy & Security › Open Anyway**. Step by step:
  [INSTALL](INSTALL.md#macos-the-desktop-app).
- **"cannot be opened because the developer cannot be verified"** (macOS 14 and earlier, untested
  here): Apple's documented way past it is to right-click the app, choose **Open**, then **Open** again.
- **"is damaged and can't be opened"**: first check the download against `SHA256SUMS`
  ([how](INSTALL.md#verify-the-download)); download it again if it does not match. If it matches,
  clear the quarantine flag:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Daily Briefing.app"
  ```

- **The command-line binary** downloaded with a browser is refused the same way:
  `xattr -d com.apple.quarantine daily-briefing-darwin-arm64` (use your file's name). A `curl`
  download carries no quarantine flag. `schedule install` clears the flag on the engine copy it makes.

## macOS: the command-line binary or the app's engine stops with "illegal instruction"

On an Apple-silicon Mac, use the arm64 builds: `daily-briefing-darwin-arm64` for the command-line tool
and `daily-briefing-<version>-darwin-arm64.dmg` for the app. The x64 builds are for Intel Macs: the
`daily-briefing-darwin-x64` binary, and the Intel app (`…-darwin-x64.dmg`), whose bundled engine is
built for the same Intel target. Run under Rosetta on macOS 14, an x64 engine can stop at once with an
illegal-instruction error (SIGILL). `uname -m` prints `x86_64` in a terminal that is itself running
under Rosetta.

## "CLI not found", or "No AI CLI found on PATH"

`init` prints `No AI CLI found on PATH (looked for claude, codex)` when it finds neither, and writes
`claude` into the config anyway. A run prints `CLI not found: <name>. Install it or set provider.cli.`

1. Install and log in to `claude` or `codex`, or use an API key or a local model instead
   ([PROVIDERS](PROVIDERS.md)).
2. Set [`provider.cli`](CONFIG.md#providercli) to the tool's **absolute path** (`which claude` prints
   it). A scheduled run does not use your shell's `PATH`: on macOS and Linux it searches only `~/.local/bin`,
   `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` and `/bin`, so a tool installed elsewhere (by a
   version manager such as nvm, or under `~/.bun/bin`) works in your terminal and is not found at 07:20.
3. Check with `daily-briefing doctor --json`: `provider.found` should be `true` and `provider.path`
   the file you expect.

## Scheduled delivery is not firing

Start with `daily-briefing schedule status`:

| Line | What to look for |
| --- | --- |
| `registered:` | `no` means nothing is scheduled: run `daily-briefing schedule install` (or set up background delivery in the app). `unknown` means the check could not run, which says nothing either way: over SSH there is no desktop session to ask, and on Linux your user's systemd manager may be out of reach from that shell. Run it again from a terminal in your desktop session; `schedule status --json` gives the reason as `registeredReason`. |
| `owner:` | `app` or `cli`. Only one may own the trigger; the other is refused rather than replacing it. |
| `morning time:` | `not yet reached` means it is earlier than your morning time ([`morningTime`](CONFIG.md#morningtime)), so ticks do nothing yet. |
| `ticks today:` | how many times the scheduler woke the engine today. `none recorded` after your morning time means the scheduler is not reaching it. |
| `last delivery:` | the last time a briefing was delivered. |
| `last skip:` | why the last tick did not deliver (table below). |
| `engine skew` | the scheduled copy is a different version. If `owner:` is `app`, click **Update background engine** on the app's Schedule screen (a `schedule install` from the terminal is refused for an app-owned schedule); if `cli`, run `schedule install` again. |

`daily-briefing schedule verify` kicks the trigger once and reports whether the kick reached the engine.

**Why a tick skipped** (`last skip:`):

| Reason | Meaning |
| --- | --- |
| `already-ran` | today's briefing was already delivered. Use `run --force` to regenerate it. |
| `below-floor` | it was earlier than `morningTime`. |
| `offline` | the network did not come up within the wait; the next tick retries. |
| `darkwake` | the Mac was in a brief maintenance wake; the next real wake delivers. |
| `limited` | the AI account is at its usage limit; the detail says until when, when the provider stated it. |
| `blocked` | no activity, and a repository could not be read — or no repository was found at all and a folder listed in `discoverRoots` could not be read or found (on macOS, usually [folder access](#macos-repos-in-protected-folders-desktop--documents--downloads--icloud)). The day is not used up; when it can, the detail names the folders. |
| `provider-fail` | the AI call failed after retries; the detail says how. |
| `no-config`, `config-error` | the config is missing or invalid: `daily-briefing doctor --json`. |
| `concurrent` | another run was still going. |
| `parse-empty`, `marker-fail`, `crashed` | the run failed after calling the AI; the log has the detail. Please report it. |

**Logs:**

- macOS: `~/Library/Application Support/daily-briefing/briefing.log`. Every tick appends to it, so read
  the end (`tail -n 50 …`). It rotates to `briefing.log.1` at about 5 MB.
- Linux: the systemd journal, `journalctl --user -u daily-briefing.service`.
- Windows: no log file; run `daily-briefing run` in a terminal to see the output.

If the Bun runtime itself crashed during a scheduled run, Bun's own crash message in the log may show
its manual report link without a host. That is expected: the schedule sets `BUN_CRASH_REPORT_URL` to
empty to keep Bun's crash upload off, and nothing was sent.

**Common causes:**

- **The computer was asleep or off.** Delivery happens at the first tick after `morningTime` while the
  computer is awake, so a laptop opened at 09:30 gets its briefing just after 09:30. That is the design,
  not a failure.
- **Linux: you were logged out.** systemd user timers do not run without a login session unless
  lingering is enabled. `schedule status` shows a `linger:` line; enable it with
  `daily-briefing schedule install --enable-linger` (or `loginctl enable-linger $USER`).
- **The AI tool is not found by the scheduled run** although it works in your terminal: see
  [CLI not found](#cli-not-found-or-no-ai-cli-found-on-path).
- **Repositories in protected folders on macOS:** the run reports `blocked`; see
  [folder access](#macos-repos-in-protected-folders-desktop--documents--downloads--icloud).

## Removing the background scheduler by hand

`daily-briefing schedule uninstall`, the app's **Remove background scheduler…** and the app's
Uninstall all remove the background scheduler the same way: they unregister the job by its label,
check that it is gone, and only then delete its files, the `schedule.json` record last. When the
check still finds the job registered, or cannot run, nothing more is deleted. The message then
says why, what is still there and what, if anything, was removed, and gives the steps below,
written for your machine's own folders (`daily-briefing schedule status --json` carries the same
steps as `removeSteps`). Copy them from that message; the ones here are for the default folders.

On macOS:

```text
Run these in a terminal (bash or zsh) inside your desktop session.
1. Unregister the job:
   launchctl bootout gui/$(id -u)/local.daily-briefing; launchctl bootout user/$(id -u)/local.daily-briefing
2. Wait a few seconds.
3. Confirm it is gone. Each of these must report not found: it prints "Could not find service", or its last line is "exit 113".
   launchctl print gui/$(id -u)/local.daily-briefing; echo "exit $?"
   launchctl print user/$(id -u)/local.daily-briefing; echo "exit $?"
   launchctl list local.daily-briefing; echo "exit $?"
   If the first one says "Could not find domain", this terminal is not in your desktop session (over SSH, for example): run these steps from a desktop session instead. The second one may say "Could not find domain"; that is fine.
   If the last one still finds the job (one loaded in another session), run this in the same terminal, wait a few seconds, and confirm again:
   launchctl remove local.daily-briefing
4. Delete the files:
   rm -f -- "$HOME"/'Library/LaunchAgents/local.daily-briefing.plist' "$HOME"/'Library/Application Support/daily-briefing/schedule.json'
```

On Linux:

```text
Run these in a terminal (bash or zsh) inside your desktop session.
1. Unregister the timer and service (a "not found" from disable is fine):
   systemctl --user stop daily-briefing.timer daily-briefing.service; systemctl --user disable daily-briefing.timer
2. Confirm they are gone:
   systemctl --user is-active daily-briefing.timer daily-briefing.service
   must print only inactive, failed or unknown, and
   systemctl --user is-enabled daily-briefing.timer
   must print static, disabled, linked, linked-runtime, masked, masked-runtime, bad or not-found, or report that the unit file does not exist.
3. Delete the files and reload:
   rm -f -- "$HOME"/'.config/systemd/user/daily-briefing.timer' "$HOME"/'.config/systemd/user/daily-briefing.service' "$HOME"/'.local/state/daily-briefing/schedule.json'; systemctl --user daemon-reload; systemctl --user reset-failed daily-briefing.timer daily-briefing.service
```

Then run `daily-briefing schedule uninstall` again (in the app: press **Remove background
scheduler…** again, or run Uninstall again). With everything gone it reports "Nothing installed by
daily-briefing was found."

## The app's login item

**Start at login** is the last choice in the app's setup. It is ticked by default, and nothing is
registered until you press **Finish**. With it on, the desktop app opens when you log in, so it is
running to show and announce the morning briefing. It opens the app and nothing else: the briefing
itself is generated by the background scheduler, which is separate. If you set up the engine from a
terminal and never went through the app's setup, there is no login item until you turn it on under
**Settings › This app › Start at login**.

On macOS it is listed in **System Settings › General › Login Items & Extensions**. The app records its
own bundle identifier in the login item so that macOS should list it as **Daily Briefing** with the
app's icon — not yet confirmed for this release, which is not notarized. A login item created by an
earlier version of the app carries no such label and is listed as **daily-briefing-gui**, marked "Item
from unidentified developer" because the app is not notarized; it is the same login item either way.
Turning it off and on again in the app replaces it with the labelled one.

To turn it off:

- **In the app** (preferred): **Settings › This app › Start at login › Turn off.** The app then offers
  to switch the engine's own notifications on, so you still hear about the briefing without the app
  running.
- **In System Settings:** switch it off under Login Items & Extensions. On macOS 13 and later this may
  only disable the item rather than delete it, in which case the app can still find it and show
  **Start at login** as on; turn it off in the app as well to remove it.

The app never turns it back on by itself: it registers nothing when it starts, and running its setup
again shows your current choice rather than the default. If the app cannot read the current state, its
setup says so and leaves the setting as it is unless you tick or untick the box. If you also see an
entry for the engine (`daily-briefing`) in that list, that one is the background scheduler; switching
it off stops scheduled delivery, so remove the schedule from the app's Schedule screen or with
`daily-briefing schedule uninstall` instead.

On Linux the login item is `~/.config/autostart/Daily Briefing.desktop`, and the same app setting
removes it.

## Still stuck

Open an issue on [GitHub](https://github.com/themarigold/daily-briefing/issues) with the output of
`daily-briefing doctor --json` and `daily-briefing schedule status`. Issues are public, and both
outputs carry local paths: before you post, replace your username or home folder (with `~`), the names
of private repositories, any private host name, and anything else you would not post publicly (a
skipped run's detail can quote an error message, and doctor's warnings can repeat values from your
config). For a security problem, do not open an issue:
follow [SECURITY.md](../SECURITY.md).
