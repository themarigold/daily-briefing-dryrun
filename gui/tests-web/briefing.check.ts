/**
 * The two briefing renderers (T12's struct renderer, T13's escape-first markdown renderer) and the
 * view that draws both.
 *
 * ⚠ THE GOLDEN IS THE ENGINE ITSELF. This file imports `renderBriefing` from `../../src/render.ts`
 * (read-only — the engine is not modified) and runs it over the same fixture the struct renderer
 * gets. No checked-in golden file exists to go stale: if `render.ts` changes its order, wording or
 * a branch, the parity tests below fail until `lib/briefing-struct.ts` follows.
 *
 * "Markdown syntax stripped" is exactly the STRUCTURAL PREFIX of each line — the indent, the bullet
 * glyph and the heading marker, which the view draws with CSS — because `renderBriefing` emits no
 * inline markdown of its own; a model-written `**x**` is field content, and the fixtures here keep
 * field content free of it (the markdown renderer's inline forms are tested separately).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "svelte/compiler";
import { render } from "svelte/server";

import {
  collapseWindowMerges as engineCollapseWindowMerges,
  renderBriefing,
  stripControl as engineStripControl,
  LEGEND_LABEL_CAP as ENGINE_CAP,
  CAMPAIGN_L3_PREFIX as ENGINE_L3,
} from "../../src/render";
import { LEGEND_PREFIX as ENGINE_LEGEND, NOT_SHOWN_PREFIX as ENGINE_NOT_SHOWN } from "../../src/subprojects";
import { WHY_PREFIX as ENGINE_WHY } from "../../src/transcripts/frame";
import { isShaShaped as engineIsShaShaped } from "../../src/sha";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import BriefingView from "../src/lib/BriefingView.svelte";
import {
  blockText,
  classifyLine,
  inlineSpans,
  isShaShaped,
  LEGEND_PREFIX,
  MAX_INLINE_CHARS,
  NESTED2,
  NOT_SHOWN_PREFIX,
  renderMarkdown,
  safeHref,
  WHY_PREFIX,
  type Block,
} from "../src/lib/briefing-md";
import {
  collapseWindowMerges,
  LEGEND_LABEL_CAP,
  renderStruct,
  stripControl,
  type BriefingStruct,
} from "../src/lib/briefing-struct";
import { groupRows, rowKey, subRowKey, type Member, type Row } from "../src/lib/briefing-rows";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(7);
const TAB = String.fromCharCode(9);
const C1 = String.fromCharCode(0x9b);
const HOSTILE = "<img src=x onerror=alert(1)>";

/**
 * The branches of `renderBriefing` (`src/render.ts`), enumerated from its conditionals, and
 * the fixture that takes each. This table is how "every branch" is checked: review round 1 found
 * two rows missing (the why before a GROUPED story line, and merges under an EMPTY recap), and both
 * now have a variant below.
 *
 * | branch                                                    | fixture                       |
 * | --------------------------------------------------------- | ----------------------------- |
 * | outage absent / N days / 1 day                            | QUIET / RICH / "one missed"   |
 * | legend absent / empty group dropped / over cap / at cap   | QUIET / RICH / RICH / "one c" |
 * | legend "is an area" / "are areas"                         | RICH (mono) / RICH            |
 * | stamp absent / floor + time / time only                   | QUIET / RICH / "one missed"   |
 * | branchState lines                                         | RICH                          |
 * | resume empty / bullets                                    | QUIET / RICH                  |
 * | why: resume home / recap home (skipped in resume) / none  | RICH / RICH / RICH (nowhere)  |
 * | why before an ungrouped recap bullet                      | RICH (accountant_ai)          |
 * | why before a GROUPED story line; not repeated after       | "why on a cluster"            |
 * | coverage absent / hidden > 0 / hidden = 0                 | QUIET / RICH / "coverage"     |
 * | head count: coverage / bullets / none; singular / plural  | RICH / "one c" / QUIET; both  |
 * | recap: ungrouped / cluster first / cluster later skipped  | RICH / RICH / RICH ("Mono.")  |
 * | evidence present / absent                                 | RICH                          |
 * | recap empty: placeholder (no coverage) / nothing (cov.)   | QUIET / "coverage"            |
 * | merges (S3b, one line per label): multi / single / dated  | RICH / RICH / RICH            |
 * |   range / unparsed passthrough / under an EMPTY recap     | "merges, quiet recap" (x2) / RICH / "merges, quiet recap" |
 * | today absent / present                                    | QUIET / RICH                  |
 * | suggestions none / repo / no repo / promoted              | QUIET / RICH / RICH / RICH    |
 * | stash label: no branch / name hidden / today / 1 day / bare | "stash suggestions" (IN-10)  |
 * | warnings absent / present                                 | QUIET / RICH                  |
 * | control bytes stripped per line                           | RICH                          |
 * | campaign (tier B, spec §4.7): header at level 1, its      | "campaign"                    |
 * |   group at level 2 with members at level 3, its single at |                               |
 * |   level 2; the why before the header                      |                               |
 *
 * ("one c" = "one commit, a why with no recap home, legend at the cap".)
 */
const RICH: BriefingStruct = {
  date: "2026-09-16",
  machineScope: "work-laptop",
  provider: "claude",
  outage: { missedDays: 2, label: "backup" },
  labelLegend: [
    {
      repo: "personal_code",
      labels: ["accountant_ai", "quant_stocks", "daily_briefing_application", "a4", "a5", "a6", "a7", "a8", "a9", "a10"],
    },
    { repo: "empty_repo", labels: [] },
    { repo: "mono", labels: ["web"] },
  ],
  whys: {
    quant_stocks: "finish the sharpe audit",
    accountant_ai: 'ship the "HITL" view',
    nowhere: "a turn with no bullet",
  },
  stateAsOf: "07:24",
  morningFloor: "07:20",
  branchState: [{ repo: "quant_stocks", text: "on feat/audit, 2 ahead of origin" }],
  resume: [
    { repo: "quant_stocks", text: "resume the deflated-sharpe audit" },
    { repo: "Accountant_AI.", text: "wire the review queue", ref: "notes.md" },
  ],
  recapCoverage: {
    shown: 4,
    total: 8,
    notShown: [
      { label: "daily_briefing_application", sha: "abc1234", subject: `fix${ESC}[31m the ${HOSTILE} render` },
    ],
  },
  recap: [
    { repo: "accountant_ai", text: "added the review queue", evidence: "d4e5f60" },
    { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 3 commits (09-14..09-15)" },
    { repo: "other", text: "an unrelated fix" },
    { repo: "Mono.", text: "fixed the footer", group: "web/app.ts — 3 commits (09-14..09-15)" },
    { repo: "mono", text: "tuned the grid", evidence: "1f2e3d4", group: "web/app.ts — 3 commits (09-14..09-15)" },
  ],
  // The engine's per-merge texts (core.ts). The renderers collapse them to ONE line per label (S3b,
  // 2026-09-24): zeta's two become `🔀 2 PRs merged (#12, #13) (Sep 14)  (…)`, alpha's one becomes
  // `🔀 1 PR merged (#9) (Sep 13)  (…)`, and the older unparsed text passes through under zeta.
  windowMerges: [
    { repo: "zeta", text: "🔀 Merged #12 (feat/x) (Sep 14)  (a1b2c3d)" },
    { repo: "alpha", text: "🔀 Merged #9 (fix/y) (Sep 13)  (e5f6a7b)" },
    { repo: "zeta", text: "🔀 Merged #13 (feat/z) (Sep 14)  (c9d8e7f)" },
    { repo: "zeta", text: "Merged #11 (feat/old) on 09-12" },
  ],
  today: [{ repo: "quant_stocks", text: "wip: audit notes" }],
  suggestions: [
    { text: "run the audit on day 52", repo: "quant_stocks", promoted: true },
    { text: "[accountant_ai] review queue polish" },
    { text: `tab${TAB}and bell${BEL} and C1${C1} stripped` },
  ],
  warnings: ["provider output truncated", "2 repos unreadable"],
};

const QUIET: BriefingStruct = {
  date: "2026-09-15",
  machineScope: "mac",
  provider: "anthropic-api",
  resume: [],
  recap: [],
  suggestions: [],
};

const VARIANTS: [string, BriefingStruct][] = [
  ["rich", RICH],
  ["quiet day", QUIET],
  ["one missed day, no floor", { ...QUIET, outage: { missedDays: 1, label: "primary" }, stateAsOf: "09:01" }],
  [
    "coverage over an empty recap",
    {
      ...QUIET,
      recapCoverage: { shown: 0, total: 1, notShown: [{ label: "x", sha: "deadbee", subject: "lost" }] },
    },
  ],
  [
    "one commit, a why with no recap home, legend at the cap",
    {
      ...QUIET,
      whys: { solo: "why solo" },
      resume: [{ repo: "solo", text: "keep going" }],
      recap: [{ repo: "other", text: "one thing" }],
      labelLegend: [{ repo: "big", labels: ["1", "2", "3", "4", "5", "6", "7", "8"] }],
      suggestions: [{ text: "promoted, no repo", promoted: true }],
      warnings: ["only one"],
    },
  ],
  [
    // Review round 1, S4: the why for a label whose first recap entry is a CLUSTER goes before the
    // story line, and is not repeated before that label's later, ungrouped bullet.
    "why on a cluster",
    {
      ...QUIET,
      whys: { mono: "tidy the web app" },
      recap: [
        { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 2 commits" },
        { repo: "mono", text: "tuned the grid", group: "web/app.ts — 2 commits" },
        { repo: "mono", text: "an ungrouped fix" },
      ],
    },
  ],
  [
    // Review round 1, S5: merges render under an EMPTY recap too — after the placeholder.
    "merges, quiet recap",
    {
      ...QUIET,
      windowMerges: [
        { repo: "b", text: "🔀 Merged #2 (fix/b) (Sep 14)  (bbbb222)" },
        { repo: "a", text: "🔀 Merged #1 (fix/a) (Sep 13)  (aaaa111)" },
        { repo: "a", text: "🔀 Merged #3 (fix/c) (Sep 15)  (cccc333)" },
      ],
    },
  ],
  [
    // Review round 1, T5: model text that LOOKS like an image, with an http(s) target. The file
    // renderer must keep it literal, exactly as the struct renderer does.
    "image-shaped text",
    { ...QUIET, suggestions: [{ text: "see ![diagram](https://example.com/d.png) first" }] },
  ],
  [
    // IN-10: every branch of `stashLabel` — the engine ships at most one stash line a morning, but the
    // renderer must mirror each label shape, and a model suggestion beside it stays unlabelled. A branch
    // NAME never renders (review round 1: it moved three counted audit checks) — only `no branch` does.
    "stash suggestions",
    {
      ...QUIET,
      suggestions: [
        { text: "[accountant_ai] model-written, no label" },
        { text: "Pop or drop stash@{0}", repo: "personal_code", stash: { branch: "(no branch)", ageDays: 14 } },
        { text: "Pop or drop stash@{1}", repo: "personal_code", stash: { branch: "feat/x", ageDays: 1 } },
        { text: "Pop or drop stash@{2}", repo: "mono", stash: { branch: "main", ageDays: 0 } },
        { text: "Pop or drop stash@{3}", repo: "mono", stash: {} },
        { text: "Pop or drop stash@{4}", repo: "mono", stash: { branch: "fix/accountant_ai-sync,aaaa111,bbbb222", ageDays: 2 } },
      ],
    },
  ],
  [
    // Tier B (spec §4.7 "Render", §5.4): ONE campaign holding a Stage-1 group (levels 2–3) AND a single
    // bullet (level 2), a non-member between the campaign's first member and its single (which moves up
    // under the header), an ungrouped bullet after it, and the label's why before the header.
    "campaign",
    {
      ...QUIET,
      whys: { mono: "tidy the web app" },
      recap: [
        { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 2 commits", campaign: "tidy the web app — 3 commits" },
        { repo: "mono", text: "tuned the grid", evidence: "1f2e3d4", group: "web/app.ts — 2 commits", campaign: "tidy the web app — 3 commits" },
        { repo: "other", text: "an unrelated fix", evidence: "9f8e7d6" },
        { repo: "mono", text: "fixed the footer", evidence: "4d5e6f7", campaign: "tidy the web app — 3 commits" },
        { repo: "mono", text: "an ungrouped fix after the campaign" },
      ],
    },
  ],
];

// The two struct types agree on every variant (a compile-time check under `tsc`, a no-op here).
const _typecheck: EngineStruct[] = VARIANTS.map(([, v]) => v as EngineStruct);
void _typecheck;

/** A `renderBriefing` line with its structural prefix removed — the golden's "markdown syntax". */
function visible(line: string): string {
  // The nine-space `▪` prefix (tier B's third level) goes AHEAD of the bare three-space indent, which
  // would otherwise swallow only part of it.
  for (const prefix of ["         ▪ ", "      ◦ ", "     · ", "   • ", "▶ ", "   "]) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return line;
}

function golden(struct: BriefingStruct): string[] {
  return renderBriefing(struct as EngineStruct)
    .split("\n")
    .filter((l) => l !== "")
    .map(visible);
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function viewHtml(blocks: Block[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(BriefingView as any, { props: { blocks } }).body.replace(/<!--[\s\S]*?-->/g, "");
}

/** The lines the view drew, in document order, as their DRAWN text: every line element's text,
 *  including each member inside a closed `<details>` — in the DOM, though not shown until the
 *  group is opened (2026-09-24). `summary` is the header of such a collapsed recap group: the view
 *  puts it ON the summary element, so the golden below still sees every engine line — a header
 *  that fell out of this regex would fail it, not pass it. */
function drawnLines(html: string): { kind: string; text: string }[] {
  return [...html.matchAll(/<(h3|h4|p|summary)\b([^>]*\bdata-block\b[^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => {
    const cls = /class="([^"]*)"/.exec(m[2] ?? "")?.[1] ?? "";
    const kind = cls.split(/\s+/).find((c) => c !== "b" && !c.startsWith("svelte-")) ?? "";
    return { kind, text: decode((m[3] ?? "").replace(/<[^>]*>/g, "")) };
  });
}

/** Every tag and attribute name in the markup. */
function tagsAndAttributes(html: string): { tags: Set<string>; attributes: Set<string> } {
  const tags = new Set<string>();
  const attributes = new Set<string>();
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    tags.add((m[1] ?? "").toLowerCase());
    for (const a of (m[2] ?? "").matchAll(/([^\s=/"']+)(?:="[^"]*")?/g)) attributes.add((a[1] ?? "").toLowerCase());
  }
  return { tags, attributes };
}

// `details` and `summary` (2026-09-24) are the collapsed recap group. Neither navigates, embeds,
// fetches nor executes anything — a disclosure widget is document structure, like `p` — and `open`
// is deliberately NOT an allowed attribute: a group is closed by default, in the markup as rendered.
const ALLOWED_TAGS = new Set(["article", "h3", "h4", "p", "strong", "code", "span", "details", "summary"]);
const ALLOWED_ATTRIBUTES = new Set(["class", "data-block"]);

/* ── the engine's constants, pinned ───────────────────────────────────────────────────────────── */

describe("the engine's line vocabulary", () => {
  test("prefixes, the legend cap and the sanitiser are the engine's", () => {
    expect(LEGEND_PREFIX).toBe(ENGINE_LEGEND);
    expect(NOT_SHOWN_PREFIX).toBe(ENGINE_NOT_SHOWN);
    expect(WHY_PREFIX).toBe(ENGINE_WHY);
    expect(LEGEND_LABEL_CAP).toBe(ENGINE_CAP);
    let all = "";
    for (let c = 0; c < 0x300; c++) all += String.fromCharCode(c);
    all += `é sun ${String.fromCodePoint(0x2600, 0xfe0f, 0x202e, 0x1f600)}`;
    expect(stripControl(all)).toBe(engineStripControl(all));
    expect(stripControl(all).length).toBeLessThan(all.length);
  });

  test("the SHA predicate is the engine's", () => {
    for (const tok of ["abc1234", "deadbeef", "defaced", "2026091", "added", "cafe", "0a1b2c3d4e5f", "ABCDEF1", "fffffff", "12345678"]) {
      expect(isShaShaped(tok)).toBe(engineIsShaShaped(tok));
    }
  });

  // S3b (2026-09-24): the foot collapse is a MIRROR of `src/render.ts`'s, because the GUI cannot
  // import the engine (docs/gui-seam.md §1). Every branch of the engine's function is driven through
  // both copies on the same input: multi/single label, plural/singular, in-label order, chronological
  // date range (both directions of the run-date year anchor), undated merges, a paren in a ref name,
  // an empty branch group, a branch with a space (unparseable), labels that differ only by `norm`, an
  // unparsed text passing through, and the empty block. The SECOND argument — the briefing's own date
  // — is driven too: it is what supplies the year the `Mon D` tags lack, so a mirror that ignored it
  // would pass a one-argument parity check and still disagree on every year-crossing window.
  test("the window-merge collapse is the engine's, branch for branch", () => {
    const cases: [{ repo: string; text: string }[], string][] = [
      [[], "2026-09-23"],
      [[{ repo: "a", text: "🔀 Merged #533 (fix/x) (Sep 22)  (e7b732b)" }], "2026-09-23"],
      [[
        { repo: "zeta", text: "🔀 Merged #2 (b) (Aug 19)  (bbbb222)" },
        { repo: "alpha", text: "🔀 Merged #1 (a) (Aug 18)  (aaaa111)" },
        { repo: "zeta", text: "🔀 Merged #3 (c) (Aug 20)  (cccc333)" },
      ], "2026-09-23"],
      [[
        { repo: "a", text: "🔀 Merged #2 (b) (Sep 22)  (bbbb222)" },
        { repo: "a", text: "🔀 Merged #1 (a) (Sep 21)  (aaaa111)" },
        { repo: "a", text: "🔀 Merged #3 (c) (Sep 22)  (cccc333)" },
      ], "2026-09-23"],
      // Year anchor, both directions: a Dec→Jan window wraps; a wider-than-half-a-year one does not.
      [[{ repo: "a", text: "🔀 Merged #1 (a) (Jan 2)  (aaaa111)" }, { repo: "a", text: "🔀 Merged #2 (b) (Dec 30)  (bbbb222)" }], "2027-01-05"],
      [[{ repo: "a", text: "🔀 Merged #1 (a) (Nov 20)  (aaaa111)" }, { repo: "a", text: "🔀 Merged #2 (b) (Jan 5)  (bbbb222)" }], "2027-01-06"],
      [[{ repo: "a", text: "🔀 Merged #1 (x) (Mar 1)  (aaaa111)" }, { repo: "a", text: "🔀 Merged #2 (y) (Oct 15)  (bbbb222)" }], "2026-10-20"],
      [[{ repo: "a", text: "🔀 Merged #1 (a)  (aaaa111)" }, { repo: "a", text: "🔀 Merged #2 (b) (Sep 22)  (bbbb222)" }], "2026-09-23"],
      [[{ repo: "a", text: "🔀 Merged #1 (a)  (aaaa111)" }], "2026-09-23"],
      [[{ repo: "a", text: "🔀 Merged #5 (fix/(paren)) (Sep 22)  (abc1234)" }], "2026-09-23"],
      [[{ repo: "a", text: "🔀 Merged #3 () (Sep 22)  (ccc1234)" }], "2026-09-23"],
      [[{ repo: "a", text: "🔀 Merged #4 (a) b (Sep 22)  (ddd1234)" }], "2026-09-23"],
      [[
        { repo: "Mono", text: "🔀 Merged #1 (x) (Sep 22)  (aaaa111)" },
        { repo: "mono", text: "🔀 Merged #2 (y) (Sep 22)  (bbbb222)" },
        { repo: "mono.", text: "🔀 Merged #3 (z) (Sep 22)  (cccc333)" },
      ], "2026-09-23"],
      [[
        { repo: "z", text: "Merged #1 (feat/x)" },
        { repo: "z", text: "🔀 Merged #9 (b) (Aug 1)  (1111aaa)" },
        { repo: "a", text: "some older shape" },
      ], "2026-09-23"],
      [RICH.windowMerges ?? [], RICH.date],
    ];
    for (const [input, run] of cases) {
      expect(collapseWindowMerges(input, run)).toEqual(engineCollapseWindowMerges(input, run));
    }
    // Not vacuous: the multi-label case really collapses, the singular case really is singular, the
    // anchor really moves a Dec→Jan window, and the `norm` key really merges three spellings.
    expect(collapseWindowMerges(cases[2]![0], cases[2]![1]).map((m) => m.text)).toEqual([
      "🔀 1 PR merged (#1) (Aug 18)  (aaaa111)",
      "🔀 2 PRs merged (#2, #3) (Aug 19–Aug 20)  (bbbb222, cccc333)",
    ]);
    expect(collapseWindowMerges(cases[4]![0], cases[4]![1])[0]!.text)
      .toBe("🔀 2 PRs merged (#1, #2) (Dec 30–Jan 2)  (aaaa111, bbbb222)");
    expect(collapseWindowMerges(cases[6]![0], cases[6]![1])[0]!.text)
      .toBe("🔀 2 PRs merged (#1, #2) (Mar 1–Oct 15)  (aaaa111, bbbb222)");
    expect(collapseWindowMerges(cases[12]![0], cases[12]![1])).toEqual([
      { repo: "Mono", text: "🔀 3 PRs merged (#1, #2, #3) (Sep 22)  (aaaa111, bbbb222, cccc333)" },
    ]);
    // …and an empty branch group keeps its date (a subject ending `from owner/` is reachable), while
    // a branch with a space in it — which git cannot produce — passes through instead of parsing
    // into a line with the date silently gone. Parity alone cannot see either: a mutation applied to
    // BOTH copies keeps them agreeing, so the mirror needs its own expected strings.
    expect(collapseWindowMerges(cases[10]![0], cases[10]![1])[0]!.text)
      .toBe("🔀 1 PR merged (#3) (Sep 22)  (ccc1234)");
    expect(collapseWindowMerges(cases[11]![0], cases[11]![1]))
      .toEqual([{ repo: "a", text: "🔀 Merged #4 (a) b (Sep 22)  (ddd1234)" }]);
  });

  // ⚠ `renderStruct` hands `collapseWindowMerges` the caller's own `b.windowMerges`, exactly as the
  // engine's `renderBriefing` does — so the engine's in-place-sort hazard is mirrored here too, and
  // the parity check above cannot see it (both copies would sort in place and still agree). The
  // engine's own pin is in test/merge-foot-collapse.test.ts; this is its GUI half.
  // ⚠ ITS INPUT IS A LOCAL LITERAL, NOT `RICH`, and that is the assertion working. With the in-place
  // sort in place the parity test earlier in this file — which passes `RICH.windowMerges` straight in
  // — SORTS THE SHARED FIXTURE, so a later test reading `RICH` sees an already-sorted array and the
  // mutation looks harmless. Measured while writing this: the first draft used `RICH` and stayed green
  // under exactly the mutation it exists to kill.
  test("rendering the struct does not touch it: windowMerges is deep-identical across a render", () => {
    const b: BriefingStruct = {
      ...RICH,
      windowMerges: [
        { repo: "zeta", text: "🔀 Merged #12 (feat/x) (Sep 14)  (a1b2c3d)" },
        { repo: "alpha", text: "🔀 Merged #9 (fix/y) (Sep 13)  (e5f6a7b)" },
        { repo: "zeta", text: "🔀 Merged #13 (feat/z) (Sep 14)  (c9d8e7f)" },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(b.windowMerges));
    renderStruct(b);
    renderStruct(b);
    expect(b.windowMerges).toEqual(snapshot);
  });
});

/* ── T12: golden order parity ─────────────────────────────────────────────────────────────────── */

describe("the struct renderer mirrors renderBriefing", () => {
  for (const [name, struct] of VARIANTS) {
    test(`drawn text, in document order, closed groups' members included: ${name}`, () => {
      const expected = golden(struct);
      const blocks = renderStruct(struct);
      expect(blocks.map(blockText)).toEqual(expected);
      // …and what the VIEW draws, read back out of its markup.
      expect(drawnLines(viewHtml(blocks)).map((l) => l.text)).toEqual(expected);
    });

    test(`the escape-first renderer reads the engine's file back to the same lines and kinds: ${name}`, () => {
      const markdown = renderBriefing(struct as EngineStruct);
      const fromFile = renderMarkdown(markdown);
      const fromStruct = renderStruct(struct);
      expect(fromFile.map(blockText)).toEqual(golden(struct));
      expect(fromFile.map((b) => b.kind)).toEqual(fromStruct.map((b) => b.kind));
    });
  }

  test("the rich fixture exercises every line kind", () => {
    const kinds = new Set(renderStruct(RICH).map((b) => b.kind));
    for (const k of ["title", "outage", "legend", "heading", "bullet", "nested", "notShown", "coverage", "why", "warnings", "footer"]) {
      expect(kinds.has(k as Block["kind"])).toBe(true);
    }
    expect(new Set(renderStruct(QUIET).map((b) => b.kind)).has("placeholder")).toBe(true);
  });

  test("the review-round-1 variants produce the lines they exist for", () => {
    const lines = (name: string) => golden(VARIANTS.find(([n]) => n === name)?.[1] ?? QUIET);
    const cluster = lines("why on a cluster");
    const why = '— you wrote: "tidy the web app"';
    expect(cluster.filter((l) => l === why)).toHaveLength(1);
    expect(cluster[cluster.indexOf(why) + 1]).toBe("[mono] web/app.ts — 2 commits");
    const merges = lines("merges, quiet recap");
    const at = merges.indexOf("(no commits in the window)");
    expect(merges.slice(at, at + 3)).toEqual([
      "(no commits in the window)",
      "[a] 🔀 2 PRs merged (#1, #3) (Sep 13–Sep 15)  (aaaa111, cccc333)",
      "[b] 🔀 1 PR merged (#2) (Sep 14)  (bbbb222)",
    ]);
    const rich = golden(RICH);
    expect(rich.slice(rich.indexOf("[alpha] 🔀 1 PR merged (#9) (Sep 13)  (e5f6a7b)"), rich.indexOf("Today so far"))).toEqual([
      "[alpha] 🔀 1 PR merged (#9) (Sep 13)  (e5f6a7b)",
      "[zeta] 🔀 2 PRs merged (#12, #13) (Sep 14)  (a1b2c3d, c9d8e7f)",
      "[zeta] Merged #11 (feat/old) on 09-12",
    ]);
    expect(lines("image-shaped text")).toContain("see ![diagram](https://example.com/d.png) first");
    const stash = lines("stash suggestions");
    expect(stash.slice(stash.indexOf("Suggested next") + 1, stash.indexOf("Suggested next") + 7)).toEqual([
      "[accountant_ai] model-written, no label",
      "[personal_code] Pop or drop stash@{0}  (from stash · no branch · 14 days old)",
      "[personal_code] Pop or drop stash@{1}  (from stash · 1 day old)",
      "[mono] Pop or drop stash@{2}  (from stash · made today)",
      "[mono] Pop or drop stash@{3}  (from stash)",
      "[mono] Pop or drop stash@{4}  (from stash · 2 days old)",
    ]);
  });

  test("prove-it 3b: a reordered or dropped line fails the parity", () => {
    const blocks = renderStruct(RICH).map(blockText);
    const swapped = [...blocks];
    [swapped[2], swapped[3]] = [swapped[3] ?? "", swapped[2] ?? ""];
    expect(swapped).not.toEqual(golden(RICH));
    expect(blocks.slice(1)).not.toEqual(golden(RICH));
  });

  test("a hostile commit subject is literal text in the struct view", () => {
    const html = viewHtml(renderStruct(RICH));
    const { tags, attributes } = tagsAndAttributes(html);
    expect([...tags].filter((t) => !ALLOWED_TAGS.has(t))).toEqual([]);
    expect([...attributes].filter((a) => !ALLOWED_ATTRIBUTES.has(a))).toEqual([]);
    expect(html).not.toContain("<img");
    const lines = drawnLines(html).map((l) => l.text);
    // The exact string survives, as text, with the ESC byte stripped the way the engine strips it.
    expect(lines).toContain(`[daily_briefing_application] abc1234 fix[31m the ${HOSTILE} render`);
  });
});

/* ── T13: the escape-first renderer ───────────────────────────────────────────────────────────── */

describe("the escape-first renderer", () => {
  const archived = [
    "☀️  Daily briefing — 2026-09-10  (this machine: mac)",
    "",
    "▶ Where you left off",
    "   • [app] raw html <script>alert(1)</script> and <img src=x onerror=alert(1)>",
    '   • [app] a [js link](javascript:alert(1)) and [JS](JaVaScRiPt:alert(2)) and [data](data:text/html;base64,PHNjcmlwdD4=)',
    '   • [app] an image ![pwn](https://evil.example/x.png" onerror="alert(1)) and ![p](data:image/png;base64,AAAA)',
    "   • [app] a well-formed image ![alt](https://example.com/i.png) stays text",
    "   • [app] a [real link](https://example.com/a?b=1&c=2) and a bare https://example.com/bare",
    "   • [app] **bold** and `code` and sha 3f9a2c1 and year 2026091",
    '   • [app] <a href="javascript:alert(3)">anchor</a> [rel](/etc/passwd) [ftp](ftp://x/y)',
    "",
    // A recap group (2026-09-24) — hostile text in its header AND its members, so the tag and
    // attribute allow-list below runs over a `<details>` whose every line is attacker-shaped.
    "▶ What you did — 2 commits",
    "   • [app] <img src=x onerror=alert(1)> <details open> web/app.ts — 2 commits",
    "      ◦ [app] </summary><p data-block>forged</p> and [x](javascript:alert(4))  (0a1b2c3)",
    "      ◦ [app] </details><script>alert(5)</script> and a [real](https://example.com/m) link",
    "",
    "— generated locally via claude",
  ].join("\n");

  test("raw HTML, javascript:/data: links and images all render inert", () => {
    const html = viewHtml(renderMarkdown(archived));
    const { tags, attributes } = tagsAndAttributes(html);
    expect([...tags].filter((t) => !ALLOWED_TAGS.has(t))).toEqual([]);
    expect([...attributes].filter((a) => !ALLOWED_ATTRIBUTES.has(a))).toEqual([]);
    // No raw `<` survives into text (Svelte escapes it), so none of these can be a tag. The
    // attribute-shaped text inside the escaped HTML (`href="javascript:…"`) is TEXT — the tag and
    // attribute parse above is what proves no element carries one.
    for (const bad of ["<script", "<img", "<a ", "<a>", "<iframe", "<svg", "<details open", "<p data-block>forged"]) {
      expect(html).not.toContain(bad);
    }
    expect(html).toContain("&lt;script>");
    // The hostile group IS a group — one closed details, its header on the summary and both
    // members in its body, all as inert text — so the allow-list above really ran over one.
    expect(groups(html)).toHaveLength(1);
    const [group] = groups(html);
    expect(group?.attrs).not.toMatch(/\bopen\b/);
    expect(group?.summary).toEqual({ kind: "bullet", text: "[app] <img src=x onerror=alert(1)> <details open> web/app.ts — 2 commits" });
    expect(group?.body).toEqual([
      { kind: "nested", text: "[app] </summary><p data-block>forged</p> and [x](javascript:alert(4))  (0a1b2c3)" },
      { kind: "nested", text: "[app] </details><script>alert(5)</script> and a real (https://example.com/m) link" },
    ]);
    // A well-formed image with an http(s) target is not turned into a link either.
    const image = renderMarkdown(archived).find((b) => blockText(b).includes("well-formed image"));
    expect(image?.spans.map((sp) => sp.kind)).toEqual(["text"]);
    const text = drawnLines(html).map((l) => l.text).join("\n");
    for (const literal of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[js link](javascript:alert(1))",
      "[JS](JaVaScRiPt:alert(2))",
      "[data](data:text/html;base64,PHNjcmlwdD4=)",
      '![pwn](https://evil.example/x.png" onerror="alert(1))',
      "![p](data:image/png;base64,AAAA)",
      "![alt](https://example.com/i.png)",
      '<a href="javascript:alert(3)">anchor</a>',
      "[rel](/etc/passwd)",
      "[ftp](ftp://x/y)",
      "https://example.com/bare",
    ]) {
      expect(text).toContain(literal);
    }
  });

  test("the inline allowlist: bold, code, http(s) links, SHA styling — and nothing else", () => {
    const spans = inlineSpans("**bold** and `code` and [real link](https://example.com/a?b=1&c=2) sha 3f9a2c1 year 2026091");
    expect(spans.map((s) => s.kind)).toEqual(["strong", "text", "code", "text", "link", "text", "sha", "text"]);
    expect(spans.find((s) => s.kind === "link")).toEqual({
      kind: "link",
      text: "real link",
      href: "https://example.com/a?b=1&c=2",
    });
    // A link span is drawn as text with its target, never as an anchor.
    const html = viewHtml([{ kind: "bullet", spans }]);
    expect(html).not.toContain("href");
    expect(drawnLines(html)[0]?.text).toBe(
      "bold and code and real link (https://example.com/a?b=1&c=2) sha 3f9a2c1 year 2026091",
    );
    // A bare URL is never linkified; a SHA is never a link.
    expect(inlineSpans("see https://example.com now").map((s) => s.kind)).toEqual(["text"]);
    expect(inlineSpans("3f9a2c1").map((s) => s.kind)).toEqual(["sha"]);
  });

  test("only absolute http and https URLs are links", () => {
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("HTTP://Example.com")).toBe("http://example.com/");
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      " javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "/relative",
      "//example.com/x",
      "https://exa mple.com",
      "https://example.com/\tx",
      "vbscript:x",
      "https:",
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
  });

  test("unknown and older line shapes degrade to text; CRLF is tolerated", () => {
    const blocks = renderMarkdown("☀️  Morning briefing — 2026-07-01\r\nsomething the engine never wrote\r\n");
    expect(blocks.map((b) => b.kind)).toEqual(["title", "text"]);
    expect(blocks.map(blockText)).toEqual(["☀️  Morning briefing — 2026-07-01", "something the engine never wrote"]);
  });

  test("a 1 MiB single line is shown as plain text, fast", () => {
    const line = "[x](".repeat(262_144);
    const started = performance.now();
    const blocks = renderMarkdown(line);
    const elapsed = performance.now() - started;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.spans).toEqual([{ kind: "text", text: line }]);
    expect(line.length).toBeGreaterThan(MAX_INLINE_CHARS);
    expect(elapsed).toBeLessThan(500);
    // …and a pathological line just under the cap is still bounded.
    const near = "[a](".repeat(Math.floor(MAX_INLINE_CHARS / 4));
    const t0 = performance.now();
    expect(blockText({ kind: "text", spans: inlineSpans(near) })).toBe(near);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

/* ── the recap collapse (2026-09-24): a Stage-1 group is one closed <details> ─────────────────── */

/** A group as the block MODEL holds it — a `bullet` and the run of `nested`/`nested2` right after it
 *  — computed here, independently of the view's own pass, as its lines' `blockText`: `members` is every
 *  member line, flat and in order, and — ONLY when the run holds a Stage-1 sub-group (tier B: a `nested`
 *  header followed by `nested2` lines) — `subs` lists each sub-group's header and its level-3 members. A
 *  two-level page gets no `subs` key, so its shape is exactly the pre-tierb one. */
type ModelGroup = { header: string; members: string[]; subs?: { header: string; members: string[] }[] };
const isMemberKind = (k: Block["kind"] | undefined) => k === "nested" || k === "nested2";
function modelGroups(blocks: Block[]): ModelGroup[] {
  const out: ModelGroup[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]?.kind !== "bullet" || !isMemberKind(blocks[i + 1]?.kind)) continue;
    const members: string[] = [];
    const subs: { header: string; members: string[] }[] = [];
    for (let j = i + 1; isMemberKind(blocks[j]?.kind); j++) {
      members.push(blockText(blocks[j]!));
      if (blocks[j]!.kind === "nested" && blocks[j + 1]?.kind === "nested2") {
        const sub: string[] = [];
        let k = j + 1;
        for (; blocks[k]?.kind === "nested2"; k++) { sub.push(blockText(blocks[k]!)); members.push(blockText(blocks[k]!)); }
        subs.push({ header: blockText(blocks[j]!), members: sub });
        j = k - 1;
      }
    }
    out.push(subs.length ? { header: blockText(blocks[i]!), members, subs } : { header: blockText(blocks[i]!), members });
  }
  return out;
}

type Drawn = { kind: string; text: string };
type Group = { attrs: string; summary: Drawn | null; body: Drawn[]; subs?: Group[] };
/** The TOP-LEVEL `<details>…</details>` spans of `html`, by depth counting — a `<details>` may hold
 *  another (tier B's sub-groups), which a non-greedy regex would cut at the inner close tag. */
function detailsSpans(html: string): { attrs: string; start: number; open: number; close: number; end: number }[] {
  const out: { attrs: string; start: number; open: number; close: number; end: number }[] = [];
  let depth = 0;
  let cur: { attrs: string; start: number; open: number } | null = null;
  for (const m of html.matchAll(/<(\/?)details\b([^>]*)>/g)) {
    const at = m.index ?? 0;
    if (m[1] === "") {
      if (depth === 0) cur = { attrs: m[2] ?? "", start: at, open: at + m[0].length };
      depth++;
    } else {
      depth--;
      if (depth === 0 && cur) { out.push({ ...cur, close: at, end: at + m[0].length }); cur = null; }
    }
  }
  return out;
}
/** Each top-level `<details>` the view drew, in order: the tag's attributes, its summary as a drawn
 *  line (null unless the SUMMARY ELEMENT ITSELF carries `data-block` — a line nested inside it does not
 *  count), the lines in its body — every line, flat, in order, those inside a nested `<details>`
 *  included — and, ONLY when the body holds nested `<details>` (tier B's sub-groups), `subs`: the same
 *  reading of each of them. A two-level page gets no `subs` key, so its shape is the pre-tierb one. */
function groups(html: string): Group[] {
  return detailsSpans(html).map((d) => {
    const inner = html.slice(d.open, d.close);
    const s = /^<summary\b[^>]*>[\s\S]*?<\/summary>/.exec(inner);
    const rest = inner.slice(s?.[0].length ?? 0);
    const g: Group = { attrs: d.attrs, summary: s ? (drawnLines(s[0])[0] ?? null) : null, body: drawnLines(rest) };
    return rest.includes("<details") ? { ...g, subs: groups(rest) } : g;
  });
}
/** Every group and sub-group, flattened, for checks that must see each `<details>`. */
const allGroups = (gs: Group[]): Group[] => gs.flatMap((g) => [g, ...allGroups(g.subs ?? [])]);
const shape = (html: string): ModelGroup[] => groups(html).map((g) => {
    const base = { header: g.summary?.text ?? "", members: g.body.map((l) => l.text) };
    return g.subs ? { ...base, subs: g.subs.map((s) => ({ header: s.summary?.text ?? "", members: s.body.map((l) => l.text) })) } : base;
  });
/** What a reader SEES with every `<details>` in the state its markup declares: the lines outside any
 *  closed body, plus each closed group's summary; an `open` group also shows its body, read the same
 *  way one level down (tier B: a closed sub-group inside it still hides its level-3 lines). */
function visibleHtml(html: string): string {
  let out = "";
  let pos = 0;
  for (const d of detailsSpans(html)) {
    out += html.slice(pos, d.start);                                       // everything before the tag
    const inner = html.slice(d.open, d.close);
    const s = /^<summary\b[^>]*>[\s\S]*?<\/summary>/.exec(inner);
    const summary = s?.[0] ?? "";
    out += html.slice(d.start, d.open) + summary + (/\bopen\b/.test(d.attrs) ? visibleHtml(inner.slice(summary.length)) : "");
    out += html.slice(d.close, d.end);
    pos = d.end;
  }
  return out + html.slice(pos);
}
const visibleLines = (html: string): Drawn[] => drawnLines(visibleHtml(html));
/** A named fixture. An unknown name THROWS: falling back to a default would let a renamed variant
 *  turn the assertions that read it into assertions about a different page. */
function variant(name: string): BriefingStruct {
  const found = VARIANTS.find(([n]) => n === name);
  if (found === undefined) throw new Error(`no variant named ${JSON.stringify(name)}`);
  return found[1];
}

// Two clusters back to back, a why before the first, coverage lines above, an ungrouped bullet and
// the 🔀 foot below — every neighbour a group can have, in one page.
const TWO_GROUPS: BriefingStruct = {
  ...QUIET,
  whys: { mono: "tidy the web app" },
  recapCoverage: { shown: 5, total: 6, notShown: [{ label: "x", sha: "deadbee", subject: "lost" }] },
  recap: [
    { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 2 commits" },
    { repo: "mono", text: "tuned the grid", group: "web/app.ts — 2 commits" },
    { repo: "mono", text: "renamed the store", evidence: "4d5e6f7", group: "web/store.ts — 2 commits" },
    { repo: "mono", text: "typed the store", group: "web/store.ts — 2 commits" },
    { repo: "other", text: "an ungrouped fix" },
  ],
  windowMerges: [{ repo: "a", text: "🔀 Merged #1 (fix/a) (Sep 13)  (aaaa111)" }],
};

describe("the recap collapse: a Stage-1 group is one closed <details>", () => {
  test("a group is one closed details: the header on its summary, every member — in order — as its body", () => {
    for (const struct of [RICH, TWO_GROUPS]) {
      const blocks = renderStruct(struct);
      const html = viewHtml(blocks);
      const model = modelGroups(blocks);
      expect(model.length).toBeGreaterThan(0); // not vacuous
      expect(shape(html)).toEqual(model);
      groups(html).forEach((g, k) => {
        expect(g.attrs).not.toMatch(/\bopen\b/); // closed by default, in the markup as rendered
        expect(g.summary?.kind).toBe("bullet"); // the header is ON the summary, at the • level
        // Every member is a `nested` line — the count from the MODEL, not from the body itself, so
        // an empty or short body cannot pass by agreeing with itself.
        const members = model[k]?.members ?? [];
        expect(members.length).toBeGreaterThan(0);
        expect(g.body.map((l) => l.kind)).toEqual(members.map(() => "nested"));
      });
      // No line element inside the summary: summary takes phrasing content, and the golden's
      // regex would otherwise count the header twice or not at all.
      expect(html).not.toMatch(/<summary\b[^>]*>\s*<(p|h3|h4)\b/);
      // Every block is in the DOM with its own kind, in order — collapsed or not.
      expect(drawnLines(html)).toEqual(blocks.map((b) => ({ kind: b.kind, text: blockText(b) })));
    }
  });

  test("an ungrouped bullet has no details, and a nested line with no bullet before it stays the plain line it was", () => {
    // Exactly as many <details> as the model has groups — none on a page without one.
    for (const [, struct] of VARIANTS) {
      const blocks = renderStruct(struct);
      const html = viewHtml(blocks);
      expect((html.match(/<details\b/g) ?? []).length).toBe(modelGroups(blocks).reduce((n, g) => n + 1 + (g.subs?.length ?? 0), 0));
    }
    expect(modelGroups(renderStruct(variant("one commit, a why with no recap home, legend at the cap")))).toHaveLength(0);
    expect(viewHtml(renderStruct(QUIET))).not.toContain("<details");
    // RICH's ungrouped bullets are drawn outside any details, as `<p class="b bullet">`.
    const blocks = renderStruct(RICH);
    const outside = viewHtml(blocks).replace(/<details\b[\s\S]*?<\/details>/g, "");
    const headers = new Set(modelGroups(blocks).map((g) => g.header));
    expect(drawnLines(outside).filter((l) => l.kind === "bullet").map((l) => l.text)).toEqual(
      blocks.filter((b) => b.kind === "bullet" && !headers.has(blockText(b))).map(blockText),
    );
    expect(outside).toMatch(/<p class="b bullet[^"]*" data-block[^>]*>\[other\] an unrelated fix<\/p>/);
    // A stray ◦ line — which only a HAND-EDITED page can hold: the engine has emitted the story
    // line right before its members since `◦` lines first existed (#363) — is not a group and not
    // a header.
    const stray = viewHtml(
      renderMarkdown(["▶ What you did", "      ◦ [x] orphan one", "      ◦ [x] orphan two", "   • [x] flat"].join("\n")),
    );
    expect(stray).not.toContain("<details");
    expect(drawnLines(stray).map((l) => l.kind)).toEqual(["heading", "nested", "nested", "bullet"]);
  });

  test("a why before a group stays outside it, and the ungrouped bullet after it is outside too", () => {
    const html = viewHtml(renderStruct(variant("why on a cluster")));
    const [g] = groups(html);
    expect(groups(html)).toHaveLength(1);
    expect(g?.summary?.text).toBe("[mono] web/app.ts — 2 commits");
    expect(g?.body.map((l) => l.kind)).toEqual(["nested", "nested"]);
    const before = drawnLines(html.slice(0, html.indexOf("<details")));
    expect(before[before.length - 1]).toEqual({ kind: "why", text: '— you wrote: "tidy the web app"' });
    const after = drawnLines(html.slice(html.indexOf("</details>")));
    expect(after[0]).toEqual({ kind: "bullet", text: "[mono] an ungrouped fix" });
  });

  test("two adjacent groups give two details, with nothing drawn between them", () => {
    const html = viewHtml(renderStruct(TWO_GROUPS));
    expect(shape(html)).toEqual([
      {
        header: "[mono] web/app.ts — 2 commits",
        members: ["[mono] reworked the header  (0a1b2c3)", "[mono] tuned the grid"],
      },
      {
        header: "[mono] web/store.ts — 2 commits",
        members: ["[mono] renamed the store  (4d5e6f7)", "[mono] typed the store"],
      },
    ]);
    const between = html.slice(html.indexOf("</details>") + "</details>".length, html.lastIndexOf("<details"));
    expect(drawnLines(between)).toEqual([]);
  });

  test("the coverage lines above the first group and the 🔀 foot below the last stay outside", () => {
    const html = viewHtml(renderStruct(TWO_GROUPS));
    const head = drawnLines(html.slice(0, html.indexOf("<details"))).map((l) => l.kind);
    expect(head.slice(-3)).toEqual(["coverage", "notShown", "why"]);
    const tail = drawnLines(html.slice(html.lastIndexOf("</details>")));
    expect(tail.slice(0, 2)).toEqual([
      { kind: "bullet", text: "[other] an ungrouped fix" },
      { kind: "bullet", text: "[a] 🔀 1 PR merged (#1) (Sep 13)  (aaaa111)" },
    ]);
    const rich = viewHtml(renderStruct(RICH));
    expect(drawnLines(rich.slice(rich.lastIndexOf("</details>"))).map((l) => l.text)).toContain(
      "[zeta] 🔀 2 PRs merged (#12, #13) (Sep 14)  (a1b2c3d, c9d8e7f)",
    );
  });

  test("an archived two-level page (the file path) collapses exactly as the struct path does", () => {
    for (const [, struct] of [...VARIANTS, ["two groups", TWO_GROUPS] as [string, BriefingStruct]]) {
      const fromFile = viewHtml(renderMarkdown(renderBriefing(struct as EngineStruct)));
      const fromStruct = viewHtml(renderStruct(struct));
      expect(shape(fromFile)).toEqual(shape(fromStruct));
      expect(shape(fromStruct)).toEqual(modelGroups(renderStruct(struct)));
      expect(allGroups(groups(fromFile)).map((g) => /\bopen\b/.test(g.attrs))).toEqual(allGroups(groups(fromStruct)).map(() => false));
    }
    expect(shape(viewHtml(renderMarkdown(renderBriefing(TWO_GROUPS as EngineStruct))))).toHaveLength(2);
    // …and a page written by hand in the engine's two-level shape, with inline forms in a member.
    const archived = [
      "☀️  Daily briefing — 2026-09-10  (this machine: mac)",
      "",
      "▶ What you did — 3 commits",
      '   — you wrote: "tidy"',
      "   • [mono] web/app.ts — 2 commits (09-14..09-15)",
      "      ◦ [mono] reworked the **header**  (0a1b2c3)",
      "      ◦ [mono] tuned the `grid`",
      "   • [other] a flat one",
      "",
      "— generated locally via claude",
    ].join("\n");
    const html = viewHtml(renderMarkdown(archived));
    expect(shape(html)).toEqual([
      {
        header: "[mono] web/app.ts — 2 commits (09-14..09-15)",
        members: ["[mono] reworked the header  (0a1b2c3)", "[mono] tuned the grid"],
      },
    ]);
    expect(drawnLines(html).map((l) => l.kind)).toEqual(["title", "heading", "why", "bullet", "nested", "nested", "bullet", "footer"]);
  });

  // prove-it 3b, for the HELPERS: this breaks the rendered STRING, not the component, so what it
  // proves is that the checks can see the two failures — the golden's read-back (`drawnLines`)
  // misses a line whose summary is gone, and the attribute allow-list names an `open`. The
  // component-side kills are measured by mutation (the fix round's table), not here.
  test("the helpers notice: markup without its summaries fails the golden, and an `open` attribute fails the allow-list", () => {
    const html = viewHtml(renderStruct(RICH));
    expect(drawnLines(html).map((l) => l.text)).toEqual(golden(RICH));
    const headless = html.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/g, "");
    expect(drawnLines(headless).map((l) => l.text)).not.toEqual(golden(RICH));
    // …and one that opened the group would fail the attribute allow-list.
    const { attributes } = tagsAndAttributes(html.replace("<details", "<details open"));
    expect([...attributes].filter((a) => !ALLOWED_ATTRIBUTES.has(a))).toEqual(["open"]);
  });
});

/* ── the row key (fix round, MED-1): a new briefing never inherits an open group ─────────────── */

/** A recap whose one group sits at row 1 under `header` — what Run Now swaps on Today, in place. */
function onePage(header: string): Block[] {
  return renderMarkdown(
    ["▶ What you did — 2 commits", `   • [mono] ${header}`, "      ◦ [mono] reworked it  (0a1b2c3)", "      ◦ [mono] tuned it"].join("\n"),
  );
}
const keysOf = (rows: Row[]) => rows.map((r, i) => rowKey(r, i));

/** Every node of one `type` in a parsed component, in any fragment. The AST shares nodes, hence
 *  `seen`. */
function nodesOfType(node: unknown, type: string, out: Record<string, any>[] = [], seen = new WeakSet<object>()): Record<string, any>[] {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if ((node as { type?: unknown }).type === type) out.push(node as Record<string, any>);
  for (const value of Object.values(node)) nodesOfType(value, type, out, seen);
  return out;
}

describe("the row key: a new briefing never inherits an open group", () => {
  // `open` is DOM state Svelte does not reset on a REUSED element, and Today swaps briefings
  // without unmounting the view, so the key decides whether row 1's <details> is reused. Server
  // rendering cannot show that (it has no DOM); the key function and the view's use of it are what
  // is pinned.
  test("a different header at the same index is a different key; the same header is the same key", () => {
    const before = groupRows(onePage("web/app.ts — 2 commits"));
    const next = groupRows(onePage("web/store.ts — 2 commits"));
    expect(before.map((r) => r.group)).toEqual([false, true]); // row 1 is a group on both pages
    expect(next.map((r) => r.group)).toEqual([false, true]);
    expect(rowKey(next[1]!, 1)).not.toBe(rowKey(before[1]!, 1));
    // A `state:changed` that leaves the briefing alone: a FRESH array with the same lines keeps
    // every key, so an open group stays open (why `{#key blocks}` is not the fix: it would close
    // it).
    const again = groupRows(onePage("web/app.ts — 2 commits"));
    expect(again).not.toBe(before);
    expect(keysOf(again)).toEqual(keysOf(before));
    // A plain row holds no DOM state; its key is its index.
    expect(rowKey(before[0]!, 0)).toBe("0");
    expect(rowKey(next[0]!, 0)).toBe(rowKey(before[0]!, 0));
  });

  test("keys are unique on every page, including two groups under the same header", () => {
    for (const [, struct] of [...VARIANTS, ["two groups", TWO_GROUPS] as [string, BriefingStruct]]) {
      const keys = keysOf(groupRows(renderStruct(struct)));
      expect(new Set(keys).size).toBe(keys.length);
    }
    const twice = groupRows(
      renderMarkdown(
        ["▶ What you did — 2 commits", "   • [mono] same — 1 commit", "      ◦ [mono] one", "   • [mono] same — 1 commit", "      ◦ [mono] two"].join("\n"),
      ),
    );
    expect(twice.filter((r) => r.group)).toHaveLength(2);
    expect(new Set(keysOf(twice)).size).toBe(twice.length);
    // The separator is load-bearing: without it, a group headed `2 x` at row 1 and one headed ` x`
    // at row 12 both key to "12 x", and Svelte throws on a duplicate key — Today would crash on
    // that (hand-edited) page. The fixture is checked to collide under a plain concatenation first,
    // so it cannot drift into testing nothing.
    const plain = Array.from({ length: 10 }, (_, k) => `   • p${k}`);
    const crafted = groupRows(
      renderMarkdown(["▶ What you did — 2 commits", "   • 2 x", "      ◦ a", ...plain, "   •  x", "      ◦ b"].join("\n")),
    );
    const at = crafted.flatMap((r, i) => (r.group ? [i] : []));
    expect(at).toEqual([1, 12]);
    const naive = at.map((i) => `${i}${blockText((crafted[i] as Extract<Row, { group: true }>).header)}`);
    expect(naive[0]).toBe(naive[1]);
    expect(new Set(keysOf(crafted)).size).toBe(crafted.length);
  });

  test("the view draws its rows under rowKey(row, i) — not under the index alone, and not inside a {#key}", () => {
    const source = readFileSync(new URL("../src/lib/BriefingView.svelte", import.meta.url), "utf8");
    const ast = parse(source, { modern: true });
    const overRows = nodesOfType(ast, "EachBlock").filter(
      (e) => e.expression?.type === "Identifier" && e.expression.name === "rows",
    );
    expect(overRows).toHaveLength(1);
    const [each] = overRows;
    expect(each?.key?.type).toBe("CallExpression");
    expect(each?.key?.callee?.name).toBe("rowKey");
    expect(each?.key?.arguments?.map((a: { name?: string }) => a.name)).toEqual([each?.context?.name, each?.index]);
    // A `{#key}` anywhere would re-create what it wraps whenever its value changes — and `blocks`
    // is a fresh array on every `state:changed` — so the open groups would close on every update.
    expect(nodesOfType(ast, "KeyBlock")).toEqual([]);
    // …and `rowKey` is the IMPORTED one: a local function of the same name would satisfy every
    // check above while keying by index again.
    const imports = nodesOfType(ast.instance, "ImportDeclaration").filter((d) => d.source?.value === "./briefing-rows");
    expect(imports.flatMap((d) => d.specifiers.map((sp: { local: { name: string } }) => sp.local.name))).toContain("rowKey");
    const localRowKey = [...nodesOfType(ast.instance, "VariableDeclarator"), ...nodesOfType(ast.instance, "FunctionDeclaration")].filter(
      (d) => d.id?.name === "rowKey",
    );
    expect(localRowKey).toEqual([]);
    expect(nodesOfType(ast, "EachBlock").length).toBeGreaterThan(0); // the walk reaches the template
  });
});

/* ── tier B (T2.3, plan §4): the helper-equality capture — a NAMED ONE-SHOT ────────────────────── */

/** The outputs of this file's helpers — `visible()` over every golden line, `modelGroups` and `groups`
 *  over every `VARIANTS` entry, plus each renderer's line KINDS — as they were BEFORE any tier-B edit
 *  to them, written to `__fixtures__/helpers-pre-tierb.json`. Captured ONCE, on the unchanged helpers,
 *  by `CAPTURE_HELPERS=1 bun run test`, and committed before the first helper edit; skipped otherwise.
 *  `helpers reproduce their pre-tierb outputs on every existing variant` (below, after the edits) holds
 *  the changed helpers to it. The helpers are private to this file, and the runner runs only
 *  `tests-web/*.check.ts`, so the capture lives here as a test rather than as a script. */
function helperOutputs(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, struct] of VARIANTS) {
    const blocks = renderStruct(struct);
    out[name] = {
      visible: golden(struct),
      modelGroups: modelGroups(blocks),
      groups: groups(viewHtml(blocks)),
      fileKinds: renderMarkdown(renderBriefing(struct as EngineStruct)).map((b) => b.kind),
      structKinds: blocks.map((b) => b.kind),
    };
  }
  return out;
}

test.skipIf(!process.env.CAPTURE_HELPERS)("capture pre-tierb helper outputs", async () => {
  const out = helperOutputs();
  expect(Object.keys(out)).toHaveLength(VARIANTS.length);
  await Bun.write(new URL("./__fixtures__/helpers-pre-tierb.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
});

/* ── tier B (T2.3): the third level in the GUI model, and the helper-equality proof ────────────── */

describe("tier B: the third level (T2.3)", () => {
  test("the campaign variant exercises the nested2 line kind", () => {
    // The GUI's prefix is the engine's constant, not a spelling of its own.
    expect(NESTED2).toBe(ENGINE_L3);
    expect(NESTED2).toBe("         ▪ ");
    expect(classifyLine(`${NESTED2}[x] y`)).toEqual({ kind: "nested2", text: "[x] y" });
    const s = variant("campaign");
    expect(renderStruct(s).filter((b) => b.kind === "nested2")).toHaveLength(2);
    expect(renderMarkdown(renderBriefing(s as EngineStruct)).filter((b) => b.kind === "nested2")).toHaveLength(2);
    // …and NOT on RICH: it has no campaign, and its kinds are the pre-tierb set (the fixture below).
    expect(renderStruct(RICH).some((b) => b.kind === "nested2")).toBe(false);
  });

  test("helpers reproduce their pre-tierb outputs on every existing variant", () => {
    // The fixture was captured on the UNCHANGED helpers (`capture pre-tierb helper outputs`, committed
    // before the first helper edit). The changed helpers — `visible()` with the new prefix, the two
    // renderers with the third level — must give exactly those outputs on every variant that existed
    // then. The campaign variant is not in the fixture and is not compared.
    // Svelte's scoped class hash (`svelte-<hash>` in `groups()[].attrs`) is derived from the component's
    // filename RELATIVE TO THE CWD, so it differs between a run from `gui/` and one from the package
    // root. It is normalised on BOTH sides — only that token, only in `attrs` — before comparing.
    const unhash = (v: unknown): unknown => JSON.parse(JSON.stringify(v), (k, x) =>
      k === "attrs" && typeof x === "string" ? x.replace(/\bsvelte-[a-z0-9]+\b/g, "svelte-HASH") : x);
    const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/helpers-pre-tierb.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const names = Object.keys(fixture);
    expect(names).toHaveLength(9);
    expect(names).not.toContain("campaign");
    const now = helperOutputs();
    for (const name of names) {
      variant(name);                                                     // throws on a renamed variant
      expect(unhash(now[name])).toEqual(unhash(fixture[name]));
    }
  });

  test("[TB-P19a] the GUI parity variant (third level) against renderBriefing: text and kinds at all three levels", () => {
    const s = variant("campaign");
    const expected = golden(s);
    const blocks = renderStruct(s);
    expect(blocks.map(blockText)).toEqual(expected);
    const fromFile = renderMarkdown(renderBriefing(s as EngineStruct));
    expect(fromFile.map(blockText)).toEqual(expected);
    expect(fromFile.map((b) => b.kind)).toEqual(blocks.map((b) => b.kind));
    // the recap section, line by line: why, the campaign header, its group at level 2, the group's
    // members at level 3, its single at level 2, then the non-member and the trailing ungrouped bullet
    const at = blocks.findIndex((b) => blockText(b).startsWith("What you did"));
    expect(blocks.slice(at + 1, at + 9).map((b) => [b.kind, blockText(b)])).toEqual([
      ["why", '— you wrote: "tidy the web app"'],
      ["bullet", "[mono] tidy the web app — 3 commits"],
      ["nested", "[mono] web/app.ts — 2 commits"],
      ["nested2", "[mono] reworked the header  (0a1b2c3)"],
      ["nested2", "[mono] tuned the grid  (1f2e3d4)"],
      ["nested", "[mono] fixed the footer  (4d5e6f7)"],
      ["bullet", "[other] an unrelated fix  (9f8e7d6)"],
      ["bullet", "[mono] an ungrouped fix after the campaign"],
    ]);
    // the engine's own bytes for those lines carry the three prefixes
    const lines = renderBriefing(s as EngineStruct).split("\n");
    expect(lines).toContain("   • [mono] tidy the web app — 3 commits");
    expect(lines).toContain("      ◦ [mono] web/app.ts — 2 commits");
    expect(lines).toContain(`${ENGINE_L3}[mono] reworked the header  (0a1b2c3)`);
    // …and the VIEW draws every line, in order, the level-3 ones as nested2
    const drawn = drawnLines(viewHtml(blocks));
    expect(drawn.map((l) => l.text)).toEqual(expected);
    expect(drawn.filter((l) => l.kind === "nested2").map((l) => l.text)).toEqual(["[mono] reworked the header  (0a1b2c3)", "[mono] tuned the grid  (1f2e3d4)"]);
    // the engine's struct type and the GUI's agree on the new field
    const _t: EngineStruct = s as EngineStruct;
    expect(_t.recap[0]?.campaign).toBe("tidy the web app — 3 commits");
  });

  test("[TB-P20] archived two-level pages classify unchanged", () => {
    // Every pre-tierb variant's page classifies to the kinds captured before the third level existed,
    // and none of them holds a nested2 line.
    const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/helpers-pre-tierb.json", import.meta.url), "utf8")) as Record<string, { fileKinds: string[] }>;
    for (const name of Object.keys(fixture)) {
      const kinds = renderMarkdown(renderBriefing(variant(name) as EngineStruct)).map((b) => b.kind);
      expect(kinds).toEqual(fixture[name]!.fileKinds);
      expect(kinds).not.toContain("nested2");
    }
    // A hand-written archived two-level page: its `◦` lines are `nested`, never `nested2`; a plain
    // six-space line is text; only the nine-space `▪` prefix is the new kind.
    const page = ["▶ What you did — 2 commits", "   • [app] web/app.ts — 2 commits", "      ◦ [app] one  (0a1b2c3)", "      ◦ [app] two", "      six spaces, no glyph"].join("\n");
    expect(renderMarkdown(page).map((b) => b.kind)).toEqual(["heading", "bullet", "nested", "nested", "text"]);
    expect(classifyLine("      ◦ [app] one")).toEqual({ kind: "nested", text: "[app] one" });
    expect(classifyLine(`${NESTED2}[app] deep`)?.kind).toBe("nested2");
    expect(renderMarkdown(renderBriefing(RICH as EngineStruct)).filter((b) => b.kind === "nested")).toHaveLength(3);
  });
});

/* ── tier B (T2.4): the collapse of the third level ────────────────────────────────────────────── */

describe("tier B: the collapse of the third level (T2.4)", () => {
  const CAMPAIGN_HEADER = "[mono] tidy the web app — 3 commits";
  const SUB_HEADER = "[mono] web/app.ts — 2 commits";
  const L3 = ["[mono] reworked the header  (0a1b2c3)", "[mono] tuned the grid  (1f2e3d4)"];

  test("[TB-P19b] the GUI collapse state: collapsed, only level-1 lines show; one campaign expanded, its level-2 lines show and every Stage-1 sub-group stays a closed <details> holding the level-3 lines", () => {
    const html = viewHtml(renderStruct(variant("campaign")));
    // structural (D12): the markup declares no `open` anywhere, at either level
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    const [g] = groups(html);
    expect(groups(html)).toHaveLength(1);
    expect(g?.summary).toEqual({ kind: "bullet", text: CAMPAIGN_HEADER });
    // COLLAPSED: what shows is every line outside a closed body plus the closed groups' summaries —
    // level-1 lines only: no `nested`, no `nested2`
    const closed = visibleLines(html);
    expect(closed.map((l) => l.kind)).not.toContain("nested");
    expect(closed.map((l) => l.kind)).not.toContain("nested2");
    expect(closed.filter((l) => l.kind === "bullet").map((l) => l.text)).toEqual([
      CAMPAIGN_HEADER, "[other] an unrelated fix  (9f8e7d6)", "[mono] an ungrouped fix after the campaign",
    ]);
    // …yet every line is in the DOM (the golden still requires each engine line)
    expect(drawnLines(html).map((l) => l.text)).toEqual(golden(variant("campaign")));
    expect(drawnLines(html).filter((l) => l.kind === "nested2").map((l) => l.text)).toEqual(L3);
    // ONE CAMPAIGN EXPANDED, by the test helper: its outer <details> opened in the HTML string
    const opened = html.replace("<details", "<details open");
    expect(groups(opened)[0]?.attrs).toMatch(/\bopen\b/);
    const view = visibleLines(opened);
    expect(view.filter((l) => l.kind === "nested").map((l) => l.text)).toEqual([SUB_HEADER, "[mono] fixed the footer  (4d5e6f7)"]);
    expect(view.map((l) => l.kind)).not.toContain("nested2");                 // the sub-group is still closed
    // every Stage-1 sub-group is a closed <details> holding exactly the level-3 lines, its header on the
    // summary at the ◦ level
    expect(g?.subs).toHaveLength(1);
    const sub = g!.subs![0]!;
    expect(sub.attrs).not.toMatch(/\bopen\b/);
    expect(sub.summary).toEqual({ kind: "nested", text: SUB_HEADER });
    expect(sub.body).toEqual(L3.map((text) => ({ kind: "nested2", text })));
    expect(sub.subs).toBeUndefined();                                          // no fourth level
    // the single member sits in the campaign's own body, outside the sub-group
    expect(g?.body.map((l) => [l.kind, l.text])).toEqual([["nested", SUB_HEADER], ["nested2", L3[0]], ["nested2", L3[1]], ["nested", "[mono] fixed the footer  (4d5e6f7)"]]);
    // …and with the sub-group opened too, the level-3 lines show
    const both = opened.replace(/<details([^>]*)>(<summary\b[^>]*\bclass="b nested)/, "<details$1 open>$2");
    expect(allGroups(groups(both)).map((x) => /\bopen\b/.test(x.attrs))).toEqual([true, true]);
    expect(visibleLines(both).filter((l) => l.kind === "nested2").map((l) => l.text)).toEqual(L3);
    // a two-level page is unchanged by any of this: one closed details, no sub-groups
    const two = viewHtml(renderStruct(variant("why on a cluster")));
    expect(groups(two)).toHaveLength(1);
    expect(groups(two)[0]?.subs).toBeUndefined();
    expect(visibleLines(two).map((l) => l.kind)).not.toContain("nested");
  });

  test("sub-group keys are unique, and a new briefing never inherits an open sub-group", () => {
    const rows = groupRows(renderStruct(variant("campaign")));
    const camp = rows.find((r) => r.group && blockText(r.header) === CAMPAIGN_HEADER) as Extract<Row, { group: true }> | undefined;
    expect(camp).toBeDefined();
    expect(camp!.members.map((m) => m.group)).toEqual([true, false]);
    const keys = camp!.members.map((m, j) => subRowKey(m, j));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([`0\u0001${SUB_HEADER}`, "1"]);
    // Run Now swaps the briefing in place: a DIFFERENT sub-group at the same position under the next
    // briefing's campaign is a different key (a fresh, closed element); the same lines again keep it.
    const page = (sub: string) => renderMarkdown([
      "▶ What you did — 3 commits", "   • [mono] tidy — 3 commits", `      ◦ [mono] ${sub}`, "         ▪ [mono] one", "         ▪ [mono] two", "      ◦ [mono] a single",
    ].join("\n"));
    const subs = (rs: Row[]) => (rs[1] as Extract<Row, { group: true }>).members;
    const a = groupRows(page("web/app.ts — 2 commits")), b = groupRows(page("web/store.ts — 2 commits")), again = groupRows(page("web/app.ts — 2 commits"));
    expect(subs(a).map((m) => m.group)).toEqual([true, false]);
    expect(subRowKey(subs(b)[0]!, 0)).not.toBe(subRowKey(subs(a)[0]!, 0));
    expect(subs(again).map((m, j) => subRowKey(m, j))).toEqual(subs(a).map((m, j) => subRowKey(m, j)));
    // a plain member keys by its index alone (no DOM state to leak); the outer key is unchanged
    expect(subRowKey(subs(a)[1]!, 1)).toBe("1");
    expect(rowKey(a[1]!, 1)).toBe("1\u0001[mono] tidy — 3 commits");
    // two sub-groups under ONE campaign with the SAME header: unique by index; and the separator is
    // load-bearing exactly as it is for rows (`1` + ` x` vs `1 x` collide under plain concatenation)
    const twice = groupRows(renderMarkdown([
      "▶ What you did — 4 commits", "   • [mono] tidy — 4 commits", "      ◦ [mono] same", "         ▪ [mono] x", "      ◦ [mono] same", "         ▪ [mono] y",
    ].join("\n")));
    const tk = subs(twice).map((m, j) => subRowKey(m, j));
    expect(subs(twice).map((m) => m.group)).toEqual([true, true]);
    expect(new Set(tk).size).toBe(2);
    // the VIEW keys its members by the imported subRowKey — pinned on the component's AST like rowKey
    const source = readFileSync(new URL("../src/lib/BriefingView.svelte", import.meta.url), "utf8");
    const ast = parse(source, { modern: true });
    const overMembers = nodesOfType(ast, "EachBlock").filter((e) => e.expression?.type === "MemberExpression" && e.expression.property?.name === "members" && e.expression.object?.name === "row");
    expect(overMembers).toHaveLength(1);
    expect(overMembers[0]?.key?.type).toBe("CallExpression");
    expect(overMembers[0]?.key?.callee?.name).toBe("subRowKey");
    expect(overMembers[0]?.key?.arguments?.map((x: { name?: string }) => x.name)).toEqual([overMembers[0]?.context?.name, overMembers[0]?.index]);
    const imports = nodesOfType(ast.instance, "ImportDeclaration").filter((d) => d.source?.value === "./briefing-rows");
    expect(imports.flatMap((d) => d.specifiers.map((sp: { local: { name: string } }) => sp.local.name))).toContain("subRowKey");
    expect(nodesOfType(ast, "KeyBlock")).toEqual([]);
  });

  test("the campaign variant's markup passes the tag and attribute allow-list", () => {
    const html = viewHtml(renderStruct(variant("campaign")));
    const { tags, attributes } = tagsAndAttributes(html);
    expect([...tags].filter((t) => !ALLOWED_TAGS.has(t))).toEqual([]);
    expect([...attributes].filter((a) => !ALLOWED_ATTRIBUTES.has(a))).toEqual([]);
    // not vacuous: the markup really nests a <details> inside a <details>, and nothing is `open`
    expect(groups(html)[0]?.subs).toHaveLength(1);
    expect(html).toMatch(/<details[^>]*>[^]*?<details[^>]*>[^]*?<\/details>[^]*?<\/details>/);
    expect(attributes.has("open")).toBe(false);
    // the list itself is #545's — nothing was added for the third level
    expect([...ALLOWED_TAGS].sort()).toEqual(["article", "code", "details", "h3", "h4", "p", "span", "strong", "summary"]);
    expect([...ALLOWED_ATTRIBUTES].sort()).toEqual(["class", "data-block"]);
    // and a plain member, as groupRows builds it for the view, is exactly `Member`'s non-group arm
    const camp = groupRows(renderStruct(variant("campaign"))).find((r) => r.group && blockText(r.header) === CAMPAIGN_HEADER) as Extract<Row, { group: true }> | undefined;
    const plain: Member | undefined = camp?.members.find((m) => !m.group);
    expect(plain && Object.keys(plain).sort()).toEqual(["block", "group"]);
    expect(plain && !plain.group && [plain.block.kind, blockText(plain.block)]).toEqual(["nested", "[mono] fixed the footer  (4d5e6f7)"]);
  });
});
