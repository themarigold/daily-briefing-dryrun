//! B25 (T25) — the uninstall action: bounded-list parity, the consent gate, and the
//! never-recursive rule.
//!
//! ## What is real here and what is not
//!
//! The FILE legs run against the REAL filesystem — [`SystemFs`] over scratch directories, the
//! `cli_shim` posture. ⚠ What keeps the real `app_data_dir` / engine state dir unreachable is
//! NOT the sink — the sink here IS the real filesystem: it is the `with_app_data_dir` /
//! `with_app_config_dir` overrides on every fixture plus the fake sidecar, whose `status --json`
//! answer points the engine leg at a scratch state dir. That convention is pinned MECHANICALLY by
//! `every_default_uninstall_state_in_tests_overrides_both_app_dirs` below (round-1 fix M7 — the
//! ConfigSaver/AccessState trap's fourth recurrence gets a mechanism, not a reminder). The
//! AUTOSTART leg is a recording sink only; its real `disable()` removes a
//! `~/Library/LaunchAgents` plist and is VM-gated with the rest of T19
//! (`docs/gui-seam.md` §12c, §16c).
//!
//! ## The parity pin (the T9 pattern)
//!
//! [`ENGINE_STATE_REMOVALS`] must be `scripts/uninstall.sh`'s `$SUPPORT`-rooted list, token for
//! token. The test PARSES the script at test time — the same anti-drift shape as
//! `tests/engine_env.rs`'s `pathEnv` parse — so editing either side alone goes red. The script's
//! `$PLIST` (launchd unit) and `$DBA_TEST_DIR/sentinel` (test-mode) removals are deliberately
//! OUTSIDE the parity set: the unit is `schedule uninstall`'s territory, and the sentinel is the
//! script's own harness.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{fake_sidecar, RecordingAutostartSink, ScratchDir};
use daily_briefing_gui_lib::autostart::AutostartState;
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use daily_briefing_gui_lib::uninstall::{
    remove_app_files, remove_engine_state, uninstall_execute, uninstall_preview, ActionReport,
    EngineEntry, EntryKind, Outcome, SystemFs, UninstallFs, UninstallState, APP_CONFIG_FILES,
    APP_DATA_DIRS, APP_DATA_FILES, ENGINE_STATE_REMOVALS,
};
use tauri::test::{mock_builder, MockRuntime};
use tauri::{App, Manager};

/* ── the parity pin ───────────────────────────────────────────────────────────────────────────── */

/// The uninstall script, relative to this crate — the same addressing as `engine_env.rs`'s
/// `UNIT_GENERATOR`.
const UNINSTALL_SH: &str = "../../scripts/uninstall.sh";

/// Every `$SUPPORT`-rooted removal in the script, PARSED: `(token, recursive)` per `rm` operand
/// spelled `"$SUPPORT"/<token>`. Flags decide `recursive` (`-rf`/`-fr`/`-r`); the token keeps the
/// script's own spelling, glob star included.
///
/// ⚠ THE COVERAGE GUARD (round-1 fix M1, measured): the parse recognises exactly ONE spelling,
/// so before it, a bare `rm -rf "$SUPPORT"` (the forbidden recursive delete itself), the
/// `"${SUPPORT}"` brace form and an unquoted `$SUPPORT/x` were all INVISIBLE — the set-equality
/// below stayed green while the script deleted everything. Now every `SUPPORT` mention on a
/// non-comment `rm` line must produce a parsed token, and a spelling the parse cannot see is a
/// loud failure instead of a silent hole.
fn script_support_removals() -> Vec<(String, bool)> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(UNINSTALL_SH);
    let text = std::fs::read_to_string(&source).unwrap_or_else(|e| {
        panic!(
            "could not read the CLI uninstaller at {} ({e}). If it moved, this test must follow \
             it — the whole point is that the bounded list has ONE definition.",
            source.display()
        )
    });

    let mut removals = Vec::new();
    for line in text.lines() {
        // Count and parse on the code half only: a trailing `# … SUPPORT …` comment is a
        // harmless edit, not a spelling the parse cannot see (round-1 verify LOW-2).
        let trimmed = line.trim_start().split('#').next().unwrap_or("").trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let support_mentions = trimmed.matches("SUPPORT").count();
        if !trimmed.starts_with("rm ") {
            // The coverage guard's outer half: an `rm` that touches $SUPPORT from a line shape
            // the parse does not read (`x && rm …`, a pipeline, …) must fail loudly here, not
            // pass silently. (The variable's own definition line has no `rm `.)
            assert!(
                support_mentions == 0 || !trimmed.contains("rm "),
                "scripts/uninstall.sh has an rm touching SUPPORT in a line shape this parse \
                 cannot read: {trimmed:?}. Extend the parse — the parity comparison is only as \
                 good as its coverage."
            );
            continue;
        }
        let mut recursive = false;
        let mut parsed_on_line = 0usize;
        for word in trimmed.split_whitespace() {
            if let Some(flags) = word.strip_prefix('-') {
                if word == "-" {
                    continue;
                }
                if flags.chars().all(|c| c.is_ascii_alphabetic()) && flags.contains('r') {
                    recursive = true;
                }
                continue;
            }
            if let Some(token) = word.strip_prefix("\"$SUPPORT\"/") {
                removals.push((token.to_string(), recursive));
                parsed_on_line += 1;
            }
        }
        // The coverage guard's inner half: every SUPPORT on this rm line parsed. A bare
        // `rm -rf "$SUPPORT"`, a `"${SUPPORT}"` brace spelling or an unquoted `$SUPPORT/x`
        // mentions SUPPORT without producing a token — refuse it instead of not seeing it.
        assert_eq!(
            parsed_on_line, support_mentions,
            "an rm line mentions SUPPORT {support_mentions} time(s) but the parse read \
             {parsed_on_line} token(s) from it: {trimmed:?}. Either the script gained a spelling \
             this parse cannot see (a bare \"$SUPPORT\", a brace form, an unquoted operand) or \
             the forbidden recursive delete of the support dir itself — both must be loud."
        );
    }
    removals
}

/// The pin itself: set-equality between the parsed script and the Rust list, kinds included.
///
/// ⚠ Seen red on a disposable copy both ways: adding `File("last-run")` to the Rust list fails
/// with the extra token named, and adding `rm -f "$SUPPORT"/extra-file` to a script copy fails
/// with the missing token named (mutation ledger, `docs/gui-seam.md` §16d).
#[test]
fn the_engine_list_is_the_scripts_support_rooted_list() {
    let parsed = script_support_removals();

    // prove-it 3b: a parse that silently matched nothing would make the comparison vacuous for
    // an empty Rust list. The script's shape is known: at least six entries, the archive dir
    // recursive, the audit glob present.
    assert!(
        parsed.len() >= 6,
        "the parse found only {parsed:?} — the script's rm lines changed shape and the parity \
         comparison below would be vacuous; fix the parse, not the assertion"
    );
    assert!(
        parsed.iter().any(|(t, r)| t == "briefings" && *r),
        "the parse lost the recursive briefings entry: {parsed:?}"
    );
    assert!(
        parsed.iter().any(|(t, _)| t.contains('*')),
        "the parse lost the audit glob: {parsed:?}"
    );

    let script: BTreeSet<(String, EntryKind)> = parsed
        .into_iter()
        .map(|(token, recursive)| {
            let kind = if recursive {
                EntryKind::Dir
            } else if token.contains('*') {
                EntryKind::Glob
            } else {
                EntryKind::File
            };
            (token, kind)
        })
        .collect();
    let rust: BTreeSet<(String, EntryKind)> = ENGINE_STATE_REMOVALS
        .iter()
        .map(|e| (e.token.to_string(), e.kind))
        .collect();
    assert_eq!(
        rust, script,
        "uninstall::ENGINE_STATE_REMOVALS and scripts/uninstall.sh's $SUPPORT-rooted list have \
         diverged. They are the same contract: the app's consented removal must touch exactly \
         what `bash scripts/uninstall.sh` would, and not one file more."
    );
}

/// No token is a path, and each glob carries exactly one star — the shapes the remover joins onto
/// the engine's state dir without any further validation.
#[test]
fn the_tokens_are_names_not_paths_and_globs_carry_one_star() {
    for EngineEntry { token, kind } in ENGINE_STATE_REMOVALS {
        assert!(
            !token.contains('/') && !token.contains("..") && !token.is_empty(),
            "{token:?} is not a bare direct-child name"
        );
        let stars = token.matches('*').count();
        match kind {
            EntryKind::Glob => {
                assert_eq!(stars, 1, "{token:?} must carry exactly one star");
                // Round-1 fix F6: `glob_matches("*", name)` matches EVERY direct child — a lone
                // star is a sweep of the state dir wearing a glob's clothes, and this guard read
                // as if it prevented that without actually checking.
                assert_ne!(
                    *token, "*",
                    "a bare `*` glob token matches every direct child of the state dir — never a \
                     bounded removal"
                );
            }
            _ => assert_eq!(stars, 0, "{token:?} must carry no star"),
        }
    }
    // And the app-side lists obey the same rule.
    for name in APP_DATA_FILES
        .iter()
        .chain(APP_DATA_DIRS)
        .chain(APP_CONFIG_FILES)
    {
        assert!(
            !name.contains('/') && !name.contains(".."),
            "{name:?} is not a bare direct-child name"
        );
    }
}

/* ── the real-dirs default trap, pinned mechanically (round-1 fix M7) ─────────────────────────── */

/// Every `.rs` file under `dir`, recursively.
fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("tests dir is readable") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `text` with every `//`-to-end-of-line stretch removed (`///` and `//!` included), so the pin
/// below searches CODE, not prose about the code — its own doc comment names the construct it
/// hunts. Cutting at a `//` inside a string literal could truncate a line, but a truncated real
/// chain fails the assert LOUDLY, which is the safe direction.
fn without_line_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        out.push_str(line.split("//").next().unwrap_or(""));
        out.push('\n');
    }
    out
}

/// The method names chained onto the expression `rest` starts after: `.name(args)` repeated,
/// stopping at the first non-`.` continuation. Line comments between calls are skipped; paren
/// depth tracks the argument lists (good enough for this crate's builder chains — no string
/// literal in them carries an unbalanced paren, and a false stop fails LOUD, not silent).
fn chained_methods(rest: &str) -> Vec<String> {
    let mut methods = Vec::new();
    let mut chars = rest.char_indices().peekable();
    loop {
        // Skip whitespace and `//` comments.
        while let Some(&(i, c)) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else if rest[i..].starts_with("//") {
                for (_, c2) in chars.by_ref() {
                    if c2 == '\n' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
        match chars.peek() {
            Some(&(_, '.')) => {
                chars.next();
            }
            _ => return methods,
        }
        let mut name = String::new();
        while let Some(&(_, c)) = chars.peek() {
            if c.is_ascii_alphanumeric() || c == '_' {
                name.push(c);
                chars.next();
            } else {
                break;
            }
        }
        methods.push(name);
        // Consume the balanced `(…)` argument list, if any.
        if let Some(&(_, '(')) = chars.peek() {
            let mut depth = 0i32;
            for (_, c) in chars.by_ref() {
                if c == '(' {
                    depth += 1;
                } else if c == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
        }
    }
}

/// The FOURTH recurrence of the ConfigSaver/AccessState trap gets a MECHANISM (round-1 fix M7).
///
/// `UninstallState::default()` is the real `SystemFs` over the real `app_data_dir()` /
/// `app_config_dir()` — measured on the `MockRuntime`: it resolves the developer's live
/// `~/Library/Application Support/com.themarigold.daily-briefing`, not a sandbox — and
/// `uninstall_execute` DELETES files. Two remembered builder calls were all that kept every test
/// off those directories. The T9 source-parse idiom, applied to ourselves: every
/// `UninstallState::default()` under `tests/` must chain BOTH dir overrides in the same
/// expression.
#[test]
fn every_default_uninstall_state_in_tests_overrides_both_app_dirs() {
    let tests_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    // Concatenated so this test's own string never satisfies its own search.
    let needle: String = ["UninstallState::", "default()"].concat();
    let mut sources = Vec::new();
    collect_rs_files(&tests_dir, &mut sources);
    let mut occurrences = 0usize;
    for path in &sources {
        let raw = std::fs::read_to_string(path).expect("test source is readable");
        let text = without_line_comments(&raw);
        // The stripper cuts at the FIRST `//` on a line, including one inside a string
        // literal — which would swallow a needle to its right and skip the walk for it
        // entirely (round-1 verify LOW-1). Compare against the raw CODE lines (whole-line
        // comments excluded — doc comments name the needle legitimately): a mismatch means
        // a needle hides behind a mid-line `//`. Refuse it instead of silently not seeing it.
        let raw_code_count: usize = raw
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .map(|l| l.matches(&needle).count())
            .sum();
        assert_eq!(
            raw_code_count,
            text.matches(&needle).count(),
            "{}: a `{needle}` sits after a `//` on its line (e.g. inside a string literal) — \
             the comment stripper cannot see it, so this pin cannot walk its chain. Move it to \
             its own line.",
            path.display()
        );
        let mut from = 0usize;
        while let Some(at) = text[from..].find(&needle) {
            let start = from + at + needle.len();
            from = start;
            occurrences += 1;
            let methods = chained_methods(&text[start..]);
            let has = |m: &str| methods.iter().any(|name| name == m);
            assert!(
                has("with_app_data_dir") && has("with_app_config_dir"),
                "{}: a `{needle}` does not chain BOTH with_app_data_dir and with_app_config_dir \
                 (chained: {methods:?}). The default is the REAL filesystem over the REAL app \
                 directories, and uninstall_execute deletes files — override both, always.",
                path.display()
            );
        }
    }
    // prove-it 3b: a parse that found nothing would pass vacuously; the two known fixtures
    // (this file's and tests/capability.rs's) must be visible to it.
    assert!(
        occurrences >= 2,
        "the source parse found only {occurrences} `{needle}` occurrence(s) under tests/ — the \
         pin's own search broke; fix the parse, not the assertion"
    );
}

/* ── the removals, against the real filesystem in scratch ─────────────────────────────────────── */

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("scratch parent");
    }
    std::fs::write(path, text).expect("scratch file");
}

fn outcome_of<'r>(report: &'r [ActionReport], name: &str) -> &'r Outcome {
    &report
        .iter()
        .find(|r| r.name == name)
        .unwrap_or_else(|| panic!("no report line for {name:?}: {report:?}"))
        .outcome
}

/// The consented leg removes exactly the bounded list — and the survivors PROVE the rule that
/// matters most: never a recursive delete of the state dir, whose other files (the day marker,
/// the skip record, the run lock, the ownership record, the account store, a file this module
/// has never heard of) all outlive the uninstall.
#[test]
fn a_consented_removal_touches_exactly_the_bounded_list() {
    let scratch = ScratchDir::new("uninstall-engine");
    let state = scratch.join("state");

    let targets = [
        "daily-briefing",
        "wake-schedule.json",
        "briefing.log",
        "briefing-latest.md",
        "briefing.log.1",
        "transcript-health.json",
        "audit-2026-09-01.md",
        "audit-2026-09-02.md",
    ];
    for name in targets {
        write(&state.join(name), name);
    }
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&state.join("briefings").join("2026-09-02.md"), "archived");
    let survivors = [
        "last-run",
        "last-skip.json",
        "run.lock",
        "schedule.json",
        "account-state.json",
        "somebody-elses-notes.txt",
        // Glob near-misses: the audit glob must not overreach.
        "audit-2026-09-01.txt",
        "not-audit-2026-09-01.md.bak",
    ];
    for name in survivors {
        write(&state.join(name), name);
    }

    let report = remove_engine_state(&SystemFs, &state);

    for EngineEntry { token, .. } in ENGINE_STATE_REMOVALS {
        assert_eq!(
            outcome_of(&report, token),
            &Outcome::Removed,
            "{token} was planted and must be reported removed"
        );
    }
    for name in targets {
        assert!(!state.join(name).exists(), "{name} must be gone");
    }
    assert!(
        !state.join("briefings").exists(),
        "the archive dir must be gone"
    );
    for name in survivors {
        assert!(
            state.join(name).exists(),
            "{name} is OUTSIDE the bounded list and must survive"
        );
    }
    assert!(state.exists(), "the state dir itself must survive");
}

/// An empty state dir: every entry reports `absent`, nothing is created, nothing fails.
#[test]
fn a_consented_removal_of_nothing_reports_absent() {
    let scratch = ScratchDir::new("uninstall-empty");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");

    let report = remove_engine_state(&SystemFs, &state);
    for line in &report {
        assert_eq!(line.outcome, Outcome::Absent, "{line:?}");
    }
    assert_eq!(report.len(), ENGINE_STATE_REMOVALS.len());
}

/// The app-file leg: the records and the candidate dir go from `data`, the window-state file
/// from `config`, and nothing else in either directory is touched — including a config dir that
/// doubles as something else's home (the macOS reality, where both resolve to the same
/// `Application Support` folder).
#[test]
fn the_app_leg_removes_the_enumerated_files_and_leaves_the_rest() {
    let scratch = ScratchDir::new("uninstall-app");
    let data = scratch.join("app-data");
    let config = scratch.join("app-config");

    for name in APP_DATA_FILES {
        write(&data.join(name), name);
    }
    write(
        &data.join(APP_DATA_DIRS[0]).join("candidate-1-1.json"),
        "{}",
    );
    for name in APP_CONFIG_FILES {
        write(&config.join(name), name);
    }
    write(&data.join("unrelated.json"), "not ours to remove");
    write(&config.join("unrelated.json"), "not ours to remove");

    let report = remove_app_files(&SystemFs, &data, &config);

    for name in APP_DATA_FILES.iter().chain(APP_CONFIG_FILES) {
        assert_eq!(outcome_of(&report, name), &Outcome::Removed, "{name}");
    }
    assert_eq!(outcome_of(&report, APP_DATA_DIRS[0]), &Outcome::Removed);
    assert!(!data.join(APP_DATA_DIRS[0]).exists());
    assert!(
        data.join("unrelated.json").exists(),
        "the data dir is not swept"
    );
    assert!(
        config.join("unrelated.json").exists(),
        "the config dir is not swept"
    );
    assert!(
        data.exists() && config.exists(),
        "the directories themselves survive"
    );
}

/// A file that cannot be removed is a per-entry `failed`, and the other entries still proceed —
/// one unremovable file must not hide what WAS removed.
#[cfg(unix)]
#[test]
fn a_refused_removal_is_reported_and_does_not_stop_the_rest() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = ScratchDir::new("uninstall-refused");
    let state = scratch.join("state");
    // `briefings` holds a file inside a directory whose write bit is off, so unlinking the child
    // fails — remove_dir_all cannot clear it.
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    let locked = state.join("briefings");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555))
        .expect("lock the dir");
    write(&state.join("briefing.log"), "log");

    let report = remove_engine_state(&SystemFs, &state);

    // Restore the write bit FIRST so the scratch's Drop can clean up whatever the assertions say.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
        .expect("unlock the dir");

    assert!(
        matches!(outcome_of(&report, "briefings"), Outcome::Failed { .. }),
        "{report:?}"
    );
    assert_eq!(
        outcome_of(&report, "briefing.log"),
        &Outcome::Removed,
        "{report:?}"
    );
}

/* ── the commands, over a mock app ────────────────────────────────────────────────────────────── */

/// A fake sidecar whose `status --json` names `state_dir` — the one read the commands make.
fn status_sidecar(dir: &Path, state_dir: &Path) -> PathBuf {
    let body = format!(
        r#"case "$1:$2" in
  status:--json) printf '%s' '{{"paths":{{"stateDir":"{state}","configPath":"{state}/config.json"}}}}' ;;
esac
exit 0"#,
        state = state_dir.display()
    );
    fake_sidecar(dir, "engine.sh", &body)
}

struct Fixture {
    app: App<MockRuntime>,
    autostart: Arc<RecordingAutostartSink>,
    _scratch: ScratchDir,
}

/// ONE `generate_context!` call site for the whole binary — a second one collides on the macOS
/// `_EMBED_INFO_PLIST` static (the exact linker story `src/commands.rs`'s module doc records).
/// `fs`: `None` = the real `SystemFs` over the scratch dirs; `Some` = an injected sink (the
/// all-failures fixture below).
fn app_with(
    program: PathBuf,
    scratch: &ScratchDir,
    autostart: Arc<RecordingAutostartSink>,
    fs: Option<Arc<dyn UninstallFs>>,
) -> App<MockRuntime> {
    let mut uninstall_state = UninstallState::default()
        .with_app_data_dir(scratch.join("app-data"))
        .with_app_config_dir(scratch.join("app-config"));
    if let Some(fs) = fs {
        uninstall_state = uninstall_state.with_fs(fs);
    }
    mock_builder()
        .manage(Engine(Ok(EngineClient::with_program(program))))
        .manage(AutostartState::default().with_sink(autostart))
        .manage(uninstall_state)
        .build(tauri::generate_context!())
        .expect("mock app")
}

fn fixture(scratch: ScratchDir, autostart: Arc<RecordingAutostartSink>) -> Fixture {
    let state_dir = scratch.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    let program = status_sidecar(&scratch.path, &state_dir);
    let app = app_with(program, &scratch, autostart.clone(), None);
    Fixture {
        app,
        autostart,
        _scratch: scratch,
    }
}

/// Round-1 fix F4's fixture: a filesystem where every removal is refused (EPERM-shaped) and the
/// glob leg finds a match to fail on — so a consented run produces an engine report whose lines
/// are ALL `Failed`.
struct RefusingFs;

impl UninstallFs for RefusingFs {
    fn exists(&self, _path: &Path) -> bool {
        true
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("refused: {}", path.display()),
        ))
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("refused: {}", path.display()),
        ))
    }
    fn list_dir(&self, _dir: &Path) -> std::io::Result<Vec<String>> {
        Ok(vec!["audit-2026-09-01.md".into()])
    }
}

/// The consent gate, end to end over the command: `false` leaves every planted engine file in
/// place while the app files go; `true` removes the bounded list. The same run also pins the
/// autostart reuse: an enabled login item is disabled exactly once, through T19's sink.
#[tokio::test(flavor = "multi_thread")]
async fn the_consent_flag_gates_the_engine_leg() {
    let scratch = ScratchDir::new("uninstall-consent");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    write(&state.join("briefing-latest.md"), "latest");
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&state.join("last-run"), "2026-09-17");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );

    // Without consent: the engine's files all survive; the app record went; autostart disabled.
    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), false)
        .await
        .expect("uninstall_execute answers");
    assert!(!report.engine_state_removed);
    assert!(report.engine.is_empty(), "{report:?}");
    assert_eq!(report.engine_error, None, "{report:?}");
    assert_eq!(
        report.engine_state_dir, None,
        "no consent, no target dir to report: {report:?}"
    );
    let state = f._scratch.join("state");
    for name in ["briefing.log", "briefing-latest.md", "last-run"] {
        assert!(
            state.join(name).exists(),
            "{name} must survive an unconsented uninstall"
        );
    }
    assert!(state.join("briefings").exists());
    assert!(!f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists());
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert_eq!(
        f.autostart.disables(),
        1,
        "T19's disable, reused — exactly once"
    );
    assert_eq!(f.autostart.enables(), 0);

    // With consent: the bounded list goes; the marker — outside the list — still survives.
    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), true)
        .await
        .expect("uninstall_execute answers");
    assert!(report.engine_state_removed, "{report:?}");
    assert_eq!(report.engine.len(), ENGINE_STATE_REMOVALS.len());
    // Round-1 fix M3: the report names the directory the consented leg targeted — the fixture
    // sidecar's `status --json` answer, the same resolution the preview rendered consent from.
    assert_eq!(
        report.engine_state_dir.as_deref(),
        state.to_str(),
        "{report:?}"
    );
    assert!(!state.join("briefing.log").exists());
    assert!(!state.join("briefings").exists());
    assert!(state.join("last-run").exists(), "outside the bounded list");
    // The second run found the login item already disabled (the recorder flipped its state).
    assert_eq!(report.autostart, Outcome::Absent, "{report:?}");
    assert_eq!(
        f.autostart.disables(),
        1,
        "no second disable for an absent entry"
    );
}

/// The preview is read-only: it names what is present and removes nothing.
#[tokio::test(flavor = "multi_thread")]
async fn the_preview_reports_presence_and_removes_nothing() {
    let scratch = ScratchDir::new("uninstall-preview");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    write(&state.join("audit-2026-09-01.md"), "report");
    write(&scratch.join("app-data").join(APP_DATA_FILES[1]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );

    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");

    assert_eq!(preview.autostart_enabled, Some(true));
    assert_eq!(preview.autostart_error, None);
    assert!(preview.engine_state_dir.is_some(), "{preview:?}");
    let engine_present: Vec<(&str, bool)> = preview
        .engine_entries
        .iter()
        .map(|e| (e.name.as_str(), e.present))
        .collect();
    assert!(
        engine_present.contains(&("briefing.log", true)),
        "{engine_present:?}"
    );
    assert!(
        engine_present.contains(&("audit-*.md", true)),
        "the glob probes matches"
    );
    assert!(
        engine_present.contains(&("briefings", false)),
        "{engine_present:?}"
    );
    let app_present: Vec<(&str, bool)> = preview
        .app_entries
        .iter()
        .map(|e| (e.name.as_str(), e.present))
        .collect();
    assert!(
        app_present.contains(&(APP_DATA_FILES[1], true)),
        "{app_present:?}"
    );
    assert!(
        app_present.contains(&(APP_DATA_FILES[0], false)),
        "{app_present:?}"
    );

    // Read-only: everything planted is still there, and nothing was disabled.
    let state = f._scratch.join("state");
    assert!(state.join("briefing.log").exists());
    assert!(state.join("audit-2026-09-01.md").exists());
    assert!(f._scratch.join("app-data").join(APP_DATA_FILES[1]).exists());
    assert_eq!(f.autostart.disables(), 0);
}

/// An engine that cannot answer `status --json` fails ONLY the engine leg — consented or not,
/// the app files still go, and the report says why the engine leg could not run.
#[tokio::test(flavor = "multi_thread")]
async fn an_unanswerable_engine_fails_only_its_own_leg() {
    let scratch = ScratchDir::new("uninstall-noengine");
    // A sidecar that prints nothing and exits 2: `status --json` yields no envelope.
    let program = fake_sidecar(&scratch.path, "engine.sh", "exit 2");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let autostart = Arc::new(RecordingAutostartSink::default());
    let app = app_with(program, &scratch, autostart.clone(), None);

    let report = uninstall_execute(app.handle().clone(), app.state(), app.state(), true)
        .await
        .expect("uninstall_execute answers");
    assert!(!report.engine_state_removed, "{report:?}");
    assert!(report.engine.is_empty());
    assert!(report.engine_error.is_some(), "{report:?}");
    assert_eq!(
        report.engine_state_dir, None,
        "an unresolvable state dir must not be named: {report:?}"
    );
    assert!(
        !scratch.join("app-data").join(APP_DATA_FILES[0]).exists(),
        "the app leg proceeds regardless"
    );
}

/// Round-1 fixes M3 + F4, pinned together over the command:
/// - M3: the report NAMES the directory the consented leg targeted (`engine_state_dir`), equal
///   to the fixture sidecar's `status --json` answer.
/// - F4: `engine_state_removed` derives from the OUTCOMES — consent given, dir resolved, every
///   entry `Failed` must report FALSE. (The pre-fix spelling, consent && no resolution error,
///   reported true here: a machine-readable claim of removal over eight failures.)
#[tokio::test(flavor = "multi_thread")]
async fn a_consented_run_names_its_target_and_all_failures_report_nothing_removed() {
    let scratch = ScratchDir::new("uninstall-allfail");
    let state_dir = scratch.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    let program = status_sidecar(&scratch.path, &state_dir);
    let autostart = Arc::new(RecordingAutostartSink::default());
    let app = app_with(program, &scratch, autostart, Some(Arc::new(RefusingFs)));

    let report = uninstall_execute(app.handle().clone(), app.state(), app.state(), true)
        .await
        .expect("uninstall_execute answers");

    assert_eq!(
        report.engine_state_dir.as_deref(),
        state_dir.to_str(),
        "{report:?}"
    );
    assert_eq!(report.engine.len(), ENGINE_STATE_REMOVALS.len());
    for line in &report.engine {
        assert!(
            matches!(line.outcome, Outcome::Failed { .. }),
            "RefusingFs must fail every entry: {line:?}"
        );
    }
    assert!(
        !report.engine_state_removed,
        "all-failed must not read as removed: {report:?}"
    );
    assert_eq!(report.engine_error, None, "{report:?}");
}
