// test/account.marks-reason.test.ts — reason-carrying marks and the walk's mark filter (provider-fallback plan
// P1-M5-T1; spec r9 §5 "Marks", §4 "The current item 1 is never benched by an hour mark").
//
// Against temp state folders only (every writer here takes `stateDir`).
import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  accountStatePath, clearMark, loadAccountState, markFilter, recordHourMark, recordLimit, resolveForScript,
  parseResetInstant, PROBE_MS, HOUR_MARK_REASONS, type AccountState,
} from "../src/account";
import { FAILOVER_REASONS } from "../src/failover";

const NOW = new Date("2026-10-16T07:20:00-07:00");
const dir = () => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-marks-")));
const later = (ms: number) => new Date(NOW.getTime() + ms);
const entries = [{ label: "Claude login 1" }, { label: "Claude login 2" }, { label: "Local model" }];

describe("what a mark carries", () => {
  test("a probe mark written through recordHourMark carries its hour reason, never usage, and no lastLimit", async () => {
    const d = dir();
    expect(await recordHourMark("Claude login 2", "cli-failure", NOW, { item1Label: "Claude login 1", stateDir: d })).toBe(true);
    const s = await loadAccountState(d);
    expect(s.accounts["Claude login 2"]!.isProbe).toBe(true);
    expect(s.accounts["Claude login 2"]!.reason).toBe("cli-failure");
    expect(s.lastLimit).toBeUndefined();
  });

  test("an UNPARSED usage wall recorded on tick 1 still reads as usage on tick 2 and still benches item 1", async () => {
    const d = dir();
    const reset = parseResetInstant("You've hit your weekly limit · resets sometime (who knows)", NOW);
    expect(reset.isProbe).toBe(true);                     // the premise: the unparsed form, a probe deadline
    await recordLimit("Claude login 1", reset.until, NOW, { reason: "usage", isProbe: reset.isProbe, stateDir: d });
    const s = await loadAccountState(d);                  // tick 2 reads the file
    expect(s.accounts["Claude login 1"]!.reason).toBe("usage");
    const f = markFilter(entries, s, later(60_000), "Claude login 1");
    expect(f.eligible.map((e) => e.label)).toEqual(["Claude login 2", "Local model"]);
    expect(f.skipped.map((x) => [x.entry.label, x.reason])).toEqual([["Claude login 1", "usage"]]);
  });

  test("legacy marks with no reason: isProbe:false reads as usage, isProbe:true as the hour class (reported earlier-failure)", async () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: {
      "Claude login 1": { limitedUntil: later(PROBE_MS).toISOString(), isProbe: false },
      "Claude login 2": { limitedUntil: later(PROBE_MS).toISOString(), isProbe: true },
    } }));
    const s = await loadAccountState(d);
    expect(s.accounts["Claude login 1"]!.reason).toBeUndefined();     // read as written: no reason invented on disk
    const f = markFilter(entries, s, NOW, "Local model");               // a reorder: neither marked entry is item 1
    expect(f.skipped.map((x) => [x.entry.label, x.reason])).toEqual([["Claude login 1", "usage"], ["Claude login 2", "earlier-failure"]]);
    // As item 1, the legacy probe mark is hour class and therefore ignored; the legacy usage mark still benches.
    expect(markFilter(entries, s, NOW, "Claude login 2").eligible.map((e) => e.label)).toEqual(["Claude login 2", "Local model"]);
  });

  test("an unknown reason string is dropped at read, falling back to the legacy reading", async () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: {
      "Local model": { limitedUntil: later(PROBE_MS).toISOString(), isProbe: true, reason: "made-up" },
    } }));
    const s = await loadAccountState(d);
    expect(s.accounts["Local model"]!.reason).toBeUndefined();
    expect(markFilter(entries, s, NOW, "Claude login 1").skipped.map((x) => x.reason)).toEqual(["earlier-failure"]);
  });
});

describe("recordHourMark", () => {
  test("writes an hour mark with its reason and no lastLimit", async () => {
    const d = dir();
    expect(await recordHourMark("Local model", "not-found", NOW, { item1Label: "Claude login 1", stateDir: d })).toBe(true);
    const s = await loadAccountState(d);
    expect(s.accounts["Local model"]).toEqual({ limitedUntil: later(PROBE_MS).toISOString(), isProbe: true, reason: "not-found" });
    expect(s.lastLimit).toBeUndefined();
  });

  test("refuses item 1: the current item 1 is never hour-marked", async () => {
    const d = dir();
    expect(await recordHourMark("Claude login 1", "auth", NOW, { item1Label: "Claude login 1", stateDir: d })).toBe(false);
    expect((await loadAccountState(d)).accounts["Claude login 1"]).toBeUndefined();
  });
});

describe("markFilter", () => {
  const s = (accounts: AccountState["accounts"]): AccountState => ({ accounts });

  test("an hour mark on the current item 1 is ignored at read, and stays in the file", async () => {
    const d = dir();
    await recordHourMark("Claude login 2", "auth", NOW, { item1Label: "Claude login 1", stateDir: d });
    // The user then moves "Claude login 2" to the top of the list.
    const st = await loadAccountState(d);
    const f = markFilter(entries, st, NOW, "Claude login 2");
    expect(f.eligible.map((e) => e.label)).toEqual(["Claude login 1", "Claude login 2", "Local model"]);
    expect(f.skipped).toEqual([]);
    expect((await loadAccountState(d)).accounts["Claude login 2"]!.reason).toBe("auth");   // still on disk
  });

  test("a usage mark still applies to item 1", () => {
    const f = markFilter(entries, s({ "Claude login 1": { limitedUntil: later(3_600_000).toISOString(), isProbe: false, reason: "usage" } }), NOW, "Claude login 1");
    expect(f.skipped.map((x) => [x.entry.label, x.reason, x.until])).toEqual([["Claude login 1", "usage", later(3_600_000).toISOString()]]);
  });

  test("expired, unparseable and far-future marks do not bench (resolveAccount's rule)", () => {
    const f = markFilter(entries, s({
      "Claude login 1": { limitedUntil: new Date(NOW.getTime() - 1).toISOString(), isProbe: false, reason: "usage" },
      "Claude login 2": { limitedUntil: "not a date", isProbe: true, reason: "auth" },
      "Local model": { limitedUntil: later(40 * 86_400_000).toISOString(), isProbe: false, reason: "usage" },
    }), NOW, "Claude login 1");
    expect(f.skipped).toEqual([]);
    expect(f.eligible.length).toBe(3);
  });

  test("the eligible list keeps the input order and the entries themselves", () => {
    const rich = entries.map((e, i) => ({ ...e, i }));
    const f = markFilter(rich, s({ "Claude login 2": { limitedUntil: later(PROBE_MS).toISOString(), isProbe: true, reason: "cli-failure" } }), NOW, "Claude login 1");
    expect(f.eligible).toEqual([rich[0]!, rich[2]!]);
    expect(f.skipped[0]!.entry).toBe(rich[1]!);
  });
});

describe("writes are non-fatal", () => {
  test("recordLimit, recordHourMark and clearMark into an unwritable dir do not throw", async () => {
    const d = dir();
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { "Local model": { limitedUntil: later(PROBE_MS).toISOString(), isProbe: true, reason: "auth" } } }));
    chmodSync(d, 0o500);
    try {
      await recordLimit("Claude login 1", later(PROBE_MS), NOW, { reason: "usage", stateDir: d });
      await recordHourMark("Local model", "auth", NOW, { item1Label: "Claude login 1", stateDir: d });
      await clearMark("Local model", d);
    } finally { chmodSync(d, 0o700); }
    // Nothing was written, and nothing threw.
    expect(Object.keys((await loadAccountState(d)).accounts)).toEqual(["Local model"]);
  });
});

describe("the script path is unchanged", () => {
  test("resolveForScript picks the same account as before, whatever reason a mark carries", async () => {
    const d = dir();
    const accounts = [{ label: "primary" }, { label: "fallback", configDir: "/x" }];
    expect((await resolveForScript(accounts, NOW, d)).account).toEqual({ label: "primary" });
    // An hour-class mark on the primary still benches it for the judge: the item-1 rule lives in markFilter only.
    mkdirSync(d, { recursive: true });
    writeFileSync(accountStatePath(d), JSON.stringify({ accounts: { primary: { limitedUntil: later(PROBE_MS).toISOString(), isProbe: true, reason: "auth" } } }));
    expect(await resolveForScript(accounts, NOW, d)).toEqual({ account: { label: "fallback", configDir: "/x" }, env: { CLAUDE_CONFIG_DIR: "/x" } });
  });
});

describe("one list of hour reasons", () => {
  test("every hour-class row of the failover table is a reason a mark can carry", () => {
    const hourRows = Object.entries(FAILOVER_REASONS).filter(([, r]) => r.mark.startsWith("hour-")).map(([k]) => k);
    expect(hourRows.length).toBeGreaterThan(0);
    for (const r of hourRows) expect(`${r}: ${(HOUR_MARK_REASONS as readonly string[]).includes(r)}`).toBe(`${r}: true`);
  });

  test("a mark whose reason is in the list survives a write and a read", async () => {
    for (const reason of HOUR_MARK_REASONS) {
      const d = dir();
      await recordHourMark("Local model", reason, NOW, { item1Label: "Claude login 1", stateDir: d });
      expect((await loadAccountState(d)).accounts["Local model"]!.reason).toBe(reason);
    }
  });
});
