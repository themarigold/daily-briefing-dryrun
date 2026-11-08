//! T15 — the config save path, driven through REAL IPC on a MockRuntime app built from the shipped
//! handler, against a fake engine (and, in one test, the real one) inside a scratch sandbox.
//!
//! ## The sandbox, and why nothing here can reach the developer's config
//!
//! The config path is whatever the ENGINE's `status --json` says. Every fake here reports a path
//! under its own `ScratchDir`; the one real-engine test runs the bundled sidecar with
//! `XDG_CONFIG_HOME`, `DAILY_BRIEFING_STATE_DIR`, `HOME` and `DBA_TEST_UNIT_DIR` pointed into its
//! scratch and ASSERTS that the reported `configPath` is under it before it saves anything.
//! Candidate files go to a scratch directory too (`ConfigSaver::with_candidate_dir`): a MockRuntime
//! app's `app_data_dir()` is the developer's real one.
//!
//! What is asserted is on DISK — bytes, `.bak`, leftover temp files, permission bits — plus what
//! the fake engine was asked to validate (it copies each candidate while it still exists).

mod common;

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use common::{files_sidecar, sandbox_env, ScratchDir};
use daily_briefing_gui_lib::config_save::{
    canonical_json, digest, is_custom_notify, json_eq, replace_config_file,
    replace_config_file_with_link, staged_prefix, ConfigSaver, SaveError, MAX_CONFIG_BYTES,
    REDACTED_API_KEY,
};
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

const FULL: &str = include_str!("fixtures/config-full.json");
const API: &str = include_str!("fixtures/config-api.json");
const SENTINEL_KEY: &str = "sk-ant-SENTINEL-DO-NOT-LEAK-0000";

struct Sandbox {
    config: PathBuf,
    candidates: PathBuf,
    record: PathBuf,
    app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    scratch: ScratchDir,
}

fn app_over(
    client: EngineClient,
    candidates: &Path,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    app_with(client, ConfigSaver::with_candidate_dir(candidates))
}

fn app_with(
    client: EngineClient,
    saver: ConfigSaver,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(Engine(Ok(client)))
        .manage(saver)
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(tauri::generate_context!())
        .expect("mock app");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");
    (app, webview)
}

/// A sandbox whose config holds `initial` (or no config at all).
fn sandbox(tag: &str, initial: Option<&str>) -> Sandbox {
    let scratch = ScratchDir::new(tag);
    let state = scratch.join("state");
    let xdg = scratch.join("xdg").join("daily-briefing");
    let record = scratch.join("record");
    for d in [&state, &xdg, &record] {
        std::fs::create_dir_all(d).expect("sandbox dir");
    }
    let config = xdg.join("config.json");
    if let Some(text) = initial {
        std::fs::write(&config, text).expect("initial config");
    }
    let candidates = scratch.join("app-data").join("config-candidates");
    let program = files_sidecar(&scratch.path, "engine.sh", &state, &config, &record);
    let (app, webview) = app_over(EngineClient::with_program(program), &candidates);
    Sandbox {
        config,
        candidates,
        record,
        app,
        webview,
        scratch,
    }
}

impl Sandbox {
    fn call(&self, cmd: &str, body: Value) -> Result<Value, Value> {
        call(&self.webview, cmd, body)
    }

    fn read(&self) -> Value {
        self.call("config_read", json!({}))
            .unwrap_or_else(|e| panic!("config_read failed: {e}"))
    }

    fn save(&self, text: &str, base: &str) -> Result<Value, Value> {
        self.call("config_save", json!({ "text": text, "base": base }))
    }

    fn on_disk(&self) -> String {
        std::fs::read_to_string(&self.config).expect("the config is readable")
    }

    fn backup(&self) -> Option<String> {
        std::fs::read_to_string(bak_of(&self.config)).ok()
    }

    /// How many times the engine was asked to validate.
    fn validations(&self) -> usize {
        std::fs::read_to_string(self.record.join("validated-paths.txt"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    fn validated(&self, n: usize) -> String {
        std::fs::read_to_string(self.record.join(format!("validated-{n}.json")))
            .expect("the fake copied the candidate")
    }

    /// Anything but the config and its `.bak` in the config directory — a leftover temp file.
    fn leftovers(&self) -> Vec<String> {
        let dir = self.config.parent().expect("a parent");
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .expect("config dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .filter(|n| n != "config.json" && n != "config.json.bak")
            .collect();
        names.sort();
        names
    }

    /// `<candidate mode> <candidate dir mode>` for each validation, in octal.
    fn validated_modes(&self) -> Vec<String> {
        std::fs::read_to_string(self.record.join("validated-modes.txt"))
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default()
    }

    fn candidates_left(&self) -> usize {
        std::fs::read_dir(&self.candidates)
            .map(|d| d.count())
            .unwrap_or(0)
    }
}

fn bak_of(config: &Path) -> PathBuf {
    config.with_file_name("config.json.bak")
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

fn base_of(doc: &Value) -> String {
    doc["base"].as_str().expect("a base token").to_string()
}

fn text_of(doc: &Value) -> String {
    doc["text"].as_str().expect("a text").to_string()
}

fn edit(text: &str, f: impl FnOnce(&mut Value)) -> String {
    let mut v: Value = serde_json::from_str(text).expect("JSON");
    f(&mut v);
    canonical_json(&v)
}

fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

/* ── the format ───────────────────────────────────────────────────────────────────────────────── */

/// The fixtures are `JSON.stringify(x, null, 2)` output (generated by bun, and re-checked by
/// `gui/tests-web/settings.check.ts`); the Rust re-serialisation must reproduce them byte for byte —
/// key order, escapes (ESC as a backslash-u escape), raw U+2028 and DEL, non-ASCII, nested empties, no trailing newline.
#[test]
fn the_save_format_is_json_stringify_with_two_spaces() {
    for (name, fixture) in [("config-full.json", FULL), ("config-api.json", API)] {
        let parsed: Value = serde_json::from_str(fixture).expect("fixture parses");
        assert_eq!(
            canonical_json(&parsed),
            fixture,
            "{name}: re-serialising changed the bytes (is serde_json's preserve_order on?)"
        );
    }
    // prove-it 3b: the check can fail — a reordered object does not reproduce the fixture.
    let mut reordered: Value = serde_json::from_str(FULL).expect("fixture");
    let obj = reordered.as_object_mut().expect("object");
    let first = obj.shift_remove("$comment").expect("the first key");
    obj.insert("$comment".into(), first);
    assert_ne!(canonical_json(&reordered), FULL);
}

// ⚠ SANDBOX TAGS STAY AT 14 CHARACTERS OR FEWER. The candidate path runs through B3's `--file`
// validator, which refuses a path SEGMENT over 64 characters, and the scratch directory's name is
// `daily-briefing-t8-<tag>-<pid>-<19-digit nanos>-<seq>` — 50 characters plus the tag with a
// 7-digit pid and a 3-digit sequence number. A longer tag fails the save as `candidateDir`.

/* ── round trip / no-op ───────────────────────────────────────────────────────────────────────── */

#[test]
fn an_unchanged_full_config_round_trips_byte_identical_and_writes_nothing() {
    let s = sandbox("cfg-noop", Some(FULL));
    let before = std::fs::metadata(&s.config).expect("metadata");
    let doc = s.read();
    assert_eq!(doc["exists"], true);
    assert_eq!(doc["path"], s.config.display().to_string());
    assert_eq!(
        text_of(&doc),
        FULL,
        "config_read must show the file as the save would write it"
    );
    assert_eq!(doc["apiKeyRedacted"], false);

    let out = s.save(&text_of(&doc), &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "unchanged", "{out}");
    assert_eq!(s.on_disk(), FULL);
    let after = std::fs::metadata(&s.config).expect("metadata");
    assert_eq!(
        before.modified().ok(),
        after.modified().ok(),
        "the file was rewritten"
    );
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(before.ino(), after.ino(), "the file was replaced");
    }
    assert!(s.backup().is_none(), "a no-op save made a backup");
    assert_eq!(s.validations(), 0, "a no-op save still asked the engine");
    assert!(s.leftovers().is_empty(), "{:?}", s.leftovers());

    // Formatting-only differences are a no-op too: the same document, minified.
    let minified = serde_json::to_string(&serde_json::from_str::<Value>(FULL).unwrap()).unwrap();
    let out = s.save(&minified, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "unchanged", "{out}");
    assert_eq!(s.on_disk(), FULL);
}

#[test]
fn unknown_keys_are_preserved_in_place() {
    let s = sandbox("cfg-unknown", Some(FULL));
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(9));
    let out = s.save(&candidate, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert!(out["warnings"].as_array().expect("warnings").is_empty());
    assert_eq!(out["path"], s.config.display().to_string());

    let written = s.on_disk();
    assert_eq!(
        written, candidate,
        "the written bytes are the canonical candidate"
    );
    assert_eq!(
        written,
        FULL.replace("\"lookbackCapDays\": 7", "\"lookbackCapDays\": 9")
    );
    let keys: Vec<String> = serde_json::from_str::<Value>(&written)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let original: Vec<String> = serde_json::from_str::<Value>(FULL)
        .unwrap()
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert_eq!(keys, original, "key order changed");
    assert_eq!(
        s.backup().as_deref(),
        Some(FULL),
        ".bak must hold the previous bytes"
    );
    assert_eq!(s.validations(), 1);
    assert_eq!(
        s.validated(0),
        candidate,
        "the engine validated other bytes than were written"
    );
    assert!(s.leftovers().is_empty(), "{:?}", s.leftovers());
    assert_eq!(s.candidates_left(), 0, "the candidate file was not removed");
}

/* ── validation ───────────────────────────────────────────────────────────────────────────────── */

#[test]
fn an_invalid_candidate_writes_nothing_and_leaves_bak_untouched() {
    let s = sandbox("cfg-invalid", Some(FULL));
    std::fs::write(bak_of(&s.config), "an older backup").expect("seed .bak");
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["x-test"] = json!("__invalid__"));
    let out = s.save(&candidate, &base_of(&doc)).expect("save answers");
    assert_eq!(kind(&out), "invalid", "{out}");
    assert_eq!(out["errors"][0]["field"], "lookbackCapDays");
    assert!(out["errors"][0]["message"]
        .as_str()
        .unwrap()
        .contains("lookbackCapDays"));
    assert_eq!(s.on_disk(), FULL, "an invalid config was written");
    assert_eq!(
        s.backup().as_deref(),
        Some("an older backup"),
        ".bak was touched"
    );
    assert_eq!(s.validations(), 1);
    assert!(s.leftovers().is_empty(), "{:?}", s.leftovers());
    assert_eq!(s.candidates_left(), 0);
}

#[test]
fn a_warning_does_not_block_the_save() {
    let s = sandbox("cfg-warn", Some(FULL));
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| {
        v["morningTime"] = json!("25:99");
        v["x-test"] = json!("__warn__");
    });
    let out = s.save(&candidate, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_eq!(out["warnings"][0]["field"], "morningTime");
    assert_eq!(s.on_disk(), candidate);
    assert_eq!(s.backup().as_deref(), Some(FULL));
}

/* ── atomicity ────────────────────────────────────────────────────────────────────────────────── */

/// A crash between the durable write of the new bytes and the rename: simulated by the hook
/// failing, and by the hook PANICKING (which, like a real crash, runs no cleanup of its own).
#[test]
fn a_crash_between_write_and_rename_leaves_the_old_file_intact() {
    let scratch = ScratchDir::new("cfg-crash");
    let config = scratch.join("config.json");
    std::fs::write(&config, FULL).expect("seed");
    std::fs::write(bak_of(&config), "an older backup").expect("seed .bak");
    let new = FULL.replace("\"lookbackCapDays\": 7", "\"lookbackCapDays\": 3");

    // The hook sees the tmp file complete, beside the target, and fails — the stand-in for a
    // failed final rename, which comes after `.bak` has been swapped.
    let mut seen = None;
    let err = replace_config_file(&config, new.as_bytes(), FULL, 0o600, |tmp| {
        seen = Some((
            tmp.parent().map(Path::to_path_buf),
            std::fs::read_to_string(tmp).ok(),
        ));
        Err(std::io::Error::other("simulated crash"))
    })
    .expect_err("the hook failed");
    assert!(matches!(err, SaveError::Write { .. }), "{err:?}");
    let (dir, tmp_text) = seen.expect("the hook ran");
    assert_eq!(
        dir.as_deref(),
        config.parent(),
        "the tmp file is not in the target's directory"
    );
    assert_eq!(
        tmp_text.as_deref(),
        Some(new.as_str()),
        "the tmp file was not complete before the rename"
    );
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        FULL,
        "the old config was changed"
    );
    let names = || -> Vec<String> {
        let mut n: Vec<String> = std::fs::read_dir(scratch.path.clone())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        n.sort();
        n
    };
    assert_eq!(
        names(),
        ["config.json", "config.json.bak"],
        "a failed save left a staged file behind"
    );
    // Review round 1: a failed replace must not overwrite `.bak`.
    assert_eq!(
        std::fs::read_to_string(bak_of(&config)).unwrap(),
        "an older backup",
        "a failed save replaced .bak"
    );

    // With no `.bak` before, a failed save leaves none.
    std::fs::remove_file(bak_of(&config)).unwrap();
    replace_config_file(&config, new.as_bytes(), FULL, 0o600, |_| {
        Err(std::io::Error::other("simulated crash"))
    })
    .expect_err("the hook failed");
    assert_eq!(names(), ["config.json"], "a failed save created .bak");
    std::fs::write(bak_of(&config), "an older backup").unwrap();

    // A panic between the two renames (a crash — no cleanup runs): the config is untouched, and
    // `.bak` holds the config's own bytes, so the pre-save state is on disk under both names.
    let result = catch_unwind(AssertUnwindSafe(|| {
        replace_config_file(&config, new.as_bytes(), FULL, 0o600, |_| panic!("killed"))
    }));
    assert!(result.is_err(), "the hook's panic did not propagate");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), FULL);
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), FULL);
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(parsed["lookbackCapDays"], 7);
    let prefix = staged_prefix("config.json");
    assert!(
        names().iter().any(|n| n.starts_with(&prefix)),
        "the crash left no staged files, so the sweep below proves nothing: {:?}",
        names()
    );

    // And the same function, uninterrupted, does replace it — sweeping the crash's leftovers.
    let current = std::fs::read_to_string(&config).unwrap();
    replace_config_file(&config, new.as_bytes(), &current, 0o600, |_| Ok(())).expect("replace");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), new);
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), FULL);
    assert_eq!(names(), ["config.json", "config.json.bak"]);

    // A stale expectation is a conflict, and writes nothing (the re-read guard, called directly).
    let err = replace_config_file(&config, b"{}", FULL, 0o600, |_| Ok(()))
        .expect_err("the file is no longer FULL");
    assert!(matches!(err, SaveError::Conflict { .. }), "{err:?}");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), new);
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), FULL);
    assert_eq!(names(), ["config.json", "config.json.bak"]);
}

/// The names in `dir`, sorted.
fn names_in(dir: &Path) -> Vec<String> {
    let mut n: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    n.sort();
    n
}

/// Review round 2 (V2): the round-1 swap HARD-LINKED the previous `.bak` aside and gave up on any
/// other error, so on FAT32 (`EOPNOTSUPP`) every save after the first failed. A filesystem without
/// hard links now moves `.bak` aside instead, with the same guarantees: a save lands, a failed
/// final rename restores the previous `.bak`, a crash leaves the config untouched.
#[test]
fn a_filesystem_without_hard_links_still_saves_and_restores_bak() {
    let scratch = ScratchDir::new("cfg-nolink");
    let config = scratch.join("config.json");
    std::fs::write(&config, FULL).expect("seed");
    let v = |n: u32| {
        FULL.replace(
            "\"lookbackCapDays\": 7",
            &format!("\"lookbackCapDays\": {n}"),
        )
    };
    let names = || names_in(&scratch.path);
    let clean = ["config.json", "config.json.bak"];
    let links = std::cell::Cell::new(0_u32);
    // FAT32 answers EOPNOTSUPP; some network filesystems answer EPERM. Both take the fallback.
    let refuse = |kind: std::io::ErrorKind| {
        let links = &links;
        move |from: &Path, to: &Path| -> std::io::Result<()> {
            links.set(links.get() + 1);
            assert!(from.ends_with("config.json.bak"), "linked {from:?}");
            assert!(!to.exists(), "the link target {to:?} already exists");
            Err(std::io::Error::new(kind, "simulated: no hard links here"))
        }
    };
    let unsupported = std::io::ErrorKind::Unsupported;

    // The first save has no `.bak` to keep, so it never links.
    replace_config_file_with_link(
        &config,
        v(1).as_bytes(),
        FULL,
        0o600,
        refuse(unsupported),
        |_| Ok(()),
    )
    .expect("first save");
    assert_eq!(links.get(), 0, "linked with no .bak present");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), v(1));
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), FULL);

    // The second save is the one that failed in round 1.
    replace_config_file_with_link(
        &config,
        v(2).as_bytes(),
        &v(1),
        0o600,
        refuse(unsupported),
        |_| Ok(()),
    )
    .expect("the second save lands without hard links");
    assert_eq!(links.get(), 1, "the injected link was not attempted");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), v(2));
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), v(1));
    assert_eq!(names(), clean, "the fallback left a staged file behind");

    // A failed final rename under the fallback puts the moved-aside `.bak` back.
    let err = replace_config_file_with_link(
        &config,
        v(3).as_bytes(),
        &v(2),
        0o600,
        refuse(std::io::ErrorKind::PermissionDenied),
        |_| Err(std::io::Error::other("simulated failed rename")),
    )
    .expect_err("the hook failed");
    assert!(matches!(err, SaveError::Write { .. }), "{err:?}");
    assert_eq!(links.get(), 2);
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        v(2),
        "the config changed"
    );
    assert_eq!(
        std::fs::read_to_string(bak_of(&config)).unwrap(),
        v(1),
        "a failed save lost the previous .bak"
    );
    assert_eq!(names(), clean);

    // A crash between the renames: the config is untouched, `.bak` holds its bytes, and the
    // previous backup waits under the staged name until the next save sweeps it.
    let result = catch_unwind(AssertUnwindSafe(|| {
        replace_config_file_with_link(
            &config,
            v(4).as_bytes(),
            &v(2),
            0o600,
            refuse(unsupported),
            |_| panic!("killed"),
        )
    }));
    assert!(result.is_err(), "the hook's panic did not propagate");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), v(2));
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), v(2));
    let prefix = staged_prefix("config.json");
    let prev: Vec<String> = names()
        .into_iter()
        .filter(|n| n.starts_with(&prefix) && n.ends_with(".prev"))
        .collect();
    assert_eq!(prev.len(), 1, "{:?}", names());
    assert_eq!(
        std::fs::read_to_string(scratch.join(&prev[0])).unwrap(),
        v(1),
        "the moved-aside backup is not under the staged name"
    );
    replace_config_file_with_link(
        &config,
        v(5).as_bytes(),
        &v(2),
        0o600,
        refuse(unsupported),
        |_| Ok(()),
    )
    .expect("the next save");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), v(5));
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), v(2));
    assert_eq!(names(), clean, "the crash's leftovers were not swept");

    // The fallback never renames over a file it did not create: a `.prev` name that appears
    // between the failed link and the move (somebody else's) is left exactly as it was.
    let err = replace_config_file_with_link(
        &config,
        v(6).as_bytes(),
        &v(5),
        0o600,
        |_: &Path, to: &Path| {
            std::fs::write(to, "somebody else's").unwrap();
            Err(std::io::Error::new(
                unsupported,
                "simulated: no hard links here",
            ))
        },
        |_| Ok(()),
    )
    .expect_err("the temp name is taken");
    assert!(matches!(err, SaveError::Write { .. }), "{err:?}");
    let taken: Vec<String> = names()
        .into_iter()
        .filter(|n| n.ends_with(".prev"))
        .collect();
    assert_eq!(taken.len(), 1, "{:?}", names());
    assert_eq!(
        std::fs::read_to_string(scratch.join(&taken[0])).unwrap(),
        "somebody else's",
        "the fallback renamed .bak over a file it did not create"
    );
    assert_eq!(std::fs::read_to_string(&config).unwrap(), v(5));
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), v(2));
    std::fs::remove_file(scratch.join(&taken[0])).unwrap();

    // `AlreadyExists` is not a missing feature: it is somebody else's file, and it is refused.
    let err = replace_config_file_with_link(
        &config,
        v(6).as_bytes(),
        &v(5),
        0o600,
        |_: &Path, _: &Path| Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists)),
        |_| Ok(()),
    )
    .expect_err("a clash is refused");
    assert!(matches!(err, SaveError::Write { .. }), "{err:?}");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), v(5));
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), v(2));
    assert_eq!(names(), clean);
}

/// Review round 2 (V2): a `.bak` that is a directory used to fail every save with an opaque link
/// error. It — and a symlinked `.bak` — is now refused BY NAME, and left exactly as it is.
#[test]
fn a_backup_that_is_not_a_regular_file_is_refused_by_name() {
    let scratch = ScratchDir::new("cfg-bakdir");
    let config = scratch.join("config.json");
    std::fs::write(&config, FULL).expect("seed");
    let bak = bak_of(&config);
    std::fs::create_dir(&bak).unwrap();
    std::fs::write(bak.join("inside.txt"), "the user's").unwrap();
    let new = FULL.replace("\"lookbackCapDays\": 7", "\"lookbackCapDays\": 3");

    let linked = std::cell::Cell::new(false);
    let err = replace_config_file_with_link(
        &config,
        new.as_bytes(),
        FULL,
        0o600,
        |_: &Path, _: &Path| {
            linked.set(true);
            Ok(())
        },
        |_| Ok(()),
    )
    .expect_err("a directory .bak");
    match &err {
        SaveError::BackupNotAFile { path, detail } => {
            assert_eq!(path, &bak.display().to_string());
            assert_eq!(detail, "a directory");
        }
        other => panic!("expected BackupNotAFile, got {other:?}"),
    }
    assert!(!linked.get(), "a directory .bak reached the link");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), FULL);
    assert_eq!(
        std::fs::read_to_string(bak.join("inside.txt")).unwrap(),
        "the user's"
    );
    assert_eq!(names_in(&scratch.path), ["config.json", "config.json.bak"]);

    // A symlinked `.bak`: refused, the link and its target untouched.
    std::fs::remove_dir_all(&bak).unwrap();
    let target = scratch.join("elsewhere.bak");
    std::fs::write(&target, "kept elsewhere").unwrap();
    std::os::unix::fs::symlink(&target, &bak).unwrap();
    let err = replace_config_file(&config, new.as_bytes(), FULL, 0o600, |_| Ok(()))
        .expect_err("a symlinked .bak");
    assert!(
        matches!(&err, SaveError::BackupNotAFile { detail, .. } if detail == "a symbolic link"),
        "{err:?}"
    );
    assert!(std::fs::symlink_metadata(&bak)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "kept elsewhere");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), FULL);
    assert_eq!(
        names_in(&scratch.path),
        ["config.json", "config.json.bak", "elsewhere.bak"]
    );

    // Through IPC: the webview gets the kind and the backup's path, after validation.
    let s = sandbox("cfg-bakipc", Some(FULL));
    std::fs::create_dir(bak_of(&s.config)).unwrap();
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(2));
    let err = s
        .save(&candidate, &base_of(&doc))
        .expect_err("directory .bak");
    assert_eq!(kind(&err), "backupNotAFile", "{err}");
    assert_eq!(err["path"], bak_of(&s.config).display().to_string());
    assert_eq!(err["detail"], "a directory");
    assert_eq!(s.on_disk(), FULL);
    assert!(bak_of(&s.config).is_dir());
    assert_eq!(s.validations(), 1);
    assert!(s.leftovers().is_empty(), "{:?}", s.leftovers());
    assert_eq!(s.candidates_left(), 0);
}

/* ── the human gates ──────────────────────────────────────────────────────────────────────────── */

#[test]
fn transcripts_cannot_be_changed_by_the_form_or_the_raw_tab() {
    let s = sandbox("cfg-transcr", Some(FULL));
    let doc = s.read();
    let base = base_of(&doc);
    let text = text_of(&doc);
    let cases = [
        // The form path: a document the form produced — canonical JSON — with the flag flipped…
        (
            "form: enabled flipped",
            edit(&text, |v| v["transcripts"]["enabled"] = json!(true)),
        ),
        // …or with the block dropped, as a form that forgot the field would.
        (
            "form: block dropped",
            edit(&text, |v| {
                v.as_object_mut().unwrap().shift_remove("transcripts");
            }),
        ),
        // The raw path: hand-typed text, not canonical, root changed.
        (
            "raw: root changed",
            text.replace(
                "\"root\": \"~/.claude/projects\"",
                "\"root\":\"/tmp/elsewhere\"",
            ),
        ),
        ("raw: enabled flipped, minified", {
            let mut v: Value = serde_json::from_str(&text).unwrap();
            v["transcripts"]["enabled"] = json!(true);
            serde_json::to_string(&v).unwrap()
        }),
    ];
    for (what, candidate) in cases {
        assert_ne!(candidate, text, "{what}: the case did not change anything");
        let err = s.save(&candidate, &base).expect_err(what);
        assert_eq!(kind(&err), "transcriptsChanged", "{what}: {err}");
        assert_eq!(s.on_disk(), FULL, "{what}: written");
    }
    assert_eq!(s.validations(), 0, "a refused candidate reached the engine");
    assert!(s.backup().is_none());

    // Reordering INSIDE the block is not a change.
    let reordered = text.replace(
        "\"transcripts\": {\n    \"enabled\": false,\n    \"root\": \"~/.claude/projects\"\n  }",
        "\"transcripts\": {\"root\": \"~/.claude/projects\", \"enabled\": false}",
    );
    assert_ne!(reordered, text, "the reorder case did not apply");
    let out = s.save(&reordered, &base).expect("a reorder is allowed");
    assert_eq!(kind(&out), "saved", "{out}");

    // And a config with NO transcripts block cannot gain one.
    let t = sandbox("cfg-tr-absent", Some(API));
    let doc = t.read();
    let added = edit(&text_of(&doc), |v| {
        v["transcripts"] = json!({ "enabled": false })
    });
    let err = t.save(&added, &base_of(&doc)).expect_err("added");
    assert_eq!(kind(&err), "transcriptsChanged", "{err}");
    assert_eq!(t.on_disk(), API);
}

#[test]
fn a_literal_api_key_is_never_shown_and_cannot_be_set_from_the_app() {
    let s = sandbox("cfg-apikey", Some(API));
    std::fs::set_permissions(
        &s.config,
        std::os::unix::fs::PermissionsExt::from_mode(0o644),
    )
    .unwrap();
    let doc = s.read();
    let text = text_of(&doc);
    assert!(
        !doc.to_string().contains(SENTINEL_KEY),
        "the key reached the webview: {doc}"
    );
    assert!(text.contains(REDACTED_API_KEY));
    assert_eq!(doc["apiKeyRedacted"], true);

    // Sent back untouched with another change: the stored key is kept, the mode tightened.
    let changed = edit(&text, |v| {
        v["provider"]["api"]["model"] = json!("claude-opus-5")
    });
    let out = s.save(&changed, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    assert_eq!(
        written["provider"]["api"]["apiKey"], SENTINEL_KEY,
        "the stored key was lost"
    );
    assert_eq!(written["provider"]["api"]["model"], "claude-opus-5");
    assert!(
        !s.validated(0).contains(REDACTED_API_KEY),
        "the engine validated the placeholder"
    );
    assert_eq!(
        mode_of(&s.config),
        0o600,
        "an API config must be owner-only, as `init` leaves it"
    );
    assert_eq!(s.backup().as_deref(), Some(API));
    // Review round 1, M4: `.bak` holds the stored key too, so it is never wider than the new file.
    assert_eq!(
        mode_of(&bak_of(&s.config)),
        0o600,
        ".bak (which carries the literal key) is world-readable"
    );

    // Setting a different literal: refused.
    let doc = s.read();
    for key in ["sk-ant-something-else", ""] {
        let other = edit(&text_of(&doc), |v| {
            v["provider"]["api"]["apiKey"] = json!(key)
        });
        let err = s.save(&other, &base_of(&doc)).expect_err("a new key");
        assert_eq!(kind(&err), "apiKeyChanged", "{err}");
    }
    // Removing it: allowed.
    let removed = edit(&text_of(&doc), |v| {
        v["provider"]["api"]
            .as_object_mut()
            .unwrap()
            .shift_remove("apiKey");
        v["provider"]["api"]["apiKeyCommand"] = json!(["security", "find-generic-password", "-w"]);
    });
    let out = s.save(&removed, &base_of(&doc)).expect("removal");
    assert_eq!(kind(&out), "saved", "{out}");
    assert!(!s.on_disk().contains(SENTINEL_KEY));

    // The placeholder with no key behind it is refused too.
    let doc = s.read();
    let pasted = edit(&text_of(&doc), |v| {
        v["provider"]["api"]["apiKey"] = json!(REDACTED_API_KEY)
    });
    let err = s
        .save(&pasted, &base_of(&doc))
        .expect_err("placeholder without a key");
    assert_eq!(kind(&err), "apiKeyChanged", "{err}");

    // P3-M2-T1: the same at EVERY pointer, not only `/provider/api/apiKey` — a `fallbacks` entry's
    // key, and a literal anywhere else in the document, at any spelling.
    let s = sandbox("cfg-apikey-all", Some(&multi_literal()));
    let doc = s.read();
    for (pointer, key) in LITERALS {
        assert!(
            !doc.to_string().contains(key),
            "{pointer}'s key reached the webview: {doc}"
        );
        let shown: Value = serde_json::from_str(&text_of(&doc)).unwrap();
        assert_eq!(
            shown.pointer(pointer),
            Some(&json!(REDACTED_API_KEY)),
            "{pointer}"
        );
    }
    assert_eq!(doc["apiKeyRedacted"], true);
    // Sent back untouched with another change: every stored key is kept where it was.
    let changed = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(7));
    let out = s.save(&changed, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());
    assert!(
        !s.validated(0).contains(REDACTED_API_KEY),
        "the engine validated the placeholder"
    );
    // The placeholder with no key behind it, at each pointer: refused, nothing validated or written.
    for (pointer, _) in LITERALS {
        let doc = s.read();
        let before = s.on_disk();
        let removed = edit(&text_of(&doc), |v| remove_at(v, pointer));
        let out = s
            .save(&removed, &base_of(&doc))
            .expect("removing a key is allowed");
        assert_eq!(kind(&out), "saved", "{pointer}: {out}");
        assert!(serde_json::from_str::<Value>(&s.on_disk())
            .unwrap()
            .pointer(pointer)
            .is_none());
        let doc = s.read();
        let validations = s.validations();
        let pasted = edit(&text_of(&doc), |v| {
            set_at(v, pointer, json!(REDACTED_API_KEY))
        });
        let err = s
            .save(&pasted, &base_of(&doc))
            .expect_err("placeholder without a key");
        assert_eq!(kind(&err), "apiKeyChanged", "{pointer}: {err}");
        assert_eq!(
            s.validations(),
            validations,
            "{pointer}: the engine was asked"
        );
        // Put the key back by hand (as a user's editor would) for the next pointer's round.
        std::fs::write(&s.config, &before).unwrap();
    }
}

/* ── P3-M2-T1: redaction is recursive; restore is by pointer, with the owner check ───────────────── */

const FALLBACK_KEY: &str = "sk-ant-FALLBACK-SENTINEL-1111";
const LOCAL_KEY: &str = "sk-local-SENTINEL-2222";
const STRAY_KEY: &str = "sk-stray-SENTINEL-3333";

/// Every literal in [`multi_literal`], by JSON pointer.
const LITERALS: [(&str, &str); 4] = [
    ("/provider/api/apiKey", SENTINEL_KEY),
    ("/fallbacks/0/api/apiKey", FALLBACK_KEY),
    ("/fallbacks/1/api/apiKey", LOCAL_KEY),
    ("/x-notes/history/0/APIKEY", STRAY_KEY),
];

/// The API fixture (item 1 `"default"`, a literal key) plus two literal-key `fallbacks` entries
/// and a literal at an odd spelling in an unknown block the engine never reads.
fn multi_literal() -> String {
    edit(API, |v| {
        v["fallbacks"] = json!([
            { "label": "backup", "api": { "kind": "anthropic", "model": "claude-haiku-5", "apiKey": FALLBACK_KEY } },
            { "label": "local", "timeoutMs": 600000,
              "api": { "kind": "openai-compatible", "model": "llama", "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": LOCAL_KEY } }
        ]);
        v["x-notes"] = json!({ "history": [{ "APIKEY": STRAY_KEY }] });
    })
}

fn assert_literals_kept(on_disk: &str) {
    let written: Value = serde_json::from_str(on_disk).unwrap();
    for (pointer, key) in LITERALS {
        assert_eq!(
            written.pointer(pointer),
            Some(&json!(key)),
            "the key at {pointer} was lost or moved"
        );
    }
}

fn parent_and_key(pointer: &str) -> (&str, &str) {
    pointer.rsplit_once('/').expect("a pointer with a parent")
}

fn set_at(v: &mut Value, pointer: &str, value: Value) {
    let (parent, key) = parent_and_key(pointer);
    v.pointer_mut(parent).expect("the parent exists")[key] = value;
}

fn remove_at(v: &mut Value, pointer: &str) {
    let (parent, key) = parent_and_key(pointer);
    v.pointer_mut(parent)
        .and_then(Value::as_object_mut)
        .expect("an object parent")
        .shift_remove(key);
}

#[test]
fn redaction_reaches_every_literal_key_and_config_read_never_returns_one() {
    let s = sandbox("cfg-redact-all", Some(&multi_literal()));
    let doc = s.read();
    let shown: Value = serde_json::from_str(&text_of(&doc)).unwrap();
    for (pointer, key) in LITERALS {
        assert!(
            !doc.to_string().contains(key),
            "{pointer}'s key reached the webview: {doc}"
        );
        assert_eq!(
            shown.pointer(pointer),
            Some(&json!(REDACTED_API_KEY)),
            "{pointer}"
        );
    }
    assert_eq!(doc["apiKeyRedacted"], true);
    // Nothing else changed: the shown document is the file with exactly those values replaced.
    let mut expected: Value = serde_json::from_str(&multi_literal()).unwrap();
    for (pointer, _) in LITERALS {
        set_at(&mut expected, pointer, json!(REDACTED_API_KEY));
    }
    assert_eq!(text_of(&doc), canonical_json(&expected));

    // A literal ONLY in a fallback still counts as redacted (the raw tab's placeholder note).
    let only_fallback = edit(&multi_literal(), |v| {
        remove_at(v, "/provider/api/apiKey");
        v["x-notes"] = json!({});
        v["fallbacks"].as_array_mut().unwrap().truncate(1);
    });
    let s = sandbox("cfg-redact-fb", Some(&only_fallback));
    let doc = s.read();
    assert!(!doc.to_string().contains(FALLBACK_KEY), "{doc}");
    assert_eq!(doc["apiKeyRedacted"], true);
    // A reference is not a literal: shown as written, and no redaction is reported.
    let reference = edit(&only_fallback, |v| {
        remove_at(v, "/fallbacks/0/api/apiKey");
        v["fallbacks"][0]["api"]["apiKeyEnv"] = json!("BACKUP_KEY");
    });
    let s = sandbox("cfg-redact-ref", Some(&reference));
    let doc = s.read();
    assert_eq!(text_of(&doc), reference);
    assert_eq!(doc["apiKeyRedacted"], false);
}

#[test]
fn a_stored_key_is_restored_at_its_own_pointer_for_item_1_and_for_a_fallback() {
    let s = sandbox("cfg-restore-ptr", Some(&multi_literal()));
    let doc = s.read();
    // Edit item 1's and each fallback's block beside its key (the form's ordinary edits).
    let changed = edit(&text_of(&doc), |v| {
        v["provider"]["api"]["model"] = json!("claude-opus-5");
        v["fallbacks"][0]["api"]["model"] = json!("claude-sonnet-5");
        v["fallbacks"][1]["timeoutMs"] = json!(900000);
    });
    let out = s.save(&changed, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    assert_eq!(written["provider"]["api"]["model"], "claude-opus-5");
    assert_eq!(written["fallbacks"][0]["api"]["model"], "claude-sonnet-5");
    assert_eq!(written["fallbacks"][1]["timeoutMs"], 900000);
    // What the engine validated is what was written: the keys, never the placeholder.
    let validated: Value = serde_json::from_str(&s.validated(0)).unwrap();
    assert_eq!(validated, written);

    // Item 1's label is RESOLVED: no `provider.label` and `"default"` are the same entry (the
    // engine's rule for an API item 1), so writing the default out is not a change of owner.
    let doc = s.read();
    let named = edit(&text_of(&doc), |v| {
        v["provider"]["label"] = json!("default")
    });
    let out = s.save(&named, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());
    // And `provider.accounts` beside an API item 1 is ignored by the engine, so it never labels
    // item 1 here either: a login list appearing beside it does not change the key's owner.
    let doc = s.read();
    let with_logins = edit(&text_of(&doc), |v| {
        v["provider"]["accounts"] = json!([{ "label": "work" }, { "label": "home" }])
    });
    let out = s.save(&with_logins, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());
}

#[test]
fn a_swap_of_two_literal_key_entries_is_refused_by_the_label_check_alone() {
    // Each case puts a placeholder at a pointer where the file holds ANOTHER entry's literal (the
    // first such slot in document order), so a pointer-only restore would put one entry's key into
    // another. No editor is involved: the Rust guard alone refuses.
    type Case = (&'static str, fn(&mut Value));
    let cases: [Case; 6] = [
        ("swap two fallbacks", |v| {
            v["fallbacks"].as_array_mut().unwrap().swap(0, 1);
        }),
        ("swap item 1 and a fallback", |v| {
            let item1 = v["provider"].clone();
            let mut first = v["fallbacks"][0].clone();
            let label = first
                .as_object_mut()
                .unwrap()
                .shift_remove("label")
                .unwrap();
            v["provider"] = first;
            v["provider"]["label"] = label;
            let mut moved = json!({ "label": "default" });
            for (k, x) in item1.as_object().unwrap() {
                moved[k] = x.clone();
            }
            v["fallbacks"][0] = moved;
        }),
        ("remove the entry above", |v| {
            v["fallbacks"].as_array_mut().unwrap().remove(0);
            // The surviving entry now sits at `/fallbacks/0`, where `backup`'s key is stored.
        }),
        ("insert an entry above", |v| {
            // A new entry carrying the placeholder lands on `backup`'s stored key's pointer.
            v["fallbacks"].as_array_mut().unwrap().insert(
                0,
                json!({ "label": "new", "api": { "kind": "anthropic", "model": "m", "apiKey": REDACTED_API_KEY } }),
            );
        }),
        ("rename the fallback that owns a key", |v| {
            v["fallbacks"][0]["label"] = json!("renamed");
        }),
        ("rename item 1", |v| {
            v["provider"]["label"] = json!("renamed");
        }),
    ];
    let s = sandbox("cfg-swap", Some(&multi_literal()));
    for (name, change) in cases {
        let doc = s.read();
        let candidate = edit(&text_of(&doc), change);
        let err = s
            .save(&candidate, &base_of(&doc))
            .expect_err(&format!("{name}: saved a key under another entry"));
        assert_eq!(kind(&err), "apiKeyChanged", "{name}: {err}");
        assert_eq!(s.on_disk(), multi_literal(), "{name}: the file changed");
        assert_eq!(s.validations(), 0, "{name}: the engine was asked");
        assert!(s.backup().is_none(), "{name}");
    }
}

#[test]
fn a_placeholder_where_the_file_holds_no_literal_is_refused() {
    let s = sandbox("cfg-ph-nokey", Some(&multi_literal()));
    type Case = (&'static str, fn(&mut Value));
    let cases: [Case; 4] = [
        ("a new fallback carrying the placeholder", |v| {
            v["fallbacks"].as_array_mut().unwrap().push(
                json!({ "label": "third", "api": { "kind": "anthropic", "model": "m", "apiKey": REDACTED_API_KEY } }),
            );
        }),
        ("the placeholder outside a fallback's api block", |v| {
            v["fallbacks"][0]["apiKey"] = json!(REDACTED_API_KEY);
        }),
        (
            "the placeholder at another spelling of the stored key's name",
            |v| {
                remove_at(v, "/provider/api/apiKey");
                v["provider"]["api"]["ApiKey"] = json!(REDACTED_API_KEY);
            },
        ),
        ("the placeholder nested where nothing is stored", |v| {
            v["x-notes"]["history"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "apiKey": REDACTED_API_KEY }));
        }),
    ];
    for (name, change) in cases {
        let doc = s.read();
        let candidate = edit(&text_of(&doc), change);
        let err = s
            .save(&candidate, &base_of(&doc))
            .expect_err(&format!("{name}: saved the placeholder as a key"));
        assert_eq!(kind(&err), "apiKeyChanged", "{name}: {err}");
        assert_eq!(s.on_disk(), multi_literal(), "{name}: the file changed");
        assert_eq!(s.validations(), 0, "{name}: the engine was asked");
    }
}

/// A slot inside `provider.accounts[j]` is login `j`'s, not item 1's: reordering the logins below
/// item 1 leaves item 1's label alone, so only the login's own label can catch the move. (The engine
/// never reads a key there — a CLI item 1 has no `api` block — but restore must still never put
/// one entry's key into another.)
#[test]
fn a_key_inside_a_login_is_owned_by_that_login() {
    let initial = edit(API, |v| {
        v["provider"] = json!({ "cli": "claude", "argv": ["-p"], "promptVia": "stdin",
            "accounts": [{ "label": "a" }, { "label": "b", "apiKey": FALLBACK_KEY }, { "label": "c", "apiKey": LOCAL_KEY }] });
    });
    let s = sandbox("cfg-login-owner", Some(&initial));
    let doc = s.read();
    assert!(!doc.to_string().contains(FALLBACK_KEY), "{doc}");
    assert!(!doc.to_string().contains(LOCAL_KEY), "{doc}");
    // Both logins hold a key, so after the swap each placeholder sits where the OTHER's is stored.
    let swapped = edit(&text_of(&doc), |v| {
        v["provider"]["accounts"].as_array_mut().unwrap().swap(1, 2)
    });
    let err = s
        .save(&swapped, &base_of(&doc))
        .expect_err("b's key moved into login c");
    assert_eq!(kind(&err), "apiKeyChanged", "{err}");
    assert_eq!(s.on_disk(), initial);
    let unrelated = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(3));
    let out = s.save(&unrelated, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    assert_eq!(written["provider"]["accounts"][1]["apiKey"], FALLBACK_KEY);
    assert_eq!(written["provider"]["accounts"][2]["apiKey"], LOCAL_KEY);
}

/// `gui/src/lib/wizard.ts` `providerValue`, the api path, on a re-run over a config holding a
/// literal: it REBUILDS `provider` (the kept api keys first, then `kind`, `model`, the references,
/// and `apiKey: REDACTED_API_KEY` last — `wizard.ts:465-479`), so key order changes; the
/// placeholder must come back as today's literal, byte for byte, and a fallback's literal stays.
#[test]
fn a_wizard_re_run_round_trips_todays_literal_unchanged() {
    for (tag, initial) in [
        ("cfg-wizard-api", API.to_string()),
        ("cfg-wizard-multi", multi_literal()),
    ] {
        let s = sandbox(tag, Some(&initial));
        let doc = s.read();
        let rebuilt = edit(&text_of(&doc), |v| {
            let api = v["provider"]["api"].clone();
            let mut out = serde_json::Map::new();
            for (k, x) in api.as_object().unwrap() {
                if !["kind", "model", "apiKeyFile", "apiKeyCommand", "apiKey"].contains(&k.as_str())
                {
                    out.insert(k.clone(), x.clone());
                }
            }
            out.insert("kind".into(), json!("anthropic"));
            out.insert("model".into(), json!("claude-opus-5"));
            let stored = api["apiKey"] == json!(REDACTED_API_KEY);
            assert!(stored, "{tag}: the wizard saw no placeholder to carry");
            out.insert("apiKey".into(), json!(REDACTED_API_KEY));
            v["provider"] = json!({ "api": Value::Object(out) });
        });
        let out = s.save(&rebuilt, &base_of(&doc)).expect("save");
        assert_eq!(kind(&out), "saved", "{tag}: {out}");
        let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
        assert_eq!(written["provider"]["api"]["apiKey"], SENTINEL_KEY, "{tag}");
        assert_eq!(
            written["provider"]["api"]["model"], "claude-opus-5",
            "{tag}"
        );
        if tag == "cfg-wizard-multi" {
            assert_literals_kept(&s.on_disk());
        }
        assert!(!s.on_disk().contains(REDACTED_API_KEY), "{tag}");
    }
}

/* ── P3-M2-T1 checkpoint: a stored key is bound to its endpoint, and to a label no one shares ────── */

/// Save `change` over what `config_read` shows.
fn try_change(s: &Sandbox, change: impl FnOnce(&mut Value)) -> Result<Value, Value> {
    let doc = s.read();
    let candidate = edit(&text_of(&doc), change);
    s.save(&candidate, &base_of(&doc))
}

/// `change` is refused as `apiKeyChanged` before the engine is asked, and the file is `initial`.
fn assert_refused(s: &Sandbox, initial: &str, name: &str, change: impl FnOnce(&mut Value)) {
    let validations = s.validations();
    let err = try_change(s, change).expect_err(&format!("{name}: saved"));
    assert_eq!(kind(&err), "apiKeyChanged", "{name}: {err}");
    assert_eq!(s.on_disk(), initial, "{name}: the file changed");
    assert_eq!(s.validations(), validations, "{name}: the engine was asked");
}

/// `change` saves, with the stored `key` back at `pointer`; then the file is put back to `initial`.
fn assert_restored(
    s: &Sandbox,
    initial: &str,
    name: &str,
    pointer: &str,
    key: &str,
    change: impl FnOnce(&mut Value),
) {
    let out = try_change(s, change).unwrap_or_else(|e| panic!("{name}: {e}"));
    assert_eq!(kind(&out), "saved", "{name}: {out}");
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    assert_eq!(written.pointer(pointer), Some(&json!(key)), "{name}");
    assert!(!s.on_disk().contains(REDACTED_API_KEY), "{name}");
    std::fs::write(&s.config, initial).unwrap();
}

/// The checkpoint's HIGH (reviewer probe, and P6): restore checked only the LABEL, so a block
/// replaced under the same label — the wizard's Anthropic → local re-run, which carried the
/// placeholder into the new `openai-compatible` block — got the stored literal, and the engine sent
/// it as a bearer token to the new host (over plain `http:` to a LAN address). The owning block's
/// `api.kind` and the ORIGIN of its `api.baseUrl` (scheme, host, port; absent = the kind's default)
/// must be the same on disk and in the candidate. The Rust guard alone refuses; no editor is
/// involved.
#[test]
fn a_stored_key_is_bound_to_its_endpoint_kind_and_origin() {
    let initial = multi_literal();
    let s = sandbox("cfg-endpoint", Some(&initial));
    type Case = (&'static str, fn(&mut Value));
    let refused: [Case; 9] = [
        (
            "the wizard repro: item 1 rebuilt as a LAN endpoint, the placeholder carried",
            |v| {
                // What `providerValue`'s local path built before the fix: the existing api keys it
                // did not own (`maxTokens`, `apiKey`) first, then `kind`, `model`, `baseUrl`.
                v["provider"]["api"] = json!({ "maxTokens": 4096, "apiKey": REDACTED_API_KEY,
                "kind": "openai-compatible", "model": "llama3", "baseUrl": "http://192.168.1.5:8080/v1" });
            },
        ),
        (
            "P6: a fallback's block replaced under the same label",
            |v| {
                v["fallbacks"][0]["api"] = json!({ "kind": "openai-compatible", "model": "m",
                "baseUrl": "http://evil.example/v1", "apiKey": REDACTED_API_KEY });
            },
        ),
        (
            "the same kind, another host (absent → the Anthropic default before)",
            |v| {
                v["fallbacks"][0]["api"]["baseUrl"] = json!("https://evil.example");
            },
        ),
        ("item 1's host changed", |v| {
            v["provider"]["api"]["baseUrl"] = json!("https://gateway.example.com");
        }),
        ("a port change", |v| {
            v["fallbacks"][1]["api"]["baseUrl"] = json!("http://127.0.0.1:11435/v1");
        }),
        ("a scheme change", |v| {
            v["fallbacks"][1]["api"]["baseUrl"] = json!("https://127.0.0.1:11434/v1");
        }),
        ("the kind alone changed", |v| {
            v["fallbacks"][1]["api"]["kind"] = json!("anthropic");
        }),
        (
            "an openai-compatible baseUrl removed (that kind has no default)",
            |v| {
                remove_at(v, "/fallbacks/1/api/baseUrl");
            },
        ),
        ("a baseUrl that does not parse", |v| {
            v["fallbacks"][1]["api"]["baseUrl"] = json!("http://[127.0.0.1:11434/v1");
        }),
    ];
    for (name, change) in refused {
        assert_refused(&s, &initial, name, change);
    }
    // The same origin is the same endpoint: a model change, a path change, the default port or the
    // kind's default spelled out, and a different letter case all keep the key.
    let restored: [(&str, &str, &str, fn(&mut Value)); 6] = [
        (
            "a model change",
            "/fallbacks/1/api/apiKey",
            LOCAL_KEY,
            |v| {
                v["fallbacks"][1]["api"]["model"] = json!("qwen");
            },
        ),
        (
            "a path change on the same origin",
            "/fallbacks/1/api/apiKey",
            LOCAL_KEY,
            |v| {
                v["fallbacks"][1]["api"]["baseUrl"] = json!("http://127.0.0.1:11434/api");
            },
        ),
        (
            "the letter case of the scheme and host",
            "/fallbacks/1/api/apiKey",
            LOCAL_KEY,
            |v| {
                v["fallbacks"][1]["api"]["baseUrl"] = json!("HTTP://127.0.0.1:11434/v1/");
            },
        ),
        (
            "the default port spelled out",
            "/provider/api/apiKey",
            SENTINEL_KEY,
            |v| {
                v["provider"]["api"]["baseUrl"] = json!("https://API.anthropic.com:443/v1");
            },
        ),
        (
            "the Anthropic default spelled out",
            "/fallbacks/0/api/apiKey",
            FALLBACK_KEY,
            |v| {
                v["fallbacks"][0]["api"]["baseUrl"] = json!("https://api.anthropic.com");
            },
        ),
        (
            "item 1's baseUrl removed (the kind's default is the same origin)",
            "/provider/api/apiKey",
            SENTINEL_KEY,
            |v| {
                remove_at(v, "/provider/api/baseUrl");
            },
        ),
    ];
    for (name, pointer, key, change) in restored {
        assert_restored(&s, &initial, name, pointer, key, change);
    }
}

/// The checkpoint's MED (probes P1, P1b): two entries sharing a label defeat the owner check, so
/// removing the first put its key into the second. Labels are unique across the combined list
/// (spec §4); the Rust guard refuses a restore whose owning label occurs more than once, on either
/// side, counting item 1's resolved label (or its logins'), and every fallback's.
#[test]
fn a_label_two_entries_share_never_owns_a_restored_key() {
    const K0: &str = "sk-ant-DUP-SENTINEL-0000";
    const K1: &str = "sk-ant-DUP-SENTINEL-1111";
    // The same kind and endpoint on both, so only the label check can tell them apart.
    let dup = edit(API, |v| {
        v["fallbacks"] = json!([
            { "label": "a", "api": { "kind": "anthropic", "model": "m1", "apiKey": K0 } },
            { "label": "a", "api": { "kind": "anthropic", "model": "m2", "apiKey": K1 } }
        ]);
    });
    let s = sandbox("cfg-dup-disk", Some(&dup));
    assert_refused(
        &s,
        &dup,
        "P1: the first of two \"a\" entries removed",
        |v| {
            v["fallbacks"].as_array_mut().unwrap().remove(0);
        },
    );
    assert_refused(&s, &dup, "P1b: the two \"a\" entries swapped", |v| {
        v["fallbacks"].as_array_mut().unwrap().swap(0, 1);
    });
    // While the labels collide, the guard cannot tell whose key a placeholder is, so even an
    // unrelated save is refused: the user renames one by hand, or moves the keys out first.
    assert_refused(&s, &dup, "an unrelated edit beside colliding labels", |v| {
        v["lookbackCapDays"] = json!(3);
    });

    // A collision only in the CANDIDATE is refused too.
    const KEY: &str = "sk-ant-ONE-SENTINEL-2222";
    let one = edit(API, |v| {
        v["fallbacks"] =
            json!([{ "label": "a", "api": { "kind": "anthropic", "model": "m1", "apiKey": KEY } }]);
    });
    let s = sandbox("cfg-dup-cand", Some(&one));
    assert_refused(&s, &one, "a second \"a\" entry added", |v| {
        v["fallbacks"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "label": "a", "api": { "kind": "anthropic", "model": "m2" } }));
    });
    // Item 1's RESOLVED label counts: an API item 1 with no `provider.label` is "default".
    assert_refused(&s, &one, "a fallback labelled like item 1", |v| {
        v["fallbacks"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "label": "default", "api": { "kind": "anthropic", "model": "m2" } }));
    });
    // The control: a distinct label saves, with every key where it was.
    assert_restored(
        &s,
        &one,
        "a distinct label added",
        "/fallbacks/0/api/apiKey",
        KEY,
        |v| {
            v["fallbacks"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "label": "b", "api": { "kind": "anthropic", "model": "m2" } }));
        },
    );

    // A CLI item 1's logins count as entries of the combined list.
    let logins = edit(API, |v| {
        v["provider"] = json!({ "cli": "claude", "argv": ["-p"], "promptVia": "stdin",
            "accounts": [{ "label": "a" }, { "label": "b", "apiKey": KEY }] });
    });
    let s = sandbox("cfg-dup-login", Some(&logins));
    assert_refused(&s, &logins, "a fallback labelled like a login", |v| {
        v["fallbacks"] = json!([{ "label": "b", "api": { "kind": "anthropic", "model": "m" } }]);
    });
}

/// Checkpoint LOW: redaction covered only STRINGS, so an array, an object, a number or a boolean at
/// an `apiKey` slot was shown verbatim. Every non-null value there is redacted now (the slots
/// `holds_literal_api_key` refuses at create), and restore puts back exactly what the file holds
/// at that pointer — never a value from anywhere else, and never over a `null`.
#[test]
fn a_non_string_value_at_a_key_slot_is_never_shown_and_round_trips() {
    let initial = edit(API, |v| {
        v["fallbacks"] = json!([{ "label": "backup",
            "api": { "kind": "anthropic", "model": "m", "apiKey": ["sk-arr-SENTINEL-4444"] } }]);
        v["x-notes"] = json!({ "apikey": { "nested": "sk-obj-SENTINEL-5555" },
            "ApiKey": 987654321987_u64, "APIKEY": true, "apiKEY": null });
    });
    let slots = [
        "/fallbacks/0/api/apiKey",
        "/x-notes/apikey",
        "/x-notes/ApiKey",
        "/x-notes/APIKEY",
    ];
    let s = sandbox("cfg-nonstring", Some(&initial));
    let doc = s.read();
    for secret in [
        "sk-arr-SENTINEL-4444",
        "sk-obj-SENTINEL-5555",
        "987654321987",
        SENTINEL_KEY,
    ] {
        assert!(
            !doc.to_string().contains(secret),
            "{secret} reached the webview: {doc}"
        );
    }
    let shown: Value = serde_json::from_str(&text_of(&doc)).unwrap();
    for pointer in slots {
        assert_eq!(
            shown.pointer(pointer),
            Some(&json!(REDACTED_API_KEY)),
            "{pointer}"
        );
    }
    assert_eq!(
        shown.pointer("/x-notes/apiKEY"),
        Some(&Value::Null),
        "a null holds nothing"
    );
    // Sent back with an unrelated change: each slot gets back exactly what the file held.
    let out = try_change(&s, |v| v["lookbackCapDays"] = json!(3)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    let original: Value = serde_json::from_str(&initial).unwrap();
    for pointer in slots
        .iter()
        .copied()
        .chain(["/x-notes/apiKEY", "/provider/api/apiKey"])
    {
        assert_eq!(
            written.pointer(pointer),
            original.pointer(pointer),
            "{pointer}"
        );
    }
    std::fs::write(&s.config, &initial).unwrap();
    // The placeholder where the file holds `null` is a placeholder with no key behind it.
    assert_refused(&s, &initial, "the placeholder over a null", |v| {
        v["x-notes"]["apiKEY"] = json!(REDACTED_API_KEY);
    });
}

/* ── P3-M2-T2: refuse only a NEW or CHANGED literal, at every pointer; 0600 for any api block ───── */

/// After restore, a key slot (`apiKey` at any ASCII case, at any depth) holding any non-null value
/// must hold what the file holds at the SAME pointer. Anything else is the app setting or changing
/// a literal, refused before the engine is asked, with the config and its `.bak` untouched. The
/// reviewer's probes: P4, a new `fallbacks[0].api.apiKey: "sk-NEW"` saved; P5, a changed stored
/// fallback literal overwrote the key, which survived only in `.bak`.
#[test]
fn a_new_or_changed_literal_is_refused_at_every_pointer() {
    // P4, exactly: a fallback whose key is a reference on disk gains a literal beside it.
    let by_reference = edit(API, |v| {
        v["fallbacks"] = json!([{ "label": "backup",
            "api": { "kind": "anthropic", "model": "m", "apiKeyEnv": "BACKUP_KEY" } }]);
    });
    let s = sandbox("cfg-new-lit-ref", Some(&by_reference));
    assert_refused(&s, &by_reference, "P4: a new fallbacks[0] literal", |v| {
        v["fallbacks"][0]["api"]["apiKey"] = json!("sk-NEW");
    });
    assert_eq!(s.backup(), None, "P4: a .bak was written");

    let initial = multi_literal();
    let s = sandbox("cfg-new-lit", Some(&initial));
    type Case = (&'static str, fn(&mut Value));
    let refused: [Case; 11] = [
        ("P5: a changed stored fallback literal", |v| {
            v["fallbacks"][0]["api"]["apiKey"] = json!("sk-CHANGED");
        }),
        ("a changed item-1 literal", |v| {
            v["provider"]["api"]["apiKey"] = json!("sk-CHANGED");
        }),
        ("a changed literal in a block the engine never reads", |v| {
            v["x-notes"]["history"][0]["APIKEY"] = json!("sk-CHANGED");
        }),
        ("a new fallback carrying a literal", |v| {
            v["fallbacks"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "label": "third",
                "api": { "kind": "anthropic", "model": "m", "apiKey": "sk-NEW" } }));
        }),
        ("a case variant beside item 1's placeholder", |v| {
            v["provider"]["api"]["APIKEY"] = json!("sk-NEW");
        }),
        ("a case variant beside a fallback's placeholder", |v| {
            v["fallbacks"][1]["api"]["ApiKey"] = json!("sk-NEW");
        }),
        ("a literal at a new pointer outside any entry", |v| {
            v["x-other"] = json!({ "apikey": "sk-NEW" });
        }),
        ("a stored key sent verbatim to ANOTHER pointer", |v| {
            v["fallbacks"][1]["api"]["apiKey"] = json!(FALLBACK_KEY);
        }),
        ("a stored key sent verbatim into a new entry", |v| {
            v["fallbacks"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "label": "third",
                "api": { "kind": "anthropic", "model": "m", "apiKey": SENTINEL_KEY } }));
        }),
        ("a non-string value over a stored literal", |v| {
            v["fallbacks"][0]["api"]["apiKey"] = json!(["sk-NEW"]);
        }),
        ("an empty string over a stored literal", |v| {
            v["fallbacks"][0]["api"]["apiKey"] = json!("");
        }),
    ];
    for (name, change) in refused {
        assert_refused(&s, &initial, name, change);
        assert_eq!(s.backup(), None, "{name}: a .bak was written");
    }

    // A placeholder-only round trip is the no-op it always was.
    let doc = s.read();
    let out = s.save(&text_of(&doc), &base_of(&doc)).expect("round trip");
    assert_eq!(kind(&out), "unchanged", "{out}");
    // An unrelated edit beside every stored literal saves (today's literal-key users), keys kept.
    let out = try_change(&s, |v| v["lookbackCapDays"] = json!(9)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());
    // The other write path, whose candidate holds the literals VERBATIM (the file, parsed, plus one
    // edit): the Quit offer over the same file saves, and every literal stays where it was.
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("offer");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());
    // Removing a literal is allowed, at a fallback as at item 1.
    let out = try_change(&s, |v| {
        remove_at(v, "/fallbacks/0/api/apiKey");
        v["fallbacks"][0]["api"]["apiKeyEnv"] = json!("BACKUP_KEY");
    })
    .expect("removal");
    assert_eq!(kind(&out), "saved", "{out}");
    assert!(!s.on_disk().contains(FALLBACK_KEY));
    // Removing by `null` is a removal too: a `null` slot holds nothing (checkpoint P3-M2 LOW,
    // the surviving mutant that counted `null` as a literal).
    let out = try_change(&s, |v| v["fallbacks"][1]["api"]["apiKey"] = Value::Null)
        .expect("removal by null");
    assert_eq!(kind(&out), "saved", "{out}");
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    assert_eq!(
        written.pointer("/fallbacks/1/api/apiKey"),
        Some(&Value::Null)
    );
    assert!(!s.on_disk().contains(LOCAL_KEY));
}

/// Checkpoint P3-M2 LOW (reviewer probes): a literal sent back VERBATIM — the stored value itself
/// rather than the placeholder — skipped the owner and endpoint checks a restored one passes, so an
/// editor could keep a stored key while pointing its entry at another host, or rename the entry
/// that owns it. A literal that survives is bound to its owner and endpoint like a restored one.
/// The unique-label check is NOT applied to it: the Quit offer and calendar saves rebuild the
/// candidate from the parsed file, and a hand-written config with duplicate labels must keep them
/// working.
#[test]
fn a_verbatim_literal_is_bound_to_its_owner_and_endpoint_like_a_restored_one() {
    let initial = multi_literal();
    let s = sandbox("cfg-verbatim", Some(&initial));
    type Case = (&'static str, fn(&mut Value));
    let refused: [Case; 4] = [
        (
            "the probe: fallbacks[0]'s stored key verbatim, its baseUrl now another host",
            |v| {
                v["fallbacks"][0]["api"]["apiKey"] = json!(FALLBACK_KEY);
                v["fallbacks"][0]["api"]["baseUrl"] = json!("https://evil.example/v1");
            },
        ),
        (
            "the probe: fallbacks[0] renamed, its stored key verbatim",
            |v| {
                v["fallbacks"][0]["label"] = json!("renamed");
                v["fallbacks"][0]["api"]["apiKey"] = json!(FALLBACK_KEY);
            },
        ),
        (
            "item 1's stored key verbatim, its kind now openai-compatible",
            |v| {
                v["provider"]["api"]["apiKey"] = json!(SENTINEL_KEY);
                v["provider"]["api"]["kind"] = json!("openai-compatible");
                v["provider"]["api"]["baseUrl"] = json!("http://192.168.1.5:8080/v1");
            },
        ),
        ("item 1 labelled, its stored key verbatim", |v| {
            v["provider"]["label"] = json!("work");
            v["provider"]["api"]["apiKey"] = json!(SENTINEL_KEY);
        }),
    ];
    for (name, change) in refused {
        assert_refused(&s, &initial, name, change);
        assert_eq!(s.backup(), None, "{name}: a .bak was written");
    }
    // The control: an unrelated edit with EVERY stored literal sent verbatim saves, keys kept.
    let out = try_change(&s, |v| {
        for (pointer, key) in LITERALS {
            set_at(v, pointer, json!(key));
        }
        v["lookbackCapDays"] = json!(9);
    })
    .expect("an unrelated edit with verbatim literals");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_literals_kept(&s.on_disk());

    // A hand-written config whose two literal-key entries share a label: the write paths that
    // rebuild the candidate from the parsed file keep working over it.
    const K0: &str = "sk-ant-DUPV-SENTINEL-0000";
    const K1: &str = "sk-ant-DUPV-SENTINEL-1111";
    let dup = edit(API, |v| {
        v["fallbacks"] = json!([
            { "label": "a", "api": { "kind": "anthropic", "model": "m1", "apiKey": K0 } },
            { "label": "a", "api": { "kind": "anthropic", "model": "m2", "apiKey": K1 } }
        ]);
    });
    let s = sandbox("cfg-verbatim-dup", Some(&dup));
    let kept = |s: &Sandbox, name: &str| {
        let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
        assert_eq!(
            written.pointer("/fallbacks/0/api/apiKey"),
            Some(&json!(K0)),
            "{name}"
        );
        assert_eq!(
            written.pointer("/fallbacks/1/api/apiKey"),
            Some(&json!(K1)),
            "{name}"
        );
        assert_eq!(
            written.pointer("/provider/api/apiKey"),
            Some(&json!(SENTINEL_KEY)),
            "{name}"
        );
    };
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("the Quit offer over duplicate labels");
    assert_eq!(kind(&out), "saved", "{out}");
    kept(&s, "the Quit offer");
    let block = json!({ "enabled": false, "links": [] });
    let out = s
        .call("calendar_config_save", json!({ "text": block.to_string() }))
        .expect("a calendar save over duplicate labels");
    assert_eq!(kind(&out), "saved", "{out}");
    kept(&s, "the calendar save");
}

/// Owner-only whenever ANY `api` block exists on either side — item 1's or a `fallbacks[i].api` —
/// or a literal sits anywhere in the file; the `.bak`, which may carry the old key, is never wider.
/// Before P3-M2-T2 only `/provider/api` counted, so a CLI item 1 with an API fallback holding a
/// literal kept a 0644 file and a 0644 `.bak`.
#[test]
fn an_api_block_only_in_fallbacks_makes_the_file_and_its_bak_owner_only() {
    let with_fallback = edit(FULL, |v| {
        v["fallbacks"] = json!([{ "label": "api-backup",
            "api": { "kind": "anthropic", "model": "m", "apiKey": FALLBACK_KEY } }]);
    });
    let world_readable = |s: &Sandbox| {
        std::fs::set_permissions(
            &s.config,
            std::os::unix::fs::PermissionsExt::from_mode(0o644),
        )
        .unwrap()
    };
    type Case = (&'static str, String, fn(&mut Value));
    let cases: [Case; 5] = [
        (
            "both sides: an unrelated edit beside the fallback's literal",
            with_fallback.clone(),
            |v| v["lookbackCapDays"] = json!(5),
        ),
        (
            "the file side only: the API fallback removed, its literal now only in .bak",
            with_fallback.clone(),
            |v| {
                v.as_object_mut().unwrap().shift_remove("fallbacks");
            },
        ),
        (
            // Checkpoint P3-M2 LOW: no literal anywhere, so only the FILE's api block can make it
            // owner-only (the surviving mutant dropped `holds_api_block(&on_disk)`).
            "the file side only, by reference: the API fallback removed, no literal anywhere",
            edit(FULL, |v| {
                v["fallbacks"] = json!([{ "label": "api-backup",
                    "api": { "kind": "anthropic", "model": "m", "apiKeyEnv": "BACKUP_KEY" } }]);
            }),
            |v| {
                v.as_object_mut().unwrap().shift_remove("fallbacks");
            },
        ),
        (
            "the candidate side only: a CLI config gains an API fallback (by reference)",
            FULL.to_string(),
            |v| {
                v["fallbacks"] = json!([{ "label": "api-backup",
                    "api": { "kind": "anthropic", "model": "m", "apiKeyEnv": "BACKUP_KEY" } }]);
            },
        ),
        (
            "no api block, a literal in a block the engine never reads",
            edit(FULL, |v| v["x-notes"] = json!({ "apiKey": STRAY_KEY })),
            |v| v["lookbackCapDays"] = json!(5),
        ),
    ];
    for (i, (name, initial, change)) in cases.into_iter().enumerate() {
        let s = sandbox(&format!("cfg-mode-fb-{i}"), Some(&initial));
        world_readable(&s);
        let out = try_change(&s, change).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(kind(&out), "saved", "{name}: {out}");
        assert_eq!(s.backup().as_deref(), Some(initial.as_str()), "{name}");
        assert_eq!(mode_of(&s.config), 0o600, "{name}: the config");
        assert_eq!(mode_of(&bak_of(&s.config)), 0o600, "{name}: the .bak");
    }
}

/// Checkpoint LOW (surviving mutants A, C, K): the label rule is the engine's `nonEmpty` — empty
/// after JavaScript's `trim()`, which strips Unicode white space but NOT U+0085. A fallback whose
/// label is only spaces has no label (the engine drops it), so it owns no key on either side; one
/// labelled U+0085 is a real label and keeps its key.
#[test]
fn the_label_rule_is_javascripts_trim() {
    const KEY: &str = "sk-ant-LABEL-SENTINEL-6666";
    let with_label = |label: &str| {
        edit(API, |v| {
            v["fallbacks"] = json!([{ "label": label, "api": { "kind": "anthropic", "model": "m", "apiKey": KEY } }]);
        })
    };
    let blank = with_label("  ");
    let s = sandbox("cfg-label-blank", Some(&blank));
    assert_refused(&s, &blank, "a label of spaces on both sides", |v| {
        v["fallbacks"][0]["api"]["model"] = json!("m2");
    });
    let nel = with_label("\u{85}");
    let s = sandbox("cfg-label-nel", Some(&nel));
    assert_restored(
        &s,
        &nel,
        "a label of U+0085",
        "/fallbacks/0/api/apiKey",
        KEY,
        |v| {
            v["fallbacks"][0]["api"]["model"] = json!("m2");
        },
    );
}

/// Checkpoint LOW (surviving mutant H): a CLI item 1 is labelled by its FIRST LOGIN, as the engine
/// labels it — `provider.label` is ignored beside `accounts`. So relabelling `accounts[0]` changes
/// the owner of a stray key in `provider`, even though `provider.label` stayed.
#[test]
fn a_cli_item_1_is_labelled_by_its_first_login() {
    const KEY: &str = "sk-stray-CLI-SENTINEL-7777";
    let initial = edit(API, |v| {
        v["provider"] = json!({ "cli": "claude", "argv": ["-p"], "promptVia": "stdin",
            "label": "P", "apiKey": KEY, "accounts": [{ "label": "a" }] });
    });
    let s = sandbox("cfg-cli-label", Some(&initial));
    assert_refused(&s, &initial, "the first login relabelled", |v| {
        v["provider"]["accounts"][0]["label"] = json!("b");
    });
    assert_restored(
        &s,
        &initial,
        "an unrelated edit",
        "/provider/apiKey",
        KEY,
        |v| {
            v["lookbackCapDays"] = json!(3);
        },
    );
}

/* ── where, and from whom ─────────────────────────────────────────────────────────────────────── */

/// The written path is the one `status --json` reported — here a scratch path no platform config
/// directory could produce — and the webview cannot add another.
#[test]
fn the_path_is_status_configpath_and_the_webview_cannot_supply_one() {
    let s = sandbox("cfg-path", Some(FULL));
    let evil = s.scratch.join("evil.json");
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(5));
    let out = s
        .call(
            "config_save",
            json!({
                "text": candidate,
                "base": base_of(&doc),
                "path": evil,
                "file": evil,
                "configPath": evil,
            }),
        )
        .expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_eq!(out["path"], s.config.display().to_string());
    assert_eq!(s.on_disk(), candidate);
    assert!(!evil.exists(), "a webview-supplied path was written");

    // The candidate went under the app's candidate directory, as an absolute path.
    let validated = std::fs::read_to_string(s.record.join("validated-paths.txt")).unwrap();
    let candidate_path = PathBuf::from(validated.trim());
    assert!(candidate_path.is_absolute());
    assert!(
        candidate_path.starts_with(&s.candidates),
        "{}",
        candidate_path.display()
    );

    // The app's platform config dir is not where it went.
    use tauri::Manager;
    if let Ok(dir) = s.app.path().app_config_dir() {
        assert!(!s.config.starts_with(&dir));
    }

    // ⚠ AND BY SIGNATURE: `config_save` takes text and a base token, nothing path-shaped, and the
    // module never asks Tauri for its config directory.
    let source = include_str!("../src/config_save.rs");
    const OPEN: &str = "pub async fn config_save<R: Runtime>(";
    let start = source.find(OPEN).expect("config_save's signature") + OPEN.len();
    let params_text = &source[start..start + source[start..].find(") ->").expect("signature end")];
    let params: Vec<&str> = params_text
        .split(",\n")
        .map(|p| p.trim().trim_end_matches(','))
        .filter(|p| !p.is_empty())
        .collect();
    assert_eq!(
        params,
        [
            "app: AppHandle<R>",
            "engine: State<'_, Engine>",
            "saver: State<'_, ConfigSaver>",
            "text: String",
            "base: String",
        ],
        "config_save's parameters changed; the webview must never be able to name a path"
    );
    let code: String = source
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        !code.contains("app_config_dir"),
        "config_save.rs resolves Tauri's config dir"
    );
}

#[test]
fn a_file_changed_since_it_was_loaded_is_a_conflict() {
    let s = sandbox("cfg-conflict", Some(FULL));
    let doc = s.read();
    let edited_elsewhere = FULL.replace("\"lookbackCapDays\": 7", "\"lookbackCapDays\": 8");
    std::fs::write(&s.config, &edited_elsewhere).unwrap();
    let candidate = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(9));
    let err = s.save(&candidate, &base_of(&doc)).expect_err("stale base");
    assert_eq!(kind(&err), "conflict", "{err}");
    assert_eq!(s.on_disk(), edited_elsewhere);
    assert_eq!(s.validations(), 0);
    assert_eq!(base_of(&s.read()), digest(edited_elsewhere.as_bytes()));
}

#[test]
fn no_config_a_symlink_and_unparseable_json_are_refused_not_replaced() {
    // No config: read says so; a save is refused (Settings does not create one).
    let s = sandbox("cfg-none", None);
    let doc = s.read();
    assert_eq!(doc["exists"], false);
    assert!(doc["text"].is_null());
    let err = s.save(FULL, "anything").expect_err("no config");
    assert_eq!(kind(&err), "noConfig", "{err}");
    assert!(!s.config.exists(), "a config was created");
    let err = s
        .call("config_offer_notify_auto", json!({}))
        .expect_err("no config");
    assert_eq!(kind(&err), "noConfig", "{err}");
    assert!(!s.config.exists());

    // A symlinked config: refused, and the link survives as a link to the untouched target.
    let s = sandbox("cfg-link", None);
    let target = s.scratch.join("dotfiles-config.json");
    std::fs::write(&target, FULL).unwrap();
    std::os::unix::fs::symlink(&target, &s.config).unwrap();
    let err = s.call("config_read", json!({})).expect_err("symlink");
    assert_eq!(kind(&err), "configUnreadable", "{err}");
    assert!(
        err["detail"].as_str().unwrap().contains("symbolic link"),
        "{err}"
    );
    let err = s.save(FULL, &digest(FULL.as_bytes())).expect_err("symlink");
    assert_eq!(kind(&err), "configUnreadable", "{err}");
    assert!(std::fs::symlink_metadata(&s.config)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), FULL);

    // Not JSON on disk: shown as such, never replaced.
    let broken = "{\n  \"lookbackCapDays\": 7,\n";
    let s = sandbox("cfg-broken", Some(broken));
    let doc = s.read();
    assert_eq!(doc["exists"], true);
    assert!(doc["text"].is_null());
    assert!(doc["parseError"].as_str().is_some());
    let err = s.save(FULL, &base_of(&doc)).expect_err("broken on disk");
    assert_eq!(kind(&err), "onDiskNotJson", "{err}");
    assert_eq!(s.on_disk(), broken);

    // A candidate that is not a JSON object.
    let s = sandbox("cfg-notjson", Some(FULL));
    let doc = s.read();
    for bad in ["{ nope", "[1, 2]", "\"a string\""] {
        let err = s.save(bad, &base_of(&doc)).expect_err(bad);
        assert_eq!(kind(&err), "notJson", "{bad}: {err}");
    }
    assert_eq!(s.on_disk(), FULL);
}

/* ── review round 1: the guards the first round left unpinned ────────────────────────────────── */

/// M7: the file is re-read after validation and just before the swap. An editor that saves while
/// the engine is validating wins: its bytes stay, `.bak` is untouched, nothing is left behind.
#[test]
fn an_edit_that_lands_during_validation_is_a_conflict_and_is_kept() {
    let s = sandbox("cfg-midcheck", Some(FULL));
    std::fs::write(bak_of(&s.config), "an older backup").expect("seed .bak");
    let editor = FULL.replace("\"lookbackCapDays\": 7", "\"lookbackCapDays\": 11");
    std::fs::write(s.record.join("rewrite-with.json"), &editor).expect("the editor's bytes");
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["x-test"] = json!("__rewrite__"));
    let err = s
        .save(&candidate, &base_of(&doc))
        .expect_err("the file changed under the save");
    assert_eq!(kind(&err), "conflict", "{err}");
    assert_eq!(s.validations(), 1, "the base check fired before validation");
    assert_eq!(s.on_disk(), editor, "the editor's save was overwritten");
    assert_eq!(
        s.backup().as_deref(),
        Some("an older backup"),
        ".bak was touched"
    );
    assert!(s.leftovers().is_empty(), "{:?}", s.leftovers());
    assert_eq!(s.candidates_left(), 0);
}

/// The candidate is refused by SIZE before it is parsed, and a candidate that would only exceed
/// the cap once pretty-printed is refused too. Neither reaches the engine.
#[test]
fn an_oversized_candidate_is_refused_before_the_engine_sees_it() {
    let s = sandbox("cfg-toolarge", Some(FULL));
    let doc = s.read();
    let limit = MAX_CONFIG_BYTES as usize;
    let huge = format!("{{\"x\": \"{}\"}}", "a".repeat(limit));
    let err = s.save(&huge, &base_of(&doc)).expect_err("over the cap");
    assert_eq!(kind(&err), "tooLarge", "{err}");
    assert_eq!(err["limit"], MAX_CONFIG_BYTES);
    // Not JSON at all, but over the cap: the size answers first (no parse of a huge body).
    let err = s
        .save(&"{".repeat(limit + 1), &base_of(&doc))
        .expect_err("over the cap");
    assert_eq!(kind(&err), "tooLarge", "{err}");

    // Minified under the cap, pretty-printed over it.
    let mut v: Value = serde_json::from_str(FULL).unwrap();
    v["x-list"] = json!(vec![0; 400_000]);
    let minified = serde_json::to_string(&v).unwrap();
    assert!(minified.len() < limit, "{}", minified.len());
    assert!(canonical_json(&v).len() > limit);
    let err = s
        .save(&minified, &base_of(&doc))
        .expect_err("grows past the cap");
    assert_eq!(kind(&err), "tooLarge", "{err}");

    assert_eq!(
        s.validations(),
        0,
        "an oversized candidate reached the engine"
    );
    assert_eq!(s.on_disk(), FULL);
    assert!(s.backup().is_none());
}

/// Failure hygiene: stale staged files and stale candidates of THIS APP'S OWN naming are swept at
/// the start of a save; a live writer's files, look-alikes and anything else are left alone.
#[test]
fn a_save_sweeps_only_its_own_stale_temp_files() {
    let s = sandbox("cfg-sweep", Some(FULL));
    let dir = s.config.parent().unwrap().to_path_buf();
    let me = std::process::id();
    // A pid that was alive a moment ago and is not any more.
    let dead = {
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn true");
        let pid = child.id();
        child.wait().expect("reap true");
        pid
    };
    let prefix = staged_prefix("config.json");
    let stale = [
        format!("{prefix}{me}-900001"),
        format!("{prefix}{me}-900002.bak"),
        format!("{prefix}{dead}-1.prev"),
    ];
    // pid 1 is always alive; the look-alikes are not this app's pattern.
    let kept = [
        format!("{prefix}1-1"),
        format!("{prefix}notours"),
        format!("{prefix}{me}-3.tmp"),
        format!("{prefix}{me}"),
        "notes.txt".to_string(),
    ];
    for name in stale.iter().chain(&kept) {
        std::fs::write(dir.join(name), "x").unwrap();
    }
    // A symlink named like ours is not a file of ours; its target must survive too.
    let target = s.scratch.join("link-target.txt");
    std::fs::write(&target, "keep").unwrap();
    let link = format!("{prefix}{me}-900003");
    std::os::unix::fs::symlink(&target, dir.join(&link)).unwrap();

    std::fs::create_dir_all(&s.candidates).unwrap();
    let stale_candidate = format!("candidate-{me}-900004.json");
    let kept_candidates = ["candidate-1-1.json", "candidate-x.json", "readme.txt"];
    for name in std::iter::once(stale_candidate.as_str()).chain(kept_candidates) {
        std::fs::write(s.candidates.join(name), "x").unwrap();
    }

    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(6));
    let out = s.save(&candidate, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");

    let mut expected: Vec<String> = kept.iter().cloned().chain([link.clone()]).collect();
    expected.sort();
    assert_eq!(s.leftovers(), expected, "the sweep removed the wrong files");
    assert!(std::fs::symlink_metadata(dir.join(&link))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
    let mut left: Vec<String> = std::fs::read_dir(&s.candidates)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(
        left, kept_candidates,
        "the candidate sweep removed the wrong files"
    );
}

/// A config with a second hard link is refused like a symlink (deviation 43): the atomic rename
/// would detach the other name, which would keep the old bytes forever.
#[test]
fn a_hard_linked_config_is_refused_like_a_symlink() {
    let s = sandbox("cfg-hardlink", Some(FULL));
    let other = s.scratch.join("dotfiles-config.json");
    std::fs::hard_link(&s.config, &other).unwrap();
    let err = s.call("config_read", json!({})).expect_err("hard link");
    assert_eq!(kind(&err), "configUnreadable", "{err}");
    assert!(
        err["detail"].as_str().unwrap().contains("hard links"),
        "{err}"
    );
    let err = s
        .save(FULL, &digest(FULL.as_bytes()))
        .expect_err("hard link");
    assert_eq!(kind(&err), "configUnreadable", "{err}");
    let err = s
        .call("config_offer_notify_auto", json!({}))
        .expect_err("hard link");
    assert_eq!(kind(&err), "configUnreadable", "{err}");
    assert_eq!(s.validations(), 0);
    assert_eq!(s.on_disk(), FULL);
    use std::os::unix::fs::MetadataExt;
    assert_eq!(
        std::fs::metadata(&s.config).unwrap().nlink(),
        2,
        "the link was broken"
    );
    assert!(s.backup().is_none());
    // prove-it 3b: the same file with the second name gone is editable again.
    std::fs::remove_file(&other).unwrap();
    assert_eq!(s.read()["exists"], true);
}

/// M14: the candidate is owner-only in an owner-only directory while the engine reads it.
/// M4: `.bak` is never wider than the new file — and a config that is not an API config keeps its
/// mode on both.
#[test]
fn candidate_and_backup_modes() {
    let s = sandbox("cfg-modes", Some(FULL));
    std::fs::set_permissions(
        &s.config,
        std::os::unix::fs::PermissionsExt::from_mode(0o640),
    )
    .unwrap();
    let doc = s.read();
    let out = s
        .save(
            &edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(5)),
            &base_of(&doc),
        )
        .expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_eq!(
        s.validated_modes(),
        ["600 700"],
        "the candidate was not owner-only"
    );
    assert_eq!(mode_of(&s.config), 0o640, "a CLI config's mode changed");
    assert_eq!(mode_of(&bak_of(&s.config)), 0o640);

    // An API config on disk, switched to a CLI provider: the old key is in `.bak`, so both files
    // are owner-only afterwards.
    let a = sandbox("cfg-modes-api", Some(API));
    std::fs::set_permissions(
        &a.config,
        std::os::unix::fs::PermissionsExt::from_mode(0o644),
    )
    .unwrap();
    let doc = a.read();
    let to_cli = edit(&text_of(&doc), |v| {
        v["provider"] = json!({ "cli": "claude", "argv": ["-p"], "promptVia": "stdin" });
    });
    let out = a.save(&to_cli, &base_of(&doc)).expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert!(a.backup().unwrap().contains(SENTINEL_KEY));
    assert_eq!(
        mode_of(&bak_of(&a.config)),
        0o600,
        "the old key is world-readable in .bak"
    );
    assert_eq!(mode_of(&a.config), 0o600);
}

/// M17: two saves never validate at the same time — the Settings save and the Quit offer share
/// one lock. The fake records an overlap if a second validation starts while one is running.
///
/// ⚠ THE CONFIG HAS NO `notify`, so the offer really reaches `config validate`. Over FULL (a custom
/// command) the offer is refused BEFORE validating, and a missing lock could never show — the first
/// version of this test survived the lock-removal mutant for exactly that reason.
#[test]
fn concurrent_saves_validate_one_at_a_time() {
    let without_notify = edit(FULL, |v| {
        v.as_object_mut().unwrap().shift_remove("notify");
    });
    let s = sandbox("cfg-concurrent", Some(&without_notify));
    std::fs::write(s.record.join("slow-validate"), "").unwrap();
    let marker = s.record.join("validating");
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(4));
    let base = base_of(&doc);
    let w = &s.webview; // the App itself is not `Sync`; its webview is
    let save = |w: &WebviewWindow<MockRuntime>, text: &str, base: &str| {
        call(w, "config_save", json!({ "text": text, "base": base }))
    };
    let (saved, offered) = std::thread::scope(|scope| {
        let first = scope.spawn(|| save(w, &candidate, &base));
        let started = std::time::Instant::now();
        while !marker.exists() {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(20),
                "the first validation never started"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let second = scope.spawn(|| call(w, "config_offer_notify_auto", json!({})));
        (first.join().unwrap(), second.join().unwrap())
    });
    let overlap = std::fs::read_to_string(s.record.join("overlap.txt")).unwrap_or_default();
    assert_eq!(overlap, "", "two validations ran at once");
    assert_eq!(kind(&saved.expect("save")), "saved");
    // The offer waited for the save and then changed the SAVED file: both edits are on disk.
    assert_eq!(kind(&offered.expect("offer")), "saved");
    assert_eq!(s.validations(), 2);
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    assert_eq!(written["lookbackCapDays"], 4);
    assert_eq!(written["notify"], "auto");

    // prove-it 3b: the overlap detector fires when two validations DO overlap — a second app over
    // the same files has its own lock.
    let doc = s.read();
    let (app2, w2) = app_over(
        EngineClient::with_program(s.scratch.join("engine.sh")),
        &s.candidates,
    );
    let a = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(3));
    let b = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(2));
    let base = base_of(&doc);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| save(w, &a, &base));
        let started = std::time::Instant::now();
        while !marker.exists() {
            assert!(started.elapsed() < std::time::Duration::from_secs(20));
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let second = scope.spawn(|| save(&w2, &b, &base));
        let _ = (first.join().unwrap(), second.join().unwrap());
    });
    drop(app2);
    let overlap = std::fs::read_to_string(s.record.join("overlap.txt")).unwrap_or_default();
    assert_eq!(overlap, "overlap\n", "the detector cannot see an overlap");
}

/// An exit-0 reply that is not JSON is described in words, not as a Rust `Option`.
#[test]
fn an_unreadable_validate_reply_is_described_in_words() {
    let s = sandbox("cfg-garbage", Some(FULL));
    let doc = s.read();
    let candidate = edit(&text_of(&doc), |v| v["x-test"] = json!("__garbage__"));
    let err = s.save(&candidate, &base_of(&doc)).expect_err("garbage");
    assert_eq!(kind(&err), "engine", "{err}");
    let detail = err["detail"].as_str().unwrap();
    assert_eq!(
        detail,
        "`config validate` finished but did not print the JSON answer this app expects and wrote \
         nothing to stderr"
    );
    assert!(!detail.contains("Some("), "{detail}");
    assert_eq!(s.on_disk(), FULL);
    assert_eq!(s.candidates_left(), 0);
}

/* ── numbers ──────────────────────────────────────────────────────────────────────────────────── */

/// `float_roundtrip`: hard-to-parse numbers survive an untouched raw save as a no-op, and the
/// numbers a save DOES rewrite are exactly the ones deviation 48 lists.
#[test]
fn numbers_round_trip_and_the_rewrites_are_the_documented_ones() {
    let on_disk = "{\n  \"lookbackCapDays\": 7,\n  \"x-big\": 123456789012345678901234,\n  \"x-tiny\": 2.2250738585072011e-308,\n  \"x-hard\": 9007199254740993.0,\n  \"x-float\": 0.1\n}";
    let s = sandbox("cfg-numbers", Some(on_disk));
    let doc = s.read();
    let shown = text_of(&doc);
    let out = s.save(&shown, &base_of(&doc)).expect("save");
    assert_eq!(
        kind(&out),
        "unchanged",
        "an untouched raw save wrote: {shown}"
    );
    // …and the text the webview got, re-parsed, is the same value set (the read is stable).
    let again: Value = serde_json::from_str(&shown).unwrap();
    assert_eq!(canonical_json(&again), shown);
    assert_eq!(s.on_disk(), on_disk);
    assert_eq!(s.validations(), 0);

    // What a WRITING save does to numbers, pinned (docs/gui-seam.md §10g, deviation 48).
    let rewritten: Value = serde_json::from_str(
        r#"{"a": 1.0, "b": 1e3, "c": -0, "d": -0.0, "e": 123456789012345678901234, "f": 18446744073709551615, "g": -9223372036854775808, "h": 1.5e300, "i": 5e-324}"#,
    )
    .unwrap();
    let text: String = canonical_json(&rewritten).split_whitespace().collect();
    assert_eq!(
        text,
        r#"{"a":1.0,"b":1000.0,"c":-0.0,"d":-0.0,"e":1.2345678901234569e+23,"f":18446744073709551615,"g":-9223372036854775808,"h":1.5e+300,"i":5e-324}"#
    );
}

/// E9b: the transcripts guard compares VALUES — the form's JavaScript round trip writes `50.0` as
/// `50`, which is not a change — but exactly: a different number is still refused.
#[test]
fn the_transcripts_guard_compares_numbers_by_value_exactly() {
    let with = |n: &str| {
        FULL.replace(
            "\"root\": \"~/.claude/projects\"",
            &format!("\"root\": \"~/.claude/projects\",\n    \"x-limit\": {n}"),
        )
    };
    let on_disk = with("50.0");
    assert_ne!(on_disk, FULL, "the fixture edit did not apply");
    let s = sandbox("cfg-tnum", Some(&on_disk));
    let doc = s.read();
    let js = with("50").replace("\"lookbackCapDays\": 7", "\"lookbackCapDays\": 6");
    let out = s.save(&js, &base_of(&doc)).expect("50 is 50.0");
    assert_eq!(kind(&out), "saved", "{out}");

    let doc = s.read();
    let err = s
        .save(&with("51"), &base_of(&doc))
        .expect_err("51 is not 50");
    assert_eq!(kind(&err), "transcriptsChanged", "{err}");

    let v = |t: &str| serde_json::from_str::<Value>(t).unwrap();
    assert!(json_eq(
        &v("[50, 5e1, {\"a\": 1, \"b\": 2}]"),
        &v("[50.0, 50, {\"b\": 2.0, \"a\": 1}]")
    ));
    assert!(json_eq(&v("0"), &v("-0.0")));
    assert!(!json_eq(&v("9007199254740993"), &v("9007199254740992.0")));
    assert!(!json_eq(
        &v("18446744073709551615"),
        &v("18446744073709551616.0")
    ));
    assert!(!json_eq(&v("[1, 2]"), &v("[2, 1]")));
    assert!(!json_eq(&v("{\"a\": 1}"), &v("{\"a\": 1, \"b\": null}")));
    assert!(!json_eq(&v("\"50\""), &v("50")));
    // Review round 2: past the 64-bit range serde_json reads a DOUBLE, so two integers that round
    // to the same double are equal here — as they are to JavaScript (the documented property).
    assert!(json_eq(
        &v("123456789012345678901234"),
        &v("123456789012345678901235")
    ));
    assert!(!json_eq(
        &v("123456789012345678901234"),
        &v("123456789012345698901234")
    ));
}

/// Review round 2 (V2): `1e400` is well-formed JSON the engine's `JSON.parse` reads as Infinity;
/// the refusal says "number out of range", not "not JSON".
#[test]
fn a_number_beyond_f64_is_refused_as_out_of_range() {
    let s = sandbox("cfg-range", Some(FULL));
    let doc = s.read();
    for n in ["1e400", "-1e400"] {
        let candidate = FULL.replace(
            "\"lookbackCapDays\": 7",
            &format!("\"lookbackCapDays\": {n}"),
        );
        let err = s.save(&candidate, &base_of(&doc)).expect_err(n);
        assert_eq!(kind(&err), "notJson", "{err}");
        let detail = err["detail"].as_str().unwrap();
        assert!(
            detail.starts_with("number out of range at line"),
            "{detail}"
        );
        assert!(detail.contains("the JSON is well-formed"), "{detail}");
    }
    let err = s.save("{ nope", &base_of(&doc)).expect_err("syntax");
    assert!(
        !err["detail"].as_str().unwrap().contains("well-formed"),
        "a syntax error was called well-formed: {err}"
    );
    assert_eq!(s.on_disk(), FULL);
    assert_eq!(s.validations(), 0);

    // The same words for a file on disk.
    let s = sandbox("cfg-range2", Some("{\n  \"x\": 1e400\n}"));
    let doc = s.read();
    let shown = doc["parseError"].as_str().expect("a parse error");
    assert!(shown.starts_with("number out of range"), "{shown}");
    assert!(shown.contains("the JSON is well-formed"), "{shown}");
    let err = s.save(FULL, &base_of(&doc)).expect_err("on disk");
    assert_eq!(kind(&err), "onDiskNotJson", "{err}");
    assert!(
        err["detail"].as_str().unwrap().contains("well-formed"),
        "{err}"
    );
}

/* ── the Quit dialog's offer ──────────────────────────────────────────────────────────────────── */

#[test]
fn the_quit_offer_writes_exactly_notify_auto_and_nothing_else() {
    // Absent: appended at the end, everything else byte-identical.
    let without: String = {
        let mut v: Value = serde_json::from_str(FULL).unwrap();
        v.as_object_mut().unwrap().shift_remove("notify");
        canonical_json(&v)
    };
    let s = sandbox("cfg-of-absent", Some(&without));
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("offer");
    assert_eq!(kind(&out), "saved", "{out}");
    let expected = {
        let mut v: Value = serde_json::from_str(&without).unwrap();
        v.as_object_mut()
            .unwrap()
            .insert("notify".into(), json!("auto"));
        canonical_json(&v)
    };
    assert_eq!(s.on_disk(), expected);
    let written: Value = serde_json::from_str(&s.on_disk()).unwrap();
    let before: Value = serde_json::from_str(&without).unwrap();
    let mut rest = written.clone();
    rest.as_object_mut().unwrap().shift_remove("notify");
    assert_eq!(rest, before, "the offer changed something besides notify");
    assert_eq!(s.backup().as_deref(), Some(without.as_str()));
    assert_eq!(s.validations(), 1);

    // "off" in the middle of the file: changed in place, position kept; the stored key survives.
    let s = sandbox("cfg-offer-off", Some(API));
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("offer");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_eq!(
        s.on_disk(),
        API.replace("\"notify\": \"off\"", "\"notify\": \"auto\"")
    );
    assert!(s.on_disk().contains(SENTINEL_KEY));

    // Already "auto": nothing to do, nothing written, nothing validated.
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("offer");
    assert_eq!(kind(&out), "unchanged", "{out}");
    assert_eq!(s.validations(), 1);

    // A custom command: refused rather than silently replaced.
    let s = sandbox("cfg-of-command", Some(FULL));
    let err = s
        .call("config_offer_notify_auto", json!({}))
        .expect_err("custom command");
    assert_eq!(kind(&err), "unsupported", "{err}");
    assert_eq!(s.on_disk(), FULL);

    // Review round 1: everything the ENGINE treats as off (`resolveNotify`) — null, an unknown
    // string, a command-less or empty or non-string command, an array — is replaced by "auto".
    for (what, value) in [
        ("null", json!(null)),
        ("an unknown string", json!("loud")),
        ("an empty command", json!({ "command": [] })),
        ("a non-string command", json!({ "command": [1, 2] })),
        ("an object without a command", json!({ "cmd": ["x"] })),
        ("an array", json!(["osascript"])),
    ] {
        assert!(!is_custom_notify(&value), "{what}");
        let text = edit(&without, |v| v["notify"] = value.clone());
        let s = sandbox("cfg-offer-bad", Some(&text));
        let out = s
            .call("config_offer_notify_auto", json!({}))
            .unwrap_or_else(|e| panic!("{what}: {e}"));
        assert_eq!(kind(&out), "saved", "{what}: {out}");
        assert_eq!(
            s.on_disk(),
            edit(&text, |v| v["notify"] = json!("auto")),
            "{what}"
        );
    }
    assert!(is_custom_notify(&json!({ "command": ["/bin/echo"] })));

    // A file indented another way comes back in the save format (§10e) — the offer is a save.
    let four = serde_json::to_string_pretty(&serde_json::from_str::<Value>(&without).unwrap())
        .unwrap()
        .replace("\n  ", "\n    ");
    assert_ne!(four, without);
    let s = sandbox("cfg-of-indent", Some(&four));
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("offer");
    assert_eq!(kind(&out), "saved", "{out}");
    assert_eq!(
        s.on_disk(),
        expected,
        "the offer did not write the canonical format"
    );

    // An invalid config: the engine's verdict, nothing written.
    let invalid = edit(&without, |v| v["x-test"] = json!("__invalid__"));
    let s = sandbox("cfg-of-invalid", Some(&invalid));
    let out = s
        .call("config_offer_notify_auto", json!({}))
        .expect("offer answers");
    assert_eq!(kind(&out), "invalid", "{out}");
    assert_eq!(s.on_disk(), invalid);
}

/* ── the real engine, sandboxed ───────────────────────────────────────────────────────────────── */

/// The same pipeline against the bundled sidecar: its own `status --json` names the path (asserted
/// to be inside the sandbox BEFORE anything is saved) and its own validator decides.
#[test]
fn the_real_engine_validates_and_the_save_lands_in_the_sandbox() {
    let scratch = ScratchDir::new("cfg-real");
    let home = scratch.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let mut client = EngineClient::with_program(
        daily_briefing_gui_lib::engine::bundled_sidecar_path().expect("the bundled sidecar"),
    )
    .with_env("HOME", home.as_os_str());
    for (key, value) in sandbox_env(&scratch.path) {
        client = client.with_env(key, value);
    }
    let candidates = scratch.join("candidates");
    let (_app, w) = app_over(client, &candidates);

    let doc = call(&w, "config_read", json!({})).expect("config_read");
    let config = PathBuf::from(doc["path"].as_str().expect("a path"));
    assert!(
        config.starts_with(&scratch.path),
        "the real engine reported a config OUTSIDE the sandbox ({}); refusing to go on",
        config.display()
    );
    assert_eq!(doc["exists"], false);

    let initial = canonical_json(&json!({
        "discoverRoots": [home],
        "provider": { "cli": "claude", "argv": ["-p"], "promptVia": "stdin" },
        "lookbackCapDays": 7,
    }));
    std::fs::create_dir_all(config.parent().expect("a parent")).unwrap();
    std::fs::write(&config, &initial).unwrap();
    let doc = call(&w, "config_read", json!({})).expect("config_read");
    assert_eq!(text_of(&doc), initial);

    // The engine's own error: a string where a number belongs.
    let bad = edit(&initial, |v| v["lookbackCapDays"] = json!("4"));
    let out = call(
        &w,
        "config_save",
        json!({ "text": bad, "base": base_of(&doc) }),
    )
    .expect("save");
    assert_eq!(kind(&out), "invalid", "{out}");
    assert!(
        out["errors"][0]["message"]
            .as_str()
            .unwrap()
            .contains("lookbackCapDays"),
        "{out}"
    );
    assert_eq!(std::fs::read_to_string(&config).unwrap(), initial);

    // The engine's own warning: a bad floor degrades, it does not block.
    let warned = edit(&initial, |v| v["morningTime"] = json!("25:99"));
    let out = call(
        &w,
        "config_save",
        json!({ "text": warned, "base": base_of(&doc) }),
    )
    .expect("save");
    assert_eq!(kind(&out), "saved", "{out}");
    assert!(
        out["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["field"] == "morningTime"),
        "{out}"
    );
    assert_eq!(std::fs::read_to_string(&config).unwrap(), warned);
    assert_eq!(std::fs::read_to_string(bak_of(&config)).unwrap(), initial);
    assert_eq!(std::fs::read_dir(&candidates).unwrap().count(), 0);

    // And the offer, through the real validator.
    let out = call(&w, "config_offer_notify_auto", json!({})).expect("offer");
    assert_eq!(kind(&out), "saved", "{out}");
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    assert_eq!(written["notify"], "auto");
}

/* ── B8 (T16): the FIRST-config path — `config_create` ────────────────────────────────────────── */

/// The wizard's CLI-path template, roughly what `lib/wizard.ts`'s `buildConfig` emits.
fn create_candidate() -> String {
    json!({
        "discoverRoots": ["~"],
        "provider": {
            "cli": "claude", "argv": ["-p"], "promptVia": "stdin",
            "harden": true, "credential": "subscription"
        },
        "morningTime": "07:20",
        "networkProbeHosts": [
            { "host": "1.1.1.1", "port": 443 },
            { "host": "8.8.8.8", "port": 443 }
        ],
        "tokenBudget": { "maxChars": 200000 },
        "lookbackCapDays": 4
    })
    .to_string()
}

impl Sandbox {
    fn create(&self, text: &str) -> Result<Value, Value> {
        self.call("config_create", json!({ "text": text }))
    }
}

#[test]
fn config_create_validates_first_and_writes_the_canonical_form() {
    let s = sandbox("create-first", None);
    assert!(!s.config.exists(), "the sandbox starts with no config");

    let out = s.create(&create_candidate()).expect("create");
    assert_eq!(kind(&out), "created", "{out}");
    assert_eq!(
        out["path"].as_str().unwrap(),
        s.config.display().to_string()
    );

    // On disk: the canonical serialisation of the candidate, validated by the engine FIRST.
    let expected = canonical_json(&serde_json::from_str::<Value>(&create_candidate()).unwrap());
    assert_eq!(s.on_disk(), expected);
    assert_eq!(s.validations(), 1, "the engine validated exactly once");
    assert_eq!(
        s.validated(0),
        expected,
        "what was validated is what was written"
    );
    // A CLI-path config is world-readable like `initConfig`'s own template; no `.bak` exists
    // (there was no previous file), and nothing was left behind.
    assert_eq!(mode_of(&s.config) & 0o777, 0o644);
    assert!(s.backup().is_none());
    assert!(
        s.leftovers().is_empty(),
        "no temp files remain beside it: {:?}",
        s.leftovers()
    );
    assert_eq!(s.candidates_left(), 0);
}

#[test]
fn config_create_never_replaces_what_already_holds_the_name() {
    // A config that exists before the wizard saves: refused before validation, byte-untouched.
    let s = sandbox("create-exists", Some(FULL));
    let err = s.create(&create_candidate()).expect_err("a config exists");
    assert_eq!(kind(&err), "alreadyExists", "{err}");
    assert_eq!(s.on_disk(), FULL);
    assert_eq!(
        s.validations(),
        0,
        "nothing was validated for a refused create"
    );

    // A dotfiles SYMLINK at the name counts as existing too — never written through.
    #[cfg(unix)]
    {
        let s = sandbox("create-symlink", None);
        let target = s.scratch.join("real-config.json");
        std::fs::write(&target, "{}").unwrap();
        std::os::unix::fs::symlink(&target, &s.config).unwrap();
        let err = s
            .create(&create_candidate())
            .expect_err("a symlink holds the name");
        assert_eq!(kind(&err), "alreadyExists", "{err}");
        assert!(
            std::fs::symlink_metadata(&s.config)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the symlink is still a symlink"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
    }
}

/// The race the exclusive create exists for: a config APPEARS while the engine is validating the
/// candidate (a terminal `daily-briefing init`, say). The link lands on an existing name, the
/// answer is `alreadyExists`, and the racing config's bytes are exactly what stays on disk.
#[test]
fn a_config_that_appears_during_validation_is_never_clobbered() {
    let s = sandbox("create-race", None);
    let racing = r#"{"racing":"init wrote me"}"#;
    std::fs::write(s.record.join("rewrite-with.json"), racing).unwrap();
    // The fake's `__rewrite__` hook copies `rewrite-with.json` over the config DURING validate.
    let candidate = json!({ "$comment": "__rewrite__" }).to_string();
    let err = s
        .create(&candidate)
        .expect_err("the name appeared during validation");
    assert_eq!(kind(&err), "alreadyExists", "{err}");
    assert_eq!(
        s.on_disk(),
        racing,
        "the racing config's bytes are untouched"
    );
    assert!(
        s.leftovers().is_empty(),
        "nothing staged remains: {:?}",
        s.leftovers()
    );
}

/// Round 1 (F3): the literal-key refusal is a recursive, case-insensitive scan for a key NAMED
/// `apiKey` — not one exact pointer. The three MEASURED bypasses of the old check are refused,
/// the reference spellings stay legal, and the engine's validator (which admits all three) is
/// not relied on as a second line of defence.
#[test]
fn config_create_refuses_a_literal_key_at_any_spelling_or_position() {
    let s = sandbox("create-keyscan", None);
    for candidate in [
        // lowercase, at the canonical position — used to be CREATED at 0600
        json!({ "provider": { "api": {
            "kind": "anthropic", "model": "m", "apikey": "sk-test-obvious-placeholder"
        } } }),
        // top level — used to be CREATED at 0644, world-readable
        json!({ "apiKey": "sk-test-obvious-placeholder" }),
        // inside an array of account objects — used to be CREATED at 0644
        json!({ "provider": { "accounts": [
            { "name": "a", "apiKey": "sk-test-obvious-placeholder" }
        ] } }),
        // P3-M2-T2: a `fallbacks` entry's block, at the engine's spelling and at another case
        json!({ "provider": { "cli": "claude" }, "fallbacks": [{ "label": "b", "api": {
            "kind": "anthropic", "model": "m", "apiKey": "sk-test-obvious-placeholder"
        } }] }),
        json!({ "provider": { "cli": "claude" }, "fallbacks": [{ "label": "b", "api": {
            "kind": "anthropic", "model": "m", "APIKEY": "sk-test-obvious-placeholder"
        } }] }),
    ] {
        let err = s
            .create(&candidate.to_string())
            .expect_err("a literal key at any spelling");
        assert_eq!(kind(&err), "apiKeyChanged", "{candidate}");
    }
    assert!(!s.config.exists(), "nothing was written");
    assert_eq!(s.validations(), 0, "nothing reached the engine");

    // The references are not key VALUES and stay legal — `apiKeyFile` / `apiKeyCommand`.
    let ok = s
        .create(
            &json!({ "provider": { "api": {
                "kind": "anthropic", "model": "m",
                "apiKeyFile": "~/.config/daily-briefing/key",
                "apiKeyCommand": ["security", "find-generic-password", "-w"]
            } } })
            .to_string(),
        )
        .expect("references are legal");
    assert_eq!(kind(&ok), "created", "{ok}");
}

/// Round 1 (F5c / M-L2-7): `config_create` refuses by SIZE before it parses, exactly as the save
/// does — `"{".repeat(limit+1)` is not JSON, so `tooLarge` (never `notJson`) proves the cap
/// answered first, and the engine saw nothing.
#[test]
fn an_oversized_create_is_refused_before_parse_and_the_engine() {
    let s = sandbox("create-cap", None);
    let limit = MAX_CONFIG_BYTES as usize;
    let err = s.create(&"{".repeat(limit + 1)).expect_err("over the cap");
    assert_eq!(kind(&err), "tooLarge", "{err}");
    assert_eq!(err["limit"], MAX_CONFIG_BYTES);
    assert_eq!(
        s.validations(),
        0,
        "an oversized candidate reached the engine"
    );
    assert!(!s.config.exists(), "nothing was written");
}

#[test]
fn config_create_refuses_a_literal_key_and_a_transcripts_block_before_any_spawn() {
    let s = sandbox("create-guards", None);
    let keyed = json!({ "provider": { "api": {
        "kind": "anthropic", "model": "m", "apiKey": "sk-test-obvious-placeholder"
    } } })
    .to_string();
    let err = s.create(&keyed).expect_err("a literal key");
    assert_eq!(kind(&err), "apiKeyChanged", "{err}");

    let transcripts = json!({ "transcripts": { "enabled": true } }).to_string();
    let err = s.create(&transcripts).expect_err("a transcripts block");
    assert_eq!(kind(&err), "transcriptsChanged", "{err}");
    // Even `enabled: false` is refused — the only unchanged value on a create is absence.
    let transcripts_off = json!({ "transcripts": { "enabled": false } }).to_string();
    let err = s
        .create(&transcripts_off)
        .expect_err("any transcripts block");
    assert_eq!(kind(&err), "transcriptsChanged", "{err}");

    assert!(!s.config.exists(), "nothing was written");
    assert_eq!(s.validations(), 0, "nothing reached the engine");
}

#[test]
fn an_invalid_create_writes_nothing() {
    let s = sandbox("create-invalid", None);
    let candidate = json!({ "$comment": "__invalid__" }).to_string();
    let out = s.create(&candidate).expect("the command answers");
    assert_eq!(kind(&out), "invalid", "{out}");
    assert!(
        out["errors"].as_array().is_some_and(|e| !e.is_empty()),
        "the engine's errors are returned verbatim: {out}"
    );
    assert!(!s.config.exists(), "an invalid candidate is never written");
    assert_eq!(s.candidates_left(), 0);
}

#[test]
fn an_api_create_is_owner_only_like_init_config() {
    let s = sandbox("create-api-mode", None);
    let candidate = json!({ "provider": { "api": {
        "kind": "anthropic", "model": "claude-sonnet-5",
        "apiKeyFile": "~/.config/daily-briefing/anthropic-key"
    } } })
    .to_string();
    let out = s.create(&candidate).expect("create");
    assert_eq!(kind(&out), "created", "{out}");
    assert_eq!(
        mode_of(&s.config) & 0o777,
        0o600,
        "an api config is tightened to owner-only, as initConfig does"
    );
}

/// P3-M2-T2: an `api` block only in `fallbacks` makes a created file owner-only too, as one in item 1
/// does — the same predicate the save path uses.
#[test]
fn a_create_with_an_api_block_only_in_fallbacks_is_owner_only() {
    let s = sandbox("create-fb-mode", None);
    let candidate = edit(&create_candidate(), |v| {
        v["fallbacks"] = json!([{ "label": "backup", "api": {
            "kind": "anthropic", "model": "m", "apiKeyEnv": "BACKUP_KEY"
        } }]);
    });
    let out = s.create(&candidate).expect("create");
    assert_eq!(kind(&out), "created", "{out}");
    assert_eq!(
        mode_of(&s.config),
        0o600,
        "an api fallback's config is world-readable"
    );
    // And with no api block anywhere, a create keeps 0644, as `initConfig` does.
    let s = sandbox("create-cli-mode", None);
    let out = s.create(&create_candidate()).expect("create");
    assert_eq!(kind(&out), "created", "{out}");
    assert_eq!(mode_of(&s.config), 0o644);
}

/// The link-less fallback (FAT32 and friends): still EXCLUSIVE, and the parent directory is
/// created — a first run has no `~/.config/daily-briefing/` yet.
#[test]
fn create_without_hard_links_is_still_exclusive_and_makes_the_directory() {
    use daily_briefing_gui_lib::config_save::create_config_file_with_link;
    let dir = std::env::temp_dir().join(format!("dba-b8-create-nolink-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let path = dir.join("deep").join("config.json");
    let no_links = |_: &std::path::Path, _: &std::path::Path| {
        Err::<(), std::io::Error>(std::io::Error::from(std::io::ErrorKind::Unsupported))
    };
    create_config_file_with_link(&path, b"{\n}", 0o644, no_links).expect("the fallback creates");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\n}");
    let err = create_config_file_with_link(&path, b"{}", 0o644, no_links)
        .expect_err("the second create is refused");
    assert!(
        matches!(err, SaveError::AlreadyExists { .. }),
        "exclusive without links too: {err:?}"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\n}", "untouched");
    std::fs::remove_dir_all(&dir).ok();
}

/// The LAST window: a config that appears between `create_config_file`'s own existence check and
/// the `link(2)` itself. The injected link seam plants the file and answers `EEXIST`, exactly as
/// the kernel would — the refusal must be `alreadyExists` and the raced bytes must survive.
#[test]
fn a_config_that_appears_at_the_link_itself_is_never_clobbered() {
    use daily_briefing_gui_lib::config_save::create_config_file_with_link;
    let dir = std::env::temp_dir().join(format!("dba-b8-create-race-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("config.json");
    let racing = |_: &Path, to: &Path| {
        std::fs::write(to, "raced bytes").unwrap();
        Err::<(), std::io::Error>(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
    };
    let err = create_config_file_with_link(&path, b"{}", 0o644, racing)
        .expect_err("the race is a refusal");
    assert!(
        matches!(err, SaveError::AlreadyExists { .. }),
        "not a clobber and not an io error: {err:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "raced bytes",
        "the racing config's bytes are untouched"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/* ── final harden r2: a calendar link address is refused before any candidate file exists ─────── */

/// The calendar blocks that hold a link address — every one refused before anything is staged, by
/// the save, the create and (P3-M1-T2) the candidate check alike. `SENTINEL` marks the secret.
fn calendar_secret_blocks() -> Vec<Value> {
    const URL: &str = "https://calendar.example.invalid/ical/me%40example.com/private-SENTINEL-c4l-0000/basic.ics";
    vec![
        json!({ "enabled": true, "links": [{ "id": "work", "url": URL }] }),
        json!({ "enabled": true, "links": [{ "id": "work", "urlCommand": ["echo", URL] }] }),
        json!({ "enabled": true, "macos": { "deep": [{ "URL": "x" }] } }),
        json!({ "links": [{ "id": "w", "urlCommand": ["printf", "%s", "webcal:\\/\\/h.example\\/x"] }] }),
        // Final harden r3: an address in a link's name, owner or confirmedOwner, or in `emails`, in any
        // spelling (backslash forms included) — refused BEFORE staging too, not by the engine after.
        json!({ "links": [{ "id": "w", "name": URL }] }),
        json!({ "links": [{ "id": "w", "owner": "https:\\\\calendar.example.invalid\\private-SENTINEL-c4l-0000" }] }),
        json!({ "links": [{ "id": "w", "confirmedOwner": URL }] }),
        json!({ "emails": ["me@example.com", URL] }),
        json!({ "links": [{ "id": "w", "urlCommand": ["echo", "https:\\\\calendar.example.invalid\\private-SENTINEL-c4l-0000"] }] }),
    ]
}

/// The generic save AND the first-config create used to stage `config-candidates/*.json` and let
/// the engine refuse a calendar `url` (or a URL-shaped `urlCommand` argument) — so the secret was
/// on disk, in the candidate, before the refusal. Now both answer the engine's own error text
/// before anything is staged: no validation, no candidate directory, nothing written.
#[test]
fn a_calendar_link_address_is_refused_before_any_candidate_is_staged() {
    use daily_briefing_gui_lib::config_save::CALENDAR_SECRET_ERROR;
    let blocks = calendar_secret_blocks();
    let s = sandbox("cfg-cal-url", Some(FULL));
    let doc = s.read();
    for block in &blocks {
        let candidate = edit(&text_of(&doc), |v| v["calendar"] = block.clone());
        let out = s
            .save(&candidate, &base_of(&doc))
            .expect("the save answers");
        assert_eq!(kind(&out), "invalid", "{block}");
        assert_eq!(
            out["errors"],
            json!([{ "field": "calendar", "message": CALENDAR_SECRET_ERROR }])
        );
        assert!(
            !out.to_string().contains("SENTINEL"),
            "the answer echoed the address"
        );
        assert_eq!(s.on_disk(), FULL, "written");
    }
    assert_eq!(
        s.validations(),
        0,
        "a candidate holding a link address reached the engine"
    );
    assert!(!s.candidates.exists(), "a candidate file was staged");

    let c = sandbox("cfg-cal-create", None);
    for block in &blocks {
        let mut candidate: Value = serde_json::from_str(&create_candidate()).expect("JSON");
        candidate["calendar"] = block.clone();
        let out = c
            .create(&candidate.to_string())
            .expect("the create answers");
        assert_eq!(kind(&out), "invalid", "{block}");
        assert_eq!(out["errors"][0]["message"], CALENDAR_SECRET_ERROR);
    }
    assert_eq!(
        c.validations(),
        0,
        "a create holding a link address reached the engine"
    );
    assert!(!c.candidates.exists(), "a candidate file was staged");
    assert!(!c.config.exists(), "nothing was written");

    // A 1Password reference is a pointer, not the address: it still goes to the engine.
    let candidate = edit(
        &text_of(&doc),
        |v| {
            v["calendar"] =
                json!({ "links": [{ "id": "w", "urlCommand": ["op", "read", "op://v/cal/url"] }] })
        },
    );
    s.save(&candidate, &base_of(&doc))
        .expect("the save answers");
    assert_eq!(
        s.validations(),
        1,
        "an op:// reference must reach the engine's validation"
    );
    // Final harden r3: nor is a password-store entry that merely ends in `.ics`. (Re-read: the op://
    // save above may have written, and a stale base is a conflict.)
    let doc = s.read();
    let candidate = edit(
        &text_of(&doc),
        |v| v["calendar"] = json!({ "links": [{ "id": "w", "urlCommand": ["pass", "show", "calendar/work.ics"] }] }),
    );
    s.save(&candidate, &base_of(&doc))
        .expect("the save answers");
    assert_eq!(
        s.validations(),
        2,
        "a pass entry naming an .ics file must reach the engine's validation"
    );
}

/* ── P3-M1-T2: candidate staging for Test and validate (`provider_candidate_check`) ──────────────── */

/// The check path's fake engine: `config validate` and `provider test` over the staged candidate,
/// everything else (`status --json`, and the validate's verdict itself) by [`files_sidecar`].
///
/// - Each staged path is classified by its NAME — `provider-check-…` (the check) or `candidate-…`
///   (the save) — so a test can HOLD one kind of call while the other runs: with
///   `<record>/hold-<kind>-<config|provider>` present, the fake writes the path it was handed to
///   `held-<kind>-<op>` and waits (≤ 20 s) for `release-<kind>-<op>`, then appends `present` or
///   `gone` to `survived-<kind>-<op>.txt` — whether the staged file it was handed still existed when
///   its turn came, which is the "never delete each other's candidate" question.
/// - `provider test` records its argv (`test-argv-<n>.txt`), a copy of the candidate
///   (`tested-<n>.json`) and `<file mode> <dir mode>` (`tested-modes.txt`), then answers by marker:
///   `__test_refused__` a `config` refusal (exit 2, a JSON line), `__test_garbage__` exit 0 with
///   no JSON, `__test_crash__` exit 1 with only stderr, `__test_hang__` never answers; otherwise a pass.
fn check_sidecar(scratch: &ScratchDir, state: &Path, config: &Path, record: &Path) -> PathBuf {
    let files = files_sidecar(&scratch.path, "engine-files.sh", state, config, record);
    let files = files.display();
    let rec = record.display();
    let body = format!(
        r#"case "$1:$2" in
  config:validate) f="$5" ;;
  provider:test) f="$4" ;;
  *) exec "{files}" "$@" ;;
esac
case "$(basename "$f")" in
  provider-check-*) p=provider-check ;;
  candidate-*) p=candidate ;;
  *) p=other ;;
esac
op="$1"
if [ -e "{rec}/hold-$p-$op" ]; then
  printf '%s\n' "$f" > "{rec}/held-$p-$op.tmp" && mv "{rec}/held-$p-$op.tmp" "{rec}/held-$p-$op"
  i=0
  while [ ! -e "{rec}/release-$p-$op" ] && [ "$i" -lt 2000 ]; do sleep 0.01; i=$((i+1)); done
  if [ -e "$f" ]; then printf 'present\n'; else printf 'gone\n'; fi >> "{rec}/survived-$p-$op.txt"
fi
if [ "$op" = config ]; then exec "{files}" "$@"; fi
n="$(ls "{rec}" | grep -c '^tested-[0-9]')"
printf '%s\n' "$@" > "{rec}/test-argv-$n.txt"
cp "$f" "{rec}/tested-$n.json"
d="$(dirname "$f")"
fm="$(stat -c %a "$f" 2>/dev/null)" || fm="$(stat -f %Lp "$f")"
dm="$(stat -c %a "$d" 2>/dev/null)" || dm="$(stat -f %Lp "$d")"
printf '%s %s\n' "$fm" "$dm" >> "{rec}/tested-modes.txt"
if grep -q '__test_refused__' "$f"; then
  printf '%s' '{{"schemaVersion":1,"ok":false,"code":"config","error":"test: the candidate is not valid"}}'
  exit 2
elif grep -q '__test_garbage__' "$f"; then
  printf '%s' 'this is not JSON'
elif grep -q '__test_crash__' "$f"; then
  printf 'boom\n' >&2
  exit 1
elif grep -q '__test_hang__' "$f"; then
  sleep 30
else
  printf '%s' '{{"schemaVersion":1,"ok":true,"passed":true,"at":"2026-10-18T00:00:00.000Z","recorded":true}}'
fi
exit 0"#
    );
    common::fake_sidecar(&scratch.path, "engine.sh", &body)
}

/// A [`sandbox`] over [`check_sidecar`]; `cap` bounds every bounded operation (the Test's timeout).
fn check_box(tag: &str, initial: Option<&str>, cap: Option<std::time::Duration>) -> Sandbox {
    check_box_with(tag, initial, cap, false)
}

/// [`check_box`], with the settings-removed latch already set when `latched`.
fn check_box_with(
    tag: &str,
    initial: Option<&str>,
    cap: Option<std::time::Duration>,
    latched: bool,
) -> Sandbox {
    let scratch = ScratchDir::new(tag);
    let state = scratch.join("state");
    let xdg = scratch.join("xdg").join("daily-briefing");
    let record = scratch.join("record");
    for d in [&state, &xdg, &record] {
        std::fs::create_dir_all(d).expect("sandbox dir");
    }
    let config = xdg.join("config.json");
    if let Some(text) = initial {
        std::fs::write(&config, text).expect("initial config");
    }
    let candidates = scratch.join("app-data").join("config-candidates");
    let program = check_sidecar(&scratch, &state, &config, &record);
    let client = EngineClient::with_program(program);
    let client = match cap {
        Some(cap) => client.with_timeout_cap(cap),
        None => client,
    };
    let saver = ConfigSaver::with_candidate_dir(&candidates);
    let saver = if latched {
        saver.with_settings_removed()
    } else {
        saver
    };
    let (app, webview) = app_with(client, saver);
    Sandbox {
        config,
        candidates,
        record,
        app,
        webview,
        scratch,
    }
}

/// `{ test: { index, testTimeoutMs } }`, the Test mode's wire shape.
fn test_mode(index: u64, test_timeout_ms: u64) -> Value {
    json!({ "test": { "index": index, "testTimeoutMs": test_timeout_ms } })
}

/// The in-flight guard is process-global and `cargo test` runs this binary's tests on parallel
/// threads: every test that runs a Test (MUTATING) takes this turn first (`common::serialise`).
fn mutating_turn() -> common::Serial {
    tauri::async_runtime::block_on(common::serialise())
}

impl Sandbox {
    fn check(&self, text: &str, mode: Value) -> Result<Value, Value> {
        check_on(&self.webview, text, mode)
    }

    /// The check path's staged files still in the candidate directory.
    fn checks_left(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.candidates)
            .map(|d| {
                d.map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
                    .filter(|n| n.starts_with("provider-check-"))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn record_file(&self, name: &str) -> String {
        std::fs::read_to_string(self.record.join(name)).unwrap_or_default()
    }

    /// How many times the engine was asked to `provider test`.
    fn tests_run(&self) -> usize {
        std::fs::read_dir(&self.record)
            .expect("record dir")
            .filter(|e| {
                let n = e.as_ref().expect("entry").file_name();
                let n = n.to_string_lossy();
                n.starts_with("tested-") && n.ends_with(".json")
            })
            .count()
    }

    fn hold(&self, what: &str) {
        std::fs::write(self.record.join(format!("hold-{what}")), "").expect("hold");
    }

    fn release(&self, what: &str) {
        std::fs::write(self.record.join(format!("release-{what}")), "").expect("release");
    }

    /// Wait (≤ 20 s) until the fake is HOLDING a `what` call; the staged path it was handed.
    fn held(&self, what: &str) -> PathBuf {
        let marker = self.record.join(format!("held-{what}"));
        let started = std::time::Instant::now();
        while !marker.exists() {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(20),
                "the fake never started holding {what}"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        PathBuf::from(std::fs::read_to_string(&marker).expect("held").trim_end())
    }

    /// What the fake found when its held `what` call resumed: `present` or `gone`, one per call.
    fn survived(&self, what: &str) -> String {
        self.record_file(&format!("survived-{what}.txt"))
    }

    /// An engine argv was recorded for anything at all (the check never ran `status --json` either).
    fn engine_ran(&self) -> bool {
        self.record.join("argv.txt").exists()
            || self.record.join("validated-paths.txt").exists()
            || self.tests_run() > 0
    }
}

fn check_on(w: &WebviewWindow<MockRuntime>, text: &str, mode: Value) -> Result<Value, Value> {
    call(
        w,
        "provider_candidate_check",
        json!({ "text": text, "mode": mode }),
    )
}

/// Is `path` a check-path staged file in `candidates`: `provider-check-<pid>-<seq>.json`?
fn is_check_file(path: &Path, candidates: &Path) -> bool {
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    let pid = std::process::id().to_string();
    path.parent() == Some(candidates)
        && name
            .strip_prefix(&format!("provider-check-{pid}-"))
            .and_then(|rest| rest.strip_suffix(".json"))
            .is_some_and(|seq| !seq.is_empty() && seq.bytes().all(|b| b.is_ascii_digit()))
}

/// Validate mode answers the engine's `config validate --json` report VERBATIM, over a private
/// staged copy under the check path's own prefix — and writes nothing to the real config.
#[test]
fn a_validate_check_returns_the_engines_report_and_writes_nothing() {
    let s = check_box("chk-validate", Some(FULL), None);
    let candidate = edit(FULL, |v| v["lookbackCapDays"] = json!(5));
    let out = s
        .check(&candidate, json!("validate"))
        .expect("the check answers");
    assert_eq!(kind(&out), "validated", "{out}");
    assert_eq!(
        out["report"],
        json!({ "schemaVersion": 1, "valid": true, "errors": [], "warnings": [], "normalized": {} }),
        "the report is the engine's, verbatim"
    );
    assert_eq!(s.validations(), 1);
    let staged = PathBuf::from(s.record_file("validated-paths.txt").trim_end());
    assert!(
        is_check_file(&staged, &s.candidates),
        "staged as {} — not provider-check-<pid>-<seq>.json in the candidate dir",
        staged.display()
    );
    assert_eq!(
        s.validated(0),
        candidate,
        "the engine validated other bytes"
    );
    assert_eq!(s.validated_modes(), vec!["600 700".to_string()]);
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
    assert_eq!(s.on_disk(), FULL, "the check wrote the real config");
    assert!(s.backup().is_none(), "the check made a .bak");
    assert!(s.leftovers().is_empty(), "{:?}", s.leftovers());
    assert_eq!(
        s.record_file("argv.txt"),
        format!("config\nvalidate\n--json\n--file\n{}\n", staged.display()),
        "the check asked the engine for something besides one `config validate` (no `status`: \
         it never locates or reads the real config)"
    );

    // An INVALID verdict is still the engine's report, not an error.
    let invalid = edit(FULL, |v| v["x-test"] = json!("__invalid__"));
    let out = s
        .check(&invalid, json!("validate"))
        .expect("the check answers");
    assert_eq!(kind(&out), "validated", "{out}");
    assert_eq!(out["report"]["valid"], false);
    assert_eq!(out["report"]["errors"][0]["field"], "lookbackCapDays");

    // An exit-0 reply that is not JSON is an engine error in words, and the file is still removed.
    let garbage = edit(FULL, |v| v["x-test"] = json!("__garbage__"));
    let err = s.check(&garbage, json!("validate")).expect_err("garbage");
    assert_eq!(kind(&err), "engine", "{err}");
    assert!(
        err["detail"].as_str().is_some_and(|d| !d.is_empty()),
        "{err}"
    );
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
    assert_eq!(s.on_disk(), FULL);
}

/// Test mode runs `provider test --file <the staged copy> --index <n> --json` and answers the
/// engine's JSON line verbatim, with the bound the app applied.
#[test]
fn a_test_check_passes_the_staged_path_and_index() {
    let _turn = mutating_turn();
    let s = check_box("chk-test", Some(FULL), None);
    let candidate = edit(FULL, |v| v["lookbackCapDays"] = json!(3));
    let out = s
        .check(&candidate, test_mode(2, 80_000))
        .expect("the check answers");
    assert_eq!(kind(&out), "tested", "{out}");
    assert_eq!(
        out["answer"],
        json!({ "schemaVersion": 1, "ok": true, "passed": true, "at": "2026-10-18T00:00:00.000Z", "recorded": true })
    );
    assert_eq!(out["boundMs"], 80_000);
    assert_eq!(s.tests_run(), 1);
    let argv: Vec<String> = s
        .record_file("test-argv-0.txt")
        .lines()
        .map(str::to_string)
        .collect();
    assert_eq!(argv.len(), 7, "{argv:?}");
    assert_eq!(&argv[..3], ["provider", "test", "--file"]);
    assert!(
        is_check_file(Path::new(&argv[3]), &s.candidates),
        "staged as {} — not provider-check-<pid>-<seq>.json in the candidate dir",
        argv[3]
    );
    assert_eq!(&argv[4..], ["--index", "2", "--json"]);
    assert_eq!(
        s.record_file("tested-0.json"),
        candidate,
        "the engine probed other bytes"
    );
    assert_eq!(s.record_file("tested-modes.txt"), "600 700\n");
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
    assert_eq!(s.on_disk(), FULL, "the check wrote the real config");
    assert!(s.backup().is_none());
    assert_eq!(s.validations(), 0, "a Test validated through the save path");
}

/// The staged file is 0600 in a 0700 directory, and gone after EVERY outcome: a pass, an engine
/// refusal (still the engine's JSON line), a crash, an unreadable reply, and a timeout.
#[test]
fn the_staged_file_is_private_and_removed_on_every_outcome() {
    let _turn = mutating_turn();
    let s = check_box(
        "chk-outcomes",
        Some(FULL),
        // Long enough for every answering case on a loaded machine; the hang case sleeps 30 s.
        Some(std::time::Duration::from_secs(6)),
    );
    let with = |marker: &str| edit(FULL, |v| v["x-test"] = json!(marker));

    let out = s
        .check(&with("pass"), test_mode(0, 80_000))
        .expect("a pass");
    assert_eq!(kind(&out), "tested", "{out}");
    assert!(
        s.checks_left().is_empty(),
        "after a pass: {:?}",
        s.checks_left()
    );

    let out = s
        .check(&with("__test_refused__"), test_mode(0, 80_000))
        .expect("a refusal is the engine's answer");
    assert_eq!(kind(&out), "tested", "{out}");
    assert_eq!(out["answer"]["ok"], false);
    assert_eq!(out["answer"]["code"], "config");
    assert!(
        s.checks_left().is_empty(),
        "after a refusal: {:?}",
        s.checks_left()
    );

    let err = s
        .check(&with("__test_crash__"), test_mode(0, 80_000))
        .expect_err("a crash");
    assert_eq!(kind(&err), "engine", "{err}");
    assert!(
        s.checks_left().is_empty(),
        "after a crash: {:?}",
        s.checks_left()
    );

    let err = s
        .check(&with("__test_garbage__"), test_mode(0, 80_000))
        .expect_err("an unreadable reply");
    assert_eq!(kind(&err), "engine", "{err}");
    assert!(
        s.checks_left().is_empty(),
        "after an unreadable reply: {:?}",
        s.checks_left()
    );

    let err = s
        .check(&with("__test_hang__"), test_mode(0, 80_000))
        .expect_err("a timeout");
    assert_eq!(kind(&err), "timeout", "{err}");
    assert_eq!(err["operation"], "provider-test", "{err}");
    assert!(
        s.checks_left().is_empty(),
        "after a timeout: {:?}",
        s.checks_left()
    );

    assert_eq!(s.tests_run(), 5, "every case reached the engine");
    assert_eq!(
        s.record_file("tested-modes.txt"),
        "600 700\n".repeat(5),
        "a staged candidate was not 0600 in a 0700 directory"
    );
    assert_eq!(s.on_disk(), FULL);
}

/// An oversize candidate is refused exactly as the save path refuses it — before it is parsed,
/// staged or sent anywhere.
#[test]
fn an_oversize_candidate_is_refused_as_the_save_refuses_it() {
    let s = check_box("chk-oversize", Some(FULL), None);
    let huge = format!(
        "{{\"x\":\"{}\"}}",
        "a".repeat(usize::try_from(MAX_CONFIG_BYTES).unwrap())
    );
    let saved = s
        .save(&huge, &base_of(&s.read()))
        .expect_err("the save refuses it");
    let _ = std::fs::remove_file(s.record.join("argv.txt")); // the `config_read` above
    for mode in [json!("validate"), test_mode(0, 80_000)] {
        let err = s
            .check(&huge, mode.clone())
            .expect_err("the check refuses it");
        assert_eq!(kind(&err), "tooLarge", "{mode}: {err}");
        assert_eq!(err, saved, "{mode}: not the save path's refusal");
    }
    assert!(!s.candidates.exists(), "an oversize candidate was staged");
    assert!(!s.engine_ran(), "an oversize candidate reached the engine");
}

/// A calendar link address is refused in BOTH modes before anything is staged — the same answer
/// the save gives, so the secret never reaches `config-candidates/`.
#[test]
fn a_calendar_link_address_is_refused_by_the_check_before_staging() {
    use daily_briefing_gui_lib::config_save::CALENDAR_SECRET_ERROR;
    let s = check_box("chk-cal", Some(FULL), None);
    for block in calendar_secret_blocks() {
        let candidate = edit(FULL, |v| v["calendar"] = block.clone());
        for mode in [json!("validate"), test_mode(0, 80_000)] {
            let out = s
                .check(&candidate, mode.clone())
                .expect("the check answers");
            assert_eq!(kind(&out), "invalid", "{mode} {block}");
            assert_eq!(
                out["errors"],
                json!([{ "field": "calendar", "message": CALENDAR_SECRET_ERROR }])
            );
            assert_eq!(out["warnings"], json!([]));
            assert!(
                !out.to_string().contains("SENTINEL"),
                "the answer echoed the address"
            );
        }
    }
    assert!(
        !s.candidates.exists(),
        "a candidate holding a link address was staged"
    );
    assert!(
        !s.engine_ran(),
        "a candidate holding a link address reached the engine"
    );
}

/// PR 3 final r1 (reviewer A3): a candidate holding a LITERAL key — any non-`null` value at an
/// `apiKey` slot of any ASCII case, at any depth, other than exactly [`REDACTED_API_KEY`] — is
/// refused in BOTH modes before anything is staged. The webview never holds a key, so the only
/// literal it can legitimately send is the placeholder; anything else was typed into the Raw JSON
/// tab, and staging it would write a secret into `config-candidates/` that the save path refuses
/// anyway (`refuse_new_or_changed_literals`). The answer is the calendar refusal's shape
/// (`invalid`, one fixed note, never the value), which every caller of the check already words.
/// The placeholder itself, and a `null` slot, still stage and check exactly as before.
#[test]
fn a_literal_key_is_refused_by_the_check_before_staging_and_the_placeholder_still_checks() {
    use daily_briefing_gui_lib::config_save::CHECK_LITERAL_KEY_ERROR;
    const SECRET: &str = "sk-ant-api03-SENTINEL-literal-0000";
    let api = |key: Value| json!({ "kind": "anthropic", "model": "m", "apiKey": key });
    let fallback = |key: Value| json!([{ "label": "spare", "api": api(key) }]);
    let literal_cases: Vec<(&str, String)> = vec![
        (
            "item 1",
            edit(FULL, |v| v["provider"]["api"] = api(json!(SECRET))),
        ),
        (
            "a fallback",
            edit(FULL, |v| v["fallbacks"] = fallback(json!(SECRET))),
        ),
        (
            "a case variant",
            edit(
                FULL,
                |v| {
                    v["provider"]["api"] =
                        json!({ "kind": "anthropic", "model": "m", "ApiKey": SECRET })
                },
            ),
        ),
        (
            "anywhere else",
            edit(FULL, |v| {
                v["x-notes"] = json!({ "deep": [{ "apiKEY": SECRET }] })
            }),
        ),
        (
            "a number",
            edit(FULL, |v| v["fallbacks"] = fallback(json!(12_345_678))),
        ),
        (
            "an array",
            edit(FULL, |v| v["fallbacks"] = fallback(json!([SECRET]))),
        ),
        (
            "an object",
            edit(FULL, |v| v["fallbacks"] = fallback(json!({ "k": SECRET }))),
        ),
        (
            "empty",
            edit(FULL, |v| v["fallbacks"] = fallback(json!(""))),
        ),
        (
            "the placeholder, padded",
            edit(FULL, |v| {
                v["fallbacks"] = fallback(json!(format!(" {REDACTED_API_KEY}")))
            }),
        ),
        (
            "a placeholder beside a literal",
            edit(FULL, |v| {
                v["provider"]["api"] = api(json!(REDACTED_API_KEY));
                v["fallbacks"] = fallback(json!(SECRET));
            }),
        ),
    ];
    let s = check_box("chk-literal", Some(FULL), None);
    for (what, candidate) in &literal_cases {
        for mode in [json!("validate"), test_mode(0, 80_000)] {
            let out = s.check(candidate, mode.clone()).expect("the check answers");
            assert_eq!(kind(&out), "invalid", "{what} {mode}: {out}");
            assert_eq!(
                out["errors"],
                json!([{ "field": "apiKey", "message": CHECK_LITERAL_KEY_ERROR }]),
                "{what} {mode}"
            );
            assert_eq!(out["warnings"], json!([]));
            assert!(
                !out.to_string().contains("SENTINEL"),
                "{what}: the answer echoed the key"
            );
        }
    }
    assert!(
        !s.candidates.exists(),
        "a candidate holding a literal key was staged"
    );
    assert!(
        !s.engine_ran(),
        "a candidate holding a literal key reached the engine"
    );

    // The placeholder at a key slot, and a `null` slot, are checked exactly as today: staged as
    // they are (the check never restores — that is the save path's step) and handed to the engine.
    let _turn = mutating_turn();
    let placeholder = edit(FULL, |v| {
        v["provider"]["api"] = api(json!(REDACTED_API_KEY));
        v["fallbacks"] = fallback(Value::Null);
    });
    let out = s
        .check(&placeholder, json!("validate"))
        .expect("the check answers");
    assert_eq!(kind(&out), "validated", "{out}");
    assert_eq!(
        s.validated(0),
        placeholder,
        "the engine validated other bytes"
    );
    let out = s
        .check(&placeholder, test_mode(0, 80_000))
        .expect("the check answers");
    assert_eq!(kind(&out), "tested", "{out}");
    assert_eq!(
        s.record_file("tested-0.json"),
        placeholder,
        "the engine probed other bytes"
    );
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
    assert_eq!(s.on_disk(), FULL, "the check wrote the real config");
}

/// The mode is a closed shape: an index the engine would refuse, a misspelt mode, an extra field
/// or a missing argument are refused before anything is staged.
#[test]
fn a_malformed_mode_is_refused_before_staging() {
    let s = check_box("chk-mode", Some(FULL), None);
    let err = s
        .check(FULL, test_mode(1_000_000, 80_000))
        .expect_err("an index past the engine's six digits");
    assert_eq!(kind(&err), "invalidInput", "{err}");
    for mode in [
        json!("tset"),
        json!({ "test": { "index": 0 } }),
        json!({ "test": { "index": 0, "testTimeoutMs": 80000, "file": "/etc/passwd" } }),
        json!({ "test": { "index": -1, "testTimeoutMs": 80000 } }),
        json!({ "validate": {} }),
    ] {
        s.check(FULL, mode.clone())
            .expect_err(&format!("{mode} must be refused"));
    }
    call(
        &s.webview,
        "provider_candidate_check",
        json!({ "text": FULL }),
    )
    .expect_err("no mode");
    call(
        &s.webview,
        "provider_candidate_check",
        json!({ "mode": "validate" }),
    )
    .expect_err("no text");
    let err = s
        .check("{ not json", json!("validate"))
        .expect_err("not JSON");
    assert_eq!(kind(&err), "notJson", "{err}");
    let err = s
        .check("[1, 2]", json!("validate"))
        .expect_err("not an object");
    assert_eq!(kind(&err), "notJson", "{err}");
    assert!(!s.candidates.exists(), "a refused check staged a candidate");
    assert!(!s.engine_ran(), "a refused check reached the engine");
}

/// The prefix and the lock scope (the plan's two regressions): a save made WHILE a Test runs is not
/// blocked by it — the check holds `ConfigSaver`'s lock only around its staging, never across the
/// engine call — and the save's sweep (`candidate-`, this process's files included) never deletes
/// the Test's staged copy.
#[test]
fn a_save_made_while_a_test_runs_is_not_blocked_and_spares_its_candidate() {
    let _turn = mutating_turn();
    let s = check_box("chk-vs-save", Some(FULL), None);
    s.hold("provider-check-provider");
    let doc = s.read();
    let saved_text = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(4));
    let w = &s.webview;
    let tested = std::thread::scope(|scope| {
        let test = scope.spawn(|| check_on(w, FULL, test_mode(1, 80_000)));
        let staged = s.held("provider-check-provider");
        assert!(
            staged.exists(),
            "the Test's staged copy is missing while it runs"
        );
        // The fake is holding the Test; this save must complete WITHOUT it being released.
        let saved = call(
            w,
            "config_save",
            json!({ "text": saved_text, "base": base_of(&doc) }),
        )
        .expect("the save answers");
        assert_eq!(kind(&saved), "saved", "{saved}");
        assert!(
            !test.is_finished(),
            "the save finished only after the Test did — it waited for a lock the Test held \
             across its engine call"
        );
        assert!(
            staged.exists(),
            "the save's sweep deleted the running Test's staged copy"
        );
        s.release("provider-check-provider");
        test.join().unwrap()
    });
    let tested = tested.expect("the Test answers");
    assert_eq!(kind(&tested), "tested", "{tested}");
    assert_eq!(s.survived("provider-check-provider"), "present\n");
    assert_eq!(
        serde_json::from_str::<Value>(&s.on_disk()).unwrap()["lookbackCapDays"],
        4,
        "the save did not land"
    );
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
}

/// Check against check: a validate started while a Test runs completes (validate takes no
/// in-flight guard), and each staged file survives until its own call ends.
#[test]
fn a_validate_started_while_a_test_runs_completes() {
    let _turn = mutating_turn();
    let s = check_box("chk-vs-chk", Some(FULL), None);
    s.hold("provider-check-provider");
    let w = &s.webview;
    let tested = std::thread::scope(|scope| {
        let test = scope.spawn(|| check_on(w, FULL, test_mode(0, 80_000)));
        let test_staged = s.held("provider-check-provider");
        let out = check_on(w, FULL, json!("validate")).expect("the validate answers");
        assert_eq!(kind(&out), "validated", "{out}");
        let validate_staged = PathBuf::from(s.record_file("validated-paths.txt").trim_end());
        assert!(is_check_file(&validate_staged, &s.candidates));
        assert_ne!(
            validate_staged, test_staged,
            "the two checks shared one file"
        );
        assert!(
            !validate_staged.exists(),
            "the validate's file outlived its call"
        );
        assert!(
            test_staged.exists(),
            "the validate's sweep deleted the running Test's staged copy"
        );
        s.release("provider-check-provider");
        test.join().unwrap()
    });
    assert_eq!(kind(&tested.expect("the Test answers")), "tested");
    assert_eq!(s.survived("provider-check-provider"), "present\n");
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
}

/// A second Test while one runs is refused `busy` (Test is mutating), and its staged file is
/// removed; the first keeps its own and completes.
#[test]
fn a_second_test_while_one_runs_is_busy_and_leaves_no_staged_file() {
    let _turn = mutating_turn();
    let s = check_box("chk-busy", Some(FULL), None);
    s.hold("provider-check-provider");
    let w = &s.webview;
    let first = std::thread::scope(|scope| {
        let first = scope.spawn(|| check_on(w, FULL, test_mode(0, 80_000)));
        let first_staged = s.held("provider-check-provider");
        let err = check_on(w, FULL, test_mode(1, 80_000)).expect_err("busy");
        assert_eq!(kind(&err), "busy", "{err}");
        assert_eq!(err["running"], "provider-test", "{err}");
        let first_name = first_staged
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            s.checks_left(),
            vec![first_name],
            "the refused Test left a staged file, or removed the first's"
        );
        s.release("provider-check-provider");
        first.join().unwrap()
    });
    assert_eq!(kind(&first.expect("the first Test answers")), "tested");
    assert_eq!(s.tests_run(), 1, "the refused Test reached the engine");
    assert_eq!(s.survived("provider-check-provider"), "present\n");
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
}

/// The check's sweep of its own prefix removes ONLY a dead writer's files — never this process's
/// (an in-flight check's), never a live pid's, never another prefix's (the save's `candidate-`),
/// never anything else.
#[test]
fn a_check_sweeps_only_dead_writers_staged_files() {
    let s = check_box("chk-sweep", Some(FULL), None);
    let me = std::process::id();
    let dead = {
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn true");
        let pid = child.id();
        child.wait().expect("reap true");
        pid
    };
    std::fs::create_dir_all(&s.candidates).unwrap();
    let stale = format!("provider-check-{dead}-1.json");
    let kept = [
        format!("provider-check-{me}-900001.json"),
        "provider-check-1-1.json".to_string(),
        format!("candidate-{dead}-1.json"),
        format!("candidate-{me}-900002.json"),
        format!("provider-check-{dead}-1.json.tmp"),
        "notes.txt".to_string(),
    ];
    for name in std::iter::once(&stale).chain(&kept) {
        std::fs::write(s.candidates.join(name), "x").unwrap();
    }
    let out = s.check(FULL, json!("validate")).expect("the check answers");
    assert_eq!(kind(&out), "validated", "{out}");
    let mut left: Vec<String> = std::fs::read_dir(&s.candidates)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    let mut expected = kept.to_vec();
    expected.sort();
    assert_eq!(left, expected, "the check's sweep removed the wrong files");
}

/// The Test's bound is the row's `testTimeoutMs` as given — Rust adds nothing — clamped to between
/// 17 s and the 30-minute cap (plan Q12), so a hand-edited timeout cannot hold the guard for hours.
#[test]
fn the_test_bound_is_the_rows_value_capped_at_30_minutes() {
    let _turn = mutating_turn();
    let s = check_box("chk-bound", Some(FULL), None);
    for (given, applied) in [
        (80_000_u64, 80_000_u64),
        (125_000, 125_000),
        (30 * 60 * 1000, 30 * 60 * 1000),
        (30 * 60 * 1000 + 1, 30 * 60 * 1000),
        (u64::MAX, 30 * 60 * 1000),
        (0, 17_000),
    ] {
        let out = s
            .check(FULL, test_mode(0, given))
            .expect("the check answers");
        assert_eq!(kind(&out), "tested", "{given}: {out}");
        assert_eq!(out["boundMs"], applied, "testTimeoutMs {given}");
    }

    // `boundMs` is the bound `invoke` ENFORCES (`EngineClient::effective_timeout`), not the
    // operation's own: under a harness cap the two differ, and the answer reports the applied one.
    let capped = check_box(
        "chk-bound-cap",
        Some(FULL),
        Some(std::time::Duration::from_secs(20)),
    );
    for (given, applied) in [(80_000_u64, 20_000_u64), (0, 17_000)] {
        let out = capped
            .check(FULL, test_mode(0, given))
            .expect("the check answers");
        assert_eq!(kind(&out), "tested", "{given}: {out}");
        assert_eq!(
            out["boundMs"], applied,
            "testTimeoutMs {given} under a 20 s cap: not the bound the client applied"
        );
    }
}

/// The check TAKES `ConfigSaver`'s lock for its staging (the plan's lock-scope regression has two
/// directions; the save-during-Test test above pins "not across the engine call"): while a SAVE
/// holds the lock — here, through its own `config validate` — a check started meanwhile stages
/// nothing and asks the engine nothing, and goes on once the save is done.
#[test]
fn a_check_started_while_a_save_holds_the_lock_waits_to_stage() {
    let s = check_box("chk-wait-save", Some(FULL), None);
    let doc = s.read();
    let saved_text = edit(&text_of(&doc), |v| v["lookbackCapDays"] = json!(4));
    s.hold("candidate-config");
    // Held too, so a check that did NOT wait would sit in the fake with its staged file present.
    s.hold("provider-check-config");
    let w = &s.webview;
    let checked = std::thread::scope(|scope| {
        let save = scope.spawn(|| {
            call(
                w,
                "config_save",
                json!({ "text": saved_text, "base": base_of(&doc) }),
            )
        });
        s.held("candidate-config");
        let check = scope.spawn(|| check_on(w, FULL, json!("validate")));
        std::thread::sleep(std::time::Duration::from_millis(1000));
        assert!(
            !s.record.join("held-provider-check-config").exists(),
            "the check reached the engine while a save held the lock"
        );
        assert!(
            s.checks_left().is_empty(),
            "the check staged while a save held the lock: {:?}",
            s.checks_left()
        );
        assert!(!check.is_finished(), "the check did not wait for the save");
        s.release("candidate-config");
        let saved = save.join().unwrap().expect("the save answers");
        assert_eq!(kind(&saved), "saved", "{saved}");
        let staged = s.held("provider-check-config");
        assert!(
            is_check_file(&staged, &s.candidates) && staged.exists(),
            "the check's staged copy: {}",
            staged.display()
        );
        s.release("provider-check-config");
        check.join().unwrap()
    });
    let checked = checked.expect("the check answers");
    assert_eq!(kind(&checked), "validated", "{checked}");
    assert_eq!(s.survived("candidate-config"), "present\n");
    assert_eq!(s.survived("provider-check-config"), "present\n");
    assert_eq!(
        serde_json::from_str::<Value>(&s.on_disk()).unwrap()["lookbackCapDays"],
        4,
        "the save did not land"
    );
    assert!(s.checks_left().is_empty(), "{:?}", s.checks_left());
}

/// After Uninstall's settings leg (the latch), the check is refused in BOTH modes with the save's
/// words — before anything is staged (`config-candidates/` is not re-created) or the engine asked
/// (a Test would write into the state folder Uninstall cleared).
#[test]
fn after_uninstall_removed_the_settings_the_check_is_refused_and_creates_nothing() {
    use daily_briefing_gui_lib::config_save::SETTINGS_REMOVED_BY_UNINSTALL;
    let _turn = mutating_turn();
    let s = check_box_with("chk-latched", Some(FULL), None, true);
    assert!(
        !s.candidates.exists(),
        "premise: no candidate directory yet"
    );
    let saved = s.save(FULL, "base").expect_err("premise: the save refuses");
    assert_eq!(
        saved,
        json!({ "kind": "unsupported", "detail": SETTINGS_REMOVED_BY_UNINSTALL })
    );
    for mode in [json!("validate"), test_mode(0, 80_000)] {
        let err = s.check(FULL, mode.clone()).expect_err("the check refuses");
        assert_eq!(
            err,
            json!({ "kind": "engine", "detail": SETTINGS_REMOVED_BY_UNINSTALL }),
            "{mode}"
        );
    }
    assert!(
        !s.candidates.exists(),
        "a refused check re-created the candidate directory"
    );
    assert!(!s.engine_ran(), "a refused check reached the engine");
    assert_eq!(s.on_disk(), FULL);
}
