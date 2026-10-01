//! T19 — autostart: the default-ON one-shot, and THE LABEL TEST.
//!
//! Nothing in this file (or anywhere in the suite) calls the real `enable()` / `disable()` /
//! `is_enabled()`: on this machine those touch `~/Library/LaunchAgents` — the VM-gated legs
//! (`docs/gui-seam.md` §12c). The one-shot is driven through `common::RecordingAutostartSink`,
//! and the label question is answered from the SOURCES both sides derive from.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{RecordingAutostartSink, ScratchDir};
use daily_briefing_gui_lib::autostart::{
    read_record, should_apply_default, startup, write_record, AutostartRecord, AutostartState,
};
use tauri::test::{mock_builder, MockRuntime};
use tauri::App;

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

/* ── the rule, and the one-shot ───────────────────────────────────────────────────────────────── */

/// The whole rule: apply the default exactly while no record says it was applied. The record —
/// never the plist — is the input, so the one-shot can NEVER re-enable over a user who turned
/// autostart off (their choice removed the plist, not the record).
#[test]
fn the_default_applies_exactly_while_unrecorded() {
    assert!(should_apply_default(&AutostartRecord::default()));
    assert!(should_apply_default(&AutostartRecord { defaulted: false }));
    assert!(!should_apply_default(&AutostartRecord { defaulted: true }));
}

/// First launch: one `enable()` through the sink, and the record is written. Every later launch:
/// zero calls.
#[test]
fn the_first_launch_enables_once_and_later_launches_do_nothing() {
    let scratch = ScratchDir::new("autostart-oneshot");
    let store = scratch.join("app-data");
    let sink = Arc::new(RecordingAutostartSink::default());
    let app = mock_app(Some(
        AutostartState::default()
            .with_sink(sink.clone())
            .with_store_dir(&store),
    ));
    startup(app.handle());
    assert_eq!(
        sink.enables(),
        1,
        "the first launch must enable exactly once"
    );
    assert_eq!(read_record(&store), AutostartRecord { defaulted: true });

    // The same app launching again (a fresh state over the same store): no further call.
    let sink2 = Arc::new(RecordingAutostartSink::default());
    let app2 = mock_app(Some(
        AutostartState::default()
            .with_sink(sink2.clone())
            .with_store_dir(&store),
    ));
    startup(app2.handle());
    assert_eq!(sink2.enables(), 0, "a recorded default re-applied itself");
}

/// A FAILED enable is not recorded — the next launch retries — and an app that manages no
/// `AutostartState` (every pre-B7 fixture) is a no-op.
#[test]
fn a_failed_enable_retries_next_launch_and_an_unmanaged_app_is_a_no_op() {
    let scratch = ScratchDir::new("autostart-fail");
    let store = scratch.join("app-data");
    let sink = Arc::new(RecordingAutostartSink::failing("no launch agent dir"));
    let app = mock_app(Some(
        AutostartState::default()
            .with_sink(sink.clone())
            .with_store_dir(&store),
    ));
    startup(app.handle());
    assert_eq!(sink.enables(), 1);
    assert_eq!(
        read_record(&store),
        AutostartRecord::default(),
        "a failed enable must not be recorded as applied"
    );
    // Retried on the next launch.
    let sink2 = Arc::new(RecordingAutostartSink::default());
    let app2 = mock_app(Some(
        AutostartState::default()
            .with_sink(sink2.clone())
            .with_store_dir(&store),
    ));
    startup(app2.handle());
    assert_eq!(sink2.enables(), 1);
    assert_eq!(read_record(&store), AutostartRecord { defaulted: true });

    // No managed state at all: nothing happens, nothing panics.
    startup(mock_app(None).handle());
}

/// The record round-trips; ABSENT reads as "not yet defaulted"; PRESENT-BUT-UNUSABLE fails
/// toward the user's last known choice (`defaulted: true`), never toward re-applying the
/// default. ⚠ ROUND 1 FIX: this test used to PIN the wrong direction (garbage → `Default`),
/// which is exactly the record-loss re-enable — a corrupt or truncated record re-firing the
/// one-shot over a user's recorded OFF (module header; dev 114 as amended).
#[test]
fn the_record_round_trips_and_degrades_safely() {
    let scratch = ScratchDir::new("autostart-record");
    let dir = scratch.join("app-data");
    // Absent: a genuine first launch — the one-shot applies.
    assert_eq!(read_record(&dir), AutostartRecord::default());
    write_record(&dir, &AutostartRecord { defaulted: true }).expect("written");
    assert_eq!(read_record(&dir), AutostartRecord { defaulted: true });
    // Present but unparseable: something WAS there, so the one-shot has run before — fail
    // toward the last known choice, not toward a fresh enable().
    std::fs::write(dir.join("autostart-state.json"), "{ nope").expect("clobbered");
    assert_eq!(
        read_record(&dir),
        AutostartRecord { defaulted: true },
        "a corrupt record must not read as \"apply the default again\""
    );
}

/// The record-loss probe (round 1, lens 2's P1 shape): a PRESENT-but-corrupt record must not
/// re-fire the one-shot — zero `enable()` calls through the sink, and the record is left for
/// the user's toggle rather than rewritten as freshly defaulted.
#[test]
fn a_corrupt_record_never_reenables_autostart() {
    let scratch = ScratchDir::new("autostart-corrupt");
    let store = scratch.join("app-data");
    std::fs::create_dir_all(&store).expect("store dir");
    // The truncated/clobbered record a crash mid-write (or disk trouble) leaves behind — the
    // user may have turned autostart OFF since the one-shot ran, and their plist is deleted.
    std::fs::write(store.join("autostart-state.json"), "{\"defaul").expect("clobbered");
    let sink = Arc::new(RecordingAutostartSink::default());
    let app = mock_app(Some(
        AutostartState::default()
            .with_sink(sink.clone())
            .with_store_dir(&store),
    ));
    startup(app.handle());
    assert_eq!(
        sink.enables(),
        0,
        "a corrupt record re-created a login item the user may have deleted"
    );
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
///   * `lib.rs` calls `autostart::startup` (the one-shot) from setup.
#[test]
fn lib_rs_registers_the_plugin_with_the_default_name_and_the_one_shot() {
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
    assert!(
        lib.contains("autostart::startup(app.handle())"),
        "the default-ON one-shot is no longer called from setup"
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
