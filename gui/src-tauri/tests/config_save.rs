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
    let app = mock_builder()
        .manage(Engine(Ok(client)))
        .manage(ConfigSaver::with_candidate_dir(candidates))
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
