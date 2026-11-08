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
//!    literal API key — item 1's `provider.api.apiKey`, a `fallbacks[i].api.apiKey`, any `apiKey`
//!    anywhere (P3-M2-T1, [`redact`]) — is never sent to the webview (it gets [`REDACTED_API_KEY`]
//!    in its place) and can be KEPT or REMOVED from the app, never set or changed — the engine has
//!    no `--api-key` flag for the same reason (`src/main.ts` usage text). A kept key goes back at
//!    the same JSON pointer, and only while the same entry (by a label no other entry shares) owns
//!    it and that entry still sends it to the same kind and endpoint origin ([`restore_api_key`]).
//!    Any other literal — new, or changed from what the file holds at that pointer, at any spelling
//!    of `apiKey` — is refused ([`refuse_new_or_changed_literals`], P3-M2-T2), and so is one sent
//!    back verbatim whose owning entry's label, kind or endpoint origin changed.
//! 5. **A no-op writes nothing.** The candidate is re-serialised as
//!    `JSON.stringify(x, null, 2)` does it (2-space indent, insertion order — serde_json's
//!    `preserve_order`, no trailing newline, which is how `initConfig` writes it); if that equals the
//!    same serialisation of what is on disk, nothing is validated and nothing is written.
//! 6. **The engine validates.** The candidate goes to an app-owned file under the app's DATA dir
//!    (`<app_data_dir>/config-candidates/candidate-<pid>-<seq>.json`, mode 0600 in a 0700
//!    directory, removed afterwards; stale ones swept first) and through
//!    `config validate --json --file <it>` — B3's operand validator, unchanged. ERRORS block;
//!    WARNINGS are returned and do not block. No validation rule lives in this file — with ONE
//!    exception (final harden r2): a `calendar` block holding a link address is refused BEFORE the
//!    candidate is staged ([`CALENDAR_SECRET_ERROR`]), so the secret never reaches the candidate
//!    directory; the rule itself lives in `crate::calendar`.
//! 7. **Atomic replace** ([`replace_config_file`]). The new bytes and the backup bytes are staged in
//!    this app's own temp files IN THE SAME DIRECTORY (`fsync`ed); the file is re-read and must
//!    still be what was validated; only then is the backup renamed to `<config>.bak` and the new
//!    bytes renamed over the config, and the directory `fsync`ed. A failure anywhere leaves the
//!    config AND `.bak` as they were (a failed final rename puts the previous `.bak` back). The
//!    previous `.bak` is kept aside by a hard link, or — on a filesystem without hard links (FAT32,
//!    exFAT, some network shares) — by a rename; a `.bak` that is not a regular file is refused by
//!    name ([`SaveError::BackupNotAFile`]) and left alone. The
//!    file mode is kept — tightened to owner-only when the candidate OR the file on disk carries an
//!    `api` block, item 1's or any `fallbacks[i].api` ([`holds_api_block`]; what `initConfig` does
//!    for an API config), or the file holds a literal key anywhere, and `.bak` is never wider
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
use crate::engine::{
    config_file_path, provider_index, ConfigFilePath, Engine, EngineClient, EngineError,
    EngineOutcome, NoProgress, Operation, Outcome,
};
use crate::key_refs::{combined_entries, engine_label, DEFAULT_ITEM1_LABEL};
use crate::shell::ENGINE_READ_TIMEOUT;

/// The largest config the app will read or write. The engine's own default is well under 1 KB.
pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// What the webview sees in place of every literal `apiKey` ([`redact`]). Sending it back unchanged,
/// at the same pointer and under the same entry, keeps the stored key ([`restore_api_key`]);
/// removing the key removes it. The wizard and the list writer compare against it exactly
/// (`gui/src/lib/wizard.ts`, `gui/src/lib/provider-list.ts`), so its text never changes.
pub const REDACTED_API_KEY: &str =
    "(a literal API key is stored in config.json; Daily Briefing never displays it)";

/// Where candidate files go, under the app's data directory.
pub const CANDIDATE_SUBDIR: &str = "config-candidates";

/// The name prefix of every candidate file the SAVE path stages (`candidate-<pid>-<seq>.json`).
pub const CANDIDATE_PREFIX: &str = "candidate-";

/// The name prefix of every candidate file the CHECK path stages (`provider-check-<pid>-<seq>.json`,
/// [`provider_candidate_check`], P3-M1-T2). Its own, so the save path's
/// `sweep_stale(dir, CANDIDATE_PREFIX, …)` — which removes THIS process's files too, because it runs
/// under the save lock — can never match one: a check stages under that lock but runs the engine
/// WITHOUT it (a Test can take up to 30 minutes).
pub const CHECK_PREFIX: &str = "provider-check-";

/// Why every settings write refuses once Uninstall has removed the settings (Batch 2, spec 3.5.3
/// step 6) — [`SaveError::Unsupported`]'s `detail`, which the webview shows verbatim
/// (`lib/files.ts`, `describeFailure`), so no wire type changes (plan SQ2).
pub const SETTINGS_REMOVED_BY_UNINSTALL: &str = "Settings were removed by Uninstall.";

/// Final harden r2: what a save answers, as an `Invalid` outcome, when the candidate's `calendar`
/// block holds a link address ([`crate::calendar::calendar_block_holds_secret`]) — refused BEFORE
/// any candidate file is staged, so the secret never reaches `config-candidates/`. The engine's
/// `CALENDAR_LITERAL_URL_ERROR` (`src/calendar/config.ts`), verbatim: `config validate` would have
/// answered exactly this, and `gui/tests-web/calendar.check.ts` pins the two equal.
pub const CALENDAR_SECRET_ERROR: &str = "config error: the \"calendar\" block holds a link address (a \"url\" field, or a web address in a urlCommand argument, a link name, an owner or an email) — a calendar link's address is a secret and is never stored in the config file; delete it and add the link with `daily-briefing calendar add-link` (or give it a urlEnv, or a urlCommand that prints the address)";

/// The one error a candidate whose `calendar` block holds a link address answers, or `None`.
fn calendar_secret_errors(candidate: &Value) -> Option<Vec<FieldNote>> {
    candidate
        .get("calendar")
        .filter(|block| crate::calendar::calendar_block_holds_secret(block))
        .map(|_| {
            vec![FieldNote {
                field: "calendar".into(),
                message: CALENDAR_SECRET_ERROR.into(),
            }]
        })
}

/// The `Invalid` outcome for a candidate whose `calendar` block holds a link address, or `None`.
fn refuse_calendar_secret(candidate: &Value) -> Option<SaveOutcome> {
    calendar_secret_errors(candidate).map(|errors| SaveOutcome::Invalid {
        errors,
        warnings: Vec::new(),
    })
}

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

    /// The latch already set, as `uninstall_execute`'s settings leg leaves it. **Test harness
    /// only** — so a test of a write's refusal need not run an Uninstall first. It can only make the
    /// saver refuse more, never less.
    pub fn with_settings_removed(self) -> Self {
        self.mark_settings_removed();
        self
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
    /// `pub(crate)` for `crate::calendar`'s three writes (v0.3.0, plan M8), which take the same
    /// lock and honour the same latch.
    pub(crate) fn refuse_if_settings_removed(&self) -> Result<(), SaveError> {
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
    /// The candidate sets or changes a literal key at any pointer, or keeps one under another owner
    /// or endpoint ([`refuse_new_or_changed_literals`]), or carries
    /// [`REDACTED_API_KEY`] where the file holds no literal, where the entry owning that pointer is
    /// a different one or shares its label with another, or where that entry's `api.kind` or
    /// endpoint origin changed ([`restore_api_key`]).
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

/// A key slot that may hold a literal: an object key spelled `apiKey` at any ASCII case — the
/// spellings [`holds_literal_api_key`] refuses at create. The engine reads `apiKey` only in an
/// `api` block (item 1's or a `fallbacks` entry's), but the guard covers every spelling at every
/// depth, so a key typed into the wrong place is never shown either.
fn is_key_slot(name: &str) -> bool {
    name.eq_ignore_ascii_case("apikey")
}

/// P3-M2-T1: replace EVERY literal key — any non-null value at a [`is_key_slot`] key, at any depth
/// (item 1, each `fallbacks[i].api`, anywhere else) — with [`REDACTED_API_KEY`]. Returns whether it
/// did.
///
/// Not only strings (P3-M2-T1 checkpoint): the engine refuses an `apiKey` that is not a non-empty
/// string (`src/config.ts`, `normalizeProviderBlock`), but a key pasted as `["sk-…"]`, inside an
/// object, or as a number is still a secret in the file, so the value at a key slot is never shown
/// whatever its type — the same slots [`holds_literal_api_key`] refuses at create. Only `null`
/// holds nothing and is shown as it is. [`restore_api_key`] puts back exactly the value the file
/// holds at that pointer.
pub fn redact(mut value: Value) -> (Value, bool) {
    let redacted = redact_in(&mut value);
    (value, redacted)
}

fn redact_in(value: &mut Value) -> bool {
    let mut redacted = false;
    match value {
        Value::Object(map) => {
            for (name, v) in map.iter_mut() {
                if is_key_slot(name) && !v.is_null() {
                    *v = Value::String(REDACTED_API_KEY.to_string());
                    redacted = true;
                } else {
                    redacted |= redact_in(v);
                }
            }
        }
        Value::Array(items) => {
            for v in items {
                redacted |= redact_in(v);
            }
        }
        _ => {}
    }
    redacted
}

/// One step of a JSON pointer, typed, so no `~0`/`~1` escaping is involved.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    Key(String),
    Index(usize),
}

fn lookup<'a>(root: &'a Value, path: &[Step]) -> Option<&'a Value> {
    path.iter().try_fold(root, |v, step| match step {
        Step::Key(k) => v.as_object()?.get(k),
        Step::Index(i) => v.as_array()?.get(*i),
    })
}

fn lookup_mut<'a>(root: &'a mut Value, path: &[Step]) -> Option<&'a mut Value> {
    path.iter().try_fold(root, |v, step| match step {
        Step::Key(k) => v.as_object_mut()?.get_mut(k),
        Step::Index(i) => v.as_array_mut()?.get_mut(*i),
    })
}

/// Every pointer in `value` whose key slot holds exactly [`REDACTED_API_KEY`].
fn placeholder_slots(value: &Value, at: &mut Vec<Step>, out: &mut Vec<Vec<Step>>) {
    match value {
        Value::Object(map) => {
            for (name, v) in map {
                at.push(Step::Key(name.clone()));
                if is_key_slot(name) && v.as_str() == Some(REDACTED_API_KEY) {
                    out.push(at.clone());
                } else {
                    placeholder_slots(v, at, out);
                }
                at.pop();
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                at.push(Step::Index(i));
                placeholder_slots(v, at, out);
                at.pop();
            }
        }
        _ => {}
    }
}

/// Who owns the key slot at `path`: the combined-list entry whose block holds it, by its label.
#[derive(Debug, PartialEq, Eq)]
enum Owner<'a> {
    /// `fallbacks[i]`, `provider.accounts[j]` or item 1, labelled as the engine labels it. `None`:
    /// an entry with no usable label (the engine drops such a fallback).
    Entry(Option<&'a str>),
    /// Outside `provider` and `fallbacks`: no entry, so the pointer alone identifies the slot.
    Document,
}

/// The owner of the slot at `path` in `root`. Item 1's label is RESOLVED as the engine resolves it
/// (`resolveProviderList`, `src/providerList.ts`), which is also how the app's list writer reads it
/// (`gui/src/lib/provider-list.ts` `readAll`):
/// - an API item 1 (`provider.api` present — `!== undefined`, so even `null`): `provider.label`
///   when it is a usable label, else `"default"`. `provider.accounts` is ignored beside an API item
///   1 by both, so it never labels it here. This is the only item 1 that can hold a key the engine
///   reads (`/provider/api/apiKey`).
/// - a CLI item 1: `provider.accounts[0].label` when `accounts` is a non-empty list whose first
///   login has a usable label, else as for an API item 1. The engine uses the first login only when
///   `resolveAccounts` accepts the whole list, which Rust does not re-decide (it checks directories
///   on disk); a broken list is a `config validate` warning the editor's save gate refuses. A literal
///   under a CLI item 1 is never read by the engine (it has no `api` block), so this branch only has
///   to name the same entry on both sides, which it does.
/// A slot inside `provider.accounts[j]` is login `j`'s, by its own label — not item 1's.
fn owner<'a>(root: &'a Value, path: &[Step]) -> Owner<'a> {
    let key = |i: usize| match path.get(i) {
        Some(Step::Key(k)) => Some(k.as_str()),
        _ => None,
    };
    let index = |i: usize| match path.get(i) {
        Some(Step::Index(n)) => Some(*n),
        _ => None,
    };
    let label_at = |p: &[Step]| engine_label(lookup(root, p).and_then(|e| e.get("label")));
    match (key(0), key(1), index(1), index(2)) {
        (Some("fallbacks"), _, Some(_), _) => Owner::Entry(label_at(&path[..2])),
        (Some("provider"), Some("accounts"), _, Some(_)) => Owner::Entry(label_at(&path[..3])),
        (Some("provider"), ..) => {
            let provider = root.get("provider");
            let is_api = provider.is_some_and(|p| p.get("api").is_some());
            let first_login = provider
                .and_then(|p| p.get("accounts"))
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|l| engine_label(l.get("label")));
            let named = engine_label(provider.and_then(|p| p.get("label")));
            Owner::Entry(Some(
                first_login
                    .filter(|_| !is_api)
                    .or(named)
                    .unwrap_or(DEFAULT_ITEM1_LABEL),
            ))
        }
        _ => Owner::Document,
    }
}

/// Every usable label of the combined list in `root`, as [`owner`] reads them (P3-M2-T1
/// checkpoint): item 1's — its logins' (a CLI item 1 whose `accounts[0]` has a usable label, the
/// branch [`owner`] takes), else its resolved label — then every `fallbacks` entry's. An entry
/// with no usable label has none to count. Duplicates are KEPT: [`restore_api_key`] counts them.
///
/// P3-M4-T3: the enumeration itself moved to [`crate::key_refs::combined_entries`], which keeps
/// every POSITION (a label-less entry as `None`) so the pending-reset store can join `config
/// validate` rows to labels by index through the same reading; this keeps the labels only.
fn combined_labels(root: &Value) -> Vec<&str> {
    combined_entries(root)
        .into_iter()
        .filter_map(|e| e.label)
        .collect()
}

/// The engine's default endpoint for an `anthropic` block with no `baseUrl` —
/// `ANTHROPIC_DEFAULT_BASE_URL` (`src/providers/endpoint.ts`). An `openai-compatible` block has none.
const ANTHROPIC_DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// Where a key in the slot at `path` would be SENT (P3-M2-T1 checkpoint): the owning entry's
/// `api.kind`, and the ORIGIN of its endpoint — scheme, host and port (the scheme's default port
/// when none is written), parsed as the engine's `new URL` parses it (WHATWG; `tauri::Url` is the
/// `url` crate tauri already depends on). `baseUrl` absent (or `null`, which the engine's `??`
/// treats the same) is the kind's default (`endpointUrl`, `src/providers/endpoint.ts`), so an
/// `anthropic` block with and without `https://api.anthropic.com` written out is one endpoint. A
/// `baseUrl` that does not parse, or has no host, is compared as its raw text.
///
/// The owning entry is `fallbacks[i]` for a slot under it, and `provider` for any slot under
/// `provider` (item 1, and its logins, which have no `api` block of their own). `None`: a slot
/// outside both, which no entry sends anywhere.
fn endpoint<'a>(root: &'a Value, path: &[Step]) -> Option<(Option<&'a Value>, Option<String>)> {
    let entry = match path {
        [Step::Key(f), Step::Index(_), ..] if f == "fallbacks" => &path[..2],
        [Step::Key(p), ..] if p == "provider" => &path[..1],
        _ => return None,
    };
    let api = lookup(root, entry).and_then(|e| e.get("api"));
    let kind = api.and_then(|a| a.get("kind"));
    let raw = match api.and_then(|a| a.get("baseUrl")) {
        None | Some(Value::Null) => (kind.and_then(Value::as_str) == Some("anthropic"))
            .then(|| ANTHROPIC_DEFAULT_BASE_URL.to_string()),
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    };
    let origin = raw.map(|raw| match tauri::Url::parse(&raw) {
        Ok(url) if url.host_str().is_some() => format!(
            "{}://{}:{}",
            url.scheme(),
            url.host_str().unwrap_or_default(),
            url.port_or_known_default()
                .map_or_else(String::new, |p| p.to_string())
        ),
        _ => format!("unparsed:{raw}"),
    });
    Some((kind, origin))
}

/// P3-M2-T1: restore by pointer, with the owner check (spec §6 "The settings guard").
///
/// Wherever the candidate's key slot holds [`REDACTED_API_KEY`], the literal the file on disk holds
/// at the SAME pointer goes back — only when the entry owning that pointer ([`owner`]) has the same
/// label on disk and in the candidate, that label belongs to no other entry of the combined list on
/// either side ([`combined_labels`]; labels are unique, spec §4), and the entry's `api.kind` and
/// endpoint origin are the same on both sides ([`endpoint`]; a model or path change is not a move).
/// Otherwise the save is refused ([`SaveError::ApiKeyChanged`]): a placeholder with no literal
/// behind it (a pasted document, a new entry, a `null`), a placeholder whose pointer now belongs to
/// a different entry (a swap, a reorder, an insert or removal above it, a rename, two entries
/// sharing the label), and a placeholder whose entry now sends its key somewhere else (another
/// kind, scheme, host or port — the wizard's Anthropic → local re-run, a block replaced under the
/// same label) — so restore can never put one entry's key into another, or send it to an endpoint
/// it was not stored for, whatever the editor allowed.
///
/// Then P3-M2-T2 ([`refuse_new_or_changed_literals`]): with every placeholder restored, a literal
/// that is new or changed ANYWHERE, or kept under another owner or endpoint, is refused — item 1's
/// rule, at every pointer.
pub fn restore_api_key(candidate: &mut Value, on_disk: &Value) -> Result<(), SaveError> {
    let mut slots = Vec::new();
    placeholder_slots(candidate, &mut Vec::new(), &mut slots);
    for path in slots {
        let Some(stored) = lookup(on_disk, &path).filter(|v| !v.is_null()) else {
            // The placeholder with no key behind it: a pasted document, not an edit of this one.
            return Err(SaveError::ApiKeyChanged);
        };
        let same_owner = match (owner(on_disk, &path), owner(candidate, &path)) {
            (Owner::Document, Owner::Document) => true,
            (Owner::Entry(Some(was)), Owner::Entry(Some(is))) => {
                let unique =
                    |root: &Value| combined_labels(root).iter().filter(|l| **l == was).count() == 1;
                was == is && unique(on_disk) && unique(candidate)
            }
            _ => false,
        };
        // The ENDPOINT half is defence in depth (PR 3 final r1, C5): every restored literal is a
        // literal slot of the candidate, and `refuse_new_or_changed_literals` below compares each
        // one's owner and endpoint across the two sides — that is what binds. The owner half is
        // NOT redundant: the unique-label check exists only here.
        if !same_owner || endpoint(on_disk, &path) != endpoint(candidate, &path) {
            return Err(SaveError::ApiKeyChanged);
        }
        let stored = stored.clone();
        let slot = lookup_mut(candidate, &path).expect("the slot was found in the candidate");
        *slot = stored;
    }
    refuse_new_or_changed_literals(candidate, on_disk)
}

/// Every pointer in `value` whose key slot ([`is_key_slot`]) holds a literal: any value but `null`,
/// the slots [`redact`] replaces. A slot's value is compared whole, so nothing inside it is visited.
fn literal_slots(value: &Value, at: &mut Vec<Step>, out: &mut Vec<Vec<Step>>) {
    match value {
        Value::Object(map) => {
            for (name, v) in map {
                at.push(Step::Key(name.clone()));
                if is_key_slot(name) {
                    if !v.is_null() {
                        out.push(at.clone());
                    }
                } else {
                    literal_slots(v, at, out);
                }
                at.pop();
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                at.push(Step::Index(i));
                literal_slots(v, at, out);
                at.pop();
            }
        }
        _ => {}
    }
}

/// The one note a candidate check answers for a candidate holding a literal key (PR 3 final r1, A3).
/// Fixed text: it names the class of problem, never the value or where it sits.
pub const CHECK_LITERAL_KEY_ERROR: &str = "config error: an API key is written into these settings — this app never sets, changes or checks a key written into config.json; remove it, and paste the key into the provider's key field instead (the app keeps it in its key store)";

/// PR 3 final r1 (reviewer A3): the candidate check's refusal of a literal key, before anything is
/// staged. The webview never holds a key, so the one literal it may send at a key slot is
/// [`REDACTED_API_KEY`] (from [`config_read`]); any other non-`null` value at a slot
/// [`literal_slots`] finds — the guard's own walker, so the check and the save agree on what a
/// slot is — was typed in, and the save path refuses it anyway ([`refuse_new_or_changed_literals`]).
/// Refused here so it never reaches `config-candidates/`.
fn literal_key_errors(candidate: &Value) -> Option<Vec<FieldNote>> {
    let mut slots = Vec::new();
    literal_slots(candidate, &mut Vec::new(), &mut slots);
    slots
        .iter()
        .any(|path| lookup(candidate, path).and_then(Value::as_str) != Some(REDACTED_API_KEY))
        .then(|| {
            vec![FieldNote {
                field: "apiKey".into(),
                message: CHECK_LITERAL_KEY_ERROR.into(),
            }]
        })
}

/// P3-M2-T2: the app may KEEP or REMOVE a literal key, never set or change one (spec §6). After
/// [`restore_api_key`] has put every placeholder back, each literal left in the candidate — any
/// non-`null` value at an `apiKey` slot of any ASCII case, at any depth ([`literal_slots`]) — must
/// be exactly what the file holds at the SAME pointer; anything else is refused
/// ([`SaveError::ApiKeyChanged`]): a new literal (a fallback gaining `apiKey`, a case variant beside
/// a placeholder, a stored key copied to another pointer) or a changed one (another value, another
/// type, `""`). An absent or `null` slot holds nothing, so a removal always passes, and a candidate
/// built from the parsed file itself ([`edit_config_at`]) holds every literal where it was.
///
/// A literal kept VERBATIM is bound like a restored one (checkpoint P3-M2): the entry owning its
/// pointer ([`owner`]) and where that entry sends it ([`endpoint`]: kind and origin) must be the
/// same on both sides, so a stored key cannot follow its entry to another host or a new label by
/// being sent back as itself rather than as the placeholder. The unique-label check
/// [`restore_api_key`] adds is deliberately NOT applied here: the Quit offer and calendar saves
/// rebuild the candidate from the parsed file, and a hand-written config with duplicate labels must
/// keep saving through them.
pub fn refuse_new_or_changed_literals(candidate: &Value, on_disk: &Value) -> Result<(), SaveError> {
    let mut slots = Vec::new();
    literal_slots(candidate, &mut Vec::new(), &mut slots);
    if slots.iter().all(|path| {
        lookup(candidate, path) == lookup(on_disk, path)
            && owner(on_disk, path) == owner(candidate, path)
            && endpoint(on_disk, path) == endpoint(candidate, path)
    }) {
        Ok(())
    } else {
        Err(SaveError::ApiKeyChanged)
    }
}

/// P3-M2-T2: does `value` hold an `api` block anywhere the engine reads one — item 1's
/// (`provider.api`) or any `fallbacks[i].api` — present at all (`!== undefined`, so even `null`)?
/// A config that does is owner-only, as `initConfig` leaves an API config ([`save_value`],
/// [`config_create`]).
pub fn holds_api_block(value: &Value) -> bool {
    value.pointer("/provider/api").is_some()
        || value
            .get("fallbacks")
            .and_then(Value::as_array)
            .is_some_and(|f| f.iter().any(|e| e.get("api").is_some()))
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

/// `<pid>-<seq>`: the unique part of every temp name this module stages. `pub(crate)` for
/// `crate::calendar`'s link-file writer (plan M8), which stages its temp files the same way so
/// [`sweep_stale`] can tell its own stale ones from anything else.
pub(crate) fn unique() -> String {
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
    sweep(dir, prefix, suffixes, true)
}

/// [`sweep_stale`] for a caller that does NOT hold [`ConfigSaver`]'s lock across its whole use of the
/// files it stages (the candidate check, P3-M1-T2): it removes only a file whose writer pid the OS
/// reports as gone — **never one of this process's**, which may belong to a check still in flight
/// (each removes its own through [`RemoveOnDrop`]).
pub fn sweep_dead(dir: &Path, prefix: &str, suffixes: &[&str]) -> Vec<PathBuf> {
    sweep(dir, prefix, suffixes, false)
}

/// The one sweep: `own_files_are_stale` says whether this process's own files count as stale.
fn sweep(dir: &Path, prefix: &str, suffixes: &[&str], own_files_are_stale: bool) -> Vec<PathBuf> {
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
        let stale = if owner == me {
            own_files_are_stale
        } else {
            pid_is_dead(owner)
        };
        if !stale {
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

/// `status --json` → `paths.configPath`. `pub(crate)` for `crate::calendar`'s block save (plan M8).
pub(crate) async fn locate(client: &EngineClient) -> Result<PathBuf, SaveError> {
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

/// Stage `text` as a new private file `<prefix><pid>-<seq>.json` (0600) in the candidate directory
/// `dir` (created if missing, 0700), after `sweep` has run over that directory. The file is removed
/// when the returned guard drops — however the caller's engine call ends. `Err` is the
/// [`SaveError::CandidateDir`] detail.
fn stage_candidate(
    dir: &Path,
    prefix: &str,
    text: &str,
    sweep: impl FnOnce(&Path),
) -> Result<(RemoveOnDrop, ConfigFilePath), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    sweep(dir);
    let file = dir.join(format!("{prefix}{}.json", unique()));
    write_new_file(&file, text.as_bytes(), 0o600)
        .map_err(|e| format!("{}: {e}", file.display()))?;
    let cleanup = RemoveOnDrop(file.clone());
    let spelled = file
        .to_str()
        .ok_or_else(|| format!("{} is not valid UTF-8", file.display()))?;
    // B3's operand validator, unchanged: the path is refused before any spawn if it is not one.
    let operand = config_file_path(spelled).map_err(|r| format!("{spelled} {}", r.message()))?;
    Ok((cleanup, operand))
}

/// `config validate --json --file <candidate>`, over a candidate file this function writes and
/// removes.
async fn validate(
    client: &EngineClient,
    dir: &Path,
    text: &str,
) -> Result<ValidateReport, SaveError> {
    let payload = validate_report(client, dir, text).await?;
    serde_json::from_value(payload).map_err(|e| SaveError::Engine {
        detail: format!("`config validate` answered without a readable verdict: {e}"),
    })
}

/// [`validate`]'s engine step, answering the report VERBATIM (`providers` rows included).
///
/// ⚠ THE CALLER HOLDS [`ConfigSaver::lock`]: the stage's sweep is [`sweep_stale`], which treats
/// this process's own leftover candidates as stale.
async fn validate_report(
    client: &EngineClient,
    dir: &Path,
    text: &str,
) -> Result<Value, SaveError> {
    let (_cleanup, operand) = stage_candidate(dir, CANDIDATE_PREFIX, text, |dir| {
        sweep_stale(dir, CANDIDATE_PREFIX, &[".json"]);
    })
    .map_err(|detail| SaveError::CandidateDir { detail })?;

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
    match (&outcome.outcome, &outcome.payload) {
        (Outcome::Delivered, Some(payload)) => Ok(payload.clone()),
        _ => Err(SaveError::Engine {
            detail: failure_detail("config validate", &outcome),
        }),
    }
}

/// The SAVED config as it is on disk now, parsed, and `config validate --json`'s report over
/// exactly the bytes that were parsed (staged as a candidate, as a save's validation is) — so the
/// rows (`providers`: `appKeyId`, `appOwnedKey`, …) describe the very document the caller reads
/// labels from (`crate::key_refs`). For the pending-reset store (P3-M4-T3, hub Q21), which asks
/// "does the saved config reference this key?" before every delete.
///
/// ⚠ THE CALLER HOLDS [`ConfigSaver::lock`] (so no save lands between this read and whatever the
/// caller does with the answer) and has checked [`ConfigSaver::refuse_if_settings_removed`]. The
/// errors are [`read_existing`]'s and [`parse_on_disk`]'s (`NoConfig`, `ConfigUnreadable`,
/// `OnDiskNotJson`) and the engine's; a caller deciding whether a key may be deleted reads every one
/// of them as "referenced".
pub(crate) async fn read_saved_with_report(
    client: &EngineClient,
    candidate_dir: &Path,
) -> Result<(Value, Value), SaveError> {
    let path = locate(client).await?;
    let text = read_existing(&path)?;
    let value = parse_on_disk(&path, &text)?;
    let report = validate_report(client, candidate_dir, &text).await?;
    Ok((value, report))
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
    // Final harden r2: a calendar link address is refused HERE, before `validate` stages the
    // candidate on disk — the engine would refuse it too, but only after reading the staged file.
    if let Some(refused) = refuse_calendar_secret(&candidate) {
        return Ok(refused);
    }
    let report = validate(client, candidate_dir, &text).await?;
    if !report.valid {
        return Ok(SaveOutcome::Invalid {
            errors: report.errors,
            warnings: report.warnings,
        });
    }
    // Owner-only when EITHER side holds an API block — item 1's or any fallback's (P3-M2-T2) — or
    // the file has a key named `apiKey` anywhere ([`holds_literal_api_key`], a `null` included —
    // stricter is harmless): the new file may carry a key, and the `.bak` (never wider
    // than the new file) may carry the old one. (A literal in the candidate is one the file holds,
    // [`refuse_new_or_changed_literals`].)
    let sensitive =
        holds_api_block(&candidate) || holds_api_block(&on_disk) || holds_literal_api_key(&on_disk);
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

/// One edit of the config file AS IT IS NOW, through steps 4–7 of the module header: read it
/// (single-link, capped), parse it, apply `edit` to the parsed value, then [`save_value`] — the
/// human gates, the no-op check, the engine's `config validate`, the atomic replace with `.bak`.
///
/// ⚠ THE CALLER HOLDS [`ConfigSaver::lock`] AND HAS ALREADY CALLED
/// [`ConfigSaver::refuse_if_settings_removed`], and passes the config path it resolved under that
/// lock; this function takes no lock of its own, so a caller that must do something else under the
/// SAME lock (`calendar::calendar_link_remove` removes the link file first) can. An `Err` from
/// `edit` is returned as it is and nothing is written.
///
/// The shape [`config_offer_notify_auto`] always had, extracted when v0.3.0 (plan M8) added two more
/// callers — `calendar::calendar_config_save` (replace the `calendar` block) and
/// `calendar::calendar_link_remove` (drop one link's entry). Every OTHER field is preserved the way
/// every save preserves it: re-serialised by [`canonical_json`] in insertion order, values untouched.
pub(crate) async fn edit_config_at(
    client: &EngineClient,
    candidate_dir: &Path,
    path: &Path,
    edit: impl FnOnce(&mut Value) -> Result<(), SaveError>,
) -> Result<SaveOutcome, SaveError> {
    let current = read_existing(path)?;
    let mut candidate = parse_on_disk(path, &current)?;
    edit(&mut candidate)?;
    save_value(client, candidate_dir, path, &current, candidate).await
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

/// `pub(crate)` for `crate::calendar` (plan M8), whose config edits validate through the same
/// candidate directory.
pub(crate) fn candidate_dir<R: Runtime>(
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
    edit_config_at(client, &dir, &path, |candidate| {
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
        Ok(())
    })
    .await
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
/// Mode: owner-only (0600) when the candidate carries an `api` block — `provider.api`,
/// `initConfig`'s own rule for an API config, or any `fallbacks[i].api` (P3-M2-T2,
/// [`holds_api_block`]) — and 0644 otherwise. ⚠ 0644 is ABSOLUTE, not umask-filtered: `initConfig`'s
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
    // Final harden r2: refused before the candidate is staged (see `save_value`).
    if let Some(refused) = refuse_calendar_secret(&candidate) {
        return Ok(refused);
    }
    let report = validate(client, &dir, &text).await?;
    if !report.valid {
        return Ok(SaveOutcome::Invalid {
            errors: report.errors,
            warnings: report.warnings,
        });
    }
    let mode = if holds_api_block(&candidate) {
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

/* ── the candidate check (provider fallback PR 3, P3-M1-T2) ─────────────────────────────────────── */

/// What [`provider_candidate_check`] does with the candidate: `"validate"`, or
/// `{ "test": { "index": n, "testTimeoutMs": ms } }`. Closed: an unknown mode or an extra field is
/// refused by deserialisation, before anything runs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum CheckMode {
    /// `config validate --json --file <staged>`.
    Validate,
    /// `provider test --file <staged> --index <index> --json`. `test_timeout_ms` is the entry's
    /// `config validate` row `testTimeoutMs` (`docs/gui-seam.md` §1d), passed through unchanged —
    /// Rust adds nothing; [`Operation::timeout`] clamps it to between 17 s and the 30-minute cap.
    Test {
        index: u64,
        #[serde(rename = "testTimeoutMs")]
        test_timeout_ms: u64,
    },
}

/// What a candidate check answered. Tagged by `kind`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckOutcome {
    /// `config validate --json`'s report, VERBATIM — `valid`, `errors`, `warnings` and the
    /// `providers` rows (`testTimeoutMs`, `loopback`, `keyOptional`, `keyMoved`, `appOwnedKey`, `appKeyId`) the app reads instead of
    /// deciding them itself. An invalid candidate is a report with `valid: false`, not an error.
    Validated { report: Value },
    /// `provider test --json`'s one JSON line, VERBATIM — a pass or a failure (`ok: true`), or the
    /// engine's refusal (`ok: false`, `code`, …; switch on `code`, never on the exit status).
    /// `bound_ms` is the bound the app applied to the call (the row's value, clamped) —
    /// [`EngineClient::effective_timeout`], the value `invoke` enforces.
    #[serde(rename_all = "camelCase")]
    Tested { answer: Value, bound_ms: u64 },
    /// Refused before anything was staged: the candidate's `calendar` block holds a link address
    /// ([`CALENDAR_SECRET_ERROR`]), exactly as the save path answers it — or (PR 3 final r1) a
    /// literal key other than the placeholder ([`CHECK_LITERAL_KEY_ERROR`], field `apiKey`).
    Invalid {
        errors: Vec<FieldNote>,
        warnings: Vec<FieldNote>,
    },
}

/// Why a candidate check did not answer. Tagged by `kind`; every kind is one the webview's
/// `describeFailure` (`gui/src/lib/files.ts`) already words. Nothing was ever written to the config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckError {
    /// The candidate is not a JSON object.
    NotJson { detail: String },
    /// The candidate is larger than [`MAX_CONFIG_BYTES`] — refused before it is parsed, as a save
    /// refuses it.
    TooLarge { bytes: u64, limit: u64 },
    /// The candidate directory is unavailable or unusable.
    CandidateDir { detail: String },
    /// The mode's `index` is not one the engine accepts. Nothing was staged.
    InvalidInput { field: String, reason: String },
    /// Another state-changing engine operation (a Test, a briefing, …) is running; a Test is
    /// refused, not queued. Its staged file was removed.
    Busy { running: String },
    /// The engine did not answer within the bound and was stopped.
    Timeout { operation: String, seconds: u64 },
    /// The engine could not be run, crashed, or answered without a usable JSON reply — or the check
    /// was refused before anything was staged because Uninstall removed the settings in this app
    /// session (`detail` is then [`SETTINGS_REMOVED_BY_UNINSTALL`], the words a save refuses with).
    Engine { detail: String },
}

impl From<EngineError> for CheckError {
    fn from(e: EngineError) -> Self {
        match e {
            EngineError::InvalidInput { field, reason } => {
                CheckError::InvalidInput { field, reason }
            }
            EngineError::Busy { running } => CheckError::Busy { running },
            EngineError::Timeout { operation, seconds } => {
                CheckError::Timeout { operation, seconds }
            }
            other @ (EngineError::SidecarUnresolved { .. }
            | EngineError::Spawn { .. }
            | EngineError::Unsupported { .. }) => CheckError::Engine {
                detail: other.to_string(),
            },
        }
    }
}

/// The [`SaveError`]s the check's shared steps can produce ([`too_large`], [`candidate_dir`],
/// [`client_of`], [`ConfigSaver::refuse_if_settings_removed`]), as the check's own kinds.
impl From<SaveError> for CheckError {
    fn from(e: SaveError) -> Self {
        match e {
            SaveError::TooLarge { bytes, limit } => CheckError::TooLarge { bytes, limit },
            SaveError::NotJson { detail } => CheckError::NotJson { detail },
            SaveError::CandidateDir { detail } => CheckError::CandidateDir { detail },
            SaveError::Engine { detail } => CheckError::Engine { detail },
            // [`ConfigSaver::refuse_if_settings_removed`]: the save's words, unwrapped.
            SaveError::Unsupported { detail } => CheckError::Engine { detail },
            other => CheckError::Engine {
                detail: format!("{other:?}"),
            },
        }
    }
}

/// Validate or Test a CANDIDATE config — the Providers screen's "Check" and "Test" (P3-M1-T2) —
/// without saving it.
///
/// ⚠ THE SIGNATURE IS THE PATH GUARANTEE, as for [`config_save`]: JSON text and a closed mode, no
/// path. This is the ONLY route from the webview to `provider test --file`, which runs whatever
/// candidate it is handed — so the candidate file is one this command writes itself.
///
/// In order:
/// 1. **Refused before anything is staged**: a candidate over [`MAX_CONFIG_BYTES`] (before it is
///    parsed, as the save refuses it), one that is not a JSON object, one whose `calendar` block
///    holds a link address (`Invalid`, the save path's answer — the secret never reaches the
///    candidate directory), one holding a literal key other than [`REDACTED_API_KEY`] at any key
///    slot (`Invalid`, [`CHECK_LITERAL_KEY_ERROR`]; [`literal_key_errors`], PR 3 final r1), and a
///    Test `index` the engine would refuse.
/// 2. **Staged** under [`CHECK_PREFIX`] — never [`CANDIDATE_PREFIX`], which the save path's sweep
///    owns — as a private 0600 file in the 0700 candidate directory, after a sweep of that prefix
///    that removes only a DEAD writer's files ([`sweep_dead`]). `ConfigSaver`'s lock is held for
///    that sweep and the write ONLY, never across the engine call: the lock serialises every settings
///    write, and a Test can run for 80 s, or up to its 30-minute cap. Its first step under the lock
///    is the settings-removed latch ([`ConfigSaver::refuse_if_settings_removed`]), as every other
///    candidate-directory writer's is: after Uninstall's settings leg nothing is staged (so
///    `config-candidates/` is not re-created) and the engine is never asked, so a Test cannot write
///    into the state folder Uninstall cleared.
/// 3. **Run**: `config validate --json --file <staged>` (bounded at the engine read timeout; not
///    mutating, so it takes no in-flight guard and can run beside a Test), or `provider test --file
///    <staged> --index <n> --json` (MUTATING: a second Test while one runs is `Busy`; bounded by
///    the row's `testTimeoutMs`, clamped by [`Operation::timeout`]).
/// 4. **Removed** on every outcome ([`RemoveOnDrop`]): an answer, a refusal, a crash, an
///    unreadable reply, a timeout, `Busy`. Nothing is written to the real config.
///
/// ⚠ A LITERAL KEY'S PLACEHOLDER IS STAGED AS IT IS — AND IS THE ONLY LITERAL THAT IS. [`config_read`]
/// shows [`REDACTED_API_KEY`] in place of the value at every `apiKey` slot ([`redact`]); a candidate
/// carrying it is checked with the placeholder text, not the stored key (any other literal is
/// refused in step 1). Restoring it is the save path's step alone
/// ([`restore_api_key`]: same pointer, same unshared label, same kind and endpoint origin).
#[tauri::command]
pub async fn provider_candidate_check<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
    text: String,
    mode: CheckMode,
) -> Result<CheckOutcome, CheckError> {
    too_large(text.len())?;
    let candidate: Value = serde_json::from_str(&text).map_err(|e| CheckError::NotJson {
        detail: json_error_detail(&e),
    })?;
    if !candidate.is_object() {
        return Err(CheckError::NotJson {
            detail: "the top level is not an object".into(),
        });
    }
    if let Some(errors) =
        calendar_secret_errors(&candidate).or_else(|| literal_key_errors(&candidate))
    {
        return Ok(CheckOutcome::Invalid {
            errors,
            warnings: Vec::new(),
        });
    }
    // Exactly the bytes the calendar and key rules just read are what the engine reads.
    let text = canonical_json(&candidate);
    too_large(text.len())?;
    let test = match mode {
        CheckMode::Validate => None,
        CheckMode::Test {
            index,
            test_timeout_ms,
        } => {
            let index = provider_index(index).map_err(|r| CheckError::InvalidInput {
                field: "index".into(),
                reason: r.message().into(),
            })?;
            Some((index, test_timeout_ms))
        }
    };
    let client = client_of(&engine)?;
    let dir = candidate_dir(&app, &saver)?;
    let (_cleanup, file) = {
        let _staging = saver.lock.lock().await;
        saver.refuse_if_settings_removed()?;
        stage_candidate(&dir, CHECK_PREFIX, &text, |dir| {
            sweep_dead(dir, CHECK_PREFIX, &[".json"]);
        })
        .map_err(|detail| CheckError::CandidateDir { detail })?
    }; // ← the save lock is released HERE, before the engine is asked anything.
    match test {
        None => {
            let outcome = match tokio::time::timeout(
                ENGINE_READ_TIMEOUT,
                client.invoke(Operation::ConfigValidate { file }, &NoProgress),
            )
            .await
            {
                Ok(answer) => answer?,
                Err(_) => {
                    return Err(CheckError::Timeout {
                        operation: "config-validate".into(),
                        seconds: ENGINE_READ_TIMEOUT.as_secs(),
                    })
                }
            };
            match (&outcome.outcome, &outcome.payload) {
                (Outcome::Delivered, Some(report)) => Ok(CheckOutcome::Validated {
                    report: report.clone(),
                }),
                _ => Err(CheckError::Engine {
                    detail: failure_detail("config validate", &outcome),
                }),
            }
        }
        Some((index, test_timeout_ms)) => {
            let op = Operation::ProviderTest {
                file,
                index,
                test_timeout_ms,
            };
            let bound_ms = client
                .effective_timeout(&op)
                .map_or(0, |b| u64::try_from(b.as_millis()).unwrap_or(u64::MAX));
            let outcome = client.invoke(op, &NoProgress).await?;
            tested(outcome, bound_ms)
        }
    }
}

/// A `provider test --json` outcome as the check answers it: its JSON line whenever there is one
/// (`ok` a boolean — a refusal exits non-zero with one too), otherwise an engine error in words (a
/// crash prints no JSON line; never infer the refusal from the exit status, `docs/gui-seam.md` §1d).
fn tested(outcome: EngineOutcome, bound_ms: u64) -> Result<CheckOutcome, CheckError> {
    match &outcome.payload {
        Some(answer) if answer.get("ok").is_some_and(Value::is_boolean) => {
            Ok(CheckOutcome::Tested {
                answer: answer.clone(),
                bound_ms,
            })
        }
        _ => Err(CheckError::Engine {
            detail: failure_detail("provider test", &outcome),
        }),
    }
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &[
    "config_read",
    "config_save",
    "config_offer_notify_auto",
    "config_create",
    "provider_candidate_check",
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
        // P3-M1-T2: the save's sweep can never own a check's file, nor the check's a save's.
        assert!(!CHECK_PREFIX.starts_with(CANDIDATE_PREFIX));
        assert!(!CANDIDATE_PREFIX.starts_with(CHECK_PREFIX));
        assert_eq!(
            temp_owner("provider-check-9-3.json", CANDIDATE_PREFIX, &[".json"]),
            None
        );
        assert_eq!(
            temp_owner("candidate-9-3.json", CHECK_PREFIX, &[".json"]),
            None
        );
        assert_eq!(
            temp_owner("provider-check-9-3.json", CHECK_PREFIX, &[".json"]),
            Some(9)
        );
    }
}
