//! T25 (B25) — the Settings-side "Uninstall app" action.
//!
//! ## What it removes, and what it never touches
//!
//! Three legs, each reported separately (`docs/gui-seam.md` §16):
//!
//!   1. **The app's own autostart entry** — T19's plugin `disable()`, REUSED through
//!      `autostart::disable_now` (the same sink-or-plugin resolution the autostart commands use),
//!      never a hand-rolled plist removal. The real plugin leg is VM-gated exactly as T19's is
//!      (§12c); the suite drives a recording sink. Its read and `disable()` run under
//!      `autostart::lock_changes` — the same lock the toggle's ON holds across its branding
//!      `rename`, which could otherwise re-create the plist this leg just removed (Phase E M5b).
//!   2. **The app's own files** — the enumerated records in `app_data_dir()`
//!      ([`APP_DATA_FILES`], [`APP_DATA_DIRS`]) and the window-state file in `app_config_dir()`
//!      ([`APP_CONFIG_FILES`]). ⚠ TWO directories on purpose, MEASURED rather than assumed:
//!      `tauri-plugin-window-state` 2.4.1 saves through `app_config_dir()`
//!      (`src/lib.rs:122-124`), not `app_data_dir()` — the two coincide on macOS
//!      (`~/Library/Application Support/<bundle-id>`) and DIVERGE on Linux
//!      (`~/.config/<id>` vs `~/.local/share/<id>`), so a single-dir list would leave the
//!      window-state file behind on exactly the platform where nobody would notice.
//!   3. **Only behind the explicit `removeEngineState` consent flag** — the engine state
//!      directory's contents, and NOT one file more: [`ENGINE_STATE_REMOVALS`] mirrors
//!      `scripts/uninstall.sh`'s bounded list — its `rm … "$SUPPORT"/<token>` lines — token for
//!      token, and `tests/uninstall.rs` PARSES the script at test time and asserts set-equality
//!      (the T9 pathEnv parity pattern) — the two spellings cannot drift silently. The state dir is
//!      the ENGINE's answer (`status --json` → `paths.stateDir`, absolutised), never a webview
//!      operand.
//!
//! ⚠ **NEVER a recursive delete of the support directory.** The one `remove_dir_all` the engine
//! leg performs is on the `briefings` SUBDIRECTORY the script itself `rm -rf`s; the directory
//! also holds files this list deliberately leaves (`last-run`, `last-skip.json`, `run.lock`,
//! `schedule.json`, `account-state.json`, …) and — the reason the rule exists — the CLI's own
//! managed binary lives there too, and on a machine where the CLI is the user's daily tool an
//! unconsented removal would break it. (The consented list DOES include `daily-briefing`, because
//! the script's does: consent here means "remove the engine's data and its managed copy", the
//! same meaning `bash scripts/uninstall.sh` has.)
//!
//! ⚠ **While a schedule record exists the consented leg removes NOTHING** (Phase E final harden
//! round 2, A-M1 — superseding round 1's "keep only the engine copy"). `scripts/uninstall.sh`
//! removes nothing while `$RECORD` (`<state>/schedule.json`) exists until the engine has removed
//! its own schedule, and refuses when it cannot (its `if [ -f "$RECORD" ]` block): the trigger that
//! record describes — the CLI's OR this app's, both install the same `local.daily-briefing` unit —
//! runs the managed binary (`src/schedule/install.ts`, `managedBinPath`, the record's `binPath`),
//! calls the provider and writes this directory every time it delivers. This action never removes a
//! schedule (below), so after it any recorded trigger is still there. Round 1 kept only
//! `daily-briefing` and deleted the rest; that left the schedule running the kept copy, calling the
//! provider every morning and RE-CREATING the archive and log the user had just consented to
//! delete. So now the record is checked ONCE, before the first removal, and when it is there the
//! leg removes nothing at all and reports ONE refusal ([`UninstallReport::engine_refused`],
//! [`REFUSED_FOR_SCHEDULE`]) naming the way out: the Schedule screen's own removal for a schedule
//! this app installed, `daily-briefing schedule uninstall` for one installed from a terminal, then
//! Uninstall again. The record's owner is deliberately NOT read: the way out is named for both, so
//! an unreadable or foreign record refuses exactly like this app's own. The login-item and
//! app-file legs run as before.
//!
//! ⚠ **A record can be STALE, and the refusal says how out of that too** (round 3, B3-L1). An
//! unparseable record, or a dangling symlink, still refuses (it fails toward not deleting) — but
//! then the Schedule screen draws no removal button, and `daily-briefing schedule uninstall` exits
//! "Nothing installed" before it unlinks the record (`src/schedule/install.ts`,
//! `uninstallSchedule`). So the refusal ends with the shared stale-record clause: if both report
//! nothing, delete `schedule.json` from the engine's folder and run Uninstall again.
//!
//! ⚠ **A scheduler UNIT FILE with no record refuses the same way** (round 3, D3-L4). An older install
//! (`scripts/install.sh`, or an engine from before the record existed) can leave the unit the
//! engine writes — `~/Library/LaunchAgents/local.daily-briefing.plist`, or on Linux
//! `~/.config/systemd/user/daily-briefing.{service,timer}` ([`schedule_unit_files`]) — with no
//! `schedule.json`, and that unit runs the very copy the consented leg would delete. So the leg
//! also refuses while one of those FILES is there: a presence check (`lstat`) only — this module
//! never asks `launchctl` or `systemctl` anything — and the refusal ([`refused_for_unit`]) names
//! the unit and the command that removes it, first, with no stale-RECORD clause: there is no
//! record (round 4, B4-L6; it used to be [`REFUSED_FOR_SCHEDULE`] with the unit appended).
//!
//! ⚠ **The report says what the gate saw** (round 4, G4-L1): `uninstall_execute` takes ONE look
//! ([`ScheduleSeen`]) right before leg 3, refuses on it, and reports it — never a second sample.
//!
//! ⚠ **What this deliberately does NOT do:** it never touches the launchd domain. The CLI's
//! `local.daily-briefing` unit is `schedule uninstall`'s to remove (the Schedule panel's existing
//! flow, `ScheduleUninstall.svelte`); the script's `launchctl unload` + `rm $PLIST` lines are
//! that engine subcommand's territory, not a file-removal this module may re-implement — which is
//! also why the parity list below is the `$SUPPORT`-rooted subset. The webview copy says so
//! rather than implying a total uninstall.
//!
//! ⚠ **The consented leg can remove the briefing archive** (`briefings/`, `briefing.log`) — the
//! one surface in the app that can, and the reason the flag defaults OFF and the dialog names the
//! archive explicitly. This is an uninstall with consent, not a pruning offer; T13's
//! retention-stays-unbounded rule is about the app's ordinary surfaces and is unchanged
//! (`docs/gui-seam.md` §16, deviation 159).
//!
//! All filesystem effects go through the injectable [`UninstallFs`] sink (the B8 `ShimSink`
//! pattern); the real [`SystemFs`] is constructed in `lib.rs` only, and every test drives a
//! recorder or a scratch directory.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::briefing_files::{absolute, engine_paths};
use crate::engine::{Engine, EngineClient};
use crate::{access, autostart, config_save, notifications};

/* ── the bounded lists ────────────────────────────────────────────────────────────────────────── */

/// How one engine-state entry is removed — the same three shapes the script's `rm` lines have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryKind {
    /// `rm -f "$SUPPORT"/<name>` — one file.
    File,
    /// `rm -f "$SUPPORT"/<prefix>*<suffix>` — direct children matching the one-star pattern.
    Glob,
    /// `rm -rf "$SUPPORT"/<name>` — one directory, recursively. The ONLY recursive removals in
    /// this module are the entries carrying this kind.
    Dir,
}

/// One engine-state removal, spelled EXACTLY as `scripts/uninstall.sh` spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineEntry {
    /// The `$SUPPORT`-relative token from the script — a bare name or a one-star glob, never a
    /// path (no separator; `tests/uninstall.rs` pins that too).
    pub token: &'static str,
    pub kind: EntryKind,
}

/// The consent-gated engine-state list: `scripts/uninstall.sh`'s `$SUPPORT`-rooted removals (its
/// `rm … "$SUPPORT"/<token>` lines), token for token. Set-equality with a test-time PARSE of the script is pinned by
/// `tests/uninstall.rs` (`the_engine_list_is_the_scripts_support_rooted_list`), so editing either
/// side alone goes red. The script's `$PLIST` line is deliberately NOT here — module header.
pub const ENGINE_STATE_REMOVALS: &[EngineEntry] = &[
    EngineEntry {
        token: "daily-briefing",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "wake-schedule.json",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "briefing.log",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "briefing-latest.md",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "briefing.log.1",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "transcript-health.json",
        kind: EntryKind::File,
    },
    EngineEntry {
        token: "audit-*.md",
        kind: EntryKind::Glob,
    },
    EngineEntry {
        token: "briefings",
        kind: EntryKind::Dir,
    },
    // Phase E (E11): the opt-in update check's last answer, `src/updateCheck.ts`.
    EngineEntry {
        token: "update-check.json",
        kind: EntryKind::File,
    },
];

/// The engine's single-owner schedule record, `<state>/schedule.json` (`src/schedule/install.ts`,
/// `schedulePath`) — `scripts/uninstall.sh`'s `$RECORD`. Never removed here; while it EXISTS, the
/// consented leg removes nothing and reports [`REFUSED_FOR_SCHEDULE`] (module header).
pub const SCHEDULE_RECORD: &str = "schedule.json";

/// The launchd unit the engine writes on macOS — `src/schedule/units.ts`'s `SCHEDULE_LABEL` plus
/// `.plist` (`src/schedule/install.ts`, `unitPaths`). `tests/uninstall.rs` parses `units.ts` for it.
pub const LAUNCHD_UNIT: &str = "local.daily-briefing.plist";

/// The systemd user units the engine writes on Linux — `src/schedule/units.ts`'s
/// `SYSTEMD_SERVICE_NAME` and `SYSTEMD_TIMER_NAME`. `tests/uninstall.rs` parses `units.ts` for them.
pub const SYSTEMD_UNITS: &[&str] = &["daily-briefing.service", "daily-briefing.timer"];

/// Why the consented engine leg removed nothing when a schedule RECORD is there
/// ([`UninstallReport::engine_refused`]), in the report's own words, with the way out named
/// exactly. `Remove background scheduler…` is the Schedule screen's own button
/// (`gui/src/lib/ScheduleUninstall.svelte`; `tests/uninstall.rs` pins the label against that file),
/// and the rule sentence is `lib/app-uninstall.ts`'s `SCHEDULE_RECORD_RULE` (which `tests-web` holds
/// this text to); `docs/INSTALL.md` states the same rule, and the stale-record clause word for
/// word. The owner is not read (module header), so both ways out are named. It says "while that
/// schedule is installed" rather than "a schedule is installed" because a stale record is not one
/// (round 3, B3-L1). A record-LESS unit file has its own refusal, [`refused_for_unit`] (round 4,
/// B4-L6).
pub const REFUSED_FOR_SCHEDULE: &str = "a background schedule's record (schedule.json) is there, \
     and while that schedule is installed it keeps running the background engine copy, which \
     would re-create what this removes. Uninstall removes none of the engine's data while a \
     background schedule is installed: remove the schedule first (Schedule screen → Remove \
     background scheduler…), or run `daily-briefing schedule uninstall` if you installed it from \
     the terminal, then run Uninstall again. If the Schedule screen shows no schedule and \
     `daily-briefing schedule uninstall` reports nothing installed, the record is stale: delete \
     `schedule.json` from the engine's folder, then run Uninstall again.";

/// The rule sentence for a scheduler unit file with NO record (round 4, B4-L6) — its own, way out
/// first, and without [`REFUSED_FOR_SCHEDULE`]'s stale-RECORD clause: there is no record to delete.
/// The Schedule screen is not named: it offers its removal only where there is a record
/// (`gui/src/routes/Schedule.svelte` draws `ScheduleUninstall` under `recordPresent`). The engine's
/// own subcommand is the way out — it unloads and unlinks a present unit even with no record
/// (`src/schedule/install.ts`, `uninstallSchedule`). `lib/app-uninstall.ts`'s
/// `SCHEDULE_UNIT_RULE` is this sentence; `tests-web/coexistence.check.ts` holds the two equal.
pub const REFUSED_FOR_UNIT_RULE: &str = "Uninstall removes none of the engine's data while a \
     background scheduler unit file is there: run `daily-briefing schedule uninstall` in a \
     terminal, which removes that unit file, then run Uninstall again.";

/// The refusal for a scheduler unit file with NO record (module header, round 3 D3-L4): the unit
/// that was found, why it refuses, then [`REFUSED_FOR_UNIT_RULE`] (round 4, B4-L6 — it used to be
/// [`REFUSED_FOR_SCHEDULE`] with the unit appended), and for a systemd unit the exact command
/// beside it, [`unit_command_note`] (cap round, G5-2: the rule cannot carry the unit's path).
pub fn refused_for_unit(unit: &Path) -> String {
    let refused = format!(
        "a background scheduler unit file ({}) is there with no schedule record — an older \
         install's — and while it is installed it keeps running the background engine copy, which \
         would re-create what this removes. {REFUSED_FOR_UNIT_RULE}",
        unit.display()
    );
    match unit_command_note(unit) {
        Some(note) => format!("{refused} {note}"),
        None => refused,
    }
}

/// Why a systemd unit needs its own command (cap round, G5-2), ending [`unit_command_note`]. The
/// webview's `UNIT_DIR_CLAUSE` (`lib/app-uninstall.ts`) is this sentence; `tests-web` holds the two
/// equal.
pub const UNIT_DIR_CLAUSE: &str = "`daily-briefing schedule uninstall` looks for it only under \
     `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when XDG_CONFIG_HOME is unset.";

/// The command that removes `unit` from a terminal when it is a systemd unit —
/// `<config>/systemd/user/<name>`, [`schedule_unit_files`]' Linux shape — else `None` (the macOS
/// plist, whose command is the rule's own, or a path that is not UTF-8).
///
/// ⚠ WHY (cap round, G5-2): this app looks under BOTH `$XDG_CONFIG_HOME/systemd/user` and
/// `~/.config/systemd/user`, but `daily-briefing schedule uninstall` looks only under the one ITS
/// environment names (`src/schedule/install.ts`, `unitDir`: `XDG_CONFIG_HOME ?? ~/.config`). From a
/// terminal whose `XDG_CONFIG_HOME` is not the found unit's, it reports nothing installed and the
/// unit keeps refusing the leg. So the command sets `XDG_CONFIG_HOME` to the unit's OWN config
/// directory — right for either directory, whatever the terminal has set — single-quoted for a POSIX
/// shell (each `'` as `'\''`), so a space or a quote in the path cannot split or end the value.
/// `lib/app-uninstall.ts`'s `unitUninstallCommand` is the same rule.
pub fn unit_uninstall_command(unit: &Path) -> Option<String> {
    let (dir, name) = unit.to_str()?.rsplit_once('/')?;
    let config = dir.strip_suffix("/systemd/user")?;
    if config.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!(
        "XDG_CONFIG_HOME='{}' daily-briefing schedule uninstall",
        config.replace('\'', r"'\''")
    ))
}

/// The sentence beside [`REFUSED_FOR_UNIT_RULE`] for a unit [`unit_uninstall_command`] has a command
/// for, else `None`. `lib/app-uninstall.ts`'s `unitCommandNote` builds the same sentence.
pub fn unit_command_note(unit: &Path) -> Option<String> {
    unit_uninstall_command(unit).map(|command| {
        format!("To remove this unit file from a terminal, run `{command}`: {UNIT_DIR_CLAUSE}")
    })
}

/// The scheduler unit files the ENGINE writes on `os` (`std::env::consts::OS` spelling), for the
/// user whose home is `home` — `src/schedule/install.ts`'s `unitPaths` without its
/// `DBA_TEST_UNIT_DIR` test override. **Pure**, so both platforms' answers are pinned on either.
///
///   * `macos`: `~/Library/LaunchAgents/local.daily-briefing.plist`.
///   * `linux`: `daily-briefing.service` and `.timer` under `<config>/systemd/user`, for EACH of
///     `$XDG_CONFIG_HOME` (when this app was given one) and `~/.config`. The engine uses the first
///     when set, but the engine THIS app spawns never sees it (`engine::FORWARDED_ENV` clears it),
///     while one run from a terminal may have — so both are checked; an extra presence check can
///     only refuse more, never delete more.
///   * anything else: none (no desktop build ships there; the Windows task XML lives in the state
///     dir under a name the consented list does not touch).
pub fn schedule_unit_files(os: &str, home: &Path, xdg_config_home: Option<&Path>) -> Vec<PathBuf> {
    match os {
        "macos" => vec![home.join("Library").join("LaunchAgents").join(LAUNCHD_UNIT)],
        "linux" => {
            let mut configs: Vec<PathBuf> = Vec::new();
            if let Some(xdg) = xdg_config_home.filter(|p| !p.as_os_str().is_empty()) {
                configs.push(xdg.to_path_buf());
            }
            let default = home.join(".config");
            if !configs.contains(&default) {
                configs.push(default);
            }
            configs
                .iter()
                .flat_map(|config| {
                    SYSTEMD_UNITS
                        .iter()
                        .map(move |unit| config.join("systemd").join("user").join(unit))
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The first of `unit_files` that is there (`lstat`: a dangling symlink counts) — never a
/// scheduler query.
fn present_unit(fs: &dyn UninstallFs, unit_files: &[PathBuf]) -> Option<PathBuf> {
    unit_files.iter().find(|p| fs.exists(p)).cloned()
}

/// ONE look at what refuses the consented engine leg: the record and the first unit file that is
/// there. ⚠ The gate refuses on it AND the report states it (round 4, G4-L1): the report used to
/// sample the unit before the execute-time `status --json` spawn while the gate looked again after
/// it, so a unit that appeared in between was refused on but reported absent — and the done view
/// gave a stale-RECORD warning for a unit refusal. One observation, taken immediately before the
/// first removal, cannot disagree with itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleSeen {
    /// `<state>/schedule.json` is there ([`UninstallFs::exists`]).
    pub record: bool,
    /// The first of the unit files that is there, record or not ([`present_unit`]).
    pub unit: Option<PathBuf>,
}

impl ScheduleSeen {
    /// Look, once. Both are always looked at, so the report has both facts whichever refuses.
    pub fn look(fs: &dyn UninstallFs, state_dir: &Path, unit_files: &[PathBuf]) -> Self {
        Self {
            record: fs.exists(&state_dir.join(SCHEDULE_RECORD)),
            unit: present_unit(fs, unit_files),
        }
    }

    /// The refusal this observation means — the record's first, else the record-less unit's — or
    /// `None` when nothing refuses.
    pub fn refusal(&self) -> Option<String> {
        if self.record {
            return Some(REFUSED_FOR_SCHEDULE.to_string());
        }
        self.unit.as_deref().map(refused_for_unit)
    }
}

/// The app-owned records in `app_data_dir()` — the three `STORE_FILE` constants, referenced from
/// their owning modules so a rename there is a compile error here, not a leftover file.
pub const APP_DATA_FILES: &[&str] = &[
    autostart::STORE_FILE,
    notifications::STORE_FILE,
    access::STORE_FILE,
];

/// App-owned directories in `app_data_dir()`: T15's candidate staging dir (normally empty — every
/// save sweeps its own temp files — but a crash mid-save can leave one behind).
pub const APP_DATA_DIRS: &[&str] = &[config_save::CANDIDATE_SUBDIR];

/// App-owned files in `app_config_dir()`: the window-state plugin's file, named by the PLUGIN's
/// own constant so the two cannot drift (module header for the two-directory measurement).
pub const APP_CONFIG_FILES: &[&str] = &[tauri_plugin_window_state::DEFAULT_FILENAME];

/* ── the sink ─────────────────────────────────────────────────────────────────────────────────── */

/// The filesystem effects, injectable so the suite can record or sandbox them (B8's `ShimSink`
/// shape). Everything the module removes goes through here; nothing else touches the disk.
pub trait UninstallFs: Send + Sync {
    /// `symlink_metadata` presence — a broken symlink counts as present (it is removable), and so
    /// does a path that cannot be told absent ([`SystemFs::exists`]).
    fn exists(&self, path: &Path) -> bool;
    fn remove_file(&self, path: &Path) -> std::io::Result<()>;
    /// Called ONLY on the [`EntryKind::Dir`] entries and [`APP_DATA_DIRS`] — never on a state,
    /// data or config directory itself. `tests/uninstall.rs` pins the survivors.
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()>;
    /// Direct-child names of `dir`, for the one-star globs. Names, never paths.
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>>;
}

/// The real filesystem. Constructed in `lib.rs` only; tests inject fakes or scratch directories.
pub struct SystemFs;

impl UninstallFs for SystemFs {
    /// ⚠ ONLY "NO SUCH ENTRY" IS ABSENT (round 4, A4-L3). `NotFound`, and `NotADirectory` (a path
    /// component is a file, so nothing can be under it), say the entry is not there. Any other
    /// failure — `EACCES` on a parent that cannot be searched, an I/O error, a symlink loop on the
    /// way — says only that `lstat` could not answer, and counts as PRESENT: the record and unit
    /// gates refuse on a file they cannot rule out (`remove_engine_state`'s docs). It used to be
    /// `symlink_metadata(path).is_ok()`, which read every one of those as "absent".
    fn exists(&self, path: &Path) -> bool {
        match std::fs::symlink_metadata(path) {
            Ok(_) => true,
            Err(e) => !matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ),
        }
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_file(path)
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        std::fs::remove_dir_all(path)
    }
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            names.push(entry?.file_name().to_string_lossy().into_owned());
        }
        Ok(names)
    }
}

/* ── managed state ────────────────────────────────────────────────────────────────────────────── */

/// The sink, the two app directories and the home the scheduler unit files are looked for under,
/// overridable by tests ONLY (the `MockRuntime` `app_data_dir()` is the developer's REAL one — the
/// `ConfigSaver`/`AccessState` trap — and the real home holds the developer's real
/// `local.daily-briefing` unit, which would refuse every consented test run).
pub struct UninstallState {
    fs: Arc<dyn UninstallFs>,
    app_data_dir: Option<PathBuf>,
    app_config_dir: Option<PathBuf>,
    home_dir: Option<PathBuf>,
}

impl Default for UninstallState {
    fn default() -> Self {
        Self {
            fs: Arc::new(SystemFs),
            app_data_dir: None,
            app_config_dir: None,
            home_dir: None,
        }
    }
}

impl UninstallState {
    /// Test harness only.
    pub fn with_fs(mut self, fs: Arc<dyn UninstallFs>) -> Self {
        self.fs = fs;
        self
    }
    /// Test harness only.
    pub fn with_app_data_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.app_data_dir = Some(dir.into());
        self
    }
    /// Test harness only.
    pub fn with_app_config_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.app_config_dir = Some(dir.into());
        self
    }
    /// Test harness only — the home [`schedule_unit_files`] is resolved under. An overridden home
    /// also drops `$XDG_CONFIG_HOME`, so a test sees only the units it planted.
    pub fn with_home_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.home_dir = Some(dir.into());
        self
    }

    /// The scheduler unit files to look for: [`schedule_unit_files`] for this platform, under the
    /// override or else `HOME` (`USERPROFILE` on Windows, else `/` — `engine::home_dir`'s rule, the
    /// way the engine reads it) and this app's `$XDG_CONFIG_HOME`.
    fn unit_files(&self) -> Vec<PathBuf> {
        let os = std::env::consts::OS;
        if let Some(home) = &self.home_dir {
            return schedule_unit_files(os, home, None);
        }
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let home = std::env::var_os(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"));
        let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
        schedule_unit_files(os, &home, xdg.as_deref())
    }

    fn data_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, UninstallError> {
        if let Some(dir) = &self.app_data_dir {
            return Ok(dir.clone());
        }
        app.path()
            .app_data_dir()
            .map_err(|e| UninstallError::Store {
                detail: format!("this app's data directory could not be resolved: {e}"),
            })
    }

    fn config_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, UninstallError> {
        if let Some(dir) = &self.app_config_dir {
            return Ok(dir.clone());
        }
        app.path()
            .app_config_dir()
            .map_err(|e| UninstallError::Store {
                detail: format!("this app's config directory could not be resolved: {e}"),
            })
    }
}

/* ── wire types ───────────────────────────────────────────────────────────────────────────────── */

/// Why a command could not answer at all. Per-entry failures are [`Outcome::Failed`] in the
/// report instead — one unremovable file must not hide what WAS removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UninstallError {
    /// An app directory could not be resolved; `detail` says which and why.
    Store { detail: String },
}

/// One entry of the preview: what would be removed, and whether anything is there now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    /// The bare name (or the glob token) inside its directory — never a full path.
    pub name: String,
    pub kind: EntryKind,
    /// For a glob: at least one match exists.
    pub present: bool,
}

/// `uninstall_preview`'s answer: the enumerated lists, resolved and inspected — nothing removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPreview {
    pub app_data_dir: String,
    pub app_config_dir: String,
    pub app_entries: Vec<PreviewEntry>,
    /// `status --json`'s `paths.stateDir`; `null` with `engineError` set when the engine could
    /// not answer (the app legs are still previewable and executable).
    pub engine_state_dir: Option<String>,
    pub engine_error: Option<String>,
    pub engine_entries: Vec<PreviewEntry>,
    /// `is_enabled()`'s answer; `null` when it could not be read (`autostartError` says why).
    pub autostart_enabled: Option<bool>,
    pub autostart_error: Option<String>,
    /// Whether `<engine state dir>/schedule.json` exists — when it does, a consented run removes
    /// NOTHING of the engine's ([`REFUSED_FOR_SCHEDULE`], module header), and the consent wording
    /// says so, with the way out, before consent is given. `false` when the engine state dir could
    /// not be resolved (nothing engine-side is offered).
    pub schedule_record_present: bool,
    /// The first scheduler unit file the engine writes ([`schedule_unit_files`]) that is there —
    /// with or without a record. A consented run refuses while one is (module header, round 3
    /// D3-L4), so the consent wording reads it too. `None` when none is.
    pub schedule_unit_file: Option<String>,
    /// `std::env::consts::OS`: where the engine copy lives, and how the app itself is removed, is
    /// per platform (round 3, B3-L6), and the webview words it from this.
    pub os: String,
}

/// What happened to one entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum Outcome {
    Removed,
    Absent,
    Failed { detail: String },
}

/// One removal's report line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    pub name: String,
    pub outcome: Outcome,
}

/// `uninstall_execute`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    /// The T19 leg: `Removed` = the login item was disabled, `Absent` = it was not enabled.
    pub autostart: Outcome,
    /// The app-file legs, one line per enumerated entry.
    pub app: Vec<ActionReport>,
    /// True when at least one engine entry was ACTUALLY removed — derived from the outcomes,
    /// never echoed from the consent operand: consent over an empty state dir (all `Absent`), or
    /// with every removal refused (all `Failed`), reports false. (Round-1 fix F4: the old
    /// `consent && no resolution error` spelling reported true while every entry had failed.)
    pub engine_state_removed: bool,
    /// Empty unless consented — and empty when the leg was refused ([`Self::engine_refused`]).
    pub engine: Vec<ActionReport>,
    /// Set when consent was given and the state dir resolved, but a schedule record — or, with none,
    /// a scheduler unit file — was there, so the leg removed NOTHING ([`REFUSED_FOR_SCHEDULE`] or
    /// [`refused_for_unit`]; module header). ONE refusal for the whole leg rather than a line per
    /// entry: no entry was attempted.
    pub engine_refused: Option<String>,
    /// The directory the consented engine leg targeted — `status --json`'s answer at EXECUTE
    /// time, absolutised, so the report names where the removals landed (round-1 fix M3: consent
    /// is rendered against the preview's resolution, and this is the auditable record of the
    /// execute-time one; both go through the same [`engine_state_dir`] call path, so they can
    /// diverge only if the engine's own answer changed between the two spawns). `None` when the
    /// leg was not attempted or the engine could not answer; SET on a refusal too (the directory the
    /// refused leg targeted — a record's or a record-less unit's refusal alike).
    pub engine_state_dir: Option<String>,
    /// Set when consent was given but the engine could not name its state dir.
    pub engine_error: Option<String>,
    /// Whether `<state>/schedule.json` was there at EXECUTE time — checked whether or not consent
    /// was given (round 3, A3-L2), so the done view warns from what is on disk after the run rather
    /// than from the preview the user consented from. With [`Self::schedule_unit_file`] it is ONE
    /// look ([`ScheduleSeen`], round 4 G4-L1) — the one leg 3's gate refused on, when it ran. `None`
    /// when the engine could not name its state dir at execute time.
    pub schedule_record_present: Option<bool>,
    /// The first scheduler unit file ([`schedule_unit_files`]) that was there at EXECUTE time, or
    /// `None` — checked whether or not consent was given; the same look as the record's.
    pub schedule_unit_file: Option<String>,
    /// `std::env::consts::OS` — the done view's last step is per platform (round 3, B3-L6).
    pub os: String,
}

/* ── the removals, sink-driven and directly testable ──────────────────────────────────────────── */

fn remove_file_at(fs: &dyn UninstallFs, dir: &Path, name: &str) -> Outcome {
    match fs.remove_file(&dir.join(name)) {
        Ok(()) => Outcome::Removed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Outcome::Absent,
        Err(e) => Outcome::Failed {
            detail: e.to_string(),
        },
    }
}

fn remove_dir_at(fs: &dyn UninstallFs, dir: &Path, name: &str) -> Outcome {
    match fs.remove_dir_all(&dir.join(name)) {
        Ok(()) => Outcome::Removed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Outcome::Absent,
        Err(e) => Outcome::Failed {
            detail: e.to_string(),
        },
    }
}

/// `prefix*suffix` over a DIRECT-CHILD name. One star only — the script's `audit-*.md` shape;
/// `tests/uninstall.rs` pins that every glob token here has exactly one.
fn glob_matches(token: &str, name: &str) -> bool {
    let Some((prefix, suffix)) = token.split_once('*') else {
        return false;
    };
    name.len() >= prefix.len() + suffix.len() && name.starts_with(prefix) && name.ends_with(suffix)
}

fn remove_glob_at(fs: &dyn UninstallFs, dir: &Path, token: &str) -> Outcome {
    let names = match fs.list_dir(dir) {
        Ok(names) => names,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Outcome::Absent,
        Err(e) => {
            return Outcome::Failed {
                detail: e.to_string(),
            }
        }
    };
    let mut removed = false;
    let mut failures = Vec::new();
    for name in names.iter().filter(|n| glob_matches(token, n)) {
        match fs.remove_file(&dir.join(name)) {
            Ok(()) => removed = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    if !failures.is_empty() {
        return Outcome::Failed {
            detail: failures.join("; "),
        };
    }
    if removed {
        Outcome::Removed
    } else {
        Outcome::Absent
    }
}

/// The app-file legs: the records and candidate dir in `data_dir`, the window-state file in
/// `config_dir`. Enumerated removals only; the directories themselves are left in place.
pub fn remove_app_files(
    fs: &dyn UninstallFs,
    data_dir: &Path,
    config_dir: &Path,
) -> Vec<ActionReport> {
    let mut report = Vec::new();
    for name in APP_DATA_FILES {
        report.push(ActionReport {
            name: (*name).into(),
            outcome: remove_file_at(fs, data_dir, name),
        });
    }
    for name in APP_DATA_DIRS {
        report.push(ActionReport {
            name: (*name).into(),
            outcome: remove_dir_at(fs, data_dir, name),
        });
    }
    for name in APP_CONFIG_FILES {
        report.push(ActionReport {
            name: (*name).into(),
            outcome: remove_file_at(fs, config_dir, name),
        });
    }
    report
}

/// The consented engine leg: exactly [`ENGINE_STATE_REMOVALS`], each joined onto the ENGINE's
/// reported state dir. Never the directory itself — module header.
///
/// `Err` is the REFUSAL, and it means nothing was touched: while a [`SCHEDULE_RECORD`] exists the
/// leg removes nothing at all and answers [`REFUSED_FOR_SCHEDULE`]; with no record, while one of
/// `unit_files` ([`schedule_unit_files`]) exists, it answers [`refused_for_unit`] (module header).
/// Both are checked ONCE ([`ScheduleSeen::look`]), before the first removal, the way
/// `scripts/uninstall.sh` checks `$RECORD` before its `rm` lines, and a file that cannot be told
/// absent (`exists` is an `lstat`: a dangling symlink, or a path `lstat` cannot answer for, still
/// counts — [`SystemFs::exists`]) refuses — it fails toward not deleting.
pub fn remove_engine_state(
    fs: &dyn UninstallFs,
    state_dir: &Path,
    unit_files: &[PathBuf],
) -> Result<Vec<ActionReport>, String> {
    remove_engine_state_as_seen(
        fs,
        state_dir,
        &ScheduleSeen::look(fs, state_dir, unit_files),
    )
}

/// [`remove_engine_state`], gated on a look the caller has just taken and REPORTS
/// (`uninstall_execute`, round 4 G4-L1) — so the refusal and the report's schedule facts are one
/// observation. The caller takes it immediately before this call, with nothing awaited between.
fn remove_engine_state_as_seen(
    fs: &dyn UninstallFs,
    state_dir: &Path,
    seen: &ScheduleSeen,
) -> Result<Vec<ActionReport>, String> {
    if let Some(refused) = seen.refusal() {
        return Err(refused);
    }
    Ok(ENGINE_STATE_REMOVALS
        .iter()
        .map(|entry| ActionReport {
            name: entry.token.into(),
            outcome: match entry.kind {
                EntryKind::File => remove_file_at(fs, state_dir, entry.token),
                EntryKind::Glob => remove_glob_at(fs, state_dir, entry.token),
                EntryKind::Dir => remove_dir_at(fs, state_dir, entry.token),
            },
        })
        .collect())
}

/// For [`EntryKind::Glob`] entries the `PathBuf` is the DIRECTORY the token matches inside; for
/// the other kinds it is the entry itself.
fn preview_entries(
    fs: &dyn UninstallFs,
    entries: impl IntoIterator<Item = (String, EntryKind, PathBuf)>,
) -> Vec<PreviewEntry> {
    entries
        .into_iter()
        .map(|(name, kind, path)| {
            let present = match kind {
                EntryKind::Glob => fs
                    .list_dir(&path)
                    .map(|names| names.iter().any(|n| glob_matches(&name, n)))
                    .unwrap_or(false),
                _ => fs.exists(&path),
            };
            PreviewEntry {
                name,
                kind,
                present,
            }
        })
        .collect()
}

fn app_preview(fs: &dyn UninstallFs, data_dir: &Path, config_dir: &Path) -> Vec<PreviewEntry> {
    let mut entries: Vec<(String, EntryKind, PathBuf)> = Vec::new();
    for name in APP_DATA_FILES {
        entries.push(((*name).into(), EntryKind::File, data_dir.join(name)));
    }
    for name in APP_DATA_DIRS {
        entries.push(((*name).into(), EntryKind::Dir, data_dir.join(name)));
    }
    for name in APP_CONFIG_FILES {
        entries.push(((*name).into(), EntryKind::File, config_dir.join(name)));
    }
    preview_entries(fs, entries)
}

fn engine_preview(fs: &dyn UninstallFs, state_dir: &Path) -> Vec<PreviewEntry> {
    preview_entries(
        fs,
        ENGINE_STATE_REMOVALS.iter().map(|e| {
            let path = match e.kind {
                EntryKind::Glob => state_dir.to_path_buf(),
                _ => state_dir.join(e.token),
            };
            (e.token.to_string(), e.kind, path)
        }),
    )
}

/* ── the engine read ──────────────────────────────────────────────────────────────────────────── */

/// The engine's state dir, absolutised (`cli_shim::engine_targets`' rule: a relative dir would
/// make the removal target depend on this app's working directory).
async fn engine_state_dir(client: &EngineClient) -> Result<PathBuf, String> {
    let paths = engine_paths(client).await?;
    absolute("status --json", "paths.stateDir", paths.state_dir.as_ref())
}

fn client_of(engine: &Engine) -> Result<&EngineClient, String> {
    engine.client().map_err(|e| e.to_string())
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// What an uninstall would remove, resolved and inspected. Read-only: one engine spawn
/// (`status --json`), one `is_enabled()` read, and `lstat`s.
#[tauri::command]
pub async fn uninstall_preview<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    state: State<'_, UninstallState>,
) -> Result<UninstallPreview, UninstallError> {
    let data_dir = state.data_dir(&app)?;
    let config_dir = state.config_dir(&app)?;
    let app_entries = app_preview(state.fs.as_ref(), &data_dir, &config_dir);
    let (engine_state_dir_path, engine_error) = match client_of(&engine) {
        Ok(client) => match engine_state_dir(client).await {
            Ok(dir) => (Some(dir), None),
            Err(detail) => (None, Some(detail)),
        },
        Err(detail) => (None, Some(detail)),
    };
    let engine_entries = engine_state_dir_path
        .as_deref()
        .map(|dir| engine_preview(state.fs.as_ref(), dir))
        .unwrap_or_default();
    let schedule_record_present = engine_state_dir_path
        .as_deref()
        .is_some_and(|dir| state.fs.exists(&dir.join(SCHEDULE_RECORD)));
    let schedule_unit_file =
        present_unit(state.fs.as_ref(), &state.unit_files()).map(|unit| unit.display().to_string());
    let (autostart_enabled, autostart_error) = match autostart::enabled_now(&app) {
        Ok(enabled) => (Some(enabled), None),
        Err(detail) => (None, Some(detail)),
    };
    Ok(UninstallPreview {
        app_data_dir: data_dir.display().to_string(),
        app_config_dir: config_dir.display().to_string(),
        app_entries,
        engine_state_dir: engine_state_dir_path.map(|d| d.display().to_string()),
        engine_error,
        engine_entries,
        autostart_enabled,
        autostart_error,
        schedule_record_present,
        schedule_unit_file,
        os: std::env::consts::OS.to_string(),
    })
}

/// Perform the uninstall. `remove_engine_state` is the EXPLICIT consent flag for leg 3 — false
/// touches nothing of the engine's (it still READS: one `status --json` spawn and `lstat`s, for the
/// report's execute-time schedule facts). Per-entry failures are reported, not thrown; the report
/// says exactly what happened to each enumerated name.
#[tauri::command]
pub async fn uninstall_execute<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    state: State<'_, UninstallState>,
    remove_engine_state: bool,
) -> Result<UninstallReport, UninstallError> {
    let data_dir = state.data_dir(&app)?;
    let config_dir = state.config_dir(&app)?;

    // Leg 1 — the login item, through T19's own disable (reused, not forked). `is_enabled` first:
    // the plugin's `disable()` on an absent entry is not a removal to report as one. Read and
    // disable run under the login-item change lock, so a concurrent ON's branding cannot re-create
    // the plist between them (`autostart::lock_changes`). The guard is dropped at the end of this
    // block — before any `.await` below.
    let autostart_outcome = match autostart::lock_changes(&app) {
        Err(detail) => Outcome::Failed { detail },
        Ok(held) => match autostart::enabled_now(&app) {
            Ok(false) => Outcome::Absent,
            Ok(true) => match autostart::disable_now(&app, &held) {
                Ok(()) => Outcome::Removed,
                Err(detail) => Outcome::Failed { detail },
            },
            Err(detail) => Outcome::Failed { detail },
        },
    };

    // The schedule, as it is NOW — read whether or not consent was given (round 3, A3-L2), so the
    // done view's warning that a schedule outlives the app is the execute-time truth, not the
    // preview's. The state dir is resolved through the SAME [`engine_state_dir`] call path
    // `uninstall_preview` used — a `status --json` spawn, read-only, never a webview-echoed path;
    // the unit files are `lstat`s under the home ([`schedule_unit_files`]).
    let unit_files = state.unit_files();
    let resolved = match client_of(&engine) {
        Ok(client) => engine_state_dir(client).await,
        Err(detail) => Err(detail),
    };
    // ⚠ ONE LOOK, AFTER THE SPAWN, AND THE GATE REFUSES ON THE SAME ONE (round 4, G4-L1): the
    // report's schedule facts are exactly what leg 3's gate sees — taken here, with nothing awaited
    // between this and the gate, so it is as fresh as the gate's own look always was. With no state
    // dir there is no record to look for (`None`: unknown) and no leg; the units are looked at all
    // the same.
    let looked = resolved.map(|dir| {
        let seen = ScheduleSeen::look(state.fs.as_ref(), &dir, &unit_files);
        (dir, seen)
    });
    let (schedule_record_present, schedule_unit_file) = match &looked {
        Ok((_, seen)) => (Some(seen.record), seen.unit.clone()),
        Err(_) => (None, present_unit(state.fs.as_ref(), &unit_files)),
    };
    let schedule_unit_file = schedule_unit_file.map(|unit| unit.display().to_string());

    // Leg 3 — engine state, consent-gated, at the directory resolved above. Before leg 2 only so
    // that a report is ordered the way the module header narrates; nothing app-side feeds it. The
    // resolved directory is echoed into the report so the consented target is auditable after the
    // fact (round-1 fix M3). A schedule record — or, with none, a scheduler unit file — refuses the
    // whole leg (module header): nothing removed, the directory still named, and the refusal
    // reported once.
    let (engine_report, engine_dir, engine_refused, engine_error) = if remove_engine_state {
        match &looked {
            Ok((dir, seen)) => match remove_engine_state_as_seen(state.fs.as_ref(), dir, seen) {
                Ok(report) => (report, Some(dir.display().to_string()), None, None),
                Err(refused) => (
                    Vec::new(),
                    Some(dir.display().to_string()),
                    Some(refused),
                    None,
                ),
            },
            Err(detail) => (Vec::new(), None, None, Some(detail.clone())),
        }
    } else {
        (Vec::new(), None, None, None)
    };

    // Leg 2 — the app's own files.
    let app_report = remove_app_files(state.fs.as_ref(), &data_dir, &config_dir);

    Ok(UninstallReport {
        autostart: autostart_outcome,
        app: app_report,
        // Derived from what HAPPENED, not from what was asked (round-1 fix F4).
        engine_state_removed: engine_report
            .iter()
            .any(|r| matches!(r.outcome, Outcome::Removed)),
        engine: engine_report,
        engine_state_dir: engine_dir,
        engine_refused,
        engine_error,
        schedule_record_present,
        schedule_unit_file,
        os: std::env::consts::OS.to_string(),
    })
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["uninstall_preview", "uninstall_execute"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_glob_token_matches_the_scripts_shape() {
        assert!(glob_matches("audit-*.md", "audit-2026-09-17.md"));
        assert!(glob_matches("audit-*.md", "audit-.md"));
        assert!(!glob_matches("audit-*.md", "audit-2026-09-17.txt"));
        assert!(!glob_matches("audit-*.md", "briefing.log"));
        // The overlap trap: prefix and suffix must not share characters of a too-short name.
        assert!(!glob_matches("audit-*.md", "audit-"));
        assert!(!glob_matches("no-star", "no-star"));
    }
}
