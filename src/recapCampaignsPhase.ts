// src/recapCampaignsPhase.ts — Tier B (Stage-2 recap campaigns): the EFFECTFUL half. The pure core is
// `src/recapCampaigns.ts`; this module does the I/O around it. Spec: `2026-09-24-stage2-recap-grouping-B-
// design-v3.md` §4.1–§4.4, §4.10, Appendix D (D1 + addendum, D2, D6, D8, D9 and its `reposUnread`
// addendum, D14, D17).
//
// T3.2: `readPrFacts` — the PR facts of one morning, read from git under ONE budget.
// T4.4: `runRecapCampaignsPhase` — §4.2 steps 1–11. `core.ts` owns step 1's `off` branch (it never calls
// the phase in `off`) and step 12 (the one struct write). Every runtime value — the grouper, the record
// writer, the provider's runtime-warnings accessor, `clockNow` — comes in as a PARAMETER from `core.ts`.
//
// ⚠ IMPORT RULE (D17; plan §2, pinned transitively by test/recap-campaigns.imports.test.ts): following
// VALUE imports from this module must never reach `src/core`, `src/runlock` or `src/main` — nor `src/json`,
// which reaches `runlock` in one hop. `core.ts` imports THIS module, so any such route closes an import
// cycle, and a cycle here crashes EVERY run at load, mode `off` included: under `bun` as a TDZ
// `ReferenceError` ("Cannot access … before initialization"), in the compiled binary as a `TypeError`.
// The load guard therefore judges exit code and output, never the error class (plan K5). `readPrFacts`
// still takes its budget as a PARAMETER; the phase reads `src/recapBudget.ts`, the leaf that exists so
// both the lock and this phase can share `D_call` without that cycle.
import { ProviderError, type Activity, type BriefingStruct } from "./types";
import { listDefaultRefMerges, mergeMembers, startGitBudget, type DefaultRefMerge } from "./git";
import {
  attachPrFacts, isMarkedItem, buildCampaignItems, buildCampaignPrompt, busyByLoad, topLevelRecapCount,
  labelUniverse, recordLabels, recordCampaigns, scoreReply, formatRecapRecordLine, formatRecapStderrLine,
  type CampaignItem, type PrMembership, type PrRef, type RecapImpl, type RecapRecordV2, type ScoreResult,
} from "./recapCampaigns";
import { RECAP_GIT_BUDGET_MS, recapCallDeadlineMs } from "./recapBudget";
import { diagError } from "./diag";

/** D9 + addendum: the record's `prFacts`. `merges` = in-window merges listed across the repos READ (PR and
 *  non-PR alike — §4.3 item 2's window rule is what keeps a merge); `read` = merges whose `rev-list`
 *  completed; `timedOut` = merges whose `rev-list` the budget never reached or whose kill was a timeout
 *  (D2) — a count of MERGES only; `marked` = offered items whose fact is the `merged across PRs` form;
 *  `reposUnread` = repos whose LISTING was not read (refused by the budget, or killed by its timeout),
 *  which add 0 to every merge counter. */
export type PrFactsCounts = { merges: number; read: number; timedOut: number; marked: number; reposUnread: number };

export type PrFactsResult = {
  /** Full commit id → the INNERMOST PR merge containing it, over the commits of the offered items only —
   *  the input `attachPrFacts` takes. A commit absent from it is in no PR (K). */
  membership: PrMembership;
  prFacts: PrFactsCounts;
  /** Wall time of the git reads, from the first git call to the last; 0 when no repo owns an item. */
  gitMs: number;
};

/** A PR merge's claim on a commit: the smaller member set wins (innermost); ties go to the lower PR
 *  number, then the lower merge SHA, so the result never depends on listing order. */
type Claim = { size: number; pr: PrRef; sha: string };
const beats = (a: Claim, b: Claim): boolean =>
  a.size !== b.size ? a.size < b.size : a.pr.number !== b.pr.number ? a.pr.number < b.pr.number : a.sha < b.sha;

/** §4.3 "How PR facts are derived", item 4's order and budget, D6 and D9:
 *   1. the repos that OWN an offered item — the `repo` of every offered commit in `commitsById` — and only
 *      those, in sorted repo-path order;
 *   2. the LISTING (`listDefaultRefMerges`) of EVERY such repo first;
 *   3. only then the `rev-list`s (`mergeMembers`) across the repos whose listing was read.
 *  ONE budget of `budgetMs` for all of it, running from the first git call (`startGitBudget`'s clock
 *  starts at its first read). The order guarantees only that every listing precedes every `rev-list`; a
 *  listing that hangs still takes the remaining budget before its kill, starving the listings after it
 *  (K33 — accepted: those repos count in `reposUnread` and the morning continues).
 *  D6: non-PR merges are dropped BEFORE the innermost rule — among the merges whose members were read,
 *  only PR merges claim commits, and a commit inside two PR merges' member sets belongs to the one with
 *  the smallest set. Commits of a non-PR merge, of a merge not read in time, and of an unread repo are in
 *  no PR.
 *  A git failure other than a timeout kill or a budget refusal (a real non-zero exit, an
 *  `IncompleteReadError`) propagates from T3.1's reads; §4.2's try/catch makes it `rejected: exception`. */
export async function readPrFacts(
  items: readonly CampaignItem[],
  commitsById: ReadonlyMap<string, Activity>,
  windowStart: Date,
  now: Date,
  budgetMs: number,
): Promise<PrFactsResult> {
  const offered = new Set<string>();
  const owners = new Set<string>();
  for (const item of items) {
    for (const sha of item.commits) {
      offered.add(sha);
      const repo = commitsById.get(sha)?.repo;
      if (repo !== undefined) owners.add(repo);
    }
  }
  const repos = [...owners].sort();
  const counts: PrFactsCounts = { merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 0 };
  if (repos.length === 0) return { membership: new Map(), prFacts: counts, gitMs: 0 };

  const budget = startGitBudget(budgetMs);
  const started = performance.now();
  // 2. every listing, before any rev-list
  const listed: { repo: string; merges: DefaultRefMerge[] }[] = [];
  for (const repo of repos) {
    const r = await listDefaultRefMerges(repo, windowStart, now, budget);
    if (r.unread) { counts.reposUnread++; continue; }
    counts.merges += r.merges.length;
    listed.push({ repo, merges: r.merges });
  }
  // 3. the rev-lists, then D6 and the innermost rule
  const claims = new Map<string, Claim>();
  for (const { repo, merges } of listed) {
    const m = await mergeMembers(repo, merges, budget);
    counts.read += m.read;
    counts.timedOut += m.timedOut;
    for (const merge of merges) {
      if (merge.pr === undefined) continue;          // D6: a non-PR merge claims nothing
      const members = m.members.get(merge.sha);
      if (members === undefined) continue;           // not read in time: no facts
      const claim: Claim = { size: members.length, pr: merge.pr, sha: merge.sha };
      for (const sha of members) {
        if (!offered.has(sha)) continue;
        const held = claims.get(sha);
        if (held === undefined || beats(claim, held)) claims.set(sha, claim);
      }
    }
  }
  const gitMs = Math.round(performance.now() - started);
  const membership: PrMembership = new Map([...claims].map(([sha, c]) => [sha, c.pr]));
  counts.marked = attachPrFacts(items, membership).filter(isMarkedItem).length;
  return { membership, prFacts: counts, gitMs };
}

// ── T4.4: the phase, spec §4.2 steps 1–11 ───────────────────────────────────────────────────────────

/** Everything the phase needs, as parameters (plan §4 T4.4, "the full signature"). The phase never imports
 *  `./core`: `runtimeWarningsOf` is private there, and the import would be the cycle the header forbids. */
export type RecapPhaseParams = {
  /** `resolveRecapCampaigns(cfg.recapCampaigns).mode` — never `off` here: `core.ts` owns step 1's `off`
   *  branch and does not call the phase at all (§4.1 step 1: "`off` → B does nothing at all"). */
  mode: "trial" | "on";
  /** Read only. The phase never writes it; `core.ts` makes the one step-12 assignment from the result. */
  struct: BriefingStruct;
  /** §4.1 step 3's "commits": `ctx.repos.flatMap((r) => r.activities).filter((a) => a.kind === "commit").length`. */
  gateCommits: number;
  /** `clusterRecap`'s population (`generator.ts:929`): `kind === "commit"` and a string `event_id`. */
  ctxCommits: Activity[];
  /** Every resolved unit label and every repo label → `labelUniverse` → check (c)'s rows and rule 5. */
  unitLabels: string[];
  repoLabels: string[];
  /** `new Date(windowStartUtc)`, from `gitActivity`. */
  windowStart: Date;
  /** `core.ts`'s `clockNow` (`deps.now ?? new Date`), the `now` of `[windowStart, now)` (D14). */
  clockNow: () => Date;
  /** `core.ts`'s `runDate` — the record's `date` (D1 addendum), never `clockNow()`. */
  runDate: string;
  force: boolean;
  /** `deps.recapInvocation` (D8): absent ⇒ `"invoker":"unknown"`; `json` defaults to `false`. */
  invocation?: { invoker: string; json: boolean };
  /** The RESOLVED grouper (§4.2): `deps.grouper ?? (owned ? (p) => built!.provider.generate(p) : undefined)`. */
  grouper: ((prompt: string) => Promise<string>) | undefined;
  /** `() => runtimeWarningsOf(provider)` — the run's own provider instance's shared warnings array. */
  warningsOf: () => readonly string[];
  /** `laddered ? (laddered.hardeningActive() ? "on" : "off") : "n/a"`, evaluated at step 4. */
  hardeningOf: () => "on" | "off" | "n/a";
  /** `cfg.provider.timeoutMs ?? TIMEOUT_MS`; `recapCallDeadlineMs` sanitises it. */
  timeoutMs: number;
  /** The record writer: `deps.persistRecapRecord`, or `core.ts`'s append to `recapCampaignsPath()`. */
  persist: (line: string) => Promise<void>;
  /** Tests only: a short `D_call` (F17/P9), a git budget (P10's 0), and the implementation seam (F20–F22). */
  seams?: { callDeadlineMs?: number; gitBudgetMs?: number; impl?: Partial<RecapImpl> };
};

/** A deadline settlement, distinguishable from any reply text. */
const DEADLINE: unique symbol = Symbol("recap-call-deadline");

/** Spec §4.2 steps 1–11, and NEVER throws. ONE main try/catch spans steps 1–9; any throw there is
 *  `rejected`/`exception` with the struct untouched (the phase never writes it). Step 10 (the record
 *  append) and step 11 (the stderr line) each run in their OWN try/catch, once, whatever happened above —
 *  so a run that reaches the phase writes exactly ONE record line. Returns the candidate `recap` ONLY for
 *  `applied` (mode `on`, every check passed); `core.ts` assigns it as step 12, after this returns.
 *
 *  Bounded (plan K30): every loop here and in what it calls walks a finite array — items, campaigns,
 *  repos, merges, reply lines. No retry, no polling, no `while (true)`. The call is ONE attempt raced
 *  against `D_call` (`recapCallDeadlineMs`, or the test seam), whose timer is cleared on settlement. */
export async function runRecapCampaignsPhase(p: RecapPhaseParams): Promise<{ recap?: BriefingStruct["recap"] }> {
  const started = performance.now();
  let before = 0;
  let gate: RecapRecordV2["gate"] = null;
  let outcome: RecapRecordV2["outcome"] = "rejected";
  let reason: string | null = "exception";
  let labels: RecapRecordV2["labels"];
  let prFacts: RecapRecordV2["prFacts"] | undefined;
  let gitMs = 0;
  let hardening: RecapRecordV2["hardening"] | undefined;
  let snapshot: number | undefined;          // set at step 3; its presence means step 9 has warnings to copy
  let score: ScoreResult | undefined;
  let providerWarnings: string[] = [];
  const copyWarnings = (): string[] => (snapshot === undefined ? [] : [...p.warningsOf().slice(snapshot)]);

  // ── the main try/catch: steps 1–9 ──
  try {
    before = topLevelRecapCount(p.struct.recap);
    // 1. the gate (§4.1 steps 2–3; step 1's `off` is the caller's)
    if (p.grouper === undefined) {
      outcome = "skipped"; reason = "no-grouper";
    } else if (!busyByLoad(p.gateCommits, before)) {
      gate = { fired: false, commits: p.gateCommits, top: before };
      outcome = "skipped"; reason = "gate";
    } else {
      gate = { fired: true, commits: p.gateCommits, top: before };
      // 2. the offered items, then the PR facts under the git budget (§4.3)
      const commitsById = new Map(p.ctxCommits.map((a) => [a.event_id, a] as const));
      let items = (p.seams?.impl?.buildCampaignItems ?? buildCampaignItems)(p.struct.recap, p.ctxCommits);
      labels = recordLabels(items);
      const facts = await readPrFacts(items, commitsById, p.windowStart, p.clockNow(), p.seams?.gitBudgetMs ?? RECAP_GIT_BUDGET_MS);
      prFacts = facts.prFacts;
      gitMs = facts.gitMs;
      items = attachPrFacts(items, facts.membership);
      // 3. the prompt; the warnings snapshot
      const prompt = buildCampaignPrompt(items, commitsById);
      snapshot = p.warningsOf().length;
      // 4. the call, raced against its deadline
      hardening = p.hardeningOf();
      const reply = await raceDeadline(p.grouper, prompt, p.seams?.callDeadlineMs ?? recapCallDeadlineMs(p.timeoutMs));
      if (!reply.ok) {
        outcome = "rejected"; reason = reply.reason;
      } else {
        // 5–8. parse, validate, apply, live check, outcome — the ONE composition (`scoreReply`)
        const units = labelUniverse(p.unitLabels, p.repoLabels).map((l) => ({ repo: l, labels: [l] }));
        score = scoreReply(p.struct, items, reply.text, units, p.mode, p.seams?.impl);
        outcome = score.outcome; reason = score.reason;
      }
      // 9. the runtime warnings B's own call appended — every outcome that reached step 4
      providerWarnings = copyWarnings();
    }
  } catch {
    // Any throw in steps 1–9: `exception`, struct untouched. The call's warnings are copied only if the
    // call had started; nothing the run already built is withdrawn from the record (`labels`, `prFacts`).
    outcome = "rejected"; reason = "exception"; score = undefined;
    try { providerWarnings = copyWarnings(); } catch { providerWarnings = []; }
  }

  // The record (§4.10 1), field order = `RecapRecordV2`'s. `labels[]` on every line where items were
  // built; `prFacts` (with `reposUnread`) on every line where `readPrFacts` RETURNED; `campaigns[]` only
  // for `applied`/`trial` — `ScoreResult.keptCampaigns` is also filled on a live-check REJECTION, which
  // must not carry them.
  let hardeningValue: RecapRecordV2["hardening"] = "n/a";
  try { hardeningValue = hardening ?? p.hardeningOf(); } catch { /* the record still goes out */ }
  const record: RecapRecordV2 = {
    v: 2, date: p.runDate, mode: p.mode,
    invoker: p.invocation?.invoker ?? "unknown", json: p.invocation?.json ?? false, forced: p.force,
    gate, outcome, reason,
    before, after: score?.after ?? before,
    proposed: score?.proposed ?? 0, kept: score?.kept ?? 0,
    dropped: score?.dropped ?? [],
    latencyMs: Math.round(performance.now() - started), gitMs,
    ...(prFacts !== undefined ? { prFacts } : {}),
    hardening: hardeningValue, providerWarnings,
    ...(labels !== undefined ? { labels } : {}),
    ...((outcome === "applied" || outcome === "trial") && score ? { campaigns: recordCampaigns(score.keptCampaigns) } : {}),
  };

  // 10. the record line — its OWN try/catch: a rejected write costs only the record (`"record":false`)
  let recordOk = false;
  try {
    await p.persist(formatRecapRecordLine(record));
    recordOk = true;
  } catch { /* the outcome stands */ }

  // 11. the count-only stderr line — its OWN try/catch: a throwing `diagError` changes nothing
  try { diagError(formatRecapStderrLine(record, recordOk)); } catch { /* the outcome stands */ }

  return outcome === "applied" && score?.candidate ? { recap: score.candidate.recap } : {};
}

/** Step 4: ONE call, raced against `deadlineMs` from the call's start; the timer is cleared on
 *  settlement. A `ProviderError` is `provider-error:<code>`, any other throw `grouper-throw`, expiry
 *  `deadline` — each a whole-reply rejection (§4.6).
 *  ⚠ The grouper's promise gets `.catch(() => {})` AT CREATION — the plan's ONE named mutation-exempt
 *  line (§1, K3): an abandoned grouper that rejects after the deadline must never surface as an
 *  unhandled rejection. It is defence in depth that no mutation can turn red (a promise handed to
 *  `Promise.race` in the same tick is already handled); F17 and P9 are its behaviour tests. A grouper
 *  that throws SYNCHRONOUSLY is caught by the async wrapper, so it is a `grouper-throw`, not an
 *  `exception`. */
async function raceDeadline(
  grouper: (prompt: string) => Promise<string>, prompt: string, deadlineMs: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const call = (async () => grouper(prompt))();
  call.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => { timer = setTimeout(() => resolve(DEADLINE), deadlineMs); });
  try {
    const settled = await Promise.race([call, deadline]);
    if (settled === DEADLINE) return { ok: false, reason: "deadline" };
    return { ok: true, text: String(settled) };
  } catch (e) {
    return { ok: false, reason: e instanceof ProviderError ? `provider-error:${e.code}` : "grouper-throw" };
  } finally {
    clearTimeout(timer);
  }
}
