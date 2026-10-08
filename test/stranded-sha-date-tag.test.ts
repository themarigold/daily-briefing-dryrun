// test/stranded-sha-date-tag.test.ts — the date-tagged pipe-less RECAP tail.
//
// The prompt asks for `- [<repo>] <claim> | evidence: <SHA>`. In a 2026-10-06 `day8-tie` eval capture the
// model dropped the pipe AND wrote the prompt's own date format after the SHA: `… — evidence: 36c4738
// (Oct 5)`. The day-57 pipe-less fallback refused that tail (`Oct` and `5` cannot name a commit), so the
// SHA stayed in the bullet text and the bullet read as uncited. `trailingEvidence` now accepts a tail that
// ENDS in one `(Mon D)` tag when the rest of the tail is one contiguous hex run of 7–40 characters, after
// `bareToken` alone, that passes `isShaShaped`, and keeps the whole tail verbatim as evidence, exactly as
// the pipe form keeps it. Everything else stays in the text, as before.
//
// The fixture holds that capture's three failing bullet texts (synthetic eval-repo text, label stripped).
// Every other line here is a short hand-written stand-in.
import "./fixtures/isolate-state";
import { describe, test, expect } from "bun:test";
import { parseBriefing, splitRecapEvidence, countPipelessRecapEvidence, generateBriefing } from "../src/generator";
import { runCore } from "../src/core";
import { renderBriefing } from "../src/render";
import { NOT_SHOWN_PREFIX } from "../src/subprojects";
import { buildRepo } from "./fixtures/build-repo";
import type { Activity, Config, Provider, ReducedContext } from "../src/types";
import type { Unit } from "../src/subprojects";
import fx from "./fixtures/stranded-sha/day8-tie-date-tagged.json";

const META = { date: "2026-10-06", machineScope: "host", provider: "fake" };
const doc = (...recap: string[]) =>
  `## RESUME\n- [r] x\n## RECAP\n${recap.map((l) => `- ${l}`).join("\n")}\n## SUGGESTIONS\n- s`;
const recapOf = (...lines: string[]) => parseBriefing(doc(...lines), META).recap;
const SEP = " evidence: ";
/** The piped twin: the text's final ` evidence: ` becomes ` | evidence: `. */
const piped = (t: string): string => {
  const i = t.lastIndexOf(SEP);
  return `${t.slice(0, i)} | evidence: ${t.slice(i + SEP.length)}`;
};

describe("unit", () => {
  // ── The captured shape ──────────────────────────────────────────────────────────────────────────
  test("the fixture holds the three captured texts, each with one ` evidence: ` and the same tagged SHA", () => {
    expect(fx.length).toBe(3);
    for (const t of fx) {
      expect(t.split(SEP).length).toBe(2);
      expect(t.endsWith(" — evidence: 36c4738 (Oct 5)")).toBe(true);
    }
  });

  for (const [i, t] of fx.entries()) {
    test(`captured text ${i + 1} splits: evidence "36c4738 (Oct 5)", claim byte-equal to its piped twin's, dangling dash kept`, () => {
      const got = splitRecapEvidence(t);
      const twin = splitRecapEvidence(piped(t));
      expect(got.evidence).toBe("36c4738 (Oct 5)");
      expect(twin.evidence).toBe("36c4738 (Oct 5)");
      expect(got.text).toBe(twin.text);
      // whitespace-trimmed only: the claim is everything before ` evidence: `, the separator dash included
      expect(got.text).toBe(t.slice(0, t.lastIndexOf(SEP)));
      expect(got.text.endsWith(" —")).toBe(true);
      // the same split through parseBriefing, label stripped by repoOf
      expect(recapOf(`[repo] ${t}`)).toEqual([{ repo: "repo", text: got.text, evidence: "36c4738 (Oct 5)" }]);
    });
  }

  // The SPLIT table's row for a period after the tag pins the ` — ` claim form; this keeps the
  // sentence-period claim form (`did it.`), which the table does not build.
  test("a period after the tag is kept in evidence, as the piped form keeps it", () => {
    expect(splitRecapEvidence("did it. evidence: d08ee51 (Oct 4).")).toEqual({ text: "did it.", evidence: "d08ee51 (Oct 4)." });
    expect(splitRecapEvidence("did it. | evidence: d08ee51 (Oct 4).")).toEqual({ text: "did it.", evidence: "d08ee51 (Oct 4)." });
  });

  // ── Refused: the tail stays in the text, and the counter does not count it ─────────────────────
  const REFUSED: [string, string][] = [
    ["a non-date parenthetical", "d08ee51 (see log)"],
    ["a four-letter month", "d08ee51 (Sept 4)"],
    ["a lowercase month (the tag is case-sensitive)", "d08ee51 (oct 4)"],
    ["a tag carrying a year", "d08ee51 (Oct 4, 2026)"],
    ["an ISO date", "d08ee51 (2026-10-04)"],
    ["a tag glued to the SHA (whitespace before the tag is required)", "d08ee51(Oct 4)"],
    ["two SHAs before the tag (one token only)", "abc1234, def5678 (Oct 5)"],
    ["a 4-character SHA (the 7-character floor)", "d08e (Oct 4)"],
    ["a parenthesis inside the token (never read as abc1234)", "abc(1234) (Oct 5)"],
    ["two SHAs joined by parentheses", "abc1234(def5678) (Oct 5)"],
    ["a parenthesised SHA (bareToken strips no parenthesis)", "(abc1234) (Oct 5)"],
    ["prose before the SHA", "the log shows d08ee51"],
    ["an adorned 4-character SHA (the length is read on the bare form)", "**d08e** (Oct 4)"],
    ["a 6-character SHA (the floor's boundary)", "d08ee5 (Oct 4)"],
    ["an adorned 6-character SHA (6 on the bare form, not 9)", "`d08ee5`. (Oct 4)"],
    ["punctuation after the tag (the tag must end the tail)", "abc1234 (Oct 5);"],
    ["an all-digit SHA (not isShaShaped)", "4760499 (Oct 4)"],
    ["two date tags (one tag only)", "36c4738 (Oct 4) (Oct 5)"],
    ["a date tag followed by more words (the tag must end the tail)", "36c4738 (Oct 4) and more"],
    // Rejected twice over: the branch's own `{7,40}` and `isShaShaped`'s 40-character `SHA_RE` ceiling
    // each refuse it alone, so this row pins the ceiling, not which of the two enforces it.
    ["a 41-character hex run (one past the 40-character ceiling)", `${"36c4738a".repeat(5)}b (Oct 5)`],
    ["a three-digit day (the day is at most two digits)", "d08ee51 (Oct 123)"],
  ];
  for (const [name, tail] of REFUSED) {
    test(`refused: ${name} — "evidence: ${tail}" stays in the text`, () => {
      const t = `did it — evidence: ${tail}`;
      expect(splitRecapEvidence(t)).toEqual({ text: t, evidence: undefined });
      expect(countPipelessRecapEvidence(doc(`[r] ${t}`))).toEqual({ recovered: 0, total: 1 });
    });
  }

  // ── Split: the ORIGINAL tail is the evidence, identical to the piped twin's ────────────────────
  const SPLIT: [string, string][] = [
    ["a backticked SHA (bareToken strips the adornments for the test only)", "`d08ee51` (Oct 4)"],
    ["a SHA longer than 7 characters", "36c4738a1b2c (Oct 5)"],
    ["an uppercase SHA (isShaShaped is case-insensitive)", "D08EE51 (Oct 4)"],
    ["a comma after the SHA (trailing punctuation bareToken strips)", "abc1234, (Oct 5)"],
    ["a period after the tag (kept in evidence, as the piped form keeps it)", "d08ee51 (Oct 4)."],
    ["a 40-character SHA (the 40-character ceiling)", `${"36c4738a".repeat(5)} (Oct 5)`],
    ["a month other than Oct and a two-digit day (every month, a day of up to two digits)", "d08ee51 (Jan 10)"],
    ["the last month, the largest day and a period after the tag", "d08ee51 (Dec 31)."],
  ];
  for (const [name, tail] of SPLIT) {
    test(`splits with the tail verbatim: ${name} — "evidence: ${tail}"`, () => {
      const t = `did it — evidence: ${tail}`;
      expect(splitRecapEvidence(t)).toEqual({ text: "did it —", evidence: tail });
      expect(splitRecapEvidence(piped(t))).toEqual({ text: "did it —", evidence: tail });
      expect(countPipelessRecapEvidence(doc(`[r] ${t}`))).toEqual({ recovered: 1, total: 1 });
    });
  }

  // ── The plain pipe-less fallback (no tag) is unchanged ──────────────────────────────────────────
  test("plain fallback unchanged: an untagged two-SHA tail still splits", () => {
    expect(splitRecapEvidence("did two. evidence: abc1234, def5678")).toEqual({ text: "did two.", evidence: "abc1234, def5678" });
  });

  test("plain fallback unchanged: an untagged all-digit SHA still splits", () => {
    expect(splitRecapEvidence("did it. evidence: 4760499")).toEqual({ text: "did it.", evidence: "4760499" });
  });

  test("plain fallback unchanged: an untagged `abc(1234)` keeps its pre-existing behaviour (splits)", () => {
    // PRE-EXISTING behaviour of the plain fallback, not of the date-tag rule: `evidenceTokens` deletes the
    // parentheses inside the token and reads `abc1234`, so this untagged tail splits today, and the
    // downstream readers read `abc1234` too. It is a known residual, left as it is. The date-tag branch
    // does not inherit it (`abc(1234) (Oct 5)` is refused above). If the plain fallback is ever tightened,
    // this expectation changes on purpose; that is not a regression of the date-tag rule.
    expect(splitRecapEvidence("did it. evidence: abc(1234)")).toEqual({ text: "did it.", evidence: "abc(1234)" });
  });

  // ── Literal text: no claim, no split (the claim guard runs before the date-tag branch) ─────────
  test("literal text: an evidence-only tail with a date tag is not split (direct call, no claim)", () => {
    expect(splitRecapEvidence("evidence: d08ee51 (Oct 4)")).toEqual({ text: "evidence: d08ee51 (Oct 4)", evidence: undefined });
  });

  test("literal text: a labelled evidence-only bullet with a date tag is not split through parseBriefing", () => {
    // Through parseBriefing, where repoOf strips the label first. A direct call on the labelled string
    // would have the claim `[r]` and split, so the case is pinned on the path the product takes.
    expect(recapOf("[r] evidence: d08ee51 (Oct 4)")).toEqual([{ repo: "r", text: "evidence: d08ee51 (Oct 4)", evidence: undefined }]);
  });

  // ── The telemetry counter reads the same branch ─────────────────────────────────────────────────
  test("countPipelessRecapEvidence counts a date-tagged recovery (the branch lives in trailingEvidence)", () => {
    expect(countPipelessRecapEvidence(doc("[r] a — evidence: 36c4738 (Oct 5)"))).toEqual({ recovered: 1, total: 1 });
  });
});

// ── Integration: through generateBriefing and runCore, each with a fake provider ─────────────────────
// A fixed `ctx` of three commits with full 40-character ids, so a 7-character cite is a PREFIX of the id
// and prefix semantics are the real ones. Every id carries a letter; the first two touch the same file,
// so a bullet citing each can cluster.
const AT = "2026-10-05T10:00:00-07:00";
const full = (prefix: string): string => (prefix + "0123456789abcdef0123456789abcdef01234567").slice(0, 40);
const commit = (sha: string, file: string): Activity => ({
  source: "git", kind: "commit", event_id: full(sha), repo: "/r", timestamp: AT, text: `c-${sha}`,
  meta: { diffstat: [{ file, added: 5, removed: 1 }] },
});
const CTX: ReducedContext = { repos: [{ repo: "/r", summary: "s", activities: [
  commit("36c4738", "src/a.ts"),
  commit("d08ee51", "src/a.ts"),
  commit("abc1234", "src/b.ts"),
] }] };
const UNITS: Unit[] = [{ repo: "/r", root: null, label: "repo", hasResumptionState: false,
  hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null }];
/** generateBriefing over a fake provider whose RECAP is exactly `recap`. */
const brief = (...recap: string[]) => {
  const provider: Provider = { generate: async () => doc(...recap) };
  return generateBriefing(CTX, provider, META, UNITS);
};

// The runCore harness: these two helpers are copied once from test/day57-recap-inline-evidence.test.ts,
// which is not edited and exports nothing.
const yesterdayNoon = () => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - 1); return t.toISOString(); };
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.error = real; }
  return lines;
}

describe("integration", () => {
  test("a garbled date-tagged SHA is split, then dropped by verifyEvidence: evidence `Oct, 5` and the didn't-resolve warning, as its piped twin", async () => {
    // The stated residual: `deadbe7` is hex with a letter and resolves to nothing in CTX, so the split
    // hands it to the grounding guard, which drops it and keeps the tag's other tokens.
    const t = "[repo] did it — evidence: deadbe7 (Oct 5)";
    const b = await brief(t);
    expect(b.recap.map((r) => [r.repo, r.text, r.evidence])).toEqual([["repo", "did it —", "Oct, 5"]]);
    expect(b.warnings).toEqual(["1 cited SHA(s) didn't resolve to a real commit and were removed: deadbe7"]);
    const twin = await brief(piped(t));
    expect(b.recap).toEqual(twin.recap);
    expect(b.warnings).toEqual(twin.warnings);
  });

  const KEPT: [string, string][] = [
    ["an all-digit garble (not isShaShaped)", "0000000 (Oct 5)"],
    ["a non-hex token", "zzzzzzz (Oct 5)"],
  ];
  for (const [name, tail] of KEPT) {
    test(`${name}: "evidence: ${tail}" stays in the text, with no warning`, async () => {
      const b = await brief(`[repo] did it — evidence: ${tail}`);
      expect(b.recap.map((r) => [r.repo, r.text, r.evidence])).toEqual([["repo", `did it — evidence: ${tail}`, undefined]]);
      expect(b.warnings ?? []).toEqual([]);
    });
  }

  test("scope guard: a bullet opening with a bare SHA and carrying no `evidence:` stays in the text, with no warning", async () => {
    const b = await brief("[repo] abc1234 — Fixed the join");
    expect(b.recap.map((r) => [r.repo, r.text, r.evidence])).toEqual([["repo", "abc1234 — Fixed the join", undefined]]);
    expect(b.warnings ?? []).toEqual([]);
  });

  test("a mixed recap (piped, pipe-less, date-tagged, uncited) parses each bullet as specified", async () => {
    const b = await brief(
      "[repo] Piped fix | evidence: d08ee51",
      "[repo] Plain fix. evidence: abc1234",
      "[repo] Tagged fix — evidence: 36c4738 (Oct 5)",
      "[repo] Uncited tidy",
    );
    expect(b.recap.map((r) => [r.repo, r.text, r.evidence])).toEqual([
      ["repo", "Piped fix", "d08ee51"],
      ["repo", "Plain fix.", "abc1234"],
      ["repo", "Tagged fix —", "36c4738 (Oct 5)"],
      ["repo", "Uncited tidy", undefined],
    ]);
    expect(b.warnings ?? []).toEqual([]);
    // All three in-window commits are cited, so coverage is complete, which is ABSENT by contract.
    expect(b.recapCoverage).toBeUndefined();
  });

  test("a date-tagged recovered bullet counts as coverage: no \"not shown\" line for its commit", async () => {
    const t = "[repo] Tagged fix — evidence: 36c4738 (Oct 5)";
    const b = await brief(t);
    expect(b.recap.map((r) => r.evidence)).toEqual(["36c4738 (Oct 5)"]);
    expect(b.recapCoverage).toEqual({ shown: 1, total: 3, notShown: [
      { label: "repo", sha: "d08ee51", subject: "c-d08ee51" },
      { label: "repo", sha: "abc1234", subject: "c-abc1234" },
    ] });
    const page = renderBriefing(b);
    // The two uncited commits are still reported, so the line format below is the one render prints.
    expect(page).toContain(`${NOT_SHOWN_PREFIX}[repo] d08ee51 c-d08ee51`);
    expect(page).toContain(`${NOT_SHOWN_PREFIX}[repo] abc1234 c-abc1234`);
    expect(page).not.toContain(`${NOT_SHOWN_PREFIX}[repo] 36c4738`);
    // Exactly the coverage its piped twin earns.
    expect(b.recapCoverage).toEqual((await brief(piped(t))).recapCoverage);
  });

  test("date-tagged recovered bullets cluster exactly as their piped twins", async () => {
    const lines = [
      "[repo] a.ts: first change — evidence: 36c4738 (Oct 5)",
      "[repo] a.ts: second change — evidence: d08ee51 (Oct 5)",
      "[repo] b.ts: other change — evidence: abc1234 (Oct 5)",
    ];
    const tagged = await brief(...lines);
    const twin = await brief(...lines.map(piped));
    expect(tagged.recap[0]!.group).toBeDefined();
    expect(tagged.recap[0]!.group).toContain("src/a.ts");
    expect(tagged.recap[1]!.group).toBe(tagged.recap[0]!.group);
    expect(tagged.recap[2]!.group).toBeUndefined();
    expect(tagged.recap).toEqual(twin.recap);
  });

  test("runCore logs ONE parse-info line for a date-tagged pipe-less bullet, none for its piped twin, and the page is unchanged", async () => {
    const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
    const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30,
      provider: { cli: "echo", argv: [], promptVia: "stdin" } };
    const run = async (recapLine: string) => {
      let result: Awaited<ReturnType<typeof runCore>> | undefined;
      const lines = await captureStderr(async () => {
        result = await runCore(cfg, { provider: { generate: async () =>
          `## RESUME\n- [x] resume\n## RECAP\n- ${recapLine}\n## SUGGESTIONS\n- s` }, netProbe: async () => true });
      });
      return { lines: lines.filter((l) => l.startsWith("parse-info")), struct: result!.struct };
    };
    // A FIXED SHA with a letter, never the repo's head: that repo is rebuilt on every run and its
    // 7-character abbreviation is all digits on about one day in 27, which the date-tag branch refuses
    // by design. The counter reads raw text and never resolves; `deadbe7` resolves to nothing here, so
    // verifyEvidence drops it in both runs, and the two runs are compared with each other only.
    const line = "[x] did it (Sep 9). evidence: deadbe7 (Oct 5)";
    const pipeless = await run(line);
    const pipe = await run(piped(line));

    expect(pipeless.lines).toEqual([
      `parse-info [recap-evidence-pipeless]: 1 of 1 recap bullet(s) cited evidence without the prompt's "| evidence:" pipe; recovered by the trailing-form fallback`,
    ]);
    expect(pipe.lines).toEqual([]);
    // Log-only: nothing reaches the delivered page, and both runs parse and render identically.
    expect(JSON.stringify(pipeless.struct.warnings ?? [])).not.toContain("parse-info");
    expect(pipeless.struct.recap).toEqual(pipe.struct.recap);
    // The two runs read the wall clock separately, so pin its stamps (date, state-as-of HH:MM) to one run's.
    expect(renderBriefing({ ...pipeless.struct, date: pipe.struct.date, stateAsOf: pipe.struct.stateAsOf }))
      .toBe(renderBriefing(pipe.struct));
  });
});
