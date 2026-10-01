//! B8 (dev 63) — the CLI-shim Settings action, driven through REAL IPC on a MockRuntime app built
//! from the shipped handler, against a fake engine and — deliberately — the REAL [`SystemShim`]
//! sink, pointed at a SCRATCH directory.
//!
//! ⚠ NOTHING HERE TOUCHES `/usr/local/bin`. Every `CliShimState` in this file carries
//! `with_dir(<scratch>/bin)`, so the real symlink/rename/remove code runs inside the sandbox; the
//! one leg that remains UNRUN is the same code against the real root-owned directory, which is
//! VM-gated (`docs/gui-seam.md` §13). The fake engine reports a `binPath` inside the scratch state
//! directory, so the "ours" classification is exercised against real paths that exist nowhere but
//! the sandbox.

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{fake_sidecar, ScratchDir};
use daily_briefing_gui_lib::cli_shim::{
    classify, CliShimState, Inspect, ShimSink, ShimState, SystemShim, SHIM_NAME,
};
use daily_briefing_gui_lib::config_save::ConfigSaver;
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use daily_briefing_gui_lib::shell::{EngineSnapshots, ShellState};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

/* ── the pure classification ──────────────────────────────────────────────────────────────────── */

#[test]
fn the_ownership_rule_is_target_equality_or_the_state_directory() {
    let bin = PathBuf::from("/state/daily-briefing");
    let state = PathBuf::from("/state");

    assert_eq!(
        classify(&Inspect::Missing, Some(&bin), Some(&state)),
        ShimState::Absent
    );
    assert_eq!(
        classify(&Inspect::Symlink(bin.clone()), Some(&bin), Some(&state)),
        ShimState::Current
    );
    // A link into the state dir that is not the current binPath: OURS, but stale.
    assert_eq!(
        classify(
            &Inspect::Symlink(PathBuf::from("/state/old-name")),
            Some(&bin),
            Some(&state)
        ),
        ShimState::Stale {
            points_to: "/state/old-name".into()
        }
    );
    // With no binPath (nothing installed), the state dir alone still identifies ours.
    assert_eq!(
        classify(&Inspect::Symlink(bin.clone()), None, Some(&state)),
        ShimState::Stale {
            points_to: "/state/daily-briefing".into()
        }
    );
    // A link anywhere else, or a non-link, is FOREIGN — whoever made it.
    assert!(matches!(
        classify(
            &Inspect::Symlink(PathBuf::from("/opt/homebrew/bin/other")),
            Some(&bin),
            Some(&state)
        ),
        ShimState::Foreign { .. }
    ));
    assert!(matches!(
        classify(&Inspect::Other("a regular file"), Some(&bin), Some(&state)),
        ShimState::Foreign { .. }
    ));
    // With NOTHING known from the engine, no symlink can be judged ours.
    assert!(matches!(
        classify(&Inspect::Symlink(bin.clone()), None, None),
        ShimState::Foreign { .. }
    ));

    // Round 1 (lens 2's surviving widenings): the ownership rule is parent EQUALITY —
    // a nested path UNDER the state dir is foreign (kills the `starts_with` widening)…
    assert!(matches!(
        classify(
            &Inspect::Symlink(PathBuf::from("/state/nested/daily-briefing")),
            Some(&bin),
            Some(&state)
        ),
        ShimState::Foreign { .. }
    ));
    // …and so is a link into a directory ELSEWHERE that happens to be NAMED like the state dir
    // (kills the last-component-match widening; the real state dir's basename is exactly the
    // name a stranger's tree can also carry).
    let real_state = PathBuf::from("/Users/x/Library/Application Support/daily-briefing");
    assert!(matches!(
        classify(
            &Inspect::Symlink(PathBuf::from("/opt/daily-briefing/daily-briefing")),
            None,
            Some(&real_state)
        ),
        ShimState::Foreign { .. }
    ));
    // Round 1's degenerate shape: a state dir that IS the filesystem root owns nothing — every
    // top-level path is a child of `/`, so parent equality alone would call `/bin` ours.
    assert!(matches!(
        classify(
            &Inspect::Symlink(PathBuf::from("/bin")),
            None,
            Some(Path::new("/"))
        ),
        ShimState::Foreign { .. }
    ));
}

/* ── the real sink, in a scratch directory ────────────────────────────────────────────────────── */

#[cfg(unix)]
#[test]
fn the_system_sink_is_exclusive_on_create_and_atomic_on_replace() {
    let scratch = ScratchDir::new("shim-sink");
    let dir = scratch.join("bin");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(SHIM_NAME);
    let target = scratch.join("state").join("daily-briefing");

    assert_eq!(SystemShim.inspect(&path).unwrap(), Inspect::Missing);
    SystemShim.create(&path, &target).expect("create");
    assert_eq!(
        SystemShim.inspect(&path).unwrap(),
        Inspect::Symlink(target.clone())
    );

    // Exclusive: a second create fails rather than replacing what appeared.
    let err = SystemShim
        .create(&path, &target)
        .expect_err("the name is taken");
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);

    // Replace: lands on the new target, leaves no temp file behind.
    let newer = scratch.join("state").join("daily-briefing-2");
    SystemShim.replace(&path, &newer).expect("replace");
    assert_eq!(SystemShim.inspect(&path).unwrap(), Inspect::Symlink(newer));
    let names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![SHIM_NAME.to_string()], "no temp names remain");

    SystemShim.remove(&path).expect("remove");
    assert_eq!(SystemShim.inspect(&path).unwrap(), Inspect::Missing);

    // A regular file inspects as Other — the classification the foreign refusal rests on.
    std::fs::write(&path, "#!/bin/sh\n").unwrap();
    assert_eq!(
        SystemShim.inspect(&path).unwrap(),
        Inspect::Other("a regular file")
    );
}

/* ── the commands, through IPC ────────────────────────────────────────────────────────────────── */

struct Harness {
    app: App<MockRuntime>,
    /// The scratch stand-in for `/usr/local/bin`.
    bin_dir: PathBuf,
    /// The scratch state dir the fake engine reports; `binPath` is `<state_dir>/daily-briefing`.
    engine_copy: PathBuf,
    _scratch: ScratchDir,
}

/// A fake engine answering `schedule status --json` with a `binPath` inside the scratch state
/// directory (or without one), and `status --json` with `paths.stateDir` beside it.
fn harness(with_bin_path: bool, shim_dir: Option<&Path>) -> Harness {
    harness_with_sink(with_bin_path, shim_dir, None)
}

fn harness_with_sink(
    with_bin_path: bool,
    shim_dir: Option<&Path>,
    sink: Option<Arc<dyn ShimSink>>,
) -> Harness {
    let scratch = ScratchDir::new("shim-ipc");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let engine_copy = state.join("daily-briefing");
    std::fs::write(&engine_copy, "engine bytes").unwrap();
    let bin_dir = shim_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| scratch.join("bin"));
    std::fs::create_dir_all(&bin_dir).ok();

    let state_shown = state.display();
    let bin_line = if with_bin_path {
        format!(r#"\"binPath\":\"{}\","#, engine_copy.display())
    } else {
        String::new()
    };
    let body = format!(
        r#"case "$1:$2" in
  status:--json)
    printf '%s' "{{\"schemaVersion\":1,\"paths\":{{\"stateDir\":\"{state_shown}\",\"configPath\":\"{state_shown}/config.json\"}}}}"
    ;;
  schedule:status)
    printf '%s' "{{\"schemaVersion\":1,{bin_line}\"recordPresent\":true}}"
    ;;
esac
exit 0"#
    );
    let program = fake_sidecar(&scratch.path, "engine.sh", &body);
    let engine = Engine(Ok(EngineClient::with_program(program)));
    let snapshots = Arc::new(EngineSnapshots::new(engine.0.clone()));
    let app = mock_builder()
        .manage(engine)
        .manage(snapshots)
        .manage(ShellState::default())
        .manage(ConfigSaver::with_candidate_dir(
            scratch.join("candidates-unused"),
        ))
        // The REAL sink, pointed at scratch — the whole point of this file (module header) —
        // unless the test injects its own (still over scratch).
        .manage(match sink {
            Some(sink) => CliShimState::default().with_dir(&bin_dir).with_sink(sink),
            None => CliShimState::default().with_dir(&bin_dir),
        })
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(tauri::generate_context!())
        .expect("mock app");
    Harness {
        app,
        bin_dir,
        engine_copy,
        _scratch: scratch,
    }
}

fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("main webview")
}

fn call(w: &WebviewWindow<MockRuntime>, cmd: &str) -> Result<Value, String> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: InvokeBody::Json(json!({})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    match get_ipc_response(w, request) {
        Ok(body) => Ok(deserialize(body)),
        Err(e) => Err(e
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| e.to_string())),
    }
}

fn deserialize(body: InvokeResponseBody) -> Value {
    body.deserialize().expect("a JSON response")
}

#[cfg(unix)]
#[test]
fn install_status_and_remove_round_trip_against_the_real_sink() {
    let h = harness(true, None);
    let w = main_webview(&h.app);
    let shim = h.bin_dir.join(SHIM_NAME);

    // Absent, with the target named for display.
    let status = call(&w, "cli_shim_status").expect("status");
    assert_eq!(status["supported"], true, "{status}");
    assert_eq!(status["state"], "absent", "{status}");
    assert_eq!(
        status["target"].as_str().unwrap(),
        h.engine_copy.display().to_string(),
        "{status}"
    );
    assert_eq!(
        status["shimPath"].as_str().unwrap(),
        shim.display().to_string(),
        "{status}"
    );

    // Install: a real symlink appears, pointing at the managed copy; the answer says current.
    let installed = call(&w, "cli_shim_install").expect("install");
    assert_eq!(installed["state"], "current", "{installed}");
    assert_eq!(std::fs::read_link(&shim).unwrap(), h.engine_copy);

    // Idempotent: installing again changes nothing and does not error.
    let again = call(&w, "cli_shim_install").expect("install twice");
    assert_eq!(again["state"], "current", "{again}");
    assert_eq!(std::fs::read_link(&shim).unwrap(), h.engine_copy);

    // Remove: the symlink is gone; removing again is a no-op.
    let removed = call(&w, "cli_shim_remove").expect("remove");
    assert_eq!(removed["state"], "absent", "{removed}");
    assert!(
        std::fs::symlink_metadata(&shim).is_err(),
        "the link is gone"
    );
    let again = call(&w, "cli_shim_remove").expect("remove twice");
    assert_eq!(again["state"], "absent", "{again}");
}

#[cfg(unix)]
#[test]
fn a_stale_link_of_ours_is_repaired_and_a_foreign_one_is_refused() {
    let h = harness(true, None);
    let w = main_webview(&h.app);
    let shim = h.bin_dir.join(SHIM_NAME);

    // A link into the state dir under another name: OURS, stale — install repairs it in place.
    let old = h.engine_copy.with_file_name("old-engine-name");
    std::os::unix::fs::symlink(&old, &shim).unwrap();
    let status = call(&w, "cli_shim_status").expect("status");
    assert_eq!(status["state"], "stale", "{status}");
    assert_eq!(
        status["pointsTo"].as_str().unwrap(),
        old.display().to_string(),
        "{status}"
    );
    let repaired = call(&w, "cli_shim_install").expect("repair");
    assert_eq!(repaired["state"], "current", "{repaired}");
    assert_eq!(std::fs::read_link(&shim).unwrap(), h.engine_copy);
    std::fs::remove_file(&shim).unwrap();

    // A symlink into ANOTHER tree: foreign — refused by install AND by remove, and untouched.
    let elsewhere = h.bin_dir.join("someone-elses-tool");
    std::fs::write(&elsewhere, "not ours").unwrap();
    std::os::unix::fs::symlink(&elsewhere, &shim).unwrap();
    let err = call(&w, "cli_shim_install").expect_err("a foreign symlink");
    assert!(err.contains("foreign"), "{err}");
    let err = call(&w, "cli_shim_remove").expect_err("a foreign symlink");
    assert!(err.contains("foreign"), "{err}");
    assert_eq!(std::fs::read_link(&shim).unwrap(), elsewhere, "untouched");
    std::fs::remove_file(&shim).unwrap();

    // A REGULAR FILE at the name: foreign — refused, byte-untouched.
    std::fs::write(&shim, "#!/bin/sh\necho real tool\n").unwrap();
    let err = call(&w, "cli_shim_install").expect_err("a regular file");
    assert!(
        err.contains("foreign") && err.contains("regular file"),
        "{err}"
    );
    let err = call(&w, "cli_shim_remove").expect_err("a regular file");
    assert!(err.contains("foreign"), "{err}");
    assert_eq!(
        std::fs::read_to_string(&shim).unwrap(),
        "#!/bin/sh\necho real tool\n"
    );
}

#[cfg(unix)]
#[test]
fn a_missing_managed_copy_refuses_and_a_missing_directory_names_the_manual_command() {
    // No binPath from the engine: install refuses toward the scheduler, and touches nothing.
    let h = harness(false, None);
    let w = main_webview(&h.app);
    let err = call(&w, "cli_shim_install").expect_err("no managed copy");
    assert!(err.contains("noManagedEngine"), "{err}");
    let status = call(&w, "cli_shim_status").expect("status");
    assert_eq!(status["target"], Value::Null, "{status}");

    // A shim directory that does not exist (a Mac without /usr/local/bin): the refusal carries
    // the EXACT manual command — the app never escalates.
    let scratch = ScratchDir::new("shim-nodir");
    let missing = scratch.join("no-such-dir").join("bin");
    let h = harness(true, Some(&missing));
    // `create_dir_all` in the harness made it; remove it again to simulate the missing dir.
    std::fs::remove_dir_all(scratch.join("no-such-dir")).ok();
    std::fs::remove_dir_all(&missing).ok();
    let w = main_webview(&h.app);
    let err = call(&w, "cli_shim_install").expect_err("no directory to write into");
    assert!(err.contains("needsManualStep"), "{err}");
    assert!(
        err.contains(&format!("sudo ln -sfn '{}'", h.engine_copy.display())),
        "the manual command names the real target, shell-quoted (round 1): {err}"
    );
}

/* ── round 1: the manual sudo lines are shell-safe ────────────────────────────────────────────── */

/// F2: the REAL `binPath` shape contains a SPACE (`~/Library/Application Support/…`), so an
/// unquoted manual line broke on every stock install. The pin round-trips the emitted line
/// through `sh`'s own word-splitting (`set --` assigns, executes nothing) and demands exactly
/// the intended words back — operands intact, 5 for install, 3 for remove.
#[cfg(unix)]
#[test]
fn the_manual_sudo_lines_survive_sh_word_splitting_with_a_spaced_path() {
    use daily_briefing_gui_lib::cli_shim::{manual_install_command, manual_remove_command};
    let bin = Path::new("/Users/x/Library/Application Support/daily-briefing/daily-briefing");
    let shim = Path::new("/usr/local/bin/daily-briefing");
    let words = |line: &str| -> Vec<String> {
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "set -- {line}; for w; do printf '%s\\n' \"$w\"; done"
            ))
            .output()
            .expect("sh runs");
        assert!(out.status.success(), "sh refused the line: {line}");
        String::from_utf8(out.stdout)
            .expect("utf8")
            .lines()
            .map(str::to_string)
            .collect()
    };

    let install = words(&manual_install_command(bin, shim));
    assert_eq!(
        install,
        vec![
            "sudo".to_string(),
            "ln".into(),
            "-sfn".into(),
            bin.display().to_string(),
            shim.display().to_string(),
        ],
        "5 words, the spaced operand whole"
    );

    let remove = words(&manual_remove_command(shim));
    assert_eq!(
        remove,
        vec!["sudo".to_string(), "rm".into(), shim.display().to_string()],
        "3 words"
    );

    // And a quote INSIDE a path cannot break out of the quoting.
    let hostile = Path::new("/tmp/it's a dir/daily-briefing");
    let quoted = words(&manual_remove_command(hostile));
    assert_eq!(
        quoted,
        vec![
            "sudo".to_string(),
            "rm".into(),
            hostile.display().to_string()
        ]
    );
}

/// F5(b): the Absent arm must CREATE (exclusive), never replace — pinned by a sink whose INSPECT
/// is stale (always `Missing`) while its writes are the real ones. Whatever appeared after the
/// inspect must survive: the exclusive symlink call answers `EEXIST` instead of clobbering.
/// (The STALE arm's temp+rename replace is inherently clobbering inside its own bounded window —
/// recorded, not fixed: `docs/gui-seam.md` §13f deviation 137.)
#[cfg(unix)]
#[test]
fn a_file_that_appears_between_inspect_and_install_is_never_clobbered() {
    struct StaleInspectSink;
    impl ShimSink for StaleInspectSink {
        fn inspect(&self, _path: &Path) -> std::io::Result<Inspect> {
            Ok(Inspect::Missing)
        }
        fn create(&self, path: &Path, target: &Path) -> std::io::Result<()> {
            SystemShim.create(path, target)
        }
        fn replace(&self, path: &Path, target: &Path) -> std::io::Result<()> {
            SystemShim.replace(path, target)
        }
        fn remove(&self, path: &Path) -> std::io::Result<()> {
            SystemShim.remove(path)
        }
    }

    let h = harness_with_sink(true, None, Some(Arc::new(StaleInspectSink)));
    let w = main_webview(&h.app);
    let shim = h.bin_dir.join(SHIM_NAME);
    // The racing file: it landed after the (stale) inspect said Missing.
    std::fs::write(&shim, "#!/bin/sh\nsomebody else's tool\n").unwrap();

    let err = call(&w, "cli_shim_install").expect_err("the name is taken");
    assert!(
        err.contains("sink"),
        "EEXIST surfaces, nothing rewrites: {err}"
    );
    assert_eq!(
        std::fs::read_to_string(&shim).unwrap(),
        "#!/bin/sh\nsomebody else's tool\n",
        "the raced file's bytes are exactly as they were"
    );
}

/* ── round 1: the sandbox discipline, mechanically ────────────────────────────────────────────── */

/// F8: the TRUE property is "no test points a real sink at the real directory" — previously a
/// convention, now a source scan (the EXPECTED_GRANTS derived-vs-literal doctrine applied to
/// test hygiene):
/// 1. every `CliShimState::default()` STATEMENT in `tests/` carries `.with_dir(`/`.with_sink(`
///    before its `;` — a managed default is the one shape IPC can reach, and un-overridden it is
///    the real `SystemShim` over the real `/usr/local/bin`;
/// 2. in `src/`, the un-overridden construction appears exactly once — `lib.rs`;
/// 3. a direct `SystemShim.` method call (explicit scratch paths, no IPC reach) appears only in
///    THIS file, whose module header owns that discipline.
#[test]
fn no_test_wires_the_real_sink_at_the_real_directory() {
    // Built by concatenation so this test's own source does not match its own needles.
    let default_needle = ["CliShimState::default", "()"].concat();
    let direct_needle = ["System", "Shim."].concat();

    let rust_files = |dir: &Path| -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).expect("dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(
                    std::fs::read_dir(&path)
                        .expect("subdir")
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| p.extension().is_some_and(|e| e == "rs")),
                );
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
        out
    };

    let tests_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    for path in rust_files(&tests_dir) {
        let source = std::fs::read_to_string(&path).expect("test source");
        let mut from = 0;
        while let Some(at) = source[from..].find(&default_needle) {
            let start = from + at;
            let statement = &source[start
                ..source[start..]
                    .find(';')
                    .map_or(source.len(), |i| start + i)];
            assert!(
                statement.contains(".with_dir(") || statement.contains(".with_sink("),
                "{}: a default-constructed shim state without with_dir/with_sink in its statement:\n{statement}",
                path.display()
            );
            from = start + default_needle.len();
        }
        if source.contains(&direct_needle) {
            assert!(
                path.file_name().is_some_and(|n| n == "cli_shim.rs"),
                "{}: a direct SystemShim method call outside the sink's own unit-test file",
                path.display()
            );
        }
    }

    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bare_defaults = Vec::new();
    for path in rust_files(&src_dir) {
        let source = std::fs::read_to_string(&path).expect("crate source");
        let count = source.matches(&default_needle).count();
        if count > 0 {
            bare_defaults.push((
                path.file_name().unwrap().to_string_lossy().into_owned(),
                count,
            ));
        }
    }
    assert_eq!(
        bare_defaults,
        vec![("lib.rs".to_string(), 1)],
        "the real-directory default may be constructed exactly once, in lib.rs"
    );
}
