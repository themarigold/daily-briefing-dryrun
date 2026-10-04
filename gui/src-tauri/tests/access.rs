//! T17 — the folder-access grant flow, from the pure classifiers up to the four commands driven
//! through real IPC.
//!
//! ## ⛔ THE SAFETY RULES THIS FILE IS BUILT AROUND
//!
//! Every one of them is a property of the fixtures, not a convention to remember:
//!
//!   * **No test reads a real protected folder.** `access::AccessState::with_home` points `HOME` at
//!     a scratch directory, so the four paths `access_probe` can reach are all under `$TMPDIR`. A
//!     read of the developer's own `~/Desktop` / `~/Documents` / `~/Downloads` /
//!     `~/Library/Mobile Documents` would raise a real macOS TCC prompt or consume a real grant on
//!     this machine — a side effect a test suite has no business having.
//!   * **No test opens anything.** `common::RecordingOpener` records the URL or path that was
//!     CHOSEN; the shipping sink (`tauri-plugin-opener`'s free functions) would launch System
//!     Settings and raise a Finder window.
//!   * **No test reaches the real engine.** The app's `Engine` state is a fake sidecar under the
//!     scratch directory, as in `tests/capability.rs`.
//!   * **⚠ THE DENIAL LEG IS `EACCES`, NOT TCC, AND THAT IS STATED RATHER THAN GLOSSED.** A
//!     `chmod 000` directory is an ORDINARY permission denial. The classifier folds `EPERM` and
//!     `EACCES` into one `Denied` verdict precisely because the errno is all it has, so the mode-bit
//!     leg exercises the same code path a TCC denial would — but it is NOT evidence about TCC, and
//!     every TCC leg in this build is VM-gated and UNRUN (`docs/spikes/spk-1b-app-principal.md`).

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

use common::{access_sidecar, RecordingOpener, ScratchDir};
use daily_briefing_gui_lib::access::{
    case_insensitive_for, classify_dir_error, is_under, probe_advice, protected_roots, read_record,
    scope_of, version_change, AccessRecord, AccessSnapshot, AccessState, DirAccess, ProbeAdvice,
    ProtectedRoot, SettingsPane, VersionChange, EACCES, ENOENT, ENOTDIR, EPERM,
    PROTECTED_ROOT_SEGMENTS, SETTINGS_FILES_AND_FOLDERS, SETTINGS_FULL_DISK_ACCESS,
    SETTINGS_PRIVACY_ROOT, STORE_FILE,
};
use daily_briefing_gui_lib::config_save::ConfigSaver;
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use daily_briefing_gui_lib::shell::{EngineSnapshots, ShellState};

/* ── the engine's own list, pinned ────────────────────────────────────────────────────────────── */

/// The engine module that defines the protected roots — relative to this crate.
const PROTECTED_PATH_TS: &str = "../../src/protectedPath.ts";

/// ⚠ THE APP'S IDEA OF "IN SCOPE" AND THE ENGINE'S IDEA OF "THIS EPERM IS A TCC DENIAL" MUST BE ONE
/// LIST. `src/protectedPath.ts`'s `defaultProtectedRoots` is what `classifyReadError` matches
/// against, so a root this app offers a grant for but the engine does not classify would be a step
/// that fixes nothing, and a root the engine classifies but this app does not list would be a
/// blocked repo with no step at all.
///
/// The parse reads the `join(home, …)` calls inside that function, in order.
#[test]
fn the_protected_roots_are_the_engines() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(PROTECTED_PATH_TS);
    let text = std::fs::read_to_string(&source).unwrap_or_else(|e| {
        panic!(
            "could not read the engine's protected-root list at {} ({e}). If it moved, this test \
             must follow it — the whole point is that the list has ONE definition.",
            source.display()
        )
    });
    const OPEN: &str = "export function defaultProtectedRoots";
    let start = text
        .find(OPEN)
        .unwrap_or_else(|| panic!("{PROTECTED_PATH_TS} no longer defines defaultProtectedRoots"));
    let body = &text[start..];
    let end = body
        .find("\n}")
        .unwrap_or_else(|| panic!("defaultProtectedRoots is not closed in {PROTECTED_PATH_TS}"));
    let body = &body[..end];

    let mut engine: Vec<Vec<String>> = Vec::new();
    for line in body.lines() {
        let Some(open) = line.find("join(home,") else {
            continue;
        };
        let rest = &line[open + "join(home,".len()..];
        let close = rest
            .find(')')
            .unwrap_or_else(|| panic!("an unterminated join() in {PROTECTED_PATH_TS}: {line}"));
        let segments: Vec<String> = rest[..close]
            .split(',')
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect();
        engine.push(segments);
    }
    // prove-it 3b: a parse that matched nothing would make the comparison below vacuous.
    assert!(
        !engine.is_empty(),
        "nothing was parsed out of defaultProtectedRoots. The PARSE — not the app — is what broke; \
         fix it rather than deleting the assertion it feeds. Body was: {body:?}"
    );

    let ours: Vec<Vec<String>> = PROTECTED_ROOT_SEGMENTS
        .iter()
        .map(|(_, segments)| segments.iter().map(|s| s.to_string()).collect())
        .collect();
    assert_eq!(
        ours, engine,
        "`access::PROTECTED_ROOT_SEGMENTS` and the engine's `defaultProtectedRoots` disagree. Both \
         the ORDER and the segments matter: the order decides which root a launch-time revocation \
         check reads first, and the segments decide what the panel offers a grant for."
    );

    // And every key resolves to the path the segments describe.
    let home = PathBuf::from("/Users/x");
    let by_key: BTreeMap<&str, PathBuf> = protected_roots(&home)
        .into_iter()
        .map(|(root, path)| (root.key(), path))
        .collect();
    assert_eq!(
        by_key,
        BTreeMap::from([
            ("desktop", PathBuf::from("/Users/x/Desktop")),
            ("documents", PathBuf::from("/Users/x/Documents")),
            ("downloads", PathBuf::from("/Users/x/Downloads")),
            ("icloud", PathBuf::from("/Users/x/Library/Mobile Documents")),
        ])
    );
    for root in ProtectedRoot::all() {
        assert_eq!(
            ProtectedRoot::from_key(root.key()),
            Some(root),
            "{} does not round-trip through its key",
            root.key()
        );
    }
    assert_eq!(
        ProtectedRoot::from_key("/etc"),
        None,
        "an unknown key must not resolve to a root at all — a fallback of `~/Desktop` would raise a \
         TCC prompt for a typo"
    );
}

/// The engine's `matchProtectedRoot`, including its case rule — separator-aware both ways.
#[test]
fn a_root_match_is_separator_aware_and_case_follows_the_platform() {
    assert!(is_under("/Users/x/Desktop", "/Users/x/Desktop", false));
    assert!(is_under("/Users/x/Desktop/proj", "/Users/x/Desktop", false));
    assert!(
        !is_under("/Users/x/Desktopfoo", "/Users/x/Desktop", false),
        "a prefix match without the separator would put an unrelated directory in scope — the \
         engine's own `matchProtectedRoot` is separator-aware for exactly this"
    );
    assert!(
        !is_under("/Users/x/desktop/proj", "/Users/x/Desktop", false),
        "case-SENSITIVE matching must not fold"
    );
    assert!(
        is_under("/Users/x/desktop/proj", "/Users/x/Desktop", true),
        "on a case-insensitive filesystem the engine classifies this EPERM as tcc-denied, so the \
         panel must call the same path in scope"
    );
    assert!(
        case_insensitive_for("macos") && case_insensitive_for("windows"),
        "the engine folds case on darwin and win32 (`classifyReadError`)"
    );
    assert!(!case_insensitive_for("linux"));
}

/* ── scope ────────────────────────────────────────────────────────────────────────────────────── */

fn doctor_with(repos: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "repos": repos,
        "reposTimedOut": false,
        "verdict": "blocked",
    })
}

/// ⚠ NEITHER SOURCE COVERS THE OTHER, and this is the test that says so. Doctor sees a repo reached
/// THROUGH a discovery root (the config names `~`, not `~/Documents`); the config sees a protected
/// discovery root that has not produced a repo yet (doctor lists nothing for an empty folder).
/// Dropping either source loses one of these rows.
#[test]
fn scope_comes_from_doctor_and_from_the_config_and_neither_alone_is_enough() {
    let home = PathBuf::from("/Users/x");

    let doctor_only = doctor_with(serde_json::json!([
        { "path": "/Users/x/Documents/proj", "ok": true, "issueKind": null, "advice": null },
    ]));
    let config_only = serde_json::json!({ "discoverRoots": ["/Users/x"] });
    let from_doctor = scope_of(&doctor_only, Some(&config_only), &[], &home, true);
    assert_eq!(
        from_doctor.iter().map(|r| r.key).collect::<Vec<_>>(),
        vec!["documents"],
        "a repo discovered under a protected root must put that root in scope even though the \
         CONFIG only names the home directory: {from_doctor:?}"
    );

    let empty_doctor = doctor_with(serde_json::json!([]));
    let config_root = serde_json::json!({ "discoverRoots": ["/Users/x/Desktop"] });
    let from_config = scope_of(&empty_doctor, Some(&config_root), &[], &home, true);
    assert_eq!(
        from_config.iter().map(|r| r.key).collect::<Vec<_>>(),
        vec!["desktop"],
        "a configured discovery root that IS a protected folder must be in scope even when doctor \
         lists nothing under it — that is the state a user is in while still setting up: \
         {from_config:?}"
    );

    // Nothing protected: no flow at all.
    let elsewhere = serde_json::json!({ "repos": ["/Users/x/code/proj"] });
    assert!(
        scope_of(&empty_doctor, Some(&elsewhere), &[], &home, true).is_empty(),
        "a config that reaches nothing protected must produce NO grant step (plan R1: grant \
         acquisition is CONDITIONAL)"
    );
    assert!(
        scope_of(&empty_doctor, None, &[], &home, true).is_empty(),
        "no config and no doctor rows is not a reason to ask for a grant"
    );
}

/// ⚠ THE ENGINE'S ADVICE, VERBATIM. `doctor --json`'s `advice` is `warnFor(issue)`
/// (`src/protectedPath.ts`), and the appendix requires it shown unmodified. Nothing in `scope_of`
/// rewrites, truncates or re-words it.
#[test]
fn a_tcc_denied_row_carries_the_engines_advice_unmodified() {
    let advice = "TCC-blocked: can't read /Users/x/Documents/proj (macOS-protected folder \
                  /Users/x/Documents). Grant the daily-briefing binary access in System Settings → \
                  Privacy & Security → Files & Folders (or Full Disk Access), or move the repo out \
                  of Desktop/Documents/Downloads. See the README.";
    let doctor = doctor_with(serde_json::json!([
        {
            "path": "/Users/x/Documents/proj",
            "ok": false,
            "issueKind": "tcc-denied",
            "advice": advice,
        },
        {
            "path": "/Users/x/Documents/gone",
            "ok": false,
            "issueKind": "not-found",
            "advice": "skipped: path not found — /Users/x/Documents/gone",
        },
    ]));
    let scope = scope_of(&doctor, None, &[], &PathBuf::from("/Users/x"), true);
    assert_eq!(scope.len(), 1, "{scope:?}");
    assert_eq!(
        scope[0].denied.len(),
        1,
        "only a `tcc-denied` row is a denial — a `not-found` one is a typo, and offering a folder \
         grant for it would send the user to System Settings for nothing: {scope:?}"
    );
    assert_eq!(scope[0].denied[0].advice, advice);
    assert_eq!(scope[0].denied[0].path, "/Users/x/Documents/proj");
    assert!(
        scope[0]
            .because
            .contains(&"/Users/x/Documents/gone".to_string()),
        "a non-denied path under the root still puts it in scope: {scope:?}"
    );
}

/// Phase E final harden: `doctor --json` now adds `partialClone: true` and `notes: [<sentence>]` to a
/// repo row that is a partial clone (ADDITIVE-OPTIONAL — a normal row keeps the old shape, and only
/// rows that read fine are probed). `DoctorRepo` declares no `deny_unknown_fields`, and must not:
/// `scope_of` maps a failed parse of the envelope to an EMPTY view, so a strict row type would drop
/// every denied row's advice the moment one repo is a partial clone. The app shows the note on the
/// wizard's last step (`lib/wizard.ts`, `doctorRepoNotes`); this path only has to keep reading.
#[test]
fn a_doctor_row_carrying_the_partial_clone_keys_still_reads() {
    let advice =
        "TCC-blocked: can't read /Users/x/Desktop/proj (macOS-protected folder /Users/x/Desktop).";
    let doctor = doctor_with(serde_json::json!([
        {
            "path": "/Users/x/Desktop/proj",
            "ok": false,
            "issueKind": "tcc-denied",
            "advice": advice,
        },
        {
            "path": "/Users/x/Documents/big",
            "ok": true,
            "issueKind": null,
            "advice": null,
            "partialClone": true,
            "notes": ["partial clone: while the tool reads this repository's history, git itself may download missing file contents from the repository's own remote, with your usual git credentials (the tool never fetches)"],
        },
    ]));
    let scope = scope_of(&doctor, None, &[], &PathBuf::from("/Users/x"), true);
    let desktop = scope
        .iter()
        .find(|r| r.key == "desktop")
        .expect("the denied row's root is in scope");
    assert_eq!(desktop.denied.len(), 1, "{scope:?}");
    assert_eq!(desktop.denied[0].advice, advice);
    let documents = scope
        .iter()
        .find(|r| r.key == "documents")
        .expect("the partial clone's root is in scope");
    assert!(
        documents.denied.is_empty(),
        "a partial clone is a fact, not a denial: {scope:?}"
    );
    assert_eq!(
        documents.because,
        vec!["/Users/x/Documents/big".to_string()]
    );
}

/// Round 1 (lens 2, t12): the engine expands a leading `~` in `repos`/`discoverRoots` at config
/// LOAD (`src/config.ts`, `expandTilde`), but `scope_of` reads the RAW file — so a `~`-spelled
/// entry was invisible to the config-side source, which §11d justifies precisely by the protected
/// discovery root that has produced no repo yet. The rule here is the engine's, member for member:
/// `~` alone is home, a `~/` (or `~\`) prefix is joined onto home, and `~user` is NOT expanded.
#[test]
fn a_tilde_spelled_config_entry_is_in_scope() {
    use daily_briefing_gui_lib::access::expand_tilde;
    let home = PathBuf::from("/Users/x");
    assert_eq!(expand_tilde("~", &home), "/Users/x");
    assert_eq!(
        expand_tilde("~/Desktop/proj", &home),
        "/Users/x/Desktop/proj"
    );
    assert_eq!(
        expand_tilde("~user/Desktop", &home),
        "~user/Desktop",
        "the engine does not expand `~user`, so neither may this"
    );
    assert_eq!(expand_tilde("/abs/proj", &home), "/abs/proj");
    assert_eq!(
        expand_tilde("proj/~/x", &home),
        "proj/~/x",
        "only a LEADING tilde is the convention the engine honours"
    );

    let empty_doctor = doctor_with(serde_json::json!([]));
    let config = serde_json::json!({ "repos": ["~/Desktop/proj"], "discoverRoots": ["~"] });
    let scope = scope_of(&empty_doctor, Some(&config), &[], &home, true);
    assert_eq!(
        scope.iter().map(|r| r.key).collect::<Vec<_>>(),
        vec!["desktop"],
        "a `~/`-spelled repo must be in scope of the root it lives under (and `~` alone is HOME \
         ITSELF, under no protected root): {scope:?}"
    );
    assert_eq!(
        scope[0].because,
        vec!["/Users/x/Desktop/proj".to_string()],
        "the EXPANDED spelling is what lands in `because`: {scope:?}"
    );

    // The expansion is also what de-duplicates a config entry against the doctor row for the SAME
    // repo — raw `~/…` beside doctor's absolute path would list one repo twice.
    let doctor = doctor_with(serde_json::json!([
        { "path": "/Users/x/Documents/proj", "ok": true, "issueKind": null, "advice": null },
    ]));
    let config = serde_json::json!({ "repos": ["~/Documents/proj"] });
    let scope = scope_of(&doctor, Some(&config), &[], &home, true);
    assert_eq!(scope.len(), 1, "{scope:?}");
    assert_eq!(
        scope[0].because,
        vec!["/Users/x/Documents/proj".to_string()],
        "one repo, one `because` row: {scope:?}"
    );

    // And a `~user` entry stays out of scope rather than being guessed at.
    let config = serde_json::json!({ "discoverRoots": ["~user/Desktop"] });
    assert!(scope_of(&empty_doctor, Some(&config), &[], &home, true).is_empty());
}

/* ── the read ─────────────────────────────────────────────────────────────────────────────────── */

/// ⚠ THE CONSTANTS THEMSELVES, not a second copy of the literals. Renumbering `EPERM` in
/// `access.rs` must fail here.
#[test]
fn the_errno_constants_are_what_this_os_reports() {
    assert_eq!(
        std::io::Error::from_raw_os_error(EPERM).kind(),
        std::io::ErrorKind::PermissionDenied,
        "access.rs's EPERM ({EPERM}) is not a permission error on this platform"
    );
    assert_eq!(
        std::io::Error::from_raw_os_error(EACCES).kind(),
        std::io::ErrorKind::PermissionDenied,
        "access.rs's EACCES ({EACCES}) is not a permission error on this platform"
    );
    assert_eq!(
        std::io::Error::from_raw_os_error(ENOENT).kind(),
        std::io::ErrorKind::NotFound,
        "access.rs's ENOENT ({ENOENT}) is not the missing-file error on this platform"
    );
    assert_eq!(
        std::io::Error::from_raw_os_error(ENOTDIR).kind(),
        std::io::ErrorKind::NotADirectory,
        "access.rs's ENOTDIR ({ENOTDIR}) is not the not-a-directory error on this platform"
    );
    assert_eq!(
        classify_dir_error(&std::io::Error::from_raw_os_error(EPERM)),
        DirAccess::Denied { errno: EPERM }
    );
    assert_eq!(
        classify_dir_error(&std::io::Error::from_raw_os_error(EACCES)),
        DirAccess::Denied { errno: EACCES }
    );
    assert_eq!(
        classify_dir_error(&std::io::Error::from_raw_os_error(ENOENT)),
        DirAccess::NotFound
    );
    assert_eq!(
        classify_dir_error(&std::io::Error::from_raw_os_error(ENOTDIR)),
        DirAccess::NotADirectory
    );
}

/// ⚠ THE DENIAL HERE IS `EACCES` FROM A MODE-000 DIRECTORY — AN ORDINARY PERMISSION DENIAL, NOT
/// TCC. It exercises the same classifier arm a TCC `EPERM` would and is NOT evidence about TCC;
/// every TCC leg is VM-gated and UNRUN.
#[test]
#[cfg(unix)]
fn a_read_reports_denied_missing_and_not_a_directory_apart() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = ScratchDir::new("access-read");

    let readable = scratch.join("readable");
    std::fs::create_dir_all(&readable).expect("a readable directory");
    std::fs::write(readable.join("a.txt"), b"one").expect("an entry");
    std::fs::write(readable.join("b.txt"), b"two").expect("another entry");
    assert_eq!(
        daily_briefing_gui_lib::access::read_dir_access(&readable),
        DirAccess::Ok { entries: 2 },
        "a readable directory answers with its ENTRY COUNT — and the count is all the app learns"
    );

    let missing = scratch.join("missing");
    assert_eq!(
        daily_briefing_gui_lib::access::read_dir_access(&missing),
        DirAccess::NotFound
    );

    let file = scratch.join("a-file");
    std::fs::write(&file, b"x").expect("a file");
    assert_eq!(
        daily_briefing_gui_lib::access::read_dir_access(&file),
        DirAccess::NotADirectory
    );

    let locked = scratch.join("locked");
    std::fs::create_dir_all(&locked).expect("a directory to lock");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
        .expect("chmod 000 the directory");
    let verdict = daily_briefing_gui_lib::access::read_dir_access(&locked);
    // Restore before any assertion can panic, so `ScratchDir::drop` can still remove it.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
        .expect("restore the mode");
    assert_eq!(
        verdict,
        DirAccess::Denied { errno: EACCES },
        "a mode-000 directory must classify as Denied — the same arm a TCC EPERM takes. (This is \
         EACCES, an ordinary permission denial; it is not TCC evidence.)"
    );
}

/// The drain: a directory that OPENS and then fails per entry is a denial, not a pass.
#[test]
fn the_first_entry_error_wins_over_a_successful_open() {
    use daily_briefing_gui_lib::access::verdict_from_entries;
    let clean: Vec<Result<(), std::io::Error>> = vec![Ok(()), Ok(()), Ok(())];
    assert_eq!(verdict_from_entries(clean), DirAccess::Ok { entries: 3 });

    let midway: Vec<Result<(), std::io::Error>> = vec![
        Ok(()),
        Err(std::io::Error::from_raw_os_error(EACCES)),
        Ok(()),
    ];
    assert_eq!(
        verdict_from_entries(midway),
        DirAccess::Denied { errno: EACCES },
        "a TCC-refused directory can opendir and then fail per entry; treating the open as the \
         answer would turn a denial into a grant"
    );

    let two: Vec<Result<(), std::io::Error>> = vec![
        Err(std::io::Error::from_raw_os_error(ENOENT)),
        Err(std::io::Error::from_raw_os_error(EACCES)),
    ];
    assert_eq!(
        verdict_from_entries(two),
        DirAccess::NotFound,
        "the FIRST error wins"
    );

    let empty: Vec<Result<(), std::io::Error>> = vec![];
    assert_eq!(verdict_from_entries(empty), DirAccess::Ok { entries: 0 });
}

/* ── the gates ────────────────────────────────────────────────────────────────────────────────── */

/// Plan R1's launch rule, as a table. ⚠ THE `(true, false)` ROW IS THE ONE THAT MATTERS: something
/// protected is in scope and NO grant was ever observed, so a read would be an ACQUISITION trigger
/// — an unexplained system prompt outside the guided flow.
#[test]
fn the_launch_probe_fires_only_as_a_revocation_check() {
    assert_eq!(probe_advice(false, false), ProbeAdvice::None);
    assert_eq!(
        probe_advice(false, true),
        ProbeAdvice::None,
        "a recorded grant with nothing protected in scope has nothing to check"
    );
    assert_eq!(
        probe_advice(true, false),
        ProbeAdvice::None,
        "in scope but never granted is exactly the acquisition trigger plan R1 forbids at launch \
         (final-check M2); the guided flow is where that read belongs"
    );
    assert_eq!(probe_advice(true, true), ProbeAdvice::RevocationCheck);
}

/// The post-update check's comparison.
#[test]
fn a_new_version_is_reported_once_and_a_first_launch_is_not_an_update() {
    assert_eq!(version_change(None, "0.1.1"), VersionChange::FirstLaunch);
    assert_eq!(version_change(Some("0.1.1"), "0.1.1"), VersionChange::Same);
    assert_eq!(
        version_change(Some("0.1.0"), "0.1.1"),
        VersionChange::Changed {
            from: "0.1.0".into()
        },
        "an ad-hoc-signed .app has a cdhash-bound DR, so a new version is when the app-principal \
         grant is most likely to have been revoked"
    );
}

/// The three deep links are the three literals, and nothing maps to a fourth.
#[test]
fn the_settings_panes_are_three_fixed_literals() {
    assert_eq!(
        SettingsPane::FilesAndFolders.url(),
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Files"
    );
    assert_eq!(
        SettingsPane::FullDiskAccess.url(),
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    );
    assert_eq!(
        SettingsPane::PrivacyRoot.url(),
        "x-apple.systempreferences:com.apple.preference.security?Privacy"
    );
    assert_eq!(
        SETTINGS_FILES_AND_FOLDERS,
        SettingsPane::FilesAndFolders.url()
    );
    assert_eq!(
        SETTINGS_FULL_DISK_ACCESS,
        SettingsPane::FullDiskAccess.url()
    );
    assert_eq!(SETTINGS_PRIVACY_ROOT, SettingsPane::PrivacyRoot.url());
    for url in [
        SETTINGS_FILES_AND_FOLDERS,
        SETTINGS_FULL_DISK_ACCESS,
        SETTINGS_PRIVACY_ROOT,
    ] {
        assert!(
            url.starts_with("x-apple.systempreferences:"),
            "{url} is not a System Settings deep link. The scheme is the whole of what makes these \
             safe to hand to the system opener; an http(s) URL here would be a browser navigation \
             the app chose for the user."
        );
    }
}

/// Off macOS the flow is absent entirely (appendix T17: *"Assert non-macOS builds never show this
/// step."*). The snapshot's own shape is what the panel switches on.
#[test]
fn an_unsupported_platform_offers_nothing() {
    let snapshot = AccessSnapshot::unsupported("0.1.1");
    assert!(!snapshot.supported);
    assert!(snapshot.roots.is_empty());
    assert_eq!(snapshot.probe_advice, ProbeAdvice::None);
    assert!(snapshot.probe_root.is_none());
    assert!(snapshot.managed_engine_path.is_none());
}

/* ── the record ───────────────────────────────────────────────────────────────────────────────── */

/// A missing, malformed or unreadable record is "nothing observed" — never a refusal to open.
#[test]
fn an_unreadable_record_reads_as_nothing_observed() {
    let scratch = ScratchDir::new("access-record");
    assert_eq!(read_record(&scratch.path), AccessRecord::default());

    std::fs::write(scratch.join(STORE_FILE), b"{ not json").expect("a malformed record");
    assert_eq!(
        read_record(&scratch.path),
        AccessRecord::default(),
        "a malformed record must degrade to Default; a panel that refused to open over its own \
         cache would be worse than one that re-asks"
    );

    let record = AccessRecord {
        app_principal_grant_observed: true,
        last_launch_version: Some("0.1.0".into()),
    };
    daily_briefing_gui_lib::access::write_record(&scratch.path, &record).expect("write the record");
    assert_eq!(read_record(&scratch.path), record, "it round-trips");

    // Round 1 (GA3): the write is temp-then-rename, not truncate-then-write — a crash mid-write
    // must not be able to MANUFACTURE the malformed record whose pinned degrade-to-Default would
    // silently reset the launch gate. What a test can reach of that: an overwrite replaces the
    // whole record, and no staging file outlives a successful write.
    let replaced = AccessRecord {
        app_principal_grant_observed: false,
        last_launch_version: Some("0.2.0".into()),
    };
    daily_briefing_gui_lib::access::write_record(&scratch.path, &replaced).expect("overwrite it");
    assert_eq!(
        read_record(&scratch.path),
        replaced,
        "the overwrite replaces the whole record"
    );
    let leftovers: Vec<String> = std::fs::read_dir(&scratch.path)
        .expect("list the record dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name != STORE_FILE)
        .collect();
    assert_eq!(
        leftovers,
        Vec::<String>::new(),
        "a successful write must leave no staging file beside {STORE_FILE}"
    );
}

/// Known item 8 (Phase E final harden): the record's temp file is CREATED, never opened. With a
/// dangling symlink planted at every temp name the write can draw, the write refuses — it neither
/// creates a link's target through it (`File::create` did) nor replaces a plant — and the record
/// already on disk is left exactly as it was.
#[cfg(unix)]
#[test]
fn a_planted_temp_name_is_never_written_through() {
    let scratch = ScratchDir::new("access-temp-plant");
    let seeded = AccessRecord {
        app_principal_grant_observed: true,
        last_launch_version: Some("0.1.0".into()),
    };
    daily_briefing_gui_lib::access::write_record(&scratch.path, &seeded).expect("seed the record");
    common::assert_planted_temp_names_refused(&scratch.path, STORE_FILE, || {
        daily_briefing_gui_lib::access::write_record(&scratch.path, &AccessRecord::default())
    });
    assert_eq!(read_record(&scratch.path), seeded);
}

/* ── the commands, through real IPC ───────────────────────────────────────────────────────────── */

struct Harness {
    app: App<MockRuntime>,
    opener: Arc<RecordingOpener>,
    home: PathBuf,
    app_data: PathBuf,
    argv_file: PathBuf,
    _scratch: ScratchDir,
}

/// A mock app around the SHIPPED handler, with the engine pointed at `access_sidecar` and T17's
/// state pointed entirely inside the scratch directory.
///
/// `doctor_repos` is handed the INJECTED home, because a doctor row has to name a path under it —
/// and that path cannot be written down before the scratch directory exists. A row naming the
/// developer's real `~/Documents` would put a folder in scope that a later `access_probe` would then
/// READ.
fn harness(
    doctor_repos: impl FnOnce(&Path) -> String,
    bin_path: Option<&str>,
    config: Option<&str>,
) -> Harness {
    harness_with(
        doctor_repos,
        bin_path,
        config,
        Arc::new(RecordingOpener::default()),
    )
}

/// [`harness`] with the sink chosen by the caller — the opener-failure leg needs a failing one.
fn harness_with(
    doctor_repos: impl FnOnce(&Path) -> String,
    bin_path: Option<&str>,
    config: Option<&str>,
    opener: Arc<RecordingOpener>,
) -> Harness {
    let (scratch, home, config_path, argv_file) = harness_dirs(config);
    let bin = bin_path.map(PathBuf::from);
    let doctor_repos_json = doctor_repos(&home);
    let program = access_sidecar(
        &scratch.path,
        "engine.sh",
        &config_path,
        &doctor_repos_json,
        bin.as_deref(),
        &argv_file,
    );
    build_harness(scratch, home, argv_file, program, opener)
}

/// [`harness`] over a sidecar whose `doctor --json` answer is the CURRENT content of
/// `doctor_file` — for sequences a fixed fake cannot play (a repo walk that times out on one call
/// and finishes on the next).
fn harness_doctor_file(doctor_file: &Path, config: Option<&str>) -> Harness {
    let (scratch, home, config_path, argv_file) = harness_dirs(config);
    let program = common::access_sidecar_doctor_file(
        &scratch.path,
        "engine.sh",
        &config_path,
        doctor_file,
        None,
        &argv_file,
    );
    build_harness(
        scratch,
        home,
        argv_file,
        program,
        Arc::new(RecordingOpener::default()),
    )
}

/// The scratch layout every harness shares: an injected home, a fake state dir, the argv record.
fn harness_dirs(config: Option<&str>) -> (ScratchDir, PathBuf, PathBuf, PathBuf) {
    let scratch = ScratchDir::new("access-ipc");
    let home = scratch.join("home");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("the fake state dir");
    let config_path = state.join("config.json");
    if let Some(text) = config {
        std::fs::write(&config_path, text).expect("the fake config");
    }
    let argv_file = scratch.join("argv.txt");
    (scratch, home, config_path, argv_file)
}

/// ⚠ ONE `generate_context!()` IN THIS BINARY, AND THAT IS NOT STYLE. Two expansions both emit the
/// macOS `__EMBED_INFO_PLIST` static and the link fails outright (`error: symbol
/// _EMBED_INFO_PLIST is already defined`) — the same collision `src/commands.rs`'s module header
/// records from the other direction. Every app in this file is built here.
fn build_harness(
    scratch: ScratchDir,
    home: PathBuf,
    argv_file: PathBuf,
    program: PathBuf,
    opener: Arc<RecordingOpener>,
) -> Harness {
    let app_data = scratch.join("app-data");
    let engine = Engine(Ok(EngineClient::with_program(program)));
    let snapshots = Arc::new(EngineSnapshots::new(engine.0.clone()));
    let app = mock_builder()
        .manage(engine)
        .manage(snapshots)
        .manage(ShellState::default())
        .manage(ConfigSaver::with_candidate_dir(
            scratch.join("candidates-unused"),
        ))
        .manage(
            AccessState::default()
                .with_home(&home)
                .with_store_dir(&app_data)
                .with_opener(opener.clone()),
        )
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(tauri::generate_context!())
        .expect("mock app should build from the shipped tauri.conf.json + capabilities");
    Harness {
        app,
        opener,
        home,
        app_data,
        argv_file,
        _scratch: scratch,
    }
}

fn main_webview(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("main webview")
}

fn call(
    w: &WebviewWindow<MockRuntime>,
    cmd: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: InvokeBody::Json(body),
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

fn deserialize(body: InvokeResponseBody) -> serde_json::Value {
    body.deserialize().expect("a JSON response")
}

/// The whole T17 pipeline: scope from doctor AND the config, the engine's advice verbatim, the
/// managed engine copy named, the launch gate shut until a grant has been observed.
#[test]
#[cfg(target_os = "macos")]
fn the_snapshot_names_the_roots_in_scope_and_keeps_the_launch_probe_shut() {
    /// The engine's own wording, as `warnFor` writes it for a `tcc-denied` issue. `DOCS` stands in
    /// for the injected home's `Documents`, which only exists once the harness has one.
    const ADVICE: &str = "TCC-blocked: can't read DOCS/proj (macOS-protected folder DOCS). Grant \
                          the daily-briefing binary access in System Settings → Privacy & Security \
                          → Files & Folders (or Full Disk Access), or move the repo out of \
                          Desktop/Documents/Downloads. See the README.";
    const MANAGED: &str = "/Users/x/Library/Application Support/daily-briefing/daily-briefing";

    let h = harness(
        |home| {
            let docs = home.join("Documents");
            serde_json::json!([{
                "path": docs.join("proj").to_string_lossy(),
                "ok": false,
                "issueKind": "tcc-denied",
                "advice": ADVICE.replace("DOCS", &docs.to_string_lossy()),
            }])
            .to_string()
        },
        Some(MANAGED),
        None,
    );
    let docs = h.home.join("Documents");
    let advice = ADVICE.replace("DOCS", &docs.to_string_lossy());
    let w = main_webview(&h.app);

    let snapshot = call(&w, "access_snapshot", serde_json::json!({})).expect("a snapshot");
    assert_eq!(snapshot["supported"], true, "{snapshot}");
    let roots = snapshot["roots"].as_array().expect("roots");
    assert_eq!(roots.len(), 1, "{snapshot}");
    assert_eq!(roots[0]["key"], "documents", "{snapshot}");
    assert_eq!(
        roots[0]["path"],
        docs.to_string_lossy().as_ref(),
        "{snapshot}"
    );
    assert_eq!(
        roots[0]["denied"][0]["advice"], advice,
        "the engine's advice must reach the panel unmodified"
    );
    assert_eq!(
        snapshot["managedEnginePath"], MANAGED,
        "the managed copy comes from `schedule status --json`'s binPath: {snapshot}"
    );
    assert_eq!(
        snapshot["probeAdvice"], "none",
        "a protected root is in scope but no grant was ever observed, so a launch-time read would \
         be an acquisition trigger: {snapshot}"
    );
    assert_eq!(
        snapshot["versionChange"]["kind"], "firstLaunch",
        "{snapshot}"
    );

    // The engine was asked for all three envelopes.
    let argv = std::fs::read_to_string(&h.argv_file).expect("the fake was spawned");
    for expected in ["doctor\n--json\n", "status\n--json\n", "schedule\nstatus\n"] {
        assert!(
            argv.contains(expected),
            "access_snapshot did not run {expected:?}; argv was {argv:?}"
        );
    }

    // ── the second call reports `same`: the post-update check fires ONCE per new version.
    let again = call(&w, "access_snapshot", serde_json::json!({})).expect("a second snapshot");
    assert_eq!(
        again["versionChange"]["kind"], "same",
        "the recorded launch version must advance on the first call, so an update is surfaced once \
         rather than on every re-check: {again}"
    );

    // ── the probe: the root exists and is readable, so the grant is OBSERVED and recorded, and the
    //    launch gate opens for the next launch.
    std::fs::create_dir_all(&docs).expect("the injected Documents");
    let probe = call(
        &w,
        "access_probe",
        serde_json::json!({ "root": "documents" }),
    )
    .expect("a probe result");
    assert_eq!(probe["access"]["kind"], "ok", "{probe}");
    assert_eq!(probe["recorded"], true, "{probe}");
    assert_eq!(
        probe["path"],
        docs.to_string_lossy().as_ref(),
        "the probe must read the INJECTED home — never the developer's own ~/Documents: {probe}"
    );
    assert!(
        read_record(&h.app_data).app_principal_grant_observed,
        "a successful read must record the observation; it is the whole input to the launch gate"
    );

    let after = call(&w, "access_snapshot", serde_json::json!({})).expect("a third snapshot");
    assert_eq!(
        after["probeAdvice"], "revocation-check",
        "with a grant recorded AND a protected root in scope, the launch-time read is a revocation \
         check: {after}"
    );
    assert_eq!(after["probeRoot"], "documents", "{after}");
    assert_eq!(after["grantObserved"], true, "{after}");
}

/// A denial does not record a grant — and does not CLEAR one either.
#[test]
#[cfg(all(unix, target_os = "macos"))]
fn a_denied_read_records_nothing_and_clears_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness(|_| "[]".to_string(), None, None);
    let w = main_webview(&h.app);

    let downloads = h.home.join("Downloads");
    std::fs::create_dir_all(&downloads).expect("the injected Downloads");
    std::fs::set_permissions(&downloads, std::fs::Permissions::from_mode(0o000))
        .expect("chmod 000");
    let probe = call(
        &w,
        "access_probe",
        serde_json::json!({ "root": "downloads" }),
    );
    std::fs::set_permissions(&downloads, std::fs::Permissions::from_mode(0o755))
        .expect("restore the mode");
    let probe = probe.expect("a probe result");
    // ⚠ EACCES from a mode-000 directory — an ORDINARY permission denial, not TCC.
    assert_eq!(probe["access"]["kind"], "denied", "{probe}");
    assert_eq!(probe["recorded"], false, "{probe}");
    assert!(
        !read_record(&h.app_data).app_principal_grant_observed,
        "a denial must not record an observation"
    );

    // With a grant already recorded, a denial leaves it alone: a machine that HAD a grant and lost
    // it is still a machine where checking at launch is the right thing to do.
    daily_briefing_gui_lib::access::write_record(
        &h.app_data,
        &AccessRecord {
            app_principal_grant_observed: true,
            last_launch_version: Some("0.1.1".into()),
        },
    )
    .expect("seed the record");
    std::fs::set_permissions(&downloads, std::fs::Permissions::from_mode(0o000))
        .expect("chmod 000 again");
    let probe = call(
        &w,
        "access_probe",
        serde_json::json!({ "root": "downloads" }),
    );
    std::fs::set_permissions(&downloads, std::fs::Permissions::from_mode(0o755))
        .expect("restore the mode");
    let probe = probe.expect("a probe result");
    assert_eq!(probe["access"]["kind"], "denied", "{probe}");
    assert!(
        read_record(&h.app_data).app_principal_grant_observed,
        "a revoked grant must not erase the record — that would turn the next launch's revocation \
         CHECK back into an acquisition trigger"
    );
}

/// The reveal takes its path from the ENGINE, and the sink records rather than opens.
#[test]
#[cfg(target_os = "macos")]
fn revealing_the_managed_engine_uses_the_path_the_engine_reports() {
    let scratch = ScratchDir::new("access-bin");
    let bin = scratch.join("daily-briefing");
    std::fs::write(&bin, b"#!/bin/sh\nexit 0\n").expect("a stand-in managed copy");
    let h = harness(|_| "[]".to_string(), Some(&bin.to_string_lossy()), None);
    let w = main_webview(&h.app);

    let revealed = call(&w, "access_reveal_engine", serde_json::json!({})).expect("a path");
    assert_eq!(revealed, serde_json::json!(bin.to_string_lossy()));
    assert_eq!(
        h.opener.reveals(),
        vec![bin.clone()],
        "the reveal must use `schedule status --json`'s binPath and nothing else"
    );
    assert!(
        h.opener.urls().is_empty(),
        "revealing a file is not opening a URL"
    );

    // Nothing installed: a named refusal, and the sink is untouched.
    let h = harness(|_| "[]".to_string(), None, None);
    let w = main_webview(&h.app);
    let err = call(&w, "access_reveal_engine", serde_json::json!({}))
        .expect_err("no managed copy to reveal");
    assert!(
        err.contains("noManagedEngine"),
        "an absent binPath must be named as \"nothing is installed\", not blamed on the engine: \
         {err}"
    );
    assert!(h.opener.reveals().is_empty());
}

/// The opener's own failure is reported as `AccessError::Opener`, with its words.
#[test]
#[cfg(target_os = "macos")]
fn an_opener_failure_is_reported_with_its_own_words() {
    let opener = Arc::new(RecordingOpener::failing("System Settings is not installed"));
    let h = harness_with(|_| "[]".to_string(), None, None, opener.clone());
    let w = main_webview(&h.app);

    let err = call(
        &w,
        "access_open_settings",
        serde_json::json!({ "pane": "full-disk-access" }),
    )
    .expect_err("the sink failed");
    assert!(err.contains("opener"), "{err}");
    assert!(err.contains("System Settings is not installed"), "{err}");
    assert_eq!(
        opener.urls(),
        vec!["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
        "the Full Disk Access pane is the broad grant's URL"
    );
}

/// ⚠ THE WIRE-LEVEL CLOSED-ENUM REFUSAL, PINNED (round 1: mutant M9 — `#[serde(alias =
/// "Desktop")]` on `ProtectedRoot` — left all 16 access tests green, so nothing pinned that a
/// NON-MEMBER spelling is refused AT THE BOUNDARY rather than merely absent from the docs). The
/// member control proves the refusals below are the operand's, not the harness's.
#[test]
#[cfg(target_os = "macos")]
fn the_probe_refuses_every_non_member_root_spelling() {
    let h = harness(|_| "[]".to_string(), None, None);
    let w = main_webview(&h.app);

    // The member control: admitted and ANSWERED. The folder does not exist in the injected home,
    // and `notFound` is an answer, not a refusal.
    let ok = call(&w, "access_probe", serde_json::json!({ "root": "desktop" }))
        .expect("the member spelling must be admitted");
    assert_eq!(ok["access"]["kind"], "notFound", "{ok}");

    for bad in [
        serde_json::json!({ "root": "Desktop" }), // casing — the alias mutant's spelling
        serde_json::json!({ "root": " desktop" }), // whitespace
        serde_json::json!({ "root": "desktop " }),
        serde_json::json!({ "root": "/Users/x/Desktop" }), // a path is not a key
        serde_json::json!({ "root": "~/Desktop" }),
        serde_json::json!({ "root": 3 }), // a number
        serde_json::json!({ "root": { "key": "desktop" } }), // an object
        serde_json::json!({}),            // the argument missing entirely
    ] {
        let err = call(&w, "access_probe", bad.clone())
            .expect_err(&format!("{bad} must be refused at the IPC boundary"));
        assert!(
            err.contains("root"),
            "{bad}'s refusal must name the operand, not fail somewhere later: {err}"
        );
        assert!(
            !read_record(&h.app_data).app_principal_grant_observed,
            "{bad} recorded a grant on the strength of a refused operand"
        );
    }
}

/// Round 1 (lens 2, t13): the post-update notice must survive a repo walk that TIMED OUT.
/// `access_snapshot` used to advance `lastLaunchVersion` unconditionally; with
/// `reposTimedOut: true` the roots list is empty, every display path for the notice requires a
/// root in scope, so the one `changed` answer was consumed by a snapshot that could never show it
/// — and the walk finishing a moment later read `same` forever. (The PLAIN sequence — update,
/// walk finishes, advance — is intended and pinned by
/// `the_snapshot_names_the_roots_in_scope_and_keeps_the_launch_probe_shut`.)
#[test]
#[cfg(target_os = "macos")]
fn a_timed_out_walk_does_not_consume_the_post_update_notice() {
    let doctor_dir = ScratchDir::new("access-doctor-file");
    let doctor_file = doctor_dir.join("doctor.json");
    let timed_out = serde_json::json!({
        "schemaVersion": 1, "repos": [], "reposTimedOut": true, "verdict": "degraded",
    });
    std::fs::write(&doctor_file, timed_out.to_string()).expect("the timed-out doctor answer");
    let h = harness_doctor_file(&doctor_file, None);
    let w = main_webview(&h.app);

    // A previous launch, on an older version.
    daily_briefing_gui_lib::access::write_record(
        &h.app_data,
        &AccessRecord {
            app_principal_grant_observed: false,
            last_launch_version: Some("0.0.1".into()),
        },
    )
    .expect("seed the record");

    let first = call(&w, "access_snapshot", serde_json::json!({})).expect("a snapshot");
    assert_eq!(first["reposTimedOut"], true, "{first}");
    assert_eq!(first["versionChange"]["kind"], "changed", "{first}");
    assert_eq!(
        read_record(&h.app_data).last_launch_version.as_deref(),
        Some("0.0.1"),
        "a timed-out walk must NOT advance the recorded version — no snapshot has been able to \
         display the notice yet"
    );

    // The walk finishes and a protected root is in scope: the notice still fires…
    let docs = h.home.join("Documents");
    let finished = serde_json::json!({
        "schemaVersion": 1,
        "repos": [{
            "path": docs.join("proj").to_string_lossy(),
            "ok": true, "issueKind": null, "advice": null,
        }],
        "reposTimedOut": false, "verdict": "ready",
    });
    std::fs::write(&doctor_file, finished.to_string()).expect("the finished doctor answer");
    let second = call(&w, "access_snapshot", serde_json::json!({})).expect("a second snapshot");
    assert_eq!(second["reposTimedOut"], false, "{second}");
    assert_eq!(second["roots"][0]["key"], "documents", "{second}");
    assert_eq!(
        second["versionChange"]["kind"], "changed",
        "the finished walk is the FIRST snapshot that can display the notice, so it must still \
         say `changed`: {second}"
    );

    // …exactly once: that call advanced the record, and the next one reads `same`.
    let third = call(&w, "access_snapshot", serde_json::json!({})).expect("a third snapshot");
    assert_eq!(third["versionChange"]["kind"], "same", "{third}");
}

/* ── B8 (T16): the wizard's draft scope ───────────────────────────────────────────────────────── */

/// The wizard's not-yet-saved draft enters scope EXACTLY as configured entries do: expanded
/// against the same home, unioned, de-duplicated against a config entry for the same path.
#[test]
fn draft_paths_enter_scope_like_configured_entries() {
    use daily_briefing_gui_lib::access::scope_of;
    let home = PathBuf::from("/Users/x");
    let empty_doctor = doctor_with(serde_json::json!([]));

    // No config at all (the wizard's ordinary case): the draft alone puts a root in scope.
    let draft = ["~/Documents/proj".to_string()];
    let scope = scope_of(&empty_doctor, None, &draft, &home, true);
    assert_eq!(
        scope.iter().map(|r| r.key).collect::<Vec<_>>(),
        vec!["documents"],
        "{scope:?}"
    );
    assert_eq!(
        scope[0].because,
        vec!["/Users/x/Documents/proj".to_string()],
        "the draft entry is expanded and shown as the reason"
    );

    // A draft entry that repeats a configured one (the re-run wizard pre-populates its draft
    // from the config) is listed once, not twice.
    let config = serde_json::json!({ "discoverRoots": ["~/Documents"] });
    let scope = scope_of(
        &empty_doctor,
        Some(&config),
        &["~/Documents".to_string()],
        &home,
        true,
    );
    assert_eq!(scope.len(), 1, "{scope:?}");
    assert_eq!(
        scope[0].because,
        vec!["/Users/x/Documents".to_string()],
        "one path, one reason: {scope:?}"
    );

    // A draft naming nothing protected changes nothing.
    assert!(
        scope_of(&empty_doctor, None, &["~/dev".to_string()], &home, true).is_empty(),
        "an unprotected draft path is not a reason to ask for a grant"
    );
}

/// The draft operand's bounds, refused before anything runs.
#[test]
fn a_draft_is_bounded_and_control_characters_are_refused() {
    use daily_briefing_gui_lib::access::{checked_draft, MAX_DRAFT_PATHS, MAX_DRAFT_PATH_BYTES};
    assert!(checked_draft(&[]).is_ok());
    assert!(checked_draft(&["~/Documents".to_string()]).is_ok());
    assert!(checked_draft(&[String::new()]).is_err(), "an empty entry");
    assert!(
        checked_draft(&["a\u{0000}b".to_string()]).is_err(),
        "NUL is a control character"
    );
    assert!(
        checked_draft(&["a\nb".to_string()]).is_err(),
        "a newline is a control character"
    );
    // Round 1 (F11.8): the zero-width / BiDi format characters — invisible, or able to reorder
    // what the snapshot displays — are refused the same way.
    assert!(
        checked_draft(&["a\u{202E}b".to_string()]).is_err(),
        "a right-to-left override is refused"
    );
    assert!(
        checked_draft(&["a\u{200B}b".to_string()]).is_err(),
        "a zero-width space is refused"
    );
    assert!(
        checked_draft(&["a\u{2066}b".to_string()]).is_err(),
        "a BiDi isolate is refused"
    );
    // Round 2 (V-3): U+2028/9 sit in the refusal list for their own reason — JavaScript's
    // line/paragraph separators — and dropping exactly those two survived every assertion above.
    assert!(
        checked_draft(&["a\u{2028}b".to_string()]).is_err(),
        "a line separator (U+2028) is refused"
    );
    assert!(
        checked_draft(&["a\u{2029}b".to_string()]).is_err(),
        "a paragraph separator (U+2029) is refused"
    );
    assert!(
        checked_draft(&["Ünïcodé is fine/día".to_string()]).is_ok(),
        "ordinary non-ASCII stays legal"
    );
    assert!(checked_draft(&["x".repeat(MAX_DRAFT_PATH_BYTES)]).is_ok());
    assert!(checked_draft(&["x".repeat(MAX_DRAFT_PATH_BYTES + 1)]).is_err());
    let many: Vec<String> = (0..MAX_DRAFT_PATHS).map(|i| format!("/p{i}")).collect();
    assert!(checked_draft(&many).is_ok());
    let too_many: Vec<String> = (0..=MAX_DRAFT_PATHS).map(|i| format!("/p{i}")).collect();
    assert!(checked_draft(&too_many).is_err());
}

/// Round 1 (F7 / lens-3 mutations e, e2): the bounds AS LITERALS. The test above is relative to
/// the constants, so silently widening them survives it — the suite's derived-vs-literal
/// doctrine (`tests/capability.rs`, EXPECTED_GRANTS) applied to the two numbers the docs state:
/// `capabilities/README.md`'s access_snapshot row ("up to 64 strings of ≤ 1024 bytes") and
/// `docs/gui-seam.md` §13c.
#[test]
fn the_draft_bounds_are_the_documented_literals() {
    use daily_briefing_gui_lib::access::{MAX_DRAFT_PATHS, MAX_DRAFT_PATH_BYTES};
    assert_eq!(MAX_DRAFT_PATHS, 64);
    assert_eq!(MAX_DRAFT_PATH_BYTES, 1024);
}

/// Through IPC: with NO config on disk, a draft naming a protected root puts it in scope — the
/// wizard's folder-access step — and the same call without the draft reports nothing in scope.
#[test]
#[cfg(target_os = "macos")]
fn the_snapshot_takes_the_wizard_draft_into_scope() {
    let h = harness(|_| "[]".to_string(), None, None);
    let w = main_webview(&h.app);

    let bare = call(&w, "access_snapshot", serde_json::json!({}))
        .expect("access_snapshot without a draft");
    assert_eq!(
        bare["roots"].as_array().map(Vec::len),
        Some(0),
        "no config and no draft: nothing in scope — {bare}"
    );

    let with_draft = call(
        &w,
        "access_snapshot",
        serde_json::json!({ "draft": ["~/Desktop/proj", "~/dev/other"] }),
    )
    .expect("access_snapshot with a draft");
    let roots = with_draft["roots"].as_array().expect("roots");
    assert_eq!(roots.len(), 1, "{with_draft}");
    assert_eq!(roots[0]["key"], "desktop", "{with_draft}");
    let because: Vec<String> = roots[0]["because"]
        .as_array()
        .expect("because")
        .iter()
        .map(|v| v.as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        because,
        vec![h.home.join("Desktop/proj").display().to_string()],
        "the draft path, expanded against the injected home"
    );

    // And the refusal: a control character in the draft is refused before any spawn.
    let _ = std::fs::remove_file(&h.argv_file);
    let err = call(
        &w,
        "access_snapshot",
        serde_json::json!({ "draft": ["bad\u{0007}"] }),
    )
    .expect_err("a control character");
    assert!(err.contains("invalidDraft"), "{err}");
    assert!(
        !h.argv_file.exists(),
        "the refusal must come before any engine spawn"
    );
}

/* ── v0.2.1 §3.4: the engine check while setup is still open ──────────────────────────────────── */

/// `config.exists` is read as `Option<bool>`: only an explicit `false` means "no config yet". The
/// `doctor_with()` fixtures above carry no `config` key at all, so they read `None` — today's
/// behaviour — and keep every assertion they had.
#[test]
fn doctor_config_exists_is_read_only_from_an_explicit_boolean() {
    use daily_briefing_gui_lib::access::doctor_config_exists;
    assert_eq!(
        doctor_config_exists(&doctor_with(serde_json::json!([]))),
        None,
        "the existing fixtures carry no `config` key, so they must keep today's behaviour"
    );
    let no_config = serde_json::json!({
        "schemaVersion": 1,
        "config": { "exists": false, "valid": false, "errors": [], "warnings": [] },
        "repos": [],
        "reposTimedOut": false,
        "verdict": "blocked",
    });
    assert_eq!(doctor_config_exists(&no_config), Some(false));
    let with_config = serde_json::json!({ "config": { "exists": true } });
    assert_eq!(doctor_config_exists(&with_config), Some(true));
    for odd in [
        serde_json::json!({ "config": null }),
        serde_json::json!({ "config": {} }),
        serde_json::json!({ "config": { "exists": "false" } }),
        serde_json::json!({ "config": { "exists": 0 } }),
        serde_json::json!("not an object"),
    ] {
        assert_eq!(
            doctor_config_exists(&odd),
            None,
            "anything but a literal boolean is `None`, never \"no config\": {odd}"
        );
    }
}

/// Through IPC, the three states of `config.exists` with NO config file on disk (the wizard's
/// case): `false` sets the flag and adds no "could not be read" note; `true` and an absent field
/// both keep today's note and leave the flag unset.
#[test]
#[cfg(target_os = "macos")]
fn with_no_config_yet_the_snapshot_flags_it_and_adds_no_read_note() {
    let doctor_dir = ScratchDir::new("access-no-config");
    let doctor_file = doctor_dir.join("doctor.json");
    let no_config = serde_json::json!({
        "schemaVersion": 1,
        "config": {
            "exists": false, "valid": false,
            "errors": [{ "field": "", "message": "the config is not a JSON object" }],
            "warnings": [],
        },
        "repos": [],
        "reposTimedOut": false,
        "verdict": "blocked",
    });
    std::fs::write(&doctor_file, no_config.to_string()).expect("the no-config doctor answer");
    let h = harness_doctor_file(&doctor_file, None);
    let w = main_webview(&h.app);

    let snapshot = call(&w, "access_snapshot", serde_json::json!({})).expect("a snapshot");
    assert_eq!(snapshot["configMissing"], true, "{snapshot}");
    assert_eq!(
        snapshot["doctorVerdict"], "blocked",
        "the verdict is still carried verbatim; the panel decides which line to show: {snapshot}"
    );
    let notes = snapshot["notes"].as_array().expect("notes");
    for note in notes {
        let text = note.as_str().unwrap_or_default();
        assert!(
            !text.contains("could not be read") && !text.contains("config.json"),
            "with no config yet, the expected read failure must not be reported: {snapshot}"
        );
    }
    // The config read still ran — only its note is suppressed.
    let argv = std::fs::read_to_string(&h.argv_file).expect("the fake was spawned");
    assert!(argv.contains("status\n--json\n"), "{argv:?}");

    // `exists: true` with the file unreadable: today's note, flag unset.
    let with_config = serde_json::json!({
        "schemaVersion": 1,
        "config": { "exists": true, "valid": true, "errors": [], "warnings": [] },
        "repos": [],
        "reposTimedOut": false,
        "verdict": "blocked",
    });
    std::fs::write(&doctor_file, with_config.to_string()).expect("the with-config answer");
    let present = call(&w, "access_snapshot", serde_json::json!({})).expect("a snapshot");
    assert_eq!(present["configMissing"], false, "{present}");
    assert!(
        present["notes"]
            .as_array()
            .expect("notes")
            .iter()
            .any(|n| n.as_str().unwrap_or_default().contains(
                "The config could not be read, so only the folders the engine already reported"
            ) && n.as_str().unwrap_or_default().contains("config.json does not exist")),
        "a config doctor says exists but that cannot be read keeps today's note: {present}"
    );

    // No `config` key at all (an older envelope): today's behaviour, exactly as `true`.
    let absent = serde_json::json!({
        "schemaVersion": 1, "repos": [], "reposTimedOut": false, "verdict": "blocked",
    });
    std::fs::write(&doctor_file, absent.to_string()).expect("the field-less answer");
    let legacy = call(&w, "access_snapshot", serde_json::json!({})).expect("a snapshot");
    assert_eq!(legacy["configMissing"], false, "{legacy}");
    assert!(
        legacy["notes"]
            .as_array()
            .expect("notes")
            .iter()
            .any(|n| n.as_str().unwrap_or_default().contains("could not be read")),
        "{legacy}"
    );
}

/// Off macOS the flag is false like every other field of the unsupported answer.
#[test]
fn the_unsupported_snapshot_does_not_claim_setup_is_unfinished() {
    let snapshot = AccessSnapshot::unsupported("0.1.1");
    assert!(!snapshot.config_missing);
    let wire = serde_json::to_value(&snapshot).expect("serialises");
    assert_eq!(
        wire["configMissing"], false,
        "the wire name is camelCase, as `gui/src/lib/access.ts` declares it: {wire}"
    );
}
