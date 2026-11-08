//! P3-M4-T3 — Replace, with a Rust-owned pending-reset store (`src/pending_resets.rs`, the matcher in
//! `src/key_refs.rs`); spec r9 §6 "Add, replace, remove" steps 1–4, plan P3-M4-T3, hub Q11/Q20/Q21.
//!
//! Driven through REAL IPC on a MockRuntime app built from the shipped handler, against a fake
//! engine inside a scratch sandbox — plus one test against the REAL sidecar (sandboxed, and only
//! the operations that read: `status`, `config validate`, and `provider reset`, which writes marks
//! under the sandbox's state folder). No test runs `/usr/bin/security` or touches a Keychain (Q27):
//! every `key delete` reaches the fake, and the real-engine test never deletes a key.
//!
//! ## The fake engine
//!
//! It answers `status --json` with a config path inside the scratch; `config validate --json --file`
//! with the report REGISTERED FOR THE STAGED BYTES — `<rec>/reports/<n>.cfg` holds a config's exact
//! bytes and `<n>.json` the report the engine gives them (`Rig::register`; `Rig::saved` writes the
//! config and registers it), matched with `cmp`, so a check that reads an OLDER config than the test
//! meant gets that older config's rows, as it would live (P3-M4-T3 checkpoint: a fake answering one
//! report whatever was staged let a missing `ConfigSaver.lock` pass). Bytes nobody registered get a
//! valid report with no rows (which vouches for nothing), and every validate fails outright while
//! `<rec>/validate-fail` exists (a transient engine failure); `provider reset --label-stdin` by
//! recording its stdin in `resets.txt` and answering `ok`, or `lock-held` while `<rec>/reset-lock`
//! exists, or a `config` refusal while `<rec>/reset-config` exists; `provider key delete --id` by
//! recording the id in `deleted.txt` and answering `ok` (or `write-failed` while
//! `<rec>/delete-fail` exists); and `provider key delete-all` by HOLDING (touching `holding`) while
//! `<rec>/hold` exists — the way these tests occupy the app's in-flight guard, so the next mutating
//! operation is refused `Busy` exactly as a running Test would make it.
//!
//! ## Turns
//!
//! The in-flight guard is process-global, so every test here takes [`TURN`] for its whole body.

mod common;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{fake_sidecar, sandbox_env, sq, ScratchDir};
use daily_briefing_gui_lib::config_save::ConfigSaver;
use daily_briefing_gui_lib::engine::{Engine, EngineClient, NoProgress, Operation};
use daily_briefing_gui_lib::key_refs::{
    combined_entries, entries_referencing_key, KeyRefs, RefVerdict,
};
use daily_briefing_gui_lib::pending_resets::{
    self, read_records, PendingRecord, PendingResets, Phase, MAX_DOUBTFUL_PASSES,
    PENDING_RESETS_FILE, RETRY_INTERVAL,
};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn turn() -> std::sync::MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(|e| e.into_inner())
}

const OLD: &str = "k-000000000001";
const NEW: &str = "k-0123456789ab";
const NEW2: &str = "k-ba9876543210";

/* ── the rig ──────────────────────────────────────────────────────────────────────────────────── */

struct Rig {
    config: PathBuf,
    rec: PathBuf,
    store: PathBuf,
    candidates: PathBuf,
    program: PathBuf,
    app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    _scratch: ScratchDir,
}

fn mock_app(
    client: EngineClient,
    candidates: &Path,
    store: &Path,
    interval: Duration,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(Engine(Ok(client)))
        .manage(ConfigSaver::with_candidate_dir(candidates))
        .manage(
            PendingResets::default()
                .with_store_dir(store)
                .with_retry_interval(interval),
        )
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(tauri::generate_context!())
        .expect("mock app");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");
    (app, webview)
}

fn engine_body(state: &Path, config: &Path, rec: &Path) -> String {
    let state = state.display();
    let config = config.display();
    let rec = rec.display();
    let ok_reset = sq(r#"{"schemaVersion":1,"ok":true,"cleared":true}"#);
    let lock_held = sq(
        r#"{"schemaVersion":1,"ok":false,"code":"lock-held","error":"reset: a briefing is running — retry later"}"#,
    );
    let config_refusal = sq(
        r#"{"schemaVersion":1,"ok":false,"code":"config","error":"reset: no entry has that label"}"#,
    );
    let deleted = sq(r#"{"schemaVersion":1,"ok":true,"deleted":true}"#);
    let delete_failed = sq(
        r#"{"schemaVersion":1,"ok":false,"code":"write-failed","reason":"failed","error":"key delete: the key could not be removed"}"#,
    );
    let unregistered = sq(
        r#"{"schemaVersion":1,"valid":true,"errors":[],"warnings":[],"normalized":{},"providers":[]}"#,
    );
    format!(
        r#"printf '%s\n' "$*" >> "{rec}/argv.txt"
case "$1:$2" in
  status:--json)
    printf '%s' "{{\"schemaVersion\":1,\"engineVersion\":\"0.1.1\",\"platform\":\"darwin\",\"paths\":{{\"stateDir\":\"{state}\",\"configPath\":\"{config}\",\"markerPath\":\"{state}/last-run\",\"tickPath\":\"{state}/last-tick\",\"latestBriefingPath\":\"{state}/briefing-latest.md\",\"briefingsDir\":\"{state}/briefings\",\"lastSkipPath\":\"{state}/last-skip.json\",\"schedulePath\":\"{state}/schedule.json\"}},\"configExists\":true,\"configError\":null,\"lastRunDate\":null,\"lastSkip\":null,\"lastTick\":null,\"latestBriefingMtime\":null,\"archivedDates\":[],\"logBytes\":null,\"morningTime\":{{\"value\":\"07:20\",\"minutes\":440,\"warning\":null}},\"isPastFloor\":true}}"
    ;;
  config:validate)
    cp "$5" "{rec}/validated.json"
    [ -e "{rec}/validate-fail" ] && exit 1
    [ -e "{rec}/slow-validate" ] && sleep 1
    for f in "{rec}"/reports/*.cfg; do
      [ -e "$f" ] || continue
      if cmp -s "$5" "$f"; then cat "${{f%.cfg}}.json"; exit 0; fi
    done
    printf '%s' {unregistered}
    ;;
  provider:reset)
    body="$(cat)"
    printf '%s\n' "$body" >> "{rec}/resets.txt"
    if [ -e "{rec}/reset-lock" ]; then printf '%s' {lock_held}; exit 3; fi
    if [ -e "{rec}/reset-config" ]; then printf '%s' {config_refusal}; exit 2; fi
    printf '%s' {ok_reset}
    ;;
  provider:key)
    case "$3" in
      delete)
        printf '%s\n' "$5" >> "{rec}/deleted.txt"
        if [ -e "{rec}/delete-fail" ]; then printf '%s' {delete_failed}; exit 1; fi
        printf '%s' {deleted}
        ;;
      delete-all)
        : > "{rec}/holding"
        while [ -e "{rec}/hold" ]; do sleep 0.02; done
        rm -f "{rec}/holding"
        printf '%s' '{{"schemaVersion":1,"ok":true,"deleted":0}}'
        ;;
    esac
    ;;
esac
exit 0"#
    )
}

/// ⚠ TAGS STAY SHORT: the candidate path runs through B3's `--file` validator, which refuses a path
/// segment over 64 characters (`tests/config_save.rs`'s note).
fn rig(tag: &str) -> Rig {
    rig_with_interval(tag, Duration::from_millis(100))
}

fn rig_with_interval(tag: &str, interval: Duration) -> Rig {
    let scratch = ScratchDir::new(tag);
    let state = scratch.join("state");
    let rec = scratch.join("rec");
    let xdg = scratch.join("xdg");
    for d in [&state, &rec, &xdg] {
        std::fs::create_dir_all(d).expect("sandbox dir");
    }
    let config = xdg.join("config.json");
    let store = scratch.join("app-data");
    let candidates = store.join("config-candidates");
    let program = fake_sidecar(
        &scratch.path,
        "engine.sh",
        &engine_body(&state, &config, &rec),
    );
    let (app, webview) = mock_app(
        EngineClient::with_program(program.clone()),
        &candidates,
        &store,
        interval,
    );
    Rig {
        config,
        rec,
        store,
        candidates,
        program,
        app,
        webview,
        _scratch: scratch,
    }
}

fn call(w: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("url"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    match get_ipc_response(w, request) {
        Ok(body) => Ok(body.deserialize().expect("a JSON response")),
        Err(e) => Err(e),
    }
}

fn kind(v: &Value) -> &str {
    v["kind"].as_str().unwrap_or("<no kind>")
}

/// A key command naming `id` — the engine's macOS reference shape. Rust never reads it: which key
/// an entry references is the engine's `config validate` row (`Rig::saved` writes that row).
fn key_command(id: &str) -> Value {
    json!([
        "/usr/bin/security",
        "find-generic-password",
        "-s",
        "daily-briefing.app-key",
        "-a",
        id,
        "-w",
        "/nonexistent-home/Library/Keychains/login.keychain-db"
    ])
}

fn api_entry(label: &str, id: &str) -> Value {
    json!({ "label": label, "api": { "kind": "anthropic", "model": "claude-x", "apiKeyCommand": key_command(id) } })
}

/// A saved config: a Claude CLI item 1 (`"default"`, index 0), then `fallbacks`.
fn saved_config(fallbacks: &[Value]) -> Value {
    json!({
        "provider": { "cli": "claude", "argv": ["-p"], "promptVia": "stdin" },
        "fallbacks": fallbacks,
    })
}

/// One `config validate` row: `Some(id)` — app-owned and naming `id`; `owned` with `None` — app-owned
/// naming no id (may read any app key); neither — not an app key.
fn row(index: usize, id: Option<&str>, owned: bool) -> Value {
    let mut r =
        json!({ "index": index, "testTimeoutMs": 80000, "loopback": false, "keyMoved": false });
    if owned || id.is_some() {
        r["appOwnedKey"] = json!(true);
    }
    if let Some(id) = id {
        r["appKeyId"] = json!(id);
    }
    r
}

fn report(rows: &[Value]) -> Value {
    json!({ "schemaVersion": 1, "valid": true, "errors": [], "warnings": [], "normalized": {}, "providers": rows })
}

/// A config's bytes exactly as the app writes them (`config_save::canonical_json`) and as a save
/// stages them for `config validate`.
fn bytes_of(config: &Value) -> String {
    serde_json::to_string_pretty(config).unwrap()
}

impl Rig {
    fn call(&self, cmd: &str, body: Value) -> Result<Value, Value> {
        call(&self.webview, cmd, body)
    }

    fn add(&self, label: &str, id: &str) -> Value {
        self.call(
            "provider_pending_reset_add",
            json!({ "label": label, "newKeyId": id }),
        )
        .unwrap_or_else(|e| panic!("add {label} {id}: {e}"))
    }

    fn flush(&self, label: &str, id: &str) -> Value {
        self.call(
            "provider_pending_reset_flush",
            json!({ "label": label, "newKeyId": id }),
        )
        .unwrap_or_else(|e| panic!("flush {label} {id}: {e}"))
    }

    fn drop_(&self, label: &str, id: &str) -> Value {
        self.call(
            "provider_pending_reset_drop",
            json!({ "label": label, "newKeyId": id }),
        )
        .unwrap_or_else(|e| panic!("drop {label} {id}: {e}"))
    }

    fn pass(&self) {
        tauri::async_runtime::block_on(pending_resets::retry_pass(self.app.handle()));
    }

    /// The saved config on disk, and the rows the fake engine reports for exactly those bytes.
    fn saved(&self, config: &Value, rows: &[Value]) {
        std::fs::write(&self.config, bytes_of(config)).unwrap();
        self.register(config, &report(rows));
    }

    /// The report the fake engine gives `config`'s exact bytes, whoever stages them (a save's own
    /// validation, or a reference check reading the saved file). Registering the same bytes again
    /// replaces their report.
    fn register(&self, config: &Value, report: &Value) {
        let dir = self.rec.join("reports");
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = bytes_of(config);
        let mut n = 0;
        while dir.join(format!("{n}.cfg")).exists() {
            if std::fs::read_to_string(dir.join(format!("{n}.cfg"))).unwrap() == bytes {
                break;
            }
            n += 1;
        }
        std::fs::write(dir.join(format!("{n}.cfg")), &bytes).unwrap();
        std::fs::write(
            dir.join(format!("{n}.json")),
            serde_json::to_string(report).unwrap(),
        )
        .unwrap();
    }

    /// The common shape: "Work" (index 1) saved with `id`.
    fn saved_work(&self, id: &str) {
        self.saved(
            &saved_config(&[api_entry("Work", id)]),
            &[row(0, None, false), row(1, Some(id), false)],
        );
    }

    fn records(&self) -> Vec<PendingRecord> {
        read_records(&self.store)
    }

    fn lines(&self, name: &str) -> Vec<String> {
        std::fs::read_to_string(self.rec.join(name))
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    fn deleted(&self) -> Vec<String> {
        self.lines("deleted.txt")
    }

    fn resets(&self) -> Vec<String> {
        self.lines("resets.txt")
    }

    fn flag(&self, name: &str, on: bool) {
        let p = self.rec.join(name);
        if on {
            std::fs::write(p, "").unwrap();
        } else {
            let _ = std::fs::remove_file(p);
        }
    }

    /// Occupy the in-flight guard with a held `key delete-all` until the returned guard drops.
    fn hold_in_flight(&self) -> Hold {
        self.flag("hold", true);
        let client = EngineClient::with_program(self.program.clone());
        let thread = std::thread::spawn(move || {
            tauri::async_runtime::block_on(client.invoke(Operation::KeyDeleteAll, &NoProgress))
        });
        let started = Instant::now();
        while !self.rec.join("holding").exists() {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the holder never started"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        Hold {
            flag: self.rec.join("hold"),
            thread: Some(thread),
        }
    }
}

struct Hold {
    flag: PathBuf,
    thread: Option<
        std::thread::JoinHandle<
            Result<
                daily_briefing_gui_lib::engine::EngineOutcome,
                daily_briefing_gui_lib::engine::EngineError,
            >,
        >,
    >,
}

impl Drop for Hold {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.flag);
        if let Some(t) = self.thread.take() {
            let out = t.join().expect("the holder thread");
            assert!(out.is_ok(), "the holder failed: {out:?}");
        }
    }
}

fn rec(label: &str, phase: Phase, id: &str) -> PendingRecord {
    rec_doubted(label, phase, id, 0)
}

/// A record whose reference check has been in doubt (transiently) on `passes` retry passes.
fn rec_doubted(label: &str, phase: Phase, id: &str, passes: u32) -> PendingRecord {
    PendingRecord {
        label: label.into(),
        phase,
        new_key_id: id.into(),
        doubtful_passes: passes,
    }
}

/// What a PREVIOUS run of the app left in the store.
fn left_behind(store: &Path, records: &[PendingRecord]) {
    std::fs::create_dir_all(store).unwrap();
    std::fs::write(
        store.join(PENDING_RESETS_FILE),
        serde_json::to_string(records).unwrap(),
    )
    .unwrap();
}

const WORK_RESET: &str = r#"{"label":"Work"}"#;

/* ── the matcher ──────────────────────────────────────────────────────────────────────────────── */

/// The matcher reads WHICH KEY from the engine's rows and only joins them to labels, by position,
/// through the settings guard's enumeration: a key-command reference and a key-file reference are
/// both found (the engine named the id on each row), and nothing else is — not an entry naming
/// another id, not an env key, not a login.
#[test]
fn the_matcher_finds_a_key_command_and_a_key_file_reference_and_nothing_else() {
    let config = json!({
        "provider": { "cli": "claude", "argv": ["-p"], "promptVia": "stdin",
            "accounts": [{ "label": "login 1" }, { "label": "login 2", "configDir": "~/.claude-2" }] },
        "fallbacks": [
            api_entry("cmd", NEW),
            { "label": "file", "api": { "kind": "anthropic", "model": "m", "apiKeyFile": format!("/s/keys/{NEW}.key") } },
            { "label": "env", "api": { "kind": "anthropic", "model": "m", "apiKeyEnv": "X" } },
            api_entry("other", NEW2),
        ],
    });
    let rows = [
        row(0, None, false),
        row(1, None, false),
        row(2, Some(NEW), false),
        row(3, Some(NEW), false),
        row(4, None, false),
        row(5, Some(NEW2), false),
    ];
    let labels: Vec<Option<&str>> = combined_entries(&config).iter().map(|e| e.label).collect();
    assert_eq!(
        labels,
        [
            Some("login 1"),
            Some("login 2"),
            Some("cmd"),
            Some("file"),
            Some("env"),
            Some("other")
        ]
    );
    let refs = entries_referencing_key(&config, &rows, NEW);
    assert_eq!(
        refs,
        KeyRefs::Known {
            definite: vec!["cmd".into(), "file".into()],
            possible: vec![]
        }
    );
    assert_eq!(refs.verdict("cmd"), RefVerdict::UnderLabel);
    assert_eq!(refs.verdict("file"), RefVerdict::UnderLabel);
    assert_eq!(refs.verdict("env"), RefVerdict::OtherLabel);
    let other = entries_referencing_key(&config, &rows, NEW2);
    assert_eq!(other.verdict("other"), RefVerdict::UnderLabel);
    assert_eq!(
        entries_referencing_key(&config, &rows, OLD).verdict("cmd"),
        RefVerdict::Unreferenced,
        "an id no row names is referenced nowhere"
    );

    // A row that may read ANY app key (app-owned, no id named) keeps every key in doubt.
    let mut ambiguous = rows.clone();
    ambiguous[4] = row(4, None, true);
    let refs = entries_referencing_key(&config, &ambiguous, OLD);
    assert_eq!(refs.verdict("cmd"), RefVerdict::Uncertain);
    assert_eq!(
        entries_referencing_key(&config, &ambiguous, NEW).verdict("cmd"),
        RefVerdict::UnderLabel,
        "a definite reference under the label still wins"
    );

    // Rows that cannot vouch for every written entry: nothing can be said.
    assert_eq!(
        entries_referencing_key(&config, &rows[..5], OLD),
        KeyRefs::Unknown,
        "a dropped entry has no row"
    );
    assert_eq!(
        entries_referencing_key(&config, &[], OLD),
        KeyRefs::Unknown,
        "no rows (a broken accounts list)"
    );
    let mut dup = rows.clone();
    dup[5] = row(4, None, false);
    assert_eq!(
        entries_referencing_key(&config, &dup, OLD),
        KeyRefs::Unknown,
        "an index twice"
    );
    let mut out_of_range = rows.clone();
    out_of_range[5] = row(9, Some(NEW2), false);
    assert_eq!(
        entries_referencing_key(&config, &out_of_range, OLD),
        KeyRefs::Unknown
    );
    let unlabelled =
        json!({ "provider": { "cli": "claude" }, "fallbacks": [{ "label": "  ", "api": {} }] });
    assert_eq!(
        combined_entries(&unlabelled)
            .iter()
            .map(|e| e.label)
            .collect::<Vec<_>>(),
        [Some("default"), None],
        "an unlabelled fallback keeps its position"
    );
    assert_eq!(
        entries_referencing_key(
            &unlabelled,
            &[row(0, None, false), row(1, Some(NEW), false)],
            NEW
        ),
        KeyRefs::Unknown,
        "a row for an entry with no usable label"
    );

    // Item 1 is labelled as the settings guard labels it: an API item 1 by `provider.label` (its
    // `accounts` ignored), else "default".
    let api_item1 = json!({ "provider": { "label": "Work key", "api": { "kind": "anthropic" }, "accounts": [{ "label": "x" }] } });
    assert_eq!(
        entries_referencing_key(&api_item1, &[row(0, Some(NEW), false)], NEW).verdict("Work key"),
        RefVerdict::UnderLabel
    );
    let bare = json!({ "provider": { "api": { "kind": "anthropic" } } });
    assert_eq!(
        entries_referencing_key(&bare, &[row(0, Some(NEW), false)], NEW).verdict("default"),
        RefVerdict::UnderLabel
    );
}

/// PR 3 final r4 (C5): a row whose `appOwnedKey` is present but not a boolean, or whose `appKeyId`
/// is present but not a string, is MALFORMED, and one malformed row makes the whole answer
/// [`KeyRefs::Unknown`] — the key is kept, as `any_app_key_referenced` keeps it. Before, such a row
/// read as "not an app key", so a key the entry may read could be called unreferenced.
#[test]
fn a_malformed_app_key_field_makes_the_answer_unknown() {
    let config = saved_config(&[api_entry("cmd", NEW)]);
    let with = |fields: Value| -> Vec<Value> {
        let mut r = row(1, None, false);
        for (k, v) in fields.as_object().unwrap() {
            r[k] = v.clone();
        }
        vec![row(0, None, false), r]
    };
    for (name, fields) in [
        ("appOwnedKey a string", json!({ "appOwnedKey": "yes" })),
        ("appOwnedKey null", json!({ "appOwnedKey": null })),
        ("appOwnedKey a number", json!({ "appOwnedKey": 1 })),
        ("appKeyId a number", json!({ "appKeyId": 5 })),
        (
            "appKeyId null",
            json!({ "appOwnedKey": true, "appKeyId": null }),
        ),
        (
            "appKeyId an array",
            json!({ "appOwnedKey": true, "appKeyId": [NEW] }),
        ),
        (
            "a string appOwnedKey beside a good id",
            json!({ "appOwnedKey": "true", "appKeyId": NEW }),
        ),
    ] {
        assert_eq!(
            entries_referencing_key(&config, &with(fields), OLD),
            KeyRefs::Unknown,
            "{name}"
        );
    }
    // Well-formed shapes stay decidable: `appOwnedKey: false` is "not an app key".
    assert_eq!(
        entries_referencing_key(&config, &with(json!({ "appOwnedKey": false })), OLD)
            .verdict("cmd"),
        RefVerdict::Unreferenced
    );
    assert_eq!(
        entries_referencing_key(
            &config,
            &with(json!({ "appOwnedKey": true, "appKeyId": NEW })),
            NEW
        )
        .verdict("cmd"),
        RefVerdict::UnderLabel
    );
}

/// The same answer from the REAL engine's rows, sandboxed: a key-command and a key-file reference
/// are found under their labels, through the real `config validate`; Discard of a key the saved
/// config uses keeps it and promotes the record; the promoted record's reset runs against the real
/// `provider reset --label-stdin`. Nothing here deletes a key (Q27: no Keychain is touched).
#[test]
fn the_real_engine_rows_decide_and_nothing_is_deleted() {
    let _t = turn();
    let scratch = ScratchDir::new("pr-real");
    let home = scratch.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let mut client = EngineClient::with_program(
        daily_briefing_gui_lib::engine::bundled_sidecar_path().expect("the bundled sidecar"),
    )
    .with_env("HOME", home.as_os_str());
    let env = sandbox_env(&scratch.path);
    let state = PathBuf::from(&env[0].1);
    for (key, value) in env {
        client = client.with_env(key, value);
    }
    let store = scratch.join("app-data");
    let (app, w) = mock_app(
        client,
        &store.join("cands"),
        &store,
        Duration::from_millis(50),
    );
    let doc = call(&w, "config_read", json!({})).expect("config_read");
    let config = PathBuf::from(doc["path"].as_str().expect("a path"));
    assert!(
        config.starts_with(&scratch.path),
        "the real engine reported a config OUTSIDE the sandbox ({}); refusing to go on",
        config.display()
    );
    let keys = state.join("keys");
    std::fs::create_dir_all(&keys).unwrap();
    let key_file = keys.join(format!("{NEW2}.key"));
    std::fs::write(&key_file, "not-a-real-key-0000").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let saved = json!({
        "provider": { "cli": "claude", "argv": ["-p"], "promptVia": "stdin" },
        "fallbacks": [
            { "label": "cmd", "api": { "kind": "anthropic", "model": "claude-x", "apiKeyCommand": [
                "/usr/bin/security", "find-generic-password", "-s", "daily-briefing.app-key", "-a", NEW, "-w",
                format!("{}/Library/Keychains/login.keychain-db", home.display())] } },
            { "label": "file", "api": { "kind": "anthropic", "model": "claude-x", "apiKeyFile": key_file.display().to_string() } },
            { "label": "env", "api": { "kind": "anthropic", "model": "claude-x", "apiKeyEnv": "SOME_KEY" } },
        ],
    });
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, serde_json::to_string_pretty(&saved).unwrap()).unwrap();

    let d = |label: &str, id: &str| {
        call(
            &w,
            "provider_pending_reset_drop",
            json!({ "label": label, "newKeyId": id }),
        )
        .unwrap_or_else(|e| panic!("drop {label}: {e}"))
    };
    assert_eq!(
        kind(&d("cmd", NEW)),
        "promoted",
        "the key command names NEW under cmd"
    );
    assert_eq!(
        kind(&d("file", NEW2)),
        "promoted",
        "the key file names NEW2 under file"
    );
    let kept = d("env", NEW);
    assert_eq!(kind(&kept), "kept", "{kept}");
    assert_eq!(kept["why"], "otherLabel", "{kept}");
    assert_eq!(
        read_records(&store),
        [
            rec("cmd", Phase::PostSave, NEW),
            rec("file", Phase::PostSave, NEW2)
        ]
    );
    // The promoted records' resets run against the real engine and clear them.
    tauri::async_runtime::block_on(pending_resets::retry_pass(app.handle()));
    assert_eq!(
        read_records(&store),
        [],
        "the real `provider reset --label-stdin` cleared both"
    );
    assert!(key_file.exists(), "nothing deleted the key file");
}

/* ── Discard / drop ───────────────────────────────────────────────────────────────────────────── */

#[test]
fn discard_drops_the_pre_save_record_and_deletes_the_unused_id() {
    let _t = turn();
    let r = rig("pr-discard");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    assert_eq!(r.records(), [rec("Work", Phase::PreSave, NEW)]);
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "deleted", "{out}");
    assert_eq!(r.deleted(), [NEW], "exactly the unused new id is deleted");
    assert_eq!(r.records(), []);
}

/// A waiting `post-save` record for the same label is never touched by a drop — neither by a drop
/// of another replacement for that label, nor by a drop naming the record itself (its save landed).
#[test]
fn a_drop_leaves_a_post_save_record_for_the_same_label_untouched() {
    let _t = turn();
    let r = rig("pr-dropps");
    r.saved_work(OLD);
    r.flag("reset-lock", true);
    assert_eq!(kind(&r.add("Work", NEW)), "retry");
    r.saved_work(NEW);
    assert_eq!(
        kind(&r.flush("Work", NEW)),
        "retry",
        "the post-save reset waits on the run lock"
    );
    assert_eq!(r.records(), [rec("Work", Phase::PostSave, NEW)]);
    // A second replacement of the same row, discarded.
    assert_eq!(kind(&r.add("Work", NEW2)), "retry");
    let out = r.drop_("Work", NEW2);
    assert_eq!(kind(&out), "deleted", "{out}");
    assert_eq!(r.deleted(), [NEW2]);
    assert_eq!(r.records(), [rec("Work", Phase::PostSave, NEW)]);
    // A drop naming the post-save record itself: the save landed, nothing is dropped or deleted —
    // not even once the saved config has moved on (a hand edit put the old key back), which would
    // otherwise read as "referenced nowhere".
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "promoted", "{out}");
    r.saved_work(OLD);
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "promoted", "{out}");
    assert_eq!(r.records(), [rec("Work", Phase::PostSave, NEW)]);
    assert_eq!(r.deleted(), [NEW2]);
}

/// A drop whose `key delete` is refused `Busy` (a Test holds the in-flight guard) keeps the record
/// as `discard`, and the retry task deletes the id later — the Keychain item is never orphaned.
#[test]
fn a_busy_delete_keeps_the_record_and_the_retry_task_deletes_it_later() {
    let _t = turn();
    let r = rig("pr-busydel");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    {
        let _held = r.hold_in_flight();
        let out = r.drop_("Work", NEW);
        assert_eq!(kind(&out), "deletePending", "{out}");
        assert_eq!(
            r.records(),
            [rec("Work", Phase::Discard, NEW)],
            "Busy keeps `discard`"
        );
        r.pass();
        assert_eq!(
            r.records(),
            [rec("Work", Phase::Discard, NEW)],
            "still busy: kept again"
        );
        assert_eq!(r.deleted(), [] as [&str; 0]);
    }
    r.pass();
    assert_eq!(r.deleted(), [NEW], "the retry task deleted it");
    assert_eq!(r.records(), []);
}

/// Hub Q21: Discard after the save completed keeps the key and promotes the record.
#[test]
fn discard_after_the_save_completed_keeps_and_promotes() {
    let _t = turn();
    let r = rig("pr-afters");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    r.saved_work(NEW);
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "promoted", "{out}");
    assert_eq!(r.records(), [rec("Work", Phase::PostSave, NEW)]);
    assert_eq!(
        r.deleted(),
        [] as [&str; 0],
        "a key the saved config uses is never deleted"
    );
    r.pass();
    assert_eq!(
        r.records(),
        [],
        "the promoted record's reset ran and cleared it"
    );
    assert_eq!(r.resets(), [WORK_RESET, WORK_RESET]);
}

/// Run `config_save` of "Work" switched to `id` (the bytes `saved_work(id)` would write, their rows
/// registered first) on its own thread, and call `during` once that save is INSIDE its validation —
/// holding the settings lock, the old config still on disk, the fake's validate held 1 s. Answers
/// `during`'s result once the save has answered `saved`.
fn while_saving_work<T>(r: &Rig, id: &str, during: impl FnOnce() -> T) -> T {
    let doc = r.call("config_read", json!({})).expect("config_read");
    let base = doc["base"].as_str().unwrap().to_string();
    let config = saved_config(&[api_entry("Work", id)]);
    r.register(
        &config,
        &report(&[row(0, None, false), row(1, Some(id), false)]),
    );
    let candidate = bytes_of(&config);
    let _ = std::fs::remove_file(r.rec.join("validated.json"));
    r.flag("slow-validate", true);
    let out = std::thread::scope(|s| {
        let w = &r.webview;
        let save =
            s.spawn(move || call(w, "config_save", json!({ "text": candidate, "base": base })));
        let started = Instant::now();
        while !r.rec.join("validated.json").exists() {
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the save never validated"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let before = std::fs::read_to_string(&r.config).unwrap();
        assert!(
            before.contains(OLD) && !before.contains(id),
            "the save had not written yet when the racer started"
        );
        let out = during();
        let saved = save.join().expect("the save thread").expect("the save");
        assert_eq!(kind(&saved), "saved", "{saved}");
        out
    });
    r.flag("slow-validate", false);
    out
}

/// Hub Q21: a save queued BEFORE the Discard holds the settings lock; the drop waits for it, then
/// reads the config the save wrote — so it never deletes the key that save committed. The fake's
/// rows follow the staged bytes: a drop that did NOT wait would read the old config, whose rows name
/// no `NEW`, and delete it.
#[test]
fn a_save_racing_discard_never_commits_a_deleted_key() {
    let _t = turn();
    let r = rig("pr-race");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    let out = while_saving_work(&r, NEW, || r.drop_("Work", NEW));
    assert_eq!(
        kind(&out),
        "promoted",
        "the drop read the config the save wrote: {out}"
    );
    assert_eq!(r.deleted(), [] as [&str; 0]);
    assert_eq!(r.records(), [rec("Work", Phase::PostSave, NEW)]);
}

/// Hub Q21, the retry task's side: a `discard` record's pass racing a save that puts its key back
/// in use waits for that save under the settings lock, re-checks, and promotes — never deleting the
/// key the save commits.
#[test]
fn the_retry_tasks_discard_pass_racing_a_save_never_deletes_its_key() {
    let _t = turn();
    let r = rig("pr-racetask");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    {
        let _held = r.hold_in_flight();
        assert_eq!(kind(&r.drop_("Work", NEW)), "deletePending");
    }
    assert_eq!(r.records(), [rec("Work", Phase::Discard, NEW)]);
    while_saving_work(&r, NEW, || r.pass());
    assert_eq!(
        r.deleted(),
        [] as [&str; 0],
        "the pass read the config the save wrote"
    );
    assert_eq!(r.records(), [], "promoted, and its reset cleared it");
    assert_eq!(r.resets(), [WORK_RESET, WORK_RESET]);
}

/// Hub Q21: a same-label Discard (its delete waiting on Busy) and a new replacement keep BOTH
/// records — they are keyed by `(label, newKeyId)`.
#[test]
fn a_same_label_discard_then_replace_keeps_both_records() {
    let _t = turn();
    let r = rig("pr-twice");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    let _held = r.hold_in_flight();
    assert_eq!(kind(&r.drop_("Work", NEW)), "deletePending");
    assert_eq!(
        kind(&r.add("Work", NEW2)),
        "retry",
        "Busy: the pre-save reset is retried"
    );
    assert_eq!(
        r.records(),
        [
            rec("Work", Phase::Discard, NEW),
            rec("Work", Phase::PreSave, NEW2)
        ]
    );
}

/// The rename case (plan Q11 DRAFT 5, hub Q21): the id is referenced, but under ANOTHER label —
/// the record is dropped and the key KEPT, from a drop and from a record found at start.
#[test]
fn a_key_referenced_only_under_another_label_is_kept_and_its_record_dropped() {
    let _t = turn();
    let r = rig("pr-rename");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    r.saved(
        &saved_config(&[api_entry("Renamed", NEW)]),
        &[row(0, None, false), row(1, Some(NEW), false)],
    );
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "kept", "{out}");
    assert_eq!(out["why"], "otherLabel", "{out}");
    assert_eq!(r.records(), []);

    left_behind(&r.store, &[rec("Work", Phase::PreSave, NEW2)]);
    r.saved(
        &saved_config(&[api_entry("Renamed", NEW2)]),
        &[row(0, None, false), row(1, Some(NEW2), false)],
    );
    r.pass();
    assert_eq!(r.records(), []);
    assert_eq!(r.deleted(), [] as [&str; 0], "neither key is deleted");
}

/// Hub Q21: a `key delete` failing for any reason but `Busy` drops the record and leaves the orphan
/// id for uninstall's `delete-all` (nothing retries forever).
#[test]
fn a_non_busy_delete_failure_drops_the_record() {
    let _t = turn();
    let r = rig("pr-delfail");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    r.flag("delete-fail", true);
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "deleteFailed", "{out}");
    assert_eq!(r.deleted(), [NEW], "it was tried once");
    assert_eq!(r.records(), []);
}

/// Hub Q21: a missing or unreadable saved config — or rows that cannot vouch for every entry —
/// counts as referenced: nothing is deleted.
#[test]
fn an_unreadable_saved_config_deletes_nothing() {
    let _t = turn();
    let r = rig("pr-unread");
    for setup in ["missing", "garbage", "dropped-entry", "may-read-any"] {
        match setup {
            "missing" => {
                let _ = std::fs::remove_file(&r.config);
            }
            "garbage" => std::fs::write(&r.config, "this is not JSON").unwrap(),
            "dropped-entry" => r.saved(
                &saved_config(&[api_entry("Work", OLD), api_entry("Work", OLD)]),
                &[row(0, None, false), row(1, Some(OLD), false)],
            ),
            _ => r.saved(
                &saved_config(&[api_entry("Work", OLD), api_entry("Mine", OLD)]),
                &[
                    row(0, None, false),
                    row(1, Some(OLD), false),
                    row(2, None, true),
                ],
            ),
        }
        assert_eq!(kind(&r.add("Work", NEW)), "reset", "{setup}");
        let out = r.drop_("Work", NEW);
        assert_eq!(kind(&out), "kept", "{setup}: {out}");
        assert_eq!(out["why"], "unverified", "{setup}: {out}");
        assert_eq!(r.records(), [], "{setup}");
    }
    assert_eq!(r.deleted(), [] as [&str; 0]);
}

/* ── reset before and after the save ──────────────────────────────────────────────────────────── */

/// Spec §6 steps 2–3: a reset BEFORE the save (which does not clear the record) and one AFTER it
/// (which does).
#[test]
fn reset_before_and_after_the_save() {
    let _t = turn();
    let r = rig("pr-bracket");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    assert_eq!(
        r.resets(),
        [WORK_RESET],
        "the label went to the engine on stdin"
    );
    assert_eq!(
        r.records(),
        [rec("Work", Phase::PreSave, NEW)],
        "a successful PRE-save reset does not clear the record"
    );
    r.saved_work(NEW);
    assert_eq!(kind(&r.flush("Work", NEW)), "reset");
    assert_eq!(r.resets(), [WORK_RESET, WORK_RESET]);
    assert_eq!(r.records(), [], "the post-save reset cleared it");
    assert_eq!(
        r.deleted(),
        [] as [&str; 0],
        "Replace never deletes the old id"
    );
    let argv = r.lines("argv.txt");
    assert!(
        argv.iter().all(|a| !a.contains("Work")),
        "a label reached argv: {argv:?}"
    );
}

/// A save delayed beyond one retry interval — the run lock held across several of the editor's
/// 15 s retries: the pre-save reset completes, then the save, and only the post-save reset clears
/// the record. Meanwhile the store's own retry task leaves the editor's `pre-save` record alone.
#[test]
fn a_delayed_save_completes_the_pre_save_reset_then_the_save_then_the_post_save_reset() {
    let _t = turn();
    let r = rig("pr-delay");
    r.saved_work(OLD);
    r.flag("reset-lock", true);
    assert_eq!(kind(&r.add("Work", NEW)), "retry");
    r.pass();
    assert_eq!(
        kind(&r.add("Work", NEW)),
        "retry",
        "the editor's next retry"
    );
    r.pass();
    assert_eq!(r.records(), [rec("Work", Phase::PreSave, NEW)]);
    assert_eq!(
        r.resets().len(),
        2,
        "only the editor's two tries reached the engine"
    );
    r.flag("reset-lock", false);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    assert_eq!(r.records(), [rec("Work", Phase::PreSave, NEW)]);
    r.saved_work(NEW);
    assert_eq!(kind(&r.flush("Work", NEW)), "reset");
    assert_eq!(r.records(), []);
    assert_eq!(r.deleted(), [] as [&str; 0]);
}

/// An `EngineError::Busy` during a retry is retried, not dropped.
#[test]
fn a_busy_reset_during_a_retry_is_retried_not_dropped() {
    let _t = turn();
    let r = rig("pr-busyre");
    r.saved_work(NEW);
    r.flag("reset-lock", true);
    assert_eq!(kind(&r.flush("Work", NEW)), "retry");
    r.flag("reset-lock", false);
    {
        let _held = r.hold_in_flight();
        r.pass();
        assert_eq!(
            r.records(),
            [rec("Work", Phase::PostSave, NEW)],
            "Busy is retryable"
        );
    }
    r.pass();
    assert_eq!(r.records(), []);
}

/// A non-busy refusal of the pre-save reset drops the record and is reported.
#[test]
fn a_non_busy_refusal_drops_the_record() {
    let _t = turn();
    let r = rig("pr-refuse");
    r.saved_work(OLD);
    r.flag("reset-config", true);
    let out = r.add("Work", NEW);
    assert_eq!(kind(&out), "refused", "{out}");
    assert_eq!(out["code"], "config", "{out}");
    assert_eq!(r.records(), []);
    assert_eq!(
        r.deleted(),
        [] as [&str; 0],
        "the editor's Discard decides the key"
    );
}

/// A `post-save` record whose label is no longer saved is dropped (the engine refuses the label).
#[test]
fn a_record_for_a_removed_label_is_dropped() {
    let _t = turn();
    let r = rig("pr-gone");
    left_behind(&r.store, &[rec("Gone", Phase::PostSave, NEW)]);
    r.saved_work(OLD);
    r.flag("reset-config", true);
    r.pass();
    assert_eq!(r.records(), []);
    assert_eq!(r.deleted(), [] as [&str; 0]);
}

/// PR 3 final r4 (C2): `add` for a `(label, key)` whose record is already `discard` — a replacement
/// being thrown away — refuses, runs NO reset, and leaves the `discard` record as it was (its delete
/// is the retry task's). Defence in depth: the editor never re-adds a discarded replacement.
#[test]
fn add_refuses_a_replacement_already_being_discarded() {
    let _t = turn();
    let r = rig("pr-add-disc");
    r.saved_work(OLD);
    left_behind(&r.store, &[rec_doubted("Work", Phase::Discard, NEW, 2)]);
    let out = r.add("Work", NEW);
    assert_eq!(kind(&out), "refused", "{out}");
    assert_eq!(out["detail"], "this replacement was discarded", "{out}");
    assert_eq!(
        r.resets(),
        [] as [&str; 0],
        "no reset for a discarded replacement"
    );
    assert_eq!(r.records(), [rec_doubted("Work", Phase::Discard, NEW, 2)]);
    assert_eq!(r.deleted(), [] as [&str; 0]);
}

/// PR 3 final r4 (C1): a record MOVED to another phase starts with no doubt counted. A `pre-save`
/// record left behind with transient doubts already counted is promoted to `post-save` once the
/// check vouches; while its reset waits on the run lock, the `post-save` record carries 0 doubtful
/// passes, not the `pre-save` record's count.
#[test]
fn a_record_moved_to_another_phase_starts_with_no_doubt_counted() {
    let _t = turn();
    let r = rig("pr-phase0");
    r.saved_work(NEW);
    left_behind(&r.store, &[rec_doubted("Work", Phase::PreSave, NEW, 5)]);
    r.flag("reset-lock", true);
    r.pass();
    assert_eq!(r.resets(), [WORK_RESET], "promoted, its reset tried");
    assert_eq!(
        r.records(),
        [rec("Work", Phase::PostSave, NEW)],
        "promoted to post-save with its doubt count reset"
    );
    // And a phase that does not change keeps its count: the same `pre-save` record in doubt again.
    r.flag("reset-lock", false);
    left_behind(&r.store, &[rec_doubted("Work", Phase::PreSave, NEW, 5)]);
    r.flag("validate-fail", true);
    r.pass();
    assert_eq!(r.records(), [rec_doubted("Work", Phase::PreSave, NEW, 6)]);
}

/// PR 3 final r4 (C3): a stored record whose key id is not a key id, or whose label could not be
/// reset by label (empty, a NUL), is DROPPED on read — never retried — and nothing is asked of the
/// engine for it: no `config validate`, no reset, no delete.
#[test]
fn a_record_with_a_bad_id_or_label_is_dropped_on_read_and_never_reaches_the_engine() {
    let _t = turn();
    let r = rig("pr-badrec");
    r.saved_work(OLD);
    left_behind(
        &r.store,
        &[
            rec("Work", Phase::Discard, "k-0123456789AB"),
            rec("Work", Phase::PreSave, "not-a-key-id"),
            rec("", Phase::Discard, NEW),
            rec("Wo\0rk", Phase::PostSave, NEW),
        ],
    );
    assert_eq!(r.records(), [], "every record dropped on read");
    r.pass();
    assert!(
        !r.rec.join("argv.txt").exists(),
        "a dropped record reached the engine: {:?}",
        r.lines("argv.txt")
    );
    assert_eq!(r.records(), []);
}

/* ── at start ─────────────────────────────────────────────────────────────────────────────────── */

/// A `post-save` record surviving an app restart is flushed at start — by the task the app spawns
/// at setup (its first pass), with no editor involved.
#[test]
fn a_post_save_record_surviving_a_restart_is_flushed_at_start() {
    let _t = turn();
    let r = rig_with_interval("pr-start", Duration::from_secs(3600));
    left_behind(&r.store, &[rec("Work", Phase::PostSave, NEW)]);
    r.saved_work(NEW);
    let task = pending_resets::spawn_retry(r.app.handle());
    let started = Instant::now();
    while !r.records().is_empty() {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the start pass never ran"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    task.abort();
    assert_eq!(r.resets(), [WORK_RESET]);
}

/// The 15 s retry, on an injected interval: a record the first pass could not clear (a run held
/// the lock) is cleared by a LATER tick once the lock is free.
#[test]
fn the_retry_task_retries_on_its_interval() {
    let _t = turn();
    assert_eq!(
        RETRY_INTERVAL,
        Duration::from_secs(15),
        "spec §6: every 15 s"
    );
    let r = rig_with_interval("pr-tick", Duration::from_millis(100));
    left_behind(&r.store, &[rec("Work", Phase::PostSave, NEW)]);
    r.saved_work(NEW);
    r.flag("reset-lock", true);
    let task = pending_resets::spawn_retry(r.app.handle());
    let started = Instant::now();
    while r.resets().len() < 2 {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the task did not retry"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        r.records(),
        [rec("Work", Phase::PostSave, NEW)],
        "lock-held is retried"
    );
    r.flag("reset-lock", false);
    while !r.records().is_empty() {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the task never cleared it"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    task.abort();
}

/// Plan Q11: a `pre-save` record found at start whose key no saved entry references — the save
/// never happened — is dropped and its unreferenced key id deleted. No reset is needed.
#[test]
fn a_pre_save_record_found_at_start_is_dropped_and_its_key_deleted() {
    let _t = turn();
    let r = rig("pr-stale");
    left_behind(&r.store, &[rec("Work", Phase::PreSave, NEW)]);
    r.saved_work(OLD);
    r.pass();
    assert_eq!(r.records(), []);
    assert_eq!(r.deleted(), [NEW]);
    assert_eq!(r.resets(), [] as [&str; 0]);
}

/// Plan Q11 (DRAFT 4): a crash after `configSave` succeeded but before `flush` — the saved entry
/// already references the new id — is promoted to `post-save` at start, flushed, and its reset
/// retried; the key is kept.
#[test]
fn a_crash_between_save_and_flush_is_promoted_at_start_and_the_key_kept() {
    let _t = turn();
    let r = rig("pr-crash");
    left_behind(&r.store, &[rec("Work", Phase::PreSave, NEW)]);
    r.saved_work(NEW);
    r.flag("reset-lock", true);
    r.pass();
    assert_eq!(
        r.records(),
        [rec("Work", Phase::PostSave, NEW)],
        "promoted, its reset retried"
    );
    assert_eq!(r.resets(), [WORK_RESET], "flushed at once");
    r.flag("reset-lock", false);
    r.pass();
    assert_eq!(r.records(), []);
    assert_eq!(
        r.deleted(),
        [] as [&str; 0],
        "the key the save landed is kept"
    );
}

/// Hub Q21: `flush` meeting a `discard` record whose key the saved config references promotes it.
#[test]
fn flush_meeting_a_referenced_discard_record_promotes_it() {
    let _t = turn();
    let r = rig("pr-flushd");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    {
        let _held = r.hold_in_flight();
        assert_eq!(kind(&r.drop_("Work", NEW)), "deletePending");
    }
    r.saved_work(NEW);
    assert_eq!(kind(&r.flush("Work", NEW)), "reset");
    assert_eq!(r.records(), []);
    assert_eq!(r.deleted(), [] as [&str; 0]);
}

/// Hub Q21: the retry task re-runs the reference check before every delete — a `discard` record
/// whose key the saved config now references is promoted, not deleted.
#[test]
fn the_retry_task_rechecks_references_before_every_delete() {
    let _t = turn();
    let r = rig("pr-recheck");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    {
        let _held = r.hold_in_flight();
        assert_eq!(kind(&r.drop_("Work", NEW)), "deletePending");
    }
    r.saved_work(NEW);
    r.pass();
    assert_eq!(r.deleted(), [] as [&str; 0]);
    assert_eq!(r.records(), [], "promoted, and its reset cleared it");
    assert_eq!(r.resets(), [WORK_RESET, WORK_RESET]);
}

/// The `valid` gate: an INVALID config's "nothing references it" is not trusted — the key is kept,
/// from a drop and from a record found at start. The very same rows from a VALID config delete it,
/// so the gate, not the rows, is what kept it.
#[test]
fn an_invalid_configs_nothing_references_it_deletes_nothing() {
    let _t = turn();
    let r = rig("pr-invalid");
    let config = saved_config(&[api_entry("Work", OLD)]);
    let rows = [row(0, None, false), row(1, Some(OLD), false)];
    std::fs::write(&r.config, bytes_of(&config)).unwrap();
    let mut invalid = report(&rows);
    invalid["valid"] = json!(false);
    r.register(&config, &invalid);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    let out = r.drop_("Work", NEW);
    assert_eq!(kind(&out), "kept", "{out}");
    assert_eq!(out["why"], "unverified", "{out}");
    assert_eq!(r.records(), []);
    left_behind(&r.store, &[rec("Work", Phase::PreSave, NEW2)]);
    r.pass();
    assert_eq!(
        r.records(),
        [],
        "an invalid config is a config error: dropped"
    );
    assert_eq!(r.deleted(), [] as [&str; 0], "nothing deleted");

    r.saved(&config, &rows);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    assert_eq!(kind(&r.drop_("Work", NEW)), "deleted");
    assert_eq!(r.deleted(), [NEW]);
}

/// `flush` meeting a `discard` record whose key the saved config does NOT use under its label:
/// nothing is reset, it answers `discarding`, the record stays `discard`, and the retry task then
/// deletes the key.
#[test]
fn flush_meeting_an_unreferenced_discard_record_answers_discarding() {
    let _t = turn();
    let r = rig("pr-flushud");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    {
        let _held = r.hold_in_flight();
        assert_eq!(kind(&r.drop_("Work", NEW)), "deletePending");
    }
    let out = r.flush("Work", NEW);
    assert_eq!(kind(&out), "discarding", "{out}");
    assert_eq!(r.records(), [rec("Work", Phase::Discard, NEW)]);
    assert_eq!(r.resets(), [WORK_RESET], "only the pre-save reset ran");
    assert_eq!(r.deleted(), [] as [&str; 0]);
    r.pass();
    assert_eq!(r.deleted(), [NEW]);
    assert_eq!(r.records(), []);
}

/// A record found at start whose reference check is in doubt for a TRANSIENT reason — `config
/// validate` failing outright, or the label's own row undecided (the shape the engine's 2 s
/// ownership deadline answers: `appOwnedKey` with no id) — is KEPT for the next pass, its doubt
/// counted. So a crash between save and flush still gets its post-save reset once the check
/// answers, and a `discard` record still gets its delete. No key is deleted while in doubt.
#[test]
fn a_transient_doubt_keeps_a_left_behind_record_for_the_next_pass() {
    let _t = turn();
    let r = rig("pr-transient");
    for setup in ["validate-fail", "undecided-row"] {
        // A crash between the save and the flush: the saved entry already uses NEW.
        left_behind(&r.store, &[rec("Work", Phase::PreSave, NEW)]);
        let landed = saved_config(&[api_entry("Work", NEW)]);
        if setup == "validate-fail" {
            r.saved(&landed, &[row(0, None, false), row(1, Some(NEW), false)]);
            r.flag("validate-fail", true);
        } else {
            r.saved(&landed, &[row(0, None, false), row(1, None, true)]);
        }
        r.pass();
        assert_eq!(
            r.records(),
            [rec_doubted("Work", Phase::PreSave, NEW, 1)],
            "{setup}: kept, its doubt counted"
        );
        r.pass();
        assert_eq!(
            r.records(),
            [rec_doubted("Work", Phase::PreSave, NEW, 2)],
            "{setup}"
        );
        assert_eq!(r.resets(), [] as [&str; 0], "{setup}");
        r.flag("validate-fail", false);
        r.saved(&landed, &[row(0, None, false), row(1, Some(NEW), false)]);
        r.pass();
        assert_eq!(
            r.records(),
            [],
            "{setup}: promoted, and its reset cleared it"
        );
        assert_eq!(r.resets(), [WORK_RESET], "{setup}");
        std::fs::remove_file(r.rec.join("resets.txt")).unwrap();
    }
    // A `discard` record in doubt is kept too, and deleted once the check vouches.
    r.saved_work(OLD);
    left_behind(&r.store, &[rec("Work", Phase::Discard, NEW2)]);
    r.flag("validate-fail", true);
    r.pass();
    assert_eq!(r.records(), [rec_doubted("Work", Phase::Discard, NEW2, 1)]);
    r.flag("validate-fail", false);
    r.pass();
    assert_eq!(r.records(), []);
    assert_eq!(r.deleted(), [NEW2], "deleted only once the check vouched");
}

/// Spec §6 step 4, nothing retries forever: a record in doubt on every pass is dropped after
/// `MAX_DOUBTFUL_PASSES`, and its key is KEPT (uninstall's `delete-all` removes it).
#[test]
fn a_record_in_doubt_on_every_pass_is_dropped_after_the_bound_and_its_key_kept() {
    let _t = turn();
    let r = rig("pr-bound");
    r.saved_work(OLD);
    left_behind(&r.store, &[rec("Work", Phase::PreSave, NEW)]);
    r.flag("validate-fail", true);
    for n in 1..MAX_DOUBTFUL_PASSES {
        r.pass();
        assert_eq!(r.records(), [rec_doubted("Work", Phase::PreSave, NEW, n)]);
    }
    r.pass();
    assert_eq!(r.records(), [], "the bound reached: dropped");
    assert_eq!(r.deleted(), [] as [&str; 0], "and the key kept");
}

/// A STRUCTURAL doubt — no saved config (the label is no longer saved), a config that is not JSON
/// (a config error), rows that cannot vouch for every entry — drops a record found at start at once,
/// keeping its key (spec §6 step 4: such a record is dropped, nothing retries forever).
#[test]
fn a_structural_doubt_drops_a_left_behind_record_at_once_and_keeps_its_key() {
    let _t = turn();
    let r = rig("pr-struct");
    for setup in ["missing", "garbage", "dropped-entry"] {
        match setup {
            "missing" => {
                let _ = std::fs::remove_file(&r.config);
            }
            "garbage" => std::fs::write(&r.config, "this is not JSON").unwrap(),
            _ => r.saved(
                &saved_config(&[api_entry("Work", OLD), api_entry("Work", OLD)]),
                &[row(0, None, false), row(1, Some(OLD), false)],
            ),
        }
        left_behind(
            &r.store,
            &[
                rec("Work", Phase::PreSave, NEW),
                rec("Work", Phase::Discard, NEW2),
            ],
        );
        r.pass();
        assert_eq!(r.records(), [], "{setup}");
    }
    assert_eq!(r.deleted(), [] as [&str; 0]);
}

/// A crash between a store write's temp file and its rename leaves `pending-resets.json.tmp-<pid>-
/// <seq>` behind (0600, holding labels). The retry task's first pass sweeps every such file a
/// DIFFERENT process left — never this process's own, nor a name of another shape.
#[test]
fn the_first_pass_sweeps_stale_temp_files_of_the_store() {
    let _t = turn();
    let r = rig_with_interval("pr-sweep", Duration::from_secs(3600));
    std::fs::create_dir_all(&r.store).unwrap();
    let other = std::process::id().wrapping_add(1);
    let stale = r.store.join(format!("{PENDING_RESETS_FILE}.tmp-{other}-7"));
    let own = r.store.join(format!(
        "{PENDING_RESETS_FILE}.tmp-{}-9999",
        std::process::id()
    ));
    let shapes = [
        r.store
            .join(format!("{PENDING_RESETS_FILE}.tmp-x{other}-7")),
        r.store.join(format!("{PENDING_RESETS_FILE}.tmp-{other}")),
        r.store.join(format!("other.json.tmp-{other}-7")),
    ];
    for f in std::iter::once(&stale).chain([&own]).chain(&shapes) {
        std::fs::write(
            f,
            r#"[{"label":"Work","phase":"pre-save","newKeyId":"k-0123456789ab"}]"#,
        )
        .unwrap();
    }
    let task = pending_resets::spawn_retry(r.app.handle());
    let started = Instant::now();
    while stale.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the stale temp file was never swept"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    task.abort();
    assert!(own.exists(), "this process's own temp name is not stale");
    for f in &shapes {
        assert!(f.exists(), "{} is not a temp of the store", f.display());
    }
}

/* ── persistence and the writers ──────────────────────────────────────────────────────────────── */

/// Persistence through the real bridge: an `add` over IPC lands in `pending-resets.json` (0600 —
/// a label is user text), a second app over the same store (a restart) reads it back, and treats
/// it as a previous run's record — while the app that wrote it does not.
#[test]
fn records_persist_through_the_real_bridge() {
    let _t = turn();
    let r = rig("pr-persist");
    r.saved_work(OLD);
    assert_eq!(kind(&r.add("Work", NEW)), "reset");
    let file = r.store.join(PENDING_RESETS_FILE);
    let on_disk: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        on_disk,
        json!([{ "label": "Work", "phase": "pre-save", "newKeyId": NEW }])
    );
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    r.pass();
    assert_eq!(
        r.records(),
        [rec("Work", Phase::PreSave, NEW)],
        "this run's own pre-save record is the editor's"
    );
    let (restarted, _w) = mock_app(
        EngineClient::with_program(r.program.clone()),
        &r.candidates,
        &r.store,
        Duration::from_millis(100),
    );
    tauri::async_runtime::block_on(pending_resets::retry_pass(restarted.handle()));
    assert_eq!(r.records(), [], "a restart resolves it (plan Q11)");
    assert_eq!(r.deleted(), [NEW]);
}

/// Operand validation, before anything is written or spawned.
#[test]
fn bad_operands_are_refused_before_anything_runs() {
    let _t = turn();
    let r = rig("pr-operand");
    for cmd in [
        "provider_pending_reset_add",
        "provider_pending_reset_flush",
        "provider_pending_reset_drop",
    ] {
        let e = r
            .call(
                cmd,
                json!({ "label": "Work", "newKeyId": "k-0123456789AB" }),
            )
            .expect_err("an upper-case id");
        assert_eq!(e["kind"], "invalidInput", "{cmd}: {e}");
        assert_eq!(e["field"], "newKeyId", "{cmd}: {e}");
        let e = r
            .call(cmd, json!({ "label": "", "newKeyId": NEW }))
            .expect_err("an empty label");
        assert_eq!(e["field"], "label", "{cmd}: {e}");
    }
    assert!(
        !r.rec.join("argv.txt").exists(),
        "a refused operand reached the engine"
    );
    assert_eq!(r.records(), []);
}

/// The five writers of `pending-resets.json` — `add`, `flush`, `drop`, the retry task and the
/// start-up pass (the first pass of the task the app spawns at setup) — racing each other never
/// lose a record: every record no writer was asked to change is still there, as written; every
/// added one is there; a flushed one is `post-save` or cleared by its reset; a dropped one stays
/// gone. Each writer's read-modify-write includes an fsync'd temp-then-rename, so without the one
/// mutex these writes interleave and records are lost or resurrected.
#[test]
fn concurrent_writers_never_lose_a_record() {
    let _t = turn();
    let r = rig_with_interval("pr-five", Duration::from_secs(3600));
    // No saved config: a drop's reference check is "unverified" — keep the key, drop the record.
    let ids: Vec<String> = (0..20).map(|i| format!("k-{i:012x}")).collect();
    // Twelve records of THIS run first (the editor's), sequentially.
    for (i, id) in ids[..12].iter().enumerate() {
        let out = r.add(&format!("seed{i}"), id);
        assert_eq!(kind(&out), "reset", "{out}");
    }
    // `App` is not `Sync`: the writers share the webview (IPC) and a cloned `AppHandle`.
    let w = &r.webview;
    let handle = r.app.handle().clone();
    let op = |cmd: &str, label: String, id: &str| {
        call(w, cmd, json!({ "label": label, "newKeyId": id }))
            .unwrap_or_else(|e| panic!("{cmd}: {e}"))
    };
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        for (i, id) in ids[12..20].iter().enumerate() {
            handles.push(s.spawn(move || {
                (
                    "add",
                    op("provider_pending_reset_add", format!("new{i}"), id),
                )
            }));
        }
        for (i, id) in ids[0..3].iter().enumerate() {
            handles.push(s.spawn(move || {
                (
                    "flush",
                    op("provider_pending_reset_flush", format!("seed{i}"), id),
                )
            }));
        }
        for (i, id) in ids[3..6].iter().enumerate() {
            let i = i + 3;
            handles.push(s.spawn(move || {
                (
                    "drop",
                    op("provider_pending_reset_drop", format!("seed{i}"), id),
                )
            }));
        }
        for _ in 0..3 {
            let handle = handle.clone();
            handles.push(s.spawn(move || {
                tauri::async_runtime::block_on(pending_resets::retry_pass(&handle));
                ("pass", json!({}))
            }));
        }
        {
            let handle = handle.clone();
            handles.push(s.spawn(move || {
                let task = pending_resets::spawn_retry(&handle);
                std::thread::sleep(Duration::from_millis(300));
                task.abort();
                ("start", json!({}))
            }));
        }
        for h in handles {
            let (what, out) = h.join().expect("a writer");
            match what {
                "add" | "flush" => {
                    assert!(["reset", "retry"].contains(&kind(&out)), "{what}: {out}")
                }
                "drop" => assert_eq!(kind(&out), "kept", "{what}: {out}"),
                _ => {}
            }
        }
    });
    let records = r.records();
    for (i, id) in ids.iter().enumerate() {
        let label = if i < 12 {
            format!("seed{i}")
        } else {
            format!("new{}", i - 12)
        };
        let got: Vec<&PendingRecord> = records.iter().filter(|x| x.label == label).collect();
        assert!(got.len() <= 1, "{label} twice: {records:?}");
        let got = got.first().map(|x| (x.phase, x.new_key_id.as_str()));
        match i {
            0..=2 => assert!(
                got.is_none() || got == Some((Phase::PostSave, id.as_str())),
                "{label} (flushed) is {got:?}: {records:?}"
            ),
            3..=5 => assert_eq!(got, None, "{label} (dropped) came back: {records:?}"),
            _ => assert_eq!(
                got,
                Some((Phase::PreSave, id.as_str())),
                "{label} was lost or changed: {records:?}"
            ),
        }
    }
    assert_eq!(
        r.deleted(),
        [] as [&str; 0],
        "no key is deleted with no saved config"
    );
}
