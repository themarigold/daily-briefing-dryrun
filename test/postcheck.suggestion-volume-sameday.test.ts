// test/postcheck.suggestion-volume-sameday.test.ts — IN-4: S3's SAME-DAY leg.
//
// Day 48 (EVAL.md): 9 of 10 same-day commits were `accountant_ai` and it got zero suggestions, while
// BOTH window legs stayed correctly silent — the counter only ever saw the window. The leg is a NEW
// INPUT (`Unit.todayCommits`, git-derived), the same union over it, gated by a calibrated minimum-n
// floor, and INFO-only like the rest of S3. Pinned below, each against the mutant it exists to kill:
//   (a) the defect reproduces without the leg and is reported with it (day 48's own numbers);
//   (b) the floor — share-1.000-by-construction mornings stay silent; inclusive at the floor;
//   (c) the ARITHMETIC coupling floor × share floor × cap;
//   (d) info:true on every row — by TYPE (a non-literal does not compile unless escaped by a cast, a
//       non-null assertion or an `any` value), and by a sweep over volume, suggestion count and label
//       length (escapes keyed on those, nothing else) — and a log prefix the EVAL flag-count grep cannot
//       match;
//   (e) no G-check reports it — by text, and by running the real CHECKS over a morning where it fires;
//   (f) only MODEL-WRITTEN lines count on this leg — S1 promotions and IN-10 stash lines do not
//       (the window legs are unchanged and still count both, in the 3-argument call too);
//   (g) `resolveUnits` counts it per unit, same-day only, excluded commits skipped;
//   (h) end to end through runCore (clock pinned, cleaned up in afterEach even on a timeout): git →
//       todayCommits → postcheck → stderr, exactly one row and no other; and a throw in S3 cannot erase
//       that morning's COUNTED rows.
import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir
import { test, expect, describe, spyOn, setSystemTime, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as postcheckModule from "../src/postcheck";
import {
  checkSuggestionVolume, SAME_DAY_MIN_COMMITS, VOLUME_SHARE_FLOOR, VOLUME_FINDING_CAP,
  type PostFinding, type Suggestion, type UnitVolume,
} from "../src/postcheck";
import { CHECKS } from "../src/eval/checks";
import type { CheckInput } from "../src/eval/types";
import { runCore } from "../src/core";
import type { Unit } from "../src/subprojects";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import type { Activity, Config } from "../src/types";

const S = (...texts: string[]): Suggestion[] => texts.map((text) => ({ text }));
const V = (o: Record<string, number>): UnitVolume[] => Object.entries(o).map(([label, commits]) => ({ label, commits }));
const sameDay = (out: PostFinding[]) => out.filter((f) => f.rule === "suggestion-sameday-miss");
const labelOf = (f: PostFinding) => f.detail.match(/\[([^\]]+)\]/)![1];
/** EXACTLY how core.ts prints a finding (its `diagError` template; pinned against the source below). */
const logLine = (p: PostFinding) => `${p.info ? "postcheck-info" : "postcheck"} [${p.rule}]: ${p.detail}`;

// ── FILE-LEVEL CLEANUP, AND A TOKEN PER TEST ────────────────────────────────────────────────────────
// ⚠ `setSystemTime`, the `console.error` swap and `spyOn` on a module namespace are PROCESS-WIDE, and this
// file is the suite's only `setSystemTime` user. A test that times out does not stop its body: the body
// keeps running afterwards, concurrently with LATER tests and files. Measured (review rounds 2 and 3):
// a run that outlived its timeout froze the NEXT FILE's `Date` 289-327 min ahead; a body that timed out
// BEFORE it reached `run()` later pinned the clock, installed its throwing spy and took over stderr in
// the next file, unpinned a later same-file test mid-run, and reset a later spy to the real function.
// So every process-wide side effect here is TOKEN-GATED. `beforeEach` issues each test a fresh token
// (the (h) tests take it at entry, via `e2e`); `afterEach` — which bun runs even after a timeout —
// REVOKES it, unpins the clock, hands stderr back and restores every spy. `run()` and
// `throwingDetector()` check the token BEFORE touching anything and throw on a revoked one, and a run
// already under way restores nothing from its late `finally` once its token is revoked.
// GUARANTEED: once a test has ended, nothing its body does afterwards pins the clock, swaps stderr or
// installs a spy (the helpers below are this file's only routes to those three). NOT guaranteed: a
// runCore already under way when its test ended runs to completion — on whatever clock is current then
// (the real clock, or a LATER test's pin), printing to whatever `console.error` is current then. And the
// refused late call is visible only sometimes: if it lands during another test in THIS file, bun reports
// it as "Unhandled error between tests" ("1 error", no test wrongly blamed); if it lands in the NEXT file,
// bun swallows it silently. Either way the run is red already — it exits 1 from the timeout.
// ⚠ KNOWN GAP: no test pins this cleanup itself — deleting the unpin below leaves the suite green;
// only the out-of-suite timeout adversaries (review rounds 2-3) show it.
type Token = { live: boolean };
const realConsoleError = console.error;
const liveSpies: { mockRestore(): void }[] = [];
let current: Token = { live: false };
beforeEach(() => { current = { live: true }; });
afterEach(() => {
  current.live = false;
  setSystemTime();
  console.error = realConsoleError;
  while (liveSpies.length) liveSpies.pop()!.mockRestore();
});
/** Refuses a revoked token BEFORE any process-wide side effect. */
function claim(tok: Token, what: string): void {
  if (!tok.live) throw new Error(`stale ${what} refused: its test already ended — nothing was pinned, spied or swapped`);
}
/** The one spy this file installs: the S3 detector, made to throw. Token-gated; restored by `afterEach`. */
function throwingDetector(tok: Token, message: string) {
  claim(tok, "spy");
  const spy = spyOn(postcheckModule, "checkSuggestionVolume").mockImplementation(() => { throw new Error(message); });
  liveSpies.push(spy);
  return spy;
}

// Day 48 (2026-09-02), from the archived briefing and EVAL.md:134. Window: argmax quant_stocks 36/40,
// accountant_ai 2/40 = 0.050. Same-day ("Today so far", 🔀 lines excluded): accountant_ai 9, personal_code 1.
const DAY48_SUGGESTION = S("[quant_stocks] Once the Phase B review round 2 tests from de8fee3 are confirmed green, revisit the campaign-2 gate in run_phase_b.py added at fc0b775 — the commit itself states it's mechanically shut until campaign 2 opens, so that's the concrete blocker to lift.");
const DAY48_WINDOW = V({ quant_stocks: 36, accountant_ai: 2, daily_briefing_application: 2, personal_code: 1 });
const DAY48_TODAY = V({ accountant_ai: 9, personal_code: 1 });

describe("(a) day 48 — the defect, and the leg that sees it", () => {
  test("WITHOUT a same-day input both window legs are silent — the day-48 shape, reproduced", () => {
    expect(checkSuggestionVolume(DAY48_SUGGESTION, DAY48_WINDOW)).toEqual([]);
  });

  test("WITH it, exactly one same-day row: accountant_ai 9/10, argmax and high-share", () => {
    const out = checkSuggestionVolume(DAY48_SUGGESTION, DAY48_WINDOW, DAY48_TODAY);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("suggestion-sameday-miss");
    expect(out[0]!.detail).toBe(
      "highest-volume unit [accountant_ai] (9 same-day commits, 9/10 = share 0.900) got no model-written suggestion mentioning it"
      + ` (1 checked, 0 code-built not counted) — criterion: argmax+share>=0.30, same-day total>=${SAME_DAY_MIN_COMMITS}`);
  });

  test("the same-day leg ranks SAME-DAY volume only — a window giant with nothing today is not in it", () => {
    // quant_stocks has 36 window commits and none today: it must not appear in, or dilute, the same-day
    // denominator (10, not 46).
    const out = sameDay(checkSuggestionVolume(S("unrelated"), DAY48_WINDOW, DAY48_TODAY));
    expect(out.map(labelOf)).toEqual(["accountant_ai"]);
    expect(out[0]!.detail).toContain("9/10 = share 0.900");
  });

  test("ineligible same-day counts (0, negative, NaN, Infinity) stay out of the numerator AND the denominator", () => {
    const out = sameDay(checkSuggestionVolume(S("x"), [], [
      ...V({ big: 3, mid: 2 }), { label: "zero", commits: 0 }, { label: "neg", commits: -4 },
      { label: "nan", commits: NaN }, { label: "inf", commits: Infinity },
    ]));
    expect(out.map(labelOf)).toEqual(["big", "mid"]);
    expect(out[1]!.detail).toContain("2/5 = share 0.400");
  });

  test("the window rows are byte-identical with and without a same-day input — code-built lines included", () => {
    // ⚠ PRODUCTION ALWAYS PASSES THREE ARGUMENTS (core.ts), and on the window legs a CODE-BUILT line —
    // an S1 `(from resume)` promotion or IN-10's stash line — still counts as a mention. So the cases
    // below where the ONLY line naming a window-qualifying unit is code-built are the ones that matter:
    // a window leg that set code-built lines aside whenever a third argument is present (review round
    // 1's mutant L1) would add a window row here that the two-argument call does not have.
    const PROMOTED: Suggestion = { text: "carry on with the M7.5a checkpoint", repo: "accountant_ai", promoted: true };
    const PROMOTED_INLINE: Suggestion = { text: "[quant_stocks] continue the Phase C review cycle", promoted: true };
    const STASH: Suggestion = { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "main", ageDays: 13 } };
    const cases: [Suggestion[], UnitVolume[]][] = [
      [S("unrelated"), V({ a: 13, b: 1 })],
      [S("ship alpha"), V({ zeta: 5, alpha: 5 })],
      [S("open the quant_stocks PR"), V({ quant_stocks: 8, accountant_ai: 6, dba: 4 })],
      [DAY48_SUGGESTION, DAY48_WINDOW],
      [[PROMOTED], V({ accountant_ai: 9, other: 1 })],                                 // promotion is the only mention
      [[...S("unrelated"), PROMOTED_INLINE], V({ quant_stocks: 6, accountant_ai: 6 })],   // label in the promoted text
      [[STASH], V({ personal_code: 5, other: 1 })],                                    // stash line is the only mention
      [[...DAY48_SUGGESTION, PROMOTED, STASH], V({ quant_stocks: 30, accountant_ai: 25, personal_code: 25 })],
    ];
    let codeBuiltLoadBearing = 0;
    for (const [s, w] of cases) {
      const before = checkSuggestionVolume(s, w);
      // CONTROL — on the code-built cases the code-built line is what silences the window row: grading
      // the model-written lines alone reports it. Without this, the case could pass vacuously.
      const modelOnly = s.filter((x) => !x.promoted && !x.stash);
      if (modelOnly.length < s.length && checkSuggestionVolume(modelOnly, w).length > before.length) codeBuiltLoadBearing++;
      for (const today of [V({ a: 5, zeta: 9, dba: 4, other: 7 }), V({ accountant_ai: 9, personal_code: 1 }), V({ solo: 1 })]) {
        const after = checkSuggestionVolume(s, w, today);
        expect(after.filter((f) => f.rule === "suggestion-volume-miss")).toEqual(before);
        expect(after.slice(0, before.length)).toEqual(before);        // window rows first, as before
      }
    }
    expect(codeBuiltLoadBearing).toBe(4);
  });
});

describe("(b) the minimum-n floor", () => {
  test("below the floor NOTHING reports — the shapes where a share is fixed by the denominator", () => {
    // Every one of these reports on the WINDOW leg (the control column), so the floor — and nothing
    // else — is what silences them on the same-day leg.
    const shapes = [V({ solo: 1 }), V({ a: 1, b: 1 }), V({ a: 1, b: 1, c: 1 }), V({ a: 3 }), V({ a: 2, b: 1 })];
    for (const t of shapes) {
      const total = t.reduce((n, u) => n + u.commits, 0);
      expect(total).toBeLessThan(SAME_DAY_MIN_COMMITS);
      expect(checkSuggestionVolume(S("unrelated"), t).length).toBeGreaterThan(0);          // control
      expect(checkSuggestionVolume(S("unrelated"), [], t)).toEqual([]);
    }
  });

  test("day 45's 1/1 (one autolog sync commit — share 1.000 by construction) does not report", () => {
    expect(checkSuggestionVolume(S("f66f890 labels itself M7 Phase A — land PR2/3 in accountant_ai."), [], V({ personal_code: 1 }))).toEqual([]);
  });

  test("the floor is INCLUSIVE — a same-day total of exactly SAME_DAY_MIN_COMMITS reports", () => {
    const out = checkSuggestionVolume(S("unrelated"), [], V({ solo: SAME_DAY_MIN_COMMITS }));
    expect(out).toHaveLength(1);
    expect(out[0]!.detail).toContain(`${SAME_DAY_MIN_COMMITS}/${SAME_DAY_MIN_COMMITS} = share 1.000`);
  });

  test("the calibration's upper edge: days 41 and 46 — judge-confirmed misses at a same-day total of 4 — report", () => {
    // EVAL day 41: "zero suggestions touch accountant_ai (… all 4 same-day)"; day 46: "No accountant_ai
    // item in Suggested next at all" (accountant_ai 3, quant_stocks 1 same-day). A floor of 5 loses both.
    const d41 = checkSuggestionVolume(S("verify the sops re-encryption in ai_news", "check the dba threshold watch"), [], V({ accountant_ai: 4 }));
    const d46 = checkSuggestionVolume(S("[quant_stocks] run the exp016 audit"), [], V({ accountant_ai: 3, quant_stocks: 1 }));
    expect(d41.map(labelOf)).toEqual(["accountant_ai"]);
    expect(d46.map(labelOf)).toEqual(["accountant_ai"]);
  });

  test("the gate is on the ELIGIBLE same-day total — junk counts cannot lift a 3-commit day over it", () => {
    const t = [...V({ a: 2, b: 1 }), { label: "neg", commits: -9 }, { label: "nan", commits: NaN }];
    expect(checkSuggestionVolume(S("x"), [], t)).toEqual([]);
  });
});

describe("(c) ARITHMETIC — the floor, the share floor and the cap are one coupled set", () => {
  test("SAME_DAY_MIN_COMMITS is the SMALLEST n at which one commit cannot clear VOLUME_SHARE_FLOOR; the cap bounds this leg too", () => {
    // ⚠ READ BEFORE CHANGING ANY OF THE THREE. The floor was calibrated to a BAND on the archive (2-4:
    // 1 admits day 45's 1/1 artifact; 5 loses the judge-confirmed misses of days 41 and 46), and the
    // band's top was taken for this arithmetic: at n >= floor a lone commit is under the share floor.
    expect(SAME_DAY_MIN_COMMITS).toBe(4);
    expect(1 / SAME_DAY_MIN_COMMITS).toBeLessThan(VOLUME_SHARE_FLOOR);                        // 0.25 < 0.30
    expect(1 / (SAME_DAY_MIN_COMMITS - 1)).toBeGreaterThanOrEqual(VOLUME_SHARE_FLOOR);       // 0.333 >= 0.30: 3 would not do
    // The cap: this leg reuses VOLUME_SHARE_FLOOR, so the window leg's proof holds here too — at most
    // ⌊1/0.30⌋ = 3 units clear the floor, the argmax is never a fourth, and 3 <= the cap. The ONE edit
    // that makes the cap live — a share floor <= 0.25 — ALSO breaks the lone-commit property above
    // (1/4 = 0.25 would clear it), so that edit fails this test on two counts, not one.
    expect(Math.floor(1 / VOLUME_SHARE_FLOOR)).toBeLessThanOrEqual(VOLUME_FINDING_CAP);
    expect(VOLUME_FINDING_CAP).toBe(3);
  });

  test("the reachable ceilings, exercised: 2 rows at exactly the floor, 3 above it, never 4", () => {
    // At n = 4 a share-qualifier needs >= 2 commits (0.30 × 4 = 1.2), so at most two units qualify.
    expect(sameDay(checkSuggestionVolume(S("x"), [], V({ a: 2, b: 2 })))).toHaveLength(2);
    // A 3+1 split: only the 3 qualifies — the lone commit (0.25) is under the share floor.
    expect(sameDay(checkSuggestionVolume(S("x"), [], V({ a: 3, b: 1 }))).map(labelOf)).toEqual(["a"]);
    // Three at 0.30 each is the most the floor admits.
    expect(sameDay(checkSuggestionVolume(S("x"), [], V({ a: 3, b: 3, c: 3, d: 1 })))).toHaveLength(3);
    // Four equal units at 0.25: none clears the share floor, so only the argmax reports (the stated residual).
    const frag = sameDay(checkSuggestionVolume(S("x"), [], V({ w: 1, x: 1, y: 1, z: 1 })));
    expect(frag.map(labelOf)).toEqual(["w"]);
    expect(frag[0]!.detail).toContain("criterion: argmax, same-day");
  });
});

describe("(d) INFO-ONLY — it can never move an EVAL flag count", () => {
  test("every same-day row is info:true, UNCONDITIONALLY — on both legs of the union", () => {
    const cases: PostFinding[][] = [
      checkSuggestionVolume([], [], V({ a: 4 })),
      checkSuggestionVolume(DAY48_SUGGESTION, DAY48_WINDOW, DAY48_TODAY),
      checkSuggestionVolume(S("x"), [], V({ zeta: 5, alpha: 5 })),                            // argmax + share
      checkSuggestionVolume(S("ship alpha"), [], V({ zeta: 5, alpha: 5 })),                   // share only (tiebreak loser)
      checkSuggestionVolume(S("x"), [], V({ w: 1, x: 1, y: 1, z: 1 })),                       // argmax only
      checkSuggestionVolume(S("x"), [], V({ a: 3, b: 3, c: 3, d: 1 })),
    ];
    const all = cases.flat().filter((f) => f.rule === "suggestion-sameday-miss");
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(all.filter((f) => f.info !== true)).toEqual([]);
  });

  test("…on EVERY input the sweep varies — volume past the archive's heaviest morning, 0-5 model-written lines, 0-2 code-built lines, 51-char labels", () => {
    // ⚠ WHAT THIS PROVES, AND WHAT IT DOES NOT (review rounds 1-3). `PostFinding` makes an S3 row's
    // `info` the required literal `true`, so a non-literal (`info: day.total <= 10`) is a compile error
    // UNLESS it is escaped, and three escapes still compile: a CAST (`… as true`, `as unknown as true`,
    // `<PostFinding>{…}`), a NON-NULL ASSERTION (`info: (day.total <= 10 || undefined)!`), and an
    // `any`-typed value (`info: JSON.parse(String(day.total <= 10))`). This sweep catches any of them ONLY
    // if it is keyed on an input it VARIES: the volume (unit size and day total, past day 51's 30 commits and day 33's
    // 22-commit unit), the number of model-written suggestions (0-5), the number of code-built ones (0-2)
    // and the label length (1 and 51 characters). NOTHING MORE — in particular NOT the number of units
    // (at most 3 here; `info: (today.length < 5) as true` survives) and NOT labels with spaces or
    // parentheses. Before the axis each keys on was swept, these passed the whole suite; on the real
    // archive they would have printed as COUNTED `postcheck [` lines: EM1 `day.total <= 10` 3 of the 11
    // rows, EM2 `c.unit.commits < 10` 2, `model.length < 2` 6, `c.unit.label.length < 20` 3.
    const LONG = "a_sub_project_label_well_past_forty_characters_long";                // 51 chars
    const model = (k: number): Suggestion[] => Array.from({ length: k }, (_, i) => ({ text: `unrelated step ${i}` }));
    const built = (j: number): Suggestion[] => ([
      { text: "carry on with the checkpoint", repo: "elsewhere", promoted: true },
      { text: "Pop or drop stash@{0}", repo: "elsewhere_too", stash: { branch: "main", ageDays: 3 } },
    ] as Suggestion[]).slice(0, j);
    const rows: PostFinding[] = [];
    const reached = new Set<string>();                                         // (label length, k, j) combos that produced rows
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20, 22, 25, 29, 30, 35, 45]) {
      for (const label of ["a", LONG]) {
        for (const t of [[{ label, commits: n }], [{ label, commits: n }, { label: "b", commits: 1 }], [{ label, commits: n }, { label: "b", commits: n }],
                         [{ label, commits: n }, { label: "b", commits: Math.ceil(n / 2) }, { label: "c", commits: 2 }]]) {
          for (let k = 0; k <= 5; k++) for (let j = 0; j <= 2; j++) {
            const s = [...model(k), ...built(j)];
            const two = sameDay(checkSuggestionVolume(s, [], t)), three = sameDay(checkSuggestionVolume(s, t, t));   // + the production 3-arg shape
            if (two.length && three.length) reached.add(`${label.length}:${k}+${j}`);
            rows.push(...two, ...three);
          }
        }
      }
    }
    // The archive's own heavy mornings, verbatim: days 47 (29), 51 (30), 33 (22 in one unit), 35 (21).
    for (const t of [V({ accountant_ai: 18, quant_stocks: 11 }), V({ accountant_ai: 12, quant_stocks: 17, personal_code: 1 }),
                     V({ accountant_ai: 22 }), V({ accountant_ai: 21 })]) {
      rows.push(...sameDay(checkSuggestionVolume(S("unrelated"), [], t)));
    }
    // NOT VACUOUS — every varied input really reaches a reported row, on both union legs.
    const totals = rows.map((f) => Number(/\/(\d+) = share/.exec(f.detail)![1]));
    const unitNs = rows.map((f) => Number(/\((\d+) same-day commits?/.exec(f.detail)![1]));
    expect(Math.max(...totals)).toBeGreaterThanOrEqual(30);
    expect(unitNs.filter((n) => n >= 10).length).toBeGreaterThan(50);
    expect(reached.size).toBe(2 * 6 * 3);                                        // every label × k × j reached a row on both call shapes
    expect(rows.filter((f) => labelOf(f) === LONG).length).toBeGreaterThan(100);
    expect(rows.some((f) => f.detail.includes("criterion: share>="))).toBe(true);           // a share-only row
    expect(rows.filter((f) => f.info !== true).map((f) => f.detail)).toEqual([]);
  });

  test("its log line is `postcheck-info [...]`, which the EVAL convention `grep -c \"postcheck \\[\"` cannot match", async () => {
    const line = logLine(checkSuggestionVolume(DAY48_SUGGESTION, DAY48_WINDOW, DAY48_TODAY)[0]!);
    expect(line.startsWith("postcheck-info [suggestion-sameday-miss]: ")).toBe(true);
    expect(/postcheck \[/.test(line)).toBe(false);
    // …and the template above IS core.ts's: if the print statement changes, this test must be revisited.
    const core = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
    expect(core).toContain('diagError(`${p.info ? "postcheck-info" : "postcheck"} [${p.rule}]: ${p.detail}`)');
  });

  test("its detail carries no SHA-shaped run — nothing an audit SHA predicate could pick up", () => {
    const d = checkSuggestionVolume(DAY48_SUGGESTION, DAY48_WINDOW, DAY48_TODAY)[0]!.detail;
    expect(d).not.toMatch(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/i);
  });
});

describe("(e) NOT an eval check", () => {
  test("no G-check reports `suggestion-sameday-miss`: the id appears nowhere under src/eval, and CHECKS kept its scope", () => {
    expect(CHECKS.length).toBe(7);   // same scope guard as the window rule's test
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
      const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });
    const src = join(import.meta.dir, "..", "src");
    const carriers = walk(src).filter((p) => readFileSync(p, "utf8").includes("suggestion-sameday-miss"))
      .map((p) => p.slice(src.length + 1)).sort();
    // The rule id lives in the detector alone; core.ts prints `p.rule` generically and never names it.
    expect(carriers).toEqual(["postcheck.ts"]);
    // And the eval layer cannot reach the detector by name either.
    for (const p of walk(`${src}/eval`)) expect(readFileSync(p, "utf8")).not.toContain("checkSuggestionVolume");
  });

  test("BEHAVIOURAL: the real CHECKS, run over a morning where the same-day leg FIRES, report nothing of it", () => {
    // The text pin above cannot see a G-check that reaches the detector through a re-export wrapper
    // (review round 1's mutant EM4: `export { checkSuggestionVolume as s3Rows }` in a new module, called
    // from G6 with the units' `todayCommits`). This runs every check for real, on day 48's shape.
    const unit = (label: string, windowCommits: number, todayCommits?: number): Unit => ({
      repo: `/r/${label}`, root: null, label, hasResumptionState: false, hasWindowContent: windowCommits > 0,
      resumptionNote: "", dirtyFiles: [], latestCommitTime: null, windowCommits,
      ...(todayCommits === undefined ? {} : { todayCommits }),
    });
    const done = Array.from({ length: 9 }, (_, i) => ({ label: "accountant_ai", subject: `feat(m7): step ${i}`, whenMs: Date.parse("2026-09-02T09:00:00Z") + i * 60_000 }));
    const input = (withToday: boolean): CheckInput => ({
      caseName: "in4-sameday", rawText: "", promptText: "", ctx: { repos: [] }, emptyWindow: false,
      struct: { date: "2026-09-02", machineScope: "test", provider: "test", resume: [], recap: [], suggestions: DAY48_SUGGESTION },
      units: [unit("quant_stocks", 36, withToday ? 0 : undefined), unit("accountant_ai", 2, withToday ? 9 : undefined),
              unit("daily_briefing_application", 2, withToday ? 0 : undefined), unit("personal_code", 1, withToday ? 1 : undefined)],
      gitShaSet: new Set(), fileInventory: new Set(), shaToUnit: new Map(), commitMessages: new Map(), denylist: [],
      doneToday: withToday ? done : [],
    });
    const withLeg = input(true);
    // PREMISE — the leg really fires on this input (else the test passes whenever nothing fires).
    const row = sameDay(checkSuggestionVolume(withLeg.struct.suggestions, [],
      withLeg.units.map((u) => ({ label: u.label, commits: u.todayCommits ?? 0 }))));
    expect(row.map(labelOf)).toEqual(["accountant_ai"]);
    const run = (i: CheckInput) => CHECKS.flatMap((c) => c(i));
    const findings = run(withLeg);
    // Nothing a check reports mentions the same-day leg…
    expect(findings.filter((f) => /same-day|suggestion-sameday-miss/.test(f.detail))).toEqual([]);
    expect(findings.filter((f) => f.detail === row[0]!.detail)).toEqual([]);
    // …and the same-day evidence changes NOTHING any check reports: identical findings without it.
    expect(findings).toEqual(run(input(false)));
  });

  test("the audit sources name no postcheck line — a TEXT check; the real guard is print ORDER", () => {
    // What keeps a postcheck row out of what the audit reads is ORDER, not this text: runCore prints
    // every postcheck line to stderr before main.ts prints the rendered briefing, so `lastBriefing`'s
    // header-to-EOF slice of briefing.log starts after them. This test only pins that neither audit
    // source reads or names the prefix; it cannot see a postcheck line printed inside the slice.
    for (const f of ["../scripts/audit.ts", "../src/audit.ts"]) {
      const text = readFileSync(`${import.meta.dir}/${f}`, "utf8");
      expect(text).not.toContain("postcheck");
      expect(text).not.toContain("suggestion-sameday-miss");
    }
  });
});

describe("(f) which lines count — MODEL-WRITTEN only on the same-day leg", () => {
  // Day 64 (2026-09-18), same-day: dba 2, personal_code 3, accountant_ai 2, quant_stocks 1 — and IN-10's
  // stash line `[personal_code] Pop or drop stash@{0}` would have been appended that morning.
  const DAY64_TODAY = V({ daily_briefing_application: 2, personal_code: 3, accountant_ai: 2, quant_stocks: 1 });
  const STASH: Suggestion = { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "(no branch)", ageDays: 13 } };
  const MODEL = S("Fix the unsafe ordering in accountant_ai db statement 23.");

  test("IN-10's stash line naming the unit does NOT silence its same-day row (day 64, measured)", () => {
    const out = sameDay(checkSuggestionVolume([...MODEL, STASH], [], DAY64_TODAY));
    expect(out.map(labelOf)).toEqual(["personal_code"]);
    expect(out[0]!.detail).toContain("(1 checked, 1 code-built not counted)");
  });

  test("an S1 `(from resume)` promotion naming the unit does NOT silence it either — with or without `repo`", () => {
    const withRepo: Suggestion = { text: "continue the M7.5a checkpoint work", repo: "accountant_ai", promoted: true };
    const inText: Suggestion = { text: "[accountant_ai] continue the M7.5a checkpoint work", promoted: true };
    for (const p of [withRepo, inText]) {
      const out = sameDay(checkSuggestionVolume([p], [], DAY48_TODAY));
      expect(out.map(labelOf)).toEqual(["accountant_ai"]);
      expect(out[0]!.detail).toContain("(0 checked, 1 code-built not counted)");
    }
  });

  test("a MODEL-WRITTEN line naming the unit DOES silence it (the control)", () => {
    expect(sameDay(checkSuggestionVolume([...S("[personal_code] raise the CI skip budget again"), STASH], [], DAY64_TODAY))).toEqual([]);
    expect(sameDay(checkSuggestionVolume(S("Land M7.5a M-d in accountant_ai."), [], DAY48_TODAY))).toEqual([]);
  });

  test("the WINDOW legs are unchanged: there the stash line and the promotion still count as mentions", () => {
    // Pre-IN-4 behaviour, preserved on purpose (IN-10 lens 3 recorded it; changing it is not this item).
    const PROMO: Suggestion = { text: "carry on", repo: "solo", promoted: true };
    expect(checkSuggestionVolume([STASH], V({ personal_code: 5, other: 1 }))).toEqual([]);
    expect(checkSuggestionVolume([PROMO], V({ solo: 3 }))).toEqual([]);
    // …AND IN PRODUCTION'S SHAPE — a non-empty third argument, as core.ts always passes. The same-day
    // leg reports (it does not count the code-built line); the window leg, graded on BOTH channels,
    // still does not.
    const withToday = checkSuggestionVolume([STASH], V({ personal_code: 5, other: 1 }), DAY64_TODAY);
    expect(withToday.filter((f) => f.rule === "suggestion-volume-miss")).toEqual([]);
    expect(sameDay(withToday).map(labelOf)).toEqual(["personal_code"]);
    const promoToday = checkSuggestionVolume([PROMO], V({ solo: 3 }), V({ solo: 4 }));
    expect(promoToday.filter((f) => f.rule === "suggestion-volume-miss")).toEqual([]);
    expect(sameDay(promoToday).map(labelOf)).toEqual(["solo"]);
  });
});

// ── (g) `Unit.todayCommits` — the leg's volume input ────────────────────────────────────────────────
const CFG: Config = { provider: { cli: "c", argv: [], promptVia: "stdin" } };
const commit = (repo: string, id: string, file: string, excluded = false): Activity => ({
  source: "git", kind: "commit", event_id: id, repo, timestamp: "2026-07-13T10:00:00Z",
  meta: { diffstat: [{ file, added: 1, removed: 0 }], ...(excluded ? { excluded: true } : {}) },
});

describe("(g) resolveUnits: todayCommits", () => {
  test("counts SAME-DAY commits only — and windowCommits still counts only the window", async () => {
    const { resolveUnits } = await import("../src/subprojects");
    const repo = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tc1-")));
    const { units } = await resolveUnits(
      [commit(repo, "w1", "a.ts"), commit(repo, "w2", "b.ts")],                      // window
      [commit(repo, "t1", "c.ts"), commit(repo, "t2", "d.ts"), commit(repo, "t3", "e.ts")],   // today
      [repo], CFG);
    const cat = units.find((u) => u.root === null)!;
    expect(cat.todayCommits).toBe(3);
    expect(cat.windowCommits).toBe(2);
  });

  test("skips EXCLUDED (bot/auto) commits by the same gate windowCommits uses", async () => {
    const { resolveUnits } = await import("../src/subprojects");
    const repo = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tc2-")));
    const { units } = await resolveUnits([], [commit(repo, "t1", "a.ts"), commit(repo, "bot", "b.ts", true)], [repo], CFG);
    expect(units.find((u) => u.root === null)!.todayCommits).toBe(1);
  });

  test("is per unit, by the same unitForCommit vote — a same-day-only unit carries windowCommits 0", async () => {
    const { resolveUnits } = await import("../src/subprojects");
    const { mkdirSync } = await import("node:fs");
    const repo = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tc3-")));
    for (const d of ["packages/api", "packages/web"]) mkdirSync(join(repo, d), { recursive: true });
    const cfg: Config = { ...CFG, subprojects: [{ repo, roots: ["packages/*"] }] };
    const { units } = await resolveUnits(
      [commit(repo, "w1", "packages/web/z.ts")],
      [commit(repo, "a1", "packages/api/x.ts"), commit(repo, "a2", "packages/api/y.ts")], [repo], cfg);
    const api = units.find((u) => u.label === "api")!, web = units.find((u) => u.label === "web")!;
    expect([api.todayCommits, api.windowCommits]).toEqual([2, 0]);
    expect([web.todayCommits, web.windowCommits]).toEqual([0, 1]);
  });
});

describe("(h) end to end through runCore — clock pinned", () => {
  // ⚠ THE CLOCK IS PINNED (review round 1, lens 3 F2). These tests used to date their "same-day" commits
  // from `new Date()` at fixture time while runCore read the clock again at run time, so a run straddling
  // midnight filed them as yesterday's (reproduced deterministically: "Expected length: 4 / Received
  // length: 0") — and under `bun test` TZ is UTC, so that midnight is 17:00 PDT, inside the working day.
  // Now ONE instant rules both sides: PIN, local noon of the day this file loads, twelve hours from
  // either boundary. The fixture's dates are computed FROM it, and `setSystemTime` freezes `Date` AT it
  // for the whole runCore call — so no wall-clock movement between fixture and run reaches either side.
  const PIN = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })();
  const todayAt = (i: number) => { const d = new Date(PIN); d.setHours(0, 0, 30 + i, 0); return d.toISOString(); };
  const yesterdayNoon = () => { const d = new Date(PIN); d.setDate(d.getDate() - 1); return d.toISOString(); };
  async function gitOut(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text(); await p.exited; return out.trim();
  }
  const mkCfg = (repos: string[]): Config => ({
    repos, excludeCommitPatterns: ["^vault backup:"], lookbackCapDays: 30, provider: { cli: "echo", argv: [], promptVia: "stdin" },
  });
  const stub = (sha: string, suggestions: string[], resume: string[] = []) => ({ generate: async () => [
    "## RESUME", ...resume.map((b) => `- ${b}`), "## RECAP", `- [x] add README | evidence: ${sha.slice(0, 7)}`,
    "## SUGGESTIONS", ...suggestions.map((s) => `- ${s}`),
  ].join("\n") });
  async function run(tok: Token, cfg: Config, s: { generate: () => Promise<string> }) {
    claim(tok, "runCore");                           // before the clock, stderr or anything else is touched
    const errs: string[] = []; const o = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    setSystemTime(PIN);
    try { return { r: await runCore(cfg, { provider: s, netProbe: async () => true }), errs }; }
    finally { if (tok.live) { setSystemTime(); console.error = o; } }   // revoked ⇒ afterEach already restored both
  }
  /** An explicit e2e budget. Most runCore end-to-end tests in the suite run on bun's default 5 s, which
   *  was measured timing THESE out under load; 30 s is the class core.api-provider (15/20 s) and
   *  day33-batch (30/60 s) already use. A real hang still fails, at 30 s. */
  const E2E_TIMEOUT = 30_000;
  /** An (h) test: takes its token AT ENTRY (the one `beforeEach` just issued), under the e2e budget. */
  const e2e = (name: string, body: (tok: Token) => Promise<void>) => test(name, () => body(current), E2E_TIMEOUT);
  /** Every postcheck line a run printed, counted or info — the assertion surface for "exactly these rows". */
  const postcheckLines = (errs: string[]) => errs.filter((e) => e.startsWith("postcheck"));
  /** Repo W: one window commit (yesterday). Repo T: `real` same-day commits plus `bots` excluded ones. */
  async function fixture(real: number, bots: number) {
    const w = await buildRepo([{ file: "README.md", content: "x", isoDate: yesterdayNoon() }]);
    const t = await buildRepo([]);
    for (let i = 0; i < real; i++) await commitFiles(t, [`f${i}.ts`], { message: `feat: step ${i}`, isoDate: todayAt(i) });
    for (let i = 0; i < bots; i++) await commitFiles(t, [`b${i}.md`], { message: `vault backup: ${i}`, isoDate: todayAt(real + i) });
    return { w, t, sha: await gitOut(["rev-parse", "HEAD"], w), wl: w.split("/").pop()!, tl: t.split("/").pop()! };
  }

  e2e("4 same-day commits in an unsuggested repo: EXACTLY one postcheck line — the same-day row; the briefing is untouched", async (tok) => {
    const { w, t, sha, wl, tl } = await fixture(4, 0);
    const { r, errs } = await run(tok, mkCfg([w, t]), stub(sha, [`[${wl}] finish the README work.`]));
    // The count is the "Today so far" population: 4 commit lines for T, and todayCommits 4.
    expect(r.today.filter((x) => x.repo === tl)).toHaveLength(4);
    expect(r.units.find((u) => u.label === tl)!.todayCommits).toBe(4);
    // BEHAVIOURAL WIRING (this replaced a regex over core.ts's source): the whole postcheck output of the
    // morning is this one row. T's commits are all same-day, so a window leg fed today's counts would add
    // a `postcheck-info [suggestion-volume-miss]` row for T here, and a wiring that dropped same-day-only
    // units would remove the row below — either one fails this equality.
    expect(postcheckLines(errs)).toEqual([`postcheck-info [suggestion-sameday-miss]: highest-volume unit [${tl}] (4 same-day commits, 4/4 = share 1.000) got no model-written suggestion mentioning it (1 checked, 0 code-built not counted) — criterion: argmax+share>=0.30, same-day total>=4`]);
    expect(r.struct.suggestions).toEqual([{ text: `[${wl}] finish the README work.` }]);   // diagnostic only
  });

  e2e("3 real + 2 excluded (`vault backup:`) same-day commits: todayCommits 3, under the floor, no postcheck line at all", async (tok) => {
    const { w, t, sha, wl, tl } = await fixture(3, 2);
    const { r, errs } = await run(tok, mkCfg([w, t]), stub(sha, [`[${wl}] finish the README work.`]));
    expect(r.units.find((u) => u.label === tl)!.todayCommits).toBe(3);
    expect(r.today.filter((x) => x.repo === tl)).toHaveLength(3);                 // the same 3 the page shows
    expect(postcheckLines(errs)).toEqual([]);                                      // the gate is the SAME-DAY total (3), not window+today (4)
  });

  e2e("a THROW in the S3 counter cannot erase that morning's COUNTED rows — it runs in its own try", async (tok) => {
    // Review round 1 measured the old shape: one `try` around every check, so an S3 throw took the
    // COUNTED `postcheck [suggestion-restates]` row down with it (counted 1 → 0). The suggestion below
    // restates W's RESUME bullet verbatim — a counted row — on a morning where the same-day leg also fires.
    const { w, t, sha, wl, tl } = await fixture(5, 0);
    const bullet = `[${wl}] finish the parser migration for the ledger export module before review`;
    const model = stub(sha, [bullet], [bullet]);
    // CONTROL — unmocked, the morning carries BOTH a counted row and the same-day info row.
    const clean = postcheckLines((await run(tok, mkCfg([w, t]), model)).errs);
    expect(clean.filter((e) => e.startsWith("postcheck [suggestion-restates]"))).toHaveLength(1);
    expect(clean.filter((e) => e.startsWith("postcheck-info [suggestion-sameday-miss]") && e.includes(`[${tl}]`))).toHaveLength(1);
    // INJECTED — the S3 detector throws (spied on its module namespace, so core.ts's live binding sees it).
    // Restored by afterEach, not here: cleanup must not depend on this body finishing.
    const spy = throwingDetector(tok, "injected S3 failure");
    const { errs } = await run(tok, mkCfg([w, t]), model);
    expect(spy.mock.calls.length).toBe(1);         // PREMISE — the injection really reached runCore's S3 call
    const lines = postcheckLines(errs);
    expect(lines.filter((e) => e.startsWith("postcheck [suggestion-restates]"))).toEqual(clean.filter((e) => e.startsWith("postcheck [suggestion-restates]")));
    expect(lines.filter((e) => e.includes("[suggestion-sameday-miss]") || e.includes("[suggestion-volume-miss]"))).toEqual([]);
    expect(lines.filter((e) => e.startsWith("postcheck skipped"))).toEqual(["postcheck skipped (non-fatal, S3 volume counter): Error: injected S3 failure"]);
  });
});
