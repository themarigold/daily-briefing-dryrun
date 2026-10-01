import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.4 — the plan-added SMOKE over the phase itself, driven directly
// (no runCore): a hand-built struct whose 16 ungrouped bullets each resolve to one ctx commit, ctx
// commits owned by a real (merge-free) git repo so `readPrFacts` really lists, a canned grouper, and an
// in-memory record writer. It pins the record's per-outcome SHAPE: one line per run; `labels[]` wherever
// items were built; `prFacts` (with `reposUnread`) wherever `readPrFacts` returned.
import { test, expect, beforeAll } from "bun:test";
import { runRecapCampaignsPhase, type RecapPhaseParams } from "../src/recapCampaignsPhase";
import { RECAP_STDERR_PREFIX, type RecapRecordV2 } from "../src/recapCampaigns";
import type { Activity, BriefingStruct } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
import { yesterdayNoon, CAMPAIGN_REPLY, CAMPAIGN_TITLE } from "./fixtures/recap-busy";

const LABEL = "phase-lab";
const N = 16;
/** Distinct, letter-bearing 40-hex ids (a 7-prefix per commit, never all-digit). */
const sha = (i: number): string => `abc${i.toString(16).padStart(4, "0")}`.padEnd(40, "0");

let repo: string;
beforeAll(async () => { repo = await buildRepo([{ file: "p.txt", content: "p", isoDate: yesterdayNoon().toISOString() }]); });

const commits = (owner: string): Activity[] => Array.from({ length: N }, (_, i) => ({
  source: "git", kind: "commit", event_id: sha(i), repo: owner, text: `adjust q${i} widget`, timestamp: yesterdayNoon().toISOString(),
}));

const struct = (): BriefingStruct => ({
  date: "2026-09-27", machineScope: "test", provider: "echo", resume: [], suggestions: [], warnings: [],
  recap: Array.from({ length: N }, (_, i) => ({
    repo: LABEL, text: i < 2 ? `${CAMPAIGN_TITLE} step ${i + 1}` : `polish piece number ${i}`, evidence: sha(i).slice(0, 7),
  })),
} as BriefingStruct);

type Phase = { records: RecapRecordV2[]; raw: string[]; stderr: string[]; result: Awaited<ReturnType<typeof runRecapCampaignsPhase>> };

async function phase(over: Partial<RecapPhaseParams> & { owner?: string }): Promise<Phase> {
  const raw: string[] = [];
  const stderr: string[] = [];
  const oErr = console.error;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(" ")); };
  try {
    const { owner, ...rest } = over;
    const result = await runRecapCampaignsPhase({
      mode: "trial", struct: struct(), gateCommits: N, ctxCommits: commits(owner ?? repo),
      unitLabels: [LABEL], repoLabels: [LABEL], windowStart: new Date(Date.now() - 3 * 86_400_000),
      clockNow: () => new Date(), runDate: "2026-09-28", force: false,
      grouper: async () => CAMPAIGN_REPLY, warningsOf: () => [], hardeningOf: () => "n/a",
      timeoutMs: 120_000, persist: async (line) => { raw.push(line); },
      ...rest,
    });
    return { records: raw.map((l) => JSON.parse(l)), raw, stderr, result };
  } finally { console.error = oErr; }
}

/** One run per outcome shape the smoke covers. */
let runs: Record<"applied" | "trial" | "none" | "skippedNoGrouper" | "skippedGate" | "exception", Phase>;
beforeAll(async () => {
  runs = {
    applied: await phase({ mode: "on" }),
    trial: await phase({ mode: "trial" }),
    none: await phase({ grouper: async () => JSON.stringify({ campaigns: [] }) }),
    skippedNoGrouper: await phase({ grouper: undefined }),
    skippedGate: await phase({ gateCommits: 10, struct: { ...struct(), recap: struct().recap.slice(0, 14) } }),
    // items are built, then `readPrFacts` THROWS (its owning repo does not exist, so git cannot spawn):
    // the F19 shape — an `exception` line with `labels[]` and no `prFacts`.
    exception: await phase({ owner: "/nonexistent/tb44-phase-repo" }),
  };
});

test("applied/trial/none/skipped each write exactly one record line", () => {
  const shape = (p: Phase) => ({
    lines: p.raw.length, outcome: p.records[0]?.outcome, reason: p.records[0]?.reason ?? null,
    stderr: p.stderr.filter((l) => l.startsWith(RECAP_STDERR_PREFIX)).length,
  });
  expect(shape(runs.applied)).toEqual({ lines: 1, outcome: "applied", reason: null, stderr: 1 });
  expect(shape(runs.trial)).toEqual({ lines: 1, outcome: "trial", reason: null, stderr: 1 });
  expect(shape(runs.none)).toEqual({ lines: 1, outcome: "none", reason: null, stderr: 1 });
  expect(shape(runs.skippedNoGrouper)).toEqual({ lines: 1, outcome: "skipped", reason: "no-grouper", stderr: 1 });
  expect(shape(runs.skippedGate)).toEqual({ lines: 1, outcome: "skipped", reason: "gate", stderr: 1 });
  expect(shape(runs.exception)).toEqual({ lines: 1, outcome: "rejected", reason: "exception", stderr: 1 });
  // only `applied` hands a recap back to the caller (step 12 is core's), and `campaigns[]` only on applied/trial
  expect(runs.applied.result.recap?.slice(0, 2).map((e) => e.campaign)).toEqual([`${CAMPAIGN_TITLE} — 2 commits`, `${CAMPAIGN_TITLE} — 2 commits`]);
  for (const k of ["trial", "none", "skippedNoGrouper", "skippedGate", "exception"] as const) expect({ k, r: runs[k].result }).toEqual({ k, r: {} });
  expect(runs.applied.records[0]!.campaigns).toHaveLength(1);
  expect(runs.trial.records[0]!.campaigns).toHaveLength(1);
  for (const k of ["none", "skippedNoGrouper", "skippedGate", "exception"] as const) expect({ k, has: "campaigns" in runs[k].records[0]! }).toEqual({ k, has: false });
});

test("every record line where items were built carries labels[], and every line where readPrFacts returned carries prFacts.reposUnread", () => {
  const LABELS = [{ label: LABEL, offered: N }];
  for (const k of ["applied", "trial", "none"] as const) {
    const r = runs[k].records[0]!;
    expect({ k, labels: r.labels }).toEqual({ k, labels: LABELS });
    expect({ k, reposUnread: r.prFacts?.reposUnread }).toEqual({ k, reposUnread: 0 });
    expect({ k, prFactKeys: Object.keys(r.prFacts ?? {}) }).toEqual({ k, prFactKeys: ["merges", "read", "timedOut", "marked", "reposUnread"] });
  }
  // a skipped line: no items were built and no git was read — neither field
  for (const k of ["skippedNoGrouper", "skippedGate"] as const) {
    const r = runs[k].records[0]!;
    expect({ k, labels: "labels" in r, prFacts: "prFacts" in r }).toEqual({ k, labels: false, prFacts: false });
  }
  // items built, then `readPrFacts` threw: `labels[]` only
  const ex = runs.exception.records[0]!;
  expect({ labels: ex.labels, prFacts: "prFacts" in ex }).toEqual({ labels: LABELS, prFacts: false });
});
