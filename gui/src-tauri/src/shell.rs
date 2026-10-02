//! T11 — the app shell: tray, app menu, single-instance, window-state, close-to-tray and an
//! explicit Quit.
//!
//! ## The tray is CORE, not a plugin
//!
//! `tauri` 2.11.5's `[features]` carries `tray-icon = ["dep:tray-icon"]`. The feature adds no
//! grant of its own to this app: the webview's capability names only `core:event:allow-listen` /
//! `allow-unlisten` plus this app's own commands, so `plugin:tray|*` and `plugin:menu|*` are
//! REFUSED to the webview (`tests/capability.rs` pins that behaviourally). The appendix's
//! "Tauri 2 CORE (tray-icon feature — not a plugin; verified)" is confirmed against this exact
//! version in `Cargo.toml`.
//!
//! ## What the tray menu says, and what R1 removed from it
//!
//! Plan R1's rework register, T11: *"the tray/app-owned install BUTTON is removed — install is
//! reachable only through the wizard or the Schedule & Access panel flow; tray gains 'Schedule
//! settings'; tray states per reworked machine."* So there is no "Install background scheduler"
//! item here, and the status line is [`ScheduleState::tray_line`] — the SAME state object the
//! Schedule screen renders, never a second derivation.
//!
//! "Check for Updates…" (appendix §12) is OMITTED: plan R6(U) excludes the Tauri updater from
//! 0.2.0, and a menu item for a capability the build does not have is a support ticket with a
//! label on it. Deviation register, `docs/gui-seam.md`.
//!
//! ## Quit is explicit, it has ONE path, and the copy is DELEGATED
//!
//! The appendix's Quit warning ("briefings will stop until you reopen — or install the background
//! scheduler instead") is false under R1: scheduling is delegated-only, so quitting the app does
//! not stop anything being generated. The R1 wording says so and offers the engine's
//! `notify: "auto"` — an `--invoker app` install leaves the engine's own `notify` at `"off"`
//! (`src/notify.ts`, plan T18). [`quit_dialog`] is that copy, owned in Rust so the tray and the
//! webview cannot disagree about it.
//!
//! ⚠ THE COPY DEPENDS ON THE STATE. "The background scheduler keeps generating them" is only true
//! when there IS a working one; with nothing scheduled, a broken unit, a unit nobody recorded, no
//! usable config or no state yet, the notice says what is actually true instead ([`QuitCopy`]).
//! Since B7 (T18) the app CAN post the arrival notification — behind its own opt-in — so the
//! Scheduled body names that as the thing quitting stops, without claiming the opt-in is on.
//!
//! Every way to ask to quit — tray Quit, the app menu's Quit (⌘Q), and closing the window where
//! there is no tray to hide into — goes through [`request_quit`], over the per-app
//! [`ShellState`] latch: the first request shows the notice, `app_quit` is allowed from then on,
//! and a second request exits. Dock → Quit, logout and shutdown do NOT pass through it (register).
//!
//! The offer is TAKEABLE since B5: it calls `config_save::config_offer_notify_auto`, the same
//! validated, atomic save path the Settings screen uses (see [`NOTIFY_OFFER_WRITABLE`]). Where it
//! cannot be taken — Windows, no usable config, no state yet — the dialog says why instead of
//! showing a control ([`offer_unavailable_reason`]).
//!
//! ⚠ BEFORE SETUP IS FINISHED THE NOTICE IS PLAIN (Phase E final harden, VM-measured UX finding).
//! A first-run quit — no config yet, the state the wizard opens on — used to read "no briefing is
//! being generated right now: the engine has no usable config. The Schedule screen shows what is
//! wrong" beside a disabled "Switch engine notifications to auto": an engine-health warning and an
//! engine setting, to someone who has not finished setting anything up. [`QuitCopy::NotSetUp`]
//! now says only that setup will be offered again, with no offer section and no Schedule button.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu,
    HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};

use crate::engine::{
    Engine, EngineClient, EngineError, EngineOutcome, NoProgress, Operation, Outcome,
};
use crate::schedule_state::{self, Phase, ScheduleState, StatusView};
use crate::watcher::{self, Snapshot, SnapshotSource, StateSink, WatchOptions, WatchTargets};

/// The window every shell action raises. The capability is scoped to it too.
pub const MAIN_WINDOW: &str = "main";

/* ── the events this module emits ─────────────────────────────────────────────────────────────── */

/// A fresh [`Snapshot`]: a file changed, time changed the state, or the watcher started.
pub const EVENT_STATE_CHANGED: &str = "state:changed";
/// Which screen to show — `"today"`, `"schedule"` or `"settings"`.
pub const EVENT_NAVIGATE: &str = "app:navigate";
/// The tray's Run Now. The webview runs it, so its progress has somewhere to land.
pub const EVENT_RUN_NOW: &str = "app:run-now";
/// The first quit request this session. Payload: [`QuitDialog`].
pub const EVENT_QUIT_REQUESTED: &str = "app:quit-requested";
/// The tray could not be built. Payload: the one-time notice text ([`tray_unavailable_notice`]).
pub const EVENT_TRAY_UNAVAILABLE: &str = "app:tray-unavailable";

/* ── the tray menu, as data ───────────────────────────────────────────────────────────────────── */

pub const MENU_STATUS: &str = "status";
pub const MENU_OPEN_BRIEFING: &str = "open-briefing";
pub const MENU_RUN_NOW: &str = "run-now";
pub const MENU_SCHEDULE_SETTINGS: &str = "schedule-settings";
pub const MENU_SETTINGS: &str = "settings";
pub const MENU_QUIT: &str = "quit";
/// The app menu's Quit — a CUSTOM item, so ⌘Q reaches [`request_quit`] instead of AppKit's
/// `terminate:`, which no notice can intercept (tao implements no `applicationShouldTerminate`).
pub const APP_MENU_QUIT: &str = "app-quit";
pub const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

/// The tray line shown before the first snapshot has arrived.
///
/// ⚠ NOT "Delivered" AND NOT "Offline". An app that has not yet asked the engine anything knows
/// nothing, and either guess would be a claim.
pub const STATUS_UNKNOWN: &str = "Checking…";

/// The tray line when the engine answered, but not with a state — a failed or timed-out
/// `status --json`, or a missing sidecar. The window says why (`Snapshot::error`).
pub const STATUS_ENGINE_ERROR: &str = "Engine unavailable";

/// One tray menu entry, as data rather than as a `MenuItem` — so the derivation can be tested
/// without a Tauri runtime, a display server or a menu bar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuSpec {
    pub id: &'static str,
    pub label: String,
    pub enabled: bool,
    /// A separator follows this entry.
    pub separator_after: bool,
}

/// The tray menu for a given state. **Pure.**
///
/// The first entry is the status line and is deliberately disabled: it is a readout, not an action,
/// and a clickable one invites the reading that it does something.
pub fn tray_menu_items(state: Option<&ScheduleState>) -> Vec<MenuSpec> {
    let status = state
        .map(|s| s.tray_line())
        .unwrap_or_else(|| STATUS_UNKNOWN.to_string());
    vec![
        MenuSpec {
            id: MENU_STATUS,
            label: status,
            enabled: false,
            separator_after: true,
        },
        MenuSpec {
            id: MENU_OPEN_BRIEFING,
            label: "Open Briefing".into(),
            enabled: true,
            separator_after: false,
        },
        MenuSpec {
            id: MENU_RUN_NOW,
            label: "Run Now".into(),
            enabled: true,
            separator_after: true,
        },
        MenuSpec {
            id: MENU_SCHEDULE_SETTINGS,
            label: "Schedule settings".into(),
            enabled: true,
            separator_after: false,
        },
        MenuSpec {
            id: MENU_SETTINGS,
            label: "Settings…".into(),
            enabled: true,
            separator_after: true,
        },
        MenuSpec {
            id: MENU_QUIT,
            label: "Quit".into(),
            enabled: true,
            separator_after: false,
        },
    ]
}

/// The tray line once the watcher has stopped (`Snapshot::updates_stopped`). The window says why.
pub const STATUS_UPDATES_STOPPED: &str = "Live updates stopped — reopen the app";

/// The tray's status line for a snapshot. **Pure.** Unknown before the first snapshot; the
/// state's own line when there is a state; [`STATUS_ENGINE_ERROR`] when the engine could not be
/// read — never the PREVIOUS state's line, which is what a sink that only wrote on success showed;
/// and [`STATUS_UPDATES_STOPPED`] once nothing will update it again, whatever state it last held.
pub fn tray_status_line(snapshot: Option<&Snapshot>) -> String {
    match snapshot {
        None => STATUS_UNKNOWN.to_string(),
        Some(snapshot) if snapshot.updates_stopped => STATUS_UPDATES_STOPPED.to_string(),
        Some(snapshot) => match &snapshot.schedule_state {
            Some(state) => state.tray_line(),
            None => STATUS_ENGINE_ERROR.to_string(),
        },
    }
}

/// Where a tray-icon event takes the user, if anywhere. **Pure.**
///
/// Left-click RELEASE is the primary action — the window, on Today (`show_menu_on_left_click(false)`
/// puts the menu on the right button). Every other event (right-click, a press without its release,
/// hover, a Windows double-click) does nothing here.
pub fn tray_click_route(event: &TrayIconEvent) -> Option<&'static str> {
    match event {
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => Some("today"),
        _ => None,
    }
}

/* ── the macOS app menu, as data ──────────────────────────────────────────────────────────────── */

/// One entry of the macOS app menu. Every one but [`AppMenuEntry::Quit`] is AppKit's predefined
/// item, handled natively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppMenuEntry {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    /// The one custom item: id [`APP_MENU_QUIT`], accelerator [`QUIT_ACCELERATOR`].
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Fullscreen,
    Minimize,
    Maximize,
    Separator,
}

/// A submenu. `title: None` is the application's own name (the first, "app" submenu). `id` is set
/// only where AppKit needs to find the submenu by it (see [`app_menu_spec`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppSubmenu {
    pub id: Option<&'static str>,
    pub title: Option<&'static str>,
    pub entries: &'static [AppMenuEntry],
}

/// Tauri 2.11.5's default macOS menu (`src/menu/menu.rs:142-241`, `Menu::default`), with its
/// predefined Quit REPLACED by [`AppMenuEntry::Quit`] and Show All added beside Hide Others.
/// **Pure.**
///
/// ⚠ THE EDIT SUBMENU IS NOT DECORATION. On macOS, ⌘C/⌘V/⌘A in a webview text field work only
/// because an Edit menu carries those selectors; an app menu without it breaks copy and paste in
/// every input — including B5's Settings screen.
///
/// ⚠ THE WINDOW AND HELP SUBMENUS CARRY TAURI'S IDS, and that is what makes them AppKit's. When a
/// menu is installed, tauri looks up [`WINDOW_SUBMENU_ID`] and [`HELP_SUBMENU_ID`] and registers
/// those submenus as `NSApp`'s windows menu and help menu (`src/app.rs:2487-2502`); a Window
/// submenu with any other id is an ordinary submenu, so the system's window list and the Help
/// search field never appear. Help is empty, as in tauri's own default on macOS — AppKit fills it.
pub fn app_menu_spec() -> Vec<AppSubmenu> {
    use AppMenuEntry::*;
    vec![
        AppSubmenu {
            id: None,
            title: None,
            entries: &[
                About, Separator, Services, Separator, Hide, HideOthers, ShowAll, Separator, Quit,
            ],
        },
        AppSubmenu {
            id: None,
            title: Some("File"),
            entries: &[CloseWindow],
        },
        AppSubmenu {
            id: None,
            title: Some("Edit"),
            entries: &[Undo, Redo, Separator, Cut, Copy, Paste, SelectAll],
        },
        AppSubmenu {
            id: None,
            title: Some("View"),
            entries: &[Fullscreen],
        },
        AppSubmenu {
            id: Some(WINDOW_SUBMENU_ID),
            title: Some("Window"),
            entries: &[Minimize, Maximize, Separator, CloseWindow],
        },
        AppSubmenu {
            id: Some(HELP_SUBMENU_ID),
            title: Some("Help"),
            entries: &[],
        },
    ]
}

/* ── the Quit dialog ──────────────────────────────────────────────────────────────────────────── */

/// Does the ENGINE have a `notify` config field for the offer to set?
///
/// ⚠ PINNED AGAINST THE ENGINE AT TEST TIME, not asserted here:
/// `tests/shell.rs`'s `the_engine_still_has_the_notify_field_the_offer_targets` reads
/// `src/types.ts` and requires the declaration to be there. The brief's instruction is "stub the
/// offer behind a `notify`-field check … if the engine has no `notify` field: stub + deviation" —
/// this constant IS that check, and the test is what keeps it honest when the engine changes.
pub const ENGINE_HAS_NOTIFY_FIELD: bool = true;

/// Can the offer actually be TAKEN in this build? **Yes, since B5.**
///
/// B4 shipped this `false` (deviation 12): the write is a validated config save — candidate file →
/// `config validate --json --file` → atomic tmp+rename over the path `status --json` reports, `.bak`
/// kept — and that path did not exist yet. B5 builds it once, for the Settings screen, in
/// `config_save`; the offer is `config_save::config_offer_notify_auto`, a one-field change through
/// that same pipeline. `tests/shell.rs` pins the value through [`quit_dialog_for`].
pub const NOTIFY_OFFER_WRITABLE: bool = true;

/// Why the offer cannot be taken for this state on this OS, or `None` when it can. **Pure.**
///
/// ⚠ WINDOWS: the engine's `"auto"` resolves to NO notifier there (`src/notify.ts`, `notifyArgv`
/// returns `null` for win32), so offering it would be offering silence (`docs/gui-seam.md` §4).
/// ⚠ NO USABLE CONFIG, OR NO STATE YET: there is nothing the app knows it can change; the save would
/// be refused anyway, and a button that can only fail is not an offer.
pub fn offer_unavailable_reason(copy: QuitCopy, os: &str) -> Option<&'static str> {
    if !(ENGINE_HAS_NOTIFY_FIELD && NOTIFY_OFFER_WRITABLE) {
        return Some("This build cannot change the engine's notification setting.");
    }
    if os == "windows" {
        return Some(
            "On Windows the engine's \"auto\" notification setting posts nothing, so it is not \
             offered here.",
        );
    }
    match copy {
        // Never SHOWN — a not-set-up notice has no offer section ([`QuitDialog::offer_label`] is
        // `None`) — but the field keeps its rule: never `null` while the offer is unavailable.
        QuitCopy::NotSetUp => {
            Some("Setup is not finished, so there is no engine setting to change yet.")
        }
        QuitCopy::NoWorkingConfig => Some(
            "The engine has no usable config to change right now; the Schedule screen shows \
             what is wrong.",
        ),
        QuitCopy::Unknown => Some(
            "Daily Briefing has not been able to read the engine's state, so it does not offer \
             to change the engine's settings from here.",
        ),
        QuitCopy::Scheduled | QuitCopy::NothingScheduled | QuitCopy::UnrecordedUnit => None,
    }
}

/// The Quit dialog's copy. One object, owned in Rust, carried to the webview in the
/// `app:quit-requested` payload — so there is no second copy of the wording in TypeScript to drift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitDialog {
    pub title: String,
    /// Plan R1's delegated meaning, worded for the state the app last derived ([`QuitCopy`]) and
    /// so it is true whatever the engine's `notify` is.
    pub body: String,
    /// The engine-notification offer's label — `None` when the notice has NO offer section at all
    /// ([`QuitCopy::NotSetUp`]: setup is not finished, so there is no engine setting to offer).
    pub offer_label: Option<String>,
    /// Whether the offer can be acted on here and now. See [`offer_unavailable_reason`].
    pub offer_available: bool,
    /// Why not, when it is not. Never `null` while `offer_available` is false.
    pub offer_unavailable_reason: Option<String>,
    /// A button that opens the Schedule screen instead of quitting, when the body points there
    /// (every [`QuitCopy`] but `Scheduled` and `NotSetUp`). `null` otherwise.
    pub schedule_label: Option<String>,
    pub confirm_label: String,
    pub cancel_label: String,
}

/// Which of the Quit notice's bodies is TRUE for the state the app last derived. **Pure.**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitCopy {
    /// A schedule is installed and not known to be unloaded, and the config loads (whatever
    /// today's outcome): the background scheduler keeps generating briefings while the app is
    /// closed. AGENT-STALE is here too — its unit is still registered, and "dead or asleep" is the
    /// Schedule screen's to explain, not the Quit notice's.
    Scheduled,
    /// No schedule record and no unit (`not-scheduled`), or a record whose unit is gone or unloaded
    /// (`scheduler-broken`): NOTHING generates briefings in the background, app open or not.
    NothingScheduled,
    /// No schedule record, but a unit IS present or registered (`not-scheduled` with a unit beside
    /// it). Something may still fire it and nothing says what it runs — the Schedule screen says it
    /// "cannot tell what it will do", and this says the same rather than "nothing is generating".
    UnrecordedUnit,
    /// No config file at all ([`Phase::NotConfigured`]) — the state the setup wizard opens on
    /// (`App.svelte`), i.e. setup is not finished. The notice is PLAIN: no engine-status warning,
    /// no notification offer, no Schedule button (module header).
    NotSetUp,
    /// A config that does not load: the scheduler may run, but it generates nothing.
    NoWorkingConfig,
    /// No state yet (or the engine could not be read): the app does not know which of the above
    /// is true, and must not guess.
    Unknown,
}

impl QuitCopy {
    /// ⚠ THE STATE, NOT ONLY ITS PHASE: `not-scheduled` is two different truths depending on
    /// whether a unit is there ([`ScheduleState::unit_present`], [`ScheduleState::registered`]) —
    /// the same test `Schedule.svelte` makes before it hedges.
    pub fn for_state(state: Option<&ScheduleState>) -> Self {
        let Some(state) = state else {
            return QuitCopy::Unknown;
        };
        match &state.phase {
            Phase::NotScheduled if state.unit_present || state.registered == Some(true) => {
                QuitCopy::UnrecordedUnit
            }
            Phase::NotScheduled | Phase::SchedulerBroken => QuitCopy::NothingScheduled,
            Phase::NotConfigured => QuitCopy::NotSetUp,
            Phase::ConfigError { .. } => QuitCopy::NoWorkingConfig,
            _ => QuitCopy::Scheduled,
        }
    }
}

/// The delegated Quit copy for the state the app last derived. **Pure.**
///
/// ⚠ IT DOES NOT CLAIM TO KNOW THE ENGINE'S `notify` VALUE, because it cannot: `status --json`
/// does not report it. The first wording — "Notifications will come from the system notifier
/// instead of this app" — was false in the app's own default (an `--invoker app` install leaves
/// engine notify `"off"`), i.e. it promised a notification that would never come.
///
/// ⚠ IT DOES NOT CLAIM THE APP'S NOTIFICATIONS ARE ON. Since B7 (T18) the app posts the arrival
/// notification behind its own opt-in, so the Scheduled body says quitting stops "any
/// notification this app itself would post" — conditional on purpose: the opt-in may be off or
/// never asked, and the body must be true in every one of those states.
///
/// ⚠ IT DOES NOT CLAIM A SCHEDULER THAT IS NOT THERE. "Keeps generating them" is said only for
/// [`QuitCopy::Scheduled`].
pub fn quit_dialog(state: Option<&ScheduleState>) -> QuitDialog {
    quit_dialog_for(state, std::env::consts::OS)
}

/// [`quit_dialog`] for a given `os` (`std::env::consts::OS` spelling). **Pure.**
pub fn quit_dialog_for(state: Option<&ScheduleState>, os: &str) -> QuitDialog {
    let copy = QuitCopy::for_state(state);
    let unavailable = offer_unavailable_reason(copy, os);
    let body = match copy {
        QuitCopy::Scheduled => {
            // ⚠ REWORDED IN B7 (T11 rework): since T18 the app CAN post the arrival notification
            // (when enabled in Settings), and that is exactly what quitting stops — so the offer
            // of the engine's own notifier is the fallback for a closed app, not a hypothetical.
            // It still does not claim to know the engine's `notify` value (`status --json` does
            // not report it) and does not claim the app WILL notify (the opt-in may be off).
            // ⚠ HEDGED IN THE B7 FIX ROUND (deviation 119): "depends ONLY on the engine's own
            // notification setting" promised the engine's banner works when set, and the engine's
            // own header says an osascript banner "may not post at all from a launchd agent" —
            // which is exactly how the engine runs. The wording now leaves room for the setup.
            "Quitting does not stop your briefings — the background scheduler keeps generating \
             them while this app is closed. What stops is any notification this app itself would \
             post when one arrives; whether you are told then depends on the engine's own \
             notification setting — and on whether your setup shows its banner — neither of which \
             quitting changes."
        }
        QuitCopy::NothingScheduled => {
            "Nothing is generating briefings in the background on this machine right now — no \
             working scheduler is installed — and quitting changes nothing about that. To have \
             them generated while this app is closed, set the scheduler up on the Schedule screen \
             first."
        }
        QuitCopy::UnrecordedUnit => {
            "A background scheduler unit exists on this machine, but there is no ownership record \
             beside it, so Daily Briefing cannot say whether briefings will keep arriving while it \
             is closed. Quitting does not change that unit; the Schedule screen shows what is known \
             about it."
        }
        QuitCopy::NotSetUp => {
            "Setup isn't finished yet. You can quit now — setup will be offered again the next \
             time you open Daily Briefing."
        }
        QuitCopy::NoWorkingConfig => {
            "Quitting changes nothing about your schedule, but no briefing is being generated \
             right now: the engine has no usable config. The Schedule screen shows what is wrong."
        }
        QuitCopy::Unknown => {
            "Daily Briefing has not been able to read the engine's state, so it cannot say \
             whether briefings will keep arriving while it is closed. Quitting does not change \
             the schedule itself; the Schedule screen shows what could be read."
        }
    };
    QuitDialog {
        title: "Quit Daily Briefing?".into(),
        body: body.into(),
        offer_label: (copy != QuitCopy::NotSetUp)
            .then(|| "Switch engine notifications to auto".to_string()),
        offer_available: unavailable.is_none(),
        offer_unavailable_reason: unavailable.map(str::to_string),
        schedule_label: (!matches!(copy, QuitCopy::Scheduled | QuitCopy::NotSetUp))
            .then(|| "Open Schedule".to_string()),
        confirm_label: "Quit".into(),
        cancel_label: "Keep running".into(),
    }
}

/// What a quit request should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitAction {
    /// Show the window and hand the webview the dialog.
    ShowNotice,
    /// The notice has already been shown this session; exit.
    ExitNow,
}

/// **Pure.** Appendix T11: *"Quit dialog appears exactly once per session."*
pub fn quit_action(notice_already_shown: bool) -> QuitAction {
    if notice_already_shown {
        QuitAction::ExitNow
    } else {
        QuitAction::ShowNotice
    }
}

/// What closing the main window should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide it; the tray is how the user gets it back.
    HideToTray,
    /// There is nothing to hide INTO, so closing is a quit request ([`request_quit`]).
    QuitFlow,
}

/// **Pure.** `os` is `std::env::consts::OS`.
///
/// ⚠ HIDE ONLY WHERE A TRAY IS KNOWN TO BE THERE. With no tray, a hidden window is an app the user
/// cannot see, reach or quit. On Linux a built tray is NOT evidence of a visible one: `tray-icon`
/// cannot detect a missing StatusNotifierItem host (bare GNOME has none), so construction
/// "succeeds" into nothing — and so Linux never hides (deviation register).
pub fn close_action(tray_built: bool, os: &str) -> CloseAction {
    if tray_built && os != "linux" {
        CloseAction::HideToTray
    } else {
        CloseAction::QuitFlow
    }
}

/// The notice the webview shows once when the tray could not be built. **Pure.**
pub fn tray_unavailable_notice(error: &str) -> String {
    format!(
        "The menu-bar icon could not be created ({error}), so Daily Briefing is running as an \
         ordinary window. Closing the window asks whether to quit instead of hiding it, and the \
         tray's actions are in the window itself."
    )
}

/// What the app does with the result of building the tray. **Pure over `state`.**
///
/// Sets whether closing hides to the tray ([`close_action`] for `os`) and, when the build failed,
/// queues the one-time in-window notice and says so on stderr. `setup` is its only caller, with
/// `std::env::consts::OS`; it is a function of its own so the decision is tested per platform
/// without a tray, a display server or a run loop.
pub fn after_tray_build(state: &ShellState, built: Result<(), &str>, os: &str) {
    if let Err(e) = built {
        // Appendix §12's stated degradation, and the same posture as a missing sidecar: say what
        // failed — in the WINDOW, once, not only on stderr — and keep running.
        eprintln!("daily-briefing: the tray could not be created ({e}); running window-only.");
        state.set_tray_notice(tray_unavailable_notice(e));
    }
    state.set_close_hides_to_tray(close_action(built.is_ok(), os) == CloseAction::HideToTray);
}

/// Run a tray build, turning a PANIC into an error.
///
/// ⚠ A TRAY BACKEND CAN PANIC RATHER THAN FAIL. UNVERIFIED on a host (no Linux host in this build;
/// source: V2 review): `libappindicator-sys` 0.9.0 (`src/lib.rs:41-54`) `panic!`s when neither
/// `ayatana-appindicator3` nor `appindicator3` can be loaded — which a bare Linux desktop may lack.
/// `setup` runs on the main thread, where tauri executes the tray build inline
/// (`tauri-runtime-wry` `send_user_message`), so that panic would unwind through `setup` and take
/// the app down before its window appears. Caught, it is a failed tray like any other, and the app
/// runs window-only with the notice.
pub fn catch_tray_build<T>(build: impl FnOnce() -> tauri::Result<T>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(build)) {
        Ok(Ok(built)) => Ok(built),
        Ok(Err(e)) => Err(e.to_string()),
        Err(panic) => Err(format!(
            "the tray backend panicked: {}",
            panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "no message".to_string())
        )),
    }
}

/// The shell's per-app state: the quit latch, what closing does, the pending tray notice, the
/// state the Quit notice's wording depends on, and whether live updates have stopped.
///
/// ⚠ MANAGED STATE, NOT A PROCESS GLOBAL. It used to be a `static AtomicBool`, which made every
/// test that touched it own the whole process; per app, each MockRuntime app in a test has its own.
#[derive(Debug, Default)]
pub struct ShellState {
    quit_notice_shown: AtomicBool,
    close_hides_to_tray: AtomicBool,
    tray_notice: Mutex<Option<String>>,
    /// The derived state of the last snapshot the app announced (`None` before the first, or when
    /// it had no state). Written by [`AppState`]; read by [`request_quit`] for [`quit_dialog`].
    last_state: Mutex<Option<ScheduleState>>,
    /// The notice the watcher's last snapshot led with, once it has STOPPED. Written by
    /// [`AppState`]; [`state_snapshot`] repeats it on every later read.
    updates_stopped: Mutex<Option<String>>,
}

impl ShellState {
    /// A quit request: the first one this session shows the notice, every later one exits.
    ///
    /// ⚠ THE LATCH IS SET WHEN THE NOTICE GOES OUT, not when the user acknowledges it. A webview
    /// that dropped the event would leave `app_quit` callable without the dialog having been
    /// seen; the alternative — an acknowledgement command — is one more IPC surface for a case with
    /// no observed occurrence. Recorded, not fixed.
    pub fn request_quit(&self) -> QuitAction {
        quit_action(self.quit_notice_shown.swap(true, Ordering::SeqCst))
    }

    pub fn quit_notice_shown(&self) -> bool {
        self.quit_notice_shown.load(Ordering::SeqCst)
    }

    pub fn set_close_hides_to_tray(&self, hides: bool) {
        self.close_hides_to_tray.store(hides, Ordering::SeqCst);
    }

    /// `false` until `setup` has built a tray it trusts — so a close before that is a quit request.
    pub fn close_hides_to_tray(&self) -> bool {
        self.close_hides_to_tray.load(Ordering::SeqCst)
    }

    pub fn set_tray_notice(&self, notice: String) {
        if let Ok(mut slot) = self.tray_notice.lock() {
            *slot = Some(notice);
        }
    }

    /// The pending notice, at most once per session.
    pub fn take_tray_notice(&self) -> Option<String> {
        self.tray_notice
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }

    /// Remember the derived state of the snapshot about to be announced.
    pub fn note_state(&self, state: Option<&ScheduleState>) {
        if let Ok(mut slot) = self.last_state.lock() {
            *slot = state.cloned();
        }
    }

    /// The derived state of the last announced snapshot, if it had one.
    pub fn last_state(&self) -> Option<ScheduleState> {
        self.last_state.lock().ok().and_then(|slot| slot.clone())
    }

    /// Remember that the watcher has stopped, and the notice it said so with. Never cleared: a
    /// stopped watcher is not restarted this session.
    pub fn note_updates_stopped(&self, notice: &str) {
        if let Ok(mut slot) = self.updates_stopped.lock() {
            *slot = Some(notice.to_string());
        }
    }

    /// The stopped watcher's notice, once there is one.
    pub fn updates_stopped(&self) -> Option<String> {
        self.updates_stopped
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }
}

/* ── the engine-backed snapshot source ────────────────────────────────────────────────────────── */

/// How long one `status --json` / `schedule status --json` may take before it is abandoned.
///
/// ⚠ A HUNG READ MUST NOT WEDGE THE WATCHER. `schedule status` runs `launchctl list`, which can
/// hang; the watcher's thread would hang with it and live updates would stop for the session.
///
/// ⚠ WHAT THE TIMEOUT KILLS — measured, not inferred. Dropping the timed-out future drops B3's
/// invocation future, which on unix SIGKILLs the whole process GROUP the spawn was put in
/// (`engine::ProcessGroupKill`; non-unix keeps `kill_on_drop`'s single pid): the sidecar (under
/// `caffeinate -i`, which `exec`s into the spawned pid), the assertion holder it forked, and a
/// hung `launchctl list` it forked — which
/// `kill_on_drop` alone could not reach, and which used to be orphaned to pid 1 as the documented
/// residual (`docs/gui-seam.md` §9, deviation 30, now retired; measured with a fake sidecar that
/// forks rather than `exec`s: `tests/watcher.rs`,
/// `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked`). This timeout is still the only
/// place the shipped app drops an engine future mid-flight, and reads can overlap: the watcher's
/// own are serial on its thread, but `state_snapshot` reads through the same [`EngineSnapshots`]
/// with the same timeout, concurrently with them.
pub const ENGINE_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Produces a [`Snapshot`] by invoking the engine. The app's [`SnapshotSource`].
///
/// ⚠ EVERY SNAPSHOT READS BOTH ENVELOPES, AND THE CACHE IS ONLY A FALLBACK. `schedule status
/// --json` recomputes the tick count, the tick state, the unit's presence and — through a real
/// `launchctl list` (`src/schedule/status.ts`, `isRegistered`) — its registration on every call, so
/// an envelope from an earlier read is an answer about an earlier moment. (An earlier version
/// cached it until `schedule.json` changed, reasoning that it "changes when somebody installs or
/// removes a schedule"; measured, that held `ticksToday` at 4 while `last-tick` said 11, kept a
/// replaced legacy heartbeat UNKNOWN, and kept an unloaded unit "registered". The cost of reading
/// it fresh is one extra spawn per engine read — see `watcher.rs`'s header for the rates.)
///
/// The last good envelope is kept for ONE purpose: when this read's `schedule status` fails, it is
/// still fed to [`schedule_state::derive`] — a state derived WITHOUT the schedule is not a cheaper
/// state, it is a different one — and the snapshot is marked [`Snapshot::schedule_stale`], with the
/// per-read facts withheld and `error` saying why. A FAILED read never replaces it.
pub struct EngineSnapshots {
    /// ⚠ THE STARTUP `Result`, NOT AN UNWRAPPED CLIENT — the same shape as `engine::Engine` and for
    /// the same reason: an app whose sidecar is missing still opens, and every read then reports
    /// that fact with the path it looked at instead of panicking at managed-state resolution time.
    client: Result<EngineClient, EngineError>,
    schedule: Mutex<Option<serde_json::Value>>,
    timeout: Duration,
}

impl EngineSnapshots {
    pub fn new(client: Result<EngineClient, EngineError>) -> Self {
        Self {
            client,
            schedule: Mutex::new(None),
            timeout: ENGINE_READ_TIMEOUT,
        }
    }

    /// The same source with a different read timeout. Tests use it; the app uses the default.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn cached_schedule(&self) -> Option<serde_json::Value> {
        self.schedule.lock().ok().and_then(|s| s.clone())
    }

    /// One engine read: its envelope, or why there is none.
    async fn read(
        &self,
        client: &EngineClient,
        op: Operation,
    ) -> Result<serde_json::Value, String> {
        let what = op.argv().join(" ");
        match tokio::time::timeout(self.timeout, client.invoke(op, &NoProgress)).await {
            Err(_) => Err(format!(
                "`{what}` did not answer within {} and was stopped",
                describe(self.timeout)
            )),
            Ok(Err(e)) => Err(e.to_string()),
            Ok(Ok(outcome)) => envelope_of(outcome, &what),
        }
    }

    /// The snapshot: `status --json`, then `schedule status --json`, both read now. The watcher's
    /// blocking form is [`SnapshotSource::snapshot`].
    pub async fn snapshot_async(&self) -> Snapshot {
        let client = match self.client.as_ref() {
            Ok(client) => client,
            Err(e) => return Snapshot::unavailable(e.to_string()),
        };
        let status = match self.read(client, Operation::Status).await {
            Ok(payload) => payload,
            Err(detail) => return Snapshot::unavailable(detail),
        };
        let now = schedule_state::now_local();
        match self.read(client, Operation::ScheduleStatus).await {
            Ok(payload) => {
                if let Ok(mut slot) = self.schedule.lock() {
                    *slot = Some(payload.clone());
                }
                Snapshot::build(Some(status), Some(payload), &now, None)
            }
            // ⚠ A FAILED SCHEDULE READ KEEPS THE LAST GOOD ENVELOPE AND SAYS SO — BOTH HALVES.
            // Losing it would derive a different state (no owner, no interval, no registration);
            // keeping it silently would show an earlier moment's schedule as current.
            Err(detail) => match self.cached_schedule() {
                Some(cached) => {
                    Snapshot::with_stale_schedule(Some(status), cached, &now, Some(detail))
                }
                None => Snapshot::build(Some(status), None, &now, Some(detail)),
            },
        }
    }
}

/// The envelope of a completed read, or the engine's own words for why it is not usable.
///
/// Usable means: the engine exited 0 (`Delivered`, or `Skipped` — which a read never produces, but
/// which is still a zero exit) AND printed JSON. Anything else — exit 1, exit 2, a signal, output
/// that is not JSON — is an ERROR, carrying stderr verbatim; it used to be an `Ok(None)` that the
/// snapshot rendered as "no state" with `error: null`.
fn envelope_of(outcome: EngineOutcome, what: &str) -> Result<serde_json::Value, String> {
    let succeeded = matches!(
        outcome.outcome,
        Outcome::Delivered | Outcome::Skipped { .. }
    );
    if let (true, Some(payload)) = (succeeded, outcome.payload) {
        return Ok(payload);
    }
    let stderr = outcome.stderr.trim_end();
    if !stderr.is_empty() {
        return Err(format!("`{what}` failed: {stderr}"));
    }
    Err(match outcome.exit_code {
        Some(0) => format!("`{what}` exited 0 without printing a JSON envelope"),
        Some(code) => format!("`{what}` exited {code} and wrote nothing to stderr"),
        None => format!("`{what}` was killed by a signal and wrote nothing to stderr"),
    })
}

fn describe(d: Duration) -> String {
    if d.as_secs() >= 1 && d.subsec_millis() == 0 {
        format!("{}s", d.as_secs())
    } else {
        format!("{}ms", d.as_millis())
    }
}

impl SnapshotSource for EngineSnapshots {
    /// ⚠ `block_on`, SO THIS IS FOR THE WATCHER'S OWN THREAD ONLY. Called from inside the async
    /// runtime it panics ("Cannot start a runtime from within a runtime") — the `#[tauri::command]`
    /// path uses [`EngineSnapshots::snapshot_async`] instead. One implementation, two entry points.
    fn snapshot(&self) -> Snapshot {
        tauri::async_runtime::block_on(self.snapshot_async())
    }
}

/// The shipping sink: `state:changed` to the webview, and the tray status line beside it.
pub struct AppState<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AppState<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> StateSink for AppState<R> {
    fn changed(&self, snapshot: &Snapshot) {
        // What the Quit notice's wording and `state_snapshot` depend on — recorded BEFORE anything
        // is announced, so a quit request or a refresh racing this snapshot never answers for an
        // older one than the tray and the window show. `tests/shell.rs` pins the order with a Rust
        // listener, which tauri runs inside `emit`.
        if let Some(shell) = self.app.try_state::<ShellState>() {
            shell.note_state(snapshot.schedule_state.as_ref());
            if let Some(notice) = snapshot.stopped_notice() {
                shell.note_updates_stopped(notice);
            }
        }
        // T18: the delegated-arm notification decision — every announced snapshot passes through
        // the transition machine. A no-op on an app that manages no `NotifyState` (every pre-B7
        // fixture); the suite's `NotifyState`s carry a recording sink, so nothing is ever posted
        // from a test (`docs/gui-seam.md` §12c).
        crate::notifications::on_snapshot(&self.app, snapshot);
        // A failed emit is not a reason to stop watching: the next change re-sends everything, and
        // the webview can always ask for a snapshot itself.
        let _ = self.app.emit(EVENT_STATE_CHANGED, snapshot);
        // `try_state`, never `state`: the latter PANICS when nothing of that type is managed, and a
        // tray that failed to build is exactly the configuration where that happens.
        if let Some(tray) = self.app.try_state::<TrayHandle<R>>() {
            if let Ok(item) = tray.0.lock() {
                if let Some(item) = item.as_ref() {
                    let _ = item.set_text(tray_status_line(Some(snapshot)));
                }
            }
        }
    }
}

/// The tray's status line, kept as managed state so a later snapshot can rewrite it. `None` when
/// the tray could not be created.
///
/// Not `#[derive(Clone)]` and not a bag of parts: `MenuItem<R>` is the only handle an update needs,
/// and a derived `Clone` on a struct generic over `R` would demand `R: Clone`, which no `Runtime`
/// is.
pub struct TrayHandle<R: Runtime>(pub Mutex<Option<MenuItem<R>>>);

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// The current state, on demand.
///
/// The webview calls this at startup — AFTER its listeners are registered — and then lives on
/// `state:changed`. It is also where a pending one-time [`EVENT_TRAY_UNAVAILABLE`] notice is
/// delivered: an event emitted from `setup` would fire before any listener exists, and this call
/// is the first moment the webview is known to be listening.
///
/// ⚠ A STOPPED WATCHER STAYS STOPPED ACROSS A REFRESH. The read here is fresh, but nothing will
/// update it afterwards, so once the watcher has stopped the answer carries `updatesStopped` and
/// leads its `error` with the watcher's notice — otherwise a webview reload would clear the "live
/// updates stopped" message while the tray still shows it.
#[tauri::command]
pub async fn state_snapshot<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    snapshots: State<'_, Arc<EngineSnapshots>>,
) -> Result<Snapshot, EngineError> {
    let notice = app
        .try_state::<ShellState>()
        .and_then(|shell| shell.take_tray_notice());
    if let Some(notice) = notice {
        let _ = app.emit(EVENT_TRAY_UNAVAILABLE, notice);
    }
    // Surfaced as the typed error rather than folded into `Snapshot.error`, so a missing sidecar
    // reads the same here as it does from every other command (`docs/gui-seam.md` §1a).
    engine.client()?;
    let mut snapshot = snapshots.snapshot_async().await;
    if let Some(notice) = app
        .try_state::<ShellState>()
        .and_then(|shell| shell.updates_stopped())
    {
        snapshot.mark_updates_stopped(&notice);
    }
    Ok(snapshot)
}

/// Show and focus the window, on the Today screen.
///
/// ⚠ A RUST COMMAND BECAUSE THE WEBVIEW'S CAPABILITY GRANTS NO WINDOW CONTROL AT ALL — it names no
/// `core:window:*` permission, and even `core:window:default` would not grant `show` or
/// `set_focus` (both are declared `false` in `tauri-2.11.5/build.rs`). The tray, the
/// single-instance callback and T16/T18 all need something that can raise the window.
#[tauri::command]
pub fn open_today<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    focus_main(&app)?;
    let _ = app.emit(EVENT_NAVIGATE, "today");
    Ok(())
}

/// Exit, after the Quit notice has been shown.
///
/// ⚠ IT REFUSES WHEN THE NOTICE HAS NOT BEEN SHOWN THIS SESSION, and that is not ceremony: this
/// command is the webview's half of an explicit, confirmed Quit. A webview that could call it cold
/// would be able to close the app without the one dialog whose absence the appendix names as "the
/// single most likely support complaint".
///
/// `AppHandle::exit` rather than `std::process::exit`: `tauri-plugin-window-state` saves the
/// window geometry on `RunEvent::Exit` (`src/lib.rs:501-505`), which a raw process exit skips.
#[tauri::command]
pub fn app_quit<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let shown = app
        .try_state::<ShellState>()
        .is_some_and(|shell| shell.quit_notice_shown());
    if !shown {
        return Err("the quit notice has not been shown this session".into());
    }
    app.exit(0);
    Ok(())
}

/// Every command this module exposes, in the order `lib.rs` registers them.
///
/// The engine's list is `engine::COMMANDS`; `crate::all_commands()` is the two concatenated, and
/// `tests/capability.rs` pins that against the capability, `build.rs` and `generate_handler!`.
pub const COMMANDS: &[&str] = &["state_snapshot", "open_today", "app_quit"];

/* ── wiring ───────────────────────────────────────────────────────────────────────────────────── */

fn focus_main<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("there is no window labelled `{MAIN_WINDOW}`"))?;
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

fn hide_main<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| format!("there is no window labelled `{MAIN_WINDOW}`"))?
        .hide()
        .map_err(|e| e.to_string())
}

/// Raise the window and ask for `route`.
fn show_route<R: Runtime>(app: &AppHandle<R>, route: &str) {
    let _ = focus_main(app);
    let _ = app.emit(EVENT_NAVIGATE, route);
}

/// **THE** quit path. Tray Quit, the app menu's Quit and a close with nothing to hide into all
/// come here: the first request this session shows the notice, a later one exits.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let Some(shell) = app.try_state::<ShellState>() else {
        // `lib.rs` always manages it; an app without it has no notice to show, and refusing to
        // quit would leave it unquittable.
        app.exit(0);
        return;
    };
    // ⚠ THE LATCH IS SET BEFORE THE NOTICE IS EMITTED (`request_quit` swaps it), and
    // `tests/shell.rs` pins that order with a Rust listener, which tauri runs INSIDE `emit`: a
    // webview whose confirm button raced the event must find `app_quit` already allowed.
    match shell.request_quit() {
        QuitAction::ShowNotice => {
            let _ = focus_main(app);
            let dialog = quit_dialog(shell.last_state().as_ref());
            let _ = app.emit(EVENT_QUIT_REQUESTED, dialog);
        }
        QuitAction::ExitNow => app.exit(0),
    }
}

/// Every menu event — the tray's AND the app menu's. Registered ONCE, on the builder.
///
/// ⚠ ONCE, AND NOT ALSO ON THE TRAY. `TrayIconBuilder::on_menu_event`'s handler "is called for any
/// menu event, whether it is coming from this window, another window or from the tray icon menu"
/// (tauri 2.11.5 `src/tray/mod.rs:324-327`), so registering this in both places would run every
/// Quit twice — the first showing the notice, the second exiting past it.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_OPEN_BRIEFING => show_route(app, "today"),
        MENU_RUN_NOW => {
            // ⚠ THE TRAY ASKS THE WEBVIEW TO RUN; IT DOES NOT RUN. `engine_run` streams
            // `engine:progress` and the screen is what shows it, so a tray-initiated run that
            // bypassed the webview would be a briefing generated with no visible progress and no
            // place for its result to land.
            show_route(app, "today");
            let _ = app.emit(EVENT_RUN_NOW, ());
        }
        MENU_SCHEDULE_SETTINGS => show_route(app, "schedule"),
        MENU_SETTINGS => show_route(app, "settings"),
        MENU_QUIT | APP_MENU_QUIT => request_quit(app),
        _ => {}
    }
}

/// The app's run-loop callback (`lib.rs`: `.build(…)?.run(shell::on_run_event)`).
///
/// A RUN-LOOP callback rather than a per-window `on_window_event`, for a measured reason: the
/// MockRuntime delivers `CloseRequested` to this callback and honours `prevent_close` there, while
/// a per-window handler is never called under it — so only this shape can be tested headless.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: RunEvent) {
    match event {
        // A Dock click, or a relaunch that single-instance did not catch, on an app whose window
        // is hidden: without this, nothing appears.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            let _ = focus_main(app);
        }
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == MAIN_WINDOW => {
            let Some(shell) = app.try_state::<ShellState>() else {
                return; // an ordinary close
            };
            api.prevent_close();
            if shell.close_hides_to_tray() {
                // ⚠ CLOSE HIDES, IT DOES NOT QUIT (appendix T11) — where there is a tray to come
                // back from.
                let _ = hide_main(app);
            } else {
                request_quit(app);
            }
        }
        _ => {}
    }
}

/// The tray icon bytes.
///
/// ⚠ macOS TAKES THE @2x FILE, AND THAT IS MEASURED RATHER THAN ASSUMED. `tray-icon` 0.24.2
/// (`src/platform_impl/macos/mod.rs:295-307`) forces every menu-bar image to a LOGICAL height of
/// 18pt whatever its pixel size, so handing it the 36×36 bitmap yields 18pt at 2× — crisp on a
/// Retina display — while the 18×18 would be upscaled. Elsewhere the raw size is used, so the 1×
/// file is the one that belongs there. Both are committed; both are used.
#[cfg(target_os = "macos")]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-template@2x.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-template.png");

/// Build the tray. Returns the status [`MenuItem`] so later snapshots can rewrite its label.
/// Menu events are NOT handled here — see [`on_menu_event`].
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItem<R>> {
    let specs = tray_menu_items(None);
    let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
    let mut status_item: Option<MenuItem<R>> = None;
    for spec in &specs {
        let item = MenuItem::with_id(app, spec.id, &spec.label, spec.enabled, None::<&str>)?;
        if spec.id == MENU_STATUS {
            status_item = Some(item.clone());
        }
        items.push(Box::new(item));
        if spec.separator_after {
            items.push(Box::new(PredefinedMenuItem::separator(app)?));
        }
    }
    let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;

    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(TRAY_ICON_PNG)?)
        // macOS template image: the system recolours it for the light/dark menu bar.
        .icon_as_template(true)
        .tooltip("Daily Briefing")
        .menu(&menu)
        // ⚠ `show_menu_on_left_click`, NOT the appendix's `menuOnLeftClick`: the latter is the
        // deprecated spelling in 2.11.5 (`tauri/src/tray/mod.rs:307`) and `-D warnings` refuses it.
        // Same semantics — left-click is the PRIMARY action (open the window on Today), the menu
        // is on right-click.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let Some(route) = tray_click_route(&event) {
                show_route(tray.app_handle(), route);
            }
        })
        .build(app)?;

    status_item.ok_or_else(|| {
        tauri::Error::Io(std::io::Error::other(
            "the tray menu spec has no status entry",
        ))
    })
}

/// The macOS app menu, built from [`app_menu_spec`]. `lib.rs` installs it on macOS only.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let mut submenus: Vec<Submenu<R>> = Vec::new();
    for spec in app_menu_spec() {
        let mut items: Vec<Box<dyn IsMenuItem<R>>> = Vec::new();
        for entry in spec.entries {
            items.push(app_menu_item(app, *entry, &name)?);
        }
        let refs: Vec<&dyn IsMenuItem<R>> = items.iter().map(|i| i.as_ref()).collect();
        let title = spec.title.map_or_else(|| name.clone(), str::to_string);
        submenus.push(match spec.id {
            Some(id) => Submenu::with_id_and_items(app, id, title, true, &refs)?,
            None => Submenu::with_items(app, title, true, &refs)?,
        });
    }
    let refs: Vec<&dyn IsMenuItem<R>> = submenus.iter().map(|s| s as &dyn IsMenuItem<R>).collect();
    Menu::with_items(app, &refs)
}

fn app_menu_item<R: Runtime>(
    app: &AppHandle<R>,
    entry: AppMenuEntry,
    name: &str,
) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    use AppMenuEntry::*;
    Ok(match entry {
        About => Box::new(PredefinedMenuItem::about(
            app,
            None,
            Some(AboutMetadata {
                name: Some(name.to_string()),
                version: Some(app.package_info().version.to_string()),
                ..Default::default()
            }),
        )?),
        Services => Box::new(PredefinedMenuItem::services(app, None)?),
        Hide => Box::new(PredefinedMenuItem::hide(app, None)?),
        HideOthers => Box::new(PredefinedMenuItem::hide_others(app, None)?),
        ShowAll => Box::new(PredefinedMenuItem::show_all(app, None)?),
        Quit => Box::new(MenuItem::with_id(
            app,
            APP_MENU_QUIT,
            format!("Quit {name}"),
            true,
            Some(QUIT_ACCELERATOR),
        )?),
        CloseWindow => Box::new(PredefinedMenuItem::close_window(app, None)?),
        Undo => Box::new(PredefinedMenuItem::undo(app, None)?),
        Redo => Box::new(PredefinedMenuItem::redo(app, None)?),
        Cut => Box::new(PredefinedMenuItem::cut(app, None)?),
        Copy => Box::new(PredefinedMenuItem::copy(app, None)?),
        Paste => Box::new(PredefinedMenuItem::paste(app, None)?),
        SelectAll => Box::new(PredefinedMenuItem::select_all(app, None)?),
        Fullscreen => Box::new(PredefinedMenuItem::fullscreen(app, None)?),
        Minimize => Box::new(PredefinedMenuItem::minimize(app, None)?),
        Maximize => Box::new(PredefinedMenuItem::maximize(app, None)?),
        Separator => Box::new(PredefinedMenuItem::separator(app)?),
    })
}

/// Everything T11 wires at startup, called from `lib.rs`'s `setup`.
///
/// Ordered deliberately: the tray first (so a snapshot arriving a moment later has a status item to
/// write into, and so the close behaviour is known), then the watcher — which needs one
/// `status --json` to learn the state directory it is supposed to watch.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let built = catch_tray_build(|| build_tray(app));
    let outcome = built.as_ref().map(|_| ()).map_err(String::as_str);
    if let Some(shell) = app.try_state::<ShellState>() {
        after_tray_build(&shell, outcome, std::env::consts::OS);
    }
    app.manage(TrayHandle(Mutex::new(built.ok())));
    start_watcher(app);
}

/// How [`start_watcher_with`] backs off while the engine cannot tell it where to watch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub first: Duration,
    pub max: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            first: Duration::from_secs(2),
            max: Duration::from_secs(60),
        }
    }
}

impl RetryPolicy {
    /// `first`, doubling per attempt, capped at `max`. **Pure.**
    pub fn delay(&self, attempt: u32) -> Duration {
        self.first
            .checked_mul(1u32.checked_shl(attempt).unwrap_or(u32::MAX))
            .unwrap_or(self.max)
            .min(self.max)
    }
}

/// Learn the state directory from `status --json`, then watch it — with the app's retry policy.
pub fn start_watcher<R: Runtime>(app: &AppHandle<R>) {
    start_watcher_with(app, RetryPolicy::default());
}

/// Asynchronous and fire-and-forget on purpose: a slow or missing engine must not delay the window
/// appearing.
///
/// ⚠ IT RETRIES. A first `status --json` that fails (the engine was mid-update, a hung
/// `launchctl`, a sidecar that appears later) used to switch live updates off for the whole
/// session. Now each failed attempt is emitted — so the tray says "Engine unavailable" and the
/// window says why — and retried with backoff until a watcher is running.
pub fn start_watcher_with<R: Runtime>(app: &AppHandle<R>, retry: RetryPolicy) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(snapshots) = app
            .try_state::<Arc<EngineSnapshots>>()
            .map(|s| Arc::clone(&s))
        else {
            return;
        };
        let sink = Arc::new(AppState::new(app.clone()));
        let mut last_emitted: Option<Snapshot> = None;
        let mut attempt: u32 = 0;
        loop {
            let first = snapshots.snapshot_async().await;
            // The first snapshot is worth sending — it is what the tray's line becomes — and a
            // failing one is worth sending once, not once per retry.
            if last_emitted.as_ref() != Some(&first) {
                sink.changed(&first);
                last_emitted = Some(first.clone());
            }
            let targets = first
                .status
                .as_ref()
                .and_then(|v| serde_json::from_value::<StatusView>(v.clone()).ok())
                .as_ref()
                .and_then(WatchTargets::from_status);
            let delay = retry.delay(attempt);
            match targets {
                None => eprintln!(
                    "daily-briefing: `status --json` did not report a state directory; retrying \
                     live updates in {}.",
                    describe(delay)
                ),
                Some(targets) => {
                    let opts = WatchOptions {
                        initial: Some(first),
                        ..WatchOptions::default()
                    };
                    match watcher::spawn_with(targets, snapshots.clone(), sink.clone(), opts) {
                        Ok(w) => {
                            // Held for the life of the app; dropping it would stop the thread.
                            app.manage(Mutex::new(w));
                            return;
                        }
                        Err(e) => eprintln!(
                            "daily-briefing: the state-directory watcher could not start ({e}); \
                             retrying in {}.",
                            describe(delay)
                        ),
                    }
                }
            }
            tokio::time::sleep(delay).await;
            attempt = attempt.saturating_add(1);
        }
    });
}
