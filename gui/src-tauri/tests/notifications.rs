//! T18 — the delegated-arm notification decision, driven end to end WITHOUT posting anything.
//!
//! Every test here manages a `RecordingNotifySink` (`common/mod.rs`) and a scratch store; the
//! REAL post — the plugin, notify-rust, Notification Center, the OS's first-post registration —
//! is VM-gated (`docs/gui-seam.md` §12c) and never reachable from this file: no mock app
//! registers the notification plugin, and every `NotifyState` carries an injected sink.
//!
//! The layers, tested separately and then through the shipping sink:
//!
//!   * the CLASS map over the ENGINE's whole skip vocabulary (the never-notify table);
//!   * the TRANSITION machine (`Observation`): absorption at startup, the two-batch delivery
//!     flip, the per-(class, date) dedupe, midnight rollover;
//!   * the OWNERSHIP predicate (`engine_will_notify`), replayed over the SAME fixture file the
//!     web suite replays through the engine's own `notifyArgv`
//!     (`tests/fixtures/notify_predicate.json` / `gui/tests-web/notify.check.ts`);
//!   * the GATES (opt-in, ownership, body building) through `shell::AppState::changed` — the
//!     literal shipping sink — on a MockRuntime app.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::{RecordingNotifySink, ScratchDir};
use daily_briefing_gui_lib::notifications::{
    build_notification, classify_notify, engine_will_notify, facts_of, first_resume_line,
    notification_line, read_notified_dates, read_record, skip_notify_class, strip_control,
    strip_markdown_markers, write_notified_dates, write_record, Facts, Firing, NotifyClass,
    NotifyRecord, NotifyState, Observation, SkipFact, NOTIFIED_DATES_FILE,
    OUT_OF_USAGE_FALLBACK_BODY,
};
use daily_briefing_gui_lib::schedule_state::{now_local, LastSkip, Now, Phase, SKIP_REASONS};
use daily_briefing_gui_lib::shell::{AppState, ShellState};
use daily_briefing_gui_lib::watcher::{Snapshot, StateSink};
use serde_json::json;
use tauri::test::{mock_builder, MockRuntime};
use tauri::{App, Manager};

/* ── fixtures ─────────────────────────────────────────────────────────────────────────────────── */

/// Where the ENGINE's repo lives relative to this crate, for the source pins.
fn engine_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the repository root resolves")
}

/// A `status --json` payload with the fields the decision reads.
fn status_payload(
    last_run_date: Option<&str>,
    mtime: Option<&str>,
    last_skip: Option<(&str, &str, Option<&str>)>, // (reason, localDate, detail)
    config_path: Option<&str>,
    briefing_path: Option<&str>,
) -> serde_json::Value {
    let skip = match last_skip {
        None => serde_json::Value::Null,
        Some((reason, local_date, detail)) => json!({
            "iso": format!("{local_date}T07:20:00.000Z"),
            "localDate": local_date,
            "reason": reason,
            "detail": detail,
        }),
    };
    json!({
        "schemaVersion": 1,
        "configExists": true,
        "configError": null,
        "lastRunDate": last_run_date,
        "lastSkip": skip,
        "lastTick": null,
        "latestBriefingMtime": mtime,
        "morningTime": { "value": "07:20", "minutes": 440, "warning": null },
        "paths": {
            "stateDir": "/tmp/nowhere",
            "configPath": config_path,
            "latestBriefingPath": briefing_path,
        },
    })
}

/// A snapshot whose derived state matches the payload — built through the REAL `Snapshot::build`
/// so `facts_of` reads what the watcher would actually hand it. `now` is fixed at the given local
/// date, past the floor.
fn snapshot(now_date: &str, status: serde_json::Value) -> Snapshot {
    let now = daily_briefing_gui_lib::schedule_state::Now {
        local_date: now_date.to_string(),
        minutes: 480,
        epoch_secs: 1_790_000_000,
    };
    let schedule = json!({
        "registered": true,
        "recordPresent": true,
        "unitPresent": true,
        "owner": "app",
        "invoker": "app",
        "intervalSec": 600,
        "experimental": false,
    });
    Snapshot::build(Some(status), Some(schedule), &now, None)
}

fn delivered_snapshot(
    date: &str,
    mtime: &str,
    config: Option<&str>,
    briefing: Option<&str>,
) -> Snapshot {
    snapshot(
        date,
        status_payload(Some(date), Some(mtime), None, config, briefing),
    )
}

fn skipped_snapshot(
    date: &str,
    reason: &str,
    detail: Option<&str>,
    mtime: Option<&str>,
) -> Snapshot {
    skipped_snapshot_with_config(date, reason, detail, mtime, None)
}

/// [`skipped_snapshot`] with a real `paths.configPath` — what the ownership gate reads. The
/// DELIVERED-scoping pin (`engine_ownership_suppresses_delivered_only`) MUST use this form: a
/// skipped snapshot whose `config_path` is `None` never reaches the ownership gate at all, so the
/// FAILED leg would pass even under a mutant that suppresses every class by ownership (the round-1
/// vacuous-pin finding, mutant M10b).
fn skipped_snapshot_with_config(
    date: &str,
    reason: &str,
    detail: Option<&str>,
    mtime: Option<&str>,
    config: Option<&str>,
) -> Snapshot {
    snapshot(
        date,
        status_payload(None, mtime, Some((reason, date, detail)), config, None),
    )
}

/// A skip RECORD as `skip_notify_class` takes it (spec r9 §5: the class reads the record, not only
/// its reason, because `allOutOfUsage` decides `limited`'s class).
fn skip_record(reason: &str, all_out_of_usage: bool) -> LastSkip {
    LastSkip {
        iso: "2026-09-17T07:20:00.000Z".into(),
        local_date: "2026-09-17".into(),
        reason: reason.into(),
        detail: None,
        all_out_of_usage,
    }
}

/// The engine's two-line detail for an all-out-of-usage skip (`src/main.ts`, P1-M9-T2): the
/// notification body first, `limitedSkipMessage` second (the `briefing.log` line).
const OUT_OF_USAGE_DETAIL: &str =
    "No briefing yet today — every provider is out of usage until 09:00. It will arrive once one \
     resets, if your Mac is awake.\nskipped: account \"work\" is at its usage limit until 09:00 — no \
     other account is available; will retry next interval";
const OUT_OF_USAGE_BODY: &str =
    "No briefing yet today — every provider is out of usage until 09:00. It will arrive once one \
     resets, if your Mac is awake.";

/// A `limited` skip snapshot for `date` carrying the engine's `allOutOfUsage: true` ON THE WIRE —
/// the `status --json` `lastSkip` field — so `facts_of` reads it through the real deserializer.
fn out_of_usage_snapshot(date: &str, detail: Option<&str>) -> Snapshot {
    let mut status = status_payload(None, None, Some(("limited", date, detail)), None, None);
    status["lastSkip"]["allOutOfUsage"] = json!(true);
    snapshot(date, status)
}

fn waiting_snapshot(date: &str, mtime: Option<&str>) -> Snapshot {
    snapshot(date, status_payload(None, mtime, None, None, None))
}

/// [`snapshot`] with a BROKEN scheduler half (`registered: false`), so the derived phase is
/// `SchedulerBroken` — which `derive_phase` decides BEFORE `delivered_today` and
/// `Phase::Skipped` (the deviation-121 shadowing the round-2 priming pins need).
fn broken_scheduler_snapshot(now_date: &str, status: serde_json::Value) -> Snapshot {
    let now = daily_briefing_gui_lib::schedule_state::Now {
        local_date: now_date.to_string(),
        minutes: 480,
        epoch_secs: 1_790_000_000,
    };
    let schedule = json!({
        "registered": false,
        "recordPresent": true,
        "unitPresent": true,
        "owner": "app",
        "invoker": "app",
        "intervalSec": 600,
        "experimental": false,
    });
    Snapshot::build(Some(status), Some(schedule), &now, None)
}

/// [`facts_of`], observed by an app whose clock says `today` — what `on_snapshot` hands the
/// machine (P3-M5-T2: FAILED and `OutOfUsage` escape start-up absorption for TODAY's date only,
/// so the machine has to know which date that is). `today` may differ from the snapshot's own
/// derivation date on purpose: that is how an EARLIER-dated record is built.
fn on(today: &str, snapshot: &Snapshot) -> Facts {
    let mut facts = facts_of(snapshot);
    facts.today = Some(today.to_string());
    facts
}

/// A persisted / seeded dedupe map, written out.
fn dates(entries: &[(NotifyClass, &str)]) -> BTreeMap<NotifyClass, String> {
    entries
        .iter()
        .map(|(class, date)| (*class, date.to_string()))
        .collect()
}

/* ── the never-notify table, over the ENGINE's whole vocabulary ───────────────────────────────── */

/// Every member of the engine's `SKIP_REASONS` (pinned against `src/json.ts` by
/// `schedule_state.rs`'s vocabulary test) has an EXPLICIT notify decision, and the never-notify
/// set is exactly the documented one. An engine reason added tomorrow fails the vocabulary pin
/// first and this table second — the decision cannot default.
#[test]
fn every_skip_reason_has_the_documented_notify_decision() {
    let expected: &[(&str, Option<NotifyClass>)] = &[
        ("already-ran", None),
        ("no-config", None),
        ("config-error", None),
        ("below-floor", None),
        ("concurrent", None),
        ("offline", None),
        ("darkwake", None),
        ("limited", None),
        ("blocked", Some(NotifyClass::Blocked)),
        ("provider-fail", Some(NotifyClass::Failed)),
        ("parse-empty", Some(NotifyClass::Failed)),
        ("marker-fail", Some(NotifyClass::Failed)),
        ("write-fail", Some(NotifyClass::Failed)),
        ("crashed", Some(NotifyClass::Failed)),
    ];
    assert_eq!(
        expected.iter().map(|(r, _)| *r).collect::<Vec<_>>(),
        SKIP_REASONS.to_vec(),
        "the table no longer covers the engine's vocabulary member for member — a reason was \
         added or renamed; decide its class explicitly"
    );
    for (reason, class) in expected {
        assert_eq!(
            skip_notify_class(&skip_record(reason, false)),
            *class,
            "{reason}"
        );
    }
    // The additive rule: an unknown reason is SILENCE, never a guessed banner.
    assert_eq!(
        skip_notify_class(&skip_record("something-new", false)),
        None,
        "an unknown skip reason must choose silence"
    );
    // Requirement 11 (spec r9 §5): the ONE row the record's `allOutOfUsage` changes. A plain
    // `limited` stays silent above; a `limited` skip where every provider is out of usage is the
    // once-a-day out-of-usage notification.
    assert_eq!(
        skip_notify_class(&skip_record("limited", true)),
        Some(NotifyClass::OutOfUsage),
        "an all-out-of-usage limited skip must notify as out of usage"
    );
    // And it changes ONLY that row: the engine writes the field on `limited` alone, and a stray
    // flag on any other reason (or an unknown one) must not re-class it.
    for (reason, class) in expected.iter().filter(|(r, _)| *r != "limited") {
        assert_eq!(
            skip_notify_class(&skip_record(reason, true)),
            *class,
            "allOutOfUsage re-classed {reason}"
        );
    }
    assert_eq!(skip_notify_class(&skip_record("something-new", true)), None);
}

/// The new class's metadata: the Today route (the screen that shows the engine's out-of-usage
/// line), its wire spelling for `notify_status`'s suppression record, and the same spelling from
/// serde (the suppression log and `Notification` both serialise the class).
#[test]
fn the_out_of_usage_class_routes_to_today_and_is_spelled_out_of_usage() {
    assert_eq!(NotifyClass::OutOfUsage.route(), "today");
    assert_eq!(NotifyClass::OutOfUsage.as_str(), "out-of-usage");
    assert_eq!(
        serde_json::to_value(NotifyClass::OutOfUsage).expect("serialises"),
        json!("out-of-usage")
    );
}

/// Through the machine, from the WIRE: `status --json`'s `lastSkip.allOutOfUsage` reaches both
/// `facts_of` sites (the phase-derived skip fact and the raw priming key) as the out-of-usage
/// class, and a fresh transition fires exactly one `OutOfUsage` firing carrying the engine's
/// detail. A plain `limited` (no field — every older engine, whose `limited` includes the "next
/// tick uses another account" case) yields no fact and no firing.
#[test]
fn an_all_out_of_usage_skip_fires_out_of_usage_and_a_plain_limited_stays_silent() {
    let facts = facts_of(&out_of_usage_snapshot(
        "2026-09-17",
        Some(OUT_OF_USAGE_DETAIL),
    ));
    assert_eq!(
        facts.skip.as_ref().map(|s| s.class),
        Some(NotifyClass::OutOfUsage),
        "{facts:?}"
    );
    assert_eq!(
        facts.raw_skip_key,
        Some((NotifyClass::OutOfUsage, "2026-09-17".to_string()))
    );

    let mut machine = Observation::default();
    assert_eq!(
        machine.observe(&facts_of(&waiting_snapshot("2026-09-17", None))),
        vec![]
    );
    let firings = machine.observe(&facts);
    assert_eq!(
        firings,
        vec![Firing::Skip {
            class: NotifyClass::OutOfUsage,
            date: "2026-09-17".into(),
            detail: Some(OUT_OF_USAGE_DETAIL.into()),
            reason: "limited".into(),
        }]
    );
    // Repeated ticks on the same date: the per-(class, date) dedupe holds.
    for _ in 0..3 {
        assert_eq!(
            machine.observe(&facts),
            vec![],
            "a repeated all-out tick fired"
        );
    }

    // A plain `limited`, same day, same detail text: silence at both sites.
    let plain = facts_of(&skipped_snapshot(
        "2026-09-17",
        "limited",
        Some(OUT_OF_USAGE_DETAIL),
        None,
    ));
    assert_eq!(plain.skip, None, "{plain:?}");
    assert_eq!(plain.raw_skip_key, None, "{plain:?}");
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot("2026-09-17", None)));
    assert_eq!(machine.observe(&plain), vec![]);
}

/// The body is the engine's detail's FIRST line (`notification_line`), the title is the fixed
/// "No briefing yet today", and the click lands on Today. With no detail at all (no engine writes
/// that, but the record's `detail` is optional) the body still says out of usage — never that the
/// run failed.
#[test]
fn the_out_of_usage_body_is_the_details_first_line() {
    let n = build_notification(
        &Firing::Skip {
            class: NotifyClass::OutOfUsage,
            date: "2026-09-17".into(),
            detail: Some(OUT_OF_USAGE_DETAIL.into()),
            reason: "limited".into(),
        },
        None,
    );
    assert_eq!(n.class, NotifyClass::OutOfUsage);
    assert_eq!(n.title, "No briefing yet today");
    assert_eq!(n.body, OUT_OF_USAGE_BODY, "first line only");
    assert_eq!(n.route, "today");

    for detail in [None, Some(""), Some("\nsecond line only")] {
        let n = build_notification(
            &Firing::Skip {
                class: NotifyClass::OutOfUsage,
                date: "2026-09-17".into(),
                detail: detail.map(str::to_string),
                reason: "limited".into(),
            },
            None,
        );
        assert_eq!(n.title, "No briefing yet today");
        // EXACTLY the engine's no-time line (pinned against `src/failover.ts` below), so the
        // fallback can neither name a time nor drift into "tomorrow" or "failed" (carried L2).
        assert_eq!(n.body, OUT_OF_USAGE_FALLBACK_BODY, "detail={detail:?}");
    }
    assert!(
        OUT_OF_USAGE_FALLBACK_BODY.contains("out of usage")
            && !OUT_OF_USAGE_FALLBACK_BODY.to_lowercase().contains("fail")
    );
}

/// The no-detail fallback is the ENGINE's `outOfUsageLine` with no reset time
/// (`src/failover.ts`): read as text, the template's one `${when}` substituted with "" — the
/// engine drops "until <time>" exactly that way when it parsed none. A change to the engine's
/// wording fails here until the app's copy follows.
#[test]
fn the_out_of_usage_fallback_is_the_engines_line_without_a_time() {
    let failover = std::fs::read_to_string(engine_root().join("src/failover.ts"))
        .expect("src/failover.ts is readable");
    let start = failover
        .find("export function outOfUsageLine(")
        .expect("the engine's outOfUsageLine moved or was renamed — re-pin the fallback");
    let body = &failover[start..];
    let open = body
        .find("return `")
        .expect("outOfUsageLine returns a template")
        + "return `".len();
    let close = open + body[open..].find('`').expect("the template closes");
    let template = &body[open..close];
    assert_eq!(
        template.matches("${").count(),
        1,
        "the template gained an interpolation — {template}"
    );
    assert_eq!(template.replace("${when}", ""), OUT_OF_USAGE_FALLBACK_BODY);
}

/// End to end through `AppState::changed` (the literal shipping sink), opted in: one banner for
/// the day's all-out-of-usage skip, however many ticks rewrite the record.
#[test]
fn an_all_out_of_usage_skip_posts_once_through_the_shipping_sink() {
    let scratch = ScratchDir::new("notify-out-of-usage");
    let store = scratch.join("app-data");
    write_record(
        &store,
        &NotifyRecord {
            enabled: Some(true),
        },
    )
    .expect("record written");
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&store),
    ));
    let sink = AppState::new(app.handle().clone());
    sink.changed(&waiting_snapshot("2026-09-17", None));
    for _ in 0..3 {
        sink.changed(&out_of_usage_snapshot(
            "2026-09-17",
            Some(OUT_OF_USAGE_DETAIL),
        ));
    }
    let posted = recorder.posted();
    assert_eq!(posted.len(), 1, "one banner per (class, date): {posted:?}");
    assert_eq!(posted[0].class, NotifyClass::OutOfUsage);
    assert_eq!(posted[0].title, "No briefing yet today");
    assert_eq!(posted[0].body, OUT_OF_USAGE_BODY);
    assert_eq!(posted[0].route, "today");
}

/// And through the whole machine: a never-notify skip produces NO firing even as a fresh
/// transition — not merely a different class.
#[test]
fn never_notify_reasons_fire_nothing_through_the_machine() {
    for reason in ["offline", "darkwake", "concurrent", "limited"] {
        let mut machine = Observation::default();
        assert_eq!(
            machine.observe(&facts_of(&waiting_snapshot("2026-09-17", None))),
            vec![]
        );
        let firings = machine.observe(&facts_of(&skipped_snapshot(
            "2026-09-17",
            reason,
            Some("detail"),
            None,
        )));
        assert_eq!(firings, vec![], "{reason} must never notify");
    }
    // `already-ran`/`below-floor`/`no-config`/`config-error` never even reach `Phase::Skipped`
    // (they are `derive`'s noise set or their own phases) — assert the facts carry no skip.
    for reason in ["already-ran", "below-floor", "no-config", "config-error"] {
        let facts = facts_of(&skipped_snapshot("2026-09-17", reason, None, None));
        assert_eq!(facts.skip, None, "{reason} reached the facts as a skip");
    }
}

/* ── the transition machine ───────────────────────────────────────────────────────────────────── */

/// App start over an already-delivered day: absorbed, not fired — and the watcher double-fire
/// (the same delivered snapshot again) stays silent.
#[test]
fn a_delivery_that_predates_the_app_is_absorbed_and_never_fires() {
    let mut machine = Observation::default();
    let first = facts_of(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    ));
    assert_eq!(machine.observe(&first), vec![]);
    for _ in 0..5 {
        assert_eq!(machine.observe(&first), vec![], "a re-announcement fired");
    }
}

/// THE DEGRADED-PRIMER REGRESSION (round 1 HIGH, reproduced through the shipping sink): the
/// watcher deliberately announces every failing retry attempt, and a failed `status --json` read
/// is `Snapshot::unavailable` — empty facts. If THAT primes the machine, the first GOOD snapshot
/// of an already-delivered morning satisfies both fire conditions (baseline `None`, no fired
/// dates) and a briefing delivered hours before launch posts as news; the stale FAILED banner is
/// the same hole. A status-free snapshot must never be the absorption baseline: the first
/// status-BEARING snapshot is, and it absorbs.
#[test]
fn a_degraded_first_snapshot_never_primes_the_machine() {
    // The machine, directly: unavailable → good delivered = absorbed, silent — and still primed
    // properly, so a LATER real delivery (new date, changed mtime) fires.
    let mut machine = Observation::default();
    assert_eq!(
        machine.observe(&facts_of(&Snapshot::unavailable("sidecar missing"))),
        vec![]
    );
    assert_eq!(
        machine.observe(&facts_of(&Snapshot::unavailable("still missing"))),
        vec![],
        "every failing retry is announced; none may prime"
    );
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T07:24:00Z",
            None,
            None,
        ))),
        vec![],
        "a briefing delivered before the app could read anything fired as news"
    );
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-18",
            "2026-09-18T07:22:00Z",
            None,
            None,
        ))),
        vec![Firing::Delivered {
            date: "2026-09-18".into()
        }],
        "the machine must still be primed by the first status-bearing snapshot"
    );

    // A skip already on file behind a degraded first read is absorbed the same way. The app's
    // clock is a day past the record: since P3-M5-T2 only an EARLIER day's FAILED record is
    // absorbed (today's, unannounced, fires — `a_failure_fires_once_per_day_and_…`).
    let mut machine = Observation::default();
    machine.observe(&on("2026-09-18", &Snapshot::unavailable("boom")));
    assert_eq!(
        machine.observe(&on(
            "2026-09-18",
            &skipped_snapshot("2026-09-17", "provider-fail", Some("E529"), None),
        )),
        vec![],
        "a stale FAILED banner fired through the degraded primer"
    );

    // And through the LITERAL shipping sink, opted in: the reproduction's exact sequence.
    let scratch = ScratchDir::new("notify-degraded-primer");
    let store = scratch.join("app-data");
    write_record(
        &store,
        &NotifyRecord {
            enabled: Some(true),
        },
    )
    .expect("record written");
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&store),
    ));
    let sink = AppState::new(app.handle().clone());
    sink.changed(&Snapshot::unavailable("engine not up yet"));
    sink.changed(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    ));
    assert_eq!(
        recorder.posted(),
        vec![],
        "the degraded-primer sequence posted through the shipping sink"
    );
}

/// KILLS MUTANT M7 (round 1: the priming branch drops the delivered-date record — it survived
/// because every absorbed-then-reobserved fixture kept the same mtime, so the mtime half hid the
/// missing date half): after absorbing an already-delivered morning, a same-day mtime change (a
/// `--force` regenerate) must STILL be silent — the date was absorbed, not just the mtime.
#[test]
fn absorption_records_the_delivered_date_not_only_the_mtime() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    )));
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T09:00:00Z",
            None,
            None,
        ))),
        vec![],
        "an absorbed day re-fired on a same-day regenerate — absorption lost the date"
    );
}

/// ROUND 2's MED — the content-free primer was not only `Snapshot::unavailable`. A WELL-FORMED
/// payload can carry `latestBriefingMtime: null` (the engine derives it as
/// `stat(...).catch(() => null)` — `src/json.ts` — so a user-deleted `briefing-latest.md` or a
/// transient stat failure is `null` inside a valid payload) while scheduler trouble shadows the
/// derived phase (deviation 121), leaving the phase-gated facts EMPTY. Priming from those facts
/// absorbed nothing, and the next good snapshot fired a delivery that predates the app — the
/// round-1 HIGH's symptom through a status-bearing snapshot. Absorption must read the RAW
/// `lastRunDate`. The verifier's sequence (a), plus (c): the next day still fires.
#[test]
fn a_shadowed_phase_primer_absorbs_the_raw_run_date() {
    let primer = broken_scheduler_snapshot(
        "2026-09-17",
        status_payload(Some("2026-09-17"), None, None, None, None),
    );
    assert_eq!(
        primer.schedule_state.as_ref().map(|s| &s.phase),
        Some(&Phase::SchedulerBroken),
        "the fixture no longer derives the shadowed phase — this pin would be vacuous"
    );
    let facts = facts_of(&primer);
    assert_eq!(
        facts.delivered_date, None,
        "the phase-gated fact must be shadowed for this pin to mean anything"
    );
    assert_eq!(facts.last_run_date.as_deref(), Some("2026-09-17"));

    let mut machine = Observation::default();
    assert_eq!(machine.observe(&facts), vec![]);
    // (a) the next good snapshot of the SAME morning: absorbed, not news.
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T07:24:00Z",
            None,
            None,
        ))),
        vec![],
        "a delivery that predates the app fired through a status-bearing primer"
    );
    // (c) the NEXT day's genuine delivery still fires — absorption recorded a date, not a gag.
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-18",
            "2026-09-18T07:22:00Z",
            None,
            None,
        ))),
        vec![Firing::Delivered {
            date: "2026-09-18".into()
        }]
    );

    // And through the LITERAL shipping sink, opted in — where the verifier reproduced it.
    let scratch = ScratchDir::new("notify-shadowed-primer");
    let store = scratch.join("app-data");
    write_record(
        &store,
        &NotifyRecord {
            enabled: Some(true),
        },
    )
    .expect("record written");
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&store),
    ));
    let sink = AppState::new(app.handle().clone());
    sink.changed(&broken_scheduler_snapshot(
        "2026-09-17",
        status_payload(Some("2026-09-17"), None, None, None, None),
    ));
    sink.changed(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    ));
    assert_eq!(
        recorder.posted(),
        vec![],
        "the shadowed-phase primer sequence posted through the shipping sink"
    );
}

/// ROUND 2's second content-free shape, the verifier's sequence (b): every `StatusView` field is
/// `#[serde(default)]` (the frozen-envelope robustness rule), so `{}` PARSES — and it carries
/// nothing: no run date, no mtime, no paths. It must wait exactly as `Snapshot::unavailable`
/// waits; the first STRUCTURALLY REAL payload (one reporting `paths.stateDir`, which the engine
/// emits unconditionally) is the one that absorbs.
#[test]
fn a_content_free_status_object_cannot_prime() {
    let empty = snapshot("2026-09-17", json!({}));
    assert!(
        !facts_of(&empty).has_status,
        "`{{}}` must not count as a structurally real status payload"
    );

    let mut machine = Observation::default();
    assert_eq!(machine.observe(&facts_of(&empty)), vec![]);
    // (b) the next good snapshot of an already-delivered morning primes-and-absorbs: ZERO posts.
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T07:24:00Z",
            None,
            None,
        ))),
        vec![],
        "a `{{}}` primer let an already-delivered morning fire as news"
    );
    // (c) a genuine NEW delivery after such a primer still fires.
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-18",
            "2026-09-18T07:22:00Z",
            None,
            None,
        ))),
        vec![Firing::Delivered {
            date: "2026-09-18".into()
        }]
    );

    // And the machine is not merely deaf after a `{}`: a real waiting payload primes, and the
    // delivery it then OBSERVES fires.
    let mut machine = Observation::default();
    machine.observe(&facts_of(&snapshot("2026-09-17", json!({}))));
    assert_eq!(
        machine.observe(&facts_of(&waiting_snapshot(
            "2026-09-17",
            Some("2026-09-16T07:24:00Z")
        ))),
        vec![]
    );
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T07:24:00Z",
            None,
            None,
        ))),
        vec![Firing::Delivered {
            date: "2026-09-17".into()
        }]
    );
}

/// The FAILED half of the same round-2 hole, INVERTED for today's date by P3-M5-T2 (spec r9 §5,
/// requirement 11). `Phase::Skipped` is shadowed by the scheduler-trouble phases, so priming
/// reads the RAW `last-skip` record — and since FAILED is exempt from start-up absorption for
/// TODAY's local date, a primer carrying today's failure leaves it UNABSORBED: once the scheduler
/// is repaired and the record surfaces as `Phase::Skipped`, the failure fires once (opening the
/// app late must not miss the day's failure). A record from an EARLIER day is still absorbed
/// from the raw evidence, whatever the derived phase says.
#[test]
fn a_shadowed_phase_primer_absorbs_only_an_earlier_days_failure() {
    let primer = broken_scheduler_snapshot(
        "2026-09-17",
        status_payload(
            None,
            None,
            Some(("provider-fail", "2026-09-17", Some("E529"))),
            None,
            None,
        ),
    );
    assert_eq!(
        primer.schedule_state.as_ref().map(|s| &s.phase),
        Some(&Phase::SchedulerBroken),
        "the fixture no longer derives the shadowed phase — this pin would be vacuous"
    );
    let facts = on("2026-09-17", &primer);
    assert_eq!(
        facts.skip, None,
        "the phase-gated skip must be shadowed for this pin to mean anything"
    );
    assert_eq!(
        facts.raw_skip_key,
        Some((NotifyClass::Failed, "2026-09-17".to_string()))
    );

    // TODAY's failure behind a shadowed primer: not absorbed; it fires once the phase surfaces.
    let mut machine = Observation::default();
    assert_eq!(machine.observe(&facts), vec![]);
    let repaired = on(
        "2026-09-17",
        &skipped_snapshot("2026-09-17", "provider-fail", Some("E529"), None),
    );
    assert_eq!(
        machine.observe(&repaired),
        vec![Firing::Skip {
            class: NotifyClass::Failed,
            date: "2026-09-17".into(),
            detail: Some("E529".into()),
            reason: "provider-fail".into(),
        }],
        "today's unannounced failure was absorbed by a shadowed-phase primer"
    );
    assert_eq!(machine.observe(&repaired), vec![], "once per day");

    // An EARLIER day's failure (the app's clock already says 09-18): absorbed from the raw key.
    let mut machine = Observation::default();
    assert_eq!(machine.observe(&on("2026-09-18", &primer)), vec![]);
    assert_eq!(
        machine.observe(&on(
            "2026-09-18",
            &skipped_snapshot("2026-09-17", "provider-fail", Some("E529"), None),
        )),
        vec![],
        "an earlier day's failure fired through the shadowed-phase primer"
    );
    // A NEW day's failure still fires.
    let firings = machine.observe(&on(
        "2026-09-18",
        &skipped_snapshot("2026-09-18", "provider-fail", Some("E530"), None),
    ));
    assert_eq!(firings.len(), 1, "{firings:?}");
    assert_eq!(firings[0].class(), NotifyClass::Failed);
}

/// KILLS MUTANT M8 (round 1: dropping the `briefing_mtime.is_some()` guard — it survived because
/// the only no-mtime fixture also had a `None` baseline): with a REAL baseline held, a delivered
/// flip whose snapshot reports NO mtime cannot confirm the "briefing changed" half and must stay
/// silent — `None != Some(baseline)` is missing evidence, not a change.
#[test]
fn a_missing_mtime_is_not_a_briefing_change_even_against_a_real_baseline() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot(
        "2026-09-17",
        Some("2026-09-16T07:24:00Z"),
    )));
    let status = status_payload(Some("2026-09-17"), None, None, None, None);
    assert_eq!(
        machine.observe(&facts_of(&snapshot("2026-09-17", status))),
        vec![],
        "a flip with no mtime fired against a Some baseline"
    );
}

/// The ordinary morning: the app was open and waiting, the delivery lands (briefing write and
/// stamp in ONE batch) — exactly one firing, and four rapid re-announcements stay deduped.
#[test]
fn an_observed_delivery_fires_once_with_the_run_date_as_the_dedupe_key() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot(
        "2026-09-17",
        Some("2026-09-16T07:24:00Z"),
    )));
    let delivered = facts_of(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    ));
    assert_eq!(
        machine.observe(&delivered),
        vec![Firing::Delivered {
            date: "2026-09-17".into()
        }]
    );
    for _ in 0..4 {
        assert_eq!(
            machine.observe(&delivered),
            vec![],
            "the dedupe key did not hold"
        );
    }
    // A `--force` regenerate later the same day changes the mtime but not the date: still silent.
    let regenerated = facts_of(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T09:00:00Z",
        None,
        None,
    ));
    assert_eq!(
        machine.observe(&regenerated),
        vec![],
        "same-day regenerate re-notified"
    );
}

/// The measured two-batch delivery (`watcher.rs`: the delivering tick's writes land more than the
/// 1 s ceiling apart): batch 1 changes the briefing while the day is still unstamped, batch 2
/// flips `last-run`. The flip batch must fire although ITS mtime equals the previous batch's.
#[test]
fn a_two_batch_delivery_fires_on_the_flip_batch() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot(
        "2026-09-17",
        Some("2026-09-16T07:24:00Z"),
    )));
    // Batch 1: the briefing file changed; not delivered yet. No firing.
    assert_eq!(
        machine.observe(&facts_of(&waiting_snapshot(
            "2026-09-17",
            Some("2026-09-17T07:24:01Z")
        ))),
        vec![]
    );
    // Batch 2: the stamp. The mtime is batch 1's — the baseline must still be the PRE-delivery
    // one, or this fires nothing.
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T07:24:01Z",
            None,
            None,
        ))),
        vec![Firing::Delivered {
            date: "2026-09-17".into()
        }]
    );
}

/// The "BOTH halves" rule: a delivered phase whose briefing mtime never changed from the baseline
/// (or is absent) does not fire.
#[test]
fn a_flip_without_an_observed_briefing_change_stays_silent() {
    // mtime unchanged across the flip (the app started between the write and the stamp — the
    // documented absorption cost).
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot(
        "2026-09-17",
        Some("2026-09-17T07:24:00Z"),
    )));
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-17",
            "2026-09-17T07:24:00Z",
            None,
            None,
        ))),
        vec![]
    );
    // No mtime at all: the "briefing changed" half cannot be confirmed.
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot("2026-09-17", None)));
    let status = status_payload(Some("2026-09-17"), None, None, None, None);
    assert_eq!(
        machine.observe(&facts_of(&snapshot("2026-09-17", status))),
        vec![]
    );
}

/// Midnight: tomorrow's delivery is a new date and fires again.
#[test]
fn the_next_day_fires_again() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    )));
    assert_eq!(
        machine.observe(&facts_of(&delivered_snapshot(
            "2026-09-18",
            "2026-09-18T07:22:00Z",
            None,
            None,
        ))),
        vec![Firing::Delivered {
            date: "2026-09-18".into()
        }]
    );
}

/// A failure skip fires once per (class, date): the engine rewrites `last-skip.json` on every
/// tick of a failing morning (a new `iso` each time), and 144 banners a day is the thing the
/// dedupe exists to prevent. At startup (INVERTED by P3-M5-T2, spec r9 §5 requirement 11), a
/// failure already on file for TODAY with no persisted firing fires once — FAILED is exempt from
/// start-up absorption for today's date — while an EARLIER day's record is absorbed.
#[test]
fn a_failure_fires_once_per_day_and_startup_fires_only_todays_unannounced_one() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot("2026-09-17", None)));
    let firings = machine.observe(&facts_of(&skipped_snapshot(
        "2026-09-17",
        "provider-fail",
        Some("E529: overloaded"),
        None,
    )));
    assert_eq!(
        firings,
        vec![Firing::Skip {
            class: NotifyClass::Failed,
            date: "2026-09-17".into(),
            detail: Some("E529: overloaded".into()),
            reason: "provider-fail".into(),
        }]
    );
    // Later ticks rewrite the record (new iso, same day, same reason — or even another FAILED
    // reason: the class fired today).
    for reason in ["provider-fail", "crashed"] {
        assert_eq!(
            machine.observe(&facts_of(&skipped_snapshot(
                "2026-09-17",
                reason,
                Some("later detail"),
                None,
            ))),
            vec![],
            "{reason} re-fired within the day"
        );
    }
    // BLOCKED is its own class and still fires today.
    let firings = machine.observe(&facts_of(&skipped_snapshot(
        "2026-09-17",
        "blocked",
        None,
        None,
    )));
    assert_eq!(firings.len(), 1, "{firings:?}");
    assert_eq!(firings[0].class(), NotifyClass::Blocked);

    // Startup on the SAME day: a fresh machine over today's failure fires it, once.
    let todays = on(
        "2026-09-17",
        &skipped_snapshot(
            "2026-09-17",
            "provider-fail",
            Some("E529: overloaded"),
            None,
        ),
    );
    let mut fresh = Observation::default();
    assert_eq!(
        fresh.observe(&todays),
        vec![Firing::Skip {
            class: NotifyClass::Failed,
            date: "2026-09-17".into(),
            detail: Some("E529: overloaded".into()),
            reason: "provider-fail".into(),
        }],
        "opening the app after today's failure must announce it"
    );
    for _ in 0..3 {
        assert_eq!(fresh.observe(&todays), vec![], "re-fired within the day");
    }

    // An EARLIER day's record (the app's clock is a day past the snapshot's) is absorbed.
    let mut later = Observation::default();
    let earlier = on(
        "2026-09-18",
        &skipped_snapshot(
            "2026-09-17",
            "provider-fail",
            Some("E529: overloaded"),
            None,
        ),
    );
    assert_eq!(later.observe(&earlier), vec![]);
    assert_eq!(later.observe(&earlier), vec![]);

    // No clock at all (an empty local date): nothing can be called today, so it absorbs.
    let mut unclocked = Observation::default();
    assert_eq!(
        unclocked.observe(&facts_of(&skipped_snapshot(
            "2026-09-17",
            "provider-fail",
            Some("E529: overloaded"),
            None,
        ))),
        vec![]
    );
}

/// A failed morning then a successful retry: FAILED fires, then DELIVERED fires — an honest
/// sequence, not a contradiction.
#[test]
fn a_failure_then_a_delivery_both_fire() {
    let mut machine = Observation::default();
    machine.observe(&facts_of(&waiting_snapshot(
        "2026-09-17",
        Some("2026-09-16T07:24:00Z"),
    )));
    assert_eq!(
        machine
            .observe(&facts_of(&skipped_snapshot(
                "2026-09-17",
                "provider-fail",
                Some("E529"),
                Some("2026-09-16T07:24:00Z"),
            )))
            .len(),
        1
    );
    let firings = machine.observe(&facts_of(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:40:00Z",
        None,
        None,
    )));
    assert_eq!(
        firings,
        vec![Firing::Delivered {
            date: "2026-09-17".into()
        }]
    );
}

/* ── once a day, across restarts (P3-M5-T2, spec r9 §5 requirement 11) ──────────────────────── */

/// Requirement 11: "one notification per state per day … when the app opens after the state
/// began". Opening the app after today's first all-out-of-usage tick fires `OutOfUsage` ONCE, and
/// opening it after today's first mixed-state tick (out of usage plus paused after failures — the
/// engine's `provider-fail`, step 7 row 3) fires FAILED once: both classes skip start-up
/// absorption for today's date. Behind a shadowed primer too. An earlier day's record is absorbed.
#[test]
fn opening_the_app_after_todays_first_all_out_or_mixed_state_tick_fires_once() {
    let all_out = on(
        "2026-09-17",
        &out_of_usage_snapshot("2026-09-17", Some(OUT_OF_USAGE_DETAIL)),
    );
    let mut machine = Observation::default();
    assert_eq!(
        machine.observe(&all_out),
        vec![Firing::Skip {
            class: NotifyClass::OutOfUsage,
            date: "2026-09-17".into(),
            detail: Some(OUT_OF_USAGE_DETAIL.into()),
            reason: "limited".into(),
        }],
        "the app opened after today's first all-out tick and stayed silent"
    );
    for _ in 0..3 {
        assert_eq!(
            machine.observe(&all_out),
            vec![],
            "a repeated all-out tick fired"
        );
    }

    let mixed = on(
        "2026-09-17",
        &skipped_snapshot(
            "2026-09-17",
            "provider-fail",
            Some("every provider failed or is out of usage"),
            None,
        ),
    );
    let mut machine = Observation::default();
    let firings = machine.observe(&mixed);
    assert_eq!(firings.len(), 1, "{firings:?}");
    assert_eq!(firings[0].class(), NotifyClass::Failed);
    assert_eq!(machine.observe(&mixed), vec![]);

    // A shadowed-phase primer carrying today's all-out record leaves it unabsorbed too.
    let mut status = status_payload(
        None,
        None,
        Some(("limited", "2026-09-17", Some(OUT_OF_USAGE_DETAIL))),
        None,
        None,
    );
    status["lastSkip"]["allOutOfUsage"] = json!(true);
    let primer = on(
        "2026-09-17",
        &broken_scheduler_snapshot("2026-09-17", status),
    );
    assert_eq!(
        primer.raw_skip_key,
        Some((NotifyClass::OutOfUsage, "2026-09-17".to_string()))
    );
    let mut machine = Observation::default();
    assert_eq!(machine.observe(&primer), vec![]);
    assert_eq!(
        machine.observe(&all_out).len(),
        1,
        "fires once the phase surfaces"
    );

    // An EARLIER day's all-out record is absorbed, as every class's is.
    let earlier = on(
        "2026-09-18",
        &out_of_usage_snapshot("2026-09-17", Some(OUT_OF_USAGE_DETAIL)),
    );
    let mut machine = Observation::default();
    assert_eq!(machine.observe(&earlier), vec![]);
    assert_eq!(machine.observe(&earlier), vec![]);
}

/// DELIVERED and BLOCKED keep today's start-up absorption: a briefing delivered before the app
/// opened, or a run blocked before it, is furniture, not news — even with the app's clock on that
/// very day, and even behind a shadowed primer.
#[test]
fn delivered_and_blocked_keep_todays_startup_absorption() {
    let mut machine = Observation::default();
    assert_eq!(
        machine.observe(&on(
            "2026-09-17",
            &delivered_snapshot("2026-09-17", "2026-09-17T07:24:00Z", None, None),
        )),
        vec![]
    );
    assert_eq!(
        machine.observe(&on(
            "2026-09-17",
            &delivered_snapshot("2026-09-17", "2026-09-17T09:00:00Z", None, None),
        )),
        vec![],
        "today's absorbed delivery fired on a same-day regenerate"
    );

    let blocked = on(
        "2026-09-17",
        &skipped_snapshot("2026-09-17", "blocked", None, None),
    );
    let mut machine = Observation::default();
    assert_eq!(
        machine.observe(&blocked),
        vec![],
        "today's BLOCKED escaped absorption"
    );
    assert_eq!(machine.observe(&blocked), vec![]);

    let mut machine = Observation::default();
    machine.observe(&on(
        "2026-09-17",
        &broken_scheduler_snapshot(
            "2026-09-17",
            status_payload(
                None,
                None,
                Some(("blocked", "2026-09-17", None)),
                None,
                None,
            ),
        ),
    ));
    assert_eq!(
        machine.observe(&blocked),
        vec![],
        "a shadowed BLOCKED primer was not absorbed"
    );
}

/// The persisted map seeds the machine: a persisted date blocks a second firing of that class
/// for that date (FAILED and `OutOfUsage` would otherwise escape absorption at start), an EARLIER
/// persisted date blocks nothing, and at load the LATER of the persisted and the primer's absorbed
/// date wins, per class, in both directions.
#[test]
fn a_seeded_date_blocks_its_class_and_the_later_date_wins_at_load() {
    let mut machine = Observation::default();
    assert!(!machine.is_seeded());
    machine.seed(dates(&[
        (NotifyClass::Failed, "2026-09-17"),
        (NotifyClass::OutOfUsage, "2026-09-17"),
    ]));
    assert!(machine.is_seeded());
    assert_eq!(
        machine.observe(&on(
            "2026-09-17",
            &skipped_snapshot("2026-09-17", "provider-fail", Some("E529"), None),
        )),
        vec![],
        "a persisted FAILED firing repeated after the restart"
    );
    assert_eq!(
        machine.observe(&on(
            "2026-09-17",
            &out_of_usage_snapshot("2026-09-17", Some(OUT_OF_USAGE_DETAIL)),
        )),
        vec![],
        "a persisted OutOfUsage firing repeated after the restart"
    );

    let mut machine = Observation::default();
    machine.seed(dates(&[(NotifyClass::Failed, "2026-09-16")]));
    assert_eq!(
        machine
            .observe(&on(
                "2026-09-17",
                &skipped_snapshot("2026-09-17", "provider-fail", Some("E529"), None),
            ))
            .len(),
        1,
        "yesterday's persisted firing blocked today's"
    );

    // Later wins at load: persisted DELIVERED (today's, so not a future date the load discards)
    // is later than the primer's run date; persisted BLOCKED is earlier than the primer's record.
    let mut machine = Observation::default();
    machine.seed(dates(&[
        (NotifyClass::Delivered, "2026-09-18"),
        (NotifyClass::Blocked, "2026-09-16"),
    ]));
    machine.observe(&on(
        "2026-09-18",
        &snapshot(
            "2026-09-18",
            status_payload(
                Some("2026-09-17"),
                Some("2026-09-17T07:24:00Z"),
                Some(("blocked", "2026-09-17", None)),
                None,
                None,
            ),
        ),
    ));
    assert_eq!(
        machine.fired(),
        &dates(&[
            (NotifyClass::Delivered, "2026-09-18"),
            (NotifyClass::Blocked, "2026-09-17"),
        ]),
        "at load the later of the persisted and the absorbed date must win per class"
    );
    // And for the raw SKIP key too: a persisted BLOCKED date (today's) later than the primer's
    // record holds.
    let mut machine = Observation::default();
    machine.seed(dates(&[(NotifyClass::Blocked, "2026-09-18")]));
    machine.observe(&on(
        "2026-09-18",
        &skipped_snapshot("2026-09-17", "blocked", None, None),
    ));
    assert_eq!(
        machine.fired(),
        &dates(&[(NotifyClass::Blocked, "2026-09-18")]),
        "the primer's earlier skip key overwrote a later persisted date"
    );
}

/// P3-M5 checkpoint L2 (hub, 2026-10-18): at load, a persisted date LATER than the app's today
/// is discarded before "later wins" runs — dates only increase in normal running, so a future
/// date means the clock or the time zone moved backwards. Kept, it knocked out today's start-up
/// absorption for BLOCKED and DELIVERED (the reviewer's probe: a block that predates the app
/// fired once a shadowed phase surfaced it). A future FAILED date does not suppress today's
/// FAILED, a non-future persisted date still wins (the test above), and with no today nothing
/// is discarded.
#[test]
fn a_future_persisted_date_is_discarded_at_load() {
    let d = "2026-09-17";
    let blocked_primer = on(
        d,
        &broken_scheduler_snapshot(
            d,
            status_payload(None, None, Some(("blocked", d, None)), None, None),
        ),
    );
    let blocked = on(d, &skipped_snapshot(d, "blocked", None, None));

    // The reviewer's probe.
    let mut machine = Observation::default();
    machine.seed(dates(&[(NotifyClass::Blocked, "2026-09-18")]));
    assert_eq!(machine.observe(&blocked_primer), vec![]);
    assert_eq!(
        machine.observe(&blocked),
        vec![],
        "a future persisted BLOCKED date let a block that predates the app fire"
    );
    assert_eq!(machine.fired(), &dates(&[(NotifyClass::Blocked, d)]));

    // DELIVERED, on a same-day regenerate.
    let mut machine = Observation::default();
    machine.seed(dates(&[(NotifyClass::Delivered, "2026-09-18")]));
    assert_eq!(
        machine.observe(&on(
            d,
            &delivered_snapshot(d, "2026-09-17T07:24:00Z", None, None)
        )),
        vec![]
    );
    assert_eq!(
        machine.observe(&on(
            d,
            &delivered_snapshot(d, "2026-09-17T09:00:00Z", None, None)
        )),
        vec![],
        "a future persisted DELIVERED date let a delivery that predates the app fire"
    );

    // A future FAILED date does not suppress today's FAILED: it fires once.
    let failed = on(d, &skipped_snapshot(d, "provider-fail", Some("E529"), None));
    let mut machine = Observation::default();
    machine.seed(dates(&[(NotifyClass::Failed, "2026-09-18")]));
    assert_eq!(
        machine.observe(&failed).len(),
        1,
        "today's FAILED did not fire"
    );
    assert_eq!(
        machine.observe(&failed),
        vec![],
        "today's FAILED fired twice"
    );

    // No today: nothing is discarded (the behaviour before the rule).
    let mut machine = Observation::default();
    machine.seed(dates(&[(NotifyClass::Blocked, "2026-09-18")]));
    let mut undated = blocked_primer.clone();
    undated.today = None;
    machine.observe(&undated);
    assert_eq!(
        machine.fired(),
        &dates(&[(NotifyClass::Blocked, "2026-09-18")]),
        "with no today a persisted date was discarded"
    );
}

/// Carried L3 (requirement 11's mixed state): `OutOfUsage` and FAILED are SEPARATE dedupe slots on
/// the same day. An all-out firing followed by a `provider-fail` skip on that date is two
/// firings — with no restart between them, and with a restart between them that carries the
/// persisted map. Once both are persisted, neither repeats after another restart.
#[test]
fn out_of_usage_and_failed_keep_separate_slots_on_one_day() {
    let d = "2026-09-17";
    let all_out = on(d, &out_of_usage_snapshot(d, Some(OUT_OF_USAGE_DETAIL)));
    let failed = on(d, &skipped_snapshot(d, "provider-fail", Some("E529"), None));

    // No restart.
    let mut machine = Observation::default();
    machine.observe(&on(d, &waiting_snapshot(d, None)));
    let first = machine.observe(&all_out);
    let second = machine.observe(&failed);
    assert_eq!((first.len(), second.len()), (1, 1), "{first:?} {second:?}");
    assert_eq!(first[0].class(), NotifyClass::OutOfUsage);
    assert_eq!(second[0].class(), NotifyClass::Failed);
    assert_eq!(machine.observe(&all_out), vec![]);
    assert_eq!(machine.observe(&failed), vec![]);

    // A restart between them, carrying the persisted map.
    let mut before = Observation::default();
    before.observe(&on(d, &waiting_snapshot(d, None)));
    assert_eq!(before.observe(&all_out).len(), 1);
    let mut after = Observation::default();
    after.seed(before.fired().clone());
    let firings = after.observe(&failed);
    assert_eq!(
        firings.len(),
        1,
        "the persisted OutOfUsage slot blocked FAILED: {firings:?}"
    );
    assert_eq!(firings[0].class(), NotifyClass::Failed);
    assert_eq!(
        after.observe(&all_out),
        vec![],
        "OutOfUsage repeated after the restart"
    );

    // Both persisted: another restart says nothing for either.
    let mut again = Observation::default();
    again.seed(after.fired().clone());
    assert_eq!(again.observe(&all_out), vec![]);
    assert_eq!(again.observe(&failed), vec![]);
}

/* ── the bodies, and §5's boundary ────────────────────────────────────────────────────────────── */

/// `strip_control` is the ENGINE's `stripControl`, read out of `src/render.ts` at test time.
#[test]
fn strip_control_matches_the_engines() {
    let render = std::fs::read_to_string(engine_root().join("src/render.ts"))
        .expect("src/render.ts is readable");
    assert!(
        render.contains(r#"s.replace(/[\x00-\x1f\x7f-\x9f]/g, "")"#),
        "the engine's stripControl changed its class — re-port `notifications::strip_control` \
         and update this pin"
    );
    assert_eq!(strip_control("a\x00b\x1fc\x7fd\u{9f}e"), "abcde");
    assert_eq!(strip_control("plain — text"), "plain — text");
}

/// The resume-extraction prefixes are the engine's own render literals.
#[test]
fn the_resume_prefixes_are_the_engines() {
    let render = std::fs::read_to_string(engine_root().join("src/render.ts"))
        .expect("src/render.ts is readable");
    assert!(
        render.contains("`▶ Where you left off${stamp}`"),
        "the engine's resume heading literal moved — update `first_resume_line`'s prefix"
    );
    assert!(
        render.contains("`   • [${r.repo}] ${r.text}`"),
        "the engine's resume bullet literal moved — update `first_resume_line`'s prefix"
    );
}

/// The first bullet after the heading wins (branch state first is the render's own order);
/// a bulletless morning and a bullet in a LATER section both yield the fallback.
#[test]
fn the_first_resume_line_is_extracted_or_the_fallback_is_used() {
    let briefing = "☀️  Daily briefing — 2026-09-17  (this machine: all)\n\
                    \n\
                    ▶ Where you left off  (first wake past 07:20 · state as of 07:24)\n\
                    \x20\x20\x20• [quant_stocks] main is 2 ahead\n\
                    \x20\x20\x20• [accountant_ai] resume the HITL screen\n\
                    \n\
                    ▶ What you did\n\
                    \x20\x20\x20• [other] not this one\n";
    assert_eq!(
        first_resume_line(briefing).as_deref(),
        Some("[quant_stocks] main is 2 ahead")
    );
    let quiet = "☀️  Daily briefing — 2026-09-17\n\
                 ▶ Where you left off\n\
                 \x20\x20\x20(nothing in progress)\n\
                 ▶ What you did\n\
                 \x20\x20\x20• [other] later section\n";
    assert_eq!(first_resume_line(quiet), None);
    assert_eq!(first_resume_line(""), None);

    // Provider fallback P1-M9-T4: a briefing that OPENS with notice lines (above its title) still yields the resume
    // bullet — the notices start with `ℹ︎ `, never with the `▶ ` heading prefix.
    let with_notices = "ℹ︎ Skipped \"Local\": unreachable — used \"Claude login 2\"\n\
                        ℹ︎ Generated using \"Claude login 2\" — API charges may apply.\n\
                        \n\
                        ☀️  Daily briefing — 2026-10-16  (this machine: all)\n\
                        \n\
                        ▶ Where you left off\n\
                        \x20\x20\x20• [app] resume the walk\n";
    assert_eq!(
        first_resume_line(with_notices).as_deref(),
        Some("[app] resume the walk")
    );

    let n = build_notification(
        &Firing::Delivered {
            date: "2026-09-17".into(),
        },
        Some(quiet),
    );
    assert_eq!(n.body, "Your briefing for 2026-09-17 is ready.");
    assert_eq!(n.title, "Daily briefing — 2026-09-17");
    assert_eq!(n.route, "today");

    // The bullet is user prose in the general case: markdown markers are stripped for the banner
    // (links to their text, bold and inline code to their content), while the engine's own
    // `[repo]` prefix — a bare bracket with no target — and snake_case underscores survive.
    let marked = "☀️  Daily briefing — 2026-09-17\n\
                  ▶ Where you left off\n\
                  \x20\x20\x20• [my_repo] fix `parse_config` in **core**, see [the PR](https://x.example/1)\n";
    assert_eq!(
        first_resume_line(marked).as_deref(),
        Some("[my_repo] fix parse_config in core, see the PR"),
        "markdown residue reached the notification body"
    );
}

/// Nested brackets inside link text (round 2, GE2): the close is the MATCHING bracket, so one
/// level of nesting reduces to the link's text instead of leaving the whole segment
/// unprocessed. A bare `[label]` — including one extracted from `[[foo]](url)` — keeps its
/// brackets (the engine's own `[repo]` prefix shape), and a bracketed label BEFORE an unrelated
/// link is never swallowed into it (the case a first-`](`-scan rewrite would have broken).
#[test]
fn nested_brackets_in_link_text_reduce_to_the_text() {
    assert_eq!(
        strip_markdown_markers("[text with [nested] info](url)"),
        "text with [nested] info"
    );
    assert_eq!(strip_markdown_markers("[[foo]](url)"), "[foo]");
    assert_eq!(strip_markdown_markers("[a] (b) [c](d)"), "[a] (b) c");
    assert_eq!(
        strip_markdown_markers("[my_repo] see [the [draft] PR](https://x.example/1)"),
        "[my_repo] see the [draft] PR"
    );
    // An unbalanced open never forms a link; the complete inner link is still reached.
    assert_eq!(
        strip_markdown_markers("[unclosed nested [x](url)"),
        "[unclosed nested x"
    );
}

/// FAILED carries the engine's literal error line (first line, control-stripped, capped) and
/// routes to Schedule; BLOCKED always has the fixed body (v0.2.1 §2.4.5 — see the test below).
#[test]
fn failure_bodies_relay_the_engines_line_within_the_boundary() {
    let n = build_notification(
        &Firing::Skip {
            class: NotifyClass::Failed,
            date: "2026-09-17".into(),
            detail: Some("ProviderError: overloaded\nstack line two".into()),
            reason: "provider-fail".into(),
        },
        None,
    );
    assert_eq!(n.body, "ProviderError: overloaded", "first line only");
    assert_eq!(n.title, "Briefing failed — 2026-09-17");
    assert_eq!(n.route, "schedule");

    let n = build_notification(
        &Firing::Skip {
            class: NotifyClass::Failed,
            date: "2026-09-17".into(),
            detail: Some("bad\x1b[31mansi\x07".into()),
            reason: "crashed".into(),
        },
        None,
    );
    assert_eq!(
        n.body, "bad[31mansi",
        "control characters must not reach the notifier"
    );

    let n = build_notification(
        &Firing::Skip {
            class: NotifyClass::Blocked,
            date: "2026-09-17".into(),
            detail: None,
            reason: "blocked".into(),
        },
        None,
    );
    assert_eq!(n.body, BLOCKED_BODY);
    assert_eq!(n.title, "Briefing blocked — 2026-09-17");
    assert_eq!(n.route, "schedule");

    let long = "x".repeat(500);
    assert_eq!(notification_line(&long).chars().count(), 180);
    assert!(notification_line(&long).ends_with('…'));
}

/// The Blocked banner's one body, for every blocked skip (v0.2.1 §2.4.5, r5).
const BLOCKED_BODY: &str =
    "A folder or repository could not be read or found, so no briefing was generated. \
     Open the Schedule screen for details.";

/// v0.2.1 §2.4.5 (r5): since v0.2.1 a blocked skip's `detail` is the engine's discovery summary,
/// which NAMES FOLDERS — and an OS notification preview can sit on a lock screen. So the Blocked
/// banner never relays `detail`: the generic body every time, one banner per (class, date) however
/// often the failing morning rewrites the record, and no path from the detail anywhere in it.
/// Driven through `AppState::changed` (the literal shipping sink) with the opt-in on.
#[test]
fn a_blocked_skip_with_a_discovery_summary_posts_the_generic_body_once_per_day_and_no_path() {
    let summary = "No repositories were found in Folders to search. Couldn't read 1 folder \
                   (/Users/me/Documents) because macOS blocked access, so repos in it may be \
                   missing. Allow access in System Settings → Privacy & Security → Files & Folders \
                   (in the app: Schedule → Folder access).";

    // The pure builder: the detail is ignored for BLOCKED, whatever it holds.
    let n = build_notification(
        &Firing::Skip {
            class: NotifyClass::Blocked,
            date: "2026-09-17".into(),
            detail: Some(summary.into()),
            reason: "blocked".into(),
        },
        None,
    );
    assert_eq!(n.body, BLOCKED_BODY);
    assert_eq!(n.title, "Briefing blocked — 2026-09-17");

    // End to end, opted in.
    let scratch = ScratchDir::new("notify-blocked-summary");
    let store = scratch.join("app-data");
    write_record(
        &store,
        &NotifyRecord {
            enabled: Some(true),
        },
    )
    .expect("record written");
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&store),
    ));
    let sink = AppState::new(app.handle().clone());
    // The baseline: absorbed, never fires.
    sink.changed(&waiting_snapshot("2026-09-17", None));
    // The failing morning: a new record every ten-minute tick, the summary re-worded once.
    for detail in [
        summary,
        summary,
        "Couldn't find 1 folder listed in Folders to search (/Users/me/typo).",
    ] {
        sink.changed(&skipped_snapshot(
            "2026-09-17",
            "blocked",
            Some(detail),
            None,
        ));
    }
    let posted = recorder.posted();
    assert_eq!(posted.len(), 1, "one banner per (class, date): {posted:?}");
    assert_eq!(posted[0].class, NotifyClass::Blocked);
    assert_eq!(posted[0].title, "Briefing blocked — 2026-09-17");
    assert_eq!(posted[0].body, BLOCKED_BODY);
    assert_eq!(posted[0].route, "schedule");
    for leak in [
        "/Users/me",
        "Documents",
        "typo",
        "Couldn't",
        "Folders to search",
    ] {
        assert!(
            !posted[0].title.contains(leak) && !posted[0].body.contains(leak),
            "the banner carries {leak:?} from the detail: {:?}",
            posted[0]
        );
    }
    // The next day's blocked morning is a new (class, date): it fires again, still generic.
    sink.changed(&skipped_snapshot(
        "2026-09-18",
        "blocked",
        Some(summary),
        None,
    ));
    let posted = recorder.posted();
    assert_eq!(posted.len(), 2, "{posted:?}");
    assert_eq!(posted[1].title, "Briefing blocked — 2026-09-18");
    assert_eq!(posted[1].body, BLOCKED_BODY);
}

/* ── the ownership predicate, over the shared fixtures ────────────────────────────────────────── */

/// `tests/fixtures/notify_predicate.json` holds `{ platform, os, notify, expected }` rows. The
/// engine spelling (`platform`) is replayed through the REAL `notifyArgv` by
/// `gui/tests-web/notify.check.ts`; the Rust spelling (`os`) is replayed here through the port.
/// One fixture file, two implementations, no drift.
#[test]
fn the_ownership_predicate_matches_the_shared_fixtures() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/notify_predicate.json");
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the fixture file"))
            .expect("the fixture file is JSON");
    assert!(rows.len() >= 12, "the fixture table shrank: {}", rows.len());
    for row in rows {
        let os = row["os"].as_str().expect("an `os` per row");
        let expected = row["expected"].as_bool().expect("an `expected` per row");
        let notify = row.get("notify").filter(|v| !v.is_null());
        assert_eq!(
            engine_will_notify(os, notify),
            expected,
            "os={os} notify={:?}",
            row.get("notify")
        );
    }
    // And the display classification agrees with `resolveNotify`'s shapes.
    assert_eq!(classify_notify(None), "off");
    assert_eq!(classify_notify(Some(&json!(null))), "off");
    assert_eq!(classify_notify(Some(&json!("off"))), "off");
    assert_eq!(classify_notify(Some(&json!("auto"))), "auto");
    assert_eq!(
        classify_notify(Some(&json!({ "command": ["notify-send"] }))),
        "custom"
    );
    assert_eq!(classify_notify(Some(&json!({ "command": [] }))), "invalid");
    assert_eq!(classify_notify(Some(&json!("banner"))), "invalid");
}

/// The engine-mirroring config read (deviation 118). A stow/chezmoi-managed
/// `~/.config/daily-briefing/config.json` is a SYMLINK in ordinary use, and the engine follows it
/// (`Bun.file(...).json()`, `src/config.ts`); a no-follow read here flipped suppression to
/// fail-open "off" while the engine read `"auto"` and posted too — the double notification the
/// predicate exists to prevent. Also pins the absent-vs-unreadable classification from the READ
/// ERROR itself (never a racy post-hoc `exists()`).
#[cfg(unix)]
#[test]
fn a_symlinked_config_is_read_the_way_the_engine_reads_it() {
    use daily_briefing_gui_lib::notifications::{
        read_engine_config_text, read_notify_value, ConfigUnreadable,
    };
    let scratch = ScratchDir::new("notify-symlink");
    let real = scratch.join("dotfiles").join("config.json");
    std::fs::create_dir_all(real.parent().unwrap()).expect("dotfiles dir");
    std::fs::write(&real, r#"{ "notify": "auto" }"#).expect("real config written");
    let link = scratch.join("config.json");
    std::os::unix::fs::symlink(&real, &link).expect("symlinked");

    // The value resolves THROUGH the link, exactly as the engine resolves it.
    assert_eq!(
        read_notify_value(link.to_str()),
        Some(json!("auto")),
        "a symlinked config must read as the engine reads it, not as unreadable"
    );

    // A dangling link is ENOENT for the engine too: absent, and the app notifies.
    let dangling = scratch.join("dangling.json");
    std::os::unix::fs::symlink(scratch.join("nowhere.json"), &dangling).expect("dangling link");
    assert_eq!(
        read_engine_config_text(&dangling),
        Err(ConfigUnreadable::Absent)
    );
    assert_eq!(read_notify_value(dangling.to_str()), None);

    // Absent vs unreadable, from the error itself: a missing file is Absent; a directory (or an
    // over-cap file — the registered residual) is Unreadable, never "no config".
    assert_eq!(
        read_engine_config_text(&scratch.join("missing.json")),
        Err(ConfigUnreadable::Absent)
    );
    assert_eq!(
        read_engine_config_text(&scratch.join("dotfiles")),
        Err(ConfigUnreadable::Unreadable)
    );

    // And end to end on macOS: the symlinked "auto" config SUPPRESSES the DELIVERED banner
    // (engine-notifies) instead of double-posting beside the engine's own notifier.
    if cfg!(target_os = "macos") {
        let store = scratch.join("app-data");
        write_record(
            &store,
            &NotifyRecord {
                enabled: Some(true),
            },
        )
        .expect("record written");
        let recorder = Arc::new(RecordingNotifySink::default());
        let app = mock_app(Some(
            NotifyState::default()
                .with_sink(recorder.clone())
                .with_store_dir(&store),
        ));
        announce_delivery(&app, link.to_str(), None);
        assert_eq!(
            recorder.posted(),
            vec![],
            "a symlinked auto config double-notified"
        );
        assert_eq!(
            app.state::<NotifyState>().suppressed()[0].reason,
            "engine-notifies"
        );
    }
}

/* ── the gates, through the SHIPPING sink ─────────────────────────────────────────────────────── */

/// The shipped context. ONE `generate_context!` per test binary — each expansion defines the
/// macOS `__EMBED_INFO_PLIST` symbol, and two of them collide at link time (gui-seam deviation
/// 21's measured failure, met again here on the first draft of this file).
fn shipped_context() -> tauri::Context<MockRuntime> {
    tauri::generate_context!()
}

fn mock_app(notify: Option<NotifyState>) -> App<MockRuntime> {
    let builder = mock_builder().manage(ShellState::default());
    let builder = match notify {
        Some(notify) => builder.manage(notify),
        None => builder,
    };
    builder.build(shipped_context()).expect("mock app")
}

/// Drive `AppState::changed` — the literal shipping sink — over a waiting→delivered transition.
fn announce_delivery(app: &App<MockRuntime>, config: Option<&str>, briefing: Option<&str>) {
    let sink = AppState::new(app.handle().clone());
    sink.changed(&waiting_snapshot(
        "2026-09-17",
        Some("2026-09-16T07:24:00Z"),
    ));
    sink.changed(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        config,
        briefing,
    ));
}

/// Never asked → nothing posts, the suppression log says so, and the machine still deduped (a
/// later opt-in does not replay the morning).
#[test]
fn a_background_fire_before_the_opt_in_posts_nothing_and_is_recorded() {
    let scratch = ScratchDir::new("notify-unasked");
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(scratch.join("app-data")),
    ));
    announce_delivery(&app, None, None);
    assert_eq!(
        recorder.posted(),
        vec![],
        "a never-asked state posted a notification"
    );
    let state = app.state::<NotifyState>();
    let suppressed = state.suppressed();
    assert_eq!(suppressed.len(), 1, "{suppressed:?}");
    assert_eq!(suppressed[0].class, "delivered");
    assert_eq!(suppressed[0].reason, "never-asked");
}

/// Declined → `disabled`; enabled → the post happens, with the resume line as the body.
#[test]
fn the_opt_in_gates_the_post_and_the_body_is_the_first_resume_line() {
    for (enabled, expect_posts) in [(false, 0usize), (true, 1usize)] {
        let scratch = ScratchDir::new("notify-optin");
        let store = scratch.join("app-data");
        write_record(
            &store,
            &NotifyRecord {
                enabled: Some(enabled),
            },
        )
        .expect("record written");
        let briefing_path = scratch.join("briefing-latest.md");
        std::fs::write(
            &briefing_path,
            "☀️  Daily briefing — 2026-09-17\n▶ Where you left off\n   • [dba] finish B7\n",
        )
        .expect("briefing written");
        let recorder = Arc::new(RecordingNotifySink::default());
        let app = mock_app(Some(
            NotifyState::default()
                .with_sink(recorder.clone())
                .with_store_dir(&store),
        ));
        announce_delivery(&app, None, briefing_path.to_str());
        let posted = recorder.posted();
        assert_eq!(posted.len(), expect_posts, "enabled={enabled}: {posted:?}");
        if expect_posts == 1 {
            assert_eq!(posted[0].title, "Daily briefing — 2026-09-17");
            assert_eq!(posted[0].body, "[dba] finish B7");
            assert_eq!(posted[0].route, "today");
            assert_eq!(app.state::<NotifyState>().suppressed(), vec![]);
        } else {
            assert_eq!(
                app.state::<NotifyState>().suppressed()[0].reason,
                "disabled"
            );
        }
    }
}

/// The resolved-capability rule, end to end on THIS platform (macOS in this suite): an engine
/// config of `"auto"` resolves to a real emitter → the app suppresses its DELIVERED banner and
/// records `engine-notifies`; `"off"` (and an unreadable config) → the app posts. A FAILED firing
/// is NOT suppressed by ownership — the engine has no failure notifier
/// (`src/main.ts:489` is the only `notify(...)` call, on the delivered path).
#[test]
fn engine_ownership_suppresses_delivered_only() {
    if !cfg!(target_os = "macos") {
        // This end-to-end leg encodes the darwin resolution of "auto"; the predicate itself is
        // covered per-OS by the fixture table above. Extend this table before running it on
        // another host.
        return;
    }
    for (config_text, expect_posted, expect_reason) in [
        (
            Some(r#"{ "notify": "auto" }"#),
            false,
            Some("engine-notifies"),
        ),
        (Some(r#"{ "notify": "off" }"#), true, None),
        (
            Some(r#"{ "notify": { "command": ["terminal-notifier", "{title}"] } }"#),
            false,
            Some("engine-notifies"),
        ),
        (Some("not json at all"), true, None),
        (None, true, None),
    ] {
        let scratch = ScratchDir::new("notify-owner");
        let store = scratch.join("app-data");
        write_record(
            &store,
            &NotifyRecord {
                enabled: Some(true),
            },
        )
        .expect("record written");
        let config_path = scratch.join("config.json");
        if let Some(text) = config_text {
            std::fs::write(&config_path, text).expect("config written");
        }
        let recorder = Arc::new(RecordingNotifySink::default());
        let app = mock_app(Some(
            NotifyState::default()
                .with_sink(recorder.clone())
                .with_store_dir(&store),
        ));
        announce_delivery(&app, config_path.to_str(), None);
        let posted = recorder.posted();
        assert_eq!(
            !posted.is_empty(),
            expect_posted,
            "config={config_text:?}: {posted:?}"
        );
        if let Some(reason) = expect_reason {
            assert_eq!(app.state::<NotifyState>().suppressed()[0].reason, reason);
        }

        // The SAME config never suppresses a FAILED firing — and the snapshot CARRIES that
        // config, so the ownership gate is actually reached for the FAILED class. With
        // `config_path: None` this leg was vacuous (round 1, mutant M10b: suppress ALL classes
        // by ownership left the suite green because the gate was never consulted); with the
        // `"auto"` row here, that mutant records `engine-notifies` for the FAILED firing and
        // the `posted.len() == 1` below goes red.
        let recorder = Arc::new(RecordingNotifySink::default());
        let app = mock_app(Some(
            NotifyState::default()
                .with_sink(recorder.clone())
                .with_store_dir(&store),
        ));
        let sink = AppState::new(app.handle().clone());
        sink.changed(&waiting_snapshot("2026-09-17", None));
        sink.changed(&skipped_snapshot_with_config(
            "2026-09-17",
            "provider-fail",
            Some("E529: overloaded"),
            None,
            config_path.to_str(),
        ));
        let posted = recorder.posted();
        assert_eq!(posted.len(), 1, "config={config_text:?}: {posted:?}");
        assert_eq!(posted[0].class, NotifyClass::Failed);
        assert_eq!(posted[0].body, "E529: overloaded");
        assert!(
            app.state::<NotifyState>()
                .suppressed()
                .iter()
                .all(|s| s.class != "failed"),
            "a FAILED firing was ownership-suppressed under config={config_text:?}"
        );
    }
}

/// A sink that fails is recorded and fails nothing else — and pre-B7 fixtures (no managed
/// `NotifyState`) pass through the shipping sink untouched.
#[test]
fn a_failed_post_is_recorded_and_an_unmanaged_app_is_a_no_op() {
    let scratch = ScratchDir::new("notify-postfail");
    let store = scratch.join("app-data");
    write_record(
        &store,
        &NotifyRecord {
            enabled: Some(true),
        },
    )
    .expect("record written");
    let recorder = Arc::new(RecordingNotifySink::failing("the notifier is gone"));
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&store),
    ));
    announce_delivery(&app, None, None);
    assert_eq!(
        recorder.posted().len(),
        1,
        "the sink was not even attempted"
    );
    assert_eq!(
        app.state::<NotifyState>().suppressed()[0].reason,
        "post-failed"
    );

    // No NotifyState managed at all: the sink must not panic or post.
    let bare = mock_app(None);
    let sink = AppState::new(bare.handle().clone());
    sink.changed(&waiting_snapshot("2026-09-17", None));
    sink.changed(&delivered_snapshot(
        "2026-09-17",
        "2026-09-17T07:24:00Z",
        None,
        None,
    ));
}

/// Known item 8 (Phase E final harden): the record's temp file is CREATED, never opened — the
/// `access` record's test, for this module's own `write_record`. With a dangling symlink planted
/// at every temp name the write can draw, it refuses; nothing is created through a link, no plant
/// is replaced, and the recorded opt-in stands.
#[cfg(unix)]
#[test]
fn a_planted_temp_name_is_never_written_through() {
    let scratch = ScratchDir::new("notify-temp-plant");
    let seeded = NotifyRecord {
        enabled: Some(true),
    };
    write_record(&scratch.path, &seeded).expect("seed the record");
    common::assert_planted_temp_names_refused(&scratch.path, "notify-state.json", || {
        write_record(&scratch.path, &NotifyRecord::default())
    });
    assert_eq!(read_record(&scratch.path), seeded);
}

/// The record round-trips, degrades to `Default` on garbage, and `Facts` extraction stays total
/// over a stateless snapshot.
#[test]
fn the_record_and_the_facts_degrade_safely() {
    let scratch = ScratchDir::new("notify-record");
    let dir = scratch.join("app-data");
    assert_eq!(
        read_record(&dir),
        NotifyRecord::default(),
        "missing = never asked"
    );
    write_record(
        &dir,
        &NotifyRecord {
            enabled: Some(false),
        },
    )
    .expect("written");
    assert_eq!(read_record(&dir).enabled, Some(false));
    std::fs::write(dir.join("notify-state.json"), "{ not json").expect("clobbered");
    assert_eq!(
        read_record(&dir),
        NotifyRecord::default(),
        "garbage = never asked"
    );

    assert_eq!(
        facts_of(&Snapshot::unavailable("nothing")),
        Facts::default()
    );
    // A skip fact needs the record's localDate; a snapshot whose last_skip vanished carries none.
    let mut s = skipped_snapshot("2026-09-17", "provider-fail", None, None);
    s.last_skip = None;
    assert_eq!(facts_of(&s).skip, None);
    let _ = SkipFact {
        class: NotifyClass::Failed,
        date: String::new(),
        detail: None,
        reason: String::new(),
    };
}

/* ── `notified-dates.json`, through the SHIPPING sink ─────────────────────────────────────────── */

/// A `NotifyState` for the shipping sink whose clock says `today` (the exemption is for TODAY's
/// local date, and the fixtures' day is not the real one).
fn clocked_state(store: &Path, recorder: Arc<RecordingNotifySink>, today: &str) -> NotifyState {
    let today = today.to_string();
    NotifyState::default()
        .with_sink(recorder)
        .with_store_dir(store)
        .with_clock(Arc::new(move || Now {
            local_date: today.clone(),
            minutes: 480,
            epoch_secs: 1_790_000_000,
        }))
}

/// One app session over `store`: a fresh `NotifyState` (as at app start), every snapshot through
/// `AppState::changed`, and what it posted and withheld.
fn session(
    store: &Path,
    today: &str,
    snapshots: &[Snapshot],
) -> (
    Vec<daily_briefing_gui_lib::notifications::Notification>,
    Vec<(String, String, String)>,
) {
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(clocked_state(store, recorder.clone(), today)));
    let sink = AppState::new(app.handle().clone());
    for snapshot in snapshots {
        sink.changed(snapshot);
    }
    let withheld = app
        .state::<NotifyState>()
        .suppressed()
        .into_iter()
        .map(|s| (s.class.to_string(), s.date, s.reason.to_string()))
        .collect();
    (recorder.posted(), withheld)
}

fn opted_in_store(scratch: &ScratchDir) -> PathBuf {
    let store = scratch.join("app-data");
    write_record(
        &store,
        &NotifyRecord {
            enabled: Some(true),
        },
    )
    .expect("record written");
    store
}

/// A FAILED firing is not repeated after a restart: without the persisted date, today's failure
/// would escape start-up absorption and post again. And the spec's own double-fire: an all-out
/// banner, a quiet `offline` skip overwriting the record, a restart, the next all-out tick —
/// silent, because the date was persisted.
#[test]
fn a_failed_firing_is_not_repeated_after_a_restart() {
    let d = "2026-09-17";
    let scratch = ScratchDir::new("notify-dates-restart");
    let store = opted_in_store(&scratch);
    let failed = skipped_snapshot(d, "provider-fail", Some("E529"), None);

    let (posted, _) = session(&store, d, &[waiting_snapshot(d, None), failed.clone()]);
    assert_eq!(posted.len(), 1, "{posted:?}");
    assert_eq!(posted[0].class, NotifyClass::Failed);
    assert_eq!(
        read_notified_dates(&store)
            .get(&NotifyClass::Failed)
            .map(String::as_str),
        Some(d),
        "the firing was not persisted"
    );
    let (posted, _) = session(&store, d, &[failed.clone(), failed.clone(), failed]);
    assert_eq!(
        posted,
        vec![],
        "the FAILED banner repeated after the restart"
    );

    let scratch = ScratchDir::new("notify-dates-offline-interleave");
    let store = opted_in_store(&scratch);
    let all_out = out_of_usage_snapshot(d, Some(OUT_OF_USAGE_DETAIL));
    let (posted, _) = session(
        &store,
        d,
        &[
            waiting_snapshot(d, None),
            all_out.clone(),
            skipped_snapshot(d, "offline", None, None),
        ],
    );
    assert_eq!(posted.len(), 1, "{posted:?}");
    let (posted, _) = session(&store, d, &[all_out.clone(), all_out]);
    assert_eq!(
        posted,
        vec![],
        "the all-out banner repeated after an offline skip and a restart"
    );
}

/// Carried L3 through the file: an all-out banner, a restart, then the day's `provider-fail` —
/// FAILED still posts (its own slot), the all-out tick after it does not, and a third session
/// posts nothing. Two banners for the day, one per state.
#[test]
fn out_of_usage_then_failed_on_one_day_post_twice_across_a_restart() {
    let d = "2026-09-17";
    let scratch = ScratchDir::new("notify-dates-two-slots");
    let store = opted_in_store(&scratch);
    let all_out = out_of_usage_snapshot(d, Some(OUT_OF_USAGE_DETAIL));
    let failed = skipped_snapshot(d, "provider-fail", Some("E529"), None);

    let (posted, _) = session(&store, d, &[waiting_snapshot(d, None), all_out.clone()]);
    assert_eq!(
        posted.iter().map(|n| n.class).collect::<Vec<_>>(),
        vec![NotifyClass::OutOfUsage]
    );
    let (posted, _) = session(&store, d, &[failed.clone(), all_out.clone()]);
    assert_eq!(
        posted.iter().map(|n| n.class).collect::<Vec<_>>(),
        vec![NotifyClass::Failed],
        "after the restart FAILED must post once and OutOfUsage not again"
    );
    let (posted, _) = session(&store, d, &[failed, all_out]);
    assert_eq!(posted, vec![]);
    assert_eq!(
        read_notified_dates(&store),
        dates(&[(NotifyClass::Failed, d), (NotifyClass::OutOfUsage, d)])
    );
}

/// A firing WITHHELD because notifications are off or never asked is persisted all the same, so a
/// restart does not decide it again (no second suppression entry, and nothing posts if the user
/// opts in later that day).
#[test]
fn a_withheld_firing_is_persisted() {
    let d = "2026-09-17";
    for (enabled, reason) in [(None, "never-asked"), (Some(false), "disabled")] {
        let scratch = ScratchDir::new("notify-dates-withheld");
        let store = scratch.join("app-data");
        if enabled.is_some() {
            write_record(&store, &NotifyRecord { enabled }).expect("record written");
        }
        let all_out = out_of_usage_snapshot(d, Some(OUT_OF_USAGE_DETAIL));
        let failed = skipped_snapshot(d, "provider-fail", Some("E529"), None);
        let (posted, withheld) = session(
            &store,
            d,
            &[waiting_snapshot(d, None), all_out.clone(), failed.clone()],
        );
        assert_eq!(posted, vec![]);
        assert_eq!(
            withheld,
            vec![
                (
                    "out-of-usage".to_string(),
                    d.to_string(),
                    reason.to_string()
                ),
                ("failed".to_string(), d.to_string(), reason.to_string()),
            ]
        );
        assert_eq!(
            read_notified_dates(&store),
            dates(&[(NotifyClass::Failed, d), (NotifyClass::OutOfUsage, d)]),
            "{reason}: a withheld firing was not persisted"
        );
        // Restart, now opted in: the day's two states were already decided.
        write_record(
            &store,
            &NotifyRecord {
                enabled: Some(true),
            },
        )
        .expect("record written");
        let (posted, withheld) = session(&store, d, &[all_out, failed]);
        assert_eq!((posted, withheld), (vec![], vec![]), "{reason}");
    }
}

/// At load the later date wins, per class, through the FILE: a planted map whose DELIVERED date is
/// later than the primer's run date keeps it, and whose BLOCKED and FAILED dates are earlier
/// gives way — to the primer's absorbed BLOCKED, and to the FAILED firing that rewrites the file.
#[test]
fn the_later_date_wins_at_load_through_the_file() {
    let d = "2026-09-17";
    let scratch = ScratchDir::new("notify-dates-later-wins");
    let store = opted_in_store(&scratch);
    std::fs::write(
        store.join(NOTIFIED_DATES_FILE),
        r#"{"delivered":"2026-09-17","blocked":"2026-09-16","failed":"2026-09-16"}"#,
    )
    .expect("planted");
    let primer = snapshot(
        d,
        status_payload(
            Some("2026-09-16"),
            Some("2026-09-17T07:24:00Z"),
            Some(("blocked", d, None)),
            None,
            None,
        ),
    );
    let (posted, _) = session(
        &store,
        d,
        &[
            primer,
            skipped_snapshot(d, "provider-fail", Some("E529"), None),
        ],
    );
    assert_eq!(
        posted.iter().map(|n| n.class).collect::<Vec<_>>(),
        vec![NotifyClass::Failed],
        "an earlier persisted FAILED date blocked today's firing"
    );
    assert_eq!(
        read_notified_dates(&store),
        dates(&[
            (NotifyClass::Delivered, d),
            (NotifyClass::Blocked, d),
            (NotifyClass::Failed, d),
        ])
    );
}

/// P3-M5 checkpoint L1: the PRODUCTION clock path — a `NotifyState` with NO `with_clock`, so
/// `today` is `schedule_state::now_local()` (the store is still a scratch dir, never the real
/// app data dir). Today's FAILED fires at start-up: an always-empty clock would absorb it.
#[test]
fn the_production_clock_decides_today_at_start_up() {
    let today = now_local().local_date;
    assert!(!today.is_empty(), "this machine has no local date");
    let scratch = ScratchDir::new("notify-dates-real-clock");
    let store = opted_in_store(&scratch);
    let recorder = Arc::new(RecordingNotifySink::default());
    let app = mock_app(Some(
        NotifyState::default()
            .with_sink(recorder.clone())
            .with_store_dir(&store),
    ));
    let sink = AppState::new(app.handle().clone());
    sink.changed(&skipped_snapshot(
        &today,
        "provider-fail",
        Some("E529"),
        None,
    ));
    if now_local().local_date != today {
        eprintln!("the local date rolled over mid-test; nothing to assert");
        return;
    }
    let posted = recorder.posted();
    assert_eq!(
        posted.len(),
        1,
        "today's FAILED did not fire at start-up: {posted:?}"
    );
    assert_eq!(posted[0].class, NotifyClass::Failed);
}

/// A write failure of `notified-dates.json` falls back to the in-memory dedupe: with a DIRECTORY
/// where the file belongs (unreadable as a map, unwritable as a file), each class still posts
/// exactly once for the day and nothing panics.
#[test]
fn a_write_failure_falls_back_to_in_memory_dedupe() {
    let d = "2026-09-17";
    let scratch = ScratchDir::new("notify-dates-write-fails");
    let store = opted_in_store(&scratch);
    std::fs::create_dir(store.join(NOTIFIED_DATES_FILE)).expect("a directory in the file's place");
    let failed = skipped_snapshot(d, "provider-fail", Some("E529"), None);
    let all_out = out_of_usage_snapshot(d, Some(OUT_OF_USAGE_DETAIL));
    let (posted, _) = session(
        &store,
        d,
        &[
            waiting_snapshot(d, None),
            failed.clone(),
            failed.clone(),
            all_out.clone(),
            all_out,
            failed,
        ],
    );
    assert_eq!(
        posted.iter().map(|n| n.class).collect::<Vec<_>>(),
        vec![NotifyClass::Failed, NotifyClass::OutOfUsage]
    );
    assert!(store.join(NOTIFIED_DATES_FILE).is_dir());
    assert_eq!(read_notified_dates(&store), BTreeMap::new());
}

/// The file round-trips as one JSON object keyed by the wire spelling, and degrades to an EMPTY
/// map — today's in-memory behaviour — when it is missing or garbage; an unknown class or a value
/// that is not a `YYYY-MM-DD` date is ignored, never guessed at.
#[test]
fn the_notified_dates_file_round_trips_and_degrades_to_empty() {
    let scratch = ScratchDir::new("notify-dates-file");
    let dir = scratch.join("app-data");
    assert_eq!(
        read_notified_dates(&dir),
        BTreeMap::new(),
        "missing = nothing persisted"
    );
    let map = dates(&[
        (NotifyClass::Failed, "2026-09-17"),
        (NotifyClass::OutOfUsage, "2026-09-17"),
    ]);
    write_notified_dates(&dir, &map).expect("written");
    assert_eq!(read_notified_dates(&dir), map);
    let on_disk: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(NOTIFIED_DATES_FILE)).expect("readable"),
    )
    .expect("JSON");
    assert_eq!(
        on_disk,
        json!({ "failed": "2026-09-17", "out-of-usage": "2026-09-17" })
    );

    std::fs::write(dir.join(NOTIFIED_DATES_FILE), "{ not json").expect("clobbered");
    assert_eq!(
        read_notified_dates(&dir),
        BTreeMap::new(),
        "garbage = nothing persisted"
    );
    std::fs::write(
        dir.join(NOTIFIED_DATES_FILE),
        r#"{"failed":"2026-09-17","mystery":"2026-09-17","blocked":"yesterday","delivered":7,"out-of-usage":"2026-9-17"}"#,
    )
    .expect("written");
    assert_eq!(
        read_notified_dates(&dir),
        dates(&[(NotifyClass::Failed, "2026-09-17")])
    );

    // P3-M5 checkpoint L3: every class round-trips, keyed by its wire spelling. (The read and the
    // write are keyed through `NotifyClass`'s derived serde, so a new variant needs no list.)
    let every = [
        NotifyClass::Delivered,
        NotifyClass::Failed,
        NotifyClass::Blocked,
        NotifyClass::OutOfUsage,
    ];
    let map: BTreeMap<NotifyClass, String> = every
        .iter()
        .map(|c| (*c, "2026-09-17".to_string()))
        .collect();
    write_notified_dates(&dir, &map).expect("written");
    assert_eq!(read_notified_dates(&dir), map);
    let on_disk: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.join(NOTIFIED_DATES_FILE)).expect("readable"),
    )
    .expect("JSON");
    for class in every {
        assert_eq!(
            on_disk[class.as_str()],
            json!("2026-09-17"),
            "{class:?} is not keyed by its wire spelling"
        );
    }
}

/// The dates file's temp is CREATED, never opened through a planted link — the record's own test
/// (`a_planted_temp_name_is_never_written_through`), for `write_notified_dates`.
#[cfg(unix)]
#[test]
fn a_planted_notified_dates_temp_name_is_never_written_through() {
    let scratch = ScratchDir::new("notify-dates-temp-plant");
    let seeded = dates(&[(NotifyClass::Failed, "2026-09-17")]);
    write_notified_dates(&scratch.path, &seeded).expect("seed the file");
    common::assert_planted_temp_names_refused(&scratch.path, NOTIFIED_DATES_FILE, || {
        write_notified_dates(&scratch.path, &BTreeMap::new())
    });
    assert_eq!(read_notified_dates(&scratch.path), seeded);
}
