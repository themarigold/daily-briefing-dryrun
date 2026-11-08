/**
 * Wizard follow-up M2 (design 2026-10-31 r6 §3, and §4's "While hidden: the delivery step's verify loop") — the
 * busy signals and the nav buttons.
 *
 * - `wizardNav` (`lib/wizard.ts`) decides every nav button but Continue and the save button (those stay inline in
 *   `Wizard.svelte`): Back and "Set up later" up to the save gate (today's rules, plus `accessLoading` on step 3),
 *   "Finish setup later" on the calendar and delivery steps, Back from delivery to the calendar step only (narrow
 *   Back, D2), and Finish's install/verify gate.
 * - `installBusy` (`lib/install-flow.ts`) and the verify call's in-flight counter (`ScheduleVerify.svelte`) feed it.
 * - `armDecision` and `evidenceStep` (`lib/verify-flow.ts`) are the verify loop's `suspended` rules: a trigger that
 *   arrives while hidden arms once on show, and a kick is SUPPRESSED while hidden, never held (r6).
 *
 * ⚠ EVERY EXPECTATION BELOW IS A LITERAL (plan rule 0.1). The tests render on the server, so no effect runs; the
 * wiring is pinned by source pins on the exact calls, and every slice asserts both its anchors exist and are ordered.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import { installBusy, type Stage } from "../src/lib/install-flow";
import {
  afterKick,
  armDecision,
  beginKick,
  evidenceStep,
  initialLoop,
  isNewEvidence,
  onEvidence,
  type LoopState,
  type VerifyEvidence,
} from "../src/lib/verify-flow";
import { wizardNav, type NavState, type StepId, type WizardNav } from "../src/lib/wizard";
import type { EngineOutcome } from "../src/lib/engine";
import Wizard from "../src/routes/Wizard.svelte";

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

/** `text.slice(start, end)` between two anchors, asserting both exist and are ordered (plan rule 0.2). */
function between(text: string, from: string, to: string, fromIndex = 0): string {
  const start = text.indexOf(from, fromIndex);
  expect([from, start]).not.toEqual([from, -1]);
  const end = text.indexOf(to, start + from.length);
  expect([to, end]).not.toEqual([to, -1]);
  expect(start).toBeLessThan(end);
  return text.slice(start, end);
}

/* ── the verify loop while hidden ─────────────────────────────────────────────────────────────── */

const skipped = (reason: string): EngineOutcome => ({
  operation: "schedule-verify",
  outcome: { kind: "delivered" },
  exitCode: 0,
  payload: { kickstarted: true, outcome: "skipped", skipReason: reason, detail: null, iterations: 1 },
  stdout: "",
  stderr: "",
}) as unknown as EngineOutcome;

/**
 * `evidenceStep`'s state is `onEvidence`'s own: the INPUT object whenever `onEvidence` changed nothing (the identity
 * the component's `next.state !== loop` fixed point rests on), and otherwise an equal new one. (`onEvidence` builds a
 * fresh object on each change, so two separate calls can only agree by value there — identity is the claim exactly
 * where it is checkable.)
 */
function sameState(input: LoopState, got: LoopState, plain: LoopState): void {
  if (plain === input) {
    expect(got).toBe(input);
  } else {
    expect(got).not.toBe(input);
    expect(got).toEqual(plain);
  }
}

/** A plain `retrying` loop — the one `access.check.ts`'s agreement test builds: seen "B", nothing pending. */
function retrying(): LoopState {
  let s = beginKick({ skipIso: "A", delivered: false }, 1);
  s = afterKick(s, skipped("offline"), 1, { skipIso: "B", delivered: false });
  expect(s.stage.stage).toBe("retrying");
  expect(s.ownSkipPending).toBe(false);
  expect(s.deliveredAtKick).toBe(false);
  expect(s.seenSkipIso).toBe("B");
  return s;
}

describe("armDecision — a trigger arms only while shown, and only once", () => {
  test("the table", () => {
    const rows: [number, number, boolean, "arm" | "defer" | "none"][] = [
      [0, 0, false, "none"],
      [0, 0, true, "none"],
      [1, 0, false, "arm"],
      [1, 0, true, "defer"],
      [1, 1, false, "none"],
      [1, 1, true, "none"],
      [2, 1, false, "arm"],
      [2, 1, true, "defer"],
      [0, 1, false, "none"],
      [0, 1, true, "none"],
    ];
    for (const [trigger, seen, suspended, want] of rows) {
      expect({ trigger, seen, suspended, got: armDecision(trigger, seen, suspended) }).toEqual({ trigger, seen, suspended, got: want });
    }
  });

  test("a trigger while suspended defers, arms once on resume, and then is spent", () => {
    // The component advances `seenTrigger` only on "arm": while hidden it stays behind, so the trigger is still due.
    let seen = 0;
    expect(armDecision(1, seen, true)).toBe("defer");
    expect(armDecision(1, seen, true)).toBe("defer");
    expect(armDecision(1, seen, false)).toBe("arm");
    seen = 1;
    expect(armDecision(1, seen, false)).toBe("none");
    expect(armDecision(1, seen, true)).toBe("none");
  });
});

describe("evidenceStep — onEvidence, with the kick suppressed while suspended and nothing held", () => {
  test("agreement with onEvidence over access.check.ts's inert grid: the same kick, and the SAME state object", () => {
    // The grid of `access.check.ts`'s "onEvidence agrees with isNewEvidence wherever the refinement is inert",
    // written out again here (that test is left untouched): the same plain retrying loop, the same four pushes.
    const s = retrying();
    const grid: VerifyEvidence[] = [
      { skipIso: null, delivered: false },
      { skipIso: "B", delivered: false },
      { skipIso: "C", delivered: false },
      { skipIso: "B", delivered: true },
    ];
    for (const evidence of grid) {
      const plain = onEvidence(s, evidence);
      const step = evidenceStep(s, evidence, false);
      expect({ evidence, kick: step.kick }).toEqual({ evidence, kick: plain.kick });
      sameState(s, step.state, plain.state);
      // And `isNewEvidence` still judges it, through the wrapper.
      expect({ evidence, acted: step.kick !== null || step.state !== s }).toEqual({ evidence, acted: isNewEvidence(evidence, s.seenSkipIso) });
    }
    // The literal outcomes, so the agreement cannot hold by both being wrong the same way.
    expect(grid.map((e) => evidenceStep(s, e, false).kick)).toEqual([null, null, 2, null]);
    expect(grid.map((e) => evidenceStep(s, e, false).state.stage.stage)).toEqual(["retrying", "retrying", "retrying", "watching"]);
    expect(grid.map((e) => evidenceStep(s, e, false).state === s)).toEqual([true, true, true, false]);
  });

  test("agreement over every loop shape, not only the plain retrying one", () => {
    let pending = beginKick({ skipIso: "A", delivered: false }, 1);
    pending = afterKick(pending, skipped("offline"), 1, { skipIso: "A", delivered: false });
    expect(pending.ownSkipPending).toBe(true);
    const shapes: LoopState[] = [
      initialLoop(),
      beginKick({ skipIso: "A", delivered: false }, 1),
      beginKick({ skipIso: "A", delivered: true }, 1),
      retrying(),
      pending,
      onEvidence(retrying(), { skipIso: "B", delivered: true }).state,
    ];
    const pushes: VerifyEvidence[] = [
      { skipIso: null, delivered: false },
      { skipIso: "A", delivered: false },
      { skipIso: "B", delivered: false },
      { skipIso: "C", delivered: false },
      { skipIso: "A", delivered: true },
      { skipIso: "C", delivered: true },
    ];
    for (const shape of shapes) {
      for (const evidence of pushes) {
        const plain = onEvidence(shape, evidence);
        const shown = evidenceStep(shape, evidence, false);
        expect(shown.kick).toBe(plain.kick);
        sameState(shape, shown.state, plain.state);
        // Suspended: the same transition, never a kick.
        const hidden = evidenceStep(shape, evidence, true);
        expect(hidden.kick).toBeNull();
        sameState(shape, hidden.state, plain.state);
      }
    }
  });

  test("the fold is a fixed point through evidenceStep too, for both values of suspended", () => {
    for (const suspended of [false, true]) {
      const idle = { skipIso: null, delivered: false };
      const s = beginKick(idle, 1);
      expect(evidenceStep(s, idle, suspended).state).toBe(s);
      const pushed = { skipIso: "B", delivered: false };
      let r = evidenceStep(s, pushed, suspended);
      expect(evidenceStep(r.state, pushed, suspended).state).toBe(r.state);
      expect(evidenceStep(r.state, pushed, suspended).kick).toBeNull();
      const delivered = { skipIso: "B", delivered: true };
      r = evidenceStep(s, delivered, suspended);
      expect(evidenceStep(r.state, delivered, suspended).state).toBe(r.state);
      expect(evidenceStep(r.state, delivered, suspended).kick).toBeNull();
    }
  });

  test("a due kick is suppressed while suspended and comes back by itself on resume (no state change meanwhile)", () => {
    const s = retrying();
    const hidden = evidenceStep(s, { skipIso: "C", delivered: false }, true);
    expect(hidden.kick).toBeNull();
    expect(hidden.state).toBe(s);
    // Resume: the effect re-runs on `suspended`, and the unchanged state yields the same kick again.
    const resumed = evidenceStep(hidden.state, { skipIso: "C", delivered: false }, false);
    expect(resumed.kick).toBe(2);
  });

  test("two skip records while suspended: one kick on resume, not two", () => {
    const s = retrying();
    let r = evidenceStep(s, { skipIso: "C", delivered: false }, true);
    expect(r.kick).toBeNull();
    r = evidenceStep(r.state, { skipIso: "D", delivered: false }, true);
    expect(r.kick).toBeNull();
    expect(r.state).toBe(s);
    r = evidenceStep(r.state, { skipIso: "D", delivered: false }, false);
    expect(r.kick).toBe(2);
    // The kick begins (the component's `kick` → `beginKick`): folding the same push again kicks nothing.
    const kicked = beginKick({ skipIso: "D", delivered: false }, 2);
    expect(evidenceStep(kicked, { skipIso: "D", delivered: false }, false).kick).toBeNull();
  });

  test("a delivery while suspended ends the loop in watching; resume kicks nothing", () => {
    const verifying = beginKick({ skipIso: "A", delivered: false }, 1);
    const r = evidenceStep(verifying, { skipIso: "A", delivered: true }, true);
    expect(r.kick).toBeNull();
    expect(r.state.stage.stage).toBe("watching");
    expect(evidenceStep(r.state, { skipIso: "A", delivered: true }, false).kick).toBeNull();
  });

  test("retrying, then a skip while suspended, then a delivery while suspended, then resume → no kick (r6)", () => {
    // The HIGH r6 fixed: a HELD kick would fire here into a loop the delivery already settled.
    const s = retrying();
    let r = evidenceStep(s, { skipIso: "C", delivered: false }, true);
    expect(r.kick).toBeNull();
    r = evidenceStep(r.state, { skipIso: "C", delivered: true }, true);
    expect(r.kick).toBeNull();
    expect(r.state.stage.stage).toBe("watching");
    r = evidenceStep(r.state, { skipIso: "C", delivered: true }, false);
    expect(r.kick).toBeNull();
    expect(r.state.stage.stage).toBe("watching");
  });

  test("no held-kick state: the loop's memory is the same five fields", () => {
    expect(Object.keys(initialLoop()).sort()).toEqual(["deliveredAtKick", "kickBaselineIso", "ownSkipPending", "seenSkipIso", "stage"]);
    const body = between(src("lib/verify-flow.ts"), "export function evidenceStep(", "\n}\n");
    expect(body).toContain("onEvidence(loop, evidence)");
    expect(body).not.toMatch(/held|pending|defer/i);
  });
});

/* ── ScheduleVerify: suspended, onbusy, and nothing held ──────────────────────────────────────── */

describe("ScheduleVerify.svelte wires armDecision, evidenceStep and the call-lifetime busy signal", () => {
  const verify = src("lib/ScheduleVerify.svelte");

  test("the props: suspended defaults to false, onbusy is optional", () => {
    expect(verify).toContain("let { evidence, trigger = 0, onfinished, suspended = false, onbusy }: Props = $props();");
    expect(verify).toContain("suspended?: boolean;");
    expect(verify).toContain("onbusy?: (busy: boolean) => void;");
  });

  test("the trigger effect advances seenTrigger only on \"arm\"", () => {
    const effect = between(verify, "$effect(() => {\n    if (armDecision(", "\n  });");
    expect(effect).toContain('if (armDecision(trigger, seenTrigger, suspended) === "arm") {\n      seenTrigger = trigger;');
    expect(effect).toContain("const armed = armLoop(evidence);");
    expect(verify.match(/armDecision\(/g)).toHaveLength(1);
    // Final harden r1 (MED 2): the COMPLETE arm block, through the kick dispatch and its closing — deleting
    // `if (armed.kick !== null) void kick(armed.kick);` left every pin green while the real panel sat on "Checking…"
    // with no verify call made (`armLoop` puts the loop in `verifying` before the kick runs).
    expect(verify).toContain(
      '  $effect(() => {\n    if (armDecision(trigger, seenTrigger, suspended) === "arm") {\n      seenTrigger = trigger;\n      const armed = armLoop(evidence);\n      loop = armed.state;\n      if (armed.kick !== null) void kick(armed.kick);\n    }\n  });\n',
    );
    // The old ungated comparison is gone.
    expect(verify).not.toContain("if (trigger > seenTrigger)");
  });

  test("the evidence effect folds through evidenceStep with suspended, and never calls onEvidence itself", () => {
    expect(verify).toContain("const next = evidenceStep(loop, evidence, suspended);");
    expect(verify).toContain("if (next.state !== loop) loop = next.state;\n    if (next.kick !== null) void kick(next.kick);");
    expect(verify).not.toMatch(/\bonEvidence\(/);
    // Final harden r1 (MED 2): the complete evidence effect, exactly.
    expect(verify).toContain(
      "  $effect(() => {\n    const next = evidenceStep(loop, evidence, suspended);\n    if (next.state !== loop) loop = next.state;\n    if (next.kick !== null) void kick(next.kick);\n  });\n",
    );
    // Three kick dispatches in all — the arm block, the evidence effect, the button — and no other effect.
    expect(verify.match(/void kick\(/g)).toEqual(["void kick(", "void kick(", "void kick("]);
    expect(verify).toContain("void kick(armed.kick);");
    expect(verify).toContain("void kick(next.kick);");
    expect(verify).toContain("seenTrigger = trigger;\n      void kick(1);");
    expect(verify.match(/\$effect(\.\w+)?\(/g)).toEqual(["$effect(", "$effect("]);
  });

  test("busy is the call's lifetime: a counter around each scheduleVerify(), in try/finally, emitted on a change", () => {
    expect(verify.match(/scheduleVerify\(\)/g)).toHaveLength(1);
    const kick = between(verify, "async function kick(which: number): Promise<void> {", "\n  }\n");
    expect(kick).toMatch(/track\(1\);\s*try \{\s*const outcome = await scheduleVerify\(\);[\s\S]*\} finally \{\s*track\(-1\);\s*\}$/);
    const track = between(verify, "function track(delta: 1 | -1): void {", "\n  }\n");
    expect(track).toContain("const before = inFlight > 0;");
    expect(track).toContain("inFlight += delta;");
    expect(track).toContain("if ((inFlight > 0) !== before) onbusy?.(inFlight > 0);");
    expect(verify.match(/onbusy\?\.\(/g)).toHaveLength(1);
    // Final harden r2 (MED): the WHOLE kick() and track(), exactly. Discarding beginKick's result
    // (`loop = beginKick(…)` → `beginKick(…)`) left every check above green — the regex skips what sits between
    // `try {` and `} finally {`, and nothing pinned the line before `track(1)`.
    expect(verify).toContain(
      "  async function kick(which: number): Promise<void> {\n    loop = beginKick(evidence, which);\n    track(1);\n    try {\n      const outcome = await scheduleVerify();\n      loop = afterKick(loop, outcome, which, evidence);\n      onfinished?.(outcome);\n    } catch (e) {\n      // A `busy` refusal means a run or an install is already in flight; nothing was started.\n      loop = afterKickRefusal(loop, describeFailure(e));\n    } finally {\n      track(-1);\n    }\n  }\n",
    );
    expect(verify).toContain(
      "  function track(delta: 1 | -1): void {\n    const before = inFlight > 0;\n    inFlight += delta;\n    if ((inFlight > 0) !== before) onbusy?.(inFlight > 0);\n  }\n",
    );
    expect(verify.match(/async function kick\(/g)).toHaveLength(1);
    expect(verify.match(/function track\(/g)).toHaveLength(1);
    // Two track calls, both in kick(); inFlight is written only in track().
    expect(verify.match(/track\(-?1\)/g)).toEqual(["track(1)", "track(-1)"]);
    expect(verify.match(/inFlight \+?=/g)).toEqual(["inFlight =", "inFlight +="]);
  });

  test("the verify-flow import names exactly what the script calls (this branch swapped onEvidence for armDecision and evidenceStep)", () => {
    expect(verify).toContain(
      '  import {\n    afterKick,\n    afterKickRefusal,\n    armDecision,\n    armLoop,\n    beginKick,\n    evidenceStep,\n    initialLoop,\n    MAX_VERIFY_ATTEMPTS,\n    type LoopState,\n    type VerifyEvidence,\n  } from "./verify-flow";\n',
    );
    expect(verify.match(/from "\.\/verify-flow"/g)).toHaveLength(1);
    expect(verify).not.toContain("onEvidence,");
  });

  test("no held-kick state: the component's reactive state is the loop and seenTrigger only", () => {
    expect(verify.match(/\$state[<(]/g)).toHaveLength(2);
    expect(verify).toContain("let loop = $state<LoopState>(initialLoop());");
    expect(verify).toContain("let seenTrigger = $state(0);");
    expect(verify).toContain("let inFlight = 0;");
    // No variable that could remember a kick for later.
    expect(verify).not.toMatch(/\b(let|const)\s+\w*(held|hold|pending|defer|queued)\w*/i);
    expect(verify.match(/^\s*let\s+\w+/gm)?.map((l) => l.trim())).toEqual(["let loop", "let seenTrigger", "let inFlight"]);
  });
});

/* ── ScheduleInstall: onbusy from installBusy ─────────────────────────────────────────────────── */

describe("installBusy and ScheduleInstall's onbusy", () => {
  test("the table: busy while the install runs or its foreign-owner dialog is open", () => {
    const rows: [Stage, boolean][] = [
      ["idle", false],
      ["running", true],
      ["foreign-owner", true],
      ["done", false],
      ["failed", false],
    ];
    for (const [stage, want] of rows) expect({ stage, busy: installBusy(stage) }).toEqual({ stage, busy: want });
  });

  test("the component emits it on every stage change — including the return to idle after Keep", () => {
    const install = src("lib/ScheduleInstall.svelte");
    expect(install).toContain("onbusy?: (busy: boolean) => void;");
    expect(install).toMatch(/onended,\n    onbusy,\n  \}: Props = \$props\(\);/);
    expect(install).toContain("$effect(() => {\n    onbusy?.(installBusy(stage));\n  });");
    expect(install.match(/onbusy\?\.\(/g)).toHaveLength(1);
    // Keep sets the stage back to idle, which the effect reports.
    expect(install).toContain('onkeep={() => {\n        stage = "idle";');
  });
});

/* ── Schedule.svelte is untouched: it passes neither ──────────────────────────────────────────── */

describe("Schedule.svelte passes neither suspended nor onbusy (plan rule 0.3)", () => {
  test("its ScheduleVerify and all three ScheduleInstall tags", () => {
    const schedule = src("routes/Schedule.svelte");
    expect(schedule).toContain("<ScheduleVerify {evidence} trigger={verifyTrigger} />");
    expect(schedule.match(/<ScheduleVerify\b/g)).toHaveLength(1);
    const installs = schedule.match(/<ScheduleInstall\b[^>]*\/>/g) ?? [];
    expect(installs).toHaveLength(3);
    expect(schedule.match(/<ScheduleInstall\b/g)).toHaveLength(3);
    for (const tag of installs) expect([tag, tag.includes("onbusy")]).toEqual([tag, false]);
    expect(schedule).not.toContain("onbusy");
    expect(schedule).not.toContain("suspended");
  });
});

/* ── wizardNav ────────────────────────────────────────────────────────────────────────────────── */

type Flag = keyof NavState;
const FLAGS: Flag[] = ["saving", "keyBusy", "accessLoading", "installBusy", "verifyInFlight", "verifyTriggered", "finishing", "calendarBusy"];
const NONE: NavState = {
  saving: false, keyBusy: false, accessLoading: false, installBusy: false,
  verifyInFlight: false, verifyTriggered: false, finishing: false, calendarBusy: false,
};
const T = true;
const F = false;
/** [back shown, back disabled], [set up later …], [finish setup later …], finish disabled. */
type Row = [StepId, Flag | null, [boolean, boolean], [boolean, boolean], [boolean, boolean], boolean];
const nav = (b: [boolean, boolean], s: [boolean, boolean], l: [boolean, boolean], f: boolean): WizardNav => ({
  back: { shown: b[0], disabled: b[1] },
  setUpLater: { shown: s[0], disabled: s[1] },
  finishLater: { shown: l[0], disabled: l[1] },
  finish: { disabled: f },
});

/* The all-false row and every single-flag row, per step — written out by hand from spec §3. */
const ROWS: Row[] = [
  // welcome: no Back; Set up later waits while saving.
  ["welcome", null, [F, F], [T, F], [F, F], F],
  ["welcome", "saving", [F, F], [T, T], [F, F], F],
  ["welcome", "keyBusy", [F, F], [T, F], [F, F], F],
  ["welcome", "accessLoading", [F, F], [T, F], [F, F], F],
  ["welcome", "installBusy", [F, F], [T, F], [F, F], T],
  ["welcome", "verifyInFlight", [F, F], [T, F], [F, F], T],
  ["welcome", "verifyTriggered", [F, F], [T, F], [F, F], F],
  ["welcome", "finishing", [F, F], [T, F], [F, F], T],
  ["welcome", "calendarBusy", [F, F], [T, F], [F, F], F],
  // provider: Back waits for a key step and a save.
  ["provider", null, [T, F], [T, F], [F, F], F],
  ["provider", "saving", [T, T], [T, T], [F, F], F],
  ["provider", "keyBusy", [T, T], [T, F], [F, F], F],
  ["provider", "accessLoading", [T, F], [T, F], [F, F], F],
  ["provider", "installBusy", [T, F], [T, F], [F, F], T],
  ["provider", "verifyInFlight", [T, F], [T, F], [F, F], T],
  ["provider", "verifyTriggered", [T, F], [T, F], [F, F], F],
  ["provider", "finishing", [T, F], [T, F], [F, F], T],
  ["provider", "calendarBusy", [T, F], [T, F], [F, F], F],
  // repos: and Back waits for the access check too (r4).
  ["repos", null, [T, F], [T, F], [F, F], F],
  ["repos", "saving", [T, T], [T, T], [F, F], F],
  ["repos", "keyBusy", [T, T], [T, F], [F, F], F],
  ["repos", "accessLoading", [T, T], [T, F], [F, F], F],
  ["repos", "installBusy", [T, F], [T, F], [F, F], T],
  ["repos", "verifyInFlight", [T, F], [T, F], [F, F], T],
  ["repos", "verifyTriggered", [T, F], [T, F], [F, F], F],
  ["repos", "finishing", [T, F], [T, F], [F, F], T],
  ["repos", "calendarBusy", [T, F], [T, F], [F, F], F],
  // access: today's rule (a refresh's accessLoading does not hold Back here).
  ["access", null, [T, F], [T, F], [F, F], F],
  ["access", "saving", [T, T], [T, T], [F, F], F],
  ["access", "keyBusy", [T, T], [T, F], [F, F], F],
  ["access", "accessLoading", [T, F], [T, F], [F, F], F],
  ["access", "installBusy", [T, F], [T, F], [F, F], T],
  ["access", "verifyInFlight", [T, F], [T, F], [F, F], T],
  ["access", "verifyTriggered", [T, F], [T, F], [F, F], F],
  ["access", "finishing", [T, F], [T, F], [F, F], T],
  ["access", "calendarBusy", [T, F], [T, F], [F, F], F],
  // updates
  ["updates", null, [T, F], [T, F], [F, F], F],
  ["updates", "saving", [T, T], [T, T], [F, F], F],
  ["updates", "keyBusy", [T, T], [T, F], [F, F], F],
  ["updates", "accessLoading", [T, F], [T, F], [F, F], F],
  ["updates", "installBusy", [T, F], [T, F], [F, F], T],
  ["updates", "verifyInFlight", [T, F], [T, F], [F, F], T],
  ["updates", "verifyTriggered", [T, F], [T, F], [F, F], F],
  ["updates", "finishing", [T, F], [T, F], [F, F], T],
  ["updates", "calendarBusy", [T, F], [T, F], [F, F], F],
  // floor: the save gate — Back and Set up later wait while saving.
  ["floor", null, [T, F], [T, F], [F, F], F],
  ["floor", "saving", [T, T], [T, T], [F, F], F],
  ["floor", "keyBusy", [T, T], [T, F], [F, F], F],
  ["floor", "accessLoading", [T, F], [T, F], [F, F], F],
  ["floor", "installBusy", [T, F], [T, F], [F, F], T],
  ["floor", "verifyInFlight", [T, F], [T, F], [F, F], T],
  ["floor", "verifyTriggered", [T, F], [T, F], [F, F], F],
  ["floor", "finishing", [T, F], [T, F], [F, F], T],
  ["floor", "calendarBusy", [T, F], [T, F], [F, F], F],
  // calendar: no Back, no Set up later; Finish setup later waits for a calendar flow or write too.
  ["calendar", null, [F, F], [F, F], [T, F], F],
  ["calendar", "saving", [F, F], [F, F], [T, F], F],
  ["calendar", "keyBusy", [F, F], [F, F], [T, F], F],
  ["calendar", "accessLoading", [F, F], [F, F], [T, F], F],
  ["calendar", "installBusy", [F, F], [F, F], [T, T], T],
  ["calendar", "verifyInFlight", [F, F], [F, F], [T, T], T],
  ["calendar", "verifyTriggered", [F, F], [F, F], [T, F], F],
  ["calendar", "finishing", [F, F], [F, F], [T, T], T],
  ["calendar", "calendarBusy", [F, F], [F, F], [T, T], F],
  // delivery: Back to the calendar step waits for the install, a triggered or in-flight check, and Finish.
  ["delivery", null, [T, F], [F, F], [T, F], F],
  ["delivery", "saving", [T, F], [F, F], [T, F], F],
  ["delivery", "keyBusy", [T, F], [F, F], [T, F], F],
  ["delivery", "accessLoading", [T, F], [F, F], [T, F], F],
  ["delivery", "installBusy", [T, T], [F, F], [T, T], T],
  ["delivery", "verifyInFlight", [T, T], [F, F], [T, T], T],
  ["delivery", "verifyTriggered", [T, T], [F, F], [T, F], F],
  ["delivery", "finishing", [T, T], [F, F], [T, T], T],
  ["delivery", "calendarBusy", [T, F], [F, F], [T, F], F],
];

describe("wizardNav — every nav button but Continue and the save button, one pure rule (spec §3)", () => {
  test("the table covers all-false plus every single flag on every step", () => {
    const steps: StepId[] = ["welcome", "provider", "repos", "access", "updates", "floor", "calendar", "delivery"];
    expect(ROWS).toHaveLength(steps.length * (FLAGS.length + 1));
    for (const step of steps) {
      expect(ROWS.filter((r) => r[0] === step).map((r) => r[1])).toEqual([null, ...FLAGS]);
    }
  });

  test("all-false and each single flag, per step", () => {
    for (const [step, flag, b, s, l, f] of ROWS) {
      const state: NavState = flag === null ? NONE : { ...NONE, [flag]: true };
      expect({ step, flag, nav: wizardNav(step, state) }).toEqual({ step, flag, nav: nav(b, s, l, f) });
    }
  });

  test("the named combinations", () => {
    // After an install, with its check triggered and settled: Back stays shut (the loop must never remount and
    // re-kick), but Finish setup later and Finish are open — a pending retry may wait forever for a tick.
    expect(wizardNav("delivery", { ...NONE, verifyTriggered: true })).toEqual(nav([T, T], [F, F], [T, F], F));
    // The install running with its check in flight: everything that leaves the step waits.
    expect(wizardNav("delivery", { ...NONE, installBusy: true, verifyInFlight: true, verifyTriggered: true })).toEqual(nav([T, T], [F, F], [T, T], T));
    // After Keep on the foreign-owner dialog (installBusy back to false, nothing triggered): all open again.
    expect(wizardNav("delivery", NONE)).toEqual(nav([T, F], [F, F], [T, F], F));
    // The access check running on step 3 while a key step is busy: Back waits; Set up later does not.
    expect(wizardNav("repos", { ...NONE, accessLoading: true, keyBusy: true })).toEqual(nav([T, T], [T, F], [F, F], F));
    // The save in flight on the gate: Back and Set up later both wait (the re-anchored `disabled={saving}` and
    // `disabled={keyBusy || saving}` pins' property).
    expect(wizardNav("floor", { ...NONE, saving: true, keyBusy: true })).toEqual(nav([T, T], [T, T], [F, F], F));
    // A calendar flow running while Finish is pressed elsewhere cannot happen, but the gate is the OR.
    expect(wizardNav("calendar", { ...NONE, calendarBusy: true, finishing: true })).toEqual(nav([F, F], [F, F], [T, T], T));
    // Delivery ignores the calendar and the pre-save flags.
    expect(wizardNav("delivery", { ...NONE, calendarBusy: true, saving: true, keyBusy: true, accessLoading: true })).toEqual(nav([T, F], [F, F], [T, F], F));
  });

  test("Back never goes past the save; Set up later only before it; Finish setup later only after it", () => {
    const steps: StepId[] = ["welcome", "provider", "repos", "access", "updates", "floor", "calendar", "delivery"];
    expect(steps.map((s) => wizardNav(s, NONE).back.shown)).toEqual([F, T, T, T, T, T, F, T]);
    expect(steps.map((s) => wizardNav(s, NONE).setUpLater.shown)).toEqual([T, T, T, T, T, T, F, F]);
    expect(steps.map((s) => wizardNav(s, NONE).finishLater.shown)).toEqual([F, F, F, F, F, F, T, T]);
  });
});

/* ── Wizard.svelte reads wizardNav ────────────────────────────────────────────────────────────── */

describe("Wizard.svelte: the nav row reads wizardNav, and the busy handlers feed it", () => {
  const wizard = src("routes/Wizard.svelte");
  const row = between(wizard, '<div class="nav-row">', "</section>");

  test("nav is derived from the exact state", () => {
    expect(wizard).toContain(
      "const nav = $derived(wizardNav(step, { saving, keyBusy, accessLoading, installBusy, verifyInFlight, verifyTriggered: verifyTrigger > 0, finishing, calendarBusy }));",
    );
    expect(wizard).toContain("const calendarBusy = $derived(calendarStore.flow.running !== null || calendarStore.writesInFlight > 0);");
    expect(wizard).toContain("let installBusy = $state(false);");
    expect(wizard).toContain("let verifyInFlight = $state(false);");
    // M3: `shown` is the required prop now (M2's local constant is gone; wizard-resume.check.ts pins the prop).
    expect(wizard).not.toContain("const shown = ");
    expect(wizard).toMatch(/\n    shown: boolean;\n/);
  });

  test("each button renders on nav.X.shown and is disabled on nav.X.disabled", () => {
    expect(row).toContain(
      '{#if nav.setUpLater.shown}\n      <button class="quiet" disabled={nav.setUpLater.disabled} onclick={() => { releaseIfUnused("leave"); oncancel(); }}>Set up later</button>\n    {/if}',
    );
    expect(row).toContain(
      '{#if nav.finishLater.shown}\n      <button class="quiet" disabled={nav.finishLater.disabled} onclick={finishLater}>Finish setup later</button>\n    {/if}',
    );
    expect(row).toContain('{#if nav.back.shown}\n      <button class="quiet" disabled={nav.back.disabled} onclick={() => {');
    expect(row).toContain('<button disabled={nav.finish.disabled || loginPlan.kind === "wait"} onclick={() => void finish()}>');
    // Nothing in the row decides on its own any more.
    expect(row).not.toContain("cancelWritesNothing(");
    expect(row).not.toContain("disabled={saving}");
    expect(row).not.toContain("disabled={keyBusy");
    expect(row).not.toContain('step !== "welcome"');
    expect(row.match(/\{#if nav\.\w+\.shown\}/g)).toEqual(["{#if nav.setUpLater.shown}", "{#if nav.finishLater.shown}", "{#if nav.back.shown}"]);
  });

  test("Finish setup later calls onfinished() and nothing else — no install, no login item", () => {
    const body = between(wizard, "function finishLater(): void {", "}");
    expect(body.replace("function finishLater(): void {", "").trim()).toBe("onfinished();");
  });

  test("the busy handlers: the install and the verify call set their flags; the wizard's verify is suspended while hidden", () => {
    const delivery = between(wizard, "<h3>Background delivery</h3>", "<h3>Start at login</h3>");
    expect(delivery).toContain(
      '<ScheduleInstall\n          label="Install background delivery"\n          purpose="install the background scheduler"\n          owner={engineOwner}\n          onfinished={() => (verifyTrigger += 1)}\n          onbusy={(busy) => (installBusy = busy)}\n        />',
    );
    expect(delivery).toContain("<ScheduleVerify {evidence} trigger={verifyTrigger} suspended={!shown} onbusy={(busy) => (verifyInFlight = busy)} />");
    expect(wizard.match(/installBusy = busy/g)).toHaveLength(1);
    expect(wizard.match(/verifyInFlight = busy/g)).toHaveLength(1);
  });

  test("the calendar step's configuration line carries the saved-settings sentence; delivery's does not", () => {
    const calendar = between(wizard, '{:else if step === "calendar"}', '{:else}\n    <div class="body">\n      {#if saved !== null}');
    expect(calendar).toContain(
      ': "Your configuration is unchanged"}{doc !== null ? ` at ${doc.path}` : ""}. You can change these settings in Settings after setup.\n          </p>',
    );
    expect(wizard.match(/You can change these settings in Settings after setup\./g)).toHaveLength(1);
    const delivery = between(wizard, '{:else}\n    <div class="body">\n      {#if saved !== null}', "<h3>Provider check</h3>");
    expect(delivery).not.toContain("You can change these settings");
    expect(delivery).toContain(': "Your configuration is unchanged"}{doc !== null ? ` at ${doc.path}` : ""}.\n        </p>');
  });

  test("on delivery, the line under Finish setup later points at the Schedule screen", () => {
    const after = between(wizard, '<div class="nav-row">', "</section>");
    expect(after).toContain(
      '{#if step === "delivery"}\n    <p class="muted small">You can install background delivery any time from the Schedule screen.</p>\n  {/if}',
    );
    expect(wizard.match(/You can install background delivery any time from the Schedule screen\./g)).toHaveLength(1);
  });

  test("rendered at step 1: Set up later, no Back, no Finish setup later", () => {
    const body = render(Wizard as never, { props: { scheduleState: null, os: "macos" } }).body;
    expect(body).toContain("Set up later");
    expect(body).not.toContain("Finish setup later");
    expect(body).not.toMatch(/>\s*Back\s*</);
    expect(body).not.toContain("You can install background delivery any time");
  });
});
