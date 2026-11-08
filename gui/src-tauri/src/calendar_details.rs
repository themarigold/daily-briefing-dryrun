//! Today's calendar details, read live and never saved (briefing redesign C; wave-2 plan C-M3-T8, C-M3-T9).
//!
//! The webview DRIVES (a move onto the calendar slide or the launchpad, the minute tick, window focus) and this module
//! GATES: [`decide`] is the one pure rule, over the window's visibility ([`crate::live_gate`]), the current slide, the
//! ask's reason, what is held, and Rust's own clock. A read runs the engine's `calendar details --json` through the
//! SEALED path ([`crate::engine::EngineClient::invoke_sealed`]): its answer is parsed inside Rust, never an
//! `EngineOutcome`, never logged.
//!
//! What is held, in memory only (C "The privacy rule"):
//!   - **the read**: the event map (keyed by an unguessable per-read handle), each source's answer, the read time, and
//!     the day and config generation it belongs to. Purged at the day change, on a config change and by a read that
//!     does not answer; replaced by every read that answers;
//!   - **the remembered command-link URLs** ([`HeldLink`]), with their own life: exactly the URLs the last answered
//!     read returned (a dead link's is not returned), each keyed by its link's id and entry hash. Unchanged by a
//!     refusal, a held reply or a read that does not answer. Cleared at quit;
//!   - **the per-source last status**, beside the URLs, with the same life: what a skipped source shows.
//!
//! ⚠ ONE READ IN FLIGHT ([`CalendarDetails::run`]). A second ask WAITS for it, then re-samples the window and the clock
//! and runs [`decide`] again against what is held then (C-M3-T8, R2-M1 / R3-M3).
//!
//! ⚠ THE STATE LOCK NEVER SPANS AN AWAIT. Every access is through [`CalendarDetails::with_state`], a plain (non-async)
//! function; the handback is snapshotted into a zeroing buffer inside it, and the read is spawned after it returns
//! (`tests/calendar_details.rs` pins both).
//!
//! ⚠ NOTHING HERE PRINTS A HELD VALUE. No held type derives `Debug`, `Clone` or `Serialize`; the replies carry no URL
//! (only a Join host), and no error carries text from the engine.

use std::hash::{BuildHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::access::{OpenSink, SystemOpener};
use crate::calendar::{link_id, link_url, link_url_bytes, LinkId};
use crate::engine::{
    DetailsFailure, DetailsRaw, DetailsRead, EngineClient, EngineError, LinkHandback, Operation, RawJoin,
    SecretBytes,
};
use crate::live_gate::{CurrentSlide, LiveEnv, Visibility};
use crate::schedule_state::Now;

/* ── the decision ─────────────────────────────────────────────────────────────────────────────── */

/// Why the webview asks. The webview sends `became-current` ONLY for the user's own move onto the calendar slide or
/// the launchpad (`gui/src/lib/live-current.ts`'s `onmove`); `focus` and `timer` never run a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    BecameCurrent,
    Focus,
    Timer,
}

/// The timer's backstop: a `timer` ask less than this long after the last answered read gets the held read (300 s
/// less 5 s of tolerance against the webview's minute tick; round-5 item C6).
pub const TIMER_BACKSTOP_SECS: i64 = 300 - 5;

/// [`decide`]'s inputs, all sampled when the ask decides (after any wait on the read in flight).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetailsGateInput {
    /// The main window, sampled when the ask decides; [`decide`] reads it through [`Visibility::shown`].
    pub visibility: Visibility,
    /// The deck's current slide, as the ask carries it.
    pub current: Option<CurrentSlide>,
    pub reason: Reason,
    /// A held read of the same day and config generation (none at all, a read that did not answer, a day change and a
    /// config change all make it false).
    pub held_valid: bool,
    /// Rust's clock now, less the held read's answer time (meaningful only when `held_valid`).
    pub since_read_secs: i64,
    /// A remembered command link holds no URL (its command gave none, its link was dead, or its entry changed).
    pub any_link_without_url: bool,
    /// The Mac source's last status is `denied` or `not-granted`.
    pub mac_blocked: bool,
}

/// What an ask gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailsDecision {
    /// Nothing held and another slide current: `{ gate: "none" }`; nothing read.
    None,
    /// The held read: `{ gate: "held", … }`; nothing read.
    Held,
    /// The window is hidden or minimised: `{ refused: "hidden" }`. Nothing is owed (new OD1).
    RefusedHidden,
    /// Read now, with these Rust-built flags: `{ gate: "read", … }`.
    Read { skip_commands: bool, skip_mac: bool },
}

/// The one rule (C-M3-T8). A command runs only on a `became-current` read: `skip_commands` is true on every `focus`
/// and `timer` read, whatever is held (the new OD1, orchestrator-settled 2026-10-24; the webview's rule is the first
/// line, this the second). `skip_mac` only on a timed read, while the Mac source's last status is a refusal.
pub fn decide(i: DetailsGateInput) -> DetailsDecision {
    // 1. Another slide: whatever is held, nothing read.
    if !matches!(i.current, Some(CurrentSlide::Calendar | CurrentSlide::Launchpad)) {
        return if i.held_valid { DetailsDecision::Held } else { DetailsDecision::None };
    }
    // 2. Not shown: refused, nothing owed.
    if !i.visibility.shown() {
        return DetailsDecision::RefusedHidden;
    }
    let timed = DetailsDecision::Read { skip_commands: true, skip_mac: i.mac_blocked };
    // 3. No valid held read: every reason reads; only became-current runs commands.
    if !i.held_valid {
        return match i.reason {
            Reason::BecameCurrent => DetailsDecision::Read { skip_commands: false, skip_mac: false },
            Reason::Focus => DetailsDecision::Read { skip_commands: true, skip_mac: false },
            Reason::Timer => timed,
        };
    }
    match i.reason {
        // 4. The retry: a move reads again only when a command link holds no URL.
        Reason::BecameCurrent if i.any_link_without_url => {
            DetailsDecision::Read { skip_commands: false, skip_mac: false }
        }
        Reason::BecameCurrent => DetailsDecision::Held,
        // 5. The backstop.
        Reason::Timer if i.since_read_secs < TIMER_BACKSTOP_SECS => DetailsDecision::Held,
        Reason::Timer => timed,
        // 6.
        Reason::Focus => DetailsDecision::Read { skip_commands: true, skip_mac: false },
    }
}

/* ── the replies (C-M3-T9's IPC shapes; no URL anywhere) ──────────────────────────────────────── */

/// `calendar_details_open`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum OpenReply {
    /// `{ gate: "none" }`: no read held, another slide current.
    Gate { gate: &'static str },
    /// `{ refused: "hidden" }` or `{ refused: "calendar-off" }`.
    Refused { refused: &'static str },
    /// `{ failed: <code> }`: the read did not answer with a document (a fixed code, never the engine's text).
    Failed { failed: &'static str },
    /// The list, `gate: "held"` or `"read"`.
    List(DetailsList),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailsList {
    pub gate: &'static str,
    /// The engine's read time (ISO 8601).
    pub read_at: String,
    pub reader_outdated: bool,
    pub events: Vec<EventView>,
    pub sources: Vec<SourceView>,
}

/// One event, as the timeline, the card and the tile need it. NEVER a URL: only the Join host.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub handle: String,
    pub title: String,
    pub location: Option<String>,
    pub row_text: String,
    pub time: serde_json::Value,
    pub status: String,
    pub ended: bool,
    /// `none`, `one` or `several`.
    pub link_state: &'static str,
    pub join_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_name: Option<String>,
    pub needs_confirm: bool,
    pub from_mac: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    pub id: String,
    pub kind: String,
    /// Present only when the source was read (a skipped source has none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub skipped: bool,
    /// The last-status table's entry; `null` reads "not read yet".
    pub last: Option<LastView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastView {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub at: String,
}

/* ── the held state ───────────────────────────────────────────────────────────────────────────── */

/// One remembered command-link URL. ⚠ NO `Debug`, `Clone` OR `Serialize`; the URL is a [`crate::calendar::LinkUrl`]
/// (redacting `Debug`, no `Display`/`Serialize`/`Clone`), and the only reader of its bytes here is the snapshot,
/// [`handback_buffer`].
struct HeldLink {
    id: LinkId,
    /// The engine's per-entry hash, 64 lowercase hex characters (checked before it is held).
    entry_hash: String,
    url: Option<crate::calendar::LinkUrl>,
}

/// One event of the held read. ⚠ NO `Debug`, `Clone` OR `Serialize`: it holds the join URL, the people and the notes.
struct HeldEvent {
    handle: String,
    title: String,
    location: Option<String>,
    row_text: String,
    time: serde_json::Value,
    status: String,
    ended: bool,
    from_mac: bool,
    people: Option<Vec<(Option<String>, bool)>>,
    notes: Option<String>,
    /// `(title, notes)` per other view of a near-duplicate merge; `None` when the answer had none.
    other_notes: Option<Vec<(Option<String>, String)>>,
    join: Option<HeldJoin>,
}

/// The event's Join candidate (`src/calendar/join.ts`). ⚠ NO `Debug`, `Clone` OR `Serialize`.
enum HeldJoin {
    Several,
    One { url: String, host: String, service_name: Option<String>, needs_confirm: bool },
}

struct HeldSource {
    id: String,
    kind: String,
    status: Option<String>,
    reason: Option<String>,
}

/// One answered read. ⚠ NO `Debug`, `Clone` OR `Serialize`.
struct HeldRead {
    /// Today, when the read was decided (`Now::local_date`). Each handle carries the read's own unguessable
    /// generation, so a handle from another read matches no event here.
    day: String,
    config_gen: String,
    /// Rust's clock when the read answered, for the timer's backstop.
    answered_at: i64,
    read_at: String,
    reader_outdated: bool,
    events: Vec<HeldEvent>,
    sources: Vec<HeldSource>,
}

struct LastStatus {
    status: String,
    reason: Option<String>,
    at: String,
    /// The link's entry hash when it was recorded (`None` for a source that is not a command link).
    entry_hash: Option<String>,
}

/// Everything held. ⚠ NO `Debug`, `Clone` OR `Serialize`.
#[derive(Default)]
struct DetailsState {
    read: Option<HeldRead>,
    links: Vec<HeldLink>,
    last: Vec<(String, LastStatus)>,
    /// `status --json`'s `paths.configPath`, looked up once per app run.
    config_path: Option<PathBuf>,
    read_seq: u64,
}

/// Launches the Calendar app (`calendar_app_open`). A trait so no test launches anything.
pub trait CalendarAppSink: Send + Sync {
    /// `url` is [`calendar_date_url`]'s, built from Rust's clock alone, never from an event.
    fn open_calendar_app(&self, url: &str) -> Result<(), String>;
}

/// Calendar.app's own date link for the instant `epoch_secs`: `ical://date/<UTC yyyy-MM-dd_HH-mm-ss>?method=show`.
/// Calendar shows the day that instant falls on in its own zone, which is the machine's, so "now" lands on today.
///
/// ⚠ Apple does not document it. Read from Calendar's binary on macOS 26.5.2 (25F84) and measured there by hand,
/// 2026-10-31: the handler takes host `date`, needs `method=show` (without it Calendar opens and stays put), and
/// parses the first path component with the format above in GMT. `calshow:` (iOS) has no handler on the Mac. If a
/// later macOS drops the link, `open` still launches Calendar, the button's old behaviour.
pub fn calendar_date_url(epoch_secs: i64) -> String {
    let t = crate::schedule_state::utc_civil(epoch_secs);
    format!(
        "ical://date/{:04}-{:02}-{:02}_{:02}-{:02}-{:02}?method=show",
        t.year,
        t.month,
        t.day,
        t.hour,
        t.minute,
        epoch_secs.rem_euclid(60)
    )
}

/// The shipping sink: `/usr/bin/open -b com.apple.iCal <url>`, so the link goes to Calendar and no other `ical:` handler.
pub struct SystemCalendarApp;

impl CalendarAppSink for SystemCalendarApp {
    fn open_calendar_app(&self, url: &str) -> Result<(), String> {
        let status = std::process::Command::new("/usr/bin/open")
            .args(["-b", "com.apple.iCal", url])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| "spawn".to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("exit".to_string())
        }
    }
}

/// The live details' managed state (one, in `lib.rs`). ⚠ NO `Debug`, `Clone` OR `Serialize`.
pub struct CalendarDetails {
    inner: std::sync::Mutex<DetailsState>,
    /// The one-in-flight latch: a read, so the engine's `IN_FLIGHT` guard does not cover it (round-5 LOW).
    run: tokio::sync::Mutex<()>,
    /// **Test harness only**: the config file to read for the config generation (else `status --json`'s).
    config_path: Option<PathBuf>,
    opener: Arc<dyn OpenSink>,
    calendar_app: Arc<dyn CalendarAppSink>,
}

impl Default for CalendarDetails {
    fn default() -> Self {
        Self {
            inner: std::sync::Mutex::new(DetailsState::default()),
            run: tokio::sync::Mutex::new(()),
            config_path: None,
            opener: Arc::new(SystemOpener),
            calendar_app: Arc::new(SystemCalendarApp),
        }
    }
}

impl CalendarDetails {
    /// **Test harness only**: read the config generation from `path` (no `status --json` lookup).
    pub fn with_config_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.config_path = Some(path.into());
        self
    }

    /// **Test harness only**: where Join opens (a recording sink; the real one is `SystemOpener`).
    pub fn with_opener(mut self, opener: Arc<dyn OpenSink>) -> Self {
        self.opener = opener;
        self
    }

    /// **Test harness only**: how Open in Calendar launches (a recording sink).
    pub fn with_calendar_app(mut self, sink: Arc<dyn CalendarAppSink>) -> Self {
        self.calendar_app = sink;
        self
    }

    /// The ONE place the state lock is taken. Not async, so no guard can be held across an `.await`.
    fn with_state<T>(&self, f: impl FnOnce(&mut DetailsState) -> T) -> T {
        let mut guard = self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    }

    /// The remembered command links, as `(id, holds a URL)`, in report order. Never the URL. For tests and
    /// diagnostics.
    pub fn held_links(&self) -> Vec<(String, bool)> {
        self.with_state(|s| s.links.iter().map(|l| (l.id.as_str().to_string(), l.url.is_some())).collect())
    }

    /// Record a read's answer as if a read decided on `now`'s day, under config generation `config_gen`, had just
    /// returned it, and give the reply. The path every answered read takes ([`open_details`]); `pub` so the state
    /// transitions are tested on canned [`DetailsRaw`] values.
    pub fn record_answer(
        &self,
        now: &Now,
        config_gen: &str,
        answer: Result<DetailsRaw, DetailsFailure>,
    ) -> OpenReply {
        self.with_state(|s| apply_answer(s, &now.local_date, config_gen, now.epoch_secs, answer))
    }
}

/// The config generation: a digest of the config file's `calendar` value, canonicalised (`config_save`'s
/// `canonical_json` and `digest`). A missing or unreadable file, or no `calendar` key, is the generation of `null`.
/// Rust's own value for invalidating handles; the engine's per-entry hash is a different value (C-M2-T5).
pub fn config_generation(path: &Path) -> String {
    let calendar = crate::briefing_files::read_single_link_text_capped(path, crate::config_save::MAX_CONFIG_BYTES)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("calendar").cloned())
        .unwrap_or(serde_json::Value::Null);
    crate::config_save::digest(crate::config_save::canonical_json(&calendar).as_bytes())
}

/// `^[0-9a-f]{64}$`, the engine's entry-hash grammar (`LINK_ENTRY_HASH_RE`).
fn is_entry_hash(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The handle of event `index` in read `gen`: `"{gen}.{index}.{hash}"`, the hash over its start and title.
fn handle_of(gen: u64, index: usize, time: &serde_json::Value, title: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    time.to_string().hash(&mut h);
    title.hash(&mut h);
    format!("{gen:016x}.{index}.{:016x}", h.finish())
}

/// What an answer does to the state (C-M3-T8 "After a read that answers"), and the reply.
fn apply_answer(
    s: &mut DetailsState,
    day: &str,
    config_gen: &str,
    answered_at: i64,
    answer: Result<DetailsRaw, DetailsFailure>,
) -> OpenReply {
    let raw = match answer {
        // A read that does not answer: no valid read held; the URLs and last statuses unchanged.
        Err(f) => {
            s.read = None;
            return OpenReply::Failed { failed: failure_code(f) };
        }
        Ok(raw) => raw,
    };
    let Some(read) = raw.into_read() else {
        // The calendar is off: the map purged; the URLs and last statuses unchanged.
        s.read = None;
        return OpenReply::Refused { refused: "calendar-off" };
    };
    let DetailsRead { read_at, events, sources, reader_outdated, links } = read;

    // The URL list becomes exactly the report's well-formed links, a URL kept where it came back and `link_url` takes it.
    let report: Vec<HeldLink> = links
        .into_iter()
        .filter(|l| is_entry_hash(&l.entry_hash))
        .filter_map(|l| {
            let id = link_id(&l.id).ok()?;
            let url = l.url.as_deref().and_then(|u| link_url(u).ok());
            Some(HeldLink { id, entry_hash: l.entry_hash, url })
        })
        .collect();
    // Command links whose report entry was refused (a malformed hash) get neither a URL nor a last status.
    let refused_link = |src: &crate::engine::RawSource| src.kind == "link" && src.command && !report.iter().any(|l| l.id.as_str() == src.id);
    let hash_of = |id: &str| report.iter().find(|l| l.id.as_str() == id).map(|l| l.entry_hash.clone());

    let previous = std::mem::take(&mut s.last);
    let mut last: Vec<(String, LastStatus)> = Vec::new();
    for src in &sources {
        let entry_hash = hash_of(&src.id);
        if src.skipped {
            // Kept only while its own entry is the same (an own-entry change or removal drops it).
            if let Some((_, prev)) = previous.iter().find(|(id, _)| *id == src.id) {
                if prev.entry_hash == entry_hash && !refused_link(src) {
                    last.push((
                        src.id.clone(),
                        LastStatus {
                            status: prev.status.clone(),
                            reason: prev.reason.clone(),
                            at: prev.at.clone(),
                            entry_hash: prev.entry_hash.clone(),
                        },
                    ));
                }
            }
        } else if let Some(status) = &src.status {
            if refused_link(src) {
                continue;
            }
            last.push((
                src.id.clone(),
                LastStatus { status: status.clone(), reason: src.reason.clone(), at: read_at.clone(), entry_hash },
            ));
        }
    }
    s.last = last;
    s.links = report;

    s.read_seq = s.read_seq.wrapping_add(1);
    let gen = std::collections::hash_map::RandomState::new().hash_one(s.read_seq);
    let events = events
        .into_iter()
        .enumerate()
        .map(|(index, e)| HeldEvent {
            handle: handle_of(gen, index, &e.time, &e.title),
            title: e.title,
            location: e.location,
            row_text: e.row_text,
            time: e.time,
            status: e.status,
            ended: e.ended,
            from_mac: e.from_mac,
            people: e.people.map(|people| people.into_iter().map(|p| (p.name, p.organiser)).collect()),
            notes: e.notes,
            other_notes: e.other_notes.map(|other| other.into_iter().map(|o| (o.title, o.notes)).collect()),
            join: e.join.map(|j| match j {
                RawJoin::Several => HeldJoin::Several,
                RawJoin::Known { url, host } => HeldJoin::One { url, host, service_name: None, needs_confirm: false },
                RawJoin::Other { url, host } => HeldJoin::One { url, host, service_name: None, needs_confirm: true },
                RawJoin::Service { url, host, service_name } => {
                    HeldJoin::One { url, host, service_name: Some(service_name), needs_confirm: true }
                }
            }),
        })
        .collect();
    let sources = sources
        .into_iter()
        .map(|src| HeldSource { id: src.id, kind: src.kind, status: src.status, reason: src.reason })
        .collect();
    s.read = Some(HeldRead {
        day: day.to_string(),
        config_gen: config_gen.to_string(),
        answered_at,
        read_at,
        reader_outdated,
        events,
        sources,
    });
    list_reply(s, "read")
}

fn failure_code(f: DetailsFailure) -> &'static str {
    match f {
        DetailsFailure::Malformed => "malformed",
        DetailsFailure::BadArguments => "bad-arguments",
        DetailsFailure::StdinTooLarge => "stdin-too-large",
        DetailsFailure::StdinInvalid => "stdin-invalid",
        DetailsFailure::ConfigUnreadable => "config-unreadable",
        DetailsFailure::Internal => "internal",
        DetailsFailure::Exit(_) => "exit",
    }
}

/// The held read as the webview's list (no URL: only the Join host).
fn list_reply(s: &DetailsState, gate: &'static str) -> OpenReply {
    let Some(read) = &s.read else {
        return OpenReply::Gate { gate: "none" };
    };
    let events = read
        .events
        .iter()
        .map(|e| {
            let (link_state, join_host, service_name, needs_confirm) = match &e.join {
                None => ("none", None, None, false),
                Some(HeldJoin::Several) => ("several", None, None, false),
                Some(HeldJoin::One { host, service_name, needs_confirm, .. }) => {
                    ("one", Some(host.clone()), service_name.clone(), *needs_confirm)
                }
            };
            EventView {
                handle: e.handle.clone(),
                title: e.title.clone(),
                location: e.location.clone(),
                row_text: e.row_text.clone(),
                time: e.time.clone(),
                status: e.status.clone(),
                ended: e.ended,
                link_state,
                join_host,
                service_name,
                needs_confirm,
                from_mac: e.from_mac,
            }
        })
        .collect();
    let sources = read
        .sources
        .iter()
        .map(|src| SourceView {
            id: src.id.clone(),
            kind: src.kind.clone(),
            status: src.status.clone(),
            reason: src.reason.clone(),
            skipped: src.status.is_none(),
            last: s.last.iter().find(|(id, _)| *id == src.id).map(|(_, l)| LastView {
                status: l.status.clone(),
                reason: l.reason.clone(),
                at: l.at.clone(),
            }),
        })
        .collect();
    OpenReply::List(DetailsList {
        gate,
        read_at: read.read_at.clone(),
        reader_outdated: read.reader_outdated,
        events,
        sources,
    })
}

/// The snapshot of the remembered URLs as the read's STDIN document (C-M3-T8, R2-M10 / R3-M4 (a)):
/// `{"links":[{"id":"…","entryHash":"…","url":"…"}…]}`, written into ONE buffer allocated at its exact length, so no
/// reallocation leaves an unwiped copy. Only links holding a URL are listed. The id (`link_id`'s grammar) and the hash
/// (hex, checked when held) need no escaping; the URL is escaped for `"` and `\` (which `link_url` admits), counted in
/// the length. Returns the buffer, its address at allocation and the length computed before it was allocated (the
/// in-module test's no-reallocation and exact-length checks).
///
/// ⚠ THE ONE READER OF A `LinkUrl`'s BYTES BESIDES THE LINK FILE (`link_url_bytes`, pinned). Runs under the state lock.
fn handback_buffer(links: &[HeldLink]) -> (Vec<u8>, *const u8, usize) {
    let held: Vec<(&str, &str, &[u8])> = links
        .iter()
        .filter_map(|l| l.url.as_ref().map(|u| (l.id.as_str(), l.entry_hash.as_str(), link_url_bytes(u))))
        .collect();
    const HEAD: &[u8] = b"{\"links\":[";
    const ID: &[u8] = b"{\"id\":\"";
    const HASH: &[u8] = b"\",\"entryHash\":\"";
    const URL: &[u8] = b"\",\"url\":\"";
    const END: &[u8] = b"\"}";
    const TAIL: &[u8] = b"]}";
    let escaped = |u: &[u8]| u.len() + u.iter().filter(|b| **b == b'"' || **b == b'\\').count();
    let len = HEAD.len()
        + TAIL.len()
        + held.len().saturating_sub(1)
        + held
            .iter()
            .map(|(id, hash, u)| ID.len() + id.len() + HASH.len() + hash.len() + URL.len() + escaped(u) + END.len())
            .sum::<usize>();
    let mut buf: Vec<u8> = Vec::with_capacity(len);
    let at = buf.as_ptr();
    buf.extend_from_slice(HEAD);
    for (n, (id, hash, u)) in held.iter().enumerate() {
        if n > 0 {
            buf.push(b',');
        }
        buf.extend_from_slice(ID);
        buf.extend_from_slice(id.as_bytes());
        buf.extend_from_slice(HASH);
        buf.extend_from_slice(hash.as_bytes());
        buf.extend_from_slice(URL);
        for b in u.iter() {
            if *b == b'"' || *b == b'\\' {
                buf.push(b'\\');
            }
            buf.push(*b);
        }
        buf.extend_from_slice(END);
    }
    buf.extend_from_slice(TAIL);
    (buf, at, len)
}

/// The read's handback: the snapshot, moved into a zeroing [`SecretBytes`] (no copy).
fn snapshot(links: &[HeldLink]) -> LinkHandback {
    let (bytes, _, _) = handback_buffer(links);
    LinkHandback::new(SecretBytes::from_vec(bytes))
}

fn mac_blocked(s: &DetailsState) -> bool {
    s.last.iter().any(|(id, l)| id == "macos" && (l.status == "denied" || l.status == "not-granted"))
}

/// The config generation now, or `None` when no config path is known yet (then no held read can be valid: one is only
/// held after a read, which looked the path up).
fn current_config_gen(state: &CalendarDetails, s: &DetailsState) -> Option<String> {
    state.config_path.as_deref().or(s.config_path.as_deref()).map(config_generation)
}

/// `calendar_details_open`'s body (C-M3-T8 / T9), with the clock and the window injected: the command passes
/// `&LiveEnv` and `|| env.visibility(&app)`, never values sampled before the call.
///
/// One read in flight: the ask takes [`CalendarDetails::run`] first (waiting for a read in flight), and only then
/// samples the window and the clock and decides, so a waiter decides on what is held after that read (R2-M1, R3-M3).
/// The residual (C-M3-T8): `current` is the webview's, sent with the ask, and is not re-sampled.
pub async fn open_details<V: Fn() -> Visibility + Sync>(
    state: &CalendarDetails,
    env: &LiveEnv,
    visibility: &V,
    client: &EngineClient,
    reason: Reason,
    current: Option<CurrentSlide>,
) -> Result<OpenReply, EngineError> {
    let _one_in_flight = state.run.lock().await;
    let seen = visibility();
    let now = env.now();
    let input = state.with_state(|s| {
        let held_valid = match &s.read {
            None => false,
            Some(r) => r.day == now.local_date && current_config_gen(state, s).as_deref() == Some(r.config_gen.as_str()),
        };
        if !held_valid {
            s.read = None;
        }
        DetailsGateInput {
            visibility: seen,
            current,
            reason,
            held_valid,
            since_read_secs: s.read.as_ref().map_or(0, |r| now.epoch_secs - r.answered_at),
            any_link_without_url: s.links.iter().any(|l| l.url.is_none()),
            mac_blocked: mac_blocked(s),
        }
    });
    let (skip_commands, skip_mac) = match decide(input) {
        DetailsDecision::None => return Ok(OpenReply::Gate { gate: "none" }),
        DetailsDecision::Held => return Ok(state.with_state(|s| list_reply(s, "held"))),
        DetailsDecision::RefusedHidden => return Ok(OpenReply::Refused { refused: "hidden" }),
        DetailsDecision::Read { skip_commands, skip_mac } => (skip_commands, skip_mac),
    };
    // The config path, looked up once per app run (a `status --json` read) when no test override is set.
    if state.config_path.is_none() && state.with_state(|s| s.config_path.is_none()) {
        let path = crate::config_save::locate(client)
            .await
            .map_err(|_| EngineError::Spawn { detail: "could not locate the config through `status --json`".into() })?;
        state.with_state(|s| s.config_path = Some(path));
    }
    let config_gen = state.with_state(|s| current_config_gen(state, s)).unwrap_or_default();
    // The handback is snapshotted under the lock, and the guard is gone before the spawn.
    let handback = state.with_state(|s| snapshot(&s.links));
    let answer = client
        .invoke_sealed(Operation::CalendarDetails { skip_mac, skip_commands }, handback)
        .await;
    let finished = env.now();
    if finished.local_date != now.local_date {
        // A read spanning midnight did not answer for this day. Keep URLs/statuses as for any non-answer.
        state.with_state(|s| s.read = None);
        return Ok(OpenReply::Failed { failed: "day-changed" });
    }
    let answered_at = finished.epoch_secs;
    match answer {
        Ok(answer) => Ok(state.with_state(|s| apply_answer(s, &now.local_date, &config_gen, answered_at, answer))),
        Err(e) => {
            // A read that does not answer (the bound, a spawn failure): no valid read held; URLs unchanged.
            state.with_state(|s| s.read = None);
            Err(e)
        }
    }
}

/* ── get, join, the calendar app (C-M3-T9) ────────────────────────────────────────────────────── */

/// `calendar_details_get`'s answer: one event's people, notes and other views' notes, from the map, or `{ refused: "stale" }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum GetReply {
    // Null people preserves unavailable details, separately from a known empty attendee list.
    // `otherNotes` is omitted, not null, when the answer had none (an unmerged or older event).
    Card {
        people: Option<Vec<PersonView>>,
        notes: Option<String>,
        #[serde(rename = "otherNotes", skip_serializing_if = "Option::is_none")]
        other_notes: Option<Vec<OtherNoteView>>,
    },
    Refused { refused: &'static str },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PersonView {
    pub name: Option<String>,
    pub organiser: bool,
}

/// One other view's notes on a merged card: its title when it differs from the shown title, else null.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OtherNoteView {
    pub title: Option<String>,
    pub notes: String,
}

/// `calendar_join`'s answer. NEVER the URL, and never the opener's own text (which could hold it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum JoinReply {
    /// Opened.
    Opened { opened: bool },
    /// Ask first: the host (lowercase, punycode) and, for a notes-list service, its name.
    Ask {
        ask: String,
        #[serde(rename = "serviceName", skip_serializing_if = "Option::is_none")]
        service_name: Option<String>,
    },
    /// `stale` (a handle from another read, day or config generation), `several`, `no-link` or `invalid-link`.
    Refused { refused: &'static str },
    /// `opener`: the opener failed (its error text is not forwarded).
    Failed { failed: &'static str },
}

/// The held event for `handle`, if the read is still valid now: the same day and config generation (Rust reads the
/// config on each get and join; C "The config hash is checked at every use"). The handle carries the read's
/// generation, so a handle from any other read matches nothing.
fn valid_event<'a>(state: &CalendarDetails, s: &'a mut DetailsState, now: &Now, handle: &str) -> Option<&'a HeldEvent> {
    let read = s.read.as_ref()?;
    if read.day != now.local_date || current_config_gen(state, s).as_deref() != Some(read.config_gen.as_str()) {
        s.read = None;
        return None;
    }
    s.read.as_ref()?.events.iter().find(|e| e.handle == handle)
}

/// One card's people, notes and other views' notes (see [`GetReply`]). Reads nothing (no spawn); refuses a stale
/// handle.
pub fn details_get(state: &CalendarDetails, env: &LiveEnv, handle: &str) -> GetReply {
    let now = env.now();
    state.with_state(|s| match valid_event(state, s, &now, handle) {
        None => GetReply::Refused { refused: "stale" },
        Some(e) => GetReply::Card {
            people: e.people.as_ref().map(|people| people.iter().map(|(name, organiser)| PersonView { name: name.clone(), organiser: *organiser }).collect()),
            notes: e.notes.clone(),
            other_notes: e.other_notes.as_ref().map(|other| {
                other.iter().map(|(title, notes)| OtherNoteView { title: title.clone(), notes: notes.clone() }).collect()
            }),
        },
    })
}

/// The held Join candidate, re-validated with the `url` crate before anything opens (C "Join links"): https; no
/// backslash anywhere in the raw string (the parser would read one as `/` and move the host); no username or
/// password; NO PORT WRITTEN, checked on the raw string's authority (the parser drops a written default port, so
/// `https://zoom.us:443/…` would otherwise pass); the host as the parser gives it, lowercase and in its ASCII
/// (punycode) form, which [`join`] then requires to equal the held Join host.
fn joinable(raw: &str) -> Option<url::Url> {
    let scheme = raw.get(..8)?;
    if !scheme.eq_ignore_ascii_case("https://") {
        return None;
    }
    if raw.contains('\\') { return None; }
    let rest = &raw[8..];
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    // A bracketed IPv6 literal carries `:` of its own; a port is a `:` after it.
    let after_host = match authority.strip_prefix('[') {
        Some(v6) => &v6[v6.find(']')? + 1..],
        None => authority,
    };
    if authority.is_empty() || authority.contains('@') || after_host.contains(':') {
        return None;
    }
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return None;
    }
    u.host_str()?;
    Some(u)
}

/// Join by handle: `{ ask }` for an ask-first link until `confirmed`, else opened through the sink.
///
/// `confirmed` is the webview's assertion, not a proof; acceptable under the hub's model because the URL is chosen
/// here, from the map, by handle (C "Join links").
pub fn join(state: &CalendarDetails, env: &LiveEnv, handle: &str, confirmed: bool) -> JoinReply {
    let now = env.now();
    state.with_state(|s| {
        let Some(event) = valid_event(state, s, &now, handle) else {
            return JoinReply::Refused { refused: "stale" };
        };
        let (url, host, service_name, needs_confirm) = match &event.join {
            None => return JoinReply::Refused { refused: "no-link" },
            Some(HeldJoin::Several) => return JoinReply::Refused { refused: "several" },
            Some(HeldJoin::One { url, host, service_name, needs_confirm }) => (url, host, service_name, *needs_confirm),
        };
        // The parsed host must be the held Join host: the one the webview was shown and that decided ask-first.
        let Some(valid) = joinable(url).filter(|v| v.host_str() == Some(host.as_str())) else {
            return JoinReply::Refused { refused: "invalid-link" };
        };
        if needs_confirm && !confirmed {
            return JoinReply::Ask {
                ask: valid.host_str().unwrap_or_default().to_string(),
                service_name: service_name.clone(),
            };
        }
        match state.opener.open_url(valid.as_str()) {
            Ok(()) => JoinReply::Opened { opened: true },
            Err(_) => JoinReply::Failed { failed: "opener" },
        }
    })
}

/// Open in Calendar: macOS only ([`crate::engine::mac_only`]), the Calendar app by bundle id through the sink, on
/// today ([`calendar_date_url`] of `now`, the only meetings the slide shows). Takes nothing from any event.
pub fn app_open(state: &CalendarDetails, env: &LiveEnv, on_macos: bool) -> Result<(), EngineError> {
    crate::engine::mac_only(on_macos)?;
    state
        .calendar_app
        .open_calendar_app(&calendar_date_url(env.now().epoch_secs))
        .map_err(|_| EngineError::Spawn { detail: "could not open the Calendar app".into() })
}

/* ── the commands (C-M3-T9) ───────────────────────────────────────────────────────────────────── */

/// `calendar_details_open`'s request. `deny_unknown_fields`: the webview CANNOT pass a URL.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenRequest {
    pub reason: Reason,
    /// The deck's current slide (`null` when none is, e.g. the Full briefing view).
    pub current: Option<CurrentSlide>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GetRequest {
    pub handle: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct JoinRequest {
    pub handle: String,
    pub confirmed: bool,
}

/// Ask for today's live details: the held read, a new read, or a refusal ([`decide`]). The window and the clock are
/// sampled inside [`open_details`] (after any wait on the read in flight), never here.
#[tauri::command]
pub async fn calendar_details_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    engine: tauri::State<'_, crate::engine::Engine>,
    env: tauri::State<'_, LiveEnv>,
    details: tauri::State<'_, CalendarDetails>,
    request: OpenRequest,
) -> Result<OpenReply, EngineError> {
    let client = engine.client()?;
    let env: &LiveEnv = &env;
    let visibility = || env.visibility(&app);
    open_details(&details, env, &visibility, client, request.reason, request.current).await
}

/// One card's people, notes and other views' notes (see [`GetReply`]), from Rust's map by handle. Reads nothing.
#[tauri::command]
pub async fn calendar_details_get(
    env: tauri::State<'_, LiveEnv>,
    details: tauri::State<'_, CalendarDetails>,
    request: GetRequest,
) -> Result<GetReply, EngineError> {
    Ok(details_get(&details, &env, &request.handle))
}

/// Join by handle (see [`join`]).
#[tauri::command]
pub async fn calendar_join(
    env: tauri::State<'_, LiveEnv>,
    details: tauri::State<'_, CalendarDetails>,
    request: JoinRequest,
) -> Result<JoinReply, EngineError> {
    Ok(join(&details, &env, &request.handle, request.confirmed))
}

/// Open the Calendar app on today (macOS only).
#[tauri::command]
pub async fn calendar_app_open(
    env: tauri::State<'_, LiveEnv>,
    details: tauri::State<'_, CalendarDetails>,
) -> Result<(), EngineError> {
    app_open(&details, &env, cfg!(target_os = "macos"))
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &[
    "calendar_details_open",
    "calendar_details_get",
    "calendar_join",
    "calendar_app_open",
];

/// The handback snapshot, where its buffer is visible (`cargo test --lib handback_snapshot`; plan C-M3-T8, PC-M5).
#[cfg(test)]
mod handback_snapshot_tests {
    use super::*;

    fn held(id: &str, url: Option<&str>) -> HeldLink {
        HeldLink {
            id: link_id(id).expect("a valid id"),
            entry_hash: "0123456789abcdef".repeat(4),
            url: url.map(|u| link_url(u).expect("a valid url")),
        }
    }

    #[test]
    fn handback_snapshot_is_one_exact_capacity_buffer_of_valid_json() {
        let links = [
            held("work", Some("https://h/a\"b\\c")),
            held("none", None),
            held("home", Some("webcal://cal.example/x.ics?k=1")),
        ];
        let (buf, at, len) = handback_buffer(&links);
        let doc: serde_json::Value = serde_json::from_slice(&buf).expect("the snapshot is JSON");
        assert_eq!(
            doc,
            serde_json::json!({ "links": [
                { "id": "work", "entryHash": "0123456789abcdef".repeat(4), "url": "https://h/a\"b\\c" },
                { "id": "home", "entryHash": "0123456789abcdef".repeat(4), "url": "webcal://cal.example/x.ics?k=1" }
            ] })
        );
        assert_eq!(buf.as_ptr(), at, "the buffer was reallocated while it was written");
        // `Vec::with_capacity` promises AT LEAST the asked capacity, so `>=`; and what was computed is exactly what
        // was written (the escaping counted).
        assert!(buf.capacity() >= len);
        assert_eq!(buf.len(), len);
    }

    #[test]
    fn handback_snapshot_with_nothing_held_is_an_empty_list() {
        let (buf, _, len) = handback_buffer(&[held("work", None)]);
        assert_eq!(buf, br#"{"links":[]}"#);
        assert_eq!(len, buf.len());
        let (buf, _, _) = handback_buffer(&[]);
        assert_eq!(buf, br#"{"links":[]}"#);
    }

    /// The largest document Rust can write: ten links, 32-character ids, URLs of exactly `MAX_LINK_URL_BYTES` made of
    /// `https://h/` and then `"` and `\` only. At most 83 231 bytes, the figure C-M2-T6 derives for the engine's
    /// 128 KiB ceiling (`DETAILS_STDIN_MAX_BYTES`).
    #[test]
    fn handback_snapshot_maximal_document_fits_the_engines_ceiling() {
        let tail: String = (0..crate::calendar::MAX_LINK_URL_BYTES - "https://h/".len())
            .map(|i| if i % 2 == 0 { '"' } else { '\\' })
            .collect();
        let url = format!("https://h/{tail}");
        assert_eq!(url.len(), crate::calendar::MAX_LINK_URL_BYTES);
        let links: Vec<HeldLink> = (0..crate::calendar::MAX_LINKS)
            .map(|n| held(&format!("{n}{}", "a".repeat(31)), Some(&url)))
            .collect();
        let (buf, at, len) = handback_buffer(&links);
        assert_eq!(buf.as_ptr(), at);
        assert_eq!(buf.len(), len);
        assert!(buf.len() <= 83_231, "the maximal handback is {} bytes", buf.len());
        assert!(buf.len() < 128 * 1024);
        let doc: serde_json::Value = serde_json::from_slice(&buf).expect("JSON");
        assert_eq!(doc["links"].as_array().expect("links").len(), 10);
        assert_eq!(doc["links"][9]["url"], serde_json::json!(url));
    }

    /// The held types cannot be printed or serialised (compile-time probes, decoys both ways).
    #[test]
    fn handback_snapshot_held_types_are_not_printable() {
        use std::marker::PhantomData;
        struct Probe<T>(PhantomData<T>);
        trait NotDebug {
            const IS_DEBUG: bool = false;
        }
        impl<T> NotDebug for Probe<T> {}
        impl<T: std::fmt::Debug> Probe<T> {
            #[allow(dead_code)]
            const IS_DEBUG: bool = true;
        }
        struct DProbe<T>(PhantomData<T>);
        trait NotDisplay {
            const IS_DISPLAY: bool = false;
        }
        impl<T> NotDisplay for DProbe<T> {}
        impl<T: std::fmt::Display> DProbe<T> {
            #[allow(dead_code)]
            const IS_DISPLAY: bool = true;
        }
        struct SProbe<T>(PhantomData<T>);
        trait NotSerialize {
            const IS_SERIALIZE: bool = false;
        }
        impl<T> NotSerialize for SProbe<T> {}
        impl<T: serde::Serialize> SProbe<T> {
            #[allow(dead_code)]
            const IS_SERIALIZE: bool = true;
        }
        struct Plain;
        assert!(Probe::<String>::IS_DEBUG && !Probe::<Plain>::IS_DEBUG);
        assert!(DProbe::<String>::IS_DISPLAY && !DProbe::<Plain>::IS_DISPLAY);
        assert!(SProbe::<String>::IS_SERIALIZE && !SProbe::<Plain>::IS_SERIALIZE);
        assert!(!Probe::<HeldLink>::IS_DEBUG && !DProbe::<HeldLink>::IS_DISPLAY && !SProbe::<HeldLink>::IS_SERIALIZE);
        assert!(!Probe::<HeldEvent>::IS_DEBUG && !DProbe::<HeldEvent>::IS_DISPLAY && !SProbe::<HeldEvent>::IS_SERIALIZE);
        assert!(!Probe::<HeldJoin>::IS_DEBUG && !SProbe::<HeldJoin>::IS_SERIALIZE);
        assert!(!Probe::<HeldRead>::IS_DEBUG && !SProbe::<HeldRead>::IS_SERIALIZE);
        assert!(!Probe::<DetailsState>::IS_DEBUG && !SProbe::<DetailsState>::IS_SERIALIZE);
        assert!(!Probe::<CalendarDetails>::IS_DEBUG && !SProbe::<CalendarDetails>::IS_SERIALIZE);
    }
}
