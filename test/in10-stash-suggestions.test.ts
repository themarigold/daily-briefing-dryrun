// test/in10-stash-suggestions.test.ts — IN-10: a PERSISTING GIT STASH becomes one code-built suggestion.
//
// EVAL days 47/57/58/60/63: both archived stashes sat in "Where you left off" on 25 of 26 mornings and an
// action was proposed on two. The judge asked for "apply or drop" on days 51, 57 and 63.
//
// Binding constraints, each pinned below:
//   (a) CHANNEL — a new `stash` field, never `promoted`: the restatement check (and so eval check G6)
//       skips `promoted`, and this channel must not widen that narrowing. So the line IS scored…
//   (b) …and the COUNTED `suggestion-restates` rule must be unable to fire on it: the text is fixed at
//       `Pop or drop stash@{N}` (3 topical tokens < MIN_SHARED_TOKENS) — pinned for refs 0-99 against
//       the REAL 09-17 backfill line, and against a line that says pop/drop (1.00, held by the floor alone).
//   (c) INTENT — a stash whose OWN message (the `<msg>` of `On <branch>: <msg>`, never the branch) states
//       a hold gets no line; whole words only; the automatic `WIP on …` subject is never read for intent.
//   (d) RANK — appended LAST, at most one, the oldest qualifier, skipped when a suggestion already names it
//       under ANY lane label of the same repo.
//   (e) IN-2 — the text is hex-free, so the verdict-path marker cannot fire on it.
//   (f) LABEL — no branch NAME ever renders (it moved three counted audit checks); `no branch` does.
//   (g) AGE — whole LOCAL calendar days, pinned under forced zones on both sides of UTC.
import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { stashSuggestions, STASH_INTENT_RE, STASH_SUGGESTIONS_MAX, markVerdictPathSuggestions, runCore } from "../src/core";
import { renderBriefing, stashLabel } from "../src/render";
import { checkSuggestionRestatement, contentTokens, MIN_SHARED_TOKENS, RESTATEMENT_THRESHOLD } from "../src/postcheck";
import { coverageGaps, extractCitedShas, missingSameDay } from "../src/audit";
import { buildRepo } from "./fixtures/build-repo";
import type { Unit } from "../src/subprojects";
import type { Activity, BriefingStruct, Config } from "../src/types";

const REPO = "/w/personal_code";
const RUN = "2026-09-19";
// Local-time ISO strings (no offset), so the whole-day age is the same on any machine's timezone.
const stash = (n: number, gs: string, iso: string, repo = REPO): Activity => ({
  source: "git", kind: "stash", event_id: `${repo}:stash:${n}`, repo, timestamp: iso,
  target: `stash@{${n}}`, text: `stash@{${n}}: ${gs}`, meta: { sha: String(n).padStart(40, "a") },
});
// The archive's two stashes, verbatim (`git stash list --format=%gs`).
const OWN = "On (no branch): pre-HEAD-fix: local STATE.md edits";
const PARKED = "On refactor/one-tenant-definition: autolog STATE.md — not mine, parked for relay start";
const build = (acts: Activity[], existing: BriefingStruct["suggestions"] = [], units: Unit[] = []) =>
  stashSuggestions(acts, [REPO], units, existing, RUN);

describe("which stashes qualify", () => {
  test("the archive's unmarked branchless stash: ONE line — fixed text, repo label, git's branch literal, whole days", () => {
    expect(build([stash(0, OWN, "2026-09-05T00:21:36")])).toEqual([
      { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "(no branch)", ageDays: 14 } },
    ]);
  });

  test("the archive's parked 'not mine' stash: NO line — the user's own message states the hold", () => {
    expect(build([stash(1, PARKED, "2026-08-22T00:50:41")])).toEqual([]);
    // …and the two together (today's real state) yield only the unmarked one.
    expect(build([stash(0, OWN, "2026-09-05T00:21:36"), stash(1, PARKED, "2026-08-22T00:50:41")]).map((s) => s.text))
      .toEqual(["Pop or drop stash@{0}"]);
  });

  // Review round 1's measured phrasings (lens 1: 43 ways of saying "leave this", 22 ordinary work messages;
  // lens 3: six more), verbatim. The first list held 6/43 and silenced 10/22; this one holds 42/43 and
  // silences 6/22 — every row is pinned below, in the group it lands in.
  const HOLDS = ["autolog STATE.md — not mine, parked for relay start", "not yours", "Not Ours", "parked",
    "blocked on review", "frozen until Friday", "deferred to v2", "held for Sam", "waiting on CI", "shut until the audit",
    "don't drop", "dont pop", "do not touch", "don’t apply",
    // lens 1
    "don't touch", "waiting for Sam", "not mine", "DO NOT DROP", "keep", "keep this", "keep for later", "hold",
    "on hold", "hold off", "for later", "backup", "backup before rebase", "bak", "save for later", "later", "someday",
    "leave it", "leave alone", "wait for review", "blocked by CI", "parking this", "park", "Sam's changes",
    "someone else's", "do-not-drop", "dont-drop", "reference only", "archive", "experiment - keep", "WIP keep",
    "until the audit", "paused", "on ice", "needs review", "for Monday", "postponed", "skip", "ignore", "stale, ignore",
    // lens 3
    "hold until review", "someone else's changes", "Sam's WIP", "not for me to apply"];
  const ORDINARY = ["pre-HEAD-fix: local STATE.md edits", "wip parser", "unblocked the queue", "mine sweeper fix",
    "keep going", "block layout", "fix the parking lot page", "try the drop shadow",
    // lens 1 — the first four were silenced by the first list: a hyphen is not a word boundary here
    "parked-car detector", "not mine-sweeper", "frozen until-loop refactor", "held on to the ref",
    "parking feature", "unparked the worker", "parker bug", "the frozen-pizza icon", "waiting-room UI", "held-out test set",
    "shut down gracefully", "blocked-user list", "deferred loading", "shut off flag"];

  test("the intent vocabulary: hold and ownership phrases match; ordinary work messages do not", () => {
    for (const m of HOLDS) expect([m, STASH_INTENT_RE.test(m)]).toEqual([m, true]);
    for (const m of ORDINARY) expect([m, STASH_INTENT_RE.test(m)]).toEqual([m, false]);
  });

  test("the accepted costs, pinned so a change to them is a decision: six work messages that use a hold phrase literally are silenced; 'old attempt' is not a hold", () => {
    // Silence is the pre-IN-10 briefing (the stash still shows in RESUME); a miss is a daily "drop" nag.
    for (const m of ["add parked state to the enum", "waiting on the promise in fetch", "blocked on the mutex fix",
      "don't drop the index (comment)", "held for the new API", "deferred to the render pass"]) {
      expect([m, STASH_INTENT_RE.test(m)]).toEqual([m, true]);
    }
    // "old attempt" calls the stash obsolete — dropping it is what the line proposes.
    expect(STASH_INTENT_RE.test("old attempt")).toBe(false);
  });

  test("intent is read from the MESSAGE only — a hold word in the BRANCH name says nothing about this stash", () => {
    expect(build([stash(0, "On parked: half-done parser", "2026-09-10T12:00:00")])).toEqual([
      { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "parked", ageDays: 9 } },
    ]);
    expect(build([stash(0, "On keep: later", "2026-09-10T12:00:00")])).toEqual([]);
  });

  test("a `WIP on` stash is NEVER read for intent — its subject is the HEAD commit's, not the user's", () => {
    expect(build([stash(0, "WIP on main: 8cefd59 chore: parked config, not mine", "2026-09-18T12:00:00")])).toEqual([
      { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "main", ageDays: 1 } },
    ]);
  });

  test("an unrecognised subject still yields a line, with NO branch claim", () => {
    expect(build([stash(0, "autostash", "2026-09-19T08:00:00")])).toEqual([
      { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { ageDays: 0 } },
    ]);
  });

  test("a ref that is not `stash@{N}` cannot be named, so it gets no line", () => {
    const a = { ...stash(0, OWN, "2026-09-05T12:00:00"), target: "stash", text: `stash: ${OWN}` };
    expect(build([a])).toEqual([]);
  });

  test("no stash activity ⇒ [] (commits, branches and dirty files are not stashes)", () => {
    const other: Activity[] = [
      { source: "git", kind: "commit", event_id: "c1", repo: REPO, timestamp: "2026-09-18T12:00:00", text: "stash the parser" },
      { source: "git", kind: "branch", event_id: "b1", repo: REPO, target: "main", text: "On branch main (ahead 1, behind 0)" },
    ];
    expect(build(other)).toEqual([]);
  });

  test("the label is the CATCH-ALL unit's label (the backfill line's bracket), not a sub-project's", () => {
    const units = [
      { repo: REPO, root: "accountant_ai", label: "accountant_ai" },
      { repo: REPO, root: null, label: "w/personal_code" },
    ] as unknown as Unit[];
    expect(build([stash(0, OWN, "2026-09-05T12:00:00")], [], units)[0]!.repo).toBe("w/personal_code");
  });
});

describe("rank, cap and dedupe", () => {
  test(`at most ${STASH_SUGGESTIONS_MAX}: the OLDEST qualifier; a marked older stash does not take the slot`, () => {
    const acts = [stash(0, "On main: newest", "2026-09-10T12:00:00"), stash(1, PARKED, "2026-08-22T12:00:00"),
      stash(2, "On main: middle", "2026-09-07T12:00:00")];
    expect(build(acts)).toEqual([{ text: "Pop or drop stash@{2}", repo: "personal_code", stash: { branch: "main", ageDays: 12 } }]);
  });

  test("equal dates break to the deeper stack entry (larger N is older)", () => {
    const acts = [stash(0, "On main: a", "2026-09-10T12:00:00"), stash(1, "On main: b", "2026-09-10T12:00:00")];
    expect(build(acts).map((s) => s.text)).toEqual(["Pop or drop stash@{1}"]);
  });

  test("the model already named it (day 62's line, verbatim) ⇒ no second line", () => {
    const day62 = { text: "[personal_code] Decide keep-or-drop on stash@{0} (pre-HEAD-fix local STATE.md edits) before next autolog run touches those files again." };
    expect(build([stash(0, OWN, "2026-09-05T12:00:00")], [day62])).toEqual([]);
    // A promoted entry carries its label in `repo`, not the text — the same fold postcheck applies.
    expect(build([stash(0, OWN, "2026-09-05T12:00:00")], [{ text: "pop stash@{0} first", repo: "personal_code", promoted: true }])).toEqual([]);
  });

  test("…but ONLY the same ref in the same repo: another repo's stash@{0}, or stash@{1}/stash@{10}, does not cover it", () => {
    const one = [stash(0, OWN, "2026-09-05T12:00:00")];
    expect(build(one, [{ text: "[other_repo] drop stash@{0}" }])).toHaveLength(1);
    expect(build([stash(1, OWN, "2026-09-05T12:00:00")], [{ text: "[personal_code] drop stash@{10}" }])).toHaveLength(1);
    expect(build(one, [{ text: "[personal_code] drop stash@{1}" }])).toHaveLength(1);
  });

  // A multi-lane repo: the S1 promotion's `repo` is the MODEL's RESUME bracket and a model line carries its
  // own, so the same stash can arrive under a sub-project label (review round 1: "[parser] applying
  // stash@{0} …" shipped beside a second whole-repo line).
  const OTHER = "/w/notes";
  const lanes = [
    { repo: REPO, root: "parser", label: "parser" },
    { repo: REPO, root: null, label: "personal_code" },
    { repo: OTHER, root: "drafts", label: "drafts" },
    { repo: OTHER, root: null, label: "notes" },
  ] as unknown as Unit[];

  test("a suggestion naming the ref under ANY lane label of the SAME repo covers it — promoted or model-written", () => {
    const one = [stash(0, OWN, "2026-09-05T12:00:00")];
    expect(build(one, [{ text: "applying stash@{0} and finishing the parser tests", repo: "parser", promoted: true }], lanes)).toEqual([]);
    expect(build(one, [{ text: "[parser] Pop stash@{0} and finish the form." }], lanes)).toEqual([]);
  });

  test("…but a DIFFERENT repo's lane label does not, and neither does a lane of the same repo naming another ref", () => {
    const one = [stash(0, OWN, "2026-09-05T12:00:00")];
    expect(build(one, [{ text: "[drafts] drop stash@{0}" }], lanes)).toHaveLength(1);
    expect(build(one, [{ text: "[notes] drop stash@{0}" }], lanes)).toHaveLength(1);
    expect(build(one, [{ text: "[parser] drop stash@{1}" }], lanes)).toHaveLength(1);
  });
});

/** The archive's branchless stash, built in a CHILD process whose zone is forced to `zone`. Not an
 *  in-process switch: bun honours an assignment to `process.env.TZ`, but after a `delete` it ignores every
 *  later one (measured), so a test that sets the zone cannot put an originally-UNSET zone back — and the
 *  rest of the run (and every process it spawns) would inherit the forced one. */
async function ageIn(zone: string, iso: string): Promise<{ zone: string; ageDays?: number; label: string }> {
  const code = `const { stashSuggestions } = await import(${JSON.stringify(join(import.meta.dir, "../src/core.ts"))});
const { stashLabel } = await import(${JSON.stringify(join(import.meta.dir, "../src/render.ts"))});
const [s] = stashSuggestions([{ source: "git", kind: "stash", event_id: "e", repo: ${JSON.stringify(REPO)}, timestamp: ${JSON.stringify(iso)},
  target: "stash@{0}", text: ${JSON.stringify(`stash@{0}: ${OWN}`)}, meta: { sha: "a".repeat(40) } }], [${JSON.stringify(REPO)}], [], [], ${JSON.stringify(RUN)});
console.log(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, ageDays: s.stash.ageDays, label: stashLabel(s.stash) }));`;
  const p = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`age child (${zone}) exited ${p.exitCode}: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("age", () => {
  test("made today ⇒ 0; a date AFTER the run date (clock skew) OMITS the age; an unreadable date omits the age", () => {
    expect(build([stash(0, "On main: x", "2026-09-19T00:05:00")])[0]!.stash).toEqual({ branch: "main", ageDays: 0 });
    // Not "made today": the RESUME line beside it prints the future date, and the two would disagree.
    expect(build([stash(0, "On main: x", "2026-09-21T12:00:00")])[0]!.stash).toEqual({ branch: "main" });
    expect(stashLabel(build([stash(0, "On main: x", "2026-10-24T12:00:00")])[0]!.stash!)).toBe("  (from stash)");
    expect(build([stash(0, "On main: x", "not a date")])[0]!.stash).toEqual({ branch: "main" });
  });

  // ⚠ WHOLE LOCAL CALENDAR DAYS, PINNED WHERE THIS RUNS. A UTC-date regression (the stash's date read with
  // toISOString) is invisible in UTC — the zone `bun test` defaults to and CI uses — and in any zone for a
  // stash made at local noon. Review round 1 showed it survived the whole suite in PDT and UTC. So each case
  // runs in a FORCED zone and picks an instant whose UTC date differs from its local date; the expectations
  // are literals, not recomputed with the code's own `localDateStr`.
  test("git's real offset form, zone forced: a stash made at 18:30 PDT the previous evening is 1 day old in Los Angeles", async () => {
    // 2026-09-18 18:30 PDT = 2026-09-19 01:30Z: the UTC date IS the run date; the local date is the day before.
    expect(await ageIn("America/Los_Angeles", "2026-09-18T18:30:00-07:00"))
      .toEqual({ zone: "America/Los_Angeles", ageDays: 1, label: "  (from stash · no branch · 1 day old)" });
    expect((await ageIn("America/Los_Angeles", "2026-09-18T23:59:00-07:00")).ageDays).toBe(1);
    expect((await ageIn("America/Los_Angeles", "2026-09-19T00:01:00-07:00")).ageDays).toBe(0);
  });

  test("…and east of UTC: a stash made at 02:00 IST is counted from its Kolkata date, not the UTC date before it", async () => {
    // 2026-09-18 02:00 IST = 2026-09-17 20:30Z: local date 09-18 (1 day old); the UTC date would say 2.
    const r = await ageIn("Asia/Kolkata", "2026-09-18T02:00:00+05:30");
    expect(r.zone).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
    expect(r.ageDays).toBe(1);
  });
});

// ── (b) THE COUNTED RULE CANNOT FIRE ────────────────────────────────────────────────────────────────
// The real 2026-09-17 RESUME backfill line for [personal_code], as `parseBriefing` stores it (label stripped).
const BACKFILL_0917 = "behind 2; stash@{0}: On (no branch): pre-HEAD-fix: local STATE.md edits (Sep 5); stash@{1}: On refactor/one-tenant-definition: autolog STATE.md — not mine, park… (Aug 22)";
const bullet = [{ repo: "personal_code", text: BACKFILL_0917 }];

describe("the counted `suggestion-restates` rule cannot fire on the shipped text", () => {
  // The text under test is the BUILDER's own output for each ref, not a copy of the template — so a change
  // to the shipped wording is graded here directly.
  const shipped = (n: number) => build([stash(n, OWN, "2026-09-05T12:00:00")])[0]!;

  test("refs 0-99: at most 3 topical tokens — below MIN_SHARED_TOKENS, so no bullet can share enough", () => {
    expect(MIN_SHARED_TOKENS).toBe(4);
    for (let n = 0; n < 100; n++) expect(contentTokens(shipped(n).text).size).toBeLessThan(MIN_SHARED_TOKENS);
  });

  test("refs 0-99 against the REAL 09-17 backfill line: never a counted finding", () => {
    for (let n = 0; n < 100; n++) {
      expect(checkSuggestionRestatement([shipped(n)], bullet).filter((p) => !p.info)).toEqual([]);
    }
  });

  test("the line IS scored — no skip: against that line it logs the INFO near-miss row (the accepted calibration cost)", () => {
    const out = checkSuggestionRestatement([shipped(0)], bullet);
    expect(out.map((p) => [p.rule, p.info])).toEqual([["suggestion-restates-near", true]]);
    expect(out[0]!.detail).toContain("0.33 containment, 1 shared tokens");
  });

  test("POSITIVE CONTROL: the same stash with its MESSAGE in the text trips the counted rule on that line", () => {
    const withMsg = { text: "Decide stash@{0} (pre-HEAD-fix: local STATE.md edits): apply or drop" };
    expect(checkSuggestionRestatement([withMsg], bullet).map((p) => [p.rule, p.info ?? false]))
      .toEqual([["suggestion-restates", false]]);
  });

  test("against a RESUME line that itself says pop/drop (EVAL day 51's 'needs pop/drop'): 1.00 containment, still INFO — MIN_SHARED_TOKENS is the only gate", () => {
    const popDrop = [{ repo: "personal_code", text: "stash@{0} (pre-HEAD-fix: local STATE.md edits) needs pop/drop" }];
    const out = checkSuggestionRestatement([shipped(0)], popDrop);
    expect(out.map((p) => [p.rule, p.info])).toEqual([["suggestion-restates-near", true]]);
    expect(out[0]!.detail).toContain("1.00 containment, 3 shared tokens");
    // The score gate alone WOULD fire — only the token floor keeps this row info-only.
    expect(Number(/\(([\d.]+) containment/.exec(out[0]!.detail)![1])).toBeGreaterThanOrEqual(RESTATEMENT_THRESHOLD);
  });
});

// ── RENDER ───────────────────────────────────────────────────────────────────────────────────────────
const base: BriefingStruct = { date: "2026-09-19", machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] };
const suggestedBlock = (out: string) => {
  const L = out.split("\n"); const s = L.indexOf("▶ Suggested next");
  let e = s + 1; while (e < L.length && L[e] !== "") e++;
  return L.slice(s + 1, e);
};

describe("render", () => {
  test("the label's shapes: branchless, on a branch (no name rendered), 1 day, made today, nothing known", () => {
    expect(stashLabel({ branch: "(no branch)", ageDays: 14 })).toBe("  (from stash · no branch · 14 days old)");
    expect(stashLabel({ branch: "feat/x", ageDays: 1 })).toBe("  (from stash · 1 day old)");
    expect(stashLabel({ branch: "main", ageDays: 0 })).toBe("  (from stash · made today)");
    expect(stashLabel({ branch: "(no branch)" })).toBe("  (from stash · no branch)");
    expect(stashLabel({})).toBe("  (from stash)");
  });

  // Review round 1 (lens 2) moved three COUNTED audit checks end to end through a branch name in the label.
  // Each shape, at the reader level: with the line rendered, every reader must equal the page without it.
  test("NO BRANCH NAME REACHES THE PAGE: the three branch shapes that moved counted audit flags leave every reader at base", () => {
    const sameDay = "0123abc4567def";
    const repos = [{ repo: "personal_code", labels: ["personal_code"] }, { repo: "accountant_ai", labels: ["accountant_ai"] }];
    const page = (stash?: { branch: string }) => renderBriefing({ ...base, resume: [{ repo: "personal_code", text: "Mid-way through the client." }],
      suggestions: [{ text: "[personal_code] Write the client test." },
        ...(stash ? [{ text: "Pop or drop stash@{0}", repo: "personal_code", stash: { ...stash, ageDays: 3 } }] : [])] });
    const before = page();
    for (const branch of ["fix/accountant_ai-sync", "x,aaaa111,bbbb222,y", `bisect/${sameDay.slice(0, 7)}`]) {
      const after = page({ branch });
      expect(suggestedBlock(after).at(-1)).toBe("   • [personal_code] Pop or drop stash@{0}  (from stash · 3 days old)");
      expect([branch, coverageGaps(repos, after)]).toEqual([branch, coverageGaps(repos, before)]);        // A/B: hid a flag
      expect([branch, extractCitedShas(after)]).toEqual([branch, extractCitedShas(before)]);             // C: invented SHAs
      expect([branch, missingSameDay([sameDay], after)]).toEqual([branch, missingSameDay([sameDay], before)]); // same-day
    }
    // The readers can see it: `accountant_ai` IS a gap on this page, and the same-day commit IS missing.
    expect(coverageGaps(repos, before).map((g) => g.repo)).toEqual(["accountant_ai"]);
    expect(missingSameDay([sameDay], before)).toEqual([sameDay]);
  });

  test("the shipped line, exactly, after a model suggestion; a suggestion without the field is unchanged", () => {
    const out = renderBriefing({ ...base, suggestions: [
      { text: "[accountant_ai] Fix the two-rate race" },
      { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "(no branch)", ageDays: 14 } },
    ] });
    expect(suggestedBlock(out)).toEqual([
      "   • [accountant_ai] Fix the two-rate race",
      "   • [personal_code] Pop or drop stash@{0}  (from stash · no branch · 14 days old)",
    ]);
  });

  test("the rendered line moves no audit text reader; a hex label WOULD (control)", () => {
    const withLine = (line: string) => renderBriefing({ ...base, resume: [{ repo: "personal_code", text: BACKFILL_0917 }],
      suggestions: [{ text: "[accountant_ai] Fix the race (0123abc)" }, ...(line ? [{ text: line, repo: "personal_code" }] : [])] });
    const before = withLine("");
    const after = renderBriefing({ ...base, resume: [{ repo: "personal_code", text: BACKFILL_0917 }], suggestions: [
      { text: "[accountant_ai] Fix the race (0123abc)" },
      { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "(no branch)", ageDays: 14 } }] });
    const control = withLine("Pop or drop stash@{0}  (fedcba9)");
    const repos = [{ repo: "personal_code", labels: ["personal_code"] }, { repo: "ghost", labels: ["ghost"] }];
    const day = ["0123abc4567", "fedcba98765"];
    expect(extractCitedShas(after)).toEqual(extractCitedShas(before));
    expect(missingSameDay(day, after)).toEqual(missingSameDay(day, before));
    expect(coverageGaps(repos, after)).toEqual(coverageGaps(repos, before));
    expect(extractCitedShas(control)).not.toEqual(extractCitedShas(before));
    expect(missingSameDay(day, control)).not.toEqual(missingSameDay(day, before));
  });
});

// ── (e) IN-2 ─────────────────────────────────────────────────────────────────────────────────────────
describe("IN-2's verdict-path marker cannot fire on a stash line", () => {
  test("refs 0-99 never marked, even when a pool commit on a verdict path could match any 7-hex run; a citing text IS (control)", () => {
    const pool: Activity[] = [{ source: "git", kind: "commit", event_id: "0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", repo: REPO,
      meta: { diffstat: [{ file: "quant_stocks/STATE.md", added: 1, removed: 0 }] } }];
    for (let n = 0; n < 100; n++) {
      const line: BriefingStruct["suggestions"] = [{ text: `Pop or drop stash@{${n}}`, repo: "personal_code", stash: { ageDays: 1 } }];
      const [s] = markVerdictPathSuggestions(line, pool, ["quant_stocks"]);
      expect(s!.verdictPath).toBeUndefined();
    }
    const citing: BriefingStruct["suggestions"] = [{ text: "revisit 0000000 now" }];
    expect(markVerdictPathSuggestions(citing, pool, ["quant_stocks"])[0]!.verdictPath).toBe(true);
  });
});

// ── END-TO-END: a real stash in a temp repo → runCore → struct → postcheck → render ────────────────────
async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, env: { ...process.env, ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
}
async function gitOut(args: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text(); await p.exited; return out.trim();
}
const daysAgoNoon = (n: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const mkCfg = (repos: string[], extra: Partial<Config> = {}): Config => ({
  repos, excludeCommitPatterns: [], lookbackCapDays: 30, provider: { cli: "echo", argv: [], promptVia: "stdin" }, ...extra,
});
/** A temp repo with one in-window commit and one stash made `stashDays` ago with message `msg`. */
async function repoWithStash(msg: string, stashDays: number): Promise<{ dir: string; sha: string }> {
  const dir = await buildRepo([{ file: "README.md", content: "x", isoDate: daysAgoNoon(1).toISOString() }]);
  await Bun.write(join(dir, "README.md"), "edited, then stashed");
  const at = daysAgoNoon(stashDays).toISOString();
  await git(["stash", "push", "-m", msg], dir, { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at });
  return { dir, sha: await gitOut(["rev-parse", "HEAD"], dir) };
}
const stubFor = (sha: string, suggestions: string[]) => ({ generate: async () => [
  "## RESUME", "## RECAP", `- [x] add README | evidence: ${sha.slice(0, 7)}`, "## SUGGESTIONS", ...suggestions.map((s) => `- ${s}`),
].join("\n") });
/** runCore with stderr captured — the postcheck block writes there, and it is the ordering witness. */
async function run(cfg: Config, stub: { generate: () => Promise<string> }) {
  const errs: string[] = []; const o = console.error;
  console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
  try { return { r: await runCore(cfg, { provider: stub, netProbe: async () => true }), errs }; } finally { console.error = o; }
}

describe("end-to-end (runCore)", () => {
  test("an unmarked stash: the line is appended LAST, shaped as designed, graded by postcheck, never marked by IN-2", async () => {
    const { dir, sha } = await repoWithStash("half-done parser edits", 3);
    const { r, errs } = await run(mkCfg([dir], { verdictPaths: ["README.md"] }), stubFor(sha, ["Write the parser test."]));
    const label = dir.split("/").pop()!;
    expect(r.struct.suggestions).toEqual([
      { text: "Write the parser test." },
      { text: "Pop or drop stash@{0}", repo: label, stash: { branch: "main", ageDays: 3 } },
    ]);
    // The resume backfill carries the stash's message — the line the suggestion deliberately does not repeat.
    expect(r.struct.resume.some((b) => b.text.includes("stash@{0}: On main: half-done parser edits"))).toBe(true);
    // ORDERING WITNESS: the postcheck block graded the stash line (so it was appended ABOVE that block).
    expect(errs.some((e) => e.startsWith("postcheck-info [suggestion-restates-near]") && e.includes('"Pop or drop stash@{0}"'))).toBe(true);
    expect(errs.some((e) => e.startsWith("postcheck [") && e.includes("Pop or drop"))).toBe(false);
    // The struct keeps git's branch literal; the page does not show it (a branch name moved counted audit flags).
    expect(suggestedBlock(renderBriefing(r.struct)).at(-1)).toBe(`   • [${label}] Pop or drop stash@{0}  (from stash · 3 days old)`);
  });

  test("a stash whose own message says 'not mine, parked for relay start': no line — and it still shows in RESUME", async () => {
    const { dir, sha } = await repoWithStash("autolog STATE.md — not mine, parked for relay start", 20);
    const { r } = await run(mkCfg([dir]), stubFor(sha, ["Write the parser test."]));
    expect(r.struct.suggestions).toEqual([{ text: "Write the parser test." }]);
    expect(r.struct.resume.some((b) => b.text.includes("not mine"))).toBe(true);
  });

  test("the model already named the stash: no second line", async () => {
    const { dir, sha } = await repoWithStash("half-done parser edits", 2);
    const label = dir.split("/").pop()!;
    const { r } = await run(mkCfg([dir]), stubFor(sha, [`[${label}] Pop stash@{0} before the next sync.`]));
    // WITNESS: a stash really was collected (the backfill names it) — without it this test passes vacuously.
    expect(r.struct.resume.some((b) => b.text.includes("stash@{0}: On main: half-done parser edits"))).toBe(true);
    expect(r.struct.suggestions.map((s) => s.text)).toEqual([`[${label}] Pop stash@{0} before the next sync.`]);
  });

  test("no stash: the suggestion list is exactly the model's, with no new field", async () => {
    const dir = await buildRepo([{ file: "README.md", content: "x", isoDate: daysAgoNoon(1).toISOString() }]);
    const sha = await gitOut(["rev-parse", "HEAD"], dir);
    const { r } = await run(mkCfg([dir]), stubFor(sha, ["Write the parser test."]));
    expect(r.struct.suggestions).toEqual([{ text: "Write the parser test." }]);
  });
});
