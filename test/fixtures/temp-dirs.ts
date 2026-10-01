// test/fixtures/temp-dirs.ts — the run-wide list of temp directories to delete when `bun test` ends.
//
// A test or fixture wraps its mkdtemp call in place — `removeAtRunEnd(mkdtempSync(join(tmpdir(),
// "dba-x-")))` — and `test/preload.ts` drains the list from the one run-wide afterAll. Nothing is removed
// before then, so a directory lives exactly as long as it did unregistered and no test's timing,
// behaviour, or assertions change. preload.ts owns everything about bun's behaviour at run end (why the
// hook lives there, how a failure is reported); this module owns the registration contract.
//
// No `bun:test` import here: `src/eval/run-case.ts` reaches this module from the eval CLI, outside the
// test runner, where the list is simply never drained.
import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const registered: string[] = [];

/** Register `dir` for removal after the last test file and return it unchanged. A directory the test
 *  already removed is a no-op at that point (the walk's ENOENT branch, then `force`); registering the same
 *  path twice is harmless.
 *  Accepts only a DIRECT child of `tmpdir()`: a recursive chmod-and-delete gets one boundary, and every
 *  caller registers exactly that — a mkdtemp result, or the provider's stable fallback name.
 *  Both sides are normalised with `resolve`; nothing realpaths (so a realpath'd spelling of a real child
 *  is refused — no caller passes one). On the base side, `tmpdir()` returns TMPDIR nearly verbatim — only
 *  one trailing slash stripped — so a raw string compare mismatches the `join(tmpdir(), …)` every caller
 *  builds under `/tmp//x`, `/tmp/./x`, `//tmp/x` (measured; a false positive here would throw in every
 *  test). On the registrant's side, a trailing slash makes lstat and rm FOLLOW a symlinked root, so the
 *  RESOLVED path is what gets pushed and removed. `..` or a symlinked middle segment walks out of the base
 *  (also measured); "direct child" closes both, along with nested registrations. */
export function removeAtRunEnd(dir: string): string {
  const path = resolve(dir);
  const base = resolve(tmpdir());
  // `path === base` is reachable only under TMPDIR=/ (dirname("/") === "/"): never register the root itself.
  if (dirname(path) !== base || path === base) throw new Error(`removeAtRunEnd: ${dir} is not a direct child of ${tmpdir()}`);
  registered.push(path);
  return dir;
}

/** Delete every registered directory and forget it. Each is attempted even if an earlier one failed —
 *  one unremovable directory must not strand the other several hundred — and the failures, if any, are
 *  thrown together afterwards, one `path: reason` line each, so the run fails visibly instead of leaking
 *  silently. Trust the path over the reason: bun 1.3.14 reports an immutable (`uchg`) entry as EFAULT,
 *  not EPERM. */
export function removeRegisteredTempDirs(): void {
  const dirs = registered.splice(0);
  const failures: string[] = [];
  for (const dir of dirs) {
    let reason = tryRemove(dir);
    if (reason !== undefined) reason = tryRemove(dir);   // once more: a straggler still writing can move the target
    if (reason !== undefined) failures.push(`${dir}: ${reason}`);
  }
  if (failures.length > 0) throw new Error(`could not remove ${failures.length} temp dir(s):\n  ${failures.join("\n  ")}`);
}

/** One attempt; returns why it did not fully succeed, or undefined. The chmod walk and the rm are separate
 *  steps on purpose: a walk that fails on one entry (EPERM on something this uid does not own) must not
 *  skip the rm of everything else, so its error is reported only if the rm then leaves something behind.
 *  The lstat after `rmSync` is there because bun's `force` also swallows the ENOENT a concurrent deleter
 *  inside the tree provokes and returns with the directory still present (measured): without it that shape
 *  would be exactly the silent leak this list exists to end. */
function tryRemove(dir: string): string | undefined {
  let walk: string | undefined;
  try { makeRemovable(dir); } catch (e) { walk = reasonOf(e); }
  try {
    rmSync(dir, { recursive: true, force: true });
    if (!stillPresent(dir)) return undefined;
    return `still present after rm${walk ? ` (walk: ${walk})` : ""}`;
  } catch (e) {
    return `${reasonOf(e)}${walk ? ` (walk: ${walk})` : ""}`;
  }
}

function reasonOf(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function stillPresent(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** `rmSync` cannot enter a directory whose mode is 000 — measured on bun 1.3.14: EACCES, and `force`
 *  covers only a missing path — and some tests leave one behind on purpose (harden.ladder's "vanish" case
 *  chmods `state/provider-cwd` to 000 to prove the provider survives it). Give the owner rwx on every
 *  directory first, parent before children, since a 000 parent cannot be listed until it is fixed.
 *  `lstat`, never `stat`: tests plant symlinks to directories (config's `dba-symlink-`, harden's squat
 *  and `dba-plink-` cases), and a symlink must be unlinked by `rmSync`, not followed and chmodded.
 *  Files need nothing — unlinking one needs the parent's write bit, not the file's. ENOENT anywhere in
 *  the walk means the entry is already gone — its test removed it, or another process sharing this
 *  TMPDIR did — which is the wanted outcome, not a failure; anything else joins the aggregate error. */
function makeRemovable(path: string): void {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory()) return;
    if ((st.mode & 0o700) !== 0o700) chmodSync(path, (st.mode & 0o7777) | 0o700);
    for (const name of readdirSync(path)) makeRemovable(join(path, name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
