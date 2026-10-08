import "./fixtures/isolate-state";   // A0 — arms the isolation variables from any cwd (see test/isolation.meta.test.ts)
// Batch 2 T2.1 — the bounded record read (spec 3.1.2) against a FIFO at `schedule.json`; and T3.4 — what
// `uninstallSchedule` makes of one (spec 3.7 "Exit codes").
//
// ⚠ WHY A FILE OF ITS OWN, AND WHY A CHILD PROCESS. Opening a FIFO for reading blocks until a writer
// appears, so a `readScheduleRecord` that stopped checking `lstat` first would HANG, not fail — and a hung
// read inside the test process would take the whole suite with it. So each case runs in a `bun -e` child
// that a 10 s timer kills, well inside the test's explicit 20 s timeout (bunfig.toml sets none), and the
// test asserts the child EXITED ON ITS OWN with the "present but unreadable" answer. The FIFO itself is
// made by `mkfifo` (Bun has no API for it); spawning that here is why these cases cannot live in
// test/schedule.install.test.ts, whose scanner-2 exemption holds only while it spawns nothing
// (spec 3.7 "Exit codes"). This file names no scheduler tool.
//
// The child resolves the record path the default way, through `schedulePath()`, with
// DAILY_BRIEFING_STATE_DIR set to this test's own temp dir, and its env otherwise spreads `process.env`,
// which the fixture import above has armed. The uninstall case injects a fake exec that answers BY VERB
// (never by the tool's name), a scratch HOME, an env with DBA_TEST_UNIT_DIR and XDG_DATA_HOME under
// scratch dirs, uid 4242, and a fake clock and sleep — nothing real is reached, and nothing waits.
import { test, expect } from "bun:test";
import { mkdtempSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const INSTALL_TS = join(import.meta.dir, "..", "src", "schedule", "install.ts");

/** A temp state dir holding a FIFO at `schedule.json`. */
function fifoStateDir(): { stateDir: string; fifo: string } {
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-fifo-state-")));
  const fifo = join(stateDir, "schedule.json");
  const made = Bun.spawnSync(["mkfifo", fifo]);
  expect(made.exitCode).toBe(0);
  expect(lstatSync(fifo).isFIFO()).toBe(true);
  return { stateDir, fifo };
}

/** Runs `script` in a `bun -e` child with DAILY_BRIEFING_STATE_DIR set to `stateDir`, killed by a 10 s
 *  timer, and asserts it EXITED ON ITS OWN, cleanly; returns its stdout parsed as JSON. The timer is
 *  cleared and the kill enforced in a `finally`, so a regression can neither outlive the test nor orphan
 *  the child. */
async function runChild(script: string, stateDir: string): Promise<unknown> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, DAILY_BRIEFING_STATE_DIR: stateDir },
    stdout: "pipe", stderr: "pipe",
  });
  let killedByTimer = false;
  const timer = setTimeout(() => { killedByTimer = true; child.kill("SIGKILL"); }, 10_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(`killed by the 10 s timer: ${killedByTimer}`).toBe("killed by the 10 s timer: false");
    expect(`exit ${code}, signal ${child.signalCode}, stderr ${JSON.stringify(err.trim())}`).toBe("exit 0, signal null, stderr \"\"");
    return JSON.parse(out.trim());
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");   // a no-op once it has exited; never an orphaned child otherwise
  }
}

test("a FIFO at schedule.json is present but unreadable, and the read never blocks on it", async () => {
  const { stateDir, fifo } = fifoStateDir();
  const script = [
    `const m = await import(${JSON.stringify(INSTALL_TS)});`,
    "const path = m.schedulePath();",
    "const record = await m.readScheduleRecord();",
    "const present = await m.pathPresent(path);",
    "console.log(JSON.stringify({ path, record, present }));",
  ].join("\n");
  expect(await runChild(script, stateDir)).toEqual({ path: fifo, record: null, present: true });
}, 20_000);

test("uninstall with a FIFO record: --invoker app is exit 2 before any exec; the terminal removes it, exit 0 — never blocking", async () => {
  const { stateDir, fifo } = fifoStateDir();
  const home = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-fifo-home-")));
  const units = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-fifo-units-")));
  const script = [
    `const m = await import(${JSON.stringify(INSTALL_TS)});`,
    "const verbs = [], said = [], warned = [];",
    "let clock = 100000;",
    // By VERB: the two prints and the list report service-not-found (exit 113); anything else succeeds.
    "const exec = async (cmd) => { verbs.push(cmd[1]); return cmd[1] === 'print' || cmd[1] === 'list' ? { code: 113, out: '', err: '' } : { code: 0, out: '', err: '' }; };",
    "const deps = {",
    `  exec, platform: "darwin", home: ${JSON.stringify(home)}, uid: 4242,`,
    `  env: { ...process.env, DBA_TEST_UNIT_DIR: ${JSON.stringify(units)}, XDG_DATA_HOME: ${JSON.stringify(join(home, ".local", "share"))} },`,
    "  now: () => new Date('2026-09-14T12:00:00.000Z'), say: (l) => said.push(l), warn: (l) => warned.push(l),",
    "  clock: () => clock, sleep: async (ms) => { clock += ms; },",
    "};",
    "const app = await m.uninstallSchedule({ invoker: 'app' }, deps);",
    "const appVerbs = verbs.splice(0), appWarned = warned.splice(0);",
    "const cli = await m.uninstallSchedule({ invoker: 'cli' }, deps);",
    "const present = await m.pathPresent(m.schedulePath());",
    "console.log(JSON.stringify({ app, appVerbs, appWarned, cli, cliVerbs: verbs, cliWarned: warned, removed: said[0], present }));",
  ].join("\n");
  expect(await runChild(script, stateDir)).toEqual({
    app: 2, appVerbs: [],
    appWarned: [`This background scheduler wasn't set up by this app (a schedule record that can't be read at ${fifo}, with no unit file). Removing it needs your go-ahead.`],
    // A file on disk, so no first check: unregister, the check, then the FIFO unlinked — never opened.
    cli: 0, cliVerbs: ["bootout", "bootout", "print", "print", "list"], cliWarned: [],
    removed: "Removed the background scheduler.",
    present: false,
  });
}, 20_000);
