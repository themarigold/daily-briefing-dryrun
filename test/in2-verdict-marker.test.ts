// test/in2-verdict-marker.test.ts — IN-2: the VERDICT-PATH MARKER on suggestions (EVAL days 51/52).
//
// Day 52's judge: "'Wire deflated-edge input into rule 2's graduation gate' is verdict-path /
// signal-adoption work, quant guardrail class. Briefing proposes it flat, with no human-gate flag —
// the suggestion itself is genuine and well-grounded; the framing is the defect."
//
// Three binding constraints, each pinned below:
//   (a) RENDER-SIDE — annotate, never suppress;
//   (b) CONFIG-KEYED, additive-optional, DEFAULT OFF (`Config.verdictPaths`);
//   (c) the marker line's PREFIX is ONE shared constant EXCLUDED from `audit.coverageGaps`' haystack —
//       the #399 shape, and the condition EVAL.md's 2026-09-17 comparability boundary rests on.
import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir
import { test, expect, describe } from "bun:test";
import { renderBriefing, VERDICT_MARKER_TEXT } from "../src/render";
import {
  VERDICT_MARKER_PREFIX, LEGEND_PREFIX, NOT_SHOWN_PREFIX, labelBoundary,
} from "../src/subprojects";
import {
  coverageGaps, extractCitedShas, missingSameDay, branchLinesFromBriefing, generationInstant, quotationsIn,
} from "../src/audit";
import { parseWhy } from "../src/transcripts/frame";
import { resolveVerdictPaths } from "../src/config";
import { featuresLine } from "../src/audit";
import { markVerdictPathSuggestions, runCore } from "../src/core";
import { validateCandidate } from "../src/json";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import type { Activity, BriefingStruct, Config } from "../src/types";

const base: BriefingStruct = {
  date: "2026-09-06", machineScope: "mymac", provider: "claude",
  resume: [], recap: [], suggestions: [],
};

const commit = (sha: string, files: string[], extra: Partial<Activity> = {}): Activity => ({
  source: "git", kind: "commit", event_id: sha, repo: "/w/personal_code", timestamp: "2026-09-05T12:00:00-07:00",
  text: `subject ${sha.slice(0, 7)}`, meta: { diffstat: files.map((file) => ({ file, added: 1, removed: 0 })) }, ...extra,
});

// Full 40-char ids, as `listCommits` emits them. Chosen so no two share a 7-char prefix EXCEPT the
// deliberate ambiguous pair.
const QUANT = "0d741d9aa11bb22cc33dd44ee55ff66778899001";         // quant_stocks/live — the day-52 citation
const ACCT = "5ab248c0000000000000000000000000000000aa";          // accountant_ai only
const SIBLING = "7c7c7c71111111111111111111111111111111bb";       // quant_stocks_old — a NAME-prefix, not a dir
const RENAME = "9e9e9e92222222222222222222222222222222cc";        // renamed OUT of quant_options
const DIGITS = "4760499333333333333333333333333333333333";        // an all-digit 7-char abbreviation
const AMBIG_A = "abcdef1444444444444444444444444444444444";
const AMBIG_B = "abcdef1555555555555555555555555555555555";       // shares `abcdef1` with AMBIG_A
const POOL: Activity[] = [
  commit(QUANT, ["quant_stocks/live/graduation.py", "quant_stocks/live/test_graduation.py"]),
  commit(ACCT, ["accountant_ai/core/match_read.py"]),
  commit(SIBLING, ["quant_stocks_old/notes.md"]),
  { ...commit(RENAME, []), meta: { diffstat: [{ file: "archive/rule2.py", renamedFrom: "quant_options/rule2.py", added: 0, removed: 0 }] } },
  commit(DIGITS, ["quant_options/sizing.py"]),
  commit(AMBIG_A, ["quant_stocks/a.py"]),
  commit(AMBIG_B, ["quant_stocks/b.py"]),
  // Not a commit, and only the `kind` filter keeps it out: its id is hex and its diffstat is under a
  // verdict path, so a pool that admitted it would mark "rebase onto (f00dfac)" below. (Production ids
  // for non-commits are repo-prefixed — `eventId.ts` — so this is a synthetic worst case; the first
  // cut's `branch:x` id could never match a hex token, which left the filter unpinned — IN-2 review.)
  { source: "git", kind: "branch", event_id: "f00dfacecafe0000000000000000000000000000", repo: "/w/personal_code",
    meta: { tip: "f00dfacecafe0000000000000000000000000000", diffstat: [{ file: "quant_stocks/live/graduation.py", added: 1, removed: 0 }] } },
];
const SEED = ["quant_stocks", "quant_options"];

// ── (b) CONFIG: additive-optional, default OFF, B1-style degradation ─────────────────────────────
describe("resolveVerdictPaths — Config.verdictPaths", () => {
  test("UNSET is off with no warning: absent, null and [] all yield no paths (default off)", () => {
    expect(resolveVerdictPaths(undefined)).toEqual({ paths: [] });
    expect(resolveVerdictPaths(null)).toEqual({ paths: [] });
    expect(resolveVerdictPaths([])).toEqual({ paths: [] });
  });

  test("normalises to bare repo-relative directory prefixes, de-duplicated", () => {
    expect(resolveVerdictPaths(["quant_stocks/", "./quant_options", "quant_stocks", "  quant_stocks//  "]))
      .toEqual({ paths: ["quant_stocks", "quant_options"] });
    expect(resolveVerdictPaths(["quant_stocks/live"])).toEqual({ paths: ["quant_stocks/live"] });
  });

  // The warning, as a LITERAL (not the source's constant): a mutant that re-words it — adds an example
  // lane, echoes the configured value — must fail here, and comparing against the constant it mutated
  // would pass.
  const WARNING = 'config: "verdictPaths" must be an array of literal repo-relative directory paths, no globs — verdict-path marker disabled';

  test("a malformed value DISABLES the marker with a warning — never throws, never half-applies", () => {
    for (const bad of ["quant_stocks/", 5, {}, [1], [""], ["/abs/quant"], ["~/quant"], ["a/../b"], ["."], ["./"], ["a//b"], ["quant_stocks", 7]]) {
      const r = resolveVerdictPaths(bad);
      expect(r.paths).toEqual([]);
      // FIXED TEXT, identical for every bad value: it renders in the briefing's ⚠ line, which feeds
      // coverageGaps' haystack, so it must never name a lane — neither an example like `quant_stocks/`
      // nor an echo of what the operator typed (either would "surface" that repo on this very morning).
      expect(r.warning).toBe(WARNING);
      expect(r.warning).not.toMatch(/quant|\//);
    }
  });

  test("GLOBS and BACKSLASHES are rejected, not accepted-and-dead: the day-52 judge's own `quant_stocks/**` among them", () => {
    // audit-2026-09-06.md:40 spells the path `quant_stocks/**`, and the sibling key subprojects[].roots
    // DOES take globs — accepted silently, each of these enabled a marker that could never fire.
    for (const glob of ["quant_stocks/**", "quant_stocks/*", "quant_*", "quant_stocks/*.py", "quant_?tocks",
      "quant_{stocks,options}", "quant_stocks/[a-z]*", "!quant_stocks/docs", "quant_stocks\\live", "quant_stocks\\"]) {
      expect(resolveVerdictPaths([glob])).toEqual({ paths: [], warning: WARNING });
      expect(resolveVerdictPaths(["quant_options", glob])).toEqual({ paths: [], warning: WARNING });   // all-or-nothing
    }
  });

  test("the two shapes the resolver cannot refuse: wrong CASE matches anyway; a REPO-NAME prefix is accepted and shown", () => {
    // Case: accepted verbatim, and the matcher is case-insensitive (see the marking tests below).
    expect(resolveVerdictPaths(["Quant_Stocks/"])).toEqual({ paths: ["Quant_Stocks"] });
    // A repo-name prefix cannot be told from a real inner folder (`pkg/pkg/`) without the repo — so it is
    // accepted, never matches unless that folder exists, and the audit's features line PRINTS it.
    expect(resolveVerdictPaths(["personal_code/quant_stocks"])).toEqual({ paths: ["personal_code/quant_stocks"] });
    const cite: { text: string; verdictPath?: true }[] = [{ text: `wire it (${QUANT.slice(0, 7)})` }];
    expect(markVerdictPathSuggestions(cite, POOL, ["personal_code/quant_stocks"])[0]!.verdictPath).toBeUndefined();
    expect(featuresLine({ provider: {}, verdictPaths: ["personal_code/quant_stocks/"] }, { enabled: false, root: "/x" }))
      .toContain("verdictPaths=on (personal_code/quant_stocks)");
  });

  test("validateCandidate (the GUI's config check) reports the same warning, and only when malformed", () => {
    const PROV = { cli: "echo", argv: [], promptVia: "stdin" };
    const bad = validateCandidate({ provider: PROV, verdictPaths: "quant_stocks/" }, "/home/me", {});
    expect(bad.valid).toBe(true);   // a WARNING, not an error — the briefing still runs
    expect(bad.warnings.filter((w) => w.field === "verdictPaths")).toHaveLength(1);
    for (const raw of [{ provider: PROV }, { provider: PROV, verdictPaths: ["quant_stocks/"] }]) {
      expect(validateCandidate(raw, "/home/me", {}).warnings.filter((w) => w.field === "verdictPaths")).toEqual([]);
    }
  });

  test("the audit's features line says whether the marker was ON — off, on (with its paths), and malformed", () => {
    // IN-2 review, lens 2: without it a key-on day with zero marks reads like a key-off day, and an
    // EVAL watch can be opened on a switched-off marker (the day-29/32 failure featuresLine exists for).
    const tx = { enabled: false, root: "/x" };
    expect(featuresLine({ provider: {} }, tx)).toContain("verdictPaths=OFF");
    expect(featuresLine({ provider: {}, verdictPaths: [] }, tx)).toContain("verdictPaths=OFF");
    expect(featuresLine({ provider: {}, verdictPaths: ["quant_stocks/", "./quant_options"] }, tx))
      .toContain("verdictPaths=on (quant_stocks, quant_options)");
    expect(featuresLine({ provider: {}, verdictPaths: ["quant_stocks/**"] }, tx))
      .toContain("verdictPaths=OFF (malformed — marker disabled)");
  });
});

// ── THE KEY: a cited SHA → exactly one real commit → its git diffstat ────────────────────────────
describe("markVerdictPathSuggestions — git-derived key, never prose", () => {
  const S = (text: string, extra: Partial<BriefingStruct["suggestions"][number]> = {}) => ({ text, ...extra });

  test("DEFAULT OFF: no prefixes ⇒ the input array itself comes back, with no field on any entry", () => {
    const input = [S(`Wire deflated-edge input into rule 2's graduation gate (${QUANT.slice(0, 7)})`)];
    const out = markVerdictPathSuggestions(input, POOL, []);
    expect(out).toBe(input);
    expect("verdictPath" in out[0]!).toBe(false);
  });

  test("a suggestion citing a commit under a configured path is marked; the day-52 item carried NO [label]", () => {
    const out = markVerdictPathSuggestions([
      S(`Wire deflated-edge input into rule 2's graduation gate in quant_stocks/live — currently it only refuses when that input is missing (${QUANT.slice(0, 7)}), the actual input wiring looks unstarted.`),
    ], POOL, SEED);
    expect(out[0]!.verdictPath).toBe(true);
  });

  test("NEVER SUPPRESSES: same length, same order, same text; only the matching entry gains the field", () => {
    const input = [
      S(`[accountant_ai] Add a test for the booked_twin projection (${ACCT.slice(0, 7)}).`),
      S(`[quant_stocks] Roll the P2 ledger enforcement out (${QUANT.slice(0, 7)}).`, { repo: undefined }),
      S("wiring that input into rule 2", { repo: "quant_stocks", promoted: true }),
    ];
    const out = markVerdictPathSuggestions(input, POOL, SEED);
    expect(out.map((s) => s.text)).toEqual(input.map((s) => s.text));
    expect(out.map((s) => s.verdictPath)).toEqual([undefined, true, undefined]);
    expect(out[0]).toBe(input[0]!);           // an unmarked entry is not even copied
    expect(out[1]).not.toBe(input[1]!);       // the marked one is a copy — the input is not mutated
    expect("verdictPath" in input[1]!).toBe(false);
  });

  test("PROSE IS NOT A KEY: a [quant_stocks] label, a promoted repo field, or a named path with no SHA marks nothing", () => {
    const out = markVerdictPathSuggestions([
      S("[quant_stocks] wire the deflated-edge input into rule 2's graduation gate"),
      S("wiring that input into rule 2", { repo: "quant_stocks", promoted: true }),
      S("edit quant_stocks/live/graduation.py to consume the deflated edge"),
    ], POOL, SEED);
    expect(out.every((s) => s.verdictPath === undefined)).toBe(true);
  });

  test("the prefix is a DIRECTORY boundary: quant_stocks does not match quant_stocks_old/", () => {
    expect(markVerdictPathSuggestions([S(`tidy notes (${SIBLING.slice(0, 7)})`)], POOL, SEED)[0]!.verdictPath).toBeUndefined();
    expect(markVerdictPathSuggestions([S(`tidy notes (${SIBLING.slice(0, 7)})`)], POOL, ["quant_stocks_old"])[0]!.verdictPath).toBe(true);
  });

  test("a commit outside every configured path marks nothing", () => {
    expect(markVerdictPathSuggestions([S(`run it (${ACCT.slice(0, 7)})`)], POOL, SEED)[0]!.verdictPath).toBeUndefined();
  });

  test("a rename OUT of a verdict path counts — renamedFrom is part of what the commit touched", () => {
    expect(markVerdictPathSuggestions([S(`check the move (${RENAME.slice(0, 7)})`)], POOL, SEED)[0]!.verdictPath).toBe(true);
  });

  test("resolution is exact: fabricated, ambiguous, sub-7-char and non-commit SHAs all resolve to nothing", () => {
    const out = markVerdictPathSuggestions([
      S("confirm (0d741d8) landed"),                         // one digit off QUANT — fabricated/garbled
      S(`review (${AMBIG_A.slice(0, 7)})`),                  // prefixes TWO commits — cannot tell
      S(`review (${QUANT.slice(0, 6)})`),                    // 6 chars — under the 7-char floor
      S("rebase onto (f00dfac)"),                            // a branch TIP, not a commit
    ], POOL, SEED);
    expect(out.map((s) => s.verdictPath)).toEqual([undefined, undefined, undefined, undefined]);
    // ...and a longer, unambiguous spelling of the ambiguous pair DOES resolve.
    expect(markVerdictPathSuggestions([S(`review ${AMBIG_A.slice(0, 8)}`)], POOL, SEED)[0]!.verdictPath).toBe(true);
  });

  test("JOINED citations resolve (IN-2 review, lens 1 LOW-1): possessive, a/b, a..b, dash, sha:path, x@sha, ellipsis", () => {
    const q = QUANT.slice(0, 7), a = ACCT.slice(0, 7);
    const out = markVerdictPathSuggestions([
      S(`confirm ${q}'s undated-flow rejection holds`),   // day 57's shape — the one real archive miss
      S(`confirm ${q}’s rejection holds`),                 // typographic apostrophe
      S(`compare ${a}/${q}`),
      S(`diff ${a}..${q}`),
      S(`see ${q}—the gate commit`),
      S(`open ${q}:quant_stocks/live/graduation.py`),
      S(`rebase main@${q}`),
      S(`see ${q}…`),
    ], POOL, SEED);
    expect(out.map((s) => s.verdictPath)).toEqual([true, true, true, true, true, true, true, true]);
  });

  test("a hex run GLUED to a letter or digit is not a citation; an upper-case one is", () => {
    const q = QUANT.slice(0, 7);
    const out = markVerdictPathSuggestions([
      S(`describe says v1.2-g${q}`),     // git-describe suffix: glued to `g`
      S(`token x${q}y`),
      S(`id 9${q}`),                     // glued to a digit: a longer run that prefixes nothing
      S(`see ${q.toUpperCase()}`),
    ], POOL, SEED);
    expect(out.map((s) => s.verdictPath)).toEqual([undefined, undefined, undefined, true]);
  });

  test("paths match CASE-INSENSITIVELY, and a configured FILE path matches that file exactly", () => {
    const cite = [S(`wire it (${QUANT.slice(0, 7)})`)];
    expect(markVerdictPathSuggestions(cite, POOL, ["Quant_Stocks"])[0]!.verdictPath).toBe(true);
    expect(markVerdictPathSuggestions(cite, POOL, ["QUANT_STOCKS/LIVE"])[0]!.verdictPath).toBe(true);
    expect(markVerdictPathSuggestions(cite, POOL, ["quant_stocks/live/graduation.py"])[0]!.verdictPath).toBe(true);
    expect(markVerdictPathSuggestions(cite, POOL, ["quant_stocks/live/graduation"])[0]!.verdictPath).toBeUndefined();
  });

  test("adorned and all-digit citations resolve: `backticks`, trailing punctuation, a 4760499-style abbrev", () => {
    const out = markVerdictPathSuggestions([
      S(`see \`${QUANT.slice(0, 7)}\`.`),
      S(`sizing follow-up (introduced in ${DIGITS.slice(0, 7)}).`),
      S(`both: ${ACCT.slice(0, 7)}, ${QUANT.slice(0, 7)}`),   // ANY cited commit under a path marks it
    ], POOL, SEED);
    expect(out.map((s) => s.verdictPath)).toEqual([true, true, true]);
  });
});

// ── (a) RENDER: one extra line under the suggestion; the suggestion line itself is untouched ─────
const MARKED: BriefingStruct = {
  ...base,
  suggestions: [
    { text: `[accountant_ai] Add a test for the booked_twin projection (${ACCT.slice(0, 7)}).` },
    { text: `Wire deflated-edge input into rule 2's graduation gate (${QUANT.slice(0, 7)}).`, verdictPath: true },
    { text: "wiring that input into rule 2", repo: "quant_stocks", promoted: true, verdictPath: true },
  ],
};
const UNMARKED: BriefingStruct = { ...MARKED, suggestions: MARKED.suggestions.map(({ verdictPath: _v, ...s }) => s) };
const markerLines = (out: string) => out.split("\n").filter((l) => l.startsWith(VERDICT_MARKER_PREFIX));

describe("render — annotate, never suppress", () => {
  test("no verdictPath field ⇒ no marker line anywhere (the default-off render)", () => {
    const out = renderBriefing(UNMARKED);
    expect(markerLines(out)).toEqual([]);
    expect(out).not.toContain(VERDICT_MARKER_TEXT);
    expect(out).not.toContain("⚑");
  });

  test("a marked suggestion gets exactly ONE marker line, directly under its own bullet", () => {
    const lines = renderBriefing(MARKED).split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    expect(markerLines(lines.join("\n"))).toHaveLength(2);
    expect(lines[at("graduation gate") + 1]).toBe(`${VERDICT_MARKER_PREFIX}${VERDICT_MARKER_TEXT}`);
    // The promoted one: under its `(from resume)` line, not spliced into it.
    expect(lines[at("wiring that input") ]).toBe("   • [quant_stocks] wiring that input into rule 2  (from resume)");
    expect(lines[at("wiring that input") + 1]).toBe(`${VERDICT_MARKER_PREFIX}${VERDICT_MARKER_TEXT}`);
    // The unmarked neighbour is followed by the next BULLET, not a marker.
    expect(lines[at("booked_twin") + 1]!.startsWith("   • ")).toBe(true);
  });

  test("removing the marker lines gives back the unmarked render BYTE-FOR-BYTE — every other line is untouched", () => {
    expect(markerLines(renderBriefing(MARKED))).toHaveLength(2);   // non-vacuous: there IS something to remove
    const marked = renderBriefing(MARKED).split("\n").filter((l) => !l.startsWith(VERDICT_MARKER_PREFIX)).join("\n");
    expect(marked).toBe(renderBriefing(UNMARKED));
  });
});

// ── (c) THE SHARED PREFIX — writer and excluder are one symbol ───────────────────────────────────
describe("VERDICT_MARKER_PREFIX — one constant, written by render.ts, excluded by audit.coverageGaps", () => {
  test("behavioural seam: the rendered marker line starts with the constant the excluder filters on", () => {
    const lines = markerLines(renderBriefing(MARKED));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l.startsWith(VERDICT_MARKER_PREFIX)).toBe(true);
  });

  test("wiring: both sides IMPORT the shared prefix — neither spells the marker as a literal", async () => {
    // The LEGEND_PREFIX pin's idiom (render.legend.test.ts). With two literals a one-sided re-word
    // compiles, ships, and silently re-admits the marker line to the haystack — nothing fails.
    const audit = await Bun.file(new URL("../src/audit.ts", import.meta.url)).text();
    const render = await Bun.file(new URL("../src/render.ts", import.meta.url)).text();
    expect(render).toMatch(/`\$\{VERDICT_MARKER_PREFIX\}\$\{VERDICT_MARKER_TEXT\}`/);
    for (const src of [audit, render]) {
      expect(src).not.toContain("u2691");   // no escaped flag literal on either side
      expect(src).not.toContain("⚑");  // nor a raw one
    }
    // The excluder: IN the coverageGaps chain, matched as a PREFIX, riding the ONE existing filter.
    const fn = audit.slice(audit.indexOf("export function coverageGaps"));
    const hayChain = fn.slice(fn.indexOf("const hay = briefingText"));
    const chain = hayChain.slice(0, hayChain.indexOf(".toLowerCase();"));
    expect(chain).toMatch(/!l\.startsWith\(VERDICT_MARKER_PREFIX\)/);
    expect(chain.match(/\.filter\(/g) ?? []).toHaveLength(1);
  });

  test("distinct from every other structural prefix, so no excluder or classifier can swallow another's lines", () => {
    const others = [LEGEND_PREFIX, NOT_SHOWN_PREFIX, "   • ", "      ◦ ", "   ⚠ ", '   — you wrote: "'];
    for (const o of others) {
      expect(VERDICT_MARKER_PREFIX.startsWith(o)).toBe(false);
      expect(o.startsWith(VERDICT_MARKER_PREFIX)).toBe(false);
    }
  });

  test("the marker text states what the KEY knows and nothing more — it never classifies the work", () => {
    // IN-2 review, lens 1 MED-1: the first cut ended "— gate-class work, not routine next work", false
    // for 4 of the 6 marks on days 49-64 (add-a-test / run-the-suite), and the line reaches the audit
    // judge's prompt verbatim, where Act is scored. A LITERAL, so any re-wording is a deliberate edit here.
    expect(VERDICT_MARKER_TEXT).toBe("human gate: cites a commit on a configured verdict path");
    expect(VERDICT_MARKER_TEXT).not.toMatch(/gate-class|routine|next work|\bnot\b|verdict change|must|should/i);
  });

  test("the marker body is inert to every OTHER text predicate: no hex run, no parenthesis, no evidence:", () => {
    // coverageGaps is the only audit reader that excludes by prefix; extractCitedShas / missingSameDay
    // read every line. So the body must carry nothing they can mine.
    const line = `${VERDICT_MARKER_PREFIX}${VERDICT_MARKER_TEXT}`;
    expect(line).not.toMatch(/[0-9a-f]{4,}/i);
    expect(line).not.toMatch(/[()]/);
    expect(line).not.toMatch(/evidence:/i);
    expect(extractCitedShas(line)).toEqual([]);
  });
});

// ── THE PRESERVED SIGNAL (the #399 regression shape): no counted flag moves with the marker ──────
describe("preserved signal — the counted deterministic flags are identical with and without the marker", () => {
  // Sub-project labels are folder BASENAMES, so a label can be any word — including a word of the
  // marker's own sentence. These two are exactly that: a repo with working state that the briefing
  // NEVER names, except inside the marker line. It is the legend's #399 hazard in miniature.
  const COLLIDING = [
    { repo: "/w/human", labels: ["human"] },
    { repo: "/w/personal_code", labels: ["personal_code", "verdict"] },
  ];

  test("control (non-vacuity): the marker line really does name both colliding labels", () => {
    const line = `${VERDICT_MARKER_PREFIX}${VERDICT_MARKER_TEXT}`.toLowerCase();
    expect(labelBoundary("human").test(line)).toBe(true);
    expect(labelBoundary("verdict").test(line)).toBe(true);
    // ...and nothing ELSE in the marked briefing does — so any coverage must come from the marker.
    const rest = renderBriefing(MARKED).split("\n").filter((l) => !l.startsWith(VERDICT_MARKER_PREFIX)).join("\n").toLowerCase();
    expect(labelBoundary("human").test(rest)).toBe(false);
    expect(labelBoundary("verdict").test(rest)).toBe(false);
  });

  test("control (the harness can see a leak): the SAME marker line without its prefix clears both gaps", () => {
    // Simulates a writer that drifted off the shared constant: the line is the marker's body with a
    // different indent. If coverageGaps could not tell, the pin below would be vacuous.
    const leaked = renderBriefing(MARKED).split("\n")
      .map((l) => (l.startsWith(VERDICT_MARKER_PREFIX) ? `   ${VERDICT_MARKER_TEXT}` : l)).join("\n");
    expect(coverageGaps(COLLIDING, leaked)).toEqual([]);
  });

  test("UNCOMMITTED NOT SURFACED still fires: both real gaps survive the marker (the #399 pin)", () => {
    expect(markerLines(renderBriefing(MARKED))).toHaveLength(2);   // non-vacuous: the marker IS rendered
    const without = coverageGaps(COLLIDING, renderBriefing(UNMARKED));
    expect(without.map((g) => g.repo)).toEqual(["/w/human", "/w/personal_code"]);
    expect(coverageGaps(COLLIDING, renderBriefing(MARKED))).toEqual(without);
  });

  test("genuine coverage is unchanged: the MARKED suggestion's own line still feeds the haystack", () => {
    // The exclusion is scoped to the added line. A suggestion that names a lane still surfaces it
    // when marked — otherwise switching the marker on would CREATE gaps, the opposite regression.
    const s: BriefingStruct = { ...base, suggestions: [{ text: `[zqlane] wire the gate input (${QUANT.slice(0, 7)})`, verdictPath: true }] };
    const zq = [{ repo: "/w/zq", labels: ["zqlane"] }];
    expect(coverageGaps(zq, renderBriefing(s))).toEqual([]);
    expect(coverageGaps(zq, renderBriefing({ ...s, suggestions: [{ ...s.suggestions[0]!, verdictPath: undefined }] }))).toEqual([]);
  });

  test("every other text-mined signal is byte-for-byte the same: cited SHAs, same-day misses, branch lines, stamp, quotations", () => {
    const rich: BriefingStruct = {
      ...MARKED, stateAsOf: "07:22", morningFloor: "07:20",
      branchState: [{ repo: "quant_stocks", text: "On branch feat/rule2 (ahead 2, behind 0)" }],
      whys: { quant_stocks: "finish the graduation gate" },
      resume: [{ repo: "quant_stocks", text: "resume the rule-2 wiring" }],
      recap: [{ repo: "quant_stocks", text: "gate refuses without input", evidence: QUANT.slice(0, 7) }],
    };
    const richUnmarked: BriefingStruct = { ...rich, suggestions: UNMARKED.suggestions };
    const tM = renderBriefing(rich), tU = renderBriefing(richUnmarked);
    expect(markerLines(tM)).toHaveLength(2);   // sanity: the marker is really there
    const dayShas = [QUANT, ACCT, DIGITS, "1234567890abcdef1234567890abcdef12345678"];
    expect(extractCitedShas(tM).sort()).toEqual(extractCitedShas(tU).sort());
    expect(missingSameDay(dayShas, tM)).toEqual(missingSameDay(dayShas, tU));
    expect([...branchLinesFromBriefing(tM)]).toEqual([...branchLinesFromBriefing(tU)]);
    expect(generationInstant(tM, "2026-09-06")).toBe(generationInstant(tU, "2026-09-06"));
    expect(quotationsIn(tM, parseWhy)).toEqual(quotationsIn(tU, parseWhy));
  });
});

// ── END-TO-END through runCore: config → git diffstat → struct → render ──────────────────────────
const yesterdayNoon = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - 1); return d.toISOString(); };
const mkCfg = (repos: string[], extra: Partial<Config> = {}): Config => ({
  repos, excludeCommitPatterns: [], lookbackCapDays: 30,
  provider: { cli: "echo", argv: [], promptVia: "stdin" }, ...extra,
});

describe("end-to-end (runCore) — the key reads the real git diffstat", () => {
  const fixture = async () => {
    const dir = await buildRepo([{ file: "README.md", content: "x", isoDate: yesterdayNoon() }]);
    const quant = await commitFiles(dir, ["quant_stocks/live/graduation.py"], { message: "feat: rule 2 gate refuses without input", isoDate: yesterdayNoon() });
    const acct = await commitFiles(dir, ["accountant_ai/core/match_read.py"], { message: "feat: five-key select", isoDate: yesterdayNoon() });
    const stub = { generate: async () => [
      "## RESUME", "- [quant_stocks] rule 2 gate is half-wired",
      "## RECAP", `- [quant_stocks] gate refuses | evidence: ${quant.slice(0, 7)}`, `- [accountant_ai] select | evidence: ${acct.slice(0, 7)}`,
      "## SUGGESTIONS",
      `- Add a test for the booked_twin projection (${acct.slice(0, 7)}).`,
      `- Wire deflated-edge input into rule 2's graduation gate (${quant.slice(0, 7)}).`,
    ].join("\n") };
    return { dir, stub };
  };

  test("key UNSET (default): no suggestion carries the field and the briefing has no marker line", async () => {
    const { dir, stub } = await fixture();
    const r = await runCore(mkCfg([dir]), { provider: stub, netProbe: async () => true });
    expect(r.struct.suggestions).toHaveLength(2);
    for (const s of r.struct.suggestions) expect("verdictPath" in s).toBe(false);
    const out = renderBriefing(r.struct);
    expect(markerLines(out)).toEqual([]);
    expect(out).not.toContain(VERDICT_MARKER_TEXT);
  });

  test("key SET: only the suggestion citing the quant_stocks commit is marked, and nothing is dropped", async () => {
    const { dir, stub } = await fixture();
    const r = await runCore(mkCfg([dir], { verdictPaths: ["quant_stocks/", "quant_options/"] }), { provider: stub, netProbe: async () => true });
    expect(r.struct.suggestions.map((s) => s.verdictPath)).toEqual([undefined, true]);
    const lines = renderBriefing(r.struct).split("\n");
    const i = lines.findIndex((l) => l.includes("graduation gate"));
    expect(lines[i + 1]).toBe(`${VERDICT_MARKER_PREFIX}${VERDICT_MARKER_TEXT}`);
    expect(markerLines(lines.join("\n"))).toHaveLength(1);
  });

  test("PROMPT BYTES ARE UNTOUCHED: the marker is post-generation, so the frozen prompt format (and echo.ts' parse of it) cannot move", async () => {
    // The design appendix's echo-parseability constraint is about PROMPT bytes — `eval/echo.ts` parses
    // buildPrompt's body, and every eval case pins its promptText. Same repo, key off vs on.
    const { dir, stub } = await fixture();
    const off = await runCore(mkCfg([dir]), { provider: stub, netProbe: async () => true });
    const on = await runCore(mkCfg([dir], { verdictPaths: ["quant_stocks/"] }), { provider: stub, netProbe: async () => true });
    expect(on.struct.suggestions.some((s) => s.verdictPath)).toBe(true);   // sanity: the marker really is on
    expect(on.promptText).toBe(off.promptText);
    expect(on.rawText).toBe(off.rawText);
  });

  test("the pool is window + TODAY, minus bot-excluded commits: a same-day quant commit marks, an excluded one never does", async () => {
    // IN-2 review, lens 3 mutants b/c: both populations were unpinned.
    const dir = await buildRepo([{ file: "README.md", content: "x", isoDate: yesterdayNoon() }]);
    const acct = await commitFiles(dir, ["accountant_ai/core/match_read.py"], { message: "feat: five-key select", isoDate: yesterdayNoon() });
    const bot = await commitFiles(dir, ["quant_stocks/STATE.md"], { message: "vault backup: nightly", isoDate: yesterdayNoon() });
    const now = new Date(), midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
    const todayIso = new Date(Math.max(midnight.getTime() + 1000, now.getTime() - 5000)).toISOString();
    const today = await commitFiles(dir, ["quant_options/sizing.py"], { message: "feat: position cap", isoDate: todayIso });
    const stub = { generate: async () => [
      "## RESUME", "- [accountant_ai] select is in",
      "## RECAP", `- [accountant_ai] select | evidence: ${acct.slice(0, 7)}`,
      "## SUGGESTIONS",
      `- Review what landed first thing (${today.slice(0, 7)}).`,
      `- Look at the nightly backup (${bot.slice(0, 7)}).`,
    ].join("\n") };
    const r = await runCore(mkCfg([dir], { excludeCommitPatterns: ["^vault backup:"], verdictPaths: ["quant_stocks/", "quant_options/"] }),
      { provider: stub, netProbe: async () => true });
    expect(r.struct.suggestions.map((s) => s.text.slice(0, 12))).toEqual(["Review what ", "Look at the "]);
    expect(r.struct.suggestions.map((s) => s.verdictPath)).toEqual([true, undefined]);
  });

  test("key MALFORMED on an EMPTY window: the provider is skipped and the warning still reaches the struct", async () => {
    // core.ts resolves the key before the empty-window return for exactly this; the first cut left it unpinned.
    const provider = { generate: async (): Promise<string> => { throw new Error("must not be called"); } };
    const r = await runCore(mkCfg([], { verdictPaths: ["quant_stocks/**"] }), { provider, netProbe: async () => true });
    expect(r.emptyWindow).toBe(true);
    expect(r.struct.warnings ?? []).toContain('config: "verdictPaths" must be an array of literal repo-relative directory paths, no globs — verdict-path marker disabled');
  });

  test("key MALFORMED: nothing is marked, the briefing still delivers, and it says why", async () => {
    const { dir, stub } = await fixture();
    const r = await runCore(mkCfg([dir], { verdictPaths: "quant_stocks/" as unknown as string[] }), { provider: stub, netProbe: async () => true });
    expect(r.struct.suggestions.every((s) => s.verdictPath === undefined)).toBe(true);
    expect((r.struct.warnings ?? []).some((w) => w.includes('"verdictPaths"'))).toBe(true);
  });
});
