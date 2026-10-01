// test/recap-campaigns.items.test.ts — tier B, T1.3: the offered items (§4.3), the count (§4.7) and the
// gate's load rule (§4.1). Cases V14–V17, V31, V33 of spec §5.2 (plan §7).
import { test, expect, describe } from "bun:test";
import { buildCampaignItems, busyByLoad, topLevelRecapCount, BUSY_COMMITS, BUSY_TOP_LINES, NO_PR_FACT } from "../src/recapCampaigns";
import { renderBriefing } from "../src/render";
import { RENDER_CORPUS } from "./fixtures/render-corpus";
import { MORNING_RECAP, MORNING_COMMITS, A, B, C, D, E, F, G, H } from "./fixtures/campaign-morning";
import type { BriefingStruct } from "../src/types";

describe("buildCampaignItems (§4.3)", () => {
  const items = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);

  test("[TB-V14] ids are consecutive over offered items, ordered by the index of each item's FIRST member entry", () => {
    // Seven offered items on the fixture morning (two bullets are unresolved): G1…G7 with no gap, and the
    // order is the first-entry order — a group at entries 0–1 leads, the quant_stocks single at entry 3
    // is G3, the singles after the unresolved entry 5 keep counting.
    expect(items.map((i) => i.id)).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
    expect(items.map((i) => i.entries[0])).toEqual([0, 2, 3, 4, 6, 7, 8]);
    expect(items.map((i) => i.kind)).toEqual(["group", "single", "single", "single", "single", "single", "single"]);
    // NOT by kind: a group that starts LATER than a single takes a later id. The order is the entry index,
    // whatever the kind — pinned with a single ahead of a group.
    const later = buildCampaignItems([
      { repo: "app", text: "single first", evidence: "c3c3c3c" },
      { repo: "app", text: "group member one", evidence: "a1a1a1a", group: "g — 2 commits" },
      { repo: "app", text: "group member two", evidence: "b2b2b2b", group: "g — 2 commits" },
      { repo: "app", text: "single last", evidence: "d4d4d4d" },
    ], MORNING_COMMITS);
    expect(later.map((i) => [i.id, i.kind, i.entries[0]])).toEqual([["G1", "single", 0], ["G2", "group", 1], ["G3", "single", 3]]);
  });

  test("[TB-V15] an unresolved bullet gets no id and is never offered — nothing stamps it", () => {
    // Entry 5 has no evidence; entry 9 cites `9999999`, a token that clears the 7-char floor and matches
    // no commit. Neither is an item, and no item's `entries` lists them.
    const offered = new Set(items.flatMap((i) => i.entries));
    expect(offered.has(5)).toBe(false);
    expect(offered.has(9)).toBe(false);
    expect([...offered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 6, 7, 8]);
    // …and an ambiguous cite is unresolved too (two commits share the 7-char prefix): still no item.
    const twins = [
      { ...MORNING_COMMITS[0]!, event_id: "abc1234dead0000000000000000000000000000000" },
      { ...MORNING_COMMITS[1]!, event_id: "abc1234feed0000000000000000000000000000000" },
    ];
    expect(buildCampaignItems([{ repo: "app", text: "ambiguous", evidence: "abc1234" }], twins)).toEqual([]);
  });

  test("[TB-V16] a group item's entries list EVERY member of its Stage-1 group, ascending, and its texts lead with the header", () => {
    const g1 = items[0]!;
    expect(g1.kind).toBe("group");
    expect(g1.entries).toEqual([0, 1]);
    expect(g1.labelKey).toBe("accountant_ai");
    expect(g1.texts).toEqual(["queue.py retry path reworked — 2 commits", "queue.py retry path reworked twice", "retry backoff added"]);
    // Members are gathered by (norm(repo), group) — the render walk's key — so a `Mono.` spelling joins
    // the `mono` group, and a member that sits AFTER an unrelated entry still lands in the same item.
    const spread = buildCampaignItems([
      { repo: "mono", text: "one", evidence: "a1a1a1a", group: "web — 3 commits" },
      { repo: "other", text: "unrelated", evidence: "d4d4d4d" },
      { repo: "Mono.", text: "two", evidence: "b2b2b2b", group: "web — 3 commits" },
      { repo: "MONO", text: "three", evidence: "c3c3c3c", group: "web — 3 commits" },
    ], MORNING_COMMITS);
    expect(spread.map((i) => [i.id, i.kind, i.entries])).toEqual([["G1", "group", [0, 2, 3]], ["G2", "single", [1]]]);
    expect(spread[0]!.labelKey).toBe("mono");
  });

  test("[TB-V17] commits are DISTINCT full ids: two bullets citing one commit contribute it once", () => {
    expect(items.map((i) => i.commits)).toEqual([[A, B], [C], [D], [E], [F], [G], [H]]);
    for (const c of items.flatMap((i) => i.commits)) expect(c).toHaveLength(40);
    const twice = buildCampaignItems([
      { repo: "app", text: "one", evidence: "a1a1a1a", group: "g — 1 commit" },
      { repo: "app", text: "one again", evidence: "a1a1a1a", group: "g — 1 commit" },
      { repo: "app", text: "two", evidence: "b2b2b2b", group: "g — 1 commit" },
    ], MORNING_COMMITS);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.commits).toEqual([A, B]);
    expect(twice[0]!.entries).toEqual([0, 1, 2]);
  });

  test("every item starts with the `no PR fact` line and the input recap is not written", () => {
    expect(items.every((i) => i.fact === NO_PR_FACT)).toBe(true);
    const before = JSON.stringify(MORNING_RECAP);
    buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
    expect(JSON.stringify(MORNING_RECAP)).toBe(before);
    expect(items.some((i) => "prByCommit" in i)).toBe(false);
  });
});

describe("topLevelRecapCount (§4.7) and the gate's load rule (§4.1)", () => {
  /** What the render walk draws at level 1 before the 🔀 foot — the count's definition, read off the page. */
  const drawnLevel1 = (b: BriefingStruct): number => {
    const lines = renderBriefing(b).split("\n");
    const start = lines.findIndex((l) => l.startsWith("▶ What you did"));
    let n = 0;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (l === "" || l.includes("🔀")) break;
      if (l.startsWith("   • ")) n++;
    }
    return n;
  };

  test("[TB-V31] on Stage-1 fixtures the count is (entries with no group) + distinct (norm(repo), group), and equals the level-1 lines rendered", () => {
    expect(topLevelRecapCount(MORNING_RECAP)).toBe(9);                          // 1 group + 6 singles + 2 unresolved
    // Every render-corpus struct: the count equals what the walk draws (the goldens' inputs, so this
    // covers the `Mono.`-joins-`mono` case, an empty recap, and a why line that must not be counted).
    for (const { struct } of RENDER_CORPUS) expect(topLevelRecapCount(struct.recap)).toBe(drawnLevel1(struct));
    // The formula, spelled out on a hand fixture: 2 ungrouped + 2 distinct groups (one spelled two ways).
    const recap: BriefingStruct["recap"] = [
      { repo: "a", text: "x" },
      { repo: "c", text: "y", group: "g1 — 2 commits" },
      { repo: "C.", text: "z", group: "g1 — 2 commits" },
      { repo: "c", text: "w", group: "g2 — 2 commits" },
      { repo: "c", text: "v", group: "g2 — 2 commits" },
      { repo: "d", text: "u" },
    ];
    expect(topLevelRecapCount(recap)).toBe(4);
    // A `campaign` stamp counts ONCE per (norm(repo), campaign) and hides the groups beneath it — NOT a
    // count of `group` alone, which apply could never move (§4.7's "Not:"). One campaign over both `c`
    // groups: 4 → 3.
    const stamped = recap.map((r, i) => (i >= 1 && i <= 4 ? { ...r, campaign: "one campaign — 4 commits" } : r));
    expect(topLevelRecapCount(stamped)).toBe(3);
    expect(topLevelRecapCount(stamped)).toBeLessThan(topLevelRecapCount(recap));
    // …and the key is PER LABEL: the same stamp over entries of two labels counts twice (2 + 2 = 4, no
    // saving) — which is why validation refuses a campaign that mixes labels (§3 requirement 4).
    const mixed = recap.map((r, i) => (i >= 1 && i <= 4 ? { ...r, repo: i <= 2 ? "b" : "c", campaign: "mixed — 4 commits" } : r));
    expect(topLevelRecapCount(mixed)).toBe(4);
  });

  test("[TB-V33] the gate's two arms, through the count: commits ≥ 40 OR top ≥ 15, never `> 8`", () => {
    expect([BUSY_COMMITS, BUSY_TOP_LINES]).toEqual([40, 15]);
    const linesOf = (n: number): BriefingStruct["recap"] => Array.from({ length: n }, (_, i) => ({ repo: "app", text: `bullet ${i}` }));
    expect(busyByLoad(39, topLevelRecapCount(linesOf(15)))).toBe(true);    // the lines arm alone
    expect(busyByLoad(40, topLevelRecapCount(linesOf(14)))).toBe(true);    // the commits arm alone
    expect(busyByLoad(39, topLevelRecapCount(linesOf(14)))).toBe(false);   // neither
    expect(busyByLoad(9, topLevelRecapCount(linesOf(9)))).toBe(false);     // `> 8` is NOT the rule (§9.1)
    // A grouped recap counts its groups once: 14 singles + one 3-member group = 15 lines → busy.
    const grouped = [...linesOf(14), ...[1, 2, 3].map((i) => ({ repo: "app", text: `m${i}`, group: "g — 3 commits" }))];
    expect(topLevelRecapCount(grouped)).toBe(15);
    expect(busyByLoad(0, topLevelRecapCount(grouped))).toBe(true);
  });
});
