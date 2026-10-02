//! T10 — the state-dir watcher. What makes a CLI-initiated run appear in the GUI live.
//!
//! A developer who types `daily-briefing` in a terminal, or whose launchd agent fires at 07:24,
//! must see the app's Today screen update without touching it. That is the concrete form of
//! "CLI users stay first-class" (appendix §13), and it is the main job of this module: watch the
//! engine's state directory, debounce, re-read `status --json` through a [`SnapshotSource`], and
//! emit `state:changed`. Its second job is the one a file watcher cannot do by itself: notice that
//! TIME has changed the answer (see property 5).
//!
//! ## Six properties, each with a reason
//!
//! 1. ⚠ **THE PATH COMES FROM `status --json`, NEVER FROM A RECOMPUTATION.** `src/json.ts`'s
//!    `StatePaths` docstring is explicit: one implementation of `stateDirFor` ("macOS →
//!    ~/Library/Application Support, Windows → %LOCALAPPDATA%, else XDG, and
//!    `DAILY_BRIEFING_STATE_DIR` overrides all three") exists so a second one cannot drift — and
//!    the failure mode of drift here is *a shell watching a directory the engine no longer writes
//!    to*, which looks exactly like a working app that never updates. [`WatchTargets::from_status`]
//!    is the only constructor that reads a path, and it reads `paths.stateDir`.
//! 2. ⚠ **IT NEVER WRITES INTO THE WATCHED DIRECTORY.** Not a line of it opens a file for writing;
//!    the only filesystem calls are `stat`/`realpath` for the promotion/recovery check, and the
//!    only engine operations its source runs are `status --json` and `schedule status --json`,
//!    both of which the engine documents as pure reads. `tests/watcher.rs`'s
//!    `the_watcher_never_writes_into_the_directory_it_watches` asserts it with a before/after tree
//!    hash rather than by reading the code.
//! 3. ⚠ **A MISSING, REPLACED OR RE-POINTED STATE DIRECTORY IS NORMAL**, not an error: a fresh
//!    install has no state dir until the first run, and a user may delete it, or swap it for a
//!    symlink, with the app open. The watcher watches the PARENT as well as the target, and every
//!    [`RECOVERY_POLL`] compares the directory's IDENTITY — its canonical path and, on unix, its
//!    device and inode — with the one it watched. Any difference re-takes the watch. (A notify
//!    backend filters events by the canonical path it saw AT WATCH TIME, so a symlink re-pointed
//!    elsewhere delivered nothing until restart — measured, and the reason identity includes the
//!    canonical path rather than only existence.)
//! 4. ⚠ **THE DEBOUNCE IS A SCHEDULER, NOT A DEDUPLICATOR.** Its output is not "the events that
//!    happened" but "re-read the engine now", and the interesting question is how many ENGINE
//!    SPAWNS a burst of writes can cost. Hence a quiet period AND a ceiling: without the ceiling a
//!    continuously-written file never settles and the UI never updates at all. See [`Debounce`].
//! 5. ⚠ **TIME CHANGES THE ANSWER WITH NO FILE CHANGING.** A scheduler that has DIED writes
//!    nothing, and a delivered day becomes an undelivered one at midnight — so a state recomputed
//!    only on file events would show "waiting" forever over a dead agent. The loop keeps the last
//!    envelopes and re-runs [`crate::schedule_state::derive`] over them (no engine spawn) at the
//!    next instant [`crate::schedule_state::next_boundary`] names, and at least every
//!    [`REDERIVE_EVERY`] besides, emitting ONLY when the snapshot changed. The clock is an
//!    injectable function ([`WatchOptions::clock`]) so `tests/watcher.rs` can walk the loop past a
//!    stale deadline and across midnight.
//! 6. ⚠ **A PURE RE-DERIVE IS ONLY HONEST BETWEEN THE INSTANTS THE ENGINE ITSELF RECOMPUTES.**
//!    `schedule status --json` recomputes `ticksToday`, `ticksExpectedSinceFloor`, `lastTickState`,
//!    `unitPresent` and `registered` (a live `launchctl` probe) on EVERY call
//!    (`src/schedule/status.ts`), and an unloaded unit writes nothing under the state directory. So
//!    the loop does a REAL read of both envelopes (a) for every served file-event batch, (b) when
//!    the clock crosses local midnight, the floor or the stale deadline
//!    ([`crate::schedule_state::crosses_read_boundary`]), and (c) at most every
//!    [`UNHEALTHY_READ_EVERY`] while the snapshot is in a state a unit load/unload can change with
//!    no file event — AGENT-STALE, SCHEDULER-BROKEN, NOT-SCHEDULED — or is itself degraded (no
//!    state, or a failed read). Only the ≤ 60 s cadence in between stays a pure re-derive.
//!
//! ## What that costs, in engine spawns (each read is `status --json` + `schedule status --json`)
//!
//!   * **A healthy, idle scheduler** (`StartInterval 600`): one batch per tick — the tick's
//!     `last-tick` / `last-skip.json` writes land milliseconds apart — so 2 spawns per 10 minutes
//!     (12 an hour), 4 for the tick that delivers (its stamp and its delivery land more than the
//!     1 s ceiling apart), plus 2 at midnight and 2 at the floor. The stale deadline moves forward
//!     with every tick, so a healthy scheduler never reaches it.
//!   * **A dead or unloaded scheduler**: no file events, so the periodic read — 2 spawns every
//!     5 minutes (24 an hour, 576 a day) — plus the midnight and floor reads.
//!   * **Something writing continuously**: the debounce's bound, `ceil(d / 1 s) + 1` batches for a
//!     burst lasting `d`, at 2 spawns each.
//!
//! Those three are COMPUTED from the loop. Three mixed cases cost more, and these figures are
//! MEASURED rather than computed — by the round-2 cold verifier (source: b4v4), against a fake
//! engine over 2 simulated hours at 60× time:
//!
//!   * **Healthy, but a tick's skip record lands more than the 1 s ceiling after its heartbeat**
//!     (a slow offline check): two batches per tick — **23 spawns an hour**.
//!   * **Unhealthy while ticks still land** (SCHEDULER-BROKEN with a unit that still fires, or a
//!     `schedule status` that keeps failing): a batch per tick plus a periodic read five minutes
//!     after each — **25 an hour**.
//!   * **Both**: **35 an hour**.
//!
//! ## What is watched, and what is deliberately not
//!
//! [`WATCHED_NAMES`] plus the `briefings/` subtree. `briefing.log` and `run.lock` are excluded on
//! purpose: the log is appended by EVERY tick (~144 times a day under `StartInterval 600`) and the
//! lock is created and removed around every run, so including them would spend two engine spawns
//! per tick to learn nothing the four state files do not already say.
//!
//! And only a CHANGE to those counts. An event that reports a READ — Linux inotify's `IN_OPEN`,
//! raised by the engine's own reads of these very files — is not one; counted, it re-reads the
//! engine forever. See [`is_change`].
//!
//! ## A panic stops the loop LOUDLY
//!
//! The loop body runs under `catch_unwind`. If it panics — a source, a sink or the loop itself —
//! the thread ends, and before it does it emits one last snapshot with
//! [`Snapshot::updates_stopped`] set and an `error` that says live updates have stopped, so the tray
//! and the window say so instead of freezing on the last state as though it were current. The
//! shipping sink records that notice, and `state_snapshot` repeats it on every later read, so a
//! webview refresh does not clear it while the tray keeps it.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::event::{AccessKind, AccessMode, MetadataKind, ModifyKind};
use notify::{EventKind, RecursiveMode, Watcher as _};
use serde::Serialize;

use crate::schedule_state::{self, LastSkip, Now, Phase, ScheduleState, ScheduleView, StatusView};

/* ── what counts as a change ──────────────────────────────────────────────────────────────────── */

/// The state-dir entries whose change means the app's view is out of date.
///
/// Appendix T10 names `last-run`, `last-tick`, `briefing-latest.md` and `briefings/`;
/// `last-skip.json` is added because plan R1 made it the skip source (T14 derives from it), and
/// `schedule.json` because the same task requires `schedule status --json` to be re-read "when the
/// schedule file or unit changed" — an install or uninstall rewrites the record, and its batch
/// re-reads both envelopes like every other. Both additions are in the deviation register. The
/// UNIT half of "changed" writes nothing here at all (a `launchctl bootout` touches no state file),
/// which is what the boundary and periodic reads are for (module header, property 6).
pub const WATCHED_NAMES: &[&str] = &[
    "last-run",
    "last-tick",
    "last-skip.json",
    "briefing-latest.md",
    "schedule.json",
];

/// Subdirectories of the state dir whose CONTENTS matter. `briefings/` is the dated archive.
pub const WATCHED_DIRS: &[&str] = &["briefings"];

/// Whether an event of this KIND can mean a file changed — as opposed to having been READ. The
/// loop counts an event only when this and [`WatchTargets::is_interesting`] both hold.
///
/// ⚠ A READ IS NOT A CHANGE, AND ON LINUX COUNTING ONE IS A LOOP. `notify`'s inotify backend puts
/// `IN_OPEN` in every watch's mask (`notify-8.2.0/src/inotify.rs:425-433`) and reports it as
/// `Access(Open(Any))` (:349-356). So the engine opening `last-run` to answer `status --json`, and
/// `notify`'s own walk of the directory when the recursive watch is taken (:407), each arrive as an
/// event on an interesting path — and counted, every re-read schedules the next one. MEASURED on
/// the first Linux `cargo test` (Phase E M2): 6 emits in a 1.5 s window in which only excluded
/// files were touched, and 11 failures in `tests/watcher.rs`. FSEvents emits no `Access` kind at all
/// (`fsevent.rs`), which is why macOS never showed it.
///
/// So every `Access` kind is ignored EXCEPT `Access(Close(Write))` — `IN_CLOSE_WRITE` (:325-331), a
/// handle opened FOR WRITING was closed. A read cannot produce it (neither the watcher nor the
/// engine's reads open a watched file for writing), and it is the one signal inotify can give for a
/// write it never reports as `IN_MODIFY` (one made through `mmap`, per inotify(7)). An ordinary
/// write already arrives as `Modify`/`Create`, so keeping it costs at most one more batch, bounded
/// by the debounce.
///
/// `Modify(Metadata(AccessTime))` is the same echo — an atime update is what a read causes — and is
/// ignored too. No `notify` 8.2.0 backend emits it (inotify maps `IN_ATTRIB` to `Metadata(Any)`,
/// :341-347), so that arm guards a backend that starts to rather than fixing one that does.
/// `Metadata(Any)` stays a change: a `chmod` or `utimensat` is one, and it cannot be told apart.
/// `Any` and `Other` stay changes too — an event the backend could not classify is no evidence of
/// a read.
pub fn is_change(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)) => false,
        EventKind::Any
        | EventKind::Create(_)
        | EventKind::Modify(_)
        | EventKind::Remove(_)
        | EventKind::Other => true,
    }
}

/// Whether ONE backend event means the app's view may be stale — the loop's whole per-event rule.
/// Either of:
///
///   * a RESCAN notice ([`notify::Event::need_rescan`]) that can COVER the state dir: one with no
///     path at all, or whose path is the state dir, one of its ancestors
///     ([`WatchTargets::encloses_state_dir`]), or an interesting path inside it
///     ([`WatchTargets::is_interesting`]). A rescan means "events were DROPPED under this path", so
///     any of those could have been a change to a watched file, and it is served like one: a real
///     re-read of both envelopes. A re-read cannot feed itself: the engine's reads are `Access`
///     events, which are not changes.
///   * a CHANGE ([`is_change`]) to an interesting path.
///
/// WHICH RESCAN PATHS CAN ARRIVE AT ALL, measured against `notify` 8.2.0's two shipped backends
/// (the Windows backend emits no `Flag::Rescan`):
///
///   * **inotify**: `IN_Q_OVERFLOW` becomes `Other` + `Flag::Rescan` with NO path
///     (`notify-8.2.0/src/inotify.rs:212-214`) — the kernel queue overflowed and nothing says
///     where, so it always counts. Before Phase E final harden (M2 verifier item 2) this notice
///     failed `is_interesting` and was dropped: a burst that overflowed the queue could leave the
///     app stale until the next boundary or periodic read.
///   * **FSEvents**: `MustScanSubDirs` becomes `Other` + `Flag::Rescan` (`fsevent.rs:116-125`)
///     carrying the event's own path (`:572`) — the directory under which events were coalesced or
///     dropped; Apple's `FSEvents.h` gives `/Users/jsmith` for coalesced events in two of its
///     children. ⚠ `notify` DROPS every event whose path is not under a watched root, before the
///     loop ever sees it (`fsevent.rs:549-566`): it keeps a path only if it IS a watched root, lies
///     under a RECURSIVELY watched one, or is a direct child of a NON-recursively watched one.
///     This loop watches two roots (`spawn_inner`): the state dir recursively and its PARENT
///     non-recursively — keyed by their canonical paths (`fsevent.rs:392,407`). So a rescan
///     reaches here only for the state dir or a path inside it, the parent itself (coalesced over
///     the state dir and a sibling — it counts, as an ancestor), or a direct child of the parent
///     other than the state dir: a SIBLING, such as another app's folder in
///     `~/Library/Application Support`. A sibling's rescan says nothing about the state dir, and
///     counting it (as this rule did in round 1, for any path) served a spurious re-read for every
///     rescan anywhere beside the state dir (round 2: B-M4, D-L1, A-L2). A path INSIDE the state dir
///     that is not interesting (an excluded file or an unknown subdirectory) cannot cover a watched
///     file either, so it does not count.
///
/// ⚠ An ancestor is matched against the roots this watcher knows (the engine's spelling and, once
/// the directory has existed, its resolved one). Before the state dir first exists only the
/// engine's spelling is known, so a rescan carrying a resolved parent (`/private/var/…` for
/// `/var/…`) is not matched — harmless: what it could stand for is the directory's creation, which
/// the [`RECOVERY_POLL`] identity check serves anyway.
pub fn counts_as_change(event: &notify::Event, targets: &WatchTargets) -> bool {
    if event.need_rescan() {
        event.paths.is_empty()
            || event
                .paths
                .iter()
                .any(|p| targets.encloses_state_dir(p) || targets.is_interesting(p))
    } else {
        is_change(&event.kind) && event.paths.iter().any(|p| targets.is_interesting(p))
    }
}

/// The `info` tag [`StateWatcher::inject`] puts on every event it hands the loop, so the loop can
/// count the injected ones apart from whatever the real backend delivers meanwhile. **Test harness
/// only**: it changes nothing about how an event is judged.
#[doc(hidden)]
pub const INJECTED: &str = "daily-briefing:injected";

/// The directory this watcher is pointed at, and the prefixes an event path may legitimately carry
/// for it.
///
/// ⚠ TWO ROOTS, AND THE SECOND ONE IS NOT PARANOIA — IT IS macOS. The engine's state dir under a
/// test sandbox is typically `$TMPDIR/...`, i.e. `/var/folders/...`, and `/var` is a symlink to
/// `/private/var`. FSEvents reports the RESOLVED path, so an event arrives as
/// `/private/var/folders/...` while `paths.stateDir` says `/var/folders/...` and a naive
/// `strip_prefix` matches nothing at all — a watcher that runs, receives every event, and discards
/// every one of them. Both spellings are kept and either matches; the resolved one is REPLACED
/// whenever the directory is re-watched, so a re-pointed symlink's old target stops matching.
#[derive(Debug, Clone)]
pub struct WatchTargets {
    /// The path as the ENGINE reports it. This is the one that is watched and re-watched.
    pub state_dir: PathBuf,
    /// `state_dir` plus, when it differs, its canonical form.
    roots: Vec<PathBuf>,
}

impl WatchTargets {
    pub fn new(state_dir: impl Into<PathBuf>) -> Self {
        let state_dir = state_dir.into();
        let mut targets = Self {
            roots: vec![state_dir.clone()],
            state_dir,
        };
        // `canonicalize` fails when the directory does not exist yet — the fresh-install case — and
        // that is fine: the resolved spelling is set later, when the loop takes the watch.
        if let Ok(resolved) = std::fs::canonicalize(&targets.state_dir) {
            targets.set_resolved(resolved);
        }
        targets
    }

    /// The state directory as `status --json` reports it. **The only path source.**
    pub fn from_status(status: &StatusView) -> Option<Self> {
        status
            .paths
            .state_dir
            .as_ref()
            .filter(|p| !p.is_empty())
            .map(Self::new)
    }

    /// Replace the resolved spelling. Idempotent.
    fn set_resolved(&mut self, resolved: PathBuf) {
        self.roots.truncate(1);
        if resolved != self.state_dir {
            self.roots.push(resolved);
        }
    }

    /// Whether `path` is the state directory or one of its ancestors, in either spelling — the
    /// rescan paths that can cover it ([`counts_as_change`]). Component-wise, so `/tmp/sta` is not
    /// an ancestor of `/tmp/state`.
    pub fn encloses_state_dir(&self, path: &Path) -> bool {
        self.roots.iter().any(|root| root.starts_with(path))
    }

    /// Whether a change at `path` means the app's view is stale.
    ///
    /// The state directory ITSELF counts: its creation is the promotion trigger and its removal is
    /// the recovery trigger.
    pub fn is_interesting(&self, path: &Path) -> bool {
        for root in &self.roots {
            if path == root {
                return true;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                let Some(first) = rel.components().next() else {
                    return true; // the root itself, spelled with a trailing separator
                };
                let name = first.as_os_str();
                if WATCHED_NAMES.iter().any(|n| name == *n)
                    || WATCHED_DIRS.iter().any(|d| name == *d)
                {
                    return true;
                }
            }
        }
        false
    }
}

/// What makes "the same directory" the same: where it resolves to and, on unix, which inode it
/// is. A delete-and-recreate (new inode) or a symlink re-pointed elsewhere (new canonical path)
/// both differ, and both need the watch re-taken.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DirIdentity {
    canonical: PathBuf,
    /// `(device, inode)` on unix; `(0, 0)` elsewhere, where the canonical path is all there is.
    file_id: (u64, u64),
}

fn dir_identity(path: &Path) -> Option<DirIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    #[cfg(unix)]
    let file_id = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(not(unix))]
    let file_id = (0, 0);
    Some(DirIdentity { canonical, file_id })
}

/* ── the debounce ─────────────────────────────────────────────────────────────────────────────── */

/// How long the directory must be quiet before the engine is re-read.
///
/// Appendix T10's own number. It is long enough that the engine's own multi-file write of a
/// delivery (`briefing-latest.md`, the dated archive, `last-run`, `last-tick`, and the removal of
/// `last-skip.json`) coalesces into ONE re-read, and short enough that a person watching the window
/// does not notice the gap.
pub const DEBOUNCE_QUIET: Duration = Duration::from_millis(250);

/// The longest a stream of changes may postpone a re-read.
///
/// ⚠ WITHOUT THIS, A FILE THAT IS WRITTEN CONTINUOUSLY NEVER SETTLES AND THE UI NEVER UPDATES.
/// A quiet-period-only debounce is a starvation bug wearing a performance costume. One second is
/// the bound on how stale the Today screen can be while something is writing.
pub const DEBOUNCE_CEILING: Duration = Duration::from_millis(1000);

/// Quiet-period + ceiling coalescer. **Pure**: it owns no clock, no channel and no filesystem, so
/// `tests/watcher.rs` drives it with synthetic [`Instant`]s and asserts the bound directly rather
/// than inferring it from a flaky timing test.
///
/// The bound it guarantees, and the one the test measures: a burst lasting `d` produces at most
/// `ceil(d / ceiling) + 1` re-reads — the `+1` being the final quiet-period fire after the burst
/// ends.
#[derive(Debug, Clone)]
pub struct Debounce {
    quiet: Duration,
    ceiling: Duration,
    /// When the current, unserved batch started.
    first: Option<Instant>,
    /// The most recent change in the current batch.
    last: Option<Instant>,
}

impl Debounce {
    pub fn new(quiet: Duration, ceiling: Duration) -> Self {
        Self {
            quiet,
            ceiling,
            first: None,
            last: None,
        }
    }

    /// Note a change at `at`.
    pub fn record(&mut self, at: Instant) {
        if self.first.is_none() {
            self.first = Some(at);
        }
        self.last = Some(at);
    }

    /// Whether anything is waiting to be served.
    pub fn pending(&self) -> bool {
        self.last.is_some()
    }

    /// Whether the batch should be served at `at`: the directory has been quiet for `quiet`, or the
    /// batch has been open for `ceiling`.
    pub fn due(&self, at: Instant) -> bool {
        match (self.first, self.last) {
            (Some(first), Some(last)) => {
                at.duration_since(last) >= self.quiet || at.duration_since(first) >= self.ceiling
            }
            _ => false,
        }
    }

    /// How long to wait before [`Debounce::due`] can next become true. `None` when nothing is
    /// pending.
    pub fn wait_from(&self, at: Instant) -> Option<Duration> {
        let (first, last) = (self.first?, self.last?);
        let by_quiet = (last + self.quiet).saturating_duration_since(at);
        let by_ceiling = (first + self.ceiling).saturating_duration_since(at);
        Some(by_quiet.min(by_ceiling))
    }

    /// Clear the batch. Called after the re-read has been dispatched.
    pub fn take(&mut self) {
        self.first = None;
        self.last = None;
    }
}

/* ── what the watcher produces ────────────────────────────────────────────────────────────────── */

/// The `state:changed` payload, and what `state_snapshot` returns.
///
/// ⚠ `status` AND `schedule` ARE THE ENGINE'S ENVELOPES, UNINTERPRETED. The app's interpretation is
/// `scheduleState`, and it is computed ONCE, in Rust, by [`schedule_state::derive`]. The webview
/// renders it; it does not recompute any part of it, and it does not need to parse the envelopes to
/// know what to say.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// The parsed `status --json` payload, or `null` when the call failed.
    pub status: Option<serde_json::Value>,
    /// `status.lastSkip`, lifted out because it is the one nested object every surface wants.
    ///
    /// ⚠ FROM `status` ONLY. It used to fall back to the schedule envelope's copy, which — once
    /// that envelope could be a cached one — resurrected a skip the engine had already cleared.
    /// `status` is read in every batch and carries the same record, so the fallback bought nothing.
    pub last_skip: Option<LastSkip>,
    /// The parsed `schedule status --json` payload READ IN THE SAME BATCH as `status` — unless
    /// `scheduleStale` is true, in which case this batch's read failed (`error` says why) and this
    /// is the last good envelope from an EARLIER read — or `null` when there has never been one.
    pub schedule: Option<serde_json::Value>,
    /// True when `schedule` is a cached envelope from an earlier read rather than this batch's.
    ///
    /// ⚠ A STALE SCHEDULE HALF IS KEPT, NOT PRESENTED AS CURRENT. It still supplies the owner, the
    /// interval and the registration the derivation needs (a state derived without them is a
    /// different and worse state), but the per-read facts it carries — `ticksToday`,
    /// `ticksExpectedSinceFloor`, `lastTickState` — are withheld from `scheduleState` (they read as
    /// `null`, i.e. "unknown"), because they were true of a different moment.
    pub schedule_stale: bool,
    /// The derived state, or `null` when `status` could not be read — in which case there is
    /// nothing honest to derive from and a fabricated state would be the worst possible answer.
    pub schedule_state: Option<ScheduleState>,
    /// Why part of this snapshot is missing or stale, in the engine's own words (its stderr,
    /// verbatim) where it gave any: a `status` read that failed (every other field is then null),
    /// a `schedule status` read that failed (the schedule half is then the last good envelope and
    /// `scheduleStale` is true, or null), or — with `updatesStopped` — the watcher itself. Never a
    /// paraphrase of the engine; when the engine said nothing, a plain statement of what happened —
    /// the exit code, the signal, the timeout.
    pub error: Option<String>,
    /// True when the watcher has STOPPED (its thread panicked) and nothing will update this
    /// snapshot again until the app restarts. The tray says so, and `error` says why.
    pub updates_stopped: bool,
}

impl Snapshot {
    /// The snapshot for "the engine could not be read at all".
    pub fn unavailable(error: impl Into<String>) -> Self {
        Self {
            status: None,
            last_skip: None,
            schedule: None,
            schedule_stale: false,
            schedule_state: None,
            error: Some(error.into()),
            updates_stopped: false,
        }
    }

    /// Build one from two envelopes READ TOGETHER. Pure apart from `now`, which the caller supplies.
    pub fn build(
        status_payload: Option<serde_json::Value>,
        schedule_payload: Option<serde_json::Value>,
        now: &Now,
        error: Option<String>,
    ) -> Self {
        Self::assemble(status_payload, schedule_payload, false, now, error)
    }

    /// Build one whose schedule half is a CACHED envelope from an earlier read, because this
    /// batch's `schedule status` failed. `error` should say why. See [`Snapshot::schedule_stale`].
    pub fn with_stale_schedule(
        status_payload: Option<serde_json::Value>,
        cached_schedule: serde_json::Value,
        now: &Now,
        error: Option<String>,
    ) -> Self {
        Self::assemble(status_payload, Some(cached_schedule), true, now, error)
    }

    fn assemble(
        status_payload: Option<serde_json::Value>,
        schedule_payload: Option<serde_json::Value>,
        schedule_stale: bool,
        now: &Now,
        error: Option<String>,
    ) -> Self {
        // ⚠ A payload that does not fit the view is NOT an error: the envelope is frozen
        // additive-only, so unknown keys are expected, and every field of `StatusView` has a
        // default. What `serde_json::from_value` can still refuse is a wrong TYPE — a string where
        // a bool belongs — and that degrades to "no derived state", never to a panic.
        let (status, mut schedule) =
            Self::views(status_payload.as_ref(), schedule_payload.as_ref());
        if schedule_stale {
            if let Some(s) = schedule.as_mut() {
                // The facts `schedule status` recomputes on every call, withheld rather than shown
                // as current. `lastTickState` goes with the counts: `status.lastTick` (current) is
                // what staleness is judged from, and a cached "legacy" must not pin UNKNOWN-TICK.
                s.ticks_today = None;
                s.ticks_expected_since_floor = None;
                s.last_tick_state = None;
            }
        }
        let last_skip = status.as_ref().and_then(|s| s.last_skip.clone());
        let schedule_state = status
            .as_ref()
            .map(|s| schedule_state::derive(s, last_skip.as_ref(), schedule.as_ref(), now));
        Self {
            status: status_payload,
            last_skip,
            schedule: schedule_payload,
            schedule_stale,
            schedule_state,
            error,
            updates_stopped: false,
        }
    }

    fn views(
        status: Option<&serde_json::Value>,
        schedule: Option<&serde_json::Value>,
    ) -> (Option<StatusView>, Option<ScheduleView>) {
        (
            status.and_then(|v| serde_json::from_value(v.clone()).ok()),
            schedule.and_then(|v| serde_json::from_value(v.clone()).ok()),
        )
    }

    /// The same envelopes, derived again at `now`. **No engine read** — this is how the loop
    /// notices that time, not a file, changed the answer, between the instants where only a real
    /// read is honest (see [`Snapshot::crosses_read_boundary`]).
    pub fn rederive(&self, now: &Now) -> Self {
        Self {
            updates_stopped: self.updates_stopped,
            ..Self::assemble(
                self.status.clone(),
                self.schedule.clone(),
                self.schedule_stale,
                now,
                self.error.clone(),
            )
        }
    }

    /// When [`Snapshot::rederive`] could next produce a different state. See
    /// [`schedule_state::next_boundary`].
    pub fn next_boundary(&self, now: &Now) -> Option<i64> {
        let (status, schedule) = Self::views(self.status.as_ref(), self.schedule.as_ref());
        schedule_state::next_boundary(&status?, schedule.as_ref(), now)
    }

    /// Whether moving the clock from `before` to `after` crosses an instant at which the ENGINE's
    /// answer can change — so the loop must read it again rather than re-derive. See
    /// [`schedule_state::crosses_read_boundary`]. A snapshot with no readable `status` still
    /// crosses at midnight (and on a clock step), which is when a retry is cheapest to justify.
    pub fn crosses_read_boundary(&self, before: &Now, after: &Now) -> bool {
        let (status, schedule) = Self::views(self.status.as_ref(), self.schedule.as_ref());
        schedule_state::crosses_read_boundary(
            &status.unwrap_or_default(),
            schedule.as_ref(),
            before,
            after,
        )
    }

    /// Whether this snapshot is one that can change with NO file event and no time boundary, so
    /// the loop re-reads it every [`UNHEALTHY_READ_EVERY`]: a unit that can be loaded or unloaded
    /// behind the app's back (AGENT-STALE, SCHEDULER-BROKEN, NOT-SCHEDULED), or a snapshot that is
    /// itself degraded (no state, or a read that failed in part).
    pub fn wants_periodic_read(&self) -> bool {
        if self.error.is_some() {
            return true;
        }
        match &self.schedule_state {
            None => true,
            Some(state) => matches!(
                state.phase,
                Phase::AgentStale { .. } | Phase::SchedulerBroken | Phase::NotScheduled
            ),
        }
    }

    /// The last snapshot a stopped watcher sends: `last`'s envelopes and state (still the best
    /// information there is), flagged [`Snapshot::updates_stopped`], with an `error` saying why.
    pub fn stopped(last: Option<&Snapshot>, why: &str) -> Self {
        // ONE line, whatever the panic said (an `assert_eq!` message spans several), so the notice
        // is always `error`'s first line and [`Snapshot::stopped_notice`] can hand it on.
        let why = why.split_whitespace().collect::<Vec<_>>().join(" ");
        let notice = format!(
            "Live updates have stopped: the state-directory watcher failed ({why}). What is shown \
             will not change on its own; restart Daily Briefing to resume live updates."
        );
        let mut snapshot = match last {
            Some(last) => last.clone(),
            None => Snapshot::unavailable(String::new()),
        };
        snapshot.mark_updates_stopped(&notice);
        snapshot
    }

    /// Flag this snapshot as one nothing will update: [`Snapshot::updates_stopped`], with `notice`
    /// leading `error` (any error it already had follows on the next line).
    ///
    /// Also how `shell::state_snapshot` keeps a FRESH read honest once the watcher has stopped — a
    /// webview refresh must not clear what the tray still says.
    pub fn mark_updates_stopped(&mut self, notice: &str) {
        self.error = Some(match self.error.take().filter(|e| !e.is_empty()) {
            Some(previous) => format!("{notice}\n{previous}"),
            None => notice.to_string(),
        });
        self.updates_stopped = true;
    }

    /// The one-line notice a stopped snapshot leads its `error` with — `None` unless
    /// [`Snapshot::updates_stopped`]. What the shipping sink records for `state_snapshot` to repeat.
    pub fn stopped_notice(&self) -> Option<&str> {
        if !self.updates_stopped {
            return None;
        }
        self.error.as_deref().and_then(|e| e.lines().next())
    }
}

/// Where a fresh [`Snapshot`] comes from. A trait so `tests/watcher.rs` can drive the loop with a
/// source it counts, and so the loop itself owns no engine, no runtime and no Tauri handle.
pub trait SnapshotSource: Send + Sync + 'static {
    /// Produce a COMPLETE snapshot from a REAL read of both envelopes.
    ///
    /// ⚠ THERE IS NO "CHEAP" FORM, AND THAT IS A CORRECTION. An earlier version took a
    /// `refresh_schedule` hint and served the schedule half from a cache unless `schedule.json` had
    /// changed — and measured, that paired a CURRENT `status` with a `schedule status` from an
    /// earlier batch: `ticksToday` stayed at 4 while `last-tick` said 11, a legacy heartbeat
    /// replaced by a valid one stayed UNKNOWN-TICK, and an unloaded unit stayed "registered". The
    /// engine recomputes those on every call, so the only honest schedule half is a fresh one. A
    /// cache may exist only as the FALLBACK for a failed read, and then the snapshot says so
    /// ([`Snapshot::with_stale_schedule`]).
    ///
    /// ⚠ BLOCKING, and called only from the watcher's own thread. An implementation may block on
    /// an async runtime (`shell::EngineSnapshots` does), which PANICS if this is called from inside
    /// that runtime — async callers use the implementation's async form instead.
    fn snapshot(&self) -> Snapshot;
}

/// Where a [`Snapshot`] goes. The app's implementation emits `state:changed`.
pub trait StateSink: Send + Sync + 'static {
    fn changed(&self, snapshot: &Snapshot);
}

/* ── the loop ─────────────────────────────────────────────────────────────────────────────────── */

/// How often the loop re-checks whether the state directory has appeared, vanished or been
/// replaced.
///
/// ⚠ A `stat` AND A `realpath`, NOT A DIRECTORY READ, and it is a BACKSTOP rather than the
/// mechanism: the parent watch is what normally notices a create or a delete. This exists because
/// a watch on a directory that is then removed is gone on every backend, and the event that told
/// us so is exactly the one a dropped FSEvents/inotify queue can lose — so the recovery path must
/// not be reachable only through the notification that failed.
pub const RECOVERY_POLL: Duration = Duration::from_millis(500);

/// The longest the loop goes without re-deriving the state from the envelopes it holds, whatever
/// [`schedule_state::next_boundary`] said. It absorbs the boundaries that function cannot foresee:
/// a DST day, a clock step, a zone change, a machine that slept through the named instant.
///
/// ⚠ A PURE RE-DERIVE — no engine spawn. The instants where only a real read is honest are
/// detected separately, as CROSSINGS ([`Snapshot::crosses_read_boundary`]), so a machine that slept
/// through midnight still reads the engine on the first re-derive after it wakes.
pub const REDERIVE_EVERY: Duration = Duration::from_secs(60);

/// How often the loop re-READS the engine, with no file event and no boundary, while the snapshot
/// is one [`Snapshot::wants_periodic_read`] names.
///
/// ⚠ THIS IS THE ONLY WAY AN UNLOAD OR A RELOAD BECOMES VISIBLE BETWEEN BOUNDARIES. `launchctl
/// bootout`/`bootstrap` write nothing under the state directory, and a dead scheduler writes
/// nothing at all. Five minutes bounds the cost at 2 spawns per 5 minutes (24 an hour) and only in
/// the unhealthy states; a healthy scheduler's own ticks are its file events.
pub const UNHEALTHY_READ_EVERY: Duration = Duration::from_secs(300);

/// A clock for the loop's re-derivation. The app's is [`schedule_state::now_local`].
pub type Clock = Arc<dyn Fn() -> Now + Send + Sync>;

/// How a watcher runs. [`WatchOptions::default`] is what the app uses; tests shorten the timings
/// and inject the clock.
pub struct WatchOptions {
    pub quiet: Duration,
    pub ceiling: Duration,
    /// See [`REDERIVE_EVERY`].
    pub rederive_every: Duration,
    /// See [`UNHEALTHY_READ_EVERY`].
    pub unhealthy_read_every: Duration,
    /// What the caller has ALREADY emitted, if anything. The loop's first engine read (taken right
    /// after the watch, so a change between the caller's read and the watch is not lost) is
    /// emitted only when it differs from this — and never when this is `None`, because then there
    /// is no earlier announcement for it to correct.
    pub initial: Option<Snapshot>,
    /// Every snapshot the loop holds is derived at this clock — including the ones it reads, which
    /// are re-derived at it — so a test's hand clock and the loop's state agree.
    pub clock: Clock,
}

impl Default for WatchOptions {
    fn default() -> Self {
        Self {
            quiet: DEBOUNCE_QUIET,
            ceiling: DEBOUNCE_CEILING,
            rederive_every: REDERIVE_EVERY,
            unhealthy_read_every: UNHEALTHY_READ_EVERY,
            initial: None,
            clock: Arc::new(schedule_state::now_local),
        }
    }
}

/// Counters the running loop publishes. What tests wait on INSTEAD OF SLEEPING: "the watch is
/// taken" is an event the loop reports, not a duration a test guesses.
#[derive(Default)]
struct Progress {
    /// Set once the first pass — watch taken (when the directory exists) and first read done — is
    /// complete.
    ready: AtomicBool,
    /// Set when the loop has ended, for any reason.
    stopped: AtomicBool,
    /// How many times a watch on the state directory has been taken.
    arms: AtomicU64,
    /// How many engine reads the loop has asked its source for, of every kind.
    reads: AtomicU64,
    /// Of those, how many were taken because the clock crossed a boundary.
    boundary_reads: AtomicU64,
    /// …and how many because the snapshot was unhealthy and [`UNHEALTHY_READ_EVERY`] had passed.
    periodic_reads: AtomicU64,
    /// How many snapshots it has handed to the sink.
    emitted: AtomicU64,
    /// How many PURE time-driven re-derivations it has run.
    rederives: AtomicU64,
    /// How many events tagged [`INJECTED`] the loop has judged, and how many of those it counted
    /// as a change ([`counts_as_change`]) — the test harness's view of the per-event rule as WIRED.
    ///
    /// ⚠ `injected_seen` IS BUMPED LAST, after `injected_counted` and [`Progress::injected_stamps`]
    /// (Phase E final harden round 4, G4-3): a test waits for `seen` to reach `n` and then reads
    /// the others as EXACT, so `seen` must mean "judged, and every bit of bookkeeping for it done".
    /// Bumped first (as it was in rounds 2 and 3), a preemption between the two increments failed a
    /// correct loop.
    injected_seen: AtomicU64,
    injected_counted: AtomicU64,
    /// The instant the loop judged each COUNTED injected event, in order — the very `Instant` it
    /// handed [`Debounce::record`]. What `tests/watcher.rs` measures a burst's consumer-side span
    /// with (round 4, G4-4). Only [`StateWatcher::inject`] can grow it, so the app's watcher, which
    /// holds no injector, never does.
    injected_stamps: std::sync::Mutex<Vec<Instant>>,
    /// How many REAL (not injected) rescan notices the loop counted as a change.
    rescans_counted: AtomicU64,
}

/// A running watcher. Dropping it stops the thread.
pub struct StateWatcher {
    stop: Arc<AtomicBool>,
    progress: Arc<Progress>,
    handle: Option<std::thread::JoinHandle<()>>,
    /// A second sender into the loop's event channel — present ONLY on a watcher started by
    /// [`spawn_injectable`]. The app's watcher holds none, so its channel still disconnects exactly
    /// when the backend's sender goes, as the loop's `Disconnected` arm expects.
    injector: Option<mpsc::Sender<notify::Result<notify::Event>>>,
}

impl StateWatcher {
    /// How many snapshots this watcher has dispatched. The count `tests/watcher.rs` bounds.
    pub fn emitted(&self) -> u64 {
        self.progress.emitted.load(Ordering::SeqCst)
    }

    /// How many engine reads the loop has requested (its first read included).
    pub fn reads(&self) -> u64 {
        self.progress.reads.load(Ordering::SeqCst)
    }

    /// How many of [`StateWatcher::reads`] a boundary crossing caused.
    pub fn boundary_reads(&self) -> u64 {
        self.progress.boundary_reads.load(Ordering::SeqCst)
    }

    /// How many of [`StateWatcher::reads`] the unhealthy-state period caused.
    pub fn periodic_reads(&self) -> u64 {
        self.progress.periodic_reads.load(Ordering::SeqCst)
    }

    /// How many times a watch on the state directory has been taken.
    pub fn arms(&self) -> u64 {
        self.progress.arms.load(Ordering::SeqCst)
    }

    /// How many PURE time-driven re-derivations have run.
    pub fn rederives(&self) -> u64 {
        self.progress.rederives.load(Ordering::SeqCst)
    }

    /// How many REAL rescan notices — from the backend, not [`StateWatcher::inject`]ed — the loop
    /// has counted as a change ([`counts_as_change`]). Each one can add at most ONE served batch
    /// (one read, one announcement) that no file write caused, and nothing a test does can stop
    /// FSEvents coalescing events onto a watched directory; so an exact read/emit count over a real
    /// backend is exact up to this number (`tests/watcher.rs`, `assert_discounting_rescans`).
    pub fn rescans_counted(&self) -> u64 {
        self.progress.rescans_counted.load(Ordering::SeqCst)
    }

    /// **Test harness only** — hand `event` to the loop through the SAME channel the backend uses,
    /// tagged [`INJECTED`], so the per-event rule's WIRING is observable on every platform (Phase E
    /// final harden, M2 verifier item 4). FSEvents never emits an `Access` kind and never a
    /// `Rescan` on demand, so on macOS no file write can show that the loop consults
    /// [`counts_as_change`]; an injected event can. Panics on a watcher not started by
    /// [`spawn_injectable`].
    #[doc(hidden)]
    pub fn inject(&self, event: notify::Event) {
        let injector = self
            .injector
            .as_ref()
            .expect("inject() needs a watcher started by spawn_injectable");
        let _ = injector.send(Ok(event.set_info(INJECTED)));
    }

    /// **Test harness only** — hand `event` to the loop through the same channel as
    /// [`StateWatcher::inject`] but UNTAGGED, exactly as the backend would, so the loop counts it
    /// with the real events ([`StateWatcher::rescans_counted`]) rather than the injected ones. It is
    /// how `tests/watcher.rs` pins that real-event counter with no backend in the room (Phase E final
    /// harden round 3, B3-L2): nothing a test does makes FSEvents or inotify emit a rescan on demand.
    /// Panics on a watcher not started by [`spawn_injectable`].
    #[doc(hidden)]
    pub fn inject_as_backend(&self, event: notify::Event) {
        let injector = self
            .injector
            .as_ref()
            .expect("inject_as_backend() needs a watcher started by spawn_injectable");
        let _ = injector.send(Ok(event));
    }

    /// **Test harness only** — how many [`StateWatcher::inject`]ed events the loop has judged AND
    /// finished the bookkeeping for: it is incremented after [`StateWatcher::injected_counted`] and
    /// [`StateWatcher::injected_stamps`] (round 4, G4-3), so once this reads `n`, those two are
    /// final for the first `n` events — wait on this, then read them exactly.
    #[doc(hidden)]
    pub fn injected_seen(&self) -> u64 {
        self.progress.injected_seen.load(Ordering::SeqCst)
    }

    /// **Test harness only** — how many of those it counted as a change. Exact for the first `n`
    /// events once [`StateWatcher::injected_seen`] reads `n`.
    #[doc(hidden)]
    pub fn injected_counted(&self) -> u64 {
        self.progress.injected_counted.load(Ordering::SeqCst)
    }

    /// **Test harness only** — the instant the loop judged each COUNTED injected event, in order:
    /// the same `Instant` it recorded in the debounce, so `stamps[last] - stamps[first]` over a
    /// burst is the CONSUMER-side span the debounce actually saw (round 4, G4-4). Complete for the
    /// first `n` events once [`StateWatcher::injected_seen`] reads `n`.
    #[doc(hidden)]
    pub fn injected_stamps(&self) -> Vec<Instant> {
        self.progress
            .injected_stamps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Whether the first pass is complete: from here on, a write into an existing state directory
    /// is observed, and nothing the loop emits is an announcement of its own start.
    pub fn is_ready(&self) -> bool {
        self.progress.ready.load(Ordering::SeqCst)
    }

    /// Whether the loop has ended — asked to stop, or stopped by a panic.
    pub fn has_stopped(&self) -> bool {
        self.progress.stopped.load(Ordering::SeqCst)
    }

    /// Poll `condition` until it holds or `within` elapses. Returns whether it held.
    pub fn wait_until(&self, within: Duration, condition: impl Fn(&Self) -> bool) -> bool {
        let deadline = Instant::now() + within;
        loop {
            if condition(self) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Ask the thread to stop and wait for it.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for StateWatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The text of a caught panic, for the snapshot that says the loop stopped.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_else(|| "a panic with no message".to_string())
}

/// Start watching with the app's settings. Returns immediately; the work happens on one dedicated
/// thread.
///
/// A plain `std::thread` rather than a tokio task: the `notify` backend delivers on its own thread
/// and the loop's only waits are a channel receive and a `stat`. Putting it on the async runtime
/// would mean blocking a worker for `RECOVERY_POLL` at a time, or an async shim around a
/// synchronous API, for no benefit.
pub fn spawn(
    targets: WatchTargets,
    source: Arc<dyn SnapshotSource>,
    sink: Arc<dyn StateSink>,
) -> Result<StateWatcher, notify::Error> {
    spawn_with(targets, source, sink, WatchOptions::default())
}

/// [`spawn`] with every setting exposed.
pub fn spawn_with(
    targets: WatchTargets,
    source: Arc<dyn SnapshotSource>,
    sink: Arc<dyn StateSink>,
    opts: WatchOptions,
) -> Result<StateWatcher, notify::Error> {
    spawn_inner(targets, source, sink, opts, false)
}

/// **Test harness only** — [`spawn_with`], plus an [`StateWatcher::inject`] handle into the loop's
/// event channel. Everything else — the backend, the watch, the loop — is the shipped path.
#[doc(hidden)]
pub fn spawn_injectable(
    targets: WatchTargets,
    source: Arc<dyn SnapshotSource>,
    sink: Arc<dyn StateSink>,
    opts: WatchOptions,
) -> Result<StateWatcher, notify::Error> {
    spawn_inner(targets, source, sink, opts, true)
}

fn spawn_inner(
    mut targets: WatchTargets,
    source: Arc<dyn SnapshotSource>,
    sink: Arc<dyn StateSink>,
    opts: WatchOptions,
    injectable: bool,
) -> Result<StateWatcher, notify::Error> {
    let stop = Arc::new(AtomicBool::new(false));
    let progress = Arc::new(Progress::default());
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let injector = injectable.then(|| tx.clone());

    // Constructed on THIS thread so a backend that cannot start (inotify limits, a sandbox with no
    // FSEvents) fails the caller loudly instead of dying silently inside a detached thread.
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })?;

    // The parent is watched unconditionally and non-recursively: it is how the state directory's
    // own creation and removal are noticed. A state dir with no parent (a filesystem root) is not a
    // real configuration, and failing to watch it is not fatal — the recovery poll still runs.
    if let Some(parent) = targets.state_dir.parent() {
        let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
    }

    let stop_thread = Arc::clone(&stop);
    let progress_thread = Arc::clone(&progress);
    let handle = std::thread::Builder::new()
        .name("daily-briefing-state-watcher".into())
        .spawn(move || {
            // Moved in so the backend lives exactly as long as the loop.
            let mut watcher = watcher;
            let WatchOptions {
                quiet,
                ceiling,
                rederive_every,
                unhealthy_read_every,
                initial,
                clock,
            } = opts;
            let progress = progress_thread;
            let emit = |snapshot: &Snapshot| {
                progress.emitted.fetch_add(1, Ordering::SeqCst);
                sink.changed(snapshot);
            };
            // ⚠ EVERY READ IS RE-DERIVED AT THE LOOP'S CLOCK, so the state the loop holds and the
            // instant it compares boundaries against are the same instant. (The app's source
            // derives at `now_local`, which is the app's clock too; a test's source derives at
            // whatever it likes, and its hand clock still decides.)
            let read = |now: &Now| {
                progress.reads.fetch_add(1, Ordering::SeqCst);
                source.snapshot().rederive(now)
            };

            // Outside the unwind boundary, so a panic can still report the last good state.
            let mut last: Option<Snapshot> = None;
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let mut debounce = Debounce::new(quiet, ceiling);
                // What the directory was at the last poll, and whether a watch on it is live.
                let mut observed: Option<DirIdentity> = None;
                let mut watching = false;
                // When to derive again, when the engine was last read, and the clock value `last`
                // was derived at — the "before" of every boundary crossing.
                let mut next_due: Option<i64> = None;
                let mut last_rederive = Instant::now();
                let mut last_read = Instant::now();
                let mut last_now: Option<Now> = None;
                // ⚠ THE FIRST PASS IS NOT A CHANGE. On every pass after it, a new identity means
                // the directory APPEARED, VANISHED or was REPLACED, and each is a change the app
                // must react to. On the first pass it only means the directory was already there.
                let mut first_pass = true;

                loop {
                    if stop_thread.load(Ordering::SeqCst) {
                        break;
                    }

                    // ── promotion, recovery and re-targeting ──────────────────────────────────
                    let current = dir_identity(&targets.state_dir);
                    if current != observed {
                        if watching {
                            // The backend may already have dropped this watch; unwatching is
                            // bookkeeping so the next `watch` is not refused as a duplicate, and
                            // it clears the backend's record of the OLD canonical path.
                            let _ = watcher.unwatch(&targets.state_dir);
                            watching = false;
                        }
                        if !first_pass {
                            debounce.record(Instant::now());
                        }
                        observed = current;
                    }
                    if let (Some(identity), false) = (&observed, watching) {
                        // Retried every pass while it fails, WITHOUT recording a change each time
                        // — a persistently failing watch (an exhausted inotify budget) must not
                        // turn into two engine spawns every poll.
                        if watcher
                            .watch(&targets.state_dir, RecursiveMode::Recursive)
                            .is_ok()
                        {
                            targets.set_resolved(identity.canonical.clone());
                            watching = true;
                            progress.arms.fetch_add(1, Ordering::SeqCst);
                        }
                    }

                    // ── the first read: AFTER the watch, so nothing between the caller's read and
                    // the watch can be missed (a change before this read is in it; one after is an
                    // event).
                    if first_pass {
                        first_pass = false;
                        let now = clock();
                        let snapshot = read(&now);
                        last_read = Instant::now();
                        next_due = snapshot.next_boundary(&now);
                        last_rederive = Instant::now();
                        if initial.as_ref().is_some_and(|i| *i != snapshot) {
                            emit(&snapshot);
                        }
                        last = Some(snapshot);
                        last_now = Some(now);
                        progress.ready.store(true, Ordering::SeqCst);
                    }

                    // ── wait ──────────────────────────────────────────────────────────────────
                    let timeout = debounce
                        .wait_from(Instant::now())
                        .unwrap_or(RECOVERY_POLL)
                        .min(RECOVERY_POLL);
                    match rx.recv_timeout(timeout) {
                        Ok(Ok(event)) => {
                            // A CHANGE to an interesting path, or a rescan notice (events were
                            // dropped). A read is neither — see [`counts_as_change`], [`is_change`],
                            // and the Linux re-read loop it closes.
                            let counted = counts_as_change(&event, &targets);
                            let at = Instant::now();
                            if counted {
                                debounce.record(at);
                            }
                            if event.info() == Some(INJECTED) {
                                // ⚠ `injected_seen` LAST — see [`Progress::injected_seen`].
                                if counted {
                                    progress.injected_counted.fetch_add(1, Ordering::SeqCst);
                                    progress
                                        .injected_stamps
                                        .lock()
                                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                                        .push(at);
                                }
                                progress.injected_seen.fetch_add(1, Ordering::SeqCst);
                            } else if counted && event.need_rescan() {
                                progress.rescans_counted.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        // A backend error (a dropped queue, a vanished watch) is not fatal: the
                        // identity check at the top of the loop is what repairs the watch, and
                        // the error itself carries no state the app can act on.
                        Ok(Err(_)) => {}
                        Err(RecvTimeoutError::Timeout) => {}
                        // Every sender is gone, which can only happen if the backend was dropped.
                        Err(RecvTimeoutError::Disconnected) => break,
                    }

                    // ── serve a file change: a REAL read of BOTH envelopes, every time ─────────
                    if debounce.pending() {
                        if debounce.due(Instant::now()) {
                            debounce.take();
                            let now = clock();
                            let snapshot = read(&now);
                            last_read = Instant::now();
                            // ⚠ ALWAYS EMITTED: the raw envelopes are part of the payload and the
                            // files changed, whether or not the derived state did.
                            emit(&snapshot);
                            next_due = snapshot.next_boundary(&now);
                            last_rederive = Instant::now();
                            last = Some(snapshot);
                            last_now = Some(now);
                        }
                        // A pending batch will re-derive when it is served; re-deriving now as
                        // well would announce the same moment twice.
                        continue;
                    }

                    // ── or let time change the answer ─────────────────────────────────────────
                    let (Some(previous), Some(before)) = (last.as_ref(), last_now.as_ref()) else {
                        continue;
                    };
                    let now = clock();
                    // ⚠ A CROSSING, NOT AN INSTANT: midnight, the floor or the stale deadline lying
                    // between the last derivation and now — however the loop got here (the named
                    // boundary, the cap, a machine that slept through it).
                    let boundary = previous.crosses_read_boundary(before, &now);
                    let periodic = !boundary
                        && previous.wants_periodic_read()
                        && last_read.elapsed() >= unhealthy_read_every;
                    let due = boundary
                        || periodic
                        || next_due.is_some_and(|at| now.epoch_secs >= at)
                        || last_rederive.elapsed() >= rederive_every;
                    if !due {
                        continue;
                    }
                    let next = if boundary || periodic {
                        let counter = if boundary {
                            &progress.boundary_reads
                        } else {
                            &progress.periodic_reads
                        };
                        counter.fetch_add(1, Ordering::SeqCst);
                        last_read = Instant::now();
                        read(&now)
                    } else {
                        progress.rederives.fetch_add(1, Ordering::SeqCst);
                        previous.rederive(&now)
                    };
                    next_due = next.next_boundary(&now);
                    last_rederive = Instant::now();
                    // ⚠ ONLY WHEN SOMETHING CHANGED. A pure re-derive holds identical envelopes by
                    // construction, so an unchanged state is not news — and the cap would otherwise
                    // emit every minute. A real read is news when anything in it differs.
                    if next != *previous {
                        emit(&next);
                    }
                    last = Some(next);
                    last_now = Some(now);
                }
            }));

            if let Err(panic) = outcome {
                // ⚠ LOUD, NOT SILENT. Without this the thread would end and the tray and window
                // would keep showing the last state as though it were still being kept current.
                let why = panic_message(panic.as_ref());
                eprintln!("daily-briefing: the state-directory watcher stopped ({why}).");
                let stopped = Snapshot::stopped(last.as_ref(), &why);
                // A sink that panicked once may panic again; that must not abort the thread's
                // unwinding a second time.
                let _ = catch_unwind(AssertUnwindSafe(|| emit(&stopped)));
            }
            progress.stopped.store(true, Ordering::SeqCst);
        })
        .map_err(|e| notify::Error::io(std::io::Error::other(e.to_string())))?;

    Ok(StateWatcher {
        stop,
        progress,
        handle: Some(handle),
        injector,
    })
}
