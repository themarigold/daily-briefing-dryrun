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

Everything is on the [latest release](https://github.com/themarigold/daily-briefing/releases/latest)
page; [docs/INSTALL.md](docs/INSTALL.md) has the steps for each platform.

- **Desktop app:** a `.dmg` for macOS (Apple silicon or Intel), and an AppImage or a `.deb` for Linux
  (x86_64). The macOS app is not notarized, so its first open needs **Open Anyway** in System Settings
  ([how](docs/INSTALL.md#macos-the-desktop-app)).
- **Homebrew** (the command-line tool, macOS and Linux):
  `brew install themarigold/tap/daily-briefing`.
- **A single binary** for macOS, Linux or Windows (experimental). Check it against `SHA256SUMS` before
  running it ([commands](docs/INSTALL.md#the-command-line-binary)).
- **From source**, with [Bun](https://bun.sh): [docs/INSTALL.md](docs/INSTALL.md#from-a-source-checkout).

**You need** git, and an AI to write the briefing: an installed, logged-in `claude` or `codex`; an API
key for Anthropic or an OpenAI-compatible service (the desktop app's setup offers the Anthropic key
only; an OpenAI-compatible service is set up on a first install with `daily-briefing init --provider openai-compatible
--model <id> --base-url <url>`, or in the config file); or a local model (Ollama, LM Studio).
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
- **Your repository's own remote, only in a partial clone.** The tool never runs `git fetch`, `pull` or
  `push`. But a repository cloned with `--filter` (or by `scalar clone`, which does so by default) is a
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
`recapCampaigns` adds one more call to the same provider.) (`daily-briefing init` additionally runs `which`/`where` — one or two
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

## Command line and advanced use

| Command | What it does |
| --- | --- |
| `daily-briefing` or `daily-briefing run` | Generate today's briefing (once per day) |
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
- [docs/PROVIDERS.md](docs/PROVIDERS.md): API keys and local models, provider hardening, which
  credential is spent, and failover between accounts.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): empty briefings, folder access, Gatekeeper,
  scheduling, the app's login item.
- [docs/INSTALL.md](docs/INSTALL.md): every platform, using the app and the command line together,
  where files live, and [uninstalling](docs/INSTALL.md#uninstall).
- [docs/self-hosted.md](docs/self-hosted.md): scheduled delivery on an always-on Linux machine.
- [docs/AUDIT.md](docs/AUDIT.md): the self-audit and evaluation tooling (source checkout).

## Links

- [Releases](https://github.com/themarigold/daily-briefing/releases) and the
  [Homebrew tap](https://github.com/themarigold/homebrew-tap).
- [CONTRIBUTING.md](CONTRIBUTING.md): the stack, setup, tests and how to send a change.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately.
- [docs/gui-seam.md](docs/gui-seam.md): the design contract between the desktop app and the engine.
  The project's planning notes are kept outside this repository; for a design question or proposal,
  open an issue.

## License

MIT © Harshil S Jain — see [LICENSE](LICENSE).
