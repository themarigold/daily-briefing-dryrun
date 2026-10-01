import { test, expect } from "bun:test";
import { ProviderError, API_LABEL_ANTHROPIC, API_LABEL_OPENAI } from "../src/types";
import { claudeShaped } from "../src/harden";
import type { Activity, BriefingStruct, ProviderErrorCode, Config, ActivityMeta } from "../src/types";

test("Activity requires source/kind/event_id only", () => {
  const a: Activity = { source: "git", kind: "commit", event_id: "abc" }; // no repo/timestamp needed
  expect(a.source).toBe("git");
});

test("BriefingStruct has resume/recap/suggestions arrays", () => {
  const b: BriefingStruct = {
    date: "2026-07-07", machineScope: "host", provider: "claude",
    resume: [], recap: [], suggestions: [],
  };
  expect(b.recap).toEqual([]);
});

test("ProviderError carries a typed code", () => {
  const e = new ProviderError("nonzero-exit", "boom");
  expect(e.code).toBe("nonzero-exit");
  expect(e).toBeInstanceOf(Error);
});

// The array is hardcoded, so adding a union member keeps this green while silently making the test's
// own name false. Extended with "usage-limit" in the same change that added it.
test("all 5 ProviderErrorCode values construct a valid ProviderError", () => {
  const codes: ProviderErrorCode[] = ["missing-binary", "nonzero-exit", "empty-output", "timeout", "usage-limit"];
  for (const code of codes) {
    const e = new ProviderError(code, `msg for ${code}`);
    expect(e.code).toBe(code);
    expect(e.message).toBe(`msg for ${code}`);
  }
});

test("BriefingStruct.recap items round-trip evidence alongside repo/text (regression guard: evidence must not be dropped by any transform)", () => {
  const b: BriefingStruct = {
    date: "2026-07-07", machineScope: "host", provider: "claude",
    resume: [], suggestions: [],
    recap: [{ repo: "/r1", text: "fixed the bug", evidence: "a1b2c3d" }],
  };
  expect(b.recap[0]).toEqual({ repo: "/r1", text: "fixed the bug", evidence: "a1b2c3d" });
  expect(b.recap[0]!.evidence).toBe("a1b2c3d");
});

test("Config accepts an additive subprojects field", () => {
  const cfg: Config = {
    provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" },
    subprojects: [{ repo: "/r", roots: ["*"] }],
  };
  expect(cfg.subprojects?.[0]?.roots).toEqual(["*"]);
});

test("ActivityMeta accepts an additive uncommittedFiles field", () => {
  const m: ActivityMeta = { uncommittedFiles: ["a.ts", "b.ts"] };
  expect(m.uncommittedFiles).toEqual(["a.ts", "b.ts"]);
});

// ── A3 / Slice 2: the additive API-provider contract ───────────────────────────────────────────────

/**
 * ⚠ THE PIN IS THE TYPE ANNOTATION, NOT THE `expect`s — and the distinction is the whole point.
 *
 * This guard used to be `const codes: ProviderErrorCode[] = [...five literals]; expect(codes).toHaveLength(5)`,
 * which pinned NOTHING: an array of five valid members stays an array of five valid members no matter
 * how wide the union gets, so widening `ProviderErrorCode` to six left the test green while its comment
 * said in capitals that it could not.
 *
 * `Record<ProviderErrorCode, true>` on a FRESH OBJECT LITERAL fails in BOTH directions, which is what
 * "exactly these five" actually requires:
 *   • a SIXTH union member → that key is missing from the literal → TS2739/TS2741 (missing property).
 *   • a REMOVED union member → its key here is now an excess property → TS2353 (object-literal
 *     freshness), so a shrink cannot pass unnoticed either.
 * `bunx tsc --noEmit` covers this file, so the failure is a build failure, not a silent pass.
 *
 * Every HTTP failure maps onto these five because their members already encode the SEMANTICS callers
 * need (`missing-binary` = permanent for this run, `usage-limit` = permanent AND a timed outage worth
 * skipping quietly). A sixth would mean somebody widened a frozen union rather than reading what the
 * existing ones mean.
 */
const PROVIDER_ERROR_CODES: Record<ProviderErrorCode, true> = {
  "missing-binary": true,
  "nonzero-exit": true,
  "empty-output": true,
  "timeout": true,
  "usage-limit": true,
};

test("A3: the ProviderErrorCode union is still EXACTLY 5 — an API transport added none", () => {
  // The runtime half is a SECOND, weaker check kept for the count itself: the type-level pin above is
  // what makes a widened or narrowed union impossible, and this only reports the number a reader expects.
  const codes = Object.keys(PROVIDER_ERROR_CODES) as ProviderErrorCode[];
  expect(codes).toHaveLength(5);
  expect(new Set(codes).size).toBe(5);
  expect(codes.sort()).toEqual(["empty-output", "missing-binary", "nonzero-exit", "timeout", "usage-limit"]);
});

test("A3: ProviderError.resetAt is additive — it round-trips and does not disturb instanceof", () => {
  const e = new ProviderError("usage-limit", "spend cap reached");
  expect(e.resetAt).toBeUndefined();               // absent by default: the CLI path never sets it
  e.resetAt = "2026-10-01T00:00:00.000Z";
  expect(e.resetAt).toBe("2026-10-01T00:00:00.000Z");
  expect(e).toBeInstanceOf(ProviderError);
  expect(e).toBeInstanceOf(Error);
  expect(e.code).toBe("usage-limit");
});

test("A3: a LEGACY provider config with no `api` still satisfies Config[\"provider\"]", () => {
  // The whole point of an additive-optional field: 85 importers of this file are untouched, and tsc is
  // the proof. This test exists so the property is stated somewhere a reader will find it.
  const legacy: Config["provider"] = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
  expect(legacy.api).toBeUndefined();
  const withApi: Config["provider"] = { cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin", api: { kind: "anthropic", model: "m" } };
  expect(withApi.api?.kind).toBe("anthropic");
});

test("⚠ A3: NEITHER transport label is claude-shaped — three safety gates depend on this literal", () => {
  // `claudeShaped` is an exact lower-cased basename check. The transcripts warning (core.ts), the
  // transcript scan gate (core.ts) and `auditMayCarryRawTurn` (audit.ts) all fall the SAFE way for an
  // API provider with ZERO edits at those sites — purely because these two strings are not "claude".
  // That is a property of the LITERAL, so it is pinned here rather than left to reading.
  expect(claudeShaped(API_LABEL_ANTHROPIC)).toBe(false);
  expect(claudeShaped(API_LABEL_OPENAI)).toBe(false);
  expect(API_LABEL_ANTHROPIC).not.toBe(API_LABEL_OPENAI);
  // …and the sanity check in the other direction, so the assertion above cannot pass vacuously because
  // `claudeShaped` stopped matching anything at all.
  expect(claudeShaped("claude")).toBe(true);
});

// ── Tier B (Stage-2 recap campaigns), T1.1: two additive optional fields ─────────────────────────
//
// ⚠ Like the A3 block above, THE PIN IS THE TYPE ANNOTATION. Each literal below is a FRESH object literal
// annotated with the contract type, so a field REMOVED from `types.ts` turns it into an excess property
// (TS2353) under `bunx tsc --noEmit` — a build failure, not a silent pass. The `expect`s are the weaker
// runtime half: `bun test` erases types, so they alone would stay green with the field gone.

test("a recap entry accepts an additive `campaign` stamp beside `group` (tier B, T1.1)", () => {
  // Both stamps at once is the shape B produces: a campaign absorbs a whole Stage-1 group, so a member
  // carries the level-1 header (`campaign`) AND the level-2 header (`group`).
  const member: BriefingStruct["recap"][number] = {
    repo: "accountant_ai", text: "wired the review queue", evidence: "a1b2c3d",
    group: "agent/loop.py — 2 commits (Sep 3)", campaign: "review-queue hardening — 5 commits",
  };
  expect(member.campaign).toBe("review-queue hardening — 5 commits");
  expect(member.group).toBe("agent/loop.py — 2 commits (Sep 3)");
  // …and the field is OPTIONAL: the pre-B entry shape is still a member of the type, untouched.
  const plain: BriefingStruct["recap"][number] = { repo: "/r1", text: "fixed the bug", evidence: "a1b2c3d" };
  expect(plain.campaign).toBeUndefined();
  const b: BriefingStruct = {
    date: "2026-09-24", machineScope: "host", provider: "claude",
    resume: [], suggestions: [], recap: [member, plain],
  };
  expect(b.recap.map((r) => r.campaign)).toEqual(["review-queue hardening — 5 commits", undefined]);
});

test("Config accepts any `recapCampaigns` value — it is `unknown`, read only by its resolver (tier B, T1.1)", () => {
  // The documented shape AND the malformed shapes Appendix D7 says degrade to `off` with a warning: all
  // of them must be MEMBERS of `Config`, or a bad value would fail at the type boundary instead of at
  // `resolveRecapCampaigns`, where it degrades visibly.
  const provider: Config["provider"] = { cli: "claude", argv: ["-p"], promptVia: "stdin" };
  const cfgs: Config[] = [
    { provider, recapCampaigns: { mode: "trial" } },
    { provider, recapCampaigns: { mode: "off" } },
    { provider, recapCampaigns: "garbage" },
    { provider, recapCampaigns: 42 },
    { provider, recapCampaigns: null },
    { provider, recapCampaigns: { mode: "on", extra: true } },
  ];
  expect(cfgs.map((c) => c.recapCampaigns)).toEqual([{ mode: "trial" }, { mode: "off" }, "garbage", 42, null, { mode: "on", extra: true }]);
  // …and absent is still a `Config` (the common install), reading back as `undefined`.
  const absent: Config = { provider };
  expect(absent.recapCampaigns).toBeUndefined();
  expect("recapCampaigns" in absent).toBe(false);
});
