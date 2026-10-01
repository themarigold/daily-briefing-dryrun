import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.6 — the remaining pins, spec §5.4 (plan §7): P2, P8, P9, P13, P30b.
// runCore cases drive the real engine over real git repos with the main call canned and B's grouper
// injected; P8 and P13's stderr-guard clause drive `runRecapCampaignsPhase` directly. P13's invoker/json
// clause runs through `run()` with a config written into an isolated config dir (`XDG_CONFIG_HOME`) and
// its own registered state dir per run. No provider is ever spawned or reached.
import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { runCore, type RunDeps } from "../src/core";
import { run, type RunDeps as ShellDeps } from "../src/main";
import { renderBriefing } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import { isSelfPrompt } from "../src/transcripts/discover";
import { PROMPT_HEADER } from "../src/generator";
import { recapCampaignsPath, localDateStr } from "../src/marker";
import { norm } from "../src/subprojects";
import { runRecapCampaignsPhase } from "../src/recapCampaignsPhase";
import { RECAP_STDERR_PREFIX, STDERR_LATENCY_CAP, type RecapRecordV2 } from "../src/recapCampaigns";
import type { Activity, BriefingStruct, Config, Provider } from "../src/types";
import { unstamp } from "./helpers/unstamp";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { buildRepo } from "./fixtures/build-repo";
import { busyRepo, busyReply, busyCfg, yesterdayNoon, CAMPAIGN_REPLY, CAMPAIGN_TITLE, type BusyRepo } from "./fixtures/recap-busy";

const LONG = 60_000;
const realSpawn = Bun.spawn;
type SpawnArgs = Parameters<typeof Bun.spawn>;

let busy: BusyRepo;
/** A second repo with two in-window commits: P13's "one extra repo" whose merge listing is self-killed. */
let extra: { dir: string; label: string; shas: string[] };
let offPage = "";

const deliver = (s: BriefingStruct): string => unstamp(redactCredentials(renderBriefing(s)));

type Run = { r: Awaited<ReturnType<typeof runCore>>; records: RecapRecordV2[]; lines: string[]; prompts: string[] };

/** One runCore over `busy` (plus `extra` when asked): the mode, a grouper answering `reply`, an in-memory
 *  record writer, console.log/error captured into ONE array in call order. */
async function runB(opts: {
  mode: "off" | "trial" | "on"; reply?: string | ((p: string) => Promise<string>); withExtra?: boolean;
  deps?: Partial<RunDeps>; force?: boolean;
}): Promise<Run> {
  const records: RecapRecordV2[] = [];
  const lines: string[] = [];
  const prompts: string[] = [];
  let main = busyReply(busy, 16);
  if (opts.withExtra) {
    const more = extra.shas.map((sha, i) => `- [${extra.label}] tune extra piece ${i} | evidence: ${sha.slice(0, 7)}`);
    main = main.replace("## SUGGESTIONS", [...more, "## SUGGESTIONS"].join("\n"));
  }
  const cfg = busyCfg(busy, { recapCampaigns: { mode: opts.mode }, ...(opts.withExtra ? { repos: [busy.dir, extra.dir] } : {}) });
  const reply = opts.reply ?? CAMPAIGN_REPLY;
  const deps: RunDeps = {
    provider: { generate: async () => main }, netProbe: async () => true, persistHealth: async () => {},
    powerPlatform: "linux",
    persistRecapRecord: async (line) => { records.push(JSON.parse(line)); },
    grouper: async (p) => { prompts.push(p); return typeof reply === "string" ? reply : reply(p); },
    ...opts.deps,
  };
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { r: await runCore(cfg, deps, opts.force ?? true), records, lines, prompts }; }
  finally { console.log = oLog; console.error = oErr; }
}

beforeAll(async () => {
  busy = await busyRepo(40);
  const t0 = yesterdayNoon().getTime() + 55 * 60_000;
  const dir = await buildRepo([
    { file: "e1.txt", content: "e1", isoDate: new Date(t0).toISOString() },
    { file: "e2.txt", content: "e2", isoDate: new Date(t0 + 60_000).toISOString() },
  ]);
  const log = realSpawn(["git", "log", "--reverse", "--format=%H"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const shas = (await new Response(log.stdout).text()).trim().split("\n").filter(Boolean);
  await log.exited;
  extra = { dir, label: basename(dir), shas };
  offPage = deliver((await runB({ mode: "off" })).r.struct);
}, 2 * LONG);

// ── P2 ────────────────────────────────────────────────────────────────────────────────────────────
test("[TB-P2] the prompt runCore SENT to the grouper starts with PROMPT_HEADER, and isSelfPrompt is true", async () => {
  const x = await runB({ mode: "trial" });
  expect(x.prompts).toHaveLength(1);
  expect(x.prompts[0]!.startsWith(PROMPT_HEADER)).toBe(true);
  expect(isSelfPrompt(x.prompts[0]!)).toBe(true);
}, LONG);

// ── P8 ────────────────────────────────────────────────────────────────────────────────────────────
describe("[TB-P8] a git phase that spends its whole budget still leaves the call its full D_call", () => {
  const LABEL = "p8-lab";
  const N = 16;
  const sha = (i: number): string => `bee${i.toString(16).padStart(4, "0")}`.padEnd(40, "2");
  let repo = "";
  beforeAll(async () => { repo = await buildRepo([{ file: "p8.txt", content: "p8", isoDate: yesterdayNoon().toISOString() }]); });

  test("[TB-P8] the budget is spent by a slow listing (1.6 s of a 2.5 s budget), then a 0.6 s grouper under a 1.0 s D_call is NOT abandoned", async () => {
    // The ONE owner repo's first listing call (`symbolic-ref`) is replaced by a KILL-FREE double (the
    // held-spawn shape of `recap-campaigns.failure.test.ts`): it exits 0 with an empty, CLOSED stdout after
    // 1 600 ms. Its per-call timeout (2 500 − 1 000 = 1 500 ms) never fires: nothing real is spawned, so
    // there is nothing to kill. `symbolic-ref` succeeding with "" is D15's no-origin case; then ~900 ms are left,
    // under the 1 000 ms reserve, so `for-each-ref` is REFUSED (the repo is not read) — the git phase has
    // spent everything it may. `D_call` is measured from the CALL's start, so the grouper's 600 ms fit in
    // 1 000 ms; measured from the phase's start they would not (≥ 1 600 + 600). No `sh -c 'sleep …'` here:
    // K33's one real-timeout kill lives in P29 alone, and a dash `sleep` would outlive the kill as a
    // grandchild holding the pipes.
    const closed = (): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.close(); } });
    const slowEmpty = () => ({
      stdout: closed(), stderr: closed(),
      exited: Bun.sleep(1_600).then(() => 0), exitCode: 0, signalCode: null, kill() {},
    }) as unknown as ReturnType<typeof Bun.spawn>;
    const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
      const argv = cmd as string[];
      return argv[0] === "git" && argv[1] === "symbolic-ref" ? slowEmpty() : realSpawn(argv, opts as any);
    }) as typeof Bun.spawn);
    const records: RecapRecordV2[] = [];
    let called = 0;
    const oErr = console.error;
    console.error = () => {};
    try {
      await runRecapCampaignsPhase({
        mode: "trial",
        struct: { date: "2026-09-27", machineScope: "t", provider: "echo", resume: [], suggestions: [], warnings: [],
          recap: Array.from({ length: N }, (_, i) => ({ repo: LABEL, text: i < 2 ? `${CAMPAIGN_TITLE} step ${i + 1}` : `polish piece number ${i}`, evidence: sha(i).slice(0, 7) })) } as BriefingStruct,
        gateCommits: N,
        ctxCommits: Array.from({ length: N }, (_, i): Activity => ({ source: "git", kind: "commit", event_id: sha(i), repo, text: `adjust q${i} widget`, timestamp: yesterdayNoon().toISOString() })),
        unitLabels: [LABEL], repoLabels: [LABEL], windowStart: new Date(Date.now() - 3 * 86_400_000),
        clockNow: () => new Date(), runDate: "2026-09-28", force: false,
        grouper: async () => { called++; await Bun.sleep(600); return CAMPAIGN_REPLY; },
        warningsOf: () => [], hardeningOf: () => "n/a", timeoutMs: 120_000,
        persist: async (line) => { records.push(JSON.parse(line)); },
        seams: { gitBudgetMs: 2_500, callDeadlineMs: 1_000 },
      });
    } finally { spy.mockRestore(); console.error = oErr; }
    expect(called).toBe(1);
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.prFacts).toEqual({ merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 1 });
    expect(rec.gitMs).toBeGreaterThanOrEqual(1_400);                 // the git phase really spent the budget
    expect([rec.outcome, rec.reason]).toEqual(["trial", null]);     // NOT deadline
  }, 15_000);
});

// ── P9 ────────────────────────────────────────────────────────────────────────────────────────────
test("[TB-P9] a grouper that outlives D_call is abandoned — the page is Stage 1's — and writes no late second record", async () => {
  for (const late of ["resolves", "rejects"] as const) {
    let settledLate = false;
    const x = await runB({
      mode: "on", deps: { recapCallDeadlineMs: 50 },
      reply: () => new Promise<string>((resolve, reject) => setTimeout(() => {
        settledLate = true;
        if (late === "resolves") resolve(CAMPAIGN_REPLY); else reject(new Error("tb46: late rejection"));
      }, 300)),
    });
    expect({ late, o: x.records.map((r) => [r.outcome, r.reason]) }).toEqual({ late, o: [["rejected", "deadline"]] });
    expect(deliver(x.r.struct)).toBe(offPage);
    await Bun.sleep(500);                                          // past the grouper's own settlement
    expect({ late, settledLate, records: x.records.length }).toEqual({ late, settledLate: true, records: 1 });
  }
}, LONG);

// ── P30b ──────────────────────────────────────────────────────────────────────────────────────────
test("[TB-P30b] a repo with no origin and no main/master: B still runs through runCore — the grouper's outcome, no facts, not exception", async () => {
  const trunk = await busyRepo(40);
  const mv = realSpawn(["git", "branch", "-m", "main", "trunk"], { cwd: trunk.dir, stdout: "pipe", stderr: "pipe" });
  await mv.exited;
  expect(mv.exitCode).toBe(0);
  const records: RecapRecordV2[] = [];
  let prompt = "";
  const oLog = console.log, oErr = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    await runCore(busyCfg(trunk, { recapCampaigns: { mode: "trial" } }), {
      provider: { generate: async () => busyReply(trunk, 16) }, netProbe: async () => true, persistHealth: async () => {},
      grouper: async (p) => { prompt = p; return CAMPAIGN_REPLY; },
      persistRecapRecord: async (line) => { records.push(JSON.parse(line)); },
    }, true);
  } finally { console.log = oLog; console.error = oErr; }
  expect(records.map((r) => [r.outcome, r.reason])).toEqual([["trial", null]]);
  expect(records[0]!.prFacts).toEqual({ merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 0 });
  const block = prompt.slice(prompt.indexOf("\n=== ITEMS ===\n"));   // the data block (the rules name both forms)
  expect(block).not.toContain("merged in PR");
  expect(block).not.toContain("merged across PRs");
  expect(block.split("\n").filter((l) => l.trim() === "no PR fact")).toHaveLength(16);
}, LONG);

// ── P13 ───────────────────────────────────────────────────────────────────────────────────────────
describe("[TB-P13] the record", () => {
  const LABELS = () => [{ label: norm(busy.label), offered: 16 }];

  test("[TB-P13] it goes through the injected writer, never stdout", async () => {
    const x = await runB({ mode: "trial" });
    expect(x.records).toHaveLength(1);
    const stdoutish = x.lines.filter((l) => !l.startsWith(RECAP_STDERR_PREFIX));
    for (const l of stdoutish) expect(l.includes('"v":2') || l.includes('"campaigns"') || l.includes('"labels"')).toBe(false);
    expect(x.lines.filter((l) => l.startsWith(RECAP_STDERR_PREFIX))).toHaveLength(1);
  }, LONG);

  test("[TB-P13] campaigns[] is present iff the outcome is applied or trial — absent on none, skipped, a garbage rejection AND a live-check rejection (whose keptCampaigns are filled)", async () => {
    const applied = await runB({ mode: "on" });
    const trial = await runB({ mode: "trial" });
    const none = await runB({ mode: "on", reply: JSON.stringify({ campaigns: [] }) });
    const garbage = await runB({ mode: "on", reply: "nothing parseable here" });
    // A live-check REJECTION injected through the seam: the reply is valid and a campaign is KEPT (so
    // scoreReply's keptCampaigns is filled, recapCampaigns.ts's `rejected` return), and only the check fails.
    let liveCalls = 0;
    const live = await runB({ mode: "on", deps: { recapImpl: { liveCheck: () => { liveCalls++; return { ok: false, letter: "d", reason: "live-check-d" }; } } } });
    const skipped = await runB({ mode: "trial", deps: { grouper: undefined } });
    const shape = (x: Run) => ({ o: x.records.map((r) => [r.outcome, r.reason]), campaigns: x.records.map((r) => "campaigns" in r) });
    expect(shape(applied)).toEqual({ o: [["applied", null]], campaigns: [true] });
    expect(shape(trial)).toEqual({ o: [["trial", null]], campaigns: [true] });
    expect(shape(none)).toEqual({ o: [["none", null]], campaigns: [false] });
    expect(shape(garbage)).toEqual({ o: [["rejected", "unparseable"]], campaigns: [false] });
    expect(liveCalls).toBe(1);
    expect(live.records[0]!.kept).toBe(1);
    expect(shape(live)).toEqual({ o: [["rejected", "live-check-d"]], campaigns: [false] });
    expect(shape(skipped)).toEqual({ o: [["skipped", "no-grouper"]], campaigns: [false] });
    expect(applied.records[0]!.campaigns!.map((c) => [c.label, c.title, c.commits])).toEqual([[norm(busy.label), CAMPAIGN_TITLE, 2]]);
    expect(deliver(live.r.struct)).toBe(offPage);
  }, 2 * LONG);

  test("[TB-P13] forced is runCore's force", async () => {
    const forced = await runB({ mode: "trial", force: true });
    const unforced = await runB({ mode: "trial", force: false });
    expect([forced.records[0]!.forced, unforced.records[0]!.forced]).toEqual([true, false]);
  }, LONG);

  test("[TB-P13] labels[] {label, offered} on every line where items were built, label = the labelKey", async () => {
    const runs = {
      applied: await runB({ mode: "on" }),
      trial: await runB({ mode: "trial" }),
      none: await runB({ mode: "trial", reply: JSON.stringify({ campaigns: [] }) }),
      rejected: await runB({ mode: "trial", reply: "garbage" }),
      deadline: await runB({ mode: "trial", reply: () => new Promise<string>(() => {}), deps: { recapCallDeadlineMs: 30 } }),
    };
    for (const [k, x] of Object.entries(runs)) expect({ k, labels: x.records[0]!.labels }).toEqual({ k, labels: LABELS() });
    const two = await runB({ mode: "trial", withExtra: true, reply: JSON.stringify({ campaigns: [] }) });
    expect(two.records[0]!.labels).toEqual([...LABELS(), { label: norm(extra.label), offered: 2 }]);
  }, 2 * LONG);

  test("[TB-P13] prFacts.reposUnread is present wherever readPrFacts returned and equals the unread-repo count: 0 normally, 1 when one extra repo's listing is killed", async () => {
    const normal = await runB({ mode: "trial", withExtra: true, reply: JSON.stringify({ campaigns: [] }) });
    expect(normal.records[0]!.prFacts).toEqual({ merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 0 });
    const rejected = await runB({ mode: "trial", reply: "garbage" });
    expect(rejected.records[0]!.prFacts?.reposUnread).toBe(0);
    // T3.1's instant self-kill for B's merge listing (`git log --first-parent --merges`) in the EXTRA repo
    // only, at the production 20 s budget: that repo is not read, the busy repo still is.
    let killed = 0;
    const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
      const argv = cmd as string[];
      const mergeLog = argv[0] === "git" && argv[1] === "log" && argv.includes("--first-parent") && argv.includes("--merges");
      if (mergeLog && (opts as { cwd?: string } | undefined)?.cwd === extra.dir) { killed++; return realSpawn(["sh", "-c", "kill -KILL $$"], opts as any); }
      return realSpawn(argv, opts as any);
    }) as typeof Bun.spawn);
    let x: Run;
    try { x = await runB({ mode: "trial", withExtra: true, reply: JSON.stringify({ campaigns: [] }) }); } finally { spy.mockRestore(); }
    expect(killed).toBe(1);
    expect([x!.records[0]!.outcome, x!.records[0]!.reason]).toEqual(["none", null]);
    expect(x!.records[0]!.prFacts).toEqual({ merges: 0, read: 0, timedOut: 0, marked: 0, reposUnread: 1 });
  }, 2 * LONG);

  test("[TB-P13] proposed on the RECORD path: two campaigns, one dropped → proposed 2, kept 1, one dropped[] entry", async () => {
    const reply = JSON.stringify({ campaigns: [{ title: CAMPAIGN_TITLE, items: ["G1", "G2"] }, { title: "polish piece number", items: ["G3"] }] });
    const x = await runB({ mode: "trial", reply });
    const r = x.records[0]!;
    expect([r.outcome, r.proposed, r.kept, r.dropped.length]).toEqual(["trial", 2, 1, 1]);
    expect(r.dropped[0]!.reasons).toContain("too-few-items");
  }, LONG);

  test("[TB-P13] \"invoker\":\"unknown\" (json false) when runCore is called with no recapInvocation", async () => {
    const x = await runB({ mode: "trial" });
    expect([x.records[0]!.invoker, x.records[0]!.json]).toEqual(["unknown", false]);
    const y = await runB({ mode: "trial", deps: { recapInvocation: { invoker: "scheduled", json: true } } });
    expect([y.records[0]!.invoker, y.records[0]!.json]).toEqual(["scheduled", true]);
  }, LONG);

  test("[TB-P13] date === runDate, even with an injected now on a DIFFERENT calendar day", async () => {
    const later = new Date(Date.now() + 2 * 86_400_000);
    const x = await runB({ mode: "trial", deps: { now: () => later } });
    expect(localDateStr(later)).not.toBe(x.r.runDate);            // the precondition that makes the pin bite
    expect(x.records[0]!.date).toBe(x.r.runDate);
    const stderr = JSON.parse(x.lines.find((l) => l.startsWith(RECAP_STDERR_PREFIX))!.slice(RECAP_STDERR_PREFIX.length));
    expect(stderr.date).toBe(x.r.runDate);
  }, LONG);

  test("[TB-P13] the stderr line matches none of /[()]/, /evidence/i, a left-bounded 7-hex run, nor a configured label — members carry SHAs, parens and labels, and latencyMs is forced above 999 999", async () => {
    const LABEL = "zeta-lab";
    const N = 16;
    const sha = (i: number): string => `cafe${i.toString(16).padStart(3, "0")}`.padEnd(40, "d");
    const records: RecapRecordV2[] = [];
    const lines: string[] = [];
    // `performance.now` jumps 2 000 000 ms once the grouper runs, so the phase's own latency exceeds the cap.
    const realNow = performance.now.bind(performance);
    let offset = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    const oErr = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      await runRecapCampaignsPhase({
        mode: "trial",
        struct: { date: "2026-09-27", machineScope: "t", provider: "echo", resume: [], suggestions: [], warnings: [],
          recap: Array.from({ length: N }, (_, i) => ({
            repo: LABEL,
            text: i < 2 ? `${CAMPAIGN_TITLE} step ${i + 1} (see ${LABEL} ${sha(i).slice(0, 9)}, evidence noted)` : `polish piece number ${i} (${LABEL}) ${sha(i).slice(0, 8)}`,
            evidence: sha(i).slice(0, 7),
          })) } as BriefingStruct,
        gateCommits: N,
        ctxCommits: Array.from({ length: N }, (_, i): Activity => ({ source: "git", kind: "commit", event_id: sha(i), repo: busy.dir, text: `fix (${LABEL}) ${sha(i).slice(0, 7)}`, timestamp: yesterdayNoon().toISOString() })),
        unitLabels: [LABEL], repoLabels: [LABEL], windowStart: new Date(Date.now() - 3 * 86_400_000),
        clockNow: () => new Date(), runDate: "2026-09-28", force: false,
        grouper: async () => {
          offset = 2_000_000;
          return JSON.stringify({ campaigns: [{ title: CAMPAIGN_TITLE, items: ["G1", "G2"] }, { title: "polish (piece) deadbee evidence", items: ["G3", "G4"] }] });
        },
        warningsOf: () => [], hardeningOf: () => "n/a", timeoutMs: 120_000,
        persist: async (line) => { records.push(JSON.parse(line)); },
        seams: { gitBudgetMs: 0 },
      });
    } finally { clock.mockRestore(); console.error = oErr; }
    expect(records).toHaveLength(1);
    expect([records[0]!.outcome, records[0]!.kept, records[0]!.dropped.length]).toEqual(["trial", 1, 1]);
    expect(records[0]!.latencyMs).toBeGreaterThan(999_999);         // the record keeps the true value
    const b = lines.filter((l) => l.startsWith(RECAP_STDERR_PREFIX));
    expect(b).toHaveLength(1);
    const line = b[0]!;
    expect(JSON.parse(line.slice(RECAP_STDERR_PREFIX.length)).latencyMs).toBe(STDERR_LATENCY_CAP);
    expect(line).not.toMatch(/[()]/);
    expect(line).not.toMatch(/evidence/i);
    expect(line).not.toMatch(/(?<![0-9a-f])[0-9a-f]{7}/i);
    expect(line).not.toContain(LABEL);
    // non-vacuity: the RECORD does carry parens, SHAs and the label (member texts, the dropped title)
    const rec = JSON.stringify(records[0]);
    expect(rec).toMatch(/[()]/);
    expect(rec).toContain(LABEL);
  }, LONG);

  // ── invoker / json through run() (round 3, B5) ──
  describe("[TB-P13] invoker and json come from main.ts, through run()", () => {
    let prevXdg: string | undefined, prevState: string | undefined;
    let repo = "";
    beforeAll(async () => {
      prevXdg = process.env.XDG_CONFIG_HOME;
      prevState = process.env.DAILY_BRIEFING_STATE_DIR;
      repo = await buildRepo([{ file: "p13.txt", content: "p13", isoDate: yesterdayNoon().toISOString() }]);
    });
    afterAll(() => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
      else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    });

    /** One `run()` with its OWN config dir (carrying `recap`) and its OWN registered state dir; returns
     *  the exit code and the record file's lines (null when the file does not exist). */
    async function viaRun(recap: Config["recapCampaigns"] | "absent", deps: Partial<ShellDeps>, out: { json?: boolean }) {
      const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb46-cfg-")));
      const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb46-state-")));
      mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
      const cfg: Config = { repos: [repo], provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, ...(recap === "absent" ? {} : { recapCampaigns: recap }) };
      writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfg));
      process.env.XDG_CONFIG_HOME = cfgHome;
      process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
      const provider: Provider = { generate: async () => "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y" };
      const oLog = console.log, oErr = console.error;
      console.log = () => {}; console.error = () => {};
      let code: number;
      try { code = await run(true, { provider, netProbe: async () => true, ...deps }, out); }
      finally { console.log = oLog; console.error = oErr; }
      const path = recapCampaignsPath();
      return { code, lines: existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : null };
    }

    test("[TB-P13] an interactive run --json records \"invoker\":\"cli\" and \"json\":true", async () => {
      const x = await viaRun({ mode: "trial" }, { interactive: true }, { json: true });
      expect(x.code).toBe(0);
      expect(x.lines).toHaveLength(1);
      expect(x.lines![0]).toContain('"invoker":"cli"');
      expect(x.lines![0]).toContain('"json":true');
      const rec = JSON.parse(x.lines![0]!) as RecapRecordV2;
      expect([rec.outcome, rec.reason, rec.forced]).toEqual(["skipped", "no-grouper", true]);
    }, LONG);

    test("[TB-P13] a default (scheduled, no --json) forced run records \"invoker\":\"scheduled\" and \"json\":false", async () => {
      const x = await viaRun({ mode: "trial" }, {}, {});
      expect(x.code).toBe(0);
      expect(x.lines).toHaveLength(1);
      expect(x.lines![0]).toContain('"invoker":"scheduled"');
      expect(x.lines![0]).toContain('"json":false');
    }, LONG);

    test("[TB-P13] with the key absent, the call-site gate skips B: no record line exists", async () => {
      const x = await viaRun("absent", { interactive: true }, { json: true });
      expect(x.code).toBe(0);
      expect(x.lines).toBeNull();
    }, LONG);

    test("[TB-P13] with {mode: \"off\"}, the call-site gate skips B: no record line exists", async () => {
      const x = await viaRun({ mode: "off" }, { interactive: true }, { json: true });
      expect(x.code).toBe(0);
      expect(x.lines).toBeNull();
    }, LONG);
  });
});
