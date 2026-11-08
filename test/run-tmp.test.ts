// The run root (test/fixtures/run-tmp.ts).
//   - From a child `bun test`: with the preload a run leaves its TMPDIR exactly as it found it, apart from a
//     DEAD earlier run's root, which it sweeps; without the preload (cwd outside the package root) it leaves
//     ONE `dba-run-*` dir and sweeps nothing. Nothing else already in TMPDIR is touched either way.
//   - In-process, `sweepDeadRunRoots` on a sandbox (never the machine's real TMPDIR): it removes a
//     `dba-run-*` dir only when it is a real directory, of this uid, holding a regular-file owner marker that
//     names THIS host (and on Linux this pid namespace and boot) and a dead pid. A FIFO marker is judged in a
//     child with a timeout, so a regression that blocks on it fails instead of hanging the run.
import { test, expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { OWNER_MARKER, ownerMarker, RUN_ROOT_PREFIX, sweepDeadRunRoots } from "./fixtures/run-tmp";
import { deadPid } from "./fixtures/dead-pid";

const ROOT = resolve(import.meta.dir, "..");
const PROBE = join(import.meta.dir, "fixtures", "run-tmp.probe.ts");
const SWEEP_PROBE = join(import.meta.dir, "fixtures", "run-tmp-sweep.probe.ts");

/** A fake earlier run root at `dir/name` with the marker THIS process would write for `pid` (or `marker`
 *  verbatim, or none), and a file inside. */
function plantRoot(dir: string, name: string, pid: number | undefined, marker?: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "f"), "x");
  if (marker !== undefined) writeFileSync(join(root, OWNER_MARKER), marker);
  else if (pid !== undefined) writeFileSync(join(root, OWNER_MARKER), ownerMarker(pid));
  return root;
}

const SEEDED = ["dba-run-live", "dba-run-notours", "someone-elses-file"];

function runProbe(preload: boolean): { code: number; out: string; left: string[]; tmp: string } {
  const sandbox = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-runtmp-")));
  const tmp = join(sandbox, "tmp");
  mkdirSync(tmp);
  writeFileSync(join(tmp, "someone-elses-file"), "keep");           // must survive
  mkdirSync(join(tmp, "dba-run-notours"));                            // a look-alike with no marker: must survive
  plantRoot(tmp, "dba-run-live", process.pid);                        // a LIVE run's root (this process): must survive
  plantRoot(tmp, "dba-run-dead", deadPid());                          // a dead run's root: swept only by the preload
  const { DAILY_BRIEFING_STATE_DIR: _s, XDG_CONFIG_HOME: _c, DBA_TEST_UNIT_DIR: _u, ...inherited } = process.env;
  const r = Bun.spawnSync(["bun", "test", PROBE], {
    cwd: preload ? ROOT : sandbox, env: { ...inherited, TMPDIR: tmp }, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString(), left: readdirSync(tmp).sort(), tmp };
}

test("with the preload, a run leaves nothing in TMPDIR but what was already there, less a dead run's root", () => {
  const { code, out, left, tmp } = runProbe(true);
  expect(code).toBe(0);
  expect(left).toEqual(SEEDED);
  expect(out).toMatch(new RegExp(`PROBE_TMPDIR=${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${RUN_ROOT_PREFIX}`));
});

test("without the preload (cwd outside the package root), a run leaves exactly ONE dba-run-* dir and sweeps nothing", () => {
  const { code, left } = runProbe(false);
  expect(code).toBe(0);
  const ours = left.filter((n) => ![...SEEDED, "dba-run-dead"].includes(n));
  expect(ours).toHaveLength(1);
  expect(ours[0]).toMatch(/^dba-run-/);
  expect(left).toEqual([...SEEDED, "dba-run-dead", ours[0]!].sort());
});

/** A fresh sandbox standing in for OUTER_TMP: a registered dir, never the real TMPDIR. */
const sandbox = (): string => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-runsweep-")));

test("the sweep removes a dba-run-* dir whose marker names a dead pid", () => {
  const dir = sandbox();
  const root = plantRoot(dir, "dba-run-dead1", deadPid());
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [root], failed: [] });
  expect(existsSync(root)).toBe(false);
});

test("the sweep keeps a dba-run-* dir whose marker names a live pid", () => {
  const dir = sandbox();
  const root = plantRoot(dir, "dba-run-live1", process.pid);
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a dba-run-* dir whose marker names a live pid it may not signal (EPERM)", () => {
  // pid 1 (launchd / init) is always alive and, unless this runs as root, another uid's: kill(1, 0) is EPERM.
  let code: string | undefined;
  try { process.kill(1, 0); } catch (e) { code = (e as NodeJS.ErrnoException).code; }
  expect(code === undefined || code === "EPERM").toBe(true);
  const dir = sandbox();
  const root = plantRoot(dir, "dba-run-eperm", 1);
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a dead pid's root whose marker names another host", () => {
  const dir = sandbox();
  const dead = deadPid();
  const mine = ownerMarker(dead);
  expect(mine).toMatch(/\nhost=[!-~]+\n/);   // the premise: this process has an identity to differ from
  const root = plantRoot(dir, "dba-run-otherhost", undefined, mine.replace(/\nhost=[!-~]+\n/, "\nhost=some-other-host\n"));
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a dead pid's root whose marker names another pid namespace", () => {
  // On Linux: a different `pidns=` value. Elsewhere this process writes none, so a marker that carries one
  // (a Linux writer's, through a shared TMPDIR) differs the same way.
  const dir = sandbox();
  const mine = ownerMarker(deadPid());
  const other = /\npidns=/.test(mine) ? mine.replace(/\npidns=[!-~]+\n/, "\npidns=pid:[1]\n") : `${mine}pidns=pid:[1]\n`;
  expect(other).not.toBe(mine);
  const root = plantRoot(dir, "dba-run-otherns", undefined, other);
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a dead pid's root in the first version's pid-only marker format", () => {
  const dir = sandbox();
  const root = plantRoot(dir, "dba-run-v1", undefined, `${deadPid()}\n`);
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a root whose marker is a symlink, even to a marker it would accept", () => {
  const dir = sandbox();
  const real = join(dir, "real-marker");
  writeFileSync(real, ownerMarker(deadPid()));
  const root = plantRoot(dir, "dba-run-linkmark", undefined);
  symlinkSync(real, join(root, OWNER_MARKER));
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a root whose marker is a FIFO, and does not block on it", () => {
  const dir = sandbox();
  const root = plantRoot(dir, "dba-run-fifo", undefined);
  expect(Bun.spawnSync(["mkfifo", join(root, OWNER_MARKER)]).exitCode).toBe(0);
  // In a child, with a timeout: a sweep that opened the FIFO blocking would wait for a writer forever.
  const childTmp = join(dir, "child-tmp");   // its own run root lands here, not beside the FIFO root
  mkdirSync(childTmp);
  const { DAILY_BRIEFING_STATE_DIR: _s, XDG_CONFIG_HOME: _c, DBA_TEST_UNIT_DIR: _u, ...inherited } = process.env;
  const r = Bun.spawnSync(["bun", SWEEP_PROBE, dir], { env: { ...inherited, TMPDIR: childTmp }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  expect([r.exitCode, r.stdout.toString().trim()]).toEqual([0, JSON.stringify({ removed: [], failed: [] })]);
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
});

test("the sweep keeps a dba-run-* dir with no marker, or a marker it cannot read as a pid", () => {
  const dir = sandbox();
  const none = plantRoot(dir, "dba-run-nomark", undefined);
  const junk = plantRoot(dir, "dba-run-junk", undefined);
  writeFileSync(join(junk, OWNER_MARKER), "");   // e.g. read mid-write
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(none, "sub", "f"))).toBe(true);
  expect(existsSync(join(junk, "sub", "f"))).toBe(true);
});

test("the sweep keeps a symlinked dba-run-* entry, and leaves its target untouched", () => {
  const dir = sandbox();
  const target = plantRoot(dir, "elsewhere", deadPid());   // would qualify on its own, but the name does not match
  const link = join(dir, "dba-run-link");
  symlinkSync(target, link);
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(existsSync(join(target, "sub", "f"))).toBe(true);
  expect(existsSync(join(target, OWNER_MARKER))).toBe(true);
});

test("the sweep keeps a dead run's dir that does not match dba-run-*", () => {
  const dir = sandbox();
  const roots = ["dba-runx", "dba-repo-dead", "xdba-run-dead"].map((n) => plantRoot(dir, n, deadPid()));
  expect(sweepDeadRunRoots(dir)).toEqual({ removed: [], failed: [] });
  for (const r of roots) expect(existsSync(join(r, "sub", "f"))).toBe(true);
});

test("the sweep keeps a dead run's dir owned by another uid", () => {
  // No test can chown to another uid without root, so the sweep is told it runs as a different uid: every
  // dir here (this process's uid) then belongs to someone else.
  const dir = sandbox();
  const root = plantRoot(dir, "dba-run-otheruid", deadPid());
  const me = process.getuid!();
  expect(sweepDeadRunRoots(dir, me + 1)).toEqual({ removed: [], failed: [] });
  expect(existsSync(join(root, "sub", "f"))).toBe(true);
  expect(sweepDeadRunRoots(dir, me)).toEqual({ removed: [root], failed: [] });   // the control: same dir, own uid
});
