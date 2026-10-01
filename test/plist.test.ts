// ⚠ RE-POINTED IN SLICE 4 (T2), NOT REWRITTEN. This file used to read
// `install/local.daily-briefing.plist` off disk. That template is DELETED: it was a second spelling
// of the unit, unreachable from a downloaded binary (no checkout, no `sed`) and free to drift from
// whatever the binary itself would write. `launchdPlist()` is now the one source, and every assertion
// below is the ORIGINAL assertion pointed at it — the same properties, checked against the thing that
// actually gets installed.
import { test, expect } from "bun:test";
import { launchdPlist, type ScheduleOpts } from "../src/schedule/units";
import { parseFloor } from "../src/schedule";

/** Stands in for what `schedule install` computes. Paths are literals, not real ones: these tests are
 *  about the GENERATED TEXT and must not depend on the runner's home directory. */
const OPTS: ScheduleOpts = {
  binPath: "/Users/x/Library/Application Support/daily-briefing/daily-briefing",
  label: "local.daily-briefing",
  logPath: "/Users/x/Library/Application Support/daily-briefing/briefing.log",
  floorMinutes: parseFloor("07:20").minutes,
  intervalSec: 600,
  pathEnv: "/Users/x/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
};

test("plist ProgramArguments wraps the binary in /usr/bin/caffeinate -i, in order, keeping <bin> run", () => {
  const plist = launchdPlist(OPTS);
  // Assert the FULL ordered argv, so a reorder (e.g. caffeinate after the binary) fails the test.
  expect(plist).toMatch(
    /<string>\/usr\/bin\/caffeinate<\/string>\s*<string>-i<\/string>\s*<string>\/Users\/x\/Library\/Application Support\/daily-briefing\/daily-briefing<\/string>\s*<string>run<\/string>/,
  );
});
