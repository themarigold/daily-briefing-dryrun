import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { renderBriefing } from "../../src/render";
import type { BriefingStruct } from "../../src/types";
import { RENDER_CORPUS } from "../../test/fixtures/render-corpus";
import { summaryCardsFromPage } from "../../src/summary/cards";
import { renderMarkdown } from "../src/lib/briefing-md";
import { mapPage } from "../src/lib/deck";

const page = (fields: Partial<BriefingStruct>): string => renderBriefing({
  date: "2026-10-16", machineScope: "fixture", provider: "fixture", resume: [], recap: [], suggestions: [], ...fields,
});
const fixtures = new URL("./__fixtures__/deck/", import.meta.url);
const pages: [string, string][] = [
  ...RENDER_CORPUS.map(({ name, struct }): [string, string] => [name, renderBriefing(struct)]),
  ...readdirSync(fixtures).filter((n) => n.endsWith(".md")).map((n): [string, string] => [n, readFileSync(new URL(n, fixtures), "utf8")]),
  ["reserved and independent keys", page({
    resume: [{ repo: "FiRsT", text: "resume" }, { repo: "resume-only", text: "resume" }],
    recap: ["", "first", "Other", "other:", "project:Other", "__proto__", "constructor", "mono/api", "mono/web"].map((repo) => ({ repo, text: "done" })),
    windowMerges: [{ repo: "merge-only", text: "🔀 Merged #12 (topic)  (a1b2c3d)" }],
    today: [{ repo: "today-only", text: "done" }], suggestions: [{ repo: "suggestion-only", text: "next" }],
  })],
  ["inline labels and first spelling", page({
    resume: [{ repo: "**Alpha**", text: "resume" }],
    recap: ["alpha", "`Beta`", "[Gamma](https://example.com)", "![image](x)", ""].map((repo) => ({ repo, text: "done" })),
  })],
  ["unknown section", page({ recap: [{ repo: "known", text: "done" }] }) + "\n▶ Future section\n   • [unknown] done"],
  ["CRLF", page({ recap: [{ repo: "crlf", text: "done" }] }).replaceAll("\n", "\r\n")],
];

test.each(pages)("summary cards agree with mapPage: %s", (_name, text) => {
  const mapped = mapPage(renderMarkdown(text), "2026-10-16");
  const expected = mapped.ok ? mapped.page.whatYouDid.cards.map(({ key, label }) => ({
    key: key === "" ? "other:" : `project:${key}`, label,
  })) : [];
  expect(summaryCardsFromPage(text)).toEqual(expected);
});
