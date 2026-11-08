//! A2-M4-T12 — the stored summary's text and record checks, and the read that binds a sidecar to the
//! latest page, against a fake engine whose `status --json` names a scratch state directory.
//!
//! Ordinary runs use Rust-written records and the shared JSON vectors, and claim no cross-language
//! chain. The two `summary_handoff_*` tests read the engine's real artifacts when the
//! `SUMMARY_HANDOFF` leg names them (plan §0.2); no test here launches Bun or sets the environment.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use common::{fake_sidecar, files_sidecar, ScratchDir};
use daily_briefing_gui_lib::briefing_files::{
    page_version_for, read_latest_briefing_at, PageVersionFields,
};
use daily_briefing_gui_lib::engine::EngineClient;
use daily_briefing_gui_lib::schedule_state::{StatusView, SummaryState, SummaryWarningCode};
use daily_briefing_gui_lib::summary::{
    is_summary_date, parse_stored_record, read_latest_summary_observed, read_latest_summary_with,
    validate_summary_text, SummaryProject, SummaryReadError, SummaryReply, SummaryRequest,
    MAX_RECORD_BYTES,
};
use serde_json::{json, Value};

const TEXT_VECTORS: &str = include_str!("fixtures/summary-text-vectors.json");
const RECORD_VECTORS: &str = include_str!("fixtures/summary-record-vectors.json");
const REFUSED_CHARS: &str = include_str!("fixtures/repos-request-limits.json");
const MODULE: &str = include_str!("../src/summary.rs");

const DATE: &str = "2026-01-11";
const NEXT_DAY: &str = "2026-01-12";
const PAGE: &str =
    "\u{2600}\u{fe0f}  Daily briefing \u{2014} 2026-01-11  (this machine: fixture)\n";
const POINT: &str = "Finished the harvest view.";
const SENTENCE: &str = "The harvest view is ready for its next pass.";

fn absent() -> SummaryReply {
    SummaryReply::Unavailable {
        warnings: Vec::new(),
    }
}

struct Sandbox {
    state: PathBuf,
    record: PathBuf,
    client: EngineClient,
    program: PathBuf,
    scratch: ScratchDir,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        let scratch = ScratchDir::new(tag);
        let state = scratch.join("state");
        let record = scratch.join("record");
        std::fs::create_dir_all(state.join("briefings")).unwrap();
        std::fs::create_dir_all(&record).unwrap();
        let program = files_sidecar(
            &scratch.path,
            "engine.sh",
            &state,
            &scratch.join("config.json"),
            &record,
        );
        Self {
            state,
            record,
            client: EngineClient::with_program(program.clone()),
            program,
            scratch,
        }
    }

    fn page_path(&self) -> PathBuf {
        self.state.join("briefing-latest.md")
    }

    fn briefings(&self) -> PathBuf {
        self.state.join("briefings")
    }

    fn mark(&self, date: &str) {
        std::fs::write(self.state.join("last-run"), format!("{date}\n")).unwrap();
    }

    /// A delivered page with its marker, and the request the page read would give the webview.
    fn delivered(&self) -> SummaryRequest {
        self.mark(DATE);
        std::fs::write(self.page_path(), PAGE).unwrap();
        self.current_request()
    }

    fn current_request(&self) -> SummaryRequest {
        let page = read_latest_briefing_at(&self.page_path()).unwrap();
        SummaryRequest {
            page_hash: page.page_hash.unwrap(),
            page_version: page.page_version.unwrap(),
        }
    }

    fn sidecar(&self, date: &str, request: &SummaryRequest) -> PathBuf {
        self.briefings().join(format!(
            "{date}.{}.{}.summary.json",
            request.page_hash, request.page_version
        ))
    }

    fn put(&self, date: &str, request: &SummaryRequest, raw: &str) -> PathBuf {
        let path = self.sidecar(date, request);
        std::fs::write(&path, raw).unwrap();
        path
    }

    fn spawned(&self) -> bool {
        self.record.join("argv.txt").exists()
    }

    /// `status --json` as the fake answers it, by running the script itself.
    fn status_reply(&self) -> String {
        let out = std::process::Command::new(&self.program)
            .args(["status", "--json"])
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    }

    async fn read(&self, request: &SummaryRequest) -> SummaryReply {
        read_latest_summary_with(&self.client, request)
            .await
            .unwrap()
    }
}

fn record_value(date: &str, request: &SummaryRequest, state: &str) -> Value {
    let ready = state == "ready";
    json!({
        "schemaVersion": 1,
        "pageDate": date,
        "pageHash": request.page_hash,
        "pageVersion": request.page_version,
        "state": state,
        "revision": i32::from(state != "pending"),
        "projects": if ready { json!([{"key": "project:orchard", "points": [POINT]}]) } else { json!([]) },
        "goodMorningSentence": if ready { json!(SENTENCE) } else { Value::Null },
        "warnings": [],
    })
}

fn ready_record(date: &str, request: &SummaryRequest) -> String {
    record_value(date, request, "ready").to_string()
}

fn ready_reply(request: &SummaryRequest) -> SummaryReply {
    SummaryReply::Ready {
        page_hash: request.page_hash.clone(),
        page_version: request.page_version.clone(),
        revision: 1,
        projects: vec![SummaryProject {
            key: "project:orchard".into(),
            points: vec![POINT.into()],
        }],
        good_morning_sentence: Some(SENTENCE.into()),
        warnings: Vec::new(),
    }
}

/* ── the fake engine's marker (Q-M4) ──────────────────────────────────────────────────────────── */

/// The reply `files_sidecar` gave before it read the marker, spelled out, so a change to the reply
/// for the callers that write no marker cannot pass by changing both sides.
fn pre_marker_status(state: &Path, config: &Path) -> String {
    let (state, config) = (state.display(), config.display());
    format!(
        "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"paths\":{{\"stateDir\":\"{state}\",\"configPath\":\"{config}\",\"markerPath\":\"{state}/last-run\",\"tickPath\":\"{state}/last-tick\",\"latestBriefingPath\":\"{state}/briefing-latest.md\",\"briefingsDir\":\"{state}/briefings\",\"lastSkipPath\":\"{state}/last-skip.json\",\"schedulePath\":\"{state}/schedule.json\"}},\"configExists\":true,\"configError\":null,\"lastRunDate\":null,\"lastSkip\":null,\"lastTick\":null,\"latestBriefingMtime\":null,\"archivedDates\":[],\"logBytes\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true}}"
    )
}

#[test]
fn the_fake_engine_reports_the_marker_and_is_unchanged_without_one() {
    let sandbox = Sandbox::new("summary-marker");
    let config = sandbox.scratch.join("config.json");
    let unmarked = pre_marker_status(&sandbox.state, &config);
    assert_eq!(sandbox.status_reply(), unmarked);
    sandbox.mark(DATE);
    assert_eq!(
        sandbox.status_reply(),
        unmarked.replace("\"lastRunDate\":null", "\"lastRunDate\":\"2026-01-11\"")
    );
}

/* ── the stored-text check ────────────────────────────────────────────────────────────────────── */

#[test]
fn every_shared_text_vector_gets_the_engines_answer() {
    let vectors: Value = serde_json::from_str(TEXT_VECTORS).unwrap();
    let rows = vectors["text"].as_array().unwrap();
    assert!(rows.len() > 200, "the vector list went missing");
    let mut wrong = Vec::new();
    for row in rows {
        let text = row["text"].as_str().unwrap();
        let expected = row["accepted"].as_bool().unwrap().then(|| text.trim());
        // Both caps, as the engine's own vector test runs each as a point and as the sentence.
        for cap in [90, 240] {
            if validate_summary_text(text, cap) != expected {
                wrong.push(format!("{text:?} at {cap}"));
            }
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[test]
fn the_refused_format_list_is_refused_and_its_neighbours_pass() {
    let limits: Value = serde_json::from_str(REFUSED_CHARS).unwrap();
    let chars = limits["chars"].as_array().unwrap();
    assert!(chars.len() > 40, "the character list went missing");
    for row in chars {
        let cp = u32::from_str_radix(row["cp"].as_str().unwrap().strip_prefix("U+").unwrap(), 16);
        let c = char::from_u32(cp.unwrap()).unwrap();
        // U+2028 and U+2029 are refused here whatever the shared flag says: they break a line.
        let refused = row["refused"].as_bool().unwrap() || matches!(c, '\u{2028}' | '\u{2029}');
        let text = format!("x{c}y");
        assert_eq!(
            validate_summary_text(&text, 90).is_none(),
            refused,
            "{}",
            row["cp"]
        );
    }
    for separator in ['\u{2028}', '\u{2029}'] {
        assert_eq!(validate_summary_text(&format!("x{separator}y"), 90), None);
        assert_eq!(validate_summary_text(&format!("{separator}x"), 90), None);
    }
}

#[test]
fn the_caps_count_scalars_after_the_trim() {
    for (cap, unit) in [(90, "a"), (90, "\u{1f980}"), (240, "a"), (240, "\u{1f980}")] {
        let exact = unit.repeat(cap);
        assert_eq!(validate_summary_text(&exact, cap), Some(exact.as_str()));
        let over = unit.repeat(cap + 1);
        assert_eq!(validate_summary_text(&over, cap), None);
        let padded = format!("  {exact}  ");
        assert_eq!(validate_summary_text(&padded, cap), Some(exact.as_str()));
    }
    assert_eq!(validate_summary_text("", 90), None);
    assert_eq!(validate_summary_text(" \u{3000} ", 90), None);
}

/* ── the stored record ────────────────────────────────────────────────────────────────────────── */

fn parse_vector(raw: &str, binding: &Value) -> Option<SummaryReply> {
    parse_stored_record(
        raw,
        binding["pageDate"].as_str().unwrap(),
        binding["pageHash"].as_str().unwrap(),
        binding["pageVersion"].as_str().unwrap(),
    )
}

#[test]
fn every_shared_record_vector_gets_the_engines_answer() {
    let vectors: Value = serde_json::from_str(RECORD_VECTORS).unwrap();
    let binding = &vectors["binding"];
    for row in vectors["valid"].as_array().unwrap() {
        let raw = row["record"].to_string();
        let name = &row["name"];
        let reply = parse_vector(&raw, binding).unwrap_or_else(|| panic!("{name} was refused"));
        // What crosses is exactly what was stored.
        let wire = serde_json::to_value(reply).unwrap();
        assert_eq!(wire["state"], row["record"]["state"], "{name}");
        assert_eq!(wire["warnings"], row["record"]["warnings"], "{name}");
        if row["record"]["state"] == "ready" {
            for member in [
                "pageHash",
                "pageVersion",
                "revision",
                "projects",
                "goodMorningSentence",
            ] {
                assert_eq!(wire[member], row["record"][member], "{name}: {member}");
            }
        }
    }
    let invalid = vectors["invalid"].as_array().unwrap();
    assert!(invalid.len() >= 39, "the vector list went missing");
    let mut accepted = Vec::new();
    for row in invalid {
        if parse_vector(row["raw"].as_str().unwrap(), binding).is_some() {
            accepted.push(row["name"].clone());
        }
    }
    assert!(accepted.is_empty(), "{accepted:#?}");
    // Membership needs the page's cards, which only the webview holds (M6): Rust checks syntax.
    for row in vectors["invalidMembership"].as_array().unwrap() {
        assert!(parse_vector(row["raw"].as_str().unwrap(), binding).is_some());
    }
}

/// Both readers run this list and give every row the same answer. A lone surrogate escape in a key
/// is refused by each: serde_json while decoding, the engine by the text rule's well-formedness test.
#[test]
fn stored_key_syntax_has_no_trim() {
    let vectors: Value = serde_json::from_str(RECORD_VECTORS).unwrap();
    let rows = vectors["storedKeys"].as_array().unwrap();
    assert!(rows.len() >= 20, "the vector list went missing");
    for row in rows {
        let name = row["name"].as_str().unwrap();
        let expected = row["accepted"].as_bool().unwrap();
        let actual = parse_vector(row["raw"].as_str().unwrap(), &vectors["binding"]).is_some();
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn the_date_rule_is_the_engines() {
    let vectors: Value = serde_json::from_str(RECORD_VECTORS).unwrap();
    let rows = vectors["dates"].as_array().unwrap();
    assert!(rows.len() >= 20, "the vector list went missing");
    for row in rows {
        let date = row["date"].as_str().unwrap();
        assert_eq!(
            is_summary_date(date),
            row["valid"].as_bool().unwrap(),
            "{date:?}"
        );
    }
}

#[test]
fn a_record_at_the_cap_is_read_and_one_byte_over_is_not() {
    let request = SummaryRequest {
        page_hash: "a".repeat(64),
        page_version: "b".repeat(64),
    };
    let raw = record_value(DATE, &request, "pending").to_string();
    let fit = format!("{raw}{}", " ".repeat(MAX_RECORD_BYTES - raw.len()));
    let parse =
        |text: &str| parse_stored_record(text, DATE, &request.page_hash, &request.page_version);
    assert!(parse(&fit).is_some());
    assert_eq!(parse(&format!("{fit} ")), None);
}

#[test]
fn a_record_bound_to_anything_else_is_refused() {
    let request = SummaryRequest {
        page_hash: "a".repeat(64),
        page_version: "b".repeat(64),
    };
    let raw = ready_record(DATE, &request);
    let (hash, version) = (&request.page_hash, &request.page_version);
    assert_eq!(
        parse_stored_record(&raw, DATE, hash, version),
        Some(ready_reply(&request))
    );
    let other = "c".repeat(64);
    assert_eq!(parse_stored_record(&raw, NEXT_DAY, hash, version), None);
    assert_eq!(parse_stored_record(&raw, DATE, &other, version), None);
    assert_eq!(parse_stored_record(&raw, DATE, hash, &other), None);
}

/* ── the read ─────────────────────────────────────────────────────────────────────────────────── */

#[tokio::test]
async fn a_bound_ready_record_crosses_exactly() {
    let sandbox = Sandbox::new("summary-ready");
    let request = sandbox.delivered();
    sandbox.put(DATE, &request, &ready_record(DATE, &request));
    let reply = sandbox.read(&request).await;
    assert_eq!(
        serde_json::to_value(reply).unwrap(),
        json!({
            "state": "ready",
            "pageHash": request.page_hash,
            "pageVersion": request.page_version,
            "revision": 1,
            "projects": [{"key": "project:orchard", "points": [POINT]}],
            "goodMorningSentence": SENTENCE,
            "warnings": [],
        })
    );
}

#[tokio::test]
async fn pending_and_unavailable_cross_with_their_fixed_codes_only() {
    let sandbox = Sandbox::new("summary-states");
    let request = sandbox.delivered();
    let mut record = record_value(DATE, &request, "pending");
    sandbox.put(DATE, &request, &record.to_string());
    assert_eq!(
        serde_json::to_value(sandbox.read(&request).await).unwrap(),
        json!({"state": "pending", "warnings": []})
    );
    record = record_value(DATE, &request, "unavailable");
    record["warnings"] = json!(["summary-usage-limit", "summary-unavailable"]);
    sandbox.put(DATE, &request, &record.to_string());
    assert_eq!(
        serde_json::to_value(sandbox.read(&request).await).unwrap(),
        json!({"state": "unavailable", "warnings": ["summary-usage-limit", "summary-unavailable"]})
    );
}

/// The date is the delivery marker's, not the clock's: past midnight the marker still says D, and
/// a sidecar named for any other day is never considered, including today's real date.
#[tokio::test]
async fn the_sidecar_date_is_the_markers_and_never_the_clock() {
    let sandbox = Sandbox::new("summary-date");
    let request = sandbox.delivered();
    let today = std::process::Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .unwrap();
    let today = String::from_utf8(today.stdout).unwrap();
    let today = today.trim();
    assert_ne!(today, DATE, "the fixture date is in the past");
    for decoy in [today, NEXT_DAY] {
        let mut record = record_value(decoy, &request, "ready");
        record["goodMorningSentence"] = json!("A sentence from the wrong day.");
        sandbox.put(decoy, &request, &record.to_string());
    }
    assert_eq!(
        sandbox.read(&request).await,
        absent(),
        "no record for the marker's date"
    );
    sandbox.put(DATE, &request, &ready_record(DATE, &request));
    assert_eq!(sandbox.read(&request).await, ready_reply(&request));
    // No marker, so no date to bind to: the same files are ordinary absence.
    std::fs::remove_file(sandbox.state.join("last-run")).unwrap();
    assert_eq!(sandbox.read(&request).await, absent());
    for clock in [
        "SystemTime",
        "Local",
        "chrono",
        "Now",
        "now()",
        "UNIX_EPOCH",
    ] {
        assert!(!MODULE.contains(clock), "{clock}");
    }
}

/// A hand-named sidecar under a date the engine's check refuses is never opened, even though its
/// shape is right and `last-run` says that date: `marker.ts` checks shape only.
#[tokio::test]
async fn a_malformed_marker_is_ordinary_absence() {
    let sandbox = Sandbox::new("summary-bad-marker");
    let request = sandbox.delivered();
    for bad in ["2026-02-30", "2026-13-01", "not-a-date", "2026-1-1", ""] {
        sandbox.mark(bad);
        std::fs::write(
            sandbox.briefings().join(format!(
                "{bad}.{}.{}.summary.json",
                request.page_hash, request.page_version
            )),
            ready_record(bad, &request),
        )
        .unwrap();
        assert_eq!(sandbox.read(&request).await, absent(), "{bad:?}");
    }
}

#[tokio::test]
async fn a_record_for_another_identity_is_never_reused() {
    let sandbox = Sandbox::new("summary-mismatch");
    let request = sandbox.delivered();
    sandbox.put(DATE, &request, &ready_record(DATE, &request));
    assert_eq!(sandbox.read(&request).await, ready_reply(&request));
    // Equal bytes from a new same-day write: same hash, a new version, and the old record stays.
    let replacement = sandbox.state.join("replacement");
    std::fs::write(&replacement, PAGE).unwrap();
    std::fs::rename(&replacement, sandbox.page_path()).unwrap();
    let newer = sandbox.current_request();
    assert_eq!(newer.page_hash, request.page_hash);
    assert_ne!(newer.page_version, request.page_version);
    assert_eq!(
        sandbox.read(&request).await,
        absent(),
        "the old identity asked"
    );
    assert_eq!(
        sandbox.read(&newer).await,
        absent(),
        "the new identity has no record"
    );
    // A record whose inside names another identity than its filename.
    sandbox.put(DATE, &newer, &ready_record(DATE, &request));
    assert_eq!(
        sandbox.read(&newer).await,
        absent(),
        "the record's own binding"
    );
    // The right file, with the wrong operand's hash.
    let wrong = SummaryRequest {
        page_hash: "c".repeat(64),
        page_version: newer.page_version.clone(),
    };
    sandbox.put(DATE, &wrong, &ready_record(DATE, &wrong));
    assert_eq!(sandbox.read(&wrong).await, absent());
}

/// A page dated before 1970: Bun reports its `mtimeNs` as 0 and Rust the true value, so the engine's
/// record and the webview's identity can never meet, and that fails closed (plan §0).
#[tokio::test]
async fn a_pre_epoch_page_gets_no_summary() {
    use std::os::unix::fs::MetadataExt;
    let sandbox = Sandbox::new("summary-pre-epoch");
    let request = sandbox.delivered();
    std::fs::OpenOptions::new()
        .write(true)
        .open(sandbox.page_path())
        .unwrap()
        .set_modified(UNIX_EPOCH - Duration::from_secs(86_400))
        .unwrap();
    let rust = sandbox.current_request();
    assert_eq!(rust.page_hash, request.page_hash);
    let meta = std::fs::symlink_metadata(sandbox.page_path()).unwrap();
    let (volume, file_id, size) = (
        meta.dev().to_string(),
        meta.ino().to_string(),
        meta.len().to_string(),
    );
    let ctime =
        (i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())).to_string();
    let engine = SummaryRequest {
        page_hash: rust.page_hash.clone(),
        page_version: page_version_for(&PageVersionFields {
            platform: "unix",
            volume: &volume,
            file_id: &file_id,
            size: &size,
            mtime_ns: "0",
            ctime_ns: &ctime,
        })
        .unwrap(),
    };
    assert_ne!(engine.page_version, rust.page_version);
    sandbox.put(DATE, &engine, &ready_record(DATE, &engine));
    assert_eq!(
        sandbox.read(&rust).await,
        absent(),
        "the webview's identity"
    );
    assert_eq!(
        sandbox.read(&engine).await,
        absent(),
        "the engine's identity"
    );
}

/// Every unsafe or unreadable record is the same ordinary reply: nothing about why, no path, no
/// OS error, no byte of what was stored.
#[tokio::test]
async fn an_unsafe_record_falls_back_and_nothing_about_it_crosses() {
    let sandbox = Sandbox::new("summary-unsafe");
    let request = sandbox.delivered();
    let path = sandbox.sidecar(DATE, &request);
    let hostile = "http://evil.example/SECRET";
    let mut unsafe_text = record_value(DATE, &request, "ready");
    unsafe_text["projects"][0]["points"] = json!([hostile]);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("malformed", b"{SECRET".to_vec()),
        ("unsafe text", unsafe_text.to_string().into_bytes()),
        ("not UTF-8", vec![0xff, 0xfe, b'{']),
        ("oversized", {
            let raw = ready_record(DATE, &request);
            let mut bytes = raw.into_bytes();
            bytes.resize(MAX_RECORD_BYTES + 1, b' ');
            bytes
        }),
    ];
    for (name, bytes) in cases {
        std::fs::write(&path, bytes).unwrap();
        let reply = sandbox.read(&request).await;
        assert_eq!(reply, absent(), "{name}");
    }
    // A symlink to a valid record, then a directory, then a FIFO that must not hang the read.
    std::fs::remove_file(&path).unwrap();
    let target = sandbox.state.join("elsewhere.json");
    std::fs::write(&target, ready_record(DATE, &request)).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert_eq!(sandbox.read(&request).await, absent(), "symlink");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert_eq!(sandbox.read(&request).await, absent(), "directory");
    std::fs::remove_dir(&path).unwrap();
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let read = tokio::time::timeout(Duration::from_secs(20), sandbox.read(&request));
    assert_eq!(read.await.expect("a FIFO hung the read"), absent(), "FIFO");
}

/// The engine's check refuses a symlinked archive directory, and the two readers must agree.
#[tokio::test]
async fn a_symlinked_archive_directory_is_absence() {
    let sandbox = Sandbox::new("summary-dir-link");
    let request = sandbox.delivered();
    let real = sandbox.state.join("real-briefings");
    std::fs::rename(sandbox.briefings(), &real).unwrap();
    std::os::unix::fs::symlink(&real, sandbox.briefings()).unwrap();
    sandbox.put(DATE, &request, &ready_record(DATE, &request));
    assert_eq!(sandbox.read(&request).await, absent());
}

#[tokio::test]
async fn an_unreadable_page_or_engine_is_absence_not_an_error() {
    let sandbox = Sandbox::new("summary-no-page");
    let request = sandbox.delivered();
    sandbox.put(DATE, &request, &ready_record(DATE, &request));
    // The page is gone, then a symlink to itself elsewhere, then not text.
    std::fs::remove_file(sandbox.page_path()).unwrap();
    assert_eq!(sandbox.read(&request).await, absent(), "missing page");
    let moved = sandbox.state.join("moved.md");
    std::fs::write(&moved, PAGE).unwrap();
    std::os::unix::fs::symlink(&moved, sandbox.page_path()).unwrap();
    assert_eq!(sandbox.read(&request).await, absent(), "symlinked page");
    std::fs::remove_file(sandbox.page_path()).unwrap();
    std::fs::write(sandbox.page_path(), [0xff]).unwrap();
    assert_eq!(sandbox.read(&request).await, absent(), "page not UTF-8");
    // An engine that fails, or answers something this app cannot read.
    for (name, body) in [
        ("fails", "printf 'SECRET path' >&2\nexit 1\n"),
        ("garbage", "printf 'not json'\n"),
        ("wrong shape", "printf '{\"paths\":7}'\n"),
    ] {
        let program = fake_sidecar(&sandbox.scratch.path, name, body);
        let client = EngineClient::with_program(program);
        let reply = read_latest_summary_with(&client, &request).await;
        assert_eq!(reply, Ok(absent()), "{name}");
    }
}

/// A relative path in `status --json` would resolve against this app's working directory, so either
/// one is absence and nothing opens. The marker, page and record are all good: the unchanged reply
/// through the same kind of fake is ready, so relativity alone explains the two absences.
#[tokio::test]
async fn a_relative_path_from_the_engine_is_absence_and_nothing_opens() {
    let sandbox = Sandbox::new("summary-relative");
    let request = sandbox.delivered();
    let sidecar = sandbox.put(DATE, &request, &ready_record(DATE, &request));
    let status: Value = serde_json::from_str(&sandbox.status_reply()).unwrap();
    assert_eq!(status["lastRunDate"], DATE);
    let answering = |name: &str, reply: &Value| {
        let body = format!("printf '%s' '{reply}'\n");
        EngineClient::with_program(fake_sidecar(&sandbox.scratch.path, name, &body))
    };

    let (opened, sink) = recording();
    let reply =
        read_latest_summary_observed(&answering("unchanged", &status), &request, sink).await;
    assert_eq!(reply, Ok(ready_reply(&request)));
    assert_eq!(*opened.lock().unwrap(), vec![sandbox.page_path(), sidecar]);

    for (name, field, relative) in [
        ("relative-page", "latestBriefingPath", "briefing-latest.md"),
        ("relative-dir", "briefingsDir", "briefings"),
    ] {
        let mut changed = status.clone();
        changed["paths"][field] = json!(relative);
        let (opened, sink) = recording();
        let reply = read_latest_summary_observed(&answering(name, &changed), &request, sink).await;
        assert_eq!(reply, Ok(absent()), "{name}");
        assert!(opened.lock().unwrap().is_empty(), "{name}");
    }
}

/* ── the operands (M7) ────────────────────────────────────────────────────────────────────────── */

fn recording() -> (Arc<Mutex<Vec<PathBuf>>>, impl FnMut(&Path) + Send) {
    let opened = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&opened);
    (opened, move |path: &Path| {
        sink.lock().unwrap().push(path.to_path_buf());
    })
}

#[test]
fn the_request_takes_exactly_two_string_members() {
    let good = "a".repeat(64);
    let parse = |value: Value| serde_json::from_value::<SummaryRequest>(value);
    assert!(parse(json!({"pageHash": good, "pageVersion": good})).is_ok());
    assert!(parse(json!({"pageHash": good, "pageVersion": good, "path": "/etc/passwd"})).is_err());
    assert!(parse(json!({"pageHash": good})).is_err());
    assert!(parse(json!({"pageVersion": good})).is_err());
    assert!(parse(json!({"pageHash": 7, "pageVersion": good})).is_err());
    assert!(parse(json!({"page_hash": good, "page_version": good})).is_err());
}

/// Refused as an operand, before the engine is asked and before any file is opened, with a real
/// valid record sitting where the traversal would land if the operand were ever joined to a path.
#[tokio::test]
async fn a_bad_operand_is_refused_before_anything_opens() {
    let sandbox = Sandbox::new("summary-operands");
    let good = sandbox.delivered();
    // The record's name is `<date>.<hash>.<version>.summary.json`, so the operand's first `..` is
    // absorbed into the directory name `<date>.<hash>...`. The next two leave that and `briefings/`.
    const TRAVERSAL: &str = "../../../sentinel";
    std::fs::create_dir(
        sandbox
            .briefings()
            .join(format!("{DATE}.{}...", good.page_hash)),
    )
    .unwrap();
    let sentinel = sandbox.state.join("sentinel.summary.json");
    std::fs::write(&sentinel, ready_record(DATE, &good)).unwrap();
    let landing = sandbox.briefings().join(format!(
        "{DATE}.{}.{TRAVERSAL}.summary.json",
        good.page_hash
    ));
    assert_eq!(
        std::fs::canonicalize(&landing).expect("the traversal must reach the planted file"),
        std::fs::canonicalize(&sentinel).unwrap(),
        "the operand no longer resolves to the sentinel, so its refusal would prove nothing"
    );
    let bad_values = [
        String::new(),
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        "g".repeat(64),
        format!("../{}", "a".repeat(61)),
        format!("{}\n", "a".repeat(63)),
        "\u{e9}".repeat(32),
        TRAVERSAL.to_string(),
    ];
    for bad in &bad_values {
        for request in [
            SummaryRequest {
                page_hash: bad.clone(),
                page_version: good.page_version.clone(),
            },
            SummaryRequest {
                page_hash: good.page_hash.clone(),
                page_version: bad.clone(),
            },
        ] {
            let (opened, sink) = recording();
            let reply = read_latest_summary_observed(&sandbox.client, &request, sink).await;
            assert_eq!(reply, Err(SummaryReadError::InvalidOperand), "{bad:?}");
            assert!(opened.lock().unwrap().is_empty(), "{bad:?}");
            assert!(!sandbox.spawned(), "{bad:?}: the engine was asked");
        }
    }
    assert_eq!(
        serde_json::to_value(SummaryReadError::InvalidOperand).unwrap(),
        json!({"kind": "invalidOperand"})
    );
}

/// A valid request opens the latest page and then the one constructed sidecar, and nothing else.
#[tokio::test]
async fn a_valid_request_opens_only_the_page_and_the_exact_sidecar() {
    let sandbox = Sandbox::new("summary-opens");
    let request = sandbox.delivered();
    let sidecar = sandbox.put(DATE, &request, &ready_record(DATE, &request));
    let (opened, sink) = recording();
    let reply = read_latest_summary_observed(&sandbox.client, &request, sink).await;
    assert_eq!(reply, Ok(ready_reply(&request)));
    assert_eq!(*opened.lock().unwrap(), vec![sandbox.page_path(), sidecar]);
    // A mismatched identity stops at the page: no sidecar is opened for it.
    let other = SummaryRequest {
        page_hash: "c".repeat(64),
        page_version: request.page_version.clone(),
    };
    let (opened, sink) = recording();
    let reply = read_latest_summary_observed(&sandbox.client, &other, sink).await;
    assert_eq!(reply, Ok(absent()));
    assert_eq!(*opened.lock().unwrap(), vec![sandbox.page_path()]);
}

#[test]
fn the_read_module_has_no_write_call() {
    for call in [
        "fs::write",
        "File::create",
        "remove_file",
        "rename(",
        "create_dir",
        "OpenOptions",
    ] {
        assert!(!MODULE.contains(call), "{call}");
    }
}

/* ── the staged handoff (plan §0.2): first exercised at T14's checkpoint ──────────────────────── */

/// The producer's root, or `None` for an ordinary run. Required mode with no root fails here,
/// before any fallback.
fn handoff_root() -> Option<PathBuf> {
    let root = std::env::var_os("DBA_SUMMARY_ROUNDTRIP_DIR").filter(|dir| !dir.is_empty());
    let required = std::env::var_os("DBA_SUMMARY_ROUNDTRIP_REQUIRED").is_some_and(|v| v == "1");
    assert!(
        root.is_some() || !required,
        "summary-handoff: required mode needs DBA_SUMMARY_ROUNDTRIP_DIR"
    );
    root.map(PathBuf::from)
}

fn artifact(root: &Path, name: &str) -> Value {
    let text = std::fs::read_to_string(root.join(name))
        .unwrap_or_else(|e| panic!("summary-handoff: {name} is required: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("summary-handoff: {name}: {e}"))
}

/// Run the production read against engine-shaped files under `state`, and check it against the
/// identity and values the writer recorded. `receipt` holds `pageHash`, `pageVersion`, `projects`
/// and `goodMorningSentence`.
async fn read_what_was_written(state: &Path, receipt: &Value) -> SummaryRequest {
    let scratch = ScratchDir::new("summary-handoff-read");
    let record = scratch.join("record");
    std::fs::create_dir_all(&record).unwrap();
    let program = files_sidecar(
        &scratch.path,
        "engine.sh",
        state,
        &scratch.join("config.json"),
        &record,
    );
    // The same live file the writer identified, recomputed here.
    let page = read_latest_briefing_at(&state.join("briefing-latest.md")).unwrap();
    assert_eq!(page.page_hash.as_deref(), receipt["pageHash"].as_str());
    assert_eq!(
        page.page_version.as_deref(),
        receipt["pageVersion"].as_str()
    );
    let request = SummaryRequest {
        page_hash: page.page_hash.unwrap(),
        page_version: page.page_version.unwrap(),
    };
    let client = EngineClient::with_program(program);
    let reply = read_latest_summary_with(&client, &request).await.unwrap();
    let wire = serde_json::to_value(reply).unwrap();
    assert_eq!(wire["state"], "ready");
    assert_eq!(wire["pageHash"], receipt["pageHash"]);
    assert_eq!(wire["pageVersion"], receipt["pageVersion"]);
    assert_eq!(wire["revision"], 1);
    assert_eq!(wire["projects"], receipt["projects"]);
    assert_eq!(wire["goodMorningSentence"], receipt["goodMorningSentence"]);
    assert_eq!(wire["warnings"], json!([]));
    request
}

#[tokio::test]
async fn summary_handoff_engine_store_read() {
    if let Some(root) = handoff_root() {
        let receipt = artifact(&root, "page-receipt.json");
        read_what_was_written(&root.join("state"), &receipt).await;
        // For T13's registered-IPC stage: the identity and values verified here.
        std::fs::write(root.join("reader-receipt.json"), receipt.to_string()).unwrap();
        return;
    }
    let sandbox = Sandbox::new("summary-handoff-native");
    let request = sandbox.delivered();
    sandbox.put(DATE, &request, &ready_record(DATE, &request));
    let receipt = json!({
        "pageHash": request.page_hash,
        "pageVersion": request.page_version,
        "projects": [{"key": "project:orchard", "points": [POINT]}],
        "goodMorningSentence": SENTENCE,
    });
    read_what_was_written(&sandbox.state, &receipt).await;
}

/// `want`: the page identity and the date the status must name, and the record's revision.
fn check_status_model(status_report: &Value, want: &Value, revision: u8) -> StatusView {
    let view: StatusView = serde_json::from_value(status_report.clone()).unwrap();
    assert!(view.ai_summary_status.enabled);
    assert_eq!(
        view.ai_summary_status.warnings,
        Vec::<SummaryWarningCode>::new()
    );
    assert_eq!(view.last_run_date.as_deref(), want["HANDOFF_DATE"].as_str());
    let latest = view.latest_summary_revision.clone().expect("a revision");
    assert_eq!(Some(latest.page_hash.as_str()), want["pageHash"].as_str());
    assert_eq!(
        Some(latest.page_version.as_str()),
        want["pageVersion"].as_str()
    );
    assert_eq!(latest.revision, revision);
    assert_eq!(latest.state, SummaryState::Ready);
    view
}

#[test]
fn summary_handoff_status_model() {
    if let Some(root) = handoff_root() {
        let receipt = artifact(&root, "page-receipt.json");
        let date = receipt["HANDOFF_DATE"].as_str().expect("HANDOFF_DATE");
        let name = format!(
            "{date}.{}.{}.summary.json",
            receipt["pageHash"].as_str().expect("pageHash"),
            receipt["pageVersion"].as_str().expect("pageVersion"),
        );
        let stored = artifact(&root.join("state").join("briefings"), &name);
        let revision = stored["revision"]
            .as_u64()
            .and_then(|r| u8::try_from(r).ok());
        let view = check_status_model(
            &artifact(&root, "status-report.json"),
            &receipt,
            revision.expect("the record's revision"),
        );
        std::fs::write(
            root.join("status-model.json"),
            serde_json::to_string(&view).unwrap(),
        )
        .unwrap();
        // The leading newline gives the receipt its own line under the harness's output.
        println!("\nsummary-handoff: status ok");
        return;
    }
    let hash = "a".repeat(64);
    let version = "b".repeat(64);
    check_status_model(
        &json!({
            "lastRunDate": DATE,
            "latestSummaryRevision": {"pageHash": hash, "pageVersion": version, "revision": 1, "state": "ready"},
            "aiSummaryStatus": {"enabled": true, "warnings": []},
        }),
        &json!({"HANDOFF_DATE": DATE, "pageHash": hash, "pageVersion": version}),
        1,
    );
}
