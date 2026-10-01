// test/recap-campaigns.report.test.ts — tier B, T5.1: the trial record's reader (spec §4.10 3, D1 + addendum,
// D9 addendum) and `summariseRecapOutcomes`, the ONE summariser the replay's `--score` also uses. P15 plus the
// plan's five exact titles.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { summariseRecapOutcomes, type RecapSummaryRow } from "../src/recapCampaigns";
import { main, readRecordFiles, buildReport } from "../scripts/recap-campaigns-report";

const FIXTURE = join(import.meta.dir, "fixtures", "recap-campaigns.p15.jsonl");
const PKG = join(import.meta.dir, "..");

const run = async (files: string[]): Promise<{ code: number; lines: string[] }> => {
  const lines: string[] = [];
  const code = await main(files, (l) => lines.push(l));
  return { code, lines };
};
const summaryOf = (lines: string[]): string[] => lines.slice(lines.findIndex((l) => l.startsWith("summary — ")));

/** A summary row; `kept` rides along as on a real record/ScoreResult, so a summariser that read it where it
 *  should read `proposed` would see real numbers, not `undefined`. */
const row = (outcome: string, before: number, after: number, proposed = 0, dropped = 0, reason: string | null = null, kept = 0): RecapSummaryRow & { kept: number } =>
  ({ outcome, reason, before, after, proposed, kept, dropped: Array.from({ length: dropped }, () => ({})) });

describe("the reader (§4.10 3)", () => {
  test("[TB-P15] the reader uses the LAST gate-fired line per date, reports the other two, and prints the §6.2 summary exactly", async () => {
    const { code, lines } = await run([FIXTURE]);
    expect(code).toBe(0);
    // the chosen line is the later gate-fired one (the forced terminal run), not the scheduled one, and not
    // the physically last line (a `skipped` line whose gate was never evaluated)
    expect(lines).toContain(`2026-09-24 — gated: line ${FIXTURE}:2 (the last gate-fired line of 3 for this date)`);
    expect(lines).toContain("  mode trial · outcome trial · reason — · before 18 → after 14");
    expect(lines).toContain("  prFacts: merges 8 · read 7 · timedOut 1 · marked 1 · reposUnread 1");
    // the other two lines, never silently dropped: count, invoker, json, forced, outcome
    expect(lines).toContain("  other lines for this date: 2");
    expect(lines).toContain(`    ${FIXTURE}:1: invoker scheduled · json false · forced false · outcome none · gate fired (commits 46, top 18)`);
    expect(lines).toContain(`    ${FIXTURE}:3: invoker cli · json true · forced false · outcome skipped (no-grouper) · gate not evaluated`);
    // members, PR facts, and the C(ii) flag on the absorbed marked item only
    expect(lines.filter((l) => l.includes("⚑ C(ii)"))).toEqual(["    G1 (group) memory/provenance.py — 2 commits  ⚑ C(ii): absorbed an item marked merged across PRs"]);
    expect(lines).toContain("      fact: merged across PRs #431 (feat acct provenance), #433 (fix replay)");
    // the §6.2 summary numbers, exactly. The share is the LARGEST campaign (3 items) over ITS label's
    // `offered` (9, from labels[] on the labelKey) — not over the kept items (5), and not the largest share
    // (quant_stocks' 2 of 4). Line 1 (the EARLIER gate-fired line) offers accountant_ai 12, so a share
    // joined on any line but the chosen one would print 25.0% (3 of 12).
    expect(summaryOf(lines)).toEqual([
      "summary — over the chosen line of each gated date",
      "  gated dates: 1",
      "  outcomes: applied 0 · trial 1 · none 0 · rejected 0",
      "  mean after (applied/trial/none, a none at its before): 14.00 over 1 date(s)",
      "  rejections: 0",
      "  dropped / proposed: 1 / 4 (25.0%)",
      "  absorbed items marked merged across PRs (C(ii)): 1",
      "  page-length delta (Σ kept campaigns): +3",
      "  largest campaign's share of its label's items: 33.3% (2026-09-24 [accountant_ai] \"answer provenance\", 3 of 9)",
      "  latency: mean 9000 ms · max 9000 ms",
      "  prFacts: timedOut total 1 · reposUnread total 1 · dates with reposUnread > 0: 1",
    ]);
  });

  // Harden r1 (C3): the cross-date aggregates need a SECOND gated date to bind (on one date the largest
  // share is the only share, and the latency mean is the max). P15's fixture plus a small second record
  // file: 2026-09-25, a LARGER largest-campaign share (3 of 4 = 75.0% vs 33.3%), latency 3000 ms (vs
  // 9000), reposUnread 0 (vs 1). P15's own expectations are untouched.
  test("across two gated dates: the larger share wins, latency is the mean, reposUnread totals and counts dates", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb51-report-")));
    const second = join(dir, "recap-campaigns.jsonl");
    const items = ["G1", "G2", "G3"].map((id, i) => ({ id, kind: "single", bullets: [`sharpe ratio guard step ${i}`], prFact: "no PR fact" }));
    writeFileSync(second, JSON.stringify({
      v: 2, date: "2026-09-25", mode: "trial", invoker: "scheduled", json: false, forced: false, gate: { fired: true, commits: 41, top: 15 },
      outcome: "trial", reason: null, before: 15, after: 13, proposed: 1, kept: 1, dropped: [], latencyMs: 3000, gitMs: 200,
      prFacts: { merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 0 }, hardening: "on", providerWarnings: [],
      labels: [{ label: "quant_stocks", offered: 4 }],
      campaigns: [{ label: "quant_stocks", title: "sharpe ratio guard", header: "sharpe ratio guard — 3 commits", commits: 3, items }],
    }) + "\n");
    const { code, lines } = await run([FIXTURE, second]);
    expect(code).toBe(0);
    expect(lines).toContain(`2026-09-25 — gated: line ${second}:1 (the last gate-fired line of 1 for this date)`);
    const sum = summaryOf(lines);
    expect(sum[1]).toBe("  gated dates: 2");
    expect(sum).toContain("  largest campaign's share of its label's items: 75.0% (2026-09-25 [quant_stocks] \"sharpe ratio guard\", 3 of 4)");
    expect(sum).toContain("  latency: mean 6000 ms · max 9000 ms");
    expect(sum).toContain("  prFacts: timedOut total 1 · reposUnread total 1 · dates with reposUnread > 0: 1");
  });

  test("a date with no gate-fired line is not a gated morning", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb51-report-")));
    const file = join(dir, "recap-campaigns.jsonl");
    const base = { v: 2, mode: "trial", invoker: "scheduled", json: false, forced: false, reason: "gate", before: 6, after: 6, proposed: 0, kept: 0, dropped: [], latencyMs: 4, gitMs: 0, hardening: "n/a", providerWarnings: [] };
    writeFileSync(file, [
      { ...base, date: "2026-09-25", gate: { fired: false, commits: 12, top: 6 }, outcome: "skipped" },
      { ...base, date: "2026-09-25", gate: null, outcome: "skipped", reason: "no-grouper" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { code, lines } = await run([file]);
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith("2026-09-25 — gated"))).toBe(false);
    expect(lines).toContain("  2026-09-25: 2 line(s), none gate-fired — skipped/gate, skipped/no-grouper");
    expect(summaryOf(lines).slice(1, 4)).toEqual([
      "  gated dates: 0",
      "  outcomes: applied 0 · trial 0 · none 0 · rejected 0",
      "  mean after (applied/trial/none, a none at its before): n/a over 0 date(s)",
    ]);
  });

  test("a missing record file reads as empty", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb51-report-")));
    const gone = join(dir, "recap-campaigns.jsonl");
    const read = await readRecordFiles([gone]);
    expect(read).toEqual({ lines: [], missing: [gone], problems: [] });
    const { code, lines } = await run([gone]);
    expect(code).toBe(0);
    expect(lines).toContain(`  ${gone}: missing — read as empty`);
    expect(lines).toContain("  gated dates: 0");
    // the default path (the isolated state dir's record, which no test writes), through the real CLI
    const p = Bun.spawnSync(["bun", "scripts/recap-campaigns-report.ts"], { cwd: PKG, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toMatch(/recap-campaigns\.jsonl: missing — read as empty/);
    expect(p.stdout.toString()).toContain("  gated dates: 0");
  });

  test("a record line without prFacts or labels is reported, never a crash", async () => {
    const read = await readRecordFiles([FIXTURE]);
    const third = read.lines[2]!.record;
    expect(third.prFacts).toBeUndefined();
    // make it the chosen line of its own date: gate fired, rejected on an exception before the git reads
    const r = { ...third, date: "2026-09-26", gate: { fired: true, commits: 50, top: 20 }, outcome: "rejected" as const, reason: "exception" };
    const report = buildReport({ lines: [{ file: "x", line: 1, record: r }], missing: [], problems: [] }, ["x"]);
    expect(report.text).toContain("  prFacts: absent on this line (no git read returned)");
    expect(report.text).toContain("  largest campaign's share of its label's items: n/a");
    expect(report.text).toContain("  prFacts: timedOut total 0 · reposUnread total 0 · dates with reposUnread > 0: 0 · lines without prFacts: 1");
    expect(report.summary.rejections).toBe(1);
  });
});

describe("summariseRecapOutcomes (§6.2 A and B — the ONE summariser)", () => {
  test("summariseRecapOutcomes counts a none at its before in the mean after", () => {
    // a `none` row carries after === before on a real record; give it a DIFFERENT after here so the rule
    // (the `before`) is what is pinned, not a coincidence of the input
    const s = summariseRecapOutcomes([row("trial", 18, 12), row("none", 20, 99), row("applied", 16, 10)]);
    expect(s.meanAfter).toBe((12 + 20 + 10) / 3);
    expect(s.meanAfterOver).toBe(3);
    expect(s.outcomes).toEqual({ applied: 1, trial: 1, none: 1, rejected: 0, skipped: 0 });
  });

  test("summariseRecapOutcomes excludes rejected dates from the mean and counts them as rejections", () => {
    const s = summariseRecapOutcomes([
      row("trial", 18, 12), row("rejected", 30, 30, 0, 0, "unparseable"), row("rejected", 24, 20, 2, 0, "live-check-e"),
      row("none", 14, 14), row("rejected", 22, 22, 0, 0, "unparseable"),
    ]);
    expect(s.meanAfter).toBe((12 + 14) / 2);
    expect(s.meanAfterOver).toBe(2);
    expect(s.rejections).toBe(3);
    expect(s.rejectionReasons).toEqual({ unparseable: 2, "live-check-e": 1 });
    expect(summariseRecapOutcomes([row("rejected", 30, 30, 0, 0, "schema")]).meanAfter).toBeNull();
  });

  test("summariseRecapOutcomes computes dropped/proposed from proposed, not kept", () => {
    // proposed 4 + 3 + 2 = 9, kept 1 + 3 + 0 = 4, dropped 3 + 0 + 2 = 5 → 5 / 9, never 5 / 4
    const s = summariseRecapOutcomes([row("trial", 18, 15, 4, 3, null, 1), row("trial", 20, 15, 3, 0, null, 3), row("none", 12, 12, 2, 2, null, 0)]);
    expect([s.dropped, s.proposed]).toEqual([5, 9]);
    expect(s.droppedShare).toBe(5 / 9);
    expect(summariseRecapOutcomes([row("none", 12, 12)]).droppedShare).toBeNull();
  });
});
