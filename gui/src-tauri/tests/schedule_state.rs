//! T14 — the schedule state machine, as a table.
//!
//! ## What is asserted, and what would make it vacuous
//!
//! The machine's whole contract is "every input yields EXACTLY ONE state, and it is the honest
//! one". A table test that only checked the rows it happened to think of would pass while the
//! machine returned nonsense for everything else, so there are three layers here:
//!
//!   1. **The table** — one row per phase plus the specific shapes the appendix and plan R1 name
//!      by hand: the day-35 tick line, `today=11` past the floor, `today=1`, a `limited` skip from
//!      a PROBE (no reset time), a legacy heartbeat line, and `already-ran` (which must NOT read
//!      as a problem, because it is the steady state of a healthy day for ~17 hours).
//!   2. **A cross product** — every combination of a small set of values for each operand, with
//!      the assertion that the machine terminates, returns a phase, and never panics. "Exactly
//!      one" is structural (the return type is one `Phase`), so what this adds is *totality*.
//!   3. **Anti-drift pins against the ENGINE's own source** — the skip vocabulary and the
//!      heartbeat format are read out of `../../src/*.ts` at test time. A Rust port of a closed
//!      vocabulary that nothing compares to the original is a copy waiting to rot.
//!
//! ⚠ NO CLOCK IS READ ANYWHERE BELOW. `Now` is constructed by hand, which is the property that
//! makes "the day-35 shape" testable at all: it needs a local date that disagrees with the ISO
//! instant's UTC date, and no injectable clock can produce that on demand.

use daily_briefing_gui_lib::schedule_state::{
    crosses_read_boundary, derive, first_wake_sentence, next_boundary, now_from_civil,
    parse_iso_utc, utc_civil, CivilTime, LastSkip, MorningTime, Now, Phase, ScheduleView,
    SkipReason, StatePaths, StatusView, TickLine, TickProblem, FUTURE_TICK_SKEW_SECS,
    MAX_INTERVAL_SECS, SKIP_REASONS,
};

/* ── fixtures ─────────────────────────────────────────────────────────────────────────────────── */

const TODAY: &str = "2026-09-16";
const YESTERDAY: &str = "2026-09-15";

/// 09:10 local on `TODAY`, with a UTC instant that is the same calendar day.
fn at_0910() -> Now {
    Now {
        local_date: TODAY.into(),
        minutes: 9 * 60 + 10,
        // 2026-09-16T16:10:00Z — 09:10 on a UTC-7 machine.
        epoch_secs: parse_iso_utc("2026-09-16T16:10:00.000Z").expect("fixture parses"),
    }
}

/// 00:30 local on `TODAY` — the day-35 shape's observation point: past local midnight, so the
/// tick written at 17:00 LOCAL YESTERDAY carries today's UTC date.
fn at_0030() -> Now {
    Now {
        local_date: TODAY.into(),
        minutes: 30,
        epoch_secs: parse_iso_utc("2026-09-16T07:30:00.000Z").expect("fixture parses"),
    }
}

/// 00:05 local on `TODAY` — seven minutes after a tick written at 23:58 local YESTERDAY, which
/// is 06:58Z TODAY on a UTC-7 machine.
fn at_0005() -> Now {
    Now {
        local_date: TODAY.into(),
        minutes: 5,
        epoch_secs: parse_iso_utc("2026-09-16T07:05:00.000Z").expect("fixture parses"),
    }
}

/// 06:00 local — before the 07:20 floor.
fn at_0600() -> Now {
    Now {
        local_date: TODAY.into(),
        minutes: 6 * 60,
        epoch_secs: parse_iso_utc("2026-09-16T13:00:00.000Z").expect("fixture parses"),
    }
}

fn status() -> StatusView {
    StatusView {
        engine_version: Some("0.1.1".into()),
        config_exists: true,
        config_error: None,
        last_run_date: None,
        last_skip: None,
        last_tick: None,
        latest_briefing_mtime: None,
        morning_time: MorningTime {
            value: "07:20".into(),
            minutes: 440,
            warning: None,
        },
        paths: StatePaths {
            state_dir: Some("/tmp/state".into()),
            ..Default::default()
        },
    }
}

fn schedule() -> ScheduleView {
    ScheduleView {
        engine_version: Some("0.1.1".into()),
        registered: Some(true),
        record_present: true,
        unit_present: true,
        owner: Some("app".into()),
        invoker: Some("app".into()),
        unit_path: Some("/Users/x/Library/LaunchAgents/local.daily-briefing.plist".into()),
        installed_at: Some("2026-09-01T00:00:00.000Z".into()),
        installed_engine_version: Some("0.1.1".into()),
        last_tick_state: Some("ok".into()),
        ticks_today: Some(11),
        ticks_expected_since_floor: Some(11),
        interval_sec: Some(600),
        experimental: false,
        linger_state: Some("not-applicable".into()),
        last_skip: None,
        record_file_present: true,
        registered_reason: None,
        remove_steps: Some(REMOVE_STEPS.into()),
    }
}

/// A stand-in for the engine's `removeSteps` (spec 3.1.8): its real framing line, which is all a
/// fixture needs to be recognisably that text. `derive` carries it verbatim and never reads it.
const REMOVE_STEPS: &str = "Run these in a terminal (bash or zsh) inside your desktop session.";

fn tick(iso: &str, local_date: &str, count: u64) -> TickLine {
    TickLine {
        iso: iso.into(),
        local_date: local_date.into(),
        count,
    }
}

fn skip(reason: &str, local_date: &str, detail: Option<&str>) -> LastSkip {
    LastSkip {
        iso: format!("{local_date}T16:00:00.000Z"),
        local_date: local_date.into(),
        reason: reason.into(),
        detail: detail.map(str::to_string),
    }
}

/// The discriminant only — what "exactly one state" is asserted over.
fn name(phase: &Phase) -> String {
    match phase {
        Phase::NotConfigured => "not-configured".into(),
        Phase::ConfigError { .. } => "config-error".into(),
        Phase::NotScheduled => "not-scheduled".into(),
        Phase::SchedulerBroken => "scheduler-broken".into(),
        Phase::Delivered { .. } => "delivered".into(),
        Phase::WaitingForFloor { .. } => "waiting-for-floor".into(),
        Phase::WaitingForWake => "waiting-for-wake".into(),
        Phase::Skipped { reason, .. } => format!("skipped:{}", reason.as_str()),
        Phase::AgentStale { .. } => "agent-stale".into(),
        Phase::UnknownTick { cause } => format!(
            "unknown-tick:{}",
            serde_json::to_value(cause)
                .expect("a cause serialises")
                .as_str()
                .expect("as a string")
        ),
    }
}

/// `at_0910()` moved by `delta` seconds, same local day.
fn secs_before_0910(delta: i64) -> String {
    let t = parse_iso_utc("2026-09-16T16:10:00.000Z").expect("fixture parses") - delta;
    let c = utc_civil(t);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        c.year,
        c.month,
        c.day,
        c.hour,
        c.minute,
        t.rem_euclid(60)
    )
}

/* ── 1. the table ─────────────────────────────────────────────────────────────────────────────── */

struct Row {
    what: &'static str,
    status: StatusView,
    skip: Option<LastSkip>,
    schedule: Option<ScheduleView>,
    now: Now,
    expect: &'static str,
}

fn rows() -> Vec<Row> {
    let recent_tick = tick("2026-09-16T16:05:00.000Z", TODAY, 11);
    vec![
        Row {
            what: "no config file at all",
            status: StatusView {
                config_exists: false,
                ..status()
            },
            skip: Some(skip("no-config", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "not-configured",
        },
        Row {
            what: "the config exists and does not load",
            status: StatusView {
                config_error: Some("Unexpected token } in JSON at position 42".into()),
                ..status()
            },
            skip: Some(skip("config-error", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "config-error",
        },
        Row {
            what: "a config error on a day that was ALREADY delivered — the error still wins",
            status: StatusView {
                config_error: Some("Unexpected token } in JSON at position 42".into()),
                last_run_date: Some(TODAY.into()),
                latest_briefing_mtime: Some("2026-09-16T14:24:00.000Z".into()),
                ..status()
            },
            skip: Some(skip("already-ran", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "config-error",
        },
        Row {
            what: "a config-error skip record while the config now loads is noise",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("config-error", TODAY, Some("old"))),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "J: a record, but the OS does not have the unit loaded",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                registered: Some(false),
                ..schedule()
            }),
            now: at_0910(),
            expect: "scheduler-broken",
        },
        Row {
            what: "J2: a record, and the unit file is gone",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                unit_present: false,
                ..schedule()
            }),
            now: at_0910(),
            expect: "scheduler-broken",
        },
        Row {
            what: "J3: a broken unit outranks a delivery, like a missing record does",
            status: StatusView {
                last_run_date: Some(TODAY.into()),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                registered: Some(false),
                ..schedule()
            }),
            now: at_0910(),
            expect: "scheduler-broken",
        },
        Row {
            what: "J4: registration UNKNOWN (the probe could not run) is not broken",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                registered: None,
                ..schedule()
            }),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "stale threshold: a tick EXACTLY 2 x 600 s old is not stale",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(1_200), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "stale threshold: 2 x 600 s + 1 s is stale",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(1_201), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "agent-stale",
        },
        Row {
            what: "the interval comes from the ENVELOPE: 300 s, tick 601 s old, is stale",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(601), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                interval_sec: Some(300),
                ..schedule()
            }),
            now: at_0910(),
            expect: "agent-stale",
        },
        Row {
            what: "the interval comes from the ENVELOPE: 300 s, tick 599 s old, is not",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(599), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                interval_sec: Some(300),
                ..schedule()
            }),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "an interval of 0 is unknown, not a hair trigger",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(3_600), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                interval_sec: Some(0),
                ..schedule()
            }),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "an absurd interval is unknown, and does not wrap into a negative threshold",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(3_600), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                interval_sec: Some(u64::MAX),
                ..schedule()
            }),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "D21: a legacy line outranks a stale-looking instant",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(7_200), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                last_tick_state: Some("legacy".into()),
                ticks_today: None,
                ..schedule()
            }),
            now: at_0910(),
            expect: "unknown-tick:legacy",
        },
        Row {
            what: "a tick an hour in the FUTURE is a clock problem, not a current heartbeat",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(-3_600), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "unknown-tick:future",
        },
        Row {
            what: "a tick a minute ahead is within the skew allowance",
            status: StatusView {
                last_tick: Some(tick(&secs_before_0910(-60), TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "a tick whose instant does not parse cannot be judged",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T16:05:00+00:00", TODAY, 8)),
                ..status()
            },
            skip: None,
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "unknown-tick:unreadable-instant",
        },
        Row {
            what: "no ownership record: nothing will trigger a run",
            status: status(),
            skip: None,
            schedule: Some(ScheduleView {
                record_present: false,
                ..schedule()
            }),
            now: at_0910(),
            expect: "not-scheduled",
        },
        Row {
            what: "delivered today",
            status: StatusView {
                last_run_date: Some(TODAY.into()),
                latest_briefing_mtime: Some("2026-09-16T14:24:00.000Z".into()),
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            // ⚠ THE HEALTHY-DAY SHAPE: ten minutes after a delivery the next tick rewrites
            // last-skip.json with `already-ran`, and it stays there until midnight. A machine that
            // read this as a problem would show one every single working day.
            skip: Some(skip("already-ran", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "delivered",
        },
        Row {
            what: "delivered, and nothing owns the schedule — the LOUD state wins",
            status: StatusView {
                last_run_date: Some(TODAY.into()),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                record_present: false,
                ..schedule()
            }),
            now: at_0910(),
            expect: "not-scheduled",
        },
        Row {
            what: "today=11 at 09:10, past the floor, undelivered — the ordinary morning",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: None,
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "today=1 at 09:10 — the same phase, and the COUNT is what tells the story",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T16:05:00.000Z", TODAY, 1)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                ticks_today: Some(1),
                ..schedule()
            }),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "before the floor",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T12:55:00.000Z", TODAY, 2)),
                ..status()
            },
            skip: Some(skip("below-floor", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0600(),
            expect: "waiting-for-floor",
        },
        Row {
            what: "local= YESTERDAY, ISO today's UTC, and 7.5 hours old: stale because it is OLD",
            status: StatusView {
                // 17:00 local yesterday on a UTC-7 machine == 00:00Z today.
                last_tick: Some(tick("2026-09-16T00:00:00.000Z", YESTERDAY, 9)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                // The engine reports 0 for a parsed line from another day — NOT null, which would
                // mean "unparseable".
                ticks_today: Some(0),
                ..schedule()
            }),
            now: at_0030(),
            expect: "agent-stale",
        },
        Row {
            what: "the day-35 disagreement: local= YESTERDAY, ISO TODAY, 7 minutes old — current",
            status: StatusView {
                // 23:58 local yesterday on a UTC-7 machine == 06:58Z today.
                last_tick: Some(tick("2026-09-16T06:58:00.000Z", YESTERDAY, 144)),
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                ticks_today: Some(0),
                ..schedule()
            }),
            now: at_0005(),
            expect: "waiting-for-floor",
        },
        Row {
            what: "a legacy heartbeat line: unknown, never zero",
            status: StatusView {
                last_tick: None,
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                last_tick_state: Some("legacy".into()),
                ticks_today: None,
                ..schedule()
            }),
            now: at_0910(),
            expect: "unknown-tick:legacy",
        },
        Row {
            what: "no heartbeat at all, past the floor",
            status: StatusView {
                last_tick: None,
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                last_tick_state: Some("absent".into()),
                ticks_today: None,
                ..schedule()
            }),
            now: at_0910(),
            expect: "agent-stale",
        },
        Row {
            what: "no heartbeat at all, BEFORE the floor — a fresh install, not a fault",
            status: StatusView {
                last_tick: None,
                ..status()
            },
            skip: None,
            schedule: Some(ScheduleView {
                last_tick_state: Some("absent".into()),
                ticks_today: None,
                ..schedule()
            }),
            now: at_0600(),
            expect: "waiting-for-floor",
        },
        Row {
            what: "offline",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip(
                "offline",
                TODAY,
                Some("skipped: no network after ~45s — will retry next interval"),
            )),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:offline",
        },
        Row {
            what: "darkwake",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("darkwake", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:darkwake",
        },
        Row {
            what: "limited, PARSED reset — the engine's line names a time and we carry it",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip(
                "limited",
                TODAY,
                Some(
                    "skipped: account \"work\" is at its usage limit until 2026-09-16T18:00:00Z — \
                     the next tick will use another account",
                ),
            )),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:limited",
        },
        Row {
            what: "limited, PROBE mark — no reset time may be named",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip(
                "limited",
                TODAY,
                Some(
                    "skipped: account \"work\" is unavailable — no other account is available; \
                     will retry next interval",
                ),
            )),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:limited",
        },
        Row {
            what: "blocked",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("blocked", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:blocked",
        },
        Row {
            what: "concurrent",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("concurrent", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:concurrent",
        },
        Row {
            what: "provider-fail",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("provider-fail", TODAY, Some("provider exited 1"))),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:provider-fail",
        },
        Row {
            what: "parse-empty",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("parse-empty", TODAY, None)),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:parse-empty",
        },
        Row {
            what: "marker-fail",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("marker-fail", TODAY, Some("EACCES"))),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:marker-fail",
        },
        Row {
            what: "crashed",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("crashed", TODAY, Some("TypeError: …"))),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:crashed",
        },
        Row {
            what: "a reason this build has never heard of",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("solar-flare", TODAY, Some("who knows"))),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "skipped:solar-flare",
        },
        Row {
            what: "YESTERDAY's skip record is yesterday's story and must not be shown today",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: Some(skip("offline", YESTERDAY, Some("no network"))),
            schedule: Some(schedule()),
            now: at_0910(),
            expect: "waiting-for-wake",
        },
        Row {
            what: "no schedule envelope at all: no NOT-SCHEDULED banner may be invented",
            status: StatusView {
                last_tick: Some(recent_tick.clone()),
                ..status()
            },
            skip: None,
            schedule: None,
            now: at_0910(),
            expect: "waiting-for-wake",
        },
    ]
}

#[test]
fn every_row_yields_exactly_one_state() {
    for row in rows() {
        let state = derive(
            &row.status,
            row.skip.as_ref(),
            row.schedule.as_ref(),
            &row.now,
        );
        assert_eq!(
            name(&state.phase),
            row.expect,
            "row {:?} produced the wrong phase: {:?}",
            row.what,
            state.phase
        );
    }
}

/// prove-it 3b: if `name` collapsed several phases onto one string, every row above could pass
/// while the machine returned the same phase for all of them. This pins that the table actually
/// exercises distinct outcomes.
#[test]
fn the_table_covers_every_phase_constructor() {
    let mut seen: Vec<String> = rows()
        .into_iter()
        .map(|row| {
            let state = derive(
                &row.status,
                row.skip.as_ref(),
                row.schedule.as_ref(),
                &row.now,
            );
            name(&state.phase).split(':').next().unwrap().to_string()
        })
        .collect();
    seen.sort();
    seen.dedup();
    for expected in [
        "not-configured",
        "config-error",
        "not-scheduled",
        "scheduler-broken",
        "delivered",
        "waiting-for-floor",
        "waiting-for-wake",
        "skipped",
        "agent-stale",
        "unknown-tick",
    ] {
        assert!(
            seen.contains(&expected.to_string()),
            "no row in the table reaches {expected:?}; the table is not covering the machine"
        );
    }
}

/// A heartbeat from YESTERDAY's local day that is also hours OLD reads as stale — and its count is
/// still reported as the fact it is (0 today), never as the unparseable null.
#[test]
fn an_hours_old_tick_from_yesterday_reads_as_stale_with_zero_ticks_today() {
    let status = StatusView {
        last_tick: Some(tick("2026-09-16T00:00:00.000Z", YESTERDAY, 9)),
        ..status()
    };
    let schedule = ScheduleView {
        ticks_today: Some(0),
        ..schedule()
    };
    let state = derive(&status, None, Some(&schedule), &at_0030());
    assert!(
        matches!(state.phase, Phase::AgentStale { .. }),
        "the day-35 shape must read as stale/new-day, got {:?}",
        state.phase
    );
    // The tick the engine parsed is still carried, with ITS OWN local date — the whole point of
    // the two-field format is that the local day and the instant are separately legible.
    let carried = state.lastick_local_date();
    assert_eq!(carried.as_deref(), Some(YESTERDAY));
    assert_eq!(
        state.ticks_today,
        Some(0),
        "a parsed line from another day is 0 ticks TODAY — and 0 here is a fact, not the \
         unparseable case (which is null)"
    );
}

/// ⚠ THE ACTUAL DAY-35 SHAPE: the tick's `local=` is YESTERDAY while its ISO instant is TODAY'S UTC
/// date, and it is only seven minutes old. The 2026-08-20 bug compared the wrong one of those two
/// dates; here the machine must read the heartbeat as CURRENT (not stale, not "never fired"), carry
/// the engine's `ticksToday: 0` as a fact, and keep the tick's own local date legible.
#[test]
fn the_day_35_date_disagreement_is_current_not_stale_and_not_never_fired() {
    let tick_line = tick("2026-09-16T06:58:00.000Z", YESTERDAY, 144);
    assert_ne!(
        &tick_line.iso[..10],
        tick_line.local_date,
        "the fixture must actually disagree on the date, or this test is not the day-35 shape"
    );
    let status = StatusView {
        last_tick: Some(tick_line),
        ..status()
    };
    let schedule = ScheduleView {
        ticks_today: Some(0),
        ..schedule()
    };
    let state = derive(&status, None, Some(&schedule), &at_0005());
    match &state.phase {
        Phase::WaitingForFloor {
            minutes_until_floor,
            ..
        } => assert_eq!(*minutes_until_floor, 440 - 5),
        other => panic!("a 7-minute-old tick must not read as {other:?}"),
    }
    assert_eq!(state.ticks_today, Some(0));
    assert_eq!(state.lastick_local_date().as_deref(), Some(YESTERDAY));
}

/// `today=11` at 09:10 is the day-34 diagnostic: the ticks WERE firing, so the gate is the story.
#[test]
fn eleven_ticks_past_the_floor_is_waiting_for_wake_with_eleven_ticks() {
    let status = StatusView {
        last_tick: Some(tick("2026-09-16T16:05:00.000Z", TODAY, 11)),
        ..status()
    };
    let state = derive(&status, None, Some(&schedule()), &at_0910());
    assert!(matches!(state.phase, Phase::WaitingForWake));
    assert_eq!(state.ticks_today, Some(11));
    assert_eq!(state.ticks_expected_since_floor, Some(11));
}

/// `ticksToday: null` must survive as null all the way to the wire. `0` is the value that reads as
/// "launchd never fired" (`docs/gui-seam.md` §2).
#[test]
fn an_unparseable_heartbeat_is_null_ticks_never_zero() {
    let schedule = ScheduleView {
        last_tick_state: Some("legacy".into()),
        ticks_today: None,
        ..schedule()
    };
    let state = derive(&status(), None, Some(&schedule), &at_0910());
    assert!(matches!(
        state.phase,
        Phase::UnknownTick {
            cause: TickProblem::Legacy
        }
    ));
    assert_eq!(state.ticks_today, None);
    let wire = serde_json::to_value(&state).expect("serialises");
    assert!(
        wire["ticksToday"].is_null(),
        "ticksToday reached the webview as {} rather than null",
        wire["ticksToday"]
    );
}

/// ⚠ THE FALSEHOOD `limitedSkipMessage` WAS REWRITTEN TO AVOID. The app must never name a reset
/// time; it renders the engine's line, which names one only for a PARSED limit.
#[test]
fn a_probe_limit_carries_no_reset_time() {
    let probe_line = "skipped: account \"work\" is unavailable — no other account is available; \
                      will retry next interval";
    let status = StatusView {
        last_tick: Some(tick("2026-09-16T16:05:00.000Z", TODAY, 11)),
        ..status()
    };
    let state = derive(
        &status,
        Some(&skip("limited", TODAY, Some(probe_line))),
        Some(&schedule()),
        &at_0910(),
    );
    match &state.phase {
        Phase::Skipped { reason, detail, .. } => {
            assert_eq!(reason, &SkipReason::Limited);
            assert_eq!(detail.as_deref(), Some(probe_line));
            assert!(
                !detail.as_deref().unwrap_or_default().contains("until"),
                "a probe-marked limit must not name a reset time"
            );
        }
        other => panic!("expected a limited skip, got {other:?}"),
    }
    // And the WHOLE serialised state carries no reset time either — there is no second field one
    // could have leaked into.
    let wire = serde_json::to_string(&state).expect("serialises");
    assert!(
        !wire.contains("until"),
        "something in the serialised state names a reset time: {wire}"
    );
}

/* ── 2. totality ──────────────────────────────────────────────────────────────────────────────── */

/// Every combination of a small set of values for each operand terminates, returns exactly one
/// phase, and never panics — including garbage in every string field.
#[test]
fn the_machine_is_total_over_a_cross_product() {
    let run_dates = [None, Some(TODAY.to_string()), Some(YESTERDAY.to_string())];
    let ticks = [
        None,
        Some(tick("2026-09-16T16:05:00.000Z", TODAY, 11)),
        Some(tick("2026-09-16T00:00:00.000Z", YESTERDAY, 1)),
        // Deliberately unparseable instants.
        Some(tick("not-a-date", TODAY, 3)),
        Some(tick("", "", 0)),
    ];
    let tick_states = [None, Some("ok"), Some("legacy"), Some("absent"), Some("🙂")];
    let skips: [Option<LastSkip>; 6] = [
        None,
        Some(skip("already-ran", TODAY, None)),
        Some(skip("offline", TODAY, Some("line"))),
        Some(skip("offline", YESTERDAY, None)),
        Some(skip("", "", None)),
        Some(skip("\u{202e}evil", TODAY, Some("\u{0}"))),
    ];
    let nows = [at_0030(), at_0600(), at_0910()];
    let intervals = [None, Some(0u64), Some(600), Some(u64::MAX)];

    let mut count = 0usize;
    for run_date in &run_dates {
        for t in &ticks {
            for ts in &tick_states {
                for sk in &skips {
                    for now in &nows {
                        for interval in &intervals {
                            for record_present in [true, false] {
                                for config_exists in [true, false] {
                                    let status = StatusView {
                                        config_exists,
                                        last_run_date: run_date.clone(),
                                        last_tick: t.clone(),
                                        ..status()
                                    };
                                    let schedule = ScheduleView {
                                        record_present,
                                        last_tick_state: ts.map(str::to_string),
                                        interval_sec: *interval,
                                        ..schedule()
                                    };
                                    let state = derive(&status, sk.as_ref(), Some(&schedule), now);
                                    // One phase, and it serialises — the webview gets something.
                                    assert!(!name(&state.phase).is_empty());
                                    serde_json::to_value(&state).expect("serialises");
                                    count += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    assert_eq!(
        count,
        run_dates.len()
            * ticks.len()
            * tick_states.len()
            * skips.len()
            * nows.len()
            * intervals.len()
            * 2
            * 2,
        "the cross product did not run the number of cases it enumerates"
    );
}

/// Garbage JSON in, a state out — never a panic and never an error. The envelopes are frozen
/// ADDITIVE-ONLY, so an unknown key is expected; a wrong TYPE must degrade, not explode.
#[test]
fn garbage_envelopes_degrade_rather_than_panic() {
    for raw in [
        serde_json::json!({}),
        serde_json::json!({ "configExists": true, "morningTime": {} }),
        serde_json::json!({ "configExists": true, "lastTick": { "iso": "", "localDate": "", "count": 0 } }),
        serde_json::json!({ "configExists": true, "brandNewFieldFromAFutureEngine": [1, 2, 3] }),
    ] {
        let status: StatusView =
            serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("{raw} → {e}"));
        let state = derive(&status, None, None, &at_0910());
        serde_json::to_value(&state).expect("serialises");
    }
    // A wrong TYPE is a parse failure, not a panic — the caller then has no status and says so.
    let wrong: Result<StatusView, _> =
        serde_json::from_value(serde_json::json!({ "configExists": "yes" }));
    assert!(wrong.is_err(), "a wrongly-typed field must fail the parse");
}

/* ── 3. anti-drift pins against the engine ────────────────────────────────────────────────────── */

/// The Rust port of `SKIP_REASONS` is compared to the ENGINE's array, in order.
///
/// ⚠ THE ENGINE'S OWN DOCSTRING IS WHY THIS EXISTS: *"CLOSED ON PURPOSE … a GUI switches on it to
/// decide what to tell the user — so a free-text reason invented at one return site is a silent gap
/// in that switch."* This app is that GUI, and a port nothing compares to the original is the gap
/// with extra steps.
#[test]
fn the_skip_vocabulary_matches_the_engine() {
    let source = include_str!("../../../src/json.ts");
    let start = source
        .find("export const SKIP_REASONS = [")
        .expect("src/json.ts still declares SKIP_REASONS");
    let body = &source[start..];
    let end = body
        .find("] as const;")
        .expect("the SKIP_REASONS array is closed with `] as const;`");
    let body = &body[..end];

    let engine = quoted_tokens(body);
    // prove-it 3b: a parse that silently matched nothing would make this assertion vacuous.
    assert!(
        engine.len() >= 10,
        "only {} reasons were parsed out of src/json.ts — the PARSE broke, not the port. Fix the \
         parse rather than deleting the assertion it feeds. Body was: {body:?}",
        engine.len()
    );
    assert_eq!(
        engine,
        SKIP_REASONS.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        "schedule_state::SKIP_REASONS and src/json.ts's SKIP_REASONS disagree. The engine's set is \
         closed, and a member this app does not know maps to SkipReason::Unknown — which renders, \
         but with no wording of its own. Port the new member and give it a tray line."
    );
    // Every member round-trips through the typed enum without becoming Unknown.
    for reason in SKIP_REASONS {
        let parsed = SkipReason::parse(reason);
        assert!(parsed.is_known(), "{reason} parsed as Unknown");
        assert_eq!(parsed.as_str(), *reason);
    }
    assert!(!SkipReason::parse("solar-flare").is_known());
    assert_eq!(SkipReason::parse("solar-flare").as_str(), "solar-flare");
}

/// Every quoted token in an array-literal body — double- or single-quoted, several to a line —
/// after dropping `//` comments. The body starts at the `[`.
fn quoted_tokens(body: &str) -> Vec<String> {
    let inner = body.split_once('[').map_or(body, |(_, rest)| rest);
    let mut out = Vec::new();
    for line in inner.lines() {
        let code = line.split("//").next().unwrap_or_default();
        let mut chars = code.chars();
        while let Some(c) = chars.next() {
            if c == '"' || c == '\'' {
                let token: String = chars.by_ref().take_while(|&d| d != c).collect();
                out.push(token);
            }
        }
    }
    out
}

/// The parser above, against the shapes the engine could legitimately switch to.
#[test]
fn the_vocabulary_parser_reads_every_quoted_token() {
    let body = "[\n  \"a\", \"b\",   // \"not-me\"\n  'c',\n  \"d\" // trailing\n";
    assert_eq!(quoted_tokens(body), vec!["a", "b", "c", "d"]);
}

/// The heartbeat format the machine's inputs assume is still the one `stampTick` writes.
#[test]
fn the_heartbeat_format_matches_the_engine() {
    let marker = include_str!("../../../src/marker.ts");
    assert!(
        marker.contains("local=${todayLocal} today=${next}"),
        "src/marker.ts no longer writes `<iso> local=<YYYY-MM-DD> today=<n>`. The UNKNOWN-TICK \
         state, the day-35 reading and `ticksToday`'s null-vs-zero rule all rest on that shape."
    );
    assert!(
        include_str!("../../../src/json.ts").contains(r"/^(\S+)\s+local=(\S+)\s+today=(\d+)$/"),
        "src/json.ts's TICK_RE changed; a line that no longer matches reads as `legacy` here, \
         which this app renders as UNKNOWN — so a format change is a UI change."
    );
}

/* ── instants ─────────────────────────────────────────────────────────────────────────────────── */

/// The hand-rolled parser, against instants computed independently (Python 3's `datetime`).
#[test]
fn parse_iso_utc_agrees_with_known_instants() {
    for (iso, expected) in [
        ("1970-01-01T00:00:00.000Z", 0_i64),
        ("2000-03-01T00:00:00.000Z", 951_868_800),
        ("2026-09-16T07:30:00.000Z", 1_789_543_800),
        ("1999-12-31T23:59:59.000Z", 946_684_799),
        ("2024-02-29T12:00:00.000Z", 1_709_208_000),
        ("1969-12-31T23:59:59.000Z", -1),
        ("2026-08-20T00:00:00.000Z", 1_787_184_000),
        // The seconds-only form the parser also accepts.
        ("2026-09-16T07:30:00Z", 1_789_543_800),
        // Real leap days, including the 400-year one.
        ("2000-02-29T00:00:00.000Z", 951_782_400),
        ("2028-02-29T23:59:59.999Z", 1_835_481_599),
    ] {
        assert_eq!(parse_iso_utc(iso), Some(expected), "{iso}");
    }
}

/// ⚠ STRICT ON PURPOSE. A shape the parser does not recognise must be `None`, because the caller
/// then declines to judge staleness rather than judging it from a number it invented.
#[test]
fn parse_iso_utc_refuses_everything_else() {
    for bad in [
        "",
        "2026-09-16",
        "2026-09-16T07:30:00",       // no zone
        "2026-09-16T07:30:00+02:00", // not UTC
        "2026-13-16T07:30:00.000Z",  // month 13
        "2026-09-32T07:30:00.000Z",  // day 32
        "2026-09-16T24:30:00.000Z",  // hour 24
        "2026-09-16T07:61:00.000Z",  // minute 61
        "2026-09-16T07:30:61.000Z",  // second 61
        "20260916T073000Z",          // no separators
        "2026/09/16T07:30:00.000Z",  // wrong separators
        "202６-09-16T07:30:00.000Z", // a full-width digit
        "not-a-date",
        // GA1: anything between the seconds and the `Z` used to be ignored.
        "2026-09-16T07:30:00NOT_A_FRACTIONZ",
        "2026-09-16T07:30:00.1Z",
        "2026-09-16T07:30:00.12345Z",
        "2026-09-16T07:30:00,000Z",
        "2026-09-16T07:30:00.0a0Z",
        "+026-09-16T07:30:00.000Z",
        "2026-09-16 07:30:00.000Z",
        // GA2: days that do not exist.
        "2026-02-29T00:00:00.000Z",
        "2025-02-29T00:00:00Z",
        "2026-02-31T00:00:00Z",
        "2026-04-31T00:00:00Z",
        "1900-02-29T00:00:00Z", // divisible by 100, not by 400
        "2026-00-10T00:00:00Z",
        "2026-09-00T00:00:00Z",
        // `toISOString()` never writes a leap second.
        "2026-09-16T07:30:60.000Z",
    ] {
        assert_eq!(parse_iso_utc(bad), None, "{bad:?} was accepted");
    }
}

/* ── the rest of the verdict ──────────────────────────────────────────────────────────────────── */

#[test]
fn engine_skew_is_only_claimed_for_an_app_owned_schedule_with_both_versions_known() {
    let pair_for = |owner: Option<&str>, installed: Option<&str>, current: Option<&str>| {
        let status = StatusView {
            engine_version: current.map(str::to_string),
            ..status()
        };
        let schedule = ScheduleView {
            owner: owner.map(str::to_string),
            installed_engine_version: installed.map(str::to_string),
            engine_version: current.map(str::to_string),
            ..schedule()
        };
        derive(&status, None, Some(&schedule), &at_0910()).engine_update_available
    };
    let app = Some("app");
    assert!(pair_for(app, Some("0.1.0"), Some("0.1.1")));
    assert!(!pair_for(app, Some("0.1.1"), Some("0.1.1")));
    assert!(!pair_for(app, None, Some("0.1.1")));
    assert!(!pair_for(app, Some("0.1.0"), None));
    // ⚠ R1: "CLI-owned installs refresh via install.sh as today". An app-invoked re-install over a
    // CLI record is a take-over, so the prompt must not offer it as an "update".
    assert!(!pair_for(Some("cli"), Some("0.1.0"), Some("0.1.1")));
    assert!(!pair_for(None, Some("0.1.0"), Some("0.1.1")));
}

/// The first-wake sentence carries the configured floor, both times, and says the floor is not a
/// delivery time. It is the single mitigation for this product's most common misreading.
#[test]
fn the_first_wake_sentence_names_the_floor_and_denies_it_is_a_delivery_time() {
    let sentence = first_wake_sentence("08:45");
    assert_eq!(sentence.matches("08:45").count(), 2, "{sentence}");
    assert!(sentence.contains("first check after"), "{sentence}");
    assert!(sentence.contains("not at"), "{sentence}");
    let state = derive(&status(), None, Some(&schedule()), &at_0910());
    assert_eq!(state.first_wake, first_wake_sentence("07:20"));
}

/// Every field the webview reads is camelCase, including the ones INSIDE a phase variant — serde's
/// container `rename_all` renames variants only, so this is what pins `rename_all_fields`.
#[test]
fn the_wire_shape_is_camel_case_throughout() {
    let status = StatusView {
        last_tick: Some(tick("2026-09-16T12:55:00.000Z", TODAY, 2)),
        ..status()
    };
    let state = derive(&status, None, Some(&schedule()), &at_0600());
    let wire = serde_json::to_value(&state).expect("serialises");
    assert_eq!(wire["phase"]["phase"], "waiting-for-floor");
    assert_eq!(wire["phase"]["floor"], "07:20");
    assert_eq!(wire["phase"]["minutesUntilFloor"], 80);
    assert!(
        wire["phase"]["minutes_until_floor"].is_null(),
        "a snake_case field reached the wire: {wire}"
    );
    for key in [
        "statusLine",
        "floorWarning",
        "firstWake",
        "ticksToday",
        "ticksExpectedSinceFloor",
        "lastTick",
        "unitPath",
        "recordPresent",
        "unitPresent",
        "engineVersion",
        "installedEngineVersion",
        "engineUpdateAvailable",
        "intervalSec",
        "lingerState",
        // Batch 2 (spec 3.4.1): the TS `ScheduleState` (`gui/src/lib/state.ts`) reads these three.
        "recordFilePresent",
        "registeredReason",
        "removeSteps",
    ] {
        assert!(
            wire.get(key).is_some(),
            "the wire shape is missing {key}: {wire}"
        );
    }
    for snake in ["record_file_present", "registered_reason", "remove_steps"] {
        assert!(
            wire.get(snake).is_none(),
            "a snake_case field reached the wire: {snake} in {wire}"
        );
    }
    // A skip's reason serialises as the ENGINE's literal string, not as serde's enum wrapper.
    let skipped = derive(
        &status,
        Some(&skip("solar-flare", TODAY, Some("d"))),
        Some(&schedule()),
        &at_0910(),
    );
    let wire = serde_json::to_value(&skipped).expect("serialises");
    assert_eq!(wire["phase"]["reason"], "solar-flare");
}

/// ⚠ CONFIG-ERROR OUTRANKS DELIVERED, AND DOES NOT HIDE IT. Two lies this pins against: a tray
/// that says "Not delivered today" on a day that was delivered, and a machine that ranks a broken
/// config BELOW the delivery (so tomorrow's missing briefing is never flagged).
#[test]
fn a_config_error_outranks_delivery_and_keeps_it_visible() {
    let broken = |delivered: bool| StatusView {
        config_error: Some("Unexpected token } in JSON at position 42".into()),
        last_run_date: delivered.then(|| TODAY.to_string()),
        latest_briefing_mtime: delivered.then(|| "2026-09-16T14:24:00.000Z".to_string()),
        ..status()
    };

    let state = derive(&broken(true), None, Some(&schedule()), &at_0910());
    match &state.phase {
        Phase::ConfigError {
            detail,
            delivered_today,
            delivered_at,
        } => {
            assert_eq!(detail, "Unexpected token } in JSON at position 42");
            assert!(*delivered_today);
            assert_eq!(delivered_at.as_deref(), Some("2026-09-16T14:24:00.000Z"));
        }
        other => panic!("a config error must outrank a delivery, got {other:?}"),
    }
    assert!(
        state.status_line.starts_with("Delivered ")
            && state.status_line.ends_with(" · config has an error"),
        "{}",
        state.status_line
    );
    assert_eq!(state.tray_line(), state.status_line);

    let state = derive(&broken(false), None, Some(&schedule()), &at_0910());
    assert!(matches!(
        state.phase,
        Phase::ConfigError {
            delivered_today: false,
            delivered_at: None,
            ..
        }
    ));
    assert_eq!(state.status_line, "Config has an error");

    let wire = serde_json::to_value(derive(&broken(true), None, None, &at_0910())).unwrap();
    assert_eq!(wire["phase"]["phase"], "config-error");
    assert_eq!(wire["phase"]["deliveredToday"], true);
    assert_eq!(
        wire["phase"]["detail"],
        "Unexpected token } in JSON at position 42"
    );
}

/// A broken unit gets its own loud line.
#[test]
fn a_broken_scheduler_says_so_in_the_tray() {
    let state = derive(
        &status(),
        None,
        Some(&ScheduleView {
            registered: Some(false),
            ..schedule()
        }),
        &at_0910(),
    );
    assert_eq!(state.phase, Phase::SchedulerBroken);
    assert_eq!(state.status_line, "Scheduler not loaded");
    assert_eq!(
        serde_json::to_value(&state).unwrap()["phase"]["phase"],
        "scheduler-broken"
    );
}

/// ⚠ UNKNOWN IS NOT BROKEN, NOW WITH A REASON (Batch 2, spec 3.1.5). A Linux record whose user
/// manager cannot be reached used to read `registered: false` — SCHEDULER-BROKEN, with Repair —
/// and the engine now answers `null` with `registeredReason`. With a record present that must not
/// read as broken: the phase is exactly the one a registered schedule gets from the same inputs,
/// and the reason and the manual steps reach the state the Schedule screen renders, verbatim.
#[test]
fn an_unknown_registration_with_a_record_is_not_broken_and_carries_its_reason() {
    let unknown = ScheduleView {
        registered: None,
        registered_reason: Some("no-user-manager".into()),
        ..schedule()
    };
    let state = derive(&status(), None, Some(&unknown), &at_0910());
    assert_ne!(state.phase, Phase::SchedulerBroken, "{state:?}");
    assert_eq!(
        state.phase,
        derive(&status(), None, Some(&schedule()), &at_0910()).phase,
        "an unknown registration must read exactly like a registered one"
    );
    assert_eq!(state.registered, None);
    assert_eq!(state.registered_reason.as_deref(), Some("no-user-manager"));
    assert_eq!(state.remove_steps.as_deref(), Some(REMOVE_STEPS));
    assert!(state.record_file_present, "{state:?}");
    let wire = serde_json::to_value(&state).expect("serialises");
    assert_eq!(wire["registered"], serde_json::Value::Null, "{wire}");
    assert_eq!(wire["registeredReason"], "no-user-manager", "{wire}");
    assert_eq!(wire["removeSteps"], REMOVE_STEPS, "{wire}");
    assert_eq!(wire["recordFilePresent"], true, "{wire}");
}

/// `recordFilePresent` is the engine's `lstat` fact, readable or not, and `derive` passes it
/// through on its own — it is NOT `recordPresent` (spec 3, "three record facts"). A malformed
/// record reads `recordPresent: false` (the phase stays NOT-SCHEDULED, keyed on the readable
/// record as before) and `recordFilePresent: true`, which is what the Schedule screen's remove
/// control will key on (spec 3.4.1). With no schedule envelope at all, all three are unknown.
#[test]
fn the_record_file_fact_is_carried_apart_from_the_readable_record() {
    let malformed = ScheduleView {
        record_present: false,
        record_file_present: true,
        owner: None,
        ..schedule()
    };
    let state = derive(&status(), None, Some(&malformed), &at_0910());
    assert_eq!(state.phase, Phase::NotScheduled, "{state:?}");
    assert!(!state.record_present);
    assert!(state.record_file_present, "{state:?}");

    let none = derive(&status(), None, None, &at_0910());
    assert!(!none.record_file_present, "{none:?}");
    assert_eq!(none.registered_reason, None);
    assert_eq!(none.remove_steps, None);
}

/// The three keys are read under the ENGINE's spelling. `ScheduleView` is `#[serde(default)]`, so
/// a misspelt key would not fail to parse — it would silently read as absent, `false` or `null`,
/// forever. So every key `ScheduleView` reads is required to be a member of the engine's own
/// `ScheduleStatusReport` type (`src/schedule/status.ts`), and the three Batch 2 keys are parsed
/// out of a real-shaped envelope.
#[test]
fn every_schedule_view_key_is_a_member_of_the_engines_report() {
    let source = include_str!("../../../src/schedule/status.ts");
    let start = source
        .find("export type ScheduleStatusReport = {")
        .expect("src/schedule/status.ts still declares ScheduleStatusReport");
    let body = &source[start..];
    let end = body
        .find("\n};")
        .expect("the ScheduleStatusReport type is closed with `};` on its own line");
    let body = &body[..end];
    let wire = serde_json::to_value(ScheduleView::default()).expect("serialises");
    let keys: Vec<&String> = wire.as_object().expect("an object").keys().collect();
    // prove-it 3b: an empty key list would make the loop below pass vacuously.
    assert!(keys.len() >= 19, "only {} keys: {keys:?}", keys.len());
    for key in keys {
        assert!(
            body.contains(&format!("\n  {key}:")),
            "ScheduleView reads `{key}`, which src/schedule/status.ts's ScheduleStatusReport does \
             not declare — a misspelt key reads as its default forever"
        );
    }

    let view: ScheduleView = serde_json::from_value(serde_json::json!({
        "registered": null,
        "registeredReason": "timeout",
        "recordPresent": false,
        "recordFilePresent": true,
        "removeSteps": REMOVE_STEPS,
    }))
    .expect("the engine's shape parses");
    assert_eq!(view.registered, None);
    assert_eq!(view.registered_reason.as_deref(), Some("timeout"));
    assert!(view.record_file_present);
    assert_eq!(view.remove_steps.as_deref(), Some(REMOVE_STEPS));
    // And an older engine, which sends none of them, reads as "not known" rather than failing.
    assert_eq!(
        serde_json::from_value::<ScheduleView>(serde_json::json!({ "recordPresent": true }))
            .expect("an older envelope parses"),
        ScheduleView {
            record_present: true,
            ..ScheduleView::default()
        }
    );
}

/// A skip carries the instant its record was written — the screen's "Recorded …" line.
#[test]
fn a_skip_carries_the_records_instant() {
    let state = derive(
        &StatusView {
            last_tick: Some(tick("2026-09-16T16:05:00.000Z", TODAY, 11)),
            ..status()
        },
        Some(&skip("offline", TODAY, Some("no network"))),
        Some(&schedule()),
        &at_0910(),
    );
    match &state.phase {
        Phase::Skipped {
            reason,
            iso,
            detail,
        } => {
            assert_eq!(reason, &SkipReason::Offline);
            assert_eq!(iso.as_deref(), Some("2026-09-16T16:00:00.000Z"));
            assert_eq!(detail.as_deref(), Some("no network"));
        }
        other => panic!("expected a skip, got {other:?}"),
    }
    assert_eq!(state.status_line, "Offline");
    // L10: the human line, not the raw token, is what the badge shows.
    let marker = derive(
        &status(),
        Some(&skip("marker-fail", TODAY, Some("EACCES"))),
        Some(&schedule()),
        &at_0910(),
    );
    assert_eq!(marker.status_line, "Delivered, but the day marker failed");
}

/// v0.2.1 §2.4.5: a blocked run can now be blocked by a FOLDER (a configured search folder that
/// could not be read, or is missing), so the line says "folder or repo" and "or found"; the engine's
/// discovery summary rides in `detail`, verbatim, for Today's and Schedule's banner.
#[test]
fn a_blocked_skip_says_folder_or_repo_and_keeps_the_summary_as_detail() {
    let summary = "No repositories were found in Folders to search. Couldn't read 1 folder \
                   (~/Documents) because macOS blocked access, so repos in it may be missing.";
    let state = derive(
        &status(),
        Some(&skip("blocked", TODAY, Some(summary))),
        Some(&schedule()),
        &at_0910(),
    );
    assert_eq!(
        state.status_line,
        "Blocked — a folder or repo could not be read or found"
    );
    match &state.phase {
        Phase::Skipped { reason, detail, .. } => {
            assert_eq!(reason, &SkipReason::Blocked);
            assert_eq!(detail.as_deref(), Some(summary));
        }
        other => panic!("expected a skip, got {other:?}"),
    }
}

/// ⚠ AN INVALID `morningTime` SHOWS THE FLOOR THE ENGINE USES. `parseFloor` falls back to the
/// default for "25:99"; showing "25:99" as the floor would describe a schedule that is not running.
#[test]
fn an_invalid_morning_time_shows_the_floor_in_force() {
    let invalid = StatusView {
        morning_time: MorningTime {
            value: "25:99".into(),
            minutes: 440,
            warning: Some("invalid morningTime \"25:99\" — using the default 07:20".into()),
        },
        ..status()
    };
    let state = derive(&invalid, None, Some(&schedule()), &at_0600());
    assert_eq!(state.floor, "07:20");
    assert_eq!(state.first_wake, first_wake_sentence("07:20"));
    assert!(state
        .floor_warning
        .as_deref()
        .unwrap_or_default()
        .contains("25:99"));
    match &state.phase {
        Phase::WaitingForFloor { floor, .. } => assert_eq!(floor, "07:20"),
        other => panic!("expected waiting-for-floor, got {other:?}"),
    }
    // A single-digit hour the engine accepts is shown padded.
    let short = StatusView {
        morning_time: MorningTime {
            value: "7:05".into(),
            minutes: 425,
            warning: None,
        },
        ..status()
    };
    assert_eq!(derive(&short, None, None, &at_0910()).floor, "07:05");
}

/// A tick count past `u32::MAX` must not blank the whole state (it used to fail the parse of the
/// entire `status` envelope).
#[test]
fn a_huge_tick_count_does_not_blank_the_state() {
    let raw = serde_json::json!({
        "configExists": true,
        "lastTick": { "iso": "2026-09-16T16:05:00.000Z", "localDate": TODAY, "count": 5_000_000_000u64 }
    });
    let status: StatusView = serde_json::from_value(raw).expect("a u64 count parses");
    assert_eq!(
        status.last_tick.as_ref().map(|t| t.count),
        Some(5_000_000_000)
    );
    let schedule: ScheduleView = serde_json::from_value(serde_json::json!({
        "recordPresent": true, "unitPresent": true, "ticksToday": 5_000_000_000u64
    }))
    .expect("a u64 ticksToday parses");
    let state = derive(&status, None, Some(&schedule), &at_0910());
    assert_eq!(state.ticks_today, Some(5_000_000_000));
}

/* ── time boundaries ──────────────────────────────────────────────────────────────────────────── */

fn iso(s: &str) -> i64 {
    parse_iso_utc(s).unwrap_or_else(|| panic!("{s} parses"))
}

/// A local instant on a UTC-7 machine: `local_date`, `hh:mm:ss` local.
fn utc_minus_7(local_date: &str, hh: u32, mm: u32, ss: i64) -> Now {
    let midnight_utc = iso(&format!("{local_date}T00:00:00Z")) + 7 * 3_600;
    Now {
        local_date: local_date.into(),
        minutes: hh * 60 + mm,
        epoch_secs: midnight_utc + i64::from(hh) * 3_600 + i64::from(mm) * 60 + ss,
    }
}

/// `next_boundary` names the instant the state changes with no file changing — and the table
/// checks that `derive` really does change there (and not one second earlier).
#[test]
fn next_boundary_names_the_instant_the_state_changes() {
    struct Case {
        what: &'static str,
        status: StatusView,
        schedule: Option<ScheduleView>,
        now: Now,
        expect: Option<i64>,
        /// Whether the state really does change AT the boundary. A boundary is where the state
        /// CAN change; midnight over an already-stale heartbeat, for one, changes nothing.
        changes: bool,
    }
    let at = |hh, mm, ss| utc_minus_7(TODAY, hh, mm, ss);
    let midnight = iso("2026-09-17T07:00:00Z");
    let cases = vec![
        Case {
            what: "09:00 waiting, tick 08:55: the stale deadline, 20 min + 1 s after the tick",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T15:55:00.000Z", TODAY, 10)),
                ..status()
            },
            schedule: Some(schedule()),
            now: at(9, 0, 0),
            expect: Some(iso("2026-09-16T16:15:01Z")),
            changes: true,
        },
        Case {
            what: "a 300 s interval halves the deadline",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T15:55:00.000Z", TODAY, 10)),
                ..status()
            },
            schedule: Some(ScheduleView {
                interval_sec: Some(300),
                ..schedule()
            }),
            now: at(9, 0, 0),
            expect: Some(iso("2026-09-16T16:05:01Z")),
            changes: true,
        },
        Case {
            what: "06:00:30, before the floor: the next minute",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T12:55:00.000Z", TODAY, 2)),
                ..status()
            },
            schedule: Some(schedule()),
            now: at(6, 0, 30),
            expect: Some(iso("2026-09-16T13:01:00Z")),
            changes: true,
        },
        Case {
            what: "23:59:30 delivered, tick 23:55: local midnight comes before the deadline",
            status: StatusView {
                last_run_date: Some(TODAY.into()),
                last_tick: Some(tick("2026-09-17T06:55:00.000Z", TODAY, 99)),
                ..status()
            },
            schedule: Some(schedule()),
            now: at(23, 59, 30),
            expect: Some(midnight),
            changes: true,
        },
        Case {
            what: "a deadline already passed is not a boundary: midnight is",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T10:00:00.000Z", TODAY, 1)),
                ..status()
            },
            schedule: Some(schedule()),
            now: at(9, 0, 0),
            expect: Some(midnight),
            changes: false,
        },
        Case {
            what: "no interval (no schedule envelope): midnight only",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T15:55:00.000Z", TODAY, 10)),
                ..status()
            },
            schedule: None,
            now: at(9, 0, 0),
            expect: Some(midnight),
            changes: true,
        },
        Case {
            what: "an absurd interval is no deadline",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T15:55:00.000Z", TODAY, 10)),
                ..status()
            },
            schedule: Some(ScheduleView {
                interval_sec: Some(0),
                ..schedule()
            }),
            now: at(9, 0, 0),
            expect: Some(midnight),
            changes: true,
        },
        Case {
            what: "a tick an hour ahead: when it comes within the skew allowance",
            status: StatusView {
                last_tick: Some(tick("2026-09-16T17:00:00.000Z", TODAY, 10)),
                ..status()
            },
            schedule: Some(schedule()),
            now: at(9, 0, 0),
            expect: Some(iso("2026-09-16T17:00:00Z") - FUTURE_TICK_SKEW_SECS),
            changes: true,
        },
        Case {
            what: "no local date and nothing else: no boundary to name",
            status: status(),
            schedule: None,
            now: Now {
                local_date: String::new(),
                ..at(9, 0, 0)
            },
            expect: None,
            changes: false,
        },
    ];
    for case in cases {
        let got = next_boundary(&case.status, case.schedule.as_ref(), &case.now);
        assert_eq!(got, case.expect, "{}", case.what);
        let Some(boundary) = got else { continue };
        // The claim is not just "some instant": the state is the same one second before it...
        let before_state = |now: &Now| derive(&case.status, None, case.schedule.as_ref(), now);
        let shift = |secs: i64| {
            let t = boundary + secs;
            let c = utc_civil(t - 7 * 3_600);
            now_from_civil(t, Some(c))
        };
        if boundary - 1 > case.now.epoch_secs && !case.now.local_date.is_empty() {
            assert_eq!(
                before_state(&shift(-1)).phase,
                before_state(&case.now).phase,
                "{}: the state changed BEFORE the named boundary",
                case.what
            );
        }
        // ...and different at it, where the case says the change is real.
        assert_eq!(
            before_state(&shift(0)) != before_state(&case.now),
            case.changes,
            "{}: the state {} AT the named boundary",
            case.what,
            if case.changes {
                "did not change"
            } else {
                "changed"
            }
        );
    }
}

/// One row: what, the status, the schedule, before, after, whether it is a crossing.
type Crossing<'a> = (
    &'a str,
    &'a StatusView,
    Option<ScheduleView>,
    Now,
    Now,
    bool,
);

/// ⚠ R2-1: WHICH CLOCK MOVES MUST READ THE ENGINE AGAIN. Midnight, the floor, the stale deadline
/// and a clock going backwards are crossings; a minute of countdown, an hour inside the deadline and
/// a standing clock are not. The stale-deadline row is checked against `next_boundary`'s own
/// deadline, so the two cannot disagree about where it is.
#[test]
fn crossing_midnight_the_floor_or_the_deadline_needs_a_real_read() {
    let at = |date: &str, hh, mm, ss| utc_minus_7(date, hh, mm, ss);
    let ticked = StatusView {
        last_tick: Some(tick("2026-09-16T15:55:00.000Z", TODAY, 10)),
        ..status()
    };
    let deadline =
        next_boundary(&ticked, Some(&schedule()), &at(TODAY, 9, 0, 0)).expect("a stale deadline");
    assert_eq!(deadline, iso("2026-09-16T16:15:01Z"));
    let just_before = Now {
        epoch_secs: deadline - 1,
        ..at(TODAY, 9, 15, 0)
    };
    let at_deadline = Now {
        epoch_secs: deadline,
        ..at(TODAY, 9, 15, 0)
    };
    let cases: Vec<Crossing> = vec![
        (
            "a standing clock",
            &ticked,
            Some(schedule()),
            at(TODAY, 9, 0, 0),
            at(TODAY, 9, 0, 0),
            false,
        ),
        (
            "inside the deadline",
            &ticked,
            Some(schedule()),
            at(TODAY, 9, 0, 0),
            just_before.clone(),
            false,
        ),
        (
            "onto the deadline",
            &ticked,
            Some(schedule()),
            just_before.clone(),
            at_deadline.clone(),
            true,
        ),
        (
            "past the deadline in one jump",
            &ticked,
            Some(schedule()),
            at(TODAY, 9, 0, 0),
            at(TODAY, 11, 0, 0),
            true,
        ),
        (
            "already past it",
            &ticked,
            Some(schedule()),
            at_deadline,
            at(TODAY, 11, 0, 0),
            false,
        ),
        (
            "no interval, no deadline",
            &ticked,
            None,
            at(TODAY, 9, 0, 0),
            at(TODAY, 11, 0, 0),
            false,
        ),
        (
            "a minute of countdown",
            &ticked,
            Some(schedule()),
            at(TODAY, 6, 0, 30),
            at(TODAY, 6, 1, 0),
            false,
        ),
        (
            "onto the floor",
            &ticked,
            Some(schedule()),
            at(TODAY, 7, 19, 59),
            at(TODAY, 7, 20, 0),
            true,
        ),
        (
            "across the floor",
            &ticked,
            Some(schedule()),
            at(TODAY, 7, 0, 0),
            at(TODAY, 8, 0, 0),
            true,
        ),
        (
            "after the floor",
            &ticked,
            Some(schedule()),
            at(TODAY, 7, 20, 0),
            at(TODAY, 7, 21, 0),
            false,
        ),
        (
            "across midnight",
            &ticked,
            Some(schedule()),
            at(TODAY, 23, 59, 30),
            at("2026-09-17", 0, 0, 5),
            true,
        ),
        (
            "a clock stepped back",
            &ticked,
            Some(schedule()),
            at(TODAY, 9, 0, 0),
            at(TODAY, 8, 59, 0),
            true,
        ),
    ];
    for (what, status, schedule, before, after, expected) in cases {
        assert_eq!(
            crosses_read_boundary(status, schedule.as_ref(), &before, &after),
            expected,
            "{what}"
        );
    }
    // The floor is the one IN FORCE — the engine's minutes, not a constant.
    let late_floor = StatusView {
        morning_time: MorningTime {
            value: "09:30".into(),
            minutes: 570,
            warning: None,
        },
        ..status()
    };
    assert!(!crosses_read_boundary(
        &late_floor,
        None,
        &at(TODAY, 7, 19, 0),
        &at(TODAY, 7, 21, 0)
    ));
    assert!(crosses_read_boundary(
        &late_floor,
        None,
        &at(TODAY, 9, 29, 0),
        &at(TODAY, 9, 30, 0)
    ));
}

/// The one-day interval ceiling, as a value: an envelope interval past a day is not one this app
/// judges staleness by.
#[test]
fn the_interval_ceiling_is_one_day() {
    assert_eq!(MAX_INTERVAL_SECS, 86_400);
}

/* ── the UTC fallback ─────────────────────────────────────────────────────────────────────────── */

/// ⚠ THE NON-UNIX FALLBACK, TESTED HERE BECAUSE IT IS COMPILED HERE. It used to exist only under
/// `cfg(not(unix))`, and it did not type-check.
#[test]
fn the_utc_fallback_breaks_instants_down_correctly() {
    for (s, expected) in [
        ("1970-01-01T00:00:00Z", (1970, 1, 1, 0, 0)),
        ("1969-12-31T23:59:59Z", (1969, 12, 31, 23, 59)),
        ("2000-02-29T12:34:56Z", (2000, 2, 29, 12, 34)),
        ("2026-09-16T14:24:00Z", (2026, 9, 16, 14, 24)),
        ("2026-12-31T23:59:59Z", (2026, 12, 31, 23, 59)),
        ("2027-01-01T00:00:00Z", (2027, 1, 1, 0, 0)),
        ("2100-03-01T00:00:00Z", (2100, 3, 1, 0, 0)),
    ] {
        let c = utc_civil(iso(s));
        assert_eq!((c.year, c.month, c.day, c.hour, c.minute), expected, "{s}");
    }
    // Round trip across four centuries of days.
    let mut day = iso("1900-01-01T00:00:00Z");
    while day < iso("2300-01-01T00:00:00Z") {
        let c = utc_civil(day + 86_399);
        let back = format!("{:04}-{:02}-{:02}T23:59:59Z", c.year, c.month, c.day);
        assert_eq!(iso(&back), day + 86_399, "{back}");
        day += 86_400 * 37;
    }
    let now = now_from_civil(
        iso("2026-09-16T14:24:00Z"),
        Some(CivilTime {
            year: 2026,
            month: 9,
            day: 16,
            hour: 14,
            minute: 24,
        }),
    );
    assert_eq!(now.local_date, "2026-09-16");
    assert_eq!(now.minutes, 14 * 60 + 24);
    let unknown = now_from_civil(5, None);
    assert_eq!((unknown.local_date.as_str(), unknown.minutes), ("", 0));
}

/// A `TickProblem` reaches the wire as the kebab-case word the screen switches on.
#[test]
fn tick_problems_serialise_as_words() {
    for (cause, word) in [
        (TickProblem::Legacy, "legacy"),
        (TickProblem::UnreadableInstant, "unreadable-instant"),
        (TickProblem::Future, "future"),
    ] {
        assert_eq!(serde_json::to_value(cause).unwrap(), word);
    }
}

/// Small helper the day-35 test uses; kept here rather than on the type because nothing in the app
/// needs it.
trait TickLocalDate {
    fn lastick_local_date(&self) -> Option<String>;
}
impl TickLocalDate for daily_briefing_gui_lib::schedule_state::ScheduleState {
    fn lastick_local_date(&self) -> Option<String> {
        self.last_tick.as_ref().map(|t| t.local_date.clone())
    }
}
