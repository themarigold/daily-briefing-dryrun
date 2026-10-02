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
  `launchctl setenv` or placed in the LaunchAgent plist's `EnvironmentVariables`, which is exactly
  how a machine-wide key reaches it.

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
the next tick uses the next unmarked account; marks expire on their own. With no `accounts` list,
behaviour is exactly the single-login default. If every account is walled the skip message says so — plus, once delivery
resumes, an opening line reports how many briefings the outage actually cost (calendar-aware,
never blaming a closed-laptop weekend on the limit). Which account generated a given
briefing is recorded in the run log (stderr), not in the briefing text itself.

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

### Why there is no built-in OS keychain

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

### What does *not* apply to an API provider

`harden`, `credential` and `accounts` are all properties of a **spawned child process**: injected argv
flags, a withheld environment variable, and a `CLAUDE_CONFIG_DIR` pointing at a CLI login. None has an
HTTP analogue. They are ignored with one warning each rather than silently, and the posture line in the
run's provenance reads:

```
posture: unhardened (api provider)
```

— not `full` (nothing was hardened, so claiming it would be an unearned claim) and not `degraded`
(nothing malfunctioned). Multi-key API failover is not in this release.

### The connectivity check follows your endpoint

With an API provider and no explicit `networkProbeHosts`, the pre-run connectivity check probes **your
endpoint's host** instead of the public DNS anycast defaults — which additionally catches DNS failure, a
proxy blocking the API host, and a down gateway. For a **loopback** endpoint it turns itself off
entirely (`[]`), so a local model never costs you the network wait. An explicit `networkProbeHosts` in
your config always wins, `[]` included. It is still a raw TCP connect that sends nothing.
