/**
 * v0.2.1 §3.2 — the morning-time picker: two dropdowns in the wizard and in Settings, and the GUI's
 * mirror of the engine's `parseFloor`, which decides what they show for a stored value.
 *
 * ⚠ THE GOLDEN IS THE ENGINE. `lib/morning-time.ts` repeats `parseFloor` (`src/schedule.ts`) rule for
 * rule. It is pinned twice here: to the engine SOURCE, read as text (the regex literal, the trim,
 * the bounds — the style of the first-wake sentence's drift test in `wizard.check.ts`), and to the
 * engine FUNCTION, imported read-only (`src/schedule.ts` is pure) and run over a corpus beside the
 * mirror.
 *
 * ⚠ WHAT THIS HARNESS CANNOT EXECUTE. The components are server-rendered with no DOM, so no event
 * handler runs here: a dropdown's `onchange` and the "Use HH:MM" button's `onclick` are pinned by
 * source, and the model functions they call (`writeField`, `readTime`, `formSubmission`, `isDirty`)
 * are driven directly. The wizard renders only its first step on the server (its step is internal
 * state), so the morning-time step's markup is pinned through the shared `MorningTimeSelect`
 * component — rendered here — and through `Wizard.svelte`'s source for that step.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

// READ-ONLY engine import: `src/schedule.ts` is pure (no I/O at import or call time).
import { DEFAULT_MORNING_TIME as ENGINE_DEFAULT, parseFloor } from "../../src/schedule";
import {
  DEFAULT_MORNING_TIME,
  HOURS,
  MINUTES,
  MORNING_TIME_PATTERN,
  parseMorningTime,
  storedTimeNote,
  unparseableNote,
} from "../src/lib/morning-time";
import MorningTimeSelect from "../src/lib/MorningTimeSelect.svelte";
import {
  formSubmission,
  getPath,
  isDirty,
  readField,
  readTime,
  SECTIONS,
  writeField,
  type Draft,
  type Field,
} from "../src/lib/settings-model";
import { draftFromConfig, emptyDraft, floorValid, mergeConfig, savePlan, stepBlocker } from "../src/lib/wizard";
import SettingsForm from "../src/routes/SettingsForm.svelte";

const HOSTILE = '<img src=x onerror="alert(1)">';
const FULL = readFileSync(new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url), "utf8");
const UNREADABLE = "The stored morning time \"7:5\" wasn't understood; the engine uses 07:20.";

const flat = (body: string): string => body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");

function picker(value: string, id = "t"): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return flat(render(MorningTimeSelect as any, { props: { id, value, onchange: () => {} } }).body);
}

function formHtml(draft: Draft): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return flat(
    render(SettingsForm as any, {
      props: { draft, errors: {}, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {} },
    }).body,
  );
}

const field = (id: string): Field => {
  const f = SECTIONS.flatMap((s) => s.fields).find((x) => x.id === id);
  if (f === undefined) throw new Error(`no field ${id}`);
  return f;
};
const MORNING = field("morningTime");

/** FULL with `morningTime` replaced (or removed, for `undefined`), as the file's own text. */
function withMorning(value: unknown): string {
  const d = JSON.parse(FULL) as Draft;
  if (value === undefined) delete d.morningTime;
  else d.morningTime = value;
  return JSON.stringify(d, null, 2);
}

/** The `{…}` block of a template branch: from `start` to the next `{:else` at the same indent. */
function branch(source: string, start: string): string {
  const at = source.indexOf(start);
  expect({ start, found: at >= 0 }).toEqual({ start, found: true });
  const rest = source.slice(at + start.length);
  return rest.slice(0, rest.search(/\n\s*\{:else/));
}

/* ── the mirror: pinned to the engine source and to the engine function ───────────────────────── */

describe("the mirror is parseFloor", () => {
  const engine = readFileSync(new URL("../../src/schedule.ts", import.meta.url), "utf8");
  const fn = engine.slice(engine.indexOf("export function parseFloor("), engine.indexOf("export function isPastFloor("));
  const mirror = readFileSync(new URL("../src/lib/morning-time.ts", import.meta.url), "utf8");

  test("the regex literal, the trim and the bounds are the engine's, read from src/schedule.ts", () => {
    expect(fn.length).toBeGreaterThan(100);
    // The engine's literal, applied to the trimmed value — the mirror's pattern has the same source
    // and no flags, and the mirror applies it to the trimmed value too.
    const literal = /\/(\^[^/\n]*\$)\/([a-z]*)\.exec\(morningTime\.trim\(\)\)/.exec(fn);
    expect(literal).not.toBeNull();
    expect(MORNING_TIME_PATTERN.source).toBe(literal![1]!);
    expect(MORNING_TIME_PATTERN.flags).toBe(literal![2]!);
    expect(mirror).toContain("MORNING_TIME_PATTERN.exec(stored.trim())");
    // The bounds, and what a non-match reads as — the same line in both.
    const bounds = "if (!m || hh < 0 || hh > 23 || mm < 0 || mm > 59)";
    expect(fn).toContain(bounds);
    expect(mirror).toContain(bounds);
    for (const line of ["const hh = m ? Number(m[1]) : NaN;", "const mm = m ? Number(m[2]) : NaN;"]) {
      expect(fn).toContain(line);
      expect(mirror).toContain(line);
    }
    // Absent: the default, no warning. Any other non-string: the default, with a warning.
    expect(fn).toContain("if (morningTime === undefined) return { minutes: def };");
    expect(mirror).toContain("if (stored === undefined) return { ...fallback, unparseable: false };");
    expect(fn).toContain('if (typeof morningTime !== "string") {');
    expect(mirror).toContain('if (typeof stored !== "string") return fallback;');
    expect(DEFAULT_MORNING_TIME).toBe(ENGINE_DEFAULT);
  });

  test("the pin can fail: a different literal or bound is not accepted", () => {
    const drifted = fn.replace("(\\d{1,2})", "(\\d{2})").replace("hh > 23", "hh > 24");
    expect(drifted).not.toBe(fn);
    const literal = /\/(\^[^/\n]*\$)\/([a-z]*)\.exec\(morningTime\.trim\(\)\)/.exec(drifted);
    expect(literal![1]).not.toBe(MORNING_TIME_PATTERN.source);
    expect(drifted).not.toContain("if (!m || hh < 0 || hh > 23 || mm < 0 || mm > 59)");
  });

  test("the mirror and parseFloor agree on every value of a corpus", () => {
    const corpus: unknown[] = [
      undefined, "07:05", "7:05", " 07:05 ", "\t7:05\n", " 7:05", "7:5", "07:5", "25:00", "24:00",
      "23:59", "00:00", "0:00", "00:60", "07:60", "007:05", "07:005", "+7:05", "-1:00", "7:05pm",
      "07.05", "07:05:00", "Ab:cd", "", " ", ":", "１２:００", "٠٧:٠٥", "9:59", "19:00", "07:20",
      720, 0, null, true, false, {}, [], ["07:05"], { hh: 7 }, HOSTILE,
    ];
    for (const v of corpus) {
      const engine = parseFloor(v as string);
      const mine = parseMorningTime(v);
      expect({ v, minutes: mine.hour * 60 + mine.minute, warns: mine.unparseable }).toEqual({
        v,
        minutes: engine.minutes,
        warns: engine.warning !== undefined,
      });
      expect(mine.hhmm).toBe(`${String(mine.hour).padStart(2, "0")}:${String(mine.minute).padStart(2, "0")}`);
    }
  });

  test("standard means floorValid's HH:MM: the stored value IS its own reading", () => {
    for (const v of ["07:05", "00:00", "23:59", "7:05", " 07:05 ", "7:5", "24:00", "", "07:60", "0720"]) {
      const t = parseMorningTime(v);
      expect({ v, standard: !t.unparseable && t.hhmm === v }).toEqual({ v, standard: floorValid(v) });
    }
  });
});

/* ── the round trips the spec names ───────────────────────────────────────────────────────────── */

describe("what the dropdowns show for a stored value", () => {
  test("07:05 → 07:05, nothing to say", () => {
    expect(parseMorningTime("07:05")).toEqual({ hour: 7, minute: 5, hhmm: "07:05", unparseable: false });
    expect(storedTimeNote("07:05")).toBeNull();
  });

  test("7:05 (lenient) → shows 07:05, with a note that it is not written as HH:MM", () => {
    expect(parseMorningTime("7:05")).toEqual({ hour: 7, minute: 5, hhmm: "07:05", unparseable: false });
    expect(storedTimeNote("7:05")).toBe(
      'The stored morning time "7:05" is not written as HH:MM; the engine reads it as 07:05.',
    );
    expect(parseMorningTime(" 07:05 ").hhmm).toBe("07:05");
    expect(storedTimeNote(" 07:05 ")).not.toBeNull();
    expect(unparseableNote("7:05")).toBeNull();
  });

  test("7:5 (unparseable) → 07:20, the time the engine uses, with spec §3.2's note", () => {
    expect(parseMorningTime("7:5")).toEqual({ hour: 7, minute: 20, hhmm: "07:20", unparseable: true });
    expect(unparseableNote("7:5")).toBe(UNREADABLE);
    expect(storedTimeNote("7:5")).toBe(UNREADABLE);
    for (const bad of ["25:00", "Ab:cd", ""]) expect(parseMorningTime(bad).hhmm).toBe("07:20");
    // A non-string is named by its JSON.
    expect(unparseableNote(720)).toBe("The stored morning time \"720\" wasn't understood; the engine uses 07:20.");
    expect(unparseableNote(null)).toContain('"null"');
  });

  test("absent → the engine's default, and nothing to say", () => {
    expect(parseMorningTime(undefined)).toEqual({ hour: 7, minute: 20, hhmm: "07:20", unparseable: false });
    expect(storedTimeNote(undefined)).toBeNull();
    expect(unparseableNote(undefined)).toBeNull();
  });
});

/* ── the shared picker ────────────────────────────────────────────────────────────────────────── */

describe("MorningTimeSelect: an hour and a minute dropdown, 24-hour", () => {
  test("00–23 and 00–59, the shown time selected, ids for a label", () => {
    expect(HOURS).toHaveLength(24);
    expect(HOURS[0]).toBe("00");
    expect(HOURS[23]).toBe("23");
    expect(MINUTES).toHaveLength(60);
    expect(MINUTES[59]).toBe("59");
    const body = picker("07:05", "f-x");
    const selects = [...body.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)];
    expect(selects).toHaveLength(2);
    const [hour, minute] = selects as [RegExpMatchArray, RegExpMatchArray];
    expect(hour[1]).toContain('id="f-x"');
    expect(minute[1]).toContain('id="f-x-minute"');
    expect(minute[1]).toContain('aria-label="Minute"');
    const options = (s: string) => [...s.matchAll(/<option value="(\d\d)"[^>]*>(\d\d)<\/option>/g)].map((m) => m[1]);
    expect(options(hour[2]!)).toEqual(HOURS);
    expect(options(minute[2]!)).toEqual(MINUTES);
    const selected = (s: string) => [...s.matchAll(/<option value="(\d\d)"[^>]*\bselected\b[^>]*>/g)].map((m) => m[1]);
    expect(selected(hour[2]!)).toEqual(["07"]);
    expect(selected(minute[2]!)).toEqual(["05"]);
    // …and it follows the value.
    const late = picker("23:59");
    expect(selected(late)).toEqual(["23", "59"]);
    // No free-text input at all.
    expect(body).not.toContain("<input");
  });

  test("a change hands the caller the new HH:MM: the hour keeps the minute, the minute keeps the hour", () => {
    const source = readFileSync(new URL("../src/lib/MorningTimeSelect.svelte", import.meta.url), "utf8");
    expect(source).toContain("onchange={(e) => onchange(`${e.currentTarget.value}:${minute}`)}");
    expect(source).toContain("onchange={(e) => onchange(`${hour}:${e.currentTarget.value}`)}");
    expect(source).toContain("const hour = $derived(value.slice(0, 2));");
    expect(source).toContain("const minute = $derived(value.slice(3, 5));");
  });
});

/* ── the wizard ───────────────────────────────────────────────────────────────────────────────── */

describe("the wizard's morning-time step", () => {
  test("a re-run seed is NORMALISED, so Next is never blocked by a value the user cannot see", () => {
    const cases: [unknown, string, string | null][] = [
      ["07:05", "07:05", null],
      ["7:05", "07:05", null],
      [" 07:05 ", "07:05", null],
      ["7:5", "07:20", UNREADABLE],
      ["25:00", "07:20", "The stored morning time \"25:00\" wasn't understood; the engine uses 07:20."],
      [720, "07:20", "The stored morning time \"720\" wasn't understood; the engine uses 07:20."],
      [undefined, "07:20", null],
    ];
    for (const [stored, floor, note] of cases) {
      const draft = draftFromConfig(withMorning(stored));
      expect({ stored, floor: draft?.floor, note: draft?.floorNote }).toEqual({ stored, floor, note });
      expect({ stored, blocker: stepBlocker("floor", draft!) }).toEqual({ stored, blocker: null });
    }
    expect(emptyDraft().floorNote).toBeNull();
  });

  test("a re-run saves the normalised value — what the engine already uses — and an HH:MM one unchanged", () => {
    const lenient = withMorning("7:05");
    expect((mergeConfig(lenient, draftFromConfig(lenient)!) as Draft)["morningTime"]).toBe("07:05");
    const unreadable = withMorning("7:5");
    expect((mergeConfig(unreadable, draftFromConfig(unreadable)!) as Draft)["morningTime"]).toBe("07:20");
    // The untouched re-run of an HH:MM config stays the save path's byte-identical no-op.
    const plan = savePlan({ exists: true, text: FULL, base: "tok" }, draftFromConfig(FULL)!);
    expect((plan as { text: string }).text).toBe(FULL);
    // The note is display only: never a config key.
    expect(Object.keys(mergeConfig(unreadable, draftFromConfig(unreadable)!))).not.toContain("floorNote");
  });

  test("the step uses the shared dropdowns, labelled \"Morning time\" — no free-text time input", () => {
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    const step = branch(wizard, '{:else if step === "floor"}');
    expect(step).toContain('<label for="wizard-morning-time">Morning time</label>');
    expect(step).toContain('<MorningTimeSelect id="wizard-morning-time" value={draft.floor}');
    // Picking a time clears the unparseable note: it names the stored value, which the pick replaced.
    expect(step).toContain("onchange={(hhmm) => { draft.floor = hhmm; draft.floorNote = null; }} />");
    // The unparseable note is interpolated as text.
    expect(step).toContain('{#if draft.floorNote !== null}\n        <p class="warn-text">{draft.floorNote}</p>');
    // spec §3.1 keeps the "earliest, not exact" sentence.
    expect(step).toContain("This is the <strong>earliest</strong> time, not an\n        exact one.");
    expect(step).not.toContain("<input");
    expect(step).not.toContain("Earliest time");
    expect(wizard).not.toContain("draft.floor = e.currentTarget.value");
    // The step's markup is the picker's — rendered above; here it is the wizard's value, shown.
    expect(picker(draftFromConfig(withMorning("7:05"))!.floor)).toContain('<option value="05" selected');
  });
});

/* ── Settings ─────────────────────────────────────────────────────────────────────────────────── */

describe("the Settings field", () => {
  test("is the `time` kind, labelled \"Morning time\", rendered as the two dropdowns", () => {
    expect(MORNING.kind).toBe("time");
    expect(MORNING.label).toBe("Morning time");
    expect(MORNING.path).toEqual(["morningTime"]);
    const body = formHtml(JSON.parse(withMorning("06:45")) as Draft);
    expect(body).toMatch(/<label for="f-morningTime"[^>]*>Morning time<\/label>/);
    expect(body).toMatch(/<select id="f-morningTime"[^>]*>/);
    expect(body).toMatch(/<select id="f-morningTime-minute"[^>]*>/);
    expect(body).toMatch(/<option value="06"[^>]*selected/);
    expect(body).toMatch(/<option value="45"[^>]*selected/);
    // No free-text input for this field any more.
    expect(body).not.toMatch(/<input[^>]*id="f-morningTime"/);
    // An HH:MM value has no note and no button.
    expect(body).not.toContain("Use HH:MM");
    expect(body).not.toContain("The stored morning time");
  });

  test("a non-standard stored value: shown the engine's way, a note, and a \"Use HH:MM\" button", () => {
    const lenient = formHtml(JSON.parse(withMorning("7:05")) as Draft);
    expect(lenient).toMatch(/<option value="07"[^>]*selected/);
    expect(lenient).toMatch(/<option value="05"[^>]*selected/);
    expect(lenient).toContain('The stored morning time "7:05" is not written as HH:MM; the engine reads it as 07:05.');
    expect(lenient).toMatch(/<button type="button"[^>]*>Use HH:MM<\/button>/);

    const unreadable = formHtml(JSON.parse(withMorning("7:5")) as Draft);
    expect(unreadable).toMatch(/<option value="20"[^>]*selected/);
    expect(unreadable).toContain("The stored morning time \"7:5\" wasn't understood; the engine uses 07:20.");
    expect(unreadable).toContain("Use HH:MM");

    // The stored value is untrusted text: escaped, never markup.
    const hostile = formHtml(JSON.parse(withMorning(HOSTILE)) as Draft);
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;img src=x");
  });

  test("an untouched non-standard value is not dirty, and a save of another field does not rewrite it", () => {
    for (const stored of ["7:05", "7:5", " 07:05 "]) {
      const text = withMorning(stored);
      const draft = JSON.parse(text) as Draft;
      // Reading it for display writes nothing.
      expect(readTime(draft, MORNING).hhmm).toBe(parseMorningTime(stored).hhmm);
      expect(readField(draft, MORNING)).toBe(stored);
      expect(getPath(draft, ["morningTime"])).toBe(stored);
      expect(formSubmission(draft, text, {})).toEqual({ kind: "unchanged" });
      expect(isDirty({ base: "b", loadedText: text, tab: "form", draft, raw: text, errors: {} })).toBe(false);
      // Another field saved: the stored morning time rides through raw.
      expect(writeField(draft, field("lookbackCapDays"), "5")).toBeNull();
      const sent = formSubmission(draft, text, {});
      expect(sent.kind).toBe("save");
      expect((JSON.parse((sent as { text: string }).text) as Draft)["morningTime"]).toBe(stored);
    }
  });

  test("the button writes the displayed value: the field becomes dirty with HH:MM", () => {
    const form = readFileSync(new URL("../src/routes/SettingsForm.svelte", import.meta.url), "utf8");
    expect(form).toContain("{@const time = readTime(draft, field)}");
    expect(form).toContain('<button type="button" onclick={() => onfield(field, time.hhmm)}>Use HH:MM</button>');
    expect(form).toContain("onchange={(hhmm) => onfield(field, hhmm)}");
    // What that click does, through the same callback Settings.svelte wires (`writeField`).
    for (const [stored, shown] of [["7:05", "07:05"], ["7:5", "07:20"]] as const) {
      const text = withMorning(stored);
      const draft = JSON.parse(text) as Draft;
      expect(writeField(draft, MORNING, readTime(draft, MORNING).hhmm)).toBeNull();
      expect(getPath(draft, ["morningTime"])).toBe(shown);
      expect(readTime(draft, MORNING).note).toBeNull();
      expect(isDirty({ base: "b", loadedText: text, tab: "form", draft, raw: text, errors: {} })).toBe(true);
      expect(formSubmission(draft, text, {})).toEqual({ kind: "save", text: JSON.stringify(draft, null, 2) });
    }
    const settings = readFileSync(new URL("../src/routes/Settings.svelte", import.meta.url), "utf8");
    expect(settings).toContain('errors[field.id] = writeField(draft, field, value) ?? "";');
  });

  test("a dropdown change writes HH:MM; anything else is refused and changes nothing", () => {
    const draft = JSON.parse(withMorning("7:05")) as Draft;
    expect(writeField(draft, MORNING, "06:30")).toBeNull();
    expect(getPath(draft, ["morningTime"])).toBe("06:30");
    for (const bad of ["7:5", "7:05", "24:00", "late", " 6:30"]) {
      expect({ bad, error: writeField(draft, MORNING, bad) }).toEqual({ bad, error: "must be HH:MM, e.g. 07:20" });
    }
    expect(getPath(draft, ["morningTime"])).toBe("06:30");
    // Absent stays absent until a dropdown changes: the engine's default, shown as 07:20.
    const absent = JSON.parse(withMorning(undefined)) as Draft;
    expect(readTime(absent, MORNING)).toEqual({ hhmm: "07:20", note: null });
    expect(writeField(absent, MORNING, readField(absent, MORNING))).toBeNull();
    expect("morningTime" in absent).toBe(false);
  });
});
