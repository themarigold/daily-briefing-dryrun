// test/promote-resume.credential.test.ts — a credential in a Resume: action is never promoted.
//
// MEASURED DEFECT (2026-10-29): the promotion cut stops at the first `[.!?]` + whitespace and strips
// a trailing `.!?,`. A credential that meets its 8-character floor only WITH that `.` lost it:
// "Resume: rotate PASSWORD=abcdefg. Next…" promoted `rotate PASSWORD=abcdefg`, which matches no
// pattern, so the page (main.ts redacts the RENDERED text) showed it in clear under "Suggested next"
// while the RESUME bullet beside it was redacted. Fixed by declining any action whose sentence
// carries a credential; declining, not redacting, because the channel never edits text. Fake values only.
import { expect, test } from "bun:test";
import { generateBriefing, promoteResumeActions } from "../src/generator";
import { renderBriefing } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import type { BriefingStruct, Provider, ReducedContext } from "../src/types";

const R = (text: string, repo = "/r1"): BriefingStruct["resume"][number] => ({ repo, text });
const texts = (s: BriefingStruct["suggestions"]) => s.map((x) => x.text);

test("the reproduction: a credential that needs its sentence-final `.` declines the action", () => {
  // Precondition, so the case cannot pass vacuously: the cut action alone matches nothing.
  expect(redactCredentials("rotate PASSWORD=abcdefg")).toBe("rotate PASSWORD=abcdefg");
  expect(redactCredentials("rotate PASSWORD=abcdefg.")).toBe("rotate [redacted]");
  const s = promoteResumeActions([{ text: "add tests for reduce.ts" }], [R("Shipped the parser. Resume: rotate PASSWORD=abcdefg. Next we ship the CLI.")]);
  expect(texts(s)).toEqual(["add tests for reduce.ts"]);
});

test("a credential that needs its trailing `,` at end of bullet declines the action too", () => {
  expect(redactCredentials("rotate PASSWORD=abcdefg")).toBe("rotate PASSWORD=abcdefg");
  expect(texts(promoteResumeActions([], [R("Resume: rotate PASSWORD=abcdefg,")]))).toEqual([]);
});

test("declined, not redacted: an action whose credential would survive the cut is also not promoted", () => {
  const s = promoteResumeActions([], [R("Resume: rotate PASSWORD=abcdefgh1 and redeploy the worker")]);
  expect(texts(s)).toEqual([]);
  expect(texts(s).some((t) => t.includes("[redacted]"))).toBe(false);
});

test("scoped to the action's sentence: a credential in a LATER sentence does not decline a clean action", () => {
  const s = promoteResumeActions([], [R("Resume: rotate the staging keys. Then PASSWORD=abcdefgh1 was logged")]);
  expect(texts(s)).toEqual(["rotate the staging keys"]);
});

test("per bullet: a declined bullet does not stop a clean bullet from promoting", () => {
  const s = promoteResumeActions([], [R("Resume: rotate PASSWORD=abcdefg. Later."), R("Resume: audit the day-42 briefing next", "/r2")]);
  expect(s).toEqual([{ text: "audit the day-42 briefing next", repo: "/r2", promoted: true }]);
});

test("pipeline: the rendered, redacted page never shows the credential (main.ts's sink)", async () => {
  const ctx: ReducedContext = { repos: [] };
  const provider: Provider = {
    generate: async () => [
      "## RESUME",
      "- [/r1] Shipped the parser. Resume: rotate PASSWORD=abcdefg. Next we ship the CLI.",
      "## RECAP",
      "- [/r1] did work | evidence: a1b2c3",
      "## SUGGESTIONS",
      "- add tests for reduce.ts",
    ].join("\n"),
  };
  const b = await generateBriefing(ctx, provider, { date: "2026-10-29", machineScope: "host", provider: "claude" }, []);
  expect(texts(b.suggestions)).toEqual(["add tests for reduce.ts"]);
  const page = redactCredentials(renderBriefing(b));
  expect(page).not.toContain("abcdefg");
  expect(page).toContain("rotate [redacted] Next we ship the CLI.");   // the source bullet still renders
});
