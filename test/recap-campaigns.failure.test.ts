import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Tier B (Stage-2 recap campaigns), T4.5 — FAILURE INJECTION, spec §5.1 (F1–F24; plan §7) plus the two
// plan-added D2 phase-level cases. Every case drives the REAL `runCore` over a real git repo with the main
// call canned and B's grouper injected, and asserts spec §5.1's four things per case:
//   - the unstamped DELIVERED page is byte-identical to the same run with B `off` (except an `applied`
//     outcome whose record write (F23) or stderr line (F24) alone failed — that page equals the normal
//     `on` page, because the outcome stands);
//   - `runCore` returns normally;
//   - no account state is written (this file's own state dir holds no `account-state.json`, and nothing
//     at all, after every run — the record writer is injected);
//   - the record's `outcome`/`reason` are as specified, on exactly ONE record line.
// F19 and the two D2 cases hijack B's two-dot `rev-list` ONLY, through a PASS-THROUGH `spyOn(Bun, "spawn")`
// (every other spawn — the engine's own git included — reaches the real one; plan K21). F20–F22 inject
// through `RunDeps.recapImpl` (the phase's `seams.impl`); F24 through `spyOn(console, "error")`.
import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { runCore, type RunDeps } from "../src/core";
import { renderBriefing } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import { accountStatePath } from "../src/account";
import { RECAP_STDERR_PREFIX, REPLY_MAX_BYTES, type RecapRecordV2 } from "../src/recapCampaigns";
import { ProviderError, type BriefingStruct, type ProviderErrorCode } from "../src/types";
import { unstamp } from "./helpers/unstamp";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { buildRepo } from "./fixtures/build-repo";
import { busyRepo, busyReply, busyCfg, yesterdayNoon, CAMPAIGN_REPLY, CAMPAIGN_TITLE, type BusyRepo } from "./fixtures/recap-busy";

const LONG = 60_000;
/** The REAL spawn, captured before any spy. */
const realSpawn = Bun.spawn;
type SpawnArgs = Parameters<typeof Bun.spawn>;

let busy: BusyRepo;
/** The busy repo plus ONE in-window PR merge on `main`, so B's reader spawns a two-dot `rev-list`. */
let merged: BusyRepo;
/** A second repo (two in-window commits) — F16's second label. */
let other: { dir: string; label: string; shas: string[] };
let stateDir = "";
let prevStateDir: string | undefined;

const deliver = (s: BriefingStruct): string => unstamp(redactCredentials(renderBriefing(s)));

/** The canned main reply over `repo`, plus two bullets of `extra` (F16's second label) when given. */
function mainReply(repo: BusyRepo, extra?: typeof other): string {
  const base = busyReply(repo, 16);
  if (!extra) return base;
  const more = extra.shas.map((sha, i) => `- [${extra.label}] tune other piece ${i} | evidence: ${sha.slice(0, 7)}`);
  return base.replace("## SUGGESTIONS", [...more, "## SUGGESTIONS"].join("\n"));
}

type Run = { r: Awaited<ReturnType<typeof runCore>>; records: RecapRecordV2[]; lines: string[]; grouperCalls: number };

/** One runCore: mode (`off` = B does nothing), a grouper, an in-memory record writer unless `deps`
 *  overrides it, console.log/error captured into ONE array in call order (spec §5 convention) unless
 *  `rawConsole` (F24 installs its own spy). */
async function runB(opts: {
  mode: "off" | "trial" | "on"; grouper?: (p: string) => Promise<string>; repo?: BusyRepo; extra?: typeof other;
  deps?: Partial<RunDeps>; rawConsole?: boolean;
}): Promise<Run> {
  const repo = opts.repo ?? busy;
  const records: RecapRecordV2[] = [];
  const lines: string[] = [];
  let grouperCalls = 0;
  const reply = mainReply(repo, opts.extra);
  const cfg = busyCfg(repo, { recapCampaigns: { mode: opts.mode }, ...(opts.extra ? { repos: [repo.dir, opts.extra.dir] } : {}) });
  const grouper = opts.grouper ?? (async () => CAMPAIGN_REPLY);
  const deps: RunDeps = {
    provider: { generate: async () => reply }, netProbe: async () => true, persistHealth: async () => {},
    persistRecapRecord: async (line) => { records.push(JSON.parse(line)); },
    grouper: (p) => { grouperCalls++; return grouper(p); },
    ...opts.deps,
  };
  if (opts.rawConsole) return { r: await runCore(cfg, deps, true), records, lines, grouperCalls };
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { r: await runCore(cfg, deps, true), records, lines, grouperCalls }; }
  finally { console.log = oLog; console.error = oErr; }
}

/** The per-case invariants that do not depend on the outcome: runCore returned a struct, and no account
 *  (or any other) state landed in this file's own state dir. */
function returnedAndNoState(x: Run): void {
  expect(x.r.struct).toBeDefined();
  expect(x.r.emptyWindow).toBe(false);
  expect(existsSync(accountStatePath(stateDir))).toBe(false);
  expect(readdirSync(stateDir)).toEqual([]);
}
const outcomes = (x: Run) => x.records.map((r) => [r.outcome, r.reason]);
const stderrLines = (x: Run) => x.lines.filter((l) => l.startsWith(RECAP_STDERR_PREFIX));

/** Reference pages: the same inputs with B `off`, and a normal `on` run that applies CAMPAIGN_REPLY. */
const pages = { off: "", on: "", mergedOff: "", twoLabelOff: "" };

beforeAll(async () => {
  prevStateDir = process.env.DAILY_BRIEFING_STATE_DIR;
  stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tb45-state-")));
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;

  busy = await busyRepo(40);
  merged = await busyRepo(40);
  const iso = new Date(yesterdayNoon().getTime() + 50 * 60_000).toISOString();
  const script = [
    "set -e", "git checkout -q -b feat/x",
    `printf 'x\\n' > x.txt && git add x.txt && GIT_AUTHOR_DATE=${iso} GIT_COMMITTER_DATE=${iso} git commit -q -m 'adjust topic widget'`,
    "git checkout -q main",
    `GIT_AUTHOR_DATE=${iso} GIT_COMMITTER_DATE=${iso} git merge -q --no-ff -m 'Merge pull request #7 from owner/feat/x' feat/x`,
  ].join("\n");
  const m = realSpawn(["sh", "-c", script], { cwd: merged.dir, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  await m.exited;
  if (m.exitCode !== 0) throw new Error(`merge fixture: ${await new Response(m.stderr).text()}`);

  const t0 = yesterdayNoon().getTime() + 55 * 60_000;
  const otherDir = await buildRepo([
    { file: "o1.txt", content: "o1", isoDate: new Date(t0).toISOString() },
    { file: "o2.txt", content: "o2", isoDate: new Date(t0 + 60_000).toISOString() },
  ]);
  const log = realSpawn(["git", "log", "--reverse", "--format=%H"], { cwd: otherDir, stdout: "pipe", stderr: "pipe" });
  const shas = (await new Response(log.stdout).text()).trim().split("\n").filter(Boolean);
  await log.exited;
  other = { dir: otherDir, label: basename(otherDir), shas };

  pages.off = deliver((await runB({ mode: "off" })).r.struct);
  const on = await runB({ mode: "on" });
  expect(outcomes(on)).toEqual([["applied", null]]);          // the reference really applied
  pages.on = deliver(on.r.struct);
  expect(pages.on).not.toBe(pages.off);
  pages.mergedOff = deliver((await runB({ mode: "off", repo: merged })).r.struct);
  pages.twoLabelOff = deliver((await runB({ mode: "off", extra: other })).r.struct);
}, 4 * LONG);

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
  else process.env.DAILY_BRIEFING_STATE_DIR = prevStateDir;
});

/** One whole-reply / reply-shape case in mode `on` (the STRONGER mode for "page equals off": `on` is the
 *  only mode that could change it). */
async function expectOffPage(x: Run, outcome: string, reason: string | null, offPage = pages.off): Promise<RecapRecordV2> {
  returnedAndNoState(x);
  expect(outcomes(x)).toEqual([[outcome, reason]]);
  expect(stderrLines(x)).toHaveLength(1);
  expect(deliver(x.r.struct)).toBe(offPage);
  expect(x.r.struct.recap.some((e) => e.campaign !== undefined)).toBe(false);
  return x.records[0]!;
}

// ── F1–F6: the grouper throws ────────────────────────────────────────────────────────────────────
describe("the grouper throws: whole-reply rejection, the page is Stage 1's", () => {
  // The tags are LITERAL in each title (F-8 greps the source for them).
  const CASES: [string, ProviderErrorCode][] = [
    ["[TB-F1] a thrown ProviderError missing-binary → rejected, provider-error:missing-binary", "missing-binary"],
    ["[TB-F2] a thrown ProviderError nonzero-exit → rejected, provider-error:nonzero-exit", "nonzero-exit"],
    ["[TB-F3] a thrown ProviderError empty-output → rejected, provider-error:empty-output", "empty-output"],
    ["[TB-F4] a thrown ProviderError timeout → rejected, provider-error:timeout", "timeout"],
    ["[TB-F5] a thrown ProviderError usage-limit → rejected, provider-error:usage-limit, and no account state is written", "usage-limit"],
  ];
  for (const [title, code] of CASES) {
    test(title, async () => {
      const x = await runB({ mode: "on", grouper: async () => { throw new ProviderError(code, `tb45: ${code}`); } });
      expect(x.grouperCalls).toBe(1);
      const rec = await expectOffPage(x, "rejected", `provider-error:${code}`);
      expect(rec.gate?.fired).toBe(true);
    }, LONG);
  }

  // Harden r1 (A2): step 9 copies the runtime warnings B's own call appended on EVERY outcome that
  // reached step 4 — a whole-reply rejection (reply not ok) included, not just an accepted reply. The
  // provider double carries `runtimeWarnings` (read through core's `runtimeWarningsOf`); the grouper
  // appends to it before throwing / hanging, i.e. DURING B's call, after the main call's fold.
  test("a provider-error or deadline rejection still records the warnings B's call appended", async () => {
    for (const [grouperOf, deps, reason] of [
      [(w: string[]) => async () => { w.push("tb-h1: rung warning before the throw"); throw new ProviderError("nonzero-exit", "tb-h1"); }, {}, "provider-error:nonzero-exit"],
      [(w: string[]) => () => { w.push("tb-h1: rung warning before the hang"); return new Promise<string>(() => {}); }, { recapCallDeadlineMs: 50 }, "deadline"],
    ] as const) {
      const runtimeWarnings: string[] = [];
      const reply = mainReply(busy);
      const x = await runB({
        mode: "on", grouper: grouperOf(runtimeWarnings),
        deps: { ...deps, provider: Object.assign({ generate: async () => reply }, { runtimeWarnings }) },
      });
      const rec = await expectOffPage(x, "rejected", reason);
      expect(runtimeWarnings).toHaveLength(1);                       // non-vacuity: the double really carried one
      expect(rec.providerWarnings).toEqual([...runtimeWarnings]);
    }
  }, LONG);

  test("[TB-F6] a non-ProviderError throw → rejected, grouper-throw", async () => {
    const x = await runB({ mode: "on", grouper: async () => { throw new TypeError("tb45: not a provider error"); } });
    await expectOffPage(x, "rejected", "grouper-throw");
  }, LONG);
});

// ── F7–F18: the reply ────────────────────────────────────────────────────────────────────────────
describe("the reply: parse, schema, ids, validation, deadline", () => {
  const reply = (text: string) => async () => text;
  const VALID = { title: CAMPAIGN_TITLE, items: ["G1", "G2"] };

  test("[TB-F7] garbage text → rejected, unparseable", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply("the model rambled instead of answering") }), "rejected", "unparseable");
  }, LONG);

  test("[TB-F8] a single fenced reply is accepted (trial: page unchanged)", async () => {
    const x = await runB({ mode: "trial", grouper: reply("```json\n" + CAMPAIGN_REPLY + "\n```") });
    const rec = await expectOffPage(x, "trial", null);
    expect([rec.proposed, rec.kept]).toEqual([1, 1]);
  }, LONG);

  test("[TB-F9] two fences → rejected, unparseable", async () => {
    const fenced = "```json\n" + CAMPAIGN_REPLY + "\n```";
    await expectOffPage(await runB({ mode: "on", grouper: reply(`${fenced}\n${fenced}`) }), "rejected", "unparseable");
  }, LONG);

  test("[TB-F10] prose around the object → rejected, unparseable", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply(`Here you go: ${CAMPAIGN_REPLY} — hope that helps`) }), "rejected", "unparseable");
  }, LONG);

  test("[TB-F11] a reply of 16 384 + 1 bytes (D5) → rejected, oversize; at exactly 16 384 it is parsed", async () => {
    const body = JSON.stringify({ campaigns: [] });
    const at = (n: number) => " ".repeat(n - Buffer.byteLength(body, "utf8")) + body;
    expect(Buffer.byteLength(at(REPLY_MAX_BYTES + 1), "utf8")).toBe(16_385);
    await expectOffPage(await runB({ mode: "on", grouper: reply(at(REPLY_MAX_BYTES + 1)) }), "rejected", "oversize");
    await expectOffPage(await runB({ mode: "on", grouper: reply(at(REPLY_MAX_BYTES)) }), "none", null);
  }, LONG);

  test("[TB-F12] an extra top-level key → rejected, schema", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply(JSON.stringify({ campaigns: [VALID], note: "x" })) }), "rejected", "schema");
  }, LONG);

  test("[TB-F13] an extra campaign key → rejected, schema", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply(JSON.stringify({ campaigns: [{ ...VALID, why: "x" }] })) }), "rejected", "schema");
  }, LONG);

  test("[TB-F14] an unknown id → rejected, unknown-id", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply(JSON.stringify({ campaigns: [{ ...VALID, items: ["G1", "G99"] }] })) }), "rejected", "unknown-id");
  }, LONG);

  test("[TB-F15] a repeated id → rejected, duplicate-id", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply(JSON.stringify({ campaigns: [{ ...VALID, items: ["G1", "G1"] }] })) }), "rejected", "duplicate-id");
  }, LONG);

  test("[TB-F16] a cross-label campaign is dropped (mixes-labels) → none", async () => {
    // Two repos → two labels; the grouper reads its own prompt and pairs the first id of each LABEL block.
    let prompt = "";
    const x = await runB({
      mode: "on", extra: other,
      grouper: async (p) => {
        prompt = p;
        const firsts: string[] = [];
        let fresh = false;
        for (const line of p.split("\n")) {
          if (line.startsWith("LABEL ")) { fresh = true; continue; }
          const m = /^ {2}(G\d+) {2}label=/.exec(line);
          if (m && fresh) { firsts.push(m[1]!); fresh = false; }
        }
        return JSON.stringify({ campaigns: [{ title: "tune other piece", items: firsts }] });
      },
    });
    expect(prompt.split("\n").filter((l) => l.startsWith("LABEL "))).toHaveLength(2);
    returnedAndNoState(x);
    expect(outcomes(x)).toEqual([["none", null]]);
    expect(x.records[0]!.dropped).toHaveLength(1);
    expect(x.records[0]!.dropped[0]!.reasons).toContain("mixes-labels");
    expect(stderrLines(x)).toHaveLength(1);
    expect(deliver(x.r.struct)).toBe(pages.twoLabelOff);
  }, LONG);

  test("[TB-F17] a grouper that never settles, with a short injected D_call → rejected, deadline", async () => {
    const x = await runB({ mode: "on", grouper: () => new Promise<string>(() => {}), deps: { recapCallDeadlineMs: 50 } });
    await expectOffPage(x, "rejected", "deadline");
  }, LONG);

  test("[TB-F18] an empty campaign list → none, not rejected", async () => {
    await expectOffPage(await runB({ mode: "on", grouper: reply(JSON.stringify({ campaigns: [] })) }), "none", null);
  }, LONG);
});

// ── F19 and the D2 phase-level pair: B's two-dot rev-list, hijacked ────────────────────────────────
/** The pass-through spy: B's two-dot `rev-list <hex>..<hex>` gets `substitute`; everything else is real. */
function hijackRevList(substitute: (cmd: string[], opts: SpawnArgs[1]) => ReturnType<typeof Bun.spawn>) {
  let hijacked = 0;
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
    const argv = cmd as string[];
    if (argv[0] === "git" && argv[1] === "rev-list" && /^[0-9a-f]+\.\.[0-9a-f]+$/.test(argv[2] ?? "")) {
      hijacked++;
      return substitute(argv, opts);
    }
    return realSpawn(argv, opts as any);
  }) as typeof Bun.spawn);
  return { spy, count: () => hijacked };
}
function stream(chunks: string[], eof: boolean): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); if (eof) c.close(); } });
}
/** `git.swallow-audit`'s held spawn: exits 0 but leaves stdout open → runGit's IncompleteReadError. */
const heldSpawn = () => ({
  stdout: stream(["partial"], false), stderr: stream([], true),
  exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {},
}) as unknown as ReturnType<typeof Bun.spawn>;

describe("B's git reader", () => {
  test("[TB-F19] the git reader throws IncompleteReadError → rejected, exception, ONE line (labels[], no prFacts)", async () => {
    const h = hijackRevList(() => heldSpawn());
    let x: Run;
    try { x = await runB({ mode: "on", repo: merged }); } finally { h.spy.mockRestore(); }
    expect(h.count()).toBe(1);
    const rec = await expectOffPage(x!, "rejected", "exception", pages.mergedOff);
    expect(rec.labels?.length).toBeGreaterThan(0);
    expect("prFacts" in rec).toBe(false);
  }, LONG);

  test("a real non-zero exit on B's rev-list ends the morning as exception", async () => {
    const h = hijackRevList((_argv, opts) => realSpawn(["sh", "-c", "exit 3"], opts as any));
    let x: Run;
    try { x = await runB({ mode: "on", repo: merged }); } finally { h.spy.mockRestore(); }
    expect(h.count()).toBe(1);
    returnedAndNoState(x!);
    expect(outcomes(x!)).toEqual([["rejected", "exception"]]);
    expect(deliver(x!.r.struct)).toBe(pages.mergedOff);
  }, LONG);

  test("a SIGKILLed rev-list lets the morning continue", async () => {
    // The instant self-kill (T3.1's mechanism, indistinguishable from a timeout kill) at the PRODUCTION
    // 20 s budget (no `recapGitBudgetMs` seam): D2 → `timedOut`, no facts, and the outcome is the grouper's.
    const h = hijackRevList((_argv, opts) => realSpawn(["sh", "-c", "kill -KILL $$"], opts as any));
    let x: Run;
    try { x = await runB({ mode: "trial", repo: merged }); } finally { h.spy.mockRestore(); }
    expect(h.count()).toBe(1);
    returnedAndNoState(x!);
    expect(outcomes(x!)).toEqual([["trial", null]]);
    expect(x!.records[0]!.prFacts?.timedOut).toBeGreaterThanOrEqual(1);
    expect(x!.records[0]!.prFacts).toMatchObject({ merges: 1, read: 0, timedOut: 1, reposUnread: 0 });
    expect(x!.grouperCalls).toBe(1);
    expect(deliver(x!.r.struct)).toBe(pages.mergedOff);
  }, LONG);
});

// ── F20–F22: throws inside the composition, through the seams ─────────────────────────────────────
describe("throws in steps 2–8, through RunDeps.recapImpl", () => {
  test("[TB-F20] buildCampaignItems throws (the phase's step 2) → rejected, exception, ONE line", async () => {
    const x = await runB({ mode: "on", deps: { recapImpl: { buildCampaignItems: () => { throw new Error("tb45: items"); } } } });
    const rec = await expectOffPage(x, "rejected", "exception");
    expect(x.grouperCalls).toBe(0);
    expect(rec.gate?.fired).toBe(true);
    expect(["labels" in rec, "prFacts" in rec, "campaigns" in rec]).toEqual([false, false, false]);
  }, LONG);

  test("[TB-F21] applyCampaigns throws (inside scoreReply) → rejected, exception, ONE line", async () => {
    const x = await runB({ mode: "on", deps: { recapImpl: { applyCampaigns: () => { throw new Error("tb45: apply"); } } } });
    const rec = await expectOffPage(x, "rejected", "exception");
    expect(x.grouperCalls).toBe(1);
    expect("campaigns" in rec).toBe(false);
  }, LONG);

  test("[TB-F22] liveCheck throws (inside scoreReply) → rejected, exception, ONE line", async () => {
    const x = await runB({ mode: "on", deps: { recapImpl: { liveCheck: () => { throw new Error("tb45: live check"); } } } });
    const rec = await expectOffPage(x, "rejected", "exception");
    expect("campaigns" in rec).toBe(false);
  }, LONG);
});

// ── F23–F24: throws in steps 10–11 change nothing but their own output ─────────────────────────────
describe("steps 10 and 11 fail on their own", () => {
  test("[TB-F23] persistRecapRecord rejects → the outcome stands, no line, the stderr line says \"record\":false", async () => {
    for (const [mode, outcome, page] of [["on", "applied", () => pages.on], ["trial", "trial", () => pages.off]] as const) {
      let writes = 0;
      const x = await runB({ mode, deps: { persistRecapRecord: async () => { writes++; throw new Error("tb45: disk full"); } } });
      returnedAndNoState(x);
      expect({ mode, writes, records: x.records.length }).toEqual({ mode, writes: 1, records: 0 });
      const lines = stderrLines(x);
      expect(lines).toHaveLength(1);
      const body = JSON.parse(lines[0]!.slice(RECAP_STDERR_PREFIX.length));
      expect({ mode, outcome: body.outcome, reason: body.reason, record: body.record }).toEqual({ mode, outcome, reason: null, record: false });
      expect(deliver(x.r.struct)).toBe(page());           // `applied` still applies; `trial` is the off page
    }
  }, 2 * LONG);

  test("[TB-F24] diagError throws on the stderr line → the outcome stands, ONE record line, no exception line", async () => {
    // `diagError` is `console.error(redactCredentials(line))` (diag.ts): the spy throws for B's line and
    // captures every other one, so the throw is raised exactly where step 11 prints.
    const others: string[] = [];
    let thrown = 0;
    const spy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      const line = a.map(String).join(" ");
      if (line.startsWith("grouping-info [recap-campaigns]:")) { thrown++; throw new Error("tb45: stderr closed"); }
      others.push(line);
    });
    let x: Run;
    try { x = await runB({ mode: "on", rawConsole: true }); } finally { spy.mockRestore(); }
    expect(thrown).toBe(1);
    returnedAndNoState(x!);
    expect(outcomes(x!)).toEqual([["applied", null]]);
    // the throwing line was B's ONLY stderr emission: no fallback / "exception" line was printed in its
    // place (every line starting with the prefix threw above, so `others` is what else reached stderr)
    expect(others.filter((l) => l.includes("recap-campaigns"))).toEqual([]);
    expect(deliver(x!.r.struct)).toBe(pages.on);
  }, LONG);
});
