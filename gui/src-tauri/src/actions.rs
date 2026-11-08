//! Briefing redesign B2 (wave-3 plan B2-M2-T6): the public handles Rust mints from the engine's private facts.
//!
//! [`mint_accepted`] joins each private facts entry to the reply's repo views, cards and labels by exact `repoKey`, decides
//! which actions each row and card may have (B2 `:36-42`, `:53-60`), and returns two things: the public
//! [`ActionCard`]s that cross into the webview, and the [`HeldTargets`] that stay in Rust. A click names a handle and
//! nothing else; what it opens is read from the held map (`ReposState::held_target`). Membership there is the
//! authority: a handle is opaque and is never parsed for meaning.
//!
//! ⚠ THE REPLY IS UNTRUSTED HERE. `mint` reads the engine's document BEFORE `sanitize_reply` (`actions` must be on the
//! document that is projected), so nothing below indexes or unwraps: a member of the wrong shape gives no handle.
//!
//! ⚠ WHAT IT MINTS MUST PASS THE PROJECTION. A required field that fails `repos::project` nulls the whole document, so
//! a value that would do that (a malformed project key, a redacted label) is refused here by the projection's own
//! rule and gives no handle (B2 `:25`). Malformed private facts never cost B1's rows.
//!
//! ⚠ ONLY PUBLIC VALUES ENTER THE HANDLE'S HASH (plan R5-L8). `DefaultHasher::new()` has fixed keys, so a hash over a
//! private fact would give the webview a function of private data to test guesses against. A change to a private fact
//! bumps the generation instead (T7), which is the tuple's first member.
//!
//! ⚠ A CLICK RE-JUDGES WHAT THE MINT DECIDED (B2 `:30`, `:54`). Each held target carries the private facts of its repo and
//! the row it decorates, the same values `ReposState` holds beside the reply and replaced with it. [`open_handle`] checks
//! the sources first ([`ReposLive::check_before_sink`]), resolves the handle second, and judges the target against those
//! facts third, and [`copy_handles`] does the same for each branch. That judgement is what names a refusal: the mint
//! only decides whether a button exists.

use std::collections::{BTreeMap, BTreeSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime, State};

use crate::access::{OpenSink, SystemOpener};
use crate::app_prefs::AppPrefs;
use crate::editor::FolderIdentity;
use crate::engine::EngineError;
use crate::repos::{is_project_key, is_safe_action_label, BranchFacts, RemoteFacts, RepoFacts, ReposLive, Transport};

/// The four kinds of card a handle can belong to (B2 `:27`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CardKind {
    Did,
    LeftOff,
    Push,
    Tile,
}

impl CardKind {
    /// The token the reply shows.
    pub fn as_str(self) -> &'static str {
        match self {
            CardKind::Did => "did",
            CardKind::LeftOff => "leftOff",
            CardKind::Push => "push",
            CardKind::Tile => "tile",
        }
    }
}

/// The closed set of public target kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Pr,
    Branch,
    Commit,
    Compare,
    Editor,
    Copy,
}

impl TargetKind {
    /// The token the reply shows.
    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::Pr => "pr",
            TargetKind::Branch => "branch",
            TargetKind::Commit => "commit",
            TargetKind::Compare => "compare",
            TargetKind::Editor => "editor",
            TargetKind::Copy => "copy",
        }
    }
}

/// One card's public handles (`src/repos/types.ts`, `ActionCard`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionCard {
    pub repo_key: String,
    pub card_kind: CardKind,
    pub card_id: String,
    pub handles: Vec<ActionHandle>,
}

/// One public handle. `row` is the row it decorates in that card's `rows`; `sha` is set only on a commit target,
/// `project` only on an editor target and `label` only on a compare target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionHandle {
    pub handle: String,
    pub target: TargetKind,
    pub row: Option<usize>,
    pub sha: Option<String>,
    pub project: Option<String>,
    pub label: Option<String>,
}

/// What a held handle resolves to. Private: none of this crosses, and none of it enters the handle's hash. `remote` is
/// the remote the mint established, which the click re-judges by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetFacts {
    Pr { owner: String, repo: String, remote: String, number: u64 },
    Branch { owner: String, repo: String, remote: String, remote_branch: String },
    Commit { owner: String, repo: String, remote: String, sha: String },
    Compare { owner: String, repo: String, remote: String, default_branch: String, remote_branch: String },
    /// The validated checkout and the checkout-relative root; the launch re-verifies both.
    Editor { checkout: String, root: String, project: String, branch: String },
    /// A local branch by its displayed name. The push facts are read from [`HeldTarget::facts`] at the click.
    Copy { store_key: String, branch: String },
}

impl TargetFacts {
    fn kind(&self) -> TargetKind {
        match self {
            TargetFacts::Pr { .. } => TargetKind::Pr,
            TargetFacts::Branch { .. } => TargetKind::Branch,
            TargetFacts::Commit { .. } => TargetKind::Commit,
            TargetFacts::Compare { .. } => TargetKind::Compare,
            TargetFacts::Editor { .. } => TargetKind::Editor,
            TargetFacts::Copy { .. } => TargetKind::Copy,
        }
    }
}

/// One held handle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldTarget {
    pub generation: u64,
    pub repo_key: String,
    pub card_kind: CardKind,
    pub card_id: String,
    pub target: TargetFacts,
    /// The private facts of the handle's repo, as held beside the reply it was minted from.
    pub facts: Arc<RepoFacts>,
    /// The row a What-you-did handle decorates: the held group a PR number or commit must occur in. `None` elsewhere.
    pub row: Option<Arc<Value>>,
    /// Its place in the mint, which walks each card's rows and branches in reply order: a copy's push-card order.
    pub order: usize,
    /// How many copy handles its card holds, the bound on a copy request (B2 `:82`). 0 on any other target.
    pub population: usize,
    /// An editor target's checkout and folder identities. The mint is pure, so this leaves it `None` and the hold step
    /// fills it (`editor::hold_identities`); a launch compares against it, and with none it refuses (B2 `:69`).
    pub identity: Option<FolderIdentity>,
}

/// Handle → what it resolves to. Replaced whole with each successful full mint, cleared on every generation bump.
pub type HeldTargets = BTreeMap<String, HeldTarget>;

/// The fixed-order typed tuple a handle's hash covers. Every member is already on the reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PublicTuple<'a> {
    pub generation: u64,
    pub repo_key: &'a str,
    pub card_kind: &'a str,
    pub card_id: &'a str,
    pub target: &'a str,
    pub row: Option<usize>,
    pub sha: Option<&'a str>,
    pub project: Option<&'a str>,
    pub label: Option<&'a str>,
}

impl PublicTuple<'_> {
    /// C's precedent (`calendar_details.rs`, `handle_of`): a discriminator, not an authority.
    pub fn hash_value(&self) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.hash(&mut h);
        h.finish()
    }
}

/// `^[0-9a-f]{40}$`: a commit target is a full ID, never a page prefix (B2 `:60`).
fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The highest PR number a target may name (B2 `:60`).
const MAX_PR_NUMBER: u64 = 4_294_967_295;

/// Rust's revalidation of the engine's parsed GitHub fields (B2 `:58`, O-3). The owner/repo half of
/// `github-target-vectors.json`; the credential matcher stays in the engine (plan R2-O4).
pub fn is_github_name(owner: &str, repo: &str) -> bool {
    let owner_ok = (1..=39).contains(&owner.len()) && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let repo_ok = (1..=100).contains(&repo.len())
        && repo != "."
        && repo != ".."
        && repo.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    owner_ok && repo_ok
}

/// The only member, when there is exactly one.
fn one<T>(mut items: impl Iterator<Item = T>) -> Option<T> {
    let first = items.next()?;
    items.next().is_none().then_some(first)
}

fn items<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A repo the mint may act on: its one facts entry and its one readable view.
#[derive(Clone, Copy)]
struct Repo<'a> {
    key: &'a str,
    facts: &'a RepoFacts,
    no_remote: bool,
    store_key: Option<&'a str>,
}

/// A remote branch established for a row or card, on a remote with a GitHub repository.
struct Established<'a> {
    remote: &'a RemoteFacts,
    owner: &'a str,
    repo: &'a str,
    branch: &'a str,
}

/// The one remote called `name`, when it has a valid GitHub repository.
fn github_remote<'a>(f: &'a RepoFacts, name: &str) -> Option<(&'a RemoteFacts, &'a str, &'a str)> {
    let remote = one(f.remotes.as_deref()?.iter().filter(|r| r.name == name))?;
    let github = remote.github.as_ref()?;
    is_github_name(&github.owner, &github.repo).then_some((remote, github.owner.as_str(), github.repo.as_str()))
}

fn established<'a>(f: &'a RepoFacts, remote: &str, branch: &'a str) -> Option<Established<'a>> {
    let (remote, owner, repo) = github_remote(f, remote)?;
    is_safe_action_label(branch).then_some(Established { remote, owner, repo, branch })
}

/// The one local branch of this displayed name. A redacted name has none: the facts omit it (B2 `:23`).
fn local_branch<'a>(f: &'a RepoFacts, name: &str) -> Option<&'a BranchFacts> {
    if !is_safe_action_label(name) {
        return None;
    }
    one(f.branches.as_deref()?.iter().filter(|b| b.name == name))
}

/// The remote `pushRemote`, else `pushDefault`, selects for `branch`. Neither set: none.
fn push_selection<'a>(f: &'a RepoFacts, branch: &'a BranchFacts) -> Option<&'a str> {
    branch.push_remote.as_deref().or(f.push_default.as_deref())
}

/// Whether git would really push `branch` to its upstream (plan §0). A selection of another remote says no, whatever the
/// upstream is called: `git checkout -b feat upstream/feat` with `pushRemote=origin` pushes to `origin`. Otherwise an
/// upstream of its own name says yes, and one named differently only when `push.default` is `upstream` or `tracking`; else
/// that upstream is only where the branch started, as `git checkout -b feat origin/develop` leaves it.
fn upstream_is_destination(f: &RepoFacts, branch: &BranchFacts) -> bool {
    let (Some(remote), Some(upstream)) = (branch.upstream_remote.as_deref(), branch.upstream_branch.as_deref()) else { return false };
    push_selection(f, branch).is_none_or(|selected| selected == remote) && (upstream == branch.name || f.pushes_to_upstream)
}

/// A local branch's remote counterpart (B2 `:55`): its upstream's remote branch, which must exist, when that is its real
/// destination ([`upstream_is_destination`]); else the one remote branch of the same name at the branch's own tip, on the
/// selected remote when [`push_selection`] names one, since no other holds what a push would send. A shared tip alone is a
/// coincidence: `git checkout -b wip` at `origin/main` is not `main` (B2 `:38`). Never `origin` by default, and never a
/// row's newest commit, which can be older than the branch. Unknown remote facts have none: their `None`s are not "no upstream".
fn local_counterpart<'a>(f: &'a RepoFacts, name: &str) -> Option<Established<'a>> {
    let branch = local_branch(f, name)?;
    if !branch.ref_format_ok || branch.remote_facts_unknown {
        return None;
    }
    let listed = f.remote_branches.as_deref()?;
    let entry = match (branch.upstream_remote.as_deref(), branch.upstream_branch.as_deref()) {
        (Some(remote), Some(upstream)) if upstream_is_destination(f, branch) => {
            one(listed.iter().filter(|e| e.remote == remote && e.name == upstream))?
        }
        (Some(_), Some(_)) | (None, None) => {
            let tip = branch.tip.as_deref()?;
            let selected = push_selection(f, branch);
            one(listed.iter().filter(|e| e.sha == tip && e.name == branch.name && selected.is_none_or(|s| e.remote == s)))?
        }
        _ => return None,
    };
    established(f, &entry.remote, &entry.name)
}

/// A `default` row in a repo with no local branch of that name (B2 `:39`): the one remote whose default it is. An unknown
/// local list is no such repo.
fn default_counterpart<'a>(f: &'a RepoFacts, name: &str) -> Option<Established<'a>> {
    if f.branches.as_deref()?.iter().any(|b| b.name == name) {
        return None;
    }
    let remote = one(f.remotes.as_deref()?.iter().filter(|r| r.default_branch.as_deref() == Some(name)))?;
    let entry = one(f.remote_branches.as_deref()?.iter().filter(|e| e.remote == remote.name && e.name == name))?;
    established(f, &entry.remote, &entry.name)
}

/// A `remoteBranch` row: its displayed name must equal exactly one `remote + "/" + name`. It is never split, since a
/// remote's name can hold a `/` (B2 `:20`).
fn remote_row_counterpart<'a>(f: &'a RepoFacts, shown: &str) -> Option<Established<'a>> {
    if !is_safe_action_label(shown) {
        return None;
    }
    let listed = f.remote_branches.as_deref()?;
    let entry = one(listed.iter().filter(|e| {
        shown.len() == e.remote.len() + 1 + e.name.len()
            && shown.starts_with(e.remote.as_str())
            && shown.as_bytes().get(e.remote.len()) == Some(&b'/')
            && shown.ends_with(e.name.as_str())
    }))?;
    established(f, &entry.remote, &entry.name)
}

/// Whether a row is shown to be this repo's: a card's rows can come from another repo while its `repoKey` names one
/// (`src/repos/status.ts:363-387`), and a name like `main` would then resolve in the wrong repo's facts. Every commit
/// must be in this repo's `reachableRemotes` list; an unknown list, or a row with no commit, shows nothing.
fn row_is_this_repos(f: &RepoFacts, row: &Value) -> bool {
    let Some(known) = f.reachable_remotes.as_deref() else { return false };
    let commits = items(row, "commits");
    !commits.is_empty()
        && commits.iter().all(|c| text(c, "sha").is_some_and(|sha| known.iter().any(|r| r.sha == sha)))
}

/// The row's established remote branch: a branch-naming row's only source of a remote for an ambiguous commit. A row
/// not shown to be this repo's has none.
fn row_counterpart<'a>(f: &'a RepoFacts, row: &Value) -> Option<Established<'a>> {
    if !row_is_this_repos(f, row) {
        return None;
    }
    let name = text(row, "name")?;
    match text(row, "kind")? {
        "branch" => local_counterpart(f, name),
        "default" => local_counterpart(f, name).or_else(|| default_counterpart(f, name)),
        "remoteBranch" => remote_row_counterpart(f, name),
        _ => None,
    }
}

/// The remotes holding evidence for `#number` on one of this row's commits. `None` is unknown evidence.
fn pr_holders<'a>(f: &'a RepoFacts, row: &Value, number: u64) -> Option<BTreeSet<&'a str>> {
    let shas: BTreeSet<&str> = items(row, "commits").iter().filter_map(|c| text(c, "sha")).collect();
    Some(f.pr_evidence.as_deref()?.iter()
        .filter(|e| e.number == number && shas.contains(e.sha.as_str()))
        .map(|e| e.remote.as_str())
        .collect())
}

/// How many repositories those remotes are (plan §0): `origin` and `origin-ssh` for one `owner/repo` are one, as GitHub reads
/// names, whatever their case. A remote that reads as no GitHub repository is one of its own: nothing says what it is. The
/// engine lists none as PR evidence (`src/repos/reach.ts`), and a commit counts only [`github_holders`].
fn repositories(f: &RepoFacts, remotes: &BTreeSet<&str>) -> usize {
    let distinct: BTreeSet<(String, String)> = remotes.iter()
        .map(|name| match github_remote(f, name) {
            Some((_, owner, repo)) => (owner.to_ascii_lowercase(), repo.to_ascii_lowercase()),
            None => (String::new(), (*name).to_string()),
        })
        .collect();
    distinct.len()
}

/// The remotes holding a commit that read as GitHub (plan §0): only they can be opened, so a deploy remote costs no arrow.
fn github_holders<'a>(f: &RepoFacts, remotes: &'a [String]) -> BTreeSet<&'a str> {
    remotes.iter().map(String::as_str).filter(|name| github_remote(f, name).is_some()).collect()
}

/// A PR row's target (B2 `:56`, plan §0): evidence in exactly one repository, for a commit in this row. The engine lists every
/// remote that holds the evidence commit, a GitHub one with no known default too, so a synced fork has no single owner
/// (`src/repos/reach.ts`). Of several remotes for that repository, the first by name.
fn pr_target(f: &RepoFacts, row: &Value) -> Option<TargetFacts> {
    let number = row.get("number").and_then(Value::as_u64).filter(|n| (1..=MAX_PR_NUMBER).contains(n))?;
    let remotes = pr_holders(f, row, number)?;
    if repositories(f, &remotes) != 1 {
        return None;
    }
    let (remote, owner, repo) = github_remote(f, remotes.first()?)?;
    Some(TargetFacts::Pr { owner: owner.into(), repo: repo.into(), remote: remote.name.clone(), number })
}

/// A commit's target (B2 `:55`, `:41`): the one GitHub repository holding it, under the first of its remote names, or its
/// row's established remote when that is one of several. Unknown reachability, or several with no established one, gives no link.
fn commit_target(f: &RepoFacts, sha: &str, row: Option<&Established<'_>>) -> Option<TargetFacts> {
    if !is_full_sha(sha) {
        return None;
    }
    let reach = one(f.reachable_remotes.as_deref()?.iter().filter(|r| r.sha == sha))?;
    let remotes = github_holders(f, reach.remotes.as_deref()?);
    let name = match (repositories(f, &remotes), row) {
        (1, _) => *remotes.first()?,
        (_, Some(e)) if remotes.contains(e.remote.name.as_str()) => e.remote.name.as_str(),
        _ => return None,
    };
    let (remote, owner, repo) = github_remote(f, name)?;
    Some(TargetFacts::Commit { owner: owner.into(), repo: repo.into(), remote: remote.name.clone(), sha: sha.into() })
}

fn branch_target(e: &Established<'_>) -> TargetFacts {
    TargetFacts::Branch { owner: e.owner.into(), repo: e.repo.into(), remote: e.remote.name.clone(), remote_branch: e.branch.into() }
}

/// A Compare (B2 `:57`): the selected remote's real default under a label that passes the projection. No default and
/// a self-Compare give none.
fn compare_target(e: &Established<'_>) -> Option<TargetFacts> {
    let default_branch = e.remote.default_branch.as_deref()?;
    (default_branch != e.branch && is_safe_action_label(default_branch)).then(|| TargetFacts::Compare {
        owner: e.owner.into(),
        repo: e.repo.into(),
        remote: e.remote.name.clone(),
        default_branch: default_branch.into(),
        remote_branch: e.branch.into(),
    })
}

/// An editor target (B2 `:68-70`): the branch's validated checkout, then the one root whose `labelKeys` name this
/// card exactly. A key on no root or two, and a project key the projection would refuse, give none.
fn editor_target(f: &RepoFacts, card_key: &str, branch: &BranchFacts) -> Option<TargetFacts> {
    let checkout = branch.checkout_path.as_deref()?;
    let root = one(f.roots.as_deref()?.iter().filter(|r| r.label_keys.iter().any(|k| k == card_key)))?;
    is_project_key(&root.project).then(|| TargetFacts::Editor {
        checkout: checkout.into(),
        root: root.root.clone(),
        project: root.project.clone(),
        branch: branch.name.clone(),
    })
}

/// Which facts entries and views may be acted on: joined by exact `repoKey` only (plan P-M1). A key on two entries or
/// two views, an entry with no view, and a repo unknown in the reply or in `unknownRepos` give nothing (B2 `:30`).
fn usable_repos<'a>(reply: &'a Map<String, Value>, facts: &'a [RepoFacts]) -> BTreeMap<&'a str, Repo<'a>> {
    let member = |key: &str| reply.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let unknown: BTreeSet<&str> = member("unknownRepos").iter().filter_map(Value::as_str).collect();
    let mut repos = BTreeMap::new();
    for f in facts {
        let key = f.repo_key.as_str();
        if unknown.contains(key) || facts.iter().filter(|x| x.repo_key == key).count() != 1 {
            continue;
        }
        let Some(view) = one(member("repoViews").iter().filter(|v| text(v, "key") == Some(key))) else { continue };
        if text(view, "state") != Some("ok") {
            continue;
        }
        let Some(no_remote) = view.get("noRemote").and_then(Value::as_bool) else { continue };
        repos.insert(key, Repo { key, facts: f, no_remote, store_key: text(view, "storeKey") });
    }
    repos
}

/// A Where-you-left-off card's repo. Its line carries no repo key: it is the What-you-did card's of the same key, else
/// (a label-only card, B2 `:70`) the one repo whose run record lists the key (`cardKeys`), whether or not that label's
/// folder is here: only the editor target asks that (B2 `:42`). "One" is decided over `facts`, every entry the engine
/// reported: a repo left out of `repos` still holds its keys, and must not make another's look unique.
fn left_off_repo<'a>(reply: &Map<String, Value>, facts: &[RepoFacts], repos: &BTreeMap<&'a str, Repo<'a>>, key: &str) -> Option<Repo<'a>> {
    let labels = reply.get("labels").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let mut same_key = labels.iter().filter(|l| text(l, "key") == Some(key));
    if let Some(label) = same_key.next() {
        return if same_key.next().is_none() { repos.get(text(label, "repoKey")?).copied() } else { None };
    }
    if facts.iter().any(|f| f.card_keys.is_none()) {
        return None; // an unknown key set cannot establish a unique label-only repo
    }
    let listed = one(facts.iter().filter(|f| f.card_keys.as_deref().is_some_and(|keys| keys.iter().any(|k| k == key))))?;
    repos.get(listed.repo_key.as_str()).copied()
}

/// Builds the public cards and the held map in step, so a handle cannot exist on one side alone.
struct Minter {
    generation: u64,
    next_index: usize,
    cards: Vec<ActionCard>,
    held: HeldTargets,
    /// One shared copy of each repo's facts, however many handles it mints.
    shared: BTreeMap<String, Arc<RepoFacts>>,
}

impl Minter {
    fn add(&mut self, repo: Repo<'_>, card_kind: CardKind, card_id: &str, row: Option<(usize, &Arc<Value>)>, target: TargetFacts) {
        let repo_key = repo.key;
        let facts = self.shared.entry(repo_key.to_string()).or_insert_with(|| Arc::new(repo.facts.clone())).clone();
        let (row, held_row) = row.map_or((None, None), |(index, value)| (Some(index), Some(value.clone())));
        let (sha, project, label) = match &target {
            TargetFacts::Commit { sha, .. } => (Some(sha.clone()), None, None),
            TargetFacts::Editor { project, .. } => (None, Some(project.clone()), None),
            TargetFacts::Compare { default_branch, .. } => (None, None, Some(default_branch.clone())),
            _ => (None, None, None),
        };
        let kind = target.kind();
        let hash = PublicTuple {
            generation: self.generation,
            repo_key,
            card_kind: card_kind.as_str(),
            card_id,
            target: kind.as_str(),
            row,
            sha: sha.as_deref(),
            project: project.as_deref(),
            label: label.as_deref(),
        }
        .hash_value();
        let handle = format!("{:016x}.{}.{hash:016x}", self.generation, self.next_index);
        self.next_index += 1;
        let order = self.held.len();
        self.held.insert(
            handle.clone(),
            HeldTarget {
                generation: self.generation,
                repo_key: repo_key.into(),
                card_kind,
                card_id: card_id.into(),
                target,
                facts,
                row: held_row,
                order,
                population: 0,
                identity: None,
            },
        );
        let public = ActionHandle { handle, target: kind, row, sha, project, label };
        match self.cards.iter_mut().find(|c| c.repo_key == repo_key && c.card_kind == card_kind && c.card_id == card_id) {
            Some(card) => card.handles.push(public),
            None => self.cards.push(ActionCard {
                repo_key: repo_key.into(),
                card_kind,
                card_id: card_id.into(),
                handles: vec![public],
            }),
        }
    }

    /// One What-you-did card (B2 `:36-41`). Row controls by kind; any row's commit by its own reachability.
    fn did_card(&mut self, repo: Repo<'_>, card_id: &str, rows: &[Value]) {
        for (index, row) in rows.iter().enumerate() {
            let counterpart = row_counterpart(repo.facts, row);
            let held = Arc::new(row.clone());
            if text(row, "kind") == Some("pr") {
                if let Some(target) = pr_target(repo.facts, row) {
                    self.add(repo, CardKind::Did, card_id, Some((index, &held)), target);
                }
            }
            if let Some(e) = &counterpart {
                self.add(repo, CardKind::Did, card_id, Some((index, &held)), branch_target(e));
            }
            for sha in items(row, "commits").iter().filter_map(|c| text(c, "sha")) {
                if let Some(target) = commit_target(repo.facts, sha, counterpart.as_ref()) {
                    self.add(repo, CardKind::Did, card_id, Some((index, &held)), target);
                }
            }
        }
    }

    /// One Where-you-left-off card (B2 `:42`): branch, Compare and copy on a live line of a repo with a remote; the
    /// editor on a live or `noRemote` line. A missing branch, or one the private facts do not hold, has none.
    fn left_off_card(&mut self, repo: Repo<'_>, line: &Value, key: &str) {
        let Some(name) = text(line, "name") else { return };
        let Some(branch) = local_branch(repo.facts, name) else { return };
        let state = text(line, "state");
        if !matches!(state, Some("live" | "noRemote")) {
            return;
        }
        if state == Some("live") && !repo.no_remote {
            if let Some(e) = local_counterpart(repo.facts, name) {
                self.add(repo, CardKind::LeftOff, key, None, branch_target(&e));
                if let Some(target) = compare_target(&e) {
                    self.add(repo, CardKind::LeftOff, key, None, target);
                }
            }
            let push_tag = line.get("neverPushed").and_then(Value::as_bool) == Some(true)
                || line.get("notPushed").and_then(Value::as_u64).is_some_and(|n| n > 0);
            // B2 `:42`: a live push tag AND an eligible target, so that no button is shown that could only refuse.
            let eligible = judge_copy_branch(repo.facts, name).is_ok();
            if let (true, true, Some(store_key)) = (push_tag, eligible, repo.store_key) {
                self.add(repo, CardKind::LeftOff, key, None, TargetFacts::Copy { store_key: store_key.into(), branch: name.into() });
            }
        }
        if let Some(target) = editor_target(repo.facts, key, branch) {
            self.add(repo, CardKind::LeftOff, key, None, target);
        }
    }

    /// The push cards (B2 `:43`) and the launchpad tile (`:46`). No button is shown that could only refuse (user decision
    /// 2026-11-05, as `:42` has it for Where you left off): one refused branch would refuse the whole copy at the click
    /// (`:82`), so a card with a branch [`judge_copy_branch`] refuses mints no copy handles, and leaving only that branch out
    /// would copy a shorter list. For the same reason the tile, which copies all the cards, is complete or has no handles at
    /// all: a card this mint cannot supply or that refuses costs that card its own handles and the tile all of them. A list
    /// over [`MAX_COPY_HANDLES`] would refuse the same way, so a card over it has no button, and a tile over it has none
    /// although each of its cards may. The
    /// click judges every branch again as a backstop; a change since the mint clears the handles and answers `stale`. A repo with no remote never lists a branch in
    /// a real reply (`src/repos/push.ts:175`), so one that does counts as such a card.
    fn push_and_tile(&mut self, repos: &BTreeMap<&str, Repo<'_>>, push_cards: &[Value]) {
        fn names_of(card: &Value) -> impl Iterator<Item = &str> {
            let on_default = card.get("onDefault").and_then(|d| text(d, "name"));
            items(card, "branches").iter().filter_map(|b| text(b, "name")).chain(on_default)
        }
        let copies = |repo: Repo<'_>, card: &Value| {
            names_of(card).collect::<BTreeSet<_>>().len() <= MAX_COPY_HANDLES && names_of(card).all(|name| judge_copy_branch(repo.facts, name).is_ok())
        };
        let on_the_tile: BTreeSet<(&str, &str)> = push_cards.iter()
            .filter_map(|card| text(card, "storeKey").map(|store| names_of(card).map(move |name| (store, name))))
            .flatten().collect();
        let tile_complete = on_the_tile.len() <= MAX_COPY_HANDLES && push_cards.iter().all(|card| {
            let lists_a_branch = !items(card, "branches").is_empty() || card.get("onDefault").is_some_and(|d| !d.is_null());
            let suppliable = text(card, "storeKey").is_some()
                && text(card, "repoKey").and_then(|k| repos.get(k)).is_some_and(|r| !r.no_remote && copies(*r, card));
            !lists_a_branch || suppliable
        });
        let mut on_tile: BTreeSet<(String, String)> = BTreeSet::new();
        for card in push_cards {
            let Some(repo) = text(card, "repoKey").and_then(|k| repos.get(k)).copied() else { continue };
            let Some(store_key) = text(card, "storeKey") else { continue };
            if repo.no_remote || !copies(repo, card) {
                continue;
            }
            let card_id = format!("push:{}", repo.key);
            let mut on_card = BTreeSet::new();
            for name in names_of(card) {
                if !on_card.insert(name) {
                    continue;
                }
                let target = TargetFacts::Copy { store_key: store_key.into(), branch: name.into() };
                self.add(repo, CardKind::Push, &card_id, None, target.clone());
                if tile_complete && on_tile.insert((store_key.to_string(), name.to_string())) {
                    self.add(repo, CardKind::Tile, "onlyHere", None, target);
                }
            }
        }
    }
}

/// Mint the public cards and the held map from an `all` document and its parsed facts, for `generation`. Pure. The
/// document is untrusted (the module header), and a member of the wrong shape only costs its own handles. `reply`'s
/// `unknownRepos`, when present, names repos that get no handles. So do repos `accepted` does not name (the ones whose
/// stat inputs Rust did not accept), exactly like a repo with no facts, but they still count when a label key must be unique.
pub fn mint_accepted(
    reply: &Map<String, Value>,
    facts: &[RepoFacts],
    accepted: impl Fn(&str) -> bool,
    generation: u64,
) -> (Vec<ActionCard>, HeldTargets) {
    let mut repos = usable_repos(reply, facts);
    repos.retain(|key, _| accepted(key));
    let mut minter = Minter { generation, next_index: 0, cards: Vec::new(), held: HeldTargets::new(), shared: BTreeMap::new() };
    let member = |key: &str| reply.get(key).and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    for label in member("labels") {
        let (Some(card_id), Some(repo_key)) = (text(label, "key"), text(label, "repoKey")) else { continue };
        let Some(repo) = repos.get(repo_key).copied().filter(|r| !r.no_remote) else { continue };
        // A row index names a row in ONE card: two cards under one id could not say whose.
        if member("labels").iter().filter(|l| text(l, "key") == Some(card_id)).count() == 1 {
            minter.did_card(repo, card_id, items(label, "rows"));
        }
    }
    for line in member("branchLines") {
        let Some(key) = text(line, "key") else { continue };
        // As for the cards above: two lines under one id could not say whose handles these are.
        if member("branchLines").iter().filter(|l| text(l, "key") == Some(key)).count() != 1 {
            continue;
        }
        if let Some(repo) = left_off_repo(reply, facts, &repos, key) {
            minter.left_off_card(repo, line, key);
        }
    }
    minter.push_and_tile(&repos, member("pushCards"));
    let mut populations: BTreeMap<(&'static str, String), usize> = BTreeMap::new();
    for held in minter.held.values().filter(|h| h.target.kind() == TargetKind::Copy) {
        *populations.entry((held.card_kind.as_str(), held.card_id.clone())).or_default() += 1;
    }
    for held in minter.held.values_mut().filter(|h| h.target.kind() == TargetKind::Copy) {
        held.population = populations[&(held.card_kind.as_str(), held.card_id.clone())];
    }
    (minter.cards, minter.held)
}

/* ── open_github (B2 `:53-62`) ────────────────────────────────────────────────────────────────── */

/// `open_github { request: { handle } }`. Closed: the webview names a handle, never a URL, path or branch.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenGithubRequest {
    pub handle: String,
}

/// B2 `:62`: `{opened: true}`, `{refused: <code>}` or `{failed: "opener"}`. Never a URL or the opener's own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenGithubReply {
    Opened(bool),
    Refused(OpenRefusal),
    Failed(OpenFailure),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OpenRefusal {
    Stale,
    LinksOff,
    UnknownRepo,
    NotPushed,
    InvalidTarget,
    Ambiguous,
    Host,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenFailure {
    Opener,
}

/// A branch name's path segments, or `None` for one that would not survive as a path: the url crate silently drops a
/// `.` or `..` segment and its parser drops tabs and newlines, so either would open a different branch than the one held.
fn branch_segments(name: &str) -> Option<Vec<&str>> {
    if !is_safe_action_label(name) {
        return None;
    }
    let segments: Vec<&str> = name.split('/').collect();
    segments.iter().all(|s| !matches!(*s, "" | "." | "..")).then_some(segments)
}

/// A GitHub target's URL (B2 `:57`), built by segment so that the url crate's path-segment set encodes each one and the
/// branch separators stay outside them, then re-checked as C's Join links are (`calendar_details.rs`, `joinable`).
/// `None` for anything but those four targets, or for a field that fails its rule.
pub fn github_url(target: &TargetFacts) -> Option<String> {
    let (owner, repo, tail): (&str, &str, Vec<String>) = match target {
        TargetFacts::Pr { owner, repo, number, .. } => {
            (1..=MAX_PR_NUMBER).contains(number).then_some(())?;
            (owner, repo, vec!["pull".into(), number.to_string()])
        }
        TargetFacts::Branch { owner, repo, remote_branch, .. } => {
            let mut tail = vec!["tree".to_string()];
            tail.extend(branch_segments(remote_branch)?.into_iter().map(str::to_string));
            (owner, repo, tail)
        }
        TargetFacts::Commit { owner, repo, sha, .. } => {
            is_full_sha(sha).then_some(())?;
            (owner, repo, vec!["commit".into(), sha.clone()])
        }
        TargetFacts::Compare { owner, repo, default_branch, remote_branch, .. } => {
            let (default, branch) = (branch_segments(default_branch)?, branch_segments(remote_branch)?);
            let (last, before) = default.split_last()?;
            let (first, after) = branch.split_first()?;
            let mut tail = vec!["compare".to_string()];
            tail.extend(before.iter().map(|s| s.to_string()));
            tail.push(format!("{last}...{first}"));
            tail.extend(after.iter().map(|s| s.to_string()));
            (owner, repo, tail)
        }
        TargetFacts::Editor { .. } | TargetFacts::Copy { .. } => return None,
    };
    if !is_github_name(owner, repo) {
        return None;
    }
    let mut url = url::Url::parse("https://github.com/").ok()?;
    url.path_segments_mut().ok()?.push(owner).push(repo).extend(&tail);
    let clean = url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    clean.then(|| url.to_string())
}

/// The one remote branch a Branch or Compare target names, on its own remote (B2 `:55`).
fn judge_remote_branch(f: &RepoFacts, remote: &str, branch: &str) -> Result<(), OpenRefusal> {
    let listed = f.remote_branches.as_deref().ok_or(OpenRefusal::NotPushed)?;
    match listed.iter().filter(|e| e.remote == remote && e.name == branch).count() {
        0 => Err(OpenRefusal::NotPushed),
        1 => Ok(()),
        _ => Err(OpenRefusal::Ambiguous),
    }
}

/// A PR target's held group and evidence (B2 `:56`, `:60`): its own row's number, with merge or squash evidence for one
/// of that row's commits on the remote it names, and in no other repository. Evidence in several repositories establishes no
/// owner for `#N` (plan §0).
fn judge_pr(held: &HeldTarget, remote: &str, number: u64) -> Result<(), OpenRefusal> {
    let row = held.row.as_deref().ok_or(OpenRefusal::InvalidTarget)?;
    if row.get("number").and_then(Value::as_u64) != Some(number) {
        return Err(OpenRefusal::InvalidTarget);
    }
    let remotes = pr_holders(&held.facts, row, number).ok_or(OpenRefusal::NotPushed)?;
    match (repositories(&held.facts, &remotes), remotes.contains(remote)) {
        (0, _) => Err(OpenRefusal::NotPushed),
        (1, true) => Ok(()),
        _ => Err(OpenRefusal::Ambiguous),
    }
}

/// A commit target's held group and evidence (B2 `:55`, `:60`): in its own row and reachable on the remote it names,
/// which on several remotes must be the one its row establishes.
fn judge_commit(held: &HeldTarget, remote: &str, sha: &str) -> Result<(), OpenRefusal> {
    let row = held.row.as_deref().ok_or(OpenRefusal::InvalidTarget)?;
    if !items(row, "commits").iter().any(|c| text(c, "sha") == Some(sha)) {
        return Err(OpenRefusal::InvalidTarget);
    }
    let f = held.facts.as_ref();
    let known = f.reachable_remotes.as_deref().ok_or(OpenRefusal::NotPushed)?;
    let mut entries = known.iter().filter(|r| r.sha == sha);
    let entry = entries.next().ok_or(OpenRefusal::NotPushed)?;
    if entries.next().is_some() {
        return Err(OpenRefusal::Ambiguous);
    }
    let remotes = entry.remotes.as_deref().ok_or(OpenRefusal::NotPushed)?;
    if !remotes.iter().any(|r| r == remote) {
        return Err(OpenRefusal::NotPushed);
    }
    if repositories(f, &github_holders(f, remotes)) > 1 && row_counterpart(f, row).is_none_or(|e| e.remote.name != remote) {
        return Err(OpenRefusal::Ambiguous);
    }
    Ok(())
}

/// Judge a held GitHub target against its held facts (B2 `:54`): a recognised raw remote, then the target's own evidence.
/// `Ok` is the URL to open.
fn judge_github(held: &HeldTarget) -> Result<String, OpenRefusal> {
    let (owner, repo, remote) = match &held.target {
        TargetFacts::Pr { owner, repo, remote, .. }
        | TargetFacts::Branch { owner, repo, remote, .. }
        | TargetFacts::Commit { owner, repo, remote, .. }
        | TargetFacts::Compare { owner, repo, remote, .. } => (owner, repo, remote),
        TargetFacts::Editor { .. } | TargetFacts::Copy { .. } => return Err(OpenRefusal::InvalidTarget),
    };
    let f = held.facts.as_ref();
    let remotes = f.remotes.as_deref().ok_or(OpenRefusal::UnknownRepo)?;
    let mut named = remotes.iter().filter(|r| r.name == *remote);
    let entry = named.next().ok_or(OpenRefusal::Host)?;
    if named.next().is_some() {
        return Err(OpenRefusal::Ambiguous);
    }
    let github = entry.github.as_ref().ok_or(OpenRefusal::Host)?;
    if github.owner != *owner || github.repo != *repo {
        return Err(OpenRefusal::InvalidTarget);
    }
    // Before the evidence: a number or id that fails its rule is invalid whatever the facts say about it.
    let url = github_url(&held.target).ok_or(OpenRefusal::InvalidTarget)?;
    match &held.target {
        TargetFacts::Pr { number, .. } => judge_pr(held, remote, *number)?,
        TargetFacts::Commit { sha, .. } => judge_commit(held, remote, sha)?,
        TargetFacts::Branch { remote_branch, .. } => {
            // A What-you-did row must still be shown to be this repo's.
            if held.row.as_deref().is_some_and(|row| !row_is_this_repos(f, row)) {
                return Err(OpenRefusal::InvalidTarget);
            }
            judge_remote_branch(f, remote, remote_branch)?;
        }
        TargetFacts::Compare { default_branch, remote_branch, .. } => {
            if entry.default_branch.as_deref() != Some(default_branch) || default_branch == remote_branch {
                return Err(OpenRefusal::InvalidTarget);
            }
            judge_remote_branch(f, remote, remote_branch)?;
        }
        TargetFacts::Editor { .. } | TargetFacts::Copy { .. } => return Err(OpenRefusal::InvalidTarget),
    }
    Ok(url)
}

/// A click on an already resolved handle (`None`: Rust does not hold it). The switch answers first, then the handle, then
/// the judgement; only a target that passes all three reaches the opener, and it does so once.
pub fn open_held(held: Option<&HeldTarget>, links_on: bool, opener: &dyn OpenSink) -> OpenGithubReply {
    if !links_on {
        return OpenGithubReply::Refused(OpenRefusal::LinksOff);
    }
    let Some(held) = held else {
        return OpenGithubReply::Refused(OpenRefusal::Stale);
    };
    match judge_github(held) {
        Err(refusal) => OpenGithubReply::Refused(refusal),
        Ok(url) => match opener.open_url(&url) {
            Ok(()) => OpenGithubReply::Opened(true),
            Err(_) => OpenGithubReply::Failed(OpenFailure::Opener),
        },
    }
}

/// [`open_github`]'s body. `links_on` is the GitHub-links switch, which the command reads from app prefs.
///
/// ⚠ THE ORDER IS THE POINT (plan R2-O3, `ReposLive::check_before_sink`). Sources are checked FIRST and the handle
/// resolved SECOND, so a change this click finds clears the handle it would otherwise open.
pub async fn open_handle(live: &ReposLive, request: OpenGithubRequest, links_on: bool, opener: &dyn OpenSink) -> OpenGithubReply {
    live.check_before_sink().await;
    let held = live.resolve_handle(&request.handle);
    open_held(held.as_ref(), links_on, opener)
}

/* ── copy_push_command (B2 `:81-108`) ─────────────────────────────────────────────────────────── */

/// The most handles one copy may hold (B2 `:82`).
pub const MAX_COPY_HANDLES: usize = 32;

/// `copy_push_command { request: { handles } }`. Closed: the webview names handles, never a command, path or branch.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CopyPushRequest {
    pub handles: Vec<String>,
}

/// B2 `:108`: `{copied: true}`, `{refused: <code>}` or `{failed: "clipboard"}`, and `{copiedToOrigin: true}` when at least one
/// command got its remote from [`Selected::OriginAmongSeveral`], which is the one guess the user should see named. Never the
/// command, a remote's name or the sink's own words.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyPushReply {
    Copied(bool),
    CopiedToOrigin(bool),
    Refused(CopyRefusal),
    Failed(CopyFailure),
}

/// Declared in the order a branch is judged (B2 `:83`). The first match wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CopyRefusal {
    Stale,
    UnknownRepo,
    UnsafeName,
    NoRemote,
    Ambiguous,
    NameMismatch,
    Transport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyFailure {
    Clipboard,
}

/// Where a copied command ends up.
///
/// ⚠ A TRAIT SO THE SUITE NEVER WRITES TO THE CLIPBOARD (plan §0.6), as `access::OpenSink` keeps it from opening anything.
pub trait ClipboardSink: Send + Sync {
    fn write_text(&self, text: &str) -> Result<(), String>;
}

/// The shipping sink: the registered clipboard plugin's Rust API (`lib.rs`).
pub struct SystemClipboard<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> ClipboardSink for SystemClipboard<R> {
    fn write_text(&self, text: &str) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        self.0.clipboard().write_text(text.to_string()).map_err(|e| e.to_string())
    }
}

/// One branch's established push: its operands, each already checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushCommand {
    repo: String,
    remote: String,
    branch: String,
    set_upstream: bool,
    /// Its remote came from [`Selected::OriginAmongSeveral`]. Nothing in the text says so; the reply does.
    origin_among_several: bool,
}

impl PushCommand {
    /// B2 `:84`: `-u` only with no upstream, chosen per branch; the operands single-quoted for a POSIX shell.
    pub fn text(&self) -> String {
        let u = if self.set_upstream { " -u" } else { "" };
        format!("git -C {} push{u} -- {} {}", posix_quote(&self.repo), posix_quote(&self.remote), posix_quote(&self.branch))
    }
}

fn posix_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// A remote or branch operand (B2 `:84`). The character set already excludes every control and format character.
fn is_push_operand(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
}

/// A repo path is quoted, not restricted, except for what quoting cannot make safe to show or paste (plan H1). Off Windows
/// that takes in a backslash, which no path there needs: fish reads `\\` and `\'` as escapes even inside single quotes.
fn is_quotable_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains("[redacted]")
        && !(cfg!(not(windows)) && path.contains('\\'))
        && !path.chars().any(|c| c.is_control() || crate::engine::is_refused_format_character(c) || matches!(c, '\u{2028}' | '\u{2029}'))
}

/// The remote the copied text names: `pushRemote`, `pushDefault`, the upstream's remote when that is the branch's real
/// destination ([`upstream_is_destination`]), the sole remote, then `origin` among several. This narrows B2 `:85` (user
/// decision 2026-11-04): after `git checkout -b feat upstream/main` plain `git push` refuses under `simple`, so where the branch
/// started must not name where the copied text pushes, and (user decision 2026-11-05) `origin` is where it goes instead, the
/// reply saying so. Under `push.default=current` that same plain push goes to the upstream's remote while the copied text
/// names `origin`, on purpose: the text says where it goes, and for a fork `origin` is the wanted one. No `origin` among
/// several remotes selects nothing, and neither does a list of names that is not fully known. A `.` upstream is no remote,
/// whatever its merge name.
enum Selected<'a> {
    Name(&'a str),
    /// Nothing else selected a remote, and `origin` is one of several known names.
    OriginAmongSeveral,
    NoRemote,
    Unresolved,
}

fn select_remote<'a>(f: &'a RepoFacts, branch: &'a BranchFacts, remotes: &'a [RemoteFacts]) -> Selected<'a> {
    let upstream = branch.upstream_remote.as_deref().filter(|u| *u == "." || upstream_is_destination(f, branch));
    if let Some(name) = push_selection(f, branch).or(upstream) {
        return Selected::Name(name);
    }
    // Every name with a config section or a legacy entry is a remote, even one the facts leave out for its name (B2 `:90`);
    // either list unknown makes the count unknown.
    if f.omitted_remotes {
        return Selected::Unresolved;
    }
    let Some(legacy) = f.legacy_names.as_deref() else { return Selected::Unresolved };
    if remotes.iter().any(|r| r.config_section.is_none()) {
        return Selected::Unresolved;
    }
    let mut names: BTreeSet<&str> = legacy.iter().map(String::as_str).collect();
    names.extend(remotes.iter().filter(|r| r.config_section == Some(true) || r.legacy == Some(true)).map(|r| r.name.as_str()));
    let has_origin = names.contains("origin");
    let mut names = names.into_iter();
    match (names.next(), names.next()) {
        (None, _) => Selected::NoRemote,
        (Some(name), None) => Selected::Name(name),
        _ if has_origin => Selected::OriginAmongSeveral,
        _ => Selected::Unresolved,
    }
}

/// Whether `r` has a legacy `remotes/<n>` or `branches/<n>` entry. `None`: unknown, and a known entry beats that.
fn legacy_of(f: &RepoFacts, r: &RemoteFacts) -> Option<bool> {
    let names = f.legacy_names.as_deref();
    if r.legacy == Some(true) || names.is_some_and(|n| n.contains(&r.name)) {
        return Some(true);
    }
    names.and(r.legacy)
}

/// Judge one local branch for a copy, in B2 `:83`'s one order, and establish its command. Pure: the mint calls it to decide
/// whether Where-you-left-off, a push card and the tile show the button, the click to decide what the button does. A handle Rust does not hold is
/// the caller's `stale`.
pub fn judge_copy_branch(f: &RepoFacts, name: &str) -> Result<PushCommand, CopyRefusal> {
    use CopyRefusal::{Ambiguous, NameMismatch, NoRemote, UnknownRepo, UnsafeName};

    let remotes = f.remotes.as_deref().ok_or(UnknownRepo)?;

    // A branch the engine left out, or whose verdict is anything but a known `true`, is unsafe (plan H1). `tag` and `HEAD`
    // are git's own operands, whatever the ref-format check says (B2 `:84`).
    if !is_push_operand(name) || matches!(name, "tag" | "HEAD") || !is_quotable_path(&f.path) {
        return Err(UnsafeName);
    }
    let branch = one(f.branches.as_deref().unwrap_or_default().iter().filter(|b| b.name == name)).ok_or(UnsafeName)?;
    if !branch.ref_format_ok {
        return Err(UnsafeName);
    }
    // Its pointers hold what is no remote name, such as a URL: nothing below can read them, and their `None`s are not "none".
    if branch.remote_facts_unknown {
        return Err(Ambiguous);
    }
    let selected = select_remote(f, branch, remotes);
    if matches!(selected, Selected::Name(n) if !is_push_operand(n)) {
        return Err(UnsafeName);
    }

    // `no-remote`: nothing behind the name, and known to have no legacy entry (a legacy entry is never `no-remote`).
    let origin_among_several = matches!(selected, Selected::OriginAmongSeveral);
    let selected = match selected {
        Selected::NoRemote | Selected::Name(".") => return Err(NoRemote),
        Selected::Unresolved => None,
        Selected::OriginAmongSeveral => Some("origin"),
        Selected::Name(n) => Some(n),
    };
    let entry = selected.and_then(|n| one(remotes.iter().filter(|r| r.name == n)));
    if let Some(r) = entry {
        let nothing_there = r.config_section == Some(false) || (r.config_section == Some(true) && r.url == Some(false));
        if nothing_there && legacy_of(f, r) == Some(false) {
            return Err(NoRemote);
        }
    }

    // `ambiguous`: anything these rules read that is unknown, and several remotes with none resolved and no `origin`.
    let upstream = match (branch.upstream_remote.as_deref(), branch.upstream_branch.as_deref()) {
        (Some(remote), Some(merge)) => Some((remote, merge)),
        (None, None) => None,
        _ => return Err(Ambiguous),
    };
    let (Some(remote_name), Some(r)) = (selected, entry) else { return Err(Ambiguous) };
    if r.config_section.is_none() || r.url.is_none() || r.push.is_none() {
        return Err(Ambiguous);
    }
    let selected_legacy = legacy_of(f, r).ok_or(Ambiguous)?;
    let upstream_legacy = match upstream {
        Some((u, _)) if u != "." => legacy_of(f, one(remotes.iter().filter(|x| x.name == u)).ok_or(Ambiguous)?).ok_or(Ambiguous)?,
        _ => false,
    };

    // `name-mismatch`: anything that could push somewhere the copied text does not say. An upstream of another name that is
    // only where the branch started does not: the command names the branch's own name, and with an upstream it adds no -u.
    let renamed = upstream.is_some_and(|(_, merge)| merge != name) && upstream_is_destination(f, branch);
    if selected_legacy || upstream_legacy || r.push == Some(true) || renamed {
        return Err(NameMismatch);
    }

    // `transport`: the selected remote's verdict, which never crosses as destinations.
    if r.vcs != Some(false) || r.transport != Some(Transport::Network) {
        return Err(CopyRefusal::Transport);
    }
    Ok(PushCommand { repo: f.path.clone(), remote: remote_name.into(), branch: name.into(), set_upstream: upstream.is_none(), origin_among_several })
}

fn list_fits(len: usize) -> bool {
    (1..=MAX_COPY_HANDLES).contains(&len)
}

/// The whole copy's text and whether any command's remote came from [`Selected::OriginAmongSeveral`], or the one refusal it
/// gets (B2 `:82-83`). The list checks come first, and an unknown handle has no card to compare, so it skips them. It then
/// refuses `stale`, the first stage, ahead of every known branch: it has no place in the card's order, and a list holding one
/// came from an older page. Known branches are judged in push-card order, whatever order the request came in, and each store
/// and branch once.
fn copy_text(resolved: &[Option<HeldTarget>]) -> Result<(String, bool), CopyRefusal> {
    if !list_fits(resolved.len()) {
        return Err(CopyRefusal::UnsafeName);
    }
    let mut known: Vec<&HeldTarget> = resolved.iter().flatten().collect();
    if let Some(first) = known.first() {
        let same_card = known.iter().all(|h| h.card_kind == first.card_kind && h.card_id == first.card_id);
        let one_left_off = first.card_kind != CardKind::LeftOff || resolved.len() == 1;
        if !same_card || !one_left_off || resolved.len() > first.population {
            return Err(CopyRefusal::UnsafeName);
        }
    }
    if known.len() != resolved.len() {
        return Err(CopyRefusal::Stale);
    }
    known.sort_by_key(|h| h.order);
    let mut seen = BTreeSet::new();
    let mut commands = Vec::with_capacity(known.len());
    let mut to_origin = false;
    for held in known {
        // A held handle of another kind on the same card has no branch to push: a list check's refusal.
        let TargetFacts::Copy { store_key, branch } = &held.target else { return Err(CopyRefusal::UnsafeName) };
        if seen.insert((store_key, branch)) {
            let command = judge_copy_branch(&held.facts, branch)?;
            to_origin |= command.origin_among_several;
            commands.push(command.text());
        }
    }
    Ok((commands.join(" && "), to_origin))
}

/// A copy of already resolved handles (`None`: Rust does not hold that one). Verified whole before the sink is touched.
pub fn copy_resolved(resolved: &[Option<HeldTarget>], clipboard: &dyn ClipboardSink) -> CopyPushReply {
    match copy_text(resolved) {
        Err(refusal) => CopyPushReply::Refused(refusal),
        Ok((text, to_origin)) => match clipboard.write_text(&text) {
            Ok(()) if to_origin => CopyPushReply::CopiedToOrigin(true),
            Ok(()) => CopyPushReply::Copied(true),
            Err(_) => CopyPushReply::Failed(CopyFailure::Clipboard),
        },
    }
}

/// [`copy_push_command`]'s body. As for [`open_handle`], sources are checked FIRST and the handles resolved SECOND (plan
/// R2-O3). A list no card could hold is refused before either, so its length costs nothing.
pub async fn copy_handles(live: &ReposLive, request: CopyPushRequest, clipboard: &dyn ClipboardSink) -> CopyPushReply {
    if !list_fits(request.handles.len()) {
        return CopyPushReply::Refused(CopyRefusal::UnsafeName);
    }
    live.check_before_sink().await;
    let resolved: Vec<Option<HeldTarget>> = request.handles.iter().map(|h| live.resolve_handle(h)).collect();
    copy_resolved(&resolved, clipboard)
}

/* ── the commands (B2-M4-T12) ─────────────────────────────────────────────────────────────────── */

/// Where a click ends up. The default wires the real opener; `copy_push_command` builds the real clipboard sink from
/// its app handle when `clipboard` is `None`. Every test manages recording sinks (plan §0.6).
pub struct ActionsState {
    opener: Arc<dyn OpenSink>,
    /// `None` in the app: [`SystemClipboard`] over the command's own `AppHandle`.
    clipboard: Option<Arc<dyn ClipboardSink>>,
}

impl Default for ActionsState {
    fn default() -> Self {
        Self { opener: Arc::new(SystemOpener), clipboard: None }
    }
}

impl ActionsState {
    /// **Test harness only.**
    pub fn with_opener(mut self, opener: Arc<dyn OpenSink>) -> Self {
        self.opener = opener;
        self
    }

    /// **Test harness only.**
    pub fn with_clipboard(mut self, clipboard: Arc<dyn ClipboardSink>) -> Self {
        self.clipboard = Some(clipboard);
        self
    }
}

/// Open one held GitHub target by handle. Takes no URL. A data folder that cannot be resolved means the switch cannot be
/// read, so nothing opens and the reply is the fixed failure.
#[tauri::command]
pub async fn open_github<R: Runtime>(
    app: AppHandle<R>,
    live: State<'_, ReposLive>,
    prefs: State<'_, AppPrefs>,
    actions: State<'_, ActionsState>,
    request: OpenGithubRequest,
) -> Result<OpenGithubReply, EngineError> {
    let Ok(dir) = prefs.store_dir(&app) else {
        return Ok(OpenGithubReply::Failed(OpenFailure::Opener));
    };
    let links_on = prefs.get(&dir).github_links;
    Ok(open_handle(&live, request, links_on, actions.opener.as_ref()).await)
}

/// Copy the push command of held branches by handle. Takes no command, path or branch, and the reply never holds the text.
#[tauri::command]
pub async fn copy_push_command<R: Runtime>(
    app: AppHandle<R>,
    live: State<'_, ReposLive>,
    actions: State<'_, ActionsState>,
    request: CopyPushRequest,
) -> Result<CopyPushReply, EngineError> {
    Ok(match &actions.clipboard {
        Some(sink) => copy_handles(&live, request, sink.as_ref()).await,
        None => copy_handles(&live, request, &SystemClipboard(app)).await,
    })
}

/// Every command this module exposes, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["open_github", "copy_push_command"];
