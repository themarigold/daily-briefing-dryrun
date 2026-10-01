//! T9 — the PARENT-ENVIRONMENT half of `engine_env.rs`, in a process of its own.
//!
//! ⚠ **WHY A SECOND BINARY RATHER THAN A SERIALISER.** The test below is the only one in the suite
//! that calls `std::env::set_var` / `remove_var`. That is process-wide, and `cargo test` runs a
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
//! Two tests live here: the behavioural one that does the mutating, and the `FORWARDED_ENV`
//! literal pin it is the other half of — kept beside it because each is the other's explanation,
//! and because it touches no environment at all and so cannot race the one that does.

mod common;

use std::path::Path;

use common::{env_dumper, parse_env, ScratchDir};
use daily_briefing_gui_lib::engine::{
    launchd_path, EngineClient, NoProgress, Operation, FORWARDED_ENV,
};

/// The forwarded set is THESE SEVEN, by literal — not "whatever the constant says".
///
/// ⚠ `engine_env.rs`'s `the_environment_is_otherwise_minimal` derives its allowed set FROM
/// `FORWARDED_ENV`, so it
/// cannot object to the constant growing: MEASURED, adding `ANTHROPIC_API_KEY` to the constant
/// and setting it in the parent left that test green. This is the pin that constant needs, and
/// `secrets_and_overrides_in_the_parent_never_reach_the_child` is the behavioural half.
#[test]
fn the_forwarded_set_is_exactly_these_seven() {
    assert_eq!(
        FORWARDED_ENV,
        &["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ"],
        "engine::FORWARDED_ENV changed. Every name here is something a launchd-started process \
         also gets from the session; a secret or an engine override does not belong in this list, \
         whatever the reason — pass it through `with_env` from a caller that knows what it is \
         doing, and say why here."
    );
}

/// A variable set in the parent, one per class the forward list must never carry, RAII-restored.
struct ParentEnv {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl ParentEnv {
    fn set(vars: &[(&'static str, &str)]) -> Self {
        let saved = vars
            .iter()
            .map(|(k, v)| {
                let prior = std::env::var_os(k);
                std::env::set_var(k, v);
                (*k, prior)
            })
            .collect();
        Self { saved }
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
