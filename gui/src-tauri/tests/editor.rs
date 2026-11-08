//! Briefing redesign B2 (wave-3 plan B2-M4-T11): "Open in editor". Detecting, choosing and launching.
//!
//! Nothing here opens an editor or asks LaunchServices anything: the detector and the launcher are recording fakes (plan
//! §0.6). The config comes from a real temp file through the production `config_read` handler and a fake status sidecar
//! (R3-L10), the home is injected, and the git facts are the shared fixture's, materialised under a scratch root.

mod common;

use std::collections::BTreeSet;
use std::sync::Mutex;

use daily_briefing_gui_lib::editor::{
    checkout_holds_branch, list_editors, open_folder, preselect, set_choice, EditorChoiceRequest, EditorDetector,
    EditorEnv, EditorId, EditorListRequest, EditorOpenRequest, EditorSink,
};
use serde_json::{json, Value};

/// A detector that knows only the bundle ids a test names.
#[derive(Default)]
struct FakeDetector(BTreeSet<String>);

impl FakeDetector {
    fn with(ids: &[&str]) -> Self {
        Self(ids.iter().map(|s| s.to_string()).collect())
    }
}

impl EditorDetector for FakeDetector {
    fn is_installed(&self, bundle_id: &str) -> bool {
        self.0.contains(bundle_id)
    }
}

/// A launcher that records the argv it was asked to run and starts nothing.
#[derive(Default)]
struct RecordingLauncher {
    argv: Mutex<Vec<Vec<String>>>,
    fail: bool,
}

impl EditorSink for RecordingLauncher {
    fn launch(&self, argv: &[String]) -> Result<(), String> {
        self.argv.lock().unwrap().push(argv.to_vec());
        if self.fail {
            return Err("/private/secret: launch error text".into());
        }
        Ok(())
    }
}

const VS_CODE: &str = "com.microsoft.VSCode";
const IDEA: &str = "com.jetbrains.intellij";
const IDEA_CE: &str = "com.jetbrains.intellij.ce";
const PYCHARM: &str = "com.jetbrains.pycharm";
const PYCHARM_CE: &str = "com.jetbrains.pycharm.ce";
const ZED: &str = "dev.zed.Zed";

/* ── the closed enum (B2 `:67`, `:75`; G-TEXT's default labels, R5-M6) ───────────────────────────── */

#[test]
fn the_table_is_b2s_list_in_order_with_the_default_labels() {
    let table: Vec<(EditorId, &str, &[&str])> = EditorId::ALL.iter().map(|e| (*e, e.label(), e.bundle_ids())).collect();
    let want: Vec<(EditorId, &str, &[&str])> = vec![
        (EditorId::VsCode, "VS Code", &["com.microsoft.VSCode"]),
        (EditorId::Cursor, "Cursor", &["com.todesktop.230313mzl4w4u92"]),
        (EditorId::Windsurf, "Windsurf", &["com.exafunction.windsurf"]),
        (EditorId::Zed, "Zed", &["dev.zed.Zed"]),
        (EditorId::SublimeText, "Sublime Text", &["com.sublimetext.4"]),
        (EditorId::Xcode, "Xcode", &["com.apple.dt.Xcode"]),
        (EditorId::IntellijIdea, "IntelliJ IDEA", &["com.jetbrains.intellij", "com.jetbrains.intellij.ce"]),
        (EditorId::Pycharm, "PyCharm", &["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"]),
        (EditorId::Webstorm, "WebStorm", &["com.jetbrains.WebStorm"]),
        (EditorId::Goland, "GoLand", &["com.jetbrains.goland"]),
        (EditorId::Rustrover, "RustRover", &["com.jetbrains.rustrover"]),
        (EditorId::Clion, "CLion", &["com.jetbrains.CLion"]),
        (EditorId::Rider, "Rider", &["com.jetbrains.rider"]),
        (EditorId::Rubymine, "RubyMine", &["com.jetbrains.rubymine"]),
        (EditorId::Phpstorm, "PhpStorm", &["com.jetbrains.PhpStorm"]),
        (EditorId::Datagrip, "DataGrip", &["com.jetbrains.datagrip"]),
    ];
    assert_eq!(table, want);
}

/// B2 `:74`: VS Code before IntelliJ IDEA when both markers match, each marker only when its editor is installed, then
/// the first installed editor, then nothing.
#[test]
fn preselection_follows_the_markers_then_the_enum_order() {
    use EditorId::{IntellijIdea, VsCode, Zed};
    for (name, installed, vscode, idea, want) in [
        (".vscode", vec![Zed, VsCode], true, false, Some(VsCode)),
        (".idea", vec![Zed, IntellijIdea], false, true, Some(IntellijIdea)),
        ("both, VS Code first", vec![VsCode, IntellijIdea], true, true, Some(VsCode)),
        ("both, only IDEA installed", vec![IntellijIdea], true, true, Some(IntellijIdea)),
        (".vscode without VS Code", vec![Zed], true, false, Some(Zed)),
        (".idea without IDEA", vec![VsCode, Zed], false, true, Some(VsCode)),
        ("neither", vec![Zed, IntellijIdea], false, false, Some(Zed)),
        ("none installed", vec![], true, true, None),
    ] {
        assert_eq!(preselect(&installed, vscode, idea), want, "{name}");
    }
}

#[cfg(unix)]
#[test]
fn a_checkout_holds_a_branch_only_by_its_own_head() {
    let scratch = common::ScratchDir::new("editor-head");
    let main = scratch.join("main");
    std::fs::create_dir_all(main.join(".git")).unwrap();
    assert!(!checkout_holds_branch(&main, "b"), "no HEAD");
    std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/b\n").unwrap();
    assert!(checkout_holds_branch(&main, "b"));
    assert!(!checkout_holds_branch(&main, "c"), "another branch");
    std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/bb\n").unwrap();
    assert!(!checkout_holds_branch(&main, "b"), "a branch this name is only a prefix of");
    std::fs::write(main.join(".git/HEAD"), "0123456789012345678901234567890123456789\n").unwrap();
    assert!(!checkout_holds_branch(&main, "b"), "a detached HEAD");

    // A linked worktree: `.git` is a gitfile, absolute or relative.
    let linked = scratch.join("linked");
    let entry = scratch.join("store/worktrees/linked");
    std::fs::create_dir_all(&linked).unwrap();
    std::fs::create_dir_all(&entry).unwrap();
    std::fs::write(entry.join("HEAD"), "ref: refs/heads/feat/x\n").unwrap();
    std::fs::write(linked.join(".git"), format!("gitdir: {}\n", entry.display())).unwrap();
    assert!(checkout_holds_branch(&linked, "feat/x"));
    std::fs::write(linked.join(".git"), "gitdir: ../store/worktrees/linked\n").unwrap();
    assert!(checkout_holds_branch(&linked, "feat/x"), "a relative gitfile");
    std::fs::write(linked.join(".git"), "not a gitfile\n").unwrap();
    assert!(!checkout_holds_branch(&linked, "feat/x"));

    // A `.git` link is no checkout (the engine refuses it too, `checkouts.ts`), and neither is a linked HEAD.
    let by_link = scratch.join("by-link");
    std::fs::create_dir_all(&by_link).unwrap();
    std::os::unix::fs::symlink(main.join(".git"), by_link.join(".git")).unwrap();
    std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/b\n").unwrap();
    assert!(!checkout_holds_branch(&by_link, "b"));
    let linked_head = scratch.join("linked-head");
    std::fs::create_dir_all(linked_head.join(".git")).unwrap();
    std::os::unix::fs::symlink(main.join(".git/HEAD"), linked_head.join(".git/HEAD")).unwrap();
    assert!(!checkout_holds_branch(&linked_head, "b"));
}

#[cfg(unix)]
mod with_a_sandbox {
    use super::*;
    use daily_briefing_gui_lib::app_prefs::{read_prefs, AppPrefs, ProjectKey, APP_PREFS_FILE};
    use daily_briefing_gui_lib::editor::{sample_identities, EditorChoice};
    use daily_briefing_gui_lib::engine::{Engine, EngineClient};
    use daily_briefing_gui_lib::live_gate::{LiveEnv, Visibility};
    use daily_briefing_gui_lib::repos::{accept_stat_inputs, parse_action_facts, status, B2StatInputs, ReposIpcRequest, ReposLive};
    use daily_briefing_gui_lib::schedule_state::Now;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;
    use tauri::test::{mock_builder, MockRuntime};
    use tauri::{App, Manager};

    const GUI_PROJECT: &str = "9fbb6e9f98a6074f844482cda9171850";
    const ROOT_PROJECT: &str = "032fa4562bc7b051317d2a37a7291db8";
    const OTHER_KEY: &str = "00000000000000000000000000000001";

    /// One selected blocking read waits on a condition variable. Drop always releases it, including on a red run.
    struct StatStall {
        calls: Arc<AtomicUsize>,
        blocked_call: Arc<AtomicUsize>,
        started: Arc<tokio::sync::Semaphore>,
        release: Arc<(Mutex<bool>, std::sync::Condvar)>,
    }

    impl StatStall {
        fn new(rig: &mut Rig) -> Self {
            let stall = Self {
                calls: Arc::new(AtomicUsize::new(0)),
                blocked_call: Arc::new(AtomicUsize::new(usize::MAX)),
                started: Arc::new(tokio::sync::Semaphore::new(0)),
                release: Arc::new((Mutex::new(false), std::sync::Condvar::new())),
            };
            let (calls, blocked_call, started, release) = (
                stall.calls.clone(), stall.blocked_call.clone(), stall.started.clone(), stall.release.clone(),
            );
            rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
                if calls.fetch_add(1, Ordering::SeqCst) == blocked_call.load(Ordering::SeqCst) {
                    started.add_permits(1);
                    let (lock, ready) = &*release;
                    let (_guard, timeout) = ready.wait_timeout_while(
                        lock.lock().unwrap(), Duration::from_secs(45), |released| !*released,
                    ).unwrap();
                    assert!(!timeout.timed_out(), "the test did not release its blocked read");
                }
            }));
            stall
        }

        fn block_after(&self, reads: usize) {
            self.blocked_call.store(self.calls.load(Ordering::SeqCst) + reads, Ordering::SeqCst);
        }

        async fn wait(&self) {
            tokio::time::timeout(Duration::from_secs(10), self.started.acquire()).await
                .expect("the selected read started").unwrap().forget();
        }

        fn release(&self) {
            let (lock, ready) = &*self.release;
            *lock.lock().unwrap() = true;
            ready.notify_all();
        }
    }

    impl Drop for StatStall {
        fn drop(&mut self) {
            self.release();
        }
    }

    struct Rig {
        _scratch: common::ScratchDir,
        root: PathBuf,
        home: PathBuf,
        config: PathBuf,
        store: PathBuf,
        prefs: AppPrefs,
        app: App<MockRuntime>,
        repos_client: EngineClient,
        env: LiveEnv,
        live: ReposLive,
    }

    impl Rig {
        /// A sandbox config through the production reader, and an engine answering the fixture's reply with its facts
        /// materialised under the scratch root. `.git/HEAD` holds the fixture's checked-out branch.
        fn new(tag: &str) -> Self {
            let scratch = common::ScratchDir::new(tag);
            let root = std::fs::canonicalize(&scratch.path).expect("the root");
            let (state, xdg, record, home) = (root.join("state"), root.join("xdg"), root.join("record"), root.join("home"));
            for d in [&state, &xdg, &record, &home] {
                std::fs::create_dir_all(d).expect("a sandbox folder");
            }
            let config = xdg.join("config.json");
            let program = common::files_sidecar(&root, "config-engine.sh", &state, &config, &record);
            let app = mock_builder()
                .manage(Engine(Ok(EngineClient::with_program(program))))
                .build(tauri::generate_context!())
                .expect("mock app");

            let fx: Value = serde_json::from_str(include_str!("fixtures/action-facts-vectors.json")).expect("the fixture");
            let mut doc = fx["reply"].clone();
            doc["repos"] = json!([]);
            doc["actionFacts"] = common::materialise_action_facts(&root, &fx["actionFacts"]);
            std::fs::write(root.join("repo/.git/HEAD"), "ref: refs/heads/feature/contract\n").expect("HEAD");
            std::fs::write(root.join("all.json"), doc.to_string()).expect("all.json");
            let body = format!("cat > /dev/null\ncat {}", common::sq(&root.join("all.json").display().to_string()));
            let repos_client = EngineClient::with_program(common::fake_sidecar(&root, "repos-engine.sh", &body));
            let env = LiveEnv::default()
                .with_visibility(Arc::new(|| Visibility { visible: true, minimized: false }))
                .with_clock(Arc::new(|| Now { local_date: "2026-01-11".into(), minutes: 600, epoch_secs: 1_000 }));
            let store = root.join("app-data");
            Rig {
                _scratch: scratch,
                root,
                home,
                config,
                store,
                prefs: AppPrefs::default(),
                app,
                repos_client,
                env,
                live: ReposLive::default(),
            }
        }

        fn set_config(&self, config: Value) {
            std::fs::write(&self.config, config.to_string()).expect("the config");
        }

        /// A real folder under the scratch root, for a config to name.
        fn folder(&self, name: &str) -> String {
            let path = self.root.join(name);
            std::fs::create_dir_all(&path).expect("a folder");
            path.display().to_string()
        }

        fn env_with<'a>(&'a self, detector: &'a dyn EditorDetector, on_macos: bool) -> EditorEnv<'a> {
            EditorEnv { prefs: &self.prefs, store_dir: &self.store, home: &self.home, detector, on_macos }
        }

        /// One full check through the production `status`, which holds the identities.
        async fn ask(&self) -> Value {
            self.ask_page("2026-01-11").await
        }

        async fn ask_page(&self, page_date: &str) -> Value {
            let request: ReposIpcRequest = serde_json::from_value(json!({
                "labels": [{ "key": "repo", "tokens": [] }, { "key": "gui", "tokens": ["5fab0a2"] }],
                "branches": [{ "key": "gui", "name": "feature/contract" }],
                "pageDate": page_date,
                "reason": "first",
                "current": "whatYouDid",
            }))
            .expect("a well-formed ask");
            let visible = || Visibility { visible: true, minimized: false };
            status(&self.repos_client, &self.env, visible, &self.live, request).await.expect("the check").0
        }

        async fn editor_handle(&self) -> String {
            handle_of(&self.ask().await, "editor")
        }

        async fn list(&self, detector: &dyn EditorDetector, handle: Option<&str>) -> Value {
            let request: EditorListRequest = serde_json::from_value(match handle {
                Some(h) => json!({ "handle": h }),
                None => json!({}),
            })
            .expect("a request");
            let reply = list_editors(self.app.state::<Engine>(), &self.live, &self.env_with(detector, true), request).await;
            let reply = serde_json::to_value(&reply).expect("a reply");
            let text = reply.to_string();
            assert!(!text.contains(self.root.to_str().unwrap()), "a path crossed: {text}");
            reply
        }

        async fn open(&self, detector: &dyn EditorDetector, handle: &str, editor: Value) -> (Value, Vec<Vec<String>>) {
            let launcher = RecordingLauncher::default();
            let replied = self.open_into(detector, handle, editor, &launcher).await;
            (replied, launcher.argv.into_inner().unwrap())
        }

        async fn open_into(&self, detector: &dyn EditorDetector, handle: &str, editor: Value, launcher: &RecordingLauncher) -> Value {
            let request: EditorOpenRequest = serde_json::from_value(json!({ "handle": handle, "editor": editor })).expect("a request");
            let reply = open_folder(&self.live, true, detector, launcher, request).await;
            serde_json::to_value(&reply).expect("a reply")
        }

        async fn choose(&self, project: Value, editor: Value) -> Value {
            let detector = FakeDetector::default();
            let request: EditorChoiceRequest = serde_json::from_value(json!({ "project": project, "editor": editor })).expect("a request");
            let reply = set_choice(self.app.state::<Engine>(), &self.live, &self.env_with(&detector, true), request).await;
            serde_json::to_value(&reply).expect("a reply")
        }

        fn folder_argv(&self, bundle: &str) -> Vec<String> {
            ["/usr/bin/open", "-b", bundle, self.root.join("repo/apps/gui").to_str().unwrap()].map(String::from).to_vec()
        }
    }

    fn handle_of(reply: &Value, target: &str) -> String {
        reply["actions"].as_array().expect("actions").iter().filter(|c| c["cardKind"] == "leftOff")
            .flat_map(|c| c["handles"].as_array().expect("handles")).find(|h| h["target"] == target)
            .unwrap_or_else(|| panic!("no {target}: {reply}"))["handle"].as_str().expect("a handle").to_string()
    }

    fn not_checked(label: &str) -> Value {
        json!({ "project": null, "label": label, "choice": null, "availability": "not-checked" })
    }

    fn ready(project: &str, label: &str, choice: Value) -> Value {
        json!({ "project": project, "label": label, "choice": choice, "availability": "ready" })
    }

    /* ── off macOS (B2 `:65`; `engine::mac_only`'s own text is calendar text, so it must never show) ────── */

    #[tokio::test(flavor = "multi_thread")]
    async fn off_macos_every_command_refuses_unsupported_with_the_editor_code() {
        let rig = Rig::new("editor-off-mac");
        rig.set_config(json!({ "repos": [rig.folder("a")] }));
        let handle = rig.editor_handle().await;
        let detector = FakeDetector::with(&[VS_CODE]);
        let env = rig.env_with(&detector, false);
        let unsupported = json!({ "refused": "unsupported" });

        let list: EditorListRequest = serde_json::from_value(json!({})).unwrap();
        let reply = list_editors(rig.app.state::<Engine>(), &rig.live, &env, list).await;
        assert_eq!(serde_json::to_value(&reply).unwrap(), unsupported);

        let launcher = RecordingLauncher::default();
        let open: EditorOpenRequest = serde_json::from_value(json!({ "handle": handle, "editor": "vs-code" })).unwrap();
        let reply = open_folder(&rig.live, false, &detector, &launcher, open).await;
        assert_eq!(serde_json::to_value(&reply).unwrap(), unsupported);
        assert!(launcher.argv.lock().unwrap().is_empty());

        let choice: EditorChoiceRequest = serde_json::from_value(json!({ "project": GUI_PROJECT, "editor": "zed" })).unwrap();
        let reply = set_choice(rig.app.state::<Engine>(), &rig.live, &env, choice).await;
        assert_eq!(serde_json::to_value(&reply).unwrap(), unsupported);
        assert!(!rig.store.join(APP_PREFS_FILE).exists(), "the refusal wrote the choice");
    }

    /* ── editor_list: installed editors and preselect (B2 `:74-76`) ──────────────────────────────────── */

    #[tokio::test(flavor = "multi_thread")]
    async fn the_list_holds_installed_editors_in_enum_order_with_one_row_per_edition_pair() {
        let rig = Rig::new("editor-installed");
        rig.set_config(json!({}));
        for (ids, want) in [
            (vec![ZED, VS_CODE], json!([{ "editor": "vs-code", "label": "VS Code" }, { "editor": "zed", "label": "Zed" }])),
            (vec![IDEA, IDEA_CE], json!([{ "editor": "intellij-idea", "label": "IntelliJ IDEA" }])),
            (vec![IDEA_CE], json!([{ "editor": "intellij-idea", "label": "IntelliJ IDEA" }])),
            (vec![PYCHARM_CE], json!([{ "editor": "pycharm", "label": "PyCharm" }])),
            (vec![], json!([])),
        ] {
            let reply = rig.list(&FakeDetector::with(&ids), None).await;
            assert_eq!(reply["editors"], want, "{ids:?}");
            assert!(reply.get("preselect").is_none(), "no handle, no member: {reply}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_held_editor_handle_preselects_from_its_own_sub_project_folder() {
        let rig = Rig::new("editor-preselect");
        rig.set_config(json!({}));
        let handle = rig.editor_handle().await;
        let folder = rig.root.join("repo/apps/gui");
        let both = FakeDetector::with(&[ZED, VS_CODE, IDEA]);

        // A marker at the checkout root alone is ignored for a sub-project folder.
        std::fs::create_dir_all(rig.root.join("repo/.vscode")).unwrap();
        assert_eq!(rig.list(&both, Some(&handle)).await["preselect"], json!("vs-code"), "the first installed");
        let reply = rig.list(&FakeDetector::with(&[ZED, VS_CODE]), Some(&handle)).await;
        assert_eq!(reply["preselect"], json!("vs-code"), "the first installed, not the root's marker");
        assert_eq!(rig.list(&FakeDetector::with(&[ZED, IDEA]), Some(&handle)).await["preselect"], json!("zed"), "no marker here");

        std::fs::create_dir_all(rig.root.join("repo/.idea")).unwrap();
        assert_eq!(rig.list(&FakeDetector::with(&[ZED, IDEA]), Some(&handle)).await["preselect"], json!("zed"), "root-only .idea is ignored");
        std::fs::create_dir_all(folder.join(".idea")).unwrap();
        assert_eq!(rig.list(&both, Some(&handle)).await["preselect"], json!("intellij-idea"), "root-only .vscode cannot beat the folder's .idea");
        assert_eq!(rig.list(&FakeDetector::with(&[ZED, IDEA]), Some(&handle)).await["preselect"], json!("intellij-idea"));
        std::fs::create_dir_all(folder.join(".vscode")).unwrap();
        assert_eq!(rig.list(&both, Some(&handle)).await["preselect"], json!("vs-code"), "both: VS Code, the enum's first");
        assert_eq!(rig.list(&FakeDetector::with(&[ZED]), Some(&handle)).await["preselect"], json!("zed"), "neither installed");

        // None installed is a null member, unlike no handle's absent one.
        let none = rig.list(&FakeDetector::default(), Some(&handle)).await;
        assert_eq!(none.get("preselect"), Some(&Value::Null), "{none}");
    }

    /// A configured subdirectory's roots reach its checkout through the subdirectory (`src/repos/checkouts.ts`): the same
    /// relative path at the checkout's top, with its own marker, is another folder.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_configured_subdirectory_preselects_and_opens_inside_itself() {
        let rig = Rig::new("editor-subdirectory");
        let (configured, target) = (rig.root.join("repo/apps/gui"), rig.root.join("repo/apps/gui/pkg/a"));
        std::fs::create_dir_all(target.join(".vscode")).unwrap();
        std::fs::create_dir_all(rig.root.join("repo/pkg/a/.idea")).unwrap();
        rig.set_config(json!({ "repos": [configured.to_str().unwrap()] }));
        let path = rig.root.join("all.json");
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc["actionFacts"][0]["path"] = json!(configured.to_str().unwrap());
        doc["actionFacts"][0]["roots"][0]["root"] = json!("apps/gui");
        doc["actionFacts"][0]["roots"][1]["root"] = json!("apps/gui/pkg/a");
        std::fs::write(&path, doc.to_string()).unwrap();
        let handle = rig.editor_handle().await;
        let reply = rig.list(&FakeDetector::with(&[VS_CODE, IDEA]), Some(&handle)).await;
        assert_eq!(reply["preselect"], json!("vs-code"), "the folder's own marker, not the top's");
        let projects: Vec<&str> = reply["projects"].as_array().unwrap().iter().map(|p| p["project"].as_str().unwrap()).collect();
        assert_eq!(projects, [ROOT_PROJECT, GUI_PROJECT], "the configured row resolves to its roots: {reply}");
        let (replied, argv) = rig.open(&FakeDetector::with(&[VS_CODE]), &handle, json!("vs-code")).await;
        assert_eq!(replied, json!({ "opened": true }));
        assert_eq!(argv, vec![["/usr/bin/open", "-b", VS_CODE, target.to_str().unwrap()].map(String::from).to_vec()]);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_handle_that_is_not_a_held_editor_handle_refuses_stale() {
        let rig = Rig::new("editor-list-stale");
        rig.set_config(json!({}));
        let reply = rig.ask().await;
        let detector = FakeDetector::with(&[VS_CODE]);
        let stale = json!({ "refused": "stale" });
        assert_eq!(rig.list(&detector, Some("0000.0.0000")).await, stale, "unknown");
        assert_eq!(rig.list(&detector, Some(&handle_of(&reply, "branch"))).await, stale, "another target");
    }

    /* ── editor_list: the configured inventory (C4, R2-O4, R4-2, R3-L10) ────────────────────────────────── */

    #[tokio::test(flavor = "multi_thread")]
    async fn before_the_first_check_the_configured_repos_are_listed_unchecked() {
        let rig = Rig::new("editor-config-first");
        rig.set_config(json!({ "repos": [rig.folder("one"), rig.folder("two")] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!(reply["projects"], json!([not_checked("one"), not_checked("two")]));
        assert_eq!(reply["discoveryConfigured"], json!(false));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_held_repo_lists_its_resolved_roots_and_a_later_added_repo_is_not_checked_yet() {
        let rig = Rig::new("editor-config-merge");
        let repo = rig.root.join("repo").display().to_string();
        rig.set_config(json!({ "repos": [repo] }));
        rig.ask().await;
        let resolved = json!([ready(ROOT_PROJECT, "Repo", Value::Null), ready(GUI_PROJECT, "GUI", Value::Null)]);
        assert_eq!(rig.list(&FakeDetector::default(), None).await["projects"], resolved);

        // The current config is read on each call: a repo added after the held check is listed, with no key.
        rig.set_config(json!({ "repos": [repo, rig.folder("later")] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!(
            reply["projects"],
            json!([ready(ROOT_PROJECT, "Repo", Value::Null), ready(GUI_PROJECT, "GUI", Value::Null), not_checked("later")])
        );

        // A resolved root stays while its repo is no longer in the current config (an accepted record can name it).
        rig.set_config(json!({ "repos": [rig.folder("later")] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!(
            reply["projects"],
            json!([not_checked("later"), ready(ROOT_PROJECT, "Repo", Value::Null), ready(GUI_PROJECT, "GUI", Value::Null)])
        );
    }

    /// A row reads as Resume does: the card's label as written, not the key `norm` made of it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_row_shows_its_cards_label_as_written() {
        let rig = Rig::new("editor-display-label");
        rig.set_config(json!({}));
        let path = rig.root.join("all.json");
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc["actionFacts"][0]["roots"][1]["labelKeys"] = json!(["quant stocks"]);
        doc["actionFacts"][0]["roots"][1]["displayLabel"] = json!("Quant Stocks");
        // One the projection would refuse falls back, rather than reaching the screen.
        doc["actionFacts"][0]["roots"][0]["displayLabel"] = json!("[redacted]");
        std::fs::write(&path, doc.to_string()).unwrap();
        rig.ask().await;
        assert_eq!(
            rig.list(&FakeDetector::default(), None).await["projects"],
            json!([ready(ROOT_PROJECT, "repo", Value::Null), ready(GUI_PROJECT, "Quant Stocks", Value::Null)])
        );
    }

    /// A line or paragraph separator is refused as it is on a configured row (`configured_label`): each source falls through.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resolved_label_with_a_line_separator_falls_through() {
        let rig = Rig::new("editor-label-separator");
        rig.set_config(json!({}));
        let path = rig.root.join("all.json");
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc["actionFacts"][0]["roots"][0]["labelKeys"] = json!([]);
        doc["actionFacts"][0]["roots"][0]["displayLabel"] = json!("Root\u{2028}Label");
        doc["actionFacts"][0]["roots"][1]["labelKeys"] = json!(["gui\u{2029}key", "gui"]);
        doc["actionFacts"][0]["roots"][1]["displayLabel"] = json!("Quant\u{2029}Stocks");
        std::fs::write(&path, doc.to_string()).unwrap();
        rig.ask().await;
        assert_eq!(
            rig.list(&FakeDetector::default(), None).await["projects"],
            json!([ready(ROOT_PROJECT, "repo", Value::Null), ready(GUI_PROJECT, "gui", Value::Null)])
        );
    }

    /// With no accepted run record a root has no card keys (`checkouts.ts`), so its row shows the repo's own name. The engine
    /// also lists a checked repo no label names today with such a root: a project with a choice, not "Not checked yet".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_root_with_no_usable_card_key_shows_its_repos_name() {
        let rig = Rig::new("editor-config-name");
        rig.set_config(json!({}));
        let path = rig.root.join("all.json");
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc["actionFacts"][0]["roots"][0]["labelKeys"] = json!([]);
        doc["actionFacts"][0]["roots"][0]["displayLabel"] = Value::Null;
        doc["actionFacts"][0]["roots"][1]["labelKeys"] = json!(["[redacted]", "gui"]);
        doc["actionFacts"][0]["roots"][1]["displayLabel"] = Value::Null;
        std::fs::write(&path, doc.to_string()).unwrap();
        rig.ask().await;
        assert_eq!(
            rig.list(&FakeDetector::default(), None).await["projects"],
            json!([ready(ROOT_PROJECT, "repo", Value::Null), ready(GUI_PROJECT, "gui", Value::Null)])
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_ready_row_with_no_safe_card_key_or_repo_name_shows_not_checked_yet() {
        let rig = Rig::new("editor-ready-unsafe-label");
        rig.set_config(json!({}));
        let path = rig.root.join("all.json");
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        doc["actionFacts"][0]["roots"][0]["labelKeys"] = json!([]);
        doc["actionFacts"][0]["roots"][0]["displayLabel"] = Value::Null;
        doc["actionFacts"][0]["roots"][1]["labelKeys"] = json!(["[redacted]"]);
        doc["actionFacts"][0]["roots"][1]["displayLabel"] = Value::Null;
        doc["repoViews"][0]["name"] = json!("unsafe\nrepo");
        std::fs::write(&path, doc.to_string()).unwrap();
        rig.ask().await;
        assert_eq!(
            rig.list(&FakeDetector::default(), None).await["projects"],
            json!([ready(ROOT_PROJECT, "Not checked yet", Value::Null), ready(GUI_PROJECT, "Not checked yet", Value::Null)])
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rows_naming_one_real_path_merge_and_a_stored_choice_shows_on_its_row() {
        let rig = Rig::new("editor-config-dupes");
        let repo = rig.root.join("repo");
        std::os::unix::fs::symlink(&repo, rig.root.join("alias")).unwrap();
        std::os::unix::fs::symlink(rig.folder("plain"), rig.root.join("plain-alias")).unwrap();
        rig.set_config(json!({ "repos": [
            repo.display().to_string(),
            rig.root.join("alias").display().to_string(),
            format!("{}/", repo.display()),
            rig.root.join("repo/apps/gui").display().to_string(),
            rig.root.join("plain").display().to_string(),
            rig.root.join("plain-alias").display().to_string(),
        ] }));
        rig.ask().await;
        assert_eq!(rig.choose(json!(GUI_PROJECT), json!("zed")).await, json!({ "saved": true, "revision": 1 }));
        assert_eq!(rig.choose(json!(ROOT_PROJECT), json!("ask")).await, json!({ "saved": true, "revision": 2 }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!(
            reply["projects"],
            json!([ready(ROOT_PROJECT, "Repo", json!("ask")), ready(GUI_PROJECT, "GUI", json!("zed")), not_checked("plain")])
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn tildes_expand_against_the_injected_home_and_exclusions_match_as_the_engine_does() {
        let rig = Rig::new("editor-config-tilde");
        std::fs::create_dir_all(rig.home.join("code/kept")).unwrap();
        std::fs::create_dir_all(rig.home.join("code/gone")).unwrap();
        std::fs::create_dir_all(rig.home.join("code/by-name")).unwrap();
        std::fs::create_dir_all(rig.home.join("code/Case")).unwrap();
        rig.set_config(json!({
            "repos": ["~/code/kept", "~/code/gone", "~/code/by-name", "~\\code\\backslash", "~/code/Case", "~"],
            "excludeRepos": ["~/code/gone/", "by-name/", "case"],
        }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        // `~` is the injected home, and its basename shows. Exclusions are exact and case-sensitive, with a trailing slash
        // tolerated on the entry, so `case` drops nothing.
        let home = rig.home.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            reply["projects"],
            json!([not_checked("kept"), not_checked(if cfg!(windows) { "backslash" } else { "code\\backslash" }), not_checked("Case"), not_checked(home)])
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn discovery_alone_is_a_flag_with_no_rows_and_explicit_repos_take_precedence() {
        let rig = Rig::new("editor-config-discovery");
        rig.set_config(json!({ "discoverRoots": ["~/code"] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!((&reply["projects"], &reply["discoveryConfigured"]), (&json!([]), &json!(true)));

        rig.set_config(json!({ "repos": [], "discoverRoots": ["~/code"] }));
        assert_eq!(rig.list(&FakeDetector::default(), None).await["discoveryConfigured"], json!(true), "an empty list is absent");

        rig.set_config(json!({ "repos": [rig.folder("x")], "discoverRoots": ["~/code"] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!((&reply["projects"], &reply["discoveryConfigured"]), (&json!([not_checked("x")]), &json!(false)));

        // Every explicit repo excluded: the list is still explicit, as `discoverRepos` treats it.
        rig.set_config(json!({ "repos": [rig.folder("x")], "discoverRoots": ["~/code"], "excludeRepos": ["x"] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!((&reply["projects"], &reply["discoveryConfigured"]), (&json!([]), &json!(false)));

        rig.set_config(json!({ "discoverRoots": [] }));
        let reply = rig.list(&FakeDetector::default(), None).await;
        assert_eq!((&reply["projects"], &reply["discoveryConfigured"]), (&json!([]), &json!(false)), "the empty state");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_hostile_basename_never_crosses_and_a_credential_shaped_one_follows_the_config_reader() {
        let rig = Rig::new("editor-config-hostile");
        let parent = rig.root.join("p").display().to_string();
        for (basename, want) in [
            ("evil\u{7}name", "Not checked yet"),
            ("evil\u{202e}name", "Not checked yet"),
            ("evil\u{200b}name", "Not checked yet"),
            ("evil\nname", "Not checked yet"),
            ("evil\u{2028}name", "Not checked yet"),
            ("evil\u{2029}name", "Not checked yet"),
            ("ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
        ] {
            rig.set_config(json!({ "repos": [format!("{parent}/{basename}")] }));
            assert_eq!(rig.list(&FakeDetector::default(), None).await["projects"], json!([not_checked(want)]), "{basename:?}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn missing_config_is_the_empty_state_and_an_unusable_one_is_a_detection_failure() {
        let rig = Rig::new("editor-config-failures");
        rig.set_config(json!({ "repos": [rig.folder("a")] }));
        assert_eq!(rig.list(&FakeDetector::default(), None).await["projects"], json!([not_checked("a")]));
        // Held facts do not retain an inventory once the config is gone.
        rig.ask().await;

        std::fs::remove_file(&rig.config).unwrap();
        let reply = rig.list(&FakeDetector::with(&[VS_CODE]), None).await;
        assert_eq!((&reply["projects"], &reply["discoveryConfigured"]), (&json!([]), &json!(false)), "{reply}");
        assert_eq!(reply["editors"], json!([{ "editor": "vs-code", "label": "VS Code" }]));

        let failed = json!({ "failed": "detection" });
        for text in ["{not json", "[1]", "\"text\"", "{\"repos\":\"a\"}", "{\"repos\":[1]}", "{\"excludeRepos\":{}}", "{\"discoverRoots\":null}"] {
            std::fs::write(&rig.config, text).unwrap();
            assert_eq!(rig.list(&FakeDetector::default(), None).await, failed, "{text}");
        }

        std::fs::remove_file(&rig.config).unwrap();
        let elsewhere = rig.root.join("elsewhere.json");
        std::fs::write(&elsewhere, "{}").unwrap();
        std::os::unix::fs::symlink(&elsewhere, &rig.config).unwrap();
        assert_eq!(rig.list(&FakeDetector::default(), None).await, failed, "a symlinked config");
    }

    /* ── editor_open (B2 `:69`, `:73`, `:75-76`) ────────────────────────────────────────────────────────── */

    #[tokio::test(flavor = "multi_thread")]
    async fn a_positive_launch_gets_exact_argv_and_prefers_the_paid_edition() {
        let rig = Rig::new("editor-launch");
        let handle = rig.editor_handle().await;
        for (ids, editor, bundle) in [
            (vec![VS_CODE, ZED], "vs-code", VS_CODE),
            (vec![VS_CODE, ZED], "zed", ZED),
            (vec![IDEA, IDEA_CE], "intellij-idea", IDEA),
            (vec![IDEA_CE], "intellij-idea", IDEA_CE),
            (vec![PYCHARM, PYCHARM_CE], "pycharm", PYCHARM),
            (vec![PYCHARM_CE], "pycharm", PYCHARM_CE),
        ] {
            let (replied, argv) = rig.open(&FakeDetector::with(&ids), &handle, json!(editor)).await;
            assert_eq!((replied, argv), (json!({ "opened": true }), vec![rig.folder_argv(bundle)]), "{editor} with {ids:?}");
        }
        assert!(rig.live.holds_handle(&handle), "a launch does not spend the handle");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unheld_or_foreign_handle_and_a_bad_editor_reach_no_launcher() {
        let rig = Rig::new("editor-open-refusals");
        let reply = rig.ask().await;
        let handle = handle_of(&reply, "editor");
        let detector = FakeDetector::with(&[VS_CODE]);
        let stale = (json!({ "refused": "stale" }), vec![]);
        assert_eq!(rig.open(&detector, "0000.0.0000", json!("vs-code")).await, stale, "never minted");
        assert_eq!(rig.open(&detector, &handle_of(&reply, "branch"), json!("vs-code")).await, stale, "another target");

        let no_editor = (json!({ "refused": "no-editor" }), vec![]);
        assert_eq!(rig.open(&FakeDetector::default(), &handle, json!("vs-code")).await, no_editor, "none installed");
        assert_eq!(rig.open(&detector, &handle, json!("zed")).await, no_editor, "the remembered editor was removed");
        for bad in [json!("ask"), json!("emacs"), json!(null), json!(7), json!({ "zed": null }), json!(["zed"])] {
            assert_eq!(rig.open(&detector, &handle, bad.clone()).await, no_editor, "{bad}");
        }
        // An absent editor is the same refusal, not an IPC argument error.
        let request: EditorOpenRequest = serde_json::from_value(json!({ "handle": handle })).expect("editor is read raw");
        let launcher = RecordingLauncher::default();
        let replied = open_folder(&rig.live, true, &detector, &launcher, request).await;
        assert_eq!(serde_json::to_value(&replied).unwrap(), json!({ "refused": "no-editor" }));
        assert!(serde_json::from_value::<EditorOpenRequest>(json!({ "handle": "h", "editor": "zed", "path": "/x" })).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_launcher_failure_answers_the_fixed_code_without_its_words() {
        let rig = Rig::new("editor-launch-fail");
        let handle = rig.editor_handle().await;
        let launcher = RecordingLauncher { fail: true, ..RecordingLauncher::default() };
        let replied = rig.open_into(&FakeDetector::with(&[VS_CODE]), &handle, json!("vs-code"), &launcher).await;
        assert_eq!(replied, json!({ "failed": "editor" }));
        assert_eq!(launcher.argv.lock().unwrap().len(), 1);
    }

    /// B2 `:69`: identities, containment and the checkout's branch, read again at the launch. Each of these changes only
    /// what no stat input covers, so the fingerprint stays quiet and this check alone refuses.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_moved_replaced_or_escaping_folder_or_a_checkout_off_its_branch_refuses_invalid_folder() {
        let detector = FakeDetector::with(&[VS_CODE]);
        let invalid = (json!({ "refused": "invalid-folder" }), vec![]);
        for change in [
            "moved",
            "replaced by a new folder",
            "a link out of the checkout",
            "a link inside the checkout",
            "another branch checked out",
            "HEAD gone",
        ] {
            let rig = Rig::new("editor-folder");
            let handle = rig.editor_handle().await;
            let folder = rig.root.join("repo/apps/gui");
            let aside = rig.root.join("repo/apps/aside");
            let head = rig.root.join("repo/.git/HEAD");
            match change {
                "moved" => std::fs::rename(&folder, &aside).unwrap(),
                "replaced by a new folder" => {
                    // The old folder stays alive, so the new one cannot reuse its inode.
                    std::fs::rename(&folder, &aside).unwrap();
                    std::fs::create_dir(&folder).unwrap();
                }
                "a link out of the checkout" => {
                    std::fs::rename(&folder, &aside).unwrap();
                    std::os::unix::fs::symlink(rig.folder("outside"), &folder).unwrap();
                }
                "a link inside the checkout" => {
                    std::fs::rename(&folder, &aside).unwrap();
                    std::os::unix::fs::symlink(&aside, &folder).unwrap();
                    assert!(aside.is_dir(), "the same folder, under another name");
                }
                "another branch checked out" => std::fs::write(&head, "ref: refs/heads/main\n").unwrap(),
                "HEAD gone" => std::fs::remove_file(&head).unwrap(),
                other => unreachable!("{other}"),
            }
            let got = rig.open(&detector, &handle, json!("vs-code")).await;
            assert_eq!(got, invalid, "{change}");
            assert!(rig.live.holds_handle(&handle), "{change}: the fingerprint refused it, not this check");
        }
    }

    /// Only the checkout inode changes: the folder, its canonical path and all git metadata are moved back intact, so the
    /// stat inputs still match and the answer is the identity comparison's: a fingerprint refusal would be `stale`.
    #[tokio::test(flavor = "multi_thread")]
    async fn replacing_only_the_checkout_identity_refuses_invalid_folder() {
        use std::os::unix::fs::MetadataExt;
        let rig = Rig::new("editor-checkout-identity");
        let handle = rig.editor_handle().await;
        let repo = rig.root.join("repo");
        let folder = repo.join("apps/gui");
        let id = |p: &std::path::Path| {
            let m = std::fs::metadata(p).unwrap();
            (m.dev(), m.ino())
        };
        let (checkout_before, folder_before) = (id(&repo), id(&folder));
        let aside = rig.root.join("repo-aside");
        std::fs::rename(&repo, &aside).unwrap();
        std::fs::create_dir(&repo).unwrap();
        std::fs::rename(aside.join(".git"), repo.join(".git")).unwrap();
        std::fs::rename(aside.join("apps"), repo.join("apps")).unwrap();
        assert_ne!(id(&repo), checkout_before);
        assert_eq!(id(&folder), folder_before, "the folder itself is unchanged");
        assert_eq!(std::fs::canonicalize(&folder).unwrap(), folder);
        assert!(checkout_holds_branch(&repo, "feature/contract"));
        let (replied, argv) = rig.open(&FakeDetector::with(&[VS_CODE]), &handle, json!("vs-code")).await;
        assert_eq!(replied, json!({ "refused": "invalid-folder" }));
        assert!(argv.is_empty());
    }

    /// A folder already bad when the check runs has no baseline at all, so no later read can match one: a link out of the
    /// checkout is not sampled, and neither is a checkout whose held path is not its own canonical path.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_hold_step_samples_only_a_folder_inside_a_checkout_at_its_own_path() {
        let rig = Rig::new("editor-sample");
        let (repo, folder) = (rig.root.join("repo"), rig.root.join("repo/apps/gui"));
        let text = std::fs::read_to_string(rig.root.join("all.json")).unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        let mut facts = parse_action_facts(Some(doc["actionFacts"].clone()));
        assert_eq!(facts.len(), 1);
        let held = repo.to_str().unwrap().to_string();
        let key = |checkout: &str, root: &str| (checkout.to_string(), root.to_string());

        let accepted = accept_stat_inputs(&facts, &B2StatInputs::default());
        let sampled = sample_identities(&facts, &accepted);
        assert!(sampled.contains_key(&key(&held, "")) && sampled.contains_key(&key(&held, "apps/gui")), "{sampled:?}");

        // A checkout path that is a link to the real one.
        let alias = rig.root.join("alias");
        std::os::unix::fs::symlink(&repo, &alias).unwrap();
        let by_alias = alias.to_str().unwrap().to_string();
        for branch in facts[0].branches.iter_mut().flatten() {
            if branch.checkout_path.is_some() {
                branch.checkout_path = Some(by_alias.clone());
            }
        }
        assert!(sample_identities(&facts, &accepted).is_empty(), "a checkout held by a link's path");

        // The folder a link out of the checkout before the check, through the production hold step.
        std::fs::rename(&folder, rig.root.join("repo/apps/aside")).unwrap();
        std::os::unix::fs::symlink(rig.folder("outside"), &folder).unwrap();
        let handle = rig.editor_handle().await;
        let got = rig.open(&FakeDetector::with(&[VS_CODE]), &handle, json!("vs-code")).await;
        assert_eq!(got, (json!({ "refused": "invalid-folder" }), vec![]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn refused_repos_have_no_identity_samples() {
        let rig = Rig::new("editor-refused-sample");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(rig.root.join("all.json")).unwrap()).unwrap();
        let mut facts = parse_action_facts(Some(doc["actionFacts"].clone()));
        let mut refused = facts[0].clone();
        refused.repo_key = "r000000000001".into();
        refused.stat_inputs = None; // no stat inputs means this repo can never mint
        let ignored = rig.folder("ignored/apps/gui");
        let ignored_checkout = rig.root.join("ignored").display().to_string();
        assert!(std::path::Path::new(&ignored).is_dir());
        for branch in refused.branches.iter_mut().flatten() {
            if branch.checkout_path.is_some() {
                branch.checkout_path = Some(ignored_checkout.clone());
            }
        }
        facts.push(refused);
        let accepted = accept_stat_inputs(&facts, &B2StatInputs::default());
        assert!(accepted.holds(&facts[0].repo_key));
        assert!(!accepted.holds(&facts[1].repo_key));
        let sampled = sample_identities(&facts, &accepted);
        assert!(sampled.contains_key(&(rig.root.join("repo").display().to_string(), "apps/gui".into())));
        assert!(!sampled.keys().any(|(checkout, _)| checkout == &ignored_checkout),
            "a refused repo's checkout/root product must not be read");
    }

    /// The baseline is what the hold step sampled, not what the click last saw: the same folder back in place launches.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_put_back_after_a_refusal_launches_again() {
        let rig = Rig::new("editor-folder-back");
        let handle = rig.editor_handle().await;
        let folder = rig.root.join("repo/apps/gui");
        let aside = rig.root.join("repo/apps/aside");
        std::fs::rename(&folder, &aside).unwrap();
        let detector = FakeDetector::with(&[VS_CODE]);
        assert_eq!(rig.open(&detector, &handle, json!("vs-code")).await.0, json!({ "refused": "invalid-folder" }));
        std::fs::rename(&aside, &folder).unwrap();
        assert_eq!(rig.open(&detector, &handle, json!("vs-code")).await.0, json!({ "opened": true }));
    }

    /// R2-O3: T7's fingerprint is checked immediately before the launch, and a change clears every handle.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_changed_source_refuses_stale_before_any_launch() {
        let rig = Rig::new("editor-source");
        let handle = rig.editor_handle().await;
        std::fs::write(rig.root.join("repo/.git/config"), "[core]\n\tchanged = true\n").unwrap();
        assert!(rig.live.holds_handle(&handle), "nothing has looked yet");
        let got = rig.open(&FakeDetector::with(&[VS_CODE]), &handle, json!("vs-code")).await;
        assert_eq!(got, (json!({ "refused": "stale" }), vec![]));
        assert!(!rig.live.holds_handle(&handle));

        // The reciprocal metadata: the checkout's `.git` turned into a link is a change the fingerprint sees.
        let rig = Rig::new("editor-source-link");
        let handle = rig.editor_handle().await;
        let stored = rig.root.join("stored-git");
        std::fs::rename(rig.root.join("repo/.git"), &stored).unwrap();
        std::os::unix::fs::symlink(&stored, rig.root.join("repo/.git")).unwrap();
        let got = rig.open(&FakeDetector::with(&[VS_CODE]), &handle, json!("vs-code")).await;
        assert_eq!(got, (json!({ "refused": "stale" }), vec![]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_ask_during_the_folder_read_refuses_stale_without_launching() {
        let mut rig = Rig::new("editor-read-page");
        let stall = StatStall::new(&mut rig);
        let handle = rig.editor_handle().await;
        stall.block_after(1); // let the fingerprint pass, then hold folder verification
        let detector = FakeDetector::with(&[VS_CODE]);
        let launcher = RecordingLauncher::default();
        let open = rig.open_into(&detector, &handle, json!("vs-code"), &launcher);
        let invalidate = async {
            stall.wait().await;
            rig.ask_page("2026-01-10").await;
            assert!(!rig.live.holds_handle(&handle), "the page ask must end this handle");
            stall.release();
        };
        let (reply, ()) = tokio::join!(open, invalidate);
        assert_eq!(reply, json!({ "refused": "stale" }));
        assert!(launcher.argv.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_stuck_inventory_keeps_github_working_and_starts_only_one_blocked_read() {
        use daily_briefing_gui_lib::access::OpenSink;
        use daily_briefing_gui_lib::actions::{open_handle, OpenGithubRequest};
        #[derive(Default)]
        struct Opener(Mutex<Vec<String>>);
        impl OpenSink for Opener {
            fn open_url(&self, url: &str) -> Result<(), String> {
                self.0.lock().unwrap().push(url.to_string());
                Ok(())
            }
            fn reveal(&self, _: &std::path::Path) -> Result<(), String> {
                panic!("a GitHub click must not reveal a file")
            }
        }
        let mut rig = Rig::new("editor-inventory-stuck");
        rig.set_config(json!({ "repos": [rig.root.join("repo")] }));
        let stall = StatStall::new(&mut rig);
        let reply = rig.ask().await;
        let handle = handle_of(&reply, "branch");
        stall.block_after(0);
        let detector = FakeDetector::with(&[VS_CODE]);
        let opener = Opener::default();
        let list = rig.list(&detector, None);
        let while_stuck = async {
            stall.wait().await;
            let first = rig.list(&detector, None).await;
            assert_eq!(first, json!({ "failed": "detection" }));
            assert_eq!(stall.calls.load(Ordering::SeqCst), stall.blocked_call.load(Ordering::SeqCst) + 1,
                "a second inventory read must wait on the same lane");
            let reply = open_handle(&rig.live, OpenGithubRequest { handle }, true, &opener).await;
            let opened = serde_json::to_value(reply).unwrap();
            stall.release(); // release before asserting, even when the base answers stale
            assert_eq!(opened, json!({ "opened": true }));
            assert_eq!(*opener.0.lock().unwrap(), vec!["https://github.com/org/repo/tree/feature/contract"]);
        };
        let (listed, ()) = tokio::join!(list, while_stuck);
        assert_eq!(listed, json!({ "failed": "detection" }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_folder_read_timeout_refuses_invalid_folder_and_never_launches_late() {
        let mut rig = Rig::new("editor-read-timeout");
        let stall = StatStall::new(&mut rig);
        let handle = rig.editor_handle().await;
        stall.block_after(1); // mint and fingerprint pass; the third B2 sample blocks
        let detector = FakeDetector::with(&[VS_CODE]);
        let launcher = RecordingLauncher::default();
        let reply = rig.open_into(&detector, &handle, json!("vs-code"), &launcher).await;
        assert_eq!(reply, json!({ "refused": "invalid-folder" }));
        assert!(launcher.argv.lock().unwrap().is_empty());
        assert!(rig.live.holds_handle(&handle), "only the folder read timed out");
        stall.release();
        rig.live.check_before_sink().await; // drain the click lane after the blocked work ends
        assert!(launcher.argv.lock().unwrap().is_empty(), "no late launch after the read finishes");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_inventory_read_timeout_answers_failed_detection() {
        let mut rig = Rig::new("editor-list-timeout");
        rig.set_config(json!({ "repos": [rig.root.join("repo")] }));
        let stall = StatStall::new(&mut rig);
        stall.block_after(0);
        let reply = rig.list(&FakeDetector::default(), None).await;
        stall.release();
        assert_eq!(reply, json!({ "failed": "detection" }));
    }

    /* ── editor_choice_set (R2-O7, R5-L2) ───────────────────────────────────────────────────────────────── */

    #[tokio::test(flavor = "multi_thread")]
    async fn a_known_key_is_in_the_inventory_or_already_stored_and_anything_else_writes_nothing() {
        let rig = Rig::new("editor-choice-known");
        let repo = rig.root.join("repo").display().to_string();
        rig.set_config(json!({ "repos": [repo] }));
        rig.ask().await;

        // Refused before any write: a key in neither place, and anything that is not a key's shape.
        let stale = json!({ "refused": "stale" });
        for project in [json!(OTHER_KEY), json!("nothex"), json!(null), json!(7), json!({ "k": 1 })] {
            assert_eq!(rig.choose(project.clone(), json!("zed")).await, stale, "{project}");
        }
        assert!(!rig.store.join(APP_PREFS_FILE).exists());

        // In the inventory, and still after a generation bump: invalidation ends handles, not a project's stable key.
        assert_eq!(rig.choose(json!(GUI_PROJECT), json!("zed")).await, json!({ "saved": true, "revision": 1 }));
        std::fs::write(rig.root.join("repo/.git/config"), "[core]\n\tchanged = true\n").unwrap();
        rig.live.check_before_sink().await;
        assert_eq!(rig.choose(json!(GUI_PROJECT), json!("cursor")).await, json!({ "saved": true, "revision": 2 }));

        // Stored and no longer in the inventory: it can still change, to an editor or "ask".
        rig.prefs.set_editor_choice(&rig.store, ProjectKey::parse(OTHER_KEY).unwrap(), EditorChoice::Ask).unwrap();
        assert_eq!(rig.choose(json!(OTHER_KEY), json!("zed")).await, json!({ "saved": true, "revision": 4 }));
        assert_eq!(rig.choose(json!(OTHER_KEY), json!("ask")).await, json!({ "saved": true, "revision": 5 }));
        let stored = read_prefs(&rig.store);
        assert_eq!(stored.editor_choices[&ProjectKey::parse(OTHER_KEY).unwrap()], EditorChoice::Ask);
        assert_eq!(stored.editor_choices[&ProjectKey::parse(GUI_PROJECT).unwrap()], EditorChoice::Editor(EditorId::Cursor));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_null_or_unknown_editor_refuses_unknown_editor_with_no_write() {
        let rig = Rig::new("editor-choice-value");
        rig.set_config(json!({ "repos": [rig.root.join("repo").display().to_string()] }));
        rig.ask().await;
        for bad in [json!(null), json!("emacs"), json!(7), json!({ "zed": null }), json!(["zed"]), json!("")] {
            assert_eq!(rig.choose(json!(GUI_PROJECT), bad.clone()).await, json!({ "refused": "unknown-editor" }), "{bad}");
        }
        assert!(!rig.store.join(APP_PREFS_FILE).exists());
        // An absent editor is the same refusal, read raw.
        let request: EditorChoiceRequest = serde_json::from_value(json!({ "project": GUI_PROJECT })).expect("read raw");
        let detector = FakeDetector::default();
        let reply = set_choice(rig.app.state::<Engine>(), &rig.live, &rig.env_with(&detector, true), request).await;
        assert_eq!(serde_json::to_value(&reply).unwrap(), json!({ "refused": "unknown-editor" }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_full_store_and_a_closed_store_answer_their_own_codes() {
        let rig = Rig::new("editor-choice-full");
        let longest = EditorChoice::Editor(EditorId::IntellijIdea);
        let mut i = 0u32;
        while rig.prefs.set_editor_choice(&rig.store, ProjectKey::parse(&format!("{i:032x}")).unwrap(), longest).is_ok() {
            i += 1;
        }
        let before = std::fs::read(rig.store.join(APP_PREFS_FILE)).unwrap();
        rig.set_config(json!({ "repos": [rig.root.join("repo").display().to_string()] }));
        rig.ask().await;
        assert_eq!(rig.choose(json!(GUI_PROJECT), json!("intellij-idea")).await, json!({ "refused": "preferences-full" }));
        assert_eq!(std::fs::read(rig.store.join(APP_PREFS_FILE)).unwrap(), before);

        drop(rig.prefs.close_for_uninstall());
        assert_eq!(rig.choose(json!(GUI_PROJECT), json!("intellij-idea")).await, json!({ "failed": "preferences" }));
    }
}
