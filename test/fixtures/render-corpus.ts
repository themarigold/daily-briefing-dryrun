// test/fixtures/render-corpus.ts — the RENDER CORPUS (tier B, T1.0): every struct whose `renderBriefing`
// bytes are frozen at the build's base by `test/render.golden.test.ts`.
//
// WHAT "EVERY BRANCH" MEANS HERE, exactly: every row of the reviewed branch table at
// `gui/tests-web/briefing.check.ts:59–90` — the enumeration of `renderBriefing`'s conditionals that
// review round 1 of the GUI parity suite completed (it found two rows missing, "why before a GROUPED
// story line" and "merges under an EMPTY recap", and both have a variant) — ported as ENGINE data
// (RICH, QUIET and the VARIANTS rows, byte for byte), plus TWO rows that table lacks:
//   · `verdict-path marker` — a suggestion stamped `verdictPath` (IN-2), the one render branch the
//     GUI table has no row for;
//   · `Mono/mono label pair` — labels that differ only by `norm` across sections: the why's home is
//     decided on `norm(label)`, the cluster key is `norm(repo)` + stamp text, and the legend/merge
//     lines are not (they print the raw bracket).
// NOTHING in that table could not be ported: every fixture there is plain `BriefingStruct` data (the
// GUI file itself asserts `VARIANTS.map(v => v as EngineStruct)`), so no row is claimed beyond the
// list above and none is missing from it. The table's rows, for the record (fixture in brackets):
//   outage absent / N days / 1 day                       [quiet / rich / one missed day]
//   legend absent / empty group / over cap / at cap      [quiet / rich / rich / one commit…]
//   legend "is an area" / "are areas"                    [rich (mono) / rich]
//   stamp absent / floor + time / time only              [quiet / rich / one missed day]
//   branchState lines                                    [rich]
//   resume empty / bullets                               [quiet / rich]
//   why: resume home / recap home / none                 [rich / rich / rich (nowhere)]
//   why before an ungrouped recap bullet                 [rich (accountant_ai)]
//   why before a GROUPED story line; not repeated        [why on a cluster]
//   coverage absent / hidden > 0 / hidden = 0            [quiet / rich / coverage over an empty recap]
//   head count: coverage / bullets / none; sing./plural  [rich / one commit… / quiet]
//   recap: ungrouped / cluster first / later skipped     [rich / rich / rich ("Mono.")]
//   evidence present / absent                            [rich]
//   recap empty: placeholder / nothing (coverage)        [quiet / coverage over an empty recap]
//   merges: multi / single / dated / range / passthrough [rich / rich / rich / merges, quiet recap / rich]
//   merges under an EMPTY recap                          [merges, quiet recap]
//   today absent / present                               [quiet / rich]
//   suggestions none / repo / no repo / promoted         [quiet / rich / rich / rich]
//   stash label: no branch / name hidden / today / 1 day / bare   [stash suggestions]
//   warnings absent / present                            [quiet / rich]
//   control bytes stripped per line                      [rich]
//
// ⚠ FROZEN. This file is held to the freeze commit by F-7 (plan §10): only a commit named
// `tierb: corpus addition at <freeze-base>` may touch it, and a new row's `.snap` entry is captured in a
// disposable tree at the freeze base — upstream code, no B — never from the branch's own render.
import type { BriefingStruct } from "../../src/types";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(7);
const TAB = String.fromCharCode(9);
const C1 = String.fromCharCode(0x9b);
const HOSTILE = "<img src=x onerror=alert(1)>";

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

export const RENDER_CORPUS: readonly { name: string; struct: BriefingStruct }[] = [
  { name: "rich", struct: RICH },
  { name: "quiet day", struct: QUIET },
  { name: "one missed day, no floor", struct: { ...QUIET, outage: { missedDays: 1, label: "primary" }, stateAsOf: "09:01" } },
  {
    name: "coverage over an empty recap",
    struct: {
      ...QUIET,
      recapCoverage: { shown: 0, total: 1, notShown: [{ label: "x", sha: "deadbee", subject: "lost" }] },
    },
  },
  {
    name: "one commit, a why with no recap home, legend at the cap",
    struct: {
      ...QUIET,
      whys: { solo: "why solo" },
      resume: [{ repo: "solo", text: "keep going" }],
      recap: [{ repo: "other", text: "one thing" }],
      labelLegend: [{ repo: "big", labels: ["1", "2", "3", "4", "5", "6", "7", "8"] }],
      suggestions: [{ text: "promoted, no repo", promoted: true }],
      warnings: ["only one"],
    },
  },
  {
    // The why for a label whose first recap entry is a CLUSTER goes before the story line, and is not
    // repeated before that label's later, ungrouped bullet.
    name: "why on a cluster",
    struct: {
      ...QUIET,
      whys: { mono: "tidy the web app" },
      recap: [
        { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 2 commits" },
        { repo: "mono", text: "tuned the grid", group: "web/app.ts — 2 commits" },
        { repo: "mono", text: "an ungrouped fix" },
      ],
    },
  },
  {
    // Merges render under an EMPTY recap too — after the placeholder.
    name: "merges, quiet recap",
    struct: {
      ...QUIET,
      windowMerges: [
        { repo: "b", text: "🔀 Merged #2 (fix/b) (Sep 14)  (bbbb222)" },
        { repo: "a", text: "🔀 Merged #1 (fix/a) (Sep 13)  (aaaa111)" },
        { repo: "a", text: "🔀 Merged #3 (fix/c) (Sep 15)  (cccc333)" },
      ],
    },
  },
  {
    // Model text that LOOKS like an image, with an http(s) target, stays literal.
    name: "image-shaped text",
    struct: { ...QUIET, suggestions: [{ text: "see ![diagram](https://example.com/d.png) first" }] },
  },
  {
    // IN-10: every branch of `stashLabel`; a model suggestion beside them stays unlabelled; a branch
    // NAME never renders — only `no branch` does.
    name: "stash suggestions",
    struct: {
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
  },
  // ── The two rows the GUI table lacks ──────────────────────────────────────────────────────────────
  {
    // IN-2: the marker line under a `verdictPath` suggestion; its neighbour, unstamped, is untouched.
    name: "verdict-path marker",
    struct: {
      ...QUIET,
      suggestions: [
        { text: "sign off the sigma-integrity change", repo: "quant_stocks", verdictPath: true },
        { text: "[quant_stocks] plain suggestion beside it" },
      ],
    },
  },
  {
    // `Mono` / `mono` / `Mono.`: one `norm` key. The why's home is decided per norm (recap wins over
    // resume), the cluster nests all three spellings under ONE story line, and the raw brackets print
    // as written on every line.
    name: "Mono/mono label pair",
    struct: {
      ...QUIET,
      whys: { mono: "tidy the app" },
      branchState: [{ repo: "Mono", text: "on feat/tidy, 1 ahead of origin" }],
      resume: [{ repo: "Mono", text: "resume the tidy-up" }],
      recap: [
        { repo: "mono", text: "reworked the header", evidence: "0a1b2c3", group: "web/app.ts — 3 commits (Sep 14–15)" },
        { repo: "other", text: "an unrelated fix", evidence: "9f8e7d6" },
        { repo: "Mono.", text: "fixed the footer", evidence: "1f2e3d4", group: "web/app.ts — 3 commits (Sep 14–15)" },
        { repo: "Mono", text: "tuned the grid", group: "web/app.ts — 3 commits (Sep 14–15)" },
      ],
      windowMerges: [
        { repo: "Mono", text: "🔀 Merged #1 (x) (Sep 14)  (aaaa111)" },
        { repo: "mono", text: "🔀 Merged #2 (y) (Sep 14)  (bbbb222)" },
      ],
      suggestions: [{ text: "ship the tidy-up", repo: "mono" }],
    },
  },
];
