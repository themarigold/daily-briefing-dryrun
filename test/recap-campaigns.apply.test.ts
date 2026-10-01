// test/recap-campaigns.apply.test.ts — tier B, T1.4: `applyCampaigns` (§4.7 "Types and apply"). Cases
// V18–V24 of spec §5.2 (plan §7).
import { test, expect, describe } from "bun:test";
import { applyCampaigns, buildCampaignItems, campaignHeaderText, type KeptCampaign } from "../src/recapCampaigns";
import { MORNING_RECAP, MORNING_STRUCT, MORNING_COMMITS, A } from "./fixtures/campaign-morning";
import type { BriefingStruct } from "../src/types";

const ITEMS = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
const byId = (id: string) => ITEMS.find((i) => i.id === id)!;
const kept = (title: string, ids: string[]): KeptCampaign => ({ title, labelKey: byId(ids[0]!).labelKey, items: ids.map(byId) });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

describe("applyCampaigns (§4.7)", () => {
  test("[TB-V18] apply stamps EXACTLY the kept items' entries and nothing else", () => {
    const { candidate } = applyCampaigns(MORNING_STRUCT, [kept("retry backoff", ["G1", "G2"])]);
    const stamped = candidate.recap.map((r, i) => (r.campaign !== undefined ? i : -1)).filter((i) => i >= 0);
    expect(stamped).toEqual([0, 1, 2]);                                 // G1's two entries and G2's one
    expect(new Set(candidate.recap.slice(0, 3).map((r) => r.campaign)).size).toBe(1);
    for (const i of [3, 4, 5, 6, 7, 8, 9]) expect(candidate.recap[i]).toBe(MORNING_STRUCT.recap[i]);   // the original objects
    // no kept campaign → nothing stamped, and every entry is the original object
    const none = applyCampaigns(MORNING_STRUCT, []);
    expect(none.headers).toEqual([]);
    none.candidate.recap.forEach((r, i) => expect(r).toBe(MORNING_STRUCT.recap[i]!));
  });

  test("[TB-V19] N = |⋃ commits|, and two bullets citing ONE commit give `— 1 commit`", () => {
    const { candidate, headers } = applyCampaigns(MORNING_STRUCT, [kept("retry backoff", ["G1", "G2"])]);
    expect(candidate.recap[0]!.campaign).toBe("retry backoff — 3 commits");               // A, B, C
    expect(headers).toEqual(["   • [accountant_ai] retry backoff — 3 commits"]);
    // Two singles resolving to the same commit: N is 1, singular.
    const struct: BriefingStruct = { ...MORNING_STRUCT, recap: [
      { repo: "app", text: "retry path reworked twice", evidence: "a1a1a1a" },
      { repo: "app", text: "retry path reworked, cited again", evidence: "a1a1a1a" },
    ] };
    const items = buildCampaignItems(struct.recap, MORNING_COMMITS);
    expect(items.map((i) => i.commits)).toEqual([[A], [A]]);
    const one = applyCampaigns(struct, [{ title: "retry path reworked", labelKey: "app", items }]);
    expect(one.candidate.recap.map((r) => r.campaign)).toEqual(["retry path reworked — 1 commit", "retry path reworked — 1 commit"]);
    expect(one.headers).toEqual(["   • [app] retry path reworked — 1 commit"]);
    expect(campaignHeaderText("t", 1)).toBe("t — 1 commit");
    expect(campaignHeaderText("t", 2)).toBe("t — 2 commits");
  });

  test("[TB-V20] the bracket is `struct.recap[min entry].repo` — the RAW repo string of the first member entry", () => {
    const struct: BriefingStruct = { ...MORNING_STRUCT, recap: [
      { repo: "other", text: "unrelated", evidence: "d4d4d4d" },
      { repo: "Accountant_AI.", text: "retry backoff added", evidence: "b2b2b2b" },
      { repo: "accountant_ai", text: "retry backoff tuned", evidence: "c3c3c3c" },
    ] };
    const items = buildCampaignItems(struct.recap, MORNING_COMMITS);
    expect(items.map((i) => [i.id, i.labelKey])).toEqual([["G1", "other"], ["G2", "accountant_ai"], ["G3", "accountant_ai"]]);
    // kept with the items in REVERSE order: the bracket still comes from the minimum entry (index 1)
    const { headers } = applyCampaigns(struct, [{ title: "retry backoff", labelKey: "accountant_ai", items: [items[2]!, items[1]!] }]);
    expect(headers).toEqual(["   • [Accountant_AI.] retry backoff — 2 commits"]);
  });

  test("[TB-V21] `headers` are in render order — ascending first entry — whatever order the campaigns were kept in", () => {
    const later = kept("retry backoff also landed here", ["G6", "G7"]);      // first entry 7
    const earlier = kept("retry backoff", ["G1", "G2"]);                     // first entry 0
    const { headers } = applyCampaigns(MORNING_STRUCT, [later, earlier]);
    expect(headers).toEqual([
      "   • [accountant_ai] retry backoff — 3 commits",
      "   • [accountant_ai] retry backoff also landed here — 2 commits",
    ]);
  });

  test("[TB-V22] purity: the input struct is deep-equal to before, and `candidate.recap` is a new array", () => {
    const before = clone(MORNING_STRUCT);
    const keptOne = kept("retry backoff", ["G1", "G2"]);
    const keptBefore = clone(keptOne);
    const { candidate } = applyCampaigns(MORNING_STRUCT, [keptOne]);
    expect(MORNING_STRUCT).toEqual(before);
    expect(keptOne).toEqual(keptBefore);
    expect(candidate.recap).not.toBe(MORNING_STRUCT.recap);
    expect(MORNING_STRUCT.recap.some((r) => r.campaign !== undefined)).toBe(false);
    // running it twice on the same input gives the same output — no hidden state
    expect(applyCampaigns(MORNING_STRUCT, [keptOne])).toEqual(applyCampaigns(MORNING_STRUCT, [keptOne]));
  });

  test("[TB-V23] the candidate differs from the struct ONLY by `campaign` on the stamped entries", () => {
    const { candidate } = applyCampaigns(MORNING_STRUCT, [kept("retry backoff", ["G1", "G2"])]);
    const stripped: BriefingStruct = { ...candidate, recap: candidate.recap.map(({ campaign: _c, ...rest }) => rest) };
    expect(stripped).toEqual(MORNING_STRUCT);
    // every other top-level field is the SAME reference — nothing else in the struct changes
    for (const k of Object.keys(MORNING_STRUCT) as (keyof BriefingStruct)[]) if (k !== "recap") expect(candidate[k]).toBe(MORNING_STRUCT[k]);
    // …and a stamped entry keeps its own fields byte for byte
    expect(candidate.recap[0]).toEqual({ ...MORNING_STRUCT.recap[0]!, campaign: "retry backoff — 3 commits" });
  });

  test("[TB-V24] every entry of an absorbed Stage-1 group carries the campaign, spelled identically, beside its `group`", () => {
    const { candidate } = applyCampaigns(MORNING_STRUCT, [kept("retry backoff", ["G1", "G2"])]);
    const g = candidate.recap.filter((r) => r.group === "queue.py retry path reworked — 2 commits");
    expect(g).toHaveLength(2);
    expect(g.map((r) => r.campaign)).toEqual(["retry backoff — 3 commits", "retry backoff — 3 commits"]);
    expect(g.map((r) => r.group)).toEqual(["queue.py retry path reworked — 2 commits", "queue.py retry path reworked — 2 commits"]);
    // a second campaign of singles stamps its own text and nothing of the first
    const both = applyCampaigns(MORNING_STRUCT, [kept("retry backoff", ["G1", "G2"]), kept("retry backoff also landed here", ["G6", "G7"])]);
    expect(both.candidate.recap.map((r) => r.campaign)).toEqual([
      "retry backoff — 3 commits", "retry backoff — 3 commits", "retry backoff — 3 commits", undefined, undefined, undefined, undefined,
      "retry backoff also landed here — 2 commits", "retry backoff also landed here — 2 commits", undefined,
    ]);
  });
});
