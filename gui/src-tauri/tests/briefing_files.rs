//! T12/T13 — the two briefing reads, driven through REAL IPC on a MockRuntime app built from the
//! shipped handler, against a fake engine whose `status --json` names a scratch state directory.
//!
//! What is pinned: the date operand admits real calendar dates only and is refused BEFORE any
//! spawn; the file read refuses symlinks, non-regular files, over-size and non-UTF-8 content and
//! returns everything else byte-for-byte; and a browse session writes NOTHING under the state
//! directory (a tree hash, not a code reading).

mod common;

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{files_sidecar, ScratchDir};
use daily_briefing_gui_lib::briefing_files::{
    absolute, archive_date, archived_path, read_text_capped, DateRefusal, ReadRefusal,
    MAX_BRIEFING_BYTES,
};
use daily_briefing_gui_lib::config_save::ConfigSaver;
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

/// A briefing as `renderBriefing` shapes it, carrying hostile inline content in the model-written
/// fields — the renderer's problem, not this module's: here it must come back UNMODIFIED.
const HOSTILE_BRIEFING: &str = "\u{2600}\u{fe0f}  Daily briefing \u{2014} 2026-09-15  (this machine: mac)\n\n\u{25b6} Where you left off\n   \u{2022} [app] <img src=x onerror=alert(1)> and [x](javascript:alert(1))\n\n\u{25b6} Suggested next\n   \u{2022} ![p](data:text/html;base64,PHNjcmlwdD4=)\n\n\u{2014} generated locally via claude";

struct Browse {
    state: PathBuf,
    record: PathBuf,
    _app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    _scratch: ScratchDir,
}

fn browse(tag: &str) -> Browse {
    let scratch = ScratchDir::new(tag);
    let state = scratch.join("state");
    let record = scratch.join("record");
    std::fs::create_dir_all(state.join("briefings")).expect("state");
    std::fs::create_dir_all(&record).expect("record");
    let program = files_sidecar(
        &scratch.path,
        "engine.sh",
        &state,
        &scratch.join("xdg").join("config.json"),
        &record,
    );
    let app = mock_builder()
        .manage(Engine(Ok(EngineClient::with_program(program))))
        .manage(ConfigSaver::with_candidate_dir(scratch.join("candidates")))
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(tauri::generate_context!())
        .expect("mock app");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");
    Browse {
        state,
        record,
        _app: app,
        webview,
        _scratch: scratch,
    }
}

fn call_on(webview: &WebviewWindow<MockRuntime>, cmd: &str, body: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().expect("url"),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    match get_ipc_response(webview, request) {
        Ok(body) => Ok(body.deserialize().expect("JSON")),
        Err(e) => Err(e),
    }
}

impl Browse {
    fn call(&self, cmd: &str, body: Value) -> Result<Value, Value> {
        call_on(&self.webview, cmd, body)
    }

    fn archived(&self, date: &str) -> Result<Value, Value> {
        self.call("read_archived_briefing", json!({ "date": date }))
    }

    fn spawns(&self) -> usize {
        std::fs::read_to_string(self.record.join("argv.txt"))
            .map(|s| s.matches("status\n--json\n").count())
            .unwrap_or(0)
    }

    fn put(&self, date: &str, bytes: &[u8]) -> PathBuf {
        let path = self.state.join("briefings").join(format!("{date}.md"));
        std::fs::write(&path, bytes).expect("write briefing");
        path
    }
}

fn kind(v: &Value) -> &str {
    v["kind"].as_str().unwrap_or("<no kind>")
}

/// How long a read of a FIFO may take before it counts as blocked.
const BLOCKED_AFTER: Duration = Duration::from_secs(10);

/// Run `read` on its own thread and return its answer, or FAIL within [`BLOCKED_AFTER`] if it
/// has not answered — rather than hanging the suite, which is what an in-line call does when the
/// open blocks (review round 1: without `O_NONBLOCK` the old in-line check never got to fire).
///
/// On a timeout the FIFO is opened for writing (non-blocking, so this cannot hang either), which
/// releases the stuck reader so its thread ends before the scratch directory is removed.
fn within_or_unblock<T: Send + 'static>(
    fifo: &Path,
    what: &str,
    read: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let _ = tx.send(read());
    });
    match rx.recv_timeout(BLOCKED_AFTER) {
        Ok(answer) => {
            reader.join().expect("the reader thread");
            answer
        }
        Err(_) => {
            use std::os::unix::fs::OpenOptionsExt;
            let _writer = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(fifo);
            let _ = rx.recv_timeout(Duration::from_secs(5));
            panic!(
                "{what}: the read of a FIFO blocked for {BLOCKED_AFTER:?} (is O_NONBLOCK gone?)"
            );
        }
    }
}

/// Everything under `root`: relative path → (kind, bytes, mode, mtime). A write, a delete, a
/// rename, a chmod or a touch all change it.
fn tree(root: &Path) -> BTreeMap<String, String> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .expect("readable")
            .map(|e| e.expect("entry").path())
            .collect();
        entries.sort();
        for path in entries {
            use std::os::unix::fs::MetadataExt;
            let meta = std::fs::symlink_metadata(&path).expect("metadata");
            let rel = path
                .strip_prefix(root)
                .expect("under root")
                .display()
                .to_string();
            let content = if meta.file_type().is_symlink() {
                format!("link->{}", std::fs::read_link(&path).unwrap().display())
            } else if meta.is_dir() {
                "dir".to_string()
            } else if meta.is_file() {
                let mut bytes = Vec::new();
                std::fs::File::open(&path)
                    .unwrap()
                    .read_to_end(&mut bytes)
                    .unwrap();
                format!("file:{:?}", bytes)
            } else {
                "special".to_string()
            };
            out.insert(
                rel,
                format!(
                    "{content} mode={:o} mtime={}.{}",
                    meta.mode(),
                    meta.mtime(),
                    meta.mtime_nsec()
                ),
            );
            if meta.is_dir() && !meta.file_type().is_symlink() {
                walk(&path, root, out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

/* ── the date operand ─────────────────────────────────────────────────────────────────────────── */

#[test]
fn only_real_calendar_dates_are_admitted() {
    for ok in [
        "2026-09-16",
        "2024-02-29",
        "2000-02-29",
        "0001-01-01",
        "9999-12-31",
        "2026-04-30",
    ] {
        let date = archive_date(ok).unwrap_or_else(|e| panic!("{ok} was refused: {e:?}"));
        assert_eq!(date.as_str(), ok);
    }
    let nul = format!("2026-01-0{}", char::from(0));
    let fullwidth_two = format!("{}026-01-01", char::from_u32(0xff12).unwrap());
    let refused: Vec<(&str, DateRefusal)> = vec![
        ("2026-13-01", DateRefusal::Month),
        ("2026-00-10", DateRefusal::Month),
        ("2026-02-30", DateRefusal::Day),
        ("2025-02-29", DateRefusal::Day),
        ("1900-02-29", DateRefusal::Day),
        ("2026-04-31", DateRefusal::Day),
        ("2026-01-00", DateRefusal::Day),
        ("2026-01-32", DateRefusal::Day),
        ("0000-01-01", DateRefusal::Year),
        ("20260101", DateRefusal::Shape),
        ("../2026-01-01", DateRefusal::Shape),
        ("..", DateRefusal::Shape),
        ("2026/01/01", DateRefusal::Shape),
        ("2026-1-01", DateRefusal::Shape),
        ("2026-01-1", DateRefusal::Shape),
        (" 2026-01-01", DateRefusal::Shape),
        ("2026-01-01\n", DateRefusal::Shape),
        ("2026-01-01.md", DateRefusal::Shape),
        ("/etc/passwd", DateRefusal::Shape),
        ("/tmp/2026-01-01", DateRefusal::Shape),
        ("2026-+1-01", DateRefusal::Shape),
        ("2026--1-01", DateRefusal::Shape),
        ("", DateRefusal::Shape),
        (&nul, DateRefusal::Shape),
        (&fullwidth_two, DateRefusal::Shape),
    ];
    for (value, expected) in refused {
        assert_eq!(archive_date(value), Err(expected), "{value:?}");
    }
}

#[test]
fn the_archive_path_is_the_engine_directory_plus_the_date() {
    let dir = Path::new("/state/briefings");
    let date = archive_date("2026-09-16").unwrap();
    assert_eq!(
        archived_path(dir, &date),
        PathBuf::from("/state/briefings/2026-09-16.md")
    );
    // An engine-reported path must be absolute; a relative one is not resolved against the cwd.
    assert!(absolute(
        "status --json",
        "paths.briefingsDir",
        Some(&"state/briefings".to_string())
    )
    .is_err());
    assert!(absolute("status --json", "paths.briefingsDir", None).is_err());
    assert!(absolute(
        "status --json",
        "paths.briefingsDir",
        Some(&"/s/b".to_string())
    )
    .is_ok());
}

#[test]
fn a_refused_date_is_refused_before_any_spawn() {
    let b = browse("brief-refuse");
    for bad in [
        "../",
        "../../etc/passwd",
        "2026-13-01",
        "2026-02-30",
        "20260101",
        "/etc/passwd",
        "/tmp/2026-01-01.md",
    ] {
        let err = b.archived(bad).expect_err(bad);
        assert_eq!(kind(&err), "invalidDate", "{bad}: {err}");
    }
    assert_eq!(b.spawns(), 0, "a refused date reached the engine");
    // The path is not a parameter: an extra key is ignored, the date still decides.
    let err = b
        .call(
            "read_archived_briefing",
            json!({ "date": "nope", "path": "/etc/passwd" }),
        )
        .expect_err("still refused");
    assert_eq!(kind(&err), "invalidDate", "{err}");
}

/* ── the file ─────────────────────────────────────────────────────────────────────────────────── */

#[test]
fn a_valid_date_returns_the_bytes_unmodified() {
    let b = browse("brief-ok");
    let path = b.put("2026-09-15", HOSTILE_BRIEFING.as_bytes());
    let file = b.archived("2026-09-15").expect("read");
    assert_eq!(file["text"], HOSTILE_BRIEFING);
    assert_eq!(file["bytes"], HOSTILE_BRIEFING.len());
    assert_eq!(file["path"], path.display().to_string());

    let missing = b.archived("2026-09-14").expect_err("missing");
    assert_eq!(kind(&missing), "notFound", "{missing}");

    // Exactly at the cap is fine.
    let at_cap = vec![b'a'; MAX_BRIEFING_BYTES as usize];
    b.put("2026-09-13", &at_cap);
    assert_eq!(
        b.archived("2026-09-13").expect("at cap")["bytes"],
        MAX_BRIEFING_BYTES
    );
}

#[test]
fn over_size_non_utf8_symlinks_and_non_files_are_refused() {
    let b = browse("brief-refusals");
    b.put("2026-01-01", &vec![b'a'; MAX_BRIEFING_BYTES as usize + 1]);
    b.put("2026-01-02", &[0x66, 0x6f, 0xff, 0xfe, 0x6f]);
    let outside = b.state.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "a file outside the archive").unwrap();
    std::os::unix::fs::symlink(&outside, b.state.join("briefings").join("2026-01-03.md")).unwrap();
    std::fs::create_dir(b.state.join("briefings").join("2026-01-04.md")).unwrap();
    let fifo = b.state.join("briefings").join("2026-01-05.md");
    let c_path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: a valid NUL-terminated path; mkfifo has no other preconditions.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0, "mkfifo");

    // The FIFO first, each read on its own thread: a blocking open must FAIL this test, not hang it.
    let webview = b.webview.clone();
    let err = within_or_unblock(&fifo, "read_archived_briefing", move || {
        call_on(
            &webview,
            "read_archived_briefing",
            json!({ "date": "2026-01-05" }),
        )
    })
    .expect_err("a FIFO");
    assert_eq!(kind(&err), "unreadable", "{err}");
    let direct = fifo.clone();
    assert_eq!(
        within_or_unblock(&fifo, "read_text_capped", move || {
            read_text_capped(&direct, MAX_BRIEFING_BYTES)
        }),
        Err(ReadRefusal::NotAFile)
    );

    for (date, needle) in [
        ("2026-01-01", "over the"),
        ("2026-01-02", "not UTF-8"),
        ("2026-01-03", "symbolic link"),
        ("2026-01-04", "not a regular file"),
        ("2026-01-05", "not a regular file"),
    ] {
        let started = Instant::now();
        let err = b.archived(date).expect_err(date);
        assert!(
            started.elapsed() < BLOCKED_AFTER,
            "{date}: the read blocked"
        );
        assert_eq!(kind(&err), "unreadable", "{date}: {err}");
        assert!(
            err["detail"].as_str().unwrap().contains(needle),
            "{date}: {err}"
        );
        assert!(
            !err.to_string().contains("a file outside the archive"),
            "{date}: {err}"
        );
    }

    // The same refusals from the function itself, by variant.
    let dir = b.state.join("briefings");
    assert!(matches!(
        read_text_capped(&dir.join("2026-01-01.md"), MAX_BRIEFING_BYTES),
        Err(ReadRefusal::TooLarge { .. })
    ));
    assert_eq!(
        read_text_capped(&dir.join("2026-01-02.md"), MAX_BRIEFING_BYTES),
        Err(ReadRefusal::NotUtf8)
    );
    assert_eq!(
        read_text_capped(&dir.join("2026-01-03.md"), MAX_BRIEFING_BYTES),
        Err(ReadRefusal::Symlink)
    );
    assert_eq!(
        read_text_capped(&dir.join("2026-01-04.md"), MAX_BRIEFING_BYTES),
        Err(ReadRefusal::NotAFile)
    );
    assert_eq!(
        read_text_capped(&dir.join("2026-01-06.md"), MAX_BRIEFING_BYTES),
        Err(ReadRefusal::NotFound)
    );
    // prove-it 3b: the symlink refusal is the link's, not the target's — the target reads fine.
    assert!(read_text_capped(&outside, MAX_BRIEFING_BYTES).is_ok());
}

#[test]
fn the_latest_briefing_is_none_until_the_engine_writes_one() {
    let b = browse("brief-latest");
    assert_eq!(
        b.call("read_latest_briefing", json!({})).expect("read"),
        Value::Null
    );
    std::fs::write(b.state.join("briefing-latest.md"), HOSTILE_BRIEFING).unwrap();
    let file = b.call("read_latest_briefing", json!({})).expect("read");
    assert_eq!(file["text"], HOSTILE_BRIEFING);
    std::fs::remove_file(b.state.join("briefing-latest.md")).unwrap();
    std::os::unix::fs::symlink("/etc/hosts", b.state.join("briefing-latest.md")).unwrap();
    let err = b
        .call("read_latest_briefing", json!({}))
        .expect_err("a symlink");
    assert_eq!(kind(&err), "unreadable", "{err}");
}

/// ⚠ THE CALIBRATION CORPUS IS NEVER WRITTEN. A browse session — the latest file, every archived
/// date twice, refused dates, a missing date — leaves the whole state tree byte-identical,
/// modes and mtimes included.
#[test]
fn a_browse_session_never_writes_or_deletes_under_the_state_dir() {
    let b = browse("brief-tree");
    std::fs::write(b.state.join("briefing-latest.md"), HOSTILE_BRIEFING).unwrap();
    let mut dates = Vec::new();
    for day in 1..=30 {
        let date = format!("2026-08-{day:02}");
        b.put(&date, format!("{HOSTILE_BRIEFING}\n{date}").as_bytes());
        dates.push(date);
    }
    let before = tree(&b.state);
    assert!(
        before.len() >= 32,
        "the fixture tree is too small to mean anything: {}",
        before.len()
    );

    for _ in 0..2 {
        b.call("read_latest_briefing", json!({})).expect("latest");
        for date in &dates {
            let file = b.archived(date).expect("archived");
            assert!(file["text"].as_str().unwrap().ends_with(date.as_str()));
        }
        let _ = b.archived("2026-09-30");
        let _ = b.archived("../last-run");
        let _ = b.archived("2026-02-31");
    }
    assert_eq!(
        tree(&b.state),
        before,
        "reading briefings changed the state directory"
    );

    // prove-it 3b: the hash would have noticed a touch.
    let probe = b.state.join("briefings").join("2026-08-01.md");
    let bytes = std::fs::read(&probe).unwrap();
    std::fs::write(&probe, &bytes).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    std::fs::write(&probe, &bytes).unwrap();
    assert_ne!(tree(&b.state), before, "the tree hash cannot see a rewrite");
}

/// The module opens nothing for writing: no write, create, rename or remove call in its code.
#[test]
fn the_read_module_has_no_write_call() {
    let source = include_str!("../src/briefing_files.rs");
    let code: String = source
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for call in [
        "fs::write",
        "File::create",
        ".write(true)",
        ".create(",
        ".append(",
        "remove_file",
        "remove_dir",
        "fs::rename",
        "set_permissions",
        "read_dir",
    ] {
        assert!(!code.contains(call), "briefing_files.rs calls {call}");
    }
}
