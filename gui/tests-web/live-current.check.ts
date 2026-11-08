/**
 * Briefing redesign wave 2, W2-S-T1 — the deck's current slide and the user's moves (`src/lib/live-current.ts`), and
 * where `DeckOrClassic.svelte` and `Today.svelte` use them (plan §1.2, "The current slide (webview)").
 *
 * - `currentSlide` is WHAT is current: `null` unless the slides are on, the deck is the slides and Full briefing is not
 *   open; otherwise the slide at `nav.index`. It is reported through `oncurrent` and is never read as "the user moved".
 * - `moveRules` is WHEN the user moved: one object per mount, holding the one "drawn" flag, used at `onmove`'s three
 *   sites (a navigation through `dispatch`, Back to slides, and the deck's first draw in the mount). Its rules are
 *   tested here as SEQUENCES on one `moveRules()`, as the component calls them; the call sites are source pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { renderBriefing } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { deckView, type DeckView, type SlideId } from "../src/lib/deck";
import { currentSlide, moveRules, type Move } from "../src/lib/live-current";
import { listChange } from "../src/lib/deck-state";
import { todayModel, type LatestLoad } from "../src/lib/today";

const TODAY = "2026-10-16";

const page = (s: Partial<EngineStruct> = {}): string =>
  renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], ...s });

const view = (latest: LatestLoad): DeckView => {
  const model = todayModel({ snapshot: null, latest, lastRun: null, today: TODAY });
  return deckView({ model, today: TODAY, firstName: null });
};
const file = (text: string): LatestLoad => ({ state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } });

/** A's slide list, from the real `deckView`: with a calendar section (six slides) and without (five). */
const WITH_CAL = view(file(page({ calendar: { events: [], sources: [], incomplete: false } } as Partial<EngineStruct>)));
const WITHOUT_CAL = view(file(page()));

/** A source as code: comments removed, so a commented-out copy never satisfies a pin. */
const codeOf = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|[ \t])\/\/[^\n]*/gm, "$1");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const SHELL = flat(codeOf(readFileSync(new URL("../src/lib/deck/DeckOrClassic.svelte", import.meta.url), "utf8")));
const TODAY_SRC = flat(codeOf(readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8")));
const count = (s: string, needle: string): number => s.split(needle).length - 1;
/** The body of `function <name>(` up to the next top-level `function ` or `$effect`. */
const fnBody = (src: string, head: string): string => {
  const at = src.indexOf(head);
  expect({ head, found: at > -1 }).toEqual({ head, found: true });
  const rest = src.slice(at + head.length);
  const ends = [rest.indexOf(" function "), rest.indexOf(" $effect"), rest.indexOf("</script>")].filter((i) => i > -1);
  return src.slice(at, at + head.length + Math.min(...ends));
};

describe("currentSlide: what is current", () => {
  test("PREMISE: A's slide list, six slides with a calendar section and five without", () => {
    expect(WITH_CAL.kind === "slides" && WITH_CAL.slides).toEqual(["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"]);
    expect(WITHOUT_CAL.kind === "slides" && WITHOUT_CAL.slides).toEqual(["goodMorning", "whatYouDid", "leftOff", "suggested", "launchpad"]);
  });

  test("null with the slides switched off, on the classic (cannot-map) view, on every one-slide state, and with Full briefing open", () => {
    expect(currentSlide({ slides: false, deck: WITH_CAL, classic: false, index: 0 })).toBeNull();
    expect(currentSlide({ slides: true, deck: { kind: "classic", reason: "no-title", line: "" }, classic: false, index: 0 })).toBeNull();
    for (const latest of [{ state: "loading" }, { state: "error", message: "/p is a symbolic link" }, { state: "none" }] as LatestLoad[]) {
      const single = view(latest);
      expect({ latest: latest.state, kind: single.kind }).toEqual({ latest: latest.state, kind: "single" });
      expect({ latest: latest.state, slide: currentSlide({ slides: true, deck: single, classic: false, index: 0 }) }).toEqual({ latest: latest.state, slide: null });
    }
    expect(currentSlide({ slides: true, deck: WITH_CAL, classic: true, index: 4 })).toBeNull();
  });

  test("otherwise the slide at the index; null for an index past the list", () => {
    const ids = (d: DeckView): SlideId[] => (d.kind === "slides" ? d.slides : []);
    for (const d of [WITH_CAL, WITHOUT_CAL]) {
      ids(d).forEach((id, index) => expect(currentSlide({ slides: true, deck: d, classic: false, index })).toBe(id));
      expect(currentSlide({ slides: true, deck: d, classic: false, index: ids(d).length })).toBeNull();
      expect(currentSlide({ slides: true, deck: d, classic: false, index: -1 })).toBeNull();
    }
    // The calendar slide and the launchpad at their indices, with and without a calendar section.
    expect(currentSlide({ slides: true, deck: WITH_CAL, classic: false, index: 4 })).toBe("calendar");
    expect(currentSlide({ slides: true, deck: WITH_CAL, classic: false, index: 5 })).toBe("launchpad");
    expect(currentSlide({ slides: true, deck: WITHOUT_CAL, classic: false, index: 4 })).toBe("launchpad");
  });
});

describe("moveRules: onmove's rules, as sequences on one moveRules()", () => {
  const SIX: SlideId[] = ["goodMorning", "whatYouDid", "leftOff", "suggested", "calendar", "launchpad"];

  test("dispatched: a move when the index changed, with the new slide and the old one", () => {
    const m = moveRules();
    expect(m.dispatched(0, 1, SIX)).toEqual({ slide: "whatYouDid", from: "goodMorning" });
    // The calendar slide to the launchpad: `from` tells a move between the two apart.
    expect(m.dispatched(4, 5, SIX)).toEqual({ slide: "launchpad", from: "calendar" });
    expect(m.dispatched(5, 4, SIX)).toEqual({ slide: "calendar", from: "launchpad" });
    expect(m.dispatched(0, 4, SIX)).toEqual({ slide: "calendar", from: "goodMorning" });
  });

  test("dispatched: no move when the index did not change (toggle, openAll, closeAll, a jump to the same index, next at the last slide)", () => {
    const m = moveRules();
    for (const i of [0, 3, 5]) expect(m.dispatched(i, i, SIX)).toBeNull();
    // …and no index change marks nothing: the first draw still emits.
    expect(m.drawn("goodMorning")).toEqual({ slide: "goodMorning", from: null });
  });

  test("the kept-Full-briefing remount (P5-H1): classic view, Back to slides, the slides draw — exactly ONE move", () => {
    const m = moveRules();
    const moves: (Move | null)[] = [m.drawn(null), m.backToSlides("launchpad"), m.drawn("launchpad")];
    expect(moves).toEqual([null, { slide: "launchpad", from: null }, null]);
    expect(moves.filter((x) => x !== null)).toHaveLength(1);
  });

  test("the ordinary mount: loading, then the first draw — one move; a later draw after a read error and recovery — none", () => {
    const m = moveRules();
    expect(m.drawn(null)).toBeNull();
    expect(m.drawn("calendar")).toEqual({ slide: "calendar", from: null });
    expect(m.drawn(null)).toBeNull();   // the read error: the deck goes one-slide
    expect(m.drawn("calendar")).toBeNull();   // …and back
  });

  test("a first read that errors before any draw still emits once, onto the slide then shown (round 5, LOW)", () => {
    const m = moveRules();
    expect([m.drawn(null), m.drawn(null), m.drawn("calendar"), m.drawn("calendar")]).toEqual([null, null, { slide: "calendar", from: null }, null]);
  });

  test("a dispatched move before any draw also marks the mount: a later draw gives null", () => {
    const m = moveRules();
    expect(m.dispatched(0, 1, SIX)).toEqual({ slide: "whatYouDid", from: "goodMorning" });
    expect(m.drawn("whatYouDid")).toBeNull();
    // Each move the user makes is still a move.
    expect(m.dispatched(1, 2, SIX)).toEqual({ slide: "leftOff", from: "whatYouDid" });
  });

  test("Back to slides: a move only with a current slide; with none it marks nothing", () => {
    const m = moveRules();
    expect(m.backToSlides(null)).toBeNull();
    expect(m.drawn("goodMorning")).toEqual({ slide: "goodMorning", from: null });
    expect(m.backToSlides("suggested")).toEqual({ slide: "suggested", from: null });   // every Back to slides is a move
  });

  test("each moveRules() is its own mount: a new one emits its first draw again", () => {
    const a = moveRules();
    expect(a.drawn("calendar")).not.toBeNull();
    const b = moveRules();
    expect(b.drawn("calendar")).toEqual({ slide: "calendar", from: null });
    expect(a.drawn("calendar")).toBeNull();
  });
});

describe("PB-M1-T3: a remap or a removal is not a move", () => {
  test("after the first draw, the list-change path calls no rule, and the first-draw rule stays silent for the new current slide", () => {
    const m = moveRules();
    const five = WITHOUT_CAL.slides as readonly SlideId[];
    const six = WITH_CAL.slides as readonly SlideId[];
    expect(m.drawn(five[4]!)).toEqual({ slide: "launchpad", from: null });
    // The calendar slide added before the launchpad: a remap (no rule is called on that path, by source in
    // deck-render.check.ts); the current-slide effect re-runs with the same slide, and drawn gives nothing.
    const r = listChange({ prev: five, index: 4, next: six, quiet: null, glide: true });
    expect(r.kind).toBe("remap");
    expect(m.drawn(six[r.index]!)).toBeNull();
    // The calendar slide removed while current: its neighbour, and still nothing.
    const gone = listChange({ prev: six, index: 4, next: five, quiet: null, glide: true });
    expect(gone.kind).toBe("removed");
    expect(m.drawn(five[gone.index]!)).toBeNull();
    // A user move after either is still a move.
    expect(m.dispatched(gone.index, 3, five)).toEqual({ slide: "suggested", from: "launchpad" });
  });
});

describe("DeckOrClassic: oncurrent and onmove, by source", () => {
  test("the two optional props", () => {
    expect(SHELL).toContain("oncurrent?: ((slide: SlideId | null) => void) | undefined;");
    expect(SHELL).toContain("onmove?: ((slide: SlideId, from: SlideId | null) => void) | undefined;");
    expect(SHELL).toMatch(/let \{[^}]* oncurrent, onmove \}: Props = \$props\(\);/);
  });

  test("oncurrent is called once, untracked inside a $effect, with tracked currentSlide over the slides switch, the deck, the classic view and nav.index", () => {
    expect(count(SHELL, "oncurrent?.(")).toBe(1);
    expect(SHELL).toContain("$effect(() => { const slide = currentSlide({ slides, deck, classic, index: nav.index }); untrack(() => oncurrent?.(slide)); });");
  });

  test("both effect callbacks run inside untrack so their reads are not effect dependencies", () => {
    expect(SHELL).toContain("untrack(() => oncurrent?.(slide));");
    expect(SHELL).toContain("untrack(() => onmove?.(m.slide, m.from));");
  });

  test("dispatch's exact body: the move is taken from the OLD index, before `nav = next;`, and emitted after keep()", () => {
    const body = fnBody(SHELL, "function dispatch(a: DeckAction): void {");
    expect(body).toMatch(
      /^function dispatch\(a: DeckAction\): void \{ const next = deckReducer\(nav, a\); if \(next\.index !== nav\.index\) \{ landing = "slideHeading"; glide = true; quiet = null; \} const m = moves\.dispatched\(nav\.index, next\.index, deck\.kind === "slides" \? deck\.slides : \[\]\); nav = next; keep\(\); if \(m !== null\) onmove\?\.\(m\.slide, m\.from\); \}\s*$/,
    );
  });

  test("onmove's three call sites, and no other: dispatch (moves.dispatched), showClassic under !on (moves.backToSlides), the first-draw $effect (tracked moves.drawn, untracked callback)", () => {
    expect(count(SHELL, "onmove?.(")).toBe(3);
    expect(count(SHELL, "onmove?.(m.slide, m.from)")).toBe(3);
    const show = fnBody(SHELL, "function showClassic(on: boolean): void {");
    expect(show).toContain(
      "keep(); if (!on) { const m = moves.backToSlides(currentSlide({ slides, deck, classic, index: nav.index })); if (m !== null) onmove?.(m.slide, m.from); } }",
    );
    expect(SHELL).toContain("$effect(() => { const m = moves.drawn(currentSlide({ slides, deck, classic, index: nav.index })); if (m !== null) untrack(() => onmove?.(m.slide, m.from)); });");
    // Each rule is called once, at its own site.
    for (const rule of ["moves.dispatched(", "moves.backToSlides(", "moves.drawn("]) expect({ rule, n: count(SHELL, rule) }).toEqual({ rule, n: 1 });
  });

  test("none in the key-change $effect.pre or the run rule; one moveRules() at the top level; no other drawn flag", () => {
    const pre = SHELL.slice(SHELL.indexOf("$effect.pre("), SHELL.indexOf("function keep(): void"));
    expect(pre).toContain("if (key !== shownKey) {");
    expect(pre).toContain("const jump = runJumpNow(");
    expect(pre).not.toContain("onmove");
    expect(pre).not.toContain("moves.");
    expect(count(SHELL, "moveRules(")).toBe(1);
    expect(SHELL).toContain("const moves = moveRules();");
    // At the component's top level: before the first function, outside every effect and handler.
    expect(SHELL.indexOf("const moves = moveRules();")).toBeLessThan(SHELL.indexOf(" function "));
    expect(SHELL).toContain('import { currentSlide, moveRules } from "../live-current";');
    expect(SHELL).not.toMatch(/\b(drawn|firstDraw|hasDrawn|didDraw)\s*=/);
  });
});

describe("Today: the current slide and the four driver points, by source", () => {
  test("`current` and onCurrent, which returns at once when the slide is already current", () => {
    expect(TODAY_SRC).toContain("let current = $state<SlideId | null>(null);");
    expect(TODAY_SRC).toContain("function onCurrent(slide: SlideId | null): void { if (slide === current) return; current = slide;");
  });

  test("onMove, onMinute and onFocus; the tick and the window's focus call them; DeckOrClassic gets oncurrent and onmove", () => {
    expect(TODAY_SRC).toContain("function onMove(slide: SlideId, from: SlideId | null): void {");
    expect(TODAY_SRC).toContain("function onMinute(): void { now = Date.now();");
    expect(TODAY_SRC).toContain("function onFocus(): void { now = Date.now();");
    expect(TODAY_SRC).toContain("const tick = setInterval(onMinute, 60_000);");
    expect(TODAY_SRC).toContain("<svelte:window onfocus={onFocus} />");
    expect(TODAY_SRC).toMatch(/<DeckOrClassic [^>]* oncurrent=\{onCurrent\} onmove=\{onMove\} \/>/);
    expect(TODAY_SRC).toContain('import { deckView, type SlideId } from "../lib/deck";');
  });
});
