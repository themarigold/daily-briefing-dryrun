// Real-process output check for summary.run.test.ts. All paths arrive in the test-owned start environment.
// With a third argument `real-provider` no provider is injected: the config's own entry runs, so a child it starts is real.
import { readFileSync } from "node:fs";

const inherited = { ...process.env };
await import("../fixtures/isolate-state");
// The fixture arms fresh baselines. Restore only the parent's explicitly sandboxed locations before engine imports.
for (const key of ["DAILY_BRIEFING_STATE_DIR", "XDG_CONFIG_HOME", "DBA_TEST_UNIT_DIR", "TMPDIR"] as const) {
  if (!inherited[key]) throw new Error(`missing isolated ${key}`);
  process.env[key] = inherited[key];
}
// Fix the morning's wall clock so a sub-millisecond network probe cannot add a random wait diagnostic.
// Summary timers and cancellation still use the real monotonic clock.
const wallTime = Number(process.argv[3]);
if (!Number.isFinite(wallTime) || wallTime <= 0) throw new Error("missing fixture wall time");
Date.now = () => wallTime;
// `new Date()` with no arguments reads the system clock on its own, not through Date.now, and the
// header's "state as of HH:MM" comes from exactly that (src/core.ts stateAsOf, deliberately outside the
// injected clock). Unpinned, an off run and an on run that straddle a minute printed different headers
// and failed the byte comparison (CI, 2026-11-07: 20:47 vs 20:48). Pin the no-argument form too.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(wallTime);
    else super(...(args as [string | number | Date]));
  }
  static now() { return wallTime; }
} as DateConstructor;
const { run } = await import("../../src/main");
const { latestBriefingPath } = await import("../../src/marker");
const { summaryCardsFromPage } = await import("../../src/summary/cards");
const { calendarSnapshot, capturedCalendar } = await import("./summary-calendar");
const { BRIEFING, walkDeps } = await import("./walk");

const injected = process.argv[4] === "real-provider" ? {} : {
  provider: { generate: async () => BRIEFING },
  summaryProvider: { generate: async () => JSON.stringify({
    projects: [{ key: summaryCardsFromPage(readFileSync(latestBriefingPath(), "utf8"))[0]!.key, points: ["A real subprocess point."] }],
    goodMorningSentence: "The work is ready.",
  }) },
  summaryTestSeed: {
    winner: { provider: { cli: "/nonexistent/never-spawned", argv: [], promptVia: "stdin" as const } },
    morningLocked: false,
    calendarCapture: capturedCalendar(await calendarSnapshot({ configured: false })),
  },
};
const code = await run(true, {
  ...walkDeps(),
  now: () => new Date(wallTime),
  interactive: true,                               // the unchanged update-check gate stays closed
  ...injected,
}, { jsonOut: process.argv[2]! });
process.exit(code);
