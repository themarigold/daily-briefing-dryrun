import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.6 — P10 (spec §5.4 "Deadline", plan §4 T4.6 / K4 / K18 / K30):
// a PRODUCTION-SHAPED grouper double — its first spawn fails at t, the retry succeeds at 2t — is NOT
// abandoned. Driven against `runRecapCampaignsPhase` directly, under fake timers, with t = 200 000 ms, so
// the production `D_call` = 2 × (200 + 5 + 10) s = 430 s leaves 30 s over the double's 400 s; a 1× `D_call`
// (215 s) or one built from `TIMEOUT_MS` (270 s) abandons it.
//
// What keeps this honest under fake timers:
//   - git budget 0: T3.1's listing rule refuses every listing — no repo is read, nothing is spawned,
//     nothing throws; `persist` is IN MEMORY (an fs append never completes on microtasks alone);
//   - a BOUNDED advance loop, 10 000 ms × at most 1 000 steps (the plan's ≥ 1 000 ms per step), each step
//     followed by microtask flushes only; the test asserts the loop ended BECAUSE the phase settled (the
//     `settled` flag, the step budget not exhausted, the real-time bound not hit). The double still resolves
//     by ~410 s, inside the production 430 s D_call and after a 215 s (1×) or 270 s (TIMEOUT_MS) one;
//   - a REAL-time bound, 10 s of /proc/uptime (bun fakes every JS clock). It replaces the plan's `sleep 5`
//     watchdog child: on the GitHub runner that child's exit was never observed under fake timers, and the
//     real macrotask turn it needed per step cost up to ~2.5 s there (CI runs 36495107663 … 36500948806),
//     so P10 timed out on CI while passing locally. Off Linux the bound is inert and the runner timeout below
//     (deferred by bun while fakes are installed) plus the finite step budget bound the loop;
//   - real timers restored in `finally`;
//   - the grouper WAS called, `reposUnread` equals the repos that own an offered item, `timedOut` is 0 and
//     the outcome is the grouper's own — so a phase that throws at budget 0, or never reaches the call,
//     cannot pass for the wrong reason.
import { test, expect, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { runRecapCampaignsPhase } from "../src/recapCampaignsPhase";
import { ProviderError, type Activity, type BriefingStruct } from "../src/types";
import type { RecapRecordV2 } from "../src/recapCampaigns";
import { CAMPAIGN_REPLY, CAMPAIGN_TITLE } from "./fixtures/recap-busy";

const T = 200_000;

/** A REAL clock under fake timers: bun fakes Date, performance.now, process.hrtime and Bun.nanoseconds (measured),
 *  but not the kernel's /proc/uptime (Linux, i.e. CI). Elsewhere it is undefined and the bound is inert. */
const realSec = (): number | undefined => {
  try { return Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]); } catch { return undefined; }
};
const LABEL = "deadline-lab";
const N = 16;
const REPOS = ["/tb46/deadline/repo-a", "/tb46/deadline/repo-b"];   // never spawned against: budget 0
const sha = (i: number): string => `dea${i.toString(16).padStart(4, "0")}`.padEnd(40, "1");

const struct = (): BriefingStruct => ({
  date: "2026-09-27", machineScope: "test", provider: "echo", resume: [], suggestions: [], warnings: [],
  recap: Array.from({ length: N }, (_, i) => ({
    repo: LABEL, text: i < 2 ? `${CAMPAIGN_TITLE} step ${i + 1}` : `polish piece number ${i}`, evidence: sha(i).slice(0, 7),
  })),
} as BriefingStruct);
const commits = (): Activity[] => Array.from({ length: N }, (_, i) => ({
  source: "git", kind: "commit", event_id: sha(i), repo: REPOS[i % 2]!, text: `adjust q${i} widget`,
  timestamp: new Date(Date.now() - 86_400_000).toISOString(),
}));

test("[TB-P10] a production-shaped double (fails at t, succeeds at 2t; t = 200 000) is NOT abandoned — the grouper was called and the outcome is its own", async () => {
  const records: RecapRecordV2[] = [];
  let grouperCalls = 0;
  /** hardenedProvider.generate's worst production shape: the first spawn fails at t (a timeout), the one
   *  retry succeeds at t later — every wait a FAKE `setTimeout`, nothing spawned. */
  const grouper = async (): Promise<string> => {
    grouperCalls++;
    await new Promise<void>((resolve) => setTimeout(resolve, T))
      .then(() => { throw new ProviderError("timeout", "tb46: first spawn timed out at t"); })
      .catch(() => {});
    return new Promise<string>((resolve) => setTimeout(() => resolve(CAMPAIGN_REPLY), T));
  };

  const oErr = console.error;
  console.error = () => {};
  vi.useFakeTimers();
  try {
    let settled = false;
    const phase = runRecapCampaignsPhase({
      mode: "trial", struct: struct(), gateCommits: N, ctxCommits: commits(),
      unitLabels: [LABEL], repoLabels: [LABEL], windowStart: new Date(Date.now() - 3 * 86_400_000),
      clockNow: () => new Date(), runDate: "2026-09-28", force: false,
      grouper, warningsOf: () => [], hardeningOf: () => "on",
      timeoutMs: T,                                              // D_call from THIS, not TIMEOUT_MS
      persist: async (line) => { records.push(JSON.parse(line)); },
      seams: { gitBudgetMs: 0 },                                 // no callDeadlineMs: the PRODUCTION D_call
    }).then((r) => { settled = true; return r; });

    const STEP_MS = 10_000, MAX_STEPS = 1_000, REAL_LIMIT_S = 10;
    const t0 = realSec();
    const elapsed = (): number => { const t = realSec(); return t === undefined || t0 === undefined ? 0 : t - t0; };
    let steps = 0;
    let realStop = false;
    while (!settled && steps < MAX_STEPS) {
      vi.advanceTimersByTime(STEP_MS);
      steps++;
      for (let i = 0; i < 25; i++) await Promise.resolve();
      if (elapsed() > REAL_LIMIT_S) { realStop = true; break; }
    }
    expect({ settled, exhausted: steps >= MAX_STEPS, realStop },
      `loop ended at step ${steps} after ${elapsed().toFixed(2)} s real: grouper calls ${grouperCalls}, records ${records.length}`)
      .toEqual({ settled: true, exhausted: false, realStop: false });
    expect(steps).toBeGreaterThanOrEqual(2 * T / STEP_MS);        // it really waited out both attempts
    const result = await phase;
    expect(result).toEqual({});                                   // trial: nothing handed back
    expect(grouperCalls).toBe(1);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect([rec.outcome, rec.reason]).toEqual(["trial", null]);  // the grouper's own — not exception, not deadline
    expect(rec.prFacts).toEqual({ merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: REPOS.length });
  } finally {
    vi.useRealTimers();
    console.error = oErr;
  }
  // An explicit runner timeout above the 10 s real-time bound, so bun's (deferred) runner timeout cannot
  // pre-empt the named assertion above.
}, 30_000);
