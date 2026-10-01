// test/cluster-resolver-alldigit.test.ts — `clusterRecap`'s resolver gate (IN-3 Part-2 §A.5).
//
// `resolveOne` gated candidate evidence tokens on `isShaShaped`, the FABRICATION test, which rejects
// all-digit tokens on purpose (a year or PR number must not cost a false "fabricated SHA" verdict).
// The resolver asks the opposite question — "which REAL commit is this?" — and answers it against
// ground truth. This project had already ruled on that split three weeks before this code was written
// and ruled the other way: `2913255207` (#140, 2026-08-03, user-directed) records at
// `src/eval/checks.ts:161-180` that `isShaShaped` is "harmless when deciding whether to
// grounding-CHECK a token, wrong when deciding whether a token EXISTS", measured by the
// `monorepo-detect` gold case (commit `4760499`, an all-digit 7-char abbrev). `79770ab8a` (#363,
// 2026-08-25) created `resolveOne` as a verbatim transplant of `verifyEvidence`'s tokenizer + gate
// and its own note ends "no behaviour is chosen here" — so this is a RESTORATION, not a new call.
// Cost of the strict gate, measured: 6 of 196 rendered commits on days 49–52 could never resolve, so
// never join a cluster (`3316617` → `agent/loop.py`, `7343129` → `agent/spike_run.py` each had a
// cluster waiting); top-level lines 18/18/23/33 → 17/18/22/33.
//
// TWO rules make the widened gate safe, and they are what this file pins:
//   1. a 7-CHAR FLOOR on tokens `isShaShaped` rejects, matching `evidenceCandidates`'
//      `[0-9a-f]{7,40}` (`src/eval/checks.ts:157`; `sha.ts:12-16` records that divergence). It
//      admits exactly one new class — all-digit 7–40 — and rejects the whole short-decoy class.
//      NOT a blanket floor: a 4–6-char token carrying a hex letter is `isShaShaped` and untouched.
//   2. ZERO hits CONTINUES the scan while AMBIGUOUS still ends it. A token that accounts for no
//      in-window commit is not a citation of anything here; an ambiguous one means "cannot tell".
// The fabrication gate itself (`isShaShaped`, its audit and eval callers) is UNCHANGED.
import { test, expect, describe } from "bun:test";
import { clusterRecap, generateBriefing } from "../src/generator";
import { extractCitedShas } from "../src/audit";
import { isShaShaped, SHA_RE } from "../src/sha";
import type { ReducedContext, Activity, Provider } from "../src/types";

// Full 40-char ids, so prefix semantics are the real ones: a 7-char cite is a PREFIX of the id.
const full = (prefix: string): string => (prefix + "0123456789abcdef0123456789abcdef01234567").slice(0, 40);
const d3 = "2026-09-03T10:00:00-07:00";
const commit = (sha: string, file: string, churn = 5): Activity =>
  ({ source: "git", kind: "commit", event_id: full(sha), repo: "/r", timestamp: d3, text: `c-${sha}`,
     meta: { diffstat: [{ file, added: churn, removed: 0 }] } });
const ctxOf = (acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "", activities: acts }] });

describe("clusterRecap — the resolver gate is SHA_RE with a 7-char floor, not the fabrication test", () => {
  test("an ALL-DIGIT abbreviated SHA resolves and joins its cluster (the day-49 / day-51 shape)", () => {
    // RED before the fix: `3316617` and `7343129` were skipped by `isShaShaped`, so each of their
    // clusters had one member and no stamp. The second cite carries the archive's exact adornment
    // (`backticks` + a trailing date) to show the bare-token strip still runs ahead of the gate.
    const ctx = ctxOf([
      commit("3316617", "agent/loop.py"), commit("aaaa111", "agent/loop.py"),
      commit("7343129", "agent/spike_run.py"), commit("cccc333", "agent/spike_run.py"),
      commit("bbbb222", "other.py"),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "one", evidence: "3316617" },
      { repo: "app", text: "two", evidence: "aaaa111" },
      { repo: "app", text: "three", evidence: "`7343129` (Sep 3)" },
      { repo: "app", text: "four", evidence: "cccc333" },
      { repo: "app", text: "five", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("agent/loop.py — 2 commits (Sep 3)");
    expect(out[1]!.group).toBe(out[0]!.group);
    expect(out[2]!.group).toBe("agent/spike_run.py — 2 commits (Sep 3)");
    expect(out[3]!.group).toBe(out[2]!.group);
    expect(out[4]!.group).toBeUndefined();
    // presentation-only, still: text/evidence/order untouched
    expect(out.map((e) => e.evidence)).toEqual(["3316617", "aaaa111", "`7343129` (Sep 3)", "cccc333", "bbbb222"]);
  });

  test("the uniqueness guard still refuses an AMBIGUOUS token from the newly admitted class", () => {
    // ⚠ The guard is NOT what makes the widened gate safe, which an earlier draft of this file (and
    // of the gate comment) claimed. Measured over 15 real windows: of 10,000 bare 4-digit tokens
    // 1–13 resolve UNIQUELY and ZERO are ambiguous, so for the short class the guard essentially
    // never fires and every coincidental hit is one it ADMITS. The 7-char floor is the mechanism —
    // test 4 pins it. What the guard does cover is genuine ambiguity, which the floor does not
    // address, so it must still fire inside the class the floor lets through: two commits sharing a
    // 7-digit prefix. A `>= 1` mutant seats the ambiguous cite in the f.ts cluster.
    const ctx = ctxOf([commit("3316617a", "f.ts"), commit("3316617b", "g.ts"), commit("cccc333", "f.ts")]);
    const out = clusterRecap([
      { repo: "app", text: "ambiguous all-digit prefix", evidence: "3316617" },
      { repo: "app", text: "real", evidence: "cccc333" },
      { repo: "app", text: "real too, cited unambiguously", evidence: "3316617a" },
    ], ctx);
    expect(out[0]!.group).toBeUndefined();
    expect(out[1]!.group).toBe("f.ts — 2 commits (Sep 3)");
    expect(out[2]!.group).toBe(out[1]!.group);
  });

  test("REGRESSION PIN for the floor: a bare year must not file a bullet under a stranger's file", () => {
    // The worst case of the un-floored gate, constructed through the real pipeline in review and
    // reproduced here: a bare `2026` coincidentally prefixes a PAYMENTS commit, so an AUTH bullet is
    // filed under `src/payments.ts`, the legitimate `src/auth.ts` cluster is destroyed, its partner
    // is orphaned to a top-level line, and the payments header claims "2 commits" when only one
    // payments commit is cited — a code-built numeric claim inflated by one. Three wrong outcomes
    // and a wrong number from one decoy token, with no warning anywhere.
    //
    // The 7-char floor makes it unreachable: `2026` is skipped, the scan reaches `aaaa111`, and the
    // auth bullets cluster correctly. Remove the floor and every expectation below flips.
    const ctx = ctxOf([
      commit("2026a", "src/payments.ts"), commit("dddd444", "src/payments.ts"),
      commit("aaaa111", "src/auth.ts"), commit("bbbb222", "src/auth.ts"),
    ]);
    const out = clusterRecap([
      { repo: "app", text: "rewrote the auth token refresh path", evidence: "2026, aaaa111" },
      { repo: "app", text: "payments retry", evidence: "dddd444" },
      { repo: "app", text: "more auth work", evidence: "bbbb222" },
    ], ctx);
    expect(out[0]!.group).toBe("src/auth.ts — 2 commits (Sep 3)");   // the file it actually cited
    expect(out[2]!.group).toBe(out[0]!.group);                        // partner not orphaned
    expect(out[1]!.group).toBeUndefined();                            // no phantom payments cluster
    // …and no header anywhere claims a payments cluster at all — the count-inflation half.
    expect(out.some((e) => e.group?.startsWith("src/payments.ts"))).toBe(false);
  });

  test("the floor is exactly 7 for tokens the fabrication test rejects, and never applies to the rest", () => {
    // The boundary itself, both sides of it, and the NON-REGRESSION that bounds the fix: this must
    // not become a blanket 7-char floor. `isShaShaped` rejects TWO classes — every all-digit token
    // AND short all-[a-f] words (`recapCoverage`'s comment at :531-533 names `cafe`/`abcd`) — and
    // only those two are floored. A 4–6-char token carrying a hex letter and a digit is
    // `isShaShaped`, resolves today, and must keep resolving.
    //
    // Observability: a token "resolved" iff its bullet joined the anchor's cluster, which needs two
    // members. Each case gets its own fixture so the anchor never changes.
    const resolvesTo = (tok: string, prefixed: string): boolean => {
      const ctx = ctxOf([commit(prefixed, "f.ts"), commit("cccc333", "f.ts")]);
      const out = clusterRecap([
        { repo: "app", text: "probe", evidence: tok },
        { repo: "app", text: "anchor", evidence: "cccc333" },
      ], ctx);
      return out[0]!.group !== undefined;
    };
    // all-digit sweep against ONE commit id, `20260903…`, which every token below prefixes
    expect(resolvesTo("2026", "20260903")).toBe(false);      // 4 — floored
    expect(resolvesTo("20260", "20260903")).toBe(false);     // 5 — floored
    expect(resolvesTo("202609", "20260903")).toBe(false);    // 6 — floored
    expect(resolvesTo("2026090", "20260903")).toBe(true);    // 7 — the git abbrev width, admitted
    expect(resolvesTo("20260903", "20260903")).toBe(true);   // 8 — admitted
    // short all-[a-f] words: the second class `isShaShaped` rejects, floored the same way
    expect(resolvesTo("cafe", "cafe9")).toBe(false);
    expect(resolvesTo("facade", "facade9")).toBe(false);
    // NON-REGRESSION — `isShaShaped` tokens below 7 chars are untouched by the floor
    expect(resolvesTo("2026a", "2026a")).toBe(true);
    expect(resolvesTo("45ac", "45ac")).toBe(true);
    expect(resolvesTo("1b2c", "1b2c")).toBe(true);
    expect(resolvesTo("45acfe", "45acfe")).toBe(true);
    // `#418` never had a hex shape at all. NOT a pin of the `SHA_RE` line, though it reads like one
    // (cold review LOW): `bareToken("#418")` is `#418`, which fails `shaPrefixMatch` against every id
    // anyway AND is 4 chars, so it still would not resolve with that line deleted. Kept as a plain
    // statement of the outcome for a `#NNN` PR reference, which is what models actually write.
    expect(resolvesTo("#418", "4180000")).toBe(false);
    // THE ACTUAL `if (!SHA_RE.test(bare)) continue;` PIN — nothing else in the suite distinguished
    // that line (measured: delete it, keep the floor, and 1970 tests stay green). It is load-bearing
    // exactly where `shaPrefixMatch`'s EITHER-DIRECTION rule would otherwise bite: a token that
    // BEGINS with a full 40-char id and carries a non-hex suffix (`…-dirty`, a `git describe`-ish
    // decoration) satisfies `bare.startsWith(id)`, and at 40+ chars the 7-char floor cannot stop it
    // either. Delete the `SHA_RE` line and this flips to `true`. (Since IN-3 review round 3 that line
    // is the `SHA_RE.test(tok)` clause of `sha.ts`'s `isExtractableSha`, which the gate now calls.)
    expect(resolvesTo(`${full("aaaa111")}-dirty`, "aaaa111")).toBe(false);
  });

  test("the FABRICATION gate is not loosened: the two gates now diverge here deliberately, and the audit's miner is unchanged", () => {
    // `isShaShaped` is untouched (IN-3 round 3 only ADDED `isExtractableSha` beside it in `sha.ts` — this
    // gate, moved verbatim); this pins the divergence from the resolver's side so a future "make them
    // agree" cannot land silently. The predicate's OWN rules are pinned once, in
    // `test/eval/sha-shape-convergence.test.ts:77-85` — deliberately not restated here, so one
    // re-tuning of `sha.ts` does not have to be chased through two files (cold review LOW: T5's
    // `isShaShaped("4fa7227")` / `("2026")` were verbatim duplicates of :83 / :80-81 and are gone).
    expect(SHA_RE.test("3316617")).toBe(true);
    expect(isShaShaped("3316617")).toBe(false);   // the exact token this site now admits and that one still rejects
    // audit.ts's citation miner (`extractCitedShas`, an existing isShaShaped caller): an all-digit
    // token inside a citation group is not a citation, exactly as before.
    expect(extractCitedShas("evidence: 4fa7227 (3316617 note)")).toEqual(["4fa7227"]);
    expect(extractCitedShas("evidence: 3316617")).toEqual([]);
  });

  test("an AMBIGUOUS first cite is not rescued by a unique second one — ambiguity ends the scan", () => {
    // The half of first-token-decides that SURVIVES the zero-hit `continue` (test 7), and the reason
    // the two hit-counts are handled separately: "cannot tell" is a decision, "no such commit here"
    // is not. The prefix twin sits on g.ts so the f.ts stamp keeps its plain "2 commits" form (a
    // third f.ts toucher would widen it to "2 of 3 commits touching it" — the day-53 denominator,
    // not this pin). Plain unresolved/absent/ambiguous evidence is pinned in
    // `day36-deinversion.test.ts:61`; what is new here is the ambiguous-THEN-unique ordering.
    const ctx = ctxOf([commit("abc1234dead", "f.ts"), commit("abc1234feed", "g.ts"), commit("cccc333", "f.ts")]);
    const out = clusterRecap([
      { repo: "app", text: "ambiguous then unique", evidence: "abc1234, cccc333" },
      { repo: "app", text: "unique", evidence: "cccc333" },
      { repo: "app", text: "unique too", evidence: "abc1234d" },
    ], ctx);
    expect(out[0]!.group).toBeUndefined();
    expect(out[1]!.group).toBe("f.ts — 2 commits (Sep 3)");
    expect(out[2]!.group).toBe(out[1]!.group);
  });

  test("a ZERO-HIT token no longer ends the scan: the real SHA behind it still resolves", () => {
    // THE CONTRACT CHANGE. Previously the first SHA-shaped token decided even when it accounted for
    // no commit at all, so anything ahead of the real SHA flattened the entry silently. Five leading
    // tokens, one outcome — the bullet finds its cluster. Three of them reach the hits filter and
    // score zero there:
    //   `9f9f9f9`  a garbled hex SHA (`isShaShaped`, never resolves)
    //   `20260903` a compact date that clears the 7-char floor (the residual the floor cannot close)
    //   `eeee555`  SHA-shaped and matching no commit — the SHAPE of a cited branch tip. This fixture
    //              has no branch activity, so here it is only that shape; the real `meta.tip` carrier
    //              (and the reason `verifyEvidence` keeps it) is exercised end-to-end in test 8.
    // The other two never get that far — they are stopped at the gate, which is a different fact and
    // is why they are listed apart:
    //   `2026`     floored out BEFORE the hits filter (all-digit, under 7)
    //   `#418`     fails `SHA_RE`, skipped as it always was (not a pin of that line — see test 4)
    //
    // ⚠ An earlier version of this test asserted the OPPOSITE and justified it by claiming a leading
    // bare number "ends the search the way a garbled hex token always has". That claim was false and
    // was the stated reason this change was deferred: `verifyEvidence` runs BEFORE `clusterRecap` and
    // is gated on `isShaShaped`, so it strips precisely the tokens `isShaShaped` accepts — a garbled
    // hex token never reached the resolver in the real pipeline (it clusters, with a warning), while
    // a bare number reached it and flattened the bullet with no warning at all. The two classes are
    // complementary by construction, never analogous. See the gate comment in `generator.ts`.
    const ctx = ctxOf([commit("aaaa111", "f.ts"), commit("bbbb222", "f.ts")]);
    const out = clusterRecap([
      { repo: "app", text: "garbled hex first", evidence: "9f9f9f9, aaaa111" },
      { repo: "app", text: "compact date first", evidence: "20260903, aaaa111" },
      { repo: "app", text: "year first", evidence: "2026, aaaa111" },
      { repo: "app", text: "branch tip first", evidence: "eeee555, aaaa111" },
      { repo: "app", text: "non-SHA token first", evidence: "#418, aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ], ctx);
    // "2 commits", not 6: `nCommits` counts DISTINCT event_ids, and five bullets cite `aaaa111`.
    expect(out.every((e) => e.group === "f.ts — 2 commits (Sep 3)")).toBe(true);

    // ⚠ WHAT THE `continue` COSTS — pinned as CURRENT behaviour, NOT as desired behaviour, so that
    // narrowing it later is a deliberate act and not an accident. The tokens that survive
    // `verifyEvidence` and score zero hits here are exactly the ones `knownShas` (`generator.ts:29`)
    // admits and `commits` does not — a branch tip (`meta.tip`) or a stash SHA (`meta.sha`) — and the
    // scan now moves PAST them to the next token, which the 7-char floor does not cover when it
    // carries a hex letter (`45ac` is `isShaShaped`, hence floor-exempt). So an auth bullet lands
    // under a stranger's `src/payments.ts` behind a code-built "2 commits" header, silently.
    // Accepted because it widens an existing class rather than creating one (`9999999, 45ac` already
    // mis-files identically at base), because it is presentation-only (`recapCoverage` scans
    // `evidence`, never `group`), and because it is 0 of 196 on the day-49..52 corpus. The gate
    // comment in `generator.ts` carries the full trade-off and the measurements.
    const tipCtx: ReducedContext = { repos: [{ repo: "/r", summary: "", activities: [
      commit("45ac999", "src/payments.ts"), commit("beef777", "src/payments.ts"),
      { source: "git", kind: "branch", event_id: "br-1", repo: "/r", timestamp: d3, text: "feat/auth",
        meta: { tip: full("eeee555") } },
    ] }] };
    const tip = clusterRecap([
      { repo: "app", text: "rewrote the auth token refresh path", evidence: "eeee555, 45ac" },
      { repo: "app", text: "payments retry backoff", evidence: "beef777" },
    ], tipCtx);
    expect(tip[0]!.group).toBe("src/payments.ts — 2 commits (Sep 3)");  // a file the bullet never cited
    expect(tip[1]!.group).toBe(tip[0]!.group);                          // header says 2; one was cited
    // …and the floor still covers the all-[a-f] half of the very same shape, which is why it is
    // "part of the job" rather than none of it: swap the decoy for `cafe` and nothing groups.
    const flooredCtx: ReducedContext = { repos: [{ repo: "/r", summary: "", activities: [
      commit("cafe999", "src/payments.ts"), commit("beef777", "src/payments.ts"),
      { source: "git", kind: "branch", event_id: "br-1", repo: "/r", timestamp: d3, text: "feat/auth",
        meta: { tip: full("eeee555") } },
    ] }] };
    const floored = clusterRecap([
      { repo: "app", text: "rewrote the auth token refresh path", evidence: "eeee555, cafe" },
      { repo: "app", text: "payments retry backoff", evidence: "beef777" },
    ], flooredCtx);
    expect(floored.every((e) => e.group === undefined)).toBe(true);
  });

  test("END-TO-END through generateBriefing: verifyEvidence RETAINS both classes, and clusterRecap seats them", () => {
    // The unit tests above call `clusterRecap` directly, so none of them exercises the delivery path.
    // A mutation of `verifyEvidence` (`generator.ts:53`) to strip all-digit tokens kills this feature
    // completely in production — `3316617` and `7343129` return to being flat top-level lines in the
    // 07:20 briefing — and the whole suite stayed green. This is the pin for that: the two gates meet
    // at `:1088` → `:1099`, and the all-digit citation must survive the first to reach the second.
    //
    // ⚠ A MUTATION OF `generator.ts:53` CAN BE INERT — that finding stands, but the mutation text
    // first published for it was wrong, so here is the one that actually demonstrates it. INSERT,
    // leaving the guard below intact:
    //
    //     if (/^[0-9]+$/.test(bare)) return false;     // immediately before the `isShaShaped` line
    //
    // That drops all-digit tokens out of `kept` WITHOUT pushing to `dropped`, so `verifyEvidence`'s
    // `dropped.length === 0` early return hands back the ORIGINAL evidence verbatim and discards
    // `kept` entirely: the file genuinely changes and nothing downstream does. Measured on a severed
    // copy of this tree — full suite 1969 pass / 1 skip / 0 fail, rendered briefing byte-identical to
    // the unmutated run. A mutation here must also RECORD the drop (`dropped.push(tok); return
    // false;`) to have any effect, and that one is RED: 1965 / 1 / 4 — this test, `verifyEvidence`'s
    // own Tier-A pin, and two transcript gold cases.
    //
    // What does NOT show this, and was reported as green twice: REPLACING line 53 outright with
    // `return !/^[0-9]+$/.test(bare);`. It is a different mutation — an unconditional `return` makes
    // the `shaResolves` check below it unreachable, so the grounding guard stops dropping garbled
    // SHAs at all. Measured on this tree: 1966 pass / 1 skip / 3 FAIL (the two `verifyEvidence`
    // drop-and-warn tests, plus "B8: dynamic warnings survive…"). Cold-review lens 3 and the round-1
    // fix each reported their own CLEAN floor (1968/1/0 and 1969/0) as if it were that mutated run.
    // Written down here because this comment exists precisely so nobody re-derives it.
    //
    // Likewise the literal "unify the gates on SHA_RE" change does NOT kill the feature — a real
    // all-digit SHA still RESOLVES and so is kept — it only trips `verifyEvidence`'s own Tier-A pin.
    //
    // It also pins the branch-tip half end-to-end, which is what makes the zero-hit `continue`
    // necessary rather than merely tidy: `knownShas` (:29) accepts `meta.sha`/`meta.tip`, so a cited
    // tip is NOT a fabrication and `verifyEvidence` keeps it — but `clusterRecap`'s `commits` is
    // `kind === "commit"` only, so it scores zero hits. Before the `continue` it ended the scan and
    // destroyed the cluster with no warning at all.
    const ctx: ReducedContext = { repos: [{ repo: "/r", summary: "", activities: [
      commit("3316617", "agent/loop.py"), commit("aaaa111", "agent/loop.py"),
      commit("dddd444", "agent/spike_run.py"), commit("ffff666", "agent/spike_run.py"),
      { source: "git", kind: "branch", event_id: "br-1", repo: "/r", timestamp: d3, text: "feat/x",
        meta: { tip: full("eeee555") } },
    ] }] };
    const provider: Provider = { generate: async () => [
      "## RESUME", "- [/r] resume", "## RECAP",
      "- [/r] all-digit citation | evidence: 3316617",
      "- [/r] its partner | evidence: aaaa111",
      "- [/r] branch tip ahead of the real sha | evidence: eeee555, dddd444",
      "- [/r] its partner | evidence: ffff666",
      "## SUGGESTIONS", "- x",
    ].join("\n") };
    return generateBriefing(ctx, provider, { date: "2026-09-03", machineScope: "h", provider: "p" }, [])
      .then((b) => {
        // verifyEvidence kept BOTH — nothing was reported as a non-resolving SHA
        expect((b.warnings ?? []).filter((w) => w.includes("didn't resolve"))).toEqual([]);
        expect(b.recap[0]!.evidence).toBe("3316617");
        expect(b.recap[2]!.evidence).toBe("eeee555, dddd444");
        // …and clusterRecap seated them
        expect(b.recap[0]!.group).toBe("agent/loop.py — 2 commits (Sep 3)");
        expect(b.recap[1]!.group).toBe(b.recap[0]!.group);
        expect(b.recap[2]!.group).toBe("agent/spike_run.py — 2 commits (Sep 3)");
        expect(b.recap[3]!.group).toBe(b.recap[2]!.group);
      });
  });
});
