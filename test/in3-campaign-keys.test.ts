// test/in3-campaign-keys.test.ts — IN-3 Stage 1b: the deterministic campaign-key tiers of
// `clusterRecap`, and the constraints that bound them.
//
// The tiers, evaluated in order (Part 1 §8, corrected by Part 2 and by review round 1):
//   1. (DROPPED in review round 1.) Prose/manifest demotion in `dominantFile` was shipped and then
//      removed by a rule declared before measuring — never longer than the file key alone on any of
//      17 windows, and no suppressed campaign merge. As shipped it was longer on 2026-09-17 and
//      suppressed two correct campaigns; narrowed to `.claude/**` it still suppressed day 49's
//      `M7.5a — 5 commits`. The "no prose demotion" block below pins both shapes, so it cannot come back
//      silently. The tier numbers are kept so the review record still reads.
//   2. campaign token from the commit's RAW SUBJECT (`Activity.text`, git data) — a FROZEN
//      vocabulary of token shapes, first match wins, in an ORDER corrected in review so a milestone
//      (`M8`) outranks the sub-item every milestone reuses (`M-a`).
//   3. leading phrase over the subject with the conventional-commit prefix stripped and a stopword
//      guard (a token that could NAME a commit is skipped too — `isExtractableSha`, the resolver's own
//      extraction rule; review rounds 2–3). ⚠ On the day-49..52 rendered population
//      tier 3 changes NOTHING under the strict reading (deleting it leaves those four days
//      byte-identical); its measured yield is on unseen
//      windows — `phase c` on the cold hold-out, `phase b` on a fresh one. The tier-3 cases below are
//      UNIT tests of the keying mechanism on synthetic windows, not day-51 reproductions.
//   4. #410's dominant-file key, unchanged, as the fallback it already is — and, with tier 1 gone,
//      byte-identical to `main`'s.
//   A campaign is scoped to the commit's GIT UNIT (repo + sub-project root) AND the bullet's label;
//   its header carries the day-53 denominator when the unit holds more carriers than it groups.
//
// CONSTRAINTS, each with a pin that a mutation turns red:
//   · WIDEN-ONLY (property test below). Tiers 2–3 may MERGE whole file clusters or ABSORB
//     singletons; they never SPLIT a cluster the file key already formed. Part 1 §4.3b measured the
//     regression when a campaign key overrides per entry: day 51's 12-member `STATE.md` cluster was
//     pulled apart into `suite count` / `GATE-S` / rest and the day got WORSE (23 → 25) while the
//     total still looked like a normal run. The line count cannot see it; only the property can.
//     The "pre" clusters are obtained through the public API alone, by running `clusterRecap` over
//     the same window with every subject blanked, which leaves tiers 2–3 nothing to read. With tier 1
//     dropped those ARE the pre-IN-3 file clusters, so the property is now the global one Part 1
//     proposed (it was scoped to tiers 2–3 only because tier 1 legitimately changed the atoms).
//   · DETERMINISM. Tiers 2–3 read `Activity.text` (the git subject) and NEVER `entry.text` (model
//     prose): `generator.ts`'s docblock and `types.ts`'s `group?` contract both promise it, and Part 1
//     §4.2 measured token coverage on model prose swinging 20 % → 71 % day to day. Pinned by re-wording
//     every bullet between two runs. The bullet's LABEL is also model prose; review round 1 moved the
//     campaign's scope onto git (the unit), so inside `clusterRecap` a label cannot JOIN commits git
//     keeps apart — pinned by re-labelling bullets between two runs as well. That was NOT yet true on
//     the page (review round 2): render.ts nests by label + stamp TEXT, so two same-named campaigns
//     from different units printed as one header. Pinned at the RENDERED level below ("ONE NAME PER
//     BRACKET"), and through `generateBriefing` so the production call site cannot drop the unit lane.
//   · NO LABEL THE AUDIT'S SAME-DAY SCAN CAN READ (review round 4). A campaign header is text
//     `audit.missingSameDay` scans for commit-SHA prefixes, and a read moves a counted flag the
//     comparability boundary preserves. Rounds 2–3 closed it one token shape at a time; the rule is
//     now one guard where the label is final (`readsAsSameDaySha`), pinned per shape through the
//     rendered page, and coupled to the scan — which is eval scoring logic and is not touched — by an
//     equivalence test that treats `missingSameDay` as a black box and cannot pass on an empty corpus.
import { test, expect, describe } from "bun:test";
import { clusterRecap, campaignKey, generateBriefing, norm, readsAsSameDaySha } from "../src/generator";
import { renderBriefing } from "../src/render";
import { missingSameDay } from "../src/audit";
import type { ReducedContext, Activity, Provider } from "../src/types";

type Row = { file: string; added: number; removed: number };
const d2 = "2026-09-02T10:00:00-07:00", d3 = "2026-09-03T10:00:00-07:00", d4 = "2026-09-04T10:00:00-07:00";
const commit = (sha: string, subject: string, diffstat: Row[], iso = d4, repo = "/r"): Activity =>
  ({ source: "git", kind: "commit", event_id: sha, repo, timestamp: iso, text: subject, meta: { diffstat } });
const ctxOf = (acts: Activity[], repo = "/r"): ReducedContext => ({ repos: [{ repo, summary: "", activities: acts }] });
const row = (file: string, churn = 10): Row => ({ file, added: churn, removed: 0 });
type Entry = { repo: string; text: string; evidence?: string; group?: string };
const bullets = (lane: string, acts: Activity[]): Entry[] => acts.map((a) => ({ repo: lane, text: `prose ${a.event_id}`, evidence: a.event_id }));
// Top-level recap lines as render.ts would emit them: one per cluster + one per ungrouped bullet.
const topLevel = (out: Entry[]): number => {
  const clusters = new Set<string>(); let flat = 0;
  for (const e of out) { if (e.group) clusters.add(`${norm(e.repo)}\x1f${e.group}`); else flat++; }
  return clusters.size + flat;
};
// What render.ts actually DRAWS — read off the rendered text, not off `clusterRecap`'s stamps, because the
// defect this guards lived in the seam between the two: every header line, the name it prints (per
// bracket, case-folded), the count it states, and the DISTINCT commits nested under it.
const drawn = (out: Entry[]) => {
  const L = renderBriefing({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [], recap: out }).split("\n");
  const hs: { line: string; name: string; stated: number; nested: number }[] = [];
  for (let i = 0; i < L.length; i++) {
    const h = /^ {3}• \[([^\]]+)\] (.+) — (\d+)(?: of \d+)? commits?\b/.exec(L[i]!);
    if (!h || !/^ {6}◦ /.test(L[i + 1] ?? "")) continue;
    const shas = new Set<string>();
    for (let j = i + 1; /^ {6}◦ /.test(L[j] ?? ""); j++) shas.add(/\(([^()]+)\)$/.exec(L[j]!)![1]!);
    hs.push({ line: L[i]!.trim(), name: `${norm(h[1]!)}|${h[2]!.toLowerCase()}`, stated: Number(h[3]), nested: shas.size });
  }
  return hs;
};

// Deterministic PRNG so a failing seed is reproducible from its number alone (the widen-only property
// and round 4's label corpus).
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── The widen-only property ──────────────────────────────────────────────────────────────────────
describe("IN-3 widen-only: tiers 2–3 never split a file cluster (property)", () => {
  const LANES = ["accountant_ai", "quant_stocks"];
  const FILES = ["agent/loop.py", "agent/spike_run.py", "db/schema.sql", "live/admin.py", "STATE.md", "tests/test_x.py"];
  const TOKENS = ["M8", "IM3", "P1", "rev 13", "spec §1 M-a", "GATE-S", "day-51", "T17", "checkpoint-C", "spec D-2"];
  const PHRASES = ["provider seam", "suite count", "admin restore", "delisting convention"];
  const FILLER = ["the", "two", "fix", "pin the", "landed", "tightened", "review round", "polish", "and", "gate"];
  const PREFIX = ["feat(accountant_ai): ", "fix(quant_stocks): ", "docs: ", "chore(state): ", ""];
  const pick = <T,>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

  const buildWindow = (seed: number) => {
    const r = mulberry32(seed);
    const n = 8 + Math.floor(r() * 20);
    const acts: Activity[] = []; const lanes: string[] = [];
    for (let i = 0; i < n; i++) {
      const sha = (0x100000 + Math.floor(r() * 0xefffff)).toString(16).padStart(7, "a") + i.toString(16).padStart(3, "0");
      const lane = pick(r, LANES);
      const rows: Row[] = [];
      const k = 1 + Math.floor(r() * 3);
      for (let j = 0; j < k; j++) rows.push({ file: pick(r, FILES), added: Math.floor(r() * 60), removed: Math.floor(r() * 10) });
      const parts: string[] = [];
      if (r() < 0.5) parts.push(pick(r, TOKENS));
      if (r() < 0.5) parts.push(pick(r, PHRASES));
      parts.push(pick(r, FILLER), pick(r, FILLER));
      // shuffle the parts so tokens and phrases appear at any position
      for (let a = parts.length - 1; a > 0; a--) { const b = Math.floor(r() * (a + 1)); [parts[a], parts[b]] = [parts[b]!, parts[a]!]; }
      const subject = pick(r, PREFIX) + parts.join(" ");
      acts.push(commit(sha, subject, rows, r() < 0.5 ? d3 : d4, r() < 0.2 ? "/other" : "/r"));
      lanes.push(lane);
    }
    // one bullet per commit, occasionally a second citing the same commit, in shuffled order
    const recap: Entry[] = acts.map((a, i) => ({ repo: lanes[i]!, text: `prose ${i}`, evidence: a.event_id }));
    if (r() < 0.3) recap.push({ ...recap[Math.floor(r() * recap.length)]!, text: "cited twice" });
    for (let a = recap.length - 1; a > 0; a--) { const b = Math.floor(r() * (a + 1)); [recap[a], recap[b]] = [recap[b]!, recap[a]!]; }
    const ctx: ReducedContext = { repos: [
      { repo: "/r", summary: "", activities: acts.filter((a) => a.repo === "/r") },
      { repo: "/other", summary: "", activities: acts.filter((a) => a.repo === "/other") },
    ] };
    // The ATOMS: the same window with every subject blanked, so tiers 2–3 have nothing to read and
    // the output is exactly the tier-4 file keying (= main's, now that tier 1 is dropped).
    const blank: ReducedContext = { repos: ctx.repos.map((rr) => ({ ...rr, activities: rr.activities.map((a) => ({ ...a, text: "" })) })) };
    return { recap, ctx, blank };
  };

  test("over 2000 seeded windows: every file atom lands WHOLE in one post-tier group, and the line count never rises", () => {
    let atomsSeen = 0, mergesSeen = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const { recap, ctx, blank } = buildWindow(seed);
      const atoms = clusterRecap(recap, blank);
      const full = clusterRecap(recap, ctx);
      const atomId = (i: number) => (atoms[i]!.group ? `${norm(recap[i]!.repo)}\x1f${atoms[i]!.group}` : undefined);
      for (let i = 0; i < recap.length; i++) {
        const ai = atomId(i);
        if (!ai) continue;
        atomsSeen++;
        for (let j = i + 1; j < recap.length; j++) {
          if (atomId(j) !== ai) continue;
          // i and j were one file cluster before tiers 2–3 ran → they must still share ONE stamp.
          if (full[i]!.group === undefined || full[i]!.group !== full[j]!.group) {
            throw new Error(`seed ${seed}: atom "${ai.split("\x1f")[1]}" split — bullet ${i} → ${full[i]!.group} | bullet ${j} → ${full[j]!.group}`);
          }
        }
      }
      // Widen-only's arithmetic corollary: merging and absorbing can only lower the count.
      const before = topLevel(atoms), after = topLevel(full);
      if (after > before) throw new Error(`seed ${seed}: top-level rose ${before} → ${after}`);
      if (after < before) mergesSeen++;
      // presentation-only, always
      expect(full.map((e) => e.text)).toEqual(recap.map((e) => e.text));
      expect(full.map((e) => e.evidence)).toEqual(recap.map((e) => e.evidence));
    }
    // Non-vacuity: the generator must actually have produced atoms to protect and campaigns that fired.
    // Margins measured at round 1: atomsSeen 28129 (it counts grouped BULLETS, so it is met trivially)
    // and mergesSeen 134 of 2000 windows. 300 seeds gave 26 merges against a floor of 20 — a floor a
    // generator tweak could trip and a mutant removing a quarter of all merges could pass — hence the
    // larger run: a no-op still scores 0, and a spurious trip needs merges to fall by more than half.
    expect(atomsSeen).toBeGreaterThan(100);
    expect(mergesSeen).toBeGreaterThan(60);
    // ⚠ ITS OWN TIMEOUT, not bun's 5 s default: 2000 windows measured ~1.9 s alone (bun 1.3.14) and timed
    // out under a loaded full-suite run (known item 5, Phase E final harden). The seed count and both
    // floors above are the property; only the wall-clock allowance changed.
  }, 30_000);

  test("the day-51 shape: a 12-member STATE.md cluster with mixed campaign keys is not pulled apart", () => {
    // Part 1 §4.3b, the measured regression: 7 of the 12 lead with "suite count", 3 carry GATE-S,
    // 2 are review-round subjects with no key. `suite count` and `GATE-S` each have a second carrier
    // in the lane (a singleton elsewhere), so either could form a campaign. A per-entry override sends
    // 7 one way, 3 another and leaves 2 — three headers where the judge endorsed one. Widen-only keeps
    // all 12 together.
    const sm = (i: number, subj: string) => commit(`aaaa${String(i).padStart(3, "0")}`, subj, [row("quant_stocks/STATE.md", 40), row("quant_stocks/tests/test_x.py", 5)]);
    const members = [
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => sm(i, `docs(quant_stocks): suite count ${2300 + i} after round ${i}`)),
      ...[8, 9, 10].map((i) => sm(i, `docs(quant_stocks): GATE-S readout ${i} recorded in STATE`)),
      sm(11, "fix(quant_stocks): Round-1 review fixes — delta arithmetic, stale comment"),
      sm(12, "fix(quant_stocks): Round-2 findings fixed — LockTimeout, atomic parquet writes"),
    ];
    const others = [
      commit("bbbb001", "feat(quant_stocks): suite count tripwire in CI", [row("quant_stocks/ci.py", 30)]),
      commit("bbbb002", "feat(quant_stocks): GATE-S gate wired into the runner", [row("quant_stocks/runner.py", 30)]),
    ];
    const out = clusterRecap(bullets("quant_stocks", [...members, ...others]), ctxOf([...members, ...others]));
    const stamps = new Set(out.slice(0, 12).map((e) => e.group));
    expect(stamps.size).toBe(1);
    // …and under the STRICT reading it stays the FILE cluster: 7 of 12 saying `suite count` does
    // not rename the other five. The permissive reading (atom follows its plurality key) would stamp
    // all 12 `suite count — 12 commits`; that reading was measured and rejected — see the next test.
    expect([...stamps][0]).toBe("quant_stocks/STATE.md — 12 commits (Sep 4)");
  });

  test("STRICT, not permissive: a lone carrier never drags its whole file cluster under its key", () => {
    // A day-52 shape. Under permissive, `live/prices.py`'s 3-member atom followed `round 1` on ONE
    // vote — `124c5e2 round-1 findings` — because the other two members' keys (`final round`, `P3`)
    // were lone carriers and did not count; it then merged with an unrelated `core` review round into
    // one 4-commit header (rendered `P3 — 4 commits` by the label line, since the label is the
    // smallest spelling among all members). A review round is an activity, not a campaign (Part 1
    // §4.3 rule G). The decisive day-52 case is larger — twelve commits under one checkpoint id where
    // strict renders three headers — and roughly half of permissive's extra merges ARE correct
    // (`rev 13 — 3`); strict is chosen because the bad half is unbounded. Measured cost on days 49–52
    // after review round 1: strict 80 top-level lines, permissive 69, the file key alone 90. Both
    // tables are in the commit message, so the choice is reversible.
    const acts = [
      commit("07d1de8", "fix(live): final-round findings — the marker gates the merge", [row("quant_stocks/live/prices.py", 30)]),
      commit("124c5e2", "fix(live): round-1 findings — the split HOLD is persistent", [row("quant_stocks/live/prices.py", 20)]),
      commit("68b55aa", "feat(live): P3 sigma-integrity guards — signed 2026-09-04", [row("quant_stocks/live/prices.py", 25)]),
      commit("8d563d5", "fix(core): round-1 review findings — replication targets", [row("quant_stocks/core/repl.py", 40)]),
    ];
    const out = clusterRecap(bullets("quant_stocks", acts), ctxOf(acts));
    expect(out[0]!.group).toBe("quant_stocks/live/prices.py — 3 commits (Sep 4)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out[2]!.group).toBe(out[0]!.group);
    expect(out[3]!.group).toBeUndefined();
    expect(out.some((e) => e.group?.startsWith("round 1"))).toBe(false);
    expect(out.every((e) => e.group === undefined || e.group === out[0]!.group)).toBe(true);   // no campaign at all
  });
});

// ── Determinism: the stamp reads git data, never model prose ────────────────────────────────────
describe("IN-3 determinism: tiers 2–3 read Activity.text, never entry.text", () => {
  test("re-wording every bullet between two runs of the same window leaves the stamps identical", () => {
    const acts = [
      commit("aaaa111", "feat(accountant_ai): M8 context assembly", [row("agent/context.py")]),
      commit("bbbb222", "fix(accountant_ai): M8 provenance stamp on every row", [row("agent/provenance.py")]),
      commit("cccc333", "chore(accountant_ai): bump the lockfile", [row("bun.lock")]),
    ];
    const ctx = ctxOf(acts);
    // Run A: prose carries nothing. Run B: the model re-worded every bullet and put a DECOY token
    // (`IM3`) in all three — a tier reading `entry.text` groups all three under IM3 in run B and
    // nothing in run A. The subjects say M8 on two of them, both runs, and that is what decides.
    const runA = clusterRecap([
      { repo: "accountant_ai", text: "assembled the context window", evidence: "aaaa111" },
      { repo: "accountant_ai", text: "stamped provenance on rows", evidence: "bbbb222" },
      { repo: "accountant_ai", text: "lockfile bump", evidence: "cccc333" },
    ], ctx);
    const runB = clusterRecap([
      { repo: "accountant_ai", text: "IM3 context window assembled", evidence: "aaaa111" },
      { repo: "accountant_ai", text: "IM3 provenance rows stamped", evidence: "bbbb222" },
      { repo: "accountant_ai", text: "IM3 lockfile bump", evidence: "cccc333" },
    ], ctx);
    expect(runA.map((e) => e.group)).toEqual(runB.map((e) => e.group));
    expect(runA[0]!.group).toBe("M8 — 2 commits (Sep 4)");
    expect(runA[1]!.group).toBe(runA[0]!.group);
    expect(runA[2]!.group).toBeUndefined();
    // and a plain same-input re-run is byte-identical
    expect(clusterRecap(runA.map((e) => ({ repo: e.repo, text: e.text, evidence: e.evidence })), ctx)).toEqual(runA);
  });
  // The GIT UNIT, threaded the way `generateBriefing` does (`units`, `rootsByRepo`).
  const rbr = new Map([["/r", ["accountant_ai", "quant_stocks"]]]);
  test("re-LABELLING bullets between two runs cannot join commits git keeps apart (the lane is the git unit)", () => {
    const acts = [
      commit("aaaa111", "feat(accountant_ai): M8 context assembly", [row("accountant_ai/agent/context.py")]),
      commit("bbbb222", "fix(accountant_ai): M8 provenance stamp", [row("accountant_ai/agent/provenance.py")]),
      commit("cccc333", "chore(accountant_ai): bump the lockfile", [row("accountant_ai/bun.lock")]),
      commit("dddd444", "feat(quant_stocks): M8 ledger contract", [row("quant_stocks/core/ledger.py")]),
    ];
    const ctx = ctxOf(acts);
    // Run A: every bullet labelled as its unit. Run B: the model spells two labels differently
    // (norm-equivalent) AND files the quant_stocks M8 commit under [accountant_ai]. Under a label
    // lane run B grows `M8 — 3 commits`, mixing two units' milestones; under the git unit it cannot.
    const runA = clusterRecap([
      { repo: "accountant_ai", text: "a", evidence: "aaaa111" }, { repo: "accountant_ai", text: "b", evidence: "bbbb222" },
      { repo: "accountant_ai", text: "c", evidence: "cccc333" }, { repo: "quant_stocks", text: "d", evidence: "dddd444" },
    ], ctx, [], rbr);
    const runB = clusterRecap([
      { repo: "Accountant_AI", text: "a", evidence: "aaaa111" }, { repo: "**accountant_ai**", text: "b", evidence: "bbbb222" },
      { repo: "accountant_ai", text: "c", evidence: "cccc333" }, { repo: "accountant_ai", text: "d", evidence: "dddd444" },
    ], ctx, [], rbr);
    expect(runB.map((e) => e.group)).toEqual(runA.map((e) => e.group));
    expect(runA[0]!.group).toBe("M8 — 2 commits (Sep 4)");
    expect(runA[1]!.group).toBe(runA[0]!.group);
    expect(runA[3]!.group).toBeUndefined();
  });
  test("a label that SPLITS a campaign is visible: the header keeps git's denominator, never quotes it twice", () => {
    // What the model's label can still do — the same partition render.ts applies to every cluster
    // (tier 4's file clusters included; recorded as a pre-existing residual). A campaign spanning two
    // labels would print its header under each, quoting the whole count over part of it; instead
    // each label keeps its own members, and git's denominator shows what the split left out.
    const m8 = (sha: string, f: string) => commit(sha, `fix(accountant_ai): M8 ${f}`, [row(`accountant_ai/agent/${f}.py`)]);
    const acts = [m8("aaaa111", "context"), m8("bbbb222", "provenance"), m8("cccc333", "replay"), m8("dddd444", "ledger")];
    const three = clusterRecap([
      { repo: "accountant_ai", text: "a", evidence: "aaaa111" }, { repo: "accountant_ai", text: "b", evidence: "bbbb222" },
      { repo: "Accountant AI", text: "c", evidence: "cccc333" },
    ], ctxOf(acts.slice(0, 3)), [], rbr);
    expect(three[0]!.group).toBe("M8 — 2 of 3 commits naming it (grouped: Sep 4)");
    expect(three[1]!.group).toBe(three[0]!.group);
    expect(three[2]!.group).toBeUndefined();
    // Two labels each holding a whole campaign: two headers, each counting only its own members, and
    // neither quotes the shared denominator (4), which a reader summing the two would double.
    const four = clusterRecap([
      { repo: "accountant_ai", text: "a", evidence: "aaaa111" }, { repo: "accountant_ai", text: "b", evidence: "bbbb222" },
      { repo: "Accountant AI", text: "c", evidence: "cccc333" }, { repo: "Accountant AI", text: "d", evidence: "dddd444" },
    ], ctxOf(acts.slice(0, 4)), [], rbr);
    expect(four.map((e) => e.group)).toEqual(["M8 — 2 commits (Sep 4)", "M8 — 2 commits (Sep 4)", "M8 — 2 commits (Sep 4)", "M8 — 2 commits (Sep 4)"]);
    expect(topLevel(four)).toBe(2);
    // …and every header render.ts would draw (one per label + stamp) nests at least two of its OWN
    // label's commits — never a header over a lone bullet whose partners sit under another label.
    for (const out of [three, four]) for (const e of out) if (e.group)
      expect(new Set(out.filter((x) => x.group === e.group && norm(x.repo) === norm(e.repo)).map((x) => x.evidence)).size).toBeGreaterThan(1);
  });
  test("ONE NAME PER BRACKET: 2+2 same-token campaigns from two git units never render as one header (read off the page)", () => {
    // Review round 2's MED, a regression from round 1. The unit lane made these TWO campaigns; render.ts
    // nests by label + stamp TEXT, so with equal counts and dates they printed ONE header —
    // `[accountant_ai] M8 — 2 commits (Sep 4)` with FOUR bullets nested under it. 1+1 never showed it
    // (a one-atom campaign already falls back to its file); 2+2 does. Both dissolve to their file
    // clusters, the refusal `wider` makes for a shared file denominator.
    const m8 = (sha: string, unit: string, f: string) => commit(sha, `fix(${unit}): M8 ${f}`, [row(`${unit}/core/${f}.py`)]);
    const acc = [m8("aaaa111", "accountant_ai", "context"), m8("bbbb222", "accountant_ai", "provenance")];
    const qs = [m8("cccc333", "quant_stocks", "ledger"), m8("dddd444", "quant_stocks", "rounding")];
    // …and the catch-all (repo-root files, no sub-project root) is a unit of its own too.
    const root = [commit("eeee555", "chore: M8 run-state checkpoint", [row("STATE.md")]), commit("ffff666", "docs: M8 runbook", [row("docs/m8-runbook.md")])];
    for (const other of [qs, root]) {
      const acts = [...acc, ...other];
      const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts), [], rbr);
      for (const h of drawn(out)) expect(`${h.line} over ${h.nested}`).toBe(`${h.line} over ${h.stated}`);
      expect(out.map((e) => e.group)).toEqual([undefined, undefined, undefined, undefined]);
      // each unit ALONE still forms its campaign — the dissolve is the collision's, not the token's
      const alone = clusterRecap(bullets("accountant_ai", other), ctxOf(acts), [], rbr);
      expect(alone.map((e) => e.group)).toEqual(["M8 — 2 commits (Sep 4)", "M8 — 2 commits (Sep 4)"]);
    }
    // Unequal counts never merged on the page, but printed `M8` twice in one bracket — `M8 — 2 of 3
    // commits naming it` beside `M8 — 2 commits` — with nothing to say which is which. Same rule.
    const acts = [...acc, m8("abab777", "accountant_ai", "replay"), ...root];
    const out = clusterRecap(bullets("accountant_ai", [...acc, ...root]), ctxOf(acts), [], rbr);
    expect(out.every((e) => e.group === undefined)).toBe(true);
    // Different BRACKETS are different headers on the page, so the same name there is left alone.
    const split = clusterRecap([...bullets("accountant_ai", acc), ...bullets("quant_stocks", qs)], ctxOf([...acc, ...qs]), [], rbr);
    expect(split.map((e) => e.group)).toEqual(Array(4).fill("M8 — 2 commits (Sep 4)"));
    expect(drawn(split).map((h) => h.line)).toEqual(["• [accountant_ai] M8 — 2 commits (Sep 4)", "• [quant_stocks] M8 — 2 commits (Sep 4)"]);
  });
  test("ONE NAME PER BRACKET is keyed on the NAME printed, not the token: `rev 13` (tier 2) and `rev-13 …` (tier 3) in ONE unit", () => {
    // The same collision without any unit lane — pre-existing since the original build, on the 2-arg path
    // too. The hyphen defeats `revn`, so `rev-13 export` keys the tier-3 PHRASE `rev 13`: two different
    // keys, one printed name, one header `rev 13 — 2 commits` over four bullets. A dissolve keyed on the
    // token would not see it. The name is CASE-FOLDED: spelled `Rev 13`, the two headers no longer merge
    // on the page, but `Rev 13 — 2 commits` beside `rev 13 — 2 commits` is still one name printed twice.
    for (const rev of ["rev 13", "Rev 13"]) {
      const acts = [
        commit("aaaa111", `feat: ${rev} ledger contract`, [row("core/ledger.py")]),
        commit("bbbb222", `fix: ${rev} rounding`, [row("core/rounding.py")]),
        commit("cccc333", "feat: rev-13 export path", [row("core/export.py")]),
        commit("dddd444", "fix: rev-13 import path", [row("core/import.py")]),
      ];
      expect(acts.map((a) => campaignKey(a.text!)?.key)).toEqual(["revn:rev 13", "revn:rev 13", "phrase:rev 13", "phrase:rev 13"]);
      for (const out of [clusterRecap(bullets("accountant_ai", acts), ctxOf(acts)), clusterRecap(bullets("accountant_ai", acts), ctxOf(acts), [], rbr)]) {
        for (const h of drawn(out)) expect(`${h.line} over ${h.nested}`).toBe(`${h.line} over ${h.stated}`);
        expect(out.every((e) => e.group === undefined)).toBe(true);
      }
    }
  });
  test("END-TO-END through generateBriefing: the production call site threads the unit lane (a relabel cannot join units)", () => {
    // Every unit-lane test above calls `clusterRecap` directly. Review round 2 measured the call site
    // unpinned: `generateBriefing` passing only (recap, ctx) survived the whole suite, and production's
    // unit lane would have regressed to the label lane with nothing noticing. This drives the delivery
    // path with the model filing a quant_stocks M8 commit under [accountant_ai]: threaded, it stays out
    // (`M8 — 2 commits`); on the label lane it would join (`M8 — 3 commits`).
    const acts = [
      commit("aaaa111", "feat(accountant_ai): M8 context assembly", [row("accountant_ai/agent/context.py")]),
      commit("bbbb222", "fix(accountant_ai): M8 provenance stamp", [row("accountant_ai/agent/provenance.py")]),
      commit("dddd444", "feat(quant_stocks): M8 ledger contract", [row("quant_stocks/core/ledger.py")]),
    ];
    const provider: Provider = { generate: async () => [
      "## RESUME", "- [accountant_ai] resume", "## RECAP",
      "- [accountant_ai] context assembled | evidence: aaaa111",
      "- [accountant_ai] provenance stamped | evidence: bbbb222",
      "- [accountant_ai] ledger contract | evidence: dddd444",
      "## SUGGESTIONS", "- x",
    ].join("\n") };
    return generateBriefing(ctxOf(acts), provider, { date: "2026-09-05", machineScope: "h", provider: "p" }, [], rbr).then((b) => {
      expect(b.recap.map((e) => e.evidence)).toEqual(["aaaa111", "bbbb222", "dddd444"]);
      expect(b.recap.map((e) => e.group)).toEqual(["M8 — 2 commits (Sep 4)", "M8 — 2 commits (Sep 4)", undefined]);
    });
  });
});

// ── Tier 1 DROPPED: no prose demotion — the two shapes that decided it ─────────────────────────
describe("IN-3 no prose demotion: a prose file that is a cluster's common ground keeps it (tier 1 dropped)", () => {
  test("2026-09-17: two commits whose shared file is a design doc stay one cluster on that doc", () => {
    // Real shape (d0e07b5, a276afc): real subjects, and the two rows that decide each key with their real
    // churn (test rows and the rest abridged; fixture-dated). With `*.md` demoted each re-keyed on a different script and the
    // correct 2-commit cluster was destroyed — the one window in 17 where the shipped tier 1 made the
    // briefing LONGER than the file key alone (19 → 20 lines).
    const acts = [
      commit("d0e07b5", "feat(dba): T22 sun-motif icon set, menubar template + branding pipeline (B22)",
        [row("daily_briefing_application/docs/gui-seam.md", 169), row("daily_briefing_application/gui/scripts/generate-branding.sh", 144)]),
      commit("a276afc", "feat(dba): T23 per-platform packaging, signing parameterization, size budget (B23)",
        [row("daily_briefing_application/docs/gui-seam.md", 322), row("daily_briefing_application/gui/scripts/nesting-probe.sh", 239)]),
    ];
    const out = clusterRecap(bullets("daily_briefing_application", acts), ctxOf(acts));
    expect(out[0]!.group).toBe("daily_briefing_application/docs/gui-seam.md — 2 commits (Sep 4)");
    expect(out[1]!.group).toBe(out[0]!.group);
  });
  test("day 49: a run-state commit is not pulled off its run-state file onto another campaign's source file", () => {
    // Real shape: the five commits' real subjects, and each one's real dominant row with its real churn
    // (other rows abridged). `38bc50b` (an M8 checkpoint, keyed `M-c1`) leads with
    // `.claude/phase-loop-state-m8.md`; `8e1705d` untracked that file four minutes later.
    // Demoting `.claude/**` — even that narrowly — re-keyed it onto `llm/provider.py`, beside two
    // M7.5a commits: that atom stopped being whole, `M7.5a` lost them, and `llm/provider.py` rendered
    // an M8 commit under a header of M7.5a work. The one rename the narrow variant bought IS the
    // merge it suppressed, so it failed the pre-declared rule.
    const acts = [
      commit("38bc50b", "fix(accountant_ai): M-c1 checkpoint + the six docstring riders",
        [row("accountant_ai/.claude/phase-loop-state-m8.md", 177), row("accountant_ai/llm/provider.py", 35)], d2),
      commit("8e1705d", "chore(accountant_ai): untrack the phase-loop run-state file", [row("accountant_ai/.claude/phase-loop-state-m8.md", 177)], d2),
      commit("e1c907f", "fix(accountant_ai): M7.5a verify round — a failure after the request returned", [row("accountant_ai/llm/provider.py", 132)], d2),
      commit("cef44b8", "fix(accountant_ai): M7.5a M-d — loop.step is a typed parameter", [row("accountant_ai/llm/provider.py", 21)], d2),
      commit("f3a59c7", "feat(accountant_ai): M7.5a M-a — the oracle gate and the gated generate path", [row("accountant_ai/agent/oracle.py", 191)], d2),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out[0]!.group).toBe("accountant_ai/.claude/phase-loop-state-m8.md — 2 commits (Sep 2)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out.slice(2).every((e) => e.group === "M7.5a — 3 commits (Sep 2)")).toBe(true);
  });
});

// ── Tier 2: the frozen campaign vocabulary over the raw subject ─────────────────────────────────
describe("IN-3 tier 2: campaign token from the raw subject, ≥2 distinct commits in the lane", () => {
  test("the FROZEN vocabulary, one shape each, with its case rule", () => {
    const k = (s: string) => campaignKey(s)?.key;
    expect(k("feat: spec §1 M-a landed")).toBe("spec-sec:spec §1");     // spec §<n> wins over M-a (list order)
    expect(k("docs: SPEC § 12 re-read")).toBe("spec-sec:spec § 12");   // case-insensitive
    expect(k("feat: spec D-1 checkpoint")).toBe("spec-letter:spec d-1");
    expect(k("fix: M-c riders")).toBe("m-letter:m-c");
    expect(k("fix: m-c riders")).toBe("phrase:m c");                    // M-<letter> is case-sensitive → falls to tier 3
    expect(k("feat: IM3 memory path")).toBe("imn:im3");
    expect(k("feat: M7.5a agent hardening")).toBe("mn:m7.5a");
    expect(k("feat: M8 context")).toBe("mn:m8");
    expect(k("feat: m8 context")).toBe("phrase:m8 context");            // case-sensitive → tier 3
    expect(k("quant: P1 readout")).toBe("pn:p1");
    expect(k("quant: P0 readout")).toBe("phrase:p0 readout");           // P[1-9] → tier 3
    expect(k("feat: rev 13 ledger contract")).toBe("revn:rev 13");
    expect(k("feat: rev13 ledger contract")).toBe("revn:rev13");         // as measured: not whitespace-normalised
    expect(k("feat: checkpoint-C done")).toBe("checkpoint:checkpoint-c");
    expect(k("feat: GATE-S wired")).toBe("gate-s:gate-s");
    expect(k("eval: day-51 briefing logged")).toBe("day-n:day-51");
    expect(k("feat: T17 restore path")).toBe("tn:t17");
    expect(campaignKey("chore: nothing here")).toEqual({ tier: 3, key: "phrase:nothing here", label: "nothing here" });
    // display labels keep the subject's spelling; keys are lower-cased
    expect(campaignKey("feat: Rev 13 ledger")?.label).toBe("Rev 13");
  });
  test("ORDER: a milestone outranks the sub-item every milestone reuses (`M8 M-a`, `IM3 M-b`)", () => {
    // Review round 1's HIGH. First match wins, and `m-letter` used to come first, so `M8 M-a` and
    // `M7.5a M-a` both keyed `M-a` — day 49 rendered `M-a — 3 commits` over an M8, an M7.5a and a
    // bare checkpoint commit, and `M-b — 2 commits` over `661d84c` (M8) and `87bf360` (M7.5a).
    const k = (s: string) => campaignKey(s)?.key;
    expect(k("feat(accountant_ai): M8 M-a — answer provenance and its replay")).toBe("mn:m8");
    expect(k("feat(accountant_ai): M7.5a M-a — the oracle gate")).toBe("mn:m7.5a");
    expect(k("fix(accountant_ai): M7.5a checkpoint M-b — pin breaker precedence")).toBe("mn:m7.5a");
    expect(k("IM3 M-b: the refusal document at the surface")).toBe("imn:im3");
    expect(k("fix(accountant_ai): M-a checkpoint — refuse a route-less row")).toBe("m-letter:m-a");   // alone, it still keys
    const acts = [
      commit("80e907e", "feat(accountant_ai): M8 M-a — answer provenance and its replay", [row("accountant_ai/memory/provenance.py", 40)], d2),
      commit("661d84c", "feat(accountant_ai): M8 M-b — answer_with_provenance, both routes", [row("accountant_ai/agent/answer.py", 30)], d2),
      commit("f3a59c7", "feat(accountant_ai): M7.5a M-a — the oracle gate and the gated generate path", [row("accountant_ai/agent/oracle.py", 90)], d2),
      commit("87bf360", "fix(accountant_ai): M7.5a checkpoint M-b — pin breaker precedence", [row("accountant_ai/agent/breakers.py", 20)], d2),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.map((e) => e.group)).toEqual(["M8 — 2 commits (Sep 2)", "M8 — 2 commits (Sep 2)", "M7.5a — 2 commits (Sep 2)", "M7.5a — 2 commits (Sep 2)"]);
  });
  test("shape corrections, each unexercised in this history (0 or 1 of 2236 subjects) and pinned both ways", () => {
    const k = (s: string) => campaignKey(s)?.key;
    // gate-s is word-anchored
    expect(k("fix: DELEGATE-SERVER retries")).toBe("phrase:delegate server");
    expect(k("feat: AGGREGATE-STATS table")).toBe("phrase:aggregate stats");
    expect(k("docs: GATE-S signed")).toBe("gate-s:gate-s");
    // spec-letter takes a leading \b ("a" is a stopword, hence `techspec 1`); a HYPHEN is a word
    // boundary, so `openapi-spec A-1` still keys `spec A-1` — pinned as the known edge, 0 of 2236 either way
    expect(k("docs: techspec A-1 notes")).toBe("phrase:techspec 1");
    expect(k("docs: inspect A-1 notes")).toBe("phrase:inspect 1");
    expect(k("docs: openapi-spec A-1 notes")).toBe("spec-letter:spec a-1");
    // tn is case-sensitive: a lower-case t<n> in prose is not a task id
    expect(k("refactor(agent): drop the t5 shim now the loop owns retries")).toBe("phrase:drop t5");
    expect(k("docs(spec): pin T5 acceptance criteria")).toBe("tn:t5");
    // the conventional-commit prefix is stripped whatever its case, so a TYPE never becomes a campaign
    expect(k("Feat: restore the admin panel filters")).toBe("phrase:restore admin");
    expect(k("feat: restore the admin panel filters")).toBe("phrase:restore admin");
  });
  test("the header label is the smallest spelling among the members, whatever order the bullets arrive in", () => {
    const a = commit("aaaa111", "feat: Rev 13 ledger contract", [row("core/ledger.py")]);
    const b = commit("bbbb222", "fix: rev 13 rounding", [row("core/rounding.py")]);
    for (const order of [[a, b], [b, a]]) {
      const out = clusterRecap(bullets("accountant_ai", order), ctxOf([a, b]));
      expect(out.map((e) => e.group)).toEqual(["Rev 13 — 2 commits (Sep 4)", "Rev 13 — 2 commits (Sep 4)"]);
    }
  });
  test("two commits in ONE lane carrying the token group; one carrier, or two in different lanes, do not", () => {
    const a = commit("aaaa111", "feat: IM3 query path", [row("q.py")]), b = commit("bbbb222", "fix: IM3 memory", [row("m.py")]);
    const c = commit("cccc333", "fix: IM3 elsewhere", [row("e.py")]);
    const same = clusterRecap(bullets("accountant_ai", [a, b]), ctxOf([a, b]));
    expect(same[0]!.group).toBe("IM3 — 2 commits (Sep 4)");
    expect(same[1]!.group).toBe(same[0]!.group);
    const alone = clusterRecap(bullets("accountant_ai", [a]), ctxOf([a, b]));
    expect(alone[0]!.group).toBeUndefined();
    const split = clusterRecap([{ repo: "accountant_ai", text: "x", evidence: "aaaa111" }, { repo: "quant_stocks", text: "y", evidence: "cccc333" }], ctxOf([a, c]));
    expect(split.every((e) => e.group === undefined)).toBe(true);
  });
  test("two file clusters whose members ALL carry the token MERGE into one campaign (the day-49 M7.5a shape)", () => {
    const acts = [
      commit("aaaa111", "feat: M7.5a agent loop hardening", [row("agent/loop.py", 30)], d2),
      commit("bbbb222", "fix: M7.5a loop retry", [row("agent/loop.py", 20)], d3),
      commit("cccc333", "feat: M7.5a spike runner", [row("agent/spike_run.py", 30)], d2),
      commit("dddd444", "fix: M7.5a spike runner budget", [row("agent/spike_run.py", 20)], d3),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.every((e) => e.group === "M7.5a — 4 commits (Sep 2–3)")).toBe(true);
  });
  test("a campaign absorbs a singleton into an existing file cluster", () => {
    const acts = [
      commit("aaaa111", "feat: rev 13 ledger contract", [row("core/ledger.py", 30)]),
      commit("bbbb222", "fix: rev 13 ledger rounding", [row("core/ledger.py", 20)]),
      commit("cccc333", "test: rev 13 fixtures", [row("tests/test_ledger.py", 50)]),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.every((e) => e.group === "rev 13 — 3 commits (Sep 4)")).toBe(true);
  });
  test("a campaign that gathers only ONE file cluster adds nothing: the file stamp (and its denominator) stays", () => {
    const acts = [
      commit("aaaa111", "feat: P1 readout", [row("q/readout.py", 30)]),
      commit("bbbb222", "fix: P1 readout again", [row("q/readout.py", 20)]),
      commit("cccc333", "chore: unrelated big edit", [row("q/big.py", 90), row("q/readout.py", 1)]),
    ];
    const out = clusterRecap(bullets("quant_stocks", acts), ctxOf(acts));
    expect(out[0]!.group).toBe("q/readout.py — 2 of 3 commits touching it (grouped: Sep 4)");
    expect(out[2]!.group).toBeUndefined();
  });
  test("a campaign stamp never borrows the FILE denominator form, and the model citing one commit twice counts once", () => {
    const acts = [
      commit("aaaa111", "feat: T17 restore", [row("live/admin.py", 30)]),
      commit("bbbb222", "fix: T17 restore manifest", [row("live/manifest.py", 20)]),
      commit("cccc333", "chore: admin big edit", [row("live/admin.py", 90)]),
    ];
    const out = clusterRecap([...bullets("quant_stocks", acts.slice(0, 2)), { repo: "quant_stocks", text: "again", evidence: "bbbb222" }], ctxOf(acts));
    expect(out[0]!.group).toBe("T17 — 2 commits (Sep 4)");
    expect(out[2]!.group).toBe(out[0]!.group);
  });
  test("the day-53 rule for campaigns: a header renders `N of M` when its git unit holds more carriers than it groups", () => {
    // Review round 1 (lens 3 MED-A): `M-a — 3 commits` rendered where 4 in-lane commits named M-a —
    // the carrier strict could not take sat under a FILE header a few lines away, the day-53 defect
    // in the new header form. M counts the WINDOW (an uncited carrier counts too), like the file form.
    const acts = [
      commit("aaaa111", "feat(accountant_ai): M8 context assembly", [row("accountant_ai/agent/context.py", 30)]),
      commit("bbbb222", "fix(accountant_ai): M8 provenance stamp", [row("accountant_ai/agent/provenance.py", 30)]),
      // an M8 carrier sharing a file atom with a commit that does not carry M8 — strict leaves it out
      commit("cccc333", "fix(accountant_ai): M8 queue retry", [row("accountant_ai/core/queue.py", 40)]),
      commit("dddd444", "chore(accountant_ai): queue logging", [row("accountant_ai/core/queue.py", 30)]),
      // an M8 carrier the model never cited
      commit("eeee555", "feat(accountant_ai): M8 replay budget", [row("accountant_ai/agent/replay.py", 20)]),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts.slice(0, 4)), ctxOf(acts));
    expect(out[0]!.group).toBe("M8 — 2 of 4 commits naming it (grouped: Sep 4)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out[2]!.group).toBe("accountant_ai/core/queue.py — 2 commits (Sep 4)");
    expect(out[3]!.group).toBe(out[2]!.group);
    // equal counts stay bare — "2 of 2" adds nothing
    const bare = clusterRecap(bullets("accountant_ai", acts.slice(0, 2)), ctxOf(acts.slice(0, 2)));
    expect(bare[0]!.group).toBe("M8 — 2 commits (Sep 4)");
  });
});

// ── Tier 3: leading phrase, conventional prefix stripped, stopword guard ────────────────────────
describe("IN-3 tier 3: leading-phrase key over the prefix-stripped subject", () => {
  // SYNTHETIC: a `provider seam` window shaped so every member of both atoms carries the phrase.
  // Day 51's real `provider seam` does NOT group under strict (see this file's header) — this pins
  // the mechanism, not that morning.
  test("a phrase spanning three files, every member carrying it, merges into one campaign", () => {
    const acts = [
      commit("aaaa111", "feat(accountant_ai): provider seam — factory takes the config", [row("llm/provider.py", 30)]),
      commit("bbbb222", "fix(accountant_ai): Provider seam honours the timeout", [row("llm/factory.py", 20)]),
      commit("cccc333", "test(accountant_ai): provider seam fixtures", [row("tests/test_provider.py", 50)]),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.every((e) => e.group === "provider seam — 3 commits (Sep 4)")).toBe(true);
  });
  test("the stopword guard skips `fix the two …` and keys on the words that follow", () => {
    expect(campaignKey("fix the two suite count tripwires")?.key).toBe("phrase:suite count");
    expect(campaignKey("pin the suite count")?.key).toBe("phrase:suite count");
    expect(campaignKey("feat(x)!: Suite Count 2,339")?.key).toBe("phrase:suite count");
    expect(campaignKey("fix the")).toBeUndefined();                       // fewer than two content tokens
    expect(campaignKey("")).toBeUndefined();
  });
  test("tier 2 wins over tier 3 when both are present, and does not fall through when its key is a lone carrier", () => {
    // `M8` on aaaa111 is a tier-2 key carried by ONE commit, and the entry does NOT then fall through
    // to its phrase — which here leads the subject and is exactly `provider seam`, so a fall-through
    // implementation WOULD group both commits under `provider seam — 2 commits`. (The fixture used to
    // put `M8` first, where a fall-through phrase is `m8 provider` and the test could not fail on its
    // own name; review round 1's mutant passed the whole suite.) The rule is the instrument's; it is
    // not required to reproduce the warm days — fall-through leaves days 49–52 unchanged.
    const acts = [
      commit("aaaa111", "feat: provider seam for M8", [row("a.py")]),
      commit("bbbb222", "fix: provider seam timeout", [row("b.py")]),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.every((e) => e.group === undefined)).toBe(true);
    expect(campaignKey("feat: provider seam for M8")?.key).toBe("mn:m8");
    expect(campaignKey("fix: provider seam timeout")?.key).toBe("phrase:provider seam");
  });
  test("a SHA-shaped token never reaches a tier-3 label — a header must not answer the audit's same-day scan", () => {
    // Review round 2 (pre-existing since the original build). The real subject below keyed
    // `db22f092 silently`; a header carrying it sits in the text `audit.missingSameDay` scans for 7-char
    // prefixes, so a same-day commit starting `db22f09` would count as reflected with no bullet citing
    // it — a move in the auto-audit's deterministic flag count. The token is skipped like a stopword,
    // after `bareToken` (so a trailing `.` cannot smuggle it through) — by `isShaShaped` in round 2, by
    // `isExtractableSha` since round 3 (the all-digit class; next test).
    expect(campaignKey("fix(transcripts): db22f092 silently un-guarded every OLD self-prompt"))
      .toEqual({ tier: 3, key: "phrase:silently un", label: "silently un" });
    expect(campaignKey("revert: 3a4b5c6. restore the gate")?.key).toBe("phrase:restore gate");
    // …and ONLY tokens that could name a commit: short hex-ish words and numbers under 7 digits are
    // phrase words as before
    expect(campaignKey("docs: facade decade notes")?.key).toBe("phrase:facade decade");
    expect(campaignKey("chore: 2026 retro notes")?.key).toBe("phrase:2026 retro");
    // Rendered, against the audit's own predicate: two commits leading with the SHA of a same-day
    // commit the recap never cites. The header must leave that commit MISSING.
    const acts = [
      commit("aaaa111", "fix: 1a2b3c4 follow-up rounding", [row("core/rounding.py")]),
      commit("bbbb222", "fix: 1a2b3c4 follow-up ledger", [row("core/ledger.py")]),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.map((e) => e.group)).toEqual(["follow up — 2 commits (Sep 4)", "follow up — 2 commits (Sep 4)"]);
    const text = renderBriefing({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [], recap: out });
    const sameDay = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
    expect(missingSameDay([sameDay], text)).toEqual([sameDay]);
  });
  test("an ALL-DIGIT abbreviated SHA never reaches a tier-3 label either — the resolver's extraction rule, not the fabrication test", () => {
    // Review round 3. Round 2 skipped by `isShaShaped`, which rejects every all-digit token BY DESIGN
    // (sha.ts: "pure numbers … are not SHAs"), so `4760499` — a real all-digit git abbreviation, the
    // `monorepo-detect` gold case's commit — still led the phrase: `4760499 follow — 2 commits`, and
    // `missingSameDay` counted a same-day `4760499…` as reflected. The skip is now `isExtractableSha`:
    // SHA_RE plus a 7-char floor for the tokens `isShaShaped` rejects — the gate `resolveOne` seats on.
    expect(campaignKey("fix: 4760499 follow-up rounding")?.key).toBe("phrase:follow up");
    expect(campaignKey("revert: 4760499. restore the gate")?.key).toBe("phrase:restore gate");   // bareToken still runs first
    expect(campaignKey("chore: 20260915 digest rerun")?.key).toBe("phrase:digest rerun");        // the stated cost: a 7+-digit number goes too
    // the floor's other side: under 7 digits a number stays a phrase word (the audit's scan needs 7)
    expect(campaignKey("fix: 476049 follow-up rounding")?.key).toBe("phrase:476049 follow");
    const acts = [
      commit("aaaa111", "fix: 4760499 follow-up rounding", [row("core/rounding.py")]),
      commit("bbbb222", "fix: 4760499 follow-up ledger", [row("core/ledger.py")]),
    ];
    const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
    expect(out.map((e) => e.group)).toEqual(["follow up — 2 commits (Sep 4)", "follow up — 2 commits (Sep 4)"]);
    const text = renderBriefing({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [], recap: out });
    expect(text).not.toContain("4760499");
    const sameDay = "4760499abcdef0123456789abcdef0123456789a";
    expect(missingSameDay([sameDay], text)).toEqual([sameDay]);
  });
  test("ONE extraction rule at both sites: a token leaves the tier-3 phrase iff the resolver would seat it", () => {
    // The two call sites of `isExtractableSha` (`campaignKey`'s phrase filter, `resolveOne`'s gate)
    // must answer "could this token name a commit?" identically — round 2's pair disagreed on exactly
    // the all-digit class. Plain alphanumeric tokens only, so both tokenizers see the same string.
    const seats = (tok: string): boolean => {
      const acts = [commit(`${tok}0f0f0f`, "fix: x", [row("f.ts")]), commit("cccc333", "fix: y", [row("f.ts")])];
      const out = clusterRecap([
        { repo: "app", text: "probe", evidence: tok },
        { repo: "app", text: "anchor", evidence: "cccc333" },
      ], ctxOf(acts));
      return out[0]!.group !== undefined;
    };
    const drops = (tok: string): boolean => campaignKey(`fix: ${tok} alpha beta`)?.label === "alpha beta";
    for (const tok of ["4760499", "20260915", "1234567", "476049", "2026", "cafe", "facade", "defaced", "2026a", "45ac", "1a2b3c4", "db22f092"]) {
      expect(`${tok}: phrase drops ${drops(tok)}`).toBe(`${tok}: phrase drops ${seats(tok)}`);
    }
    // non-vacuous: both answers occur
    expect(seats("4760499")).toBe(true);
    expect(seats("2026")).toBe(false);
  });
  test("a git REVERT keys on the subject it reverts, never on the phrase `revert feat`", () => {
    expect(campaignKey('Revert "feat(accountant_ai): provider seam — factory takes the config"')?.key).toBe("phrase:provider seam");
    expect(campaignKey('Revert "Revert "feat: M8 context""')?.key).toBe("mn:m8");
    expect(campaignKey("revert(eval): drop stray src/eval/types.ts")?.key).toBe("phrase:drop stray");   // a CC type, stripped as one
  });
});

// ── Review round 4: no campaign label the audit's same-day scan can read ────────────────────────
describe("IN-3 round 4: no campaign label the audit's same-day scan can read — every tier, every token", () => {
  // THE SCAN AS A BLACK BOX. Would `missingSameDay` count some commit as reflected BECAUSE `label` was
  // printed as a campaign header? Candidates are real SHA shapes (lower-case hex, 40 chars) whose
  // leading characters are one of the label's own hex substrings, any length, any position — no other
  // SHA could have its prefix matched inside the label, whatever prefix length or boundary rule the
  // scan uses. The scan then decides, over the real renderer's page, against the same page with a
  // neutral label, so only reads the LABEL causes count. Deliberately not a copy of the scan's rule
  // (7 chars, left boundary): that rule is exactly what this oracle has to be free to disagree with.
  const page = (label: string) => {
    const group = `${label} — 2 commits (Sep 4)`;
    return renderBriefing({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [],
      recap: [{ repo: "app", text: "one", group }, { repo: "app", text: "two", group }] });
  };
  const NEUTRAL = page("zzz");
  const auditReads = (label: string): boolean => {
    const cands = new Set<string>();
    for (const run of label.toLowerCase().match(/[0-9a-f]+/g) ?? [])
      for (let i = 0; i < run.length; i++)
        for (let j = i + 1; j <= Math.min(run.length, i + 40); j++) cands.add(run.slice(i, j).padEnd(40, "0"));
    if (!cands.size) return false;
    const unreadWithout = missingSameDay([...cands], NEUTRAL);
    const unreadWith = new Set(missingSameDay([...cands], page(label)));
    return unreadWithout.some((c) => !unreadWith.has(c));
  };

  test("every shape the round-3 residual named — and the rest of tier 2's digit shapes — renders FLAT, and the scan leaves the commit MISSING", () => {
    // [subject stem, the label `campaignKey` gives it, the 7-hex run the scan would read]. The label is
    // asserted first: the KEY still carries the run, so it is the guard, not the key, that refuses it.
    const refused: [string, string, string][] = [
      ["fix: rev 4760499 follow-up", "rev 4760499", "4760499"],          // tier 2 `revn` — the space bounds it
      ["feat: M4760499 rollout", "M4760499", "4760499"],                 // tier 2 `mn` — the `m` bounds it
      ["fix: spec §4760499 durability", "spec §4760499", "4760499"],     // tier 2 `spec-sec`
      ["fix: spec A-4760499 durability", "spec A-4760499", "4760499"],   // tier 2 `spec-letter`
      ["fix: IM4760499 intake", "IM4760499", "4760499"],                 // tier 2 `imn`
      ["fix: day-4760499 replay", "day-4760499", "4760499"],             // tier 2 `day-n`
      ["fix: T4760499 replay", "T4760499", "4760499"],                   // tier 2 `tn`
      ["fix: spec A-DEADBEE durability", "spec A-DEADBEE", "deadbee"],   // upper-case: the scan lower-cases
      ["fix: v4760499 follow-up", "v4760499 follow", "4760499"],         // tier 3, a run inside a token
      ["fix: 4760499..abc1234 follow-up", "4760499..abc1234 follow", "4760499"],
      ["fix: p4760499 follow-up", "p4760499 follow", "4760499"],
      ["fix: GATE-S4760499 follow-up", "gate s4760499", "4760499"],      // `gate-s` needs a word end, so tier 3
      ["fix: vdb22f09 follow-up", "vdb22f09 follow", "db22f09"],         // hex letters inside a token
    ];
    const formed: [string, boolean][] = [];
    for (const [stem, label, run] of refused) {
      expect(campaignKey(`${stem} rounding`)?.label).toBe(label);
      expect(campaignKey(`${stem} ledger`)?.label).toBe(label);
      const acts = [
        commit("aaaa111", `${stem} rounding`, [row("core/rounding.py")]),
        commit("bbbb222", `${stem} ledger`, [row("core/ledger.py")]),
      ];
      const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
      formed.push([label, out.some((e) => e.group !== undefined)]);
      expect(`${label}: ${JSON.stringify(out.map((e) => e.group))}`).toBe(`${label}: [null,null]`);
      const text = renderBriefing({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [], recap: out });
      const sameDay = `${run}${"0123456789abcdef0123456789abcdef0"}`;
      expect(`${label}: ${JSON.stringify(missingSameDay([sameDay], text))}`).toBe(`${label}: ${JSON.stringify([sameDay])}`);
    }
    // …and ONLY those: the same fixture under a label the scan cannot read still forms its header.
    // `rev 476049` is six digits — the boundary; `follow up` is round 3's skip keeping a SHA-led
    // subject's campaign under a clean label rather than losing it.
    const kept: [string, string][] = [
      ["fix: rev 13 follow-up", "rev 13"],
      ["fix: rev 476049 follow-up", "rev 476049"],
      ["feat: M8 rollout", "M8"],
      ["fix: 4760499 follow-up", "follow up"],
      ["fix: facade decade", "facade decade"],
    ];
    for (const [stem, label] of kept) {
      const acts = [
        commit("aaaa111", `${stem} rounding`, [row("core/rounding.py")]),
        commit("bbbb222", `${stem} ledger`, [row("core/ledger.py")]),
      ];
      const out = clusterRecap(bullets("accountant_ai", acts), ctxOf(acts));
      formed.push([label, out.some((e) => e.group !== undefined)]);
      expect(out.map((e) => e.group)).toEqual([`${label} — 2 commits (Sep 4)`, `${label} — 2 commits (Sep 4)`]);
    }
    // The behavioural half of the coupling: across both lists, as OBSERVED, a header formed iff the
    // scan could not read its label.
    expect(formed.length).toBe(18);
    for (const [label, f] of formed) expect(`${label}: header ${f}`).toBe(`${label}: header ${!auditReads(label)}`);
  });

  test("a refused campaign dissolves back to EXACTLY its file clusters — the refusal `wider` and ONE NAME PER BRACKET make", () => {
    // Two 2-member file atoms whose every member carries `rev 4760499`: the campaign would be
    // `rev 4760499 — 4 commits`. Refused, the page is what the file key alone draws — the same window
    // with every subject blanked, which leaves tiers 2–3 nothing to read.
    const window = (subject: (s: string) => string) => [
      commit("aaaa111", subject("rounding"), [row("core/rounding.py", 40)]),
      commit("aaaa222", subject("rounding tests"), [row("core/rounding.py", 30)]),
      commit("bbbb111", subject("ledger"), [row("core/ledger.py", 40)]),
      commit("bbbb222", subject("ledger tests"), [row("core/ledger.py", 30)]),
    ];
    const run = (subject: (s: string) => string) => { const acts = window(subject); return clusterRecap(bullets("accountant_ai", acts), ctxOf(acts)); };
    const refused = run((s) => `fix: rev 4760499 follow-up ${s}`);
    expect(refused).toEqual(run(() => ""));
    expect(refused.map((e) => e.group)).toEqual(["core/rounding.py — 2 commits (Sep 4)", "core/rounding.py — 2 commits (Sep 4)",
      "core/ledger.py — 2 commits (Sep 4)", "core/ledger.py — 2 commits (Sep 4)"]);
    // control: the identical window under a readable-safe token merges, so the refusal is the guard's
    expect(run((s) => `fix: rev 13 follow-up ${s}`).map((e) => e.group)).toEqual(Array(4).fill("rev 13 — 4 commits (Sep 4)"));
  });

  test("the guard refuses a label IFF the audit's same-day scan reads some part of it as a SHA — over a corpus that cannot be empty", () => {
    // `missingSameDay` is eval scoring logic, so the guard does not share code with it; this test is
    // the coupling instead. Three corpora, each with a pinned size so an emptied or shrunken corpus
    // FAILS rather than passing vacuously:
    //  · NAMED — every shape of rounds 2–4, mixed case, the 6-hex boundary, all-hex English words (the
    //    stated cost), and labels carrying no hex at all, each with its expected verdict written out;
    //  · REAL — the 7 labels, of the 1625 distinct ones `campaignKey` gives the 2236 real non-merge
    //    subjects, whose longest hex run is 5 or 6 characters: the real labels nearest the boundary.
    //    (The other 1618 carry runs of 4 or fewer. All 1625 were measured against this same oracle
    //    when this landed, 0 refused — out of tree, because `test/` ships in the public export and
    //    the full list is a digest of private history.)
    //  · SEEDED — 2000 labels of hex runs (1–10 chars, mixed case) joined by separators the scan could
    //    treat either way: space, `-`, `.`, `..`, `§`, `_`, `/`, non-hex letters, and non-ASCII
    //    (`é`, `İ` — which lower-cases to TWO characters — and an em dash).
    const NAMED: [string, boolean][] = [
      ["rev 4760499", true], ["M4760499", true], ["spec §4760499", true], ["spec A-4760499", true],
      ["IM4760499", true], ["day-4760499", true], ["T4760499", true], ["v4760499 follow", true],
      ["4760499..abc1234 follow", true], ["p4760499 follow", true], ["gate s4760499", true],
      ["4760499 follow", true], ["db22f092 silently", true], ["1a2b3c4 follow", true],   // rounds 3 and 2, as labels
      ["spec A-DEADBEE", true], ["Rev 4760499", true], ["DeFaCeD notes", true], ["x0.1234567", true],
      ["defaced notes", true], ["effaced notes", true], ["notes 20260915", true], ["abcdef0123456789abcdef0123456789abcdef0123", true],
      ["rev 476049", false], ["abc123 notes", false], ["facade decade", false], ["rev 13", false],
      ["M8", false], ["follow up", false], ["spec §1", false], ["phase c", false], ["abc123-def456", false],
      ["abc123 def456", false], ["", false], ["İİİİİİİ", false], ["ｄｅａｄｂｅｅ", false],
    ];
    const REAL = ["five defects", "repair unreadable", "close unreadable", "unreadable document", "machine readable",
      "embeddable_statuses auto_booked", "caffeinate plist"];
    const HEXC = "0123456789abcdefABCDEF";
    const SEPS = [" ", "-", ".", "..", "§", "_", "/", "g", "m", "v", "x", "M", "T", "é", "İ", "—"];
    const r = mulberry32(20260919);
    const at = <T,>(xs: readonly T[] | string): T => xs[Math.floor(r() * xs.length)] as T;
    const SEEDED: string[] = [];
    for (let n = 0; n < 2000; n++) {
      let s = r() < 0.5 ? at<string>(SEPS) : "";
      const k = 1 + Math.floor(r() * 3);
      for (let i = 0; i < k; i++) {
        const len = 1 + Math.floor(r() * 10);
        for (let j = 0; j < len; j++) s += at<string>(HEXC);
        if (i < k - 1 || r() < 0.5) s += at<string>(SEPS);
      }
      SEEDED.push(s);
    }
    expect(NAMED.length).toBe(35);
    expect(REAL.length).toBe(7);
    expect(SEEDED.length).toBe(2000);

    // The written-out verdicts: guard AND scan, each on its own.
    for (const [label, want] of NAMED) {
      expect(`${JSON.stringify(label)}: guard ${readsAsSameDaySha(label)}`).toBe(`${JSON.stringify(label)}: guard ${want}`);
      expect(`${JSON.stringify(label)}: scan ${auditReads(label)}`).toBe(`${JSON.stringify(label)}: scan ${want}`);
    }
    // The equivalence, over all three.
    const all = [...NAMED.map(([l]) => l), ...REAL, ...SEEDED];
    const disagree = all.filter((l) => readsAsSameDaySha(l) !== auditReads(l)).map((l) => `${JSON.stringify(l)} guard ${readsAsSameDaySha(l)}`);
    expect(disagree).toEqual([]);
    // Non-vacuous: both verdicts occur in bulk, and the seeded corpus sits ON the boundary — many labels
    // whose longest hex run is exactly 6, and many exactly 7.
    const refused = all.filter((l) => readsAsSameDaySha(l)).length;
    expect(refused).toBeGreaterThan(500);
    expect(all.length - refused).toBeGreaterThan(500);
    const longest = (l: string) => Math.max(0, ...(l.match(/[0-9a-f]+/gi) ?? []).map((x) => x.length));
    expect(SEEDED.filter((l) => longest(l) === 6).length).toBeGreaterThan(100);
    expect(SEEDED.filter((l) => longest(l) === 7).length).toBeGreaterThan(100);
    expect(REAL.every((l) => !readsAsSameDaySha(l) && !auditReads(l) && longest(l) >= 5)).toBe(true);
  });
});
