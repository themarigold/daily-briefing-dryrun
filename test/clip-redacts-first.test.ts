import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/clip-redacts-first.test.ts — the two git-derived clips on the briefing's delivery path redact
// BEFORE they truncate. (Not every clip in the codebase: review found provider.ts's 300-char cut of a
// provider CLI's own output, and harden.ts's `firstLine`, still truncate first — a separate,
// provider-output channel, recorded rather than fixed here.)
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
import { matchesCredential, redactCredentials, REDACTION } from "../src/transcripts/credentials";
import type { ReducedContext, Activity, BriefingStruct } from "../src/types";

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
