// test/fixtures/run-tmp.ts — ONE private temp root per `bun test` process, and TMPDIR pointed into it.
//
// Side-effect module, imported FIRST by test/fixtures/isolate-state.ts (and so by test/preload.ts), before
// anything in the process calls `tmpdir()`. From then on every temp directory this process makes — the
// registry's `removeAtRunEnd` dirs, isolate-state's three baselines, the provider's stable fallback name,
// and those of any child given `env: { ...process.env, … }` — is created INSIDE `RUN_TMP`, never beside
// the user's other TMPDIR entries. `tmpdir()` re-reads TMPDIR on every call (measured, bun 1.3.14).
//
// test/preload.ts removes `RUN_TMP` as the LAST step of its run-wide afterAll. A run that never reaches it
// — interrupted (SIGINT/SIGTERM), or run from a cwd without bunfig.toml (no preload) — leaves this ONE
// directory instead of every directory the run made, and the next run that loads the preload sweeps it
// (`sweepDeadRunRoots`, below) once its owner is dead.
//
// What it does not cover: a child spawned with NO `env` sees bun's startup environment (fixtures/
// isolate-state.ts says the same of its variables), so it uses the outer TMPDIR.
//
// NOT imported by anything under src/ or scripts/ (the eval CLI reaches fixtures/temp-dirs.ts, never this):
// only a test process redirects its own TMPDIR.
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { removeTree } from "./temp-dirs";

/** The name every run root starts with, and the only names the sweep looks at. */
export const RUN_ROOT_PREFIX = "dba-run-";
/** The owner marker inside every run root (format: `ownerMarker`). */
export const OWNER_MARKER = ".dba-run-owner";
const MARKER_HEADER = "dba-run-owner v2\n";
/** A marker longer than this is not ours and is never read further (ours is well under 200 bytes). */
const MARKER_MAX_BYTES = 512;

/** Which pid namespace a pid in a marker belongs to: the hostname, and on Linux the pid-namespace id and the
 *  boot id. `kill(pid, 0)` answers only for THIS namespace on THIS host and boot, so a marker whose identity
 *  differs from the sweeper's says nothing about whether its owner is alive. Undefined when any part cannot
 *  be read or is not plain printable text: such a process neither matches nor is matched (it sweeps nothing,
 *  and its own marker says `unidentified`). */
function readIdentity(): string | undefined {
  const plain = (v: string): string | undefined => (/^[!-~]{1,255}$/.test(v) ? v : undefined);
  try {
    const host = plain(hostname());
    if (host === undefined) return undefined;
    if (process.platform !== "linux") return `host=${host}\n`;
    const ns = plain(readlinkSync("/proc/self/ns/pid"));
    const boot = plain(readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    return ns === undefined || boot === undefined ? undefined : `host=${host}\npidns=${ns}\nboot=${boot}\n`;
  } catch { return undefined; }
}
const IDENTITY = readIdentity();

/** The owner marker for `pid` as THIS process writes it: a header, the pid, then this process's identity
 *  (`readIdentity`), each line `\n`-terminated. Exported so tests can plant a marker the sweep accepts. */
export function ownerMarker(pid: number): string {
  return `${MARKER_HEADER}pid=${pid}\n${IDENTITY ?? "unidentified\n"}`;
}

export const OUTER_TMP = tmpdir();
// `tmpdir()` spelled at the call, not OUTER_TMP: isolation.meta scanner 5 sees only that shape.
export const RUN_TMP = mkdtempSync(join(tmpdir(), "dba-run-"));
// Written before TMPDIR moves, so a root without one was never a whole run's (or is still being made) and is
// never swept. No start time: a reused pid makes a dead run's root look LIVE, which only keeps it until a
// later run, never the reverse (an owner's own pid is always alive while it runs).
writeFileSync(join(RUN_TMP, OWNER_MARKER), ownerMarker(process.pid), { flag: "wx", mode: 0o600 });
process.env.TMPDIR = RUN_TMP;
// os.tmpdir() on Windows reads TEMP/TMP, not TMPDIR.
if (process.platform === "win32") { process.env.TEMP = RUN_TMP; process.env.TMP = RUN_TMP; }

/** The pid a marker names when the marker is EXACTLY `ownerMarker(pid)` for this process's identity, or
 *  undefined for anything else: another host, pid namespace or boot; an unidentified writer or sweeper; the
 *  pid-only format of the first version; a marker read mid-write. Read without following a symlink
 *  (O_NOFOLLOW), without blocking (O_NONBLOCK: a FIFO opens at once), only if `fstat` says it is a regular
 *  file, and at most MARKER_MAX_BYTES + 1 bytes. */
function markerPid(root: string): number | undefined {
  if (IDENTITY === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(join(root, OWNER_MARKER), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return undefined;
    const buf = Buffer.alloc(MARKER_MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MARKER_MAX_BYTES) return undefined;
    const text = buf.subarray(0, n).toString("utf8");
    const m = /^dba-run-owner v2\npid=([1-9][0-9]{0,9})\n/.exec(text);
    return m !== null && text === ownerMarker(Number(m[1])) ? Number(m[1]) : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}

/** True only when the OS says there is no such process (ESRCH). EPERM — alive, another uid's — and any
 *  other error count as alive, so the sweep never removes a live run's root. The same rule as the GUI's
 *  `pid_is_dead` (gui/src-tauri/src/config_save.rs). */
function pidIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Remove the run roots of DEAD earlier runs directly under `dir` (test/preload.ts passes OUTER_TMP). An
 *  entry is removed only when ALL of these hold: its name starts with `dba-run-`; `lstat` says it is a real
 *  directory (a symlink is never followed); it is owned by `uid`; its owner marker is exactly what THIS
 *  process would write for that pid (`markerPid`: same hostname, and on Linux the same pid namespace and
 *  boot); `kill(pid, 0)` reports ESRCH; and the entry is still the same directory (dev and inode) just
 *  before it is removed. Anything else — the legacy leaked `dba-repo-*`/`dba-isolated-*` dirs, a
 *  look-alike, another uid's run, another host's, namespace's or boot's, or one whose identity cannot be
 *  read — is left alone.
 *  What that guarantees: on Linux a matching marker was written on a host of this name, in this pid
 *  namespace, during this boot, so its pid means the same process to `kill` here and a live owner is never
 *  removed. What it does not: off Linux (no pid namespaces; no boot id read) the hostname is the whole
 *  identity, so two machines with the SAME hostname sharing one TMPDIR could mistake each other's live runs
 *  for dead ones. In the other direction, a hostname change, or on Linux a reboot, only makes older roots
 *  unsweepable (kept), never wrongly removed. On a Mac with no HostName set, `os.hostname()` comes from the
 *  network, so moving to another network is such a change: an interrupted run's root is kept until the Mac is
 *  back on the network it ran on.
 *  Best effort: a root that will not go is reported in `failed`, never thrown. `uid` is a parameter only so
 *  a test can stand in for another uid; with no uid (Windows) nothing is swept. */
export function sweepDeadRunRoots(dir: string, uid: number | undefined = process.getuid?.()): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  if (uid === undefined) return { removed, failed };
  let names: string[];
  try { names = readdirSync(dir); } catch { return { removed, failed }; }
  // Filtered before anything else: a long-lived TMPDIR can hold hundreds of thousands of entries (348,679 on
  // the author's machine, 2026-10-19: one readdir of it measured 0.2-0.9 s).
  for (const name of names.filter((n) => n.startsWith(RUN_ROOT_PREFIX)).sort()) {
    const root = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(root);
      if (!st.isDirectory() || st.uid !== uid) continue;
    } catch { continue; }
    const pid = markerPid(root);
    if (pid === undefined || !pidIsDead(pid)) continue;
    try {
      const now = lstatSync(root);   // swapped since the checks above: not the directory they judged
      if (!now.isDirectory() || now.dev !== st.dev || now.ino !== st.ino) continue;
    } catch { continue; }
    try { removeTree(root); removed.push(root); } catch (e) { failed.push(e instanceof Error ? e.message : String(e)); }
  }
  return { removed, failed };
}
