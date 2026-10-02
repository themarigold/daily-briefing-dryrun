//! B25 (T25) — the uninstall action: bounded-list parity, the consent gate, and the
//! never-recursive rule.
//!
//! ## What is real here and what is not
//!
//! The FILE legs run against the REAL filesystem — [`SystemFs`] over scratch directories, the
//! `cli_shim` posture. ⚠ What keeps the real `app_data_dir` / engine state dir unreachable is
//! NOT the sink — the sink here IS the real filesystem: it is the `with_app_data_dir` /
//! `with_app_config_dir` overrides on every fixture plus the fake sidecar, whose `status --json`
//! answer points the engine leg at a scratch state dir — and, since round 3, the `with_home_dir`
//! override, so the scheduler-unit check looks under a scratch home, never the developer's real
//! `~/Library/LaunchAgents`. That convention is pinned MECHANICALLY by
//! `every_default_uninstall_state_in_tests_overrides_its_real_paths` below (round-1 fix M7 — the
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

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{fake_sidecar, RecordingAutostartSink, ScratchDir};
use daily_briefing_gui_lib::autostart::AutostartState;
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use daily_briefing_gui_lib::uninstall::{
    refused_for_unit, remove_app_files, remove_engine_state, schedule_unit_files,
    uninstall_execute, uninstall_preview, unit_command_note, unit_uninstall_command, ActionReport,
    EngineEntry, EntryKind, Outcome, SystemFs, UninstallFs, UninstallState, APP_CONFIG_FILES,
    APP_DATA_DIRS, APP_DATA_FILES, ENGINE_STATE_REMOVALS, LAUNCHD_UNIT, REFUSED_FOR_SCHEDULE,
    REFUSED_FOR_UNIT_RULE, SCHEDULE_RECORD, SYSTEMD_UNITS,
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
/// expression — and, since round 3 (D3-L4), the HOME override too: the default looks for the
/// scheduler unit files under the REAL home, where the developer's live
/// `local.daily-briefing.plist` sits, so a test without it would be refused by that machine's own
/// schedule (and would read a real `~/Library/LaunchAgents`).
#[test]
fn every_default_uninstall_state_in_tests_overrides_its_real_paths() {
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
                has("with_app_data_dir") && has("with_app_config_dir") && has("with_home_dir"),
                "{}: a `{needle}` does not chain with_app_data_dir, with_app_config_dir AND \
                 with_home_dir (chained: {methods:?}). The default is the REAL filesystem over the \
                 REAL app directories and the REAL home's scheduler units, and uninstall_execute \
                 deletes files — override all three, always.",
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
        // Phase E (E11): the opt-in update check's record.
        "update-check.json",
    ];
    for name in targets {
        write(&state.join(name), name);
    }
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&state.join("briefings").join("2026-09-02.md"), "archived");
    // ⚠ NO `schedule.json` HERE (Phase E final harden, round 2): a schedule record REFUSES the
    // whole leg, so this — the list removed in full — is the NO-record case. The record's case is
    // `a_schedule_record_refuses_the_whole_engine_leg_whoever_owns_it`.
    let survivors = [
        "last-run",
        "last-skip.json",
        "run.lock",
        "account-state.json",
        "somebody-elses-notes.txt",
        // Glob near-misses: the audit glob must not overreach.
        "audit-2026-09-01.txt",
        "not-audit-2026-09-01.md.bak",
    ];
    for name in survivors {
        write(&state.join(name), name);
    }

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");

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

/// Every entry under `dir` with its bytes — a symlink as its target, a directory as a marker — so
/// "nothing removed" can be asserted as NOTHING CHANGED rather than as "the files I thought of".
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).expect("scratch dir is readable") {
            let path = entry.expect("dir entry").path();
            let rel = path.strip_prefix(root).expect("under root").to_path_buf();
            let meta = std::fs::symlink_metadata(&path).expect("lstat");
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&path).expect("readlink");
                out.insert(rel, format!("-> {}", target.display()).into_bytes());
            } else if meta.is_dir() {
                out.insert(rel, b"<dir>".to_vec());
                walk(root, &path, out);
            } else {
                out.insert(rel, std::fs::read(&path).expect("read"));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// THE GUI-SIDE H1 GUARD, round 2 (Phase E final harden, A-M1 — superseding round 1's "keep only
/// the engine copy"). `scripts/uninstall.sh` removes nothing while `$RECORD` exists until the
/// engine has removed its own schedule (its `if [ -f "$RECORD" ]` block). Round 1's app leg kept
/// `daily-briefing` and deleted the rest, so the schedule went on running the kept copy, calling
/// the provider every morning and RE-CREATING the archive and log the user had consented to
/// delete. Now a record refuses the WHOLE leg: the state dir is byte-for-byte what it was, and the
/// answer is the one refusal that names the way out. Whoever owns the record — this app, the CLI,
/// or nobody legible (an unparseable record; a dangling symlink, which `exists`'s `lstat` still
/// sees) — it refuses the same way: the owner is not read, and an unreadable record fails toward
/// not deleting. With the record gone, the same directory loses exactly the bounded list again.
#[test]
fn a_schedule_record_refuses_the_whole_engine_leg_whoever_owns_it() {
    for record_kind in ["app-owned", "cli-owned", "unparseable", "dangling-symlink"] {
        let scratch = ScratchDir::new("uninstall-scheduled");
        let state = scratch.join("state");
        let targets = [
            "daily-briefing",
            "wake-schedule.json",
            "briefing.log",
            "briefing-latest.md",
            "briefing.log.1",
            "transcript-health.json",
            "audit-2026-09-01.md",
            "update-check.json",
        ];
        for name in targets {
            write(&state.join(name), name);
        }
        write(&state.join("briefings").join("2026-09-01.md"), "archived");
        write(&state.join("last-run"), "2026-09-17");
        let record = |owner: &str| {
            format!(
                r#"{{"owner":"{owner}","invoker":"{owner}","unitPath":"/u/local.daily-briefing.plist","binPath":"{}","installedAt":"2026-09-17T07:00:00.000Z"}}"#,
                state.join("daily-briefing").display()
            )
        };
        match record_kind {
            "app-owned" => write(&state.join(SCHEDULE_RECORD), &record("app")),
            "cli-owned" => write(&state.join(SCHEDULE_RECORD), &record("cli")),
            "unparseable" => write(&state.join(SCHEDULE_RECORD), "{ half"),
            _ => {
                #[cfg(unix)]
                std::os::unix::fs::symlink(scratch.join("nowhere"), state.join(SCHEDULE_RECORD))
                    .expect("a dangling record");
                #[cfg(not(unix))]
                write(&state.join(SCHEDULE_RECORD), "{}");
            }
        }
        let before = tree(&state);
        // prove-it 3b: an empty picture would make the equality below vacuous.
        assert!(
            before.len() >= targets.len() + 4,
            "{record_kind}: premise — the fixture planted the tree: {before:?}"
        );

        let refused = remove_engine_state(&SystemFs, &state, &[]);

        assert_eq!(
            refused,
            Err(REFUSED_FOR_SCHEDULE.to_string()),
            "{record_kind}: a schedule record must refuse the whole engine leg"
        );
        assert_eq!(
            tree(&state),
            before,
            "{record_kind}: the refused leg changed the state dir — it must remove NOTHING"
        );

        // The same directory with the record gone: the bounded list goes, as it always did.
        std::fs::remove_file(state.join(SCHEDULE_RECORD)).expect("remove the record");
        let report = remove_engine_state(&SystemFs, &state, &[])
            .unwrap_or_else(|why| panic!("{record_kind}: refused with no record: {why}"));
        for EngineEntry { token, .. } in ENGINE_STATE_REMOVALS {
            assert_eq!(
                outcome_of(&report, token),
                &Outcome::Removed,
                "{record_kind}: {token} was planted and must go once the record is gone"
            );
        }
        assert!(state.join("last-run").exists(), "outside the bounded list");
    }
}

/// The refusal names the way out EXACTLY: the Schedule screen's real removal button — read from
/// the component that draws it, so a renamed button cannot leave this text pointing at nothing —
/// the engine's own subcommand for a schedule installed from a terminal, "then Uninstall again",
/// and the stale-record clause for a record neither of those can remove. The rule sentence is the
/// webview's (`tests-web/coexistence.check.ts` holds this text to it); `docs/INSTALL.md` states the
/// same rule, and the stale-record clause word for word.
#[test]
fn the_refusal_names_the_real_way_out() {
    const BUTTON: &str = "Remove background scheduler…";
    let component =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/ScheduleUninstall.svelte");
    let source = std::fs::read_to_string(&component)
        .unwrap_or_else(|e| panic!("could not read {} ({e})", component.display()));
    assert!(
        source.contains(&format!("\"{BUTTON}\"")),
        "ScheduleUninstall.svelte no longer draws a {BUTTON:?} button — REFUSED_FOR_SCHEDULE and \
         the consent label (lib/app-uninstall.ts) name it as the way out; rename all three together"
    );
    for part in [
        format!("Schedule screen → {BUTTON}"),
        "`daily-briefing schedule uninstall`".to_string(),
        "if you installed it from the terminal".to_string(),
        "then run Uninstall again".to_string(),
        "Uninstall removes none of the engine's data while a background schedule is installed"
            .to_string(),
        SCHEDULE_RECORD.to_string(),
        // Round 3 (B3-L1): the way out of a STALE record, which the Schedule screen cannot remove
        // (it draws no button) and `schedule uninstall` will not (it exits "Nothing installed"
        // before it unlinks) — the shared clause, word for word (`docs/INSTALL.md`).
        "If the Schedule screen shows no schedule and `daily-briefing schedule uninstall` reports \
         nothing installed, the record is stale: delete `schedule.json` from the engine's folder, \
         then run Uninstall again."
            .to_string(),
        // Round 4 (B4-L6): the RECORD's refusal opens on the record alone — a record-less unit
        // has its own (`refused_for_unit`, below), so this text no longer names a unit file.
        "a background schedule's record (schedule.json) is there,".to_string(),
    ] {
        assert!(
            REFUSED_FOR_SCHEDULE.contains(&part),
            "the refusal does not say {part:?}: {REFUSED_FOR_SCHEDULE}"
        );
    }
    assert!(
        !REFUSED_FOR_SCHEDULE.contains("unit file"),
        "the record's refusal names a unit file again: {REFUSED_FOR_SCHEDULE}"
    );
}

/// THE RECORD-LESS UNIT'S REFUSAL IS ITS OWN (round 4, B4-L6). It used to be the RECORD's refusal
/// with the unit appended: a stale-RECORD clause ("delete `schedule.json`") for a case with no
/// record, and the way out that applies — `daily-briefing schedule uninstall`, which removes a
/// present unit with no record (`src/schedule/install.ts`, `uninstallSchedule`) — LAST. Now it names
/// the unit, then `REFUSED_FOR_UNIT_RULE`, whose first instruction is that command; it carries no
/// record clause, and no Schedule-screen button either (that screen offers its removal only where
/// there is a record). `tests-web/coexistence.check.ts` holds the rule to the webview's
/// `SCHEDULE_UNIT_RULE`, word for word.
#[test]
fn a_record_less_units_refusal_names_its_own_way_out_first() {
    let unit = Path::new("/h/Library/LaunchAgents/local.daily-briefing.plist");
    let refused = refused_for_unit(unit);
    assert!(
        refused.contains("(/h/Library/LaunchAgents/local.daily-briefing.plist)"),
        "{refused}"
    );
    assert!(refused.ends_with(REFUSED_FOR_UNIT_RULE), "{refused}");
    assert_eq!(
        REFUSED_FOR_UNIT_RULE,
        "Uninstall removes none of the engine's data while a background scheduler unit file is \
         there: run `daily-briefing schedule uninstall` in a terminal, which removes that unit \
         file, then run Uninstall again."
    );
    for absent in [
        SCHEDULE_RECORD,
        "stale",
        "Schedule screen",
        "if you installed it from the terminal",
    ] {
        assert!(
            !refused.contains(absent),
            "a record-less unit's refusal says {absent:?}: {refused}"
        );
    }
    assert!(
        !refused.starts_with(REFUSED_FOR_SCHEDULE) && !refused.contains(REFUSED_FOR_SCHEDULE),
        "{refused}"
    );
    // The macOS plist gets no command of its own: `daily-briefing schedule uninstall` as the rule
    // says always looks in `~/Library/LaunchAgents` (cap round, G5-2 — Linux only).
    assert_eq!(unit_command_note(unit), None);
}

/// A LINUX UNIT'S WAY OUT IS A COMMAND FOR ITS OWN DIRECTORY (cap round, G5-2). This app looks under
/// both `$XDG_CONFIG_HOME/systemd/user` and `~/.config/systemd/user` (`schedule_unit_files`), but
/// `daily-briefing schedule uninstall` looks only under the one its environment names
/// (`src/schedule/install.ts`, `unitDir`), so from a terminal with another `XDG_CONFIG_HOME` it
/// reports nothing installed and the unit keeps refusing. For EACH directory the app looks in — one
/// spelled with a space, a quote and a `$` — the refusal is the rule, then the command with
/// `XDG_CONFIG_HOME` set to that unit's own config directory; and a real `/bin/sh` proves the quoting
/// hands a program exactly that directory. (Only the `XDG_CONFIG_HOME=…` prefix is run, in front of
/// `printenv` — the command's own program is stripped off first and never runs.)
#[cfg(unix)]
#[test]
fn a_linux_units_refusal_names_the_command_for_its_own_directory() {
    let home = Path::new("/h");
    let custom = "/x/my cfg/it's $HOME";
    let units = schedule_unit_files("linux", home, Some(Path::new(custom)));
    assert_eq!(units.len(), 4, "premise: both directories, both units");
    for (unit, config, quoted) in [
        (&units[0], custom, r"'/x/my cfg/it'\''s $HOME'"),
        (&units[1], custom, r"'/x/my cfg/it'\''s $HOME'"),
        (&units[2], "/h/.config", "'/h/.config'"),
        (&units[3], "/h/.config", "'/h/.config'"),
    ] {
        let command = unit_uninstall_command(unit).expect("a systemd unit has a command");
        assert_eq!(
            command,
            format!("XDG_CONFIG_HOME={quoted} daily-briefing schedule uninstall"),
            "{unit:?}"
        );
        let refused = refused_for_unit(unit);
        assert!(
            refused.ends_with(&format!(
                "{REFUSED_FOR_UNIT_RULE} To remove this unit file from a terminal, run \
                 `{command}`: `daily-briefing schedule uninstall` looks for it only under \
                 `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when \
                 XDG_CONFIG_HOME is unset."
            )),
            "{refused}"
        );
        assert!(
            refused.contains(&format!("({})", unit.display())),
            "{refused}"
        );

        // The quoting, measured: the prefix alone, in front of `printenv`, through a real shell.
        let prefix = command
            .strip_suffix(" daily-briefing schedule uninstall")
            .expect("the command ends with the engine's subcommand");
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{prefix} /usr/bin/printenv XDG_CONFIG_HOME"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("/bin/sh runs");
        assert!(out.status.success(), "{out:?}");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("{config}\n"),
            "the shell must hand the program exactly the unit's config directory"
        );
    }
    // Byte for byte, the sentence `lib/app-uninstall.ts` pins for the same unit (`unitCommandNote`).
    assert_eq!(
        unit_command_note(Path::new("/h/.config/systemd/user/daily-briefing.timer")).as_deref(),
        Some(
            "To remove this unit file from a terminal, run `XDG_CONFIG_HOME='/h/.config' \
             daily-briefing schedule uninstall`: `daily-briefing schedule uninstall` looks for it \
             only under `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when \
             XDG_CONFIG_HOME is unset."
        )
    );
}

/// The engine's own source, relative to this crate (the `UNINSTALL_SH` addressing).
const ENGINE_UNITS_TS: &str = "../../src/schedule/units.ts";
const ENGINE_INSTALL_TS: &str = "../../src/schedule/install.ts";

/// `export const <name> = "<value>";` from an engine source file — the T9 parse idiom.
fn engine_string_const(source: &str, name: &str) -> String {
    let marker = format!("export const {name} = \"");
    let at = source
        .find(&marker)
        .unwrap_or_else(|| panic!("the engine source no longer declares {name} as a string"));
    let rest = &source[at + marker.len()..];
    rest[..rest.find('"').expect("a closing quote")].to_string()
}

/// THE UNIT FILES ARE THE ENGINE'S (round 3, D3-L4). The names are PARSED from
/// `src/schedule/units.ts` and the directories held to `src/schedule/install.ts`'s `unitDir`, so
/// a renamed label or unit cannot leave the record-less-unit refusal looking for a file nobody
/// writes. `schedule_unit_files` is pure: both platforms' answers are pinned on either.
#[test]
fn the_unit_files_are_the_engines() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let units = std::fs::read_to_string(root.join(ENGINE_UNITS_TS)).expect("units.ts is readable");
    assert_eq!(
        LAUNCHD_UNIT,
        format!("{}.plist", engine_string_const(&units, "SCHEDULE_LABEL"))
    );
    assert_eq!(
        SYSTEMD_UNITS,
        [
            engine_string_const(&units, "SYSTEMD_SERVICE_NAME"),
            engine_string_const(&units, "SYSTEMD_TIMER_NAME"),
        ]
    );
    let install =
        std::fs::read_to_string(root.join(ENGINE_INSTALL_TS)).expect("install.ts is readable");
    for spelling in [
        r#"if (platform === "darwin") return join(home, "Library", "LaunchAgents");"#,
        r#"if (platform === "linux") return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user");"#,
    ] {
        assert!(
            install.contains(spelling),
            "install.ts's unitDir no longer reads {spelling:?} — schedule_unit_files mirrors it"
        );
    }

    let home = Path::new("/h");
    assert_eq!(
        schedule_unit_files("macos", home, None),
        [PathBuf::from(
            "/h/Library/LaunchAgents/local.daily-briefing.plist"
        )]
    );
    assert_eq!(
        schedule_unit_files("linux", home, None),
        [
            PathBuf::from("/h/.config/systemd/user/daily-briefing.service"),
            PathBuf::from("/h/.config/systemd/user/daily-briefing.timer"),
        ]
    );
    // `$XDG_CONFIG_HOME` is looked under AS WELL — the engine's own pick when set — never instead.
    assert_eq!(
        schedule_unit_files("linux", home, Some(Path::new("/x"))),
        [
            PathBuf::from("/x/systemd/user/daily-briefing.service"),
            PathBuf::from("/x/systemd/user/daily-briefing.timer"),
            PathBuf::from("/h/.config/systemd/user/daily-briefing.service"),
            PathBuf::from("/h/.config/systemd/user/daily-briefing.timer"),
        ]
    );
    assert_eq!(
        schedule_unit_files("linux", home, Some(Path::new("/h/.config"))).len(),
        2,
        "the default spelled out is not looked for twice"
    );
    assert_eq!(
        schedule_unit_files("linux", home, Some(Path::new(""))).len(),
        2,
        "an empty $XDG_CONFIG_HOME is no directory"
    );
    assert!(schedule_unit_files("windows", home, None).is_empty());
}

/// THE RECORD-LESS UNIT GUARD (round 3, D3-L4). An older install can leave the engine's unit with
/// no `schedule.json`, and that unit runs the very engine copy the consented leg deletes. So, with
/// no record, each of this platform's unit files — a regular file, or a dangling symlink (`lstat`)
/// — refuses the whole leg: the state dir is byte-for-byte what it was, the unit is untouched (a
/// presence check, never a scheduler call), and the refusal is `refused_for_unit`: the unit's path,
/// then `REFUSED_FOR_UNIT_RULE` with the command that removes it (round 4, B4-L6). The unit gone,
/// the bounded list goes.
#[test]
fn a_record_less_unit_file_refuses_the_whole_engine_leg() {
    let scratch = ScratchDir::new("uninstall-unit");
    let home = scratch.join("home");
    let units = schedule_unit_files(std::env::consts::OS, &home, None);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert!(!units.is_empty(), "premise: this platform has unit files");
    for unit in &units {
        for shape in ["file", "dangling-symlink"] {
            let state = scratch.join("state");
            write(&state.join("daily-briefing"), "#!/bin/sh\n");
            write(&state.join("briefing.log"), "log");
            write(&state.join("briefings").join("2026-09-01.md"), "archived");
            match shape {
                "file" => write(unit, "<plist/>"),
                _ => {
                    std::fs::create_dir_all(unit.parent().expect("a parent")).expect("unit dir");
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(scratch.join("nowhere"), unit)
                        .expect("a dangling unit");
                    #[cfg(not(unix))]
                    write(unit, "<plist/>");
                }
            }
            let before = tree(&state);
            assert!(before.len() >= 4, "premise — the fixture planted the tree");

            let refused = remove_engine_state(&SystemFs, &state, &units);

            let expected = refused_for_unit(unit);
            assert_eq!(refused, Err(expected.clone()), "{unit:?} ({shape})");
            // The rule ends it — then, for a systemd unit, the exact command for the unit's own
            // directory (cap round, G5-2).
            let tail = unit_command_note(unit).map_or(REFUSED_FOR_UNIT_RULE.to_string(), |note| {
                format!("{REFUSED_FOR_UNIT_RULE} {note}")
            });
            assert!(
                expected.contains(&unit.display().to_string()) && expected.ends_with(&tail),
                "the refusal names the unit and the command that removes it: {expected}"
            );
            assert_eq!(
                tree(&state),
                before,
                "{unit:?} ({shape}): NOTHING may be removed"
            );
            assert!(
                std::fs::symlink_metadata(unit).is_ok(),
                "{unit:?}: the unit file is the scheduler's — never removed here"
            );

            std::fs::remove_file(unit).expect("remove the unit");
            let report = remove_engine_state(&SystemFs, &state, &units)
                .unwrap_or_else(|why| panic!("{unit:?} ({shape}): refused with no unit: {why}"));
            assert_eq!(outcome_of(&report, "daily-briefing"), &Outcome::Removed);
            assert_eq!(outcome_of(&report, "briefings"), &Outcome::Removed);
        }
    }
}

/// AN `lstat` THAT CANNOT ANSWER IS NOT "ABSENT" (round 4, A4-L3). `SystemFs::exists` was
/// `symlink_metadata(path).is_ok()`, so a unit file in a directory this user cannot search
/// (`EACCES`) read as absent — and the gate whose own docs say a file that cannot be told absent
/// refuses let the leg run. Now only "no such entry" (`NotFound`) and "a component is not a
/// directory" (`NotADirectory`) are absent. On the REAL filesystem: the unit's directory is made
/// non-searchable (mode 000; restored by a drop guard, so the scratch dir can be removed even when an
/// assertion fails), and the leg must refuse with the state dir untouched; a missing path and a path
/// through a regular file stay absent. ⚠ As root, or with `CAP_DAC_OVERRIDE`, mode 000 does not deny
/// `lstat` (cap round, G5-L2): when a probe shows `lstat` succeeding through it, the EACCES subcase's
/// premise cannot hold, so that subcase alone is SKIPPED, saying why; any other `lstat` failure still
/// fails the premise loudly, and the `NotFound` / `NotADirectory` cases always run.
#[cfg(unix)]
#[test]
fn a_path_lstat_cannot_answer_for_counts_as_present() {
    use std::os::unix::fs::PermissionsExt;
    /// Puts the unit's directory back to 0755 when dropped — on a panicking assertion too.
    struct RestoreMode(PathBuf);
    impl Drop for RestoreMode {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    let scratch = ScratchDir::new("uninstall-eacces");
    let units = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None);
    let unit = units
        .first()
        .expect("premise: this platform has unit files")
        .clone();
    write(&unit, "<plist/>");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    let locked = unit.parent().expect("the unit's directory").to_path_buf();

    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
        .expect("chmod 000 the unit's directory");
    let restore = RestoreMode(locked);
    let lstat = std::fs::symlink_metadata(&unit)
        .map(|_| ())
        .map_err(|e| e.kind());
    if lstat.is_ok() {
        drop(restore);
        eprintln!(
            "a_path_lstat_cannot_answer_for_counts_as_present: SKIPPED the EACCES subcase — lstat \
             succeeded through a mode-000 directory (root, or CAP_DAC_OVERRIDE), so its premise \
             cannot hold here; the NotFound and NotADirectory cases still run"
        );
    } else {
        let exists = SystemFs.exists(&unit);
        let refused = remove_engine_state(&SystemFs, &state, &units);
        let log_left = state.join("briefing.log").exists();
        drop(restore);

        assert_eq!(
            lstat,
            Err(std::io::ErrorKind::PermissionDenied),
            "premise: lstat under a mode-000 directory fails with EACCES"
        );
        assert!(exists, "an lstat that failed with EACCES read as absent");
        assert_eq!(
            refused,
            Err(refused_for_unit(&unit)),
            "a unit that cannot be ruled out must refuse the leg"
        );
        assert!(log_left, "the refused leg removed engine data");
    }

    assert!(!SystemFs.exists(&scratch.join("nothing-here")), "NotFound");
    assert!(
        !SystemFs.exists(&state.join("briefing.log").join("under-a-file")),
        "NotADirectory: nothing can be under a regular file"
    );
}

/// An empty state dir: every entry reports `absent`, nothing is created, nothing fails.
#[test]
fn a_consented_removal_of_nothing_reports_absent() {
    let scratch = ScratchDir::new("uninstall-empty");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");
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

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");

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
        .with_app_config_dir(scratch.join("app-config"))
        .with_home_dir(scratch.join("home"));
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
/// are ALL `Failed`. Everything reads as present EXCEPT the schedule record and the scheduler unit
/// files: either refuses the whole leg before any removal is attempted (rounds 2 and 3), and this
/// fixture is about attempts.
struct RefusingFs;

impl UninstallFs for RefusingFs {
    fn exists(&self, path: &Path) -> bool {
        path.file_name().is_none_or(|name| {
            name != SCHEDULE_RECORD
                && name != LAUNCHD_UNIT
                && !SYSTEMD_UNITS.contains(&&*name.to_string_lossy())
        })
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
        report.engine_refused, None,
        "no consent, nothing to refuse: {report:?}"
    );
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
    assert_eq!(
        report.engine_refused, None,
        "no schedule record, no refusal: {report:?}"
    );
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

/// Phase E M5b checkpoint: leg 1's `disable()` runs under the login-item change lock — the one the
/// toggle's ON holds across its branding `rename`, which would otherwise re-create the plist this
/// leg just removed. Asked from INSIDE the recording sink's `disable()`; released afterwards.
#[tokio::test(flavor = "multi_thread")]
async fn the_autostart_leg_disables_under_the_change_lock() {
    let f = fixture(
        ScratchDir::new("uninstall-lock"),
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    f.autostart.observe_lock_of(f.app.handle().clone());
    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), false)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert_eq!(
        f.autostart.locked_during(),
        [("disable", true)],
        "the uninstall's disable ran WITHOUT the login-item change lock"
    );
    assert!(
        !f.app.state::<AutostartState>().changes_locked(),
        "the change lock is still held after the uninstall returned"
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

/// The schedule-record gate over the commands (Phase E final harden, round 2 — A-M1): the PREVIEW
/// says a record is there before consent is given (`scheduleRecordPresent`, which the consent
/// wording reads), and a consented EXECUTE removes NOTHING of the engine's — every planted file
/// and the archive survive byte-for-byte — reports the ONE refusal (`engineRefused`) and the
/// directory it examined, and still runs the OTHER legs: the login item is disabled and the app's
/// own record removed, exactly as without a schedule.
#[tokio::test(flavor = "multi_thread")]
async fn a_consented_uninstall_under_a_schedule_record_refuses_the_engine_leg_only() {
    let scratch = ScratchDir::new("uninstall-record-cmd");
    let state = scratch.join("state");
    write(&state.join("daily-briefing"), "#!/bin/sh\n");
    write(&state.join("briefing.log"), "log");
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    let state = f._scratch.join("state");

    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(
        !preview.schedule_record_present,
        "no record yet: {preview:?}"
    );
    write(
        &state.join(SCHEDULE_RECORD),
        r#"{"owner":"app","invoker":"app"}"#,
    );
    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(
        preview.schedule_record_present,
        "the preview must report the record before consent is asked for: {preview:?}"
    );
    let before = tree(&state);

    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), true)
        .await
        .expect("uninstall_execute answers");

    assert_eq!(
        report.engine_refused.as_deref(),
        Some(REFUSED_FOR_SCHEDULE),
        "{report:?}"
    );
    assert!(
        report.engine.is_empty(),
        "a refused leg attempts no entry: {report:?}"
    );
    assert!(!report.engine_state_removed, "{report:?}");
    assert_eq!(report.engine_error, None, "{report:?}");
    assert_eq!(
        report.engine_state_dir.as_deref(),
        state.to_str(),
        "the refusal names the directory whose record refused it: {report:?}"
    );
    assert_eq!(
        tree(&state),
        before,
        "the refused engine leg changed the state dir — it must remove NOTHING"
    );
    // The other legs ran as before.
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert_eq!(f.autostart.disables(), 1);
    assert_eq!(
        outcome_of(&report.app, APP_DATA_FILES[0]),
        &Outcome::Removed
    );
    assert!(!f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists());

    // The wire shape the webview's `UninstallReport` mirrors (`gui/src/lib/app-uninstall.ts`).
    let wire = serde_json::to_value(&report).expect("JSON");
    assert_eq!(wire["engineRefused"], REFUSED_FOR_SCHEDULE, "{wire}");
    assert_eq!(wire["engine"], serde_json::json!([]), "{wire}");
    assert_eq!(wire["engineStateRemoved"], false, "{wire}");
    assert_eq!(wire["scheduleRecordPresent"], true, "{wire}");
    assert_eq!(wire["scheduleUnitFile"], serde_json::Value::Null, "{wire}");
    assert_eq!(wire["os"], std::env::consts::OS, "{wire}");
    let wire = serde_json::to_value(&preview).expect("JSON");
    assert_eq!(wire["scheduleRecordPresent"], true, "{wire}");
    assert_eq!(wire["scheduleUnitFile"], serde_json::Value::Null, "{wire}");
    assert_eq!(wire["os"], std::env::consts::OS, "{wire}");
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
            "RefusingFs must fail every entry it is asked to remove: {line:?}"
        );
    }
    assert!(
        !report.engine_state_removed,
        "nothing removed (all failed) must not read as removed: {report:?}"
    );
    assert_eq!(report.engine_error, None, "{report:?}");
    assert_eq!(
        report.engine_refused, None,
        "a failed attempt is not a refusal: {report:?}"
    );
}

/// The record-less unit guard over the commands (round 3, D3-L4), with a FAKE home: the preview
/// names the unit file it found (`scheduleUnitFile`) beside `scheduleRecordPresent: false`, and a
/// consented execute removes nothing of the engine's, reports `refused_for_unit` once — the unit's
/// path included — and still runs the other legs. Nothing outside the scratch home is looked at:
/// the fixture overrides it (`every_default_uninstall_state_in_tests_overrides_its_real_paths`).
#[tokio::test(flavor = "multi_thread")]
async fn a_consented_uninstall_under_a_record_less_unit_refuses_and_names_it() {
    let scratch = ScratchDir::new("uninstall-unit-cmd");
    let state = scratch.join("state");
    write(&state.join("daily-briefing"), "#!/bin/sh\n");
    write(&state.join("briefing.log"), "log");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    let state = f._scratch.join("state");
    let units = schedule_unit_files(std::env::consts::OS, &f._scratch.join("home"), None);
    let Some(unit) = units.last() else {
        // No desktop build ships where the engine writes no unit file (`schedule_unit_files`).
        return;
    };
    write(unit, "<plist/>");

    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(!preview.schedule_record_present, "{preview:?}");
    assert_eq!(
        preview.schedule_unit_file.as_deref(),
        unit.to_str(),
        "the preview must name the unit before consent is asked for: {preview:?}"
    );
    let before = tree(&state);

    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), true)
        .await
        .expect("uninstall_execute answers");

    assert_eq!(
        report.engine_refused,
        Some(refused_for_unit(unit)),
        "{report:?}"
    );
    assert!(report.engine.is_empty(), "{report:?}");
    assert!(!report.engine_state_removed, "{report:?}");
    assert_eq!(tree(&state), before, "the refused leg must remove NOTHING");
    assert!(unit.exists(), "the unit is never removed here");
    assert_eq!(report.schedule_record_present, Some(false), "{report:?}");
    assert_eq!(
        report.schedule_unit_file.as_deref(),
        unit.to_str(),
        "{report:?}"
    );
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert!(!f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists());
}

/// THE DONE VIEW'S SCHEDULE FACTS ARE THE EXECUTE-TIME ONES, ticked or not (round 3, A3-L2). The
/// done view used to warn from the PREVIEW's `scheduleRecordPresent`: a schedule removed between
/// preview and execute still warned, and a preview that could not resolve the state dir never did.
/// Now `uninstall_execute` reads the record (and the unit files) itself, whether or not consent was
/// given: a record the preview saw and that is gone by execute reports `Some(false)`; a record
/// there at execute reports `Some(true)` with the engine untouched and no refusal (no consent, no
/// leg); an engine that cannot name its state dir reports `None` — unknown, not "absent".
#[tokio::test(flavor = "multi_thread")]
async fn the_report_carries_the_execute_time_schedule_facts_ticked_or_not() {
    let scratch = ScratchDir::new("uninstall-exec-facts");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    write(&state.join(SCHEDULE_RECORD), r#"{"owner":"app"}"#);
    let f = fixture(scratch, Arc::new(RecordingAutostartSink::default()));
    let state = f._scratch.join("state");

    // The preview sees the record; the user then removes the schedule before clicking.
    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(preview.schedule_record_present, "{preview:?}");
    std::fs::remove_file(state.join(SCHEDULE_RECORD)).expect("the schedule is removed");
    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), false)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        report.schedule_record_present,
        Some(false),
        "UNTICKED, the execute-time record check still ran and found the record gone: {report:?}"
    );
    assert_eq!(report.schedule_unit_file, None, "{report:?}");
    assert_eq!(report.os, std::env::consts::OS);

    // A record there at execute, box unticked: reported, and nothing of the engine's touched.
    write(&state.join(SCHEDULE_RECORD), r#"{"owner":"cli"}"#);
    let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), false)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(report.schedule_record_present, Some(true), "{report:?}");
    assert_eq!(
        report.engine_refused, None,
        "no consent, no leg to refuse: {report:?}"
    );
    assert!(
        report.engine.is_empty() && report.engine_state_dir.is_none(),
        "{report:?}"
    );
    assert!(state.join("briefing.log").exists());

    // A record-less unit there at execute, box UNTICKED: the unit is read ticked or not too (round
    // 4, B4-L8 — until then only a TICKED execute pinned it, so a read made only under consent
    // passed).
    std::fs::remove_file(state.join(SCHEDULE_RECORD)).expect("the record is removed");
    let units = schedule_unit_files(std::env::consts::OS, &f._scratch.join("home"), None);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert!(!units.is_empty(), "premise: this platform has unit files");
    if let Some(unit) = units.last() {
        write(unit, "<plist/>");
        let report = uninstall_execute(f.app.handle().clone(), f.app.state(), f.app.state(), false)
            .await
            .expect("uninstall_execute answers");
        assert_eq!(
            report.schedule_unit_file.as_deref(),
            unit.to_str(),
            "UNTICKED, the execute-time unit check still ran and found the unit: {report:?}"
        );
        assert_eq!(report.schedule_record_present, Some(false), "{report:?}");
        assert_eq!(
            report.engine_refused, None,
            "no consent, no leg to refuse: {report:?}"
        );
        assert!(unit.exists(), "the unit is never removed here");
    }

    // An engine that cannot name its state dir: unknown, not absent — ticked or not. The unit
    // files are under the home, not the state dir, so they are still looked at.
    let scratch = ScratchDir::new("uninstall-exec-facts-noengine");
    let program = fake_sidecar(&scratch.path, "engine.sh", "exit 2");
    let unit = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None)
        .last()
        .cloned();
    if let Some(unit) = &unit {
        write(unit, "<plist/>");
    }
    let app = app_with(
        program,
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        None,
    );
    for consent in [false, true] {
        let report = uninstall_execute(app.handle().clone(), app.state(), app.state(), consent)
            .await
            .expect("uninstall_execute answers");
        assert_eq!(
            report.schedule_record_present, None,
            "consent={consent}: {report:?}"
        );
        assert_eq!(
            report.schedule_unit_file.as_deref(),
            unit.as_deref().and_then(Path::to_str),
            "consent={consent}: with no state dir the unit is still looked for: {report:?}"
        );
        assert_eq!(
            report.engine_error.is_some(),
            consent,
            "the engine error belongs to the consented leg only: {report:?}"
        );
    }
}

/// A filesystem that is the real one, except that ONE path — a scheduler unit or the record —
/// APPEARS on its `appears_at`-th presence check (1-based) and stays: what a schedule installed
/// while `uninstall_execute` runs looks like to it.
struct AppearsFs {
    path: PathBuf,
    appears_at: u32,
    checks: std::sync::atomic::AtomicU32,
}

impl UninstallFs for AppearsFs {
    fn exists(&self, path: &Path) -> bool {
        if path == self.path {
            let n = self
                .checks
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            return n >= self.appears_at;
        }
        SystemFs.exists(path)
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        SystemFs.remove_file(path)
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        SystemFs.remove_dir_all(path)
    }
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>> {
        SystemFs.list_dir(dir)
    }
}

/// THE REPORT SAYS WHAT THE GATE SAW (round 4, G4-L1). `uninstall_execute` used to sample the unit
/// BEFORE its `status --json` spawn and the record after it, while the gate looked again before the
/// first removal; a unit that appeared in between was refused on and reported absent, and the done
/// view gave the stale-RECORD warning for a unit refusal. Now one look feeds both. Driven by a unit,
/// then a record, that appears on its 1st, 2nd or 3rd presence check: whatever happens, the
/// consented report must agree with its own refusal — refused on the unit ⇒ the report names that
/// unit and no record; refused on the record ⇒ it says a record; not refused ⇒ it names neither
/// (and the leg ran). The 1st-check case is refused, so the agreement is never vacuous.
#[tokio::test(flavor = "multi_thread")]
async fn the_report_states_the_look_the_gate_refused_on() {
    for target in ["unit", "record"] {
        let mut refusals = 0;
        for appears_at in 1..=3 {
            let scratch = ScratchDir::new("uninstall-one-look");
            let state = scratch.join("state");
            write(&state.join("briefing.log"), "log");
            let units = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None);
            let Some(unit) = units.first().cloned() else {
                // No desktop build ships where the engine writes no unit file.
                return;
            };
            let path = match target {
                "unit" => unit.clone(),
                _ => state.join(SCHEDULE_RECORD),
            };
            let fs = Arc::new(AppearsFs {
                path,
                appears_at,
                checks: std::sync::atomic::AtomicU32::new(0),
            });
            let program = status_sidecar(&scratch.path, &state);
            let app = app_with(
                program,
                &scratch,
                Arc::new(RecordingAutostartSink::default()),
                Some(fs),
            );
            let report = uninstall_execute(app.handle().clone(), app.state(), app.state(), true)
                .await
                .expect("uninstall_execute answers");
            let at = format!("{target} appearing at check {appears_at}");
            match report.engine_refused.as_deref() {
                Some(refused) if refused == REFUSED_FOR_SCHEDULE => {
                    refusals += 1;
                    assert_eq!(target, "record", "{at}: refused on a record: {report:?}");
                    assert_eq!(
                        report.schedule_record_present,
                        Some(true),
                        "{at}: refused on a record the report does not state: {report:?}"
                    );
                }
                Some(refused) => {
                    refusals += 1;
                    assert_eq!(refused, refused_for_unit(&unit), "{at}: {report:?}");
                    assert_eq!(
                        report.schedule_unit_file.as_deref(),
                        unit.to_str(),
                        "{at}: refused on a unit the report does not name: {report:?}"
                    );
                    assert_eq!(report.schedule_record_present, Some(false), "{at}");
                }
                None => {
                    assert_eq!(report.schedule_unit_file, None, "{at}: {report:?}");
                    assert_eq!(report.schedule_record_present, Some(false), "{at}");
                    assert!(report.engine_state_removed, "{at}: the leg ran: {report:?}");
                }
            }
        }
        assert!(
            refusals >= 1,
            "premise: a {target} there from the first check must refuse"
        );
    }
}
