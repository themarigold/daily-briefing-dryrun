import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Slice 4 T5 — the SECOND TRIGGER, and the marker that makes it free.
//
// The launchd agent now fires from TWO independent sources: `StartInterval` 600 + `RunAtLoad`
// (unchanged) and a new `StartCalendarInterval` at the morning floor. That is deliberate defence in
// depth against the day-34 case — ~110 minutes past the floor on a machine that never slept, cause
// still undetermined — but it is only affordable because the once-per-day marker dedupes the extra
// fire. This file pins that: two ticks inside ONE simulated day must produce exactly ONE briefing and
// exactly ONE provider call.
//
// It also pins T7's ORDERING invariant, which is the other half of "the second trigger costs
// nothing": the notification must be unreachable until the day is stamped.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo } from "./fixtures/build-repo";
import { run } from "../src/main";
import { archivedBriefingPath, localDateStr, readLastRunDate, markerPath } from "../src/marker";
import type { Provider } from "../src/types";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();

function withEnv(cfgObj: unknown): () => void {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t5-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t5-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  };
}

function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

function fakeProvider() {
  let calls = 0;
  const provider: Provider = {
    async generate() {
      calls++;
      return "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";
    },
  };
  return { provider, calls: () => calls };
}

const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
/** Two ticks in ONE simulated day: the calendar fire at the 07:20 floor, then an interval tick. */
const CALENDAR_FIRE = () => new Date(2026, 6, 16, 7, 20);
const INTERVAL_TICK = () => new Date(2026, 6, 16, 7, 30);

describe("the marker dedupes the second trigger", () => {
  test("two ticks in one simulated day ⇒ ONE provider call, ONE briefing, ONE archive", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const cleanup = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
    const cap = captureConsole();
    const fp = fakeProvider();
    try {
      // Tick 1 — the NEW StartCalendarInterval fire, exactly at the floor. Not forced, not
      // interactive: precisely what launchd does.
      const first = await run(false, { provider: fp.provider, now: CALENDAR_FIRE, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });
      // Tick 2 — the ordinary StartInterval tick ten minutes later. This is the run that used to be
      // the ONLY one; with two triggers it is now the duplicate, and the marker is what makes it a
      // cheap no-op rather than a second provider call and a second delivery.
      const second = await run(false, { provider: fp.provider, now: INTERVAL_TICK, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });

      expect(`${first} ${second}`).toBe("0 0");             // both exit cleanly
      expect(fp.calls()).toBe(1);                            // ⚠ THE POINT: one provider call
      // ⚠ The DAY KEY comes from the run clock, not from the injected `now`: `deps.now` pins only the
      // FLOOR gate, while `runCore` derives `runDate` from the real clock (core.ts) and `stampToday`
      // is given that. Both ticks belong to the same real day, which is what makes the dedupe work —
      // and asserting the injected date here would be asserting a fact the engine does not have.
      const day = localDateStr(new Date());
      expect(await readLastRunDate()).toBe(day);
      expect(existsSync(archivedBriefingPath(day))).toBe(true);
      // Exactly one briefing reached stdout — the second tick rendered nothing at all.
      expect(cap.out.filter((l) => l.includes("RESUME") || l.includes("Resume")).length).toBeLessThanOrEqual(1);
    } finally { cap.restore(); cleanup(); }
  }, 30_000);
});

describe("⚠ T7 ORDERING: the notification is unreachable before the day is stamped", () => {
  test("STRUCTURAL — there is exactly ONE notify call site in main.ts, and it is AFTER stampToday", () => {
    // Asserted over the SOURCE, in posture.test.ts's style, because the property is "under ANY code
    // path" and no finite set of runtime cases can say that. A second call site, or one hoisted above
    // the stamp, would let an absent `notify-send` decide whether a briefing counted.
    const src = readFileSync(new URL("../src/main.ts", import.meta.url).pathname, "utf8");
    const calls = [...src.matchAll(/^\s*await notify\(/gm)];
    expect(`notify call sites = ${calls.length}`).toBe("notify call sites = 1");
    const notifyAt = src.indexOf("await notify(");
    const stampAt = src.indexOf("await stampToday(");
    expect(`stamp=${stampAt < notifyAt} both-present=${stampAt > 0 && notifyAt > 0}`).toBe("stamp=true both-present=true");
    // …and it is guarded, so a rejected promise cannot escape into the delivery path.
    expect(src.slice(notifyAt, notifyAt + 200)).toContain(".catch(() => {})");
  });

  test("RUNTIME — a run that cannot stamp the day does NOT notify", async () => {
    const repo = await buildRepo([{ file: "c.txt", content: "c", isoDate: yesterdayISO() }]);
    const cleanup = withEnv({
      repos: [repo], provider: PROV, morningTime: "07:20",
      notify: { command: ["/definitely/not/a/notifier", "{body}"] },
    });
    const cap = captureConsole();
    const fp = fakeProvider();
    try {
      // Make the marker unwritable by putting a DIRECTORY where the file goes: `stampToday` then
      // fails and run() returns 1 at the marker-fail branch, one line before the notify call.
      mkdirSync(markerPath(), { recursive: true });
      const code = await run(false, { provider: fp.provider, now: CALENDAR_FIRE, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });
      expect(code).toBe(1);
      expect(cap.err.join("\n")).toContain("could not write the day marker");
      // The configured notifier does not exist. Had it been reached, `notify()` would still swallow
      // the failure — so the assertion that carries weight is the exit path above plus the structural
      // test: the notify line is textually after the `return` that this run took.
      expect(await readLastRunDate()).toBeUndefined();
    } finally { cap.restore(); cleanup(); }
  }, 30_000);

  test("a delivered run with a BROKEN notifier still exits 0, stamps, and prints nothing extra", async () => {
    // ⚠ THE FIREWALL: StandardOut and StandardError both point at briefing.log, and
    // `audit.lastBriefing` slices from the last briefing header to EOF. A byte emitted by the notify
    // path would be handed to the audit judge AS BRIEFING TEXT.
    const repo = await buildRepo([{ file: "d.txt", content: "d", isoDate: yesterdayISO() }]);
    const cleanup = withEnv({
      repos: [repo], provider: PROV, morningTime: "07:20",
      notify: { command: ["/definitely/not/a/notifier", "{body}"] },
    });
    const cap = captureConsole();
    const fp = fakeProvider();
    try {
      const code = await run(false, { provider: fp.provider, now: CALENDAR_FIRE, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 });
      expect(code).toBe(0);
      expect(await readLastRunDate()).toBe(localDateStr(new Date()));   // the run clock — see above
      const all = [...cap.out, ...cap.err].join("\n");
      for (const leak of ["notifier", "ENOENT", "notify", "spawn"]) {
        expect(`${leak} leaked: ${all.includes(leak)}`).toBe(`${leak} leaked: false`);
      }
    } finally { cap.restore(); cleanup(); }
  }, 30_000);
});
