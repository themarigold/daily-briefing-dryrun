//! The engine client — the ONLY code in this app that spawns the sidecar (T8), and the only place
//! the launchd environment is reproduced (T9).
//!
//! ## What changed, and why this module exists at all
//!
//! B1 shipped the seam as a `shell:allow-execute` capability: the webview called
//! `Command.sidecar(...)` and Tauri's shell scope decided which argv was allowed. That design was
//! MEASURED to have a ceiling — `tauri-plugin-shell` looks a sidecar's scope entry up with
//! `iter().find(|s| s.name == command_name)` and every sidecar entry necessarily shares one name,
//! so only the FIRST entry was ever consulted and the app could reach exactly one subcommand
//! (`status --json`). `capabilities/README.md` keeps the history note; the measurement itself is in
//! git history, in B1's `capabilities/default.json` and its `tests/capability_allowlist.rs` (which
//! this change renames to `tests/capability.rs` and rewrites).
//!
//! This module lifts that ceiling by moving the decision one layer in:
//!
//!   * **The webview has no shell access at all.** `tauri-plugin-shell` is not a dependency of this
//!     crate any more and is not registered on the builder; the capability grants no `shell:*`
//!     permission. The plugin also forwarded frontend-supplied `cwd` and `env` straight past the
//!     scope (`commands.rs:149-155`) — `DAILY_BRIEFING_STATE_DIR` and `XDG_CONFIG_HOME` are a second
//!     control channel into the engine — and that gap closes with it, because nothing the webview
//!     sends reaches the child's environment now.
//!   * **Argv is constructed here, in Rust, from [`Operation`]** — an enum that is exhaustive over
//!     the operations the app may perform: the engine surface minus `init` and `help`. A caller
//!     picks an operation; it never spells an argv.
//!   * **Each operation is one `#[tauri::command]`**, so `capabilities/default.json` names the
//!     operations the webview may invoke *individually*. One enum-taking command would have made
//!     "may read status" and "may generate a briefing" the same grant.
//!
//! ## The caller-supplied operands, and where they are refused
//!
//! Every operand that is not a fixed literal is a newtype that cannot be constructed without
//! passing its validator, so an [`Operation`] carrying an unvalidated value is unrepresentable
//! rather than merely unlikely. FOUR reach argv — `run --json-out <name>` ([`JsonOutName`]),
//! `config validate --file <path>` ([`ConfigFilePath`]), a provider `--index` ([`ProviderIndex`])
//! and a key `--id` ([`KeyId`]) — and TWO are written to the engine's STDIN, never to argv: a reset
//! label ([`Label`], as `{"label": …}`) and the key `key set` reads ([`KeySecret`], which is not an
//! [`Operation`] operand at all). The first two are the originals, described here; the PR 3 ones
//! follow below. (Since PR 3 final r1 the webview supplies only the first of the originals: the
//! `--file` path is always one Rust staged or owns — `config_save.rs` — because the
//! `engine_config_validate` command is gone; see [`COMMANDS`].)
//! `--json-out` is a port of the capability regex B1 measured, character class for character
//! class. `--file` is deliberately WIDER than B1's regex: that regex refused every directory the
//! engine and the app naturally use (`~/.config/…` for a dot-leading segment, `~/Library/Application
//! Support/…` for a space), and neither refusal had a threat model on this path — the argv is
//! handed to `execve` as a vector with no shell in between, and the engine reads the operand whole.
//! See [`json_out_name`] and [`config_file_path`], and `capabilities/README.md`.
//!
//! **Provider fallback PR 3 (P3-M1-T1) adds four, under the same rule:** a provider `--index`
//! ([`ProviderIndex`]), a key `--id` ([`KeyId`]), a reset LABEL ([`Label`]) and the key itself
//! ([`KeySecret`]). The first three are each a port of the ENGINE's own rule (`docs/gui-seam.md`
//! §1d); the key is NOT: [`KeySecret`] checks only the engine's stdin bound (non-empty, at most
//! [`KEY_STDIN_MAX_BYTES`]) and leaves the key rule itself (trimmed, 8–512 characters of the key
//! charset) to the engine, which answers for it. The label never reaches argv: it is written to
//! the engine's stdin as `{"label": …}`, as `key set`'s key is — and the key is not an operand of
//! [`Operation`] at all, but a separate [`KeySecret`] ([`EngineClient::invoke_with_key`]).
//!
//! The invoker on `schedule install`/`uninstall` is NOT caller-supplied either: the commands pass
//! [`Invoker::App`] unconditionally. The engine's foreign-owner refusal keys on the record's
//! `invoker`, and a webview that could spell `--invoker cli` could forge that record. The Rust side
//! knows it is the app.
//!
//! ## What is deliberately NOT here (plan R1 deviations from gui-tauri T8)
//!
//!   * **No `runs.jsonl` journal.** R1 deleted that arm ("runs.jsonl arm deleted"). The appendix's
//!     T8 specifies an app-owned journal under `<appDataDir>`; there is none.
//!   * **No `run_scheduled()` / tick.** R1 defers the app-owned tick out of 0.2.0 — the OS
//!     scheduler is the only trigger. The appendix's launchd-equivalence contract (append the
//!     sidecar's stdout+stderr to `briefing.log` in launchd's order) belongs to that deferred arm
//!     and is not built, so this module never writes to `briefing.log`.
//!   * **No `init()`.** Settings (T15, B5) edits an EXISTING config through `config_save`, which
//!     validates with `config validate`; creating the first config is the wizard's (T16, B8) and
//!     its shape is not designed yet — an operation the UI cannot drive is a surface nobody
//!     reviewed (`docs/gui-seam.md` §10e).
//!   * ~~**No `calendar`.**~~ **AMENDED IN v0.3.0 (calendar connection, plan M8):** this bullet said
//!     the ENGINE had no `calendar` subcommand, so the enum had no variant for it. The calendar
//!     build gives the engine `calendar status|list|test|connect mac --json` (W1's M5) and this
//!     enum the four typed operations below (W2's M8) in the SAME release, PR 1 — the two land
//!     together, so the rule this bullet stated (a typed operation that cannot run reports failure
//!     for a reason the user cannot act on) still holds for every shipped build. The enum is still
//!     exhaustive over the operations the app may perform — the engine surface minus `init` and
//!     `help`, and minus `calendar add-link` / `remove-link`, whose URL travels on STDIN, which the
//!     app's spawns never give the engine (`stdin(null())` below): the app writes the managed link
//!     file itself (`crate::calendar`). (`update --check` was in this bullet until Phase E's E11
//!     gave the engine the subcommand; it is [`Operation::UpdateCheck`] now — see the section
//!     below.)
//!
//! ## What B6 ADDED here, and the one thing that did not change
//!
//! `schedule verify` was in the list above until B6 (T20). The kickstart is still engine-side —
//! `schedule install` performs it as its last step (plan R1) — and that is exactly why a re-run
//! needs a surface: the Schedule & Access panel's post-install loop re-issues the SAME engine-side
//! kick rather than reaching for `launchctl`, so the app's exec surface stays engine-only.
//! [`Operation::ScheduleVerify`] is therefore `schedule verify --json`, and it is **mutating**: the
//! kick starts the live launchd/systemd job, which generates a briefing and stamps the day.
//!
//! Nothing else in this module moved. The spawn path, the environment plan
//! ([`EngineClient::env_plan`], [`FORWARDED_ENV`], [`launchd_path`]), the process-group kill and
//! both operand validators are untouched by B6.
//!
//! ## What Phase E (E12) ADDED: `update --check --json`
//!
//! [`Operation::UpdateCheck`] is the Settings screen's "Check now": the engine's MANUAL update
//! check, which always fetches (the config's `intervalHours` gates only the engine's own automatic
//! path) and prints its result object. It is **not mutating** — it touches no schedule and no
//! briefing state, and its one write is the engine's own atomic `<state>/update-check.json` — so it
//! takes no in-flight guard and "Check now" works while a run is in flight. Like every other
//! operation it takes no operand: the argv is three fixed literals, and the request it makes is the
//! engine's (`src/updateCheck.ts`), never the webview's — the webview's CSP permits no remote
//! connection at all.
//!
//! ## What v0.3.0 (plan M8) ADDED: the four calendar operations, and a per-operation timeout
//!
//! [`Operation::CalendarStatus`] / [`Operation::CalendarList`] (reads),
//! [`Operation::CalendarTest`] (a read of every configured source NOW — network fetches and the Mac
//! helper — that touches no schedule and no briefing state) and [`Operation::CalendarConnectMac`]
//! (MUTATING: it installs and re-signs the helper copy and raises the Calendar permission dialog).
//! Each takes no operand. All four exist on every platform, so `COMMANDS`, `build.rs` and the
//! capability stay in parity on the Linux CI job; off macOS the connect command refuses with
//! [`EngineError::Unsupported`] before any spawn ([`mac_only`]), the `access.rs` precedent.
//!
//! ⚠ **THE FIRST OPERATIONS WITH THEIR OWN WALL-CLOCK BOUND** ([`Operation::timeout`]). Until M8 the
//! only bound anywhere was the 30 s `shell::ENGINE_READ_TIMEOUT` that four READ paths wrap around
//! `invoke` themselves; every other operation was unbounded at this layer. The four calendar
//! operations carry theirs on the operation, and [`EngineClient::invoke`] applies it — so no caller
//! can forget it — answering [`EngineError::Timeout`] when it fires. Every pre-existing operation
//! answers `None` there and behaves exactly as before.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

/* ── the operation surface ────────────────────────────────────────────────────────────────────── */

/// Who owns the OS schedule record — `schedule.json`'s `invoker` (`docs/gui-seam.md` §3).
///
/// Deliberately NOT `Deserialize`: no `#[tauri::command]` takes one, and without the derive none
/// can. The app always installs as [`Invoker::App`]; `Cli` exists so the enum is the engine's whole
/// vocabulary and the argv tests can spell both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invoker {
    App,
    Cli,
}

impl Invoker {
    fn as_str(self) -> &'static str {
        match self {
            Invoker::App => "app",
            Invoker::Cli => "cli",
        }
    }
}

/// Every engine invocation this app can make. Exhaustive over the operations the app may perform —
/// the engine surface minus `init` and `help` — as `src/main.ts` dispatches it today; see the
/// module header for what is deliberately absent and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operation {
    /// `run --json [--force] [--now] [--json-out <name>]`.
    ///
    /// `--json` is unconditional: the app always wants the envelope on stdout. `--json-out` is
    /// additive (the engine writes the same envelope to a file and leaves stdout alone about it),
    /// not an alternative. `--now` is the app's Run now: the engine lifts its morning-time floor for
    /// it and keeps the once-a-day guard (`--force` lifts both).
    Run {
        force: bool,
        now: bool,
        json_out: Option<JsonOutName>,
    },
    /// `status --json` — a pure state-dir read. `--json` is REQUIRED; there is no human form.
    Status,
    /// `doctor --json` — preflight + capability probe. Exits 0 even when the verdict is `blocked`.
    Doctor,
    /// `config validate --json --file <path>` — validates a CANDIDATE config. Exits 0 whether or
    /// not the candidate is valid; validity is the payload.
    ConfigValidate { file: ConfigFilePath },
    /// `schedule install --invoker <who> [--take-over]`.
    ScheduleInstall { invoker: Invoker, take_over: bool },
    /// `schedule uninstall --invoker <who> [--take-over]`.
    ScheduleUninstall { invoker: Invoker, take_over: bool },
    /// `schedule status --json`.
    ScheduleStatus,
    /// `schedule verify --json` (T20) — re-issue the verification KICKSTART `schedule install`
    /// already performs as its last step, and report what evidence appeared.
    ///
    /// ⚠ MUTATING, AND THAT IS NOT A JUDGEMENT CALL. `verifySchedule` (`src/schedule/install.ts`)
    /// kicks the REGISTERED trigger — `launchctl kickstart` on macOS — so the live launchd job
    /// runs the engine, which may generate a briefing, write the archive and stamp the day. It
    /// looks like a read (it "checks" something) and is the most expensive write the app can
    /// issue; [`Operation::is_mutating`] says so and the in-flight guard holds it.
    ///
    /// ⚠ EXIT CODES ARE NOT THE USUAL ONES (`src/main.ts`, `verifyExitCode`): `0` evidence
    /// appeared that the kick reached the engine · `1` the kick was accepted and produced NO NEW
    /// evidence (inconclusive — including `already-delivered-before-kick`, which proves nothing) ·
    /// `3` the scheduler refused the kick. `2` is never used here, so [`Outcome::ConfigError`]
    /// cannot arise from it.
    ScheduleVerify,
    /// `update --check --json` (Phase E, E12) — the engine's MANUAL, notify-only update check: one
    /// anonymous request for the project's latest GitHub release, compared with the running
    /// version, the answer printed as JSON and written to `<state>/update-check.json`.
    ///
    /// ⚠ NOT MUTATING (plan §5 decision 16). It changes no schedule and no briefing state — its one
    /// write is the engine's own atomic state file — so it takes no in-flight guard, and "Check
    /// now" works while a run is in flight. Exit 0 whatever the answer; `unknown` in the payload is
    /// the engine reporting that the check could not complete, not a failure of this invocation.
    UpdateCheck,
    /// `calendar status --json` (v0.3.0, plan M8) — the `calendar` configuration as resolved plus
    /// each source's LAST SCHEDULED read from `<state>/calendar/health.json` (the engine's
    /// `CalendarStatusJson`, `src/calendar/types.ts`). Makes no network call and never prompts.
    /// A read: no in-flight guard; bounded by `shell::ENGINE_READ_TIMEOUT` ([`Operation::timeout`]).
    CalendarStatus,
    /// `calendar list --json` (plan M8) — the Mac calendars (for Settings' checklist; `null` off
    /// macOS) and the configured links, NEVER a link's URL (`CalendarListJson`). On macOS it runs
    /// the helper's `list` mode, which exits before creating an event store unless access is
    /// already granted — so it cannot raise a prompt. A read, bounded like `CalendarStatus`.
    CalendarList,
    /// `calendar test --json` (plan M8) — read every configured source NOW and report per-source
    /// counts, never titles (`CalendarTestJson`). It makes the link fetches and launches the Mac
    /// helper's `read` mode.
    ///
    /// ⚠ NOT MUTATING, by the same rule as [`Operation::UpdateCheck`]: it changes no schedule and no
    /// briefing state (the health file records SCHEDULED reads; the spec's "Test" shows the answer
    /// directly), so a Test refused with `Busy` because a briefing is generating would guard
    /// nothing. Bounded by [`CALENDAR_TEST_TIMEOUT`].
    CalendarTest,
    /// `calendar connect mac --json` (plan M8; the engine side is W1's M5 stub, then W3's M10b) —
    /// install or update the helper copy under `<state>/calendar/reader/`, re-sign it with the
    /// stable local identity, and run its `request` mode while the user is present.
    ///
    /// ⚠ MUTATING: it writes the helper copy and touches the KEYCHAIN (the managed-copy signing
    /// `schedule install` also uses), so it must never run beside a schedule install or a second
    /// connect — the in-flight guard holds it. Bounded by [`CALENDAR_CONNECT_MAC_TIMEOUT`], the
    /// first MUTATING operation with a Rust-side bound — see that constant for what a timeout does.
    /// Off macOS the command refuses before any spawn ([`mac_only`]); the variant exists on every
    /// platform so the grant lists stay in parity.
    CalendarConnectMac,
    /// `provider key set --json` (provider fallback PR 3, P3-M1-T1; `docs/gui-seam.md` §1d) — store
    /// a pasted key in the app's key store and answer the reference to save.
    ///
    /// ⚠ THE KEY IS NOT IN THIS VARIANT, AND THAT IS THE DESIGN. It travels as a [`KeySecret`] —
    /// no `Debug`, no `Clone`, no `Serialize` — through [`EngineClient::invoke_with_key`], and
    /// reaches the engine on STDIN only, never argv. So `format!("{op:?}")`, [`Operation::argv`] and
    /// every log line built from an `Operation` cannot hold it. [`Operation::takes_key`] is true for
    /// this variant alone, and `invoke` refuses it without a key (and refuses a key for any other).
    KeySet,
    /// `provider key migrate --index <n> --json` — move entry n's legacy literal `apiKey` from the
    /// SAVED config into the key store. The key is the engine's to read; nothing secret is here.
    KeyMigrate { index: ProviderIndex },
    /// `provider key delete --id <keyId> --json` — remove one app-owned key.
    KeyDelete { id: KeyId },
    /// `provider key delete-all --json` — remove every app-owned key (the uninstall leg).
    KeyDeleteAll,
    /// `provider key scrub-backup --json` — remove from `<config>.bak` every literal key the saved
    /// config no longer holds. ⚠ Its COMMAND holds `ConfigSaver`'s save lock across the call
    /// ([`engine_provider_key_scrub_backup`]), so no settings save rewrites `.bak` meanwhile.
    KeyScrubBackup,
    /// `provider reset (--index <n> | --label-stdin) --json` — clear that entry's marks.
    ///
    /// ⚠ A LABEL NEVER REACHES ARGV (hub Q20; spec §4): [`ResetTarget::Label`] is written to the
    /// engine's STDIN as `{"label": "…"}` ([`Operation::stdin_payload`]), and argv carries only
    /// `--label-stdin`. A label is user text — `-h`, `--help` or `--old` are all legal labels, and
    /// the engine's dispatch reads `-h`/`--help`/`-v`/`--version` ANYWHERE in argv as help/version.
    ProviderReset { target: ResetTarget },
    /// `provider test --file <candidate.json> --index <n> --json` — probe entry n of a CANDIDATE
    /// file the app staged, and record the outcome.
    ///
    /// ⚠ NO WEBVIEW COMMAND CONSTRUCTS THIS: it takes a file path, and the only route to it is the
    /// staging command (P3-M1-T2), which writes the candidate itself. `COMMANDS` and the capability
    /// carry nothing for it (`tests/capability.rs` pins that no command body in `src/` names it, and
    /// that nothing in `src/` outside its allowlist constructs one).
    ///
    /// `test_timeout_ms` is ALWAYS the `testTimeoutMs` the engine reports for that entry in
    /// `config validate --json`'s `providers` rows (`docs/gui-seam.md` §1d), FOR EVERY ENTRY KIND:
    /// a remote or CLI row is 80 000 ([`PROVIDER_TEST_REMOTE_TIMEOUT`]), a loopback row the effective
    /// `timeoutMs` + 17 s — already summed, so nothing here adds to it, and the app never decides
    /// "loopback" itself (P3-M1-T1 checkpoint: it was `loopback_timeout_ms: Option<u64>`, whose
    /// `None` asked the caller to make exactly that decision). It is clamped to between
    /// [`PROVIDER_TEST_LOOPBACK_EXTRA`] and [`PROVIDER_TEST_LOOPBACK_CAP`] (plan Q12: a hand-edited
    /// `timeoutMs` cannot hold the in-flight guard for hours) — see [`Operation::timeout`]. The floor
    /// stays 17 s, NOT 80 s: a loopback row is below 80 000 whenever its effective `timeoutMs` is
    /// under 63 s (`appTestTimeoutMs`, `src/attemptBounds.ts`: `timeoutMs` + 17 000), so a remote
    /// floor would stretch every such Test's bound past what the engine itself allows. A remote row below 80 000 is not something the engine
    /// produces; the contract above, not the clamp, is what keeps a remote Test at 80 s.
    ///
    /// ⚠ AND ITS PROCESS GROUP IS KILLED WHEN IT RETURNS, not only when it is abandoned
    /// ([`Operation::kills_its_group_on_return`]): a CLI Test's backgrounded grandchild can outlive
    /// the engine (measured at the P2-M4 checkpoint).
    ProviderTest {
        file: ConfigFilePath,
        index: ProviderIndex,
        test_timeout_ms: u64,
    },
    /// `repos status --json` (briefing redesign B1, wave-2 plan B1-M4-T11) — the desktop app's live
    /// git check: groups, push state and the "Not committed" counts for today's page.
    ///
    /// ⚠ THE REQUEST RIDES ON STDIN ([`Operation::stdin_payload`]), NEVER ARGV: argv is three fixed
    /// literals. It is the [`ProviderReset`](Operation::ProviderReset) pattern — an operand the
    /// operation carries, validated by [`ReposRequest::new`], not a secret.
    ///
    /// A READ: it changes no repo (the engine's hardening runs no repo-supplied code and writes
    /// nothing) and no briefing state, so it takes no in-flight guard; one check at a time is
    /// `repos::ReposLive`'s own latch. Bounded at `shell::ENGINE_READ_TIMEOUT`; the engine's own
    /// overall budget is 5 s under it (`REPOS_STATUS_BUDGET_MS`, `src/repos/status.ts`).
    ReposStatus { request: ReposRequest },
    /// `calendar details --json [--skip-mac] [--skip-commands]` (briefing redesign wave 2, C-M3-T7)
    /// — today's live calendar details: links, people and notes, read live and never saved.
    ///
    /// ⚠ RUN ONLY THROUGH THE SEALED PATH, [`EngineClient::invoke_sealed`]. Its stdout holds meeting
    /// links, notes, names and the remembered command-link URLs, so it never reaches `classify`
    /// (whose [`EngineOutcome`] keeps stdout and stderr verbatim and derives `Debug` and
    /// `Serialize`); `invoke` and `invoke_with_key` refuse it before any spawn. The remembered URLs
    /// are NOT in this variant: they travel beside it as a [`LinkHandback`], the [`KeySecret`]
    /// pattern, so `format!("{op:?}")` and [`Operation::argv`] hold two booleans and nothing else.
    ///
    /// Both flags are built in Rust (`calendar_details::decide`), never taken from the webview.
    /// NOT mutating (no schedule, no briefing state, no health file); bounded by
    /// [`CALENDAR_DETAILS_TIMEOUT`]. Every match arm on it binds with a trailing `..`, so the
    /// capability scan can tell a pattern from a construction (`tests/capability.rs`).
    CalendarDetails { skip_mac: bool, skip_commands: bool },
}

/// Which entry `provider reset` clears: by position, or by label (the label on STDIN).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResetTarget {
    Index(ProviderIndex),
    Label(Label),
}

/// `key set` and `key migrate`: 1 s pre-store + 10 s store + 3 s cleanup = 14 s of the engine's own
/// worst case, + 5 s (spec §6, amended at the P2-M2 / P2-M3-T1 checkpoints).
pub const KEY_SET_TIMEOUT: Duration = Duration::from_secs(19);

/// `key delete-all`: 1 s sweep + 10 s store = 11 s, + 5 s (spec §6).
pub const KEY_DELETE_ALL_TIMEOUT: Duration = Duration::from_secs(16);

/// `key delete`, `reset` and `key scrub-backup`: 10 s of the engine's own worst case, + 5 s (spec §6).
pub const PROVIDER_OP_TIMEOUT: Duration = Duration::from_secs(15);

/// `provider test` for a remote or CLI entry: the engine's ≈ 72.5 s worst case + 5 s, rounded up
/// (spec §6, amended at the P2-M4 checkpoint). The engine's own copy is `APP_REMOTE_TEST_TIMEOUT_MS`
/// (`src/attemptBounds.ts`); `tests/engine_client.rs` reads it and asserts the two are equal.
pub const PROVIDER_TEST_REMOTE_TIMEOUT: Duration = Duration::from_secs(80);

/// The cap on a loopback Test's bound (plan Q12): 30 minutes. ⚠ THE ENGINE CAPS ITS PROBE SO THAT
/// `probe + 17 s` STAYS UNDER THIS — `APP_LOOPBACK_TEST_CAP_MS` in `src/attemptBounds.ts` restates
/// it, and nothing links the two copies but `tests/engine_client.rs`, which reads the engine's and
/// asserts equality. Move one, move both.
pub const PROVIDER_TEST_LOOPBACK_CAP: Duration = Duration::from_secs(30 * 60);

/// What the app adds to a loopback Test's probe timeout (spec §6) — and therefore the smallest
/// bound the engine ever reports in `testTimeoutMs`, which is why it is the floor of the clamp in
/// [`Operation::timeout`]. The engine's copy is `APP_LOOPBACK_TEST_EXTRA_MS`.
pub const PROVIDER_TEST_LOOPBACK_EXTRA: Duration = Duration::from_secs(17);

/// How long `calendar test --json` may take before it is abandoned (plan M8).
///
/// ⚠ DERIVED FROM THE ENGINE'S OWN BOUNDS, NOT MEASURED — `UNVERIFIED` against W1's M5, which builds
/// the subcommand. Spec r4 §3 bounds a run's calendar step at 30 s from the moment the network check
/// resolves, and that check's grace is up to 25 s (`NET_DEFAULT_GRACE_MS`, `src/net.ts`); a Test
/// that probes the network first and then reads every source is therefore up to ~55 s of the
/// engine's own waiting. 75 s adds 20 s for the process start, the config load and the helper
/// launch, so the engine's own `timeout` / `offline` statuses are what the user sees — not this.
pub const CALENDAR_TEST_TIMEOUT: Duration = Duration::from_secs(75);

/// How long `calendar details --json` may take before it is abandoned (wave-2 plan C-M3-T7): the
/// engine's 30 s calendar bound (`CALENDAR_STEP_BOUND_MS`, `src/calendar/bounds.ts`) plus 15 s for
/// the process start, the config load and the reader launch. It runs no network probe, so not
/// [`CALENDAR_TEST_TIMEOUT`]'s 75 s.
pub const CALENDAR_DETAILS_TIMEOUT: Duration = Duration::from_secs(45);

/// How long `calendar connect mac --json` may take before it is abandoned: **150 s**, spec r4 §8
/// ("`CalendarConnectMac` (mutating, 150 s: the helper's own 120 s request limit plus headroom, so the
/// engine reports its timeout status before the app kills it; …)").
///
/// ⚠ THE FIRST TIMEOUT ON A MUTATING INVOCATION, AND WHAT IT COSTS. Every other mutating operation
/// is deliberately unbounded here (`uninstall.rs`, `remove_scheduler`: "a timeout here could not
/// stop the engine's effects"). This one is bounded because its long pole is a PERSON — the helper's
/// `request` mode waits for the Calendar permission dialog — and a Settings button that can hang
/// forever is the worse failure. When it fires, dropping the invocation SIGKILLs the engine's process
/// group (`ProcessGroupKill`), so an engine interrupted mid-copy or mid-sign is killed without grace;
/// the helper itself is launched through LaunchServices (or `launchctl`), outside that group, and
/// ends on its own limit.
///
/// ⚠ WHY 150 AND NOT 120 (hub decision, plan M9; spec §8 updated to match). §4.1 gives the helper's
/// `request` mode a 120 s limit of its own, so a person can read and answer the dialog; at M8 this
/// bound was the SAME 120 s, which let the engine's copy-and-sign time push the whole call past it
/// and the Rust timeout fire before the engine could report its own `timeout` status. 150 s is that
/// 120 s plus 30 s of headroom for the copy, the re-sign and the engine's own start and answer. If W3
/// (M10b) raises the helper's limit, this must move with it.
pub const CALENDAR_CONNECT_MAC_TIMEOUT: Duration = Duration::from_secs(150);

/// The answer off macOS for the one macOS-only operation, [`Operation::CalendarConnectMac`] — the
/// `access.rs` precedent (`AccessError::Unsupported`): the command EXISTS on every platform, so the
/// grant lists stay in parity on the Linux CI job, and refuses before any spawn where it cannot
/// work. `on_macos` is a parameter (the command passes `cfg!(target_os = "macos")`) so both answers
/// are testable on whichever platform the suite runs.
pub fn mac_only(on_macos: bool) -> Result<(), EngineError> {
    if on_macos {
        return Ok(());
    }
    Err(EngineError::Unsupported {
        detail: "the Mac Calendar app source is a macOS feature; calendar links work on this \
                 platform without it"
            .into(),
    })
}

impl Operation {
    /// The argv the engine receives, argv[0] excluded.
    ///
    /// ⚠ THE SUBCOMMAND IS ALWAYS FIRST. `src/main.ts` refuses `--json status` with exit 2, and
    /// before that guard existed it routed to `run` and discarded the token — so a panel polling
    /// every few seconds performed a full pipeline run and the first poll of the morning consumed
    /// the morning (`docs/gui-seam.md` §1). Nothing here accepts a caller-supplied leading flag;
    /// there is no argv position a caller can reach that is not an operand of a fixed flag.
    pub fn argv(&self) -> Vec<String> {
        let mut argv: Vec<String> = Vec::new();
        match self {
            Operation::Run {
                force,
                now,
                json_out,
            } => {
                argv.push("run".into());
                argv.push("--json".into());
                if *force {
                    argv.push("--force".into());
                }
                if *now {
                    argv.push("--now".into());
                }
                if let Some(name) = json_out {
                    argv.push("--json-out".into());
                    argv.push(name.as_str().into());
                }
            }
            Operation::Status => {
                argv.push("status".into());
                argv.push("--json".into());
            }
            Operation::Doctor => {
                argv.push("doctor".into());
                argv.push("--json".into());
            }
            Operation::ConfigValidate { file } => {
                argv.push("config".into());
                argv.push("validate".into());
                argv.push("--json".into());
                argv.push("--file".into());
                argv.push(file.as_str().into());
            }
            Operation::ScheduleInstall { invoker, take_over } => {
                argv.push("schedule".into());
                argv.push("install".into());
                argv.push("--invoker".into());
                argv.push(invoker.as_str().into());
                if *take_over {
                    argv.push("--take-over".into());
                }
            }
            Operation::ScheduleUninstall { invoker, take_over } => {
                argv.push("schedule".into());
                argv.push("uninstall".into());
                argv.push("--invoker".into());
                argv.push(invoker.as_str().into());
                if *take_over {
                    argv.push("--take-over".into());
                }
            }
            Operation::ScheduleStatus => {
                argv.push("schedule".into());
                argv.push("status".into());
                argv.push("--json".into());
            }
            Operation::ScheduleVerify => {
                argv.push("schedule".into());
                argv.push("verify".into());
                argv.push("--json".into());
            }
            Operation::UpdateCheck => {
                argv.push("update".into());
                argv.push("--check".into());
                argv.push("--json".into());
            }
            Operation::CalendarStatus => {
                argv.push("calendar".into());
                argv.push("status".into());
                argv.push("--json".into());
            }
            Operation::CalendarList => {
                argv.push("calendar".into());
                argv.push("list".into());
                argv.push("--json".into());
            }
            Operation::CalendarTest => {
                argv.push("calendar".into());
                argv.push("test".into());
                argv.push("--json".into());
            }
            Operation::CalendarConnectMac => {
                argv.push("calendar".into());
                argv.push("connect".into());
                argv.push("mac".into());
                argv.push("--json".into());
            }
            // The `provider` verbs, spelled as `docs/gui-seam.md` §1d spells them: `--json`
            // exactly once, last. Every operand is a validated newtype; no key and no label is ever
            // pushed here.
            Operation::KeySet => {
                argv.extend(["provider", "key", "set", "--json"].map(String::from));
            }
            Operation::KeyMigrate { index } => {
                argv.extend(["provider", "key", "migrate", "--index"].map(String::from));
                argv.push(index.to_string());
                argv.push("--json".into());
            }
            Operation::KeyDelete { id } => {
                argv.extend(["provider", "key", "delete", "--id"].map(String::from));
                argv.push(id.as_str().into());
                argv.push("--json".into());
            }
            Operation::KeyDeleteAll => {
                argv.extend(["provider", "key", "delete-all", "--json"].map(String::from));
            }
            Operation::KeyScrubBackup => {
                argv.extend(["provider", "key", "scrub-backup", "--json"].map(String::from));
            }
            Operation::ProviderReset { target } => {
                argv.extend(["provider", "reset"].map(String::from));
                match target {
                    ResetTarget::Index(index) => {
                        argv.push("--index".into());
                        argv.push(index.to_string());
                    }
                    // The label itself goes to stdin (`stdin_payload`), never here.
                    ResetTarget::Label(_) => argv.push("--label-stdin".into()),
                }
                argv.push("--json".into());
            }
            Operation::ProviderTest { file, index, .. } => {
                argv.extend(["provider", "test", "--file"].map(String::from));
                argv.push(file.as_str().into());
                argv.push("--index".into());
                argv.push(index.to_string());
                argv.push("--json".into());
            }
            // The request goes to stdin (`stdin_payload`), never here.
            Operation::ReposStatus { .. } => {
                argv.extend(["repos", "status", "--json"].map(String::from));
            }
            Operation::CalendarDetails {
                skip_mac,
                skip_commands,
                ..
            } => {
                argv.extend(["calendar", "details", "--json"].map(String::from));
                if *skip_mac {
                    argv.push("--skip-mac".into());
                }
                if *skip_commands {
                    argv.push("--skip-commands".into());
                }
            }
        }
        argv
    }

    /// The bytes the engine reads on STDIN for this operation, when the OPERATION supplies them:
    /// `provider reset --label-stdin`'s `{"label": "…"}` and (wave 2, B1) `repos status`'s request,
    /// and nothing else. `None` means the child's stdin is `/dev/null`, as it always was before PR 3.
    ///
    /// ⚠ NOT THE KEY. `key set`'s key is never part of an `Operation`; it arrives through
    /// [`EngineClient::invoke_with_key`] as a separate [`KeySecret`]. An operation that supplied a
    /// payload AND was handed a key would be refused — which cannot arise today, because only
    /// [`Operation::KeySet`] takes a key and it supplies no payload.
    pub fn stdin_payload(&self) -> Option<Vec<u8>> {
        match self {
            Operation::ProviderReset {
                target: ResetTarget::Label(label),
            } => Some(label.stdin_payload()),
            Operation::ReposStatus { request } => Some(request.stdin_payload()),
            _ => None,
        }
    }

    /// Whether this operation reads a KEY on stdin — [`Operation::KeySet`] alone.
    pub fn takes_key(&self) -> bool {
        matches!(self, Operation::KeySet)
    }

    /// Whether the engine's process group is SIGKILLed when this invocation RETURNS normally, not
    /// only when it is abandoned — [`Operation::ProviderTest`] alone (P2-M4 checkpoint, into P3: a
    /// CLI Test's backgrounded grandchild can outlive the engine; the accepted 2026-10-16
    /// descendant-kill residual). Every other operation keeps what it deliberately backgrounded
    /// (`a_completed_invocation_leaves_what_the_engine_backgrounded_running`).
    pub fn kills_its_group_on_return(&self) -> bool {
        matches!(self, Operation::ProviderTest { .. })
    }

    /// A short, stable name for logs, events and the [`EngineError::Busy`] message.
    pub fn name(&self) -> &'static str {
        match self {
            Operation::Run { .. } => "run",
            Operation::Status => "status",
            Operation::Doctor => "doctor",
            Operation::ConfigValidate { .. } => "config-validate",
            Operation::ScheduleInstall { .. } => "schedule-install",
            Operation::ScheduleUninstall { .. } => "schedule-uninstall",
            Operation::ScheduleStatus => "schedule-status",
            Operation::ScheduleVerify => "schedule-verify",
            Operation::UpdateCheck => "update-check",
            Operation::CalendarStatus => "calendar-status",
            Operation::CalendarList => "calendar-list",
            Operation::CalendarTest => "calendar-test",
            Operation::CalendarConnectMac => "calendar-connect-mac",
            Operation::KeySet => "provider-key-set",
            Operation::KeyMigrate { .. } => "provider-key-migrate",
            Operation::KeyDelete { .. } => "provider-key-delete",
            Operation::KeyDeleteAll => "provider-key-delete-all",
            Operation::KeyScrubBackup => "provider-key-scrub-backup",
            Operation::ProviderReset { .. } => "provider-reset",
            Operation::ProviderTest { .. } => "provider-test",
            Operation::ReposStatus { .. } => "repos-status",
            Operation::CalendarDetails { .. } => "calendar-details",
        }
    }

    /// The wall-clock bound [`EngineClient::invoke`] puts on this operation, or `None` for none at
    /// this layer (plan M8).
    ///
    /// ⚠ `None` IS NOT "UNBOUNDED EVERYWHERE". The pre-M8 operations keep exactly the behaviour they
    /// had: the READ paths that need a bound (`shell::EngineSnapshots`, `briefing_files::engine_paths`,
    /// `access::read_envelope`, `config_save`'s validate) wrap `invoke` in
    /// `shell::ENGINE_READ_TIMEOUT` themselves, and every mutating one is deliberately unbounded
    /// (the engine's own deadlines bound it; `uninstall.rs`, `remove_scheduler`). The calendar
    /// operations carry their bound HERE instead, so every path to them is bounded by construction.
    ///
    /// ⚠ PR 3 (P3-M1-T1): the seven `provider` operations carry theirs too — spec §6, "every new
    /// operation has an explicit app-side timeout": the engine's own worst case + 5 s. All seven are
    /// MUTATING, so a timeout here kills an engine that may be mid-write; each verb's own deadlines
    /// fire first by construction (+5 s), and the store writes are temp-and-rename.
    pub fn timeout(&self) -> Option<Duration> {
        match self {
            Operation::CalendarStatus | Operation::CalendarList | Operation::ReposStatus { .. } => {
                Some(crate::shell::ENGINE_READ_TIMEOUT)
            }
            Operation::CalendarTest => Some(CALENDAR_TEST_TIMEOUT),
            Operation::CalendarDetails { .. } => Some(CALENDAR_DETAILS_TIMEOUT),
            Operation::CalendarConnectMac => Some(CALENDAR_CONNECT_MAC_TIMEOUT),
            Operation::KeySet | Operation::KeyMigrate { .. } => Some(KEY_SET_TIMEOUT),
            Operation::KeyDeleteAll => Some(KEY_DELETE_ALL_TIMEOUT),
            Operation::KeyDelete { .. }
            | Operation::KeyScrubBackup
            | Operation::ProviderReset { .. } => Some(PROVIDER_OP_TIMEOUT),
            Operation::ProviderTest {
                test_timeout_ms, ..
            } => Some(
                Duration::from_millis(*test_timeout_ms)
                    .clamp(PROVIDER_TEST_LOOPBACK_EXTRA, PROVIDER_TEST_LOOPBACK_CAP),
            ),
            Operation::Run { .. }
            | Operation::Status
            | Operation::Doctor
            | Operation::ConfigValidate { .. }
            | Operation::ScheduleInstall { .. }
            | Operation::ScheduleUninstall { .. }
            | Operation::ScheduleStatus
            | Operation::ScheduleVerify
            | Operation::UpdateCheck => None,
        }
    }

    /// Whether stdout is expected to be exactly one JSON document.
    ///
    /// ⚠ NOT A UNIVERSAL PROPERTY, which is the trap this method exists to avoid. `schedule
    /// install` and `schedule uninstall` have no `--json` form at all (`src/main.ts`: the flag is
    /// accepted on `schedule status` and `schedule verify` only) — they narrate on stdout.
    /// Treating a parse failure as [`Outcome::Failed`] for those would report every successful
    /// install as malformed output.
    pub fn expects_json(&self) -> bool {
        !matches!(
            self,
            Operation::ScheduleInstall { .. } | Operation::ScheduleUninstall { .. }
        )
    }

    /// Whether this operation can change state — a briefing, a day stamp, an OS schedule.
    ///
    /// This is what the in-flight guard keys on. It is deliberately NOT "every operation": the
    /// appendix's requirement is *one in-flight RUN*, and a `status` poll refused because a run is
    /// in flight would make a polling panel fail exactly when it has the most to show. What must
    /// never happen twice at once is a generation or a schedule mutation.
    ///
    /// ⚠ `ScheduleVerify` IS IN THIS SET ALTHOUGH ITS VERB READS LIKE A CHECK (T20). It kicks the
    /// registered trigger, so the engine runs under launchd and may deliver a briefing and stamp
    /// the day — a `schedule verify` racing a `Run Now` is two generations, which is the one thing
    /// this guard exists to prevent. `schedule status` remains a read and remains unguarded.
    ///
    /// ⚠ `UpdateCheck` IS NOT IN THIS SET, AND THAT IS A DECISION (plan §5 decision 16): it touches no
    /// schedule and no briefing state — its one write is the engine's own atomic update-check record
    /// — so a "Check now" refused with `Busy` because a briefing is generating would be a refusal
    /// guarding nothing. `tests/engine_client.rs` pins both halves: the partition, and the check
    /// succeeding while a run is in flight.
    ///
    /// ⚠ v0.3.0 (plan M8): `CalendarConnectMac` IS IN THIS SET — it writes and re-signs the helper
    /// copy through the keychain identity a schedule install also uses. `CalendarStatus`,
    /// `CalendarList` and `CalendarTest` are NOT: they change no schedule and no briefing state.
    ///
    /// ⚠ PR 3 (P3-M1-T1; spec §6 "the writing operations … hold the in-flight guard"): ALL SEVEN
    /// `provider` operations are in this set — each writes the key store, the settings backup or
    /// the engine's marks and status files. `ProviderTest` included: it records its outcome, and a
    /// second Test while one runs is refused `Busy` (P3-M1-T2 relies on that).
    pub fn is_mutating(&self) -> bool {
        matches!(
            self,
            Operation::Run { .. }
                | Operation::ScheduleInstall { .. }
                | Operation::ScheduleUninstall { .. }
                | Operation::ScheduleVerify
                | Operation::CalendarConnectMac
                | Operation::KeySet
                | Operation::KeyMigrate { .. }
                | Operation::KeyDelete { .. }
                | Operation::KeyDeleteAll
                | Operation::KeyScrubBackup
                | Operation::ProviderReset { .. }
                | Operation::ProviderTest { .. }
        )
    }
}

/* ── the original caller-supplied operands: `--json-out` and `--file` ───────────────────────────── */

/// Why an operand was refused. One variant per class, so a refusal is a fact the caller can act on
/// rather than "did not match a pattern".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputRefusal {
    /// The empty string, or an empty path segment (a `//` or a trailing `/`).
    Empty,
    /// A NUL byte. It would truncate the argv string at the syscall boundary.
    Nul,
    /// Whitespace. For `--json-out` that is ANY whitespace: a bare filename has no business
    /// containing one. For `--file` it is any whitespace OTHER THAN U+0020 — a plain space is a
    /// legitimate path character (`~/Library/Application Support/…`) and the argv is a vector, so
    /// nothing re-tokenises it; a tab, a newline or a NBSP in a path is still a value that reads
    /// as two on a log line.
    Whitespace,
    /// A control character (`char::is_control`) in a `--file` path. Nothing legitimate puts one
    /// in a filename, and it is what makes a terminal or a log render a different string from the
    /// one the syscall received. Checked AFTER [`InputRefusal::Whitespace`], so a tab or a newline
    /// — which is both — is reported as whitespace.
    ControlCharacter,
    /// A Unicode FORMAT character (general category `Cf`) — see [`REFUSED_FORMAT_CHARACTERS`] for
    /// the exact list and why it is a list. It is neither `char::is_control` (which is `Cc` only)
    /// nor `char::is_whitespace`, so it slipped past both of the checks above until this class
    /// existed; a bidi override is the same hazard they exist for, one layer up — it reorders how
    /// the path RENDERS without changing a byte of what `execve` receives. Checked AFTER those two
    /// so a tab or a newline keeps reporting its own class.
    FormatCharacter,
    /// A leading `-`. The value is spliced into an argv, so `-rf` or `--help` is a string that
    /// reads as a FLAG to whatever parses it next.
    LeadingDash,
    /// A path separator where a bare filename was required.
    Separator,
    /// A `--json-out` name starting with `.` — which is how `..` is excluded from a bare filename,
    /// and which also excludes a dotfile name, deliberately: the envelope lands in the engine's
    /// state directory and a hidden file there is not a thing anyone asked for.
    DotSegment,
    /// A `--file` path with a `.` or `..` segment — compared literally, so `.config` and `.local`
    /// are admitted while traversal is not.
    Traversal,
    /// A relative path where an absolute one was required.
    NotAbsolute,
    /// A `--json-out` character outside `[A-Za-z0-9._-]` that is not one of the classes above —
    /// notably not a [`InputRefusal::FormatCharacter`], which is split out of this class precisely
    /// because it is the invisible one.
    DisallowedCharacter,
    /// A segment longer than [`MAX_SEGMENT_CHARS`].
    SegmentTooLong,
    /// More than [`MAX_PATH_SEGMENTS`] segments.
    TooManySegments,
    /// A `--json-out` name that does not end in `.json`.
    NotJsonExtension,
    /// A `--json-out` name the ENGINE READS but does not refuse (B25 round-1 fix M4, measured):
    /// the engine's own `--json-out` guard (`src/json.ts`, `engineOwns`) derives its refusal list
    /// from `statePaths()`, and `transcript-health.json` — read and merged by `src/core.ts`
    /// (`emptyHealth()` spread, the §3.8 warning triggers) — has no `statePaths()` entry, so the
    /// engine ACCEPTS it and overwrites the whole health history with a run envelope (measured: 14
    /// seeded days → 0). Every OTHER engine-read state-dir `.json` is refused engine-side, which
    /// makes this an omission, not a design choice. The canonical fix is engine-side (a
    /// `transcriptHealthPath` in `statePaths()` + `engineOwns`'s `owned` list) and is registered
    /// as a Phase C follow-up (`docs/gui-seam.md` §16b dev 164 — the engine tree is read-only in
    /// B25); THIS refusal closes the app-reachable path (`engine_run_to_file`) now.
    EngineReadName,
    /// PR 3: a provider `--index` outside the engine's `/^\d{1,6}$/` (`src/providerCli.ts`,
    /// `parseIndex`) — so above [`MAX_PROVIDER_INDEX`].
    IndexOutOfRange,
    /// PR 3: a `--id` that is not `k-` followed by 12 LOWERCASE hex digits (the engine's
    /// `KEY_ID_RE`, `src/keyFile.ts`).
    NotKeyId,
    /// PR 3: a stdin payload larger than the engine reads — a label whose `{"label": …}` is over
    /// [`LABEL_STDIN_MAX_BYTES`], or a key over [`KEY_STDIN_MAX_BYTES`].
    TooLarge,
}

impl InputRefusal {
    /// A sentence for the webview. Deliberately does NOT echo the offending value: the caller
    /// supplied it and already has it, and not round-tripping an attacker-influenceable string
    /// back into a render surface is free here.
    pub fn message(self) -> &'static str {
        match self {
            InputRefusal::Empty => "is empty (or has an empty path segment)",
            InputRefusal::Nul => "contains a NUL byte",
            InputRefusal::Whitespace => "contains whitespace",
            InputRefusal::ControlCharacter => "contains a control character",
            InputRefusal::FormatCharacter => {
                "contains a Unicode format character (category Cf — a bidi override, a zero-width \
                 space or joiner, or a byte-order mark)"
            }
            InputRefusal::LeadingDash => "starts with a dash, which reads as a flag in an argv",
            InputRefusal::Separator => "contains a path separator; a bare filename was required",
            InputRefusal::DotSegment => "starts with a dot",
            InputRefusal::Traversal => "has a `.` or `..` path segment",
            InputRefusal::NotAbsolute => "is not an absolute path",
            InputRefusal::DisallowedCharacter => "contains a character outside [A-Za-z0-9._-]",
            InputRefusal::SegmentTooLong => "has a path segment longer than 64 characters",
            InputRefusal::TooManySegments => "has more than 16 path segments",
            InputRefusal::NotJsonExtension => "does not end in .json",
            InputRefusal::EngineReadName => {
                "is transcript-health.json — a state file the engine reads (its health history), \
                 not a free envelope name; writing a run envelope there would destroy that history"
            }
            InputRefusal::IndexOutOfRange => {
                "is not a provider position the engine accepts (0 to 999999)"
            }
            InputRefusal::NotKeyId => "is not a key id (k- followed by 12 lowercase hex digits)",
            InputRefusal::TooLarge => "is larger than the engine reads on stdin",
        }
    }
}

/// The Unicode FORMAT characters (general category `Cf`) both operand validators refuse, as
/// inclusive ranges.
///
/// ⚠ **AN EXPLICIT LIST RATHER THAN A CRATE.** Rust's standard library has no `Cf` predicate:
/// `char::is_control` is `Cc` ONLY (33 code points) and `char::is_whitespace` is `White_Space`,
/// and MEASURED against this validator before the list existed, every character below was
/// ADMITTED — U+202E RIGHT-TO-LEFT OVERRIDE included. Getting the category from
/// `unicode-general-category` or `unicode-properties` would add a dependency, and its tables, to a
/// validator whose whole claim is that it is small enough to read.
///
/// ⚠ **THE LIST IS THE ACTIONABLE SUBSET OF `Cf`, NOT A BMP SUBSET** — and that distinction is the
/// round-3 correction. This paragraph used to justify stopping at the BMP with "most of them
/// plane-1 formatting nobody puts in a path", which was wrong twice over: U+FFF9–U+FFFB are BMP,
/// and the TAG CHARACTERS are plane-14 formatting that is precisely what someone puts in a path —
/// an invisible mirror of ASCII, the classic hidden-payload set. MEASURED against Python 3's
/// bundled UCD (16.0.0), the category is **170** code points; the ranges below refuse **123** of
/// them: the bidi controls and isolates, the zero-width spaces/joiners, the BOM, the soft hyphen,
/// the interlinear annotation marks, and the language tag plus its 96 tag characters.
///
/// The **47 still ADMITTED** are named, because "we did not get to it" is not a reason:
/// U+0600–U+0605, U+06DD, U+070F, U+0890–U+0891, U+08E2 (Arabic/Syriac number, footnote, ayah,
/// abbreviation and currency marks), U+110BD, U+110CD (Kaithi number signs), U+13430–U+1343F
/// (Egyptian hieroglyph format controls), U+1BCA0–U+1BCA3 (Duployan shorthand), U+1D173–U+1D17A
/// (musical beam/phrase marks) — scribal and notational marks that render as marks, and none of
/// which reorders or conceals the text around it. **U+206A–U+206F is the honest exception**:
/// deprecated since Unicode 5.1, still invisible, and admitted here only because it neither
/// reorders (the bidi controls do) nor joins (U+2060–U+2064 do), so it can pad a rendered path
/// but not make it read as a different one. Widening the list is a one-line diff with a test —
/// the same standard [`MAX_SEGMENT_CHARS`] is held to.
///
/// ⚠ **THIS IS ABOUT RENDERING, NOT ABOUT `execve`.** A format character cannot change which file
/// the engine opens. It is refused because the engine's own stderr echoes the path back — a failed
/// `config validate --file` prints `could not read ${path}` (`src/main.ts:773-787`) and the
/// engine's `stripControl` (`src/render.ts`) strips `[\x00-\x1f\x7f-\x9f]` only, so the bytes
/// survive — and that stderr reaches the webview verbatim, as `EngineOutcome.stderr` and as each
/// `ProgressEvent.line`. MEASURED end to end: `config validate --json --file /<U+202E>evil.json`
/// against the real sidecar exits 2 and writes the path verbatim TWICE to stderr.
pub const REFUSED_FORMAT_CHARACTERS: &[(char, char)] = &[
    ('\u{00AD}', '\u{00AD}'),   // SOFT HYPHEN
    ('\u{061C}', '\u{061C}'),   // ARABIC LETTER MARK
    ('\u{180E}', '\u{180E}'),   // MONGOLIAN VOWEL SEPARATOR
    ('\u{200B}', '\u{200F}'),   // ZERO WIDTH SPACE … RIGHT-TO-LEFT MARK (ZWSP/ZWNJ/ZWJ/LRM/RLM)
    ('\u{202A}', '\u{202E}'),   // LEFT-TO-RIGHT EMBEDDING … RIGHT-TO-LEFT OVERRIDE
    ('\u{2060}', '\u{2064}'),   // WORD JOINER … INVISIBLE PLUS
    ('\u{2066}', '\u{2069}'),   // LRI / RLI / FSI / POP DIRECTIONAL ISOLATE (U+2065 is unassigned)
    ('\u{FEFF}', '\u{FEFF}'),   // ZERO WIDTH NO-BREAK SPACE (byte-order mark)
    ('\u{FFF9}', '\u{FFFB}'),   // INTERLINEAR ANNOTATION ANCHOR / SEPARATOR / TERMINATOR
    ('\u{E0001}', '\u{E0001}'), // LANGUAGE TAG (deprecated)
    ('\u{E0020}', '\u{E007F}'), // TAG CHARACTERS: an invisible mirror of ASCII, plus CANCEL TAG
];

/// Whether `c` is one of [`REFUSED_FORMAT_CHARACTERS`].
pub fn is_refused_format_character(c: char) -> bool {
    REFUSED_FORMAT_CHARACTERS
        .iter()
        .any(|(lo, hi)| c >= *lo && c <= *hi)
}

/// The per-segment character ceiling, ported from the capability's `{0,63}` (a leading character
/// plus 63). Arbitrary-but-generous rather than principled — widen it deliberately, with a test.
/// Counted in `char`s, not bytes, so a non-ASCII segment is measured the way a user reads it.
pub const MAX_SEGMENT_CHARS: usize = 64;

/// The path-depth ceiling, ported from the capability's `(…/){0,15}` plus the final segment.
pub const MAX_PATH_SEGMENTS: usize = 16;

/// A validated `run --json-out` operand: a BARE FILENAME ending in `.json`.
///
/// Ported from the capability validator `[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json`. No separator can
/// appear, so traversal is unreachable here rather than merely caught later by the engine's own
/// `resolveJsonOutPath` guard (`src/json.ts`); a relative name resolves under the engine's state
/// directory, and the engine additionally refuses names it owns (`briefing.log`, `last-run`, …) —
/// with one measured gap, `transcript-health.json`, refused HERE instead
/// ([`InputRefusal::EngineReadName`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonOutName(String);

impl JsonOutName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A validated `config validate --file` operand: an ABSOLUTE path with no empty, `.` or `..`
/// segment, no NUL, no control character, no Unicode format character
/// ([`REFUSED_FORMAT_CHARACTERS`]), no whitespace other than U+0020, at most
/// [`MAX_PATH_SEGMENTS`] segments of at most [`MAX_SEGMENT_CHARS`] characters each.
///
/// ⚠ DELIBERATELY WIDER THAN THE CAPABILITY REGEX IT REPLACES
/// (`/([A-Za-z0-9_-][A-Za-z0-9._-]{0,63}/){0,15}[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}`). That regex
/// refused a dot-leading segment (to exclude `..` without lookahead) and every character outside
/// its ASCII class (whitespace included) — which refused `$HOME/.config/daily-briefing/config.json`,
/// the engine's own default config path, and everything under `~/Library/Application Support/`,
/// which is both the engine's state directory and Tauri's `app_data_dir`. Neither refusal was a
/// security control: the value is one element of the argv VECTOR `tokio::process::Command` hands
/// to `execve` (see [`EngineClient::invoke`] — there is no shell to re-tokenise a space), the
/// engine reads the operand whole (`src/main.ts`, `readCandidate`: `Bun.file(path).text()`), and a
/// symlink walks through a `..` rule anyway. What is still refused is what can change the string
/// between the caller and the syscall (NUL), make a log line lie about it (control characters,
/// non-space whitespace, and — since round 2 — Unicode format characters: a bidi override is
/// neither control nor whitespace and reorders how the path renders, and the engine's OWN stderr
/// echoes the path back verbatim, so this is a live surface rather than a hypothetical one; see
/// [`REFUSED_FORMAT_CHARACTERS`] for the measurement), or is not a candidate file's path at all
/// (relative, empty segment, traversal, the two ceilings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigFilePath(String);

impl ConfigFilePath {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The `--json-out` preamble, before anything shape-specific: empty, NUL, and ANY whitespace. A
/// bare filename has no legitimate whitespace in it. (`--file` does its own preamble inline —
/// it admits U+0020 — see [`config_file_path`].)
fn reject_argv_hazards(value: &str) -> Result<(), InputRefusal> {
    if value.is_empty() {
        return Err(InputRefusal::Empty);
    }
    if value.contains('\0') {
        return Err(InputRefusal::Nul);
    }
    // `char::is_whitespace` rather than `is_ascii_whitespace`: U+00A0 and friends are just as
    // capable of hiding a second token from a human reading a log line.
    if value.chars().any(char::is_whitespace) {
        return Err(InputRefusal::Whitespace);
    }
    Ok(())
}

/// Classify a character that is not an allowed *interior* character, so every refusal names its
/// own class instead of collapsing to "disallowed".
fn classify_bad_char(c: char) -> InputRefusal {
    match c {
        '/' | '\\' => InputRefusal::Separator,
        '-' => InputRefusal::LeadingDash,
        '.' => InputRefusal::DotSegment,
        // `--json-out` already refused every one of these as "outside [A-Za-z0-9._-]", so this
        // changes no verdict — only the reason. It is the one refusal class whose offending
        // character is INVISIBLE, which is exactly when "contains a disallowed character" leaves
        // the caller with nothing to look for.
        c if is_refused_format_character(c) => InputRefusal::FormatCharacter,
        _ => InputRefusal::DisallowedCharacter,
    }
}

/// Parse a `--json-out` operand, or say exactly why not.
pub fn json_out_name(value: &str) -> Result<JsonOutName, InputRefusal> {
    reject_argv_hazards(value)?;
    // The `.json` suffix must be TERMINAL — `out.json.exe` is not a JSON envelope name.
    let stem = value
        .strip_suffix(".json")
        .ok_or(InputRefusal::NotJsonExtension)?;
    let mut chars = stem.chars();
    let first = chars.next().ok_or(InputRefusal::Empty)?;
    if !first.is_ascii_alphanumeric() {
        return Err(classify_bad_char(first));
    }
    // 1 leading character + `{0,63}`, exactly as the capability spells it.
    if stem.chars().count() > MAX_SEGMENT_CHARS {
        return Err(InputRefusal::SegmentTooLong);
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
            return Err(classify_bad_char(c));
        }
    }
    // ⚠ THE ASYMMETRY THIS GUARDS (B25 round-1 fix M4): the engine refuses `--json-out` names it
    // OWNS (`briefing.log`, `last-run`, `account-state.json`, …) but its refusal list is derived
    // from `statePaths()`, and `transcript-health.json` — a file the engine READS on every run —
    // has no entry there, so the engine accepts it and clobbers its own health history. Refused
    // HERE, exactly, until the engine-side list gains the entry (Phase C follow-up, `docs/
    // gui-seam.md` §16b dev 164). See [`InputRefusal::EngineReadName`] for the measurement.
    // ASCII-case-insensitive: the default APFS volume is case-INSENSITIVE, so
    // `Transcript-Health.json` opens the same file the exact spelling would clobber.
    if value.eq_ignore_ascii_case("transcript-health.json") {
        return Err(InputRefusal::EngineReadName);
    }
    Ok(JsonOutName(value.to_string()))
}

/// Parse a `--file` operand, or say exactly why not. See [`ConfigFilePath`] for what is refused and
/// why the shape is wider than `--json-out`'s.
pub fn config_file_path(value: &str) -> Result<ConfigFilePath, InputRefusal> {
    if value.is_empty() {
        return Err(InputRefusal::Empty);
    }
    if value.contains('\0') {
        return Err(InputRefusal::Nul);
    }
    // U+0020 is admitted; every other whitespace character is not. Checked before the control
    // check so that a tab or a newline — both — is reported as the class a reader expects.
    if value.chars().any(|c| c.is_whitespace() && c != ' ') {
        return Err(InputRefusal::Whitespace);
    }
    if value.chars().any(char::is_control) {
        return Err(InputRefusal::ControlCharacter);
    }
    // Checked LAST of the three character classes, so a character that is also whitespace or a
    // control reports the class a reader expects. See [`REFUSED_FORMAT_CHARACTERS`].
    if value.chars().any(is_refused_format_character) {
        return Err(InputRefusal::FormatCharacter);
    }
    let rest = value.strip_prefix('/').ok_or(InputRefusal::NotAbsolute)?;
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.len() > MAX_PATH_SEGMENTS {
        return Err(InputRefusal::TooManySegments);
    }
    for segment in segments {
        if segment.is_empty() {
            return Err(InputRefusal::Empty);
        }
        // An explicit comparison, which the hand-written validator can express and the regex
        // could not: `.` and `..` are refused, `.config` and `.local` are admitted.
        if segment == "." || segment == ".." {
            return Err(InputRefusal::Traversal);
        }
        if segment.chars().count() > MAX_SEGMENT_CHARS {
            return Err(InputRefusal::SegmentTooLong);
        }
    }
    Ok(ConfigFilePath(value.to_string()))
}

/* ── the provider operands (PR 3, P3-M1-T1) ───────────────────────────────────────────────────── */
//
// Four more caller-supplied values, each a newtype that cannot be built without its validator, so
// the module header's invariant — every caller-supplied operand is a validated newtype — still
// holds: two that reach argv, a provider `--index` and a key `--id`; and two written to stdin,
// never argv — a reset LABEL and the KEY `key set` reads ([`KeySecret`], not an `Operation`
// operand: `EngineClient::invoke_with_key` takes it beside one).
// Each validator ports the ENGINE'S OWN rule (`docs/gui-seam.md` §1d), and `tests/engine_client.rs`
// reads the engine's source for the rule it compares against.

/// The largest provider position the engine accepts: `--index` must match `/^\d{1,6}$/`
/// (`src/providerCli.ts`, `parseIndex`).
pub const MAX_PROVIDER_INDEX: u32 = 999_999;

/// The most `provider reset --label-stdin` reads: `LABEL_STDIN_MAX_BYTES` (`src/providerCli.ts`).
/// The cap applies to the whole `{"label": …}` payload, which is what the engine measures.
pub const LABEL_STDIN_MAX_BYTES: usize = 64 * 1024;

/// The most `key set` reads on stdin: `KEY_STDIN_MAX_BYTES` (`src/providerCli.ts`).
pub const KEY_STDIN_MAX_BYTES: usize = 4 * 1024;

/// A validated provider `--index`: the 0-based position in the combined list (`status --json`'s
/// `providers[].index`), at most [`MAX_PROVIDER_INDEX`]. Rendered as plain decimal — no sign, no
/// leading zero — so it always matches the engine's `/^\d{1,6}$/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderIndex(u32);

impl ProviderIndex {
    pub fn get(self) -> u32 {
        self.0
    }
}

impl std::fmt::Display for ProviderIndex {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Parse a provider position, or say why not.
pub fn provider_index(value: u64) -> Result<ProviderIndex, InputRefusal> {
    u32::try_from(value)
        .ok()
        .filter(|n| *n <= MAX_PROVIDER_INDEX)
        .map(ProviderIndex)
        .ok_or(InputRefusal::IndexOutOfRange)
}

/// A validated `key delete --id`: `k-` and 12 LOWERCASE hex digits, exactly the engine's
/// `KEY_ID_RE` (`src/keyFile.ts`). Not a secret — the engine answers it on stdout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyId(String);

impl KeyId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Parse a key id, or say why not.
pub fn key_id(value: &str) -> Result<KeyId, InputRefusal> {
    let hex = value.strip_prefix("k-").ok_or(InputRefusal::NotKeyId)?;
    if hex.len() == 12
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(KeyId(value.to_string()))
    } else {
        Err(InputRefusal::NotKeyId)
    }
}

/// A validated `provider reset` label: non-empty, no NUL, and short enough that its
/// `{"label": …}` payload fits the engine's [`LABEL_STDIN_MAX_BYTES`].
///
/// ⚠ THE CAP IS MEASURED ON THE PAYLOAD, NOT THE LABEL, and that is the measurement the plan asked
/// for. The config validator's label rule (`src/providerList.ts`: a non-empty string after `trim`)
/// has NO length limit, so no byte cap on the label could admit every label a config can hold; the
/// real limit is what `reset --label-stdin` will read. JSON escaping can grow a label (a control
/// byte becomes six), so the serialised payload — the bytes the engine actually counts — is what is
/// compared. A label over the cap cannot be reset by label; `--index` still can.
///
/// ⚠ NOT A ROUTE INTO ARGV. The label is only ever written to stdin
/// ([`Operation::stdin_payload`]); it is user text and may itself be key-shaped (spec §4), so its
/// `Debug` prints the byte length only.
#[derive(Clone, PartialEq, Eq)]
pub struct Label(String);

impl std::fmt::Debug for Label {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Label(<{} bytes>)", self.0.len())
    }
}

impl Label {
    /// `{"label": "<label>"}`, exactly what `reset --label-stdin` reads (that one member only).
    pub fn stdin_payload(&self) -> Vec<u8> {
        label_payload(&self.0)
    }
}

fn label_payload(label: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "label": label }))
        .expect("a JSON object of one string member always serialises")
}

/// Parse a reset label, or say why not. Whitespace is NOT judged here: a label of spaces cannot be
/// in a valid config (the validator trims), and the engine answers such a reset with its own
/// `config` refusal — the app does not re-implement the list's rules.
pub fn label(value: &str) -> Result<Label, InputRefusal> {
    if value.is_empty() {
        return Err(InputRefusal::Empty);
    }
    if value.contains('\0') {
        return Err(InputRefusal::Nul);
    }
    if label_payload(value).len() > LABEL_STDIN_MAX_BYTES {
        return Err(InputRefusal::TooLarge);
    }
    Ok(Label(value.to_string()))
}

/// The key `key set` reads on stdin — NOT part of any [`Operation`].
///
/// ⚠ DELIBERATELY NO `Debug`, `Display`, `Clone`, `Serialize` OR `PartialEq`: nothing can print it,
/// copy it or compare it by accident, and `tests/engine_client.rs` pins the missing `Debug` at
/// compile time. Its bytes are overwritten when it is dropped (best effort: the webview's `String`
/// it was built from is Tauri's, and the pipe buffer is the kernel's). The engine trims it and
/// applies the key rule (`docs/gui-seam.md` §1d); the app refuses only what the engine would never
/// read — empty, or over [`KEY_STDIN_MAX_BYTES`] — and never echoes it.
pub struct KeySecret(Vec<u8>);

impl KeySecret {
    pub fn new(key: String) -> Result<Self, InputRefusal> {
        let secret = KeySecret(key.into_bytes());
        if secret.0.is_empty() {
            return Err(InputRefusal::Empty);
        }
        if secret.0.len() > KEY_STDIN_MAX_BYTES {
            return Err(InputRefusal::TooLarge);
        }
        Ok(secret)
    }

    fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for KeySecret {
    fn drop(&mut self) {
        wipe_bytes(&mut self.0);
    }
}

/// Overwrite `buf` with zeros so the bytes of a secret about to be freed do not linger in the heap.
///
/// ⚠ THE ONE VOLATILE LOOP (wave-2 plan C-M3-T7): [`KeySecret`]'s `Drop` and [`SecretBytes::wipe`]
/// both call this, moved here unchanged from `KeySecret`'s `Drop`, so the two secrets cannot drift
/// into a second copy the optimiser may drop. `tests/engine_client.rs` pins exactly one
/// `write_volatile` in this file, inside this function.
pub(crate) fn wipe_bytes(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
        // SAFETY: `byte` is a valid, aligned, exclusively borrowed `u8`. Volatile so the
        // overwrite of a buffer about to be freed is not optimised away.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

/// Bytes that are a secret: zeroed when dropped, through [`wipe_bytes`].
///
/// ⚠ DELIBERATELY NO `Debug`, `Display`, `Clone`, `Serialize` OR `PartialEq` (the [`KeySecret`]
/// rule; `tests/engine_client.rs` probes the first three at compile time and greps for the rest).
/// It holds the live details read's handback ([`LinkHandback`]): the remembered command-link URLs.
/// [`SecretBytes::from_vec`] takes the `Vec` by value, so no copy is made, and its caller builds it
/// at its exact capacity (`calendar_details.rs`), so no reallocation leaves an unwiped copy behind.
/// Best effort, as `KeySecret`'s is: copies this buffer does not own are not reached. In particular,
/// the sealed read's final stdout/stderr buffers drop unwiped on timeout or a `child.wait()` error,
/// before `SealedDetails::collect` can wipe them. Earlier allocations freed by growth, stderr's
/// temporary reader/line/text buffers, serde's parse strings and kernel pipe buffers are not wiped.
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Take ownership of `v`; nothing is copied.
    pub fn from_vec(v: Vec<u8>) -> Self {
        SecretBytes(v)
    }

    /// Zero the bytes now (also done on drop).
    pub(crate) fn wipe(&mut self) {
        wipe_bytes(&mut self.0);
    }

    fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for SecretBytes {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// The live details read's STDIN: `{"links":[{"id","entryHash","url"}…]}`, the command-link URLs
/// Rust remembered, handed back so their commands do not run again (redesign C, "Later reads hand
/// it back"). NOT part of any [`Operation`]: it travels beside [`Operation::CalendarDetails`]
/// through [`EngineClient::invoke_sealed`], the [`KeySecret`] pattern.
///
/// ⚠ NO `Debug`, `Display`, `Clone` OR `Serialize` (probed). Its one production caller is the
/// snapshot in `calendar_details.rs`, which copies the URLs into its buffer under that module's
/// state lock (`tests/capability.rs` pins the caller).
pub struct LinkHandback(SecretBytes);

impl LinkHandback {
    /// Wrap the snapshot's bytes. One production caller: `calendar_details.rs`'s snapshot.
    pub fn new(bytes: SecretBytes) -> Self {
        LinkHandback(bytes)
    }

    fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
}

/* ── B1 (wave 2): the `repos status --json` request ───────────────────────────────────────────── */
//
// The live git check's operand (wave-2 plan B1-M4-T11; the B1 spec "Where it is computed"). It is
// written to the engine's STDIN as ONE JSON document — `{ scope, pageDate, labels: [{ key, tokens }],
// branches: [{ key, name }] }`, camelCase, exactly what `parseReposRequest` (`src/repos/status.ts`)
// reads and no other member (the engine refuses one) — and never to argv: the `ProviderReset`
// precedent, an operand the operation carries, not a secret. `tests/fixtures/repos-request-wire.json`
// pins the bytes on both sides (`tests/engine_client.rs` and `test/repos.status.test.ts`).
//
// ⚠ ONE BAD ENTRY REFUSES THE WHOLE REQUEST, so the webview's `reposRequest` (`git-detail.ts`, B1-M5)
// never builds one: it leaves an odd card out instead. The six limits and the character rule are
// shared with it through `tests/fixtures/repos-request-limits.json`.

/// At most this many labels (What-you-did cards).
pub const REPOS_MAX_LABELS: usize = 64;
/// At most this many branch entries (Where-you-left-off cards with a named branch).
pub const REPOS_MAX_BRANCHES: usize = 64;
/// A label key, and a branch entry's key, is at most this many Unicode scalar values.
pub const REPOS_KEY_MAX_SCALARS: usize = 80;
/// At most this many tokens on one label.
pub const REPOS_TOKENS_PER_LABEL: usize = 512;
/// At most this many tokens in the whole request.
pub const REPOS_TOKENS_TOTAL: usize = 4096;
/// A branch name is at most this many UTF-8 BYTES (not scalars).
pub const REPOS_BRANCH_MAX_BYTES: usize = 255;
/// The most `repos status` reads on stdin: `REPOS_STDIN_MAX_BYTES` (`src/repos/status.ts`), pinned
/// to the engine's through `tests/fixtures/repos-request-wire.json`. The largest request the
/// validation admits serialises under it (`tests/engine_client.rs`).
pub const REPOS_STDIN_MAX_BYTES: usize = 256 * 1024;

/// Which check the engine runs: everything, or the minute "Not committed" status alone. The gate
/// (`repos::decide`) chooses it; the webview never does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReposScope {
    All,
    Uncommitted,
}

/// One What-you-did card as the webview sends it: its key (`norm(label)`; the Other card's is `""`)
/// and the hex tokens of its page lines. UNVALIDATED until [`ReposRequest::new`] takes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReposLabel {
    pub key: String,
    pub tokens: Vec<String>,
}

/// One Where-you-left-off card's named branch. UNVALIDATED until [`ReposRequest::new`] takes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReposBranch {
    pub key: String,
    pub name: String,
}

/// Why a repos request was refused: one variant per rule, never echoing the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReposRefusal {
    /// More than [`REPOS_MAX_LABELS`] labels.
    TooManyLabels,
    /// More than [`REPOS_MAX_BRANCHES`] branch entries.
    TooManyBranches,
    /// A label key over [`REPOS_KEY_MAX_SCALARS`] scalar values.
    LabelKeyTooLong,
    /// A control (`char::is_control`) or refused format character ([`is_refused_format_character`])
    /// in a label key.
    LabelKeyCharacter,
    /// A token that is not 1 to 40 ASCII hex characters.
    TokenNotHex,
    /// More than [`REPOS_TOKENS_PER_LABEL`] tokens on one label.
    TooManyTokensInLabel,
    /// More than [`REPOS_TOKENS_TOTAL`] tokens in all.
    TooManyTokens,
    /// A branch entry's key over [`REPOS_KEY_MAX_SCALARS`] scalar values.
    BranchKeyTooLong,
    /// A control or refused format character in a branch entry's key.
    BranchKeyCharacter,
    /// A branch name over [`REPOS_BRANCH_MAX_BYTES`] UTF-8 bytes.
    BranchNameTooLong,
    /// A control or refused format character in a branch name.
    BranchNameCharacter,
    /// `pageDate` is not a real `YYYY-MM-DD` date ([`crate::briefing_files::archive_date`]).
    PageDate,
}

impl ReposRefusal {
    /// The request member the refusal is about.
    pub fn field(self) -> &'static str {
        match self {
            ReposRefusal::TooManyLabels
            | ReposRefusal::LabelKeyTooLong
            | ReposRefusal::LabelKeyCharacter => "labels",
            ReposRefusal::TokenNotHex
            | ReposRefusal::TooManyTokensInLabel
            | ReposRefusal::TooManyTokens => "labels.tokens",
            ReposRefusal::TooManyBranches
            | ReposRefusal::BranchKeyTooLong
            | ReposRefusal::BranchKeyCharacter
            | ReposRefusal::BranchNameTooLong
            | ReposRefusal::BranchNameCharacter => "branches",
            ReposRefusal::PageDate => "pageDate",
        }
    }

    /// A sentence for the webview; the value is never echoed.
    pub fn message(self) -> &'static str {
        match self {
            ReposRefusal::TooManyLabels => "has more than 64 labels",
            ReposRefusal::TooManyBranches => "has more than 64 branch entries",
            ReposRefusal::LabelKeyTooLong => "has a label key longer than 80 characters",
            ReposRefusal::LabelKeyCharacter => {
                "has a label key holding a control or Unicode format character"
            }
            ReposRefusal::TokenNotHex => "has a token that is not 1 to 40 hex digits",
            ReposRefusal::TooManyTokensInLabel => "has more than 512 tokens on one label",
            ReposRefusal::TooManyTokens => "has more than 4096 tokens in all",
            ReposRefusal::BranchKeyTooLong => "has a branch entry key longer than 80 characters",
            ReposRefusal::BranchKeyCharacter => {
                "has a branch entry key holding a control or Unicode format character"
            }
            ReposRefusal::BranchNameTooLong => "has a branch name longer than 255 bytes",
            ReposRefusal::BranchNameCharacter => {
                "has a branch name holding a control or Unicode format character"
            }
            ReposRefusal::PageDate => "is not a YYYY-MM-DD date",
        }
    }
}

impl From<ReposRefusal> for EngineError {
    fn from(r: ReposRefusal) -> Self {
        EngineError::InvalidInput {
            field: r.field().into(),
            reason: r.message().into(),
        }
    }
}

/// The character rule for keys and branch names: no control and no refused format character.
fn repos_char_ok(c: char) -> bool {
    !(c.is_control() || is_refused_format_character(c))
}

/// Why a key breaks the label-key rule, which a branch entry's key follows too.
enum KeyBreak {
    TooLong,
    Character,
}

/// The label-key rule: at most [`REPOS_KEY_MAX_SCALARS`] scalars and no refused character; `""`
/// (the Other card) is admitted.
fn repos_key_check(key: &str) -> Result<(), KeyBreak> {
    if key.chars().count() > REPOS_KEY_MAX_SCALARS {
        return Err(KeyBreak::TooLong);
    }
    if !key.chars().all(repos_char_ok) {
        return Err(KeyBreak::Character);
    }
    Ok(())
}

/// A validated `repos status` request. Constructed only by [`ReposRequest::new`]; serialises to
/// exactly the engine's STDIN contract. It holds no secret and no path, so it derives `Debug`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReposRequest {
    scope: ReposScope,
    page_date: String,
    labels: Vec<ReposLabel>,
    branches: Vec<ReposBranch>,
}

impl ReposRequest {
    /// Validate a request, or say which rule it breaks (plan B1-M4-T11).
    pub fn new(
        scope: ReposScope,
        page_date: &str,
        labels: Vec<ReposLabel>,
        branches: Vec<ReposBranch>,
    ) -> Result<Self, ReposRefusal> {
        crate::briefing_files::archive_date(page_date).map_err(|_| ReposRefusal::PageDate)?;
        if labels.len() > REPOS_MAX_LABELS {
            return Err(ReposRefusal::TooManyLabels);
        }
        if branches.len() > REPOS_MAX_BRANCHES {
            return Err(ReposRefusal::TooManyBranches);
        }
        let hex =
            |t: &String| (1..=40).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit());
        let mut total = 0usize;
        for label in &labels {
            repos_key_check(&label.key).map_err(|b| match b {
                KeyBreak::TooLong => ReposRefusal::LabelKeyTooLong,
                KeyBreak::Character => ReposRefusal::LabelKeyCharacter,
            })?;
            if label.tokens.len() > REPOS_TOKENS_PER_LABEL {
                return Err(ReposRefusal::TooManyTokensInLabel);
            }
            total += label.tokens.len();
            if total > REPOS_TOKENS_TOTAL {
                return Err(ReposRefusal::TooManyTokens);
            }
            if !label.tokens.iter().all(hex) {
                return Err(ReposRefusal::TokenNotHex);
            }
        }
        for branch in &branches {
            repos_key_check(&branch.key).map_err(|b| match b {
                KeyBreak::TooLong => ReposRefusal::BranchKeyTooLong,
                KeyBreak::Character => ReposRefusal::BranchKeyCharacter,
            })?;
            if branch.name.len() > REPOS_BRANCH_MAX_BYTES {
                return Err(ReposRefusal::BranchNameTooLong);
            }
            if !branch.name.chars().all(repos_char_ok) {
                return Err(ReposRefusal::BranchNameCharacter);
            }
        }
        Ok(Self {
            scope,
            page_date: page_date.to_string(),
            labels,
            branches,
        })
    }

    pub fn page_date(&self) -> &str {
        &self.page_date
    }

    pub fn labels(&self) -> &[ReposLabel] {
        &self.labels
    }

    pub fn branches(&self) -> &[ReposBranch] {
        &self.branches
    }

    /// The same validated request at another scope: the gate (`repos::decide`) chooses it.
    pub fn with_scope(mut self, scope: ReposScope) -> Self {
        self.scope = scope;
        self
    }

    /// The bytes the engine reads on stdin.
    fn stdin_payload(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a request of strings and lists always serialises")
    }
}

/* ── T9: the launchd environment, reproduced ──────────────────────────────────────────────────── */

/// The PATH the engine's own launchd generator puts in the plist, reproduced for every spawn this
/// app makes.
///
/// ⚠ WHY THIS EXISTS AT ALL, and why it will not reproduce in development. A GUI app launched from
/// Finder or as a login item gets a MINIMAL environment, not the user's interactive shell PATH — so
/// the sidecar would fail to find `claude`/`codex` and every morning would end in a
/// missing-binary ProviderError with a confusing message. `cargo tauri dev` inherits the
/// developer's shell PATH and hides it completely. This only shows up for the stranger, which is
/// the whole audience.
///
/// ⚠ THE SOURCE OF TRUTH IS `src/schedule/install.ts`, NOT `scripts/install.sh`. The appendix cites
/// `install.sh:82`; that line is GONE — A2 deleted the checked-in plist template and the `sed` that
/// filled it, and moved unit generation into the engine (`scripts/install.sh`'s "THE PLIST HALF IS
/// DELEGATED TO THE BINARY" note). The value now lives in `installSchedule`'s `ScheduleOpts`
/// (`src/schedule/install.ts`, the `pathEnv:` line), which `src/schedule/units.ts` writes into the
/// plist's `EnvironmentVariables`. `tests/engine_env.rs` parses that line at test time and compares
/// it to this function character for character, so the two cannot diverge silently.
pub fn launchd_path(home: &Path) -> String {
    let local_bin = home.join(".local").join("bin");
    format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        local_bin.display()
    )
}

/// The variables forwarded from the app's own environment, when present.
///
/// Everything else is dropped, PATH included — PATH is always [`launchd_path`] (or an explicit
/// override), never inherited, and `path_is_never_inherited` pins that. This list is the small set
/// a launchd-started process also receives from the user's session: the engine resolves its state
/// directory from `HOME` (`src/marker.ts`), git reads `HOME` for its config, and the rest are
/// locale/temp conveniences that cost nothing and whose absence produces confusing failures.
/// Linux adds two more — [`FORWARDED_ENV_LINUX`]; [`forwarded_env`] is the set actually forwarded.
pub const FORWARDED_ENV: &[&str] = &["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ"];

/// Forwarded IN ADDITION on Linux, and only there: how `systemctl --user` reaches the user's
/// service manager.
///
/// The engine schedules itself on Linux by running `systemctl --user` (`src/schedule/install.ts`)
/// with its own environment (`src/proc.ts`), and that call needs one of these to find the user
/// bus — without them the app's scheduler install fails at its first `daemon-reload`. Linux-only
/// so the macOS app's environment stays exactly [`FORWARDED_ENV`].
pub const FORWARDED_ENV_LINUX: &[&str] = &["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/// The names forwarded on THIS OS: [`FORWARDED_ENV`], plus [`FORWARDED_ENV_LINUX`] on Linux.
pub fn forwarded_env() -> Vec<&'static str> {
    let mut names = FORWARDED_ENV.to_vec();
    if cfg!(target_os = "linux") {
        names.extend_from_slice(FORWARDED_ENV_LINUX);
    }
    names
}

/// Set (never forwarded) on every spawn: turns off the Bun runtime's own crash reporter.
///
/// The engine is a `bun build --compile` binary, and Bun (v1.3.14,
/// `src/crash_handler/crash_handler.zig`, `isReportingEnabled`) uploads a crash trace to
/// `bun.report` when the RUNTIME itself panics or segfaults — by default on macOS and Windows. It
/// reads `BUN_ENABLE_CRASH_REPORTING` through libc `getenv` when it decides, and `"0"` turns the
/// upload off; only a set `BUN_CRASH_REPORT_URL` outranks it, and `env_clear` guarantees the child
/// has none. The scheduled runs carry the same pair (`src/schedule/units.ts`,
/// `BUN_CRASH_REPORTING_OFF`), and the README's Privacy section promises both.
pub const BUN_CRASH_REPORTING_OFF: (&str, &str) = ("BUN_ENABLE_CRASH_REPORTING", "0");

/// The idle-sleep guard for app spawns. The plist USED to wrap the engine in it
/// (`/usr/bin/caffeinate -i <bin> run`); since 2026-10-11 it starts `[<bin>, run]` directly — the
/// wrapper made Background Activity list the job as "caffeinate" — and sets
/// `DAILY_BRIEFING_KEEP_AWAKE=1`, on which the engine starts `caffeinate -i -w <its pid>` itself
/// (`src/schedule/units.ts` `launchdPlist`, `src/keep-awake.ts`). App spawns do not set that
/// variable, so they keep exactly one caffeinate: this wrapper.
///
/// R1 grafts this onto ALL app spawns, not only scheduled ones ("PATH parity + caffeinate on app
/// spawns"): a user-clicked run makes the same 30-120s provider call, and a machine that idles to
/// sleep halfway through loses it just as thoroughly.
///
/// ⚠ THE PROCESS TOPOLOGY IS NOT WHAT THE COMMAND LINE SUGGESTS. `caffeinate -i <utility>` does
/// not run the utility as its child: it forks, the CHILD becomes the assertion holder (the
/// `/usr/bin/caffeinate` you see in `ps`), and the ORIGINAL pid `exec`s the utility. MEASURED: the
/// pid returned by the spawn is the sidecar itself, and `/usr/bin/caffeinate -i …` is a child of
/// it. So killing the spawned PID kills the sidecar and the caffeinate child exits with its parent
/// — but the sidecar's own children (git, the provider CLI, an `apiKeyCommand` helper) are not
/// reached by a signal to that one pid, and used to be left to pid 1. A signal to the process
/// GROUP reaches all of them, the assertion holder included, since it is the sidecar's child: that
/// is what `ProcessGroupKill` sends and why every spawn here gets a group of its own. (Named in
/// plain backticks, not linked: that type is `#[cfg(unix)]` and this constant is not, so an
/// intra-doc link here is a `broken_intra_doc_links` warning on a non-unix doc build.)
pub const CAFFEINATE: &str = "/usr/bin/caffeinate";

/* ── the outcome ──────────────────────────────────────────────────────────────────────────────── */

/// What the engine's exit code meant, classified.
///
/// ⚠ `Delivered` IS WIDER THAN THE WORD SUGGESTS, stated here rather than left to be inferred. For
/// [`Operation::Run`] it means what it says — the envelope's `delivered` is true. For every other
/// operation it means "exit 0, here is the payload": `status` delivers a report, not a briefing.
/// The alternative was a second success variant that every caller would have to handle identically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    /// Exit 0, and (for `run`) the envelope says a briefing was delivered.
    Delivered,
    /// Exit 0 and the envelope says `delivered: false`. `reason` is the envelope's `skipReason`
    /// verbatim — one of `src/json.ts`'s `SKIP_REASONS`, never a string invented here.
    Skipped { reason: Option<String> },
    /// Exit 1, any other non-zero exit, a signal, or output that should have been JSON and was not.
    /// The raw stdout and stderr are retained on [`EngineOutcome`]; nothing is discarded and
    /// nothing panics.
    Failed { reason: Option<String> },
    /// Exit 2 — the engine's refusal code: a bad config, a bad flag, a foreign schedule owner, or a
    /// required confirmation withheld (`docs/gui-seam.md` §3). The stderr text is what explains
    /// which, and it is surfaced verbatim.
    ConfigError,
}

/// One completed invocation. The classification is the small part; the raw material always
/// survives beside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOutcome {
    /// Which operation produced this, by [`Operation::name`].
    pub operation: String,
    pub outcome: Outcome,
    /// `None` when the child was killed by a signal — serialised as `null`, never a fabricated -1.
    pub exit_code: Option<i32>,
    /// The parsed JSON envelope, when the operation produces one and it parsed.
    pub payload: Option<serde_json::Value>,
    /// Everything the engine wrote to stdout, verbatim.
    pub stdout: String,
    /// Everything the engine wrote to stderr, verbatim — the same bytes the progress channel
    /// carried, kept so a caller that missed the events still has them.
    pub stderr: String,
}

/// Every way an invocation can fail before or around the engine, as opposed to *in* it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EngineError {
    /// A caller-supplied operand was refused. **No spawn happened.**
    InvalidInput { field: String, reason: String },
    /// Another state-changing invocation is already in flight in this process. A typed refusal, not
    /// a queue: a second briefing generation must not be *delayed* into happening, it must not
    /// happen.
    Busy { running: String },
    /// The bundled sidecar could not be located beside the executable.
    SidecarUnresolved { detail: String },
    /// The process could not be spawned, or died in a way the OS reported rather than the engine.
    Spawn { detail: String },
    /// v0.3.0 (plan M8): the operation's own bound ([`Operation::timeout`]) passed before the engine
    /// finished, and the invocation was abandoned — its process group killed (`ProcessGroupKill`).
    /// `operation` is [`Operation::name`]; `seconds` the bound that fired.
    Timeout { operation: String, seconds: u64 },
    /// v0.3.0 (plan M8): the operation does not exist on this platform (the Mac Calendar app source
    /// off macOS, [`mac_only`]). **No spawn happened.** The `access.rs` precedent.
    Unsupported { detail: String },
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::InvalidInput { field, reason } => write!(f, "{field} {reason}"),
            EngineError::Busy { running } => {
                write!(f, "an engine {running} is already running")
            }
            EngineError::SidecarUnresolved { detail } => {
                write!(f, "could not locate the bundled engine: {detail}")
            }
            EngineError::Spawn { detail } => write!(f, "could not run the engine: {detail}"),
            EngineError::Timeout { operation, seconds } => write!(
                f,
                "the engine's {operation} did not finish within {seconds} s and was stopped"
            ),
            EngineError::Unsupported { detail } => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for EngineError {}

/* ── the in-flight guard ──────────────────────────────────────────────────────────────────────── */

/// The name of the state-changing operation currently in flight, if any.
///
/// A `std::sync::Mutex` held only across the swap — never across an await — rather than an async
/// mutex, because the whole point is that a second caller is REFUSED rather than parked.
static IN_FLIGHT: Mutex<Option<&'static str>> = Mutex::new(None);

/// RAII: the slot is cleared on every exit path, including a dropped future.
///
/// ⚠ A COMMAND FUTURE IS NEVER DROPPED MID-FLIGHT; ONE CALLER'S IS. A `#[tauri::command] async fn`
/// body runs detached on Tauri's runtime — `respond_async_serialized` hands it to
/// `crate::async_runtime::spawn` (tauri `src/ipc/mod.rs`, via the macro's wrapper) — so a webview
/// that navigates away does not cancel it, and app exit (`AppHandle::exit`, after which tauri's
/// `App::run` ends the process with `std::process::exit`, `src/app.rs`) drops nothing. There is no
/// cancel command. The one shipped caller that DOES drop an invocation is `shell::EngineSnapshots`,
/// whose 30 s read timeout abandons a hung `status`/`schedule status` — a read, which this guard
/// never holds (`is_mutating` is false for both). The guard still clears on drop because a guard
/// that could wedge closed is worse than one whose drop path is rarely taken.
///
/// The guard remembers which operation it holds and clears the slot only if that is still what is
/// there — so a guard whose slot was somehow taken over by a later holder cannot release the later
/// holder's turn on its way out.
struct InFlight {
    name: &'static str,
}

impl InFlight {
    fn try_acquire(op: &Operation) -> Result<Option<Self>, EngineError> {
        if !op.is_mutating() {
            return Ok(None);
        }
        let mut slot = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        match *slot {
            Some(running) => Err(EngineError::Busy {
                running: running.to_string(),
            }),
            None => {
                let name = op.name();
                *slot = Some(name);
                Ok(Some(InFlight { name }))
            }
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        let mut slot = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        if *slot == Some(self.name) {
            *slot = None;
        }
    }
}

/* ── the process-group kill ───────────────────────────────────────────────────────────────────── */

/// RAII: SIGKILLs the child's whole PROCESS GROUP when an abandoned invocation drops it.
///
/// ⚠ WHY A GROUP AND NOT THE SPAWNED PID. `kill_on_drop` signals the pid tokio spawned and nothing
/// else. Under `caffeinate -i` that pid IS the sidecar (see [`CAFFEINATE`]), so the sidecar does
/// die — but a `launchctl list` the sidecar forked is re-parented to pid 1 and runs on. MEASURED
/// before this guard existed, with a fake sidecar that forks rather than `exec`s: the read timed
/// out, the sidecar's pid was gone, its `sleep 41` child was still running.
/// [`EngineClient::invoke`] therefore spawns into a NEW process group and this guard signals the
/// GROUP, which reaches the sidecar, the `caffeinate` assertion holder (the sidecar's own child),
/// and anything else the sidecar started that is still in the group when the drop happens.
///
/// That last qualifier is the honest boundary and it is not a loophole: a drop can only occur
/// while the invocation is still in flight, which means the sidecar has not exited or something
/// holding its pipes has not. A descendant that outlives BOTH — the sidecar gone, its own stdio
/// elsewhere — ends the invocation normally instead, and a normal end deliberately leaves it
/// alone (below).
///
/// ⚠ WHAT MAKES THE SIGNAL SAFE, spelled out because a `killpg` at the wrong id is a SIGKILL to
/// every process in a group this app never created:
///
///   * **The id is the child's own pid.** `process_group(0)` is `setpgid(0, 0)` in the child, so
///     the group's id and the child's pid are one number, and the group holds only this spawn's
///     own descendants.
///   * **That pid cannot have been recycled while the guard is armed**, because the armed window
///     and the un-reaped window are made to be the same window. A pid — hence the group id that
///     equals it — is not reused while the process is still a zombie awaiting its reaper, and
///     `wait()` is what reaps it. So [`EngineClient::invoke`] drains both pipes FIRST and calls
///     `wait()` afterwards, disarming on its return: the child stays un-reaped for as long as
///     anything it started still holds a pipe open. See the comment above that `wait()` for why
///     the obvious ordering — all three in one `join!` — cannot have both this property and the
///     one below. **The `wait()` error paths split**: `ECHILD` means some other reaper took the
///     child, so the pid MAY be free — certainly free only if the group is empty too, which cannot
///     be tested without a race — and the guard gives the group up rather than risk a recycled id.
///     Any OTHER error leaves the child's state genuinely unknown (it may still be running) and
///     keeps the guard armed. The residual on the `ECHILD` path is `kill_on_drop`'s `kill(pid)`,
///     one process wide where this guard is a whole group wide — not the same exposure, which is
///     why the two are treated differently.
///   * **Two ids are refused outright**: anything `<= 1`, and this process's own group whatever
///     its number. MEASURED, because the obvious reading of the first one is wrong and far too
///     reassuring: `killpg(p, s)` is `kill(-p, s)`, so `killpg(1, …)` is `kill(-1, …)` — the
///     BROADCAST form, every process this uid owns, not "init's group". (`killpg(1, 0)` and
///     `kill(1, 0)` both return `EPERM`, and `killpg(-1, 0)` returns `EPERM` where a real empty
///     group returns `ESRCH`.) And `0` means *this process's own group*. So the refusals stand
///     between a mistake here and, respectively, every process the user owns and this app's own
///     group — the app, or the test runner.
///
/// ⚠ A NORMAL EXIT IS NOT A DROP. The guard is disarmed on a completed `wait()`, so an engine run
/// that deliberately left something behind is left alone; only an ABANDONED invocation takes its
/// group with it. The shipped callers that abandon one are the read timeouts
/// (`shell::ENGINE_READ_TIMEOUT`, around `shell::EngineSnapshots` and three other read paths) and,
/// since v0.3.0 (plan M8), the calendar operations' own bounds ([`Operation::timeout`]) — including
/// ONE MUTATING operation, `calendar connect mac` ([`CALENDAR_CONNECT_MAC_TIMEOUT`]); see the
/// `SIGKILL` paragraph below for what that now costs.
///
/// ⚠ AND THE SIGNAL IS `SIGKILL`, WITH NO `SIGTERM` GRACE — a deliberate choice, and one NO TEST
/// PINS: swapping it for `SIGTERM` reddens nothing, because every fake in the suite dies on either.
/// Stated here rather than left to read as covered, on the same footing as
/// [`ProcessGroupKill::is_signalable`]'s refusals. A descendant is therefore killed mid-write —
/// a `git` left with an `index.lock`, a helper interrupted between `tmp` and rename. That is a
/// property of the mechanism rather than a cost the app pays today: the only shipped drop is the
/// read timeout, and the two read operations fork nothing worse than read-only probes
/// (`status --json` is file reads; `schedule status` shells out to `launchctl list` on macOS and
/// `systemctl is-enabled` / `loginctl show-user` on Linux — this guard is unix-wide, not
/// macOS-only, so the inventory has to be too). It would start
/// costing that the moment a MUTATING invocation became droppable — **and since v0.3.0 one is**:
/// `calendar connect mac` is abandoned at [`CALENDAR_CONNECT_MAC_TIMEOUT`], so an engine still
/// copying or re-signing the helper at that moment is killed mid-write. That is accepted there
/// (the constant's docs say why: the long pole is a person answering a dialog) and is the engine's
/// install step's to survive (a staged copy renamed into place, W3's M10b). Under the old single-pid kill
/// descendants were spared only by being orphaned, which is the thing this closes, and a hung read
/// leaving a live `launchctl` behind was judged the worse of the two.
///
/// `pub` for one reason: [`ProcessGroupKill::is_signalable`] is the refusal that stands between a
/// mistake here and a SIGKILL to the app's own group, the two ids it rejects cannot be provoked
/// through [`EngineClient::invoke`] without killing the test runner, and the test that pins them
/// (`tests/engine_client.rs`) is a separate crate. Nothing constructs this outside
/// [`EngineClient::invoke`]. (The prose references elsewhere — `shell::ENGINE_READ_TIMEOUT`,
/// `docs/gui-seam.md` §6/§8/§9 — are plain backticks and would resolve to a private item just as
/// well; they are not a reason.)
#[cfg(unix)]
pub struct ProcessGroupKill {
    /// The group to signal — `None` once disarmed, and `None` when no id could be established that
    /// passes [`ProcessGroupKill::is_signalable`].
    pgid: Option<libc::pid_t>,
}

#[cfg(unix)]
impl ProcessGroupKill {
    /// Arm over `child`'s process group.
    ///
    /// `child.id()` is `None` only once the child has been reaped, which cannot be the case here —
    /// this runs immediately after `spawn`. (It is emphatically NOT true in general that a reaped
    /// child means nothing left to signal: a reaped sidecar whose forked `launchctl` is still
    /// running is the exact case this guard exists for. That is why [`EngineClient::invoke`] is
    /// careful about WHEN the reaping happens.)
    ///
    /// ⚠ THE ID IS A PID, AND ONLY `process_group(0)` MAKES IT A GROUP ID. [`Self::is_signalable`]
    /// cannot tell the difference, so removing that one line in [`EngineClient::invoke`] would
    /// leave this signalling a plain pid interpreted as a group. What catches that is behavioural,
    /// not structural: `tests/watcher.rs`'s
    /// `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked` asserts the sidecar's own
    /// pgid EQUALS its pid, and that the forked child dies — both of which fail without the group.
    fn arm(child: &tokio::process::Child) -> Self {
        Self {
            pgid: child
                .id()
                .and_then(|pid| libc::pid_t::try_from(pid).ok())
                .filter(|pgid| Self::is_signalable(*pgid)),
        }
    }

    /// Whether `pgid` is an id this process may SIGKILL — the refusals in the struct docs, and the
    /// reason the struct is `pub`.
    ///
    /// ⚠ THE TEST THAT PINS THIS PINS THE PREDICATE, NOT ITS WIRING, and the gap is disclosed
    /// rather than papered over: deleting the `.filter(…)` in [`Self::arm`] leaves the whole suite
    /// green, because neither refused id is reachable through [`EngineClient::invoke`] — a spawned
    /// child's pid can be neither `<= 1` nor equal to its parent's process group, which is pinned
    /// for as long as this process is a member of it (a process-group id is reserved for the
    /// group's LIFETIME, not its leader's — an orphaned group whose leader died still holds its
    /// number). That unreachability is the whole reason this predicate is defence against a FUTURE
    /// second construction site, and it is why a behavioural test for it cannot exist without
    /// inventing one.
    pub fn is_signalable(pgid: libc::pid_t) -> bool {
        // SAFETY: `getpgrp` takes no arguments, dereferences nothing, and is defined to succeed.
        let own = unsafe { libc::getpgrp() };
        pgid > 1 && pgid != own
    }

    /// Give up the group: the child exited on its own terms.
    fn disarm(&mut self) {
        self.pgid = None;
    }

    /// SIGKILL the group NOW, then disarm — for an operation that must not leave descendants
    /// behind even when it returns normally ([`Operation::kills_its_group_on_return`]).
    ///
    /// ⚠ CALLED BEFORE `wait()`, NEVER AFTER: the same un-reaped window the drop path relies on
    /// (the struct docs) is what keeps the id from having been recycled. [`EngineClient::invoke`]
    /// calls this once both pipes are at EOF — the engine has closed its stdio, i.e. it is exiting
    /// or a zombie — and only then reaps it, so its exit status is the one it chose (a SIGKILL sent
    /// to a process already in its exit path does not replace that status; `tests/engine_client.rs`
    /// asserts exit 0 survives this).
    fn kill_now(&mut self) {
        self.signal();
        self.disarm();
    }

    fn signal(&self) {
        if let Some(pgid) = self.pgid {
            // SAFETY: as in `Drop` below — two integers, nothing dereferenced, and the id is the
            // un-reaped child's own group.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupKill {
    fn drop(&mut self) {
        if let Some(pgid) = self.pgid {
            // SAFETY: `killpg` takes two integers, dereferences nothing, and cannot invalidate
            // anything Rust owns. Why this id is the right one, and why it cannot have been
            // recycled, is the struct's doc comment.
            //
            // The return value is deliberately ignored, and the errnos are MEASURED rather than
            // guessed — `ESRCH` is the obvious guess and is the one that essentially cannot happen
            // here. While the guard is armed the child is by construction un-reaped, so the group
            // always still has a member: the outcome is `0` when something in it was signalled, and
            // `EPERM` on macOS when the only member left is the zombie leader (measured: zombie-only
            // group → EPERM; the same id after reaping → ESRCH; a live member → 0). `ESRCH` would
            // mean the child had already been reaped, which is the state this guard disarms in. All
            // are benign and a drop has no one to report to — but a future
            // `if errno != ESRCH { log }` would fire on every ordinary timeout.
            unsafe {
                libc::killpg(pgid, libc::SIGKILL);
            }
        }
    }
}

/* ── the progress channel ─────────────────────────────────────────────────────────────────────── */

/// Where a stderr line goes while the engine is still running.
///
/// ⚠ STDERR ONLY, and VERBATIM. The engine's diagnostics are the user-facing explanation of what
/// it is doing and why it stopped; paraphrasing them in the shell would mean maintaining a second,
/// worse copy of every message. Stdout is not streamed: for the JSON operations it is one envelope
/// that means nothing until it is complete, and for the others it is narration the caller gets in
/// [`EngineOutcome::stdout`] anyway.
pub trait ProgressSink: Send + Sync {
    fn stderr_line(&self, operation: &str, line: &str);
}

/// A sink that drops everything — the read-only operations, and any caller that does not want the
/// events.
pub struct NoProgress;

impl ProgressSink for NoProgress {
    fn stderr_line(&self, _operation: &str, _line: &str) {}
}

/// The payload of an `engine:progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub operation: String,
    /// One stderr line, with its terminator removed and nothing else changed.
    pub line: String,
}

/// The shipping sink: emits `engine:progress` to the webview.
pub struct AppProgress<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AppProgress<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> ProgressSink for AppProgress<R> {
    fn stderr_line(&self, operation: &str, line: &str) {
        // A failed emit is not a reason to fail the run: the briefing matters, the progress line
        // does not. The line still reaches the caller in `EngineOutcome::stderr`.
        let _ = self.app.emit(
            "engine:progress",
            ProgressEvent {
                operation: operation.to_string(),
                line: line.to_string(),
            },
        );
    }
}

/* ── the client ───────────────────────────────────────────────────────────────────────────────── */

/// The sidecar, and the environment it is spawned into.
///
/// ⚠ THE PROGRAM IS NEVER CALLER-SUPPLIED. [`EngineClient::bundled`] resolves it from the
/// executable's own directory; [`EngineClient::with_program`] exists for the test harness. No
/// `#[tauri::command]` in this module takes a program, a path to one, an environment, or a working
/// directory — which is the property the shell plugin could not give us (it forwarded frontend
/// `cwd` and `env` straight to the child).
#[derive(Debug, Clone)]
pub struct EngineClient {
    program: PathBuf,
    path_env: Option<String>,
    caffeinate: PathBuf,
    extra_env: Vec<(OsString, OsString)>,
    /// **Test harness only** ([`EngineClient::with_timeout_cap`]): an upper limit on every
    /// [`Operation::timeout`], so a test can watch a 150 s bound fire in milliseconds. `None` in
    /// the app.
    timeout_cap: Option<Duration>,
}

impl EngineClient {
    /// The bundled sidecar, resolved the way `tauri-plugin-shell` resolves it.
    pub fn bundled() -> Result<Self, EngineError> {
        Ok(Self::with_program(bundled_sidecar_path()?))
    }

    /// A client over an explicit program. **Test harness only** — see the struct docs.
    pub fn with_program(program: PathBuf) -> Self {
        Self {
            program,
            path_env: None,
            caffeinate: PathBuf::from(CAFFEINATE),
            extra_env: Vec::new(),
            timeout_cap: None,
        }
    }

    /// Cap every operation's own bound at `cap`. **Test harness only** — it is what lets a test
    /// prove [`Operation::timeout`] is APPLIED (the fake is killed and [`EngineError::Timeout`]
    /// comes back) without waiting 150 s. An operation whose timeout is `None` stays unbounded: the
    /// cap shortens a bound, it never invents one.
    pub fn with_timeout_cap(mut self, cap: Duration) -> Self {
        self.timeout_cap = Some(cap);
        self
    }

    /// The bound [`EngineClient::invoke`] applies to `op`: [`Operation::timeout`], shortened by the
    /// harness cap when one is set.
    pub fn effective_timeout(&self, op: &Operation) -> Option<Duration> {
        op.timeout().map(|bound| match self.timeout_cap {
            Some(cap) => bound.min(cap),
            None => bound,
        })
    }

    /// Override the PATH applied to every spawn.
    ///
    /// No Settings field feeds this: B5's T15 writes the engine's USER config only (plan R1), and the
    /// spawn PATH is an app setting (`docs/gui-seam.md` §10g, deviation 51). The parameter exists
    /// so a later field is a wiring change rather than a redesign, and so a test can assert an
    /// override is honoured.
    pub fn with_path_override(mut self, path: impl Into<String>) -> Self {
        self.path_env = Some(path.into());
        self
    }

    /// Point the caffeinate wrapper somewhere else. **Test harness only**: it is what lets a test
    /// exercise the missing-caffeinate fallback without removing a system binary.
    pub fn with_caffeinate_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.caffeinate = path.into();
        self
    }

    /// Add one environment variable to the child. **Test harness only** — this is how a test
    /// points the engine at a sandbox (`DAILY_BRIEFING_STATE_DIR`, `XDG_CONFIG_HOME`). Nothing the
    /// webview sends reaches here.
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.extra_env.push((key.into(), value.into()));
        self
    }

    /// The program that is actually executed, and the argv it receives — caffeinate wrapping
    /// included. Split out of [`EngineClient::invoke`] so a test can assert the composition
    /// without spawning anything.
    pub fn command_line(&self, op: &Operation) -> (PathBuf, Vec<String>) {
        let argv = op.argv();
        if cfg!(target_os = "macos") {
            if self.caffeinate.exists() {
                let mut wrapped = Vec::with_capacity(argv.len() + 2);
                wrapped.push("-i".to_string());
                wrapped.push(self.program.to_string_lossy().into_owned());
                wrapped.extend(argv);
                return (self.caffeinate.clone(), wrapped);
            }
            // ⚠ FALL BACK, NEVER FAIL. A machine without `/usr/bin/caffeinate` can still produce a
            // briefing; it just might idle to sleep during a long provider call. Refusing to run
            // would turn a degradation into an outage.
            eprintln!(
                "daily-briefing: {} is missing — spawning the engine directly. A long provider \
                 call may be interrupted by idle sleep.",
                self.caffeinate.display()
            );
        }
        (self.program.clone(), argv)
    }

    /// The environment the child gets: cleared, then [`forwarded_env`] from this process, then
    /// PATH, then [`BUN_CRASH_REPORTING_OFF`], then the harness overrides.
    ///
    /// ⚠ PATH IS SET LAST AMONG THE INHERITED ONES AND IS NEVER FORWARDED. That ordering is the
    /// whole of T9's first half: inheriting the developer's shell PATH is the failure that does not
    /// reproduce in development and only ever bites the stranger.
    pub fn env_plan(&self) -> Vec<(OsString, OsString)> {
        let mut plan: Vec<(OsString, OsString)> = Vec::new();
        for key in forwarded_env() {
            if let Some(value) = std::env::var_os(key) {
                plan.push((OsString::from(key), value));
            }
        }
        let path = self
            .path_env
            .clone()
            .unwrap_or_else(|| launchd_path(&home_dir()));
        plan.push((OsString::from("PATH"), OsString::from(path)));
        let (key, value) = BUN_CRASH_REPORTING_OFF;
        plan.push((OsString::from(key), OsString::from(value)));
        plan.extend(self.extra_env.iter().cloned());
        plan
    }

    /// Spawn, stream, classify.
    ///
    /// Everything this future owns — the child, both pipe readers, the in-flight guard — is owned
    /// by the future itself rather than by detached tasks, so dropping it drops all of them.
    ///
    /// ⚠ WHAT A DROP ACTUALLY KILLS, measured rather than inferred from the command line. On macOS
    /// the spawned pid is the SIDECAR — `caffeinate -i` `exec`s the utility into its own pid and
    /// forks the assertion holder as the utility's child (see [`CAFFEINATE`]). `kill_on_drop`
    /// signals THAT PID and no other, which used to leave the sidecar's OWN children — git, the
    /// provider CLI, an `apiKeyCommand` helper, a `launchctl list` — running as orphans of pid 1.
    /// On unix the spawn is now put in a process group of its own (`process_group(0)`) and
    /// `ProcessGroupKill` SIGKILLs that group on the drop, so the children go with it; that
    /// guard's docs carry why the id it signals is safe (plain backticks for the same
    /// `#[cfg(unix)]` reason as [`CAFFEINATE`]). Non-unix keeps `kill_on_drop` alone.
    ///
    /// Where a drop is actually reached: command bodies run detached on Tauri's runtime and are
    /// never dropped (see [`InFlight`]), but `shell::EngineSnapshots` drops a READ that exceeds its
    /// 30 s timeout — so a timed-out `schedule status`, and anything it forked, are killed together
    /// (`tests/watcher.rs`, `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked`). A
    /// generation is never dropped this way; if one ever outlives its caller that is the engine's
    /// own concern — its `run.lock` (`src/runlock.ts`) refuses a second generation while one is
    /// still running, and it does not care who the first one's parent was.
    ///
    /// ⚠ v0.3.0 (plan M8): AN OPERATION WITH ITS OWN BOUND IS DROPPED HERE. When
    /// [`Operation::timeout`] is `Some` (the four calendar operations), the invocation runs under
    /// `tokio::time::timeout` and, when the bound passes, the inner future — child, pipe readers,
    /// in-flight guard and process-group kill — is dropped exactly as a read timeout drops one, and
    /// the answer is [`EngineError::Timeout`]. `None` (every pre-M8 operation) is the unchanged path.
    pub async fn invoke(
        &self,
        op: Operation,
        sink: &dyn ProgressSink,
    ) -> Result<EngineOutcome, EngineError> {
        self.invoke_inner(op, None, sink).await
    }

    /// [`EngineClient::invoke`] for the one operation that reads a KEY on stdin,
    /// [`Operation::KeySet`] (PR 3, P3-M1-T1).
    ///
    /// ⚠ THE KEY IS A SEPARATE ARGUMENT, NEVER PART OF THE OPERATION — see [`KeySecret`]. It is
    /// written to the child's stdin and the pipe closed (the engine requires stdin to END within
    /// 1 s); it is in no argv, no environment, no `Debug` and no answer. An operation that does not
    /// take a key is refused with one, and `KeySet` is refused without one — both BEFORE any spawn.
    pub async fn invoke_with_key(
        &self,
        op: Operation,
        key: KeySecret,
        sink: &dyn ProgressSink,
    ) -> Result<EngineOutcome, EngineError> {
        self.invoke_inner(op, Some(key), sink).await
    }

    /// The live details read, `calendar details --json` (wave-2 plan C-M3-T7): the SEALED path.
    ///
    /// ⚠ NO `EngineOutcome`, NO PROGRESS SINK, NO STDERR TEXT. The spawn, the stdin write, the
    /// drain, the process-group kill and the wait are [`EngineClient::invoke`]'s own body
    /// (`invoke_unbounded_with`); only the collector differs: stdout is parsed into
    /// [`DetailsRaw`] inside Rust and its buffer zeroed, stderr is reduced to a fixed
    /// [`DetailsFailure`] code, and stderr lines go to [`NoProgress`]. The handback is written to the
    /// child's stdin and the pipe closed. Any `op` other than [`Operation::CalendarDetails`] is
    /// refused before any spawn, as `invoke` refuses `CalendarDetails` (it takes a handback).
    /// Bounded by [`EngineClient::effective_timeout`], under the same [`EngineError::Timeout`].
    ///
    /// One production caller: `calendar_details.rs` (`tests/capability.rs` pins it).
    pub async fn invoke_sealed(
        &self,
        op: Operation,
        handback: LinkHandback,
    ) -> Result<Result<DetailsRaw, DetailsFailure>, EngineError> {
        if !matches!(op, Operation::CalendarDetails { .. }) {
            return Err(EngineError::InvalidInput {
                field: "handback".into(),
                reason: format!("is not an input of {}", op.name()),
            });
        }
        let bound = self.effective_timeout(&op);
        let operation = op.name();
        let stdin = Some(StdinPayload::Links(handback));
        self.within_bound(
            bound,
            operation,
            self.invoke_unbounded_with(op, stdin, &NoProgress, SealedDetails),
        )
        .await
    }

    async fn invoke_inner(
        &self,
        op: Operation,
        key: Option<KeySecret>,
        sink: &dyn ProgressSink,
    ) -> Result<EngineOutcome, EngineError> {
        // Wave 2 (C-M3-T7): the live details read takes a handback and runs only sealed.
        if matches!(op, Operation::CalendarDetails { .. }) {
            return Err(EngineError::InvalidInput {
                field: "handback".into(),
                reason: "is required for this operation".into(),
            });
        }
        let stdin = match (op.takes_key(), key, op.stdin_payload()) {
            (true, Some(key), None) => Some(StdinPayload::Key(key)),
            (false, None, payload) => payload.map(StdinPayload::Operand),
            (true, None, _) => {
                return Err(EngineError::InvalidInput {
                    field: "key".into(),
                    reason: "is required for this operation".into(),
                })
            }
            // A key for an operation that reads none, or an operation that would supply its own
            // stdin AND a key: refused, never merged.
            (_, Some(_), _) => {
                return Err(EngineError::InvalidInput {
                    field: "key".into(),
                    reason: format!("is not an input of {}", op.name()),
                })
            }
        };
        let bound = self.effective_timeout(&op);
        let operation = op.name();
        self.within_bound(
            bound,
            operation,
            self.invoke_unbounded_with(op, stdin, sink, Classify),
        )
        .await
    }

    /// `answer` under `bound` when there is one: past it, the future — child, pipe readers,
    /// in-flight guard and process-group kill — is dropped and the answer is
    /// [`EngineError::Timeout`]. `None` awaits it unbounded (every pre-M8 operation).
    async fn within_bound<T>(
        &self,
        bound: Option<Duration>,
        operation: &'static str,
        answer: impl std::future::Future<Output = Result<T, EngineError>>,
    ) -> Result<T, EngineError> {
        match bound {
            None => answer.await,
            Some(bound) => match tokio::time::timeout(bound, answer).await {
                Ok(answer) => answer,
                Err(_) => Err(EngineError::Timeout {
                    operation: operation.to_string(),
                    // Whole seconds for the sentence; a sub-second harness cap reads as 0.
                    seconds: bound.as_secs(),
                }),
            },
        }
    }

    /// [`EngineClient::invoke`] without the per-operation bound: spawn, stream, collect.
    ///
    /// ⚠ ONE BODY, TWO COLLECTORS (wave-2 plan C-M3-T7: factored, not copied): [`Classify`] is
    /// today's path, unchanged (`classify` builds the [`EngineOutcome`]); [`SealedDetails`] is the
    /// live details read's, which parses stdout inside Rust and keeps no text. Everything else —
    /// the in-flight guard, the spawn, the stdin write, the drain, the process-group kill and the
    /// wait — is this one body for both.
    async fn invoke_unbounded_with<C: Collect>(
        &self,
        op: Operation,
        stdin: Option<StdinPayload>,
        sink: &dyn ProgressSink,
        collector: C,
    ) -> Result<C::Out, EngineError> {
        let _guard = InFlight::try_acquire(&op)?;

        let (program, argv) = self.command_line(&op);
        let mut cmd = tokio::process::Command::new(&program);
        cmd.args(&argv)
            .env_clear()
            .envs(self.env_plan())
            // `/dev/null` unless this operation reads stdin (PR 3: `key set`'s key, `reset
            // --label-stdin`'s label). A piped stdin is written and CLOSED inside the drain below,
            // before `wait()` — see the ordering note there.
            .stdin(if stdin.is_some() {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            // ⚠ KEPT, THOUGH THE UNIX SUITE NO LONGER PINS IT: on unix every drop the tests
            // exercise is now covered by the group kill, so deleting this stays green. It is the
            // only mechanism on non-unix, and the stated residual on the `ECHILD` path below.
            .kill_on_drop(true);
        // ⚠ ITS OWN PROCESS GROUP, so an abandoned invocation can take what the sidecar forked with
        // it rather than only the sidecar — see [`ProcessGroupKill`]. `0` means "the child's own
        // pid becomes the group's id", which is what makes the id safe to signal later.
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().map_err(|e| EngineError::Spawn {
            detail: format!("{}: {e}", program.display()),
        })?;
        // ⚠ ARMED HERE, AND DECLARED AFTER `child` — both halves are load-bearing. Locals drop in
        // reverse declaration order, so this guard's `killpg` runs BEFORE the `Child` is dropped
        // and reaped, which is what keeps the group id from being recycled out from under the
        // signal. Arming before the pipes are taken means the `?`s below kill the group too.
        #[cfg(unix)]
        let mut group = ProcessGroupKill::arm(&child);
        // Both pipes were configured above, so neither `take` can be `None`; the `ok_or` is here so
        // a future refactor that drops a `.stdout(piped())` fails as an error rather than a panic.
        let stdout = child.stdout.take().ok_or_else(|| EngineError::Spawn {
            detail: "the child has no stdout pipe".into(),
        })?;
        let stderr = child.stderr.take().ok_or_else(|| EngineError::Spawn {
            detail: "the child has no stderr pipe".into(),
        })?;
        // `None` exactly when `stdin` is: the pipe is configured above only when there is a payload.
        let stdin_pipe = child.stdin.take();

        let name = op.name();
        // ⚠ THE PIPES ARE DRAINED FIRST AND `wait()` COMES AFTER, WHICH IS THE WHOLE SAFETY
        // ARGUMENT — it is not the obvious ordering, and joining all three (the earlier shape)
        // breaks it two different ways depending on where the guard is disarmed.
        //
        // `wait()` REAPS the child the moment it returns; tokio says so itself (`Child::id`: "Once
        // the child has been polled to completion this will return None … the OS identifier could
        // be reused once the process has completed"). A reaped pid is a reusable pid, and this
        // guard's id IS that pid. Meanwhile the two readers run to EOF, which a descendant that
        // inherited the pipes holds open after the sidecar itself is gone (MEASURED:
        // `/bin/sh -c 'sleep 3 & exit 0' | cat` takes 3 s).
        //
        // So: reaping inside the join and disarming AFTER it leaves the guard armed over a reaped
        // pid. How wide that window is depends on the group: an id stays pinned while the group
        // still has members, so the exposure needs a pipe-holder that has LEFT the group (a
        // `setsid` daemon, or an fd handed to an unrelated process) — narrow, but the failure is a
        // `killpg` of a group this app never created, including a concurrent read's. Reaping
        // inside the join and disarming THERE is safe but gives the descendant back its orphan:
        // the guard is already disarmed when the timeout fires. Draining first removes the window
        // entirely AND keeps the kill. The child stays an un-reaped zombie — pid pinned, therefore
        // process-group id pinned — for exactly as long as anything it started still holds a pipe,
        // which is exactly as long as the group is still worth killing.
        //
        // ⚠ AND THE ORDERING DEPENDS ON STDIN BEING CLOSED INSIDE THE DRAIN. tokio's `wait()` drops
        // the child's stdin first, precisely to avoid the deadlock where a child blocks on input
        // the parent never closes (`tokio::process`, `Child::wait`); with `wait()` moved after the
        // readers, a stdin pipe still open here would deadlock on a pipe only that `wait()`
        // closes. So since PR 3 the stdin pipe (present only for an operation that reads one) was
        // TAKEN above and is written AND DROPPED by `write_stdin`, joined with the two readers —
        // concurrently, so a payload larger than the pipe buffer cannot deadlock against an engine
        // that writes before it reads. Without a payload the stdin is `null()`, as before.
        // `tests/watcher.rs`'s `a_timed_out_read_kills_a_child_that_outlived_the_sidecar` is what
        // pins the drain-then-wait ordering.
        let ((), out, err) = tokio::join!(
            write_stdin(stdin_pipe, stdin),
            read_all(stdout),
            stream_stderr(stderr, name, sink)
        );
        // ⚠ PR 3 (P2-M4 checkpoint, into P3): `provider test` takes its process group with it even
        // on a NORMAL return — a CLI Test's backgrounded grandchild can outlive the engine. HERE,
        // after the drain and BEFORE `wait()`: the child is un-reaped, so its pid — the group id —
        // is pinned (see `ProcessGroupKill::kill_now`). The group is the engine's own because
        // `process_group(0)` above made the child its leader.
        #[cfg(unix)]
        if op.kills_its_group_on_return() {
            group.kill_now();
        }
        let status = child.wait().await;
        // ⚠ `ECHILD` GIVES THE GROUP UP; EVERY OTHER ERROR KEEPS IT. Another error leaves the
        // child's state unknown — it may well still be running — so the guard stays armed and the
        // `?` below takes the group with the dropped future. `ECHILD` means something else already
        // reaped the child, and the honest statement is that the pid MAY then be free: a
        // process-group id is pinned for the group's LIFETIME, so it is certainly free only if the
        // group is also empty, which cannot be tested cheaply or without a race. This path
        // therefore gives up a kill that might still have been correct, rather than risk
        // `killpg`ing a recycled id — and with every spawn now a group leader whose pgid equals
        // its pid, the likeliest owner of a recycled one is this app's own concurrent read
        // (`shell.rs`: the watcher's reads and `state_snapshot`'s overlap). The residual is
        // `kill_on_drop`'s `kill(pid)`: one process wide, where this guard is a group wide.
        //
        // ⚠ NOTHING TESTS THIS ARM, and that is said rather than left to be assumed: deleting it
        // leaves the suite green, because `ECHILD` needs a foreign reaper (a `waitpid(-1)` or
        // `SIGCHLD → SIG_IGN` elsewhere in the process) and this app has none. It is defence
        // against a future one — the same standing as [`ProcessGroupKill::is_signalable`]'s
        // refusals.
        #[cfg(unix)]
        match &status {
            Ok(_) => group.disarm(),
            Err(e) if e.raw_os_error() == Some(libc::ECHILD) => group.disarm(),
            Err(_) => {}
        }
        let status = status.map_err(|e| EngineError::Spawn {
            detail: format!("waiting for the engine failed: {e}"),
        })?;

        Ok(collector.collect(&op, status.code(), out, err))
    }
}

/* ── the collectors (wave 2, C-M3-T7) ─────────────────────────────────────────────────────────── */

/// What an invocation's exit code and output become. Two implementations: [`Classify`] (every
/// operation but one) and [`SealedDetails`] (the live details read).
trait Collect {
    type Out;
    fn collect(self, op: &Operation, code: Option<i32>, stdout: Vec<u8>, stderr: Vec<u8>)
        -> Self::Out;
}

/// Today's collector: [`classify`], unchanged.
struct Classify;

impl Collect for Classify {
    type Out = EngineOutcome;
    fn collect(
        self,
        op: &Operation,
        code: Option<i32>,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    ) -> EngineOutcome {
        classify(op, code, stdout, stderr)
    }
}

/// The live details read's collector: stdout parsed into [`DetailsRaw`] and its buffer zeroed;
/// stderr reduced to a fixed [`DetailsFailure`] code and zeroed. No raw child output is returned.
/// This wipes the final buffers only on normal collection. On timeout (dropped reader futures) or
/// a `child.wait()` error (early return), stdout/stderr drop unwiped. Stderr's temporary buffers and
/// earlier allocations freed by growth are also outside this best-effort wipe (see [`SecretBytes`]).
///
/// ⚠ NO `Debug`, `Clone` OR `Serialize` (the grep test in `tests/engine_client.rs`).
struct SealedDetails;

impl Collect for SealedDetails {
    type Out = Result<DetailsRaw, DetailsFailure>;
    fn collect(
        self,
        _op: &Operation,
        code: Option<i32>,
        mut stdout: Vec<u8>,
        mut stderr: Vec<u8>,
    ) -> Result<DetailsRaw, DetailsFailure> {
        let answer = match code {
            Some(0) => DetailsRaw::parse(&stdout),
            _ => Err(DetailsFailure::from_exit(code, &stderr)),
        };
        wipe_bytes(&mut stdout);
        wipe_bytes(&mut stderr);
        answer
    }
}

/// Why the live details read gave no document. A FIXED CODE: no variant holds text from the child
/// (its stderr may echo what it read, and a parse error can quote a value), so it may be printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailsFailure {
    /// Exit 0, but stdout was not the sealed document.
    Malformed,
    /// The engine's own fixed codes (`src/calendar/details.ts`, `failed`), recognised only when its
    /// stderr is exactly `calendar details: <code>`.
    BadArguments,
    StdinTooLarge,
    StdinInvalid,
    ConfigUnreadable,
    Internal,
    /// Any other non-zero exit (`None`: killed by a signal).
    Exit(Option<i32>),
}

impl DetailsFailure {
    fn from_exit(code: Option<i32>, stderr: &[u8]) -> Self {
        let text = std::str::from_utf8(stderr).unwrap_or("").trim_end();
        match text.strip_prefix("calendar details: ") {
            Some("bad-arguments") => DetailsFailure::BadArguments,
            Some("stdin-too-large") => DetailsFailure::StdinTooLarge,
            Some("stdin-invalid") => DetailsFailure::StdinInvalid,
            Some("config-unreadable") => DetailsFailure::ConfigUnreadable,
            Some("internal") => DetailsFailure::Internal,
            _ => DetailsFailure::Exit(code),
        }
    }
}

/// The live details read's answer, parsed inside Rust (`src/calendar/details.ts`'s
/// `CalendarDetailsJson`, or its `{ schemaVersion: 1, refused: "calendar-off" }`).
///
/// ⚠ NO `Debug`, `Display`, `Clone` OR `Serialize`, AND NEITHER HAS ANYTHING IT HOLDS (probed and
/// grepped): it carries meeting links, people, notes and the remembered command-link URLs. Its
/// parts are read by `calendar_details.rs` only, which keeps them in Rust memory.
pub struct DetailsRaw(DetailsDoc);

enum DetailsDoc {
    CalendarOff,
    Read(DetailsRead),
}

/// One answered read. `pub(crate)` for `calendar_details.rs`, which turns it into its held state.
pub(crate) struct DetailsRead {
    pub(crate) read_at: String,
    pub(crate) events: Vec<RawEvent>,
    pub(crate) sources: Vec<RawSource>,
    pub(crate) reader_outdated: bool,
    pub(crate) links: Vec<RawLink>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawEvent {
    pub(crate) title: String,
    pub(crate) location: Option<String>,
    pub(crate) row_text: String,
    /// `CalendarStructEvent["time"]`, passed to the webview as it is (no secret: instants and dates).
    pub(crate) time: serde_json::Value,
    pub(crate) status: String,
    pub(crate) ended: bool,
    pub(crate) from_mac: bool,
    /// `None` when the engine could not retain the raw details; `Some([])` is a known empty list.
    pub(crate) people: Option<Vec<RawPerson>>,
    pub(crate) notes: Option<String>,
    /// A near-duplicate merge's other views' cleaned notes, core excluded (`CalendarDetailsEvent["otherNotes"]`).
    /// Absent on an unmerged or older event; serde reads a missing `Option` as `None`.
    pub(crate) other_notes: Option<Vec<RawOtherNote>>,
    pub(crate) join: Option<RawJoin>,
}

#[derive(serde::Deserialize)]
pub(crate) struct RawPerson {
    pub(crate) name: Option<String>,
    pub(crate) organiser: bool,
}

/// One `otherNotes` entry: `title` is null when it equals the shown title; `notes` may be empty.
#[derive(serde::Deserialize)]
pub(crate) struct RawOtherNote {
    pub(crate) title: Option<String>,
    pub(crate) notes: String,
}

/// `src/calendar/join.ts`'s `JoinCandidate`.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum RawJoin {
    Known {
        url: String,
        host: String,
    },
    Other {
        url: String,
        host: String,
    },
    Service {
        url: String,
        host: String,
        #[serde(rename = "serviceName")]
        service_name: String,
    },
    Several,
}

/// `{ id, kind, status, reason? }` or `{ id, kind, skipped: true }`; never both.
#[derive(serde::Deserialize)]
pub(crate) struct RawSource {
    /// Whether this link uses a command; env/file links have no command report entry.
    #[serde(default)]
    pub(crate) command: bool,
    pub(crate) id: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) status: Option<String>,
    #[serde(default)]
    pub(crate) reason: Option<String>,
    #[serde(default)]
    pub(crate) skipped: bool,
}

/// One command-sourced link's report: `{ id, entryHash, url? }` (`url` absent for a dead link or
/// a command that gave none).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawLink {
    pub(crate) id: String,
    pub(crate) entry_hash: String,
    #[serde(default)]
    pub(crate) url: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRead {
    schema_version: u32,
    read_at: String,
    events: Vec<RawEvent>,
    sources: Vec<RawSource>,
    reader_outdated: bool,
    links: Vec<RawLink>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRefused {
    schema_version: u32,
    refused: String,
}

impl DetailsRaw {
    /// The one parse of the sealed document. One production caller: [`SealedDetails`]; the
    /// integration tests build canned values with it (`tests/capability.rs` pins the caller).
    ///
    /// ⚠ A REFUSAL IS THE FIXED [`DetailsFailure::Malformed`], NEVER THE PARSER'S ERROR: a serde
    /// message can quote the offending value, which here can be a URL.
    pub fn parse(stdout: &[u8]) -> Result<DetailsRaw, DetailsFailure> {
        if let Ok(r) = serde_json::from_slice::<WireRefused>(stdout) {
            return if r.schema_version == 1 && r.refused == "calendar-off" {
                Ok(DetailsRaw(DetailsDoc::CalendarOff))
            } else {
                Err(DetailsFailure::Malformed)
            };
        }
        let w: WireRead =
            serde_json::from_slice(stdout).map_err(|_| DetailsFailure::Malformed)?;
        if w.schema_version != 1 {
            return Err(DetailsFailure::Malformed);
        }
        if w.sources.iter().any(|s| s.skipped == s.status.is_some()) {
            return Err(DetailsFailure::Malformed);
        }
        Ok(DetailsRaw(DetailsDoc::Read(DetailsRead {
            read_at: w.read_at,
            events: w.events,
            sources: w.sources,
            reader_outdated: w.reader_outdated,
            links: w.links,
        })))
    }

    /// The engine refused because the calendar is off (`{ refused: "calendar-off" }`).
    pub fn calendar_off(&self) -> bool {
        matches!(self.0, DetailsDoc::CalendarOff)
    }

    /// The answered read, or `None` for the calendar-off refusal. For `calendar_details.rs`.
    pub(crate) fn into_read(self) -> Option<DetailsRead> {
        match self.0 {
            DetailsDoc::CalendarOff => None,
            DetailsDoc::Read(read) => Some(read),
        }
    }
}

/// Where the bundled sidecar sits at runtime.
///
/// ⚠ REPLICATED FROM `tauri-plugin-shell`, NOT CALLED INTO IT, and the reason is T9. The plugin's
/// Rust-side API (`Shell::sidecar`, `lib.rs:67-69` → `Command::new_sidecar`) does bypass the IPC
/// scope entirely — the scope only exists inside `commands.rs`'s `prepare_cmd` (`:99-146`), which
/// is reached from the `execute`/`spawn` IPC handlers and nowhere else — so it would have been a
/// legitimate way to resolve the path. But `Command::new_sidecar` fixes the child's PROGRAM to the
/// sidecar, and caffeinate wrapping needs the program to be `/usr/bin/caffeinate` with the sidecar
/// as an argument. The plugin's `Command` exposes no way to change that, so the path is resolved
/// here and the spawn is ours.
///
/// The resolution itself is `relative_command_path` (`process/mod.rs:120-151`): the directory of
/// `tauri::utils::platform::current_exe()`, hopping up one level when it is `deps/` (a `cargo test`
/// binary), joined with the sidecar's file name — the LAST component of the `externalBin` entry, as
/// `scope.rs:303-313` takes it — plus `.exe` on Windows. `tauri_build::build()` is what puts the
/// file there: it copies `binaries/daily-briefing-<triple>` to `target/<profile>/daily-briefing`
/// and refuses to compile the crate when the source is missing.
///
/// ⚠ AND THE PATH IS STATTED, because the spawn cannot tell a missing sidecar from a failing one.
/// MEASURED: on macOS the caffeinate-wrapped spawn of a nonexistent program does not fail — the
/// program that `Command::spawn` starts is `/usr/bin/caffeinate`, which exists, and it is
/// caffeinate's `exec` that fails, so the result is an ordinary `Failed { reason: "exit-127" }`
/// with `No such file or directory` on stderr. Statting here is what turns "the sidecar is not
/// there" into [`EngineError::SidecarUnresolved`] with the path in it, at startup, rather than an
/// exit code the user has to decode after clicking.
///
/// ⚠ AND EXISTENCE IS NOT ENOUGH — see [`resolve_sidecar`]. MEASURED: a DIRECTORY at the sidecar
/// path, and a regular file with mode `0o644`, both passed the bare existence stat and both then
/// produced `Failed { reason: "exit-126" }` with `daily-briefing: Permission denied` — i.e.
/// exactly the undecodable exit code the stat exists to prevent, one class over.
pub fn bundled_sidecar_path() -> Result<PathBuf, EngineError> {
    let exe =
        tauri::utils::platform::current_exe().map_err(|e| EngineError::SidecarUnresolved {
            detail: format!("current_exe: {e}"),
        })?;
    resolve_sidecar(&exe)
}

/// [`sidecar_path_beside`] plus the stat. Split from [`bundled_sidecar_path`] so a test can point
/// it at a directory it controls rather than at the test binary's own.
///
/// The stat requires a REGULAR, EXECUTABLE file, not merely an existing path, and the detail says
/// which of the three it was. `metadata` follows symlinks, so a symlinked sidecar is judged by its
/// target — which is what `execve` will do too.
pub fn resolve_sidecar(exe: &Path) -> Result<PathBuf, EngineError> {
    let path = sidecar_path_beside(exe)?;
    let meta = std::fs::metadata(&path).map_err(|e| EngineError::SidecarUnresolved {
        detail: format!("{}: {e}", path.display()),
    })?;
    if !meta.is_file() {
        return Err(EngineError::SidecarUnresolved {
            detail: format!(
                "{}: not a regular file (it is a {})",
                path.display(),
                if meta.is_dir() {
                    "directory"
                } else {
                    "special file"
                }
            ),
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            return Err(EngineError::SidecarUnresolved {
                detail: format!(
                    "{}: not executable (mode {:04o})",
                    path.display(),
                    mode & 0o7777
                ),
            });
        }
    }
    Ok(path)
}

/// Where the sidecar WOULD be for an executable at `exe` — the pure half of the resolution, with
/// no filesystem access.
pub fn sidecar_path_beside(exe: &Path) -> Result<PathBuf, EngineError> {
    let dir = exe.parent().ok_or_else(|| EngineError::SidecarUnresolved {
        detail: format!("{} has no parent directory", exe.display()),
    })?;
    let base = if dir.ends_with("deps") {
        dir.parent().unwrap_or(dir)
    } else {
        dir
    };
    let name = if cfg!(windows) {
        "daily-briefing.exe"
    } else {
        "daily-briefing"
    };
    Ok(base.join(name))
}

/// The user's home directory, read the same way the engine reads it (`os.homedir()` → `$HOME` on
/// POSIX). Falling back to `/` rather than failing: a missing `HOME` is a broken session, and a
/// PATH of `/.local/bin:…` still finds `/usr/bin/git` — which is a worse briefing, not no app.
fn home_dir() -> PathBuf {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// What a spawn writes to the engine's stdin: the operation's own operand (a reset label), or the
/// separate key secret. Never both — [`EngineClient::invoke_with_key`] refuses that before a spawn.
enum StdinPayload {
    Operand(Vec<u8>),
    Key(KeySecret),
    /// The live details read's handback (wave 2, C-M3-T7), only through [`EngineClient::invoke_sealed`].
    Links(LinkHandback),
}

impl StdinPayload {
    fn bytes(&self) -> &[u8] {
        match self {
            StdinPayload::Operand(bytes) => bytes,
            StdinPayload::Key(key) => key.bytes(),
            StdinPayload::Links(handback) => handback.bytes(),
        }
    }
}

/// Write the payload to the child's stdin, then CLOSE it (the drop at the end) — the engine reads
/// to EOF and requires the stream to end within 1 s (`docs/gui-seam.md` §1d). A write error is
/// ignored: an engine that exits or refuses before reading closes its end (`EPIPE`; Rust ignores
/// `SIGPIPE`), and its own answer on stdout is what the caller sees.
async fn write_stdin(pipe: Option<tokio::process::ChildStdin>, payload: Option<StdinPayload>) {
    use tokio::io::AsyncWriteExt;
    if let (Some(mut pipe), Some(payload)) = (pipe, payload) {
        let _ = pipe.write_all(payload.bytes()).await;
        let _ = pipe.shutdown().await;
    }
}

async fn read_all<Rd: tokio::io::AsyncRead + Unpin>(mut rd: Rd) -> Vec<u8> {
    let mut buf = Vec::new();
    // A read error mid-stream keeps whatever arrived: partial output is evidence, and losing it
    // would turn a diagnosable failure into an empty one.
    let _ = rd.read_to_end(&mut buf).await;
    buf
}

/// Read stderr, handing each line to the sink as it arrives and keeping the raw bytes.
async fn stream_stderr<Rd: tokio::io::AsyncRead + Unpin>(
    rd: Rd,
    operation: &str,
    sink: &dyn ProgressSink,
) -> Vec<u8> {
    let mut reader = BufReader::new(rd);
    let mut raw: Vec<u8> = Vec::new();
    let mut line: Vec<u8> = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        raw.extend_from_slice(&line);
        let text = String::from_utf8_lossy(&line);
        sink.stderr_line(operation, text.trim_end_matches(['\n', '\r']));
    }
    raw
}

/// Exit code + output → [`EngineOutcome`]. Pure, and therefore testable without a process.
pub fn classify(
    op: &Operation,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
) -> EngineOutcome {
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    let payload: Option<serde_json::Value> = if op.expects_json() {
        serde_json::from_str(stdout.trim()).ok()
    } else {
        None
    };

    let reason_from_payload = |key: &str| -> Option<String> {
        payload
            .as_ref()
            .and_then(|p| p.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };

    let outcome = match exit_code {
        Some(0) => {
            if op.expects_json() && payload.is_none() {
                // ⚠ DEGRADE, NEVER PANIC. A zero exit with unparseable output is the engine having
                // been replaced, truncated or wrapped by something that printed first; the raw
                // stdout is retained above so the user can see what actually came back.
                Outcome::Failed {
                    reason: Some("malformed-json".to_string()),
                }
            } else if payload
                .as_ref()
                .and_then(|p| p.get("delivered"))
                .and_then(serde_json::Value::as_bool)
                == Some(false)
            {
                Outcome::Skipped {
                    reason: reason_from_payload("skipReason"),
                }
            } else {
                Outcome::Delivered
            }
        }
        Some(1) => Outcome::Failed {
            reason: reason_from_payload("skipReason"),
        },
        Some(2) => Outcome::ConfigError,
        Some(other) => Outcome::Failed {
            reason: Some(format!("exit-{other}")),
        },
        None => Outcome::Failed {
            reason: Some("signalled".to_string()),
        },
    };

    EngineOutcome {
        operation: op.name().to_string(),
        outcome,
        exit_code,
        payload,
        stdout,
        stderr,
    }
}

/* ── the IPC surface ──────────────────────────────────────────────────────────────────────────── */
//
// ONE COMMAND PER OPERATION, and that is the design decision the capability rests on: the grant is
// per command name, so `capabilities/default.json` can say "this webview may read status and
// validate a config" distinctly from "this webview may generate a briefing and install a
// schedule". A single command taking the operation as a parameter would collapse all of them into
// one grant and put the distinction back inside application code, which is where B1's ceiling
// measurement found it was not enforceable.
//
// None of these takes a program, an environment, a working directory or a raw argv. The only
// caller-supplied values are the validated operands above (four on argv, two on stdin — the module
// header), and each is parsed before any spawn. The
// invoker on the schedule mutations is not caller-supplied either (see `Invoker`).

/// The engine client, as Tauri managed state.
///
/// `lib.rs::run()` manages one, built from [`EngineClient::bundled`] ONCE at startup, and every
/// command reads it back through `tauri::State`. Two things follow from that shape:
///
///   * **The app starts even when the sidecar is missing.** The `Result` is stored, not
///     unwrapped; each command returns the stored [`EngineError::SidecarUnresolved`] at call time,
///     with the path it looked at, instead of the app refusing to launch or the click producing an
///     exit-127 to decode.
///   * **The client is injectable.** `tests/capability.rs` manages an [`Engine`] over a fake
///     sidecar under a tempdir and drives every engine command through real IPC, so every command
///     BODY is executed by a test rather than only reached. The previous shape — the commands
///     calling `EngineClient::bundled()` inline — left six of the (then) eight bodies unreachable by any
///     test, which a mutation (`engine_schedule_install` replaced by a constant `Ok`) confirmed
///     with a green suite.
///
/// A newtype rather than a bare `Result<EngineClient, EngineError>` because `tauri::State` keys
/// managed values by TYPE — one value per type — and a name that says what it is beats a `Result`
/// nobody else may manage.
pub struct Engine(pub Result<EngineClient, EngineError>);

impl Engine {
    /// The client, or the startup error it failed with.
    pub fn client(&self) -> Result<&EngineClient, EngineError> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

macro_rules! run_op {
    ($app:expr, $engine:expr, $op:expr) => {{
        let op = $op;
        let sink = AppProgress::new($app);
        $engine.client()?.invoke(op, &sink).await
    }};
}

#[tauri::command]
pub async fn engine_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::Status)
}

#[tauri::command]
pub async fn engine_doctor<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::Doctor)
}

#[tauri::command]
pub async fn engine_run<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    force: bool,
    now: bool,
) -> Result<EngineOutcome, EngineError> {
    run_op!(
        app,
        engine,
        Operation::Run {
            force,
            now,
            json_out: None
        }
    )
}

#[tauri::command]
pub async fn engine_run_to_file<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    name: String,
    force: bool,
    now: bool,
) -> Result<EngineOutcome, EngineError> {
    let json_out = json_out_name(&name).map_err(|reason| EngineError::InvalidInput {
        field: "name".into(),
        reason: reason.message().into(),
    })?;
    run_op!(
        app,
        engine,
        Operation::Run {
            force,
            now,
            json_out: Some(json_out)
        }
    )
}

/// `schedule install --invoker app [--take-over]`. The invoker is fixed: this IS the app.
#[tauri::command]
pub async fn engine_schedule_install<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    take_over: bool,
) -> Result<EngineOutcome, EngineError> {
    run_op!(
        app,
        engine,
        Operation::ScheduleInstall {
            invoker: Invoker::App,
            take_over
        }
    )
}

/// `schedule uninstall --invoker app [--take-over]`. The invoker is fixed: this IS the app.
#[tauri::command]
pub async fn engine_schedule_uninstall<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    take_over: bool,
) -> Result<EngineOutcome, EngineError> {
    run_op!(
        app,
        engine,
        Operation::ScheduleUninstall {
            invoker: Invoker::App,
            take_over
        }
    )
}

#[tauri::command]
pub async fn engine_schedule_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::ScheduleStatus)
}

/// `schedule verify --json` (T20) — re-issue the engine-side verification kickstart.
///
/// ⚠ THIS IS A WRITE, AND IT IS GUARDED AS ONE. See [`Operation::ScheduleVerify`]: the kick starts
/// the registered trigger, so a briefing can be generated and the day stamped. A second one while
/// any mutating operation is in flight is refused with [`EngineError::Busy`], not queued.
///
/// ⚠ AND ITS EXIT CODES DO NOT MEAN WHAT THE OTHERS DO. `1` here is "the kick was accepted and
/// produced no NEW evidence" — inconclusive, not broken — which the classifier reports as
/// [`Outcome::Failed`] with the envelope's own `skipReason` (there is none, so `null`). The panel
/// reads the ENVELOPE's `outcome` field for the verdict, never the exit class alone
/// (`gui/src/lib/verify-flow.ts`).
#[tauri::command]
pub async fn engine_schedule_verify<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::ScheduleVerify)
}

/// `update --check --json` (Phase E, E12) — the Settings screen's "Check now".
///
/// ⚠ A READ AS FAR AS THE GUARD IS CONCERNED, so it is admitted while a run is in flight (see
/// [`Operation::UpdateCheck`]). No operand: the webview cannot shape the request, which the engine
/// builds (`src/updateCheck.ts`). The payload is the engine's result object —
/// `{ status, current, latest?, url?, checkedAt }` — and exit 0 is the norm whatever it says.
#[tauri::command]
pub async fn engine_update_check<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::UpdateCheck)
}

/// `calendar status --json` (v0.3.0, plan M8) — Settings → Calendar's configuration and each
/// source's last SCHEDULED read. A read: no operand, no in-flight guard, bounded at 30 s.
#[tauri::command]
pub async fn engine_calendar_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::CalendarStatus)
}

/// `calendar list --json` (plan M8) — the Mac calendars for the checklist and the configured links,
/// never a URL. A read: no operand, no in-flight guard, bounded at 30 s.
#[tauri::command]
pub async fn engine_calendar_list<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::CalendarList)
}

/// `calendar test --json` (plan M8) — Settings' "Test": read every source now. No operand; NOT
/// mutating (see [`Operation::CalendarTest`]); bounded at [`CALENDAR_TEST_TIMEOUT`].
#[tauri::command]
pub async fn engine_calendar_test<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    run_op!(app, engine, Operation::CalendarTest)
}

/// `calendar connect mac --json` (plan M8) — Settings' "Allow access": install or update the helper
/// copy and request Calendar access while the user is present.
///
/// ⚠ MUTATING (the in-flight guard holds it) and bounded at [`CALENDAR_CONNECT_MAC_TIMEOUT`]. Off
/// macOS it answers [`EngineError::Unsupported`] BEFORE any spawn ([`mac_only`]).
#[tauri::command]
pub async fn engine_calendar_connect_mac<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
) -> Result<EngineOutcome, EngineError> {
    mac_only(cfg!(target_os = "macos"))?;
    run_op!(app, engine, Operation::CalendarConnectMac)
}

/* ── the provider commands (PR 3, P3-M1-T1; `docs/gui-seam.md` §1d) ─────────────────────────────── */
//
// Five commands for the seven `provider` operations. Two operations have NONE: `provider test` takes
// a candidate file path, so the webview reaches it only through the staging command (P3-M1-T2),
// which stages the file itself; and `provider key delete-all` has had no command since PR 3 final
// r1 — Uninstall runs [`Operation::KeyDeleteAll`] Rust-side (`uninstall.rs`). None of these five
// takes a path. All five are MUTATING (the in-flight guard holds them) and bounded
// ([`Operation::timeout`]). The answer is the engine's one JSON line as the
// outcome's `payload`: the webview switches on its `code` and `reason`, never on the exit class.

/// Turn an operand refusal into the IPC error, naming the argument and never echoing its value.
fn refused(field: &str, reason: InputRefusal) -> EngineError {
    EngineError::InvalidInput {
        field: field.into(),
        reason: reason.message().into(),
    }
}

/// `provider key set --json` — store a pasted key; the answer carries the reference to save.
///
/// ⚠ THE KEY IS ON STDIN ONLY ([`EngineClient::invoke_with_key`]); it never enters an
/// [`Operation`], an argv, an error or a log line, and the refusals below do not echo it.
#[tauri::command]
pub async fn engine_provider_key_set<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    key: String,
) -> Result<EngineOutcome, EngineError> {
    let key = KeySecret::new(key).map_err(|reason| refused("key", reason))?;
    let sink = AppProgress::new(app);
    engine
        .client()?
        .invoke_with_key(Operation::KeySet, key, &sink)
        .await
}

/// `provider key migrate --index <n> --json` — move entry n's legacy literal key into the store.
#[tauri::command]
pub async fn engine_provider_key_migrate<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    index: u64,
) -> Result<EngineOutcome, EngineError> {
    let index = provider_index(index).map_err(|reason| refused("index", reason))?;
    run_op!(app, engine, Operation::KeyMigrate { index })
}

/// `provider key delete --id <keyId> --json` — remove one app-owned key.
#[tauri::command]
pub async fn engine_provider_key_delete<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    id: String,
) -> Result<EngineOutcome, EngineError> {
    let id = key_id(&id).map_err(|reason| refused("id", reason))?;
    run_op!(app, engine, Operation::KeyDelete { id })
}

/// `provider key scrub-backup --json` — remove from `.bak` the literal keys the saved config no
/// longer holds.
///
/// ⚠ HOLDS `ConfigSaver`'S SAVE LOCK ACROSS THE ENGINE CALL (plan P3-M1-T1): every settings write
/// takes that lock and keeps `.bak`, so a save running beside the scrub could rewrite `.bak` between
/// the scrub's read and its write. Taken BEFORE the in-flight guard, the lock order every holder of
/// both uses (`uninstall_execute` holds it across its `schedule uninstall`).
///
/// ⚠ AND IT SWEEPS A CRASHED SAVE'S STAGED COPIES FIRST, UNDER THAT LOCK (P3-M4 checkpoint). A save
/// cut short leaves `.<config>.save-<pid>-<seq>.prev`, a second name for `.bak`'s inode, which keeps
/// the literals the scrub removes (the engine answers `otherCopies: true` and never touches it). The
/// only other sweep runs inside a save that WRITES, and an unchanged save writes nothing. So the
/// config is located the way every save locates it ([`crate::config_save::locate`]) and
/// [`crate::config_save::sweep_stale`] runs over its staged prefix — safe here because the lock is
/// held, so none of this process's staged files is in flight (`sweep_stale`'s own contract). A copy
/// left after that is one the app did not make or could not remove. Best effort: a config that
/// cannot be located sweeps nothing, and the scrub still runs (it reports its own refusal).
#[tauri::command]
pub async fn engine_provider_key_scrub_backup<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, crate::config_save::ConfigSaver>,
) -> Result<EngineOutcome, EngineError> {
    let client = engine.client()?;
    let _serialised = saver.lock.lock().await;
    if let Ok(path) = crate::config_save::locate(client).await {
        if let (Some(dir), Some(name)) = (path.parent(), path.file_name()) {
            let prefix = crate::config_save::staged_prefix(&name.to_string_lossy());
            crate::config_save::sweep_stale(dir, &prefix, crate::config_save::STAGED_SUFFIXES);
        }
    }
    let sink = AppProgress::new(app);
    client.invoke(Operation::KeyScrubBackup, &sink).await
}

/// `provider reset (--index <n> | --label-stdin) --json` — clear one entry's marks. Exactly one of
/// `index` and `label` must be given; the label is written to stdin, never argv (hub Q20).
#[tauri::command]
pub async fn engine_provider_reset<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    index: Option<u64>,
    label: Option<String>,
) -> Result<EngineOutcome, EngineError> {
    let target = match (index, label) {
        (Some(index), None) => {
            ResetTarget::Index(provider_index(index).map_err(|reason| refused("index", reason))?)
        }
        (None, Some(text)) => {
            ResetTarget::Label(self::label(&text).map_err(|reason| refused("label", reason))?)
        }
        _ => {
            return Err(EngineError::InvalidInput {
                field: "index/label".into(),
                reason: "exactly one of the two is required".into(),
            })
        }
    };
    run_op!(app, engine, Operation::ProviderReset { target })
}

/// Every command name this module exposes, in the order `lib.rs` registers them.
///
/// `build.rs` autogenerates one `allow-<command>` permission per entry and
/// `capabilities/default.json` grants exactly these; `tests/capability.rs` asserts the three lists
/// agree, so a command added here without a grant fails a test rather than shipping unreachable,
/// and a grant without a command fails rather than lingering as a permission for nothing.
///
/// ⚠ THREE OPERATIONS HAVE NO COMMAND, ON PURPOSE: `ProviderTest` (only the candidate check stages
/// one, `config_save.rs`), and since PR 3 final r1 `ConfigValidate` and `KeyDeleteAll`. The webview's `engine_config_validate(file)` returned `normalized` — every
/// literal `apiKey` of any absolute file it named — and `engine_provider_key_delete_all` deleted
/// every app key in one call, around uninstall's kept-schedule refusal and consent; no app code
/// called either. Rust still runs both: the settings guard and the candidate check validate files
/// they staged or own (`config_save.rs`), and uninstall's key leg deletes the keys behind its own
/// gates (`uninstall.rs`). `tests/capability.rs` pins the refusal.
pub const COMMANDS: &[&str] = &[
    "engine_status",
    "engine_doctor",
    "engine_run",
    "engine_run_to_file",
    "engine_schedule_install",
    "engine_schedule_uninstall",
    "engine_schedule_status",
    "engine_schedule_verify",
    "engine_update_check",
    "engine_calendar_status",
    "engine_calendar_list",
    "engine_calendar_test",
    "engine_calendar_connect_mac",
    "engine_provider_key_set",
    "engine_provider_key_migrate",
    "engine_provider_key_delete",
    "engine_provider_key_scrub_backup",
    "engine_provider_reset",
];

/// `wipe` and `wipe_bytes` are `pub(crate)`, so an integration test cannot reach them; this is
/// where they are visible (wave-2 plan C-M3-T7, R4-M7). Run by `cargo test --lib secret_bytes`.
/// No read through a pointer after a drop (that would be undefined behaviour): the wipe is checked
/// on a live buffer.
#[cfg(test)]
mod secret_bytes_tests {
    use super::*;

    #[test]
    fn secret_bytes_wipe_zeroes_every_byte() {
        let mut s = SecretBytes::from_vec(b"https://vault.example/MARKER".to_vec());
        let ptr = s.0.as_ptr();
        assert!(s.bytes().iter().any(|b| *b != 0), "the decoy: the bytes start non-zero");
        s.wipe();
        assert_eq!(s.0.len(), 28, "wipe keeps the length (it overwrites, it does not truncate)");
        assert!(s.bytes().iter().all(|b| *b == 0), "a byte survived the wipe");
        assert_eq!(s.0.as_ptr(), ptr, "the wipe reallocated instead of overwriting");
    }

    #[test]
    fn secret_bytes_wipe_bytes_on_an_empty_slice_is_a_no_op() {
        let mut empty: [u8; 0] = [];
        wipe_bytes(&mut empty);
        let mut s = SecretBytes::from_vec(Vec::new());
        s.wipe();
        assert!(s.bytes().is_empty());
        let mut some = [7u8, 8, 9];
        wipe_bytes(&mut some[1..]);
        assert_eq!(some, [7, 0, 0], "wipe_bytes reached outside its slice");
    }

    /// The handback's bytes are exactly what it was given (the snapshot is the one writer).
    #[test]
    fn secret_bytes_link_handback_holds_its_bytes_unchanged() {
        let h = LinkHandback::new(SecretBytes::from_vec(br#"{"links":[]}"#.to_vec()));
        assert_eq!(h.bytes(), br#"{"links":[]}"#);
        assert_eq!(StdinPayload::Links(h).bytes(), br#"{"links":[]}"#);
    }

    /// The private sealed types cannot be printed or serialised either (the integration probes reach
    /// only the `pub` ones). Decoys both ways.
    #[test]
    fn secret_bytes_private_sealed_types_are_not_printable() {
        use std::marker::PhantomData;
        struct Probe<T>(PhantomData<T>);
        trait NotDebug {
            const IS_DEBUG: bool = false;
        }
        impl<T> NotDebug for Probe<T> {}
        impl<T: std::fmt::Debug> Probe<T> {
            #[allow(dead_code)]
            const IS_DEBUG: bool = true;
        }
        struct SProbe<T>(PhantomData<T>);
        trait NotSerialize {
            const IS_SERIALIZE: bool = false;
        }
        impl<T> NotSerialize for SProbe<T> {}
        impl<T: serde::Serialize> SProbe<T> {
            #[allow(dead_code)]
            const IS_SERIALIZE: bool = true;
        }
        struct Plain;
        assert!(Probe::<String>::IS_DEBUG && !Probe::<Plain>::IS_DEBUG);
        assert!(SProbe::<String>::IS_SERIALIZE && !SProbe::<Plain>::IS_SERIALIZE);
        assert!(!Probe::<DetailsRead>::IS_DEBUG && !SProbe::<DetailsRead>::IS_SERIALIZE);
        assert!(!Probe::<RawEvent>::IS_DEBUG && !SProbe::<RawEvent>::IS_SERIALIZE);
        assert!(!Probe::<RawPerson>::IS_DEBUG && !SProbe::<RawPerson>::IS_SERIALIZE);
        assert!(!Probe::<RawOtherNote>::IS_DEBUG && !SProbe::<RawOtherNote>::IS_SERIALIZE);
        assert!(!Probe::<RawJoin>::IS_DEBUG && !SProbe::<RawJoin>::IS_SERIALIZE);
        assert!(!Probe::<RawSource>::IS_DEBUG && !SProbe::<RawSource>::IS_SERIALIZE);
        assert!(!Probe::<RawLink>::IS_DEBUG && !SProbe::<RawLink>::IS_SERIALIZE);
        assert!(!Probe::<StdinPayload>::IS_DEBUG && !SProbe::<StdinPayload>::IS_SERIALIZE);
    }
}
