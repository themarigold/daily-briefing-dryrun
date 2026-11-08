// src/repos/resolve.ts — the live git check's repos, tokens and "not matched" (B1-M2-T4, wave-2 plan; B1
// spec "What B1 is given", "Which repos").
//
// The webview sends, per card, its key (`norm(label)`; the Other card's key is "") and the SHA tokens of
// its page lines. Only 7- to 40-character hex tokens are resolved; shorter ones are dropped and counted
// nowhere. A token resolves to a commit only when git's answer STARTS WITH the token (a ref named like a
// token wins in `rev-parse`, measured: the guard rejects it). With the run record, a label's tokens are
// resolved in its repo alone, first among the record's own commits for that repo (no spawn); without the
// record, for a label the record lacks, and for the Other card, in every repo, where a token held by two
// repos is "not matched". Unknown and ambiguous tokens count in `notMatched` and never fail the repo.
//
// The work is split so the command (B1-M3) can run each repo in its own budget slice: `planTokens` says
// which tokens each repo is asked (pure), `resolveInRepo` asks one repo, and `settleTokens` turns the
// answers into each card's result (pure). `resolveLabels` runs the three in order.
import { isExcludedRepo } from "../config";
import { NO_SHOW_SIGNATURE, LISTING_MAX_BYTES } from "../git";
import { norm } from "../subprojects";
import type { RunRecord } from "../runRecord";
import { gitOut, resolveIn, RepoUnknown, type RepoGit } from "./hgit";

/** The tokens B1 resolves: 7 to 40 hex characters (the page's SHAs are 7). */
export const TOKEN_RE = /^[0-9a-f]{7,40}$/;
const SHA40 = /^[0-9a-f]{40}$/;

/** A card's resolvable tokens: lowercased, kept only when `TOKEN_RE` holds, deduplicated in order. Pure. */
export function keptTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const l = t.toLowerCase();
    if (TOKEN_RE.test(l) && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Which repos: the accepted record's `repos`; else the explicitly configured `repos` after
 *  `excludeRepos`; never discovery. With neither, "none" (the webview keeps A's disclosure). Pure. */
export function reposFor(record: RunRecord | null, cfg: { repos?: string[]; excludeRepos?: string[] }): string[] | "none" {
  if (record !== null) return record.repos.length > 0 ? [...record.repos] : "none";
  const configured = (cfg.repos ?? []).filter((p) => !isExcludedRepo(p, cfg.excludeRepos));
  return configured.length > 0 ? configured : "none";
}

export type LabelTokens = { key: string; tokens: readonly string[] };
/** One token asked of one repo. `fromRecord`: look among the record's commits for this repo first. */
export type TokenAsk = { token: string; fromRecord: boolean };
export type TokenPlan = {
  /** Every repo asked, in order; a label with no record repo is settled across all of them. */
  repos: string[];
  /** Per card: its kept tokens and the record's repo for its label (null: every repo). */
  labels: { key: string; tokens: string[]; repo: string | null }[];
  /** Per repo: what it is asked, each (token, fromRecord) once. */
  asks: Map<string, TokenAsk[]>;
};

/** The record's labels by `norm` key. Two record labels with one key give no repo (the card is then
 *  resolved across the repos, as for a label the record lacks). */
function recordRepoByKey(record: RunRecord | null): Map<string, string | null> {
  const m = new Map<string, string | null>();
  if (record === null) return m;
  for (const [label, l] of Object.entries(record.labels)) {
    const k = norm(label);
    m.set(k, m.has(k) ? null : l.repo);
  }
  return m;
}

/** Which tokens each repo is asked. Pure. */
export function planTokens(labels: readonly LabelTokens[], record: RunRecord | null, repoPaths: readonly string[]): TokenPlan {
  const byKey = recordRepoByKey(record);
  const asks = new Map<string, TokenAsk[]>(repoPaths.map((p) => [p, []]));
  const ask = (repo: string, a: TokenAsk) => {
    const list = asks.get(repo);
    if (list && !list.some((x) => x.token === a.token && x.fromRecord === a.fromRecord)) list.push(a);
  };
  const planned = labels.map((l) => {
    const tokens = keptTokens(l.tokens);
    const r = l.key === "" ? null : byKey.get(l.key) ?? null;
    const repo = r !== null && asks.has(r) ? r : null;
    for (const token of tokens) {
      if (repo !== null) ask(repo, { token, fromRecord: true });
      else for (const p of repoPaths) ask(p, { token, fromRecord: false });
    }
    return { key: l.key, tokens, repo };
  });
  return { repos: [...repoPaths], labels: planned, asks };
}

/** Ask one repo: per ask, the full SHA it resolves to, or null. A `fromRecord` ask is settled with no
 *  spawn when exactly one of `recordShas` (the record's commits in this repo) starts with the token; none
 *  or several fall through to `rev-parse --verify --quiet --end-of-options <t>^{commit}` (the one
 *  resolution form, B1-M1-T2). A resolved SHA that does not start with the token is null. Throws
 *  `RepoUnknown` when a resolution fails (any output but one 40-hex line, any exit but 0 or 1). */
export async function resolveInRepo(rg: RepoGit, asks: readonly TokenAsk[], recordShas: readonly string[]): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const a of asks) {
    if (a.fromRecord) {
      const hits = recordShas.filter((s) => s.startsWith(a.token));
      if (hits.length === 1) { out.push(hits[0]!); continue; }
    }
    const sha = await resolveIn(rg, `${a.token}^{commit}`);
    out.push(sha !== null && sha.startsWith(a.token) ? sha : null);
  }
  return out;
}

export type ResolvedToken = { token: string; sha: string; repo: string };
export type LabelResolution = {
  key: string;
  /** The record's repo for this card's label, or null. */
  recordRepo: string | null;
  /** The card's repo: the record's, else the one repo its tokens resolved in, else null. */
  repo: string | null;
  resolved: ResolvedToken[];
  /** Tokens that resolved to no commit, or were ambiguous (in one repo, or across repos). */
  notMatched: number;
  /** Tokens that could not be settled because a repo they needed could not be read (it answers `unknown`). */
  unsettled: number;
};

/** Each card's result from the repos' answers (aligned with `plan.asks`; "unknown" for a repo that could
 *  not be read). `mains`: the checkouts of their store's MAIN worktree (git dir = common dir; a configured
 *  subdirectory of it too). Pure. */
export function settleTokens(
  plan: TokenPlan, answers: ReadonlyMap<string, readonly (string | null)[] | "unknown">,
  commonDirs: ReadonlyMap<string, string> = new Map(), mains: ReadonlySet<string> = new Set(),
): LabelResolution[] {
  // Linked checkouts and configured subdirectories share one object store. A readable checkout
  // settles its store, even when another checkout of that store could not answer. The checkout a token
  // resolves in becomes the card's repo, whose per-checkout words (HEAD, "not committed") the card shows:
  // the store's main worktree first, then the configured order.
  const stores = new Map<string, string[]>();
  for (const repo of [...plan.repos.filter((r) => mains.has(r)), ...plan.repos.filter((r) => !mains.has(r))]) {
    const key = commonDirs.get(repo) ?? repo;
    stores.set(key, [...(stores.get(key) ?? []), repo]);
  }
  const answer = (repo: string, token: string, fromRecord: boolean): string | null | "unknown" => {
    const a = answers.get(repo);
    if (a === undefined || a === "unknown") return "unknown";
    const i = (plan.asks.get(repo) ?? []).findIndex((x) => x.token === token && x.fromRecord === fromRecord);
    return i === -1 ? "unknown" : (a[i] ?? null);
  };
  return plan.labels.map((l) => {
    const resolved: ResolvedToken[] = [];
    let notMatched = 0, unsettled = 0;
    for (const token of l.tokens) {
      if (l.repo !== null) {
        const s = answer(l.repo, token, true);
        if (s === "unknown") unsettled++;
        else if (s === null) notMatched++;
        else resolved.push({ token, sha: s, repo: l.repo });
        continue;
      }
      const hits: ResolvedToken[] = [];
      let anyUnknown = false;
      for (const checkouts of stores.values()) {
        let known = false;
        for (const repo of checkouts) {
          const s = answer(repo, token, false);
          if (s === "unknown") continue;
          known = true;
          if (s !== null) { hits.push({ token, sha: s, repo }); break; }
        }
        if (!known) anyUnknown = true;
      }
      if (hits.length >= 2) notMatched++;
      else if (anyUnknown) unsettled++;
      else if (hits.length === 1) resolved.push(hits[0]!);
      else notMatched++;
    }
    const repos = [...new Set(resolved.map((r) => r.repo))];
    return { key: l.key, recordRepo: l.repo, repo: l.repo ?? (repos.length === 1 ? repos[0]! : null), resolved, notMatched, unsettled };
  });
}

/** A repo for `resolveLabels`: readable (`rg`), or one whose hardening answered `unknown`. */
export type RepoHandle = { rg: RepoGit } | { unknown: string };

/** `planTokens`, `resolveInRepo` per repo (serially), then `settleTokens`. A repo whose resolution
 *  throws `RepoUnknown` is answered "unknown". */
export async function resolveLabels(labels: readonly LabelTokens[], record: RunRecord | null, repos: ReadonlyMap<string, RepoHandle>): Promise<LabelResolution[]> {
  const plan = planTokens(labels, record, [...repos.keys()]);
  const answers = new Map<string, (string | null)[] | "unknown">();
  for (const [path, h] of repos) {
    if (!("rg" in h)) { answers.set(path, "unknown"); continue; }
    const shas = record === null ? [] : record.commits.filter((c) => c.repo === path).map((c) => c.sha);
    try { answers.set(path, await resolveInRepo(h.rg, plan.asks.get(path) ?? [], shas)); } catch (e) {
      if (e instanceof RepoUnknown) answers.set(path, "unknown"); else throw e;
    }
  }
  return settleTokens(plan, answers);
}

/** At most this many SHAs per listing call (the hidden-subjects listing's figure, B1-M3-T8). */
export const SHAS_PER_CALL = 2000;

/** Committer dates (epoch ms) of `shas` in one repo: `log --no-walk=unsorted --ignore-missing
 *  --no-show-signature --format=%H%x1f%cI --end-of-options <sha…>`, at most `SHAS_PER_CALL` per call, each a
 *  validated 40-hex SHA (others are not asked). An absent SHA is skipped (`--ignore-missing`); any exit
 *  but 0 throws `RepoUnknown`. */
export async function commitDates(rg: RepoGit, shas: readonly string[]): Promise<Map<string, number>> {
  const asked = [...new Set(shas.filter((s) => SHA40.test(s)))];
  const out = new Map<string, number>();
  for (let i = 0; i < asked.length; i += SHAS_PER_CALL) {
    const chunk = asked.slice(i, i + SHAS_PER_CALL);
    const text = await gitOut(rg, ["log", "--no-walk=unsorted", "--ignore-missing", NO_SHOW_SIGNATURE, "--format=%H%x1f%cI", "--end-of-options", ...chunk],
      { maxBytes: LISTING_MAX_BYTES });
    for (const line of text.split("\n")) {
      const [sha, iso] = line.split("\x1f");
      if (!sha || !iso || !chunk.includes(sha)) continue;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) out.set(sha, ms);
    }
  }
  return out;
}

/** The window start: the record's `windowStartUtc`; without a record, the local midnight of the oldest of
 *  `pageCommitDates` (the resolved page commits' committer dates, epoch ms); null when there is neither.
 *  That one start serves the merge scan, the "(#N)" listing and the push counts alike. Pure. */
export function windowStartFor(record: RunRecord | null, pageCommitDates: readonly number[]): Date | null {
  if (record !== null) {
    const d = new Date(record.windowStartUtc);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (pageCommitDates.length === 0) return null;
  const d = new Date(pageCommitDates.reduce((m, x) => (x < m ? x : m)));
  d.setHours(0, 0, 0, 0);
  return d;
}
