//! T15 — the app's ONE config-write path, and the Quit dialog's `notify: "auto"` offer on top of it.
//!
//! ## The pipeline, in order
//!
//! 1. **Where.** `status --json` → `paths.configPath`. NEVER Tauri's `app_config_dir()`: the engine's
//!    config is XDG-style on every platform (`src/config.ts`, `configPath()`), and a GUI writing to
//!    the platform config dir would produce settings that silently do nothing (appendix T15's
//!    stated HIGH risk). The webview cannot name a path: [`config_save`] takes JSON TEXT and a base
//!    token, nothing else.
//! 2. **What is there.** The current file, read with the same capped, no-follow, UTF-8 read the
//!    briefing commands use, plus a single-link rule. No file → refused ([`SaveError::NoConfig`]):
//!    Settings edits a config, it does not create one (the first-run path is `daily-briefing init` /
//!    T16's wizard, whose do-not-clobber behaviour R1 protects). A symlink, or a file with more than
//!    one hard link → refused: an atomic rename replaces ONE NAME with a new file and would silently
//!    detach a dotfiles-managed config. A file that is not JSON → refused: the app will not replace
//!    what it cannot read. A candidate over [`MAX_CONFIG_BYTES`] → refused before it is parsed.
//! 3. **Nobody else changed it.** The webview got a `base` token (a digest of the bytes it was
//!    shown) from [`config_read`]; a different digest now is [`SaveError::Conflict`] — plan R1's
//!    "config mtime guard", keyed on content rather than on a timestamp.
//! 4. **Two human gates.** `transcripts` must be what is on disk — plan R1 T15: "re-enabling is a
//!    human gate, not an app setting", enforced here for the form AND the raw-JSON tab, which both
//!    arrive as the same text. "The same" is JSON equality: key order and number SPELLING (`50.0`
//!    vs `50`, which the form's JavaScript round trip changes) are not changes ([`json_eq`]). And a
//!    literal `provider.api.apiKey` is never sent to the webview (it gets [`REDACTED_API_KEY`] in
//!    its place) and can be KEPT or REMOVED from the app, never set or changed — the engine has no
//!    `--api-key` flag for the same reason (`src/main.ts` usage text).
//! 5. **A no-op writes nothing.** The candidate is re-serialised as
//!    `JSON.stringify(x, null, 2)` does it (2-space indent, insertion order — serde_json's
//!    `preserve_order`, no trailing newline, which is how `initConfig` writes it); if that equals the
//!    same serialisation of what is on disk, nothing is validated and nothing is written.
//! 6. **The engine validates.** The candidate goes to an app-owned file under the app's DATA dir
//!    (`<app_data_dir>/config-candidates/candidate-<pid>-<seq>.json`, mode 0600 in a 0700
//!    directory, removed afterwards; stale ones swept first) and through
//!    `config validate --json --file <it>` — B3's operand validator, unchanged. ERRORS block;
//!    WARNINGS are returned and do not block. No validation rule lives in this file.
//! 7. **Atomic replace** ([`replace_config_file`]). The new bytes and the backup bytes are staged in
//!    this app's own temp files IN THE SAME DIRECTORY (`fsync`ed); the file is re-read and must
//!    still be what was validated; only then is the backup renamed to `<config>.bak` and the new
//!    bytes renamed over the config, and the directory `fsync`ed. A failure anywhere leaves the
//!    config AND `.bak` as they were (a failed final rename puts the previous `.bak` back). The
//!    previous `.bak` is kept aside by a hard link, or — on a filesystem without hard links (FAT32,
//!    exFAT, some network shares) — by a rename; a `.bak` that is not a regular file is refused by
//!    name ([`SaveError::BackupNotAFile`]) and left alone. The
//!    file mode is kept — tightened to owner-only when the candidate OR the file on disk carries a
//!    `provider.api` block (what `initConfig` does for an API config), and `.bak` is never wider
//!    than the new file. Stale temp files of this app's own naming are swept at the start of each
//!    replace ([`sweep_stale`]).
//!
//! Saves are serialised by [`ConfigSaver`]'s lock, so the Settings screen and the Quit offer cannot
//! interleave two read-modify-writes. Once Uninstall's settings leg has removed the settings (Batch
//! 2, spec 3.5.3), the saver's latch makes all three writes refuse, first thing under that lock,
//! with [`SETTINGS_REMOVED_BY_UNINSTALL`] — so nothing re-creates them in this app session.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::briefing_files::{
    absolute, engine_paths, failure_detail, read_single_link_text_capped, ReadRefusal,
};
use crate::engine::{config_file_path, Engine, EngineClient, NoProgress, Operation, Outcome};
use crate::shell::ENGINE_READ_TIMEOUT;

/// The largest config the app will read or write. The engine's own default is well under 1 KB.
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// What the webview sees in place of a literal `provider.api.apiKey`. Sending it back unchanged
/// keeps the stored key; removing the key removes it; anything else is refused.
pub const REDACTED_API_KEY: &str =
    "(a literal API key is stored in config.json; Daily Briefing never displays it)";

/// Where candidate files go, under the app's data directory.
pub const CANDIDATE_SUBDIR: &str = "config-candidates";

/// The name prefix of every candidate file (`candidate-<pid>-<seq>.json`).
pub const CANDIDATE_PREFIX: &str = "candidate-";

/// Why every settings write refuses once Uninstall has removed the settings (Batch 2, spec 3.5.3
/// step 6) — [`SaveError::Unsupported`]'s `detail`, which the webview shows verbatim
/// (`lib/files.ts`, `describeFailure`), so no wire type changes (plan SQ2).
pub const SETTINGS_REMOVED_BY_UNINSTALL: &str = "Settings were removed by Uninstall.";

/// Managed state: the save lock, the "settings removed" latch, and (for tests only) where
/// candidate files go.
#[derive(Default)]
pub struct ConfigSaver {
    candidate_dir: Option<PathBuf>,
    /// The save lock: every settings write holds it (`config_save`, `config_offer_notify_auto`,
    /// `config_create`). `pub(crate)` for `uninstall::uninstall_execute` (Batch 2, spec 3.3.4.2),
    /// which holds it from before its scheduler step to its end when it will remove the settings,
    /// so a save cannot re-create a file behind that leg.
    pub(crate) lock: tokio::sync::Mutex<()>,
    /// The "settings removed" latch (Batch 2, spec 3.5.3 step 6). Set ONLY by `uninstall_execute`'s
    /// settings leg, while it holds [`Self::lock`], once that leg's `config.json` step has completed
    /// (removed, or found absent) — so it is visible to every write that takes the lock after it,
    /// whether it was queued behind the leg or comes later in this app session. Never cleared: the
    /// three settings writes then refuse ([`Self::refuse_if_settings_removed`]) and nothing
    /// re-creates the settings. `uninstall_execute` itself never reads it, so a second Uninstall can
    /// finish what a first one left.
    settings_removed: AtomicBool,
}

impl ConfigSaver {
    /// Candidate files under `dir` instead of `<app_data_dir>/config-candidates`. **Test harness
    /// only** — a MockRuntime app's `app_data_dir` is the developer's real one.
    pub fn with_candidate_dir(dir: impl Into<PathBuf>) -> Self {
        Self {
            candidate_dir: Some(dir.into()),
            ..Self::default()
        }
    }

    /// Whether Uninstall has removed the settings in this app session (the latch above).
    pub fn settings_removed(&self) -> bool {
        self.settings_removed.load(Ordering::SeqCst)
    }

    /// Set the latch. Called only by `uninstall::uninstall_execute`, with [`Self::lock`] held.
    pub(crate) fn mark_settings_removed(&self) {
        self.settings_removed.store(true, Ordering::SeqCst);
    }

    /// Each settings write's first step once it holds [`Self::lock`]: refuse, with
    /// [`SETTINGS_REMOVED_BY_UNINSTALL`], once the latch is set — before it reads anything.
    fn refuse_if_settings_removed(&self) -> Result<(), SaveError> {
        if self.settings_removed() {
            return Err(SaveError::Unsupported {
                detail: SETTINGS_REMOVED_BY_UNINSTALL.into(),
            });
        }
        Ok(())
    }
}

/* ── wire types ───────────────────────────────────────────────────────────────────────────────── */

/// One `config validate --json` note, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldNote {
    #[serde(default)]
    pub field: String,
    pub message: String,
}

/// The config as the Settings screen loads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDocument {
    /// `status --json`'s `paths.configPath`, for display.
    pub path: String,
    pub exists: bool,
    /// The config re-serialised the way the save writes it, with a literal API key redacted.
    /// `None` when there is no file or it is not JSON.
    pub text: Option<String>,
    /// The token [`config_save`] requires: a digest of the bytes on disk right now.
    pub base: Option<String>,
    /// Why the file on disk could not be parsed: the JSON parser's message ([`json_error_detail`]).
    pub parse_error: Option<String>,
    /// True when `text` carries [`REDACTED_API_KEY`] in place of a stored key.
    pub api_key_redacted: bool,
}

/// What a save did. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveOutcome {
    /// Written. `warnings` are the engine's, verbatim; they did not block.
    #[serde(rename_all = "camelCase")]
    Saved {
        path: String,
        backup_path: String,
        warnings: Vec<FieldNote>,
    },
    /// B8 (T16): [`config_create`] wrote the FIRST config. There is no backup — there was no
    /// previous file — so this is its own variant rather than a `Saved` with an empty
    /// `backupPath` a caller could mistake for a path.
    Created {
        path: String,
        warnings: Vec<FieldNote>,
    },
    /// The candidate serialises to exactly what is on disk. Nothing was validated or written.
    Unchanged { path: String },
    /// The engine said no. Nothing was written, and `.bak` was not touched.
    Invalid {
        errors: Vec<FieldNote>,
        warnings: Vec<FieldNote>,
    },
}

/// Why a save (or a read) did not happen. Tagged by `kind`.
///
/// In every case the config file and its `.bak` are exactly as they were. (A save may still have
/// removed this app's OWN stale temp files — [`sweep_stale`] — which is housekeeping, not a write
/// to anything the user or the engine reads.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SaveError {
    /// The engine could not be asked (`status` / `config validate`), or answered unusably.
    Engine { detail: String },
    /// There is no config file. Settings edits one; the wizard's [`config_create`] creates one.
    NoConfig { path: String },
    /// B8 (T16): [`config_create`] found a file (or a symlink, or anything else) already at the
    /// config path. `initConfig`'s leave-existing-alone semantics: a create NEVER replaces what is
    /// there, whatever it is — the wizard re-reads and switches to the edit path instead.
    AlreadyExists { path: String },
    /// A symlink, a non-regular file, over the size cap, not UTF-8, or an I/O error.
    ConfigUnreadable { path: String, detail: String },
    /// The file on disk is not a JSON object.
    OnDiskNotJson { path: String, detail: String },
    /// The candidate is not a JSON object.
    NotJson { detail: String },
    /// The candidate is larger than [`MAX_CONFIG_BYTES`] (refused before it is parsed), or would be
    /// once re-serialised.
    TooLarge { bytes: u64, limit: u64 },
    /// The file changed since it was loaded (the `base` token no longer matches).
    Conflict { path: String },
    /// The candidate changes `transcripts`. A human gate, not an app setting (plan R1, T15).
    TranscriptsChanged,
    /// The candidate sets or changes a literal `provider.api.apiKey`.
    ApiKeyChanged,
    /// The app's candidate directory is unavailable or unusable.
    CandidateDir { detail: String },
    /// Writing failed. The previous config and its `.bak` are intact.
    Write { path: String, detail: String },
    /// `<config>.bak` exists and is not a regular file (`detail`: a directory, a symbolic link, …).
    /// Nothing is replaced; `path` is the backup's, so the user can move it out of the way.
    BackupNotAFile { path: String, detail: String },
    /// This save is not offered here (the Quit offer on Windows, or over a custom notify command).
    Unsupported { detail: String },
}

/* ── pure pieces ──────────────────────────────────────────────────────────────────────────────── */

/// `JSON.stringify(value, null, 2)`, as far as a `serde_json::Value` can express it: two-space
/// indent, `": "`, insertion order (`preserve_order`), no trailing newline.
///
/// ⚠ ONE KNOWN DIFFERENCE: a number written with a fraction or exponent that is integral
/// (`1.0`, `1e3`) parses as `f64` and is written back as `1.0` / `1000.0`, where JavaScript writes
/// `1` / `1000`. No field the engine writes has that shape; `tests/config_save.rs` pins the rest
/// against a checked-in `JSON.stringify` golden.
pub fn canonical_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// A content token for the "changed since loaded" check. FNV-1a over the bytes, plus the length.
/// Not a security boundary — it detects edits, it does not authenticate them.
pub fn digest(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{h:016x}:{}", bytes.len())
}

/// Replace a literal `provider.api.apiKey` with [`REDACTED_API_KEY`]. Returns whether it did.
pub fn redact(mut value: Value) -> (Value, bool) {
    let redacted = match value.pointer_mut("/provider/api/apiKey") {
        Some(slot) if slot.is_string() => {
            *slot = Value::String(REDACTED_API_KEY.to_string());
            true
        }
        _ => false,
    };
    (value, redacted)
}

/// Put the stored key back where the candidate carries the placeholder; refuse any other change.
pub fn restore_api_key(candidate: &mut Value, on_disk: &Value) -> Result<(), SaveError> {
    let stored = on_disk.pointer("/provider/api/apiKey").cloned();
    let Some(slot) = candidate.pointer_mut("/provider/api/apiKey") else {
        // Absent: never set, or removed from the app. Both are allowed.
        return Ok(());
    };
    if slot.as_str() == Some(REDACTED_API_KEY) {
        return match stored {
            Some(Value::String(key)) => {
                *slot = Value::String(key);
                Ok(())
            }
            // The placeholder with no key behind it: a pasted document, not an edit of this one.
            _ => Err(SaveError::ApiKeyChanged),
        };
    }
    if Some(&*slot) == stored.as_ref() {
        return Ok(());
    }
    Err(SaveError::ApiKeyChanged)
}

/// `transcripts` as on disk, including absent-stays-absent, by [`json_eq`]: key order and the
/// spelling of an equal number are not changes.
pub fn transcripts_unchanged(candidate: &Value, on_disk: &Value) -> bool {
    match (candidate.get("transcripts"), on_disk.get("transcripts")) {
        (None, None) => true,
        (Some(a), Some(b)) => json_eq(a, b),
        _ => false,
    }
}

/// JSON value equality as JavaScript's `JSON.parse` sees it: objects compare regardless of key
/// order, and numbers compare by VALUE — `50`, `50.0` and `5e1` are one number (the Settings form
/// round-trips the config through JavaScript, which writes all three as `50`).
///
/// ⚠ WHAT IT GUARANTEES: two numbers it calls equal are equal doubles, so JavaScript cannot tell
/// them apart either. The converse holds only in part, and it depends on how serde_json READ the
/// number:
/// - an integer that fits in 64 bits is kept exactly, and equals a float only when the float is
///   exactly that integer — `9007199254740993` (2^53 + 1) is NOT equal to `9007199254740992.0`,
///   although JavaScript reads both as the same double (stricter than JavaScript);
/// - an integer beyond the 64-bit range is read as a double to begin with, so two such integers
///   that round to the same double compare EQUAL — `123456789012345678901234` and
///   `123456789012345678901235` are one number here, as they are to JavaScript (both sides see the
///   same double; the digits that differ were never read).
pub fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => number_eq(x, y),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        _ => a == b,
    }
}

/// A JSON parse error in words.
///
/// ⚠ ONE REFUSAL IS NOT A SYNTAX ERROR. serde_json refuses a number beyond the largest `f64`
/// (`1e400`, `-1e400`) with "number out of range", although JSON's grammar allows it and the
/// engine's `JSON.parse` reads it as ±Infinity. The text is valid JSON; this app cannot hold the
/// number, so it says that instead of letting the message read as "not JSON".
pub fn json_error_detail(e: &serde_json::Error) -> String {
    let text = e.to_string();
    if text.starts_with("number out of range") {
        format!(
            "{text}: the JSON is well-formed, but a number is beyond the largest 64-bit float \
             (about ±1.8e308), which this app cannot hold (JavaScript would read it as ±Infinity)"
        )
    } else {
        text
    }
}

fn number_eq(x: &serde_json::Number, y: &serde_json::Number) -> bool {
    if x == y {
        return true;
    }
    match (x.as_f64(), y.as_f64()) {
        (Some(p), Some(q)) => p == q && f64_is_exact(x) && f64_is_exact(y),
        _ => false,
    }
}

/// True when `n.as_f64()` is exactly `n` (always, for a float; for an integer, when it survives the
/// conversion unchanged — compared in 128 bits so a saturating cast cannot fake it).
fn f64_is_exact(n: &serde_json::Number) -> bool {
    if n.is_f64() {
        return true;
    }
    let as_int = n
        .as_i64()
        .map(i128::from)
        .or_else(|| n.as_u64().map(i128::from));
    match (as_int, n.as_f64()) {
        (Some(i), Some(f)) => f.is_finite() && f.fract() == 0.0 && (f as i128) == i,
        _ => false,
    }
}

/* ── the atomic replace ───────────────────────────────────────────────────────────────────────── */

static SEQ: AtomicU64 = AtomicU64::new(0);

fn unique() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Create `path` (it must not exist), write `bytes`, set `mode`, `fsync`.
///
/// ⚠ IT CLEANS UP ONLY WHAT IT CREATED. A name that already exists fails the `create_new` open and
/// is left exactly as it was — the caller must not `remove_file` it on error either, because a
/// clash means the file is somebody else's. A failure AFTER the create removes the partial file.
///
/// `pub(crate)` for ONE other caller, `autostart::replace_atomically` (Phase E M5b checkpoint fix):
/// its temp file had been a `File::create`, which writes THROUGH a symlink planted at the
/// predictable temp name and truncates a hard link's target. `create_new` (`O_CREAT|O_EXCL`) fails
/// on any existing name — a symlink included, dangling or not — so the same guarantee is reused
/// rather than re-written.
pub(crate) fn write_new_file(path: &Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    let written = (|| {
        file.write_all(bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        file.sync_all()
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Is `pid` a live process? `false` only when the OS says there is no such process; anything else
/// (alive, not ours, an unknown error) counts as alive, so a sweep never races a live writer.
#[cfg(unix)]
fn pid_is_dead(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 performs the permission and existence checks only; nothing is delivered.
    let rc = unsafe { libc::kill(pid, 0) };
    rc != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn pid_is_dead(_pid: u32) -> bool {
    false
}

/// The pid in a temp name this module made: `<prefix><pid>-<seq><suffix>`, `suffix` one of
/// `suffixes`. `None` for any other name — a file this module did not name is never swept.
fn temp_owner(name: &str, prefix: &str, suffixes: &[&str]) -> Option<u32> {
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    let rest = name.strip_prefix(prefix)?;
    let (pid, rest) = rest.split_once('-')?;
    // Every suffix is tried, not the first that strips: `""` strips from anything.
    let is_ours = suffixes
        .iter()
        .filter_map(|s| rest.strip_suffix(s))
        .any(digits);
    if !digits(pid) || !is_ours {
        return None;
    }
    pid.parse().ok()
}

/// Remove STALE temp files of this module's own naming from `dir`: regular files (never a symlink
/// or a directory) whose name is `<prefix><pid>-<seq><suffix>` and whose writer is gone — this
/// process (every caller holds [`ConfigSaver`]'s lock, so nothing of ours is in flight) or a pid the
/// OS reports as not running. Best effort; returns what it removed. **Nothing else in `dir` is
/// touched**, and a name that merely resembles ours is left alone.
pub fn sweep_stale(dir: &Path, prefix: &str, suffixes: &[&str]) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return removed;
    };
    let me = std::process::id();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(owner) = name.to_str().and_then(|n| temp_owner(n, prefix, suffixes)) else {
            continue;
        };
        if owner != me && !pid_is_dead(owner) {
            continue;
        }
        let path = entry.path();
        let regular = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file());
        if regular && std::fs::remove_file(&path).is_ok() {
            removed.push(path);
        }
    }
    removed
}

/// The suffixes [`replace_config_file`] gives its staged files: the new bytes, the staged backup,
/// and the previous backup kept aside for a restore.
pub const STAGED_SUFFIXES: &[&str] = &["", ".bak", ".prev"];

/// `.<config name>.save-` — the prefix of every file [`replace_config_file`] stages.
pub fn staged_prefix(config_name: &str) -> String {
    format!(".{config_name}.save-")
}

/// The permission bits of `path` (0o600 off unix, where they are not used).
fn file_mode(path: &Path) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .map(|m| m.permissions().mode() & 0o7777)
            .unwrap_or(0o600)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        0o600
    }
}

/// How step 4 of [`replace_config_file`] kept the previous `.bak` reachable.
#[derive(Clone, Copy)]
enum Kept {
    /// There was no `.bak`.
    Nothing,
    /// `.bak` is still in place; the staged `.prev` name is a second link to it.
    Linked,
    /// `.bak` was renamed to the staged `.prev` name (no hard links on this filesystem).
    Moved,
}

/// Keep the current `.bak` reachable under `previous` before it is replaced.
///
/// - No `.bak` → [`Kept::Nothing`]. A `.bak` that is not a regular file (a directory, a symbolic
///   link, a FIFO…) → [`SaveError::BackupNotAFile`], and nothing is touched: a rename would move a
///   directory under a temp name no sweep removes, and would detach a symlinked backup.
/// - Otherwise `link(backup, previous)` → [`Kept::Linked`]. `NotFound` (the file went away) is
///   [`Kept::Nothing`]; `AlreadyExists` (someone else's file under our temp name) is an error that
///   leaves that file alone.
/// - ⚠ ANY OTHER LINK ERROR FALLS BACK TO A RENAME. FAT32 and exFAT have no hard links
///   (`EOPNOTSUPP`, measured in review round 2: every save after the first failed there), and some
///   network filesystems answer `EPERM`. The `previous` name is first CREATED as an empty file of
///   our own (`create_new`), so the rename replaces only that — never a file this module did not
///   make — and then `rename(backup, previous)` → [`Kept::Moved`]. Between that rename and the
///   staged backup's rename there is no `.bak` name: a crash in that window leaves the config
///   untouched and the previous backup under the staged `.prev` name, which the next save's sweep
///   removes (`docs/gui-seam.md` §10g, deviation 68).
///
/// Returns the link error's words with the fallback's error when both fail.
fn keep_previous_backup(
    backup: &Path,
    previous: &Path,
    link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    write_err: impl Fn(String) -> SaveError,
) -> Result<Kept, SaveError> {
    use std::io::ErrorKind;
    match std::fs::symlink_metadata(backup) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Kept::Nothing),
        Err(e) => return Err(write_err(format!("reading {}: {e}", backup.display()))),
        Ok(meta) if !meta.file_type().is_file() => {
            let file_type = meta.file_type();
            let what = if file_type.is_dir() {
                "a directory"
            } else if file_type.is_symlink() {
                "a symbolic link"
            } else {
                "a special file"
            };
            return Err(SaveError::BackupNotAFile {
                path: backup.display().to_string(),
                detail: what.into(),
            });
        }
        Ok(_) => {}
    }
    let aside = |detail: String| write_err(format!("keeping {} aside: {detail}", backup.display()));
    let link_error = match link(backup, previous) {
        Ok(()) => return Ok(Kept::Linked),
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Kept::Nothing),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Err(aside(e.to_string())),
        Err(e) => e,
    };
    // No hard links here. Reserve the name, then move `.bak` onto our own placeholder.
    write_new_file(previous, b"", 0o600).map_err(|e| {
        aside(format!(
            "{link_error}; without a hard link, reserving the temp name failed: {e}"
        ))
    })?;
    match std::fs::rename(backup, previous) {
        Ok(()) => Ok(Kept::Moved),
        Err(e) => {
            let _ = std::fs::remove_file(previous);
            if e.kind() == ErrorKind::NotFound {
                Ok(Kept::Nothing)
            } else {
                Err(aside(format!(
                    "{link_error}; without a hard link, moving it failed: {e}"
                )))
            }
        }
    }
}

/// Replace `path` with `new_bytes`, keeping the previous bytes as `<path>.bak`.
///
/// In order:
/// 1. sweep this module's stale staged files from the directory ([`sweep_stale`]);
/// 2. stage the new bytes (mode `new_mode`) and the backup bytes — `expected_current`, mode
///    `current & new_mode`, so `.bak` is never wider than the new file — as this module's own
///    temp files beside the target, each `fsync`ed;
/// 3. RE-READ the file: anything but `expected_current` (the bytes the caller validated against)
///    is a [`SaveError::Conflict`], and nothing but the staged files has been written;
/// 4. keep the current `.bak` reachable under a staged name — a hard link, or a rename where the
///    filesystem has no hard links ([`keep_previous_backup`]; a `.bak` that is not a regular file
///    is refused) — rename the staged backup to `.bak`, run `before_rename`, rename the new bytes
///    over the config, and `fsync` the directory. If renaming the staged backup, `before_rename` or
///    the final rename fails, the previous `.bak` is put back (or the new one removed, if there was
///    none): **a failed replace changes neither file**.
///
/// The residual window is between step 3's read returning and the final `rename(2)`: two
/// link/rename calls on the BACKUP name (without hard links: creating and syncing an empty
/// placeholder, then two renames) and nothing else — no engine call, no `fsync` of anything the config depends on (both staged files are
/// already durable). An editor's save that lands inside it is replaced, and is not in `.bak`
/// either (`.bak` holds the bytes step 3 read). `docs/gui-seam.md` §10g, deviation 47.
///
/// `before_rename` is a test seam — production passes `|_| Ok(())`; `tests/config_save.rs` passes
/// one that fails (a failed final rename) and one that panics (a crash between the two renames:
/// the config is untouched and `.bak` holds its bytes). [`replace_config_file_with_link`] adds the
/// second seam, for the hard link.
///
/// Returns the backup's path.
pub fn replace_config_file(
    path: &Path,
    new_bytes: &[u8],
    expected_current: &str,
    new_mode: u32,
    before_rename: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<PathBuf, SaveError> {
    replace_config_file_with_link(
        path,
        new_bytes,
        expected_current,
        new_mode,
        |from, to| std::fs::hard_link(from, to),
        before_rename,
    )
}

/// [`replace_config_file`], with the one `link(2)` call injectable — production passes
/// `std::fs::hard_link`; `tests/config_save.rs` passes one that fails the way FAT32 does.
pub fn replace_config_file_with_link(
    path: &Path,
    new_bytes: &[u8],
    expected_current: &str,
    new_mode: u32,
    link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
    before_rename: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<PathBuf, SaveError> {
    let shown = path.display().to_string();
    let write_err = |detail: String| SaveError::Write {
        path: shown.clone(),
        detail,
    };
    let (dir, name) = match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => (dir, name.to_string_lossy().into_owned()),
        _ => return Err(write_err("the config path has no parent directory".into())),
    };
    let prefix = staged_prefix(&name);
    sweep_stale(dir, &prefix, STAGED_SUFFIXES);

    // 2. Stage both files. Nothing the engine or the user reads has changed yet.
    let stem = dir.join(format!("{prefix}{}", unique()));
    let staged = |suffix: &str| {
        let mut p = stem.clone().into_os_string();
        p.push(suffix);
        PathBuf::from(p)
    };
    let (tmp, backup_tmp, previous) = (staged(""), staged(".bak"), staged(".prev"));
    let backup = dir.join(format!("{name}.bak"));
    let discard = |paths: &[&Path]| {
        for p in paths {
            let _ = std::fs::remove_file(p);
        }
    };
    write_new_file(&tmp, new_bytes, new_mode).map_err(|e| write_err(e.to_string()))?;
    if let Err(e) = write_new_file(
        &backup_tmp,
        expected_current.as_bytes(),
        file_mode(path) & new_mode,
    ) {
        discard(&[&tmp]);
        return Err(write_err(format!("staging {}: {e}", backup.display())));
    }

    // 3. The re-read, as late as it can be: after both files are durable.
    let current = match read_existing(path) {
        Ok(current) => current,
        Err(e) => {
            discard(&[&tmp, &backup_tmp]);
            return Err(e);
        }
    };
    if current != expected_current {
        discard(&[&tmp, &backup_tmp]);
        return Err(SaveError::Conflict {
            path: shown.clone(),
        });
    }

    // 4. The swap. The previous `.bak` stays reachable until the config rename has happened.
    let kept = match keep_previous_backup(&backup, &previous, link, write_err) {
        Ok(kept) => kept,
        Err(e) => {
            discard(&[&tmp, &backup_tmp]);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&backup_tmp, &backup) {
        // `.bak` was not replaced: a second link is just a spare name; a moved `.bak` goes back.
        match kept {
            Kept::Moved => {
                let _ = std::fs::rename(&previous, &backup);
            }
            Kept::Linked => discard(&[&previous]),
            Kept::Nothing => {}
        }
        discard(&[&tmp, &backup_tmp]);
        return Err(write_err(format!("writing {}: {e}", backup.display())));
    }
    let restore_backup = || match kept {
        Kept::Linked | Kept::Moved => {
            let _ = std::fs::rename(&previous, &backup);
        }
        Kept::Nothing => {
            let _ = std::fs::remove_file(&backup);
        }
    };
    if let Err(e) = before_rename(&tmp).and_then(|()| std::fs::rename(&tmp, path)) {
        restore_backup();
        discard(&[&tmp]);
        return Err(write_err(e.to_string()));
    }
    discard(&[&previous]);
    // Make the rename itself durable. Best effort: the rename has happened either way, and
    // failing the save now would report an error for a config that was, in fact, replaced.
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(backup)
}

/// B8 (T16): create `path` with `bytes` — EXCLUSIVELY. Nothing that already holds the name (a
/// file, a symlink, a directory) is ever replaced; the answer is then [`SaveError::AlreadyExists`].
///
/// The primary route is `link(2)` from a staged, `fsync`ed temp file onto the config name — atomic
/// AND exclusive in one call (`EEXIST` when the name appeared meanwhile), so a reader can never see
/// a partial config and a racing `daily-briefing init` can never be clobbered. On a filesystem
/// without hard links the fallback is a `create_new` open of the config name itself: still
/// exclusive, no longer atomic — a crash mid-write there leaves a partial config, the same accepted
/// residual shape as [`keep_previous_backup`]'s rename fallback (`docs/gui-seam.md` §10g,
/// deviation 68). The parent directory is created if missing (a first run has no
/// `~/.config/daily-briefing/` yet — the engine's `initConfig` relies on `Bun.write` doing the
/// same).
pub fn create_config_file(path: &Path, bytes: &[u8], mode: u32) -> Result<(), SaveError> {
    create_config_file_with_link(path, bytes, mode, |from, to| std::fs::hard_link(from, to))
}

/// [`create_config_file`], with the one `link(2)` call injectable — production passes
/// `std::fs::hard_link`; `tests/config_save.rs` passes one that fails the way FAT32 does.
pub fn create_config_file_with_link(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    link: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), SaveError> {
    use std::io::ErrorKind;
    let shown = path.display().to_string();
    let write_err = |detail: String| SaveError::Write {
        path: shown.clone(),
        detail,
    };
    let already = || SaveError::AlreadyExists {
        path: shown.clone(),
    };
    let (dir, name) = match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) => (dir, name.to_string_lossy().into_owned()),
        _ => return Err(write_err("the config path has no parent directory".into())),
    };
    std::fs::create_dir_all(dir)
        .map_err(|e| write_err(format!("creating {}: {e}", dir.display())))?;
    let prefix = staged_prefix(&name);
    sweep_stale(dir, &prefix, STAGED_SUFFIXES);
    // A cheap early answer for the ordinary already-there case — the exclusive create below is the
    // guarantee; this only makes the refusal arrive before a temp file is staged. `symlink_metadata`
    // so a symlink AT the config name (a dotfiles-managed config) also reads as "exists".
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(already());
    }
    let tmp = dir.join(format!("{prefix}{}", unique()));
    write_new_file(&tmp, bytes, mode).map_err(|e| write_err(e.to_string()))?;
    let discard_tmp = || {
        let _ = std::fs::remove_file(&tmp);
    };
    let outcome = match link(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(already()),
        Err(link_error) => {
            // No hard links here. `create_new` keeps the exclusivity; atomicity is the fallback's
            // one cost (documented above).
            match write_new_file(path, bytes, mode) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == ErrorKind::AlreadyExists => Err(already()),
                Err(e) => Err(write_err(format!(
                    "{link_error}; without a hard link, creating it directly failed: {e}"
                ))),
            }
        }
    };
    discard_tmp();
    if outcome.is_ok() {
        // Make the create durable. Best effort, as in `replace_config_file`: the file exists
        // either way, and failing now would report an error for a config that was created.
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    outcome
}

/* ── the engine calls ─────────────────────────────────────────────────────────────────────────── */

/// `status --json` → `paths.configPath`.
async fn locate(client: &EngineClient) -> Result<PathBuf, SaveError> {
    let paths = engine_paths(client)
        .await
        .map_err(|detail| SaveError::Engine { detail })?;
    absolute(
        "status --json",
        "paths.configPath",
        paths.config_path.as_ref(),
    )
    .map_err(|detail| SaveError::Engine { detail })
}

/// The current config text, or why there is none to edit. Single-link, like a symlink refusal.
fn read_existing(path: &Path) -> Result<String, SaveError> {
    read_single_link_text_capped(path, MAX_CONFIG_BYTES).map_err(|r| match r {
        ReadRefusal::NotFound => SaveError::NoConfig {
            path: path.display().to_string(),
        },
        other => SaveError::ConfigUnreadable {
            path: path.display().to_string(),
            detail: other.describe(path, MAX_CONFIG_BYTES),
        },
    })
}

fn parse_on_disk(path: &Path, text: &str) -> Result<Value, SaveError> {
    let value: Value = serde_json::from_str(text).map_err(|e| SaveError::OnDiskNotJson {
        path: path.display().to_string(),
        detail: json_error_detail(&e),
    })?;
    if !value.is_object() {
        return Err(SaveError::OnDiskNotJson {
            path: path.display().to_string(),
            detail: "the top level is not an object".into(),
        });
    }
    Ok(value)
}

#[derive(Deserialize)]
struct ValidateReport {
    valid: bool,
    #[serde(default)]
    errors: Vec<FieldNote>,
    #[serde(default)]
    warnings: Vec<FieldNote>,
}

/// Removes the candidate file however validation ends.
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// `config validate --json --file <candidate>`, over a candidate file this function writes and
/// removes.
async fn validate(
    client: &EngineClient,
    dir: &Path,
    text: &str,
) -> Result<ValidateReport, SaveError> {
    let dir_err = |detail: String| SaveError::CandidateDir { detail };
    std::fs::create_dir_all(dir).map_err(|e| dir_err(format!("{}: {e}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    sweep_stale(dir, CANDIDATE_PREFIX, &[".json"]);
    let file = dir.join(format!("{CANDIDATE_PREFIX}{}.json", unique()));
    write_new_file(&file, text.as_bytes(), 0o600)
        .map_err(|e| dir_err(format!("{}: {e}", file.display())))?;
    let _cleanup = RemoveOnDrop(file.clone());
    let spelled = file
        .to_str()
        .ok_or_else(|| dir_err(format!("{} is not valid UTF-8", file.display())))?;
    // B3's operand validator, unchanged: the path is refused before any spawn if it is not one.
    let operand =
        config_file_path(spelled).map_err(|r| dir_err(format!("{spelled} {}", r.message())))?;

    let outcome = match tokio::time::timeout(
        ENGINE_READ_TIMEOUT,
        client.invoke(Operation::ConfigValidate { file: operand }, &NoProgress),
    )
    .await
    {
        Err(_) => {
            return Err(SaveError::Engine {
                detail: "`config validate` did not answer in time and was stopped".into(),
            })
        }
        Ok(Err(e)) => {
            return Err(SaveError::Engine {
                detail: e.to_string(),
            })
        }
        Ok(Ok(outcome)) => outcome,
    };
    let payload = match (&outcome.outcome, &outcome.payload) {
        (Outcome::Delivered, Some(payload)) => payload.clone(),
        _ => {
            return Err(SaveError::Engine {
                detail: failure_detail("config validate", &outcome),
            })
        }
    };
    serde_json::from_value(payload).map_err(|e| SaveError::Engine {
        detail: format!("`config validate` answered without a readable verdict: {e}"),
    })
}

/// Steps 4–7 of the module header, over a candidate VALUE.
async fn save_value(
    client: &EngineClient,
    candidate_dir: &Path,
    path: &Path,
    current: &str,
    mut candidate: Value,
) -> Result<SaveOutcome, SaveError> {
    let on_disk = parse_on_disk(path, current)?;
    if !candidate.is_object() {
        return Err(SaveError::NotJson {
            detail: "the top level is not an object".into(),
        });
    }
    restore_api_key(&mut candidate, &on_disk)?;
    if !transcripts_unchanged(&candidate, &on_disk) {
        return Err(SaveError::TranscriptsChanged);
    }
    let text = canonical_json(&candidate);
    if text == canonical_json(&on_disk) {
        return Ok(SaveOutcome::Unchanged {
            path: path.display().to_string(),
        });
    }
    // Pretty-printing grows a minified document; the next read would refuse a file over the cap.
    too_large(text.len())?;
    let report = validate(client, candidate_dir, &text).await?;
    if !report.valid {
        return Ok(SaveOutcome::Invalid {
            errors: report.errors,
            warnings: report.warnings,
        });
    }
    // Owner-only when EITHER side holds an API block: the new file may carry a key, and the
    // `.bak` (never wider than the new file) may carry the old one.
    let sensitive =
        candidate.pointer("/provider/api").is_some() || on_disk.pointer("/provider/api").is_some();
    let mode = if sensitive {
        file_mode(path) & !0o077
    } else {
        file_mode(path)
    };
    let backup = replace_config_file(path, text.as_bytes(), current, mode, |_| Ok(()))?;
    Ok(SaveOutcome::Saved {
        path: path.display().to_string(),
        backup_path: backup.display().to_string(),
        warnings: report.warnings,
    })
}

fn too_large(bytes: usize) -> Result<(), SaveError> {
    let bytes = bytes as u64;
    if bytes > MAX_CONFIG_BYTES {
        return Err(SaveError::TooLarge {
            bytes,
            limit: MAX_CONFIG_BYTES,
        });
    }
    Ok(())
}

fn candidate_dir<R: Runtime>(
    app: &AppHandle<R>,
    saver: &ConfigSaver,
) -> Result<PathBuf, SaveError> {
    if let Some(dir) = &saver.candidate_dir {
        return Ok(dir.clone());
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join(CANDIDATE_SUBDIR))
        .map_err(|e| SaveError::CandidateDir {
            detail: format!("the app's data directory is unavailable: {e}"),
        })
}

fn client_of(engine: &Engine) -> Result<&EngineClient, SaveError> {
    engine.client().map_err(|e| SaveError::Engine {
        detail: e.to_string(),
    })
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// The config as Settings shows it. Reads only.
#[tauri::command]
pub async fn config_read(engine: State<'_, Engine>) -> Result<ConfigDocument, SaveError> {
    let path = locate(client_of(&engine)?).await?;
    let shown = path.display().to_string();
    let text = match read_existing(&path) {
        Err(SaveError::NoConfig { .. }) => {
            return Ok(ConfigDocument {
                path: shown,
                exists: false,
                text: None,
                base: None,
                parse_error: None,
                api_key_redacted: false,
            })
        }
        Err(e) => return Err(e),
        Ok(text) => text,
    };
    let base = Some(digest(text.as_bytes()));
    Ok(match serde_json::from_str::<Value>(&text) {
        Ok(value) => {
            let (value, api_key_redacted) = redact(value);
            ConfigDocument {
                path: shown,
                exists: true,
                text: Some(canonical_json(&value)),
                base,
                parse_error: None,
                api_key_redacted,
            }
        }
        Err(e) => ConfigDocument {
            path: shown,
            exists: true,
            text: None,
            base,
            parse_error: Some(json_error_detail(&e)),
            api_key_redacted: false,
        },
    })
}

/// Save a candidate config — the form and the raw-JSON tab both call this.
///
/// ⚠ THE SIGNATURE IS THE PATH GUARANTEE: JSON text and the `base` token from [`config_read`].
/// There is no path parameter, and extra keys in the IPC body are not read.
#[tauri::command]
pub async fn config_save<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
    text: String,
    base: String,
) -> Result<SaveOutcome, SaveError> {
    too_large(text.len())?;
    let candidate: Value = serde_json::from_str(&text).map_err(|e| SaveError::NotJson {
        detail: json_error_detail(&e),
    })?;
    let client = client_of(&engine)?;
    let dir = candidate_dir(&app, &saver)?;
    let _serialised = saver.lock.lock().await;
    saver.refuse_if_settings_removed()?;
    let path = locate(client).await?;
    let current = read_existing(&path)?;
    if digest(current.as_bytes()) != base {
        return Err(SaveError::Conflict {
            path: path.display().to_string(),
        });
    }
    save_value(client, &dir, &path, &current, candidate).await
}

/// The Quit dialog's offer: set the ENGINE's `notify` to `"auto"`, through the same pipeline.
///
/// A one-field change made here, on the file as it is now (under the save lock), rather than by the
/// webview — so it needs no `config_read` round trip and cannot carry anything else with it.
/// Refused on Windows, where the engine's `"auto"` resolves to no notifier at all
/// (`src/notify.ts`, `notifyArgv`), and over a real custom command ([`is_custom_notify`]), which
/// the offer would otherwise silently discard. Every other value — absent, `null`, `"off"`, or one
/// the engine does not accept (which it treats as off, `resolveNotify`) — is replaced by `"auto"`;
/// `"auto"` itself is a no-op.
///
/// ⚠ LIKE ANY SAVE, IT RE-SERIALISES THE WHOLE FILE: a config indented some other way than
/// `JSON.stringify(x, null, 2)` comes back two-space indented (`docs/gui-seam.md` §10e).
#[tauri::command]
pub async fn config_offer_notify_auto<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
) -> Result<SaveOutcome, SaveError> {
    if cfg!(windows) {
        return Err(SaveError::Unsupported {
            detail: "on Windows the engine's \"auto\" notification setting posts nothing".into(),
        });
    }
    let client = client_of(&engine)?;
    let dir = candidate_dir(&app, &saver)?;
    let _serialised = saver.lock.lock().await;
    saver.refuse_if_settings_removed()?;
    let path = locate(client).await?;
    let current = read_existing(&path)?;
    let mut candidate = parse_on_disk(&path, &current)?;
    if candidate.get("notify").is_some_and(is_custom_notify) {
        return Err(SaveError::Unsupported {
            detail: "the engine's notification setting is a custom command; change it on the \
                     Settings screen rather than replacing it from here"
                .into(),
        });
    }
    if let Some(object) = candidate.as_object_mut() {
        // `preserve_order`: an existing key keeps its position; a new one is appended.
        object.insert("notify".into(), Value::String("auto".into()));
    }
    save_value(client, &dir, &path, &current, candidate).await
}

/// B8 (T16): the FIRST-config path — the wizard's one write, closing §10e's open design point
/// (`docs/gui-seam.md`, deviation 42; the design record is §13).
///
/// The same pipeline as [`config_save`] with the edit-only steps replaced by create-only ones:
///
/// - **No `base` token and no on-disk read** — there is no file to have changed. The
///   do-not-clobber guarantee is [`create_config_file`]'s EXCLUSIVE create instead: anything
///   already at the name (including a config a terminal `daily-briefing init` wrote while the
///   wizard was open, or a dotfiles symlink) is [`SaveError::AlreadyExists`] and is not touched.
/// - **A literal API key is refused outright** ([`SaveError::ApiKeyChanged`]) — since round 1,
///   as a RECURSIVE scan ([`holds_literal_api_key`]): any object key spelled `apiKey` in any
///   letter case, anywhere in the document (`provider.api.apikey`, a top-level `apiKey`,
///   `provider.accounts[].apiKey` — all three measured past the old single-pointer check, and
///   the engine's validator is NOT a second line of defence). `apiKeyFile` / `apiKeyCommand`
///   stay legal — those are the references the wizard's native-key path carries. The edit path
///   lets a placeholder restore a key the file already holds; a create has no such key, so ANY
///   value here would be the webview setting one — the thing deviation 45 exists to prevent.
///   The refusal is also what makes the 0644 mode below safe: no literal key can reach a
///   world-readable created file, at any spelling.
/// - **Any `transcripts` block is refused** ([`SaveError::TranscriptsChanged`]). Enabling
///   transcripts is a human gate, not an app setting (plan R1, T15); on the edit path "unchanged
///   from disk" expresses that, and on a create the only unchanged value is absence.
/// - The engine still validates (`config validate --json --file` over a candidate file; errors
///   block, warnings are returned), and the write is exclusive-atomic where the filesystem has
///   hard links ([`create_config_file`]).
///
/// Mode: owner-only (0600) when the candidate carries `provider.api` — `initConfig`'s own rule for
/// an API config — and 0644 otherwise. ⚠ 0644 is ABSOLUTE, not umask-filtered: `initConfig`'s
/// `Bun.write` result passes through the process umask (agreeing with this under the default 022,
/// narrower under a stricter one), where [`write_new_file`] sets the bits explicitly. Safe either
/// way: the widened key refusal above guarantees no literal key can exist in a 0644 file.
#[tauri::command]
pub async fn config_create<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
    text: String,
) -> Result<SaveOutcome, SaveError> {
    too_large(text.len())?;
    let candidate: Value = serde_json::from_str(&text).map_err(|e| SaveError::NotJson {
        detail: json_error_detail(&e),
    })?;
    if !candidate.is_object() {
        return Err(SaveError::NotJson {
            detail: "the top level is not an object".into(),
        });
    }
    if holds_literal_api_key(&candidate) {
        return Err(SaveError::ApiKeyChanged);
    }
    if candidate.get("transcripts").is_some() {
        return Err(SaveError::TranscriptsChanged);
    }
    let client = client_of(&engine)?;
    let dir = candidate_dir(&app, &saver)?;
    let _serialised = saver.lock.lock().await;
    saver.refuse_if_settings_removed()?;
    let path = locate(client).await?;
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err(SaveError::AlreadyExists {
            path: path.display().to_string(),
        });
    }
    let text = canonical_json(&candidate);
    too_large(text.len())?;
    let report = validate(client, &dir, &text).await?;
    if !report.valid {
        return Ok(SaveOutcome::Invalid {
            errors: report.errors,
            warnings: report.warnings,
        });
    }
    let mode = if candidate.pointer("/provider/api").is_some() {
        0o600
    } else {
        0o644
    };
    create_config_file(&path, text.as_bytes(), mode)?;
    Ok(SaveOutcome::Created {
        path: path.display().to_string(),
        warnings: report.warnings,
    })
}

/// B8 round 1: does any object anywhere in `value` carry a key spelled `apiKey`, in any letter
/// case? EXACTLY that name — `apiKeyFile` and `apiKeyCommand` are the legal references — and
/// whatever the value's type: a key NAMED apiKey signals a literal key however it is written,
/// and refusing the name wholesale is what keeps [`config_create`]'s guarantee scan-shaped
/// instead of pointer-shaped (the three measured bypasses: `provider.api.apikey`, a top-level
/// `apiKey`, `provider.accounts[].apiKey`).
pub fn holds_literal_api_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case("apikey") || holds_literal_api_key(v)),
        Value::Array(items) => items.iter().any(holds_literal_api_key),
        _ => false,
    }
}

/// A `notify` value the ENGINE runs as a command: `{ command: [string, …] }`, non-empty, every
/// element a string — `src/notify.ts`, `resolveNotify`, which treats every other shape as off.
pub fn is_custom_notify(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_array)
        .is_some_and(|c| !c.is_empty() && c.iter().all(Value::is_string))
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &[
    "config_read",
    "config_save",
    "config_offer_notify_auto",
    "config_create",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dba-cfg-unit-{tag}-{}", unique()));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// A temp-name clash never deletes the file that was already there (review round 1).
    #[test]
    fn a_name_clash_leaves_the_existing_file_alone() {
        let dir = scratch("clash");
        let path = dir.join(".config.json.save-1-1");
        std::fs::write(&path, "somebody else's").unwrap();
        let err = write_new_file(&path, b"ours", 0o600).expect_err("the name exists");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "somebody else's");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_this_modules_names_are_owned() {
        let p = ".config.json.save-";
        let s = STAGED_SUFFIXES;
        assert_eq!(temp_owner(".config.json.save-42-7", p, s), Some(42));
        assert_eq!(temp_owner(".config.json.save-42-7.bak", p, s), Some(42));
        assert_eq!(temp_owner(".config.json.save-42-7.prev", p, s), Some(42));
        for other in [
            ".config.json.save-42-7.tmp",
            ".config.json.save-42",
            ".config.json.save--7",
            ".config.json.save-x-7",
            ".config.json.save-42-",
            ".config.json.save-42-7.bak.bak",
            ".other.json.save-42-7",
            "config.json",
        ] {
            assert_eq!(temp_owner(other, p, s), None, "{other}");
        }
        assert_eq!(
            temp_owner("candidate-9-3.json", CANDIDATE_PREFIX, &[".json"]),
            Some(9)
        );
        assert_eq!(
            temp_owner("candidate-9-3", CANDIDATE_PREFIX, &[".json"]),
            None
        );
    }
}
