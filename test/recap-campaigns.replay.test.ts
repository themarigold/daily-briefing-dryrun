// test/recap-campaigns.replay.test.ts — tier B, the offline replay (spec §5.3; D11; D1 addendum).
// T5.2: item mode, R1–R9, plus the plan-added K11 parity and items round-trip titles.
// T5.3: `--score <dir>`, two draws, R10–R13.
// T5.4: `--dry-run`, the self-test — S1–S21 live in the SCRIPT's case table; this file spawns it once.
//
// Fixtures only: ONE real git repo whose in-window commits all sit on ONE earlier local day (the
// `yesterdayNoon` idiom, plan §1; K32), archived pages written by `renderBriefing`, and record files
// written here. No provider exists anywhere in this file. Every date is computed in THIS process, which
// `bun test` runs in UTC, and the replay runs in-process too (K27: nothing compares a local-zone driver's
// output against a test-captured artifact). The CLI spawns (R1, the dry-run) hand the child the isolated env.
import "./fixtures/isolate-state";
import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { buildRepo } from "./fixtures/build-repo";
import { yesterdayNoon } from "./fixtures/recap-busy";
import { renderBriefing } from "../src/render";
import { localDateStr } from "../src/marker";
import { localMidnight } from "../src/time";
import { gitActivity } from "../src/extractor";
import { runCore } from "../src/core";
import { PROMPT_HEADER } from "../src/generator";
import { FENCE_OPEN, scoreReply, topLevelRecapCount, attachPrFacts, buildCampaignItems, type CampaignItem, type RecapRecordV2 } from "../src/recapCampaigns";
import type { BriefingStruct, Config } from "../src/types";
import { MORNING_STRUCT, MORNING_RECAP, MORNING_COMMITS, MORNING_LABELS, A, B } from "./fixtures/campaign-morning";
import {
  main, parseArchivedPage, nowFromPage, bEraReason, replayWindow, replayDate, splitEvidence, DEFAULT_DATES, type ItemsFile,
} from "../scripts/recap-campaigns-replay";

const PKG = join(import.meta.dir, "..");
const tmp = (tag: string): string => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-tb52-${tag}-`)));

// ── the fixture repo: 40 commits + one PR branch commit, all yesterday ────────────────────────────────
let REPO = "";
let LABEL = "";
let SHAS: string[] = [];          // the 40 mainline commits, oldest first
let TIDY = "";                    // the PR branch's commit
let CFG: Config;
let CONFIG_PATH = "";
const TODAY = localDateStr(new Date());

beforeAll(async () => {
  REPO = await buildRepo([]);
  LABEL = basename(REPO);
  const base = yesterdayNoon().getTime();
  const at = (min: number) => new Date(base + min * 60_000).toISOString();
  const c = (file: string, msg: string, min: number, content = msg) =>
    `printf '%s\\n' '${content}' > ${file} && git add ${file} && GIT_AUTHOR_DATE=${at(min)} GIT_COMMITTER_DATE=${at(min)} git commit -q -m '${msg}'`;
  const script = ["set -e"];
  // commits 0 and 1 share their only file: Stage 1's clusterRecap will group them
  script.push(c("ledger.txt", "rework ledger rounding step 1", 0), c("ledger.txt", "rework ledger rounding step 2", 1, "v2"));
  for (let i = 2; i < 40; i++) script.push(c(`f${i}.txt`, `adjust q${i} widget`, i));
  // a PR: a branch commit, merged back with a GitHub subject — the fact `merged in PR #7 (feat tidy)`
  script.push("git checkout -q -b feat/tidy", c("tidy.txt", "tidy the ledger notes", 45), "git checkout -q main",
    `GIT_AUTHOR_DATE=${at(50)} GIT_COMMITTER_DATE=${at(50)} git merge -q --no-ff -m 'Merge pull request #7 from acme/feat/tidy' feat/tidy`);
  const p = Bun.spawnSync(["sh", "-c", script.join("\n")], { cwd: REPO, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`fixture repo: ${p.stderr.toString()}`);
  const log = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe" }).stdout.toString().trim();
  SHAS = log(["log", "--first-parent", "--no-merges", "--reverse", "--format=%H", "main"]).split("\n");
  TIDY = log(["rev-parse", "feat/tidy"]);
  if (SHAS.length !== 40 || !TIDY) throw new Error(`fixture repo: ${SHAS.length} mainline commits`);
  CFG = { repos: [REPO], excludeCommitPatterns: [], lookbackCapDays: 30, provider: { cli: "echo", argv: [], promptVia: "stdin" } } as Config;
  const cfgDir = tmp("cfg");
  CONFIG_PATH = join(cfgDir, "config.json");
  writeFileSync(CONFIG_PATH, JSON.stringify(CFG));
}, 20_000);

/** A page as the engine renders it: flat bullets (no Stage-1 stamps — the replay re-derives them), a why
 *  line, a 🔀 foot, and the `state as of` stamp (omitted when `stateAsOf` is null). */
const busyPage = (date: string, stateAsOf: string | null = "06:30"): string => {
  const recap: BriefingStruct["recap"] = [
    { repo: LABEL, text: "rework ledger rounding step 1", evidence: SHAS[0]!.slice(0, 7) },
    { repo: LABEL, text: "rework ledger rounding step 2", evidence: SHAS[1]!.slice(0, 7) },
    { repo: LABEL, text: "tidy the ledger notes", evidence: TIDY.slice(0, 7) },
    ...SHAS.slice(2, 15).map((s, i) => ({ repo: LABEL, text: `polish piece number ${i + 2}`, evidence: s.slice(0, 7) })),
    { repo: LABEL, text: "a bullet with no evidence" },
  ];
  return renderBriefing({
    date, machineScope: "fixture", provider: "canned", resume: [], suggestions: [], recap,
    whys: { [LABEL]: "rework the ledger" },
    windowMerges: [{ repo: LABEL, text: `🔀 Merged #7 (feat/tidy) (Sep 27)  (${TIDY.slice(0, 7)})` }],
    ...(stateAsOf ? { stateAsOf } : {}),
  });
};
/** A quiet or bullet-only page with `n` flat bullets and no evidence (busy by `top` alone when n ≥ 15). */
const flatPage = (date: string, n: number): string => renderBriefing({
  date, machineScope: "fixture", provider: "canned", resume: [], suggestions: [], stateAsOf: "07:10",
  recap: Array.from({ length: n }, (_, i) => ({ repo: LABEL, text: `bullet ${i}` })),
});

const run = async (argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, (l) => out.push(l), (l) => err.push(l));
  return { code, out, err };
};
const rec = (date: string, mode: "trial" | "on", outcome: RecapRecordV2["outcome"]): RecapRecordV2 => ({
  v: 2, date, mode, invoker: "scheduled", json: false, forced: false, gate: { fired: true, commits: 45, top: 18 }, outcome,
  reason: null, before: 18, after: 18, proposed: 0, kept: 0, dropped: [], latencyMs: 1, gitMs: 0, hardening: "on", providerWarnings: [],
});

describe("item mode (§5.3)", () => {
  test("[TB-R1] --config is required and is checked by the engine's own validateConfig", async () => {
    const archive = tmp("r1"), out = tmp("r1-out");
    const cli = (args: string[]) => Bun.spawnSync(["bun", "scripts/recap-campaigns-replay.ts", ...args], { cwd: PKG, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const none = cli(["--items", archive, "--out", out]);
    expect(none.exitCode).toBe(2);
    expect(none.stderr.toString()).toContain("--config <path> is required");
    const badPath = join(tmp("r1-cfg"), "bad.json");
    writeFileSync(badPath, JSON.stringify({ repos: [REPO] }));          // no provider → validateConfig refuses
    const bad = cli(["--config", badPath, "--items", archive, "--out", out]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain(`--config ${badPath}: config error:`);
    // in-process, the same: nothing is read or written before the config validates
    const r = await run(["--config", badPath, "--items", archive, "--out", join(out, "never")]);
    expect(r.code).toBe(2);
    expect(existsSync(join(out, "never"))).toBe(false);
  }, 20_000);

  test("[TB-R2] now is the page's date at its `state as of`; a page without it is skipped and reported", async () => {
    const page = busyPage(TODAY);
    const now = nowFromPage(TODAY, page)!;
    expect([now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()])
      .toEqual([...TODAY.split("-").map(Number), 6, 30]);
    const bare = busyPage(TODAY, null);
    expect(nowFromPage(TODAY, bare)).toBeUndefined();
    const archive = tmp("r2"), out = tmp("r2-out");
    writeFileSync(join(archive, `${TODAY}.md`), bare);
    const r = await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--dates", TODAY, "--record", join(archive, "none.jsonl")]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`SKIPPED ${TODAY}: no \`state as of HH:MM\` line — no default time`);
    expect(existsSync(join(out, `prompt-${TODAY}.txt`))).toBe(false);
  }, 20_000);

  test("[TB-R3] the inverse parse: `text  (evidence)` from the right, Stage-1 header detection, the 🔀 foot", () => {
    const recap: BriefingStruct["recap"] = [
      { repo: "acct", text: "fix (the) thing", evidence: "abc1234" },
      { repo: "acct", text: "queue work, and more", evidence: "abc1235, abc1236" },
      { repo: "acct", text: "grouped one", evidence: "def5678", group: "queue.py — 2 commits" },
      { repo: "Acct", text: "grouped two  (not evidence) tail", evidence: "def5679", group: "queue.py — 2 commits" },
      { repo: "quant", text: "ends in parens (again)" },
      { repo: "quant", text: "no evidence at all" },
    ];
    const foot = [{ repo: "acct", text: "🔀 Merged #3 (feat/x) (Sep 22)  (ccc1234)" }, { repo: "acct", text: "🔀 Merged #4 (feat/y) (Sep 23)  (ccc1235)" }];
    const page = renderBriefing({
      date: "2026-09-24", machineScope: "m", provider: "p", resume: [], suggestions: [], stateAsOf: "07:24", recap, windowMerges: foot,
      whys: { acct: "a why line" },
      recapCoverage: { total: 9, shown: 7, notShown: [{ label: "acct", sha: "fff0000", subject: "not shown" }] },
    } as BriefingStruct);
    const parsed = parseArchivedPage(page);
    expect(parsed.recap).toEqual(recap);                    // exact inverse, group stamps from the page
    expect(parsed.foot).toEqual([{ repo: "acct", text: "🔀 2 PRs merged (#3, #4) (Sep 22–Sep 23)  (ccc1234, ccc1235)" }]);
    expect(parsed.stateAsOf).toBe("07:24");
    expect(parsed.unparsed).toEqual([]);
    // exactly two spaces: three is text, one is text
    expect(splitEvidence("a   (b)")).toEqual({ text: "a   (b)" });
    expect(splitEvidence("a (b)")).toEqual({ text: "a (b)" });
    expect(splitEvidence("a  (b (c))")).toEqual({ text: "a", evidence: "b (c)" });
    // a level-1 line NOT followed by a ◦ line is a bullet, never a header
    expect(parseArchivedPage(page).recap.filter((r) => r.group === undefined).map((r) => r.text))
      .toEqual(["fix (the) thing", "queue work, and more", "ends in parens (again)", "no evidence at all"]);
  });

  test("[TB-R4] B-era rule (1): a page with a level-3 ▪ line is skipped, never parsed", async () => {
    const page = busyPage(TODAY) + "\n         ▪ [x] a campaign member  (abc1234)\n";
    expect(bEraReason(page, TODAY, [])).toBe("B-era rule 1: a level-3 (▪) line");
    const archive = tmp("r4"), out = tmp("r4-out");
    writeFileSync(join(archive, `${TODAY}.md`), page);
    const r = await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--dates", TODAY, "--record", join(archive, "none.jsonl")]);
    expect(r.out).toContain(`SKIPPED ${TODAY}: B-era rule 1: a level-3 (▪) line — never parsed`);
    expect(existsSync(join(out, `items-${TODAY}.json`))).toBe(false);
  }, 20_000);

  test("[TB-R5] B-era rule (2): an `applied` line for the page's date (the record's date is runDate)", async () => {
    const page = busyPage(TODAY);
    expect(bEraReason(page, TODAY, [rec(TODAY, "on", "applied")])).toBe("B-era rule 2: the record has an `applied` line for this date");
    // a trial line, or an applied line for ANOTHER date, is not rule 2
    expect(bEraReason(page, TODAY, [rec(TODAY, "trial", "trial"), rec("2026-01-02", "on", "applied")])).toBeUndefined();
    const archive = tmp("r5"), out = tmp("r5-out");
    writeFileSync(join(archive, `${TODAY}.md`), page);
    const record = join(archive, "recap-campaigns.jsonl");
    writeFileSync(record, JSON.stringify(rec(TODAY, "on", "applied")) + "\n");
    const r = await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--dates", TODAY, "--record", record]);
    expect(r.out).toContain(`SKIPPED ${TODAY}: B-era rule 2: the record has an \`applied\` line for this date — never parsed`);
  }, 20_000);

  test("[TB-R6] B-era rule (3): no line for the date inside the mode-on span skips it — bounded on BOTH sides", () => {
    const page = flatPage("2026-09-10", 3);
    const records = [rec("2026-09-05", "trial", "trial"), rec("2026-09-08", "on", "none"), rec("2026-09-12", "on", "applied"), rec("2026-09-20", "trial", "none")];
    const why = (d: string) => bEraReason(page, d, records);
    expect(why("2026-09-07")).toBeUndefined();                                          // before the first `on` line
    expect(why("2026-09-08")).toBeUndefined();                                          // on the span's edge, but HAS a line (not applied)
    expect(why("2026-09-10")).toBe("B-era rule 3: no record line for this date, inside the mode-on span 2026-09-08…2026-09-12");
    expect(why("2026-09-11")).toMatch(/^B-era rule 3/);
    expect(why("2026-09-15")).toBeUndefined();                                          // AFTER the last `on` line: B was switched off
    expect(why("2026-09-25")).toBeUndefined();
    expect(bEraReason(page, "2026-09-10", records.filter((r) => r.mode !== "on"))).toBeUndefined();   // no `on` line: no span
  });

  test("[TB-R7] the window, the production functions and busy by load; writes the exact prompt and the items", async () => {
    const archive = tmp("r7"), out = tmp("r7-out");
    writeFileSync(join(archive, `${TODAY}.md`), busyPage(TODAY));
    const r = await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--dates", TODAY, "--record", join(archive, "none.jsonl")]);
    expect(r.code).toBe(0);
    const f = JSON.parse(readFileSync(join(out, `items-${TODAY}.json`), "utf8")) as ItemsFile;
    const prompt = readFileSync(join(out, `prompt-${TODAY}.txt`), "utf8");
    // the window: [yesterday 00:00, today 00:00) local — every fixture commit, the PR branch's included
    const now = nowFromPage(TODAY, busyPage(TODAY))!;
    const y = localMidnight(now); y.setDate(y.getDate() - 1);
    expect([f.date, f.now, f.windowStart]).toEqual([TODAY, now.toISOString(), y.toISOString()]);
    // Stage 1 re-derived by the REAL clusterRecap: the page was flat, the two ledger bullets share one file
    expect(f.struct.recap[0]!.group).toBeDefined();
    expect(f.struct.recap[1]!.group).toBe(f.struct.recap[0]!.group);
    expect(f.struct.recap.slice(2).every((e) => e.group === undefined)).toBe(true);
    expect(f.struct.windowMerges).toEqual([{ repo: LABEL, text: `🔀 1 PR merged (#7) (Sep 27)  (${TIDY.slice(0, 7)})` }]);
    // the count and busy by load: 41 window commits (≥ 40), 16 top-level lines (≥ 15)
    expect(f.before).toBe(16);
    expect(f.before).toBe(topLevelRecapCount(f.struct.recap));
    expect(f.busy).toEqual({ commits: 41, top: 16, busy: true });
    expect(f.units).toEqual([LABEL]);
    // the offered items: one group, the resolved singles; the unresolved bullet gets no id
    expect(f.items.map((i) => [i.id, i.kind])).toEqual([["G1", "group"], ...Array.from({ length: 14 }, (_, i) => [`G${i + 2}`, "single"])]);
    expect(f.items[1]!.fact).toBe("merged in PR #7 (feat tidy)");
    expect(f.prFacts).toEqual({ merges: 1, read: 1, timedOut: 0, marked: 0, reposUnread: 0 });
    // the exact production prompt, header included
    expect(prompt.startsWith(PROMPT_HEADER)).toBe(true);
    expect(prompt).toContain(FENCE_OPEN);
    expect(prompt).toContain(`  G2  label=${LABEL.toLowerCase()}  (single)`);
    expect(prompt).toContain("    merged in PR #7 (feat tidy)");
    expect(r.out.find((l) => l.startsWith(`WROTE ${TODAY}:`))).toContain("commits 41 · top 16 (page 17) · busy yes · items 15");
    // the prompt is what replayDate builds, byte for byte
    const again = await replayDate(CFG, [REPO], busyPage(TODAY), TODAY, now);
    expect(again.prompt).toBe(prompt);
  }, 20_000);

  test("[TB-R8] it refuses to overwrite an existing prompt file — a sent prompt is immutable evidence", async () => {
    const archive = tmp("r8"), out = tmp("r8-out");
    writeFileSync(join(archive, `${TODAY}.md`), busyPage(TODAY));
    const sent = join(out, `prompt-${TODAY}.txt`);
    writeFileSync(sent, "THE PROMPT THAT WAS SENT\n");
    const r = await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--dates", TODAY, "--record", join(archive, "none.jsonl")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`REFUSED ${TODAY}: ${sent} exists — a sent prompt is immutable evidence; nothing written for this date`);
    expect(readFileSync(sent, "utf8")).toBe("THE PROMPT THAT WAS SENT\n");
    expect(existsSync(join(out, `items-${TODAY}.json`))).toBe(false);
  }, 20_000);

  test("[TB-R9] the nine-date default; an excluded or non-busy date is reported, never swapped; a busy date outside is reported, never added", async () => {
    expect([...DEFAULT_DATES]).toEqual(["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-09", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-23"]);
    const archive = tmp("r9"), out = tmp("r9-out");
    writeFileSync(join(archive, "2026-09-03.md"), flatPage("2026-09-03", 16));   // busy by top
    writeFileSync(join(archive, "2026-09-04.md"), flatPage("2026-09-04", 3));    // in the set, not busy now
    writeFileSync(join(archive, "2026-09-10.md"), flatPage("2026-09-10", 15));   // OUTSIDE the set, busy
    writeFileSync(join(archive, "2026-09-11.md"), flatPage("2026-09-11", 4));    // outside, quiet
    const r = await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--record", join(archive, "none.jsonl")]);
    expect(r.code).toBe(0);
    expect(r.out[r.out.findIndex((l) => l.startsWith("replay items — "))]).toContain("9 date(s) (the fixed acceptance set)");
    expect(r.out.find((l) => l.startsWith("WROTE 2026-09-03:"))).toContain("busy yes");
    expect(r.out.find((l) => l.startsWith("WROTE 2026-09-04:"))).toContain("busy no");
    expect(r.out).toContain("  NOT BUSY NOW 2026-09-04: the busy rule would exclude it (commits 0, top 3) — kept in the set, reported, never swapped");
    for (const d of ["2026-09-05", "2026-09-06", "2026-09-09", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-23"]) {
      expect(r.out).toContain(`EXCLUDED ${d}: no archived page ${d}.md — reported, never swapped`);
    }
    expect(r.out).toContain("BUSY OUTSIDE THE SET 2026-09-10: commits 0 · top 15 — reported, never added");
    expect(r.out.some((l) => l.includes("2026-09-11"))).toBe(false);
    expect(existsSync(join(out, "prompt-2026-09-10.txt"))).toBe(false);
    expect(existsSync(join(out, "prompt-2026-09-03.txt"))).toBe(true);
    expect(existsSync(join(out, "prompt-2026-09-04.txt"))).toBe(true);
  }, 20_000);

  test("the replay's windowStart equals gitActivity's at the real now", async () => {
    const now = new Date();
    const w = await replayWindow(CFG, [REPO], now);
    const g = await gitActivity(CFG, [REPO]);
    expect(w.windowStart.toISOString()).toBe(g.windowStartUtc);
    // and it is the fixture's one commit day, so the parity is not two empty windows agreeing
    const y = localMidnight(now); y.setDate(y.getDate() - 1);
    expect(g.windowStartUtc).toBe(y.toISOString());
  }, 20_000);

  // M5a (cc), user ruling 2026-09-28 "match production": the replay dedupes shared refs and patch-id
  // twins where `gitActivity` does. Fixture: ONE history reached through TWO configured repos (a linked
  // worktree — every SHA listed twice, `dedupeSharedRefs`' case) plus a rebase-style twin (the same
  // patch and subject on a stale branch and on main, not ancestor-related — `dedupeTwins`' case), all at
  // `yesterdayNoon`. A duplicated SHA resolves no bullet (`generator.ts` resolves only a UNIQUE hit), so
  // without the dedupe the ledger pair does not group and `before` rises; the twin inflates the commits.
  test("the replay's ctx commits and before equal runCore's on a shared-history fixture", async () => {
    const repo = await buildRepo([]);
    const wt = join(tmp("pw"), "wt");
    const base = yesterdayNoon().getTime();
    const at = (min: number) => new Date(base + min * 60_000).toISOString();
    const c = (file: string, msg: string, min: number, content = msg) =>
      `printf '%s\\n' '${content}' > ${file} && git add ${file} && GIT_AUTHOR_DATE=${at(min)} GIT_COMMITTER_DATE=${at(min)} git commit -q -m '${msg}'`;
    const script = ["set -e", c("ledger.txt", "rework ledger rounding step 1", 0), c("ledger.txt", "rework ledger rounding step 2", 1, "v2")];
    for (let i = 2; i < 6; i++) script.push(c(`f${i}.txt`, `adjust q${i} widget`, i));
    script.push("git checkout -q -b stale", c("bug.txt", "fix the rounding bug", 10, "fixed"), "git checkout -q main",
      c("bug.txt", "fix the rounding bug", 20, "fixed"), `git worktree add -q --detach ${wt}`);
    const p = Bun.spawnSync(["sh", "-c", script.join("\n")], { cwd: repo, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`shared-history fixture: ${p.stderr.toString()}`);
    const shas = Bun.spawnSync(["git", "log", "--reverse", "--format=%H", "main"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim().split("\n");
    expect(shas).toHaveLength(7);   // 6 on main + main's twin copy; the stale copy is off main
    // …and a SAME-DAY twin pair (today, before now): `today.txt` with one patch on a `stale-today` branch cut
    // from main~1 (a different parent, so a different SHA) and on main, not ancestor-related — listed
    // through both repos, so today's list holds FOUR copies of one change, and production's today-side
    // dedupe keeps ONE. Added after `shas`, off the window.
    const tToday = new Date(Math.max(localMidnight(new Date()).getTime() + 1_000, Date.now() - 120_000)).toISOString();
    const ct = `printf '%s\\n' 'today fix' > today.txt && git add today.txt && GIT_AUTHOR_DATE=${tToday} GIT_COMMITTER_DATE=${tToday} git commit -q -m 'fix the today bug'`;
    const q = Bun.spawnSync(["sh", "-c", ["set -e", "git checkout -q -b stale-today HEAD~1", ct, "git checkout -q main", ct].join("\n")], { cwd: repo, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    if (q.exitCode !== 0) throw new Error(`same-day twin fixture: ${q.stderr.toString()}`);
    const label = basename(repo);
    const reply = ["## RESUME", `- [${label}] resume the ledger rework`, "## RECAP",
      `- [${label}] rework ledger rounding step 1 | evidence: ${shas[0]!.slice(0, 7)}`,
      `- [${label}] rework ledger rounding step 2 | evidence: ${shas[1]!.slice(0, 7)}`,
      ...shas.slice(2, 6).map((s, i) => `- [${label}] polish piece number ${i + 2} | evidence: ${s.slice(0, 7)}`),
      `- [${label}] fix the rounding bug | evidence: ${shas[6]!.slice(0, 7)}`,
      "## SUGGESTIONS", `- [${label}] finish the ledger rework`].join("\n");
    const cfg = { repos: [repo, wt], excludeCommitPatterns: [], lookbackCapDays: 30, provider: { cli: "echo", argv: [], promptVia: "stdin" } } as Config;
    const r = await runCore(cfg, { provider: { generate: async () => reply }, netProbe: async () => true, persistHealth: async () => {} }, true);
    const commitsOf = (ctx: typeof r.ctx) => ctx.repos.flatMap((x) => x.activities).filter((a) => a.kind === "commit").length;
    // non-vacuity: both repos were read, production collapsed 2 × 8 listed commits to 7, and Stage 1 grouped the ledger pair
    expect(r.repos).toEqual([repo, wt]);
    for (const d of [repo, wt]) expect(Bun.spawnSync(["git", "rev-list", "--all", "--count"], { cwd: d, stdout: "pipe" }).stdout.toString().trim()).toBe("10");   // 8 in the window + the 2 same-day twins
    expect(commitsOf(r.ctx)).toBe(7);
    expect(r.struct.recap[0]!.group).toBeDefined();
    const page = renderBriefing(r.struct);
    const now = nowFromPage(TODAY, page)!;
    const w = await replayWindow(cfg, r.repos, now);
    const replayed = (await replayDate(cfg, r.repos, page, TODAY, now)).file;
    expect(commitsOf(w.ctx)).toBe(commitsOf(r.ctx));
    expect(replayed.busy.commits).toBe(commitsOf(r.ctx));
    expect(replayed.before).toBe(topLevelRecapCount(r.struct.recap));
    // the TODAY side (it feeds only `resolveUnits`): the units' same-day commit counts equal runCore's. Read
    // at the real now, as runCore's were — the page's `state as of` is floored to the minute. Units with no
    // same-day commit are left out: the replay does not replay resumption signals (the detached worktree).
    const todayOf = (units: { label: string; todayCommits?: number }[]) => units.filter((u) => (u.todayCommits ?? 0) > 0).map((u) => [u.label, u.todayCommits]);
    const wNow = await replayWindow(cfg, r.repos, new Date());
    expect(todayOf(wNow.units)).toEqual(todayOf(r.units));
    expect(todayOf(r.units).map(([, n]) => n)).toEqual([1]);         // non-vacuity: production kept ONE of four copies
  }, 30_000);

  // Harden r1 (C1): the look-back of `committerDaysWithCommits` counts from the REAL clock, so the replay
  // extends it by the page's age (`cap + 1 + age`). Pinned on a page ≥ cap + 2 days old at the DEFAULT cap
  // (4, `config.ts:27` — no `lookbackCapDays` here) over a repo whose only commits sit on the local day
  // BEFORE the page's date: without the `+ age` those commits fall outside the real-clock look-back, no
  // day is active, and `windowStart` silently widens to the cap (page − 4 days) instead of page − 1.
  test("an OLD page (≥ cap + 2 days): the look-back is extended by the page's age, windowStart = the commit day", async () => {
    const pageDay = localMidnight(new Date()); pageDay.setDate(pageDay.getDate() - 6);          // cap + 2 days ago
    const commitDay = new Date(pageDay); commitDay.setDate(commitDay.getDate() - 1);           // the local day before it
    const at = (h: number) => new Date(commitDay.getFullYear(), commitDay.getMonth(), commitDay.getDate(), h, 0, 0, 0).toISOString();
    const repo = await buildRepo([
      { file: "a.txt", content: "a", isoDate: at(10) },
      { file: "b.txt", content: "b", isoDate: at(11) },
      { file: "c.txt", content: "c", isoDate: at(12) },
    ]);
    const cfg = { repos: [repo], excludeCommitPatterns: [], provider: { cli: "echo", argv: [], promptVia: "stdin" } } as Config;
    const date = localDateStr(pageDay);
    const page = renderBriefing({
      date, machineScope: "fixture", provider: "canned", resume: [], suggestions: [], stateAsOf: "06:30",
      recap: [{ repo: basename(repo), text: "add a" }, { repo: basename(repo), text: "add b" }],
    });
    const now = nowFromPage(date, page)!;
    expect(Math.ceil((Date.now() - now.getTime()) / 864e5)).toBeGreaterThanOrEqual(6);        // non-vacuity: the page IS old
    const f = (await replayDate(cfg, [repo], page, date, now)).file;
    expect(f.windowStart).toBe(commitDay.toISOString());      // the commit day's local midnight, not page − cap
    expect(f.busy.commits).toBe(3);
  }, 20_000);

  test("items-<date>.json round-trips into scoreReply", async () => {
    const archive = tmp("rt"), out = tmp("rt-out");
    const page = busyPage(TODAY);
    writeFileSync(join(archive, `${TODAY}.md`), page);
    expect((await run(["--config", CONFIG_PATH, "--items", archive, "--out", out, "--dates", TODAY, "--record", join(archive, "none.jsonl")])).code).toBe(0);
    const f = JSON.parse(readFileSync(join(out, `items-${TODAY}.json`), "utf8")) as ItemsFile;
    const live = (await replayDate(CFG, [REPO], page, TODAY, nowFromPage(TODAY, page)!)).file;
    const reply = JSON.stringify({ campaigns: [{ title: "rework ledger rounding", items: ["G1", "G3"] }, { title: "polish piece number", items: ["G4", "G5", "G6"] }] });
    const rows = (u: string[]) => u.map((l) => ({ repo: l, labels: [l] }));
    const fromFile = scoreReply(f.struct, f.items, reply, rows(f.units), "trial");
    const inMemory = scoreReply(live.struct, live.items, reply, rows(live.units), "trial");
    expect(fromFile).toEqual(inMemory);
    expect(fromFile.before).toBe(f.before);
    expect([fromFile.outcome, fromFile.kept, fromFile.proposed]).toEqual(["trial", 2, 2]);
    expect(fromFile.after).toBeLessThan(fromFile.before);
    expect(fromFile.after).toBe(topLevelRecapCount(fromFile.candidate!.recap));
  }, 20_000);
});

// ── T5.3: `--score <dir>`, two draws (R10–R13) ─────────────────────────────────────────────────────────
// Items files built from the §5.3 fixture morning (`fixtures/campaign-morning.ts`, Stage-1 count 9), with
// G1 given a MARKED fact (its two commits in two PRs) so C(ii)'s flag has something to flag. Pure data: no
// git, no provider — `--score` never touches either.

const MARKED_ITEMS: CampaignItem[] = attachPrFacts(buildCampaignItems(MORNING_RECAP, MORNING_COMMITS),
  new Map([[A, { number: 12, branch: "feat/retry" }], [B, { number: 13, branch: "fix/backoff" }]]));
const itemsFile = (date: string, items: CampaignItem[] = MARKED_ITEMS): ItemsFile => ({
  v: 1, date, now: `${date}T07:24:00.000Z`, windowStart: `${date}T00:00:00.000Z`, struct: { ...MORNING_STRUCT, date }, units: [...MORNING_LABELS],
  items, before: 9, busy: { commits: 46, top: 9, busy: true }, prFacts: { merges: 2, read: 2, timedOut: 0, marked: 1, reposUnread: 0 },
});
const D1 = "2026-09-03", D2 = "2026-09-04";
const reply = (...campaigns: { title: string; items: string[] }[]) => JSON.stringify({ campaigns });
const ONE = reply({ title: "retry backoff", items: ["G1", "G2"] });                                             // trial, 9 → 8
const ONE_AND_A_DROP = reply({ title: "retry backoff", items: ["G1", "G2"] }, { title: "backoff retry", items: ["G6", "G7"] });   // 2 proposed, 1 dropped (rule 1)
const NONE = reply();                                                                                          // none, at its before (9)
const GARBAGE = "sure — here are the campaigns";                                                              // rejected, unparseable

/** A score directory: `items` per date, and the reply files given as `{ "<date>": [draw1?, draw2?] }`. */
const scoreDir = (items: ItemsFile[], replies: Record<string, [string | undefined, string | undefined]>): string => {
  const dir = tmp("score");
  for (const f of items) writeFileSync(join(dir, `items-${f.date}.json`), JSON.stringify(f));
  for (const [date, [d1, d2]] of Object.entries(replies)) {
    if (d1 !== undefined) writeFileSync(join(dir, `reply-${date}.json`), d1);
    if (d2 !== undefined) writeFileSync(join(dir, `reply-${date}.d2.json`), d2);
  }
  return dir;
};
const summary = (out: string[]): string[] => out.slice(out.findIndex((l) => l.startsWith("summary (§6.2)")));
/** The morning's items file with `extra` flat top-level lines added: a `none` reply leaves `after` at
 *  `before` = 9 + extra, so a date's contribution to the mean is set exactly. */
const longer = (date: string, extra: number): ItemsFile => {
  const f = itemsFile(date);
  const recap = [...f.struct.recap, ...Array.from({ length: extra }, (_, i) => ({ repo: "personal_code", text: `another flat line ${i}` }))];
  return { ...f, struct: { ...f.struct, recap }, before: 9 + extra };
};

describe("score mode (§5.3 --score, two draws)", () => {
  test("[TB-R10] --score scores each draw with the production checks and prints the per-date report", async () => {
    const dir = scoreDir([itemsFile(D1), itemsFile(D2)], { [D1]: [ONE, NONE], [D2]: [ONE_AND_A_DROP, GARBAGE] });
    const r = await run(["--score", dir]);
    expect(r.code).toBe(0);
    const block = (draw: number, date: string) => { const i = r.out.indexOf(`draw ${draw} · ${date} — reply-${date}${draw === 1 ? "" : ".d2"}.json`); return r.out.slice(i, r.out.indexOf("", i)); };
    expect(block(1, D1)).toEqual([
      `draw 1 · ${D1} — reply-${D1}.json`,
      "  validation: accepted — 1 proposed · 1 kept · 0 dropped",
      "  outcome trial · reason — · before 9 → after 8",
      "  campaign [accountant_ai] \"retry backoff\" — retry backoff — 3 commits · 2 item(s)",
      "    G1 (group)  ⚑ C(ii): absorbed an item marked merged across PRs",
      "      - queue.py retry path reworked — 2 commits",
      "      - queue.py retry path reworked twice",
      "      - retry backoff added",
      "      fact: merged across PRs #12 (feat retry), #13 (fix backoff)",
      "    G2 (single)",
      "      - retry backoff tuned for the queue",
      "      fact: no PR fact",
    ]);
    expect(block(1, D2)).toContain("  validation: accepted — 2 proposed · 1 kept · 1 dropped");
    expect(block(1, D2)).toContain("  dropped \"backoff retry\": title-rule-1");
    expect(block(2, D1)).toEqual([`draw 2 · ${D1} — reply-${D1}.d2.json`, "  validation: accepted — 0 proposed · 0 kept · 0 dropped", "  outcome none · reason — · before 9 → after 9"]);
    expect(block(2, D2)).toEqual([`draw 2 · ${D2} — reply-${D2}.d2.json`, "  validation: whole reply rejected — unparseable", "  outcome rejected · reason unparseable · before 9 → after 9"]);
  });

  test("[TB-R11] the summary: B and C on draw 1; m1, m2, max(m1, m2) ≤ 13; d as information only", async () => {
    // draw 1: 8, 8 → m1 8.00; 0 rejections; 1 dropped of 3 proposed; G1 (marked) absorbed twice.
    // draw 2: a none at its before (9) and a rejection, excluded → m2 9.00; 1 rejection; 0 of 0.
    const dir = scoreDir([itemsFile(D1), itemsFile(D2)], { [D1]: [ONE, NONE], [D2]: [ONE_AND_A_DROP, GARBAGE] });
    const r = await run(["--score", dir]);
    expect(summary(r.out)).toEqual([
      "summary (§6.2) — every outcome from scoreReply, every number from summariseRecapOutcomes",
      "  dates: 2 — NOT the fixed acceptance set (7 of its dates absent, 0 extra)",
      "  draw 1: complete",
      "  draw 2: complete",
      "  A: m1 = 8.00 over 2 date(s) · m2 = 9.00 over 1 date(s) · max(m1, m2) = 9.00 · max(m1, m2) ≤ 13: yes",
      "     d = |m1 − m2| = 1.00 (information only)",
      "  B (draw 1): rejections 0 of 2 · dropped / proposed 1 / 3 (33.3%)",
      "  C (draw 1): absorbed items marked merged across PRs: 2 (⚑ above); the kept campaigns above are for the user's judgement",
    ]);
  });

  test("[TB-R12] an incomplete draw is not scored for A: m and m ≤ 12.0; draw 1 missing → B and C on draw 2, flagged", async () => {
    // draw 2 lacks D2's reply: draw 2 is incomplete, m = draw 1's mean
    const d2gone = await run(["--score", scoreDir([itemsFile(D1), itemsFile(D2)], { [D1]: [ONE, NONE], [D2]: [ONE_AND_A_DROP, undefined] })]);
    expect(summary(d2gone.out).slice(2)).toEqual([
      "  draw 1: complete",
      `  draw 2: incomplete — missing reply-${D2}.d2.json — not scored for A`,
      "  A: m = 8.00 over 2 date(s) (draw 1, the draw that ran) · m ≤ 12.0: yes",
      "  B (draw 1): rejections 0 of 2 · dropped / proposed 1 / 3 (33.3%)",
      "  C (draw 1): absorbed items marked merged across PRs: 2 (⚑ above); the kept campaigns above are for the user's judgement",
    ]);
    // draw 1 lacks D1's reply: m = draw 2's mean, and B and C are draw 2's, flagged
    const d1gone = await run(["--score", scoreDir([itemsFile(D1), itemsFile(D2)], { [D1]: [undefined, NONE], [D2]: [ONE_AND_A_DROP, ONE] })]);
    expect(summary(d1gone.out).slice(2)).toEqual([
      `  draw 1: incomplete — missing reply-${D1}.json — not scored for A`,
      "  draw 2: complete",
      "  A: m = 8.50 over 2 date(s) (draw 2, the draw that ran) · m ≤ 12.0: yes",
      "  B (draw 2 — FLAGGED: draw 1 missing — the user's rule names draw 1): rejections 0 of 2 · dropped / proposed 0 / 1 (0.0%)",
      "  C (draw 2 — FLAGGED: draw 1 missing — the user's rule names draw 1): absorbed items marked merged across PRs: 1 (⚑ above); the kept campaigns above are for the user's judgement",
    ]);
    // the one-draw bar is 12.0, not max(m1, m2)'s 13: a mean in (12, 13] is a "no". Two `none` dates at
    // their before, 12 and 13 top-level lines (the morning's 9 plus 3 / 4 flat lines) → m = 12.50
    expect([topLevelRecapCount(longer(D1, 3).struct.recap), topLevelRecapCount(longer(D2, 4).struct.recap)]).toEqual([12, 13]);
    const over12 = await run(["--score", scoreDir([longer(D1, 3), longer(D2, 4)], { [D1]: [NONE, NONE], [D2]: [NONE, undefined] })]);
    expect(summary(over12.out)[4]).toBe("  A: m = 12.50 over 2 date(s) (draw 1, the draw that ran) · m ≤ 12.0: no");
    // both incomplete: nothing to score
    const both = await run(["--score", scoreDir([itemsFile(D1)], { [D1]: [undefined, undefined] })]);
    expect(summary(both.out).slice(4)).toEqual(["  A: both draws incomplete — nothing to score; the run pauses for the user", "  B, C: no complete draw"]);
  });

  // Harden r1 (C2) — boundary pins only; the bars themselves are unchanged. A mean landing EXACTLY on a
  // bar passes it (spec §6.2 "≤"): both draws at 13.00 → yes; one draw at exactly 12.00 → yes.
  test("the A bars are inclusive: max(m1, m2) exactly 13.00 → yes; one-draw m exactly 12.00 → yes", async () => {
    expect([topLevelRecapCount(longer(D1, 4).struct.recap), topLevelRecapCount(longer(D1, 3).struct.recap)]).toEqual([13, 12]);
    const at13 = await run(["--score", scoreDir([longer(D1, 4), longer(D2, 4)], { [D1]: [NONE, NONE], [D2]: [NONE, NONE] })]);
    expect(summary(at13.out)[4]).toBe("  A: m1 = 13.00 over 2 date(s) · m2 = 13.00 over 2 date(s) · max(m1, m2) = 13.00 · max(m1, m2) ≤ 13: yes");
    const at12 = await run(["--score", scoreDir([longer(D1, 3), longer(D2, 3)], { [D1]: [NONE, NONE], [D2]: [NONE, undefined] })]);
    expect(summary(at12.out)[4]).toBe("  A: m = 12.00 over 2 date(s) (draw 1, the draw that ran) · m ≤ 12.0: yes");
  });

  test("[TB-R13] after is the real candidate's topLevelRecapCount, never before − Σ|items| + kept", async () => {
    // On every items file item mode writes, the arithmetic and the real count agree — so this file is built
    // by hand to part them: G1 covers only entry 0 of its two-entry Stage-1 group. The campaign then leaves
    // entry 1 under the group's own header, and the real candidate counts 8 (1 campaign + the group's
    // leftover + 6 ungrouped); the arithmetic says 9 − 3 + 1 = 7. The live checks all pass, so it is a
    // `trial` date and its `after` feeds the mean.
    const partial = MARKED_ITEMS.map((it) => (it.id === "G1" ? { ...it, entries: [it.entries[0]!] } : it));
    const dir = scoreDir([itemsFile(D1, partial)], { [D1]: [reply({ title: "retry backoff", items: ["G1", "G2", "G7"] }), reply({ title: "retry backoff", items: ["G1", "G2", "G7"] })] });
    const r = await run(["--score", dir]);
    const i = r.out.indexOf(`draw 1 · ${D1} — reply-${D1}.json`);
    expect(r.out[i + 1]).toBe("  validation: accepted — 1 proposed · 1 kept · 0 dropped");
    expect(r.out[i + 2]).toBe("  outcome trial · reason — · before 9 → after 8");
    expect(summary(r.out)).toContain("  A: m1 = 8.00 over 1 date(s) · m2 = 8.00 over 1 date(s) · max(m1, m2) = 8.00 · max(m1, m2) ≤ 13: yes");
  });
});

describe("the dry-run self-test (§5.3 cases 1–21)", () => {
  test("the dry-run self-test passes 21 of 21", () => {
    const p = Bun.spawnSync(["bun", "scripts/recap-campaigns-replay.ts", "--dry-run"], { cwd: PKG, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    // (binding names differ from the script's `LEVEL1.exec(l)`: isolation.meta's spawn scan unions every
    // value a name is given across the file and its helpers, and would read `l` as this spawn's output)
    const got = p.stdout.toString().split("\n").filter(Boolean);
    expect(got.filter((ln) => !ln.startsWith("ok "))).toEqual([]);          // a FAIL line names its case here
    expect(p.exitCode).toBe(0);
    expect(got).toHaveLength(21);
    expect(got.map((ln) => /^ok \[TB-S(\d+)\] \S/.exec(ln)?.[1])).toEqual(Array.from({ length: 21 }, (_, i) => String(i + 1)));
  }, 20_000);
});
