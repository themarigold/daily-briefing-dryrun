// test/merge-foot-collapse.test.ts — the 🔀 foot block of "What you did" collapses to ONE line per
// label (shape S3b, user-directed 2026-09-24), at RENDER time only. Pinned here, in the order they
// matter:
//   1. AUDIT INVARIANCE — the counted checks read the SAME facts off the collapsed page as off the
//      per-merge page. `extractCitedShas` is the one that decided the shape: it mines a paren group
//      only when ≥50% of its comma-separated parts are lone hex tokens, so the SHAs get a trailing
//      group of their own. The fixture is the REAL 2026-09-23 foot block (13 merges, 4 labels), and
//      the assertion is set identity through the real miner, with a negative control that shows the
//      assertion CAN fail (a shape that puts `#N sha` pairs in one group loses every SHA).
//   2. THE SUGGESTION GUARD STILL FIRES — `dropMergedPrSuggestions` (generator.ts) mines PR numbers
//      from `struct.windowMerges[].text` with the literal `/🔀 Merged #(\d+)/g`. Measured: every
//      collapsed shape that reaches the STRUCT breaks that guard silently (the suggestion survives, no
//      warning). So the struct keeps the per-merge texts and only the renderers collapse. The runCore
//      pin below goes red if anyone moves the collapse into core.ts — both halves of it: the struct
//      shape assertion, and the guard assertion that is the actual reason the shape matters.
//   3. THE SHAPE — singular/plural, date range, in-label order, label sort, passthrough, empty.
import "./fixtures/isolate-state";   // A0 — the runCore pin falls back to supportDir() otherwise
import { describe, expect, test } from "bun:test";
import { collapseWindowMerges, renderBriefing } from "../src/render";
import { extractCitedShas, missingSameDay, coverageGaps } from "../src/audit";
import { isShaShaped } from "../src/sha";
import { dropMergedPrSuggestions, generateBriefing } from "../src/generator";
import { runCore } from "../src/core";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import type { BriefingStruct, Config, Provider, ReducedContext } from "../src/types";

/** The 2026-09-23 foot block, verbatim from the archived briefing (13 in-window PR landings, 4 labels,
 *  in the struct's own order — NOT label-sorted, so the sort is exercised too). */
const DAY_67_FOOT: { repo: string; text: string }[] = [
  { repo: "accountant_ai", text: "🔀 Merged #530 (feat/rev17-unnumbered-accounts) (Sep 22)  (ec26492)" },
  { repo: "accountant_ai", text: "🔀 Merged #529 (test/acct-skip-cleanup) (Sep 22)  (07d7142)" },
  { repo: "accountant_ai", text: "🔀 Merged #523 (ci/accountant-ai-ci-speed) (Sep 22)  (b86e054)" },
  { repo: "accountant_ai", text: "🔀 Merged #522 (fix/role-sweep-concurrency) (Sep 22)  (570ea20)" },
  { repo: "daily_briefing_application", text: "🔀 Merged #533 (fix/dba-recap-inline-evidence) (Sep 22)  (e7b732b)" },
  { repo: "daily_briefing_application", text: "🔀 Merged #531 (fix/dba-small-followups) (Sep 22)  (d27d108)" },
  { repo: "daily_briefing_application", text: "🔀 Merged #528 (test/dba-spawn-env-scanner) (Sep 22)  (d1a81fb)" },
  { repo: "daily_briefing_application", text: "🔀 Merged #525 (test/dba-export-public-tmpdir) (Sep 22)  (919fe7b)" },
  { repo: "daily_briefing_application", text: "🔀 Merged #527 (feat/dba-in4-s3-same-day-leg) (Sep 22)  (5859571)" },
  { repo: "daily_briefing_application", text: "🔀 Merged #521 (fix/dba-harden-warning-flag-name) (Sep 22)  (ea83c2b)" },
  { repo: "personal_code", text: "🔀 Merged #526 (ci/accountant-ai-ci-sharding) (Sep 22)  (77165f1)" },
  { repo: "personal_code", text: "🔀 Merged #524 (ci/autolog-skip-state-md) (Sep 22)  (a9f52d7)" },
  { repo: "quant_stocks", text: "🔀 Merged #532 (feat/exp017-stage1-pull-phase2-rulings) (Sep 22)  (186bf46)" },
];
const DAY_67_SHAS = DAY_67_FOOT.map((m) => /\(([0-9a-f]{7})\)$/.exec(m.text)![1]!);

const struct = (over: Partial<BriefingStruct>): BriefingStruct => ({
  date: "2026-09-23", machineScope: "test", provider: "test",
  resume: [], suggestions: [{ text: "s" }],
  recap: [
    { repo: "accountant_ai", text: "landed rev17", evidence: "ec26492" },
    { repo: "daily_briefing_application", text: "fixed inline evidence", evidence: "1234abc, 5678def" },
  ],
  ...over,
});

const footLine = (m: { repo: string; text: string }) => `   • [${m.repo}] ${m.text}`;

/** The page as it rendered BEFORE 2026-09-24: the collapsed foot lines swapped for the per-merge
 *  lines, in the stable label sort the foot always used, at the same position. Everything else on
 *  the page is byte-identical, so a counted-check difference can only come from the foot. */
function beforeAndAfter(b: BriefingStruct): { before: string; after: string } {
  const after = renderBriefing(b);
  const lines = after.split("\n");
  const collapsed = collapseWindowMerges(b.windowMerges ?? [], b.date).map(footLine);
  const at = lines.indexOf(collapsed[0]!);
  expect(at).toBeGreaterThan(-1);
  expect(lines.slice(at, at + collapsed.length)).toEqual(collapsed);   // contiguous block
  const old = [...(b.windowMerges ?? [])].sort((a, z) => a.repo.localeCompare(z.repo, "en")).map(footLine);
  lines.splice(at, collapsed.length, ...old);
  return { before: lines.join("\n"), after };
}

describe("audit invariance — the shape's reason to exist", () => {
  const b = struct({ windowMerges: DAY_67_FOOT });

  test("extractCitedShas mines the IDENTICAL set off the collapsed page and the per-merge page", () => {
    const { before, after } = beforeAndAfter(b);
    const sb = extractCitedShas(before), sa = extractCitedShas(after);
    expect(new Set(sa)).toEqual(new Set(sb));
    expect(sa.length).toBe(sb.length);
    const mined = DAY_67_SHAS.filter(isShaShaped);
    expect(sb.length).toBe(mined.length + 2);
    for (const sha of mined) expect(sa).toContain(sha);
    expect(sa).not.toContain("5859571");
    expect(sb).not.toContain("5859571");
    // The page really did collapse: 13 per-merge lines became 4, and no per-merge text survives.
    expect(after.split("\n").filter((l) => l.includes("🔀 ")).length).toBe(4);
    expect(after).not.toContain("🔀 Merged #");
  });

  // ⚠ NOT COVERAGE — a FIXTURE PROPERTY, and named that way on purpose (cold review 2026-09-24, LOW).
  // Both assertions go red only if someone edits DAY_67_FOOT, never if the collapse breaks. They are
  // kept because they are where the miner's one pre-existing residual is written down: `5859571` is
  // all digits, which `isShaShaped` (src/sha.ts) rejects deliberately, so the real 2026-09-23 foot
  // carries 12 minable SHAs and not 13 — on BOTH pages. The test above depends on that count, so if
  // the fixture changes, this is the line that says so first.
  test("fixture bookkeeping (not a collapse assertion): DAY_67_FOOT carries 12 minable SHAs + 1 all-digit one", () => {
    expect(DAY_67_SHAS.filter(isShaShaped)).toHaveLength(12);
    expect(DAY_67_SHAS.filter((s) => !isShaShaped(s))).toEqual(["5859571"]);
  });

  // ⚠ THE CLAIM IS "NO MERGE SHA IS LOST", NOT "THE MINED SET IS UNCHANGED" (cold review 2026-09-24,
  // MED on the docblock). The collapse deletes the BRANCH NAME from the page, and a branch name is
  // git-supplied text the miner reads. This is the measured difference, pinned so the header above
  // `WINDOW_MERGE_TEXT` cannot drift back to the stronger claim.
  test("a hex-shaped BRANCH NAME is mined before the collapse and not after — the direction is safe, the set is not identical", () => {
    const line = (ms: { repo: string; text: string }[]) => ms.map(footLine).join("\n");
    const hexBranch = [{ repo: "a", text: "🔀 Merged #123 (deadbeef) (Sep 22)  (abc1234)" }];
    expect(extractCitedShas(line(hexBranch))).toEqual(["deadbeef", "abc1234"]);
    expect(extractCitedShas(line(collapseWindowMerges(hexBranch, "2026-09-23")))).toEqual(["abc1234"]);
    // …and a branch that is a ≥50%-hex comma list loses both of its pseudo-SHAs the same way.
    const hexList = [{ repo: "a", text: "🔀 Merged #124 (aaaa111,bbbb222) (Sep 22)  (ccc1234)" }];
    expect(extractCitedShas(line(hexList))).toEqual(["aaaa111", "bbbb222", "ccc1234"]);
    expect(extractCitedShas(line(collapseWindowMerges(hexList, "2026-09-23")))).toEqual(["ccc1234"]);
  });

  test("negative control (prove-it 3b): a shape that pairs `#N sha` inside one group LOSES the SHAs — the assertion can fail", () => {
    const { before } = beforeAndAfter(b);
    const paired = renderBriefing(struct({
      windowMerges: [{ repo: "x", text: `🔀 13 PRs merged (${DAY_67_FOOT.map((m, i) => `#${520 + i} ${DAY_67_SHAS[i]}`).join(", ")}) (Sep 22)` }],
    }));
    expect(extractCitedShas(paired).length).toBe(3);         // only the recap evidence survives
    expect(new Set(extractCitedShas(paired))).not.toEqual(new Set(extractCitedShas(before)));
  });

  test("missingSameDay reads every merge SHA as present on both pages, and a control SHA as missing on both", () => {
    const { before, after } = beforeAndAfter(b);
    expect(missingSameDay(DAY_67_SHAS, before)).toEqual([]);
    expect(missingSameDay(DAY_67_SHAS, after)).toEqual([]);
    expect(missingSameDay(["ffff999"], before)).toEqual(["ffff999"]);
    expect(missingSameDay(["ffff999"], after)).toEqual(["ffff999"]);
  });

  test("coverageGaps: every label the foot names still covers its repo; the same control gap fires on both pages", () => {
    const { before, after } = beforeAndAfter(struct({ recap: [], windowMerges: DAY_67_FOOT }));
    const repos = [...new Set(DAY_67_FOOT.map((m) => m.repo)), "unnamed_repo"].map((l) => ({ repo: `/w/${l}`, labels: [l] }));
    expect(coverageGaps(repos, before).map((g) => g.repo)).toEqual(["/w/unnamed_repo"]);
    expect(coverageGaps(repos, after).map((g) => g.repo)).toEqual(["/w/unnamed_repo"]);
  });
});

describe("the suggestion guard still fires — the collapse is render-time ONLY", () => {
  test("struct level: the per-merge texts reach dropMergedPrSuggestions while the page shows the collapsed line", () => {
    const b = struct({ windowMerges: DAY_67_FOOT });
    const page = renderBriefing(b);
    expect(page).toContain("   • [daily_briefing_application] 🔀 6 PRs merged (#533, #531, #528, #525, #527, #521) (Sep 22)  (e7b732b, d27d108, d1a81fb, 919fe7b, 5859571, ea83c2b)");
    const r = dropMergedPrSuggestions([{ text: "merge #531 once CI is green" }, { text: "add tests" }], [...(b.today ?? []), ...(b.windowMerges ?? [])]);
    expect(r.kept.map((s) => s.text)).toEqual(["add tests"]);
    expect(r.droppedPrs).toEqual(["531"]);
    // …and the SAME predicate over the RENDERED foot texts finds nothing — which is exactly why the
    // struct must never carry the collapsed shape.
    expect(dropMergedPrSuggestions([{ text: "merge #531" }], collapseWindowMerges(b.windowMerges ?? [], b.date)).kept).toHaveLength(1);
  });

  // ⚠ THE OTHER HALF OF "RENDER-TIME ONLY", AND NOTHING PINNED IT UNTIL NOW (cold review 2026-09-24,
  // MED). `renderBriefing` hands `collapseWindowMerges` the caller's own `struct.windowMerges` array,
  // so a `merges.sort(…)` in place of `[...merges].sort(…)` reorders the STRUCT as a side effect of
  // rendering it — the value `dropMergedPrSuggestions` and the `run --json` envelope read. The page is
  // byte-identical either way and the sort is idempotent, so no other assertion in this file, and no
  // GUI parity check, can see it. Mutation-confirmed: with `[...merges]` removed from BOTH copies the
  // engine suite and the GUI web suite both stayed green.
  // ⚠ ITS INPUT IS A LOCAL LITERAL, NOT `DAY_67_FOOT`. A shared fixture handed to an earlier test in
  // the same file would be SORTED IN PLACE by the very mutation this exists to kill, and every later
  // reader would then see an already-sorted array and go green. (Measured on this file's GUI sibling,
  // where the first draft did exactly that.) Labels here are deliberately out of sort order.
  test("rendering does not touch the struct: windowMerges is deep-identical across a render (and a re-render)", () => {
    const b = struct({ windowMerges: [
      { repo: "zeta", text: "🔀 Merged #2 (b) (Sep 22)  (bbbb222)" },
      { repo: "alpha", text: "🔀 Merged #1 (a) (Sep 21)  (aaaa111)" },
      { repo: "zeta", text: "🔀 Merged #3 (c) (Sep 22)  (cccc333)" },
    ] });
    const snapshot = JSON.parse(JSON.stringify(b.windowMerges));
    renderBriefing(b);
    expect(b.windowMerges).toEqual(snapshot);
    renderBriefing(b);
    expect(b.windowMerges).toEqual(snapshot);
    // The array IDENTITY is the caller's too — an in-place sort would keep it and still be wrong, so
    // the assertion above is the load-bearing one; this only says nothing was swapped underneath.
    const unsorted = [{ repo: "zeta", text: "x" }, { repo: "alpha", text: "y" }];
    collapseWindowMerges(unsorted, "2026-09-23");
    expect(unsorted.map((m) => m.repo)).toEqual(["zeta", "alpha"]);
  });

  test("generateBriefing level: a suggestion naming a merged PR is dropped and warned, given per-merge struct texts", async () => {
    const stub: Provider = { generate: async () => "## RESUME\n- [/r1] resume\n## RECAP\n- [/r1] did work | evidence: a1b2c3\n## SUGGESTIONS\n- review and merge #531\n- add tests" };
    const b = await generateBriefing({ repos: [] } as ReducedContext, stub, {
      date: "2026-09-23", machineScope: "host", provider: "claude", windowMerges: DAY_67_FOOT,
    }, []);
    expect(b.suggestions.map((s) => s.text)).toEqual(["add tests"]);
    expect((b.warnings ?? []).some((w) => w.includes("already-merged PR") && w.includes("#531"))).toBe(true);
    expect(renderBriefing(b)).not.toContain("🔀 Merged #");
  });

  // ⚠ THE PIN THAT GOES RED IF THE COLLAPSE MOVES INTO core.ts. Real repo, two real PR merges in the
  // window, the real pipeline. Assertion order is deliberate: the GUARD first — that is the harm —
  // then the struct shape that protects it, then the rendered page.
  test("runCore: two in-window PR merges → the guard drops a suggestion naming one, the struct carries per-merge texts, the page carries ONE collapsed line", async () => {
    const yesterday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
    const plus = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3600e3).toISOString();
    const dir = await buildRepo([{ file: "w.ts", content: "x", isoDate: yesterday() }]);
    await branchCommit(dir, "feat-a", "a.txt", yesterday());
    await mergeBranchWith(dir, "feat-a", "Merge pull request #7 from o/feat/a", plus(yesterday(), 1));
    await branchCommit(dir, "feat-b", "b.txt", plus(yesterday(), 2));
    await mergeBranchWith(dir, "feat-b", "Merge pull request #8 from o/feat/b", plus(yesterday(), 3));
    const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30, provider: { cli: "echo", argv: [], promptVia: "stdin" } };
    const stub: Provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] c | evidence: HEAD\n## SUGGESTIONS\n- merge #7 once CI is green\n- add tests for w.ts" };
    const r = await runCore(cfg, { provider: stub, netProbe: async () => true });

    // 1. The guard: "#7" is merged in this window, so the suggestion naming it must be gone and warned.
    expect(r.struct.suggestions.map((s) => s.text)).toEqual(["add tests for w.ts"]);
    expect((r.struct.warnings ?? []).some((w) => w.includes("already-merged PR") && w.includes("#7"))).toBe(true);
    // 2. The struct: two entries, each in the per-merge shape the guard's regex reads.
    const wm = r.struct.windowMerges ?? [];
    expect(wm).toHaveLength(2);
    // (`listPrMerges` strips the `o/` owner from the GitHub subject, so the branch renders bare.)
    for (const m of wm) expect(m.text).toMatch(/^🔀 Merged #[78] \(feat\/[ab]\) \([A-Z][a-z]{2} \d{1,2}\)  \([0-9a-f]{7}\)$/);
    // 3. The page: ONE foot line for the repo, both PRs and both SHAs, the per-merge shape nowhere.
    const page = renderBriefing(r.struct);
    expect(page).toMatch(/^   • \[[^\]]+\] 🔀 2 PRs merged \(#[78], #[78]\) \([A-Z][a-z]{2} \d{1,2}\)  \([0-9a-f]{7}, [0-9a-f]{7}\)$/m);
    expect(page).not.toContain("🔀 Merged #");
    // …and the audit still mines both merge SHAs off that one line.
    const cited = extractCitedShas(page);
    for (const m of wm) expect(cited).toContain(/\(([0-9a-f]{7})\)$/.exec(m.text)![1]!);
  });
});

describe("collapseWindowMerges — the shape", () => {
  // The second argument is the briefing's own date (`struct.date`) — the year the `Mon D` tags lack.
  const RUN = "2026-09-23";

  test("one line per label; labels in the stable sort; within a label the struct's order, for PRs and SHAs alike", () => {
    expect(collapseWindowMerges(DAY_67_FOOT, RUN)).toEqual([
      { repo: "accountant_ai", text: "🔀 4 PRs merged (#530, #529, #523, #522) (Sep 22)  (ec26492, 07d7142, b86e054, 570ea20)" },
      { repo: "daily_briefing_application", text: "🔀 6 PRs merged (#533, #531, #528, #525, #527, #521) (Sep 22)  (e7b732b, d27d108, d1a81fb, 919fe7b, 5859571, ea83c2b)" },
      { repo: "personal_code", text: "🔀 2 PRs merged (#526, #524) (Sep 22)  (77165f1, a9f52d7)" },
      { repo: "quant_stocks", text: "🔀 1 PR merged (#532) (Sep 22)  (186bf46)" },
    ]);
  });

  test("a single merge under a label collapses to the same shape, singular — never the old per-merge form", () => {
    expect(collapseWindowMerges([{ repo: "a", text: "🔀 Merged #533 (fix/x) (Sep 22)  (e7b732b)" }], RUN))
      .toEqual([{ repo: "a", text: "🔀 1 PR merged (#533) (Sep 22)  (e7b732b)" }]);
  });

  test("date range is chronological over the label's own dates, not line order; one distinct date renders alone", () => {
    const out = collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #2 (b) (Sep 22)  (bbbb222)" },
      { repo: "a", text: "🔀 Merged #1 (a) (Sep 21)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #3 (c) (Sep 22)  (cccc333)" },
    ], RUN);
    expect(out[0]!.text).toBe("🔀 3 PRs merged (#2, #1, #3) (Sep 21–Sep 22)  (bbbb222, aaaa111, cccc333)");
    // Interleaved labels: the sort is by label, and the in-label order is the struct's.
    const two = collapseWindowMerges([
      { repo: "zeta", text: "🔀 Merged #2 (b) (Aug 19)  (bbbb222)" },
      { repo: "alpha", text: "🔀 Merged #1 (a) (Aug 18)  (aaaa111)" },
      { repo: "zeta", text: "🔀 Merged #3 (c) (Aug 20)  (cccc333)" },
    ], RUN);
    expect(two).toEqual([
      { repo: "alpha", text: "🔀 1 PR merged (#1) (Aug 18)  (aaaa111)" },
      { repo: "zeta", text: "🔀 2 PRs merged (#2, #3) (Aug 19–Aug 20)  (bbbb222, cccc333)" },
    ]);
  });

  // ── The year the `Mon D` tags do not carry. Both directions are pinned, which is what kills the
  // mutation: "never wrap" fails the Dec→Jan cases, "always wrap" fails the wide-window ones.
  test("a Dec→Jan window orders the year wrap correctly, off the briefing's own date", () => {
    const wrap = [
      { repo: "a", text: "🔀 Merged #1 (a) (Jan 2)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #2 (b) (Dec 30)  (bbbb222)" },
    ];
    expect(collapseWindowMerges(wrap, "2027-01-05")[0]!.text)
      .toBe("🔀 2 PRs merged (#1, #2) (Dec 30–Jan 2)  (aaaa111, bbbb222)");
    // …and a November→January window wraps too, though it contains neither a Dec nor a same-month
    // pair — the anchor answers it, a "does the set contain both Dec and Jan" rule would not.
    expect(collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #1 (a) (Nov 20)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #2 (b) (Jan 5)  (bbbb222)" },
    ], "2027-01-06")[0]!.text).toBe("🔀 2 PRs merged (#1, #2) (Nov 20–Jan 5)  (aaaa111, bbbb222)");
  });

  // Two boundary pins the cold verify (2026-09-24) found UNCOVERED by mutation: `o > anchor` survived
  // the engine suite as `>=` because no case dated a merge ON the run date, and `- 372` survived as
  // `- 371` because no case sat on both ends of the wrap. The values below are the correct ones; these
  // exist so a change to either is not silent.
  test("a merge dated ON the run date is this year, not last (pins `>`, not `>=`)", () => {
    // `>=` would push Sep 24 back a year and render the span inverted as (Sep 24–Sep 22).
    expect(collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #1 (a) (Sep 22)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #2 (b) (Sep 24)  (bbbb222)" },
    ], "2026-09-24")[0]!.text).toBe("🔀 2 PRs merged (#1, #2) (Sep 22–Sep 24)  (aaaa111, bbbb222)");
  });

  test("Dec 31 and Jan 1 are two dates, not one (pins the 372 wrap constant)", () => {
    // Max ordinal is Dec 31 = 372, min is Jan 1 = 1, so 372 is the minimal correct shift. With 371,
    // Dec 31 lands exactly on Jan 1's ordinal, first === last, and the span silently loses a date.
    expect(collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #1 (a) (Dec 31)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #2 (b) (Jan 1)  (bbbb222)" },
    ], "2027-01-05")[0]!.text).toBe("🔀 2 PRs merged (#1, #2) (Dec 31–Jan 1)  (aaaa111, bbbb222)");
  });

  // ⚠ THE REGRESSION. `lookbackCapDays` is validated as nothing more than a finite number
  // (config.ts), so a window wider than half a year is reachable, and the old ordinal heuristic
  // ("a span > 186 can only be Dec→Jan") REVERSED it: `[(Mar 1), (Oct 15)]` rendered
  // `(Oct 15–Mar 1)`. Mutation-confirmed: with the heuristic in place — and with the wrap made
  // unconditional, the reviewer's second surviving mutation — this case goes red.
  test("a window WIDER than half a year is NOT a year wrap: the range stays in calendar order", () => {
    expect(collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #1 (x) (Mar 1)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #2 (y) (Oct 15)  (bbbb222)" },
    ], "2026-10-20")[0]!.text).toBe("🔀 2 PRs merged (#1, #2) (Mar 1–Oct 15)  (aaaa111, bbbb222)");
    // Jan–Jun mixed with Jul–Dec, the full-year edge: Jan 3 → Dec 28 under a late-December run date.
    expect(collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #1 (x) (Dec 28)  (bbbb222)" },
      { repo: "a", text: "🔀 Merged #2 (y) (Jan 3)  (aaaa111)" },
    ], "2026-12-31")[0]!.text).toBe("🔀 2 PRs merged (#1, #2) (Jan 3–Dec 28)  (bbbb222, aaaa111)");
  });

  test("an undated merge (no parseable timestamp in core.ts) contributes no date; all undated → no date group", () => {
    expect(collapseWindowMerges([
      { repo: "a", text: "🔀 Merged #1 (a)  (aaaa111)" },
      { repo: "a", text: "🔀 Merged #2 (b) (Sep 22)  (bbbb222)" },
    ], RUN)[0]!.text).toBe("🔀 2 PRs merged (#1, #2) (Sep 22)  (aaaa111, bbbb222)");
    expect(collapseWindowMerges([{ repo: "a", text: "🔀 Merged #1 (a)  (aaaa111)" }], RUN)[0]!.text)
      .toBe("🔀 1 PR merged (#1)  (aaaa111)");
  });

  test("git allows parentheses in a ref name: the space-free branch group still finds the date and the SHA", () => {
    expect(collapseWindowMerges([{ repo: "a", text: "🔀 Merged #5 (fix/(paren)) (Sep 22)  (abc1234)" }], RUN)[0]!.text)
      .toBe("🔀 1 PR merged (#5) (Sep 22)  (abc1234)");
  });

  // ⚠ REACHABLE, not hypothetical: `listPrMerges` captures the branch with `(\S+)` and strips the
  // leading owner segment, so a subject ending `from owner/` yields `branch === ""` and core.ts emits
  // `🔀 Merged #3 () (Sep 22)  (ccc1234)`. Under the pre-2026-09-24 `(.+?)` group the branch group
  // SWALLOWED the date tag — the line parsed, and rendered `🔀 1 PR merged (#3)  (ccc1234)` with the
  // date silently gone (cold review 2026-09-24, MED). Both halves are pinned here.
  test("an empty branch group keeps its date; a branch with a SPACE in it cannot parse, so it passes through", () => {
    expect(collapseWindowMerges([{ repo: "a", text: "🔀 Merged #3 () (Sep 22)  (ccc1234)" }], RUN)[0]!.text)
      .toBe("🔀 1 PR merged (#3) (Sep 22)  (ccc1234)");
    // A ref name can never contain a space (git.ts's `(\S+)`), so this shape is not something the
    // pipeline can build — and it is re-emitted verbatim rather than parsed into a wrong line.
    const bogus = "🔀 Merged #4 (a) b (Sep 22)  (ddd1234)";
    expect(collapseWindowMerges([{ repo: "a", text: bogus }], RUN)).toEqual([{ repo: "a", text: bogus }]);
  });

  // ⚠ `norm(label)` IS THE GROUPING KEY, not the raw string (cold review 2026-09-24, MED). Foot labels
  // are code-built today so this is not reachable from `core.ts`, but the label became a GROUPING key
  // on 2026-09-24 and every other label consumer — the recap-cluster key in this same renderer,
  // `coverageGaps`, `whyFor` — already keys on `norm`.
  test("labels that differ only by norm collapse into ONE line, rendered under the struct's first spelling", () => {
    expect(collapseWindowMerges([
      { repo: "Mono", text: "🔀 Merged #1 (x) (Sep 22)  (aaaa111)" },
      { repo: "mono", text: "🔀 Merged #2 (y) (Sep 22)  (bbbb222)" },
      { repo: "mono.", text: "🔀 Merged #3 (z) (Sep 22)  (cccc333)" },
    ], RUN)).toEqual([
      { repo: "Mono", text: "🔀 3 PRs merged (#1, #2, #3) (Sep 22)  (aaaa111, bbbb222, cccc333)" },
    ]);
  });

  test("a text this cannot parse passes through unchanged under its label, after the collapsed line; nothing is dropped", () => {
    expect(collapseWindowMerges([
      { repo: "z", text: "Merged #1 (feat/x)" },
      { repo: "z", text: "🔀 Merged #9 (b) (Aug 1)  (1111aaa)" },
      { repo: "a", text: "some older shape" },
    ], RUN)).toEqual([
      { repo: "a", text: "some older shape" },
      { repo: "z", text: "🔀 1 PR merged (#9) (Aug 1)  (1111aaa)" },
      { repo: "z", text: "Merged #1 (feat/x)" },
    ]);
  });

  test("empty block renders nothing, exactly as before", () => {
    expect(collapseWindowMerges([], RUN)).toEqual([]);
    const page = renderBriefing(struct({ windowMerges: [] }));
    expect(page).not.toContain("🔀");
    expect(page).toBe(renderBriefing(struct({})));
  });

  test("the 'Today so far' 🔀 lines are NOT collapsed — only the window foot is", () => {
    const page = renderBriefing(struct({
      today: [{ repo: "a", text: "🔀 Merged #9 (feat/t) (abc1234)" }, { repo: "a", text: "🔀 Merged #10 (feat/u) (def5678)" }],
      windowMerges: [{ repo: "a", text: "🔀 Merged #1 (x) (Sep 22)  (aaaa111)" }],
    }));
    expect(page).toContain("   • [a] 🔀 Merged #9 (feat/t) (abc1234)");
    expect(page).toContain("   • [a] 🔀 Merged #10 (feat/u) (def5678)");
    expect(page).toContain("   • [a] 🔀 1 PR merged (#1) (Sep 22)  (aaaa111)");
  });
});
