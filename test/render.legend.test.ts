// test/render.legend.test.ts — the SUB-PROJECT LABEL LEGEND (judge days 41, 43, 44).
//
// The defect: a sub-project label is the root's BASENAME, so `[accountant_ai]` and `[personal_code]`
// render as peers while the first is a FOLDER INSIDE the second. Day 44: "[personal_code] no window
// work pending" read as repo-idle while 36 commits landed in that repo under sibling labels.
import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
import { test, expect } from "bun:test";
import { renderBriefing, LEGEND_LABEL_CAP } from "../src/render";
import { subprojectLegend, resolveUnits, LEGEND_PREFIX, type Unit } from "../src/subprojects";
import { coverageGaps } from "../src/audit";
import { runCore } from "../src/core";
import { buildRepo } from "./fixtures/build-repo";
import type { BriefingStruct, Config } from "../src/types";

const base: BriefingStruct = {
  date: "2026-08-29", machineScope: "mymac", provider: "claude",
  resume: [], recap: [], suggestions: [],
};

const unit = (repo: string, root: string | null, label: string): Unit => ({
  repo, root, label,
  hasResumptionState: false, hasWindowContent: true, resumptionNote: "",
  dirtyFiles: [], latestCommitTime: null,
});

const legendLine = (out: string) => out.split("\n").find((l) => l.startsWith(LEGEND_PREFIX));

test("legend renders one line under the header when a subprojects mapping is present", () => {
  const out = renderBriefing({
    ...base,
    labelLegend: [{ repo: "personal_code", labels: ["accountant_ai", "ai_news", "daily_briefing"] }],
  });
  expect(out).toContain("(labels: accountant_ai, ai_news, daily_briefing are areas of repo personal_code)");
  // ONE line, not a block.
  expect(out.split("\n").filter((l) => l.includes("(labels:"))).toHaveLength(1);
  // ABOVE the section it frames — a legend printed after the labels it explains arrives too late.
  const lines = out.split("\n");
  expect(lines.findIndex((l) => l.includes("(labels:"))).toBeLessThan(
    lines.findIndex((l) => l.includes("Where you left off")));
});

test("legend groups per parent repo when TWO repos have subprojects, still one line", () => {
  const out = renderBriefing({
    ...base,
    labelLegend: [
      { repo: "personal_code", labels: ["accountant_ai", "ai_news"] },
      { repo: "workspace", labels: ["api"] },
    ],
  });
  expect(legendLine(out)).toBe("   (labels: accountant_ai, ai_news are areas of repo personal_code; api is an area of repo workspace)");
});

test("NO legend, and byte-identical output, when there is no subprojects mapping", () => {
  // The common OSS install: one repo, one catch-all unit, no `subprojects` config.
  const withField = renderBriefing({ ...base, resume: [{ repo: "app", text: "resume auth" }] });
  const withoutField = renderBriefing({
    ...base, resume: [{ repo: "app", text: "resume auth" }], labelLegend: [],
  });
  expect(withField).not.toContain("(labels:");
  expect(withField).not.toContain("are areas of repo");
  // Absent field and an empty array must both render the SAME bytes as before this feature existed.
  expect(withoutField).toBe(withField);
});

test("a group with an empty label list contributes nothing (and cannot emit a bare legend line)", () => {
  const out = renderBriefing({ ...base, labelLegend: [{ repo: "personal_code", labels: [] }] });
  expect(out).not.toContain("(labels:");
});

// ── L1: the line is CAPPED. Measured: 40 sub-projects rendered a 704-char single line. ───────────
test("legend caps the labels listed per repo and reports the remainder (L1)", () => {
  const many = Array.from({ length: 40 }, (_, i) => `sub${String(i).padStart(2, "0")}`);
  const out = renderBriefing({ ...base, labelLegend: [{ repo: "personal_code", labels: many }] });
  const line = legendLine(out)!;
  expect(line).toContain(`(+${40 - LEGEND_LABEL_CAP} more)`);
  expect(line).toContain("sub00");
  expect(line).not.toContain(`sub${String(LEGEND_LABEL_CAP).padStart(2, "0")}`); // the first one past the cap
  // The whole point of the cap: the line stays readable rather than becoming a 704-char wall.
  expect(line.length).toBeLessThan(200);
  // Plurality follows the TRUE count, not the shown count.
  expect(line).toContain("are areas of repo personal_code");
});

test("legend cap: a group at or under the cap gets no '+N more' tail", () => {
  const labels = Array.from({ length: LEGEND_LABEL_CAP }, (_, i) => `s${i}`);
  const line = legendLine(renderBriefing({ ...base, labelLegend: [{ repo: "r", labels }] }))!;
  expect(line).not.toContain("more)");
  for (const l of labels) expect(line).toContain(l);
});

// ── H1: the legend must NOT feed `audit.coverageGaps`, or it kills a counted EVAL flag ───────────
// Idiom: test/day36-deinversion.test.ts's "audit functions identical across render shapes".
//
// MEASURED before the fix, on a probe struct: 1 gap without the legend, 0 with it. Any repo with ≥1
// sub-project unit could never report a gap again, so `UNCOMMITTED NOT SURFACED` (EVAL days 16, 25)
// silently stopped firing.
test("coverageGaps is IDENTICAL with and without the legend line — positive case (a real gap survives)", () => {
  // The briefing body names NEITHER the repo label nor its unit labels — a genuine gap.
  const reposWithState = [{ repo: "/w/personal_code", labels: ["personal_code", "accountant_ai"] }];
  const without = renderBriefing({ ...base, suggestions: [{ text: "do an unrelated thing" }] });
  const with_ = renderBriefing({
    ...base, suggestions: [{ text: "do an unrelated thing" }],
    labelLegend: [{ repo: "personal_code", labels: ["accountant_ai", "ai_news"] }],
  });
  // Sanity: the legend really is present and really does name both labels — otherwise this test
  // would pass vacuously against a briefing that never had the hazard in it.
  expect(with_).toContain("accountant_ai");
  expect(with_).toContain("personal_code");
  expect(coverageGaps(reposWithState, without)).toHaveLength(1);
  expect(coverageGaps(reposWithState, with_)).toEqual(coverageGaps(reposWithState, without));
});

test("coverageGaps is IDENTICAL with and without the legend line — negative case (genuinely covered)", () => {
  // Here a RESUME bullet names the unit, so there is no gap either way: the exclusion must not
  // manufacture a gap for a repo the briefing body genuinely covers.
  const reposWithState = [{ repo: "/w/personal_code", labels: ["personal_code", "accountant_ai"] }];
  const body = { ...base, resume: [{ repo: "accountant_ai", text: "resume the reconciliation" }] };
  const without = renderBriefing(body);
  const with_ = renderBriefing({ ...body, labelLegend: [{ repo: "personal_code", labels: ["accountant_ai"] }] });
  expect(coverageGaps(reposWithState, without)).toEqual([]);
  expect(coverageGaps(reposWithState, with_)).toEqual(coverageGaps(reposWithState, without));
});

test("the legend prefix is ONE shared constant — writer and excluder cannot drift apart (H1)", () => {
  // The behavioural half: the rendered line must actually START with the constant the excluder
  // filters on. A mutation to EITHER side alone (re-wording render's literal, or audit's filter)
  // breaks the positive-gap test above; this asserts the seam itself so the failure is legible.
  const out = renderBriefing({ ...base, labelLegend: [{ repo: "r", labels: ["a"] }] });
  expect(legendLine(out)).toBeDefined();
  expect(legendLine(out)!.startsWith(LEGEND_PREFIX)).toBe(true);
});

test("wiring: both sides IMPORT the shared prefix rather than spelling a literal (H1)", async () => {
  // Source pin in this repo's "wiring:" idiom (test/audit.test.ts). MEASURED: with two literals, a
  // one-sided re-word compiles, ships, and silently disables an EVAL flag — nothing fails.
  const audit = await Bun.file(new URL("../src/audit.ts", import.meta.url)).text();
  const render = await Bun.file(new URL("../src/render.ts", import.meta.url)).text();
  expect(audit).toMatch(/LEGEND_PREFIX/);
  expect(render).toMatch(/L\.push\(`\$\{LEGEND_PREFIX\}/);
  // Neither file may re-spell the marker as a bare literal.
  expect(audit).not.toContain('"   (labels: "');
  expect(render).not.toContain('`   (labels: ');

  // ⚠ SECOND EXCLUDED MARKER, ADDED 2026-09-03 AND USER-DIRECTED — the recap-coverage drop lines
  // (`NOT_SHOWN_PREFIX`). This assertion USED to pin the filter's exact text
  // (`!l.startsWith(LEGEND_PREFIX)`), which is what made it fail the moment a second marker was
  // added — working precisely as intended: an eval-flag guard must not widen unreviewed. It is
  // widened here deliberately, and the pin is EXTENDED rather than relaxed, so every property it
  // enforced still holds: both markers are shared constants, neither file spells either as a
  // literal, and the "One filter, by construction" count below is unchanged at 1 — the new marker
  // rides in the SAME filter via `&&`, it does not add another.
  //
  // ⚠ ONE property WAS lost and is restored below, because the first version of this comment claimed
  // "every property it enforced still holds" and that was an overclaim. The deleted regex also pinned
  // the MATCHER KIND. MEASURED by the verify round: a `startsWith` → `includes` mutant passes every
  // other assertion here — both constants present in the chain, one `.filter(`, no bare literals —
  // and no behavioural test catches it either, since no rendered line contains the marker anywhere
  // but at position 0. Behaviourally inert on today's render, which is why it is cheap to pin and
  // was cheap to lose.
  expect(audit).toMatch(/NOT_SHOWN_PREFIX/);
  expect(render).toMatch(/L\.push\(`\$\{NOT_SHOWN_PREFIX\}/);
  expect(audit).not.toContain("u00b7");     // no bare middot literal on the excluder side
  expect(render).not.toContain("u00b7");    // nor on the writer side

  // ⚠ SCOPE, not just the constant. The pin above protects the MARKER; this protects how much the
  // haystack drops. MEASURED: adding a SECOND `.filter(...)` after the legend filter leaves every
  // assertion above green. The behavioural tests below catch a broadening that removes a line which
  // can carry a repo label — but a broadening onto LABEL-FREE lines (`(none)`, `(nothing in
  // progress)`) is an EQUIVALENT mutant: it cannot change this function's output on any input, so no
  // behavioural test can ever catch it, and it is still an unreviewed widening of an eval-flag guard.
  // One filter, by construction.
  // ⚠ Anchored on `coverageGaps` FIRST: `missingSameDay` above it builds its own `const hay =
  // briefingText…`, so a bare indexOf finds THAT one and this assertion silently measures the wrong
  // function (it did, on the first draft — it failed against the pristine tree, which is the only
  // reason the mis-anchoring was caught rather than shipped as a vacuous green).
  const fn = audit.slice(audit.indexOf("export function coverageGaps"));
  const hayChain = fn.slice(fn.indexOf("const hay = briefingText"));
  const chain = hayChain.slice(0, hayChain.indexOf(".toLowerCase();"));
  expect(chain).toContain("LEGEND_PREFIX");            // sanity: this really is the right chain
  expect(chain).toContain("NOT_SHOWN_PREFIX");         // and that the second marker is in THIS chain
  // Matcher kind, restored (see above): a prefix marker must be matched as a PREFIX. `includes`
  // would let a marker anywhere on a line evict it from the haystack.
  expect(chain).toMatch(/startsWith\(LEGEND_PREFIX\)/);
  expect(chain).toMatch(/startsWith\(NOT_SHOWN_PREFIX\)/);
  expect(chain.match(/\.filter\(/g) ?? []).toHaveLength(1);
});

// ── NEW-1: the exclusion is SCOPED TO THE LEGEND — every OTHER line still feeds the haystack ─────
//
// ⚠ WHY THESE EXIST, and it is a hole in the test above, not in the source. The source-text pin
// ("wiring: both sides IMPORT…") was the ONLY thing catching a BROADENED filter: no behavioural
// assertion in the suite noticed when the exclusion grew. MEASURED — a mutant that ADDS a second
// `.filter(...)` on the next line leaves the pinned literal perfectly intact and SURVIVED all 1375
// tests, silently removing the outage line from the coverage haystack. That is precisely the
// "compiles, ships, nothing fails" mode the shared constant exists to prevent, one level up.
//
// So: each code-built line type, ON ITS OWN, must still be able to cover a repo. Broadening the
// filter to drop any of them turns that line's test red. This SUPPLEMENTS the source pin.
const ZQ = [{ repo: "/w/zqrepo", labels: ["zqrepo"] }];
const gapsFor = (s: Partial<BriefingStruct>) =>
  coverageGaps(ZQ, renderBriefing({ ...base, ...s } as BriefingStruct));

test("control: a briefing naming the repo NOWHERE reports a gap (the scope pins are not vacuous)", () => {
  expect(gapsFor({})).toHaveLength(1);
  // ...and a legend for an UNRELATED repo must not accidentally cover it either.
  expect(gapsFor({ labelLegend: [{ repo: "other", labels: ["sub"] }] })).toHaveLength(1);
});

test("a MERGE line alone still covers a repo — exclusion must not broaden to it (NEW-1)", () => {
  // Legend present and naming something else, so coverage can only come from the merge line. The
  // struct text is the real per-merge shape so the line under test is the COLLAPSED foot line
  // (S3b, 2026-09-24) — the one a reader actually gets — not a passthrough of an unparsed text.
  expect(gapsFor({
    windowMerges: [{ repo: "zqrepo", text: "🔀 Merged #1 (feat/x) (Aug 1)  (abc1234)" }],
    labelLegend: [{ repo: "other", labels: ["sub"] }],
  })).toEqual([]);
});

test("an OUTAGE line alone still covers a repo — this is the J9 mutant's target (NEW-1)", () => {
  // J9: `.filter((l) => !l.includes("No briefing for"))` added after the legend filter. It leaves
  // LEGEND_PREFIX untouched, so every source pin still passes; only this assertion can see it.
  expect(gapsFor({ outage: { missedDays: 2, label: "zqrepo" } })).toEqual([]);
  expect(gapsFor({
    outage: { missedDays: 2, label: "zqrepo" },
    labelLegend: [{ repo: "other", labels: ["sub"] }],
  })).toEqual([]);
});

test("a WARNING line alone still covers a repo (NEW-1)", () => {
  expect(gapsFor({ warnings: ["zqrepo could not be read"] })).toEqual([]);
});

test("an ordinary BULLET alone still covers a repo — resume, recap, today, branch-state (NEW-1)", () => {
  expect(gapsFor({ resume: [{ repo: "zqrepo", text: "resume auth" }] })).toEqual([]);
  expect(gapsFor({ recap: [{ repo: "zqrepo", text: "did x", evidence: "a1b2c3d" }] })).toEqual([]);
  expect(gapsFor({ today: [{ repo: "zqrepo", text: "did y (abc1234)" }] })).toEqual([]);
  expect(gapsFor({ branchState: [{ repo: "zqrepo", text: "On branch main (ahead 2)" }] })).toEqual([]);
});

// ── The builder → struct → render seam, from real `Unit` shapes ─────────────────────────────────
test("subprojectLegend builds the mapping from Unit.root and it survives into the rendered briefing", () => {
  const units = [
    // Deliberately UNSORTED and interleaved: `resolveUnits` emits units in git-activity order.
    unit("/w/personal_code", "projects/daily_briefing", "daily_briefing"),
    unit("/w/workspace", null, "workspace"),                       // catch-all — IS the repo, not an area
    unit("/w/personal_code", "projects/accountant_ai", "accountant_ai"),
    unit("/w/personal_code", null, "personal_code"),               // catch-all — must not list itself
    unit("/w/workspace", "svc/api", "api"),
  ];
  const legend = subprojectLegend(units, ["/w/personal_code", "/w/workspace"]);
  expect(legend).toEqual([
    { repo: "personal_code", labels: ["accountant_ai", "daily_briefing"] },
    { repo: "workspace", labels: ["api"] },
  ]);
  const out = renderBriefing({ ...base, labelLegend: legend });
  expect(out).toContain("accountant_ai, daily_briefing are areas of repo personal_code");
  expect(out).toContain("api is an area of repo workspace");
});

test("subprojectLegend returns [] when every unit is a repo catch-all (no subprojects config)", () => {
  const units = [unit("/w/app", null, "app"), unit("/w/other", null, "other")];
  expect(subprojectLegend(units, ["/w/app", "/w/other"])).toEqual([]);
  expect(renderBriefing({ ...base, labelLegend: subprojectLegend(units, ["/w/app", "/w/other"]) }))
    .not.toContain("(labels:");
});

test("subprojectLegend is deterministic and de-duplicates: same output regardless of unit order", () => {
  const a = [
    unit("/w/r", "b", "beta"), unit("/w/r", "a", "alpha"), unit("/w/r", "b", "beta"),
  ];
  const z = [
    unit("/w/r", "b", "beta"), unit("/w/r", "b", "beta"), unit("/w/r", "a", "alpha"),
  ].reverse();
  expect(subprojectLegend(a, ["/w/r"])).toEqual([{ repo: "r", labels: ["alpha", "beta"] }]);
  expect(subprojectLegend(z, ["/w/r"])).toEqual(subprojectLegend(a, ["/w/r"]));
});

// ── L2: `repoLabelFor` is NOT injective, so grouping must key on the PATH ────────────────────────
test("two repos that LABEL identically stay TWO groups — no false containment claim (L2)", () => {
  // `repoLabel` disambiguates a basename collision by prepending the parent dir — but that
  // qualified form can collide too, which is exactly the residual `audit.ts` and `eval/echo.ts`
  // both document. Here both repos label `a/api`.
  const repos = ["/x/a/api", "/y/a/api"];
  const units = [unit("/x/a/api", "sub/one", "one"), unit("/y/a/api", "sub/two", "two")];
  const legend = subprojectLegend(units, repos);
  expect(legend.map((g) => g.repo)).toEqual(["a/api", "a/api"]);   // NOT injective — the hazard is real
  // Pre-fix (keying by label) these MERGED into one group whose line claimed both `one` and `two`
  // are areas of a single repo — a fabricated containment claim in the line that exists to stop
  // exactly that class of mis-attribution.
  expect(legend).toHaveLength(2);
  expect(legend[0]!.labels).toEqual(["one"]);
  expect(legend[1]!.labels).toEqual(["two"]);
});

// ── M2/M12: END-TO-END through the real generation seam (runCore), not a hand-built struct ───────
const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const stub = { generate: async () => "## RESUME\n- [x] resume\n## RECAP\n- [x] did it | evidence: HEADSHA\n## SUGGESTIONS\n- next" };
const mkCfg = (repos: string[], extra: Partial<Config> = {}): Config => ({
  repos, excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "echo", argv: [], promptVia: "stdin" }, ...extra,
});

test("end-to-end (runCore): a NO-subprojects config yields no legend field and no legend line", async () => {
  // MEASURED as surviving before this test existed: making core.ts assign `struct.labelLegend`
  // UNCONDITIONALLY — a legend in every briefing, single-project installs included — left the whole
  // suite green, because every other legend test builds its struct by hand.
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const r = await runCore(mkCfg([dir]), { provider: stub, netProbe: async () => true });
  expect(r.units.length).toBeGreaterThan(0);
  expect(r.units.every((u) => u.root === null)).toBe(true);   // catch-all only — nothing to explain
  expect(r.struct.labelLegend).toBeUndefined();               // ABSENT, not [] — kills the unconditional mutant
  expect(renderBriefing(r.struct)).not.toContain("(labels:");
});

test("end-to-end (runCore): a repo WITH subprojects yields the legend, through units → struct → render", async () => {
  const dir = await buildRepo([
    { file: "packages/api/a.ts", content: "x", isoDate: yesterdayNoon() },
    { file: "packages/web/b.ts", content: "y", isoDate: yesterdayNoon() },
  ]);
  const r = await runCore(mkCfg([dir], { subprojects: [{ repo: dir, roots: ["packages/*"] }] }),
    { provider: stub, netProbe: async () => true });
  expect(r.units.some((u) => u.root !== null)).toBe(true);
  expect(r.struct.labelLegend).toBeDefined();
  const out = renderBriefing(r.struct);
  const line = legendLine(out)!;
  expect(line).toBeDefined();
  expect(line).toContain("are areas of repo");
  for (const l of ["api", "web"]) expect(line).toContain(l);
});
