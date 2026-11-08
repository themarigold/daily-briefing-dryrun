// test/summary.run.test.ts — A2-M3-T9: the hook in `run()`, on every run's exit path, driven through the named paired
// test seam (`summaryProvider` + `summaryTestSeed`), or a real owned fake CLI / loopback API where the production path
// itself is the point. A delivered run waits for the summary, whatever its output mode, and nothing it reports changes.
import "./fixtures/isolate-state";
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { main as auditMain } from "../scripts/audit";
import { briefingsDir } from "../src/json";
import { run, type RunDeps, type RunOutput } from "../src/main";
import * as marker from "../src/marker";
import { acquireRunLock } from "../src/runlock";
import * as notifyModule from "../src/notify";
import * as factory from "../src/providerFactory";
import * as updateCheck from "../src/updateCheck";
import * as cards from "../src/summary/cards";
import * as job from "../src/summary/job";
import * as pageVersion from "../src/summary/page-version";
import * as store from "../src/summary/store";
import { ProviderError, type Config, type GenerateOpts, type Provider } from "../src/types";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { MEETING_SENTINELS, calendarSnapshot, calendarStep, capturedCalendar } from "./helpers/summary-calendar";
import { BRIEFING, fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
const prevCfg = process.env.XDG_CONFIG_HOME;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => {
  process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
});
const spies: { mockRestore(): void }[] = [];
const servers: FakeApi[] = [];
const releases: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (spies.length) spies.pop()!.mockRestore();
  while (servers.length) await servers.pop()!.stop();
  while (releases.length) await releases.pop()!();
});
function spied<S extends { mockRestore(): void }>(spy: S): S { spies.push(spy); return spy; }

const POINT = "A real point about the work.";
const ANSWER = (key: string) => JSON.stringify({ projects: [{ key, points: [POINT] }], goodMorningSentence: "Good to see the work moving." });
const UNUSED_PROVIDER = { cli: "/nonexistent/never-spawned", argv: [], promptVia: "stdin" } as unknown as Config["provider"];
const INJECTED: Provider = { generate: async () => BRIEFING };

type Call = { prompt: string; opts?: GenerateOpts };
/** A summary provider whose answer is written from the page's own first card. */
function summaryFake(answer?: (call: Call) => Promise<string> | string) {
  const calls: Call[] = [];
  const provider: Provider = {
    generate: async (prompt, opts) => {
      const call = { prompt, ...(opts ? { opts } : {}) };
      calls.push(call);
      if (answer) return answer(call);
      const first = cards.summaryCardsFromPage(readFileSync(marker.latestBriefingPath(), "utf8"))[0];
      return ANSWER(first?.key ?? "other:");
    },
  };
  return { provider, calls };
}
const testSeed = async (block: Config["provider"] = UNUSED_PROVIDER) => ({
  winner: { provider: block },
  morningLocked: false,
  calendarCapture: capturedCalendar(await calendarSnapshot({ configured: false })),
});
const pair = async (fake: { provider: Provider }): Promise<Partial<RunDeps>> => ({ summaryProvider: fake.provider, summaryTestSeed: await testSeed() });
const deps = (extra: Partial<RunDeps> = {}): RunDeps => walkDeps({ provider: INJECTED, ...extra }) as RunDeps;

type Captured = { stdout: string[]; stderr: string[]; envelopePath: string; home: string };
async function withConfig<T>(cfg: Record<string, unknown> | null, fn: (c: Captured) => Promise<T>): Promise<T> {
  const home = tempDir("dba-run-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  if (cfg !== null) writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], provider: UNUSED_PROVIDER, ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
  const stdout: string[] = [], stderr: string[] = [];
  const realErr = console.error, realLog = console.log, realWarn = console.warn;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(" ")); };
  console.warn = console.error;
  console.log = (...a: unknown[]) => { stdout.push(a.map(String).join(" ")); };
  try { return await fn({ stdout, stderr, envelopePath: join(home, "envelope.json"), home }); }
  finally { console.error = realErr; console.log = realLog; console.warn = realWarn; }
}
const summaryFiles = () => existsSync(briefingsDir()) ? readdirSync(briefingsDir()).filter((n) => n.includes(".summary")) : [];
const theRecord = (): Record<string, unknown> => {
  const [name] = summaryFiles().filter((n) => n.endsWith(".summary.json"));
  return JSON.parse(readFileSync(join(briefingsDir(), name!), "utf8"));
};
const ON = { aiSummary: { enabled: true } };
const CALENDAR_HEADING = "▶ Today's calendar";

/** What a run reports, with only paths and the clock's reading normalised. */
function reportOf(c: Captured, state: string, code: number) {
  const stable = (s: string) => s.replaceAll(state, "<state>").replaceAll(c.home, "<config>").replaceAll(/\b\d{1,2}:\d{2}\b/g, "<hh:mm>").replaceAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<iso>").replaceAll(/"waitedMs":\d+/g, '"waitedMs":"<ms>"');
  const lines = (l: string[]) => l.filter((line) => !/^waited ~\d+s for the network/.test(line)).map(stable);
  return {
    code, stdout: lines(c.stdout), stderr: lines(c.stderr),
    envelope: existsSync(c.envelopePath) ? stable(readFileSync(c.envelopePath, "utf8")) : "",
    marker: readFileSync(marker.markerPath(), "utf8"), page: stable(readFileSync(marker.latestBriefingPath(), "utf8")),
  };
}
/** One delivered run in fresh state and config folders. */
async function observed(cfg: Record<string, unknown>, extra: Partial<RunDeps> = {}, out: (c: Captured) => RunOutput = (c) => ({ jsonOut: c.envelopePath })) {
  const state = freshStateDir();
  return withConfig(cfg, async (c) => reportOf(c, state, await run(true, deps(extra), out(c))));
}

describe("the gate", () => {
  test("a delivered run writes the sidecar through the paired seam, and the seam sees the page less the host, locked", async () => {
    freshStateDir();
    const fake = summaryFake();
    const code = await withConfig(ON, async () => run(true, deps(await pair(fake))));
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(1);
    const page = readFileSync(marker.latestBriefingPath(), "utf8");
    const sent = page.split("\n").filter((line) => !line.startsWith("— generated via ")).map((line) => line.startsWith("☀️") ? line.slice(0, line.indexOf("  (this machine: ")) : line).join("\n");
    expect(page).toContain("this machine: ");
    expect(page).toContain("\n— generated via ");
    expect(fake.calls[0]!.prompt).not.toContain("— generated via ");
    expect(fake.calls[0]!.prompt).toContain(sent);
    expect(fake.calls[0]!.prompt).not.toContain("this machine: ");
    expect(fake.calls[0]!.opts?.calendarVariants?.locked).toContain(sent);
    expect(theRecord()).toMatchObject({ state: "ready", revision: 1, pageDate: readFileSync(marker.markerPath(), "utf8").trim() });
  });

  test("off: no call, no record, whatever the seam holds", async () => {
    freshStateDir();
    const fake = summaryFake();
    await withConfig({ aiSummary: { enabled: false } }, async () => run(true, deps(await pair(fake))));
    expect(fake.calls).toEqual([]);
    expect(summaryFiles()).toEqual([]);
  });

  test("turning the switch off during the morning makes no summary call and no record", async () => {
    freshStateDir();
    const fake = summaryFake();
    await withConfig(ON, async (c) => {
      const provider: Provider = { generate: async () => {
        const path = join(c.home, "daily-briefing", "config.json");
        const cfg = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        writeFileSync(path, JSON.stringify({ ...cfg, aiSummary: { enabled: false } }));
        return BRIEFING;
      } };
      expect(await run(true, deps({ ...(await pair(fake)), provider }))).toBe(0);
    });
    expect(fake.calls).toEqual([]);
    expect(summaryFiles()).toEqual([]);
  });

  test("half a pair is no pair: an injected main provider alone, or with one field, never makes a second call", async () => {
    const fake = summaryFake();
    const build = spied(spyOn(factory, "buildProvider"));
    for (const extra of [{}, { summaryProvider: fake.provider }, { summaryTestSeed: await testSeed() }] as Partial<RunDeps>[]) {
      freshStateDir();
      await withConfig(ON, () => run(true, deps(extra)));
      expect(summaryFiles()).toEqual([]);
    }
    expect(fake.calls).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  test("the clock and T seams are ignored without the pair", async () => {
    freshStateDir();
    let reads = 0;
    const timers = watchTimers();
    await withConfig(ON, () => run(true, deps({ summaryClock: () => { reads++; return 0; }, summaryTimeoutMs: 7_000 })));
    expect(reads).toBe(0);
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.allCleared()).toBe(true);
  });

  test("a page with no eligible cards makes no call and no pending record", async () => {
    freshStateDir();
    spied(spyOn(cards, "summaryCardsFromPage")).mockReturnValue([]);
    const fake = summaryFake();
    const write = spied(spyOn(store, "writeSummaryRecord"));
    expect(await withConfig(ON, async () => run(true, deps(await pair(fake))))).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(summaryFiles()).toEqual([]);
  });

  test("a quiet delivered page makes no call and no pending record, and still prunes", async () => {
    freshStateDir();
    mkdirSync(briefingsDir(), { recursive: true });
    const old = join(briefingsDir(), `${marker.localDateStr(new Date())}.${"a".repeat(64)}.${"b".repeat(64)}.summary.json`);
    writeFileSync(old, "old");
    const fake = summaryFake();
    const write = spied(spyOn(store, "writeSummaryRecord"));
    // Refused for being quiet, not for happening to have no cards.
    const cardsOf = spied(spyOn(cards, "summaryCardsFromPage")).mockReturnValue([{ key: "project:r", label: "r" }]);
    await withConfig({ ...ON, repos: [] }, async () => run(true, deps(await pair(fake))));
    expect(fake.calls).toEqual([]);
    expect(cardsOf).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(existsSync(old)).toBe(false);
  });

  const NOT_DELIVERED: [string, Record<string, unknown> | null, boolean, () => Partial<RunDeps>, () => void | Promise<void>][] = [
    ["already ran today", ON, false, () => ({}), () => { writeFileSync(marker.markerPath(), `${marker.localDateStr(new Date())}\n`); }],
    ["below the morning floor", { ...ON, morningTime: "23:59" }, false, () => ({ now: () => { const d = new Date(); d.setHours(0, 1, 0, 0); return d; } }), () => {}],
    ["no config", null, true, () => ({}), () => {}],
    ["offline", ON, false, () => ({ netProbe: async () => false, netGraceMs: 1, netPollMs: 1, now: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return d; } }), () => {}],
    ["an unusable answer", ON, true, () => ({ provider: { generate: async () => "No briefing today." } }), () => {}],
    ["write-fail", ON, true, () => ({}), () => { mkdirSync(marker.latestBriefingPath(), { recursive: true }); }],
    ["marker-fail", ON, true, () => ({}), () => { spied(spyOn(marker, "stampToday")).mockRejectedValue(new Error("fixture marker failure")); }],
    ["lock held", ON, true, () => ({}), async () => {
      const lock = await acquireRunLock({ invoker: "summary-test", timeoutMs: 30_000 });
      if (!lock.acquired) throw new Error("fixture must acquire its fresh lock");
      releases.push(lock.release);
    }],
  ];
  test.each(NOT_DELIVERED)("%s: no call, no pending, no hook", async (_name, cfg, force, extra, arrange) => {
    const state = freshStateDir();
    mkdirSync(state, { recursive: true });
    await arrange();
    const fake = summaryFake();
    const hook = spied(spyOn(job, "runSummaryJob"));
    await withConfig(cfg, async () => run(force, deps({ ...(await pair(fake)), ...extra() })));
    if (["write-fail", "marker-fail", "lock held"].includes(_name)) {
      expect((await marker.readLastSkip())?.reason).toBe(_name === "lock held" ? "concurrent" : _name);
    }
    expect(fake.calls).toEqual([]);
    expect(hook).not.toHaveBeenCalled();
    expect(summaryFiles()).toEqual([]);
  });

  test("a crash rethrows before the hook, unchanged", async () => {
    freshStateDir();
    const fake = summaryFake();
    const hook = spied(spyOn(job, "runSummaryJob"));
    const failing = deps({ ...(await pair(fake)), provider: { generate: async () => { throw new TypeError("a bug"); } } });
    await withConfig(ON, () => run(true, failing)).catch(() => {});
    expect(fake.calls).toEqual([]);
    expect(hook).not.toHaveBeenCalled();
  });
});

/** Every timer armed after the notification, the last await before the phase starts. */
function watchTimers() {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const armed: { delay: number | undefined; handle: ReturnType<typeof setTimeout> }[] = [];
  const cleared = new Set<unknown>();
  let watching = false;
  spied(spyOn(notifyModule, "notify")).mockImplementation(async () => { watching = true; return true; });
  spied(spyOn(globalThis, "setTimeout")).mockImplementation(((fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);
    if (watching) armed.push({ delay: ms, handle });
    return handle;
  }) as unknown as typeof setTimeout);
  spied(spyOn(globalThis, "clearTimeout")).mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
    cleared.add(handle);
    return realClear(handle);
  }) as typeof clearTimeout);
  return { delays: () => armed.map((a) => a.delay), allCleared: () => armed.every((a) => cleared.has(a.handle)) };
}

describe("the phase ends on every path out of run()", () => {
  test("no seed (a quiet day, an injected main provider): the armed timer is cleared by the time run() returns", async () => {
    freshStateDir();
    const timers = watchTimers();
    const cardsOf = spied(spyOn(cards, "summaryCardsFromPage"));
    await withConfig(ON, () => run(true, deps()));
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.allCleared()).toBe(true);
    expect(cardsOf).not.toHaveBeenCalled();                                          // cleanup only: the gate needs the seed
  });

  test("no eligible cards, a throwing gate and a throwing job each leave no timer running, and reach the update check with the same code and stderr", async () => {
    const baseline = await observed(ON);
    const ARRANGE: [string, () => void][] = [
      ["no cards", () => { spied(spyOn(cards, "summaryCardsFromPage")).mockReturnValue([]); }],
      ["a throwing cards function", () => { spied(spyOn(cards, "summaryCardsFromPage")).mockImplementation(() => { throw new Error("cards SECRET"); }); }],
      ["a throwing job", () => { spied(spyOn(job, "runSummaryJob")).mockImplementation(async () => { throw new Error("job SECRET"); }); }],
      ["a synchronously throwing job", () => { spied(spyOn(job, "runSummaryJob")).mockImplementation((() => { throw new Error("job SECRET"); }) as never); }],
    ];
    for (const [name, arrange] of ARRANGE) {
      const timers = watchTimers();
      const check = spied(spyOn(updateCheck, "autoUpdateCheck")).mockImplementation(async () => {});
      arrange();
      const seen = await observed(ON, await pair(summaryFake()));
      expect(seen, name).toEqual(baseline);
      expect(JSON.stringify(seen)).not.toContain("SECRET");
      expect(check, name).toHaveBeenCalledTimes(1);
      expect(timers.allCleared(), name).toBe(true);
      while (spies.length) spies.pop()!.mockRestore();
    }
  });

  test("the carried controller is aborted when the job has finished", async () => {
    freshStateDir();
    const fake = summaryFake();
    await withConfig(ON, async () => run(true, deps(await pair(fake))));
    expect(fake.calls[0]!.opts?.signal?.aborted).toBe(true);
  });
});

describe("the run waits, in every mode, and reports what it would have", () => {
  const MODES: [string, boolean, Partial<RunDeps>, (c: Captured) => RunOutput][] = [
    ["a scheduled tick", false, { now: () => { const d = new Date(); d.setHours(23, 59, 0, 0); return d; } }, (c) => ({ jsonOut: c.envelopePath })],
    ["a terminal run", true, { interactive: true }, () => ({})],
    ["run --json (the app's Run now)", true, {}, () => ({ json: true })],
    ["--now", false, { runNow: true }, () => ({})],
    ["--force", true, {}, () => ({})],
  ];
  test.each(MODES)("%s", async (_name, force, extra, out) => {
    const state = freshStateDir();
    const observedAtCall: Record<string, unknown> = {};
    let envelopeAtCall: () => boolean | undefined = () => undefined;
    let returned = false;
    let release: () => void = () => {};
    const fake = summaryFake(async () => {
      observedAtCall.marker = existsSync(marker.markerPath());
      observedAtCall.page = existsSync(marker.latestBriefingPath());
      observedAtCall.envelope = envelopeAtCall();
      observedAtCall.lockReleased = !existsSync(join(state, "run.lock"));
      observedAtCall.returned = returned;
      observedAtCall.pending = theRecord().state;
      setTimeout(() => { observedAtCall.returnedLater = returned; release(); }, 150);
      await new Promise<void>((r) => { release = r; });
      return ANSWER("project:r");
    });
    const check = spied(spyOn(updateCheck, "autoUpdateCheck")).mockImplementation(async () => { observedAtCall.checkSawFinal = theRecord().state !== "pending"; });
    await withConfig(ON, async (c) => {
      envelopeAtCall = () => out(c).jsonOut ? existsSync(c.envelopePath) : undefined;
      const code = await run(force, deps({ ...(await pair(fake)), ...extra }), out(c));
      returned = true;
      expect(code).toBe(0);
      if (out(c).jsonOut) expect(JSON.parse(readFileSync(c.envelopePath, "utf8")).delivered).toBe(true);
      if (out(c).json) expect(JSON.parse(c.stdout.join("\n")).delivered).toBe(true);
    });
    expect(fake.calls).toHaveLength(1);
    expect(observedAtCall).toMatchObject({ marker: true, page: true, lockReleased: true, returned: false, returnedLater: false, pending: "pending", envelope: out({ stdout: [], stderr: [], envelopePath: "x", home: "" }).jsonOut ? true : undefined });
    const updateCheckRuns = (extra.interactive ?? false) === false && out({ stdout: [], stderr: [], envelopePath: "x", home: "" }).json !== true;
    expect(check).toHaveBeenCalledTimes(updateCheckRuns ? 1 : 0);
    if (updateCheckRuns) expect(observedAtCall.checkSawFinal).toBe(true);
  });

  test("the update check still runs last on a scheduled tick when the summary is off", async () => {
    const check = spied(spyOn(updateCheck, "autoUpdateCheck")).mockImplementation(async () => {});
    await observed({});
    expect(check).toHaveBeenCalledTimes(1);
  });

  const PROVIDERS: [string, (call: Call) => Promise<string> | string][] = [
    ["an answer", () => ANSWER("project:r")],
    ["unusable text", () => "prose SECRET"],
    ["a throw", () => { throw new Error("provider SECRET"); }],
    ["a provider error", () => { throw new ProviderError("nonzero-exit", "provider SECRET"); }],
    ["a usage limit", () => { throw new ProviderError("usage-limit", "You've hit your weekly limit SECRET"); }],
  ];
  const OUTS: [string, (c: Captured) => RunOutput][] = [
    ["--json-out", (c) => ({ jsonOut: c.envelopePath })],
    ["--json", () => ({ json: true })],
  ];
  describe.each(OUTS)("with %s, stdout, stderr, envelope, marker and page are byte-identical to an off run", (_o, out) => {
    test.each(PROVIDERS)("%s", async (_name, answer) => {
      const baseline = await observed({}, {}, out);
      const seen = await observed(ON, await pair(summaryFake(answer)), out);
      expect(seen).toEqual(baseline);
      expect(JSON.stringify(seen)).not.toContain("SECRET");
    });
  });

  const MALFORMED: [string, unknown][] = [["a string", "yes"], ["an unknown member", { enabled: true, extra: 1 }], ["a non-boolean", { enabled: "yes" }]];
  test.each(MALFORMED)("a malformed switch (%s) reports nothing anywhere, and makes no call", async (_name, block) => {
    const baseline = await observed({});
    const fake = summaryFake();
    const seen = await observed({ aiSummary: block }, await pair(fake));
    expect(seen).toEqual(baseline);
    expect(fake.calls).toEqual([]);
    for (const text of ["summary-config-invalid", "AI summary", "aiSummary"]) expect(JSON.stringify(seen)).not.toContain(text);
  });
});

describe("one phase, one clock", () => {
  function recordPreparation() {
    const identity = spied(spyOn(pageVersion, "readPageIdentity")), prune = spied(spyOn(store, "pruneSummaryRecords"));
    return { identity, prune };
  }

  test.each([
    ["the default T", {}, [25_000, 30_000]],
    ["a shorter test T", { summaryTimeoutMs: 7_000 }, [2_000, 7_000]],
  ] as [string, Partial<RunDeps>, number[]][])("a frozen clock derives each real timer's delay: %s", async (_name, extra, delays) => {
    freshStateDir();
    const timers = watchTimers();
    await withConfig(ON, async () => run(true, deps({ ...(await pair(summaryFake())), summaryClock: () => 1_000, ...extra })));
    // The job's other timers (the store's, the transport's) are not armed through this seam.
    expect(timers.delays().slice(0, 2)).toEqual(delays);
    expect(timers.allCleared()).toBe(true);
  });

  test("the winner's shorter timeout beats the seam's T", async () => {
    freshStateDir();
    const timers = watchTimers();
    const fake = summaryFake();
    const seed = await testSeed();
    seed.winner = { ...seed.winner, timeoutMs: 6_000 } as typeof seed.winner;
    await withConfig(ON, () => run(true, deps({ summaryProvider: fake.provider, summaryTestSeed: seed, summaryClock: () => 1_000, summaryTimeoutMs: 7_000 })));
    expect(timers.delays().slice(0, 2)).toEqual([1_000, 6_000]);
  });

  test("delayed identity and prune come off the job's allowance: the provider starts with what remains", async () => {
    freshStateDir();
    let now = 1_000;
    const realIdentity = pageVersion.readPageIdentity;
    const { identity, prune } = recordPreparation();
    let atCall = -1;
    const fake = summaryFake(() => { atCall = now; return ANSWER("project:r"); });
    identity.mockImplementationOnce(async (p: string) => { now += 4_000; return realIdentity(p); });
    prune.mockImplementationOnce(async () => { now += 6_000; });
    await withConfig(ON, async () => run(true, deps({ ...(await pair(fake)), summaryClock: () => now })));
    expect(atCall).toBe(11_000);
    expect(fake.calls).toHaveLength(1);
  });

  test("preparation that alone consumes the work allowance: generation never starts, and no record is written", async () => {
    freshStateDir();
    let now = 1_000;
    const { prune } = recordPreparation();
    const fake = summaryFake();
    prune.mockImplementationOnce(async () => { now += 25_000; });
    const write = spied(spyOn(store, "writeSummaryRecord"));
    await withConfig(ON, async () => run(true, deps({ ...(await pair(fake)), summaryClock: () => now })));
    expect(fake.calls).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(summaryFiles()).toEqual([]);
  });

  const SHORT_T = 6_000;
  test.each([
    ["a never-resolving provider", () => new Promise<string>(() => {})],
    ["a throwing provider", () => { throw new Error("x"); }],
  ] as [string, () => Promise<string> | string][])("%s, after delayed preparation, ends the phase by T from before identity", async (_name, answer) => {
    const baseline = await observed({});
    let began = 0;
    const realIdentity = pageVersion.readPageIdentity;
    const realPrune = store.pruneSummaryRecords;
    const { identity, prune } = recordPreparation();
    identity.mockImplementation(async (p: string) => { began ||= performance.now(); await Bun.sleep(100); return realIdentity(p); });
    prune.mockImplementation(async (d, b) => { await Bun.sleep(100); return realPrune(d, b); });
    let returned = 0;
    const seen = await observed(ON, { ...(await pair(summaryFake(answer))), summaryTimeoutMs: SHORT_T });
    returned = performance.now();
    expect(seen).toEqual(baseline);
    expect(began).toBeGreaterThan(0);
    expect(returned - began).toBeLessThan(SHORT_T);
    expect(theRecord()).toMatchObject({ state: "unavailable", warnings: ["summary-unavailable"] });
  }, 12_000);
});

describe("the production path: the entry that produced the page", () => {
  // The fake answers the morning prompt with a briefing and the summary prompt with the JSON it asks for.
  const answersBoth = (dir: string, name = "fake-provider") => fakeCli(dir, name, `input=$(cat)
case "$input" in
  *goodMorningSentence*) printf '%s' '${ANSWER("project:r")}';;
  *) printf '${BRIEFING.replace(/\n/g, "\\n")}';;
esac`);

  test("a CLI winner gets exactly one more spawn, of the same entry, with no summary-only seam at all", async () => {
    freshStateDir();
    const dir = tempDir("dba-run-cli-");
    await withConfig({ ...ON, provider: { cli: answersBoth(dir), argv: [], promptVia: "stdin" } }, () => run(true, walkDeps() as RunDeps));
    expect(spawnsIn(dir)).toHaveLength(2);
    expect(theRecord()).toMatchObject({ state: "ready", revision: 1 });
  });

  test("a real subprocess summary adds zero stdout and stderr bytes", async () => {
    const state = freshStateDir();
    await withConfig({}, async (c) => {
      const runner = new URL("./helpers/summary-run-silent.ts", import.meta.url).pathname;
      const env = { ...process.env, HOME: tempDir("dba-run-child-home-"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
      const wallTime = String(Date.now());
      const child = () => Bun.spawnSync([process.execPath, runner, c.envelopePath, wallTime], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
      const off = child();
      expect(off.exitCode, off.stderr.toString()).toBe(0);
      expect(summaryFiles()).toEqual([]);
      const configPath = join(c.home, "daily-briefing", "config.json");
      const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      writeFileSync(configPath, JSON.stringify({ ...cfg, ...ON }));
      const on = child();
      expect(on.exitCode, on.stderr.toString()).toBe(0);
      expect(theRecord()).toMatchObject({ state: "ready", revision: 1 });
      expect(on.stdout).toEqual(off.stdout);
      expect(on.stderr).toEqual(off.stderr);
      expect(process.env.DAILY_BRIEFING_STATE_DIR).toBe(state);
    });
  }, 35_000);

  describe("a child that writes to stderr, in a real process", () => {
    const NOISE = "SUMMARY-CHILD-NOISE";
    const runner = new URL("./helpers/summary-run-silent.ts", import.meta.url).pathname;
    /** Not spawnSync: a loopback API has to answer from this process while the child runs. */
    async function child(envelopePath: string, wallTime: string) {
      const env = { ...process.env, HOME: tempDir("dba-run-child-home-"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
      const proc = Bun.spawn([process.execPath, runner, envelopePath, wallTime, "real-provider"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 25_000 });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout, stderr };
    }
    async function offThenOn(c: Captured) {
      const wallTime = String(Date.now());
      const off = await child(c.envelopePath, wallTime);
      expect(off.code, off.stderr).toBe(0);
      expect(summaryFiles()).toEqual([]);
      const configPath = join(c.home, "daily-briefing", "config.json");
      writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), ...ON }));
      const on = await child(c.envelopePath, wallTime);
      expect(on.code, on.stderr).toBe(0);
      expect(theRecord()).toMatchObject({ state: "ready", revision: 1 });
      expect(on.stdout + on.stderr).not.toContain(NOISE);
      expect(on.stdout).toBe(off.stdout);
      expect(on.stderr).toBe(off.stderr);
    }

    test("a CLI's own stderr, on --help and on the generation, reaches neither stream", async () => {
      freshStateDir();
      const dir = tempDir("dba-run-noisy-");
      const cli = join(dir, "claude");
      writeFileSync(cli, `#!/bin/sh
echo x >> '${dir}/ran'
echo ${NOISE} >&2
if [ "$1" = "--help" ]; then echo "--tools --setting-sources --strict-mcp-config --no-session-persistence"; exit 0; fi
input=$(cat)
case "$input" in
  *goodMorningSentence*) printf '%s' '${ANSWER("project:r")}';;
  *) printf '${BRIEFING.replace(/\n/g, "\\n")}';;
esac
`, { mode: 0o755 });
      await withConfig({ provider: { cli, argv: [], promptVia: "stdin" } }, async (c) => {
        await offThenOn(c);
        // The noisy child really ran for the summary: a --help and a generation more than the off run's pair.
        expect(readFileSync(join(dir, "ran"), "utf8").length / 2).toBe(6);
      });
    }, 60_000);

    test("an apiKeyCommand's stderr reaches neither stream", async () => {
      freshStateDir();
      const chat = (content: string) => okJson({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
      const s = await startFakeApi(chat(BRIEFING)); servers.push(s);
      s.setHandler(async (req) => chat(req.bodyText.includes("goodMorningSentence") ? ANSWER("project:r") : BRIEFING)(req));
      const dir = tempDir("dba-run-noisy-");
      const helper = join(dir, "helper");
      writeFileSync(helper, `#!/bin/sh\necho x >> '${dir}/ran'\necho ${NOISE} >&2\necho fixture-key\n`, { mode: 0o755 });
      await withConfig({ provider: { api: { kind: "openai-compatible", model: "llama3", baseUrl: `${s.origin}/v1`, apiKeyCommand: [helper] } } }, async (c) => {
        await offThenOn(c);
        // Once for the off run's morning, then the on run's morning and its summary.
        expect(readFileSync(join(dir, "ran"), "utf8").length / 2).toBe(3);
      });
    }, 60_000);
  });

  test("off: the morning's spawn only", async () => {
    freshStateDir();
    const dir = tempDir("dba-run-cli-");
    await withConfig({ provider: { cli: answersBoth(dir), argv: [], promptVia: "stdin" } }, () => run(true, walkDeps() as RunDeps));
    expect(spawnsIn(dir)).toHaveLength(1);
    expect(summaryFiles()).toEqual([]);
  });

  test("a fallback that won is the entry the summary uses; item 1 is not tried again", async () => {
    freshStateDir();
    const dir = tempDir("dba-run-cli-"), first = tempDir("dba-run-cli-");
    const cfg = { ...ON, provider: { cli: fakeCli(first, "failing-cli", "exit 1"), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Backup", cli: answersBoth(dir, "backup-cli"), argv: [], promptVia: "stdin" }] };
    await withConfig(cfg, () => run(true, walkDeps() as RunDeps));
    const firstSpawns = spawnsIn(first).length;
    expect(firstSpawns).toBeGreaterThanOrEqual(1);
    expect(spawnsIn(dir)).toHaveLength(2);
    expect(theRecord()).toMatchObject({ state: "ready" });
  });

  describe("an API winner with a key helper", () => {
    const chat = (content: string) => okJson({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    async function apiWinner(answer: string) {
      const s = await startFakeApi(chat(answer)); servers.push(s);
      const dir = tempDir("dba-run-key-");
      const helper = join(dir, "helper");
      writeFileSync(helper, `#!/bin/sh\necho x >> '${dir}/ran'\necho fixture-key\n`, { mode: 0o755 });
      s.setHandler(async (req) => {
        const summary = req.bodyText.includes("goodMorningSentence");
        return chat(summary ? ANSWER("project:r") : answer)(req);
      });
      return { s, provider: { api: { kind: "openai-compatible", model: "llama3", baseUrl: `${s.origin}/v1`, apiKeyCommand: [helper] } }, ran: () => existsSync(join(dir, "ran")) ? readFileSync(join(dir, "ran"), "utf8").length / 2 : 0 };
    }

    test("delivered and on: the helper runs afresh, once for the morning and once for the summary", async () => {
      freshStateDir();
      const w = await apiWinner(BRIEFING);
      await withConfig({ ...ON, provider: w.provider }, () => run(true, walkDeps() as RunDeps));
      expect(w.ran()).toBe(2);
      expect(w.s.requests).toHaveLength(2);
      expect(theRecord()).toMatchObject({ state: "ready" });
    });

    test("what reaches the request: no computer name and no key file path, while the saved page keeps both", async () => {
      freshStateDir();
      const s = await startFakeApi(chat(BRIEFING)); servers.push(s);
      s.setHandler(async (req) => chat(req.bodyText.includes("goodMorningSentence") ? ANSWER("project:r") : BRIEFING)(req));
      const dir = tempDir("dba-run-key-");
      const keyFile = join(dir, "PRIVATE-KEY-FILE.key");
      writeFileSync(keyFile, "fixture-key", { mode: 0o644 });
      chmodSync(keyFile, 0o644);
      const block = { api: { kind: "openai-compatible", model: "llama3", baseUrl: `${s.origin}/v1`, apiKeyFile: keyFile, apiKey: "literal-fixture" } };
      await withConfig({ ...ON, provider: block }, () => run(true, walkDeps() as RunDeps));
      const page = readFileSync(marker.latestBriefingPath(), "utf8");
      expect(page).toContain(hostname());                  // the premise: both are on the page the run saved
      expect(page).toContain("PRIVATE-KEY-FILE");
      const summaryBodies = s.requests.map((r) => r.bodyText).filter((b) => b.includes("goodMorningSentence"));
      expect(summaryBodies).toHaveLength(1);
      expect(summaryBodies[0]).not.toContain("this machine: ");
      expect(summaryBodies[0]).not.toContain(hostname());
      expect(summaryBodies[0]).not.toContain("PRIVATE-KEY-FILE");
      expect(page).toContain("generated via");
      expect(summaryBodies[0]).not.toContain("generated via");
      expect(theRecord()).toMatchObject({ state: "ready", pageHash: createHash("sha256").update(readFileSync(marker.latestBriefingPath())).digest("hex") });
    });

    test("off: the morning's run of the helper only", async () => {
      freshStateDir();
      const w = await apiWinner(BRIEFING);
      await withConfig({ provider: w.provider }, () => run(true, walkDeps() as RunDeps));
      expect(w.ran()).toBe(1);
    });

    test("quiet: the helper never runs", async () => {
      freshStateDir();
      const w = await apiWinner(BRIEFING);
      await withConfig({ ...ON, repos: [], provider: w.provider }, () => run(true, walkDeps() as RunDeps));
      expect(w.ran()).toBe(0);
      expect(w.s.requests).toEqual([]);
    });

    test("not delivered: no summary run of the helper", async () => {
      freshStateDir();
      const w = await apiWinner("No briefing today.");
      await withConfig({ ...ON, provider: w.provider }, () => run(true, walkDeps() as RunDeps));
      expect(w.ran()).toBe(1);
      expect(summaryFiles()).toEqual([]);
    });
  });
});

// The real calendar step, through `run()`, to what the real spawn received: the job's own tests start from a built seed,
// so only this shows the capture and the lock state surviving the whole way (A2 :32-42).
describe("a real calendar step through run() to the real spawn", () => {
  const LOCKED_HELP = "--tools --setting-sources --strict-mcp-config --no-session-persistence";
  const UNLOCKED_HELP = "--setting-sources --strict-mcp-config";
  /** Answers the nth --help with the nth text (the last repeats), and keeps each generation's stdin in order. */
  function capturingCli(helps: string[]) {
    const dir = tempDir("dba-run-capture-");
    helps.forEach((help, i) => writeFileSync(join(dir, `help.${i}`), help));
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh
if [ "$1" = "--help" ]; then
  n=$(ls '${dir}' | grep -c '^asked\\.')
  : > '${dir}'/asked.$n
  [ -f '${dir}'/help.$n ] || n=${helps.length - 1}
  cat '${dir}'/help.$n
  exit 0
fi
n=$(ls '${dir}' | grep -c '^stdin\\.')
cat > '${dir}'/stdin.$n
if grep -q goodMorningSentence '${dir}'/stdin.$n; then printf '%s' '${ANSWER("project:r")}'; else printf '${BRIEFING.replace(/\n/g, "\\n")}'; fi
`, { mode: 0o755 });
    const sent = () => readdirSync(dir).filter((n) => n.startsWith("stdin.")).sort().map((n) => readFileSync(join(dir, n), "utf8"));
    return { path, sent };
  }
  async function runWith(helps: string[]) {
    freshStateDir();
    const cli = capturingCli(helps);
    const noon = new Date(); noon.setHours(12, 0, 0, 0);                  // the event is always today
    const code = await withConfig({ ...ON, provider: { cli: cli.path, argv: [], promptVia: "stdin" } },
      () => run(true, walkDeps({ calendar: calendarStep({}, noon.getTime()) }) as RunDeps));
    expect(code).toBe(0);
    const page = readFileSync(marker.latestBriefingPath(), "utf8");
    expect(page).toContain(MEETING_SENTINELS[0]!);                         // the premise: the saved page names the meeting
    expect(page).toContain(CALENDAR_HEADING);
    return { sent: cli.sent(), page };
  }

  test("locked morning, locked summary: the saved page's meeting text reaches the spawn", async () => {
    const { sent, page } = await runWith([LOCKED_HELP]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("goodMorningSentence");
    const section = page.slice(page.indexOf(CALENDAR_HEADING), page.indexOf("▶ Suggested next"));
    expect(sent[1]).toContain(section);
    expect(sent[1]).toContain(MEETING_SENTINELS[0]!);
    expect(sent[1]).toContain("A meeting may be named in the sentence only exactly as the page below shows it.");
    expect(sent[1]).not.toContain("this machine: ");
    expect(theRecord()).toMatchObject({ state: "ready" });
  }, 30_000);

  test("unlocked morning, unlocked summary: schedule shape only, with no meeting detail", async () => {
    const { sent, page } = await runWith([UNLOCKED_HELP]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("goodMorningSentence");
    for (const prompt of sent) for (const sentinel of MEETING_SENTINELS) expect(prompt).not.toContain(sentinel);
    expect(sent[1]).toContain(CALENDAR_HEADING);
    expect(sent[1]).toMatch(/\d\d:\d\d.*busy/);
    expect(sent[1]).toContain("Name no meetings");
    expect(page).toContain(MEETING_SENTINELS[0]!);                         // the saved page was not rewritten
    expect(theRecord()).toMatchObject({ state: "ready" });
  }, 30_000);

  test("locked morning, then an unlocked summary: no generation, and nothing of the page leaves", async () => {
    const { sent } = await runWith([LOCKED_HELP, UNLOCKED_HELP]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("goodMorningSentence");
    expect(theRecord()).toMatchObject({ state: "unavailable", warnings: ["summary-unavailable"] });
  }, 30_000);
});

// A2-M5-T17 (A2 :108): by the discipline of test/calendar-off.golden.test.ts:1: a pinned clock, literal commit dates, git's
// global and system config off, and only run-specific paths replaced by named placeholders, with nothing else normalised.
// No snapshot is recorded here. The baseline is a run with the key absent and no summary seam, the path whose prompt,
// envelope and audit the frozen calendar-off goldens hold, so the two files tie every switch state to those bytes.
describe("off, absent and on against a disabled baseline, byte for byte (A2 :108)", () => {
  const PIN = new Date("2026-09-16T18:00:00.000Z");
  const PIN_DATE = "2026-09-16";
  const YESTERDAY = "2026-09-15";
  const E2E_TIMEOUT = 60_000;
  // `echo` as the audit's judge, prompt as an argument: the report's judge section is then the exact prompt it was sent.
  // The morning itself runs on the injected provider below.
  const ECHO_JUDGE = { cli: "echo", argv: [], promptVia: "arg", harden: false };

  /** Git's global and system config off, for building the repo and for each run. Undone by assignment or deletion. */
  async function gitConfigOff<T>(body: () => Promise<T>): Promise<T> {
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL, prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try { return await body(); }
    finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
    }
  }

  /** Each path in both its given and its resolved spelling (macOS `/var` vs `/private/var`), longest first. */
  function named(pairs: [string, string][]): (s: string) => string {
    const all = pairs.flatMap(([path, name]): [string, string][] => [[realpathSync(path), name], [path, name]]);
    all.sort((a, b) => b[0].length - a[0].length);
    return (s) => all.reduce((text, [path, name]) => text.split(path).join(name), s);
  }

  /** Every file the run and the audit left in the state folder, except the summary's own sidecars. */
  function stateFiles(state: string, clean: (s: string) => string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const entry of readdirSync(state, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || entry.name.includes(".summary.")) continue;
      const path = join(entry.parentPath, entry.name);
      files[clean(path)] = clean(readFileSync(path, "utf8"));
    }
    return files;
  }

  let morningRepo = "";
  async function morning(block: unknown, summary?: ReturnType<typeof summaryFake>) {
    const state = freshStateDir();
    const prompts: string[] = [];
    const provider: Provider = { generate: async (prompt) => { prompts.push(prompt); return BRIEFING; } };
    const cfg = {
      repos: [morningRepo], excludeCommitPatterns: [], lookbackCapDays: 30, author: { emails: ["test@example.com"] }, provider: ECHO_JUDGE,
      ...(block === undefined ? {} : { aiSummary: block }),
    };
    return gitConfigOff(() => withConfig(cfg, async (c) => {
      setSystemTime(PIN);
      try {
        const seam = summary === undefined ? {} : await pair(summary);
        const code = await run(true, deps({ provider, now: () => PIN, ...seam }), { json: true });
        const clean = named([[state, "{{STATE_DIR}}"], [c.home, "{{CONFIG_DIR}}"]]);
        const stdout = c.stdout.splice(0).map(clean), stderr = c.stderr.splice(0).map(clean);
        // Run last, over what the run left behind: the sidecar, on an on day, is beside the page by now.
        await auditMain([marker.latestBriefingPath()]);
        return {
          report: {
            code, stdout, stderr, mainPrompts: prompts.map(clean),
            page: clean(readFileSync(marker.latestBriefingPath(), "utf8")),
            archive: clean(readFileSync(join(briefingsDir(), `${PIN_DATE}.md`), "utf8")),
            marker: readFileSync(marker.markerPath(), "utf8"),
            audit: clean(c.stdout.join("\n")), auditStderr: c.stderr.map(clean),
            files: stateFiles(state, clean),
          },
          sidecars: summaryFiles().filter((name) => name.endsWith(".summary.json")),
          record: summaryFiles().length > 0 ? theRecord() : null,
        };
      } finally { setSystemTime(); }
    }));
  }

  let baseline: Awaited<ReturnType<typeof morning>>;
  beforeAll(async () => {
    await gitConfigOff(async () => {
      morningRepo = await buildRepo([{ file: "src/parser.ts", content: "export const parse = (s: string) => s;\n", isoDate: `${YESTERDAY}T10:00:00Z` }]);
      await commitFiles(morningRepo, ["src/parser.ts"], { message: "fix(parser): handle empty input", isoDate: `${YESTERDAY}T11:00:00Z`, content: "export const parse = (s: string) => s ?? '';\n" });
      await commitFiles(morningRepo, ["src/today.ts"], { message: "feat: same-day morning work", isoDate: `${PIN_DATE}T09:00:00Z` });
      writeFileSync(join(morningRepo, "notes.md"), "draft\n");
    });
    baseline = await morning(undefined);
  }, E2E_TIMEOUT);
  afterEach(() => { setSystemTime(); });

  test("the baseline is a real delivered morning, and reading it twice gives the same bytes", async () => {
    const { report } = baseline;
    expect(report.code).toBe(0);
    expect(report.stdout).toHaveLength(1);
    expect(JSON.parse(report.stdout[0]!).delivered).toBe(true);
    expect(report.mainPrompts).toHaveLength(1);
    expect(report.mainPrompts[0]).toContain("fix(parser): handle empty input");
    expect(report.marker.trim()).toBe(PIN_DATE);
    expect(report.archive).toBe(report.page);
    expect(cards.summaryCardsFromPage(report.page).length).toBeGreaterThan(0);   // an on run has a card to summarise
    expect(report.audit).toContain("You are an ADVERSARIAL evaluator");
    expect(report.audit).toContain("resume here");                               // the page reached the judge
    expect(report.audit).toContain("fix(parser): handle empty input");           // so did the git ground truth
    expect(baseline.sidecars).toEqual([]);
    expect((await morning(undefined)).report).toEqual(report);
  }, E2E_TIMEOUT);

  test.each([
    ["absent, with the seam held", undefined],
    ["{}", {}],
    ["enabled: false", { enabled: false }],
    ["a malformed switch", { enabled: "yes" }],
  ] as [string, unknown][])("off, %s: the same bytes, no call and no sidecar", async (_name, block) => {
    const fake = summaryFake();
    const seen = await morning(block, fake);
    expect(fake.calls).toEqual([]);
    expect(seen.sidecars).toEqual([]);
    expect(seen.report).toEqual(baseline.report);
  }, E2E_TIMEOUT);

  test.each([
    ["an answer", undefined, "ready"],
    ["a provider that fails", () => { throw new Error("provider SECRET"); }, "unavailable"],
  ] as [string, ((call: Call) => string) | undefined, string][])("on, %s: the same bytes, beside the summary's one call and its sidecar", async (_name, answer, state) => {
    const fake = summaryFake(answer);
    const seen = await morning(ON.aiSummary, fake);
    expect(fake.calls).toHaveLength(1);
    expect(seen.sidecars).toHaveLength(1);
    expect(seen.record).toMatchObject({ state, pageDate: PIN_DATE });
    expect(seen.report).toEqual(baseline.report);
  }, E2E_TIMEOUT);
});
