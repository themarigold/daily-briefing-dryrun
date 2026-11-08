/**
 * Wizard follow-up M1 (design 2026-10-31 r6 §1–2, D1) — honest step numbers.
 *
 * The screen numbers count the steps that SHOW: the folder-access step only where it applies, the optional
 * calendar step always ("Step N of M — your calendar (optional)"). `stepNumber`, `stepTotal` and `stepHeading`
 * (`lib/wizard.ts`) are the only source; the header and the welcome copy call them.
 *
 * ⚠ EVERY EXPECTATION BELOW IS A LITERAL, never recomputed from `STEP_ORDER` (spec r5): a table derived from
 * the code it tests would agree with any bug in it.
 *
 * The access states: UNKNOWN (before "Continue" from step 3 ran the check), IN scope, OUT of scope. On Linux
 * and Windows the access step never counts, whatever `accessInScope` says (r6); on macOS and an unknown OS
 * ("other" may be a Mac, `platform.ts`) it counts while unknown, and then only when in scope.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import type { Os } from "../src/lib/platform";
import { stepHeading, stepNumber, stepTotal, type StepCtx, type StepId } from "../src/lib/wizard";
import Wizard from "../src/routes/Wizard.svelte";

const STEPS: StepId[] = ["welcome", "provider", "repos", "access", "updates", "floor", "calendar", "delivery"];

/** The two numberings that exist, written out by hand. */
const WITH_ACCESS: Record<StepId, number | null> = {
  welcome: 1, provider: 2, repos: 3, access: 4, updates: 5, floor: 6, calendar: 7, delivery: 8,
};
const WITHOUT_ACCESS: Record<StepId, number | null> = {
  welcome: 1, provider: 2, repos: 3, access: null, updates: 4, floor: 5, calendar: 6, delivery: 7,
};
const HEADINGS_8: Record<StepId, string | null> = {
  welcome: "Step 1 of 8 — what this is",
  provider: "Step 2 of 8 — who writes the briefing",
  repos: "Step 3 of 8 — what it reads",
  access: "Step 4 of 8 — macOS folder access",
  updates: "Step 5 of 8 — new versions",
  floor: "Step 6 of 8 — your morning time",
  calendar: "Step 7 of 8 — your calendar (optional)",
  delivery: "Step 8 of 8 — background delivery",
};
const HEADINGS_7: Record<StepId, string | null> = {
  welcome: "Step 1 of 7 — what this is",
  provider: "Step 2 of 7 — who writes the briefing",
  repos: "Step 3 of 7 — what it reads",
  access: null,
  updates: "Step 4 of 7 — new versions",
  floor: "Step 5 of 7 — your morning time",
  calendar: "Step 6 of 7 — your calendar (optional)",
  delivery: "Step 7 of 7 — background delivery",
};

type Access = "unknown" | "in" | "out";
const ctxOf = (os: Os, access: Access): StepCtx => ({
  os,
  accessKnown: access !== "unknown",
  accessInScope: access === "in",
});

/** One row per OS × access state: the expected numbers, total, headings and welcome number — all literals. */
const TABLE: { os: Os; access: Access; numbers: Record<StepId, number | null>; total: number; headings: Record<StepId, string | null>; welcome: number }[] = [
  { os: "macos", access: "unknown", numbers: WITH_ACCESS, total: 8, headings: HEADINGS_8, welcome: 5 },
  { os: "macos", access: "in", numbers: WITH_ACCESS, total: 8, headings: HEADINGS_8, welcome: 5 },
  { os: "macos", access: "out", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "other", access: "unknown", numbers: WITH_ACCESS, total: 8, headings: HEADINGS_8, welcome: 5 },
  { os: "other", access: "in", numbers: WITH_ACCESS, total: 8, headings: HEADINGS_8, welcome: 5 },
  { os: "other", access: "out", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "linux", access: "unknown", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "linux", access: "in", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "linux", access: "out", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "windows", access: "unknown", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "windows", access: "in", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
  { os: "windows", access: "out", numbers: WITHOUT_ACCESS, total: 7, headings: HEADINGS_7, welcome: 4 },
];

describe("stepNumber / stepTotal / stepHeading — the truth table (8 steps × 4 OS × 3 access states)", () => {
  test("the table covers every OS × access state exactly once, and every step", () => {
    expect(TABLE.map((r) => `${r.os}/${r.access}`).sort()).toEqual([
      "linux/in", "linux/out", "linux/unknown",
      "macos/in", "macos/out", "macos/unknown",
      "other/in", "other/out", "other/unknown",
      "windows/in", "windows/out", "windows/unknown",
    ]);
    expect(STEPS).toHaveLength(8);
  });

  for (const row of TABLE) {
    test(`${row.os}, access ${row.access}: numbers, total and headings`, () => {
      const ctx = ctxOf(row.os, row.access);
      for (const step of STEPS) {
        expect({ step, n: stepNumber(step, ctx) }).toEqual({ step, n: row.numbers[step] });
        expect({ step, h: stepHeading(step, ctx) }).toEqual({ step, h: row.headings[step] });
      }
      expect(stepTotal(ctx)).toBe(row.total);
    });
  }

  test("while access is unknown, accessInScope is ignored (it is only ever set alongside accessKnown)", () => {
    for (const [os, total] of [["macos", 8], ["other", 8], ["linux", 7], ["windows", 7]] as const) {
      const ctx: StepCtx = { os, accessKnown: false, accessInScope: true };
      expect({ os, total: stepTotal(ctx) }).toEqual({ os, total });
      expect({ os, access: stepNumber("access", ctx) }).toEqual({ os, access: total === 8 ? 4 : null });
    }
  });

  test("Linux and Windows never count the access step, even when told it is in scope (r6)", () => {
    for (const os of ["linux", "windows"] as const) {
      expect(stepNumber("access", { os, accessKnown: true, accessInScope: true })).toBeNull();
      expect(stepHeading("access", { os, accessKnown: true, accessInScope: true })).toBeNull();
      expect(stepTotal({ os, accessKnown: true, accessInScope: true })).toBe(7);
    }
  });
});

describe("the invariants, per row", () => {
  for (const row of TABLE) {
    test(`${row.os}, access ${row.access}: 1..total with no gaps, in step order; the last is the total; ${row.total} headings`, () => {
      const ctx = ctxOf(row.os, row.access);
      const numbers = STEPS.map((s) => stepNumber(s, ctx)).filter((n): n is number => n !== null);
      expect(numbers).toEqual(row.total === 8 ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7]);
      expect(numbers[numbers.length - 1]).toBe(stepTotal(ctx));
      const headings = STEPS.map((s) => stepHeading(s, ctx)).filter((h): h is string => h !== null);
      expect(headings).toHaveLength(row.total);
      // A null number and a null heading go together.
      for (const s of STEPS) expect({ s, isNull: stepNumber(s, ctx) === null }).toEqual({ s, isNull: stepHeading(s, ctx) === null });
    });
  }

  test("the calendar step is numbered, never \"Optional step\"; no heading says it", () => {
    for (const row of TABLE) {
      const ctx = ctxOf(row.os, row.access);
      for (const s of STEPS) expect(stepHeading(s, ctx) ?? "").not.toContain("Optional step");
      expect(stepHeading("calendar", ctx)).toBe(row.total === 8 ? "Step 7 of 8 — your calendar (optional)" : "Step 6 of 7 — your calendar (optional)");
    }
  });
});

describe("the welcome number — stepNumber(\"updates\", ctx)", () => {
  test("5 before access is known on macOS and an unknown OS; 4 on Linux and Windows; then 5 in scope, 4 out", () => {
    for (const row of TABLE) {
      expect({ row: `${row.os}/${row.access}`, n: stepNumber("updates", ctxOf(row.os, row.access)) }).toEqual({
        row: `${row.os}/${row.access}`,
        n: row.welcome,
      });
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (os: Os) => render(Wizard as any, { props: { scheduleState: null, os } }).body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");

  test("the rendered welcome step names that number (access is unknown at step 1)", () => {
    expect(body("macos")).toContain("only if you say yes in step 5, turn it on later in Settings");
    expect(body("other")).toContain("only if you say yes in step 5, turn it on later in Settings");
    expect(body("linux")).toContain("only if you say yes in step 4, turn it on later in Settings");
    expect(body("windows")).toContain("only if you say yes in step 4, turn it on later in Settings");
  });

  test("the rendered header is stepHeading's (access unknown at step 1)", () => {
    expect(body("macos")).toContain("Step 1 of 8 — what this is");
    expect(body("other")).toContain("Step 1 of 8 — what this is");
    expect(body("linux")).toContain("Step 1 of 7 — what this is");
    expect(body("windows")).toContain("Step 1 of 7 — what this is");
  });
});

/* ── source pins: Wizard.svelte's wiring ─────────────────────────────────────────────────────── */

const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");

/** `text.slice(start, end)` between two anchors, asserting both exist and are in order — so a missing anchor can
 *  never make the slice (and a `toContain` on it) pass vacuously (plan rule 0.2). */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + 1);
  expect({ from, found: start > -1 }).toEqual({ from, found: true });
  expect({ to, found: end > -1 }).toEqual({ to, found: true });
  expect(start).toBeLessThan(end);
  return text.slice(start, end);
}

/** The template: the source without its `<script>`, `<style>` and HTML comments. */
function templateOf(source: string): string {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

describe("Wizard.svelte takes its numbers from the helpers", () => {
  test("stepCtx is { os, accessKnown, accessInScope }", () => {
    expect(component).toContain("const stepCtx: StepCtx = $derived({ os, accessKnown, accessInScope });");
  });

  test('<header class="head"> renders stepHeading(step, stepCtx), and no step title of its own', () => {
    const head = between(component, '<header class="head">', "</header>");
    expect(head).toContain("{stepHeading(step, stepCtx)}");
    expect(head).not.toMatch(/"Step |Optional step|— what this is|— background delivery/);
  });

  test("the template has no /step\\s+\\d/i text — and the scan would catch the old wording", () => {
    const template = templateOf(component);
    // Not vacuous: the template is really there, the script and style are really gone.
    expect(template).toContain("Set up Daily Briefing");
    expect(template).toContain('{#if step === "welcome"}');
    expect(template).not.toContain("async function continueFromRepos");
    expect(template).not.toMatch(/step\s+\d/i);
    // The old header and the old welcome copy are caught by the same regex.
    for (const old of ['"Step 1 of 7 — what this is"', "only if you say yes in step\n          5, turn it on"]) {
      expect({ old, caught: /step\s+\d/i.test(old) }).toEqual({ old, caught: true });
    }
  });

  test('the welcome slice interpolates stepNumber("updates", stepCtx), keeping "only if you"', () => {
    const welcome = between(component, '{#if step === "welcome"}', '{:else if step === "provider"}').replace(/\s+/g, " ");
    expect(welcome).toContain('only if you say yes in step {stepNumber("updates", stepCtx)}, turn it on later in Settings');
  });

  test("accessKnown is set in both branches of continueFromRepos, and never cleared", () => {
    expect(component).toContain("let accessKnown = $state(false);");
    const fn = between(component, "async function continueFromRepos", "async function refreshAccess");
    const ok = between(fn, "try {", "} catch (e) {");
    const failed = between(fn, "} catch (e) {", "} finally {");
    expect(ok).toContain("accessKnown = true;");
    expect(failed).toContain("accessKnown = true;");
    // The declaration plus those two assignments — nothing else writes it, so it is never cleared.
    expect(component.match(/\baccessKnown =/g)).toHaveLength(3);
    expect(component.match(/accessKnown = true;/g)).toHaveLength(2);
  });

  test('continueFromRepos routes only if the wizard is still on "repos" when the snapshot lands', () => {
    const fn = between(component, "async function continueFromRepos", "async function refreshAccess");
    expect(fn).toContain('if (step === "repos") step = nextStep("repos", accessInScope) ?? "floor";');
    // The guarded line is the only routing in it.
    expect(fn.match(/\bstep = /g)).toHaveLength(1);
    // After the finally, so a late snapshot is checked when it lands.
    expect(fn.indexOf('if (step === "repos")')).toBeGreaterThan(fn.indexOf("} finally {"));
  });
});
