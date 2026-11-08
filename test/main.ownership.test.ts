// test/main.ownership.test.ts — the shell's half of ownership (provider-fallback plan P1-M8-T2; spec r9 §5 "Run lock"):
// `run()` passes `lockStillHeld` (never for a fail-open lock) and `verifyOwnership`, a lost lock anywhere ends in the
// quiet `concurrent` exit with no delivery and no `last-skip.json`, the delivery-side re-check runs before every
// delivery and skip write, an already-stamped day found there exits quietly as `already-ran`, the heartbeat cap is
// derived from the combined list, and a fail-open acquisition says so once.
//
// A "takeover" rewrites `<state>/run.lock` IN PLACE with a successor's nonce — the same inode, other contents, which
// `stillOwns` reads as lost — from inside the run: from the fake CLI, a recap-record hook or an injected provider.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main";
import * as runlock from "../src/runlock";
import * as core from "../src/core";
import { heartbeatCapMs } from "../src/runlock";
import { latestBriefingPath, lastSkipPath, localDateStr, markerPath, supportDir } from "../src/marker";
import { resolveProviderList } from "../src/providerList";
import { ProviderError, type Config } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
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

const SUCCESSOR = JSON.stringify({ pid: process.pid, startedIso: new Date().toISOString(), invoker: "cli", nonce: "the-successor" });
const lockFile = () => join(supportDir(), "run.lock");
/** The successor's footprint, written in place over our lock (the shell form for a fake CLI). */
const takeoverSh = () => `printf '%s' '${SUCCESSOR}' > '${lockFile()}'`;
const takeover = () => writeFileSync(lockFile(), SUCCESSOR);

async function withConfig(cfg: Record<string, unknown>, fn: (err: string[], envelope: () => Record<string, unknown>) => Promise<void>): Promise<void> {
  const home = tempDir("dba-own-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo], ...cfg }));
  process.env.XDG_CONFIG_HOME = home;
  const err: string[] = [];
  const realErr = console.error, realLog = console.log;
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try { await fn(err, () => JSON.parse(readFileSync(join(home, "envelope.json"), "utf8"))); }
  finally { console.error = realErr; console.log = realLog; }
}
const jsonOut = (home?: string) => ({ jsonOut: join(home ?? process.env.XDG_CONFIG_HOME!, "envelope.json") });
/** Nothing was delivered and no skip was recorded. */
function nothingWritten(): void {
  expect(existsSync(latestBriefingPath())).toBe(false);
  expect(existsSync(markerPath())).toBe(false);
  expect(existsSync(lastSkipPath())).toBe(false);
}

describe("a lost lock is the quiet `concurrent` exit", () => {
  test("lost during the walk, found at the post-walk check: exit 0, concurrent, no delivery, no last-skip", async () => {
    freshStateDir();
    const dir = tempDir("dba-own-");
    await withConfig({ provider: { cli: fakeCli(dir, "fake-provider", `${takeoverSh()}\nprintf '${BRIEFING.replace(/\n/g, "\\n")}'`), argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
      expect(await run(true, walkDeps(), jsonOut())).toBe(0);
      expect(envelope().skipReason).toBe("concurrent");
    });
    nothingWritten();
    expect(readFileSync(lockFile(), "utf8")).toBe(SUCCESSOR);      // the successor's lock was not released by us
  });

  test("lost after runCore returned, found at the delivery-side re-check (before any write)", async () => {
    freshStateDir();
    const dir = tempDir("dba-own-");
    await withConfig({ recapCampaigns: { mode: "trial" }, provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
      // The recap record append is runCore's last act — after its own post-walk check.
      const code = await run(true, walkDeps({ persistRecapRecord: async () => { takeover(); } }), jsonOut());
      expect(code).toBe(0);
      expect(envelope().skipReason).toBe("concurrent");
    });
    nothingWritten();
  });

  test("on the provider-fail catch path: no provider-fail skip, exit 0, concurrent", async () => {
    freshStateDir();
    await withConfig({ provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
      const provider = { generate: async () => { takeover(); throw new ProviderError("nonzero-exit", "failed after the takeover"); } };
      expect(await run(true, walkDeps({ provider }), jsonOut())).toBe(0);
      expect(envelope().skipReason).toBe("concurrent");
    });
    nothingWritten();
  });

  test("on the crash path (a LostLockError from inside the walk): never crashed, exit 0, concurrent", async () => {
    freshStateDir();
    await withConfig({ provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
      let calls = 0;
      // The first attempt fails after the takeover; withRetry's next attempt meets the lost lock at its own check.
      const provider = { generate: async () => { calls++; takeover(); throw new ProviderError("nonzero-exit", "transient"); } };
      expect(await run(true, walkDeps({ provider, retryDelaysMs: [1] }), jsonOut())).toBe(0);
      expect(calls).toBe(1);
      expect(envelope().skipReason).toBe("concurrent");
    });
    nothingWritten();
  });
});

describe("the day stamped meanwhile, and fail-open", () => {
  const stampSh = () => `printf '%s' '${localDateStr(new Date())}' > '${markerPath()}'`;

  test("a day stamped during the run exits quietly as already-ran and writes no last-skip — unless forced", async () => {
    for (const force of [false, true]) {
      freshStateDir();
      const dir = tempDir("dba-own-");
      await withConfig({ provider: { cli: fakeCli(dir, "fake-provider", `${stampSh()}\nprintf '${BRIEFING.replace(/\n/g, "\\n")}'`), argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
        expect(await run(force, walkDeps({ interactive: true }), jsonOut())).toBe(0);
        expect(`${force}: ${envelope().skipReason ?? null}`).toBe(`${force}: ${force ? null : "already-ran"}`);
      });
      expect(`${force}: ${existsSync(lastSkipPath())}`).toBe(`${force}: false`);
      expect(`${force}: ${existsSync(latestBriefingPath())}`).toBe(`${force}: ${force}`);
    }
  });

  test("a fail-open run gets no lockStillHeld, prints its diagnostic once, still delivers — and still honours a stamped day", async () => {
    for (const stamp of [false, true]) {
      freshStateDir();
      mkdirSync(lockFile(), { recursive: true });                // a directory: the lock can be neither created nor written
      const dir = tempDir("dba-own-");
      const body = `${stamp ? stampSh() + "\n" : ""}printf '${BRIEFING.replace(/\n/g, "\\n")}'`;
      await withConfig({ provider: { cli: fakeCli(dir, "fake-provider", body), argv: [], promptVia: "stdin" } }, async (err, envelope) => {
        expect(await run(false, walkDeps({ interactive: true }), jsonOut())).toBe(0);
        expect(err.filter((l) => l.includes(runlock.FAIL_OPEN_LOCK_DIAGNOSTIC)).length).toBe(1);
        expect(`${stamp}: ${envelope().skipReason ?? null}`).toBe(`${stamp}: ${stamp ? "already-ran" : null}`);
      });
      expect(`${stamp}: ${existsSync(latestBriefingPath())}`).toBe(`${stamp}: ${!stamp}`);
      expect(existsSync(lastSkipPath())).toBe(false);
    }
  });
});

describe("the heartbeat cap", () => {
  test("run() passes heartbeatCapMs derived from the combined list, so the holder's heartbeat runs during the walk", async () => {
    freshStateDir();
    const dir = tempDir("dba-own-");
    const cfg = { provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", timeoutMs: 45_000 },
      fallbacks: [{ label: "Local", api: { kind: "openai-compatible", model: "m", baseUrl: "http://127.0.0.1:9/v1" }, timeoutMs: 600_000 }] };
    const spy = spyOn(runlock, "acquireRunLock");
    try {
      await withConfig(cfg, async () => { expect(await run(true, walkDeps(), jsonOut())).toBe(0); });
      const opts = spy.mock.calls[0]![0] as { heartbeatCapMs?: number };
      const list = resolveProviderList({ repos: [repo], ...cfg } as unknown as Config, homedir());
      expect(opts.heartbeatCapMs).toBe(heartbeatCapMs(list.entries, { recapCampaigns: false, calendar: false }));
    } finally { spy.mockRestore(); }
  });
});

describe("P1-M8 checkpoint: the branches a flipping answer reaches, and the heartbeat firing", () => {
  /** `acquireRunLock` with the real lock, but `stillOwns` answering from `answers` in turn (then true). The lock file
   *  itself is never touched, so only these two branches can turn the run quiet. */
  function flippingLock(answers: boolean[]) {
    const real = runlock.acquireRunLock;
    return spyOn(runlock, "acquireRunLock").mockImplementation((async (o: Parameters<typeof real>[0]) => {
      const h = await real(o);
      if (!h.acquired) return h;
      let i = 0;
      return { ...h, stillOwns: async () => (i < answers.length ? answers[i++]! : true) };
    }) as typeof real);
  }

  test("the explicit LostLockError branch: a lost answer inside the walk, an owned one at the shell's re-check — still concurrent, never crashed", async () => {
    freshStateDir();
    const spy = flippingLock([false]);                              // the attempt's own check: lost
    try {
      await withConfig({ provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
        expect(await run(true, walkDeps({ provider: { generate: async () => BRIEFING } }), jsonOut())).toBe(0);
        expect(envelope().skipReason).toBe("concurrent");
      });
    } finally { spy.mockRestore(); }
    nothingWritten();
  });

  test("the explicit lostLock branch: runCore's post-walk check lost, the shell's re-check owned — still concurrent", async () => {
    freshStateDir();
    const spy = flippingLock([true, false]);                        // the attempt passes; verifyOwnership's read is lost
    try {
      await withConfig({ provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
        expect(await run(true, walkDeps({ provider: { generate: async () => BRIEFING } }), jsonOut())).toBe(0);
        expect(envelope().skipReason).toBe("concurrent");
      });
    } finally { spy.mockRestore(); }
    nothingWritten();
  });

  test("the heartbeat fires during a slow walk: the lock's mtime advances while the provider runs", async () => {
    freshStateDir();
    const dir = tempDir("dba-own-");
    const real = runlock.acquireRunLock;
    const spy = spyOn(runlock, "acquireRunLock").mockImplementation(((o: Parameters<typeof real>[0]) =>
      real({ ...o, heartbeatIntervalMs: 50 })) as typeof real);  // the cap is run()'s own; only the interval is shortened
    const seen = new Set<number>();
    const poll = setInterval(() => { try { seen.add(statSync(lockFile()).mtimeMs); } catch { /* not yet / gone */ } }, 10);
    try {
      await withConfig({ provider: { cli: fakeCli(dir, "fake-provider", `sleep 0.6\nprintf '${BRIEFING.replace(/\n/g, "\\n")}'`), argv: [], promptVia: "stdin" } }, async () => {
        expect(await run(true, walkDeps(), jsonOut())).toBe(0);
      });
    } finally { clearInterval(poll); spy.mockRestore(); }
    expect(seen.size).toBeGreaterThanOrEqual(3);                  // the create, then at least two touches
  });
});

describe("PR 1 final review round 1 M7: verifyOwnership's day-marker half", () => {
  test("a day stamped mid-walk (recap mode trial, not forced): no grouper call and no recap-campaigns.jsonl line", async () => {
    const { busyRepo, busyReply } = await import("./fixtures/recap-busy");
    const { recapCampaignsPath } = await import("../src/marker");
    const busy = await busyRepo(40);
    freshStateDir();
    const dir = tempDir("dba-own-");
    const reply = join(dir, "reply.md");
    writeFileSync(reply, busyReply(busy, 16));
    const stamp = `printf '%s' '${localDateStr(new Date())}' > '${markerPath()}'`;
    await withConfig({ repos: [busy.dir], excludeCommitPatterns: [], lookbackCapDays: 30, recapCampaigns: { mode: "trial" },
      provider: { cli: fakeCli(dir, "fake-provider", `${stamp}\ncat '${reply}'`), argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
      expect(await run(false, walkDeps({ interactive: true }), jsonOut())).toBe(0);
      expect(envelope().skipReason).toBe("already-ran");
    });
    expect(spawnsIn(dir)).toEqual([""]);                            // the main call only — the grouper never spawned
    expect(existsSync(recapCampaignsPath())).toBe(false);
  });
});

test("L3: the delivery-side day check compares against the RUN's localDate (an injected clock), not the wall clock", async () => {
  freshStateDir();
  const dir = tempDir("dba-own-");
  const tomorrow = new Date(Date.now() + 86400e3); tomorrow.setHours(12, 0, 0, 0);
  const stamp = `printf '%s' '${localDateStr(tomorrow)}' > '${markerPath()}'`;
  await withConfig({ provider: { cli: fakeCli(dir, "fake-provider", `${stamp}\nprintf '${BRIEFING.replace(/\n/g, "\\n")}'`), argv: [], promptVia: "stdin" } }, async (_err, envelope) => {
    expect(await run(false, walkDeps({ interactive: true, now: () => tomorrow }), jsonOut())).toBe(0);
    expect(envelope().skipReason).toBe("already-ran");
  });
  expect(existsSync(latestBriefingPath())).toBe(false);
});

describe("PR 1 final review round 3 M3: a fail-open lock has nothing to lose", () => {
  // A REAL fail-open acquisition (the lock path is a directory: it can be neither created nor written), with its
  // `stillOwns` answering "not ours" — what the contents-only identity reads when a STRANGER's lock file sits there and
  // could not be overwritten (an unlink-proof file: a read-only folder or an immutable flag, which a portable test
  // cannot build). That answer is INJECTED; nothing else is. Neither ownership check may consult it.
  test("delivers, exits 0, never `concurrent`, and runCore gets lockStillHeld: undefined", async () => {
    freshStateDir();
    mkdirSync(lockFile(), { recursive: true });
    const realAcquire = runlock.acquireRunLock;
    const acquire = spyOn(runlock, "acquireRunLock").mockImplementation((async (o: Parameters<typeof realAcquire>[0]) => {
      const h = await realAcquire(o);
      return h.acquired ? { ...h, stillOwns: async () => false } : h;
    }) as typeof realAcquire);
    const coreSpy = spyOn(core, "runCore");
    const dir = tempDir("dba-own-");
    try {
      await withConfig({ provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } }, async (err, envelope) => {
        expect(await run(false, walkDeps({ interactive: true }), jsonOut())).toBe(0);
        expect(err.filter((l) => l.includes(runlock.FAIL_OPEN_LOCK_DIAGNOSTIC)).length).toBe(1);   // the premise
        expect(envelope().skipReason ?? null).toBeNull();
      });
      const deps = coreSpy.mock.calls[0]![1] as { lockStillHeld?: unknown };
      expect("lockStillHeld" in deps ? deps.lockStillHeld : undefined).toBeUndefined();
    } finally { acquire.mockRestore(); coreSpy.mockRestore(); }
    expect(existsSync(latestBriefingPath())).toBe(true);
    expect(existsSync(lastSkipPath())).toBe(false);
  });
});
