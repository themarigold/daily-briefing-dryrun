//! A-M1-T1 — the app's own preference store (redesign A spec, "The app preference store"): the
//! first name, used only in the greeting, the "Show the briefing as slides" switch and (B2-M4-T10)
//! the GitHub links switch and each project's editor choice.
//!
//! ## The file
//!
//! `<app_data_dir>/app-prefs.json`, `{ "firstName": "Sam", "slides": false, "githubLinks": true,
//! "editorChoices": {} }`. An absent `firstName` is unset; an absent `slides` or `githubLinks` is on;
//! an absent `editorChoices` is empty. App-owned, not an engine path: it is not part of the config
//! draft, and the first name is never sent to the engine or the AI.
//!
//! **Reads** never fail: a missing, corrupt, oversized, non-UTF-8 or symlinked file reads as the
//! defaults (name unset, slides and links on, no editor choices), FIELD BY FIELD — a valid name beside
//! an invalid `slides` keeps the name. Inside `editorChoices` an invalid key or value (a stored `null` included) drops only
//! that entry, and a dropped entry reads as never chosen. A stored name is re-validated on read, so
//! a hand-edited one is held to the same rule as a typed one. The next set rewrites the file.
//!
//! **Writes** are one read-modify-write under the store's mutex: a NEW 0600 temp file beside the
//! store (create-new, so a planted name is never followed or replaced; 0600 because the name is
//! personal), then renamed over it. A failed rename removes the temp. Every write is held to
//! [`MAX_PREFS_BYTES`], the most a read will take: a file past it would read as all defaults, so a
//! write that would pass it refuses as [`AppPrefsError::PreferencesFull`], touching nothing, and
//! nothing is evicted to make room. `app_prefs_set` never writes `editorChoices`; only
//! [`AppPrefs::set_editor_choice`] does.
//!
//! ## The first name
//!
//! Validated here, the one copy (the Settings row shows the refusal's sentence inline): trimmed;
//! empty means unset; at most [`FIRST_NAME_MAX_CHARS`] Unicode scalar values; refused if it holds a
//! control character or U+2028 / U+2029 (line breaks; round-3 L5), a Unicode `Bidi_Control`
//! character ([`is_bidi_control`]), or if it has no
//! character that shows: every one `White_Space` or `Default_Ignorable_Code_Point`
//! ([`is_default_ignorable`]; round-1 L5 — a name of U+200B alone read "Good morning, "). ZWJ and
//! ZWNJ inside a real name are kept. A refused set changes nothing — not the file, and not the
//! other field of the same patch.
//!
//! None of the refusal sentences says "not allowed": `tests/capability.rs` reads that phrase as the
//! ACL's denial, and a refusal here is this module's own code answering.
//!
//! ## Locks
//!
//! The mutex is a `std::sync::Mutex` held only for the synchronous read-modify-write, never across
//! an await. It also guards the uninstall latch ([`AppPrefs::close_for_uninstall`]): the app stays
//! open on Settings after Uninstall, and the first-name row saves on blur, so without it a later
//! set would write the name back after the report said the file was removed (A-M1-T3 checkpoint
//! review, the `pending_resets` shape). And it guards the store's REVISION (round-4 L1), bumped by
//! each write that lands and answered by both commands, so the webview can keep the newest answer
//! whatever order two answers arrive in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::briefing_files::read_text_capped;
use crate::config_save::{unique, write_new_file};
use crate::editor::EditorChoice;
use crate::repos::is_project_key;

/// The store's file, under the app's data directory. Uninstall's `APP_DATA_FILES` names it.
pub const APP_PREFS_FILE: &str = "app-prefs.json";

/// Every temp file a write stages begins with this, followed by `<pid>-<seq>`; uninstall's
/// `APP_DATA_GLOBS` token is this plus `*`.
pub const APP_PREFS_TEMP_PREFIX: &str = "app-prefs.json.tmp-";

/// The bound on the file: the most a read will take, and what every write enforces. The file holds
/// the name, the slides and GitHub links switches and the editor choices.
pub const MAX_PREFS_BYTES: u64 = 16 * 1024;

/// The longest first name, in Unicode scalar values.
pub const FIRST_NAME_MAX_CHARS: usize = 40;

/// The refusal for a name over [`FIRST_NAME_MAX_CHARS`].
pub const FIRST_NAME_TOO_LONG: &str = "Your first name can be at most 40 characters.";

/// The refusal for a name holding a control character.
pub const FIRST_NAME_CONTROL: &str =
    "Your first name cannot contain control characters such as tabs or line breaks.";

/// The refusal for a name holding a character that changes the direction of text.
pub const FIRST_NAME_BIDI: &str =
    "Your first name cannot contain invisible characters that change the direction of text.";

/// The refusal for a name with no character that shows (only spaces and invisible characters).
pub const FIRST_NAME_INVISIBLE: &str =
    "Your first name must contain at least one visible character, not only spaces or invisible ones.";

/// Why every set refuses once uninstall's app-files leg has run ([`AppPrefs::close_for_uninstall`]).
pub const APP_PREFS_CLOSED_BY_UNINSTALL: &str =
    "This app's files were removed by Uninstall, so your preferences are not saved any more.";

/// A project's key in `editorChoices`: exactly 32 lowercase hex bytes, built by the engine. Rust only
/// checks the shape ([`is_project_key`]); it never hashes one.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct ProjectKey(String);

impl ProjectKey {
    /// `None` for anything but the key's exact shape.
    pub fn parse(raw: &str) -> Option<Self> {
        is_project_key(raw).then(|| Self(raw.to_string()))
    }
}

/// The stored values, as both commands answer them. `firstName` is absent from the wire and the
/// file while unset; the others are always present, `editorChoices` as `{}` when empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefsValues {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    pub slides: bool,
    pub github_links: bool,
    pub editor_choices: BTreeMap<ProjectKey, EditorChoice>,
}

impl Default for AppPrefsValues {
    fn default() -> Self {
        Self {
            first_name: None,
            slides: true,
            github_links: true,
            editor_choices: BTreeMap::new(),
        }
    }
}

/// What both COMMANDS answer (round-4 L1): the stored values and the store's REVISION, the number of
/// successful writes in this app session, read or bumped under the store's mutex. The webview sends its
/// sets one at a time, in call order (its store queues them), so only a set and the one load (startup's
/// `app_prefs_get`) can be in flight together and answer in either order; the webview keeps the answer
/// with the highest revision, the backstop for that crossing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPrefsAnswer {
    #[serde(flatten)]
    pub values: AppPrefsValues,
    pub revision: u64,
}

/// `app_prefs_set`'s one argument. An absent field is left as it is; `firstName: ""` unsets the
/// name. `{}` is a set that changes nothing and writes nothing. `editorChoices` is not a member, so
/// it is refused.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppPrefsPatch {
    pub first_name: Option<String>,
    pub slides: Option<bool>,
    pub github_links: Option<bool>,
}

/// Why a command did not answer. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppPrefsError {
    /// The name was refused; `reason` is the sentence the Settings row shows. Nothing was written.
    #[serde(rename_all = "camelCase")]
    InvalidInput { field: String, reason: String },
    /// The store's folder could not be resolved, or the file could not be written.
    Store { detail: String },
    /// The write would take the file past [`MAX_PREFS_BYTES`]. Nothing was written.
    #[serde(rename = "preferences-full")]
    PreferencesFull,
}

/// The store, held closed by uninstall's app-files leg: the mutex is held for as long as this
/// lives, so no set is in flight while that leg removes the file and its temp siblings, and the
/// latch it set refuses every later one. Never held across an await.
pub struct ClosedAppPrefs<'a>(#[allow(dead_code)] std::sync::MutexGuard<'a, StoreState>);

/// What the store's mutex guards.
#[derive(Default)]
struct StoreState {
    /// `true` once uninstall's app-files leg closed the store: every later set refuses.
    closed: bool,
    /// Successful writes this session ([`AppPrefsAnswer::revision`]).
    revision: u64,
}

/// Managed state: the store's mutex (guarding the uninstall latch and the revision), and the test
/// override.
#[derive(Default)]
pub struct AppPrefs {
    state: Mutex<StoreState>,
    /// `None` = `app_data_dir()`. **Test harness only** — a MockRuntime app's is the developer's.
    store_dir: Option<PathBuf>,
}

impl AppPrefs {
    /// **Test harness only** — see the field docs.
    pub fn with_store_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.store_dir = Some(dir.into());
        self
    }

    pub(crate) fn store_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, AppPrefsError> {
        if let Some(dir) = &self.store_dir {
            return Ok(dir.clone());
        }
        app.path().app_data_dir().map_err(|e| AppPrefsError::Store {
            detail: format!("this app's data directory could not be resolved: {e}"),
        })
    }

    /// Uninstall's app-files leg: take the store's mutex, set the closed latch, and hand the held
    /// mutex back, so the leg removes `app-prefs.json` and its temp siblings with no set in flight
    /// and none to come. Every later set answers [`APP_PREFS_CLOSED_BY_UNINSTALL`]; the closure
    /// lasts for the rest of this app session. A get still answers.
    pub fn close_for_uninstall(&self) -> ClosedAppPrefs<'_> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        ClosedAppPrefs(state)
    }

    /// The values in `dir`'s store (see [`read_prefs`]).
    pub fn get(&self, dir: &Path) -> AppPrefsValues {
        self.get_answer(dir).values
    }

    /// [`Self::get`] with the store's revision, read under the same lock (`app_prefs_get`'s answer).
    pub fn get_answer(&self, dir: &Path) -> AppPrefsAnswer {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        AppPrefsAnswer {
            values: read_prefs(dir),
            revision: state.revision,
        }
    }

    /// See [`Self::set_answer`]; the values only.
    pub fn set(&self, dir: &Path, patch: AppPrefsPatch) -> Result<AppPrefsValues, AppPrefsError> {
        self.set_answer(dir, patch).map(|answer| answer.values)
    }

    /// Apply `patch` to `dir`'s store: the name validated first (a refusal touches nothing), then
    /// ONE read-modify-write under the mutex. An empty patch writes nothing. Refused, touching
    /// nothing, once uninstall closed the store. Answers the values now stored and the revision, bumped
    /// (under the lock) by each write that landed; a set that writes nothing answers the current one.
    pub fn set_answer(
        &self,
        dir: &Path,
        patch: AppPrefsPatch,
    ) -> Result<AppPrefsAnswer, AppPrefsError> {
        let first_name =
            match &patch.first_name {
                Some(raw) => Some(validate_first_name(raw).map_err(|reason| {
                    AppPrefsError::InvalidInput {
                        field: "firstName".into(),
                        reason: reason.into(),
                    }
                })?),
                None => None,
            };
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(AppPrefsError::Store {
                detail: APP_PREFS_CLOSED_BY_UNINSTALL.into(),
            });
        }
        let mut values = read_prefs(dir);
        if first_name.is_none() && patch.slides.is_none() && patch.github_links.is_none() {
            return Ok(AppPrefsAnswer {
                values,
                revision: state.revision,
            });
        }
        if let Some(name) = first_name {
            values.first_name = name;
        }
        if let Some(on) = patch.slides {
            values.slides = on;
        }
        if let Some(on) = patch.github_links {
            values.github_links = on;
        }
        write_prefs(dir, &values)?;
        state.revision += 1;
        Ok(AppPrefsAnswer {
            values,
            revision: state.revision,
        })
    }

    /// Store `choice` for `project` (B2-M4-T10): the one writer of `editorChoices`, through the same
    /// read-modify-write, revision and size bound as [`Self::set_answer`]. The key and the value are
    /// valid by their types ([`ProjectKey::parse`], [`EditorChoice`]'s closed tokens). Refused, touching
    /// nothing, once uninstall closed the store.
    pub fn set_editor_choice(
        &self,
        dir: &Path,
        project: ProjectKey,
        choice: EditorChoice,
    ) -> Result<AppPrefsAnswer, AppPrefsError> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(AppPrefsError::Store {
                detail: APP_PREFS_CLOSED_BY_UNINSTALL.into(),
            });
        }
        let mut values = read_prefs(dir);
        values.editor_choices.insert(project, choice);
        write_prefs(dir, &values)?;
        state.revision += 1;
        Ok(AppPrefsAnswer {
            values,
            revision: state.revision,
        })
    }
}

/// U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069: Unicode's `Bidi_Control` set.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// Unicode's `Default_Ignorable_Code_Point` (DerivedCoreProperties.txt, Unicode 15.1): characters a
/// renderer draws as nothing when it does not support them — the soft hyphen, the zero-width space,
/// joiners and non-joiners, the word joiner and invisible operators, variation selectors, the BOM,
/// the Hangul fillers and the tag characters, among others.
fn is_default_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{00ad}'
            | '\u{034f}'
            | '\u{061c}'
            | '\u{115f}'..='\u{1160}'
            | '\u{17b4}'..='\u{17b5}'
            | '\u{180b}'..='\u{180f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{3164}'
            | '\u{fe00}'..='\u{fe0f}'
            | '\u{feff}'
            | '\u{ffa0}'
            | '\u{fff0}'..='\u{fff8}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0000}'..='\u{e0fff}'
    )
}

/// The first name's rule (module header): `Ok(None)` = unset, `Ok(Some(trimmed))`, or the refusal's
/// sentence.
fn validate_first_name(raw: &str) -> Result<Option<String>, &'static str> {
    let name = raw.trim();
    if name.is_empty() {
        return Ok(None);
    }
    // Round-3 L5: U+2028 / U+2029 (LINE and PARAGRAPH SEPARATOR) are not `Cc`, but they ARE line breaks, which
    // the refusal names; inside a name they are refused with it (at the ends the trim has removed them).
    if name
        .chars()
        .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
    {
        return Err(FIRST_NAME_CONTROL);
    }
    if name.chars().any(is_bidi_control) {
        return Err(FIRST_NAME_BIDI);
    }
    // Round-1 L5: nothing that shows (`char::is_whitespace` is Unicode's `White_Space`).
    if name
        .chars()
        .all(|c| c.is_whitespace() || is_default_ignorable(c))
    {
        return Err(FIRST_NAME_INVISIBLE);
    }
    if name.chars().count() > FIRST_NAME_MAX_CHARS {
        return Err(FIRST_NAME_TOO_LONG);
    }
    Ok(Some(name.to_string()))
}

/// The values in `dir`'s store. Never fails: a missing, corrupt, oversized, non-UTF-8 or symlinked
/// file (`read_text_capped` opens with no-follow) reads as the defaults, and each field that is
/// missing or invalid reads as its own default.
pub fn read_prefs(dir: &Path) -> AppPrefsValues {
    let mut values = AppPrefsValues::default();
    let Ok(text) = read_text_capped(&dir.join(APP_PREFS_FILE), MAX_PREFS_BYTES) else {
        return values;
    };
    let Ok(Value::Object(file)) = serde_json::from_str::<Value>(&text) else {
        return values;
    };
    if let Some(Ok(Some(name))) = file
        .get("firstName")
        .and_then(Value::as_str)
        .map(validate_first_name)
    {
        values.first_name = Some(name);
    }
    if let Some(on) = file.get("slides").and_then(Value::as_bool) {
        values.slides = on;
    }
    if let Some(on) = file.get("githubLinks").and_then(Value::as_bool) {
        values.github_links = on;
    }
    if let Some(choices) = file.get("editorChoices").and_then(Value::as_object) {
        values.editor_choices = choices
            .iter()
            .filter_map(|(key, choice)| {
                let choice = EditorChoice::deserialize(choice).ok()?;
                Some((ProjectKey::parse(key)?, choice))
            })
            .collect();
    }
    values
}

/// Write the values: the folder created first (`write_new_file` opens create-new and fails on a
/// missing folder), a NEW 0600 temp file, then a rename over the store.
fn write_prefs(dir: &Path, values: &AppPrefsValues) -> Result<(), AppPrefsError> {
    let store = |detail: String| AppPrefsError::Store { detail };
    let text = serde_json::to_string_pretty(values)
        .map_err(|e| store(format!("the app preferences could not be serialised: {e}")))?;
    if text.len() as u64 > MAX_PREFS_BYTES {
        return Err(AppPrefsError::PreferencesFull);
    }
    std::fs::create_dir_all(dir).map_err(|e| store(format!("{}: {e}", dir.display())))?;
    let path = dir.join(APP_PREFS_FILE);
    let tmp = dir.join(format!("{APP_PREFS_TEMP_PREFIX}{}", unique()));
    write_new_file(&tmp, text.as_bytes(), 0o600)
        .map_err(|e| store(format!("{}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        store(format!("{}: {e}", path.display()))
    })
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// The stored values (the defaults when the file is missing or unreadable), with the store's revision.
#[tauri::command]
pub async fn app_prefs_get<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppPrefs>,
) -> Result<AppPrefsAnswer, AppPrefsError> {
    let dir = state.store_dir(&app)?;
    Ok(state.get_answer(&dir))
}

/// Change the first name, the slides switch, the GitHub links switch, or any of them together. Takes
/// no path; answers the values now stored with the store's revision, or the name's or the size bound's
/// refusal (nothing written).
#[tauri::command]
pub async fn app_prefs_set<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppPrefs>,
    patch: AppPrefsPatch,
) -> Result<AppPrefsAnswer, AppPrefsError> {
    let dir = state.store_dir(&app)?;
    state.set_answer(&dir, patch)
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["app_prefs_get", "app_prefs_set"];
