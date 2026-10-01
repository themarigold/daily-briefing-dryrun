// test/core.drift-propagation.test.ts — drift must reach the ITEMS it invalidates, not just the footer.
//
// WHY THIS EXISTS. Day-20 audit (2026-08-04) of the delivered briefing: the footer said the vault
// working tree was "now clean (auto-committed?)" while SUGGESTIONS #1 still instructed committing
// those exact files. The tool detected its own staleness and then recommended the stale action
// anyway. A reader working top-down follows the instruction and never reaches the correction, so the
// top suggestion was vacuous at read time — which is the one class of briefing content that is
// ACTIVELY misleading rather than merely incomplete.
//
// The pre-existing pins (`test/main.test.ts:341`, `test/integration.test.ts:196`) only ever asserted
// that the WARNING STRING appears. Every test here would pass with the annotation deleted, which is
// exactly how the gap survived — so these are the discriminating cases.
import { test, expect } from "bun:test";
import type { Activity } from "../src/types";
import {
  computeWorkingTreeDrift, driftWarnings, annotateStaleSuggestions, workingTreeDriftWarnings,
  mentionsPath, STALE_NOTE,
} from "../src/core";
// ⚠ Imported from the EXTRACTOR on purpose. The bidirectional re-check must use the extraction
// scan's own bound, not a second constant that can drift from it; asserting against the imported
// symbol is what makes "shared" testable rather than merely commented.
import { REPO_SCAN_CONCURRENCY } from "../src/extractor";

const dirty = (repo: string, files: string): Activity => ({
  source: "git", kind: "uncommitted", event_id: `${repo}:u`, repo,
  text: `Uncommitted changes: ${files}`,
});
const sug = (...t: string[]) => t.map((text) => ({ text }));

// ── the measurement ──────────────────────────────────────────────────────────────────────────────

test("resolved = files that WERE dirty and no longer are", async () => {
  const d = await computeWorkingTreeDrift([dirty("/r", "a.md, b.md, c.md")], ["/r"],
    async () => "b.md");
  expect(d).toHaveLength(1);
  expect(d[0]!.resolved.sort()).toEqual(["a.md", "c.md"]);   // b.md is STILL dirty — not resolved
});

test("a fully-clean repo resolves everything it was carrying", async () => {
  const d = await computeWorkingTreeDrift([dirty("/r", "a.md, b.md")], ["/r"], async () => "");
  expect(d[0]!.resolved.sort()).toEqual(["a.md", "b.md"]);
  expect(d[0]!.now).toBe("");
});

test("no drift and unverifiable drift both yield NOTHING to propagate", async () => {
  const same = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "a.md");
  expect(same).toEqual([]);
  const failed = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"],
    async () => { throw new Error("git exploded"); });
  expect(failed).toEqual([]);                 // unverifiable → silent, never a false "already done"
});

// ── the propagation (the actual fix) ─────────────────────────────────────────────────────────────

test("a suggestion naming a RESOLVED file is annotated", async () => {
  const drifts = await computeWorkingTreeDrift(
    [dirty("/vault", "0 - Daily Notes/2026-08-03.md")], ["/vault"], async () => "");
  const out = annotateStaleSuggestions(
    sug("Commit the pending vault edits in `0 - Daily Notes/2026-08-03.md`."), drifts);
  expect(out[0]!.text).toContain(STALE_NOTE);
});

test("⚠ a suggestion naming a file that is STILL DIRTY is NOT annotated", async () => {
  // THE discriminating case for the `resolved` set. Annotating on `was` instead of `was - now` marks
  // live work as already-done — a false "ignore this", which is worse than the bug being fixed:
  // the reader skips a real next step. A `resolved: fileList(d.was)` mutant passes every other test
  // in this file and fails only here.
  const drifts = await computeWorkingTreeDrift(
    [dirty("/r", "keep.md, done.md")], ["/r"], async () => "keep.md");
  const out = annotateStaleSuggestions(sug("Finish the work in keep.md"), drifts);
  expect(out[0]!.text).not.toContain(STALE_NOTE);
});

test("unrelated suggestions are untouched, and the array is not reordered", async () => {
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  const out = annotateStaleSuggestions(sug("Ship the release", "Commit done.md", "Reply to email"), drifts);
  expect(out.map((s) => s.text.includes(STALE_NOTE))).toEqual([false, true, false]);
});

test("⚠ a BARE LEAF does not match — full paths only, deliberately", async () => {
  // Reversed 2026-08-04 after a fuzz pass measured 28 false positives in 1836 prose cases, ALL of
  // this shape: a resolved `quant_stocks/STATE.md` annotating "rewrite the STATE.md in
  // daily_briefing_application". 36 duplicate basenames across 757 tracked files here. Matching a
  // bare leaf cannot distinguish them, and a false "already done" makes the reader skip real work —
  // which this file's own tests call worse than the bug being fixed. False negatives are the safe
  // direction, so the leaf fallback was removed rather than narrowed.
  const drifts = await computeWorkingTreeDrift(
    [dirty("/r", "1 - Projects/quant_stocks/STATE.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Update STATE.md and move on"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
  expect(annotateStaleSuggestions(sug("Update 1 - Projects/quant_stocks/STATE.md"), drifts)[0]!.text)
    .toContain(STALE_NOTE);            // the path the prompt actually printed still matches
});

test("annotation is IDEMPOTENT — a second pass must not stack the note", async () => {
  const drifts = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "");
  const once = annotateStaleSuggestions(sug("Commit a.md"), drifts);
  const twice = annotateStaleSuggestions(once, drifts);
  expect(twice[0]!.text).toBe(once[0]!.text);
  // ⚠ Count by SPLIT, not `new RegExp(STALE_NOTE)`: the note now contains "(committed, stashed or
  // reverted)", and unescaped parens turn it into a capture group that matches different text.
  expect(twice[0]!.text.split(STALE_NOTE)).toHaveLength(2);   // exactly one occurrence
});

test("no drift ⇒ the SAME array instance back (no needless copy on the common path)", async () => {
  const s = sug("Ship the release");
  expect(annotateStaleSuggestions(s, [])).toBe(s);
});

test("⚠ it ANNOTATES, never DROPS — the count is preserved", async () => {
  // Deliberate design choice, pinned so a later "just filter them out" refactor has to argue with a
  // test. The match is a substring test on model prose: a suggestion can name a resolved file
  // incidentally while still proposing real work.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "");
  const out = annotateStaleSuggestions(sug("Commit a.md", "Also rewrite a.md's header"), drifts);
  expect(out).toHaveLength(2);
});

// ── the warning text is unchanged by the refactor ────────────────────────────────────────────────

test("workingTreeDriftWarnings still emits the exact legacy string", async () => {
  // The public signature and output are preserved — `main.ts` re-exports this and two suites assert
  // on the literal prefix. The refactor split the measurement out beneath it; it must not show.
  const w = await workingTreeDriftWarnings([dirty("/r", "a.md")], ["/r"], async () => "");
  expect(w).toHaveLength(1);
  expect(w[0]).toContain("working-tree changed while generating: [r]");
  expect(w[0]).toContain(`was "a.md"`);
  expect(w[0]).toContain("now clean (auto-committed?)");
  expect(w[0]).toContain(`re-verify "Where you left off" before acting`);
  expect(w).toEqual(driftWarnings(await computeWorkingTreeDrift([dirty("/r", "a.md")], ["/r"], async () => "")));
});

test("⚠ an untracked DIRECTORY (trailing slash) must not annotate everything", async () => {
  // ⚠ HISTORICAL, and now only defensive. This guarded the empty BASENAME of an untracked directory
  // ("?? sub/" -> basename ""), back when basenames were added to `names`. Round 4 removed basename
  // matching entirely, so `names` holds only `meta.uncommittedFiles` entries, which are never empty —
  // the `.filter(Boolean)` can no longer fire and dropping it now survives the suite. Kept as
  // defence in depth (an empty name would spin `mentionsPath`), and this test is retained as a
  // characterisation of the directory case rather than as a pin on that guard. Labelled rather than
  // deleted so the change of status is visible.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "sub/")], ["/r"], async () => "");
  expect(drifts[0]!.resolved).toEqual(["sub/"]);
  const out = annotateStaleSuggestions(sug("Ship the release", "Reply to email"), drifts);
  expect(out.map((s) => s.text.includes(STALE_NOTE))).toEqual([false, false]);
});

test("⚠ a comma in a filename must not shatter into prose-matching tokens", async () => {
  // `was` is recovered from rendered prose and re-split on ","; a path containing a comma yields
  // short tokens ("has,comma.md" -> ["has", "comma.md"]) and a 3-char token matches ordinary
  // English. `meta.uncommittedFiles` carries the real array, so the structured list is preferred.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: has,comma.md",
    meta: { uncommittedFiles: ["has,comma.md"] },
  };
  const drifts = await computeWorkingTreeDrift([a], ["/r"], async () => "");
  expect(drifts[0]!.resolved).toEqual(["has,comma.md"]);
  expect(annotateStaleSuggestions(sug("Rewrite what has changed"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ ORDERING: the annotation runs AFTER the G5 block, not before", async () => {
  // Load-bearing, and invisible in behaviour. G5's `surface` check tests `whyValues.has(s.text)` —
  // byte equality against the BARE anchored turn — so appending STALE_NOTE before G5 runs makes a why
  // that leaked into SUGGESTIONS stop matching, silently defeating the check. MEASURED on a probe
  // struct: 1 `surface` finding unannotated, 0 annotated. `parseWhy` does not backstop it (a bare why
  // carries no frame, so it returns null).
  //
  // A source-order assertion because the constraint is positional: both orders produce an identical
  // briefing on every input that has no leaked why, so no behavioural fixture can separate them.
  const src = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
  const g5 = src.indexOf("const { g5Whys } = await import(");
  const annotate = src.indexOf("struct.suggestions = annotateStaleSuggestions(");
  // ⚠ The "still before render" half was VACUOUS as first written: it looked for `renderBriefing(`
  // in core.ts, which appears ZERO times (rendering happens in the caller), so `render === -1` and
  // the guarded assertion never executed while its comment claimed it pinned the constraint.
  // Anchored instead on the health-JSON write, which core.ts documents as running after the whys
  // projection and which is genuinely downstream of the annotation.
  const downstream = src.indexOf("T4.9: the health-JSON WRITE call site");
  expect(g5).toBeGreaterThan(-1);
  expect(annotate).toBeGreaterThan(-1);
  expect(downstream).toBeGreaterThan(-1);
  expect(annotate).toBeGreaterThan(g5);            // after the eval gate…
  expect(annotate).toBeLessThan(downstream);       // …and still upstream of the run's tail
});

test("⚠ REGRESSION GUARD: a still-dirty file with a COMMA is not reported resolved", async () => {
  // Round 1 moved the `was` side to `meta.uncommittedFiles` but left `now` split on a bare ",", so
  // the two sides disagreed: `stillDirty` held {"has","comma.md"} while `wasFiles` held the whole
  // path, the still-dirty file fell out of the set-difference and was marked resolved. That marks
  // LIVE work "already committed" — the direction this file calls worse than the original bug.
  // `uncommittedFileList` joins with ", " (git.ts:422), so that is the separator to split on.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: a.md, has,comma.md",
    meta: { uncommittedFiles: ["a.md", "has,comma.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "has,comma.md");
  expect(d[0]!.resolved).toEqual(["a.md"]);        // NOT ["a.md", "has,comma.md"]
  expect(annotateStaleSuggestions(sug("Finish the edit in has,comma.md"), d)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ path BOUNDARIES: a basename inside a longer filename must not match", async () => {
  // `core.ts` is a substring of `score.ts` — 77 such basename pairs exist in this workspace.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "src/core.ts")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Refactor src/score.ts next"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
  expect(annotateStaleSuggestions(sug("Refactor src/core.ts next"), drifts)[0]!.text)
    .toContain(STALE_NOTE);                        // …but the real path still matches
  // ⚠ The bare leaf no longer matches, by design — see the full-path-only note in `core.ts`. This
  // assertion previously read `sug("Refactor core.ts next")` and expected a MATCH; it was inverted
  // when the basename fallback was removed, not deleted, so the change stays visible here.
  expect(annotateStaleSuggestions(sug("Refactor core.ts next"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ path BOUNDARIES: a same-named file in ANOTHER project must not match", async () => {
  const drifts = await computeWorkingTreeDrift(
    [dirty("/r", "daily_briefing_application/STATE.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Update quant_stocks/STATE.md and commit"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ path BOUNDARIES: a resolved DIRECTORY must not match files under it", async () => {
  // git collapses untracked directories to "src/", which a bare `includes` matched against every
  // path beneath them. Round 1 guarded only the EMPTY basename, not the directory path itself.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "src/")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Write the parser in src/parser.ts"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ REGRESSION GUARD: a SENTENCE-FINAL period must not defeat the match", async () => {
  // Round 2's boundary fix put "." in PATH_CHAR unconditionally, so "Commit done.md." — the single
  // most common shape a suggestion takes — silently MISSED, while every other punctuation matched.
  // All four boundary tests stayed green, because none of them ended a sentence on the filename.
  // The rule is "a dot continues a path only when a word char follows", so `done.md.bak` still misses.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  const shapes = [
    "Commit done.md.", "Commit done.md, then ship", "Review done.md's header",
    "Files: done.md; then push", "Commit **done.md** now", "Commit (done.md) now",
    "Commit done.md", "Commit `done.md`",
  ];
  for (const t of shapes) {
    expect(annotateStaleSuggestions(sug(t), drifts)[0]!.text).toContain(STALE_NOTE);
  }
});

test("⚠ …but a dot FOLLOWED BY a word char still continues the path", async () => {
  // The other side of the same rule: `done.md` must not match a suggestion about `done.md.bak`.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Restore done.md.bak now"), drifts)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ HANG GUARD: the empty-name early return is present in the source", async () => {
  // `"abc".indexOf("", n)` CLAMPS to text.length instead of returning -1, so an empty name makes the
  // scan loop spin forever — in the unattended 07:20 launchd job that is a HANG, not a failed
  // briefing. Reachable input exists: git renders an untracked directory as "sub/", basename "".
  //
  // ⚠ THIS IS A SOURCE PIN, AND IT HAS TO BE. A runtime pin is IMPOSSIBLE here: the loop is
  // SYNCHRONOUS, so it blocks the single-threaded event loop and no `setTimeout`/`Promise.race`
  // watchdog can ever fire. The first version of this test used exactly that race and did not fail
  // when the guard was deleted — it wedged the whole suite instead (MEASURED: `bun test` produced no
  // "Ran N tests" line and had to be killed). A test that hangs CI is not a failing test.
  //
  // Behavioural coverage of the value: `mentionsPath("x", "")` returning false is asserted below via
  // the exported function, which is safe ONLY while the guard exists — so the source pin is what
  // protects that assertion from becoming an infinite loop rather than a red test.
  const src = await Bun.file(new URL("../src/core.ts", import.meta.url)).text();
  expect(src).toMatch(/if \(!name\) return false;/);
  expect(mentionsPath("Ship the release", "")).toBe(false);
});

test("⚠ a filename containing the SEPARATOR is not shattered", async () => {
  // `,` shattered "has,comma.md"; `", "` still shattered "x, y.md". Splitting is unfixable by choice
  // of separator — membership is now an anchored check against the joined string.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: a.md, x, y.md",
    meta: { uncommittedFiles: ["a.md", "x, y.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "x, y.md");
  expect(d[0]!.resolved).toEqual(["a.md"]);        // "x, y.md" is STILL DIRTY
});

test("⚠ a SINGLE resolved path still does not lend its leaf — uniqueness was not enough", async () => {
  // The case that defeated the first fix. Uniqueness-within-`resolved` passes trivially when only
  // one path resolved, so the bare leaf was still added and still false-matched.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: quant_stocks/STATE.md",
    meta: { uncommittedFiles: ["quant_stocks/STATE.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Write the accountant_ai STATE.md section"), d)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ an INFRA path never annotates — the model provably never saw it", async () => {
  // subprojects.ts strips infra paths before the prompt and generator.ts strips suggestions naming
  // them, so any match here is coincidental by construction.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: .claude/worktrees/dba/src/core.ts",
    meta: { uncommittedFiles: [".claude/worktrees/dba/src/core.ts"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "");
  // STRONGER than it used to be: a repo whose ONLY delta is an agent worktree now produces no drift
  // entry at all (round-2 review — the denylist gates the emission, not just `resolved`), so there
  // is nothing to annotate FROM rather than an entry with an empty `resolved`.
  expect(d).toEqual([]);
  expect(annotateStaleSuggestions(sug("Refactor core.ts to split the renderer"), d)[0]!.text)
    .not.toContain(STALE_NOTE);
});

test("⚠ a period FOLLOWED BY MORE PROSE still matches (not just end-of-string)", async () => {
  // The eight sentence-final shapes all terminated at the filename, so a mutant reading "a dot
  // continues a path unless it is the last char of the WHOLE STRING" survived the suite while
  // breaking "Commit done.md. Then push." — at least as common as ending on the filename.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("Commit done.md. Then push the branch."), drifts)[0]!.text)
    .toContain(STALE_NOTE);
});

test("⚠ a LATER occurrence matches when the first is blocked", async () => {
  // The scan loop's continuation was entirely unpinned: a single-occurrence mutant survived while
  // breaking "score.ts is fine, now do core.ts" — the first hit fails the boundary test, the second
  // passes, and only the loop finds it.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "core.ts")], ["/r"], async () => "");
  expect(annotateStaleSuggestions(sug("score.ts is fine, now do core.ts"), drifts)[0]!.text)
    .toContain(STALE_NOTE);
});

test("⚠ PATH_CHAR's dash and underscore are load-bearing", async () => {
  // Both were unpinned: dropping either from PATH_CHAR left the suite green while opening a new
  // false positive, because a longer filename would then match a shorter resolved one.
  const drifts = await computeWorkingTreeDrift([dirty("/r", "done.md")], ["/r"], async () => "");
  for (const t of ["Commit x-done.md", "Commit x_done.md", "Restore done.md._old"]) {
    expect(annotateStaleSuggestions(sug(t), drifts)[0]!.text).not.toContain(STALE_NOTE);
  }
});

test("⚠ a MULTI-FILE `now` — the only shape production produces — resolves nothing", async () => {
  // THE COVERAGE HOLE. Every other `now` stub in this file is "" or a SINGLE file, so only
  // `joinedListHas`'s `joined === f` clause ever executed. Real `git status` lists several files,
  // where membership is decided by startsWith / endsWith / includes — and each of those three could
  // be replaced with `false` and survive the entire 1002-test suite. A regression in any one makes a
  // STILL-DIRTY file report as resolved, i.e. annotating live work as gone: the worst error class,
  // and the exact bug rounds 2 and 3 both shipped. This case exercises first, middle and last
  // position at once, which exhausts the possible positions.
  // ⚠ FOUR files, and the survivor set must retain a FIRST, a MIDDLE and a LAST — that is what makes
  // each of the three clauses load-bearing. A two-file `now` is not enough: first+last alone are
  // covered by startsWith/endsWith, and the `includes(", f, ")` clause survived a mutant on the
  // earlier version of this test. An `now === was` assertion is worse than useless here — it trips
  // the equality early-return before `joinedListHas` is ever called.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: a.md, b.md, c.md, d.md",
    meta: { uncommittedFiles: ["a.md", "b.md", "c.md", "d.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r"], async () => "a.md, b.md, c.md");
  // a.md is FIRST in `now` (startsWith), b.md is MIDDLE (includes), c.md is LAST (endsWith) — all
  // three still dirty. Only d.md actually left the working tree.
  expect(d[0]!.resolved).toEqual(["d.md"]);
});

// ── the OTHER direction (day-20 finding, two sightings) ──────────────────────────────────────────
//
// The re-check walked `uncommitted` — the repos already dirty AT EXTRACTION — so drift was only ever
// observable dirty→clean. A repo clean at extraction that picked up edits during generation had no
// entry to iterate and was STRUCTURALLY invisible: not a missed match, an absent loop iteration.
// Every test above passes with the widening deleted, which is precisely how the gap survived two
// sightings; these are the discriminating cases.

test("⚠ BIDIRECTIONAL: a repo CLEAN at extraction and DIRTY at re-check now surfaces", async () => {
  // Zero `uncommitted` activities — under the old walk this could not produce anything at all.
  const d = await computeWorkingTreeDrift([], ["/r"], async () => "new.md, other.md");
  expect(d).toHaveLength(1);
  expect(d[0]!.was).toBe("");
  expect(d[0]!.now).toBe("new.md, other.md");
  expect(d[0]!.resolved).toEqual([]);      // nothing was claimed, so nothing can be invalidated
  const w = driftWarnings(d);
  expect(w[0]).toContain("working-tree changed while generating: [r]");
  expect(w[0]).toContain("was clean");     // NOT `was ""`
  expect(w[0]).toContain(`now "new.md, other.md"`);
  expect(w[0]).toContain(`re-verify "Where you left off" before acting`);
});

test("⚠ the clean→dirty direction is a WARNING ONLY — it never annotates a suggestion", async () => {
  // `resolved` means "was dirty and no longer is". A repo that only GAINED files has an empty `was`,
  // so it can never mark anything stale — the briefing's content shape is untouched by this half.
  const d = await computeWorkingTreeDrift([], ["/r"], async () => "src/core.ts");
  const s = sug("Refactor src/core.ts next", "Ship the release");
  const out = annotateStaleSuggestions(s, d);
  expect(out.map((x) => x.text.includes(STALE_NOTE))).toEqual([false, false]);
});

test("⚠ a repo unchanged at BOTH ends stays silent in either direction", async () => {
  // clean→clean is the overwhelmingly common case for a configured repo; widening the scan must not
  // turn every quiet repo into a warning.
  expect(await computeWorkingTreeDrift([], ["/r"], async () => "")).toEqual([]);
});

test("⚠ unverifiable stays SILENT for a clean-at-extraction repo too", async () => {
  // The both-directions half of the "never guess" rule: a `statusNow` that throws yields nothing, so
  // an unreadable repo cannot manufacture a "you have new uncommitted work" claim either.
  const d = await computeWorkingTreeDrift([], ["/r"], async () => { throw new Error("git exploded"); });
  expect(d).toEqual([]);
});

test("⚠ MIXED: both directions in one run, in repoPaths order, and the quiet repo omitted", async () => {
  const now: Record<string, string> = { "/a": "", "/b": "gained.md", "/c": "" };
  const d = await computeWorkingTreeDrift(
    [dirty("/a", "lost.md")], ["/a", "/b", "/c"], async (repo) => now[repo] ?? "");
  expect(d.map((x) => x.label)).toEqual(["a", "b"]);   // /c clean at both ends → absent
  expect(d[0]!.resolved).toEqual(["lost.md"]);          // dirty→clean still propagates
  expect(d[1]!.resolved).toEqual([]);                   // clean→dirty warns only
  const w = driftWarnings(d);
  expect(w[0]).toContain(`was "lost.md"`);
  expect(w[0]).toContain("now clean (auto-committed?)");
  expect(w[1]).toContain("was clean");
});

test("⚠ a dirty repo OUTSIDE repoPaths is still re-checked — the widening must not narrow", async () => {
  // The scan set is the UNION. Iterating `repoPaths` alone would silently drop an uncommitted
  // activity whose repo the caller did not list, turning this fix into a regression for the very
  // direction it is meant to preserve.
  const d = await computeWorkingTreeDrift([dirty("/elsewhere", "a.md")], ["/r"], async (repo) =>
    repo === "/elsewhere" ? "" : "");
  expect(d.map((x) => x.label)).toEqual(["elsewhere"]);
  expect(d[0]!.resolved).toEqual(["a.md"]);
});

test("⚠ INFRA paths are still dropped after the widening", async () => {
  // The denylist filter moved inside the concurrent callback; it is the one invariant the rewrite
  // could have silently lost, and losing it marks live agent-scratch work "already committed".
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: .claude/worktrees/dba/src/core.ts, real.md",
    meta: { uncommittedFiles: [".claude/worktrees/dba/src/core.ts", "real.md"] },
  };
  const d = await computeWorkingTreeDrift([a], ["/r", "/other"], async () => "");
  expect(d.map((x) => x.label)).toEqual(["r"]);   // /other was and is clean
  expect(d[0]!.resolved).toEqual(["real.md"]);    // the infra path dropped, the real one kept
});

test("⚠ one status read per repo even when a repo carries two uncommitted activities", async () => {
  // The old walk emitted one drift PER ACTIVITY; the new one is keyed by repo. A duplicate entry
  // must not double-read git nor double-warn about the same working tree.
  const calls: string[] = [];
  const d = await computeWorkingTreeDrift(
    [dirty("/r", "a.md"), dirty("/r", "b.md")], ["/r"],
    async (repo) => { calls.push(repo); return ""; });
  expect(calls).toEqual(["/r"]);
  expect(d).toHaveLength(1);
});

test("⚠ the re-check is BOUNDED-CONCURRENT — not serial, not unbounded", async () => {
  // The extraction scan already ruled that per-repo git reads must not serialize (one repo on a hung
  // mount would hold the whole run behind it). This re-check runs at the very END of a run, after the
  // model call, over EVERY configured repo — the worst possible place to re-introduce a serial walk.
  //
  // ⚠ A BARRIER, NOT A SLEEP, and the floor is a REACHED flag rather than `max === bound` (round-2
  // review). The first version slept 2ms per probe and asserted `max` EQUALLED the bound: on a
  // loaded host a worker can be descheduled between its increment and the next worker's, so `max`
  // measures BELOW the bound and the test goes red for a reason that has nothing to do with the
  // code — the exact intermittent class docs/flake-chase-2026-09-15.md was written about. Here no
  // probe can return until `REPO_SCAN_CONCURRENCY` of them are simultaneously in flight, so the
  // floor is established by construction under any load; the safety valve turns a bound that can
  // NEVER reach the barrier (a serial walk) into a clean assertion failure instead of a hang.
  // Discriminating power is unchanged in both directions: `reached` kills serial/limit-1, and
  // `<= bound` kills unbounded, where 24 concurrent probes would be measured as 24.
  const repos = Array.from({ length: REPO_SCAN_CONCURRENCY * 3 }, (_, i) => `/r${i}`);
  let release!: () => void;
  const opened = new Promise<void>((r) => { release = r; });
  const valve = setTimeout(() => release(), 2_000);
  let inFlight = 0, max = 0, reached = false;
  await computeWorkingTreeDrift([], repos, async () => {
    inFlight++; max = Math.max(max, inFlight);
    if (inFlight >= REPO_SCAN_CONCURRENCY) { reached = true; release(); }
    await opened;
    inFlight--;
    return "";
  });
  clearTimeout(valve);
  expect(reached).toBe(true);                             // FLOOR: the shared bound is actually reached
  expect(max).toBeLessThanOrEqual(REPO_SCAN_CONCURRENCY); // CEILING: never exceeds it — NOT unbounded
});

test("⚠ order is repoPaths order, NOT status-completion order", async () => {
  // `mapLimit` is order-preserving; a `Promise.all(map(...))`-with-push rewrite would emit whichever
  // repo's `git status` returned first, making the warning block non-deterministic across runs.
  const delay: Record<string, number> = { "/a": 30, "/b": 1, "/c": 15 };
  const d = await computeWorkingTreeDrift([], ["/a", "/b", "/c"], async (repo) => {
    await new Promise((r) => setTimeout(r, delay[repo] ?? 0));
    return "gained.md";
  });
  expect(d.map((x) => x.label)).toEqual(["a", "b", "c"]);
});

// ── the denylist gates EMISSION and RENDER, not just `resolved` ───────────────────────────────────
//
// Round-2 review finding. The filter was applied to `wasFiles` only, so the DECISION to emit was
// `now === was` on the raw `git status` strings and the printed `was`/`now` were raw too. While only
// already-dirty repos were re-read that was invisible; once every contributing repo is re-read, an
// agent worktree appearing in an otherwise-clean repo is enough to tell the reader their pending
// work changed. `resolveUnits` (subprojects.ts) and `applySuggestionGuards` (generator.ts) already assert that the model PROVABLY
// never saw an INFRA path, so a warning built on one is a claim about work the briefing never made.

test("⚠ INFRA-ONLY delta in a clean repo emits NOTHING (denylist gates the EMISSION)", async () => {
  // The case the first INFRA test could not fail: it asserted `d[0].resolved`, which requires an
  // entry to exist. With the emission path unfiltered this returns one drift and a warning.
  expect(await computeWorkingTreeDrift([], ["/r"], async () => ".claude/worktrees/dba/src/core.ts"))
    .toEqual([]);
});

test("⚠ INFRA-ONLY delta in a DIRTY repo emits NOTHING either — both sides are filtered", async () => {
  // Same shape in the dirty→? direction: the real file is dirty at both ends and only an agent
  // worktree came or went. Filtering one side alone would leave `was !== now` and warn.
  const a: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: .claude/worktrees/x/a.ts, real.md",
    meta: { uncommittedFiles: [".claude/worktrees/x/a.ts", "real.md"] },
  };
  expect(await computeWorkingTreeDrift([a], ["/r"], async () => "real.md")).toEqual([]);
});

test("⚠ a REAL delta still surfaces, with the INFRA path stripped from the printed sides", async () => {
  // Filtering must not swallow the finding — only the agent-scratch noise inside it. The reader is
  // shown the files they can act on, never `.claude/worktrees/...`.
  const d = await computeWorkingTreeDrift([], ["/r"], async () => ".claude/worktrees/x/a.ts, new.md");
  expect(d).toHaveLength(1);
  expect(d[0]!.now).toBe("new.md");                       // the infra entry is not printed
  expect(driftWarnings(d)[0]).not.toContain(".claude/worktrees");
  expect(driftWarnings(d)[0]).toContain(`now "new.md"`);
});

test("⚠ an uncommitted activity with an EMPTY file list behaves exactly like a clean repo", async () => {
  // Adjudicating the empty-string-vs-clean confusion raised in review: `was` is "" for BOTH a repo
  // with no activity and an activity carrying no files, and the two must stay indistinguishable —
  // an empty measurement is a measurement of nothing pending, in either shape.
  const empty: Activity = {
    source: "git", kind: "uncommitted", event_id: "r:u", repo: "/r",
    text: "Uncommitted changes: ", meta: { uncommittedFiles: [] },
  };
  expect(await computeWorkingTreeDrift([empty], ["/r"], async () => "")).toEqual([]);
  const d = await computeWorkingTreeDrift([empty], ["/r"], async () => "new.md");
  expect(d).toHaveLength(1);
  expect(d[0]!.was).toBe("");
  expect(driftWarnings(d)[0]).toContain("was clean");     // not `was ""`
  expect(d[0]!.resolved).toEqual([]);
});

// ── the clean→dirty AUDIENCE is the repos that contributed ───────────────────────────────────────

test("⚠ a DISCOVERY-ONLY repo going clean→dirty produces NO warning", async () => {
  // Discovery walks two levels under each root, so a typical home directory configures dozens of
  // repos the author-filtered briefing never mentions. A build artefact landing in one of them must
  // not advise re-verifying a "Where you left off" section that says nothing about it.
  const d = await computeWorkingTreeDrift([], ["/contrib", "/vendored"], async () => "out.log",
    ["/contrib"]);
  expect(d.map((x) => x.label)).toEqual(["contrib"]);
});

test("⚠ a non-contributing repo that was DIRTY at extraction is still re-checked", async () => {
  // The two directions have different audiences on purpose: dirty→clean invalidates a claim the
  // briefing already made (its files can annotate a suggestion), so it keeps the wider audience.
  const d = await computeWorkingTreeDrift([dirty("/vendored", "a.md")], ["/contrib", "/vendored"],
    async () => "", ["/contrib"]);
  expect(d.map((x) => x.label)).toEqual(["vendored"]);
  expect(d[0]!.resolved).toEqual(["a.md"]);
});

test("⚠ a non-contributing repo is never even PROBED", async () => {
  // Not just silent — unspawned. The re-check runs at the very end of a run, after the model call;
  // each `git status` is bounded only by GIT_TIMEOUT_MS (30s), so probing repos that can contribute
  // no trustworthy measurement is wall time paid for nothing.
  const probed: string[] = [];
  await computeWorkingTreeDrift([], ["/contrib", "/vendored"],
    async (repo) => { probed.push(repo); return ""; }, ["/contrib"]);
  expect(probed).toEqual(["/contrib"]);
});
