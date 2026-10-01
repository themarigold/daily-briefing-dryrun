//! T19 — autostart (login item), default ON.
//!
//! ## The shape: the plugin's commands ARE the webview surface
//!
//! Unlike every other power in this app, T19's three operations are granted to the webview as the
//! PLUGIN's own commands — `autostart:allow-enable` / `allow-disable` / `allow-is-enabled`, the
//! whole of `tauri-plugin-autostart 2.5.1`'s shipped allow-set (its `permissions/default.toml` is
//! exactly those three; each is justified in `capabilities/README.md`). The Settings toggle lives
//! in the webview and must reflect REAL state via `is_enabled()` on every render — never a cached
//! boolean — and the plugin's `is_enabled` is precisely that read (a `stat` of the LaunchAgent
//! plist). Wrapping the three in app commands would add a fourth spelling of the same three powers
//! and no validation: none takes an operand at all.
//!
//! ## What the REAL calls touch, and why the suite never makes them
//!
//! `MacosLauncher::LaunchAgent`: `enable()` WRITES `~/Library/LaunchAgents/<app name>.plist` and
//! `disable()` REMOVES it (`auto-launch-0.5.0/src/macos.rs` — `get_file()` is
//! `~/Library/LaunchAgents/{app_name}.plist`, `Label` is `app_name`). Both are VM-gated: no test,
//! build step or probe calls them against the live plugin state (`docs/gui-seam.md` §12c). The
//! default-ON decision below is a pure rule behind the injectable [`AutostartSink`], and the suite
//! drives a recorder.
//!
//! ## THE LABEL TEST (appendix, binding)
//!
//! The CLI scheduler owns the launchd label `local.daily-briefing`
//! (`src/schedule/units.ts:44`, `SCHEDULE_LABEL`) and its unit file
//! `~/Library/LaunchAgents/local.daily-briefing.plist`. The autostart plist must NOT collide with
//! either name, or the login item and the scheduler would fight over one launchd label. The
//! plugin's derivation, read from its source rather than assumed: `tauri-plugin-autostart` builds
//! `AutoLaunch` with `app_name` defaulting to `app.package_info().name`
//! (`tauri-plugin-autostart-2.5.1/src/lib.rs`, `Builder::build`'s setup), which tauri's codegen
//! sets to `tauri.conf.json`'s `productName` (`tauri-codegen-2.6.3/src/context.rs:268-271`) —
//! `"Daily Briefing"` — and `auto-launch` uses that string as BOTH the plist's `Label` and its
//! file name. `tests/autostart.rs`'s `the_autostart_label_cannot_collide_with_the_schedulers`
//! reads the engine's constant out of `src/schedule/units.ts` and the app's name out of the built
//! `package_info()` at test time, so a change to EITHER side goes red rather than colliding
//! silently. `lib.rs` must keep the plugin's default `app_name` (no `.app_name(…)` override, no
//! builder form) — the same test pins that as source.
//!
//! ## Default ON (plan R1), as a one-shot
//!
//! "Autostart default ON" cannot mean "enable at every launch": `is_enabled()` reflects the
//! user's real choice, and re-enabling at launch would override a user who turned it off. The
//! shipped meaning is a FIRST-LAUNCH one-shot: with no record that the default was ever applied,
//! [`startup`] enables once and records it (`<app_data_dir>/autostart-state.json`); from then on
//! the plist belongs to the user's toggle. A failed enable is logged and NOT recorded, so the
//! next launch retries — one idempotent plist write per launch, at worst, until it succeeds.
//!
//! ⚠ RECORD LOSS FAILS TOWARD THE USER'S LAST KNOWN CHOICE, NOT TOWARD THE DEFAULT. Only a file
//! that is ABSENT reads as "not yet defaulted" (a genuine first launch); a file that is PRESENT
//! but unreadable or unparseable reads as `{ defaulted: true }` ([`read_record`]). The first
//! shape of this module degraded every failure to `Default`, and the failure that matters is
//! exactly the one that made that wrong: a corrupt or truncated record re-fired the one-shot and
//! RE-CREATED a login item the user had deleted — an "idempotent redundant `enable()`" only for
//! a user who never turned autostart off. The cost of the fail-safe direction is one skipped
//! default on a first launch whose record write half-happened, which the Settings toggle
//! recovers with one click; the cost of the other direction was overriding a recorded OFF.
//!
//! ## The autostart-OFF offer (T11 rework)
//!
//! Turning autostart off in delegated mode means the app may not be running at 07:20 to notify —
//! the engine's own notifier is the fallback. The Settings toggle's OFF path therefore offers
//! `notify: "auto"`, through the SAME `config_offer_notify_auto` command and the same
//! `notifyOffer` classification the Quit dialog uses (B5's pipeline, one save path). That wiring
//! is webview-side (`gui/src/lib/AppSettings.svelte`); nothing here duplicates it.
//!
//! ## What T25 (uninstall) must remove — registered here, built later
//!
//!   * `~/Library/LaunchAgents/<app name>.plist` — the login item `enable()` wrote (or
//!     `disable()` already removed).
//!   * `<app_data_dir>/autostart-state.json`, `notify-state.json`, `access-state.json` — the
//!     app-owned records.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::briefing_files::read_text_capped;

/* ── the record ───────────────────────────────────────────────────────────────────────────────── */

/// `<app_data_dir>/autostart-state.json`: whether the default-ON one-shot has been applied.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutostartRecord {
    /// True once [`startup`] has successfully applied the default. Never cleared: the user's
    /// toggle owns the plist from then on.
    pub defaulted: bool,
}

pub const STORE_FILE: &str = "autostart-state.json";
pub const MAX_RECORD_BYTES: u64 = 64 * 1024;

/// ABSENT is `Default` (a genuine first launch — the one-shot applies); PRESENT-BUT-UNUSABLE is
/// `{ defaulted: true }` (fail toward the user's last known choice — module header). A record
/// that exists at all proves the one-shot ran once, and "apply the default again" is the one
/// wrong answer to not being able to read what the user chose since: it would re-create a login
/// item the user may have deleted.
///
/// ⚠ DELIBERATELY NOT `notifications::read_record`'s degrade-everything-to-`Default` posture,
/// and the difference is the failure DIRECTION: THAT record's `Default` is "never asked", which
/// fails toward silence (nothing posts, no OS prompt), so the split would buy it nothing. This
/// record's `Default` triggers an ACTION — the default-ON one-shot writes a login-item plist —
/// so only genuine absence may read as "first launch" here.
pub fn read_record(dir: &Path) -> AutostartRecord {
    match read_text_capped(&dir.join(STORE_FILE), MAX_RECORD_BYTES) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(record) => record,
            Err(_) => AutostartRecord { defaulted: true },
        },
        Err(crate::briefing_files::ReadRefusal::NotFound) => AutostartRecord::default(),
        // Symlinked, oversized, not a regular file, I/O error, not UTF-8: something IS there.
        Err(_) => AutostartRecord { defaulted: true },
    }
}

/// Temp-then-rename, the `access::write_record` shape, for the same crash-mid-write reason.
pub fn write_record(dir: &Path, record: &AutostartRecord) -> Result<(), String> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(STORE_FILE);
    let text = serde_json::to_string_pretty(record)
        .map_err(|e| format!("the autostart record could not be serialised: {e}"))?;
    let tmp = dir.join(format!(
        "{STORE_FILE}.tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let staged = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()
    })();
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", tmp.display()));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

/* ── the rule, and the sink ───────────────────────────────────────────────────────────────────── */

/// Whether this launch should apply the default. **Pure**, and deliberately the WHOLE rule: the
/// record is the only input, so "default ON" can never read the plist and re-enable over a user
/// who removed it.
pub fn should_apply_default(record: &AutostartRecord) -> bool {
    !record.defaulted
}

/// Where an `enable()` goes. A trait so the suite records instead of writing
/// `~/Library/LaunchAgents` — the REAL leg is VM-gated (`docs/gui-seam.md` §12c).
///
/// B25 (T25) widened it by the other two plugin operations, because the uninstall's "remove the
/// app's OWN autostart entry" leg REUSES this plugin surface (`disable()` is what removes the
/// login-item plist) rather than forking a plist removal of its own — and a sink that could
/// record enables but not disables would leave the uninstall leg untestable off-VM.
pub trait AutostartSink: Send + Sync {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}

/// T19's managed state: the test overrides. `sink: None` means the real plugin manager, resolved
/// from the app at call time — reachable only from `lib.rs`'s app, which registers the plugin.
#[derive(Default)]
pub struct AutostartState {
    sink: Option<Arc<dyn AutostartSink>>,
    store_dir: Option<PathBuf>,
}

impl AutostartState {
    /// **Test harness only** — a recording sink instead of the plugin.
    pub fn with_sink(mut self, sink: Arc<dyn AutostartSink>) -> Self {
        self.sink = Some(sink);
        self
    }

    /// **Test harness only** — `app_data_dir()` on MockRuntime is the developer's real one.
    pub fn with_store_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.store_dir = Some(dir.into());
        self
    }

    fn store_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, String> {
        if let Some(dir) = &self.store_dir {
            return Ok(dir.clone());
        }
        app.path()
            .app_data_dir()
            .map_err(|e| format!("this app's data directory could not be resolved: {e}"))
    }
}

/// The shipped enable: the plugin's manager, which the real app registers.
fn enable_via_plugin<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|e| e.to_string())
}

/// The shipped disable — what removes the login-item plist. T25's uninstall reuses this.
fn disable_via_plugin<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().disable().map_err(|e| e.to_string())
}

/// The shipped read — the same `is_enabled()` the Settings toggle reflects.
fn is_enabled_via_plugin<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// `is_enabled()` through the managed state's sink-or-plugin resolution ([`startup`]'s rule).
/// An app that does not manage [`AutostartState`] gets an error, not a guess.
pub fn enabled_now<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let Some(state) = app.try_state::<AutostartState>() else {
        return Err("the autostart state is not managed by this app".into());
    };
    match &state.sink {
        Some(sink) => sink.is_enabled(),
        None => is_enabled_via_plugin(app),
    }
}

/// `disable()` through the same resolution — T25's "remove the app's OWN autostart entry" leg.
pub fn disable_now<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(state) = app.try_state::<AutostartState>() else {
        return Err("the autostart state is not managed by this app".into());
    };
    match &state.sink {
        Some(sink) => sink.disable(),
        None => disable_via_plugin(app),
    }
}

/// The default-ON one-shot, called from `lib.rs`'s setup after the shell's.
///
/// A no-op on an app that does not manage [`AutostartState`] (every pre-B7 test fixture), and a
/// no-op once the record says the default was applied. On success the record is written; a record
/// write that then fails is logged and the one-shot retries next launch (idempotent). A failed
/// `enable()` is logged and NOT recorded — see the module header.
pub fn startup<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<AutostartState>() else {
        return;
    };
    let dir = match state.store_dir(app) {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("daily-briefing: autostart default skipped ({e})");
            return;
        }
    };
    if !should_apply_default(&read_record(&dir)) {
        return;
    }
    let enabled = match &state.sink {
        Some(sink) => sink.enable(),
        None => enable_via_plugin(app),
    };
    match enabled {
        Ok(()) => {
            if let Err(e) = write_record(&dir, &AutostartRecord { defaulted: true }) {
                eprintln!(
                    "daily-briefing: autostart was enabled but the record could not be written; \
                     the default will be applied again next launch ({e})"
                );
            }
        }
        Err(e) => eprintln!(
            "daily-briefing: autostart could not be enabled by default ({e}); it stays available \
             from the Settings screen"
        ),
    }
}
