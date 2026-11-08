// src/repos/push.ts — push state, the one population, the branch line's live words (B1-M2-T7, wave-2
// plan; B1 spec "Pushed", "Which branches count", "What N and M count").
//
// PUSHED means reachable from ANY `refs/remotes/*` ref (a push without `-u` counts), as of the last fetch
// or push: nothing is fetched. "No remote" means `git remote` prints nothing; a configured remote with no
// `refs/remotes/*` yet is NOT "no remote" (its work is "never pushed"). A repo with no remote has no push
// state at all (OD3, orchestrator-settled 2026-10-24): no amber, no push card, and its branch-line
// entries answer `noRemote` (A's words stay).
// Per local branch, its OWN commits are those not on the default ref (for the default branch itself,
// all of its commits):
//   never pushed  default branch or no upstream, and none of its own commits reachable from a remote ref;
//   pushed        none of its own commits unreached by a remote ref;
//   partly        otherwise (an upstream that is gone lands here: a blue tag with amber "N not pushed").
// THE ONE POPULATION, per repo: the unpushed own commits dated at or after the window start, on the local
// branches that count (with the record, every branch holding such a commit; without it, only branches
// holding page commits), the default branch included; a branch that counts as merged never counts. A
// row's "N not pushed", the push card's counts, the tile's N and M and Good morning's N all read it.
// ARGV: every count is `rev-list … --end-of-options <full ref> ^<full ref>…`, `--remotes` written as each
// `refs/remotes/…` ref from one `for-each-ref`; the page's branch names are matched in JS and never reach
// an argv.
import { LISTING_MAX_BYTES, windowArgs } from "../git";
import { shownBranch } from "../recapCampaigns";
import { REDACTION } from "../transcripts/credentials";
import { gitOut, RepoUnknown } from "./hgit";
import { SHAS_PER_CALL } from "./resolve";
import { byteCmp, nearest, refsContaining, type RepoScan, type Row } from "./groups";

const lines = (s: string) => s.split("\n").filter((l) => l !== "");
const SHA40 = /^[0-9a-f]{40}$/;

export type HeadRef = { ref: string; upstream: string; tip: string };

/** Parse `for-each-ref --format=%(refname)%1f%(upstream)%1f%(objectname) refs/heads/` (`%1f`, not
 *  `%x1f`, which for-each-ref prints literally, measured). A line of another shape is a read error. Pure. */
export function parseHeads(out: string): HeadRef[] {
  return lines(out).map((l) => {
    const parts = l.split("\x1f");
    if (parts.length !== 3 || !parts[0]!.startsWith("refs/heads/") || !SHA40.test(parts[2]!)) throw new RepoUnknown("error", "for-each-ref refs/heads/");
    return { ref: parts[0]!, upstream: parts[1]!, tip: parts[2]! };
  });
}

export type PushFacts = { noRemote: boolean; remoteRefs: string[]; heads: HeadRef[] };

/** One repo's push facts: `git remote`, every `refs/remotes/*` ref, every local branch with its upstream. */
export async function pushFacts(scan: RepoScan): Promise<PushFacts> {
  const remotes = lines(await gitOut(scan.rg, ["remote"]));
  if (remotes.length === 0) return { noRemote: true, remoteRefs: [], heads: [] };
  const remoteRefs = lines(await gitOut(scan.rg, ["for-each-ref", "--format=%(refname)", "--end-of-options", "refs/remotes/"], { maxBytes: LISTING_MAX_BYTES }))
    .filter((r) => r.startsWith("refs/remotes/"));
  const heads = parseHeads(await gitOut(scan.rg, ["for-each-ref", "--format=%(refname)%1f%(upstream)%1f%(objectname)", "--end-of-options", "refs/heads/"], { maxBytes: LISTING_MAX_BYTES }));
  return { noRemote: false, remoteRefs, heads };
}

export type BranchPush = {
  /** The full refname: INTERNAL, never sent. */
  ref: string;
  /** Shown through `shownBranch`. */
  name: string;
  isDefault: boolean;
  neverPushed: boolean;
  state: "pushed" | "partly" | "never";
  /** The branch's share of the one population: its unpushed own commits dated at or after the window
   *  start, newest first. */
  population: string[];
  /** Exclusive nearest-tip share for the push card; raw population stays intact for rows and tile. */
  cardCommits?: number;
};
export type RepoPush =
  | { noRemote: true }
  | { noRemote: false; branches: BranchPush[]; counted: BranchPush[]; merged: ReadonlySet<string>; tile: { commits: number; branches: number } };

const count = async (scan: RepoScan, revs: readonly string[]): Promise<number> => {
  const out = (await gitOut(scan.rg, ["rev-list", "--count", "--end-of-options", ...revs], { maxBytes: LISTING_MAX_BYTES })).trim();
  if (!/^\d+$/.test(out)) throw new RepoUnknown("error", "rev-list --count");
  return Number(out);
};

/** Unreached by every remote chunk: exclusions are a union, so chunk results intersect.
 *  With no remotes, still list the branch once. Preserve the first listing's order and timestamps. */
async function unpushedLines(scan: RepoScan, own: readonly string[], remoteRefs: readonly string[], args: readonly string[], chunkSize: number): Promise<string[]> {
  let answer: string[] | undefined;
  for (let i = 0; i < Math.max(remoteRefs.length, 1); i += chunkSize) {
    const exclusions = remoteRefs.slice(i, i + chunkSize).map((r) => `^${r}`);
    const listing = lines(await gitOut(scan.rg, ["rev-list", ...args, "--end-of-options", ...own, ...exclusions], { maxBytes: LISTING_MAX_BYTES }));
    if (answer === undefined) answer = listing;
    else {
      const kept = new Set(listing);
      answer = answer.filter((line) => kept.has(line));
    }
  }
  return answer ?? [];
}

/** Push state for every local branch, and the one population. `merged`: the branches that count as
 *  merged (squash.ts). `pageShas`: null with an accepted record; else the page's resolved commits, and
 *  only branches holding one count. */
export async function repoPush(scan: RepoScan, facts: PushFacts, opts: { merged: ReadonlySet<string>; pageShas: ReadonlySet<string> | null; refsPerCall?: number }): Promise<RepoPush> {
  if (facts.noRemote) return { noRemote: true };
  return countPush(scan, await branchPushes(scan, facts, opts.refsPerCall), { ...opts, remoteRefs: facts.remoteRefs });
}

/** `repoPush`'s first half: every local branch's push state and its share of the one population, before
 *  any branch is known to count as merged. The command (B1-M3) reads it to choose the squash check's
 *  branches, then finishes with `countPush`, so the per-branch counts run once. Empty for a repo with no
 *  remote. */
export async function branchPushes(scan: RepoScan, facts: PushFacts, refsPerCall?: number): Promise<BranchPush[]> {
  if (facts.noRemote) return [];
  const { refs: defaults } = await scan.defaults();
  const chunkSize = refsPerCall ?? SHAS_PER_CALL;
  const w = await windowArgs(scan.windowStart.getTime(), { timeoutMs: scan.rg.budget.callTimeoutMs() });
  const branches: BranchPush[] = [];
  for (const h of [...facts.heads].sort((a, b) => byteCmp(a.ref, b.ref))) {
    const isDefault = defaults.includes(h.ref);
    const own = [h.ref, ...(isDefault ? [] : defaults.map((d) => `^${d}`))];
    const ownCount = await count(scan, own);
    const unpushed = facts.remoteRefs.length <= chunkSize
      ? await count(scan, [...own, ...facts.remoteRefs.map((r) => `^${r}`)])
      : (await unpushedLines(scan, own, facts.remoteRefs, [], chunkSize)).length;
    let population: string[] = [];
    if (unpushed > 0) {
      const out = await unpushedLines(scan, own, facts.remoteRefs, ["--timestamp", ...w], chunkSize);
      population = out.map((l) => l.split(" ")).filter(([ts, sha]) => sha !== undefined && SHA40.test(sha) && Number(ts) * 1000 >= scan.windowStart.getTime()).map(([, sha]) => sha!);
    }
    const neverPushed = (isDefault || h.upstream === "") && ownCount > 0 && unpushed === ownCount;
    branches.push({ ref: h.ref, name: shownBranch(h.ref.slice("refs/heads/".length)), isDefault, neverPushed, state: unpushed === 0 ? "pushed" : neverPushed ? "never" : "partly", population });
  }
  return branches;
}

/** `repoPush`'s second half over `branchPushes`' answer: which branches count (never one that counts as
 *  merged; without a record, only those holding a page commit), each one's nearest-tip share for the push
 *  card, and the tile. Sets `cardCommits` on the counted branches. */
export async function countPush(scan: RepoScan, branches: BranchPush[], opts: { merged: ReadonlySet<string>; pageShas: ReadonlySet<string> | null; remoteRefs: readonly string[] }): Promise<RepoPush> {
  const { refs: defaults } = await scan.defaults();
  const holding = opts.pageShas === null ? null : new Set(await refsContaining(scan.rg, [...opts.pageShas], ["refs/heads/"]));
  const counted = branches.filter((b) => b.population.length > 0 && !opts.merged.has(b.ref) && (holding === null || holding.has(b.ref)));
  const commits = new Set(counted.flatMap((b) => b.population));
  const at = await nearest({ own: async (ref) => defaults.includes(ref)
    ? await unpushedLines(scan, [ref], opts.remoteRefs, ["--topo-order"], SHAS_PER_CALL)
    : scan.own(ref) }, counted.map((b) => b.ref), commits);
  for (const b of counted) b.cardCommits = b.population.filter((sha) => at.get(sha) === b.ref).length;
  // M counts the default branch ONCE, however many default refs hold work (a local `main` and `master`):
  // the push card shows them as one "N commits on {default}", and the webview's tile arithmetic reads the card.
  const branchCount = counted.filter((b) => !b.isDefault).length + (counted.some((b) => b.isDefault) ? 1 : 0);
  return { noRemote: false, branches, counted, merged: opts.merged, tile: { commits: commits.size, branches: branchCount } };
}

/** A row's push words: its branch's state and "N not pushed" (the branch's population); the default row
 *  reads the default branch (the local default ref named by `defaults().name`, else the first local
 *  default ref); a remote-only row is pushed. Null for a row with no push state (a PR, tag, detached or
 *  orphan row, or any row in a repo with no remote). Pure. */
export function rowPush(row: Row, push: RepoPush): { state: BranchPush["state"]; notPushed: number } | null {
  if (push.noRemote) return null;
  if (row.kind === "remoteBranch") return { state: "pushed", notPushed: 0 };
  let b: BranchPush | undefined;
  if (row.kind === "branch") b = push.branches.find((x) => x.ref === row.ref);
  else if (row.kind === "default") b = push.branches.find((x) => x.isDefault && x.name === row.name) ?? push.branches.find((x) => x.isDefault);
  return b === undefined ? null : { state: b.state, notPushed: b.population.length };
}

/** The row-order rank of a branch row (0 pushed, 1 partly, 2 never), for `orderRows`. Pure. */
export function pushRank(push: RepoPush): (row: Row) => number {
  return (row) => {
    const p = rowPush(row, push);
    return p === null ? 0 : p.state === "pushed" ? 0 : p.state === "partly" ? 1 : 2;
  };
}

export type PushCard = { repoKey: string; storeKey: string; firstLabel: string | null; repoName: string; branches: { name: string; commits: number }[]; onDefault: { name: string; commits: number } | null };

/** One card per repo with work only on this machine, by the repo's first label in the request's card
 *  order, then the repos with no page label by path. Pure. */
export function pushCards(repos: readonly { repoKey: string; storeKey: string; repoName: string; path: string; firstLabel: string | null; firstLabelIndex: number | null; push: RepoPush }[]): PushCard[] {
  const withWork = repos.filter((r) => !r.push.noRemote && r.push.tile.commits > 0);
  const sorted = [...withWork].sort((a, b) => {
    if (a.firstLabelIndex !== null && b.firstLabelIndex !== null) return a.firstLabelIndex - b.firstLabelIndex;
    if (a.firstLabelIndex !== null) return -1;
    if (b.firstLabelIndex !== null) return 1;
    return byteCmp(a.path, b.path);
  });
  return sorted.map((r) => {
    const counted = r.push.noRemote ? [] : r.push.counted;
    const def = counted.filter((b) => b.isDefault);
    const defCommits = def.reduce((n, b) => n + (b.cardCommits ?? b.population.length), 0);
    return {
      repoKey: r.repoKey, storeKey: r.storeKey, firstLabel: r.firstLabel, repoName: r.repoName,
      branches: counted.filter((b) => !b.isDefault).sort((x, y) => byteCmp(x.name, y.name)).map((b) => ({ name: b.name, commits: b.cardCommits ?? b.population.length })),
      onDefault: def.length > 0 ? { name: def[0]!.name, commits: defCommits } : null,
    };
  });
}

export type BranchLineEntry =
  | { key: string; name: string; state: "live"; notPushed: number; neverPushed: boolean; behind: number }
  | { key: string; name: string; state: "missing" }
  | { key: string; name: string; state: "noRemote" };

/** One Where-you-left-off card's branch line, looked up by NAME, in JS, among the repo's local branches
 *  (the page's name never reaches an argv). A `[redacted]` name, or no such branch now, is "missing".
 *  `behind` is `rev-list --count --end-of-options <upstream> ^<ref>`, both full refnames from the
 *  listing, when the upstream exists; 0 otherwise. No fetch. */
export async function branchLine(scan: RepoScan, facts: PushFacts, push: RepoPush, entry: { key: string; name: string }): Promise<BranchLineEntry> {
  const { key, name } = entry;
  if (facts.noRemote || push.noRemote) return { key, name, state: "noRemote" };
  if (name === REDACTION) return { key, name, state: "missing" };
  const head = facts.heads.find((h) => h.ref === `refs/heads/${name}`);
  const b = head === undefined ? undefined : push.branches.find((x) => x.ref === head.ref);
  if (head === undefined || b === undefined) return { key, name, state: "missing" };
  const upstreamExists = head.upstream !== "" && (facts.remoteRefs.includes(head.upstream) || facts.heads.some((h) => h.ref === head.upstream));
  const behind = upstreamExists ? await count(scan, [head.upstream, `^${head.ref}`]) : 0;
  const merged = push.merged.has(head.ref);
  return { key, name, state: "live", notPushed: merged ? 0 : b.population.length, neverPushed: !merged && b.neverPushed, behind };
}
