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

/* ── A2: the latest page's canonical identity ───────────────────────────────────────────────── */

use daily_briefing_gui_lib::briefing_files::{
    canonical_page_version, page_version_for, read_briefing_at, read_latest_briefing_at,
    stable_page_version, windows_file_id, windows_ticks_to_unix_ns, BriefingError,
    PageVersionFields,
};

fn identity_vectors() -> Value {
    serde_json::from_str(include_str!("fixtures/summary-page-version.json")).unwrap()
}

fn version_fields() -> PageVersionFields<'static> {
    PageVersionFields {
        platform: "unix",
        volume: "1",
        file_id: "2",
        size: "3",
        mtime_ns: "4",
        ctime_ns: "5",
    }
}

#[test]
fn a2_page_version_matches_every_shared_literal_and_windows_conversion() {
    let fixture = identity_vectors();
    assert_eq!(fixture["vectors"].as_array().unwrap().len(), 3);
    for vector in fixture["vectors"].as_array().unwrap() {
        let f = &vector["fields"];
        let fields = PageVersionFields {
            platform: f["platform"].as_str().unwrap(),
            volume: f["volume"].as_str().unwrap(),
            file_id: f["fileId"].as_str().unwrap(),
            size: f["size"].as_str().unwrap(),
            mtime_ns: f["mtimeNs"].as_str().unwrap(),
            ctime_ns: f["ctimeNs"].as_str().unwrap(),
        };
        assert_eq!(
            canonical_page_version(&fields).as_deref(),
            vector["canonical"].as_str()
        );
        assert_eq!(
            page_version_for(&fields).as_deref(),
            vector["sha256"].as_str()
        );
    }
    for vector in fixture["windowsTicks"].as_array().unwrap() {
        let ticks = vector["ticks"].as_str().unwrap().parse::<u64>().unwrap();
        assert_eq!(
            windows_ticks_to_unix_ns(ticks),
            vector["unixNs"].as_str().unwrap()
        );
    }
    for vector in fixture["windowsIds"].as_array().unwrap() {
        let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        assert_eq!(windows_file_id(&bytes).as_deref(), vector["hex"].as_str());
    }
    for len in [0, 15, 17] {
        assert_eq!(windows_file_id(&vec![0; len]), None);
    }
}

#[test]
fn a2_page_version_preserves_precision_and_refuses_noncanonical_fields() {
    let original = page_version_for(&version_fields()).unwrap();
    for field in 0..6 {
        let mut fields = version_fields();
        match field {
            0 => {
                fields.platform = "windows";
                fields.file_id = "11111111111111111111111111111111";
            }
            1 => fields.volume = "2",
            2 => fields.file_id = "3",
            3 => fields.size = "4",
            4 => fields.mtime_ns = "5",
            _ => fields.ctime_ns = "6",
        }
        assert_ne!(page_version_for(&fields).unwrap(), original);
    }
    // The platform itself changes the hash even when the file ID is valid on both platforms.
    let mut both = version_fields();
    both.file_id = "11111111111111111111111111111111";
    let unix = page_version_for(&both).unwrap();
    both.platform = "windows";
    assert_ne!(page_version_for(&both).unwrap(), unix);
    let win = page_version_for(&both).unwrap();
    both.file_id = "01111111111111111111111111111111";
    assert_ne!(page_version_for(&both).unwrap(), win);
    both.platform = "other";
    assert_eq!(page_version_for(&both), None);

    for field in 0..5 {
        for value in ["0", "9007199254740993", "18446744073709551615"] {
            let mut fields = version_fields();
            match field {
                0 => fields.volume = value,
                1 => fields.file_id = value,
                2 => fields.size = value,
                3 => fields.mtime_ns = value,
                _ => fields.ctime_ns = value,
            }
            assert_eq!(
                canonical_page_version(&fields).unwrap(),
                format!(
                    "summary-page-v1\nunix\n{}\n{}\n{}\n{}\n{}\n",
                    fields.volume, fields.file_id, fields.size, fields.mtime_ns, fields.ctime_ns,
                )
            );
        }
        for value in ["+1", "01", "-0", " 1", "1\n", "1.0", "1e3", "", "١"] {
            let mut fields = version_fields();
            match field {
                0 => fields.volume = value,
                1 => fields.file_id = value,
                2 => fields.size = value,
                3 => fields.mtime_ns = value,
                _ => fields.ctime_ns = value,
            }
            assert_eq!(page_version_for(&fields), None, "field {field}: {value:?}");
        }
    }
    for field in 0..3 {
        let mut fields = version_fields();
        match field {
            0 => fields.volume = "-1",
            1 => fields.file_id = "-1",
            _ => fields.size = "-1",
        }
        assert_eq!(page_version_for(&fields), None);
    }
    let mut fields = version_fields();
    fields.mtime_ns = "-1";
    fields.ctime_ns = "-1000000001";
    assert_eq!(
        canonical_page_version(&fields).unwrap(),
        "summary-page-v1\nunix\n1\n2\n3\n-1\n-1000000001\n"
    );
    for id in [
        "ABCDEF01234567890123456789012345",
        "00",
        "gggggggggggggggggggggggggggggggg",
    ] {
        fields.platform = "windows";
        fields.file_id = id;
        assert_eq!(page_version_for(&fields), None);
    }
}

#[test]
fn a2_latest_identity_hashes_exact_bytes_and_archives_keep_the_base_wire_shape() {
    use std::os::unix::fs::MetadataExt;
    let scratch = ScratchDir::new("a2-identity");
    let path = scratch.join("page.md");
    std::fs::write(&path, HOSTILE_BRIEFING).unwrap();
    let meta = std::fs::metadata(&path).unwrap();
    let before = tree(&scratch.path);
    let page = read_latest_briefing_at(&path).unwrap();
    let volume = meta.dev().to_string();
    let file_id = meta.ino().to_string();
    let size = meta.len().to_string();
    let mtime =
        (i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec())).to_string();
    let ctime =
        (i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())).to_string();
    let expected = page_version_for(&PageVersionFields {
        platform: "unix",
        volume: &volume,
        file_id: &file_id,
        size: &size,
        mtime_ns: &mtime,
        ctime_ns: &ctime,
    })
    .unwrap();
    // A separately computed literal hash pins UTF-8 and the precise page bytes.
    assert_eq!(
        page.page_hash.as_deref(),
        Some("2157f5ce1cdda52bef9eb0ecabfc84ff61f3202c4e4689fa2a48df1c1ebee595")
    );
    assert_eq!(page.page_version.as_deref(), Some(expected.as_str()));
    assert_eq!(page.text, HOSTILE_BRIEFING);
    assert_eq!(page.bytes, HOSTILE_BRIEFING.len() as u64);
    assert_eq!(tree(&scratch.path), before);
    assert_eq!(
        serde_json::to_string(&read_briefing_at(&path).unwrap()).unwrap(),
        base_wire_bytes(&path)
    );
    // A byte-order mark, CRLF and edge whitespace all count; the literal comes from `shasum -a 256`.
    let edges = scratch.join("edges.md");
    std::fs::write(
        &edges,
        "\u{feff}  \u{2600}\u{fe0f} exact\r\nUTF-8 \u{1f980}\n\n  ",
    )
    .unwrap();
    assert_eq!(
        read_latest_briefing_at(&edges)
            .unwrap()
            .page_hash
            .as_deref(),
        Some("942cb824c16e6b77a7f7afd1c6c16fe321dd8ec0f0bd6665de82ada3bfc04684")
    );
    let replacement = scratch.join("replacement");
    std::fs::write(&replacement, HOSTILE_BRIEFING).unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    let newer = read_latest_briefing_at(&path).unwrap();
    assert_eq!(newer.page_hash, page.page_hash);
    assert_ne!(
        newer.page_version, page.page_version,
        "identical bytes in a different inode reused a version"
    );
}

/// The mtimes are written as literals, so the expected text does not repeat the code's arithmetic:
/// a value past 2^53 keeps its last digit and a pre-epoch value combines seconds and nanoseconds.
#[test]
fn a2_latest_version_carries_exact_timestamps_and_a_touch_changes_only_the_version() {
    use std::os::unix::fs::MetadataExt;
    use std::time::UNIX_EPOCH;
    let scratch = ScratchDir::new("a2-identity-times");
    let path = scratch.join("page.md");
    std::fs::write(&path, HOSTILE_BRIEFING).unwrap();
    let mut seen = Vec::new();
    for (when, literal) in [
        (
            UNIX_EPOCH + Duration::new(1_000_000_000, 123),
            "1000000000000000123",
        ),
        (UNIX_EPOCH - Duration::new(1, 500_000_000), "-1500000000"),
    ] {
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(when)
            .unwrap();
        let meta = std::fs::symlink_metadata(&path).unwrap();
        let volume = meta.dev().to_string();
        let file_id = meta.ino().to_string();
        let size = meta.len().to_string();
        let ctime =
            (i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())).to_string();
        let page = read_latest_briefing_at(&path).unwrap();
        assert_eq!(
            page.page_version,
            page_version_for(&PageVersionFields {
                platform: "unix",
                volume: &volume,
                file_id: &file_id,
                size: &size,
                mtime_ns: literal,
                ctime_ns: &ctime,
            })
        );
        assert_eq!(page.text, HOSTILE_BRIEFING);
        seen.push(page);
    }
    assert_eq!(seen[0].page_hash, seen[1].page_hash);
    assert_ne!(seen[0].page_version, seen[1].page_version);
}

/// The archive read's JSON as the base spelled it: exactly these keys, in this order, as bytes.
fn base_wire_bytes(path: &Path) -> String {
    format!(
        "{{\"path\":{},\"text\":{},\"bytes\":{}}}",
        serde_json::to_string(&path.display().to_string()).unwrap(),
        serde_json::to_string(HOSTILE_BRIEFING).unwrap(),
        HOSTILE_BRIEFING.len(),
    )
}

/// One clause at a time, on real metadata from real files: the read length, the opened file's second
/// stat and the pathname's stat each refuse the identity by themselves, which a live race cannot show
/// because the clauses cover for each other. `is_file` is the exception: a symlink or a directory has
/// its own inode, so those two rows are refused by the inode comparison as well, with or without it.
#[test]
fn a2_each_stability_check_refuses_the_identity_alone() {
    let scratch = ScratchDir::new("a2-identity-stable");
    let page = scratch.join("page.md");
    std::fs::write(&page, HOSTILE_BRIEFING).unwrap();
    let other = scratch.join("other.md");
    std::fs::write(&other, HOSTILE_BRIEFING).unwrap();
    let link = scratch.join("link.md");
    std::os::unix::fs::symlink(&page, &link).unwrap();
    let before = std::fs::symlink_metadata(&page).unwrap();
    let same = std::fs::symlink_metadata(&page).unwrap();
    let different = std::fs::symlink_metadata(&other).unwrap();
    let symlink = std::fs::symlink_metadata(&link).unwrap();
    let directory = std::fs::symlink_metadata(&scratch.path).unwrap();
    let len = before.len();

    let stable = stable_page_version(&before, len, Some(&same), Some(&same));
    assert!(stable.is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())));
    // The read came up short or long of what the first stat promised.
    for read in [len - 1, len + 1, 0] {
        assert_eq!(
            stable_page_version(&before, read, Some(&same), Some(&same)),
            None
        );
    }
    // The opened file changed between its two stats, or the second stat failed.
    assert_eq!(
        stable_page_version(&before, len, Some(&different), Some(&same)),
        None
    );
    assert_eq!(stable_page_version(&before, len, None, Some(&same)), None);
    // The stats agree but the path now names another inode, whatever kind of file, or nothing.
    for current in [&different, &symlink, &directory] {
        assert_eq!(
            stable_page_version(&before, len, Some(&same), Some(current)),
            None
        );
    }
    assert_eq!(stable_page_version(&before, len, Some(&same), None), None);
}

#[test]
fn a2_latest_ipc_sets_identity_and_history_keeps_exact_base_json() {
    let b = browse("a2-identity-ipc");
    let path = b.state.join("briefing-latest.md");
    std::fs::write(&path, HOSTILE_BRIEFING).unwrap();
    let direct = read_latest_briefing_at(&path).unwrap();
    let latest = b.call("read_latest_briefing", json!({})).unwrap();
    assert_eq!(latest, serde_json::to_value(direct).unwrap());
    assert!(latest["pageHash"].as_str().is_some_and(|s| s.len() == 64));
    assert!(latest["pageVersion"]
        .as_str()
        .is_some_and(|s| s.len() == 64));
    let archive_path = b.put("2026-09-15", HOSTILE_BRIEFING.as_bytes());
    // `preserve_order` keeps the wire's key order through the Value, so this compares bytes.
    assert_eq!(
        serde_json::to_string(&b.archived("2026-09-15").unwrap()).unwrap(),
        base_wire_bytes(&archive_path)
    );
}

/// The latest read refuses exactly what the base read refused, in exactly the same words.
#[test]
fn a2_latest_read_keeps_caps_and_refusals() {
    fn refused_like_the_base(path: &Path) -> BriefingError {
        let refusal = read_latest_briefing_at(path).unwrap_err();
        assert_eq!(read_briefing_at(path).unwrap_err(), refusal);
        refusal
    }
    let scratch = ScratchDir::new("a2-identity-refusals");
    let path = scratch.join("page.md");
    assert!(matches!(
        refused_like_the_base(&path),
        BriefingError::NotFound { .. }
    ));
    assert!(matches!(
        refused_like_the_base(&scratch.path),
        BriefingError::Unreadable { .. }
    ));
    std::fs::write(&path, vec![b'a'; MAX_BRIEFING_BYTES as usize]).unwrap();
    assert!(read_latest_briefing_at(&path).unwrap().page_hash.is_some());
    std::fs::write(&path, vec![b'a'; MAX_BRIEFING_BYTES as usize + 1]).unwrap();
    assert!(matches!(
        refused_like_the_base(&path),
        BriefingError::Unreadable { .. }
    ));
    std::fs::write(&path, [0xff]).unwrap();
    assert!(matches!(
        refused_like_the_base(&path),
        BriefingError::Unreadable { .. }
    ));
    std::fs::remove_file(&path).unwrap();
    let target = scratch.join("target");
    std::fs::write(&target, "safe control").unwrap();
    assert!(read_latest_briefing_at(&target)
        .unwrap()
        .page_hash
        .is_some());
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(matches!(
        refused_like_the_base(&path),
        BriefingError::Unreadable { .. }
    ));
    std::fs::remove_file(&path).unwrap();
    let c_path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let reader_path = path.clone();
    assert!(matches!(
        within_or_unblock(&path, "read_latest_briefing_at", move || {
            refused_like_the_base(&reader_path)
        }),
        BriefingError::Unreadable { .. }
    ));
}

#[test]
fn a2_torn_read_has_no_identity() {
    use std::os::unix::fs::FileExt;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let scratch = ScratchDir::new("a2-identity-torn");
    let path = scratch.join("page.md");
    let bytes = vec![b'a'; MAX_BRIEFING_BYTES as usize];
    std::fs::write(&path, &bytes).unwrap();
    assert!(read_latest_briefing_at(&path).unwrap().page_hash.is_some());
    let writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    let stop = AtomicBool::new(false);
    let writes = AtomicUsize::new(0);
    // A deadline rather than a count: a busy machine or a coarse file clock only makes the first
    // refusal arrive later, so it cannot turn this red. The writer has it too: a failed assertion
    // below never reaches `stop`, and the scope would otherwise wait for the writer forever.
    let deadline = Instant::now() + Duration::from_secs(60);
    let torn = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
                // Keep the inode, length and valid UTF-8 constant; only the metadata stability
                // checks can refuse the identity (there is no truncate or pathname replacement).
                writer.write_all_at(&bytes, 0).unwrap();
                writes.fetch_add(1, Ordering::Release);
            }
        });
        while writes.load(Ordering::Acquire) == 0 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        let mut torn = None;
        while torn.is_none() && Instant::now() < deadline {
            let page = read_latest_briefing_at(&path).unwrap();
            assert_eq!(page.text.as_bytes(), bytes);
            if page.page_hash.is_none() {
                torn = Some(page);
            }
        }
        stop.store(true, Ordering::Release);
        torn
    });
    let torn = torn.expect("concurrent writes never caused identity to be refused");
    assert_eq!(torn.page_version, None);
    // Both members are absent from the wire, not null: the page stays usable without a summary.
    let wire = serde_json::to_value(&torn).unwrap();
    assert!(wire.get("pageHash").is_none() && wire.get("pageVersion").is_none());
    assert!(read_latest_briefing_at(&path).unwrap().page_hash.is_some());
}

/// Two directories trade places under the page's pathname: identical bytes, different inodes. The
/// opened file never changes, so only the identity's last check, the pathname's stat, can refuse: a
/// last check that read the descriptor would keep an identity for a file the path no longer names.
#[test]
fn a2_a_parent_directory_swap_has_no_identity() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let scratch = ScratchDir::new("a2-identity-parent-swap");
    let (d, e, tmp) = (scratch.join("d"), scratch.join("e"), scratch.join("tmp"));
    let bytes = vec![b'a'; MAX_BRIEFING_BYTES as usize];
    for dir in [&d, &e] {
        std::fs::create_dir(dir).unwrap();
        std::fs::write(dir.join("page.md"), &bytes).unwrap();
    }
    let path = d.join("page.md");
    let stop = AtomicBool::new(false);
    let swaps = AtomicUsize::new(0);
    // A deadline, as in the torn read: load only delays the first refusal, and a failed assertion
    // below never reaches `stop`, so the swapper would otherwise hold the scope open forever.
    let deadline = Instant::now() + Duration::from_secs(60);
    let refused = std::thread::scope(|scope| {
        scope.spawn(|| {
            while !stop.load(Ordering::Acquire) && Instant::now() < deadline {
                std::fs::rename(&d, &tmp).unwrap();
                std::fs::rename(&e, &d).unwrap();
                std::fs::rename(&tmp, &e).unwrap();
                swaps.fetch_add(1, Ordering::Release);
            }
        });
        while swaps.load(Ordering::Acquire) == 0 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        let mut refused = None;
        while refused.is_none() && Instant::now() < deadline {
            match read_latest_briefing_at(&path) {
                Ok(page) => {
                    assert_eq!(page.text.as_bytes(), bytes);
                    if page.page_hash.is_none() {
                        refused = Some(page);
                    }
                }
                // The moment `d` has moved away and the other has not yet taken its name.
                Err(BriefingError::NotFound { .. }) => {}
                Err(other) => panic!("{other:?}"),
            }
        }
        stop.store(true, Ordering::Release);
        refused
    });
    let refused = refused.expect("a parent directory swap never caused identity to be refused");
    assert_eq!(refused.page_version, None);
    assert!(read_latest_briefing_at(&path).unwrap().page_hash.is_some());
}

/// The source text, because a live race cannot tell a stat that follows a symlink from one that does
/// not. The swap above refuses under either. So does flipping a symlinked parent so the pathname
/// becomes a symlink to the open file: a following stat sees the same file, but a path lookup that
/// lands mid-flip fails with `EINVAL` on macOS (measured), and a failed stat refuses too.
#[test]
fn a2_the_last_check_stats_the_pathname_without_following_it() {
    assert!(include_str!("../src/briefing_files.rs")
        .contains("let current = std::fs::symlink_metadata(path).ok();\n"));
}

#[test]
fn a2_default_windows_has_no_native_identity_edge() {
    let manifest = include_str!("../Cargo.toml");
    let module = include_str!("../src/briefing_files.rs");
    for source in [manifest, module] {
        assert!(!source.contains("windows-sys"));
        assert!(!source.contains("cfg(windows)"));
        assert!(!source.contains("cfg(target_os = \"windows\")"));
    }
    // Open question 3 (a): off unix the identity is `None`, and this is the only such branch.
    assert!(module.contains(
        "#[cfg(not(unix))]\nfn metadata_page_version(_meta: &std::fs::Metadata) -> Option<String> {\n    None\n}\n"
    ));
}
