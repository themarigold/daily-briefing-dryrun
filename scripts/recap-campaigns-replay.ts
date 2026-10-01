// scripts/recap-campaigns-replay.ts — tier B (Stage-2 recap campaigns): the OFFLINE REPLAY, the primary
// acceptance evidence (spec §5.3, §6.1; Appendix D1 addendum, D11). Provider-free: it constructs no
// provider and makes no model call — the operator sends the prompts outside it (a `--send` mode is out
// of scope).
//
//   item mode:  bun scripts/recap-campaigns-replay.ts --config <path> --items <archive-dir> --out <dir>
//                 [--dates 2026-09-03,2026-09-04,…] [--record <path>]
//   score mode: bun scripts/recap-campaigns-replay.ts --score <dir>                       (T5.3)
//   self-test:  bun scripts/recap-campaigns-replay.ts --dry-run                           (T5.4)
//
// ITEM MODE, per archived page `<archive-dir>/<date>.md`:
//   • `now` = the page's date at its `state as of HH:MM`, in the machine's local zone; a page without that
//     line is skipped and reported — there is no default time.
//   • B-era pages are skipped and reported, NEVER parsed (§5.3's three rules, against the record file,
//     `--record`, default `statePaths().recapCampaignsPath`; a missing record reads as empty): (1) a line
//     beginning `CAMPAIGN_L3_PREFIX`; (2) a record line for the date with outcome `applied`; (3) no record
//     line at all for the date, and the date inside [first, last] of the record's mode-`on` lines.
//   • The recap section is parsed back into entries by the exact inverse of `render.ts`'s
//     `${text}  (${evidence})` — a balanced-paren scan from the right requiring exactly two spaces before
//     the `(` — a level-1 line followed by a `◦` line is a Stage-1 header, and `🔀` lines are the foot.
//   • The window is rebuilt with the PRODUCTION functions, as `gitActivity` builds it but at the page's
//     `now` (K11: `gitActivity` has no injectable clock): `committerDaysWithCommits` with a look-back
//     extended by the page's age → `windowStart` → `listCommits` over every configured repo under the
//     configured author, split at `localMidnight(now)` → `dedupeTwins(dedupeSharedRefs(…))` on each half →
//     `resolveUnits` → drop `meta.excluded` → `reduce`
//     with `cfg.tokenBudget ?? DEFAULT_BUDGET` → the real `clusterRecap` over the page's bullets (its own
//     Stage-1 stamps are dropped first and re-derived, as the §1.2 baseline was measured). Then the items,
//     `readPrFacts` under `RECAP_GIT_BUDGET_MS`, `attachPrFacts` and `buildCampaignPrompt` — the functions
//     the phase calls — and busy by load. It writes `prompt-<date>.txt` (the exact production prompt,
//     header included) and `items-<date>.json`, and REFUSES to overwrite an existing prompt file: a sent
//     prompt is immutable evidence (nothing is written for that date, and the run exits 1).
//   • The acceptance date set is FIXED (`DEFAULT_DATES`). A date in the set that the busy rule would now
//     exclude, or a busy date outside it, is reported, never silently swapped.
//
// SCORE MODE (`--score <dir>`, two draws per date, `user-directed: 2026-09-24 — run both draws`): for each
// `items-<date>.json` in the directory, draw 1 is `reply-<date>.json` and draw 2 `reply-<date>.d2.json`,
// each the model's raw reply text. Each draw is scored separately by `scoreReply` — the ONE reply→outcome
// composition production runs (parse, validation, apply to a real candidate struct, the live checks
// (a)–(f), `topLevelRecapCount` of both structs) — and the numbers by `summariseRecapOutcomes`, the ONE
// summariser the reader uses. Nothing here recomputes either: in particular `after` is never computed
// arithmetically (the session scorer's `s2r-score.ts:146` formula is why v2's count bug went unseen).
// It prints the per-date report for each draw, then §6.2's numbers under the user's rulings: B and C on
// draw 1 only; m1, m2, max(m1, m2) and whether it is ≤ 13, with d = |m1 − m2| as information only; a draw
// missing any date's reply file is incomplete and not scored for A, and then m (the mean of the draw that
// ran) and whether m ≤ 12.0 are printed; with draw 1 the incomplete one, B and C are printed for draw 2,
// flagged. It prints numbers, never a verdict on B or C, and never finalises a bar — §6.2 does that.
//
// SELF-TEST (`--dry-run`, spec §5.3 cases 1–21; D3): the fixture morning of §5.3 — seven offered items and
// two unresolved bullets, Stage-1 count 9, built ONCE in `test/fixtures/campaign-morning.ts` and shared with
// the prompt, validation and apply tests so they cannot drift apart — scored against each of the 21 case
// replies by the same `scoreReply` production and `--score` call (mode `trial`, as `--score` scores; K24:
// no second composition). Its only seam is a counting wrapper around the REAL `liveCheck`, so "no live check
// runs" is observed, not inferred. One stdout line per case, `ok [TB-S<n>] <title>` or
// `FAIL [TB-S<n>] <title>: <detail>`, and a non-zero exit if any case fails. Cases 14–16 assert the named
// rule is CONTAINED in the drop's `reasons` (D3: every failing rule is recorded); every other case compares
// its drop reasons exactly.
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Activity, BriefingStruct, Config } from "../src/types";
import { validateConfig, discoverRepos, compileExcludePatterns, DEFAULT_EXCLUDE_COMMIT_PATTERNS, DEFAULT_LOOKBACK_CAP_DAYS, DEFAULT_BUDGET } from "../src/config";
import { ancestryRelated, committerDaysWithCommits, listCommits, patchIds, resolveAuthor } from "../src/git";
import { dedupeSharedRefs, dedupeTwins } from "../src/extractor";
import { windowStart, localMidnight } from "../src/time";
import { resolveUnits, repoLabelFor, NOT_SHOWN_PREFIX, type Unit } from "../src/subprojects";
import { reduce } from "../src/reduce";
import { clusterRecap } from "../src/generator";
import { CAMPAIGN_L3_PREFIX } from "../src/render";
import { WHY_PREFIX } from "../src/transcripts/frame";
import {
  buildCampaignItems, attachPrFacts, buildCampaignPrompt, busyByLoad, topLevelRecapCount, labelUniverse,
  scoreReply, summariseRecapOutcomes, recordCampaigns, isMarkedItem, liveCheck,
  type CampaignItem, type RecapRecordV2, type ScoreResult, type ScoreOutcome, type CoverageUnits, type DropReason,
} from "../src/recapCampaigns";
import { readPrFacts, type PrFactsCounts } from "../src/recapCampaignsPhase";
import { RECAP_GIT_BUDGET_MS } from "../src/recapBudget";
import { statePaths } from "../src/json";
import { readRecordFiles } from "./recap-campaigns-report";
import { MORNING_STRUCT, MORNING_RECAP, MORNING_COMMITS, MORNING_LABELS } from "../test/fixtures/campaign-morning";

type Out = (line: string) => void;

/** §5.3: the nine busy mornings of §6.1 (days 49, 50, 51, 52, 55, 62, 63, 64, 69). Fixed. */
export const DEFAULT_DATES = [
  "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-09", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-23",
] as const;

// ── the inverse parse ───────────────────────────────────────────────────────────────────────────────

export type ParsedPage = {
  /** The recap entries in page order, each with the PAGE's Stage-1 stamp (`group`) when it sat under a
   *  Stage-1 header. */
  recap: BriefingStruct["recap"];
  /** The 🔀 foot lines, `{repo: label, text}`, verbatim. */
  foot: { repo: string; text: string }[];
  stateAsOf?: string;
  /** Lines inside the recap section that are none of the shapes above (reported, never guessed at). */
  unparsed: string[];
};

const LEVEL1 = /^   • \[([^\]]*)\] (.*)$/;
const LEVEL2 = /^      ◦ \[([^\]]*)\] (.*)$/;
const STATE_AS_OF = /state as of (\d{2}):(\d{2})/;

/** The exact inverse of `render.ts`'s `${text}${evidence ? `  (${evidence})` : ""}`: a balanced-paren
 *  scan from the right; the group it closes counts as evidence only when EXACTLY two spaces precede its
 *  `(`. Anything else is all text. */
export function splitEvidence(rest: string): { text: string; evidence?: string } {
  if (!rest.endsWith(")")) return { text: rest };
  let depth = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    const c = rest[i];
    if (c === ")") depth++;
    else if (c === "(" && --depth === 0) {
      const twoSpaces = i >= 2 && rest[i - 1] === " " && rest[i - 2] === " " && rest[i - 3] !== " ";
      return twoSpaces ? { text: rest.slice(0, i - 2), evidence: rest.slice(i + 1, -1) } : { text: rest };
    }
  }
  return { text: rest };
}

/** Parse an archived page's `▶ What you did` section (to the first blank line) back into entries. */
export function parseArchivedPage(page: string): ParsedPage {
  const lines = page.split("\n");
  const out: ParsedPage = { recap: [], foot: [], unparsed: [] };
  const stamp = STATE_AS_OF.exec(page);
  if (stamp) out.stateAsOf = `${stamp[1]}:${stamp[2]}`;
  const start = lines.findIndex((l) => l.startsWith("▶ What you did"));
  if (start < 0) return out;
  let header: string | undefined;
  for (let i = start + 1; i < lines.length && lines[i] !== ""; i++) {
    const l = lines[i]!;
    if (l.startsWith(WHY_PREFIX) || l.startsWith(NOT_SHOWN_PREFIX) || l.startsWith("   ⚠ ") || l === "   (no commits in the window)") continue;
    const one = LEVEL1.exec(l);
    if (one) {
      header = undefined;
      const [, repo, rest] = one as unknown as [string, string, string];
      if (rest.startsWith("🔀 ")) { out.foot.push({ repo, text: rest }); continue; }
      if (LEVEL2.test(lines[i + 1] ?? "")) { header = rest; continue; }   // a Stage-1 header
      out.recap.push({ repo, ...splitEvidence(rest) });
      continue;
    }
    const two = LEVEL2.exec(l);
    if (two && header !== undefined) {
      const [, repo, rest] = two as unknown as [string, string, string];
      out.recap.push({ repo, ...splitEvidence(rest), group: header });
      continue;
    }
    out.unparsed.push(l);
  }
  return out;
}

/** `now` = the page's date at its `state as of HH:MM`, local zone; `undefined` without that line. */
export function nowFromPage(date: string, page: string): Date | undefined {
  const m = STATE_AS_OF.exec(page);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !d) return undefined;
  return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(m[1]), Number(m[2]), 0, 0);
}

/** §5.3's B-era rules; the reason a page is B-era, or `undefined`. `records` is the record file's lines;
 *  the record's `date` is the run date (`runDate`, D1 addendum), matched against the page's date. */
export function bEraReason(page: string, date: string, records: readonly RecapRecordV2[]): string | undefined {
  if (page.split("\n").some((l) => l.startsWith(CAMPAIGN_L3_PREFIX))) return "B-era rule 1: a level-3 (▪) line";
  if (records.some((r) => r.date === date && r.outcome === "applied")) return "B-era rule 2: the record has an `applied` line for this date";
  const on = records.filter((r) => r.mode === "on").map((r) => r.date).sort();
  if (on.length && !records.some((r) => r.date === date) && date >= on[0]! && date <= on[on.length - 1]!) {
    return `B-era rule 3: no record line for this date, inside the mode-on span ${on[0]}…${on[on.length - 1]}`;
  }
  return undefined;
}

// ── the window, rebuilt at the page's `now` ─────────────────────────────────────────────────────────

export type ReplayWindow = {
  windowStart: Date;
  end: Date;
  /** The reduced context (`reduce` over the non-excluded window activities). */
  ctx: ReturnType<typeof reduce>;
  units: Unit[];
  rootsByRepo: Map<string, string[]>;
  warnings: string[];
};

/** `gitActivity`'s window (`extractor.ts`) at an arbitrary `now`: the same functions in the same order.
 *  The look-back of `committerDaysWithCommits` counts from the REAL clock, so it is extended by the
 *  page's age; days it adds lie outside `windowStart`'s `capDays` walk and change nothing (K11). */
export async function replayWindow(cfg: Config, repos: readonly string[], now: Date): Promise<ReplayWindow> {
  const cap = cfg.lookbackCapDays ?? DEFAULT_LOOKBACK_CAP_DAYS;
  const { regexes: excludeRe } = compileExcludePatterns(cfg.excludeCommitPatterns ?? DEFAULT_EXCLUDE_COMMIT_PATTERNS);
  const age = Math.max(0, Math.ceil((Date.now() - now.getTime()) / 864e5));
  const end = localMidnight(now);
  const warnings: string[] = [];
  const days = new Set<number>();
  const readable: { repo: string; author: { names?: string[]; emails?: string[] } }[] = [];
  for (const repo of repos) {
    try {
      const author = await resolveAuthor(repo, cfg.author);
      for (const d of await committerDaysWithCommits(repo, author, cap + 1 + age, excludeRe)) days.add(d);
      readable.push({ repo, author });
    } catch (e) {
      warnings.push(`${repo}: not read — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const start = windowStart(now, (d) => days.has(d.getTime()), cap);
  const listed: Activity[] = [];
  const listedToday: Activity[] = [];
  for (const { repo, author } of readable) {
    try {
      for (const c of await listCommits(repo, start, now, author, excludeRe)) {
        (new Date(c.timestamp ?? "").getTime() < end.getTime() ? listed : listedToday).push(c);
      }
    } catch (e) {
      warnings.push(`${repo}: commits not listed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Production's dedupe, at the same point (`gitActivity`'s return, upstream of `resolveUnits` and `reduce`;
  // user ruling 2026-09-28 "match production"): shared refs, then patch-id twins, each list separately.
  // Residual: `resumptionSignals` (uncommitted/branch/stash) are NOT replayed — they read the repo's CURRENT state, not the page's morning; they can change units and labels (the label universe), not the ctx commits, `before` or the offered items unless they tip `reduce`'s budget cut.
  const activities = await dedupeTwins(dedupeSharedRefs(listed), patchIds, ancestryRelated);
  const today = await dedupeTwins(dedupeSharedRefs(listedToday), patchIds, ancestryRelated);
  const { units, warnings: unitWarnings, rootsByRepo } = await resolveUnits(activities, today, [...repos], cfg);
  warnings.push(...unitWarnings);
  const ctx = reduce(activities.filter((a) => !a.meta?.excluded), cfg.tokenBudget ?? DEFAULT_BUDGET);
  return { windowStart: start, end, ctx, units, rootsByRepo, warnings };
}

// ── one date ────────────────────────────────────────────────────────────────────────────────────────

/** Everything `--score` needs to call `scoreReply` without touching git again (plan T5.2). */
export type ItemsFile = {
  v: 1;
  date: string;
  now: string;
  windowStart: string;
  /** The Stage-1 struct: the replayed recap (the real `clusterRecap`'s group stamps) and the foot. */
  struct: BriefingStruct;
  /** The label universe (`labelUniverse`): rule 5's list and check (c)'s rows, one per label. */
  units: string[];
  /** The offered items, PR facts attached. */
  items: CampaignItem[];
  /** `topLevelRecapCount(struct.recap)`. */
  before: number;
  busy: { commits: number; top: number; busy: boolean };
  prFacts: PrFactsCounts;
};

export type ReplayedDate = { file: ItemsFile; prompt: string; pageTop: number; warnings: string[]; unparsed: string[] };

/** The Stage-1 struct and busy-by-load of one page at `now` (no PR facts, no prompt). */
async function replayStruct(cfg: Config, repos: readonly string[], page: string, date: string, now: Date) {
  const parsed = parseArchivedPage(page);
  const w = await replayWindow(cfg, repos, now);
  const flat = parsed.recap.map(({ group: _pageStamp, ...e }) => e);
  const recap = clusterRecap(flat, w.ctx, w.units, w.rootsByRepo);
  const struct: BriefingStruct = {
    date, machineScope: "replay", provider: "replay", resume: [], recap, suggestions: [], windowMerges: parsed.foot,
    ...(parsed.stateAsOf ? { stateAsOf: parsed.stateAsOf } : {}),
  };
  // §4.1 step 3's population, exactly as core.ts hands it to the phase
  const commitActs = w.ctx.repos.flatMap((r) => r.activities).filter((a) => a.kind === "commit");
  const before = topLevelRecapCount(recap);
  return { parsed, w, struct, commitActs, before, busy: { commits: commitActs.length, top: before, busy: busyByLoad(commitActs.length, before) } };
}

/** One page, end to end: the struct, the items, the PR facts, the prompt. Reads git; writes nothing. */
export async function replayDate(cfg: Config, repos: readonly string[], page: string, date: string, now: Date): Promise<ReplayedDate> {
  const r = await replayStruct(cfg, repos, page, date, now);
  const ctxCommits = r.commitActs.filter((a) => typeof a.event_id === "string");
  const commitsById = new Map(ctxCommits.map((a) => [a.event_id, a] as const));
  const labels = labelUniverse(r.w.units.map((u) => u.label), repos.map((p) => repoLabelFor(p, [...repos])));
  const offered = buildCampaignItems(r.struct.recap, ctxCommits);
  const facts = await readPrFacts(offered, commitsById, r.w.windowStart, now, RECAP_GIT_BUDGET_MS);
  const items = attachPrFacts(offered, facts.membership);
  const prompt = buildCampaignPrompt(items, commitsById);
  return {
    file: {
      v: 1, date, now: now.toISOString(), windowStart: r.w.windowStart.toISOString(), struct: r.struct, units: labels, items,
      before: r.before, busy: r.busy, prFacts: facts.prFacts,
    },
    prompt, pageTop: topLevelRecapCount(r.parsed.recap), warnings: r.w.warnings, unparsed: r.parsed.unparsed,
  };
}

// ── item mode ───────────────────────────────────────────────────────────────────────────────────────

export type ItemModeOptions = { config: string; archive: string; out: string; dates?: string[]; record?: string };

const readPage = async (path: string): Promise<string | undefined> => {
  try { return await readFile(path, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/** Validate the config with the engine's own `validateConfig` (R1). Throws the engine's message. */
export async function loadReplayConfig(path: string): Promise<Config> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return validateConfig(raw, homedir());
}

export async function runItemMode(o: ItemModeOptions, out: Out): Promise<number> {
  const cfg = await loadReplayConfig(o.config);
  const { repos, issues } = await discoverRepos(cfg);
  for (const i of issues) out(`WARN repo discovery: ${i.path} (${i.kind})`);
  const recordPath = o.record ?? statePaths().recapCampaignsPath;
  const rec = await readRecordFiles([recordPath]);
  for (const m of rec.missing) out(`record ${m}: missing — read as empty`);
  for (const p of rec.problems) out(`record ${p}`);
  const records = rec.lines.map((l) => l.record);
  const dates = o.dates ?? [...DEFAULT_DATES];
  out(`replay items — ${dates.length} date(s)${o.dates ? "" : " (the fixed acceptance set)"} · ${repos.length} repo(s) · record ${recordPath}`);
  await mkdir(o.out, { recursive: true });
  let refused = 0;
  for (const date of dates) {
    const page = await readPage(join(o.archive, `${date}.md`));
    if (page === undefined) { out(`EXCLUDED ${date}: no archived page ${date}.md — reported, never swapped`); continue; }
    const era = bEraReason(page, date, records);
    if (era) { out(`SKIPPED ${date}: ${era} — never parsed`); continue; }
    const now = nowFromPage(date, page);
    if (!now) { out(`SKIPPED ${date}: no \`state as of HH:MM\` line — no default time`); continue; }
    const promptPath = join(o.out, `prompt-${date}.txt`);
    if (existsSync(promptPath)) {
      refused++;
      out(`REFUSED ${date}: ${promptPath} exists — a sent prompt is immutable evidence; nothing written for this date`);
      continue;
    }
    const r = await replayDate(cfg, repos, page, date, now);
    await writeFile(promptPath, r.prompt, { flag: "wx" });
    await writeFile(join(o.out, `items-${date}.json`), JSON.stringify(r.file, null, 2) + "\n");
    const f = r.file;
    out(`WROTE ${date}: now ${f.now} · window [${f.windowStart}, ${new Date(localMidnight(now)).toISOString()}) · commits ${f.busy.commits} · top ${f.busy.top} (page ${r.pageTop}) · busy ${f.busy.busy ? "yes" : "no"} · items ${f.items.length} · prFacts merges ${f.prFacts.merges} read ${f.prFacts.read} timedOut ${f.prFacts.timedOut} marked ${f.prFacts.marked} reposUnread ${f.prFacts.reposUnread}`);
    if (!f.busy.busy) out(`  NOT BUSY NOW ${date}: the busy rule would exclude it (commits ${f.busy.commits}, top ${f.busy.top}) — kept in the set, reported, never swapped`);
    for (const w of r.warnings) out(`  WARN ${date}: ${w}`);
    for (const u of r.unparsed) out(`  UNPARSED ${date}: ${u}`);
  }
  // a busy date OUTSIDE the set is reported, never added
  const inSet = new Set(dates);
  const others = (await readdir(o.archive)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 10)).filter((d) => !inSet.has(d)).sort();
  for (const date of others) {
    const page = (await readPage(join(o.archive, `${date}.md`)))!;
    const now = nowFromPage(date, page);
    if (bEraReason(page, date, records) || !now) continue;
    const r = await replayStruct(cfg, repos, page, date, now);
    if (r.busy.busy) out(`BUSY OUTSIDE THE SET ${date}: commits ${r.busy.commits} · top ${r.busy.top} — reported, never added`);
  }
  return refused ? 1 : 0;
}

// ── score mode (T5.3) ───────────────────────────────────────────────────────────────────────────────

export type DrawNo = 1 | 2;
export const replyFileName = (date: string, draw: DrawNo): string => (draw === 1 ? `reply-${date}.json` : `reply-${date}.d2.json`);

/** Check (c)'s rows from the label universe: one `{repo: label, labels: [label]}` row per label — the
 *  same one-line shaping the phase applies before it calls `scoreReply` (`recapCampaignsPhase.ts`, steps
 *  5–8). It shapes an input; the outcome and every number still come from the one `scoreReply` and the
 *  one `summariseRecapOutcomes`. */
export const coverageRows = (labels: readonly string[]): CoverageUnits => labels.map((l) => ({ repo: l, labels: [l] }));

const fmt = (x: number | null): string => (x === null ? "n/a" : x.toFixed(2));
const pctOf = (x: number | null): string => (x === null ? "" : ` (${(x * 100).toFixed(1)}%)`);
const isWholeReplyRejection = (r: ScoreResult): boolean => r.outcome === "rejected" && !String(r.reason).startsWith("live-check-");

/** The per-date report of one draw (§5.3): validation, drops with reasons, outcome, before → after, every
 *  kept campaign with its members and PR facts, each absorbed marked item flagged for C(ii). */
function reportDraw(date: string, draw: DrawNo, r: ScoreResult, out: Out): void {
  out(`draw ${draw} · ${date} — ${replyFileName(date, draw)}`);
  out(isWholeReplyRejection(r)
    ? `  validation: whole reply rejected — ${r.reason}`
    : `  validation: accepted — ${r.proposed} proposed · ${r.kept} kept · ${r.dropped.length} dropped`);
  for (const d of r.dropped) out(`  dropped "${d.title}": ${d.reasons.join(", ")}`);
  out(`  outcome ${r.outcome} · reason ${r.reason ?? "—"} · before ${r.before} → after ${r.after}`);
  const note = r.outcome === "rejected" ? " (rejected by the live check — not delivered)" : "";
  const kept = recordCampaigns(r.keptCampaigns);
  r.keptCampaigns.forEach((c, i) => {
    const k = kept[i]!;
    out(`  campaign [${k.label}] "${k.title}" — ${k.header} · ${c.items.length} item(s)${note}`);
    for (const it of c.items) {
      out(`    ${it.id} (${it.kind})${isMarkedItem(it) ? "  ⚑ C(ii): absorbed an item marked merged across PRs" : ""}`);
      for (const t of it.texts) out(`      - ${t}`);
      out(`      fact: ${it.fact}`);
    }
  });
}

/** C(ii)'s count: items marked `merged across PRs` absorbed by a campaign that shipped (outcome
 *  `applied`/`trial` — the ones a record's `campaigns[]` carries). */
const absorbedMarked = (rs: readonly ScoreResult[]): number =>
  rs.filter((r) => r.outcome === "applied" || r.outcome === "trial")
    .reduce((n, r) => n + r.keptCampaigns.reduce((m, c) => m + c.items.filter(isMarkedItem).length, 0), 0);

export async function runScoreMode(dir: string, out: Out): Promise<number> {
  const dates = (await readdir(dir)).filter((n) => /^items-\d{4}-\d{2}-\d{2}\.json$/.test(n)).map((n) => n.slice(6, 16)).sort();
  if (!dates.length) { out(`no items-<date>.json in ${dir}`); return 2; }
  const scored: Record<DrawNo, Map<string, ScoreResult>> = { 1: new Map(), 2: new Map() };
  const missing: Record<DrawNo, string[]> = { 1: [], 2: [] };
  out(`replay score — ${dates.length} date(s) in ${dir}`);
  for (const date of dates) {
    const f = JSON.parse(await readFile(join(dir, `items-${date}.json`), "utf8")) as ItemsFile;
    for (const draw of [1, 2] as const) {
      const text = await readPage(join(dir, replyFileName(date, draw)));
      if (text === undefined) { missing[draw].push(replyFileName(date, draw)); continue; }
      const r = scoreReply(f.struct, f.items, text, coverageRows(f.units), "trial");
      scored[draw].set(date, r);
      out("");
      reportDraw(date, draw, r, out);
    }
  }
  const complete = (d: DrawNo) => missing[d].length === 0;
  const results = (d: DrawNo) => dates.flatMap((x) => (scored[d].has(x) ? [scored[d].get(x)!] : []));
  const sum = { 1: summariseRecapOutcomes(results(1)), 2: summariseRecapOutcomes(results(2)) };
  out("");
  out("summary (§6.2) — every outcome from scoreReply, every number from summariseRecapOutcomes");
  const set = [...DEFAULT_DATES];
  const sameSet = dates.length === set.length && dates.every((d, i) => d === set[i]);
  out(`  dates: ${dates.length}${sameSet ? " — the fixed acceptance set" : ` — NOT the fixed acceptance set (${set.filter((d) => !dates.includes(d)).length} of its dates absent, ${dates.filter((d) => !set.includes(d as (typeof set)[number])).length} extra)`}`);
  for (const d of [1, 2] as const) {
    out(`  draw ${d}: ${complete(d) ? "complete" : `incomplete — missing ${missing[d].join(", ")} — not scored for A`}`);
  }
  const mean = (d: DrawNo) => `${fmt(sum[d].meanAfter)} over ${sum[d].meanAfterOver} date(s)`;
  if (complete(1) && complete(2)) {
    const m1 = sum[1].meanAfter, m2 = sum[2].meanAfter;
    const max = m1 === null || m2 === null ? null : Math.max(m1, m2);
    out(`  A: m1 = ${mean(1)} · m2 = ${mean(2)} · max(m1, m2) = ${fmt(max)} · max(m1, m2) ≤ 13: ${max === null ? "n/a" : max <= 13 ? "yes" : "no"}`);
    out(`     d = |m1 − m2| = ${m1 === null || m2 === null ? "n/a" : fmt(Math.abs(m1 - m2))} (information only)`);
  } else if (complete(1) || complete(2)) {
    const ran: DrawNo = complete(1) ? 1 : 2;
    const m = sum[ran].meanAfter;
    out(`  A: m = ${mean(ran)} (draw ${ran}, the draw that ran) · m ≤ 12.0: ${m === null ? "n/a" : m <= 12.0 ? "yes" : "no"}`);
  } else {
    out("  A: both draws incomplete — nothing to score; the run pauses for the user");
  }
  const bc: DrawNo | undefined = complete(1) ? 1 : complete(2) ? 2 : undefined;
  if (bc === undefined) {
    out("  B, C: no complete draw");
  } else {
    const s = sum[bc];
    const flag = bc === 2 ? " — FLAGGED: draw 1 missing — the user's rule names draw 1" : "";
    const reasons = Object.entries(s.rejectionReasons).map(([k, n]) => `${k} ×${n}`).join(", ");
    out(`  B (draw ${bc}${flag}): rejections ${s.rejections} of ${s.rows}${reasons ? ` — ${reasons}` : ""} · dropped / proposed ${s.dropped} / ${s.proposed}${pctOf(s.droppedShare)}`);
    out(`  C (draw ${bc}${flag}): absorbed items marked merged across PRs: ${absorbedMarked(results(bc))} (⚑ above); the kept campaigns above are for the user's judgement`);
  }
  return 0;
}

// ── the dry-run self-test (T5.4) ────────────────────────────────────────────────────────────────────

/** One §5.3 self-test case: the reply text and its v3.2 expectation. `dropped` lists every dropped
 *  campaign's reasons in drop order, compared EXACTLY — or, for S14–S16 (D3), `{contains}`: the one drop's
 *  reasons must CONTAIN the named rule. `liveChecks` is how many times the real `liveCheck` ran. */
export type DryRunCase = {
  tag: string;
  title: string;
  reply: string;
  outcome: ScoreOutcome;
  reason: string | null;
  kept: number;
  after: number;
  dropped: DropReason[][] | { contains: DropReason };
  liveChecks: 0 | 1;
};

const camp = (title: string, ...items: string[]) => ({ title, items });
const replyOf = (...campaigns: { title: string; items: string[] }[]): string => JSON.stringify({ campaigns });
/** Case 14's title: 49 code points (rule 2's bound is 3–48; D5 counts code points). */
export const TITLE_49 = "retry backoff tuned for the queue and its retries";

/** The fixture morning's Stage-1 count (§5.3): every case starts from it. */
const DRY_RUN_BEFORE = 9;

/** §5.3's cases 1–21, each with its v3.2 expectation. */
export const DRY_RUN_CASES: readonly DryRunCase[] = [
  { tag: "[TB-S1]", title: "`retry backoff` over G1+G2, bare object → accepted, 1 kept, 9 → 8",
    reply: replyOf(camp("retry backoff", "G1", "G2")), outcome: "trial", reason: null, kept: 1, after: 8, dropped: [], liveChecks: 1 },
  { tag: "[TB-S2]", title: "the same inside one ```json fence → accepted",
    reply: "```json\n" + replyOf(camp("retry backoff", "G1", "G2")) + "\n```", outcome: "trial", reason: null, kept: 1, after: 8, dropped: [], liveChecks: 1 },
  { tag: "[TB-S3]", title: "prose around {\"campaigns\":[]} → rejected, unparseable",
    reply: 'Here is the grouping: {"campaigns":[]} Let me know if you want changes.', outcome: "rejected", reason: "unparseable", kept: 0, after: 9, dropped: [], liveChecks: 0 },
  { tag: "[TB-S4]", title: "a 17,000-character extra value → rejected, oversize",
    reply: JSON.stringify({ campaigns: [], note: "x".repeat(17_000) }), outcome: "rejected", reason: "oversize", kept: 0, after: 9, dropped: [], liveChecks: 0 },
  { tag: "[TB-S5]", title: "an extra top-level key → rejected, schema",
    reply: JSON.stringify({ campaigns: [camp("retry backoff", "G1", "G2")], note: "x" }), outcome: "rejected", reason: "schema", kept: 0, after: 9, dropped: [], liveChecks: 0 },
  { tag: "[TB-S6]", title: "an extra campaign key → rejected, schema",
    reply: JSON.stringify({ campaigns: [{ ...camp("retry backoff", "G1", "G2"), why: "x" }] }), outcome: "rejected", reason: "schema", kept: 0, after: 9, dropped: [], liveChecks: 0 },
  { tag: "[TB-S7]", title: "id G9 → rejected, unknown-id",
    reply: replyOf(camp("retry backoff", "G1", "G9")), outcome: "rejected", reason: "unknown-id", kept: 0, after: 9, dropped: [], liveChecks: 0 },
  { tag: "[TB-S8]", title: "G2 in two campaigns → rejected, duplicate-id",
    reply: replyOf(camp("retry backoff", "G1", "G2"), camp("retry backoff also landed here", "G2", "G7")), outcome: "rejected", reason: "duplicate-id", kept: 0, after: 9, dropped: [], liveChecks: 0 },
  { tag: "[TB-S9]", title: "G1+G3 (two labels) → dropped (mixes labels) → outcome none, after = before = 9, no live check runs",
    reply: replyOf(camp("retry backoff", "G1", "G3")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["mixes-labels"]], liveChecks: 0 },
  { tag: "[TB-S10]", title: "G1 alone → dropped (fewer than 2 items) → outcome none",
    reply: replyOf(camp("retry backoff", "G1")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["too-few-items"]], liveChecks: 0 },
  { tag: "[TB-S11]", title: "`backoff retry` → dropped, rule 1",
    reply: replyOf(camp("backoff retry", "G1", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["title-rule-1"]], liveChecks: 0 },
  { tag: "[TB-S12]", title: "`etry backof` → dropped, rule 1 (word boundary)",
    reply: replyOf(camp("etry backof", "G1", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["title-rule-1"]], liveChecks: 0 },
  { tag: "[TB-S13]", title: "`py` → dropped, rule 2",
    reply: replyOf(camp("py", "G1", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["title-rule-2"]], liveChecks: 0 },
  { tag: "[TB-S14]", title: "a 49-character title → dropped, rule 2 among its reasons",
    reply: replyOf(camp(TITLE_49, "G1", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: { contains: "title-rule-2" }, liveChecks: 0 },
  { tag: "[TB-S15]", title: "`retry backoff (added)` → dropped, rule 3 among its reasons",
    reply: replyOf(camp("retry backoff (added)", "G1", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: { contains: "title-rule-3" }, liveChecks: 0 },
  { tag: "[TB-S16]", title: "`retry — backoff` → dropped, rule 3 among its reasons",
    reply: replyOf(camp("retry — backoff", "G1", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: { contains: "title-rule-3" }, liveChecks: 0 },
  { tag: "[TB-S17]", title: "`deadbeef1 landed` over G4+G2 → dropped, rule 4",
    reply: replyOf(camp("deadbeef1 landed", "G4", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["title-rule-4"]], liveChecks: 0 },
  { tag: "[TB-S18]", title: "`accountant_ai queue continued` over G5+G2 → dropped, rule 5",
    reply: replyOf(camp("accountant_ai queue continued", "G5", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["title-rule-5"]], liveChecks: 0 },
  { tag: "[TB-S19]", title: "`queue.py retry path reworked` over G6+G2 → dropped in pass 3: the name part of G1's surviving header",
    reply: replyOf(camp("queue.py retry path reworked", "G6", "G2")), outcome: "none", reason: null, kept: 0, after: 9, dropped: [["duplicate-title"]], liveChecks: 0 },
  { tag: "[TB-S20]", title: "`retry backoff` twice (G1+G2, then G6+G7) → first kept, second dropped as a duplicate",
    reply: replyOf(camp("retry backoff", "G1", "G2"), camp("retry backoff", "G6", "G7")), outcome: "trial", reason: null, kept: 1, after: 8, dropped: [["duplicate-title"]], liveChecks: 1 },
  { tag: "[TB-S21]", title: "{\"campaigns\":[]} → outcome none, after = before = 9, no live check runs",
    reply: replyOf(), outcome: "none", reason: null, kept: 0, after: 9, dropped: [], liveChecks: 0 },
];

/** Every way `r` (and the live-check call count) departs from the case's expectation; empty = ok. */
function dryRunMismatches(c: DryRunCase, r: ScoreResult, liveChecks: number): string[] {
  const bad: string[] = [];
  const cmp = (what: string, got: unknown, want: unknown) => { if (got !== want) bad.push(`${what} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); };
  cmp("outcome", r.outcome, c.outcome);
  cmp("reason", r.reason, c.reason);
  cmp("before", r.before, DRY_RUN_BEFORE);
  cmp("after", r.after, c.after);
  cmp("kept", r.kept, c.kept);
  cmp("live checks", liveChecks, c.liveChecks);
  const got = r.dropped.map((d) => d.reasons);
  if (Array.isArray(c.dropped)) {
    if (JSON.stringify(got) !== JSON.stringify(c.dropped)) bad.push(`drop reasons ${JSON.stringify(got)}, expected ${JSON.stringify(c.dropped)}`);
  } else if (got.length !== 1 || !got[0]!.includes(c.dropped.contains)) {
    bad.push(`drop reasons ${JSON.stringify(got)}, expected one drop containing ${JSON.stringify(c.dropped.contains)}`);
  }
  return bad;
}

/** `--dry-run`: the fixture's own shape first (seven items G1–G7, two unresolved bullets, count 9, a
 *  49-code-point case-14 title), then every case through the ONE `scoreReply`. Returns the exit code. */
export function runDryRun(out: Out, err: Out): number {
  const items = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
  const offered = new Set(items.flatMap((i) => i.entries));
  const shape = [
    items.map((i) => i.id).join(",") === "G1,G2,G3,G4,G5,G6,G7",
    MORNING_RECAP.length - offered.size === 2,
    topLevelRecapCount(MORNING_STRUCT.recap) === DRY_RUN_BEFORE,
    [...TITLE_49].length === 49,
  ];
  if (shape.some((ok) => !ok)) { err(`--dry-run: the fixture morning is not §5.3's (checks ${shape.join(", ")})`); return 1; }
  const units = coverageRows(MORNING_LABELS);
  let failed = 0;
  for (const c of DRY_RUN_CASES) {
    let calls = 0;
    const counted: typeof liveCheck = (...a) => { calls++; return liveCheck(...a); };
    let bad: string[];
    try {
      bad = dryRunMismatches(c, scoreReply(MORNING_STRUCT, items, c.reply, units, "trial", { liveCheck: counted }), calls);
    } catch (e) {
      bad = [`scoreReply threw: ${e instanceof Error ? e.message : String(e)}`];
    }
    if (bad.length) { failed++; out(`FAIL ${c.tag} ${c.title}: ${bad.join("; ")}`); } else out(`ok ${c.tag} ${c.title}`);
  }
  err(`--dry-run: ${DRY_RUN_CASES.length - failed} of ${DRY_RUN_CASES.length} ok`);
  return failed ? 1 : 0;
}

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────────────

const USAGE = "usage: recap-campaigns-replay.ts --config <path> --items <archive-dir> --out <dir> [--dates <d1,d2,…>] [--record <path>]\n"
  + "       recap-campaigns-replay.ts --score <dir>\n"
  + "       recap-campaigns-replay.ts --dry-run";

export async function main(argv: readonly string[], out: Out = (l) => console.log(l), err: Out = (l) => console.error(l)): Promise<number> {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") { bare.add(a); continue; }
    if (["--config", "--items", "--out", "--dates", "--record", "--score"].includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { err(`${a} needs a value\n${USAGE}`); return 2; }
      flags.set(a, v); i++; continue;
    }
    err(`unknown argument ${a}\n${USAGE}`); return 2;
  }
  if (bare.has("--dry-run")) {
    if (flags.size) { err(`--dry-run takes no other flag\n${USAGE}`); return 2; }
    return runDryRun(out, err);
  }
  if (flags.has("--score")) {
    if (flags.size > 1) { err(`--score takes no other flag\n${USAGE}`); return 2; }
    return runScoreMode(flags.get("--score")!, out);
  }
  if (!flags.has("--items")) { err(USAGE); return 2; }
  const config = flags.get("--config");
  if (config === undefined) { err(`--config <path> is required: repos, units, author, excludeCommitPatterns and tokenBudget all come from it\n${USAGE}`); return 2; }
  if (!flags.has("--out")) { err(`--out <dir> is required with --items\n${USAGE}`); return 2; }
  let dates: string[] | undefined;
  if (flags.has("--dates")) {
    dates = flags.get("--dates")!.split(",").map((d) => d.trim()).filter(Boolean);
    const bad = dates.filter((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d));
    if (bad.length || !dates.length) { err(`--dates must be a comma-separated list of YYYY-MM-DD (bad: ${bad.join(", ") || "empty"})`); return 2; }
  }
  try { await loadReplayConfig(config); } catch (e) {
    err(`--config ${config}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  return runItemMode({ config, archive: flags.get("--items")!, out: flags.get("--out")!, dates, record: flags.get("--record") }, out);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`recap-campaigns-replay failed: ${e}`); process.exit(1); });
}
