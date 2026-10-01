// test/recap-campaigns.score.test.ts — tier B, T2.2 (plan-added): `scoreReply`, the ONE reply→outcome
// composition (spec §4.2 steps 5–8; §4.6's `none` rule; §4.10's `proposed`). The five tests carry the
// plan's exact titles.
import { test, expect, describe } from "bun:test";
import { scoreReply, buildCampaignItems, realRecapImpl, applyCampaigns, liveCheck, topLevelRecapCount, REPLY_MAX_BYTES, type CoverageUnits, type LiveCheckLetter, type RecapImpl } from "../src/recapCampaigns";
import { MORNING_STRUCT, MORNING_RECAP, MORNING_COMMITS, MORNING_LABELS } from "./fixtures/campaign-morning";

const ITEMS = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
const UNITS: CoverageUnits = [...MORNING_LABELS, "personal_code"].map((l) => ({ repo: `/w/${l}`, labels: [l] }));
const reply = (...campaigns: { title: string; items: string[] }[]) => JSON.stringify({ campaigns });
const VALID = reply({ title: "retry backoff", items: ["G1", "G2"] });
const score = (text: string, mode: "trial" | "on" = "trial", impl: Partial<RecapImpl> = {}) => scoreReply(MORNING_STRUCT, ITEMS, text, UNITS, mode, impl);

describe("scoreReply (§4.2 steps 5–8)", () => {
  test("scoreReply maps each mode and path to its outcome", () => {
    // applied / trial: the same valid reply, the mode decides
    const on = score(VALID, "on");
    expect([on.outcome, on.reason, on.before, on.after, on.proposed, on.kept]).toEqual(["applied", null, 9, 8, 1, 1]);
    expect(on.candidate?.recap.filter((r) => r.campaign !== undefined)).toHaveLength(3);
    expect(on.headers).toEqual(["   • [accountant_ai] retry backoff — 3 commits"]);
    const trial = score(VALID, "trial");
    expect([trial.outcome, trial.reason, trial.after]).toEqual(["trial", null, 8]);
    expect(trial.candidate).toEqual(on.candidate);                      // trial still builds the candidate; the PAGE is unchanged by the caller
    // none: an accepted reply with no campaigns, and one whose only campaign is dropped
    const empty = score(reply());
    expect([empty.outcome, empty.reason, empty.after, empty.proposed, empty.kept, "candidate" in empty]).toEqual(["none", null, 9, 0, 0, false]);
    const dropped = score(reply({ title: "retry backoff", items: ["G1", "G3"] }));   // mixes labels
    expect([dropped.outcome, dropped.reason, dropped.after, dropped.proposed, dropped.kept]).toEqual(["none", null, 9, 1, 0]);
    expect(dropped.dropped).toEqual([{ title: "retry backoff", reasons: ["mixes-labels"] }]);
    // rejected, per whole-reply reason
    expect(score(`{"campaigns":[],"x":"${"a".repeat(REPLY_MAX_BYTES)}"}`).reason).toBe("oversize");
    expect(score("sure: " + VALID).reason).toBe("unparseable");
    expect(score('{"campaigns":[{"title":"x","items":["G1"],"extra":1}]}').reason).toBe("schema");
    expect(score(reply({ title: "retry backoff", items: ["G1", "G9"] })).reason).toBe("unknown-id");
    expect(score(reply({ title: "retry backoff", items: ["G1", "G2"] }, { title: "retry backoff also landed here", items: ["G2", "G7"] })).reason).toBe("duplicate-id");
    for (const r of ["oversize", "unparseable", "schema", "unknown-id", "duplicate-id"]) {
      const s = [score(`{"campaigns":[],"x":"${"a".repeat(REPLY_MAX_BYTES)}"}`), score("sure: " + VALID), score('{"campaigns":[{"title":"x","items":["G1"],"extra":1}]}'),
        score(reply({ title: "retry backoff", items: ["G1", "G9"] })), score(reply({ title: "retry backoff", items: ["G1", "G2"] }, { title: "t", items: ["G2", "G7"] }))].find((x) => x.reason === r)!;
      expect([s.outcome, s.proposed, s.kept, s.after]).toEqual(["rejected", 0, 0, 9]);
    }
    // rejected, per live-check letter — through the seam, one letter each
    for (const letter of ["a", "b", "c", "d", "e", "f"] as LiveCheckLetter[]) {
      const s = score(VALID, "on", { liveCheck: () => ({ ok: false, letter, reason: `live-check-${letter}` as const }) });
      expect([s.outcome, s.reason, s.kept]).toEqual(["rejected", `live-check-${letter}`, 1]);
      expect(s.candidate).toBeDefined();                                // the candidate existed; the page stays Stage 1's
    }
    // …and one REAL live-check rejection: an apply that returns the struct unchanged fails (e)
    const e = score(VALID, "on", { applyCampaigns: (s) => ({ candidate: s, headers: [] }) });
    expect([e.outcome, e.reason]).toEqual(["rejected", "live-check-e"]);
  });

  test("scoreReply sets after = before without a candidate", () => {
    expect(topLevelRecapCount(MORNING_STRUCT.recap)).toBe(9);
    for (const s of [score(reply()), score(reply({ title: "retry backoff", items: ["G1", "G3"] })), score("garbage"), score(reply({ title: "retry backoff", items: ["G1", "G9"] }))]) {
      expect(s.after).toBe(s.before);
      expect(s.after).toBe(9);
      expect("candidate" in s).toBe(false);
    }
    // with a candidate, `after` is the candidate's own count — never derived arithmetically
    const on = score(VALID, "on");
    expect(on.after).toBe(topLevelRecapCount(on.candidate!.recap));
    expect(on.after).toBe(8);
  });

  test("scoreReply counts proposed before drops", () => {
    // two campaigns proposed, one dropped (too few items): proposed 2, kept 1, dropped 1
    const s = score(reply({ title: "retry backoff", items: ["G1", "G2"] }, { title: "retry backoff also landed here", items: ["G7"] }), "trial");
    expect([s.outcome, s.proposed, s.kept, s.dropped.length]).toEqual(["trial", 2, 1, 1]);
    expect(s.dropped[0]!.reasons).toContain("too-few-items");
    // every campaign dropped: proposed 3, kept 0, outcome none
    const n = score(reply({ title: "retry backoff", items: ["G1", "G3"] }, { title: "x", items: ["G2"] }, { title: "zz", items: ["G6", "G7"] }));
    expect([n.outcome, n.proposed, n.kept, n.dropped.length]).toEqual(["none", 3, 0, 3]);
    // a whole-reply rejection proposes nothing
    expect(score(reply({ title: "retry backoff", items: ["G1", "G9"] }, { title: "y", items: ["G2", "G6"] })).proposed).toBe(0);
  });

  test("scoreReply passes impl through: a throwing applyCampaigns or liveCheck propagates", () => {
    expect(() => score(VALID, "on", { applyCampaigns: () => { throw new Error("apply boom"); } })).toThrow("apply boom");
    expect(() => score(VALID, "on", { liveCheck: () => { throw new Error("live boom"); } })).toThrow("live boom");
    // the seam is merged over the real implementation: an impl that supplies only liveCheck still applies
    let calls = 0;
    const s = score(VALID, "on", { liveCheck: (a, b, c, d) => { calls++; return liveCheck(a, b, c, d); } });
    expect([calls, s.outcome]).toEqual([1, "applied"]);
    expect(realRecapImpl.applyCampaigns).toBe(applyCampaigns);
    expect(realRecapImpl.liveCheck).toBe(liveCheck);
    expect(realRecapImpl.buildCampaignItems).toBe(buildCampaignItems);
    // a `none` reply never reaches apply or the live check
    let reached = 0;
    score(reply(), "on", { applyCampaigns: () => { reached++; return { candidate: MORNING_STRUCT, headers: [] }; }, liveCheck: () => { reached++; return { ok: true }; } });
    expect(reached).toBe(0);
  });

  test("scoreReply never mutates struct", () => {
    const before = JSON.stringify(MORNING_STRUCT);
    score(VALID, "on"); score(VALID, "trial"); score(reply()); score("garbage");
    score(reply({ title: "retry backoff", items: ["G1", "G3"] }));
    score(VALID, "on", { liveCheck: () => ({ ok: false, letter: "d", reason: "live-check-d" }) });
    expect(JSON.stringify(MORNING_STRUCT)).toBe(before);
    expect(MORNING_STRUCT.recap.some((r) => r.campaign !== undefined)).toBe(false);
    const on = score(VALID, "on");
    expect(on.candidate!.recap).not.toBe(MORNING_STRUCT.recap);
  });
});
