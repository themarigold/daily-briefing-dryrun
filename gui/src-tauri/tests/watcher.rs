//! T10 — the state-dir watcher.
//!
//! ## Three layers, because a timing test alone would prove the wrong thing
//!
//! The coalescing rule is a PURE struct ([`Debounce`]) driven here with synthetic `Instant`s, so
//! the bound is asserted exactly rather than inferred from how fast this machine happens to write
//! files. The integration tests then drive the real `notify` backend against a real directory and
//! assert what only an end-to-end run can: that an event arrives at all, that the payload is
//! derived from what is on disk, that a deleted, replaced or re-pointed directory is recovered from
//! without a restart, and that nothing is written into the directory being watched. The third
//! layer walks the loop's INJECTED clock past a stale deadline, the floor and midnight with no file
//! changing at all — and asserts which of those moments READ the engine again (the ones where the
//! engine's own answer turns) and which stay pure re-derives. The fourth drives the engine-backed
//! source against fakes whose answer changes between calls, which is how a live payload is shown
//! to carry the engine's CURRENT schedule answer rather than an earlier batch's.
//!
//! ⚠ NOTHING HERE SPAWNS THE REAL ENGINE. The engine-backed tests use `common::state_sidecar`, a
//! shell script that reads the temp state directory and prints envelopes shaped like
//! `status --json` and `schedule status --json`. So no test in this file can reach
//! `~/Library/LaunchAgents`, the developer's state directory, or a provider.
//!
//! ⚠ NO TEST HERE SLEEPS TO WAIT FOR THE WATCH. The watcher REPORTS when its first pass is done and
//! how many times it has taken a watch (`StateWatcher::is_ready`, `arms`), and the tests wait on
//! those — MEASURED: the fixed 300 ms settles this replaced failed 2 in 10 full-suite runs under
//! load, with the writes landing before the watch existed. The only remaining fixed windows assert
//! ABSENCE (nothing was emitted in [`ABSENCE_WINDOW`]), which can make a mutant slower to catch.
//!
//! ⚠ AND AN ABSENCE WINDOW IS ONLY HONEST OVER A DIRECTORY THE BACKEND IS QUIET ABOUT — which is a
//! CORRECTION, MEASURED. This header used to claim such a window "can never fail a correct
//! watcher". It can, and it did: macOS FSEvents delivers events for changes made BEFORE the stream
//! existed, so a test's own setup writes arrive after the watch is taken, the loop serves them as
//! the change they genuinely were, and the absence check that follows sees an event it did not
//! cause. Every test here whose absence or exact read/emit count runs over a state directory the
//! test itself populated therefore calls [`settle_backend`] after its setup and before starting the
//! watcher. The one stated exception is `a_missing_state_dir_is_promoted_when_it_appears`: it has no
//! state directory to settle, and nothing its setup wrote is interesting. See that function for the
//! measurements.

mod common;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{
    fake_sidecar, process_gone, process_stat, sleeper, state_sidecar, unloaded_flag, ReapTagged,
    ScratchDir,
};
use daily_briefing_gui_lib::engine::EngineClient;
use daily_briefing_gui_lib::schedule_state::{
    now_local, parse_iso_utc, utc_civil, Now, Phase, StatusView,
};
use daily_briefing_gui_lib::shell::EngineSnapshots;
use daily_briefing_gui_lib::watcher::{
    self, Clock, Debounce, Snapshot, SnapshotSource, StateSink, StateWatcher, WatchOptions,
    WatchTargets, DEBOUNCE_CEILING, DEBOUNCE_QUIET, RECOVERY_POLL, REDERIVE_EVERY,
    UNHEALTHY_READ_EVERY, WATCHED_NAMES,
};
use notify::{RecursiveMode, Watcher as _};

/// How long any wait for the watcher may take before a test fails. Generous on purpose: a slow
/// machine must not fail a correct watcher.
const PATIENCE: Duration = Duration::from_secs(15);

/// How long an ABSENCE check watches for an event that must not arrive. Named once, so the several
/// "nothing was announced" SLEEPS in this file cannot drift to three different numbers for one idea.
/// (It governs those sleeps only — the `wait_quiet` settle windows are a different question, "has
/// the burst finished", and still carry per-test values.) It bounds only how slow a mutant may be
/// and still be caught — never a correct watcher, as long as the check runs over a directory the
/// backend is quiet about (see [`settle_backend`]).
const ABSENCE_WINDOW: Duration = Duration::from_millis(1_500);

/// The sentinel [`settle_backend`] writes and removes. Deliberately NOT one of `WATCHED_NAMES` and
/// not under `briefings/`, so an event for it that outlives the drain is inert rather than a change.
///
/// ⚠ THAT INERTNESS IS LOAD-BEARING, NOT DECORATIVE — it is what covers the sentinel's own events,
/// which DO reach the watcher under test (see [`settle_backend`]). It is pinned by
/// `only_the_engine_state_files_count_as_a_change`, so a widening of `is_interesting` fails there
/// rather than silently turning this helper into the flake it removes.
const SETTLE_SENTINEL: &str = ".settle";

/// Publish the backend's events for everything the test has written so far, so the watcher under
/// test starts on a directory the BACKEND is quiet about.
///
/// ⚠ macOS FSEvents DELIVERS EVENTS FOR CHANGES MADE BEFORE THE STREAM EXISTED, and that — not a
/// slow machine — is what made `one_debounced_event_carries_the_state_the_files_describe` flaky.
/// The test's own `mkdir state` and `write schedule.json` arrived AFTER the watch was taken; the
/// state directory itself and `schedule.json` are both interesting (`WatchTargets::is_interesting`),
/// so the loop served them as the change they genuinely were, and the absence check that followed
/// counted an event it had not caused. The watcher is RIGHT to re-read when it is handed such an
/// event — the files really did change, just before the watch — so this is the test's problem to
/// solve, not the loop's, and no production behaviour changes for it.
///
/// MEASURED on this machine, 12 trials each: a stream opened straight after that setup reported it
/// in 4 of 12; sleeping 300 ms first changed nothing (3 of 12), so the events are not aged out,
/// they are simply not published yet; draining them through a THROWAWAY stream first left 0 of 12.
///
/// ⚠ AND IT IS A WAIT, NOT A GUESS — BUT THE BARRIER IS THE SENTINEL'S **CREATION**, AND ONLY THAT.
/// FSEvents delivers one stream's events in order, and the sentinel is written after all of the
/// test's setup, so when its creation arrives everything earlier has been published and a stream
/// opened afterwards begins past all of it. That is the whole mechanism.
///
/// ⚠ THE SENTINEL'S OWN EVENTS ARE **NOT** COVERED BY THAT BARRIER, AND ARE NOT MEANT TO BE — which
/// is a CORRECTION. This helper used to wait a second time, for the removal, and claim that put the
/// stream past everything. It did not: `notify` emits one event per translated FSEvents flag bit
/// (`notify-8.2.0/src/fsevent.rs:570`), so a single `write` yields `Create(File)` +
/// `Modify(Metadata(Extended))` + `Modify(Data(Content))`, the first wait consumed one and left two
/// queued, and the second wait was satisfied instantly by a leftover — MEASURED 20/20, never once by
/// a `Remove`. The removal wait was a no-op wearing the costume of a barrier, so it is gone rather
/// than repaired: the honest design has ONE barrier and says what covers the rest.
///
/// What covers the rest is [`SETTLE_SENTINEL`]'s inertness. The watcher under test does receive the
/// sentinel's create and remove, and `is_interesting` rejects both. The residual worry — FSEvents
/// coalescing a child's change onto the CONTAINING DIRECTORY, which `is_interesting` accepts via
/// `path == root` — was measured and does not occur: 40 create+remove cycles inside a watched
/// directory produced 184 events, **0** of them naming the directory itself.
///
/// The drain's watch scope mirrors the loop's (the parent non-recursively, the directory
/// recursively) so nothing the loop would be told about is left unpublished.
fn settle_backend(state: &Path) {
    assert!(
        state.is_dir(),
        "settle_backend: {state:?} is not a directory — settle AFTER the state dir is created"
    );
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut drain = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .expect("the settling backend starts");
    if let Some(parent) = state.parent() {
        let _ = drain.watch(parent, RecursiveMode::NonRecursive);
    }
    drain
        .watch(state, RecursiveMode::Recursive)
        .expect("the settling watch is taken");

    let sentinel = state.join(SETTLE_SENTINEL);
    std::fs::write(&sentinel, "settling\n").expect("write the settling sentinel");

    let deadline = Instant::now() + PATIENCE;
    let mut published = false;
    while !published && Instant::now() < deadline {
        if let Ok(Ok(event)) = rx.recv_timeout(Duration::from_millis(20)) {
            published = event
                .paths
                .iter()
                .any(|p| p.file_name().is_some_and(|n| n == SETTLE_SENTINEL));
        }
    }
    // ⚠ NAMES THE DIRECTORY, because the scratch path carries the calling test's tag — otherwise
    // this panic says only that "a sentinel" was lost, in a run of six call sites plus every test
    // routed through `TempState::new`.
    assert!(
        published,
        "settle_backend: the sentinel's creation under {state:?} never arrived within {PATIENCE:?} \
         — the FSEvents backend is not delivering, which would also break the waits in the test \
         this was called from"
    );

    std::fs::remove_file(&sentinel).expect("remove the settling sentinel");
    // The removal's own events are inert (above); the drain is dropped here rather than at the end
    // of the enclosing scope so the stream is gone before the watcher under test opens its own.
    drop(drain);
}

/* ── 1. the coalescer, driven by hand ─────────────────────────────────────────────────────────── */

#[test]
fn nothing_is_due_until_something_is_recorded() {
    let d = Debounce::new(DEBOUNCE_QUIET, DEBOUNCE_CEILING);
    let now = Instant::now();
    assert!(!d.pending());
    assert!(!d.due(now));
    assert_eq!(d.wait_from(now), None);
}

#[test]
fn a_quiet_period_fires_and_a_continuing_stream_postpones_it() {
    let start = Instant::now();
    let mut d = Debounce::new(Duration::from_millis(250), Duration::from_millis(1000));
    d.record(start);
    assert!(d.pending());
    assert!(!d.due(start + Duration::from_millis(249)));
    assert!(d.due(start + Duration::from_millis(250)));

    // A change at 200ms pushes the quiet deadline out to 450ms.
    let mut d = Debounce::new(Duration::from_millis(250), Duration::from_millis(1000));
    d.record(start);
    d.record(start + Duration::from_millis(200));
    assert!(!d.due(start + Duration::from_millis(400)));
    assert!(d.due(start + Duration::from_millis(450)));
}

/// ⚠ THE CEILING IS THE ANTI-STARVATION HALF. Without it, a file written every 100 ms forever
/// means the quiet period never elapses and the UI never updates at all.
#[test]
fn the_ceiling_fires_even_while_changes_keep_arriving() {
    let start = Instant::now();
    let mut d = Debounce::new(Duration::from_millis(250), Duration::from_millis(1000));
    for step in 0..20 {
        d.record(start + Duration::from_millis(step * 100));
    }
    // At 1000ms the batch is a second old, and nothing has been quiet for 250ms.
    assert!(d.due(start + Duration::from_millis(1000)));
    assert!(!d.due(start + Duration::from_millis(999)));
}

/// The bound the module documents: a burst lasting `d` costs at most `ceil(d / ceiling) + 1`
/// re-reads. Simulated over a 5-second storm of changes 10 ms apart.
#[test]
fn a_continuous_storm_costs_the_documented_number_of_rereads() {
    let start = Instant::now();
    let quiet = Duration::from_millis(250);
    let ceiling = Duration::from_millis(1000);
    let mut d = Debounce::new(quiet, ceiling);

    let storm_ms = 5_000u64;
    let mut fires = 0usize;
    for ms in 0..=(storm_ms + 1_000) {
        let now = start + Duration::from_millis(ms);
        if ms <= storm_ms && ms % 10 == 0 {
            d.record(now);
        }
        if d.pending() && d.due(now) {
            d.take();
            fires += 1;
        }
    }
    let bound = storm_ms.div_ceil(1_000) as usize + 1;
    assert!(
        fires <= bound,
        "a {storm_ms}ms storm produced {fires} re-reads; the documented bound is {bound}"
    );
    assert!(
        fires >= 2,
        "a {storm_ms}ms storm produced only {fires} re-read(s) — the ceiling is not firing, which \
         is the starvation bug this bound exists to rule out"
    );
}

/* ── 2. which paths matter ────────────────────────────────────────────────────────────────────── */

#[test]
fn only_the_engine_state_files_count_as_a_change() {
    let targets = WatchTargets::new("/tmp/state");
    for name in WATCHED_NAMES {
        assert!(
            targets.is_interesting(Path::new("/tmp/state").join(name).as_path()),
            "{name} should be interesting"
        );
    }
    assert!(targets.is_interesting(Path::new("/tmp/state")));
    assert!(targets.is_interesting(Path::new("/tmp/state/briefings/2026-09-16.md")));

    // ⚠ EXCLUDED ON PURPOSE. `briefing.log` is appended by every tick and `run.lock` churns around
    // every run; both would cost an engine spawn to learn nothing.
    for ignored in [
        "/tmp/state/briefing.log",
        "/tmp/state/run.lock",
        "/tmp/state/account-state.json",
        "/tmp/state/config.json",
        "/tmp/elsewhere/last-run",
        "/tmp/state-other/last-run",
        // ⚠ `settle_backend`'s sentinel, pinned HERE rather than trusted to its doc comment. Its
        // create and remove DO reach the watcher under test, so every settled test in this file
        // rests on this one staying uninteresting; a widening of `is_interesting` must fail here
        // rather than quietly turn the helper into the flake it removes.
        "/tmp/state/.settle",
    ] {
        assert!(
            !targets.is_interesting(Path::new(ignored)),
            "{ignored} should not be interesting"
        );
    }
}

/// ⚠ A READ IS NOT A CHANGE — every event kind `notify` 8.2.0 can name, sorted by hand. On Linux,
/// inotify reports the engine's own reads as `Access(Open(Any))`; counted, they re-read the engine
/// in a loop (Phase E M2's first Linux `cargo test`: 11 failures here, 6 emits in a 1.5 s window in
/// which only excluded files were touched). See `watcher::is_change`.
///
/// ⚠ THIS PINS THE DECISION ON EVERY PLATFORM; THE LOOP'S USE OF IT IS PINNED ONLY ON LINUX.
/// FSEvents emits no `Access` kind, so on macOS the loop tests cannot tell a loop that consults
/// `is_change` from one that does not — MEASURED: with the guard removed from the loop, this file
/// stays 38/38 green on macOS. Where inotify runs (the Linux `cargo test` job), the absence and
/// exact-count tests in sections 3 and 4 are what catch it.
#[test]
fn a_read_is_not_a_change() {
    use notify::event::{
        AccessKind, AccessMode, CreateKind, DataChange, EventKind, MetadataKind, ModifyKind,
        RemoveKind, RenameMode,
    };
    let reads = [
        // `IN_OPEN` — what the engine's reads and `notify`'s own watch-time walk raise on Linux.
        EventKind::Access(AccessKind::Open(AccessMode::Any)),
        EventKind::Access(AccessKind::Open(AccessMode::Read)),
        // Opening FOR writing changes nothing yet; the write itself is a `Modify`.
        EventKind::Access(AccessKind::Open(AccessMode::Write)),
        EventKind::Access(AccessKind::Open(AccessMode::Execute)),
        EventKind::Access(AccessKind::Read),
        // `IN_CLOSE_NOWRITE` — a read handle closed.
        EventKind::Access(AccessKind::Close(AccessMode::Read)),
        EventKind::Access(AccessKind::Close(AccessMode::Any)),
        EventKind::Access(AccessKind::Close(AccessMode::Execute)),
        EventKind::Access(AccessKind::Close(AccessMode::Other)),
        EventKind::Access(AccessKind::Any),
        EventKind::Access(AccessKind::Other),
        // An atime update is what a read causes.
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)),
    ];
    for kind in reads {
        assert!(
            !watcher::is_change(&kind),
            "{kind:?} reports a read, not a change"
        );
    }

    let changes = [
        // `IN_CLOSE_WRITE` — a handle opened for writing was closed: a completed write.
        EventKind::Access(AccessKind::Close(AccessMode::Write)),
        EventKind::Create(CreateKind::File),
        EventKind::Create(CreateKind::Folder),
        EventKind::Create(CreateKind::Any),
        EventKind::Create(CreateKind::Other),
        EventKind::Modify(ModifyKind::Data(DataChange::Any)),
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        EventKind::Modify(ModifyKind::Data(DataChange::Size)),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
        // `IN_ATTRIB` arrives as `Metadata(Any)`: a chmod or a utimensat is a change, and it cannot
        // be told apart from one.
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)),
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::WriteTime)),
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::Ownership)),
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::Extended)),
        EventKind::Modify(ModifyKind::Metadata(MetadataKind::Other)),
        EventKind::Modify(ModifyKind::Any),
        EventKind::Modify(ModifyKind::Other),
        EventKind::Remove(RemoveKind::File),
        EventKind::Remove(RemoveKind::Folder),
        EventKind::Remove(RemoveKind::Any),
        EventKind::Remove(RemoveKind::Other),
        // Unclassified — FSEvents' imprecise mode, a queue overflow's rescan — is no evidence of a
        // read.
        EventKind::Any,
        EventKind::Other,
    ];
    for kind in changes {
        assert!(watcher::is_change(&kind), "{kind:?} is a change");
    }
}

/// ⚠ THE macOS SYMLINK TRAP, PINNED. `$TMPDIR` is under `/var/folders`, `/var` is a symlink to
/// `/private/var`, and FSEvents reports the RESOLVED path — so a watcher that matched only the
/// spelling `status --json` gave would receive every event and discard every one of them.
#[test]
fn an_event_path_resolved_through_a_symlink_still_matches() {
    let scratch = ScratchDir::new("symlink");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let resolved = std::fs::canonicalize(&state).expect("canonical");

    let targets = WatchTargets::new(&state);
    assert!(targets.is_interesting(&state.join("last-run")));
    assert!(
        targets.is_interesting(&resolved.join("last-run")),
        "the resolved spelling {resolved:?} did not match the engine's spelling {state:?} — this \
         is the trap the second root exists for"
    );
}

/* ── 3. the loop, end to end ──────────────────────────────────────────────────────────────────── */

#[derive(Default)]
struct Counter {
    count: AtomicU64,
    payloads: Mutex<Vec<String>>,
}

impl Counter {
    fn n(&self) -> u64 {
        self.count.load(Ordering::SeqCst)
    }
    fn wait_for(&self, at_least: u64, within: Duration) -> u64 {
        let deadline = Instant::now() + within;
        loop {
            let seen = self.n();
            if seen >= at_least || Instant::now() >= deadline {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    /// Wait until nothing has been emitted for `quiet_for`. Returns the count then.
    fn wait_quiet(&self, quiet_for: Duration, within: Duration) -> u64 {
        let deadline = Instant::now() + within;
        let mut last = self.n();
        let mut since = Instant::now();
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
            let now = self.n();
            if now != last {
                last = now;
                since = Instant::now();
            } else if since.elapsed() >= quiet_for {
                break;
            }
        }
        last
    }
    /// Wait until some payload satisfies `pred`; return it.
    fn wait_for_payload(
        &self,
        within: Duration,
        pred: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        let deadline = Instant::now() + within;
        loop {
            let found = self
                .payloads
                .lock()
                .expect("lock")
                .iter()
                .map(|p| serde_json::from_str::<serde_json::Value>(p).expect("JSON"))
                .find(|v| pred(v));
            if found.is_some() || Instant::now() >= deadline {
                return found;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn last(&self) -> Option<serde_json::Value> {
        self.payloads
            .lock()
            .ok()
            .and_then(|p| p.last().cloned())
            .map(|p| serde_json::from_str(&p).expect("a payload is JSON"))
    }
    fn phases(&self) -> Vec<String> {
        self.payloads
            .lock()
            .expect("lock")
            .iter()
            .map(|p| {
                let v: serde_json::Value = serde_json::from_str(p).expect("JSON");
                v["scheduleState"]["phase"]["phase"]
                    .as_str()
                    .unwrap_or("none")
                    .to_string()
            })
            .collect()
    }
}

impl StateSink for Counter {
    fn changed(&self, snapshot: &Snapshot) {
        if let Ok(mut payloads) = self.payloads.lock() {
            payloads.push(serde_json::to_string(snapshot).unwrap_or_default());
        }
        self.count.fetch_add(1, Ordering::SeqCst);
    }
}

/// A source that returns what the test last put in it — the stand-in for an engine whose answer
/// changes between calls with no file changing — and counts how often, and WHEN, it was asked.
struct Fixed {
    snapshot: Mutex<Snapshot>,
    calls: AtomicU64,
    asked_at: Mutex<Vec<Instant>>,
}

impl Fixed {
    fn new(snapshot: Snapshot) -> Self {
        Self {
            snapshot: Mutex::new(snapshot),
            calls: AtomicU64::new(0),
            asked_at: Mutex::new(Vec::new()),
        }
    }
}

impl Fixed {
    fn set(&self, snapshot: Snapshot) {
        *self.snapshot.lock().expect("lock") = snapshot;
    }
    fn calls(&self) -> u64 {
        self.calls.load(Ordering::SeqCst)
    }
    /// The instant of every call, in order.
    fn asked_at(&self) -> Vec<Instant> {
        self.asked_at.lock().expect("lock").clone()
    }
}

impl SnapshotSource for Fixed {
    fn snapshot(&self) -> Snapshot {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.asked_at.lock().expect("lock").push(Instant::now());
        self.snapshot.lock().expect("lock").clone()
    }
}

/// A source that reports `last-run`'s CONTENT as `lastRunDate` — no engine, but a payload that
/// says which write it saw, so "the watch works" can be asserted as "this write was observed"
/// rather than "some event arrived".
struct MarkerReader {
    state: PathBuf,
}

impl SnapshotSource for MarkerReader {
    fn snapshot(&self) -> Snapshot {
        let marker = std::fs::read_to_string(self.state.join("last-run")).unwrap_or_default();
        Snapshot::build(
            Some(serde_json::json!({ "configExists": true, "lastRunDate": marker.trim() })),
            None,
            &frozen_now(),
            None,
        )
    }
}

/// A fixed instant: 2026-09-16 09:10 on a UTC-7 machine.
fn frozen_now() -> Now {
    Now {
        local_date: "2026-09-16".into(),
        minutes: 9 * 60 + 10,
        epoch_secs: parse_iso_utc("2026-09-16T16:10:00.000Z").expect("parses"),
    }
}

/// Options for tests that are NOT about time: a clock that never moves, and no periodic
/// re-derivation or re-read, so nothing but a file change can produce an event.
fn file_only(quiet: Duration, ceiling: Duration) -> WatchOptions {
    WatchOptions {
        quiet,
        ceiling,
        rederive_every: Duration::from_secs(3_600),
        unhealthy_read_every: Duration::from_secs(3_600),
        initial: None,
        clock: Arc::new(frozen_now),
    }
}

/// [`app_timings`] on the REAL local clock — for the engine-backed tests, whose fake engine dates
/// things by the machine's own `date` and whose payloads are derived at `now_local`.
fn live_clock() -> WatchOptions {
    WatchOptions {
        clock: Arc::new(now_local),
        ..app_timings()
    }
}

fn app_timings() -> WatchOptions {
    file_only(DEBOUNCE_QUIET, DEBOUNCE_CEILING)
}

/// Spawn, and wait for the first pass to finish — the watch taken, the first read done.
fn start(
    targets: WatchTargets,
    source: Arc<dyn SnapshotSource>,
    sink: Arc<dyn StateSink>,
    opts: WatchOptions,
) -> StateWatcher {
    let w = watcher::spawn_with(targets, source, sink, opts).expect("the watcher starts");
    assert!(
        w.wait_until(PATIENCE, StateWatcher::is_ready),
        "the watcher's first pass did not complete within {PATIENCE:?}"
    );
    w
}

/// Write `token` into `last-run` until a payload reports it, or `within` passes. Rewriting covers
/// a backend that coalesced or dropped the first event; the payload check is what makes a
/// passing result mean THIS write was seen.
fn write_until_observed(state: &Path, sink: &Counter, token: &str, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        std::fs::write(state.join("last-run"), format!("{token}\n")).expect("write last-run");
        let until = Instant::now() + Duration::from_millis(1_500);
        while Instant::now() < until {
            if sink
                .last()
                .is_some_and(|v| v["status"]["lastRunDate"] == token)
            {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    false
}

/// A fingerprint of every file under `dir`: relative path, length and content.
fn tree_hash(dir: &Path) -> u64 {
    let mut entries: Vec<(String, u64, u64)> = Vec::new();
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, u64, u64)>) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in read.flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                out.push((rel, u64::MAX, 0));
                walk(root, &path, out);
            } else {
                let bytes = std::fs::read(&path).unwrap_or_default();
                let mut h = DefaultHasher::new();
                bytes.hash(&mut h);
                out.push((rel, bytes.len() as u64, h.finish()));
            }
        }
    }
    walk(dir, dir, &mut entries);
    entries.sort();
    let mut h = DefaultHasher::new();
    entries.hash(&mut h);
    h.finish()
}

/// A real `EngineSnapshots` over the state-reading fake sidecar.
fn engine_source(scratch: &ScratchDir, state: &Path) -> Arc<EngineSnapshots> {
    let program = state_sidecar(&scratch.path, "engine.sh", state, None);
    Arc::new(EngineSnapshots::new(Ok(EngineClient::with_program(
        program,
    ))))
}

/// The state dir did not exist when the targets were built (the fresh-install case), and the
/// resolved spelling is learned when the watch is taken. Pinned because `WatchTargets::new`'s
/// `canonicalize` simply fails then, and a design that relied on it would silently watch one
/// spelling forever.
///
/// ⚠ ONLY macOS EXERCISES THE LEARNED SPELLING. Linux inotify reports every path as the WATCHED
/// path joined with the entry's name, never canonicalised (`notify-8.2.0/src/inotify.rs:218`, from the
/// spelling stored at watch time, :464) — so there the event arrives in the engine's spelling, and
/// this test checks its premise and the delivery only. FSEvents reports the RESOLVED path, which is
/// what makes the learned spelling load-bearing; that half is exercised by the macOS runs — the
/// public `ci.yml` `cargo-macos` job and the macOS release legs.
#[test]
fn the_resolved_spelling_is_learned_after_the_directory_appears() {
    let scratch = ScratchDir::new("late");
    // The state dir is spelled through a symlink THIS TEST creates, so the premise below holds on
    // every platform: `$TMPDIR` happens to be symlinked on macOS (`/var` -> `/private/var`), but
    // Linux's `/tmp` is not, and the premise failed there (Phase E M2, first Linux `cargo test`).
    let real = scratch.join("real");
    std::fs::create_dir_all(&real).expect("real dir");
    let link = scratch.join("link");
    std::os::unix::fs::symlink(&real, &link).expect("symlink to the real dir");
    let state = link.join("state");
    let targets = WatchTargets::new(&state);
    std::fs::create_dir_all(&state).expect("state dir");
    let resolved = std::fs::canonicalize(&state).expect("canonical");
    assert_ne!(
        resolved, state,
        "this test needs a scratch path that is spelled through a symlink"
    );
    // Before the watch is taken, only the engine's spelling matches.
    assert!(!targets.is_interesting(&resolved.join("last-run")));

    let sink = Arc::new(Counter::default());
    let source = Arc::new(MarkerReader {
        state: state.clone(),
    });
    let mut w = start(
        targets,
        source,
        sink.clone(),
        file_only(Duration::from_millis(60), Duration::from_millis(200)),
    );
    assert_eq!(w.arms(), 1);
    let seen = write_until_observed(&state, &sink, "2026-01-01", PATIENCE);
    w.stop();
    assert!(
        seen,
        "no event arrived through the resolved spelling {resolved:?}"
    );
}

/// The headline case: write `last-run` and `briefing-latest.md`, get ONE debounced event whose
/// payload was derived from those files.
#[test]
fn one_debounced_event_carries_the_state_the_files_describe() {
    let scratch = ScratchDir::new("one-event");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    std::fs::write(state.join("schedule.json"), "{}").expect("schedule record");

    let sink = Arc::new(Counter::default());
    let source = engine_source(&scratch, &state);
    // ⚠ AFTER the whole setup, so nothing this test wrote is still unpublished when the watch is
    // taken — without it the backend replays `mkdir state` and `schedule.json` into the window
    // below, which is the flake this call exists for. (It is placed after `engine_source` for
    // ordering only: `engine.sh` lands in the PARENT, and no parent-level path except the state
    // directory itself can ever be interesting.)
    settle_backend(&state);
    let mut w = start(
        WatchTargets::new(&state),
        source,
        sink.clone(),
        live_clock(),
    );

    // ⚠ THE FIRST PASS IS NOT A CHANGE. The loop has taken the watch and done its first read; a
    // loop that also recorded a change would serve it one quiet period (plus two fake-engine
    // spawns) later. The window below is an ABSENCE check, so its length cannot fail a correct
    // watcher OVER A DIRECTORY THE BACKEND IS QUIET ABOUT — which is what the `settle_backend`
    // above is for, and without which this exact assertion is the one that flaked. It only bounds
    // how slow a mutant may be and still be caught.
    std::thread::sleep(ABSENCE_WINDOW);
    assert_eq!(
        sink.n(),
        0,
        "the watcher announced a change that never happened"
    );
    assert_eq!(
        w.reads(),
        1,
        "the first pass must read the engine exactly once"
    );

    let today = now_local().local_date;
    std::fs::write(state.join("last-run"), format!("{today}\n")).expect("marker");
    std::fs::write(state.join("briefing-latest.md"), "# Today\n").expect("briefing");

    let seen = sink.wait_for(1, PATIENCE);
    // Let the coalescer settle so a second, spurious event would be visible.
    let total = sink.wait_quiet(Duration::from_millis(800), PATIENCE);
    w.stop();

    assert!(seen >= 1, "no `state:changed` arrived within {PATIENCE:?}");
    // ⚠ A REGISTERED TOLERANCE OF ONE, NOT AN EXACT 1, and not a vacuous bound either. The two
    // writes are 0 ms apart, but the backend may hand them over in two deliveries, and a delivery
    // that lands after the first batch was already served is a correct second read — an exact `1`
    // would fail a correct watcher on a loaded machine. MEASURED (review round 2): with the debounce
    // switched off (quiet 0) this same test produced 6 events and went red 3 runs in 3, so `<= 2`
    // still catches a watcher that does not coalesce. Deviation register, `docs/gui-seam.md` §9.
    assert!(
        total <= 2,
        "two file writes 0ms apart produced {total} events; the debounce is not coalescing"
    );

    let value = sink.last().expect("a payload was recorded");
    assert_eq!(
        value["status"]["lastRunDate"], today,
        "the payload did not come from the file that was just written: {value}"
    );
    assert_eq!(
        value["scheduleState"]["phase"]["phase"], "delivered",
        "the derived state does not match the files on disk: {value}"
    );
    assert!(
        value["scheduleState"]["phase"]["at"].is_string(),
        "DELIVERED must carry the delivery time from briefing-latest.md's mtime: {value}"
    );
    assert!(
        value["schedule"]["owner"] == "app",
        "the schedule half of the payload is missing: {value}"
    );
}

/// 20 rapid writes must coalesce. The bound asserted is the one the module documents, and the
/// MEASURED number is printed so a regression in coalescing is visible even while it passes.
#[test]
fn twenty_rapid_writes_coalesce_to_a_bounded_number_of_events() {
    let scratch = ScratchDir::new("burst");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");

    let sink = Arc::new(Counter::default());
    let source = Arc::new(Fixed::new(Snapshot::unavailable("counted, not used")));
    // The event count below is the assertion; a replayed setup event would inflate it.
    settle_backend(&state);
    let mut w = start(
        WatchTargets::new(&state),
        source.clone(),
        sink.clone(),
        app_timings(),
    );

    let started = Instant::now();
    for i in 0..20 {
        std::fs::write(state.join("last-tick"), format!("tick {i}\n")).expect("tick");
    }
    let burst = started.elapsed();

    sink.wait_for(1, PATIENCE);
    let events = sink.wait_quiet(Duration::from_millis(800), PATIENCE);
    let reads = source.calls();
    w.stop();

    // ceil(burst / ceiling) + 1, with one extra slot of slack for a backend that delivers the tail
    // of the burst after the first fire.
    let bound = (burst.as_millis() as u64).div_ceil(DEBOUNCE_CEILING.as_millis() as u64) + 2;
    println!(
        "MEASURED: 20 writes in {burst:?} → {events} state:changed event(s), {reads} engine \
         read(s) (one of them the first pass's); bound {bound}"
    );
    assert!(events >= 1, "the burst produced no events at all");
    assert!(
        events <= bound,
        "20 writes in {burst:?} produced {events} events, over the bound of {bound}"
    );
    assert_eq!(
        events + 1,
        reads,
        "every emitted event must correspond to exactly one engine read, plus the first pass's"
    );
}

/// ⚠ THE CASE THE APPENDIX SAYS IS USUALLY MISSED. Deleting the watched directory drops the watch
/// on every backend; the watcher must notice and re-take it without the app restarting.
#[test]
fn a_deleted_and_recreated_state_dir_recovers_without_a_restart() {
    let scratch = ScratchDir::new("recreate");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");

    let sink = Arc::new(Counter::default());
    let source = Arc::new(MarkerReader {
        state: state.clone(),
    });
    let mut w = start(
        WatchTargets::new(&state),
        source,
        sink.clone(),
        app_timings(),
    );
    assert_eq!(w.arms(), 1);

    std::fs::remove_dir_all(&state).expect("delete the state dir");
    // The vanishing is itself a change.
    assert!(
        sink.wait_for(1, PATIENCE) >= 1,
        "deleting the state dir was not noticed"
    );
    std::fs::create_dir_all(&state).expect("recreate the state dir");
    assert!(
        w.wait_until(PATIENCE, |w| w.arms() >= 2),
        "the recreated directory was never re-watched"
    );
    sink.wait_quiet(Duration::from_millis(1_000), PATIENCE);

    // The real proof: a write INSIDE the recreated directory reaches the sink.
    let seen = write_until_observed(&state, &sink, "2026-02-02", PATIENCE);
    w.stop();
    assert!(
        seen,
        "a write into the RECREATED directory was never observed; the watch was not re-taken"
    );
}

/// ⚠ REPLACED BY A SYMLINK, FAST. The directory is deleted and a symlink to another directory put
/// in its place before the recovery poll runs, so "does it exist" never changes — only its
/// identity does. MEASURED before the identity check: events lost until restart.
#[test]
fn a_state_dir_replaced_by_a_symlink_is_rewatched() {
    let scratch = ScratchDir::new("symlink-swap");
    let state = scratch.join("state");
    let other = scratch.join("other");
    std::fs::create_dir_all(&state).expect("state dir");
    std::fs::create_dir_all(&other).expect("other dir");

    let sink = Arc::new(Counter::default());
    let source = Arc::new(MarkerReader {
        state: state.clone(),
    });
    let mut w = start(
        WatchTargets::new(&state),
        source,
        sink.clone(),
        app_timings(),
    );

    std::fs::remove_dir_all(&state).expect("delete");
    std::os::unix::fs::symlink(&other, &state).expect("symlink in its place");
    assert!(
        w.wait_until(PATIENCE, |w| w.arms() >= 2),
        "the directory's identity changed and the watch was not re-taken"
    );
    sink.wait_quiet(Duration::from_millis(1_000), PATIENCE);
    let seen = write_until_observed(&state, &sink, "2026-03-03", PATIENCE);
    w.stop();
    assert!(
        seen,
        "a write through the replacing symlink was never observed"
    );
}

/// ⚠ A SYMLINKED STATE DIR RE-POINTED ATOMICALLY. The path exists throughout and is a directory
/// throughout; only where it resolves to changes. A backend filters events by the canonical path
/// it saw at watch time, so without a re-watch every event under the new target is dropped.
#[test]
fn a_symlinked_state_dir_retargeted_is_rewatched() {
    let scratch = ScratchDir::new("symlink-retarget");
    let a = scratch.join("a");
    let b = scratch.join("b");
    std::fs::create_dir_all(&a).expect("a");
    std::fs::create_dir_all(&b).expect("b");
    let state = scratch.join("state");
    std::os::unix::fs::symlink(&a, &state).expect("state -> a");

    let sink = Arc::new(Counter::default());
    let source = Arc::new(MarkerReader {
        state: state.clone(),
    });
    let mut w = start(
        WatchTargets::new(&state),
        source,
        sink.clone(),
        app_timings(),
    );
    assert!(
        write_until_observed(&state, &sink, "2026-04-04", PATIENCE),
        "the symlinked state dir was not watched at all"
    );

    let tmp = scratch.join("state.tmp");
    std::os::unix::fs::symlink(&b, &tmp).expect("tmp -> b");
    std::fs::rename(&tmp, &state).expect("atomic retarget");
    assert!(
        w.wait_until(PATIENCE, |w| w.arms() >= 2),
        "the symlink was re-pointed and the watch was not re-taken"
    );
    sink.wait_quiet(Duration::from_millis(1_000), PATIENCE);
    let seen = write_until_observed(&state, &sink, "2026-05-05", PATIENCE);
    w.stop();
    assert!(
        seen,
        "a write into the NEW symlink target was never observed"
    );
}

/// A fresh install has no state directory at all. The watcher watches the parent and promotes.
#[test]
fn a_missing_state_dir_is_promoted_when_it_appears() {
    let scratch = ScratchDir::new("promote");
    let state = scratch.join("state"); // deliberately not created

    let sink = Arc::new(Counter::default());
    let source = Arc::new(MarkerReader {
        state: state.clone(),
    });
    let mut w = start(
        WatchTargets::new(&state),
        source,
        sink.clone(),
        app_timings(),
    );
    assert_eq!(w.arms(), 0, "there was nothing to watch yet");
    assert_eq!(sink.n(), 0);

    std::fs::create_dir_all(&state).expect("the engine's first run creates it");
    assert!(
        w.wait_until(PATIENCE, |w| w.arms() >= 1),
        "the state directory appeared and the watcher did not promote itself"
    );
    let seen = write_until_observed(&state, &sink, "2026-06-06", PATIENCE);
    w.stop();
    assert!(
        seen,
        "a write into the promoted directory was never observed"
    );
}

/// L14: the loop's first read is taken AFTER the watch and emitted when it differs from what the
/// caller already announced — so a change between the caller's read and the watch is not lost —
/// and not when it is the same.
#[test]
fn the_first_read_is_announced_only_if_it_differs_from_the_callers() {
    let scratch = ScratchDir::new("initial");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    // ⚠ NO `settle_backend` HERE, DELIBERATELY. Each iteration reads `sink.n()` the instant
    // `start()` returns, and `start()` returns on `is_ready`, which the loop sets inside the
    // first-pass block (`src/watcher.rs`) — before it ever reaches the wait/serve section. A
    // replayed event needs a full `DEBOUNCE_QUIET` to be served, so it cannot land inside that
    // window. An earlier draft settled here and justified it by the exact counts; the counts are
    // real but the mechanism was not, and a settle that cannot matter is one the next reader
    // copies to a site where its absence does.
    let current = Snapshot::unavailable("the engine's current answer");

    for (initial, expected) in [
        (Some(Snapshot::unavailable("an older answer")), 1),
        (Some(current.clone()), 0),
        (None, 0),
    ] {
        let sink = Arc::new(Counter::default());
        let source = Arc::new(Fixed::new(current.clone()));
        let mut w = start(
            WatchTargets::new(&state),
            source,
            sink.clone(),
            WatchOptions {
                initial,
                ..app_timings()
            },
        );
        let seen = sink.n();
        w.stop();
        assert_eq!(seen, expected);
    }
}

/// ⚠ ASSERTED WITH A TREE HASH, NOT BY READING THE CODE. A watcher that wrote into the directory
/// it watches would feed itself: every write would be a change, every change a re-read, and the
/// engine would be spawned in a loop against the user's real state directory.
#[test]
fn the_watcher_never_writes_into_the_directory_it_watches() {
    let scratch = ScratchDir::new("no-write");
    let state = scratch.join("state");
    std::fs::create_dir_all(state.join("briefings")).expect("state dir");
    std::fs::write(state.join("last-run"), "2026-09-16\n").expect("marker");
    std::fs::write(
        state.join("last-tick"),
        "2026-09-16T16:05:00.000Z local=2026-09-16 today=11\n",
    )
    .expect("tick");
    std::fs::write(state.join("schedule.json"), "{}").expect("record");

    let sink = Arc::new(Counter::default());
    // The REAL engine source, so the engine is actually spawned — a no-write assertion over a fake
    // that never runs the sidecar would prove nothing about the sidecar.
    let source = engine_source(&scratch, &state);
    // Settled before `start()` so the watcher's stream begins past this setup. The hash is
    // unaffected either way — the sentinel is removed before `settle_backend` returns — so the
    // ordering against `tree_hash` is free choice, not a constraint.
    settle_backend(&state);
    let before = tree_hash(&state);

    let mut w = start(
        WatchTargets::new(&state),
        source,
        sink.clone(),
        app_timings(),
    );
    // Touch a watched file so the loop does a full cycle: event → debounce → engine → emit.
    std::fs::write(
        state.join("last-tick"),
        "2026-09-16T16:15:00.000Z local=2026-09-16 today=12\n",
    )
    .expect("tick");
    // ⚠ HASHED HERE, BEFORE THE CYCLE RUNS, AND THIS IS THE ASSERTION THAT CATCHES THE REAL BUG.
    // The first draft only compared the tree around an IDLE watcher, which proves nothing about a
    // watcher that writes on the emit path — MEASURED: a mutation adding `fs::write` next to
    // `source.snapshot(...)` left this test GREEN and was caught by the coalescing tests instead,
    // because an idle watcher never reaches the emit path at all. `expected` is the tree as the
    // TEST left it; everything after this line is the watcher's doing.
    let expected = tree_hash(&state);
    assert!(sink.wait_for(1, PATIENCE) >= 1, "the cycle never ran");
    sink.wait_quiet(Duration::from_millis(400), PATIENCE);
    w.stop();

    let after = tree_hash(&state);
    // prove-it 3b, twice over. A hash that never changes would make the assertions below pass for a
    // watcher that rewrote the whole directory; a hash that was not stable across two reads of an
    // unchanged tree would make them fail at random. Both are checked before it is trusted.
    assert_eq!(
        after,
        tree_hash(&state),
        "the tree hash is not stable across two reads of an unchanged directory, so it cannot be \
         used as evidence either way"
    );
    assert_ne!(
        before, expected,
        "the test's own write did not change the tree hash — the hash is not sensitive enough for \
         the assertions below to mean anything"
    );
    assert_eq!(
        after, expected,
        "the watcher changed the directory it was watching WHILE SERVING A CHANGE. That is the \
         self-feeding loop this assertion exists for: every write is a change, every change a \
         re-read, and the engine is spawned in a loop against the user's real state directory."
    );

    // And the idle case: a second watcher, with only DELIBERATELY EXCLUDED files touched, must
    // leave the tree byte-identical and emit nothing.
    let sink2 = Arc::new(Counter::default());
    let source2 = engine_source(&scratch, &state);
    // The cycle above wrote `last-tick`; without settling, the backend replays that write into this
    // watcher's absence window and the idle case reads as a watcher re-reading on a timer.
    settle_backend(&state);
    let mut w2 = start(
        WatchTargets::new(&state),
        source2,
        sink2.clone(),
        app_timings(),
    );
    // ⚠ AND THE EXCLUDED NAMES, WRITTEN INTO A LIVE WATCH. `only_the_engine_state_files_count_as_a_change`
    // covers `is_interesting` as a PURE FUNCTION; nothing covered the loop's USE of it, and a
    // mutation making the loop record every event regardless (`src/watcher.rs`, the
    // `event.paths.iter().any(is_interesting)` guard) survived the whole suite — measured. The
    // module header prices that exclusion at two engine spawns per tick, ~144 ticks a day, so it is
    // worth a real assertion. This is only a usable home for it because the directory is settled:
    // before that, a replayed setup event was indistinguishable from a `briefing.log` that leaked.
    std::fs::write(state.join("briefing.log"), "tick\n").expect("log");
    std::fs::write(state.join("run.lock"), "1\n").expect("lock");
    let quiet_before = tree_hash(&state);
    std::thread::sleep(ABSENCE_WINDOW);
    w2.stop();
    assert_eq!(
        quiet_before,
        tree_hash(&state),
        "the watcher changed the directory it was watching"
    );
    assert_eq!(
        sink2.n(),
        0,
        "the watcher emitted with only `briefing.log` and `run.lock` touched — both deliberately \
         excluded from WATCHED_NAMES. Either it is re-reading on a timer, or the loop is not \
         filtering events through `is_interesting`, which costs two engine spawns per tick."
    );
}

/* ── 4. time changes the answer ───────────────────────────────────────────────────────────────── */

/// A clock the test moves by hand.
fn hand_clock(start: Now) -> (Clock, Arc<Mutex<Now>>) {
    let now = Arc::new(Mutex::new(start));
    let reader = Arc::clone(&now);
    (Arc::new(move || reader.lock().expect("lock").clone()), now)
}

/// A local instant on a UTC-7 machine.
fn local(date: &str, hh: u32, mm: u32, ss: i64) -> Now {
    let midnight_utc = parse_iso_utc(&format!("{date}T00:00:00Z")).expect("date") + 7 * 3_600;
    Now {
        local_date: date.into(),
        minutes: hh * 60 + mm,
        epoch_secs: midnight_utc + i64::from(hh) * 3_600 + i64::from(mm) * 60 + ss,
    }
}

fn envelopes(
    last_run: Option<&str>,
    tick_iso: &str,
    tick_local: &str,
) -> (serde_json::Value, serde_json::Value) {
    (
        serde_json::json!({
            "configExists": true,
            "lastRunDate": last_run,
            "latestBriefingMtime": last_run.map(|_| "2026-09-16T14:24:00.000Z"),
            "lastTick": { "iso": tick_iso, "localDate": tick_local, "count": 12 },
            "morningTime": { "value": "07:20", "minutes": 440, "warning": null },
            "paths": { "stateDir": "/unused" }
        }),
        serde_json::json!({
            "recordPresent": true, "unitPresent": true, "registered": true, "owner": "app",
            "intervalSec": 600, "lastTickState": "ok", "ticksToday": 12
        }),
    )
}

/// `schedule` with `edits` merged over it — the engine's answer, changed between two calls.
fn with(mut schedule: serde_json::Value, edits: serde_json::Value) -> serde_json::Value {
    for (k, v) in edits.as_object().expect("an object of edits") {
        schedule[k] = v.clone();
    }
    schedule
}

/// A timed watcher's handles.
struct Timed {
    w: StateWatcher,
    sink: Arc<Counter>,
    source: Arc<Fixed>,
    hand: Arc<Mutex<Now>>,
    _state: TempState,
}

impl Timed {
    fn set_clock(&self, now: Now) {
        *self.hand.lock().expect("lock") = now;
    }
    /// What the engine answers from now on. The snapshot's own derivation instant is irrelevant:
    /// the loop re-derives every read at its own clock.
    fn engine_answers(&self, status: &serde_json::Value, schedule: serde_json::Value) {
        self.source.set(Snapshot::build(
            Some(status.clone()),
            Some(schedule),
            &frozen_now(),
            None,
        ));
    }
}

/// Run a watcher over a scripted source, with the hand clock. `unhealthy_read_every` is an hour
/// unless the test is about it.
fn timed_watcher(
    start_at: Now,
    status: serde_json::Value,
    schedule: serde_json::Value,
    rederive_every: Duration,
    unhealthy_read_every: Duration,
) -> Timed {
    let scratch = TempState::new();
    let snapshot = Snapshot::build(Some(status), Some(schedule), &start_at, None);
    let (clock, hand) = hand_clock(start_at);
    let sink = Arc::new(Counter::default());
    let source = Arc::new(Fixed::new(snapshot));
    let w = start(
        WatchTargets::new(&scratch.state),
        source.clone(),
        sink.clone(),
        WatchOptions {
            rederive_every,
            unhealthy_read_every,
            clock,
            ..app_timings()
        },
    );
    Timed {
        w,
        sink,
        source,
        hand,
        _state: scratch,
    }
}

const HOUR: Duration = Duration::from_secs(3_600);

struct TempState {
    _scratch: ScratchDir,
    state: PathBuf,
}

impl TempState {
    fn new() -> Self {
        let scratch = ScratchDir::new("timed");
        let state = scratch.join("state");
        std::fs::create_dir_all(&state).expect("state dir");
        // ⚠ EVERY HAND-CLOCK TEST ASSERTS AN EXACT READ OR EMIT COUNT over a directory nothing is
        // supposed to touch, so each one is exposed to the replayed `mkdir` — settled here, once,
        // rather than in each of them.
        settle_backend(&state);
        Self {
            _scratch: scratch,
            state,
        }
    }
}

/// ⚠ H1: A DEAD SCHEDULER WRITES NOTHING. At 09:00 the 08:55 heartbeat is current ("waiting"); when
/// the loop's clock passes 08:55 + 20 min, the state must become AGENT-STALE with no file event —
/// and (R2-1) the crossing is a REAL read, because the moment the heartbeat stops is exactly when
/// the engine's own answer may have turned. Inside the deadline, nothing is read.
#[test]
fn a_waiting_state_goes_stale_when_the_clock_passes_the_deadline() {
    let (status, schedule) = envelopes(None, "2026-09-16T15:55:00.000Z", "2026-09-16");
    let mut t = timed_watcher(local("2026-09-16", 9, 0, 0), status, schedule, HOUR, HOUR);
    assert_eq!(t.sink.n(), 0);

    // Still inside the deadline: nothing to say, and nothing read.
    t.set_clock(local("2026-09-16", 9, 15, 0));
    std::thread::sleep(ABSENCE_WINDOW);
    assert_eq!(t.sink.n(), 0, "an unchanged state was announced");
    assert_eq!(
        t.source.calls(),
        1,
        "a clock move inside the deadline read the engine"
    );

    // Past it.
    t.set_clock(local("2026-09-16", 9, 16, 0));
    let seen = t.sink.wait_for(1, PATIENCE);
    let reads = t.source.calls();
    let boundary_reads = t.w.boundary_reads();
    t.w.stop();
    assert!(
        seen >= 1,
        "the heartbeat went stale and nothing was emitted"
    );
    assert_eq!(
        t.sink.phases().first().map(String::as_str),
        Some("agent-stale")
    );
    assert_eq!(
        (reads, boundary_reads),
        (2, 1),
        "crossing the stale deadline must be exactly one real read"
    );
    let payload = t.sink.last().expect("a payload");
    assert_eq!(
        payload["scheduleState"]["statusLine"],
        "Scheduler has not checked in"
    );
    assert!(
        payload["status"].is_object(),
        "the envelopes ride along: {payload}"
    );
}

/// ⚠ R2-1: AN UNLOADED UNIT WRITES NOTHING EITHER. The engine now answers `registered: false`, with
/// no file event; the stale-deadline read is what sees it — as SCHEDULER-BROKEN, which is the true
/// and the actionable answer, not the AGENT-STALE a pure re-derive of the old envelope would give.
#[test]
fn the_stale_deadline_read_finds_an_unloaded_unit() {
    let (status, schedule) = envelopes(None, "2026-09-16T15:55:00.000Z", "2026-09-16");
    let mut t = timed_watcher(
        local("2026-09-16", 9, 0, 0),
        status.clone(),
        schedule.clone(),
        HOUR,
        HOUR,
    );
    t.engine_answers(
        &status,
        with(schedule, serde_json::json!({ "registered": false })),
    );
    t.set_clock(local("2026-09-16", 9, 16, 0));
    let payload = t.sink.wait_for_payload(PATIENCE, |v| {
        v["scheduleState"]["phase"]["phase"] != serde_json::Value::Null
    });
    t.w.stop();
    let payload = payload.expect("the deadline passed and nothing was emitted");
    assert_eq!(
        payload["scheduleState"]["phase"]["phase"], "scheduler-broken",
        "the unloaded unit was not seen at the deadline: {payload}"
    );
    assert_eq!(payload["scheduleState"]["registered"], false);
}

/// ⚠ H1 + R2-1: A DELIVERED DAY ENDS AT LOCAL MIDNIGHT, AND MIDNIGHT IS A REAL READ. Delivered at
/// 07:24; at 00:00:05 the next day, with a heartbeat five minutes old, the state is the next day's
/// waiting-for-floor — carrying the ENGINE's new-day count (a parsed tick from yesterday is `0`
/// today), not yesterday's 12 paired with today's countdown.
#[test]
fn a_delivered_day_rolls_over_at_local_midnight_with_the_engines_new_day_count() {
    let (status, schedule) =
        envelopes(Some("2026-09-16"), "2026-09-17T06:55:00.000Z", "2026-09-16");
    let mut t = timed_watcher(
        local("2026-09-16", 23, 59, 30),
        status.clone(),
        schedule.clone(),
        HOUR,
        HOUR,
    );
    std::thread::sleep(ABSENCE_WINDOW);
    assert_eq!(t.sink.n(), 0, "nothing changed before midnight");

    t.engine_answers(
        &status,
        with(
            schedule,
            serde_json::json!({ "ticksToday": 0, "ticksExpectedSinceFloor": null }),
        ),
    );
    t.set_clock(local("2026-09-17", 0, 0, 5));
    let seen = t.sink.wait_for(1, PATIENCE);
    let boundary_reads = t.w.boundary_reads();
    t.w.stop();
    assert!(
        seen >= 1,
        "midnight passed and the delivered day did not end"
    );
    assert_eq!(
        t.sink.phases().first().map(String::as_str),
        Some("waiting-for-floor")
    );
    let payload = t.sink.last().expect("a payload");
    assert_eq!(
        payload["scheduleState"]["ticksToday"], 0,
        "after midnight the screen paired today's countdown with yesterday's count: {payload}"
    );
    assert_eq!(boundary_reads, 1, "midnight must be exactly one real read");
}

/// ⚠ H1: NO EMIT WHEN NOTHING CHANGED — measured over MANY re-derivations, not assumed from zero of
/// them (the re-derivation counter is what makes the zero mean something). And they are PURE: no
/// boundary is crossed, so nothing is read.
#[test]
fn rederiving_an_unchanged_state_emits_nothing() {
    let (status, schedule) = envelopes(None, "2026-09-16T15:55:00.000Z", "2026-09-16");
    let mut t = timed_watcher(
        local("2026-09-16", 9, 0, 0),
        status,
        schedule,
        Duration::from_millis(20),
        HOUR,
    );
    // Move the clock within the same state, repeatedly.
    for second in 1..30 {
        t.set_clock(local("2026-09-16", 9, 1, second));
        std::thread::sleep(Duration::from_millis(40));
    }
    let rederived = t.w.wait_until(PATIENCE, |w| w.rederives() >= 5);
    let seen = t.sink.n();
    let reads = t.source.calls();
    let rederives = t.w.rederives();
    t.w.stop();
    assert!(
        rederived,
        "the loop re-derived only {rederives} time(s), so an absence of events proves nothing"
    );
    assert_eq!(seen, 0, "an unchanged state was announced");
    assert_eq!(reads, 1);
}

/// Before the floor the countdown is part of the state, so it is re-announced each minute — by a
/// PURE re-derive (the engine's answer does not turn between minutes).
#[test]
fn the_countdown_to_the_floor_is_kept_current_without_reading() {
    let (status, schedule) = envelopes(None, "2026-09-16T12:55:00.000Z", "2026-09-16");
    let mut t = timed_watcher(local("2026-09-16", 6, 0, 30), status, schedule, HOUR, HOUR);
    t.set_clock(local("2026-09-16", 6, 1, 0));
    let seen = t.sink.wait_for(1, PATIENCE);
    let reads = t.source.calls();
    t.w.stop();
    assert!(seen >= 1);
    let payload = t.sink.last().expect("a payload");
    assert_eq!(payload["scheduleState"]["phase"]["minutesUntilFloor"], 79);
    assert_eq!(reads, 1, "a minute of countdown read the engine");
}

/// ⚠ R2-1: THE FLOOR IS A REAL READ. The engine's `ticksExpectedSinceFloor` is `null` before it and a
/// number after it, so a pure re-derive at 07:20 would show the new phase with the old figure.
#[test]
fn crossing_the_floor_reads_the_engine() {
    // A heartbeat at 07:15 local, so the stale deadline (07:35:01) is not what is crossed here.
    let (status, schedule) = envelopes(None, "2026-09-16T14:15:00.000Z", "2026-09-16");
    let schedule = with(
        schedule,
        serde_json::json!({ "ticksExpectedSinceFloor": null }),
    );
    let mut t = timed_watcher(
        local("2026-09-16", 7, 19, 0),
        status.clone(),
        schedule.clone(),
        HOUR,
        HOUR,
    );
    t.engine_answers(
        &status,
        with(
            schedule,
            serde_json::json!({ "ticksExpectedSinceFloor": 1 }),
        ),
    );
    t.set_clock(local("2026-09-16", 7, 20, 5));
    let payload = t.sink.wait_for_payload(PATIENCE, |v| {
        v["scheduleState"]["phase"]["phase"] == "waiting-for-wake"
    });
    let boundary_reads = t.w.boundary_reads();
    t.w.stop();
    let payload = payload.expect("the floor passed and the phase did not move");
    assert_eq!(
        payload["scheduleState"]["ticksExpectedSinceFloor"], 1,
        "the floor was crossed on the old envelope: {payload}"
    );
    assert_eq!(boundary_reads, 1);
}

/// ⚠ R2-1: WHILE A UNIT CAN BE LOADED OR UNLOADED BEHIND THE APP'S BACK, THE LOOP RE-READS. A dead
/// scheduler (AGENT-STALE) is unloaded — no file event, no boundary, the clock standing still — and
/// the periodic read shows SCHEDULER-BROKEN; the unit is reloaded, and the next one shows that too.
///
/// ⚠ AND NO FASTER THAN THE PERIOD — which is only measurable with a period ABOVE the loop's own
/// [`RECOVERY_POLL`]. Round 2 used 300 ms, below the 500 ms poll, where "once per period" and "once
/// per loop pass" are the same count; MEASURED in review round 3, a loop that never reset its read
/// clock after a time-driven read — so it read on EVERY pass once the period had first elapsed,
/// ~1,200 spawns in 30 s on a dead scheduler — passed it. So the period here is 1.2 s, the window a
/// fixed ~6 s, and two things are asserted over every engine read in it: no two are closer together
/// than the period (less a scheduling slack far below the 500 ms a per-pass read would show), and
/// the periodic count is within `elapsed / period + 1`.
#[test]
fn an_unhealthy_state_is_re_read_every_period() {
    const PERIOD: Duration = Duration::from_millis(1_200);
    const WINDOW: Duration = Duration::from_secs(6);
    /// Between the loop stamping its read clock and the source being asked: two statements.
    const SLACK: Duration = Duration::from_millis(100);
    assert!(
        PERIOD > RECOVERY_POLL + SLACK,
        "a period at or below the loop's poll cannot tell a per-period read from a per-pass one"
    );
    // The last tick two hours before a 09:00 that never moves.
    let (status, schedule) = envelopes(None, "2026-09-16T14:00:00.000Z", "2026-09-16");
    let started = Instant::now();
    let mut t = timed_watcher(
        local("2026-09-16", 9, 0, 0),
        status.clone(),
        schedule.clone(),
        HOUR,
        PERIOD,
    );
    t.engine_answers(
        &status,
        with(schedule.clone(), serde_json::json!({ "registered": false })),
    );
    let broken = t.sink.wait_for_payload(PATIENCE, |v| {
        v["scheduleState"]["phase"]["phase"] == "scheduler-broken"
    });
    t.engine_answers(&status, schedule);
    let back = t.sink.wait_for_payload(PATIENCE, |v| {
        v["scheduleState"]["phase"]["phase"] == "agent-stale"
    });
    // The rest of the window with the answer unchanged: the reads go on, at the period.
    if let Some(rest) = WINDOW.checked_sub(started.elapsed()) {
        std::thread::sleep(rest);
    }
    // Stopped BEFORE anything is counted, so the counters and the call log are final and every
    // read they record happened inside `elapsed`.
    t.w.stop();
    let elapsed = started.elapsed();
    let (periodic, boundary) = (t.w.periodic_reads(), t.w.boundary_reads());
    let asked_at = t.source.asked_at();
    assert!(
        broken.is_some(),
        "an unloaded unit was never seen while the scheduler was stale: {:?}",
        t.sink.phases()
    );
    assert!(back.is_some(), "the reload was never seen");
    assert_eq!(
        boundary, 0,
        "no boundary was crossed; these were periodic reads"
    );
    assert_eq!(
        asked_at.len() as u64,
        periodic + 1,
        "every read after the first should be a periodic one"
    );
    let gaps: Vec<Duration> = asked_at.windows(2).map(|w| w[1] - w[0]).collect();
    assert!(
        gaps.iter().all(|gap| *gap + SLACK >= PERIOD),
        "engine reads closer together than the {PERIOD:?} period: {gaps:?}"
    );
    let bound = (elapsed.as_millis() / PERIOD.as_millis()) as u64 + 1;
    assert!(
        (2..=bound).contains(&periodic),
        "{periodic} periodic reads in {elapsed:?} at a {PERIOD:?} period (bound {bound}; gaps \
         {gaps:?})"
    );
}

/// …and a healthy state is NOT re-read on a timer: its own ticks are its file events.
#[test]
fn a_healthy_state_is_not_re_read_periodically() {
    let (status, schedule) = envelopes(None, "2026-09-16T15:55:00.000Z", "2026-09-16");
    let mut t = timed_watcher(
        local("2026-09-16", 9, 0, 0),
        status,
        schedule,
        HOUR,
        Duration::from_millis(50),
    );
    std::thread::sleep(ABSENCE_WINDOW);
    let (reads, periodic) = (t.source.calls(), t.w.periodic_reads());
    t.w.stop();
    assert_eq!(
        (reads, periodic),
        (1, 0),
        "a waiting (healthy) state was re-read on a timer"
    );
}

/// The app's cadences, as values: a re-derive at least once a minute, an unhealthy re-read no more
/// than every five.
#[test]
fn the_time_cadences_are_the_documented_ones() {
    let (rederive, unhealthy) = (REDERIVE_EVERY, UNHEALTHY_READ_EVERY);
    assert!(
        rederive <= Duration::from_secs(60),
        "REDERIVE_EVERY is {rederive:?}; the docs promise a re-derive at least every 60 s"
    );
    assert_eq!(unhealthy, Duration::from_secs(300));
    let defaults = WatchOptions::default();
    assert_eq!(defaults.rederive_every, REDERIVE_EVERY);
    assert_eq!(defaults.unhealthy_read_every, UNHEALTHY_READ_EVERY);
}

/// Which snapshots are re-read on the unhealthy period. **Pure.**
#[test]
fn only_unhealthy_or_degraded_snapshots_want_a_periodic_read() {
    let now = local("2026-09-16", 9, 0, 0);
    let (status, schedule) = envelopes(None, "2026-09-16T15:55:00.000Z", "2026-09-16");
    let build = |schedule: serde_json::Value| {
        Snapshot::build(Some(status.clone()), Some(schedule), &now, None)
    };
    let cases = [
        ("waiting", build(schedule.clone()), false),
        (
            "not-scheduled",
            build(with(
                schedule.clone(),
                serde_json::json!({ "recordPresent": false }),
            )),
            true,
        ),
        (
            "scheduler-broken",
            build(with(
                schedule.clone(),
                serde_json::json!({ "unitPresent": false }),
            )),
            true,
        ),
        (
            "unknown-tick",
            build(with(
                schedule.clone(),
                serde_json::json!({ "lastTickState": "legacy" }),
            )),
            false,
        ),
        (
            "failed schedule read",
            Snapshot::build(
                Some(status.clone()),
                None,
                &now,
                Some("`schedule status --json` failed".into()),
            ),
            true,
        ),
        ("no state", Snapshot::unavailable("EACCES"), true),
    ];
    for (what, snapshot, expected) in cases {
        assert_eq!(snapshot.wants_periodic_read(), expected, "{what}");
    }
    let stale = Snapshot::build(
        Some(serde_json::json!({
            "configExists": true,
            "lastTick": { "iso": "2026-09-16T14:00:00.000Z", "localDate": "2026-09-16", "count": 3 },
            "morningTime": { "value": "07:20", "minutes": 440, "warning": null }
        })),
        Some(schedule),
        &now,
        None,
    );
    assert!(matches!(
        stale.schedule_state.as_ref().map(|s| &s.phase),
        Some(Phase::AgentStale { .. })
    ));
    assert!(stale.wants_periodic_read(), "agent-stale");
}

/* ── 4b. live payloads carry the engine's CURRENT schedule answer ─────────────────────────────── */

/// `new Date().toISOString()` for this instant, whole seconds.
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs() as i64;
    let c = utc_civil(secs);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        c.year,
        c.month,
        c.day,
        c.hour,
        c.minute,
        secs.rem_euclid(60)
    )
}

/// ⚠ R2-1, V3's EXPERIMENT AS A TEST. The real `EngineSnapshots`, the real watcher and a fake engine
/// that recomputes the per-read facts on every call (as `src/schedule/status.ts` does). Before the
/// fix, each case was MEASURED wrong: the count stayed 4 while `last-tick` said 11; a legacy
/// heartbeat replaced by a valid one stayed UNKNOWN-TICK; an unloaded unit stayed "registered".
#[test]
fn live_payloads_carry_the_engines_current_schedule_answer() {
    let today = now_local().local_date;
    type Check = fn(&serde_json::Value) -> bool;
    let cases: [(&str, String, String, bool, Check); 3] = [
        (
            "count",
            format!("{} local={today} today=4", iso_now()),
            format!("{} local={today} today=11", iso_now()),
            false,
            |v| v["scheduleState"]["ticksToday"] == 11 && v["status"]["lastTick"]["count"] == 11,
        ),
        (
            "legacy",
            "2026-08-01T00:00:00.000Z today=3".to_string(),
            format!("{} local={today} today=1", iso_now()),
            false,
            |v| {
                v["scheduleState"]["phase"]["phase"] != "unknown-tick"
                    && !v["scheduleState"]["phase"]["phase"].is_null()
                    && v["scheduleState"]["ticksToday"] == 1
            },
        ),
        (
            "unloaded",
            format!("{} local={today} today=4", iso_now()),
            format!("{} local={today} today=5", iso_now()),
            true,
            |v| {
                v["scheduleState"]["phase"]["phase"] == "scheduler-broken"
                    && v["scheduleState"]["registered"] == false
            },
        ),
    ];
    for (name, first, second, unload, check) in cases {
        let scratch = ScratchDir::new(&format!("live-{name}"));
        let state = scratch.join("state");
        std::fs::create_dir_all(&state).expect("state dir");
        std::fs::write(state.join("schedule.json"), "{}").expect("record");
        std::fs::write(state.join("last-tick"), format!("{first}\n")).expect("tick");
        let program = state_sidecar(&scratch.path, "engine.sh", &state, None);
        let snaps = Arc::new(EngineSnapshots::new(Ok(EngineClient::with_program(
            program,
        ))));
        let initial = block(snaps.snapshot_async());
        assert!(
            !check(&serde_json::to_value(&initial).expect("JSON")),
            "{name}: the starting state already satisfies the check, so it proves nothing"
        );
        let sink = Arc::new(Counter::default());
        let mut w = start(
            WatchTargets::new(&state),
            snaps.clone(),
            sink.clone(),
            WatchOptions {
                initial: Some(initial),
                ..live_clock()
            },
        );
        if unload {
            std::fs::write(unloaded_flag(&scratch.path, "engine.sh"), "x").expect("unload");
        }
        std::fs::write(state.join("last-tick"), format!("{second}\n")).expect("tick");
        let seen = sink.wait_for_payload(PATIENCE, check);
        w.stop();
        assert!(
            seen.is_some(),
            "{name}: no live payload carried the engine's current answer: {:?}",
            sink.last()
        );
        let seen = seen.expect("checked");
        assert_eq!(seen["scheduleStale"], false, "{name}: {seen}");
        assert!(seen["error"].is_null(), "{name}: {seen}");
    }
}

/* ── 5. the engine-backed source, when the engine fails ───────────────────────────────────────── */

/// A fake engine that fails on demand: `status --json` when `<dir>/fail-status` exists (its content
/// `kill` means SIGKILL itself, `garbage` means exit 0 with non-JSON), `schedule status --json` when
/// `<dir>/fail-schedule` exists; otherwise the state-reading fake.
fn failing_engine(scratch: &ScratchDir, state: &Path) -> PathBuf {
    let inner = state_sidecar(&scratch.path, "inner.sh", state, None);
    let fs = scratch.join("fail-status");
    let fsc = scratch.join("fail-schedule");
    fake_sidecar(
        &scratch.path,
        "failing.sh",
        &format!(
            "case \"$1:$2\" in\n  status:--json)\n    if [ -f \"{fs}\" ]; then\n      m=$(cat \"{fs}\")\n      if [ \"$m\" = kill ]; then kill -9 $$; fi\n      if [ \"$m\" = garbage ]; then printf 'not json'; exit 0; fi\n      echo 'engine exploded: EACCES' >&2; exit 1\n    fi ;;\n  schedule:status)\n    if [ -f \"{fsc}\" ]; then echo 'launchctl: timed out' >&2; exit 1; fi ;;\nesac\nexec \"{inner}\" \"$@\"",
            fs = fs.display(),
            fsc = fsc.display(),
            inner = inner.display(),
        ),
    )
}

fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// ⚠ M11 + R2-1: A FAILED READ IS AN ERROR, NOT A BLANK — AND A CACHED SCHEDULE HALF SAYS IT IS
/// ONE. MEASURED before round 1: exit 1 and SIGKILL both produced `status: null, error: null`, and a
/// failed `schedule status` REPLACED a good cached envelope with nothing. Round 2: the kept envelope
/// is marked `scheduleStale`, and its per-read facts are withheld rather than shown as current.
#[test]
fn failed_engine_reads_are_reported_and_never_wipe_the_cache() {
    let scratch = ScratchDir::new("failing");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    std::fs::write(state.join("schedule.json"), "{}").expect("record");
    let today = now_local().local_date;
    std::fs::write(
        state.join("last-tick"),
        format!("{} local={today} today=7\n", iso_now()),
    )
    .expect("tick");
    let program = failing_engine(&scratch, &state);
    let snaps = EngineSnapshots::new(Ok(EngineClient::with_program(program)));

    // Healthy: both halves, no error, fresh, the cache filled.
    let good = block(snaps.snapshot_async());
    assert_eq!(good.error, None);
    assert!(!good.schedule_stale);
    assert_eq!(
        good.schedule.as_ref().map(|s| &s["owner"]),
        Some(&serde_json::json!("app"))
    );
    let fresh = good.schedule_state.as_ref().expect("a state");
    assert_eq!(fresh.ticks_today, Some(7));
    assert_eq!(fresh.ticks_expected_since_floor, Some(11));

    // `schedule status` fails: the cached envelope is KEPT, MARKED, and the failure is SAID.
    std::fs::write(scratch.join("fail-schedule"), "x").expect("flag");
    for attempt in 0..2 {
        let s = block(snaps.snapshot_async());
        assert_eq!(
            s.schedule, good.schedule,
            "attempt {attempt}: the cached schedule was lost"
        );
        assert!(
            s.schedule_stale,
            "attempt {attempt}: a cached schedule half was presented as this read's"
        );
        let st = s.schedule_state.as_ref().expect("a state");
        assert_eq!(
            st.owner.as_deref(),
            Some("app"),
            "attempt {attempt}: the state was derived without the schedule"
        );
        assert_eq!(
            (st.ticks_today, st.ticks_expected_since_floor),
            (None, None),
            "attempt {attempt}: an earlier read's tick figures were shown as current"
        );
        let error = s.error.expect("a failed schedule read must be reported");
        assert!(
            error.contains("schedule status --json") && error.contains("launchctl: timed out"),
            "{error}"
        );
        let wire = serde_json::to_value(block(snaps.snapshot_async())).expect("JSON");
        assert_eq!(wire["scheduleStale"], true, "{wire}");
        assert!(wire["scheduleState"]["ticksToday"].is_null(), "{wire}");
    }
    // The watcher's blocking path is the same implementation.
    let sync = snaps.snapshot();
    assert!(sync.schedule_stale);
    assert!(sync
        .error
        .unwrap_or_default()
        .contains("launchctl: timed out"));
    std::fs::remove_file(scratch.join("fail-schedule")).expect("unflag");
    // …and the next good read is fresh again.
    let recovered = block(snaps.snapshot_async());
    assert!(!recovered.schedule_stale && recovered.error.is_none());

    // `status` fails three ways; each is an error with the engine's words or a plain statement.
    for (mode, needle) in [
        ("exit", "engine exploded: EACCES"),
        ("kill", "killed by a signal"),
        ("garbage", "without printing a JSON envelope"),
    ] {
        std::fs::write(scratch.join("fail-status"), mode).expect("flag");
        let s = block(snaps.snapshot_async());
        assert!(s.status.is_none(), "{mode}: {s:?}");
        assert!(s.schedule_state.is_none(), "{mode}: a state was invented");
        let error = s.error.unwrap_or_default();
        assert!(
            error.contains("status --json") && error.contains(needle),
            "{mode}: the error does not say what happened: {error:?}"
        );
    }
    // A failed status read did not touch the cache either.
    std::fs::remove_file(scratch.join("fail-status")).expect("unflag");
    std::fs::write(scratch.join("fail-schedule"), "x").expect("flag");
    let after = block(snaps.snapshot_async());
    assert_eq!(after.schedule, recovered.schedule);
    assert!(after.schedule_stale);

    // With NO cached envelope at all, a failed schedule read is an error and a null schedule —
    // not a stale one, because there is nothing earlier to be stale.
    let cold = EngineSnapshots::new(Ok(EngineClient::with_program(failing_engine(
        &scratch, &state,
    ))));
    let s = block(cold.snapshot_async());
    assert!(s.schedule.is_none() && !s.schedule_stale && s.error.is_some());
}

/// Poll until no live process carries `tag` in its command line, then assert there is none.
///
/// ⚠ WHAT AN EMPTY RESULT IS AND IS NOT. It is a backstop over ANY process of the spawn, whatever
/// its name — a leak of the sidecar itself would be invisible to a filter that named only the
/// wrapper. It is NOT evidence about a particular one of them: `pgrep -f` matches on the command
/// line and under-matches on long ones, so a specific process is pinned by pid
/// ([`process_gone`]), not by this.
fn assert_no_tagged_survivors(tag: &str) {
    let deadline = Instant::now() + PATIENCE;
    let mut survivors = String::new();
    while Instant::now() < deadline {
        let out = std::process::Command::new("pgrep")
            .args(["-fl", tag])
            .output()
            .expect("pgrep runs");
        survivors = String::from_utf8_lossy(&out.stdout).into_owned();
        if survivors.trim().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        survivors.trim().is_empty(),
        "the timed-out engine read left a process behind: {survivors}"
    );
}

/// ⚠ M11: A HUNG READ IS ABANDONED, AND AN `exec`-SHAPED SIDECAR IS KILLED WITH IT. A
/// `schedule status` that never returns used to wedge the watcher's thread for the session.
///
/// ⚠ WHAT THIS PROVES IS NARROW, AND THE NAME SAYS SO: the fake `exec`s its sleeper, so the spawned
/// pid IS the only process — which is the shape of the real sidecar binary itself, but not of the
/// children it forks. `a_timed_out_read_kills_the_sidecar_and_the_children_it_forked` is the one
/// that covers those.
#[test]
fn a_hung_exec_shaped_sidecar_is_killed_by_the_read_timeout() {
    let scratch = ScratchDir::new("hung");
    // If the assertion below fails, the sleeper outlives the test by 30 s without this; every
    // other process test here carries the same net.
    let _reap = ReapTagged(scratch.tag());
    let program = sleeper(&scratch.path, "hung.sh", 30);
    let snaps = EngineSnapshots::new(Ok(EngineClient::with_program(program)))
        .with_timeout(Duration::from_millis(500));

    let started = Instant::now();
    let s = snaps.snapshot();
    let took = started.elapsed();
    assert!(took < Duration::from_secs(10), "the read took {took:?}");
    let error = s.error.unwrap_or_default();
    assert!(
        error.contains("status --json") && error.contains("did not answer within 500ms"),
        "{error:?}"
    );

    // The abandoned future took the child with it.
    assert_no_tagged_survivors(&scratch.tag());
}

/// What a [`probed_timed_out_read`] saw. Every field is an observation, never an inference.
#[derive(Debug, Default)]
struct ProbedRead {
    /// What the fake recorded as its own pid, and the process group `ps` told it it was in.
    sidecar_pid: String,
    sidecar_pgid: String,
    /// What the fake recorded as the pid of the child it forked.
    child_pid: String,
    /// Whether `child_pid` was ever seen RUNNING while the read was in flight. Without this,
    /// "it is gone afterwards" is also what a child that never ran looks like.
    child_seen_running: bool,
    /// How long `sidecar_pid` was observed as a ZOMBIE while the read was in flight — exited, and
    /// deliberately not yet reaped, which is what pins its pid (and so its process-group id). The
    /// span between the first and last `Z` sighting, so zero when it was seen at most once.
    ///
    /// ⚠ A DURATION, NOT A FLAG AND NOT A COUNT, and each step matters. A sidecar reaped inside the
    /// `join!` is ALSO transiently `Z` — between its `exit` and tokio's SIGCHLD-driven reap — so a
    /// single sighting proves nothing and a one-shot flag lets that shape pass whenever the probe
    /// lands in that window. A COUNT fixes that but is measured in probe iterations, and the probe
    /// period moves with machine load, as does the reap window it has to out-measure; a count is
    /// only as good as an assumption about their ratio. A duration is invariant to probe speed in
    /// both directions. [`ProbedRead::stayed_zombie`] is the threshold.
    sidecar_zombie_window: Duration,
}

impl ProbedRead {
    /// The minimum any of these tests needs before its gone-checks mean anything: the fake got far
    /// enough to record both pids AND its own pgid, and the child was actually seen running.
    ///
    /// The pgid belongs here rather than in a bare assertion for the reason the ladder exists: a
    /// rung whose `ps -o pgid=` failed to fork under load measured nothing, and must be retried
    /// rather than turned into a spurious `assert_eq!("", "12345")`.
    fn forked_and_was_seen(&self) -> bool {
        !self.sidecar_pid.is_empty()
            && !self.sidecar_pgid.is_empty()
            && !self.child_pid.is_empty()
            && self.child_seen_running
    }

    /// Whether the sidecar was seen as a zombie for LONGER than a reap could take — the threshold
    /// that separates "deliberately left un-reaped for the whole read" from "briefly `Z` on its
    /// way to being reaped inside the `join!`".
    ///
    /// MEASURED, so 100 ms is not a bare number. The shipped ordering holds the zombie for the
    /// whole remaining read — ≥500 ms even on the first rung — because nothing reaps it until
    /// `wait()`, which runs after the pipes drain. Reaping inside the `join!` holds it for one
    /// SIGCHLD-driven task wake-up: single-digit milliseconds. 100 ms sits an order of magnitude
    /// from both ends. One probe iteration is ~25-35 ms (a 20 ms sleep plus two `ps` forks), so
    /// the shipped path clears the threshold with samples to spare, and the ladder retries a rung
    /// that did not.
    fn stayed_zombie(&self) -> bool {
        self.sidecar_zombie_window >= Duration::from_millis(100)
    }
}

/// Stops a probe thread on EVERY exit path, an unwinding assertion inside the ladder included —
/// otherwise a failing attempt leaves a thread forking `ps` every 20 ms for the rest of the run.
struct StopProbe(Arc<AtomicBool>);

impl Drop for StopProbe {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// A pid file's contents — `""` unless it holds a COMPLETE number.
///
/// ⚠ PARSED, NOT MERELY NON-EMPTY: a reader races the shell's `echo $! > file`, and a torn read
/// yields a truncated number that may match an unrelated live process. Recorded as "the child was
/// seen running", it would then be blamed on the wrong thing when the exact pid is asked for.
fn read_pid(path: &Path) -> String {
    let raw = std::fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_string();
    if raw.parse::<u32>().is_ok() {
        raw
    } else {
        String::new()
    }
}

/// Poll until `pid` is gone, then assert it is.
fn assert_gone(what: &str, pid: &str) {
    // ⚠ AN EMPTY PID PASSES THIS SILENTLY OTHERWISE. MEASURED: `ps -o stat= -p ""` exits 1 with
    // EMPTY stdout, so `process_gone("")` is `true` — a fixture that recorded no pid would sail
    // through the very check that exists to catch a survivor.
    assert!(
        !pid.is_empty(),
        "{what}: no pid was recorded, so this gone-check would pass without measuring anything"
    );
    let deadline = Instant::now() + PATIENCE;
    while !process_gone(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        process_gone(pid),
        "the timed-out read left the {what} (pid {pid}) running"
    );
}

/// Drive `program` through an engine read that TIMES OUT, sampling `ps` while it is in flight, and
/// return what was observed. `files` is (sidecar pid, sidecar pgid, child pid), each a path the
/// fake writes.
///
/// ⚠ THE TIMEOUT GROWS UNTIL AN ATTEMPT OBSERVED WHAT THE CALLER NEEDS. MEASURED: under the full
/// suite's parallel load a 500 ms timeout sometimes fired before the shell had run its first line,
/// so there was no pid to check and no child either. An attempt that did not get that far proves
/// nothing about what the timeout kills, so `ready` says whether it did and a short attempt is
/// RETRIED rather than counted — an assertion outside this loop would turn the retryable case into
/// a failure. Callers still assert the same condition afterwards, for when all three rungs fall
/// short.
fn probed_timed_out_read(
    program: &Path,
    files: (&Path, &Path, &Path),
    ready: impl Fn(&ProbedRead) -> bool,
) -> ProbedRead {
    let (pid_file, pgid_file, child_pid_file) = files;
    let mut observed = ProbedRead::default();
    for timeout_ms in [500u64, 2_000, 8_000] {
        let _ = std::fs::remove_file(pid_file);
        let _ = std::fs::remove_file(pgid_file);
        let _ = std::fs::remove_file(child_pid_file);

        let stop = Arc::new(AtomicBool::new(false));
        let _stop_on_unwind = StopProbe(Arc::clone(&stop));
        // (pids seen running, first and last instant the sidecar was seen as a zombie)
        type Samples = (Vec<String>, Option<Instant>, Option<Instant>);
        let samples: Arc<Mutex<Samples>> = Arc::new(Mutex::new((Vec::new(), None, None)));
        let probe = {
            let (watch_child, watch_sidecar) =
                (child_pid_file.to_path_buf(), pid_file.to_path_buf());
            let stop = Arc::clone(&stop);
            let samples = Arc::clone(&samples);
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let child = read_pid(&watch_child);
                    let sidecar = read_pid(&watch_sidecar);
                    let mut s = samples.lock().unwrap_or_else(|e| e.into_inner());
                    if !child.is_empty() && !process_gone(&child) && !s.0.contains(&child) {
                        s.0.push(child);
                    }
                    if !sidecar.is_empty() && process_stat(&sidecar).starts_with('Z') {
                        let now = Instant::now();
                        s.1.get_or_insert(now);
                        s.2 = Some(now);
                    }
                    drop(s);
                    std::thread::sleep(Duration::from_millis(20));
                }
            })
        };

        let snaps = EngineSnapshots::new(Ok(EngineClient::with_program(program.to_path_buf())))
            .with_timeout(Duration::from_millis(timeout_ms));
        let s = snaps.snapshot();
        let error = s.error.unwrap_or_default();
        let expected = if timeout_ms >= 1_000 {
            format!("did not answer within {}s", timeout_ms / 1_000)
        } else {
            format!("did not answer within {timeout_ms}ms")
        };
        assert!(
            error.contains("status --json") && error.contains(&expected),
            "{error:?}"
        );

        stop.store(true, Ordering::SeqCst);
        probe.join().expect("the probe thread");
        let child_pid = read_pid(child_pid_file);
        let seen = samples.lock().unwrap_or_else(|e| e.into_inner());
        observed = ProbedRead {
            sidecar_pid: read_pid(pid_file),
            // Through `read_pid` like the other two: the fake writes this with `ps … > file` and
            // the `killpg` can cut that write short, and a truncated-but-non-empty pgid would
            // satisfy the readiness predicate, break the ladder, and die at the `assert_eq!`
            // below — the exact spurious failure the ladder exists to prevent.
            sidecar_pgid: read_pid(pgid_file),
            child_seen_running: !child_pid.is_empty() && seen.0.contains(&child_pid),
            sidecar_zombie_window: match (seen.1, seen.2) {
                (Some(first), Some(last)) => last.saturating_duration_since(first),
                _ => Duration::ZERO,
            },
            child_pid,
        };
        drop(seen);
        if ready(&observed) {
            break;
        }
    }
    observed
}

/// ⚠ R2-2, NOW CLOSED: THE TIMEOUT TAKES THE WHOLE PROCESS GROUP. A sidecar that FORKS its hung
/// work (as the real one forks `launchctl list`) is killed by the timeout, and so is the fork: the
/// spawn is put in a process group of its own and the dropped invocation `killpg`s it
/// (`engine.rs`, `invoke` + `ProcessGroupKill`). This test was
/// `a_timed_out_read_kills_the_sidecar_but_not_its_children` while the orphan was the documented
/// residual (deviation 30); it now asserts the child is gone rather than reporting that it is not.
///
/// ⚠ AND IT ASSERTS THE CHILD WAS ALIVE FIRST, because "gone afterwards" is what a child that never
/// ran looks like too — a sleeper whose `exec` failed would pass a gone-check trivially. A probe
/// thread watches the recorded pid while the read is in flight and the assertion requires that
/// exact pid in what it saw running.
#[test]
fn a_timed_out_read_kills_the_sidecar_and_the_children_it_forked() {
    let scratch = ScratchDir::new("hung-fork");
    let tag = scratch.tag();
    let _reap = ReapTagged(tag.clone());
    // `sleeper` makes the tagged `<scratch>/sleep` symlink; its own script is not used.
    let _ = sleeper(&scratch.path, "unused.sh", 1);
    let pid_file = scratch.join("sidecar.pid");
    let pgid_file = scratch.join("sidecar.pgid");
    let child_pid_file = scratch.join("child.pid");
    // The sleeper is BACKGROUNDED and the shell `wait`s on it, so the spawned pid stays alive as a
    // parent with a live child — the shape of the real sidecar forking `launchctl list`, and the
    // shape an `exec`ing fake cannot produce.
    //
    // ⚠ IT ALSO RECORDS ITS OWN PGID, because that is the premise the whole kill rests on and
    // nothing else pins it. `ProcessGroupKill` signals `child.id()` — a PID — and only
    // `process_group(0)` makes that number a group id; the guard's own refusals cannot tell the
    // difference. The fake asking the OS "what group am I in" is an answer from outside the code
    // under test.
    let program = fake_sidecar(
        &scratch.path,
        "forking.sh",
        &format!(
            "echo $$ > \"{pid}\"\nps -o pgid= -p $$ > \"{pgid}\"\n\"{sleep}\" 41 &\n\
             echo $! > \"{child}\"\nwait\nexit 0",
            pid = pid_file.display(),
            pgid = pgid_file.display(),
            child = child_pid_file.display(),
            sleep = scratch.join("sleep").display(),
        ),
    );

    let observed = probed_timed_out_read(&program, (&pid_file, &pgid_file, &child_pid_file), |o| {
        o.forked_and_was_seen()
    });
    assert!(
        observed.forked_and_was_seen(),
        "in 8 s the sidecar never forked a child this test could observe RUNNING, so the \
         gone-checks below would mean nothing: {observed:?}"
    );

    // ⚠ THE PREMISE, ASSERTED RATHER THAN ASSUMED: the sidecar led a process group of its own, and
    // that group's id is its pid — which is what makes `ProcessGroupKill`'s `killpg(child.id())`
    // a kill of THIS spawn's group rather than of whatever else happens to carry that number.
    // Without `process_group(0)` the sidecar would be in the test runner's group and this fails
    // before the gone-checks, which would otherwise fail for a reason that never names the cause.
    assert_eq!(
        observed.sidecar_pgid, observed.sidecar_pid,
        "the sidecar's process group is not its own pid, so the spawn was never put in a group of \
         its own: {observed:?}"
    );

    // Both halves now: the sidecar, and the child it forked and the old `kill_on_drop` could not
    // reach.
    assert_gone("sidecar", &observed.sidecar_pid);
    assert_gone("forked child", &observed.child_pid);

    // …and nothing else of this spawn survives either, whatever it is. Deliberately NOT read as
    // evidence about the `caffeinate` assertion holder specifically: that one exits with its
    // parent anyway (`engine::CAFFEINATE`, measured), so it would be gone with or without a group
    // kill. See [`assert_no_tagged_survivors`].
    assert_no_tagged_survivors(&tag);
}

/// ⚠ THE ORDERING INSIDE `invoke` IS WHAT THIS PINS, and nothing else does. `engine::invoke` drains
/// both pipes and only THEN calls `child.wait()`, disarming `ProcessGroupKill` on its return. The
/// comment there rejects both one-`join!` shapes, and until this test existed a reviewer could
/// revert to either and watch the whole suite stay green — the other timeout test's fake `wait`s on
/// its sleeper, so its sidecar has not exited when the timeout fires and the guard is armed under
/// every shape.
///
/// This fake is the discriminating one: it EXITS IMMEDIATELY, and the sleeper it backgrounds
/// INHERITS the pipes (no `/dev/null`, unlike `engine_client.rs`'s completed-invocation fake). So
/// the sidecar is dead while the read is still in flight, and the two observations below fail under
/// one reverted shape each:
///
///   * **the sidecar STAYS a zombie while the read runs** — exited, un-reaped, so its pid and its
///     process-group id are still pinned. Reaping inside the `join!` collapses that to the few
///     milliseconds between `exit` and tokio's SIGCHLD wake, which is the whole pid-reuse hazard
///     made observable — and why the check counts samples rather than taking the first sighting
///     (see [`ProbedRead::stayed_zombie`]).
///   * **the backgrounded child is dead afterwards** — the guard was still armed when the timeout
///     dropped the future. Disarming at `wait()`'s return inside the `join!` hands this child back
///     its orphan, which is deviation 30 returning by the back door.
///
/// This is also the shape §6 means by "anything the sidecar started that is still in the group when
/// the drop happens": the sidecar is gone, its child is not, and the group is killed anyway.
#[test]
fn a_timed_out_read_kills_a_child_that_outlived_the_sidecar() {
    let scratch = ScratchDir::new("hung-outlive");
    let tag = scratch.tag();
    let _reap = ReapTagged(tag.clone());
    // `sleeper` makes the tagged `<scratch>/sleep` symlink; its own script is not used.
    let _ = sleeper(&scratch.path, "unused.sh", 1);
    let pid_file = scratch.join("sidecar.pid");
    let pgid_file = scratch.join("sidecar.pgid");
    let child_pid_file = scratch.join("child.pid");
    // ⚠ NO `>/dev/null` ON THE SLEEPER, which is the load-bearing difference: it inherits the
    // SIDECAR's stdout/stderr — the pipe write-ends tokio created — so the pipes do not reach EOF
    // when the shell exits and the read cannot finish on its own. That is what keeps the
    // invocation in flight after its sidecar is dead. (Had the sleeper inherited the TEST BINARY's
    // own stdio instead, the pipes would close with the shell and this test would measure nothing.)
    let program = fake_sidecar(
        &scratch.path,
        "outliving.sh",
        &format!(
            "echo $$ > \"{pid}\"\nps -o pgid= -p $$ > \"{pgid}\"\n\"{sleep}\" 41 &\n\
             echo $! > \"{child}\"\nexit 0",
            pid = pid_file.display(),
            pgid = pgid_file.display(),
            child = child_pid_file.display(),
            sleep = scratch.join("sleep").display(),
        ),
    );

    let observed = probed_timed_out_read(&program, (&pid_file, &pgid_file, &child_pid_file), |o| {
        o.forked_and_was_seen() && o.stayed_zombie()
    });
    assert!(
        observed.forked_and_was_seen(),
        "in 8 s the sidecar never forked a child this test could observe RUNNING: {observed:?}"
    );
    assert_eq!(
        observed.sidecar_pgid, observed.sidecar_pid,
        "the sidecar's process group is not its own pid: {observed:?}"
    );
    // ⚠ ORDER MATTERS HERE, so that each revert dies on its OWN observation rather than both dying
    // on whichever runs first. Disarming inside the `join!` still kills nothing, so it fails the
    // child check below; the three-way `join!` that disarms after it DOES still kill (the guard is
    // armed at the drop), so it passes that and fails the zombie check instead. Measured both ways.
    assert_gone("child that outlived the sidecar", &observed.child_pid);
    assert!(
        observed.stayed_zombie(),
        "the sidecar was not seen as a zombie for long enough while the read was in flight, so it \
         was reaped before the timeout rather than held un-reaped — the pid the guard signals was \
         reusable for that whole window: {observed:?}"
    );
    assert_no_tagged_survivors(&tag);
}

/// ⚠ R2-16: A PANIC STOPS LIVE UPDATES LOUDLY. The source panics on its second read (a served file
/// change); the loop must end AND say so in one last snapshot — the last good state, flagged
/// `updatesStopped`, with an error naming the panic — rather than going quiet while the tray keeps
/// showing a state nothing will update again.
#[test]
fn a_panicking_watcher_says_live_updates_stopped() {
    struct PanicsAfter {
        good: u64,
        calls: AtomicU64,
    }
    impl SnapshotSource for PanicsAfter {
        fn snapshot(&self) -> Snapshot {
            if self.calls.fetch_add(1, Ordering::SeqCst) >= self.good {
                panic!("injected source failure");
            }
            Snapshot::build(
                Some(serde_json::json!({ "configExists": true, "lastRunDate": "2026-09-16" })),
                None,
                &frozen_now(),
                None,
            )
        }
    }

    // After one good read.
    let scratch = ScratchDir::new("panics");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let sink = Arc::new(Counter::default());
    let mut w = start(
        WatchTargets::new(&state),
        Arc::new(PanicsAfter {
            good: 1,
            calls: AtomicU64::new(0),
        }),
        sink.clone(),
        app_timings(),
    );
    std::fs::write(state.join("last-run"), "2026-09-16\n").expect("a change");
    let stopped = sink.wait_for_payload(PATIENCE, |v| v["updatesStopped"] == true);
    let ended = w.wait_until(PATIENCE, StateWatcher::has_stopped);
    w.stop();
    let stopped = stopped.expect("a panicking watcher ended silently");
    assert!(ended, "the loop did not end");
    let error = stopped["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("Live updates have stopped") && error.contains("injected source failure"),
        "{error}"
    );
    assert_eq!(
        stopped["status"]["lastRunDate"], "2026-09-16",
        "the last good state should still be shown: {stopped}"
    );
    assert_eq!(stopped["scheduleState"]["phase"]["phase"], "delivered");

    // On the very first read: no state to keep, and still loud.
    let sink = Arc::new(Counter::default());
    let mut w = watcher::spawn_with(
        WatchTargets::new(&state),
        Arc::new(PanicsAfter {
            good: 0,
            calls: AtomicU64::new(0),
        }),
        sink.clone(),
        app_timings(),
    )
    .expect("the watcher starts");
    let stopped = sink.wait_for_payload(PATIENCE, |v| v["updatesStopped"] == true);
    w.stop();
    let stopped = stopped.expect("a watcher that panicked on its first read ended silently");
    assert!(stopped["scheduleState"].is_null() && stopped["status"].is_null());
    assert!(stopped["error"]
        .as_str()
        .unwrap_or_default()
        .contains("injected source failure"));
}

/* ── 6. the payload's shape ───────────────────────────────────────────────────────────────────── */

/// ⚠ THE DEV/INODE HALF OF THE IDENTITY, PINNED (V1's probe, adopted). A delete and an immediate
/// recreate at the same path keeps the canonical path and changes only the inode — faster than any
/// event can be relied on — and the watch must still be re-taken.
#[test]
fn a_fast_delete_and_recreate_is_rewatched() {
    use std::os::unix::fs::MetadataExt;
    let scratch = ScratchDir::new("inode");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let sink = Arc::new(Counter::default());
    let mut w = start(
        WatchTargets::new(&state),
        Arc::new(Fixed::new(Snapshot::unavailable("counted, not used"))),
        sink,
        file_only(Duration::from_millis(60), Duration::from_millis(200)),
    );
    assert_eq!(w.arms(), 1);
    let before = std::fs::metadata(&state).expect("stat").ino();
    // ⚠ THE OLD DIRECTORY IS HELD OPEN ACROSS THE DELETE, so its inode stays allocated and the
    // recreate CANNOT be handed the same number — which is what makes the premise below hold on
    // every filesystem rather than by luck. ext4 reuses a freed inode at once (Phase E M2's first
    // Linux `cargo test`: 100101 -> 100101, and this premise failed); APFS happens not to. Dropped
    // once `after` is measured — it is there for the premise, not for the watcher.
    let old = std::fs::File::open(&state).expect("hold the old directory open");
    std::fs::remove_dir(&state).expect("delete");
    std::fs::create_dir(&state).expect("recreate");
    let after = std::fs::metadata(&state).expect("stat").ino();
    drop(old);
    let rearmed = w.wait_until(PATIENCE, |w| w.arms() >= 2);
    let arms = w.arms();
    w.stop();
    assert_ne!(
        before, after,
        "the recreate kept the inode, so this run proves nothing about the inode half"
    );
    assert!(
        rearmed,
        "a fast recreate (inode {before} -> {after}) was not re-watched; arms={arms}"
    );
}

#[test]
fn a_snapshot_with_no_status_carries_the_engines_words_and_no_invented_state() {
    let snapshot = Snapshot::unavailable("/nowhere/daily-briefing: No such file or directory");
    let wire = serde_json::to_value(&snapshot).expect("serialises");
    assert!(wire["status"].is_null());
    assert!(wire["scheduleState"].is_null());
    assert!(wire["schedule"].is_null());
    assert_eq!(wire["scheduleStale"], false);
    assert_eq!(wire["updatesStopped"], false);
    assert_eq!(
        wire["error"],
        "/nowhere/daily-briefing: No such file or directory"
    );
    // And there is nothing to re-derive from.
    assert_eq!(snapshot.rederive(&frozen_now()), snapshot);
    assert_eq!(snapshot.next_boundary(&frozen_now()), None);
}

#[test]
fn the_state_dir_comes_from_the_status_envelope_and_nowhere_else() {
    let status: StatusView = serde_json::from_value(serde_json::json!({
        "configExists": true,
        "paths": { "stateDir": "/somewhere/else" }
    }))
    .expect("parses");
    let targets = WatchTargets::from_status(&status).expect("a state dir was reported");
    assert_eq!(targets.state_dir, PathBuf::from("/somewhere/else"));

    // No state dir reported → no watcher, rather than a recomputed guess.
    let blind: StatusView =
        serde_json::from_value(serde_json::json!({ "configExists": true })).expect("parses");
    assert!(WatchTargets::from_status(&blind).is_none());
    let empty: StatusView =
        serde_json::from_value(serde_json::json!({ "paths": { "stateDir": "" } })).expect("parses");
    assert!(WatchTargets::from_status(&empty).is_none());
}

#[test]
fn a_snapshot_built_from_both_envelopes_derives_the_state_once() {
    let now = frozen_now();
    let snapshot = Snapshot::build(
        Some(serde_json::json!({
            "configExists": true,
            "lastRunDate": "2026-09-16",
            "latestBriefingMtime": "2026-09-16T14:24:00.000Z",
            "morningTime": { "value": "07:20", "minutes": 440, "warning": null },
            "lastSkip": { "iso": "2026-09-16T16:00:00.000Z", "localDate": "2026-09-16",
                          "reason": "already-ran" },
            "paths": { "stateDir": "/tmp/state" }
        })),
        Some(serde_json::json!({
            "recordPresent": true, "unitPresent": true, "owner": "app", "intervalSec": 600,
            "lastTickState": "ok", "ticksToday": 11
        })),
        &now,
        None,
    );
    let state = snapshot
        .schedule_state
        .clone()
        .expect("a state was derived");
    assert!(matches!(state.phase, Phase::Delivered { .. }));
    assert_eq!(state.ticks_today, Some(11));
    // `lastSkip` is lifted out of the status envelope for the surfaces that want it — and it is
    // `already-ran`, which must NOT have produced a Skipped phase.
    assert_eq!(
        snapshot.last_skip.as_ref().map(|s| s.reason.as_str()),
        Some("already-ran")
    );
    assert!(!snapshot.schedule_stale);
    // Re-deriving at the same instant is the identity; at local midnight it is the next day.
    assert_eq!(snapshot.rederive(&now), snapshot);
    let next_day = Now {
        local_date: "2026-09-17".into(),
        minutes: 0,
        epoch_secs: now.epoch_secs + 15 * 3_600,
    };
    assert!(!matches!(
        snapshot.rederive(&next_day).schedule_state.map(|s| s.phase),
        Some(Phase::Delivered { .. })
    ));
    assert_eq!(
        snapshot.next_boundary(&now),
        parse_iso_utc("2026-09-17T07:00:00Z"),
        "a delivered day's next boundary is local midnight"
    );
}

/// ⚠ L8: `lastSkip` COMES FROM `status` ONLY. A schedule envelope — possibly a cached one from an
/// earlier read — that still carries a skip the engine has since cleared must not resurrect it.
#[test]
fn a_cleared_skip_is_not_resurrected_from_the_schedule_envelope() {
    let now = frozen_now();
    let skip = serde_json::json!({
        "iso": "2026-09-16T15:00:00.000Z", "localDate": "2026-09-16",
        "reason": "offline", "detail": "no network"
    });
    let status = serde_json::json!({
        "configExists": true, "lastSkip": null,
        "morningTime": { "value": "07:20", "minutes": 440, "warning": null }
    });
    let schedule = serde_json::json!({
        "recordPresent": true, "unitPresent": true, "registered": true, "intervalSec": 600,
        "lastTickState": "absent", "lastSkip": skip
    });
    for snapshot in [
        Snapshot::build(Some(status.clone()), Some(schedule.clone()), &now, None),
        Snapshot::with_stale_schedule(
            Some(status.clone()),
            schedule.clone(),
            &now,
            Some("x".into()),
        ),
    ] {
        assert_eq!(snapshot.last_skip, None, "{snapshot:?}");
        assert!(
            !matches!(
                snapshot.schedule_state.as_ref().map(|s| &s.phase),
                Some(Phase::Skipped { .. })
            ),
            "a cleared skip came back: {snapshot:?}"
        );
    }
}

/// ⚠ R2-1: A STALE SCHEDULE HALF KEEPS WHAT THE DERIVATION NEEDS AND WITHHOLDS WHAT WAS TRUE OF
/// ANOTHER MOMENT — including a cached "legacy", which must not pin UNKNOWN-TICK over a heartbeat
/// `status` (current) reads fine.
#[test]
fn a_stale_schedule_half_withholds_its_per_read_facts() {
    let now = local("2026-09-16", 9, 0, 0);
    let (status, schedule) = envelopes(None, "2026-09-16T15:55:00.000Z", "2026-09-16");
    let legacy = with(
        schedule,
        serde_json::json!({ "lastTickState": "legacy", "ticksExpectedSinceFloor": 11 }),
    );
    let fresh = Snapshot::build(Some(status.clone()), Some(legacy.clone()), &now, None);
    assert!(matches!(
        fresh.schedule_state.as_ref().map(|s| &s.phase),
        Some(Phase::UnknownTick { .. })
    ));
    let stale = Snapshot::with_stale_schedule(Some(status), legacy.clone(), &now, Some("x".into()));
    let st = stale.schedule_state.as_ref().expect("a state");
    assert_eq!(st.phase, Phase::WaitingForWake, "{st:?}");
    assert_eq!(
        (st.ticks_today, st.ticks_expected_since_floor),
        (None, None)
    );
    assert_eq!(
        st.owner.as_deref(),
        Some("app"),
        "the owner is still needed"
    );
    assert_eq!(st.interval_sec, Some(600), "the interval is still needed");
    assert_eq!(
        stale.schedule,
        Some(legacy),
        "the raw envelope is kept as it was"
    );
    // Re-deriving keeps it stale.
    let later = stale.rederive(&local("2026-09-16", 9, 1, 0));
    assert!(later.schedule_stale);
    assert_eq!(
        later.schedule_state.as_ref().and_then(|s| s.ticks_today),
        None
    );
}
