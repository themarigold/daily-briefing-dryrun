// src/runlock.ts — the ADVISORY cross-process run lock (backlog IN-5).
//
// WHY IT EXISTS. `marker.ts:200` checkRanToday READS the day marker and `marker.ts:227` stampToday
// WRITES it, with nothing between them — a check-then-act race. Today it is nearly unreachable
// because only the launchd tick invokes the pipeline and ticks are 600 s apart. The desktop-app
// pivot makes it reachable: a GUI "run now" firing while a scheduled tick is mid-generation produces
// two provider calls and two deliveries for one day.
//
// ⚠ IT SITS BESIDE THE MARKER, IT DOES NOT REPLACE IT. `checkRanToday`'s repair semantics (an
// unreadable marker is repaired from the dated archive, never answered "false", because answering
// false regenerates every tick — the self-inflicted usage wall its comment documents) are untouched.
// This lock adds mutual exclusion around the generate+stamp span and changes no gate.
//
// ⚠ FAIL-OPEN IS MANDATORY AND IS THE WHOLE DESIGN. A new gate that can fail CLOSED is a mechanism
// for silently losing a morning, which is strictly worse than the duplicate run it prevents. So only
// a lock that is BOTH fresh AND readable AND held by a live process blocks; every other condition —
// stale mtime, unparseable contents, a dead holder, a permission error, a filesystem that cannot do
// O_EXCL — PROCEEDS. Each of those is exercised by a test rather than asserted here.
import { randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { supportDir } from "./marker";
import { TIMEOUT_MS, KILL_GRACE_MS } from "./provider";
import { PROVIDER_RETRY_DELAYS_MS } from "./core";
import { NET_DEFAULT_GRACE_MS } from "./net";
import { sanitizeTimeoutMs, recapPhaseBoundMs } from "./recapBudget";

/** MARGIN on top of the holder's derived worst case — NOT the bound itself. */
export const LOCK_STALE_GRACE_MS = 60_000;

/** Provider attempts one held lock can cover, worst case. `withRetry` runs
 *  `1 + PROVIDER_RETRY_DELAYS_MS.length`; the C1/B6 hardening ladder adds two more SINGLE attempts
 *  (rung 1 with flags, rung 2 with them suppressed) once that schedule is exhausted — core.ts:628-641
 *  calls the composition "the intended worst case of 5 calls". Derived from the schedule rather than
 *  written as 5, so lengthening the schedule widens the window automatically. */
export const MAX_PROVIDER_ATTEMPTS = 1 + PROVIDER_RETRY_DELAYS_MS.length + 2;

/**
 * How old a held lock may get before it is treated as ABANDONED.
 *
 * ⚠ DERIVED FROM THE HOLDER'S OWN CONSTANTS, and the derivation is the fix for a measured defect.
 * This used to be `timeoutMs + LOCK_STALE_GRACE_MS` = 180 s at the defaults, described as "one
 * provider call plus retries, which extend it — hence a grace". The numbers contradicted the words:
 * the retry SLEEPS alone are 135 s, more than twice that 60 s grace. Everything below runs INSIDE the
 * lock (taken at main.ts before runCore):
 *
 *     net gate grace                 NET_DEFAULT_GRACE_MS            25 s
 *   + MAX_PROVIDER_ATTEMPTS attempts each bounded by timeoutMs + KILL_GRACE_MS   5 x 125 s
 *   + the retry sleeps              sum(PROVIDER_RETRY_DELAYS_MS)   135 s
 *   + margin                        LOCK_STALE_GRACE_MS             60 s
 *
 * so ONE timed-out attempt plus the FIRST retry sleep (25 + 125 + 45 = 195 s) already exceeded the old
 * bound while the holder was alive and mid-generation. Measured: an alive holder at 185 s was EVICTED,
 * the successor's marker re-read passed (the first run has not stamped — it is still generating), and
 * the run proceeded: two provider calls and two deliveries for one day, i.e. exactly the IN-5 failure
 * this module exists to close, restored precisely in the slow-run case where a GUI "run now" is most
 * likely to land.
 *
 * ⚠ THE LONGER WINDOW COSTS NOTHING IN THE FAIL-OPEN DIRECTION, which is why it is safe to widen so
 * far past the 600 s tick interval. A CRASHED holder is reclaimed IMMEDIATELY by `holderAlive` — its
 * pid is gone — so this bound never governs the crash case at all. It governs only pid REUSE: a
 * recycled pid that now belongs to an unrelated live process, where liveness says "alive" and mtime is
 * the only remaining backstop. Trading a rarer, bounded stall against a reproducible double delivery
 * is the trade this module's header already commits to in the other direction.
 *
 * A non-finite or non-positive configured `timeoutMs` falls back to the default rather than collapsing
 * the window: `provider.timeoutMs` is user-supplied, and a bound of zero is a gate that never holds.
 * (`sanitizeTimeoutMs`, shared with tier B's call deadline so the two cannot sanitise differently.)
 *
 * ⚠ TIER B (spec §4.9): with `opts.recapCampaigns` set — `main.ts` sets it iff the mode resolves to
 * `trial`/`on` — the bound gains exactly `D_B` = `recapPhaseBoundMs(t)` (290 s at the default: 845 s →
 * 1 135 s), B's phase's own worst case, which runs inside the lock. Without it the bound is UNCHANGED, so
 * mode `off`, an absent key and a malformed one all keep today's 845 s.
 */
export function lockStaleMs(timeoutMs: number = TIMEOUT_MS, opts?: { recapCampaigns?: boolean }): number {
  const t = sanitizeTimeoutMs(timeoutMs);
  const backoffMs = PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  const base = NET_DEFAULT_GRACE_MS + MAX_PROVIDER_ATTEMPTS * (t + KILL_GRACE_MS) + backoffMs + LOCK_STALE_GRACE_MS;
  return opts?.recapCampaigns === true ? base + recapPhaseBoundMs(t) : base;
}

/** `nonce` is OPTIONAL on purpose: a lock written by an OLDER build carries none, and that file must
 *  still PARSE — an unparseable lock is reclaimed, and reclaiming a live holder's lock is the double
 *  delivery this module exists to prevent. `release` therefore reads a missing nonce as "not mine",
 *  which is the fail-safe direction: it declines to unlink rather than deleting a stranger's lock. */
export type LockInfo = { pid: number; startedIso: string; invoker: string; nonce?: string };

export function runLockPath(stateDir: string = supportDir()): string {
  return join(stateDir, "run.lock");
}

/** Is `pid` a process that still exists? `kill(pid, 0)` sends no signal and only tests existence.
 *  ESRCH is the ONLY answer that proves death — EPERM means it exists and belongs to someone else,
 *  and anything unexpected is read as ALIVE so an exotic platform cannot make us reclaim a live lock.
 *
 *  ⚠ This only ever makes the lock MORE fail-open: a dead holder becomes reclaimable immediately
 *  instead of after the staleness window. Pid REUSE (a recycled pid now belonging to something else)
 *  is the opposite direction and is NOT handled here — it makes this check say "alive", which simply
 *  falls back to the mtime bound below. That asymmetry is deliberate. */
function holderAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function parseLock(text: string): LockInfo | null {
  try {
    const o = JSON.parse(text) as Partial<LockInfo>;
    if (typeof o?.pid !== "number" || typeof o.startedIso !== "string" || typeof o.invoker !== "string") return null;
    // `nonce` is carried through when present and left undefined otherwise — NOT required, so a lock
    // from an older build still parses rather than being reclaimed out from under a live holder.
    return { pid: o.pid, startedIso: o.startedIso, invoker: o.invoker, ...(typeof o.nonce === "string" ? { nonce: o.nonce } : {}) };
  } catch { return null; }
}

export type LockHeld = {
  acquired: true;
  /** Removes the lock — idempotent, never throws, and a NO-OP when the file on disk is no longer
   *  ours. The ownership re-check matters: a run that overran the staleness window has had its lock
   *  legitimately reclaimed by a successor, and unlinking blindly would delete the SUCCESSOR's lock
   *  and re-open the race this module exists to close. */
  release: () => Promise<void>;
};
export type LockBusy = { acquired: false; holder: LockInfo };

/**
 * Try to take `<stateDir>/run.lock` with O_EXCL (`open(path, "wx")` — the one create-or-fail
 * primitive node/Bun expose, atomic on POSIX and Windows).
 *
 * Returns `{acquired:false, holder}` ONLY for a fresh, parseable lock whose pid is alive. Everything
 * else returns `{acquired:true, release}` — see the fail-open note at the top of this file.
 */
export async function acquireRunLock(opts: {
  invoker: string;
  /** `provider.timeoutMs` (or its 120 s default). A lock older than `lockStaleMs(timeoutMs)` — the
   *  holder's derived worst case, NOT one timeout — is abandoned. See that function. */
  timeoutMs: number;
  /** Tier B is enabled for this run (mode `trial`/`on`): forwarded to `lockStaleMs`, which then widens
   *  the staleness bound by B's phase bound (spec §4.9). Absent/false ⇒ the bound is unchanged. */
  recapCampaigns?: boolean;
  /** Test seam ONLY for placing the lock elsewhere; production always uses `runLockPath()`. There is
   *  deliberately no injected clock or pid: staleness is exercised with `utimes` and liveness with a
   *  really-dead pid, so an injected one would be a knob nothing needs. */
  path?: string;
}): Promise<LockHeld | LockBusy> {
  const path = opts.path ?? runLockPath();
  const now = new Date();
  const mine: LockInfo = { pid: process.pid, startedIso: now.toISOString(), invoker: opts.invoker, nonce: randomUUID() };
  const body = JSON.stringify(mine);

  /** Set at acquire time; `release` refuses to unlink a file that is no longer the one we created. */
  let ino: number | undefined;

  const release = async (): Promise<void> => {
    try {
      const f = Bun.file(path);
      if (!(await f.exists())) return;
      // ⚠ IDENTITY IS THE INODE FIRST, the contents second — and NEITHER IS SUFFICIENT ALONE.
      // Measured: a lock taken and a successor's lock taken in the SAME MILLISECOND carry the same
      // `{pid, startedIso}` when both run in one process, so a contents-only check let an overrunning
      // run delete its successor's lock and re-open the race.
      //
      // ⚠ AND THE INODE FAST PATH DOES NOT COVER THE GAP. It rests on unlink+create handing out a
      // DIFFERENT inode, which is an APFS property, not a POSIX guarantee: ext4 hands a freed inode
      // straight back to the next create, so on CI ubuntu the successor's unlink+create at the
      // reclaim path below can land on the SAME inode. With the pid and startedIso already colliding,
      // that made all three identity checks agree and release deleted the successor's lock — the
      // intermittent CI failure of this file's NO-OP release test. ⚠ NOT A MEASUREMENT — it has never
      // been reproduced, here or on CI, and it never reproduces locally because APFS does not reuse
      // inode numbers. It is what reading this code against ext4's allocator explains, and it accounts
      // for the failure being CI-only; treat it as the leading hypothesis, not a confirmed cause.
      //
      // So the discriminator is the PER-ACQUIRE nonce, which survives both collisions: it is freshly
      // random per acquire, so it cannot coincide across holders however the clock or the allocator
      // behaves. A lock with NO nonce (an older build's) is read as not ours and left alone.
      const st = await stat(path);
      if (ino !== undefined && st.ino !== ino) return;
      const cur = parseLock(await f.text());
      if (cur && (cur.pid !== mine.pid || cur.startedIso !== mine.startedIso || cur.nonce !== mine.nonce)) return;
      await unlink(path);
    } catch { /* releasing must never cost an exit code */ }
  };

  const remember = async (): Promise<void> => {
    try { ino = (await stat(path)).ino; } catch { ino = undefined; }
  };

  const createOnce = async (): Promise<"ok" | "exists" | "no-dir" | "error"> => {
    try {
      const fh = await open(path, "wx");
      try { await fh.writeFile(body); } finally { await fh.close(); }
      return "ok";
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "EEXIST" ? "exists" : code === "ENOENT" ? "no-dir" : "error";
    }
  };
  /** O_EXCL create, creating the state directory first if this is a machine that has never run.
   *  (`stampTick` normally creates it, but it swallows its own failures, so this cannot assume it.) */
  const create = async (): Promise<boolean> => {
    const first = await createOnce();
    if (first === "ok") return true;
    if (first !== "no-dir") return false;
    try { await mkdir(dirname(path), { recursive: true }); } catch { return false; }
    return (await createOnce()) === "ok";
  };

  if (await create()) { await remember(); return { acquired: true, release }; }

  // The file exists (or could not be created). Decide whether it is a LIVE holder.
  let holder: LockInfo | null = null;
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    holder = parseLock(await Bun.file(path).text());
    ageMs = now.getTime() - (await stat(path)).mtimeMs;
  } catch { holder = null; }   // unreadable ⇒ fail open below

  // ⚠ `lockStaleMs`, not `timeoutMs + LOCK_STALE_GRACE_MS`. Freshness is the PID-REUSE BACKSTOP for
  // liveness, not a second gate on the holder's health: a holder `kill(pid,0)` proves alive is still
  // generating, and evicting it is a double delivery. See lockStaleMs for the measurement.
  const fresh = ageMs <= lockStaleMs(opts.timeoutMs, { recapCampaigns: opts.recapCampaigns });
  if (holder && fresh && holderAlive(holder.pid)) return { acquired: false, holder };

  // Stale / unparseable / dead holder / unreadable ⇒ RECLAIM. Best-effort, in the fail-open
  // direction throughout: if the unlink races another reclaimer we simply overwrite, and if even the
  // overwrite fails we still proceed — a lock we could not write is a lock that cannot stop tomorrow.
  try { await unlink(path); } catch { /* raced or unremovable */ }
  if (await create()) { await remember(); return { acquired: true, release }; }
  try { await Bun.write(path, body); } catch { /* proceed unlocked rather than lose a morning */ }
  await remember();
  return { acquired: true, release };
}
