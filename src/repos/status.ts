// src/repos/status.ts — `repos status --json`: the desktop app's live git check (B1-M3-T9, B1-M3-T10, wave-2
// plan; B1 spec "Where it is computed"). Read-only: no repo-supplied code runs, nothing is written to a repo,
// nothing is fetched (the hardening, harden.ts), and the run record is read, never written.
//
// THE BUDGET. One overall budget of `REPOS_STATUS_BUDGET_MS` (25 s), 5 s under Rust's 30 s read bound
// (`ENGINE_READ_TIMEOUT`, gui/src-tauri/src/shell.rs), the margin the spec asks for. THE POOL: repos run in
// `mapLimit(…, REPO_SCAN_CONCURRENCY, …)` (src/extractor.ts), the page-labelled repos first, each with its own
// slice `startGitBudget(min(REPO_SLICE_MS, overall remaining))`; a repo whose slice runs out answers
// `unknown` (`timeout`), and a repo not started before the overall budget ends answers `unknown` (`budget`).
// So one slow repo cannot take the others' answers. The check runs in two passes over the pool, because two
// rules need every repo's tokens first (a token the Other card's or an unrecorded label's tokens resolve in
// two repos is "not matched", and without a record the window start is the oldest resolved page commit's
// day): pass 1 hardens each repo and resolves its tokens; pass 2 (a fresh slice each) reads the groups, the
// squash check, push state, the hidden subjects and the branch lines. Each repo's minute status
// (`status --porcelain --ignore-submodules=all`) has its own bound, `REPO_STATUS_BOUND_MS` (10 s), inside
// the overall budget, and runs beside pass 2's reads, so a slow status costs only its own tile.
//
// THE REPLY carries typed reason codes and shown names only (types.ts says what it never carries). Every git
// call goes through `hgit` or the shared functions' `{ lead }` path, both of which hand git a sanitized
// environment (env.ts `cleanGitEnv`): the engine's own GIT_* variables never reach a live-check git.
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig as loadUserConfig } from "../config";
import { mapLimit, REPO_SCAN_CONCURRENCY } from "../extractor";
import { startGitBudget, type GitBudget } from "../git";
import { readRunRecord, type RunRecord } from "../runRecord";
import { norm as normKey, repoLabelFor } from "../subprojects";
import { shownBranch } from "../recapCampaigns";
import { redactCredentials } from "../transcripts/credentials";
import { hardenArgs, lazyFetchProbe, type GitProbe } from "./harden";
import { gitIn, hgit, RepoUnknown, type RepoGit } from "./hgit";
import {
  planTokens, reposFor, resolveInRepo, settleTokens, commitDates, windowStartFor, type LabelResolution, type TokenPlan,
} from "./resolve";
import { groupLabel, openScan, orderRows, refsContaining, type LabelCommit, type Row, type SquashMatch } from "./groups";
import { squashMatches, sweepStaleSquashDirs, SQUASH_CHECK_CAP } from "./squash";
import {
  branchLine, branchPushes, countPush, pushCards, pushFacts, pushRank, rowPush, type RepoPush,
} from "./push";
import { hiddenSubjects, planHidden } from "./hidden";
import { readActionFacts } from "./facts";
import type {
  BranchLine, LabelView, ReplyRow, RepoStatTarget, RepoUnknownReason, RepoView, ReposEngineReply, ReposRequest,
  ReposUncommittedReply, Uncommitted,
} from "./types";

/** The overall budget, 5 s under Rust's 30 s `ENGINE_READ_TIMEOUT`. */
export const REPOS_STATUS_BUDGET_MS = 25_000;
/** Each repo's slice of it, per pass. */
export const REPO_SLICE_MS = 12_000;
/** Each repo's minute status, inside the overall budget. */
export const REPO_STATUS_BOUND_MS = 10_000;
/** The request on STDIN (`readStdinBounded`, src/providerCli.ts). Rust's maximal request is under it. */
export const REPOS_STDIN_MAX_BYTES = 256 * 1024;
/** The version probes' own bound, inside the overall budget. */
const PROBE_BOUND_MS = 5_000;

// ── the request ───────────────────────────────────────────────────────────────────────────────────────

const HEX_TOKEN = /^[0-9a-fA-F]{1,40}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, want: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === want.length && want.every((w) => k.includes(w));
};
function validDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The request, or null when it is not exactly `{ scope, pageDate, labels: [{ key, tokens }], branches:
 *  [{ key, name }] }` with a closed `scope`, a real `YYYY-MM-DD` date and 1-40-character hex tokens (Rust's
 *  rule, B1-M4-T11; the label and branch bounds are Rust's, and the byte bound is the CLI's). Pure. */
export function parseReposRequest(text: string): ReposRequest | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !onlyKeys(v, ["scope", "pageDate", "labels", "branches"])) return null;
  if (v.scope !== "all" && v.scope !== "uncommitted") return null;
  if (!validDate(v.pageDate)) return null;
  if (!Array.isArray(v.labels) || !Array.isArray(v.branches)) return null;
  for (const l of v.labels) {
    if (!isObj(l) || !onlyKeys(l, ["key", "tokens"]) || typeof l.key !== "string" || !Array.isArray(l.tokens)) return null;
    if (!l.tokens.every((t) => typeof t === "string" && HEX_TOKEN.test(t))) return null;
  }
  for (const b of v.branches) {
    if (!isObj(b) || !onlyKeys(b, ["key", "name"]) || typeof b.key !== "string" || typeof b.name !== "string") return null;
  }
  return v as unknown as ReposRequest;
}

// ── small pieces ──────────────────────────────────────────────────────────────────────────────────────

/** The repo key: `"r"` + the first 12 hex of the SHA-256 of the repo's real path (the path as given when it
 *  cannot be resolved), stable across replies and path-free. */
export function repoKeyFor(path: string): string {
  return pathKey("r", path);
}

/** `prefix` + the first 12 hex of the SHA-256 of `path`'s real path (as given when it cannot be resolved):
 *  the repo key ("r"), the store key ("s", of the git common dir) and the tree key ("t", of the working
 *  tree's top level). Never the path itself. */
function pathKey(prefix: string, path: string): string {
  let real = path;
  try { real = realpathSync(path); } catch { /* a missing repo keeps its given path */ }
  return `${prefix}${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
}

/** "Not committed": the hardened `status --porcelain --ignore-submodules=all`, the count of its non-empty
 *  lines, under its own bound. A timeout, a cut output or any exit but 0 is unknown. */
export async function uncommittedCount(repo: string, lead: readonly string[], timeoutMs: number | undefined): Promise<Uncommitted> {
  if (timeoutMs === undefined) return { unknown: true };
  const r = await hgit(repo, ["status", "--porcelain", "--ignore-submodules=all"], { lead, timeoutMs });
  if (r.timedOut || !r.complete || r.code !== 0) return { unknown: true };
  return { count: r.out.split("\n").filter((l) => l !== "").length };
}

/** A reftable repo: a `reftable/` directory in the common dir, or `extensions.refStorage = reftable`. */
async function isReftable(rg: RepoGit, commonDir: string): Promise<boolean> {
  try { if (statSync(join(commonDir, "reftable")).isDirectory()) return true; } catch { /* absent */ }
  const r = await gitIn(rg, ["config", "--get", "extensions.refStorage"]);
  if (r.code === 1 && r.out.trim() === "") return false;
  if (r.code !== 0) throw new RepoUnknown("error", "config extensions.refStorage");
  return r.out.trim().toLowerCase() === "reftable";
}

const byteCmp = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const reasonOf = (e: RepoUnknown): RepoUnknownReason => e.reason;

export type StatusDeps = {
  now?: () => Date;
  readRecord?: (pageDate: string) => Promise<{ accepted: false } | { accepted: true; record: RunRecord }>;
  loadConfig?: () => Promise<{ repos?: string[]; excludeRepos?: string[] }>;
  budgets?: { overallMs?: number; sliceMs?: number; statusMs?: number };
  concurrency?: number;
  /** Where the squash check's throwaway object dirs and spools go (tests point it at their own tree). */
  tmpRoot?: string;
};

type Repo = { path: string; key: string; name: string; index: number };
type Ready = { rg: RepoGit; gitDir: string; commonDir: string; reftable: boolean };

/** One repo's run in a pass: refused when the overall budget is spent, else given its own slice. */
function sliceFor(overall: GitBudget, ms: number): GitBudget | null {
  if (overall.callTimeoutMs() === undefined) return null;
  return startGitBudget(Math.min(ms, overall.remainingMs()));
}

// ── the command ───────────────────────────────────────────────────────────────────────────────────────

/** The check for `req`. `scope: "uncommitted"` answers each repo's minute status alone. */
export async function reposStatus(req: ReposRequest, deps: StatusDeps = {}): Promise<ReposEngineReply | ReposUncommittedReply> {
  const now = deps.now?.() ?? new Date();
  const overallMs = deps.budgets?.overallMs ?? REPOS_STATUS_BUDGET_MS;
  const sliceMs = deps.budgets?.sliceMs ?? REPO_SLICE_MS;
  const statusMs = deps.budgets?.statusMs ?? REPO_STATUS_BOUND_MS;
  const limit = deps.concurrency ?? REPO_SCAN_CONCURRENCY;
  const overall = startGitBudget(overallMs);
  overall.remainingMs();                                                         // the clock starts now
  const checkedAt = now.toISOString();
  const statusTimeout = (): number | undefined => {
    const t = overall.callTimeoutMs();
    return t === undefined ? undefined : Math.min(statusMs, t);
  };

  const rec = await (deps.readRecord ?? readRunRecord)(req.pageDate);
  const record = rec.accepted ? rec.record : null;
  const cfg = record !== null ? {} : await (deps.loadConfig ?? loadUserConfig)().catch(() => ({}));
  const found = reposFor(record, cfg);
  // One entry per repo: two spellings of one real path (a trailing slash, a symlink) would share a repo key.
  const seenKeys = new Set<string>();
  const paths = (found === "none" ? [] : found).filter((p) => {
    const k = repoKeyFor(p);
    if (seenKeys.has(k)) return false;
    seenKeys.add(k);
    return true;
  });

  // Card order: each repo at the first card that names it (the record's repo for its label); the rest by path.
  // Without a record the token answers decide it, after pass 1 (`order`, below).
  const recordRepoOf = (key: string): string | null => {
    if (record === null || key === "") return null;
    let repo: string | null = null;
    for (const [label, l] of Object.entries(record.labels)) {
      if (normKey(label) !== key) continue;
      if (repo !== null && repo !== l.repo) return null;
      repo = l.repo;
    }
    return repo;
  };
  const allNames = paths;
  const repos: Repo[] = paths.map((path, index) => ({ path, key: repoKeyFor(path), name: redactCredentials(repoLabelFor(path, allNames)), index }));

  if (req.scope === "uncommitted") {
    const answers = paths.length === 0 ? [] : await uncommittedPass(repos, overall, sliceMs, statusTimeout, limit);
    const order = orderRepos(repos, req.labels.map((l) => (recordRepoOf(l.key) === null ? [] : [recordRepoOf(l.key)!])));
    return { schemaVersion: 1, scope: "uncommitted", checkedAt, repoViews: order.map((r) => ({ key: r.key, uncommitted: answers[r.index] ?? { unknown: true } })) };
  }

  // A check Rust killed past its read bound left its squash temp dirs behind (no `finally` ran): remove the
  // stale ones under this check's own tmp root before it makes any.
  await sweepStaleSquashDirs(deps.tmpRoot ?? tmpdir());

  if (paths.length === 0) {
    return {
      schemaVersion: 1, scope: "all", checkedAt,
      record: { accepted: record !== null, windowStartUtc: record?.windowStartUtc ?? null }, windowStartUtc: null,
      repoViews: [{ key: "", name: "", state: "noRepos", noRemote: false, uncommitted: { unknown: true } }],
      labels: [], branchLines: [], pushCards: [], tile: { commits: 0, branches: 0 }, hidden: { complete: false, perLabel: {} }, repos: [],
      actionFacts: [],
    };
  }

  // The call's git: once, before any repo. Below 2.31 (or unreadable), no repo is run.
  const probeT = overall.callTimeoutMs();
  const probe: GitProbe | null = probeT === undefined ? null : await lazyFetchProbe(Math.min(PROBE_BOUND_MS, probeT));
  const callUnknown: RepoUnknownReason | null = probe === null ? "budget" : probe.version === "" ? "error" : probe.tooOld ? "git-too-old" : null;

  // ── pass 1: harden, then resolve the tokens (and, without a record, their committer dates)
  const plan: TokenPlan = planTokens(req.labels, record, paths);
  const labelledFirst = [...repos].sort((a, b) => Number(!isLabelled(a.path)) - Number(!isLabelled(b.path)) || a.index - b.index);
  function isLabelled(path: string): boolean {
    return req.labels.some((l) => recordRepoOf(l.key) === path);
  }
  const unknownBy = new Map<string, RepoUnknownReason>();
  const ready = new Map<string, Ready>();
  const commonDirs = new Map<string, string>();
  const commonOf = (path: string): string => commonDirs.get(path) ?? path;
  const toplevels = new Map<string, string>();
  /** The main worktree's checkouts (git dir = common dir): an unrecorded card's tokens settle there first. */
  const mains = new Set<string>();
  const tokenAnswers = new Map<string, (string | null)[] | "unknown">();
  const datesBy = new Map<string, Map<string, number>>();                       // without a record: per repo, sha → ms
  if (callUnknown !== null) for (const r of repos) unknownBy.set(r.path, callUnknown);
  else {
    await mapLimit(labelledFirst, limit, async (r) => {
      const slice = sliceFor(overall, sliceMs);
      if (slice === null) { unknownBy.set(r.path, "budget"); return; }
      const h = await hardenArgs(r.path, slice, probe!);
      if ("unknown" in h) { unknownBy.set(r.path, h.unknown); return; }
      commonDirs.set(r.path, h.commonDir);
      toplevels.set(r.path, h.toplevel);
      if (h.gitDir === h.commonDir) mains.add(r.path);
      const rg: RepoGit = { repo: r.path, lead: h.lead, budget: slice };
      try {
        const reftable = await isReftable(rg, h.commonDir);
        const shas = record === null ? [] : record.commits.filter((c) => c.repo === r.path).map((c) => c.sha);
        const answers = await resolveInRepo(rg, plan.asks.get(r.path) ?? [], shas);
        if (record === null) datesBy.set(r.path, await commitDates(rg, answers.filter((s): s is string => s !== null)));
        tokenAnswers.set(r.path, answers);
        ready.set(r.path, { rg, gitDir: h.gitDir, commonDir: h.commonDir, reftable });
      } catch (e) {
        if (!(e instanceof RepoUnknown)) throw e;
        unknownBy.set(r.path, reasonOf(e));
      }
    });
  }
  for (const r of repos) if (!tokenAnswers.has(r.path)) tokenAnswers.set(r.path, "unknown");
  const resolutions: LabelResolution[] = settleTokens(plan, tokenAnswers, commonDirs, mains);
  // The fallback window start reads only the commits the cards SETTLED on (a token answered in two repos is
  // not matched, so neither of its commits counts).
  const pageDates = resolutions.flatMap((l) => l.resolved).flatMap((t) => {
    const ms = datesBy.get(t.repo)?.get(t.sha);
    return ms === undefined ? [] : [ms];
  });
  const windowStart = windowStartFor(record, pageDates);

  // The repo each card's commits resolved in, per card, in card order (the order rule's input).
  const cardRepos = resolutions.map((l) => [...new Set([...(l.repo !== null ? [l.repo] : []), ...l.resolved.map((t) => t.repo)])]);
  const order = orderRepos(repos, cardRepos);

  // The hidden commits (with an accepted record only).
  const resolvedAll = resolutions.flatMap((l) => l.resolved);
  const hiddenPlan = record === null ? null : planHidden(record, req.labels.map((l) => l.key), resolvedAll);

  // ── pass 2: per readable repo, in card order, a fresh slice each; its status beside the reads
  type RepoOut = {
    noRemote: boolean;
    rows: Map<number, { rows: Row[]; push: RepoPush }>;
    push: RepoPush | null;
    lines: Map<number, BranchLine>;
    hiddenFound: Map<string, string>;
    squashed: Map<string, SquashMatch>;
  };
  const outs = new Map<string, RepoOut>();
  const uncommittedBy = new Map<string, Uncommitted>();
  const scanStart = windowStart ?? now;                                          // no window: nothing in it
  const branchRepo = (b: { key: string }): string | null => {
    const i = req.labels.findIndex((l) => l.key === b.key);
    if (i !== -1) return resolutions[i]!.repo;
    return recordRepoOf(b.key);
  };
  await mapLimit(order.filter((r) => ready.has(r.path)), limit, async (r) => {
    const slice = sliceFor(overall, sliceMs);
    const base = ready.get(r.path)!;
    const statusP = uncommittedCount(r.path, base.rg.lead, statusTimeout());
    if (slice === null) { unknownBy.set(r.path, "budget"); uncommittedBy.set(r.path, await statusP); return; }
    const rg: RepoGit = { ...base.rg, budget: slice };
    const cap = { left: SQUASH_CHECK_CAP }; // Per repo: concurrent reads cannot spend another repo's checks.
    try {
      const hiddenHere = hiddenPlan?.byRepo.get(r.path) ?? [];
      const hiddenFound = hiddenHere.length > 0 ? await hiddenSubjects(rg, hiddenHere.map((h) => h.sha)) : new Map<string, string>();
      const scan = openScan(rg, scanStart, now);
      const facts = await pushFacts(scan);
      const branches = await branchPushes(scan, facts);
      // each card's commits in this repo: its page commits (with their tokens), then its hidden ones
      const perCard = new Map<number, LabelCommit[]>();
      resolutions.forEach((l, i) => {
        const cs: LabelCommit[] = l.resolved.filter((t) => t.repo === r.path).map((t) => ({ sha: t.sha, token: t.token }));
        const seen = new Set(cs.map((c) => c.sha));
        for (const h of hiddenHere) {
          const subject = hiddenFound.get(h.sha);
          if (h.key === l.key && subject !== undefined && !seen.has(h.sha)) { cs.push({ sha: h.sha, token: null, subject }); seen.add(h.sha); }
        }
        if (cs.length > 0) perCard.set(i, cs);
      });
      const labelShas = [...new Set([...perCard.values()].flat().map((c) => c.sha))];
      const { refs: defaults } = await scan.defaults();
      const holders = labelShas.length === 0 ? [] : await refsContaining(rg, labelShas, ["refs/heads/"]);
      const candidates = [...new Set([...holders, ...branches.filter((b) => b.population.length > 0).map((b) => b.ref)])]
        .filter((ref) => ref.startsWith("refs/heads/") && !defaults.includes(ref)).sort(byteCmp);
      const squashed: Map<string, SquashMatch> = candidates.length === 0 ? new Map()
        : await squashMatches(scan, candidates, base.commonDir, cap, { tmpRoot: deps.tmpRoot ?? tmpdir() });
      const groups = new Map<number, Row[]>();
      for (const [i, cs] of perCard) groups.set(i, await groupLabel(scan, cs, squashed));
      const pageShas = record === null ? new Set(resolvedAll.filter((t) => commonOf(t.repo) === commonOf(r.path)).map((t) => t.sha)) : null;
      const push = facts.noRemote ? { noRemote: true as const } : await countPush(scan, branches, { merged: new Set(squashed.keys()), pageShas, remoteRefs: facts.remoteRefs });
      const rows = new Map<number, { rows: Row[]; push: RepoPush }>();
      for (const [i, rs] of groups) rows.set(i, { rows: rs, push });
      const lines = new Map<number, BranchLine>();
      for (const [i, b] of req.branches.entries()) {
        if (branchRepo(b) !== r.path) continue;
        const entry = await branchLine(scan, facts, push, b);
        lines.set(i, { ...entry, name: shownBranch(entry.name) });
      }
      outs.set(r.path, { noRemote: facts.noRemote, rows, push, lines, hiddenFound, squashed });
    } catch (e) {
      if (!(e instanceof RepoUnknown)) throw e;
      unknownBy.set(r.path, reasonOf(e));
      outs.delete(r.path);
    }
    uncommittedBy.set(r.path, await statusP);
  });

  // ── the reply
  const okRepo = (path: string) => outs.has(path) && !unknownBy.has(path);
  const storeKeyOf = (path: string): string | null => (commonDirs.has(path) ? pathKey("s", commonDirs.get(path)!) : null);
  const treeKeyOf = (path: string): string | null => (toplevels.has(path) ? pathKey("t", toplevels.get(path)!) : null);
  const repoViews: RepoView[] = order.map((r): RepoView => {
    const uncommitted = uncommittedBy.get(r.path) ?? { unknown: true };
    const reason = unknownBy.get(r.path);
    const storeKey = storeKeyOf(r.path), treeKey = treeKeyOf(r.path);
    if (reason !== undefined || !outs.has(r.path) || storeKey === null || treeKey === null) {
      return { key: r.key, name: r.name, state: "unknown", reason: reason ?? "error", noRemote: false, uncommitted, storeKey, treeKey };
    }
    return { key: r.key, name: r.name, state: "ok", noRemote: outs.get(r.path)!.noRemote, uncommitted, storeKey, treeKey };
  });
  const keyOf = new Map(repos.map((r) => [r.path, r.key]));

  const labels: LabelView[] = resolutions.map((l, i): LabelView => {
    const needed = new Set([...(l.repo !== null ? [l.repo] : []), ...l.resolved.map((t) => t.repo),
      ...(hiddenPlan?.byRepo ? [...hiddenPlan.byRepo].filter(([, hs]) => hs.some((h) => h.key === l.key)).map(([p]) => p) : [])]);
    let unknown = l.unsettled > 0;
    const rank = new Map<Row, number>();
    const rows: Row[] = [];
    const pushOf = new Map<Row, RepoPush>();
    const onlyHereShas = new Set<string>();
    for (const path of needed) {
      if (!okRepo(path)) { unknown = true; continue; }
      const got = outs.get(path)!.rows.get(i);
      if (got === undefined) continue;
      const rk = pushRank(got.push);
      for (const row of got.rows) {
        rows.push(row); rank.set(row, rk(row)); pushOf.set(row, got.push);
        if (got.push.noRemote || (row.kind !== "branch" && row.kind !== "default")) continue;
        const b = row.kind === "branch" ? got.push.branches.find((b) => b.ref === row.ref)
          : got.push.branches.find((b) => b.isDefault && b.name === row.name) ?? got.push.branches.find((b) => b.isDefault);
        for (const sha of b?.population ?? []) onlyHereShas.add(sha);
      }
    }
    const ordered = orderRows(rows, (row) => rank.get(row) ?? 0);
    const reply = ordered.map((row) => replyRow(row, pushOf.get(row)!));
    const prNumbers = [...new Set(reply.flatMap((row) => (row.kind === "pr" ? [row.number] : [])))].sort((a, b) => a - b);
    const onlyHere = onlyHereShas.size;
    return { key: l.key, repoKey: l.repo === null ? null : keyOf.get(l.repo) ?? null, state: unknown ? "unknown" : "ok", rows: reply, notMatched: l.notMatched, prNumbers, onlyHere };
  });

  const branchLines: BranchLine[] = [];
  for (const i of req.branches.keys()) {
    for (const out of outs.values()) {
      const line = out.lines.get(i);
      if (line !== undefined) branchLines.push(line);
    }
  }

  const firstCard = (path: string): number | null => {
    const i = cardRepos.findIndex((rs) => rs.includes(path));
    return i === -1 ? null : i;
  };
  // Push work belongs to the common refs, once at the first readable checkout in card order.
  // Checkout-specific status and HEAD/group reads remain separate.
  const pushStores = new Set<string>();
  const pushRepos = order.filter((r) => {
    if (!okRepo(r.path) || outs.get(r.path)!.push === null || pushStores.has(commonOf(r.path))) return false;
    pushStores.add(commonOf(r.path));
    return true;
  });
  const cards = pushCards(pushRepos.map((r) => {
    const fi = firstCard(r.path);
    return { repoKey: r.key, storeKey: storeKeyOf(r.path)!, repoName: r.name, path: r.path, firstLabel: fi === null ? null : req.labels[fi]!.key, firstLabelIndex: fi, push: outs.get(r.path)!.push! };
  }));
  const tile = { commits: 0, branches: 0 };
  for (const r of pushRepos) {
    const p = outs.get(r.path)!.push;
    if (p !== null && !p.noRemote) { tile.commits += p.tile.commits; tile.branches += p.tile.branches; }
  }

  const perLabel: Record<string, number> = Object.create(null);
  let complete = record !== null && hiddenPlan !== null && hiddenPlan.strays === 0 && labels.every((l) => l.state === "ok");
  if (record !== null && hiddenPlan !== null) {
    for (const l of req.labels) perLabel[l.key] = 0;
    for (const [path, hs] of hiddenPlan.byRepo) {
      const out = okRepo(path) ? outs.get(path)! : null;
      if (out === null) { complete = false; continue; }
      for (const h of hs) {
        if (!out.hiddenFound.has(h.sha)) { complete = false; continue; }
        perLabel[h.key] = (perLabel[h.key] ?? 0) + 1;
      }
    }
  }

  const stat: RepoStatTarget[] = order.filter((r) => ready.has(r.path)).map((r) => {
    const x = ready.get(r.path)!;
    return { key: r.key, path: r.path, gitDir: x.gitDir, commonDir: x.commonDir, reftable: x.reftable };
  });

  // B1 has completed, including status and reply assembly. B2 gets only the remaining overall time.
  const actionFacts = await readActionFacts(order.filter((r) => okRepo(r.path)).map((r) => ({
    rg: ready.get(r.path)!.rg, commonDir: ready.get(r.path)!.commonDir, gitDir: ready.get(r.path)!.gitDir,
    commits: [...resolvedAll.filter((c) => c.repo === r.path).map((c) => c.sha), ...outs.get(r.path)!.hiddenFound.keys()],
    squashed: outs.get(r.path)!.squashed,
  })), { branches: req.branches.map((b) => b.name), overall, concurrency: limit, labels: record?.labels ?? null, windowStart: scanStart, now });

  return {
    schemaVersion: 1, scope: "all", checkedAt,
    record: { accepted: record !== null, windowStartUtc: record?.windowStartUtc ?? null },
    windowStartUtc: windowStart === null ? null : windowStart.toISOString(),
    repoViews, labels, branchLines, pushCards: cards, tile, hidden: { complete, perLabel: { ...perLabel } }, repos: stat,
    actionFacts,
  };
}

/** The repo views' order: each repo at the first card (in request order) that names it, then the rest by
 *  path in byte order. Pure. */
function orderRepos(repos: readonly Repo[], cardRepos: readonly (readonly string[])[]): Repo[] {
  const first = new Map<string, number>();
  cardRepos.forEach((rs, i) => { for (const p of rs) if (!first.has(p)) first.set(p, i); });
  return [...repos].sort((a, b) => {
    const fa = first.get(a.path), fb = first.get(b.path);
    if (fa !== undefined && fb !== undefined) return fa - fb || a.index - b.index;
    if (fa !== undefined) return -1;
    if (fb !== undefined) return 1;
    return byteCmp(a.path, b.path);
  });
}

/** An internal row as the reply carries it: no full refname, push words for branch and default rows. */
function replyRow(row: Row, push: RepoPush): ReplyRow {
  const commits = row.commits.map((c) => (c.token === null ? { sha: c.sha, token: null, subject: c.subject } : { sha: c.sha, token: c.token }));
  switch (row.kind) {
    case "pr": return { kind: "pr", number: row.number, title: row.title, commits };
    case "branch": return { kind: "branch", name: row.name, push: rowPush(row, push), commits };
    case "remoteBranch": return { kind: "remoteBranch", name: row.name, commits };
    case "default": return { kind: "default", name: row.name, push: rowPush(row, push), commits };
    case "tag": return { kind: "tag", name: row.name, commits };
    case "detached": return { kind: "detached", commits };
    case "orphan": return { kind: "orphan", commits };
  }
}

/** `scope: "uncommitted"`: per repo, harden (its own slice), then its status (its own bound). */
async function uncommittedPass(repos: readonly Repo[], overall: GitBudget, sliceMs: number, statusTimeout: () => number | undefined, limit: number): Promise<Uncommitted[]> {
  const probeT = overall.callTimeoutMs();
  if (probeT === undefined) return repos.map(() => ({ unknown: true }));
  const probe = await lazyFetchProbe(Math.min(PROBE_BOUND_MS, probeT));
  if (probe.version === "" || probe.tooOld) return repos.map(() => ({ unknown: true }));
  return mapLimit([...repos], limit, async (r) => {
    const slice = sliceFor(overall, sliceMs);
    if (slice === null) return { unknown: true } as const;
    const h = await hardenArgs(r.path, slice, probe);
    if ("unknown" in h) return { unknown: true } as const;
    return uncommittedCount(r.path, h.lead, statusTimeout());
  });
}
