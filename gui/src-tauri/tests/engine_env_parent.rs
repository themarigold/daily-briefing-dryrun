//! T9 — the PARENT-ENVIRONMENT half of `engine_env.rs`, in a process of its own.
//!
//! ⚠ **WHY A SECOND BINARY RATHER THAN A SERIALISER.** The tests in this file are the only ones in
//! the suite that call `std::env::set_var` / `remove_var`. That is process-wide, and `cargo test` runs a
//! binary's tests on parallel threads — so while it held a sentinel `PATH`, a sentinel
//! `DAILY_BRIEFING_STATE_DIR` and two sentinel provider keys, every sibling test in
//! `engine_env.rs` was running inside that environment. Nothing was measurably contaminated (none
//! of the four names is in `FORWARDED_ENV`, PATH is never inherited, and the sentinel value
//! differs from `launchd_path`), but `path_is_ours_and_is_never_inherited`'s anti-vacuity
//! `assert_ne!` reads `std::env::var("PATH")` to prove it can tell reproduction from inheritance —
//! and that assertion quietly measures nothing if what it reads is this test's sentinel.
//!
//! A `serialise()` gate like `engine_client.rs`'s was the other option and is strictly weaker
//! here. That gate works there because the thing being serialised is an explicit `EngineClient`
//! call that every contending test makes knowingly. The environment has no such chokepoint:
//! `EngineClient::env_plan` reads `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL` and `TZ`
//! through `std::env::var_os` on **every** spawn (`src/engine.rs`, `env_plan`), `home_dir()` reads
//! `HOME` again, and `#[tokio::test]`'s runtime threads read whatever they read — so a gate could
//! only cover the readers that opt in, and "every test in the file takes the lock" is a
//! single-threaded binary written the long way. A separate process has no window to gate at all.
//! It is also the honest shape: `set_var` in a multi-threaded process is a data race against every
//! concurrent `getenv` in it, which is why the 2024 edition makes it `unsafe`.
//!
//! Three tests live here: the two behavioural ones that do the mutating, and the forwarded-set
//! literal pin they are the other half of — kept beside them because each is the other's
//! explanation, and because it touches no environment at all and so cannot race the ones that do.
//! The two that mutate cannot race EACH OTHER either: [`ParentEnv`] holds [`PARENT_ENV_LOCK`] from
//! its first `set_var` until its last restore, and every spawn either test makes happens inside
//! that window. That is the serialiser argued against above, and it is complete here for the
//! reason it could not be in `engine_env.rs`: nothing else in this process reads the environment.

mod common;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use common::{env_dumper, parse_env, ScratchDir};
use daily_briefing_gui_lib::engine::{
    forwarded_env, launchd_path, EngineClient, NoProgress, Operation, FORWARDED_ENV,
    FORWARDED_ENV_LINUX,
};

/// The forwarded set, by literal, per OS — not "whatever the constants say": exactly these seven
/// everywhere, and these seven plus `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` on Linux.
///
/// ⚠ `engine_env.rs`'s `the_environment_is_otherwise_minimal` derives its allowed set FROM
/// `forwarded_env()`, so it cannot object to the set growing: MEASURED (against the constant it
/// read then), adding `ANTHROPIC_API_KEY` to the constant and setting it in the parent left that
/// test green. This is the pin the set needs; `secrets_and_overrides_in_the_parent_never_reach_the_child`
/// and `the_session_bus_variables_reach_the_child_on_linux_only` are the behavioural halves.
///
/// The Linux extras' CONTENTS are asserted on every host. Which set `forwarded_env()` returns is
/// asserted for the host the test runs on, so the Linux arm runs in CI's `ubuntu-22.04` cargo job.
#[test]
fn the_forwarded_set_is_these_seven_plus_two_on_linux() {
    const SEVEN: [&str; 7] = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ"];
    const LINUX_TWO: [&str; 2] = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
    assert_eq!(
        FORWARDED_ENV, &SEVEN,
        "engine::FORWARDED_ENV changed. Every name here is something a launchd-started process \
         also gets from the session; a secret or an engine override does not belong in this list, \
         whatever the reason — pass it through `with_env` from a caller that knows what it is \
         doing, and say why here."
    );
    assert_eq!(
        FORWARDED_ENV_LINUX, &LINUX_TWO,
        "engine::FORWARDED_ENV_LINUX changed. It is only what `systemctl --user` needs to reach \
         the user's service manager; anything else belongs in neither list."
    );
    let expected: Vec<&str> = if cfg!(target_os = "linux") {
        SEVEN.iter().chain(LINUX_TWO.iter()).copied().collect()
    } else {
        SEVEN.to_vec()
    };
    assert_eq!(
        forwarded_env(),
        expected,
        "engine::forwarded_env() is not the per-OS set: the Linux extras must be forwarded on \
         Linux and ONLY there (the macOS app's environment stays the seven)."
    );
}

/// Held by every [`ParentEnv`] for its whole life, so the tests that mutate this process's
/// environment take turns. A test that panics poisons it; the next one takes it anyway, because
/// the restore in `Drop` has already run by then.
static PARENT_ENV_LOCK: Mutex<()> = Mutex::new(());

/// A variable set in the parent, one per class the forward list must never carry, RAII-restored.
///
/// Field order matters: `Drop::drop` restores the variables first, and only then is `_lock`
/// dropped, so the next test cannot start mutating until this one's environment is back.
struct ParentEnv {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _lock: MutexGuard<'static, ()>,
}

impl ParentEnv {
    fn set(vars: &[(&'static str, &str)]) -> Self {
        let lock = PARENT_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved = vars
            .iter()
            .map(|(k, v)| {
                let prior = std::env::var_os(k);
                std::env::set_var(k, v);
                (*k, prior)
            })
            .collect();
        Self { saved, _lock: lock }
    }
}

impl Drop for ParentEnv {
    fn drop(&mut self) {
        for (key, prior) in self.saved.drain(..) {
            match prior {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// Secrets and engine overrides in the APP's environment never reach the sidecar, and PATH is
/// replaced rather than forwarded.
///
/// Four names, one per class: two provider keys (a developer running `cargo tauri dev` with a key
/// exported is the realistic case, and the engine's `apiKeyEnv` rung would silently spend it),
/// the engine's state-dir override (which redirects every path it reads), and PATH itself. Each
/// is set in the test process, the dumper is spawned, and the child must have none of the first
/// three and exactly `launchd_path(home)` for the fourth.
///
/// ⚠ THE SENTINEL VALUES ARE NOT SECRETS and must never be — they are string literals in a test
/// that appear in a process listing. The PATH sentinel deliberately keeps `/usr/bin` so the dumper
/// could still resolve if the parent's PATH leaked; the assertion is on equality, not on failure.
///
/// ⚠ Seen red on a disposable copy by adding `"ANTHROPIC_API_KEY"` to `engine::FORWARDED_ENV`.
#[tokio::test(flavor = "multi_thread")]
async fn secrets_and_overrides_in_the_parent_never_reach_the_child() {
    let scratch = ScratchDir::new("noleak");
    let sentinel_path = "/nowhere/sentinel/bin:/usr/bin:/bin";
    let _parent = ParentEnv::set(&[
        ("ANTHROPIC_API_KEY", "sk-not-a-real-key-t9-sentinel"),
        ("OPENAI_API_KEY", "sk-not-a-real-key-t9-sentinel"),
        ("DAILY_BRIEFING_STATE_DIR", "/nowhere/sentinel/state"),
        ("PATH", sentinel_path),
    ]);
    // prove-it 3b: the parent really carries them, or the leak check below measures nothing.
    for key in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "DAILY_BRIEFING_STATE_DIR",
    ] {
        assert!(
            std::env::var_os(key).is_some(),
            "{key} was not set in the parent; the assertion below would be vacuous"
        );
    }
    assert_eq!(std::env::var("PATH").as_deref(), Ok(sentinel_path));

    let client = EngineClient::with_program(env_dumper(&scratch.path, "env.sh"));
    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs");
    let child = parse_env(&out.stdout);

    for key in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "DAILY_BRIEFING_STATE_DIR",
    ] {
        assert!(
            !child.contains_key(key),
            "{key} reached the sidecar from the app's environment. Full child environment: \
             {child:#?}"
        );
    }
    let home = std::env::var("HOME").expect("a HOME in the test environment");
    assert_eq!(
        child.get("PATH").map(String::as_str),
        Some(launchd_path(Path::new(&home)).as_str()),
        "the child's PATH is not the launchd one while the parent's was {sentinel_path:?}"
    );
    assert_ne!(
        child.get("PATH").map(String::as_str),
        Some(sentinel_path),
        "the parent's PATH was forwarded"
    );
}

/// `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` in the APP's environment reach the sidecar on
/// Linux, and nowhere else.
///
/// On Linux the engine runs `systemctl --user` for the schedule with its own environment, and that
/// needs one of these to find the user's service manager — without them the app's scheduler install
/// fails at `daemon-reload`. On macOS the app's environment must stay exactly what it was, so there
/// the same two names, set in the parent, must NOT arrive. Both arms are asserted against the same
/// sentinel values; which arm runs depends on the host (the Linux one in CI's `ubuntu-22.04` job).
///
/// ⚠ THE SENTINELS ARE NOT REAL PATHS, and the dumper never dials either: it only prints its
/// environment.
#[tokio::test(flavor = "multi_thread")]
async fn the_session_bus_variables_reach_the_child_on_linux_only() {
    let scratch = ScratchDir::new("busvars");
    let runtime_dir = "/nowhere/sentinel/run-user";
    let bus = "unix:path=/nowhere/sentinel/run-user/bus";
    let _parent = ParentEnv::set(&[
        ("XDG_RUNTIME_DIR", runtime_dir),
        ("DBUS_SESSION_BUS_ADDRESS", bus),
    ]);
    // prove-it 3b: the parent really carries them, or the "not forwarded" arm measures nothing.
    assert_eq!(std::env::var("XDG_RUNTIME_DIR").as_deref(), Ok(runtime_dir));
    assert_eq!(
        std::env::var("DBUS_SESSION_BUS_ADDRESS").as_deref(),
        Ok(bus)
    );

    let client = EngineClient::with_program(env_dumper(&scratch.path, "env.sh"));
    let out = client
        .invoke(Operation::Status, &NoProgress)
        .await
        .expect("the env dumper runs");
    let child = parse_env(&out.stdout);

    if cfg!(target_os = "linux") {
        assert_eq!(
            child.get("XDG_RUNTIME_DIR").map(String::as_str),
            Some(runtime_dir),
            "XDG_RUNTIME_DIR was not forwarded on Linux. Full child environment: {child:#?}"
        );
        assert_eq!(
            child.get("DBUS_SESSION_BUS_ADDRESS").map(String::as_str),
            Some(bus),
            "DBUS_SESSION_BUS_ADDRESS was not forwarded on Linux. Full child environment: \
             {child:#?}"
        );
    } else {
        for key in ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] {
            assert!(
                !child.contains_key(key),
                "{key} reached the sidecar off Linux — the macOS app's environment must not \
                 change. Full child environment: {child:#?}"
            );
        }
    }
}
