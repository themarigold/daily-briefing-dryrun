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
    config_file_path, is_refused_format_character, json_out_name, resolve_sidecar,
    sidecar_path_beside, EngineClient, EngineError, InputRefusal, Invoker, NoProgress, Operation,
    Outcome, ProgressSink, REFUSED_FORMAT_CHARACTERS,
};

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
                json_out: None,
            },
            vec!["run", "--json"],
        ),
        (
            Operation::Run {
                force: true,
                json_out: None,
            },
            vec!["run", "--json", "--force"],
        ),
        (
            Operation::Run {
                force: false,
                json_out: Some(json_out_name("envelope.json").expect("a valid name")),
            },
            vec!["run", "--json", "--json-out", "envelope.json"],
        ),
        (
            Operation::Run {
                force: true,
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
            Operation::UpdateCheck => None,
        }
    }
    let mut all = vec![Operation::Run {
        force: false,
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
            "config-validate",
            "doctor",
            "run",
            "schedule-install",
            "schedule-status",
            "schedule-uninstall",
            "schedule-verify",
            "status",
            "update-check",
        ],
        "the operation set changed. `init` and `calendar` are deliberately absent — the first \
         because first-config creation (T16) is undesigned, the second because the ENGINE does not \
         have it (`src/main.ts`'s KNOWN_COMMANDS). `schedule verify` WAS in that list until B6: the \
         kickstart is still engine-side inside `schedule install` (plan R1), and this operation is \
         the re-run of that same engine-side kick, which is what keeps the app's exec surface \
         engine-only. `update --check` WAS in it until Phase E: E11 gave the engine the subcommand \
         and E12 granted it (notify-only, not mutating). Adding one needs a grant in the capability \
         and a reason in the same change."
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
            json_out: None,
        },
        Operation::Run {
            force: true,
            json_out: None,
        },
        Operation::Run {
            force: false,
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
    let checked = checked.unwrap_or_else(|e| {
        panic!("an update check was refused while a run was in flight: {e:?}")
    });
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
