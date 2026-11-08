//! P3-M4-T3 — the pending-reset store behind Replace (spec r9 §6 "Add, replace, remove" steps 1–4;
//! plan P3-M4-T3; hub Q11, Q20, Q21).
//!
//! Replacing an entry's key brackets the save with two `provider reset`s, so a mark the OLD key
//! earned never benches the new one: one BEFORE the save (resolved by label against the SAVED
//! config — the one reset allowed while the list has unsaved edits) and one AFTER it. Between them
//! a record in `<app_data_dir>/pending-resets.json` says a reset is still owed, so an app exit, or
//! a briefing holding the run lock, cannot leave the new key benched for longer than the next
//! retry.
//!
//! ## Why Rust owns it
//!
//! The post-save retry must run on app open whatever screen is shown, and Rust already holds the
//! engine client, the app data dir and the config reader; a TypeScript store would still need read,
//! write and clear commands plus a timer tied to a mounted component.
//!
//! ## The record
//!
//! `{label, phase, newKeyId}` (plus `doubtfulPasses` while non-zero, below), keyed by
//! `(label, newKeyId)` — two replacements of one row (one being discarded, the next waiting) are two
//! records:
//!
//!   * `pre-save` — written by [`provider_pending_reset_add`] before the pre-save reset; the editor
//!     still holds the candidate and retries `add` every 15 s while a run holds the lock, then
//!     saves. A successful pre-save reset does NOT clear it.
//!   * `post-save` — [`provider_pending_reset_flush`], after the save landed. Cleared ONLY by a
//!     post-save reset that succeeds; the retry task resets it every 15 s while the app runs and
//!     once at start. Lock-held and `Busy` are retried; any other refusal (a label no longer saved
//!     among them) drops it — nothing retries forever.
//!   * `discard` — an unsaved replacement being thrown away ([`provider_pending_reset_drop`]): its
//!     unused key is about to be deleted. The marker makes the delete survive a crash and a `Busy`
//!     (a Test holds the in-flight guard); the retry task finishes it.
//!
//! ## Whose `pre-save` record is it
//!
//! A `pre-save` record this process wrote is the EDITOR's ([`Inner::mine`]): the retry task leaves
//! it alone. One a previous run left behind has no editor any more, and the retry task — its first
//! pass is the start-up hook — resolves it against the saved config (plan Q11, three ways): the
//! entry under its label references `newKeyId` → the save landed before the app could flush (a
//! crash between `config_save` and `flush`), so it is promoted to `post-save` and reset; only
//! another label references it → the same save renamed the row (a hand edit) — drop the record,
//! KEEP the key; nothing references it → the save never happened — delete the key, drop the record.
//!
//! ## A check in doubt (P3-M4-T3 checkpoint)
//!
//! When the retry task cannot tell whether the saved config references a record's key, WHY decides:
//!
//!   * **transient** — `config validate` (or the `status` that locates the config) failed, timed out
//!     or could not be spawned; the config could not be read (`ConfigUnreadable` — an I/O error, but
//!     also a symlink or an oversized file, which only the bound below ends); the candidate could not
//!     be staged; or a row is `appOwnedKey` with no id where no entry names the id definitely (the
//!     shape the engine's 2 s ownership deadline answers — indistinguishable from a reference naming
//!     no id, so the bound ends that one). The record is KEPT and its `doubtfulPasses` counted, so a
//!     crash between save and flush still gets its post-save reset once the check answers;
//!   * **structural** — the settings were removed by Uninstall; this app's data directory cannot be
//!     resolved; there is no saved config (its label is no longer saved — spec §6 step 4 drops such a
//!     record); the config is not a JSON object, or the engine calls it invalid with nothing
//!     referencing the key, or reports no `providers` rows (a config error, which spec §6 step 4 also
//!     drops); or the rows cannot vouch for every entry (`KeyRefs::Unknown`). The record is dropped at
//!     once.
//!
//! **Nothing retries forever (spec §6 step 4):** a record in doubt on [`MAX_DOUBTFUL_PASSES`] passes
//! is dropped, as a structural doubt is. The count is in the FILE, so app restarts do not reset it.
//! Either way the key is KEPT — a dropped `discard` record leaves its id for uninstall's
//! `delete-all`. The editor's own Discard (`drop`) does not wait: it reports any doubt on the row.
//!
//! ## Discard never deletes a key the saved config references (hub Q21)
//!
//! "References" is the ENGINE's answer: `config validate` over the saved bytes, its rows'
//! `appKeyId` / `appOwnedKey`, joined to labels by `crate::key_refs` (the PR 3 start decision).
//! A key is deleted only on [`RefVerdict::Unreferenced`]; a missing or unreadable config, rows that
//! cannot vouch for every entry, or a row that may read ANY app key keep it. Every delete re-runs
//! that check first, under `ConfigSaver`'s lock — so no save can land between the check and the
//! delete — and the editor awaits any save of its own before it calls `drop` (a Tauri command
//! cannot be recalled).
//!
//! ## Locks
//!
//! **`ConfigSaver.lock` first, then the store's mutex; the mutex is never held across an await,
//! an engine call or `ConfigSaver.lock`.** The mutex ([`PendingResets::update`]) covers exactly one
//! read-modify-write of the file, and every writer goes through it — `add`, `flush`, `drop`, the
//! retry task and its first pass at start-up — so no write can lose another's record. It is a
//! `std::sync::Mutex` on purpose: an await while holding it would not compile clean
//! (`clippy::await_holding_lock`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::config_save::{
    candidate_dir, read_saved_with_report, write_new_file, ConfigSaver, SaveError,
};
use crate::engine::{
    key_id, label as reset_label, Engine, EngineClient, EngineError, EngineOutcome, NoProgress,
    Operation, ResetTarget,
};
use crate::key_refs::{entries_referencing_key, KeyRefs, RefVerdict};

/// The store's file, under the app's data directory. App-owned (not an engine path); uninstall's
/// `APP_DATA_FILES` names it, and `APP_DATA_GLOBS` its stale `pending-resets.json.tmp-<pid>-<seq>`
/// siblings ([`write_records`], [`sweep_stale_temps`]) — P3-M6-T4.
pub const PENDING_RESETS_FILE: &str = "pending-resets.json";

/// Every temp file [`write_records`] writes begins with this: `pending-resets.json.tmp-` — the one
/// spelling the writer, [`sweep_stale_temps`] and uninstall's `APP_DATA_GLOBS` token share
/// (`tests/uninstall.rs` holds that token to it).
pub const PENDING_RESETS_TEMP_PREFIX: &str = "pending-resets.json.tmp-";

/// Why every store write refuses once uninstall's app-files leg has run ([`PendingResets::close_for_uninstall`]).
pub const STORE_CLOSED_BY_UNINSTALL: &str =
    "This app's files were removed by Uninstall, so no pending key replacement is kept any more.";

/// Spec §6: a pending record is retried every 15 s while the app runs.
pub const RETRY_INTERVAL: Duration = Duration::from_secs(15);

/// A bound on the file a read will take, not a budget: a record is a label and an id.
const MAX_STORE_BYTES: u64 = 1024 * 1024;

/// Where a pending reset is in the replace (module header).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    PreSave,
    PostSave,
    Discard,
}

/// One pending reset. The label is the entry's identity as written (user text — it may itself be
/// key-shaped, spec §4), so `Debug` prints its length only and the file is 0600.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRecord {
    pub label: String,
    pub phase: Phase,
    pub new_key_id: String,
    /// Retry passes on which this record's reference check was in doubt for a transient reason
    /// (module header). Absent from the file while zero.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub doubtful_passes: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// How many retry passes a record's reference check may stay in doubt, transiently, before the
/// record is dropped (module header, "A check in doubt"): 20 passes — five minutes at
/// [`RETRY_INTERVAL`], longer while a slow engine stretches each pass.
pub const MAX_DOUBTFUL_PASSES: u32 = 20;

impl std::fmt::Debug for PendingRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingRecord")
            .field("label", &format_args!("<{} bytes>", self.label.len()))
            .field("phase", &self.phase)
            .field("new_key_id", &self.new_key_id)
            .field("doubtful_passes", &self.doubtful_passes)
            .finish()
    }
}

impl PendingRecord {
    fn is(&self, label: &str, key: &str) -> bool {
        self.label == label && self.new_key_id == key
    }
}

type RecordKey = (String, String);

/// What the one mutex guards besides the file: the `pre-save` records this process wrote, and
/// whether uninstall has closed the store ([`PendingResets::close_for_uninstall`]).
#[derive(Default)]
struct Inner {
    mine: BTreeSet<RecordKey>,
    /// Set, under the mutex, by uninstall's app-files leg: from then on no write lands, so nothing in
    /// this process — the retry task, `add`, `flush`, `drop` — can re-create the file that leg removes.
    closed: bool,
}

/// The store, held closed by uninstall's app-files leg (P3-M6-T4): the mutex is held for as long as
/// this lives, so no read-modify-write is in flight while that leg removes the file and its temp
/// siblings, and the latch it set refuses every later one. Never held across an await.
pub struct ClosedStore<'a>(#[allow(dead_code)] std::sync::MutexGuard<'a, Inner>);

/// Managed state: the store's mutex, and the test overrides.
#[derive(Default)]
pub struct PendingResets {
    inner: Mutex<Inner>,
    /// `None` = `app_data_dir()`. **Test harness only** — a MockRuntime app's is the developer's.
    store_dir: Option<PathBuf>,
    /// `None` = [`RETRY_INTERVAL`]. **Test harness only** — the injected clock of the retry task.
    retry_interval: Option<Duration>,
}

impl PendingResets {
    /// **Test harness only** — see the field docs.
    pub fn with_store_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.store_dir = Some(dir.into());
        self
    }

    /// **Test harness only** — see the field docs.
    pub fn with_retry_interval(mut self, interval: Duration) -> Self {
        self.retry_interval = Some(interval);
        self
    }

    fn store_dir<R: Runtime>(&self, app: &AppHandle<R>) -> Result<PathBuf, PendingError> {
        if let Some(dir) = &self.store_dir {
            return Ok(dir.clone());
        }
        app.path().app_data_dir().map_err(|e| PendingError::Store {
            detail: format!("this app's data directory could not be resolved: {e}"),
        })
    }

    /// Uninstall's app-files leg (P3-M6-T4, closing P3-M4-T3's known race): take the store's mutex,
    /// set the closed latch, and hand the held mutex back, so the leg removes `pending-resets.json`
    /// and its temp siblings with no write in flight and none to come. Without it the retry task —
    /// which runs every 15 s whatever screen is shown — could re-create the file mid-leg or after it
    /// (a `discard` marker, a promoted record). Every later write answers
    /// [`STORE_CLOSED_BY_UNINSTALL`]; the closure lasts for the rest of this app session.
    pub fn close_for_uninstall(&self) -> ClosedStore<'_> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.closed = true;
        ClosedStore(inner)
    }

    /// ONE read-modify-write of the file, under the one mutex: read, let `f` change the records
    /// (and this process's own set), write back only if they changed. Never held across an await —
    /// `f` is synchronous by type. Refused, touching nothing, once uninstall closed the store.
    fn update<T>(
        &self,
        dir: &Path,
        f: impl FnOnce(&mut Vec<PendingRecord>, &mut BTreeSet<RecordKey>) -> T,
    ) -> Result<T, PendingError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.closed {
            return Err(PendingError::Store {
                detail: STORE_CLOSED_BY_UNINSTALL.into(),
            });
        }
        let before = read_records(dir);
        let mut records = before.clone();
        let out = f(&mut records, &mut inner.mine);
        if records != before {
            write_records(dir, &records).map_err(|detail| PendingError::Store { detail })?;
        }
        Ok(out)
    }
}

/// The records in `dir`'s store. Missing, unreadable or malformed is EMPTY (a lost record costs at
/// worst a stray key or a mark the next Reset clears); a record whose id is not a key id, or whose
/// label could not be reset by label, is dropped rather than retried forever.
pub fn read_records(dir: &Path) -> Vec<PendingRecord> {
    let Ok(text) =
        crate::briefing_files::read_text_capped(&dir.join(PENDING_RESETS_FILE), MAX_STORE_BYTES)
    else {
        return Vec::new();
    };
    let Ok(records) = serde_json::from_str::<Vec<PendingRecord>>(&text) else {
        return Vec::new();
    };
    records
        .into_iter()
        .filter(|r| key_id(&r.new_key_id).is_ok() && reset_label(&r.label).is_ok())
        .collect()
}

/// Write the records: a NEW 0600 temp file beside the store (create-new, so a planted name is never
/// followed or replaced), fsync'd, then renamed over it. 0600 because a label is user text.
fn write_records(dir: &Path, records: &[PendingRecord]) -> Result<(), String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(PENDING_RESETS_FILE);
    let text = serde_json::to_string_pretty(records)
        .map_err(|e| format!("the pending resets could not be serialised: {e}"))?;
    for _ in 0..16 {
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = dir.join(format!(
            "{PENDING_RESETS_TEMP_PREFIX}{}-{seq}",
            std::process::id()
        ));
        match write_new_file(&tmp, text.as_bytes(), 0o600) {
            Ok(()) => {
                return std::fs::rename(&tmp, &path).map_err(|e| {
                    let _ = std::fs::remove_file(&tmp);
                    format!("{}: {e}", path.display())
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("{}: {e}", tmp.display())),
        }
    }
    Err(format!("{}: no free temp name beside it", path.display()))
}

/// Remove the temp files [`write_records`] leaves when a process dies between writing one and
/// renaming it: `pending-resets.json.tmp-<pid>-<seq>` (0600, holding labels) whose `<pid>` is NOT this
/// process's — this process's own are in flight or already renamed. Only that exact shape, and only
/// a regular file (a symlink is never followed). Best effort: a file that cannot be removed waits for
/// the next start. Run by the retry task before its first pass. ⚠ Assumes one app process per store,
/// as the store's in-process mutex already does; a stale name whose pid this process now reuses is
/// left (it can never collide: temp names are create-new, with a fresh `<seq>` on a clash).
pub fn sweep_stale_temps(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = PENDING_RESETS_TEMP_PREFIX;
    let me = std::process::id();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(rest) = name.to_str().and_then(|n| n.strip_prefix(prefix)) else {
            continue;
        };
        let Some((pid, seq)) = rest.split_once('-') else {
            continue;
        };
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if !digits(pid) || !digits(seq) || pid.parse::<u32>().ok() == Some(me) {
            continue;
        }
        let path = entry.path();
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn find<'a>(records: &'a [PendingRecord], label: &str, key: &str) -> Option<&'a PendingRecord> {
    records.iter().find(|r| r.is(label, key))
}

/// Set `(label, key)` to `phase`, inserting it when absent. A record moved to another phase starts
/// with no doubt counted.
fn upsert(records: &mut Vec<PendingRecord>, label: &str, key: &str, phase: Phase) {
    match records.iter_mut().find(|r| r.is(label, key)) {
        Some(r) => {
            if r.phase != phase {
                r.doubtful_passes = 0;
            }
            r.phase = phase;
        }
        None => records.push(PendingRecord {
            label: label.to_string(),
            phase,
            new_key_id: key.to_string(),
            doubtful_passes: 0,
        }),
    }
}

/// Remove `(label, key)` only while it is in one of `phases` — never another record.
fn remove_if(records: &mut Vec<PendingRecord>, label: &str, key: &str, phases: &[Phase]) {
    records.retain(|r| !(r.is(label, key) && phases.contains(&r.phase)));
}

/* ── wire types ───────────────────────────────────────────────────────────────────────────────── */

/// What `add` did. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddOutcome {
    /// The pre-save reset succeeded: save now. The `pre-save` record stays until the post-save
    /// reset (`flush`).
    Reset,
    /// A briefing holds the run lock, or another engine operation holds the app's in-flight guard:
    /// the editor shows "a briefing is running — the key will be replaced when it finishes" and
    /// calls `add` again in 15 s. The record stays.
    Retry,
    /// Any other refusal: the record is dropped. `code` and `reason` are the engine's (word by
    /// them); `detail` its fixed text, or the app's error.
    Refused {
        code: Option<String>,
        reason: Option<String>,
        detail: String,
    },
}

/// What `flush` did. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlushOutcome {
    /// The post-save reset succeeded; the record is cleared.
    Reset,
    /// Lock-held or `Busy`: the record is `post-save` and the retry task resets it.
    Retry,
    /// The record is being discarded and the saved config does not use its key under this label:
    /// nothing was reset; the retry task finishes the discard.
    Discarding,
    /// Any other refusal: the record is dropped.
    Refused {
        code: Option<String>,
        reason: Option<String>,
        detail: String,
    },
}

/// Why a discarded replacement's key was kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeptWhy {
    /// Another saved entry references it.
    OtherLabel,
    /// The saved config could not vouch that nothing references it (missing, unreadable, rows
    /// that do not cover every entry, or an entry that may read any app key).
    Unverified,
}

/// What `drop` did. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DropOutcome {
    /// The saved entry under this label already references the key — the save landed. Nothing was
    /// deleted; the record is `post-save` and its reset follows.
    Promoted,
    /// The unused key was deleted and the record dropped.
    Deleted,
    /// The delete was refused `Busy` (or lock-held): the record stays `discard` and the retry task
    /// deletes the key.
    DeletePending,
    /// The key was kept and the record dropped.
    Kept { why: KeptWhy },
    /// The delete failed for another reason: the record is dropped and the key is left for
    /// uninstall's `delete-all` (nothing retries forever).
    DeleteFailed { detail: String },
}

/// Why a command did not answer. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingError {
    /// An operand was refused. Nothing was written or spawned. The value is never echoed.
    #[serde(rename_all = "camelCase")]
    InvalidInput { field: String, reason: String },
    /// The store could not be read or written (or is not managed).
    Store { detail: String },
    /// The engine could not be located.
    Engine { detail: String },
}

/* ── the engine calls ─────────────────────────────────────────────────────────────────────────── */

/// A provider verb's answer, as the store acts on it.
enum Answer {
    Ok,
    /// Lock-held, or the app's own `Busy`: retry later.
    Retry,
    Refused {
        code: Option<String>,
        reason: Option<String>,
        detail: String,
    },
}

/// Switch on the JSON's `ok` and `code` only, never on the exit status (`docs/gui-seam.md` §1d).
fn answer_of(result: Result<EngineOutcome, EngineError>) -> Answer {
    let outcome = match result {
        Err(EngineError::Busy { .. }) => return Answer::Retry,
        Err(e) => {
            return Answer::Refused {
                code: None,
                reason: None,
                detail: e.to_string(),
            }
        }
        Ok(outcome) => outcome,
    };
    let Some(payload) = outcome.payload.as_ref() else {
        return Answer::Refused {
            code: None,
            reason: None,
            detail: "the engine stopped before replying".into(),
        };
    };
    let text = |k: &str| payload.get(k).and_then(Value::as_str).map(str::to_string);
    match payload.get("ok").and_then(Value::as_bool) {
        Some(true) => Answer::Ok,
        Some(false) if text("code").as_deref() == Some("lock-held") => Answer::Retry,
        _ => Answer::Refused {
            code: text("code"),
            reason: text("reason"),
            detail: text("error").unwrap_or_else(|| "the engine refused".into()),
        },
    }
}

/// `provider reset --label-stdin --json` — the label on STDIN, never argv (hub Q20).
async fn reset(client: &EngineClient, label: &str) -> Answer {
    let target = match reset_label(label) {
        Ok(l) => ResetTarget::Label(l),
        Err(r) => {
            return Answer::Refused {
                code: None,
                reason: None,
                detail: format!("label {}", r.message()),
            }
        }
    };
    answer_of(
        client
            .invoke(Operation::ProviderReset { target }, &NoProgress)
            .await,
    )
}

/// `provider key delete --id <key> --json`.
async fn delete_key(client: &EngineClient, key: &str) -> Answer {
    let id = match key_id(key) {
        Ok(id) => id,
        Err(r) => {
            return Answer::Refused {
                code: None,
                reason: None,
                detail: format!("key id {}", r.message()),
            }
        }
    };
    answer_of(
        client
            .invoke(Operation::KeyDelete { id }, &NoProgress)
            .await,
    )
}

/// Why a reference check could not decide (module header, "A check in doubt").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Doubt {
    /// The next pass may answer: keep the record (up to [`MAX_DOUBTFUL_PASSES`]).
    Transient,
    /// No retry changes it: drop the record (the key is kept).
    Structural,
}

/// [`reference_check`]'s doubt for a failed read of the saved config and its report.
fn doubt_of(e: &SaveError) -> Doubt {
    match e {
        SaveError::Engine { .. }
        | SaveError::ConfigUnreadable { .. }
        | SaveError::CandidateDir { .. } => Doubt::Transient,
        _ => Doubt::Structural,
    }
}

/// Does the SAVED config reference `key`, and under `label`? The engine's rows, joined to labels
/// (`crate::key_refs`) — `Ok` with [`RefVerdict::UnderLabel`], [`RefVerdict::OtherLabel`] or
/// [`RefVerdict::Unreferenced`], or `Err` with why it is in doubt (never `Ok(Uncertain)`).
/// ⚠ THE CALLER HOLDS `ConfigSaver.lock`. Hub Q21: a missing or unreadable config counts as
/// referenced, and so does an invalid config's "nothing references it" — a key is deleted only on a
/// verdict from a config the engine calls valid.
async fn reference_check<R: Runtime>(
    app: &AppHandle<R>,
    client: &EngineClient,
    saver: &ConfigSaver,
    label: &str,
    key: &str,
) -> Result<RefVerdict, Doubt> {
    if saver.refuse_if_settings_removed().is_err() {
        return Err(Doubt::Structural);
    }
    let dir = candidate_dir(app, saver).map_err(|_| Doubt::Structural)?;
    let (config, report) = read_saved_with_report(client, &dir)
        .await
        .map_err(|e| doubt_of(&e))?;
    let Some(rows) = report.get("providers").and_then(Value::as_array) else {
        return Err(Doubt::Structural);
    };
    let refs = entries_referencing_key(&config, rows, key);
    if refs == KeyRefs::Unknown {
        return Err(Doubt::Structural);
    }
    let valid = report.get("valid").and_then(Value::as_bool) == Some(true);
    match refs.verdict(label) {
        // A row that may read any app key, and none that names this one: the ownership deadline's
        // shape (module header).
        RefVerdict::Uncertain => Err(Doubt::Transient),
        RefVerdict::Unreferenced if !valid => Err(Doubt::Structural),
        verdict => Ok(verdict),
    }
}

/// [`reference_check`] for a caller that only needs the verdict: any doubt is
/// [`RefVerdict::Uncertain`].
async fn reference_verdict<R: Runtime>(
    app: &AppHandle<R>,
    client: &EngineClient,
    saver: &ConfigSaver,
    label: &str,
    key: &str,
) -> RefVerdict {
    reference_check(app, client, saver, label, key)
        .await
        .unwrap_or(RefVerdict::Uncertain)
}

/* ── the steps ────────────────────────────────────────────────────────────────────────────────── */

/// The managed pieces every step needs.
struct Parts<'a> {
    client: &'a EngineClient,
    saver: &'a ConfigSaver,
    store: &'a PendingResets,
    dir: PathBuf,
}

fn parts<R: Runtime>(app: &AppHandle<R>) -> Result<Parts<'_>, PendingError> {
    let engine = app
        .try_state::<Engine>()
        .ok_or_else(|| PendingError::Engine {
            detail: "the engine is not managed".into(),
        })?;
    let saver = app
        .try_state::<ConfigSaver>()
        .ok_or_else(|| PendingError::Store {
            detail: "the settings lock is not managed".into(),
        })?;
    let store = app
        .try_state::<PendingResets>()
        .ok_or_else(|| PendingError::Store {
            detail: "the pending-reset store is not managed".into(),
        })?;
    let client = engine.inner().client().map_err(|e| PendingError::Engine {
        detail: e.to_string(),
    })?;
    let dir = store.inner().store_dir(app)?;
    Ok(Parts {
        client,
        saver: saver.inner(),
        store: store.inner(),
        dir,
    })
}

fn operands(label: &str, key: &str) -> Result<(), PendingError> {
    reset_label(label).map_err(|r| PendingError::InvalidInput {
        field: "label".into(),
        reason: r.message().into(),
    })?;
    key_id(key).map_err(|r| PendingError::InvalidInput {
        field: "newKeyId".into(),
        reason: r.message().into(),
    })?;
    Ok(())
}

/// A replacement nobody will save any more (a Discard, a stale `pre-save` record, a `discard`
/// record being retried), given the reference verdict just taken. ⚠ THE CALLER HOLDS
/// `ConfigSaver.lock`, so no save lands between that check and the delete below.
async fn resolve_unwanted(
    p: &Parts<'_>,
    label: &str,
    key: &str,
    verdict: RefVerdict,
) -> Result<DropOutcome, PendingError> {
    let unsaved = [Phase::PreSave, Phase::Discard];
    match verdict {
        RefVerdict::UnderLabel => {
            p.store.update(&p.dir, |records, mine| {
                mine.remove(&(label.to_string(), key.to_string()));
                upsert(records, label, key, Phase::PostSave);
            })?;
            Ok(DropOutcome::Promoted)
        }
        RefVerdict::OtherLabel | RefVerdict::Uncertain => {
            p.store.update(&p.dir, |records, mine| {
                mine.remove(&(label.to_string(), key.to_string()));
                remove_if(records, label, key, &unsaved);
            })?;
            Ok(DropOutcome::Kept {
                why: if verdict == RefVerdict::OtherLabel {
                    KeptWhy::OtherLabel
                } else {
                    KeptWhy::Unverified
                },
            })
        }
        RefVerdict::Unreferenced => {
            // The marker first, so a crash or a `Busy` leaves the delete to the retry task.
            p.store.update(&p.dir, |records, mine| {
                mine.remove(&(label.to_string(), key.to_string()));
                upsert(records, label, key, Phase::Discard);
            })?;
            match delete_key(p.client, key).await {
                Answer::Ok => {
                    p.store.update(&p.dir, |records, _| {
                        remove_if(records, label, key, &[Phase::Discard])
                    })?;
                    Ok(DropOutcome::Deleted)
                }
                Answer::Retry => Ok(DropOutcome::DeletePending),
                Answer::Refused { detail, .. } => {
                    p.store.update(&p.dir, |records, _| {
                        remove_if(records, label, key, &[Phase::Discard])
                    })?;
                    Ok(DropOutcome::DeleteFailed { detail })
                }
            }
        }
    }
}

/// The post-save reset of `(label, key)`: cleared on success, kept on lock-held / `Busy`, dropped
/// on any other refusal.
async fn post_save_reset(p: &Parts<'_>, label: &str, key: &str) -> Result<Answer, PendingError> {
    let answer = reset(p.client, label).await;
    match &answer {
        Answer::Ok | Answer::Refused { .. } => p.store.update(&p.dir, |records, _| {
            remove_if(records, label, key, &[Phase::PostSave])
        })?,
        Answer::Retry => {}
    }
    Ok(answer)
}

async fn add<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    key: &str,
) -> Result<AddOutcome, PendingError> {
    operands(label, key)?;
    let p = parts(app)?;
    // Spec §6 step 1: the record BEFORE the reset it guards.
    let existing = p.store.update(&p.dir, |records, mine| {
        let existing = find(records, label, key).map(|r| r.phase);
        if existing.is_none() {
            upsert(records, label, key, Phase::PreSave);
        }
        if existing.is_none() || existing == Some(Phase::PreSave) {
            mine.insert((label.to_string(), key.to_string()));
        }
        existing
    })?;
    if existing == Some(Phase::Discard) {
        // A replacement already being thrown away is never saved after all.
        return Ok(AddOutcome::Refused {
            code: None,
            reason: None,
            detail: "this replacement was discarded".into(),
        });
    }
    Ok(match reset(p.client, label).await {
        Answer::Ok => AddOutcome::Reset,
        Answer::Retry => AddOutcome::Retry,
        Answer::Refused {
            code,
            reason,
            detail,
        } => {
            p.store.update(&p.dir, |records, mine| {
                mine.remove(&(label.to_string(), key.to_string()));
                remove_if(records, label, key, &[Phase::PreSave]);
            })?;
            AddOutcome::Refused {
                code,
                reason,
                detail,
            }
        }
    })
}

async fn flush<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    key: &str,
) -> Result<FlushOutcome, PendingError> {
    operands(label, key)?;
    let p = parts(app)?;
    {
        let _settings = p.saver.lock.lock().await;
        let was = p.store.update(&p.dir, |records, mine| {
            mine.remove(&(label.to_string(), key.to_string()));
            let was = find(records, label, key).map(|r| r.phase);
            if was != Some(Phase::Discard) {
                // The save landed: a `pre-save` record (or none — the bracket's record is what
                // guarantees the retry) becomes `post-save`.
                upsert(records, label, key, Phase::PostSave);
            }
            was
        })?;
        if was == Some(Phase::Discard) {
            let verdict = reference_verdict(app, p.client, p.saver, label, key).await;
            if verdict != RefVerdict::UnderLabel {
                return Ok(FlushOutcome::Discarding);
            }
            p.store.update(&p.dir, |records, _| {
                upsert(records, label, key, Phase::PostSave)
            })?;
        }
    } // ← the settings lock is released before the engine is asked to reset.
    Ok(match post_save_reset(&p, label, key).await? {
        Answer::Ok => FlushOutcome::Reset,
        Answer::Retry => FlushOutcome::Retry,
        Answer::Refused {
            code,
            reason,
            detail,
        } => FlushOutcome::Refused {
            code,
            reason,
            detail,
        },
    })
}

async fn drop_replacement<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    key: &str,
) -> Result<DropOutcome, PendingError> {
    operands(label, key)?;
    let p = parts(app)?;
    let _settings = p.saver.lock.lock().await;
    // This very record already `post-save`: its save landed — never touched here.
    let phase = p.store.update(&p.dir, |records, _| {
        find(records, label, key).map(|r| r.phase)
    })?;
    if phase == Some(Phase::PostSave) {
        return Ok(DropOutcome::Promoted);
    }
    let verdict = reference_verdict(app, p.client, p.saver, label, key).await;
    resolve_unwanted(&p, label, key, verdict).await
}

/// One pass of the retry task over every record that is not this process's editor's: `post-save`
/// records are reset; `discard` records, and `pre-save` records a previous run left, are resolved
/// against the saved config (module header) — kept for the next pass while that check is in doubt
/// for a transient reason, up to [`MAX_DOUBTFUL_PASSES`]. The first pass at start-up is the
/// start-up hook. Errors are swallowed: a record that could not be handled is tried again next pass.
pub async fn retry_pass<R: Runtime>(app: &AppHandle<R>) {
    let Ok(p) = parts(app) else {
        return;
    };
    // Skipping the editor's own `pre-save` records here is an OPTIMISATION (PR 3 final r1, C5): the
    // snapshot is stale by the time a record is handled, so what GUARANTEES that one is never
    // resolved under the editor is the re-read under the settings lock below, which filters `mine`
    // again. Post-save records are reset from the snapshot as they stand.
    let Ok(snapshot) = p.store.update(&p.dir, |records, mine| {
        records
            .iter()
            .filter(|r| {
                !(r.phase == Phase::PreSave
                    && mine.contains(&(r.label.clone(), r.new_key_id.clone())))
            })
            .cloned()
            .collect::<Vec<_>>()
    }) else {
        return;
    };
    for record in snapshot {
        let (label, key) = (record.label.as_str(), record.new_key_id.as_str());
        if record.phase == Phase::PostSave {
            let _ = post_save_reset(&p, label, key).await;
            continue;
        }
        let promoted = {
            let _settings = p.saver.lock.lock().await;
            // Re-read under the lock: `flush` or `drop` may have moved it meanwhile.
            let now = p.store.update(&p.dir, |records, mine| {
                find(records, label, key).map(|r| r.phase).filter(|phase| {
                    *phase == Phase::Discard
                        || !mine.contains(&(label.to_string(), key.to_string()))
                })
            });
            match now {
                Ok(Some(phase @ (Phase::PreSave | Phase::Discard))) => {
                    let verdict = match reference_check(app, p.client, p.saver, label, key).await {
                        Ok(verdict) => Some(verdict),
                        Err(Doubt::Structural) => Some(RefVerdict::Uncertain),
                        Err(Doubt::Transient) => {
                            // Counted under the store's mutex, on the record as it is now.
                            let counted = p.store.update(&p.dir, |records, _| {
                                let r = records.iter_mut().find(|r| r.is(label, key))?;
                                if r.phase != phase {
                                    return None;
                                }
                                r.doubtful_passes = r.doubtful_passes.saturating_add(1);
                                Some(r.doubtful_passes)
                            });
                            match counted {
                                // The bound: nothing retries forever.
                                Ok(Some(n)) if n >= MAX_DOUBTFUL_PASSES => {
                                    Some(RefVerdict::Uncertain)
                                }
                                _ => None,
                            }
                        }
                    };
                    match verdict {
                        Some(verdict) => matches!(
                            resolve_unwanted(&p, label, key, verdict).await,
                            Ok(DropOutcome::Promoted)
                        ),
                        None => false,
                    }
                }
                _ => false,
            }
        };
        if promoted {
            // Plan Q11: promoted to `post-save`, flushed — its reset retried like any other.
            let _ = post_save_reset(&p, label, key).await;
        }
    }
}

/// Spawn the retry task: the store's stale temp files swept ([`sweep_stale_temps`]), a pass now
/// (the start-up hook), then one every [`RETRY_INTERVAL`] (or the injected interval) while the app
/// runs.
pub fn spawn_retry<R: Runtime>(app: &AppHandle<R>) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let store = app.try_state::<PendingResets>();
        let interval = store
            .as_ref()
            .and_then(|s| s.inner().retry_interval)
            .unwrap_or(RETRY_INTERVAL);
        if let Some(dir) = store.and_then(|s| s.inner().store_dir(&app).ok()) {
            sweep_stale_temps(&dir);
        }
        loop {
            retry_pass(&app).await;
            tokio::time::sleep(interval).await;
        }
    })
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// Replace, before the save: record a `pre-save` reset for `label`'s replacement by `newKeyId`, and
/// run the pre-save `provider reset` (resolved by the engine against the SAVED config; the label on
/// STDIN). Answers `reset` (save now), `retry` (a run holds the lock — call again in 15 s), or
/// `refused` (the record is dropped). Idempotent for the editor's retries.
#[tauri::command]
pub async fn provider_pending_reset_add<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    new_key_id: String,
) -> Result<AddOutcome, PendingError> {
    add(&app, &label, &new_key_id).await
}

/// Replace, after the save landed: the record becomes `post-save` and the post-save reset runs;
/// cleared on success, retried by the task on lock-held / `Busy`.
#[tauri::command]
pub async fn provider_pending_reset_flush<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    new_key_id: String,
) -> Result<FlushOutcome, PendingError> {
    flush(&app, &label, &new_key_id).await
}

/// Discard or cancel an unsaved replacement: under the settings lock, the saved config decides —
/// referenced under this label (the save landed) → promoted; only under another → the key is kept;
/// nowhere (and the rows vouch for every entry) → the unused key is deleted. A `post-save` record
/// is never touched. The editor awaits any save of its own before calling this.
#[tauri::command]
pub async fn provider_pending_reset_drop<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    new_key_id: String,
) -> Result<DropOutcome, PendingError> {
    drop_replacement(&app, &label, &new_key_id).await
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &[
    "provider_pending_reset_add",
    "provider_pending_reset_flush",
    "provider_pending_reset_drop",
];
