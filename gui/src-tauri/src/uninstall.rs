//! T25 (B25) — the Settings-side "Uninstall app" action.
//!
//! ## What it removes, and what it never touches
//!
//! Three legs, each reported separately (`docs/gui-seam.md` §16):
//!
//!   1. **The app's own autostart entry** — T19's plugin `disable()`, REUSED through
//!      `autostart::disable_now` (the same sink-or-plugin resolution `autostart::startup` uses),
//!      never a hand-rolled plist removal. The real plugin leg is VM-gated exactly as T19's is
//!      (§12c); the suite drives a recording sink.
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
//!      `scripts/uninstall.sh`'s bounded `$SUPPORT`-rooted list (`:11-24`) token for token, and
//!      `tests/uninstall.rs` PARSES the script at test time and asserts set-equality (the T9
//!      pathEnv parity pattern) — the two spellings cannot drift silently. The state dir is the
//!      ENGINE's answer (`status --json` → `paths.stateDir`, absolutised), never a webview
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

/// The consent-gated engine-state list: `scripts/uninstall.sh:11-24`'s `$SUPPORT`-rooted
/// removals, token for token. Set-equality with a test-time PARSE of the script is pinned by
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
];

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
    /// `symlink_metadata` presence — a broken symlink counts as present (it is removable).
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
    fn exists(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok()
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

/// The sink and the two app directories, overridable by tests ONLY (the `MockRuntime`
/// `app_data_dir()` is the developer's REAL one — the `ConfigSaver`/`AccessState` trap).
pub struct UninstallState {
    fs: Arc<dyn UninstallFs>,
    app_data_dir: Option<PathBuf>,
    app_config_dir: Option<PathBuf>,
}

impl Default for UninstallState {
    fn default() -> Self {
        Self {
            fs: Arc::new(SystemFs),
            app_data_dir: None,
            app_config_dir: None,
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
    /// Empty unless consented.
    pub engine: Vec<ActionReport>,
    /// The directory the consented engine leg targeted — `status --json`'s answer at EXECUTE
    /// time, absolutised, so the report names where the removals landed (round-1 fix M3: consent
    /// is rendered against the preview's resolution, and this is the auditable record of the
    /// execute-time one; both go through the same [`engine_state_dir`] call path, so they can
    /// diverge only if the engine's own answer changed between the two spawns). `None` when the
    /// leg was not attempted or the engine could not answer.
    pub engine_state_dir: Option<String>,
    /// Set when consent was given but the engine could not name its state dir.
    pub engine_error: Option<String>,
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
pub fn remove_engine_state(fs: &dyn UninstallFs, state_dir: &Path) -> Vec<ActionReport> {
    ENGINE_STATE_REMOVALS
        .iter()
        .map(|entry| ActionReport {
            name: entry.token.into(),
            outcome: match entry.kind {
                EntryKind::File => remove_file_at(fs, state_dir, entry.token),
                EntryKind::Glob => remove_glob_at(fs, state_dir, entry.token),
                EntryKind::Dir => remove_dir_at(fs, state_dir, entry.token),
            },
        })
        .collect()
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
    })
}

/// Perform the uninstall. `remove_engine_state` is the EXPLICIT consent flag for leg 3 — false
/// touches nothing of the engine's. Per-entry failures are reported, not thrown; the report says
/// exactly what happened to each enumerated name.
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
    // the plugin's `disable()` on an absent entry is not a removal to report as one.
    let autostart_outcome = match autostart::enabled_now(&app) {
        Ok(false) => Outcome::Absent,
        Ok(true) => match autostart::disable_now(&app) {
            Ok(()) => Outcome::Removed,
            Err(detail) => Outcome::Failed { detail },
        },
        Err(detail) => Outcome::Failed { detail },
    };

    // Leg 3 — engine state, consent-gated, resolved from the ENGINE. Before leg 2 only so that a
    // report is ordered the way the module header narrates; nothing app-side feeds it. The
    // resolution is the SAME [`engine_state_dir`] call path `uninstall_preview` used — a second
    // `status --json` spawn, not a webview-echoed path — and the resolved directory is echoed
    // into the report so the consented target is auditable after the fact (round-1 fix M3).
    let (engine_report, engine_dir, engine_error) = if remove_engine_state {
        match client_of(&engine) {
            Ok(client) => match engine_state_dir(client).await {
                Ok(dir) => {
                    let report = remove_engine_state_leg(state.fs.as_ref(), &dir);
                    (report, Some(dir.display().to_string()), None)
                }
                Err(detail) => (Vec::new(), None, Some(detail)),
            },
            Err(detail) => (Vec::new(), None, Some(detail)),
        }
    } else {
        (Vec::new(), None, None)
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
        engine_error,
    })
}

/// Free-function alias so the command body above reads as the leg it is; the public name
/// [`remove_engine_state`] is taken by the operand.
fn remove_engine_state_leg(fs: &dyn UninstallFs, state_dir: &Path) -> Vec<ActionReport> {
    remove_engine_state(fs, state_dir)
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
