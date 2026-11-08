// test/providerStatus.test.ts — `<state>/provider-status.json` (src/providerStatus.ts, provider-fallback plan
// P1-M5-T2; spec r9 §5 Reporting). The store only: the walk's writes and the latch are in test/walk.quickcheck.test.ts.
import "./fixtures/isolate-state";
import { describe, expect, spyOn, test } from "bun:test";
import * as fsp from "node:fs/promises";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  observeRun, observeTest, pruneStatus, readProviderStatus, rowStatus, writeProviderStatus,
  STATUS_PRUNE_MS, type LabelRecord, type ProviderStatus,
} from "../src/providerStatus";
import { providerStatusPath, supportDir } from "../src/marker";
import type { FailoverReason } from "../src/failover";
import { join as pjoin } from "node:path";

const T0 = Date.parse("2026-10-16T07:20:00Z");
const at = (mins: number) => new Date(T0 + mins * 60_000).toISOString();
const NOW = new Date(T0 + 24 * 3_600_000);
const R1 = "a".repeat(32), R2 = "b".repeat(32);
const ok = (mins: number, revision = R1) => ({ at: at(mins), revision, ok: true as const });
const bad = (mins: number, reason: FailoverReason = "unreachable", revision = R1) => ({ at: at(mins), revision, ok: false as const, reason });

describe("transitions", () => {
  test("failingSince is set by the first failure after the last ok, kept, and cleared by an ok", () => {
    let r: LabelRecord | undefined;
    r = observeRun(r, ok(0));
    expect(r.failingSince).toBeUndefined();
    r = observeRun(r, bad(10));
    expect(r.failingSince).toEqual({ at: at(10), revision: R1 });
    r = observeRun(r, bad(20, "auth"));
    expect(r.failingSince).toEqual({ at: at(10), revision: R1 });        // kept: set once
    r = observeTest(r, bad(25));
    expect(r.failingSince).toEqual({ at: at(10), revision: R1 });        // a failed test does not move it either
    r = observeTest(r, ok(30));
    expect(r.failingSince).toBeUndefined();                              // any ok clears it
    expect([r.lastRun?.at, r.lastTest?.at, r.revision]).toEqual([at(20), at(30), R1]);
  });

  test("a revision change clears failingSince, and a failure at the new revision starts afresh — never inherited", () => {
    let r = observeRun(undefined, bad(0));
    expect(r.failingSince).toEqual({ at: at(0), revision: R1 });
    r = observeRun(r, ok(5, R2));
    expect(r.failingSince).toBeUndefined();
    r = observeRun(observeRun(undefined, bad(0)), bad(40, "auth", R2));
    expect(r.failingSince).toEqual({ at: at(40), revision: R2 });        // not at(0): that was another revision
    expect(r.revision).toBe(R2);
  });

  test("transitions are pure: the input record is not modified", () => {
    const before = observeRun(undefined, ok(0));
    const snapshot = JSON.stringify(before);
    observeRun(before, bad(1));
    observeTest(before, bad(2));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("an OLDER observation arriving late updates only its slot, and failingSince is rebuilt from the timeline", () => {
    // P1-M5 checkpoint MED, the reproduced case: `provider test` probes unlocked and applies its result later, so a
    // failed test at t50 can land after an ok run at t100 was recorded. A failed run at t200 then starts the failure.
    let r = observeRun(undefined, ok(100));
    r = observeTest(r, bad(50, "auth"));
    expect(r.failingSince).toBeUndefined();               // the ok at t100 is newer: still working
    expect(r.lastTest).toEqual(bad(50, "auth"));          // the late result is kept in its own slot…
    r = observeRun(r, bad(200));
    expect(r.failingSince).toEqual({ at: at(200), revision: R1 });   // …and is not taken for the start: t200, not t50
    // A late OK older than the failure's start does not clear it; a later failure keeps the earlier start.
    let q = observeRun(undefined, bad(100));
    q = observeRun(q, bad(200));
    q = observeTest(q, ok(50));
    expect(q.failingSince).toEqual({ at: at(100), revision: R1 });
    // A late ok BETWEEN two failures moves the start to the first failure after it.
    let w = observeRun(undefined, bad(100));
    w = observeRun(w, bad(200));
    w = observeTest(w, ok(150));
    expect(w.failingSince).toEqual({ at: at(200), revision: R1 });
    // A late observation into an OCCUPIED slot leaves the newer one there.
    const occupied = observeRun(observeRun(undefined, ok(100)), bad(50, "auth"));
    expect(occupied.lastRun).toEqual(ok(100));
    expect(occupied.failingSince).toBeUndefined();
    // A late observation never moves the record's revision.
    const v = observeTest(observeRun(undefined, ok(100, R2)), bad(50, "auth", R1));
    expect(v.revision).toBe(R2);
  });

  test("failures at t0, t10, t20 then a LATE success at t5: the failure started at t10 (codex LOW)", () => {
    let r = observeRun(undefined, bad(0));
    r = observeRun(r, bad(10));
    r = observeRun(r, bad(20));
    r = observeTest(r, ok(5));
    expect(r.failingSince).toEqual({ at: at(10), revision: R1 });
  });

  test("the history is bounded: only the newest observations are kept", () => {
    let r: LabelRecord | undefined;
    for (let i = 0; i < 40; i++) r = observeRun(r, i % 2 ? ok(i) : bad(i));
    expect(r!.history!.length).toBeLessThanOrEqual(16);
    expect(r!.history!.at(-1)!.at).toBe(at(39));
  });

  test("quickCheck rides through observations untouched", () => {
    const r: LabelRecord = { ...observeRun(undefined, ok(0)), quickCheck: { localDate: "2026-10-16", revision: R1 } };
    expect(observeRun(r, bad(3)).quickCheck).toEqual({ localDate: "2026-10-16", revision: R1 });
  });
});

describe("rowStatus — precedence", () => {
  const entry = { label: "Local model", revision: R1 };
  const failing = observeRun(observeRun(undefined, ok(0)), bad(10, "unreachable"));

  // A DROPPED entry's `invalid` row is built by `status --json`'s caller, not here (round 5 L6): pinned in
  // test/json-surfaces.test.ts ("one row per entry and per dropped entry").

  test("then out of usage, then paused, from the (already filtered) marks", () => {
    const usage = [{ entry: { label: "Local model" }, reason: "usage" as const, until: at(24 * 60 + 90) }];
    const hour = [{ entry: { label: "Local model" }, reason: "auth" as const, until: at(24 * 60 + 30) }];
    expect(rowStatus(entry, failing, usage, NOW)).toEqual({ kind: "out-of-usage", until: at(24 * 60 + 90) });
    expect(rowStatus(entry, failing, hour, NOW)).toEqual({ kind: "paused", until: at(24 * 60 + 30), reason: "auth" });
    // Another label's mark is not this row's.
    expect(rowStatus(entry, failing, [{ ...hour[0]!, entry: { label: "Other" } }], NOW).kind).toBe("not-working");
    // An expired mark (a stale list) does not pause.
    expect(rowStatus(entry, failing, [{ ...hour[0]!, until: at(-1) }], NOW).kind).toBe("not-working");
  });

  test("item 1 carrying an hour mark reads by its newest observation, never paused (markFilter dropped the mark)", () => {
    // markFilter ignores an hour mark on the current item 1, so the row gets no mark at all.
    const item1 = { label: "Claude login 1", revision: R1 };
    expect(rowStatus(item1, observeRun(undefined, ok(5)), [], NOW)).toEqual({ kind: "working", at: at(5) });
  });

  test("then the newest matching-revision observation: failed, ok run, ok test", () => {
    expect(rowStatus(entry, failing, [], NOW)).toEqual({ kind: "not-working", since: at(10), reason: "unreachable" });
    expect(rowStatus(entry, observeRun(undefined, ok(7)), [], NOW)).toEqual({ kind: "working", at: at(7) });
    expect(rowStatus(entry, observeTest(undefined, ok(8)), [], NOW)).toEqual({ kind: "key-accepted", at: at(8) });
    // The NEWER of the two decides.
    const runThenTest = observeTest(observeRun(undefined, bad(1)), ok(2));
    expect(rowStatus(entry, runThenTest, [], NOW)).toEqual({ kind: "key-accepted", at: at(2) });
    const testThenRun = observeRun(observeTest(undefined, ok(1)), bad(2, "auth"));
    expect(rowStatus(entry, testThenRun, [], NOW)).toEqual({ kind: "not-working", since: at(2), reason: "auth" });
  });

  test("since is the failure's START, not the newest failure (P1-M5 checkpoint MED)", () => {
    const twice = observeRun(observeRun(undefined, bad(10)), bad(20, "auth"));
    expect(rowStatus(entry, twice, [], NOW)).toEqual({ kind: "not-working", since: at(10), reason: "auth" });
  });

  test("a failingSince that belongs to another revision is not this revision's start", () => {
    const rec: LabelRecord = { revision: R1, lastRun: bad(30, "unreachable"), failingSince: { at: at(5), revision: R2 } };
    expect(rowStatus(entry, rec, [], NOW)).toEqual({ kind: "not-working", since: at(30), reason: "unreachable" });
  });

  test("a failed TEST with no run reads not working since", () => {
    expect(rowStatus(entry, observeTest(undefined, bad(3, "key-unavailable")), [], NOW))
      .toEqual({ kind: "not-working", since: at(3), reason: "key-unavailable" });
  });

  test("a revision mismatch reads not tested; so does no record", () => {
    expect(rowStatus({ label: "Local model", revision: R2 }, failing, [], NOW)).toEqual({ kind: "not-tested" });
    expect(rowStatus(entry, undefined, [], NOW)).toEqual({ kind: "not-tested" });
  });
});

describe("pruning", () => {
  test("a label absent from the saved config is dropped only when its newest observation is over 7 days old", () => {
    const now = new Date(T0);
    const st: ProviderStatus = { labels: {
      kept: observeRun(undefined, { at: new Date(T0 - 30 * 86_400_000).toISOString(), revision: R1, ok: true }),   // in config: kept however old
      six: observeRun(undefined, { at: new Date(T0 - 6 * 86_400_000).toISOString(), revision: R1, ok: true }),
      eight: observeRun(undefined, { at: new Date(T0 - 8 * 86_400_000).toISOString(), revision: R1, ok: true }),
      eightButTestedRecently: observeTest(
        observeRun(undefined, { at: new Date(T0 - 8 * 86_400_000).toISOString(), revision: R1, ok: true }),
        { at: new Date(T0 - 86_400_000).toISOString(), revision: R1, ok: true }),
    } };
    const out = pruneStatus(st, new Set(["kept"]), now);
    expect(Object.keys(out.labels).sort()).toEqual(["eightButTestedRecently", "kept", "six"]);
    expect(STATUS_PRUNE_MS).toBe(7 * 86_400_000);
  });
});

describe("the file", () => {
  const dir = () => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-pstatus-")));

  test("providerStatusPath() is <state>/provider-status.json", () => {
    expect(providerStatusPath()).toBe(pjoin(supportDir(), "provider-status.json"));
  });

  test("round-trips, atomically (no temp file left), and holds nothing but the record", async () => {
    const path = join(dir(), "provider-status.json");
    const st: ProviderStatus = { labels: { "Local model": observeRun(undefined, bad(1, "unreachable")) } };
    expect(await writeProviderStatus(st, path)).toBe(true);
    expect(await readProviderStatus(path)).toEqual(st);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(path, "..")).sort()).toEqual(["provider-status.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(st);
  });

  test("unreadable or malformed reads as absent", async () => {
    const d = dir();
    expect(await readProviderStatus(join(d, "missing.json"))).toBeUndefined();
    writeFileSync(join(d, "bad.json"), "{not json");
    expect(await readProviderStatus(join(d, "bad.json"))).toBeUndefined();
    writeFileSync(join(d, "shape.json"), JSON.stringify({ labels: 5 }));
    expect(await readProviderStatus(join(d, "shape.json"))).toBeUndefined();
  });

  test("malformed dates and unknown reasons are dropped at read (P1-M5 checkpoint LOW)", async () => {
    const d = dir();
    writeFileSync(join(d, "p.json"), JSON.stringify({ labels: {
      a: { revision: R1, lastRun: { at: "yesterday-ish", revision: R1, ok: true }, lastTest: { at: at(1), revision: R1, ok: false, reason: "a made-up reason" } },
      b: { revision: R1, failingSince: { at: "not a date", revision: R1 }, quickCheck: { localDate: "2026-13-45", revision: R1 } },
      c: { revision: R1, quickCheck: { localDate: "16 Oct 2026", revision: R1 }, lastRun: { at: at(2), revision: R1, ok: false, reason: "unreachable" } },
    } }));
    const st = await readProviderStatus(join(d, "p.json"));
    expect(st!.labels.a).toEqual({ revision: R1 });
    expect(st!.labels.b).toEqual({ revision: R1 });
    expect(st!.labels.c).toEqual({ revision: R1, lastRun: { at: at(2), revision: R1, ok: false, reason: "unreachable" } });
  });

  test("the file is written 0600; a failed rename removes the temp file and leaves the old file intact", async () => {
    const d = dir();
    const path = join(d, "provider-status.json");
    const first: ProviderStatus = { labels: { x: observeRun(undefined, ok(1)) } };
    expect(await writeProviderStatus(first, path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const spy = spyOn(fsp, "rename").mockImplementation((async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); }) as typeof fsp.rename);
    let wrote: boolean;
    try { wrote = await writeProviderStatus({ labels: { y: observeRun(undefined, bad(2)) } }, path); }
    finally { spy.mockRestore(); }
    expect(wrote).toBe(false);
    expect(readdirSync(d)).toEqual(["provider-status.json"]);   // no temp file left behind
    expect(await readProviderStatus(path)).toEqual(first);
  });

  test("a malformed label record is dropped at read; the rest survive", async () => {
    const d = dir();
    const good = observeRun(undefined, ok(0));
    writeFileSync(join(d, "p.json"), JSON.stringify({ labels: { good, junk: "x", partial: { lastRun: { at: 5 } } } }));
    const st = await readProviderStatus(join(d, "p.json"));
    expect(Object.keys(st!.labels)).toEqual(["good", "partial"]);
    expect(st!.labels.partial).toEqual({});       // the bad observation is dropped, the label kept
  });

  test("a write into an unwritable dir does not throw, and reports false", async () => {
    const d = dir();
    chmodSync(d, 0o500);
    try { expect(await writeProviderStatus({ labels: {} }, join(d, "provider-status.json"))).toBe(false); }
    finally { chmodSync(d, 0o700); }
  });
});

test("L11: quickCheckActive is gated on the local date, the revision and the newest matching observation", async () => {
  const { quickCheckActive } = await import("../src/providerStatus");
  const failed = { at: "2026-10-16T08:00:00.000Z", revision: "r1", ok: false as const, reason: "unreachable" as const };
  const rec = { revision: "r1", lastRun: failed, quickCheck: { localDate: "2026-10-16", revision: "r1" } };
  expect(quickCheckActive(rec, "r1", "2026-10-16")).toBe(true);
  expect(quickCheckActive(rec, "r1", "2026-10-17")).toBe(false);          // a new local date clears it
  expect(quickCheckActive(rec, "r2", "2026-10-16")).toBe(false);          // a revision change clears it
  expect(quickCheckActive({ ...rec, lastTest: { at: "2026-10-16T09:00:00.000Z", revision: "r1", ok: true } }, "r1", "2026-10-16")).toBe(false);
  expect(quickCheckActive(undefined, "r1", "2026-10-16")).toBe(false);
});

describe("PR 1 final review round 3 L13: observe's equal-instant and window edges", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 7, 0, s)).toISOString();
  test("an observation at the SAME `at` as the slot's replaces it", () => {
    const first = observeRun(undefined, { at: at(0), revision: "r", ok: false, reason: "unreachable" });
    const second = observeRun(first, { at: at(0), revision: "r", ok: true });
    expect(second.lastRun).toEqual({ at: at(0), revision: "r", ok: true });
  });

  test("an ok and a failure at the same instant leave no failingSince", () => {
    const ok = observeRun(undefined, { at: at(0), revision: "r", ok: true });
    const fail = observeRun(ok, { at: at(0), revision: "r", ok: false, reason: "unreachable" });
    expect(fail.failingSince).toBeUndefined();
  });

  test("17 failures at one revision: failingSince is the FIRST, though it fell out of the 16-entry history", () => {
    let rec: ReturnType<typeof observeRun> | undefined;
    for (let i = 0; i < 17; i++) rec = observeRun(rec, { at: at(i), revision: "r", ok: false, reason: "unreachable" });
    expect(rec!.history!.length).toBe(16);                 // the premise: the first failure is out of the window
    expect(rec!.failingSince).toEqual({ at: at(0), revision: "r" });
  });
});
