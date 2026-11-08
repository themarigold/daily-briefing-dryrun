// src/calendar/bounds.ts — the calendar step's time bounds (v0.3.0 plan M4; spec r4 §3). Constants only, importing
// nothing, so `src/runlock.ts` can budget for the step without loading the calendar pipeline.

/** The step's overall bound, measured from the moment the network gate resolved (spec §3). */
export const CALENDAR_STEP_BOUND_MS = 30_000;

/** The step's WORST CASE as its callers budget for it: the bound plus a margin for the reconcile, the prompt build
 *  and the health write that follow the reads. `runCore` races the step against this, and `lockStaleMs`
 *  (src/runlock.ts) widens the lock's staleness bound by it when calendar is on (spec §3 "Run lock"). */
export const CALENDAR_STEP_WORST_MS = CALENDAR_STEP_BOUND_MS + 5_000;
