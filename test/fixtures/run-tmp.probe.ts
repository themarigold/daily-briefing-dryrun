// Child-process probe for test/run-tmp.test.ts (NOT a *.test.ts: run only by that file, by path).
// Makes the shapes a real test file makes — a registered dir with content, a write into the state baseline —
// and prints where they went.
import "./isolate-state";
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./temp-dirs";

test("probe", () => {
  const d = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-rtprobe-")));
  writeFileSync(join(d, "f"), "x");
  writeFileSync(join(process.env.DAILY_BRIEFING_STATE_DIR!, "last-run"), "x");
  console.log(`PROBE_TMPDIR=${tmpdir()}`);
  console.log(`PROBE_STATE=${process.env.DAILY_BRIEFING_STATE_DIR}`);
  expect(true).toBe(true);
});
