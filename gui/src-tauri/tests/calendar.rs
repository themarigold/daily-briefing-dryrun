//! v0.3.0 (calendar connection, plan M8) — the Rust side of a calendar LINK, `src/calendar.rs`: the
//! id grammar, the URL's minimal check, the managed link file (folder 0700, file 0600, atomic, no
//! symlink followed, at most ten), its removal, the `calendar` config block's checks, and the three
//! commands driven through REAL IPC on a MockRuntime app built from the shipped handler.
//!
//! ## The sandbox
//!
//! Every path here is under a `ScratchDir`. The state folder is whatever the FAKE engine's
//! `status --json` says (`common::files_sidecar`, the config-save suite's fake), so no command can
//! reach the developer's `~/Library/Application Support/daily-briefing`; candidate configs go to a
//! scratch directory (`ConfigSaver::with_candidate_dir`). Nothing here runs the real engine.
//!
//! ## The URL sentinel
//!
//! [`SENTINEL_URL`] is driven through every refusal, the success path and the `Debug` of the URL
//! type, and [`SENTINEL`] must appear in no answer, no error and no rendered value. Nothing here
//! prints it either: assertion messages show answers only after checking they are clean.

mod common;

use std::path::{Path, PathBuf};

use common::{files_sidecar, ScratchDir};
use daily_briefing_gui_lib::calendar::{
    check_calendar_block, clear_confirmed_owner, current_owner, drop_link_entry, is_calendar_email,
    link_id, link_path, link_url, links_dir, remove_link_file, remove_link_file_as,
    replaces_a_different_url, url_shaped_arg, write_link_file, write_link_file_as, CalendarError, FileRemoval,
    LinkIdRefusal, UrlRefusal, CALENDAR_DIR, LINKS_DIR, LINK_TEMP_PREFIX, MAX_LINKS,
    MAX_LINK_URL_BYTES,
};
use daily_briefing_gui_lib::config_save::{canonical_json, ConfigSaver};
use daily_briefing_gui_lib::engine::{Engine, EngineClient};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow, WebviewWindowBuilder};

const FULL: &str = include_str!("fixtures/config-full.json");

/// A private link that must never be echoed. `.invalid` (RFC 2606): nothing here fetches it anyway.
const SENTINEL_URL: &str =
    "https://calendar.example.invalid/ical/me%40example.com/private-SENTINEL-c4l-0000/basic.ics";
/// The part of [`SENTINEL_URL`] no answer may contain.
const SENTINEL: &str = "SENTINEL-c4l-0000";

/* ── helpers ──────────────────────────────────────────────────────────────────────────────────── */

fn mode_of(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::symlink_metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o7777
}

fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

fn id(value: &str) -> daily_briefing_gui_lib::calendar::LinkId {
    link_id(value).unwrap_or_else(|r| panic!("{value:?} must be a valid id: {r:?}"))
}

fn url(value: &str) -> daily_briefing_gui_lib::calendar::LinkUrl {
    link_url(value).unwrap_or_else(|r| panic!("a valid URL was refused: {r:?}"))
}

/// Everything in `dir` other than the link files themselves — a leftover temp file.
fn leftovers(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .expect("links dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .filter(|n| !n.ends_with(".url"))
        .collect();
    names.sort();
    names
}

/// Panic when `text` carries the sentinel — WITHOUT printing `text`, which would put it in the log.
fn assert_clean(text: &str, what: &str) {
    assert!(
        !text.contains(SENTINEL),
        "{what}: the sentinel URL leaked into an answer (contents withheld so the log stays clean)"
    );
}

fn error_json(e: &CalendarError) -> String {
    serde_json::to_string(e).expect("a CalendarError serialises")
}

/* ── the link id ──────────────────────────────────────────────────────────────────────────────── */

#[test]
fn the_link_id_grammar_is_the_specs_and_macos_is_reserved() {
    for ok in [
        "a",
        "0",
        "work",
        "home-2",
        "9to5",
        "a-",
        "x---y",
        "abcdefghijklmnopqrstuvwxyz012345", // 32: the ceiling
    ] {
        assert!(link_id(ok).is_ok(), "{ok:?} must be admitted");
    }
    let cases: &[(&str, LinkIdRefusal)] = &[
        ("", LinkIdRefusal::Empty),
        ("-work", LinkIdRefusal::BadFirstCharacter),
        ("Work", LinkIdRefusal::BadFirstCharacter),
        (".hidden", LinkIdRefusal::BadFirstCharacter),
        ("/etc", LinkIdRefusal::BadFirstCharacter),
        ("ａ", LinkIdRefusal::BadFirstCharacter), // a fullwidth look-alike
        ("wOrk", LinkIdRefusal::BadCharacter),
        ("a_b", LinkIdRefusal::BadCharacter),
        ("a.url", LinkIdRefusal::BadCharacter),
        ("a/b", LinkIdRefusal::BadCharacter),
        ("a b", LinkIdRefusal::BadCharacter),
        ("a\0b", LinkIdRefusal::BadCharacter),
        ("café", LinkIdRefusal::BadCharacter),
        ("abcdefghijklmnopqrstuvwxyz0123456", LinkIdRefusal::TooLong), // 33
        ("macos", LinkIdRefusal::Reserved),
    ];
    for (value, expected) in cases {
        assert_eq!(link_id(value), Err(*expected), "{value:?}");
        // (The reserved refusal names `macos` on purpose: it is the fixed reserved word, not input.)
        assert!(
            value.is_empty()
                || *expected == LinkIdRefusal::Reserved
                || !expected.message().contains(value),
            "the refusal for {value:?} echoes the value"
        );
    }
    // A URL pasted into the id field is refused, and the refusal does not repeat it.
    let refused = link_id(SENTINEL_URL).expect_err("a URL is not an id");
    assert_clean(refused.message(), "id refusal");
}

/* ── the URL's minimal check ──────────────────────────────────────────────────────────────────── */

#[test]
fn the_url_check_admits_https_and_webcal_and_refuses_the_rest_without_echoing() {
    for ok in [
        SENTINEL_URL,
        "https://calendar.google.com/calendar/ical/me%40gmail.com/private-0123abcd/basic.ics",
        "webcal://p01-calendars.icloud.com/published/2/MTIzNDU2",
        "HTTPS://Outlook.Office365.com/owa/calendar/abc/def/calendar.ics",
        "WebCal://example.com",
        "https://example.com?x=1",
        "https://example.com:443/a",
        "  https://example.com/trailing-newline-from-a-paste\n",
    ] {
        assert!(link_url(ok).is_ok(), "a valid URL was refused");
    }
    let long = format!("https://example.com/{}", "a".repeat(MAX_LINK_URL_BYTES));
    let cases: Vec<(String, UrlRefusal)> = vec![
        (String::new(), UrlRefusal::Empty),
        ("   \n\t".into(), UrlRefusal::Empty),
        (long, UrlRefusal::TooLong),
        (
            SENTINEL_URL.replace("/ical/", "/ical /"),
            UrlRefusal::Whitespace,
        ),
        (
            SENTINEL_URL.replace("/ical/", "/ical\t/"),
            UrlRefusal::Whitespace,
        ),
        (
            SENTINEL_URL.replace("/ical/", "/ical\u{a0}/"),
            UrlRefusal::Whitespace,
        ),
        (
            SENTINEL_URL.replace("/ical/", "/ical\u{7}/"),
            UrlRefusal::ControlCharacter,
        ),
        (
            SENTINEL_URL.replace("/ical/", "/ical\u{202e}/"),
            UrlRefusal::FormatCharacter,
        ),
        (
            SENTINEL_URL.replace("/ical/", "/ical\u{200b}/"),
            UrlRefusal::FormatCharacter,
        ),
        (
            SENTINEL_URL.replace("https://", "http://"),
            UrlRefusal::Scheme,
        ),
        (
            SENTINEL_URL.replace("https://", "ftp://"),
            UrlRefusal::Scheme,
        ),
        (
            SENTINEL_URL.replace("https://", "webcals://"),
            UrlRefusal::Scheme,
        ),
        (SENTINEL_URL.replace("https://", ""), UrlRefusal::Scheme),
        ("httpé://example.com".into(), UrlRefusal::Scheme),
        ("https://".into(), UrlRefusal::NoHost),
        (
            SENTINEL_URL.replace("calendar.example.invalid", ""),
            UrlRefusal::NoHost,
        ),
        ("webcal://?q=1".into(), UrlRefusal::NoHost),
    ];
    for (value, expected) in &cases {
        match link_url(value) {
            Ok(_) => panic!("a malformed URL was admitted (expected {expected:?})"),
            Err(got) => {
                assert_eq!(got, *expected, "the wrong refusal class");
                assert_clean(got.message(), "URL refusal");
            }
        }
    }
}

#[test]
fn the_url_type_never_renders_its_value() {
    let rendered = format!("{:?}", url(SENTINEL_URL));
    assert_clean(&rendered, "LinkUrl's Debug");
    assert_eq!(rendered, "LinkUrl(<redacted>)");
}

/* ── the link file ────────────────────────────────────────────────────────────────────────────── */

#[test]
fn a_written_link_is_exactly_the_url_0600_in_a_0700_folder() {
    let scratch = ScratchDir::new("cal-write");
    // The state folder does not exist yet: the writer creates it.
    let state = scratch.join("state");
    let (path, replaced) =
        write_link_file(&state, &id("work"), &url(&format!("  {SENTINEL_URL}\n")))
            .unwrap_or_else(|e| panic!("the write failed: {}", error_json(&e)));
    assert_eq!(path, state.join("calendar").join("links").join("work.url"));
    assert_eq!(path, link_path(&state, &id("work")));
    assert!(!replaced, "nothing was there to replace");
    assert_eq!(
        std::fs::read(&path).expect("the link file"),
        SENTINEL_URL.as_bytes(),
        "the file must hold the trimmed URL exactly — no surrounding whitespace, no newline"
    );
    assert_eq!(mode_of(&path), 0o600, "the link file must be owner-only");
    assert_eq!(mode_of(&links_dir(&state)), 0o700);
    assert_eq!(mode_of(&state.join(CALENDAR_DIR)), 0o700);
    assert_eq!(leftovers(&links_dir(&state)), Vec::<String>::new());

    // A second write REPLACES, atomically, and says so.
    let (again, replaced) =
        write_link_file(&state, &id("work"), &url("webcal://example.com/next.ics"))
            .unwrap_or_else(|e| panic!("the rewrite failed: {}", error_json(&e)));
    assert_eq!(again, path);
    assert!(replaced);
    assert_eq!(
        std::fs::read_to_string(&path).expect("the link file"),
        "webcal://example.com/next.ics"
    );
    assert_eq!(mode_of(&path), 0o600);
    assert_eq!(leftovers(&links_dir(&state)), Vec::<String>::new());
}

/// A reader racing the writer sees the old URL or the new one in full — never an empty or partial
/// file. The rename is what makes that true; a write-in-place would fail this within a few rounds.
#[test]
fn a_reader_racing_a_rewrite_never_sees_a_partial_file() {
    let scratch = ScratchDir::new("cal-race");
    let state = scratch.join("state");
    let a = format!("https://a.example/{}", "a".repeat(3000));
    let b = format!("https://b.example/{}", "b".repeat(3500));
    write_link_file(&state, &id("work"), &url(&a)).expect("the first write");
    let path = link_path(&state, &id("work"));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader = {
        let (path, stop, a, b) = (path.clone(), stop.clone(), a.clone(), b.clone());
        std::thread::spawn(move || {
            let mut reads = 0u32;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let seen = std::fs::read_to_string(&path).expect("the file is always there");
                assert!(
                    seen == a || seen == b,
                    "a reader saw a partial link file ({} bytes)",
                    seen.len()
                );
                reads += 1;
            }
            reads
        })
    };
    for round in 0..300 {
        let next = if round % 2 == 0 { &b } else { &a };
        write_link_file(&state, &id("work"), &url(next)).expect("a rewrite");
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let reads = reader.join().expect("the reader thread");
    assert!(
        reads > 0,
        "the reader never ran — the race was not exercised"
    );
}

#[test]
fn the_state_folder_may_be_a_symlink_but_calendar_and_links_may_not() {
    let scratch = ScratchDir::new("cal-symlink-dirs");
    // 1. `<state>` itself through a symlink: admitted (macOS's `/var` is one; so may a user's be).
    let real_state = scratch.join("real-state");
    std::fs::create_dir_all(&real_state).expect("real state");
    let linked_state = scratch.join("linked-state");
    std::os::unix::fs::symlink(&real_state, &linked_state).expect("symlink state");
    write_link_file(&linked_state, &id("work"), &url(SENTINEL_URL))
        .unwrap_or_else(|e| panic!("a symlinked state dir was refused: {}", error_json(&e)));
    assert!(real_state.join("calendar/links/work.url").is_file());

    // 2. `<state>/calendar` a symlink: refused, and nothing written through it.
    let state = scratch.join("state-2");
    let elsewhere = scratch.join("elsewhere");
    std::fs::create_dir_all(&state).expect("state");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, state.join(CALENDAR_DIR)).expect("symlink calendar");
    let err = write_link_file(&state, &id("work"), &url(SENTINEL_URL))
        .expect_err("a symlinked calendar folder must be refused");
    assert!(matches!(err, CalendarError::LinkFolder { .. }));
    assert!(error_json(&err).contains("symbolic link"));
    assert_clean(&error_json(&err), "symlinked calendar folder");
    assert_eq!(
        std::fs::read_dir(&elsewhere).expect("elsewhere").count(),
        0,
        "the writer followed the symlink and wrote into its target"
    );

    // 3. `<state>/calendar/links` a symlink: refused, nothing written through it.
    let state = scratch.join("state-3");
    std::fs::create_dir_all(state.join(CALENDAR_DIR)).expect("calendar");
    chmod(&state.join(CALENDAR_DIR), 0o700);
    let target = scratch.join("links-target");
    std::fs::create_dir_all(&target).expect("links target");
    chmod(&target, 0o700);
    std::os::unix::fs::symlink(&target, state.join(CALENDAR_DIR).join(LINKS_DIR))
        .expect("symlink links");
    let err = write_link_file(&state, &id("work"), &url(SENTINEL_URL))
        .expect_err("a symlinked links folder must be refused");
    assert!(matches!(err, CalendarError::LinkFolder { .. }));
    assert_eq!(std::fs::read_dir(&target).expect("target").count(), 0);

    // 4. `<state>/calendar` a FILE: refused, untouched.
    let state = scratch.join("state-4");
    std::fs::create_dir_all(&state).expect("state");
    std::fs::write(state.join(CALENDAR_DIR), "not a folder").expect("a file");
    let err = write_link_file(&state, &id("work"), &url(SENTINEL_URL))
        .expect_err("a file at the calendar folder's name must be refused");
    assert!(matches!(err, CalendarError::LinkFolder { .. }));
    assert_eq!(
        std::fs::read_to_string(state.join(CALENDAR_DIR)).expect("still a file"),
        "not a folder"
    );
}

#[test]
fn a_loose_or_foreign_folder_is_refused_not_repaired() {
    let scratch = ScratchDir::new("cal-loose");
    // A links folder with group/other bits: refused, and its mode is NOT changed.
    let state = scratch.join("state-1");
    let links = state.join(CALENDAR_DIR).join(LINKS_DIR);
    std::fs::create_dir_all(&links).expect("links");
    chmod(&state.join(CALENDAR_DIR), 0o700);
    for loose in [0o755, 0o750, 0o701, 0o710] {
        chmod(&links, loose);
        let err = write_link_file(&state, &id("work"), &url(SENTINEL_URL))
            .expect_err("a loose links folder must be refused");
        assert!(
            matches!(err, CalendarError::LinkFolder { .. }),
            "{loose:o}: {}",
            error_json(&err)
        );
        assert_eq!(mode_of(&links), loose, "the refusal repaired the mode");
        assert!(!links.join("work.url").exists());
    }
    // The calendar folder: world-writable is refused; group-writable (a umask-002 engine) is not.
    let state = scratch.join("state-2");
    std::fs::create_dir_all(state.join(CALENDAR_DIR)).expect("calendar");
    chmod(&state.join(CALENDAR_DIR), 0o777);
    let err = write_link_file(&state, &id("work"), &url(SENTINEL_URL))
        .expect_err("a world-writable calendar folder must be refused");
    assert!(matches!(err, CalendarError::LinkFolder { .. }));
    chmod(&state.join(CALENDAR_DIR), 0o775);
    write_link_file(&state, &id("work"), &url(SENTINEL_URL))
        .unwrap_or_else(|e| panic!("a 0775 calendar folder was refused: {}", error_json(&e)));

    // Another user's folder (the owner check, injected — a real `chown` needs root).
    let me = current_owner().expect("unix has a uid");
    let state = scratch.join("state-3");
    let err = write_link_file_as(&state, &id("work"), &url(SENTINEL_URL), Some(me + 1))
        .expect_err("a folder owned by someone else must be refused");
    assert!(error_json(&err).contains("belongs to another user"));
    assert!(!link_path(&state, &id("work")).exists());
    // …and the same owner check guards a removal.
    write_link_file(&state, &id("work"), &url(SENTINEL_URL)).expect("written as me");
    let err = remove_link_file_as(&state, &id("work"), Some(me + 1))
        .expect_err("removing through another user's folder must be refused");
    assert!(matches!(err, CalendarError::LinkFolder { .. }));
    assert!(link_path(&state, &id("work")).exists());
}

#[test]
fn a_non_regular_file_at_the_link_name_is_refused_and_left_alone() {
    let scratch = ScratchDir::new("cal-nonregular");
    let state = scratch.join("state");
    write_link_file(&state, &id("home"), &url(SENTINEL_URL)).expect("set up the folder");
    let links = links_dir(&state);

    // A symlink at `work.url`, pointing at a file outside: refused; the outside file untouched.
    let outside = scratch.join("outside.txt");
    std::fs::write(&outside, "someone else's file").expect("outside");
    std::os::unix::fs::symlink(&outside, links.join("work.url")).expect("symlink link file");
    let err = write_link_file(&state, &id("work"), &url(SENTINEL_URL))
        .expect_err("a symlink at the link's name must be refused");
    assert!(matches!(err, CalendarError::LinkFile { .. }));
    assert!(error_json(&err).contains("symbolic link"));
    assert_clean(&error_json(&err), "symlinked link file");
    assert_eq!(
        std::fs::read_to_string(&outside).expect("outside"),
        "someone else's file"
    );
    assert!(std::fs::symlink_metadata(links.join("work.url"))
        .expect("still there")
        .file_type()
        .is_symlink());

    // A folder at `team.url`: refused, untouched.
    std::fs::create_dir(links.join("team.url")).expect("a folder");
    let err = write_link_file(&state, &id("team"), &url(SENTINEL_URL))
        .expect_err("a folder at the link's name must be refused");
    assert!(matches!(err, CalendarError::LinkFile { .. }));
    assert!(links.join("team.url").is_dir());
    assert_eq!(leftovers(&links), Vec::<String>::new());
}

#[test]
fn the_eleventh_link_is_refused_and_replacing_one_is_not() {
    let scratch = ScratchDir::new("cal-eleven");
    let state = scratch.join("state");
    for n in 0..MAX_LINKS {
        write_link_file(&state, &id(&format!("link-{n}")), &url(SENTINEL_URL))
            .unwrap_or_else(|e| panic!("link {n}: {}", error_json(&e)));
    }
    let links = links_dir(&state);
    // Names that are NOT link files do not count: not the grammar, reserved, or not `.url`.
    for name in [
        "README",
        "macos.url",
        "Bad.url",
        "notes.txt",
        ".link-save-x",
    ] {
        std::fs::write(links.join(name), "x").expect("a non-link name");
    }
    let err = write_link_file(&state, &id("one-more"), &url(SENTINEL_URL))
        .expect_err("an eleventh link must be refused");
    assert_eq!(err, CalendarError::TooManyLinks { limit: MAX_LINKS });
    assert!(!links.join("one-more.url").exists());
    // Replacing one of the ten is not a new link.
    let (_, replaced) = write_link_file(&state, &id("link-3"), &url("https://example.com/new"))
        .unwrap_or_else(|e| panic!("replacing link-3 was refused: {}", error_json(&e)));
    assert!(replaced);
}

#[test]
fn stale_temp_files_of_this_module_are_swept_and_nothing_else() {
    let scratch = ScratchDir::new("cal-sweep");
    let state = scratch.join("state");
    write_link_file(&state, &id("work"), &url(SENTINEL_URL)).expect("set up");
    let links = links_dir(&state);
    let mine = format!("{LINK_TEMP_PREFIX}{}-7", std::process::id());
    let dead = format!("{LINK_TEMP_PREFIX}999999-1");
    let foreign = [".link-save-abc-1", ".other-save-1-1", "keep-me.txt"];
    for name in [mine.as_str(), dead.as_str()].into_iter().chain(foreign) {
        std::fs::write(links.join(name), "stale").expect("plant");
    }
    write_link_file(&state, &id("work"), &url(SENTINEL_URL)).expect("a write sweeps");
    assert!(
        !links.join(&mine).exists(),
        "this process's stale temp file must go"
    );
    // pid 999999 is (almost certainly) not running; if it is, the sweep rightly keeps its file.
    if common::process_gone("999999") {
        assert!(
            !links.join(&dead).exists(),
            "a dead writer's temp file must go"
        );
    }
    for name in foreign {
        assert!(
            links.join(name).exists(),
            "{name} is not this module's and must survive"
        );
    }
}

/* ── removal ──────────────────────────────────────────────────────────────────────────────────── */

#[test]
fn removal_takes_the_file_is_idempotent_and_never_follows_a_link() {
    let scratch = ScratchDir::new("cal-remove");
    let state = scratch.join("state");
    // No calendar folder at all: absent, nothing created.
    assert_eq!(
        remove_link_file(&state, &id("work")).expect("absent"),
        FileRemoval::Absent
    );
    assert!(!state.join(CALENDAR_DIR).exists());

    write_link_file(&state, &id("work"), &url(SENTINEL_URL)).expect("written");
    let stale = links_dir(&state).join(format!("{LINK_TEMP_PREFIX}{}-9", std::process::id()));
    std::fs::write(&stale, SENTINEL_URL).expect("a stale temp holding a URL");
    assert_eq!(
        remove_link_file(&state, &id("work")).expect("removed"),
        FileRemoval::Removed
    );
    assert!(!link_path(&state, &id("work")).exists());
    assert!(
        !stale.exists(),
        "a stale temp file may hold a URL and is swept by a removal too"
    );
    assert_eq!(
        remove_link_file(&state, &id("work")).expect("again"),
        FileRemoval::Absent
    );

    // A symlink at the name is unlinked, never followed.
    let outside = scratch.join("outside.txt");
    std::fs::write(&outside, "keep").expect("outside");
    std::os::unix::fs::symlink(&outside, links_dir(&state).join("team.url")).expect("symlink");
    assert_eq!(
        remove_link_file(&state, &id("team")).expect("the link goes"),
        FileRemoval::Removed
    );
    assert_eq!(std::fs::read_to_string(&outside).expect("outside"), "keep");

    // A folder at the name is refused.
    std::fs::create_dir(links_dir(&state).join("dir.url")).expect("a folder");
    assert!(matches!(
        remove_link_file(&state, &id("dir")),
        Err(CalendarError::LinkFile { .. })
    ));
    assert!(links_dir(&state).join("dir.url").is_dir());

    // A symlinked links folder is refused: nothing is removed through it.
    let state = scratch.join("state-2");
    std::fs::create_dir_all(state.join(CALENDAR_DIR)).expect("calendar");
    let target = scratch.join("target");
    std::fs::create_dir_all(&target).expect("target");
    std::fs::write(target.join("work.url"), "x").expect("a file behind the link");
    std::os::unix::fs::symlink(&target, state.join(CALENDAR_DIR).join(LINKS_DIR))
        .expect("symlink links");
    assert!(matches!(
        remove_link_file(&state, &id("work")),
        Err(CalendarError::LinkFolder { .. })
    ));
    assert!(target.join("work.url").exists());
}

/* ── the config block ─────────────────────────────────────────────────────────────────────────── */

/// The block check is the engine resolver's acceptance rules (W1's `src/calendar/config.ts`, which is
/// all-or-nothing: one bad key switches the whole calendar off) plus the URL guard. Every case below
/// is one the resolver treats the same way — admitted, or malformed — except the `url` guard, which
/// is stricter here by design (the resolver SKIPS a link carrying `url`; this app never writes one).
#[test]
fn the_calendar_block_check_is_the_resolvers_acceptance_rules_plus_the_url_guard() {
    // The cases are a SHARED fixture (`tests/fixtures/calendar_block_cases.json`): the engine's own
    // `resolveCalendar` replays the same file in `gui/tests-web/calendar.check.ts`, so a block admitted
    // here is one the resolver keeps whole, and a refusal here is one it switches off (or, for the
    // per-link `url` guard, skips) — the mirror cannot drift from the authority unnoticed.
    let text = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/calendar_block_cases.json"),
    )
    .expect("the shared block-case fixture");
    // The fixture's URL cases carry THIS sentinel, so `assert_clean` below is not vacuous.
    assert!(text.contains(SENTINEL_URL), "the fixture lost the sentinel URL");
    let fixture: Value = serde_json::from_str(&text).expect("JSON");
    let accept = fixture["accept"].as_array().expect("accept[]");
    let refuse = fixture["refuse"].as_array().expect("refuse[]");
    assert!(accept.len() >= 9 && refuse.len() >= 59, "the fixture shrank");
    for fine in accept {
        check_calendar_block(fine)
            .unwrap_or_else(|e| panic!("{fine} was refused: {}", error_json(&e)));
    }
    // The cap case really is one over the cap.
    assert!(refuse.iter().any(|c| c["kind"] == "tooManyLinks"
        && c["block"]["links"].as_array().map(Vec::len) == Some(MAX_LINKS + 1)));
    for case in refuse {
        let (block, kind) = (&case["block"], case["kind"].as_str().expect("kind"));
        let err = match check_calendar_block(block) {
            Err(err) => err,
            Ok(()) => panic!("a block the resolver refuses was admitted (expected {kind})"),
        };
        let rendered = error_json(&err);
        assert_clean(&rendered, kind);
        let got: Value = serde_json::from_str(&rendered).expect("JSON");
        assert_eq!(got["kind"], kind, "{rendered}");
    }
    // The position is named, the value never is.
    let err = check_calendar_block(
        &json!({ "links": [{ "id": "a" }, { "id": "b", "name": SENTINEL_URL }] }),
    )
    .expect_err("refused");
    assert_eq!(
        err,
        CalendarError::UrlInConfig {
            field: "links[1].name".into()
        }
    );
    // Final harden r2: the position is a FIXED schema position — a key that is itself the URL is
    // never copied into it (the old position walked every key on the way down).
    for (block, field) in [
        (json!({ "macos": { SENTINEL_URL: [{ "url": 1 }] } }), "macos"),
        (json!({ SENTINEL_URL: { "Url": 1 } }), "calendar"),
        (json!({ "URL": SENTINEL_URL }), "url"),
        (json!({ "links": [{ "id": "a" }, { "id": "b", SENTINEL_URL: { "uRl": 1 } }] }), "links[1]"),
        (json!({ "links": [{ "id": "a", "url": SENTINEL_URL }] }), "links[0].url"),
        (json!({ "links": [{ "id": "a", "urlCommand": ["echo", SENTINEL_URL] }] }), "links[0].urlCommand"),
    ] {
        let err = check_calendar_block(&block).expect_err("refused");
        assert_clean(&error_json(&err), field);
        assert_eq!(err, CalendarError::UrlInConfig { field: field.into() });
    }
    // A `url` nested far deeper than the engine's old 16-level walk is still found.
    let mut deep = json!({ "url": 1 });
    for _ in 0..40 {
        deep = json!([deep]);
    }
    assert_eq!(
        check_calendar_block(&json!({ "macos": { "x": deep } })),
        Err(CalendarError::UrlInConfig { field: "macos".into() })
    );
    // A duplicate's id passed the grammar, so it may be named.
    assert_eq!(
        check_calendar_block(&json!({ "links": [{ "id": "work" }, { "id": "work" }] })),
        Err(CalendarError::DuplicateId { id: "work".into() })
    );
}

/// The resolver's `email()` — trimmed, lower-cased, ≤ 254 UTF-16 units, no control character, one
/// `@`, a dotted domain, none of whitespace or `@ / \ : < > ( ) [ ] , ; " '`.
#[test]
fn the_email_rule_is_the_resolvers() {
    for ok in [
        "me@example.com",
        "  ME@Example.COM ",
        "first.last+tag@sub.example.co.uk",
        "a@b.c",
        "a@.b.c",
        "x@y..z",
        "ü@exämple.de",
    ] {
        assert!(is_calendar_email(ok), "{ok:?} must be an address");
    }
    let long = format!("{}@example.com", "a".repeat(243)); // 255 units
    for bad in [
        "",
        "me",
        "me@",
        "@example.com",
        "me@example",
        "me@example.",
        "me@@example.com",
        "me@exa mple.com",
        "me@example.com/x",
        "me:you@example.com",
        "<me@example.com>",
        "\"me\"@example.com",
        "me@example.com\u{85}",
        "me@exam\u{feff}ple.com",
        // Final harden r2: what the engine's `cleanEmail` strips (and so `calendarEmail` refuses).
        "me\u{200b}@example.com",
        "me\u{ad}@example.com",
        "\u{202e}me@example.com",
        "me@exam\u{2060}ple.com",
        "me@example.com\u{e0041}",
        "me\u{1d173}@example.com",
        long.as_str(),
    ] {
        assert!(!is_calendar_email(bad), "{bad:?} must not be an address");
    }
    assert!(
        is_calendar_email(&format!("{}@example.com", "a".repeat(242))),
        "254 units is the ceiling"
    );
}

#[test]
fn clearing_a_confirmation_touches_only_that_entrys_confirmed_owner() {
    let mut config = json!({
        "a": 1,
        "calendar": { "links": [
            { "id": "work", "name": "W", "confirmedOwner": "me@x.com", "owner": "me@x.com" },
            { "id": "home", "confirmedOwner": "me@y.com" }
        ] }
    });
    assert!(clear_confirmed_owner(&mut config, &id("work")));
    assert_eq!(
        config,
        json!({ "a": 1, "calendar": { "links": [
            { "id": "work", "name": "W", "owner": "me@x.com" },
            { "id": "home", "confirmedOwner": "me@y.com" }
        ] } })
    );
    // Key ORDER is kept (no swap-remove): `owner` still follows `name`.
    let keys: Vec<&String> = config["calendar"]["links"][0]
        .as_object()
        .expect("an object")
        .keys()
        .collect();
    assert_eq!(keys, ["id", "name", "owner"]);
    assert!(
        !clear_confirmed_owner(&mut config, &id("work")),
        "nothing left to clear"
    );
    assert!(!clear_confirmed_owner(&mut json!({ "a": 1 }), &id("work")));
}

#[test]
fn only_a_different_url_counts_as_replacing_one() {
    let scratch = ScratchDir::new("cal-differs");
    let state = scratch.join("state");
    assert!(
        !replaces_a_different_url(&state, &id("work"), &url(SENTINEL_URL)),
        "no file yet: a new link replaces nothing"
    );
    write_link_file(&state, &id("work"), &url(SENTINEL_URL)).expect("written");
    assert!(
        !replaces_a_different_url(&state, &id("work"), &url(&format!(" {SENTINEL_URL}\n"))),
        "the same URL (as pasted) is not a replacement"
    );
    assert!(replaces_a_different_url(
        &state,
        &id("work"),
        &url("https://example.com/other.ics")
    ));
    // A file that is not readable as a URL counts as different — the confirmation goes.
    std::fs::write(link_path(&state, &id("work")), [0xff, 0xfe]).expect("not UTF-8");
    assert!(replaces_a_different_url(
        &state,
        &id("work"),
        &url(SENTINEL_URL)
    ));
}

#[test]
fn dropping_a_link_entry_touches_only_that_entry() {
    let mut config = json!({
        "a": 1,
        "calendar": { "enabled": true, "links": [{ "id": "work" }, { "id": "home", "name": "H" }] },
        "z": [1, 2]
    });
    drop_link_entry(&mut config, &id("work"));
    assert_eq!(
        config,
        json!({ "a": 1, "calendar": { "enabled": true, "links": [{ "id": "home", "name": "H" }] }, "z": [1, 2] })
    );
    let before = config.clone();
    drop_link_entry(&mut config, &id("absent"));
    assert_eq!(config, before, "no such entry: nothing changes");
    let mut no_block = json!({ "a": 1 });
    drop_link_entry(&mut no_block, &id("work"));
    assert_eq!(no_block, json!({ "a": 1 }));
}

/* ── through real IPC ─────────────────────────────────────────────────────────────────────────── */

struct Sandbox {
    state: PathBuf,
    config: PathBuf,
    record: PathBuf,
    webview: WebviewWindow<MockRuntime>,
    _app: App<MockRuntime>,
    _scratch: ScratchDir,
}

/// A mock app around the SHIPPED handler, its engine a `files_sidecar` reporting a scratch state
/// folder and a scratch config path (holding `initial`, or nothing).
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
    let program = files_sidecar(&scratch.path, "engine.sh", &state, &config, &record);
    let app = mock_builder()
        .manage(Engine(Ok(EngineClient::with_program(program))))
        .manage(ConfigSaver::with_candidate_dir(
            scratch.join("app-data").join("config-candidates"),
        ))
        .invoke_handler(daily_briefing_gui_lib::handler())
        .build(tauri::generate_context!())
        .expect("mock app");
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("main webview");
    Sandbox {
        state,
        config,
        record,
        webview,
        _app: app,
        _scratch: scratch,
    }
}

impl Sandbox {
    /// The answer as JSON TEXT, Ok or Err — what the webview would receive either way.
    fn call(&self, cmd: &str, body: Value) -> Result<Value, String> {
        let request = InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        };
        match get_ipc_response(&self.webview, request) {
            Ok(body) => Ok(body.deserialize().expect("a JSON response")),
            Err(e) => Err(e
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| e.to_string())),
        }
    }

    /// Every argv the fake engine received, one token per line.
    fn argv(&self) -> String {
        std::fs::read_to_string(self.record.join("argv.txt")).unwrap_or_default()
    }

    fn on_disk(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.config).expect("config")).expect("JSON")
    }
}

#[test]
fn the_link_write_command_writes_under_the_engines_state_dir_and_echoes_nothing() {
    let s = sandbox("cal-ipc-write", None);
    let answer = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": SENTINEL_URL }),
        )
        .unwrap_or_else(|e| {
            assert_clean(&e, "write error");
            panic!("the write failed: {e}")
        });
    assert_clean(&answer.to_string(), "write answer");
    assert_eq!(answer["id"], "work");
    assert_eq!(answer["replaced"], false);
    let path = s.state.join("calendar/links/work.url");
    assert_eq!(answer["path"], path.display().to_string());
    assert_eq!(std::fs::read(&path).expect("file"), SENTINEL_URL.as_bytes());
    assert_eq!(mode_of(&path), 0o600);
    // The one engine call was the state-dir read; the URL reached no argv.
    assert_eq!(s.argv(), "status\n--json\n");
    assert_clean(&s.argv(), "engine argv");
}

/// Every way the write command can refuse, each answered without the URL — and the operand
/// refusals before ANY spawn.
#[test]
fn every_refusal_of_the_link_write_is_clean_and_operand_refusals_spawn_nothing() {
    let s = sandbox("cal-ipc-refuse", None);
    let operand_cases: Vec<(Value, &str)> = vec![
        (
            json!({ "id": SENTINEL_URL, "url": SENTINEL_URL }),
            "invalidId",
        ),
        (json!({ "id": "macos", "url": SENTINEL_URL }), "invalidId"),
        (
            json!({ "id": "work", "url": SENTINEL_URL.replace("https", "http") }),
            "invalidUrl",
        ),
        (
            json!({ "id": "work", "url": format!("{SENTINEL_URL} trailing") }),
            "invalidUrl",
        ),
        (
            json!({ "id": "work", "url": format!("{SENTINEL_URL}\u{0}") }),
            "invalidUrl",
        ),
        (
            json!({ "id": "work", "url": SENTINEL_URL.replace("calendar.example.invalid", "") }),
            "invalidUrl",
        ),
    ];
    for (body, kind) in &operand_cases {
        let e = s
            .call("calendar_link_write", body.clone())
            .expect_err("refused");
        assert_clean(&e, kind);
        let err: Value = serde_json::from_str(&e).expect("a serialised CalendarError");
        assert_eq!(err["kind"], *kind, "{e}");
    }
    assert_eq!(s.argv(), "", "an operand refusal reached the engine");

    // Filesystem refusals: a symlinked links folder, a symlink at the name, the eleventh link.
    let calendar = s.state.join(CALENDAR_DIR);
    std::fs::create_dir_all(&calendar).expect("calendar");
    chmod(&calendar, 0o700);
    let elsewhere = s.state.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    std::os::unix::fs::symlink(&elsewhere, calendar.join(LINKS_DIR)).expect("symlink links");
    let e = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": SENTINEL_URL }),
        )
        .expect_err("a symlinked links folder is refused");
    assert_clean(&e, "linkFolder");
    assert!(e.contains("\"linkFolder\""), "{e}");
    std::fs::remove_file(calendar.join(LINKS_DIR)).expect("unlink");
    std::fs::create_dir(calendar.join(LINKS_DIR)).expect("a real links folder");
    chmod(&calendar.join(LINKS_DIR), 0o700);
    std::os::unix::fs::symlink(&elsewhere, calendar.join(LINKS_DIR).join("work.url"))
        .expect("symlink at the name");
    let e = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": SENTINEL_URL }),
        )
        .expect_err("a symlink at the name is refused");
    assert_clean(&e, "linkFile");
    assert!(e.contains("\"linkFile\""), "{e}");
    for n in 0..MAX_LINKS {
        std::fs::write(calendar.join(LINKS_DIR).join(format!("l{n}.url")), "x").expect("a link");
    }
    let e = s
        .call(
            "calendar_link_write",
            json!({ "id": "eleven", "url": SENTINEL_URL }),
        )
        .expect_err("the eleventh link is refused");
    assert_clean(&e, "tooManyLinks");
    assert!(e.contains("\"tooManyLinks\""), "{e}");
    assert_eq!(
        std::fs::read_dir(&elsewhere).expect("elsewhere").count(),
        0,
        "something was written through a symlink"
    );
}

/// The block save goes through the one config-write path: every OTHER field of the full fixture is
/// preserved byte for byte in the canonical form, the block is appended (or replaced in place),
/// the engine validated exactly the bytes written, and `.bak` holds the previous file.
#[test]
fn the_block_save_preserves_every_other_field_byte_for_byte() {
    let s = sandbox("cal-ipc-config", Some(FULL));
    let block = json!({
        "enabled": true,
        "emails": ["me@example.com"],
        "links": [{ "id": "work", "name": "Work (Outlook)", "owner": "me@work.example" }]
    });
    let answer = s
        .call("calendar_config_save", json!({ "text": block.to_string() }))
        .unwrap_or_else(|e| panic!("the block save failed: {e}"));
    assert_eq!(answer["kind"], "saved", "{answer}");

    let written = std::fs::read_to_string(&s.config).expect("config");
    let mut expected: Value = serde_json::from_str(FULL).expect("fixture");
    expected
        .as_object_mut()
        .expect("an object")
        .insert("calendar".into(), block.clone());
    assert_eq!(
        written,
        canonical_json(&expected),
        "the save must be the fixture, byte for byte, with the calendar block appended"
    );
    // Removing the block again gives back the fixture's own bytes: nothing else moved.
    let mut without: Value = serde_json::from_str(&written).expect("JSON");
    without.as_object_mut().expect("object").remove("calendar");
    assert_eq!(canonical_json(&without), FULL);
    assert_eq!(
        std::fs::read_to_string(s.config.with_file_name("config.json.bak")).expect(".bak"),
        FULL
    );
    assert_eq!(
        std::fs::read_to_string(s.record.join("validated-0.json")).expect("validated"),
        written,
        "the engine validated something other than what was written"
    );

    // A second save REPLACES the block in place: its position does not move.
    let changed = json!({ "enabled": false, "links": [] });
    let answer = s
        .call(
            "calendar_config_save",
            json!({ "text": changed.to_string() }),
        )
        .unwrap_or_else(|e| panic!("the second save failed: {e}"));
    assert_eq!(answer["kind"], "saved", "{answer}");
    let keys =
        |v: &Value| -> Vec<String> { v.as_object().expect("object").keys().cloned().collect() };
    assert_eq!(keys(&s.on_disk()), keys(&expected));
    assert_eq!(s.on_disk()["calendar"], changed);
    // And saving the same block again writes nothing.
    let answer = s
        .call(
            "calendar_config_save",
            json!({ "text": changed.to_string() }),
        )
        .unwrap_or_else(|e| panic!("the no-op save failed: {e}"));
    assert_eq!(answer["kind"], "unchanged", "{answer}");
}

#[test]
fn the_block_save_refuses_a_url_or_a_bad_id_before_any_spawn() {
    let s = sandbox("cal-ipc-config-refuse", Some(FULL));
    for (block, kind) in [
        (
            json!({ "links": [{ "id": "work", "url": SENTINEL_URL }] }),
            "urlInConfig",
        ),
        (
            json!({ "links": [{ "id": "work", "name": SENTINEL_URL }] }),
            "urlInConfig",
        ),
        (json!({ "links": [{ "id": "macos" }] }), "invalidId"),
        (
            json!({ "links": [{ "id": "a" }, { "id": "a" }] }),
            "duplicateId",
        ),
        (json!(["not", "an", "object"]), "invalidBlock"),
    ] {
        let e = s
            .call("calendar_config_save", json!({ "text": block.to_string() }))
            .expect_err("refused");
        assert_clean(&e, kind);
        let err: Value = serde_json::from_str(&e).expect("a serialised CalendarError");
        assert_eq!(err["kind"], kind, "{e}");
    }
    // Not JSON: the save pipeline's own error, wrapped.
    let e = s
        .call("calendar_config_save", json!({ "text": "{ not json" }))
        .expect_err("refused");
    let err: Value = serde_json::from_str(&e).expect("JSON");
    assert_eq!(err["kind"], "config");
    assert_eq!(err["error"]["kind"], "notJson");
    assert_eq!(s.argv(), "", "a refused block reached the engine");
    assert_eq!(std::fs::read_to_string(&s.config).expect("config"), FULL);
}

#[test]
fn the_remove_command_takes_the_file_and_the_entry_and_is_idempotent() {
    let mut initial: Value = serde_json::from_str(FULL).expect("fixture");
    initial.as_object_mut().expect("object").insert(
        "calendar".into(),
        json!({ "enabled": true, "links": [{ "id": "work", "name": "W" }, { "id": "home" }] }),
    );
    let initial_text = canonical_json(&initial);
    let s = sandbox("cal-ipc-remove", Some(&initial_text));
    s.call(
        "calendar_link_write",
        json!({ "id": "work", "url": SENTINEL_URL }),
    )
    .unwrap_or_else(|e| panic!("set up: {e}"));
    let path = s.state.join("calendar/links/work.url");
    assert!(path.exists());

    let answer = s
        .call("calendar_link_remove", json!({ "id": "work" }))
        .unwrap_or_else(|e| panic!("the remove failed: {e}"));
    assert_clean(&answer.to_string(), "remove answer");
    assert_eq!(answer["file"], "removed", "{answer}");
    assert_eq!(answer["config"]["kind"], "saved", "{answer}");
    assert!(!path.exists());
    let mut expected = initial.clone();
    expected["calendar"]["links"] = json!([{ "id": "home" }]);
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        canonical_json(&expected),
        "only the work entry may change"
    );

    let answer = s
        .call("calendar_link_remove", json!({ "id": "work" }))
        .unwrap_or_else(|e| panic!("the second remove failed: {e}"));
    assert_eq!(answer["file"], "absent", "{answer}");
    assert_eq!(answer["config"]["kind"], "unchanged", "{answer}");

    // An id that fails the grammar is refused before any engine call.
    let before = s.argv();
    let e = s
        .call("calendar_link_remove", json!({ "id": "../config" }))
        .expect_err("refused");
    assert!(e.contains("\"invalidId\""), "{e}");
    assert_eq!(s.argv(), before);
}

#[test]
fn removing_a_link_with_no_config_file_reports_no_config_step() {
    let s = sandbox("cal-ipc-remove-noconfig", None);
    s.call(
        "calendar_link_write",
        json!({ "id": "work", "url": SENTINEL_URL }),
    )
    .unwrap_or_else(|e| panic!("set up: {e}"));
    let answer = s
        .call("calendar_link_remove", json!({ "id": "work" }))
        .unwrap_or_else(|e| panic!("the remove failed: {e}"));
    assert_eq!(answer["file"], "removed", "{answer}");
    assert_eq!(answer["config"], Value::Null, "{answer}");
    assert!(!s.state.join("calendar/links/work.url").exists());
}

/// Spec §4.2 / the hub brief: a replaced link never inherits its confirmation. A DIFFERENT URL
/// written over an existing one removes that link's `confirmedOwner` first; the same URL again, a
/// new link, or a link without a confirmation touches no config.
#[test]
fn replacing_a_links_url_clears_its_confirmed_owner_and_nothing_else() {
    let mut initial: Value = serde_json::from_str(FULL).expect("fixture");
    initial.as_object_mut().expect("object").insert(
        "calendar".into(),
        json!({ "enabled": true, "links": [
            { "id": "work", "name": "W", "confirmedOwner": "me@example.com" },
            { "id": "home", "confirmedOwner": "me@home.example" }
        ] }),
    );
    let initial_text = canonical_json(&initial);
    let s = sandbox("cal-ipc-confirm", Some(&initial_text));

    // A NEW link (no file yet): no config edit, confirmation kept.
    let answer = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": SENTINEL_URL }),
        )
        .unwrap_or_else(|e| panic!("first write: {e}"));
    assert_eq!(answer["confirmationCleared"], false, "{answer}");
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        initial_text
    );
    // The SAME URL again: still not a replacement.
    let answer = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": format!("{SENTINEL_URL}\n") }),
        )
        .unwrap_or_else(|e| panic!("same-URL write: {e}"));
    assert_eq!(answer["confirmationCleared"], false, "{answer}");
    assert_eq!(answer["replaced"], true, "{answer}");
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        initial_text
    );

    // A DIFFERENT URL: the work link's confirmation goes, and only that.
    let answer = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": "https://example.com/someone-else.ics" }),
        )
        .unwrap_or_else(|e| panic!("replacing write: {e}"));
    assert_clean(&answer.to_string(), "replace answer");
    assert_eq!(answer["confirmationCleared"], true, "{answer}");
    let mut expected = initial.clone();
    expected["calendar"]["links"][0] = json!({ "id": "work", "name": "W" });
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        canonical_json(&expected)
    );
    assert_eq!(
        std::fs::read_to_string(s.state.join("calendar/links/work.url")).expect("file"),
        "https://example.com/someone-else.ics"
    );
    // Replacing again: nothing left to clear, no write.
    let answer = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": "https://example.com/third.ics" }),
        )
        .unwrap_or_else(|e| panic!("third write: {e}"));
    assert_eq!(answer["confirmationCleared"], false, "{answer}");
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        canonical_json(&expected)
    );
}

/// Fix-round 1: the 10-link limit is checked BEFORE the confirmation clear. With ten OTHER link files
/// on disk, replacing `work`'s URL is refused as `tooManyLinks` — and the config, with `work`'s
/// `confirmedOwner`, is left exactly as it was (the old order cleared it, then failed the write).
#[test]
fn the_link_limit_refuses_before_any_confirmation_is_cleared() {
    let mut initial: Value = serde_json::from_str(FULL).expect("fixture");
    initial.as_object_mut().expect("object").insert(
        "calendar".into(),
        json!({ "enabled": true, "links": [
            { "id": "work", "confirmedOwner": "me@example.com" }
        ] }),
    );
    let initial_text = canonical_json(&initial);
    let s = sandbox("cal-ipc-limit-first", Some(&initial_text));
    s.call(
        "calendar_link_write",
        json!({ "id": "work", "url": SENTINEL_URL }),
    )
    .unwrap_or_else(|e| panic!("set up: {e}"));
    let links = s.state.join("calendar/links");
    for i in 0..MAX_LINKS {
        let p = links.join(format!("l{i}.url"));
        std::fs::write(&p, "https://example.com/x.ics").expect("other link file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).expect("mode");
        }
    }
    let e = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": "https://example.com/someone-else.ics" }),
        )
        .expect_err("refused by the limit");
    assert!(e.contains("\"tooManyLinks\""), "{e}");
    assert!(!e.contains("confirmationCleared\":true"), "{e}");
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        initial_text,
        "the confirmation must survive a refused write"
    );
    assert_eq!(
        std::fs::read_to_string(links.join("work.url")).expect("file"),
        SENTINEL_URL
    );
}

/// M8 checkpoint (LOW): THE ORDER IS PINNED, NOT JUST DOCUMENTED. The confirmation is cleared
/// BEFORE the new file goes in place, so a config edit that FAILS must leave the OLD URL standing,
/// with its confirmation. The fault: a directory at `config.json.bak`, which the save pipeline
/// refuses to replace (`SaveError::BackupNotAFile`) before it touches the config. A writer that put
/// the file in place first (the reviewer's mutation: `write_link_file` moved above the clear) would
/// leave the NEW URL behind a confirmation of the old one's address — this test then fails.
#[test]
fn a_failed_confirmation_clear_leaves_the_old_url_and_its_confirmation_standing() {
    let mut initial: Value = serde_json::from_str(FULL).expect("fixture");
    initial.as_object_mut().expect("object").insert(
        "calendar".into(),
        json!({ "enabled": true, "links": [{ "id": "work", "confirmedOwner": "me@example.com" }] }),
    );
    let initial_text = canonical_json(&initial);
    let s = sandbox("cal-ipc-order", Some(&initial_text));
    s.call("calendar_link_write", json!({ "id": "work", "url": SENTINEL_URL }))
        .unwrap_or_else(|e| panic!("first write: {e}"));
    let file = s.state.join("calendar/links/work.url");
    assert!(std::fs::read_to_string(&file).expect("file") == SENTINEL_URL, "the first write");

    // The fault: the config edit cannot complete.
    let backup = s.config.with_file_name("config.json.bak");
    std::fs::create_dir(&backup).expect("a directory at the backup name");
    let err = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": "https://example.com/someone-else.ics" }),
        )
        .expect_err("the clear failed, so the write must fail");
    assert_clean(&err, "failed-clear refusal");
    assert!(err.contains("backupNotAFile"), "{err}");
    assert!(
        std::fs::read_to_string(&file).expect("file") == SENTINEL_URL,
        "the new URL went in place although its confirmation clear failed"
    );
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        initial_text,
        "the config changed although its edit failed"
    );
    assert!(leftovers(&s.state.join("calendar/links")).is_empty());

    // The fault removed: the same write now clears the confirmation and replaces the file.
    std::fs::remove_dir(&backup).expect("remove the fault");
    let answer = s
        .call(
            "calendar_link_write",
            json!({ "id": "work", "url": "https://example.com/someone-else.ics" }),
        )
        .unwrap_or_else(|e| panic!("retried write: {e}"));
    assert_eq!(answer["confirmationCleared"], true, "{answer}");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "https://example.com/someone-else.ics"
    );
}

/// W2 fixer (LOW): the clear goes FIRST, so a file write that then fails has already changed the
/// config. The error must say so (`confirmationCleared: true`, wrapping the write's own refusal) so
/// Settings reloads the form instead of saving its stale base back. The fault: a links folder the
/// writer cannot create its temp file in (mode 0500 — owner-only, so the folder checks pass), so the
/// write fails after the clear succeeded. (Until fix-round 1 the fault was ten OTHER link files; the
/// limit is now checked BEFORE the clear — `the_link_limit_refuses_before_any_confirmation_is_cleared`.)
#[test]
fn a_write_that_fails_after_the_clear_says_the_config_changed() {
    let mut initial: Value = serde_json::from_str(FULL).expect("fixture");
    initial.as_object_mut().expect("object").insert(
        "calendar".into(),
        json!({ "enabled": true, "links": [{ "id": "work", "confirmedOwner": "me@example.com" }] }),
    );
    let initial_text = canonical_json(&initial);
    let s = sandbox("cal-ipc-clr", Some(&initial_text));
    s.call("calendar_link_write", json!({ "id": "work", "url": SENTINEL_URL }))
        .unwrap_or_else(|e| panic!("first write: {e}"));
    let links = s.state.join("calendar/links");
    chmod(&links, 0o500);
    let err = s.call(
        "calendar_link_write",
        json!({ "id": "work", "url": "https://example.com/someone-else.ics" }),
    );
    chmod(&links, 0o700);
    let err = err.expect_err("the temp file cannot be created");
    assert_clean(&err, "write-after-clear refusal");
    let got: Value = serde_json::from_str(&err).expect("a serialised CalendarError");
    assert_eq!(got["kind"], "writeAfterConfirmationCleared", "{err}");
    assert_eq!(got["confirmationCleared"], true, "{err}");
    assert_eq!(got["error"]["kind"], "linkFile", "{err}");
    // The config DID change (the confirmation is gone); the old URL stays.
    let mut expected = initial.clone();
    expected["calendar"]["links"][0] = json!({ "id": "work" });
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        canonical_json(&expected)
    );
    assert!(
        std::fs::read_to_string(links.join("work.url")).expect("file") == SENTINEL_URL,
        "the old URL must stay"
    );
    // A refusal with nothing cleared stays the plain error.
    for n in 0..MAX_LINKS {
        let other = links.join(format!("other{n}.url"));
        std::fs::write(&other, "https://example.com/other.ics").expect("other link");
        chmod(&other, 0o600);
    }
    let err = s
        .call("calendar_link_write", json!({ "id": "fresh", "url": SENTINEL_URL }))
        .expect_err("over the cap");
    let got: Value = serde_json::from_str(&err).expect("JSON");
    assert_eq!(got["kind"], "tooManyLinks", "{err}");
}

/// M8 checkpoint (LOW): the link folders are checked BEFORE the existing file is compared and
/// before any confirmation is cleared. A symlinked `calendar/` (case 1) or a loose `links/`
/// (case 2) holding a DIFFERENT URL for the link used to be read for the comparison, the
/// confirmation cleared — a config write — and only then the file write refused. Now the folder is
/// refused first and the config is untouched.
#[test]
fn a_refused_link_folder_clears_no_confirmation() {
    let mut initial: Value = serde_json::from_str(FULL).expect("fixture");
    initial.as_object_mut().expect("object").insert(
        "calendar".into(),
        json!({ "enabled": true, "links": [{ "id": "work", "confirmedOwner": "me@example.com" }] }),
    );
    let initial_text = canonical_json(&initial);

    // 1. `<state>/calendar` is a symlink to a folder holding a private `links/work.url`.
    let s = sandbox("cal-ipc-folder-1", Some(&initial_text));
    let elsewhere = s.state.with_file_name("elsewhere-calendar");
    std::fs::create_dir_all(elsewhere.join(LINKS_DIR)).expect("elsewhere");
    chmod(&elsewhere.join(LINKS_DIR), 0o700);
    std::fs::write(elsewhere.join(LINKS_DIR).join("work.url"), "https://example.com/old.ics")
        .expect("old file");
    chmod(&elsewhere.join(LINKS_DIR).join("work.url"), 0o600);
    std::os::unix::fs::symlink(&elsewhere, s.state.join(CALENDAR_DIR)).expect("symlink calendar");
    let err = s
        .call("calendar_link_write", json!({ "id": "work", "url": SENTINEL_URL }))
        .expect_err("a symlinked calendar folder must be refused");
    assert_clean(&err, "symlinked calendar folder");
    assert!(err.contains("linkFolder"), "{err}");
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        initial_text,
        "a confirmation was cleared for a write through a refused folder"
    );
    assert_eq!(
        std::fs::read_to_string(elsewhere.join(LINKS_DIR).join("work.url")).expect("old file"),
        "https://example.com/old.ics"
    );

    // 2. `<state>/calendar/links` is a real folder of ours but loose (0755).
    let s = sandbox("cal-ipc-folder-2", Some(&initial_text));
    let links = s.state.join(CALENDAR_DIR).join(LINKS_DIR);
    std::fs::create_dir_all(&links).expect("links");
    chmod(&s.state.join(CALENDAR_DIR), 0o700);
    chmod(&links, 0o755);
    std::fs::write(links.join("work.url"), "https://example.com/old.ics").expect("old file");
    chmod(&links.join("work.url"), 0o600);
    let err = s
        .call("calendar_link_write", json!({ "id": "work", "url": SENTINEL_URL }))
        .expect_err("a loose links folder must be refused");
    assert_clean(&err, "loose links folder");
    assert!(err.contains("linkFolder"), "{err}");
    assert_eq!(
        std::fs::read_to_string(&s.config).expect("config"),
        initial_text,
        "a confirmation was cleared for a write into a refused folder"
    );
    assert_eq!(mode_of(&links), 0o755, "the loose folder was repaired instead of refused");
}

/* ── the module prints nothing ────────────────────────────────────────────────────────────────── */

/// No log line can carry a URL from a module that has no log line. Comment-stripped, so a doc
/// comment that NAMES a macro cannot satisfy or trip this.
#[test]
fn the_calendar_module_prints_nothing() {
    let source = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("calendar.rs"),
    )
    .expect("src/calendar.rs");
    let code = common::code_only(&source);
    assert!(
        code.contains("fn write_link_file_as"),
        "the scan read the wrong file or stripped the code"
    );
    for needle in [
        "println!",
        "eprintln!",
        "print!",
        "eprint!",
        "dbg!",
        "log::",
        "tracing::",
        "emit(",
    ] {
        assert!(
            !code.contains(needle),
            "src/calendar.rs contains `{needle}` — this module must print nothing, so no URL can \
             reach a log"
        );
    }
}

/// Final harden r3: the URL-shaped `urlCommand` rule's edges — the SAME table as the engine's
/// `test/calendar-config.test.ts` ("the rule's edges, as the desktop mirrors them"): backslash
/// spellings are addresses, a bare `.ics` path (a password-store entry) is not, an `.ics` after a
/// dotted host is.
#[test]
fn the_url_shaped_argument_rule_matches_the_engines_edges() {
    let shaped: &[(&str, bool)] = &[
        ("https:\\\\host\\path", true),
        ("HTTPS:\\/host", true),
        ("webcal:/\\h", true),
        ("x%3a%5c%2fh", true),
        ("op://vault/item/field", false),
        ("OP://v/i/f", false),
        ("op://v/i/https:\\\\h", true),
        ("cal.example.com/x.ics", true),
        ("cal.example.com\\x.ics", true),
        ("cal.example.com:8443/x.ics", true),
        ("me@cal.example.com/x.ics", true),
        ("cal.example.com/x.icsx", false),
        ("example.com/user", false),
        ("calendar/work.ics", false),
        ("c:\\cal\\work.ics", false),
        ("a.b1/x.ics", false),
        ("cal.example.com:123456/x.ics", false),
        // Post-convergence LOW: a percent-encoded separator after the dotted host.
        ("host.example%2Fcalendar%2Fbasic.ics", true),
        ("cal.example.com%5cx.ics", true),
        ("cal.example.com:8443%2fx.ICS", true),
        ("calendar%2Fwork.ics", false),
        ("example.com%2Fuser", false),
    ];
    for (arg, want) in shaped {
        assert_eq!(url_shaped_arg(arg), *want, "{arg}");
    }
}
