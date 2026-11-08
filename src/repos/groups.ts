// src/repos/groups.ts — the groups for a project, and the order rows are drawn in (B1-M2-T5, wave-2 plan;
// B1 spec "Groups for a project").
//
// Every commit given for a label (its resolved page commits, plus with a run record its hidden ones) shows
// EXACTLY ONCE, in the first of these that holds it:
//   1. a merged PR: a member of a "Merge pull request #N" merge on the default ref (`listDefaultRefMerges`
//      to the live now, and `mergeMembers`; the nearest merge, the oldest on the first-parent line,
//      wins), a default-ref "(#N)" commit (B1's own bounded listing, the exact window applied in JS), or a
//      commit on a kept local branch that counts as squash-merged (`squashed`, from squash.ts);
//   2. on main: reachable from the default refs (a windowed `rev-list`, then unwindowed ancestor checks);
//   3. a branch in progress: a local branch holding it off the default ref, the nearest tip winning
//      (the commit's index in that branch's `rev-list --topo-order`), ties by name in byte order; else a
//      remote-tracking branch, by the same rule ("branch {remote}/{name}");
//   4. a tag ("tag {name}", the first by name in byte order) or a detached HEAD;
//   5. no longer on a branch.
// A ref here is `refs/heads/*`, `refs/tags/*`, `refs/remotes/*` (never a remote `*/HEAD`) or HEAD. Every name shown
// goes through `shownBranch`; every PR title through `redactCredentials`, then the 200-character clip.
//
// ARGV (B1-M1-T2): every revision is a full ref name or a 40-hex SHA, after `--end-of-options`, an
// exclusion written `^<full ref>`. The shared `listDefaultRefMerges` and `mergeMembers` already pass only
// full refnames and SHA ranges; their argv is not changed.
import { listDefaultRefMerges, mergeMembers, defaultRefs, windowArgs, NO_SHOW_SIGNATURE, LISTING_MAX_BYTES } from "../git";
import { shownBranch } from "../recapCampaigns";
import { redactCredentials } from "../transcripts/credentials";
import { gitIn, gitOut, resolveIn, sharedIn, RepoUnknown, type RepoGit } from "./hgit";
import { commitDates, SHAS_PER_CALL } from "./resolve";

/** A label's commit: a page commit with the token it resolved from, or a hidden one (behind "(+N more)",
 *  B1-M3-T8) with its subject. */
export type LabelCommit = { sha: string; token: string } | { sha: string; token: null; subject: string };

/** A row. A branch row's `ref` is the full refname, for the push state; it is INTERNAL and never sent
 *  (the reply carries `name`, through `shownBranch`). */
export type Row =
  | { kind: "pr"; number: number; title: string; commits: LabelCommit[] }
  | { kind: "branch"; ref: string; name: string; commits: LabelCommit[] }
  | { kind: "remoteBranch"; ref: string; name: string; commits: LabelCommit[] }
  | { kind: "default"; name: string; commits: LabelCommit[] }
  | { kind: "tag"; name: string; commits: LabelCommit[] }
  | { kind: "detached"; commits: LabelCommit[] }
  | { kind: "orphan"; commits: LabelCommit[] };

/** A kept local branch squash-merged as PR #`number` (squash commit `sha`, its shown title). */
export type SquashMatch = { number: number; sha: string; title: string };

export const PR_TITLE_MAX = 200;
/** A PR title for the reply: redacted FIRST, then cut to `PR_TITLE_MAX − 1` and marked with "…"
 *  (`clipSubject`'s idiom, src/generator.ts: a credential the cut halved would no longer match). Pure. */
export function prTitle(raw: string): string {
  const t = redactCredentials(raw);
  if (t.length <= PR_TITLE_MAX) return t;
  let end = PR_TITLE_MAX - 1;
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${t.slice(0, end)}…`;
}

/** Byte order of the UTF-8 encodings (git's own sort), not UTF-16 code units. */
export function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const SHA40 = /^[0-9a-f]{40}$/;
const SQUASH_RE = /\s*\(#(\d+)\)\s*$/;
const lines = (s: string) => s.split("\n").filter((l) => l !== "");

export type PrMerge = { sha: string; number: number; at: number; order: number; members: Set<string> };
export type SquashCommit = { sha: string; number: number; title: string; at: number };

/** One repo's facts, read once and shared by every label in the repo (groups), the squash check and the
 *  push state. Each getter runs its calls on first use and caches the promise. */
export type RepoScan = {
  rg: RepoGit;
  windowStart: Date;
  now: Date;
  /** The default refs (`defaultRefs`' union, full refnames that exist) and the default branch's name. */
  defaults(): Promise<{ refs: string[]; name: string | null }>;
  /** The default refs resolved once per scan, deduplicated by SHA. */
  defaultShas(): Promise<string[]>;
  /** The PR merges on the default refs in [windowStart, now), with their members. */
  prMerges(): Promise<PrMerge[]>;
  /** The default refs' "(#N)" commits in [windowStart, now). */
  squashes(): Promise<SquashCommit[]>;
  /** Every commit reachable from the default refs (pre-filtered by the window's `--since-as-filter`). */
  onDefault(): Promise<Set<string>>;
  /** `rev-list --topo-order --end-of-options <ref> ^<each default ref>`: the ref's commits off the
   *  default ref, nearest the tip first. */
  own(ref: string): Promise<string[]>;
  /** The first non-empty line of merge `sha`'s body (`show -s --no-show-signature --format=%b`), raw. */
  mergeBody(sha: string): Promise<string>;
};

function memo<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}

async function windowed(scan: { rg: RepoGit; windowStart: Date }): Promise<string[]> {
  return windowArgs(scan.windowStart.getTime(), { timeoutMs: scan.rg.budget.callTimeoutMs() });
}

/** The scan of one repo for a live check at `now`, its window from `windowStart`. */
export function openScan(rg: RepoGit, windowStart: Date, now: Date): RepoScan {
  const inWindow = (ms: number) => ms >= windowStart.getTime() && ms < now.getTime();
  const defaults = memo(async () => {
    const d = await sharedIn(() => defaultRefs(rg.repo, rg.budget, { lead: rg.lead }));
    if (d.unread) throw new RepoUnknown("timeout", "default refs");
    return { refs: d.refs, name: d.name };
  });
  const defaultShas = memo(async () => {
    const { refs } = await defaults();
    const shas = new Set<string>();
    for (const ref of refs) {
      const sha = await resolveIn(rg, `${ref}^{commit}`);
      if (sha !== null) shas.add(sha);
    }
    return [...shas];
  });
  const prMerges = memo(async () => {
    const r = await sharedIn(() => listDefaultRefMerges(rg.repo, windowStart, now, rg.budget, { lead: rg.lead }));
    if (r.unread) throw new RepoUnknown("timeout", "default-ref merges");
    const prs = r.merges.filter((m) => m.pr !== undefined);
    const mm = await sharedIn(() => mergeMembers(rg.repo, prs, rg.budget, { lead: rg.lead }));
    if (mm.timedOut > 0) throw new RepoUnknown("timeout", "merge members");
    return prs.map((m, order) => ({ sha: m.sha, number: m.pr!.number, at: Date.parse(m.timestamp), order, members: new Set(mm.members.get(m.sha) ?? []) }));
  });
  const squashes = memo(async () => {
    const { refs } = await defaults();
    if (refs.length === 0) return [];
    const w = await windowed({ rg, windowStart });
    const out = await gitOut(rg, ["log", NO_SHOW_SIGNATURE, "--format=%H%x1f%cI%x1f%s", ...w, "--end-of-options", ...refs], { maxBytes: LISTING_MAX_BYTES });
    const seen = new Set<string>();
    const list: SquashCommit[] = [];
    for (const line of lines(out)) {
      const [sha, iso, subject = ""] = line.split("\x1f");
      if (!sha || !iso || seen.has(sha)) continue;
      seen.add(sha);
      const at = Date.parse(iso);
      const m = SQUASH_RE.exec(subject);
      if (!m || !inWindow(at)) continue;
      const number = Number(m[1]);
      if (!Number.isSafeInteger(number) || number <= 0) continue;
      list.push({ sha, number, title: subject.replace(SQUASH_RE, ""), at });
    }
    return list;
  });
  const onDefault = memo(async () => {
    const { refs } = await defaults();
    if (refs.length === 0) return new Set<string>();
    const w = await windowed({ rg, windowStart });
    return new Set(lines(await gitOut(rg, ["rev-list", ...w, "--end-of-options", ...refs], { maxBytes: LISTING_MAX_BYTES })));
  });
  const owns = new Map<string, Promise<string[]>>();
  const own = (ref: string) => {
    let p = owns.get(ref);
    if (p === undefined) {
      p = defaults().then(async ({ refs }) => lines(await gitOut(rg,
        ["rev-list", "--topo-order", "--end-of-options", ref, ...refs.filter((d) => d !== ref).map((d) => `^${d}`)], { maxBytes: LISTING_MAX_BYTES })));
      owns.set(ref, p);
    }
    return p;
  };
  const bodies = new Map<string, Promise<string>>();
  const mergeBody = (sha: string) => {
    let p = bodies.get(sha);
    if (p === undefined) {
      if (!SHA40.test(sha)) throw new RepoUnknown("error", "merge sha");
      p = gitOut(rg, ["show", "-s", NO_SHOW_SIGNATURE, "--format=%b", "--end-of-options", sha]).then((b) => b.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "");
      bodies.set(sha, p);
    }
    return p;
  };
  return { rg, windowStart, now, defaults, defaultShas, prMerges, squashes, onDefault, own, mergeBody };
}

/** Refs holding any of `shas`: `--contains` filters are OR'd. Union each bounded call's answer,
 *  then restore git's byte ordering. `chunkSize` lets tests compare the same query across chunk sizes. */
export async function refsContaining(rg: RepoGit, shas: readonly string[], patterns: readonly string[], chunkSize = SHAS_PER_CALL): Promise<string[]> {
  const refs = new Set<string>();
  for (let i = 0; i < shas.length; i += chunkSize) {
    const contains = shas.slice(i, i + chunkSize).flatMap((s) => ["--contains", s]);
    for (const ref of lines(await gitOut(rg, ["for-each-ref", "--format=%(refname)", ...contains, "--end-of-options", ...patterns], { maxBytes: LISTING_MAX_BYTES }))) refs.add(ref);
  }
  return [...refs].sort(byteCmp);
}

/** An unwindowed reachability check. Exit 1 means false; every other failure stays unknown. */
async function isAncestor(rg: RepoGit, sha: string, ref: string): Promise<boolean> {
  const r = await gitIn(rg, ["merge-base", "--is-ancestor", "--end-of-options", sha, ref]);
  if (r.code !== 0 && r.code !== 1) throw new RepoUnknown("error", `merge-base --is-ancestor: exit ${r.code}`);
  return r.code === 0;
}

/** The nearest-tip branch for each commit among `refs` (each ref's `own` listing; the smallest index
 *  wins, ties by ref name in byte order). */
export async function nearest(scan: Pick<RepoScan, "own">, refs: readonly string[], shas: ReadonlySet<string>): Promise<Map<string, string>> {
  const best = new Map<string, { ref: string; index: number }>();
  for (const ref of [...refs].sort(byteCmp)) {
    const listing = await scan.own(ref);
    listing.forEach((sha, index) => {
      if (!shas.has(sha)) return;
      const b = best.get(sha);
      if (b === undefined || index < b.index) best.set(sha, { ref, index });
    });
  }
  return new Map([...best].map(([sha, b]) => [sha, b.ref]));
}

/** Row ranks: the plan's order (B1-M2-T5). `pushRank` places a branch row among the branch rows (0
 *  pushed, 1 partly pushed, 2 never pushed; remote-only rows are 0); without it every branch row is 0. */
const KIND_RANK: Record<Row["kind"], number> = { pr: 0, branch: 1, remoteBranch: 1, default: 2, tag: 3, detached: 4, orphan: 5 };
export function orderRows(rows: readonly Row[], pushRank: (r: Row) => number = () => 0): Row[] {
  const key = (r: Row): string => ("name" in r ? r.name : "");
  return [...rows].sort((a, b) => {
    const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (k !== 0) return k;
    if (a.kind === "pr" && b.kind === "pr") return a.number - b.number;
    if (KIND_RANK[a.kind] === 1) {
      const p = (a.kind === "remoteBranch" ? 0 : pushRank(a)) - (b.kind === "remoteBranch" ? 0 : pushRank(b));
      if (p !== 0) return p;
      return byteCmp(key(a), key(b)) || byteCmp((a as { ref: string }).ref, (b as { ref: string }).ref);
    }
    return byteCmp(key(a), key(b));
  });
}

/** The groups for one label in one repo, in the plan's row order (branch rows all ranked as pushed: the
 *  command re-orders them with `orderRows` once push state is known). Within a row, commits newest first
 *  by committer date. Throws `RepoUnknown` when a call fails (the repo then answers `unknown`). */
export async function groupLabel(scan: RepoScan, commits: readonly LabelCommit[], squashed: ReadonlyMap<string, SquashMatch> = new Map()): Promise<Row[]> {
  const rg = scan.rg;
  const given = commits.filter((c) => SHA40.test(c.sha));
  const left = new Map(given.map((c) => [c.sha, c] as const));
  const rows: Row[] = [];
  const prRows = new Map<number, Extract<Row, { kind: "pr" }>>();
  const toPr = (sha: string, number: number, title: () => Promise<string>) => async () => {
    const c = left.get(sha);
    if (!c) return;
    left.delete(sha);
    let row = prRows.get(number);
    if (!row) { row = { kind: "pr", number, title: prTitle(await title()), commits: [] }; prRows.set(number, row); rows.push(row); }
    row.commits.push(c);
  };

  // 1. Merged PRs: merge members (the nearest merge: the oldest, then the latest in log order), "(#N)"
  //    commits, then commits on a squash-matched kept branch.
  const merges = await scan.prMerges();
  for (const sha of [...left.keys()]) {
    const holding = merges.filter((m) => m.members.has(sha));
    if (holding.length === 0) continue;
    const m = holding.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.order > a.order) ? b : a));
    await toPr(sha, m.number, () => scan.mergeBody(m.sha))();
  }
  const squashes = await scan.squashes();
  for (const s of squashes) await toPr(s.sha, s.number, async () => s.title)();
  for (const [ref, match] of [...squashed].sort(([a], [b]) => byteCmp(a, b))) {
    if (left.size === 0) break;
    await toPr(match.sha, match.number, async () => match.title)();
    for (const sha of await scan.own(ref)) await toPr(sha, match.number, async () => match.title)();
  }

  // 2. On main.
  const { refs: defaults, name: defaultName } = await scan.defaults();
  if (left.size > 0) {
    const on = await scan.onDefault();
    const held: LabelCommit[] = [];
    for (const c of left.values()) {
      let onMain = on.has(c.sha);
      if (!onMain) {
        for (const ref of defaults) {
          if (await isAncestor(rg, c.sha, ref)) { onMain = true; break; }
        }
      }
      if (onMain) held.push(c);
    }
    if (held.length > 0) {
      for (const c of held) left.delete(c.sha);
      rows.push({ kind: "default", name: shownBranch(defaultName ?? "HEAD"), commits: held });
    }
  }

  // 3. Branches in progress: local first, then remote-tracking; only refs that hold a leftover commit.
  if (left.size > 0) {
    const holders = (await refsContaining(rg, [...left.keys()], ["refs/heads/", "refs/remotes/"])).filter((r) => !defaults.includes(r) && !(r.startsWith("refs/remotes/") && r.endsWith("/HEAD")));
    for (const [prefix, kind] of [["refs/heads/", "branch"], ["refs/remotes/", "remoteBranch"]] as const) {
      if (left.size === 0) break;
      const refs = holders.filter((r) => r.startsWith(prefix));
      const at = await nearest(scan, refs, new Set(left.keys()));
      const byRef = new Map<string, LabelCommit[]>();
      for (const [sha, ref] of at) {
        byRef.set(ref, [...(byRef.get(ref) ?? []), left.get(sha)!]);
        left.delete(sha);
      }
      for (const [ref, cs] of byRef) rows.push({ kind, ref, name: shownBranch(ref.slice(prefix.length)), commits: cs });
    }
  }

  // 4. Tags (the first by name in byte order), then a detached HEAD.
  const tagRows = new Map<string, Extract<Row, { kind: "tag" }>>();
  const tags = (await refsContaining(rg, [...left.keys()], ["refs/tags/"])).filter((r) => r.startsWith("refs/tags/"));
  for (const ref of tags) {
    const name = shownBranch(ref.slice("refs/tags/".length));
    for (const c of [...left.values()]) {
      if (!await isAncestor(rg, c.sha, ref)) continue;
      let row = tagRows.get(name);
      if (!row) { row = { kind: "tag", name, commits: [] }; tagRows.set(name, row); rows.push(row); }
      row.commits.push(c);
      left.delete(c.sha);
    }
  }
  if (left.size > 0) {
    const sym = await gitIn(rg, ["symbolic-ref", "-q", "HEAD"]);
    if (sym.code !== 0 && sym.code !== 1) throw new RepoUnknown("error", `symbolic-ref: exit ${sym.code}`);
    const head = sym.code === 1 ? await resolveIn(rg, "HEAD^{commit}") : null;
    if (head !== null) {
      const held: LabelCommit[] = [];
      for (const c of [...left.values()]) {
        if (await isAncestor(rg, c.sha, head)) { held.push(c); left.delete(c.sha); }
      }
      if (held.length > 0) rows.push({ kind: "detached", commits: held });
    }
  }

  // 5. No longer on a branch.
  if (left.size > 0) rows.push({ kind: "orphan", commits: [...left.values()] });

  // Within a row: newest first by committer date (input order on a tie, or for a date not found).
  const dates = await commitDates(rg, given.map((c) => c.sha));
  for (const r of rows) r.commits.sort((a, b) => (dates.get(b.sha) ?? 0) - (dates.get(a.sha) ?? 0));
  return orderRows(rows);
}
