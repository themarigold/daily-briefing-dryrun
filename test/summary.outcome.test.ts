// test/summary.outcome.test.ts — A2-M3-T8: what the delivered run carries for the AI summary. `runCore`'s private
// `summarySeed` (the winning entry, its actual lock state, the morning calendar capture) and `runBriefing`'s
// switch-gated preparation (one phase clock, identity capture, same-day pruning), which runs after the delivered
// envelope, while the run lock is held, and can change nothing the run reports.
import "./fixtures/isolate-state";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runCore, type RunDeps as CoreDeps } from "../src/core";
import { briefingsDir, envelopeFrom } from "../src/json";
import { runBriefing, type RunDeps, type RunOutput } from "../src/main";
import * as marker from "../src/marker";
import * as notifyModule from "../src/notify";
import { renderBriefing } from "../src/render";
import { buildCalendarPromptBlocks } from "../src/calendar/prompt";
import * as pageVersion from "../src/summary/page-version";
import * as store from "../src/summary/store";
import * as factory from "../src/providerFactory";
import { ProviderError, type Config, type PromptVariant, type Provider } from "../src/types";
import { accountStatePath, PROBE_MS } from "../src/account";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
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
afterEach(async () => {
  while (spies.length) spies.pop()!.mockRestore();
  while (servers.length) await servers.pop()!.stop();
});
function spied<S extends { mockRestore(): void }>(spy: S): S { spies.push(spy); return spy; }

const INJECTED: Provider = { generate: async () => BRIEFING };
/** The config needs a provider block; with an injected provider it is never built. */
const UNUSED_PROVIDER = { cli: "/nonexistent/never-spawned", argv: [], promptVia: "stdin" };
/** An owned CLI winner whose short timeout gives T = 6 500 ms: 1 500 ms of work, so a hang ends quickly. */
const SHORT_TIMEOUT_MS = 6_500;
const WORK_MS = SHORT_TIMEOUT_MS - 5_000;
const shortCli = (dir: string) => ({ cli: fakeCli(dir), argv: [], promptVia: "stdin", timeoutMs: SHORT_TIMEOUT_MS });

type Captured = { stdout: string[]; stderr: string[]; envelopePath: string };
async function withConfig<T>(cfg: Record<string, unknown>, fn: (c: Captured) => Promise<T>): Promise<T> {
  const home = tempDir("dba-outcome-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], provider: UNUSED_PROVIDER, ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
  const stdout: string[] = [], stderr: string[] = [];
  const realErr = console.error, realLog = console.log;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { stdout.push(a.map(String).join(" ")); };
  try { return await fn({ stdout, stderr, envelopePath: join(home, "envelope.json") }); }
  finally { console.error = realErr; console.log = realLog; }
}
const injectedDeps = (extra: Partial<RunDeps> = {}): RunDeps => walkDeps({ provider: INJECTED, ...extra }) as RunDeps;
const today = () => marker.localDateStr(new Date());
const hex = (c: string) => c.repeat(64);
const sidecarName = (date: string, h: string, v: string) => `${date}.${hex(h)}.${hex(v)}.summary.json`;
function placeSidecars(date: string): { name: string; path: string; bytes: string }[] {
  mkdirSync(briefingsDir(), { recursive: true });
  return [sidecarName(date, "a", "b"), sidecarName("2001-01-02", "c", "d")].map((name) => {
    const path = join(briefingsDir(), name), bytes = `old ${name}`;
    writeFileSync(path, bytes);
    return { name, path, bytes };
  });
}
/** Identity and prune recorded, each still doing its real work unless a test replaces it. */
function recordPreparation() {
  const realIdentity = pageVersion.readPageIdentity, realPrune = store.pruneSummaryRecords;
  return {
    identity: spied(spyOn(pageVersion, "readPageIdentity")),
    prune: spied(spyOn(store, "pruneSummaryRecords")),
    realIdentity, realPrune,
  };
}

/** Watch every timer armed after the notification, the last await between the stamp and the preparation, at any delay.
 *  `afterNotify` is the test's own change to the state at that moment. */
function watchPhaseTimers(afterNotify: () => void = () => {}) {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const armed: { delay: number | undefined; handle: ReturnType<typeof setTimeout> }[] = [];
  const cleared = new Set<unknown>();
  let watching = false;
  spied(spyOn(notifyModule, "notify")).mockImplementation(async () => { watching = true; afterNotify(); return true; });
  spied(spyOn(globalThis, "setTimeout")).mockImplementation(((fn: () => void, ms?: number) => {
    const handle = realSet(fn, ms);
    if (watching) armed.push({ delay: ms, handle });
    return handle;
  }) as unknown as typeof setTimeout);
  spied(spyOn(globalThis, "clearTimeout")).mockImplementation(((handle: ReturnType<typeof setTimeout>) => {
    cleared.add(handle);
    return realClear(handle);
  }) as typeof clearTimeout);
  return {
    delays: () => armed.map((a) => a.delay),
    handles: () => armed.map((a) => a.handle),
    allCleared: () => armed.every((a) => cleared.has(a.handle)),
  };
}

describe("off: no clock, no identity, no prune, no sidecar", () => {
  const OFF: [string, Record<string, unknown>][] = [
    ["absent", {}], ["{}", { aiSummary: {} }], ["enabled: false", { aiSummary: { enabled: false } }],
    ["a string", { aiSummary: "yes" }], ["a non-boolean switch", { aiSummary: { enabled: "yes" } }],
    ["an unknown member beside enabled: true", { aiSummary: { enabled: true, extra: 1 } }],
  ];
  test.each(OFF)("%s", async (_name, block) => {
    freshStateDir();
    const before = placeSidecars(today());
    const stats = before.map((s) => statSync(s.path).mtimeMs);
    const { identity, prune } = recordPreparation();
    const write = spied(spyOn(store, "writeSummaryRecord"));
    const clock = spied(spyOn(globalThis, "AbortController"));
    const outcome = await withConfig(block, () => runBriefing(true, injectedDeps(), {}));
    expect(outcome).toEqual({ code: 0, delivered: true, aiSummaryEnabled: false });
    for (const s of [identity, prune, write, clock]) expect(s).not.toHaveBeenCalled();
    expect(readdirSync(briefingsDir()).filter((n) => n.includes(".summary.")).sort()).toEqual(before.map((s) => s.name).sort());
    before.forEach((s, i) => {
      expect(readFileSync(s.path, "utf8")).toBe(s.bytes);
      expect(statSync(s.path).mtimeMs).toBe(stats[i]!);
    });
  });

  test("a run that does not deliver carries no switch and prepares nothing", async () => {
    freshStateDir();
    const { identity, prune } = recordPreparation();
    const dir = tempDir("dba-outcome-");
    const outcome = await withConfig({ aiSummary: { enabled: true }, provider: { cli: fakeCli(dir, "prose", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" } },
      () => runBriefing(true, walkDeps() as RunDeps, {}));
    expect(outcome).toEqual({ code: 1, delivered: false });
    expect(identity).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });
});

describe("on: preparation runs after the delivered envelope, with the run lock held", () => {
  test("the outcome carries the page, its date and the delivered file's identity, under one clock", async () => {
    freshStateDir();
    const events: string[] = [];
    const { identity, prune, realIdentity, realPrune } = recordPreparation();
    const holdsLock = () => JSON.parse(readFileSync(join(marker.supportDir(), "run.lock"), "utf8")).pid === process.pid;
    let envelopeAtIdentity: Record<string, unknown> | undefined;
    const timers = watchPhaseTimers();
    const outcome = await withConfig({ aiSummary: { enabled: true } }, async (c) => {
      identity.mockImplementation(async (p: string) => {
        events.push(`identity lock=${holdsLock()}`);
        envelopeAtIdentity = JSON.parse(readFileSync(c.envelopePath, "utf8"));
        return realIdentity(p);
      });
      prune.mockImplementation(async (d, b) => { events.push(`prune lock=${holdsLock()}`); return realPrune(d, b); });
      return runBriefing(true, injectedDeps(), { jsonOut: c.envelopePath });
    });
    expect(events).toEqual(["identity lock=true", "prune lock=true"]);
    expect(envelopeAtIdentity?.delivered).toBe(true);
    expect(existsSync(join(marker.supportDir(), "run.lock"))).toBe(false);          // released once it returned
    expect(outcome.code).toBe(0);
    expect(outcome.aiSummaryEnabled).toBe(true);

    const s = outcome.summary!;
    expect(s.page).toBe(readFileSync(marker.latestBriefingPath(), "utf8"));
    expect(s.date).toBe(readFileSync(marker.markerPath(), "utf8").trim());
    expect(s.identity).toEqual((await realIdentity(marker.latestBriefingPath()))!);
    expect(prune.mock.calls[0]![1]).toEqual({ pageDate: s.date, ...s.identity });
    expect(identity.mock.calls[0]![0]).toBe(marker.latestBriefingPath());
    expect(s.emptyWindow).toBe(false);
    expect(s.seed).toBeUndefined();                                                  // an injected main provider
    expect(s.deadline - s.startedAt).toBeCloseTo(30_000, 3);
    expect(s.workCutoff - s.startedAt).toBeCloseTo(25_000, 3);
    expect(s.controller.signal.aborted).toBe(false);
    // One timer, which never holds the process open and is cleared by aborting the carried controller.
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.handles()[0]!.hasRef()).toBe(false);
    expect(timers.allCleared()).toBe(false);
    // The prune is told to stop once the phase has ended.
    const stop = prune.mock.calls[0]![2]!;
    expect(stop()).toBe(false);
    s.controller.abort();
    expect(timers.allCleared()).toBe(true);
    expect(stop()).toBe(true);
  });

  test("an ordinary delivered page matches its identity, multi-byte text included, so the check refuses nothing here", async () => {
    freshStateDir();
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    const s = outcome.summary!;
    s.controller.abort();
    expect(s.page).toContain("☀️");
    expect(s.identity.pageHash).toBe(createHash("sha256").update(readFileSync(marker.latestBriefingPath())).digest("hex"));
  });

  test("the sidecar date is the marker's, not the injected clock's", async () => {
    freshStateDir();
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () =>
      runBriefing(true, injectedDeps({ now: () => new Date("2001-02-03T12:00:00") }), {}));
    const s = outcome.summary!;
    s.controller.abort();
    expect(s.date).toBe(readFileSync(marker.markerPath(), "utf8").trim());
    expect(s.date).toBe(today());
  });

  test("the clock starts only after the envelope's write has finished", async () => {
    freshStateDir();
    const realWrite = Bun.write;
    let written = 0;
    const outcome = await withConfig({ aiSummary: { enabled: true } }, async (c) => {
      const w = spied(spyOn(Bun, "write"));
      w.mockImplementation((async (...a: Parameters<typeof Bun.write>) => {
        const n = await realWrite(...a);
        if (a[0] === c.envelopePath) { await Bun.sleep(50); written = performance.now(); }
        return n;
      }) as typeof Bun.write);
      return runBriefing(true, injectedDeps(), { jsonOut: c.envelopePath });
    });
    expect(written).toBeGreaterThan(0);
    expect(outcome.summary!.startedAt).toBeGreaterThanOrEqual(written);
    outcome.summary!.controller.abort();
  });

  test("T is the winner's shorter timeout, never a longer one", async () => {
    const dir = tempDir("dba-outcome-");
    for (const [timeoutMs, whole, work] of [[SHORT_TIMEOUT_MS, SHORT_TIMEOUT_MS, WORK_MS], [60_000, 30_000, 25_000]] as const) {
      freshStateDir();
      const outcome = await withConfig({ aiSummary: { enabled: true }, provider: { ...shortCli(dir), timeoutMs } },
        () => runBriefing(true, walkDeps() as RunDeps, {}));
      const s = outcome.summary!;
      expect(s.deadline - s.startedAt).toBeCloseTo(whole, 3);
      expect(s.workCutoff - s.startedAt).toBeCloseTo(work, 3);
      expect(s.seed?.winner.timeoutMs).toBe(timeoutMs);
      s.controller.abort();
    }
  });

  test("a same-day --force gives a new identity, and prunes the record of the page it replaced", async () => {
    freshStateDir();
    const first = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    const old = first.summary!;
    old.controller.abort();
    const oldRecord = join(briefingsDir(), `${old.date}.${old.identity.pageHash}.${old.identity.pageVersion}.summary.json`);
    writeFileSync(oldRecord, "{}");
    const second = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    const next = second.summary!;
    next.controller.abort();
    expect(next.identity.pageVersion).not.toBe(old.identity.pageVersion);
    expect(next.identity).toEqual((await pageVersion.readPageIdentity(marker.latestBriefingPath()))!);
    expect(existsSync(oldRecord)).toBe(false);
  });

  test("an off run leaves the old sidecars, and the next enabled delivery prunes only the same-day one", async () => {
    freshStateDir();
    const [sameDay, otherDay] = placeSidecars(today());
    await withConfig({}, () => runBriefing(true, injectedDeps(), {}));
    expect(existsSync(sameDay!.path)).toBe(true);
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    outcome.summary!.controller.abort();
    expect(existsSync(sameDay!.path)).toBe(false);
    expect(readFileSync(otherDay!.path, "utf8")).toBe(otherDay!.bytes);
  });

  test("a quiet delivery still prunes, under 30 000 ms, with no seed and no pending record", async () => {
    freshStateDir();
    const [sameDay] = placeSidecars(today());
    const dir = tempDir("dba-outcome-");
    const write = spied(spyOn(store, "writeSummaryRecord"));
    const outcome = await withConfig({ repos: [], aiSummary: { enabled: true }, provider: shortCli(dir) }, () => runBriefing(true, walkDeps() as RunDeps, {}));
    const s = outcome.summary!;
    expect(outcome.delivered).toBe(true);
    expect(s.emptyWindow).toBe(true);
    expect(s.seed).toBeUndefined();
    expect(s.deadline - s.startedAt).toBeCloseTo(30_000, 3);
    expect(existsSync(sameDay!.path)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(spawnsIn(dir)).toEqual([]);
    s.controller.abort();
  });

  test.each([
    ["a date other than the run's", "2001-01-01\n"],
    ["a malformed marker", "not a date\n"],
  ])("%s: the marker is what both readers recover the date from, so nothing is prepared", async (_name, text) => {
    freshStateDir();
    const { identity, prune } = recordPreparation();
    const timers = watchPhaseTimers(() => writeFileSync(marker.markerPath(), text));
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    expect(outcome).toEqual({ code: 0, delivered: true, aiSummaryEnabled: true });
    expect(identity).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.allCleared()).toBe(true);
  });

  test("no reliable identity (Windows' answer too): nothing is pruned, nothing is prepared", async () => {
    freshStateDir();
    const [sameDay] = placeSidecars(today());
    const { identity, prune } = recordPreparation();
    identity.mockResolvedValue(null);
    const timers = watchPhaseTimers();
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    expect(outcome.summary).toBeUndefined();
    expect(outcome.aiSummaryEnabled).toBe(true);
    expect(prune).not.toHaveBeenCalled();
    expect(existsSync(sameDay!.path)).toBe(true);
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.allCleared()).toBe(true);
  });
});

describe("one phase allowance: delay spends it, expiry ends it", () => {
  test("delayed identity and prune reduce the same carried allowance, and the armed timer still fires on time", async () => {
    freshStateDir();
    const dir = tempDir("dba-outcome-");
    const { identity, prune, realIdentity, realPrune } = recordPreparation();
    identity.mockImplementation(async (p: string) => { await Bun.sleep(200); return realIdentity(p); });
    prune.mockImplementation(async (d, b) => { await Bun.sleep(200); return realPrune(d, b); });
    const outcome = await withConfig({ aiSummary: { enabled: true }, provider: shortCli(dir) }, () => runBriefing(true, walkDeps() as RunDeps, {}));
    const returned = performance.now();
    const s = outcome.summary!;
    expect(returned - s.startedAt).toBeGreaterThanOrEqual(400);
    expect(s.workCutoff - s.startedAt).toBeCloseTo(WORK_MS, 3);                      // not restarted after the delays
    expect(s.controller.signal.aborted).toBe(false);
    await Bun.sleep(Math.max(0, s.workCutoff - performance.now()) + 100);
    expect(s.controller.signal.aborted).toBe(true);                                  // armed before the capture, carried
  }, 20_000);

  test("expiry during capture: no summary, one timer, and the late answer goes nowhere", async () => {
    freshStateDir();
    const dir = tempDir("dba-outcome-");
    const { identity, prune, realIdentity } = recordPreparation();
    identity.mockImplementation(async (p: string) => { await Bun.sleep(WORK_MS + 300); return realIdentity(p); });
    const timers = watchPhaseTimers();
    const outcome = await withConfig({ aiSummary: { enabled: true }, provider: shortCli(dir) }, (c) =>
      runBriefing(true, walkDeps() as RunDeps, { jsonOut: c.envelopePath }));
    expect(outcome).toEqual({ code: 0, delivered: true, aiSummaryEnabled: true });
    expect(timers.delays()).toEqual([WORK_MS]);
    expect(timers.allCleared()).toBe(true);
    expect(spawnsIn(dir)).toHaveLength(1);                                           // the morning's, no summary call
    await Bun.sleep(500);                                                            // the late identity has resolved
    expect(prune).not.toHaveBeenCalled();
  }, 20_000);
});

describe("preparation, whatever becomes of it, changes nothing the run reports", () => {
  type Seen = { code: number; delivered: boolean; stdout: string[]; stderr: string[]; envelope: string; marker: string; page: string; notified: unknown[] };
  type Observed = { seen: Seen; carried: boolean; phaseMs: number };
  /** One delivered run in fresh state and config folders, with every channel it reports on read back. Those two paths
   *  and the clock's reading are the only things two runs may differ by. `carried` and `phaseMs` (notification to
   *  return, so the morning's own spawn is outside it) sit beside what is compared. */
  async function observe(dir: string, on: boolean, out: (c: Captured) => RunOutput, afterNotify: () => void = () => {}, timeoutMs = SHORT_TIMEOUT_MS): Promise<Observed> {
    const state = freshStateDir();
    const realNotify = notifyModule.notify;
    const notified: unknown[] = [];
    let notifiedAt = 0;
    const n = spyOn(notifyModule, "notify").mockImplementation(async (...a: Parameters<typeof realNotify>) => {
      notified.push(a[1]);
      afterNotify();
      notifiedAt = performance.now();
      return true;
    });
    try {
      return await withConfig({ provider: { ...shortCli(dir), timeoutMs }, ...(on ? { aiSummary: { enabled: true } } : {}) }, async (c) => {
        const { code, delivered, summary } = await runBriefing(true, walkDeps() as RunDeps, out(c));
        const phaseMs = performance.now() - notifiedAt;
        summary?.controller.abort();
        // The net gate times itself before any preparation: a 1 ms wait sets `waitedMs` and adds its "waited" line.
        const stable = (s: string) => s.replaceAll(state, "<state>").replaceAll(dirname(c.envelopePath), "<config>").replaceAll(/\b\d{1,2}:\d{2}\b/g, "<hh:mm>").replaceAll(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<iso>").replaceAll(/"waitedMs":\d+/g, '"waitedMs":"<ms>"');
        const stableAll = (l: string[]) => l.filter((line) => !/^waited ~\d+s for the network/.test(line)).map(stable);
        return {
          carried: summary !== undefined, phaseMs,
          seen: {
            code, delivered, stdout: stableAll(c.stdout), stderr: stableAll(c.stderr),
            envelope: existsSync(c.envelopePath) ? stable(readFileSync(c.envelopePath, "utf8")) : "",
            marker: readFileSync(marker.markerPath(), "utf8"), page: stable(readFileSync(marker.latestBriefingPath(), "utf8")),
            notified: JSON.parse(stable(JSON.stringify(notified))),
          },
        };
      });
    } finally { n.mockRestore(); }
  }
  const NEVER = () => new Promise<never>(() => {});
  /** Only the preparation's re-read of the marker: the morning's own read (the outage line) comes before the notification. */
  const markerReadFails = (read: () => Promise<string | undefined>) => (): (() => void) => {
    const real = marker.readLastRunDate;
    let preparing = false;
    spied(spyOn(marker, "readLastRunDate")).mockImplementation(() => preparing ? read() : real());
    return () => { preparing = true; };
  };
  const ROWS: [string, (p: ReturnType<typeof recordPreparation>) => void | (() => void), "fails" | "hangs" | "succeeds"][] = [
    ["a throwing marker re-read", markerReadFails(async () => { throw new Error("marker SECRET"); }), "fails"],
    ["a never-resolving marker re-read", markerReadFails(NEVER), "hangs"],
    ["a throwing identity capture", (p) => { p.identity.mockImplementation(async () => { throw new Error("identity SECRET"); }); }, "fails"],
    ["an identity capture that throws synchronously", (p) => { p.identity.mockImplementation((() => { throw new Error("identity SECRET"); }) as never); }, "fails"],
    ["a never-resolving identity capture", (p) => { p.identity.mockImplementation(NEVER); }, "hangs"],
    ["a throwing prune", (p) => { p.prune.mockImplementation(async () => { throw new Error("prune SECRET"); }); }, "fails"],
    ["a never-resolving prune", (p) => { p.prune.mockImplementation(NEVER); }, "hangs"],
    ["a preparation that succeeds", () => {}, "succeeds"],
  ];
  const OUTS: [string, (c: Captured) => RunOutput][] = [
    ["--json-out", (c) => ({ jsonOut: c.envelopePath })],
    ["--json", () => ({ json: true })],
  ];
  describe.each(OUTS)("%s", (_outName, out) => {
    test.each(ROWS)("%s", async (_name, arrange, kind) => {
      const dir = tempDir("dba-outcome-");
      const baseline = await observe(dir, false, out);
      const p = recordPreparation();
      const afterNotify = arrange(p) ?? undefined;
      const run = await observe(dir, true, out, afterNotify);
      expect(run.seen).toEqual(baseline.seen);
      expect(baseline.seen.delivered).toBe(true);
      expect(JSON.stringify(run.seen)).not.toContain("SECRET");
      expect(run.carried).toBe(kind === "succeeds");
      if (kind === "succeeds") expect(p.prune).toHaveBeenCalledTimes(1);
      if (kind === "hangs") {
        // Bounded by the original clock. The cut-off ends it; the ceiling is the whole of T, measured over the phase alone.
        expect(run.phaseMs).toBeGreaterThanOrEqual(WORK_MS - 5);
        expect(run.phaseMs).toBeLessThan(SHORT_TIMEOUT_MS);
      }
    }, 30_000);
  });

  test("the latest page rewritten before the capture: the carried text is not that file, so nothing is prepared or pruned", async () => {
    const dir = tempDir("dba-outcome-");
    const jsonOut = (c: Captured): RunOutput => ({ jsonOut: c.envelopePath });
    const baseline = await observe(dir, false, jsonOut);
    const p = recordPreparation();
    const rewritten = "another run's page\n";
    const run = await observe(dir, true, jsonOut, () => writeFileSync(marker.latestBriefingPath(), rewritten));
    expect(run.carried).toBe(false);
    expect(p.identity).toHaveBeenCalledTimes(1);
    expect(p.prune).not.toHaveBeenCalled();
    expect(run.seen.page).toBe(rewritten);
    expect({ ...run.seen, page: baseline.seen.page }).toEqual(baseline.seen);
  }, 30_000);

  test("that refusal clears the phase's timer", async () => {
    freshStateDir();
    const timers = watchPhaseTimers(() => writeFileSync(marker.latestBriefingPath(), "another run's page\n"));
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    expect(outcome).toEqual({ code: 0, delivered: true, aiSummaryEnabled: true });
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.allCleared()).toBe(true);
  });

  test.each([5_000, 3_000])("T = %d leaves no work allowance: no read, no prune, no summary, the same report", async (timeoutMs) => {
    const dir = tempDir("dba-outcome-");
    const jsonOut = (c: Captured): RunOutput => ({ jsonOut: c.envelopePath });
    const baseline = await observe(dir, false, jsonOut, undefined, timeoutMs);
    const p = recordPreparation();
    const markerRead = spied(spyOn(marker, "readLastRunDate"));
    let readsAtNotify = -1;
    const run = await observe(dir, true, jsonOut, () => { readsAtNotify = markerRead.mock.calls.length; }, timeoutMs);
    expect(run.carried).toBe(false);
    expect(markerRead.mock.calls.length).toBe(readsAtNotify);
    expect(p.identity).not.toHaveBeenCalled();
    expect(p.prune).not.toHaveBeenCalled();
    expect(run.seen).toEqual(baseline.seen);
  }, 30_000);

  test("the failed preparation leaves no summary on the outcome, and clears its timer", async () => {
    freshStateDir();
    const { prune } = recordPreparation();
    prune.mockImplementation(async () => { throw new Error("prune"); });
    const timers = watchPhaseTimers();
    const outcome = await withConfig({ aiSummary: { enabled: true } }, () => runBriefing(true, injectedDeps(), {}));
    expect(outcome).toEqual({ code: 0, delivered: true, aiSummaryEnabled: true });
    expect(timers.delays()).toEqual([25_000]);
    expect(timers.allCleared()).toBe(true);
  });
});

// ── runCore's private seed ───────────────────────────────────────────────────────────────────────────

const FULL_HELP = "--tools --setting-sources --strict-mcp-config --no-session-persistence";
/** A claude-shaped fake that offers every lock flag and records what each spawn received on stdin. */
function lockableCli(dir: string, behaviour = ""): string {
  const p = join(dir, "claude");
  writeFileSync(p, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '${FULL_HELP}'; exit 0; fi
cat > '${join(dir, "stdin")}'
${behaviour}
printf '${BRIEFING.replace(/\n/g, "\\n")}'
`, { mode: 0o755 });
  return p;
}
const blocks = (title: string) => buildCalendarPromptBlocks({
  events: [{
    id: "e1", sourceId: "work", sourceKind: "link", title, location: null, description: null, organizer: null, attendees: [],
    availability: "busy", transparency: "opaque", time: { kind: "timed", startMs: Date.UTC(2026, 0, 5, 9), endMs: Date.UTC(2026, 0, 5, 10) },
  }] as never,
  sources: [{ id: "work", status: "ok" }], runDate: "2026-01-05", nowMs: Date.UTC(2026, 0, 5, 8), maxChars: 100_000,
});
type Step = NonNullable<CoreDeps["calendar"]>;
const stepOf = (promptBlocks: ReturnType<typeof blocks> | null, events: unknown[] = []): Step => async () => ({
  struct: { events, sources: [{ id: "work", kind: "link", status: "ok" }], incomplete: false } as never, promptBlocks, skipOffline: false,
});
const chat = (content: string) => okJson({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
const loopbackApi = (origin: string) => ({ kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` });
function bench(state: string, label: string): void {
  mkdirSync(state, { recursive: true });
  writeFileSync(accountStatePath(state), JSON.stringify({ accounts: { [label]: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
}

describe("summarySeed names what actually won", () => {
  test("absent with an injected main provider, and on a quiet day", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const provider = { cli: fakeCli(dir), argv: [], promptVia: "stdin" };
    expect((await runCore({ repos: [repo], provider } as Config, walkDeps({ provider: INJECTED, calendar: stepOf(blocks("T")) }))).summarySeed).toBeUndefined();
    const quiet = await runCore({ repos: [], provider } as unknown as Config, walkDeps());
    expect(quiet.emptyWindow).toBe(true);
    expect(quiet.summarySeed).toBeUndefined();
  });

  test("a single entry with no `account` field still carries its block, its posture and no login", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const provider = { cli: fakeCli(dir), argv: [], promptVia: "stdin", timeoutMs: 45_000 };
    const r = await runCore({ repos: [repo], provider } as unknown as Config, walkDeps());
    expect(r.account).toBeUndefined();                                               // never derived from this field
    expect(r.summarySeed).toEqual({
      winner: { provider: provider as Config["provider"], timeoutMs: 45_000 },
      morningLocked: false,
      calendarCapture: { unlockedBlock: null, hasEvents: false },
    });
    expect(Object.hasOwn(r.summarySeed!.winner, "configDir")).toBe(false);
  });

  test("a fallback that wins after the walk moved on is the seed's winner, not item 1", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const failing = fakeCli(dir, "failing-cli", "exit 1");
    const fallback = { label: "Backup", cli: fakeCli(dir, "backup-cli"), argv: [], promptVia: "stdin", timeoutMs: 7_000 };
    const cfg = { repos: [repo], provider: { cli: failing, argv: [], promptVia: "stdin" }, fallbacks: [fallback] } as unknown as Config;
    const r = await runCore(cfg, walkDeps());
    expect(spawnsIn(dir).length).toBeGreaterThanOrEqual(2);                          // item 1 was really tried first
    const w = r.summarySeed!.winner;
    expect(w.provider.cli).toBe(fallback.cli);
    expect(w.timeoutMs).toBe(7_000);
  });

  test("a login that wins carries its own config dir and item 1's block", async () => {
    const state = freshStateDir();
    const dir = tempDir("dba-seed-");
    bench(state, "A");
    const provider = { cli: fakeCli(dir), argv: [], promptVia: "stdin", accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }] };
    const r = await runCore({ repos: [repo], provider } as unknown as Config, walkDeps(), true);
    const w = r.summarySeed!.winner;
    expect(w.configDir).toBe(`${dir}/b`);
    expect(w.provider).toEqual(provider as unknown as Config["provider"]);
  });

  test("an API winner's send is locked", async () => {
    const state = freshStateDir();
    const dir = tempDir("dba-seed-");
    const s = await startFakeApi(chat(BRIEFING)); servers.push(s);
    bench(state, "default");
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [{ label: "Local", api: loopbackApi(s.origin) }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ calendar: stepOf(blocks("T")) }));
    expect(r.summarySeed!.winner.provider.api).toBeDefined();
    expect(r.summarySeed!.morningLocked).toBe(true);
    expect(s.requests.at(-1)?.bodyText).toContain("| T |");                              // the locked text is what was sent
  });

  test("harden: false is an off posture, and unlocked", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const r = await runCore({ repos: [repo], provider: { cli: lockableCli(dir), argv: [], promptVia: "stdin", harden: false } } as unknown as Config, walkDeps({ calendar: stepOf(blocks("T")) }));
    expect(r.summarySeed!.morningLocked).toBe(false);
  });
});

describe("morningLocked is what the winning attempt actually sent", () => {
  const cfgOf = (cli: string, argv: string[] = []) => ({ repos: [repo], provider: { cli, argv, promptVia: "stdin" } } as unknown as Config);

  test("a locked spawn is locked, and the locked text is what the child got", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const r = await runCore(cfgOf(lockableCli(dir)), walkDeps({ calendar: stepOf(blocks("SNTL-TITLE")) }));
    expect(r.summarySeed!.morningLocked).toBe(true);
    expect(readFileSync(join(dir, "stdin"), "utf8")).toContain("SNTL-TITLE");
  });

  test("a flag off the allow-list is unlocked", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const r = await runCore(cfgOf(lockableCli(dir), ["--chrome"]), walkDeps({ calendar: stepOf(blocks("SNTL-TITLE")) }));
    expect(r.summarySeed!.morningLocked).toBe(false);
    expect(readFileSync(join(dir, "stdin"), "utf8")).not.toContain("SNTL-TITLE");
  });

  test("a locked first spawn whose flag was refused wins on the bare respawn: unlocked, posture off", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const refuse = `case " $* " in *" --strict-mcp-config "*) echo "error: unknown option '--strict-mcp-config'" >&2; exit 2;; esac`;
    const r = await runCore(cfgOf(lockableCli(dir, refuse)), walkDeps({ calendar: stepOf(blocks("SNTL-TITLE")) }));
    expect(r.summarySeed!.morningLocked).toBe(false);
    expect(readFileSync(join(dir, "stdin"), "utf8")).not.toContain("SNTL-TITLE");
  });

  test("a winner that reports no send is not credited with an earlier entry's locked one", async () => {
    freshStateDir();
    const failsLocked: Provider = {
      generate: async (prompt, opts) => {
        opts?.onPromptSent?.({ variant: "locked", text: prompt });
        throw new ProviderError("timeout", "failed after a locked send");
      },
    };
    const silent: Provider = { generate: async () => BRIEFING };
    spied(spyOn(factory, "buildProvider")).mockImplementation(((block: Config["provider"]) => ({ provider: block.cli === "fails" ? failsLocked : silent })) as typeof factory.buildProvider);
    const cfg = { repos: [repo], provider: { cli: "fails", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Backup", cli: "backup", argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ calendar: stepOf(blocks("T")) }));
    expect(r.summarySeed!.winner.provider.cli).toBe("backup");
    expect(r.summarySeed!.morningLocked).toBe(false);
  });

  test("an attempt abandoned at its deadline cannot speak for the winner, however late it reports a locked send", async () => {
    freshStateDir();
    let abandonedSend: ((sent: { variant: PromptVariant; text: string }) => void) | undefined;
    const hung: Provider = { generate: async (_prompt, opts) => { abandonedSend = opts?.onPromptSent; return new Promise<string>(() => {}); } };
    const winner: Provider = {
      generate: async (prompt, opts) => {
        opts?.onPromptSent?.({ variant: "unlocked", text: prompt });
        abandonedSend?.({ variant: "locked", text: "late" });
        return BRIEFING;
      },
    };
    spied(spyOn(factory, "buildProvider")).mockImplementation(((block: Config["provider"]) => ({ provider: block.cli === "hung" ? hung : winner })) as typeof factory.buildProvider);
    const cfg = { repos: [repo], provider: { cli: "hung", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Backup", cli: "backup", argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ calendar: stepOf(blocks("T")), attemptDeadlineMs: 50 }));
    expect(abandonedSend).toBeDefined();
    expect(r.summarySeed!.winner.provider.cli).toBe("backup");
    expect(r.summarySeed!.morningLocked).toBe(false);
  });

  test("an earlier entry's locked attempt does not leak onto an unlocked winner", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const cfg = { repos: [repo], provider: { cli: lockableCli(dir, "exit 1"), argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Backup", cli: fakeCli(dir, "backup-cli"), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, walkDeps({ calendar: stepOf(blocks("SNTL-TITLE")) }));
    expect(r.summarySeed!.winner.provider.cli).toEndWith("backup-cli");
    expect(r.summarySeed!.morningLocked).toBe(false);
  }, 20_000);                                          // 19 real spawns: 13 git, a --help, the failing entry's 4 attempts, the fallback
});

describe("the calendar capture is the same snapshot's, and only its unlocked side", () => {
  const cfgOf = (dir: string) => ({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } } as unknown as Config);
  const EVENT = { title: "ignored" };

  test("a block with no events: the block, and no events", async () => {
    freshStateDir();
    const b = blocks("SNTL-TITLE");
    const seed = (await runCore(cfgOf(tempDir("dba-seed-")), walkDeps({ calendar: stepOf(b) }))).summarySeed!;
    expect(seed.calendarCapture).toEqual({ unlockedBlock: b.unlocked, hasEvents: false });
    expect(JSON.stringify(seed)).not.toContain("SNTL-TITLE");                        // the locked block is never kept
  });

  test("events with a block; events with no block; neither", async () => {
    freshStateDir();
    const b = blocks("T");
    const capture = async (s: Step) => (await runCore(cfgOf(tempDir("dba-seed-")), walkDeps({ calendar: s }))).summarySeed!.calendarCapture;
    expect(await capture(stepOf(b, [EVENT]))).toEqual({ unlockedBlock: b.unlocked, hasEvents: true });
    expect(await capture(stepOf(null, [EVENT]))).toEqual({ unlockedBlock: null, hasEvents: true });
    expect(await capture(stepOf(null))).toEqual({ unlockedBlock: null, hasEvents: false });
  });

  test("the captured block is redacted, as the page beside it is", async () => {
    freshStateDir();
    const b = blocks("T");
    const key = "AKIAIOSFODNN7EXAMPLE";
    const seed = (await runCore(cfgOf(tempDir("dba-seed-")), walkDeps({ calendar: stepOf({ ...b, unlocked: `${b.unlocked}\nnote ${key}` }) }))).summarySeed!;
    expect(seed.calendarCapture.unlockedBlock).toContain("note ");
    expect(seed.calendarCapture.unlockedBlock).not.toContain(key);
  });
});

describe("the seed stays private", () => {
  test("nothing of it reaches the envelope", async () => {
    freshStateDir();
    const dir = tempDir("dba-seed-");
    const provider = { cli: fakeCli(dir), argv: ["--model", "SEED-ONLY-MODEL"], promptVia: "stdin" };
    const r = await runCore({ repos: [repo], provider } as unknown as Config, walkDeps());
    expect(r.summarySeed?.winner.provider.argv).toContain("SEED-ONLY-MODEL");
    const envelope = JSON.stringify(envelopeFrom(r, renderBriefing(r.struct), 0));
    for (const hidden of ["summarySeed", "morningLocked", "calendarCapture", "aiSummary", "SEED-ONLY-MODEL"]) expect(envelope).not.toContain(hidden);
  });
});
