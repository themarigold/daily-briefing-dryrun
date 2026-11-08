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

**Type:** number (milliseconds) · **Default:** `120000` (2 minutes) for a command-line provider;
`300000` (5 minutes) when `provider.api` is set.

How long one call to the provider may take before it is abandoned. Raise it for a slow local model or
a large multi-repo window. An API provider gets the longer default so a long reply (up to
[`maxTokens`](#providerapi)) is not cut off by the clock first; a value you set always wins.
A reply close to the 16,000-token cap may need more than the 300 s default on a slow model, so raise
`timeoutMs` if long replies time out.
With the 300 s API default, a hung endpoint can take longer before the run gives up: a single API
provider retries timeouts twice (about 17 minutes in total), while an API provider followed by a
fallback moves on after the 300 s timeout without retrying it.

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
hits its usage limit or fails, the same run moves on to the next one. The logins come first in the
combined provider list, before any [`fallbacks`](#fallbacks). See
[multiple accounts](PROVIDERS.md#multiple-accounts-failover).

### `provider.label`

**Type:** non-empty string · **Default:** `"default"`.

The name of the first provider in the list when it has no `provider.accounts` (an API provider, or a
command-line tool with one login). Limit marks and provider status are kept by this name, so it is
fixed once saved. Beside a non-empty `provider.accounts` list that resolves it is ignored, with a
warning: the first account's `label` names the first entry instead. (Beside an empty `accounts: []`, or a
`provider.accounts` list that does not resolve — "account failover disabled" — it names the first entry as
usual.) Older versions ignore it and use `"default"`.

### `provider.api`

**Type:** object · **Default:** none (the command-line tool is used).

Generates the briefing over HTTP instead of running a tool, with one of two built-in transports. Its
fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `kind` | `"anthropic"` or `"openai-compatible"` | required | Which transport. |
| `model` | string | required | The model id. The tool never picks one for you. |
| `baseUrl` | string | `https://api.anthropic.com` for `anthropic`; required in practice for `openai-compatible` | The endpoint (`http:` or `https:`, no user name or password in it). Name the final URL: a redirect is not followed, so an endpoint that answers with one (an `http://` address that redirects to `https://`, a gateway that moved) fails every attempt. |
| `maxTokens` | positive whole number | `16000` for `anthropic`; omitted from the request for `openai-compatible` | The output-token limit. Lower `maxTokens` if your model's output limit is below 16000. |
| `apiKeyEnv` | string | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` when no key source is set | The name of an environment variable holding the key. |
| `apiKeyFile` | string | none | A file holding the key (a leading `~` is expanded); refused if group- or world-readable. A file in the state folder's `keys/` is an app-owned key: it is read strictly (named `k-<12 hex>.key`, your own private single-link regular file, not a symlink) and never sent over plain `http:` to a non-loopback host — see [Keys the app stores](PROVIDERS.md#keys-the-app-stores). |
| `apiKeyCommand` | array of strings | none | A command (argv) whose standard output is the key. |
| `apiKey` | string | none | The key itself, in this file. Works, and warns on every run. |

A redirect is refused rather than followed because following it would send the prompt, and for
`anthropic` the key header, to whatever address the redirect names. A plain `http://` endpoint that is
not loopback sends the prompt and the API key unencrypted; the tool still sends them, and warns about it
on every run.

See [API providers](PROVIDERS.md#api-providers--bring-your-own-key-or-point-at-a-local-model).

### `fallbacks`

**Type:** array of provider blocks, each with a `label` · **Default:** none (only `provider` runs).

The providers to try, in order, after `provider` and its `provider.accounts` logins. The whole list is
`provider`'s logins first, then these. Each entry is written like `provider` — a command-line tool
(`cli`, `argv`, `promptVia`) or an `api` block on its own — plus:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `label` | non-empty string | required | The entry's name. Unique across the whole list, and fixed once saved: marks and status follow it, not the position. |
| `configDir` | string | none (the tool's default login) | A login directory, for a `claude` entry only (a leading `~` is expanded). |
| `timeoutMs` | positive number | `120000` for a command-line entry, `300000` for an `api` entry | This entry's per-attempt timeout. It does not inherit `provider.timeoutMs`. |

```jsonc
"fallbacks": [
  { "label": "Anthropic key",
    "api": { "kind": "anthropic", "model": "claude-sonnet-5", "apiKeyEnv": "ANTHROPIC_API_KEY" } },
  { "label": "Local model", "timeoutMs": 600000,
    "api": { "kind": "openai-compatible", "model": "llama3", "baseUrl": "http://127.0.0.1:11434/v1" } }
]
```

An entry is checked exactly as `provider` is. A broken entry is skipped at run time, with a warning
naming it (`fallbacks[1] "Local model": …`), and the rest of the list still runs; `config validate`
reports it as an error, so the desktop app will not save it. An entry is broken when its block is
malformed or it nests `fallbacks` or `accounts`, when its label is already used, when it sets
`configDir` on anything but a `claude` tool, or when it is the same `claude` login (directory and
`credential`) as an earlier entry. A broken `provider` block is still a configuration error.

In the desktop app this list is **Settings › AI providers › Providers, in order**: it adds, orders, tests and removes
entries, and stores a pasted key for you, so the settings file keeps only a reference to it
([In the desktop app](PROVIDERS.md#in-the-desktop-app)). It keeps a CLI login in `provider.accounts` only
while it stays next to item 1 with item 1's settings; every other entry, a newly added login included, is
written as a full `fallbacks` block.
A background schedule running an engine older than this feature uses only your first provider and its
logins: the app's Schedule screen warns about that ([Provider fallback](TROUBLESHOOTING.md#provider-fallback-skipped-not-tried-and-paused)).

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

With [`fallbacks`](#fallbacks) (a list of two or more providers), the check probes these hosts (or the
default pair, when unset) **plus** the endpoint host of every remote API entry, so a reachable provider
counts as online even where the default hosts are blocked. CLI and loopback entries add no host, and a
loopback item 1 no longer turns the check off: only a list whose entries are all loopback (with
`networkProbeHosts` unset) or an explicit `[]` does. An offline run with two or more providers can still
use a local model; see [delivery timing, in full](#delivery-timing-in-full).

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
matched after the briefing is generated, so the briefing's own prompt holds no transcript text. With
[`aiSummary`](#aisummary) on, the page's quotes are sent in the summary's call, up to 600 characters each.

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

### `aiSummary`

**Type:** `{ "enabled"?: boolean }` · **Default:** off by absence.

`{ "enabled": true }` enables short AI project points and a separate Good morning sentence,
generated after your briefing is delivered. An absent key, `{}`, or `{ "enabled": false }` keeps
AI summaries off. CLI `init` leaves the key absent.

What the call sends and where the result is stored are in
[PROVIDERS.md](PROVIDERS.md#ai-summaries-the-second-call). Every attempt leaves out the computer's name, the
page's warning and notice lines and the line that names the provider. The result shows only on the desktop app's slides, and the call is still
made with the slides off or with no desktop app. AI summaries are not available on Windows yet. No summary
call is made on Windows.

A malformed block, a non-boolean `enabled`, or any unknown field switches AI summaries off with
exactly one fixed diagnostic code, `summary-config-invalid`, exposed only through summary status
and Settings. It never adds a warning to the morning briefing, run envelope or process output.

### `calendar`

**Type:** `{ "enabled"?: boolean, "emails"?: string[], "macos"?: object, "links"?: array }` ·
**Default:** off.

Today's calendar in the briefing: a **▶ Today's calendar** section, and today's events in the AI's prompt
so its suggestions fit around your meetings. Off unless `enabled` is `true`. What is read, what each AI
attempt receives and what is stored are in the README's
[Privacy section](../README.md#todays-calendar-optional-off-by-default).

```json
"calendar": {
  "enabled": true,
  "emails": ["me@work.example"],
  "links": [
    { "id": "work", "name": "Work calendar" },
    { "id": "team", "urlEnv": "TEAM_CALENDAR_URL", "owner": "me@work.example" },
    { "id": "home", "urlCommand": ["pass", "show", "calendar/home"] }
  ]
}
```

- **`enabled`** — `true` turns the calendar on. Absent or `false`: off, and the briefing, the prompt and
  `run --json` are exactly what they are without this block.
- **`emails`** — extra addresses that are you, beyond the one a link reveals or names. They recognise
  your accept or decline on an invitation.
- **`links`** — at most 10 private calendar links (an iCalendar address: Google's "Secret address in
  iCal format", Outlook's published ICS link, an iCloud shared link). An iCloud link is a **Public
  Calendar**: anyone with the address can read it, and its events carry no attendees and no replies, so
  `owner` has nothing to match there, an invitation you declined still shows, and every event on it is
  treated as not accepted (its description never reaches the AI). Each entry:
  - **`id`** — 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit; not
    `macos`. It names the link in the briefing and in `calendar status`.
  - **`name`** — an optional label, on one line, that is not a web address.
  - **Where the address comes from — exactly one place, never this file.** A link's address is a
    secret (whoever has it reads that calendar). With neither key below it is read from the link's own
    file, `<state dir>/calendar/links/<id>.url`, which the desktop app or
    `daily-briefing calendar add-link --id <id>` (address on standard input) writes for you, readable only
    by you; the file is refused if anyone else can read or write it, if it is a symbolic link, or if it
    belongs to another user. **`urlEnv`** names an environment variable holding the address instead —
    read only by runs that inherit your shell's environment (a command you type); the desktop app and
    scheduled runs do not see it, so for those use the link's own file or `urlCommand`.
    **`urlCommand`** is a command that prints it: an **array** — the program and each argument as its own
    string, never one shell string — run with a 5-second limit, whose error output is never shown. An
    argument must not be the address itself: one that holds a web address — a scheme separator in any
    spelling (`://`, `:\\`, `:/\`, the JSON-escaped `:\/\/` or the percent-encoded `%3A%2F%2F` / `%3A%5C%5C`),
    or an `.ics` file name after a dotted host (`calendar.example.com/…/basic.ics`) — switches the calendar
    off with its own warning, and `config validate` makes it an error. The one exception is a single
    **leading** 1Password reference, `op://vault/item/field`: it points to the address rather than holding
    it. Password-store entries are fine, `.ics` names included (`["pass", "show", "calendar/work.ics"]`,
    `["pass", "show", "web/calendar.google.com/me"]`). Set
    `urlEnv` or `urlCommand`, not both. Only the source you configured is tried. A literal `url` field
    (any letter case, anywhere in the block) is skipped by a run, with a warning, and refused as an
    error by `config validate`, which the desktop app runs before every save.
  - **`owner`** — the address this calendar belongs to, when the link does not reveal it (Outlook and
    iCloud links, and Google calendars other than your primary one). It recognises your accept or
    decline only.
  - **`confirmedOwner`** — written by setup, not by hand: the address in the link's own path (a Google
    primary calendar's address) that you confirmed is yours when you added the link. It holds only while
    the link still carries that address, so replacing the link with one to someone else's calendar does
    not inherit it.
- **`macos`** — `{ "calendars": "editable" | "all" | [{ "id", "title", "account" }] }`: which Mac
  Calendar app calendars to read (`editable`, the default, skips the ones you cannot edit, such as
  Birthdays and subscribed calendars). Read only on macOS 14 or later, through the Calendar Reader that
  `daily-briefing calendar connect mac` (or Settings → Calendar → Allow access) installs. When access is
  granted, that command adds `"macos": {}` here; with no `calendar` block at all it writes
  `{ "enabled": true, "macos": {} }`, which turns the calendar on. A calendar someone else shared with you can be
  editable too: Settings lists each calendar's account so you can untick it, and the explicit list form
  reads only the ids you chose.

A malformed block switches the calendar off with one warning, rather than reading part of it; no warning
ever quotes a value from the block, so an address pasted into the wrong field is never echoed back.

What the AI is given, and what is kept (the full rules are in the
[Privacy section](../README.md#todays-calendar-optional-off-by-default)):

- **Every HTTP provider counts as locked** and gets every event detail: `provider.api` sends a prompt and
  reads back text, with no tools of its own. A local OpenAI-compatible endpoint that fronts a tool-using
  agent is your own choice; the tool cannot see behind the endpoint.
- **The AI's own suggestions may mention meeting details it was given** (on a locked attempt, an
  attendee's name or a line of a description), and they are stored in your briefing like any suggestion.

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
  endpoint; with two or more providers, see [`networkProbeHosts`](#networkprobehosts)) — so a dark-wake tick doesn't burn its provider call before wifi re-associates; if still
  offline after the grace period it skips (no stamp), and the scheduled agent's next 10-minute tick
  retries (a manual run you simply re-run once you're back online). Set `networkProbeHosts: []` to
  **disable** this gate entirely — useful for a local/offline provider that needs no network at all.
  `--force` always bypasses the morning time and the once-per-day marker; on the network step it still
  waits briefly (same bounded poll), but if still offline afterward it **proceeds anyway** — a forced
  run always calls the provider — whereas a non-`--force` run instead skips (no stamp; retried as just
  described). `run --now` — what the app's **Run now** sends — bypasses the morning time only: the
  once-per-day marker still applies, and on the network step it is a non-`--force` run. A run from your
  own terminal is exempt from the morning time without it.
- **Offline, with two or more providers ([`fallbacks`](#fallbacks)):** a non-`--force` run that is still
  offline after the wait does not skip outright. It runs the list's *leading* loopback entries (local
  models at the front of the list, which need no network) and, from 60 minutes past the morning time,
  *every* loopback entry, in list order; remote entries wait for a later tick. If nothing of those
  delivers, it takes the same quiet offline skip. The same rule applies after a mid-walk re-check: when an
  entry fails and the follow-up network check says offline, the rest of the walk runs only the loopback
  entries that rule permits at that moment, then skips quietly — and an entry whose failure was followed
  by an offline check gets no hour mark and is not recorded as failing (a usage limit is still recorded). A single provider keeps the rule above.

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
staleness bound by **`2 × timeoutMs + 50 s`** — 290 s at a command-line provider's default 120 s
`provider.timeoutMs`, 650 s at an API provider's default 300 s. (The
wider bound only matters when a crashed run's process id has been reused; a crashed run is otherwise
reclaimed at once.) A quiet morning makes no extra call.

In `trial` and `on`, every run that reaches the grouping step — quiet mornings included — appends one
JSON line to `recap-campaigns.jsonl` and prints one count-only `grouping-info [recap-campaigns]:` line
on stderr. The file is append-only and never rotated (about 1 MB a year); delete it whenever you like.
`bun run scripts/recap-campaigns-report.ts` summarises it.
