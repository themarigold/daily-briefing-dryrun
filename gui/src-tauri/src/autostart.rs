//! T19 — autostart (login item), default ON — chosen at the setup wizard's LAST step, never at
//! launch, and BRANDED on macOS (Phase E M5b, user-directed 2026-10-01).
//!
//! ## The shape: two app commands, plus the plugin's one read
//!
//! The webview holds ONE plugin grant, `autostart:allow-is-enabled` — the Settings toggle must
//! reflect REAL state on every render, never a cached boolean, and the plugin's `is_enabled` is
//! precisely that read (a `stat` of the LaunchAgent plist) — and TWO app commands:
//!
//!   * [`autostart_set_enabled`] — the Settings toggle's ON/OFF AND the wizard's last step. ON is
//!     [`enable_now`] (the plugin's `enable()`, then, on macOS, [`brand_launch_agent`]); OFF is
//!     [`disable_now`]. Either way the record below is written: a login-item choice has now been
//!     made in this app.
//!   * [`autostart_wizard_default`] — the wizard's initial value for its "Start Daily Briefing at
//!     login" choice ([`wizard_default`]).
//!
//! ⚠ WHY THE PLUGIN'S OWN `enable`/`disable` ARE NO LONGER GRANTED (B7 granted the plugin's whole
//! allow-set). The plugin's `enable()` writes an UNBRANDED plist, so a webview that could call it
//! directly would hold a second way to turn the login item on — one that skips the branding. Every
//! enable now goes through ONE function, [`enable_now`]. `disable` went with it so that ON and OFF
//! are one command rather than an app command and a plugin command; T25's uninstall already
//! reached it Rust-side ([`disable_now`]).
//!
//! ## What the REAL calls touch, and why the suite never makes them
//!
//! `MacosLauncher::LaunchAgent`: `enable()` WRITES `~/Library/LaunchAgents/<app name>.plist` and
//! `disable()` REMOVES it (`auto-launch-0.5.0/src/macos.rs` — `get_file()` is
//! `~/Library/LaunchAgents/{app_name}.plist`, `Label` is `app_name`), and the branding step then
//! REWRITES that file. All three are VM-gated: no test, build step or probe calls them against the
//! live plugin state or the real `~/Library/LaunchAgents` (`docs/gui-seam.md` §12c, §12d). The
//! commands resolve an injectable [`AutostartSink`] the suite drives as a recorder, and the
//! branding is a pure-input function ([`brand_launch_agent`]) the suite drives on scratch files.
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
//! builder form) — the same test pins that as source. The branding keeps the label: it adds ONE
//! key and rewrites nothing the plugin wrote.
//!
//! ## Nothing at launch; default ON at the wizard's last step (Phase E M5b, user-directed)
//!
//! B7 shipped plan R1's "autostart default ON" as a FIRST-LAUNCH ONE-SHOT (`startup`, called from
//! `lib.rs`'s setup, enabled once and recorded it). M5b moves the default: **the app registers
//! NOTHING at launch** — there is no launch hook at all any more, which `tests/autostart.rs` pins —
//! and the default-ON lives in the setup wizard's last step as a "Start Daily Briefing at login"
//! choice, applied when the user presses Finish. The wizard's own promise ("nothing is installed
//! until you confirm at the last step") is therefore true of the login item too.
//!
//! The record (`<app_data_dir>/autostart-state.json`) keeps its file and its one key, `defaulted`;
//! its meaning widens from "the first-launch default was applied" to "a login-item choice has been
//! applied in this app" — B7's one-shot (an existing install), the wizard's last step, or the
//! Settings toggle. Its one reader is now [`wizard_default`]: no record ⇒ ON (a fresh install —
//! plan R1's default); a record ⇒ the REAL current state, so finishing the wizard again keeps
//! whatever the user has — it never re-creates a login item they removed and never removes one
//! they kept.
//!
//! **Existing installs** (a B7-era record says `defaulted: true`, and the plist is whatever the
//! user left): nothing at launch touches either, so their state is kept exactly. Their plist was
//! written by B7's unbranded one-shot and stays unbranded until the next ON through this app —
//! stated, not repaired at launch, because a launch-time rewrite of a login item is the kind of
//! unrequested action M5b removes.
//!
//! ⚠ RECORD LOSS FAILS TOWARD THE USER'S LAST KNOWN CHOICE, NOT TOWARD THE DEFAULT. Only a file
//! that is ABSENT reads as "no choice made yet"; a file that is PRESENT but unreadable or
//! unparseable reads as `{ defaulted: true }` ([`read_record`]), which makes the wizard show the
//! REAL state instead of the default ON. B7's first shape degraded every failure to `Default`,
//! and a corrupt or truncated record then re-fired the one-shot and RE-CREATED a login item the
//! user had deleted. M5b keeps the split for the same reason one step later: a corrupt record must
//! not pre-tick "Start at login" over a login item the user removed. The cost of the fail-safe
//! direction is one unticked box on a first run whose record write half-happened, which the user
//! can tick.
//!
//! ## The branded login item (macOS; Phase E M5b, user-directed)
//!
//! `auto-launch 0.5.0` writes `ProgramArguments = [current_exe()]` — the bundle's inner executable
//! — so macOS 13+ lists the login item under that file's name, "daily-briefing-gui", with a generic
//! icon. A LaunchAgent plist's `AssociatedBundleIdentifiers` key names the app it belongs to, which
//! is what lets System Settings › Login Items show it as "Daily Briefing" with the app's icon.
//! [`enable_now`]'s real leg therefore follows the plugin's `enable()` with [`brand_launch_agent`]:
//! parse the plist the plugin just wrote (with the `plist` crate — a real parser and writer, not
//! string surgery), check its `Label` is this app's, add the key = `[the bundle identifier]`
//! (`tauri.conf.json`'s `identifier`, `com.themarigold.daily-briefing`), and replace the file
//! atomically. Every key the plugin wrote is kept, so its `is_enabled()` (a `stat`) and
//! `disable()` (a remove) of the same path work unchanged. A branding failure is logged and NOT
//! fatal: the login item the user asked for exists either way, only its label differs.
//!
//! ⚠ UNVERIFIED (until the Phase F VM): that macOS 13+ actually shows the branded name and icon
//! for this plist from this (ad-hoc signed, not notarized) bundle. The key, its value and the
//! rewrite are tested; what the OS does with them is not (`docs/gui-seam.md` §12d). Linux has no
//! equivalent key: `~/.config/autostart/Daily Briefing.desktop` is written exactly as before.
//!
//! ## One change at a time (Phase E M5b checkpoint fix)
//!
//! ON is three steps — the plugin's `enable()`, the branding's read-then-`rename`, the record —
//! and OFF is two. Interleaved, an OFF's `disable()` could land between ON's `enable()` and its
//! `rename`, which then RE-CREATES the plist the OFF removed. Every change therefore runs under
//! ONE lock in [`AutostartState`] ([`lock_changes`]): [`autostart_set_enabled`] holds it across
//! the whole ON or OFF, the uninstall's leg 1 across its read and `disable()`, and
//! [`enable_now`] / [`disable_now`] demand the guard as an argument, so a new caller cannot skip
//! it. `tests/autostart.rs` asserts the lock is held from inside the sink's `enable()`/`disable()`
//! and drives an OFF while an ON is paused mid-enable.
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

/// `<app_data_dir>/autostart-state.json`: whether a login-item choice has been applied in this
/// app (module header — B7 wrote it for the first-launch default; M5b for any explicit choice).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutostartRecord {
    /// True once a login-item choice has been applied — B7's first-launch default on an existing
    /// install, the wizard's last step, or the Settings toggle. Never cleared. The key keeps its
    /// B7 name so an existing install's record reads unchanged.
    pub defaulted: bool,
}

pub const STORE_FILE: &str = "autostart-state.json";
pub const MAX_RECORD_BYTES: u64 = 64 * 1024;

/// ABSENT is `Default` (no choice made yet — the wizard pre-ticks ON); PRESENT-BUT-UNUSABLE is
/// `{ defaulted: true }` (fail toward the user's last known choice — module header). A record
/// that exists at all proves a choice was applied once, and "offer the default again" is the one
/// wrong answer to not being able to read it: it would pre-tick a login item the user may have
/// deleted.
///
/// ⚠ DELIBERATELY NOT `notifications::read_record`'s degrade-everything-to-`Default` posture,
/// and the difference is the failure DIRECTION: THAT record's `Default` is "never asked", which
/// fails toward silence (nothing posts, no OS prompt), so the split would buy it nothing. This
/// record's `Default` leads toward an ACTION — a pre-ticked box whose Finish writes a login-item
/// plist — so only genuine absence may read as "no choice yet" here.
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
    let text = serde_json::to_string_pretty(record)
        .map_err(|e| format!("the autostart record could not be serialised: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    replace_atomically(&dir.join(STORE_FILE), text.as_bytes())
}

/// The mode every file [`replace_atomically`] writes ends with — the login-item plist and the
/// record. Set explicitly on the temp before the rename, so the result never depends on the
/// process umask (before the checkpoint fix the rewritten plist simply took the umask's mode).
pub const REPLACED_MODE: u32 = 0o644;

/// How many temp names [`replace_atomically`] tries before giving up. Each clash is a name that
/// already exists beside the target — never ours, so never touched — and the next sequence number
/// is a fresh name; more than a handful in a row means something is planting them.
pub const TEMP_ATTEMPTS: usize = 8;

/// Write `bytes` to a NEW temp file beside `path` (mode [`REPLACED_MODE`]), `fsync` it, and
/// `rename` it over `path`. The temp name never ends in `.plist` or `.json`, so a leftover from a
/// crash between the two steps is a file nothing (launchd included) reads.
///
/// ⚠ THE TEMP IS CREATED, NEVER OPENED (Phase E M5b checkpoint fix). Its name,
/// `<name>.tmp-<pid>-<seq>`, is predictable, and the first shape opened it with `File::create`,
/// which follows a symlink planted at that name (writing the plist's bytes wherever it points) and
/// truncates a hard link's target. The temp is now made by `config_save::write_new_file` —
/// `create_new`, i.e. `O_CREAT|O_EXCL`, which fails on ANY existing name, a symlink included — and
/// a clash is left exactly as it was while the next name is tried, at most [`TEMP_ATTEMPTS`]
/// times.
///
/// `pub(crate)` for the app's two other records (Phase E final harden, known item 8):
/// `access::write_record` and `notifications::write_record` staged their temp files with that same
/// `File::create` — and on a failed write removed whatever sat at the name, a planted file
/// included. All three records (this module's, `access-state.json`, `notify-state.json`) now
/// share this one create-new, explicit-mode, temp-then-rename path.
pub(crate) fn replace_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} has no file name", path.display()))?
        .to_string_lossy();
    replace_atomically_via(path, bytes, || {
        dir.join(format!(
            "{name}.tmp-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    })
}

/// [`replace_atomically`] with the temp names supplied by `next_temp` — **the test seam only**:
/// the shipped names come from a process-wide counter a test cannot predict, so the suite plants a
/// symlink and a hard link at the names it hands in here and asserts neither target is touched.
#[doc(hidden)]
pub fn replace_atomically_via(
    path: &Path,
    bytes: &[u8],
    mut next_temp: impl FnMut() -> PathBuf,
) -> Result<(), String> {
    for _ in 0..TEMP_ATTEMPTS {
        let tmp = next_temp();
        match crate::config_save::write_new_file(&tmp, bytes, REPLACED_MODE) {
            Ok(()) => {
                return std::fs::rename(&tmp, path).map_err(|e| {
                    // Ours (the create succeeded), so ours to remove.
                    let _ = std::fs::remove_file(&tmp);
                    format!("{}: {e}", path.display())
                });
            }
            // Someone else's name: leave it exactly as it is and try the next one.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            // `write_new_file` removed its own partial file; nothing else was created.
            Err(e) => return Err(format!("{}: {e}", tmp.display())),
        }
    }
    Err(format!(
        "{}: every one of {TEMP_ATTEMPTS} temp names beside it already exists; nothing was written",
        path.display()
    ))
}

/* ── the rule, and the sink ───────────────────────────────────────────────────────────────────── */

/// The wizard's initial value for "Start Daily Briefing at login". **Pure**, and the WHOLE rule:
///
///   * no choice recorded (a fresh install) ⇒ **ON** — plan R1's "autostart default ON";
///   * a choice recorded ⇒ the REAL current state (`is_enabled()`), so finishing the wizard again
///     keeps whatever the user has — it never re-creates a login item they removed, never removes
///     one they kept;
///   * a choice recorded and the real state unreadable ⇒ **an error, not a guess** (Phase E M5b
///     checkpoint fix). This answered OFF at first, and the wizard's Finish then APPLIED that OFF —
///     a `disable()` that removes a login item nobody could see. The wizard now treats the error as
///     "the current state could not be read": its Finish leaves the login item as it is unless the
///     user ticks or unticks the box (`gui/src/lib/wizard.ts`'s `loginItemPlan`).
///
/// The error is the read's own cause, UNWRAPPED (Phase E M5b fix round 2): the wizard's note
/// (`loginItemNote`) already says "whether Daily Briefing already starts at login could not be
/// read (<cause>)", and a sentence wrapped here too reached the user twice over.
pub fn wizard_default(
    record: &AutostartRecord,
    enabled: Result<bool, String>,
) -> Result<bool, String> {
    if !record.defaulted {
        return Ok(true);
    }
    enabled
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

/// T19's managed state: the test overrides, and the ONE lock every login-item change holds.
/// `sink: None` means the real plugin manager, resolved from the app at call time — reachable only
/// from `lib.rs`'s app, which registers the plugin.
#[derive(Default)]
pub struct AutostartState {
    sink: Option<Arc<dyn AutostartSink>>,
    store_dir: Option<PathBuf>,
    /// Held across a WHOLE change — ON's `enable()` → branding → record, OFF's `disable()` →
    /// record, and the uninstall's read → `disable()` ([`lock_changes`]).
    changes: std::sync::Mutex<()>,
    /// How many callers are inside [`lock_changes`] and have not yet acquired [`Self::changes`] —
    /// raised before the `lock()`, lowered after it returns. Bookkeeping only (it guards nothing):
    /// the suite's observable for "a second change is now BLOCKED behind the first"
    /// ([`Self::changes_waiting`]), so the mid-enable race test can prove the OFF waited at the
    /// lock rather than merely arrived late (Phase E final harden, GM2-5).
    waiting: std::sync::atomic::AtomicUsize,
}

impl AutostartState {
    /// **Test harness only** — how many login-item changes are waiting to take the change lock
    /// right now (see the `waiting` field). Never blocks.
    #[doc(hidden)]
    pub fn changes_waiting(&self) -> usize {
        self.waiting.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// **Test harness only** — whether a login-item change holds the lock right now. A probe a
    /// recording sink calls from INSIDE its `enable()`/`disable()`, so the suite can assert the
    /// lock is held across the sequence (a `try_lock`: it never blocks, on any thread).
    #[doc(hidden)]
    pub fn changes_locked(&self) -> bool {
        matches!(
            self.changes.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        )
    }

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

fn managed<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, AutostartState>, String> {
    app.try_state::<AutostartState>()
        .ok_or_else(|| "the autostart state is not managed by this app".to_string())
}

/// Proof that the caller holds the login-item change lock ([`lock_changes`]). [`enable_now`] and
/// [`disable_now`] take one, so no caller can change the login item without holding it.
pub struct ChangeGuard<'a> {
    _held: std::sync::MutexGuard<'a, ()>,
}

/// Take the ONE lock every login-item change holds, for the whole change (Phase E M5b checkpoint
/// fix). Without it an ON and an OFF could interleave: ON's `enable()` writes the plist, OFF's
/// `disable()` removes it, and ON's branding — a read, then a temp file `rename`d over the path —
/// RE-CREATES the plist the OFF had just removed, leaving the login item on after the user turned
/// it off. Held by [`autostart_set_enabled`] across enable → brand → record and disable → record,
/// and by the uninstall's leg 1 across its read → disable.
///
/// A std `Mutex`, held across no `.await`: every step under it is synchronous file work. A
/// poisoned lock (a panic mid-change) is taken anyway — it orders changes, it guards no data.
pub fn lock_changes<R: Runtime>(app: &AppHandle<R>) -> Result<ChangeGuard<'_>, String> {
    use std::sync::atomic::Ordering;
    let state: &AutostartState = managed(app)?.inner();
    state.waiting.fetch_add(1, Ordering::SeqCst);
    let held = state
        .changes
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    state.waiting.fetch_sub(1, Ordering::SeqCst);
    Ok(ChangeGuard { _held: held })
}

/// The shipped enable: the plugin's manager, which the real app registers — then, on macOS, the
/// branding (module header). A branding failure is logged, not returned: the login item the user
/// asked for exists either way.
fn enable_via_plugin<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().enable().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let label = &app.package_info().name;
        let branded = app
            .path()
            .home_dir()
            .map_err(|e| format!("the home directory could not be resolved: {e}"))
            .and_then(|home| {
                brand_launch_agent(
                    &launch_agent_plist(&home, label),
                    label,
                    &app.config().identifier,
                )
            });
        if let Err(e) = branded {
            eprintln!(
                "daily-briefing: Start at login is on, but its login item could not be labelled \
                 as this app ({e}); macOS may list it under the executable's name"
            );
        }
    }
    Ok(())
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

/// `is_enabled()` through the managed state's sink-or-plugin resolution. An app that does not
/// manage [`AutostartState`] gets an error, not a guess.
pub fn enabled_now<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    let state = managed(app)?;
    match &state.sink {
        Some(sink) => sink.is_enabled(),
        None => is_enabled_via_plugin(app),
    }
}

/// `enable()` through the same resolution — THE ONE ENABLE (module header): the wizard's last
/// step and the Settings toggle both reach it through [`autostart_set_enabled`], and the real leg
/// brands the plist it writes. Only under the change lock (`_held`, [`lock_changes`]).
pub fn enable_now<R: Runtime>(app: &AppHandle<R>, _held: &ChangeGuard<'_>) -> Result<(), String> {
    let state = managed(app)?;
    match &state.sink {
        Some(sink) => sink.enable(),
        None => enable_via_plugin(app),
    }
}

/// `disable()` through the same resolution — the toggle's OFF, and T25's "remove the app's OWN
/// autostart entry" leg. Only under the change lock (`_held`, [`lock_changes`]).
pub fn disable_now<R: Runtime>(app: &AppHandle<R>, _held: &ChangeGuard<'_>) -> Result<(), String> {
    let state = managed(app)?;
    match &state.sink {
        Some(sink) => sink.disable(),
        None => disable_via_plugin(app),
    }
}

/* ── the branding (macOS) ─────────────────────────────────────────────────────────────────────── */

/// The LaunchAgent key macOS 13+ reads to attribute a login item to an app bundle.
pub const ASSOCIATED_BUNDLE_IDENTIFIERS: &str = "AssociatedBundleIdentifiers";

/// The largest login-item plist [`brand_launch_agent`] will read. The plugin writes ~350 bytes.
pub const MAX_PLIST_BYTES: u64 = 64 * 1024;

/// `<home>/Library/LaunchAgents/<label>.plist` — `auto-launch 0.5.0`'s `get_file()`
/// (`dirs::home_dir()` joined with `Library/LaunchAgents/{app_name}.plist`), rebuilt from the same
/// two inputs: the home directory and the label the plugin derives (`package_info().name`).
pub fn launch_agent_plist(home: &Path, label: &str) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{label}.plist"))
}

/// Add `AssociatedBundleIdentifiers = [bundle_id]` to the login-item plist at `path` and replace
/// the file atomically, keeping every key already there. Idempotent.
///
/// Refuses — and leaves the file untouched — when `path` is absent, a symlink, hard-linked,
/// oversized, not a property list, not a dictionary, or its `Label` is not `label`: it rewrites
/// only the plist the plugin wrote for THIS app, never a file it does not recognise.
///
/// ⚠ THAT REFUSAL COVERS THIS FUNCTION'S OWN WRITE, NOT THE ONE BEFORE IT. In
/// [`enable_via_plugin`] the plugin's `enable()` runs first, and `auto-launch 0.5.0` writes the
/// plist with `fs::File::create(self.get_file())` (`src/macos.rs:112`), which FOLLOWS a symlink
/// planted at that path (and truncates a hard link's target) — so by the time this refuses the
/// symlink, the plugin has already written its plist bytes through it. Planting that link needs
/// write access to the user's own `~/Library/LaunchAgents`, i.e. an attacker already running code as
/// this user — out of scope in `SECURITY.md` ("an attacker who can already run code as your user").
/// Stated so the refusal is not read as protecting the plugin's write too.
#[cfg(target_os = "macos")]
pub fn brand_launch_agent(path: &Path, label: &str, bundle_id: &str) -> Result<(), String> {
    let text = crate::briefing_files::read_single_link_text_capped(path, MAX_PLIST_BYTES)
        .map_err(|refusal| refusal.describe(path, MAX_PLIST_BYTES))?;
    let mut value = plist::Value::from_reader_xml(text.as_bytes())
        .map_err(|e| format!("{} is not a property list: {e}", path.display()))?;
    let dict = value
        .as_dictionary_mut()
        .ok_or_else(|| format!("{} is not a dictionary property list", path.display()))?;
    let found = dict.get("Label").and_then(plist::Value::as_string);
    if found != Some(label) {
        return Err(format!(
            "{} has Label {found:?}, not {label:?}; it is not this app's login item",
            path.display()
        ));
    }
    dict.insert(
        ASSOCIATED_BUNDLE_IDENTIFIERS.to_string(),
        plist::Value::Array(vec![plist::Value::String(bundle_id.to_string())]),
    );
    let mut bytes = Vec::new();
    value
        .to_writer_xml(&mut bytes)
        .map_err(|e| format!("the login-item plist could not be serialised: {e}"))?;
    bytes.push(b'\n');
    replace_atomically(path, &bytes)
}

/* ── the two commands ─────────────────────────────────────────────────────────────────────────── */

/// The webview-facing names, in [`crate::handler`]'s order (the `commands::all_commands` rule).
pub const COMMANDS: &[&str] = &["autostart_set_enabled", "autostart_wizard_default"];

/// Turn the login item ON or OFF — the Settings toggle and the wizard's last step. Takes one
/// boolean and nothing else: what the plist says (label, program, argv) is the plugin's fixed
/// derivation, plus the fixed bundle identifier. On success the choice is recorded; a record
/// write that fails is logged, not returned, because the plist — which is what the toggle
/// reflects — already says what the user chose (the record only decides a FUTURE wizard's
/// pre-tick). The whole change — the plist AND the record — runs under [`lock_changes`], so a
/// concurrent OFF waits for an ON's branding to finish rather than racing it.
#[tauri::command]
pub async fn autostart_set_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let held = lock_changes(&app)?;
    if enabled {
        enable_now(&app, &held)?;
    } else {
        disable_now(&app, &held)?;
    }
    let recorded = managed(&app)
        .and_then(|state| state.store_dir(&app))
        .and_then(|dir| write_record(&dir, &AutostartRecord { defaulted: true }));
    if let Err(e) = recorded {
        eprintln!("daily-briefing: the login-item choice was applied but not recorded ({e})");
    }
    Ok(())
}

/// The wizard's initial value for "Start Daily Briefing at login" — [`wizard_default`] over the
/// record and the REAL state. Reads only; never enables anything. An error means "the current
/// state is unknown", and the wizard then changes nothing unless the user chooses.
#[tauri::command]
pub async fn autostart_wizard_default<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let dir = managed(&app)?.store_dir(&app)?;
    wizard_default(&read_record(&dir), enabled_now(&app))
}
