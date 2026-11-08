//! The live gate's shared half (briefing redesign wave 2, W2-S; plan §1.2, "The visibility gate (Rust)").
//!
//! Two live reads are DRIVEN by the webview (Today's tick, focus, current slide and moves) and GATED here, in Rust:
//! B1's `repos_status` (`repos.rs`) and C's calendar-details commands (`calendar_details.rs`). Each command's own
//! decision is a pure function in its own module that takes a [`Visibility`] and an `Option<CurrentSlide>` among its
//! inputs and calls [`Visibility::shown`]; this module holds only what the two share:
//!
//! - [`CurrentSlide`], the deck's slide as the webview reports it;
//! - [`Visibility`] and its one rule, [`Visibility::shown`];
//! - [`LiveEnv`], the clock and the window probe, managed ONCE in `lib.rs`. Its default is the real clock and the real
//!   main window; tests inject both (`with_clock`, `with_visibility`), so no command test depends on MockRuntime
//!   reporting `is_visible()` (constantly `true` there).
//!
//! ⚠ FAIL CLOSED. No main window, or an error from either window query, answers HIDDEN: a live read that spawns
//! anything must never run for a window nobody can see.
//!
//! No trait and no command here: two plain functions over one injected-state struct, for two users.

use tauri::Manager;

use crate::schedule_state::now_local;
use crate::shell::MAIN_WINDOW;

/// The deck's current slide, as the webview reports it (`SlideId`, gui/src/lib/deck.ts:754).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CurrentSlide {
    GoodMorning,
    WhatYouDid,
    LeftOff,
    Suggested,
    Calendar,
    Launchpad,
}

/// The main window as the user sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Visibility {
    pub visible: bool,
    pub minimized: bool,
}

impl Visibility {
    /// The one visibility rule both live commands use: on screen, and not minimised.
    pub const fn shown(self) -> bool {
        self.visible && !self.minimized
    }
}

/// What [`LiveEnv::visibility`] answers instead of asking the window (test harness only).
pub type VisibilityProbe = std::sync::Arc<dyn Fn() -> Visibility + Send + Sync>;

/// No window, or a window that would not say: treated as not shown.
const HIDDEN: Visibility = Visibility {
    visible: false,
    minimized: false,
};

/// Managed once in lib.rs. Default = the real clock and the real main window.
#[derive(Default)]
pub struct LiveEnv {
    /// `None` = [`now_local`], the watcher's own clock.
    clock: Option<crate::watcher::Clock>,
    /// `None` = the main window's `is_visible()` / `is_minimized()`.
    visibility: Option<VisibilityProbe>,
}

impl LiveEnv {
    /// **Test harness only**: the clock [`LiveEnv::now`] reads, sampled on every call.
    pub fn with_clock(mut self, clock: crate::watcher::Clock) -> Self {
        self.clock = Some(clock);
        self
    }

    /// **Test harness only**: the answer [`LiveEnv::visibility`] gives, sampled on every call.
    pub fn with_visibility(mut self, probe: VisibilityProbe) -> Self {
        self.visibility = Some(probe);
        self
    }

    /// The clock, or [`crate::schedule_state::now_local`].
    pub fn now(&self) -> crate::schedule_state::Now {
        match &self.clock {
            Some(clock) => clock(),
            None => now_local(),
        }
    }

    /// The probe, or the main window's `is_visible()` / `is_minimized()`; no window or an error → hidden.
    pub fn visibility<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> Visibility {
        if let Some(probe) = &self.visibility {
            return probe();
        }
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return HIDDEN;
        };
        match (window.is_visible(), window.is_minimized()) {
            (Ok(visible), Ok(minimized)) => Visibility { visible, minimized },
            _ => HIDDEN,
        }
    }
}
