//! T11 — the app shell, asserted where it can be: the pure derivations, the quit sequence and the
//! close/menu wiring on a MockRuntime app, the committed assets, and the wiring as written in
//! `src/lib.rs`.
//!
//! ## What IS driven headless, and how
//!
//!   * **The quit sequence**, end to end over one app's `ShellState`: a cold `app_quit` refuses;
//!     the tray's (or the app menu's) Quit shows the notice exactly once; `app_quit` then REACHES
//!     `AppHandle::exit`; a second Quit exits without a second notice. "Reaches exit" is observable
//!     because MockRuntime's `request_exit` is `unimplemented!()` — the panic is caught and its
//!     message read (the `not implemented` panic text in this binary's output is that, and expected).
//!   * **Closing the window**, through the SAME run-loop callback `lib.rs` installs: MockRuntime's
//!     `App::run` raises `CloseRequested` for `window.close()` and honours `prevent_close`.
//!   * **Menu routing** (Run Now, Open Briefing, the settings items) and `open_today`, observed as
//!     the events a Rust-side listener receives.
//!   * **The one-time tray-unavailable notice**, through real IPC, and the watcher start RETRYING
//!     after failed engine reads.
//!   * **The Quit notice's wording for the last announced state**, and that the latch is set BEFORE
//!     the notice is emitted (a Rust listener runs inside `emit`) — as are the state the notice is
//!     worded from and the stopped-watcher notice, before `state:changed` goes out.
//!   * **A refresh after the watcher stopped**: `state_snapshot`, through real IPC, still says live
//!     updates have stopped.
//!   * **The delivery clock time in a fixed zone**, in child processes with `TZ` set.
//!
//! ## What still is NOT, stated rather than quietly skipped
//!
//!   * **Whether a hidden window is hidden / a shown one shown** — MockRuntime's `show`/`hide` are
//!     no-ops and `is_visible` is constantly `true`. So "close HIDES" is pinned as the decision
//!     (`close_action`, `after_tray_build`) AND as source (the close arm calls `hide_main`, which
//!     calls `hide`); "Reopen SHOWS" has no decision function and is pinned as source ONLY (the arm
//!     calls `focus_main`, which calls `show`, and the arm is compiled on macOS). Every source pin
//!     strips `//` and `/* */` comments first.
//!   * **macOS `RunEvent::Reopen` itself** — the variant is `#[non_exhaustive]`, so a test outside
//!     tauri cannot construct it.
//!   * **The tray and the app menu as native objects** — `muda` builds them on the main thread
//!     through the event loop; their SHAPE is pinned as data (`tray_menu_items`, `app_menu_spec`)
//!     and the tray's label update as the pure `tray_status_line`.
//!   * **A second launch focusing the first** — `tauri-plugin-single-instance` takes an OS-level
//!     lock in its setup hook, so it needs two processes.
//!   * **The tray icon rendering as a template image** — a rendered menu bar is the only oracle.

mod common;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{appending_ipc_sidecar, fake_sidecar, state_sidecar, ScratchDir};
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use daily_briefing_gui_lib::schedule_state::{
    derive, local_hhmm_from_iso, now_local, utc_civil, LastSkip, MorningTime, Now, Phase,
    ScheduleState, ScheduleView, StatusView, TickLine,
};
use daily_briefing_gui_lib::shell::{
    self, after_tray_build, app_menu_spec, catch_tray_build, close_action, quit_action,
    quit_dialog, tray_click_route, tray_menu_items, tray_status_line, tray_unavailable_notice,
    AppMenuEntry, AppState, CloseAction, EngineSnapshots, QuitAction, QuitCopy, RetryPolicy,
    ShellState, APP_MENU_QUIT, ENGINE_HAS_NOTIFY_FIELD, ENGINE_READ_TIMEOUT, EVENT_NAVIGATE,
    EVENT_QUIT_REQUESTED, EVENT_RUN_NOW, EVENT_STATE_CHANGED, EVENT_TRAY_UNAVAILABLE,
    MENU_OPEN_BRIEFING, MENU_QUIT, MENU_RUN_NOW, MENU_SCHEDULE_SETTINGS, MENU_SETTINGS,
    MENU_STATUS, QUIT_ACCELERATOR, STATUS_ENGINE_ERROR, STATUS_UNKNOWN, STATUS_UPDATES_STOPPED,
};
use daily_briefing_gui_lib::watcher::{Snapshot, StateSink, StateWatcher};
use tauri::menu::{MenuEvent, MenuId, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::{App, AppHandle, Listener, Manager, RunEvent, WebviewWindowBuilder};

/* ── fixtures: one ScheduleState per phase, built by the REAL machine ─────────────────────────── */

const TODAY: &str = "2026-09-16";

fn now() -> Now {
    Now {
        local_date: TODAY.into(),
        minutes: 9 * 60 + 10,
        epoch_secs: 1_789_575_000, // 2026-09-16T16:10:00Z
    }
}

fn status() -> StatusView {
    StatusView {
        engine_version: Some("0.1.1".into()),
        config_exists: true,
        morning_time: MorningTime {
            value: "07:20".into(),
            minutes: 440,
            warning: None,
        },
        ..Default::default()
    }
}

fn schedule() -> ScheduleView {
    ScheduleView {
        registered: Some(true),
        record_present: true,
        unit_present: true,
        owner: Some("app".into()),
        last_tick_state: Some("ok".into()),
        ticks_today: Some(11),
        interval_sec: Some(600),
        ..Default::default()
    }
}

fn recent_tick() -> TickLine {
    TickLine {
        iso: "2026-09-16T16:05:00.000Z".into(),
        local_date: TODAY.into(),
        count: 11,
    }
}

/// Every phase the tray has to be able to say something about, each produced by `derive` rather
/// than constructed by hand — so a change to the machine cannot leave this list describing states
/// it no longer produces.
fn one_per_phase() -> Vec<(&'static str, ScheduleState)> {
    let skip = |reason: &str| LastSkip {
        iso: format!("{TODAY}T16:00:00.000Z"),
        local_date: TODAY.into(),
        reason: reason.into(),
        detail: Some("the engine's own line".into()),
    };
    vec![
        (
            "not-configured",
            derive(
                &StatusView {
                    config_exists: false,
                    ..status()
                },
                None,
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "config-error",
            derive(
                &StatusView {
                    config_error: Some("bad json".into()),
                    ..status()
                },
                None,
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "scheduler-broken",
            derive(
                &status(),
                None,
                Some(&ScheduleView {
                    registered: Some(false),
                    ..schedule()
                }),
                &now(),
            ),
        ),
        (
            "not-scheduled",
            derive(
                &status(),
                None,
                Some(&ScheduleView {
                    record_present: false,
                    ..schedule()
                }),
                &now(),
            ),
        ),
        (
            "delivered",
            derive(
                &StatusView {
                    last_run_date: Some(TODAY.into()),
                    latest_briefing_mtime: Some("2026-09-16T14:24:00.000Z".into()),
                    ..status()
                },
                None,
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "waiting-for-floor",
            derive(
                &StatusView {
                    last_tick: Some(recent_tick()),
                    ..status()
                },
                None,
                Some(&schedule()),
                &Now {
                    minutes: 6 * 60,
                    ..now()
                },
            ),
        ),
        (
            "waiting-for-wake",
            derive(
                &StatusView {
                    last_tick: Some(recent_tick()),
                    ..status()
                },
                None,
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "agent-stale",
            derive(
                &StatusView {
                    last_tick: Some(TickLine {
                        iso: "2026-09-16T00:00:00.000Z".into(),
                        local_date: "2026-09-15".into(),
                        count: 9,
                    }),
                    ..status()
                },
                None,
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "unknown-tick",
            derive(
                &status(),
                None,
                Some(&ScheduleView {
                    last_tick_state: Some("legacy".into()),
                    ticks_today: None,
                    ..schedule()
                }),
                &now(),
            ),
        ),
        (
            "skipped:offline",
            derive(
                &StatusView {
                    last_tick: Some(recent_tick()),
                    ..status()
                },
                Some(&skip("offline")),
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "skipped:limited",
            derive(
                &StatusView {
                    last_tick: Some(recent_tick()),
                    ..status()
                },
                Some(&skip("limited")),
                Some(&schedule()),
                &now(),
            ),
        ),
        (
            "skipped:unknown",
            derive(
                &StatusView {
                    last_tick: Some(recent_tick()),
                    ..status()
                },
                Some(&skip("solar-flare")),
                Some(&schedule()),
                &now(),
            ),
        ),
    ]
}

/* ── the menu ─────────────────────────────────────────────────────────────────────────────────── */

/// The menu's SHAPE is fixed and its status line is the T14 state. R1 removed the install button;
/// R6(U) removed "Check for Updates…".
#[test]
fn the_tray_menu_is_the_delegated_one() {
    let items = tray_menu_items(None);
    let ids: Vec<&str> = items.iter().map(|i| i.id).collect();
    assert_eq!(
        ids,
        vec![
            MENU_STATUS,
            MENU_OPEN_BRIEFING,
            MENU_RUN_NOW,
            MENU_SCHEDULE_SETTINGS,
            MENU_SETTINGS,
            MENU_QUIT,
        ],
        "the tray menu's items or their order changed"
    );

    // The status line is a readout, not an action.
    assert!(!items[0].enabled);
    assert_eq!(items[0].label, STATUS_UNKNOWN);
    for item in &items[1..] {
        assert!(item.enabled, "{} is disabled", item.id);
    }

    let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
    assert!(labels.contains(&"Schedule settings"), "{labels:?}");
    // ⚠ R1: the tray/app-owned INSTALL BUTTON is removed — install is reachable only through the
    // wizard or the Schedule & Access panel.
    for forbidden in ["Install", "install"] {
        assert!(
            !labels.iter().any(|l| l.contains(forbidden)),
            "the tray offers an install action again: {labels:?}"
        );
    }
    // ⚠ R6(U): the updater is excluded from 0.2.0. A menu item for a capability the build does not
    // have is a support ticket with a label on it.
    assert!(
        !labels.iter().any(|l| l.to_lowercase().contains("update")),
        "the tray offers an update check, which this build cannot perform: {labels:?}"
    );
}

/// Every phase produces a distinct, non-empty status line, and it comes from the SAME state object
/// the Schedule screen renders.
#[test]
fn the_status_line_is_derived_from_every_t14_state() {
    let mut lines: Vec<(String, String)> = Vec::new();
    for (what, state) in one_per_phase() {
        let items = tray_menu_items(Some(&state));
        assert_eq!(items.len(), tray_menu_items(None).len());
        let line = items[0].label.clone();
        assert!(!line.is_empty(), "{what} produced an empty status line");
        assert_eq!(
            line,
            state.tray_line(),
            "{what}: the menu composed its own status line instead of rendering the state's"
        );
        assert_ne!(
            line, STATUS_UNKNOWN,
            "{what} fell through to the not-yet-known line"
        );
        lines.push((what.to_string(), line));
    }

    // The four the appendix names by example must read as it says.
    let of = |what: &str| -> String {
        lines
            .iter()
            .find(|(w, _)| w == what)
            .map(|(_, l)| l.clone())
            .unwrap_or_else(|| panic!("no fixture for {what}"))
    };
    assert!(
        of("delivered").starts_with("Delivered"),
        "{}",
        of("delivered")
    );
    assert!(
        of("waiting-for-floor").starts_with("Waiting — first wake past 07:20"),
        "{}",
        of("waiting-for-floor")
    );
    assert_eq!(of("skipped:offline"), "Offline");
    assert_eq!(of("not-scheduled"), "Scheduler not installed");
    assert_eq!(of("scheduler-broken"), "Scheduler not loaded");
    assert_eq!(of("config-error"), "Config has an error");
    assert_eq!(of("unknown-tick"), "Heartbeat unreadable");
    // A reason this build has never heard of still gets a line, with the engine's word in it.
    assert!(
        of("skipped:unknown").contains("solar-flare"),
        "{}",
        of("skipped:unknown")
    );

    // Distinctness: a menu that said the same thing for every state would pass every assertion
    // above except this one.
    let mut distinct: Vec<String> = lines.iter().map(|(_, l)| l.clone()).collect();
    distinct.sort();
    distinct.dedup();
    assert!(
        distinct.len() >= 10,
        "only {} distinct status lines across {} phases: {lines:?}",
        distinct.len(),
        lines.len()
    );
}

/// The delivered line carries a LOCAL clock time, not the UTC instant the engine reports.
///
/// ⚠ PINNED IN CHILD PROCESSES WITH A FIXED `TZ`, because in-process it cannot fail: this machine's
/// zone is whatever it is, and a shape check ("five characters, a colon, four digits") passes for
/// a UTC clock time exactly as well as for a local one. Each child re-runs THIS test with `TZ` set
/// (POSIX offsets, so no zoneinfo file is needed) and checks the exact local time — so a
/// `localtime_r` replaced by `gmtime_r` fails three of the four zones.
#[test]
fn the_delivered_line_is_a_local_clock_time() {
    const INSTANT: &str = "2026-09-16T14:24:00.000Z";
    if let Ok(expected) = std::env::var("DBA_TZ_CHILD_EXPECT") {
        let offset_min: i64 = std::env::var("DBA_TZ_CHILD_OFFSET_MIN")
            .expect("the parent passes the offset")
            .parse()
            .expect("an integer offset");
        let state = derive(
            &StatusView {
                last_run_date: Some(TODAY.into()),
                latest_briefing_mtime: Some(INSTANT.into()),
                ..status()
            },
            None,
            Some(&schedule()),
            &now(),
        );
        assert!(matches!(state.phase, Phase::Delivered { .. }));
        assert_eq!(state.tray_line(), format!("Delivered {expected}"));
        assert_eq!(
            local_hhmm_from_iso(INSTANT).as_deref(),
            Some(expected.as_str())
        );
        // `now_local` uses the same conversion: its minutes and date are UTC shifted by the zone.
        let now = now_local();
        let shifted = utc_civil(now.epoch_secs + offset_min * 60);
        assert_eq!(now.minutes, shifted.hour * 60 + shifted.minute);
        assert_eq!(
            now.local_date,
            format!(
                "{:04}-{:02}-{:02}",
                shifted.year, shifted.month, shifted.day
            )
        );
        println!("DBA_TZ_CHILD_RAN {expected}");
        return;
    }

    let exe = std::env::current_exe().expect("the test binary's path");
    for (tz, expected, offset_min) in [
        ("UTC0", "14:24", 0),
        ("XST-12", "02:24", 720),
        ("YST7", "07:24", -420),
        ("ZST-5:30", "19:54", 330),
    ] {
        let out = std::process::Command::new(&exe)
            .args([
                "the_delivered_line_is_a_local_clock_time",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("TZ", tz)
            .env("DBA_TZ_CHILD_EXPECT", expected)
            .env("DBA_TZ_CHILD_OFFSET_MIN", offset_min.to_string())
            .output()
            .expect("the test binary re-runs itself");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success() && stdout.contains(&format!("DBA_TZ_CHILD_RAN {expected}")),
            "TZ={tz}: the delivered line is not {expected} local.\nstdout: {stdout}\nstderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // A missing mtime must not fabricate one.
    let no_mtime = derive(
        &StatusView {
            last_run_date: Some(TODAY.into()),
            ..status()
        },
        None,
        Some(&schedule()),
        &now(),
    );
    assert_eq!(no_mtime.tray_line(), "Delivered today");
}

/// The tray line for a SNAPSHOT: unknown before the first, the state's own line with one, and
/// "Engine unavailable" — never the previous state's line — when the engine could not be read.
#[test]
fn the_tray_line_says_so_when_the_engine_cannot_be_read() {
    assert_eq!(tray_status_line(None), STATUS_UNKNOWN);
    assert_eq!(
        tray_status_line(Some(&Snapshot::unavailable(
            "`status --json` failed: EACCES"
        ))),
        STATUS_ENGINE_ERROR
    );
    let state = one_per_phase()
        .into_iter()
        .find(|(what, _)| *what == "skipped:offline")
        .map(|(_, s)| s)
        .expect("fixture");
    let snapshot = Snapshot {
        status: Some(serde_json::json!({})),
        last_skip: None,
        schedule: None,
        schedule_stale: false,
        schedule_state: Some(state),
        error: None,
        updates_stopped: false,
    };
    assert_eq!(tray_status_line(Some(&snapshot)), "Offline");
    // ⚠ R2-16: once the watcher has stopped, the tray says so — whatever state it last held.
    let stopped = Snapshot::stopped(Some(&snapshot), "injected");
    assert_eq!(tray_status_line(Some(&stopped)), STATUS_UPDATES_STOPPED);
    assert!(stopped
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("injected"));
    assert_eq!(
        tray_status_line(Some(&Snapshot::stopped(None, "x"))),
        STATUS_UPDATES_STOPPED
    );
}

/// ⚠ R2-9: TRAY LEFT-CLICK (on release) OPENS TODAY; nothing else does. The handler in `build_tray`
/// is `tray_click_route` and nothing more (pinned from source below, since `muda`/`tray-icon` cannot
/// be built off the main thread).
#[test]
fn only_a_left_click_release_on_the_tray_opens_today() {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent, TrayIconId};
    use tauri::{PhysicalPosition, Rect};
    let click = |button, button_state| TrayIconEvent::Click {
        id: TrayIconId::new("main"),
        position: PhysicalPosition::new(0.0, 0.0),
        rect: Rect::default(),
        button,
        button_state,
    };
    assert_eq!(
        tray_click_route(&click(MouseButton::Left, MouseButtonState::Up)),
        Some("today")
    );
    for (button, state) in [
        (MouseButton::Left, MouseButtonState::Down),
        (MouseButton::Right, MouseButtonState::Up),
        (MouseButton::Right, MouseButtonState::Down),
        (MouseButton::Middle, MouseButtonState::Up),
    ] {
        assert_eq!(
            tray_click_route(&click(button, state)),
            None,
            "{button:?} {state:?}"
        );
    }
    let enter = TrayIconEvent::Enter {
        id: TrayIconId::new("main"),
        position: PhysicalPosition::new(0.0, 0.0),
        rect: Rect::default(),
    };
    assert_eq!(tray_click_route(&enter), None);

    let shell_rs = code_only(include_str!("../src/shell.rs"));
    let build = function_body(&shell_rs, "pub fn build_tray<");
    assert!(
        build.contains(
            ".on_tray_icon_event(|tray, event| {\n            if let Some(route) = tray_click_route(&event) {\n                show_route(tray.app_handle(), route);"
        ),
        "the tray's click handler no longer routes through `tray_click_route`:\n{build}"
    );
}

/* ── the Quit notice ──────────────────────────────────────────────────────────────────────────── */

/// `not-scheduled` with the unit legs set as given — the machine's own output, not a hand-built
/// phase.
fn not_scheduled(unit_present: bool, registered: Option<bool>) -> ScheduleState {
    let state = derive(
        &status(),
        None,
        Some(&ScheduleView {
            record_present: false,
            unit_present,
            registered,
            ..schedule()
        }),
        &now(),
    );
    assert_eq!(state.phase, Phase::NotScheduled, "fixture");
    state
}

/// Plan R1's delegated meaning — quitting does not stop briefings — worded so it is true whatever
/// the engine's `notify` is, plus the notify offer that replaced the appendix's "install the
/// background scheduler" button. ⚠ R2-11: and worded for the STATE — "the background scheduler keeps
/// generating them" only where one is there to do it, and nowhere a claim that the app notifies.
/// ⚠ Round 3: `not-scheduled` with a unit beside it is NOT "nothing is generating" — the Schedule
/// screen hedges there, and so does the notice.
#[test]
fn the_quit_copy_is_the_delegated_wording_for_each_state() {
    let states = one_per_phase();
    let state_of = |what: &str| -> ScheduleState {
        states
            .iter()
            .find(|(w, _)| *w == what)
            .map(|(_, s)| s.clone())
            .unwrap_or_else(|| panic!("no fixture for {what}"))
    };
    let keeps_generating = "the background scheduler keeps generating them";
    let nothing_generating = "Nothing is generating briefings";

    // Scheduled: every phase with an installed, loaded unit and a usable config.
    for what in [
        "delivered",
        "waiting-for-floor",
        "waiting-for-wake",
        "agent-stale",
        "unknown-tick",
        "skipped:offline",
        "skipped:limited",
        "skipped:unknown",
    ] {
        let state = state_of(what);
        assert_eq!(
            QuitCopy::for_state(Some(&state)),
            QuitCopy::Scheduled,
            "{what}"
        );
        let dialog = quit_dialog(Some(&state));
        // ⚠ REWORDED IN B7 (T11 rework): the app posts the arrival notification since T18 — behind
        // its own opt-in — so the body names that as what quitting stops, WITHOUT claiming the
        // opt-in is on ("any notification this app itself would post") and still without claiming
        // to know the engine's `notify` value. HEDGED in the B7 fix round (deviation 119): the
        // body no longer says being told "depends ONLY on" the engine's setting — the engine's
        // osascript banner may not post from a launchd agent at all, so the setup is named too.
        assert_eq!(
            dialog.body,
            "Quitting does not stop your briefings — the background scheduler keeps generating \
             them while this app is closed. What stops is any notification this app itself would \
             post when one arrives; whether you are told then depends on the engine's own \
             notification setting — and on whether your setup shows its banner — neither of which \
             quitting changes.",
            "{what}"
        );
        assert!(
            !dialog.body.contains("depends only on"),
            "{what}: the un-hedged promise is back (deviation 119): {}",
            dialog.body
        );
        assert!(
            !dialog.body.contains("does not post notifications"),
            "{what}: the pre-T18 claim is back: {}",
            dialog.body
        );
        assert_eq!(dialog.schedule_label, None, "{what}");
    }

    // Nothing scheduled: never "keeps generating", and the Schedule screen is offered.
    for (what, state) in [
        ("not-scheduled, no unit", not_scheduled(false, Some(false))),
        (
            "not-scheduled, no unit, registration unknown",
            not_scheduled(false, None),
        ),
        ("scheduler-broken", state_of("scheduler-broken")),
    ] {
        assert_eq!(
            QuitCopy::for_state(Some(&state)),
            QuitCopy::NothingScheduled,
            "{what}"
        );
        let dialog = quit_dialog(Some(&state));
        assert!(
            !dialog.body.contains(keeps_generating),
            "{what}: {}",
            dialog.body
        );
        assert!(
            dialog.body.contains(nothing_generating)
                && dialog.body.contains("quitting changes nothing about that")
                && dialog.body.contains("Schedule screen"),
            "{what}: {}",
            dialog.body
        );
        assert_eq!(
            dialog.schedule_label.as_deref(),
            Some("Open Schedule"),
            "{what}"
        );
    }

    // ⚠ Round 3: NO RECORD, BUT A UNIT IS THERE (present, registered, or both — `one_per_phase`'s
    // own `not-scheduled` is this case). Something may still fire it, so neither claim is made.
    for (what, state) in [
        ("unit present and registered", state_of("not-scheduled")),
        (
            "unit present, not registered",
            not_scheduled(true, Some(false)),
        ),
        (
            "unit present, registration unknown",
            not_scheduled(true, None),
        ),
        (
            "unit file gone, still registered",
            not_scheduled(false, Some(true)),
        ),
    ] {
        assert_eq!(
            QuitCopy::for_state(Some(&state)),
            QuitCopy::UnrecordedUnit,
            "{what}"
        );
        let dialog = quit_dialog(Some(&state));
        assert!(
            !dialog.body.contains(keeps_generating) && !dialog.body.contains(nothing_generating),
            "{what}: a unit with no record was worded as a certainty: {}",
            dialog.body
        );
        assert!(
            dialog.body.contains("no ownership record")
                && dialog
                    .body
                    .contains("cannot say whether briefings will keep arriving")
                && dialog.body.contains("Schedule screen"),
            "{what}: {}",
            dialog.body
        );
        assert_eq!(
            dialog.schedule_label.as_deref(),
            Some("Open Schedule"),
            "{what}"
        );
    }

    // No usable config: the scheduler may run, but it generates nothing.
    for what in ["not-configured", "config-error"] {
        let state = state_of(what);
        assert_eq!(
            QuitCopy::for_state(Some(&state)),
            QuitCopy::NoWorkingConfig,
            "{what}"
        );
        let dialog = quit_dialog(Some(&state));
        assert!(
            !dialog.body.contains(keeps_generating),
            "{what}: {}",
            dialog.body
        );
        assert!(
            dialog.body.contains("no usable config"),
            "{what}: {}",
            dialog.body
        );
        assert_eq!(
            dialog.schedule_label.as_deref(),
            Some("Open Schedule"),
            "{what}"
        );
    }

    // No state yet: no guess either way.
    assert_eq!(QuitCopy::for_state(None), QuitCopy::Unknown);
    let unknown = quit_dialog(None);
    assert!(!unknown.body.contains(keeps_generating), "{}", unknown.body);
    assert!(unknown.body.contains("cannot say"), "{}", unknown.body);
    assert_eq!(unknown.schedule_label.as_deref(), Some("Open Schedule"));

    for dialog in [
        quit_dialog(None),
        quit_dialog(Some(&state_of("delivered"))),
        quit_dialog(Some(&state_of("not-scheduled"))),
        quit_dialog(Some(&not_scheduled(false, Some(false)))),
        quit_dialog(Some(&state_of("config-error"))),
    ] {
        let lower = dialog.body.to_lowercase();
        // ⚠ THE FIRST PROMISE IS FALSE IN THE APP'S OWN DEFAULT: an `--invoker app` install leaves
        // engine notify "off" (src/notify.ts, plan T18), so nothing "comes from the system notifier".
        assert!(
            !lower.contains("system notifier") && !lower.contains("will come from"),
            "the Quit copy promises a notification the engine may never send: {}",
            dialog.body
        );
        // ⚠ RETIRED IN B7: the round-1 guard here refused "what stops is …" because the pre-T18
        // app posted nothing. T18 built the app's notifications, so the Scheduled body now names
        // them — CONDITIONALLY ("any notification this app itself WOULD post", pinned verbatim
        // above). What must still never appear is an unconditional promise that the app notifies:
        assert!(
            !lower.contains("this app will notify") && !lower.contains("you will be notified"),
            "the Quit copy promises a notification the opt-in may be withholding: {}",
            dialog.body
        );
        // ⚠ THE APPENDIX'S WORDING IS FALSE UNDER R1 AND MUST NOT COME BACK.
        assert!(
            !lower.contains("briefings will stop"),
            "the app-owned-tick warning is back: {}",
            dialog.body
        );
        assert!(dialog.offer_label.to_lowercase().contains("auto"));
        assert!(dialog.offer_label.to_lowercase().contains("notification"));
        assert!(!dialog.title.is_empty());
        assert!(!dialog.confirm_label.is_empty());
        assert!(!dialog.cancel_label.is_empty());
    }
}

/// A snapshot carrying `state` and nothing else of note.
fn snapshot_of(state: Option<ScheduleState>) -> Snapshot {
    Snapshot {
        status: Some(serde_json::json!({})),
        last_skip: None,
        schedule: None,
        schedule_stale: false,
        schedule_state: state,
        error: None,
        updates_stopped: false,
    }
}

/// ⚠ R2-11: THE NOTICE IS WORDED FOR THE STATE THE APP LAST ANNOUNCED. The shipping sink records
/// the state; the quit path reads it.
#[test]
fn the_quit_notice_is_worded_for_the_last_announced_state() {
    let delivered = one_per_phase()
        .into_iter()
        .find(|(w, _)| *w == "delivered")
        .map(|(_, s)| s)
        .expect("fixture");
    for (what, state, expected) in [
        (
            "not-scheduled, no unit",
            not_scheduled(false, Some(false)),
            QuitCopy::NothingScheduled,
        ),
        (
            "not-scheduled, a unit",
            not_scheduled(true, Some(true)),
            QuitCopy::UnrecordedUnit,
        ),
        ("delivered", delivered, QuitCopy::Scheduled),
    ] {
        let app = mock_app(ShellState::default());
        with_main_window(&app);
        let h = app.handle().clone();
        let notices = record(&h, EVENT_QUIT_REQUESTED);
        AppState::new(h.clone()).changed(&snapshot_of(Some(state.clone())));
        assert_eq!(
            h.state::<ShellState>().last_state(),
            Some(state.clone()),
            "{what}"
        );
        shell::on_menu_event(&h, menu(MENU_QUIT));
        let payload: serde_json::Value =
            serde_json::from_str(&notices.lock().unwrap()[0]).expect("JSON payload");
        let expected_body = quit_dialog(Some(&state)).body;
        assert_eq!(payload["body"], expected_body, "{what}");
        assert_eq!(QuitCopy::for_state(Some(&state)), expected, "{what}");
    }
}

/// The offer is TAKEABLE since B5 — wherever it can work — and says why wherever it cannot.
///
/// ⚠ THIS REPLACES B4's `the_notify_offer_states_why_it_cannot_be_taken_yet`, which pinned
/// `offer_available == false` for every state (deviation 12). B5 builds the write path
/// (`config_save::config_offer_notify_auto`, driven end to end in `tests/config_save.rs`), so the
/// deviation and that test retire together, as the test itself required. What is pinned now is the
/// TABLE, per state and per OS, through `quit_dialog_for` — never on the constants alone, which
/// would be the constant compared with itself (the B4 test's own measured lesson).
#[test]
fn the_notify_offer_is_takeable_exactly_where_it_can_work() {
    let delivered = one_per_phase()
        .into_iter()
        .find(|(w, _)| *w == "delivered")
        .map(|(_, s)| s)
        .expect("fixture");
    let not_configured = one_per_phase()
        .into_iter()
        .find(|(w, _)| *w == "not-configured")
        .map(|(_, s)| s)
        .expect("fixture");
    let cases: Vec<(&str, Option<ScheduleState>, bool)> = vec![
        ("delivered", Some(delivered.clone()), true),
        (
            "not-scheduled, no unit",
            Some(not_scheduled(false, Some(false))),
            true,
        ),
        (
            "not-scheduled, a unit",
            Some(not_scheduled(true, Some(true))),
            true,
        ),
        ("not-configured", Some(not_configured), false),
        ("no state yet", None, false),
    ];
    for os in ["macos", "linux", "windows"] {
        for (what, state, where_it_works) in &cases {
            let dialog = shell::quit_dialog_for(state.as_ref(), os);
            let expected = *where_it_works && os != "windows";
            assert_eq!(dialog.offer_available, expected, "{os} / {what}");
            match (&dialog.offer_unavailable_reason, expected) {
                (None, true) => {}
                (Some(reason), false) => {
                    assert!(!reason.is_empty(), "{os} / {what}");
                    if os == "windows" {
                        assert!(reason.contains("Windows"), "{os} / {what}: {reason}");
                    }
                    assert!(
                        !reason.to_lowercase().contains("next build"),
                        "{os} / {what}: the B4 stub wording is back: {reason}"
                    );
                }
                (reason, _) => panic!("{os} / {what}: available={expected} but reason={reason:?}"),
            }
        }
    }
    // `quit_dialog` is `quit_dialog_for` on this machine's OS.
    assert_eq!(
        quit_dialog(Some(&delivered)),
        shell::quit_dialog_for(Some(&delivered), std::env::consts::OS)
    );
    // prove-it 3b: the table is not vacuous — on this (non-Windows) host, a delivered state IS
    // offered, which B4's shipped value could never have produced.
    if std::env::consts::OS != "windows" {
        assert!(quit_dialog(Some(&delivered)).offer_available);
    }
}

/// ⚠ THE `notify`-FIELD CHECK THE STUB IS GATED ON, PINNED AGAINST THE ENGINE. If the engine ever
/// drops the field, `ENGINE_HAS_NOTIFY_FIELD` is a lie and the offer is advertising something that
/// cannot exist.
#[test]
fn the_engine_still_has_the_notify_field_the_offer_targets() {
    let types = include_str!("../../../src/types.ts");
    assert!(
        types.contains(r#"notify?: "off" | "auto" | { command: string[] };"#),
        "src/types.ts no longer declares the `notify` config field, so `shell::quit_dialog`'s \
         offer targets a field that does not exist. Either the offer goes or the constant does."
    );
    assert_eq!(
        ENGINE_HAS_NOTIFY_FIELD,
        types.contains("notify?:"),
        "`shell::ENGINE_HAS_NOTIFY_FIELD` and src/types.ts disagree about whether the engine has a \
         `notify` config field. The constant IS the check the Quit offer is stubbed behind."
    );
    // And the resolved-capability rule the offer rests on is still the engine's own
    // (`docs/gui-seam.md` §4): `notifyArgv` is what a GUI keys suppression on.
    assert!(
        include_str!("../../../src/notify.ts").contains("export function notifyArgv("),
        "src/notify.ts no longer exports `notifyArgv`, which is the predicate the notification \
         ownership rule (plan R1, T18) is defined in terms of."
    );
}

/// Appendix T11: *"Quit dialog appears exactly once per session."* The pure rule, and the latch
/// that applies it — in sequence, because a latch that is never SET makes the app unquittable from
/// the tray (every Quit shows the notice again, and `app_quit` keeps refusing).
#[test]
fn the_quit_notice_is_shown_once_per_session() {
    assert_eq!(quit_action(false), QuitAction::ShowNotice);
    assert_eq!(quit_action(true), QuitAction::ExitNow);

    let shell = ShellState::default();
    assert!(!shell.quit_notice_shown());
    assert_eq!(shell.request_quit(), QuitAction::ShowNotice);
    assert!(
        shell.quit_notice_shown(),
        "the notice went out and the latch was not set"
    );
    assert_eq!(shell.request_quit(), QuitAction::ExitNow);
    assert_eq!(shell.request_quit(), QuitAction::ExitNow);
}

/// Closing hides only where a tray is known to be there. Linux never hides: `tray-icon` cannot
/// tell a StatusNotifierItem host is missing, so "built" is not "visible" there.
#[test]
fn closing_hides_only_where_a_tray_is_known_to_exist() {
    for (tray_built, os, expected) in [
        (true, "macos", CloseAction::HideToTray),
        (true, "windows", CloseAction::HideToTray),
        (false, "macos", CloseAction::QuitFlow),
        (false, "windows", CloseAction::QuitFlow),
        (true, "linux", CloseAction::QuitFlow),
        (false, "linux", CloseAction::QuitFlow),
    ] {
        assert_eq!(close_action(tray_built, os), expected, "{tray_built} {os}");
    }
    // A fresh ShellState does not hide: until `setup` has built a tray, a close is a quit request.
    assert!(!ShellState::default().close_hides_to_tray());
    // And the tray-failure notice is delivered once.
    let shell = ShellState::default();
    shell.set_tray_notice(tray_unavailable_notice("no host"));
    let notice = shell.take_tray_notice().expect("a pending notice");
    assert!(
        notice.contains("no host") && notice.contains("quit"),
        "{notice}"
    );
    assert_eq!(shell.take_tray_notice(), None);
}

/// ⚠ R2-3: WHAT `setup` DOES WITH THE TRAY BUILD'S RESULT, PER PLATFORM. The hide-on-close flag
/// follows `close_action` for the platform it is given, and a failed build — only a failed build —
/// queues the one-time notice. `setup` passes `std::env::consts::OS` (pinned from source: on this
/// machine a literal "macos" would behave identically, so no behavioural test can see it).
#[test]
fn after_the_tray_build_the_close_flag_and_the_notice_follow_the_platform() {
    for (os, built, hides, notice) in [
        ("macos", Ok(()), true, false),
        ("windows", Ok(()), true, false),
        ("linux", Ok(()), false, false),
        ("macos", Err("no status bar"), false, true),
        ("windows", Err("no shell tray"), false, true),
        ("linux", Err("no appindicator"), false, true),
    ] {
        let state = ShellState::default();
        // A flag left over from before must be overwritten, not merely left alone.
        state.set_close_hides_to_tray(!hides);
        after_tray_build(&state, built, os);
        assert_eq!(
            state.close_hides_to_tray(),
            hides,
            "{os} {built:?}: hide-on-close"
        );
        let pending = state.take_tray_notice();
        assert_eq!(pending.is_some(), notice, "{os} {built:?}: notice pending");
        if let (Some(text), Err(e)) = (pending, built) {
            assert!(
                text.contains(e),
                "{os}: the notice does not say what failed: {text}"
            );
        }
    }

    let shell_rs = code_only(include_str!("../src/shell.rs"));
    let setup = function_body(&shell_rs, "pub fn setup<");
    assert!(
        setup.contains("after_tray_build(&shell, outcome, std::env::consts::OS);"),
        "`setup` no longer hands the RUNNING platform to `after_tray_build`:\n{setup}"
    );
    assert!(
        setup.contains("catch_tray_build(|| build_tray(app))"),
        "`setup` no longer builds the tray through `catch_tray_build`:\n{setup}"
    );
    assert_eq!(
        shell_rs.matches("after_tray_build(").count(),
        2,
        "`after_tray_build` should be defined once and called once (from `setup`)"
    );
}

/// ⚠ R2-16: A TRAY BACKEND THAT PANICS IS A FAILED TRAY, not a dead app.
#[test]
fn a_panicking_tray_build_is_an_error() {
    let panicked = catch_tray_build::<()>(|| panic!("Failed to load ayatana-appindicator3"));
    let e = panicked.expect_err("a panic must become an error");
    assert!(
        e.contains("panicked") && e.contains("ayatana-appindicator3"),
        "{e}"
    );
    let failed = catch_tray_build::<()>(|| Err(tauri::Error::FailedToReceiveMessage));
    assert!(failed.is_err());
    assert_eq!(catch_tray_build(|| Ok(7)), Ok(7));
}

/// ⚠ THE APP MENU KEEPS AppKit's STANDARD ITEMS AND REPLACES ONLY QUIT. The Edit submenu is what
/// makes ⌘C/⌘V work in a webview text field; the custom Quit is what makes ⌘Q reach the notice.
#[test]
fn the_app_menu_is_the_default_one_with_a_quit_that_reaches_the_notice() {
    use AppMenuEntry::*;
    let spec = app_menu_spec();
    let titles: Vec<Option<&str>> = spec.iter().map(|s| s.title).collect();
    assert_eq!(
        titles,
        vec![
            None,
            Some("File"),
            Some("Edit"),
            Some("View"),
            Some("Window"),
            Some("Help")
        ]
    );
    // ⚠ R2-8: THE IDS AppKit's WINDOW AND HELP MENUS ARE FOUND BY (tauri `src/app.rs:2487-2502`),
    // and no other submenu claims them.
    let ids: Vec<Option<&str>> = spec.iter().map(|s| s.id).collect();
    assert_eq!(
        ids,
        vec![
            None,
            None,
            None,
            None,
            Some(WINDOW_SUBMENU_ID),
            Some(HELP_SUBMENU_ID)
        ]
    );
    assert!(
        spec[5].entries.is_empty(),
        "Help is AppKit's to fill, as in tauri's default"
    );
    let app = &spec[0].entries;
    for needed in [About, Hide, HideOthers, ShowAll, Quit] {
        assert!(app.contains(&needed), "the app submenu lost {needed:?}");
    }
    assert_eq!(app.last(), Some(&Quit), "Quit belongs at the bottom");
    assert_eq!(
        spec[2].entries,
        &[Undo, Redo, Separator, Cut, Copy, Paste, SelectAll],
        "the Edit submenu is what makes copy/paste work in the webview"
    );
    assert!(spec[4].entries.contains(&Minimize) && spec[4].entries.contains(&CloseWindow));
    assert_eq!(spec[4].title, Some("Window"));
    let quits: usize = spec
        .iter()
        .map(|s| s.entries.iter().filter(|e| **e == Quit).count())
        .sum();
    assert_eq!(quits, 1);
    assert_eq!(QUIT_ACCELERATOR, "CmdOrCtrl+Q");
    assert_ne!(APP_MENU_QUIT, MENU_QUIT);

    // The builder maps the custom entry to the custom id AND the ⌘Q accelerator, and a spec id to
    // `with_id_and_items` — read from source (comments stripped), since muda cannot build a menu off
    // the main thread.
    let shell_rs = &code_only(include_str!("../src/shell.rs"));
    assert!(
        shell_rs.contains(
            "Quit => Box::new(MenuItem::with_id(\n            app,\n            APP_MENU_QUIT,\n            format!(\"Quit {name}\"),\n            true,\n            Some(QUIT_ACCELERATOR),\n        )?),"
        ),
        "the app menu's Quit is no longer the custom APP_MENU_QUIT item with QUIT_ACCELERATOR"
    );
    let build_menu = function_body(shell_rs, "pub fn build_app_menu<");
    assert!(
        build_menu
            .contains("Some(id) => Submenu::with_id_and_items(app, id, title, true, &refs)?,"),
        "`build_app_menu` no longer gives a spec id to its submenu:\n{build_menu}"
    );
    assert!(
        !shell_rs.contains("PredefinedMenuItem::quit("),
        "a predefined Quit is back: AppKit's `terminate:` bypasses the notice"
    );
}

/* ── the wiring, as written ───────────────────────────────────────────────────────────────────── */

/// ⚠ READ OUT OF `lib.rs`, WHICH IS WHAT A TEST CAN REACH. Registering a plugin, the app menu and
/// the run-loop callback happens inside `run()`, which builds a real windowed app; no mock runtime
/// executes it. So this asserts the source says what the design requires — a weaker claim than
/// "it works", and stated as such. The BEHAVIOUR of the pieces it wires is driven below.
#[test]
fn the_plugins_the_menu_and_the_run_callback_are_wired() {
    // ⚠ CODE ONLY. The doc comments in both files QUOTE the very calls pinned here, so a pin over
    // the raw text passes with the call deleted — measured: replacing `.run(shell::on_run_event)`
    // with `.run(|_, _| {})` left this test green until comments were stripped first.
    let lib = &code_only(include_str!("../src/lib.rs"));
    assert!(
        lib.contains("tauri_plugin_single_instance::init("),
        "`tauri-plugin-single-instance` is not registered; a second launch would race the first \
         instead of focusing it."
    );
    assert!(
        lib.contains("tauri_plugin_window_state::Builder::default().build()"),
        "`tauri-plugin-window-state` is not registered; window size and position would not persist."
    );

    // ⚠ ORDER IS LOAD-BEARING: single-instance takes its lock in its own setup hook, so it has to
    // be the first plugin on the builder.
    let single = lib
        .find("tauri_plugin_single_instance::init(")
        .expect("checked above");
    let window_state = lib
        .find("tauri_plugin_window_state::Builder")
        .expect("checked above");
    assert!(
        single < window_state,
        "single-instance must be registered before the other plugins"
    );
    // A second launch raises the window through the same command the webview may call.
    assert!(lib.contains("shell::open_today(app.clone())"));

    // The shell's setup runs, and the state it and the commands resolve is managed — `State<'_, T>`
    // PANICS if nothing of that type is managed.
    assert!(lib.contains("shell::setup(app.handle())"));
    assert!(lib.contains(".manage(snapshots)"));
    assert!(
        lib.contains(".manage(shell::ShellState::default())"),
        "the quit latch is not managed: every Quit would exit with no notice"
    );

    // ⚠ THE RUN-LOOP CALLBACK. Without it there is no macOS Reopen (a Dock click on a hidden
    // window shows nothing) and no close-to-tray decision at all.
    assert!(
        lib.contains(".run(shell::on_run_event)"),
        "lib.rs no longer runs the app with `shell::on_run_event`"
    );
    // The app menu (macOS) and the ONE menu handler.
    assert!(lib.contains("let builder = builder.menu(shell::build_app_menu);"));
    assert!(lib.contains(".on_menu_event(shell::on_menu_event)"));
    let shell_rs = &code_only(include_str!("../src/shell.rs"));
    assert_eq!(
        shell_rs.matches(".on_menu_event(").count() + lib.matches(".on_menu_event(").count(),
        1,
        "the menu handler must be registered exactly once: a tray-level `on_menu_event` ALSO \
         receives app-menu events, so two registrations run every Quit twice — notice, then exit"
    );
    // The Reopen arm raises the window; its variant cannot be constructed outside tauri.
    let run_event = function_body(shell_rs, "pub fn on_run_event<");
    assert!(
        run_event.contains("RunEvent::Reopen { .. } => {\n            let _ = focus_main(app);"),
        "`shell::on_run_event` no longer raises the window on macOS Reopen:\n{run_event}"
    );
    // ⚠ R2-4: …and the arm is COMPILED on macOS. A `cfg` that excludes macOS (or any cfg other
    // than exactly `target_os = "macos"`) would leave the source above intact and the arm gone.
    let before_arm = &run_event[..run_event.find("RunEvent::Reopen").expect("found above")];
    let attribute = before_arm
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    assert!(
        !attribute.starts_with("#[") || attribute == "#[cfg(target_os = \"macos\")]",
        "the Reopen arm carries `{attribute}`, which does not compile it on macOS"
    );
    // ⚠ R2-4: the close decision HIDES through `hide_main` and otherwise asks to quit — MockRuntime's
    // `hide` is a no-op, so this half is pinned as source.
    assert!(
        squash(run_event).contains(
            "if shell.close_hides_to_tray() { let _ = hide_main(app); } else { request_quit(app); }"
        ),
        "the close path no longer hides through `hide_main` (or quits otherwise):\n{run_event}"
    );
    // …and `focus_main` actually SHOWS the window (MockRuntime's `show` is a no-op too).
    let focus = function_body(shell_rs, "fn focus_main<");
    assert!(
        focus.contains("window.show().map_err(|e| e.to_string())?;")
            && focus.contains("window.set_focus()")
            && focus.contains("window.unminimize()"),
        "`focus_main` no longer shows, unminimizes and focuses the window:\n{focus}"
    );
    let hide = function_body(shell_rs, "fn hide_main<");
    assert!(
        hide.contains(".hide()"),
        "`hide_main` no longer hides:\n{hide}"
    );
}

/// Source with every comment removed — `//` line, doc and inner-doc comments and `/* … */` blocks
/// (nesting included, newlines kept so line shapes survive) — and everything else kept verbatim.
///
/// ⚠ A LEXER, NOT A SEARCH-AND-DELETE. String literals (`"…"` with escapes, raw `r"…"` /
/// `r#"…"#`, and their `b` forms) and char literals are copied through whole, so a `"/*"` or a
/// `"https://…"` in code cannot open a comment that swallows the pinned code after it. MEASURED in
/// review round 3: with a `"/*"` literal in `shell.rs`, the previous version dropped everything
/// that followed, and a predefined Quit added below it passed the "no predefined Quit" pin.
/// A `'` is a char literal only when it is one (`'x'`, `'\n'`, `'\u{..}'`); otherwise it is a
/// lifetime or a label and is copied as code.
fn code_only(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let ident = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match (c, at(i + 1)) {
            // A block comment, to its matching close. Only its newlines survive.
            ('/', Some('*')) => {
                let mut depth = 0usize;
                while i < chars.len() {
                    match (chars[i], at(i + 1)) {
                        ('/', Some('*')) => {
                            depth += 1;
                            i += 2;
                        }
                        ('*', Some('/')) => {
                            depth -= 1;
                            i += 2;
                            if depth == 0 {
                                break;
                            }
                        }
                        ('\n', _) => {
                            out.push('\n');
                            i += 1;
                        }
                        _ => i += 1,
                    }
                }
            }
            // A line comment, to (not including) its newline.
            ('/', Some('/')) => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            // A string: to the first unescaped `"`.
            ('"', _) => {
                let start = i;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    i += if chars[i] == '\\' { 2 } else { 1 };
                }
                i = (i + 1).min(chars.len());
                out.extend(&chars[start..i]);
            }
            // A raw string (`r`, or `br`, not inside an identifier): to `"` plus as many `#`.
            ('r', Some('"' | '#'))
                if !ident(i.checked_sub(1).and_then(at))
                    || (at(i - 1) == Some('b') && !ident(i.checked_sub(2).and_then(at))) =>
            {
                let hashes = chars[i + 1..].iter().take_while(|c| **c == '#').count();
                if at(i + 1 + hashes) != Some('"') {
                    // `r#ident` — a raw identifier, not a string.
                    out.push(c);
                    i += 1;
                    continue;
                }
                let start = i;
                i += hashes + 2;
                let close: Vec<char> = std::iter::once('"')
                    .chain(std::iter::repeat_n('#', hashes))
                    .collect();
                while i < chars.len() && !chars[i..].starts_with(&close) {
                    i += 1;
                }
                i = (i + close.len()).min(chars.len());
                out.extend(&chars[start..i]);
            }
            // A char literal — `'\…'` or `'x'` — and otherwise a lifetime or label.
            ('\'', Some('\\')) => {
                let start = i;
                i += 3;
                while i < chars.len() && chars[i] != '\'' {
                    i += 1;
                }
                i = (i + 1).min(chars.len());
                out.extend(&chars[start..i]);
            }
            ('\'', Some(_)) if at(i + 2) == Some('\'') => {
                out.extend(&chars[i..i + 3]);
                i += 3;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// `s` with every run of whitespace collapsed to one space.
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The text of the function whose signature starts with `signature`, up to its closing `}` at
/// column 0. Panics if there is no such function — a pin over a renamed function must fail loudly.
fn function_body<'a>(code: &'a str, signature: &str) -> &'a str {
    let start = code
        .find(signature)
        .unwrap_or_else(|| panic!("no `{signature}` in the source"));
    let rest = &code[start..];
    let end = rest.find("\n}").map_or(rest.len(), |i| i + 2);
    &rest[..end]
}

#[test]
fn code_only_drops_comments_and_keeps_code() {
    let stripped = code_only("//! `.run(x)`\n    .run(y); // `.run(z)`\n/// .run(w)\n");
    assert!(stripped.contains(".run(y);"));
    assert!(
        !stripped.contains(".run(x)")
            && !stripped.contains(".run(z)")
            && !stripped.contains(".run(w)")
    );
    // ⚠ R2-4: BLOCK COMMENTS TOO — a `/* … */` around a pinned arm used to leave the pin green.
    let blocked = code_only(
        "a();\n/*\n    RunEvent::Reopen { .. } => {\n        b();\n    }\n*/\nc(); /* d() */ e();\n/* x /* nested */ f(); */ g();\n",
    );
    assert!(blocked.contains("a();") && blocked.contains("c();") && blocked.contains("e();"));
    assert!(blocked.contains("g();"));
    assert!(
        !blocked.contains("Reopen") && !blocked.contains("b();") && !blocked.contains("d()"),
        "{blocked}"
    );
    assert!(
        !blocked.contains("f();"),
        "a nested block comment ended early: {blocked}"
    );
    assert_eq!(
        blocked.lines().count(),
        "a();\n/*\n    RunEvent::Reopen { .. } => {\n        b();\n    }\n*/\nc(); /* d() */ e();\n/* x /* nested */ f(); */ g();\n"
            .lines()
            .count(),
        "line structure must survive stripping"
    );
    // ⚠ Round 3: COMMENT MARKERS INSIDE LITERALS ARE NOT COMMENTS. Each line is built so that
    // mis-lexing its literal swallows a `pinned_*` call or exposes a `gone_*` comment: a string
    // or raw string not recognised opens the `/*` inside it; a char literal holding `"` not
    // recognised opens a STRING that ends at the next `"`, which is placed just before a `/*`; and
    // a raw identifier taken for a raw string copies the comments after it.
    let literals = code_only(concat!(
        "let a = \"/*\"; pinned_a();\n",
        "let b = \"https://x\"; pinned_b(); // gone_b()\n",
        "let c = \"esc \\\" /* still\"; pinned_c();\n",
        "let d = r#\"raw \" /* \"#; pinned_d();\n",
        "let e = br\"/*\"; pinned_e();\n",
        "let f = '\"'; pinned_f(); let f2 = \"/*\"; pinned_f2();\n",
        "let g = '/'; pinned_g(); let h = '\\''; pinned_h(); let q = '\\\"'; pinned_q(); let q2 = \"/*\"; pinned_q2();\n",
        "fn l<'a>(x: &'a str) -> &'a str { x } pinned_l(); let r#type = 1; pinned_r(); // gone_r\n",
        "/* \"*/ pinned_s(); // \"gone_s\n",
        "pinned_t(); /* 'gone_t */ pinned_u();\n",
    ));
    for pinned in [
        "pinned_a();",
        "pinned_b();",
        "pinned_c();",
        "pinned_d();",
        "pinned_e();",
        "pinned_f();",
        "pinned_f2();",
        "pinned_g();",
        "pinned_h();",
        "pinned_q();",
        "pinned_q2();",
        "pinned_l();",
        "pinned_r();",
        "pinned_s();",
        "pinned_t();",
        "pinned_u();",
    ] {
        assert!(
            literals.contains(pinned),
            "{pinned} was swallowed:\n{literals}"
        );
    }
    for gone in ["gone_b", "gone_r", "gone_s", "gone_t"] {
        assert!(
            !literals.contains(gone),
            "the comment holding {gone} was kept:\n{literals}"
        );
    }
    // …and the literals themselves are kept, verbatim.
    for kept in [
        "\"/*\"",
        "\"https://x\"",
        "r#\"raw \" /* \"#",
        "'\"'",
        "'\\''",
        "'\\\"'",
        "&'a str",
        "r#type",
    ] {
        assert!(literals.contains(kept), "{kept} was altered:\n{literals}");
    }
    assert_eq!(literals.lines().count(), 10, "{literals}");
    // And the function slicer finds the whole function and nothing after it.
    let code = "fn a() {\n    x();\n}\nfn b() {\n    y();\n}\n";
    assert_eq!(function_body(code, "fn a("), "fn a() {\n    x();\n}");
}

/// ⚠ R2-5: THE VALUES, NOT ONLY THE MECHANISMS. A hung read is abandoned after thirty seconds.
#[test]
fn the_engine_read_timeout_is_thirty_seconds() {
    assert_eq!(ENGINE_READ_TIMEOUT, Duration::from_secs(30));
}

/// The crate declares the two cargo features the tray needs, and no `default` key turned them into
/// something else.
#[test]
fn the_tray_is_built_on_tauris_core_feature() {
    let manifest = include_str!("../Cargo.toml");
    assert!(
        manifest
            .contains(r#"tauri = { version = "=2.11.5", features = ["tray-icon", "image-png"] }"#),
        "the tray feature set changed. `tray-icon` is what makes `TrayIconBuilder` exist at all, \
         and `image-png` is what makes `Image::from_bytes` exist — the tray icon is a committed \
         PNG, not a raw RGBA blob."
    );
}

/* ── the committed tray assets ────────────────────────────────────────────────────────────────── */

/// The two icon files exist, are PNGs, and are the sizes macOS wants.
///
/// ⚠ 18pt IS NOT A STYLE CHOICE. `tray-icon` 0.24.2 sets every menu-bar image's LOGICAL height to
/// 18 whatever its pixel size (`src/platform_impl/macos/mod.rs:295-307`), so the 36×36 file renders
/// at 18pt on a 2× display and the 18×18 is the 1× artwork.
#[test]
fn the_tray_icons_are_template_images_of_the_right_size() {
    for (name, expected) in [
        ("tray-template.png", 18u32),
        ("tray-template@2x.png", 36u32),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("icons")
            .join(name);
        let bytes =
            std::fs::read(&path).unwrap_or_else(|e| panic!("{} is readable: {e}", path.display()));
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "{name} is not a PNG");
        // IHDR is always the first chunk: 8 signature + 4 length + 4 tag, then width and height.
        let width = u32::from_be_bytes(bytes[16..20].try_into().expect("IHDR width"));
        let height = u32::from_be_bytes(bytes[20..24].try_into().expect("IHDR height"));
        assert_eq!((width, height), (expected, expected), "{name}");
        let colour_type = bytes[25];
        assert_eq!(
            colour_type, 6,
            "{name} is colour type {colour_type}; a macOS template image needs an ALPHA channel \
             (RGBA = 6) because the system recolours it and keeps only the shape"
        );
    }

    // And the constant that decides which one is compiled in still picks by platform.
    let shell = include_str!("../src/shell.rs");
    assert!(shell.contains(r#"include_bytes!("../icons/tray-template@2x.png")"#));
    assert!(shell.contains(r#"include_bytes!("../icons/tray-template.png")"#));
    assert!(
        shell.contains(".icon_as_template(true)"),
        "the tray icon is no longer marked as a template image; on macOS it would render as \
         literal black pixels and disappear in the dark menu bar."
    );
    assert!(
        shell.contains(".show_menu_on_left_click(false)"),
        "left-click must be the PRIMARY action (open the window), not the menu."
    );
}

/* ── the shell on a MockRuntime app ───────────────────────────────────────────────────────────── */

/// The shipped context. ONE `generate_context!` per test binary: each expansion defines the macOS
/// `_EMBED_INFO_PLIST` symbol, and a second one is a compile error.
fn ctx() -> tauri::Context<MockRuntime> {
    tauri::generate_context!()
}

/// A mock app managing `shell`. `App::run` creates the configured `main` window at `Ready`; tests
/// that do not run the loop add it with [`with_main_window`].
fn mock_app(shell: ShellState) -> App<MockRuntime> {
    mock_builder().manage(shell).build(ctx()).expect("mock app")
}

fn with_main_window(app: &App<MockRuntime>) {
    WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("main webview");
}

/// Records every payload of one event.
fn record(app: &AppHandle<MockRuntime>, event: &str) -> Arc<Mutex<Vec<String>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    app.listen(event, move |e| {
        sink.lock().expect("lock").push(e.payload().to_string());
    });
    seen
}

fn count(seen: &Arc<Mutex<Vec<String>>>) -> usize {
    seen.lock().expect("lock").len()
}

/// The text of a caught panic.
fn panic_text(result: std::thread::Result<impl std::fmt::Debug>) -> Option<String> {
    match result {
        Ok(_) => None,
        Err(p) => Some(
            p.downcast_ref::<String>()
                .cloned()
                .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default(),
        ),
    }
}

/// MockRuntime's `request_exit` is `unimplemented!()`: this panic IS "exit was reached".
const EXIT_REACHED: &str = "not implemented";

fn menu(id: &str) -> MenuEvent {
    MenuEvent {
        id: MenuId::new(id),
    }
}

/// ⚠ THE WHOLE QUIT SEQUENCE, IN ORDER, FOR BOTH QUIT ITEMS: a cold `app_quit` refuses; the first
/// Quit shows the notice once and latches; `app_quit` then reaches exit; a second Quit exits with no
/// second notice. Each of those steps has been measured to survive a mutation that the pure tests
/// could not see (the latch never set; `app_quit` never exiting; the tray Quit skipping the notice).
#[test]
fn the_quit_sequence_shows_the_notice_once_then_exits() {
    for quit_item in [MENU_QUIT, APP_MENU_QUIT] {
        let app = mock_app(ShellState::default());
        with_main_window(&app);
        let h = app.handle().clone();
        let notices = record(&h, EVENT_QUIT_REQUESTED);

        assert_eq!(
            shell::app_quit(h.clone()),
            Err("the quit notice has not been shown this session".to_string()),
            "{quit_item}: `app_quit` must refuse before the notice"
        );

        shell::on_menu_event(&h, menu(quit_item));
        assert_eq!(
            count(&notices),
            1,
            "{quit_item}: the first Quit must show the notice"
        );
        let payload: serde_json::Value =
            serde_json::from_str(&notices.lock().unwrap()[0]).expect("JSON payload");
        // No snapshot was announced on this app, so the notice is the "cannot say" one.
        assert_eq!(payload["body"], quit_dialog(None).body, "{quit_item}");
        assert!(
            h.state::<ShellState>().quit_notice_shown(),
            "{quit_item}: the notice went out and the latch was not set"
        );

        let exited = panic_text(catch_unwind(AssertUnwindSafe(|| {
            shell::app_quit(h.clone())
        })));
        assert_eq!(
            exited.as_deref(),
            Some(EXIT_REACHED),
            "{quit_item}: `app_quit` after the notice did not reach `AppHandle::exit`"
        );

        let exited = panic_text(catch_unwind(AssertUnwindSafe(|| {
            shell::on_menu_event(&h, menu(quit_item))
        })));
        assert_eq!(
            exited.as_deref(),
            Some(EXIT_REACHED),
            "{quit_item}: the second Quit did not exit"
        );
        assert_eq!(
            count(&notices),
            1,
            "{quit_item}: the notice was shown twice"
        );
    }
}

/// ⚠ R2-7: THE LATCH IS SET BEFORE THE NOTICE IS EMITTED. Tauri runs a Rust listener INSIDE `emit`
/// (`src/event/listener.rs`, `emit_filter`), so a listener that finds the latch still open proves
/// the order is wrong — the window in which a fast confirm click would find `app_quit` refusing.
#[test]
fn the_quit_latch_is_set_before_the_notice_goes_out() {
    let app = mock_app(ShellState::default());
    with_main_window(&app);
    let h = app.handle().clone();
    let seen: Arc<Mutex<Vec<bool>>> = Arc::new(Mutex::new(Vec::new()));
    let (sink, listener_app) = (Arc::clone(&seen), h.clone());
    h.listen(EVENT_QUIT_REQUESTED, move |_| {
        let latched = listener_app.state::<ShellState>().quit_notice_shown();
        sink.lock().expect("lock").push(latched);
    });
    shell::on_menu_event(&h, menu(MENU_QUIT));
    assert_eq!(
        *seen.lock().unwrap(),
        vec![true],
        "the quit notice was emitted before the latch was set (or not delivered synchronously)"
    );
}

/// ⚠ Round 3: WHAT THE SINK RECORDS IS RECORDED BEFORE IT ANNOUNCES. A quit request or a
/// `state_snapshot` racing a `state:changed` must not answer for an older snapshot than the one
/// being announced. Tauri runs a Rust listener INSIDE `emit`, so a listener that finds the old
/// state (or no stopped notice) proves the order is wrong.
#[test]
fn the_sink_records_the_state_before_it_announces_it() {
    let app = mock_app(ShellState::default());
    let h = app.handle().clone();
    type Seen = (Option<ScheduleState>, Option<String>);
    let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
    let (sink, listener_app) = (Arc::clone(&seen), h.clone());
    h.listen(EVENT_STATE_CHANGED, move |_| {
        let shell = listener_app.state::<ShellState>();
        sink.lock()
            .expect("lock")
            .push((shell.last_state(), shell.updates_stopped()));
    });
    let delivered = one_per_phase()
        .into_iter()
        .find(|(w, _)| *w == "delivered")
        .map(|(_, s)| s)
        .expect("fixture");
    let first = snapshot_of(Some(delivered.clone()));
    let stopped = Snapshot::stopped(Some(&first), "injected");
    let sink = AppState::new(h.clone());
    sink.changed(&first);
    sink.changed(&stopped);
    let notice = stopped.stopped_notice().map(str::to_string);
    assert!(notice.is_some(), "a stopped snapshot has a notice");
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(Some(delivered.clone()), None), (Some(delivered), notice)],
        "`state:changed` went out before the sink recorded what it carries"
    );
}

/// Run Now asks the WEBVIEW to run (on Today); the other items navigate; an unknown id does nothing.
#[test]
fn tray_items_raise_the_window_on_the_right_screen() {
    let app = mock_app(ShellState::default());
    with_main_window(&app);
    let h = app.handle().clone();
    let routes = record(&h, EVENT_NAVIGATE);
    let runs = record(&h, EVENT_RUN_NOW);
    let notices = record(&h, EVENT_QUIT_REQUESTED);

    shell::on_menu_event(&h, menu(MENU_RUN_NOW));
    assert_eq!(count(&runs), 1, "Run Now did not ask the webview to run");
    shell::on_menu_event(&h, menu(MENU_OPEN_BRIEFING));
    shell::on_menu_event(&h, menu(MENU_SCHEDULE_SETTINGS));
    shell::on_menu_event(&h, menu(MENU_SETTINGS));
    shell::on_menu_event(&h, menu(MENU_STATUS)); // a readout, not an action
    shell::on_menu_event(&h, menu("something-else"));
    assert_eq!(
        *routes.lock().unwrap(),
        vec![
            "\"today\"".to_string(),
            "\"today\"".to_string(),
            "\"schedule\"".to_string(),
            "\"settings\"".to_string(),
        ]
    );
    assert_eq!(count(&runs), 1);
    assert_eq!(count(&notices), 0);

    // `open_today` (the single-instance callback, and the webview's own command) lands on Today…
    shell::open_today(h.clone()).expect("a main window exists");
    assert_eq!(
        routes.lock().unwrap().last().map(String::as_str),
        Some("\"today\"")
    );
    // …and with no window it says so rather than navigating nothing.
    let bare = mock_app(ShellState::default());
    let bare_routes = record(bare.handle(), EVENT_NAVIGATE);
    assert!(shell::open_today(bare.handle().clone()).is_err());
    assert_eq!(count(&bare_routes), 0);
}

/// The shipping sink emits the snapshot the watcher produced, verbatim.
#[test]
fn the_app_sink_emits_state_changed() {
    let app = mock_app(ShellState::default());
    let h = app.handle().clone();
    let seen = record(&h, EVENT_STATE_CHANGED);
    let snapshot = Snapshot::unavailable("`status --json` failed: EACCES");
    AppState::new(h.clone()).changed(&snapshot);
    assert_eq!(count(&seen), 1);
    let payload: serde_json::Value = serde_json::from_str(&seen.lock().unwrap()[0]).unwrap();
    assert_eq!(payload["error"], "`status --json` failed: EACCES");
    assert!(payload["scheduleState"].is_null());
}

/// What `app.run` saw when the test closed the main window `closes` times.
struct CloseRun {
    /// The panic text, if the run ended in one (`EXIT_REACHED` = the app exited).
    panic: Option<String>,
    notices: usize,
    /// Whether every close was PREVENTED. Observed as the absence of an `ExitRequested` before the
    /// test's own final destroy: MockRuntime removes an unprevented window from its own map and,
    /// that being the last window, asks to exit — while tauri's window registry never hears of it
    /// (the mock emits no `Destroyed`), so "is the window still there?" cannot tell. MEASURED: an
    /// earlier version asked exactly that, and a mutant that dropped `prevent_close` passed it.
    prevented: bool,
}

/// ⚠ ONE `App::run` AT A TIME IN THIS PROCESS. On `Ready`, a dev build of tauri 2.11.5 sets the
/// app icon through `NSApplication::sharedApplication` on WHATEVER thread runs the loop
/// (`src/app.rs`, "set the app icon in development") — here, a test thread. MEASURED on this
/// binary: with the two run-loop tests in parallel, 5 of 30 runs died by SIGTRAP/SIGABRT/SIGSEGV;
/// with either one alone in parallel with everything else, 0 of 40; serialized, 0 of 20.
static RUN_LOOP: Mutex<()> = Mutex::new(());

/// Drive `App::run` with `shell::on_run_event` — the callback `lib.rs` installs — closing the main
/// window `closes` times, one per loop iteration, then destroying it.
fn close_main(shell: ShellState, closes: u32) -> CloseRun {
    // A panic inside a previous run poisons the lock; the lock only serialises, so that is fine.
    let _one_at_a_time = RUN_LOOP.lock().unwrap_or_else(|e| e.into_inner());
    let app = mock_app(shell);
    let notices = record(app.handle(), EVENT_QUIT_REQUESTED);
    let premature_exit = Arc::new(AtomicBool::new(false));
    let premature_in_loop = Arc::clone(&premature_exit);
    // ⚠ STEP ONLY AFTER EACH CLOSE HAS BEEN HANDLED. MockRuntime runs `close()` as a main-thread
    // task, so the `CloseRequested` it causes arrives a loop iteration LATER — MEASURED: a version
    // that destroyed the window on the first tick destroyed it before the close was handled, and
    // so could not see an unprevented close.
    let mut closes_sent = 0u32;
    let mut closes_handled = 0u32;
    let mut destroyed = false;
    let close = |h: &AppHandle<MockRuntime>| {
        h.get_webview_window("main")
            .expect("the config window exists")
            .close()
            .expect("close is sent");
    };
    let result = catch_unwind(AssertUnwindSafe(move || {
        app.run(move |h, event| {
            match &event {
                // `setup` has created the config window by the time Ready is delivered.
                RunEvent::Ready => {
                    close(h);
                    closes_sent += 1;
                }
                RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } => closes_handled += 1,
                RunEvent::MainEventsCleared if closes_handled == closes_sent => {
                    if closes_sent < closes {
                        close(h);
                        closes_sent += 1;
                    } else if !destroyed {
                        destroyed = true;
                        if let Some(w) = h.get_webview_window("main") {
                            let _ = w.destroy();
                        }
                    }
                }
                RunEvent::ExitRequested { .. } if !destroyed => {
                    premature_in_loop.store(true, Ordering::SeqCst);
                }
                _ => {}
            }
            shell::on_run_event(h, event);
        })
    }));
    CloseRun {
        panic: panic_text(result),
        notices: count(&notices),
        prevented: !premature_exit.load(Ordering::SeqCst),
    }
}

/// ⚠ WITH A TRAY, CLOSE HIDES: the close is PREVENTED (the loop does not try to exit), no notice
/// is shown, and nothing exits.
#[test]
fn closing_with_a_tray_keeps_the_app_running() {
    let shell = ShellState::default();
    shell.set_close_hides_to_tray(true);
    let run = close_main(shell, 1);
    assert_eq!(run.panic, None, "closing with a tray must not exit");
    assert!(
        run.prevented,
        "the close was not prevented: the last window went, and the app asked to exit"
    );
    assert_eq!(run.notices, 0, "closing with a tray is not a quit request");
}

/// ⚠ WITHOUT A TRAY, CLOSE IS A QUIT REQUEST: the first close is prevented and shows the notice; the
/// second exits. Hiding here would leave an app the user cannot see, reach or quit.
#[test]
fn closing_without_a_tray_goes_through_the_quit_notice() {
    let run = close_main(ShellState::default(), 2);
    assert!(
        run.prevented,
        "the first close was not prevented — the notice had nowhere to show"
    );
    assert_eq!(
        run.notices, 1,
        "the first close must show the quit notice, once"
    );
    assert_eq!(
        run.panic.as_deref(),
        Some(EXIT_REACHED),
        "the second close must exit"
    );
}

/// The tray-unavailable notice reaches the webview ONCE, on its first `state_snapshot` — the first
/// moment it is known to be listening — through real IPC.
#[test]
fn the_tray_failure_notice_is_delivered_once_through_state_snapshot() {
    let scratch = ScratchDir::new("tray-notice");
    let program = appending_ipc_sidecar(&scratch.path, "engine.sh", &scratch.join("argv.txt"));
    let client = Ok(EngineClient::with_program(program));
    let shell_state = ShellState::default();
    shell_state.set_tray_notice(tray_unavailable_notice("no StatusNotifierItem host"));
    let app = mock_builder()
        .manage(Engine(client.clone()))
        .manage(Arc::new(EngineSnapshots::new(client)))
        .manage(shell_state)
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(ctx())
        .expect("mock app");
    let w = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");
    let notices = record(app.handle(), EVENT_TRAY_UNAVAILABLE);
    for _ in 0..2 {
        let request = tauri::webview::InvokeRequest {
            cmd: "state_snapshot".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        get_ipc_response(&w, request).expect("state_snapshot is admitted and answers");
    }
    let seen = notices.lock().unwrap().clone();
    assert_eq!(
        seen.len(),
        1,
        "the notice must be delivered exactly once: {seen:?}"
    );
    assert!(seen[0].contains("no StatusNotifierItem host"), "{seen:?}");
}

/// One `state_snapshot` through real IPC, as the webview makes it.
fn invoke_state_snapshot(w: &tauri::WebviewWindow<MockRuntime>) -> serde_json::Value {
    let request = tauri::webview::InvokeRequest {
        cmd: "state_snapshot".into(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(w, request)
        .expect("state_snapshot is admitted and answers")
        .deserialize()
        .expect("a Snapshot is JSON")
}

/// ⚠ Round 3: A REFRESH DOES NOT CLEAR "LIVE UPDATES STOPPED". Once the watcher has stopped, the
/// sink records its notice, and every later `state_snapshot` — a FRESH read, whose state is shown
/// — still carries `updatesStopped` and leads its `error` with that notice, as the tray does.
#[test]
fn a_refresh_after_the_watcher_stopped_still_says_so() {
    let scratch = ScratchDir::new("stopped-refresh");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    std::fs::write(state.join("schedule.json"), "{}").expect("record");
    let program = state_sidecar(&scratch.path, "engine.sh", &state, None);
    let client = Ok(EngineClient::with_program(program));
    let app = mock_builder()
        .manage(Engine(client.clone()))
        .manage(Arc::new(EngineSnapshots::new(client)))
        .manage(ShellState::default())
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(ctx())
        .expect("mock app");
    let w = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");

    let before = invoke_state_snapshot(&w);
    assert_eq!(before["updatesStopped"], false, "{before}");
    assert!(before["error"].is_null(), "{before}");
    assert!(!before["scheduleState"].is_null(), "{before}");

    // The watcher's last word, through the shipping sink. A multi-line panic message is folded
    // onto the notice's one line.
    let stopped = Snapshot::stopped(None, "injected\nsecond line");
    AppState::new(app.handle().clone()).changed(&stopped);

    for refresh in 0..2 {
        let after = invoke_state_snapshot(&w);
        assert_eq!(after["updatesStopped"], true, "refresh {refresh}: {after}");
        let error = after["error"].as_str().unwrap_or_default();
        assert!(
            error.starts_with("Live updates have stopped")
                && error.contains("(injected second line)"),
            "refresh {refresh}: {error}"
        );
        assert_eq!(
            Some(error),
            stopped.stopped_notice(),
            "refresh {refresh}: a clean fresh read carries the notice and nothing else"
        );
        // The read itself is fresh, not the stopped snapshot's (which had no state at all).
        assert_eq!(
            after["scheduleState"], before["scheduleState"],
            "refresh {refresh}"
        );
    }
}

/// A fake engine whose first `fail_first` `status --json` calls fail, then answers like
/// `common::state_sidecar`. Its call count is in `<dir>/status-calls`.
fn flaky_engine(dir: &Path, state: &Path, fail_first: u32) -> std::path::PathBuf {
    let inner = state_sidecar(dir, "inner.sh", state, None);
    let counter = dir.join("status-calls");
    fake_sidecar(
        dir,
        "flaky.sh",
        &format!(
            "if [ \"$1:$2\" = status:--json ]; then\n  n=$(cat \"{c}\" 2>/dev/null || echo 0)\n  n=$((n+1))\n  echo $n > \"{c}\"\n  if [ $n -le {fail_first} ]; then echo \"engine not ready (attempt $n)\" >&2; exit 1; fi\nfi\nexec \"{inner}\" \"$@\"",
            c = counter.display(),
            inner = inner.display(),
        ),
    )
}

/// ⚠ A FAILED FIRST READ NO LONGER SWITCHES LIVE UPDATES OFF FOR THE SESSION. The failure is emitted
/// (so the tray can say "Engine unavailable" and the window can say why), retried with backoff,
/// and the watcher starts once the engine answers.
#[test]
fn the_watcher_start_retries_until_the_engine_answers() {
    let scratch = ScratchDir::new("retry");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    std::fs::write(state.join("schedule.json"), "{}").expect("record");
    let program = flaky_engine(&scratch.path, &state, 2);
    let app = mock_builder()
        .manage(Arc::new(EngineSnapshots::new(Ok(
            EngineClient::with_program(program),
        ))))
        .build(ctx())
        .expect("mock app");
    let h = app.handle().clone();
    let seen = record(&h, EVENT_STATE_CHANGED);

    shell::start_watcher_with(
        &h,
        RetryPolicy {
            first: Duration::from_millis(50),
            max: Duration::from_millis(200),
        },
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    while h.try_state::<Mutex<StateWatcher>>().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let started = h.try_state::<Mutex<StateWatcher>>().is_some();
    if let Some(w) = h.try_state::<Mutex<StateWatcher>>() {
        w.lock().expect("lock").stop();
    }
    assert!(
        started,
        "the watcher never started after the engine recovered"
    );

    let calls: u32 = std::fs::read_to_string(scratch.join("status-calls"))
        .expect("the counter")
        .trim()
        .parse()
        .expect("a count");
    assert!(
        calls >= 3,
        "the engine was asked {calls} time(s); two failures need a third try"
    );

    let payloads: Vec<serde_json::Value> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|p| serde_json::from_str(p).expect("JSON"))
        .collect();
    let first = payloads.first().expect("the failed read was emitted");
    assert!(first["scheduleState"].is_null(), "{first}");
    assert!(
        first["error"]
            .as_str()
            .unwrap_or_default()
            .contains("engine not ready (attempt 1)"),
        "the failure must carry the engine's stderr: {first}"
    );
    // Two identical failures are ONE announcement, not one per retry.
    let failures = payloads
        .iter()
        .filter(|p| p["scheduleState"].is_null())
        .count();
    assert!(failures <= 2, "every retry was announced: {payloads:?}");
    assert!(
        payloads.iter().any(|p| !p["scheduleState"].is_null()),
        "the recovered state was never emitted: {payloads:?}"
    );
}

#[test]
fn the_retry_backoff_doubles_and_is_capped() {
    let policy = RetryPolicy::default();
    let secs: Vec<u64> = (0..8).map(|a| policy.delay(a).as_secs()).collect();
    assert_eq!(secs, vec![2, 4, 8, 16, 32, 60, 60, 60]);
    assert_eq!(policy.delay(u32::MAX), Duration::from_secs(60));
}
