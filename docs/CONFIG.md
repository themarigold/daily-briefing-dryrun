# Configuration reference

The configuration is one JSON file:

- macOS and Linux: `~/.config/daily-briefing/config.json` (`$XDG_CONFIG_HOME/daily-briefing/config.json`
  when `XDG_CONFIG_HOME` is set)
- Windows: `%USERPROFILE%\.config\daily-briefing\config.json`

`daily-briefing init` writes a starting file, and the desktop app's setup writes the same file. The
command-line tool and the app share it. The file is plain JSON: no comments, no trailing commas.

To check a file before you rely on it, run the same validator the engine uses:

```sh
daily-briefing config validate --json --file ~/.config/daily-briefing/config.json
```

It prints a JSON report (`valid`, `errors`, `warnings`) and changes nothing. Most keys are checked
strictly: a value of the wrong shape stops every run with `Config error: …` naming the key. The
optional features (`transcripts`, `verdictPaths`, `recapCampaigns`, `notify`, `updateCheck`,
`provider.accounts`) and the delivery keys `morningTime` and `networkProbeHosts` are lenient instead: a
bad value falls back to the default (off, for the features) with a warning, so a typo there never costs
you the morning's briefing.

Every key is listed below once, with its type, its default, and what it does. A **default** is what
the engine uses when the key is absent. Some keys are also written explicitly by `init`; that is said
where it applies.

## Which repositories

### `repos`

**Type:** array of strings (absolute paths; a leading `~` is expanded) · **Default:** none. `init`
writes the repositories it found under `discoverRoots`.

The repositories to brief on. When this list is present and not empty, `discoverRoots` is not
searched at all.

### `discoverRoots`

**Type:** array of strings (paths; `~` is expanded) · **Default:** none. `init` writes the folder you
ran it from and your home folder.

Folders searched for git repositories when `repos` is absent or empty: the folder itself, its children
and its grandchildren (folders starting with `.` and `node_modules` are skipped).

### `excludeRepos`

**Type:** array of strings · **Default:** none.

To drop a repo you don't want in the briefing (a stale or work checkout), add it to `excludeRepos`, by
absolute path or bare basename. It filters both the explicit `repos` list and anything found under
`discoverRoots`; a bare basename drops every repo with that name.

### `author`

**Type:** `{ "names"?: string[], "emails"?: string[] }` · **Default:** each repository's own
`git config user.email` (or `user.name` when no email is set).

Whose commits count as yours. Each entry is matched literally against git's author field, so list
every email you commit with.

### `excludeCommitPatterns`

**Type:** array of strings (regular expressions) · **Default:** `["^vault backup:"]`.

Commits whose subject matches any pattern are treated as automated noise and left out of the briefing,
including "Today so far". Setting this key replaces the default list; an invalid pattern is ignored
with a warning.

### `lookbackCapDays`

**Type:** number · **Default:** `4`.

How far back, in days, the briefing looks for your last day with commits. "What you did" covers that
day up to midnight today, so a Monday briefing still finds Friday's work.

### `subprojects`

**Type:** array of `{ "repo": string, "roots": string[] }` · **Default:** none. A repository with a
workspace manifest (`package.json` `workspaces`, `pnpm-workspace.yaml`) is split automatically.

Splits one repository into separately labelled projects. `repo` is the repository's absolute path,
exactly as it appears among your repos (`~` is not expanded here); `roots` are project-root globs inside
it, and `"roots": []` keeps the repository as one project even when it has a workspace manifest.

## Which AI writes the briefing

`provider` takes one of two shapes: a command-line tool to run (`cli`, `argv`, `promptVia`), or an HTTP
API (`api`). Never both: the engine refuses to start with both and names the keys to remove.
[docs/PROVIDERS.md](PROVIDERS.md) covers both paths in depth.

### `provider`

**Type:** object (required) · **Default:** none; `init` writes it, using the first of `claude` and
`codex` it finds on your `PATH` (`claude` when it finds neither).

Which AI generates the briefing, and how the engine calls it. The keys below are its fields.

### `provider.cli`

**Type:** string · **Default:** none; `init` writes the absolute path it found.

The AI command-line tool to run. Use an absolute path: a scheduled run gets a minimal `PATH`, so a bare
name that works in your terminal may not be found at 07:20. Required unless `provider.api` is set.

### `provider.argv`

**Type:** array of strings · **Default:** none; `init` writes `["-p"]` for `claude` and `["exec"]` for
`codex`.

Arguments passed to the tool before the prompt. Required unless `provider.api` is set.

### `provider.promptVia`

**Type:** `"stdin"` or `"arg"` · **Default:** none; `init` writes `"stdin"`.

How the prompt reaches the tool: on standard input, or appended as the last argument. Required unless
`provider.api` is set.

### `provider.timeoutMs`

**Type:** number (milliseconds) · **Default:** `120000`.

How long one call to the provider may take before it is abandoned. Raise it for a slow local model or
a large multi-repo window.

### `provider.harden`

**Type:** boolean · **Default:** `true`; `init` writes it explicitly so the opt-out is visible.

When the tool is `claude`, the briefing call runs with its tools, project settings and hooks, and MCP
servers switched off, because commit text from your repos is untrusted input. `false` turns all of it
off. See [provider hardening](PROVIDERS.md#provider-hardening-on-by-default).

### `provider.credential`

**Type:** `"subscription"` or `"env-api-key"` · **Default:** `"subscription"`; `init` writes it
explicitly.

Whether the tool may see `ANTHROPIC_API_KEY`. `"subscription"` withholds it, so the tool uses the plan
you logged into; `"env-api-key"` passes it through and bills API credits. See
[which credential gets used](PROVIDERS.md#which-credential-gets-used--subscription-or-api-credits).

### `provider.accounts`

**Type:** array of `{ "label": string, "configDir"?: string }` · **Default:** none (the tool's own
login).

An ordered failover list for a `claude` tool with more than one logged-in account: when one account
hits its usage limit, the next tick uses the next one. See
[multiple accounts](PROVIDERS.md#multiple-accounts-failover).

### `provider.api`

**Type:** object · **Default:** none (the command-line tool is used).

Generates the briefing over HTTP instead of running a tool, with one of two built-in transports. Its
fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | `"anthropic"` or `"openai-compatible"` | required | Which transport. |
| `model` | string | required | The model id. The tool never picks one for you. |
| `baseUrl` | string | `https://api.anthropic.com` for `anthropic`; required in practice for `openai-compatible` | The endpoint (`http:` or `https:`, no user name or password in it). Name the final URL: a redirect is not followed, so an endpoint that answers with one (an `http://` address that redirects to `https://`, a gateway that moved) fails every attempt. |
| `maxTokens` | positive whole number | `4096` for `anthropic`; omitted from the request for `openai-compatible` | The output-token limit. |
| `apiKeyEnv` | string | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` when no key source is set | The name of an environment variable holding the key. |
| `apiKeyFile` | string | none | A file holding the key (a leading `~` is expanded); refused if group- or world-readable. |
| `apiKeyCommand` | array of strings | none | A command (argv) whose standard output is the key. |
| `apiKey` | string | none | The key itself, in this file. Works, and warns on every run. |

A redirect is refused rather than followed because following it would send the prompt, and for
`anthropic` the key header, to whatever address the redirect names. A plain `http://` endpoint that is
not loopback sends the prompt and the API key unencrypted; the tool still sends them, and warns about it
on every run.

See [API providers](PROVIDERS.md#api-providers--bring-your-own-key-or-point-at-a-local-model).

## When it is delivered

### `morningTime`

**Type:** string, 24-hour `"HH:MM"` in local time · **Default:** `"07:20"`.

The earliest time a scheduled run delivers: the first scheduled tick at or after it generates the
day's briefing. An invalid value falls back to the default and the briefing carries a warning. See
[delivery timing, in full](#delivery-timing-in-full).

### `networkProbeHosts`

**Type:** array of `{ "host": string, "port": number }` · **Default:** `1.1.1.1:443` and `8.8.8.8:443`;
with `provider.api`, your endpoint's host (and `[]` for a loopback endpoint). `init` writes the
default pair explicitly; `init --provider` instead writes the value derived from your endpoint, when
it can derive one.

The hosts a run connects to before calling the provider, to confirm the network is up. It is a TCP
connect that sends no data. `[]` turns the check off, which suits a local model.

### `notify`

**Type:** `"off"`, `"auto"` or `{ "command": string[] }` · **Default:** `"off"`.

A desktop notification when a briefing is delivered. `"auto"` uses `osascript` on macOS and
`notify-send` on Linux, and does nothing on Windows; a `command` array is run with `{title}`, `{body}`
and `{path}` substituted into separate arguments. The body is always the date and the file path, never
briefing text. The desktop app posts its own notification and needs none of this.

## Optional features (all off by default)

### `recapCampaigns`

**Type:** `{ "mode": "off" | "trial" | "on" }` · **Default:** `{ "mode": "off" }`.

On a busy morning, spends one extra model call to group related recap items under campaign headers.
See [recap campaigns, in full](#recap-campaigns-in-full).

### `transcripts`

**Type:** `{ "enabled"?: boolean, "root"?: string }` · **Default:** `enabled` is `false`; `root` is
`~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects` when that variable is set).

When enabled, the engine reads Claude Code session transcripts under `root` on your machine so the
briefing can quote, beside a project, what you asked for there (`— you wrote: "…"`). The quote is
matched after the briefing is generated; transcript text is not added to the prompt.

### `verdictPaths`

**Type:** array of strings (directory paths relative to a repository's root) · **Default:** none.

Marks a suggestion with `⚑ human gate: cites a commit on a configured verdict path` when it cites a
commit that touches one of these directories, for work that needs a person's sign-off. Matched as a
directory prefix, case-insensitively, in every repository; no globs.

### `updateCheck`

**Type:** `{ "enabled"?: boolean, "intervalHours"?: number }` · **Default:** off.

The opt-in update check. When enabled, a run that has just delivered your briefing asks GitHub
whether a newer release exists, provided that run is non-interactive (neither its input nor its
output is a terminal) and was not started with `--json`. In practice that is the scheduled run. It is notify-only: it downloads nothing and installs nothing,
and the answer is only recorded for `status --json` and the desktop app. What is sent: one HTTPS GET
to `api.github.com` for this project's latest release, with this version in the User-Agent and no
query string, plus (after the first answer) GitHub's own cache tag for that release, which is the
same for everyone; no account, machine or install identifier. The result never reaches the briefing
or anything a run prints.

### `updateCheck.enabled`

**Type:** boolean · **Default:** `false`; anything other than `true` means no automatic check at all.

Lets a scheduled run check automatically, right after it delivers your briefing.
`daily-briefing update --check` always checks, whatever this says.

### `updateCheck.intervalHours`

**Type:** whole number from 1 to 720 · **Default:** `24`.

The minimum number of hours between automatic checks, with one hour of slack: a check is due once the
last one is `intervalHours` minus one hour old (minus half the interval, for intervals under two
hours). The slack is what keeps a daily check daily: a scheduled run that delivers a few minutes
earlier than yesterday's would otherwise find the last check not quite 24 hours old and skip a day.
Only a scheduled run that has delivered that day's briefing checks automatically, once its own work is
done; a tick that delivers nothing (the day already done, too early, offline, a failed run) never
checks. No briefing waits for it, and a run in a terminal or with `--json` never checks.

## Tuning and tooling

### `tokenBudget`

**Type:** `{ "maxChars": number }` · **Default:** `{ "maxChars": 200000 }`.

The most characters of git context sent to the model. A larger context is trimmed to fit, least
important detail first, and the briefing notes that it was trimmed.

### `auditJudgeArgv`

**Type:** array of strings · **Default:** none.

Extra arguments for the self-audit's judge only (`bun run audit`, a source-checkout tool), appended
after `provider.argv` so they win on a repeated flag; the briefing itself never uses them. See
[docs/AUDIT.md](AUDIT.md).

## Delivery timing, in full

- **Delivery timing (`morningTime` / `networkProbeHosts`):** the installed agent ticks every 10
  minutes (see `schedule install` in the README) but only *delivers* once it's past your morning time,
  `morningTime` (24h `"HH:MM"` in local time, default `"07:20"`) — every tick before it is a
  silent no-op, and the first tick at or after it (whether that's a scheduled interval fire or the
  wake/login `RunAtLoad` fire) generates and marks the day done. An invalid `morningTime` falls back to
  the default and surfaces a warning in the briefing. Before generating, a non-`--force` run (whether
  the scheduled agent or a manual `run`) also waits briefly for real network connectivity — a raw TCP
  probe against `networkProbeHosts` (when it is not set: two anycast DNS hosts, `1.1.1.1:443` /
  `8.8.8.8:443`, with an AI CLI; with `provider.api`, the endpoint's own host, and none for a loopback
  endpoint) — so a dark-wake tick doesn't burn its provider call before wifi re-associates; if still
  offline after the grace period it skips (no stamp), and the scheduled agent's next 10-minute tick
  retries (a manual run you simply re-run once you're back online). Set `networkProbeHosts: []` to
  **disable** this gate entirely — useful for a local/offline provider that needs no network at all.
  `--force` always bypasses the morning time and the once-per-day marker; on the network step it still
  waits briefly (same bounded poll), but if still offline afterward it **proceeds anyway** — a forced
  run always calls the provider — whereas a non-`--force` run instead skips (no stamp; retried as just
  described).

In plain words: the "morning time" is `morningTime` (**Morning time** in the app), a "tick" is one
scheduled wake-up of the engine, and the "marker" is the engine's record that today's briefing was
delivered, which makes every later tick that day a no-op.

## Recap campaigns, in full

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
