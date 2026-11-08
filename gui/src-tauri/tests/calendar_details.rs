//! Briefing redesign wave 2, C — the live calendar details' Rust half (`src/calendar_details.rs`; plan C-M3-T8 and
//! C-M3-T9): the pure `decide`, the held state (the event map, the remembered command-link URLs, the per-source last
//! statuses), one read in flight with a waiting ask that re-samples and decides again, and (C-M3-T9) the four
//! commands.
//!
//! ⚠ NO TEST HERE TOUCHES THE REAL CALENDAR, THE REAL READER, A REAL LINK OR THE USER'S CONFIG. The engine is a fake
//! sidecar (`common::fake_sidecar`) that records its argv and stdin and prints a canned sealed document; the config
//! is a temp file (`CalendarDetails::with_config_path`); the clock and the window are injected (`LiveEnv`).
//!
//! ⚠ AND NO URL SURFACES. Every fixture URL carries `MARKER`, and the replies, the decisions and every error are
//! scanned for it.

mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{sq, ScratchDir};
use daily_briefing_gui_lib::calendar_details::{
    config_generation, decide, open_details, CalendarDetails, DetailsDecision, DetailsGateInput, OpenReply, Reason,
    TIMER_BACKSTOP_SECS,
};
use daily_briefing_gui_lib::engine::{DetailsFailure, DetailsRaw, EngineClient, EngineError};
use daily_briefing_gui_lib::live_gate::{CurrentSlide, LiveEnv, Visibility};
use daily_briefing_gui_lib::schedule_state::Now;

const SLIDES: [Option<CurrentSlide>; 7] = [
    None,
    Some(CurrentSlide::GoodMorning),
    Some(CurrentSlide::WhatYouDid),
    Some(CurrentSlide::LeftOff),
    Some(CurrentSlide::Suggested),
    Some(CurrentSlide::Calendar),
    Some(CurrentSlide::Launchpad),
];
const REASONS: [Reason; 3] = [Reason::BecameCurrent, Reason::Focus, Reason::Timer];

const SHOWN: Visibility = Visibility { visible: true, minimized: false };
const HIDDEN_WINDOWS: [Visibility; 3] = [
    Visibility { visible: false, minimized: false },
    Visibility { visible: true, minimized: true },
    Visibility { visible: false, minimized: true },
];

fn vis(shown: bool) -> Visibility {
    Visibility { visible: shown, minimized: false }
}

fn input(reason: Reason) -> DetailsGateInput {
    DetailsGateInput {
        visibility: SHOWN,
        current: Some(CurrentSlide::Calendar),
        reason,
        held_valid: true,
        since_read_secs: 10,
        any_link_without_url: false,
        mac_blocked: false,
    }
}

const READ_ALL: DetailsDecision = DetailsDecision::Read { skip_commands: false, skip_mac: false };
const READ_SKIP: DetailsDecision = DetailsDecision::Read { skip_commands: true, skip_mac: false };
const READ_SKIP_MAC: DetailsDecision = DetailsDecision::Read { skip_commands: true, skip_mac: true };

/* ── decide, directly ─────────────────────────────────────────────────────────────────────────── */

#[test]
fn another_slide_reads_nothing_and_answers_held_or_none() {
    for current in [None, Some(CurrentSlide::GoodMorning), Some(CurrentSlide::Suggested)] {
        for reason in REASONS {
            for shown in [true, false] {
                let held = DetailsGateInput { current, visibility: vis(shown), held_valid: true, ..input(reason) };
                assert_eq!(decide(held), DetailsDecision::Held, "{current:?} {reason:?} shown {shown}");
                let none = DetailsGateInput { current, visibility: vis(shown), held_valid: false, ..input(reason) };
                assert_eq!(decide(none), DetailsDecision::None, "{current:?} {reason:?} shown {shown}");
            }
        }
    }
}

#[test]
fn a_hidden_window_is_refused_on_either_slide() {
    for current in [Some(CurrentSlide::Calendar), Some(CurrentSlide::Launchpad)] {
        for reason in REASONS {
            for held_valid in [true, false] {
                for visibility in HIDDEN_WINDOWS {
                    let i = DetailsGateInput { current, visibility, held_valid, ..input(reason) };
                    assert_eq!(decide(i), DetailsDecision::RefusedHidden, "{current:?} {reason:?} {visibility:?}");
                }
            }
        }
    }
}

#[test]
fn with_no_valid_held_read_every_reason_reads_and_only_became_current_runs_commands() {
    let none = |reason| DetailsGateInput { held_valid: false, ..input(reason) };
    assert_eq!(decide(none(Reason::BecameCurrent)), READ_ALL);
    assert_eq!(decide(none(Reason::Focus)), READ_SKIP);
    assert_eq!(decide(none(Reason::Timer)), READ_SKIP);
    // R3-M5: the first timer after midnight does not read a denied / not-granted Mac source.
    assert_eq!(decide(DetailsGateInput { mac_blocked: true, ..none(Reason::Timer) }), READ_SKIP_MAC);
    assert_eq!(decide(DetailsGateInput { mac_blocked: true, ..none(Reason::Focus) }), READ_SKIP);
    assert_eq!(decide(DetailsGateInput { mac_blocked: true, ..none(Reason::BecameCurrent) }), READ_ALL);
}

#[test]
fn became_current_with_a_valid_held_read_reads_only_for_a_link_without_a_url() {
    assert_eq!(decide(input(Reason::BecameCurrent)), DetailsDecision::Held);
    let missing = DetailsGateInput { any_link_without_url: true, ..input(Reason::BecameCurrent) };
    assert_eq!(decide(missing), READ_ALL);
    // The launchpad counts the same.
    let launchpad = DetailsGateInput { current: Some(CurrentSlide::Launchpad), ..missing };
    assert_eq!(decide(launchpad), READ_ALL);
}

#[test]
fn the_timer_backstop_holds_under_295_seconds_and_reads_after() {
    assert_eq!(TIMER_BACKSTOP_SECS, 300 - 5);
    let at = |s| DetailsGateInput { since_read_secs: s, ..input(Reason::Timer) };
    assert_eq!(decide(at(0)), DetailsDecision::Held);
    assert_eq!(decide(at(294)), DetailsDecision::Held);
    assert_eq!(decide(at(295)), READ_SKIP);
    assert_eq!(decide(at(296)), READ_SKIP);
    assert_eq!(decide(DetailsGateInput { mac_blocked: true, ..at(296) }), READ_SKIP_MAC);
    assert_eq!(decide(DetailsGateInput { mac_blocked: true, ..at(294) }), DetailsDecision::Held);
    // A link without a URL changes nothing for the timer: it never runs a command.
    assert_eq!(decide(DetailsGateInput { any_link_without_url: true, ..at(296) }), READ_SKIP);
}

#[test]
fn focus_with_a_valid_held_read_reads_skipping_commands() {
    assert_eq!(decide(input(Reason::Focus)), READ_SKIP);
    assert_eq!(decide(DetailsGateInput { any_link_without_url: true, ..input(Reason::Focus) }), READ_SKIP);
    assert_eq!(decide(DetailsGateInput { mac_blocked: true, ..input(Reason::Focus) }), READ_SKIP);
}

/// ⚠ THE NEW OD1, AS A PROPERTY: every `focus` and `timer` read skips commands, whatever Rust holds; only a
/// `became-current` read may run one; `skip_mac` only on a timed read.
#[test]
fn skip_commands_is_set_on_every_focus_and_timer_read_over_every_input() {
    let mut reads = 0;
    for current in SLIDES {
        for reason in REASONS {
            for visibility in [SHOWN, HIDDEN_WINDOWS[0], HIDDEN_WINDOWS[1]] {
                for held_valid in [true, false] {
                    for since_read_secs in [0, 294, 295, 296, 10_000] {
                        for any_link_without_url in [true, false] {
                            for mac_blocked in [true, false] {
                                let i = DetailsGateInput {
                                    visibility, current, reason, held_valid, since_read_secs, any_link_without_url,
                                    mac_blocked,
                                };
                                if let DetailsDecision::Read { skip_commands, skip_mac } = decide(i) {
                                    reads += 1;
                                    assert_eq!(skip_commands, reason != Reason::BecameCurrent, "{i:?}");
                                    if skip_mac {
                                        assert_eq!(reason, Reason::Timer, "{i:?}");
                                        assert!(mac_blocked, "{i:?}");
                                    }
                                    assert!(visibility.shown(), "a hidden window read: {i:?}");
                                    assert!(
                                        matches!(current, Some(CurrentSlide::Calendar | CurrentSlide::Launchpad)),
                                        "another slide read: {i:?}"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(reads > 50, "the loop saw only {reads} reads — vacuous");
}

#[test]
fn a_reason_deserialises_from_the_webviews_three_words_only() {
    for (word, reason) in [("became-current", Reason::BecameCurrent), ("focus", Reason::Focus), ("timer", Reason::Timer)] {
        assert_eq!(serde_json::from_value::<Reason>(serde_json::json!(word)).expect(word), reason);
    }
    for bad in ["becameCurrent", "Focus", "load", ""] {
        assert!(serde_json::from_value::<Reason>(serde_json::json!(bad)).is_err(), "{bad}");
    }
}

/* ── the held state, on canned answers ────────────────────────────────────────────────────────── */

const MARKER: &str = "MARKER";
const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn url(n: u32) -> String {
    format!("https://vault.example/{MARKER}-{n}/cal.ics")
}

/// A sealed document: `events` titled as given, `sources`, and the command links' reports.
fn doc(titles: &[&str], mut sources: serde_json::Value, links: serde_json::Value) -> String {
    // Existing fixtures describe command sources unless they explicitly mark an env/file source.
    for src in sources.as_array_mut().expect("sources") {
        if src["kind"] == "link" && src.get("command").is_none() { src["command"] = serde_json::json!(true); }
    }
    let events: Vec<serde_json::Value> = titles
        .iter()
        .enumerate()
        .map(|(i, t)| {
            serde_json::json!({
                "title": t, "location": null, "rowText": format!("09:{i:02}–10:00 {t}"),
                "time": { "kind": "timed", "startMs": 1_000 * i as i64, "endMs": 9_000 },
                "status": "confirmed", "ended": false, "fromMac": i == 0,
                "people": [{ "name": "Priya Shah", "organiser": true }],
                "notes": format!("notes for {t}"),
                "join": { "kind": "known", "url": format!("https://zoom.us/j/{MARKER}{i}"), "host": "zoom.us" }
            })
        })
        .collect();
    serde_json::json!({
        "schemaVersion": 1, "readAt": "2026-10-24T09:00:00.000Z", "events": events, "sources": sources,
        "readerOutdated": false, "links": links
    })
    .to_string()
}

fn raw(text: &str) -> DetailsRaw {
    DetailsRaw::parse(text.as_bytes()).unwrap_or_else(|f| panic!("the fixture parses: {f:?}"))
}

fn now(date: &str, epoch_secs: i64) -> Now {
    Now { local_date: date.into(), minutes: 9 * 60, epoch_secs }
}

/// The JSON of a reply, scanned for the marker.
fn reply_json(reply: &OpenReply) -> serde_json::Value {
    let v = serde_json::to_value(reply).expect("the reply serialises");
    assert!(!v.to_string().contains(MARKER), "a URL reached the reply: {v}");
    assert!(!format!("{reply:?}").contains(MARKER), "a URL reached the reply's Debug");
    v
}

fn last_of(reply: &OpenReply, id: &str) -> serde_json::Value {
    let v = reply_json(reply);
    v["sources"]
        .as_array()
        .expect("a list reply has sources")
        .iter()
        .find(|s| s["id"] == id)
        .unwrap_or_else(|| panic!("no source {id} in {v}"))["last"]
        .clone()
}

#[test]
fn an_answered_read_holds_exactly_the_reported_urls_and_records_each_source() {
    let s = CalendarDetails::default();
    let today = now("2026-10-24", 1_000);
    let reply = s.record_answer(
        &today,
        "gen-1",
        Ok(raw(&doc(
            &["Standup", "Review"],
            serde_json::json!([
                { "id": "macos", "kind": "macos", "status": "ok" },
                { "id": "work", "kind": "link", "status": "incomplete", "reason": "unreachable" },
                { "id": "home", "kind": "link", "status": "ok" }
            ]),
            serde_json::json!([
                { "id": "work", "entryHash": H1, "url": url(1) },
                { "id": "home", "entryHash": H2 }
            ]),
        ))),
    );
    let v = reply_json(&reply);
    assert_eq!(v["gate"], "read");
    assert_eq!(v["events"].as_array().expect("events").len(), 2);
    assert_eq!(v["events"][0]["linkState"], "one");
    assert_eq!(v["events"][0]["joinHost"], "zoom.us");
    assert_eq!(v["events"][0]["needsConfirm"], false);
    assert_eq!(v["events"][0]["fromMac"], true);
    assert!(v["events"][0].get("notes").is_none() && v["events"][0].get("people").is_none());
    assert_eq!(s.held_links(), vec![("work".to_string(), true), ("home".to_string(), false)]);
    assert_eq!(last_of(&reply, "work"), serde_json::json!({ "status": "incomplete", "reason": "unreachable", "at": "2026-10-24T09:00:00.000Z" }));
    assert_eq!(last_of(&reply, "macos")["status"], "ok");

    // The next read: work's URL reported dead (absent), home's now resolved.
    s.record_answer(
        &today,
        "gen-1",
        Ok(raw(&doc(
            &[],
            serde_json::json!([{ "id": "work", "kind": "link", "status": "link-refused" }, { "id": "home", "kind": "link", "status": "ok" }]),
            serde_json::json!([{ "id": "work", "entryHash": H1 }, { "id": "home", "entryHash": H2, "url": url(2) }]),
        ))),
    );
    assert_eq!(s.held_links(), vec![("work".to_string(), false), ("home".to_string(), true)]);
}

#[test]
fn a_skipped_source_keeps_its_last_status_unless_its_own_entry_changed_or_went() {
    let s = CalendarDetails::default();
    let today = now("2026-10-24", 1_000);
    let first = |s: &CalendarDetails| {
        s.record_answer(
            &today,
            "gen-1",
            Ok(raw(&doc(
                &[],
                serde_json::json!([{ "id": "work", "kind": "link", "status": "malformed" }, { "id": "macos", "kind": "macos", "status": "denied" }]),
                serde_json::json!([{ "id": "work", "entryHash": H1 }]),
            ))),
        )
    };
    first(&s);
    // Same entry, skipped: the last status is kept, at its own time.
    let kept = s.record_answer(
        &today,
        "gen-1",
        Ok(raw(&doc(
            &[],
            serde_json::json!([{ "id": "work", "kind": "link", "skipped": true }, { "id": "macos", "kind": "macos", "skipped": true }]),
            serde_json::json!([{ "id": "work", "entryHash": H1 }]),
        ))),
    );
    assert_eq!(last_of(&kept, "work")["status"], "malformed");
    assert_eq!(last_of(&kept, "macos")["status"], "denied");
    let v = reply_json(&kept);
    assert_eq!(v["sources"][0], serde_json::json!({ "id": "work", "kind": "link", "skipped": true, "last": { "status": "malformed", "at": "2026-10-24T09:00:00.000Z" } }));

    // Its own entry changed (a new hash): skipped, and NO last status — it reads "not read yet".
    let changed = s.record_answer(
        &today,
        "gen-2",
        Ok(raw(&doc(
            &[],
            serde_json::json!([{ "id": "work", "kind": "link", "skipped": true }]),
            serde_json::json!([{ "id": "work", "entryHash": H2 }]),
        ))),
    );
    assert_eq!(last_of(&changed, "work"), serde_json::Value::Null);
    assert_eq!(s.held_links(), vec![("work".to_string(), false)]);

    // Removed: gone from both.
    let s2 = CalendarDetails::default();
    first(&s2);
    let gone = s2.record_answer(&today, "gen-3", Ok(raw(&doc(&[], serde_json::json!([]), serde_json::json!([])))));
    assert!(reply_json(&gone)["sources"].as_array().expect("sources").is_empty());
    assert!(s2.held_links().is_empty());
}

#[test]
fn a_refusal_or_a_failed_read_leaves_the_urls_and_last_statuses_unchanged() {
    let s = CalendarDetails::default();
    let today = now("2026-10-24", 1_000);
    s.record_answer(
        &today,
        "gen-1",
        Ok(raw(&doc(&[], serde_json::json!([{ "id": "work", "kind": "link", "status": "ok" }]), serde_json::json!([{ "id": "work", "entryHash": H1, "url": url(1) }])))),
    );
    let off = s.record_answer(&today, "gen-1", Ok(raw(r#"{"schemaVersion":1,"refused":"calendar-off"}"#)));
    assert_eq!(reply_json(&off), serde_json::json!({ "refused": "calendar-off" }));
    assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
    for f in [DetailsFailure::Malformed, DetailsFailure::Exit(Some(1)), DetailsFailure::Internal] {
        let failed = s.record_answer(&today, "gen-1", Err(f));
        assert!(reply_json(&failed).get("failed").is_some(), "{failed:?}");
        assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
    }
    // And the last status survives too: the next skipped read shows it.
    let next = s.record_answer(
        &today,
        "gen-1",
        Ok(raw(&doc(&[], serde_json::json!([{ "id": "work", "kind": "link", "skipped": true }]), serde_json::json!([{ "id": "work", "entryHash": H1 }])))),
    );
    assert_eq!(last_of(&next, "work")["status"], "ok");
}

#[test]
fn a_report_link_with_a_malformed_hash_or_a_refused_url_is_not_held_as_a_url() {
    let s = CalendarDetails::default();
    let today = now("2026-10-24", 1_000);
    let upper = H1.to_uppercase().replace('1', "A");
    let reply = s.record_answer(
        &today,
        "gen-1",
        Ok(raw(&doc(
            &[],
            serde_json::json!([
                { "id": "upper", "kind": "link", "status": "ok" },
                { "id": "short", "kind": "link", "status": "ok" },
                { "id": "quote", "kind": "link", "status": "ok" },
                { "id": "http", "kind": "link", "status": "ok" }
            ]),
            serde_json::json!([
                { "id": "upper", "entryHash": upper, "url": url(1) },
                { "id": "short", "entryHash": &H1[..63], "url": url(2) },
                { "id": "quote", "entryHash": format!("{}\"", &H1[..63]), "url": url(3) },
                { "id": "http", "entryHash": H2, "url": format!("http://plain.example/{MARKER}") }
            ]),
        ))),
    );
    // The three bad hashes: neither held nor given a last status.
    assert_eq!(s.held_links(), vec![("http".to_string(), false)]);
    for id in ["upper", "short", "quote"] {
        assert_eq!(last_of(&reply, id), serde_json::Value::Null, "{id}");
    }
    assert_eq!(last_of(&reply, "http")["status"], "ok");
}

#[test]
fn the_config_generation_follows_the_calendar_block_only() {
    let scratch = ScratchDir::new("calgen");
    let path = scratch.join("config.json");
    let write = |v: serde_json::Value| std::fs::write(&path, serde_json::to_string_pretty(&v).expect("JSON")).expect("write");
    write(serde_json::json!({ "provider": "a", "calendar": { "enabled": true, "links": [{ "id": "work" }] } }));
    let g1 = config_generation(&path);
    write(serde_json::json!({ "provider": "b", "calendar": { "enabled": true, "links": [{ "id": "work" }] } }));
    assert_eq!(config_generation(&path), g1, "a change outside `calendar` moved the generation");
    write(serde_json::json!({ "provider": "b", "calendar": { "enabled": true, "links": [{ "id": "work", "name": "W" }] } }));
    assert_ne!(config_generation(&path), g1);
    std::fs::remove_file(&path).expect("remove");
    assert_ne!(config_generation(&path), g1, "a missing config kept the generation");
}

/* ── the source pins ──────────────────────────────────────────────────────────────────────────── */

fn src(rel: &str) -> String {
    production(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(rel)).expect("readable"))
}

/// A source file as code (`common::code_only`), cut at its first `#[cfg(test)]`: the pins below are about production
/// callers, and an in-module test block (every one in `src/` sits at its file's end) is not one.
fn production(source: &str) -> String {
    let code = common::code_only(source);
    match code.find("#[cfg(test)]") {
        Some(at) => code[..at].to_string(),
        None => code,
    }
}

/// The body of the item whose header starts at `head`'s first occurrence.
fn body_after<'a>(code: &'a str, head: &str) -> &'a str {
    let at = code.find(head).unwrap_or_else(|| panic!("no `{head}`"));
    let open = at + code[at..].find('{').expect("a body");
    let mut depth = 0usize;
    for (i, c) in code[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &code[at..=open + i];
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces after `{head}`")
}

/// Follow calendar.rs's code-only pin: comments and literal strings cannot create false positives.
#[test]
fn the_details_module_and_sealed_engine_sections_print_nothing() {
    let details = src("calendar_details.rs");
    assert!(details.contains("pub async fn open_details"), "the details module was not scanned");
    let engine = src("engine.rs");
    // Bound the three separated sealed sections by existing item headers. The spawn body is shared.
    let secret_start = engine.find("pub struct SecretBytes(").expect("SecretBytes");
    let secret_end = engine[secret_start..].find("pub fn launchd_path(").expect("the environment section") + secret_start;
    let collector_start = engine.find("struct SealedDetails;").expect("SealedDetails");
    let collector_end = engine.find("pub fn bundled_sidecar_path(").expect("sidecar resolution");
    let secrets = &engine[secret_start..secret_end];
    let sealed = &engine[collector_start..collector_end];
    assert!(secrets.contains("pub struct LinkHandback("));
    assert!(sealed.contains("pub struct DetailsRaw(") && sealed.contains("pub enum DetailsFailure"));
    for (name, code) in [
        ("calendar_details.rs", details.as_str()),
        ("SecretBytes / LinkHandback", secrets),
        ("invoke_sealed", body_after(&engine, "pub async fn invoke_sealed(")),
        ("SealedDetails / DetailsRaw / DetailsFailure", sealed),
    ] {
        for needle in ["println!", "eprintln!", "print!", "eprint!", "dbg!", "log::", "tracing::"] {
            assert!(!code.contains(needle), "{name} contains `{needle}` — sealed details must print nothing");
        }
    }
}

/// ⚠ NO `LinkUrl` LEAVES `DetailsState`, AND NO STATE LOCK SPANS AN AWAIT (R2-M10). `LinkUrl` is named in this module
/// only inside `HeldLink`; the snapshot (`handback_buffer`) returns bytes, never a `LinkUrl` or a `&LinkUrl`; and the
/// one `inner.lock()` sits in a NON-async helper (`with_state`), so no `MutexGuard` of the state can be held across an
/// `.await`, by construction.
#[test]
fn no_link_url_leaves_the_state_and_no_state_lock_spans_an_await() {
    let code = src("calendar_details.rs");
    let held = body_after(&code, "struct HeldLink");
    assert_eq!(code.matches("LinkUrl").count(), held.matches("LinkUrl").count(), "LinkUrl named outside HeldLink");
    assert!(held.contains("LinkUrl"), "HeldLink no longer holds a LinkUrl — the pin is vacuous");
    let snap = body_after(&code, "fn handback_buffer");
    let sig = &snap[..snap.find('{').expect("a body")];
    assert!(!sig.contains("LinkUrl") && sig.contains("Vec<u8>"), "the snapshot's signature: {sig}");
    assert!(snap.contains("link_url_bytes("), "the snapshot no longer reads the URLs — vacuous");
    assert_eq!(code.matches("inner.lock(").count(), 1, "a second lock site on the state");
    let helper = body_after(&code, "fn with_state");
    assert!(helper.contains("inner.lock("));
    let before = &code[..code.find("fn with_state").expect("with_state")];
    assert!(!before.trim_end().ends_with("async"), "with_state must not be async");
    assert!(!helper.contains(".await"));
}

/// ⚠ ONE READER OF A `LinkUrl`'s BYTES BESIDES THE LINK FILE (R2-M10, C "Later reads hand it back"): `link_url_bytes`
/// is called once in `src/`, by `calendar_details.rs`'s `handback_buffer`; `calendar.rs`'s own `url.bytes()` is the
/// link file writer's alone.
#[test]
fn link_url_bytes_has_one_caller_and_the_link_file_writer_is_the_only_other_reader() {
    let mut files = Vec::new();
    collect_rs(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    assert!(files.len() > 10);
    let mut calls = Vec::new();
    for f in &files {
        let code = production(&std::fs::read_to_string(f).expect("readable"));
        let n = code.matches("link_url_bytes(").count() - code.matches("fn link_url_bytes(").count();
        if n > 0 {
            calls.push((f.file_name().expect("a name").to_string_lossy().into_owned(), n));
        }
    }
    assert_eq!(calls, vec![("calendar_details.rs".to_string(), 1)]);
    assert!(body_after(&src("calendar_details.rs"), "fn handback_buffer").contains("link_url_bytes("));
    let cal = src("calendar.rs");
    assert!(body_after(&cal, "fn link_url_bytes").contains("u.bytes()"));
    assert_eq!(cal.matches("url.bytes()").count(), 1, "a second reader of a LinkUrl's bytes in calendar.rs");
    assert!(body_after(&cal, "fn write_link_file_as").contains("url.bytes()"));
}

/// ⚠ THE SEALED PATH'S `pub` ITEMS HAVE ONE PRODUCTION CALLER EACH (P5-M3, PC-M5): they are `pub` only so the
/// integration tests can reach them. In `src/`, `invoke_sealed(` and `LinkHandback::new(` are called only from
/// `calendar_details.rs`, and `DetailsRaw::parse(` only from `engine.rs` (its `SealedDetails`).
#[test]
fn the_sealed_paths_pub_items_have_one_production_caller_each() {
    let mut files = Vec::new();
    collect_rs(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let mut seen: Vec<(String, &str)> = Vec::new();
    for f in &files {
        let name = f.file_name().expect("a name").to_string_lossy().into_owned();
        let code = production(&std::fs::read_to_string(f).expect("readable"));
        for needle in [".invoke_sealed(", "LinkHandback::new(", "DetailsRaw::parse("] {
            for _ in 0..code.matches(needle).count() {
                seen.push((name.clone(), needle));
            }
        }
    }
    seen.sort();
    assert_eq!(
        seen,
        vec![
            ("calendar_details.rs".to_string(), ".invoke_sealed("),
            ("calendar_details.rs".to_string(), "LinkHandback::new("),
            ("engine.rs".to_string(), "DetailsRaw::parse("),
        ]
    );
    assert!(body_after(&src("engine.rs"), "impl Collect for SealedDetails").contains("DetailsRaw::parse("));
}

/// No held type derives or implements `Debug`, `Display`, `Clone` or `Serialize` (the in-module probes check `Debug`
/// and `Serialize` at compile time; this reads the declarations). Decoys first.
#[test]
fn no_held_type_derives_or_implements_a_printable_trait() {
    fn printable(code: &str, name: &str) -> Vec<String> {
        let mut found = Vec::new();
        let decl = regex::Regex::new(&format!(r"(?m)^[ \t]*(?:pub(?:\(crate\))? )?(?:struct|enum) {name}\b")).expect("regex");
        let m = decl.find(code).unwrap_or_else(|| panic!("`{name}` is not declared"));
        let lines: Vec<&str> = code[..m.start()].lines().collect();
        for l in lines.iter().rev() {
            let t = l.trim();
            if t.is_empty() {
                continue;
            }
            if !t.starts_with("#[") {
                break;
            }
            if t.starts_with("#[derive(") && ["Debug", "Clone", "Serialize"].iter().any(|b| t.contains(b)) {
                found.push(format!("{name}: {t}"));
            }
        }
        let imp = regex::Regex::new(&format!(
            r"impl\s*(?:<[^>]*>)?\s*(?:[A-Za-z_]+::)*(Debug|Display|Serialize|Clone)\s+for\s+{name}\b"
        ))
        .expect("regex");
        found.extend(imp.find_iter(code).map(|m| m.as_str().to_string()));
        found
    }
    assert_eq!(printable("#[derive(Debug)]\nstruct HeldLink {}\n", "HeldLink").len(), 1);
    assert_eq!(printable("struct HeldLink {}\nimpl Clone for HeldLink {}\n", "HeldLink").len(), 1);
    assert!(printable("#[derive(Default)]\nstruct HeldLink {}\nimpl Clone for HeldLinks {}\n", "HeldLink").is_empty());
    let code = src("calendar_details.rs");
    for name in ["HeldLink", "HeldEvent", "HeldJoin", "HeldRead", "DetailsState", "CalendarDetails"] {
        let found = printable(&code, name);
        assert!(found.is_empty(), "{found:?}");
    }
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("readable") {
        let path = entry.expect("an entry").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

/* ── one read in flight, against a fake engine ────────────────────────────────────────────────── */

/// A fake `calendar details` engine. Each spawn appends its argv to `spawns`, saves its stdin as `stdin-<n>`, waits
/// while `hold` exists until `release` does, then prints `doc.json`.
struct FakeEngine {
    scratch: ScratchDir,
    client: EngineClient,
    config: PathBuf,
}

impl FakeEngine {
    fn new(tag: &str) -> Self {
        let scratch = ScratchDir::new(tag);
        let p = |f: &str| sq(&scratch.join(f).display().to_string());
        let program = common::fake_sidecar(
            &scratch.path,
            "engine.sh",
            &format!(
                "echo \"$*\" >> {spawns}\nn=$(wc -l < {spawns} | tr -d ' ')\ncat > {dir}/stdin-$n\n\
                 if [ -e {hold} ]; then while [ ! -e {release} ]; do sleep 0.02; done; fi\ncat {doc}",
                spawns = p("spawns"),
                dir = sq(&scratch.path.display().to_string()),
                hold = p("hold"),
                release = p("release"),
                doc = p("doc.json"),
            ),
        );
        let config = scratch.join("config.json");
        std::fs::write(&config, r#"{"calendar":{"enabled":true,"links":[{"id":"work","urlCommand":"pw get cal"}]}}"#)
            .expect("write the config");
        Self { client: EngineClient::with_program(program), config, scratch }
    }

    fn answer(&self, text: &str) {
        std::fs::write(self.scratch.join("doc.json"), text).expect("write doc.json");
    }

    fn spawns(&self) -> Vec<String> {
        std::fs::read_to_string(self.scratch.join("spawns"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn stdin(&self, n: usize) -> String {
        std::fs::read_to_string(self.scratch.join(&format!("stdin-{n}"))).expect("the spawn's stdin")
    }

    fn state(&self) -> CalendarDetails {
        CalendarDetails::default().with_config_path(self.config.clone())
    }
}

/// The links' report with `work` holding `u` (or none).
fn work_doc(u: Option<&str>) -> String {
    let link = match u {
        Some(u) => serde_json::json!({ "id": "work", "entryHash": H1, "url": u }),
        None => serde_json::json!({ "id": "work", "entryHash": H1 }),
    };
    doc(&["Standup"], serde_json::json!([{ "id": "work", "kind": "link", "status": "ok" }]), serde_json::json!([link]))
}

#[derive(Clone)]
struct Env {
    env: Arc<LiveEnv>,
    clock: Arc<Mutex<Now>>,
    shown: Arc<AtomicBool>,
}

fn live_env() -> Env {
    let clock = Arc::new(Mutex::new(now("2026-10-24", 1_000_000)));
    let shown = Arc::new(AtomicBool::new(true));
    let (c, s) = (clock.clone(), shown.clone());
    let env = LiveEnv::default()
        .with_clock(Arc::new(move || c.lock().expect("clock").clone()))
        .with_visibility(Arc::new(move || Visibility { visible: s.load(Ordering::SeqCst), minimized: false }));
    Env { env: Arc::new(env), clock, shown }
}

async fn ask(
    state: &CalendarDetails,
    env: &Env,
    client: &EngineClient,
    reason: Reason,
    current: Option<CurrentSlide>,
) -> OpenReply {
    // The probe the env was built with, read directly: the command's own `|| env.visibility(&app)` is driven through
    // IPC in `tests/capability.rs`; here no MockRuntime app is needed.
    let shown = env.shown.clone();
    let visibility = move || Visibility { visible: shown.load(Ordering::SeqCst), minimized: false };
    let env = &env.env;
    match open_details(state, env, &visibility, client, reason, current).await {
        Ok(reply) => reply,
        Err(e) => panic!("the ask failed: {e}"),
    }
}

const CAL: Option<CurrentSlide> = Some(CurrentSlide::Calendar);

async fn wait_for(cond: impl Fn() -> bool, what: &str) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_read_hands_back_the_remembered_url_and_its_argv_follows_the_decision() {
    let fake = FakeEngine::new("cdhand");
    let e = live_env();
    let state = fake.state();
    fake.answer(&work_doc(Some(&url(7))));
    let first = ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await;
    assert_eq!(reply_json(&first)["gate"], "read");
    assert_eq!(fake.spawns(), vec!["calendar details --json"]);
    assert_eq!(fake.stdin(1), r#"{"links":[]}"#);
    // A focus read hands it back, skipping commands.
    let second = ask(&state, &e, &fake.client, Reason::Focus, CAL).await;
    assert_eq!(reply_json(&second)["gate"], "read");
    assert_eq!(fake.spawns()[1], "calendar details --json --skip-commands");
    let handed: serde_json::Value = serde_json::from_str(&fake.stdin(2)).expect("the handback is JSON");
    assert_eq!(handed, serde_json::json!({ "links": [{ "id": "work", "entryHash": H1, "url": url(7) }] }));
    // became-current with every URL held answers from the held read, spawning nothing.
    let held = ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await;
    assert_eq!(reply_json(&held)["gate"], "held");
    assert_eq!(fake.spawns().len(), 2);
    // Another slide: held, nothing read; a timer under the backstop: held.
    let other = ask(&state, &e, &fake.client, Reason::Focus, Some(CurrentSlide::GoodMorning)).await;
    assert_eq!(reply_json(&other)["gate"], "held");
    let early = ask(&state, &e, &fake.client, Reason::Timer, CAL).await;
    assert_eq!(reply_json(&early)["gate"], "held");
    assert_eq!(fake.spawns().len(), 2);
    // Past the backstop the timer reads, skipping commands.
    e.clock.lock().expect("clock").epoch_secs += 296;
    let late = ask(&state, &e, &fake.client, Reason::Timer, CAL).await;
    assert_eq!(reply_json(&late)["gate"], "read");
    assert_eq!(fake.spawns()[2], "calendar details --json --skip-commands");
    // Hidden: refused, nothing spawned.
    e.shown.store(false, Ordering::SeqCst);
    let hidden = ask(&state, &e, &fake.client, Reason::Focus, CAL).await;
    assert_eq!(reply_json(&hidden), serde_json::json!({ "refused": "hidden" }));
    assert_eq!(fake.spawns().len(), 3);
    // Another slide with no read held: none.
    let fresh = fake.state();
    let none = ask(&fresh, &e, &fake.client, Reason::Focus, Some(CurrentSlide::LeftOff)).await;
    assert_eq!(reply_json(&none), serde_json::json!({ "gate": "none" }));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_timer_read_skips_the_mac_source_while_its_last_status_is_denied() {
    let fake = FakeEngine::new("cdmac");
    let e = live_env();
    let state = fake.state();
    fake.answer(&doc(&[], serde_json::json!([{ "id": "macos", "kind": "macos", "status": "denied" }]), serde_json::json!([])));
    ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await;
    e.clock.lock().expect("clock").epoch_secs += 400;
    ask(&state, &e, &fake.client, Reason::Timer, CAL).await;
    assert_eq!(fake.spawns()[1], "calendar details --json --skip-mac --skip-commands");
    ask(&state, &e, &fake.client, Reason::Focus, CAL).await;
    assert_eq!(fake.spawns()[2], "calendar details --json --skip-commands", "focus must not skip the Mac source");
    // R3-M5: a timer with no valid held read (after midnight) still skips it.
    {
        let mut c = e.clock.lock().expect("clock");
        c.local_date = "2026-10-25".into();
    }
    ask(&state, &e, &fake.client, Reason::Timer, CAL).await;
    assert_eq!(fake.spawns()[3], "calendar details --json --skip-mac --skip-commands");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn an_invalidation_is_read_by_focus_and_timer_skipping_commands() {
    let fake = FakeEngine::new("cdinval");
    let e = live_env();
    let state = fake.state();
    fake.answer(&work_doc(None));
    ask(&state, &e, &fake.client, Reason::Timer, CAL).await;
    assert_eq!(fake.spawns()[0], "calendar details --json --skip-commands", "a timer with no read held");
    // A config change outside the app: focus reads, skipping commands, never "stale".
    std::fs::write(&fake.config, r#"{"calendar":{"enabled":true,"links":[{"id":"work","name":"W","urlCommand":"pw"}]}}"#)
        .expect("edit the config");
    let r = ask(&state, &e, &fake.client, Reason::Focus, CAL).await;
    assert_eq!(reply_json(&r)["gate"], "read");
    assert_eq!(fake.spawns()[1], "calendar details --json --skip-commands");
    // A day change: the timer reads, skipping commands.
    e.clock.lock().expect("clock").local_date = "2026-10-25".into();
    let r = ask(&state, &e, &fake.client, Reason::Timer, CAL).await;
    assert_eq!(reply_json(&r)["gate"], "read");
    assert_eq!(fake.spawns()[2], "calendar details --json --skip-commands");
}

/// Start an ask in its own task (an `Arc`'d state and env, a cloned client).
fn spawn_ask(
    state: &Arc<CalendarDetails>,
    env: &Env,
    client: &EngineClient,
    reason: Reason,
) -> tokio::task::JoinHandle<OpenReply> {
    let (state, env, client) = (state.clone(), env.clone(), client.clone());
    tokio::spawn(async move { ask(&state, &env, &client, reason, CAL).await })
}

/// ⚠ THE WAITER RE-SAMPLES AFTER THE LOCK (R3-M3) AND DECIDES AGAIN (R2-M1). A `became-current` waiting on an
/// in-flight read: (a) the window hidden meanwhile → `RefusedHidden`, no second spawn; (b) the clock past midnight
/// meanwhile → it reads itself; (c) the read now held and valid → the shared `Held`; (d) behind a `timer` read that
/// skipped a URL-less link → it reads again, with commands.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_ask_resamples_and_decides_again_after_the_read_in_flight() {
    for case in ["hidden", "midnight", "shared", "behind-timer"] {
        let fake = FakeEngine::new("cdwait");
        let e = live_env();
        let state = Arc::new(fake.state());
        std::fs::write(fake.scratch.join("hold"), "").expect("hold");
        let first_reason = if case == "behind-timer" { Reason::Timer } else { Reason::BecameCurrent };
        let first_url = url(1);
        fake.answer(&work_doc(if case == "behind-timer" { None } else { Some(&first_url) }));
        let first = spawn_ask(&state, &e, &fake.client, first_reason);
        wait_for(|| fake.spawns().len() == 1, "the first spawn").await;
        let second = spawn_ask(&state, &e, &fake.client, Reason::BecameCurrent);
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(fake.spawns().len(), 1, "{case}: the second ask did not wait");
        match case {
            "hidden" => e.shown.store(false, Ordering::SeqCst),
            "midnight" => e.clock.lock().expect("clock").local_date = "2026-10-25".into(),
            _ => {}
        }
        std::fs::write(fake.scratch.join("release"), "").expect("release");
        let a = first.await.expect("the first ask");
        if case == "midnight" {
            assert_eq!(reply_json(&a), serde_json::json!({ "failed": "day-changed" }));
        } else {
            assert_eq!(reply_json(&a)["gate"], "read", "{case}");
        }
        let b = second.await.expect("the second ask");
        // The release file stays, so a second spawn runs straight through.
        match case {
            "hidden" => {
                assert_eq!(reply_json(&b), serde_json::json!({ "refused": "hidden" }));
                assert_eq!(fake.spawns().len(), 1, "a hidden waiter spawned");
            }
            "midnight" => {
                assert_eq!(reply_json(&b)["gate"], "read");
                assert_eq!(fake.spawns().len(), 2);
            }
            "shared" => {
                assert_eq!(reply_json(&b)["gate"], "held");
                assert_eq!(fake.spawns().len(), 1, "the shared read was read twice");
            }
            _ => {
                assert_eq!(reply_json(&b)["gate"], "read");
                assert_eq!(
                    fake.spawns(),
                    vec!["calendar details --json --skip-commands", "calendar details --json"],
                    "behind a timer read, became-current must read again WITH commands"
                );
            }
        }
    }
}

/// A read that does not answer (here the engine's own failure) leaves no valid held read: the next ask reads.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_read_that_does_not_answer_holds_nothing() {
    let fake = FakeEngine::new("cdfail");
    let e = live_env();
    let state = fake.state();
    fake.answer(&format!("not a document {MARKER}"));
    let r = ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await;
    assert_eq!(reply_json(&r), serde_json::json!({ "failed": "malformed" }));
    fake.answer(&work_doc(Some(&url(1))));
    let r = ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await;
    assert_eq!(reply_json(&r)["gate"], "read");
    assert_eq!(fake.spawns().len(), 2);
}

/// Start with a real answered read so removing any of the three invalidation assignments is observable.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn non_answers_discard_an_answered_read_before_the_timer_backstop() {
    for case in ["malformed", "calendar-off", "engine-error"] {
        let fake = FakeEngine::new("cdnonanswer");
        let e = live_env();
        let state = fake.state();
        fake.answer(&work_doc(Some(&url(1))));
        let first = reply_json(&ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await);
        assert_eq!(first["gate"], "read", "{case}");
        let handle = first_handle(&first);
        assert!(matches!(details_get(&state, &e.env, &handle), GetReply::Card { .. }), "{case}");
        advance(&e, 1);
        match case {
            "engine-error" => {
                // A timeout is an EngineError after a spawn, rather than a DetailsFailure document.
                std::fs::write(fake.scratch.join("hold"), "").expect("hold");
                let client = fake.client.clone().with_timeout_cap(Duration::from_millis(500));
                let error = open_details(&state, &e.env, &|| SHOWN, &client, Reason::Focus, CAL)
                    .await.expect_err("the held engine must time out");
                assert!(matches!(error, EngineError::Timeout { .. }), "{error:?}");
                std::fs::write(fake.scratch.join("release"), "").expect("release");
            }
            _ => {
                fake.answer(if case == "malformed" {
                    "not a document"
                } else {
                    r#"{"schemaVersion":1,"refused":"calendar-off"}"#
                });
                let failed = reply_json(&ask(&state, &e, &fake.client, Reason::Focus, CAL).await);
                let expected = if case == "malformed" {
                    serde_json::json!({ "failed": "malformed" })
                } else {
                    serde_json::json!({ "refused": "calendar-off" })
                };
                assert_eq!(failed, expected, "{case}");
            }
        }
        assert_eq!(fake.spawns().len(), 2, "{case}: the non-answer did not run");
        // Check before another answer can replace the map and accidentally make this assertion pass.
        assert_eq!(details_get(&state, &e.env, &handle), GetReply::Refused { refused: "stale" }, "{case}");
        fake.answer(&work_doc(Some(&url(1))));
        advance(&e, 1); // Still only two injected seconds since the first answer, well inside 295 s.
        let timer = reply_json(&ask(&state, &e, &fake.client, Reason::Timer, CAL).await);
        assert_eq!(timer["gate"], "read", "{case}: a non-answer left a held read");
        assert_eq!(fake.spawns().len(), 3, "{case}: the timer did not spawn");
        assert_eq!(details_get(&state, &e.env, &handle), GetReply::Refused { refused: "stale" }, "{case}");
    }
}

/// Returning to the old day/config must not resurrect a refused read. This proves the events were purged,
/// without exposing held data through a public test accessor. Exercise open, get and join independently.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn invalid_reads_are_purged_and_cannot_be_resurrected() {
    for change in ["midnight", "config"] {
        for operation in ["open", "get", "join"] {
            let fake = FakeEngine::new("cdpurge");
            let e = live_env();
            let state = fake.state();
            fake.answer(&work_doc(Some(&url(1))));
            // An injected clock at day's end; advance both its date and epoch across midnight.
            *e.clock.lock().expect("clock") = Now { minutes: 23 * 60 + 59, ..now("2026-10-24", 1_000_000) };
            let old_clock = e.clock.lock().expect("clock").clone();
            let original_config = std::fs::read(&fake.config).expect("config");
            let first = reply_json(&ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await);
            let handle = first_handle(&first);
            assert!(matches!(details_get(&state, &e.env, &handle), GetReply::Card { .. }));
            if change == "midnight" {
                *e.clock.lock().expect("clock") = Now { minutes: 0, ..now("2026-10-25", old_clock.epoch_secs + 2) };
            } else {
                std::fs::write(&fake.config, r#"{"calendar":{"enabled":false}}"#).expect("change calendar");
            }
            match operation {
                "open" => {
                    // Another slide cannot spawn or replace the map, even with a stale read.
                    let answer = ask(&state, &e, &fake.client, Reason::Timer, Some(CurrentSlide::GoodMorning)).await;
                    assert_eq!(reply_json(&answer), serde_json::json!({ "gate": "none" }));
                }
                "get" => assert_eq!(details_get(&state, &e.env, &handle), GetReply::Refused { refused: "stale" }),
                _ => assert_eq!(join(&state, &e.env, &handle, true), JoinReply::Refused { refused: "stale" }),
            }
            assert_eq!(fake.spawns().len(), 1, "{change} {operation}: invalidation spawned");
            *e.clock.lock().expect("clock") = old_clock;
            std::fs::write(&fake.config, &original_config).expect("restore config");
            assert_eq!(
                details_get(&state, &e.env, &handle), GetReply::Refused { refused: "stale" },
                "{change} {operation}: restoring the generation resurrected held events"
            );
        }
    }
}

/* ── C-M3-T9: the remembered URL against a fake engine with a stub command ────────────────────── */

/// A fake `calendar details` engine that behaves as the engine does for ONE command-sourced link, `work`
/// (`src/calendar/pipeline.ts`'s details mode): a handed URL whose entry hash is the link's current one (`hash`) is
/// used and its command NOT run; with none, the stub command runs unless `--skip-commands` was given, and each run
/// appends a line to `counter`. The stub gives the URL in `url`, or nothing while `stub-fails` exists (the link's
/// status is then `malformed`, the engine's settled credential failure). `dead` makes the transfer refuse the URL
/// (`link-refused`: no URL reported back); `offline` reports `incomplete` / `unreachable` and keeps it; `off` answers
/// the calendar-off refusal. The child's stdin is echoed to its STDERR too, so a leak through stderr would carry it.
struct StubEngine {
    scratch: ScratchDir,
    client: EngineClient,
    config: PathBuf,
}

impl StubEngine {
    fn new(tag: &str) -> Self {
        let scratch = ScratchDir::new(tag);
        let d = sq(&scratch.path.display().to_string());
        let body = format!(
            r#"cd {d} || exit 3
echo "$*" >> spawns
n=$(wc -l < spawns | tr -d ' ')
cat > stdin-$n
cat stdin-$n >&2
if [ -e off ]; then printf '%s' '{{"schemaVersion":1,"refused":"calendar-off"}}'; exit 0; fi
case "$*" in *--skip-commands*) skip=1 ;; *) skip=0 ;; esac
hash=$(cat hash)
if grep -q "\"entryHash\":\"$hash\",\"url\":" stdin-$n; then handed=1; else handed=0; fi
url=""
status=ok
reason=""
if [ $handed = 1 ]; then url=$(cat url)
elif [ $skip = 0 ]; then echo run >> counter; if [ -e stub-fails ]; then status=malformed; else url=$(cat url); fi
fi
if [ -e dead ] && [ -n "$url" ]; then url=""; status=link-refused; fi
if [ -e offline ]; then status=incomplete; reason=',"reason":"unreachable"'; fi
if [ -n "$url" ]; then link="{{\"id\":\"work\",\"entryHash\":\"$hash\",\"url\":\"$url\"}}"; else link="{{\"id\":\"work\",\"entryHash\":\"$hash\"}}"; fi
if [ $skip = 1 ] && [ $handed = 0 ]; then src='{{"id":"work","kind":"link","command":true,"skipped":true}}'; else src="{{\"id\":\"work\",\"kind\":\"link\",\"command\":true,\"status\":\"$status\"$reason}}"; fi
printf '{{"schemaVersion":1,"readAt":"2026-10-24T09:00:00.000Z","events":[%s],"sources":[%s],"readerOutdated":false,"links":[%s]}}' "$(cat event.json)" "$src" "$link""#
        );
        let program = common::fake_sidecar(&scratch.path, "engine.sh", &body);
        let engine = Self {
            client: EngineClient::with_program(program),
            config: scratch.join("config.json"),
            scratch,
        };
        engine.set("hash", H1);
        engine.set("url", &url(1));
        engine.event(serde_json::json!({ "kind": "known", "url": format!("https://zoom.us/j/{MARKER}1?pwd=abc"), "host": "zoom.us" }));
        engine.config(r#"{"calendar":{"enabled":true,"links":[{"id":"work","urlCommand":"pw get cal"},{"id":"home","name":"H"}]}}"#);
        engine
    }

    fn set(&self, file: &str, text: &str) {
        std::fs::write(self.scratch.join(file), text).expect("write a fake file");
    }

    fn flag(&self, file: &str, on: bool) {
        if on {
            self.set(file, "");
        } else {
            let _ = std::fs::remove_file(self.scratch.join(file));
        }
    }

    fn event(&self, join: serde_json::Value) {
        let event = serde_json::json!({
            "title": "Standup", "location": "Room 4", "rowText": "09:30–09:45 Standup (Room 4)",
            "time": { "kind": "timed", "startMs": 1_000, "endMs": 2_000 },
            "status": "confirmed", "ended": false, "fromMac": true,
            "people": [{ "name": "Priya S.", "organiser": true }, { "name": null, "organiser": false }],
            "notes": "Agenda: the plan", "join": join
        });
        self.set("event.json", &event.to_string());
    }

    fn config(&self, text: &str) {
        std::fs::write(&self.config, text).expect("write the config");
    }

    fn runs(&self) -> usize {
        std::fs::read_to_string(self.scratch.join("counter")).map_or(0, |t| t.lines().count())
    }

    fn spawns(&self) -> Vec<String> {
        std::fs::read_to_string(self.scratch.join("spawns")).unwrap_or_default().lines().map(str::to_string).collect()
    }

    fn stdin(&self, n: usize) -> String {
        std::fs::read_to_string(self.scratch.join(&format!("stdin-{n}"))).expect("the spawn's stdin")
    }

    fn state(&self) -> CalendarDetails {
        CalendarDetails::default().with_config_path(self.config.clone())
    }
}

/// Every answer of a sequence, scanned for the marker (the reply, its `Debug`).
async fn step(s: &CalendarDetails, e: &Env, engine: &StubEngine, reason: Reason) -> serde_json::Value {
    reply_json(&ask(s, e, &engine.client, reason, CAL).await)
}

fn advance(e: &Env, secs: i64) {
    e.clock.lock().expect("clock").epoch_secs += secs;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_remembered_url_is_handed_back_and_its_command_runs_once_per_app_run() {
    let engine = StubEngine::new("cdstub");
    let e = live_env();
    let s = engine.state();
    assert_eq!(step(&s, &e, &engine, Reason::BecameCurrent).await["gate"], "read");
    assert_eq!(engine.runs(), 1, "the first move runs the command");
    assert_eq!(engine.stdin(1), r#"{"links":[]}"#);
    // Focus: handed back, the command not run.
    step(&s, &e, &engine, Reason::Focus).await;
    assert!(engine.stdin(2).contains(&url(1)), "the URL was not handed back on stdin");
    assert_eq!(engine.runs(), 1);
    // A timer past the backstop: handed back, not run.
    advance(&e, 400);
    assert_eq!(step(&s, &e, &engine, Reason::Timer).await["gate"], "read");
    assert!(engine.stdin(3).contains(&url(1)));
    assert_eq!(engine.runs(), 1);
    // became-current with the URL held and a valid held read answers Held WITHOUT a spawn — so to prove the handback
    // on a became-current read, the held read is invalidated first: (1) a day change through the clock…
    assert_eq!(step(&s, &e, &engine, Reason::BecameCurrent).await["gate"], "held");
    assert_eq!(engine.spawns().len(), 3);
    e.clock.lock().expect("clock").local_date = "2026-10-25".into();
    assert_eq!(step(&s, &e, &engine, Reason::BecameCurrent).await["gate"], "read");
    assert_eq!(engine.spawns().len(), 4, "the day change did not force a read");
    assert!(engine.stdin(4).contains(&url(1)));
    assert_eq!(engine.spawns()[3], "calendar details --json", "a became-current read runs with commands allowed");
    assert_eq!(engine.runs(), 1, "the handed URL was used instead of the command");
    // …and (2) an unrelated config change (another link's name).
    engine.config(r#"{"calendar":{"enabled":true,"links":[{"id":"work","urlCommand":"pw get cal"},{"id":"home","name":"Home"}]}}"#);
    assert_eq!(step(&s, &e, &engine, Reason::BecameCurrent).await["gate"], "read");
    assert_eq!(engine.spawns().len(), 5);
    assert!(engine.stdin(5).contains(&url(1)));
    assert_eq!(engine.runs(), 1);
    assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn an_own_entry_change_drops_the_url_and_other_changes_keep_it() {
    let engine = StubEngine::new("cdentry");
    let e = live_env();
    let s = engine.state();
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(engine.runs(), 1);
    // The Mac source, another link, and the calendar turned off then on: kept.
    engine.flag("off", true);
    assert_eq!(step(&s, &e, &engine, Reason::Focus).await, serde_json::json!({ "refused": "calendar-off" }));
    engine.flag("off", false);
    assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
    step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(engine.runs(), 1, "the calendar off and on dropped the URL");
    // Its own entry changes (the engine's hash moves): the handed URL is ignored, the focus read skips the link, and
    // Rust then holds no URL for it — so the next move runs the command again.
    engine.set("hash", H2);
    let r = step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(r["sources"][0]["skipped"], true);
    assert_eq!(r["sources"][0]["last"], serde_json::Value::Null, "the changed entry kept its last status");
    assert_eq!(s.held_links(), vec![("work".to_string(), false)]);
    assert_eq!(engine.runs(), 1);
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(engine.runs(), 2, "the next move did not run the command for the changed entry");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_command_is_not_repeated_by_focus_or_timer_and_runs_again_on_the_next_move() {
    let engine = StubEngine::new("cdfailcmd");
    let e = live_env();
    let s = engine.state();
    engine.flag("stub-fails", true);
    let r = step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(r["sources"][0]["status"], "malformed");
    assert_eq!(engine.runs(), 1);
    advance(&e, 400);
    let r = step(&s, &e, &engine, Reason::Timer).await;
    assert_eq!(engine.spawns()[1], "calendar details --json --skip-commands");
    assert_eq!(r["sources"][0]["skipped"], true);
    assert_eq!(r["sources"][0]["last"]["status"], "malformed", "the skipped link must show its last status");
    step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(engine.spawns()[2], "calendar details --json --skip-commands");
    assert_eq!(engine.runs(), 1, "focus or the timer re-ran a failed command");
    engine.flag("stub-fails", false);
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(engine.runs(), 2, "the next move did not retry the command");
    assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_url_is_dropped_and_an_offline_one_kept() {
    let engine = StubEngine::new("cddead");
    let e = live_env();
    let s = engine.state();
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    // Offline: kept and handed back, the command not run.
    engine.flag("offline", true);
    let r = step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(r["sources"][0]["reason"], "unreachable");
    engine.flag("offline", false);
    assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
    // Dead: dropped; focus then skips the link; the next move runs the command.
    engine.flag("dead", true);
    step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(s.held_links(), vec![("work".to_string(), false)]);
    engine.flag("dead", false);
    step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(engine.spawns().last().expect("a spawn"), "calendar details --json --skip-commands");
    assert!(!engine.stdin(engine.spawns().len()).contains(MARKER), "a dropped URL was handed back");
    assert_eq!(engine.runs(), 1);
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(engine.runs(), 2);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_value_link_url_refuses_is_not_held_and_focus_then_skips_the_link() {
    let engine = StubEngine::new("cdrefuse");
    let e = live_env();
    let s = engine.state();
    engine.set("url", &format!("http://plain.example/{MARKER}"));
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(s.held_links(), vec![("work".to_string(), false)]);
    step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(engine.spawns()[1], "calendar details --json --skip-commands");
    assert_eq!(engine.stdin(2), r#"{"links":[]}"#);
}

/// The new OD1 in Rust (R2-H1): a `timer` refused while hidden, then a `focus` once shown, reads with
/// `--skip-commands`; and a hidden refusal, a held reply and a read that does not answer each leave the URLs unchanged.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_hidden_refusal_is_not_owed_and_the_next_focus_reads_skipping_commands() {
    let engine = StubEngine::new("cdhidden");
    let e = live_env();
    let s = engine.state();
    engine.flag("stub-fails", true);
    e.shown.store(false, Ordering::SeqCst);
    assert_eq!(step(&s, &e, &engine, Reason::Timer).await, serde_json::json!({ "refused": "hidden" }));
    assert!(engine.spawns().is_empty());
    e.shown.store(true, Ordering::SeqCst);
    step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(engine.spawns(), vec!["calendar details --json --skip-commands"]);
    assert_eq!(engine.runs(), 0, "focus ran a command that has never run");
    engine.flag("stub-fails", false);
    step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(engine.runs(), 1);
    // A read that does not answer leaves the URL held.
    engine.set("event.json", "not json");
    advance(&e, 400);
    assert_eq!(step(&s, &e, &engine, Reason::Timer).await, serde_json::json!({ "failed": "malformed" }));
    assert_eq!(s.held_links(), vec![("work".to_string(), true)]);
}

/* ── get, join and the calendar app ───────────────────────────────────────────────────────────── */

use daily_briefing_gui_lib::calendar_details::{
    app_open, calendar_date_url, details_get, join, CalendarAppSink, GetReply, JoinReply,
};

fn first_handle(reply: &serde_json::Value) -> String {
    reply["events"][0]["handle"].as_str().expect("a handle").to_string()
}

/// Records each URL it is asked to open; launches nothing.
#[derive(Default)]
struct RecordingCalendarApp(Mutex<Vec<String>>);

impl CalendarAppSink for RecordingCalendarApp {
    fn open_calendar_app(&self, url: &str) -> Result<(), String> {
        self.0.lock().expect("urls").push(url.to_string());
        Ok(())
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn unavailable_details_survive_the_sealed_parse_held_map_and_card_reply() {
    let engine = StubEngine::new("cdgetmissing");
    let e = live_env();
    let s = engine.state();
    for people in [serde_json::Value::Null, serde_json::json!([])] {
        let mut answer: serde_json::Value = serde_json::from_str(&work_doc(None)).expect("fixture");
        answer["events"][0]["people"] = people.clone();
        answer["events"][0]["notes"] = serde_json::Value::Null;
        engine.set("event.json", &answer["events"][0].to_string());
        let r = step(&s, &e, &engine, Reason::Focus).await;
        assert_eq!(r["gate"], "read", "sealed reply rejected: {r}");
        let handle = first_handle(&r);
        assert_eq!(serde_json::to_value(details_get(&s, &e.env, &handle)).expect("JSON"),
            serde_json::json!({ "people": people, "notes": null }));
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_card_reads_people_and_notes_from_the_map_for_its_read_only() {
    let engine = StubEngine::new("cdget");
    let e = live_env();
    let s = engine.state();
    let r = step(&s, &e, &engine, Reason::BecameCurrent).await;
    let handle = first_handle(&r);
    let card = serde_json::to_value(details_get(&s, &e.env, &handle)).expect("serialises");
    assert_eq!(
        card,
        serde_json::json!({
            "people": [{ "name": "Priya S.", "organiser": true }, { "name": null, "organiser": false }],
            "notes": "Agenda: the plan"
        })
    );
    assert!(!card.to_string().contains(MARKER));
    assert_eq!(engine.spawns().len(), 1, "a card read the engine");
    // Another read replaces the map: the old handle is stale.
    let r2 = step(&s, &e, &engine, Reason::Focus).await;
    assert_ne!(first_handle(&r2), handle);
    let stale = serde_json::json!({ "refused": "stale" });
    assert_eq!(serde_json::to_value(details_get(&s, &e.env, &handle)).expect("JSON"), stale);
    let handle = first_handle(&r2);
    // A config change outside the app, and the day change: stale.
    engine.config(r#"{"calendar":{"enabled":true,"links":[{"id":"work","urlCommand":"pw get cal"}]}}"#);
    assert_eq!(serde_json::to_value(details_get(&s, &e.env, &handle)).expect("JSON"), stale);
    assert_eq!(serde_json::to_value(join(&s, &e.env, &handle, true)).expect("JSON"), stale);
    let r3 = step(&s, &e, &engine, Reason::Focus).await;
    let handle = first_handle(&r3);
    assert_ne!(serde_json::to_value(details_get(&s, &e.env, &handle)).expect("JSON"), stale);
    e.clock.lock().expect("clock").local_date = "2026-10-25".into();
    assert_eq!(serde_json::to_value(details_get(&s, &e.env, &handle)).expect("JSON"), stale);
    for bad in ["", "x", "0.0.0", &format!("{handle}x")] {
        assert_eq!(serde_json::to_value(details_get(&s, &e.env, bad)).expect("JSON"), stale, "{bad:?}");
    }
}

/// C09 Rust half: a merged event's `otherNotes` (one titled entry, one untitled entry with empty notes) travels from
/// the sealed answer through the held map to the card reply, in order and unchanged. The open reply never carries
/// it (notes travel only by handle), and a stale handle still refuses.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn c09_other_notes_reach_the_card_reply_by_handle_only() {
    let engine = StubEngine::new("cdothernotes");
    let e = live_env();
    let s = engine.state();
    let mut answer: serde_json::Value = serde_json::from_str(&work_doc(None)).expect("fixture");
    let other = serde_json::json!([
        { "title": "Ticket: Standup", "notes": "Bring the ticket.\nGate 4" },
        { "title": null, "notes": "" }
    ]);
    answer["events"][0]["otherNotes"] = other.clone();
    answer["events"][0]["notes"] = serde_json::json!("Agenda: the plan");
    engine.set("event.json", &answer["events"][0].to_string());
    let r = step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(r["gate"], "read", "sealed reply rejected: {r}");
    let ev = &r["events"][0];
    assert!(
        ev.get("otherNotes").is_none() && ev.get("notes").is_none() && ev.get("people").is_none(),
        "the open reply carried card data: {ev}"
    );
    assert!(!r.to_string().contains("Bring the ticket"), "other notes reached the open reply: {r}");
    assert!(!r.to_string().contains("Ticket: Standup"), "another view's title reached the open reply: {r}");
    let handle = first_handle(&r);
    let card = serde_json::to_value(details_get(&s, &e.env, &handle)).expect("serialises");
    assert_eq!(
        card,
        serde_json::json!({
            "people": [{ "name": "Priya Shah", "organiser": true }],
            "notes": "Agenda: the plan",
            "otherNotes": other
        })
    );
    assert!(!card.to_string().contains(MARKER));
    // Another read replaces the map: the old handle is stale, and its refusal carries no notes.
    let r2 = step(&s, &e, &engine, Reason::Focus).await;
    assert_ne!(first_handle(&r2), handle);
    assert_eq!(
        serde_json::to_value(details_get(&s, &e.env, &handle)).expect("JSON"),
        serde_json::json!({ "refused": "stale" })
    );
}

/// C09 compatibility: an answer without `otherNotes` (an unmerged or older event), or with an explicit null, gives a
/// card reply with no `otherNotes` key at all; an empty list stays an empty list.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn c09_an_answer_without_other_notes_gives_no_other_notes_key() {
    let engine = StubEngine::new("cdnoothernotes");
    let e = live_env();
    let s = engine.state();
    for (case, other) in [
        ("absent", None),
        ("null", Some(serde_json::Value::Null)),
        ("empty", Some(serde_json::json!([]))),
    ] {
        let mut answer: serde_json::Value = serde_json::from_str(&work_doc(None)).expect("fixture");
        if let Some(o) = &other {
            answer["events"][0]["otherNotes"] = o.clone();
        }
        engine.set("event.json", &answer["events"][0].to_string());
        let r = step(&s, &e, &engine, Reason::Focus).await;
        assert_eq!(r["gate"], "read", "{case}: sealed reply rejected: {r}");
        let card = serde_json::to_value(details_get(&s, &e.env, &first_handle(&r))).expect("JSON");
        assert_eq!(card["notes"], "notes for Standup", "{case}: {card}");
        match case {
            "empty" => assert_eq!(card["otherNotes"], serde_json::json!([]), "{case}: {card}"),
            _ => assert!(card.get("otherNotes").is_none(), "{case}: an otherNotes key appeared: {card}"),
        }
    }
}

/// C09 engine-shaped literal: the exact event JSON the engine's `detailsEventOf` emits for a merged event (pinned
/// byte for byte by the engine's `C09 engine-shaped literal` test against this same file) goes through the sealed
/// parse, the held map and the card reply unchanged. `RawEvent` ignores unknown fields, so the card's `otherNotes`
/// and `notes` are compared with the fixture's own values, read separately: a renamed or dropped field fails here.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn c09_the_engine_shaped_literal_reaches_the_card_reply_unchanged() {
    const LITERAL: &str = include_str!("fixtures/calendar-details-merged-event.json");
    let text = LITERAL.strip_suffix('\n').unwrap_or(LITERAL);
    let fixture: serde_json::Value = serde_json::from_str(text).expect("the fixture is JSON");
    let other = fixture["otherNotes"].as_array().expect("the fixture carries otherNotes");
    assert!(
        other.iter().any(|o| o["title"].is_string() && o["notes"].as_str().is_some_and(|n| !n.is_empty()))
            && other.iter().any(|o| o["title"].is_null()),
        "the fixture lost its titled or its untitled other entry: {fixture}"
    );
    assert!(fixture["notes"].is_string(), "the fixture lost its notes: {fixture}");
    let engine = StubEngine::new("cdliteral");
    let e = live_env();
    let s = engine.state();
    engine.set("event.json", text);
    let r = step(&s, &e, &engine, Reason::BecameCurrent).await;
    assert_eq!(r["gate"], "read", "sealed reply rejected the engine's literal: {r}");
    let card = serde_json::to_value(details_get(&s, &e.env, &first_handle(&r))).expect("serialises");
    assert_eq!(card["otherNotes"], fixture["otherNotes"], "card: {card}");
    assert_eq!(card["notes"], fixture["notes"], "card: {card}");
}

/// Join through a recording opener: the exact string opened, nothing for an ask-first link without `confirmed`, a
/// written port refused on the raw string, a Unicode host shown in punycode, and the opener's error never forwarded.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn join_opens_only_by_the_rules_and_through_the_sink() {
    let opener = Arc::new(common::RecordingOpener::default());
    let engine = StubEngine::new("cdjoin");
    let e = live_env();
    let s = engine.state().with_opener(opener.clone());
    let zoom = format!("https://zoom.us/j/{MARKER}1?pwd=abc");
    let handle = first_handle(&step(&s, &e, &engine, Reason::BecameCurrent).await);
    let opened = serde_json::to_value(join(&s, &e.env, &handle, false)).expect("JSON");
    assert_eq!(opened, serde_json::json!({ "opened": true }));
    assert_eq!(opener.urls(), vec![zoom.clone()]);

    // Schemes are case-insensitive: the URL parser normalises HTTPS and preserves the right host.
    engine.event(serde_json::json!({ "kind": "known", "url": "HTTPS://zoom.us/j/1", "host": "zoom.us" }));
    let upper = step(&s, &e, &engine, Reason::Focus).await;
    assert_eq!(upper["events"][0]["joinHost"], "zoom.us");
    let handle = first_handle(&upper);
    assert_eq!(join(&s, &e.env, &handle, false), JoinReply::Opened { opened: true });
    assert_eq!(opener.urls().last().expect("opened uppercase HTTPS"), "https://zoom.us/j/1");

    let cases: Vec<(serde_json::Value, serde_json::Value)> = vec![
        // Ask first: another host, as written.
        (
            serde_json::json!({ "kind": "other", "url": format!("https://Meet.Example.com/{MARKER}"), "host": "meet.example.com" }),
            serde_json::json!({ "ask": "meet.example.com" }),
        ),
        // Ask first, the service named.
        (
            serde_json::json!({ "kind": "service", "url": format!("https://whereby.com/{MARKER}"), "host": "whereby.com", "serviceName": "Whereby" }),
            serde_json::json!({ "ask": "whereby.com", "serviceName": "Whereby" }),
        ),
        // A Unicode host is shown in its ASCII (punycode) form.
        (
            serde_json::json!({ "kind": "other", "url": format!("https://bücher.example/{MARKER}"), "host": "xn--bcher-kva.example" }),
            serde_json::json!({ "ask": "xn--bcher-kva.example" }),
        ),
        // Refused on the raw string: a written default port, any port, userinfo, http.
        (
            serde_json::json!({ "kind": "known", "url": format!("https://zoom.us:443/j/{MARKER}"), "host": "zoom.us" }),
            serde_json::json!({ "refused": "invalid-link" }),
        ),
        (
            serde_json::json!({ "kind": "known", "url": format!("https://zoom.us:8443/j/{MARKER}"), "host": "zoom.us" }),
            serde_json::json!({ "refused": "invalid-link" }),
        ),
        (
            serde_json::json!({ "kind": "known", "url": format!("https://me:pw@zoom.us/j/{MARKER}"), "host": "zoom.us" }),
            serde_json::json!({ "refused": "invalid-link" }),
        ),
        // Even empty userinfo is forbidden: the URL parser alone normalises the written `@` away.
        (
            serde_json::json!({ "kind": "known", "url": "https://@zoom.us/j/1", "host": "zoom.us" }),
            serde_json::json!({ "refused": "invalid-link" }),
        ),
        (
            serde_json::json!({ "kind": "known", "url": format!("http://zoom.us/j/{MARKER}"), "host": "zoom.us" }),
            serde_json::json!({ "refused": "invalid-link" }),
        ),
        (serde_json::json!({ "kind": "several" }), serde_json::json!({ "refused": "several" })),
        (serde_json::Value::Null, serde_json::json!({ "refused": "no-link" })),
    ];
    for (candidate, unconfirmed) in cases {
        engine.event(candidate.clone());
        let handle = first_handle(&step(&s, &e, &engine, Reason::Focus).await);
        let before = opener.urls().len();
        let got = serde_json::to_value(join(&s, &e.env, &handle, false)).expect("JSON");
        assert_eq!(got, unconfirmed, "{candidate}");
        assert!(!got.to_string().contains(MARKER), "{got}");
        assert_eq!(opener.urls().len(), before, "{candidate}: opened without confirmation");
        if unconfirmed.get("ask").is_some() {
            assert_eq!(serde_json::to_value(join(&s, &e.env, &handle, true)).expect("JSON"), serde_json::json!({ "opened": true }));
            assert_eq!(opener.urls().len(), before + 1);
        } else {
            // A refused link stays refused whatever the webview asserts.
            assert_eq!(serde_json::to_value(join(&s, &e.env, &handle, true)).expect("JSON"), unconfirmed);
            assert_eq!(opener.urls().len(), before);
        }
    }
    // The opener's own error text (which could hold the URL) is never forwarded.
    let failing = Arc::new(common::RecordingOpener::failing(&format!("could not open {zoom}")));
    let s2 = engine.state().with_opener(failing);
    engine.event(serde_json::json!({ "kind": "known", "url": zoom, "host": "zoom.us" }));
    let handle = first_handle(&step(&s2, &e, &engine, Reason::BecameCurrent).await);
    let got = serde_json::to_value(join(&s2, &e.env, &handle, false)).expect("JSON");
    assert_eq!(got, serde_json::json!({ "failed": "opener" }));
}

#[test]
fn the_calendar_app_opens_on_macos_only_through_its_sink_on_the_clocks_instant() {
    let sink = Arc::new(RecordingCalendarApp::default());
    let s = CalendarDetails::default().with_calendar_app(sink.clone());
    let e = live_env();
    *e.clock.lock().expect("clock") = now("2026-10-31", 1_793_475_005); // 2026-10-31T19:30:05Z
    assert!(matches!(
        app_open(&s, &e.env, false),
        Err(daily_briefing_gui_lib::engine::EngineError::Unsupported { .. })
    ));
    assert!(sink.0.lock().expect("urls").is_empty());
    app_open(&s, &e.env, true).expect("opened");
    // The clock is sampled per call, never held.
    *e.clock.lock().expect("clock") = now("2028-02-29", 1_835_395_200);
    app_open(&s, &e.env, true).expect("opened");
    assert_eq!(
        *sink.0.lock().expect("urls"),
        ["ical://date/2026-10-31_19-30-05?method=show", "ical://date/2028-02-29_00-00-00?method=show"]
    );
}

#[test]
fn the_calendar_date_url_is_the_utc_instant_in_calendars_own_format() {
    assert_eq!(calendar_date_url(0), "ical://date/1970-01-01_00-00-00?method=show");
    assert_eq!(calendar_date_url(1_798_761_599), "ical://date/2026-12-31_23-59-59?method=show");
    assert_eq!(calendar_date_url(1_798_761_600), "ical://date/2027-01-01_00-00-00?method=show");
    assert_eq!(calendar_date_url(1_835_395_200), "ical://date/2028-02-29_00-00-00?method=show");
    assert_eq!(calendar_date_url(-1), "ical://date/1969-12-31_23-59-59?method=show");
}


#[test]
fn env_and_file_links_record_last_status_but_a_bad_command_report_does_not() {
    let s = CalendarDetails::default();
    let today = now("2026-10-24", 1_000);
    let answer = s.record_answer(&today, "gen", Ok(raw(&doc(&[], serde_json::json!([
        { "id": "env", "kind": "link", "command": false, "status": "ok" },
        { "id": "file", "kind": "link", "command": false, "status": "incomplete", "reason": "unreachable" },
        { "id": "command", "kind": "link", "command": true, "status": "ok" }
    ]), serde_json::json!([{ "id": "command", "entryHash": "bad" }])))));
    assert_eq!(last_of(&answer, "env")["status"], "ok");
    assert_eq!(last_of(&answer, "file")["status"], "incomplete");
    assert_eq!(last_of(&answer, "command"), serde_json::Value::Null);
    let skipped = s.record_answer(&today, "gen", Ok(raw(&doc(&[], serde_json::json!([
        { "id": "env", "kind": "link", "command": false, "skipped": true },
        { "id": "file", "kind": "link", "command": false, "skipped": true },
        { "id": "command", "kind": "link", "command": true, "skipped": true }
    ]), serde_json::json!([{ "id": "command", "entryHash": "bad" }])))));
    assert_eq!(last_of(&skipped, "env")["status"], "ok");
    assert_eq!(last_of(&skipped, "file")["reason"], "unreachable");
    assert_eq!(last_of(&skipped, "command"), serde_json::Value::Null);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_read_crossing_midnight_is_a_non_answer_and_purges_the_event_map() {
    let fake = FakeEngine::new("cdcrossmidnight");
    let e = live_env();
    let state = Arc::new(fake.state());
    fake.answer(&work_doc(Some(&url(1))));
    let first = ask(&state, &e, &fake.client, Reason::BecameCurrent, CAL).await;
    let handle = reply_json(&first)["events"][0]["handle"].as_str().expect("handle").to_string();
    std::fs::write(fake.scratch.join("hold"), "").expect("hold");
    fake.answer(&work_doc(Some(&url(2))));
    let read = spawn_ask(&state, &e, &fake.client, Reason::Focus);
    wait_for(|| fake.spawns().len() == 2, "the read before midnight").await;
    let before = e.clock.lock().expect("clock").clone();
    *e.clock.lock().expect("clock") = now("2026-10-25", before.epoch_secs + 2);
    std::fs::write(fake.scratch.join("release"), "").expect("release");
    let answer = read.await.expect("read");
    assert_eq!(reply_json(&answer), serde_json::json!({ "failed": "day-changed" }));
    // Rewind only to prove the old map was purged, rather than merely hidden by the current-day check.
    *e.clock.lock().expect("clock") = before;
    assert_eq!(details_get(&state, &e.env, &handle), GetReply::Refused { refused: "stale" });
    ask(&state, &e, &fake.client, Reason::Focus, CAL).await;
    let handed: serde_json::Value = serde_json::from_str(&fake.stdin(3)).expect("handback");
    assert_eq!(handed["links"][0]["url"], url(1), "a non-answer changed the remembered URL");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn join_refuses_backslashes_before_the_url_parser_normalises_them() {
    let opener = Arc::new(common::RecordingOpener::default());
    let engine = StubEngine::new("cdbackslash");
    let e = live_env();
    let state = engine.state().with_opener(opener.clone());
    for url in [r"https://zoom.us\evil.example/j/1", r"https://zoom.us\:443/j/1", r"https://zoom.us/j\1"] {
        engine.event(serde_json::json!({ "kind": "known", "url": url, "host": "zoom.us" }));
        let handle = first_handle(&step(&state, &e, &engine, Reason::Focus).await);
        assert_eq!(join(&state, &e.env, &handle, false), JoinReply::Refused { refused: "invalid-link" });
        assert_eq!(join(&state, &e.env, &handle, true), JoinReply::Refused { refused: "invalid-link" });
    }
    assert!(opener.urls().is_empty());
}

/// Round 5 L2: the URL opened must be on the host the webview was shown (and that decided ask-first): a held URL whose
/// parsed host is not the held Join host is refused as `invalid-link`, confirmed or not, and nothing opens.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn join_refuses_a_url_whose_parsed_host_is_not_the_held_join_host() {
    let opener = Arc::new(common::RecordingOpener::default());
    let engine = StubEngine::new("cdhostmatch");
    let e = live_env();
    let state = engine.state().with_opener(opener.clone());
    for (kind, url, host) in [
        ("known", format!("https://evil.example/j/{MARKER}1"), "zoom.us"),
        ("known", format!("https://zoom.us.evil.example/j/{MARKER}1"), "zoom.us"),
        ("other", format!("https://bücher.example/{MARKER}"), "bücher.example"),
        ("other", format!("https://meet.example.com/{MARKER}"), "other.example.com"),
    ] {
        engine.event(serde_json::json!({ "kind": kind, "url": url, "host": host }));
        let handle = first_handle(&step(&state, &e, &engine, Reason::Focus).await);
        for confirmed in [false, true] {
            let got = join(&state, &e.env, &handle, confirmed);
            assert_eq!(got, JoinReply::Refused { refused: "invalid-link" }, "{kind} {host} confirmed={confirmed}");
        }
    }
    assert!(opener.urls().is_empty());
    // PREMISE: the same stub with matching hosts opens (the refusal above is the host check, not the fixture).
    engine.event(serde_json::json!({ "kind": "known", "url": format!("https://zoom.us/j/{MARKER}1"), "host": "zoom.us" }));
    let handle = first_handle(&step(&state, &e, &engine, Reason::Focus).await);
    assert_eq!(join(&state, &e.env, &handle, false), JoinReply::Opened { opened: true });
    assert_eq!(opener.urls().len(), 1);
}
