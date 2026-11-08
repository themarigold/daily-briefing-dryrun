// test/run-result.format.test.ts — the GUI's copy of the engine's reset formatter agrees with the engine's (wave 2
// polish spec §6, "Run now's result in plain words"; plan PA-M3-T1). Run now's "usage limit" sentence names the reset
// time through `formatResetTime`, and the GUI cannot import the engine, so `gui/src/lib/run-result.ts` carries a copy.
// This test holds the copy to `src/failover.ts`.
//
// The GUI module is loaded BY PATH AT RUN TIME (`await import(join(ROOT, …))`), never by a static import: CI runs the
// engine's tests before it installs the GUI's packages (test/engine-imports-no-gui.test.ts, which lists the module in
// `RUNTIME_GUI_MODULES`).
//
// The DST case runs in CHILD processes with TZ forced (bun cannot restore an unset TZ in-process,
// test/calendar-ics.test.ts:7-9); each child first proves the zone took effect.
import { test, expect, describe } from "bun:test";
import { join, resolve } from "node:path";
import { formatResetTime as engineFormat } from "../src/failover";
import { SKIP_REASONS } from "../src/json";

const ROOT = resolve(import.meta.dir, "..");
const GUI_RUN_RESULT = join(ROOT, "gui/src/lib/run-result.ts");
const ENGINE_FAILOVER = join(ROOT, "src/failover.ts");

type Format = (instant: string | Date, now: Date) => string;
const loadGuiFormat = async (): Promise<Format> =>
  ((await import(GUI_RUN_RESULT)) as { formatResetTime: Format }).formatResetTime;

describe("runResultSentence knows every reason the engine writes", () => {
  // The GUI's check (gui/tests-web/run-result.check.ts) holds each sentence to the spec's table, against the GUI's
  // SkipReason mirror; a GUI check must not name an engine module, so the engine's own list is read here.
  test("every SKIP_REASONS member, skipped or failed, gets a sentence of its own, never the unknown-reason one", async () => {
    type Sentence = (o: { kind: "skipped" | "failed"; reason: string | null }, l: null, now: Date, place: "today") => string;
    const { runResultSentence } = (await import(GUI_RUN_RESULT)) as { runResultSentence: Sentence };
    const now = new Date(2026, 9, 16, 8, 0);
    expect(SKIP_REASONS).toHaveLength(14);
    const generic = (reason: string): string[] => [`The briefing wasn't made (${reason}). See Details.`, `The run stopped unexpectedly (${reason}). See Details.`];
    const got = SKIP_REASONS.flatMap((reason) => (["skipped", "failed"] as const).map((kind) => {
      const s = runResultSentence({ kind, reason }, null, now, "today");
      return { reason, kind, own: !generic(reason).includes(s) };
    }));
    expect(got.filter((g) => !g.own)).toEqual([]);
    // PREMISE: an unknown reason does read as the generic sentence, so the check above can fail.
    expect(runResultSentence({ kind: "skipped", reason: "not-a-reason" }, null, now, "today")).toBe(generic("not-a-reason")[0]!);
  });
});

describe("formatResetTime: the GUI's copy gives the engine's string", () => {
  test("today, +2 days, +7 days and an unreadable instant, in this process's zone", async () => {
    const guiFormat = await loadGuiFormat();
    const now = new Date(2026, 9, 16, 8, 0);
    const cases: [string, string | Date][] = [
      ["today", new Date(2026, 9, 16, 9, 5).toISOString()],
      ["+2 days", new Date(2026, 9, 18, 7, 30).toISOString()],
      ["+7 days", new Date(2026, 9, 23, 23, 59).toISOString()],
      ["not a date", "not a date"],
      ["a Date, not a string", new Date(2026, 9, 17, 0, 0)],
    ];
    const got = cases.map(([name, instant]) => ({ name, engine: engineFormat(instant, now), gui: guiFormat(instant, now) }));
    expect(got.map(({ name, gui }) => ({ name, gui }))).toEqual(got.map(({ name, engine }) => ({ name, gui: engine })));
    // The cases reach every branch: a bare time, a weekday, a date, the fallback.
    expect(got.map((g) => g.engine)).toEqual(["09:05", "Sun 07:30", "Fri 23 Oct 23:59", "its reset", "Sat 00:00"]);
  });

  test("on a DST day (America/New_York, 8 March 2026), in a child process with TZ forced", async () => {
    const code = `const engine = (await import(${JSON.stringify(ENGINE_FAILOVER)})).formatResetTime;
const gui = (await import(${JSON.stringify(GUI_RUN_RESULT)})).formatResetTime;
const offset = new Date("2026-03-08T12:00:00Z").getTimezoneOffset();
const cases = [
  // now: Saturday 7 March, 08:00 EST; the reset: Sunday 8 March 09:30 EDT — across the 23-hour day.
  ["2026-03-08T13:30:00Z", "2026-03-07T13:00:00Z"],
  // now and the reset on the DST day itself, either side of 02:00.
  ["2026-03-08T06:30:00Z", "2026-03-08T05:00:00Z"],
  ["2026-03-08T23:00:00Z", "2026-03-08T05:00:00Z"],
  // six local days across the change: a date, not a weekday.
  ["2026-03-13T13:00:00Z", "2026-03-07T13:00:00Z"],
  // five local days across the change: still a weekday.
  ["2026-03-12T13:00:00Z", "2026-03-07T13:00:00Z"],
];
console.log(JSON.stringify({ offset, zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  got: cases.map(([at, now]) => ({ engine: engine(at, new Date(now)), gui: gui(at, new Date(now)) })) }));`;
    const p = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, TZ: "America/New_York" }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    expect({ exit: p.exitCode, err }).toEqual({ exit: 0, err: "" });
    const r = JSON.parse(out.trim().split("\n").at(-1)!) as { offset: number; zone: string; got: { engine: string; gui: string }[] };
    // PREMISE: the forced zone took effect (EDT is UTC-4 by noon UTC on 8 March 2026).
    expect({ offset: r.offset, zone: r.zone }).toEqual({ offset: 240, zone: "America/New_York" });
    expect(r.got.map((g) => g.gui)).toEqual(r.got.map((g) => g.engine));
    expect(r.got.map((g) => g.engine)).toEqual(["Sun 09:30", "01:30", "19:00", "Fri 13 Mar 09:00", "Thu 09:00"]);
  });
});
