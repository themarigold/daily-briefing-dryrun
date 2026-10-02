//! T19 — autostart, as reworked in Phase E M5b (user-directed, 2026-10-01): NOTHING at launch,
//! default ON at the setup wizard's LAST step, and a BRANDED plist on macOS — plus THE LABEL TEST.
//!
//! Nothing in this file (or anywhere in the suite) calls the real `enable()` / `disable()` /
//! `is_enabled()`: on this machine those touch `~/Library/LaunchAgents` — the VM-gated legs
//! (`docs/gui-seam.md` §12c). The two commands are driven through `common::RecordingAutostartSink`
//! with a scratch store, the branding through `brand_launch_agent` on scratch files only, and the
//! label question is answered from the SOURCES both sides derive from.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use common::{RecordingAutostartSink, ScratchDir};
use daily_briefing_gui_lib::autostart::{
    autostart_set_enabled, autostart_wizard_default, launch_agent_plist, read_record,
    wizard_default, write_record, AutostartRecord, AutostartSink, AutostartState,
};
use tauri::test::{mock_builder, MockRuntime};
use tauri::{App, Manager};

fn shipped_context() -> tauri::Context<MockRuntime> {
    tauri::generate_context!()
}

fn mock_app(state: Option<AutostartState>) -> App<MockRuntime> {
    let builder = mock_builder();
    let builder = match state {
        Some(state) => builder.manage(state),
        None => builder,
    };
    builder.build(shipped_context()).expect("mock app")
}

fn app_with(sink: Arc<RecordingAutostartSink>, store: &std::path::Path) -> App<MockRuntime> {
    mock_app(Some(
        AutostartState::default()
            .with_sink(sink)
            .with_store_dir(store),
    ))
}

/// `lib.rs` (or any source, relative to the crate) with every comment removed — the comments
/// QUOTE the tokens these pins look for. Through `common::code_only`, the full lexer (`//` and
/// nested `/* */` comments dropped, string and char literals kept whole), since the Phase E M5b
/// checkpoint's pin below scans every file under `src/`, where a line-wise `//` split would also
/// cut a line at a `"https://…"` literal.
fn code_only(rel: &str) -> String {
    let raw = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap_or_else(|e| panic!("{rel} is readable: {e}"));
    common::code_only(&raw)
}

/* ── nothing at launch (Phase E M5b) ──────────────────────────────────────────────────────────── */

/// THE USER'S DECISION, PINNED: a launch registers NO login item. B7's `.setup` called a
/// first-launch default-ON one-shot (`autostart::startup`); M5b removes it, so the default lives
/// ONLY in the wizard's last step. The setup closure is read out of `lib.rs` and must not reach
/// the autostart module, the plugin manager or anything that enables; and no `startup` hook may
/// exist in `src/autostart.rs` for a future setup to call.
///
/// ⚠ A SOURCE PIN, stated as such: the real setup builds a real windowed app with the real plugin,
/// which no test may run (it would write `~/Library/LaunchAgents`). Re-adding the B7 call — or any
/// enable — to setup turns this red.
#[test]
fn nothing_registers_a_login_item_at_launch() {
    let lib = code_only("src/lib.rs");
    const OPEN: &str = ".setup(|app| {";
    let start = lib
        .find(OPEN)
        .expect("lib.rs has a `.setup(|app| {` closure")
        + OPEN.len();
    let end = lib[start..]
        .find("Ok(())")
        .expect("the setup closure ends with `Ok(())`");
    let setup = &lib[start..start + end];
    // prove-it 3b: a parse that captured nothing would make the absences below vacuous.
    assert!(
        setup.contains("shell::setup(app.handle())"),
        "the setup closure was not captured (got {setup:?}) — fix the parse, not the assertions"
    );
    for token in ["autostart", "autolaunch", "enable", "startup"] {
        assert!(
            !setup.to_lowercase().contains(token),
            "lib.rs's setup mentions {token:?} in code — a launch must register NO login item \
             (Phase E M5b: the default-ON is the wizard's last step). Setup was: {setup:?}"
        );
    }
    let module = code_only("src/autostart.rs");
    assert!(
        !module.contains("fn startup"),
        "src/autostart.rs defines a `startup` hook again — B7's first-launch one-shot was removed \
         by the user's decision (Phase E M5b)"
    );
}

/// What can turn a login item on, or reach the plugin manager that does: the ONE enable and its
/// real leg, the plugin manager accessor and its type, the branding rewrite, and the ON command
/// itself called from Rust.
///
/// The accessor is matched as the bare word `autolaunch`, not `.autolaunch()` (Phase E M5b fix
/// round 2): the method-call spelling let `tauri_plugin_autostart::ManagerExt::autolaunch(app)` —
/// the same call in fully-qualified form — through, as it would `app.autolaunch ()` or a
/// `ManagerExt::autolaunch` taken as a function value. `ManagerExt` is the trait every one of those
/// spellings has to name or import, so it is a token of its own; `AutoLaunchManager` covers
/// `app.state::<AutoLaunchManager>()`.
///
/// ⚠ AND EVERY OTHER TOKEN IS A BARE IDENTIFIER TOO, NOT A CALL SPELLING (Phase E final harden,
/// G2-1). This list used to carry `enable_now(`, `enable_via_plugin(`, `brand_launch_agent(` and
/// `autostart_set_enabled(`, so `enable_now (…)` — one space before the paren, which rustfmt would
/// remove but the compiler accepts — escaped the census, and so did a FUNCTION VALUE
/// (`let go = enable_now; go(…)`) or a `use … as` rename, none of which spells `name(`. A bare
/// identifier is in every one of those spellings: a call in any whitespace, a function value, an
/// import. So the census no longer asks "is it CALLED here?" but "is it NAMED here at all?", and
/// every naming outside the allowed callers is a finding. Matched as a SUBSTRING of the
/// comment-stripped code, which is stricter than a word match (a longer identifier containing one
/// is flagged too) and keeps string literals in scope (a Rust string handed to the webview —
/// `eval("…invoke('autostart_set_enabled'…)")` — is a way to turn it on as well). The two name
/// lists the webview's registration is built from are the only non-call mentions accepted
/// ([`NAME_LISTS`]).
const ENABLING_TOKENS: &[&str] = &[
    "enable_now",
    "enable_via_plugin",
    "autolaunch",
    "ManagerExt",
    "AutoLaunchManager",
    "brand_launch_agent",
    "autostart_set_enabled",
];

/// The three plugin legs — the only functions that may name the plugin manager.
const PLUGIN_LEGS: &[&str] = &[
    "enable_via_plugin",
    "disable_via_plugin",
    "is_enabled_via_plugin",
];

/// Within `src/autostart.rs`, the only functions each token may be NAMED in — called, taken as a
/// value, or imported (its definition, `fn brand_launch_agent`, is not a use). `autostart_set_enabled`
/// is the webview's command; nothing in Rust uses it, and nothing names the plugin's manager type.
const ALLOWED_CALLERS: &[(&str, &[&str])] = &[
    ("enable_now", &["autostart_set_enabled"]),
    ("enable_via_plugin", &["enable_now"]),
    ("autolaunch", PLUGIN_LEGS),
    ("ManagerExt", PLUGIN_LEGS),
    ("AutoLaunchManager", &[]),
    ("brand_launch_agent", &["enable_via_plugin"]),
    ("autostart_set_enabled", &[]),
];

/// The only mentions of an enabling token that are not a way to turn the login item on: the two
/// NAME LISTS the webview's registration is built from, each `(file under src/, the item's opening,
/// the token it may name)`. A mention is accepted only between that opening and the first `]`
/// after it, so the same token anywhere else in the same file is still a finding.
const NAME_LISTS: &[(&str, &str, &str)] = &[
    // `lib.rs`'s handler: registering the command is what lets the WEBVIEW invoke it.
    (
        "lib.rs",
        "tauri::generate_handler![",
        "autostart_set_enabled",
    ),
    // `autostart.rs`'s webview-facing names, which `commands::all_commands` and the capability
    // tests pin against that handler.
    (
        "autostart.rs",
        "pub const COMMANDS: &[&str] = &[",
        "autostart_set_enabled",
    ),
];

/// Every `.rs` file under `dir`, recursively, sorted.
fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let path = entry.expect("a directory entry").path();
        if path.is_dir() {
            rs_files(&path, out);
        } else if path.extension().is_some_and(|x| x == "rs") {
            out.push(path);
        }
    }
    out.sort();
}

/// The name of the `fn` whose body contains byte offset `at` of `code`, or `None` when `at` is
/// outside every function. A body runs from its `fn` to the first line that is exactly `}` (a
/// top-level item's close); `src/autostart.rs` has no `impl` method among the allowed callers.
/// An unusual spelling (`fn  name`, a nested `fn`) yields a name no allow-list holds — fail closed.
fn enclosing_fn(code: &str, at: usize) -> Option<&str> {
    let start = code[..at].rfind("fn ")?;
    let name_start = start + "fn ".len();
    let name_len = code[name_start..]
        .find(|c: char| !(c.is_alphanumeric() || c == '_'))
        .unwrap_or(code.len() - name_start);
    let end = code[start..].find("\n}").map_or(code.len(), |i| start + i);
    (at < end).then(|| &code[name_start..name_start + name_len])
}

/// Whether the token at `at` is its own DEFINITION: the `fn` keyword before it, in any whitespace.
fn is_definition(code: &str, at: usize) -> bool {
    let before = code[..at].trim_end();
    before.len() < at
        && before.ends_with("fn")
        && !before[..before.len() - 2]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// The byte range of `opening …]` in `code`, if the opening is there.
fn name_list_span(code: &str, opening: &str) -> Option<std::ops::Range<usize>> {
    let start = code.find(opening)?;
    let body = start + opening.len();
    let end = code[body..].find(']')? + body;
    Some(start..end)
}

/// What the census found: every finding, every allowed use (`caller:token`), and every accepted
/// name-list mention (`file:token`).
#[derive(Debug, Default)]
struct Census {
    findings: Vec<String>,
    uses: Vec<String>,
    listed: Vec<String>,
}

/// THE CENSUS, over `(path under src/, comment-stripped code)` pairs — pure, so the real tree and
/// the counterexamples below go through exactly the same rules.
fn enabling_census(files: &[(String, String)]) -> Census {
    let mut census = Census::default();
    for (rel, code) in files {
        let spans: Vec<(std::ops::Range<usize>, &str)> = NAME_LISTS
            .iter()
            .filter(|(file, _, _)| file == rel)
            .filter_map(|(_, opening, token)| Some((name_list_span(code, opening)?, *token)))
            .collect();
        for token in ENABLING_TOKENS {
            for (at, _) in code.match_indices(token) {
                if spans
                    .iter()
                    .any(|(span, t)| t == token && span.contains(&at))
                {
                    census.listed.push(format!("{rel}:{token}"));
                    continue;
                }
                if rel != "autostart.rs" {
                    census.findings.push(format!("src/{rel}: {token}"));
                    continue;
                }
                if is_definition(code, at) {
                    continue;
                }
                let callers = ALLOWED_CALLERS
                    .iter()
                    .find(|(t, _)| t == token)
                    .map_or(&[][..], |(_, callers)| *callers);
                match enclosing_fn(code, at) {
                    Some(caller) if callers.contains(&caller) => {
                        census.uses.push(format!("{caller}:{token}"));
                    }
                    caller => census.findings.push(format!(
                        "src/autostart.rs: {token} named in {caller:?}; only {callers:?} may"
                    )),
                }
            }
        }
    }
    census.findings.sort();
    census.uses.sort();
    census.listed.sort();
    census
}

/// Every file under `src/`, comment-stripped, keyed by its path under `src/`.
fn src_tree() -> Vec<(String, String)> {
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rs_files(&src, &mut files);
    files
        .iter()
        .map(|file| {
            let rel = file
                .strip_prefix(&src)
                .expect("under src/")
                .display()
                .to_string();
            let code = common::code_only(&std::fs::read_to_string(file).expect("readable"));
            (rel, code)
        })
        .collect()
}

/// THE LAUNCH PIN, ONE CALL DEEPER (Phase E M5b checkpoint). `nothing_registers_a_login_item_at_launch`
/// reads only the setup closure's text, so an enable one call down — in `shell::setup`, which the
/// closure calls, or anywhere else a launch reaches — stayed green. This pin reads EVERY file under
/// `src/`, comments stripped: the only one that may name an enabling token is `src/autostart.rs`,
/// and there each token is named only inside the functions in [`ALLOWED_CALLERS`] — so the ON
/// exists in exactly one place, the command, and a launch path cannot reach it without this going
/// red. (Outside both, only the two [`NAME_LISTS`] the webview's registration is built from.)
#[test]
fn nothing_outside_the_on_command_can_turn_the_login_item_on() {
    let tree = src_tree();
    // prove-it 3b: the walk found the crate (lib.rs, shell.rs, autostart.rs, … — 15 today).
    assert!(
        tree.len() >= 10,
        "src/ walk found only {} files",
        tree.len()
    );
    assert!(tree.iter().any(|(rel, _)| rel == "shell.rs"));
    assert!(tree.iter().any(|(rel, _)| rel == "autostart.rs"));

    let census = enabling_census(&tree);
    assert_eq!(
        census.findings,
        Vec::<String>::new(),
        "an enabling token is named somewhere other than its allowed callers — a launch path (or \
         anything else) could turn the login item on without the user's Finish or toggle \
         (Phase E M5b)"
    );
    // prove-it 3b: the parse found the REAL call chain, so the allow-list above is not vacuous.
    assert_eq!(
        census.uses,
        [
            "autostart_set_enabled:enable_now",
            "disable_via_plugin:ManagerExt",
            "disable_via_plugin:autolaunch",
            "enable_now:enable_via_plugin",
            "enable_via_plugin:ManagerExt",
            "enable_via_plugin:autolaunch",
            "enable_via_plugin:brand_launch_agent",
            "is_enabled_via_plugin:ManagerExt",
            "is_enabled_via_plugin:autolaunch",
        ],
        "the call chain in src/autostart.rs changed — re-check every new caller against the \
         user's decision (nothing registers at launch), then update this list deliberately"
    );
    // …and each name-list allowance matched exactly its one entry, so neither is stale or wider
    // than the list it names.
    assert_eq!(
        census.listed,
        [
            "autostart.rs:autostart_set_enabled",
            "lib.rs:autostart_set_enabled"
        ],
        "the name-list allowances no longer match the handler and COMMANDS lists one entry each"
    );
}

/// The census's counterexamples (Phase E final harden, G2-1): every spelling that escaped the old
/// call-token census, each planted into the REAL tree one at a time, must produce a finding — a
/// whitespace call, a function value, a `use … as` rename, in a launch file and inside
/// `src/autostart.rs` alike — and the one accepted registration must not cover a second mention
/// in the same file.
#[test]
fn the_census_catches_every_spelling_of_a_use() {
    let tree = src_tree();
    let planted = |rel: &str, extra: &str| -> Census {
        let mut files = tree.clone();
        let file = files
            .iter_mut()
            .find(|(r, _)| r == rel)
            .unwrap_or_else(|| panic!("src/{rel} is in the tree"));
        file.1.push_str(extra);
        enabling_census(&files)
    };
    // prove-it 3b: the unplanted tree is clean, so every finding below is the plant's.
    assert_eq!(enabling_census(&tree).findings, Vec::<String>::new());

    let cases: &[(&str, &str, &str)] = &[
        (
            "shell.rs",
            "\nfn launch(app: &AppHandle<R>, held: &ChangeGuard<'_>) {\n    let _ = crate::autostart::enable_now (app, held);\n}\n",
            "src/shell.rs: enable_now",
        ),
        (
            "shell.rs",
            "\nfn launch(app: &AppHandle<R>, held: &ChangeGuard<'_>) {\n    let go = crate::autostart::enable_now;\n    let _ = go(app, held);\n}\n",
            "src/shell.rs: enable_now",
        ),
        (
            "shell.rs",
            "\nuse crate::autostart::enable_now as go;\n",
            "src/shell.rs: enable_now",
        ),
        (
            "shell.rs",
            "\nfn launch() {\n    let _ = brand_launch_agent (p, l, b);\n}\n",
            "src/shell.rs: brand_launch_agent",
        ),
        (
            "lib.rs",
            "\nfn launch(app: AppHandle<R>) {\n    let _ = autostart::autostart_set_enabled (app, true);\n}\n",
            "src/lib.rs: autostart_set_enabled",
        ),
        (
            "shell.rs",
            "\nfn launch(w: &WebviewWindow) {\n    let _ = w.eval(\"window.__TAURI__.core.invoke('autostart_set_enabled', { enabled: true })\");\n}\n",
            "src/shell.rs: autostart_set_enabled",
        ),
        (
            "autostart.rs",
            "\nfn sneaky<R: Runtime>(app: &AppHandle<R>, held: &ChangeGuard<'_>) {\n    let _ = enable_now (app, held);\n}\n",
            "src/autostart.rs: enable_now named in Some(\"sneaky\"); only [\"autostart_set_enabled\"] may",
        ),
        (
            "autostart.rs",
            "\nfn sneaky<R: Runtime>(app: &AppHandle<R>, held: &ChangeGuard<'_>) {\n    let go = enable_now;\n    let _ = go(app, held);\n}\n",
            "src/autostart.rs: enable_now named in Some(\"sneaky\"); only [\"autostart_set_enabled\"] may",
        ),
        (
            "autostart.rs",
            "\nuse self::enable_now as go;\n",
            "src/autostart.rs: enable_now named in None; only [\"autostart_set_enabled\"] may",
        ),
    ];
    for (rel, extra, expected) in cases {
        let census = planted(rel, extra);
        assert!(
            census.findings.iter().any(|f| f == expected),
            "planting {extra:?} into src/{rel} was not caught as {expected:?}; findings: {:?}",
            census.findings
        );
    }
}

/* ── the wizard's default, and the record ─────────────────────────────────────────────────────── */

/// The whole rule ([`wizard_default`]): no recorded choice ⇒ ON (plan R1's default, a fresh
/// install); a recorded choice ⇒ the REAL state, so a re-run never re-creates a removed login item
/// and never removes a kept one; recorded and unreadable ⇒ an ERROR (Phase E M5b checkpoint fix:
/// this answered OFF, and the wizard's Finish then applied that OFF as a removal of a login item
/// whose state nobody could read — the wizard now leaves the system alone on an error).
#[test]
fn the_wizard_defaults_on_only_while_no_choice_is_recorded() {
    let fresh = AutostartRecord::default();
    let chosen = AutostartRecord { defaulted: true };
    assert_eq!(wizard_default(&fresh, Ok(false)), Ok(true));
    assert_eq!(wizard_default(&fresh, Ok(true)), Ok(true));
    assert_eq!(wizard_default(&fresh, Err("unreadable".into())), Ok(true));
    assert_eq!(
        wizard_default(&chosen, Ok(true)),
        Ok(true),
        "a kept login item must stay ticked"
    );
    assert_eq!(
        wizard_default(&chosen, Ok(false)),
        Ok(false),
        "a removed login item must NOT be re-ticked"
    );
    let err = wizard_default(&chosen, Err("stat failed".into()))
        .expect_err("an unreadable state must not be answered as OFF (Finish would apply it)");
    // The cause, EXACTLY — never wrapped here: the wizard's note wraps it once (`loginItemNote`), and
    // a sentence added here as well reached the user doubled (Phase E M5b fix round 2).
    assert_eq!(err, "stat failed");
}

/// The command carries that error to the wizard instead of a guessed OFF — and still enables
/// nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_recorded_choice_over_an_unreadable_state_is_an_error_not_an_off() {
    let scratch = ScratchDir::new("autostart-unreadable");
    let store = scratch.join("app-data");
    write_record(&store, &AutostartRecord { defaulted: true }).expect("recorded");
    let sink = Arc::new(RecordingAutostartSink::failing("stat failed"));
    let app = app_with(sink.clone(), &store);
    let err = autostart_wizard_default(app.handle().clone())
        .await
        .expect_err("the wizard must learn the state is unknown");
    // Exactly the cause: the command adds no sentence either — the wizard's note words it, once.
    assert_eq!(err, "stat failed");
    assert_eq!((sink.enables(), sink.disables()), (0, 0));
}

/// The record round-trips; ABSENT reads as "no choice yet"; PRESENT-BUT-UNUSABLE fails toward
/// the user's last known choice (`defaulted: true`), never toward offering the default again.
/// (B7 round 1 fixed this direction; M5b keeps it for the wizard's pre-tick.)
#[test]
fn the_record_round_trips_and_degrades_safely() {
    let scratch = ScratchDir::new("autostart-record");
    let dir = scratch.join("app-data");
    assert_eq!(read_record(&dir), AutostartRecord::default());
    write_record(&dir, &AutostartRecord { defaulted: true }).expect("written");
    assert_eq!(read_record(&dir), AutostartRecord { defaulted: true });
    std::fs::write(dir.join("autostart-state.json"), "{ nope").expect("clobbered");
    assert_eq!(
        read_record(&dir),
        AutostartRecord { defaulted: true },
        "a corrupt record must not read as \"no choice yet\""
    );
}

/// A fresh install: the wizard's default is ON, and READING it enables nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_fresh_install_defaults_on_and_the_read_enables_nothing() {
    let scratch = ScratchDir::new("autostart-fresh");
    let store = scratch.join("app-data");
    let sink = Arc::new(RecordingAutostartSink::default());
    let app = app_with(sink.clone(), &store);
    let on = autostart_wizard_default(app.handle().clone())
        .await
        .expect("answers");
    assert!(
        on,
        "a fresh install must pre-tick Start at login (plan R1: default ON)"
    );
    assert_eq!((sink.enables(), sink.disables()), (0, 0));
    assert!(
        !store.join("autostart-state.json").exists(),
        "a read wrote the record"
    );
}

/// The record-loss probe, one step later than B7's: a PRESENT-but-corrupt record over a removed
/// login item must NOT pre-tick the box — the wizard shows the real state (off), and nothing is
/// enabled.
#[tokio::test(flavor = "multi_thread")]
async fn a_corrupt_record_never_pre_ticks_a_removed_login_item() {
    let scratch = ScratchDir::new("autostart-corrupt");
    let store = scratch.join("app-data");
    std::fs::create_dir_all(&store).expect("store dir");
    std::fs::write(store.join("autostart-state.json"), "{\"defaul").expect("clobbered");
    let sink = Arc::new(RecordingAutostartSink::reporting_enabled(false));
    let app = app_with(sink.clone(), &store);
    let on = autostart_wizard_default(app.handle().clone())
        .await
        .expect("answers");
    assert!(
        !on,
        "a corrupt record pre-ticked a login item the user may have deleted"
    );
    assert_eq!(sink.enables(), 0);
}

/// The wizard's Finish (and the Settings toggle): ON enables once through the ONE enable and
/// records the choice; from then on the wizard reflects the REAL state — OFF after an OFF, ON
/// after an ON — never the default.
#[tokio::test(flavor = "multi_thread")]
async fn set_enabled_applies_the_choice_and_records_it() {
    let scratch = ScratchDir::new("autostart-set");
    let store = scratch.join("app-data");
    let sink = Arc::new(RecordingAutostartSink::default());
    let app = app_with(sink.clone(), &store);

    autostart_set_enabled(app.handle().clone(), true)
        .await
        .expect("ON applies");
    assert_eq!((sink.enables(), sink.disables()), (1, 0));
    assert_eq!(read_record(&store), AutostartRecord { defaulted: true });
    assert!(autostart_wizard_default(app.handle().clone())
        .await
        .expect("answers"));

    autostart_set_enabled(app.handle().clone(), false)
        .await
        .expect("OFF applies");
    assert_eq!((sink.enables(), sink.disables()), (1, 1));
    assert!(
        !autostart_wizard_default(app.handle().clone())
            .await
            .expect("answers"),
        "after the user's OFF, a re-run of the wizard must not pre-tick it again"
    );

    // An OFF chosen at the wizard on a FRESH install: nothing to remove, but the choice is
    // recorded — a later re-run shows the real state (off), not the default.
    let scratch2 = ScratchDir::new("autostart-set-off");
    let store2 = scratch2.join("app-data");
    let sink2 = Arc::new(RecordingAutostartSink::default());
    let app2 = app_with(sink2.clone(), &store2);
    autostart_set_enabled(app2.handle().clone(), false)
        .await
        .expect("OFF applies");
    assert_eq!(sink2.enables(), 0);
    assert_eq!(read_record(&store2), AutostartRecord { defaulted: true });
    assert!(!autostart_wizard_default(app2.handle().clone())
        .await
        .expect("answers"));
}

/// A FAILED enable is returned, NOT recorded (the next wizard still offers the default), and an
/// app that manages no `AutostartState` gets an error, never a guess.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_enable_is_reported_and_not_recorded() {
    let scratch = ScratchDir::new("autostart-fail");
    let store = scratch.join("app-data");
    let sink = Arc::new(RecordingAutostartSink::failing("no launch agent dir"));
    let app = app_with(sink.clone(), &store);
    let err = autostart_set_enabled(app.handle().clone(), true)
        .await
        .expect_err("a failed enable must be reported");
    assert!(err.contains("no launch agent dir"), "{err}");
    assert_eq!(sink.enables(), 1);
    assert_eq!(read_record(&store), AutostartRecord::default());

    let unmanaged = mock_app(None);
    assert!(autostart_set_enabled(unmanaged.handle().clone(), true)
        .await
        .is_err());
    assert!(autostart_wizard_default(unmanaged.handle().clone())
        .await
        .is_err());
}

/* ── the branded plist (macOS; Phase E M5b) ───────────────────────────────────────────────────── */

/// The bundle id the branding writes is `tauri.conf.json`'s `identifier`, read off the BUILT
/// context — the same `app.config().identifier` the real enable passes — and the plist path is
/// `auto-launch 0.5.0`'s `get_file()` for the plugin's derived label.
#[test]
fn the_branding_inputs_are_the_bundle_id_and_the_plugins_own_path() {
    let conf =
        std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"))
            .expect("tauri.conf.json is readable");
    let conf: serde_json::Value = serde_json::from_str(&conf).expect("tauri.conf.json is JSON");
    assert_eq!(
        conf["identifier"].as_str(),
        Some("com.themarigold.daily-briefing")
    );
    let app = mock_app(None);
    assert_eq!(app.config().identifier, "com.themarigold.daily-briefing");
    assert_eq!(
        launch_agent_plist(
            std::path::Path::new("/Users/someone"),
            &app.package_info().name
        ),
        PathBuf::from("/Users/someone/Library/LaunchAgents/Daily Briefing.plist")
    );
    // ⚠ A SOURCE PIN on the real leg, which no test may run: the plugin's enable is followed by
    // the branding, with THESE inputs.
    let module = code_only("src/autostart.rs");
    let body_start = module
        .find("fn enable_via_plugin")
        .expect("autostart.rs has enable_via_plugin");
    let body = &module[body_start..][..module[body_start..]
        .find("\n}\n")
        .expect("enable_via_plugin ends")];
    for needle in [
        "app.autolaunch().enable()",
        "brand_launch_agent(",
        "launch_agent_plist(&home, label)",
        "&app.config().identifier",
        "&app.package_info().name",
    ] {
        assert!(
            body.contains(needle),
            "enable_via_plugin no longer contains {needle:?} — the real ON must brand the plist \
             the plugin wrote. Body: {body}"
        );
    }
    // …and in THAT order (Phase E M5b checkpoint): the branding rewrites the file the plugin's
    // `enable()` writes, so a branding moved before the enable would brand nothing (an absent
    // file is refused) and leave the plugin's unbranded plist behind.
    let enable_at = body.find("app.autolaunch().enable()").expect("found above");
    let brand_at = body.find("brand_launch_agent(").expect("found above");
    assert!(
        enable_at < brand_at,
        "enable_via_plugin brands before the plugin's enable() — the plist it would rewrite does \
         not exist yet. Body: {body}"
    );
}

/* ── one change at a time (Phase E M5b checkpoint) ────────────────────────────────────────────── */

/// Every change the commands make holds the login-item change lock — asked from INSIDE the sink's
/// `enable()` and `disable()`, the stand-ins for the real leg's `enable()` + branding and its
/// `disable()`. And it is released after, so the next change can run.
#[tokio::test(flavor = "multi_thread")]
async fn every_change_holds_the_change_lock() {
    let scratch = ScratchDir::new("autostart-lock");
    let store = scratch.join("app-data");
    let sink = Arc::new(RecordingAutostartSink::default());
    let app = app_with(sink.clone(), &store);
    sink.observe_lock_of(app.handle().clone());

    autostart_set_enabled(app.handle().clone(), true)
        .await
        .expect("ON applies");
    autostart_set_enabled(app.handle().clone(), false)
        .await
        .expect("OFF applies");
    assert_eq!(
        sink.locked_during(),
        [("enable", true), ("disable", true)],
        "a login-item change ran WITHOUT the change lock — an OFF could then land between an ON's \
         enable() and its branding rename, which re-creates the plist the OFF removed"
    );
    assert!(
        !app.state::<AutostartState>().changes_locked(),
        "the change lock is still held after both commands returned"
    );
}

/// An `AutostartSink` whose FIRST `enable()` pauses until the test releases it — the real leg's
/// window between the plugin's `enable()` and the branding's `rename` — and which logs the order
/// in which the changes actually ran.
struct PausingSink {
    entered: Mutex<Option<mpsc::Sender<()>>>,
    release: Mutex<Option<mpsc::Receiver<()>>>,
    events: Mutex<Vec<&'static str>>,
    enabled: Mutex<bool>,
}

impl PausingSink {
    fn new(entered: mpsc::Sender<()>, release: mpsc::Receiver<()>) -> Self {
        Self {
            entered: Mutex::new(Some(entered)),
            release: Mutex::new(Some(release)),
            events: Mutex::new(Vec::new()),
            enabled: Mutex::new(false),
        }
    }

    fn events(&self) -> Vec<&'static str> {
        self.events.lock().expect("events").clone()
    }
}

impl AutostartSink for PausingSink {
    fn enable(&self) -> Result<(), String> {
        self.events.lock().expect("events").push("enable:begin");
        let entered = self.entered.lock().expect("entered").take();
        let release = self.release.lock().expect("release").take();
        if let (Some(entered), Some(release)) = (entered, release) {
            entered.send(()).expect("the test is waiting");
            release.recv().expect("the test releases the ON");
        }
        *self.enabled.lock().expect("enabled") = true;
        self.events.lock().expect("events").push("enable:end");
        Ok(())
    }

    fn disable(&self) -> Result<(), String> {
        self.events.lock().expect("events").push("disable");
        *self.enabled.lock().expect("enabled") = false;
        Ok(())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        Ok(*self.enabled.lock().expect("enabled"))
    }
}

/// THE RACE, DRIVEN: an OFF issued while an ON is paused mid-enable (the real leg's window
/// before the branding `rename`) runs only AFTER the ON finishes — so the user's OFF is the last
/// word and the login item ends OFF. Deterministic, no sleeps: the ON's sink signals when it is
/// paused, the lock is asserted held at that moment (with no lock that assertion fails every
/// time, whatever the scheduler does), and the event log proves the order.
#[test]
fn an_off_issued_while_an_on_is_mid_enable_waits_for_it() {
    let scratch = ScratchDir::new("autostart-race");
    let store = scratch.join("app-data");
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let sink = Arc::new(PausingSink::new(entered_tx, release_rx));
    let app = mock_app(Some(
        AutostartState::default()
            .with_sink(sink.clone())
            .with_store_dir(&store),
    ));

    let on_handle = app.handle().clone();
    let on = std::thread::spawn(move || {
        tauri::async_runtime::block_on(autostart_set_enabled(on_handle, true))
    });
    // A hang guard, not synchronisation: the ON signals the moment it is paused.
    entered_rx
        .recv_timeout(Duration::from_secs(60))
        .expect("the ON reached enable()");
    assert!(
        app.state::<AutostartState>().changes_locked(),
        "an ON paused inside enable() does not hold the change lock — a concurrent OFF would run \
         now, and the ON's branding rename would then re-create the plist it removed"
    );

    let off_handle = app.handle().clone();
    let off = std::thread::spawn(move || {
        tauri::async_runtime::block_on(autostart_set_enabled(off_handle, false))
    });
    // ⚠ "THE OFF IS NOW WAITING" BEFORE THE RELEASE (Phase E final harden, GM2-5). Released at once,
    // the OFF thread could simply not have started yet — then it runs after the ON for the
    // scheduler's reasons, the order below holds whether or not the OFF ever met the lock, and the
    // test proved only that the ON held it. So the release waits until the OFF is INSIDE
    // `lock_changes` (its `waiting` count is raised before the `lock()` and lowered only once the
    // lock is taken) — or until the OFF has already run its `disable()`, which is the failure this
    // exists to catch and is reported, not waited out. The deadline is a hang guard only.
    let state = app.state::<AutostartState>();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while state.changes_waiting() == 0 && sink.events().len() == 1 {
        assert!(
            std::time::Instant::now() < deadline,
            "the OFF never reached the change lock"
        );
        std::thread::yield_now();
    }
    assert_eq!(
        (state.changes_waiting(), sink.events()),
        (1, vec!["enable:begin"]),
        "the OFF did not wait at the change lock while the ON was paused mid-enable — it ran (or \
         got past the lock) inside the ON's enable(), which is the interleaving that lets the ON's \
         branding rename re-create the plist the OFF removed"
    );
    release_tx.send(()).expect("the ON is waiting");
    on.join().expect("the ON thread").expect("ON applies");
    off.join().expect("the OFF thread").expect("OFF applies");

    assert_eq!(
        sink.events(),
        ["enable:begin", "enable:end", "disable"],
        "the OFF ran inside the ON's enable"
    );
    assert!(
        !sink.is_enabled().expect("readable"),
        "the login item is ON after the user's OFF"
    );
    assert_eq!(read_record(&store), AutostartRecord { defaulted: true });
    assert!(!app.state::<AutostartState>().changes_locked());
}

/* ── the atomic replace: a temp file CREATED, never opened (Phase E M5b checkpoint) ──────────── */

#[cfg(unix)]
mod temp_files {
    use super::*;
    use daily_briefing_gui_lib::autostart::{replace_atomically_via, REPLACED_MODE, TEMP_ATTEMPTS};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    pub(crate) fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).expect("stat").permissions().mode() & 0o777
    }

    /// Held by every test in this file that asserts a created file's mode. The umask is PROCESS-wide and
    /// the harness runs this file's tests on parallel threads, so a test that lowers it must not
    /// overlap another that reads a mode. (No other test in this file asserts a mode; a file another
    /// test creates meanwhile only loses group/other bits, which nothing here reads.)
    static MODE_TESTS: Mutex<()> = Mutex::new(());

    pub(crate) fn mode_lock() -> std::sync::MutexGuard<'static, ()> {
        MODE_TESTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The temp name is predictable (`<name>.tmp-<pid>-<seq>`), so something may already sit at
    /// it. A symlink to a file, a DANGLING symlink, and a hard link to a file are planted at the
    /// first three names handed out: none is written through, created through or truncated, each
    /// is left exactly as it was, and the replace succeeds on the fourth (fresh) name with mode
    /// [`REPLACED_MODE`] whatever the umask.
    #[test]
    fn a_planted_temp_name_is_never_written_through() {
        let _serial = mode_lock();
        let scratch = ScratchDir::new("autostart-temp");
        let dir = scratch.join("LaunchAgents");
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("Daily Briefing.plist");
        std::fs::write(&path, "old").expect("planted");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        let victim = scratch.join("victim-of-symlink");
        std::fs::write(&victim, "untouched by the symlink").expect("victim");
        let sym = dir.join("Daily Briefing.plist.tmp-planted-0");
        std::os::unix::fs::symlink(&victim, &sym).expect("symlink");

        let would_be_created = scratch.join("created-through-a-dangling-symlink");
        let dangling = dir.join("Daily Briefing.plist.tmp-planted-1");
        std::os::unix::fs::symlink(&would_be_created, &dangling).expect("dangling symlink");

        let linked = scratch.join("victim-of-hard-link");
        std::fs::write(&linked, "untouched by the hard link").expect("victim");
        let hard = dir.join("Daily Briefing.plist.tmp-planted-2");
        std::fs::hard_link(&linked, &hard).expect("hard link");

        let fresh = dir.join("Daily Briefing.plist.tmp-fresh-3");
        let mut names =
            vec![sym.clone(), dangling.clone(), hard.clone(), fresh.clone()].into_iter();
        replace_atomically_via(&path, b"new bytes", || {
            names.next().expect("asked for a fifth temp name")
        })
        .expect("replaced on the first unused name");

        assert_eq!(
            std::fs::read_to_string(&path).expect("readable"),
            "new bytes"
        );
        assert_eq!(
            mode(&path),
            REPLACED_MODE,
            "the replaced file's mode came from elsewhere"
        );
        assert_eq!(REPLACED_MODE, 0o644);
        assert_eq!(
            std::fs::read_to_string(&victim).expect("readable"),
            "untouched by the symlink",
            "the temp write followed a planted symlink"
        );
        assert!(
            !would_be_created.exists(),
            "the temp write CREATED a file through a dangling symlink"
        );
        assert_eq!(
            std::fs::read_to_string(&linked).expect("readable"),
            "untouched by the hard link",
            "the temp write truncated a planted hard link's target"
        );
        // Each planted name is left exactly as it was — not removed, not replaced.
        assert!(std::fs::symlink_metadata(&sym)
            .expect("lstat")
            .file_type()
            .is_symlink());
        assert!(std::fs::symlink_metadata(&dangling)
            .expect("lstat")
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::metadata(&linked).expect("stat").nlink(), 2);
        assert!(!fresh.exists(), "the fresh temp was not renamed into place");
    }

    /// Every name taken: the replace gives up after [`TEMP_ATTEMPTS`] names, writes nothing, and
    /// leaves the target and every planted name as they were.
    #[test]
    fn every_name_taken_gives_up_and_writes_nothing() {
        let scratch = ScratchDir::new("autostart-temp-full");
        let dir = scratch.join("LaunchAgents");
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("Daily Briefing.plist");
        std::fs::write(&path, "old").expect("planted");
        let victim = scratch.join("victim");
        std::fs::write(&victim, "untouched").expect("victim");
        let planted: Vec<PathBuf> = (0..TEMP_ATTEMPTS)
            .map(|i| {
                let name = dir.join(format!("Daily Briefing.plist.tmp-planted-{i}"));
                std::os::unix::fs::symlink(&victim, &name).expect("symlink");
                name
            })
            .collect();
        let mut names = planted.clone().into_iter();
        let err = replace_atomically_via(&path, b"new bytes", || {
            names
                .next()
                .expect("asked for more than TEMP_ATTEMPTS temp names")
        })
        .expect_err("every name was taken");
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).expect("readable"), "old");
        assert_eq!(
            std::fs::read_to_string(&victim).expect("readable"),
            "untouched"
        );
        for name in &planted {
            assert!(std::fs::symlink_metadata(name)
                .expect("lstat")
                .file_type()
                .is_symlink());
        }
    }
}

#[cfg(target_os = "macos")]
mod branding {
    use super::temp_files::{mode, mode_lock};
    use super::*;
    use daily_briefing_gui_lib::autostart::{
        brand_launch_agent, ASSOCIATED_BUNDLE_IDENTIFIERS, MAX_PLIST_BYTES, REPLACED_MODE,
    };
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    const BUNDLE_ID: &str = "com.themarigold.daily-briefing";
    const PROGRAM: &str = "/Applications/Daily Briefing.app/Contents/MacOS/daily-briefing-gui";

    /// Sets the process umask for its lifetime and restores the previous one on drop — on a
    /// failing assertion too.
    struct Umask(libc::mode_t);

    impl Umask {
        fn set(mask: libc::mode_t) -> Self {
            // SAFETY: `umask` only swaps the process's mask; it has no memory-safety preconditions.
            Self(unsafe { libc::umask(mask) })
        }
    }

    impl Drop for Umask {
        fn drop(&mut self) {
            // SAFETY: as above.
            unsafe { libc::umask(self.0) };
        }
    }

    /// The process umask, read the only way POSIX offers: set it, then put it back.
    fn current_umask() -> libc::mode_t {
        Umask::set(0o022).0 // the temporary guard drops before this returns, restoring the mask
    }

    /// BYTE FOR BYTE what `auto-launch 0.5.0` writes in LaunchAgent mode
    /// (`auto-launch-0.5.0/src/macos.rs`, `enable`'s `format!`) for `app_name = "Daily Briefing"`,
    /// `app_path = PROGRAM` and no args — `tauri-plugin-autostart 2.5.1` registered with `None`.
    /// A FIXTURE, not a live read: the real `enable()` writes `~/Library/LaunchAgents`.
    fn plugin_plist(label: &str) -> String {
        format!(
            "{}\n{}\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>{}</string>\n  \
             <key>ProgramArguments</key>\n  <array>{}</array>\n  <key>RunAtLoad</key>\n  <true/>\n  \
             </dict>\n</plist>",
            r#"<?xml version="1.0" encoding="UTF-8"?>"#,
            r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#,
            label,
            format!("<string>{PROGRAM}</string>"),
        )
    }

    fn parsed(path: &std::path::Path) -> plist::Dictionary {
        plist::Value::from_file(path)
            .expect("the branded file is a property list")
            .into_dictionary()
            .expect("a dictionary")
    }

    /// The key is ADDED with the bundle id, and every key the plugin wrote survives unchanged —
    /// which is what keeps the plugin's own `is_enabled()` (a stat) and `disable()` (a remove)
    /// working, and the label test's premise true. Idempotent.
    #[test]
    fn branding_adds_the_bundle_id_and_keeps_every_plugin_key() {
        let scratch = ScratchDir::new("autostart-brand");
        let agents = scratch.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).expect("agents dir");
        let path = launch_agent_plist(&scratch.path, "Daily Briefing");
        std::fs::write(&path, plugin_plist("Daily Briefing")).expect("planted");
        // PREMISE: the fixture parses, and carries no branding yet.
        assert!(parsed(&path).get(ASSOCIATED_BUNDLE_IDENTIFIERS).is_none());

        brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).expect("branded");
        let d = parsed(&path);
        assert_eq!(
            d.get(ASSOCIATED_BUNDLE_IDENTIFIERS),
            Some(&plist::Value::Array(vec![plist::Value::String(
                BUNDLE_ID.into()
            )])),
            "the login item is not attributed to the app's bundle id"
        );
        assert_eq!(
            d.get("Label").and_then(plist::Value::as_string),
            Some("Daily Briefing")
        );
        assert_eq!(
            d.get("ProgramArguments"),
            Some(&plist::Value::Array(vec![plist::Value::String(
                PROGRAM.into()
            )]))
        );
        assert_eq!(
            d.get("RunAtLoad").and_then(plist::Value::as_boolean),
            Some(true)
        );
        let keys: Vec<&str> = d.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "Label",
                "ProgramArguments",
                "RunAtLoad",
                ASSOCIATED_BUNDLE_IDENTIFIERS
            ],
            "the branding added or dropped a key"
        );

        let once = std::fs::read(&path).expect("readable");
        brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).expect("re-branded");
        assert_eq!(
            std::fs::read(&path).expect("readable"),
            once,
            "branding is not idempotent"
        );
        // The atomic replace leaves no temp file behind in the agents directory.
        let names: Vec<String> = std::fs::read_dir(&agents)
            .expect("listable")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["Daily Briefing.plist"]);
    }

    /// It rewrites ONLY this app's plist: a missing file is an error (nothing is created), and a
    /// plist whose Label is not this app's, or a symlink, is refused and left byte-identical.
    #[test]
    fn branding_refuses_anything_but_this_apps_plist() {
        let scratch = ScratchDir::new("autostart-brand-refuse");
        let agents = scratch.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).expect("agents dir");
        let path = launch_agent_plist(&scratch.path, "Daily Briefing");

        assert!(brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).is_err());
        assert!(!path.exists(), "branding a missing plist created one");

        let foreign = plugin_plist("local.daily-briefing");
        std::fs::write(&path, &foreign).expect("planted");
        let err = brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID)
            .expect_err("a foreign Label must be refused");
        assert!(err.contains("not this app's login item"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).expect("readable"), foreign);

        std::fs::remove_file(&path).expect("removed");
        let target = scratch.join("elsewhere.plist");
        std::fs::write(&target, plugin_plist("Daily Briefing")).expect("planted");
        std::os::unix::fs::symlink(&target, &path).expect("symlinked");
        assert!(brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).is_err());
        assert_eq!(
            std::fs::read_to_string(&target).expect("readable"),
            plugin_plist("Daily Briefing"),
            "branding followed a symlink and rewrote its target"
        );
    }

    /// The other refusals the doc comment names (Phase E M5b checkpoint): a HARD-LINKED plist (a
    /// rename would detach the other name), an OVERSIZED one, and a BINARY property list (the
    /// plugin writes XML; anything else is not the file it wrote) — each refused with the file
    /// left byte-identical. The real ON logs a refusal and keeps the plugin's login item
    /// (`enable_via_plugin`'s `eprintln!`, a source the pin above holds).
    #[test]
    fn branding_refuses_a_hard_link_an_oversized_file_and_a_binary_plist() {
        let scratch = ScratchDir::new("autostart-brand-refuse-2");
        let agents = scratch.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).expect("agents dir");
        let path = launch_agent_plist(&scratch.path, "Daily Briefing");

        // A hard link: refused, both names keep the plugin's bytes, the link survives.
        std::fs::write(&path, plugin_plist("Daily Briefing")).expect("planted");
        let other = scratch.join("other-name.plist");
        std::fs::hard_link(&path, &other).expect("hard link");
        let err = brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID)
            .expect_err("a hard-linked plist must be refused");
        assert!(!err.is_empty());
        assert_eq!(
            std::fs::read_to_string(&path).expect("readable"),
            plugin_plist("Daily Briefing")
        );
        assert_eq!(
            std::fs::read_to_string(&other).expect("readable"),
            plugin_plist("Daily Briefing")
        );
        assert_eq!(std::fs::metadata(&path).expect("stat").nlink(), 2);
        std::fs::remove_file(&other).expect("unlinked");

        // Oversized: a valid plist of this app's, padded past the cap with an XML comment.
        let padded = plugin_plist("Daily Briefing").replace(
            "<plist version=\"1.0\">",
            &format!(
                "<!-- {} -->\n<plist version=\"1.0\">",
                "x".repeat(MAX_PLIST_BYTES as usize)
            ),
        );
        // PREMISE: still this app's plist in every respect but its size.
        assert!(plist::Value::from_reader_xml(padded.as_bytes()).is_ok());
        assert!(padded.len() as u64 > MAX_PLIST_BYTES);
        std::fs::write(&path, &padded).expect("planted");
        assert!(brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).is_err());
        assert_eq!(std::fs::read_to_string(&path).expect("readable"), padded);

        // A BINARY plist carrying this app's Label: refused, bytes unchanged.
        let mut dict = plist::Dictionary::new();
        dict.insert(
            "Label".into(),
            plist::Value::String("Daily Briefing".into()),
        );
        dict.insert(
            "ProgramArguments".into(),
            plist::Value::Array(vec![plist::Value::String(PROGRAM.into())]),
        );
        dict.insert("RunAtLoad".into(), plist::Value::Boolean(true));
        std::fs::remove_file(&path).expect("removed");
        plist::Value::Dictionary(dict)
            .to_file_binary(&path)
            .expect("a binary plist");
        let binary = std::fs::read(&path).expect("readable");
        assert!(
            binary.starts_with(b"bplist00"),
            "PREMISE: the fixture is a binary plist"
        );
        assert!(brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).is_err());
        assert_eq!(std::fs::read(&path).expect("readable"), binary);
    }

    /// The branded plist ends mode [`REPLACED_MODE`] (0644) whatever mode the plugin's file had —
    /// set explicitly on the temp before the rename, not inherited from the umask (Phase E M5b
    /// checkpoint; measured before the fix: the rewrite took the umask's mode).
    #[test]
    fn the_branded_plist_is_mode_0644() {
        let _serial = mode_lock();
        let scratch = ScratchDir::new("autostart-brand-mode");
        let agents = scratch.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).expect("agents dir");
        let path = launch_agent_plist(&scratch.path, "Daily Briefing");
        std::fs::write(&path, plugin_plist("Daily Briefing")).expect("planted");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).expect("branded");
        assert_eq!(REPLACED_MODE, 0o644);
        assert_eq!(
            std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777,
            0o644,
            "the branded login item's mode is not 0644"
        );
    }

    /// The same, under umask 077 (Phase E M5b fix round 2). Under the usual 022 a temp writer that
    /// took its mode from the umask — a `create_new` open that never sets one — ALSO lands on 0644,
    /// so the test above cannot tell an explicit mode from an inherited one. Under 077 an inherited
    /// mode is 0600, and only the explicit [`REPLACED_MODE`] passes.
    #[test]
    fn the_branded_plist_is_mode_0644_under_a_restrictive_umask() {
        let _serial = mode_lock();
        let scratch = ScratchDir::new("autostart-brand-umask");
        let agents = scratch.join("Library").join("LaunchAgents");
        std::fs::create_dir_all(&agents).expect("agents dir");
        let path = launch_agent_plist(&scratch.path, "Daily Briefing");
        std::fs::write(&path, plugin_plist("Daily Briefing")).expect("planted");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        let before = current_umask();
        let (premise, branded) = {
            let _mask = Umask::set(0o077);
            // prove-it 3b: the mask is in force — a file created the ordinary way gets 0600.
            let probe = scratch.join("umask-probe");
            std::fs::write(&probe, "x").expect("probe");
            brand_launch_agent(&path, "Daily Briefing", BUNDLE_ID).expect("branded");
            (mode(&probe), mode(&path))
        };
        assert_eq!(premise, 0o600, "PREMISE: umask 077 was not in force");
        assert_eq!(
            branded, REPLACED_MODE,
            "the branded login item took its mode from the umask, not REPLACED_MODE"
        );
        assert_eq!(current_umask(), before, "the umask was not restored");
    }
}

/* ── THE LABEL TEST (appendix, binding) ───────────────────────────────────────────────────────── */

/// The autostart plist's label must NOT collide with the CLI scheduler's launchd label — a
/// collision would have the login item and the scheduler fighting over one label in the same
/// domain, and `docs/gui-seam.md` §3's exact-match discipline would then unload the wrong agent.
///
/// The two sides, each read from its real source AT TEST TIME so a change to either goes red:
///
///   * **The scheduler's label** is parsed out of `src/schedule/units.ts`'s
///     `SCHEDULE_LABEL = "local.daily-briefing"` — the engine's one definition (§3: every match
///     is exact).
///   * **The autostart label** is what the plugin derives: `tauri-plugin-autostart 2.5.1` builds
///     `AutoLaunch` with `app_name` defaulting to `app.package_info().name`
///     (`src/lib.rs`, `Builder::build`'s setup — no override is passed, which the source pin
///     below enforces), tauri's codegen sets that to `tauri.conf.json`'s `productName`
///     (`tauri-codegen-2.6.3/src/context.rs:268-271`), and `auto-launch 0.5.0` uses the string as
///     BOTH the plist `Label` and the file name `~/Library/LaunchAgents/{app_name}.plist`
///     (`src/macos.rs`, `enable`/`get_file`). `package_info().name` is read off the BUILT
///     context here — the actual derivation input, not a re-spelling.
///
/// The plugin-internal steps are constants of the two version-pinned crates; a version bump that
/// changes them must revisit this test (`Cargo.toml` pins both).
#[test]
fn the_autostart_label_cannot_collide_with_the_schedulers() {
    // The engine's side, from its source.
    let units = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/schedule/units.ts"),
    )
    .expect("src/schedule/units.ts is readable");
    let label_line = units
        .lines()
        .find(|l| l.contains("export const SCHEDULE_LABEL"))
        .expect("units.ts defines SCHEDULE_LABEL");
    let scheduler_label = label_line
        .split('"')
        .nth(1)
        .expect("SCHEDULE_LABEL is a string literal");
    assert_eq!(
        scheduler_label, "local.daily-briefing",
        "the engine's scheduler label moved — re-check every exact-match consumer, and this test"
    );

    // The app's side, from the built context: the plugin's default `app_name`.
    let app = mock_app(None);
    let autostart_label = app.package_info().name.clone();
    assert!(
        !autostart_label.is_empty(),
        "package_info().name is empty; the plugin would derive an empty label"
    );

    // The labels are distinct (launchd labels are case-sensitive — this compare stays exact),
    // and so are the plist FILE names in the one shared directory — compared CASE-INSENSITIVELY,
    // because ~/Library/LaunchAgents sits on APFS, which is case-insensitive by default: two
    // names differing only in case would be ONE file there (round 1, mutant M2c).
    assert_ne!(
        autostart_label, scheduler_label,
        "the autostart label collides with the scheduler's launchd label"
    );
    assert_ne!(
        format!("{autostart_label}.plist").to_lowercase(),
        format!("{scheduler_label}.plist").to_lowercase(),
        "the two plists would be one file in ~/Library/LaunchAgents (APFS is case-insensitive)"
    );
    // And not a near-miss the §3 exact-match discipline exists for: neither name may be a prefix
    // of the other, or a sloppy future glob would match both.
    assert!(
        !autostart_label.starts_with(scheduler_label)
            && !scheduler_label.starts_with(&autostart_label),
        "{autostart_label:?} vs {scheduler_label:?}: one is a prefix of the other"
    );
}

/// The source pins that keep the derivation above the REAL one:
///   * `lib.rs` registers the autostart plugin with `MacosLauncher::LaunchAgent` (the plist mode
///     the label test reasons about — AppleScript mode has no plist at all);
///   * no `.app_name(…)` override and no `Builder` form is used, so the plugin's default
///     (`package_info().name`) is what ships;
///   * (Phase E M5b) `lib.rs`'s setup registers NO login item — the B7 one-shot is gone; the
///     default-ON lives in the wizard's last step. Pinned by the separate
///     `nothing_registers_a_login_item_at_launch` below, which reads the setup closure itself.
#[test]
fn lib_rs_registers_the_plugin_with_the_default_name() {
    let raw = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .expect("src/lib.rs is readable");
    // ⚠ CODE ONLY — the comments in lib.rs QUOTE the tokens pinned below (`.app_name(…)` is named
    // in the registration's own comment), so a raw `contains` goes red on the documentation of
    // the rule it enforces. A line-wise `//` strip suffices for these pins: none of the tokens
    // can appear inside a string literal in that file, and lib.rs has no block comments around
    // the registration. (`tests/shell.rs`'s `code_only` is the full lexer, for pins where a
    // literal could open a false comment.)
    let lib: String = raw
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        lib.contains("tauri_plugin_autostart::init("),
        "lib.rs no longer registers the autostart plugin via init()"
    );
    assert!(
        lib.contains("MacosLauncher::LaunchAgent"),
        "the launcher is no longer the LaunchAgent — the label test's premise is gone"
    );
    assert!(
        !lib.contains(".app_name("),
        "an app_name override changes the derived label; update the label test DELIBERATELY"
    );
    assert!(
        !lib.contains("tauri_plugin_autostart::Builder"),
        "the Builder form can carry an app_name; the label test pins the init() default"
    );
    // ⚠ THE THIRD PLIST INPUT — the plugin's `args` — IS PINNED TO `None` (round 1, mutant M6:
    // `Some(vec!["--from-autostart"])` left the whole suite green). `auto-launch 0.5.0` writes
    // `ProgramArguments = [app_path] + args` (`src/macos.rs`), so args are launch-time argv the
    // capability README's safety sentence depends on being empty; nothing else pinned them.
    // Whitespace-stripped so a formatting change cannot fake a diff.
    let stripped: String = lib.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(
        stripped.contains(
            "tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent,None,)"
        ) || stripped.contains(
            "tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent,None)"
        ),
        "the autostart plugin is no longer registered with `args: None` — any argv here lands \
         verbatim in the login item's ProgramArguments; change it DELIBERATELY, with a grant-level \
         justification in capabilities/README.md and an update to this pin"
    );
}

/// Dev 117's T25 removal list names `~/Library/LaunchAgents/Daily Briefing.plist` as a LITERAL,
/// and the label test above derives the name from the built context — so a `productName` change
/// would silently strand the register's string. This pins the conf value the derivation starts
/// from (round 1, lens 3): change `productName` and this names every place that must move.
#[test]
fn the_product_name_the_register_hardcodes_is_pinned() {
    let conf =
        std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"))
            .expect("tauri.conf.json is readable");
    let conf: serde_json::Value = serde_json::from_str(&conf).expect("tauri.conf.json is JSON");
    assert_eq!(
        conf["productName"].as_str(),
        Some("Daily Briefing"),
        "productName moved: update docs/gui-seam.md dev 116/117 (the T25 removal list hardcodes \
         `Daily Briefing.plist`), capabilities/README.md, and the label test's reasoning together"
    );
}
