# AI providers: which AI writes the briefing

The briefing is written by an AI you already have. There are three ways to connect one, and each needs
something different:

| Path | What you need | Config |
| --- | --- | --- |
| **An AI coding command-line tool** (the default) | `claude` or `codex` installed and logged in. Usage counts against whatever the tool is logged into; for `claude`, see [which credential gets used](#which-credential-gets-used--subscription-or-api-credits). | `provider.cli`, `provider.argv`, `provider.promptVia`; `init` writes them |
| **An API key** | A key for Anthropic, or for any OpenAI-compatible service, and a model id. Usage is billed to that key. | `provider.api` with `kind`, `model` and a key source |
| **A local model** | A model served on your machine by Ollama, LM Studio or anything else OpenAI-compatible. No key, and the prompt never leaves your machine. | `provider.api` with `kind: "openai-compatible"` and a loopback `baseUrl` |

Each morning's briefing makes **one generation call** to that tool or endpoint, on your plan or key. A
morning on which the provider fails is retried, so it can make a few more; optional features that add a
call (such as [`recapCampaigns`](CONFIG.md#recapcampaigns)) are off by default. Every key below is also listed in
[the configuration reference](CONFIG.md#which-ai-writes-the-briefing).

The rest of this page is the detail: how a `claude` tool is locked down for the briefing call, which
credential it spends, failover between accounts, and the API transports.

## Provider hardening (on by default)

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

## Calendar: locked and unlocked attempts

When [the calendar](CONFIG.md#calendar) is on, the prompt carries today's events in one of two forms, and
**the provider picks which at the moment it starts each attempt**, from the exact command line it is about
to run. A *locked* attempt cannot act on what it reads, so it gets every detail; an *unlocked* one gets
each event's schedule shape only (`09:00–09:30 busy (3 people)`), with no event title, location or attendee
names. The calendar section also carries today's date, the current time and your time zone and, when a
calendar source could not be read fully, that source's id, which can hold a name, as in `work-alice`. The
README's [Privacy section](../README.md#todays-calendar-optional-off-by-default) says what each form holds.

| Provider and attempt | Calendar form |
| --- | --- |
| `provider.api` — Anthropic, OpenAI-compatible, or a local model (no tools at all) | locked |
| `claude` with hardening on, all four of `--tools=`, `--strict-mcp-config`, `--setting-sources user` and `--no-session-persistence` injected, and `provider.argv` holding only `--model`, `--fallback-model`, `--output-format`, `--verbose`, `-p`/`--print` or `--max-turns` (with its value, where the flag takes one) | locked |
| `claude` with any other flag in `provider.argv` — including `--mcp-config`, `--settings`, `--add-dir`, `--chrome`, `--ide`, `--agent`, or a flag added to the CLI after this release — or a positional argument | unlocked |
| `claude` that lacks one of the four flags (an older version), or a flag you pass yourself in its place | unlocked |
| `claude` with `"harden": false` | unlocked |
| the retry without the hardening flags, after a CLI refuses them | unlocked |
| `codex`, `gemini`, a wrapper script, or any CLI that is not `claude` | unlocked |

On an unlocked attempt, every calendar event is a busy block in this release. Keeping the title of an event
you organised needs an organizer signal an invitation cannot fake, and neither the Mac Calendar app nor a
Google secret link has one: an invitation naming you as organizer, opened on a Mac and added to your
calendar, reads as yours in both (README, Privacy).

The allow-list is deliberately short and fails safe: a flag it does not know makes the attempt unlocked,
so a new CLI flag that attaches tools cannot quietly receive other people's text. The self-audit's judge
(`bun run audit`) follows the same table for the calendar section it is shown.

## AI summaries: the second call

AI summaries are short project points and a Good morning sentence, generated after your briefing. AI
summaries are off unless you turn them on, in Settings → General → Briefing or with
[`aiSummary`](CONFIG.md#aisummary) in your config.

With them on, a delivered briefing on a day that is not quiet makes a second AI call, if the page has at
least one project card. Generating the same day's briefing again can make another when it is delivered.

It goes to the same provider entry that wrote the briefing, with one try and no fallback. A CLI that
refuses a hardening flag, or a private working directory that cannot be used, ends the attempt: there is
no retry without the flags, and that page keeps its existing card points. If it is your key source, your
`apiKeyCommand` runs again for this call, so a password manager may ask a second time.

What the call gets follows the [table above](#calendar-locked-and-unlocked-attempts), applied to the
summary's own attempt:

- Every attempt leaves out the computer's name, the page's warning and notice lines and the line that names
  the provider. Those can name a key file, a folder or your user name. The saved page itself keeps them.
- A locked attempt gets the saved page.
- An unlocked attempt after an unlocked morning gets the saved page with the calendar section's body
  replaced by schedule shape, with no event title, location or attendee names. The calendar section also
  carries today's date, the current time and your time zone and, when a calendar source could not be read
  fully, that source's id, which can hold a name, as in `work-alice`. If the morning had no events and no
  schedule shape, for example with no calendar connected, the page's own calendar text stays. If the
  prompt budget left room only for the line `TODAY'S CALENDAR omitted: prompt budget too small`,
  that line replaces the body and the call goes with no meeting text. If it had events and there was no room
  even for that line, or the schedule shape could not be built, no call is made.
- An unlocked attempt after a locked morning makes no call, because a locked morning's suggestions may
  repeat meeting details outside the calendar section.
- If you turned [`transcripts`](CONFIG.md#transcripts) on, the call includes the page's `— you wrote` quotes
  from your sessions, up to 600 characters each.

No call is made when AI summaries are off or on a quiet day. No live details are added: what the desktop
app reads live from your calendars never goes into this call.

The result shows only on the desktop app's slides. The call is still made with the slides off or with no
desktop app, because the engine cannot read that app setting. The result is stored at
`<state>/briefings/<date>.<hash>.<version>.summary.json`. It stays after you turn AI summaries off, and
other dates' files are not pruned; it goes with the briefing archive when Uninstall removes the engine's
data. A locked attempt's text may name a meeting.

AI summaries are not available on Windows yet. No summary call is made on Windows.

## Which credential gets used — subscription or API credits

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
  `launchctl setenv`, which is exactly how a machine-wide key reaches it. Do not add a key to the
  LaunchAgent plist's `EnvironmentVariables`: every `schedule install` (the app's scheduler setup
  runs one too) rewrites the plist with a fixed set of variables, so the key is silently lost. For
  a key a scheduled run can rely on, use an API provider (`provider.api`, below) and keep the key
  in a file named by `apiKeyFile`, or behind `apiKeyCommand`.

## Multiple accounts (failover)

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
the **same run** moves on to the next unmarked account; marks expire on their own. The logins come
first in the combined provider list, before any [`fallbacks`](CONFIG.md#fallbacks). With no
`accounts` list (and no `fallbacks`), behaviour is exactly the single-login default. If every
account is walled the skip message says so — plus, once delivery resumes, an opening line reports
how many briefings the outage actually cost (calendar-aware, never blaming a closed-laptop weekend
on the limit). With two or more providers, a briefing opens with a line for each one that was
skipped or not tried, and a cost line when it came from an API key; the run log (stderr) also
names the account that generated it. See
[provider fallback](TROUBLESHOOTING.md#provider-fallback-skipped-not-tried-and-paused).

Whether multiple accounts are within your provider's terms is between you and your provider —
the tool just spawns the CLI under the config directory you point it at.

## API providers — bring your own key, or point at a local model

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

### Migrating an existing config

`provider.api` is **mutually exclusive** with `cli` / `argv` / `promptVia`. Adding it means **deleting
those three lines** — the tool refuses to start with both and tells you exactly which keys to remove.
That is a hard error rather than "the API wins, with a warning" because which transport ran (and
therefore which credential was spent) must never be invisible state.

A config written for a CLI (by `daily-briefing init` or by the app's setup) also carries an explicit `networkProbeHosts` (the
two public DNS hosts), and an explicit value always wins over the endpoint-derived check
([below](#the-connectivity-check-follows-your-endpoint)). Moving to a **local** model, set
`"networkProbeHosts": []`, or a scheduled run with no network is still skipped as offline.

### Where the key comes from

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

### Keys the app stores

The engine has one built-in key store, for app-owned keys. The desktop app uses it whenever you paste a key
([In the desktop app](#in-the-desktop-app), below); from a terminal you reach it through the engine's
`daily-briefing provider key …` commands. `daily-briefing provider key set
--json` reads a key on stdin (never from the command line), stores it under a fresh id `k-<12 hex>`, reads
it back to confirm it, and answers with a **reference** for the config — never the key itself:

- **macOS:** your login Keychain, under the service `daily-briefing.app-key` (one item per id), and the
  reference is an `apiKeyCommand` that runs `/usr/bin/security` to read that one item. The item is created
  and read by that same program, so a background run reads it with no prompt — measured from a launchd-spawned
  job: no dialog appeared. A **locked** keychain is the exception: see
  [the locked-Keychain remedy](TROUBLESHOOTING.md#macos-a-locked-keychain).
- **Linux:** a file `k-<12 hex>.key` (mode 0600) in the state folder's `keys/` (mode 0700), and the
  reference is an `apiKeyFile`. Any `apiKeyFile` inside that folder is read strictly: it must be named
  `k-<12 hex>.key`, be your own, private, single-link regular file, not a symlink, in that private folder —
  or it is refused with a warning, never read the lax way. libsecret is not used: it needs a live D-Bus
  session and an unlocked keyring, which a systemd user timer often has neither of.
- **Windows:** no built-in store — there is no first-party command that prints a stored secret, and the
  key files need POSIX owners and modes. Use `apiKeyCommand` with a helper you trust.

**Piping the key in.** `key set` refuses a terminal on stdin (there is no prompt), and stdin must end within
1 second. Pipe the key from a file or a command, never type it as a literal argument — it would land in your
shell history:

```
cat ~/path/to/anthropic.key | daily-briefing provider key set --json
```

**Saving the reference.** From a terminal, nothing writes the answer into your config for you: copy its
`apiKeyCommand` (macOS) or `apiKeyFile` (Linux) into that entry's `api` block by hand, exactly as answered,
and remove the `apiKey` literal it replaces, if any. The desktop app does this itself.

A key the app stores is **never sent over plain `http:` to another machine**: `config validate` refuses
such an entry, and a run skips it ("refused to send the key over plain http") before reading the key.
Removing keys is `provider key delete` / `key delete-all`, the desktop app's Uninstall with its settings box
ticked ([Uninstall](INSTALL.md#uninstall)), or `bash scripts/uninstall.sh --remove-keys` on a Mac
([A source checkout on macOS](INSTALL.md#a-source-checkout-on-macos)).

### In the desktop app

The app never writes a key into the settings file: a key you paste goes to the store above (the Keychain on
macOS, the key folder elsewhere), and the settings file keeps only the reference.

- **First-time setup.** The Anthropic API path asks you to paste your key, then **Store and test** stores it
  and checks it with one tiny request, billed to your key. A key that fails its test can be tested again,
  used anyway, or discarded. To point at a key you keep yourself instead, tick **Advanced: point at a key
  file or a command instead of pasting** and give a key file (readable by you alone) or a command that prints
  the key. An environment variable does not work there: neither the app nor the background scheduler passes
  your shell's environment to the engine.
- **Settings › AI providers › Providers, in order** is the list ([`fallbacks`](CONFIG.md#fallbacks)): the briefing is
  written by the first provider in it that works. Each provider is one row — its name, what it is in plain words
  and its status (working, key accepted, not working since…, out of usage until…, paused until…, invalid, not
  tested, not saved yet, status unknown, key moved — add a key: its key was removed from the settings file, so
  give it one with **Replace key**) — that opens in place: its status as a sentence, **Try again now** (clears its
  pauses; shown while it is out of usage or paused), its own settings (the first provider's tool and account, or its
  API settings, are edited there; a backup's are shown, and changed by moving it to the top or with Edit settings as
  JSON), its login folder on a Claude row, and **Test**, **Move up** / **Move down**, **Replace key** on a saved API
  entry, and **Remove**. Drag a row, or use **Move up** / **Move down**, to change the order; **Test all** runs each
  row's Test in turn. A line above the list says which provider was skipped today and which one wrote the briefing
  (or, on a day the page names none, that another provider wrote it), when one was skipped. **Add a provider…** asks what you have: a subscription you already have (a command-line
  tool: Claude Code — `claude -p` — or Codex — `codex exec` — or another command with its arguments, one per line),
  an API key (Anthropic, OpenAI, Ollama or LM Studio on this computer — each with its address filled in — or another
  OpenAI-compatible service at an address you give), or another Claude account (another login of your Claude
  command-line tool) — an Anthropic provider behind a gateway, at an address of its own, is added with Edit settings
  as JSON on Settings → Advanced instead, since the guided Add gives Anthropic no address; for an API entry you paste
  its key, and
  **Add and test** stores it and tests the new entry before you save (for a command-line tool it runs the tool once,
  which uses a little of your plan). A second Claude Code on the same login as one already in the list is refused:
  the briefing could not fall back from one to the other, so add it as another login with a login folder of its own. An OpenAI-compatible model running on
  this computer (Ollama, LM Studio, a local vLLM) needs no key: leave the key empty and it is added with none,
  once the engine confirms it needs none (an OpenAI-compatible entry at a loopback address); any other API entry
  with no key is refused, and an OpenAI-compatible one with no address is asked for it. A key the app stores is sent only
  over `https` to another machine. **Try again now**, **Move this key** and **Remove the key written in settings**
  act on the saved list, so save or discard your changes first; **Test** and **Replace key** test the list as
  you have edited it.
- **Replace key** stores the new key, saves it in place of the old one, and clears the marks the old key
  earned (if a briefing is running, the replacement waits for it). The old key stays stored until an
  Uninstall removes your settings and API keys. **Remove** deletes an entry's stored key once you save,
  but only when no other entry uses it, and only for an entry removed with the **Remove** button during this
  visit to Settings. An entry deleted with Edit settings as JSON on Settings → Advanced, or whose removal you save only after leaving
  Settings and coming back, keeps its stored key; an Uninstall removes it. The app knows which stored key an
  entry uses only from the exact command it wrote itself: while any entry's command names the Keychain item
  some other way (one you wrapped by hand, such as `sh -c '…'` or `… | tr -d '\n'`), Remove keeps every
  stored key, and an Uninstall removes them.
- **A key written in the settings file** (a literal `apiKey`, from before) is shown with a banner offering
  **Move this key to the Keychain** (**…to the key folder** off macOS), which stores it and leaves only the
  reference; the entry cannot be tested until then. When one of your own key sources (a key file or a
  command) already holds the place the moved key would take (a command on macOS, a key file elsewhere), or
  ranks below that place so the moved key would be used before it (a command, off macOS), the app offers
  **Remove the key written in settings** instead, and never touches your own source. A source that ranks
  above that place, such as an environment variable, stays in front of the moved key, so the key is moved.
- **The backup.** After a move or a removal, and each time the app opens, the app removes from
  `config.json.bak` any literal key the settings no longer hold. If another file in the settings folder is a
  second name (a hard link) for that backup, the app says so: find it (`ls -li` shows the same number) and
  delete it.
- **Uninstall** removes the keys the app stored when you tick its settings box ("Also remove my settings
  … and API keys"): see [Uninstall](INSTALL.md#uninstall).

### Keys you keep yourself

`apiKeyCommand` delegates to whichever helper **you** already trust. It runs your argv with
a 5-second ceiling and takes stdout (trimmed) as the key; nothing the command writes to either stream
is ever echoed into a warning, because stdout *is* the secret. On macOS, an item **another program**
created can raise an authorization dialog when `security` reads it, which an unattended 07:20 run cannot
answer: the 5-second ceiling then skips that entry ("key couldn't be read"), so store the item with
`security` itself, as below.

```jsonc
// macOS keychain (vendor syntax — see `man security`; store the item first). Your own item, under your
// own service name — not the app's `daily-briefing.app-key`, whose items the app adds and removes.
"apiKeyCommand": ["security", "find-generic-password", "-s", "daily-briefing", "-w"]

// Linux, libsecret (vendor syntax — see `man secret-tool`)
"apiKeyCommand": ["secret-tool", "lookup", "service", "daily-briefing"]

// pass
"apiKeyCommand": ["pass", "show", "daily-briefing/api-key"]

// 1Password CLI
"apiKeyCommand": ["op", "read", "op://Private/daily-briefing/credential"]
```

Any command that prints the key on stdout works — those four are just the common ones.

### What does *not* apply to an API provider

`harden`, `credential` and `accounts` are all properties of a **spawned child process**: injected argv
flags, a withheld environment variable, and a `CLAUDE_CONFIG_DIR` pointing at a CLI login. None has an
HTTP analogue. They are ignored with one warning each rather than silently, and the posture line in the
run's provenance reads:

```
posture: unhardened (api provider)
```

— not `full` (nothing was hardened, so claiming it would be an unearned claim) and not `degraded`
(nothing malfunctioned). To fail over to a second key or provider, see
[`fallbacks`](CONFIG.md#fallbacks).

### The connectivity check follows your endpoint

With an API provider and no explicit `networkProbeHosts`, the pre-run connectivity check probes **your
endpoint's host** instead of the public DNS anycast defaults — which additionally catches DNS failure, a
proxy blocking the API host, and a down gateway. For a **loopback** endpoint it turns itself off
entirely (`[]`), so a local model never costs you the network wait. An explicit `networkProbeHosts` in
your config always wins, `[]` included. It is still a raw TCP connect that sends nothing.

That is the rule for a single provider. With [`fallbacks`](CONFIG.md#fallbacks) (two or more providers),
the check probes your `networkProbeHosts` (or the two default hosts) **plus** every remote API entry's
endpoint host, and a loopback item 1 no longer turns it off — only a list of loopback entries alone (with
no `networkProbeHosts`) or an explicit `[]` does. Offline, such a list still runs its local models: see
[delivery timing, in full](CONFIG.md#delivery-timing-in-full).
