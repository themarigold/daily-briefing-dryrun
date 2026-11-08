# daily-briefing

A morning briefing for developers who work with AI coding assistants. It reads your local git history
and tells you where you left off, what you did, and what to do next, written by the AI you already use
and ready when you first sit down. It runs on your machine: no account, no server.

It comes as a desktop app for macOS and Linux, and as a command-line tool for macOS, Linux and
(experimentally) Windows. Both are the same engine and read the same config.

> **Status: early but usable.** Daily use so far has been on macOS. The Linux packages are built and
> smoke-tested in CI, and Windows is experimental.

## Sample briefing

This is an invented example: the repositories, branch and commits are made up.

```text
☀️  Daily briefing — 2026-10-01  (this machine: laptop)

▶ Where you left off  (first wake past 07:20 · state as of 08:12)
   • [invoice-api] On branch feat/retry-queue (ahead 3, behind 0)
   • [invoice-api] finish the retry queue: the backoff test still fails on the third attempt
   • [web-dashboard] the chart legend refactor is half done; legend.ts is uncommitted

▶ What you did — 4 commits
   • [invoice-api] src/retry.ts — 2 commits (Sep 30)
      ◦ [invoice-api] added exponential backoff to the payment webhook retries  (4f2a91c)
      ◦ [invoice-api] capped retries at five attempts and logged the final failure  (b7d03e8)
   • [invoice-api] fixed the currency rounding in PDF totals  (19c5e40)
   • [web-dashboard] moved the date picker to the shared components folder  (e81b2d7)
   • [web-dashboard] 🔀 1 PR merged (#42) (Sep 30)  (a3f9c10)

▶ Suggested next
   • [invoice-api] make the backoff test deterministic by injecting the clock, then push feat/retry-queue
   • [web-dashboard] commit legend.ts or stash it before starting the next chart
   • [invoice-api] add a test for rounding a total that ends in .005

— generated via claude
```

**Where you left off** is each project's branch and what you were in the middle of. **What you did**
is your commits since your last working day, with each commit's short hash. **Today so far** appears once
you have committed today, and **Suggested next** is a short list of concrete next steps.

## Download

Everything is on the [latest release](https://github.com/norn-app/daily-briefing/releases/latest)
page; [docs/INSTALL.md](docs/INSTALL.md) has the steps for each platform.

- **Desktop app:** a `.dmg` for macOS (Apple silicon or Intel), and an AppImage or a `.deb` for Linux
  (x86_64). The macOS app is not notarized, so its first open needs **Open Anyway** in System Settings
  ([how](docs/INSTALL.md#macos-the-desktop-app)).
- **A single binary** for macOS, Linux or Windows (experimental). Check it against `SHA256SUMS` before
  running it ([commands](docs/INSTALL.md#the-command-line-binary)).
- **From source**, with [Bun](https://bun.sh): [docs/INSTALL.md](docs/INSTALL.md#from-a-source-checkout).

**You need** git, and an AI to write the briefing: an installed, logged-in `claude` or `codex`; an API
key for Anthropic or an OpenAI-compatible service (the desktop app's setup offers the Anthropic key,
which you paste and the app stores for you; an OpenAI-compatible service is added afterwards in
**Settings › AI providers › Providers, in order**, or set up on a first install with `daily-briefing init --provider openai-compatible
--model <id> --base-url <url>`, or in the config file); or a local model (Ollama, LM Studio). You can list
more than one, in order: when one is out of usage, refuses its key or cannot be reached, the next is tried.
[docs/PROVIDERS.md](docs/PROVIDERS.md) says what each path needs.

**What it costs:** one generation call each morning, on your own plan or key; a morning on which the
provider fails retries, so it can make a few more. Nothing is billed by this project.

Tested on macOS 26; the Linux app needs Ubuntu 22.04's glibc and WebKitGTK 4.1 or newer
([requirements](docs/INSTALL.md#requirements)).

## First run

**Desktop app:** open it, and its setup asks which AI to use, which repositories to read and what time
you start your day, then installs background delivery.

**Command line:**

```sh
daily-briefing init    # finds your repos and your AI tool, and writes the config
daily-briefing run     # prints today's briefing
```

`init` writes `~/.config/daily-briefing/config.json`. Open it and check three fields; everything else
is optional:

```json
{
  "repos": ["~/code/invoice-api", "~/code/web-dashboard"],
  "author": { "emails": ["you@example.com"] },
  "provider": { "cli": "/path/to/claude", "argv": ["-p"], "promptVia": "stdin" }
}
```

1. **`repos`**: the repositories to brief on. `init` lists the ones it found near where you ran it and
   in your home folder; remove any you do not want, and add any it missed (absolute paths, `~` allowed).
2. **`author`**: the email or emails you commit with, so only your commits count. Without it, each
   repository's own `git config user.email` is used.
3. **`provider`**: the AI that writes the briefing. `init` fills in the full path of the `claude` or
   `codex` it found; to use an API key or a local model instead, see
   [docs/PROVIDERS.md](docs/PROVIDERS.md).

The file is plain JSON (no comments). `daily-briefing config validate --json --file <path>` checks it,
and [docs/CONFIG.md](docs/CONFIG.md) describes every key.

**Done** looks like the sample above, printed by `run` and saved to `briefing-latest.md` in the state
folder (`~/Library/Application Support/daily-briefing/` on macOS, `~/.local/state/daily-briefing/` on
Linux). That file is overwritten each run, so it is always just the latest; the scheduled log,
`briefing.log`, appends every run, so don't read that one directly. One briefing is made per day: a
plain `run` after it does nothing, and `run --force` regenerates it, for example to pick up commits made
since (they appear under "Today so far"). Automated commits such as `vault backup:` are left out
([`excludeCommitPatterns`](docs/CONFIG.md#excludecommitpatterns)). If the briefing comes back empty, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#the-briefing-is-empty-or-no-repos-were-found).

## Scheduled delivery

```sh
daily-briefing schedule install
```

This installs a system trigger (a launchd agent on macOS, a systemd user timer on Linux, and on Windows,
experimentally, a Task Scheduler task with `--confirm-experimental`) that wakes the engine every 10
minutes and delivers the day's briefing at the first wake at or after
[`morningTime`](docs/CONFIG.md#morningtime), 07:20 by default, so a laptop opened at 09:30 gets its
briefing shortly after it wakes. It copies the engine to a managed location and schedules that copy, so
the file you downloaded can move. The desktop app does all of this in its setup.

Before generating, a run waits briefly for the network (a connection check that sends no data); still
offline, it skips and the next tick retries. The details are in
[delivery timing, in full](docs/CONFIG.md#delivery-timing-in-full).

- `daily-briefing schedule status`: is it installed, did it fire today, and why did it last skip.
- `daily-briefing schedule verify`: fire it once now and confirm it reached the engine.
- `daily-briefing schedule uninstall`: remove the trigger.

On a Linux machine you log out of, add `--enable-linger` so the timer still fires. For an always-on
server, see [docs/self-hosted.md](docs/self-hosted.md).

### macOS: repos in protected folders

If your repositories live in Desktop, Documents, Downloads or iCloud Drive, macOS blocks the scheduled
run from reading them, silently, until you grant access. In **System Settings › Privacy & Security**, give
**Full Disk Access** (or Files & Folders) to the engine copy at
`~/Library/Application Support/daily-briefing/daily-briefing`; granting your terminal is not enough. The
desktop app is a second program with its own grant, and while it is ad-hoc signed each app update needs
that grant again. A run that is blocked does not use up the day: it retries once access is granted.
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md#macos-repos-in-protected-folders-desktop--documents--downloads--icloud)
has the full story, including how to reset a grant.

## Privacy

**`daily-briefing` is local-first and has no telemetry of its own: no analytics, no usage or crash
reporting, no account, and no server of its own.** It reads your repositories and writes your briefing on your
machine. The software itself reaches the network in these places, and no others:

- **The AI provider you choose.** To write the briefing, the tool sends a prompt built from your local
  git activity (commit subjects, short hashes and dates, the names of changed and uncommitted files, repository and
  branch names, stash messages). With an AI CLI (`provider.cli`, such as `claude`), the tool starts that
  CLI and hands it the prompt; where the CLI connects is up to the CLI and its vendor. With **`provider.api`**, the tool itself sends one HTTP(S)
  POST per generation attempt to the endpoint you configured (for the Anthropic API,
  `https://api.anthropic.com` unless you set another). That request is encrypted only if the endpoint
  is `https://`: a plain `http://` endpoint that is not loopback sends the prompt *and your API key*
  unencrypted (see below). Either way the prompt goes to *that* provider under *their* terms. Point it
  at a **local model** and the prompt never leaves your machine.
  [AI summaries](#ai-summaries-optional-off-by-default), if you turn them on, make a second call to the
  same provider.
- **The calendar links you add, only if you turn the calendar on** (off unless you turn it on; see
  [Today's calendar](#todays-calendar-optional-off-by-default) below). Each run sends one HTTPS GET per
  private calendar link you added, to that link's own host, following at most three redirects and only
  within the same domain. The desktop app's live read (below) fetches every link the same way each time it
  reads: when you move onto the calendar slide or the last slide and, while either is shown, when the window
  regains focus, when you turn the calendar on, when a meeting card or Join button finds the last read out of
  date, and every five minutes. Nothing about you or your repositories is sent; the link's address itself is
  the secret that lets the host answer.
- **A connectivity check** before it generates a briefing (on any run, scheduled or manual) and in
  `doctor --json`, which the desktop app runs during setup and, on macOS, each time it opens (including
  its first launch, before setup): a raw TCP connect to `networkProbeHosts` to confirm the network is up before it calls
  your provider. If you have not set `networkProbeHosts`, it connects to `1.1.1.1` and `8.8.8.8` on port
  443 with an AI CLI, and to your endpoint's own host with `provider.api` (no check at all for a loopback
  endpoint such as a local model). The socket is opened and immediately closed: **no data is sent or
  received**. Turn it off with `networkProbeHosts: []`.
- **GitHub, only if you ask.** If you turn on the update check (`updateCheck`, off unless you turn it
  on), press **Check now** in the app, or run `daily-briefing update --check`, the tool sends one
  anonymous HTTPS GET to `api.github.com` for this project's latest release. It carries this version in
  its User-Agent and, after the first answer, GitHub's own cache tag for that release (the same for
  everyone): no account, machine or install identifier, and nothing about your repositories. With the
  setting on, it runs at most once a day by default, and only right after a scheduled run has delivered
  your briefing. It downloads and installs nothing.
- **GitHub, when you press an Open on GitHub button in the desktop app.** Open PR, Open branch, Compare and a
  commit's arrow each open a page on `github.com` in your browser, so the owner, repository and branch names in
  that address, and its PR number or commit ID, go to `github.com` through your browser, as any page you open
  does. The app sends nothing itself and only offers these for work your local git records on a GitHub remote. The
  GitHub links switch in Settings → Editor & links turns them off.
- **Your repository's own remote, only in a partial clone.** The tool never runs `git fetch`, `pull` or
  `push`, and the desktop app never pushes: Copy push command puts a `git push` command on your clipboard for
  you to run. But a repository cloned with `--filter` (or by `scalar clone`, which does so by default) is a
  partial clone: it is missing some file contents, and when the tool reads its history, git itself
  downloads what is missing from that repository's own remote, with your usual git credentials. A
  normal clone never does this. If git cannot reach that remote (offline, or your credentials are not
  available to a scheduled run), that repository's commits are left out of the briefing, with a warning.
- **The Bun runtime, only if Bun itself crashes.** The engine is built with Bun. If the Bun runtime
  itself crashes (not an error in this tool's code), on macOS and Windows it can send Bun's team a crash
  trace to `bun.report`: Bun's version, your platform, an internal stack trace, the crash reason
  and which Bun features were used (no source code or personal information, per Bun). The desktop app turns this off for every
  run it starts, and so does the schedule `daily-briefing schedule install` sets up on macOS; on Linux
  Bun does not send it by default. For a run you start from a terminal, or the experimental Windows
  scheduled task (which cannot carry an environment variable), set `DO_NOT_TRACK=1` in your environment
  to turn it off. A schedule installed by an earlier version keeps Bun's default until you run
  `schedule install` again.

Apart from that partial-clone case, `git` only reads your local repositories. Like your AI CLI (see
below), though, `git` can start helper programs that your own git configuration names: a `textconv` diff
driver, an fsmonitor hook, or a clean filter (Git LFS's, for one).
What those programs contact is up to them. The desktop app makes no network requests of its own.

On a briefing run, the programs *this tool* starts are `git` (to read your local history) and the AI
CLI *you* configure — which it normally invokes twice per run: once as `<your-cli> --help` to check
which hardening flags it supports, and once to generate the briefing. (A non-`claude` CLI skips the `--help` check, so it is
invoked once; a morning that hits failures retries, up to five generation attempts by design, and a
retry without the hardening flags or outside the private working directory can add attempts; the opt-in
`recapCampaigns` adds one more call to the same provider, and AI summaries add one more call and, with a `claude` CLI, one more `--help` check.) (`daily-briefing init` additionally runs `which`/`where` — one or two
purely local `PATH` lookups — to locate that CLI.) On macOS a run that is not `--force`d also runs
`pmset` to tell a real wake from a maintenance wake, and a run starts your `apiKeyCommand` if you set
one, and the notifier (`osascript`, `notify-send` or your own command, after a `which` lookup when it is
named without a path) if you turned notifications on. Outside a briefing run: `daily-briefing schedule`
(install, uninstall, status and verify) runs your system's scheduler tool — `launchctl`, `systemctl` or
`schtasks` — and on Linux may run `loginctl` to check (or, with `--enable-linger`, turn on) lingering; on
macOS, `schedule install` also runs `xattr`, `codesign`, `security` and `openssl` to prepare and sign the
copy of the engine it installs, none of which contacts anything; and `doctor` runs `which` (or `where`)
and, for `claude`, the same `<your-cli> --help` check, plus `pmset` on macOS and `git config` (three local
reads per repository, to spot a partial clone; never a fetch). `init` with an API
configuration also runs your `apiKeyCommand` once, to report whether the key resolves.
The desktop app also runs `repos status --json` while the slides are shown: on page load,
on window focus, and when the minute check finds git metadata changes. Unknown results are retried. A repository with
more than 2 000 entries under `refs/` gets a full check every minute while the slides are shown. With the launchpad
current, it also runs a per-repo `git status` once a minute. These live checks run local,
read-only `git` in the listed repositories, with hooks, fsmonitor, lazy fetching and
the repository's own filters off (filters from your global or system git config, such as Git LFS's, still run).
The live check never fetches.
When you press Open in editor, on macOS, the desktop app runs `/usr/bin/open -b <editor> <project folder>`, for the
editor you chose from its fixed list. That editor may run workspace tasks according to its own trust settings.

**But your AI CLI is not a sealed box, and it would be wrong to imply otherwise.** Depending on how you
have configured it, *it* may start further programs that this tool never sees: your own hooks execute
shell commands, and your MCP servers — including any that ship with plugins — run as child processes. So
the list above is complete for `daily-briefing` itself, not for the whole pipeline.
[Provider hardening](docs/PROVIDERS.md#provider-hardening-on-by-default) is about narrowing that gap.

With a **`provider.api`** configuration that prompt is sent by this tool directly to the endpoint you
named — one HTTP(S) POST per generation attempt, carrying the prompt and nothing else (no system prompt,
no tools, no telemetry) — under that vendor's terms. Four consequences worth stating outright:

- If you point `baseUrl` at a **plain `http://` host that is not loopback**, then **your API key** *and*
  the whole briefing context — commit subjects and dates, file names, repository and branch names, stash
  messages — cross the network **in cleartext**: the key travels unencrypted in a request header on every run, and anyone on
  the path can read it. The tool still sends it (a deliberate config is honoured) but warns once per run, naming the
  credential; `http://127.0.0.1` and `http://localhost` are silent, because there is no network hop to
  protect.
- A **query string** on `baseUrl` is sent (a gateway's `api-version=` parameter is load-bearing) but is
  **withheld from every printed surface** — `doctor --json` shows origin + path only, and says when it
  held something back. Do not put a key there; use one of the four key sources (`apiKeyEnv`,
  `apiKeyFile`, `apiKeyCommand`, `apiKey`) instead: a credential in a URL lands in every log line that
  ever renders the endpoint.
- A **redirect is not followed.** If the endpoint answers with one, the request fails rather than
  re-sending the prompt and the key to the address the redirect names — so `baseUrl` must be the final
  URL (an `http://` address that redirects to `https://` fails every attempt).
- The **model id** you configure is recorded in the briefing header (`anthropic-api (claude-sonnet-5)`),
  so a change in briefing content can always be traced to the change in configuration that caused it.

In short: the only thing that carries your *data* off your machine is the prompt you send to the AI
provider you picked. The connectivity check sends nothing; the update check, if you use it, sends only
this version number and GitHub's own cache tag; in a partial clone, git asks the repository's own
remote only for file contents that remote already has; and Bun's crash trace, sent only if the runtime
itself crashes and only where it is not turned off, carries no code or personal information, per Bun.
(What programs your own configuration starts — your AI CLI's hooks and MCP servers, git's helpers, your
`apiKeyCommand` and a custom notification command — do on their own is, as above, up to them.)

### Today's calendar (optional, off by default)

With `calendar.enabled` on, the briefing shows a **▶ Today's calendar** section and the AI gets today's
events so it can fit its suggestions around your meetings. What that reads, sends and keeps:

- **What is read.** Each private calendar link you add (Google's "Secret address in iCal format",
  Outlook's published ICS link, an iCloud shared link): one GET per link per run, as above. **An iCloud
  link is a Public Calendar**: anyone who has the address can read it, and its events carry no attendees
  and no replies, so the tool cannot see whether you declined an invitation on it, and treats every
  event on it as not accepted (no description reaches the AI). A link's
  address is a secret, because whoever has it can read that calendar: the tool keeps it in its own file
  (`<state dir>/calendar/links/<id>.url`, readable only by you), or reads it from an environment
  variable or a command you name, and never from the settings file, a log, a warning or the briefing.
  An environment variable (`urlEnv`) is seen only by runs that inherit your shell's environment, that is
  a `daily-briefing` command you type; the desktop app and scheduled runs do not, so for those use the
  link's own file (what the app and `calendar add-link` write) or a command (`urlCommand`).
  The **Mac Calendar app** source (macOS 14 or later) reads every account you added to Calendar on your
  Mac through a small helper, **Daily Briefing Calendar Reader**, which ships inside the desktop app.
  Turning the source on (Settings → Calendar → Allow access, or `daily-briefing calendar connect mac`)
  copies the helper to `<state dir>/calendar/reader/`, signs that copy with the same local identity as the
  scheduled copy of the engine (which may show a keychain prompt), and starts it once so macOS can ask
  you. The dialog names **Daily Briefing Calendar Reader**, not the app you are in, because the helper
  is the program macOS gives Calendar access to. EventKit has no read-only access, so the dialog asks
  for full access; the helper never writes to a calendar. Scheduled runs only start the installed copy
  through macOS (`open`), never install, sign or ask. The helper reads yesterday to tomorrow, makes no
  network request, and hands the events to the engine through a named pipe in its own folder, so the
  event data never sits in a file. Like any program on your Mac, another program running as you could
  start the helper and read that window from the calendars you allowed.
- **What reaches the AI depends on whether the attempt is locked.** An attempt is *locked* when it
  cannot act on what it reads: an API provider or a local model (`provider.api`, no tools at all), or a
  `claude` CLI started with all three hardening flags injected (`--tools=`, `--strict-mcp-config`,
  `--setting-sources user`) and nothing in your own `provider.argv` except a short allow-list (`--model`,
  `--fallback-model`, `--output-format`, `--verbose`, `-p`/`--print`, `--max-turns`). Any other flag,
  `harden: false`, an older `claude` that lacks one of the flags, any other CLI, and every retry without
  the flags is *unlocked*. The allow-list fails safe: a flag the CLI adds later is unlocked until it is
  added here. **Every HTTP provider counts as locked**, because the tool sends it a prompt and reads back
  text, with no tools of its own: if you point `provider.api` at a local OpenAI-compatible endpoint that
  fronts an agent which *can* use tools, what that agent does with your calendar is your own choice, and
  the tool cannot see behind the endpoint. [PROVIDERS.md](docs/PROVIDERS.md#calendar-locked-and-unlocked-attempts) has the full matrix.
  - A **locked** attempt gets every detail: title, time, busy/free/tentative, location, organizer,
    attendees' names and emails, and the description, except that an invitation you have not accepted
    has no description.
  - An **unlocked** attempt gets each event's schedule shape only — `09:00–09:30 busy (3 people)`,
    `all day busy`, `invited, not accepted` — with no event title, location or attendee names. The calendar
    section also carries today's date, the current time and your time zone and, when a calendar source could
    not be read fully, that source's id, which can hold a name, as in `work-alice`. **In this release every
    event is a busy block on an unlocked attempt.** The design lets an event with guests that you
    organised keep its title, location and description (with an attendee count, never names), but only
    from an organizer signal an invitation cannot fake, and no calendar kind has one yet: an invitation
    that names you as its organizer, opened on a Mac and added to your calendar, reads as one you
    organised both in the Mac Calendar app and on your Google secret link. An iCloud link carries neither
    organizer nor attendees, so its events read as *not accepted*, with no description on a locked attempt
    either.
  - With `provider.promptVia: "arg"` the prompt is a command-line argument, which other users of the
    same machine can see in the process list while the AI runs. On a locked attempt that includes your
    attendees' names and emails. Keep the default (`stdin`) on a shared machine.
- **Cleaning.** Before anything is stored or sent, every event field is cleaned: HTML is stripped,
  conferencing boilerplate (such as Google Meet's dial-in block) is cut, every web address becomes
  `<host> link`, values after the labels passcode, password, pwd, PIN, meeting ID, access code,
  conference ID and host key become `[redacted]`, and the digits after `,` `;` or `#` in a dial string are
  removed. **The labelled-secret
  rules recognise English labels only**; the web-address rule works in any language. The desktop app's
  live read (below) is the one place a meeting's own link is kept, in the app's memory, for its Join button.
- **What is stored.** The briefing file, its dated archive and `run --json` keep event titles, times,
  locations and attendee counts. The tool never stores attendee names or emails, or descriptions, and
  stores nothing the desktop app reads live (below) — but
  **the AI's own suggestions may mention any meeting detail it was given** (on a locked attempt that can
  include an attendee's name or a line of the description), and they are stored in your briefing, its
  archive and `run --json` like any other suggestion. With
  [AI summaries](#ai-summaries-optional-off-by-default) on, their result is stored too, at
  `<state>/briefings/<date>.<hash>.<version>.summary.json`: a locked attempt's text may name a meeting.
- **Read live in the desktop app, never saved.** The desktop app's calendar slide shows more than the
  briefing does: today's meeting links, attendee names and notes, read live from your calendars when you
  move onto the calendar slide or the last slide and, while either is shown, again when the window regains
  focus, when you turn the calendar on, when a meeting card or Join button finds the last read out of date,
  and every five minutes (only while the calendar is on). They are held only in the app's memory,
  dropped the first time the app uses them after the day changes and when the app quits,
  never written to disk, the briefing or a log, and
  never sent to the AI. A calendar link whose address comes from a command (such as a password manager)
  is remembered in the app's memory while the app is open, never saved to disk: the command runs on your
  first move onto the calendar slide or the last slide after the app starts, and again on such a move only
  while no address is remembered (for example after the command failed or its settings changed); a read when
  the window regains focus or every five minutes never runs it. The app's window never receives a meeting link: Join hands the app an identifier,
  and the app opens the link itself, at once for Zoom, Google Meet, Teams and Webex, and for any other
  site only after it asks first, naming the site. A meeting card's people and notes are dropped when you
  close it, when the meeting ends and when the day changes. The notes shown are lightly cleaned: HTML is
  stripped, dial-in blocks are cut, links are removed and the labelled secrets above become `[redacted]`.
- **The self-audit** (`bun run audit`, a source-checkout tool) gives its AI judge the calendar section
  under the same rule: a locked judge sees it as rendered, an unlocked one sees times only. A meeting
  title the briefing's own suggestions quoted still reaches an unlocked judge, and the audit report says
  so.
- **If a link may have leaked**, reset it at the provider (in Google Calendar: the calendar's settings →
  "Secret address in iCal format" → Reset), then add the new one. The old address stops working.

### AI summaries (optional, off by default)

AI summaries are short project points and a Good morning sentence, generated after your briefing. AI
summaries are off unless you turn them on, in Settings → General → Briefing or with
[`aiSummary`](docs/CONFIG.md#aisummary) in your config. AI summaries are not available on Windows yet. No
summary call is made on Windows.

- **A second AI call.** With them on, a delivered briefing on a day that is not quiet makes a second AI
  call, if the page has at least one project card. Generating the same day's briefing again can make
  another when it is delivered.
- **Who receives it.** It goes to the same provider entry that wrote the briefing, with one try and no
  fallback. If it is your key source, your `apiKeyCommand` runs again for this call, so a password manager
  may ask a second time.
- **What it sends** depends on whether the attempt is locked, which means it cannot act on what it reads
  ([Today's calendar](#todays-calendar-optional-off-by-default) has the rule).
  - Every attempt leaves out the computer's name, the page's warning and notice lines and the line that
    names the provider. Those can name a key file, a folder or your user name.
  - A locked attempt gets the saved page.
  - An unlocked attempt after an unlocked morning gets the saved page with the calendar section's body
    replaced by schedule shape, such as `09:00–09:30 busy (3 people)`, with no event title, location or
    attendee names. The calendar section also carries today's date, the current time and your time zone
    and, when a calendar source could not be read fully, that source's id, which can hold a name, as in
    `work-alice`. If the morning had no events and no schedule shape, for example with no calendar connected, the
    page's own calendar text stays. If the prompt budget left room only for the line
    `TODAY'S CALENDAR omitted: prompt budget too small`, that line replaces the body and the call goes with no
    meeting text. If it had events and there was no room even for that line, or the schedule shape could not be
    built, no call is made.
  - An unlocked attempt after a locked morning makes no call, because a locked morning's suggestions may
    repeat meeting details outside the calendar section.
  - If you turned [`transcripts`](docs/CONFIG.md#transcripts) on, the call includes the page's `— you wrote`
    quotes from your sessions, up to 600 characters each.
- **When it stays quiet.** No call is made when AI summaries are off or on a quiet day. No live details
  are added: what the desktop app reads live from your calendars never goes into this call.
- **Where the result goes.** The result shows only on the desktop app's slides. The call is still made with
  the slides off or with no desktop app, because the engine cannot read that app setting. The result is
  stored at `<state>/briefings/<date>.<hash>.<version>.summary.json`. It stays after you turn AI summaries
  off, and other dates' files are not pruned; it goes with the briefing archive when Uninstall removes the
  engine's data. A locked attempt's text may name a meeting.
- **The run waits for it.** A run with AI summaries on can return up to 30 seconds after the briefing is
  delivered, and the desktop app's Run now stays running until then.

[PROVIDERS.md](docs/PROVIDERS.md#ai-summaries-the-second-call) says the same with the provider's details.

## Command line and advanced use

| Command | What it does |
| --- | --- |
| `daily-briefing` or `daily-briefing run` | Generate today's briefing (once per day) |
| `daily-briefing run --now` | Generate it now, even before the morning time — still once per day (what the app's Run now does) |
| `daily-briefing run --force` | Regenerate it, ignoring the morning time and the once-per-day rule |
| `daily-briefing init` | Write the config template |
| `daily-briefing schedule install`, `status`, `verify`, `uninstall` | Scheduled delivery |
| `daily-briefing doctor --json` | Check the config, repos, provider and network; never generates |
| `daily-briefing status --json` | Report where the engine keeps its state and when it last ran |
| `daily-briefing config validate --json --file <path>` | Check a config file |
| `daily-briefing update --check` | Ask GitHub whether a newer release exists; it downloads nothing |
| `daily-briefing --help` | Every command and flag |

Further reading:

- [docs/CONFIG.md](docs/CONFIG.md): every config key, with its type and default.
- [docs/PROVIDERS.md](docs/PROVIDERS.md): API keys and local models, the keys the app stores, provider
  hardening, which credential is spent, and failover between accounts.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): empty briefings, folder access, Gatekeeper,
  scheduling, the app's login item.
- [docs/INSTALL.md](docs/INSTALL.md): every platform, using the app and the command line together,
  where files live, and [uninstalling](docs/INSTALL.md#uninstall).
- [docs/self-hosted.md](docs/self-hosted.md): scheduled delivery on an always-on Linux machine.
- [docs/AUDIT.md](docs/AUDIT.md): the self-audit and evaluation tooling (source checkout).

## Links

- [Releases](https://github.com/norn-app/daily-briefing/releases).
- [CONTRIBUTING.md](CONTRIBUTING.md): the stack, setup, tests and how to send a change.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately.
- [docs/gui-seam.md](docs/gui-seam.md): the design contract between the desktop app and the engine.
  The project's planning notes are kept outside this repository; for a design question or proposal,
  open an issue.

## License

MIT © Harshil S Jain — see [LICENSE](LICENSE).
