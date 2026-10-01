// test/render.campaign.test.ts — tier B, T2.1: the campaign branch of `renderBriefing` (spec §4.7 "Render",
// "Order", the level-3 prefix, `whyFor`; D16). Cases P16, P18a, P18b, V25–V30, V32 of spec §5.2/§5.4
// (plan §7). With no `campaign` anywhere the page is byte-identical to base: T1.0's render golden is the
// committed proof; P18a is the in-file pin of the same property in the legend-test idiom.
import { test, expect, describe } from "bun:test";
import { renderBriefing, CAMPAIGN_L3_PREFIX } from "../src/render";
import { LEGEND_PREFIX, NOT_SHOWN_PREFIX, VERDICT_MARKER_PREFIX } from "../src/subprojects";
import { coverageGaps } from "../src/audit";
import { applyCampaigns, buildCampaignItems, topLevelRecapCount, type KeptCampaign } from "../src/recapCampaigns";
import { MORNING_STRUCT, MORNING_RECAP, MORNING_COMMITS } from "./fixtures/campaign-morning";
import type { BriefingStruct } from "../src/types";

type Entry = BriefingStruct["recap"][number];
const base: BriefingStruct = { date: "2026-09-24", machineScope: "h", provider: "p", resume: [], suggestions: [], recap: [] };
const page = (recap: Entry[], extra: Partial<BriefingStruct> = {}) => renderBriefing({ ...base, ...extra, recap });
/** The recap walk's lines: from the `▶ What you did` header to the first blank line, headers excluded. */
const walk = (out: string): string[] => {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith("▶ What you did"));
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l === "");
  return rest.slice(0, end < 0 ? rest.length : end);
};
const L1 = "   • ", L2 = "      ◦ ", L3 = CAMPAIGN_L3_PREFIX;
const G = "web/app.ts — 2 commits (Sep 14)";                    // a Stage-1 group header
const CAMP = "tidy the web app — 3 commits";                     // a campaign header text

// The fixture the order cases share: entries 0–9, campaign `CAMP` over the group at 2–3 and the single
// at 7 (first member entry 2), a second campaign at 8–9, ungrouped and unresolved bullets between.
const ORDER: Entry[] = [
  { repo: "app", text: "zero, ungrouped", evidence: "0000000" },
  { repo: "app", text: "one, unresolved bullet with no evidence" },
  { repo: "app", text: "two, first group member", evidence: "2222222", group: G, campaign: CAMP },
  { repo: "app", text: "three, second group member", evidence: "3333333", group: G, campaign: CAMP },
  { repo: "app", text: "four, ungrouped", evidence: "4444444" },
  { repo: "other", text: "five, another label", evidence: "5555555" },
  { repo: "app", text: "six, a level-1 group member", evidence: "6666666", group: "other.ts — 2 commits" },
  { repo: "app", text: "seven, a single member", evidence: "7777777", campaign: CAMP },
  { repo: "app", text: "eight, second campaign", evidence: "8888888", campaign: "second — 2 commits" },
  { repo: "app", text: "nine, second campaign", evidence: "9999999", campaign: "second — 2 commits" },
  { repo: "app", text: "ten, the other level-1 group member", evidence: "aaaaaaa", group: "other.ts — 2 commits" },
];

describe("the campaign branch (§4.7)", () => {
  test("[TB-P16] the level-3 prefix starts with NONE of the three coverageGaps exclusion prefixes — against the exported constants", () => {
    expect(CAMPAIGN_L3_PREFIX).toBe("         ▪ ");                       // nine spaces, U+25AA, one space
    expect(CAMPAIGN_L3_PREFIX.length).toBe(11);
    for (const p of [LEGEND_PREFIX, NOT_SHOWN_PREFIX, VERDICT_MARKER_PREFIX]) {
      expect(p.length).toBeGreaterThan(0);                                         // not vacuous
      expect(CAMPAIGN_L3_PREFIX.startsWith(p)).toBe(false);
      expect(CAMPAIGN_L3_PREFIX).not.toBe(p);
    }
    // …and the render really uses it: a level-3 line starts with the constant.
    const out = page(ORDER);
    const l3 = walk(out).filter((l) => l.startsWith(L3));
    expect(l3).toEqual([`${L3}[app] two, first group member  (2222222)`, `${L3}[app] three, second group member  (3333333)`]);
    // The BEHAVIOURAL half, and the load-bearing one: a label the page names ONLY on a level-3 line still
    // COVERS its repo under the real reader. `zq` is in the level-3 line's TEXT and nowhere else on the
    // page — the campaign header, the level-2 group header and every bracket say `[app]` — so were the
    // prefix to begin with an exclusion prefix, `coverageGaps` would drop that one line from its haystack
    // and report the repo as a gap. This half stands without the constants assertions above.
    const only = page([
      { repo: "app", text: "touched zq bindings", evidence: "1111111", group: "f — 1 commit", campaign: "c — 1 commit" },
    ]);
    expect(walk(only).filter((l) => l.startsWith(L3))).toHaveLength(1);
    expect(only.split("\n").filter((l) => /zq/i.test(l))).toEqual([`${L3}[app] touched zq bindings  (1111111)`]);   // the ONLY mention
    expect(coverageGaps([{ repo: "/w/zqrepo", labels: ["zq"] }], only)).toEqual([]);
    // controls: the reader reports the gap when the level-3 line does not name the label (same shape), and
    // when nothing names the repo at all
    expect(coverageGaps([{ repo: "/w/zqrepo", labels: ["zq"] }], page([
      { repo: "app", text: "touched bindings", evidence: "1111111", group: "f — 1 commit", campaign: "c — 1 commit" },
    ]))).toHaveLength(1);
    expect(coverageGaps([{ repo: "/w/zqrepo", labels: ["zq"] }], page([{ repo: "other", text: "x" }]))).toHaveLength(1);
  });

  test("[TB-P18a] no `campaign` → byte-identical output (the legend-test pattern); the branch fires on `!== undefined`, never on truthiness (D16)", () => {
    const stage1: Entry[] = ORDER.map(({ campaign: _c, ...rest }) => rest);
    const withoutKey = page(stage1);
    // the same entries with the key PRESENT but undefined must render the same bytes
    const explicitUndefined = page(stage1.map((e) => ({ ...e, campaign: undefined })));
    expect(explicitUndefined).toBe(withoutKey);
    expect(withoutKey).not.toContain(L3);
    expect(withoutKey).not.toContain(CAMP);
    // and the pre-B two-level shape is what renders: groups at level 1, members at level 2
    expect(walk(withoutKey)).toEqual([
      `${L1}[app] zero, ungrouped  (0000000)`,
      `${L1}[app] one, unresolved bullet with no evidence`,
      `${L1}[app] ${G}`,
      `${L2}[app] two, first group member  (2222222)`,
      `${L2}[app] three, second group member  (3333333)`,
      `${L1}[app] four, ungrouped  (4444444)`,
      `${L1}[other] five, another label  (5555555)`,
      `${L1}[app] other.ts — 2 commits`,
      `${L2}[app] six, a level-1 group member  (6666666)`,
      `${L2}[app] ten, the other level-1 group member  (aaaaaaa)`,
      `${L1}[app] seven, a single member  (7777777)`,
      `${L1}[app] eight, second campaign  (8888888)`,
      `${L1}[app] nine, second campaign  (9999999)`,
    ]);
    // D16 in the other direction: an EMPTY stamp is `!== undefined`, so it fires (a header with empty
    // text) — a truthiness test would silently drop the branch for it.
    const empty = page([{ repo: "app", text: "x", evidence: "1111111", campaign: "" }]);
    expect(walk(empty)).toEqual([`${L1}[app] `, `${L2}[app] x  (1111111)`]);
  });

  test("[TB-P18b] the three levels render as §4.7 specifies: campaign header, its group at level 2 with members at level 3, its single at level 2", () => {
    const out = page([
      { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: G, campaign: CAMP },
      { repo: "mono", text: "tuned the grid", evidence: "1f2e3d4", group: G, campaign: CAMP },
      { repo: "mono", text: "fixed the footer", evidence: "9f8e7d6", campaign: CAMP },
    ]);
    expect(walk(out)).toEqual([
      `${L1}[mono] ${CAMP}`,
      `${L2}[mono] ${G}`,
      `${L3}[mono] reworked the header  (0a1b2c3)`,
      `${L3}[mono] tuned the grid  (1f2e3d4)`,
      `${L2}[mono] fixed the footer  (9f8e7d6)`,
    ]);
    // the why line precedes the campaign header, once per label
    const why = page([
      { repo: "mono", text: "a", evidence: "0a1b2c3", campaign: CAMP },
      { repo: "Mono.", text: "b", evidence: "1f2e3d4", campaign: CAMP },
      { repo: "mono", text: "c, ungrouped later" },
    ], { whys: { mono: "tidy the web app" } });
    const w = walk(why);
    expect(w[0]).toBe('   — you wrote: "tidy the web app"');
    expect(w[1]).toBe(`${L1}[mono] ${CAMP}`);
    expect(w.filter((l) => l.includes("you wrote"))).toHaveLength(1);
    // membership is keyed on `norm(repo)`: `Mono.` is the same label as `mono`, so its entry renders under
    // the campaign at level 2. Keyed on the raw string it would be skipped there, then skipped again at its
    // own slot (its norm-keyed campaign is already emitted) — the line would silently vanish.
    expect(w).toContain(`${L2}[Mono.] b  (1f2e3d4)`);
    expect(w).toEqual([
      '   — you wrote: "tidy the web app"',
      `${L1}[mono] ${CAMP}`,
      `${L2}[mono] a  (0a1b2c3)`,
      `${L2}[Mono.] b  (1f2e3d4)`,
      `${L1}[mono] c, ungrouped later`,
    ]);
    // every entry renders exactly once, whatever its level
    expect(walk(out).filter((l) => /reworked the header|tuned the grid|fixed the footer/.test(l))).toHaveLength(3);
  });

  test("[TB-V25] a campaign renders at its FIRST member's position — entry 7's campaign at entry 7's slot", () => {
    const recap: Entry[] = Array.from({ length: 10 }, (_, i) => ({ repo: "app", text: `bullet ${i}`, evidence: `${i}${i}${i}${i}${i}${i}${i}` }));
    recap[7] = { ...recap[7]!, campaign: "late — 2 commits" };
    recap[9] = { ...recap[9]!, campaign: "late — 2 commits" };
    const lines = walk(page(recap));
    expect(lines.indexOf(`${L1}[app] late — 2 commits`)).toBe(7);           // exactly where entry 7 sat
    expect(lines.slice(0, 7).map((l) => l.startsWith(L1))).toEqual(Array(7).fill(true));
    expect(lines.slice(8)).toEqual([`${L2}[app] bullet 7  (7777777)`, `${L2}[app] bullet 9  (9999999)`, `${L1}[app] bullet 8  (8888888)`]);
  });

  test("[TB-V26] members render beneath their campaign in Stage-1 order", () => {
    const lines = walk(page(ORDER));
    const at = lines.indexOf(`${L1}[app] ${CAMP}`);
    expect(lines.slice(at, at + 5)).toEqual([
      `${L1}[app] ${CAMP}`,
      `${L2}[app] ${G}`,
      `${L3}[app] two, first group member  (2222222)`,
      `${L3}[app] three, second group member  (3333333)`,
      `${L2}[app] seven, a single member  (7777777)`,             // entry 7 moved up, after the group
    ]);
  });

  test("[TB-V27] a member lands under its own campaign and no other", () => {
    const lines = walk(page(ORDER));
    const first = lines.indexOf(`${L1}[app] ${CAMP}`);
    const second = lines.indexOf(`${L1}[app] second — 2 commits`);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    const under = (from: number) => { const out: string[] = []; for (let i = from + 1; i < lines.length && !lines[i]!.startsWith(L1); i++) out.push(lines[i]!); return out; };
    expect(under(first).some((l) => /eight|nine/.test(l))).toBe(false);
    expect(under(second)).toEqual([`${L2}[app] eight, second campaign  (8888888)`, `${L2}[app] nine, second campaign  (9999999)`]);
    // the same campaign text under two labels is two campaigns (keyed on norm(repo) + text)
    const two = walk(page([
      { repo: "a", text: "x", evidence: "1111111", campaign: "same — 2 commits" },
      { repo: "b", text: "y", evidence: "2222222", campaign: "same — 2 commits" },
      { repo: "a", text: "z", evidence: "3333333", campaign: "same — 2 commits" },
    ]));
    expect(two).toEqual([
      `${L1}[a] same — 2 commits`, `${L2}[a] x  (1111111)`, `${L2}[a] z  (3333333)`,
      `${L1}[b] same — 2 commits`, `${L2}[b] y  (2222222)`,
    ]);
  });

  test("[TB-V28] a Stage-1 group renders at level 2 with members at level 3 — including a hand-built SPLIT group, which pins the SHARED cluster set", () => {
    // Whole group: header once at level 2, both members at level 3, never again at level 1.
    const whole = walk(page(ORDER));
    expect(whole.filter((l) => l.includes(G))).toEqual([`${L2}[app] ${G}`]);
    expect(whole.filter((l) => l.startsWith(L3))).toHaveLength(2);
    // SPLIT group — one member stamped with the campaign, one NOT: a shape applyCampaigns never produces,
    // built to pin the shared `emittedClusters`. Under §4.7's walk the group's header renders ONCE (level
    // 2, under the campaign) with BOTH members at level 3, and the Stage-1 walk skips the outside member
    // through the shared set. A per-branch set would re-emit the header at level 1 with both members at
    // level 2 — the second member would then render twice.
    const split: Entry[] = [
      { repo: "app", text: "stamped member", evidence: "1111111", group: G, campaign: CAMP },
      { repo: "app", text: "single member", evidence: "2222222", campaign: CAMP },
      { repo: "app", text: "outside member, same group, no stamp", evidence: "3333333", group: G },
      { repo: "app", text: "trailing ungrouped", evidence: "4444444" },
    ];
    const lines = walk(page(split));
    expect(lines).toEqual([
      `${L1}[app] ${CAMP}`,
      `${L2}[app] ${G}`,
      `${L3}[app] stamped member  (1111111)`,
      `${L3}[app] outside member, same group, no stamp  (3333333)`,
      `${L2}[app] single member  (2222222)`,
      `${L1}[app] trailing ungrouped  (4444444)`,
    ]);
    // every member renders exactly once, and the group header exactly once
    for (const needle of ["stamped member", "single member", "outside member", "trailing ungrouped"]) {
      expect(lines.filter((l) => l.includes(needle))).toHaveLength(1);
    }
    expect(lines.filter((l) => l.includes(G))).toHaveLength(1);
    // …and the other direction of sharing: a group ALREADY emitted at level 1 is not re-emitted under a
    // later campaign (the outside member comes first here).
    const reversed: Entry[] = [split[2]!, split[0]!, split[1]!];
    const r = walk(page(reversed));
    expect(r.filter((l) => l.includes(G))).toEqual([`${L1}[app] ${G}`]);
    expect(r).toEqual([
      `${L1}[app] ${G}`,
      `${L2}[app] outside member, same group, no stamp  (3333333)`,
      `${L2}[app] stamped member  (1111111)`,
      `${L1}[app] ${CAMP}`,
      `${L2}[app] single member  (2222222)`,
    ]);
  });

  test("[TB-V29] non-members keep their relative order, and every level-1 line keeps its order", () => {
    const lines = walk(page(ORDER)).filter((l) => l.startsWith(L1));
    expect(lines).toEqual([
      `${L1}[app] zero, ungrouped  (0000000)`,
      `${L1}[app] one, unresolved bullet with no evidence`,
      `${L1}[app] ${CAMP}`,
      `${L1}[app] four, ungrouped  (4444444)`,
      `${L1}[other] five, another label  (5555555)`,
      `${L1}[app] other.ts — 2 commits`,
      `${L1}[app] second — 2 commits`,
    ]);
    // the Stage-1 walk beneath `other.ts` is untouched: its two members at level 2, in order
    const all = walk(page(ORDER));
    const at = all.indexOf(`${L1}[app] other.ts — 2 commits`);
    expect(all.slice(at + 1, at + 3)).toEqual([`${L2}[app] six, a level-1 group member  (6666666)`, `${L2}[app] ten, the other level-1 group member  (aaaaaaa)`]);
  });

  test("[TB-V30] an unresolved bullet never moves — same slot with and without campaigns around it", () => {
    const withC = walk(page(ORDER));
    const withoutC = walk(page(ORDER.map(({ campaign: _c, ...rest }) => rest)));
    const line = `${L1}[app] one, unresolved bullet with no evidence`;
    expect(withC.indexOf(line)).toBe(1);
    expect(withoutC.indexOf(line)).toBe(1);
    expect(withC[0]).toBe(withoutC[0]);
    // §4.7 "Order" proper: in ORDER the unresolved bullet precedes the campaign's first member, so the rule
    // for a non-member BETWEEN the first and a later member is never exercised there. Here it is: the
    // bullet keeps its level-1 slot and is never nested; the later member moves up to its campaign, above
    // it, by design; the members keep Stage-1 order.
    const between: Entry[] = [
      { repo: "app", text: "first member", evidence: "1111111", campaign: CAMP },
      { repo: "app", text: "unresolved, between the members" },
      { repo: "app", text: "later member", evidence: "3333333", campaign: CAMP },
      { repo: "app", text: "trailing, ungrouped", evidence: "4444444" },
    ];
    const u = `${L1}[app] unresolved, between the members`;
    const bw = walk(page(between));
    const bwo = walk(page(between.map(({ campaign: _c, ...rest }) => rest)));
    expect(bw).toEqual([
      `${L1}[app] ${CAMP}`,
      `${L2}[app] first member  (1111111)`,
      `${L2}[app] later member  (3333333)`,
      u,
      `${L1}[app] trailing, ungrouped  (4444444)`,
    ]);
    expect(bw.filter((l) => l.includes("unresolved, between"))).toEqual([u]);   // once, at level 1: unnested
    const level1 = (ls: string[]) => ls.filter((l) => l.startsWith(L1));
    expect(level1(bwo).indexOf(u)).toBe(1);
    expect(level1(bw).indexOf(u)).toBe(1);                                       // the same level-1 slot
  });

  test("[TB-V32] on a candidate, topLevelRecapCount equals the `   • ` lines the walk emits before the 🔀 foot", () => {
    const items = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
    const byId = (id: string) => items.find((i) => i.id === id)!;
    const kept: KeptCampaign[] = [
      { title: "retry backoff", labelKey: "accountant_ai", items: [byId("G1"), byId("G2")] },
      { title: "retry backoff also landed here", labelKey: "accountant_ai", items: [byId("G6"), byId("G7")] },
    ];
    const { candidate, headers } = applyCampaigns(MORNING_STRUCT, kept);
    const withFoot: BriefingStruct = { ...candidate, windowMerges: [{ repo: "accountant_ai", text: "🔀 Merged #9 (fix/y) (Sep 13)  (e5f6a7b)" }] };
    const out = renderBriefing(withFoot);
    const lines = out.split("\n");
    const start = lines.findIndex((l) => l.startsWith("▶ What you did"));
    let level1 = 0;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (l === "" || l.includes("🔀")) break;
      if (l.startsWith(L1)) level1++;
    }
    expect(topLevelRecapCount(candidate.recap)).toBe(level1);
    expect(level1).toBe(9 - 4 + 2);                              // 9 Stage-1 lines, 4 items absorbed into 2 campaigns
    expect(topLevelRecapCount(candidate.recap)).toBeLessThan(topLevelRecapCount(MORNING_STRUCT.recap));
    // the headers applyCampaigns promised are the level-1 lines the render drew, in order
    const drawn = lines.slice(start + 1).filter((l) => l.startsWith(L1) && /commits?$/.test(l) && !l.includes("🔀"));
    expect(drawn.filter((l) => headers.includes(l))).toEqual(headers);
    // the same count on the Stage-1 struct, for the record's `before`
    expect(topLevelRecapCount(MORNING_STRUCT.recap)).toBe(9);
  });
});
