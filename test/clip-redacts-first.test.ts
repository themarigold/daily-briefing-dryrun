import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/clip-redacts-first.test.ts — the clips on the briefing's delivery path redact BEFORE they
// truncate: the two git-derived ones below, and (Phase E final harden, E9) the provider-output channel —
// provider.ts's 300-char cut of a CLI's own stderr/stdout and harden.ts's 160-char `firstLine` — plus the
// operator audit's two error-detail clips (src/audit.ts) and the Stage-1 `🔀 Merged #N (branch)` lines,
// which now take Stage 2's any-case branch decision.
//
// `redactCredentials` matches whole shapes (`ghp_` + >=20 alnum, `AKIA` + 16), so a token that a clip
// cuts in half no longer matches, and the surviving PREFIX ships past the output-side redaction of the
// briefing file and the JSON envelope. postcheck.ts's `clip` was fixed for exactly this (see its
// header, and test/diag.credential-redaction.test.ts); two more clips on the delivery path did not:
//   · `recapCoverage`'s not-shown subject (generator.ts, 72 chars) → `▶ What you did` NOT-shown lines;
//   · `composeResumptionNote`'s stash text (subprojects.ts, 80 chars) → the deterministic RESUME
//     backfill (generator.ts) and the unit's resumption note.
// Each plant is proven to be cut by the clip (the shared matcher misses the clipped prefix) before the
// assertion that it is gone.
import { test, expect, describe } from "bun:test";
import { recapCoverage } from "../src/generator";
import { renderBriefing } from "../src/render";
import { redactStruct } from "../src/json";
import { composeResumptionNote, type Unit } from "../src/subprojects";
import { matchesCredential, redactCredentials, redactCredentialsAnyCase, REDACTION } from "../src/transcripts/credentials";
import type { ReducedContext, Activity, BriefingStruct, Config, Provider } from "../src/types";
import { BYOCliProvider } from "../src/provider";
import { firstLine } from "../src/harden";
import { gitUnavailableLine, groundTruthUnavailableLine } from "../src/audit";
import { runCore } from "../src/core";
import { buildRepo, branchCommit, mergeBranchWith } from "./fixtures/build-repo";

const GH = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";
const AWS = "AKIAIOSFODNN7EXAMPLE";
// 60 filler chars put each token across both clip points (72 and 80).
const FILL = "x".repeat(59) + " ";
const commit = (sha: string, file: string, subject: string): Activity => ({
  source: "git", kind: "commit", event_id: sha, repo: "/r", text: subject,
  meta: { diffstat: [{ file, added: 1, removed: 0 }] },
});
const ctxOf = (...acts: Activity[]): ReducedContext => ({ repos: [{ repo: "/r", summary: "s", activities: acts }] });
const UNITS: Unit[] = [{ repo: "/r", root: null, label: "personal_code", hasResumptionState: false, hasWindowContent: true,
  resumptionNote: "", dirtyFiles: [], latestCommitTime: null }];
const struct = (over: Partial<BriefingStruct>): BriefingStruct =>
  ({ date: "2026-09-05", machineScope: "x", provider: "p", resume: [], suggestions: [], recap: [], ...over } as BriefingStruct);
/** The first 7 characters after the token's fixed prefix — what a clipped prefix leaks. */
const leak = (tok: string) => tok.slice(4, 11);

describe("the not-shown subject is redacted before it is clipped", () => {
  for (const tok of [GH, AWS]) {
    test(`${tok.slice(0, 4)}…: the prefix the clip leaves reaches neither channel`, () => {
      const subject = `${FILL}${tok} rotated and more words after it`;
      // Premise: the plain clip cuts the token, and the shared matcher misses what is left.
      const naive = subject.slice(0, 71);
      expect(naive).toContain(leak(tok));
      expect(matchesCredential(naive)).toBe(false);

      const ctx = ctxOf(commit("aaa1111", "a.ts", "shown one"), commit("bbb2222", "b.ts", subject));
      const cov = recapCoverage([{ repo: "personal_code", text: "did one", evidence: "aaa1111" }], ctx, UNITS)!;
      expect(cov.notShown).toHaveLength(1);
      expect(cov.notShown[0]!.subject).toContain(REDACTION);
      const s = struct({ recap: [{ repo: "personal_code", text: "did one", evidence: "aaa1111" }], recapCoverage: cov });
      expect(redactCredentials(renderBriefing(s))).not.toContain(leak(tok));
      expect(JSON.stringify(redactStruct(s))).not.toContain(leak(tok));
    });
  }

  test("a credential-free subject is clipped exactly as before", () => {
    const subject = "y".repeat(100);
    const ctx = ctxOf(commit("aaa1111", "a.ts", "one"), commit("bbb2222", "b.ts", subject));
    const cov = recapCoverage([{ repo: "personal_code", text: "did one", evidence: "aaa1111" }], ctx, UNITS)!;
    expect(cov.notShown[0]!.subject).toBe(`${"y".repeat(71)}…`);
  });
});

describe("the stash text is redacted before it is clipped", () => {
  for (const tok of [GH, AWS]) {
    test(`${tok.slice(0, 4)}…: the prefix the clip leaves reaches neither channel`, () => {
      const text = `On main: ${"z".repeat(58)} ${tok} and the rest of the stash message`;
      // Premise: the 80-char clip cuts the token, and the shared matcher misses what is left.
      const naive = text.slice(0, 79);
      expect(naive).toContain(leak(tok));
      expect(matchesCredential(naive)).toBe(false);

      const note = composeResumptionNote({ files: [], ahead: 0, behind: 0, stashes: [{ text }], detached: false });
      expect(note).toContain(REDACTION);
      expect(note).not.toContain(leak(tok));
      const s = struct({ resume: [{ repo: "personal_code", text: note }] });
      expect(redactCredentials(renderBriefing(s))).not.toContain(leak(tok));
      expect(JSON.stringify(redactStruct(s))).not.toContain(leak(tok));
    });
  }

  test("a credential-free stash is clipped exactly as before", () => {
    const text = "w".repeat(100);
    const note = composeResumptionNote({ files: [], ahead: 0, behind: 0, stashes: [{ text }], detached: false });
    expect(note).toBe(`${"w".repeat(79)}…`);
  });
});

// ── E9: the provider-output channel, the audit's error details, the Stage-1 merge lines ──────────────

/** `tok` placed so a cut at `at` keeps exactly its fixed prefix plus the 7 chars `leak` names. */
const straddling = (tok: string, at: number, filler = "q") => `${filler.repeat(at - 12)} ${tok} and more after it`;

describe("provider.ts: a CLI's stderr/stdout is redacted before its 300-char cut", () => {
  for (const tok of [GH, AWS]) {
    test(`${tok.slice(0, 4)}…: neither stream's clipped prefix reaches the ProviderError`, async () => {
      const text = straddling(tok, 300);
      // Premise: the old cut keeps the leak and the shared matcher misses it.
      expect(text.slice(0, 300)).toContain(leak(tok));
      expect(matchesCredential(text.slice(0, 300))).toBe(false);
      const p = new BYOCliProvider({ cli: "sh", argv: ["-c", `printf '%s' '${text}' >&2; printf '%s' '${text}'; exit 1`], promptVia: "stdin" });
      const e = await p.generate("prompt").then(() => undefined, (x: unknown) => x as Error);
      expect(e?.message).toContain("exited 1");                // PREMISE: the diag path really ran
      expect(e!.message).toContain("(stdout)");                // …with BOTH streams in it
      expect(e!.message.split(REDACTION).length - 1).toBe(2);
      expect(e!.message).not.toContain(leak(tok));
      expect(matchesCredential(e!.message)).toBe(false);
    });
  }

  test("credential-free output is cut exactly as before", async () => {
    const p = new BYOCliProvider({ cli: "sh", argv: ["-c", `printf '%s' '${"e".repeat(400)}' >&2; exit 1`], promptVia: "stdin" });
    const e = await p.generate("prompt").then(() => undefined, (x: unknown) => x as Error);
    expect(e!.message.endsWith(`: ${"e".repeat(300)}`)).toBe(true);
  });
});

describe("harden.ts firstLine: redacted before its 160-char cut", () => {
  for (const tok of [GH, AWS]) {
    test(`${tok.slice(0, 4)}…`, () => {
      const m = `${straddling(tok, 160)}\nsecond line`;
      expect(m.slice(0, 160)).toContain(leak(tok));
      expect(matchesCredential(m.slice(0, 160))).toBe(false);
      const out = firstLine(m);
      expect(out).toContain(REDACTION);
      expect(out).not.toContain(leak(tok));
      expect(out).not.toContain("second line");
    });
  }
  test("a credential-free first line is cut exactly as before", () => {
    expect(firstLine(`${"f".repeat(200)}\nrest`)).toBe("f".repeat(160));
  });
});

describe("audit.ts: the two error-detail clips redact first", () => {
  for (const tok of [GH, AWS]) {
    test(`${tok.slice(0, 4)}…: GIT UNAVAILABLE (160) and GROUND TRUTH UNAVAILABLE (200)`, () => {
      const d = straddling(tok, 160);
      expect(d.slice(0, 160)).toContain(leak(tok));
      expect(matchesCredential(d.slice(0, 160))).toBe(false);
      const g = gitUnavailableLine(d)!;
      expect(g).toContain(REDACTION);
      expect(g).not.toContain(leak(tok));
      // String(err) is "Error: <message>", so the message is placed for a cut at 200 of THAT.
      const err = new Error(straddling(tok, 200 - "Error: ".length));
      expect(String(err).slice(0, 200)).toContain(leak(tok));
      expect(matchesCredential(String(err).slice(0, 200))).toBe(false);
      const t = groundTruthUnavailableLine(err);
      expect(t).toContain(REDACTION);
      expect(t).not.toContain(leak(tok));
    });
  }
});

describe("core.ts: a Stage-1 `🔀 Merged #N (branch)` line shows a credential branch as [redacted], in any case", () => {
  test("today's merge AND an in-window merge — lower-cased, so only the any-case decision catches it", async () => {
    const lowered = AWS.toLowerCase();                      // akia… — reversible, still a leak
    const branch = `fix/${lowered}`;
    // PREMISE: the case-sensitive pass every rendered briefing and envelope gets downstream misses it.
    expect(redactCredentials(`🔀 Merged #9 (${branch})`)).toBe(`🔀 Merged #9 (${branch})`);
    const noon = (daysAgo: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - daysAgo); return d.toISOString(); };
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const earlierToday = new Date(Math.max(Date.now() - 120_000, midnight.getTime() + 1_000)).toISOString();
    const dir = await buildRepo([{ file: "w.ts", content: "x", isoDate: noon(1) }]);
    await branchCommit(dir, "feat-a", "a.txt", noon(1));
    await mergeBranchWith(dir, "feat-a", `Merge pull request #7 from o/${branch}`, new Date(Date.parse(noon(1)) + 3600e3).toISOString());
    await branchCommit(dir, "feat-b", "b.txt", earlierToday);
    await mergeBranchWith(dir, "feat-b", `Merge pull request #8 from o/${branch}`, earlierToday);
    await branchCommit(dir, "feat-c", "c.txt", earlierToday);
    await mergeBranchWith(dir, "feat-c", "Merge pull request #6 from o/feat/clean-name", earlierToday);
    const cfg: Config = { repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30, provider: { cli: "echo", argv: [], promptVia: "stdin" } };
    const stub: Provider = { generate: async () => "## RESUME\n- [x] r\n## RECAP\n- [x] c | evidence: HEAD\n## SUGGESTIONS\n- n" };
    const r = await runCore(cfg, { provider: stub, netProbe: async () => true });
    const todayLine = (r.struct.today ?? []).find((t) => t.text.includes("Merged #8"));
    const windowLine = (r.struct.windowMerges ?? []).find((m) => m.text.includes("Merged #7"));
    const clean = (r.struct.today ?? []).find((t) => t.text.includes("Merged #6"));
    expect([todayLine, windowLine, clean].every(Boolean)).toBe(true);   // PREMISE: all three lines exist
    for (const line of [todayLine!.text, windowLine!.text]) {
      expect(line).toContain(`(${REDACTION})`);
      expect(line).not.toContain(lowered.slice(4));
    }
    expect(clean!.text).toContain("(feat/clean-name)");                 // a clean branch is shown verbatim
    expect(renderBriefing(r.struct)).not.toContain(lowered.slice(4));
  });
});

// Round-2 harden (D-M1): every redaction call site round 1 added is handed a string by construction —
// except one, `status --json`'s `morningTime.value`, where a hand-edited 720 reached `.replace` and
// THREW. Defence in depth for the rest: both redactors return a non-string UNCHANGED, never throw — the
// rule `redactJson` (json.ts) already applies to a non-string leaf.
describe("the redactors take a NON-string without throwing (defence in depth)", () => {
  test("a number, boolean, object, array, null or undefined comes back unchanged", () => {
    for (const v of [720, true, {}, [], null, undefined] as unknown as string[]) {
      expect(redactCredentials(v)).toBe(v);
      expect(redactCredentialsAnyCase(v)).toBe(v);
    }
    expect(redactCredentials(`x ${GH}`)).toBe(`x ${REDACTION}`);          // a string is still redacted
  });
});
