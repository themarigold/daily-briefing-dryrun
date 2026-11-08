//! The live git check's Rust half (briefing redesign B1; wave-2 plan B1-M4-T12 and T13): the state Rust
//! holds between asks, the pure gate, and the stat check.
//!
//! The webview DRIVES (Today's page key, minute tick, focus and current slide); Rust GATES: the window's
//! visibility and the current slide (`live_gate`), the reason for the ask, one check in flight, and a cheap
//! per-repo stat of git's metadata, so that a quiet minute spawns nothing, with four exceptions: on the
//! launchpad the "Not committed" status runs every minute ([`decide`] row 5); with nothing held for the
//! page, after a failed check, a full check runs every minute until one succeeds ([`decide`] row 3); a
//! repo the last check answered `unknown` is retried, after 1, 2, 4, then 5 minutes while it keeps timing
//! out and every 5 minutes otherwise, until every repo answers; and a repo with more than 2 000 entries
//! under `refs/` ([`STAT_CAP`]) counts as changed every minute. Only then does it run the engine's
//! `repos status --json` (`engine::Operation::ReposStatus`), whose request it validated
//! (`engine::ReposRequest`).
//!
//! ⚠ RUST IS A ROUTER, NOT A THIRD COPY OF THE REPLY TYPE. The engine's document is held as one
//! `serde_json::Value` map; Rust reads only its routing fields (`scope`, `repos[]`, `record.accepted`, and
//! each `repoViews[i]`'s `key` and `uncommitted`), REMOVES `repos` (the engine-only stat list) and
//! `actionFacts` (B2's engine-only private facts, held in memory as [`RepoFacts`]), the two places a path
//! appears, and the webview owns the typed model (`git-detail.ts`). It always inserts B2's public `actions`
//! on an `all` document (`[]` when nothing is minted, [`crate::actions::mint_accepted`]) and holds what each handle
//! resolves to beside it. What crosses is filtered by
//! [`sanitize_reply`]: members are admitted only in their declared object context and with their declared
//! scalar types. Undeclared members are dropped; malformed required fields reject the document.
//! [`REPLY_KEYS`] also pins the union of public member names against the engine tests.
//!
//! ⚠ FAIL CLOSED ON THE STAT CHECK. A target the engine reported with a relative directory, or one Rust
//! cannot stat for any reason but "not there", is an ERROR: it counts as a change once, and after that the
//! repo is listed in `unknownRepos` (over its last answer) while the other repos keep their gate.
//!
//! ⚠ ONE CHECK IN FLIGHT, AND IT IS NOT `engine`'s GUARD. `IN_FLIGHT` holds only mutating operations, and
//! this is a read, so [`ReposLive`] carries its own latch: a `minute` ask that finds a check running is
//! answered from what is held at once; one `first` or `focus` ask may wait for it (the one waiting slot,
//! claimed atomically) and then RE-SAMPLES the window and the clock before it decides (round 4, R4-M3);
//! any other is answered at once.
//!
//! ⚠ B2 HAS ITS OWN STAT STATE, AND B1'S GATE NEVER READS IT ([`B2StatInputs`], plan B2-M2-T7). B2's handles depend on
//! config files and worktree metadata B1's stat never looks at. Each ask that reaches the gate samples them first, and
//! a change, or an input that cannot be read, clears B2's handles and `actions` alone: it opens no gate and changes no
//! row of B1's. A sample has its own lane on the blocking pool, so an input on a dead mount costs B2 and nothing else.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Runtime, State};

use crate::actions::{self, HeldTarget, HeldTargets};
use crate::editor::{hold_identities, sample_identities, FolderIdentities};
use crate::engine::{
    Engine, EngineClient, EngineError, EngineOutcome, NoProgress, Operation, Outcome, ReposBranch,
    ReposLabel, ReposRequest, ReposScope,
};
use crate::live_gate::{CurrentSlide, LiveEnv, Visibility};

/// The commands this module defines, in the order `lib.rs` registers them.
pub const COMMANDS: &[&str] = &["repos_status"];

/* ── the gate ─────────────────────────────────────────────────────────────────────────────────── */

/// Why the webview asks (B1 "When"): today's page loaded or changed, the window regained focus, or the
/// minute tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    First,
    Focus,
    Minute,
}

/// What the stat check saw: a repo's fingerprint changed, or a repo's stat failed for the first time, or
/// a repo stats again after an error (`Changed`); or none of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatOutcome {
    Unchanged,
    Changed,
}

/// The gate's answer: answer from what is held, or run the engine at this scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Held,
    Run(ReposScope),
}

/// Everything [`decide`] reads. `stat` is consulted on the minute path only (row 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateInput {
    pub shown: Visibility,
    pub current: Option<CurrentSlide>,
    pub reason: Reason,
    /// The held result answers this ask's key (labels with tokens, branches, page date).
    pub key_matches: bool,
    pub has_held: bool,
    pub first_owed: bool,
    pub ungated_once: bool,
    pub stat: StatOutcome,
}

/// THE GATE, a pure function of its inputs (plan B1-M4-T12), row by row:
///
/// 1. no current slide (the slides off, or the Full briefing view) → `Held`, no check;
/// 2. the window not shown ([`Visibility::shown`]) → `Held` (the caller owes a hidden `first`);
/// 3. no held result for this key → `Run(All)`, whatever the reason;
/// 4. `first`, `focus`, or a `first` owed → `Run(All)`, no stat gate;
/// 5. `minute`: the armed ungated ask, or a stat change → `Run(All)`; else the launchpad current →
///    `Run(Uncommitted)` (the minute "Not committed" status, user decision D3); else `Held`.
pub fn decide(i: GateInput) -> Decision {
    if i.current.is_none() || !i.shown.shown() {
        return Decision::Held;
    }
    if !(i.has_held && i.key_matches) {
        return Decision::Run(ReposScope::All);
    }
    match i.reason {
        Reason::First | Reason::Focus => Decision::Run(ReposScope::All),
        Reason::Minute if i.first_owed || i.ungated_once || i.stat == StatOutcome::Changed => {
            Decision::Run(ReposScope::All)
        }
        Reason::Minute if i.current == Some(CurrentSlide::Launchpad) => {
            Decision::Run(ReposScope::Uncommitted)
        }
        Reason::Minute => Decision::Held,
    }
}

/// What a held result answers: the cards' keys with their tokens, the branch entries and the page date
/// (round-5 item B2). The scope is not part of it. A differing key means "no held result".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestKey {
    labels: Vec<ReposLabel>,
    branches: Vec<ReposBranch>,
    page_date: String,
}

impl RequestKey {
    pub fn of(request: &ReposRequest) -> Self {
        Self {
            labels: request.labels().to_vec(),
            branches: request.branches().to_vec(),
            page_date: request.page_date().to_string(),
        }
    }
}

/* ── the stat check ───────────────────────────────────────────────────────────────────────────── */

/// One readable repo's stat-gate input, from the last `all` reply's `repos` (the engine's
/// `RepoStatTarget`, `src/repos/types.ts`): both directories absolute, from `rev-parse
/// --path-format=absolute`. The repo's own `path` is not read here, and never leaves Rust.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatTarget {
    pub key: String,
    pub git_dir: String,
    pub common_dir: String,
    pub reftable: bool,
}

/// At most this many entries under `refs/` are statted. Overflow always opens the gate: a partial
/// directory fingerprint cannot prove that an omitted ref stayed unchanged.
pub const STAT_CAP: usize = 2000;

/// One stat: the path as joined from git's directories, and its modification time (nanoseconds from the
/// epoch) and length, or `None` when it does not exist (round 2, R2-M6: absent is not an error, so it
/// changes the fingerprint only when it appears or disappears).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct StatEntry {
    pub path: PathBuf,
    pub stamp: Option<(i128, u64)>,
}

/// A complete metadata fingerprint, or a bounded walk that could not cover every ref. An overflow
/// ALWAYS counts as changed, including two successive overflows; it must never become a baseline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fingerprint {
    Full(Vec<StatEntry>),
    OverCap,
}

impl Fingerprint {
    pub fn entries(&self) -> &[StatEntry] {
        match self {
            Fingerprint::Full(e) => e,
            Fingerprint::OverCap => &[],
        }
    }
}

/// What the fingerprint stats, each with the git directory it lies beneath, as exactly `Path::join`s of
/// the strings git gave (no string surgery): the worktree's `HEAD`, `index` and `logs/HEAD` (`gitDir`),
/// then `packed-refs` and, last, the root of the walk, `refs` — or `reftable/tables.list`, stat'd in
/// place of the walk, for a reftable repo (`commonDir`). Each pair is `(root, path)`.
pub fn stat_paths(t: &RepoStatTarget) -> Vec<(PathBuf, PathBuf)> {
    let git_dir = PathBuf::from(&t.git_dir);
    let common = PathBuf::from(&t.common_dir);
    vec![
        (git_dir.clone(), git_dir.join("HEAD")),
        (git_dir.clone(), git_dir.join("index")),
        (git_dir.clone(), git_dir.join("logs/HEAD")),
        (common.clone(), common.join("packed-refs")),
        (
            common.clone(),
            if t.reftable {
                common.join("reftable/tables.list")
            } else {
                common.join("refs")
            },
        ),
    ]
}

fn stamp_of(meta: &std::fs::Metadata) -> std::io::Result<(i128, u64)> {
    let nanos = match meta.modified()?.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    };
    Ok((nanos, meta.len()))
}

/// `symlink_metadata` of `path` (never following a symlink): present, absent, or an error.
fn stat_one(path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Check each parent beneath the engine-resolved git directory before reading a fixed path.
/// A symlinked parent makes the leaf absent; its target's metadata never enters the fingerprint.
fn stat_beneath(root: &Path, path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    let mut current = root.to_path_buf();
    for component in path.strip_prefix(root).expect("fixed path beneath git directory").components() {
        let Some(meta) = stat_one(&current)? else { return Ok(None) };
        if !meta.file_type().is_dir() {
            return Ok(None);
        }
        // Windows junctions are reparse points too; do not treat one as an ordinary directory.
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Ok(None);
            }
        }
        current.push(component);
    }
    stat_one(&current)
}

/// Stream entries without collecting a whole directory. Every yielded entry consumes the shared
/// budget BEFORE metadata is read, including files, symlinks and entries that disappear. At most
/// `cap + 1` entries are enumerated (the extra one establishes overflow), and at most `cap` statted.
fn walk(
    dir: &Path,
    cap: usize,
    seen: &mut usize,
    out: &mut Vec<StatEntry>,
) -> std::io::Result<bool> {
    let children = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e),
    };
    walk_entries(children, cap, seen, out)
}

fn walk_entries(
    children: impl Iterator<Item = std::io::Result<std::fs::DirEntry>>,
    cap: usize,
    seen: &mut usize,
    out: &mut Vec<StatEntry>,
) -> std::io::Result<bool> {
    for child in children {
        if *seen >= cap {
            return Ok(false);
        }
        *seen += 1;
        let path = child?.path();
        let Some(meta) = stat_one(&path)? else {
            continue;
        };
        let is_dir = meta.file_type().is_dir();
        out.push(StatEntry {
            path: path.clone(),
            stamp: Some(stamp_of(&meta)?),
        });
        if is_dir && !walk(&path, cap, seen, out)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Fingerprint fixed metadata and a bounded, streaming refs walk. Never descend a symlink, including
/// a symlinked refs root. Overflow is explicitly incomplete and must trigger an engine check.
pub fn stat_fingerprint(t: &RepoStatTarget, cap: usize) -> std::io::Result<Fingerprint> {
    if !Path::new(&t.git_dir).is_absolute() || !Path::new(&t.common_dir).is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "a git directory that is not absolute",
        ));
    }
    let paths = stat_paths(t);
    let walk_root = &paths.last().expect("refs root").1;
    let mut entries = Vec::with_capacity(paths.len());
    let mut root_is_dir = false;
    for (root, path) in &paths {
        let meta = stat_beneath(root, path)?;
        if path == walk_root {
            root_is_dir = meta.as_ref().is_some_and(|m| m.file_type().is_dir());
        }
        let stamp = meta.as_ref().map(stamp_of).transpose()?;
        entries.push(StatEntry {
            path: path.clone(),
            stamp,
        });
    }
    if !t.reftable && root_is_dir {
        let mut seen = 0;
        if !walk(
            walk_root,
            cap,
            &mut seen,
            &mut entries,
        )? {
            return Ok(Fingerprint::OverCap);
        }
    }
    entries.sort();
    Ok(Fingerprint::Full(entries))
}

/* ── what Rust holds between asks ─────────────────────────────────────────────────────────────── */

/// The gate's word for the webview: the reply is from a run just now, or held from an earlier one, or
/// there is nothing held for this key (A's disclosure stays).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Gate {
    Ran,
    Held,
    NoResult,
}

/// What the webview sends with each ask, as the gate reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ask {
    pub shown: Visibility,
    pub current: Option<CurrentSlide>,
    pub reason: Reason,
}

/// Each target's fingerprint, taken just before an `all` run (`None` for an error).
pub type Prints = Vec<(RepoStatTarget, Option<Fingerprint>)>;

/* ── B2's private facts ───────────────────────────────────────────────────────────────────────── */

/// B2's engine-only `actionFacts` member (`src/repos/types.ts`, `ActionFacts`), one entry per repo. It
/// never crosses into the webview: [`status`] removes it before [`sanitize_reply`] and holds it beside
/// the `all` document it came with.
pub type ActionFacts = Vec<RepoFacts>;

/// One repo's private facts (`src/repos/types.ts`, `RepoFacts`). A strict mirror: every member is
/// required (a nullable one as `null`, never by omission, see `present`) and an undeclared member is
/// refused, so a shape the engine and Rust disagree on is malformed, never a quietly defaulted value.
/// `Serialize` exists only under `cfg(test)`, for the round trip against the shared contract fixture.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RepoFacts {
    /// The exact join key for `repoViews[].key`, `pushCards[].repoKey` and non-null `labels[].repoKey`.
    pub repo_key: String,
    pub path: String,
    #[serde(deserialize_with = "present")]
    pub remotes: Option<Vec<RemoteFacts>>,
    #[serde(deserialize_with = "present")]
    pub branches: Option<Vec<BranchFacts>>,
    #[serde(deserialize_with = "present")]
    pub push_default: Option<String>,
    /// Git's `push.default` is `upstream` or `tracking`, the only values under which a plain `git push` goes to a differently
    /// named upstream. `false` also for an unknown value (plan §0).
    pub pushes_to_upstream: bool,
    #[serde(deserialize_with = "present")]
    pub legacy_names: Option<Vec<String>>,
    /// A remote with a config section or legacy entry exists under a name `remotes` leaves out. Never the name itself.
    pub omitted_remotes: bool,
    #[serde(deserialize_with = "present")]
    pub reachable_remotes: Option<Vec<ReachableRemotes>>,
    #[serde(deserialize_with = "present")]
    pub remote_branches: Option<Vec<RemoteBranch>>,
    #[serde(deserialize_with = "present")]
    pub pr_evidence: Option<Vec<PrEvidence>>,
    #[serde(deserialize_with = "present")]
    pub roots: Option<Vec<ProjectRoot>>,
    /// The public card keys of every label the run record puts on this repo, its folder here or not: a card's join to its
    /// repo. `roots` says what can be launched. `None` leaves every such join unknown.
    #[serde(deserialize_with = "present")]
    pub card_keys: Option<Vec<String>>,
    #[serde(deserialize_with = "present")]
    pub stat_inputs: Option<Vec<StatInput>>,
}

/// One remote's facts. `None` is "the read did not establish it", distinct from `false`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RemoteFacts {
    pub name: String,
    #[serde(deserialize_with = "present")]
    pub transport: Option<Transport>,
    #[serde(deserialize_with = "present")]
    pub github: Option<GithubRepo>,
    #[serde(deserialize_with = "present")]
    pub vcs: Option<bool>,
    #[serde(deserialize_with = "present")]
    pub push: Option<bool>,
    #[serde(deserialize_with = "present")]
    pub config_section: Option<bool>,
    #[serde(deserialize_with = "present")]
    pub url: Option<bool>,
    #[serde(deserialize_with = "present")]
    pub legacy: Option<bool>,
    #[serde(deserialize_with = "present")]
    pub default_branch: Option<String>,
}

/// The engine's push-destination verdict for one remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    Network,
    Refused,
}

/// A credential-free GitHub owner/repo the engine parsed from a remote's raw URL.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct GithubRepo {
    pub owner: String,
    pub repo: String,
}

/// One branch's facts. `ref_format_ok` is conservative: true only after a successful check.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BranchFacts {
    pub name: String,
    #[serde(deserialize_with = "present")]
    pub upstream_remote: Option<String>,
    #[serde(deserialize_with = "present")]
    pub upstream_branch: Option<String>,
    #[serde(deserialize_with = "present")]
    pub push_remote: Option<String>,
    /// `branch.<n>.remote` or `.pushremote` holds what is only not a remote name, such as a URL. The three members above
    /// are then `None` and mean unknown, never "no upstream"; no part of the value crosses.
    pub remote_facts_unknown: bool,
    #[serde(deserialize_with = "present")]
    pub checkout_path: Option<String>,
    pub ref_format_ok: bool,
    /// The branch's own tip (`None`: not a full 40-hex id). Reply rows hold only one card's commits.
    #[serde(deserialize_with = "present")]
    pub tip: Option<String>,
}

/// The remotes a commit is reachable on: empty is known unreachable, `None` is unknown.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct ReachableRemotes {
    pub sha: String,
    #[serde(deserialize_with = "present")]
    pub remotes: Option<Vec<String>>,
}

/// A safely named remote-tracking branch and its tip. The list is all or nothing (`None` above: over the
/// engine's cap or a failed read), because a link needs to know the match is unique.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct RemoteBranch {
    pub remote: String,
    pub name: String,
    pub sha: String,
}

/// Merge or squash evidence of a PR on a remote's default branch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct PrEvidence {
    pub number: u64,
    pub sha: String,
    pub remote: String,
    pub method: PrMethod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub enum PrMethod {
    Merge,
    Squash,
}

/// A checkout-relative root (`""` for the repo root), its engine-built 32-hex project key, the public card keys that map
/// to it, the only join from a card to a root (empty with no accepted run record), and the card label to show for it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProjectRoot {
    pub root: String,
    pub project: String,
    pub label_keys: Vec<String>,
    #[serde(deserialize_with = "present")]
    pub display_label: Option<String>,
}

/// One of B2's stat inputs with its pre-read stamp (`None`: no trustworthy stamp, which mints nothing).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(deny_unknown_fields)]
pub struct StatInput {
    pub path: String,
    #[serde(deserialize_with = "present")]
    pub stamp: Option<Stamp>,
}

/// `{mtimeNs, size, kind, target}`, the decimal strings kept as text (plan R5-M1, Q-M5). The grammar is checked as it
/// parses, so a malformed stamp makes the whole `actionFacts` malformed and no repo mints; a well-formed stamp that
/// disagrees with Rust's own sample refuses that one repo ([`accept_stat_inputs`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(try_from = "RawStamp", rename_all = "camelCase")]
pub struct Stamp {
    pub mtime_ns: String,
    pub size: String,
    pub kind: StampKind,
    pub target: Option<String>,
}

/// The stamp as printed, before its grammar is checked.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawStamp {
    mtime_ns: String,
    size: String,
    kind: StampKind,
    #[serde(deserialize_with = "present")]
    target: Option<String>,
}

/// Plain decimal text: no `+`, no leading zero, nothing empty. `str::parse` alone would accept `+1` and `01`.
fn is_decimal(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) && (text == "0" || !text.starts_with('0'))
}

impl TryFrom<RawStamp> for Stamp {
    type Error = &'static str;

    fn try_from(raw: RawStamp) -> Result<Self, Self::Error> {
        let time_ok = is_decimal(raw.mtime_ns.strip_prefix('-').unwrap_or(&raw.mtime_ns)) && raw.mtime_ns.parse::<i128>().is_ok();
        let size_ok = is_decimal(&raw.size) && raw.size.parse::<u64>().is_ok();
        let shape_ok = match raw.kind {
            StampKind::Symlink => raw.target.is_some(),
            StampKind::Missing => raw.target.is_none() && raw.mtime_ns == "0" && raw.size == "0",
            StampKind::File | StampKind::Dir => raw.target.is_none(),
        };
        if !(time_ok && size_ok && shape_ok) {
            return Err("a stamp outside the grammar");
        }
        Ok(Stamp { mtime_ns: raw.mtime_ns, size: raw.size, kind: raw.kind, target: raw.target })
    }
}

impl Stamp {
    /// The stamp as the integers Rust samples. `None` cannot happen after the parse.
    fn sample(&self) -> Option<Sample> {
        Some(Sample {
            kind: self.kind,
            mtime_ns: self.mtime_ns.parse().ok()?,
            size: self.size.parse().ok()?,
            target: self.target.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub enum StampKind {
    File,
    Dir,
    Symlink,
    Missing,
}

/* ── B2's own stat state (plan B2-M2-T7, R2-O2) ───────────────────────────────────────────────────── */

/// What one input looks like right now: [`stamp_of`] over `symlink_metadata`, plus the kind and a link's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sample {
    pub kind: StampKind,
    pub mtime_ns: i128,
    pub size: u64,
    pub target: Option<String>,
}

/// B2's stat inputs and their baseline, per repo key, from the stripped `actionFacts` alone. It is beside B1's
/// [`RepoStatTarget`], never part of it: B1's equality, `stat_paths`, `stat_fingerprint` and gate do not read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct B2StatInputs {
    repos: BTreeMap<String, BTreeMap<String, Sample>>,
}

impl B2StatInputs {
    /// Whether this repo's inputs were accepted, the condition for minting from its facts.
    pub fn holds(&self, repo_key: &str) -> bool {
        self.repos.contains_key(repo_key)
    }

    pub fn is_empty(&self) -> bool {
        self.repos.is_empty()
    }

    /// The same inputs now. A repo with an input that cannot be sampled is left out, so it differs from `self`.
    fn resample(&self) -> B2StatInputs {
        let repos = self.repos.iter().filter_map(|(key, inputs)| Some((key.clone(), sample_repo(inputs.keys())?)));
        B2StatInputs { repos: repos.collect() }
    }
}

fn is_link(meta: &std::fs::Metadata) -> bool {
    // Windows junctions are reparse points too (the same rule as `stat_beneath`).
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

/// [`stat_one`] for B2: a path under a regular file is absent, as git treats it and as the engine stamps it.
fn stat_input(path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    match stat_one(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotADirectory => Ok(None),
        other => other,
    }
}

/// One input now, metadata only and over an engine-supplied path, so it never goes through [`stat_beneath`], which
/// assumes a git directory. `None` when the sample cannot be trusted: a path that is not absolute and normal, a
/// component that cannot be read, a link on the way that `reported` does not list, or a link whose resolution neither
/// is listed nor is a directory hop. A directory link may be followed by `..` in Git's original path, so the final
/// input need not be beneath its resolution; the engine reports the hop and the final input separately. Past a
/// missing component the input is simply missing, as `lstat` answers.
///
/// Paths compare as bytes. On a case-insensitive filesystem a link reported under another spelling therefore reads as
/// unreported, and that repo mints nothing: the limit fails closed.
fn sample_input(path: &str, reported: &BTreeSet<&str>) -> Option<Sample> {
    let full = Path::new(path);
    let normal = full.components().all(|c| matches!(c, Component::Prefix(_) | Component::RootDir | Component::Normal(_)));
    if !full.is_absolute() || !normal || full.components().collect::<PathBuf>().as_os_str() != full.as_os_str() {
        return None;
    }
    let missing = Sample { kind: StampKind::Missing, mtime_ns: 0, size: 0, target: None };
    let parents: Vec<&Path> = full.ancestors().skip(1).collect();
    for parent in parents.iter().rev().filter(|p| p.parent().is_some()) {
        match stat_input(parent).ok()? {
            None => return Some(missing),
            Some(meta) if is_link(&meta) && !reported.contains(parent.to_str()?) => return None,
            Some(_) => {}
        }
    }
    let Some(meta) = stat_input(full).ok()? else { return Some(missing) };
    let (mtime_ns, size) = stamp_of(&meta).ok()?;
    let (kind, target) = if is_link(&meta) {
        // Walk link targets in kernel order too: canonicalize alone would hide a newly introduced link inside a
        // directory hop. Every hop must have been reported, even when `..` later leaves its resolved directory.
        let mut pending: std::collections::VecDeque<_> = full.components().map(|c| c.as_os_str().to_owned()).collect();
        let mut current = PathBuf::new();
        let mut hops = 0;
        while let Some(part) = pending.pop_front() {
            match Path::new(&part).components().next()? {
                Component::RootDir | Component::Prefix(_) => { current.push(&part); continue; }
                Component::CurDir => continue,
                Component::ParentDir => { current.pop(); continue; }
                Component::Normal(_) => {}
            }
            let next = current.join(part);
            let Some(step) = stat_input(&next).ok()? else { break };
            if is_link(&step) {
                hops += 1;
                if hops > 40 || !reported.contains(next.to_str()?) {
                    return None;
                }
                let target = std::fs::read_link(&next).ok()?;
                if target.is_absolute() { current.clear(); }
                for component in target.components().rev() {
                    pending.push_front(component.as_os_str().to_owned());
                }
            } else {
                current = next;
            }
        }
        match std::fs::canonicalize(full) {
            Ok(real) if real.is_dir() || reported.iter().any(|p| Path::new(p).starts_with(&real)) => {}
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {} // dangling: the link's own text is the watch
            _ => return None,
        }
        (StampKind::Symlink, Some(std::fs::read_link(full).ok()?.to_str()?.to_owned()))
    } else if meta.file_type().is_dir() {
        (StampKind::Dir, None)
    } else {
        (StampKind::File, None)
    };
    Some(Sample { kind, mtime_ns, size, target })
}

/// One repo's inputs now, or `None` when any one cannot be sampled. Links are checked against this same set.
fn sample_repo<'a>(paths: impl Iterator<Item = &'a String> + Clone) -> Option<BTreeMap<String, Sample>> {
    let reported: BTreeSet<&str> = paths.clone().map(String::as_str).collect();
    paths.map(|p| Some((p.clone(), sample_input(p, &reported)?))).collect()
}

/// The stat inputs the engine reported for one repo and the stamps it took before reading the facts. `None` when
/// any is unavailable, the set is empty, or a path is listed twice.
fn reported_inputs(facts: &RepoFacts) -> Option<BTreeMap<String, Sample>> {
    let inputs = facts.stat_inputs.as_ref()?;
    let parsed: Option<BTreeMap<String, Sample>> =
        inputs.iter().map(|i| Some((i.path.clone(), i.stamp.as_ref()?.sample()?))).collect();
    parsed.filter(|m| !m.is_empty() && m.len() == inputs.len())
}

/// Which repos may mint, after the engine's run (plan R5-M1). A repo is accepted when Rust's own sample now agrees
/// exactly with the engine's pre-read stamps, and, for a set that matches what Rust sampled before the run, when that
/// sample agrees too: so what is retained is the pre-run, pre-read state, never a post-run stat adopted as a baseline,
/// and a change during the run stays a change. [`STAT_CAP`] bounds distinct paths across all repos, a path shared by
/// several repos (the global config) counting once: a repo that would pass it is refused, and the others are still read.
pub fn accept_stat_inputs(facts: &[RepoFacts], before: &B2StatInputs) -> B2StatInputs {
    let mut accepted = B2StatInputs::default();
    let mut counted: BTreeSet<String> = BTreeSet::new();
    for repo in facts {
        let Some(reported) = reported_inputs(repo) else { continue };
        if counted.len() + reported.keys().filter(|p| !counted.contains(*p)).count() > STAT_CAP {
            continue;
        }
        counted.extend(reported.keys().cloned());
        let changed_before = before.repos.get(&repo.repo_key).is_some_and(|sampled| {
            sampled.keys().eq(reported.keys()) && *sampled != reported
        });
        if !changed_before && sample_repo(reported.keys()).as_ref() == Some(&reported) {
            accepted.repos.insert(repo.repo_key.clone(), reported);
        }
    }
    accepted
}

/// A REQUIRED nullable member. `serde` lets a missing `Option` field default to `None`; naming a
/// `deserialize_with` turns that default off, so a member the engine left out is malformed.
fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(d)
}

/// The production facts parser: the engine's `actionFacts` member, or EMPTY facts when it is missing or
/// malformed in any part. Never a failure of the check (B2 `:25`): B1 needs `repos` for its stat targets,
/// and B2's facts are optional, so a bad member removes only the actions minted from it.
pub fn parse_action_facts(raw: Option<Value>) -> ActionFacts {
    raw.and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// The result held for one key: the engine's `all` document, when Rust took it (the injected clock's
/// epoch seconds), when its "Not committed" counts were last read (the document's own `checkedAt`,
/// or a later `uncommitted` reply's), and B2's private facts that came with it (replaced with it).
#[derive(Debug, Clone)]
struct Held {
    key: RequestKey,
    reply: Map<String, Value>,
    held_at: i64,
    uncommitted_at: Value,
    facts: ActionFacts,
}

/// An unknown repo with nothing transient is retried after this many eligible minute asks; it is also
/// the cap of a transient one's backoff.
pub const UNKNOWN_RETRY_MINUTES: u8 = 5;

/// What Rust holds between asks (plan B1-M4-T12). Every method is a computation over this state and its
/// arguments; the only reads are the stat check's, of git's metadata.
#[derive(Debug, Default, Clone)]
pub struct ReposState {
    held: Option<Held>,
    /// From the last `all` reply's `repos`, each with the fingerprint taken for that reply.
    targets: Prints,
    /// Repos whose last stat errored: listed `unknown` over their last answer.
    errored: BTreeSet<String>,
    /// Unknown engine repos retry even with stat targets, counted in eligible minute asks: a
    /// transient one (`timeout`/`budget`) after `transient_wait`'s backoff, any other
    /// after [`UNKNOWN_RETRY_MINUTES`].
    retry_after: Option<u8>,
    /// The last transient retry's wait (0: none): doubled per consecutive transient answer, capped at
    /// [`UNKNOWN_RETRY_MINUTES`]; reset by an answer with nothing transient left.
    transient_wait: u8,
    first_owed: bool,
    ungated_once: bool,
    ungated_armed_for: Option<RequestKey>,
    /// B2's one generation counter (plan B2-M2-T6): bumped by every invalidation, see [`Self::clear_actions`].
    generation: u64,
    /// B2's held handles: what a click resolves. One map inside this lock, no second state object.
    handles: HeldTargets,
    /// B2's stat baseline: the accepted repos' inputs, each as it stood before their facts were read.
    b2: B2StatInputs,
}

/// Whether `t`'s stat failed just before the run, which lists its repo in `unknownRepos` over the new document.
fn stat_failed_before(t: &RepoStatTarget, before: &Prints) -> bool {
    before.iter().any(|(b, p)| b == t && p.is_none())
}

impl ReposState {
    /// B2's current generation.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The generation a mint made now must carry: [`Self::hold_all`] bumps to it as it replaces the document.
    pub fn next_generation(&self) -> u64 {
        self.generation.wrapping_add(1)
    }

    /// What a click on `handle` resolves to. Missing, or minted by an older generation, is `None`: `stale`.
    pub fn held_target(&self, handle: &str) -> Option<&HeldTarget> {
        self.handles.get(handle).filter(|t| t.generation == self.generation)
    }

    /// B2's one invalidation (plan M4, B2-M2-T6): bump the generation, drop every held handle, and replace the
    /// held document's `actions` with `[]`, before any next reply and whatever the gate answers. Only a new
    /// successful full mint fills them again. Nothing of B1's changes.
    pub fn clear_actions(&mut self) {
        self.generation = self.next_generation();
        self.handles.clear();
        if let Some(held) = self.held.as_mut() {
            held.reply.insert("actions".into(), Value::Array(Vec::new()));
        }
    }

    /// Hold what a mint for the current generation returned, after [`Self::hold_all`] took its document.
    pub fn hold_targets(&mut self, minted: HeldTargets) {
        let generation = self.generation;
        self.handles = minted.into_iter().filter(|(_, t)| t.generation == generation).collect();
    }

    /// An ask for a page other than the one held: its handles are old (B2 `:30`). An ask that changes nothing
    /// held does not bump, so repeated asks for a new page keep one generation.
    pub fn page_asked(&mut self, key: &RequestKey) {
        if self.held.as_ref().is_some_and(|h| h.key != *key) && self.has_live_actions() {
            self.clear_actions();
        }
    }

    /// Something a clear would end: held handles, or `actions` on the held document.
    fn has_live_actions(&self) -> bool {
        !self.handles.is_empty()
            || self.held.as_ref().is_some_and(|h| {
                h.reply.get("actions").and_then(Value::as_array).is_some_and(|a| !a.is_empty())
            })
    }

    /// What a sample of `sampled_from` means now: anything but an exact match clears (B2 `:31`). A commit that replaced
    /// that generation while the sample ran already ended what it covered, and what is live now is a fresh mint it says
    /// nothing about. With nothing live there is nothing to end, and no bump, so a click on an old handle cannot cost a
    /// full run in flight its mint.
    fn settle_b2(&mut self, generation: u64, sampled_from: &B2StatInputs, now: Option<&B2StatInputs>) {
        if self.generation == generation && self.b2 == *sampled_from && now != Some(sampled_from) && self.has_live_actions() {
            self.clear_actions();
        }
    }

    /// A failed run commits no gate state, but handles the gate just invalidated stay invalidated. `base` is the live
    /// generation when `gated` was cloned. The answer is what [`Self::commit`] compares with: it keeps a clear made
    /// since the clone visible, which the gate's own clear would otherwise hide.
    fn carry_clear_from(&mut self, gated: &ReposState, base: u64) -> u64 {
        let raced = self.generation != base;
        if gated.generation != base {
            self.clear_actions();
        }
        if raced {
            base
        } else {
            self.generation
        }
    }

    /// Replace this live state with `next`, a clone taken at generation `base` and worked on outside the lock. The
    /// check before a sink runs outside the run latch, so it may have cleared this state in the meantime. A clone must
    /// not put those handles and `actions` back, and what a full run minted before that clear is not held either.
    fn commit(&mut self, mut next: ReposState, base: u64) {
        if self.generation != base {
            next.clear_actions();
        }
        *self = next;
    }

    fn held_for(&self, key: &RequestKey) -> Option<&Held> {
        self.held.as_ref().filter(|h| h.key == *key)
    }

    /// B2's private facts held with the `all` document for `key` (empty with nothing held for it). Every entry the engine
    /// reported, including repos refused by the stat check. A Settings row may list such a project's stable key, but
    /// it launches nothing without a live handle (plan §0, "Note for T11 and T12").
    pub fn held_facts(&self, key: &RequestKey) -> &[RepoFacts] {
        self.held_for(key).map_or(&[], |h| h.facts.as_slice())
    }

    /// The stat check (row 5's input): each target against the fingerprint taken for the held reply. A
    /// changed fingerprint is a change; a repo's FIRST error is a change (it joins `errored`), a repeated
    /// one is not; a repo that stats again after an error is a change.
    fn stat_targets(&mut self, cap: usize) -> StatOutcome {
        let mut changed = false;
        let mut became_unknown = false;
        for (target, last) in &self.targets {
            match stat_fingerprint(target, cap) {
                Ok(now) => {
                    let recovered = self.errored.remove(&target.key);
                    if recovered || now == Fingerprint::OverCap || last.as_ref() != Some(&now) {
                        changed = true;
                    }
                }
                Err(_) => {
                    if self.errored.insert(target.key.clone()) {
                        changed = true;
                        became_unknown = true;
                    }
                }
            }
        }
        if became_unknown {
            self.clear_actions();
        }
        if let Some(left) = self.retry_after.as_mut() {
            *left = left.saturating_sub(1);
            changed |= *left == 0;
        }
        if changed {
            StatOutcome::Changed
        } else {
            StatOutcome::Unchanged
        }
    }

    /// Gate one ask for `key`: the [`decide`] table plus its bookkeeping. A hidden `first` (with a slide
    /// current) is owed; any `all` run settles an owed `first`; the minute ask that the armed ungated ask
    /// lets through spends it. The stat check runs only where row 5 reads it.
    pub fn gate(&mut self, ask: Ask, key: &RequestKey, cap: usize) -> Decision {
        let has_held = self.held.is_some();
        let key_matches = self.held_for(key).is_some();
        let row_5 = ask.reason == Reason::Minute
            && ask.current.is_some()
            && ask.shown.shown()
            && key_matches
            && !self.first_owed;
        let stat = if row_5 && !self.ungated_once {
            self.stat_targets(cap)
        } else {
            StatOutcome::Unchanged
        };
        let decision = decide(GateInput {
            shown: ask.shown,
            current: ask.current,
            reason: ask.reason,
            key_matches,
            has_held,
            first_owed: self.first_owed,
            ungated_once: self.ungated_once,
            stat,
        });
        match decision {
            Decision::Held => {
                if ask.reason == Reason::First && ask.current.is_some() && !ask.shown.shown() {
                    self.first_owed = true;
                }
            }
            Decision::Run(ReposScope::All) => {
                if row_5 {
                    self.ungated_once = false;
                }
                self.first_owed = false;
            }
            Decision::Run(ReposScope::Uncommitted) => {}
        }
        decision
    }

    /// Each current target's fingerprint, taken just BEFORE an `all` run, so that a change made while the
    /// engine runs is still a change at the next minute.
    pub fn prints_before_run(&self, cap: usize) -> Prints {
        self.targets
            .iter()
            .map(|(t, _)| (t.clone(), stat_fingerprint(t, cap).ok()))
            .collect()
    }

    /// Hold an `all` document for `key`. Its stat targets replace the old ones, each with the fingerprint
    /// taken before the run when it was already a target with the same directories (`before`). A new
    /// target has no baseline and requires a follow-up check. Unknown repos retain omitted targets.
    /// A document whose record was not accepted arms ONE ungated minute ask per key (round 1,
    /// H6: the record is written after the page); a new key clears the arming. B2's private `facts`
    /// are held with the document and replace the old ones with it. A replacing check is a generation
    /// bump: the old handles go here, and [`Self::hold_targets`] holds the ones minted for this document.
    pub fn hold_all(
        &mut self,
        key: RequestKey,
        reply: Map<String, Value>,
        mut targets: Vec<RepoStatTarget>,
        held_at: i64,
        before: Prints,
        facts: ActionFacts,
    ) {
        self.clear_actions();
        if self.ungated_armed_for.as_ref() != Some(&key) {
            self.ungated_armed_for = None;
            self.ungated_once = false;
        }
        let accepted = reply
            .get("record")
            .and_then(|r| r.get("accepted"))
            .and_then(Value::as_bool)
            == Some(true);
        if !accepted && self.ungated_armed_for.is_none() {
            self.ungated_once = true;
            self.ungated_armed_for = Some(key.clone());
        }
        let unknown: BTreeSet<String> = reply
            .get("repoViews")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|v| v.get("state").and_then(Value::as_str) == Some("unknown"))
            .filter_map(|v| v.get("key").and_then(Value::as_str).map(str::to_owned))
            .collect();
        for (old, _) in &self.targets {
            if unknown.contains(&old.key) && !targets.iter().any(|t| t.key == old.key) {
                targets.push(old.clone());
            }
        }
        let transient = reply.get("repoViews").and_then(Value::as_array)
            .into_iter().flatten().any(|v| {
                v.get("state").and_then(Value::as_str) == Some("unknown")
                    && matches!(v.get("reason").and_then(Value::as_str), Some("timeout" | "budget"))
            });
        // Back off a repo that keeps timing out (final review 4, M2): 1, 2, 4, then 5 minutes, so a
        // persistent timeout costs a full check at most every five minutes, not every minute.
        self.transient_wait = if transient {
            match self.transient_wait {
                0 => 1,
                w => w.saturating_mul(2).min(UNKNOWN_RETRY_MINUTES),
            }
        } else {
            0
        };
        self.retry_after = (!unknown.is_empty()).then_some(if transient {
            self.transient_wait
        } else {
            UNKNOWN_RETRY_MINUTES
        });
        self.errored.clear();
        let mut prints = Vec::with_capacity(targets.len());
        for t in targets {
            let print = match before.iter().find(|(b, _)| *b == t) {
                Some((_, p)) => p.clone(),
                None => None,
            };
            if stat_failed_before(&t, &before) {
                self.errored.insert(t.key.clone());
            }
            prints.push((t, print));
        }
        self.targets = prints;
        let uncommitted_at = reply.get("checkedAt").cloned().unwrap_or(Value::Null);
        self.held = Some(Held {
            key,
            reply,
            held_at,
            uncommitted_at,
            facts,
        });
    }

    /// Fold an `uncommitted` document into the held one (round 1, M15): each matching
    /// `repoViews[i].uncommitted` is replaced and `uncommittedAt` becomes the document's `checkedAt`;
    /// every other held field is untouched, and a repo the held document does not list is not added. A
    /// document for a key that is not held changes nothing.
    pub fn merge_uncommitted(&mut self, key: &RequestKey, reply: &Map<String, Value>) {
        let Some(held) = self.held.as_mut().filter(|h| h.key == *key) else {
            return;
        };
        let fresh: BTreeMap<&str, &Value> = reply
            .get("repoViews")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| Some((v.get("key")?.as_str()?, v.get("uncommitted")?)))
            .collect();
        if let Some(Value::Array(views)) = held.reply.get_mut("repoViews") {
            for view in views.iter_mut().filter_map(Value::as_object_mut) {
                let Some(k) = view.get("key").and_then(Value::as_str) else {
                    continue;
                };
                if let Some(u) = fresh.get(k) {
                    let u = (*u).clone();
                    view.insert("uncommitted".into(), u);
                }
            }
        }
        if let Some(at) = reply.get("checkedAt") {
            held.uncommitted_at = at.clone();
        }
    }

    /// The reply for `key` (plan B1-M4-T13's `ReposIpcReply`): the held document with `gate`, `heldAt`,
    /// `uncommittedAt` and `unknownRepos` added; or, with nothing held for this key, `gate: "noResult"`
    /// and nothing of the engine's.
    pub fn reply(&self, key: &RequestKey, gate: Gate) -> Value {
        let Some(held) = self.held_for(key) else {
            return serde_json::json!({
                "gate": Gate::NoResult,
                "heldAt": Value::Null,
                "uncommittedAt": Value::Null,
                "unknownRepos": [],
            });
        };
        let mut out = held.reply.clone();
        out.insert("gate".into(), serde_json::json!(gate));
        out.insert("heldAt".into(), serde_json::json!(held.held_at));
        out.insert("uncommittedAt".into(), held.uncommitted_at.clone());
        out.insert("unknownRepos".into(), serde_json::json!(self.errored));
        Value::Object(out)
    }
}

/* ── what crosses into the webview ────────────────────────────────────────────────────────────── */

/// The union of member names the engine's public reply types declare (`src/repos/types.ts`).
/// [`sanitize_reply`] additionally enforces each member's object context, union variant and scalar type. `perLabel` is the one record keyed by data (card keys), so its keys pass and
/// only its number values are kept. `repos` is not here: it is read for the stat targets and never crosses.
/// Nor is `actionFacts`: it is held as [`RepoFacts`] and never crosses.
/// `test/repos.status.test.ts` reads this list: every real reply's members must be in it, and every entry
/// must be a member `types.ts` declares.
pub const REPLY_KEYS: &[&str] = &[
    "accepted",
    "actions",
    "behind",
    "branchLines",
    "branches",
    "cardId",
    "cardKind",
    "checkedAt",
    "commits",
    "complete",
    "count",
    "firstLabel",
    "handle",
    "handles",
    "hidden",
    "key",
    "kind",
    "label",
    "labels",
    "name",
    "neverPushed",
    "noRemote",
    "notMatched",
    "notPushed",
    "number",
    "onDefault",
    "onlyHere",
    "perLabel",
    "prNumbers",
    "project",
    "push",
    "pushCards",
    "reason",
    "record",
    "repoKey",
    "repoName",
    "repoViews",
    "row",
    "rows",
    "schemaVersion",
    "scope",
    "sha",
    "state",
    "storeKey",
    "subject",
    "target",
    "tile",
    "title",
    "token",
    "treeKey",
    "uncommitted",
    "unknown",
    "windowStartUtc",
];

/// Project a document by object context, using the engine's declared required fields and scalar
/// types (`src/repos/types.ts`). Unknown members are dropped. A malformed required field rejects the
/// document (`Null`); callers must validate BEFORE committing any held/gate state.
pub fn sanitize_reply(v: Value) -> Value {
    let context = if v.get("scope").and_then(Value::as_str) == Some("uncommitted") {
        "partial"
    } else {
        "all"
    };
    project(&v, context).unwrap_or(Value::Null)
}

/// B2: an engine-built project key, exactly 32 lowercase hex (never derived in Rust). The projection's
/// rule for an editor handle's `project`; the mint refuses by the same rule, so a value that would null
/// the document here gives no handle instead (B2 `:25`).
pub(crate) fn is_project_key(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// B2: a compare target's label, the default branch's display name after B1's redaction: never empty,
/// `[redacted]` or control/format-bearing. The projection's rule for a compare handle's `label`; the mint
/// refuses by the same rule (B2 `:25`). This is NOT a credential check, and Rust has no credential matcher:
/// the engine's `safeFactName` (`src/repos/remotes.ts`) is the credential gate for this name, so a
/// credential-shaped default branch reaches Rust as `defaultBranch: null`, never as text to test here.
pub(crate) fn is_safe_action_label(s: &str) -> bool {
    !s.is_empty()
        && s != "[redacted]"
        && !s
            .chars()
            .any(|c| c.is_control() || crate::engine::is_refused_format_character(c))
}

// This is a projection of Value, not another serializable reply model. All object fields listed here
// are required; union variants choose their own fields, so names at another depth/variant are dropped.
fn project(v: &Value, context: &str) -> Option<Value> {
    if let Some(item) = context.strip_prefix("array:") {
        return v
            .as_array()?
            .iter()
            .map(|v| project(v, item))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array);
    }
    if let Some(item) = context.strip_prefix("nullable:") {
        return if v.is_null() {
            Some(Value::Null)
        } else {
            project(v, item)
        };
    }
    if let Some(choices) = context.strip_prefix("enum:") {
        return choices
            .split('|')
            .any(|s| v.as_str() == Some(s))
            .then(|| v.clone());
    }
    match context {
        "string" => return v.is_string().then(|| v.clone()),
        "bool" => return v.is_boolean().then(|| v.clone()),
        "count" => return v.as_u64().is_some().then(|| v.clone()),
        "true" => return (v.as_bool() == Some(true)).then(|| v.clone()),
        "false" => return (v.as_bool() == Some(false)).then(|| v.clone()),
        "version" => return (v.as_u64() == Some(1)).then(|| v.clone()),
        "null" => return v.is_null().then_some(Value::Null),
        "projectKey" => return is_project_key(v.as_str()?).then(|| v.clone()),
        "actionLabel" => return is_safe_action_label(v.as_str()?).then(|| v.clone()),
        "counts" => {
            return Some(Value::Object(
                v.as_object()?
                    .iter()
                    .filter(|(_, v)| v.as_u64().is_some())
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ))
        }
        _ => {}
    }
    let m = v.as_object()?;
    let fields: &[(&str, &str)] = match context {
        "all" => &[("schemaVersion", "version"), ("scope", "enum:all"), ("checkedAt", "string"),
            ("record", "record"), ("windowStartUtc", "nullable:string"), ("repoViews", "array:view"),
            ("labels", "array:label"), ("branchLines", "array:line"), ("pushCards", "array:card"),
            ("tile", "tile"), ("hidden", "hidden"), ("actions", "array:actionCard")],
        "partial" => &[("schemaVersion", "version"), ("scope", "enum:uncommitted"),
            ("checkedAt", "string"), ("repoViews", "array:partialView")],
        "record" => &[("accepted", "bool"), ("windowStartUtc", "nullable:string")],
        "view" => match m.get("state")?.as_str()? {
            "ok" => &[("key", "string"), ("name", "string"), ("state", "enum:ok"), ("noRemote", "bool"), ("uncommitted", "uncommitted"),
                ("storeKey", "string"), ("treeKey", "string")],
            "unknown" => &[("key", "string"), ("name", "string"), ("state", "enum:unknown"), ("noRemote", "false"),
                ("reason", "enum:git-too-old|dubious-ownership|required-filter|partial-clone|elsewhere|timeout|budget|error"), ("uncommitted", "uncommitted"),
                ("storeKey", "nullable:string"), ("treeKey", "nullable:string")],
            "noRepos" => &[("key", "enum:"), ("name", "enum:"), ("state", "enum:noRepos"), ("noRemote", "false"), ("uncommitted", "unknown")],
            _ => return None,
        },
        "partialView" => &[("key", "string"), ("uncommitted", "uncommitted")],
        "uncommitted" if m.contains_key("count") => &[("count", "count")],
        "uncommitted" | "unknown" => &[("unknown", "true")],
        "label" => &[("key", "string"), ("repoKey", "nullable:string"), ("state", "enum:ok|unknown"),
            ("rows", "array:row"), ("notMatched", "count"), ("prNumbers", "array:count"), ("onlyHere", "count")],
        "row" => match m.get("kind")?.as_str()? {
            "pr" => &[("kind", "enum:pr"), ("number", "count"), ("title", "string"), ("commits", "array:commit")],
            "branch" | "default" => &[("kind", "enum:branch|default"), ("name", "string"), ("push", "nullable:push"), ("commits", "array:commit")],
            "remoteBranch" | "tag" => &[("kind", "enum:remoteBranch|tag"), ("name", "string"), ("commits", "array:commit")],
            "detached" | "orphan" => &[("kind", "enum:detached|orphan"), ("commits", "array:commit")],
            _ => return None,
        },
        "commit" if m.get("token")?.is_null() => &[("sha", "string"), ("token", "null"), ("subject", "string")],
        "commit" => &[("sha", "string"), ("token", "string")],
        "push" => &[("state", "enum:pushed|partly|never"), ("notPushed", "count")],
        "line" => match m.get("state")?.as_str()? {
            "live" => &[("key", "string"), ("name", "string"), ("state", "enum:live"),
                ("notPushed", "count"), ("neverPushed", "bool"), ("behind", "count")],
            "missing" | "noRemote" => &[("key", "string"), ("name", "string"), ("state", "enum:missing|noRemote")],
            _ => return None,
        },
        "card" => &[("repoKey", "string"), ("storeKey", "string"), ("firstLabel", "nullable:string"), ("repoName", "string"),
            ("branches", "array:branchCount"), ("onDefault", "nullable:branchCount")],
        "branchCount" => &[("name", "string"), ("commits", "count")],
        "tile" => &[("commits", "count"), ("branches", "count")],
        "hidden" => &[("complete", "bool"), ("perLabel", "counts")],
        // B2's public handles (B2 `:26`): fixed member names, never a record keyed by data. `project`
        // is set only on an editor target and `label` only on a compare target; both null elsewhere.
        "actionCard" => &[("repoKey", "string"), ("cardKind", "enum:did|leftOff|push|tile"), ("cardId", "string"),
            ("handles", "array:actionHandle")],
        "actionHandle" => match m.get("target")?.as_str()? {
            "editor" => &[("handle", "string"), ("target", "enum:editor"), ("row", "nullable:count"),
                ("sha", "nullable:string"), ("project", "projectKey"), ("label", "null")],
            "compare" => &[("handle", "string"), ("target", "enum:compare"), ("row", "nullable:count"),
                ("sha", "nullable:string"), ("project", "null"), ("label", "actionLabel")],
            "pr" | "branch" | "commit" | "copy" => &[("handle", "string"), ("target", "enum:pr|branch|commit|copy"),
                ("row", "nullable:count"), ("sha", "nullable:string"), ("project", "null"), ("label", "null")],
            _ => return None,
        },
        "target" => &[("key", "string"), ("path", "string"), ("gitDir", "string"), ("commonDir", "string"), ("reftable", "bool")],
        _ => return None,
    };
    fields
        .iter()
        .map(|(k, shape)| Some(((*k).to_owned(), project(m.get(*k)?, shape)?)))
        .collect::<Option<Map<String, Value>>>()
        .map(Value::Object)
}

/// The managed state (plan B1-M4-T12): what is held, the one-in-flight latch, and the one waiting slot
/// an owed `first` or `focus` claims.
#[derive(Default)]
pub struct ReposLive {
    inner: Mutex<ReposState>,
    run: tokio::sync::Mutex<()>,
    owed: AtomicBool,
    /// Set while the gate's stat work runs on the blocking pool, cleared only when that work really ends
    /// (final review 6, M1): an ask that finds it set fails at once, so a stat stuck past `STAT_LIMIT`
    /// leaves at most one blocked thread and one clone of the state, not one per tick or focus.
    stat_busy: std::sync::Arc<AtomicBool>,
    /// `None` in the app. **Test harness only** ([`ReposLive::with_stat_stall`]).
    stall: Option<std::sync::Arc<dyn Fn() + Send + Sync>>,
    /// B2's samples for asks, one at a time and held until the blocking work really ends, so an input that never
    /// returns leaves one blocked thread, and B1's stat work runs regardless. The run latch orders the asks, so finding
    /// this taken means a sample is stuck.
    b2_ask_lane: Arc<tokio::sync::Mutex<()>>,
    /// The same for the checks before a sink, which run outside the run latch and may wait for each other.
    b2_click_lane: Arc<tokio::sync::Mutex<()>>,
    /// Inventory and marker reads cannot hold up a sink's fingerprint or folder verification.
    b2_inventory_lane: Arc<tokio::sync::Mutex<()>>,
}

/// How long each of B2's two samples on the ask path may take. Past it only B2's handles go, so it is far shorter than
/// [`STAT_LIMIT`], and an ask's worst case stays within `ASK_LIMIT_MS` (`gui/src/lib/git-live.ts`).
pub const B2_SAMPLE_LIMIT: std::time::Duration = std::time::Duration::from_millis(1_000);

/// How long the gate's stat work (the stat check and the pre-run fingerprints) may take before the ask
/// fails (final review 5, L2): a stat on a dead network mount can block forever, and it runs while the
/// run latch is held. The blocked thread is left to finish on its own; it holds a clone of the state,
/// and until it ends every ask fails at once (`ReposLive::stat_busy`).
pub const STAT_LIMIT: std::time::Duration = std::time::Duration::from_secs(5);

impl ReposLive {
    /// **Test harness only**: `stall` runs on the blocking pool before the gate's stat work and before each of B2's
    /// samples, standing in for a stat that does not return.
    pub fn with_stat_stall(mut self, stall: std::sync::Arc<dyn Fn() + Send + Sync>) -> Self {
        self.stall = Some(stall);
        self
    }

    fn state(&self) -> MutexGuard<'_, ReposState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether an ask holds the one waiting slot (diagnostic; the command tests read it).
    pub fn is_owed(&self) -> bool {
        self.owed.load(Ordering::SeqCst)
    }

    /// Whether the gate's stat work is still running on the blocking pool (diagnostic; the tests read it).
    pub fn is_stat_busy(&self) -> bool {
        self.stat_busy.load(Ordering::SeqCst)
    }

    /// **Test harness only**: B2's private facts held for `key`, for the command tests to read.
    pub fn held_facts(&self, key: &RequestKey) -> ActionFacts {
        self.state().held_facts(key).to_vec()
    }

    /// **Test harness only**: whether a click on `handle` would still resolve.
    pub fn holds_handle(&self, handle: &str) -> bool {
        self.state().held_target(handle).is_some()
    }

    /// What a click on `handle` resolves to, `None` being `stale`. A sink calls [`Self::check_before_sink`] first, then this.
    pub fn resolve_handle(&self, handle: &str) -> Option<HeldTarget> {
        self.state().held_target(handle).cloned()
    }

    /// B2's private facts of the document held now, whatever page it answers, each with its repo view's display name:
    /// the resolved half of `editor_list`'s inventory. Kept across a generation bump, which ends handles and not a
    /// project's stable key (plan R2-O7). Includes repos refused by the stat check, which get no handle.
    pub(crate) fn held_inventory(&self) -> Vec<(RepoFacts, Option<String>)> {
        let state = self.state();
        let Some(held) = state.held.as_ref() else { return Vec::new() };
        let views = held.reply.get("repoViews").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
        let name_of = |key: &str| {
            let view = views.iter().find(|v| v.get("key").and_then(Value::as_str) == Some(key))?;
            view.get("name").and_then(Value::as_str).map(str::to_string)
        };
        held.facts.iter().map(|f| (f.clone(), name_of(&f.repo_key))).collect()
    }

    /// An editor launch's folder verification, on the click lane with [`Self::check_before_sink`]'s fingerprint sample.
    /// Each wait is bounded by [`STAT_LIMIT`]; a stuck read keeps the lane until it ends, leaving at most one blocked thread.
    pub(crate) async fn read_files_bounded<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let lane = tokio::time::timeout(STAT_LIMIT, self.b2_click_lane.clone().lock_owned()).await.ok()?;
        self.sample_bounded(STAT_LIMIT, lane, work).await
    }

    /// Inventory and marker reads share their own lane, held until the work ends. A stuck mount leaves at most one
    /// blocked inventory thread and does not block launches or clear handles through a click's fingerprint timeout.
    pub(crate) async fn read_inventory_bounded<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
        let lane = tokio::time::timeout(STAT_LIMIT, self.b2_inventory_lane.clone().lock_owned()).await.ok()?;
        self.sample_bounded(STAT_LIMIT, lane, work).await
    }

    fn answer(&self, key: &RequestKey, gate: Gate) -> ReposIpcReply {
        ReposIpcReply(self.state().reply(key, gate))
    }

    /// `work` on the blocking pool, holding `lane` until it really ends, bounded by `limit`. `None` past that.
    async fn sample_bounded<T: Send + 'static>(
        &self,
        limit: std::time::Duration,
        lane: tokio::sync::OwnedMutexGuard<()>,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let stall = self.stall.clone();
        let blocking = tokio::task::spawn_blocking(move || {
            let _lane = lane;
            if let Some(stall) = stall {
                stall();
            }
            work()
        });
        tokio::time::timeout(limit, blocking).await.ok()?.ok()
    }

    /// B2's check for an ask on the gate path, whatever the gate then answers: a change clears before any reply.
    /// Returns what it sampled, the before-run sample a full run is held to. With nothing accepted there is nothing to
    /// sample and nothing to clear.
    async fn check_b2_for_ask(&self) -> B2StatInputs {
        let (generation, baseline) = {
            let state = self.state();
            (state.generation, state.b2.clone())
        };
        if baseline.is_empty() {
            return B2StatInputs::default();
        }
        let sampled = match self.b2_ask_lane.clone().try_lock_owned() {
            Ok(lane) => {
                let inputs = baseline.clone();
                self.sample_bounded(B2_SAMPLE_LIMIT, lane, move || inputs.resample()).await
            }
            Err(_) => None,
        };
        self.state().settle_b2(generation, &baseline, sampled.as_ref());
        sampled.unwrap_or_default()
    }

    /// The same bounded check, immediately before every `open_github`, `copy_push_command` and `editor_open` and before
    /// any sink (plan R2-O3). A change or an unreadable input clears the old handles, so the click then finds its handle
    /// `stale`. It does not take the run latch: a click never waits for a check in flight, and [`ReposState::commit`]
    /// keeps what it cleared.
    pub async fn check_before_sink(&self) {
        let (generation, baseline) = {
            let state = self.state();
            if !state.has_live_actions() {
                return; // nothing a change could end, so nothing to sample
            }
            (state.generation, state.b2.clone())
        };
        if baseline.is_empty() {
            return;
        }
        let inputs = baseline.clone();
        let sampled = match tokio::time::timeout(STAT_LIMIT, self.b2_click_lane.clone().lock_owned()).await {
            Ok(lane) => self.sample_bounded(STAT_LIMIT, lane, move || inputs.resample()).await,
            Err(_) => None,
        };
        self.state().settle_b2(generation, &baseline, sampled.as_ref());
    }

    /// Which repos of a full run's facts may mint ([`accept_stat_inputs`]), on the blocking pool. Past [`B2_SAMPLE_LIMIT`],
    /// or with a sample still stuck, none may: B1's reply goes ahead without B2's handles. The same one bounded read samples
    /// the editor targets' file identities, the baseline a launch compares with (B2 `:69`), so an ask's worst case does
    /// not grow and the pure mint reads no disk.
    async fn accept_b2(&self, facts: &ActionFacts, before: B2StatInputs) -> (B2StatInputs, FolderIdentities) {
        if facts.iter().all(|f| f.stat_inputs.is_none()) {
            return Default::default();
        }
        let Ok(lane) = self.b2_ask_lane.clone().try_lock_owned() else {
            return Default::default();
        };
        let facts = facts.clone();
        self.sample_bounded(B2_SAMPLE_LIMIT, lane, move || {
            let accepted = accept_stat_inputs(&facts, &before);
            let identities = sample_identities(&facts, &accepted);
            (accepted, identities)
        })
        .await
        .unwrap_or_default()
    }
}

/// What the webview sends (plan B1-M4-T13). Closed: an unknown member is refused, so the webview cannot
/// choose the scope (the gate does) or add anything the request would carry to the engine.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReposIpcRequest {
    pub labels: Vec<ReposLabel>,
    pub branches: Vec<ReposBranch>,
    pub page_date: String,
    pub reason: Reason,
    /// The deck's current slide, or `null` (the slides off, or the Full briefing view).
    pub current: Option<CurrentSlide>,
}

/// The answer: the engine's `all` document without `repos` and `actionFacts` and without any undeclared
/// member, with B2's `actions` always on it, plus
/// `gate` (`ran`, `held` or `noResult`), `heldAt` (the epoch seconds of Rust's clock when that check was
/// decided), `uncommittedAt` (the `checkedAt` its "Not committed" counts are as of) and `unknownRepos`
/// (repo keys whose stat errored, `unknown` over their last answer); or, with nothing held for this key,
/// those four alone.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct ReposIpcReply(pub Value);

/// Every engine/resolution/validation failure for THIS command has one path-free IPC error.
fn check_failed() -> EngineError {
    EngineError::Spawn {
        detail: "the live git check could not be completed".into(),
    }
}

/// The engine's document for `scope`, or why there is none. Never the engine's stderr or stdout, which
/// can hold paths: a fixed sentence.
fn engine_document(
    outcome: EngineOutcome,
    scope: ReposScope,
) -> Result<Map<String, Value>, EngineError> {
    let want = match scope {
        ReposScope::All => "all",
        ReposScope::Uncommitted => "uncommitted",
    };
    if outcome.outcome != Outcome::Delivered {
        return Err(check_failed());
    }
    match outcome.payload {
        Some(Value::Object(m))
            if m.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                && m.get("scope").and_then(Value::as_str) == Some(want) =>
        {
            Ok(m)
        }
        _ => Err(check_failed()),
    }
}

/// The body of [`repos_status`], called directly by the tests: gate the ask, run the engine when the
/// gate says so, hold or merge its answer, and reply. `visibility` and `env`'s clock are sampled when it
/// decides, which is AFTER any wait for a check in flight (round 4, R4-M3).
pub async fn status(
    client: &EngineClient,
    env: &LiveEnv,
    visibility: impl Fn() -> Visibility,
    live: &ReposLive,
    request: ReposIpcRequest,
) -> Result<ReposIpcReply, EngineError> {
    let ReposIpcRequest {
        labels,
        branches,
        page_date,
        reason,
        current,
    } = request;
    let request = ReposRequest::new(ReposScope::All, &page_date, labels, branches)?;
    let key = RequestKey::of(&request);
    let _turn = match live.run.try_lock() {
        Ok(turn) => turn,
        Err(_) if reason == Reason::Minute => return Ok(live.answer(&key, Gate::Held)),
        Err(_) => {
            if live
                .owed
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return Ok(live.answer(&key, Gate::Held));
            }
            let turn = live.run.lock().await;
            live.owed.store(false, Ordering::SeqCst);
            turn
        }
    };
    live.state().page_asked(&key);
    // The run latch serializes all decisions/commits. Clone under the short state lock, then do
    // filesystem work on the blocking pool without holding it. A failed run commits no gate state.
    // Past STAT_LIMIT the ask fails like any other (final review 5, L2): returning drops the latch, and
    // the webview dates its page "as of" on the error. While an earlier ask's stat work is still blocked
    // (final review 6, M1), this one fails at once and spawns nothing.
    if live.stat_busy.swap(true, Ordering::SeqCst) {
        return Err(check_failed());
    }
    struct StatDone(std::sync::Arc<AtomicBool>);
    impl Drop for StatDone {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let done = StatDone(live.stat_busy.clone());
    let b2_before = live.check_b2_for_ask().await;
    // After B2's sample, which can wait: the gate decides on the window and the clock as they are now (R4-M3).
    let ask = Ask {
        shown: visibility(),
        current,
        reason,
    };
    let held_at = env.now().epoch_secs;
    let mut state = live.state().clone();
    let base = state.generation;
    let gate_key = key.clone();
    let stall = live.stall.clone();
    let blocking = tokio::task::spawn_blocking(move || {
        let _done = done; // cleared when the blocking work ends, not when the ask stops waiting
        if let Some(stall) = stall {
            stall();
        }
        let decision = state.gate(ask, &gate_key, STAT_CAP);
        let before = match decision {
            Decision::Run(ReposScope::All) => state.prints_before_run(STAT_CAP),
            _ => Vec::new(),
        };
        (state, decision, before)
    });
    let (mut state, decision, before) = tokio::time::timeout(STAT_LIMIT, blocking)
        .await
        .map_err(|_| check_failed())?
        .map_err(|_| check_failed())?;
    let scope = match decision {
        Decision::Held => {
            live.state().commit(state, base);
            return Ok(live.answer(&key, Gate::Held));
        }
        Decision::Run(scope) => scope,
    };
    let base = live.state().carry_clear_from(&state, base);
    let outcome = client
        .invoke(
            Operation::ReposStatus {
                request: request.with_scope(scope),
            },
            &NoProgress,
        )
        .await
        .map_err(|_| check_failed())?;
    let mut doc = engine_document(outcome, scope)?;
    let (targets, facts, minted, b2) = if scope == ReposScope::All {
        let raw = doc.remove("repos").ok_or_else(check_failed)?;
        let raw = project(&raw, "array:target").ok_or_else(check_failed)?;
        let targets =
            serde_json::from_value::<Vec<RepoStatTarget>>(raw).map_err(|_| check_failed())?;
        // B2: the private facts never cross, and a missing or malformed member is empty facts, never a
        // failed check. `actions` is always on an `all` document; only Rust mints it, so anything the
        // engine printed under that name is replaced. `unknownRepos` is for the mint alone: the repos this
        // reply will list as unknown get no handles, and the projection drops the member.
        let facts = parse_action_facts(doc.remove("actionFacts"));
        let unknown: Vec<&str> = targets
            .iter()
            .filter(|t| stat_failed_before(t, &before))
            .map(|t| t.key.as_str())
            .collect();
        doc.insert("unknownRepos".into(), serde_json::json!(unknown));
        // Only repos whose inputs were accepted mint. The rest keep their B1 rows and get no handles.
        let (b2, identities) = live.accept_b2(&facts, b2_before).await;
        let (cards, mut minted) = actions::mint_accepted(&doc, &facts, |key| b2.holds(key), state.next_generation());
        hold_identities(&mut minted, &identities);
        let (cards, minted) = match serde_json::to_value(&cards) {
            Ok(cards) => (cards, minted),
            Err(_) => (Value::Array(Vec::new()), HeldTargets::new()),
        };
        doc.insert("actions".into(), cards);
        (targets, facts, minted, b2)
    } else {
        (Vec::new(), Vec::new(), HeldTargets::new(), B2StatInputs::default())
    };
    let Value::Object(doc) = sanitize_reply(Value::Object(doc)) else {
        return Err(check_failed());
    };
    match scope {
        ReposScope::All => {
            state.hold_all(key.clone(), doc, targets, held_at, before, facts);
            state.b2 = b2;
            state.hold_targets(minted);
        }
        ReposScope::Uncommitted => state.merge_uncommitted(&key, &doc),
    }
    live.state().commit(state, base);
    Ok(live.answer(&key, Gate::Ran))
}

/// `repos status --json` for today's page (briefing redesign B1): the live git check, gated in Rust
/// (see the module header). A READ: no in-flight guard, bounded at `shell::ENGINE_READ_TIMEOUT`; the
/// request reaches the engine on STDIN only; nothing the engine writes to stderr reaches the webview.
#[tauri::command]
pub async fn repos_status<R: Runtime>(
    app: AppHandle<R>,
    engine: State<'_, Engine>,
    env: State<'_, LiveEnv>,
    live: State<'_, ReposLive>,
    request: ReposIpcRequest,
) -> Result<ReposIpcReply, EngineError> {
    let client = engine.client().map_err(|_| check_failed())?;
    status(client, &env, || env.visibility(&app), &live, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Plan B2-M2-T5, P-M2: the production facts parser, re-serialised, equals the shared contract
    /// fixture's `actionFacts` exactly. A member the engine renamed and Rust's `serde` attribute did not
    /// (or the reverse), or one the parser defaulted, fails here instead of passing as a reshaped value.
    /// A lib test, because an integration test does not compile the library under `cfg(test)`, the only
    /// place the private facts structs derive `Serialize`.
    #[test]
    fn action_facts_round_trip() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/action-facts-vectors.json"))
                .expect("the fixture is JSON");
        let raw = fixture["actionFacts"].clone();
        assert!(raw.as_array().is_some_and(|a| !a.is_empty()), "the fixture holds facts");
        let strict: ActionFacts = serde_json::from_value(raw.clone())
            .unwrap_or_else(|e| panic!("the production facts types cannot read the fixture: {e}"));
        let parsed = parse_action_facts(Some(raw.clone()));
        assert_eq!(parsed, strict, "the lenient wrapper read the same facts");
        assert_eq!(
            serde_json::to_value(&parsed).expect("the facts serialise"),
            raw,
            "the parsed facts re-serialise to exactly the fixture's actionFacts"
        );
    }

    #[test]
    fn walk_bounds_enumeration_metadata_and_memory_even_in_a_wide_directory() {
        let root = std::env::temp_dir().join(format!("repos-walk-bound-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        for i in 0..100 {
            std::fs::write(root.join(format!("ref{i}")), "a").unwrap();
        }
        let enumerated = std::cell::Cell::new(0);
        let children = std::fs::read_dir(&root)
            .unwrap()
            .inspect(|_| enumerated.set(enumerated.get() + 1));
        let (mut seen, mut out) = (0, Vec::new());
        assert!(!walk_entries(children, 7, &mut seen, &mut out).unwrap());
        assert_eq!(
            enumerated.get(),
            8,
            "only one overflow probe may be enumerated"
        );
        assert_eq!(seen, 7, "files also consume the metadata budget");
        assert_eq!(out.len(), 7, "partial memory remains bounded");
    }
}
