# daily-briefing

A cross-platform CLI **morning briefing for developers who work with AI coding assistants**.
Reads local git history and produces a **resumption-focused** briefing — "here's where you left
off, resume here" — plus suggested next tasks. Bring-your-own AI (existing coding-agent CLI
first, then API keys, then local models).

> **Status: early but usable.** The core CLI (config, git extraction, budget-aware reduce, BYO provider,
> generator, render, marker) is built and tested — with scheduled macOS delivery (a launchd agent that
> generates on first wake past a morning floor), provider hardening on by default, multi-account
> failover, and a `bun run audit` self-audit that has graded the author's own briefing every morning
> since day one.

## Quickstart (prebuilt binary)

**You need:** local git repos to brief on, and an AI to generate with — an installed coding-agent CLI
(e.g. `claude`) is the zero-config default, and a **bring-your-own-key API provider or a local model**
is configured in the same config file — see [API providers](#api-providers--bring-your-own-key-or-point-at-a-local-model).

**macOS / Linux with [Homebrew](https://brew.sh):**

```sh
brew install themarigold/tap/daily-briefing
daily-briefing init     # writes the config template — edit it, then:
daily-briefing run
```

**Or grab the binary directly** for your platform from the
[latest release](https://github.com/themarigold/daily-briefing/releases/latest)
(`darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64`, plus an **experimental, untested**
`windows-x64`), then:

```sh
# example: Apple Silicon macOS — substitute your platform's asset name throughout
curl -fsSLO https://github.com/themarigold/daily-briefing/releases/latest/download/daily-briefing-darwin-arm64
curl -fsSLO https://github.com/themarigold/daily-briefing/releases/latest/download/SHA256SUMS
shasum -a 256 -c <(grep darwin-arm64 SHA256SUMS)     # verify before running
chmod +x daily-briefing-darwin-arm64
./daily-briefing-darwin-arm64 init                    # writes the config template — edit it, then:
./daily-briefing-darwin-arm64 run
```

Notes:
- **macOS quarantine:** a binary downloaded through a *browser* is quarantined and Gatekeeper will
  refuse it (the binaries are not notarized) — clear it with
  `xattr -d com.apple.quarantine daily-briefing-darwin-arm64`. A `curl` download has no quarantine
  attribute, so the commands above run as-is.
- **Scheduled morning delivery** (generate automatically on your first wake of the day) is currently
  a **source-checkout install on macOS only** — see **Install the morning agent** below; it needs a
  clone and [Bun](https://bun.sh). The prebuilt binary is the manual path: run it whenever you want a
  briefing, or schedule it yourself with cron/systemd (`run` is a cheap no-op after the day's
  briefing is delivered, so an aggressive schedule is safe).
- On Linux, config lives at `~/.config/daily-briefing/` and output at
  `~/.local/state/daily-briefing/` (`XDG_CONFIG_HOME` / `XDG_STATE_HOME` respected); on macOS, output
  is under `~/Library/Application Support/daily-briefing/` (the `run` output names the exact file).

## Docs
Usage lives in this README; contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md). Design notes
and decision history are maintained privately by the author — for a design question or proposal, open an
issue.

## Stack (decided)
TypeScript on **Bun** (single-binary via `bun build --compile`) for the engine. A **Tauri 2** desktop shell
(`gui/`, Rust + Svelte) is being built around it, bundling the engine as a sidecar — in progress, not yet released.

## Usage
From a source checkout (no build needed), `daily-briefing` below means `bun run src/main.ts`:
- **Init:** `bun run src/main.ts init` — writes a config template (edit it before first real run).
  To drop a repo you don't want in the briefing (a stale or work checkout), add it to
  `excludeRepos` — by absolute path or bare basename — which filters both the explicit `repos`
  list and anything found under `discoverRoots`.
- **Run manually:** `bun run src/main.ts run`. Add `--force` to bypass the once-per-morning guard.
- **Reading the briefing:** each run writes a clean, **overwritten** copy to
  `~/Library/Application Support/daily-briefing/briefing-latest.md` — that's the file to open (always
  just the latest). The `launchd` agent's raw stdout log (`briefing.log`) *appends* every run, so
  don't read that one directly. A deterministic **"Today so far"** section lists commits you've made
  today (which the yesterday-window recap excludes), so a briefing regenerated mid-day isn't blind to
  today's work; `vault backup:`-style auto-commits are filtered out as noise (configurable via
  `excludeCommitPatterns`). To **refresh** the briefing mid-day (so "Today so far" picks up new
  commits), re-run with **`--force`** — the once-per-morning marker is already set by the morning's
  delivering run, so a plain re-run is a no-op.
- **Delivery timing (`morningTime` / `networkProbeHosts`):** the installed agent ticks every 10
  minutes (see Install below) but only *delivers* once it's past a configurable local-time floor,
  `morningTime` (24h `"HH:MM"`, default `"07:20"`) — every tick before the floor is a silent no-op,
  and the first tick at or after it (whether that's a scheduled interval fire or the wake/login
  `RunAtLoad` fire) generates and marks the day done. An invalid `morningTime` falls back to the
  default and surfaces a warning in the briefing. Before generating, a non-`--force` run (whether the
  scheduled agent or a manual `run`) also waits briefly for real network connectivity — a raw TCP probe
  against `networkProbeHosts` (default two anycast DNS hosts, `1.1.1.1:443` / `8.8.8.8:443`) — so a
  dark-wake tick doesn't burn its provider call before wifi re-associates; if still offline after the
  grace period it skips (no stamp), and the scheduled agent's next 10-minute tick retries (a manual run
  you simply re-run once you're back online). Set `networkProbeHosts: []` to **disable** this gate
  entirely — useful for a local/offline provider that needs no network at all. `--force` always bypasses
  the floor and the once-per-day marker; on the network step it still waits briefly (same bounded poll),
  but if still offline afterward it **proceeds anyway** — a forced run always calls the provider —
  whereas a non-`--force` run instead skips (no stamp; retried as just described).
- **Self-audit the briefing:** `bun run scripts/audit.ts [briefing-file] [--no-judge]` (or `bun run audit`) — adversarially evaluates
  the day's briefing so you don't have to eyeball it yourself. Two layers: **deterministic** code checks
  (every cited SHA resolves to a real commit — and, separately, whether it is still reachable from any branch, since a commit on a deleted branch still resolves but a reader following it finds nothing; how many of *today's* commits the briefing missed; repos
  with uncommitted work it never named) plus an **LLM judge** (your `claude` CLI) fed the briefing + an
  independent git ground-truth, asked to attack it from multiple angles (grounding, completeness, ranked
  improvements). Optionally add a second-tool comparison with **`--popup=<dir>`** (author-only; off by
  default). Reads today's `briefing-latest.md`
  (generates it if missing), prints a report + a ready-to-paste `EVAL.md` row, and saves a dated
  `audit-YYYY-MM-DD.md`. Costs one extra `claude` call (~25s) — pass **`--no-judge`** to run only the
  fast deterministic checks with no LLM call. Pass a **briefing-file path** to audit a saved/specific
  briefing (it anchors same-day checks to that briefing's own date). It fills the objective columns; the
  subjective (a)/(b) retention marks stay yours.

- **Install the morning agent:** `bash scripts/install.sh` — builds a compiled binary into
  `~/Library/Application Support/daily-briefing/daily-briefing`, code-signs it with a **stable
  local self-signed identity** (created on demand into your login keychain, `Daily Briefing (local)
  Signing`) so macOS Gatekeeper doesn't block the unattended scheduled run **and** the folder-access
  grant persists across rebuilds, and loads a `launchd` agent that ticks every 10 minutes
  (`StartInterval` + `RunAtLoad`) and delivers on the first tick past your `morningTime` floor
  (default 07:20 — see **Delivery timing** above). Re-run the script any time to rebuild and reload — the grant survives. (If no real
  `openssl` is available it degrades to an ad-hoc signature with a warning; hermetic/CI installs still
  succeed.)
- **Running the installed binary directly** (e.g. to re-run `init` or trigger a manual briefing
  after installing): it is **not** put on your `PATH` automatically, so either invoke it by full
  path — `"$HOME/Library/Application Support/daily-briefing/daily-briefing" init` /
  `... run --force` — or add `~/Library/Application\ Support/daily-briefing` to your `PATH` and
  use the bare `daily-briefing` command shown above.
- **Linux / Windows:** the *core CLI* (`init`, `run`) is cross-platform and runs anywhere Bun does;
  its state lives in the platform-native dir (XDG `~/.local/state` on Linux, `%LOCALAPPDATA%` on
  Windows). Only *scheduled delivery* is macOS-first — `scripts/install.sh` and the `launchd` agent
  are macOS-only. On Linux/Windows, run `daily-briefing run` yourself, or wire it to your scheduler
  (a `cron` job / a `systemd` user timer / Task Scheduler) at your `morningTime`; set
  `networkProbeHosts: []` if your provider is local/offline. A first-class cross-platform scheduler is
  a later slice (Slice 4).

## Configuration

Most config keys are described above where they matter (`excludeRepos`, `excludeCommitPatterns`,
`morningTime`, `networkProbeHosts`); the ones that need more than a line get a subsection here.

### Recap campaigns — `recapCampaigns` (off by default)

On a busy morning the recap can run long even after related commits are grouped. This optional key
lets the briefing spend one extra model call merging related recap items from the same repo into
**campaigns**: a campaign header on top, with the existing group headers and bullets beneath it. Nothing
is hidden or reworded — every bullet still renders once, with its own text and evidence.

```jsonc
"recapCampaigns": { "mode": "off" }   // "off" | "trial" | "on" — default "off"
```

- **`off`** — the default, and what an absent key means: nothing runs. No extra call, no extra git
  reads, no record.
- **`trial`** — on a busy morning the grouping runs end to end (the extra call and every check), but
  the briefing is **never changed**; what it would have done is appended to `recap-campaigns.jsonl` in
  the state directory for you to judge.
- **`on`** — as `trial`, and when the reply passes every check the briefing shows the campaigns. Any
  failure — a bad reply, a failed check, a timeout, an error — delivers the briefing unchanged.
- **A malformed value** — anything that is not exactly `{ "mode": "off" | "trial" | "on" }` (a
  misspelled mode, a second key, a bare string) — counts as `off`, and the briefing carries a fixed
  warning: `config: "recapCampaigns" must be { mode: "off" | "trial" | "on" } — recap campaigns off`.

**The cost, plainly:** `trial` and `on` each spend **one extra model call on every busy morning** (at
least 40 commits in the recap window, or at least 15 top-level recap lines), and widen the run lock's
staleness bound by **`2 × timeoutMs + 50 s`** — 290 s at the default 120 s `provider.timeoutMs`. (The
wider bound only matters when a crashed run's process id has been reused; a crashed run is otherwise
reclaimed at once.) A quiet morning makes no extra call.

In `trial` and `on`, every run that reaches the grouping step — quiet mornings included — appends one
JSON line to `recap-campaigns.jsonl` and prints one count-only `grouping-info [recap-campaigns]:` line
on stderr. The file is append-only and never rotated (about 1 MB a year); delete it whenever you like.
`bun run scripts/recap-campaigns-report.ts` summarises it.

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
  would error every morning forever. So if your repos live under a protected folder, either grant
  access or list them explicitly under `repos` (which `init` does for you once access is granted).

**To grant access:** System Settings → Privacy & Security → **Files & Folders** (enable the
folders for the `daily-briefing` binary), or **Full Disk Access** for the broad fix. Add the
**binary itself** (`~/Library/Application Support/daily-briefing/daily-briefing`) — granting your
terminal isn't enough for the scheduled `launchd` run, whose principal is the binary. Or simply
keep your repos outside those folders.

> **Grant persists across updates.** `scripts/install.sh` signs the binary with a **stable local
> self-signed identity** (`Daily Briefing (local) Signing`, created once into your login keychain),
> giving it a fixed designated requirement. macOS keys the Full Disk Access / Files-&-Folders grant
> to that identity, so re-running `install.sh` to rebuild **keeps** the grant — you grant access once.
> (If the identity can't be created — no real `openssl` — install falls back to an ad-hoc signature,
> and macOS may re-prompt after each rebuild until you install `openssl` and re-run.) A Developer-ID
> signature (planned, Slice 7) additionally clears Gatekeeper for redistribution.

## Uninstall

Run `bash scripts/uninstall.sh` — it unloads the `launchd` agent and removes the installed
binary, the log, and the latest-briefing file. When a schedule is recorded, it first asks the installed
engine to remove its own schedule (`schedule uninstall`). If the desktop app owns that schedule, the
uninstall **refuses and removes nothing** — the app's schedule runs the very binary it would delete:
remove the schedule from the app's Schedule screen (or uninstall the app), then re-run. It refuses the
same way when a schedule is recorded but the installed binary is missing or not executable. If nothing
is actually scheduled (say, an old engine left the record behind), the record is stale: delete
`~/Library/Application Support/daily-briefing/schedule.json` and re-run; the message names it.

`bash scripts/uninstall.sh --remove-signing-identity` also deletes the `Daily Briefing (local) Signing`
identity from your login keychain. It is opt-in, and it refuses (removing nothing) while a schedule
record exists, because the scheduled engine is signed with that identity.

> **Upgrading from a pre-StartInterval build?** An early build used a repeating `pmset` wake for
> delivery (since replaced by the interval agent). If you ran that, an orphaned daily wake may still be
> armed — check with `pmset -g sched` and clear it with `sudo pmset repeat cancel`. Install/uninstall
> now detect a repeating schedule and remind you (they don't auto-cancel it — that needs `sudo` and
> would clear *all* your repeat schedules).

## Coexistence with the desktop app (in progress)

The Tauri shell in `gui/` is being built **around** this CLI, not instead of it:

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
- **The app's uninstall is bounded.** It removes the app's own login item and its own files;
  the engine's data goes only behind an explicit consent box that names the briefing archive,
  and the removal list is pinned to exactly what `bash scripts/uninstall.sh` removes from the
  state directory — the scheduled job itself is not touched here; remove it (or hand it over)
  from the Schedule screen.

The developer-facing contract lives in [docs/gui-seam.md](docs/gui-seam.md) (§16 for
coexistence and uninstall).

## Privacy

**`daily-briefing` is local-first and has no telemetry — and never will.** There is no analytics, no
crash reporting, no phone-home, and no account — there is no server on the other end, because the tool
has no backend.

The programs *this tool* starts are `git` (to read your local history) and the AI CLI *you* configure —
which it normally invokes twice per run: once as `<your-cli> --help` to check which hardening flags it
supports, and once to generate the briefing. (A non-`claude` CLI skips the `--help` check, so it is
invoked once; a morning that hits transient failures retries, and the flag-rejection ladder can add
rungs, so a bad morning reaches six and at worst eight.) (`daily-briefing init` additionally runs `which`/`where` — one or two
purely local `PATH` lookups — to locate that CLI.)

**But your AI CLI is not a sealed box, and it would be wrong to imply otherwise.** Depending on how you
have configured it, *it* may start further programs that this tool never sees: your own hooks execute
shell commands, and your MCP servers — including any that ship with plugins — run as child processes. So
"the only programs it runs" is true of `daily-briefing` and not of the whole pipeline. The next section
is about narrowing that gap.

### Provider hardening (on by default)

Your briefing prompt contains **commit subjects and branch names from every repo you have cloned** — text
you did not necessarily write. If the AI CLI generating the briefing has tools, project hooks, or MCP
servers available, a hostile commit subject becomes a prompt-injection route to running code on your
machine. So when your configured CLI is `claude`, `daily-briefing` invokes it with its authority reduced:

| Injected | Effect |
| --- | --- |
| `--tools=` | disables the built-in tools |
| `--setting-sources user` | ignores **project and local** settings — and therefore **project hooks** |
| `--strict-mcp-config` | ignores filesystem-configured MCP servers |
| `--no-session-persistence` | does not write a session transcript for the run |
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` | keeps the briefing prompt out of your CLI's prompt history |

It also runs the CLI in a **private working directory** (`<state dir>/provider-cwd`, mode `0700`) rather
than whatever directory the scheduled job happened to be in.

**This is a real change if you rely on MCP servers (at ANY scope) or project hooks with `claude`** —
during a briefing run they will not be available. It affects only the briefing's own invocation; your interactive
`claude` sessions are untouched.

Three things it deliberately does **not** do. It only injects flags your CLI actually lists in `--help`,
so an older version degrades to today's behaviour rather than dying on an unknown flag. It leaves your
**user-scoped settings, skills and plugins** alone (though a plugin's own MCP server is still dropped —
see the correction below) — which is why `--safe-mode`, which would disable all
of those too, was evaluated and rejected. And it never narrows the working directory unless the
settings-isolation flag actually went in, because a directory under `$HOME` is only an improvement when
project settings are already suppressed.

**One correction worth being blunt about:** `--strict-mcp-config` is scope-**blind**. Its own help says it
ignores "all other MCP configurations", so it drops your **user-level** MCP servers too, not only
project-level ones (measured: 2 servers → 0). If you depend on an MCP server during a briefing run, this
affects you regardless of which scope you configured it in — use `"harden": false`.

Some limits worth knowing: `~/CLAUDE.md` is still read (`--setting-sources` governs settings, not
`CLAUDE.md` discovery), non-`claude` CLIs get no flags at all because their flag handling is unknown, and
a flag you pass yourself in `provider.argv` wins over ours — the briefing will tell you when that
happens rather than claiming hardening it does not have.

**To turn it all off**, set `"harden": false` inside `provider` in your config. It is all-or-nothing on
purpose: partially re-enabling tools would silently drop every MCP server with no way to decline. The
briefing then carries a warning listing exactly what was given up.

### Which credential gets used — subscription or API credits

The `claude` CLI can bill two ways: the **subscription** you logged into, or **API credits** via an
`ANTHROPIC_API_KEY` in its environment. When that variable is present, it wins.

By default this tool **withholds `ANTHROPIC_API_KEY` from the CLI it spawns**, so you get the
subscription you are already paying for. That default exists because the alternative fails silently
and costs money: a machine-wide key, exported once and forgotten, will quietly re-bill every morning
briefing to API credits with nothing in the output saying so.

```jsonc
"provider": {
  // ...your existing cli / argv / promptVia — all three are required...
  "credential": "subscription"   // default — withhold the key, use the logged-in subscription
  // "credential": "env-api-key" // pass ANTHROPIC_API_KEY through and bill API credits
}
```

A few things worth knowing:

- The withholding applies **whatever CLI you configure and regardless of `harden`** — opting out of
  hardening is not opting into spending.
- It removes exactly one variable *name* — in any letter-case, since environment names are
  case-insensitive on Windows — from **every** spawn of your CLI (the briefing call and the
  capability probe alike). Other credential mechanisms the CLI supports are **not** touched —
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, an `apiKeyHelper` in your user-scope `claude` settings, and
  the AWS/Bedrock/Vertex variables. If you have one of those configured it still applies. This tool
  does not currently tell you which credential a run actually used; that is a known gap, not a
  guarantee.
- **If your CLI authenticates only by API key** (no logged-in session), set
  `"credential": "env-api-key"` — otherwise the key is withheld and the CLI will fail to
  authenticate. The error you see comes from the CLI itself and will not mention this setting.
- `"env-api-key"` needs the key in the environment the tool actually runs in. The scheduled agent
  does **not** inherit your interactive shell — but it *does* inherit anything set with
  `launchctl setenv` or placed in the LaunchAgent plist's `EnvironmentVariables`, which is exactly
  how a machine-wide key reaches it.

### Multiple accounts (failover)

If your CLI is `claude` and you have more than one logged-in account (each under its own config
directory), the tool can fail over when one hits its usage limit:

```jsonc
"provider": {
  // ...cli / argv / promptVia...
  "accounts": [
    { "label": "primary" },                                   // the CLI's default login
    { "label": "backup", "configDir": "/home/you/.claude-b" } // spawned with CLAUDE_CONFIG_DIR set
  ]
}
```

Order is priority. When a run hits a usage-limit response, the account is **marked** until the
reset time the CLI itself states (or a short conservative window when it doesn't state one), and
the next tick uses the next unmarked account; marks expire on their own. With no `accounts` list,
behaviour is exactly the single-login default. If every account is walled the skip message says so — plus, once delivery
resumes, an opening line reports how many briefings the outage actually cost (calendar-aware,
never blaming a closed-laptop weekend on the limit). Which account generated a given
briefing is recorded in the run log (stderr), not in the briefing text itself.

Whether multiple accounts are within your provider's terms is between you and your provider —
the tool just spawns the CLI under the config directory you point it at.

### API providers — bring your own key, or point at a local model

You do not need a coding-agent CLI at all. Set **`provider.api`** and the briefing is generated over
plain HTTP instead, by one of two built-in transports:

```jsonc
// Anthropic, using a key from the environment
"provider": {
  "api": {
    "kind": "anthropic",
    "model": "claude-sonnet-5",        // REQUIRED — the tool deliberately never picks one for you
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```

```jsonc
// OpenAI
"provider": {
  "api": {
    "kind": "openai-compatible",
    "model": "gpt-5",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

```jsonc
// Ollama — a local model. No key, and the connectivity check turns itself off (see below).
"provider": {
  "api": { "kind": "openai-compatible", "model": "llama3.1", "baseUrl": "http://127.0.0.1:11434/v1" }
}
```

```jsonc
// LM Studio — same transport, different port
"provider": {
  "api": { "kind": "openai-compatible", "model": "local-model", "baseUrl": "http://127.0.0.1:1234/v1" }
}
```

`daily-briefing init` can write any of these for you on a fresh machine:

```sh
daily-briefing init --provider anthropic-api     --model claude-sonnet-5
daily-briefing init --provider openai-compatible --model llama3.1 --base-url http://127.0.0.1:11434/v1
# optional: --api-key-env NAME | --api-key-file PATH | --api-key-command "helper --args"
```

There is no `--api-key` flag on purpose: a secret on a command line lands in your shell history and in
the process table.

`--api-key-command` is **split on whitespace and does not interpret quotes** — it is a flag, not a shell.
For a helper whose *arguments* contain spaces, set `provider.api.apiKeyCommand` in the config file as an
argv array instead (init refuses a quoted value rather than silently shredding it):

```jsonc
"apiKeyCommand": ["my-keychain-helper", "--item", "my service", "--field", "password"]
```

Each init flag takes its value as a **separate argument** (`--model gpt-5`), never `--model=gpt-5`.

#### Migrating an existing config

`provider.api` is **mutually exclusive** with `cli` / `argv` / `promptVia`. Adding it means **deleting
those three lines** — the tool refuses to start with both and tells you exactly which keys to remove.
That is a hard error rather than "the API wins, with a warning" because which transport ran (and
therefore which credential was spent) must never be invisible state.

#### Where the key comes from

Four sources, tried **in this order**, first hit wins. Only sources you actually configure are tried —
there is no silent fallback to an ambient environment variable once you have named a file or a command,
because that fallback is how a key you thought you had retired keeps being spent.

| # | Field | What it is |
| --- | --- | --- |
| 1 | `apiKeyEnv` | The **name** of an environment variable. Defaults to `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` when you configure no source at all. |
| 2 | `apiKeyFile` | A path. **Refused** (with a warning, never silently read) if the file is group- or world-readable — `chmod 600` it. |
| 3 | `apiKeyCommand` | An argv **array** whose stdout is the key. This is the keychain hook. |
| 4 | `apiKey` | The key itself, in the config file. Supported, but warns on every run. |

A **loopback** `openai-compatible` endpoint needs no key at all, and its absence is silent — running
Ollama should not warn you every morning.

#### Why there is no built-in OS keychain

Not a punt — a measured conclusion. On macOS the first-party keychain reader does print a secret to
stdout, but for an item created by a different binary it raises an **authorization dialog**; a
background agent running at 07:20 with nobody at the machine cannot answer that dialog, so the failure
mode is *silent non-delivery* — the worst possible outcome for this tool. On Linux the libsecret reader
needs a live D-Bus session and an unlocked keyring, which a systemd user timer often has neither of. On
Windows there is no first-party CLI that prints a stored secret to stdout at all.

So instead, `apiKeyCommand` delegates to whichever helper **you** already trust. It runs your argv with
a 5-second ceiling and takes stdout (trimmed) as the key; nothing the command writes to either stream
is ever echoed into a warning, because stdout *is* the secret.

```jsonc
// macOS keychain (vendor syntax — see `man security`; store the item first)
"apiKeyCommand": ["security", "find-generic-password", "-s", "daily-briefing", "-w"]

// Linux, libsecret (vendor syntax — see `man secret-tool`)
"apiKeyCommand": ["secret-tool", "lookup", "service", "daily-briefing"]

// pass
"apiKeyCommand": ["pass", "show", "daily-briefing/api-key"]

// 1Password CLI
"apiKeyCommand": ["op", "read", "op://Private/daily-briefing/credential"]
```

Any command that prints the key on stdout works — those four are just the common ones.

#### What does *not* apply to an API provider

`harden`, `credential` and `accounts` are all properties of a **spawned child process**: injected argv
flags, a withheld environment variable, and a `CLAUDE_CONFIG_DIR` pointing at a CLI login. None has an
HTTP analogue. They are ignored with one warning each rather than silently, and the posture line in the
run's provenance reads:

```
posture: unhardened (api provider)
```

— not `full` (nothing was hardened, so claiming it would be an unearned claim) and not `degraded`
(nothing malfunctioned). Multi-key API failover is not in this release.

#### The connectivity check follows your endpoint

With an API provider and no explicit `networkProbeHosts`, the pre-run connectivity check probes **your
endpoint's host** instead of the public DNS anycast defaults — which additionally catches DNS failure, a
proxy blocking the API host, and a down gateway. For a **loopback** endpoint it turns itself off
entirely (`[]`), so a local model never costs you the network wait. An explicit `networkProbeHosts` in
your config always wins, `[]` included. It is still a raw TCP connect that sends nothing.


The **one** network call the tool itself makes is a small **connectivity check** before it generates a
briefing (on any run — scheduled or manual — unless you've disabled it): a raw TCP connect to
`networkProbeHosts` (default two public DNS anycast IPs, `1.1.1.1` / `8.8.8.8`) to confirm the network
is up before it invokes your provider. **No data is sent or received** — the
socket is opened and immediately closed — and you can turn it off entirely with `networkProbeHosts: []`
in your config.

The one place your *data* leaves your machine is the **AI provider you choose**. To generate the briefing,
the tool sends a prompt built from your local git activity (commit subjects, changed filenames, branch
names) to your configured provider — e.g. the `claude` CLI, or a bring-your-own API key. That data goes to
*that* provider under *their* terms, exactly as if you'd handed it to their tool yourself. Point it at a
**local model** and nothing leaves your machine at all.

With a **`provider.api`** configuration that prompt is sent by this tool directly to the endpoint you
named — one HTTPS POST per generation attempt, carrying the prompt and nothing else (no system prompt,
no tools, no telemetry) — under that vendor's terms. Two consequences worth stating outright:

- If you point `baseUrl` at a **plain `http://` host that is not loopback**, then **your API key** *and*
  the whole briefing context — commit subjects, file paths, branch names — cross the network **in
  cleartext**: the key travels unencrypted in a request header on every run, and anyone on the path can
  read it. The tool still sends it (a deliberate config is honoured) but warns once per run, naming the
  credential; `http://127.0.0.1` and `http://localhost` are silent, because there is no network hop to
  protect.
- A **query string** on `baseUrl` is sent (a gateway's `api-version=` parameter is load-bearing) but is
  **withheld from every printed surface** — `doctor --json` shows origin + path only, and says when it
  held something back. Do not put a key there: the four supported key sources are the address bar's
  alternative, and a credential in a URL lands in every log line that ever renders the endpoint.
- The **model id** you configure is recorded in the briefing header (`anthropic-api (claude-sonnet-5)`),
  so a change in briefing content can always be traced to the change in configuration that caused it.

In short: the only thing that ever carries your data off the machine is the prompt you route to the AI
provider you picked — everything else (the local `git` reads, the dataless connectivity check) either
stays on your machine or sends nothing.

## License

MIT © Harshil S Jain — see [LICENSE](LICENSE).
