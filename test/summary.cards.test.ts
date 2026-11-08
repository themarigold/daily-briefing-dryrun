import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { renderBriefing } from "../src/render";
import { RENDER_CORPUS } from "./fixtures/render-corpus";
import { summaryCardsFromPage } from "../src/summary/cards";

const title = "☀️  Daily briefing — 2026-10-16  (this machine: fixture)\n";

describe("summary card identities", () => {
  test("population, order, first spelling, independent sub-projects and reserved keys", () => {
    const page = title + [
      "▶ Where you left off", "   • [FiRsT] unfinished", "   • [resume-only] unfinished",
      "▶ What you did", "   • unlabelled", "   • [first] done", "   • [Other] real project",
      "   • [other:] reserved-looking", "   • [project:Other] also a project",
      "      ◦ [mono/api] changed API", "         ▪ [mono/web] changed web",
      "   • [merge-only] 🔀 Merged #12 (topic)  (a1b2c3d)",
      "▶ Today so far", "   • [today-only] new work",
      "▶ Suggested next", "   • [suggestion-only] next", "   • [FIRST] continue",
    ].join("\n");
    expect(summaryCardsFromPage(page)).toEqual([
      { key: "project:first", label: "FiRsT" }, { key: "project:other", label: "Other" },
      { key: "project:project:other", label: "project:Other" },
      { key: "project:mono/api", label: "mono/api" }, { key: "project:mono/web", label: "mono/web" },
      { key: "project:merge-only", label: "merge-only" }, { key: "project:today-only", label: "today-only" },
      { key: "other:", label: "Other" },
    ]);
  });

  test("no card from resume or suggestions alone", () => {
    expect(summaryCardsFromPage(title + "▶ Where you left off\n   • [resume] work\n▶ Suggested next\n   • [next] work")).toEqual([]);
  });

  test("merge-only and Today-so-far-only cards exist without recap points", () => {
    expect(summaryCardsFromPage(title + "▶ What you did\n   • [merges] 🔀 Merged #12\n▶ Today so far\n   • [today] done")).toEqual([
      { key: "project:merges", label: "merges" }, { key: "project:today", label: "today" },
    ]);
  });

  test.each([
    "", "no page", "▶ What you did\n   • [x] done", title.replace("2026-10-16", "2026-13-16"),
    title + "   • [x] no heading", title + "▶ What you did\nunknown content",
    title + '▶ What you did\n   — you wrote: "unattached"',
    title + "▶ Suggested next\n     ⚑ unattached",
    title + "▶ Suggested next\n   • next\n     ⚑ first\n     ⚑ second",
  ])("unmappable pages yield no cards: %s", (page) => {
    expect(summaryCardsFromPage(page)).toEqual([]);
  });

  test("the render corpus maps to cards: the rich page's are exact, and every page's keys are distinct and well formed", () => {
    // Read from RICH in the corpus: recap, coverage, merges and Today so far populate; resume only gives a first spelling.
    expect(summaryCardsFromPage(renderBriefing(RENDER_CORPUS.find((c) => c.name === "rich")!.struct))).toEqual([
      { key: "project:daily_briefing_application", label: "daily_briefing_application" },
      { key: "project:accountant_ai", label: "Accountant_AI." },
      { key: "project:mono", label: "mono" }, { key: "project:other", label: "other" },
      { key: "project:alpha", label: "alpha" }, { key: "project:zeta", label: "zeta" },
      { key: "project:quant_stocks", label: "quant_stocks" },
    ]);
    for (const { struct } of RENDER_CORPUS) {
      const page = renderBriefing(struct);
      const cards = summaryCardsFromPage(page);
      expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
      expect(cards.every((c) => c.key === "other:" || c.key.startsWith("project:"))).toBe(true);
    }
  });
});
