//! The SPK-1(b) probe: the argv gate, the errno classification, and the JSON shape.
//!
//! **The whole file is `cfg`'d on the `tcc-probe` feature**, because the module it tests is: with
//! the feature off there is no `probe` module to import and nothing here would compile. That is
//! not a coverage hole — the thing that must hold in a DEFAULT build is "the probe is absent", and
//! `tests/probe_feature_gate.rs` asserts exactly that against the built binary, plus (in a test
//! that is not itself `cfg`'d) against the manifest that decides which build is the default one.
//!
//! Twenty-two tests, of three kinds, and the split matters because only one kind proves anything
//! about macOS TCC. The counts below are 6 + 9 + 7; they read "six / ten / six" until review, which
//! summed to the right total by two errors that cancelled.
//!
//!   • THE GATE (six). Pure `parse_mode` assertions. These are the ones that protect an ordinary
//!     launch: the probe must be unreachable unless `--tcc-probe` is argv[1], because a second
//!     path into the binary that could skip `run()` is the one way this module could break the
//!     app it lives in.
//!   • THE CLASSIFIER (nine). `EPERM`/`EACCES`/`ENOENT`/`ENOTDIR` are spelled as literals in
//!     `probe.rs` (no `libc` dependency), so `errno_constants_are_what_this_os_reports` pins
//!     **`probe.rs`'s own bindings** — not a second copy of the numbers — against
//!     `std::io::Error::from_raw_os_error`. It also covers the child classifier's tail anchoring,
//!     the per-entry drain, and the `childStderr` cap, each of which is a documented promise that
//!     a mutation once broke while the suite stayed green.
//!   • END TO END (seven). Real directories under the OS temp dir. `a_chmod_000_directory_is_
//!     denied_on_both_legs` is the only test that exercises the *denied* path with a genuine
//!     kernel errno — TCC is not reachable from a test, but `EACCES` from an unreadable directory
//!     travels the identical code path, so the classifier is exercised rather than merely mocked.
//!
//! ⚠ WHAT NONE OF THESE TESTS SHOW. Not one of them touches TCC, a protected directory, or a
//! bundle. They establish that the instrument reports what the kernel told it; they cannot
//! establish what macOS tells a *bundled, signed* `.app` about `~/Documents`. That is the whole of
//! SPK-1(b), it is VM-only per plan §6, and every leg of it is UNRUN — see
//! `docs/spikes/spk-1b-app-principal.md`.
#![cfg(feature = "tcc-probe")]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use daily_briefing_gui_lib::probe::{
    cap_child_stderr, classify_child_output, classify_io_error, dispatch, parse_mode, run_probe,
    verdict_from_entries, Mode, BUNDLE_ID, CHILD_STDERR_CAP, EACCES, ENOENT, ENOTDIR, EPERM,
    PROBE_FLAG,
};

fn argv(parts: &[&str]) -> Vec<OsString> {
    parts.iter().map(OsString::from).collect()
}

/// A fresh directory under the OS temp dir that removes itself on EVERY exit path.
///
/// Same naming shape as `common::ScratchDir` and as B1's `capability_allowlist.rs` `sandbox()`
/// before it (T8 renamed that file to `capability.rs` and rewrote it) — process id plus nanos —
/// but per-call rather than per-process, because several of these tests need a directory nobody
/// else is holding open or chmod-ing.
///
/// ⚠ The `Drop` is the point, and it is a fix rather than a flourish. Cleanup used to be a bare
/// `std::fs::remove_dir_all(&dir).ok()` written AFTER the assertions, so it ran only when the test
/// passed: a failing assertion leaked its directory, and
/// `a_chmod_000_directory_is_denied_on_both_legs` leaked one containing a subdirectory at mode
/// `d---------`, which `rm -rf` cannot remove without a `chmod` first. MEASURED: five such
/// directories were left in `$TMPDIR` by one session. A panicking assertion still unwinds through
/// `Drop`, so the cleanup now runs on the failing path too — which is the path that leaks.
struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("a clock after 1970")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "daily-briefing-tcc-probe-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("scratch dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        restore_modes(&self.path);
        std::fs::remove_dir_all(&self.path).ok();
    }
}

/// Make every directory under `path` openable again before anything tries to empty it.
///
/// `remove_dir_all` has to READ a directory to delete its contents, so a mode-000 directory defeats
/// it — the chmod has to come first, and it has to come first at each level on the way down, which
/// is why this recurses after the `set_permissions` rather than before it. Symlinks are not
/// followed: `file_type()` reports a symlink as a symlink, so only real directories are descended.
#[cfg(unix)]
fn restore_modes(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).ok();
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            restore_modes(&entry.path());
        }
    }
}

#[cfg(not(unix))]
fn restore_modes(_path: &Path) {}

// ── THE GATE ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_bare_launch_is_an_ordinary_launch() {
    assert_eq!(
        parse_mode(argv(&["/Applications/X.app/Contents/MacOS/x"])),
        Mode::Normal
    );
}

#[test]
fn an_empty_argv_is_an_ordinary_launch() {
    // Not reachable from a shell, but `env::args_os()` is not contractually non-empty and a panic
    // here would be a crash on launch.
    assert_eq!(parse_mode(Vec::<OsString>::new()), Mode::Normal);
}

#[test]
fn an_unrelated_first_argument_is_an_ordinary_launch() {
    // macOS has historically handed a launched app a `-psn_0_…` argument. Whatever arrives, only
    // the one flag diverts.
    for first in [
        "-psn_0_123456",
        "--help",
        "--tcc-probe-but-not-really",
        "open",
    ] {
        assert_eq!(
            parse_mode(argv(&["exe", first, "/tmp"])),
            Mode::Normal,
            "first={first}"
        );
    }
}

#[test]
fn the_flag_in_second_position_is_not_the_probe() {
    // The gate is positional on purpose (SPK-1(b): "no probe unless the flag is the first
    // argument"). This is the test that would fail if someone relaxed it to a scan of argv.
    assert_eq!(
        parse_mode(argv(&["exe", "--something", PROBE_FLAG, "/tmp"])),
        Mode::Normal
    );
}

#[test]
fn the_flag_first_with_one_operand_selects_the_probe() {
    assert_eq!(
        parse_mode(argv(&["exe", PROBE_FLAG, "/tmp/somewhere"])),
        Mode::Probe(PathBuf::from("/tmp/somewhere"))
    );
}

#[test]
fn the_flag_with_the_wrong_operand_count_is_a_usage_error() {
    for bad in [vec!["exe", PROBE_FLAG], vec!["exe", PROBE_FLAG, "/a", "/b"]] {
        match parse_mode(argv(&bad)) {
            Mode::Usage(message) => assert!(
                message.contains("exactly one directory operand"),
                "unhelpful usage message: {message}"
            ),
            other => panic!("{bad:?} should be a usage error, got {other:?}"),
        }
    }
    // …and `main` must turn that into a non-zero exit rather than a silent launch.
    assert_eq!(dispatch(argv(&["exe", PROBE_FLAG])), Some(2));
    assert_eq!(dispatch(argv(&["exe"])), None);
}

// ── THE CLASSIFIER ──────────────────────────────────────────────────────────────────────────────

#[test]
fn errno_constants_are_what_this_os_reports() {
    use std::io::ErrorKind;
    // ⚠ This test asserts against `probe.rs`'s OWN constants, and that is the whole point of it.
    // The earlier version passed the literals `1`/`13`/`2` to `from_raw_os_error`, which asserts
    // something true about macOS and nothing whatever about this crate: a mutation renumbering
    // `EPERM` to 99 in `probe.rs` left it green, because the test never read `probe.rs`.
    assert_eq!(
        std::io::Error::from_raw_os_error(EPERM).kind(),
        ErrorKind::PermissionDenied,
        "probe.rs's EPERM ({EPERM}) is not a permission error on this platform"
    );
    assert_eq!(
        std::io::Error::from_raw_os_error(EACCES).kind(),
        ErrorKind::PermissionDenied,
        "probe.rs's EACCES ({EACCES}) is not a permission error on this platform"
    );
    assert_eq!(
        std::io::Error::from_raw_os_error(ENOENT).kind(),
        ErrorKind::NotFound,
        "probe.rs's ENOENT ({ENOENT}) is not the missing-file error on this platform"
    );
    assert_eq!(
        std::io::Error::from_raw_os_error(ENOTDIR).kind(),
        ErrorKind::NotADirectory,
        "probe.rs's ENOTDIR ({ENOTDIR}) is not the not-a-directory error on this platform"
    );
    // …and the POSIX numbers those names denote, so a renumbering is caught even on a platform
    // whose `ErrorKind` mapping happened to agree.
    assert_eq!(
        (EPERM, ENOENT, EACCES, ENOTDIR),
        (1, 2, 13, 20),
        "probe.rs's errno constants drifted off the POSIX numbers the classifier documents"
    );
}

#[test]
fn a_path_that_spells_a_diagnosis_is_not_read_as_one() {
    // MEASURED before the fix: a directory literally named `Permission denied` with a missing
    // child produced `child = "denied"` off the stderr
    // `ls: …/Permission denied/nope: No such file or directory` — the verdict was read from the
    // OPERAND. `ls`'s format is `ls: <operand>: <diagnosis>`, so only the segment after the final
    // `": "` may be matched.
    assert_eq!(
        classify_child_output(
            Some(1),
            "ls: /tmp/Permission denied/nope: No such file or directory"
        ),
        "error:ENOENT"
    );
    assert_eq!(
        classify_child_output(
            Some(1),
            "ls: /tmp/Operation not permitted/nope: No such file or directory"
        ),
        "error:ENOENT"
    );
    // The converse: a real denial under a path that spells something else still classifies.
    assert_eq!(
        classify_child_output(
            Some(1),
            "ls: /tmp/No such file or directory: Permission denied"
        ),
        "denied"
    );
    // And exit status wins over prose entirely — a successful listing of a directory whose NAME is
    // a diagnosis is `ok`, not a denial.
    assert_eq!(
        classify_child_output(Some(0), "ls: /tmp/Permission denied"),
        "ok"
    );
}

#[test]
fn an_unrecognised_diagnosis_falls_back_to_the_exit_code() {
    // The tail anchoring must not swallow messages it does not know: an unfamiliar `ls` wording
    // has to surface as `error:exit-N` rather than be silently classified.
    assert_eq!(
        classify_child_output(Some(1), "ls: /x: Some future message"),
        "error:exit-1"
    );
    assert_eq!(classify_child_output(Some(1), ""), "error:exit-1");
    // A line with no `": "` separator at all is matched whole rather than dropped.
    assert_eq!(
        classify_child_output(Some(1), "Permission denied"),
        "denied"
    );
}

#[test]
fn the_per_entry_drain_reports_the_first_entry_error() {
    // `probe.rs:probe_app_leg` documents the drain as load-bearing — a TCC-refused directory can
    // `opendir` and then fail per entry — but the mutation replacing it with a bare `"ok"` left
    // the pre-review suite entirely green, because `DirEntry` cannot be constructed in a test.
    // Over an iterator of `Result`s the contract is directly exercisable.
    let clean: Vec<Result<(), std::io::Error>> = vec![Ok(()), Ok(()), Ok(())];
    assert_eq!(verdict_from_entries(clean), "ok");

    let denied_midway: Vec<Result<(), std::io::Error>> = vec![
        Ok(()),
        Err(std::io::Error::from_raw_os_error(EACCES)),
        Ok(()),
    ];
    assert_eq!(
        verdict_from_entries(denied_midway),
        "denied",
        "an entry error after a successful opendir must not read as ok"
    );

    // First error wins, so the verdict cannot be overwritten by a later, less specific one.
    let two_errors: Vec<Result<(), std::io::Error>> = vec![
        Err(std::io::Error::from_raw_os_error(ENOENT)),
        Err(std::io::Error::from_raw_os_error(EACCES)),
    ];
    assert_eq!(verdict_from_entries(two_errors), "error:ENOENT");

    let empty: Vec<Result<(), std::io::Error>> = vec![];
    assert_eq!(verdict_from_entries(empty), "ok");
}

#[test]
fn child_stderr_is_trimmed_and_capped_in_chars() {
    // spk-1b §2 promises `childStderr` is "trimmed, ≤512 chars". The child is `/bin/ls`, which
    // cannot be made to emit 512 characters on demand, so removing the cap survived the suite.
    // The cap is a free function precisely so this test can exist.
    assert_eq!(cap_child_stderr("  ls: /x: denied \n"), "ls: /x: denied");

    let long = "e".repeat(CHILD_STDERR_CAP * 3);
    let capped = cap_child_stderr(&long);
    assert_eq!(capped.chars().count(), CHILD_STDERR_CAP);

    // CHARS, not bytes: a multi-byte path must never be cut mid-codepoint, and the cap must not be
    // silently a third of its stated size on a non-ASCII path.
    let multibyte = "é".repeat(CHILD_STDERR_CAP * 2);
    let capped = cap_child_stderr(&multibyte);
    assert_eq!(capped.chars().count(), CHILD_STDERR_CAP);
    assert_eq!(capped.len(), CHILD_STDERR_CAP * 2, "é is two bytes");

    // Short input is returned intact — the cap must not truncate what fits.
    assert_eq!(cap_child_stderr("short"), "short");
    assert_eq!(CHILD_STDERR_CAP, 512, "spk-1b §2 documents this number");
}

#[test]
fn eperm_and_eacces_are_the_denial_verdict() {
    // EPERM is what macOS returns for a TCC-refused `opendir`; EACCES is the ordinary mode-bit
    // denial. SPK-1(b) treats both as "the grant is not in force".
    assert_eq!(
        classify_io_error(&std::io::Error::from_raw_os_error(1)),
        "denied"
    );
    assert_eq!(
        classify_io_error(&std::io::Error::from_raw_os_error(13)),
        "denied"
    );
}

#[test]
fn a_missing_or_wrong_path_is_never_reported_as_a_denial() {
    // The failure this guards against: reading "the app cannot see ~/Documents" off a typo.
    assert_eq!(
        classify_io_error(&std::io::Error::from_raw_os_error(2)),
        "error:ENOENT"
    );
    assert_eq!(
        classify_io_error(&std::io::Error::from_raw_os_error(20)),
        "error:ENOTDIR"
    );
    assert_eq!(
        classify_io_error(&std::io::Error::from_raw_os_error(28)),
        "error:errno-28"
    );
    assert_eq!(
        classify_io_error(&std::io::Error::new(std::io::ErrorKind::TimedOut, "slow")),
        "error:TimedOut"
    );
}

#[test]
fn the_child_verdict_follows_ls_prose_not_its_exit_code() {
    // `ls` exits 1 for a denial and 1 for a missing path, so the exit code alone cannot separate
    // them — this is the stringly-typed seam `probe.rs` documents, pinned so a reworded match
    // fails here rather than in a VM transcript nobody can re-derive.
    assert_eq!(classify_child_output(Some(0), ""), "ok");
    assert_eq!(
        classify_child_output(Some(1), "ls: /x: Operation not permitted"),
        "denied"
    );
    assert_eq!(
        classify_child_output(Some(1), "ls: /x: Permission denied"),
        "denied"
    );
    assert_eq!(
        classify_child_output(Some(1), "ls: /x: No such file or directory"),
        "error:ENOENT"
    );
    assert_eq!(
        classify_child_output(Some(1), "ls: /x: Not a directory"),
        "error:ENOTDIR"
    );
    assert_eq!(
        classify_child_output(Some(2), "something new"),
        "error:exit-2"
    );
    assert_eq!(classify_child_output(None, ""), "error:signalled");
}

#[test]
fn the_bundle_id_constant_matches_tauri_conf_json() {
    // `probe.rs` reports the bundle id from a constant because the probe never builds a Tauri
    // context. This is what stops that constant drifting off the frozen identifier in plan R1.
    let conf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let parsed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&conf).expect("tauri.conf.json is readable"))
            .expect("tauri.conf.json is JSON");
    assert_eq!(parsed["identifier"].as_str(), Some(BUNDLE_ID));
    assert_eq!(
        BUNDLE_ID, "com.themarigold.daily-briefing",
        "plan R1 freezes this string"
    );
}

// ── END TO END ──────────────────────────────────────────────────────────────────────────────────

fn report_json(dir: &Path) -> serde_json::Value {
    serde_json::from_str(&run_probe(dir).to_json()).expect("the probe emits valid JSON")
}

#[test]
fn the_report_is_one_json_object_with_exactly_the_agreed_keys() {
    let dir = ScratchDir::new("keys");
    let value = report_json(dir.path());
    let object = value.as_object().expect("a JSON object");
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    // `childStderr` is the one addition to the shape SPK-1(b) named — see `ProbeReport::to_json`.
    assert_eq!(
        keys,
        vec![
            "app",
            "bundleId",
            "child",
            "childExit",
            "childStderr",
            "dir",
            "executable"
        ]
    );
    assert_eq!(object["bundleId"], serde_json::json!(BUNDLE_ID));
    assert_eq!(
        object["dir"],
        serde_json::json!(dir.path().to_string_lossy())
    );
    assert!(
        object["executable"].is_string(),
        "the probe must name the binary that ran it"
    );
}

#[test]
fn a_readable_scratch_directory_is_ok_on_both_legs() {
    let dir = ScratchDir::new("ok");
    std::fs::write(dir.join("a-file"), b"x").expect("a file to list");
    let value = report_json(dir.path());
    assert_eq!(value["app"], "ok");
    assert_eq!(value["child"], "ok", "stderr was: {}", value["childStderr"]);
    assert_eq!(value["childExit"], 0);
}

#[test]
fn a_missing_directory_is_enoent_on_both_legs() {
    // The negative control for the whole spike: if this ever came back "denied", every VM
    // transcript that reported a denial would be suspect.
    let dir = ScratchDir::new("gone");
    let missing = dir.join("no-such-child");
    let value = report_json(&missing);
    assert_eq!(value["app"], "error:ENOENT");
    assert_eq!(
        value["child"], "error:ENOENT",
        "stderr was: {}",
        value["childStderr"]
    );
}

#[test]
fn a_dash_leading_operand_is_an_operand_on_both_legs() {
    // MEASURED before the fix: `--tcc-probe -laR` reported `child: "ok"` while `app` said
    // `error:ENOENT` — `/bin/ls` had parsed the operand as FLAGS and listed the working directory,
    // so the child leg answered about a directory it was never pointed at. `--` is what makes the
    // two legs answer the same question; this is the test that fails if it is removed.
    let value = report_json(Path::new("-laR"));
    assert_eq!(value["app"], "error:ENOENT");
    assert_eq!(
        value["child"], "error:ENOENT",
        "the child leg took the operand as flags — stderr was: {}",
        value["childStderr"]
    );
}

#[test]
fn a_directory_named_like_a_denial_is_not_reported_as_one() {
    // The end-to-end half of `a_path_that_spells_a_diagnosis_is_not_read_as_one`: a real directory
    // on this filesystem, listed by the real `/bin/ls`, rather than a hand-written stderr string.
    let dir = ScratchDir::new("named-denial");
    let trap = dir.join("Permission denied");
    std::fs::create_dir(&trap).expect("the trap directory");

    let value = report_json(&trap);
    assert_eq!(value["app"], "ok");
    assert_eq!(value["child"], "ok", "stderr was: {}", value["childStderr"]);

    let missing = trap.join("no-such-child");
    let value = report_json(&missing);
    assert_eq!(value["app"], "error:ENOENT");
    assert_eq!(
        value["child"], "error:ENOENT",
        "the diagnosis was read off the path — stderr was: {}",
        value["childStderr"]
    );
}

#[cfg(unix)]
#[test]
fn a_chmod_000_directory_is_denied_on_both_legs() {
    use std::os::unix::fs::PermissionsExt;
    let dir = ScratchDir::new("denied");
    let locked = dir.join("locked");
    std::fs::create_dir(&locked).expect("the directory to lock");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).expect("chmod 000");

    // Guard rather than assume: root ignores mode bits, and a green suite under root would be a
    // classifier that was never exercised.
    let readable = std::fs::read_dir(&locked).is_ok();
    if !readable {
        let value = report_json(&locked);
        assert_eq!(value["app"], "denied");
        assert_eq!(
            value["child"], "denied",
            "stderr was: {}",
            value["childStderr"]
        );
    }

    // No chmod-back and no `remove_dir_all` here: `ScratchDir`'s `Drop` restores the mode bits on
    // the way down and then removes the tree, and it does so whether this test returns or panics.
    // The version that cleaned up inline left `locked` at `d---------` in `$TMPDIR` whenever the
    // assertions above failed — which is precisely when a human next needs the temp dir tidy.
    assert!(
        !readable,
        "chmod 000 was readable — running as root? the denial path went untested"
    );
}

#[test]
fn the_probe_exits_zero_and_an_ordinary_launch_is_not_diverted() {
    let dir = ScratchDir::new("dispatch");
    let flag = OsString::from(PROBE_FLAG);
    assert_eq!(
        dispatch(vec![
            OsString::from("exe"),
            flag,
            dir.path().to_path_buf().into_os_string()
        ]),
        Some(0)
    );
    assert_eq!(dispatch(vec![OsString::from("exe")]), None);
}
