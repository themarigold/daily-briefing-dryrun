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
import { mkdir, open, stat, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { supportDir } from "./marker";
import { TIMEOUT_MS, KILL_GRACE_MS, defaultTimeoutMs } from "./provider";
import { PROVIDER_RETRY_DELAYS_MS } from "./core";
import { NET_DEFAULT_GRACE_MS, NET_PER_PROBE_MS } from "./net";
import { attemptBoundMs } from "./attemptBounds";
import { sanitizeTimeoutMs, recapPhaseBoundMs } from "./recapBudget";
import { CALENDAR_STEP_WORST_MS } from "./calendar/bounds";
import { resolveRecapCampaigns } from "./config";
import { resolveCalendar } from "./calendar/config";
import type { Config } from "./types";

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
 * This used to be `timeoutMs + LOCK_STALE_GRACE_MS` = 180 s at the CLI defaults, described as "one
 * provider call plus retries, which extend it — hence a grace". The numbers contradicted the words:
 * the retry SLEEPS alone are 135 s, more than twice that 60 s grace. Everything below runs INSIDE the
 * lock (taken at main.ts before runCore), using the CLI defaults below:
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
 * `trial`/`on` — the bound gains exactly `D_B` = `recapPhaseBoundMs(t)` (290 s at the CLI default: 845 s →
 * 1 135 s), B's phase's own worst case, which runs inside the lock. Without it the bound is UNCHANGED, so
 * mode `off`, an absent key and a malformed one all keep the CLI's 845 s base.
 *
 * ⚠ CALENDAR (v0.3.0, spec r4 §3 "Run lock"): with `opts.calendar` set — `main.ts` sets it iff `cfg.calendar`
 * resolves enabled — the bound gains the calendar step's worst case, `CALENDAR_STEP_WORST_MS` (35 s: its 30 s bound
 * plus the reconcile, prompt build and health write), "as it already does for recap campaigns". The step runs once
 * per run, before the first attempt, so it is added once. Absent/false ⇒ unchanged.
 */
export function lockStaleMs(timeoutMs: number = TIMEOUT_MS, opts?: { recapCampaigns?: boolean; calendar?: boolean }): number {
  const t = sanitizeTimeoutMs(timeoutMs);
  const backoffMs = PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  const base = NET_DEFAULT_GRACE_MS + MAX_PROVIDER_ATTEMPTS * (t + KILL_GRACE_MS) + backoffMs + LOCK_STALE_GRACE_MS;
  return base + (opts?.recapCampaigns === true ? recapPhaseBoundMs(t) : 0) + (opts?.calendar === true ? CALENDAR_STEP_WORST_MS : 0);
}

// ── the heartbeat (provider fallback, P1-M4-T2; spec r9 §5 Run lock) ──────────────────────────────────────

/** How often a holder that still owns its lock touches it. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Margin on top of the heartbeat cap's derived worst case, as `LOCK_STALE_GRACE_MS` is for `lockStaleMs`. */
export const HEARTBEAT_MARGIN_MS = LOCK_STALE_GRACE_MS;

/** An EARLIER entry's worst case: up to four attempts (its try and one retry, then the two ladder rungs), each the
 *  walk's per-attempt bound (`attemptBoundMs`, the larger of the CLI and API deadlines — hub Q24 (4)), one ~30 s retry
 *  wait (≤ `retryAfterMs` 30 s), and two network re-check rounds — the `beforeRungs` probe and, once the rungs ran,
 *  the FRESH probe before the move-on (P1-M7 checkpoint); without rungs the move-on reuses the first, so never more. */
export function earlierEntryTermMs(timeoutMs: number): number {
  return 4 * attemptBoundMs(timeoutMs) + 30_000 + 2 * NET_PER_PROBE_MS;
}

/** The LAST entry's worst case: every attempt `withRetry` and the ladder can make (`MAX_PROVIDER_ATTEMPTS`), each the
 *  per-attempt bound, plus the retry sleeps, plus the one network probe round after a retryable failure (P1-M7-T4). */
export function lastEntryTermMs(timeoutMs: number): number {
  return MAX_PROVIDER_ATTEMPTS * attemptBoundMs(timeoutMs) + PROVIDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + NET_PER_PROBE_MS;
}

/**
 * How long a walk over `entries` may keep its lock fresh: the net gate's grace, plus each entry's LARGER term,
 * plus the margin — and, under `lockStaleMs`'s own conditions, the calendar step's worst case (a fixed bound,
 * not timeout-scaled) and tier B's phase bound at the LONGEST entry timeout (the grouper reuses the WINNER's
 * instance and timeout, spec r9 §5 step 6, and any entry can win). Past it the heartbeat stops, so a holder stuck
 * beyond any honest walk becomes evictable by staleness again. `lockStaleMs` is unchanged.
 *
 * The `max` per entry: with today's constants the last term is always the larger (last − earlier = the per-attempt
 * bound + 102 000, pinned by a test), so `max` changes nothing now; it stays so a retuned retry schedule cannot silently undercut
 * an entry's earlier-position worst case.
 */
export function heartbeatCapMs(entries: readonly { timeoutMs: number }[], opts?: { recapCampaigns?: boolean; calendar?: boolean }): number {
  const perEntry = entries.reduce((a, e) => a + Math.max(earlierEntryTermMs(e.timeoutMs), lastEntryTermMs(e.timeoutMs)), 0);
  const t = entries.length === 0 ? sanitizeTimeoutMs(TIMEOUT_MS) : Math.max(...entries.map((e) => sanitizeTimeoutMs(e.timeoutMs)));
  return NET_DEFAULT_GRACE_MS + (opts?.calendar === true ? CALENDAR_STEP_WORST_MS : 0)
    + (opts?.recapCampaigns === true ? recapPhaseBoundMs(t) : 0) + perEntry + HEARTBEAT_MARGIN_MS;
}

type IntervalTimers = {
  setInterval: (fn: () => void | Promise<void>, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (h: ReturnType<typeof setInterval>) => void;
};
const realTimers: IntervalTimers = { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (h) => clearInterval(h) };

/** The one line a fail-open acquisition prints (spec r9 §5 "Fail-open acquisition"; classified, as not a posture
 *  warning, in test/posture.test.ts). */
export const FAIL_OPEN_LOCK_DIAGNOSTIC = "⚠ run lock: could not take the lock file exclusively — this run proceeds without a heartbeat or ownership checks";

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
  /** HOW the lock was taken (provider fallback, P1-M4-T1): `created` — our O_EXCL create; `reclaimed` — a
   *  stale, unparseable or dead holder's lock removed and re-created; `fail-open` — the lock could not be
   *  re-created, so it was overwritten in place (or not written at all) and the run proceeds unlocked in
   *  spirit. Only `created` and `reclaimed` get a heartbeat; the walk treats `fail-open` as nothing to lose. */
  owned: "created" | "reclaimed" | "fail-open";
  /** Is the lock on disk still this acquisition's (provider fallback, P1-M4-T1)? The question the WALK and the SHELL
   *  ask, and the LENIENT reading (`ownsForRun`): ENOENT or a mismatched identity is lost; any other I/O error is
   *  retried once and then read as still owned, so a stat blip never quiet-stops a delivery (P1-M8 checkpoint LOW 3).
   *  `release` and the heartbeat use the STRICT reading (`owns`) instead, where any read failure is "not ours", so a
   *  lock that cannot be identified is never unlinked or kept fresh. Never throws. */
  stillOwns: () => Promise<boolean>;
  /** Removes the lock — idempotent, never throws, and a NO-OP when the file on disk is no longer
   *  ours (`stillOwns`). The ownership re-check matters: a run that overran the staleness window has had
   *  its lock legitimately reclaimed by a successor, and unlinking blindly would delete the SUCCESSOR's
   *  lock and re-open the race this module exists to close. */
  release: () => Promise<void>;
};

export type LockBusy = { acquired: false; holder: LockInfo };

/** The staleness inputs a holder over `cfg` passes `acquireRunLock` — the ONE derivation (PR 2 final harden round 1,
 *  B6), shared by the briefing (src/main.ts `run()`) and the `provider` verbs that take the lock (src/providerCli.ts),
 *  so a `provider reset` or `test` holder never reads a live briefing's lock as stale sooner than another briefing
 *  would: `provider.timeoutMs` or its transport's default (`defaultTimeoutMs`: 120 s CLI, 300 s API), recap campaigns
 *  on iff their mode resolves `trial`/`on`, calendar on iff its block resolves enabled — each through the resolver
 *  `runCore` reads (a malformed key resolves off and never widens the lock). */
export function runLockInputs(cfg: Config): { timeoutMs: number; recapCampaigns: boolean; calendar: boolean } {
  return {
    timeoutMs: cfg.provider.timeoutMs ?? defaultTimeoutMs(cfg.provider),
    recapCampaigns: resolveRecapCampaigns(cfg.recapCampaigns).mode !== "off",
    calendar: resolveCalendar(cfg.calendar).enabled,
  };
}

/**
 * Try to take `<stateDir>/run.lock` with O_EXCL (`open(path, "wx")` — the one create-or-fail
 * primitive node/Bun expose, atomic on POSIX and Windows).
 *
 * Returns `{acquired:false, holder}` ONLY for a fresh, parseable lock whose pid is alive. Everything
 * else returns `{acquired:true, release}` — see the fail-open note at the top of this file.
 */
export async function acquireRunLock(opts: {
  invoker: string;
  /** `provider.timeoutMs` (or its transport's default, `runLockInputs`). A lock older than `lockStaleMs(timeoutMs)` — the
   *  holder's derived worst case, NOT one timeout — is abandoned. See that function. */
  timeoutMs: number;
  /** Tier B is enabled for this run (mode `trial`/`on`): forwarded to `lockStaleMs`, which then widens
   *  the staleness bound by B's phase bound (spec §4.9). Absent/false ⇒ the bound is unchanged. */
  recapCampaigns?: boolean;
  /** Calendar is on for this run: forwarded to `lockStaleMs`, which then widens the bound by the calendar step's
   *  worst case (spec r4 §3). Absent/false ⇒ unchanged. */
  calendar?: boolean;
  /** Test seam ONLY for placing the lock elsewhere; production always uses `runLockPath()`. There is
   *  deliberately no injected pid: liveness is exercised with a really-dead pid. Staleness itself is still
   *  exercised with `utimes`; the clock and interval seams below exist only for the heartbeat, whose 30 s
   *  interval and minutes-long cap no test can wait out (provider fallback, plan risk 4). */
  path?: string;
  /** Provider fallback (P1-M4-T2): keep the lock fresh with a `utimes` touch every `HEARTBEAT_INTERVAL_MS`, for up
   *  to this long (`heartbeatCapMs`), while the lock is `created` or `reclaimed` and `stillOwns` says it is
   *  ours. ABSENT ⇒ no heartbeat at all, so every existing caller is unchanged until the walk passes it. */
  heartbeatCapMs?: number;
  /** Test seams for the heartbeat: the interval timers, the interval, and the clock that measures the cap. The
   *  touch itself always writes the real time — contenders compare against their own wall clock. */
  heartbeatTimers?: IntervalTimers;
  heartbeatIntervalMs?: number;
  heartbeatNow?: () => number;
}): Promise<LockHeld | LockBusy> {
  const path = opts.path ?? runLockPath();
  const now = new Date();
  const mine: LockInfo = { pid: process.pid, startedIso: now.toISOString(), invoker: opts.invoker, nonce: randomUUID() };
  const body = JSON.stringify(mine);

  /** Set at acquire time; `release` refuses to unlink a file that is no longer the one we created. */
  let ino: number | undefined;

  /** The STRICT identity test, for `release` and the heartbeat: any read failure is "not ours", the fail-safe
   *  direction for an unlink or a touch (never delete or keep fresh a lock we cannot identify). */
  const owns = async (): Promise<boolean> => {
    try { return await ownsOnce(); } catch { return false; }
  };
  /** The identity test the WALK and the shell ask (`stillOwns`). ENOENT or a mismatched identity is LOST. Any OTHER
   *  I/O exception (a stat blip) is retried once and then read as STILL OWNED (P1-M8 checkpoint LOW 3): a transient fs
   *  error must never quiet-stop a run that still holds its lock — the staleness bound, not this read, is what evicts
   *  a stuck holder. Asymmetric with `owns` on purpose: stopping a delivery is the costly mistake here. */
  const ownsForRun = async (): Promise<boolean> => {
    for (let tryNo = 0; ; tryNo++) {
      try { return await ownsOnce(); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
        if (tryNo >= 1) return true;
      }
    }
  };
  /** One read of the identity; throws on an I/O error (the caller classifies it). */
  const ownsOnce = async (): Promise<boolean> => {
    {
      const f = Bun.file(path);
      // ⚠ NO `f.exists()` first (P1-M9 checkpoint MED 1): Bun answers false — it never throws — whatever its stat
      // failed with (ENOTDIR, EIO …), which turned a blip into "lost" before `ownsForRun` could classify it. `stat`
      // itself is the existence test: ENOENT throws, and the caller reads that as lost.
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
      const st = await stat(path);           // ENOENT ⇒ throws ⇒ lost; any other code ⇒ the caller's retry rule
      // The inode check is a FAST PATH and defence in depth only — identity rests on the nonce below. ⚠ It is UNPINNED:
      // no test fails without it (the nonce decides every case a test can build), so it is kept for the ext4-reuse
      // reasoning above, not because anything measured needs it.
      if (ino !== undefined && st.ino !== ino) return false;
      // An UNPARSEABLE file on our inode is still read as ours, as `release` always did: nothing proves a
      // stranger wrote it, and refusing would leave a corrupted lock of our own behind for the next run.
      const cur = parseLock(await f.text());
      if (cur && (cur.pid !== mine.pid || cur.startedIso !== mine.startedIso || cur.nonce !== mine.nonce)) return false;
      return true;
    }
  };

  /** The heartbeat's interval, when one runs. Cleared by `release`, at the cap, and never left running. */
  let beat: ReturnType<typeof setInterval> | undefined;
  const timers = opts.heartbeatTimers ?? realTimers;
  const stopBeat = (): void => { if (beat !== undefined) { timers.clearInterval(beat); beat = undefined; } };

  const release = async (): Promise<void> => {
    stopBeat();
    try {
      if (!(await owns())) return;
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
  const createKind = async (): Promise<"ok" | "exists" | "no-dir" | "error"> => {
    const first = await createOnce();
    if (first !== "no-dir") return first;
    try { await mkdir(dirname(path), { recursive: true }); } catch { return "error"; }
    return createOnce();
  };
  const create = async (): Promise<boolean> => (await createKind()) === "ok";

  /** Start the heartbeat for a lock we exclusively hold. Each touch changes ONLY the mtime (atime kept, the file
   *  never rewritten), so a contender reading during a touch sees the same bytes and the same inode; it touches
   *  only after `stillOwns`, so a successor's lock is never refreshed; and it stops for good at the cap. */
  const startBeat = (capMs: number): void => {
    // ⚠ A WALL-CLOCK cap: time asleep counts toward it, so a laptop that slept mid-walk stops beating sooner — the
    // accepted fail-open direction (the lock goes stale and becomes reclaimable, never the other way).
    const clock = opts.heartbeatNow ?? Date.now;
    const startedAt = clock();
    let busy = false;
    beat = timers.setInterval(async () => {
      if (busy || beat === undefined) return;
      if (clock() - startedAt >= capMs) { stopBeat(); return; }
      busy = true;
      try {
        if (beat === undefined) return;
        if (!(await owns())) {
          // L9: a lock that is DEFINITELY no longer ours (gone, or another acquisition's) stops the heartbeat for good,
          // rather than polling it until the cap; a read that merely failed skips this one beat (the strict reading
          // never touches a lock it cannot identify) and the next beat looks again.
          if (!(await ownsForRun())) stopBeat();
          return;
        }
        if (beat === undefined) return;               // released while the check was pending: touch nothing
        // ⚠ BY PATH: between `owns` and `utimes` a successor could swap the file, and this would refresh ITS mtime.
        // Harmless today — a successor's lock being kept fresh only delays a reclaim of a live holder's lock, and
        // the next beat's `owns` stops the touches. If it ever matters: open the file, `fstat` it against the
        // identity, and `futimes` that descriptor.
        const st = await stat(path);
        await utimes(path, st.atime, new Date());
      } catch { /* a missed beat only brings staleness closer, the fail-open direction */ }
      finally { busy = false; }
    }, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
    (beat as { unref?: () => unknown }).unref?.();
  };

  const held = (owned: LockHeld["owned"]): LockHeld => {
    if (owned !== "fail-open" && opts.heartbeatCapMs !== undefined) startBeat(opts.heartbeatCapMs);
    return { acquired: true, owned, stillOwns: ownsForRun, release };
  };

  if (await create()) { await remember(); return held("created"); }

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
  const fresh = ageMs <= lockStaleMs(opts.timeoutMs, { recapCampaigns: opts.recapCampaigns, calendar: opts.calendar });
  if (holder && fresh && holderAlive(holder.pid)) return { acquired: false, holder };

  // Stale / unparseable / dead holder / unreadable ⇒ RECLAIM. Best-effort, in the fail-open
  // direction throughout: if the unlink races another reclaimer we simply overwrite, and if even the
  // overwrite fails we still proceed — a lock we could not write is a lock that cannot stop tomorrow.
  try { await unlink(path); } catch { /* raced or unremovable */ }
  const second = await createKind();
  if (second === "ok") { await remember(); return held("reclaimed"); }
  // A LOST RECLAIM RACE is not a filesystem fault (P1-M4 checkpoint note, P1-M8-T2): another contender unlinked the
  // same stale lock and created its own between our unlink and our create, so the create failed with EEXIST. Busy
  // ONLY when the lock now on disk is FRESH by mtime and its holder alive — exactly what a contender arriving one
  // instant later would see.
  // ⚠ Re-reading the SAME stale lock (an unlink that failed — a read-only folder, an immutable file — then EEXIST)
  // must fall through to fail-open as before: answering busy there wedges every later tick on one stale file
  // (P1-M8 checkpoint HIGH 1, measured by the Opus probe: busy ×3 at b6541291a, fail-open ×3 at 531549a94). The
  // freshness test alone decides it: the stale lock we tried to reclaim is, by definition, not fresh. A "different
  // acquisition" test was dropped (P1-M9 checkpoint LOW 3): the only way the SAME lock reads fresh here is its own
  // holder touching it — a holder resumed after being stopped longer than the stale bound — and that is a live holder,
  // for which busy is the right answer.
  if (second === "exists") {
    try {
      const st = await stat(path);
      const winner = parseLock(await Bun.file(path).text());
      const freshNow = Date.now() - st.mtimeMs <= lockStaleMs(opts.timeoutMs, { recapCampaigns: opts.recapCampaigns, calendar: opts.calendar });
      if (winner && freshNow && holderAlive(winner.pid)) return { acquired: false, holder: winner };
    } catch { /* unreadable ⇒ fail open below */ }
  }
  // FAIL-OPEN: overwrite in place, best effort. `remember()` is deliberately NOT called (P1-M4-T1): an inode
  // learned here would be the one a stranger could not unlink either, and nothing about this file proves it is
  // exclusively ours — contents alone decide `stillOwns` for it, and it gets no heartbeat.
  try { await Bun.write(path, body); } catch { /* proceed unlocked rather than lose a morning */ }
  return held("fail-open");
}
