//! B2-M4-T10 and T11 — "Open in editor" (B2 spec `:65-76`): the closed set of editors it can launch, the value a project's
//! stored choice can hold, detecting which are installed, the choice's inventory, and the launch. macOS only.
//!
//! The tokens are the wire and file form. `gui/tests-web/app-prefs.check.ts` reads this file as text
//! and pins [`EditorId`]'s list against the union in `app-prefs-store.ts`, so each token stays a
//! literal `rename` here, in B2 `:67`'s order.
//!
//! ⚠ THE BODIES HERE TAKE NO PATH FROM THE WEBVIEW. A launch names a handle and an editor; the folder is read from what
//! Rust holds for that handle, and no reply carries a folder. The `#[tauri::command]` wrappers are at the end.
//!
//! ⚠ A LAUNCH RE-READS THE DISK (B2 `:69`). [`crate::repos::ReposLive::check_before_sink`] covers the reciprocal worktree
//! metadata, because the engine reports the gitfile, `gitdir` and `commondir` of each used checkout as stat inputs. The
//! folder itself and `HEAD` are not stat inputs (they move too often), so this module checks those: the two file
//! identities against the baseline the hold step sampled ([`sample_identities`], [`hold_identities`]), containment, and
//! that the checkout still holds the branch. Any failure is `invalid-folder`; another checkout is never opened instead.
//!
//! ⚠ TWO TRAITS SO THE SUITE NEVER ASKS LAUNCHSERVICES OR OPENS ANYTHING (plan §0.6), as `access::OpenSink` does for URLs.
//! Only the two `System*` types touch macOS, and everything else here compiles and runs on the Linux CI job (R5-M15).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::de::{Deserialize, Deserializer, IntoDeserializer};
use serde::{Serialize, Serializer};
use serde_json::Value;
use tauri::{AppHandle, Runtime, State};

use crate::access::{expand_tilde, AccessState};
use crate::actions::{HeldTarget, HeldTargets, TargetFacts};
use crate::app_prefs::{read_prefs, AppPrefs, AppPrefsError, ProjectKey};
use crate::briefing_files::read_text_capped;
use crate::config_save::config_read;
use crate::engine::{is_refused_format_character, mac_only, Engine, EngineError};
use crate::repos::{is_project_key, is_safe_action_label, B2StatInputs, ProjectRoot, RepoFacts, ReposLive};

/// One supported editor. An unknown token deserializes to an error; there is no catch-all variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
pub enum EditorId {
    #[serde(rename = "vs-code")]
    VsCode,
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "windsurf")]
    Windsurf,
    #[serde(rename = "zed")]
    Zed,
    #[serde(rename = "sublime-text")]
    SublimeText,
    #[serde(rename = "xcode")]
    Xcode,
    #[serde(rename = "intellij-idea")]
    IntellijIdea,
    #[serde(rename = "pycharm")]
    Pycharm,
    #[serde(rename = "webstorm")]
    Webstorm,
    #[serde(rename = "goland")]
    Goland,
    #[serde(rename = "rustrover")]
    Rustrover,
    #[serde(rename = "clion")]
    Clion,
    #[serde(rename = "rider")]
    Rider,
    #[serde(rename = "rubymine")]
    Rubymine,
    #[serde(rename = "phpstorm")]
    Phpstorm,
    #[serde(rename = "datagrip")]
    Datagrip,
}

impl EditorId {
    /// Every editor, in B2 `:67`'s order: the order the chooser lists them and preselection falls back through.
    pub const ALL: [EditorId; 16] = [
        Self::VsCode,
        Self::Cursor,
        Self::Windsurf,
        Self::Zed,
        Self::SublimeText,
        Self::Xcode,
        Self::IntellijIdea,
        Self::Pycharm,
        Self::Webstorm,
        Self::Goland,
        Self::Rustrover,
        Self::Clion,
        Self::Rider,
        Self::Rubymine,
        Self::Phpstorm,
        Self::Datagrip,
    ];

    /// The bundle ids this editor can launch, the paid edition before the community one (B2 `:75`).
    pub fn bundle_ids(self) -> &'static [&'static str] {
        match self {
            Self::VsCode => &["com.microsoft.VSCode"],
            Self::Cursor => &["com.todesktop.230313mzl4w4u92"],
            Self::Windsurf => &["com.exafunction.windsurf"],
            Self::Zed => &["dev.zed.Zed"],
            Self::SublimeText => &["com.sublimetext.4"],
            Self::Xcode => &["com.apple.dt.Xcode"],
            Self::IntellijIdea => &["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
            Self::Pycharm => &["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
            Self::Webstorm => &["com.jetbrains.WebStorm"],
            Self::Goland => &["com.jetbrains.goland"],
            Self::Rustrover => &["com.jetbrains.rustrover"],
            Self::Clion => &["com.jetbrains.CLion"],
            Self::Rider => &["com.jetbrains.rider"],
            Self::Rubymine => &["com.jetbrains.rubymine"],
            Self::Phpstorm => &["com.jetbrains.PhpStorm"],
            Self::Datagrip => &["com.jetbrains.datagrip"],
        }
    }

    /// The chooser's name for it: G-TEXT's defaults until that gate approves them (plan R5-M6).
    pub fn label(self) -> &'static str {
        match self {
            Self::VsCode => "VS Code",
            Self::Cursor => "Cursor",
            Self::Windsurf => "Windsurf",
            Self::Zed => "Zed",
            Self::SublimeText => "Sublime Text",
            Self::Xcode => "Xcode",
            Self::IntellijIdea => "IntelliJ IDEA",
            Self::Pycharm => "PyCharm",
            Self::Webstorm => "WebStorm",
            Self::Goland => "GoLand",
            Self::Rustrover => "RustRover",
            Self::Clion => "CLion",
            Self::Rider => "Rider",
            Self::Rubymine => "RubyMine",
            Self::Phpstorm => "PhpStorm",
            Self::Datagrip => "DataGrip",
        }
    }
}

/// The token for "ask each time". Never an editor token.
const ASK: &str = "ask";

/// A project's stored choice: an editor, or "ask each time". "Never chosen" is the absence of an
/// entry, not a value, so `null` is refused.
///
/// The serde impls are written out because `#[serde(untagged)]` reads a unit variant from `null`,
/// which would turn a stored `null` into "ask".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorChoice {
    Editor(EditorId),
    Ask,
}

impl Serialize for EditorChoice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Editor(id) => id.serialize(serializer),
            Self::Ask => serializer.serialize_str(ASK),
        }
    }
}

impl<'de> Deserialize<'de> for EditorChoice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let token = String::deserialize(deserializer)?;
        if token == ASK {
            return Ok(Self::Ask);
        }
        EditorId::deserialize(IntoDeserializer::<D::Error>::into_deserializer(token))
            .map(Self::Editor)
    }
}

/* ── the sinks ────────────────────────────────────────────────────────────────────────────────── */

/// Whether a bundle is installed.
pub trait EditorDetector: Send + Sync {
    fn is_installed(&self, bundle_id: &str) -> bool;
}

/// Where a launch ends up. It gets the whole argv, so a test pins exactly what would run.
pub trait EditorSink: Send + Sync {
    fn launch(&self, argv: &[String]) -> Result<(), String>;
}

/// The shipping detector: LaunchServices through `NSWorkspace`, which opens and reveals nothing (B2 `:66`). Off macOS, no
/// editor is installed.
pub struct SystemEditorDetector;

#[cfg(target_os = "macos")]
impl EditorDetector for SystemEditorDetector {
    fn is_installed(&self, bundle_id: &str) -> bool {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;
        NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
            .is_some()
    }
}

#[cfg(not(target_os = "macos"))]
impl EditorDetector for SystemEditorDetector {
    fn is_installed(&self, _bundle_id: &str) -> bool {
        false
    }
}

/// The shipping launcher: the argv as given, no shell, output discarded (precedent `calendar_details::SystemCalendarApp`).
/// Off macOS it is never reached: every command has already refused `unsupported`.
pub struct SystemEditorSink;

#[cfg(target_os = "macos")]
impl EditorSink for SystemEditorSink {
    fn launch(&self, argv: &[String]) -> Result<(), String> {
        let (program, args) = argv.split_first().ok_or("no program")?;
        let status = std::process::Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| "spawn".to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("exit".to_string())
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl EditorSink for SystemEditorSink {
    fn launch(&self, _argv: &[String]) -> Result<(), String> {
        Err("unsupported".to_string())
    }
}

/// What the three bodies read besides their request. The commands build it from managed state ([`EditorState::env`]).
pub struct EditorEnv<'a> {
    pub prefs: &'a AppPrefs,
    /// The preference store's folder.
    pub store_dir: &'a Path,
    /// What a config's `~` means, the production home in the app.
    pub home: &'a Path,
    pub detector: &'a dyn EditorDetector,
    /// `cfg!(target_os = "macos")` in the app, a parameter so both answers are testable (`engine::mac_only`).
    pub on_macos: bool,
}

/* ── the held folder (B2 `:68-69`) ────────────────────────────────────────────────────────────── */

/// What an editor target's folder is: the checkout's and the folder's file identities, as `(device, inode)`, and the
/// folder's canonical path. The path counts because a link can put the same directory back under the held name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderIdentity {
    checkout: (u64, u64),
    folder: (u64, u64),
    path: PathBuf,
}

/// [`FolderIdentity`]s read for a full check's facts, by `(checkout, root)`.
pub type FolderIdentities = BTreeMap<(String, String), FolderIdentity>;

#[cfg(unix)]
fn directory_id(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    meta.is_dir().then(|| (meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn directory_id(_path: &Path) -> Option<(u64, u64)> {
    None // no launch happens off macOS
}

/// The target folder as it is now: `checkout` still at that exact canonical path, and the folder a directory inside it,
/// canonicalised. `None` for anything else, including a link leading out.
fn read_folder(checkout: &str, root: &str) -> Option<FolderIdentity> {
    let held = Path::new(checkout);
    let canonical = std::fs::canonicalize(held).ok()?;
    if canonical != held {
        return None;
    }
    let folder = if root.is_empty() { canonical.clone() } else { std::fs::canonicalize(held.join(root)).ok()? };
    if !folder.starts_with(&canonical) {
        return None;
    }
    Some(FolderIdentity { checkout: directory_id(&canonical)?, folder: directory_id(&folder)?, path: folder })
}

/// The hold step's sample, outside the pure mint: every checkout and root an accepted repo's editor target could join.
/// `status` takes it after stat acceptance in the same bounded read, so a refused repo's folders cost no other handles.
pub fn sample_identities(facts: &[RepoFacts], accepted: &B2StatInputs) -> FolderIdentities {
    let mut sampled = FolderIdentities::new();
    for f in facts.iter().filter(|f| accepted.holds(&f.repo_key)) {
        let roots = f.roots.as_deref().unwrap_or_default();
        for checkout in f.branches.iter().flatten().filter_map(|b| b.checkout_path.as_deref()) {
            for root in roots {
                let key = (checkout.to_string(), root.root.clone());
                if !sampled.contains_key(&key) {
                    if let Some(identity) = read_folder(checkout, &root.root) {
                        sampled.insert(key, identity);
                    }
                }
            }
        }
    }
    sampled
}

/// Give each minted editor target its baseline. One left without any refuses `invalid-folder` at the click.
pub fn hold_identities(minted: &mut HeldTargets, sampled: &FolderIdentities) {
    for held in minted.values_mut() {
        if let TargetFacts::Editor { checkout, root, .. } = &held.target {
            held.identity = sampled.get(&(checkout.clone(), root.clone())).cloned();
        }
    }
}

/// The most a `HEAD` or gitfile takes: a ref name or a path, never close to this.
const MAX_GIT_POINTER_BYTES: u64 = 8 * 1024;

/// Whether the checkout has this branch checked out now (B2 `:68`): its own `HEAD`, through a `.git` directory or gitfile.
/// A linked `.git` or `HEAD` is refused, as the engine's own check refuses a linked `.git` (`src/repos/checkouts.ts`).
pub fn checkout_holds_branch(checkout: &Path, branch: &str) -> bool {
    let dotgit = checkout.join(".git");
    let Ok(meta) = std::fs::symlink_metadata(&dotgit) else { return false };
    let git_dir = if meta.is_dir() {
        dotgit
    } else if meta.is_file() {
        let Ok(text) = read_text_capped(&dotgit, MAX_GIT_POINTER_BYTES) else { return false };
        let Some(target) = text.strip_prefix("gitdir: ").map(|t| t.strip_suffix('\n').unwrap_or(t)) else { return false };
        if target.is_empty() || target.contains('\n') {
            return false;
        }
        checkout.join(target)
    } else {
        return false;
    };
    let Ok(head) = read_text_capped(&git_dir.join("HEAD"), MAX_GIT_POINTER_BYTES) else { return false };
    head.strip_suffix('\n').unwrap_or(&head) == format!("ref: refs/heads/{branch}")
}

/// An editor handle's private half.
#[derive(Clone)]
struct HeldFolder {
    checkout: String,
    root: String,
    branch: String,
    identity: Option<FolderIdentity>,
}

impl HeldFolder {
    /// `None` for any handle that is not an editor target.
    fn of(held: &HeldTarget) -> Option<Self> {
        let TargetFacts::Editor { checkout, root, branch, .. } = &held.target else { return None };
        Some(Self { checkout: checkout.clone(), root: root.clone(), branch: branch.clone(), identity: held.identity.clone() })
    }

    /// B2 `:69`: the folder to open, when it still is what the hold step sampled, still inside the checkout, and the
    /// checkout still holds the branch.
    fn verified(&self) -> Option<String> {
        let now = read_folder(&self.checkout, &self.root)?;
        if self.identity.as_ref() != Some(&now) || !checkout_holds_branch(Path::new(&self.checkout), &self.branch) {
            return None;
        }
        now.path.to_str().map(str::to_string)
    }

    /// Which of B2 `:74`'s markers the verified folder holds, itself and not the checkout root: `(.vscode, .idea)`.
    fn markers(&self) -> (bool, bool) {
        let Some(folder) = self.verified() else { return (false, false) };
        let has = |name: &str| std::fs::symlink_metadata(Path::new(&folder).join(name)).is_ok_and(|m| m.is_dir());
        (has(".vscode"), has(".idea"))
    }
}

/* ── editor_open (B2 `:76`) ───────────────────────────────────────────────────────────────────── */

/// `editor_open { request: { handle, editor } }`. `editor` is read raw and mapped, so a bad value answers with the reply's
/// own refusal rather than an IPC argument error (plan, build checkpoint B2-M4-T10).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorOpenRequest {
    pub handle: String,
    #[serde(default)]
    pub editor: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorOpenReply {
    Opened(bool),
    Refused(EditorOpenRefusal),
    Failed(EditorFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditorOpenRefusal {
    Unsupported,
    Stale,
    NoEditor,
    InvalidFolder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorFailure {
    Editor,
}

/// The editor a raw request value names: a string token, never `"ask"`. `EditorId`'s derived deserializer alone would
/// also take `{"zed": null}`; [`EditorChoice`]'s reads a string first.
fn named_editor(raw: &Value) -> Option<EditorId> {
    match EditorChoice::deserialize(raw) {
        Ok(EditorChoice::Editor(id)) => Some(id),
        _ => None,
    }
}

/// What will be launched, before the disk is read again: a held editor handle, then an installed bundle (`:75`).
fn judge_launch(
    held: Option<&HeldTarget>,
    editor: &Value,
    detector: &dyn EditorDetector,
) -> Result<(HeldFolder, &'static str), EditorOpenRefusal> {
    let folder = held.and_then(HeldFolder::of).ok_or(EditorOpenRefusal::Stale)?;
    let bundle = named_editor(editor)
        .and_then(|id| id.bundle_ids().iter().copied().find(|b| detector.is_installed(b)))
        .ok_or(EditorOpenRefusal::NoEditor)?;
    Ok((folder, bundle))
}

fn launch_verified(folder: Option<String>, bundle: &str, sink: &dyn EditorSink) -> EditorOpenReply {
    let Some(folder) = folder else {
        return EditorOpenReply::Refused(EditorOpenRefusal::InvalidFolder);
    };
    let argv = ["/usr/bin/open", "-b", bundle, folder.as_str()].map(String::from);
    match sink.launch(&argv) {
        Ok(()) => EditorOpenReply::Opened(true),
        Err(_) => EditorOpenReply::Failed(EditorFailure::Editor),
    }
}

/// [`editor_open`]'s body. As for `actions::open_handle`, sources are checked FIRST and the handle resolved SECOND (plan R2-O3).
/// The folder's own read is bounded: a dead mount refuses `invalid-folder` rather than hanging the click.
pub async fn open_folder(
    live: &ReposLive,
    on_macos: bool,
    detector: &dyn EditorDetector,
    sink: &dyn EditorSink,
    request: EditorOpenRequest,
) -> EditorOpenReply {
    if mac_only(on_macos).is_err() {
        return EditorOpenReply::Refused(EditorOpenRefusal::Unsupported);
    }
    live.check_before_sink().await;
    let held = live.resolve_handle(&request.handle);
    let (folder, bundle) = match judge_launch(held.as_ref(), &request.editor, detector) {
        Err(refusal) => return EditorOpenReply::Refused(refusal),
        Ok(judged) => judged,
    };
    let verified = live.read_files_bounded(move || folder.verified()).await.flatten();
    if live.resolve_handle(&request.handle).is_none() {
        return EditorOpenReply::Refused(EditorOpenRefusal::Stale);
    }
    launch_verified(verified, bundle, sink)
}

/* ── editor_list (B2 `:76`) and the inventory (plan C4) ───────────────────────────────────────── */

/// `editor_list { request: { handle? } }`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorListRequest {
    #[serde(default)]
    pub handle: Option<String>,
}

/// One installed editor the chooser can offer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EditorRow {
    pub editor: EditorId,
    pub label: &'static str,
}

/// `ready`: an engine key, a choice and a launch. `not-checked`: configured, with no engine key yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Availability {
    Ready,
    NotChecked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectRow {
    pub project: Option<String>,
    pub label: String,
    pub choice: Option<EditorChoice>,
    pub availability: Availability,
}

/// The list. `preselect` is absent with no handle and `null` with a handle and nothing installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInventory {
    pub editors: Vec<EditorRow>,
    pub projects: Vec<ProjectRow>,
    pub discovery_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preselect: Option<Option<EditorId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum EditorListReply {
    Listed(EditorInventory),
    Refused { refused: EditorListRefusal },
    Failed { failed: EditorListFailure },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditorListRefusal {
    Unsupported,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorListFailure {
    Detection,
}

/// B2 `:74`: VS Code's marker, then IntelliJ IDEA's, each only with that editor installed, then the first installed.
pub fn preselect(installed: &[EditorId], vscode: bool, idea: bool) -> Option<EditorId> {
    let marked = [(vscode, EditorId::VsCode), (idea, EditorId::IntellijIdea)];
    marked.iter().find(|(on, editor)| *on && installed.contains(editor)).map(|(_, editor)| *editor).or(installed.first().copied())
}

/// G-TEXT's "Unresolved project row", for a configured row whose own name cannot be shown.
const NOT_CHECKED_YET: &str = "Not checked yet";

/// What the current config lists, expanded. A present member of the wrong shape is unusable text, as the engine's own
/// `loadConfig` refuses it.
struct Configured {
    repos: Vec<String>,
    discovery: bool,
}

fn parse_configured(text: &str, home: &Path) -> Option<Configured> {
    let Value::Object(config) = serde_json::from_str::<Value>(text).ok()? else { return None };
    let list = |key: &str| -> Option<Vec<String>> {
        match config.get(key) {
            None => Some(Vec::new()),
            Some(Value::Array(items)) => items.iter().map(|v| v.as_str().map(|s| expand_tilde(s, home))).collect(),
            Some(_) => None,
        }
    };
    let (repos, roots, exclude) = (list("repos")?, list("discoverRoots")?, list("excludeRepos")?);
    Some(Configured {
        discovery: repos.is_empty() && !roots.is_empty(),
        repos: repos.into_iter().filter(|p| !is_excluded(p, &exclude)).collect(),
    })
}

/// `src/config.ts`'s `isExcludedRepo`: an exact path or a basename, case-sensitive and uncanonicalised, a trailing slash
/// tolerated on the entry.
fn is_excluded(path: &str, exclude: &[String]) -> bool {
    let basename = Path::new(path).file_name().and_then(|n| n.to_str());
    exclude.iter().any(|entry| {
        let entry = entry.strip_suffix('/').unwrap_or(entry);
        entry == path || Some(entry) == basename
    })
}

/// A configured row's display name: its basename when that is plain text (R2-O4), control and format characters being the
/// only check. The config reader already shows these paths, so there is no credential check here.
fn configured_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|name| !name.chars().any(|c| c.is_control() || is_refused_format_character(c) || matches!(c, '\u{2028}' | '\u{2029}')))
        .unwrap_or(NOT_CHECKED_YET)
        .to_string()
}

/// A resolved root's display name: its card's label as written, which Resume shows too, else its first card key, else its
/// repo's name. All three are already the engine's redacted text, which lets a line or paragraph separator through.
fn resolved_label(root: &ProjectRoot, repo_name: Option<&str>) -> String {
    root.display_label.as_deref().into_iter().chain(root.label_keys.iter().map(String::as_str)).chain(repo_name)
        .find(|label| is_safe_action_label(label) && !label.contains(['\u{2028}', '\u{2029}']))
        .unwrap_or(NOT_CHECKED_YET)
        .to_string()
}

/// Current configured repos merged with the held resolved roots, by repo real path and relative root (plan C4). `configured`
/// holds each path as written and canonicalised. A root the facts list wins over its configured row, which stays only
/// while no key is known for it. Resolved roots no longer configured stay too: an accepted run record can name them.
fn merge_rows(
    configured: &[(String, PathBuf)],
    held: &[(RepoFacts, Option<String>)],
    choices: &BTreeMap<ProjectKey, EditorChoice>,
) -> Vec<ProjectRow> {
    let resolved: Vec<(&RepoFacts, &ProjectRoot, Option<&str>)> = held.iter()
        .flat_map(|(f, name)| f.roots.iter().flatten().map(move |root| (f, root, name.as_deref())))
        .filter(|(_, root, _)| is_project_key(&root.project))
        .collect();
    let mut rows = Vec::new();
    let mut listed: BTreeSet<String> = BTreeSet::new();
    let mut add = |rows: &mut Vec<ProjectRow>, root: &ProjectRoot, name: Option<&str>| {
        if listed.insert(root.project.clone()) {
            let choice = ProjectKey::parse(&root.project).and_then(|key| choices.get(&key).copied());
            rows.push(ProjectRow {
                project: Some(root.project.clone()),
                label: resolved_label(root, name),
                choice,
                availability: Availability::Ready,
            });
        }
    };
    let mut unchecked: BTreeSet<&Path> = BTreeSet::new();
    for (written, canonical) in configured {
        let matching: Vec<_> = resolved.iter()
            .filter(|(f, root, _)| Path::new(&f.path) == canonical || Path::new(&f.path).join(&root.root) == *canonical)
            .collect();
        for (_, root, name) in &matching {
            add(&mut rows, root, *name);
        }
        if matching.is_empty() && unchecked.insert(canonical) {
            rows.push(ProjectRow { project: None, label: configured_label(written), choice: None, availability: Availability::NotChecked });
        }
    }
    for (_, root, name) in &resolved {
        add(&mut rows, root, *name);
    }
    rows
}

/// The inventory `editor_list {}` returns: `(projects, discoveryConfigured)`. `Err` is a config that cannot be used. A
/// missing config is the empty state, whatever is held (plan R4-2).
async fn inventory(engine: State<'_, Engine>, live: &ReposLive, env: &EditorEnv<'_>) -> Result<(Vec<ProjectRow>, bool), ()> {
    let document = config_read(engine).await.map_err(|_| ())?;
    if !document.exists {
        return Ok((Vec::new(), false));
    }
    let text = document.text.filter(|_| document.parse_error.is_none()).ok_or(())?;
    let configured = parse_configured(&text, env.home).ok_or(())?;
    let discovery = configured.discovery;
    let canonical = live
        .read_inventory_bounded(move || {
            configured.repos.into_iter()
                .map(|written| {
                    let canonical = std::fs::canonicalize(&written).unwrap_or_else(|_| PathBuf::from(&written));
                    (written, canonical)
                })
                .collect::<Vec<_>>()
        })
        .await
        .ok_or(())?;
    let choices = read_prefs(env.store_dir).editor_choices;
    Ok((merge_rows(&canonical, &live.held_inventory(), &choices), discovery))
}

/// [`editor_list`]'s body. Never a folder in the reply.
pub async fn list_editors(engine: State<'_, Engine>, live: &ReposLive, env: &EditorEnv<'_>, request: EditorListRequest) -> EditorListReply {
    let refused = |refused| EditorListReply::Refused { refused };
    if mac_only(env.on_macos).is_err() {
        return refused(EditorListRefusal::Unsupported);
    }
    let markers = match &request.handle {
        None => None,
        Some(handle) => {
            let held = live.resolve_handle(handle);
            let Some(folder) = held.as_ref().and_then(HeldFolder::of) else {
                return refused(EditorListRefusal::Stale);
            };
            Some(live.read_inventory_bounded(move || folder.markers()).await.unwrap_or((false, false)))
        }
    };
    let Ok((projects, discovery_configured)) = inventory(engine, live, env).await else {
        return EditorListReply::Failed { failed: EditorListFailure::Detection };
    };
    let installed: Vec<EditorId> = EditorId::ALL.iter().copied()
        .filter(|id| id.bundle_ids().iter().any(|b| env.detector.is_installed(b)))
        .collect();
    EditorListReply::Listed(EditorInventory {
        editors: installed.iter().map(|id| EditorRow { editor: *id, label: id.label() }).collect(),
        projects,
        discovery_configured,
        preselect: markers.map(|(vscode, idea)| preselect(&installed, vscode, idea)),
    })
}

/* ── editor_choice_set (B2 `:76`, plan R2-O7) ─────────────────────────────────────────────────── */

/// `editor_choice_set { request: { project, editor } }`, both read raw and mapped (plan, build checkpoint B2-M4-T10).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorChoiceRequest {
    #[serde(default)]
    pub project: Value,
    #[serde(default)]
    pub editor: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum EditorChoiceReply {
    Saved { saved: bool, revision: u64 },
    Refused { refused: EditorChoiceRefusal },
    Failed { failed: EditorChoiceFailure },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditorChoiceRefusal {
    Unsupported,
    Stale,
    UnknownEditor,
    PreferencesFull,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorChoiceFailure {
    Preferences,
}

/// [`editor_choice_set`]'s body. A key is known when it is in the inventory `editor_list {}` would return now, or already
/// stored (R2-O7): a generation bump ends handles, never a Settings row's stable key. An unusable config lists no key, so
/// only a stored one can then change.
pub async fn set_choice(engine: State<'_, Engine>, live: &ReposLive, env: &EditorEnv<'_>, request: EditorChoiceRequest) -> EditorChoiceReply {
    let refused = |refused| EditorChoiceReply::Refused { refused };
    if mac_only(env.on_macos).is_err() {
        return refused(EditorChoiceRefusal::Unsupported);
    }
    let Some(project) = request.project.as_str().and_then(ProjectKey::parse) else {
        return refused(EditorChoiceRefusal::Stale);
    };
    let stored = read_prefs(env.store_dir).editor_choices.contains_key(&project);
    let known = stored
        || inventory(engine, live, env).await.is_ok_and(|(rows, _)| {
            rows.iter().any(|row| row.project.as_deref() == request.project.as_str())
        });
    if !known {
        return refused(EditorChoiceRefusal::Stale);
    }
    let Ok(choice) = EditorChoice::deserialize(&request.editor) else {
        return refused(EditorChoiceRefusal::UnknownEditor);
    };
    match env.prefs.set_editor_choice(env.store_dir, project, choice) {
        Ok(answer) => EditorChoiceReply::Saved { saved: true, revision: answer.revision },
        Err(AppPrefsError::PreferencesFull) => refused(EditorChoiceRefusal::PreferencesFull),
        Err(_) => EditorChoiceReply::Failed { failed: EditorChoiceFailure::Preferences },
    }
}

/* ── the commands (B2-M4-T12) ─────────────────────────────────────────────────────────────────── */

/// The detector and the launcher. The DEFAULT is the one place the real ones are wired up; every test manages recording
/// ones, so no test asks LaunchServices or opens an editor (plan §0.6).
pub struct EditorState {
    detector: Arc<dyn EditorDetector>,
    sink: Arc<dyn EditorSink>,
}

impl Default for EditorState {
    fn default() -> Self {
        Self { detector: Arc::new(SystemEditorDetector), sink: Arc::new(SystemEditorSink) }
    }
}

impl EditorState {
    /// **Test harness only.**
    pub fn with_detector(mut self, detector: Arc<dyn EditorDetector>) -> Self {
        self.detector = detector;
        self
    }

    /// **Test harness only.**
    pub fn with_sink(mut self, sink: Arc<dyn EditorSink>) -> Self {
        self.sink = sink;
        self
    }

    fn env<'a>(&'a self, prefs: &'a AppPrefs, store_dir: &'a Path, home: &'a Path) -> EditorEnv<'a> {
        EditorEnv { prefs, store_dir, home, detector: self.detector.as_ref(), on_macos: cfg!(target_os = "macos") }
    }
}

/// The preference store's folder for a body that reads it. `None` is a folder that cannot be resolved, which that body's
/// fixed failure answers. Off macOS the body refuses `unsupported` before it reads anything, so that answer still comes first.
fn readable_store<R: Runtime>(app: &AppHandle<R>, prefs: &AppPrefs) -> Option<PathBuf> {
    match prefs.store_dir(app) {
        Ok(dir) => Some(dir),
        Err(_) if cfg!(target_os = "macos") => None,
        Err(_) => Some(PathBuf::new()),
    }
}

/// The installed editors and the project inventory. With a held editor handle, also `preselect`. Takes no path and answers none.
#[tauri::command]
pub async fn editor_list<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    live: State<'_, ReposLive>,
    prefs: State<'_, AppPrefs>,
    access: State<'_, AccessState>,
    editors: State<'_, EditorState>,
    request: EditorListRequest,
) -> Result<EditorListReply, EngineError> {
    let Some(dir) = readable_store(&app, &prefs) else {
        return Ok(EditorListReply::Failed { failed: EditorListFailure::Detection });
    };
    let home = access.home();
    Ok(list_editors(engine, &live, &editors.env(&prefs, &dir, &home), request).await)
}

/// Open one held folder in a named editor, by handle. Takes no path. A launch reads no preference, so a store folder that
/// cannot be resolved costs it nothing.
#[tauri::command]
pub async fn editor_open(
    live: State<'_, ReposLive>,
    editors: State<'_, EditorState>,
    request: EditorOpenRequest,
) -> Result<EditorOpenReply, EngineError> {
    Ok(open_folder(&live, cfg!(target_os = "macos"), editors.detector.as_ref(), editors.sink.as_ref(), request).await)
}

/// Remember a project's editor, or "ask". Takes a stable project key and a closed token, read raw so a bad value answers
/// with this reply's own refusal.
#[tauri::command]
pub async fn editor_choice_set<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    live: State<'_, ReposLive>,
    prefs: State<'_, AppPrefs>,
    access: State<'_, AccessState>,
    editors: State<'_, EditorState>,
    request: EditorChoiceRequest,
) -> Result<EditorChoiceReply, EngineError> {
    let Some(dir) = readable_store(&app, &prefs) else {
        return Ok(EditorChoiceReply::Failed { failed: EditorChoiceFailure::Preferences });
    };
    let home = access.home();
    Ok(set_choice(engine, &live, &editors.env(&prefs, &dir, &home), request).await)
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["editor_list", "editor_open", "editor_choice_set"];
