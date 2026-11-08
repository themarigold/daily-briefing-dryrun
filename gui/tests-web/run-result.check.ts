/**
 * Run now's result in plain words (wave 2 polish spec §6, "Run now's result in plain words"; plan PA-M3-T1).
 *
 * `gui/src/lib/run-result.ts` maps a finished run to one sentence, for Today (`App.svelte`'s `describe`) and for
 * Schedule's skipped phase. ⚠ THE EXPECTED SENTENCES BELOW ARE THE SPEC'S TABLE, TYPED HERE BY HAND, never read back
 * from the module: a sentence changed in the module turns this red.
 *
 * The reset time is `formatResetTime`, a copy of the engine's (`src/failover.ts`): the GUI cannot import the engine.
 * The expected times are literals for instants built in LOCAL time, so they hold in any zone; the engine-side parity
 * test (`test/run-result.format.test.ts`) holds the copy to the original.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { detailsOpen, type EngineOutcome } from "../src/lib/engine";
import { formatResetTime, limitedOf, NO_RUN_LINE, runLineSeen, runLineSettled, runLineStarted, runResultSentence, type Limited, type RunLine, type RunOutcome } from "../src/lib/run-result";

const SOURCE = readFileSync(new URL("../src/lib/run-result.ts", import.meta.url), "utf8");

/** Friday 16 October 2026, 08:00 local. */
const NOW = new Date(2026, 9, 16, 8, 0);
const at = (...parts: [number, number, number, number, number]): string => new Date(...parts).toISOString();

/** The spec's sentence for each of the engine's fourteen skip reasons (`SKIP_REASONS`), on Today. */
const TODAY: ReadonlyArray<readonly [string, string]> = [
  ["already-ran", "Run now makes one briefing a day, and today's is already made."],
  ["no-config", "Daily Briefing isn't set up yet. Open Setup to finish."],
  ["config-error", "Your settings file has a problem, so nothing ran. See Details."],
  ["below-floor", "It's before your morning time, so the scheduled check waited."],
  ["concurrent", "A briefing is already being made. It will show here when it's done."],
  ["offline", "You were offline, so nothing ran. Try again once you're connected."],
  ["darkwake", "The Mac was only partly awake, so the briefing waited for the next check."],
  ["limited", "Every AI account you set up is at its usage limit."],
  ["blocked", "A repository couldn't be read, so nothing ran. See Details."],
  ["provider-fail", "The AI provider didn't answer. See Details."],
  ["parse-empty", "The AI's answer had nothing usable in it. See Details."],
  [
    "marker-fail",
    "Today's briefing was written, but the engine could not record that it was — so a later check today may generate it again.",
  ],
  ["write-fail", "The briefing couldn't be saved. The next check will try again. See Details."],
  ["crashed", "Something went wrong and the run stopped. See Details."],
];

/** The same table on Schedule: no " See Details." (Schedule has no Details control), and its own `concurrent`. */
const SCHEDULE: ReadonlyArray<readonly [string, string]> = [
  ["already-ran", "Run now makes one briefing a day, and today's is already made."],
  ["no-config", "Daily Briefing isn't set up yet. Open Setup to finish."],
  ["config-error", "Your settings file has a problem, so nothing ran."],
  ["below-floor", "It's before your morning time, so the scheduled check waited."],
  ["concurrent", "A briefing was already being made."],
  ["offline", "You were offline, so nothing ran. Try again once you're connected."],
  ["darkwake", "The Mac was only partly awake, so the briefing waited for the next check."],
  ["limited", "Every AI account you set up is at its usage limit."],
  ["blocked", "A repository couldn't be read, so nothing ran."],
  ["provider-fail", "The AI provider didn't answer."],
  ["parse-empty", "The AI's answer had nothing usable in it."],
  [
    "marker-fail",
    "Today's briefing was written, but the engine could not record that it was — so a later check today may generate it again.",
  ],
  ["write-fail", "The briefing couldn't be saved. The next check will try again."],
  ["crashed", "Something went wrong and the run stopped."],
];

const sentence = (outcome: RunOutcome, place: "today" | "schedule" = "today", limited: Limited | null = null): string =>
  runResultSentence(outcome, limited, NOW, place);

describe("RunLine: a run's line lasts until a new briefing", () => {
  const SAID = "Run now makes one briefing a day, and today's is already made.";
  const [M0, M1, M2] = ["2026-11-05T08:00:00Z", "2026-11-05T09:00:00Z", "2026-11-05T10:00:00Z"];
  const started = (from = NO_RUN_LINE): RunLine => runLineStarted(from);
  const said = (line: RunLine, text = SAID): RunLine => ({ ...line, text });

  test("a skip, then a scheduled run: the line stays on the same page and goes with the new one", () => {
    const run = said(started());
    const line = runLineSettled(run, run.run, true, M0);
    expect(line.text).toBe(SAID);
    expect(runLineSeen(line, M0).text).toBe(SAID);
    expect(runLineSeen(line, M1).text).toBe("");
  });
  test("with no briefing at all, the first one takes the line", () => {
    const run = said(started());
    expect(runLineSeen(runLineSettled(run, run.run, true, null), M1).text).toBe("");
  });
  test("a delivered run keeps its line on its own page, however the push and the refresh land", () => {
    for (const before of [M0, M1, undefined]) {
      // A push during the run or the refresh, then the refresh's own read of the new page, then a later push of the same page.
      const run = runLineSeen(said(started()), before);
      const line = runLineSettled(run, run.run, true, M1);
      expect({ before, about: line.about, text: runLineSeen(line, M1).text }).toEqual({ before, about: M1, text: SAID });
    }
  });
  test("a read failing right after the run neither loses the line nor dates it", () => {
    const run = said(started());
    const line = runLineSettled(run, run.run, true, undefined);
    expect(line).toMatchObject({ text: SAID, about: undefined, settled: true });
    const dated = runLineSeen(line, M0);
    expect(dated).toMatchObject({ text: SAID, about: M0 });
    expect(runLineSeen(dated, M1).text).toBe("");
  });
  test("a refresh that gets no answer leaves the line undated, and the next snapshot dates it", () => {
    const run = said(started());
    const line = runLineSettled(run, run.run, false, M0);
    expect(line).toMatchObject({ text: SAID, about: undefined, settled: true });
    expect(runLineSeen(line, M1)).toMatchObject({ text: SAID, about: M1 });
  });
  test("a failed read hides nothing, and a line a new briefing took stays gone through one", () => {
    const run = said(started());
    const line = runLineSettled(run, run.run, true, M0);
    expect(runLineSeen(line, undefined).text).toBe(SAID);
    expect(runLineSeen(line, M1).text).toBe("");
  });
  test("only a newer page takes the line: not a slower read of an older one, or a stat that failed", () => {
    const run = said(started());
    const line = runLineSettled(run, run.run, true, M1);
    expect(runLineSeen(line, M0)).toBe(line);
    expect(runLineSeen(line, null)).toBe(line);
    expect(runLineSeen(line, M1)).toBe(line);
    expect(runLineSeen(line, M2).text).toBe("");
  });
  test("a second run started during the first's refresh keeps its own line", () => {
    const first = said(started(), "The AI provider didn't answer. See Details.");
    const second = started(first);
    // The first's refresh answers now, with the page as it was: it must not touch the second run.
    const after = runLineSettled(second, first.run, true, M0);
    expect(after).toBe(second);
    const delivered = said(after, "Done — today's briefing was generated.");
    expect(runLineSettled(delivered, second.run, true, M1)).toMatchObject({ text: "Done — today's briefing was generated.", about: M1 });
  });
  test("a snapshot while a run is going does nothing to it", () => {
    const run = started(said(started()));
    expect(runLineSeen(run, M1)).toBe(run);
  });
  test("a new run clears the last one's line and date", () => {
    const run = said(started());
    const line = runLineSettled(run, run.run, true, M0);
    expect(started(line)).toEqual({ run: line.run + 1, text: "", about: undefined, settled: false });
  });
});

describe("runResultSentence: the fourteen engine reasons", () => {
  // The engine's own list is read by the engine-side test (test/run-result.format.test.ts: every SKIP_REASONS member
  // gets a sentence of its own); a GUI check must not name an engine module (coexistence.check.ts).
  test("premise: the table names each reason of the GUI's SkipReason mirror (lib/state.ts) exactly once", () => {
    const state = readFileSync(new URL("../src/lib/state.ts", import.meta.url), "utf8");
    const block = /export type SkipReason =([\s\S]*?);/.exec(state)?.[1] ?? "";
    const reasons = [...block.matchAll(/\|\s*"([a-z-]+)"/g)].map((m) => m[1]);
    expect(reasons).toHaveLength(14);
    expect(TODAY.map(([r]) => r)).toEqual(reasons);
    expect(SCHEDULE.map(([r]) => r)).toEqual(reasons);
  });

  test("each reason reads its sentence, whether the run was skipped or failed", () => {
    for (const [reason, want] of TODAY) {
      expect([reason, sentence({ kind: "skipped", reason })]).toEqual([reason, want]);
      expect([reason, sentence({ kind: "failed", reason })]).toEqual([reason, want]);
    }
  });

  test("on Schedule: every \" See Details.\" is left out, and concurrent reads its Schedule sentence", () => {
    for (const [reason, want] of SCHEDULE) {
      expect([reason, sentence({ kind: "skipped", reason }, "schedule")]).toEqual([reason, want]);
      expect([reason, sentence({ kind: "failed", reason }, "schedule")]).toEqual([reason, want]);
    }
  });
});

describe("runResultSentence: the outcomes with no engine reason", () => {
  test("configError (exit 2, no reason) reads the settings-file sentence", () => {
    expect(sentence({ kind: "configError", reason: null })).toBe("Your settings file has a problem, so nothing ran. See Details.");
    expect(sentence({ kind: "configError", reason: null }, "schedule")).toBe("Your settings file has a problem, so nothing ran.");
  });

  test("Rust's three codes and a failed null reason: the run stopped unexpectedly", () => {
    expect(sentence({ kind: "failed", reason: "malformed-json" })).toBe("The run stopped unexpectedly (malformed-json). See Details.");
    expect(sentence({ kind: "failed", reason: "exit-3" })).toBe("The run stopped unexpectedly (exit-3). See Details.");
    expect(sentence({ kind: "failed", reason: "exit-127" })).toBe("The run stopped unexpectedly (exit-127). See Details.");
    expect(sentence({ kind: "failed", reason: "signalled" })).toBe("The run stopped unexpectedly (signalled). See Details.");
    expect(sentence({ kind: "failed", reason: null })).toBe("The run stopped unexpectedly (no reason given). See Details.");
    expect(sentence({ kind: "failed", reason: "signalled" }, "schedule")).toBe("The run stopped unexpectedly (signalled).");
    // Rust formats an i32 (`format!("exit-{other}")`, engine.rs): a Windows crash code is negative.
    expect(sentence({ kind: "failed", reason: "exit--1073741819" })).toBe("The run stopped unexpectedly (exit--1073741819). See Details.");
    expect(sentence({ kind: "failed", reason: "exit--1073741819" }, "schedule")).toBe("The run stopped unexpectedly (exit--1073741819).");
  });

  test("a skipped run with no reason was not made this time", () => {
    expect(sentence({ kind: "skipped", reason: null })).toBe("The briefing wasn't made this time.");
    expect(sentence({ kind: "skipped", reason: null }, "schedule")).toBe("The briefing wasn't made this time.");
  });

  test("an unknown reason names its code; an exit code that is not exit-<integer> is unknown", () => {
    expect(sentence({ kind: "failed", reason: "brand-new" })).toBe("The briefing wasn't made (brand-new). See Details.");
    expect(sentence({ kind: "skipped", reason: "brand-new" })).toBe("The briefing wasn't made (brand-new). See Details.");
    expect(sentence({ kind: "skipped", reason: "brand-new" }, "schedule")).toBe("The briefing wasn't made (brand-new).");
    expect(sentence({ kind: "failed", reason: "exit-" })).toBe("The briefing wasn't made (exit-). See Details.");
    expect(sentence({ kind: "failed", reason: "exit-3x" })).toBe("The briefing wasn't made (exit-3x). See Details.");
    expect(sentence({ kind: "failed", reason: "exit--" })).toBe("The briefing wasn't made (exit--). See Details.");
    expect(sentence({ kind: "failed", reason: "exit---1" })).toBe("The briefing wasn't made (exit---1). See Details.");
    // A Rust code on a SKIPPED run is not one Rust writes there: it reads as unknown.
    expect(sentence({ kind: "skipped", reason: "signalled" })).toBe("The briefing wasn't made (signalled). See Details.");
  });

  test("an object-prototype name is not a known reason", () => {
    for (const reason of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect([reason, sentence({ kind: "skipped", reason })]).toEqual([reason, `The briefing wasn't made (${reason}). See Details.`]);
    }
  });
});

describe("runResultSentence: the usage limit's reset time", () => {
  const LIMIT = "Every AI account you set up is at its usage limit";

  test("a parsed reset today names the time; another day within 5 days names the weekday; 6+ days the date", () => {
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: at(2026, 9, 16, 9, 5), isProbe: false }))
      .toBe(`${LIMIT} until 09:05.`);
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: at(2026, 9, 17, 7, 30), isProbe: false }))
      .toBe(`${LIMIT} until Sat 07:30.`);
    expect(sentence({ kind: "failed", reason: "limited" }, "today", { until: at(2026, 9, 21, 9, 0), isProbe: false }))
      .toBe(`${LIMIT} until Wed 09:00.`);
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: at(2026, 9, 22, 9, 0), isProbe: false }))
      .toBe(`${LIMIT} until Thu 22 Oct 09:00.`);
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: at(2026, 9, 23, 9, 0), isProbe: false }))
      .toBe(`${LIMIT} until Fri 23 Oct 09:00.`);
  });

  test("a probe deadline, an empty until or no limited field: no time — the app never invents one", () => {
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: at(2026, 9, 16, 9, 5), isProbe: true })).toBe(`${LIMIT}.`);
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: "", isProbe: false })).toBe(`${LIMIT}.`);
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", null)).toBe(`${LIMIT}.`);
    // Schedule's input (last-skip.json) has no `limited`: it always passes null.
    expect(sentence({ kind: "skipped", reason: "limited" }, "schedule", null)).toBe(`${LIMIT}.`);
  });

  test("an until that is set but unreadable reads \"its reset\", as the engine's does", () => {
    expect(sentence({ kind: "skipped", reason: "limited" }, "today", { until: "not a date", isProbe: false }))
      .toBe(`${LIMIT} until its reset.`);
  });

  test("limited only colours the limited sentence", () => {
    const limited = { until: at(2026, 9, 16, 9, 5), isProbe: false };
    expect(sentence({ kind: "skipped", reason: "offline" }, "today", limited)).toBe("You were offline, so nothing ran. Try again once you're connected.");
    expect(sentence({ kind: "failed", reason: null }, "today", limited)).toBe("The run stopped unexpectedly (no reason given). See Details.");
  });
});

describe("formatResetTime (the GUI's copy of the engine's)", () => {
  test("HH:MM today, Ddd HH:MM within 5 days, Ddd D Mon HH:MM 6+ days away, its reset for an unreadable instant", () => {
    expect(formatResetTime(at(2026, 9, 16, 23, 59), NOW)).toBe("23:59");
    expect(formatResetTime(new Date(2026, 9, 16, 0, 0), NOW)).toBe("00:00");
    expect(formatResetTime(at(2026, 9, 18, 9, 0), NOW)).toBe("Sun 09:00");
    expect(formatResetTime(at(2026, 9, 21, 9, 0), NOW)).toBe("Wed 09:00");
    expect(formatResetTime(at(2026, 9, 22, 9, 0), NOW)).toBe("Thu 22 Oct 09:00");
    expect(formatResetTime(at(2026, 10, 6, 9, 0), NOW)).toBe("Fri 6 Nov 09:00");
    expect(formatResetTime(at(2026, 9, 10, 9, 0), NOW)).toBe("Sat 10 Oct 09:00");
    expect(formatResetTime("not a date", NOW)).toBe("its reset");
    expect(formatResetTime(new Date(Number.NaN), NOW)).toBe("its reset");
  });
});

describe("limitedOf: the shape guard over the run envelope's limited", () => {
  test("a good field gives its until and isProbe, and nothing else", () => {
    const payload = { delivered: false, skipReason: "limited", limited: { label: "Max", until: "2026-10-16T09:05:00.000Z", isProbe: false, exhausted: true } };
    expect(limitedOf(payload)).toEqual({ until: "2026-10-16T09:05:00.000Z", isProbe: false });
    expect(limitedOf({ limited: { until: "", isProbe: true } })).toEqual({ until: "", isProbe: true });
  });

  test("a missing or malformed field, or a payload that is not an object, gives null", () => {
    for (const payload of [
      null,
      undefined,
      "limited",
      42,
      [],
      {},
      { limited: null },
      { limited: "2026-10-16T09:05:00.000Z" },
      { limited: { until: "2026-10-16T09:05:00.000Z" } },
      { limited: { isProbe: false } },
      { limited: { until: 5, isProbe: false } },
      { limited: { until: "2026-10-16T09:05:00.000Z", isProbe: "false" } },
      { limited: { until: null, isProbe: false } },
    ]) {
      expect([payload, limitedOf(payload)]).toEqual([payload, null]);
    }
  });
});

describe("run-result.ts: no imports, and Details stays collapsed on a skip", () => {
  test("(source pin) the module has no import at all: an engine test loads it by path", () => {
    expect(SOURCE).not.toMatch(/^\s*import\b/m);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  test("detailsOpen is still false for a skip, true for a failure or a config error", () => {
    const outcome = (o: EngineOutcome["outcome"]): EngineOutcome => ({ outcome: o, exitCode: 0, payload: null }) as EngineOutcome;
    expect(detailsOpen({ outcome: outcome({ kind: "skipped", reason: "offline" }) })).toBe(false);
    expect(detailsOpen({ outcome: outcome({ kind: "skipped", reason: null }) })).toBe(false);
    expect(detailsOpen({ outcome: outcome({ kind: "failed", reason: "provider-fail" }) })).toBe(true);
    expect(detailsOpen({ outcome: outcome({ kind: "configError" }) })).toBe(true);
  });
});
