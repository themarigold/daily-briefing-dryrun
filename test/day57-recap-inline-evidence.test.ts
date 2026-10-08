// test/day57-recap-inline-evidence.test.ts — day 57: the recap read "0 of 8" over a recap citing all 8.
//
// The prompt asks for `- [<repo>] <claim> | evidence: <SHA>`. On 2026-09-02 and 2026-09-11 the model
// dropped the pipe and wrote `<claim> (Sep 9). evidence: 0a9a30b`; the pipe split found nothing, the
// SHA stayed in the bullet text, no bullet resolved to a commit, coverage read "0 of N", and
// clusterRecap (which keys on `evidence`) could not act. Lines below are short hand-written stand-ins
// modelled on those mornings — no archive text is copied.
import "./fixtures/isolate-state";
import { test, expect } from "bun:test";
import { parseBriefing, splitRecapEvidence, generateBriefing, countPipelessRecapEvidence } from "../src/generator";
import { runCore } from "../src/core";
import { renderBriefing } from "../src/render";
import { buildRepo } from "./fixtures/build-repo";
import { unstamp } from "./helpers/unstamp";
import type { Config } from "../src/types";
import type { ReducedContext, Activity, Provider } from "../src/types";
import type { Unit } from "../src/subprojects";

const META = { date: "2026-09-11", machineScope: "host", provider: "fake" };
const recapOf = (...lines: string[]) =>
  parseBriefing(`## RESUME\n- [r] x\n## RECAP\n${lines.map((l) => `- ${l}`).join("\n")}\n## SUGGESTIONS\n- s`, META).recap;

test("pipe-less trailing form: evidence is split out of the text", () => {
  const [r] = recapOf("[quant_stocks] STATE.md only — marks batch complete (Sep 9). evidence: 249e47e");
  expect(r).toEqual({ repo: "quant_stocks", text: "STATE.md only — marks batch complete (Sep 9).", evidence: "249e47e" });
});

test("pipe-less trailing form accepts a comma list of SHA-shaped tokens and trailing punctuation", () => {
  expect(splitRecapEvidence("did two things. evidence: 0a9a30b, 924ff90")).toEqual({ text: "did two things.", evidence: "0a9a30b, 924ff90" });
  expect(splitRecapEvidence("did it. Evidence: `ffbe3a5`.")).toEqual({ text: "did it.", evidence: "`ffbe3a5`." });
});

test("pipe-less trailing form accepts an all-digit abbreviated SHA, but not a year or PR number", () => {
  // git abbreviates to all digits ~4% of the time; the 2026-09-02 shape had two of them in 40 bullets
  expect(splitRecapEvidence("verdict machinery added (Sep 1). evidence: 8426643")).toEqual({ text: "verdict machinery added (Sep 1).", evidence: "8426643" });
  expect(splitRecapEvidence("shipped in evidence: 2026")).toEqual({ text: "shipped in evidence: 2026", evidence: undefined });
  expect(splitRecapEvidence("merged, evidence: 528")).toEqual({ text: "merged, evidence: 528", evidence: undefined });
});

test("the pipe form parses exactly as before (text, evidence, key order)", () => {
  const [r] = recapOf("[app] fixed parser (Sep 9) | evidence: 0a9a30b (src/generator.ts)");
  expect(r).toEqual({ repo: "app", text: "fixed parser (Sep 9)", evidence: "0a9a30b (src/generator.ts)" });
  expect(Object.keys(r!)).toEqual(["repo", "text", "evidence"]);
  // a pipe line that also mentions evidence: in prose keeps the pipe split's answer
  expect(splitRecapEvidence("the evidence: 0a9a30b was wrong | evidence: 924ff90"))
    .toEqual({ text: "the evidence: 0a9a30b was wrong", evidence: "924ff90" });
});

test("prose after evidence: is never eaten", () => {
  const line = "judge disagreed; evidence: the log shows 0a9a30b ran twice (Sep 9)";
  expect(splitRecapEvidence(line)).toEqual({ text: line, evidence: undefined });
  expect(splitRecapEvidence("new evidence: added")).toEqual({ text: "new evidence: added", evidence: undefined });
  // `evidence:` must stand as a word — not a suffix of another token
  expect(splitRecapEvidence("see counterevidence: 0a9a30b")).toEqual({ text: "see counterevidence: 0a9a30b", evidence: undefined });
  // an empty tail is not evidence
  expect(splitRecapEvidence("ends with evidence:")).toEqual({ text: "ends with evidence:", evidence: undefined });
});

test("pipe-less: with two evidence: occurrences the LAST one is the split (review round 1, L1)", () => {
  // Splitting on the FIRST would test "0a9a30b was wrong (Sep 9). evidence: 924ff90" as the tail, and
  // prose fails the gate — the line would stay unsplit.
  expect(splitRecapEvidence("the old evidence: 0a9a30b was wrong (Sep 9). evidence: 924ff90"))
    .toEqual({ text: "the old evidence: 0a9a30b was wrong (Sep 9).", evidence: "924ff90" });
});

test("pipe-less: an evidence-only bullet keeps its literal text — no empty claim (review round 1, L3)", () => {
  const [r] = recapOf("[r] evidence: 0a9a30b");
  expect(r).toEqual({ repo: "r", text: "evidence: 0a9a30b", evidence: undefined });
  expect(splitRecapEvidence("  evidence: 0a9a30b")).toEqual({ text: "evidence: 0a9a30b", evidence: undefined });
});

test("countPipelessRecapEvidence counts only the bullets the fallback recovered", () => {
  const doc = (...recap: string[]) => `## RESUME\n- [r] x\n## RECAP\n${recap.map((l) => `- ${l}`).join("\n")}\n## SUGGESTIONS\n- s`;
  expect(countPipelessRecapEvidence(doc("[r] a (Sep 9). evidence: 0a9a30b", "[r] b | evidence: 924ff90",
    "[r] evidence: 999a78b", "[r] new evidence: added"))).toEqual({ recovered: 1, total: 4 });
  expect(countPipelessRecapEvidence(doc("[r] b | evidence: 924ff90"))).toEqual({ recovered: 0, total: 1 });
  expect(countPipelessRecapEvidence("")).toEqual({ recovered: 0, total: 0 });
});

// ── End to end through generateBriefing: coverage and clustering act on the fixed bullets ────────
const d = "2026-09-09T10:00:00-07:00";
const commit = (sha: string, file: string): Activity => ({
  source: "git", kind: "commit", event_id: sha, repo: "/r", timestamp: d, text: `c-${sha}`,
  meta: { diffstat: [{ file, added: 5, removed: 1 }] },
});
const ctx: ReducedContext = { repos: [{ repo: "/r", summary: "s", activities: [
  commit("0a9a30b1111", "quant_stocks/core/risk_gate.py"),
  commit("924ff902222", "quant_stocks/core/risk_gate.py"),
  commit("999a78b3333", "quant_stocks/live/prices.py"),
] }] };
const UNITS: Unit[] = [{ repo: "/r", root: "quant_stocks", label: "quant_stocks", hasResumptionState: false,
  hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null }];
const MODEL = [
  "## RESUME", "- [quant_stocks] x", "## RECAP",
  "- [quant_stocks] risk_gate.py: bounded predicate added (Sep 9). evidence: 0a9a30b",
  "- [quant_stocks] risk_gate.py: ladder stops diverging (Sep 9). evidence: 924ff90",
  "- [quant_stocks] prices.py: sigma reads raw (Sep 9). evidence: 999a78b",
  "## SUGGESTIONS", "- s",
].join("\n");

test("coverage counts the pipe-less bullets (the day-57 '0 of N' header is gone)", async () => {
  const fake: Provider = { generate: async () => MODEL };
  const b = await generateBriefing(ctx, fake, META, UNITS);
  expect(b.recap.map((r) => r.evidence)).toEqual(["0a9a30b", "924ff90", "999a78b"]);
  // Complete coverage is ABSENT by contract (day 49) — before the fix this was {shown: 0, total: 3}.
  expect(b.recapCoverage).toBeUndefined();
});

test("clusterRecap acts on the pipe-less bullets", async () => {
  const fake: Provider = { generate: async () => MODEL };
  const b = await generateBriefing(ctx, fake, META, UNITS);
  expect(b.recap[0]!.group).toBeDefined();
  expect(b.recap[0]!.group).toContain("risk_gate.py");
  expect(b.recap[1]!.group).toBe(b.recap[0]!.group);
  expect(b.recap[2]!.group).toBeUndefined();
});

// ── The format-drift line (review round 1, L4): log-only, one per briefing, never on the page ─────
const yesterdayNoon = () => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() - 1); return t.toISOString(); };
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.error = real; }
  return lines;
}
async function headSha(dir: string): Promise<string> {
  const p = Bun.spawn(["git", "rev-parse", "--short=7", "HEAD"], { cwd: dir, stdout: "pipe" });
  await p.exited;
  return (await new Response(p.stdout).text()).trim();
}

test("runCore logs ONE parse-info line when the fallback fires, none for the pipe form, and the page is unchanged", async () => {
  const dir = await buildRepo([{ file: "a.ts", content: "x", isoDate: yesterdayNoon() }]);
  const sha = await headSha(dir);
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
  const pipeless = await run(`[x] did it (Sep 9). evidence: ${sha}`);
  const pipe = await run(`[x] did it (Sep 9). | evidence: ${sha}`);

  expect(pipeless.lines).toEqual([
    `parse-info [recap-evidence-pipeless]: 1 of 1 recap bullet(s) cited evidence without the prompt's "| evidence:" pipe; recovered by the trailing-form fallback`,
  ]);
  expect(pipe.lines).toEqual([]);
  // The premise: both forms really parsed to the same cited bullet.
  expect(pipeless.struct.recap.map((r) => [r.text, r.evidence])).toEqual([["did it (Sep 9).", sha]]);
  // Log-only: nothing reaches the delivered page — no warning, and the render is byte-identical to the
  // pipe form's, which emits no line at all.
  expect(JSON.stringify(pipeless.struct.warnings ?? [])).not.toContain("parse-info");
  // Two runs, so the real-clock `state as of HH:MM` stamp is normalised (see `unstamp`).
  expect(unstamp(renderBriefing(pipeless.struct))).toBe(unstamp(renderBriefing(pipe.struct)));
  expect(renderBriefing(pipeless.struct)).not.toContain("pipe");
});
