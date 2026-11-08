import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// A delivery is only a delivery once `briefing-latest.md` is on disk.
//
// The desktop app's Today screen reads that file, and it is the "clean copy the user/audit read". Until
// this fix both briefing writes were swallowed (`.catch(() => {})`) and the day was stamped anyway, so a
// failed write (disk full, a permission change) consumed the day: every later tick declined with
// `already-ran` and no briefing ever reached the app. The latest write is now load-bearing — it fails
// closed with a `write-fail` skip and no stamp — while the dated ARCHIVE stays fail-open, as its own
// comment in main.ts intends.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo } from "./fixtures/build-repo";
import { run } from "../src/main";
import { archivedBriefingPath, latestBriefingPath, localDateStr, readLastRunDate, readLastSkip } from "../src/marker";
import type { Provider } from "../src/types";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();

function withEnv(cfgObj: unknown): () => void {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-wf-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-wf-state-")));
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

const provider: Provider = {
  async generate() {
    return "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";
  },
};
const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
const FIRE = () => new Date(2026, 6, 16, 7, 20);
const deps = { provider, now: FIRE, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 };

describe("briefing-latest.md is load-bearing for delivery", () => {
  test("an unwritable briefing-latest.md does NOT stamp the day — it records write-fail and exits 1", async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const cleanup = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
    const cap = captureConsole();
    try {
      // A DIRECTORY where the file goes makes the write fail, the same technique the marker-fail test uses.
      mkdirSync(latestBriefingPath(), { recursive: true });
      const code = await run(false, deps);
      expect(code).toBe(1);
      expect(await readLastRunDate()).toBeUndefined();          // ⚠ THE POINT: the day is not consumed
      const skip = await readLastSkip();
      expect(skip?.reason).toBe("write-fail");
      expect(cap.err.join("\n")).toContain("could not save the briefing");
    } finally { cap.restore(); cleanup(); }
  }, 30_000);

  test("an unwritable ARCHIVE still delivers — the archive stays fail-open", async () => {
    const repo = await buildRepo([{ file: "b.txt", content: "b", isoDate: yesterdayISO() }]);
    const cleanup = withEnv({ repos: [repo], provider: PROV, morningTime: "07:20" });
    const cap = captureConsole();
    try {
      const day = localDateStr(new Date());                     // the run clock decides the day key
      mkdirSync(archivedBriefingPath(day), { recursive: true });
      const code = await run(false, deps);
      expect(code).toBe(0);
      expect(await readLastRunDate()).toBe(day);
      expect(existsSync(latestBriefingPath())).toBe(true);
    } finally { cap.restore(); cleanup(); }
  }, 30_000);
});
