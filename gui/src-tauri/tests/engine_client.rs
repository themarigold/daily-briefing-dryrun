//! The engine client (T8): argv construction, operand validation, outcome mapping, the progress
//! channel, the in-flight guard, and the process-group kill's two halves — the ids it refuses, and
//! the completed invocation that must NOT fire it (`tests/watcher.rs` owns the abandoned one).
//!
//! ## What spawns what, and what it is pointed at
//!
//! ⚠ **THE TESTS THAT SPAWN THE REAL ENGINE ARE POINTED AT A SANDBOX, AND THE SANDBOX IS
//! ASSERTED.** `common::sandbox_env` sets `DAILY_BRIEFING_STATE_DIR`, `XDG_CONFIG_HOME` and
//! `DBA_TEST_UNIT_DIR`, and `the_read_only_operations_reach_the_real_sidecar` requires `status`'s
//! own reported paths to sit under that sandbox root — so the isolation is measured rather than
//! assumed, and a future engine that stopped honouring one of the three would fail here instead of
//! quietly reporting on the developer's real briefing state.
//!
//! ⚠ **`run` AND `run --force` ARE EXECUTED, AGAINST A SANDBOX WITH NO CONFIG — OR A MALFORMED
//! ONE**, which is what makes them safe: MEASURED against this engine, a non-forced run on a
//! config-less machine exits 0 with `skipReason: "no-config"` and calls no provider (`src/main.ts`:
//! the `no-config` gate `return skip("no-config", 0)`s before the run lock, the repo walk and the
//! provider), a forced one exits 2 for the same reason before reaching any of it, and a run whose
//! `config.json` does not parse exits 2 with `skipReason: "config-error"` from the same
//! `loadConfig` catch, forced or not. No provider is configured or loadable, so none can be
//! called; no briefing is generated and no day is stamped.
//!
//! ⚠ **`schedule install` AND `schedule uninstall` ARE NEVER EXECUTED AGAINST THE REAL ENGINE.**
//! `src/schedule/install.ts` copies a managed engine binary, `codesign`s it (minting a signing
//! identity with `openssl` and `security` first when it has none), and registers a plist with
//! `launchctl`; uninstall unregisters it by label. `DBA_TEST_UNIT_DIR` redirects where the plist is
//! WRITTEN (`unitDir`), and the engine's default exec also REFUSES every scheduler change while
//! that variable is set: a `launchctl load`, `unload` or `bootout`, or a `systemctl` change, spawns
//! nothing and comes back as code -2 with `SCHEDULER_CHANGE_REFUSED` (`defaultExec` and
//! `isRegistrationChange` in `src/schedule/install.ts`, spec 3.1.3). `common::sandbox_env` sets the
//! variable and `sandboxed` adds it with `with_env` (the client clears its environment, so nothing
//! ambient carries it), so a sandboxed engine's registration call would be refused rather than
//! reach the live user domain. That refusal is a backstop, never a licence to execute them: it
//! blocks only scheduler changes, so the read-only probes (`launchctl print` and `list`) and the
//! keychain and signing tools would still run for real, and `ensureIdentity`'s fallback
//! `security import` names no keychain, so it would land in the login keychain. They are covered
//! here by argv construction and by a fake sidecar that reports the argv it received; executing
//! them is VM-gated per plan line 70. `docs/gui-seam.md` records the register.
//!
//! ## The serialiser, and why it is not a mutex
//!
//! `engine::Operation::is_mutating` decides whether an invocation takes the process-global
//! in-flight guard, and `cargo test` runs the tests in this binary on parallel threads — so two
//! tests that each spawn a *mutating* operation would contend for that guard and one would fail
//! with a `Busy` it never asked for. `common::serialise()` makes those tests take turns (it lived
//! here until Batch 2 moved it to `tests/common` for `tests/uninstall.rs`, whose `uninstall_execute`
//! now runs `schedule uninstall`). It is an atomic with an async back-off rather than a `Mutex`
//! held across the test body precisely because a lock guard alive across an `.await` is the thing
//! `clippy::await_holding_lock` objects to, and silencing that lint to build a serialiser would be
//! trading a real warning for a fake one.

mod common;

use std::sync::Mutex;
use std::time::Duration;

use common::{argv_dumper, canned, envelope, sandbox_env, serialise, sleeper, ScratchDir};
// Used only by the `#[cfg(unix)]` process-group tests at the end of this file, and gated to match.
// Ungated, these four are `unused_imports` warnings on a non-unix build — and the
// `ProcessGroupKill` import below is worse than a warning there: the type is itself `#[cfg(unix)]`,
// so it does not exist to import and the build fails outright.
#[cfg(unix)]
use common::{fake_sidecar, process_gone, sq, ReapTagged};
#[cfg(unix)]
use daily_briefing_gui_lib::engine::ProcessGroupKill;
use daily_briefing_gui_lib::engine::{
    config_file_path, is_refused_format_character, json_out_name, key_id, label, mac_only,
    provider_index, resolve_sidecar, sidecar_path_beside, DetailsFailure, DetailsRaw, EngineClient,
    EngineError, InputRefusal, Invoker, KeySecret, LinkHandback, NoProgress, Operation, Outcome,
    ProgressSink, ReposBranch, ReposLabel, ReposRefusal, ReposRequest, ReposScope, ResetTarget,
    SecretBytes, CALENDAR_CONNECT_MAC_TIMEOUT, CALENDAR_DETAILS_TIMEOUT, CALENDAR_TEST_TIMEOUT,
    KEY_DELETE_ALL_TIMEOUT, KEY_SET_TIMEOUT, KEY_STDIN_MAX_BYTES, LABEL_STDIN_MAX_BYTES,
    MAX_PROVIDER_INDEX, PROVIDER_OP_TIMEOUT, PROVIDER_TEST_LOOPBACK_CAP,
    PROVIDER_TEST_LOOPBACK_EXTRA, PROVIDER_TEST_REMOTE_TIMEOUT, REFUSED_FORMAT_CHARACTERS,
    REPOS_BRANCH_MAX_BYTES, REPOS_KEY_MAX_SCALARS, REPOS_MAX_BRANCHES, REPOS_MAX_LABELS,
    REPOS_STDIN_MAX_BYTES, REPOS_TOKENS_PER_LABEL, REPOS_TOKENS_TOTAL,
};
use daily_briefing_gui_lib::shell::ENGINE_READ_TIMEOUT;

/* ── a recording progress sink ────────────────────────────────────────────────────────────────── */

#[derive(Default)]
struct Recorder {
    lines: Mutex<Vec<(String, String)>>,
}

impl Recorder {
    fn lines(&self) -> Vec<(String, String)> {
        self.lines.lock().expect("recorder").clone()
    }
}

impl ProgressSink for Recorder {
    fn stderr_line(&self, operation: &str, line: &str) {
        self.lines
            .lock()
            .expect("recorder")
            .push((operation.to_string(), line.to_string()));
    }
}

/* ── argv ─────────────────────────────────────────────────────────────────────────────────────── */

/// The whole of the argv surface, spelled out against the engine's grammar (`src/main.ts`'s
/// `dispatch`, `jsonOutArg`, `requireJson`, `SCHEDULE_VERBS`).
///
/// ⚠ THE SUBCOMMAND IS argv[0] IN EVERY CASE, and that is the assertion that matters most. The
/// reversed spelling `--json status` is refused by the engine with exit 2 (`docs/gui-seam.md` §1);
/// before that guard existed it routed to `run`, discarded the token and consumed the morning. No
/// operation here can produce a leading flag, because no caller supplies argv[0].
#[test]
fn argv_matches_the_engine_grammar() {
    let cases: Vec<(Operation, Vec<&str>)> = vec![
        (
            Operation::Run {
                force: false,
                now: false,
                json_out: None,
            },
            vec!["run", "--json"],
        ),
        (
            Operation::Run {
                force: true,
                now: false,
                json_out: None,
            },
            vec!["run", "--json", "--force"],
        ),
        // `--now` (the app's Run now): exempt from the morning floor only, still once a day.
        (
            Operation::Run {
                force: false,
                now: true,
                json_out: None,
            },
            vec!["run", "--json", "--now"],
        ),
        (
            Operation::Run {
                force: false,
                now: true,
                json_out: Some(json_out_name("envelope.json").expect("a valid name")),
            },
            vec!["run", "--json", "--now", "--json-out", "envelope.json"],
        ),
        (
            Operation::Run {
                force: false,
                now: false,
                json_out: Some(json_out_name("envelope.json").expect("a valid name")),
            },
            vec!["run", "--json", "--json-out", "envelope.json"],
        ),
        (
            Operation::Run {
                force: true,
                now: false,
                json_out: Some(json_out_name("run-2026-09-15.json").expect("a valid name")),
            },
            vec![
                "run",
                "--json",
                "--force",
                "--json-out",
                "run-2026-09-15.json",
            ],
        ),
        (Operation::Status, vec!["status", "--json"]),
        (Operation::Doctor, vec!["doctor", "--json"]),
        (
            Operation::ConfigValidate {
                file: config_file_path("/etc/daily-briefing/config.json").expect("a valid path"),
            },
            vec![
                "config",
                "validate",
                "--json",
                "--file",
                "/etc/daily-briefing/config.json",
            ],
        ),
        (
            Operation::ScheduleInstall {
                invoker: Invoker::App,
                take_over: false,
            },
            vec!["schedule", "install", "--invoker", "app"],
        ),
        (
            Operation::ScheduleInstall {
                invoker: Invoker::Cli,
                take_over: true,
            },
            vec!["schedule", "install", "--invoker", "cli", "--take-over"],
        ),
        (
            Operation::ScheduleUninstall {
                invoker: Invoker::App,
                take_over: true,
            },
            vec!["schedule", "uninstall", "--invoker", "app", "--take-over"],
        ),
        (
            Operation::ScheduleUninstall {
                invoker: Invoker::Cli,
                take_over: false,
            },
            vec!["schedule", "uninstall", "--invoker", "cli"],
        ),
        (
            Operation::ScheduleStatus,
            vec!["schedule", "status", "--json"],
        ),
        // B6 (T20). ⚠ `--json` IS ACCEPTED HERE, unlike on install/uninstall: `src/main.ts`'s
        // schedule arm prints `JSON.stringify(v)` for `verify` when `wantsJson`, and the usage text
        // says so ("schedule status|verify: print the report as JSON instead of text").
        (
            Operation::ScheduleVerify,
            vec!["schedule", "verify", "--json"],
        ),
        // Phase E (E12). `update`'s whole vocabulary is `--check` plus `--json` (`src/main.ts`,
        // UPDATE_VERBS/UPDATE_FLAGS); a bare `update` exits 2, so `--check` is never optional here.
        (Operation::UpdateCheck, vec!["update", "--check", "--json"]),
        // v0.3.0 (plan M8): the four calendar operations, as spec r4 §8's CLI spells them
        // (`daily-briefing calendar connect mac | … | list | test | status`, each with `--json`).
        // The subcommands arrive in the engine with W1's M5; until then these are pinned against
        // the spec and driven against fakes.
        (
            Operation::CalendarStatus,
            vec!["calendar", "status", "--json"],
        ),
        (Operation::CalendarList, vec!["calendar", "list", "--json"]),
        (Operation::CalendarTest, vec!["calendar", "test", "--json"]),
        (
            Operation::CalendarConnectMac,
            vec!["calendar", "connect", "mac", "--json"],
        ),
        // Wave 2, C-M3-T7: the live details read. Its two flags are the only operands, both
        // Rust-built booleans; the remembered URLs travel on stdin, never here.
        (
            Operation::CalendarDetails {
                skip_mac: false,
                skip_commands: false,
            },
            vec!["calendar", "details", "--json"],
        ),
        (
            Operation::CalendarDetails {
                skip_mac: true,
                skip_commands: false,
            },
            vec!["calendar", "details", "--json", "--skip-mac"],
        ),
        (
            Operation::CalendarDetails {
                skip_mac: false,
                skip_commands: true,
            },
            vec!["calendar", "details", "--json", "--skip-commands"],
        ),
        (
            Operation::CalendarDetails {
                skip_mac: true,
                skip_commands: true,
            },
            vec!["calendar", "details", "--json", "--skip-mac", "--skip-commands"],
        ),
        // Provider fallback PR 3 (P3-M1-T1): the `provider` verbs as `docs/gui-seam.md` §1d spells
        // them (and `src/providerCli.ts`'s `VERBS` parses them) — `--json` exactly once. No key and
        // no label appears in any of them: those travel on stdin.
        (Operation::KeySet, vec!["provider", "key", "set", "--json"]),
        (
            Operation::KeyMigrate {
                index: provider_index(3).expect("a valid index"),
            },
            vec!["provider", "key", "migrate", "--index", "3", "--json"],
        ),
        (
            Operation::KeyDelete {
                id: key_id("k-0123456789ab").expect("a valid id"),
            },
            vec![
                "provider",
                "key",
                "delete",
                "--id",
                "k-0123456789ab",
                "--json",
            ],
        ),
        (
            Operation::KeyDeleteAll,
            vec!["provider", "key", "delete-all", "--json"],
        ),
        (
            Operation::KeyScrubBackup,
            vec!["provider", "key", "scrub-backup", "--json"],
        ),
        (
            Operation::ProviderReset {
                target: ResetTarget::Index(provider_index(0).expect("a valid index")),
            },
            vec!["provider", "reset", "--index", "0", "--json"],
        ),
        (
            Operation::ProviderReset {
                target: ResetTarget::Label(label("work").expect("a valid label")),
            },
            vec!["provider", "reset", "--label-stdin", "--json"],
        ),
        (
            Operation::ProviderTest {
                file: config_file_path("/tmp/provider-check-1.json").expect("a valid path"),
                index: provider_index(999_999).expect("the largest index"),
                test_timeout_ms: 80_000,
            },
            vec![
                "provider",
                "test",
                "--file",
                "/tmp/provider-check-1.json",
                "--index",
                "999999",
                "--json",
            ],
        ),
        // B1-M4-T11: the request is the operand, and it rides on STDIN (`stdin_payload`), never here.
        (
            Operation::ReposStatus {
                request: a_repos_request(),
            },
            vec!["repos", "status", "--json"],
        ),
    ];

    for (op, expected) in cases {
        assert_eq!(
            op.argv(),
            expected,
            "argv for {op:?} is not what the engine's dispatch expects"
        );
        let argv = op.argv();
        assert!(
            !argv[0].starts_with('-'),
            "argv[0] for {op:?} is a FLAG, not a subcommand — the engine would route it to `run`"
        );
        // PR 3: the engine REQUIRES `--json` exactly once on every `provider` verb (§1d: "missing or
        // twice" is a `usage` refusal).
        if argv[0] == "provider" {
            assert_eq!(
                argv.iter().filter(|a| *a == "--json").count(),
                1,
                "{op:?}: `--json` must appear exactly once"
            );
        }
    }
}

/// One representative of every `Operation` variant, enumerated by a `match` with NO wildcard arm.
///
/// ⚠ THIS IS WHAT MAKES THE LIST COMPLETE, and it is a compile-time property: `next` matches
/// every variant and names the one after it, so a ninth variant is a non-exhaustive `match` — a
/// compile error in this file — before it is a stale list in review. A hand-built array cannot
/// give that (the previous revision of this test had one, and a ninth variant compiled and passed
/// against it). The chain is walked from the first variant until `next` returns `None`; the
/// runtime assertions in `every_operation_variant_is_accounted_for` are what catch a chain that
/// SKIPS a variant it still matches.
fn every_operation() -> Vec<Operation> {
    fn next(op: &Operation) -> Option<Operation> {
        match op {
            Operation::Run { .. } => Some(Operation::Status),
            Operation::Status => Some(Operation::Doctor),
            Operation::Doctor => Some(Operation::ConfigValidate {
                file: config_file_path("/tmp/candidate.json").expect("a valid path"),
            }),
            Operation::ConfigValidate { .. } => Some(Operation::ScheduleInstall {
                invoker: Invoker::App,
                take_over: false,
            }),
            Operation::ScheduleInstall { .. } => Some(Operation::ScheduleUninstall {
                invoker: Invoker::App,
                take_over: false,
            }),
            Operation::ScheduleUninstall { .. } => Some(Operation::ScheduleStatus),
            Operation::ScheduleStatus => Some(Operation::ScheduleVerify),
            Operation::ScheduleVerify => Some(Operation::UpdateCheck),
            Operation::UpdateCheck => Some(Operation::CalendarStatus),
            Operation::CalendarStatus => Some(Operation::CalendarList),
            Operation::CalendarList => Some(Operation::CalendarTest),
            Operation::CalendarTest => Some(Operation::CalendarConnectMac),
            Operation::CalendarConnectMac => Some(Operation::KeySet),
            Operation::KeySet => Some(Operation::KeyMigrate {
                index: provider_index(0).expect("a valid index"),
            }),
            Operation::KeyMigrate { .. } => Some(Operation::KeyDelete {
                id: key_id("k-000000000000").expect("a valid id"),
            }),
            Operation::KeyDelete { .. } => Some(Operation::KeyDeleteAll),
            Operation::KeyDeleteAll => Some(Operation::KeyScrubBackup),
            Operation::KeyScrubBackup => Some(Operation::ProviderReset {
                target: ResetTarget::Index(provider_index(0).expect("a valid index")),
            }),
            Operation::ProviderReset { .. } => Some(Operation::ProviderTest {
                file: config_file_path("/tmp/candidate.json").expect("a valid path"),
                index: provider_index(0).expect("a valid index"),
                test_timeout_ms: 80_000,
            }),
            // Wave 2, relinked by the second lander (plan §1.3, P5-M5): B1's `ReposStatus`, then C's
            // `CalendarDetails`, then the end of the chain.
            Operation::ProviderTest { .. } => Some(Operation::ReposStatus {
                request: a_repos_request(),
            }),
            Operation::ReposStatus { .. } => Some(Operation::CalendarDetails {
                skip_mac: false,
                skip_commands: false,
            }),
            Operation::CalendarDetails { .. } => None,
        }
    }
    let mut all = vec![Operation::Run {
        force: false,
        now: false,
        json_out: None,
    }];
    while let Some(op) = next(all.last().expect("the seed")) {
        all.push(op);
    }
    all
}

/// The operations that exist in plan R1's forward list but not in the engine, and the ones the
/// design excludes, are absent by construction: `Operation` has no variant for them. The
/// enumeration is `every_operation`'s exhaustive match, so this test cannot go stale by omission;
/// what it pins at runtime is the NAME set (so a variant added to the match but skipped by the
/// chain is caught) and the per-operation JSON expectation.
#[test]
fn every_operation_variant_is_accounted_for() {
    let all = every_operation();
    let mut names: Vec<&str> = all.iter().map(Operation::name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(
        names,
        [
            "calendar-connect-mac",
            "calendar-details",
            "calendar-list",
            "calendar-status",
            "calendar-test",
            "config-validate",
            "doctor",
            "provider-key-delete",
            "provider-key-delete-all",
            "provider-key-migrate",
            "provider-key-scrub-backup",
            "provider-key-set",
            "provider-reset",
            "provider-test",
            "repos-status",
            "run",
            "schedule-install",
            "schedule-status",
            "schedule-uninstall",
            "schedule-verify",
            "status",
            "update-check",
        ],
        "the operation set changed. `init` is deliberately absent — first-config creation is \
         `config_create` (T16), not the engine's template. `calendar` WAS absent until v0.3.0 \
         (plan M8): the engine gains `calendar status|list|test|connect mac` in the same release \
         (W1's M5), and its `add-link`/`remove-link` stay absent here because they read the URL \
         from STDIN, which the app's spawns never give the engine — `crate::calendar` writes the \
         link file itself. `schedule verify` WAS in that list until B6: the \
         kickstart is still engine-side inside `schedule install` (plan R1), and this operation is \
         the re-run of that same engine-side kick, which is what keeps the app's exec surface \
         engine-only. `update --check` WAS in it until Phase E: E11 gave the engine the subcommand \
         and E12 granted it (notify-only, not mutating). The seven `provider` operations arrive \
         with provider fallback PR 3 (the engine's `provider` command, `docs/gui-seam.md` §1d); \
         `provider test` is the one with no grant — only the candidate-staging command reaches it. \
         Adding one needs a grant in the capability (or a stated reason it has none) and a reason in \
         the same change."
    );
    assert_eq!(
        all.len(),
        names.len(),
        "every_operation's chain visited a variant twice or skipped one: {all:?}"
    );

    // The JSON expectation is per-operation, not universal: `schedule install`/`uninstall` narrate
    // on stdout and have no `--json` form at all.
    for op in &all {
        let expects = op.expects_json();
        let is_schedule_mutation = matches!(
            op,
            Operation::ScheduleInstall { .. } | Operation::ScheduleUninstall { .. }
        );
        assert_eq!(
            expects, !is_schedule_mutation,
            "{op:?} has the wrong JSON expectation — treating a narrating command's output as \
             malformed JSON would report every successful install as a failure"
        );
    }
}

/// The in-flight guard's partition, spelled out literally: which operations take it and which do
/// not. This is the scoping decision `Operation::is_mutating` encodes — one in-flight GENERATION
/// or schedule mutation, and a polling panel never refused.
///
/// ⚠ Seen red by dropping `ScheduleInstall` from `is_mutating` on a disposable copy. Before this
/// test existed that mutation left the whole suite green: the busy test exercised `Run` only.
#[test]
fn the_in_flight_guard_covers_exactly_the_state_changing_operations() {
    let mutating = [
        Operation::Run {
            force: false,
            now: false,
            json_out: None,
        },
        Operation::Run {
            force: true,
            now: false,
            json_out: None,
        },
        Operation::Run {
            force: false,
            now: true,
            json_out: None,
        },
        Operation::Run {
            force: false,
            now: false,
            json_out: Some(json_out_name("out.json").expect("a valid name")),
        },
        Operation::ScheduleInstall {
            invoker: Invoker::App,
            take_over: false,
        },
        Operation::ScheduleInstall {
            invoker: Invoker::App,
            take_over: true,
        },
        Operation::ScheduleInstall {
            invoker: Invoker::Cli,
            take_over: false,
        },
        Operation::ScheduleInstall {
            invoker: Invoker::Cli,
            take_over: true,
        },
        Operation::ScheduleUninstall {
            invoker: Invoker::App,
            take_over: false,
        },
        Operation::ScheduleUninstall {
            invoker: Invoker::Cli,
            take_over: true,
        },
        // B6 (T20). ⚠ THE ONE WHOSE VERB READS LIKE A READ. `schedule verify` kicks the REGISTERED
        // trigger (`src/schedule/install.ts`, `verifySchedule` → `kick`), so launchd runs the
        // engine and a briefing can be generated and the day stamped. A verify racing a Run Now is
        // two generations, which is what this guard exists to prevent.
        Operation::ScheduleVerify,
        // v0.3.0 (plan M8): installs and re-signs the helper copy through the keychain identity a
        // schedule install also uses, and raises the Calendar permission dialog.
        Operation::CalendarConnectMac,
        // PR 3 (spec §6 "the writing operations … hold the in-flight guard"): ALL SEVEN `provider`
        // operations. Each writes the key store, the settings backup or the marks/status files —
        // `provider test` included, which records its outcome (a second Test is refused `Busy`).
        Operation::KeySet,
        Operation::KeyMigrate {
            index: provider_index(1).expect("a valid index"),
        },
        Operation::KeyDelete {
            id: key_id("k-abcdef012345").expect("a valid id"),
        },
        Operation::KeyDeleteAll,
        Operation::KeyScrubBackup,
        Operation::ProviderReset {
            target: ResetTarget::Index(provider_index(1).expect("a valid index")),
        },
        Operation::ProviderReset {
            target: ResetTarget::Label(label("--help").expect("a valid label")),
        },
        Operation::ProviderTest {
            file: config_file_path("/tmp/candidate.json").expect("a valid path"),
            index: provider_index(1).expect("a valid index"),
            test_timeout_ms: 80_000,
        },
        Operation::ProviderTest {
            file: config_file_path("/tmp/candidate.json").expect("a valid path"),
            index: provider_index(1).expect("a valid index"),
            test_timeout_ms: 600_000 + 17_000,
        },
    ];
    let read_only = [
        Operation::Status,
        Operation::Doctor,
        Operation::ConfigValidate {
            file: config_file_path("/tmp/candidate.json").expect("a valid path"),
        },
        Operation::ScheduleStatus,
        // Phase E (E12). ⚠ NOT MUTATING, by decision (plan §5 #16): no schedule, no briefing state —
        // its one write is the engine's own atomic update-check record. A "Check now" refused with
        // Busy because a briefing is generating would be a refusal guarding nothing.
        Operation::UpdateCheck,
        // v0.3.0 (plan M8): the three calendar reads — the configuration and last scheduled reads,
        // the calendar list, and a Test of every source now. None changes a schedule or a briefing.
        Operation::CalendarStatus,
        Operation::CalendarList,
        Operation::CalendarTest,
        // B1-M4-T11: the live git check reads repos and the run record and writes nothing; its own
        // one-in-flight latch is `repos::ReposLive`'s, not this guard (plan §1.4, P5-M5).
        Operation::ReposStatus {
            request: a_repos_request(),
        },
        // Wave 2 (C-M3-T7): the live details read changes no schedule and no briefing state, and
        // writes no health file (the engine's jail test); its one-in-flight rule is its own latch
        // in `calendar_details.rs`, not this guard.
        Operation::CalendarDetails {
            skip_mac: false,
            skip_commands: false,
        },
        Operation::CalendarDetails {
            skip_mac: true,
            skip_commands: true,
        },
    ];
    for op in &mutating {
        assert!(
            op.is_mutating(),
            "{op:?} changes state (a briefing, a day stamp, an OS schedule) and must take the \
             in-flight guard"
        );
    }
    for op in &read_only {
        assert!(
            !op.is_mutating(),
            "{op:?} is a read and must NOT take the in-flight guard — a polling panel refused \
             with Busy fails exactly when it has the most to show"
        );
    }
    // And the two lists together cover every variant, so a new one cannot land unclassified.
    let mut classified: Vec<&str> = mutating
        .iter()
        .chain(read_only.iter())
        .map(Operation::name)
        .collect();
    classified.sort_unstable();
    classified.dedup();
    let mut all: Vec<&str> = every_operation().iter().map(Operation::name).collect();
    all.sort_unstable();
    assert_eq!(
        classified, all,
        "an Operation variant is in neither list above; classify it"
    );
}

/// v0.3.0 (plan M8): the four calendar operations carry their OWN wall-clock bounds — and, since
/// provider fallback PR 3 (P3-M1-T1), so do the seven `provider` operations (spec §6: "every new
/// operation has an explicit app-side timeout … the engine's own worst case plus 5 s"). No OTHER
/// operation does, so every pre-M8 path behaves exactly as before (the read paths keep wrapping
/// `invoke` in `ENGINE_READ_TIMEOUT` themselves; the older mutating ones stay unbounded here).
///
/// The harness cap ([`EngineClient::with_timeout_cap`]) SHORTENS a bound and never invents one —
/// pinned here because the timeout tests below depend on exactly that.
#[test]
fn only_the_calendar_and_provider_operations_carry_their_own_bounds() {
    assert_eq!(
        Operation::CalendarStatus.timeout(),
        Some(ENGINE_READ_TIMEOUT)
    );
    assert_eq!(Operation::CalendarList.timeout(), Some(ENGINE_READ_TIMEOUT));
    assert_eq!(ENGINE_READ_TIMEOUT, Duration::from_secs(30));
    assert_eq!(
        Operation::CalendarTest.timeout(),
        Some(CALENDAR_TEST_TIMEOUT)
    );
    assert_eq!(CALENDAR_TEST_TIMEOUT, Duration::from_secs(75));
    // Spec r4 §8: "`CalendarConnectMac` (mutating, 150 s: the helper's own 120 s request limit plus
    // headroom, …)" — 120 s at M8, raised by the hub's decision at M9 so the engine's own timeout
    // status arrives before the Rust bound fires.
    assert_eq!(
        Operation::CalendarConnectMac.timeout(),
        Some(CALENDAR_CONNECT_MAC_TIMEOUT)
    );
    assert_eq!(CALENDAR_CONNECT_MAC_TIMEOUT, Duration::from_secs(150));
    // Wave 2 (C-M3-T7): the engine's 30 s calendar bound (`CALENDAR_STEP_BOUND_MS`) + 15 s for the
    // process start, the config load and the reader launch; no network probe, so not 75 s.
    assert_eq!(CALENDAR_DETAILS_TIMEOUT, Duration::from_secs(45));

    // PR 3 — the numbers, as spec §6 (amended at the P2-M2 / P2-M3-T1 / P2-M4 checkpoints) states
    // them: `key set`/`migrate` 1 + 10 + 3 = 14 s + 5; `delete-all` 1 + 10 = 11 s + 5; `delete`,
    // `reset`, `scrub-backup` 10 s + 5; `test` 80 s remote.
    assert_eq!(KEY_SET_TIMEOUT, Duration::from_secs(19));
    assert_eq!(KEY_DELETE_ALL_TIMEOUT, Duration::from_secs(16));
    assert_eq!(PROVIDER_OP_TIMEOUT, Duration::from_secs(15));
    assert_eq!(PROVIDER_TEST_REMOTE_TIMEOUT, Duration::from_secs(80));
    assert_eq!(PROVIDER_TEST_LOOPBACK_CAP, Duration::from_secs(30 * 60));
    assert_eq!(PROVIDER_TEST_LOOPBACK_EXTRA, Duration::from_secs(17));
    let idx = || provider_index(2).expect("a valid index");
    let test_op = |test_timeout_ms| Operation::ProviderTest {
        file: config_file_path("/tmp/candidate.json").expect("a valid path"),
        index: idx(),
        test_timeout_ms,
    };
    let bounds: Vec<(Operation, Duration)> = vec![
        (Operation::KeySet, KEY_SET_TIMEOUT),
        (Operation::KeyMigrate { index: idx() }, KEY_SET_TIMEOUT),
        (Operation::KeyDeleteAll, KEY_DELETE_ALL_TIMEOUT),
        (
            Operation::KeyDelete {
                id: key_id("k-0123456789ab").expect("a valid id"),
            },
            PROVIDER_OP_TIMEOUT,
        ),
        (Operation::KeyScrubBackup, PROVIDER_OP_TIMEOUT),
        (
            Operation::ProviderReset {
                target: ResetTarget::Index(idx()),
            },
            PROVIDER_OP_TIMEOUT,
        ),
        (
            Operation::ProviderReset {
                target: ResetTarget::Label(label("work").expect("a valid label")),
            },
            PROVIDER_OP_TIMEOUT,
        ),
        // `test_timeout_ms` is ALWAYS the entry's validate-row `testTimeoutMs`, every entry kind
        // (`docs/gui-seam.md` §1d). A remote or CLI row is 80 000: 80 s, whatever the entry's own
        // `timeoutMs`.
        (test_op(80_000), PROVIDER_TEST_REMOTE_TIMEOUT),
        // A loopback row: the effective `timeoutMs` + 17 s, already summed by the engine, so taken
        // as given — including BELOW 80 s (a loopback `timeoutMs` under 63 s), which is why the
        // floor is 17 s and not the remote 80 s…
        (test_op(120_000 + 17_000), Duration::from_millis(137_000)),
        (test_op(5_000 + 17_000), Duration::from_millis(22_000)),
        // …capped at 30 minutes (plan Q12), so a hand-edited `timeoutMs` cannot hold the in-flight
        // guard for hours: exactly at the cap is the cap, anything above is the cap…
        (test_op(30 * 60_000), PROVIDER_TEST_LOOPBACK_CAP),
        (test_op(30 * 60_000 + 1), PROVIDER_TEST_LOOPBACK_CAP),
        (test_op(6 * 3_600_000), PROVIDER_TEST_LOOPBACK_CAP),
        (test_op(u64::MAX), PROVIDER_TEST_LOOPBACK_CAP),
        // …and never below the +17 s the engine always adds (its smallest possible answer), so a
        // zero cannot abandon a Test the moment it starts.
        (test_op(0), PROVIDER_TEST_LOOPBACK_EXTRA),
        (test_op(16_999), PROVIDER_TEST_LOOPBACK_EXTRA),
        // B1-M4-T11: the live git check is a read, bounded like the calendar reads; the engine's own
        // overall budget is 25 s, 5 s under this (`REPOS_STATUS_BUDGET_MS`, src/repos/status.ts).
        (
            Operation::ReposStatus {
                request: a_repos_request(),
            },
            ENGINE_READ_TIMEOUT,
        ),
        (
            Operation::CalendarDetails {
                skip_mac: false,
                skip_commands: false,
            },
            CALENDAR_DETAILS_TIMEOUT,
        ),
        (
            Operation::CalendarDetails {
                skip_mac: true,
                skip_commands: true,
            },
            CALENDAR_DETAILS_TIMEOUT,
        ),
    ];
    for (op, bound) in &bounds {
        assert_eq!(op.timeout(), Some(*bound), "{op:?} carries the wrong bound");
    }

    for op in every_operation() {
        if !op.name().starts_with("calendar-")
            && !op.name().starts_with("provider-")
            && !op.name().starts_with("repos-")
        {
            assert_eq!(
                op.timeout(),
                None,
                "{op:?} gained a bound at the invoke layer"
            );
        } else {
            assert!(op.timeout().is_some(), "{op:?} lost its own bound");
        }
    }

    let capped = EngineClient::with_program("/nowhere/engine".into())
        .with_timeout_cap(Duration::from_secs(1));
    assert_eq!(
        capped.effective_timeout(&Operation::CalendarConnectMac),
        Some(Duration::from_secs(1))
    );
    assert_eq!(
        capped.effective_timeout(&Operation::Status),
        None,
        "the cap invented a bound for an operation that has none"
    );
    let plain = EngineClient::with_program("/nowhere/engine".into());
    assert_eq!(
        plain.effective_timeout(&Operation::CalendarConnectMac),
        Some(CALENDAR_CONNECT_MAC_TIMEOUT)
    );
}

/// The one macOS-only operation answers `unsupported` off macOS — the `access.rs` precedent — and is
/// admitted on it. A pure decision with the platform as an operand, so BOTH answers are pinned on
/// whichever platform runs the suite; `tests/capability.rs` drives the command's non-macOS refusal
/// through IPC under `#[cfg(not(target_os = "macos"))]`.
#[test]
fn connect_mac_is_unsupported_off_macos_and_admitted_on_it() {
    assert_eq!(mac_only(true), Ok(()));
    let refused = mac_only(false).expect_err("off macOS the Mac source is refused");
    match &refused {
        EngineError::Unsupported { detail } => {
            assert!(detail.contains("macOS"), "{detail}");
            assert!(
                detail.contains("links"),
                "the refusal should say links still work: {detail}"
            );
        }
        other => panic!("expected Unsupported, got {other:?}"),
    }
    let wire = serde_json::to_value(&refused).expect("an EngineError serialises");
    assert_eq!(wire["kind"], "unsupported", "{wire}");
    // And the two new error variants read as sentences, not as Rust.
    assert_eq!(
        refused.to_string(),
        mac_only(false).unwrap_err().to_string()
    );
    let timeout = EngineError::Timeout {
        operation: "calendar-connect-mac".into(),
        seconds: 150,
    };
    assert_eq!(
        timeout.to_string(),
        "the engine's calendar-connect-mac did not finish within 150 s and was stopped"
    );
    assert_eq!(
        serde_json::to_value(&timeout).expect("serialises")["kind"],
        "timeout"
    );
}

/// Run a fresh fake to completion, so the run under a bound is not its first exec. On macOS a freshly
/// written script's first exec took a median of 703 ms and up to 1843 ms at load 6-9 (the second: 4 ms,
/// up to 24 ms), which left a 2.5 s bound firing before the fake had written its pid. The fake must exit
/// at once on `warm`.
#[cfg(unix)]
fn spend_first_exec(program: &std::path::Path) {
    let status = std::process::Command::new(program)
        .arg("warm")
        .status()
        .expect("the fake runs");
    assert!(status.success(), "warming the fake failed: {status}");
}

/// ⚠ THE BOUND IS APPLIED, NOT JUST DECLARED: a calendar operation that outlives it is ABANDONED —
/// its fake killed with its process group — and answers `Timeout`; a MUTATING one (connect mac)
/// releases the in-flight guard as it goes, so the next mutating call starts rather than `Busy`.
///
/// Driven with the harness cap at 2.5 s instead of 75 s / 150 s; the cap only shortens the bound
/// the operation declares (pinned above), so this is the shipped mechanism at a shorter duration.
/// (MEASURED: at 400 ms the bound fired before the fake had written its pid when the whole binary ran
/// in parallel — a slow spawn, not a defect — so the cap leaves the fake time to start.)
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_calendar_operation_past_its_bound_is_stopped_and_answers_timeout() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("caltimeout");
    let _reap = ReapTagged(scratch.tag());
    // `sleeper` is called for its tagged `<scratch>/sleep` symlink; its own script is unused.
    let _ = sleeper(&scratch.path, "unused.sh", 1);
    let pid_file = scratch.join("pid");
    let program = fake_sidecar(
        &scratch.path,
        "slow.sh",
        &format!(
            "[ \"$1\" = warm ] && exit 0\necho $$ > {}\nexec {} 30",
            sq(&pid_file.display().to_string()),
            sq(&scratch.join("sleep").display().to_string()),
        ),
    );
    spend_first_exec(&program);
    let client = EngineClient::with_program(program).with_timeout_cap(Duration::from_millis(2500));

    for op in [Operation::CalendarTest, Operation::CalendarConnectMac] {
        let _ = std::fs::remove_file(&pid_file);
        let started = std::time::Instant::now();
        let answer = client.invoke(op.clone(), &NoProgress).await;
        assert!(
            matches!(&answer, Err(EngineError::Timeout { operation, .. }) if operation == op.name()),
            "{op:?} past its bound must answer Timeout, got {answer:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{op:?} waited {:?} — the bound was not applied",
            started.elapsed()
        );
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap_or_else(|e| panic!("{op:?}: the fake never started ({e}) — vacuous"))
            .trim()
            .to_string();
        let mut gone = false;
        for _ in 0..40 {
            if process_gone(&pid) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            gone,
            "{op:?}: the abandoned fake (pid {pid}) is still running"
        );
    }

    // The abandoned connect released the guard: a new mutating call STARTS (and is still sleeping
    // when this gives up on it) instead of answering Busy.
    let uncapped = EngineClient::with_program(sleeper(&scratch.path, "slow2.sh", 30));
    let mut after = Box::pin(uncapped.invoke(Operation::CalendarConnectMac, &NoProgress));
    let verdict = tokio::time::timeout(Duration::from_millis(600), &mut after).await;
    assert!(
        verdict.is_err(),
        "after a timed-out connect, the next one should have STARTED, but it returned: {verdict:?}"
    );
    drop(after);
}

/* ── the operand validators ───────────────────────────────────────────────────────────────────── */

/// The `--json-out` validator B1 encoded in `capabilities/default.json`, kept here as the ORACLE
/// for the Rust port. Anchored the way `tauri-plugin-shell` anchored it (`scope.rs:92-97`:
/// `^{validator}$` when `raw` is unset).
const JSON_OUT_ORACLE: &str = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json";

/// The `--file` / `--api-key-file` validator, same provenance.
const FILE_ORACLE: &str =
    r"/([A-Za-z0-9_-][A-Za-z0-9._-]{0,63}/){0,15}[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}";

/// A DIFFERENTIAL test, not a second copy of the rules — and, for `--file`, a STATED divergence.
///
/// The capability regexes are gone from the shipped artifact — there is no shell scope any more —
/// so there is nothing left to compile at runtime and compare against. What is pinned instead:
///
///   * **`--json-out` is a faithful port**, character class for character class. Compiling the
///     original pattern and requiring agreement over a corpus is how that stays true.
///   * **`--file` is deliberately WIDER than B1's regex, and this test says exactly where.** The
///     regex refused every dot-leading segment (its way of excluding `..` without lookahead) and
///     every character outside `[A-Za-z0-9._-]`, whitespace included. That refused
///     `~/.config/daily-briefing/config.json` — the engine's own default config path — and
///     everything under `~/Library/Application Support/`, which is the engine's state directory
///     AND Tauri's `app_data_dir`. Neither refusal had a threat model: the value is one element of
///     an argv VECTOR handed to `execve` with no shell between (`src/engine.rs`, `invoke`), and
///     the engine reads the operand whole. So the port admits a U+0020 space, a dot-leading
///     segment and characters outside the ASCII class, and compares `.`/`..` literally instead.
///     The corpus below has a section for the values where the two AGREE and a section for the
///     values where the port ADMITS and the regex REFUSES, and asserts each section as such — a
///     port that narrowed anything the regex admitted would fail the first, and one that quietly
///     re-refused the app's own directories would fail the second.
///
/// PR 3's three provider operands (`--index`, `--id`, the reset label) had no capability regex to
/// port; their differential test is `the_provider_operand_validators_agree_with_the_engines_own_rules`,
/// whose oracles are read from the engine's source.
#[test]
fn the_operand_validators_agree_with_the_capability_regexes_they_port() {
    let json_out = regex::Regex::new(&format!("^{JSON_OUT_ORACLE}$")).expect("the oracle compiles");
    let file = regex::Regex::new(&format!("^{FILE_ORACLE}$")).expect("the oracle compiles");

    let json_out_corpus = [
        // accepted by both
        "envelope.json",
        "run-2026-09-15.json",
        "a.json",
        "A_b-c.2.json",
        "0.json",
        "a.json.json",
        // refused by both
        "../../../../etc/passwd",
        "../out.json",
        "/etc/passwd",
        "/tmp/out.json",
        "sub/dir/out.json",
        "..json",
        ".hidden.json",
        "-out.json",
        "out.json extra",
        "out.json\nrun",
        "out.txt",
        "out.json.exe",
        "",
        "a.json ",
        "a b.json",
        "a\tb.json",
        "a;b.json",
        "a|b.json",
        "a$b.json",
        "ünicode.json",
        ".json",
        "a/../b.json",
        // Unicode format characters. Refused by the port as `FormatCharacter` since round 2, and
        // refused by B1's regex all along — they are outside `[A-Za-z0-9._-]`. The assertion below
        // is `port.is_ok() == regex.is_match()`, so listing them HERE is what measures the second
        // half of that claim rather than asserting it.
        "a\u{200b}b.json",
        "\u{202e}evil.json",
        "a\u{feff}b.json",
    ];
    for value in json_out_corpus {
        assert_eq!(
            json_out_name(value).is_ok(),
            json_out.is_match(value),
            "the --json-out port and the capability regex disagree about {value:?}: port said \
             {:?}, regex said {}",
            json_out_name(value).err(),
            json_out.is_match(value)
        );
    }

    // Where the port and the regex AGREE.
    let file_agree_corpus = [
        // accepted by both
        "/Users/someone/keys/anthropic.key",
        "/etc/daily-briefing/config.json",
        "/a",
        "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p",
        // ⚠ ACCEPTED, and deliberately so — a segment MAY start with a dash. The capability's
        // class is `[A-Za-z0-9_-]`, and the leading-dash hazard does not apply here because the
        // VALUE always starts with `/`: `--file /-rf` can never be read as a flag by whatever
        // parses the argv next. `--json-out` is the opposite case (a bare filename, where a
        // leading dash IS the whole value's first character) and refuses it.
        "/-leading-dash",
        "/a/-b",
        // refused by both
        "/etc/../etc/passwd",
        "/a/../../etc/passwd",
        "/a/./b",
        "relative/path.json",
        "~/keys/anthropic.key",
        "/etc/passwd\nrun",
        "/a\tb",
        "/a\u{a0}b",
        "/a\u{1b}b",
        "/a\0b",
        "",
        "/",
        "//a",
        "/a/",
        "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q",
        // Unicode format characters — the round-2 narrowing. B1's regex refused them (they are
        // outside `[A-Za-z0-9._-]`), the port admitted them until round 2, and they are in the
        // AGREE corpus now rather than the widened one. That placement is the assertion: if the
        // port ever re-admits one, `port.is_ok() == regex.is_match()` fails here.
        "/a\u{200b}b",
        "/\u{202e}evil.json",
        "/a/\u{feff}b",
        "/a\u{00ad}b",
        "/a\u{2069}b",
    ];
    for value in file_agree_corpus {
        assert_eq!(
            config_file_path(value).is_ok(),
            file.is_match(value),
            "the --file port and the capability regex disagree about {value:?}: port said {:?}, \
             regex said {}",
            config_file_path(value).err(),
            file.is_match(value)
        );
    }

    // Where the port is WIDER, on purpose: the regex refuses, the port admits. Each of these is a
    // path a real user's config candidate can have, and none of them can change what `execve`
    // receives or what the engine reads.
    let file_widened_corpus = [
        // the engine's default config path: a dot-leading segment
        "/Users/x/.config/daily-briefing/config.json",
        "/.config/daily-briefing/config.json",
        "/Users/x/.local/share/candidate.json",
        // Tauri's app_data_dir and the engine's state dir on macOS: a U+0020 space
        "/Users/x/Library/Application Support/com.themarigold.daily-briefing/candidate.json",
        "/a b",
        // characters outside the ASCII class: a non-ASCII user name, a colon, an at-sign
        "/Users/josé/candidate.json",
        "/a:b",
        "/a@b",
        // three dots is a NAME, not traversal
        "/a/.../b",
    ];
    for value in file_widened_corpus {
        assert!(
            !file.is_match(value),
            "{value:?} is in the widened corpus but B1's regex ADMITS it — move it to the agree \
             corpus"
        );
        assert_eq!(
            config_file_path(value).map(|p| p.as_str().to_string()),
            Ok(value.to_string()),
            "the --file port re-refused {value:?}, which the design admits on purpose (see the \
             test doc); refusal: {:?}",
            config_file_path(value).err()
        );
    }

    // The port never NARROWS: nothing the regex admits is refused by the port, over both corpora.
    for value in file_agree_corpus.iter().chain(file_widened_corpus.iter()) {
        if file.is_match(value) {
            assert!(
                config_file_path(value).is_ok(),
                "the --file port refuses {value:?}, which B1's regex admitted — the port is only \
                 ever wider than the regex, never narrower"
            );
        }
    }

    // ⚠ prove-it 3b, on the corpus rather than on the code: a corpus of only-accepted or
    // only-refused values would make every assertion above agree vacuously.
    assert!(
        json_out_corpus.iter().any(|v| json_out.is_match(v))
            && json_out_corpus.iter().any(|v| !json_out.is_match(v)),
        "the --json-out corpus does not contain both accepted and refused values"
    );
    assert!(
        file_agree_corpus.iter().any(|v| file.is_match(v))
            && file_agree_corpus.iter().any(|v| !file.is_match(v)),
        "the --file agree corpus does not contain both accepted and refused values"
    );
    // The widened corpus is a literal array: its non-emptiness is a compile-time fact (clippy's
    // `const_is_empty` objects to asserting it), and every entry was asserted individually above.

    // And the ceilings are exercised, not merely documented.
    let long_segment = "a".repeat(65);
    assert_eq!(
        config_file_path(&format!("/{long_segment}")).err(),
        Some(InputRefusal::SegmentTooLong)
    );
    assert!(config_file_path(&format!("/{}", "a".repeat(64))).is_ok());
}

/// Every injection class the design names, each refused with its OWN reason.
///
/// A single `Err` would satisfy "it was refused" while telling a user nothing and telling a
/// reviewer less. The class is the point: `..` is refused for a different reason than a space is.
#[test]
fn json_out_refusals_name_their_class() {
    let cases = [
        ("out.json extra", InputRefusal::Whitespace),
        ("out.json\nrun", InputRefusal::Whitespace),
        ("out\t.json", InputRefusal::Whitespace),
        ("-out.json", InputRefusal::LeadingDash),
        ("../out.json", InputRefusal::DotSegment),
        (".hidden.json", InputRefusal::DotSegment),
        ("sub/out.json", InputRefusal::Separator),
        ("/tmp/out.json", InputRefusal::Separator),
        ("out.txt", InputRefusal::NotJsonExtension),
        ("out.json.exe", InputRefusal::NotJsonExtension),
        ("", InputRefusal::Empty),
        (".json", InputRefusal::Empty),
        ("a;b.json", InputRefusal::DisallowedCharacter),
        ("a b.json", InputRefusal::Whitespace),
        ("a\0b.json", InputRefusal::Nul),
        ("transcript-health.json", InputRefusal::EngineReadName),
    ];
    for (value, expected) in cases {
        assert_eq!(
            json_out_name(value).err(),
            Some(expected),
            "--json-out {value:?} was not refused as {expected:?}"
        );
    }
}

/// B25 round-1 fix M4, the two-way pin: `transcript-health.json` — the ONE engine-read state-dir
/// `.json` the engine's own `--json-out` guard does not refuse (its `engineOwns` list derives
/// from `statePaths()`, which has no entry for it; measured, a run with that name overwrote 14
/// seeded days of health history) — is refused GUI-SIDE, while the app's actual envelope name
/// stays accepted. Exact-name refusal only: the engine-side fix is the registered Phase C
/// follow-up (`docs/gui-seam.md` §16b dev 164).
#[test]
fn the_engine_read_health_file_is_refused_as_a_json_out_name() {
    assert_eq!(
        json_out_name("transcript-health.json").err(),
        Some(InputRefusal::EngineReadName)
    );
    // Case-insensitive: the default APFS volume is case-insensitive, so a case variant opens
    // (and would clobber) the same file.
    assert_eq!(
        json_out_name("Transcript-Health.json").err(),
        Some(InputRefusal::EngineReadName)
    );
    // The name the app (and the coexistence suite's planted presence) actually uses.
    assert!(json_out_name("run-envelope.json").is_ok());
    // One name, not a prefix rule — a coincidentally similar name is a legitimate envelope.
    assert!(json_out_name("transcript-health-report.json").is_ok());
}

#[test]
fn config_file_refusals_name_their_class() {
    let cases = [
        ("/etc/passwd\nrun", InputRefusal::Whitespace),
        ("/etc/passwd\tx", InputRefusal::Whitespace),
        ("/a\u{a0}b", InputRefusal::Whitespace),
        ("/a\u{1b}b", InputRefusal::ControlCharacter),
        ("/a\u{7f}b", InputRefusal::ControlCharacter),
        ("/etc/../etc/passwd", InputRefusal::Traversal),
        ("/a/./b", InputRefusal::Traversal),
        ("/..", InputRefusal::Traversal),
        ("/.", InputRefusal::Traversal),
        ("relative/x.json", InputRefusal::NotAbsolute),
        ("~/x.json", InputRefusal::NotAbsolute),
        ("", InputRefusal::Empty),
        ("/", InputRefusal::Empty),
        ("/a/", InputRefusal::Empty),
        ("//a", InputRefusal::Empty),
        ("/a\0b", InputRefusal::Nul),
        (
            "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q",
            InputRefusal::TooManySegments,
        ),
    ];
    for (value, expected) in cases {
        assert_eq!(
            config_file_path(value).err(),
            Some(expected),
            "--file {value:?} was not refused as {expected:?}"
        );
    }
}

/// The engine's DEFAULT config path — `$HOME/.config/daily-briefing/config.json` when
/// `XDG_CONFIG_HOME` is unset (`src/config.ts`, `configPath()`) — is admitted. B1's regex refused
/// it for the dot-leading segment; a validator that refuses the one path every user has is not a
/// validator anyone can use.
#[test]
fn the_default_config_path_is_admitted() {
    let path = "/Users/x/.config/daily-briefing/config.json";
    assert_eq!(
        config_file_path(path).map(|p| p.as_str().to_string()),
        Ok(path.to_string())
    );
}

/// Tauri's `app_data_dir` / `app_config_dir` on macOS — and the engine's own state directory —
/// sit under `~/Library/Application Support/`, with a space. Admitted: the value is one argv
/// element handed to `execve` as a vector, so there is no shell to split it.
#[test]
fn the_app_data_dir_is_admitted() {
    let path = "/Users/x/Library/Application Support/com.themarigold.daily-briefing/candidate.json";
    assert_eq!(
        config_file_path(path).map(|p| p.as_str().to_string()),
        Ok(path.to_string())
    );
}

/// `.` and `..` are refused as SEGMENTS, by comparison, wherever they sit — and only they: a
/// dot-leading name is not traversal.
#[test]
fn dot_and_dotdot_segments_are_refused() {
    for value in [
        "/..",
        "/.",
        "/../etc/passwd",
        "/etc/../etc/passwd",
        "/etc/passwd/..",
        "/a/./b",
        "/./a",
        "/a/.",
    ] {
        assert_eq!(
            config_file_path(value).err(),
            Some(InputRefusal::Traversal),
            "--file {value:?} must be refused as Traversal"
        );
    }
    for value in ["/.config/x", "/a/.hidden", "/a/..b", "/a/...", "/a/b.."] {
        assert!(
            config_file_path(value).is_ok(),
            "--file {value:?} is a dot-leading NAME, not traversal, and must be admitted: {:?}",
            config_file_path(value).err()
        );
    }
}

/// Every `char::is_control` character is refused. NUL is caught first as its own class; a tab or a
/// newline is both whitespace and control and is reported as whitespace (checked first); the rest
/// are `ControlCharacter`.
#[test]
fn control_characters_are_refused() {
    for c in ['\u{1}', '\u{8}', '\u{1b}', '\u{7f}', '\u{85}', '\u{9f}'] {
        let value = format!("/a{c}b");
        let expected = if c.is_whitespace() {
            InputRefusal::Whitespace
        } else {
            InputRefusal::ControlCharacter
        };
        assert_eq!(
            config_file_path(&value).err(),
            Some(expected),
            "--file with U+{:04X} was not refused as {expected:?}",
            c as u32
        );
    }
    assert_eq!(
        config_file_path("/a\0b").err(),
        Some(InputRefusal::Nul),
        "NUL keeps its own class"
    );
    // prove-it 3b: the loop above is only a check if the characters really are control characters.
    assert!(['\u{1}', '\u{1b}', '\u{7f}', '\u{85}']
        .iter()
        .all(|c| c.is_control()));
}

/// Every character in [`REFUSED_FORMAT_CHARACTERS`], in three positions, refused as
/// `FormatCharacter` — and `--json-out` reports the SAME class for the same character.
///
/// ⚠ WHY THIS CLASS EXISTS, MEASURED rather than reasoned. Before round 2, `config_file_path`
/// ADMITTED every character below: `char::is_control` is `Cc` only and a format character is `Cf`,
/// and `char::is_whitespace` is `White_Space`, which U+200B and U+202E are not. End to end,
/// `config validate --json --file /<U+202E>evil.json` against the real sidecar exits 2 and writes
/// the path VERBATIM TWICE to stderr — the engine's `stripControl` (`src/render.ts`) strips
/// `[\x00-\x1f\x7f-\x9f]` and nothing else — and that stderr reaches the webview as
/// `EngineOutcome.stderr` and as each `ProgressEvent.line`. `capabilities/README.md` used to defer
/// this "if a screen ever renders the path back"; the engine's own diagnostics already do.
///
/// ⚠ BOTH VALIDATORS REPORT THE SAME CLASS, deliberately. `--json-out` already refused all of them
/// as `DisallowedCharacter` ("outside [A-Za-z0-9._-]"), so no verdict changed — only the reason.
/// `InputRefusal`'s design is one variant per class *because the class is what a caller can act
/// on*, and this is the one refusal whose offending character is INVISIBLE: "outside
/// [A-Za-z0-9._-]" tells someone staring at a name that looks correct precisely nothing.
#[test]
fn format_characters_are_refused() {
    let mut measured = 0usize;
    for (lo, hi) in REFUSED_FORMAT_CHARACTERS {
        for c in *lo..=*hi {
            measured += 1;
            // prove-it 3b: this test measures the format check only if nothing EARLIER in
            // `config_file_path` would have refused these anyway. A character that is also control
            // or whitespace would be caught first and the loop would pass without exercising the
            // list at all.
            assert!(
                !c.is_control() && !c.is_whitespace(),
                "U+{:04X} is a control character or whitespace, so it is refused before the format \
                 check runs and its presence in REFUSED_FORMAT_CHARACTERS measures nothing",
                c as u32
            );
            assert!(is_refused_format_character(c), "U+{:04X}", c as u32);

            // leading in the first segment; interior in a later one; a whole segment on its own.
            for value in [
                format!("/{c}evil.json"),
                format!("/Users/x/a{c}b/config.json"),
                format!("/a/{c}/b"),
            ] {
                assert_eq!(
                    config_file_path(&value).err(),
                    Some(InputRefusal::FormatCharacter),
                    "--file {value:?} (U+{:04X}) was not refused as FormatCharacter",
                    c as u32
                );
            }

            for name in [format!("a{c}b.json"), format!("{c}b.json")] {
                assert_eq!(
                    json_out_name(&name).err(),
                    Some(InputRefusal::FormatCharacter),
                    "--json-out {name:?} (U+{:04X}) was not refused as FormatCharacter",
                    c as u32
                );
            }
        }
    }
    assert_eq!(
        measured, 123,
        "REFUSED_FORMAT_CHARACTERS covers a different number of code points than this test was \
         written against. That is fine — widen it deliberately, and update this number so the \
         next change is deliberate too."
    );

    // The gap between the two 206x ranges is real, not an oversight: U+2065 is UNASSIGNED, and a
    // single 2060–2069 span would claim a code point nobody has defined. It is admitted like any
    // other non-ASCII character.
    assert!(!is_refused_format_character('\u{2065}'));
    assert!(config_file_path("/a\u{2065}b").is_ok());

    // And the narrowing is narrow: an ordinary non-ASCII path is still admitted, which is the
    // whole reason `--file` dropped B1's ASCII class in round 1.
    assert!(config_file_path("/Users/josé/candidate.json").is_ok());
}

/* ── the provider operands (PR 3, P3-M1-T1) ───────────────────────────────────────────────────── */

/// The engine source file `rel` (relative to `daily_briefing_application/`), read at test time.
///
/// ⚠ THE ORACLES BELOW ARE THE ENGINE'S OWN RULES, READ FROM ITS SOURCE — not a second hand-typed
/// copy of them. The Rust validators port `docs/gui-seam.md` §1d's grammar, and nothing else links
/// the two languages; reading the TypeScript here is what makes a change on one side fail on the
/// other (the `tests/engine_env.rs` precedent for the launchd PATH).
fn engine_source(rel: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("the engine source {} is readable: {e}", path.display()))
}

/// The value of `export const <name> = <expr>;` in an engine source file, where `<expr>` is a
/// product of integer literals (`30 * 60_000`). Anything else is a parse failure, loudly — a
/// constant rewritten as `minutes(30)` must fail here rather than read as some other number.
fn engine_const(rel: &str, name: &str) -> u64 {
    let source = engine_source(rel);
    let prefix = format!("export const {name} = ");
    let line = source
        .lines()
        .find(|l| l.starts_with(&prefix))
        .unwrap_or_else(|| panic!("{rel} has no `{prefix}…;` line"));
    let expr = line[prefix.len()..]
        .strip_suffix(';')
        .unwrap_or_else(|| panic!("{rel}: `{line}` does not end in `;`"));
    expr.split('*')
        .map(|factor| {
            factor
                .trim()
                .replace('_', "")
                .parse::<u64>()
                .unwrap_or_else(|_| panic!("{rel}: `{line}` is not a product of integer literals"))
        })
        .product()
}

/// The `key delete --id` and provider `--index` validators against the ENGINE's regexes, read from
/// its source, and the label rules the engine's `--label-stdin` reader applies.
///
/// ⚠ `\d` IS TRANSLATED, AND THAT IS THE ONE EDIT TO THE ORACLE. The engine's `/^\d{1,6}$/` has no
/// `u` flag, so in JavaScript `\d` is ASCII `[0-9]` only; Rust's `regex` crate reads `\d` as ANY
/// Unicode decimal digit (`٣`, `７`), which would make the oracle wider than the engine. The
/// translation is asserted to have happened, so a rewritten engine regex cannot slip past it.
#[test]
fn the_provider_operand_validators_agree_with_the_engines_own_rules() {
    // ── key ids: `KEY_ID_SOURCE` (src/keyFile.ts), anchored as `KEY_ID_RE` anchors it.
    let key_file = engine_source("src/keyFile.ts");
    let source_line = key_file
        .lines()
        .find(|l| l.starts_with("export const KEY_ID_SOURCE = \""))
        .expect("src/keyFile.ts declares KEY_ID_SOURCE as a string literal");
    let key_id_source = source_line
        .trim_start_matches("export const KEY_ID_SOURCE = \"")
        .trim_end_matches("\";");
    assert!(
        key_file.contains("export const KEY_ID_RE = new RegExp(`^${KEY_ID_SOURCE}$`);"),
        "KEY_ID_RE is no longer `^KEY_ID_SOURCE$` with no flags — re-read the engine's rule"
    );
    let key_oracle = regex::Regex::new(&format!("^{key_id_source}$")).expect("the oracle compiles");
    let key_corpus = [
        "k-0123456789ab",
        "k-000000000000",
        "k-ffffffffffff",
        "k-abcdefabcdef",
        "k-0123456789AB", // uppercase: the engine's rule is LOWERCASE hex
        "K-0123456789ab",
        "k-0123456789a",
        "k-0123456789abc",
        "k-0123456789ag",
        "k_0123456789ab",
        "0123456789ab",
        "k-",
        "",
        " k-0123456789ab",
        "k-0123456789ab ",
        "k-0123456789ab\n",
        "--k-0123456789ab",
        "k-01234567８９ab",
        "k-0123456789ab.key",
        "../k-0123456789ab",
    ];
    for value in key_corpus {
        assert_eq!(
            key_id(value).is_ok(),
            key_oracle.is_match(value),
            "the key-id validator and the engine's KEY_ID_RE disagree about {value:?}"
        );
        if let Ok(id) = key_id(value) {
            assert_eq!(id.as_str(), value);
        } else {
            assert_eq!(
                key_id(value).err(),
                Some(InputRefusal::NotKeyId),
                "{value:?}"
            );
        }
    }
    assert!(
        key_corpus.iter().any(|v| key_oracle.is_match(v))
            && key_corpus.iter().any(|v| !key_oracle.is_match(v)),
        "the key-id corpus needs both accepted and refused values"
    );

    // ── indexes: `parseIndex`'s regex (src/providerCli.ts).
    let cli = engine_source("src/providerCli.ts");
    let parse_index = &cli[cli
        .find("function parseIndex(")
        .expect("src/providerCli.ts defines parseIndex")..];
    let body = &parse_index[..parse_index.find("\n}").expect("parseIndex ends")];
    let open = body.find("/^").expect("parseIndex tests a regex literal");
    let close = body[open..]
        .find("$/")
        .expect("the regex literal is anchored")
        + open;
    let js = &body[open + 1..close + 1];
    assert_eq!(
        js, r"^\d{1,6}$",
        "the engine's index rule changed: re-port it"
    );
    let ascii = js.replace(r"\d", "[0-9]");
    assert_ne!(ascii, js, "the `\\d` translation did not happen");
    let index_oracle = regex::Regex::new(&ascii).expect("the oracle compiles");
    for n in [
        0_u64,
        1,
        9,
        10,
        99_999,
        100_000,
        999_998,
        999_999,
        1_000_000,
        9_999_999,
        u64::from(u32::MAX),
        u64::from(u32::MAX) + 1,
        u64::MAX,
    ] {
        let rendered = n.to_string();
        assert_eq!(
            provider_index(n).is_ok(),
            index_oracle.is_match(&rendered),
            "the index validator and the engine's parseIndex disagree about {n}"
        );
        if let Ok(index) = provider_index(n) {
            assert_eq!(
                index.to_string(),
                rendered,
                "an index renders as plain decimal"
            );
            assert_eq!(u64::from(index.get()), n);
        } else {
            assert_eq!(provider_index(n).err(), Some(InputRefusal::IndexOutOfRange));
        }
    }
    assert_eq!(u64::from(MAX_PROVIDER_INDEX), 999_999);

    // ── the two stdin caps, the engine's numbers.
    assert_eq!(
        engine_const("src/providerCli.ts", "LABEL_STDIN_MAX_BYTES"),
        LABEL_STDIN_MAX_BYTES as u64
    );
    assert_eq!(
        engine_const("src/providerCli.ts", "KEY_STDIN_MAX_BYTES"),
        KEY_STDIN_MAX_BYTES as u64
    );
}

/// A reset label: non-empty, no NUL, and its `{"label": …}` payload within the engine's 64 KiB —
/// measured on the PAYLOAD, which is what the engine counts (`Buffer.byteLength` of stdin).
#[test]
fn label_refusals_name_their_class_and_the_cap_is_measured_on_the_payload() {
    assert_eq!(label("").err(), Some(InputRefusal::Empty));
    assert_eq!(label("a\0b").err(), Some(InputRefusal::Nul));
    assert_eq!(label("\0").err(), Some(InputRefusal::Nul));
    // Flag-shaped, whitespace-bearing, quoting and non-ASCII labels are all LABELS: the engine's
    // reader takes any non-empty string, and argv never sees one.
    for ok in [
        "-h",
        "--help",
        "-v",
        "--version",
        "--old",
        " ",
        "a b",
        "\"",
        "\\",
        "ünï",
        "\u{1}",
    ] {
        assert!(label(ok).is_ok(), "{ok:?} is a legal label and was refused");
    }

    // `{"label":"` + L + `"}` is 12 + L bytes for a label that needs no escaping.
    let wrapper = br#"{"label":""}"#.len();
    assert_eq!(wrapper, 12);
    let at_cap = "a".repeat(LABEL_STDIN_MAX_BYTES - wrapper);
    let payload = label(&at_cap)
        .expect("a label whose payload is exactly 64 KiB")
        .stdin_payload();
    assert_eq!(payload.len(), LABEL_STDIN_MAX_BYTES);
    assert_eq!(
        label(&format!("{at_cap}a")).err(),
        Some(InputRefusal::TooLarge),
        "one byte over the engine's cap"
    );
    // ⚠ ESCAPING COUNTS. A control byte serialises as `\u0001` — six bytes — so a label of 10,921
    // of them is 10,921 bytes long and a 65,538-byte payload. A cap on the label's own length
    // would admit it and the engine would refuse it as too large.
    let escaped_ok = "\u{1}".repeat((LABEL_STDIN_MAX_BYTES - wrapper) / 6);
    assert!(label(&escaped_ok).is_ok());
    let escaped_over = "\u{1}".repeat((LABEL_STDIN_MAX_BYTES - wrapper) / 6 + 1);
    assert!(escaped_over.len() < LABEL_STDIN_MAX_BYTES);
    assert_eq!(label(&escaped_over).err(), Some(InputRefusal::TooLarge));

    // The payload is exactly `{"label": <the label>}` and nothing else (the engine refuses any
    // other member).
    for text in ["--help", "a\"b", "line\nbreak", "ünï", "\u{1}"] {
        let parsed: serde_json::Value =
            serde_json::from_slice(&label(text).expect("legal").stdin_payload()).expect("JSON");
        assert_eq!(parsed, serde_json::json!({ "label": text }), "{text:?}");
    }

    // A label is user text that may itself be a key (spec §4): its Debug prints a length only.
    let shown = format!(
        "{:?}",
        label("sk-ant-api03-LABEL-THAT-IS-A-KEY").expect("legal")
    );
    assert!(!shown.contains("sk-ant"), "{shown}");
    let op = Operation::ProviderReset {
        target: ResetTarget::Label(label("sk-ant-api03-LABEL-THAT-IS-A-KEY").expect("legal")),
    };
    assert!(!format!("{op:?}").contains("sk-ant"), "{op:?}");

    // And the refusals read as sentences, never echoing the value.
    for reason in [
        InputRefusal::IndexOutOfRange,
        InputRefusal::NotKeyId,
        InputRefusal::TooLarge,
    ] {
        assert!(!reason.message().is_empty());
    }
}

/// ⚠ HUB Q20: A LABEL NEVER REACHES ARGV. The labels most likely to be misread — `-h`, `--help`,
/// `-v`, `--version`, which the engine's dispatch reads ANYWHERE in argv as help/version, and
/// `--old` — produce an argv of fixed literals plus `--label-stdin`, and the label itself is the
/// stdin payload. Checked on `argv()` and on `command_line` (the caffeinate-wrapped form the spawn
/// actually executes).
#[test]
fn a_reset_label_is_never_an_argv_operand() {
    let client = EngineClient::with_program("/nowhere/engine".into());
    for text in [
        "-h",
        "--help",
        "-v",
        "--version",
        "--old",
        "work",
        "provider",
    ] {
        let op = Operation::ProviderReset {
            target: ResetTarget::Label(label(text).expect("a legal label")),
        };
        assert_eq!(
            op.argv(),
            ["provider", "reset", "--label-stdin", "--json"],
            "{text:?}"
        );
        let (_, executed) = client.command_line(&op);
        assert!(
            executed.ends_with(&["provider", "reset", "--label-stdin", "--json"].map(String::from)),
            "{text:?}: {executed:?}"
        );
        if text != "provider" {
            assert!(
                !executed.iter().any(|a| a == text),
                "the label {text:?} reached argv: {executed:?}"
            );
        }
        let payload: serde_json::Value = serde_json::from_slice(
            &op.stdin_payload()
                .expect("a label reset has a stdin payload"),
        )
        .expect("JSON");
        assert_eq!(payload, serde_json::json!({ "label": text }));
    }
    // An index reset carries its operand in argv and reads no stdin; no other operation does.
    let by_index = Operation::ProviderReset {
        target: ResetTarget::Index(provider_index(4).expect("valid")),
    };
    assert_eq!(by_index.stdin_payload(), None);
    for op in every_operation() {
        // B1-M4-T11: `repos status`'s operand, the request, rides on stdin (pinned in
        // `the_repos_request_is_the_engines_stdin_contract`); it is the one exclusion, by name.
        if op.name() == "repos-status" {
            assert!(op.stdin_payload().is_some(), "{op:?} lost its stdin operand");
            assert!(!op.takes_key() && !op.kills_its_group_on_return(), "{op:?}");
            continue;
        }
        assert_eq!(op.stdin_payload(), None, "{op:?} gained a stdin payload");
        assert_eq!(op.takes_key(), matches!(op, Operation::KeySet), "{op:?}");
        assert_eq!(
            op.kills_its_group_on_return(),
            matches!(op, Operation::ProviderTest { .. }),
            "{op:?}"
        );
    }
}

/// `KeySecret` has no `Debug` — a COMPILE-TIME fact, read here through the inherent-const probe the
/// `impls` crate uses (an inherent associated const bounded on `T: Debug` shadows the blanket
/// trait's `false`, and is only selected when the bound holds). Decoys both ways first, so a probe
/// that always answered one value would fail.
#[test]
fn the_key_secret_cannot_be_debug_printed() {
    use std::marker::PhantomData;
    trait NotDebug {
        const IS_DEBUG: bool = false;
    }
    struct Probe<T>(PhantomData<T>);
    impl<T> NotDebug for Probe<T> {}
    impl<T: std::fmt::Debug> Probe<T> {
        #[allow(dead_code)]
        const IS_DEBUG: bool = true;
    }
    struct Plain;
    assert!(
        Probe::<String>::IS_DEBUG,
        "the probe cannot see a Debug impl"
    );
    assert!(!Probe::<Plain>::IS_DEBUG, "the probe sees Debug everywhere");
    assert!(
        !Probe::<KeySecret>::IS_DEBUG,
        "KeySecret implements Debug — the key could be printed by any `{{:?}}`"
    );
    // Operation stays Debug (it carries no key), and that is what makes the separation necessary.
    assert!(Probe::<Operation>::IS_DEBUG);

    assert_eq!(
        KeySecret::new(String::new()).err(),
        Some(InputRefusal::Empty)
    );
    assert_eq!(
        KeySecret::new("a".repeat(KEY_STDIN_MAX_BYTES + 1)).err(),
        Some(InputRefusal::TooLarge)
    );
    assert!(KeySecret::new("a".repeat(KEY_STDIN_MAX_BYTES)).is_ok());
}

/* ── wave 2, C-M3-T7: the sealed details path ──────────────────────────────────────────────────── */

/// A remembered command-link URL that must never surface: in an error, a `Debug`, an argv, a log.
const MARKER_URL: &str = "https://vault.example/secret-MARKER-9f3a/calendar.ics";

/// One sealed `calendar details --json` document (`src/calendar/details.ts`'s `CalendarDetailsJson`),
/// whose one command link reports `url`.
fn sealed_document(url: &str) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "readAt": "2026-10-24T09:00:00.000Z",
        "events": [{
            "title": "Standup", "location": null, "rowText": "09:30–09:45 Standup",
            "time": { "kind": "timed", "startMs": 1_000, "endMs": 2_000 },
            "status": "confirmed", "ended": false, "fromMac": false,
            "people": [{ "name": "Priya Shah", "organiser": true }, { "name": null, "organiser": false }],
            "notes": "Agenda first",
            "join": { "kind": "known", "url": "https://zoom.us/j/123", "host": "zoom.us" }
        }],
        "sources": [
            { "id": "work", "kind": "link", "status": "incomplete", "reason": "unreachable" },
            { "id": "macos", "kind": "macos", "skipped": true }
        ],
        "readerOutdated": false,
        "links": [{ "id": "work", "entryHash": "a".repeat(64), "url": url }]
    })
    .to_string()
}

/// `{"links":[…]}`, the handback document, as raw bytes in a zeroing buffer.
fn handback_of(url: &str) -> LinkHandback {
    let doc = format!(
        "{{\"links\":[{{\"id\":\"work\",\"entryHash\":\"{}\",\"url\":\"{url}\"}}]}}",
        "a".repeat(64)
    );
    LinkHandback::new(SecretBytes::from_vec(doc.into_bytes()))
}

fn details(skip_mac: bool, skip_commands: bool) -> Operation {
    Operation::CalendarDetails {
        skip_mac,
        skip_commands,
    }
}

/// ⚠ NOTHING THAT HOLDS A REMEMBERED URL CAN BE PRINTED OR SERIALISED — compile-time facts, read
/// through the same inherent-const probe as `KeySecret`'s, for `Debug`, `Display` and `Serialize`,
/// each with a positive decoy (a type that has the trait: the probe says yes) and a negative one (a
/// plain struct: the probe says no), so a probe that always answers one value fails here first.
#[test]
fn the_sealed_details_types_cannot_be_printed_or_serialised() {
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
    struct DProbe<T>(PhantomData<T>);
    trait NotDisplay {
        const IS_DISPLAY: bool = false;
    }
    impl<T> NotDisplay for DProbe<T> {}
    impl<T: std::fmt::Display> DProbe<T> {
        #[allow(dead_code)]
        const IS_DISPLAY: bool = true;
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
    // The decoys, both ways, for each probe.
    assert!(Probe::<String>::IS_DEBUG && !Probe::<Plain>::IS_DEBUG);
    assert!(DProbe::<String>::IS_DISPLAY && !DProbe::<Plain>::IS_DISPLAY);
    assert!(SProbe::<String>::IS_SERIALIZE && !SProbe::<Plain>::IS_SERIALIZE);

    assert!(!Probe::<LinkHandback>::IS_DEBUG, "LinkHandback implements Debug");
    assert!(!DProbe::<LinkHandback>::IS_DISPLAY, "LinkHandback implements Display");
    assert!(!SProbe::<LinkHandback>::IS_SERIALIZE, "LinkHandback implements Serialize");
    assert!(!Probe::<DetailsRaw>::IS_DEBUG, "DetailsRaw implements Debug");
    assert!(!DProbe::<DetailsRaw>::IS_DISPLAY, "DetailsRaw implements Display");
    assert!(!SProbe::<DetailsRaw>::IS_SERIALIZE, "DetailsRaw implements Serialize");
    assert!(!Probe::<SecretBytes>::IS_DEBUG, "SecretBytes implements Debug");
    assert!(!DProbe::<SecretBytes>::IS_DISPLAY, "SecretBytes implements Display");
    assert!(!SProbe::<SecretBytes>::IS_SERIALIZE, "SecretBytes implements Serialize");
    // The failure IS printable — and holds no text from the child (its variants are fixed codes).
    assert!(Probe::<DetailsFailure>::IS_DEBUG);
}

/// The attributes and impls a sealed type is declared with, read from `src/engine.rs` as code.
/// Returns the offending derive or impl, if any. ⚠ Strings and comments are removed first
/// (`common::code_only`), so a doc comment that MENTIONS `Debug` is not a finding.
fn printable_traits_of(code: &str, name: &str) -> Vec<String> {
    let mut found = Vec::new();
    let lines: Vec<&str> = code.lines().collect();
    let is_decl = |l: &str| {
        let t = l.trim_start();
        let t = t.strip_prefix("pub(crate) ").or_else(|| t.strip_prefix("pub ")).unwrap_or(t);
        [format!("struct {name}"), format!("enum {name}")]
            .iter()
            .any(|d| t.starts_with(d.as_str()) && !t[d.len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_'))
    };
    let decls: Vec<usize> = (0..lines.len()).filter(|&i| is_decl(lines[i])).collect();
    assert_eq!(decls.len(), 1, "`{name}` is declared {} times in the scan", decls.len());
    let mut i = decls[0];
    while i > 0 {
        i -= 1;
        let t = lines[i].trim();
        if t.is_empty() {
            continue;
        }
        if !t.starts_with("#[") {
            break;
        }
        for banned in ["Debug", "Clone", "Serialize"] {
            if t.starts_with("#[derive(") && t.contains(banned) {
                found.push(format!("{name}: {t}"));
            }
        }
    }
    let impls = regex::Regex::new(&format!(
        r"impl\s*(?:<[^>]*>)?\s*(?:[A-Za-z_]+::)*(Debug|Display|Serialize|Clone)\s+for\s+{name}\b"
    ))
    .expect("a valid regex");
    for m in impls.find_iter(code) {
        found.push(m.as_str().to_string());
    }
    found
}

/// ⚠ NO SEALED TYPE DERIVES OR HAND-IMPLEMENTS `Debug`, `Clone` OR `Serialize` (or `Display`), the
/// private ones included — the probes above reach only the `pub` ones. Decoys first.
#[test]
fn no_sealed_details_type_derives_or_implements_a_printable_trait() {
    let decoy = "#[derive(Debug, Deserialize)]\npub struct RawLink { id: String }\n";
    assert_eq!(printable_traits_of(decoy, "RawLink").len(), 1, "the scan cannot see a derive");
    let decoy = "pub struct RawLink(String);\nimpl std::fmt::Debug for RawLink { fn fmt() {} }\n";
    assert_eq!(printable_traits_of(decoy, "RawLink").len(), 1, "the scan cannot see an impl");
    let decoy = "#[derive(Deserialize)]\n#[serde(rename_all = \"camelCase\")]\nstruct RawLink { id: String }\nimpl Clone for RawLinkish {}\n";
    assert!(printable_traits_of(decoy, "RawLink").is_empty(), "the scan flags a clean type");

    let code = common::code_only(&std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/engine.rs"),
    )
    .expect("src/engine.rs is readable"));
    for name in [
        "SecretBytes",
        "LinkHandback",
        "DetailsRaw",
        "DetailsDoc",
        "DetailsRead",
        "RawEvent",
        "RawPerson",
        "RawOtherNote",
        "RawJoin",
        "RawSource",
        "RawLink",
        "WireRead",
        "WireRefused",
        "SealedDetails",
        "StdinPayload",
    ] {
        let found = printable_traits_of(&code, name);
        assert!(found.is_empty(), "a sealed type is printable: {found:?}");
    }
}

/// ⚠ ONE VOLATILE LOOP WIPES BOTH SECRETS (plan C-M3-T7, R4-M7): `KeySecret`'s overwrite moved,
/// unchanged, into `wipe_bytes`, and `KeySecret`'s `Drop` and `SecretBytes::wipe` both call it, so a
/// second copy that drifted (a plain `fill(0)` the optimiser may drop) cannot exist.
#[test]
fn one_volatile_loop_wipes_both_secrets() {
    fn body_after<'a>(code: &'a str, head: &str) -> &'a str {
        let at = code.find(head).unwrap_or_else(|| panic!("no `{head}` in src/engine.rs"));
        let open = at + code[at..].find('{').expect("a body");
        let mut depth = 0usize;
        for (i, c) in code[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return &code[open..=open + i];
                    }
                }
                _ => {}
            }
        }
        panic!("unbalanced braces after `{head}`")
    }
    let code = common::code_only(&std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/engine.rs"),
    )
    .expect("src/engine.rs is readable"));
    assert_eq!(code.matches("write_volatile").count(), 1, "there must be exactly one volatile loop");
    assert!(body_after(&code, "fn wipe_bytes(").contains("write_volatile"));
    assert!(body_after(&code, "impl Drop for KeySecret").contains("wipe_bytes("));
    assert!(body_after(&code, "fn wipe(&mut self)").contains("wipe_bytes("));
    assert!(body_after(&code, "impl Drop for SecretBytes").contains(".wipe()"));
}

/// `DetailsRaw::parse` takes the sealed document, or the calendar-off refusal, and nothing else —
/// and a refusal of anything else is the fixed `Malformed`, never the parser's text (a serde error
/// can quote the offending value, which here could be a URL).
#[test]
fn details_raw_parse_takes_only_the_sealed_document() {
    let raw = DetailsRaw::parse(sealed_document(MARKER_URL).as_bytes())
        .unwrap_or_else(|f| panic!("the sealed document parses: {f:?}"));
    assert!(!raw.calendar_off());
    let off = DetailsRaw::parse(br#"{"schemaVersion":1,"refused":"calendar-off"}"#)
        .unwrap_or_else(|f| panic!("the refusal parses: {f:?}"));
    assert!(off.calendar_off());
    let mut wrong_version: serde_json::Value =
        serde_json::from_str(&sealed_document(MARKER_URL)).expect("JSON");
    wrong_version["schemaVersion"] = serde_json::json!(2);
    let mut no_events = wrong_version.clone();
    no_events["schemaVersion"] = serde_json::json!(1);
    no_events.as_object_mut().expect("an object").remove("events");
    let mut both = no_events.clone();
    both["events"] = serde_json::json!([]);
    both["sources"] = serde_json::json!([{ "id": "x", "kind": "link", "status": "ok", "skipped": true }]);
    let mut bad_url_type = both.clone();
    bad_url_type["sources"] = serde_json::json!([]);
    bad_url_type["links"] = serde_json::json!([{ "id": "work", "entryHash": "a".repeat(64), "url": [MARKER_URL] }]);
    for bad in [
        wrong_version.to_string(),
        no_events.to_string(),
        both.to_string(),
        bad_url_type.to_string(),
        r#"{"schemaVersion":1,"refused":"something-else"}"#.to_string(),
        format!("not json {MARKER_URL}"),
        String::new(),
    ] {
        match DetailsRaw::parse(bad.as_bytes()) {
            Ok(_) => panic!("parsed a document it must refuse: {bad:.120}"),
            Err(f) => {
                assert_eq!(f, DetailsFailure::Malformed);
                assert!(!format!("{f:?}").contains("MARKER"));
            }
        }
    }
}

/// ⚠ ONLY `CalendarDetails` TAKES A HANDBACK, BOTH WAYS, BEFORE ANY SPAWN: `invoke_sealed` refuses
/// every other operation, and `invoke` / `invoke_with_key` refuse `CalendarDetails` (it must not run
/// through `classify`, whose `EngineOutcome` keeps stdout verbatim). On a client whose program and
/// caffeinate are absent, so a spawn attempt answers `Spawn` and cannot pass for a refusal.
#[tokio::test(flavor = "multi_thread")]
async fn only_calendar_details_takes_a_handback() {
    let scratch = ScratchDir::new("handbackonly");
    let absent = EngineClient::with_program(scratch.join("absent-program"))
        .with_caffeinate_path(scratch.join("absent-caffeinate"));
    match absent.invoke_sealed(details(false, false), handback_of(MARKER_URL)).await {
        Err(EngineError::Spawn { detail }) => assert!(!detail.contains("MARKER"), "{detail}"),
        Err(other) => panic!("the control must fail AT the spawn, got {other:?}"),
        Ok(_) => panic!("the control must fail AT the spawn, and it answered"),
    }
    let mut seen_details = 0;
    for op in every_operation() {
        if matches!(op, Operation::CalendarDetails { .. }) {
            seen_details += 1;
            for answer in [
                absent.invoke(op.clone(), &NoProgress).await,
                absent
                    .invoke_with_key(
                        op.clone(),
                        KeySecret::new("sk-test-0123456789".into()).expect("a key"),
                        &NoProgress,
                    )
                    .await,
            ] {
                match answer {
                    Err(EngineError::InvalidInput { field, reason }) => {
                        assert_eq!(field, "handback");
                        assert_eq!(reason, "is required for this operation");
                    }
                    other => panic!("{op:?} without a handback: expected InvalidInput, got {other:?}"),
                }
            }
            continue;
        }
        match absent.invoke_sealed(op.clone(), handback_of(MARKER_URL)).await {
            Err(EngineError::InvalidInput { field, reason }) => {
                assert_eq!(field, "handback", "{op:?}");
                assert_eq!(reason, format!("is not an input of {}", op.name()));
                assert!(!reason.contains("MARKER"));
            }
            Err(other) => panic!("{op:?} with a handback: expected InvalidInput, got {other:?}"),
            Ok(_) => panic!("{op:?} with a handback was run"),
        }
    }
    assert_eq!(seen_details, 1, "every_operation lost CalendarDetails");
}

/// A fake engine that records its argv and everything on its stdin, echoes the stdin to STDERR as
/// well (so a leak through stderr would carry the URL), and answers `stdout` with `exit`.
#[cfg(unix)]
fn sealed_recorder(dir: &std::path::Path, name: &str, stdout: &str, exit: i32) -> std::path::PathBuf {
    let rec = |f: &str| dir.join(f).display().to_string();
    std::fs::write(dir.join(format!("{name}.out")), stdout).expect("write the canned stdout");
    common::fake_sidecar(
        dir,
        name,
        &format!(
            "printf '%s\\n' \"$@\" > {argv}\ntee {stdin} >&2\ncat {out}\nexit {exit}",
            argv = sq(&rec("argv")),
            stdin = sq(&rec("stdin")),
            out = sq(&rec(&format!("{name}.out"))),
        ),
    )
}

/// ⚠ THE HANDBACK REACHES THE ENGINE ON STDIN, AND THE ANSWER IS PARSED INSIDE RUST. The URL is on
/// the child's stdin, byte for byte, and in no argv, `Debug` or failure; stderr — here an echo of the
/// URL — is reduced to a fixed code and never forwarded (there is no sink to forward it to).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_sealed_read_hands_back_on_stdin_and_parses_inside_rust() {
    let scratch = ScratchDir::new("sealedread");
    let op = details(false, true);
    assert_eq!(
        format!("{op:?}"),
        "CalendarDetails { skip_mac: false, skip_commands: true }"
    );
    let ok = EngineClient::with_program(sealed_recorder(
        &scratch.path,
        "ok.sh",
        &sealed_document(MARKER_URL),
        0,
    ));
    let raw = match tokio::time::timeout(
        Duration::from_secs(10),
        ok.invoke_sealed(op.clone(), handback_of(MARKER_URL)),
    )
    .await
    .expect("the invocation ended — so the stdin pipe was closed after the handback")
    {
        Ok(Ok(raw)) => raw,
        Ok(Err(f)) => panic!("the sealed document did not parse: {f:?}"),
        Err(e) => panic!("the fake did not run: {e}"),
    };
    assert!(!raw.calendar_off());
    let stdin = std::fs::read_to_string(scratch.join("stdin")).expect("the fake recorded its stdin");
    assert_eq!(
        stdin,
        format!(
            "{{\"links\":[{{\"id\":\"work\",\"entryHash\":\"{}\",\"url\":\"{MARKER_URL}\"}}]}}",
            "a".repeat(64)
        )
    );
    let argv = std::fs::read_to_string(scratch.join("argv")).expect("argv");
    assert_eq!(argv, "calendar\ndetails\n--json\n--skip-commands\n");

    // The failures: each a fixed code, the echoed URL nowhere in it.
    for (name, out, exit, want) in [
        ("exit1.sh", String::new(), 1, DetailsFailure::Exit(Some(1))),
        ("garbled.sh", format!("{{ not the document {MARKER_URL}"), 0, DetailsFailure::Malformed),
    ] {
        let client = EngineClient::with_program(sealed_recorder(&scratch.path, name, &out, exit));
        match client.invoke_sealed(op.clone(), handback_of(MARKER_URL)).await {
            Ok(Err(f)) => {
                assert_eq!(f, want, "{name}");
                assert!(!format!("{f:?}").contains("MARKER"), "{name}: {f:?}");
            }
            Ok(Ok(_)) => panic!("{name}: a failure parsed as a document"),
            Err(e) => panic!("{name}: the fake did not run: {e}"),
        }
    }
    // The engine's own fixed codes are recognised — and only when stderr is exactly one of them.
    for (code, want) in [
        ("bad-arguments", DetailsFailure::BadArguments),
        ("stdin-too-large", DetailsFailure::StdinTooLarge),
        ("stdin-invalid", DetailsFailure::StdinInvalid),
        ("config-unreadable", DetailsFailure::ConfigUnreadable),
        ("internal", DetailsFailure::Internal),
    ] {
        let program = common::fake_sidecar(
            &scratch.path,
            &format!("{code}.sh"),
            &format!("cat > /dev/null\necho 'calendar details: {code}' >&2\nexit 2"),
        );
        match EngineClient::with_program(program)
            .invoke_sealed(op.clone(), handback_of(MARKER_URL))
            .await
        {
            Ok(Err(f)) => assert_eq!(f, want, "{code}"),
            _ => panic!("{code}: expected the fixed failure"),
        }
    }
    // The calendar-off refusal is an answer, not a failure.
    let off = EngineClient::with_program(sealed_recorder(
        &scratch.path,
        "off.sh",
        r#"{"schemaVersion":1,"refused":"calendar-off"}"#,
        0,
    ));
    match off.invoke_sealed(op, handback_of(MARKER_URL)).await {
        Ok(Ok(raw)) => assert!(raw.calendar_off()),
        _ => panic!("the calendar-off refusal must parse"),
    }
}

/// `invoke_sealed` is bounded by `effective_timeout` (so the harness cap still shortens it), under
/// the same `Timeout` answer as every bounded operation — and the answer names no URL.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_sealed_read_past_its_bound_answers_timeout() {
    let scratch = ScratchDir::new("sealedtimeout");
    let _reap = ReapTagged(scratch.tag());
    let program = sleeper(&scratch.path, "slow.sh", 30);
    let client = EngineClient::with_program(program).with_timeout_cap(Duration::from_millis(1500));
    assert_eq!(
        client.effective_timeout(&details(false, false)),
        Some(Duration::from_millis(1500))
    );
    let started = std::time::Instant::now();
    match client.invoke_sealed(details(false, false), handback_of(MARKER_URL)).await {
        Err(e @ EngineError::Timeout { .. }) => {
            assert!(matches!(&e, EngineError::Timeout { operation, .. } if operation == "calendar-details"));
            assert!(!e.to_string().contains("MARKER") && !format!("{e:?}").contains("MARKER"));
        }
        Err(other) => panic!("expected Timeout, got {other:?}"),
        Ok(_) => panic!("expected Timeout, and it answered"),
    }
    assert!(started.elapsed() < Duration::from_secs(10), "the bound was not applied");
}

/// The app's Test bounds equal the engine's restated copies — read from `src/attemptBounds.ts`.
///
/// ⚠ THE 30-MINUTE CAP EXISTS TWICE AND NOTHING ELSE LINKS THE COPIES (P2-M4 checkpoint fix, into
/// P3-M1-T1): the engine caps a loopback probe at `APP_LOOPBACK_TEST_CAP_MS − 17 s` so its answer
/// lands inside THIS bound. If the Rust cap moved down alone, every long loopback Test would be
/// abandoned before its answer; moved up alone, the engine's cap would no longer be what bounds it.
#[test]
fn the_provider_test_bounds_equal_the_engines_copies() {
    const BOUNDS: &str = "src/attemptBounds.ts";
    assert_eq!(
        engine_const(BOUNDS, "APP_LOOPBACK_TEST_CAP_MS"),
        PROVIDER_TEST_LOOPBACK_CAP.as_millis() as u64,
        "the app's loopback Test cap and the engine's APP_LOOPBACK_TEST_CAP_MS differ"
    );
    assert_eq!(
        engine_const(BOUNDS, "APP_LOOPBACK_TEST_EXTRA_MS"),
        PROVIDER_TEST_LOOPBACK_EXTRA.as_millis() as u64
    );
    assert_eq!(
        engine_const(BOUNDS, "APP_REMOTE_TEST_TIMEOUT_MS"),
        PROVIDER_TEST_REMOTE_TIMEOUT.as_millis() as u64
    );
    // And the engine's probe cap is derived from the two, not restated (so the sum stays ≤ cap).
    assert!(
        engine_source(BOUNDS).contains(
            "export const PROBE_LOOPBACK_MAX_TIMEOUT_MS = APP_LOOPBACK_TEST_CAP_MS - APP_LOOPBACK_TEST_EXTRA_MS;"
        ),
        "the engine's loopback probe cap is no longer cap − extra"
    );
}

/// A fake that records its argv, its whole environment and EVERYTHING it reads on stdin, then
/// answers one `ok` JSON line — the shape `provider`'s answers have.
#[cfg(unix)]
fn stdin_recorder(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let rec = |f: &str| dir.join(f).display().to_string();
    common::fake_sidecar(
        dir,
        name,
        &format!(
            "printf '%s\\n' \"$@\" > {argv}\n/usr/bin/env > {env}\ncat > {stdin}\nprintf '%s' {answer}\nexit 0",
            argv = sq(&rec("argv")),
            env = sq(&rec("env")),
            stdin = sq(&rec("stdin")),
            answer = sq(r#"{"schemaVersion":1,"ok":true}"#),
        ),
    )
}

/// ⚠ THE KEY REACHES THE ENGINE ON STDIN AND NOWHERE ELSE — not argv, not the environment, not the
/// `Operation`'s `Debug`, not the outcome — and the pipe is CLOSED after it (the fake's `cat` returns
/// only at EOF, so a never-closed stdin would hang this invocation instead of answering).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_key_travels_on_stdin_and_nowhere_else() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("keystdin");
    let client = EngineClient::with_program(stdin_recorder(&scratch.path, "engine.sh"));
    const SECRET: &str = "sk-test-SECRET-0123456789abcdef";

    let op = Operation::KeySet;
    assert!(!format!("{op:?}").contains(SECRET));
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        client.invoke_with_key(
            op.clone(),
            KeySecret::new(SECRET.to_string()).expect("a key"),
            &NoProgress,
        ),
    )
    .await
    .expect("the invocation ended — so the stdin pipe was closed after the key")
    .expect("the fake ran");
    assert_eq!(outcome.outcome, Outcome::Delivered, "{outcome:?}");
    assert_eq!(
        std::fs::read_to_string(scratch.join("stdin")).expect("the fake recorded its stdin"),
        SECRET,
        "the engine must read exactly the key on stdin"
    );
    let argv = std::fs::read_to_string(scratch.join("argv")).expect("argv");
    assert_eq!(argv, "provider\nkey\nset\n--json\n");
    let env = std::fs::read_to_string(scratch.join("env")).expect("env");
    assert!(!env.contains(SECRET), "the key reached the environment");
    assert!(!format!("{outcome:?}").contains(SECRET));
    assert!(!serde_json::to_string(&outcome)
        .expect("serialises")
        .contains(SECRET));

    // Every other operation's stdin is `/dev/null`: the same fake reads nothing.
    let _ = std::fs::remove_file(scratch.join("stdin"));
    client
        .invoke(Operation::KeyDeleteAll, &NoProgress)
        .await
        .expect("the fake ran");
    assert_eq!(
        std::fs::read_to_string(scratch.join("stdin")).expect("stdin recorded"),
        ""
    );

    // The pairing is enforced BEFORE any spawn, both ways. PR 3 final, the second post-cap fix (N2):
    // the cases run on a client whose program AND caffeinate wrapper are both absent (on macOS
    // `command_line` wraps the program in caffeinate when that path exists), so ANY spawn attempt
    // answers `Spawn` — a refusal moved after the spawn can no longer pass by the child being killed
    // on drop before the fake recorded anything (r5's C1 rested on that race).
    let absent = EngineClient::with_program(scratch.join("absent-program"))
        .with_caffeinate_path(scratch.join("absent-caffeinate"));
    assert!(
        !scratch.join("absent-program").exists() && !scratch.join("absent-caffeinate").exists()
    );
    // The control: a correctly paired invocation on that client reaches the spawn, and the spawn fails.
    match absent.invoke(Operation::KeyDeleteAll, &NoProgress).await {
        Err(EngineError::Spawn { .. }) => {}
        other => panic!("the absent client must fail AT the spawn, got {other:?}"),
    }
    enum Mispaired {
        KeySetWithoutKey,
        KeyForStatus,
        KeyBesideLabel,
    }
    for case in [
        Mispaired::KeySetWithoutKey,
        Mispaired::KeyForStatus,
        Mispaired::KeyBesideLabel,
    ] {
        let (answer, what) = match case {
            Mispaired::KeySetWithoutKey => (
                absent.invoke(Operation::KeySet, &NoProgress).await,
                "key set without a key",
            ),
            Mispaired::KeyForStatus => (
                absent
                    .invoke_with_key(
                        Operation::Status,
                        KeySecret::new(SECRET.to_string()).expect("a key"),
                        &NoProgress,
                    )
                    .await,
                "a key for an operation that reads none",
            ),
            Mispaired::KeyBesideLabel => (
                absent
                    .invoke_with_key(
                        Operation::ProviderReset {
                            target: ResetTarget::Label(label("work").expect("legal")),
                        },
                        KeySecret::new(SECRET.to_string()).expect("a key"),
                        &NoProgress,
                    )
                    .await,
                "a key beside an operation's own stdin payload",
            ),
        };
        match &answer {
            Err(EngineError::InvalidInput { field, reason }) => {
                assert_eq!(field, "key", "{what}");
                assert!(!reason.contains(SECRET), "{what}: {reason}");
            }
            // `Spawn` here means the refusal came only after a spawn was attempted.
            other => panic!("{what}: expected InvalidInput before any spawn, got {other:?}"),
        }
    }
}

/// The label reaches the engine as `{"label": …}` on stdin, and the pipe is closed after it.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_reset_label_is_written_to_stdin_as_json() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("labelstdin");
    let client = EngineClient::with_program(stdin_recorder(&scratch.path, "engine.sh"));
    for text in ["--help", "-v", "work \"two\"", "ünï"] {
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            client.invoke(
                Operation::ProviderReset {
                    target: ResetTarget::Label(label(text).expect("legal")),
                },
                &NoProgress,
            ),
        )
        .await
        .expect("the invocation ended — so the stdin pipe was closed")
        .expect("the fake ran");
        assert_eq!(outcome.outcome, Outcome::Delivered, "{outcome:?}");
        let got: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(scratch.join("stdin")).expect("stdin recorded"),
        )
        .expect("the stdin is JSON");
        assert_eq!(got, serde_json::json!({ "label": text }));
        assert_eq!(
            std::fs::read_to_string(scratch.join("argv")).expect("argv"),
            "provider\nreset\n--label-stdin\n--json\n",
            "{text:?}"
        );
    }
}

/* ── B1-M4-T11: `repos status --json`'s request ───────────────────────────────────────────────── */

fn repos_label(key: &str, tokens: &[&str]) -> ReposLabel {
    ReposLabel {
        key: key.to_string(),
        tokens: tokens.iter().map(|t| t.to_string()).collect(),
    }
}

fn repos_branch(key: &str, name: &str) -> ReposBranch {
    ReposBranch {
        key: key.to_string(),
        name: name.to_string(),
    }
}

fn repos_request(
    labels: Vec<ReposLabel>,
    branches: Vec<ReposBranch>,
) -> Result<ReposRequest, ReposRefusal> {
    ReposRequest::new(ReposScope::All, "2026-10-24", labels, branches)
}

/// A small valid request, for the operation pins that need one.
fn a_repos_request() -> ReposRequest {
    repos_request(
        vec![repos_label("daily_briefing_application", &["abc1234"])],
        vec![repos_branch("daily_briefing_application", "feat/x")],
    )
    .expect("a valid request")
}

/// A fixture under `tests/fixtures/`, parsed.
fn fixture_json(name: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("the fixture {} is readable: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name} is JSON: {e}"))
}

/// Each refusal of the request's validation (plan B1-M4-T11), and the edges it admits. Rust refuses
/// the WHOLE request on one bad entry, which is why the webview's `reposRequest` (B1-M5-T14) never
/// sends one; the shared fixture below keeps the two rules equal.
#[test]
fn repos_request_refusals_name_their_class() {
    // Admitted: the Other card's key `""`, every limit exactly, both hex cases.
    let forty = "0123456789abcdefABCDEF0123456789abcdef01";
    assert_eq!(forty.len(), 40);
    let key80 = "é".repeat(REPOS_KEY_MAX_SCALARS);
    assert!(repos_request(vec![repos_label("", &["a"])], vec![]).is_ok(), "the Other card");
    assert!(repos_request(vec![repos_label(&key80, &[forty])], vec![repos_branch(&key80, "")]).is_ok());
    assert!(repos_request(vec![], vec![repos_branch("", &"a".repeat(REPOS_BRANCH_MAX_BYTES))]).is_ok());
    let many = |n: usize| -> Vec<ReposLabel> {
        (0..n).map(|i| repos_label(&format!("l{i}"), &[])).collect()
    };
    let branches = |n: usize| -> Vec<ReposBranch> {
        (0..n).map(|i| repos_branch(&format!("l{i}"), "main")).collect()
    };
    assert!(repos_request(many(REPOS_MAX_LABELS), branches(REPOS_MAX_BRANCHES)).is_ok());
    let tokens = |n: usize| vec!["abc"; n];
    assert!(repos_request(vec![repos_label("k", &tokens(REPOS_TOKENS_PER_LABEL))], vec![]).is_ok());
    let full: Vec<ReposLabel> = (0..REPOS_TOKENS_TOTAL / REPOS_TOKENS_PER_LABEL)
        .map(|i| repos_label(&format!("l{i}"), &tokens(REPOS_TOKENS_PER_LABEL)))
        .collect();
    assert!(repos_request(full.clone(), vec![]).is_ok(), "exactly 4 096 tokens in all");

    let mut over_total = full;
    over_total.push(repos_label("one more", &["a"]));
    let cases: Vec<(&str, Result<ReposRequest, ReposRefusal>, ReposRefusal)> = vec![
        ("a non-hex token", repos_request(vec![repos_label("k", &["abcg"])], vec![]), ReposRefusal::TokenNotHex),
        ("an empty token", repos_request(vec![repos_label("k", &[""])], vec![]), ReposRefusal::TokenNotHex),
        ("a 41-character token", repos_request(vec![repos_label("k", &[&"a".repeat(41)])], vec![]), ReposRefusal::TokenNotHex),
        ("a token of non-ASCII digits", repos_request(vec![repos_label("k", &["١٢٣"])], vec![]), ReposRefusal::TokenNotHex),
        ("a token with a space", repos_request(vec![repos_label("k", &["abc "])], vec![]), ReposRefusal::TokenNotHex),
        ("65 labels", repos_request(many(REPOS_MAX_LABELS + 1), vec![]), ReposRefusal::TooManyLabels),
        ("65 branch entries", repos_request(vec![], branches(REPOS_MAX_BRANCHES + 1)), ReposRefusal::TooManyBranches),
        ("513 tokens on one label", repos_request(vec![repos_label("k", &tokens(REPOS_TOKENS_PER_LABEL + 1))], vec![]), ReposRefusal::TooManyTokensInLabel),
        ("4 097 tokens in all", repos_request(over_total, vec![]), ReposRefusal::TooManyTokens),
        ("an 81-scalar label key", repos_request(vec![repos_label(&"é".repeat(81), &[])], vec![]), ReposRefusal::LabelKeyTooLong),
        ("a control character in a label key", repos_request(vec![repos_label("a\u{7}b", &[])], vec![]), ReposRefusal::LabelKeyCharacter),
        ("a newline in a label key", repos_request(vec![repos_label("a\nb", &[])], vec![]), ReposRefusal::LabelKeyCharacter),
        ("a bidi control in a label key", repos_request(vec![repos_label("a\u{202E}b", &[])], vec![]), ReposRefusal::LabelKeyCharacter),
        ("an 81-scalar branch key", repos_request(vec![], vec![repos_branch(&"é".repeat(81), "main")]), ReposRefusal::BranchKeyTooLong),
        ("a control character in a branch key", repos_request(vec![], vec![repos_branch("a\u{1b}b", "main")]), ReposRefusal::BranchKeyCharacter),
        ("a zero-width space in a branch key", repos_request(vec![], vec![repos_branch("a\u{200B}", "main")]), ReposRefusal::BranchKeyCharacter),
        ("a 256-byte branch name", repos_request(vec![], vec![repos_branch("", &"a".repeat(256))]), ReposRefusal::BranchNameTooLong),
        // 86 × "€" is 86 scalars but 258 UTF-8 bytes: the limit is bytes.
        ("a 258-byte name of 86 scalars", repos_request(vec![], vec![repos_branch("", &"€".repeat(86))]), ReposRefusal::BranchNameTooLong),
        ("a control character in a branch name", repos_request(vec![], vec![repos_branch("", "feat/\u{7f}x")]), ReposRefusal::BranchNameCharacter),
        ("a bidi isolate in a branch name", repos_request(vec![], vec![repos_branch("", "feat/\u{2066}x")]), ReposRefusal::BranchNameCharacter),
    ];
    for (what, got, want) in cases {
        assert_eq!(got.err(), Some(want), "{what}");
    }
    for bad in ["2026-02-30", "2026-1-01", "20261024", "", "0000-01-01", "2026-13-01", "2026-10-24 ", "２０２6-10-24"] {
        assert_eq!(
            ReposRequest::new(ReposScope::All, bad, vec![], vec![]).err(),
            Some(ReposRefusal::PageDate),
            "{bad:?}"
        );
    }
    // A refusal is a sentence naming its field, and never the value.
    for r in [ReposRefusal::TokenNotHex, ReposRefusal::LabelKeyCharacter, ReposRefusal::BranchNameTooLong, ReposRefusal::PageDate] {
        let e: EngineError = r.into();
        match e {
            EngineError::InvalidInput { field, reason } => {
                assert!(!field.is_empty() && !reason.is_empty(), "{r:?}");
                assert!(!reason.contains("abcg"), "{r:?}");
            }
            other => panic!("{r:?} → {other:?}"),
        }
    }
}

/// THE SHARED FIXTURE (plan B1-M4-T11; post-cap review PC-M2, PC-M3): `repos-request-limits.json`,
/// read here and by the webview's `git-detail.check.ts` (B1-M5-T14), so a limit or a refused range
/// changed on one side alone goes red on one of the two.
///
/// - every Rust constant equals its `limits` entry;
/// - every `chars` entry is classed as stated by the Rust rule (`char::is_control` or
///   `is_refused_format_character`), AND by the request's own validation, as a label key and as a
///   branch name (so the validator cannot use some other predicate);
/// - `chars` is COMPLETE for the Rust rule: for every range of `REFUSED_FORMAT_CHARACTERS`
///   (iterated, not copied) it holds `lo`, `hi`, `lo − 1` and `hi + 1`, plus the control edges.
///
/// The fixture is written by hand once; this test checks its entries, it never generates them.
#[test]
fn the_repos_request_limits_are_the_shared_fixtures() {
    let fx = fixture_json("repos-request-limits.json");
    let mut top: Vec<&String> = fx.as_object().expect("an object").keys().collect();
    top.sort_unstable();
    assert_eq!(top, ["chars", "limits"], "the fixture holds `limits` and `chars` only");
    let limits = fx["limits"].as_object().expect("`limits` is an object");
    let want = [
        ("REPOS_MAX_LABELS", REPOS_MAX_LABELS),
        ("REPOS_MAX_BRANCHES", REPOS_MAX_BRANCHES),
        ("REPOS_KEY_MAX_SCALARS", REPOS_KEY_MAX_SCALARS),
        ("REPOS_TOKENS_PER_LABEL", REPOS_TOKENS_PER_LABEL),
        ("REPOS_TOKENS_TOTAL", REPOS_TOKENS_TOTAL),
        ("REPOS_BRANCH_MAX_BYTES", REPOS_BRANCH_MAX_BYTES),
    ];
    assert_eq!(limits.len(), want.len(), "{limits:?}");
    for (name, value) in want {
        assert_eq!(limits[name].as_u64(), Some(value as u64), "{name}");
    }
    // The plan's figures, so the fixture and the constants cannot move together unseen.
    assert_eq!(
        want.map(|(_, v)| v),
        [64, 64, 80, 512, 4096, 255],
        "the six figures are plan B1-M4-T11's"
    );

    let chars: Vec<(u32, bool)> = fx["chars"]
        .as_array()
        .expect("`chars` is an array")
        .iter()
        .map(|e| {
            let cp = e["cp"].as_str().expect("`cp` is a string");
            let hex = cp.strip_prefix("U+").unwrap_or_else(|| panic!("{cp} is spelled U+XXXX"));
            let n = u32::from_str_radix(hex, 16).unwrap_or_else(|_| panic!("{cp} is hex"));
            (n, e["refused"].as_bool().expect("`refused` is a boolean"))
        })
        .collect();
    let rule = |c: char| c.is_control() || is_refused_format_character(c);
    for (cp, refused) in &chars {
        let c = char::from_u32(*cp).unwrap_or_else(|| panic!("U+{cp:04X} is a scalar value"));
        assert_eq!(rule(c), *refused, "U+{cp:04X} is classed wrongly in the fixture");
        let as_key = repos_request(vec![repos_label(&format!("k{c}"), &[])], vec![]);
        assert_eq!(as_key.is_err(), *refused, "U+{cp:04X} as a label key: {as_key:?}");
        let as_name = repos_request(vec![], vec![repos_branch("k", &format!("feat/{c}"))]);
        assert_eq!(as_name.is_err(), *refused, "U+{cp:04X} in a branch name: {as_name:?}");
        let as_branch_key = repos_request(vec![], vec![repos_branch(&format!("{c}"), "main")]);
        assert_eq!(as_branch_key.is_err(), *refused, "U+{cp:04X} as a branch key");
    }
    let held: std::collections::BTreeSet<u32> = chars.iter().map(|(cp, _)| *cp).collect();
    assert_eq!(held.len(), chars.len(), "a `chars` entry is listed twice");
    for (lo, hi) in REFUSED_FORMAT_CHARACTERS {
        for cp in [*lo as u32, *hi as u32, *lo as u32 - 1, *hi as u32 + 1] {
            assert!(
                held.contains(&cp),
                "the fixture lacks U+{cp:04X}, an edge of the refused range U+{:04X}..U+{:04X}",
                *lo as u32,
                *hi as u32
            );
        }
    }
    for cp in [0x0000, 0x001F, 0x0020, 0x007F, 0x009F, 0x00A0] {
        assert!(held.contains(&cp), "the fixture lacks the control edge U+{cp:04X}");
    }
}

/// ⚠ THE REQUEST IS EXACTLY THE ENGINE'S STDIN CONTRACT, pinned on both sides by one fixture
/// (`repos-request-wire.json`): this test asserts Rust serialises each sample request to exactly
/// the fixture's bytes (and that `stdin_payload` is those bytes), and `test/repos.status.test.ts`
/// asserts the engine's `parseReposRequest` (src/repos/status.ts) accepts each and reads it back
/// whole — `{ scope, pageDate, labels: [{ key, tokens }], branches: [{ key, name }] }`, camelCase,
/// no other member (the engine refuses one). The engine's stdin bound is pinned the same way.
#[test]
fn the_repos_request_is_the_engines_stdin_contract() {
    let fx = fixture_json("repos-request-wire.json");
    assert_eq!(
        fx["stdinMaxBytes"].as_u64(),
        Some(REPOS_STDIN_MAX_BYTES as u64),
        "the engine's REPOS_STDIN_MAX_BYTES"
    );
    let samples = [
        ReposRequest::new(
            ReposScope::All,
            "2026-10-24",
            vec![
                repos_label("daily_briefing_application", &["abc1234", "DEADBEEF"]),
                repos_label("", &["0123456789abcdef0123456789abcdef01234567"]),
                repos_label("ünï €", &[]),
            ],
            vec![repos_branch("daily_briefing_application", "feat/dba-\"x\"")],
        )
        .expect("valid"),
        ReposRequest::new(ReposScope::Uncommitted, "2026-01-31", vec![], vec![]).expect("valid"),
    ];
    let wires = fx["wires"].as_array().expect("`wires` is an array");
    assert_eq!(wires.len(), samples.len());
    for (request, wire) in samples.into_iter().zip(wires) {
        let wire = wire.as_str().expect("each wire is a string");
        assert_eq!(serde_json::to_string(&request).expect("serialises"), wire);
        let op = Operation::ReposStatus { request };
        assert_eq!(op.stdin_payload(), Some(wire.as_bytes().to_vec()));
    }
}

/// The largest request the validation admits fits the engine's `readStdinBounded(256 * 1024)`
/// (plan B1-M4-T11, round 4 LOW and round 5 LOW): every multi-byte character at 4 bytes, and the
/// quote-escaped twin, whose branch names are 255 `"` characters each serialised as `\"`.
#[test]
fn the_largest_admitted_repos_request_fits_the_engines_stdin_bound() {
    let wide = "\u{1F600}"; // 4 UTF-8 bytes, needs no JSON escape
    let key: String = wide.repeat(REPOS_KEY_MAX_SCALARS);
    assert_eq!(key.len(), 4 * REPOS_KEY_MAX_SCALARS);
    let token = "f".repeat(40);
    let per_label = REPOS_TOKENS_TOTAL / REPOS_MAX_LABELS;
    let labels = || -> Vec<ReposLabel> {
        (0..REPOS_MAX_LABELS)
            .map(|_| ReposLabel {
                key: key.clone(),
                tokens: vec![token.clone(); per_label],
            })
            .collect()
    };
    // 63 four-byte scalars and 3 ASCII bytes: 255 bytes, the most a name may hold.
    let name = format!("{}abc", wide.repeat(63));
    assert_eq!(name.len(), REPOS_BRANCH_MAX_BYTES);
    let quotes = "\"".repeat(REPOS_BRANCH_MAX_BYTES);
    for (what, branch_name) in [("multi-byte", name), ("quote-escaped", quotes)] {
        let branches = (0..REPOS_MAX_BRANCHES)
            .map(|_| ReposBranch {
                key: key.clone(),
                name: branch_name.clone(),
            })
            .collect();
        let request = ReposRequest::new(ReposScope::Uncommitted, "2026-10-24", labels(), branches)
            .unwrap_or_else(|e| panic!("the {what} maximal request is admitted: {e:?}"));
        let len = serde_json::to_vec(&request).expect("serialises").len();
        assert!(
            len < REPOS_STDIN_MAX_BYTES,
            "the {what} maximal request is {len} bytes, over the engine's {REPOS_STDIN_MAX_BYTES}"
        );
    }
    assert_eq!(REPOS_STDIN_MAX_BYTES, 256 * 1024);
}

/// The request reaches the engine on STDIN and the pipe is closed after it; argv is the three fixed
/// literals and holds no key, token or branch name; the operation's `Debug` holds no path.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_repos_request_is_written_to_stdin_and_never_argv() {
    let scratch = ScratchDir::new("reposstdin");
    let program = stdin_recorder(&scratch.path, "engine.sh");
    let client = EngineClient::with_program(program.clone());
    let request = ReposRequest::new(
        ReposScope::All,
        "2026-10-24",
        vec![repos_label("--help", &["abc1234"]), repos_label("", &["DEADBEEF"])],
        vec![repos_branch("--help", "-v")],
    )
    .expect("valid");
    let op = Operation::ReposStatus {
        request: request.clone(),
    };
    let shown = format!("{op:?}");
    assert!(!shown.contains(&scratch.path.display().to_string()), "{shown}");
    assert!(!shown.contains(&program.display().to_string()), "{shown}");
    let outcome = tokio::time::timeout(Duration::from_secs(10), client.invoke(op, &NoProgress))
        .await
        .expect("the invocation ended — so the stdin pipe was closed")
        .expect("the fake ran");
    assert_eq!(outcome.outcome, Outcome::Delivered, "{outcome:?}");
    assert_eq!(
        std::fs::read_to_string(scratch.join("stdin")).expect("stdin recorded"),
        serde_json::to_string(&request).expect("serialises")
    );
    let argv = std::fs::read_to_string(scratch.join("argv")).expect("argv recorded");
    assert_eq!(argv, "repos\nstatus\n--json\n");
    for operand in ["--help", "-v", "abc1234", "DEADBEEF"] {
        assert!(!argv.lines().any(|l| l == operand), "{operand} reached argv: {argv}");
    }
}

/// ⚠ THE BOUNDS ARE APPLIED, NOT JUST DECLARED, for the provider operations too: one past its
/// bound is abandoned — its fake killed — and answers `Timeout`, and (all seven being mutating)
/// the in-flight guard is released. Driven with the harness cap, as the calendar test is.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_provider_operation_past_its_bound_is_stopped_and_answers_timeout() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("provtimeout");
    let _reap = ReapTagged(scratch.tag());
    let _ = sleeper(&scratch.path, "unused.sh", 1);
    let pid_file = scratch.join("pid");
    let program = fake_sidecar(
        &scratch.path,
        "slow.sh",
        &format!(
            "[ \"$1\" = warm ] && exit 0\necho $$ > {}\nexec {} 30",
            sq(&pid_file.display().to_string()),
            sq(&scratch.join("sleep").display().to_string()),
        ),
    );
    spend_first_exec(&program);
    let client = EngineClient::with_program(program).with_timeout_cap(Duration::from_millis(2500));
    let test_op = Operation::ProviderTest {
        file: config_file_path("/tmp/provider-check-x.json").expect("valid"),
        index: provider_index(0).expect("valid"),
        test_timeout_ms: 29 * 60_000,
    };
    for (op, key) in [
        (Operation::KeySet, true),
        (test_op, false),
        (Operation::KeyScrubBackup, false),
    ] {
        let _ = std::fs::remove_file(&pid_file);
        let started = std::time::Instant::now();
        let answer = if key {
            client
                .invoke_with_key(
                    op.clone(),
                    KeySecret::new("sk-test-0123456789".into()).expect("a key"),
                    &NoProgress,
                )
                .await
        } else {
            client.invoke(op.clone(), &NoProgress).await
        };
        assert!(
            matches!(&answer, Err(EngineError::Timeout { operation, .. }) if operation == op.name()),
            "{op:?} past its bound must answer Timeout, got {answer:?}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{op:?}: the bound was not applied"
        );
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap_or_else(|e| panic!("{op:?}: the fake never started ({e}) — vacuous"))
            .trim()
            .to_string();
        let mut gone = false;
        for _ in 0..40 {
            if process_gone(&pid) {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            gone,
            "{op:?}: the abandoned fake (pid {pid}) is still running"
        );
    }
}

/// ⚠ `provider test` TAKES ITS PROCESS GROUP WITH IT WHEN IT RETURNS (P2-M4 checkpoint, into P3): a
/// CLI Test's backgrounded grandchild can outlive the engine. The fake backgrounds a sleeper with
/// its stdio on `/dev/null` (so the invocation returns while it lives — the
/// `a_completed_invocation_leaves_what_the_engine_backgrounded_running` shape), answers, exits 0.
///
/// Three things are measured, each the precondition of the next: the engine is the LEADER of its
/// own group (pgid == pid — "verify the engine runs in its own group first"), the grandchild is in
/// that group, and after a `ProviderTest` returns the grandchild is gone while the engine's exit
/// status is still the 0 it chose (the kill lands before the reap, on an exiting process). The
/// control is the same fake under another provider operation, which must leave it running.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_provider_test_takes_its_process_group_with_it_when_it_returns() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("testgroup");
    let _reap = ReapTagged(scratch.tag());
    let _ = sleeper(&scratch.path, "unused.sh", 1);
    let rec = |f: &str| sq(&scratch.join(f).display().to_string());
    let program = fake_sidecar(
        &scratch.path,
        "backgrounding.sh",
        &format!(
            "echo $$ > {pid}\nps -o pgid= -p $$ | tr -d ' ' > {pgid}\n\
             {sleep} 41 >/dev/null 2>&1 </dev/null &\necho $! > {child}\n\
             printf '%s' {answer}\nexit 0",
            pid = rec("pid"),
            pgid = rec("pgid"),
            sleep = rec("sleep"),
            child = rec("child.pid"),
            answer = sq(r#"{"schemaVersion":1,"ok":true,"passed":true,"recorded":true}"#),
        ),
    );
    let client = EngineClient::with_program(program);
    let read = |f: &str| {
        std::fs::read_to_string(scratch.join(f))
            .unwrap_or_default()
            .trim()
            .to_string()
    };

    // The control first: another provider operation keeps what the engine backgrounded.
    let kept = tokio::time::timeout(
        Duration::from_secs(10),
        client.invoke(Operation::KeyScrubBackup, &NoProgress),
    )
    .await
    .expect("returned within 10 s — the sleeper does not hold the pipes")
    .expect("the fake ran");
    assert_eq!(kept.exit_code, Some(0), "{kept:?}");
    let kept_child = read("child.pid");
    assert!(
        kept_child.parse::<u32>().is_ok(),
        "no background child recorded"
    );
    let watch_until = tokio::time::Instant::now() + Duration::from_millis(500);
    while tokio::time::Instant::now() < watch_until {
        assert!(
            !process_gone(&kept_child),
            "a scrub-backup killed its group on return — only `provider test` may"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Now the Test.
    let tested = tokio::time::timeout(
        Duration::from_secs(10),
        client.invoke(
            Operation::ProviderTest {
                file: config_file_path("/tmp/provider-check-1.json").expect("valid"),
                index: provider_index(0).expect("valid"),
                test_timeout_ms: 80_000,
            },
            &NoProgress,
        ),
    )
    .await
    .expect("returned within 10 s")
    .expect("the fake ran");
    let pid = read("pid");
    assert_eq!(
        read("pgid"),
        pid,
        "the engine is not the leader of its own process group, so killing \"its group\" would be \
         killing someone else's"
    );
    let child = read("child.pid");
    assert!(child.parse::<u32>().is_ok(), "no background child recorded");
    assert_eq!(
        (tested.outcome.clone(), tested.exit_code),
        (Outcome::Delivered, Some(0)),
        "the kill-on-return replaced the engine's own exit status: {tested:?}"
    );
    assert_eq!(
        tested.payload.as_ref().map(|p| p["passed"].clone()),
        Some(true.into())
    );
    let mut gone = false;
    for _ in 0..40 {
        if process_gone(&child) {
            gone = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        gone,
        "the Test's backgrounded grandchild (pid {child}) outlived it"
    );
}

/* ── the real sidecar ─────────────────────────────────────────────────────────────────────────── */

fn sandboxed(scratch: &ScratchDir) -> EngineClient {
    let mut client = EngineClient::with_program(
        daily_briefing_gui_lib::engine::bundled_sidecar_path().expect("the bundled sidecar"),
    );
    for (key, value) in sandbox_env(&scratch.path) {
        client = client.with_env(key, value);
    }
    client
}

/// The four read-only operations, end to end, against the real engine in a sandbox.
///
/// Each is asserted on its ENVELOPE — the schema key that only that subcommand emits — which is how
/// this proves WHICH command ran rather than merely that something did. Under B1's ceiling every
/// one of these would have produced a `status` envelope; that is the defect this change exists to
/// fix, so proving the four are now distinguishable is the headline assertion of T8.
#[tokio::test(flavor = "multi_thread")]
async fn the_read_only_operations_reach_the_real_sidecar() {
    let scratch = ScratchDir::new("real");
    let candidate = scratch.join("candidate.json");
    std::fs::write(&candidate, br#"{"repos":["/tmp/does-not-matter"]}"#).expect("a candidate");
    let client = sandboxed(&scratch);

    // status
    let status = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("status invokes");
    assert_eq!(status.outcome, Outcome::Delivered, "{status:?}");
    let payload = status.payload.as_ref().expect("a status envelope");
    assert!(
        payload.get("paths").is_some() && payload.get("engineVersion").is_some(),
        "this is not a status envelope: {payload}"
    );

    // ⚠ THE SANDBOX IS ASSERTED, NOT ASSUMED. If the env overrides stopped reaching the child (or
    // the engine stopped honouring them) these would be the developer's real directories and every
    // spawn in this file would be running against live briefing state.
    let root = scratch.path.display().to_string();
    for key in ["stateDir", "configPath"] {
        let got = payload["paths"][key].as_str().unwrap_or("(absent)");
        assert!(
            got.starts_with(&root),
            "paths.{key} resolved OUTSIDE the test sandbox — expected a path under {root}, got \
             {got}"
        );
    }

    // doctor — a DIFFERENT envelope, which is the whole point
    let doctor = client
        .invoke(Operation::Doctor, &NoProgress)
        .await
        .expect("doctor invokes");
    assert_eq!(doctor.outcome, Outcome::Delivered, "{doctor:?}");
    let payload = doctor.payload.as_ref().expect("a doctor envelope");
    assert!(
        payload.get("verdict").is_some() && payload.get("provider").is_some(),
        "this is not a doctor envelope — under B1's first-match ceiling it would have been a \
         status one: {payload}"
    );

    // config validate — exits 0 whether or not the candidate is valid; validity is the payload
    let validated = client
        .invoke(
            Operation::ConfigValidate {
                file: config_file_path(&candidate.display().to_string())
                    .expect("the scratch path passes the validator"),
            },
            &NoProgress,
        )
        .await
        .expect("config validate invokes");
    assert_eq!(validated.outcome, Outcome::Delivered, "{validated:?}");
    let payload = validated.payload.as_ref().expect("a validate envelope");
    assert!(
        payload.get("valid").is_some() && payload.get("errors").is_some(),
        "this is not a config-validate envelope: {payload}"
    );

    // schedule status
    let schedule = client
        .invoke(Operation::ScheduleStatus, &NoProgress)
        .await
        .expect("schedule status invokes");
    assert_eq!(schedule.outcome, Outcome::Delivered, "{schedule:?}");
    let payload = schedule.payload.as_ref().expect("a schedule envelope");
    assert!(
        payload.get("unitPath").is_some() && payload.get("lastTickState").is_some(),
        "this is not a schedule-status envelope: {payload}"
    );
    // Written into the sandbox, not `~/Library/LaunchAgents`.
    assert!(
        payload["unitPath"]
            .as_str()
            .unwrap_or_default()
            .starts_with(&root),
        "schedule status reported a unit path outside the sandbox: {payload}"
    );
}

/// PR 3: the `provider` verbs that READ BEFORE THEY WRITE, end to end against the real engine in a
/// sandbox with NO config — so each refuses with `code: "config"` before it locks, stores or probes
/// anything (`src/providerCli.ts`: the saved config, or `test`'s candidate, is read first).
///
/// ⚠ THE DISCRIMINATING CASE IS THE `--help` LABEL. Had the label reached argv, the engine's
/// dispatch would have printed help (no JSON line at all); had the stdin not been the
/// `{"label": …}` JSON, or not been closed within the engine's 1 s, the refusal would be
/// `code: "usage"`. Only a correctly written, correctly closed stdin gets as far as the config.
///
/// ⚠ `key set`, `key delete` and `key delete-all` ARE NEVER EXECUTED AGAINST THE REAL ENGINE (Q27:
/// Keychain tests are fake-only). On macOS their store is the login Keychain; the engine's own
/// backstop (`DBA_TEST_UNIT_DIR`, set by the sandbox) would refuse the `security` call, but a
/// backstop is not a licence. They are covered by the fakes above.
#[tokio::test(flavor = "multi_thread")]
async fn the_provider_verbs_reach_the_real_sidecar_and_refuse_without_a_config() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("realprov");
    let client = sandboxed(&scratch);
    let missing = scratch.join("no-such-candidate.json");
    let cases = [
        (
            Operation::ProviderReset {
                target: ResetTarget::Label(label("--help").expect("legal")),
            },
            "reset: ",
        ),
        (
            Operation::ProviderReset {
                target: ResetTarget::Label(label("-v").expect("legal")),
            },
            "reset: ",
        ),
        (
            Operation::ProviderReset {
                target: ResetTarget::Index(provider_index(0).expect("valid")),
            },
            "reset: ",
        ),
        (
            Operation::KeyMigrate {
                index: provider_index(0).expect("valid"),
            },
            "key migrate: ",
        ),
        (
            Operation::ProviderTest {
                file: config_file_path(&missing.display().to_string()).expect("valid"),
                index: provider_index(0).expect("valid"),
                test_timeout_ms: 80_000,
            },
            "test: ",
        ),
    ];
    for (op, verb) in cases {
        let out = client
            .invoke(op.clone(), &NoProgress)
            .await
            .unwrap_or_else(|e| panic!("{op:?} invokes: {e}"));
        let payload = out.payload.as_ref().unwrap_or_else(|| {
            panic!("{op:?}: no JSON line — the engine crashed or printed help: {out:?}")
        });
        assert_eq!(payload["schemaVersion"], 1, "{op:?}: {payload}");
        assert_eq!(payload["ok"], false, "{op:?}: {payload}");
        assert_eq!(
            payload["code"], "config",
            "{op:?}: expected the no-config refusal (a `usage` code means the argv or the stdin \
             payload was malformed): {payload}"
        );
        assert!(
            payload["error"]
                .as_str()
                .unwrap_or_default()
                .starts_with(verb),
            "{op:?}: {payload}"
        );
        assert_eq!(
            out.outcome,
            Outcome::ConfigError,
            "{op:?}: exit 2 is `config`"
        );
    }
    // Nothing was written into the sandbox's config folder by any of them.
    let config_dir = scratch.join("config");
    let written: Vec<_> = std::fs::read_dir(&config_dir)
        .map(|d| d.filter_map(Result::ok).map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(written.is_empty(), "the refusals wrote {written:?}");
}

/// A non-forced run on a machine with no config: exit 0, no provider, `skipReason: "no-config"`.
///
/// This is the shape that makes running the REAL `run` safe here at all — see the module header.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_against_a_sandbox_with_no_config_is_skipped_not_delivered() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("run");
    let client = sandboxed(&scratch);

    let out = client
        .invoke(
            Operation::Run {
                force: false,
                now: false,
                json_out: None,
            },
            &NoProgress,
        )
        .await
        .expect("run invokes");

    assert_eq!(out.exit_code, Some(0), "{out:?}");
    assert_eq!(
        out.outcome,
        Outcome::Skipped {
            reason: Some("no-config".to_string())
        },
        "a config-less run must be a SKIP with the engine's own reason, never a Delivered: {out:?}"
    );
    // Nothing was generated, so nothing was stamped.
    assert!(
        !scratch.join("state").join("last-run").exists(),
        "the day marker was written by a run that skipped"
    );
}

/// A forced run with no config: exit 2, and the engine's stderr surfaced verbatim.
#[tokio::test(flavor = "multi_thread")]
async fn a_forced_run_with_no_config_is_a_config_error() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("force");
    let client = sandboxed(&scratch);
    let recorder = Recorder::default();

    let out = client
        .invoke(
            Operation::Run {
                force: true,
                now: false,
                json_out: None,
            },
            &recorder,
        )
        .await
        .expect("run --force invokes");

    assert_eq!(out.exit_code, Some(2), "{out:?}");
    assert_eq!(out.outcome, Outcome::ConfigError, "{out:?}");
    assert!(
        out.stderr.contains("No config"),
        "the engine's own explanation must be surfaced, got: {:?}",
        out.stderr
    );
    // The same text reached the progress channel while it was running.
    assert!(
        recorder
            .lines()
            .iter()
            .any(|(op, line)| op == "run" && line.contains("No config")),
        "the config error never reached the progress channel: {:?}",
        recorder.lines()
    );
    // Exit 2 still carries the envelope — the classification is a summary, not a filter.
    assert_eq!(
        out.payload.as_ref().and_then(|p| p["skipReason"].as_str()),
        Some("no-config"),
        "the envelope was discarded on the exit-2 path: {out:?}"
    );
    assert!(
        !scratch.join("state").join("last-run").exists(),
        "a forced run with no config stamped the day"
    );
}

/// A forced run against a config that EXISTS and does not parse: exit 2, `config-error`, and the
/// engine's stderr surfaced. The other exit-2 leg (`a_forced_run_with_no_config_is_a_config_error`)
/// reaches that code through the no-config branch of the same catch; this one reaches it through
/// the malformed-file branch, which is the one a Settings screen will actually produce.
///
/// MEASURED before this test was written: `env -i HOME=<tmp> XDG_CONFIG_HOME=<tmp>
/// DAILY_BRIEFING_STATE_DIR=<tmp>/state <sidecar> run --json --force` with `{ this is not json`
/// at `<tmp>/daily-briefing/config.json` → exit 2, stderr `Config error: SyntaxError: Failed to
/// parse JSON`, envelope `skipReason: "config-error"`; the state dir gained `last-tick` and
/// `last-skip.json` and no `last-run`.
#[tokio::test(flavor = "multi_thread")]
async fn a_forced_run_with_a_malformed_config_is_a_config_error() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("badcfg");
    let client = sandboxed(&scratch);
    // `sandbox_env` points XDG_CONFIG_HOME at `<scratch>/config`, so the engine's `configPath()`
    // is `<scratch>/config/daily-briefing/config.json` (`src/config.ts`).
    let config_dir = scratch.join("config").join("daily-briefing");
    std::fs::create_dir_all(&config_dir).expect("config dir");
    std::fs::write(config_dir.join("config.json"), "{ this is not json").expect("a bad config");
    let recorder = Recorder::default();

    let out = client
        .invoke(
            Operation::Run {
                force: true,
                now: false,
                json_out: None,
            },
            &recorder,
        )
        .await
        .expect("run --force invokes");

    assert_eq!(out.exit_code, Some(2), "{out:?}");
    assert_eq!(out.outcome, Outcome::ConfigError, "{out:?}");
    assert!(
        out.stderr.contains("Config error"),
        "the engine's own explanation must be surfaced, got: {:?}",
        out.stderr
    );
    assert!(
        recorder
            .lines()
            .iter()
            .any(|(op, line)| op == "run" && line.contains("Config error")),
        "the config error never reached the progress channel: {:?}",
        recorder.lines()
    );
    assert_eq!(
        out.payload.as_ref().and_then(|p| p["skipReason"].as_str()),
        Some("config-error"),
        "the envelope was discarded on the exit-2 path: {out:?}"
    );
    // The sandbox is asserted, not assumed: the engine reported the config it tried to read.
    assert_eq!(
        out.payload
            .as_ref()
            .and_then(|p| p["paths"]["configPath"].as_str()),
        Some(
            config_dir
                .join("config.json")
                .display()
                .to_string()
                .as_str()
        ),
        "the engine did not read the sandbox's config: {out:?}"
    );
    assert!(
        !scratch.join("state").join("last-run").exists(),
        "a forced run with a malformed config stamped the day"
    );
}

/// `schedule install` and `schedule uninstall`, proved to construct the right argv without ever
/// reaching the real engine.
///
/// ⚠ VM-GATED, per plan line 70's live-domain register. `DBA_TEST_UNIT_DIR` redirects where the
/// plist is written (`unitDir` in `src/schedule/install.ts`), and under it the engine's default
/// exec refuses the `launchctl load` and `bootout` themselves (code -2, `SCHEDULER_CHANGE_REFUSED`,
/// spec 3.1.3), so a sandboxed run would not register or remove a LaunchAgent. That refusal is a
/// backstop, not a reason to execute either here: it covers only scheduler changes, and install
/// would still copy a managed binary and run `codesign`, `openssl` and `security` for real (and the
/// fallback `security import` names no keychain, so it would land in the login keychain). The argv
/// is what this layer owns; the rest is the engine's, and it has its own tests.
#[tokio::test(flavor = "multi_thread")]
async fn schedule_mutations_are_argv_only_outside_a_vm() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("sched");
    let dumper = argv_dumper(&scratch.path, "argv.sh");
    let client = EngineClient::with_program(dumper);

    for (op, expected) in [
        (
            Operation::ScheduleInstall {
                invoker: Invoker::App,
                take_over: false,
            },
            "schedule\ninstall\n--invoker\napp\n",
        ),
        (
            Operation::ScheduleUninstall {
                invoker: Invoker::Cli,
                take_over: true,
            },
            "schedule\nuninstall\n--invoker\ncli\n--take-over\n",
        ),
    ] {
        let out = client
            .invoke(op, &NoProgress)
            .await
            .expect("the fake sidecar runs");
        assert_eq!(
            out.stdout, expected,
            "the argv that reached the child is not the one the engine's grammar expects"
        );
        // A narrating command: exit 0 with non-JSON stdout is SUCCESS, not malformed output.
        assert_eq!(out.outcome, Outcome::Delivered, "{out:?}");
        assert!(out.payload.is_none(), "{out:?}");
    }
}

/* ── resolving the sidecar ────────────────────────────────────────────────────────────────────── */

/// A missing sidecar is `SidecarUnresolved` naming the path — never a spawn that "succeeds".
///
/// ⚠ WHY THE STAT EXISTS. MEASURED on macOS: `EngineClient::with_program(<nonexistent>)` under the
/// caffeinate wrapper does NOT fail to spawn — `/usr/bin/caffeinate` is the program, it exists,
/// and it is caffeinate's `exec` that fails — so the result is `Failed { reason: "exit-127" }`
/// with `No such file or directory` on stderr. That classification is kept as it is (an exit code
/// is an exit code); `resolve_sidecar` is what turns "there is no sidecar" into a typed error with
/// the path in it, at startup.
#[test]
fn a_missing_sidecar_is_sidecar_unresolved_with_the_path() {
    let scratch = ScratchDir::new("nosidecar");
    let deps = scratch.join("deps");
    std::fs::create_dir_all(&deps).expect("a deps dir");
    let exe = deps.join("some-test-binary");

    // The pure half: the deps hop and the file name.
    let expected = scratch.join("daily-briefing");
    assert_eq!(sidecar_path_beside(&exe).expect("a path"), expected);
    assert_eq!(
        sidecar_path_beside(&scratch.join("daily-briefing-gui")).expect("a path"),
        expected,
        "outside deps/ the sidecar sits beside the executable"
    );

    // The stat: absent → SidecarUnresolved naming the path.
    match resolve_sidecar(&exe) {
        Err(EngineError::SidecarUnresolved { detail }) => assert!(
            detail.contains(&expected.display().to_string()),
            "the error must name the path it looked at, got: {detail}"
        ),
        other => panic!("expected SidecarUnresolved for a missing sidecar, got {other:?}"),
    }

    // Present, a regular file, and EXECUTABLE → the path. The mode is load-bearing since round 2
    // — see `a_sidecar_that_is_not_a_regular_executable_file_is_unresolved` for what a 0o644 file
    // and a directory were measured to do before the check existed.
    std::fs::write(&expected, "#!/bin/sh\nexit 0\n").expect("a sidecar stand-in");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&expected, std::fs::Permissions::from_mode(0o755))
            .expect("an executable stand-in");
    }
    assert_eq!(resolve_sidecar(&exe).expect("resolves"), expected);

    // And in THIS test binary the real one is there, so `bundled()` resolves — which is what
    // `lib.rs::run()` manages at startup.
    let bundled =
        daily_briefing_gui_lib::engine::bundled_sidecar_path().expect("the bundled sidecar");
    assert!(bundled.ends_with("daily-briefing"), "{}", bundled.display());
    assert!(EngineClient::bundled().is_ok());
}

/// Existence is NOT enough: a directory and a non-executable file both pass a bare stat.
///
/// ⚠ MEASURED before this check existed, and it is the same failure the stat already exists to
/// prevent, one class over. With a DIRECTORY at the sidecar path, `resolve_sidecar` returned
/// `Ok(path)` and the caffeinate-wrapped spawn produced `Failed { reason: "exit-126" }` with
/// `…/daily-briefing: Permission denied` on stderr; a regular file with mode `0o644` produced
/// exactly the same thing. Both are plausible accidents — an unpacked bundle whose executable bit
/// was lost to a zip round-trip, a build that created the directory and never wrote the binary —
/// and `exit-126` is not something a user can act on, which is precisely the reasoning that put
/// the existence stat there in the first place.
///
/// The last leg is the anti-vacuity one: the ONLY difference between the refusal and the
/// acceptance is a `chmod`, so the refusals above are about the mode and the type rather than
/// about the path.
#[cfg(unix)]
#[test]
fn a_sidecar_that_is_not_a_regular_executable_file_is_unresolved() {
    use std::os::unix::fs::PermissionsExt;

    fn detail_of(r: Result<std::path::PathBuf, EngineError>) -> String {
        match r {
            Err(EngineError::SidecarUnresolved { detail }) => detail,
            other => panic!("expected SidecarUnresolved, got {other:?}"),
        }
    }

    let scratch = ScratchDir::new("sidecarmode");
    let exe = scratch.join("daily-briefing-gui");
    let sidecar = scratch.join("daily-briefing");
    let named = sidecar.display().to_string();

    // absent
    let detail = detail_of(resolve_sidecar(&exe));
    assert!(
        detail.contains(&named),
        "the absent case must name the path: {detail}"
    );
    assert!(
        detail.contains("No such file"),
        "the absent case must still report the OS error, not a type or mode judgement: {detail}"
    );

    // a directory
    std::fs::create_dir(&sidecar).expect("a directory where the sidecar should be");
    let detail = detail_of(resolve_sidecar(&exe));
    assert!(
        detail.contains(&named) && detail.contains("not a regular file"),
        "a directory must be refused as a TYPE problem, naming the path: {detail}"
    );
    assert!(
        detail.contains("directory"),
        "the detail must say which kind of not-a-file it found: {detail}"
    );
    std::fs::remove_dir(&sidecar).expect("remove the directory");

    // a regular file that nobody may execute
    std::fs::write(&sidecar, "#!/bin/sh\nexit 0\n").expect("a sidecar stand-in");
    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o644)).expect("chmod 644");
    let detail = detail_of(resolve_sidecar(&exe));
    assert!(
        detail.contains(&named) && detail.contains("not executable"),
        "a 0o644 file must be refused as a MODE problem, naming the path: {detail}"
    );
    assert!(
        detail.contains("0644"),
        "the detail must carry the mode it found, or a user cannot tell what to chmod: {detail}"
    );

    // the SAME file, executable — one chmod apart from the refusal above
    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755)).expect("chmod 755");
    assert_eq!(
        resolve_sidecar(&exe).expect("a regular executable file resolves"),
        sidecar
    );

    // and any execute bit is enough: the sidecar is run by its owner, and refusing 0o711 or a
    // group-execute-only file would be a stricter claim than `execve` makes.
    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o700)).expect("chmod 700");
    assert!(resolve_sidecar(&exe).is_ok());
}

/// The exit-127 case, pinned as what it is: a spawn that reached caffeinate and whose utility was
/// not there. Not reinterpreted — see `a_missing_sidecar_is_sidecar_unresolved_with_the_path` for
/// the layer that catches a missing sidecar before this can happen.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn a_nonexistent_program_under_caffeinate_is_exit_127_not_a_spawn_error() {
    let scratch = ScratchDir::new("exit127");
    let client = EngineClient::with_program(scratch.join("no-such-sidecar"));
    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("caffeinate itself spawns");
    assert_eq!(out.exit_code, Some(127), "{out:?}");
    assert_eq!(
        out.outcome,
        Outcome::Failed {
            reason: Some("exit-127".to_string())
        },
        "{out:?}"
    );
    assert!(
        out.stderr.contains("No such file or directory"),
        "caffeinate's own explanation is the stderr: {:?}",
        out.stderr
    );
}

/* ── the fake sidecar: outcome mapping and the progress channel ───────────────────────────────── */

/// Every exit code the engine documents, mapped.
///
/// A fake rather than the real engine because some of these cannot be provoked safely — an exit-1
/// `provider-fail` needs a provider call — and because the mapping is a property of THIS module,
/// not of the engine.
#[tokio::test(flavor = "multi_thread")]
async fn exit_codes_map_to_outcomes() {
    let scratch = ScratchDir::new("exits");

    let cases: Vec<(&str, String, Vec<&str>, i32, Outcome)> = vec![
        (
            "delivered.sh",
            envelope(true, None, 0),
            vec![],
            0,
            Outcome::Delivered,
        ),
        (
            "skipped.sh",
            envelope(false, Some("below-floor"), 0),
            vec![],
            0,
            Outcome::Skipped {
                reason: Some("below-floor".to_string()),
            },
        ),
        (
            "failed.sh",
            envelope(false, Some("provider-fail"), 1),
            vec!["provider exploded"],
            1,
            Outcome::Failed {
                reason: Some("provider-fail".to_string()),
            },
        ),
        (
            "configerror.sh",
            envelope(false, Some("config-error"), 2),
            vec!["Config error: unexpected token"],
            2,
            Outcome::ConfigError,
        ),
        (
            // `schedule verify`'s "the scheduler refused the kick" (gui-seam §3) — not 0, 1 or 2.
            "exit3.sh",
            String::new(),
            vec!["the scheduler refused"],
            3,
            Outcome::Failed {
                reason: Some("exit-3".to_string()),
            },
        ),
    ];

    for (name, stdout, stderr, code, expected) in cases {
        let program = canned(&scratch.path, name, &stdout, &stderr, code);
        let client = EngineClient::with_program(program);
        let out = client
            .invoke(Operation::Status, &NoProgress)
            .await
            .expect("the fake sidecar runs");
        assert_eq!(out.exit_code, Some(code), "{name}: {out:?}");
        assert_eq!(out.outcome, expected, "{name}: {out:?}");
        // Whatever the classification, the raw material survives.
        assert_eq!(out.stdout, stdout, "{name}: stdout was not retained");
        for line in &stderr {
            assert!(
                out.stderr.contains(line),
                "{name}: stderr was not retained: {:?}",
                out.stderr
            );
        }
    }
}

/// Exit 0 with output that should have been JSON and was not: degrade, retain, never panic.
#[tokio::test(flavor = "multi_thread")]
async fn malformed_json_degrades_to_failed_and_keeps_the_raw_output() {
    let scratch = ScratchDir::new("garbage");

    for (name, stdout) in [
        ("truncated.sh", "{\"schemaVersion\":1,\"ok\":tr"),
        ("not-json.sh", "Segmentation fault"),
        ("empty.sh", ""),
        ("two-documents.sh", "{\"a\":1}{\"b\":2}"),
    ] {
        let program = canned(&scratch.path, name, stdout, &[], 0);
        let client = EngineClient::with_program(program);
        let out = client
            .invoke(Operation::Status, &NoProgress)
            .await
            .expect("the fake sidecar runs and the client does not panic");
        assert_eq!(
            out.outcome,
            Outcome::Failed {
                reason: Some("malformed-json".to_string())
            },
            "{name}: {out:?}"
        );
        assert_eq!(
            out.stdout, stdout,
            "{name}: the raw output was discarded, so the user cannot see what came back"
        );
        assert!(out.payload.is_none(), "{name}: {out:?}");
    }
}

/// Stderr reaches the progress channel VERBATIM, line by line, while the process is still running.
///
/// ⚠ VERBATIM IS THE REQUIREMENT, not "roughly". The engine's diagnostics are the user-facing
/// explanation of a skip or a failure; a shell that reformatted them would be maintaining a second,
/// worse copy of every message. So the corpus deliberately carries leading whitespace, a tab, an
/// emoji and a line that looks like a flag.
#[tokio::test(flavor = "multi_thread")]
async fn stderr_reaches_the_progress_sink_verbatim() {
    let scratch = ScratchDir::new("progress");
    let lines = [
        "skipped: another daily-briefing run is already in progress",
        "  indented continuation",
        "with\ta tab",
        "☀️ unicode survives",
        "--this-looks-like-a-flag",
    ];
    let program = canned(
        &scratch.path,
        "chatty.sh",
        &envelope(true, None, 0),
        &lines,
        0,
    );
    let client = EngineClient::with_program(program);
    let recorder = Recorder::default();

    let out = client
        .invoke(Operation::Status, &recorder)
        .await
        .expect("the fake sidecar runs");
    assert_eq!(out.outcome, Outcome::Delivered, "{out:?}");

    let got: Vec<String> = recorder.lines().into_iter().map(|(_, line)| line).collect();
    assert_eq!(
        got,
        lines.iter().map(|l| l.to_string()).collect::<Vec<_>>(),
        "the progress channel did not carry stderr verbatim"
    );
    for (operation, _) in recorder.lines() {
        assert_eq!(operation, "status", "every event names its operation");
    }
    // And nothing from stdout leaked into the progress channel.
    assert!(
        !got.iter().any(|l| l.contains("schemaVersion")),
        "stdout reached the progress channel: {got:?}"
    );
}

/* ── the in-flight guard ──────────────────────────────────────────────────────────────────────── */

/// Two concurrent runs: exactly one runs, the other is refused. Not queued — refused.
///
/// ⚠ Seen red by REMOVING the guard: delete the `InFlight::try_acquire` line in `src/engine.rs` on
/// a disposable copy and both invocations succeed.
///
/// ⚠ `Box::pin`, NOT `tokio::pin!`, AND THE DIFFERENCE IS THE WHOLE CANCELLATION ASSERTION.
/// MEASURED: with `tokio::pin!`, the name is rebound to a `Pin<&mut Future>` over a future that
/// still lives on the stack, so `drop(first)` drops the *pointer* and the future — and its
/// in-flight guard, and its child — survive untouched. The final section below failed with a
/// `Busy` that proved nothing about cancellation. A boxed future is owned by the binding, so
/// dropping it actually drops it.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_mutating_invocation_is_refused_as_busy() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("busy");
    let program = sleeper(&scratch.path, "slow.sh", 30);
    let client = EngineClient::with_program(program);

    let mut first = Box::pin(client.invoke(
        Operation::Run {
            force: false,
            now: false,
            json_out: None,
        },
        &NoProgress,
    ));

    // Poll the first future far enough to have spawned and taken the guard.
    assert!(
        tokio::time::timeout(Duration::from_millis(600), &mut first)
            .await
            .is_err(),
        "the sleeping fake sidecar exited early; the rest of this test would be vacuous"
    );

    let second = client
        .invoke(
            Operation::Run {
                force: true,
                now: false,
                json_out: None,
            },
            &NoProgress,
        )
        .await;
    assert_eq!(
        second,
        Err(EngineError::Busy {
            running: "run".to_string()
        }),
        "a second run was not refused while one was in flight"
    );

    // A READ-ONLY operation is deliberately NOT blocked: a polling panel must not start failing
    // because a run is in progress. This is the scoping decision `Operation::is_mutating` encodes.
    let scratch2 = ScratchDir::new("busy-read");
    let reader = EngineClient::with_program(canned(
        &scratch2.path,
        "quick.sh",
        &envelope(true, None, 0),
        &[],
        0,
    ));
    let read = reader.invoke(Operation::Status, &NoProgress).await;
    assert!(
        read.is_ok(),
        "a read-only operation was blocked by an in-flight run: {read:?}"
    );
    // Phase E (E12): "Check now" works while a run is in flight — `update --check` takes no guard.
    // `Ok` with the fake's own exit 0 means the check really SPAWNED and completed (not merely "was
    // not refused"), and it did so while `first` still holds the guard.
    let checked = reader.invoke(Operation::UpdateCheck, &NoProgress).await;
    let checked = checked
        .unwrap_or_else(|e| panic!("an update check was refused while a run was in flight: {e:?}"));
    assert_eq!(
        (checked.operation.as_str(), checked.exit_code),
        ("update-check", Some(0)),
        "the update check did not run to completion while a run was in flight: {checked:?}"
    );

    // Dropping a running invocation must release the guard, or a cancelled run would wedge the app
    // until restart.
    drop(first);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let mut after = Box::pin(client.invoke(
        Operation::Run {
            force: false,
            now: false,
            json_out: None,
        },
        &NoProgress,
    ));
    let verdict = tokio::time::timeout(Duration::from_millis(600), &mut after).await;
    assert!(
        verdict.is_err(),
        "after the first invocation was dropped, a new run should have STARTED (and then still be \
         sleeping), but it returned: {verdict:?}"
    );
    drop(after);
}

/// The guard is ONE slot for every state-changing operation, not one per operation: a `schedule
/// uninstall` is refused while a `schedule install` is in flight, and the refusal names what is
/// running.
///
/// ⚠ Seen red by dropping `ScheduleInstall` from `is_mutating` on a disposable copy: the install
/// then takes no guard, the uninstall is admitted, and the `Busy` assertion fails.
#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_uninstall_is_refused_while_a_schedule_install_is_in_flight() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("schedbusy");
    let client = EngineClient::with_program(sleeper(&scratch.path, "slow.sh", 30));

    let mut install = Box::pin(client.invoke(
        Operation::ScheduleInstall {
            invoker: Invoker::App,
            take_over: false,
        },
        &NoProgress,
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(600), &mut install)
            .await
            .is_err(),
        "the sleeping fake sidecar exited early; the rest of this test would be vacuous"
    );

    let uninstall = client
        .invoke(
            Operation::ScheduleUninstall {
                invoker: Invoker::App,
                take_over: false,
            },
            &NoProgress,
        )
        .await;
    assert_eq!(
        uninstall,
        Err(EngineError::Busy {
            running: "schedule-install".to_string()
        }),
        "a schedule uninstall was not refused while a schedule install was in flight"
    );
    drop(install);
}

/* ── the process-group kill ───────────────────────────────────────────────────────────────────── */

/// ⚠ A COMPLETED INVOCATION DOES NOT KILL THE GROUP — the inverse of `tests/watcher.rs`'s
/// `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked`, and the only test that makes
/// `ProcessGroupKill::disarm` mutable-to-red.
///
/// An ABANDONED invocation SIGKILLs the whole process group its spawn was given. The other half of
/// that contract is that a completed one must NOT: an engine run that deliberately backgrounded
/// something has to keep it. Without this test, deleting the `disarm()` call leaves the entire
/// suite green — every other fake exits leaving nothing behind, so the `killpg` finds a group with
/// nothing signallable in it and changes no observable thing.
///
/// ⚠ Seen red on a disposable copy, twice: with `group.disarm()` replaced by `let _ = &group;`, and
/// again with the whole disarm removed in favour of the pre-revision ordering. Both fail here, at
/// the liveness check below.
///
/// ⚠ THE SLEEPER'S STDIO GOES TO `/dev/null`, AND THAT IS LOAD-BEARING. A background child that
/// inherited the pipes holds them open, `read_all`/`stream_stderr` run to EOF, and `invoke` would
/// not return until the sleeper exited — so the test would be measuring a 41 s wait rather than a
/// disarm. (That same inheritance is why `invoke` drains the pipes BEFORE calling `child.wait()`,
/// and disarms only on its return; `tests/watcher.rs`'s
/// `a_timed_out_read_kills_a_child_that_outlived_the_sidecar` is the test that pins that ordering,
/// with a fake whose sleeper deliberately does NOT redirect its stdio.)
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_completed_invocation_leaves_what_the_engine_backgrounded_running() {
    let scratch = ScratchDir::new("bgkept");
    let tag = scratch.tag();
    let _reap = ReapTagged(tag.clone());
    // `sleeper` is called for its tagged `<scratch>/sleep` symlink; its own script is unused.
    let _ = sleeper(&scratch.path, "unused.sh", 1);
    let child_pid_file = scratch.join("child.pid");
    let program = fake_sidecar(
        &scratch.path,
        "backgrounding.sh",
        &format!(
            "\"{sleep}\" 41 >/dev/null 2>&1 &\necho $! > \"{child}\"\nprintf '%s' {envelope}\nexit 0",
            sleep = scratch.join("sleep").display(),
            child = child_pid_file.display(),
            envelope = sq(&envelope(true, None, 0)),
        ),
    );

    // ⚠ BOUNDED, because the failure this test is most likely to hit is a HANG: if the sleeper
    // ever inherited the pipes, `invoke` would not return until it exited and the test would sit
    // there for 41 s before anyone learned why. Every sibling process test reaches the engine
    // through `EngineSnapshots`' timeout; this one calls `invoke` directly, so it brings its own.
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        EngineClient::with_program(program).invoke(Operation::Status, &NoProgress),
    )
    .await
    .expect(
        "`invoke` returned within 10 s — a longer wait means the backgrounded sleeper is \
             holding the pipes open, which is the one thing this fake must not do",
    )
    .expect("the fake sidecar runs");
    assert_eq!(
        outcome.outcome,
        Outcome::Delivered,
        "the invocation did not complete normally, so the disarm branch was never reached: \
         {outcome:?}"
    );

    let child_pid = std::fs::read_to_string(&child_pid_file)
        .unwrap_or_default()
        .trim()
        .to_string();
    assert!(
        child_pid.parse::<u32>().is_ok(),
        "the fake never recorded a background child ({child_pid:?}), so nothing was measured"
    );
    // ⚠ IT MUST STAY ALIVE, not merely be alive once. A single sample here runs microseconds after
    // `invoke`'s locals drop, which is exactly when a deleted `disarm()` would fire its `killpg` —
    // so the one-shot form could miss the mutant and pass silently. Polling across a window makes
    // the failure direction loud instead.
    let watch_until = tokio::time::Instant::now() + Duration::from_millis(500);
    while tokio::time::Instant::now() < watch_until {
        assert!(
            !process_gone(&child_pid),
            "a COMPLETED invocation killed the process group anyway: the background child (pid \
             {child_pid}) it deliberately left running is gone"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// This process's own process-group id, read from `ps`.
///
/// ⚠ NOT FROM `libc::getpgrp()`, deliberately: the predicate under test asks libc that question
/// itself, so an oracle that asked it the same way would agree with the implementation even when
/// both are wrong. `ps` is an independent answer to "what group is this process in".
#[cfg(unix)]
fn own_pgid() -> i32 {
    let out = std::process::Command::new("ps")
        .args(["-o", "pgid=", "-p", &std::process::id().to_string()])
        .output()
        .expect("ps runs");
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .expect("ps prints a numeric pgid")
}

/// ⚠ THE IDS A `killpg` MUST NEVER BE SENT TO, and the reason `ProcessGroupKill` is public.
/// `engine::EngineClient::invoke` signals the group it created on an abandoned invocation; `0`
/// means *this process's own group* to `killpg`, and so does this process's actual group number,
/// so either would SIGKILL the app — or this test runner — instead of the sidecar. Neither can be
/// provoked through `invoke` without doing exactly that, which is why the refusal is pinned here
/// on the predicate rather than end-to-end.
///
/// The last case is the decoy: an ordinary id must still be accepted, or a predicate that refused
/// everything would pass the three above while the guard silently never fired again.
///
/// ⚠ WHAT THIS DOES NOT PIN, said plainly: the predicate's WIRING. Deleting the `.filter(…)` that
/// calls it in `ProcessGroupKill::arm` leaves this test — and the whole suite — green, because
/// neither refused id is reachable through a real spawn. That unreachability is the reason the
/// refusal is defence against a future second construction site rather than a live guard, and it is
/// recorded on `is_signalable` itself.
///
/// ⚠ Seen red on a disposable copy, both directions: dropping `pgid != own` from
/// `is_signalable` turns the own-group case green-to-red, and dropping `pgid > 1` does the same
/// for `0` and `1`.
#[cfg(unix)]
#[test]
fn the_process_group_kill_refuses_reserved_ids_and_its_own_group() {
    assert!(
        !ProcessGroupKill::is_signalable(0),
        "0 is `this process's own group` to killpg"
    );
    assert!(!ProcessGroupKill::is_signalable(1), "1 is init's group");
    assert!(
        !ProcessGroupKill::is_signalable(-1),
        "a negative id is not a group this app created"
    );

    let own = own_pgid();
    assert!(
        own > 1,
        "this test runner's own process group is {own}, which the reserved-id rule would have \
         refused anyway — the case below would not be measuring the own-group rule"
    );
    assert!(
        !ProcessGroupKill::is_signalable(own),
        "the test runner's own process group ({own}) passed the check that exists to refuse it"
    );
    assert!(
        ProcessGroupKill::is_signalable(own + 1),
        "an ordinary group id ({}) was refused, so the guard would never fire at all",
        own + 1
    );
}
