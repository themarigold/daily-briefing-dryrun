# Security policy

## Supported versions

Only the latest release receives security fixes. If you are on an older version, update first and
check whether the problem is still there.

## Reporting a vulnerability

Report it privately through **GitHub private vulnerability reporting**: open
[the repository's Security tab and choose "Report a vulnerability"](https://github.com/norn-app/daily-briefing/security/advisories/new).
Only the maintainer can read the report.

Please do **not** open a public issue, pull request or discussion for a security problem, and do not
post it anywhere else first. There is no security email address; the private report is the only
channel.

A useful report says:

- the version (`daily-briefing --version`) and your platform;
- what an attacker controls (for example, a commit subject in a repository you cloned) and what they
  gain;
- the steps to reproduce it, ideally with a throwaway repository rather than real data.

This is a one-maintainer project. Reports are read and answered on a best-effort basis, without a
promised response time. A confirmed problem is fixed in a new release.

There is **no bug bounty**.

## Threat model

`daily-briefing` runs on your own machine, reads your local git history, and sends a prompt built from
it to the AI provider you configured. It has no server and no account. Its only other network traffic is
a connectivity check that sends no data; only if you turn the calendar on, one HTTPS GET per private
calendar link you added, to that link's own host, following at most three redirects and only within the
same domain, on each run and each time the desktop app reads them live (when you move onto the calendar
slide or the last slide and, while either is shown, when its window regains focus, when you turn the
calendar on, when a meeting card or Join button finds the last read out of date, and every five
minutes); only if you turn the update check on or ask for one, one
anonymous request to `api.github.com` for the latest release version; only in a partial clone (one made
with `--filter`, or by `scalar clone`), the file contents git itself downloads from that repository's own
remote when the tool reads its history; and, only if the Bun runtime the engine is built with itself
crashes, on macOS and Windows, Bun's own crash trace to `bun.report` (no source code or personal
information, per Bun), which the desktop app and the macOS schedule turn off. When you press an Open on
GitHub button in the desktop app (Open PR, Open branch, Compare or a commit's arrow), your browser opens
that page, so the owner, repository and branch names
in its address, and its PR number or commit ID, go to `github.com` through your browser; the GitHub links
switch turns these off. `git` also runs any helper
programs your own git configuration names (diff drivers, fsmonitor hooks, filters such as Git LFS's), and what those
contact is up to them. The README's [Privacy](README.md#privacy) section lists all seven destinations the
tool itself reaches.

**The main risk is prompt injection.** The prompt contains commit subjects and branch names from every
repository it reads, and that text is not necessarily yours: anyone who can push a commit or name a
branch in a repository you cloned writes part of your prompt. If the AI tool generating the briefing
can run tools, load project hooks or start MCP servers, a hostile commit subject becomes a route to
running code on your machine.

The mitigation is **provider hardening, on by default**: when the configured tool is `claude`, the
briefing call runs with its built-in tools disabled, project and local settings (and therefore project
hooks) ignored, filesystem-configured MCP servers ignored, no session transcript written, and a private
working directory. [docs/PROVIDERS.md](docs/PROVIDERS.md#provider-hardening-on-by-default) lists every
flag, what each does, and the limits. Turning hardening off (`"harden": false`) gives that protection
up, and the briefing then says so.

**AI summaries add one more call.** AI summaries are off unless you turn them on. With them on, a delivered
briefing on a day that is not quiet makes a second AI call, if the page has at least one project card.
Generating the same day's briefing again can make another when it is delivered. It goes to the same
provider entry that wrote the briefing, with one try and no fallback, and with the same hardening: a CLI
that refuses a hardening flag ends the attempt, with no retry without the flags. If it is your key source,
your `apiKeyCommand` runs again for this call. The saved page is not the same text as the morning's prompt:
it also holds lines that prompt never carried, such as merged pull requests' lines, but it is repository
text of the same kind, so the same risk applies. An attempt is locked when it cannot act on what it reads:
[PROVIDERS.md](docs/PROVIDERS.md#calendar-locked-and-unlocked-attempts) lists which are. Every attempt leaves
out the computer's name, the page's warning and notice lines and the line that names the provider. A locked
attempt gets the saved page. An unlocked attempt after an unlocked morning gets the saved page with the
calendar section's body replaced by schedule shape: times, busy blocks and attendee counts, with no event
title, location or attendee names. The calendar section also carries today's date, the current time and your
time zone and, when a calendar source could not be read fully, that source's id, which can hold a name, as in
`work-alice`. An unlocked attempt after a locked morning makes no call. If you turned `transcripts` on,
the call includes the page's `— you wrote` quotes from your sessions, up to 600 characters each. No call is made when AI summaries
are off or on a quiet day. No live details are added. The result shows only on the desktop app's slides. The
call is still made with the slides off or with no desktop app, because the engine cannot read that app
setting. The result is stored at `<state>/briefings/<date>.<hash>.<version>.summary.json`. It stays after you
turn AI summaries off, and other dates' files are not pruned; it goes with the briefing archive when
Uninstall removes the engine's data. A locked attempt's text may name a meeting. AI summaries are not
available on Windows yet. No summary call is made on Windows.

In scope, for example:

- a way for repository content (commit subjects, branch names, file names, stash messages) to make
  `daily-briefing` itself run a program, write outside its own state folder, or reach any network
  destination the README's [Privacy](README.md#privacy) section does not list, or send your data
  anywhere but the provider you configured;
- a way around provider hardening while it is on, or a briefing that claims hardening it does not have;
- an API key or other credential reaching output, logs, `doctor --json`, or a request where it does not
  belong;
- the desktop app reaching anything beyond what its permissions file grants.

## Out of scope

- **Your own AI tool, its hooks and its MCP servers.** Depending on how you configured it, the AI tool
  may start programs this tool never sees: your own hooks run shell commands, and your MCP servers
  (including ones that come with plugins) run as child processes. Their behaviour, and anything they do
  with the prompt, belongs to that tool and its configuration. Hardening narrows this for `claude`; it
  cannot vouch for the tool itself.
- **Programs your own git configuration names.** When the tool reads a repository, `git` runs the diff
  drivers, filters and fsmonitor hook your git configuration sets up. What they do belongs to them
  and to that configuration.
- **The AI provider's service.** What happens to the prompt after it reaches the provider you chose is
  governed by that provider's terms.
- Problems that require an attacker who can already run code as your user, edit your config file, or
  replace the installed binary.
- The macOS app being ad-hoc signed and not notarized: that is a known, documented property of this
  release ([docs/INSTALL.md](docs/INSTALL.md#macos-the-desktop-app)), not a vulnerability.
