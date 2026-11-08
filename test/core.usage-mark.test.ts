// test/core.usage-mark.test.ts — the REAL usage call site in runCore writes `reason: "usage"` (provider-fallback
// P1-M5 checkpoint MED), and the limited result's `exhausted` is computed with the mark applied in memory, so a
// failed mark write cannot make it claim another account will be used (checkpoint LOW).
//
// Driven end to end: a fake CLI prints an UNPARSED usage-limit line (no reset the parser can read), so the mark is
// written with `isProbe: true` — the case that must still read as usage, not as an hour mark item 1 would ignore.
import "./fixtures/isolate-state";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { buildRepo } from "./fixtures/build-repo";
import { runCore } from "../src/core";
import { accountStatePath, loadAccountState, DEFAULT_LABEL } from "../src/account";
import type { Config } from "../src/types";

let repo = "";
let cli = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;

beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
  const bin = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-usage-cli-")));
  cli = join(bin, "fake-provider");
  // Short, and the limit sentence last: the shape gate `limitMatch` accepts. "resets whenever" names no instant.
  writeFileSync(cli, "#!/bin/sh\necho \"You've hit your weekly limit · resets whenever\"\nexit 1\n", { mode: 0o755 });
});
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

const cfg = (): Config => ({ repos: [repo], provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 10_000 } } as Config);
const deps = { netProbe: async () => true, powerPlatform: "linux" as NodeJS.Platform, sleep: async () => {}, retryDelaysMs: [] as number[] };

function freshState(): string {
  const d = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-usage-state-")));
  process.env.DAILY_BRIEFING_STATE_DIR = d;
  return d;
}

test("an unparsed usage wall is recorded with reason usage (isProbe true) at the real call site", async () => {
  const d = freshState();
  const r = await runCore(cfg(), deps);
  expect(r.skipReason).toBe("limited");
  expect(r.limited?.isProbe).toBe(true);                    // the premise: the unparsed form
  const mark = (await loadAccountState(d)).accounts[DEFAULT_LABEL];
  expect(mark?.isProbe).toBe(true);
  expect(mark?.reason).toBe("usage");
});

test("when the mark cannot be written, exhausted still reflects the mark (no 'another account' claim), and no temp file is left", async () => {
  const d = freshState();
  // A DIRECTORY at account-state.json: the load reads it as empty, the temp write succeeds, the rename fails.
  mkdirSync(join(accountStatePath(d)), { recursive: true });
  writeFileSync(join(accountStatePath(d), "keep"), "x");
  const r = await runCore(cfg(), deps);
  expect(r.skipReason).toBe("limited");
  expect(r.limited?.exhausted).toBe(true);                  // single entry, now marked: nothing else to use
  expect(readdirSync(d).filter((n) => n.startsWith("account-state.json.tmp-"))).toEqual([]);
});
