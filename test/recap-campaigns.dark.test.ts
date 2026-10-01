import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.4 — L2, the in-branch half of the dark-ship proof (plan §6 L2).
// Mode `off` — the key ABSENT, and `{"mode":"off"}` — must make B do NOTHING at all (spec §4.1 step 1): no
// gate, no git read, no call, no record, no stderr line, and the page and struct exactly what they are
// without the key. L4 (a verifier probe, not committed) ties the same `off` page to BASE through runCore.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore, type RunDeps } from "../src/core";
import { renderBriefing } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import { recapCampaignsPath } from "../src/marker";
import { lockStaleMs } from "../src/runlock";
import { TIMEOUT_MS } from "../src/provider";
import { RECAP_STDERR_PREFIX } from "../src/recapCampaigns";
import type { BriefingStruct } from "../src/types";
import { unstamp } from "./helpers/unstamp";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { busyRepo, busyReply, busyCfg, type BusyRepo } from "./fixtures/recap-busy";

const LONG = 60_000;
let busy: BusyRepo;
beforeAll(async () => { busy = await busyRepo(40); }, LONG);   // busy by BOTH arms: 40 commits, 16 top-level lines

/** Throwing spies: any call is a failure of the `off` gate, counted even if the throw is swallowed. */
function spies() {
  const calls = { grouper: 0, persist: 0 };
  return {
    calls,
    deps: {
      grouper: async () => { calls.grouper++; throw new Error("L2: B's grouper must never be called in mode off"); },
      persistRecapRecord: async () => { calls.persist++; throw new Error("L2: B's record writer must never be called in mode off"); },
    } satisfies Partial<RunDeps>,
  };
}

async function runOff(mode: "absent" | "off" | "trial", deps: Partial<RunDeps>) {
  const lines: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const cfg = busyCfg(busy, mode === "absent" ? {} : { recapCampaigns: { mode } });
    const r = await runCore(cfg, { provider: { generate: async () => busyReply(busy, 16) }, netProbe: async () => true, persistHealth: async () => {}, ...deps }, true);
    return { r, lines };
  } finally { console.log = oLog; console.error = oErr; }
}

const deliver = (s: BriefingStruct): string => unstamp(redactCredentials(renderBriefing(s)));

test("L2: mode off (key absent, and {mode:\"off\"}) — identical pages and structs, no campaign key, 0 grouper/writer calls, no grouping-info line, lock unchanged", async () => {
  // Non-vacuity: on this fixture a `trial` run DOES reach B — one call, one record, one stderr line.
  const live = spies();
  const counted = { grouper: 0, records: 0 };
  const trial = await runOff("trial", {
    grouper: async () => { counted.grouper++; return JSON.stringify({ campaigns: [] }); },
    persistRecapRecord: async () => { counted.records++; },
  });
  expect(counted).toEqual({ grouper: 1, records: 1 });
  expect(trial.lines.filter((l) => l.startsWith(RECAP_STDERR_PREFIX))).toHaveLength(1);

  const absent = await runOff("absent", live.deps);
  const off = await runOff("off", live.deps);
  expect(live.calls).toEqual({ grouper: 0, persist: 0 });
  expect(deliver(off.r.struct)).toBe(deliver(absent.r.struct));
  expect({ ...off.r.struct, stateAsOf: "HH:MM" }).toEqual({ ...absent.r.struct, stateAsOf: "HH:MM" });
  for (const x of [absent, off]) {
    expect(JSON.stringify(x.r.struct)).not.toContain('"campaign"');
    expect(x.lines.some((l) => l.includes("grouping-info"))).toBe(false);
  }
  // the lock: `off` never widens the staleness bound (spec §4.9)
  for (const t of [TIMEOUT_MS, 1, 200_000]) expect(lockStaleMs(t)).toBe(lockStaleMs(t, { recapCampaigns: false }));
}, LONG);

test("L2: an off run with NO injected writer, in its OWN state dir, leaves no recap-campaigns record behind", async () => {
  // Its own state dir: the preload's is shared per process, so an earlier file that ran B with no
  // writer could otherwise make this order-dependent. No grouper and no writer are injected — a broken
  // `off` gate would record `skipped`/`no-grouper` through the real writer, into this dir.
  const prev = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb44-dark-state-")));
  try {
    expect(existsSync(recapCampaignsPath())).toBe(false);
    for (const mode of ["absent", "off"] as const) {
      const x = await runOff(mode, {});
      expect(x.r.emptyWindow).toBe(false);
      expect(existsSync(recapCampaignsPath())).toBe(false);
    }
  } finally {
    process.env.DAILY_BRIEFING_STATE_DIR = prev;
  }
}, LONG);
