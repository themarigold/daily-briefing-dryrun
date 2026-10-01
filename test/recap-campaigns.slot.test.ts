import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.4 — the SLOT-SENSITIVE pins (spec §5.4; plan §7): P1, P5, P6, P11a,
// P12, plus the plan-added untagged `run()` pin for `main.ts`'s `recapInvocation` deps edit. Every case
// drives the real `runCore` (and, for the last, the real `run()`) over a real git repo; the main call and
// B's grouper are canned — no provider is ever spawned or reached.
//
// Pages are compared AS DELIVERED — `redactCredentials(renderBriefing(r.struct))`, the `main.ts` path —
// through `unstamp` (the real-clock `state as of HH:MM`); structs with `stateAsOf` overwritten (plan §1, K7).
import { test, expect, describe, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore, type RunDeps } from "../src/core";
import { run } from "../src/main";
import { renderBriefing } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import { PROMPT_HEADER } from "../src/generator";
import { recapCampaignsPath } from "../src/marker";
import { emptyEvidence } from "../src/transcripts/scan";
import { repoLabel } from "../src/config";
import { norm } from "../src/subprojects";
import {
  liveCheck, labelUniverse, campaignHeaderLine, topLevelRecapCount, RECAP_STDERR_PREFIX, type RecapRecordV2,
} from "../src/recapCampaigns";
import type { BriefingStruct, Config, Provider } from "../src/types";
import { unstamp } from "./helpers/unstamp";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { buildRepo } from "./fixtures/build-repo";
import { busyRepo, busyReply, busyCfg, yesterdayNoon, CAMPAIGN_REPLY, type BusyRepo } from "./fixtures/recap-busy";

const LONG = 60_000;
/** The malformed-config warning, as `resolveRecapCampaigns` spells it (config.ts). */
const MALFORMED = 'config: "recapCampaigns" must be { mode: "off" | "trial" | "on" } — recap campaigns off';
/** The bridging paragraph's first words (§4.5 item 2): what tells B's prompt from the main one. */
const B_PROMPT_MARK = "This is the recap-grouping step";

let busy: BusyRepo;
beforeAll(async () => { busy = await busyRepo(40); }, LONG);

const deliver = (s: BriefingStruct): string => unstamp(redactCredentials(renderBriefing(s)));
const stamped = (s: BriefingStruct): BriefingStruct => ({ ...s, stateAsOf: "HH:MM" });

/** ONE array, in call order, for console.log and console.error (spec §5 convention). */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { value: await fn(), lines }; } finally { console.log = oLog; console.error = oErr; }
}

type Run = { r: Awaited<ReturnType<typeof runCore>>; records: RecapRecordV2[]; grouperCalls: number; grouperPrompts: string[]; mainPrompts: string[]; lines: string[] };

/** One runCore over the busy repo: `lines` recap bullets, the mode (undefined = key absent), a grouper
 *  answering `groupReply` (or none), an in-memory record writer. `provider` lets P5 inject its double. */
async function runBusy(opts: {
  mode?: unknown; lines?: number; groupReply?: string | null; cfg?: Record<string, unknown>;
  provider?: Provider & { runtimeWarnings?: string[] }; onGroup?: () => void; deps?: Partial<RunDeps>;
}): Promise<Run> {
  const records: RecapRecordV2[] = [];
  const grouperPrompts: string[] = [];
  const mainPrompts: string[] = [];
  const reply = busyReply(busy, opts.lines ?? 16);
  const provider = opts.provider ?? { generate: async (p: string) => { mainPrompts.push(p); return reply; } };
  const cfg = busyCfg(busy, { ...(opts.mode === undefined ? {} : { recapCampaigns: opts.mode }), ...opts.cfg });
  const deps: RunDeps = {
    provider, netProbe: async () => true, persistHealth: async () => {},
    persistRecapRecord: async (line) => { records.push(JSON.parse(line)); },
    ...(opts.groupReply === null ? {} : {
      grouper: async (p: string) => { grouperPrompts.push(p); opts.onGroup?.(); return opts.groupReply ?? CAMPAIGN_REPLY; },
    }),
    ...opts.deps,
  };
  const { value: r, lines } = await captured(() => runCore(cfg, deps, true));
  return { r, records, grouperCalls: grouperPrompts.length, grouperPrompts, mainPrompts, lines };
}

// ── P1 ────────────────────────────────────────────────────────────────────────────────────────────
test("[TB-P1] B never goes through `capturing`: after a run with a grouper, promptText/rawText are the main call's", async () => {
  const x = await runBusy({ mode: { mode: "trial" } });
  expect(x.grouperCalls).toBe(1);                                   // B DID call — so the pin is not vacuous
  expect(x.grouperPrompts[0]!.startsWith(PROMPT_HEADER)).toBe(true);
  expect(x.grouperPrompts[0]!).toContain(B_PROMPT_MARK);
  expect(x.mainPrompts).toHaveLength(1);
  expect(x.r.promptText).toBe(x.mainPrompts[0]!);                   // the MAIN prompt, not B's
  expect(x.r.promptText).not.toContain(B_PROMPT_MARK);
  expect(x.r.rawText).toBe(busyReply(busy, 16));                    // the MAIN reply, not CAMPAIGN_REPLY
}, LONG);

// ── P5 ────────────────────────────────────────────────────────────────────────────────────────────
describe("[TB-P5] B's warnings never reach the page", () => {
  const B_WARNING = "tb-p5: the grouper's transport raised this warning";
  /** A test-double provider carrying `runtimeWarnings` (read by core's `runtimeWarningsOf`), fresh per run. */
  const doubled = () => {
    const provider = { runtimeWarnings: [] as string[], generate: async () => busyReply(busy, 16) };
    return { provider, onGroup: () => { provider.runtimeWarnings.push(B_WARNING); } };
  };
  const offPage = async () => deliver((await runBusy({ mode: { mode: "off" }, ...doubled() })).r.struct);

  test("[TB-P5] (i) a garbage reply: the delivered page is byte-identical to mode off, and the record holds the warning", async () => {
    const off = await offPage();
    for (const mode of ["trial", "on"]) {
      const x = await runBusy({ mode: { mode }, groupReply: "no JSON here, just prose", ...doubled() });
      expect(x.records.map((r) => [r.outcome, r.reason])).toEqual([["rejected", "unparseable"]]);
      expect(x.records[0]!.providerWarnings).toEqual([B_WARNING]);
      expect(deliver(x.r.struct)).toBe(off);
    }
  }, LONG);

  test("[TB-P5] (ii) a valid reply in trial: the delivered page is byte-identical to mode off", async () => {
    const off = await offPage();
    const x = await runBusy({ mode: { mode: "trial" }, ...doubled() });
    expect(x.records.map((r) => r.outcome)).toEqual(["trial"]);      // every check passed — step 12 still must not run
    expect(x.records[0]!.providerWarnings).toEqual([B_WARNING]);
    expect(x.r.struct.recap.some((e) => e.campaign !== undefined)).toBe(false);
    expect(deliver(x.r.struct)).toBe(off);
  }, LONG);

  test("[TB-P5] (iii) a valid reply in on: the page differs from mode off ONLY by B's header line (no added ⚠ text); providerWarnings holds the warning", async () => {
    const off = await offPage();
    const x = await runBusy({ mode: { mode: "on" }, ...doubled() });
    expect(x.records.map((r) => r.outcome)).toEqual(["applied"]);
    expect(x.records[0]!.providerWarnings).toEqual([B_WARNING]);
    const on = deliver(x.r.struct);
    expect(on).not.toBe(off);
    expect(on).not.toContain(B_WARNING);
    const warn = (page: string) => page.split("\n").filter((l) => l.includes("⚠"));
    expect(warn(on)).toEqual(warn(off));
    // the multiset of lines, level glyph removed (check (d)'s normalisation), differs by the header alone
    const normLines = (page: string) => page.split("\n").map((l) => l.replace(/^\s*[•◦▪]\s/, "")).sort();
    const header = campaignHeaderLine(busy.label, x.r.struct.recap[0]!.campaign!).replace(/^\s*[•◦▪]\s/, "");
    expect(normLines(on)).toEqual([...normLines(off), header].sort());
  }, LONG);
});

// ── P6 ────────────────────────────────────────────────────────────────────────────────────────────
test("[TB-P6] the after-slot invariant at delivery: with the transcript-health trigger firing, checks (a)–(f) hold on the two DELIVERED pages (on vs off)", async () => {
  // The one struct writer below B's slot is the transcript-health notice (core.ts, after the postcheck
  // block). A scan double reporting `capTripped` fires the `cap-tripped` trigger through the injected
  // `persistHealth` path; `cli: "claude"` + `transcripts.enabled` make the scan run at all.
  const CAP_NOTICE = "transcript scan hit its time cap";
  const transcriptDeps: Partial<RunDeps> = {
    scan: async (o) => { const e = emptyEvidence(o.window); e.counters.capTripped = true; return { evidence: e, degraded: [] }; },
  };
  const cfg = { transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } };
  const off = await runBusy({ mode: { mode: "off" }, cfg, deps: transcriptDeps });
  const on = await runBusy({ mode: { mode: "on" }, cfg, deps: transcriptDeps });
  // preconditions: the trigger fired on BOTH runs, and B applied on the `on` run
  for (const x of [off, on]) expect((x.r.struct.warnings ?? []).some((w) => w.includes(CAP_NOTICE))).toBe(true);
  expect(on.records.map((r) => r.outcome)).toEqual(["applied"]);
  expect(off.records).toEqual([]);

  const offS = stamped(off.r.struct), onS = stamped(on.r.struct);
  // H: the campaign header lines the `on` page carries, one per (norm(repo), campaign), render order
  const seen = new Set<string>();
  const H: string[] = [];
  for (const e of onS.recap) {
    if (e.campaign === undefined) continue;
    const k = `${norm(e.repo)}\x1f${e.campaign}`;
    if (!seen.has(k)) { seen.add(k); H.push(campaignHeaderLine(e.repo, e.campaign)); }
  }
  expect(H).toHaveLength(1);
  const units = labelUniverse(on.r.units.map((u) => u.label), on.r.repos.map((r) => repoLabel(r, on.r.repos)))
    .map((l) => ({ repo: l, labels: [l] }));
  // `liveCheck` renders both structs through `redactCredentials(renderBriefing(…))` — the delivery path —
  // and evaluates (a)–(f) in order; `ok` means all six hold on the pages the user receives.
  expect(liveCheck(offS, onS, H, units)).toEqual({ ok: true });
  expect(topLevelRecapCount(onS.recap)).toBeLessThan(topLevelRecapCount(offS.recap));
}, LONG);

// ── P11a ──────────────────────────────────────────────────────────────────────────────────────────
describe("[TB-P11a] resolveRecapCampaigns at runCore: absent → off, no warning; malformed → off plus a warning ON the page", () => {
  test("[TB-P11a] key absent: off, no warning — no grouper call, no record, nothing on the page", async () => {
    const x = await runBusy({});
    expect(x.grouperCalls).toBe(0);
    expect(x.records).toEqual([]);
    expect(x.r.struct.warnings ?? []).not.toContain(MALFORMED);
    expect(deliver(x.r.struct)).not.toContain("recapCampaigns");
    expect(x.lines.some((l) => l.startsWith(RECAP_STDERR_PREFIX))).toBe(false);
  }, LONG);

  test("[TB-P11a] each malformed shape: off plus the fixed warning, which reaches the delivered page", async () => {
    for (const raw of ["on", 42, true, [], {}, { mode: "ON" }, { mode: " on" }, { mode: "on", extra: 1 }, { Mode: "on" }]) {
      const x = await runBusy({ mode: raw });
      expect({ raw, calls: x.grouperCalls, records: x.records.length }).toEqual({ raw, calls: 0, records: 0 });
      expect({ raw, warned: (x.r.struct.warnings ?? []).includes(MALFORMED) }).toEqual({ raw, warned: true });
      expect({ raw, onPage: deliver(x.r.struct).includes(MALFORMED) }).toEqual({ raw, onPage: true });
    }
  }, LONG);
});

// ── P12 ───────────────────────────────────────────────────────────────────────────────────────────
describe("[TB-P12] the gate: commits ≥ 40 or top ≥ 15", () => {
  // The repo holds 40 commits. Excluding the newest by `excludeCommitPatterns` leaves 39 in `ctx` — the
  // population the gate counts (after `excludeCommitPatterns` and the budget `reduce`, §4.1).
  const EXCLUDE_ONE = { excludeCommitPatterns: ["^adjust q39 widget$"] };
  const gateOf = (x: Run) => ({ calls: x.grouperCalls, records: x.records.map((r) => ({ gate: r.gate, outcome: r.outcome, reason: r.reason })) });
  const empty = JSON.stringify({ campaigns: [] });

  test("[TB-P12] fires at (39 commits, 15 lines) and at (40, 14)", async () => {
    const a = await runBusy({ mode: { mode: "trial" }, lines: 15, cfg: EXCLUDE_ONE, groupReply: empty });
    expect(gateOf(a)).toEqual({ calls: 1, records: [{ gate: { fired: true, commits: 39, top: 15 }, outcome: "none", reason: null }] });
    const b = await runBusy({ mode: { mode: "trial" }, lines: 14, groupReply: empty });
    expect(gateOf(b)).toEqual({ calls: 1, records: [{ gate: { fired: true, commits: 40, top: 14 }, outcome: "none", reason: null }] });
  }, LONG);

  test("[TB-P12] does not fire at (39, 14): one record, outcome skipped, reason gate — and the excluded commit is not counted", async () => {
    const x = await runBusy({ mode: { mode: "trial" }, lines: 14, cfg: EXCLUDE_ONE });
    expect(gateOf(x)).toEqual({ calls: 0, records: [{ gate: { fired: false, commits: 39, top: 14 }, outcome: "skipped", reason: "gate" }] });
    expect(x.lines.filter((l) => l.startsWith(RECAP_STDERR_PREFIX))).toHaveLength(1);
  }, LONG);

  test("[TB-P12] not in off: a busy morning (40, 16) with mode off evaluates no gate and writes nothing", async () => {
    const x = await runBusy({ mode: { mode: "off" } });
    expect(gateOf(x)).toEqual({ calls: 0, records: [] });
    expect(x.lines.some((l) => l.startsWith(RECAP_STDERR_PREFIX))).toBe(false);
  }, LONG);
});

// ── main.ts's deps edit, through run() (plan T4.4, plan-added, untagged; P13 in T4.6 keeps the tag) ──
test("run() forwards invoker and json into the record", async () => {
  // The P13 recipe: an isolated config dir carrying `recapCampaigns: {mode: "trial"}`, a registered
  // `mkdtemp` state dir, an injected provider (so `owned` is false and no grouper resolves → one
  // `skipped`/`no-grouper` line), `netProbe`, `force = true` (past the day-marker and darkwake gates) and
  // in-window commits at `yesterdayNoon()` (an empty window returns before B's slot). `run()` supplies no
  // record writer, so the line lands in the state dir's `recap-campaigns.jsonl`.
  const repo = await buildRepo([{ file: "slot.txt", content: "s", isoDate: yesterdayNoon().toISOString() }]);
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb44-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb44-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  const cfg: Config = { repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, recapCampaigns: { mode: "trial" } };
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfg));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  try {
    const provider: Provider = { generate: async () => "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y" };
    const { value: code } = await captured(() => run(true, { interactive: true, provider, netProbe: async () => true }, { json: true }));
    expect(code).toBe(0);
    expect(existsSync(recapCampaignsPath())).toBe(true);
    const lines = readFileSync(recapCampaignsPath(), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as RecapRecordV2;
    expect({ outcome: rec.outcome, reason: rec.reason, invoker: rec.invoker, json: rec.json, forced: rec.forced })
      .toEqual({ outcome: "skipped", reason: "no-grouper", invoker: "cli", json: true, forced: true });
    expect(lines[0]).toContain('"invoker":"cli"');
    expect(lines[0]).toContain('"json":true');
  } finally {
    process.env.XDG_CONFIG_HOME = prevXdg;
    process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  }
}, LONG);
