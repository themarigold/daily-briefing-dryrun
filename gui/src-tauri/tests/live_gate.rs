//! Briefing redesign wave 2, W2-S-T2 — the live gate's shared half (`src/live_gate.rs`; plan §1.2, "The visibility
//! gate (Rust)"). B1's `repos_status` and C's calendar-details commands both build to this surface:
//!
//! - `Visibility::shown` is the one visibility rule (visible AND not minimised);
//! - `CurrentSlide` is the webview's `SlideId` (`gui/src/lib/deck.ts`), six camelCase ids and nothing else;
//! - `LiveEnv` is the injected clock and window probe. The DEFAULT is the real clock and the real main window, and a
//!   missing window (or an error from either query) answers HIDDEN, so a live command never spawns for a window
//!   nobody can see. Every command test injects both (`with_clock`, `with_visibility`): none depends on MockRuntime
//!   reporting `is_visible()` (it is constantly `true` there, `tests/shell.rs`'s header).
//!   MockRuntime answers `is_minimized()` with a constant `Ok(false)` and `is_visible()` with `Ok(true)` (tauri
//!   2.11.5 `src/test/mock_runtime.rs`), so the default path's use of the real window's `is_minimized()` and the
//!   query-error arms cannot be driven by this test runtime; `shown()`'s minimised rule is covered through the probe.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use daily_briefing_gui_lib::live_gate::{CurrentSlide, LiveEnv, Visibility, VisibilityProbe};
use daily_briefing_gui_lib::schedule_state::Now;
use daily_briefing_gui_lib::shell::MAIN_WINDOW;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{App, Manager, WebviewWindowBuilder};

const HIDDEN: Visibility = Visibility { visible: false, minimized: false };

/// A mock app with NO window at all: `mock_context`'s config declares none (the shipped `tauri.conf.json` declares
/// `main`, so `generate_context!()` is deliberately not used here).
fn windowless_app() -> App<MockRuntime> {
    mock_builder()
        .build(mock_context(noop_assets()))
        .expect("a windowless mock app builds")
}

#[test]
fn shown_is_visible_and_not_minimised_for_all_four_combinations() {
    let cases = [
        (true, false, true),
        (true, true, false),
        (false, false, false),
        (false, true, false),
    ];
    for (visible, minimized, shown) in cases {
        assert_eq!(
            Visibility { visible, minimized }.shown(),
            shown,
            "visible {visible}, minimized {minimized}"
        );
    }
    // `const fn`: usable in a constant, as a command's own decision table may want.
    const SHOWN: bool = Visibility { visible: true, minimized: false }.shown();
    assert!(SHOWN);
}

#[test]
fn current_slide_deserialises_each_of_the_webviews_six_ids() {
    // `SlideId` in gui/src/lib/deck.ts, in its order.
    let ids = [
        ("goodMorning", CurrentSlide::GoodMorning),
        ("whatYouDid", CurrentSlide::WhatYouDid),
        ("leftOff", CurrentSlide::LeftOff),
        ("suggested", CurrentSlide::Suggested),
        ("calendar", CurrentSlide::Calendar),
        ("launchpad", CurrentSlide::Launchpad),
    ];
    for (id, slide) in ids {
        let got: CurrentSlide =
            serde_json::from_str(&format!("\"{id}\"")).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(got, slide, "{id}");
    }
    // Six distinct variants: no two ids land on one.
    let distinct: std::collections::BTreeSet<String> = ids.iter().map(|(_, s)| format!("{s:?}")).collect();
    assert_eq!(distinct.len(), 6);
}

#[test]
fn current_slide_refuses_any_other_string_and_null_reaches_the_caller_as_none() {
    for bad in [
        "\"GoodMorning\"",
        "\"good_morning\"",
        "\"goodmorning\"",
        "\"launchPad\"",
        "\"Calendar\"",
        "\"calendarSlide\"",
        "\"\"",
        "\" calendar\"",
        "0",
        "true",
        "{}",
        "[\"calendar\"]",
    ] {
        assert!(
            serde_json::from_str::<CurrentSlide>(bad).is_err(),
            "{bad} must be refused"
        );
    }
    assert!(serde_json::from_str::<CurrentSlide>("null").is_err());
    assert_eq!(serde_json::from_str::<Option<CurrentSlide>>("null").expect("null"), None);
    assert_eq!(
        serde_json::from_str::<Option<CurrentSlide>>("\"calendar\"").expect("calendar"),
        Some(CurrentSlide::Calendar)
    );
    assert!(serde_json::from_str::<Option<CurrentSlide>>("\"Calendar\"").is_err());
}

#[test]
fn with_clock_is_what_now_returns() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let fixed = Now { local_date: "2026-10-16".into(), minutes: 7 * 60 + 41, epoch_secs: 1_792_150_860 };
    let answer = fixed.clone();
    let env = LiveEnv::default().with_clock(Arc::new(move || {
        seen.fetch_add(1, Ordering::SeqCst);
        answer.clone()
    }));
    assert_eq!(env.now(), fixed);
    assert_eq!(env.now(), fixed);
    // Sampled on every call, never cached.
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[test]
fn the_default_clock_is_the_real_local_clock() {
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs() as i64;
    let now = LiveEnv::default().now();
    let after = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("after the epoch")
        .as_secs() as i64;
    assert!(
        (before..=after).contains(&now.epoch_secs),
        "{} not in {before}..={after}",
        now.epoch_secs
    );
    assert!(now.minutes < 24 * 60);
}

#[test]
fn with_visibility_is_what_visibility_returns_and_the_window_is_not_asked() {
    let app = windowless_app();
    for v in [
        Visibility { visible: true, minimized: false },
        Visibility { visible: true, minimized: true },
        HIDDEN,
        Visibility { visible: false, minimized: true },
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let probe: VisibilityProbe = Arc::new(move || {
            seen.fetch_add(1, Ordering::SeqCst);
            v
        });
        let env = LiveEnv::default().with_visibility(probe);
        // The app has no window at all, so a SHOWN answer can only come from the probe.
        assert_eq!(env.visibility(app.handle()), v);
        assert_eq!(env.visibility(app.handle()), v);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "sampled on every call: {v:?}");
    }
}

#[test]
fn the_default_visibility_with_no_main_window_answers_hidden() {
    let app = windowless_app();
    assert!(app.get_webview_window(MAIN_WINDOW).is_none(), "PREMISE: no `main` window");
    assert_eq!(MAIN_WINDOW, "main");
    let v = LiveEnv::default().visibility(app.handle());
    assert_eq!(v, HIDDEN);
    assert!(!v.shown());
}

#[test]
fn the_default_visibility_asks_the_window_labelled_main_and_no_other() {
    let app = windowless_app();
    // A window with another label is not the main window: still hidden.
    WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .expect("another webview");
    assert_eq!(LiveEnv::default().visibility(app.handle()), HIDDEN);
    // With `main` present the answer is the window's own (MockRuntime's: visible, not minimised).
    WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
        .build()
        .expect("main webview");
    let w = app.get_webview_window(MAIN_WINDOW).expect("main");
    let expected = Visibility {
        visible: w.is_visible().expect("is_visible"),
        minimized: w.is_minimized().expect("is_minimized"),
    };
    assert_eq!(LiveEnv::default().visibility(app.handle()), expected);
    assert!(expected.visible, "PREMISE: MockRuntime reports its windows visible");
}

#[test]
fn live_env_is_managed_state() {
    // `lib.rs` manages one; a command resolves it as `State<'_, LiveEnv>`, so it must be Send + Sync + 'static.
    fn managed<T: Send + Sync + 'static>() {}
    managed::<LiveEnv>();
    let app = mock_builder()
        .manage(LiveEnv::default().with_visibility(Arc::new(|| HIDDEN)))
        .build(mock_context(noop_assets()))
        .expect("mock app");
    let env = app.state::<LiveEnv>();
    assert_eq!(env.visibility(app.handle()), HIDDEN);
}
