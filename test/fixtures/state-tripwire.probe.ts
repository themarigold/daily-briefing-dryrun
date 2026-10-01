// test/fixtures/state-tripwire.probe.ts — the CHILD-PROCESS probe for the isolation tripwire. Run only by
// test/state-tripwire.test.ts, as `bun test <this file>` inside a sandbox the parent registered: HOME is
// `<sandbox>/home` and TMPDIR is `<sandbox>/tmp`. Not a `*.test.ts`, so a plain `bun test` never collects
// it, and it refuses to load anywhere else — it does on purpose what the suite must never do.
//
// Scenario 1 replays the 2026-09-15 live-state write (see test/fixtures/isolate-state.ts) with the timing
// made deterministic: A saves the variable, points it at its own dir, and outlives its 50 ms timeout; B
// starts, lets A's `finally` restore what A saved, and then makes a state write. The other three each take
// the isolation off one way — clearing the state dir, deleting it, deleting the config dir — and write.
//
// With test/preload.ts (the parent runs this from the package root, where bunfig.toml lives) no write may
// reach HOME, and the three direct scenarios must fail. Without it (the parent runs this from a directory
// with no bunfig.toml, and this file deliberately does not import the fixture) EVERY write lands under
// HOME — the control that shows this probe really reproduces each leak rather than passing because it
// does nothing.
import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { archivedBriefingPath, latestBriefingPath, localDateStr, stampToday } from "../../src/marker";
import { configPath } from "../../src/config";
import { removeAtRunEnd } from "./temp-dirs";

const sandbox = process.env.DBA_TRIPWIRE_SANDBOX ?? "";
if (!basename(sandbox).startsWith("dba-tripwire-") || homedir() !== join(sandbox, "home") || resolve(tmpdir()) !== resolve(sandbox, "tmp")) {
  throw new Error("state-tripwire.probe.ts runs only as the sandboxed child of test/state-tripwire.test.ts");
}

let letARestore!: () => void;
const aMayRestore = new Promise<void>((r) => { letARestore = r; });
let markARestored!: () => void;
const aRestored = new Promise<void>((r) => { markARestored = r; });

test("incident A: saves the variable, points it at its own dir, and outlives its timeout", async () => {
  const prev = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-trip-a-")));
  try {
    await aMayRestore;
  } finally {
    if (prev === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prev;
    markARestored();
  }
}, 50);

test("incident B: the next test's state write lands after A's restore", async () => {
  const prev = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-trip-b-")));
  try {
    letARestore();
    await aRestored;   // A's `finally` has run — the window the 2026-09-15 write fell in
    await Bun.write(archivedBriefingPath(localDateStr(new Date())), "incident-shape write\n");
  } finally {
    if (prev === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prev;
  }
});

test("clear: a test clears the state dir, then writes the day marker", async () => {
  const prev = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = "";
  try {
    await stampToday("2099-01-01");
  } finally {
    process.env.DAILY_BRIEFING_STATE_DIR = prev;
  }
});

test("delete: a test deletes the state dir, then writes the latest briefing", async () => {
  const prev = process.env.DAILY_BRIEFING_STATE_DIR;
  try {
    delete process.env.DAILY_BRIEFING_STATE_DIR;
    await Bun.write(latestBriefingPath(), "delete-shape write\n");
  } finally {
    process.env.DAILY_BRIEFING_STATE_DIR = prev;
  }
});

// `delete`, not `= ""`: configPath() resolves with `??`, so an empty string yields a cwd-relative path
// rather than the HOME fallback — the deletion is the shape that reaches the real config, and the one the
// 2026-09-15 cleanup performed.
test("config: a test deletes XDG_CONFIG_HOME, then writes the config", async () => {
  const prev = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    await Bun.write(configPath(), "{}\n");
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
  }
});
