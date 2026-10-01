// test/recap-campaigns.livecheck.test.ts — tier B, T2.2: `liveCheck` (spec §4.7 "Live check" (a)–(f)).
// Cases P17a–g of spec §5.4 (plan §7): each fixture fails ONLY the named check, driving `liveCheck`
// directly, plus the plan-added multiset pin for (d) and (T2.3 fix) the 🔀 foot-line pin for (f): the
// level-1 walk stops at the real foot line only — a 🔀 inside a why quote or a bullet's text does not end it.
import { test, expect, describe } from "bun:test";
import { liveCheck, applyCampaigns, buildCampaignItems, campaignHeaderLine, campaignHeaderText, level1RecapLines, type KeptCampaign, type CoverageUnits } from "../src/recapCampaigns";
import { renderBriefing } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import { extractCitedShas, coverageGaps } from "../src/audit";
import { MORNING_STRUCT, MORNING_RECAP, MORNING_COMMITS, MORNING_LABELS } from "./fixtures/campaign-morning";
import type { BriefingStruct } from "../src/types";

type Entry = BriefingStruct["recap"][number];
const ITEMS = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
const byId = (id: string) => ITEMS.find((i) => i.id === id)!;
const kept = (title: string, ids: string[]): KeptCampaign => ({ title, labelKey: byId(ids[0]!).labelKey, items: ids.map(byId) });
/** Check (c)'s rows for the fixture deployment: every label as its own row. */
const UNITS: CoverageUnits = [...MORNING_LABELS, "personal_code"].map((l) => ({ repo: `/w/${l}`, labels: [l] }));
/** The real candidate for `retry backoff` over G1+G2 — every check passes on it. */
const VALID = applyCampaigns(MORNING_STRUCT, [kept("retry backoff", ["G1", "G2"])]);
const reasonOf = (candidate: BriefingStruct, headers: string[], units: CoverageUnits = UNITS, struct: BriefingStruct = MORNING_STRUCT) => {
  const r = liveCheck(struct, candidate, headers, units);
  return r.ok ? "ok" : r.reason;
};

describe("liveCheck (§4.7): each check has a fixture that fails ONLY it", () => {
  test("control: the real candidate passes every check", () => {
    expect(liveCheck(MORNING_STRUCT, VALID.candidate, VALID.headers, UNITS)).toEqual({ ok: true });
    expect(VALID.headers).toEqual(["   • [accountant_ai] retry backoff — 3 commits"]);
  });

  test("[TB-P17a] (d) only: a candidate that drops a Stage-1 header", () => {
    // The group's members keep their campaign stamp but lose their `group`: the level-2 header line
    // `[accountant_ai] queue.py retry path reworked — 2 commits` vanishes from the page. (a)–(c) still
    // hold (the header carries no SHA and only a label every member line also carries); (d) fails.
    const recap = VALID.candidate.recap.map((r) => (r.group !== undefined ? (({ group: _g, ...rest }) => rest)(r) : r));
    expect(reasonOf({ ...VALID.candidate, recap }, VALID.headers)).toBe("live-check-d");
  });

  test("[TB-P17b] (f) only: a reordered non-member — and the unreordered candidate passes (f) with its members at level 2", () => {
    // Swap two ungrouped non-members (entries 3 and 4: G3 quant_stocks and G4) in the candidate: the
    // multiset of lines is unchanged, the count still fell, but the level-1 order is not a subsequence.
    const recap = [...VALID.candidate.recap];
    [recap[3], recap[4]] = [recap[4]!, recap[3]!];
    expect(reasonOf({ ...VALID.candidate, recap }, VALID.headers)).toBe("live-check-f");
    // The pass side pins WHAT (f) reads: level-1 lines only. The valid candidate's absorbed members sit at
    // level 2 (`◦`) — lines absent from Stage 1's level-1 sequence — and (f) must not read them.
    expect(reasonOf(VALID.candidate, VALID.headers)).toBe("ok");
    const b = redactCredentials(renderBriefing(VALID.candidate));
    expect(level1RecapLines(b)).toHaveLength(8);                        // 9 Stage-1 lines − 2 absorbed items + 1 header
    expect(level1RecapLines(redactCredentials(renderBriefing(MORNING_STRUCT)))).toHaveLength(9);
    expect(b).toContain("      ◦ [accountant_ai] retry backoff tuned for the queue  (c3c3c3c)");
  });

  test("[TB-P17c] (b) only: a header whose title carries a 7-hex run", () => {
    // `cafef00` is a fresh left-bounded 7-hex window on the page (the morning's own `deadbeef1` bullet
    // means `deadbee` would NOT be fresh); it sits in no parenthesised citation group and no `evidence:`
    // channel, so (a) still holds. (Validation's rule 4 would refuse the title; the live check is driven
    // directly here.)
    const stage1 = redactCredentials(renderBriefing(MORNING_STRUCT)).toLowerCase();
    expect(stage1).not.toContain("cafef00");
    const { candidate, headers } = applyCampaigns(MORNING_STRUCT, [kept("cafef00 retry backoff", ["G1", "G2"])]);
    expect(headers).toEqual(["   • [accountant_ai] cafef00 retry backoff — 3 commits"]);
    expect(reasonOf(candidate, headers)).toBe("live-check-b");
    // …whereas a run the page ALREADY carries (`deadbee`, inside `deadbeef1`) moves no window: (b) holds
    const dup = applyCampaigns(MORNING_STRUCT, [kept("deadbee retry backoff", ["G1", "G2"])]);
    expect(reasonOf(dup.candidate, dup.headers)).toBe("ok");
  });

  test("[TB-P17d] (c) only: a label the page lacked, carried in the header TITLE", () => {
    // `zq` is a configured label the Stage-1 page never names (a genuine gap); the title names it, so
    // the candidate page covers it and the gap sets differ. The bracket cannot do this — it is the first
    // member's own repo, already on both pages.
    const units: CoverageUnits = [...UNITS, { repo: "/w/zq", labels: ["zq"] }];
    const stage1 = redactCredentials(renderBriefing(MORNING_STRUCT));
    expect(coverageGaps(units as { repo: string; labels: string[] }[], stage1).flatMap((g) => g.labels)).toEqual(["personal_code", "zq"]);
    const { candidate, headers } = applyCampaigns(MORNING_STRUCT, [kept("zq retry backoff", ["G1", "G2"])]);
    expect(reasonOf(candidate, headers, units)).toBe("live-check-c");
    // …and with `zq` not configured, the same candidate passes (the title is just words).
    expect(reasonOf(candidate, headers, UNITS)).toBe("ok");
  });

  test("[TB-P17e] (a) only: a citation-shaped header", () => {
    // Stage 1 carries `abc1234` in a bullet's TEXT only (no parens, no `evidence:`, cited by no bullet):
    // the 7-hex window exists on both pages, so (b) holds, but `extractCitedShas` does not mine it from
    // Stage 1 and does mine it from the header's `(abc1234)` citation group — the sets differ.
    const struct: BriefingStruct = { ...MORNING_STRUCT, recap: MORNING_RECAP.map((r, i) => (i === 4 ? { ...r, text: "landed abc1234 on the queue" } : r)) };
    const items = buildCampaignItems(struct.recap, MORNING_COMMITS);
    const k: KeptCampaign = { title: "see (abc1234) retry", labelKey: "accountant_ai", items: [items[0]!, items[1]!] };
    const { candidate, headers } = applyCampaigns(struct, [k]);
    expect(headers).toEqual(["   • [accountant_ai] see (abc1234) retry — 3 commits"]);
    const stage1 = redactCredentials(renderBriefing(struct));
    expect(extractCitedShas(stage1)).not.toContain("abc1234");
    expect(extractCitedShas(redactCredentials(renderBriefing(candidate)))).toContain("abc1234");
    expect(reasonOf(candidate, headers, UNITS, struct)).toBe("live-check-a");
  });

  test("[TB-P17f] (e) only: a candidate equal to the struct with an empty header list", () => {
    expect(reasonOf(MORNING_STRUCT, [])).toBe("live-check-e");
    expect(reasonOf({ ...MORNING_STRUCT, recap: [...MORNING_STRUCT.recap] }, [])).toBe("live-check-e");
  });

  test("[TB-P17g] PASSES: a bracket carrying a control byte — H absorbs it through the delivery transform", () => {
    // The three members (the G1 group and G2) all carry the control byte in their bracket, so they keep
    // ONE label key (`norm` does not strip control bytes) and the campaign stays one campaign.
    const ESC = String.fromCharCode(0x1b);
    const recap: Entry[] = MORNING_RECAP.map((r, i) => (i <= 2 ? { ...r, repo: `acc${ESC}ountant_ai` } : r));
    const struct: BriefingStruct = { ...MORNING_STRUCT, recap };
    const items = buildCampaignItems(recap, MORNING_COMMITS);
    expect(items.slice(0, 2).map((i) => [i.id, i.kind, i.commits.length])).toEqual([["G1", "group", 2], ["G2", "single", 1]]);
    const k: KeptCampaign = { title: "retry backoff", labelKey: items[0]!.labelKey, items: [items[0]!, items[1]!] };
    const { candidate, headers } = applyCampaigns(struct, [k]);
    expect(headers[0]).toContain(ESC);                                   // the raw bracket, as §4.7 defines it
    expect(headers[0]).toBe(campaignHeaderLine(`acc${ESC}ountant_ai`, campaignHeaderText("retry backoff", 3)));
    expect(liveCheck(struct, candidate, headers, UNITS)).toEqual({ ok: true });
    // …and a header with a credential-shaped run passes for the same reason: the page redacts it and so
    // does H.
    const token = `ghp_${"A".repeat(24)}`;
    const recap2: Entry[] = MORNING_RECAP.map((r, i) => (i <= 2 ? { ...r, repo: `acct ${token}` } : r));
    const struct2: BriefingStruct = { ...MORNING_STRUCT, recap: recap2 };
    const items2 = buildCampaignItems(recap2, MORNING_COMMITS);
    const c2 = applyCampaigns(struct2, [{ title: "retry backoff", labelKey: items2[0]!.labelKey, items: [items2[0]!, items2[1]!] }]);
    expect(c2.headers[0]).toContain(token);
    expect(redactCredentials(renderBriefing(c2.candidate))).not.toContain(token);
    expect(liveCheck(struct2, c2.candidate, c2.headers, UNITS)).toEqual({ ok: true });
  });

  test("liveCheck (d) compares multisets: a duplicated line is not absorbed", () => {
    // The candidate repeats one STAMPED member entry, so exactly one line appears twice and nothing else
    // moves: `recapCoverage` fixes the `▶ What you did` head count (which otherwise counts entries), the
    // duplicate shares its campaign key (the count is unchanged, (e) holds), and it sits under the
    // campaign ((f) reads level 1 only). As SETS the two pages' lines are equal once the header is
    // removed; as multisets they are not.
    const struct: BriefingStruct = { ...MORNING_STRUCT, recapCoverage: { shown: 8, total: 8, notShown: [] } };
    const valid = applyCampaigns(struct, [kept("retry backoff", ["G1", "G2"])]);
    expect(reasonOf(valid.candidate, valid.headers, UNITS, struct)).toBe("ok");
    const recap = [...valid.candidate.recap, valid.candidate.recap[2]!];          // G2's entry, stamped, again
    const candidate = { ...valid.candidate, recap };
    expect(candidate.recap.filter((r) => r.campaign !== undefined)).toHaveLength(4);
    const b = redactCredentials(renderBriefing(candidate)), stage1 = redactCredentials(renderBriefing(struct));
    expect(b.split("\n").filter((l) => l.includes("retry backoff tuned for the queue"))).toHaveLength(2);
    expect(new Set(b.split("\n").map((l) => l.replace(/^\s*[•◦▪]\s/, ""))).size).toBe(new Set(stage1.split("\n").map((l) => l.replace(/^\s*[•◦▪]\s/, ""))).size + 1);   // as sets: only the header differs
    expect(reasonOf(candidate, valid.headers, UNITS, struct)).toBe("live-check-d");
    // …and the header must itself be present: an H line the page lacks is a (d) failure too
    expect(reasonOf(VALID.candidate, ["   • [accountant_ai] a header the page does not carry — 3 commits"])).toBe("live-check-d");
  });

  test("liveCheck (f) stops at the 🔀 foot line only: a 🔀 in a why quote or a bullet's text does not end the walk", () => {
    // (f) reads level-1 lines "stopping at the first 🔀 foot line" (§4.7) — the line
    // `collapseWindowMerges` renders, not any line that happens to carry the glyph. A 🔀 in a user's
    // quoted turn or in a bullet's text ahead of a reorder must not end the walk: (f) would then compare
    // an empty or truncated sequence and pass the very reorder it exists to reject (P17b's swap).
    const swap = (c: BriefingStruct, i: number, j: number): BriefingStruct => {
      const recap = [...c.recap];
      [recap[i], recap[j]] = [recap[j]!, recap[i]!];
      return { ...c, recap };
    };
    const lvl1 = (s: BriefingStruct) => level1RecapLines(redactCredentials(renderBriefing(s)));
    // 1. a why quote: `whyFor` emits it right under `▶ What you did`, ahead of every recap line
    const withWhy: BriefingStruct = { ...MORNING_STRUCT, whys: { accountant_ai: "check the 🔀 foot lines" } };
    const w = applyCampaigns(withWhy, [kept("retry backoff", ["G1", "G2"])]);
    expect(reasonOf(swap(w.candidate, 3, 4), w.headers, UNITS, withWhy)).toBe("live-check-f");
    expect(reasonOf(w.candidate, w.headers, UNITS, withWhy)).toBe("ok");
    const page1 = redactCredentials(renderBriefing(withWhy)).split("\n");
    expect(page1[page1.findIndex((l) => l.startsWith("▶ What you did")) + 1]).toContain("check the 🔀 foot lines");
    expect([lvl1(withWhy).length, lvl1(w.candidate).length]).toEqual([9, 8]);
    // 2. a level-1 bullet's text, ahead of a later swap of two non-members (entries 6 and 7)
    const recap2 = MORNING_RECAP.map((r, i) => (i === 3 ? { ...r, text: "🔀 sharpe ratio guard added" } : r));
    const withBullet: BriefingStruct = { ...MORNING_STRUCT, recap: recap2 };
    const items2 = buildCampaignItems(recap2, MORNING_COMMITS);
    const bl = applyCampaigns(withBullet, [{ title: "retry backoff", labelKey: "accountant_ai", items: [items2[0]!, items2[1]!] }]);
    expect(reasonOf(swap(bl.candidate, 6, 7), bl.headers, UNITS, withBullet)).toBe("live-check-f");
    expect(reasonOf(bl.candidate, bl.headers, UNITS, withBullet)).toBe("ok");
    expect([lvl1(withBullet).length, lvl1(bl.candidate).length]).toEqual([9, 8]);
    // 3. the REAL foot, both collapsed shapes (2 PRs with a date span; 1 PR, undated): the walk stops AT it,
    //    so no foot line is read as a recap line — and (f) still rejects the swap above it
    const withFoot: BriefingStruct = { ...MORNING_STRUCT, windowMerges: [
      { repo: "accountant_ai", text: "🔀 Merged #12 (feat/a) (Sep 22)  (1a2b3c4)" },
      { repo: "accountant_ai", text: "🔀 Merged #11 (feat/b) (Sep 21)  (5d6e7f8)" },
      { repo: "quant_stocks", text: "🔀 Merged #7 (fix/c)  (9a8b7c6)" },
    ] };
    const foot = redactCredentials(renderBriefing(withFoot)).split("\n").filter((l) => l.includes("🔀"));
    expect(foot).toEqual([
      "   • [accountant_ai] 🔀 2 PRs merged (#12, #11) (Sep 21–Sep 22)  (1a2b3c4, 5d6e7f8)",
      "   • [quant_stocks] 🔀 1 PR merged (#7)  (9a8b7c6)",
    ]);
    const ft = applyCampaigns(withFoot, [kept("retry backoff", ["G1", "G2"])]);
    expect([lvl1(withFoot).length, lvl1(ft.candidate).length]).toEqual([9, 8]);
    for (const f of foot) expect([...lvl1(withFoot), ...lvl1(ft.candidate)]).not.toContain(f);
    expect(reasonOf(ft.candidate, ft.headers, UNITS, withFoot)).toBe("ok");
    expect(reasonOf(swap(ft.candidate, 3, 4), ft.headers, UNITS, withFoot)).toBe("live-check-f");
  });

  test("the checks run in order a → f: the first failure names the reason", () => {
    // Dropping the last entry (`cites nothing real`, evidence `9999999`) removes a 7-hex window AND a
    // line: (b) and (d) both fail, and (b) is named. Dropping the evidence-less entry 5 removes a line
    // only: (d) is named ((e) passes, the count fell).
    expect(reasonOf({ ...MORNING_STRUCT, recap: MORNING_STRUCT.recap.slice(0, -1) }, [])).toBe("live-check-b");
    expect(reasonOf({ ...MORNING_STRUCT, recap: MORNING_STRUCT.recap.filter((_, i) => i !== 5) }, [])).toBe("live-check-d");
  });
});
