//! T9 — environment parity: the launchd PATH, and the `caffeinate` wrapper.
//!
//! Two launchd behaviours the app has to reproduce or silently lose.
//!
//!   1. **PATH.** A GUI app launched from Finder or as a login item gets a minimal environment, NOT
//!      the user's interactive shell PATH — so the sidecar would fail to find `claude`/`codex` and
//!      every morning would end in a missing-binary ProviderError with a confusing message. It does
//!      not reproduce under `cargo tauri dev`, which inherits the developer's shell PATH, so it only
//!      shows up for the stranger.
//!   2. **`caffeinate -i`.** The plist wraps the engine in it (`src/schedule/units.ts`,
//!      `launchdPlist`) so a 30-120s provider call cannot be interrupted by idle sleep. Plan R1
//!      grafts it onto ALL app spawns, not only scheduled ones.
//!
//! ⚠ **NOTHING HERE SPAWNS THE REAL ENGINE, and nothing here uses a MUTATING operation.** Every
//! test drives a fake sidecar that reports its own environment, its own argv, or sleeps. The
//! mutating operations are excluded deliberately: the in-flight guard they take is process-global,
//! and `tests/engine_client.rs` already serialises the tests that contend for it — a second binary
//! doing the same would have no way to take turns with the first.
//!
//! ⚠ **AND NOTHING HERE MUTATES THE PROCESS ENVIRONMENT.** The tests that do — the parent-leak
//! test and the Linux session-bus test, beside the forwarded-set literal pin that documents them —
//! live in `engine_env_parent.rs`, which is a SEPARATE TEST BINARY and therefore a separate
//! process. `std::env::set_var` is
//! process-wide and `cargo test` runs a binary's tests on parallel threads, so a `PATH` sentinel
//! set for one test was live inside every sibling for the duration. The one that matters is
//! [`path_is_ours_and_is_never_inherited`]: its anti-vacuity `assert_ne!` compares the launchd PATH
//! against `std::env::var("PATH")` to prove it can tell reproduction from inheritance, and a
//! sentinel silently standing in for the real PATH would make that comparison measure nothing.
//! No contamination was actually found — none of the four mutated names is forwarded, PATH is never
//! inherited, and the sentinel differs from `launchd_path` — but the window was real, and the fix
//! is to remove the mutation from this process rather than to serialise around it: a serialiser
//! could only gate tests that agree to take it, while `EngineClient::env_plan` reads `HOME` through
//! `std::env::var_os` on every single spawn and `#[tokio::test]`'s own runtime threads read
//! whatever they read. A second process has no window to gate.

mod common;

use std::path::Path;
#[cfg(target_os = "macos")]
use std::time::Duration;

#[cfg(target_os = "macos")]
use common::sleeper;
use common::{env_dumper, parse_env, ScratchDir};
use daily_briefing_gui_lib::engine::{
    forwarded_env, launchd_path, EngineClient, NoProgress, Operation, BUN_CRASH_REPORTING_OFF,
};

/* ── (1) PATH ─────────────────────────────────────────────────────────────────────────────────── */

/// The engine source that owns the value, relative to this crate.
const UNIT_GENERATOR: &str = "../../src/schedule/install.ts";

/// The one PATH the app and the OS scheduler must agree on, read out of the ENGINE at test time.
///
/// ⚠ THE APPENDIX'S CITATION IS STALE AND THIS IS WHERE THAT MATTERS. gui-tauri T9 says
/// *"install.sh:82 sets exactly `$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`"*.
/// That line no longer exists: A2 deleted the checked-in plist template and the `sed` that filled
/// it, and moved unit generation into the engine — `scripts/install.sh` now says so in as many
/// words ("THE PLIST HALF IS DELEGATED TO THE BINARY"), and `grep -n PATH scripts/install.sh`
/// returns nothing. The value lives in `installSchedule`'s `ScheduleOpts` and reaches the plist's
/// `EnvironmentVariables` through `src/schedule/units.ts`. Parsing the file the appendix named
/// would have been an anti-drift test anchored to a constant that is not the source of truth — i.e.
/// a test that passes forever while the two drift.
///
/// Returns the literal with the `${join(d.home, ".local", "bin")}` interpolation replaced by
/// `<home>/.local/bin`, so it can be compared to `launchd_path(<home>)` character for character.
fn engine_path_literal(home: &Path) -> String {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(UNIT_GENERATOR);
    let text = std::fs::read_to_string(&source).unwrap_or_else(|e| {
        panic!(
            "could not read the engine's unit installer at {} ({e}). If it moved, this test must \
             follow it — the whole point is that the PATH has ONE definition.",
            source.display()
        )
    });

    let marker = "pathEnv: `";
    let start = text.find(marker).unwrap_or_else(|| {
        panic!(
            "no `pathEnv:` template literal in {}. The engine's launchd PATH is what \
             `engine::launchd_path` reproduces; if the engine stopped spelling it here, find where \
             it moved rather than deleting this test.",
            source.display()
        )
    }) + marker.len();
    let end = start
        + text[start..]
            .find('`')
            .expect("the pathEnv template literal is terminated");
    let literal = &text[start..end];

    let interpolation = r#"${join(d.home, ".local", "bin")}"#;
    assert!(
        literal.contains(interpolation),
        "the engine's pathEnv literal no longer starts with {interpolation} — it is now \
         {literal:?}, and this test's substitution would silently compare the wrong strings"
    );
    literal.replace(
        interpolation,
        &home.join(".local").join("bin").display().to_string(),
    )
}

/// The anti-drift pin: the Rust constant and the engine's plist generator produce the same string.
///
/// ⚠ Seen red by editing `launchd_path` on a disposable copy — drop `/opt/homebrew/bin` and this
/// fails naming both strings.
#[test]
fn the_rust_path_constant_matches_the_engine_unit_generator() {
    let home = Path::new("/Users/somebody");
    assert_eq!(
        launchd_path(home),
        engine_path_literal(home),
        "the app's PATH and the launchd unit's PATH have diverged. They are the same contract: a \
         provider CLI the scheduled run can find and the app cannot (or the reverse) is a briefing \
         that works on one trigger and not the other."
    );

    // prove-it 3b: the parse is the part that could pass while the claim is false. A `find` that
    // returned an empty literal would make the comparison trivially true for an empty constant.
    let parsed = engine_path_literal(home);
    assert!(
        parsed.contains("/opt/homebrew/bin") && parsed.contains("/usr/bin") && parsed.len() > 30,
        "the parse produced something implausible ({parsed:?}); the comparison above would be \
         vacuous"
    );
}

/// Variables the child's environment gains from the processes BETWEEN us and it, rather than from
/// us. Named rather than ignored: the environment is not pristine, and pretending otherwise would
/// make the "otherwise minimal" assertion below softer than it reads.
///
///   * `PWD`, `SHLVL`, `OLDPWD`, `_` — `/bin/sh`, which the fake sidecar is, sets these on itself
///     before `exec`ing, so they survive into the image that reports them.
///   * `__CF_USER_TEXT_ENCODING` — CoreFoundation, via `caffeinate`. MEASURED:
///     `env -i PATH=… HOME=… /tmp/dump.sh` reports four variables and
///     `env -i PATH=… HOME=… /usr/bin/caffeinate -i /tmp/dump.sh` reports the same four plus this
///     one. It is the wrapper's, not a leak of the parent's — which
///     `the_environment_is_otherwise_minimal` proves directly by also spawning without the wrapper.
const PASS_THROUGH_ARTEFACTS: &[&str] = &["PWD", "SHLVL", "OLDPWD", "_", "__CF_USER_TEXT_ENCODING"];

/// PATH is ours, and the parent's is not inherited.
///
/// The client always `env_clear()`s, so every spawn IS the emptied-environment case the task asks
/// to be measured — there is no "inherited" mode to compare against. The comparison that gives the
/// claim teeth is therefore against the TEST PROCESS's own PATH: if the two were equal this test
/// could not tell inheritance from reproduction, and it says so rather than passing quietly.
#[tokio::test(flavor = "multi_thread")]
async fn path_is_ours_and_is_never_inherited() {
    let scratch = ScratchDir::new("path");
    let client = EngineClient::with_program(env_dumper(&scratch.path, "env.sh"));

    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs");
    let child = parse_env(&out.stdout);

    let home = std::env::var("HOME").expect("a HOME in the test environment");
    let expected = launchd_path(Path::new(&home));
    assert_eq!(
        child.get("PATH").map(String::as_str),
        Some(expected.as_str()),
        "the child's PATH is not the launchd one. Full child environment: {child:#?}"
    );

    let ours = std::env::var("PATH").expect("a PATH in the test environment");
    assert_ne!(
        ours, expected,
        "the test process's own PATH happens to equal the launchd PATH, so this test cannot \
         distinguish 'reproduced' from 'inherited'. That is not a pass — re-run it from a shell \
         with a different PATH."
    );
}

/// Everything except the forwarded set ([`forwarded_env`]: per OS), PATH, and the shell's own
/// additions is dropped.
///
/// ⚠ INTERROGATED BEFORE IT IS BELIEVED (prove-it 3b): the assertion is vacuous unless the PARENT
/// actually carries a variable outside the forwarded set, so that is asserted first. `cargo test`
/// supplies several `CARGO_*` variables to the test binary, which is what makes the discriminator
/// reliable rather than incidental.
#[tokio::test(flavor = "multi_thread")]
async fn the_environment_is_otherwise_minimal() {
    let parent_has_a_cargo_var =
        std::env::vars_os().any(|(k, _)| k.to_string_lossy().starts_with("CARGO_"));
    assert!(
        parent_has_a_cargo_var,
        "the test process carries no CARGO_* variable, so the leak check below would pass without \
         measuring anything. Pick another discriminator rather than deleting the check."
    );

    let scratch = ScratchDir::new("minimal");
    let client = EngineClient::with_program(env_dumper(&scratch.path, "env.sh"));
    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs");
    let child = parse_env(&out.stdout);

    let leaked: Vec<&String> = child.keys().filter(|k| k.starts_with("CARGO_")).collect();
    assert!(
        leaked.is_empty(),
        "the parent's environment leaked into the engine: {leaked:?}"
    );

    let allowed: Vec<&str> = forwarded_env()
        .into_iter()
        .chain(std::iter::once("PATH"))
        .chain(std::iter::once(BUN_CRASH_REPORTING_OFF.0))
        .chain(PASS_THROUGH_ARTEFACTS.iter().copied())
        .collect();
    let unexpected: Vec<&String> = child
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .collect();
    assert!(
        unexpected.is_empty(),
        "the child received variables outside the forwarded set: {unexpected:?}. If one of them is \
         genuinely needed, add it to engine::FORWARDED_ENV (or, Linux-only, FORWARDED_ENV_LINUX) \
         with a reason; do not widen this test."
    );

    // ⚠ THE ARTEFACT LIST IS NOT A LOOPHOLE, and this is what keeps it from becoming one. Spawn the
    // SAME dumper without the caffeinate wrapper: `__CF_USER_TEXT_ENCODING` must vanish, proving it
    // came from CoreFoundation inside `caffeinate` rather than from the environment we built. A
    // variable that survived both spawns would be a genuine leak wearing an artefact's name.
    let direct = EngineClient::with_program(env_dumper(&scratch.path, "env.sh"))
        .with_caffeinate_path(scratch.join("no-such-caffeinate"));
    let direct = direct
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs unwrapped");
    let direct = parse_env(&direct.stdout);
    assert!(
        !direct.contains_key("__CF_USER_TEXT_ENCODING"),
        "__CF_USER_TEXT_ENCODING survives an UNWRAPPED spawn, so it is not caffeinate's — it is \
         reaching the child from somewhere this test has mislabelled: {direct:#?}"
    );
    let unexpected: Vec<&String> = direct
        .keys()
        .filter(|k| !allowed.contains(&k.as_str()))
        .collect();
    assert!(
        unexpected.is_empty(),
        "the unwrapped child received variables outside the forwarded set: {unexpected:?}"
    );
}

/// Bun's runtime crash reporter is OFF in the child — the README's Privacy section promises it.
///
/// The engine is a Bun-compiled binary whose runtime, by default on macOS and Windows, uploads a crash
/// trace to `bun.report` if Bun itself panics. `BUN_ENABLE_CRASH_REPORTING=0` in the child's own
/// environment turns that off. Asserted on BOTH spawn shapes (caffeinate-wrapped and direct) and with
/// a harness override present, so neither the wrapper nor `with_env` can be what drops it.
#[tokio::test(flavor = "multi_thread")]
async fn bun_crash_reporting_is_turned_off_in_the_child() {
    assert_eq!(BUN_CRASH_REPORTING_OFF, ("BUN_ENABLE_CRASH_REPORTING", "0"));
    let scratch = ScratchDir::new("bunreport");
    for client in [
        EngineClient::with_program(env_dumper(&scratch.path, "env.sh"))
            .with_env("DAILY_BRIEFING_STATE_DIR", "/tmp/somewhere/state"),
        EngineClient::with_program(env_dumper(&scratch.path, "env.sh"))
            .with_caffeinate_path(scratch.join("no-such-caffeinate")),
    ] {
        let out = client
            .invoke(Operation::Status, &NoProgress)
            .await
            .expect("the env dumper runs");
        let child = parse_env(&out.stdout);
        assert!(child.contains_key("PATH"), "non-vacuity: the dump was parsed: {child:#?}");
        assert_eq!(
            child.get("BUN_ENABLE_CRASH_REPORTING").map(String::as_str),
            Some("0"),
            "the engine would be spawned with Bun's crash reporter in its default state"
        );
    }
}

/// The override the T15 Settings field will feed. No UI is built here; this is the seam.
///
/// ⚠ IT REPLACES, IT DOES NOT PREPEND. A T15 value of `/opt/somewhere/bin` alone would lose
/// `/usr/bin` and with it `git`; the Settings field must prepend to `launchd_path` (or the UI
/// must say the value is the whole PATH). `docs/gui-seam.md` §6 records this for T15.
#[tokio::test(flavor = "multi_thread")]
async fn a_path_override_replaces_the_launchd_path() {
    let scratch = ScratchDir::new("override");
    let custom = "/opt/somewhere/bin:/usr/bin:/bin";
    let client =
        EngineClient::with_program(env_dumper(&scratch.path, "env.sh")).with_path_override(custom);

    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs");
    assert_eq!(
        parse_env(&out.stdout).get("PATH").map(String::as_str),
        Some(custom)
    );
}

/// The sandbox overrides a test passes reach the child, and do not displace PATH.
#[tokio::test(flavor = "multi_thread")]
async fn explicit_overrides_reach_the_child_without_displacing_path() {
    let scratch = ScratchDir::new("extra");
    let client = EngineClient::with_program(env_dumper(&scratch.path, "env.sh"))
        .with_env("DAILY_BRIEFING_STATE_DIR", "/tmp/somewhere/state");

    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs");
    let child = parse_env(&out.stdout);
    assert_eq!(
        child.get("DAILY_BRIEFING_STATE_DIR").map(String::as_str),
        Some("/tmp/somewhere/state")
    );
    let home = std::env::var("HOME").expect("a HOME");
    assert_eq!(
        child.get("PATH").map(String::as_str),
        Some(launchd_path(Path::new(&home)).as_str())
    );
}

/* ── (2) caffeinate ───────────────────────────────────────────────────────────────────────────── */

/// Every live process whose command line carries `tag` — ANY name, not only the caffeinate
/// wrapper. `pgrep -fl` because the full command line is the only thing that distinguishes this
/// test's processes from any other on the machine: the tag is the scratch directory's unique name,
/// which appears in the sidecar path caffeinate was given AND in the sleeper's argv[0] (see
/// `common::sleeper` for why that takes a symlink).
///
/// ⚠ THE TAG MUST NOT CONTAIN THE WORD `caffeinate`. The "during" assertion picks the wrapper out
/// of this list by `/usr/bin/caffeinate`; MEASURED, a scratch dir named `…-caffeinate-…` makes
/// every line match that and the count means nothing.
#[cfg(target_os = "macos")]
fn processes_carrying(tag: &str) -> Vec<String> {
    assert!(
        !tag.contains("caffeinate"),
        "the scratch tag {tag:?} contains the word the during-assertion filters on; see the note \
         above"
    );
    let out = std::process::Command::new("/usr/bin/pgrep")
        .arg("-fl")
        .arg(tag)
        .output()
        .expect("pgrep runs");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

/// Every macOS spawn is `/usr/bin/caffeinate -i <sidecar> <argv…>`, in that order.
///
/// ⚠ THE ORDER IS THE CONTRACT, and it is the engine's own (`src/schedule/units.ts`: *"putting it
/// after the binary would make it an argument TO the briefing rather than a wrapper around it"*).
#[cfg(target_os = "macos")]
#[test]
fn the_macos_command_line_is_caffeinate_wrapping_the_sidecar() {
    let scratch = ScratchDir::new("caffargv");
    let program = sleeper(&scratch.path, "slow.sh", 1);
    let client = EngineClient::with_program(program.clone());

    let (executed, argv) = client.command_line(&Operation::Status);
    assert_eq!(executed, Path::new("/usr/bin/caffeinate"));
    assert_eq!(
        argv,
        vec![
            "-i".to_string(),
            program.display().to_string(),
            "status".to_string(),
            "--json".to_string(),
        ]
    );
}

/// The wrapper is real at runtime, and dropping the invocation leaves NOTHING of this spawn behind
/// — not the sidecar, not the caffeinate child.
///
/// ⚠ WHAT IS ACTUALLY BEING KILLED, because an earlier revision of this test described the
/// inverse. `caffeinate -i <utility>` `exec`s the utility into the spawned pid and forks the
/// assertion holder as the utility's CHILD (MEASURED: spawned pid = the sleeper, `/usr/bin/
/// caffeinate -i …` has ppid = the sleeper). So `kill_on_drop` kills the SIDECAR, and the
/// caffeinate child exits with its parent. What `kill_on_drop` alone does NOT reach is anything the
/// sidecar itself forked, which is why the fake sidecar here `exec`s its sleeper rather than forking
/// it: a fake that forks `sleep 30` left an orphan the same way a real sidecar would leave a `git`
/// mid-clone, two per suite run (`pgrep -fl 'sleep 30'` after `cargo test`). That residual is now
/// closed by the process-group kill on the drop (`engine::ProcessGroupKill`), and the forking shape
/// is covered by `tests/watcher.rs`'s
/// `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked`; this test keeps the `exec`ing
/// fake because what it is about is the WRAPPER's topology. In the shipped app the future is never
/// dropped mid-flight (`engine::InFlight`) except by the read timeout, and the engine's `run.lock`
/// is what handles a sidecar that outlives its caller.
///
/// The assertion is therefore over EVERY process carrying the tag, any name, not only the
/// wrapper — a leak of the sidecar itself would be invisible to a caffeinate-only filter.
///
/// Drops a `Box::pin`ned future rather than a `tokio::pin!`ed one: MEASURED in
/// `tests/engine_client.rs`, dropping a `tokio::pin!` binding drops the pointer and leaves the
/// future (and its child) alive on the stack.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_invocation_leaves_nothing_of_the_spawn_behind() {
    // ⚠ The tag must not contain "caffeinate" — see `processes_carrying`.
    let scratch = ScratchDir::new("wrapped");
    let tag = scratch.tag();
    assert!(
        processes_carrying(&tag).is_empty(),
        "a process already matches this test's unique tag before it started — the count below \
         would be meaningless"
    );

    let client = EngineClient::with_program(sleeper(&scratch.path, "slow.sh", 30));
    let mut running = Box::pin(client.invoke(Operation::Status, &NoProgress));
    assert!(
        tokio::time::timeout(Duration::from_millis(800), &mut running)
            .await
            .is_err(),
        "the sleeping fake sidecar exited early; the rest of this test would be vacuous"
    );

    // Exactly two processes carry the tag while it runs: the sidecar (the exec'd sleeper, whose
    // argv[0] is `<scratch>/sleep`) and the caffeinate child that names the sidecar script.
    //
    // ⚠ WAIT FOR THE `exec`, DO NOT ASSUME IT. MEASURED: with this binary's tests spawning in
    // parallel, `/bin/sh`'s `exec` of the sleeper regularly takes more than 800ms and up to ~2s
    // (10 concurrent `caffeinate -i <script>` spawns from a shell: 5-8 of 10 still showed the
    // pre-exec `/bin/sh` image at 800ms, 0 of 10 at 2.3s — the same for a symlinked, a direct and
    // an `exec -a` sleeper, so it is exec-under-load, not the symlink). Serially it is well under
    // 800ms. A fixed sleep here was a test that failed under `cargo test` and passed under
    // `--test-threads=1`; polling for the post-exec image is what makes it a measurement.
    let mut during = processes_carrying(&tag);
    for _ in 0..200 {
        if during.iter().any(|l| l.contains("/sleep 30")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        during = processes_carrying(&tag);
    }
    let wrappers: Vec<&String> = during
        .iter()
        .filter(|l| l.contains("/usr/bin/caffeinate"))
        .collect();
    let sleepers: Vec<&String> = during.iter().filter(|l| l.contains("/sleep 30")).collect();
    assert_eq!(
        (during.len(), wrappers.len(), sleepers.len()),
        (2, 1, 1),
        "expected the sidecar and one caffeinate child holding the machine awake, saw: {during:?}"
    );

    drop(running);

    // The drop signals twice — `ProcessGroupKill` the group first, then `kill_on_drop` the pid —
    // and reaping is the runtime's either way, so give it a moment rather than asserting into a
    // race.
    let mut after = processes_carrying(&tag);
    for _ in 0..40 {
        if after.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        after = processes_carrying(&tag);
    }
    assert!(
        after.is_empty(),
        "a process from this spawn outlived the invocation that started it: {after:?}"
    );
}

/// A machine without `/usr/bin/caffeinate` still runs the engine.
///
/// ⚠ FALL BACK, NEVER FAIL. Losing the idle-sleep guard costs a long provider call on a machine
/// that happens to sleep; refusing to spawn costs every briefing. The warning goes to the app's own
/// stderr — this asserts the behaviour, which is the half that matters.
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn a_missing_caffeinate_falls_back_to_a_direct_spawn() {
    let scratch = ScratchDir::new("nocaff");
    let program = common::argv_dumper(&scratch.path, "argv.sh");
    let client = EngineClient::with_program(program.clone())
        .with_caffeinate_path(scratch.join("no-such-caffeinate"));

    let (executed, argv) = client.command_line(&Operation::Status);
    assert_eq!(
        executed, program,
        "with caffeinate missing the sidecar itself must be the program"
    );
    assert_eq!(argv, vec!["status".to_string(), "--json".to_string()]);

    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the engine still runs without caffeinate");
    assert_eq!(
        out.stdout, "status\n--json\n",
        "the fallback spawn did not reach the sidecar with the right argv"
    );
}

/// Off macOS there is no caffeinate and none is attempted: `caffeinate -i` is a macOS tool, and
/// the systemd unit the engine writes for Linux does not wrap anything (`src/schedule/units.ts`).
#[cfg(not(target_os = "macos"))]
#[test]
fn no_caffeinate_is_attempted_off_macos() {
    let scratch = ScratchDir::new("nocaff");
    let program = common::argv_dumper(&scratch.path, "argv.sh");
    let client = EngineClient::with_program(program.clone());

    let (executed, argv) = client.command_line(&Operation::Status);
    assert_eq!(executed, program);
    assert_eq!(argv, vec!["status".to_string(), "--json".to_string()]);
    assert!(
        !argv.iter().any(|a| a.contains("caffeinate")),
        "a caffeinate argument appeared on a non-macOS platform"
    );
}
