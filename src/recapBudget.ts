// src/recapBudget.ts — Tier B (Stage-2 recap campaigns): the time budgets, in a LEAF module.
//
// ⚠ A LEAF ON PURPOSE (Appendix D17), and the reason is a crash, not taste. `runlock.ts` imports `./core`
// and reads `PROVIDER_RETRY_DELAYS_MS` at load time; B's phase is reached FROM `core`, so if these lived
// in `runlock.ts` the phase's import of them would close core → phase → runlock → core, and the app would
// throw `ReferenceError: Cannot access 'PROVIDER_RETRY_DELAYS_MS' before initialization` at startup — every
// run, mode `off` included. This file imports ONLY `./provider` (whose own value closure is account,
// marker, stream and types — none of core, runlock or main), so both `runlock.ts` and the phase can use it.
//
// Spec §4.4 (`D_call`, `D_B`) and §4.9 (the lock term). ONE definition of each, because the lock bound and
// the phase's race both feed on `D_call`: two copies of a decision-feeding timeout computation would be
// free to drift, and a lock narrower than the phase it guards is a double delivery.
import { TIMEOUT_MS, KILL_GRACE_MS, flushWindowMs } from "./provider";

/** B's git-read budget (spec §4.3): ONE budget shared by all of B's git calls across every repo, running
 *  from the first of them; the call comes after it. */
export const RECAP_GIT_BUDGET_MS = 20_000;

/** A configured `provider.timeoutMs` as every bound derives from it: a non-finite or non-positive value
 *  falls back to the default rather than collapsing the window — `provider.timeoutMs` is user-supplied,
 *  and a bound of zero is a gate that never holds. Extracted from `lockStaleMs` (runlock.ts) so the lock
 *  and B's deadline sanitise the SAME way (spec §4.4: "sanitised as `lockStaleMs` sanitises it"). */
export function sanitizeTimeoutMs(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_MS;
}

/** `D_call` (spec §4.4) = `2 × (t + KILL_GRACE_MS + flushWindowMs(false, {}))` — 270 s at the default
 *  120 s. One `hardenedProvider.generate` spawns at most twice, and each spawn settles within
 *  `t + KILL_GRACE_MS + FLUSH` whichever way it ends, so the production grouper always settles inside
 *  this deadline; the race can only fire on an injected grouper that never settles. */
export function recapCallDeadlineMs(timeoutMs: number): number {
  return 2 * (sanitizeTimeoutMs(timeoutMs) + KILL_GRACE_MS + flushWindowMs(false, {}));
}

/** `D_B` (spec §4.4, §4.9) = `RECAP_GIT_BUDGET_MS + D_call` — 290 s at the default: the git budget, then
 *  the call, sequentially. B's phase cannot outlive it, so it is exactly the term the run lock's
 *  staleness bound gains when the mode is not `off`. */
export function recapPhaseBoundMs(timeoutMs: number): number {
  return RECAP_GIT_BUDGET_MS + recapCallDeadlineMs(timeoutMs);
}
