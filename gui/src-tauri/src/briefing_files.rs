//! T12/T13 — the two engine files the app READS: `briefing-latest.md` and
//! `briefings/<YYYY-MM-DD>.md`.
//!
//! ## What this module will and will not do
//!
//! * ⚠ **IT NEVER WRITES, RENAMES OR DELETES ANYTHING.** The dated archive is the engine's
//!   calibration corpus and its retention is deliberately unbounded (`src/marker.ts`,
//!   `archivedBriefingPath`: "~8 KB/day ≈ 3 MB/year … pruning it defeats the entire purpose"). Every
//!   filesystem call below is an `open` for reading or a `stat`. `tests/briefing_files.rs` hashes
//!   the whole state tree around a browse session to prove it, rather than trusting this sentence.
//! * ⚠ **THE WEBVIEW NEVER SUPPLIES A PATH.** [`read_latest_briefing`] takes nothing;
//!   [`read_archived_briefing`] takes a DATE, parsed into [`ArchiveDate`] — a newtype that cannot be
//!   constructed except by [`archive_date`], which admits exactly `YYYY-MM-DD` for a real calendar
//!   date. No separator, no dot and no other byte can reach the join, so traversal is unreachable by
//!   construction rather than caught afterwards. A refusal happens BEFORE any engine spawn.
//! * ⚠ **THE DIRECTORY COMES FROM THE ENGINE, NEVER FROM A RUST RECOMPUTATION.** Each read runs
//!   `status --json` and joins onto `paths.latestBriefingPath` / `paths.briefingsDir` — the engine's
//!   own two paths, so the file NAMES are not re-spelled here either (`src/json.ts`'s `StatePaths`
//!   docstring: one implementation of `stateDirFor`). The archive LIST is `status --json`'s
//!   `archivedDates` too, read by the webview; nothing here lists a directory.
//! * **Size cap** [`MAX_BRIEFING_BYTES`] (1 MiB; a briefing is ~8 KB). **UTF-8 required** — the
//!   engine writes a JS string with `Bun.write`, which is UTF-8, so anything else is not a briefing.
//! * ⚠ **SYMLINK POLICY: THE FINAL COMPONENT MUST NOT BE ONE.** The engine writes regular files
//!   (`Bun.write`), so a symlink named `briefing-latest.md` or `2026-09-16.md` is something else's,
//!   and following it would let the file under the state directory name any file on the machine.
//!   On unix the open itself carries `O_NOFOLLOW` (no check-then-open window) and `O_NONBLOCK` (a
//!   FIFO planted at the path would otherwise block the open forever); the opened descriptor must
//!   then be a regular file. The DIRECTORIES above it may be symlinks — a user may point
//!   `DAILY_BRIEFING_STATE_DIR` through one, and macOS's `/var` is one — which is the same trust the
//!   engine itself extends to them.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::engine::{Engine, EngineClient, EngineOutcome, NoProgress, Operation, Outcome};
use crate::schedule_state::{ScheduleView, StatePaths, StatusView};
use crate::shell::ENGINE_READ_TIMEOUT;

/// The largest briefing file the app will read. A briefing is ~8 KB; 1 MiB is two orders of
/// magnitude of headroom and still a bound.
pub const MAX_BRIEFING_BYTES: u64 = 1024 * 1024;

/* ── the date operand ─────────────────────────────────────────────────────────────────────────── */

/// A real calendar date spelled `YYYY-MM-DD`. Constructed only by [`archive_date`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveDate(String);

impl ArchiveDate {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Why a date operand was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateRefusal {
    /// Not exactly four ASCII digits, a dash, two digits, a dash, two digits.
    Shape,
    /// Year `0000`.
    Year,
    /// Month outside `01..=12`.
    Month,
    /// Day outside the month (`2026-02-30`, `2025-02-29`, `2026-04-31`, day `00`).
    Day,
}

impl DateRefusal {
    pub fn message(self) -> &'static str {
        match self {
            DateRefusal::Shape => {
                "is not a YYYY-MM-DD date (exactly ten characters: digits and two dashes)"
            }
            DateRefusal::Year => "has year 0000",
            DateRefusal::Month => "has a month outside 01-12",
            DateRefusal::Day => "names a day that month does not have",
        }
    }
}

fn is_leap(year: u32) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Parse an archive date, or say exactly why not.
///
/// ⚠ BYTES, NOT CHARS, AND EXACTLY TEN OF THEM. A length check on `chars()` would admit a
/// multi-byte digit look-alike in a ten-character string; checking ten BYTES that are each an ASCII
/// digit or one of the two dashes leaves nothing else expressible — no separator, no dot, no NUL,
/// no whitespace, no Unicode — so the one thing this value is ever joined onto cannot be escaped.
pub fn archive_date(value: &str) -> Result<ArchiveDate, DateRefusal> {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return Err(DateRefusal::Shape);
    }
    let digits = |range: std::ops::Range<usize>| -> Result<u32, DateRefusal> {
        let mut n = 0u32;
        for &c in &b[range] {
            if !c.is_ascii_digit() {
                return Err(DateRefusal::Shape);
            }
            n = n * 10 + u32::from(c - b'0');
        }
        Ok(n)
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    if year == 0 {
        return Err(DateRefusal::Year);
    }
    if !(1..=12).contains(&month) {
        return Err(DateRefusal::Month);
    }
    if day == 0 || day > days_in_month(year, month) {
        return Err(DateRefusal::Day);
    }
    Ok(ArchiveDate(value.to_string()))
}

/// `<briefingsDir>/<date>.md`. The date carries no separator by construction.
pub fn archived_path(briefings_dir: &Path, date: &ArchiveDate) -> PathBuf {
    briefings_dir.join(format!("{}.md", date.as_str()))
}

/* ── the capped, no-follow read ───────────────────────────────────────────────────────────────── */

/// Why a file could not be read as a briefing (or, for `config_save`, as a config).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadRefusal {
    NotFound,
    /// The final path component is a symbolic link. See the module header.
    Symlink,
    /// A directory, a FIFO, a socket, a device.
    NotAFile,
    /// Larger than the cap. `bytes` is what `fstat` reported (or cap + 1 if it grew mid-read).
    TooLarge {
        bytes: u64,
    },
    /// More than one directory entry names this file (`nlink > 1`). Only the CONFIG read refuses
    /// this ([`read_single_link_text_capped`]): an atomic save replaces one NAME, which would
    /// silently detach every other name for the same file — the symlink problem, by another route.
    HardLinked {
        links: u64,
    },
    NotUtf8,
    Io(String),
}

impl ReadRefusal {
    pub fn describe(&self, path: &Path, cap: u64) -> String {
        let p = path.display();
        match self {
            ReadRefusal::NotFound => format!("{p} does not exist"),
            ReadRefusal::Symlink => format!(
                "{p} is a symbolic link; Daily Briefing only reads the regular file the engine \
                 writes there"
            ),
            ReadRefusal::NotAFile => format!("{p} is not a regular file"),
            ReadRefusal::TooLarge { bytes } => {
                format!("{p} is {bytes} bytes, over the {cap}-byte limit")
            }
            ReadRefusal::HardLinked { links } => format!(
                "{p} has {links} hard links; Daily Briefing will not replace a file that other names \
                 share, because an atomic save would detach them"
            ),
            ReadRefusal::NotUtf8 => format!("{p} is not UTF-8 text"),
            ReadRefusal::Io(e) => format!("{p} could not be read: {e}"),
        }
    }
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> Result<std::fs::File, ReadRefusal> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) => ReadRefusal::Symlink,
            Some(libc::ENOENT) => ReadRefusal::NotFound,
            _ => ReadRefusal::Io(e.to_string()),
        })
}

/// Off unix there is no `O_NOFOLLOW`; the check and the open are two calls. Windows is labelled
/// experimental by the engine's own scheduling surface, and this is recorded in the seam doc.
#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> Result<std::fs::File, ReadRefusal> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => return Err(ReadRefusal::Symlink),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadRefusal::NotFound),
        Err(e) => return Err(ReadRefusal::Io(e.to_string())),
    }
    std::fs::File::open(path).map_err(|e| ReadRefusal::Io(e.to_string()))
}

/// Read `path` as UTF-8 text of at most `cap` bytes, refusing a symlink or a non-regular file.
/// **Read-only** — the one filesystem call that opens anything opens it for reading.
pub fn read_text_capped(path: &Path, cap: u64) -> Result<String, ReadRefusal> {
    read_capped(path, cap, false)
}

/// [`read_text_capped`], and also refuse a file with more than one link
/// ([`ReadRefusal::HardLinked`]). The config save path reads through this: it REPLACES the file.
pub fn read_single_link_text_capped(path: &Path, cap: u64) -> Result<String, ReadRefusal> {
    read_capped(path, cap, true)
}

fn read_capped(path: &Path, cap: u64, single_link: bool) -> Result<String, ReadRefusal> {
    let file = open_no_follow(path)?;
    let meta = file
        .metadata()
        .map_err(|e| ReadRefusal::Io(e.to_string()))?;
    if !meta.is_file() {
        return Err(ReadRefusal::NotAFile);
    }
    #[cfg(unix)]
    if single_link {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() > 1 {
            return Err(ReadRefusal::HardLinked {
                links: meta.nlink(),
            });
        }
    }
    #[cfg(not(unix))]
    let _ = single_link;
    if meta.len() > cap {
        return Err(ReadRefusal::TooLarge { bytes: meta.len() });
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    // `take(cap + 1)`: a file that GREW between the stat and the read is still bounded, and the
    // extra byte is how the growth is noticed.
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ReadRefusal::Io(e.to_string()))?;
    if bytes.len() as u64 > cap {
        return Err(ReadRefusal::TooLarge { bytes: cap + 1 });
    }
    String::from_utf8(bytes).map_err(|_| ReadRefusal::NotUtf8)
}

/* ── the latest page's canonical v1 identity ────────────────────────────────────────────────── */

/// Decimal fields are strings so canonical formatting never loses integer precision.
pub struct PageVersionFields<'a> {
    pub platform: &'a str,
    pub volume: &'a str,
    pub file_id: &'a str,
    pub size: &'a str,
    pub mtime_ns: &'a str,
    pub ctime_ns: &'a str,
}

/// The same seven fields and final LF as `src/summary/page-version.ts`.
pub fn canonical_page_version(fields: &PageVersionFields<'_>) -> Option<String> {
    let unsigned = |value: &str| {
        value == "0"
            || (value
                .as_bytes()
                .first()
                .is_some_and(|b| matches!(b, b'1'..=b'9'))
                && value.bytes().all(|b| b.is_ascii_digit()))
    };
    let signed = |value: &str| {
        unsigned(value)
            || value
                .strip_prefix('-')
                .is_some_and(|v| v != "0" && unsigned(v))
    };
    let file_id_ok = match fields.platform {
        "unix" => unsigned(fields.file_id),
        "windows" => {
            fields.file_id.len() == 32
                && fields
                    .file_id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        }
        _ => false,
    };
    if !file_id_ok
        || !unsigned(fields.volume)
        || !unsigned(fields.size)
        || !signed(fields.mtime_ns)
        || !signed(fields.ctime_ns)
    {
        return None;
    }
    Some(format!(
        "summary-page-v1\n{}\n{}\n{}\n{}\n{}\n{}\n",
        fields.platform,
        fields.volume,
        fields.file_id,
        fields.size,
        fields.mtime_ns,
        fields.ctime_ns,
    ))
}

pub fn page_version_for(fields: &PageVersionFields<'_>) -> Option<String> {
    canonical_page_version(fields)
        .map(|canonical| format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

/// FILE_ID_128 in array-byte order, including leading zero bytes; never GUID order.
pub fn windows_file_id(bytes: &[u8]) -> Option<String> {
    (bytes.len() == 16).then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Native FILETIME ticks (100 ns) in exact wide arithmetic, up to the unsigned 64-bit boundary.
pub fn windows_ticks_to_unix_ns(ticks: u64) -> String {
    ((i128::from(ticks) - 116_444_736_000_000_000) * 100).to_string()
}

#[cfg(unix)]
fn metadata_page_version(meta: &std::fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    page_version_for(&PageVersionFields {
        platform: "unix",
        volume: &meta.dev().to_string(),
        file_id: &meta.ino().to_string(),
        size: &meta.len().to_string(),
        mtime_ns: &(i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()))
            .to_string(),
        ctime_ns: &(i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()))
            .to_string(),
    })
}

// Open question 3 (a): without a reliable native identity, summaries are unavailable.
#[cfg(not(unix))]
fn metadata_page_version(_meta: &std::fs::Metadata) -> Option<String> {
    None
}

/// The page version `before` gives, only if the read stayed on that one unchanged file: every
/// byte `before` promised was read, the opened file still matches it, and the path still names it.
pub fn stable_page_version(
    before: &std::fs::Metadata,
    read_len: u64,
    after: Option<&std::fs::Metadata>,
    current: Option<&std::fs::Metadata>,
) -> Option<String> {
    let version = metadata_page_version(before)?;
    let same_file = |meta: Option<&std::fs::Metadata>| {
        meta.is_some_and(|m| {
            m.is_file() && metadata_page_version(m).as_deref() == Some(version.as_str())
        })
    };
    (read_len == before.len() && same_file(after) && same_file(current)).then_some(version)
}

/// Read the page once; an unstable identity leaves the ordinary page usable without a summary.
/// `read_capped` stays unchanged because config saves and archived reads share it.
fn read_latest_capped(path: &Path) -> Result<(String, Option<(String, String)>), ReadRefusal> {
    let file = open_no_follow(path)?;
    let before = file
        .metadata()
        .map_err(|e| ReadRefusal::Io(e.to_string()))?;
    if !before.is_file() {
        return Err(ReadRefusal::NotAFile);
    }
    if before.len() > MAX_BRIEFING_BYTES {
        return Err(ReadRefusal::TooLarge {
            bytes: before.len(),
        });
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    (&file)
        .take(MAX_BRIEFING_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| ReadRefusal::Io(e.to_string()))?;
    if bytes.len() as u64 > MAX_BRIEFING_BYTES {
        return Err(ReadRefusal::TooLarge {
            bytes: MAX_BRIEFING_BYTES + 1,
        });
    }
    let after = file.metadata().ok();
    let current = std::fs::symlink_metadata(path).ok();
    let identity = stable_page_version(
        &before,
        bytes.len() as u64,
        after.as_ref(),
        current.as_ref(),
    )
    .map(|version| (format!("{:x}", Sha256::digest(&bytes)), version));
    let text = String::from_utf8(bytes).map_err(|_| ReadRefusal::NotUtf8)?;
    Ok((text, identity))
}

/// Latest-page read with identity from that same descriptor, never a second page read.
pub fn read_latest_briefing_at(path: &Path) -> Result<BriefingFile, BriefingError> {
    match read_latest_capped(path) {
        Ok((text, identity)) => {
            let (page_hash, page_version) = match identity {
                Some((hash, version)) => (Some(hash), Some(version)),
                None => (None, None),
            };
            Ok(BriefingFile {
                path: path.display().to_string(),
                bytes: text.len() as u64,
                text,
                page_hash,
                page_version,
            })
        }
        Err(ReadRefusal::NotFound) => Err(BriefingError::NotFound {
            path: path.display().to_string(),
        }),
        Err(refusal) => Err(BriefingError::Unreadable {
            path: path.display().to_string(),
            detail: refusal.describe(path, MAX_BRIEFING_BYTES),
        }),
    }
}

/* ── what the webview receives ────────────────────────────────────────────────────────────────── */

/// One briefing file, as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingFile {
    /// The path read — the engine's, for display. The webview never sends it back.
    pub path: String,
    /// The file's bytes, verbatim. ⚠ UNTRUSTED: git-derived text the engine only control-stripped
    /// (`src/render.ts`, `stripControl`). The webview renders it through the escape-first renderer.
    pub text: String,
    pub bytes: u64,
    /// Latest-page identity only; History's wire result remains unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_version: Option<String>,
}

/// Why a read failed. Tagged by `kind`, like `EngineError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BriefingError {
    /// The date operand was refused. **No process was created and no file was opened.**
    InvalidDate { reason: String },
    /// `status --json` could not be run or did not say where the files are.
    Engine { detail: String },
    /// The dated file is not there (the list and the directory disagree, or it was just removed).
    NotFound { path: String },
    /// Symlink, non-regular file, over the cap, not UTF-8, or an I/O error. `detail` says which.
    Unreadable { path: String, detail: String },
}

/// Read one briefing file at a path the ENGINE named. Pure over the filesystem; read-only.
pub fn read_briefing_at(path: &Path) -> Result<BriefingFile, BriefingError> {
    match read_text_capped(path, MAX_BRIEFING_BYTES) {
        Ok(text) => Ok(BriefingFile {
            path: path.display().to_string(),
            bytes: text.len() as u64,
            text,
            page_hash: None,
            page_version: None,
        }),
        Err(ReadRefusal::NotFound) => Err(BriefingError::NotFound {
            path: path.display().to_string(),
        }),
        Err(refusal) => Err(BriefingError::Unreadable {
            path: path.display().to_string(),
            detail: refusal.describe(path, MAX_BRIEFING_BYTES),
        }),
    }
}

/* ── the engine's paths ───────────────────────────────────────────────────────────────────────── */

/// Run `status --json` and return the engine's state paths.
///
/// ⚠ THROUGH THE SAME CLIENT, WITH THE SAME 30 s READ TIMEOUT, AS THE WATCHER'S READS
/// ([`ENGINE_READ_TIMEOUT`]); `NoProgress`, because a status read's stderr is not a run's progress.
/// Shared with `config_save`, which needs `paths.configPath` from the same envelope.
pub async fn engine_paths(client: &EngineClient) -> Result<StatePaths, String> {
    let outcome = match tokio::time::timeout(
        ENGINE_READ_TIMEOUT,
        client.invoke(Operation::Status, &NoProgress),
    )
    .await
    {
        Err(_) => return Err("`status --json` did not answer in time and was stopped".into()),
        Ok(Err(e)) => return Err(e.to_string()),
        Ok(Ok(outcome)) => outcome,
    };
    let ok = matches!(
        outcome.outcome,
        Outcome::Delivered | Outcome::Skipped { .. }
    );
    let payload = match (ok, &outcome.payload) {
        (true, Some(payload)) => payload.clone(),
        _ => return Err(failure_detail("status --json", &outcome)),
    };
    let view: StatusView = serde_json::from_value(payload)
        .map_err(|e| format!("`status --json` printed an envelope this app cannot read: {e}"))?;
    Ok(view.paths)
}

/// Run `schedule status --json` and return the engine's schedule facts — Uninstall's second read
/// (spec 3.3.1).
///
/// ⚠ `Err` IS "STATUS UNREADABLE", AND IT IS NOT AN ALL-DEFAULT VIEW. A read that failed, timed out
/// or printed an envelope this app cannot parse is an error here, never `ScheduleView::default()`:
/// the default says "the check ran and reported nothing", and Uninstall's detection (spec 3.3.3)
/// must be able to tell that from "the check could not be read".
///
/// Through the same client and the same 30 s [`ENGINE_READ_TIMEOUT`] as [`engine_paths`], by way of
/// `access::read_envelope`, which the access panel and the CLI shim already use for this envelope —
/// so there is one read path for it, not a third copy of the timeout-and-classify step.
pub async fn engine_schedule_view(client: &EngineClient) -> Result<ScheduleView, String> {
    let payload = crate::access::read_envelope(client, Operation::ScheduleStatus).await?;
    serde_json::from_value(payload).map_err(|e| {
        format!("`schedule status --json` printed an envelope this app cannot read: {e}")
    })
}

/// One sentence for an engine read that did not yield a usable envelope — shared by `status --json`
/// here and `config validate` in `config_save`, so both say the same thing the same way.
///
/// ⚠ HUMAN WORDING, NOT `Debug`. An exit-0 reply that is not JSON used to read "failed (exit
/// Some(0))" — a Rust `Option` printed at a user.
pub fn failure_detail(command: &str, outcome: &EngineOutcome) -> String {
    let what = match (&outcome.outcome, outcome.exit_code) {
        (Outcome::Failed { reason: Some(r) }, Some(0)) if r == "malformed-json" => {
            format!("`{command}` finished but did not print the JSON answer this app expects")
        }
        (_, Some(0)) => format!("`{command}` finished without a usable answer"),
        (_, Some(code)) => format!("`{command}` failed with exit status {code}"),
        (_, None) => format!("`{command}` was stopped by a signal"),
    };
    let stderr = outcome.stderr.trim_end();
    if stderr.is_empty() {
        format!("{what} and wrote nothing to stderr")
    } else {
        format!("{what}: {stderr}")
    }
}

/// An engine-reported path, required to be present and absolute.
///
/// `source` names the command that answered and `field` the field AS THAT ENVELOPE SPELLS IT
/// (round 1: this helper used to hardcode `` `status --json` `` and a `paths.` prefix, so a
/// missing `binPath` — top-level in the `schedule status --json` envelope — was reported as a
/// `paths.binPath` that no envelope has ever carried).
pub fn absolute(source: &str, field: &str, value: Option<&String>) -> Result<PathBuf, String> {
    match value.map(String::as_str) {
        Some(p) if Path::new(p).is_absolute() => Ok(PathBuf::from(p)),
        Some(p) => Err(format!(
            "`{source}` reported a relative `{field}` ({p:?}); refusing to resolve it \
             against this app's working directory"
        )),
        None => Err(format!("`{source}` did not report `{field}`")),
    }
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// `briefing-latest.md`, or `None` when the engine has not written one yet.
///
/// One `status --json` per call. The Today screen calls it when `latestBriefingMtime` in the pushed
/// snapshot changes (and on mount), not on every `state:changed`.
#[tauri::command]
pub async fn read_latest_briefing(
    engine: State<'_, Engine>,
) -> Result<Option<BriefingFile>, BriefingError> {
    let client = engine.client().map_err(|e| BriefingError::Engine {
        detail: e.to_string(),
    })?;
    let paths = engine_paths(client)
        .await
        .map_err(|detail| BriefingError::Engine { detail })?;
    let path = absolute(
        "status --json",
        "paths.latestBriefingPath",
        paths.latest_briefing_path.as_ref(),
    )
    .map_err(|detail| BriefingError::Engine { detail })?;
    match read_latest_briefing_at(&path) {
        Ok(file) => Ok(Some(file)),
        Err(BriefingError::NotFound { .. }) => Ok(None),
        Err(e) => Err(e),
    }
}

/// `briefings/<date>.md`. The date is validated BEFORE the engine is asked anything.
#[tauri::command]
pub async fn read_archived_briefing(
    engine: State<'_, Engine>,
    date: String,
) -> Result<BriefingFile, BriefingError> {
    let date = archive_date(&date).map_err(|r| BriefingError::InvalidDate {
        reason: r.message().to_string(),
    })?;
    let client = engine.client().map_err(|e| BriefingError::Engine {
        detail: e.to_string(),
    })?;
    let paths = engine_paths(client)
        .await
        .map_err(|detail| BriefingError::Engine { detail })?;
    let dir = absolute(
        "status --json",
        "paths.briefingsDir",
        paths.briefings_dir.as_ref(),
    )
    .map_err(|detail| BriefingError::Engine { detail })?;
    read_briefing_at(&archived_path(&dir, &date))
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["read_latest_briefing", "read_archived_briefing"];
