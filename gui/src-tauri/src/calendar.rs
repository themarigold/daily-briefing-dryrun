//! v0.3.0 (calendar connection, plan M8) — the Rust side of a calendar LINK: the managed link-file
//! writer, link removal, and the `calendar` config block save.
//!
//! ## Why Rust writes the link file, not the engine
//!
//! A private calendar link's URL is a SECRET (spec r4 §2): it never appears in `config.json`, and
//! the engine reads it from a managed file, `<state>/calendar/links/<id>.url`. The engine's own
//! `calendar add-link` takes the URL on STDIN — and every spawn this app makes has no stdin
//! (`engine.rs`, `stdin(null())`), while an argv operand would put the secret in the process
//! table. So the app writes the file itself (spec §8: "The Rust side writes the managed link file
//! itself"), and the engine then judges it with `calendar test` (`engine::Operation::CalendarTest`).
//! **The engine is the authority on what a link may be**; the checks here are the minimum that
//! keeps a wrong value out of the file and out of the config.
//!
//! ## The three commands
//!
//!   * [`calendar_link_write`] — `id` + `url` in; writes `<state>/calendar/links/<id>.url` (the
//!     config entry is [`calendar_config_save`]'s: spec §8's Settings flow writes the file, then saves
//!     the block). Its one config edit: a DIFFERENT URL replacing an existing one first removes that
//!     link's `confirmedOwner`, so a replaced link never inherits a confirmation (spec §4.2).
//!     `<state>` is the ENGINE's answer (`status --json` → `paths.stateDir`), never a webview
//!     operand and never recomputed here.
//!   * [`calendar_link_remove`] — `id` in; removes the link file AND the link's entry in
//!     `calendar.links`, under one hold of the save lock.
//!   * [`calendar_config_save`] — the `calendar` block's JSON text in; replaces that one key through
//!     the app's ONE config-write path (`config_save::edit_config_at` — the engine's
//!     `config validate`, the atomic replace with `.bak`, every other field preserved as every save
//!     preserves it). The block is first held to the engine resolver's own acceptance rules
//!     ([`check_calendar_block`]): that resolver is all-or-nothing, and a `config validate` warning
//!     does not block a save, so a block it would call malformed must never be written. No `base` token: like the Quit dialog's `notify` offer, it is a one-key edit of
//!     the file AS IT IS NOW, under the save lock, so an edit elsewhere in the file is never lost —
//!     only a hand edit of the `calendar` block itself, made while Settings was open, is replaced.
//!
//! All three hold [`ConfigSaver`]'s lock and honour its "settings removed by Uninstall" latch, so
//! they serialise with every settings write and nothing re-creates a link file or a calendar block
//! after Uninstall's settings leg. (Residual: Uninstall's ENGINE-data leg removes `<state>/calendar/`
//! without that lock — `uninstall::ENGINE_STATE_REMOVALS` — so a link written in the same instant
//! could survive it; the app is being uninstalled, and the next Uninstall removes it.)
//!
//! ## What the link file is, exactly
//!
//!   * **The folder** `<state>/calendar/links/` is created 0700 when missing and must then be a REAL
//!     directory (not a symlink), owned by this user, with NO group or other permission bits — a
//!     symlinked, foreign-owned or loose folder is REFUSED, never repaired (spec §2, which the
//!     engine's reader enforces too). Its parent `<state>/calendar/` must be a real directory owned
//!     by this user and not world-writable; it is not required to be 0700, because the engine may
//!     create it for the health file and the helper copy with an ordinary umask. ⚠ That parent can
//!     therefore be GROUP-writable (0775 under a umask of 002) — and on macOS the primary group is
//!     `staff`, shared by every account on the Mac, not a private group (M8 checkpoint, LOW). A group
//!     member can rename entries in it, but cannot read a link: the protection is `links/` itself —
//!     refused unless it is a real folder owned by this user with no group or other bit — and each
//!     file's own 0600. Anything planted in place of `links/` (another user's folder, a symlink) fails
//!     that check, and is never written through or read. `<state>` itself may be a symlink, as the
//!     briefing reads allow (`briefing_files.rs` module header).
//!   * **The file** is the URL's bytes exactly — trimmed of surrounding whitespace, no trailing
//!     newline — mode 0600, written to a temp file of this module's own naming in the SAME folder
//!     (`O_CREAT|O_EXCL`, so a planted symlink at the temp name fails the create rather than being
//!     followed — `config_save::write_new_file`), `fsync`ed, then `rename`d over `<id>.url`, then the
//!     folder `fsync`ed: a reader sees the old URL or the new one, never a partial one. A symlink, a
//!     directory or any other non-regular file already AT `<id>.url` is refused, not replaced.
//!   * **At most [`MAX_LINKS`]** link files: writing a NEW id when ten other link files exist is
//!     refused; replacing an existing id's URL is not a new link.
//!
//! ## The URL never leaks
//!
//! [`LinkUrl`] has no `Display`, no `Serialize`, and a `Debug` that prints `<redacted>`. No error,
//! no returned value and no log line carries it: refusals name the CLASS of problem only
//! ([`UrlRefusal::message`]), and the link id is echoed only once it has passed the id grammar (a
//! URL pasted into the id field is refused without being repeated). This module prints nothing at
//! all — `tests/calendar.rs` pins that over the comment-stripped source, and drives a sentinel URL
//! through every refusal and the success path asserting it appears in no answer.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Runtime, State};

use crate::briefing_files::{absolute, engine_paths, read_text_capped};
use crate::config_save::{
    self, json_error_detail, ConfigSaver, FieldNote, SaveError, SaveOutcome, MAX_CONFIG_BYTES,
};
use crate::engine::{is_refused_format_character, Engine, EngineClient};

/* ── the bounds ───────────────────────────────────────────────────────────────────────────────── */

/// At most this many links (spec §2). Enforced on the link files ([`write_link_file_as`]) and on the
/// config block ([`check_calendar_block`]).
pub const MAX_LINKS: usize = 10;

/// The id grammar's length ceiling: `^[a-z0-9][a-z0-9-]{0,31}$` is one leading character plus 31.
pub const MAX_LINK_ID_CHARS: usize = 32;

/// Ids that pass the grammar and are still refused. `macos` is the Mac Calendar app source's own id
/// (M0's contract, `src/calendar/types.ts`: `CalendarSourceKind` / the `macos` source in every
/// status line), which the engine reserves too — a link with that id would collide with it.
pub const RESERVED_LINK_IDS: &[&str] = &["macos"];

/// The URL's length ceiling, in bytes after trimming. Real private links are short (a Google secret
/// address is ~150 bytes, an Outlook published ICS link ~300); this is a bound, not a measurement.
pub const MAX_LINK_URL_BYTES: usize = 4096;

/// `<state>/calendar` — the engine's calendar folder (link files, the helper copy, its run folder,
/// the health file). Uninstall removes it whole (`uninstall::ENGINE_STATE_REMOVALS`).
pub const CALENDAR_DIR: &str = "calendar";

/// `<state>/calendar/links` — the managed link files' folder.
pub const LINKS_DIR: &str = "links";

/// `<id>.url`.
pub const LINK_FILE_SUFFIX: &str = ".url";

/// The prefix of this module's temp files in the links folder: `.link-save-<pid>-<seq>`. It starts
/// with a dot, so no temp name can ever pass the id grammar and be read as a link.
pub const LINK_TEMP_PREFIX: &str = ".link-save-";

/* ── the link id ──────────────────────────────────────────────────────────────────────────────── */

/// A link id that passed the grammar and is not reserved. Constructed only by [`link_id`]; it is the
/// only part of a link used in a file name, so it can carry no separator, dot or other byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkId(String);

impl LinkId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Why a link id was refused. The messages never echo the value: a URL pasted into the id field is
/// exactly the mistake this refusal catches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkIdRefusal {
    Empty,
    /// The first character is not `a-z` or `0-9`.
    BadFirstCharacter,
    /// A later character is not `a-z`, `0-9` or `-`.
    BadCharacter,
    /// Longer than [`MAX_LINK_ID_CHARS`].
    TooLong,
    /// One of [`RESERVED_LINK_IDS`].
    Reserved,
}

impl LinkIdRefusal {
    pub fn message(self) -> &'static str {
        match self {
            LinkIdRefusal::Empty => "is empty",
            LinkIdRefusal::BadFirstCharacter => "must start with a lowercase letter or a digit",
            LinkIdRefusal::BadCharacter => "may contain only lowercase letters, digits and dashes",
            LinkIdRefusal::TooLong => "is longer than 32 characters",
            LinkIdRefusal::Reserved => {
                "is reserved: \"macos\" is the Mac Calendar app's own source id"
            }
        }
    }
}

/// Parse a link id: `^[a-z0-9][a-z0-9-]{0,31}$`, and not reserved (spec §2; the CLI enforces the
/// same grammar). Bytes, not chars: every admitted byte is ASCII, so a multi-byte look-alike fails
/// the character class rather than slipping past a `chars()` count.
pub fn link_id(value: &str) -> Result<LinkId, LinkIdRefusal> {
    let bytes = value.as_bytes();
    let Some(&first) = bytes.first() else {
        return Err(LinkIdRefusal::Empty);
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err(LinkIdRefusal::BadFirstCharacter);
    }
    if !bytes[1..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
    {
        return Err(LinkIdRefusal::BadCharacter);
    }
    if bytes.len() > MAX_LINK_ID_CHARS {
        return Err(LinkIdRefusal::TooLong);
    }
    if RESERVED_LINK_IDS.contains(&value) {
        return Err(LinkIdRefusal::Reserved);
    }
    Ok(LinkId(value.to_string()))
}

/* ── the link URL ─────────────────────────────────────────────────────────────────────────────── */

/// A link URL that passed the minimal sanity check. Constructed only by [`link_url`].
///
/// ⚠ DELIBERATELY NO `Display`, NO `Serialize`, AND A `Debug` THAT PRINTS `<redacted>`: the value is
/// a secret, and its bytes go to two places only: the link file ([`write_link_file_as`]), and — for
/// a command-sourced link's URL remembered by the live details read (briefing redesign C) — the
/// sealed STDIN handback, through [`link_url_bytes`], whose one caller is `calendar_details.rs`'s
/// snapshot (`tests/calendar_details.rs` pins both).
pub struct LinkUrl(String);

impl std::fmt::Debug for LinkUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LinkUrl(<redacted>)")
    }
}

impl LinkUrl {
    fn bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

/// A remembered URL's bytes, for the live details read's handback snapshot — its ONE caller
/// (`calendar_details.rs`, `handback_buffer`; pinned). Crate-visible, never `pub`.
pub(crate) fn link_url_bytes(u: &LinkUrl) -> &[u8] {
    u.bytes()
}

/// Why a URL was refused. The messages name the class of problem and never the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlRefusal {
    Empty,
    /// Longer than [`MAX_LINK_URL_BYTES`] after trimming.
    TooLong,
    /// Whitespace inside the URL (surrounding whitespace is trimmed, not refused).
    Whitespace,
    /// A control character (`char::is_control`).
    ControlCharacter,
    /// A Unicode format character — `engine::REFUSED_FORMAT_CHARACTERS`, the operand validators'
    /// list, reused rather than re-spelled.
    FormatCharacter,
    /// Not `https://` or `webcal://` (case-insensitive).
    Scheme,
    /// Nothing between `://` and the first `/`, `?` or `#`.
    NoHost,
}

impl UrlRefusal {
    pub fn message(self) -> &'static str {
        match self {
            UrlRefusal::Empty => "is empty",
            UrlRefusal::TooLong => "is longer than 4096 bytes",
            UrlRefusal::Whitespace => "contains whitespace",
            UrlRefusal::ControlCharacter => "contains a control character",
            UrlRefusal::FormatCharacter => {
                "contains an invisible Unicode format character (a bidi override, a zero-width \
                 space or joiner, or a byte-order mark)"
            }
            UrlRefusal::Scheme => "must start with https:// or webcal://",
            UrlRefusal::NoHost => "has no host name after the scheme",
        }
    }
}

/// `value` starts with `prefix`, ASCII-case-insensitively. `get` rather than slicing, so a prefix
/// length that falls inside a multi-byte character is "no" rather than a panic.
fn starts_with_ignore_case(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// The minimal Rust-side check on a pasted URL (plan M8): surrounding whitespace trimmed (a paste's
/// trailing newline), then non-empty, at most [`MAX_LINK_URL_BYTES`], no whitespace, control or
/// format character inside, an `https://` or `webcal://` scheme, and a non-empty host. Everything
/// else — the default port, userinfo, redirects, what the host serves — is the ENGINE's to judge
/// (`calendar test`, spec §4.2), and is not second-guessed here.
pub fn link_url(value: &str) -> Result<LinkUrl, UrlRefusal> {
    let url = value.trim();
    if url.is_empty() {
        return Err(UrlRefusal::Empty);
    }
    if url.len() > MAX_LINK_URL_BYTES {
        return Err(UrlRefusal::TooLong);
    }
    if url.chars().any(char::is_whitespace) {
        return Err(UrlRefusal::Whitespace);
    }
    if url.chars().any(char::is_control) {
        return Err(UrlRefusal::ControlCharacter);
    }
    if url.chars().any(is_refused_format_character) {
        return Err(UrlRefusal::FormatCharacter);
    }
    let rest = if starts_with_ignore_case(url, "https://") {
        &url["https://".len()..]
    } else if starts_with_ignore_case(url, "webcal://") {
        &url["webcal://".len()..]
    } else {
        return Err(UrlRefusal::Scheme);
    };
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if host_end == 0 {
        return Err(UrlRefusal::NoHost);
    }
    Ok(LinkUrl(url.to_string()))
}

/* ── wire types ───────────────────────────────────────────────────────────────────────────────── */

/// What [`calendar_link_write`] did. Never the URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkWritten {
    pub id: String,
    /// `<state>/calendar/links/<id>.url`, for display.
    pub path: String,
    /// True when a previous URL for this id was replaced.
    pub replaced: bool,
    /// True when the config's `confirmedOwner` for this id was removed first, because a DIFFERENT
    /// URL replaced the one it confirmed ([`clear_confirmed_owner`]). The user confirms again; the
    /// webview then saves the block with the new confirmation.
    pub confirmation_cleared: bool,
}

/// What happened to one link file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileRemoval {
    Removed,
    /// Nothing was at the name (or no links folder exists) — removal is idempotent.
    Absent,
}

/// What [`calendar_link_remove`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRemoved {
    pub id: String,
    pub file: FileRemoval,
    /// The config step's answer — `unchanged` when the config held no entry for this id. `None`
    /// when there is no config file at all, so there was nothing to edit.
    pub config: Option<SaveOutcome>,
}

/// Why a calendar command did not do what it was asked. Tagged by `kind`, like `EngineError` and
/// `SaveError`. No variant carries a URL, and none carries a link id that failed the grammar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CalendarError {
    /// The link id was refused. **Nothing was spawned, read or written.**
    InvalidId { reason: String },
    /// The URL was refused by the minimal check ([`link_url`]). **Nothing was spawned or written.**
    InvalidUrl { reason: String },
    /// The `calendar` block was refused before the engine saw it: not a JSON object, `links` not a
    /// list, a link not an object. `reason` names the field by position, never a value.
    InvalidBlock { reason: String },
    /// Two links in the block share an id (which passed the grammar, so it can be named).
    DuplicateId { id: String },
    /// A key spelled `url` (any letter case), a `://` scheme inside a link's `name` / `owner` or an
    /// `emails` entry, or a URL-shaped `urlCommand` argument: a link URL is about to land in
    /// `config.json`, where it must never be (spec §2). `field` is a fixed schema position
    /// (`links[2].name`, `links[2]`, `macos`), never a value and never the user's own key text.
    UrlInConfig { field: String },
    /// More than [`MAX_LINKS`] links — in the block, or as link files on disk.
    TooManyLinks { limit: usize },
    /// The engine could not say where its state folder is (`status --json`).
    Engine { detail: String },
    /// `<state>/calendar` or `<state>/calendar/links` is refused (a symlink, not a directory,
    /// another user's, too loose) or could not be created or listed.
    LinkFolder { path: String, detail: String },
    /// A non-regular file sits at `<id>.url` (refused, untouched), or writing / removing failed.
    LinkFile { path: String, detail: String },
    /// The config step refused or failed — the save pipeline's own error, verbatim (including
    /// `unsupported` once Uninstall has removed the settings).
    Config { error: SaveError },
    /// [`calendar_link_write`] had to remove a stale `confirmedOwner` from the config BEFORE putting
    /// a different URL in place, and the engine refused the config that edit produced (it was
    /// already invalid for another reason). **Nothing was written** — not the config, not the link
    /// file — so the old URL and its confirmation still stand together.
    ConfigInvalid {
        errors: Vec<FieldNote>,
        warnings: Vec<FieldNote>,
    },
    /// [`calendar_link_remove`] dealt with the link file (`removed` says how), and THEN the config
    /// step failed: the file is gone (or was never there) but the entry is still in the config.
    ConfigAfterRemoval {
        removed: FileRemoval,
        error: SaveError,
    },
    /// [`calendar_link_write`] removed the replaced link's stale `confirmedOwner` from the config,
    /// and THEN writing the new link file failed (`error`: the [`write_link_file`] refusal). The old
    /// URL stays, now unconfirmed — the safe side — but **the config DID change**, so the webview
    /// must reload it: `confirmationCleared` is always `true` here, the field [`LinkWritten`] carries.
    WriteAfterConfirmationCleared {
        error: Box<CalendarError>,
        #[serde(rename = "confirmationCleared")]
        confirmation_cleared: bool,
    },
}

fn config_error(error: SaveError) -> CalendarError {
    CalendarError::Config { error }
}

/* ── the folder and the file ──────────────────────────────────────────────────────────────────── */

/// `<state>/calendar/links`.
pub fn links_dir(state_dir: &Path) -> PathBuf {
    state_dir.join(CALENDAR_DIR).join(LINKS_DIR)
}

/// `<state>/calendar/links/<id>.url`. The id carries no separator by construction.
pub fn link_path(state_dir: &Path, id: &LinkId) -> PathBuf {
    links_dir(state_dir).join(format!("{}{LINK_FILE_SUFFIX}", id.as_str()))
}

/// This process's effective uid — the owner every folder and file it creates gets, and the owner
/// the checks below require. `None` off unix, where there is no uid to compare.
pub fn current_owner() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: `geteuid` takes no arguments, cannot fail and touches no memory.
        Some(unsafe { libc::geteuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn folder_error(path: &Path, detail: impl Into<String>) -> CalendarError {
    CalendarError::LinkFolder {
        path: path.display().to_string(),
        detail: detail.into(),
    }
}

fn file_error(path: &Path, detail: impl Into<String>) -> CalendarError {
    CalendarError::LinkFile {
        path: path.display().to_string(),
        detail: detail.into(),
    }
}

/// `mkdir <path>` with mode 0700, not recursive; an existing entry is left for [`check_folder`].
fn make_private_dir(path: &Path) -> Result<(), CalendarError> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(folder_error(path, format!("could not be created: {e}"))),
    }
}

/// `path` is a REAL directory (an `lstat`: a symlink is refused, not followed), owned by `owner`
/// when one is given, with none of `forbidden_bits` set. Off unix only the first half is checked.
fn check_folder(path: &Path, owner: Option<u32>, forbidden_bits: u32) -> Result<(), CalendarError> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| folder_error(path, format!("could not be read: {e}")))?;
    if meta.file_type().is_symlink() {
        return Err(folder_error(
            path,
            "is a symbolic link; Daily Briefing keeps calendar links only in a real folder",
        ));
    }
    if !meta.is_dir() {
        return Err(folder_error(path, "is not a folder"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let Some(uid) = owner {
            if meta.uid() != uid {
                return Err(folder_error(path, "belongs to another user"));
            }
        }
        let mode = meta.mode() & 0o7777;
        if mode & forbidden_bits != 0 {
            return Err(folder_error(
                path,
                format!(
                    "has mode {mode:04o}, which lets other users into it; calendar links need a \
                     private folder"
                ),
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = (owner, forbidden_bits);
    Ok(())
}

/// `<state>/calendar/links`, created where missing and checked (module header).
fn ensure_links_dir(state_dir: &Path, owner: Option<u32>) -> Result<PathBuf, CalendarError> {
    if std::fs::metadata(state_dir).is_err() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(state_dir)
            .map_err(|e| folder_error(state_dir, format!("could not be created: {e}")))?;
    }
    // `metadata`, not `symlink_metadata`: the state folder itself may be a symlink.
    match std::fs::metadata(state_dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(folder_error(state_dir, "is not a folder")),
        Err(e) => return Err(folder_error(state_dir, format!("could not be read: {e}"))),
    }
    let calendar = state_dir.join(CALENDAR_DIR);
    make_private_dir(&calendar)?;
    check_folder(&calendar, owner, 0o002)?;
    let links = calendar.join(LINKS_DIR);
    make_private_dir(&links)?;
    check_folder(&links, owner, 0o077)?;
    Ok(links)
}

/// How many link files other than `id`'s are in `links` — names `<id>.url` whose stem passes the id
/// grammar. Counted whatever kind of entry holds the name, so a planted entry cannot hide a link.
fn other_link_files(links: &Path, id: &LinkId) -> Result<usize, CalendarError> {
    let entries = std::fs::read_dir(links)
        .map_err(|e| folder_error(links, format!("could not be listed: {e}")))?;
    Ok(entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(LINK_FILE_SUFFIX))
                .is_some_and(|stem| stem != id.as_str() && link_id(stem).is_ok())
        })
        .count())
}

/// Write `url` to `<state>/calendar/links/<id>.url` as this process's user. See
/// [`write_link_file_as`]. Returns the path and whether a previous URL was replaced.
pub fn write_link_file(
    state_dir: &Path,
    id: &LinkId,
    url: &LinkUrl,
) -> Result<(PathBuf, bool), CalendarError> {
    write_link_file_as(state_dir, id, url, current_owner())
}

/// [`write_link_file`] with the required OWNER as a parameter, so a test can prove a folder owned by
/// someone else is refused without `chown` (which needs root). The app passes [`current_owner`].
///
/// In order: the folders ([`ensure_links_dir`]); this module's stale temp files swept
/// (`config_save::sweep_stale` — only `.link-save-<pid>-<seq>` names whose writer is gone, never
/// anything else); the [`MAX_LINKS`] count; the entry at `<id>.url`, which must be absent or a
/// regular file; the URL staged in a 0600 temp file (`config_save::write_new_file`, `O_EXCL`,
/// `fsync`ed); `rename` over `<id>.url`; the folder `fsync`ed. A failure after staging removes the
/// temp file and leaves `<id>.url` exactly as it was.
pub fn write_link_file_as(
    state_dir: &Path,
    id: &LinkId,
    url: &LinkUrl,
    owner: Option<u32>,
) -> Result<(PathBuf, bool), CalendarError> {
    let links = ensure_links_dir(state_dir, owner)?;
    config_save::sweep_stale(&links, LINK_TEMP_PREFIX, &[""]);
    if other_link_files(&links, id)? >= MAX_LINKS {
        return Err(CalendarError::TooManyLinks { limit: MAX_LINKS });
    }
    let target = link_path(state_dir, id);
    let replaced = match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_file() => true,
        Ok(meta) => {
            let what = if meta.file_type().is_symlink() {
                "a symbolic link"
            } else if meta.is_dir() {
                "a folder"
            } else {
                "a special file"
            };
            return Err(file_error(
                &target,
                format!("is {what}, not a link file; it was left alone"),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(file_error(&target, format!("could not be read: {e}"))),
    };
    let temp = links.join(format!("{LINK_TEMP_PREFIX}{}", config_save::unique()));
    config_save::write_new_file(&temp, url.bytes(), 0o600)
        .map_err(|e| file_error(&target, format!("could not be written: {e}")))?;
    if let Err(e) = std::fs::rename(&temp, &target) {
        let _ = std::fs::remove_file(&temp);
        return Err(file_error(
            &target,
            format!("could not be put in place: {e}"),
        ));
    }
    // Make the rename durable. Best effort: the file is in place either way.
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(&links) {
        let _ = dir.sync_all();
    }
    Ok((target, replaced))
}

/// The most of an existing link file [`replaces_a_different_url`] reads: the engine's own ceiling
/// for a managed link file (W1's `src/calendar/link-url.ts` refuses a file over 8192 bytes).
pub const LINK_FILE_READ_CAP: u64 = 8192;

/// Whether writing `url` for `id` would REPLACE A DIFFERENT URL already in `<id>.url` — the case
/// whose `confirmedOwner` must not survive ([`clear_confirmed_owner`]). Read without following a
/// symlink and capped; the old URL is compared in memory and never leaves this function. A file that
/// cannot be read as a URL counts as different (the safe answer: the confirmation goes); no file, or
/// something at the name the writer will refuse anyway, counts as not replacing.
///
/// ⚠ NEVER THROUGH A SYMLINKED FOLDER (M8 checkpoint, LOW): [`calendar_link_write`] runs the full
/// folder checks ([`ensure_links_dir`]) before calling this, and this refuses on its own too — a
/// `calendar/` or `links/` that is a symbolic link or not a directory answers "not replacing", and
/// the write then refuses that folder.
pub fn replaces_a_different_url(state_dir: &Path, id: &LinkId, url: &LinkUrl) -> bool {
    let calendar = state_dir.join(CALENDAR_DIR);
    if check_folder(&calendar, None, 0).is_err() || check_folder(&calendar.join(LINKS_DIR), None, 0).is_err() {
        return false;
    }
    let target = link_path(state_dir, id);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_file() => {
            match read_text_capped(&target, LINK_FILE_READ_CAP) {
                Ok(old) => old.trim() != url.0,
                Err(_) => true,
            }
        }
        _ => false,
    }
}

/// Remove `<state>/calendar/links/<id>.url` as this process's user. See [`remove_link_file_as`].
pub fn remove_link_file(state_dir: &Path, id: &LinkId) -> Result<FileRemoval, CalendarError> {
    remove_link_file_as(state_dir, id, current_owner())
}

/// [`remove_link_file`] with the required owner as a parameter (the [`write_link_file_as`] reason).
///
/// No folder → [`FileRemoval::Absent`]. A folder that is a symlink, not a directory, or another
/// user's is REFUSED — nothing is removed through it. Its MODE is not checked here: removing a
/// secret from a loose folder is never worse than leaving it. A directory at `<id>.url` is refused;
/// anything else there (the file, or a symlink — unlinked, never followed) is removed. This
/// module's stale temp files are swept too: they may hold a URL.
pub fn remove_link_file_as(
    state_dir: &Path,
    id: &LinkId,
    owner: Option<u32>,
) -> Result<FileRemoval, CalendarError> {
    let calendar = state_dir.join(CALENDAR_DIR);
    let links = calendar.join(LINKS_DIR);
    for folder in [&calendar, &links] {
        match std::fs::symlink_metadata(folder) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(FileRemoval::Absent),
            Err(e) => return Err(folder_error(folder, format!("could not be read: {e}"))),
            Ok(_) => check_folder(folder, owner, 0)?,
        }
    }
    config_save::sweep_stale(&links, LINK_TEMP_PREFIX, &[""]);
    let target = link_path(state_dir, id);
    match std::fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileRemoval::Absent),
        Err(e) => Err(file_error(&target, format!("could not be read: {e}"))),
        Ok(meta) if meta.is_dir() => Err(file_error(
            &target,
            "is a folder, not a link file; it was left alone",
        )),
        Ok(_) => match std::fs::remove_file(&target) {
            Ok(()) => Ok(FileRemoval::Removed),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileRemoval::Absent),
            Err(e) => Err(file_error(&target, format!("could not be removed: {e}"))),
        },
    }
}

/* ── the config block ─────────────────────────────────────────────────────────────────────────── */
//
// ⚠ A MIRROR OF THE ENGINE'S ACCEPTANCE RULES, AND WHY ONE EXISTS. The engine's resolver
// (`src/calendar/config.ts`, `resolveCalendar`, W1's M1) is ALL-OR-NOTHING: one unknown key or
// mistyped field anywhere in the block switches the whole calendar off with one warning — and a
// `config validate` WARNING does not block a save (`config_save.rs` step 6). So a block the app
// wrote without these checks could save "successfully" and silently disconnect every link. The
// rules below are that resolver's, transcribed (hub brief, 2026-10-09, checked against W1's commit
// 3b110181d): closed key sets at both levels, `null` = unset on every optional key, the id grammar,
// at most ten links, unique ids, `name` non-empty one-line text without `://`, `owner` /
// `confirmedOwner` addresses, `urlEnv` a variable name, `urlCommand` a non-empty argv array of
// non-empty strings, never both. It is a SECOND COPY of a contract and can drift: the engine stays
// the authority (`config validate` still runs on every save). The two are pinned by a SHARED
// fixture, `tests/fixtures/calendar_block_cases.json`: `tests/calendar.rs` replays it through this
// check and `gui/tests-web/calendar.check.ts` through the engine's real `resolveCalendar`.

/// The `calendar` block's keys (the resolver's `objectWithOnly(raw, ["enabled", "emails", "macos",
/// "links"])`).
pub const CALENDAR_KEYS: &[&str] = &["enabled", "emails", "macos", "links"];

/// One link entry's keys (the resolver's `LINK_KEYS` minus `url`, which it reads only to SKIP the
/// link — and which this app refuses outright, [`CalendarError::UrlInConfig`]).
pub const LINK_KEYS: &[&str] = &[
    "id",
    "name",
    "owner",
    "confirmedOwner",
    "urlEnv",
    "urlCommand",
];

/// Does `text` look like it carries a URL? A scheme separator in any spelling
/// ([`scheme_separators`]): no display label, address or link id has one.
fn carries_scheme(text: &str) -> bool {
    scheme_separators(text) > 0
}

/// How many scheme separators `text` carries — the engine's `SCHEME_SEP_RE`
/// (`src/calendar/config.ts`) counted by hand: a `:` followed by two characters each `/` or `\`
/// (plain `://`, the JSON-escaped `:\/\/`, and — final harden r3 — the backslash forms a WHATWG
/// parser reads as `//` for the special schemes, `https:\\host\path`), or `%3a` followed by two
/// of `%2f` / `%5c`. ASCII case-insensitive. Every match starts at its `:` / `%3a` and consumes no
/// further `:` or `%`, so the matches never overlap and the count equals the regex's.
fn scheme_separators(text: &str) -> usize {
    let s = text.to_ascii_lowercase();
    let b = s.as_bytes();
    let slash = |i: usize| matches!(b.get(i), Some(b'/') | Some(b'\\'));
    let pct = |i: usize| b.get(i..i + 3).is_some_and(|t| t == b"%2f" || t == b"%5c");
    let mut count = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b':' && slash(i + 1) && slash(i + 2) {
            count += 1;
            i += 3;
        } else if b.get(i..i + 3) == Some(b"%3a".as_slice()) && pct(i + 3) && pct(i + 6) {
            count += 1;
            i += 9;
        } else {
            i += 1;
        }
    }
    count
}

/// The engine's `DOTTED_HOST_PATH_RE`: a dotted host — labels of ASCII letters, digits and `-`
/// joined by `.`, at least two, the last 2 to 63 letters — starting where its run starts (not after
/// a letter, digit, `.` or `-`), then an optional `:` and 1 to 5 digits, then `/` or `\` — or
/// (post-convergence LOW) the percent-encoded `%2f` / `%5c`, any case.
fn has_dotted_host_path(text: &str) -> bool {
    let s = text.to_ascii_lowercase();
    let b = s.as_bytes();
    let run = |c: u8| c.is_ascii_alphanumeric() || c == b'-' || c == b'.';
    (0..b.len()).any(|start| {
        if start > 0 && run(b[start - 1]) {
            return false;
        }
        let mut end = start;
        while end < b.len() && run(b[end]) {
            end += 1;
        }
        let labels: Vec<&[u8]> = b[start..end].split(|c| *c == b'.').collect();
        let last = labels.last().copied().unwrap_or_default();
        let hostish = labels.len() >= 2
            && labels.iter().all(|l| !l.is_empty())
            && (2..=63).contains(&last.len())
            && last.iter().all(u8::is_ascii_alphabetic);
        if !hostish {
            return false;
        }
        let mut at = end;
        if b.get(at) == Some(&b':') {
            let digits = b[at + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if !(1..=5).contains(&digits) {
                return false;
            }
            at += 1 + digits;
        }
        matches!(b.get(at), Some(b'/') | Some(b'\\'))
            || matches!(b.get(at..at + 3), Some(b"%2f") | Some(b"%5c"))
    })
}

/// Does any object at or under `value` carry a key spelled `url` (any ASCII letter case)? ITERATIVE,
/// with no depth limit (final harden r2: the engine's recursive walk stopped at depth 16 and failed
/// open; both sides now scan the whole value).
fn holds_url_key(value: &Value) -> bool {
    let mut stack = vec![value];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(map) => {
                for (key, child) in map {
                    if key.eq_ignore_ascii_case("url") {
                        return true;
                    }
                    stack.push(child);
                }
            }
            Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    false
}

/// Where the first key spelled `url` sits, as a FIXED SCHEMA POSITION — `url`, `emails`, `macos`,
/// `links`, `links[2]`, `links[2].url` or `calendar` — and never the user's own key text (final
/// harden r2: the old position copied every key on the way down, and a key can itself be the URL).
fn url_key_position(block: &Value) -> Option<String> {
    let map = block.as_object()?;
    for (key, child) in map {
        if key.eq_ignore_ascii_case("url") {
            return Some("url".into());
        }
        if !holds_url_key(child) {
            continue;
        }
        if key == "links" {
            if let Some((i, link)) = child
                .as_array()
                .and_then(|items| items.iter().enumerate().find(|(_, l)| holds_url_key(l)))
            {
                let direct = link
                    .as_object()
                    .is_some_and(|l| l.keys().any(|k| k.eq_ignore_ascii_case("url")));
                return Some(if direct {
                    format!("links[{i}].url")
                } else {
                    format!("links[{i}]")
                });
            }
        }
        return Some(match CALENDAR_KEYS.iter().find(|k| **k == key.as_str()) {
            Some(known) => (*known).to_string(),
            None => "calendar".into(),
        });
    }
    None
}

/// The engine's `calendarArgIsUrlShaped` (`src/calendar/config.ts`, final harden r2, narrowed r3):
/// one `urlCommand` argument is URL-shaped when it carries a scheme separator in any spelling
/// ([`scheme_separators`], ANY scheme) beyond one leading `op://` (a 1Password secret REFERENCE, a
/// pointer to the address and not the address), or names an `.ics` file (`.ics` not followed by an
/// ASCII letter or digit) AND carries a dotted host path ([`has_dotted_host_path`]). A bare `.ics`
/// path — `pass show calendar/work.ics`, a password-store entry — is not an address. ASCII
/// case-insensitive. Pinned against the engine by `tests/fixtures/calendar_block_cases.json`.
pub fn url_shaped_arg(arg: &str) -> bool {
    let s = arg.to_ascii_lowercase();
    let exempt = usize::from(s.starts_with("op://"));
    let ics = s.match_indices(".ics").any(|(at, _)| {
        !s.as_bytes()
            .get(at + 4)
            .is_some_and(|b| b.is_ascii_alphanumeric())
    });
    scheme_separators(&s) > exempt || (ics && has_dotted_host_path(&s))
}

/// The engine's `calendarBlockHasLiteralUrl` (`src/calendar/config.ts`): a key spelled `url` (any
/// ASCII case) anywhere in the block, a URL-shaped argument ([`url_shaped_arg`]) under any key
/// spelled `urlCommand` (any ASCII case), or (final harden r3) a scheme separator in a `name`,
/// `owner`, `confirmedOwner` or `emails` value. What `config validate` makes an ERROR — and what the
/// generic config save ([`crate::config_save`]) now refuses BEFORE it stages a candidate file
/// (final harden r2), so the secret never reaches `config-candidates/`. Iterative, no depth limit.
pub fn calendar_block_holds_secret(block: &Value) -> bool {
    let mut stack = vec![block];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(map) => {
                for (key, child) in map {
                    if key.eq_ignore_ascii_case("url") {
                        return true;
                    }
                    if key.eq_ignore_ascii_case("urlCommand") {
                        let shaped = |a: &Value| a.as_str().is_some_and(url_shaped_arg);
                        let hit = match child {
                            Value::Array(args) => args.iter().any(shaped),
                            other => shaped(other),
                        };
                        if hit {
                            return true;
                        }
                    }
                    // Final harden r3: a web address in a field never meant to hold one — a link's
                    // `name`, `owner` or `confirmedOwner`, or an `emails` entry (any ASCII case, any
                    // depth, as the engine's walk) — is the same secret in the wrong field, refused
                    // BEFORE the candidate is staged rather than by the engine after.
                    if ["name", "owner", "confirmedOwner", "emails"]
                        .iter()
                        .any(|k| key.eq_ignore_ascii_case(k))
                    {
                        let text = |t: &Value| t.as_str().is_some_and(carries_scheme);
                        let hit = match child {
                            Value::Array(items) if key.eq_ignore_ascii_case("emails") => {
                                items.iter().any(text)
                            }
                            other => text(other),
                        };
                        if hit {
                            return true;
                        }
                    }
                    stack.push(child);
                }
            }
            Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    false
}

/// The resolver's `CONTROL_RE`: C0 and C1 controls plus U+2028 / U+2029.
fn has_control(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}'))
}

/// JavaScript's `\s` (and what `String.prototype.trim` strips): Rust's `White_Space` MINUS U+0085
/// (NEL — a C1 control to JavaScript, which the control rule then refuses) PLUS U+FEFF (a space to
/// JavaScript, not to Rust). MEASURED by this file's own test: with plain `char::is_whitespace`, a
/// trailing NEL was trimmed away and `me@example.com\u{85}` admitted where the resolver refuses it.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// The invisible format characters the engine's `cleanEmail` STRIPS (`src/calendar/clean.ts`,
/// `INVISIBLE_RE`, minus the C0/C1 controls [`has_control`] already refuses). The resolver's
/// `calendarEmail` requires `cleanEmail(s) === s`, so an address carrying one — `me\u{200b}@example.com`
/// — switches the whole calendar off there (final harden r2: this check used to admit it).
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{ad}' | '\u{34f}' | '\u{61c}' | '\u{115f}' | '\u{1160}' | '\u{17b4}' | '\u{17b5}'
        | '\u{180e}' | '\u{200b}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}'
        | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{3164}' | '\u{feff}'
        | '\u{ffa0}' | '\u{fff9}'..='\u{fffb}' | '\u{1bca0}'..='\u{1bca3}'
        | '\u{1d173}'..='\u{1d17a}' | '\u{e0000}'..='\u{e007f}')
}

/// The resolver's `email(v)`: trimmed and lower-cased, at most 254 UTF-16 units, no control
/// character, no invisible format character ([`is_invisible`]), and `EMAIL_RE` — one `@`, a
/// non-empty local part, a dotted domain whose last label is non-empty, and none of whitespace or
/// `@ / \ : < > ( ) [ ] , ; " '` anywhere.
pub fn is_calendar_email(value: &str) -> bool {
    let s = value.trim_matches(js_space).to_lowercase();
    if s.encode_utf16().count() > 254 || has_control(&s) || s.chars().any(is_invisible) {
        return false;
    }
    let plain = |c: char| !js_space(c) && !"@/\\:<>()[],;\"'".contains(c);
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    let Some((head, last)) = domain.rsplit_once('.') else {
        return false;
    };
    !local.is_empty()
        && local.chars().all(plain)
        && !head.is_empty()
        && head.chars().all(plain)
        && !last.is_empty()
        && last.chars().all(plain)
}

/// The resolver's `ENV_NAME_RE`: `^[A-Za-z_][A-Za-z0-9_]{0,127}$`.
fn is_env_name(value: &str) -> bool {
    let b = value.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// `key` of `object`, with `null` read as absent (the resolver's `own`: "every optional key in the
/// block treats `null` as unset").
fn set<'a>(object: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|v| !v.is_null())
}

fn bad_block(reason: impl Into<String>) -> CalendarError {
    CalendarError::InvalidBlock {
        reason: reason.into(),
    }
}

/// The Rust-side check on a `calendar` block before it is written (plan M8): everything the
/// engine's resolver would treat as malformed (see the section comment), plus what must never reach
/// `config.json` at all. Refusal reasons are fixed text naming a field POSITION (`links[2].name`),
/// never a value — a URL pasted into the wrong field is exactly what they catch.
///
///   * a key spelled `url` in any letter case ANYWHERE in the block → [`CalendarError::UrlInConfig`]
///     (checked first: the engine would skip such a link; this keeps the secret out of the file);
///   * a `://` in a link's `name`, `owner` or `confirmedOwner`, or in an `emails` entry, or a
///     URL-shaped `urlCommand` argument ([`url_shaped_arg`]) → `UrlInConfig` (a URL pasted into the
///     wrong field);
///   * more than [`MAX_LINKS`] links → [`CalendarError::TooManyLinks`]; a missing, ungrammatical or
///     reserved id → [`CalendarError::InvalidId`]; two entries with one id →
///     [`CalendarError::DuplicateId`];
///   * anything else the resolver refuses → [`CalendarError::InvalidBlock`].
pub fn check_calendar_block(block: &Value) -> Result<(), CalendarError> {
    let Some(object) = block.as_object() else {
        return Err(bad_block("the calendar settings are not a JSON object"));
    };
    if let Some(field) = url_key_position(block) {
        return Err(CalendarError::UrlInConfig { field });
    }
    if object.keys().any(|k| !CALENDAR_KEYS.contains(&k.as_str())) {
        return Err(bad_block(
            "calendar may hold only \"enabled\", \"emails\", \"macos\" and \"links\"",
        ));
    }
    if set(object, "enabled").is_some_and(|v| !v.is_boolean()) {
        return Err(bad_block("calendar.enabled must be true or false"));
    }
    if let Some(emails) = set(object, "emails") {
        let Some(emails) = emails.as_array() else {
            return Err(bad_block(
                "calendar.emails must be a list of email addresses",
            ));
        };
        for (i, email) in emails.iter().enumerate() {
            let text = email.as_str().unwrap_or_default();
            if carries_scheme(text) {
                return Err(CalendarError::UrlInConfig {
                    field: format!("emails[{i}]"),
                });
            }
            if !email.is_string() || !is_calendar_email(text) {
                return Err(bad_block(format!(
                    "calendar.emails[{i}] is not an email address"
                )));
            }
        }
    }
    if let Some(macos) = set(object, "macos") {
        check_macos(macos)?;
    }
    let Some(links) = set(object, "links") else {
        return Ok(());
    };
    let Some(links) = links.as_array() else {
        return Err(bad_block("calendar.links must be a list"));
    };
    if links.len() > MAX_LINKS {
        return Err(CalendarError::TooManyLinks { limit: MAX_LINKS });
    }
    let mut seen: Vec<&str> = Vec::new();
    for (i, link) in links.iter().enumerate() {
        let id = check_link(i, link)?;
        if seen.contains(&id) {
            return Err(CalendarError::DuplicateId { id: id.to_string() });
        }
        seen.push(id);
    }
    Ok(())
}

/// `calendar.macos`: `{ "calendars"?: "editable" | "all" | [{ "id", "title", "account" }] }`, each
/// chosen calendar with a non-blank text `id` and text `title` and `account`, and no other key.
fn check_macos(macos: &Value) -> Result<(), CalendarError> {
    let shape = || {
        bad_block(
            "calendar.macos must be { \"calendars\": \"editable\" | \"all\" | [{ \"id\", \"title\", \
             \"account\" }] }",
        )
    };
    let Some(macos) = macos.as_object() else {
        return Err(shape());
    };
    if macos.keys().any(|k| k != "calendars") {
        return Err(shape());
    }
    match set(macos, "calendars") {
        None => Ok(()),
        Some(Value::String(choice)) if choice == "editable" || choice == "all" => Ok(()),
        Some(Value::Array(chosen)) => {
            for calendar in chosen {
                let Some(calendar) = calendar.as_object() else {
                    return Err(shape());
                };
                let text = |key: &str| set(calendar, key).and_then(Value::as_str);
                let ok = calendar
                    .keys()
                    .all(|k| ["id", "title", "account"].contains(&k.as_str()))
                    && text("id").is_some_and(|id| !id.trim_matches(js_space).is_empty())
                    && text("title").is_some()
                    && text("account").is_some();
                if !ok {
                    return Err(shape());
                }
            }
            Ok(())
        }
        Some(_) => Err(shape()),
    }
}

/// One `calendar.links` entry, at position `i`; its id when it passes.
fn check_link(i: usize, link: &Value) -> Result<&str, CalendarError> {
    let Some(link) = link.as_object() else {
        return Err(bad_block(format!("calendar.links[{i}] is not an object")));
    };
    for key in ["name", "owner", "confirmedOwner"] {
        if set(link, key)
            .and_then(Value::as_str)
            .is_some_and(carries_scheme)
        {
            return Err(CalendarError::UrlInConfig {
                field: format!("links[{i}].{key}"),
            });
        }
    }
    // Final harden r2: the address pasted into the command (`["echo", "https://…/basic.ics"]`) — the
    // engine's resolver switches the calendar off for it and `config validate` makes it an ERROR.
    if set(link, "urlCommand")
        .and_then(Value::as_array)
        .is_some_and(|argv| argv.iter().any(|a| a.as_str().is_some_and(url_shaped_arg)))
    {
        return Err(CalendarError::UrlInConfig {
            field: format!("links[{i}].urlCommand"),
        });
    }
    if link.keys().any(|k| !LINK_KEYS.contains(&k.as_str())) {
        return Err(bad_block(format!(
            "calendar.links[{i}] may hold only \"id\", \"name\", \"owner\", \"confirmedOwner\", \
             \"urlEnv\" and \"urlCommand\""
        )));
    }
    let Some(id) = set(link, "id").and_then(Value::as_str) else {
        return Err(CalendarError::InvalidId {
            reason: format!("calendar.links[{i}].id is missing or not text"),
        });
    };
    if let Err(refusal) = link_id(id) {
        return Err(CalendarError::InvalidId {
            reason: format!("calendar.links[{i}].id {}", refusal.message()),
        });
    }
    if let Some(name) = set(link, "name") {
        let ok = name
            .as_str()
            .is_some_and(|n| !n.trim_matches(js_space).is_empty() && !has_control(n));
        if !ok {
            return Err(bad_block(format!(
                "calendar.links[{i}].name must be non-empty text on one line"
            )));
        }
    }
    for key in ["owner", "confirmedOwner"] {
        if let Some(address) = set(link, key) {
            if !address.as_str().is_some_and(is_calendar_email) {
                return Err(bad_block(format!(
                    "calendar.links[{i}].{key} must be an email address"
                )));
            }
        }
    }
    let url_env = set(link, "urlEnv");
    if url_env.is_some_and(|v| !v.as_str().is_some_and(is_env_name)) {
        return Err(bad_block(format!(
            "calendar.links[{i}].urlEnv must be an environment variable name (letters, digits and \
             underscores)"
        )));
    }
    let url_command = set(link, "urlCommand");
    if let Some(argv) = url_command {
        let ok = argv.as_array().is_some_and(|argv| {
            !argv.is_empty()
                && argv
                    .iter()
                    .all(|a| a.as_str().is_some_and(|a| !a.is_empty()))
        });
        if !ok {
            return Err(bad_block(format!(
                "calendar.links[{i}].urlCommand must be a non-empty list of non-empty strings (the \
                 command and its arguments)"
            )));
        }
    }
    if url_env.is_some() && url_command.is_some() {
        return Err(bad_block(format!(
            "calendar.links[{i}] may set urlEnv or urlCommand, not both"
        )));
    }
    Ok(id)
}

/// Remove `confirmedOwner` from the `calendar.links` entry whose `id` is `id`, when there is one.
/// Returns whether it removed anything. Every other key — and every other entry — is untouched.
///
/// Spec r4 §4.2 / the hub brief: the confirmation is of the address in THIS link's URL path, so a
/// link whose URL is REPLACED never inherits it — [`calendar_link_write`] calls this before it puts a
/// different URL in place, and the user confirms the new one again.
pub fn clear_confirmed_owner(config: &mut Value, id: &LinkId) -> bool {
    let Some(links) = config
        .get_mut("calendar")
        .and_then(|calendar| calendar.get_mut("links"))
        .and_then(Value::as_array_mut)
    else {
        return false;
    };
    let mut cleared = false;
    for link in links.iter_mut() {
        if link.get("id").and_then(Value::as_str) == Some(id.as_str()) {
            if let Some(entry) = link.as_object_mut() {
                cleared |= entry.shift_remove("confirmedOwner").is_some();
            }
        }
    }
    cleared
}

/// Drop every entry whose `id` is `id` from `calendar.links`, when that list exists. Anything else
/// — no block, no list, no such entry — leaves the value as it was, and the save pipeline then
/// writes nothing ([`SaveOutcome::Unchanged`]).
pub fn drop_link_entry(config: &mut Value, id: &LinkId) {
    if let Some(links) = config
        .get_mut("calendar")
        .and_then(|calendar| calendar.get_mut("links"))
        .and_then(Value::as_array_mut)
    {
        links.retain(|link| link.get("id").and_then(Value::as_str) != Some(id.as_str()));
    }
}

/* ── the engine read ──────────────────────────────────────────────────────────────────────────── */

fn client_of(engine: &Engine) -> Result<&EngineClient, CalendarError> {
    engine.client().map_err(|e| CalendarError::Engine {
        detail: e.to_string(),
    })
}

/* ── the commands ─────────────────────────────────────────────────────────────────────────────── */

/// Write one calendar link's URL to its managed file (spec §8 "Add a calendar link"; plan M8).
///
/// ⚠ BOTH OPERANDS ARE CHECKED BEFORE ANY SPAWN, and neither is ever echoed: a refused id or URL
/// answers with the class of problem only. The state folder and the config path are
/// `status --json`'s. Writes the link file — and touches the config in exactly one case:
///
/// ⚠ **A DIFFERENT URL REPLACING AN EXISTING ONE CLEARS THAT LINK'S `confirmedOwner` FIRST** (spec
/// §4.2; [`clear_confirmed_owner`]). The confirmation is of the address in the OLD URL's path, so a
/// replaced link must never inherit it. The clear happens BEFORE the new file goes in place, under
/// the same lock: if the config edit fails, nothing is written and the old URL keeps its
/// confirmation ([`CalendarError::ConfigInvalid`] / [`CalendarError::Config`]); if the file write
/// then fails, the confirmation is gone and the old URL stays — the safe side — and the error says
/// the config changed ([`CalendarError::WriteAfterConfirmationCleared`]). (That order is
/// pinned by fault injection, `tests/calendar.rs`: a config edit made to fail leaves the old file.)
/// The link folders are checked before either step, so a refused folder clears nothing. A NEW link (no file
/// yet), or the same URL written again, touches no config. The webview's order is therefore: write
/// the link, then save the `calendar` block with any `confirmedOwner` the user just confirmed.
#[tauri::command]
pub async fn calendar_link_write<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
    id: String,
    url: String,
) -> Result<LinkWritten, CalendarError> {
    let id = link_id(&id).map_err(|r| CalendarError::InvalidId {
        reason: r.message().into(),
    })?;
    let url = link_url(&url).map_err(|r| CalendarError::InvalidUrl {
        reason: r.message().into(),
    })?;
    let client = client_of(&engine)?;
    let dir = config_save::candidate_dir(&app, &saver).map_err(config_error)?;
    let _serialised = saver.lock.lock().await;
    saver.refuse_if_settings_removed().map_err(config_error)?;
    let paths = engine_paths(client)
        .await
        .map_err(|detail| CalendarError::Engine { detail })?;
    let state = absolute("status --json", "paths.stateDir", paths.state_dir.as_ref())
        .map_err(|detail| CalendarError::Engine { detail })?;
    // The folders FIRST (M8 checkpoint, LOW): a symlinked, foreign-owned or loose `calendar/` or
    // `links/` is refused here, before the comparison below reads anything through it and before a
    // confirmation is cleared for a write that would then fail. `write_link_file` checks again.
    let links = ensure_links_dir(&state, current_owner())?;
    // The link limit BEFORE the confirmation clear too (fix-round 1): a write the limit refuses must not first
    // clear the link's `confirmedOwner`. `write_link_file` checks again, under the same save lock.
    if other_link_files(&links, &id)? >= MAX_LINKS {
        return Err(CalendarError::TooManyLinks { limit: MAX_LINKS });
    }
    let mut confirmation_cleared = false;
    if replaces_a_different_url(&state, &id, &url) {
        let config_path = absolute(
            "status --json",
            "paths.configPath",
            paths.config_path.as_ref(),
        )
        .map_err(|detail| CalendarError::Engine { detail })?;
        match config_save::edit_config_at(client, &dir, &config_path, |config| {
            clear_confirmed_owner(config, &id);
            Ok(())
        })
        .await
        {
            Ok(SaveOutcome::Saved { .. }) => confirmation_cleared = true,
            Ok(SaveOutcome::Invalid { errors, warnings }) => {
                return Err(CalendarError::ConfigInvalid { errors, warnings })
            }
            // `Unchanged`: there was no confirmation to clear. (`Created` is `config_create`'s.)
            Ok(SaveOutcome::Unchanged { .. } | SaveOutcome::Created { .. }) => {}
            // No config file: nothing can hold a confirmation.
            Err(SaveError::NoConfig { .. }) => {}
            Err(error) => return Err(config_error(error)),
        }
    }
    let (path, replaced) = write_link_file(&state, &id, &url).map_err(|error| {
        if confirmation_cleared {
            CalendarError::WriteAfterConfirmationCleared {
                error: Box::new(error),
                confirmation_cleared: true,
            }
        } else {
            error
        }
    })?;
    Ok(LinkWritten {
        id: id.as_str().to_string(),
        path: path.display().to_string(),
        replaced,
        confirmation_cleared,
    })
}

/// Remove one calendar link: its managed file, then its entry in `calendar.links` (plan M8). One
/// hold of the save lock covers both; the file goes first, so the secret is gone even when the
/// config step then fails ([`CalendarError::ConfigAfterRemoval`] says so). Idempotent: a second call
/// answers `absent` and `unchanged`.
#[tauri::command]
pub async fn calendar_link_remove<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
    id: String,
) -> Result<LinkRemoved, CalendarError> {
    let id = link_id(&id).map_err(|r| CalendarError::InvalidId {
        reason: r.message().into(),
    })?;
    let client = client_of(&engine)?;
    let dir = config_save::candidate_dir(&app, &saver).map_err(config_error)?;
    let _serialised = saver.lock.lock().await;
    saver.refuse_if_settings_removed().map_err(config_error)?;
    let paths = engine_paths(client)
        .await
        .map_err(|detail| CalendarError::Engine { detail })?;
    let state = absolute("status --json", "paths.stateDir", paths.state_dir.as_ref())
        .map_err(|detail| CalendarError::Engine { detail })?;
    let config_path = absolute(
        "status --json",
        "paths.configPath",
        paths.config_path.as_ref(),
    )
    .map_err(|detail| CalendarError::Engine { detail })?;
    let removed = remove_link_file(&state, &id)?;
    let config = match config_save::edit_config_at(client, &dir, &config_path, |config| {
        drop_link_entry(config, &id);
        Ok(())
    })
    .await
    {
        Ok(outcome) => Some(outcome),
        Err(SaveError::NoConfig { .. }) => None,
        Err(error) => return Err(CalendarError::ConfigAfterRemoval { removed, error }),
    };
    Ok(LinkRemoved {
        id: id.as_str().to_string(),
        file: removed,
        config,
    })
}

/// Replace the config's `calendar` block (plan M8) through the app's one config-write path: the
/// block is checked ([`check_calendar_block`]) BEFORE any spawn, then — under the save lock, on the
/// file as it is now — put in place of the existing `calendar` key (or appended), engine-validated
/// and atomically written with `.bak`. Every other field is preserved exactly as every save
/// preserves it. Errors block; the engine's WARNINGS come back in `saved.warnings`.
#[tauri::command]
pub async fn calendar_config_save<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    saver: State<'_, ConfigSaver>,
    text: String,
) -> Result<SaveOutcome, CalendarError> {
    if text.len() as u64 > MAX_CONFIG_BYTES {
        return Err(config_error(SaveError::TooLarge {
            bytes: text.len() as u64,
            limit: MAX_CONFIG_BYTES,
        }));
    }
    let block: Value = serde_json::from_str(&text).map_err(|e| {
        config_error(SaveError::NotJson {
            detail: json_error_detail(&e),
        })
    })?;
    check_calendar_block(&block)?;
    let client = client_of(&engine)?;
    let dir = config_save::candidate_dir(&app, &saver).map_err(config_error)?;
    let _serialised = saver.lock.lock().await;
    saver.refuse_if_settings_removed().map_err(config_error)?;
    let path = config_save::locate(client).await.map_err(config_error)?;
    config_save::edit_config_at(client, &dir, &path, move |config| {
        if let Some(object) = config.as_object_mut() {
            // `preserve_order`: an existing `calendar` key keeps its position; a new one is appended.
            object.insert("calendar".into(), block);
        }
        Ok(())
    })
    .await
    .map_err(config_error)
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &[
    "calendar_link_write",
    "calendar_link_remove",
    "calendar_config_save",
];
