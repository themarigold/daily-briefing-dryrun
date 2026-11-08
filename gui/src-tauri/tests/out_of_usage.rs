//! P3-M5-T3 — the `OutOfUsage` notification end to end, FROM THE FILE (spec r9 §5, requirement 11:
//! "one notification per state per day … including across app restarts and when the app opens
//! after the state began").
//!
//! `tests/notifications.rs` drives the transition machine with hand-built `status --json`
//! payloads. This file starts one layer further out: each test writes the engine's
//! `<state>/last-skip.json` the way `writeLastSkip` (`src/marker.ts`) does, and every "tick" is
//!
//!   1. a REAL `status --json` from the compiled sidecar (`engine::bundled_sidecar_path`), read
//!      through the watcher's own source, `shell::EngineSnapshots` — so the record crosses the
//!      engine's `readLastSkip` and the app's `LastSkip` deserializer for real;
//!   2. re-derived at the test's clock exactly as the watcher loop does with every read
//!      (`source.snapshot().rederive(now)`, `watcher.rs`'s `read` closure);
//!   3. announced through `shell::AppState::changed`, the literal shipping sink, into a managed
//!      `NotifyState` whose sink RECORDS (nothing is ever posted), whose clock is the test's, and
//!      whose store — `notify-state.json` and `notified-dates.json` — is a scratch directory.
//!
//! An "app restart" is a NEW mock app with a NEW `NotifyState` over the SAME store directory —
//! everything in-memory is gone, and only what `notified-dates.json` persisted survives.
//!
//! ## What is real, and what is not
//!
//! ⚠ ONLY `status --json` REACHES THE REAL ENGINE (plan risk 8: "the Rust tests that reach the real
//! sidecar (P3-M5-T3) read `status --json` only"). The program the client runs is a two-line
//! wrapper: `status` `exec`s the real sidecar, `schedule status` prints a canned healthy-registration
//! envelope, and anything else is refused with exit 64. The canned half is necessary, not a
//! shortcut: in a sandbox no unit is registered, so the real `schedule status` would derive
//! `NotScheduled`, which shadows `Phase::Skipped` (`derive_phase` step 3 precedes step 5) and no
//! skip could ever surface — and making it say "registered" would mean touching launchd.
//!
//! ⚠ THE SANDBOX IS ASSERTED ON EVERY READ. `common::sandbox_env` points the engine's state, config
//! and unit directories into the scratch dir, `HOME` is overridden too (the residual
//! `sandbox_env`'s docs name), and every snapshot's `paths.stateDir` / `paths.configPath` must sit
//! under the scratch root or the test fails. `status` is a pure read (`statusReport`, `src/json.ts`:
//! "Creates nothing, repairs nothing, stamps nothing"); its config names a `claude` CLI provider that
//! nothing here ever runs.
//!
//! ⚠ DATES ARE PAST AND INJECTED (plan risk 10). The day is 2026-09-17; the clock that derives the
//! phase and the clock `NotifyState` reads for "today" are the same hand clock, so nothing here
//! flips on the calendar.

mod common;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use common::{fake_sidecar, sandbox_env, sq, RecordingNotifySink, ScratchDir};
use daily_briefing_gui_lib::engine::{bundled_sidecar_path, EngineClient};
use daily_briefing_gui_lib::notifications::{
    facts_of, read_notified_dates, write_record, NotifyClass, NotifyRecord, NotifyState,
};
use daily_briefing_gui_lib::schedule_state::{parse_iso_utc, Now, Phase, SkipReason};
use daily_briefing_gui_lib::shell::{AppState, EngineSnapshots, ShellState};
use daily_briefing_gui_lib::watcher::{Clock, Snapshot, SnapshotSource, StateSink};
use serde_json::json;
use tauri::test::{mock_builder, MockRuntime};
use tauri::App;

/* ── fixtures ─────────────────────────────────────────────────────────────────────────────────── */

const DAY: &str = "2026-09-17";
const NEXT_DAY: &str = "2026-09-18";

/// The engine's two-line detail for an all-out-of-usage skip (`src/main.ts`, P1-M9-T2): the
/// notification text first, `limitedSkipMessage` second (the `briefing.log` line).
const OUT_OF_USAGE_DETAIL: &str =
    "No briefing yet today — every provider is out of usage until 09:00. It will arrive once one \
     resets, if your Mac is awake.\nskipped: account \"work\" is at its usage limit until 09:00 — no \
     other account is available; will retry next interval";
/// …and the body the banner must carry: the detail's FIRST line, nothing else.
const OUT_OF_USAGE_BODY: &str =
    "No briefing yet today — every provider is out of usage until 09:00. It will arrive once one \
     resets, if your Mac is awake.";

/// A plain `limited` detail — an older engine's, or the "another account is next" case.
const PLAIN_LIMITED_DETAIL: &str =
    "skipped: account \"work\" is at its usage limit until 09:00 — the next tick will use another \
     account";

/// A local instant on a UTC-7 machine (the shape `tests/watcher.rs`'s `local` uses), past the
/// 07:20 floor whenever `hh >= 8`.
fn local(date: &str, hh: u32, mm: u32) -> Now {
    let midnight_utc = parse_iso_utc(&format!("{date}T00:00:00Z")).expect("a date") + 7 * 3_600;
    Now {
        local_date: date.into(),
        minutes: hh * 60 + mm,
        epoch_secs: midnight_utc + i64::from(hh) * 3_600 + i64::from(mm) * 60,
    }
}

/// The hand clock both halves read: the watcher's re-derive and `NotifyState`'s "today".
fn hand_clock(start: Now) -> (Clock, Arc<Mutex<Now>>) {
    let now = Arc::new(Mutex::new(start));
    let reader = Arc::clone(&now);
    (
        Arc::new(move || reader.lock().expect("the clock").clone()),
        now,
    )
}

/// The shipped context. ONE `generate_context!` per test binary (each expansion defines the macOS
/// `__EMBED_INFO_PLIST` symbol — gui-seam deviation 21).
fn shipped_context() -> tauri::Context<MockRuntime> {
    tauri::generate_context!()
}

/// One sandboxed engine, its state directory, and the app's scratch store.
struct World {
    scratch: ScratchDir,
    state: PathBuf,
    store: PathBuf,
    source: Arc<EngineSnapshots>,
}

impl World {
    fn new(tag: &str) -> Self {
        let scratch = ScratchDir::new(tag);
        let env = sandbox_env(&scratch.path);
        let state = scratch.join("state");
        let home = scratch.join("home");
        std::fs::create_dir_all(&home).expect("a scratch HOME");
        // A config that LOADS: without one `derive_phase` stops at `NotConfigured` (step 1) and no
        // skip can surface. The provider is never run — `status` only reads.
        let config_dir = scratch.join("config").join("daily-briefing");
        std::fs::create_dir_all(&config_dir).expect("the config dir");
        std::fs::write(
            config_dir.join("config.json"),
            json!({
                "repos": [scratch.join("repo").display().to_string()],
                "provider": { "cli": "claude", "argv": ["-p"], "promptVia": "stdin" },
            })
            .to_string(),
        )
        .expect("the config");

        let real = bundled_sidecar_path().expect("the bundled sidecar (build-sidecar.sh)");
        let schedule = json!({
            "registered": true,
            "recordPresent": true,
            "unitPresent": true,
            "owner": "app",
            "invoker": "app",
            "intervalSec": 600,
            "experimental": false,
        });
        let program = fake_sidecar(
            &scratch.path,
            "engine.sh",
            &format!(
                "case \"$1\" in\n  status) exec {} \"$@\" ;;\n  schedule) printf '%s' {} ;;\n  *) \
                 echo \"out_of_usage.rs: refused $*\" >&2; exit 64 ;;\nesac",
                sq(&real.display().to_string()),
                sq(&schedule.to_string()),
            ),
        );
        let mut client = EngineClient::with_program(program);
        for (key, value) in env {
            client = client.with_env(key, value);
        }
        client = client.with_env("HOME", home.display().to_string());

        let store = scratch.join("app-data");
        write_record(
            &store,
            &NotifyRecord {
                enabled: Some(true),
            },
        )
        .expect("the opt-in record");
        Self {
            scratch,
            state,
            store,
            source: Arc::new(EngineSnapshots::new(Ok(client))),
        }
    }

    /// What one engine tick leaves behind: `<state>/last-skip.json`, in `writeLastSkip`'s shape
    /// (`allOutOfUsage` present only when true — the engine never writes `false`). The `iso` is
    /// the local wall time spelled as UTC: only its shape matters, since nothing here reads it —
    /// `localDate` is the dedupe key and the phase's day.
    fn write_skip(&self, now: &Now, reason: &str, all_out_of_usage: bool, detail: Option<&str>) {
        let mut record = json!({
            "iso": format!("{}T{:02}:{:02}:00.000Z", now.local_date, now.minutes / 60, now.minutes % 60),
            "localDate": now.local_date,
            "reason": reason,
        });
        if let Some(detail) = detail {
            record["detail"] = json!(detail);
        }
        if all_out_of_usage {
            record["allOutOfUsage"] = json!(true);
        }
        std::fs::write(self.state.join("last-skip.json"), format!("{record}\n"))
            .expect("the skip record");
    }

    fn all_out_tick(&self, now: &Now) {
        self.write_skip(now, "limited", true, Some(OUT_OF_USAGE_DETAIL));
    }

    /// One watcher read: the real `status --json` (and the canned schedule half) through
    /// `EngineSnapshots`, re-derived at `now` as the loop does. The sandbox is asserted here.
    fn read(&self, now: &Now) -> Snapshot {
        let snapshot = self.source.snapshot().rederive(now);
        assert_eq!(snapshot.error, None, "the engine read failed: {snapshot:?}");
        let status = snapshot.status.as_ref().expect("a status envelope");
        let root = self.scratch.path.display().to_string();
        for key in ["stateDir", "configPath"] {
            let got = status["paths"][key].as_str().unwrap_or("(absent)");
            assert!(
                got.starts_with(&root),
                "paths.{key} resolved OUTSIDE the sandbox {root}: {got}"
            );
        }
        snapshot
    }

    /// An app (or a restarted one): a fresh `NotifyState` — recording sink, the test's clock, this
    /// world's store.
    fn open_app(&self, clock: &Clock) -> (App<MockRuntime>, Arc<RecordingNotifySink>) {
        let recorder = Arc::new(RecordingNotifySink::default());
        let notify = NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&self.store)
            .with_clock(Arc::clone(clock));
        let app = mock_builder()
            .manage(ShellState::default())
            .manage(notify)
            .build(shipped_context())
            .expect("mock app");
        (app, recorder)
    }

    /// A tick, end to end: read the engine, then announce through the shipping sink.
    fn tick(&self, app: &App<MockRuntime>, now: &Now) -> Snapshot {
        let snapshot = self.read(now);
        AppState::new(app.handle().clone()).changed(&snapshot);
        snapshot
    }

    fn persisted(&self, class: NotifyClass) -> Option<String> {
        read_notified_dates(&self.store).get(&class).cloned()
    }
}

/// The snapshot surfaced today's `limited` skip — so a silence asserted after it is the
/// notification rule's, not a phase that never reached the machine.
fn assert_limited_surfaced(snapshot: &Snapshot, all_out_of_usage: bool) {
    let state = snapshot.schedule_state.as_ref().expect("a derived state");
    assert!(
        matches!(
            &state.phase,
            Phase::Skipped {
                reason: SkipReason::Limited,
                ..
            }
        ),
        "the skip did not surface as today's limited phase: {:?}",
        state.phase
    );
    let skip = snapshot
        .last_skip
        .as_ref()
        .expect("the skip record crossed the engine");
    assert_eq!(
        skip.all_out_of_usage, all_out_of_usage,
        "allOutOfUsage did not survive the engine's readLastSkip and the app's deserializer"
    );
}

/// The one banner the day's all-out state may produce.
fn assert_out_of_usage_banner(recorder: &RecordingNotifySink) {
    let posted = recorder.posted();
    assert_eq!(posted.len(), 1, "exactly one banner: {posted:?}");
    assert_eq!(posted[0].class, NotifyClass::OutOfUsage);
    assert_eq!(posted[0].title, "No briefing yet today");
    assert_eq!(posted[0].body, OUT_OF_USAGE_BODY);
    assert_eq!(posted[0].route, "today");
}

/* ── the tests ────────────────────────────────────────────────────────────────────────────────── */

/// Fires once for `limited` with `allOutOfUsage: true`, and every later tick on the same date —
/// the engine rewriting the record every 10 minutes — stays silent.
#[test]
fn an_all_out_tick_fires_once_and_repeated_ticks_on_the_same_date_stay_silent() {
    let world = World::new("ooe-once");
    let (clock, hand) = hand_clock(local(DAY, 8, 0));
    let (app, recorder) = world.open_app(&clock);

    // The app opens before anything was skipped today: the primer carries no skip record.
    let primer = world.tick(&app, &local(DAY, 8, 0));
    assert!(primer.last_skip.is_none(), "{primer:?}");
    assert!(recorder.posted().is_empty());

    let first = local(DAY, 8, 10);
    *hand.lock().expect("the clock") = first.clone();
    world.all_out_tick(&first);
    let snapshot = world.tick(&app, &first);
    assert_limited_surfaced(&snapshot, true);
    assert_out_of_usage_banner(&recorder);
    assert_eq!(
        world.persisted(NotifyClass::OutOfUsage).as_deref(),
        Some(DAY)
    );

    for minute in [20, 30, 40] {
        let now = local(DAY, 8, minute);
        *hand.lock().expect("the clock") = now.clone();
        world.all_out_tick(&now);
        let snapshot = world.tick(&app, &now);
        assert_limited_surfaced(&snapshot, true);
    }
    assert_out_of_usage_banner(&recorder);
}

/// A plain `limited` (no `allOutOfUsage`) is silent — on every tick, AND when the app opens with
/// one already recorded today, where an all-out record would escape absorption and fire.
#[test]
fn a_plain_limited_skip_stays_silent_at_start_and_on_every_tick() {
    let world = World::new("ooe-plain");
    let now = local(DAY, 8, 10);
    let (clock, hand) = hand_clock(now.clone());

    // Opened after today's first plain-limited tick.
    world.write_skip(&now, "limited", false, Some(PLAIN_LIMITED_DETAIL));
    let (app, recorder) = world.open_app(&clock);
    let snapshot = world.tick(&app, &now);
    assert_limited_surfaced(&snapshot, false);
    for minute in [20, 30] {
        let now = local(DAY, 8, minute);
        *hand.lock().expect("the clock") = now.clone();
        world.write_skip(&now, "limited", false, Some(PLAIN_LIMITED_DETAIL));
        let snapshot = world.tick(&app, &now);
        assert_limited_surfaced(&snapshot, false);
    }
    assert!(recorder.posted().is_empty(), "{:?}", recorder.posted());
    assert_eq!(world.persisted(NotifyClass::OutOfUsage), None);
}

/// The double-fire absorption alone allowed: the day's banner fires, a QUIET skip (`offline`)
/// overwrites the record, the app restarts — so its primer sees only the quiet record and absorbs
/// nothing — and the next all-out tick must still be silent, because `notified-dates.json` says
/// today's banner already fired.
#[test]
fn an_interleaved_quiet_skip_then_a_restart_then_another_all_out_tick_stays_silent() {
    let world = World::new("ooe-restart");
    let (clock, hand) = hand_clock(local(DAY, 8, 0));

    let (app, first_run) = world.open_app(&clock);
    world.tick(&app, &local(DAY, 8, 0));
    let now = local(DAY, 8, 10);
    *hand.lock().expect("the clock") = now.clone();
    world.all_out_tick(&now);
    world.tick(&app, &now);
    assert_out_of_usage_banner(&first_run);

    let now = local(DAY, 8, 20);
    *hand.lock().expect("the clock") = now.clone();
    world.write_skip(&now, "offline", false, Some("skipped: offline"));
    let quiet = world.tick(&app, &now);
    assert_eq!(
        quiet.last_skip.as_ref().map(|s| s.reason.as_str()),
        Some("offline")
    );
    assert_out_of_usage_banner(&first_run);
    drop(app);

    // The restart: every in-memory date is gone; the primer is the quiet record.
    let (app, second_run) = world.open_app(&clock);
    let now = local(DAY, 8, 25);
    *hand.lock().expect("the clock") = now.clone();
    let primer = world.tick(&app, &now);
    assert_eq!(
        facts_of(&primer).raw_skip_key,
        None,
        "the restarted app's primer must carry nothing to absorb, or this test proves nothing"
    );

    let now = local(DAY, 8, 30);
    *hand.lock().expect("the clock") = now.clone();
    world.all_out_tick(&now);
    let snapshot = world.tick(&app, &now);
    assert_limited_surfaced(&snapshot, true);
    assert!(
        second_run.posted().is_empty(),
        "today's banner fired a second time after a restart: {:?}",
        second_run.posted()
    );
    assert_eq!(
        world.persisted(NotifyClass::OutOfUsage).as_deref(),
        Some(DAY)
    );
}

/// The app starts AFTER the day's first all-out tick: its very first snapshot fires (today's
/// `OutOfUsage` escapes start-up absorption), later ticks and a restart do not, and an EARLIER
/// day's all-out record at start is absorbed.
#[test]
fn an_app_started_after_the_days_first_all_out_tick_fires_once() {
    let world = World::new("ooe-late");
    let now = local(DAY, 9, 0);
    let (clock, hand) = hand_clock(now.clone());
    world.all_out_tick(&local(DAY, 8, 10));

    let (app, recorder) = world.open_app(&clock);
    let primer = world.tick(&app, &now);
    assert_limited_surfaced(&primer, true);
    assert_out_of_usage_banner(&recorder);

    let now = local(DAY, 9, 10);
    *hand.lock().expect("the clock") = now.clone();
    world.all_out_tick(&now);
    world.tick(&app, &now);
    assert_out_of_usage_banner(&recorder);
    drop(app);

    let (app, restarted) = world.open_app(&clock);
    world.tick(&app, &local(DAY, 9, 20));
    assert!(
        restarted.posted().is_empty(),
        "a restart re-fired today's banner: {:?}",
        restarted.posted()
    );
    drop(app);

    // An earlier day's record at start is silent: a fresh store, the clock on the next day, and
    // yesterday's all-out record still on disk. This leg cannot tell absorption from the phase
    // rule (only TODAY's record surfaces as `Phase::Skipped`); start-up absorption of an earlier
    // date is pinned in tests/notifications.rs.
    let other = World::new("ooe-late-earlier");
    other.all_out_tick(&local(DAY, 8, 10));
    let tomorrow = local(NEXT_DAY, 9, 0);
    *hand.lock().expect("the clock") = tomorrow.clone();
    let (app, recorder) = other.open_app(&clock);
    let primer = other.tick(&app, &tomorrow);
    assert_eq!(
        facts_of(&primer).raw_skip_key,
        Some((NotifyClass::OutOfUsage, DAY.to_string())),
        "the earlier record must reach the machine"
    );
    other.tick(&app, &local(NEXT_DAY, 9, 10));
    assert!(recorder.posted().is_empty(), "{:?}", recorder.posted());
}

/// The dedupe is per DATE: the next day's all-out state fires again — in the same app across
/// midnight, and in an app restarted on the next day after that day's first tick.
#[test]
fn the_next_day_fires_again() {
    let world = World::new("ooe-nextday");
    let (clock, hand) = hand_clock(local(DAY, 8, 0));
    let (app, recorder) = world.open_app(&clock);
    world.tick(&app, &local(DAY, 8, 0));
    let now = local(DAY, 8, 10);
    *hand.lock().expect("the clock") = now.clone();
    world.all_out_tick(&now);
    world.tick(&app, &now);
    assert_out_of_usage_banner(&recorder);

    // Past midnight, before the engine's first tick of the new day: yesterday's record is still
    // on disk and must not fire.
    let now = local(NEXT_DAY, 0, 5);
    *hand.lock().expect("the clock") = now.clone();
    world.tick(&app, &now);
    assert_eq!(recorder.posted().len(), 1, "{:?}", recorder.posted());

    let now = local(NEXT_DAY, 8, 10);
    *hand.lock().expect("the clock") = now.clone();
    world.all_out_tick(&now);
    let snapshot = world.tick(&app, &now);
    assert_limited_surfaced(&snapshot, true);
    let posted = recorder.posted();
    assert_eq!(
        posted.len(),
        2,
        "the next day's banner did not fire: {posted:?}"
    );
    assert_eq!(posted[1].class, NotifyClass::OutOfUsage);
    assert_eq!(posted[1].body, OUT_OF_USAGE_BODY);
    assert_eq!(
        world.persisted(NotifyClass::OutOfUsage).as_deref(),
        Some(NEXT_DAY)
    );
    drop(app);

    // A restart on the day after THAT, opened after its first all-out tick: the persisted date is
    // the previous day's, so the new day fires at start.
    let third = "2026-09-19";
    let now = local(third, 9, 0);
    *hand.lock().expect("the clock") = now.clone();
    world.all_out_tick(&local(third, 8, 10));
    let (app, restarted) = world.open_app(&clock);
    world.tick(&app, &now);
    assert_out_of_usage_banner(&restarted);
    assert_eq!(
        world.persisted(NotifyClass::OutOfUsage).as_deref(),
        Some(third)
    );
}
