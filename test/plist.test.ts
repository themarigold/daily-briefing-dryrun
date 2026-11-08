// ⚠ RE-POINTED IN SLICE 4 (T2), NOT REWRITTEN. This file used to read
// `install/local.daily-briefing.plist` off disk. That template is DELETED: it was a second spelling
// of the unit, unreachable from a downloaded binary (no checkout, no `sed`) and free to drift from
// whatever the binary itself would write. `launchdPlist()` is now the one source, and every assertion
// below is the ORIGINAL assertion pointed at it — the same properties, checked against the thing that
// actually gets installed.
import { test, expect } from "bun:test";
import { launchdPlist, KEEP_AWAKE_ENV, type ScheduleOpts } from "../src/schedule/units";
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

test("plist ProgramArguments is EXACTLY [<bin>, run] — the whole array, with no wrapper in front", () => {
  const plist = launchdPlist(OPTS);
  // Anchored on the key and both ends of the array, so a sub-run cannot match: the old wrapped argv
  // `[/usr/bin/caffeinate, -i, <bin>, run]` CONTAINS `<bin>, run` and would pass an unanchored pattern.
  // macOS names the job after ProgramArguments[0], which is the whole point of this pin (units.ts).
  expect(plist).toMatch(
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/x\/Library\/Application Support\/daily-briefing\/daily-briefing<\/string>\s*<string>run<\/string>\s*<\/array>/,
  );
});

test("the plist names no caffeinate anywhere — keep-awake is the engine's job now", () => {
  expect(launchdPlist(OPTS)).not.toContain("caffeinate");
});

test("EnvironmentVariables carries DAILY_BRIEFING_KEEP_AWAKE=1, the switch dispatch's run branch reads", () => {
  expect(KEEP_AWAKE_ENV).toEqual({ name: "DAILY_BRIEFING_KEEP_AWAKE", value: "1" });
  const env = launchdPlist(OPTS).match(/<key>EnvironmentVariables<\/key><dict>(.*?)<\/dict>/)?.[1] ?? "";
  expect(env).toContain(`<key>PATH</key><string>${OPTS.pathEnv}</string>`);   // non-vacuity: the dict was found
  expect(env).toContain("<key>DAILY_BRIEFING_KEEP_AWAKE</key><string>1</string>");
});
