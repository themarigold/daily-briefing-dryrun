// src/repos/types.ts — the `repos status --json` request and reply types (B1-M3-T9, wave-2 plan; B1 spec
// "Where it is computed"). ONE typed engine type here and one typed GUI model (`git-detail.ts`); Rust is a
// router that holds the reply as a `serde_json::Value`, reads its routing fields (`scope`, `repos[]`,
// `record.accepted`, each `repoViews[i].key` and `.uncommitted`) and strips `repos` and `actionFacts`
// before the IPC reply, adding its own public `actions`.
//
// ⚠ WHAT THE REPLY NEVER CARRIES (the B1-M2 checkpoint's binding rule; pinned by the hostile-repo scan in
// test/repos.status.test.ts): no raw full refname (groups' `Row.ref` and push's `BranchPush.ref` are
// internal), no raw commit subject (only a PR title through `prTitle` and a hidden commit's subject through
// `hiddenSubject`, each redacted and clipped), no `RepoUnknown` message text (it can hold argv, a cwd,
// stderr and revision text: the reply has typed reason codes only), and no path outside the engine-only
// `repos` stat list or private `actionFacts`, which Rust removes. Every displayed branch, remote-tracking
// and tag name is `shownBranch`'d.

/** The request on STDIN, built and validated by Rust (B1-M4-T11) and re-checked here (`parseReposRequest`):
 *  the cards' keys (`norm(label)`; the Other card's is "") with their page lines' hex tokens, in the
 *  webview's card order, and the Where-you-left-off cards' named branches. */
export type ReposRequest = {
  scope: "all" | "uncommitted";
  /** The page's date, `YYYY-MM-DD`: selects the run record. */
  pageDate: string;
  labels: { key: string; tokens: string[] }[];
  branches: { key: string; name: string }[];
};

/** Why a repo answers `unknown`. From the hardening (`dubious-ownership`, `required-filter`,
 *  `partial-clone`, `elsewhere`, `timeout`, `error`); `git-too-old` for every repo when the call's git is
 *  below 2.31; `budget` for a repo not started before the overall budget ran out; `timeout` for a repo whose
 *  own slice ran out; `error` for any other failed call. */
export type RepoUnknownReason =
  | "git-too-old" | "dubious-ownership" | "required-filter" | "partial-clone" | "elsewhere" | "timeout" | "budget" | "error";

/** "Not committed": the hardened `status --porcelain --ignore-submodules=all`'s non-empty line count, or
 *  unknown (the repo, or that call alone, could not be answered under its own 10 s bound). */
export type Uncommitted = { count: number } | { unknown: true };

/** A repo view (per repo, path-free): `key` is the repo key (`"r"` + 12 hex of SHA-256 of its real path,
 *  stable across replies), `name` its display name (`repoLabelFor`). `storeKey` names the repo's git common
 *  dir (`"s"` + 12 hex of SHA-256 of its real path): linked worktrees and a configured subdirectory share it,
 *  and their push work is reported once per store. `treeKey` names its working tree's top level (`"t"` + 12
 *  hex, the same way): a configured subdirectory shares its enclosing checkout's, a linked worktree has its
 *  own. Both are hashes, never paths; null on an unknown view whose hardening did not answer. With no repos
 *  at all (no accepted record and no configured `repos`), `repoViews` is exactly one `noRepos` entry, and
 *  the webview keeps A's disclosure. */
export type RepoView =
  | { key: string; name: string; state: "ok"; noRemote: boolean; uncommitted: Uncommitted; storeKey: string; treeKey: string }
  | { key: string; name: string; state: "unknown"; reason: RepoUnknownReason; noRemote: false; uncommitted: Uncommitted; storeKey: string | null; treeKey: string | null }
  | { key: ""; name: ""; state: "noRepos"; noRemote: false; uncommitted: { unknown: true } };

/** A grouped commit: a page commit with the token it resolved from, or a hidden one (behind "(+N more)")
 *  with its redacted, clipped subject. */
export type ReplyCommit = { sha: string; token: string } | { sha: string; token: null; subject: string };

/** A row's push words: its branch's state and "N not pushed" (the branch's share of the one population,
 *  which can exceed the row's own commit count). */
export type PushWords = { state: "pushed" | "partly" | "never"; notPushed: number };

/** A row, in the engine's order (PR rows by number; branch rows pushed → partly → never, each by name;
 *  the default branch's row; tag rows by name; the detached-HEAD row; the "no longer on a branch" row).
 *  Commits within a row are newest first. `push` is null in a repo with no remote. */
export type ReplyRow =
  | { kind: "pr"; number: number; title: string; commits: ReplyCommit[] }
  | { kind: "branch"; name: string; push: PushWords | null; commits: ReplyCommit[] }
  | { kind: "remoteBranch"; name: string; commits: ReplyCommit[] }
  | { kind: "default"; name: string; push: PushWords | null; commits: ReplyCommit[] }
  | { kind: "tag"; name: string; commits: ReplyCommit[] }
  | { kind: "detached"; commits: ReplyCommit[] }
  | { kind: "orphan"; commits: ReplyCommit[] };

/** One What-you-did card's detail, one per request label, in request order. `repoKey`: the card's repo
 *  (the record's for its label, else the one repo its tokens resolved in, else null). `state` is `unknown`
 *  when a repo the card needs could not be read or a token could not be settled; its rows then hold only
 *  what the readable repos gave. `notMatched`: tokens that resolved to no commit or were ambiguous.
 *  `prNumbers`: the distinct PR numbers of its PR rows, ascending (the card rule's group half). `onlyHere`:
 *  the sum of its rows' "N not pushed" ("N only on this Mac" on its summary line). */
export type LabelView = {
  key: string;
  repoKey: string | null;
  state: "ok" | "unknown";
  rows: ReplyRow[];
  notMatched: number;
  prNumbers: number[];
  onlyHere: number;
};

/** The Where-you-left-off branch line's live words, per request branch entry whose card has a readable repo
 *  (none for a card with no repo, or whose repo answers unknown). `name` is the request's name, through
 *  `shownBranch`. */
export type BranchLine =
  | { key: string; name: string; state: "live"; notPushed: number; neverPushed: boolean; behind: number }
  | { key: string; name: string; state: "missing" }
  | { key: string; name: string; state: "noRemote" };

/** "Push your work": one card per store with work only on this machine, at the store's first readable
 *  checkout, by the repo's first card in the request's order, then repos no card names, by path.
 *  `firstLabel` is that card's key (null: none); `storeKey` is that checkout's `RepoView.storeKey`. */
export type PushCard = {
  repoKey: string;
  storeKey: string;
  firstLabel: string | null;
  repoName: string;
  branches: { name: string; commits: number }[];
  onDefault: { name: string; commits: number } | null;
};

/** Rust-minted, generation-bound handles. No URL, path, command or raw branch name crosses IPC. */
export type ActionCard = {
  repoKey: string;
  cardKind: "did" | "leftOff" | "push" | "tile";
  cardId: string;
  handles: {
    handle: string;
    target: "pr" | "branch" | "commit" | "compare" | "editor" | "copy";
    row: number | null;
    sha: string | null;
    project: string | null;
    label: string | null;
  }[];
};

/** The IPC reply (`repos_status`): private engine members removed, Rust-minted actions added. */
export type ReposReply = {
  schemaVersion: 1;
  scope: "all";
  /** When this check started (ISO 8601, UTC). */
  checkedAt: string;
  /** The run record: accepted only for the request's `pageDate`; its window start when accepted. */
  record: { accepted: boolean; windowStartUtc: string | null };
  /** The window start this check used: the record's, else the local midnight of the oldest resolved page
   *  commit's committer date, else null. */
  windowStartUtc: string | null;
  /** In What-you-did card order (each repo at its first card), then by path. */
  repoViews: RepoView[];
  labels: LabelView[];
  branchLines: BranchLine[];
  pushCards: PushCard[];
  actions: ActionCard[];
  /** "Only on this Mac · N commits on M branches", across every repo. */
  tile: { commits: number; branches: number };
  /** The commits behind "(+N more)": `perLabel` holds, per request card key, how many are listed (in that
   *  card's rows, as hidden commits). `complete` only with an accepted record, every repo a card needs
   *  answering, every recorded hidden commit found, and every one landing on a card the request sent. */
  hidden: { complete: boolean; perLabel: Record<string, number> };
};

/** Rust's stat-gate input, per readable repo: both dirs absolute (`rev-parse --path-format=absolute`);
 *  `reftable` from a `reftable/` directory in the common dir or `extensions.refStorage = reftable`. */
export type RepoStatTarget = { key: string; path: string; gitDir: string; commonDir: string; reftable: boolean };

/** Engine-only facts: names are credential-free, paths are canonical, and remote URLs never leave
 *  the engine. Null denotes unavailable facts, distinct from a known false presence/reachability result.
 *  Readers: remotes.ts, reach.ts, checkouts.ts and, for `statInputs`, facts.ts. The shared contract fixture is
 *  `gui/src-tauri/tests/fixtures/action-facts-vectors.json`. */
export type RepoFacts = {
  /** Exact join key for repoViews, pushCards and non-null labels[].repoKey; never join by position. */
  repoKey: string;
  path: string;
  remotes: {
    name: string;
    transport: "network" | "refused" | null;
    github: { owner: string; repo: string } | null;
    vcs: boolean | null;
    push: boolean | null;
    configSection: boolean | null;
    url: boolean | null;
    legacy: boolean | null;
    defaultBranch: string | null;
  }[] | null;
  branches: {
    name: string;
    upstreamRemote: string | null;
    upstreamBranch: string | null;
    pushRemote: string | null;
    /** `branch.<n>.remote` or `.pushremote` holds what is only not a remote name, such as a URL. The value never crosses: the
     *  three members above are null and mean unknown, so a reader must not take them for "no upstream". A credential-shaped
     *  value has no such entry; the branch is left out. */
    remoteFactsUnknown: boolean;
    checkoutPath: string | null;
    /** `listedRefOk`: a ref git lists, whose name is neither a leading `-` nor `HEAD`. */
    refFormatOk: boolean;
    /** The branch's own tip, or null when it is not a full 40-hex id. Reply rows cannot supply it: they hold
     *  only one card's commits, so a row's newest commit can be older than the branch. */
    tip: string | null;
  }[] | null;
  pushDefault: string | null;
  /** Git's `push.default` is `upstream` or `tracking`, the only values under which a plain `git push` goes to a differently
   *  named upstream. Read from the same config listing as the rest; an unknown or unreadable value is false (plan §0). */
  pushesToUpstream: boolean;
  legacyNames: string[] | null;
  /** A config section or legacy entry exists under a name these facts leave out: the name never crosses, only this.
   *  What is left cannot be counted as the sole remote (B2 `:90`), and a kept name's slashed refs cannot be shown to be
   *  its own (`readReachFacts`). A bad pointer alone (`branch.<n>.remote`, `remote.pushDefault`) is no remote and is no
   *  reason here; it costs what depends on it (`remoteFactsUnknown`, or the entry). */
  omittedRemotes: boolean;
  /** An empty remote list means known unreachable; null means the read did not establish an answer. */
  reachableRemotes: { sha: string; remotes: string[] | null }[] | null;
  /** A commit tied to a PR by merge or squash evidence on the known default of a remote that reads as GitHub, and every other
   *  such remote holding that evidence commit, with a known default or without. Any of them may own `#N`, so more than one
   *  repository among them is no owner (Rust counts distinct `owner/repo`). A remote reading as no GitHub repository owns no `#N`. */
  prEvidence: { number: number; sha: string; remote: string; method: "merge" | "squash" }[] | null;
  /** Every safely named remote-tracking branch with its tip. All or nothing, because uniqueness needs the
   *  whole list: null over REMOTE_BRANCHES_CAP or on a failed read. A branch sharing a tip with a ref left
   *  out for its name is left out too, since that ref could make it look unique. */
  remoteBranches: { remote: string; name: string; sha: string }[] | null;
  /** Checkout-relative roots (empty for the checkout's top; a configured subdirectory's own path comes first in its
   *  roots), the engine-built 32-hex project keys over the run record's repo and repo-relative root, and the public
   *  card keys (`norm` of the run record's labels) that map to each root, the only join from a card to a
   *  root. No accepted record gives no keys, and nor does the project's own folder when no label's root is here. A key on
   *  two roots joins neither. `displayLabel` is the first of those labels as written, for Settings' row; null with none,
   *  when the row shows the repo's name. */
  roots: { root: string; project: string; labelKeys: string[]; displayLabel: string | null }[] | null;
  /** The public card keys (`norm` of the run record's labels) of every label on this repo, whether or not its folder is here:
   *  how a card with no What-you-did row finds its repo. `roots` says what can be launched, this says whose card it is, so a
   *  detached checkout or a folder absent from this branch costs a card its editor and nothing else (B2 `:42`). Null
   *  when the repo's identity could not be read, which leaves every such join unknown. */
  cardKeys: string[] | null;
  /** Separate from RepoStatTarget: B2 metadata cannot change B1's stat gate or equality. Every symlink on the way
   *  to a config source git read, the source itself, and the fixed metadata the other facts come from, each with a
   *  stamp taken before those facts were read (null: not established, mints nothing). Rust re-samples them. */
  statInputs: {
    path: string;
    stamp: { mtimeNs: string; size: string; kind: "file" | "dir" | "symlink" | "missing"; target: string | null } | null;
  }[] | null;
};

export type ActionFacts = RepoFacts[];

/** What the engine prints for `scope: "all"`. Public actions are minted only by Rust. */
export type ReposEngineReply = Omit<ReposReply, "actions"> & { repos: RepoStatTarget[]; actionFacts: ActionFacts };

/** What the engine prints for `scope: "uncommitted"` (the minute "Not committed" status alone). */
export type ReposUncommittedReply = {
  schemaVersion: 1;
  scope: "uncommitted";
  checkedAt: string;
  repoViews: { key: string; uncommitted: Uncommitted }[];
};
