// test/walk.ownership.test.ts — ownership through the walk (provider-fallback plan P1-M8-T1; spec r9 §5 "Run lock",
// "Ownership checks"): `RunDeps.lockStillHeld` inside the attempt closure and before every mark and status write,
// `HardenOpts.beforeSpawn` before the hardened provider's two internal respawns, and `RunDeps.verifyOwnership` right
// after the walk, before the grouper and the recap append.
//
// A "takeover" here is the second holder's footprint: it rewrites `account-state.json`, and from then on the old
// holder's `lockStillHeld` says false. The old holder must then write nothing and bill nothing more.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCore } from "../src/core";
import { hardenedProvider } from "../src/harden";
import { accountStatePath, PROBE_MS } from "../src/account";
import { providerStatusPath } from "../src/marker";
import { LostLockError, type Config } from "../src/types";
import { busyRepo, busyReply, busyCfg, CAMPAIGN_REPLY, type BusyRepo } from "./fixtures/recap-busy";
import { emptyEvidence } from "../src/transcripts/scan";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
let busy: BusyRepo;
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
  busy = await busyRepo(40);                                       // enough commits and items that the grouper is called
});
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

const SECOND_HOLDER = JSON.stringify({ accounts: { written: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } }, by: "the second holder" });
/** `lockStillHeld` that says true for the first `n` calls, then false — the moment of the takeover. */
function heldFor(n: number) {
  let calls = 0;
  return { get calls() { return calls; }, check: async () => ++calls <= n };
}
const benchItem1 = (d: string) => {
  mkdirSync(d, { recursive: true });
  writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { default: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: false, reason: "usage" } } }));
};
const fastFail = (dir: string) => fakeCli(dir, "claude", "echo 'down' 1>&2; exit 1");
const lastOnly = (cli: string, extra: Record<string, unknown> = {}): Config => ({ repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" },
  fallbacks: [{ label: "Last", cli, argv: [], promptVia: "stdin", ...extra }] } as unknown as Config);

describe("lockStillHeld inside the attempt closure", () => {
  test("a takeover during withRetry's schedule: the next attempt never starts, no mark, no status write", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-own-");
    benchItem1(d);
    const held = heldFor(1);
    const sleep = async () => { writeFileSync(accountStatePath(d), SECOND_HOLDER); };    // the takeover lands in the wait
    const cfg = lastOnly(fakeCli(dir, "fail-cli", "exit 1"));
    await expect(runCore(cfg, walkDeps({ lockStillHeld: held.check, sleep, retryDelaysMs: [1, 1] }))).rejects.toBeInstanceOf(LostLockError);
    expect(spawnsIn(dir).length).toBe(1);                          // billed the one attempt in flight, no more
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(SECOND_HOLDER);
    expect(() => readFileSync(providerStatusPath())).toThrow();    // no provider-status.json written
  });

  test("a takeover before either ladder rung: that rung never spawns, and nothing is written", async () => {
    for (const [n, spawns] of [[1, 1], [2, 2]] as const) {         // lost before rung 1; lost before rung 2
      const d = freshStateDir();
      const dir = tempDir("dba-own-");
      benchItem1(d);
      const before = readFileSync(accountStatePath(d), "utf8");
      const held = heldFor(n);
      await expect(runCore(lastOnly(fastFail(dir)), walkDeps({ lockStillHeld: held.check }))).rejects.toBeInstanceOf(LostLockError);
      expect(`n=${n}: ${spawnsIn(dir).length}`).toBe(`n=${n}: ${spawns}`);
      expect(readFileSync(accountStatePath(d), "utf8")).toBe(before);
    }
  });

  test("a takeover before a mark write: the failed entry is not marked", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-own-");
    benchItem1(d);
    const before = readFileSync(accountStatePath(d), "utf8");
    // A non-Claude CLI that is not installed: no ladder, no retry — one attempt check, then the hour-mark write check.
    const held = heldFor(1);
    await expect(runCore(lastOnly("/nonexistent/gone-cli", { harden: false }), walkDeps({ lockStillHeld: held.check }))).rejects.toBeInstanceOf(LostLockError);
    expect(held.calls).toBe(2);
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(before);
  });

  test("a takeover before a USAGE mark write: the wall is not recorded", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-own-");
    benchItem1(d);
    const before = readFileSync(accountStatePath(d), "utf8");
    const walled = fakeCli(dir, "walled-cli", `echo "You've hit your weekly limit · resets whenever"; exit 1`);
    const held = heldFor(1);
    await expect(runCore(lastOnly(walled, { harden: false }), walkDeps({ lockStillHeld: held.check }))).rejects.toBeInstanceOf(LostLockError);
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(before);
  });

  test("with the callbacks absent nothing is checked: the same walk marks and writes its status", async () => {
    const d = freshStateDir();
    benchItem1(d);
    await runCore(lastOnly("/nonexistent/gone-cli", { harden: false }), walkDeps()).catch(() => undefined);
    expect(JSON.parse(readFileSync(accountStatePath(d), "utf8")).accounts.Last?.reason).toBe("not-installed");
    expect(JSON.parse(readFileSync(providerStatusPath(), "utf8")).labels.Last).toBeDefined();
  });
});

describe("beforeSpawn before the hardened provider's internal respawns", () => {
  const fast = { probeMs: 2_000, flushMs: 200, timeoutMs: 10_000 };
  test("the flag-rejection respawn: called first, and a lost lock stops it", async () => {
    const dir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-own-h-")));
    const cli = fakeCli(dir, "claude", `case " $* " in *" --strict-mcp-config "*) echo "error: unknown option '--strict-mcp-config'" 1>&2; exit 1;; esac
echo BARE-OK`);
    let called = 0;
    const ok = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "s1"), beforeSpawn: async () => { called++; } });
    expect((await ok.generate("x")).trim()).toBe("BARE-OK");
    expect([called, spawnsIn(dir).length]).toEqual([1, 2]);
    const lost = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: join(dir, "s2"), beforeSpawn: async () => { throw new LostLockError(); } });
    await expect(lost.generate("x")).rejects.toBeInstanceOf(LostLockError);
    expect(spawnsIn(dir).length).toBe(3);                          // the flagged spawn only; the respawn never ran
  });

  test("the unusable-cwd respawn: called first, and a lost lock stops it", async () => {
    const dir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-own-h-")));
    const cli = join(dir, "claude");
    await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '--tools --setting-sources'; exit 0; fi
echo "RAN"
`, { mode: 0o755 });
    for (const lose of [false, true]) {
      const state = join(dir, `state-${lose}`);
      let called = 0;
      const hp = hardenedProvider({ cli, argv: [], promptVia: "stdin" }, { ...fast, stateDir: state,
        beforeSpawn: async () => { called++; if (lose) throw new LostLockError(); } });
      expect((await hp.generate("a")).trim()).toBe("RAN");           // memoises the narrow cwd (no respawn)
      expect(called).toBe(0);
      await chmod(join(state, "provider-cwd"), 0o000);
      if (lose) await expect(hp.generate("b")).rejects.toBeInstanceOf(LostLockError);
      else expect((await hp.generate("b")).trim()).toBe("RAN");
      expect(called).toBe(1);
      await chmod(join(state, "provider-cwd"), 0o700);
    }
  });

  test("the walk passes it: a lock lost between the flagged spawn and its respawn stops the walk", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-own-");
    benchItem1(d);
    const cli = fakeCli(dir, "claude", `case " $* " in *" --strict-mcp-config "*) echo "error: unknown option '--strict-mcp-config'" 1>&2; exit 1;; esac
echo down 1>&2; exit 1`);
    const held = heldFor(1);                                        // the attempt's own check passes; beforeSpawn's fails
    await expect(runCore(lastOnly(cli), walkDeps({ lockStillHeld: held.check }))).rejects.toBeInstanceOf(LostLockError);
    expect(spawnsIn(dir).length).toBe(1);
  });
});

/** A busy run (≥ 40 commits, the main reply citing 16) in recap mode trial, through a fake CLI, so the grouper IS
 *  called on a run that keeps its lock (P1-M8 checkpoint LOW 10: the earlier control never reached it). */
function busyRun(extraDeps: Record<string, unknown>) {
  const dir = tempDir("dba-own-busy-");
  const reply = join(dir, "reply.md");
  writeFileSync(reply, busyReply(busy, 16));
  const cfg = busyCfg(busy, { recapCampaigns: { mode: "trial" }, provider: { cli: fakeCli(dir, "fake-provider", `cat '${reply}'`), argv: [], promptVia: "stdin" } });
  const records: string[] = [];
  let grouped = 0;
  const deps = walkDeps({
    grouper: async () => { grouped++; return CAMPAIGN_REPLY; },
    persistRecapRecord: async (line: string) => { records.push(line); },
    persistHealth: async () => {},
    ...extraDeps,
  });
  return { cfg, deps, records, grouped: () => grouped };
}

describe("verifyOwnership right after the walk, and the recap phase", () => {
  test("a failed check: a quiet lost-lock result — no grouper call, no recap append (control: both happen)", async () => {
    for (const owns of [true, false]) {
      freshStateDir();
      const x = busyRun({ verifyOwnership: async () => owns });
      const oErr = console.error;
      console.error = () => {};
      try {
        const r = await runCore(x.cfg, x.deps, true);
        expect(`${owns}: ${r.lostLock === true}`).toBe(`${owns}: ${!owns}`);
        if (!owns) expect([r.rawText, x.grouped(), x.records.length]).toEqual(["", 0, 0]);
        else expect([x.grouped(), x.records.length]).toEqual([1, 1]);
      } finally { console.error = oErr; }
    }
  });

  test("a lock lost DURING the grouper (its beforeSpawn throws): lostLock, no record, never `grouper-throw`", async () => {
    freshStateDir();
    const x = busyRun({ grouper: async () => { throw new LostLockError(); } });
    const lines: string[] = [];
    const oErr = console.error;
    console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const r = await runCore(x.cfg, x.deps, true);
      expect(r.lostLock).toBe(true);
      expect(r.rawText).toBe("");
    } finally { console.error = oErr; }
    expect(x.records).toEqual([]);
    expect(lines.join("\n")).not.toContain("grouper-throw");
  });

  test("a lock lost between the walk's last write and the grouper (the drift read): the grouper is never called (codex MED 4)", async () => {
    freshStateDir();
    let held = true;
    let flipped = false;
    // The render-time working-tree re-check runs after every post-walk write and before the recap phase.
    const x = busyRun({ lockStillHeld: async () => held, statusNow: async () => { held = false; flipped = true; return ""; } });
    const oErr = console.error;
    console.error = () => {};
    try { expect((await runCore(x.cfg, x.deps, true)).lostLock).toBe(true); } finally { console.error = oErr; }
    expect(flipped).toBe(true);                                    // the premise: the takeover landed in that window
    expect(x.grouped()).toBe(0);
    expect(x.records).toEqual([]);
  });

  test("a takeover before the transcript-health write: nothing is persisted (Opus LOW 2)", async () => {
    freshStateDir();
    const written: string[] = [];
    const cfg = { repos: [repo], transcripts: { enabled: true }, provider: { cli: "claude", argv: [], promptVia: "stdin" } } as unknown as Config;
    const held = heldFor(1);                                       // the attempt passes; the health write's check fails
    await expect(runCore(cfg, walkDeps({
      provider: { generate: async () => "## RESUME\n- [r] x\n## RECAP\n- [r] y\n## SUGGESTIONS\n- z\n" },
      lockStillHeld: held.check,
      scan: async (o: { window: { startUtc: string; endUtc: string } }) => ({ evidence: emptyEvidence(o.window as never), degraded: [] }),
      persistHealth: async (date: string) => { written.push(date); },
    }))).rejects.toBeInstanceOf(LostLockError);
    expect(written).toEqual([]);
  });

  test("a lock lost after the grouper, before the record append: lostLock, no record", async () => {
    freshStateDir();
    let held = true;
    const x = busyRun({ lockStillHeld: async () => held, grouper: async () => { held = false; return CAMPAIGN_REPLY; } });
    const oErr = console.error;
    console.error = () => {};
    try { expect((await runCore(x.cfg, x.deps, true)).lostLock).toBe(true); } finally { console.error = oErr; }
    expect(x.records).toEqual([]);
  });
});

describe("the remaining write checks (P1-M8 checkpoint LOW 4)", () => {
  test("a takeover exactly before the status write on an exhausted walk: no provider-status.json", async () => {
    freshStateDir();
    const dir = tempDir("dba-own-");
    const held = heldFor(1);                                       // the attempt passes; the status write's check fails
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false } } as unknown as Config;
    await expect(runCore(cfg, walkDeps({ lockStillHeld: held.check }))).rejects.toBeInstanceOf(LostLockError);
    expect(held.calls).toBe(2);
    expect(() => readFileSync(providerStatusPath())).toThrow();
  });

  test("a takeover exactly before the post-walk clear (the day marker untouched): the winner's mark is not cleared", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-own-");
    // An hour mark on item 1 does not bench it (ignored at read), so it runs, wins, and would be cleared.
    mkdirSync(d, { recursive: true });
    const seeded = JSON.stringify({ accounts: { default: { limitedUntil: new Date(Date.now() + PROBE_MS).toISOString(), isProbe: true, reason: "auth" } } });
    writeFileSync(accountStatePath(d), seeded);
    const held = heldFor(1);
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } } as unknown as Config;
    await expect(runCore(cfg, walkDeps({ lockStillHeld: held.check, verifyOwnership: async () => true }))).rejects.toBeInstanceOf(LostLockError);
    expect(readFileSync(accountStatePath(d), "utf8")).toBe(seeded);
  });
});
