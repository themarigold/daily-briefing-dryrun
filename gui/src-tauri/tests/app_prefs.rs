//! A-M1-T1 — the app preference store (`src/app_prefs.rs`): the first name, the slides switch and
//! (B2-M4-T10) the GitHub links switch and the editor choices, in `app-prefs.json` under
//! `app_data_dir()` (redesign A spec, "The app preference store").
//!
//! Every test drives the module's read and write functions directly on a per-test scratch folder,
//! the folder a `with_store_dir` override points the commands at. No test resolves
//! `app_data_dir()` (on MockRuntime that is the developer's real one) or builds an app; the IPC path
//! is covered by `tests/capability.rs`'s app-prefs cases (A-M1-T2).

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use common::ScratchDir;
use daily_briefing_gui_lib::app_prefs::{
    read_prefs, AppPrefs, AppPrefsAnswer, AppPrefsError, AppPrefsPatch, AppPrefsValues, ProjectKey,
    APP_PREFS_CLOSED_BY_UNINSTALL, APP_PREFS_FILE, APP_PREFS_TEMP_PREFIX, FIRST_NAME_BIDI,
    FIRST_NAME_CONTROL, FIRST_NAME_INVISIBLE, FIRST_NAME_MAX_CHARS, FIRST_NAME_TOO_LONG,
    MAX_PREFS_BYTES,
};
use daily_briefing_gui_lib::editor::{EditorChoice, EditorId};

fn name(v: &str) -> AppPrefsPatch {
    AppPrefsPatch {
        first_name: Some(v.to_string()),
        slides: None,
        github_links: None,
    }
}

fn slides(on: bool) -> AppPrefsPatch {
    AppPrefsPatch {
        first_name: None,
        slides: Some(on),
        github_links: None,
    }
}

fn values(first_name: Option<&str>, slides: bool) -> AppPrefsValues {
    AppPrefsValues {
        first_name: first_name.map(str::to_string),
        slides,
        github_links: true,
        editor_choices: BTreeMap::new(),
    }
}

fn defaults() -> AppPrefsValues {
    values(None, true)
}

fn plant(dir: &Path, text: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(APP_PREFS_FILE), text).unwrap();
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn the_file_name_and_temp_prefix_are_the_ones_uninstall_will_name() {
    assert_eq!(APP_PREFS_FILE, "app-prefs.json");
    assert_eq!(APP_PREFS_TEMP_PREFIX, "app-prefs.json.tmp-");
    assert_eq!(FIRST_NAME_MAX_CHARS, 40);
}

#[test]
fn a_set_is_read_back_and_each_field_keeps_the_other() {
    let scratch = ScratchDir::new("app-prefs-set-get");
    let dir = scratch.join("app-data");
    let store = AppPrefs::default();
    assert_eq!(store.set(&dir, name("Sam")), Ok(values(Some("Sam"), true)));
    assert_eq!(read_prefs(&dir), values(Some("Sam"), true));
    assert_eq!(
        store.set(&dir, slides(false)),
        Ok(values(Some("Sam"), false))
    );
    assert_eq!(read_prefs(&dir), values(Some("Sam"), false));
    assert_eq!(store.get(&dir), values(Some("Sam"), false));
    assert_eq!(store.set(&dir, slides(true)), Ok(values(Some("Sam"), true)));
    assert_eq!(read_prefs(&dir), values(Some("Sam"), true));
}

#[test]
fn a_set_into_a_store_folder_that_does_not_exist_yet_creates_it() {
    let scratch = ScratchDir::new("app-prefs-mkdir");
    let dir = scratch.join("not").join("there").join("yet");
    assert!(!dir.exists(), "PREMISE: the folder is missing");
    assert_eq!(
        AppPrefs::default().set(&dir, slides(false)),
        Ok(values(None, false))
    );
    assert!(dir.join(APP_PREFS_FILE).is_file());
    assert_eq!(read_prefs(&dir), values(None, false));
}

#[test]
fn a_missing_file_or_folder_reads_as_the_defaults() {
    let scratch = ScratchDir::new("app-prefs-missing");
    assert_eq!(read_prefs(&scratch.path), defaults());
    assert_eq!(read_prefs(&scratch.join("no-such-folder")), defaults());
    assert_eq!(AppPrefs::default().get(&scratch.path), defaults());
}

#[test]
fn a_corrupt_file_reads_as_the_defaults() {
    let scratch = ScratchDir::new("app-prefs-corrupt");
    for text in [
        "{not json",
        "",
        "[\"Sam\", false]",
        "\"Sam\"",
        "null",
        "{\"firstName\":\"Sam\",\"slides\":false",
    ] {
        plant(&scratch.path, text);
        assert_eq!(read_prefs(&scratch.path), defaults(), "for {text:?}");
    }
    std::fs::write(scratch.join(APP_PREFS_FILE), [0xff, 0xfe, b'{', b'}']).unwrap();
    assert_eq!(read_prefs(&scratch.path), defaults(), "not UTF-8");
}

#[test]
fn an_oversized_file_reads_as_the_defaults() {
    let scratch = ScratchDir::new("app-prefs-oversized");
    let body = "{\"firstName\":\"Sam\",\"slides\":false}";
    // prove-it: the same bytes under the cap are read.
    plant(&scratch.path, body);
    assert_eq!(read_prefs(&scratch.path), values(Some("Sam"), false));
    let padded = format!("{body}{}", " ".repeat(MAX_PREFS_BYTES as usize));
    assert!(padded.len() as u64 > MAX_PREFS_BYTES);
    plant(&scratch.path, &padded);
    assert_eq!(read_prefs(&scratch.path), defaults());
}

/// An oversized file is no lockout: it reads as the defaults, so a set starts from those, answers Ok
/// and replaces the file with a small one holding the patched value.
#[test]
fn a_set_over_an_oversized_file_replaces_it_with_a_small_file() {
    let scratch = ScratchDir::new("app-prefs-oversized-set");
    let body = "{\"firstName\":\"Sam\",\"slides\":false}";
    let padded = format!("{body}{}", " ".repeat(MAX_PREFS_BYTES as usize));
    assert!(padded.len() as u64 > MAX_PREFS_BYTES);
    plant(&scratch.path, &padded);

    assert_eq!(
        AppPrefs::default().set(&scratch.path, name("Alex")),
        Ok(values(Some("Alex"), true))
    );
    let written = std::fs::read(scratch.join(APP_PREFS_FILE)).unwrap();
    assert!(
        (written.len() as u64) < MAX_PREFS_BYTES / 16,
        "the set left {} bytes",
        written.len()
    );
    assert_eq!(read_prefs(&scratch.path), values(Some("Alex"), true));
    assert_eq!(names_in(&scratch.path), [APP_PREFS_FILE]);
}

/// A field this version does not know is ignored on a read and dropped by the next write (§0's build
/// checkpoint B2-M4-T10), and it costs the known fields nothing.
#[test]
fn an_unknown_top_level_field_is_ignored_on_read_and_dropped_by_a_set() {
    let scratch = ScratchDir::new("app-prefs-unknown-field");
    let dir = &scratch.path;
    plant(
        dir,
        "{\"firstName\":\"Sam\",\"slides\":false,\"fromTheFuture\":{\"a\":1}}",
    );
    assert_eq!(read_prefs(dir), values(Some("Sam"), false));

    assert_eq!(
        AppPrefs::default().set(
            dir,
            AppPrefsPatch {
                github_links: Some(false),
                ..AppPrefsPatch::default()
            }
        ),
        Ok(AppPrefsValues {
            github_links: false,
            ..values(Some("Sam"), false)
        })
    );
    let file: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join(APP_PREFS_FILE)).unwrap()).unwrap();
    assert_eq!(
        file,
        serde_json::json!({
            "firstName": "Sam",
            "slides": false,
            "githubLinks": false,
            "editorChoices": {}
        })
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_file_reads_as_the_defaults_and_a_set_never_writes_through_it() {
    let scratch = ScratchDir::new("app-prefs-symlink");
    let dir = scratch.join("app-data");
    std::fs::create_dir_all(&dir).unwrap();
    let victim = scratch.join("elsewhere.json");
    let body = "{\"firstName\":\"Sam\",\"slides\":false}";
    std::fs::write(&victim, body).unwrap();
    std::os::unix::fs::symlink(&victim, dir.join(APP_PREFS_FILE)).unwrap();
    assert_eq!(read_prefs(&dir), defaults());
    assert_eq!(
        AppPrefs::default().set(&dir, name("Alex")),
        Ok(values(Some("Alex"), true))
    );
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), body);
    assert!(!std::fs::symlink_metadata(dir.join(APP_PREFS_FILE))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(read_prefs(&dir), values(Some("Alex"), true));
}

#[test]
fn each_field_is_read_on_its_own() {
    let scratch = ScratchDir::new("app-prefs-fields");
    let cases: [(String, AppPrefsValues); 8] = [
        (
            "{\"firstName\":\"Sam\",\"slides\":\"no\"}".into(),
            values(Some("Sam"), true),
        ),
        (
            "{\"firstName\":7,\"slides\":false}".into(),
            values(None, false),
        ),
        (
            format!("{{\"firstName\":\"{}\",\"slides\":false}}", "a".repeat(41)),
            values(None, false),
        ),
        (
            "{\"firstName\":\"S\\u0007am\",\"slides\":false}".into(),
            values(None, false),
        ),
        (
            "{\"firstName\":\"S\\u202eam\",\"slides\":false}".into(),
            values(None, false),
        ),
        (
            "{\"firstName\":\"  Sam  \"}".into(),
            values(Some("Sam"), true),
        ),
        ("{\"slides\":false}".into(), values(None, false)),
        ("{}".into(), defaults()),
    ];
    for (text, want) in cases {
        plant(&scratch.path, &text);
        assert_eq!(read_prefs(&scratch.path), want, "for {text}");
    }
}

#[cfg(unix)]
#[test]
fn the_file_is_written_0600() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = ScratchDir::new("app-prefs-mode");
    AppPrefs::default().set(&scratch.path, name("Sam")).unwrap();
    let mode = std::fs::metadata(scratch.join(APP_PREFS_FILE))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
}

#[test]
fn no_temp_file_is_left_after_a_write() {
    let scratch = ScratchDir::new("app-prefs-temps");
    let store = AppPrefs::default();
    store.set(&scratch.path, name("Sam")).unwrap();
    store.set(&scratch.path, slides(false)).unwrap();
    assert_eq!(names_in(&scratch.path), [APP_PREFS_FILE]);
}

#[test]
fn a_corrupt_file_is_rewritten_by_the_next_set() {
    let scratch = ScratchDir::new("app-prefs-rewrite");
    plant(&scratch.path, "{not json");
    AppPrefs::default()
        .set(&scratch.path, slides(true))
        .unwrap();
    let text = std::fs::read_to_string(scratch.join(APP_PREFS_FILE)).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid JSON now");
    assert_eq!(
        parsed,
        serde_json::json!({ "slides": true, "githubLinks": true, "editorChoices": {} })
    );
}

#[test]
fn an_empty_patch_writes_nothing() {
    let scratch = ScratchDir::new("app-prefs-noop");
    let patch = AppPrefsPatch {
        first_name: None,
        slides: None,
        github_links: None,
    };
    assert_eq!(
        AppPrefs::default().set(&scratch.path, patch),
        Ok(defaults())
    );
    assert_eq!(names_in(&scratch.path), Vec::<String>::new());
}

#[test]
fn a_name_is_trimmed_and_a_trimmed_empty_name_unsets_it() {
    let scratch = ScratchDir::new("app-prefs-trim");
    let store = AppPrefs::default();
    assert_eq!(
        store.set(&scratch.path, name("  Sam \t")),
        Ok(values(Some("Sam"), true))
    );
    assert_eq!(read_prefs(&scratch.path), values(Some("Sam"), true));
    assert_eq!(store.set(&scratch.path, name("   ")), Ok(defaults()));
    assert_eq!(read_prefs(&scratch.path), defaults());
    store.set(&scratch.path, name("Sam")).unwrap();
    assert_eq!(store.set(&scratch.path, name("")), Ok(defaults()));
    assert_eq!(read_prefs(&scratch.path), defaults());
}

#[test]
fn the_limit_is_forty_unicode_scalar_values_not_bytes() {
    let scratch = ScratchDir::new("app-prefs-forty");
    let store = AppPrefs::default();
    let forty = "é".repeat(40);
    assert_eq!(forty.len(), 80, "PREMISE: two bytes each");
    assert_eq!(
        store.set(&scratch.path, name(&forty)),
        Ok(values(Some(&forty), true))
    );
    assert_eq!(read_prefs(&scratch.path), values(Some(&forty), true));
}

/// A refusal answers the sentence the Settings row shows and leaves the file byte for byte.
fn assert_refused(store: &AppPrefs, dir: &Path, raw: &str, sentence: &str) {
    let before = std::fs::read(dir.join(APP_PREFS_FILE)).unwrap();
    match store.set(dir, name(raw)) {
        Err(AppPrefsError::InvalidInput { field, reason }) => {
            assert_eq!(field, "firstName", "for {raw:?}");
            assert_eq!(reason, sentence, "for {raw:?}");
        }
        other => panic!("{raw:?} was not refused: {other:?}"),
    }
    assert_eq!(
        std::fs::read(dir.join(APP_PREFS_FILE)).unwrap(),
        before,
        "the file changed after refusing {raw:?}"
    );
    assert_eq!(
        names_in(dir),
        [APP_PREFS_FILE],
        "a temp was left for {raw:?}"
    );
}

#[test]
fn each_refusal_leaves_the_file_byte_identical() {
    let scratch = ScratchDir::new("app-prefs-refusals");
    let store = AppPrefs::default();
    store.set(&scratch.path, name("Sam")).unwrap();
    store.set(&scratch.path, slides(false)).unwrap();

    assert_refused(&store, &scratch.path, &"a".repeat(41), FIRST_NAME_TOO_LONG);
    assert_refused(&store, &scratch.path, &"é".repeat(41), FIRST_NAME_TOO_LONG);
    for c in ['\u{0}', '\u{7}', '\u{1b}', '\u{7f}', '\u{85}', '\u{9f}'] {
        assert_refused(
            &store,
            &scratch.path,
            &format!("S{c}am"),
            FIRST_NAME_CONTROL,
        );
    }
    // Inside the name, a tab or a newline is a control character too (only the ends are trimmed).
    assert_refused(&store, &scratch.path, "S\tam", FIRST_NAME_CONTROL);
    assert_refused(&store, &scratch.path, "S\nam", FIRST_NAME_CONTROL);
    // Round-3 L5: the Unicode line and paragraph separators are line breaks too.
    assert_refused(&store, &scratch.path, "S\u{2028}am", FIRST_NAME_CONTROL);
    assert_refused(&store, &scratch.path, "S\u{2029}am", FIRST_NAME_CONTROL);
    let bidi = [
        '\u{061c}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}',
        '\u{202e}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
    ];
    for c in bidi {
        assert_refused(&store, &scratch.path, &format!("S{c}am"), FIRST_NAME_BIDI);
    }
    assert_eq!(read_prefs(&scratch.path), values(Some("Sam"), false));
}

/// Round-1 L5: a name with no character that shows — each one `White_Space` or
/// `Default_Ignorable_Code_Point` — is refused with its own sentence (it read "Good morning, "), and a
/// planted one reads as unset. ZWJ and ZWNJ inside a real name are part of it and kept.
#[test]
fn a_name_of_only_invisible_characters_is_refused_and_zwj_inside_a_real_name_is_kept() {
    let scratch = ScratchDir::new("app-prefs-invisible");
    let store = AppPrefs::default();
    store.set(&scratch.path, name("Sam")).unwrap();
    // The reviewer's cases, alone, repeated, and mixed with White_Space the trim leaves inside.
    for invisible in [
        "\u{200b}",
        "\u{2060}",
        "\u{feff}",
        "\u{00ad}",
        "\u{200b}\u{200b}\u{200b}",
        "\u{00ad} \u{00ad}",
        "\u{200d}",
        "\u{200c}",
        "\u{200d}\u{200c}",
        "\u{fe0f}",
        "\u{3164}",
        "\u{e0041}\u{e0042}",
        "\u{1d173}",
        "\u{034f}\u{180e}\u{ffa0}",
    ] {
        assert_refused(&store, &scratch.path, invisible, FIRST_NAME_INVISIBLE);
        // Between ordinary spaces too (the trim removes those, the rest is still invisible).
        assert_refused(
            &store,
            &scratch.path,
            &format!("  {invisible}  "),
            FIRST_NAME_INVISIBLE,
        );
    }
    // Mixed with U+2028 / U+2029 inside: a line break, refused by the control rule first (round-3 L5).
    for broken in ["\u{200b}\u{2028}\u{200b}", "\u{2060}\u{2029}\u{feff}"] {
        assert_refused(&store, &scratch.path, broken, FIRST_NAME_CONTROL);
    }
    assert_eq!(read_prefs(&scratch.path), values(Some("Sam"), true));
    // U+2028 / U+2029 alone are White_Space: the trim takes them, and the name is unset (not stored).
    assert_eq!(
        store.set(&scratch.path, name("\u{2028}\u{2029}")),
        Ok(defaults())
    );
    // ZWJ / ZWNJ / a variation selector inside a real name: kept, as typed.
    for real in [
        "Ma\u{200c}ri",
        "\u{1f469}\u{200d}\u{1f4bb}",
        "Zo\u{00ad}e",
        "\u{2764}\u{fe0f}",
        "J\u{200b}o",
    ] {
        assert_eq!(
            store.set(&scratch.path, name(real)),
            Ok(values(Some(real), true)),
            "for {real:?}"
        );
        assert_eq!(read_prefs(&scratch.path), values(Some(real), true));
    }
    // A file that already holds an invisible-only name (written before this rule) reads as unset.
    plant(
        &scratch.path,
        "{\"firstName\":\"\\u200b\\u2060\",\"slides\":false}",
    );
    assert_eq!(read_prefs(&scratch.path), values(None, false));
}

#[test]
fn a_refusal_into_an_empty_folder_creates_nothing() {
    let scratch = ScratchDir::new("app-prefs-refuse-empty");
    let dir = scratch.join("app-data");
    let refused = AppPrefs::default().set(&dir, name(&"a".repeat(41)));
    assert!(matches!(refused, Err(AppPrefsError::InvalidInput { .. })));
    assert!(!dir.exists(), "a refused set created the store folder");
}

#[test]
fn a_refused_name_also_refuses_the_slides_half_of_the_same_patch() {
    let scratch = ScratchDir::new("app-prefs-refuse-both");
    let store = AppPrefs::default();
    store.set(&scratch.path, name("Sam")).unwrap();
    let both = AppPrefsPatch {
        first_name: Some("S\u{202e}am".into()),
        slides: Some(false),
        github_links: None,
    };
    assert!(matches!(
        store.set(&scratch.path, both),
        Err(AppPrefsError::InvalidInput { .. })
    ));
    assert_eq!(read_prefs(&scratch.path), values(Some("Sam"), true));
}

/// A-M1-T2 reads the 40-character refusal as ADMITTED (the command's own code answered), so the
/// sentence must hold none of the ACL's denial markers, which all say "not allowed".
#[test]
fn no_refusal_sentence_reads_as_an_acl_denial() {
    for sentence in [
        FIRST_NAME_TOO_LONG,
        FIRST_NAME_CONTROL,
        FIRST_NAME_BIDI,
        FIRST_NAME_INVISIBLE,
    ] {
        assert!(!sentence.contains("not allowed"), "{sentence}");
        assert!(!sentence.contains("denied"), "{sentence}");
        assert!(sentence.ends_with('.'), "{sentence}");
    }
    assert!(FIRST_NAME_TOO_LONG.contains("40"));
}

/// Round-4 L1: the store's revision — what lets the webview keep the NEWEST answer whatever order two
/// answers arrive in. It starts at 0, is bumped by every write that lands (a name, the slides, both),
/// is answered by get without a bump, and is NOT bumped by a set that writes nothing or is refused.
#[test]
fn the_revision_counts_the_writes_that_landed_and_never_goes_back() {
    let scratch = ScratchDir::new("app-prefs-revision");
    let store = AppPrefs::default();
    let rev = |a: AppPrefsAnswer| a.revision;
    assert_eq!(rev(store.get_answer(&scratch.path)), 0);
    assert_eq!(
        rev(store.set_answer(&scratch.path, name("Sam")).unwrap()),
        1
    );
    assert_eq!(rev(store.get_answer(&scratch.path)), 1);
    assert_eq!(
        rev(store.set_answer(&scratch.path, slides(false)).unwrap()),
        2
    );
    // Nothing to write: the current revision, unchanged.
    assert_eq!(
        rev(store
            .set_answer(&scratch.path, AppPrefsPatch::default())
            .unwrap()),
        2
    );
    // Refused: nothing written, no bump.
    assert!(store
        .set_answer(&scratch.path, name(&"a".repeat(41)))
        .is_err());
    assert_eq!(rev(store.get_answer(&scratch.path)), 2);
    // The plain `set` is the same write (its answer without the revision).
    assert_eq!(
        store.set(&scratch.path, slides(true)),
        Ok(values(Some("Sam"), true))
    );
    assert_eq!(
        store.get_answer(&scratch.path),
        AppPrefsAnswer {
            values: values(Some("Sam"), true),
            revision: 3
        }
    );
    // Closed by uninstall: refused, no bump.
    drop(store.close_for_uninstall());
    assert!(store.set_answer(&scratch.path, name("Alex")).is_err());
    assert_eq!(rev(store.get_answer(&scratch.path)), 3);
    // Many writes from several threads: on a fresh store each answer's revision is distinct, and together they are 1..=16.
    let store = std::sync::Arc::new(AppPrefs::default());
    let scratch2 = ScratchDir::new("app-prefs-revision-threads");
    let dir = scratch2.path.clone();
    let handles: Vec<_> = (0..16)
        .map(|n| {
            let (store, dir) = (store.clone(), dir.clone());
            std::thread::spawn(move || store.set_answer(&dir, slides(n % 2 == 0)).unwrap().revision)
        })
        .collect();
    let mut seen: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    seen.sort_unstable();
    assert_eq!(seen, (1..=16).collect::<Vec<u64>>());
}

#[test]
fn the_wire_shapes_are_camel_case() {
    let patch: AppPrefsPatch =
        serde_json::from_value(serde_json::json!({ "firstName": "Sam" })).unwrap();
    assert_eq!(patch, name("Sam"));
    let patch: AppPrefsPatch = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(
        patch,
        AppPrefsPatch {
            first_name: None,
            slides: None,
            github_links: None
        }
    );
    assert_eq!(
        serde_json::to_value(values(Some("Sam"), false)).unwrap(),
        serde_json::json!({ "firstName": "Sam", "slides": false, "githubLinks": true, "editorChoices": {} })
    );
    assert_eq!(
        serde_json::to_value(defaults()).unwrap(),
        serde_json::json!({ "slides": true, "githubLinks": true, "editorChoices": {} })
    );
    // The commands' answer: the values flattened, with the revision beside them (round-4 L1).
    assert_eq!(
        serde_json::to_value(AppPrefsAnswer {
            values: values(Some("Sam"), false),
            revision: 7
        })
        .unwrap(),
        serde_json::json!({
            "firstName": "Sam", "slides": false, "githubLinks": true, "editorChoices": {}, "revision": 7
        })
    );
    assert_eq!(
        serde_json::to_value(AppPrefsAnswer {
            values: defaults(),
            revision: 0
        })
        .unwrap(),
        serde_json::json!({ "slides": true, "githubLinks": true, "editorChoices": {}, "revision": 0 })
    );
    // A misspelt field is refused, not silently dropped as a no-op set.
    assert!(
        serde_json::from_value::<AppPrefsPatch>(serde_json::json!({ "firstname": "Sam" })).is_err()
    );
    // The error shapes `app-prefs-store.ts` reads by `kind`: the refusal's sentence is `reason`,
    // a store failure's text is `detail`.
    assert_eq!(
        serde_json::to_value(AppPrefsError::InvalidInput {
            field: "firstName".into(),
            reason: FIRST_NAME_TOO_LONG.into(),
        })
        .unwrap(),
        serde_json::json!({
            "kind": "invalidInput",
            "field": "firstName",
            "reason": FIRST_NAME_TOO_LONG,
        })
    );
    assert_eq!(
        serde_json::to_value(AppPrefsError::Store {
            detail: "the disk is full".into(),
        })
        .unwrap(),
        serde_json::json!({ "kind": "store", "detail": "the disk is full" })
    );
}

/// A rename that fails (a folder sits at the store's name) answers a store failure and leaves no
/// temp file behind: the temp holds the name, 0600, and nothing would ever sweep it.
#[test]
fn a_failed_rename_answers_a_store_failure_and_removes_its_temp() {
    let scratch = ScratchDir::new("app-prefs-rename-fails");
    let blocker = scratch.join(APP_PREFS_FILE);
    std::fs::create_dir_all(blocker.join("inside")).unwrap();
    match AppPrefs::default().set(&scratch.path, name("Sam")) {
        Err(AppPrefsError::Store { .. }) => {}
        other => panic!("a set over a folder did not fail as a store failure: {other:?}"),
    }
    assert_eq!(names_in(&scratch.path), [APP_PREFS_FILE]);
    assert!(blocker.join("inside").is_dir(), "the folder was touched");
}

/// Once uninstall's app leg has closed the store, every later set refuses with a store failure and
/// writes nothing — not the folder, not the file, not a temp — for the rest of the session (the
/// latch outlives the guard); a get still answers (the defaults, the file being gone).
#[test]
fn after_close_for_uninstall_every_set_refuses_and_writes_nothing() {
    let scratch = ScratchDir::new("app-prefs-closed");
    let dir = scratch.join("app-data");
    let store = AppPrefs::default();
    {
        let _closed = store.close_for_uninstall();
    }
    let closed = Err(AppPrefsError::Store {
        detail: APP_PREFS_CLOSED_BY_UNINSTALL.into(),
    });
    assert_eq!(store.set(&dir, name("Sam")), closed);
    assert_eq!(store.set(&dir, slides(false)), closed);
    assert!(
        !dir.exists(),
        "a set after uninstall created the store folder"
    );
    std::fs::create_dir_all(&dir).unwrap();
    assert_eq!(store.set(&dir, name("Sam")), closed);
    assert_eq!(names_in(&dir), Vec::<String>::new());
    assert_eq!(store.get(&dir), defaults());
    assert!(!APP_PREFS_CLOSED_BY_UNINSTALL.contains("not allowed"));
}

/* ── B2-M4-T10: the GitHub links switch, the editor choices and the one size bound ─────────────── */

const FULL: u64 = MAX_PREFS_BYTES;

/// The `i`th project key: 32 lowercase hex bytes, the only shape a key has.
fn pk(i: usize) -> ProjectKey {
    ProjectKey::parse(&format!("{i:032x}")).expect("a 32-lowercase-hex key")
}

fn zed() -> EditorChoice {
    EditorChoice::Editor(EditorId::Zed)
}

/// Values holding `n` choices of Zed, the shape the store writes.
fn with_choices(n: usize) -> AppPrefsValues {
    AppPrefsValues {
        editor_choices: (0..n).map(|i| (pk(i), zed())).collect(),
        ..defaults()
    }
}

fn pretty(values: &AppPrefsValues) -> String {
    serde_json::to_string_pretty(values).unwrap()
}

/// The largest `n` whose serialized values, after `adjust`, stay at or under `limit` bytes.
fn most_choices_under(limit: u64, adjust: impl Fn(&mut AppPrefsValues)) -> usize {
    let fits = |n: usize| {
        let mut v = with_choices(n);
        adjust(&mut v);
        pretty(&v).len() as u64 <= limit
    };
    let mut n = 0;
    while fits(n + 1) {
        n += 1;
    }
    n
}

/// Values with no name, and the ASCII name length that brings them to exactly [`FULL`] bytes: that
/// length and one byte more both fit the name's scalar limit. One more choice costs 47 bytes, so the
/// room left after the most choices that fit is 1 to 47. Lengthening one token from `zed` to
/// `intellij-idea` takes 10 bytes off a room past the limit, which is why this varies a token rather
/// than dropping a choice (that only adds room).
fn exactly_full_with_a_name() -> (AppPrefsValues, usize) {
    let room_with_no_name = |v: &AppPrefsValues| {
        let mut named = v.clone();
        named.first_name = Some(String::new());
        FULL as usize - pretty(&named).len()
    };
    let n = most_choices_under(FULL - 1, |v| v.first_name = Some(String::new()));
    let mut base = with_choices(n);
    if room_with_no_name(&base) >= FIRST_NAME_MAX_CHARS {
        base.editor_choices
            .insert(pk(0), EditorChoice::Editor(EditorId::IntellijIdea));
    }
    let room = room_with_no_name(&base);
    assert!(
        (1..FIRST_NAME_MAX_CHARS).contains(&room),
        "no token reaches the bound: {room}"
    );
    (base, room)
}

fn bytes_of(dir: &Path) -> Vec<u8> {
    std::fs::read(dir.join(APP_PREFS_FILE)).unwrap()
}

#[test]
fn a_patch_holding_editor_choices_is_refused_and_github_links_is_accepted() {
    for field in [
        serde_json::json!({ "editorChoices": {} }),
        serde_json::json!({ "editorChoices": { "00000000000000000000000000000000": "zed" } }),
        serde_json::json!({ "githubLinks": true, "editorChoices": {} }),
        serde_json::json!({ "editor_choices": {} }),
        serde_json::json!({ "github_links": true }),
    ] {
        assert!(
            serde_json::from_value::<AppPrefsPatch>(field.clone()).is_err(),
            "accepted {field}"
        );
    }
    let patch: AppPrefsPatch =
        serde_json::from_value(serde_json::json!({ "githubLinks": false })).unwrap();
    assert_eq!(
        patch,
        AppPrefsPatch {
            first_name: None,
            slides: None,
            github_links: Some(false)
        }
    );
}

#[test]
fn a_links_only_patch_writes_and_bumps_the_revision_while_an_empty_one_does_neither() {
    let scratch = ScratchDir::new("app-prefs-links");
    let dir = scratch.join("app-data");
    let store = AppPrefs::default();
    let empty = store.set_answer(&dir, AppPrefsPatch::default()).unwrap();
    assert_eq!(empty.revision, 0);
    assert!(!dir.exists(), "an empty patch wrote something");

    let links = |on| AppPrefsPatch {
        github_links: Some(on),
        ..AppPrefsPatch::default()
    };
    let off = store.set_answer(&dir, links(false)).unwrap();
    assert_eq!((off.values.github_links, off.revision), (false, 1));
    assert!(!read_prefs(&dir).github_links, "the switch did not land");
    let on = store.set_answer(&dir, links(true)).unwrap();
    assert_eq!((on.values.github_links, on.revision), (true, 2));
    assert!(read_prefs(&dir).github_links);

    // Each field keeps the others.
    store.set(&dir, name("Sam")).unwrap();
    store.set(&dir, slides(false)).unwrap();
    store.set(&dir, links(false)).unwrap();
    let got = read_prefs(&dir);
    assert_eq!(got.first_name.as_deref(), Some("Sam"));
    assert!(!got.slides);
    assert!(!got.github_links);
    assert_eq!(store.get_answer(&dir).revision, 5);
    assert_eq!(
        store
            .set_answer(&dir, AppPrefsPatch::default())
            .unwrap()
            .revision,
        5
    );
}

#[test]
fn an_editor_choice_round_trips_and_keeps_every_other_field() {
    let scratch = ScratchDir::new("app-prefs-choice");
    let dir = scratch.join("app-data");
    let store = AppPrefs::default();
    store.set(&dir, name("Sam")).unwrap();
    store
        .set(
            &dir,
            AppPrefsPatch {
                github_links: Some(false),
                ..AppPrefsPatch::default()
            },
        )
        .unwrap();

    let answer = store
        .set_editor_choice(&dir, pk(1), EditorChoice::Editor(EditorId::VsCode))
        .unwrap();
    assert_eq!(answer.revision, 3);
    assert_eq!(
        answer.values.editor_choices,
        BTreeMap::from([(pk(1), EditorChoice::Editor(EditorId::VsCode))])
    );
    let answer = store
        .set_editor_choice(&dir, pk(2), EditorChoice::Ask)
        .unwrap();
    assert_eq!(answer.revision, 4);
    // A choice can be changed, and to "ask".
    let answer = store
        .set_editor_choice(&dir, pk(1), EditorChoice::Ask)
        .unwrap();
    assert_eq!(answer.revision, 5);

    let got = read_prefs(&dir);
    assert_eq!(answer.values, got, "the answer is what a read gives");
    assert_eq!(got.first_name.as_deref(), Some("Sam"));
    assert!(!got.github_links);
    assert_eq!(
        got.editor_choices,
        BTreeMap::from([(pk(1), EditorChoice::Ask), (pk(2), EditorChoice::Ask)])
    );
    // The name, slides and links patches keep the choices.
    store.set(&dir, name("Alex")).unwrap();
    store.set(&dir, slides(false)).unwrap();
    assert_eq!(read_prefs(&dir).editor_choices, got.editor_choices);
    assert_eq!(names_in(&dir), [APP_PREFS_FILE]);
}

#[test]
fn an_editor_choice_after_uninstall_refuses_and_writes_nothing() {
    let scratch = ScratchDir::new("app-prefs-choice-closed");
    let store = AppPrefs::default();
    drop(store.close_for_uninstall());
    assert_eq!(
        store.set_editor_choice(&scratch.path, pk(1), zed()),
        Err(AppPrefsError::Store {
            detail: APP_PREFS_CLOSED_BY_UNINSTALL.into()
        })
    );
    assert_eq!(names_in(&scratch.path), Vec::<String>::new());
}

#[test]
fn an_oversized_choice_set_refuses_with_the_file_values_and_revision_unchanged() {
    let scratch = ScratchDir::new("app-prefs-choice-full");
    let dir = scratch.join("app-data");
    let store = AppPrefs::default();
    let mut stored = 0;
    let refusal = loop {
        assert!(stored < 1_000, "the bound never refused");
        match store.set_editor_choice(&dir, pk(stored), zed()) {
            Ok(_) => stored += 1,
            Err(e) => break e,
        }
    };
    assert_eq!(refusal, AppPrefsError::PreferencesFull);
    assert!(stored > 0);
    let before = bytes_of(&dir);
    assert!(before.len() as u64 <= FULL, "a write went past the bound");
    // The refusal changed nothing, a second one included, and nothing was evicted.
    for _ in 0..2 {
        assert_eq!(
            store.set_editor_choice(&dir, pk(stored), zed()),
            Err(AppPrefsError::PreferencesFull)
        );
        assert_eq!(bytes_of(&dir), before);
        assert_eq!(names_in(&dir), [APP_PREFS_FILE]);
        assert_eq!(store.get_answer(&dir).revision, stored as u64);
        assert_eq!(read_prefs(&dir).editor_choices.len(), stored);
    }
}

/// R5-M2: without one bound on every write, a name that pushes the file past the read's cap would
/// silently reset every preference at the next read.
#[test]
fn a_maximum_name_that_would_overflow_refuses_and_the_same_patch_under_the_bound_writes() {
    let scratch = ScratchDir::new("app-prefs-name-full");
    let dir = &scratch.path;
    let max_name = "\u{1f600}".repeat(FIRST_NAME_MAX_CHARS);
    assert_eq!(max_name.len(), 4 * FIRST_NAME_MAX_CHARS);

    // Just under the bound, with less room than this name needs.
    let n = most_choices_under(FULL - 100, |_| {});
    let near_full = with_choices(n);
    assert!((pretty(&near_full).len() as u64) < FULL);
    let mut with_name = near_full.clone();
    with_name.first_name = Some(max_name.clone());
    assert!(
        pretty(&with_name).len() as u64 > FULL,
        "the case proves nothing"
    );

    plant(dir, &pretty(&near_full));
    let before = bytes_of(dir);
    let store = AppPrefs::default();
    assert_eq!(
        store.set_answer(dir, name(&max_name)),
        Err(AppPrefsError::PreferencesFull)
    );
    assert_eq!(bytes_of(dir), before, "the refusal changed the file");
    assert_eq!(
        names_in(dir),
        [APP_PREFS_FILE],
        "the refusal left a temp file"
    );
    assert_eq!(store.get_answer(dir).revision, 0);
    assert_eq!(read_prefs(dir), near_full);

    // The same patch writes when it fits, and every choice survives it.
    let fewer = with_choices(n - 5);
    plant(dir, &pretty(&fewer));
    let answer = store.set_answer(dir, name(&max_name)).unwrap();
    assert_eq!(answer.revision, 1);
    assert_eq!(answer.values.first_name.as_deref(), Some(max_name.as_str()));
    assert_eq!(answer.values.editor_choices, fewer.editor_choices);
    assert!(bytes_of(dir).len() as u64 <= FULL);
    assert_eq!(read_prefs(dir), answer.values);
}

/// The write bound and the read's cap are one number: a file of exactly the bound is written and read
/// back whole, and one byte more refuses. Off by one either way would lose every preference.
#[test]
fn a_file_of_exactly_the_bound_writes_and_reads_back_and_one_byte_more_refuses() {
    let scratch = ScratchDir::new("app-prefs-exact");
    let dir = &scratch.path;
    let (base, room) = exactly_full_with_a_name();
    let a_name = |bytes: usize| "a".repeat(bytes);

    plant(dir, &pretty(&base));
    let store = AppPrefs::default();
    assert_eq!(
        store.set_answer(dir, name(&a_name(room + 1))),
        Err(AppPrefsError::PreferencesFull),
        "one byte over the bound"
    );
    let answer = store.set_answer(dir, name(&a_name(room))).unwrap();
    assert_eq!(bytes_of(dir).len() as u64, FULL, "not exactly the bound");
    assert_eq!(answer.revision, 1);
    let got = read_prefs(dir);
    assert_eq!(
        got.first_name,
        Some(a_name(room)),
        "the read reset the file"
    );
    assert_eq!(got.editor_choices, base.editor_choices);
}

#[test]
fn slides_and_links_patches_are_held_to_the_bound_too() {
    let scratch = ScratchDir::new("app-prefs-toggle-full");
    let dir = &scratch.path;
    let (mut full, room) = exactly_full_with_a_name();
    full.first_name = Some("a".repeat(room));
    assert_eq!(
        pretty(&full).len() as u64,
        FULL,
        "the file is not at the bound"
    );
    plant(dir, &pretty(&full));
    let before = bytes_of(dir);
    let store = AppPrefs::default();
    // `true` to `false` is one byte more.
    assert_eq!(
        store.set_answer(dir, slides(false)),
        Err(AppPrefsError::PreferencesFull)
    );
    assert_eq!(
        store.set_answer(
            dir,
            AppPrefsPatch {
                github_links: Some(false),
                ..AppPrefsPatch::default()
            }
        ),
        Err(AppPrefsError::PreferencesFull)
    );
    assert_eq!(bytes_of(dir), before);
    assert_eq!(store.get_answer(dir).revision, 0);
}

#[test]
fn the_full_refusal_serializes_as_exactly_its_code() {
    assert_eq!(
        serde_json::to_string(&AppPrefsError::PreferencesFull).unwrap(),
        "{\"kind\":\"preferences-full\"}"
    );
}

/// R5-M11: one token per editor, in B2 `:67`'s order, each bounded ASCII.
#[test]
fn the_editor_tokens_are_exact_and_round_trip() {
    let table = [
        (EditorId::VsCode, "vs-code"),
        (EditorId::Cursor, "cursor"),
        (EditorId::Windsurf, "windsurf"),
        (EditorId::Zed, "zed"),
        (EditorId::SublimeText, "sublime-text"),
        (EditorId::Xcode, "xcode"),
        (EditorId::IntellijIdea, "intellij-idea"),
        (EditorId::Pycharm, "pycharm"),
        (EditorId::Webstorm, "webstorm"),
        (EditorId::Goland, "goland"),
        (EditorId::Rustrover, "rustrover"),
        (EditorId::Clion, "clion"),
        (EditorId::Rider, "rider"),
        (EditorId::Rubymine, "rubymine"),
        (EditorId::Phpstorm, "phpstorm"),
        (EditorId::Datagrip, "datagrip"),
    ];
    for (id, token) in table {
        assert!(token.is_ascii() && token.len() <= 32, "{token}");
        let wire = serde_json::json!(token);
        assert_eq!(serde_json::to_value(id).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<EditorId>(wire.clone()).unwrap(),
            id
        );
        let choice = EditorChoice::Editor(id);
        assert_eq!(serde_json::to_value(choice).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<EditorChoice>(wire).unwrap(),
            choice
        );
    }
}

#[test]
fn ask_is_a_choice_not_an_editor_and_anything_else_is_refused() {
    let ask = serde_json::json!("ask");
    assert_eq!(serde_json::to_value(EditorChoice::Ask).unwrap(), ask);
    assert_eq!(
        serde_json::from_value::<EditorChoice>(ask.clone()).unwrap(),
        EditorChoice::Ask
    );
    assert!(serde_json::from_value::<EditorId>(ask).is_err());
    for bad in [
        serde_json::json!(null),
        serde_json::json!("notepad"),
        serde_json::json!(""),
        serde_json::json!("ASK"),
        serde_json::json!("VS-Code"),
        serde_json::json!("vs_code"),
        serde_json::json!(" zed"),
        serde_json::json!(1),
        serde_json::json!(true),
        serde_json::json!(["zed"]),
        serde_json::json!({ "editor": "zed" }),
    ] {
        assert!(
            serde_json::from_value::<EditorChoice>(bad.clone()).is_err(),
            "accepted {bad}"
        );
    }
}

#[test]
fn a_project_key_is_exactly_32_lowercase_hex_bytes() {
    assert!(ProjectKey::parse("0123456789abcdef0123456789abcdef").is_some());
    for bad in [
        "",
        "0123456789abcdef0123456789abcde",   // 31
        "0123456789abcdef0123456789abcdef0", // 33
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcdeg",
        " 123456789abcdef0123456789abcdef",
        "é123456789abcdef0123456789abcde",
    ] {
        assert!(ProjectKey::parse(bad).is_none(), "accepted {bad:?}");
    }
}

/// The engine's keys, from the shared fixture (no Rust hash): each is accepted, and a choice is found
/// under its exact key and no other.
#[test]
fn the_engine_built_fixture_keys_are_valid_and_look_up_exactly() {
    let doc: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("fixtures/project-key-vectors.json")).unwrap();
    let keys: Vec<ProjectKey> = doc
        .iter()
        .map(|v| {
            let raw = v["project"].as_str().expect("a project member");
            ProjectKey::parse(raw).unwrap_or_else(|| panic!("refused {raw}"))
        })
        .collect();
    assert_eq!(keys.len(), 5);

    let scratch = ScratchDir::new("app-prefs-vectors");
    let store = AppPrefs::default();
    store
        .set_editor_choice(&scratch.path, keys[0].clone(), zed())
        .unwrap();
    store
        .set_editor_choice(&scratch.path, keys[4].clone(), EditorChoice::Ask)
        .unwrap();
    let got = read_prefs(&scratch.path).editor_choices;
    assert_eq!(got.get(&keys[0]), Some(&zed()));
    assert_eq!(got.get(&keys[4]), Some(&EditorChoice::Ask));
    for key in &keys[1..4] {
        assert_eq!(got.get(key), None, "{key:?} was never chosen");
    }
    // Plain JSON on disk, under the fixture's own bytes.
    let text: serde_json::Value = serde_json::from_slice(&bytes_of(&scratch.path)).unwrap();
    assert_eq!(
        text["editorChoices"][doc[0]["project"].as_str().unwrap()],
        "zed"
    );
    assert_eq!(
        text["editorChoices"][doc[4]["project"].as_str().unwrap()],
        "ask"
    );
}

#[test]
fn the_new_fields_default_one_by_one_and_the_old_ones_survive_them() {
    let scratch = ScratchDir::new("app-prefs-new-fields");
    let sam = values(Some("Sam"), false);
    for text in [
        // Missing: a file from before this version.
        "{\"firstName\":\"Sam\",\"slides\":false}",
        // Invalid, each on its own.
        "{\"firstName\":\"Sam\",\"slides\":false,\"githubLinks\":\"no\"}",
        "{\"firstName\":\"Sam\",\"slides\":false,\"githubLinks\":null}",
        "{\"firstName\":\"Sam\",\"slides\":false,\"githubLinks\":0}",
        "{\"firstName\":\"Sam\",\"slides\":false,\"editorChoices\":null}",
        "{\"firstName\":\"Sam\",\"slides\":false,\"editorChoices\":[]}",
        "{\"firstName\":\"Sam\",\"slides\":false,\"editorChoices\":\"zed\"}",
        "{\"firstName\":\"Sam\",\"slides\":false,\"editorChoices\":7}",
    ] {
        plant(&scratch.path, text);
        assert_eq!(read_prefs(&scratch.path), sam, "for {text}");
    }
    // A valid new field beside invalid old ones, and the other way about.
    let key = format!("{:032x}", 9);
    plant(
        &scratch.path,
        &format!(
            "{{\"slides\":\"no\",\"githubLinks\":false,\"editorChoices\":{{\"{key}\":\"zed\"}}}}"
        ),
    );
    assert_eq!(
        read_prefs(&scratch.path),
        AppPrefsValues {
            github_links: false,
            editor_choices: BTreeMap::from([(pk(9), zed())]),
            ..defaults()
        }
    );
    plant(
        &scratch.path,
        "{\"firstName\":\"Sam\",\"slides\":false,\"githubLinks\":\"no\",\"editorChoices\":{}}",
    );
    assert_eq!(read_prefs(&scratch.path), sam);
}

#[test]
fn a_mixed_map_keeps_its_valid_entries_and_drops_only_the_rest() {
    let scratch = ScratchDir::new("app-prefs-mixed");
    let (good, ask) = (format!("{:032x}", 1), format!("{:032x}", 2));
    let (nulled, unknown, number, nested) = (
        format!("{:032x}", 3),
        format!("{:032x}", 4),
        format!("{:032x}", 5),
        format!("{:032x}", 6),
    );
    let upper = "ABCDEFABCDEFABCDEFABCDEFABCDEFAB";
    let short = "abc";
    let text = serde_json::json!({
        "firstName": "Sam",
        "editorChoices": {
            good.clone(): "cursor",
            ask.clone(): "ask",
            nulled: null,
            unknown: "notepad",
            number: 7,
            nested: { "editor": "zed" },
            upper: "zed",
            short: "zed",
        },
    })
    .to_string();
    plant(&scratch.path, &text);
    let got = read_prefs(&scratch.path);
    assert_eq!(got.first_name.as_deref(), Some("Sam"));
    assert_eq!(
        got.editor_choices,
        BTreeMap::from([
            (pk(1), EditorChoice::Editor(EditorId::Cursor)),
            (pk(2), EditorChoice::Ask),
        ])
    );
}

#[test]
fn both_new_fields_are_always_written_and_null_never_is() {
    let scratch = ScratchDir::new("app-prefs-always");
    // An empty map is written as `{}`.
    AppPrefs::default()
        .set(&scratch.path, slides(false))
        .unwrap();
    let text = String::from_utf8(bytes_of(&scratch.path)).unwrap();
    assert!(text.contains("\"editorChoices\": {}"), "{text}");
    assert!(text.contains("\"githubLinks\": true"), "{text}");

    // A stored null reads as never chosen, and the next write does not carry it.
    let key = format!("{:032x}", 1);
    plant(
        &scratch.path,
        &format!(
            "{{\"editorChoices\":{{\"{key}\":null,\"{:032x}\":\"zed\"}}}}",
            2
        ),
    );
    assert_eq!(read_prefs(&scratch.path).editor_choices.get(&pk(1)), None);
    AppPrefs::default().set(&scratch.path, name("Sam")).unwrap();
    let text = String::from_utf8(bytes_of(&scratch.path)).unwrap();
    assert!(!text.contains("null"), "{text}");
    assert!(!text.contains(&key), "{text}");
    assert_eq!(
        read_prefs(&scratch.path).editor_choices,
        BTreeMap::from([(pk(2), zed())])
    );
}
