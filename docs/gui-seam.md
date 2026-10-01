# The GUI seam — what Slice 5 may rely on

This pins the contract between the engine and the desktop app. The authoritative register lives in
the completion-build plan (R1); this file is the in-repo copy a Slice 5 contributor will actually
read.

## 1. The app SPAWNS the binary. It cannot import it.

15 of 26 `src/` modules use `Bun.*` APIs, so there is no importable engine. The app's entire API is
argv plus stdout.

| Need | Invocation |
| --- | --- |
| "brief me now" | `<bin> run --force` |
| structured outcome of a run | `<bin> run --json` (stdout) or `--json-out <name>` (a file **beside the stdout envelope**, not instead of it) |
| engine state | `<bin> status --json` |
| health check | `<bin> doctor --json` |
| validate a config about to be written | `<bin> config validate --json --file <path>` |
| **scheduling** | `<bin> schedule install\|uninstall\|status\|verify` |

⚠ **A subcommand must come FIRST.** `<bin> --json status` is REFUSED (exit 2), not treated as
`status`. It used to route to `run` and discard the token, so a Schedule panel polling every few
seconds performed a full pipeline run — provider call, archive, day stamp — and the first poll of the
morning consumed the morning.

⚠ **A bare `--json-out` name lands under the engine's STATE directory, never the cwd.**
`src/json.ts`, `resolveJsonOutPath`: `isAbsolute(p) ? p : join(stateDir, p)`. The app only ever
passes a bare name (§1a), so the file is always `<state>/<name>`; the engine additionally refuses
names it owns there (`briefing.log`, `last-run`, `run.lock`, …).

⚠ **Tier B (recap campaigns) adds one state file, `<state>/recap-campaigns.jsonl`** — the trial record
(README, *Recap campaigns*). `status --json` lists it as `paths.recapCampaignsPath` (`src/json.ts`,
`statePaths()`), and `engineOwns` refuses it as a `--json-out` target (`"recap-campaigns record"`). It is
written only when the config's `recapCampaigns.mode` is `trial` or `on` — one appended JSON line per run
that reaches the grouping step — and never under the default `off`. The app reads nothing from it. Its
Rust mirror of `paths` (`schedule_state.rs`, `StatePaths`) is `serde(default)` without
`deny_unknown_fields`, so it ignores the new field and needed no change; and the app's own
`json_out_name` could not pass the name anyway (its `.json` suffix is terminal).

### 1a. On the app side, that argv is built in Rust — the webview never spells one (T8)

`gui/src-tauri/src/engine.rs` is the **only** module that spawns the sidecar. It carries an
exhaustive `Operation` enum over the surface above, and exposes **one `#[tauri::command]` per
operation**, so `gui/src-tauri/capabilities/default.json` names the operations the webview may
invoke individually. The webview has **no shell access at all**: `tauri-plugin-shell` is not a
dependency of the shell crate and the capability grants no `shell:*` permission.

| Command | Operation |
| --- | --- |
| `engine_status` | `status --json` |
| `engine_doctor` | `doctor --json` |
| `engine_run` | `run --json [--force]` |
| `engine_run_to_file` | `run --json [--force] --json-out <name>` — `<name>` is a bare `.json` filename, resolved by the engine under its state directory (§1) |
| `engine_config_validate` | `config validate --json --file <path>` |
| `engine_schedule_install` | `schedule install --invoker app [--take-over]` |
| `engine_schedule_uninstall` | `schedule uninstall --invoker app [--take-over]` |
| `engine_schedule_status` | `schedule status --json` |
| `engine_schedule_verify` | `schedule verify --json` — B6/T20; **mutating** (§11) |

Slice 5's shell adds three more (T10/T11/T14). They spawn nothing of their own; `state_snapshot` is
the only one that reaches the engine, and it does so through the same `EngineClient`:

| Command | What it does |
| --- | --- |
| `state_snapshot` | `status --json`, then `schedule status --json`, then **one** `schedule_state::derive` — §7. Also delivers the one-time `app:tray-unavailable` notice (§8a) |
| `open_today` | shows and focuses the `main` window and emits `app:navigate` `"today"`. A Rust command because the capability grants the webview no window permission at all — and even `core:window:default` would not grant `show`, `hide`, `set_focus`, `close` or `destroy` (all five are declared `false` in `tauri-2.11.5/build.rs`) |
| `app_quit` | `AppHandle::exit(0)` — and it **refuses** until the Quit notice has been shown this session (§8) |

B5 adds five more (T12/T13/T15, §10). None spawns anything but `status --json` — and, for a save,
`config validate --json --file` — through the same `EngineClient`, and none takes a path:

| Command | What it does |
| --- | --- |
| `read_latest_briefing` | `status --json`, then READS `paths.latestBriefingPath`; `null` before the first briefing |
| `read_archived_briefing` | takes a DATE — a real calendar `YYYY-MM-DD`, refused before any spawn — then `status --json` and a READ of `<paths.briefingsDir>/<date>.md` |
| `config_read` | `status --json`, then READS `paths.configPath`; a stored literal API key is replaced by a placeholder |
| `config_save` | JSON text + the base token `config_read` returned → the validated, atomic save (§10) |
| `config_offer_notify_auto` | the Quit dialog's offer: the engine's `notify` → `"auto"`, through `config_save`'s pipeline |

B6 adds four more (T17, §11). None takes a path or a URL:

| Command | What it does |
| --- | --- |
| `access_snapshot` | `doctor --json` + `status --json` (for the config) + `schedule status --json`, folded into which macOS-protected folders this configuration reaches, the engine's `tcc-denied` advice for each, and the app's own access record. **It also advances `lastLaunchVersion`** — that write is the post-update check (§11) |
| `access_probe` | READS one protected folder **from the app process** — the macOS prompt trigger, and the launch-time revocation detector. Takes a `ProtectedRoot` (`desktop` / `documents` / `downloads` / `icloud`), joined onto the app's own `HOME` in Rust; a directory LISTING, never a file |
| `access_reveal_engine` | reveals the managed engine copy in Finder. The path is re-read from `schedule status --json`'s `binPath`, never taken back from the webview |
| `access_open_settings` | opens one of three fixed System Settings URLs, chosen by a `SettingsPane` (`files-and-folders` / `full-disk-access` / `privacy-root`) |

B7 adds two more (T18, §12). Neither takes a path or posts anything itself — posting is a
Rust-side decision driven by the watcher, gated by the record these two read and write:

| Command | What it does |
| --- | --- |
| `notify_status` | reads the app-owned notification opt-in record, the ENGINE's `notify` value (one `status --json` to locate the config, then a local engine-mirroring read — §12), the resolved-capability predicate's answer computed in Rust, and the suppression log |
| `notify_set_enabled` | takes one boolean; writes `<app_data_dir>/notify-state.json` — the explained ask's answer (a user gesture on the Settings/Schedule UI, and B8's wizard step). Posts nothing |

B8 adds four more (T16 + dev 63, §13). `config_create` spawns nothing but `status --json` and
`config validate --json --file` through the same `EngineClient`; the shim commands spawn nothing
but the two reads:

| Command | What it does |
| --- | --- |
| `config_create` | JSON text → the FIRST config, engine-validated then EXCLUSIVELY created — anything already at the name is `alreadyExists`, never replaced (§13). A literal key — any object key spelled `apiKey`, case-insensitively, anywhere in the document (`apiKeyFile`/`apiKeyCommand` stay legal) — and any `transcripts` block are refused outright |
| `cli_shim_status` | what sits at `/usr/local/bin/daily-briefing`, the target an install would use (`schedule status --json`'s `binPath`, re-read Rust-side), and whose it is (`cli_shim::classify`) |
| `cli_shim_install` | writes the symlink (exclusive; temp+rename to repair a stale one of OURS); refuses a foreign file; a permission refusal carries the exact manual `sudo ln -sfn …` line rather than escalating |
| `cli_shim_remove` | removes only a symlink `classify` calls ours; foreign refused; absent is a no-op |

⚠ **The pinned spellings, as of B8: SEVEN module `COMMANDS` lists concatenated into one, compared
against four external spellings.** `engine::COMMANDS`, `shell::COMMANDS`,
`briefing_files::COMMANDS`, `config_save::COMMANDS` (which B8 grows by `config_create`),
`access::COMMANDS` (B6), `notifications::COMMANDS` (B7) and `cli_shim::COMMANDS` (B8) each own the
names their module defines;
`daily_briefing_gui_lib::all_commands()` is the ordered concatenation, and that is what
`capabilities/default.json`, `build.rs`'s list, `generate_handler!` and the TS invoke scan
(`tests-web/history.check.ts`, set-equality since the B7 fix round) are pinned against
(`the_capability_grants_exactly_the_app_commands`). The handler parse takes an **enumerated module
allowlist** (`["engine::", "shell::", "briefing_files::", "config_save::", "access::",
"notifications::", "cli_shim::"]` — `tests/capability.rs`, grown one module per slice on purpose), not a
wildcard: the easy loosening — strip everything before `::` — would let a command from any module
into the handler unnoticed.

⚠ **The invoker is not a parameter.** `engine_schedule_install`/`uninstall` take `takeOver` only
and pass `--invoker app` unconditionally. The engine's foreign-owner refusal (§3) keys on the
record's `owner` (`src/schedule/install.ts`, `existing.owner !== invoker`), which an install writes
from `--invoker`; a webview that could spell `--invoker cli` could forge the record that refusal
protects, and the Rust side already knows it is the app.

The engine client is Tauri managed state (`engine::Engine`), resolved once at startup. A missing
sidecar does not stop the app from opening; every engine command then rejects with
`{ kind: "sidecarUnresolved", detail: "<path>: …" }` naming the path it looked at.

Exit codes map to a typed `Outcome`: `0` → `delivered` (for `run`, the envelope's `delivered`;
for everything else, "exit 0, here is the payload") or `skipped` with the envelope's own
`skipReason`; `1` and anything else non-zero → `failed`; `2` → `configError` with the engine's
stderr surfaced verbatim. **Malformed JSON degrades to `failed` with the raw output retained,
never a panic** — and the JSON expectation is per-operation, because `schedule install` and
`schedule uninstall` narrate on stdout and have no `--json` form.

Stderr is streamed to the webview as `engine:progress` events, **verbatim** — the engine's
diagnostics are the user-facing explanation, and §5's rendering warnings apply to them. **Stdout is
not streamed**: for the JSON operations it is one envelope that means nothing until it is complete,
and for the narrating ones it arrives whole in `EngineOutcome.stdout`.

**Busy semantics.** Five of the nine engine commands are **mutating** — `engine_run`,
`engine_run_to_file`, `engine_schedule_install`, `engine_schedule_uninstall` and (since B6)
`engine_schedule_verify` (four `Operation` variants: `Run` is both run commands, since `--json-out`
is a field on it) — and at most one of them may be in flight in the app process at a time.
⚠ **`schedule verify` is in that set although its verb reads like a check**: it kicks the REGISTERED
trigger, so launchd runs the engine and a briefing can be generated and the day stamped (§11). A second one does **not queue**: it is refused
immediately with `{ kind: "busy", running: "<the operation already running>" }`, because a second
briefing generation must not be *delayed* into happening. `engine_status`, `engine_doctor`,
`engine_config_validate` and `engine_schedule_status` are **never** blocked by it — a panel that
stopped refreshing while a run was in flight would go quiet exactly when it has the most to show.
The guard is **in-process only**: a `daily-briefing run` started in a terminal is outside it, and
the engine's own `run.lock` is what covers that. The partition is pinned literally by
`the_in_flight_guard_covers_exactly_the_state_changing_operations`, so adding a mutating operation
without adding it to the guard fails a test.

**The `EngineError` union, in full.** Every command rejects with exactly one of four shapes
(`gui/src/lib/engine.ts`; the tag is `kind`):

| `kind` | Fields | When |
| --- | --- | --- |
| `invalidInput` | `field`, `reason` | An operand was refused by the validator. **No process was created.** |
| `busy` | `running` | A mutating operation is already in flight (above). No process was created. |
| `sidecarUnresolved` | `detail` | The bundled sidecar is missing, is not a regular file, or is not executable. Resolved once at startup and returned by every command until it is fixed; `detail` names the path and which of the three it was. |
| `spawn` | `detail` | The spawn itself failed at the OS level. |

An engine that RAN and failed is not an error at this seam — it is an `EngineOutcome` whose
`outcome.kind` is `failed` or `configError`, with the exit code and the engine's stderr.

**What the two operands accept.** `--file` (`engine_config_validate`): an **absolute** path; U+0020
is admitted and so are dot-leading segments (`~/.config/daily-briefing/config.json` and
`~/Library/Application Support/…` are the paths that matter); refused are `.`/`..` segments, NUL,
control characters, non-space whitespace, and Unicode **format** characters (123 of the category's
170 code points — bidi overrides, zero-width joiners, the BOM, the interlinear annotation marks and
the plane-14 tag characters: refused since round 2, widened in round 3, because the engine's own
stderr echoes the path back verbatim, so a rendered path can lie); at most **16 segments** of at
most **64 characters** each. `--json-out` (`engine_run_to_file`): a **bare filename** ending
`.json`, first character ASCII alphanumeric (`first.is_ascii_alphanumeric()`, `engine.rs`'s
`json_out_name`), no separator, no whitespace, no leading dash, ≤ 64 characters before the suffix.
Both are refused **before any process is created**, as `EngineError { kind: "invalidInput" }`
naming the class. `gui/src-tauri/capabilities/README.md` carries the full justification for each
rule.

One surface the app deliberately does not carry: **`init`**. It has no command and no grant —
**and that stayed true through B8**: T16's wizard builds the first config ITSELF, through the
validated `config_create` path (§13), rather than spawning the engine's do-not-clobber writer,
because `init`'s template cannot carry the wizard's choices (its discovery roots would be the APP
process's cwd, its provider only what `--provider` can spell, no floor, no repos selection) and a
post-init edit would be the two-write shape the write-once rule forbids. `calendar` and
`update --check` are in plan R1's forward list and are **not in
the engine**, so the enum — which is exhaustive over the operations the app may perform, i.e. the
engine surface minus `init` and `help`, each excluded deliberately (§1c deviation 4) — has no
variant for them either.

⚠ **`schedule verify` WAS on that list until B6, and the reason it left is not that R1 changed.**
The kickstart is still engine-side: `schedule install` performs it as its final step, and this
operation re-issues **that same engine-side kick**. That is what keeps the app's exec surface
engine-only — the T7 allowlist still needs no `launchctl` entry (plan R1, final-check M1) — while
giving the Schedule & Access panel's post-install loop something to re-run (§11, deviation 76).

### 1c. Deviations from the plan, recorded

The T8 register (R1 wins where it and the appendix conflict), kept here so a Slice 5 contributor
does not have to reconstruct it from a commit message:

1. **No `runs.jsonl` journal** — R1 deleted that arm.
2. **No `run_scheduled()` / tick, no `briefing.log` append** — R1 defers the app-owned tick out of
   0.2.0, and the launchd-equivalence contract belongs to that deferred arm.
3. **`caffeinate` wraps ALL app spawns**, not only scheduled ones (R1 graft).
4. **The `Operation` enum is exhaustive over the operations the app may perform — the engine
   surface minus `init` and `help` — not R1's forward list** (plan line 27).
   `calendar` and `update --check` are in R1 and not in `src/main.ts`'s `KNOWN_COMMANDS`
   (`run | init | status | doctor | config | help | schedule`), so B1's allowlist entries for them
   are dropped rather than given typed commands that cannot work. `init` is out — B5's Settings
   edits an EXISTING config (§10e), and ~~creating the first one is an open B8/T16 design point~~
   **AMENDED IN B8: that design point is CLOSED** — the first config is `config_create` (§13d),
   a create mode beside the save path; `init` STAYS out of the enum (the engine's template cannot
   carry the wizard's choices — §13d's rejected alternative — and :165's reasoning is unchanged).
   **AMENDED IN B6:** this entry read "minus `init`, `help` and
   `schedule verify`" until T20 added `Operation::ScheduleVerify`; the kickstart is still
   engine-side and the new operation re-issues it (§11, deviation 76).
5. **T9's PATH source of truth is `src/schedule/install.ts`'s `pathEnv`**, not the appendix's
   `install.sh:82` — A2 deleted that line with the plist template; the anti-drift test follows the
   real source.
6. **`schedule install`/`uninstall` stay VM-gated against the real engine** (§1b); against a fake
   sidecar they ARE executed end to end through IPC.
7. **Stdout is not streamed** (above) — only stderr reaches `engine:progress`.
8. **The invoker is fixed to `app`** rather than webview-supplied (above).
9. **T9's "capability negative test" is impossible, and is replaced by the absence it would have
   tested.** The appendix asks for *"a capability negative test: an attempt to execute any path
   other than `/usr/bin/caffeinate` is refused"*. There is no spawn scope to negate: with
   `tauri-plugin-shell` gone, the caffeinate path, the PATH and the sidecar's path are arguments to
   a `tokio::process::Command` built inside `engine.rs` and are not reachable from the webview at
   all. The justification is `capabilities/README.md`, section **"No capability entry for the spawn
   itself"**; what IS tested is that the webview cannot reach the shell plugin
   (`the_webview_cannot_reach_the_shell_plugin`) and that no permission mentions it
   (`no_permission_mentions_the_shell`).
10. **`--json-out` takes a bare FILENAME, not a path**, where plan R1 spells `--json-out <path>`.
    Inherited from B1's capability regex and kept: a separator is the one thing that makes traversal
    reachable at this layer. The consequence is real and worth knowing before T10–T15 — the envelope
    can only land in the ENGINE's state directory (`src/json.ts`, `resolveJsonOutPath` joins a
    relative name to the state dir), never in Tauri's `app_data_dir`, so a surface that wants it
    must read it back from where `status` reports. Recorded under `capabilities/README.md`
    **Known gaps**.

### 1b. What the app's suite does NOT execute (VM-gated)

`schedule install` and `schedule uninstall` are never executed against the REAL engine by the
suite. The unit FILE location is redirectable (`DBA_TEST_UNIT_DIR`, `src/schedule/install.ts:130`),
but the registration is a real `launchctl`/`systemctl` call into the live user domain (`:562`) that
no environment variable redirects — so executing either would install or remove a LaunchAgent on
the machine running the tests. Plan line 70's live-domain register owns those legs. Against a FAKE
sidecar they are executed end to end — through real IPC in `tests/capability.rs`, asserting the
literal argv — so the command bodies are covered; only the engine's side of the call is not.

`run` and `run --force` ARE executed, against a sandbox with **no config at all** or a **malformed
one**: measured, the non-forced no-config path exits 0 with `skipReason: "no-config"` before the
run lock, the repo walk and the provider; the forced one exits 2 for the same reason; and a
`config.json` that does not parse exits 2 with `skipReason: "config-error"` from the same catch,
forced or not. No provider is configured or loadable, so none can be called.

## 2. `schedule status --json` is the scheduling API, and it is FROZEN ADDITIVE-ONLY

`ScheduleStatusReport` (`src/schedule/status.ts`) is the whole of it. **Only new, optional fields may
be appended.** A rename, a retype or a narrowed union is breaking and bumps `JSON_SCHEMA_VERSION` —
the same version field the A1 surfaces carry, so a GUI checks one number, not two.

Fields a panel will want first:

- `registered` / `recordPresent` / `unitPresent` — three separate legs, deliberately. A record with
  no unit is "somebody deleted my plist"; a unit with no registration is "on disk but not loaded".
  Collapsing them into one boolean hides both.
- `owner` — `"cli"` or `"app"`. See §3.
- `installedEngineVersion` vs `engineVersion` — **engine/app skew**. This is what the "update
  background engine" prompt keys on.
- `lingerState` — Linux only; `"disabled"` means the timer will silently never fire while logged out.
- `ticksToday` vs `ticksExpectedSinceFloor` — the day-34 diagnostic. A healthy count with a late
  briefing means the *gate* is the defect; a count near 1 means the trigger is not firing.
- `lastTickState` — ⚠ **`ticksToday` is `null`, never `0`, when the heartbeat cannot be parsed.**
  `0` is the value that reads as "launchd never fired", so a pre-2026-08-20 heartbeat line reported as
  `0` would show a healthy machine as a dead scheduler. `"legacy"` means *unknown*, not *none*.
- `experimental` — true on Windows. Label such a schedule experimental; do not present it as working.

## 3. `<state>/schedule.json` decides who owns the trigger

`{ owner, invoker, kind, unitPath, binPath, installedAt, engineVersion }`, written by whoever
installed it. Two schedulers means two concurrent ticks, and the day-marker check is check-then-act —
a single-owner record is what keeps that race unreachable rather than merely narrow.

- The app installs with `schedule install --invoker app`.
- A **foreign owner is REFUSED with exit 2.** Offer the user KEEP-EXISTING (the app becomes a viewer)
  or an explicit `--take-over`. Never replace a configuration the user set up deliberately.
- Exit codes for `install`/`uninstall`: `0` ours · `1` nothing found · `2` foreign owner **or a
  required confirmation refused** (Windows without `--confirm-experimental`: the task XML is written,
  nothing is registered, and **no `schedule.json` is written** — so do not read a 2 as "somebody else
  owns it" without checking `recordPresent`) · `3` error.
  ⚠ **On the app side, `schedule uninstall`'s exit 1 ("nothing found to remove") arrives as the
  typed `Outcome` `{ kind: "failed", reason: null }` with `exitCode: 1` retained.** The classifier
  does not invent a reason string for it and has no separate variant; a panel that wants to render
  "there was nothing to remove" keys on `operation === "schedule-uninstall" && exitCode === 1`,
  not on `reason`.
- Exit codes for `verify`: `0` the kick produced evidence it reached the engine · `1` the kick was
  accepted but produced **no new** evidence · `3` the scheduler refused the kick. ⚠ `outcome:
  "already-delivered-before-kick"` means today's delivery was recorded **before** the kick, so the
  result proves nothing about the trigger — never render it as a successful verification.
- Every label match is **exactly** `local.daily-briefing`. Never prefix-match, never glob: unrelated
  sibling agents (`local.daily_briefing`, `local.daily_briefing_timer`) differ by one character class
  and a loose match would unload somebody else's agent.

## 4. Notifications: the app owns them by default

The engine posts **nothing** unless `Config.notify` is set, and the default is `"off"`.

⚠ **Suppress your own notification only when `notifyArgv(platform, cfg, payload) !== null`** — i.e.
when the engine's config resolves to an actual emitter *on this platform*. Do NOT key suppression on
"notify ≠ off": `"auto"` resolves to nothing at all on Windows, so that test produces a **double
silence** — the engine posting nothing because it cannot, and the app posting nothing because it
thought the engine would. `notifyArgv` is exported and pure precisely so this predicate is cheap.

⚠ **The predicate has TWO known residuals, and both point toward double silence.**

**Linux.** `"auto"` on Linux resolves
to a `notify-send` argv **whether or not that binary is installed** (`src/notify.ts:105-112`), because
`notifyArgv` is pure by contract: a predicate a GUI evaluates cannot do a PATH lookup. So on a Linux
box without `notify-send`, an app keying on "non-null ⇒ the engine will post" suppresses itself while
the engine posts nothing — the same double silence, reached from the opposite direction. The engine
does check PATH before spawning (`notify()`), so it never spawns a missing binary; the gap is only in
what the predicate PROMISES. Mitigation, and why this is narrow rather than contended: an
`--invoker app` install leaves engine notify `"off"`, so in the configuration where both components
exist the app is unambiguously the notifier and the predicate returns null anyway. An app that wants
certainty on Linux can check `notify-send` on PATH itself before trusting a non-null result.

**macOS — and this one sits in a configuration the app itself OFFERS** (registered in the B7 fix
round, deviation 119). `engine_will_notify("macos", "auto")` is true, so the app suppresses its
DELIVERED banner — but the engine's own module header (`src/notify.ts:3-8`) says an `osascript`
banner "may not post at all from a launchd agent", and a launchd agent is EXACTLY how the engine
runs. So a user who takes the Quit dialog's or the autostart-off toggle's `notify: "auto"` offer
may get the engine posting nothing while the app suppresses itself: a double silence no app-side
check can detect (whether osascript's banner appears is not observable from another process —
resolving it is a VM leg, §12c). What B7 does about it: the OFFER and status copy is HEDGED — no
surface promises the engine's banner appears ("expected to post … if your setup shows its
banner"; the Quit body names the setup, not only the setting; the suppression log says
"configured to cover it", not "covered it") — and the predicate itself is deliberately NOT
second-guessed (dev 110: the port mirrors the engine's stated contract; inventing an app-side
"osascript probably won't work" heuristic would contradict the engine's own resolution and §4's
one-predicate rule).

An `--invoker app` install leaves engine notify `"off"`; an `--invoker cli` install may offer
`"auto"`. A re-run preserves the existing value and owner rather than resetting them.
⚠ **"May offer" is forward-looking on the ENGINE side: measured in B7, no install of either
invoker touches `notify` at all** (`src/schedule/install.ts` has no reference to it; the one
`notify(...)` call in the engine is `src/main.ts:489`, on the delivered path). There is therefore
nothing for the app to wire for the CLI-invoker arm; the app-side offers are the Quit dialog's and
the autostart-off toggle's (§12).

**B7 BUILT THE APP'S SIDE OF THIS SECTION (T18).** The suppression predicate above is shipped as
`notifications::engine_will_notify` — a member-for-member Rust port of `notifyArgv`'s nullness,
evaluated over the config file the app reads (`status --json` → `paths.configPath`), pinned
against the engine's own function by one fixture table replayed through both implementations
(`src-tauri/tests/fixtures/notify_predicate.json`; `tests/notifications.rs` +
`tests-web/notify.check.ts`). §12 is the whole design. ⚠ **The config READ mirrors the engine
too, not only the predicate** (B7 fix round, deviation 118): it FOLLOWS symlinks, because the
engine's `Bun.file(...).json()` does and a stow/chezmoi-managed config is a symlink in ordinary
use — the app's no-follow discipline for briefing files does not transfer to a file the engine
only reads and the user already controls. What still diverges, registered rather than hidden: a
config over 1 MiB is refused app-side (reads as "off" → the app posts — fail-open, at worst a
double notification, never a double silence), and a JSON shape `serde_json` rejects but Bun's
parser accepts falls the same fail-open way.

## 5. ⚠ Standing warnings for any new render surface

- **`resume[].repo` and `recap[].repo` are DISPLAY LABELS, never filesystem paths.** Do not join them
  onto a path, do not open them.
- **Repo-controlled strings reach the GUI the same way they reach the terminal.** Branch names, commit
  subjects and filenames are attacker-influenced in the general case. Every new render surface must
  re-implement the sanitization boundary (`stripControl` at minimum, escape-first rendering for
  history); inheriting it is not automatic.
- The engine's notification body is a **fixed template** (date + path) for this exact reason. If the
  app builds a richer one, it owns the sanitization. (B7 did — the first-resume-line DELIVERED body;
  deviation 122 records the contradiction and why the app's channel does not have the engine's
  injection class.)

## 6. What the engine will NOT do for you

- **PATH and `caffeinate` are the APP's job on an app spawn (T9).** A GUI app launched from Finder
  or as a login item gets a minimal environment, not the user's shell PATH, so the sidecar would
  fail to find `claude`/`codex`; and the plist wraps the binary in `/usr/bin/caffeinate -i`
  (`src/schedule/units.ts`) so a 30-120s provider call is not interrupted by idle sleep. The app
  reproduces both on **every** spawn, not only scheduled ones (plan R1: "PATH parity + caffeinate on
  app spawns"). ⚠ The PATH's one definition is `installSchedule`'s `pathEnv:`
  (`src/schedule/install.ts`) — **not** `scripts/install.sh`, which no longer sets one: A2 deleted
  the checked-in plist template and moved unit generation into the binary.
  `gui/src-tauri/tests/engine_env.rs` parses that line at test time and compares it to the Rust
  constant, so the two cannot diverge silently. A missing `/usr/bin/caffeinate` falls back to a
  direct spawn with a warning; it never fails the run.
  ⚠ **What `caffeinate -i` actually does to the process tree**, measured, because the command line
  suggests the opposite: it `exec`s the sidecar INTO the spawned pid and forks its assertion holder
  as the sidecar's CHILD. So the pid the app holds is the sidecar; killing that pid (tokio's
  `kill_on_drop`, if the invocation future is ever dropped) kills the sidecar and the caffeinate
  child exits with it — but it does not reach the sidecar's own children (git, the provider CLI, an
  `apiKeyCommand` helper, a `launchctl list`), which is why **every ENGINE spawn is put in a process
  group of its own** and a dropped invocation SIGKILLs the whole GROUP
  (`engine::ProcessGroupKill`; on unix — non-unix keeps `kill_on_drop` alone). A command future is
  never dropped mid-flight (bodies run detached on Tauri's runtime; app exit is `AppHandle::exit`,
  which drops none of them) and there is no cancel command. The ONE shipped drop is the 30 s READ
  timeout on `status`/`schedule status` (`shell::EngineSnapshots` — the watcher AND `state_snapshot`
  read through it; §8, *Engine reads*): it now takes the hung read's sidecar **and** what that
  sidecar forked. A sidecar that outlives its caller during a generation is the engine's
  `run.lock`'s concern, and it handles it.
  ⚠ **The group also detaches the spawn from terminal signals**, which is what a new process group
  means: a Ctrl-C in a terminal running `cargo tauri dev` no longer reaches the sidecar, and neither
  does one interrupting `cargo test`. A bundled app has no controlling terminal, so this is a
  development-only difference — but note the drop path above does NOT bound it, in either case: a
  process killed by SIGINT runs no destructors, so neither `ProcessGroupKill` nor `kill_on_drop`
  fires. A Ctrl-C'd `tauri dev` is bounded by the engine's `run.lock` (a stray generation refuses
  the next one); a Ctrl-C'd `cargo test` is bounded by nothing but the fakes' own sleep durations,
  since `ReapTagged`'s drop does not run either. That is a small, accepted dev-ergonomics
  regression. ⚠ And signals are not the only consequence: a new process group is a BACKGROUND
  group with respect to a dev terminal, so a descendant that opened `/dev/tty` to read would take
  SIGTTIN and stop rather than prompt. Nothing on the droppable read paths is interactive
  (`launchctl list` / `systemctl is-enabled` / `loginctl show-user`); a `git` credential prompt
  during a generation is the candidate if one ever appears, and it would be dev-only for the same
  reason.
- **Nothing but PATH and seven session variables reach the engine from the app** (`HOME`, `USER`,
  `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ` — `engine::FORWARDED_ENV`, pinned by literal). That
  is the same as under launchd, whose plist sets `PATH` only. Two consequences for T15:
  - **The engine's `apiKeyEnv` rung (`src/apiKey.ts`) cannot resolve from the app**, exactly as it
    cannot from launchd: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the app's environment are dropped
    on purpose (`secrets_and_overrides_in_the_parent_never_reach_the_child`). A Settings screen
    that offers an API-key source must steer to `apiKeyFile` or `apiKeyCommand` — never "use the
    environment variable", which would work in `cargo tauri dev` and nowhere else. **B5 (§10g,
    deviation 66):** Settings still SHOWS the `apiKeyEnv` field — it is a valid engine key, and a
    run from the user's own terminal resolves it — with a note that neither the app nor the
    scheduler passes the environment; and the config literal cannot be SET from the app at all
    (deviation 45), which leaves `apiKeyFile` / `apiKeyCommand` as the only app-settable sources.
  - **`EngineClient::with_path_override` REPLACES the launchd PATH, it does not prepend**
    (`a_path_override_replaces_the_launchd_path`). A T15 field whose value is `/opt/x/bin` alone
    would lose `/usr/bin` and with it `git`. T15 must prepend the user's directory to
    `launchd_path(home)` before calling it, or present the field as the whole PATH.
- No app-owned tick in 0.2.0 — the OS scheduler is the only trigger, installed via this subcommand.
- No read-receipt semantics: `stampToday` fires on **generation success**, not on the user having seen
  it. Every EVAL row and the account-failover feature rest on that. Read-receipts are GUI state.
- No JSON *briefing* output. `schedule status --json` is a state surface, outside the eval harness
  entirely; do not confuse the two.

## 7. The schedule state machine is ONE Rust function (T14)

`gui/src-tauri/src/schedule_state.rs`, `derive(status, last_skip, schedule, now) -> ScheduleState`.
**Pure** apart from one stated read — the local zone, to render the delivery clock time: no file I/O,
no clock. `now` is an operand, produced by `now_local()` — the one clock read in the module,
deliberately outside `derive` so a table test can put the machine at any instant. A second pure
function, `next_boundary(status, schedule, now)`, names the next instant at which `derive` over the
SAME envelopes can change (§8, *time*).

**The tray status line and the Schedule screen render the SAME object — and the same sentence.**
`ScheduleState.statusLine` is on the wire; the tray shows it verbatim and so does the screen's
badge. `Schedule.svelte` switches on `state.phase.phase` only to choose the explanatory paragraph.
Neither recomputes a phase, a staleness threshold, a tick count or a delivery date, and a future
surface must not either — a second implementation in TypeScript is the drift `src/json.ts`'s
`StatePaths` docstring exists to prevent, and the visible failure would be a screen that disagrees
with the menu bar about whether today's briefing arrived.

**The phases**, and the precedence they are decided in — *a list is not a precedence, and several
inputs match more than one member at once*:

1. `not-configured` — no config file. Nothing will ever deliver.
2. `config-error{detail, deliveredToday, deliveredAt}` — the config exists and does not load. From
   `status`'s `configError`, which is CURRENT, rather than from the skip record. It outranks
   `delivered` (tomorrow's will not arrive) but CARRIES the delivery, so the line reads
   `Delivered 07:24 · config has an error` rather than a false "not delivered".
3. `not-scheduled` — no `<state>/schedule.json` — then `scheduler-broken` — a record whose unit file
   is gone (`unitPresent: false`) or that the OS does not have loaded (`registered: false`;
   `registered: null`, "could not probe", is NOT broken). **Both ranked above `delivered`
   deliberately**: a briefing that arrived because somebody typed `daily-briefing` is still a
   machine where tomorrow's will not arrive. `recordPresent` is authoritative (§3).
4. `delivered{at}` — `lastRunDate == now.localDate`. `at` is `latestBriefingMtime`.
5. `skipped{reason, detail, iso}` — **today's** skip record, minus the four reasons a higher phase
   already explains (`already-ran`, `below-floor`, `no-config`, `config-error`). A record from
   another local day is ignored: it is yesterday's story and showing it today is the mask
   `clearLastSkip` exists to prevent.
6. `unknown-tick{cause}` — the heartbeat cannot be judged: `legacy` (`lastTickState == "legacy"`),
   `unreadable-instant` (the line parsed but its instant is not `toISOString()`'s shape), or
   `future` (the instant is more than 120 s ahead of this machine's clock). Any later phase would be
   an assertion about a number the app does not have.
7. `agent-stale{lastTick, staleAfterSecs}` — the heartbeat has not advanced in STRICTLY more than
   **2× `intervalSec`** (600 today ⇒ 20 minutes; the interval comes from the schedule envelope and
   is ignored — no staleness at all — when it is outside 1..86400), or there is no heartbeat at all
   and it is past the floor. **Ranked above the floor check**: staleness is a property of the
   TRIGGER and the floor suppresses DELIVERY.
8. `waiting-for-floor{floor, minutesUntilFloor}` / 9. `waiting-for-wake` — the two ordinary mornings.

⚠ **The floor shown is the floor IN FORCE.** `ScheduleState.floor` is formatted from
`morningTime.minutes`, which is what the engine's `parseFloor` uses; for an invalid configured value
that is the default, and `floorWarning` carries the engine's note.

⚠ **`waiting-for-wake` is INFORMATIONAL, never an error.** It is the morning where the laptop was
shut at the floor. The appendix's stated risk for this screen is a GUI that renders it red and makes
the tool feel broken every day. `gui/tests-web/render.check.ts` pins the tone.

⚠ **`last-skip.json` being PRESENT means nothing — switch on `reason`.** `src/main.ts:484-497`: the
record is removed on delivery and recreated ~10 minutes later with `already-ran`, then rewritten
every tick until midnight. On a healthy day it is absent for ~10 minutes and present for ~17 hours.

⚠ **`ticksToday` stays `null`, never `0`, when the heartbeat cannot be parsed**, all the way to the
wire (§2). `Schedule.svelte` renders a null as the word *unknown*.

⚠ **A `limited` skip carries the ENGINE's `detail` line and nothing else.** `limitedSkipMessage`
(`src/main.ts:106-121`) names a reset time only when `isProbe === false` and `until` is present,
because a probe deadline is a one-hour guess. The Rust state mirrors that **by construction**: the
only text the phase carries is that line, and there is no field a reset time could be invented into.
`a_probe_limit_carries_no_reset_time` asserts the whole serialised state contains no reset time for
a probe-marked limit.

⚠ **An unknown skip reason is a typed `Unknown(raw)`, never a crash and never a parse error.** The
vocabulary is pinned against `src/json.ts`'s `SKIP_REASONS` at test time
(`the_skip_vocabulary_matches_the_engine`, which reads every quoted token in the array literal), so
a member added to the engine fails a test here rather than silently rendering as a state with no
wording of its own.

## 8. The shell: tray, menu, close, Quit, time — and what the webview is sent (T10/T11)

**The tray is Tauri CORE** (`tray-icon` cargo feature), not a plugin. The feature makes the
`plugin:tray|*` commands live, which is why the capability no longer grants `core:default` (§8,
*capability*). The menu is `status · Open Briefing · Run Now · Schedule settings · Settings… · Quit`.

- **No install button** (plan R1): install is reachable only through the wizard (T16) or the
  Schedule & Access panel flow, whose component is `gui/src/lib/ScheduleInstall.svelte` — the same
  one T16's step 6 reuses.
- **No "Check for Updates…"** (plan R6(U)): the updater is excluded from 0.2.0.
- **Left-click opens the window on Today** — a left-button RELEASE, decided by the pure
  `shell::tray_click_route` — and the menu is on right-click (`show_menu_on_left_click(false)`).
- **The macOS app menu is tauri's default with its Quit replaced** (`shell::app_menu_spec`): App
  (About, Services, Hide, Hide Others, Show All, Quit ⌘Q), File, Edit, View, Window and Help. Window
  and Help carry tauri's `WINDOW_SUBMENU_ID` / `HELP_SUBMENU_ID`, which is what makes AppKit adopt
  them as the windows menu and the help menu (tauri `src/app.rs:2487-2502`).
- **ONE menu handler** (`shell::on_menu_event`, registered on the builder) serves the tray AND the app
  menu. A tray-level handler also receives app-menu events, so registering both would run each Quit
  twice.

**Close.** Closing the main window **hides it only where a tray is known to exist**
(`shell::close_action`): macOS and Windows with a built tray. With no tray, and on Linux always
(deviation 23), closing is a quit request. `setup` applies that through `shell::after_tray_build`
(table-tested per platform), and builds the tray through `shell::catch_tray_build`, so a tray
backend that PANICS (UNVERIFIED on a host: `libappindicator-sys` panics when no appindicator library
can be loaded) is a failed tray with the in-window notice, not a dead app. The close itself is
handled in the app's run-loop callback (`shell::on_run_event`, installed by `lib.rs` as
`.build(…)?.run(…)`), which also handles macOS `RunEvent::Reopen` — a Dock click on a hidden
window — by showing the window.

**Quit has ONE path** (`shell::request_quit`), over a per-app latch (`shell::ShellState`, managed
state rather than a process global): tray Quit, the app menu's custom Quit item (⌘Q — the default
predefined Quit sends AppKit's `terminate:`, which nothing can intercept), and a close with nothing to
hide into. The first request shows the notice and latches; `app_quit` is refused until then; a
second request exits. The latch is set BEFORE the notice is emitted (pinned with a Rust listener,
which tauri runs inside `emit`). `app_quit` calls `AppHandle::exit(0)` rather than
`std::process::exit`, because `tauri-plugin-window-state` saves the geometry on `RunEvent::Exit`.
Dock → Quit, logout and shutdown bypass the notice (deviation 24).

**The Quit copy is delegated, owned in Rust** (`shell::quit_dialog`), carried in the
`app:quit-requested` payload — and **worded for the state the app last announced**
(`shell::QuitCopy::for_state`; the shipping sink records each snapshot's derived state in
`ShellState` BEFORE it emits, pinned with a Rust listener). It reads the state, not only the
phase, because `not-scheduled` is two different truths:

| Last announced state | Body says | Offers the Schedule screen |
| --- | --- | --- |
| a loaded schedule and a usable config (`delivered`, `waiting-*`, `skipped`, `agent-stale`, `unknown-tick`) | *Quitting does not stop your briefings — the background scheduler keeps generating them while this app is closed. What stops is any notification this app itself would post when one arrives; whether you are told then depends on the engine's own notification setting — and on whether your setup shows its banner — neither of which quitting changes.* (reworded in B7 — T11 rework: since T18 the app posts the arrival notification behind its own opt-in, so this is what quitting actually stops; "would post" keeps it true while the opt-in is off. Hedged in the B7 fix round — deviation 119: "depends ONLY on the setting" promised a banner the engine's own header doubts from a launchd agent) | no |
| `not-scheduled` with no unit present or registered, `scheduler-broken` | nothing is generating briefings in the background, and quitting changes nothing about that; set the scheduler up first | yes |
| `not-scheduled` with a unit present or registered (no ownership record beside it) | a scheduler unit exists but has no ownership record, so the app cannot say whether briefings keep arriving; quitting does not change that unit — the same hedge the Schedule screen makes | yes |
| `not-configured`, `config-error` | quitting changes nothing about the schedule, but nothing is being generated: no usable config | yes |
| no state yet | the app cannot say whether briefings keep arriving; quitting does not change the schedule | yes |

None of them claims to know the engine's `notify` value — `status --json` does not report it, and
an `--invoker app` install leaves it `"off"` (plan T18), which made the first wording
("Notifications will come from the system notifier instead of this app") false in the app's own
default. None of them claims the app's notifications are ON: since B7 (T18) the app posts behind
its own opt-in, and the Scheduled body says "any notification this app itself WOULD post" —
conditional on purpose. The appendix's wording ("briefings will stop
until you reopen") is false under R1 and a test refuses its return. The `notify: "auto"` offer is
TAKEABLE since B5 (`config_offer_notify_auto`, §10) — except on Windows, where the engine's `"auto"`
resolves to NO notifier at all (`src/notify.ts`, `notifyArgv`: `return null` for win32), and where
the app has no usable config or no state yet; there the dialog states the offer and says why
(`shell::offer_unavailable_reason`). Where it is available, App.svelte reads the config when the
dialog opens (`config_read`) and the offer is a button only where taking it would change something
(§10e, *The Quit offer*). ⚠ Like every save, taking it re-writes the WHOLE file in the save format:
a config indented some other way comes back two-space indented.

**Time.** The watcher keeps the last envelopes and wakes at the instant
`schedule_state::next_boundary` names — local midnight, each minute before the floor, the stale
deadline (last tick + 2× interval + 1 s), the end of a future-dated tick — and at least every 60 s
besides. A dead scheduler writes nothing; this is what makes `agent-stale` appear while the app is
open. What a wake DOES depends on what the clock crossed:

- **A real read of both envelopes** when it crossed local midnight, the floor or the stale deadline
  (or the clock went backwards) — `schedule_state::crosses_read_boundary`. `schedule status --json`
  recomputes `ticksToday`, `ticksExpectedSinceFloor`, `lastTickState`, `unitPresent` and
  `registered` on every call (`src/schedule/status.ts`), so a re-derive across those instants would
  pair today's phase with an earlier moment's figures — after midnight, today's countdown with
  yesterday's count.
- **A pure re-derive** (no engine spawn) otherwise: the minute-by-minute countdown, the ≤ 60 s cap.
- **A periodic real read, at most every 5 minutes** (`watcher::UNHEALTHY_READ_EVERY`), while the
  snapshot is `agent-stale`, `scheduler-broken` or `not-scheduled` — the states a `launchctl`
  load/unload changes with no file event at all — or is degraded (no state, or a failed read).

`state:changed` goes out for a time-driven wake **only when the snapshot changed**. Every served
file-event batch is ALSO a real read of both envelopes, and is always emitted.

**What that costs** (each read is `status --json` + `schedule status --json`, two spawns):

| Situation | Engine spawns |
| --- | --- |
| healthy, idle scheduler (`StartInterval 600`) | 2 per tick — 12 an hour (4 for the tick that delivers) — plus 2 at midnight and 2 at the floor; the stale deadline moves with every tick and is never reached |
| dead or unloaded scheduler | 2 every 5 minutes — 24 an hour, 576 a day — plus midnight and the floor |
| something writing continuously | 2 per batch, at most `ceil(d / 1 s) + 1` batches for a burst lasting `d` |
| healthy, but a tick's skip record lands more than the 1 s ceiling after its heartbeat (a slow offline check) | 2 batches per tick — **23 an hour** (MEASURED, see below) |
| unhealthy while ticks still land (`scheduler-broken` with a unit that still fires, or a `schedule status` that keeps failing) | a batch per tick plus a periodic read 5 minutes after each — **25 an hour** (MEASURED) |
| both of the above | **35 an hour** (MEASURED) |

The first three rows are COMPUTED from the loop. The last three are MEASURED, not computed — by the
round-2 cold verifier (source: b4v4), against a fake engine over 2 simulated hours at 60× time;
none of them was measured on a live machine. `tests/watcher.rs` pins each trigger against a
counting source, and the periodic RATE with a 1.2 s period — above the loop's 500 ms poll
(`watcher::RECOVERY_POLL`), so a loop that read on every pass instead of once per period fails it:
no two reads closer than the period, and at most `elapsed / period + 1` of them. (Round 2 pinned
the rate with a 300 ms period, below the poll, where the two are the same count; a per-pass read
passed it.)

**Engine reads.** `state_snapshot` and the watcher read through `shell::EngineSnapshots`, and
**every read runs both `status --json` and `schedule status --json`**. A read that does not exit 0
with JSON is an ERROR carrying the engine's stderr verbatim (it used to be a silent blank). The last
good schedule envelope is kept ONLY as the fallback for a failed `schedule status`: then the
snapshot's `scheduleStale` is true, `error` says why, and the per-read figures (`ticksToday`,
`ticksExpectedSinceFloor`, `lastTickState`) are withheld from `scheduleState` rather than shown as
current. `lastSkip` comes from `status` only (it used to fall back to the schedule envelope's copy,
which a cached envelope could turn into a resurrected skip).

Each read is abandoned after **30 s**. ⚠ **What that kills:** dropping the read drops B3's
invocation future, which SIGKILLs the whole process GROUP the spawn was put in
(`engine::ProcessGroupKill`, unix) — the sidecar (under `caffeinate -i`, which `exec`s into the
spawned pid), its assertion holder, and anything the sidecar forked, such as a hung `launchctl
list`. That last one is what `kill_on_drop` alone could not reach; it used to survive as an orphan,
at most one per timed-out read (deviation 30, retired). ⚠ Reads still overlap — the watcher's own are
serial on its thread, but `state_snapshot` reads through the same `EngineSnapshots` with the same
timeout, concurrently with them — so two groups can be killed at once. MEASURED with a fake that
forks rather than `exec`s (`a_timed_out_read_kills_the_sidecar_and_the_children_it_forked`: the
sidecar pid and the `sleep` child it forked are both gone, and the child is asserted to have been
running first). This is still the only place the shipped app drops an engine future mid-flight.

The watcher start RETRIES with backoff (2 s doubling to 60 s) instead of switching live updates off
for the session, and the tray reads **Engine unavailable** while there is no state. If the watcher's
thread PANICS, it emits one last snapshot — the last state it held, `updatesStopped: true`, and an
`error` saying live updates have stopped — and the tray reads **Live updates stopped — reopen the
app**; it does not go quiet over a state nothing will update. The shipping sink records that
notice, and every later `state_snapshot` (a fresh read) also carries `updatesStopped: true` with
its `error` led by the same notice, so a webview reload does not clear what the tray still says.
The Schedule screen heads that error "This screen is no longer updating on its own", not "Part of
the engine's state could not be read".

**Five plugins, one granted (B7 widened this — it was "two plugins, zero grants" through B6).**
`tauri-plugin-single-instance` exposes no `#[tauri::command]` at all (measured against 2.4.4);
`tauri-plugin-window-state`'s persistence is entirely Rust-side (2.4.1 `src/lib.rs:385-508`), so
its three commands are refused (`the_window_state_plugin_commands_are_not_granted`);
`tauri-plugin-opener` (B6) is a dependency that is never registered, so its commands do not exist
at runtime; `tauri-plugin-notification` (B7) is registered for the Rust-side post and granted
NOTHING (its three live commands are refused —
`the_webview_cannot_reach_the_notification_plugin`); and `tauri-plugin-autostart` (B7) is the ONE
granted plugin — exactly its three-member shipped allow-set, justified grant by grant in
`capabilities/README.md` (§12).

**The capability** is thirty-two entries since B8 (§13 adds `allow-config-create` and the three
`allow-cli-shim-*`; through B7 it was twenty-eight — §12: B7 adds `allow-notify-status` /
`allow-notify-set-enabled` and the three `autostart:*` grants — the first plugin grants it has
carried; `tauri-plugin-notification` is REGISTERED, live and granted NOTHING, the tray posture).
Through B6 it was twenty-three: `core:event:allow-listen`,
`core:event:allow-unlisten`, the **nine** `allow-engine-*` (B6 adds `allow-engine-schedule-verify`),
`allow-state-snapshot` / `allow-open-today` / `allow-app-quit`, B5's `allow-read-latest-briefing` /
`allow-read-archived-briefing` / `allow-config-read` / `allow-config-save` /
`allow-config-offer-notify-auto` (§10), and B6's `allow-access-snapshot` / `allow-access-probe` /
`allow-access-reveal-engine` / `allow-access-open-settings` (§11). NOT
`core:default` — measured, it admitted `plugin:tray|*`, `plugin:menu|*`, `plugin:resources|close` and
`plugin:event|emit`/`emit_to` (a webview-forged `state:changed` reached a Rust listener). And NOT
`opener:*`: `tauri-plugin-opener` is a dependency since B6 and is **never registered on the
builder**, so its commands do not exist at runtime at all
(`the_webview_cannot_reach_the_opener_plugin`). See
`gui/src-tauri/capabilities/README.md`, *Why not `core:default`*.

### 8a. The events and payloads B5, T16 and T18 build on

| Event (Rust → webview) | When | Payload |
| --- | --- | --- |
| `state:changed` | a watched file changed (always; both envelopes re-read); a time boundary, a periodic re-read or a re-derive changed the snapshot (only then); the watcher started or its start failed; the watcher stopped (once, `updatesStopped`) | `Snapshot` |
| `app:navigate` | tray Open Briefing / left-click / `open_today` → `"today"`; Schedule settings → `"schedule"`; Settings… → `"settings"` | `"today" \| "schedule" \| "settings"` |
| `app:run-now` | tray Run Now (after `app:navigate` `"today"`) — the WEBVIEW runs it, so progress has somewhere to land | `null` |
| `app:quit-requested` | the first quit request this session (the latch is already set when it arrives) | `QuitDialog` |
| `app:tray-unavailable` | the tray could not be built — delivered once, from the webview's first `state_snapshot` (the first moment it is known to be listening) | the notice, as text |
| `engine:progress` | (B3) a stderr line from a running engine command | `{ operation, line }` |

`state_snapshot` returns the same `Snapshot`:

```ts
interface Snapshot {
  status: unknown | null;          // `status --json`, uninterpreted; null when the read failed
  lastSkip: LastSkip | null;       // status.lastSkip, lifted out (status ONLY — never the schedule's)
  schedule: unknown | null;        // `schedule status --json`, read with `status` — unless:
  scheduleStale: boolean;          // true: `schedule` is an EARLIER read's (this one failed);
                                   //   scheduleState's ticksToday/ticksExpectedSinceFloor are null
  scheduleState: ScheduleState | null; // null when status could not be read
  error: string | null;            // why part of it is missing or stale; engine stderr verbatim
  updatesStopped: boolean;         // the watcher died; nothing will update this again. Also set on
                                   //   every `state_snapshot` after that, `error` led by its notice
}

interface QuitDialog {
  title: string;
  body: string;                    // worded for the last announced state (§8, *Quit*)
  offerLabel: string;              // the engine `notify: "auto"` offer
  offerAvailable: boolean;         // B5: false only on Windows, with no usable config, or no state
  offerUnavailableReason: string | null; // never null while offerAvailable is false
  scheduleLabel: string | null;    // "Open Schedule" when the body points there; else null
  confirmLabel: string;            // → `app_quit`, which refuses until this notice went out
  cancelLabel: string;
}

interface ScheduleState {
  phase:
    | { phase: "not-configured" }
    | { phase: "config-error"; detail: string; deliveredToday: boolean; deliveredAt: string | null }
    | { phase: "not-scheduled" }
    | { phase: "scheduler-broken" }
    | { phase: "delivered"; at: string | null }
    | { phase: "waiting-for-floor"; floor: string; minutesUntilFloor: number }
    | { phase: "waiting-for-wake" }
    | { phase: "skipped"; reason: string; detail: string | null; iso: string | null }
    | { phase: "agent-stale"; lastTick: string | null; staleAfterSecs: number }
    | { phase: "unknown-tick"; cause: "legacy" | "unreadable-instant" | "future" };
  statusLine: string;              // the tray line; the screen's badge
  floor: string;                   // HH:MM in force
  floorWarning: string | null;
  firstWake: string;
  ticksToday: number | null;       // null = unknown, NEVER 0
  ticksExpectedSinceFloor: number | null;
  lastTick: { iso: string; localDate: string; count: number } | null;
  owner: "cli" | "app" | null;
  invoker: "cli" | "app" | null;
  unitPath: string | null;
  registered: boolean | null;
  recordPresent: boolean;
  unitPresent: boolean;
  engineVersion: string | null;
  installedEngineVersion: string | null;
  engineUpdateAvailable: boolean;  // app-owned AND versions differ
  intervalSec: number | null;      // null when missing or outside 1..86400
  experimental: boolean;
  lingerState: string | null;
}
```

`gui/src/lib/state.ts` is the TypeScript copy; the Rust types are the source.

**The webview components T16 and T18 reuse, and their contracts.**

- **`gui/src/lib/ScheduleInstall.svelte`** — the install/repair flow; T16's wizard step 6 is THIS
  component (plan R1: "the SAME flow component"). Props: `label` (the button text; default
  "Install / repair scheduler"), `purpose` (the take-over button's verb phrase, "Take over and
  {purpose}"), `owner` (`ScheduleState.owner` as last seen — `null` when there is no record), and
  `onfinished(outcome: EngineOutcome)`, called only when `afterInstall` resolves the attempt to
  `done` (`armsVerify` — B7's F2; a failed or foreign-owner attempt does not fire it, nor does an IPC
  rejection). It owns no route and no layout beyond its own controls. ⚠ **The first attempt never
  takes over**: its button always calls `engine_schedule_install` with `takeOver: false`; only the
  foreign-owner dialog's second button retries with `takeOver: true`. The Schedule screen shows ONE
  install/repair control: on `scheduler-broken` its "Repair background scheduler" replaces the
  generic one (the separate "Update background engine" prompt, shown only for app-owned version
  skew, is an update rather than a second repair).
- **`gui/src/lib/ForeignOwnerDialog.svelte`** — props `message` (the engine's stderr, rendered as
  text), `purpose`, `onkeep`, `ontakeover`. KEEP-EXISTING is the first, primary button; take-over is
  the second, marked dangerous.
- **`gui/src/lib/install-flow.ts` `afterInstall(outcome, takeOver, owner) → { stage, message }`** —
  pure. `delivered` → `done` (stdout as the message); `configError` (exit 2) → `foreign-owner` ONLY
  when this attempt did not already take over AND `owner` is non-null and not `"app"`, and
  otherwise → `failed` — both with the engine's stderr verbatim and NO stdout fallback (an exit 2
  with an empty stderr shows an empty message); every other failure → `failed` with the engine's
  stderr verbatim, or its stdout when stderr is empty. A refused take-over is `failed`, never a loop
  back into the dialog.
- **`gui/src/lib/QuitDialog.svelte`** — props `dialog` (the `QuitDialog` payload above, rendered
  verbatim; the component adds no wording of its own), `oncancel`, and optional `onschedule` (shown
  as a button only when `dialog.scheduleLabel` is non-null). Confirm calls `app_quit` and shows the
  refusal if the app is still there. Since B5, when `offerAvailable` is true the offer is a button
  calling `config_offer_notify_auto`, and its one-line result is shown beside it. B5 round 1 adds an
  optional `offer` prop (`lib/settings-model.ts`'s `NotifyOffer`, from `notifyOffer(config_read's
  text)`): `already` and `custom` show a line instead of the button, `checking` shows a line while
  the config is read, and `unknown` (the default, e.g. a failed read) keeps the button.
- **`gui/src/lib/BriefingView.svelte`** (B5) — prop `blocks` (`lib/briefing-md.ts`'s `Block[]`, from
  either renderer). Text nodes only; T18's notification click and any future briefing surface
  should reuse it rather than draw a briefing a second way. Since 2026-09-24 a recap GROUP — a
  `bullet` block and the `nested` run after it — is one native `<details>`, closed by default, with
  the header on its `<summary>` and the members as its body; every member stays in the DOM (§10c).
- **`gui/src/lib/ScheduleAccess.svelte`** (B6) — the folder-access flow, and T16's wizard step 4 is
  THIS component (plan R1's "SAME flow component", as `ScheduleInstall.svelte` is for step 6).
  Props: `snapshot` (`lib/access.ts`'s `AccessSnapshot`, `null` before the first one),
  `launchProbe` (the launch-time revocation check's `ProbeResult`, or `null`), `error`, `onrefresh`
  (the parent re-runs `access_snapshot`) and `refreshing`. It owns no route and no layout beyond its
  own controls, and **renders nothing at all** when `snapshot` is `null` or `supported` is false.
- **`gui/src/lib/ScheduleUninstall.svelte`** (B6) — props `scheduleState` (⚠ not `state`: a local
  binding by that name makes `$state(...)` parse as a store subscription) and `onfinished`. Two
  confirmations: the first names the unit file and the consequence, the second is
  `ForeignOwnerDialog` for a record this app does not own.
- **`gui/src/lib/ScheduleVerify.svelte`** (B6) — props `evidence` (`{ skipIso, delivered }` from the
  pushed `Snapshot`), `trigger` (a counter the parent bumps after an install) and `onfinished`. The
  loop's rules are pure (`lib/verify-flow.ts`).
- **`gui/src/routes/Wizard.svelte`** (B8, T16) — the first-run wizard, §13. Props `scheduleState`
  (⚠ not `state` — deviation 91's rune conflict), `evidence`, `notifyAsk` / `notifyAskError` /
  `onnotifychoice` (the SAME record and copy as the Schedule screen's ask — dev 107), `oncancel`
  (steps 1–5: leaves with NOTHING written) and `onfinished`. It HOSTS `ScheduleAccess` (its step
  4) and `ScheduleInstall` + `ScheduleVerify` (its step 6) — the same flow components, not forks —
  and its rules are pure (`lib/wizard.ts`). Entry: App.svelte routes to it ONCE per session on the
  first snapshot whose phase is `not-configured` (:1180's state); a `Setup` nav button shows while
  that phase holds. `Route` gained `"wizard"`; `NavigateTarget` did not (deviation 54's rule).

## 9. Deviations recorded by T10/T11/T14 (B4)

Numbered from 11, continuing §1c.

**A retired entry keeps its number and its slot** — entries are cited by number from all over: §8
and §8a, §9's own entries and its trailing *What B4 does NOT execute* list, and the code and its
tests (`src/shell.rs`, `capabilities/README.md`, `tests/watcher.rs`). Treat that enumeration as
incomplete and `grep -rn "deviation <n>"` before renumbering anything; renumbering breaks live
references, which is what this convention exists to prevent.
Its headline is struck through and its body says what closed it, when, and what now holds the
property. Note §9's older item 12 uses "retire" in the opposite sense (the entry goes away with its
test); that is that entry's own wording, not this convention.

11. **"Check for Updates…" is omitted from the tray**, where appendix §12 lists it. Plan R6(U)
    excludes the Tauri updater from 0.2.0; a menu item for a capability the build does not have is a
    support ticket with a label on it. `the_tray_menu_is_the_delegated_one` refuses it.
12. **RETIRED in B5.** B4 shipped the Quit dialog's `notify: "auto"` offer as stated-only, because
    the validated config write it needs did not exist yet. B5 builds that path once, for Settings
    (`config_save`), and the offer now uses it (`config_offer_notify_auto`;
    `shell::NOTIFY_OFFER_WRITABLE == true`). B4's `the_notify_offer_states_why_it_cannot_be_taken_yet`
    retired with this entry, as it required; `the_notify_offer_is_takeable_exactly_where_it_can_work`
    pins the replacement table (§10, deviation 49).
13. **`Phase::Skipped` is ONE variant parameterised by a closed `SkipReason`**, not one variant per
    reason. The task text says "one state per `SKIP_REASONS` member"; on the wire it is one state per
    member (`{"phase":"skipped","reason":"offline"}`), and the exhaustive `match` the status line
    writes is over `SkipReason` — including `Unknown(raw)`, which per-reason variants could not have
    carried. `config-error` is the exception, with its own phase (§7).
14. **`crashed` is a skip state too.** The brief enumerates nine reasons; `crashed` is in
    `SKIP_REASONS` and can be the last skip, so it gets a phase and a status line like the rest.
15. **The watcher also watches `last-skip.json` and `schedule.json`**, where appendix T10 names
    `last-run`, `last-tick`, `briefing-latest.md` and `briefings/`. `last-skip.json` because plan R1
    made it the skip source T14 derives from; `schedule.json` because the same task requires
    `schedule status --json` to be re-read "when the schedule file or unit changed", and an install
    or uninstall rewrites that file. **The UNIT half of that requirement cannot be met by watching
    anything**: a `launchctl bootout`/`bootstrap` writes nothing under the state directory. It is met
    by re-reading instead (deviations 28 and 29): every batch reads `schedule status`, the stale
    deadline is a real read, and an unhealthy state is re-read every 5 minutes — so an unloaded or
    reloaded unit shows up within one of those reads, not on a file event. `briefing.log` and
    `run.lock` are excluded on purpose: the log is appended by every tick and the lock churns around
    every run, so both would cost engine spawns per tick to learn nothing.
16. **The debounce is `notify` plus a hand-written coalescer**, not `notify-debouncer-full`. What is
    needed is a scheduler — a 250 ms quiet period AND a **1 s ceiling**, so a continuously-written
    file cannot starve the UI — whose output is "re-read the engine now". `notify-debouncer-full`
    additionally reconstructs renames by file id (`file-id` + `walkdir`), which nothing here reads.
    One dependency instead of three, and the part that can be wrong is a pure struct driven by
    synthetic `Instant`s in `tests/watcher.rs`. Bound: a burst lasting *d* costs at most
    `ceil(d / 1s) + 1` re-reads.
17. **The watcher does not announce its own start.** Its first pass takes the watch and then reads
    the engine once (so a change between the caller's read and the watch is not lost), and emits
    that read only when it differs from what the caller already emitted (`WatchOptions::initial`).
18. **`WatchTargets` carries TWO spellings of the state directory.** `$TMPDIR` is under
    `/var/folders`, `/var` is a symlink to `/private/var`, and FSEvents reports the RESOLVED path —
    so matching only the spelling `status --json` gave yields a watcher that receives every event and
    discards every one. The resolved spelling is replaced whenever the watch is re-taken.
19. **`show_menu_on_left_click(false)`, not the appendix's `menuOnLeftClick`.** Same semantics; the
    latter is deprecated in 2.11.5 (`tauri/src/tray/mod.rs:307`) and `-D warnings` refuses it.
20. **`libc` is a direct dependency, for things the standard library does not expose** (no count —
    the list has already grown once): `localtime_r` (`schedule_state::now_local`); the
    process-group kill's `getpgrp` + `killpg` + `SIGKILL` + `pid_t` (`engine::ProcessGroupKill`,
    added with deviation 30's retirement — std can CREATE a process group via `process_group`, but
    cannot signal one); and `ECHILD`, which `engine::EngineClient::invoke` uses to tell "someone
    else reaped the child" from every other `wait()` failure. The standard library has no local-time
    conversion at all, and `derive` needs today's LOCAL date and the local minutes-since-midnight
    as operands. `libc` was already in `Cargo.lock` through tokio and tauri,
    so this adds an edge, not a crate. **On a non-unix build the fallback is UTC**
    (`schedule_state::utc_civil`, compiled and tested on every platform; only the call site is
    `cfg`-selected): the tray and the Schedule screen show UTC clock times there, and "today" is
    the UTC date, until a local-time source is added. Windows is already `experimental: true` on the
    engine's own scheduling surface, and the screen labels it.
21. **`all_commands()` lives in its own module** (`src/commands.rs`) rather than beside `run()` in
    `lib.rs`. MEASURED: with it in `lib.rs`, `tests/capability.rs` calling it pulled `run()`'s
    `generate_context!` expansion into a test binary that has one of its own, and every `cargo test`
    printed `ld: duplicate symbol '__EMBED_INFO_PLIST'`. Absent at 4e8bd4fb0, present with the
    function in `lib.rs`, absent again with it moved.
22. **`open_today` is granted although no B4 screen calls it.** The tray and the single-instance
    callback reach `shell::open_today` as a plain Rust function; the grant and the TypeScript binding
    exist because T16's wizard and T18's notification click both need the webview to raise its own
    window, and the capability provides no other way at all. This is a deliberate asymmetry with the
    window-state plugin, whose commands are ungranted for the same "nothing calls them" reason: that
    plugin's commands write to `app_config_dir`, and this one shows the window the user is already
    looking at.
23. **On Linux, closing the window never hides it** — it is a quit request (notice once, then exit).
    Appendix §12 and plan R1 require falling back to window-only operation when the tray is
    unavailable, which needs to KNOW it is unavailable; `tray-icon` cannot detect a missing
    StatusNotifierItem host (bare GNOME has none without the AppIndicator extension), so construction
    "succeeds" into an invisible icon, and a hidden window would then be unreachable. UNVERIFIED on a
    Linux host (no host in this build); the policy is pinned as `shell::close_action`. Where
    construction DOES fail (any platform), the webview gets a one-time in-window notice
    (`app:tray-unavailable`), not only a line on stderr.
24. **Dock → Quit, logout and shutdown bypass the Quit notice.** The app menu's Quit (⌘Q) and the
    tray's reach it; the Dock's Quit, logout and shutdown send AppKit's termination, which tao does
    not let an app intercept (no `applicationShouldTerminate`). Recorded rather than papered over;
    quitting does not stop briefings either way.
25. **The frontend tests are `bun test` + a 40-line Bun plugin, and are named `*.check.ts`.** No new
    dependency: `gui/tests-web/svelte-loader.ts` compiles `.svelte` with the project's own
    `svelte/compiler` (server target) and the tests render with `svelte/server`. The `.check.ts`
    names keep the ENGINE suite's `bun test` (run from `daily_briefing_application/`, which recurses
    into `gui/`) from discovering them; `bun run test` in `gui/` passes `./tests-web/*.check.ts`,
    which its shell expands (B5 round 2 — it used to name each file, and a new one was silently
    skipped). SSR does not
    run click handlers, so the install flow's outcome → stage rule is a pure module
    (`gui/src/lib/install-flow.ts`) and the foreign-owner dialog is its own component.
26. **`limited` carries no `{account, until}` fields**, where the brief spells the state
    `limited{account, until only when isProbe===false}`. The engine's `last-skip.json` record has no
    such fields — `limitedSkipMessage` has already folded both into `detail`, and names `until` only
    when `isProbe === false` — so the phase carries that line verbatim and nothing else (§7). A
    structured `account`/`until` would have to be re-parsed out of prose, which is the one thing the
    engine's discipline exists to prevent.
27. **RETIRED in B5.** B4's Today and Settings were placeholders; B5 builds both (T12, T15) and adds
    History (T13), and the tray's "Open Briefing" / "Settings…" items now land on them (§10).
28. **Every engine read runs `schedule status --json` as well as `status --json`; the schedule cache
    is only a fallback.** Round 1 re-read the schedule envelope only when `schedule.json` changed.
    MEASURED in review round 2: that paired a current `status` with an earlier batch's schedule —
    `ticksToday` stayed 4 while `last-tick` said 11, a legacy heartbeat replaced by a valid one stayed
    `unknown-tick`, an unloaded unit stayed `registered: true`. The cost is one extra spawn per engine
    read (§8 has the rates). When the schedule read fails, the last good envelope is still used for
    the derivation, the snapshot says `scheduleStale: true`, and the per-read figures are withheld
    (`null`, "unknown") rather than shown as current.
29. **Time-driven wakes READ the engine at midnight, the floor and the stale deadline, and re-read an
    unhealthy state every 5 minutes.** H1's pure re-derive stays for everything in between. This is
    a deviation from H1's "no engine spawn" wording, deliberately: those are the instants where the
    engine's own answer turns, and the unhealthy states are the ones a unit load/unload changes
    without a file event. A dead scheduler therefore costs 24 spawns an hour (computed, §8); the
    mixed cases cost up to 35 (measured, §8).
30. ~~**The 30 s read timeout kills the sidecar, not its children.**~~ **RETIRED 2026-09-16 — the
    follow-up landed.** The deviation stood while `kill_on_drop` signalled only the spawned pid, so a
    `launchctl list` the sidecar forked survived a timed-out read as an orphan (at most one per
    timed-out read; the watcher's reads are serial, but `state_snapshot`'s run concurrently with
    them, so two could time out at once). MEASURED then with a non-`exec` fake. B4 corrected the
    comments that said this drop never happens in the shipped app (`engine.rs`, comment-only),
    `Cargo.toml`, `capabilities/README.md` and §6. **The B3 follow-up is now implemented**:
    `engine::EngineClient::invoke` spawns each child with `process_group(0)` and
    `engine::ProcessGroupKill` SIGKILLs that group when an abandoned invocation drops it, so the
    sidecar, the `caffeinate` assertion holder and anything the sidecar forked die together
    (`a_timed_out_read_kills_the_sidecar_and_the_children_it_forked` asserts the forked child was
    running and is then gone, and that the sidecar's pgid is its own pid;
    `a_timed_out_read_kills_a_child_that_outlived_the_sidecar` pins the drain-then-`wait()` ordering
    the kill depends on; `a_completed_invocation_leaves_what_the_engine_backgrounded_running` pins
    the inverse — a normal exit must NOT kill the group; and
    `the_process_group_kill_refuses_reserved_ids_and_its_own_group` pins the refusals that keep the
    signal off this app's own group). Unix only; non-unix behaviour is
    unchanged. ⚠ **What it costs, both halves:** (a) the spawn is in its own group, so it no longer
    receives the terminal's signals — a development-only difference (§6); (b) the signal is
    `SIGKILL` with no `SIGTERM` grace and it now reaches descendants, so a descendant can be killed
    mid-write (a `git` left with an `index.lock`, a helper between `tmp` and rename). (b) is a
    property of the mechanism, not a cost paid today: the only shipped drop is the read timeout, and
    the two read operations fork nothing worse than read-only probes (`launchctl list` on macOS,
    `systemctl is-enabled` / `loginctl show-user` on Linux). It becomes a real cost the
    moment a mutating invocation is droppable. Under the old single-pid kill descendants were spared
    only by being orphaned — the thing being closed — and a live `launchctl` left behind every
    timed-out read was judged the worse of the two.
31. **`Snapshot.lastSkip` comes from `status` only.** The fallback to the schedule envelope's copy
    is dropped: `status` is read in every batch and carries the same record, and a cached schedule
    envelope could resurrect a skip the engine had already cleared.
32. **The Quit notice has five bodies, chosen by the last announced STATE, and may offer the
    Schedule screen** (§8, *Quit*). "The background scheduler keeps generating them" is said only
    where a loaded schedule and a usable config exist; "nothing is generating briefings" only where
    no unit is present or registered either — a `not-scheduled` state with a unit beside it gets the
    same hedge as the Schedule screen; no body says the app notifies (it posts nothing until T18). ⚠ For T15/T18: the engine's `notify: "auto"` resolves to NO notifier on
    Windows (`src/notify.ts`, `notifyArgv` returns `null` for win32), so the offer is not a working
    choice there — and B5 withholds it there (§10, deviation 49).
33. **`one_debounced_event_carries_the_state_the_files_describe` allows ONE extra event** (`<= 2`,
    not `== 1`). Two writes 0 ms apart may reach the loop in two backend deliveries, and a delivery
    that arrives after the first batch was served is a correct second read, so an exact 1 would fail
    a correct watcher under load. The bound is not vacuous — MEASURED in review round 2: with the
    debounce switched off the test saw 6 events and went red 3 runs in 3.
34. **A panicking watcher stops LOUDLY and is not restarted.** It emits one last snapshot
    (`updatesStopped: true`, the last state it held, an `error` saying why) and the tray reads "Live
    updates stopped — reopen the app"; every later `state_snapshot` says so too. An automatic
    restart would hide a panic that repeats.
35. **The tray build runs under `catch_unwind`.** UNVERIFIED on a host (source: review round 2):
    `libappindicator-sys` 0.9.0 `panic!`s when no appindicator library can be loaded; `setup` runs on
    the main thread, where tauri builds the tray inline, so that panic would otherwise take the app
    down before its window appears. Caught, it is a failed tray (window-only, with the notice).
36. **The app menu gains an empty Help submenu and tauri's submenu ids**, matching tauri's own
    default: `WINDOW_SUBMENU_ID` / `HELP_SUBMENU_ID` are what make AppKit adopt them as the windows
    and help menus.
37. **An absence window is only valid over a settled backend** (deviation-33 class; recorded here
    2026-09-17 by B23 so the rule outlives its one habitat). The watcher-flake fix (PR #504,
    2026-09-17) established it: macOS FSEvents replays changes made BEFORE the stream existed, so
    a test that populates a directory and then asserts NOTHING is emitted in a window is asserting
    over a backend that still owes it deliveries — the absence check sees an event the test's own
    setup caused, and the "flake" is the test lying about time, not the watcher failing. Every
    absence/exact-count assertion must first drain the backend to quiescence over that directory
    (`settle_backend`). Until this entry the rule lived only in `tests/watcher.rs`'s header
    (its "⚠ AND AN ABSENCE WINDOW IS ONLY HONEST…" correction); it is test methodology, not
    watcher trivia — any future suite watching a directory, socket or log tail inherits it.

### What B4 does NOT execute, and what is therefore UNRUN

Beyond §1b's VM-gated `schedule install`/`uninstall` legs, which are unchanged:

- **The Schedule screen's "Install / repair scheduler" action against the REAL engine.** The
  component, its outcome → stage rule and the foreign-owner dialog's order are tested, and the argv
  is pinned through IPC against a fake sidecar; the registration itself is still the live-domain
  register's.
- **Whether the window is actually hidden or shown.** Closing and Quit are driven through the
  run-loop callback on MockRuntime (`tests/shell.rs`), which proves the close is PREVENTED, the notice
  is shown once and the exit is REACHED — but MockRuntime's `show`/`hide` are no-ops and its
  `RunEvent::Reopen` cannot be constructed outside tauri. What is pinned instead, precisely:
  **close-hides** as the decision (`close_action`, `after_tray_build`, table-tested) plus source
  (the close arm calls `hide_main`, which calls `hide()`); **Reopen-shows** as source ONLY — no
  decision function exists for it — (the arm calls `focus_main`, which calls `unminimize`, `show`
  and `set_focus`, and the arm's only permitted attribute is `#[cfg(target_os = "macos")]`); all
  source pins read the code with `//` AND `/* */` comments stripped.
- **The tray and the app menu as native objects** (and the tray label update): `muda` builds them on
  the main thread through the event loop. Their shape is pinned as data (`tray_menu_items`,
  `app_menu_spec`, including the Window/Help ids), the label as `tray_status_line`, the tray click as
  `tray_click_route`, and the builders' use of the ⌘Q accelerator, the submenu ids and the click
  route as source.
- **A panicking tray backend on a real Linux desktop** (deviation 35): `catch_tray_build` is tested
  with an injected panic, not with a missing `libappindicator`.
- **A real `launchctl` hang.** The read timeout, and the process-group kill that now takes the hung
  sidecar's children with it, are measured with fakes.
- **A second launch focusing the first** (two processes) and **the tray rendering as a template
  image** (a rendered menu bar).
- **`app_quit`'s success branch is now driven**: on MockRuntime `AppHandle::exit` reaches
  `request_exit`, which is `unimplemented!()`, and `tests/shell.rs` catches that panic as "exit was
  reached". The real process exit is not.

## 10. Today, History and Settings (T12/T13/T15, B5)

### 10a. Reading the engine's briefing files

`src-tauri/src/briefing_files.rs`. **Read-only**: every filesystem call opens for reading or stats,
and `tests/briefing_files.rs` hashes the whole state tree (bytes, modes, mtimes) around a browse
session rather than trusting that sentence.

- **No path from the webview.** `read_latest_briefing` takes nothing; `read_archived_briefing` takes
  a date, parsed into `ArchiveDate` — exactly ten BYTES, `YYYY-MM-DD`, a real calendar date (leap
  years, day 0, month 13, year 0000 all refused) — BEFORE any engine spawn. No separator, dot or
  other byte can reach the join, so traversal is unreachable by construction.
- **The directory is the engine's.** Each read runs `status --json` and joins onto
  `paths.latestBriefingPath` / `paths.briefingsDir` — the engine's own full paths, so the file names
  are not re-spelled in Rust either. The archive LIST is `status --json`'s `archivedDates`; nothing
  in the app lists a directory.
- **1 MiB cap** (a briefing is ~8 KB); **UTF-8 required**.
- **Symlink policy: the final component must not be one.** On unix the open carries `O_NOFOLLOW`
  (no check-then-open window) and `O_NONBLOCK` (a FIFO at the path would otherwise hang the open);
  the opened descriptor must be a regular file. Directories above it may be symlinks — the same
  trust the engine extends to them (review round 1 re-examined this and kept it: a parent directory
  is not a trust boundary the app can hold). Off unix the check and the open are two calls. The
  CONFIG read (§10e) additionally refuses a file with more than one hard link; these reads replace
  nothing, so they do not.
- **Rates.** Each read is one `status --json` spawn. Today reads on mount, when the pushed
  snapshot's `latestBriefingMtime` changes, and after a run this app started — not on every
  `state:changed`. History reads once per date the user opens.

### 10b. Today (T12)

`routes/Today.svelte` gathers; `lib/today.ts` decides; `routes/TodayView.svelte` draws.

- **Which renderer.** Under R1 the morning briefing is delivered by launchd, so the app normally
  holds no envelope for it and Today renders `briefing-latest.md` through the escape-first renderer.
  The STRUCT renderer (`lib/briefing-struct.ts`) is used only when ALL of these hold: the last
  `run --json` THIS app started delivered; it carried a struct; its `markdown` is byte-identical to
  the file; and the struct view's blocks show exactly the same lines, of the same kinds, as the
  escape-first renderer's blocks for that `markdown` (`lib/today.ts`, `sameVisibleText`). Anything
  else — including a later CLI `--force` the same day — shows the file. The envelope is held in
  memory only; a webview reload falls back to the file.
- ⚠ **Why the last condition exists (review round 1, H1).** The first cut concluded "the envelope's
  `markdown` is the very string written to the file, so the struct IS the file". That was wrong
  whenever redaction fires: the engine (before Phase E) redacted credentials in the RENDERED string
  only (`src/main.ts`: `const rendered = redactCredentials(renderBriefing(r.struct))`), wrote that,
  and put the RAW `r.struct` in the envelope (`src/json.ts`, `envelopeFrom`: `markdown: rendered`,
  `struct: r.struct`). So `markdown === file` held while the struct still carried keys the file
  showed as `[redacted]`, and Today put them on screen after Run Now — reproduced end to end with the
  real sidecar. **Since Phase E's E1** the envelope's `struct`, `warnings` and `discIssues` are
  redacted by `redactStruct` (`src/json.ts`, via `redactEnvelope`, applied once in `emit` before the
  stdout / `--json-out` split). The check below STAYS as the fail-closed fallback: an engine older
  than E1 still ships the raw struct, and per-leaf redaction is measured not to render byte-equal to
  the redacted file in one shape (`test/envelope-redaction.test.ts`, D2: an `env-assignment` value
  that ends a leaf swallows the renderer's following punctuation only in the post-render scan). The
  text comparison is fail-closed and carries no copy of the engine's credential patterns: any
  difference, whatever its cause, shows the file. `tests-web/today.check.ts` builds its fixture with
  the engine's own `redactCredentials` (imported read-only). The engine-side stderr exposure the same
  review saw is a separate engine task.
- **States.** No briefing yet · a quiet day (the engine's own `(no commits in the window)` line) ·
  a skip (the Rust `statusLine`, its tone, and the skip's `detail` verbatim — blocked, offline,
  limited, …) · a config error (its `detail`) · a briefing that is not today's (its own title date
  against the local date — a label on the document, not a schedule phase). The badge is
  `ScheduleState.statusLine` coloured by `lib/tone.ts`, moved there from `Schedule.svelte` so the
  two screens cannot colour one state two ways.
- **Run Now** is `engine_run` with `force: false`, as in B4. Only `engine:progress` lines whose
  operation is `run` are shown, verbatim; a `busy` refusal names the operation already running.

### 10c. The renderers (T12, T13)

- `lib/briefing-md.ts` — the escape-first renderer (plan R1). Each line is classified by the
  engine's fixed prefixes (`LEGEND_PREFIX`, `NOT_SHOWN_PREFIX`, `WHY_PREFIX` are pinned against
  `src/` by `tests-web/briefing.check.ts`); an unknown line is a `text` block. Inline allowlist:
  `**bold**`, `` `code` ``, `[label](http(s) url)`, SHA-shaped tokens (the engine's `isShaShaped`)
  styled but not linked. Everything else — raw HTML, `javascript:`/`data:`/relative links, images,
  bare URLs — is literal text. Lines over 2000 characters skip the inline scan.
- `lib/briefing-struct.ts` — `renderBriefing`'s order, branch for branch, every line through the
  engine's `stripControl`, no inline interpretation at all.
- Both produce `Block[]`; `lib/BriefingView.svelte` draws them as text nodes. **No HTML string exists
  on this path.** A link span has no `href` (§10g, deviation 39).
- **A recap group is collapsed** (2026-09-24). A `bullet` block immediately followed by `nested`
  blocks — the shape of `renderBriefing`'s group-aware walk, and the only source of a `      ◦ `
  line — is drawn as one native `<details>`, CLOSED by default, the header ON its `<summary>` and
  the members as its body. A view change only: every member stays in the DOM, the golden below
  counts `summary` as a drawn line and still requires every engine line in order, and the markdown
  page the eval judge grades is untouched. `briefing.check.ts`'s tag allow-list gains exactly
  `details` and `summary` (neither navigates, embeds nor executes) and no `open` attribute. A why
  line is emitted before the story line, so it stays outside; a stray `◦` line with no bullet
  before it stays a plain line — only a HAND-EDITED page can hold one, because the walk has
  emitted the story line right before its members since `◦` lines first existed (#363).
- **A third recap level** (tier B, recap campaigns). Only a page the engine delivered with
  `recapCampaigns.mode: "on"` has one — `trial` never changes a page, and `off` is the default. A
  campaign header is a `bullet` line and its members are `nested` lines: a single member as a plain
  `nested` line, and a Stage-1 group the campaign absorbed as a `nested` header followed by that
  group's members as `nested2` lines — the engine's `         ▪ ` prefix (`src/render.ts`,
  `CAMPAIGN_L3_PREFIX`; `lib/briefing-md.ts`'s `NESTED2`, pinned against `src/` by
  `tests-web/briefing.check.ts`). `lib/briefing-struct.ts` mirrors the engine's three-level walk from
  the struct's optional `recap[].campaign` field. In the view the campaign is the group `<details>`
  above; inside it, a `nested` header and the `nested2` run after it are a SUB-GROUP — its own
  `<details>`, closed by default, keyed by index AND header (`lib/briefing-rows.ts`'s `subRowKey`, the
  rule in the next bullet) — so collapsed only level-1 lines show, and expanding a campaign shows its
  level-2 lines with each absorbed group still collapsed. No `open` attribute is written at either
  level. A two-level page has no `nested2` line, so its rows are exactly what they were.
- **Rows are keyed by index AND header** (`lib/briefing-rows.ts`'s `rowKey`; fix round, MED-1).
  `open` is DOM state Svelte does not reset on a reused element, and Today swaps briefings inside
  the same `BriefingView` (Run Now replaces `latest`; `TodayView.svelte` keeps the view), so an
  index key left a group open under the NEXT briefing's header. History unmounts the view between
  dates and was never affected. `{#key blocks}` is not the fix: `todayModel` builds a fresh `blocks`
  array on every `state:changed`, which would close every open group on every state update; with
  `rowKey`, a briefing whose lines did not change keeps its keys and its open groups.
- **The golden is the engine.** `tests-web/briefing.check.ts` imports `renderBriefing` from
  `../../src/render.ts` read-only and requires, for each fixture, that the struct view's DRAWN
  text, in document order — every line element's text, each member inside a closed `<details>`
  included, read back out of the rendered markup — equals the engine's lines with their
  structural prefix (indent, bullet glyph, heading marker) removed, and that the escape-first
  renderer reads the engine's own output back to the same lines and kinds. "Every branch" is a
  TABLE at the top of that file: `renderBriefing`'s conditionals enumerated one per row, each with
  the fixture that takes it. The first cut claimed full coverage without that table and missed two
  rows (a why before a GROUPED story line; merges under an EMPTY recap — mutants S4/S5 survived);
  round 1 added both, plus model text shaped like an http(s) image (T5) and a `delivered: false`
  envelope with a struct (`marker-fail`, T8, in `today.check.ts`).

### 10d. History (T13)

`routes/History.svelte`, `lib/history.ts`. Dates newest first from `archivedDates`; buttons with
arrow/Home/End/PageUp/PageDown movement FROM THE FOCUSED BUTTON (`moveFrom`; round 1 — the first
cut moved from the selected date whatever had focus); the selected file's size and path. **No
prune, delete or clean-up affordance exists** — in the screen, in any webview `invoke`, or as a
command — and the screen says in words that the archive is kept on purpose (~8 KB/day) as the
calibration record. No date picker (appendix T13; deviation 73).

**An unknown list is not an empty archive** (round 1, M6). `archiveList` returns `null` when the
snapshot carries no `status` (none yet, or a failed `status --json`); App.svelte keeps the last
KNOWN list across such a snapshot (`keepArchive`) and passes the snapshot's error. History then
shows the error, says when its list is from an earlier read, and says "No archived briefings yet."
only for a list the engine actually reported empty. A briefing the user has open stays open.

### 10e. The config save path (T15)

`src-tauri/src/config_save.rs`; its module header is the whole pipeline. In order:

1. a candidate over `MAX_CONFIG_BYTES` (1 MiB) is refused before it is parsed (`tooLarge`);
2. `status --json` → `paths.configPath` (never `app_config_dir()`);
3. the current file: no file / a symlink / a second hard link / not JSON → refused, nothing written;
4. the `base` token (content digest from `config_read`) must still match (R1's "config mtime guard");
5. `transcripts` must equal what is on disk as JSON VALUES (key order and `50.0` vs `50` are not
   changes — the form's JavaScript round trip rewrites the latter; `config_save::json_eq`: two
   numbers it calls equal are equal doubles; it is exact for integers that fit in 64 bits, and past
   that range serde_json reads a double on both sides, as JavaScript does) and a literal
   `provider.api.apiKey` may be kept or removed but not set or
   changed (the webview only ever sees the placeholder);
6. a candidate that re-serialises to what is on disk is a no-op (nothing validated, nothing written);
   one that re-serialises past the size cap is `tooLarge`;
7. the candidate is written to `<app_data_dir>/config-candidates/candidate-<pid>-<seq>.json` (0600,
   in a 0700 directory, removed afterwards; stale candidates of this naming are swept first) and
   validated by `config validate --json --file` through B3's validator — errors block, warnings are
   returned;
8. `replace_config_file`: sweep this app's stale staged files; stage the new bytes and the backup
   bytes as `.<config>.save-<pid>-<seq>` / `<same>.bak` beside the config (`fsync`ed); RE-READ the config
   — anything but the validated bytes is `conflict` and nothing else was written; keep the current
   `.bak` aside as `<same>.prev` (a hard link, or a rename where there are none — below), rename the
   staged backup to `.bak`, rename the new bytes over the config, `fsync` the directory. A failed
   rename of either staged file puts the previous `.bak` back (or removes the new one): **a failed
   save changes neither the config nor `.bak`**.

**What the config directory must support** (round 2). Create, write, `fsync`, `rename(2)` within
the directory, and unlink — nothing more. Hard links are used when they exist and are NOT required:
the round-1 swap needed them, and on FAT32 (`EOPNOTSUPP`, measured by review round 2) every save
after the first failed, safely but permanently. Now any link error other than `NotFound` /
`AlreadyExists` falls back to a rename: the `.prev` name is first created as an empty file of this
app's own (`create_new`), then `.bak` is renamed onto it, and a failure after that renames it back.
The one thing the fallback gives up is the crash case: between that rename and the staged backup's
rename there is no `.bak` name, so a crash there (not a failure — no code runs) leaves the config
untouched and the previous backup only under the staged `.prev` name, which the next save's sweep
removes. `config_save::keep_previous_backup`; `replace_config_file_with_link` is the test seam
(`tests/config_save.rs`, `a_filesystem_without_hard_links_still_saves_and_restores_bak`).

**A `.bak` that is not a regular file** — a directory, a symbolic link, a FIFO — is refused before
anything is touched, as `backupNotAFile { path, detail }` naming the backup's path; the user moves it
aside. Refusing was chosen over replacing an empty directory: a rename would move a directory under
a temp name no sweep removes (the sweep deletes regular files only), and would detach a symlinked
backup from its target. A `.bak` swapped for a directory by another program between that check and
the swap is not covered (the window is the swap itself).

Modes: the config keeps its mode, tightened to owner-only when the candidate OR the file on disk has
`provider.api` (as `initConfig` does for an API config); `.bak` gets `current & new`, never wider
than the new file (round 1, M4: a 0644 API config used to leave a world-readable `.bak` holding the
literal key). Saves are serialised by a lock in `ConfigSaver` — the Settings save and the Quit offer
share it, and `tests/config_save.rs` pins that two never validate at once.

**Stale temp files** (`config_save::sweep_stale`): only names of exactly this app's pattern, only
regular files (never a symlink or directory), only in the config directory or the candidate
directory, and only when their writer is gone — this process (every caller holds the lock) or a pid
the OS reports as not running. A pid that is alive, or not ours to signal, is left alone. A temp-name
clash (`create_new` fails) is an error and never deletes the file that was already there.

**Format.** `serde_json::to_string_pretty` with `preserve_order` and `float_roundtrip`:
`JSON.stringify(x, null, 2)` byte-for-byte for every fixture (`tests/fixtures/*.json`, generated by
`JSON.stringify` and re-checked by `tests-web/settings.check.ts`), including escapes, raw U+2028, DEL
and key order. Numbers are exact (`float_roundtrip` — `2.2250738585072011e-308` and
`123456789012345678901234` survive an untouched raw save as a no-op). What a WRITING save does to
numbers is pinned by `numbers_round_trip_and_the_rewrites_are_the_documented_ones` and listed in
deviation 48.

**The wire shapes (for T16/T18; the TS contract is `gui/src/lib/files.ts`).** Arguments:
`config_read {}`, `config_save { text, base }`, `config_create { text }` (B8),
`config_offer_notify_auto {}`,
`read_latest_briefing {}`, `read_archived_briefing { date }` — nothing else is read from the body.

- `ConfigDocument { path, exists, text, base, parseError, apiKeyRedacted }` — `text` is the file
  re-serialised in the save format with a stored key replaced by the literal placeholder
  `(a literal API key is stored in config.json; Daily Briefing never displays it)`; `text` and
  `parseError` are `null` when there is no file, `text` is `null` when it is not JSON; `base` is
  `null` only when there is no file.
- `SaveOutcome` (tagged `kind`): `saved { path, backupPath, warnings }`,
  `created { path, warnings }` (B8 — no `backupPath`: there was no previous file),
  `unchanged { path }`,
  `invalid { errors, warnings }`; each note is `{ field, message }`, verbatim from the engine.
- `SaveError` (tagged `kind`): `engine { detail }`, `noConfig { path }`,
  `alreadyExists { path }` (B8 — `config_create` found something already at the config path;
  nothing was replaced),
  `configUnreadable { path, detail }`, `onDiskNotJson { path, detail }`, `notJson { detail }`,
  `tooLarge { bytes, limit }`, `conflict { path }`, `transcriptsChanged`, `apiKeyChanged`,
  `candidateDir { detail }`, `write { path, detail }`, `backupNotAFile { path, detail }` (round 2;
  `path` is the backup's), `unsupported { detail }`. In every case the config and its `.bak` are
  unchanged. A candidate or file that serde_json cannot read is `notJson` / `onDiskNotJson` (and a
  `parseError`) with the parser's message; for a number beyond the largest double (`1e400`) that
  message says "number out of range … the JSON is well-formed", because it is (round 2).
- `BriefingFile { path, text, bytes }`; `read_latest_briefing` returns `null` before the first one.
- `BriefingError` (tagged `kind`): `invalidDate { reason }` (no process was created),
  `engine { detail }`, `notFound { path }`, `unreadable { path, detail }`.

**~~No first-config path yet~~ (deviation 42 — CLOSED IN B8).** `config_save` still refuses when
there is no file (`noConfig`), and Settings now points at the WIZARD (and, for terminal users, at
`daily-briefing init`). The open design point this paragraph carried is resolved by
`config_create` — the second of the two shapes it sketched, hardened: a create mode beside the
save path, engine-validated (`config validate --json --file` over the same candidate discipline)
and EXCLUSIVELY created, so the engine's `initConfig` leave-existing-alone semantics hold by
construction. §13 records the design, the alternatives rejected, and why the first shape (an
`init` operation) lost.

**The wizard's key step (T16) is constrained by what exists.** `config_save` refuses to SET a
literal `provider.api.apiKey` (deviation 45); `init` has no `--api-key` flag; and `apiKeyEnv` cannot
resolve from the app or from launchd (§6). So a wizard that wants a native key must write it to a
file and point `apiKeyFile` at it, point `apiKeyCommand` at a keychain helper, or come with a new
create path that is designed to carry a key. **B8 chose the references** (deviation 129): the
wizard collects an `apiKeyFile` path or an `apiKeyCommand` argv and never the key value, and
`config_create` refuses a literal key outright — the third option was rejected, §13.

**Which file.** The path is whatever `status --json` reports, and the app does not forward
`XDG_CONFIG_HOME` to the engine (`engine::FORWARDED_ENV`) — nor does launchd — so the app, and the
scheduled run, edit and read `$HOME/.config/daily-briefing/config.json` (`src/config.ts`,
`configPath()`). A CLI user whose shell exports `XDG_CONFIG_HOME` reads a DIFFERENT file from their
terminal. Settings shows the path it edits; deviation 64.

**The Settings screen** (`routes/Settings.svelte`, `SettingsForm.svelte`, `SaveReport.svelte`,
`lib/settings-model.ts`): a form over every `Config` field except `transcripts`, and a raw-JSON
tab; both send JSON text to `config_save`. The form edits the PARSED file in place, so unknown keys
and key order survive, and list-of-object fields are rebuilt by matching existing entries. Help
text is quoted from the engine (`src/types.ts`, `src/config.ts`, `src/harden.ts`), each quote
checked verbatim against those files by a test. Errors and warnings are reported in separate
blocks. Round 1:

- the save decision is a pure function (`formSubmission`): a LIVE field error blocks (errors on a
  hidden or disabled field do not, and toggling a list to the engine default clears its error); a
  draft equal to the loaded document as JSON values is `unchanged` with no IPC at all; otherwise
  the whole draft is sent (`rawFromDraft`, which is also what the raw tab shows);
- `provider.timeoutMs` is its own section, shown for CLI and API providers alike;
- ⚠ the `provider.argv` field says that `init` refuses `--tools` / `--settings` and that a save from
  this screen does not check for them (deviation 62; round 2 dropped its "unless `provider.harden`
  is off" — `init` refuses with `harden: false` too);
- an unsaved edit survives leaving the screen, in memory (`keepSettings`), and says so on return;
  one kept while its own save was in flight is dropped when that save lands as `saved` or
  `unchanged` and the kept edit is what was sent (round 2, `keptAfterSave`) — before, it came back
  as "unsaved" and then conflicted with the file it had just written.

**The Quit offer** is `config_offer_notify_auto`: under the same lock, the file as it is now, with
`notify` set to `"auto"` (in place if present, appended if absent) through the same pipeline.
Refused on Windows and over a REAL custom command only — `{ command: [string, …] }`, non-empty,
exactly `src/notify.ts`'s `resolveNotify` test (`config_save::is_custom_notify`). Everything the
engine treats as off (absent, `null`, `"off"`, an unknown string, an empty or non-string command, an
array) is replaced; `"auto"` is `unchanged`. The dialog asks first: App.svelte runs `config_read`
when it opens and `notifyOffer` classifies the value, so the button appears only where it would
change something, with a line saying when the current value is one the engine ignores. ⚠ A save
re-serialises the whole file, so a config indented some other way comes back two-space indented.

**Rates.** `config_read` = one `status --json`. `config_save` = one `status --json`, plus one
`config validate` unless the save is a no-op.

### 10f. What B5 does NOT execute, and what is therefore UNRUN

- **A real webview.** Every screen is rendered by the Svelte compiler's server target
  (`tests-web/*.check.ts`); click and key handlers, focus movement, `onchange` commits, the `$effect`
  that re-reads the file, Settings' `onMount`/`onDestroy` (the kept draft) and App.svelte's
  quit-time `config_read` are not executed by any test. They are thin wiring over pure functions
  (`chooseSource`, `formSubmission`, `rawFromDraft`, `isDirty`/`keepSettings`, `notifyOffer`,
  `keepArchive`, `moveFrom`) and Rust commands through IPC, which are.
- **`fsync` at run time.** No cheap observable exists for it on this machine (no file-ops trait;
  syscall tracing needs root). Round 2 pins it at SOURCE level instead
  (`tests-web/settings.check.ts`, "config_save.rs fsyncs before it renames"): `write_new_file`
  syncs after writing and returns the sync's error, both staged files are written through it before
  the re-read and before any rename, and the directory is synced after the final rename. Removing
  either `sync_all` turns that test red; what the kernel does with the call is not observed.
- **A real filesystem without hard links in the suite.** The fallback is driven through
  `replace_config_file_with_link`'s link seam (errors `Unsupported` and `PermissionDenied`), not on
  a FAT32 volume. (Round 2 also ran it against a FAT32 disk image by hand — §10g, deviation 68.)
- **Leaving Settings and coming back while a save is still in flight.** The returning screen takes
  the kept draft before that save has answered, so it shows it as unsaved with the old base, and its
  save is refused as a conflict (reported as such; nothing is overwritten). `keptAfterSave` covers
  only the case where the save answers first.
- **A real failed rename.** The restore of `.bak` is driven through `replace_config_file`'s test
  seam (a hook that fails immediately before the final rename), not by making `rename(2)` fail.
- **Adversarial render cost.** Review round 1 measured a whole-file adversarial render at about 1 s
  for 1 MiB (the engine's own output is ~16 KB). UNVERIFIED here — not re-measured by the fixer.
- **The History 500-entry budget in WebKit.** Measured: the server render of 500 entries,
  worst of 5 = 0.40 ms against the appendix's 200 ms (round 2: the worst of five runs of that
  test, 0.34–0.40 ms). WebKit layout of that markup is unmeasured.
- **`app_data_dir()` as the candidate directory.** Every test injects one
  (`ConfigSaver::with_candidate_dir`), because a MockRuntime app's `app_data_dir` is the developer's
  real one. Its shape (`~/Library/Application Support/com.themarigold.daily-briefing/…`, spaces and
  all) is admitted by B3's `--file` validator, which is pinned there.
- **What a link click does in the real webview.** No `href` is rendered, so nothing is clicked into;
  whether tauri-runtime-wry 2.11.4's default navigation handling would have admitted an external
  navigation is UNVERIFIED on a running app (it installs a new-window handler only when one is
  configured).
- **Windows and Linux.** The no-follow open is unix-only; the Quit offer's Windows refusal is a
  `cfg!` branch tested through `quit_dialog_for`, not on Windows.

### 10g. Deviations recorded by T12/T13/T15 (B5)

Numbered from 37, continuing §9.

37. **Today's struct comes from this app's own run envelope only, and only while it renders to the
    file's text.** The appendix's T12 names "briefing-latest.md's companion struct"; no such file
    exists (the engine writes markdown only, `src/main.ts`). Under R1 the common case is therefore
    the escape-first renderer over `briefing-latest.md`. The match rule is byte equality of the
    envelope's `markdown` with the file AND equal visible text between the two renderers.
    **CORRECTED in round 1:** this entry concluded that "the envelope's `markdown` is the very
    string written" made the struct safe to show. It is not when redaction fires — see 61.
38. **The History renderer is the escape-first line renderer, not markdown-it + DOMPurify** (appendix
    gui-tauri T13), per plan R1's graft and the Electron-era T9 line: no markdown dependency, no
    sanitiser, no HTML string.
39. **Links are drawn as text (label and target), never as navigable anchors.** The allowlist decides
    which `[label](url)` becomes a link SPAN (`http:`/`https:` only); none gets an `href`. There is
    no REGISTERED opener plugin in this build (40, amended in B6), and an anchor in the app's only
    window would navigate the app itself to a remote page. `tests-web/static.check.ts` refuses anchors and URL attributes in
    any component by parsing it (round 2: `svelte/compiler`'s `parse`, and TypeScript's
    tokenizer for code — the round-1 substring scan had 20 measured evasions), and states what a
    static scan cannot see, with the CSP as the runtime backstop.
40. **No "Reveal in file manager"** (appendix T13). `tauri-plugin-opener` is not in the local cargo
    cache and nothing is fetched in this build; History shows the file's path instead. Adding it
    later is one dependency, one exactly-enumerated grant (never the plugin's default set) and a
    refusal/admission test. **AMENDED IN B6 (round 1):** the DECISION stands — History and Today
    still have no reveal (deviation 82) — but the recipe in the last sentence is superseded: B6
    added the dependency with the OPPOSITE pattern (deviation 81 — free functions, `init()` never
    called, a dedicated validated command per power, and **no** `opener:*` grant), and
    `the_webview_cannot_reach_the_opener_plugin` now makes any `plugin:opener|*` grant a red test.
    A future briefing reveal follows dev 81/82's shipped shape, not this entry's.
41. **No directory pickers** (appendix T15). `tauri-plugin-dialog` is not in the local cargo cache
    either; repository and folder fields are plain text, validated by the engine. No grant was
    added for either plugin.
42. **Settings edits an existing config and never creates one.** With no config it points at
    `daily-briefing init`; the first-run path is T16's wizard, whose do-not-clobber behaviour R1
    protects, and a second creation path would compete with it. **AMENDED IN B8:** the DECISION
    stands — Settings still never creates — and the wizard's path now exists (`config_create`,
    §13); the no-config pointer on Settings and in `describeFailure` names the wizard first,
    `daily-briefing init` second.
43. **A symlinked config is refused, not written through — and so is a hard-linked one** (round 1).
    An atomic rename replaces the LINK (or the one NAME of a file with `nlink > 1`), which would
    silently detach a dotfiles-managed config; resolving the link would write into a directory the
    engine never names. The same no-follow rule applies to the briefing files (10a); the single-link
    rule applies to the config only (`ReadRefusal::HardLinked`).
44. **A config on disk that is not JSON is never replaced from the app** — shown with the parser's
    message and a pointer to `config.json.bak`.
45. **A literal API key is never shown and cannot be set or changed from the app.** The brief's
    premise that "a literal key never exists in config by design" is FALSE: `ProviderApi.apiKey` is a
    supported plaintext field (`src/types.ts`: "supported, warns on every run"). So `config_read`
    replaces it with a placeholder, `config_save` restores it when the placeholder comes back,
    refuses any other value (the engine has no `--api-key` flag for the same reason), and allows
    removal. A save of an API config tightens the file to owner-only, as `initConfig` does.
46. **JSON syntax is checked in Rust before the engine is asked**, because re-serialising needs a
    parse. Config SEMANTICS remain the engine's alone (`config validate`).
47. **The "config mtime guard" (R1) is a content digest.** A base token from `config_read` must
    still match before validation, and the file is re-read after validation, once both staged files
    are durable, immediately before the swap (round 1 moved it there and pinned it: an edit landing
    during `config validate` is a `conflict` that keeps the editor's bytes). **The residual window,
    precisely:** from that re-read's `read` returning to the final `rename(2)` of the staged file
    over the config. Inside it: one `link(2)` and one `rename(2)` on the BACKUP name (without hard
    links: a placeholder create + `fsync` of that empty temp file and two renames — 68) — no engine
    call, nothing the config depends on. An editor's save that lands there is replaced, and is not
    in `.bak` either.
48. **`serde_json` gains `preserve_order`** — one `Cargo.lock` edge to `indexmap` 2.14.2, which was
    already locked through tauri — **and `float_roundtrip`** (round 1; no lock change). It unifies
    across the normal dependency graph. **CORRECTED in round 1** — the number residual is larger
    than "integral floats", and differs by path:
    - an UNTOUCHED save writes nothing, from either tab (raw: Rust compares re-serialisations;
      form: `formSubmission` compares values before any IPC);
    - a RAW-tab save that writes re-spells every number through `f64`/`u64`/`i64`: a float that is
      integral keeps a fraction (`1.0` → `1.0`, `1e3` → `1000.0`, `-0` → `-0.0`, where JavaScript
      writes `1`, `1000`, `0`); an integer beyond the 64-bit range becomes an exponent float
      (`123456789012345678901234` → `1.2345678901234569e+23`, as JavaScript writes it); others keep
      their digits (pinned by `numbers_round_trip_and_the_rewrites_are_the_documented_ones`);
    - a FORM save that writes goes through `JSON.stringify` first: every number is spelled the
      JavaScript way (`1.0` → `1`, `-0` → `0`, integers past 2^53 lose precision), and
      integer-like object keys (`"42"`) move before the others. No key the engine defines is
      integer-like; the `transcripts` guard compares values, so this never trips it;
    - a number beyond the largest double (`±1e400`) is refused from either tab and shown as the
      reason a file on disk cannot be edited: serde_json cannot hold it, although the engine's
      `JSON.parse` reads it as ±Infinity. Round 2 words it as "number out of range … the JSON is
      well-formed", not as "not valid JSON".
49. **The Quit offer is gated and has its own command.** R1 offers `notify: "auto"` unconditionally;
    B5 withholds it on Windows (the engine's `"auto"` posts nothing there), with no usable config,
    and before the first state (each with a stated reason), and refuses it over a custom
    `{ command }` value it would otherwise discard. It is a Rust command making a one-field change
    under the save lock, rather than the webview composing a whole config.
50. **List-of-object fields are line-based inputs** (`label = dir`, `repo: glob, glob`, `host:port`)
    rather than a row editor; entries are matched on rebuild so their unknown keys survive.
51. **No PATH field.** `engine::EngineClient::with_path_override` stays unused: plan R1 has T15 write
    the USER config only, and the spawn PATH is an app setting, not engine config.
52. **The History list is not virtualised** (appendix T13: "virtualised list"). The measured server
    render of 500 entries is 0.40 ms against the 200 ms budget (10f); the archive grows by ~365
    entries a year.
53. **The golden is the engine's own `renderBriefing`, imported read-only by the gui test**, not a
    checked-in golden file (the brief allowed either).
54. **History is reachable from the window only.** The tray menu is fixed (B4) and `app:navigate`
    has no `"history"` target; the webview's `Route` type gained it, `NavigateTarget` did not.
55. **`tone()` moved** from `routes/Schedule.svelte` to `lib/tone.ts`, unchanged, so Today uses the
    same rule.
56. **The read commands join onto `paths.latestBriefingPath` / `paths.briefingsDir`** — the engine's
    own full paths — rather than onto `paths.stateDir` with the names re-spelled in Rust.
57. **`transcripts` has no form field at all** (appendix T15: a disabled toggle), per R1; the save
    path refuses a change from either tab.
58. **The four appendix snapshot states are bun `toMatchSnapshot` files over server-rendered
    markup** (`tests-web/__snapshots__/today.check.ts.snap`), which include Svelte's scoped-style
    class hashes — a CSS change to `TodayView.svelte` needs `bun test --update-snapshots`.
59. **The not-today's-briefing label compares the briefing's own title date with the local date in
    the webview.** It labels the document; it is not a schedule phase, and the badge beside it is
    still Rust's `statusLine`.
60. **RESOLVED in round 1 (comment-only):** `engine.rs`'s `No init()` note and
    `with_path_override`'s doc, and the assertion message in `tests/engine_client.rs`, no longer call
    Settings undesigned; `init` is still absent, for the reason §1c and §10e give. The non-comment
    diff of `engine.rs` against the B5 base is empty.
61. **Today's struct view must render to the same text as the file** (round 1, H1; §10b). Before
    Phase E the engine redacted credentials in the rendered string only and shipped the raw struct
    in the envelope, so a struct that matched the file by `markdown` could still show a key the file
    redacted. **E1 now redacts the envelope's struct, warnings and discIssues** (`redactStruct` at
    `emit`, `src/json.ts`); the fail-closed text comparison stays as the fallback for pre-E1 engines
    and the measured D2 shape. No credential pattern is copied into the app (the engine's stderr
    exposure is a separate engine task).
62. **Settings saves what `config validate` accepts — `init`'s argv hardening check is not applied**
    (round 1, M1). Measured with the real sidecar: `argv ["-p","--settings",…,"--tools","Bash"]` →
    `saved`, no warning, because `assertInitSafeArgv` (`src/harden.ts`) runs only in `init`. The
    engine is frozen in Phase B, so the `provider.argv` field says so in plain words (and quotes the
    engine's reason). **Phase C engine follow-up:** `config validate` should report `argvConflicts`
    / `INIT_REFUSED` so the app can show the engine's own verdict; and `init`'s refusal
    ("remove it, or set `provider.harden`: false to opt out of hardening deliberately",
    `src/harden.ts`, `assertInitSafeArgv`) is misleading — `init` runs that check for every
    command-line provider whatever `harden` says (`src/main.ts`, `if (loaded.provider.api ===
    undefined)`; the function takes the argv only), so following the advice changes nothing.
    **CORRECTED in round 2:** the field's note said `init` refuses "unless provider.harden is off";
    measured with the real engine, `init` exits 2 with `harden: false` too. The parenthetical is gone,
    and `tests-web/settings.check.ts` pins both the note and the engine's wording.
63. **R1's "`daily-briefing-app` + CLI-shim Settings action" is DEFERRED to B8** (round 1, M2; plan
    R1 line 27, design appendix §13). It is neither built nor stubbed in B5; the wizard batch builds
    it together with the first-config path (§10e). **RESOLVED IN B8** — built as
    `src-tauri/src/cli_shim.rs` + the Settings screen's "Command-line tool" block; this doc's §13
    carries the design, including the naming call (the shim is `daily-briefing`, verified against
    the design appendix in the B8 fix round; R1's "`daily-briefing-app`" is the APP BUNDLE's
    executableName — a packaging concern deferred to T22/T23, deviation 131 as amended).
64. **The app edits `$HOME/.config/daily-briefing/config.json` whatever the user's shell exports as
    `XDG_CONFIG_HOME`** (round 1, LOW-8). `XDG_CONFIG_HOME` is not in `engine::FORWARDED_ENV` (nor in
    the launchd plist), so the app and the scheduled run agree with each other and may disagree with
    a terminal that exports it. Settings shows the path it edits; §10e.
65. **`.bak` is never wider than the new config, and a save that touches an API config leaves both
    owner-only** (round 1, M4) — `.bak` mode is `current & new`; the new mode is tightened when the
    candidate OR the file on disk has `provider.api`. `initConfig`'s rule covers the candidate only.
66. **Settings shows the `apiKeyEnv` field** although it cannot resolve from the app or launchd (§6):
    it is a valid engine key a terminal run resolves, and removing it from the form would hide a
    value the user has. Its note says it will not be found by the app or the scheduler.
67. **A candidate over 1 MiB is refused before it is parsed** (`tooLarge`), and so is one that would
    exceed the cap once pretty-printed (round 1).
68. **A failed save changes neither the config nor `.bak`; this app's stale temp files are swept**
    (round 1). The chosen strategy is BOTH halves the review offered: `.bak` is written only after
    every check (staged, then renamed after the re-read), and a failed final rename RESTORES the
    previous `.bak` from a copy of its name kept aside. A crash between the two renames (not a
    failure: no code runs) leaves the config untouched and `.bak` holding its bytes, with the
    previous backup under a staged name until the next save sweeps it. The sweep's rules are in §10e.
    **CORRECTED in round 2 — hard links are no longer required.** The round-1 swap kept the previous
    `.bak` aside with a hard link and gave up on any other error, a regression from round 0 (which
    only wrote and renamed): on FAT32 every save after the first failed, and a `.bak` that was a
    directory failed every save with an opaque error. Now a link error other than `NotFound` /
    `AlreadyExists` falls back to renaming `.bak` onto an app-created placeholder under the same
    `.prev` name, restored on failure; its one cost is a crash in the gap between that rename and
    the staged backup's rename, which leaves no `.bak` name (the config is untouched; the previous
    backup waits under `.prev` and the next save's sweep removes it). A `.bak` that is not a regular
    file is refused by name (`backupNotAFile`) and left as it is. Pinned through
    `replace_config_file_with_link`'s link seam; §10e has the requirement.
69. **The Quit offer is decided from the config as it is** (round 1). The dialog reads it when it
    opens and offers the button only where taking it changes something; the command refuses only a
    real custom command and replaces every value the engine treats as off. (49 still holds for
    Windows and for no config / no state.)
70. **An unsaved Settings edit is KEPT across screen changes** (round 1; the brief allowed "keep" or
    "warn before leaving" — keep was chosen). In memory only: a reload or restart starts from the
    file; the kept edit keeps its `base` token, so a file changed meanwhile is still a `conflict`.
71. **`provider.timeoutMs` has its own always-shown section** (round 1): `src/config.ts` validates it
    for both provider kinds and it bounds the API call as it bounds a spawn.
72. **The appendix's "`configPath()` on all three platforms" test is replaced by "the path written
    is `status.paths.configPath`"** (`the_path_is_status_configpath_and_the_webview_cannot_supply_one`):
    the app never computes the path, so there is no per-platform rule of its own to test.
73. **History has no date picker** (appendix T13): the newest-first list with keyboard movement is
    the only navigation.
74. **Naming only:** the brief's `briefingMarkdown` envelope field is `markdown` in the engine
    (`src/json.ts`, `RunEnvelope`); B5 reads `markdown`.
75. **Appendix features not built in B5** (round 2, V3 — each was missing without a register
    entry). All but one are deferred to the B7/B8 backlog:
    - **History full-text search** ([S-HISTORY], "search across archived text") — deferred. It needs
      every archived day read (one `status --json` spawn per read today, §10a), so it wants a
      batched read command designed for it rather than a loop over this one.
    - **Today's Regenerate** ([S-TODAY]: "only when already delivered today; confirms …") —
      deferred. It is NOT covered by Run Now: Today's Run Now is `run --json` WITHOUT `--force`
      (`TodayView.svelte`, `App.svelte` passes `force: false`), which does nothing once today's
      briefing exists. `engine_run` already accepts `force`; what is missing is the button, its
      only-when-delivered gate and the provider-call confirmation.
    - **Today's Copy markdown** — deferred: it needs a clipboard path (no clipboard plugin or grant
      in this build), and a `navigator.clipboard` write from the webview would be a new surface to
      review.
    - **Today's Reveal in Finder** — deferred (40 covers History only): it needs
      `tauri-plugin-opener`, which B6 adds Rust-side behind its own commands; Today and History can
      use that command once it exists.
    - **Today's dismissible warnings band** — deferred. Today shows a skip's detail and, for a run
      this app started, the engine's stderr lines verbatim (its `⚠` warnings among them); there is
      no separate warnings band, and nothing on the screen can be dismissed.
    - **Live regex validation of `excludeCommitPatterns`** ([S-SETTINGS]) — DROPPED. Validation is
      the engine's: `config validate` warns "not a valid regex, ignored" and does not block
      (`src/json.ts`, `validateCandidate`), and Settings shows that warning on save; a live check
      in the webview would be a second, JavaScript-dialect copy of that rule (46) that could
      disagree with it.
    - **A warning when hardening is turned off** ([S-SETTINGS]: "harden (all-or-nothing, warn on
      disable)") — deferred. The field quotes the engine's all-or-nothing note, but no warning is
      shown at the moment `provider.harden` is switched to off, and `config validate` returns none
      for it (only `doctor` and the run itself report it).

## 11. Schedule ownership and folder access (T20/T17, B6)

### 11a. `schedule verify` is an app operation now, and it is a WRITE

The kickstart is still ENGINE-SIDE (plan R1): `schedule install` performs it as its final step, and
`Operation::ScheduleVerify` re-issues **that same kick**. The app never reaches `launchctl` — the
capability grants no shell surface and there is no unit-manipulating command — so the T7 allowlist
still needs no launchctl entry (plan R1, final-check M1).

⚠ **It is classified `is_mutating`, although its verb reads like a check.** `verifySchedule`
(`src/schedule/install.ts`) kicks the REGISTERED trigger, so launchd runs the engine: a briefing can
be generated, the archive written and the day stamped. A `schedule verify` racing a Run Now is two
generations, which is the one thing the in-flight guard exists to prevent
(`the_in_flight_guard_covers_exactly_the_state_changing_operations`).

⚠ **Its exit codes are not the others', and the ENVELOPE is the verdict.** `0` evidence appeared ·
`1` the kick was accepted and produced NO NEW evidence · `3` the scheduler refused it
(`src/main.ts`, `verifyExitCode`; `2` is never used). B3's classifier maps `1` and `3` alike to
`Outcome::Failed`, so a panel switching on the outcome kind would report an ordinary inconclusive
result as a failure — and would have no way to see `already-delivered-before-kick`, which §3 says
must **never** render as a successful verification. `gui/src/lib/verify-flow.ts` is the one place
that reads `payload.outcome`, and it is pure and table-tested.

### 11b. The post-install verification loop

Driven by B4's `state:changed` stream plus `schedule verify`; **it polls nothing**. The whole loop
is a pure state machine in `lib/verify-flow.ts` (round 1 — deviations 94/95): the component feeds
it three events (kick issued, kick's IPC completed, watcher push) and draws the stage it is handed.

| What came back | What the panel does |
| --- | --- |
| `delivered` | **Stops.** Plan R1 (final-check M3): a fresh install's first iteration may deliver a THIN briefing, and `doctor`'s "repos need access" carries the thinness. Falls through to the next-tick watch |
| `skipped`, reason in the engine's SETTLED set (`already-ran`, `below-floor`) | **Stops as CONFIRMED, benign tone** (round 1, deviation 95). Both prove the trigger reached the engine and neither is improved by another live kick — on a fresh install `already-ran` is the install's own first run |
| `skipped`, any other reason | The trigger DID reach the engine; the run declined. Loops on new `last-skip.json` evidence (a different `iso` **that the loop's own kick did not produce** — deviation 94) up to `MAX_VERIFY_ATTEMPTS` (3), then stops saying the trigger works and the engine's reason is what to look at |
| `no-evidence` | Loops the same way, then stops as NOT confirmed |
| `already-delivered-before-kick` | **Stops immediately, as NOT confirmed.** Today's delivery predates the kick, so nothing it did could be observed — and the day marker makes every further kick decline identically, so retrying cannot help today |
| `kickstarted: false` (exit 3) | The scheduler refused the kick; the engine's stderr verbatim |
| an outcome this version does not know | NOT confirmed. The envelope is additive-only (§2), so an unknown member must never read as a pass |

And between kicks, what the WATCHER pushes (round 1 — the shipped B6 loop got both of these
wrong, which was the round's HIGH):

- **A skip record produced by the loop's own kick never arms the next one**, in both orderings:
  a push landing while the IPC is in flight is absorbed into the baseline, and when the loop
  enters `retrying` with the baseline unchanged since the kick, the FIRST new iso is taken as the
  kick's own output (the `skipped` answer proves such a record exists) and absorbed too. Every
  comparison is kick-relative; no wall clock, no polling.
- **A delivery that does not predate the kick ends the loop in `watching`** — never a kick. One
  that DOES predate it is left to the envelope's `already-delivered-before-kick`, which §3 forbids
  rendering as success.

The loop's bound is an app-side judgement call, not a measurement: the engine's own `verifySchedule`
already polls twice internally (`maxIterations: 2`), and `MAX_VERIFY_ATTEMPTS` bounds how many times
the app asks again. Widen it deliberately, with a test.

### 11c. Uninstall, and who owns the trigger

`engine_schedule_uninstall` existed since B3; B6 exposes it. Two confirmations:

1. The first names the unit **file** (`ScheduleState.unitPath` — never a path this app computed) and
   the consequence: under R1 the OS trigger is the ONLY thing that delivers, so removing it stops
   the product until one is installed again. With no `unitPath` it says so rather than naming one.
2. The second is `ForeignOwnerDialog`, and only for a record this app does not own (`owner !== "app"`,
   §3). KEEP-EXISTING is the default; take-over is explicit. A refused take-over is a failure, never
   a loop back into the dialog.

⚠ **Exit 1 is "there was nothing to remove", keyed on the EXIT CODE.** §3: the classifier invents no
reason string for it, so `reason` is `null` and a panel keying on it would show an empty error for a
perfectly ordinary outcome. The key is `operation === "schedule-uninstall" && exitCode === 1`.

Both the verification and the removal controls are offered on **`recordPresent`**, which §3 calls
authoritative — not on the phase, and not on `unitPresent`.

### 11d. T17 — two TCC principals, both guided

Plan R1 replaces the appendix's single-principal model, and this build is correct in BOTH branches of
SPK-1(b)'s unresolved inheritance question:

- **The delegated principal** — the managed engine copy at `<state>/daily-briefing`, which launchd
  executes at 07:20. Guided step: reveal it in Finder (`access_reveal_engine`, path from
  `schedule status --json`'s `binPath`), then add it in System Settings.
- **The app principal** — the `.app`, responsible process for a GUI-initiated run. Guided step: the
  prompt-driven read (`access_probe`).

⚠ **Both are guided whenever a protected root is in scope, and that is deliberate over-service.**
`docs/spikes/spk-1b-app-principal.md` §4's negative branch — the child is judged on its own code
identity, so the sidecar does NOT inherit the app's grant — is UNRUN. Guiding both costs one extra
step in the branch where inheritance holds, and is the difference between a working briefing and a
silently empty one in the branch where it does not. **The spike's decision table is still the gate
for choosing between its two options** (route GUI runs through the managed copy, or keep the app
principal in the guided flow); this build takes the second, which is the one that needs no new exec
surface, and records the dependency there.

**Scope is conditional** (plan R1): the flow appears only when a protected root is actually reached.
It is read from **both** `doctor --json`'s `repos[]` (which sees a repo discovered under
`~/Documents` through a `discoverRoots` entry of `~`) and the config's `repos` / `discoverRoots`
(which sees a protected discovery root that has produced no repo yet). Neither source covers the
other.

**The launch-time read is a revocation detector only.** `access::probe_advice(in_scope,
grant_recorded)` returns `revocation-check` for exactly one input pair; every other pair is `none`.
Dropping the `grant_recorded` half would turn it into an acquisition trigger at every launch, which
is the "no unexplained prompts" property plan R1's deselected-by-default protected-roots graft
exists to keep. The webview mirrors that answer (`lib/access.ts`'s `launchActions`) rather than
re-deriving it.

**The post-update check** (T21's kept half) is `access_snapshot`'s one write: it advances
`lastLaunchVersion` in the app's own record AFTER computing `versionChange` from the old value —
**unless doctor's repo walk timed out** (round 1, deviation 96): a timed-out walk leaves `roots`
empty, every display path for the notice requires a root in scope, and advancing on that call
consumed the one `changed` answer on a snapshot that could never show it. So the FIRST call after
an update **whose walk finished** reports `changed` and every later one reports `same`. An
ad-hoc-signed `.app` has a cdhash-bound designated requirement, so every rebuild or update revokes
the grant (plan R1, delta-verify H) — a new version plus a protected root in scope is exactly when
to look.

### 11e. Deviations recorded by T20/T17 (B6)

Numbered from 76, continuing §10g. The convention in §9's header applies: **a retired entry keeps its
number and its slot.** (The B6 builder brief said this register continues "from 61"; §10g ends at
75, so 76 is the correct continuation — recorded here so the discrepancy reads as the brief's typo,
not a gap.) Entries 93 onward were added by the round-1 review consolidation.

76. **`schedule verify` is an `Operation` and a granted command**, where §1c deviation 4 listed it as
    deliberately absent and `capabilities/README.md` said *"`schedule verify` is deliberately
    absent"*. The reason it was absent — the kickstart is engine-side — is unchanged and is why this
    is a re-run of the engine's own kick rather than a launchctl surface. §1c deviation 4 and that
    README paragraph are amended in place.
77. **The app-principal probe takes a CLOSED ROOT ENUM, not a path.** The appendix's flow is
    *"attempting a read of the affected root from the app process"*, which reads as "the app is given
    a root". `access_probe` takes `desktop` / `documents` / `downloads` / `icloud` and joins it onto
    the app's own `HOME` in Rust, so the webview cannot name a directory at all. Same shape as
    `read_archived_briefing`'s date.
78. **It reads a directory LISTING, never a file.** Appendix §6's onboarding step 4 says the app
    *"deliberately touches one file under each protected root"*. TCC gates the `opendir`, so
    enumerating the directory answers the same question — and it is the LEAST that answers it. What
    reaches the webview is an ENTRY COUNT: no name, no byte, no `stat` of any entry. Reading a file
    under a user's `~/Documents` to prove the app can read `~/Documents` would put its bytes in this
    process for no additional fact. The drain is load-bearing all the same: a TCC-refused directory
    can `opendir` and then fail per entry, so the first entry error wins
    (`the_first_entry_error_wins_over_a_successful_open`).
79. **Both principals are guided; inheritance is never assumed.** Appendix T17 opens with *"the APP
    must hold the grant and the sidecar inherits it"*. See §11d.
80. **Scope comes from `doctor --json` AND the config**, where the appendix names doctor alone. §11d
    has the case each source misses.
81. **`tauri-plugin-opener` is a dependency and is NEVER REGISTERED.** `open_url` and
    `reveal_item_in_dir` are free functions (2.5.5, `src/open.rs`, `src/reveal_item_in_dir.rs`), so
    `tauri_plugin_opener::init()` is not called and the plugin contributes no live commands.
    ⚠ **The refusal's SHAPE is the ACL's, not the shell's `Plugin not found`** (corrected in
    round 1, measured): being in `[dependencies]` means tauri-build collects the crate's ACL
    manifest (`gen/schemas/acl-manifests.json` carries an `opener` entry), so `plugin:opener|*` is
    refused as *"not allowed. Permissions associated with this command: …"* one layer before the
    missing registration is consulted — the shell's `Plugin not found` needs the crate absent from
    every dependency table. The capability grants no `opener:` permission and
    `the_webview_cannot_reach_the_opener_plugin` pins the refusal, its ACL shape, and the absent
    grant. **No JS package was added**: the webview has no opener client either. `Cargo.lock`
    gained exactly four packages (`tauri-plugin-opener` 2.5.5, `open` 5.4.4, `is-docker` 0.2.0,
    `is-wsl` 0.4.0).
82. **Deviation 40 STANDS: History still has no "Reveal in file manager"**, and neither does Today
    (§10g, 75). B6's reveal command exists, but it takes NO operand — it re-reads `binPath` from
    `schedule status --json` — and a briefing reveal needs a date- or path-derived operand, which is
    a different command with its own validator and its own review. Wiring it is a small, separable
    change; it is not this batch's.
83. **Four access commands, not one.** "May read a protected folder from this process" (the only one
    that can raise a system dialog), "may reveal the managed engine copy" and "may open a System
    Settings pane" are three different powers, and the grant is per command name — the same argument
    §1a makes for one command per engine operation.
84. **`access_snapshot` costs THREE engine spawns** — `status --json` (to locate the config),
    `doctor --json` (the repo walk, up to 20 s) and `schedule status --json`. It runs on mount and
    from the Re-check button, never on a timer, and it is not part of what the live `state:changed`
    feed costs (§8).
85. **`access_snapshot` WRITES.** It advances `lastLaunchVersion`; that write is the post-update
    check (§11d). Nothing else on this surface writes, and the grant record is written only by a
    SUCCESSFUL `access_probe`.
86. **The app's record is `<app_data_dir>/access-state.json` — a boolean and a version string.** Not
    the engine's state directory (plan R1 and the T17 brief both say so): `<state>/` is the ENGINE's,
    shared with every CLI user, and `scripts/uninstall.sh` removes a bounded list from it that a file
    the app invented would not be on. No timestamp is stored: the record's only job is to decide
    whether a launch-time read is a revocation CHECK or an acquisition trigger, and a date does not
    change that answer.
87. **A denial never CLEARS the recorded grant.** A machine that had a grant and lost it is still a
    machine where checking at launch is the right thing to do; clearing it would turn the next
    launch's revocation check back into an acquisition trigger.
88. **The System Settings deep links are UNVERIFIED on macOS 26**, as the appendix says. The manual
    step-by-step path and a third "Privacy & Security root" button are shown ALWAYS, not revealed on
    failure — a deep link that lands on the wrong pane reports no error, so there is nothing to
    reveal them on. The three URLs are also printed as text.
89. **The revocation banner is in-window, not a notification.** ~~T18 is not built; the app posts
    nothing (§4).~~ **AMENDED IN B7, decision kept.** T18 exists now, and the banner deliberately
    STAYS in-window rather than joining the notification path: the check that produces it runs at
    LAUNCH (`App.svelte`'s `refreshAccess(true)`), when the window is on screen carrying this very
    notice — with T19's default-ON autostart, launch is the login moment, and a system banner
    duplicating an on-screen banner is the never-surprise rule's own counterexample. T18's classes
    stay the three RUN outcomes (§12a); a revocation remains a state the window explains.
    `App.svelte` shows the dismissible notice with a button that opens the Schedule screen,
    unchanged.
90. **`probe.rs`'s classifier moved to `access.rs`** and the feature-gated spike module maps its
    typed answer to the wire strings `docs/spikes/spk-1b-app-principal.md` §2 documents. T17 needs
    the same four errno values and the same "is this a denial" rule in the SHIPPING build, where
    `probe.rs` is not compiled at all; two copies of that rule is the divergence that would have the
    spike and the product disagree about a machine they both measured.
91. **`ScheduleUninstall`'s prop is `scheduleState`, and `ScheduleVerify`'s trigger counter lives in
    `App.svelte`.** Not style: a local binding called `state` makes `$state(...)` parse as a STORE
    SUBSCRIPTION to it (`svelte.dev/e/store_rune_conflict`), so a rune declared in a file with a
    `state` prop silently stops being reactive. MEASURED — `svelte-check` reported three errors and
    three "is updated, but is not declared with `$state(...)`" warnings before the rename.
92. **`DoctorRepo` carries its own `#[serde(rename_all = "camelCase")]`.** Recorded because it was a
    real defect, not a style note: `rename_all` is NOT inherited from the enclosing type, and with
    `#[serde(default)]` beside it the miss is SILENT — every `tcc-denied` row read as not-denied, so
    the panel listed the folder and showed no advice for it. Caught by
    `a_tcc_denied_row_carries_the_engines_advice_unmodified` going red.
93. **Only a `done` install arms the verification loop** (round 1). The shipped B6 comments called
    the every-completed-attempt bump deliberate; it was a defect — a foreign-owner REFUSAL (exit 2)
    opened the keep-or-take-over dialog and simultaneously kicked the CLI's live launchd job, a
    mutating side effect of a refused action. The gate is `install-flow.ts`'s `armsVerify`, applied
    in exactly one place (`ScheduleInstall`'s `onfinished`), pinned by
    `only a done install arms the verification loop`.
94. **A skip record produced by the loop's OWN kick never arms the next kick, and a delivery ends
    the loop** (round 1 — the HIGH). The shipped loop captured its baseline PRE-kick and answered
    every new push with `kick()`, so it re-armed on its own output (three back-to-back live kicks
    on the mainline fresh install, ending amber) and a genuine delivery during `retrying`
    triggered a further kick. The loop is now a pure state machine (`verify-flow.ts`: `beginKick`
    / `afterKick` / `onEvidence`) — baseline captured at kick time, own-output absorption in BOTH
    push orderings, delivery → `watching` unless it PREDATES the kick (§3's already-delivered rule
    keeps that case honest). Kick-relative comparisons only; no wall clock, no polling. §11b has
    the rules; `access.check.ts` pins them.
95. **Settled skip reasons stop the loop as confirmed, and a post-install delivery skips the kick
    entirely** (round 1). `already-ran` and `below-floor` mirror the ENGINE's settled set
    (`src/schedule/install.ts`) and land in benign-toned `watching` — on a fresh install
    `already-ran` is the install's own first run, so "declined N checks" copy was wrong there.
    Unknown skip reasons stay retryable up to the bound (the additive rule cuts toward retrying
    for reasons, toward not-a-pass for outcomes). And arming the loop while the pushed evidence
    already shows `delivered` confirms WITHOUT any kick — plan R1 final-check M3 implemented
    directly (`armLoop`); the MANUAL button still issues a real kick, because an explicit "check
    now" is a request for a live answer.
96. **`lastLaunchVersion` does not advance while doctor's repo walk timed out** (round 1). The
    unconditional advance consumed the post-update notice on a snapshot whose empty `roots` could
    never display it, and every later call read `same`. §11d has the rule;
    `a_timed_out_walk_does_not_consume_the_post_update_notice` pins the sequence. The plain
    no-timeout sequence is unchanged and still pinned.
97. **Config-side scope expands a leading `~` the way the engine does** (round 1). The engine
    expands `repos`/`discoverRoots` at config LOAD (`src/config.ts` `expandTilde`); `scope_of`
    reads the RAW file, so `~/Desktop/proj` was invisible to the config source — the source §11d
    justifies by exactly the state such an entry sits in. `access::expand_tilde` ports the rule
    member for member (`~` alone → home; `~/` and `~\` prefixes joined; `~user` NOT expanded),
    against the same `home` the roots are built from; the EXPANDED spelling lands in `because` so
    a doctor row for the same repo de-duplicates. One knowing divergence: Node's `join` normalises
    `..` segments and Rust's does not, which is subsumed by deviation 101's non-canonicalisation
    limit.
98. **The access record is written temp-then-rename** (round 1, Gemini GA3). `std::fs::write`
    truncates first, so a crash mid-write could MANUFACTURE the malformed record whose pinned
    degrade-to-`Default` silently resets revocation detection. Same rename shape as `config_save`,
    minus its backup and hard-link machinery (the record is app-owned, tiny, and degrades safely —
    the refusal would buy nothing). Malformed-reads-as-`Default` is unchanged and still pinned.
99. **A `busy` refusal renders as its sentence, not as raw JSON** (round 1). `ScheduleVerify` and
    `ScheduleUninstall` rendered a typed rejection with `JSON.stringify`; both now use
    `describeFailure` — and so does `ScheduleInstall`, whose copy of the same pattern was
    B4-vintage (in-scope polish, noted here rather than slipped in silently).
100. **The web launch-gate mirror keeps its `probeAdvice` condition, now falsifiably** (round 1,
    mutant M10). Every `"none"` fixture also had `probeRoot: null`, so `launchActions` ignoring
    `probeAdvice` left the suite green. The inconsistent fixture (`probeAdvice: "none"`,
    `probeRoot: "desktop"` → probe must be `null`) is added rather than the condition deleted:
    Rust never produces that pair, but the mirror must fail CLOSED on it.
101. **KNOWN LIMIT — `is_under` is a string-prefix check over non-canonicalised paths** (round 1,
    Gemini GA1, reproduced: `/Users/x/Desktop/../secret` classifies under Desktop). NOT fixed
    GUI-side alone, deliberately: it is a faithful port of the engine's `matchProtectedRoot`
    (`src/protectedPath.ts`), and one-sided canonicalisation would make the app and the engine
    disagree about the same path — the worse defect. Consequence today is a cosmetic extra
    in-scope root: the probe path is built from the closed ENUM, never from the raw string.
    Phase C follow-up: canonicalise BOTH sides together, or neither.
102. **KNOWN LIMIT, accepted by design — an out-of-scope `access_probe` executes and records a
    grant on the webview's word** (round 1, measured). The module documents why (access.rs: Rust
    cannot tell a guided click from an ungated one, and pretending it could would put the honest
    gate somewhere it is not). Blast radius: a directory LISTING COUNT of one of four fixed
    HOME-relative folders, behind a genuine macOS consent prompt; the launch gate stays shut while
    nothing is in scope because `probe_advice` needs BOTH inputs.
103. **KNOWN LIMIT — a dead scheduler leaves the loop in `retrying` after a first `no-evidence`**
    (round 1). Evidence-silence is indistinguishable from slowness without a clock or a poll, both
    of which the loop forbids on purpose; the surrounding screen carries the honest signal (tick
    counts, the `agent-stale` phase). Not worth a timer of its own.
104. **KNOWN LIMIT — the uninstall success message unmounts with the `recordPresent` block.** The
    state display is honest (the record IS gone); the confirmation's lifetime is a UX defect.
    Holding the message would mean lifting `ScheduleUninstall`'s state into the route, against
    §11c's recordPresent gating — deferred rather than smuggled in.

### 11f. What B6 does NOT execute, and what is therefore UNRUN

Beyond §1b's VM-gated `schedule install`/`uninstall` legs and §9's / §10f's lists, all unchanged:

- **Every TCC leg.** No test grants, revokes or observes a real TCC decision. The denial leg in
  `tests/access.rs` is an `EACCES` from a `chmod 000` directory — an ORDINARY permission denial that
  takes the same classifier arm — and is stated as such. `docs/spikes/spk-1b-app-principal.md` owns
  the VM protocol and every row in its §4 decision table is still UNRUN.
- **`schedule verify` against the REAL engine.** It kicks a real LaunchAgent in the user's login
  domain, exactly as `install`/`uninstall` do (§1b). Against a FAKE sidecar it is executed end to end
  through IPC, asserting the literal argv.
- **Any real System Settings window or Finder reveal.** Every test manages a recording `OpenSink`;
  the URL or path that was CHOSEN is asserted and nothing is opened. Whether
  `x-apple.systempreferences:…?Privacy_Files` lands on the Files-and-Folders pane on macOS 26 is
  UNVERIFIED (deviation 88).
- **A real macOS permission PROMPT.** `access_probe` raises one on a first read of a genuinely
  protected folder; every test points `HOME` at a scratch directory, so no test can reach one.
- **The post-install loop end to end.** The loop's rules are all pure and table-tested — round 1
  moved the LAST of them out of the component: `beginKick`/`afterKick`/`onEvidence`/`armLoop`
  carry the own-kick absorption (both push orderings), the delivery-ends-the-loop rule and the
  no-kick-on-armed-delivery rule, beside `afterVerify` and `afterUninstall`. What remains unrun is
  only the `$effect` wiring that feeds those functions from `state:changed` in a real webview (SSR
  runs no effects — §10f); it holds no decision beyond "call the machine, apply what it returns",
  and the fixed-point test pins that re-feeding the same evidence cannot loop.
- **The launch-time revocation path in a real webview.** `App.svelte`'s `refreshAccess(true)` is
  thin wiring over `launchActions` (tested) and two commands (tested through IPC); the `onMount`
  that calls it is not executed by any test.

## 12. Desktop notifications and autostart (T18/T19, B7)

### 12a. T18 — the delegated-watcher arm is the ONLY notification source

Plan R1 defers the app-owned tick out of 0.2.0, so there is no app-run outcome to notify from; the
one source is B4's watcher. Every snapshot the shipping sink announces (`shell::AppState::changed`)
also passes through `notifications::on_snapshot`, whose pure transition machine
(`notifications::Observation`) decides whether the snapshot is NEWS:

- **DELIVERED** fires when the machine observes BOTH halves — the derived phase becoming
  `delivered` (a `last-run` flip to today) AND `briefing-latest.md`'s mtime differing from the
  baseline it holds. The DEDUPE KEY is the run DATE, per class: a watcher double-fire, five rapid
  events, a re-derive, or a same-day `--force` regenerate all land on a (class, date) already
  fired and stay silent. Title carries the date; the body is the briefing's first resume line
  (the engine's own `▶` / `   • ` literals, pinned by `the_resume_prefixes_are_the_engines`), and
  the click route is Today. ⚠ The baseline moves ONLY at absorption and at a delivered firing —
  the delivering tick's briefing write and its stamp land in TWO batches (§8's measured rates), so
  a baseline that tracked every snapshot would erase the change before the flip arrived.
- **FAILED** (`provider-fail`, `parse-empty`, `marker-fail`, `crashed`) and **BLOCKED**
  (`blocked`) fire from TODAY's `Phase::Skipped` evidence, once per class per day (a failing
  morning rewrites `last-skip.json` every tick — 144 banners is what the per-day key prevents).
  The FAILED body is the engine's literal error line (the skip `detail`'s first line — no
  app-side redaction; the engine redacts its own diagnostics since PR #496 — but control-stripped
  and capped: §5's boundary is not redaction). Click route for both: the Schedule screen
  (deviation 106).
- **NEVER for a legitimate skip.** The whole engine vocabulary is enumerated
  (`notifications::skip_notify_class`, an exhaustive match; table-tested against `SKIP_REASONS`,
  which is itself pinned to `src/json.ts`): `already-ran`, `below-floor`, `offline`, `darkwake`,
  `concurrent`, `limited`, `no-config` and `config-error` are silence, each with its reason in
  the match's own docs; an UNKNOWN reason is silence (the additive rule — deviation 108 records
  the reasoning per member).
- **The first observation is ABSORBED, never fired**: a briefing already delivered (or a failure
  already recorded) when the app opens is state, not an event. Absorption is also why the dedupe
  needs no persistence across restarts. The one knowing cost: an app started between the briefing
  write and the stamp absorbs the new mtime and stays silent for that delivery — the letter of
  "observed BOTH halves". ⚠ **Only a STRUCTURALLY REAL status payload can prime, and priming
  absorbs the RAW evidence** (round-1 HIGH + round-2 MED, both fixed): the watcher deliberately
  announces every failing startup retry, and a failed `status --json` read is
  `Snapshot::unavailable` — EMPTY facts, not a statement that nothing was delivered. Priming
  from one hollowed the invariant: the next good snapshot satisfied both fire conditions for a
  briefing delivered hours before launch (and the stale FAILED banner the same way). Round 2
  measured the same symptom through a status-BEARING snapshot: a well-formed payload can report
  `latestBriefingMtime: null` while scheduler trouble shadows the derived phase (deviation 121),
  so the phase-gated facts primed empty — and `{}` parses into the all-default `StatusView` and
  primed empty too. An unprimed machine now skips any snapshot whose payload does not report
  `paths.stateDir` (the engine emits it unconditionally — `Facts::has_status`), and absorption
  records the RAW `lastRunDate` and `last-skip` keys independent of derived phase — pinned by
  `a_degraded_first_snapshot_never_primes_the_machine`, the shadowed-phase and `{}` primer
  sequences, and their next-day-still-fires legs, through the shipping sink.

**Notify ownership (R1's resolved-capability rule).** The app suppresses its own DELIVERED
notification only when `notifications::engine_will_notify(os, config.notify)` is true — the
member-for-member port of `notifyArgv(...) !== null` (§4), evaluated at fire time over the config
at `status --json`'s `paths.configPath`, pinned against the engine's real function through one
shared fixture table (`tests/fixtures/notify_predicate.json`, replayed by `tests/notifications.rs`
AND `tests-web/notify.check.ts`). Suppression is scoped to DELIVERED (deviation 109): the engine's
notifier fires only on its delivered path (`src/main.ts:489`), so suppressing FAILED/BLOCKED would
be a double silence under every config. An unreadable or absent config reads as "engine posts
nothing" — the app notifies; the suppression decision must never be the thing that fails.

**The opt-in, and "no prompt from a background fire".** The plugin's desktop permission API is a
constant-`Granted` stub (deviation 107), so the honest gate is the app's OWN record —
`<app_data_dir>/notify-state.json`, `enabled: null | false | true` (never-asked / declined /
on). While it is not `true`, every firing is recorded in a bounded suppression log (visible via
`notify_status`, rendered by Settings) and NOTHING posts — so no notification and no OS prompt
can come out of a background event before the user answers the EXPLAINED ask (the Settings panel
and the Schedule screen's one-time ask block, both carrying `NOTIFY_ASK_EXPLANATION`). Two new
commands carry it: `notify_status` (record + the engine probe + the log; one `status --json`
spawn, on Settings mount / app mount, never a timer) and `notify_set_enabled` (the answer; posts
nothing). B8/T16's wizard step wires the same command (deviation 107).

**What the shipping sink is.** `NotifySink` is the injectable seam (the `RecordingOpener`
pattern); the shipped implementation is `tauri-plugin-notification 2.4.0`'s
`builder().title().body().show()`, reachable only from `lib.rs`'s app (no test manages a
`NotifyState` without a recording sink). The plugin is REGISTERED (its Rust API needs managed
state) and granted nothing (§8's capability note; `capabilities/README.md`). A failed post is
logged and suppression-recorded, never propagated — the engine's own posture for its notifier —
though on the shipped 2.4.0 plugin a real post's failure can never be OBSERVED (deviation 120):
the `post-failed` path is exercised only through the injected sink today.

### 12b. Deviations recorded by T18/T19 (B7)

Numbered from 105, continuing §11e. §9's retire-in-place convention applies.

105. **The notification click ROUTE is computed and carried, and the shipped desktop plugin
     cannot deliver a click.** `tauri-plugin-notification 2.4.0`'s desktop `show()` spawns
     notify-rust detached and DISCARDS the handle; the plugin exposes no desktop click event at
     all (its three commands are `notify`/`request_permission`/`is_permission_granted`). Every
     built `Notification` carries `route` (`today` / `schedule`) so the recording sink asserts the
     appendix's intent and a future plugin (or a VM-measured Reopen path) can wire it; the SHIPPED
     click behaviour is macOS's default activation, and whether that activation reaches
     `RunEvent::Reopen` (whose handler already shows the window) is UNVERIFIED — §12c.
     *Amended in the B7 fix round:* the same measured plugin line has a SECOND consequence this
     entry originally did not draw — the detached spawn discards the post's ERROR too, so
     delivery failure is undetectable, not merely clicks. That half is deviation 120.
106. **FAILED's click target is the Schedule screen** — the appendix names a Diagnostics surface
     this app does not have; Schedule is where the run's state, the engine's detail and the
     repair controls live. BLOCKED's "Schedule & Access" is the same route (the T17 panel is ON
     the Schedule screen).
107. **The permission state machine is the app's own record, because the plugin's desktop
     permission API is a stub** — `permission_state()`/`request_permission()` return `Granted`
     unconditionally (2.4.0 `src/desktop.rs`), and the REAL macOS ask happens at the first post
     (from an unsigned bundle: UNVERIFIED, appendix:79, §12c). So `never-asked` is a first-class
     state; nothing posts and nothing prompts until the explained ask is answered
     (`notify_set_enabled`). **T16 handoff (B8): the wizard's notifications step calls
     `notify_status` / `notify_set_enabled` — the ask copy is `lib/notify.ts`'s
     `NOTIFY_ASK_EXPLANATION`; no new command, grant or record is needed.**
108. **The never-notify set, member by member** (the appendix's list, resolved against the
     engine's real vocabulary): `already-ran`/`below-floor` are the ordinary day;
     `offline`/`darkwake` are the machine's own mornings (the next tick retries);
     `concurrent` is a transient lock race; `limited` may resolve itself when the limit resets
     and the Today screen carries the engine's own reset-time line; `no-config`/`config-error`
     are STANDING states rewritten every tick — a daily banner for an unchanging condition
     trains the user to swipe. An unknown reason is silence (additive rule). ⚠ The appendix's
     "quiet-day" is NOT an engine skip — a quiet day is a DELIVERED briefing (`(no commits in
     the window)`) and notifies as one.
109. **Ownership suppression is scoped to the DELIVERED class** (§12a): the engine has no
     failure notifier (`src/main.ts:489` is its only `notify(...)` call), so suppressing
     FAILED/BLOCKED under an engine-owns config would be silence no configuration can lift.
     *Amended in the B7 fix round:* the pin for this rule was VACUOUS as shipped — the FAILED
     test leg's snapshot hardwired `configPath: None`, so the ownership gate was never reached
     and a suppress-every-class mutant (M10b) left the suite green. The leg now carries a real
     config (`skipped_snapshot_with_config`) and asserts no FAILED firing is ever
     ownership-suppressed.
110. **The resolved-capability predicate is a pinned Rust PORT, not an engine surface.** No JSON
     envelope reports `notifyArgv`'s resolution (checked: `json.ts`, `schedule/status.ts`,
     doctor); §4 designates the exported pure function as the GUI's predicate, and the port +
     shared-fixture pin is that designation honoured across the process boundary. The known Linux
     residual (§4) is ported as-is, deliberately.
111. **There is nothing to wire for the `--invoker cli` notify arm**: measured, no engine install
     path touches `notify` (§4's B7 note). The app-side offers are the Quit dialog's (B5) and
     the autostart-off toggle's (both through `config_offer_notify_auto`).
112. **Deviation 89 amended in place** — the revocation banner stays in-window, with the reasoned
     decision recorded there.
113. **The Quit dialog's Scheduled body is reworded (T11 rework)**: it now names the app's own
     notification as what quitting stops — conditionally ("would post"), because the opt-in may
     be off — and the engine-setting offer as the fallback. §8's table carries the new text;
     `tests/shell.rs` pins it and retires the pre-T18 "what stops is …" refusal.
114. **Autostart default-ON is a first-launch ONE-SHOT** (`autostart::startup`), recorded in
     `<app_data_dir>/autostart-state.json`. The record — never the plist — is the rule's input,
     so the default can never re-enable over a user who turned it off; a failed enable is logged,
     unrecorded, and retried next launch (idempotent). *Amended in the B7 fix round (a MED —
     record LOSS re-enabled over an OFF):* the first shape degraded EVERY read failure to "not
     yet defaulted", so a corrupt/truncated/lost-but-present record re-fired the one-shot and
     re-created a login item the user had deleted — contradicting this entry's own promise.
     `read_record` now splits the cases: ABSENT = genuine first launch (apply the default);
     PRESENT-but-unusable = `{ defaulted: true }` (fail toward the user's last known choice).
     Pinned by `a_corrupt_record_never_reenables_autostart`; the cost of the safe direction is
     one skipped default after a half-written first-launch record, recoverable by the toggle.
115. **The autostart toggle is the webview calling the PLUGIN's three commands directly** — the
     first plugin grants in the capability, and exactly its shipped allow-set
     (`capabilities/README.md`). Real state via `is_enabled()` per render, never cached. The OFF
     path offers engine `notify: "auto"` through the existing offer command and wording
     (`AppSettings.svelte`; the Quit dialog's rule).
116. **The autostart label is `Daily Briefing` — `package_info().name`, i.e. the productName —
     and cannot collide with `local.daily-briefing`.** The plugin's default `app_name` feeds
     `auto-launch`, which uses it as the plist `Label` AND file name; `tests/autostart.rs`'s
     label test reads the engine's `SCHEDULE_LABEL` out of `src/schedule/units.ts` and the app's
     name off the built context, asserts distinctness (and non-prefix-ness) of labels and file
     names, and pins `lib.rs` to the plugin default (no `app_name` override).
117. **What T25 (uninstall) must remove, registered now**:
     `~/Library/LaunchAgents/Daily Briefing.plist` (the login item, if enabled) and the app-owned
     records `notify-state.json`, `autostart-state.json`, `access-state.json` under
     `app_data_dir()` (`~/Library/Application Support/com.themarigold.daily-briefing/`), plus
     B5's `config-candidates/` directory there. The engine-side list is
     `scripts/uninstall.sh`'s, unchanged. *Amended in the B7 fix round:* the hardcoded
     `Daily Briefing.plist` above can no longer go silently stale —
     `the_product_name_the_register_hardcodes_is_pinned` (tests/autostart.rs) fails on any
     `productName` change and names this entry as one of the places that must move with it.

The entries from 118 are the B7 fix round's (round-1 review findings, resolved and recorded):

118. **The ownership predicate's config read FOLLOWS SYMLINKS — an engine-mirroring read,
     deliberately unlike every other app-side file read.** Round 1 found the shipped no-follow
     read (`O_NOFOLLOW`) turned a stow/chezmoi-SYMLINKED `~/.config/daily-briefing/config.json`
     — ordinary dotfiles practice — into `ReadRefusal::Symlink` → "off" → the app posts, while
     the engine follows the link (`src/config.ts`, `Bun.file(...).json()`), reads `notify:
     "auto"` and posts too: a DOUBLE NOTIFICATION from the predicate's own read semantics. The
     decision: this one read (`notifications::read_engine_config_text`, used by the fire path
     AND `notify_status`) follows symlinks, because the predicate exists to MIRROR the engine
     and the no-follow discipline protects reads of engine-WRITTEN state files, which the config
     is not — the user already controls both link and target, so following it grants nothing.
     Kept residuals, fail-OPEN by construction (double notification at worst, never double
     silence): a config over 1 MiB reads as unreadable → "off" → the app posts; a JSON shape
     serde rejects but Bun accepts reads the same way. `notify_status` reports these honestly as
     `unreadable` (classified from the read error itself — never a racy post-hoc `exists()`).
     Pinned by `a_symlinked_config_is_read_the_way_the_engine_reads_it`.
119. **The offered `notify: "auto"` can produce a DOUBLE SILENCE on macOS, and the app cannot
     detect it — registered, hedged, predicate unchanged.** §4's second residual, in full: the
     Quit dialog and the autostart-off toggle actively offer `"auto"`; the predicate then
     resolves it to an emitter and the app suppresses DELIVERED — but the engine's own header
     (`src/notify.ts:3-8`) says an osascript banner "may not post at all from a launchd agent",
     which is exactly how the engine runs. Resolving whether it actually posts is a VM leg
     (§12c). App-side action taken: every offer/status surface is HEDGED so nothing promises the
     engine's banner appears (Quit body: "…and on whether your setup shows its banner";
     Settings: "expected to post … if your setup shows its banner"; suppression log:
     "configured to cover it"), all pinned verbatim. The predicate is NOT second-guessed —
     dev 110's port-as-is reasoning governs.
120. **Delivery failure is UNDETECTABLE on the shipped notification plugin — `post-failed` is a
     sink-only reason today.** Three lenses independently: 2.4.0's desktop `show()` spawns the
     post detached and discards the error (`src/desktop.rs:216-220`), so
     `notifications::post_via_plugin` can never return `Err` on macOS — an OS-refused post
     leaves `notify_status` claiming enabled with an empty suppression log. DECISION: the
     `post-failed` enum arm and its UI string SHIP — the recording sink exercises the path and a
     future plugin version may report errors — but both carry the blind-spot note in source
     (`notifications.rs`, `lib/notify.ts`), and this entry is the honest statement: the app
     cannot know a post failed on this plugin version. Dev 105 amended with the same measured
     line's second consequence.
121. **DELIVERED can be shadowed by scheduler-trouble phases — a known limit, recorded not
     fixed.** `derive_phase` decides `NotConfigured`/`ConfigError`/`NotScheduled`/
     `SchedulerBroken` BEFORE `delivered_today`, so a briefing that lands while the unit is
     unloaded (a manual `daily-briefing run` with the agent broken, say) derives a non-delivered
     phase and the notification machine sees no delivery to fire. Left as-is deliberately: those
     phases are graver news than the delivery, the Schedule screen carries them all day, and
     re-deriving delivery out of phase order for a notification would fork §7's one state
     machine. Recorded so the silence is a documented consequence, not a surprise.
     *Round-2 amendment:* the same shadowing also hid the dedupe keys at PRIME time — a
     shadowed-phase primer absorbed nothing, and the next good snapshot fired a banner for a
     morning that predates the app — so absorption now reads the RAW `lastRunDate` and
     `last-skip` record instead of the phase-gated facts (`notifications.rs`, the
     content-free-primer rule). The live-firing silence this entry records is unchanged.
122. **The app's DELIVERED body is briefing text, which the ENGINE's own notify module forbids
     ITSELF — a conscious contradiction.** `src/notify.ts:10-15` fixes the engine's body to a
     template (date + path) because a briefing-text body would be a new render surface for
     repo-controlled strings. The appendix mandates the first-resume-line body for the APP, and
     the app's channel differs where the engine's reasoning bites: the post is a structured
     plugin call (title/body fields — no AppleScript string to inject into), the text is
     post-redaction (PR #496) and §5-bounded (control-stripped, capped, markdown-stripped since
     the fix round). The engine's rule is about ITS channel (osascript string literals); the
     app's channel does not have that class. Recorded because two modules in one repo now argue
     opposite postures and both are right for their transport.
123. **The suppression log is IN-MEMORY ONLY** (`NotifyState::suppressed`, bounded at 8): a
     restart empties it, so "a delivery was observed while notifications were off" survives only
     as long as the process. Deliberate — the log is UI courtesy, not a record; persisting it
     would be a third app-owned store for information whose absence costs one explanatory line.
124. **The startup emit's blocking reads run on a tokio worker thread** — the watcher's
     `SnapshotSource::snapshot` is `block_on` from its own OS thread, but the FIRST snapshot in
     `start_watcher_with` runs `snapshot_async` on the async runtime, whose file reads
     (`read_record`, the config, the briefing) are std blocking calls on a worker. Noted, no
     fix: they are small local files read once per snapshot, and the engine spawn beside them
     dwarfs them; lifting them to `spawn_blocking` would complicate the one shipping sink for an
     unmeasured stall.
125. **The default-ON plist's program path is `current_exe()` — a dev/debug bundle's first
     launch registers a login item pointing at the BUILD DIRECTORY.** Derivation:
     `autostart::startup` → plugin `enable()` → `auto-launch 0.5.0` writes `ProgramArguments =
     [app_path, ...args]` with `app_path = current_exe()` (its macOS LaunchAgent branch; args
     test-pinned `None`, dev/README). A developer running the debug bundle therefore gets a
     login item at `target/debug/bundle/...` until the record says defaulted; a moved or deleted
     build dir leaves launchd pointing at nothing (launchd logs the failure and gives up — no
     crash loop against the user's session, UNVERIFIED beyond auto-launch's source: VM leg,
     §12c). Shipped-bundle behaviour is the correct one (`/Applications/...`). Recorded; the
     alternative — refusing the one-shot outside `/Applications` — would make the shipped
     default untestable in every dev build for a residual that only affects developers.

### 12c. What B7 does NOT execute, and what is therefore UNRUN (VM-gated)

Beyond §1b, §9, §10f and §11f, all unchanged:

- **A real notification post.** The plugin → notify-rust → Notification Center leg, including
  `set_application(bundle id)` attribution, is never executed: every test posts into a recording
  sink. Whether a post from an UNSIGNED bundle appears at all is the appendix's UNVERIFIED note
  (appendix:79).
- **The OS's own permission registration/prompt at the first post**, and its System Settings
  entry for the app.
- **A real notification CLICK** — whether it activates the app, whether activation arrives as
  `RunEvent::Reopen` (which would show the window), and therefore whether the carried route can
  ever be honoured on this plugin version (deviation 105).
- **A real `enable()` / `disable()` / `is_enabled()` against the live plugin state.** The plist
  write/remove in `~/Library/LaunchAgents` and the stat that reads it back are never called; the
  one-shot and the toggle are driven through recording sinks, and the autostart grants' IPC
  admission is asserted against a mock app with no plugin registered. `~/Library/LaunchAgents`
  is stat-identical before and after the whole B7 build+test run (measured by the builder).
- **The default-ON one-shot in a real bundled app at a real login**, and the login item actually
  launching the app.
- **The label non-collision against a LIVE launchd domain** — both agents loaded at once. The
  test proves the names are distinct; launchd's own behaviour with both present is unexercised.
- **The notification plugin's `js_init_script` in a real webview.** Its real surface, read from
  the plugin source (B7 fix round): it REPLACES `window.Notification` with a shim whose every
  path is refused by this ACL, and it fires an ungranted `is_permission_granted` with no
  `.catch` on EVERY page load — an unhandled promise rejection in the console each time. Nothing
  in this webview consumes `window.Notification` (grepped: zero uses), so the shim shadows an
  API nobody calls. `the_webview_cannot_reach_the_notification_plugin` pins the refusals through
  IPC, not through a rendered webview — and note the "tray posture" shorthand elsewhere covers
  the COMMANDS only: the tray injects no script, this plugin does.
- **Whether the ENGINE's `"auto"` osascript banner posts at all from its launchd agent**
  (deviation 119; the engine's own header doubts it). Until a VM measures it, every app surface
  is worded so a silent engine banner breaks no promise.
- **The default-ON login item from a NON-/Applications (dev/debug) bundle** — `current_exe()`
  lands in the plist (deviation 125); what launchd does when that path later disappears is
  UNVERIFIED beyond auto-launch's source.

## 13. The first-run wizard, the first-config path and the CLI shim (T16 + dev 63, B8)

### 13a. The wizard: six steps, one write

`gui/src/routes/Wizard.svelte` over the pure `gui/src/lib/wizard.ts`; entry is the existing
`not-configured` state (§8a's Wizard contract). The six steps are plan R1's: welcome (local-first,
no telemetry, BYO AI, where data lives) · provider (the three paths, below) · repos · macOS folder
access (CONDITIONAL — darwin and a protected root reached by the draft; `ScheduleAccess.svelte` IS
this step) · morning time (the floor, with `first_wake_sentence`'s canonical wording — the webview
mirror is pinned against the Rust source by `wizard.check.ts`) · background delivery
(UNCONDITIONAL; `ScheduleInstall.svelte` IS the install, the foreign-owner dialog keeps
KEEP-EXISTING first, `ScheduleVerify.svelte` is the live test — the install's own engine-side
kickstart IS the verification, no second run path exists — then the notifications ask, dev 107's
same command and copy, then `doctor --json`'s provider verdict).

**The one write.** Steps 1–5 build a DRAFT in webview memory; `lib/wizard.ts` performs no IPC at
all (pinned by source scan), and the single write happens at the step-5 → step-6 gate:
`savePlan` picks `config_create` (no document) or `config_save` with the base token from the
`config_read` that pre-populated (a document exists). Cancel on any step before that gate writes
NOTHING — `cancelWritesNothing`, pinned and mutation-checked.

**Re-run = pre-populate + edit, never clobber** (R1 delta-verify H) — **scoped in round 1 to the
two re-entry shapes that are actually REACHABLE**, because R1 rules the wizard FIRST-RUN ONLY
(entry exists only at the `not-configured` phase; the Setup button is gated on the same phase,
and the Schedule & Access panel remains the flow component for existing-config users — no general
re-entry point exists or should be added): **(1) a pre-existing config found at first launch**
(the `onMount` `config_read` seeds the draft), and **(2) the mid-wizard recovery** — a config
that appears under the wizard (`alreadyExists` from the exclusive create, or `conflict` on the
edit path) is re-read, the draft is RE-SEEDED from what is really there, the pre-populated banner
renders, and the second write is gated on an EXPLICIT acknowledgement (round 1: the recovery used
to re-read the document but not the draft, so the next click merged a fresh-setup draft over the
just-protected config — measured: repos deleted, provider rebuilt as template, floor reset). In
both shapes: `draftFromConfig` seeds the
draft from the loaded text — and a text it CANNOT seed (`{"provider":{"api":null}}`, measured)
now blocks the save gate (`saveGateBlocker`) instead of falling through to an empty-draft merge;
`mergeConfig` applies the draft ONTO the parsed document in place, so
unknown fields, key order and every non-wizard key ride through the save's canonical
re-serialisation; an untouched re-run merges to a VALUE-identical document and the save path
answers `unchanged` (pinned byte-for-byte against the FULL fixture AND a local-provider fixture —
round 1, deviation 134 as amended). Three do-not-clobber layers
in `providerValue`: a KEPT CLI provider is returned as-is (a customised `argv` such as
`["-p","--model","sonnet"]` survives), a changed provider rebuilds only wizard-owned keys (with
unowned `api` keys — `baseUrl`, `maxTokens`, `apiKeyEnv` — riding through; a rebuild that changed
no VALUE keeps the existing object, order included), and a stored literal
key's PLACEHOLDER is carried so the edit path keeps the key.

### 13b. The provider step's three paths (R1)

- **(a) an installed CLI (recommended)** — `claude` (default) or `codex`, writing exactly the
  engine's own `initConfig` template block (argv `["-p"]` / `["exec"]`, `promptVia: "stdin"`,
  `harden: true`, `credential: "subscription"`, the explicit default probe-host pair on a create).
  ⚠ **Detection is POST-SAVE, not pre-save — a recorded divergence from the R1 summary's "detect
  claude then codex on PATH via doctor --json"** (deviation 127): with no config on disk,
  `doctor --json` probes NOTHING (`doctorReport` runs `which` only over `cfg.provider.cli`, and
  `cfg` is `null` — `src/json.ts:625-638`), and a PATH walk of the app's own is forbidden. So
  step 2 offers the choice with the engine's own default first, and step 6 runs `doctor --json`
  against the JUST-WRITTEN config and shows `provider.found`/`path`/`anomalies`/`notes` — the
  same `which` mechanism `initConfig` uses, at the first moment it can actually run.
- **(b) a native Anthropic key** — `provider.api` kind `anthropic`, model prefilled
  `claude-sonnet-5` and EXPLICITLY confirmed (the Continue button blocks until the checkbox or an
  edit). **The key is collected BY REFERENCE ONLY** (deviation 129): an `apiKeyFile` path or an
  `apiKeyCommand` argv, per §10e's constraint paragraph — the app never ASKS FOR, SETS or ECHOES
  a key value (round 1's honest wording: a user can paste one into the key-command textarea, as
  into any textarea; the app never requests one, never stores one, and the engine never echoes
  one), and `config_create` refuses a literal `apiKey` outright — at any spelling or position
  (§13d).
  `networkProbeHosts` is deliberately OMITTED on this path (deviation 130): absent, the run
  derives probe hosts from the endpoint (`initConfig`'s own note), where copying the engine's
  explicit-write behaviour would need a drift-prone webview port of `deriveProbeHosts`.
- **(c) a local endpoint** — `provider.api` kind `openai-compatible`, `baseUrl` + model,
  `timeoutMs` prefilled to 600 000 (never over an existing value) and `networkProbeHosts: []`
  (prefilled the same way since round 1 — only where the key is absent; an existing value is the
  user's, deviation 134 as amended)
  with the explanation on screen: the network gate probes public anycast hosts, and a local model
  needs no internet. A loopback endpoint needs no key (the engine's own rule).

Every option is worded as a CLI or endpoint the ENGINE talks to; the app never calls a provider.

### 13c. The repos step, and the deselected-by-default graft

Checkboxes are DISCOVERY ROOTS in tilde form (`~`, `~/Desktop`, `~/Documents`, `~/Downloads` —
the engine expands at load, `access::expand_tilde` expands the same way for scope), plus free-text
roots, explicit `repos` (discovery is then skipped by the engine), and `excludeRepos`.
**Desktop/Documents/Downloads start DESELECTED** (R1's grant-acquisition graft, pinned): a
protected folder enters scope only by an explicit choice, so no macOS prompt is ever unexplained.
`~` starts SELECTED (deviation 128 — it is the engine's own init default minus the meaningless
cwd, and an all-deselected default ships an empty briefing) with the walk-enters-protected-folders
consequence explained inline; deselecting it and listing folders is the narrow path the copy
offers. Pre-save there is nothing discovered to checkbox (the same no-config fact as detection —
deviation 127), so "what was found" is shown at step 6 from doctor's `discoveredCount`/`repos`,
and exclusion guidance points at Settings.

**Step 4's scope comes from the DRAFT** — the one seam change: `access_snapshot` takes an
optional `draft: string[]` (bounded: at most **64** entries of at most **1024** bytes — pinned as
literals, the EXPECTED_GRANTS doctrine — with ASCII control characters AND, since round 1, the
zero-width/BiDi format characters refused before any spawn — `access::checked_draft`), unioned
into `scope_of` exactly as configured entries are. The webview
influencing scope display is dev-102's accepted class (the probe path is still built from the
closed enum); the parameter is absent from every non-wizard call.

### 13d. `config_create` — the first-config design (closes §10e's open point)

The shape shipped: **a create mode beside the save path** (`config_save.rs`), sharing the save's
candidate discipline (size cap → parse → engine `config validate --json --file` over a 0600
candidate in the app's own dir → errors block) and replacing the edit-only steps with create-only
ones: no base token and no on-disk read; a literal key refused outright (dev 45's invariant —
the wizard's native-key path never has one) — **since round 1 as a RECURSIVE, CASE-INSENSITIVE
scan for any object key spelled `apiKey`, anywhere in the document**
(`config_save::holds_literal_api_key`): the original single-pointer check let three measured
shapes through (`provider.api.apikey` created at 0600; a top-level `apiKey` and
`provider.accounts[].apiKey` created at 0644, world-readable) and the engine's validator is NOT
a second line of defence; `apiKeyFile`/`apiKeyCommand` stay legal. **The mode rule is unchanged
and now guaranteed-safe**: 0600 exactly when the candidate carries `provider.api`, 0644 (absolute,
not umask-filtered) otherwise — safe because post-refusal no literal key can exist ANYWHERE in a
created document, so none can reach a world-readable file. Any `transcripts` block refused
(the human gate: on a create the only unchanged value is absence). The write is
`create_config_file`: stage → `fsync` → **`link(2)` onto the config name — atomic AND exclusive
in one call**, so `EEXIST` is the do-not-clobber answer (`alreadyExists`) for a config a terminal
`daily-briefing init` wrote mid-wizard, a dotfiles symlink, anything; a link-less filesystem
falls back to `create_new` (still exclusive, no longer atomic — the same accepted residual as
deviation 68's rename fallback); the parent directory is created (a first run has no
`~/.config/daily-briefing/`). Mode 0600 when the candidate carries `provider.api` (initConfig's
rule), 0644 otherwise (guaranteed key-free by the scan above). The wizard answers `alreadyExists`
by RE-READING, RE-SEEDING the draft from what is really there, and switching to the base-token
edit behind an explicit acknowledgement (§13a's recovery shape, round 1 — deviation 136).

**The execution surface this widens, recorded** (round 1, deviation 139): a FIRST config written
from the webview can carry the engine-executed argv classes — `provider.argv`,
`provider.api.apiKeyCommand`, `notify.command`, `auditJudgeArgv`. T15 gave the webview this over
EXISTING configs; `config_create` extends it to creation. No refusal is added — the engine
executes these by design, and refusing them would break legitimate configs. The trust statement:
the webview is the app's own local assets (strict CSP, no remote content — §5's posture is the
boundary), not an untrusted principal. Worth naming because `apiKeyCommand` runs UNATTENDED under
launchd at key-resolution time: whatever argv the config carries executes on the morning tick
with no one watching.

**Alternatives rejected** (the two others §10e sketched): an `Operation::Init` typed command —
the engine's writer cannot carry the wizard's choices (its roots would be the APP's cwd + home,
its provider only what `--provider` spells, no floor/repos/excludes), so every wizard would
need a second write on top, which is the two-write shape the write-once rule forbids; and a
create path DESIGNED TO CARRY A KEY — rejected because it inverts dev 45 (the webview would hold
a literal key in memory and IPC, and `config_read` would owe a redaction for a key the app itself
introduced), where the reference design costs one `cat > file` and keeps the app's zero-key
invariant intact.

### 13e. The CLI shim (dev 63)

`src-tauri/src/cli_shim.rs` + the Settings screen's "Command-line tool" block + `lib/shim.ts`.
A symlink at `/usr/local/bin/daily-briefing` → the MANAGED ENGINE COPY (`schedule status
--json`'s `binPath`, re-read Rust-side per call — the `access_reveal_engine` rule; refused while
none exists). Explicit user action; target path shown; reversible (`cli_shim_remove`); **a
foreign file at the name is never overwritten or removed** — `classify` calls a link OURS exactly
when its target is the managed copy or another name in the engine's state directory, and
everything else (a real binary, a link into another tree) is a refusal that names what is there.
`/usr/local/bin` is root-owned on a stock Mac (or absent on Apple Silicon) — though not
universally: on the machine this was built on it is `drwxrwxr-x <installing user>:admin`
(measured round 1, owner corrected round 2 — the installing user, not root),
admin-writable with no prompt, so the permission error is the common case rather than a
guarantee and the FOREIGN-FILE REFUSAL is the actual protection. When the filesystem does
refuse, the answer carries the EXACT `sudo ln -sfn …` / `sudo rm …` line — SHELL-QUOTED since
round 1 (`cli_shim::manual_install_command`/`manual_remove_command`): the stock target contains
a space (`~/Library/Application Support/…`), so the unquoted line failed on every stock install
(measured: 6 words, `ln` refused; the narrow harmful mode created two root-owned symlinks inside
a directory) — for the user's own terminal; the app never escalates, never shells out, never
runs `sudo`. The filesystem effect is behind the injectable `ShimSink`. **The sandbox property,
stated honestly (round 1): no test points a real sink at the real directory.** The un-overridden
default pairing (real `SystemShim` over the real `SHIM_DIR`) is constructed only in `lib.rs`;
tests DO construct `SystemShim` (its unit test drives it against scratch), and every
test-managed `CliShimState` carries `with_dir`/`with_sink` — a discipline
`tests/cli_shim.rs::no_test_wires_the_real_sink_at_the_real_directory` pins with a source scan
rather than leaving to convention. The real `/usr/local/bin` leg is UNRUN (§13g).

**Naming** (the dev-63 phrase's ambiguity — resolved, and since round 1 VERIFIED against the
design appendix, deviation 131 as amended): the shim is **`daily-briefing`** — exactly what
appendix `:337` (T19) prescribes: *"an 'Install command-line tool' action symlinking
`/usr/local/bin/daily-briefing`"*. R1 line 27's "`daily-briefing-app`" is NOT a shim-name
candidate at all: the appendix (`:189`) names it as the APP BUNDLE's `executableName`,
deliberately different from the CLI's *"so it cannot shadow the CLI on PATH"* — a packaging
concern, explicitly deferred to the packaging task family (T22/T23; deviation 131). The
appendix's replace-with-confirmation shape (`:902`/`:919`) diverges from B8's outright foreign
refusal — recorded as deviation 138, behavior kept.

### 13f. Deviations recorded by T16 + dev 63 (B8)

Numbered from 126, continuing §12b. §9's retire-in-place convention applies.

126. **The wizard writes the config ONCE, at the step-5 → step-6 gate — not at the end of step
     6.** "At the end" in the R1 summary cannot be literal: step 6's install triggers the
     engine-side kickstart, whose live run must find the config on disk or the "test run" would
     skip `no-config` and verify nothing. The gate is explicit ("Create configuration &
     continue"); cancel before it writes nothing, and step 6's own actions (install, notify
     choice, shim) are post-config effects, not config writes.
127. **Provider detection and repo discovery are POST-SAVE** (§13b/§13c). The R1 summary's
     pre-save "detect via doctor --json" and "checkboxes on what was found" are not reachable
     through the engine's surfaces with no config on disk — `doctorReport` probes and walks only
     what the on-disk config names, and both a Rust-side PATH walk and a repo walk would be new
     app surfaces the seam's posture forbids. Surfaced as a conflict, resolved toward the seam:
     choice pre-save, engine's own verdict post-save, on the finish step.
128. **`~` (Home) starts SELECTED in the repos step; the three protected roots start DESELECTED**
     (R1's graft, applied literally to the folders it names). An all-deselected default was
     rejected — the default path must yield a working briefing, and `[home]` is the engine's own
     init default minus the meaningless cwd — at the recorded cost that the first post-save walk
     of `~` enters protected folders and macOS may ask; the step's copy explains exactly that
     beforehand, which is what keeps R1's rule about UNEXPLAINED prompts satisfied rather than
     violated.
129. **The native-key path carries the key BY REFERENCE, never by value** (§13b, §13d). No
     literal key can exist in the webview, in IPC, on a command line or in a log; `config_create`
     refuses one outright, and the STOP condition in the B8 brief was therefore not triggered —
     the engine's surface DOES accept a key without violating the constraint (`apiKeyFile` /
     `apiKeyCommand`, dev 45's "only app-settable sources").
130. **Path (b) omits `networkProbeHosts` where `initConfig` writes the derived hosts
     explicitly.** Absent, the run derives them from the endpoint at load (the engine's own
     documented behaviour); writing them would need a webview copy of `deriveProbeHosts`, a
     drift surface for zero behavioural difference. Path (a) keeps the template's explicit
     default pair on a CREATE only; on a merge, presence is the user's.
131. **~~Design appendix §13 was not readable in this repo~~ — AMENDED IN B8 ROUND 1: the
     appendix IS readable on this machine (the vault copy), and the naming is now VERIFIED, not
     UNVERIFIED.** The shim name `daily-briefing` is exactly what appendix `:337` (T19)
     prescribes (*"an 'Install command-line tool' action symlinking
     `/usr/local/bin/daily-briefing`"*). The build round's "rejected alternative
     `daily-briefing-app`" text was a MISREADING and is struck: that name is the APP BUNDLE's
     `executableName` (appendix `:189` — deliberately NOT `daily-briefing`, *"so it cannot
     shadow the CLI on PATH"*), a packaging concern and never a shim-name candidate. R1 line
     27's second half (the `daily-briefing-app` executable name) is thereby explicitly DEFERRED
     to the packaging task family (T22/T23), not resolved here. The one real divergence from the
     appendix's own text is the confirmation shape — deviation 138.
132. **`cli_shim_remove` is an enumerated exception to the webview's no-deletion-name scan**
     (`tests-web/history.check.ts`): it removes the app's OWN symlink — the reversibility dev 63
     requires — and can reach no briefing, archive or engine file (no operand; `classify`'s
     foreign refusal). The scan still fails any OTHER deletion-shaped name.
133. **The wizard's repos step requires at least one source.** A draft with no roots and no
     repos would validate (both keys are optional) and deliver empty mornings forever; the
     wizard exists to produce a working setup, and "set up nothing" is the cancel button.
134. **The floor is written only when it differs from the default or the key already exists**,
     and a members-unchanged list keeps the existing array (order included) — both so an
     untouched re-run is the save path's `unchanged` no-op instead of a cosmetic write
     (`wizard.check.ts`'s byte-identical round-trip). **AMENDED IN B8 ROUND 1 — the premise was
     FALSE for path (c) and is now true, plus three merge-rule corrections:** (1) the local path
     FORCED `networkProbeHosts: []` on every merge, so an untouched path-(c) re-run was a real
     write (measured: `[{host:"1.1.1.1",port:443}]` → `[]`) — now prefilled only where the key
     is ABSENT, and the round-trip pin gained a local-provider fixture (the FULL fixture is
     CLI-only, which is why this survived); (2) the members-unchanged comparison is a MULTISET,
     not a set (`["a","a","b"]` vs `["a","b","b"]` share a set but differ — degenerate configs,
     real difference — fixed, not just recorded); (3) a provider rebuild that changed no VALUE
     keeps the existing object, order included (the api/local arms rebuild wizard-owned keys,
     which preserves values but could reorder keys — and a reordered candidate is a WRITE to the
     byte-level `unchanged` check). Adjudicated in the same round (Gemini B1's other half):
     SWITCHING the CLI deliberately rebuilds `argv` — a codex argv on a claude CLI would be
     wrong — kept and pinned; unowned provider keys still ride through.
135. **`SaveOutcome` gained `created` and `SaveError` gained `alreadyExists`** — additive wire
     variants (`lib/files.ts` updated together with the Rust types); `created` rather than a
     `saved` with an empty `backupPath` a caller could mistake for a path.
136. **The mid-wizard recovery re-seeds the draft and gates the second write on an explicit
     acknowledgement** (round 1, the F1 HIGH). The `alreadyExists`/`conflict` catch used to
     re-read the DOCUMENT but not the DRAFT, so the next click merged a fresh-setup draft over
     the config the exclusive create had just protected (measured: repos deleted, provider
     rebuilt as template, floor reset to 07:20; only `$comment` survived). Now: re-read →
     re-seed (`draftFromConfig`) → the pre-populated banner renders → the save button stays
     disabled until the user ticks the recovery checkbox (`wizard::saveGateBlocker`). A document
     whose fields CANNOT be seeded (`{"provider":{"api":null}}`, measured — the old try/catch
     covered only `JSON.parse`, and unreadable text fell back to an EMPTY draft with the save
     enabled) now blocks the gate outright: `draftFromConfig` answers `null`, never a guessed
     draft. §13a's re-run claim is scoped to the two reachable re-entry shapes accordingly.
137. **The Stale-arm replace window is a RECORDED bounded race, not a fixed one** (round 1;
     Gemini A1's real half — its Absent-arm half is REFUTED: the create is exclusive, and a file
     appearing between inspect and install answers `EEXIST`, pinned with a stale-inspect sink).
     The Stale arm's temp-symlink + `rename(2)` is inherently clobbering; a re-inspect
     immediately before the rename would NARROW the window, never close it (rename has no
     exclusive form), and would imply a guarantee the code cannot give. The residual, honestly:
     one single fixed path, precondition OURS-at-inspect, and a foreign swap must land between
     one command's inspect and its rename — the same accepted class as deviation 47's replace
     window on the config path.
138. **A foreign file at the shim name is refused OUTRIGHT where the appendix asks
     replace-with-confirmation showing both versions** (appendix `:902`/`:919`; round 1).
     Kept deliberately: refusing is strictly safer than replacing behind any dialog, the manual
     `sudo` path remains for a user who wants the name, and a replace-with-confirm (which needs
     both versions resolved for display) can land later as its own change without unwinding
     anything shipped here.
139. **`config_create` widens the webview's execution-influence surface to FIRST configs**
     (round 1, recorded in §13d): `provider.argv`, `provider.api.apiKeyCommand`,
     `notify.command` and `auditJudgeArgv` are engine-executed argv classes a first config can
     now carry from the webview — T15 granted this over existing configs; B8 extends it to
     creation. No code change: the engine executes these by design, refusing them would break
     legitimate configs, and the CSP/no-remote-content posture is the boundary. Named because
     `apiKeyCommand` runs UNATTENDED under launchd at key-resolution time.
140. **Step 1's promise is scoped to the config and the scheduler** (round 1). The old copy —
     "No file is written and nothing is installed until you confirm at the last step" — was
     contradicted by step 4: `access_probe`'s button raises the REAL macOS TCC prompt and, on a
     successful read, writes the app's own access record (`access.rs`, grant-observed) before
     the save gate. The copy now reads "no configuration is written and nothing is installed…;
     the folder-access step asks macOS for permission only when you press its button". The
     probe behavior is unchanged — it is an explicit user action, and recording an observed
     grant is its purpose.
141. **The step-6 orphan shape, recorded** (round 1; extends dev 126): a user who saves at the
     step-5 gate and quits during step 6 has a config on disk, no wizard re-entry (the phase is
     no longer `not-configured`), and background delivery not yet installed. Nothing is lost:
     the Schedule screen IS the same install component, and Settings edits the same config —
     the wizard is a path through existing surfaces, not the owner of any of them.
142. **A `..` in a draft entry is an engine-parity residual, not a GUI-side fix** (round 1,
     Gemini A5 — same class as deviation 101): a draft path is prefix-matched and displayed,
     never opened, joined or spawned, and the same textual form is legal in a real config's
     `repos`/`discoverRoots`, where the ENGINE's semantics govern. A one-sided GUI
     normalisation would make the wizard's scope display disagree with what the engine will
     actually do — recorded, no fix.
143. **The grant step ships as step 4, not inside step 6** (round 1; the R1-line-34
     reconciliation). R1's rework line places grant acquisition inside the delivery step; the
     design appendix and §8a's B6 contract place `ScheduleAccess` as its own CONDITIONAL step
     4, and B8 shipped that. §1c's rule is that R1 wins over the appendix where they conflict,
     so the placement is recorded as a deviation FROM R1 rather than silently following the
     appendix: step-4 placement is load-bearing for deviation 128's explained-prompt rule (the
     grant guidance must precede the first post-save walk of `~`), and both placements use the
     same flow component, so nothing else diverges.
144. **The EDIT path's literal-key refusal is still the single canonical pointer** (round 2,
     V-5). `config_save`'s pipeline handles `/provider/api/apiKey` exactly (`redact` on read,
     `restore_api_key` on save — the placeholder-restore contract), while `config_create`
     refuses apiKey-named keys ANYWHERE via `holds_literal_api_key` (round 1, F3). Recorded
     rather than wired shut here because the honest edit-path scan is not the create path's
     three lines: the canonical slot is LEGAL on disk (the engine's own `apiKey` field), and
     `config_read` redacts only that pointer — so a hand-written config holding a
     non-canonical apiKey-named key round-trips through every candidate, and a bare
     scan-refusal would brick all subsequent Settings edits of such a file behind a misleading
     `apiKeyChanged`. Discriminating introduced-by-this-edit from round-tripped-from-disk
     needs a positional diff of apiKey sites plus a rule for pre-existing non-canonical keys.
     Bounded meanwhile: the wizard's create (B8's surface) refuses at any spelling, and the
     edit path's owner-only mode rule fires whenever either side carries `/provider/api` —
     the residual is a hand-added apiKey-named key OUTSIDE any api block keeping a 0644 file.
     Follow-up: an introduced-by-this-edit scan in `save_value`.
145. **A `config_read` failure DURING the alreadyExists/conflict recovery leaves the PRIOR
     `recovered`/`recoverAck` state in place** (round 2, V-6/GE1; measured SAFE). The inner
     catch reports the failure without re-seeding — but the stale draft's second save still
     cannot clobber: the edit path's stale `base` digest answers `conflict`, and the create
     path's exclusive create answers `alreadyExists`. A residual UX wrinkle (the
     acknowledgement checkbox can render against a stale banner), not a safety gap.

### 13g. What B8 does NOT execute, and what is therefore UNRUN (VM-gated)

Beyond §1b, §9, §10f, §11f and §12c, all unchanged:

- **The real `/usr/local/bin` leg of the CLI shim.** Every test drives a recording sink or the
  real `SystemShim` against a scratch directory; writing, repairing or removing the symlink in
  the real root-owned directory — and the `sudo` manual path shown on refusal — is the clean-VM
  register's.
- **The wizard end to end in a real webview.** SSR renders step 1 and runs no click handler
  (§10f's standing note); every rule is pure and table-tested (`lib/wizard.ts`), the save gate's
  two IPC calls are pinned by source scan, and `config_create` itself is driven through real IPC
  — but no test walks a real webview through all six steps against the real engine on a clean
  machine.
- **The live `schedule install` + kickstart from step 6** — §1b's VM-gated legs, reached through
  the SAME components as the Schedule screen (no new exec surface to gate).
- **A real TCC prompt from step 4** — §11f's legs, unchanged; the wizard adds a caller of the
  same `access_probe`, not a new prompt path.
- **The first post-save `doctor --json` walk of `~` on a real machine with protected folders**
  (deviation 128's recorded cost): whether and when macOS prompts for Desktop/Documents/Downloads
  during that walk is a TCC leg no test reaches.
- **`config_create` against the REAL engine's validator with the REAL config path** — the fake
  validates in every IPC test; the real `config validate` is exercised by the existing
  real-engine save test's sandbox, not by a create (the create's own real-engine leg is the
  clean-VM first-run scenario).

### 13h. The B8 mutation ledger, enumerated for replay (round 1)

The build round reported its ledger only summarily ("15+1, all red; one initial survivor — the
link-arm race — answered by adding the missing test"), which a later verifier cannot replay; its
per-mutation enumeration is not reconstructable from the record and is carried as exactly that.
**From this round on the ledger is enumerated** — target, mutation, killing test — so replay is
mechanical (fresh disposable copy, delete-first, applied-check via diff, restore byte-identical
`cmp` + `touch`). The round-1 ledger, every row RED:

| # | replays | target (file → mutation) | killed by |
| --- | --- | --- | --- |
| R1-1 | M-L1-A | `Wizard.svelte` → recovery call `seedFromDocument(next)` reverted to `doc = next` | `wizard.check.ts` "the component wires it" (helper count) |
| R1-2 | M-L1-B | `wizard.ts` → seed-failure paths revert to returning the empty draft (isObj guards + final catch) | "a config whose fields cannot be seeded blocks the gate" |
| R1-3 | M-L1-C | `wizard.ts` → morningTime write condition drops the key-exists arm | "setting the floor back to the default still writes it" |
| R1-4 | M-L2-1 | `cli_shim.rs` `classify` → parent equality widened to `starts_with` | nested-path-under-state-dir pin |
| R1-5 | M-L2-2 | `cli_shim.rs` `classify` → parent equality widened to last-component match | elsewhere-named-`daily-briefing` pin |
| R1-6 | M-L2-6 | `cli_shim.rs` install Absent arm → `create` becomes `replace` | stale-inspect-sink race pin |
| R1-7 | M-L2-7 | `config_save.rs` `config_create` → pre-parse `too_large` deleted | `an_oversized_create_is_refused_before_parse_and_the_engine` |
| R1-8 | (e) | `access.rs` → `MAX_DRAFT_PATHS` 64→256 | `the_draft_bounds_are_the_documented_literals` |
| R1-9 | (e2) | `access.rs` → `MAX_DRAFT_PATH_BYTES` 1024→4096 | `the_draft_bounds_are_the_documented_literals` |
| R1-10 | — | `cli_shim.rs` → `sh_quote` becomes identity | sh word-splitting pin (spaced path) |
| R1-11 | — | `config_save.rs` → key scan reverts to the single pointer | `config_create_refuses_a_literal_key_at_any_spelling_or_position` |
| R1-12 | — | `wizard.ts` → `networkProbeHosts` forced `[]` again (guard dropped) | local-provider round-trip pin |
| R1-13 | — | `wizard.ts` → `keepOrSet` reverts to set comparison | multiset pin |
| R1-14 | — | `cli_shim.rs` `classify` → root-state-dir guard dropped | `stateDir="/"` degenerate pin |
| R1-15 | — | `access.rs` → format-control block deleted | BiDi/zero-width refusal pins |
| R1-16 | — | a test file gains a bare `CliShimState::default()` | `no_test_wires_the_real_sink_at_the_real_directory` |
| R1-17 | — | `wizard.ts` → `saveGateBlocker` recovery arm deleted | gate-blockers pin |
| R1-18 | — | `wizard.ts` → provider keep-if-value-equal always rebuilds | local-provider round-trip pin (key order) |

## 14. Icon, branding and the menubar template (T22, B22)

### 14a. The assets and the pipeline

Three HAND-AUTHORED SVG sources under `gui/src-tauri/branding/` are the only things a human
edits; every raster in the repo derives from them, deterministically, via
`gui/scripts/generate-branding.sh`:

| Source (hand-authored) | Derived, committed |
| --- | --- |
| `branding/master.svg` — 1024×1024 sun mark (disc + eight round-capped rays, flat `#FFC24B` on `#234A73`, the ☀️ the briefing header already uses) on the Big Sur 824×824/rx 185 grid | the whole `icons/` app-icon set: `icon.icns` (twelve elements — the full 16/32/128/256/512pt ladder at @1x/@2x, the 16/32 @1x slots in the legacy `is32`/`il32` types with their `s8mk`/`l8mk` masks), `icon.ico`, the PNG set incl. the `Square*`/`StoreLogo` tiles, plus `branding/icon-1024.png` (the canonical raster; about/branding surface) |
| `branding/tray-template.svg` — the same mark reduced to a monochrome glyph, pure `#000` on transparency | `icons/tray-template.png` (18×18) and `icons/tray-template@2x.png` (36×36) — BLACK + ALPHA ONLY, pixel-scanned by `tests/icons.rs` |
| `branding/dmg-background.svg` — 660×400, sun mark top-center, drag-to-Applications arrow | `branding/dmg-background.png` (660×400) and `@2x` (1320×800) |

The pipeline (script header carries the same record): the PINNED `@tauri-apps/cli` 2.11.4
(`gui/package.json`) rasterises every square asset — `tauri icon` for the full set, `-p 1024`
for the master raster, `-p 18 -p 36` for the tray templates; macOS `sips` rasterises only the
non-square DMG background (measured deterministic: byte-identical across runs; its `eXIf`
carries pixel dimensions, no timestamp), with the @2x rendered from the SAME svg by doubling
`width`/`height` while the `viewBox` pins the geometry. `gui/scripts/icns-canonical.ts` sorts
the ICNS elements by type code because the CLI's writer emits them in hash-map order
(deviation 147). **Idempotence is a runnable check, not a hope — and the floor runs it**:
`generate-branding.sh --check` regenerates into scratch and byte-compares all 22 derived files
against the committed ones (measured twice-in-a-row byte-identical at build time), and
`tests/icons.rs::regeneration_check_gate` shells out to it, making the check part of the
default `cargo test` floor on macOS — the only OS whose renderers exist (`sips` ships nowhere
else). That macOS gating is also why "CI-runnable" would be an overclaim: CI is ubuntu-only
and runs no cargo at all, so the floor test is the check's ONLY caller. Every tool is checked
before use and the derived-file list is ENUMERATED — with every generated source verified
present BEFORE any destination is rewritten — so an absent tool or a CLI whose output set
changed fails loudly instead of silently skipping or half-rewriting the committed tree. Asset
generation is local-only; nothing fetches.

**The tray wiring is B4's, read and kept** (`shell.rs:1041-1068`): `TRAY_ICON_PNG` includes the
@2x file on macOS (the measured 18pt forcing — see deviation 146's sibling note there),
`icon_as_template(true)` already set; B22 replaces the placeholder GLYPH, not the wiring, and
keeps the filenames the `include_bytes!` paths name.

**License in the bundle — the choice, recorded** (the appendix names no mechanism): the ONLY
license wiring is `bundle.resources: { "../../LICENSE": "LICENSE" }`, which lands the MIT
text of the SUB-PROJECT root `daily_briefing_application/LICENSE` (the repo root carries no
LICENSE) at `Contents/Resources/LICENSE` — asserted against the built bundle at the floor.
The macOS `.app` bundler has no license handling of its own (measured against
`tauri-bundler` 2.9.4: `bundle/macos/app.rs` — no license path at all), and
`bundle.licenseFile` is DELIBERATELY OMITTED — deviation 149 records why (on the default
build it ships a click-through DMG EULA). `bundle.license` (the identifier) stays implicit —
it defaults from `Cargo.toml`'s `license = "MIT"`, which is also the field the rpm bundler
records (`linux/rpm.rs:61,78` — `settings.license()`, the SPDX name; rpm never reads
`licenseFile`).

**About box and window icon, dispositioned**: the About item is B4's
`PredefinedMenuItem::about` with name+version metadata only (`shell.rs:1117-1125`), which muda
routes to AppKit's STANDARD about panel (`muda-0.19.3` macos `orderFrontStandardAboutPanel…`,
read) — with no icon option the panel shows the app's bundle icon, i.e. the new `.icns`;
`branding/icon-1024.png` is the committed raster for any future surface that wants one. macOS
windows show no title-bar icon: the conf's `bundle.icon` PNG entries feed the window-icon
path that `tao` documents as macOS-unsupported (`tao-0.35.3 src/window.rs`
`set_window_icon` — "iOS / Android / macOS: Unsupported"; the macOS `platform_impl` body is
empty), so that leg is Linux/Windows-only, and the entry list is unchanged from base.

**Bundle identifier**: `com.themarigold.daily-briefing`, unchanged — plan R1 froze it
(plan:25) over appendix T22's `dev.dailybriefing.app`, and §1c's rule is that R1 wins. Verified
repo-wide: no config anywhere carries the old id (the only `dailybriefing` hit is
`probe.rs:79`'s doc comment RECORDING the supersession, and `tests/tcc_probe.rs` pins the
constant against `tauri.conf.json`).

**T23 handoff, recorded**: the DMG background ships as ASSET ONLY. T23 wires
`bundle.macOS.dmg` — `background: "branding/dmg-background.png"` (or the @2x; T23 owns the
retina choice), and the geometry this file was drawn for: window 660×400, 128px icons, app
icon centered at (180, 210), Applications folder at (480, 210) — the arrow spans exactly the
gap between those two footprints, so moving the positions means regenerating the background.
The appendix's "DMG opens with background and Applications symlink positioned correctly" test
is T23's, in the clean-VM register.

### 14b. Deviations recorded by T22 (B22)

Numbered from 146, continuing §13f. §9's retire-in-place convention applies.

146. **The menubar template icons are 18pt (18/36px), not the appendix's "16/32pt @1x/@2x".**
     `tray-icon` 0.24.2 forces every macOS menu-bar image to a LOGICAL height of 18pt
     (`platform_impl/macos/mod.rs`, `icon_height: f64 = 18.0` — the measurement B4's
     `TRAY_ICON_PNG` note records, re-verified against the crate source this round), so a
     32×32 @2x would be upscaled to 36 physical pixels — soft exactly at the surface the
     appendix warns must not look amateur. B4's placeholder dimensions were already the
     measured-correct ones; B22 keeps them and replaces the glyph. `tests/icons.rs` pins the
     dimensions so a well-meaning "follow the appendix" regression fails.
147. **The shipped `icon.icns` is `tauri icon`'s output with its element order canonicalised**
     (`icns-canonical.ts`: sorted by four-byte type code, bytes otherwise untouched). The
     CLI's ICNS writer iterates a hash map — measured: two consecutive runs over the same SVG,
     twelve identical elements, shuffled order — which would break the pipeline's
     byte-identical-regeneration promise (`--check`). macOS reads ICNS elements by type, never
     by position. The script fails loudly on any container shape it does not fully understand
     (notably a `TOC ` element, which records order and would lie after sorting).
148. **The DMG background carries no text.** `sips`/CoreSVG would set text with SYSTEM fonts,
     which render differently across macOS versions — the committed PNGs would churn on the
     next machine and `--check` would flag phantom drift. The drag-to-Applications arrow is
     the instruction; every string stays in the installer chrome T23 owns. (Also the reason
     the sun mark is pure geometry in all three sources.)
149. **`bundle.licenseFile` is deliberately OMITTED** (orchestrator ruling, review round 1).
     Because dmg is a macOS target (B23: via `tauri.macos.conf.json`; at the time of this
     ruling via the base conf's since-removed `targets: "all"`), tauri-bundler feeds `licenseFile` to the DMG build as a
     click-through EULA — `settings.license_file()` becomes `--eula` to the `bundle_dmg`
     script (`bundle/macos/dmg/mod.rs:161-171`), which embeds it as a udifrez `LPic`
     resource: an Agree/Disagree panel before the volume even mounts, on every default
     `tauri build` DMG. A permissive MIT license does not warrant a mount-blocking EULA
     panel — the "amateur signal" class T22 exists to avoid — and the build round never
     exercised that surface (only `--bundles app` was built). The `.app` license mechanism is
     and remains the `bundle.resources` map (the load-bearing leg, unchanged);
     `tests/icons.rs` pins `licenseFile`'s ABSENCE so it cannot drift back. T23 (the DMG
     task) may reintroduce it DELIBERATELY if a click-through is ever wanted — a recorded
     decision to make, not a default to inherit.

### 14c. What B22 does NOT execute, and what is therefore UNRUN (VM-gated)

Beyond §1b, §9, §10f, §11f, §12c and §13g, all unchanged. T22's visual legs cannot be asserted
from a test process and are NOT faked:

- **The menubar template icon in a real menu bar** — light, dark and TINTED menu bars, and
  against a busy wallpaper (the appendix's stated visual check). The black+alpha pixel scan
  and `icon_as_template(true)` are the assertable halves; how macOS's recolouring LOOKS is the
  clean-VM register's.
- **The Dock/Finder rendering of the new `.icns`** at each size slot (the container walk
  asserts presence, not appearance), and the About panel actually showing it (AppKit standard
  panel; muda routing read, panel never opened — no test launches the app).
- **The DMG background in a real mounted DMG** with the Applications symlink positioned per
  the §14a handoff — T23's leg, listed here so the register carries it from day one.
- **The .app bundle-content leg — a floor OBSERVATION, replayable manually, not a committed
  test**: offline `cargo tauri build --debug --bundles app`, then assert the built .app
  carries a byte-identical `icon.icns`, the LICENSE text at `Contents/Resources/LICENSE`, the
  frozen `CFBundleIdentifier` and `CFBundleIconFile = icon.icns`. Nothing in the suite builds
  a bundle (the suite asserts the conf wiring and the source assets); the bundle replay is
  manual, and was re-run green after the round-1 `licenseFile` removal.
- **The Windows/Store consumption surfaces**: the `.ico`'s frames in real Windows chrome
  (title bar, taskbar, Explorer) and the `Square*`/`StoreLogo` tiles in an MSIX/Store
  packaging — no Windows build exists here. `tests/icons.rs` asserts their byte-level
  integrity (readdir over `icons/` + per-format completeness walks); the consumption legs on
  the unbuilt platforms are this register's.
- **License surfaces on the bundlers this repo does not build today** (NSIS/msi show a
  license at install): moot while `licenseFile` is deliberately omitted (dev 149) — they
  become real surfaces only if T23 reintroduces it, deliberately.

### 14d. The B22 mutation ledger, enumerated for replay

Per §13h's convention — fresh disposable copy (`cp -Rc` APFS clone of the whole
`daily_briefing_application` tree, delete-first, discarded after the run), applied-check via
`cmp` against the original, restore byte-identical `cmp` + `touch`. Every row RED (the check
fails with the mutation in place):

| # | target (file → mutation) | killed by |
| --- | --- | --- |
| B22-1 | `icons/tray-template@2x.png` → the first visible pixel recoloured `rgba(255,0,0,·)` (IDAT decoded, patched, re-encoded, re-CRC'd) | `the_menubar_template_icons_are_black_plus_alpha_only` |
| B22-2 | `icons/icon.icns` → the `ic10` (512@2x) element excised, header length rewritten | `the_icns_carries_every_required_size` |
| B22-3 | `tauri.conf.json` → `bundle.icon` gains `"icons/does-not-exist.png"` | `every_icon_the_conf_references_exists` |
| B22-4 | `tauri.conf.json` → `bundle.resources` map deleted | `the_license_is_wired_into_the_bundle` |
| B22-5 | `branding/dmg-background@2x.png` → truncated to 100 bytes | `the_branding_sources_and_derived_rasters_are_present_and_sized` — **the build round's one SURVIVOR, answered by strengthening the test**: magic + IHDR dims live in the first 100 bytes, so "starts like a PNG, claims the right size" passed; the test now also requires the trailing `IEND` chunk, and the SAME mutation re-run is red |
| B22-6 | `branding/master.svg` → sun disc fill nudged one hex digit (`#FFC24B`→`#FFC24C`) | `generate-branding.sh --check`, exit 1 — MISMATCH on all 18 master-derived files |

Round-1 fix mutations — the review round's gates-that-don't-run, answered and replayed under
the same convention (every row RED on the DEFAULT `cargo test` flavor unless noted):

| # | target (file → mutation) | killed by |
| --- | --- | --- |
| B22-7 | `icons/32x32.png` → zero-byte | `every_icon_the_conf_references_exists` + `every_committed_icon_is_complete_and_well_formed` (was: existence-only, survived). Measured while replaying: `tauri::generate_context!` ALSO refuses to compile with a zero-byte `bundle.icon` PNG, so under `cargo test` this mutant dies at build; the test-level kill was replayed against the prebuilt suite binary, both tests red |
| B22-8 | `icons/128x128.png` → truncated to 100 bytes | the same pair (IEND completeness on conf-referenced and readdir'd files) |
| B22-9 | `icons/icon.icns` → element order reversed, header intact | `the_icns_carries_every_required_size` — the exact-sequence pin on deviation 147's canonical order (was: slot-presence only, survived) |
| B22-10 | `icons/icon.icns` → junk 13th element appended, header length rewritten | `the_icns_carries_every_required_size` — the exact-sequence pin (12 elements, no more) |
| B22-11 | `icons/StoreLogo.png` → zeroed | `every_committed_icon_is_complete_and_well_formed` (conf never references it; readdir does) |
| B22-12 | `tauri.conf.json` → `identifier` → `dev.dailybriefing.app` | `the_bundle_identifier_is_the_r1_frozen_one` — on the DEFAULT flavor (the `tcc_probe.rs` pin is feature-gated and still stands) |
| B22-13 | `generate-branding.sh` → `command -v node` guard dropped, node absent from PATH | functional check, not a suite kill: the tauri CLI run fails, and the die now SURFACES the captured stderr naming node as the cause (was: stderr discarded) |

## 15. Packaging per platform, signing parameterization and the size budget (T23, B23)

### 15a. The shapes, the verdict and the measurements

**Per-platform bundle targets live in PLATFORM-SPECIFIC CONF FILES**, and the base
`tauri.conf.json` carries no `bundle.targets` at all (deviation 150 records the choice among
the three mechanisms Tauri 2 offers):

| file | `bundle.targets` | also carries |
| --- | --- | --- |
| `tauri.macos.conf.json` | `["app", "dmg"]` — built separately per arch (`--target aarch64-apple-darwin` / `x86_64-apple-darwin`), NOT universal: a universal binary would carry two ~62 MB sidecars | `bundle.macOS`: the signing parameterization and the DMG wiring below |
| `tauri.linux.conf.json` | `["appimage", "deb"]` | nothing else |
| `tauri.windows.conf.json` | `["nsis"]` — CI-only experimental (binding C3) | `bundle.windows.webviewInstallMode`: `downloadBootstrapper`, silent (the smallest installer; needs network at INSTALL time, which is the installer's disclosure, not the app's) |

The CLI merges the platform file over the base by JSON MERGE PATCH (RFC 7396 — tauri-utils
2.9.3 `config/parse.rs:54` names the files, `:185` is `json_patch::merge`; arrays replace
wholesale), and `tauri::generate_context!` applies the same merge at compile time, so the
suite compiles against the same merged view CI builds. Because a merge patch lets ANY key in
a platform file silently override the base on one platform only, `tests/packaging.rs` pins
the EXACT key sets of all three files, the base's `targets` ABSENCE, and `bundle.licenseFile`
absence in EVERY conf file (dev 149's pin covered the base; the macOS file is the live
hazard — the DMG target is exactly where `--eula` bites).

**DMG wiring — §14a's handoff, consumed verbatim** (`bundle.macOS.dmg`): background
`branding/dmg-background.png` (@1x — deviation 151), window 660×400, app at (180, 210),
Applications drop link at (480, 210). The y=210 pins are load-bearing against the bundler's
(x, 170) defaults (`tauri-utils config.rs:587-593`); 128 px icons are `bundle_dmg`'s own
default (`ICON_SIZE=128`, tauri-bundler 2.9.4 `dmg/bundle_dmg:27` — no `--icon-size` is
passed and DmgConfig cannot set it, so there is nothing to wire). The built DMG was mounted
READ-ONLY and content-asserted (never launched): `.background/dmg-background.png`
byte-identical to the committed asset, `Applications → /Applications` symlink present,
`Daily Briefing.app` present with its nested sidecar byte-identical to the built one,
`.VolumeIcon.icns` present, and `hdiutil imageinfo` reports
`Software License Agreement: false` — the dev-149 no-EULA promise, asserted on the real
artifact. The Finder-layout `.DS_Store` is NOT in this build, and with it goes ALL the
branding — nothing binds the copied background or the icon positions without it —
deviation 155.

**Signing parameterization — present and EMPTY** (`bundle.macOS`): `signingIdentity` is
explicitly null, `hardenedRuntime` true, `entitlements: "entitlements.plist"` (explicitly
NOT sandboxed, no other entitlement — deviation 153 for why the file carries no comments).
Today, with no identity and no certificate in the environment, `tauri-bundler` builds
UNSIGNED — exactly as before this change (`sign.rs:19-44`: no `APPLE_CERTIFICATE` env pair
and a None identity → no keychain → the whole sign block is skipped). Deviation 152 records
the CI secret shape. Notarization credentials are env-only and absent
(`sign.rs:96-160`: `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID`, or
`APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`); with none set the bundler warns
and skips notarization (`app.rs:135-150`) — the one hard error is APPLE_ID+PASSWORD with no
team id (`MissingTeamId`).

**The nesting verdict (the appendix's RISK:HIGH question), answered on two legs:**
tauri-bundler 2.9.4 DOES sign the nested externalBin, so the appendix's conditional
post-bundle codesign step is NOT added (deviation 154 — including the bare-name correction
that step would have needed).

* *Source leg*: `bundle/macos/app.rs:99-105` — `settings.copy_binaries()` copies every
  externalBin into `Contents/MacOS` and pushes each as a `SignTarget { is_an_executable:
  true }`; `:107-111` adds the main binaries; `:122-125` pushes the `.app` itself LAST;
  `sign.rs:53` iterates IN ORDER ("signing must be done inside out", `:120-121`). Each
  target gets `codesign --force -s <identity> --options runtime --entitlements <file>`
  (`tauri-macos-sign` 2.3.4 `keychain.rs:221-239`; runtime because `is_an_executable &&
  hardened_runtime`), after `xattr -crs` on the bundle (`app.rs:127-129`).
* *Probe leg* (`gui/scripts/nesting-probe.sh`, replayable — a floor observation over a built
  .app, per §14c's convention for bundle-content legs): the same file set and order, ad-hoc
  (`-s -`) on a scratch COPY. Measured: the sidecar comes out
  `flags=0x10002(adhoc,runtime)`, `codesign --verify --deep --strict` explicitly
  `--validated` the nested `Contents/MacOS/daily-briefing` and passes. Negative control A
  (strip the sidecar signature) goes red. Negative control B (fresh copy, sign ONLY the
  bundle) is the classic failure, measured end to end: **codesign SUCCEEDS silently** — the
  sidecar keeps its build-time `linker-signed` ad-hoc signature (`flags=0x20002`,
  `Identifier=a.out` — bun's compile emits it) — and validation then fails with
  `invalid signature (code or signature have been modified) / In subcomponent: …/Contents/
  MacOS/daily-briefing`. Silent at build, fails on the user's machine: exactly the appendix's
  risk, and exactly what the bundler's inside-out order prevents.

**`spctl` observations (read-only, local, both recorded — the "expected 'unnotarized'
reason" leg needs a real identity and is VM-gated, §15c):** on the UNSIGNED debug build,
`spctl -a -vv` rejects with `code has no resources but signature indicates they must be
present` (rc=1) — an unsigned-bundle-class rejection whose string comes from the only
signature spctl can find, the linker-signed main Mach-O with no resource seal; on an AD-HOC
signed scratch copy it rejects with a clean `rejected` (rc=3) and no malformed-signature
complaint. Neither is a malformed-signature class; neither can say "unnotarized" because
nothing is signed with an identity notarization would recognise.

**The size budget** (`gui/size-budget.json`, enforced by `tests/packaging.rs`): sidecar
re-measured **61,810,018 bytes** — B22's floor figure exactly; the appendix's 61,677,922
anchor is recorded beside it and the current measurement governs. Release-build actuals,
2026-09-17, aarch64 (x86_64 std is not installed here — UNMEASURED, §15c):

| artifact | budget (bytes) | measured (bytes) |
| --- | --- | --- |
| .app aarch64 (tree sum) | — | 75,230,547 |
| DMG aarch64 | 45,000,000 | 26,264,487 |
| DMG x86_64 | 45,000,000 | UNMEASURED |
| deb x86_64 | 80,000,000 | UNMEASURED |
| AppImage x86_64 | 160,000,000 | UNMEASURED |
| NSIS x86_64 | 70,000,000 | UNMEASURED |

The test re-stats whatever exists locally — SYMMETRICALLY: the recorded actual and the
on-disk size must sit within the >20% bound of EACH OTHER (an inflated baseline disarms the
gate as surely as a grown artifact; the predicate is unit-tested on both sides of its
boundary) — and over-ceiling fails. A measured row whose path is missing while its artifact
ROOT exists (`target/release/bundle`; `src-tauri/binaries` for the sidecar) FAILS as STALE:
libtest swallows stdout on passing tests, so there is no loud-skip channel and a printed
skip would be invisible under the floor command (round-1 H1 corrected the three "skips
LOUDLY" claims this section and the file's own note used to carry). Only a fresh clone with
no artifact root at all skips; null rows are ceiling-only. CI wiring is T24's, in
`publish/` only.

### 15b. Deviations recorded by T23 (B23)

Numbered from 150, continuing §14b. §9's retire-in-place convention applies.

150. **Per-platform targets are platform-specific conf files, and the base conf carries no
     `bundle.targets` at all.** Tauri 2 offers three shapes: a base-conf value (one value for
     every OS — cannot express this matrix), per-job `--bundles` flags (the value lives in
     T24's workflow, invisible to this repo's tests), or `tauri.<platform>.conf.json` files
     merged by JSON Merge Patch (declarative, testable here, and CI jobs run a plain
     `tauri build --target <triple>`). The files win. The base key is REMOVED rather than
     left as `"all"`: a base value is dead config that takes over the moment a platform file
     is deleted or renamed — with `"all"` that failure mode quietly bundles every installer
     no one budgeted or branded. `tests/packaging.rs` pins the absence, the three files'
     exact targets AND exact key sets (a merge patch is a silent per-platform override
     channel — the pin is the visibility).
151. **The DMG background is wired @1x** (`dmg-background.png`, 660×400 — matching the
     window geometry), not the @2x. The bundler hands create-dmg's fork a single
     `--background` file; retina there conventionally means a multi-resolution TIFF
     (`tiffutil`), a derived asset this task deliberately does not add to B22's enumerated
     22-file pipeline for an unverifiable-here rendering win. The @2x stays committed
     (§14a's table) for a future deliberate multi-res pass. How the @1x RENDERS on a retina
     display is the §15c visual leg — and the whole trade-off is DOWNSTREAM of deviation
     155: a background renders at all only when the Finder-layout leg runs
     (`TAURI_BUNDLER_DMG_IGNORE_CI=true` on a Finder-capable runner, or a pre-generated
     `.DS_Store`).
152. **The CI signing secret shape is the certificate-import path, and the conf identity
     stays null.** `signingIdentity: null` is the recorded parameterization point
     (present-as-null, pinned); the CI leg imports a certificate via
     `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD`, which tauri-bundler consumes WITH a
     null identity (`sign.rs:19-36` — it builds the keychain from the cert; a non-null
     identity is only a cross-check against the cert's own name). That covers the appendix's
     "stable project self-signed identity from a CI secret" without this repo hardcoding an
     identity string that must match a cert it does not hold. `APPLE_SIGNING_IDENTITY` as an
     env override: SOURCE-VERIFIED (round 1 — this entry first recorded it UNVERIFIED on the
     false premise that the CLI was "not source in the registry cache"; `tauri-cli-2.11.4`
     IS in the cache, matching `@tauri-apps/cli` 2.11.4, and had been for three days when
     that was written). `rust.rs:1467-1475`: the env var wins OUTRIGHT and the conf identity
     is only the fallback; `APPLE_PROVIDER_SHORT_NAME` behaves identically (`:1477-1485`).
     Either route works; the certificate pair stays the recorded CI shape. ⚠ AND THE
     BASE-CONF ROUTE IS TRAPPED (RFC 7396): `signingIdentity: null` in the platform file is
     a merge-patch DELETE — it does not survive the merge and would silently REMOVE an
     identity someone later sets in the base `tauri.conf.json` (unsigned build, no error).
     The marker lives in the FILE; fill via env, `--config`, or the certificate pair, never
     via the base conf (`tests/packaging.rs` documents the same trap at the pin).
153. **`entitlements.plist` must carry NO `--` sequence outside comment delimiters —
     MEASURED (cause corrected in round 1): AMFI rejects a literal `--` INSIDE an XML
     comment; comments themselves are fine.** The first probe run failed with
     `AMFIUnserializeXML: syntax error near line 16` (a header comment quoting a flag pair —
     `codesign --options` phrasing is natural for exactly this file); `plutil -lint` passes
     the same file, so nothing before the SIGN step would have caught it — on the
     parameterized path that is the first CI build with a certificate, failing on every
     target. This entry originally over-generalized the cause to "codesign rejects XML
     comments": round-1 re-measurement (two independent probes; 12 comment variants
     codesign-green incl. repo-style multi-line headers; only a `--` inside a comment
     reproduces the exact error, which `plutil` tolerates) narrowed it, and the suite now
     pins the REAL rule (`tests/packaging.rs`: strip the `<!--`/`-->` delimiters, no `--`
     may remain). A header comment that avoids `--` is permitted; the file simply stays
     minimal today (explicit `app-sandbox` false, nothing else). The hardened-runtime
     question for the Bun sidecar (`disable-library-validation`, possibly
     `allow-jit`/`allow-unsigned-executable-memory`) re-opens at the FIRST SIGNED BUILD,
     not the notarization pass: `sign.rs:68` applies `--options runtime` plus this
     entitlements file to every executable target the moment ANY identity exists —
     including the self-signed CI certificate, which is all spk-2's **G8** (the recorded
     does-the-sidecar-run-under-hardened-runtime check) needs. Verify G8 there; nothing is
     added pre-emptively (the suite pins exactly one `com.apple.security.` key).
154. **No post-bundle codesign step is added — the bundler signs the nested externalBin**
     (the appendix's conditional, resolved NOT-TRIGGERED on the two-leg evidence in §15a).
     AND THE STEP AS PRESCRIBED WOULD HAVE MISSED: the appendix names
     `Contents/MacOS/daily-briefing-*`, but the bundler STRIPS the `-<triple>` suffix at
     copy time (`settings.rs::copy_binaries` — `.replace(&format!("-{}", self.target), "")`;
     measured in the built .app: the sidecar is `Contents/MacOS/daily-briefing`, bare), so
     that glob matches NOTHING in the bundle. Recorded so any future post-bundle step (a
     re-sign after a resource edit, a notarization repair) never inherits the wrong pattern.
     `nesting-probe.sh` therefore enumerates sidecars as "executables in Contents/MacOS
     minus CFBundleExecutable" and FAILS on an empty enumeration (mutation B23-9).
155. **The DMG ships from this machine WITHOUT the Finder `.DS_Store` layout, via the
     bundler's own skip mechanism — and T24 inherits a decision here.** The layout is
     written by create-dmg's AppleScript driving Finder; in this headless session the
     AppleEvent times out (`Finder got an error: AppleEvent timed out. (-1712)` — no
     Automation grant can be answered, and granting TCC is on the never-touch list), which
     FAILS the whole `--bundles dmg` build. The build here uses the bundler's own CI switch
     (`CI=true` → `--skip-jenkins`, `dmg/mod.rs:173-181`), and the consequence is the
     script's own words (round-1 correction — this entry first said only the position/size
     `.DS_Store` was absent): *"This will result in a DMG without any custom background or
     icons positioning"* (`bundle_dmg.sh:517`). The skipped AppleScript is what BINDS the
     background and the icon positions; the background FILE and the Applications link still
     land (plain `cp`/`ln` before it), but nothing references the copied file, so the user
     sees a default Finder window over a hidden `.background/` folder nobody reads. The
     bundler also SWALLOWS that warning (`dmg/mod.rs:188` `output_ok()`; measured: 0
     occurrences of it in this build's entire 55-line log) — the operator is never told.
     THE TRAP: GitHub Actions sets `CI=true`, so WITHOUT `TAURI_BUNDLER_DMG_IGNORE_CI=true`
     (and a runner that can drive Finder at all — an open question T24 must MEASURE, not
     assume) the RELEASED DMG carries NO branding (if the runner cannot: accept the
     brandless DMG deliberately, or pre-generate the `.DS_Store`). The geometry stays wired
     and pinned either way; the visual leg was always §15c's.
156. **B8's zero-platform-siblings security pin is REFINED, not removed — platform config
     files are permitted only as BUNDLE-ONLY.** `tests/capability.rs`'s
     `exactly_one_capability_file_exists_and_nothing_is_declared_inline` asserted that NO
     `tauri.<platform>.conf.json` sibling exists, because the builder merge-patches a sibling
     over the base conf BEFORE the ACL is resolved and a merged non-empty
     `app.security.capabilities` REPLACES the capability files outright. T23's targets
     mechanism (dev 150) collides with the letter of that pin; the property it guards does
     not require zero siblings, only that no merged file can REACH the ACL. The assertion now
     asserts the discovered sibling set EQUALS exactly the three recorded files and then
     walks it, requiring each to be plain JSON with top-level keys within
     {`$schema`, `bundle`} — an unparseable (`.json5`/`.toml`) sibling fails loudly rather
     than dodging the key walk. The discovery walk is SHARED (round-1 hardening,
     `tests/common/mod.rs`): `capability.rs`'s security walk and `packaging.rs`'s
     targets-authority pin both assert SET-EQUALITY over the same enumeration, so a
     neutered walk fails BOTH suites instead of passing vacuously, and a FOURTH sibling —
     even a bundle-only one, which nothing else on this machine ever reads — is refused
     outright rather than admitted key-bounded. (Round 1 falsified this entry's original
     "cannot drift apart" claim with exactly that pair of mutations; and bundle-only bounds
     the ACL blast radius without making a sibling harmless — `frameworks`/`files`/
     `infoPlist`/`exceptionDomain` are bundle keys with runtime consequences.) The
     refinement closes the SAME channel at the same test site (mutation B23-10 proves the
     new predicate bites: an `app` key in a sibling is red); recorded here because a
     builder loosening a security pin to admit its own change is exactly the move that
     deserves a written trail.

### 15c. What B23 does NOT execute, and what is therefore UNRUN (VM-gated)

Beyond §1b, §9, §10f, §11f, §12c, §13g and §14c, all unchanged:

- **Linux and Windows configs are source-verified, never built here**: `tauri.linux.conf.json`
  and `tauri.windows.conf.json` are shape-pinned by the suite and their values verified
  against tauri-utils 2.9.3's schema types (targets enum, `WebviewInstallMode`), but no
  appimage/deb/nsis build ran — no builder for those platforms exists on this machine. First
  execution is T24's CI matrix; first install-and-launch is T26's VMs (Ubuntu 22.04 per the
  appendix).
- **The x86_64-apple-darwin leg entirely**: rust std for the target is not installed
  (`rustup target list --installed` → aarch64 only; ~1 GB of toolchain was not installed for
  a number T24's CI produces anyway). Its budget rows are honestly-null UNMEASURED entries
  the suite checks as ceiling-only (there is no loud print channel — §15a, round-1 H1).
- **Real-identity signing, notarization, and `spctl` ACCEPTANCE**: no signing identity
  exists on this machine (`security find-identity` reported 0 at plan time; nothing here may
  create one). The ad-hoc probe answers the NESTING question; it cannot answer chain
  validation, notarization, or Gatekeeper acceptance — including the appendix's "rejection
  reads 'unnotarized', not malformed" assert, which needs a SIGNED build to produce that
  string (both local rejection strings are recorded in §15a). VM/CI leg with the real
  certificate secret.
- **The DMG's Finder layout, generated and seen**: generation is environment-blocked here
  (deviation 155); the appendix's "DMG opens with background and Applications symlink
  positioned correctly" visual check was §14c's register entry and stays VM-gated, now with
  the extra condition that the DMG under test must be built by a layout-capable builder.
- **Install-and-run legs**: nothing here mounts-and-LAUNCHES, installs to /Applications,
  or runs the right-click→Open Gatekeeper path (appendix T23 TESTS) — T26's clean-VM
  walkthrough, per the plan's live-domain rule.
- **T24 handoff — what CI must assert (workflows live in `publish/` ONLY, never app-level
  `.github`)**: run the size-budget check per bundle job over `gui/size-budget.json` and
  fail the job on over-ceiling or >20% regression (the marker-artifact mechanics are plan
  T2(W)'s); build macOS per-arch with `--target`, never universal; re-measure and commit
  updated actuals deliberately IN THE SAME CHANGE as a version bump (the recorded paths
  carry the version string, and the suite FAILS on a stale row wherever release bundles
  exist — round-1 H1); secrets: `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` (sign),
  `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or the `APPLE_API_KEY` trio (notarize, later,
  absent now), `TAURI_SIGNING_PRIVATE_KEY` (updater, T21's); the certificate-import path is
  gated on ENV PRESENCE, not CI (`sign.rs:19-27`), and is NOT ephemeral —
  `tauri-macos-sign` creates `$HOME/Library/Keychains/<random>.keychain-db`
  (`keychain.rs:65-71`), imports with `-T /usr/bin/codesign` (`:105-127`), REWRITES the
  user keychain search list (`:160-181`), and with a null conf identity signs with
  `identity::list().first()` from that keychain (`:183-185`, no cross-check); cleanup is
  `Drop`-only (`keychain.rs:29-38`), so a cancelled or timed-out job leaves a
  certificate-bearing keychain and a dangling search-list entry on the runner — the job
  needs an explicit `security delete-keychain` in an `always()` step, and anyone exporting
  those vars LOCALLY gets the same writes to their real keychain directory; decide
  `TAURI_BUNDLER_DMG_IGNORE_CI` per deviation 155 — without it (on a runner that can drive
  Finder at all, which T24 must MEASURE) the released DMG carries NO branding — and keep
  consuming Apple secrets on tag-push only.

### 15d. The B23 mutation ledger, enumerated for replay

Per §13h/§14d's convention — fresh disposable copy (`cp -Rc` APFS clone of the whole
`daily_briefing_application` tree at a constant scratch path, delete-first, discarded after
the run; a shared out-of-tree `CARGO_TARGET_DIR` keeps the clone compile warm), applied-check
via `cmp` against the original, restore byte-identical `cmp` + `touch`. Every row RED:

| # | target (file → mutation) | killed by |
| --- | --- | --- |
| B23-1 | `tauri.macos.conf.json` → dmg `appPosition.y` 210→170 (the bundler default — the exact silent regression) | `the_dmg_wiring_is_the_b22_handoff` |
| B23-2 | `tauri.macos.conf.json` → `bundle.licenseFile` reintroduced | `no_conf_file_reintroduces_the_license_file` (the platform-merge channel dev 149's base-conf pin could not see) |
| B23-3 | `tauri.conf.json` → `bundle.targets: "all"` restored | `the_platform_conf_files_are_the_only_targets_authority` |
| B23-4 | `tauri.macos.conf.json` → `signingIdentity` set to a Developer ID string | `the_signing_parameters_are_present_and_empty` |
| B23-5 | `tauri.windows.conf.json` → `webviewInstallMode` → `embedBootstrapper` | `the_windows_webview_mode_is_the_downloaded_bootstrapper` |
| B23-6 | `entitlements.plist` → `com.apple.security.cs.disable-library-validation` added | `the_entitlements_are_not_sandboxed_and_carry_no_exceptions` (exactly-one-entitlement pin) |
| B23-7 | `size-budget.json` → deb ceiling 80,000,000→90,000,000 | `the_size_budget_file_is_schema_valid_and_carries_the_appendix_ceilings` |
| B23-8 | `size-budget.json` → dmg-aarch64 `measuredBytes` deflated to 20,000,000 (making the real 26,264,487-byte artifact read as a +31% regression) | `the_recorded_actuals_match_a_re_stat_of_what_exists_here` |
| B23-9 | `nesting-probe.sh` → sidecar enumeration pointed at `Contents/MacOSX` (the broken-glob class) | functional check, not a suite kill: the probe exits 1 on "enumerated ZERO sidecars" instead of passing vacuously |
| B23-10 | `tauri.macos.conf.json` → gains `"app": {"security": {"capabilities": [{"identifier": "aaa-extra", "windows": ["main"], "permissions": ["core:default"]}]}}` — the exact ACL-displacement payload dev 156's refined pin exists for | `exactly_one_capability_file_exists_and_nothing_is_declared_inline` (the refined bundle-only walk) AND `the_platform_conf_files_carry_exactly_the_recorded_keys` — two independent kills on the default flavor |
| B23-11 | `size-budget.json` → dmg row path `0.1.1`→`0.9.9` (the version-bump orphan; parent dir present) | `the_recorded_actuals_match_a_re_stat_of_what_exists_here` — "row is STALE" |
| B23-12 | `size-budget.json` → sidecar row path dangling while `binaries/` exists | same test, sidecar stale arm |
| B23-13 | `size-budget.json` → dmg `measuredBytes` INFLATED to 40,000,000 (the baseline-moving direction B23-8 cannot see) | same test, symmetric `assert_close` upper arm |
| B23-14 | `size-budget.json` → sidecar `measuredBytes` inflated to 200,000,000 | same test, same arm |
| B23-15 | `tests/common/mod.rs` → sibling-walk suffix predicate neutered (`.conf.json`→`.conf.jsonx`) plus a hostile `tauri.ios.conf.json` carrying the B23-10 payload | set-equality asserts in BOTH `capability.rs` (pre-walk) and `packaging.rs` (targets authority) — `left: []` |
| B23-16 | a fourth sibling `tauri.ios.conf.json`, bundle-only, `targets` `["app","dmg","deb","appimage","nsis"]` | both set-equality asserts |
| B23-17 | `entitlements.plist` → gains `<!-- codesign --options runtime -->` (the AMFI `--`-in-comment trap plutil passes) | `the_entitlements_are_not_sandboxed_and_carry_no_exceptions` — comment-stripped `--` refusal |
| B23-18 | `tauri.windows.conf.json` → `webviewInstallMode.silent` key misspelled `sillent` | `the_windows_webview_install_mode_is_the_recorded_one` — exact key-set pin |
| B23-19 | `size-budget.json` → sidecar block gains `ignoreRegression`; a None-budget row's `budgetBytes` null→`-1` | sidecar key-set pin; `is_null()` pin |
| B23-20 | probe scope: an extra Mach-O at `Contents/MacOS/helper-tool`; a `Contents/Plugins` dir; a non-empty merged `bundle.macOS.files` | `nesting-probe.sh` bails rc=2 on each (functional checks, not suite kills) |

## 16. Coexistence, uninstall, and who writes what (T25, B25)

### 16a. The contract, the matrix, and the suite

**Who writes the once-per-day marker: the ENGINE, inside `stampToday`
(`src/marker.ts` — one `Bun.write(markerPath(), …)`), on success only, at the end of a
run (`src/main.ts` — `try { await stampToday(r.runDate); }`, the line its own comment labels
*"fail-closed: only on a successful delivery"*; the catch refuses to mark the day). Never the
app, never the installer, never the tray.** The app has no path to it: the webview has no
filesystem surface at all (`tests-web/static.check.ts`), and the Rust shell's engine seam refuses
`--json-out` names the engine owns — `last-run` among them (§1). Both halves are pinned by
`tests-web/coexistence.check.ts` §6: a source parse of the two cited SITES — by symbol, which is
what the parse actually matches (`stampToday`'s export, its one `await` call site, the fail-closed
comment), so the cites above are spelled the way the pin enforces them (round-1 fix F9: line
numbers here could rot with the suite green) — plus behaviour: a delivering sandbox run stamps
today, a refused one stamps nothing.

**The four user-facing facts, stated for the README and asserted here:** the app is OPTIONAL; the
CLI is the engine (the app spawns the same binary and speaks argv + stdout — §1); both read the
SAME config at the same path and write the SAME state dir (the app resolves both from
`status --json`, never from Tauri's own dirs — §10a); and nothing the app does changes briefing
content. That last one is the eval-adjacent invariant (appendix EVAL_BOUNDARIES: a GUI that
starved `briefing.log` would break the eval by starving it, not by editing it), so it is a
byte-level TEST, not intent.

**The suite** (`gui/tests-web/coexistence.check.ts` — engine-invoking, so it lives with B3's
parse-comparison class in `tests-web/`, running the REAL engine from source in fully sandboxed
tempdirs: HOME + XDG_CONFIG_HOME + DAILY_BRIEFING_STATE_DIR + DBA_TEST_UNIT_DIR,
`networkProbeHosts: []`, fake provider shell script citing a real fixture SHA):

1. **Byte-identical**: `run --force` in a pre-GUI baseline sandbox vs two GUI-present sandboxes
   (app-owned record; CLI-owned record + full app-data presence). Stdout, stderr and
   `briefing-latest.md` compared as BYTES under a minute guard for the one real-clock
   `state as of HH:MM` stamp (`src/core.ts:538`); one measured stderr timing line normalised
   (dev 160). The planted presence follows the SOURCES, not the appendix (dev 158).
2. **Corpus**: two launchd-shaped appends (stdout+stderr → one `briefing.log`), then the
   engine's OWN `audit.lastBriefing` (`src/audit.ts:218`, imported read-only — never
   re-implemented) returns exactly the last block, byte-equal to `briefing-latest.md`.
3. **Audit**: `bun run audit --no-judge`, offline, in both sandboxes — finds
   `briefing-latest.md (today's)`, grades clean (the fixture cites a real SHA), writes
   `audit-<date>.md`, and the whole report is byte-identical across the two.
4. **Config**: a pretty-printed CLI-written config is byte-stable through `status --json`,
   `doctor --json` and `config validate --json --file` in a FRESH sandbox (dev 163 for why
   fresh).
5. **Ownership facts**: `recordPresent`/`unitPresent`/`owner` per leg — never `registered`
   (dev 162).

**The matrix**, leg by leg:

| Leg | Asserted locally (this suite unless noted) | VM-gated remainder (§16c) |
| --- | --- | --- |
| CLI-only (install.sh/launchd, unchanged) | sandboxed `run --force` + audit on the TRUE pre-GUI baseline; log corpus + config stability + the owner-`"cli"` fact asserted in GUI-PRESENT sandboxes, where the stronger case covers this row's weaker one (round-1 F12: no suite sandbox is cli-owned without GUI files) | real install.sh + a real launchd tick |
| GUI-only (app-owned) | on-disk presence planted; owner `"app"` record facts; CLI byte-identical through it | real `schedule install --invoker app` + autostart |
| Both installed, GUI delegating | owner `"cli"` record + FULL app presence: byte-identical, corpus, audit all hold | the delegated watcher against a real tick |
| Transition CLI→app (take-over) | engine's foreign-owner exit-2 + `--take-over` argv covered by the engine's own tests and `tests/capability.rs`'s IPC legs (§1b) | the real `launchctl` swap (plan line 70's live-domain register) |
| Transition app→CLI (handback) | same coverage class (§1b) | same |
| Uninstall | `tests/uninstall.rs`: script parity, consent gate, never-recursive, survivors, T19-disable reuse — real `SystemFs` on scratch | the real removal legs + login item (§16c) |

### 16b. Deviations recorded by T25 (B25)

Numbered from 157, continuing §15b. §9's retire-in-place convention applies.

157. **The byte-identical baseline is GENERATED INSIDE THE SUITE, not a committed Phase-0
     fixture.** Plan line 74 lists a Phase-0 "coexistence fixture baseline"; searched before
     building — none exists in the repo, and plan R8 itself still lists it as "remaining". A
     committed baseline blob rots with every legitimate render change and rots SILENTLY with
     every illegitimate one; the suite instead builds the pre-GUI sandbox and the GUI-present
     sandboxes from the same fixture in the same run, so the assert compares live bytes to live
     bytes and can only fail loudly.
158. **The simulated GUI presence follows the SOURCES, not the appendix's file list — and the
     app-data removal list with it.** The appendix names "runs.jsonl, window state"; there is no
     `runs.jsonl` (R1 deleted that arm — §1c dev 1, nothing writes it). What a GUI install
     actually leaves, each name read from its owning module: `autostart-state.json`
     (`autostart.rs`), `notify-state.json` (`notifications.rs`), `access-state.json`
     (`access.rs`), `config-candidates/` (`config_save.rs`), and `.window-state.json` — whose
     directory is `app_config_dir()`, NOT `app_data_dir()` (`tauri-plugin-window-state` 2.4.1
     `src/lib.rs:122-124`, measured): the two coincide on macOS and DIVERGE on Linux
     (`~/.config/<id>` vs `~/.local/share/<id>`), so `uninstall.rs` carries TWO directories and
     the single-dir shape the appendix implies would strand the window-state file on exactly the
     platform where nobody would look.
159. **The app's uninstall never touches the launchd domain, and the consented engine list DOES
     include the managed binary.** `scripts/uninstall.sh`'s `$PLIST` lines (unload + rm) are
     `schedule uninstall`'s territory — the Schedule panel's existing flow — so the parity set is
     the `$SUPPORT`-rooted subset (`uninstall.sh:11-24`'s class), and the Settings copy points at
     the Schedule screen rather than implying a total uninstall. Within that subset,
     `daily-briefing` (the managed engine copy) IS removed on consent because the script removes
     it: consent means what `bash scripts/uninstall.sh` means. The bounded list is pinned by
     SET-EQUALITY against a test-time PARSE of the script (`tests/uninstall.rs`, the T9 pathEnv
     pattern), so either side editing alone goes red — and the consented leg is the ONE surface
     in the app that can remove the briefing archive, which the consent label must NAME
     (`coexistence.check.ts` pins the wording; `tests-web/history.check.ts` carries
     `uninstall_execute` as an enumerated, argued exception to its no-deletion-surface claim).
     T13's retention-stays-unbounded rule is unchanged: an uninstall with named consent is not a
     pruning offer.
160. **The stderr comparison normalises exactly ONE measured timing line; stdout is compared
     raw.** With `networkProbeHosts: []` the probe answers instantly, but `waitedMs` is a
     `Date.now()` difference (`src/net.ts::waitForNetwork`) that jitters between 0 and 1 ms, and
     `src/main.ts:95` prints `waited ~0s for the network to come up` only when it lands ≥ 1 —
     measured at roughly one run in ten (a 40-iteration paired probe; stdout never diverged).
     The line is pre-header, so the audit's `lastBriefing` slice never contains it. Every other
     stderr byte is compared exactly.
161. **The capability grows by an EIGHTH module, `uninstall::`, 32 → 34** — the
     one-module-per-slice growth path `tests/capability.rs`'s enumerated allowlist prescribes.
     Two commands (`uninstall_preview` / `uninstall_execute`), one boolean operand between them
     (the consent flag), no path anywhere: app-file names are module constants, engine names are
     the parity list, the state dir is re-read from `status --json`. All seven external
     spellings updated together (capability file, build.rs, generate_handler!, autogenerated
     permissions, TS invoke scan, README, this register). ⚠ What the Rust side GUARANTEES is
     BOUNDS, not consent (round-1 F6, measured at the IPC seam): the enumerated lists and the
     no-path operand hold whatever the webview does, but `uninstall_execute({removeEngineState:
     true})` is admissible with no preview ever called — preview→execute is a webview-side
     ceremony, exactly as B6's `ScheduleUninstall` confirm is (`engine_schedule_uninstall
     (take_over)`, the same shape). Degraded-path bound, also measured: `absolute()` refuses a
     relative, `~`-prefixed or empty `paths.stateDir` and accepts ANY absolute path without
     canonicalisation — and wherever the engine points, the blast radius stays the 8 enumerated
     separator-free names, joined statically (a hostile engine is no escalation; it already runs
     as the user).
162. **`registered` is never asserted by the coexistence suite.** `schedule status` probes the
     LIVE launchctl domain (read-only, the one leg no environment variable redirects — §1b), and
     on the author's machine the real `local.daily-briefing` agent answers: measured, a sandbox
     with a fixture record reported `registered: true` because the PROBE found the live agent
     under the same label. Ownership facts come from the sandbox-rooted fields only.
163. **The config-stability leg runs in a FRESH sandbox because the shared one hid a real
     mutation.** Round 1 ran it against the already-delivered sandbox; a planted
     config-normalising rewrite in `loadConfig` SURVIVED (mutation B25-10, first round) — test
     1's runs had already normalised the file before the before-hash was taken, so
     rewrite-on-load reproduced identical bytes. The leg now hashes a pretty-printed file no run
     has ever loaded, and the same mutation dies at exactly this test (§16d).
164. **`transcript-health.json` is refused as a `--json-out` name GUI-SIDE; the engine-side
     refusal is a REGISTERED FOLLOW-UP, not done here.** Measured (B25 round-1 review): the
     engine's own `--json-out` guard (`src/json.ts`, `engineOwns`) derives its refusal list from
     `statePaths()`, and `transcript-health.json` — read and merged by `src/core.ts` on every run
     (the §3.8 health-warning triggers) — has NO `statePaths()` entry, so the engine accepts the
     name and overwrites the whole health history with a run envelope (seeded 14 days → 0). Every
     OTHER engine-read state-dir `.json` is refused engine-side, which makes this an omission,
     not a design choice — and the coexistence suite structurally cannot catch the class, because
     its planted presence uses the benign envelope name (correctly: that is what the app writes
     today). The engine tree is read-only in B25, so the fix ships in two halves: (a) DONE — the
     GUI's `json_out_name` validator (`engine.rs`, `InputRefusal::EngineReadName`) refuses the
     exact name, closing the only app-reachable path (`engine_run_to_file`; no webview code calls
     it today, which is why this was latent); (b) PHASE C FOLLOW-UP — a `transcriptHealthPath`
     entry in `statePaths()` and `engineOwns`'s `owned` list, so the engine refuses it for every
     caller, not just this app. Until (b) lands, the asymmetry is deliberate and this register is
     its record.
165. **The coexistence fixture plants EACH PLATFORM's layout, not macOS's everywhere** (2026-09-24,
     after CI began running this suite on `ubuntu-latest`, #547). Before, `plantGuiPresence`
     wrote the app's files under `~/Library/Application Support/<id>` on every platform, so the
     Linux CI run checked directories the Linux app never writes. It now resolves Tauri's
     `app_data_dir` / `app_config_dir` per platform (`appDirs`: tauri 2.11.5 over dirs 6.0.0, so
     on Linux `$XDG_DATA_HOME/<id>` and `$XDG_CONFIG_HOME/<id>` — dev 158's divergence), plants
     the login item the app enables by default — Linux `~/.config/autostart/Daily Briefing.desktop`
     (auto-launch 0.5.0 ignores XDG_CONFIG_HOME there), macOS `Daily Briefing.plist` beside the
     engine's own `local.daily-briefing.plist` in the (redirected) unit dir — and records the Linux
     `managedBinPath`; #547 had already made the scheduler unit files per-platform. The suite now
     requires EVERY planted file to be intact, byte for byte, in every GUI-present sandbox after
     every engine command it runs there (`run --force`, the two log appends, `bun run audit`,
     `status`/`doctor`/`config validate`, `schedule status`); it used to check that four
     app-data files still EXISTED, in one sandbox, after `run --force` only. Apart from the login
     item, macOS paths are unchanged. Still NOT simulated: the webview's own data. The app sets no
     data directory, and on Linux tauri 2.11.5 then points the webview at `app_local_data_dir`
     (`src/manager/webview.rs:534-545`), which dirs 6.0.0 makes the same directory as
     `app_data_dir` — so it lands beside the planted records; which files WebKitGTK writes there
     is unmeasured. Kills: §16d B25-13 … B25-22.

### 16c. What B25 does NOT execute, and what is therefore UNRUN (VM-gated)

Beyond §1b, §9, §10f, §11f, §12c, §13g, §14c and §15c, all unchanged:

- **The uninstall-consent REAL leg**: no test removes anything from a real `app_data_dir()`,
  `app_config_dir()` or the live engine state dir — `tests/uninstall.rs` drives the real
  `SystemFs` against scratch directories only, and the live state dir
  (`~/Library/Application Support/daily-briefing`) is on the never-touch list. First real
  execution is T26's clean-VM walkthrough.
- **The login-item removal**: `uninstall_execute`'s autostart leg reuses T19's plugin
  `disable()`, whose real effect (removing `~/Library/LaunchAgents/Daily Briefing.plist`) is
  VM-gated with the rest of T19 (§12c); every test drives the recording sink.
- **The real-install matrix legs**: `schedule install`/`uninstall`/take-over/handback against a
  real launchd domain (plan line 70's live-domain register; §1b), a real `install.sh` run, and a
  real delegated tick with the GUI watching. The suite simulates the ON-DISK halves only.
- **`registered` truth**: which agents the live `launchctl` domain actually holds is observed
  (read-only) but never asserted (dev 162); asserting it needs a VM whose domain the test owns.
- **The uninstall through a packaged webview**: button → consent dialog → report in a real .app
  is T26's dry-run; here the command bodies run over `MockRuntime` IPC
  (`tests/capability.rs::the_b25_uninstall_commands_are_admitted_and_run_their_own_code`) and
  the wording over `tests-web`.
- **The compiled-binary run leg**: the suite runs the engine from SOURCE (`bun src/main.ts` —
  the same modules `build-sidecar.sh` compiles); the sandboxed compiled-sidecar legs are
  `tests/engine_client.rs`'s, and the full compiled-CLI walkthrough is T26's.

### 16d. The B25 mutation ledger, enumerated for replay

Per §15d's convention — fresh disposable copy (`cp -Rc` APFS clone of the whole worktree at a
constant scratch path, delete-first; shared out-of-tree `CARGO_TARGET_DIR` keeps the clone
compile-warm), applied-check via `cmp` against the original, restore byte-identical `cmp` +
`touch`. Engine-source mutations exist ONLY on the disposable clone (engine files in the
worktree are read-only to this task). Every row RED; B25-10's first round SURVIVED and is
recorded as the check fix it forced (dev 163):

| # | target (file → mutation) | killed by |
| --- | --- | --- |
| B25-1 | suite clone: `plantGuiPresence` gains a GUI config write (`morningTime: "07:21"` — a GUI file the engine READS) | byte-identical: `run --force: baseline, app-owned and delegating sandboxes emit the same bytes` (re-verified after the dev-160 stderr change) |
| B25-2 | `uninstall.rs` → `ENGINE_STATE_REMOVALS` gains `File("last-run")` (outside the script's set) | `the_engine_list_is_the_scripts_support_rooted_list` |
| B25-3 | `uninstall.rs` → consent gate dropped (`remove_engine_state` forced true) | `the_consent_flag_gates_the_engine_leg` |
| B25-4 | script clone: `uninstall.sh` gains `rm -f "$SUPPORT"/extra-file` | same parity test, other direction — "have diverged" naming the missing token |
| B25-5 | engine clone: `src/main.ts` → the `await stampToday(r.runDate)` call removed | BOTH §6 pins: the source parse (zero call sites) and the behaviour pin (no marker after a delivering run) |
| B25-6 | `uninstall.rs` → `remove_engine_state` gains the forbidden `fs.remove_dir_all(state_dir)` | `a_consented_removal_touches_exactly_the_bounded_list` — survivors gone |
| B25-7 | engine clone: `src/main.ts` → `console.log("notified")` after the notify call (post-render stdout) | corpus: `lastBriefing()` last block ≠ `briefing-latest.md` |
| B25-8 | engine clone: `src/main.ts` → the `briefing-latest.md` write removed | byte-identical's latest-file comparison + the audit leg's `source: briefing-latest.md (today's)` |
| B25-9 | `app-uninstall.ts` → consent label loses "briefing archive" / "cannot be recovered" (syntactically valid rewrite; a first attempt that broke the module was discarded as an invalid kill) | wording pin: `the consent label names the archive, the irrecoverability, the engine copy and the bound` |
| B25-10 | engine clone: `src/config.ts` → `loadConfig` re-serialises the file it read | **round 1: SURVIVED** (the shared sandbox was pre-normalised — dev 163); after the fix: `status/doctor/config-validate leave the file untouched` |
| B25-11 | engine clone: `src/schedule/status.ts` → `owner` hardcoded `"app"` when a record exists | ownership facts: the CLI-only/delegating leg expects `"cli"` |
| B25-12 | `capabilities/default.json` → `allow-uninstall-execute` dropped | `the_capability_grants_exactly_the_app_commands` |

Dev 165's rows run on LINUX unless marked: a copy of the tree inside an `oven/bun:1.3.14`
container, each mutation inserted into the copy's `run()` right after `rotateLogIfLarge()` in
`src/main.ts` (B25-19: into `scripts/audit.ts`'s retention step instead), applied-check by
counting the marker line, clean baseline `coexistence.check.ts` 11 pass / 0 fail. Rows B25-13 …
B25-22 are 6 pass / 5 fail — the root failure below, then the four legs that reuse its sandbox —
except B25-19, which fails in the audit leg itself (9 / 2). Against the macOS-only fixture every
row B25-13 … B25-18 SURVIVED (11 / 0): trivially for 13, 14, 15 and 17, whose Linux targets it
never planted, and for 16 and 18 because it never checked those files. B25-15 … B25-18 also
survived the first per-platform version, which checked only that four app-data files existed
after `run --force` (17 trivially: it did not plant the autostart entry). B25-22 is the exception
to the preamble's disposable-clone rule: it ran on darwin in this task's own worktree, which was
restored by `git checkout` and re-run clean (11 / 0).

| # | target (engine clone → mutation; Linux unless marked) | killed by |
| --- | --- | --- |
| B25-13 | `run()` prints every non-`daily-briefing` entry of `$XDG_CONFIG_HOME` to stderr | byte-identical: the stderr comparison (`stray com.themarigold.daily-briefing`) |
| B25-14 | `run()` deletes `$XDG_CONFIG_HOME/<id>/.window-state.json` | byte-identical: `…/.window-state.json vanished` |
| B25-15 | `run()` deletes `~/.local/share/<id>/config-candidates/` | byte-identical: `…/config-candidates/candidate-9-9.json vanished` |
| B25-16 | `run()` deletes `$XDG_CONFIG_HOME/daily-briefing/config.json.bak` | byte-identical: `…/config.json.bak vanished` |
| B25-17 | `run()` deletes `~/.config/autostart/Daily Briefing.desktop` | byte-identical: `…/Daily Briefing.desktop vanished` |
| B25-18 | `run()` deletes `<state>/run-envelope.json` | byte-identical: `…/run-envelope.json vanished` |
| B25-19 | `scripts/audit.ts` retention step also unlinks `<state>/run-envelope.json` | the audit leg: `…/run-envelope.json vanished after bun run audit` |
| B25-20 | `run()` truncates `$XDG_CONFIG_HOME/<id>/.window-state.json` to 0 bytes | byte-identical: `…/.window-state.json changed after run --force` |
| B25-21 | `run()` deletes the window-state file only when `schedule.json` says owner `"cli"` (the delegating sandbox) | byte-identical: `byte-cli-0/…/.window-state.json vanished after run --force` |
| B25-22 | darwin: `run()` deletes `<unit dir>/Daily Briefing.plist` | byte-identical: `…/units/Daily Briefing.plist vanished after run --force` |
