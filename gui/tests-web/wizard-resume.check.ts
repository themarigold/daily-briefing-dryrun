/**
 * Wizard follow-up M3 (design 2026-10-31 r6 §4 "Keeping your place", decision D3) — setup stays mounted while another
 * tab is shown.
 *
 * - `wizardTabShown` (`lib/wizard.ts`): the Setup tab shows while setup is the route, while it is open (mounted,
 *   hidden), or while the engine reports no configuration.
 * - App mounts `<Wizard>` once, on `wizardOpen || route === "wizard"`, inside `.screen` and OUTSIDE the route chain, in
 *   a wrapper `hidden` on every other route; `wizardOpen` is set by an effect on the route and cleared by Finish /
 *   "Finish setup later", "Set up later", and an Uninstall's start; Finish routes to Today only from setup itself.
 * - The wizard's required `shown` prop: the calendar step's body is not drawn while hidden; showing it again on that
 *   step re-enters the step (`calendarEntryPending`, `calendarEntryAction` in calendar-question.check.ts).
 * - Focus: the step line is keyed on `step` and takes focus on every step change and every show, never on the first
 *   mount (`focusStepLine`).
 *
 * ⚠ EVERY EXPECTATION BELOW IS A LITERAL (plan rule 0.1). The tests render on the server, so no effect runs; the
 * wiring is pinned by source pins on the exact code, and every slice asserts both its anchors exist and are ordered.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import type { Phase, Route } from "../src/lib/state";
import { focusStepLine, loginDefaultRereads, wizardTabShown } from "../src/lib/wizard";

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

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * Every innermost `selector { body }` rule in a stylesheet, comments stripped — the innermost blocks only, so a rule
 * inside an `@media` block is found with its own selector. (A Svelte `:global { … }` BLOCK would hide its inner rules'
 * global-ness from this; the test that uses it asserts there is none.)
 */
function cssRules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

/** `selector` with every `:global(…)` replaced by what it wraps, so a combinator inside one is read as written. */
function unwrapGlobal(selector: string): string {
  let out = selector;
  for (let i = out.indexOf(":global("); i !== -1; i = out.indexOf(":global(")) {
    let depth = 0;
    let j = i + ":global".length;
    for (; j < out.length; j++) {
      if (out[j] === "(") depth++;
      else if (out[j] === ")" && --depth === 0) break;
    }
    out = out.slice(0, i) + out.slice(i + ":global(".length, j) + out.slice(j + 1);
  }
  return out;
}

/** The last compound of each comma-separated selector: what follows its last top-level combinator. */
function lastCompounds(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= selector.length; i++) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (i === selector.length || ch === ",")) {
      out.push(selector.slice(start, i).trim());
      start = i + 1;
    } else if (depth === 0 && /[\s>+~]/.test(ch)) start = i + 1;
  }
  return out;
}

/** The compound names no class, id or type — only pseudo-classes, `*` and attributes — so it may match any element. */
function anyElement(compound: string): boolean {
  let c = compound;
  for (let prev = ""; prev !== c; ) {
    prev = c;
    c = c.replace(/\([^()]*\)/g, "");
  }
  return c.replace(/\[[^\]]*\]/g, "").replace(/::?[\w-]+/g, "").replace(/\*/g, "").trim() === "";
}

/**
 * A selector that could match the setup wrapper: `div`, `*`, a `.screen >` child, `[hidden]`, or — post-convergence
 * LOW 2 — any selector whose LAST compound names no class, id or type (`.screen :first-child`, `main > :not(nav)`,
 * `:global(.screen) > :first-child`).
 */
const couldMatchWrapper = (selector: string): boolean =>
  /(^|[\s,>+~(])(div|\*)(?![\w-])/.test(selector) ||
  /\[hidden\]/.test(selector) ||
  /\.screen\s*>/.test(selector) ||
  lastCompounds(unwrapGlobal(selector)).some(anyElement);

/* ── the pure rules ───────────────────────────────────────────────────────────────────────────── */

describe("wizardTabShown: the Setup tab", () => {
  test("the truth table (literal): shown on the wizard route, while setup is open, or while not configured", () => {
    const rows: [Route, Phase["phase"] | null | undefined, boolean, boolean][] = [
      // route === "wizard": always.
      ["wizard", "not-configured", false, true],
      ["wizard", "delivered", false, true],
      ["wizard", undefined, false, true],
      ["wizard", null, true, true],
      // Another route, setup open (hidden, D3): shown.
      ["today", "delivered", true, true],
      ["history", undefined, true, true],
      ["schedule", "not-scheduled", true, true],
      ["settings", null, true, true],
      // Another route, not open: only the engine's no-config phase shows it (today's rule).
      ["today", "not-configured", false, true],
      ["settings", "not-configured", false, true],
      ["today", "delivered", false, false],
      ["history", "config-error", false, false],
      ["schedule", "not-scheduled", false, false],
      ["settings", "skipped", false, false],
      ["today", undefined, false, false],
      ["today", null, false, false],
    ];
    for (const [route, phase, open, want] of rows) {
      expect({ route, phase, open, got: wizardTabShown(route, phase, open) }).toEqual({ route, phase, open, got: want });
    }
  });
});

describe("focusStepLine: the step line's focusHeading argument", () => {
  test("the truth table (literal): true only when shown and past the first mount", () => {
    const rows: [boolean, boolean, boolean][] = [
      [true, true, false], // the first mount (app start, or the auto-offer): no focus stolen
      [true, false, false],
      [false, false, false], // hidden: nothing to focus
      [false, true, true], // shown, after a step change or a hide
    ];
    for (const [firstMount, shown, want] of rows) {
      expect({ firstMount, shown, got: focusStepLine(firstMount, shown) }).toEqual({ firstMount, shown, got: want });
    }
  });
});

describe("loginDefaultRereads: showing setup again reads the login-item default once more (final harden r1, MED 3)", () => {
  test("the truth table (literal): only while the box is untouched — a tick or an untick is the user's and is never re-read", () => {
    const rows: [boolean | null, boolean][] = [
      [null, true], // untouched: Settings › This app may have changed the login item while setup was hidden
      [true, false], // ticked by the user
      [false, false], // unticked by the user
    ];
    for (const [choice, want] of rows) {
      expect({ choice, got: loginDefaultRereads(choice) }).toEqual({ choice, got: want });
    }
  });
});

/* ── App.svelte: the mount, the open flag, the tab ────────────────────────────────────────────── */

describe("App.svelte keeps setup mounted while another tab is shown (D3)", () => {
  const app = src("App.svelte");
  const screen = between(app, '<div class="screen">', "</main>");
  const chain = between(screen, '{#if route === "today"}', "\n  {/if}\n  </div>");
  const wizardTag = between(app, "<Wizard\n", "/>");

  test("wizardOpen: one $state, set by an effect on the route, cleared in exactly three places", () => {
    expect(app).toContain("let wizardOpen = $state(false);");
    expect(app).toContain('$effect(() => {\n    if (route === "wizard") wizardOpen = true;\n  });');
    expect(count(app, "wizardOpen = true")).toBe(1);
    expect(count(app, "wizardOpen = false")).toBe(3);
  });

  test("the clears: Finish and Finish setup later (onfinished), Set up later (oncancel), an Uninstall's start (Settings)", () => {
    expect(wizardTag).toContain('oncancel={() => {\n          wizardOpen = false;\n          route = "today";\n        }}');
    // r4: Finish routes to Today only from setup itself; it still refreshes either way.
    expect(wizardTag).toContain(
      'onfinished={() => {\n          wizardOpen = false;\n          if (route === "wizard") route = "today";\n          void refresh();\n          void refreshAccess(false);\n        }}',
    );
    expect(wizardTag).not.toMatch(/\n\s*route = "today";\n\s*void refresh\(\);/);
    const settings = between(app, "<Settings\n", "/>");
    expect(between(settings, "onuninstallstarted={() => {", "}}")).toContain("wizardOpen = false;");
    expect(count(settings, "wizardOpen = false")).toBe(1);
  });

  test("the mount: on wizardOpen || route === \"wizard\", inside .screen, before and outside the route chain, in a hidden wrapper", () => {
    expect(count(app, "<Wizard\n")).toBe(1);
    expect(screen).toContain(
      '  {#if wizardOpen || route === "wizard"}\n    <div hidden={route !== "wizard"}>\n      <Wizard\n        scheduleState={snapshot?.scheduleState ?? null}\n        {os}\n        shown={route === "wizard"}\n',
    );
    const mount = between(screen, '{#if wizardOpen || route === "wizard"}', '{#if route === "today"}');
    expect(mount).toContain("<Wizard\n");
    expect(mount.trimEnd().endsWith("</div>\n  {/if}")).toBe(true);
    // Not inside the chain.
    expect(chain).not.toContain("<Wizard");
    expect(screen.indexOf("<Wizard\n")).toBeLessThan(screen.indexOf('{#if route === "today"}'));
  });

  test("the wrapper has no class and no author display rule: the hidden attribute alone hides it", () => {
    expect(app).toContain('<div hidden={route !== "wizard"}>');
    expect(count(app, "hidden={")).toBe(1);
    const style = between(app, "<style>", "</style>");
    expect(style).not.toMatch(/\[hidden\]/);
    expect(style).not.toMatch(/(^|[\s,>}])div\b/);
    expect(style).not.toMatch(/\.screen\s*>\s*(\*|div)/);
    // Post-convergence LOW 2: App's scoped rules reach the wrapper too, so none that could match it sets `display`.
    const rules = cssRules(style);
    expect(rules.length).toBeGreaterThan(10); // non-vacuous: the style block was parsed
    expect(rules.map((r) => r.selector)).toContain("main:has(:global(.deck)) > .screen");
    for (const r of rules) {
      if (couldMatchWrapper(r.selector)) expect([r.selector, /(^|[\s;])display\s*:/.test(r.body)]).toEqual([r.selector, false]);
    }
  });

  test("couldMatchWrapper (literal): a last compound with no class, id or type may match the wrapper", () => {
    const rows: [string, boolean][] = [
      [".screen :first-child", true],
      ["main > :not(nav)", true],
      [":global(.screen) > :first-child", true],
      [":global(.screen > :first-child)", true],
      ["*", true],
      ["[data-x]", true],
      ["a, :first-child", true],
      ["div.panel", true],
      [".screen > .card", true],
      ["main:has(:global(.deck)) > .screen", false],
      ["main:has(:global(.deck))", false],
      ["nav button.active", false],
      [".notice p", false],
      ["button:not(:disabled):hover", false],
      [":global(.deck)", false],
      ["header", false],
    ];
    for (const [selector, want] of rows) {
      expect({ selector, got: couldMatchWrapper(selector) }).toEqual({ selector, got: want });
    }
  });

  test("…and no unscoped rule anywhere gives it one: app.css, and every :global( rule under src (final harden r2, LOW 3)", () => {
    // app.css is unscoped: every rule there reaches the wrapper if its selector matches. Its `* { box-sizing }` does
    // match, so the claim is the property — no matching rule sets `display` — and no `[hidden]` rule at all.
    const appCss = cssRules(src("app.css"));
    expect(appCss.length).toBeGreaterThan(20); // non-vacuous: the sheet was parsed
    expect(appCss.map((r) => r.selector)).toContain("*"); // and the universal rule is among what is checked
    for (const r of appCss) {
      expect([r.selector, /\[hidden\]/.test(r.selector)]).toEqual([r.selector, false]);
      if (couldMatchWrapper(r.selector)) expect([r.selector, /(^|[\s;])display\s*:/.test(r.body)]).toEqual([r.selector, false]);
    }
    // Every component's `:global(` rule escapes its scope, so the same holds for each of them.
    const root = new URL("../src/", import.meta.url);
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".svelte"));
    expect(files).toContain("App.svelte");
    const globals: string[] = [];
    for (const f of files) {
      const text = readFileSync(new URL(f, root), "utf8");
      // No `:global {` block form, whose inner rules cssRules would not see as global.
      expect([f, /:global\s*\{/.test(text)]).toEqual([f, false]);
      const open = text.indexOf("<style>");
      if (open === -1) continue;
      for (const r of cssRules(between(text, "<style>", "</style>"))) {
        if (!r.selector.includes(":global(")) continue;
        globals.push(`${f}: ${r.selector}`);
        expect([f, r.selector, /\[hidden\]/.test(r.selector)]).toEqual([f, r.selector, false]);
        if (couldMatchWrapper(r.selector)) expect([f, r.selector, /(^|[\s;])display\s*:/.test(r.body)]).toEqual([f, r.selector, false]);
      }
    }
    expect(globals.length).toBeGreaterThan(5); // non-vacuous: the :global rules were found
    expect(globals).toContain("App.svelte: main:has(:global(.deck)) > .screen");
  });

  test("the chain keeps an empty wizard arm, so its bare {:else} still renders Settings and nothing else", () => {
    const arm = between(chain, '{:else if route === "wizard"}', "{:else}");
    expect(arm.replace('{:else if route === "wizard"}', "").replace(/<!--[\s\S]*?-->/g, "").trim()).toBe("");
    const tail = chain.slice(chain.lastIndexOf("{:else}"));
    expect(tail).toContain("<Settings\n");
    expect(tail).not.toContain("<Wizard");
  });

  test("the Setup tab renders through wizardTabShown", () => {
    const nav = between(app, "<nav>", "</nav>");
    expect(nav).toContain(
      '{#if wizardTabShown(route, snapshot?.scheduleState?.phase.phase, wizardOpen)}\n        <button class:active={route === "wizard"} onclick={() => (route = "wizard")}>Setup</button>\n      {/if}',
    );
    expect(nav).not.toContain('phase.phase === "not-configured"');
    expect(app).toMatch(/import \{[^}]*\bwizardTabShown\b[^}]*\} from "\.\/lib\/wizard";/);
  });
});

/* ── Wizard.svelte: the shown prop, the calendar step while hidden, focus ─────────────────────── */

describe("Wizard.svelte: shown is the required prop, and what it hides", () => {
  const wizard = src("routes/Wizard.svelte");
  const script = wizard.slice(0, wizard.indexOf("</script>"));
  const calendarStep = between(wizard, '{:else if step === "calendar"}', '{:else}\n    <div class="body">\n      {#if saved !== null}');

  test("shown: required (no ?), destructured with no default; the M2 constant is gone", () => {
    expect(script).toMatch(/\n    shown: boolean;\n/);
    const destructure = between(script, "let {", "}: Props = $props();");
    expect(destructure).toMatch(/\n    shown,\n/);
    expect(destructure).not.toMatch(/\bshown\s*=/);
    expect(script).not.toContain("const shown = ");
    // The verify loop still reads it (M2's pin).
    expect(wizard).toContain("suspended={!shown}");
  });

  test("{#if shown} occurs once in the template, inside the calendar step: delivery's body stays mounted while hidden (post-convergence LOW 3)", () => {
    const template = wizard
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    expect(template).toContain("<ScheduleInstall"); // non-vacuous: the delivery body is in what is scanned
    expect(template).toContain("<ScheduleVerify");
    expect(template.match(/\{#if\s+shown\b/g)).toEqual(["{#if shown"]);
    const step = between(template, '{:else if step === "calendar"}', '{:else}\n    <div class="body">\n      {#if saved !== null}');
    expect(step.match(/\{#if\s+shown\b/g)).toEqual(["{#if shown"]);
  });

  test("{#if shown} wraps the calendar step's whole body", () => {
    expect(calendarStep.startsWith('{:else if step === "calendar"}\n    {#if shown}\n      <div class="body">\n')).toBe(true);
    expect(calendarStep.trimEnd().endsWith("</div>\n    {/if}")).toBe(true);
    expect(count(calendarStep, "{#if shown}")).toBe(1);
    // CalendarQuestion and both CalendarSettings sit inside it.
    const body = between(calendarStep, "{#if shown}", "\n    {/if}\n");
    expect(count(body, "<CalendarQuestion ")).toBe(1);
    expect(count(body, "<CalendarSettings ")).toBe(2);
  });

  test("calendarEntryPending: one $state, set at exactly three sites — the first entry, a show on the step, Back from delivery", () => {
    expect(script).toContain("let calendarEntryPending = $state(false);");
    expect(count(wizard, "calendarEntryPending = true")).toBe(3);
    // 1. The first entry: the save moves to the calendar step (nextStep("floor") is always "calendar").
    const save = between(script, "async function saveOnce()", "\n  }\n");
    expect(save).toContain('step = nextStep("floor", accessInScope) ?? "delivery";\n      calendarEntryPending = true;');
    // 2. Shown again while on the step — final harden r1 (MED 1): in the show detector, a `$effect.pre`, so the flag is
    // set before the DOM update and `{#if shown}` never draws the previous entry's view for a flush. (MED 3: the same
    // show branch re-reads the login-item default while the box is untouched — pinned below.)
    expect(script).toContain(
      '  $effect.pre(() => {\n    if (!shown) {\n      hiddenSinceShown = true;\n    } else if (hiddenSinceShown) {\n      hiddenSinceShown = false;\n      if (untrack(() => step) === "calendar") calendarEntryPending = true;\n      if (loginDefaultRereads(untrack(() => loginChoice))) untrack(() => readLoginItemDefault());\n    }\n  });',
    );
    expect(script).toContain("let hiddenSinceShown = false;");
    // Final harden r2 (LOW 4): the declaration and the show detector's two writes, and no other write anywhere.
    expect(count(wizard, "hiddenSinceShown = ")).toBe(3);
    expect(wizard.match(/\bhiddenSinceShown\s*=(?!=)/g)).toEqual(["hiddenSinceShown =", "hiddenSinceShown =", "hiddenSinceShown ="]);
    // 3. Back, which lands on the calendar step only from delivery (narrow Back, D2).
    const row = between(wizard, '<div class="nav-row">', "</section>");
    expect(row).toContain(
      'step = previousStep(step, accessInScope) ?? "welcome";\n        if (step === "calendar") calendarEntryPending = true;',
    );
  });

  test("the entry effect: calendarEntryAction over the pending flag and the store; on enter it clears the flag, then reads (macOS and Linux)", () => {
    expect(script).toContain(
      '  $effect(() => {\n    if (calendarEntryAction({ pending: calendarEntryPending, running: calendarStore.flow.running, writesInFlight: calendarStore.writesInFlight }) !== "enter") return;\n    calendarEntryPending = false;\n    if (os === "macos" || os === "linux") untrack(() => void enterCalendarStep());\n  });',
    );
    expect(count(wizard, "calendarEntryPending = false")).toBe(1);
    expect(count(wizard, "calendarEntryAction(")).toBe(1);
    expect(count(wizard, "void enterCalendarStep()")).toBe(1);
    // The step's own question never re-enters it: nothing but the three sites sets the flag (above), and the old
    // effect on `step` alone is gone.
    expect(script).not.toContain('if (step === "calendar" && (os === "macos" || os === "linux"))');
  });

  test("the view waits on the pending flag (entryWaiting)", () => {
    expect(script).toContain(
      "const calendarView = $derived(wizardCalendarStep({ os, entry: calendarEntry, answer: calendarAnswer, running: calendarStore.flow.running, result: calendarStore.flow.result, entryWaiting: calendarEntryPending }));",
    );
  });
});

describe("Wizard.svelte: the step line takes focus on every step change and every show, never on the first mount", () => {
  const wizard = src("routes/Wizard.svelte");
  const script = wizard.slice(0, wizard.indexOf("</script>"));

  test("the step line is keyed on step, focusable, and focused through focusStepLine(firstMount, shown)", () => {
    const head = between(wizard, '<header class="head">', "</header>");
    expect(head).toContain(
      '    <h2>Set up Daily Briefing</h2>\n    {#key step}\n      <p class="muted" tabindex="-1" use:focusHeading={focusStepLine(firstMount, shown)}>{stepHeading(step, stepCtx)}</p>\n    {/key}\n',
    );
    expect(count(wizard, "focusStepLine(")).toBe(1);
  });

  test("firstMount: true until the first step change or the first hide, never set back", () => {
    expect(script).toContain("let firstMount = $state(true);");
    expect(script).toContain('  $effect(() => {\n    if (step !== "welcome" || !shown) firstMount = false;\n  });');
    expect(count(wizard, "firstMount = false")).toBe(1);
    expect(count(wizard, "firstMount = true")).toBe(0);
    expect(script).toContain('let step = $state<StepId>("welcome");');
  });

  test("the effects: the entry effect is still the first, so the enterCalendarStep and continueWithoutCalendar slices end there", () => {
    // Final harden r1 (MED 1): two plain effects (the entry, the focus flag) and ONE `$effect.pre`, the show detector
    // (`"$effect("` does not match `"$effect.pre("`, so the counts are disjoint).
    expect(count(script, "$effect(")).toBe(2);
    expect(count(script, "$effect.pre(")).toBe(1);
    expect(script.slice(script.indexOf("$effect.pre("), script.indexOf("$effect.pre(") + 60)).toContain("if (!shown) {");
    // No other rune of the family ($effect.root, $effect.tracking, ...): three effect calls in all.
    expect(wizard.match(/\$effect(\.\w+)?\(/g)).toEqual(["$effect(", "$effect.pre(", "$effect("]);
    const first = script.indexOf("$effect(");
    expect(script.slice(first, first + 60)).toContain("calendarEntryAction(");
    expect(script.indexOf("async function enterCalendarStep(")).toBeLessThan(first);
    expect(script.indexOf("function continueWithoutCalendar(")).toBeLessThan(first);
  });
});

describe("Wizard.svelte: the login-item default is read again on a show while the box is untouched (final harden r1, MED 3)", () => {
  const wizard = src("routes/Wizard.svelte");
  const script = wizard.slice(0, wizard.indexOf("</script>"));

  test("readLoginItemDefault: back to pending, then a read whose reply lands only if no newer read started", () => {
    expect(script).toContain("let loginReads = 0;");
    expect(script).toContain(
      '  function readLoginItemDefault(): void {\n    const mine = ++loginReads;\n    loginDefault = { kind: "pending" };\n    void settleLoginItemDefault(() => autostartWizardDefault(), describeFailure).then((settled) => {\n      if (mine === loginReads) loginDefault = settled;\n    });\n  }\n',
    );
    // The counter is bumped in this one place and compared in this one place; the read is the one IPC call site.
    expect(count(wizard, "++loginReads")).toBe(1);
    expect(count(wizard, "mine === loginReads")).toBe(1);
    expect(count(wizard, "settleLoginItemDefault(")).toBe(1);
    // The declaration and exactly two callers: the first mount, and the show branch of the show detector (pinned whole
    // above).
    expect(count(wizard, "readLoginItemDefault()")).toBe(3);
    expect(count(wizard, "function readLoginItemDefault(): void {")).toBe(1);
    expect(count(wizard, "\n    readLoginItemDefault();\n")).toBe(1);
    expect(count(wizard, "untrack(() => readLoginItemDefault())")).toBe(1);
    const mount = between(script, "onMount(() => {\n    void configRead()", "\n  });");
    expect(mount).toContain("\n    readLoginItemDefault();");
    const show = between(script, "  $effect.pre(() => {", "\n  });");
    const branch = between(show, "} else if (hiddenSinceShown) {", "\n    }");
    expect(branch).toContain("if (loginDefaultRereads(untrack(() => loginChoice))) untrack(() => readLoginItemDefault());");
    // Only the read and the user set the default and the choice: nothing else writes either (each count includes the
    // `let … = $state` declaration).
    expect(count(wizard, "loginDefault = ")).toBe(3);
    expect(count(wizard, "loginChoice = ")).toBe(2);
    expect(wizard).toContain("onchange={(e) => (loginChoice = e.currentTarget.checked)}");
  });

  test("while it is pending again Finish waits (the plan is wait) and the box shows the checking note", () => {
    expect(wizard).toContain('<button disabled={nav.finish.disabled || loginPlan.kind === "wait"} onclick={() => void finish()}>');
    expect(wizard).toContain("{#if loginItemNote(loginDefault, loginChoice) !== null}");
  });
});
