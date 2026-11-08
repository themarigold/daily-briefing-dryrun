/**
 * PB-M1-T1 — the Today store's briefing section (`src/lib/today-store.ts`; wave-2 polish spec §3, "The Today store").
 *
 * What is pinned here:
 *   1. the store's initial state is the FULL declared shape (later tasks fill in transitions, never the shape);
 *   2. `startingLatest` starts Today `loaded` from the kept briefing only when the snapshot's `latestMtime` is non-null
 *      and equals the kept one, otherwise `loading` (a newer file, no snapshot, or nothing kept);
 *   3. `keepBriefing(null)` drops the kept briefing;
 *   4. a subscriber registered on another route hears every change, and its unsubscribe stops it.
 *
 * Isolation (plan §0.6): every test starts from `resetTodayStoreForTests()` and ends with no write in flight and no
 * flow running.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";

import type { CalendarStatusJson } from "../src/lib/calendar-contract";
import type { EngineOutcome } from "../src/lib/engine";
import type { BriefingFile, SaveOutcome } from "../src/lib/files";
import {
  applyCalendarOff,
  briefingReads,
  calendarOn,
  connectWrote,
  keepBriefing,
  liveReadSent,
  malformed,
  neverAsked,
  readStatusThroughStore,
  seedTodayStoreForTests,
  storeLinkRemove,
  storeSaveBlock,
  storeWrite,
  onTodayStore,
  resetTodayStoreForTests,
  startingLatest,
  todayStore,
  type FlowResult,
  type KeptBriefing,
  type TodayStoreState,
} from "../src/lib/today-store";

beforeEach(() => {
  resetTodayStoreForTests();
});

afterEach(() => {
  expect(todayStore().writesInFlight).toBe(0);
  expect(todayStore().flow.running).toBeNull();
});

const kept = (mtime: string | null, text = "# Briefing\n"): KeptBriefing => ({
  file: { path: "/tmp/briefing-latest.md", text, bytes: text.length },
  key: `key-${text.length}`,
  mtime,
});

test("the initial store is the full declared shape", () => {
  const initial: TodayStoreState = {
    briefing: null,
    status: null,
    writesInFlight: 0,
    notNowSettled: 0,
    notNowOrigin: null,
    flow: { running: null, result: null },
  };
  expect(todayStore()).toEqual(initial);
});

test("startingLatest: an equal latestMtime starts loaded from the kept file", () => {
  const k = kept("2026-10-31T07:00:00Z");
  expect(startingLatest(k, "2026-10-31T07:00:00Z")).toEqual({ state: "loaded", file: k.file });
});

test("startingLatest: a newer latestMtime starts loading (yesterday's page never flashes)", () => {
  expect(startingLatest(kept("2026-10-30T07:00:00Z"), "2026-10-31T07:00:00Z")).toEqual({ state: "loading" });
});

test("startingLatest: a null latestMtime never matches, even against a null kept mtime", () => {
  expect(startingLatest(kept("2026-10-31T07:00:00Z"), null)).toEqual({ state: "loading" });
  expect(startingLatest(kept(null), null)).toEqual({ state: "loading" });
});

test("startingLatest: nothing kept starts loading", () => {
  expect(startingLatest(null, "2026-10-31T07:00:00Z")).toEqual({ state: "loading" });
  expect(startingLatest(null, null)).toEqual({ state: "loading" });
});

test("keepBriefing keeps a briefing, and keepBriefing(null) drops it", () => {
  const k = kept("2026-10-31T07:00:00Z");
  keepBriefing(k);
  expect(todayStore().briefing).toEqual(k);
  keepBriefing(null);
  expect(todayStore().briefing).toBeNull();
});

test("a subscriber on another route hears every change; its unsubscribe stops it", () => {
  const heard: (KeptBriefing | null)[] = [];
  const off = onTodayStore((s) => heard.push(s.briefing));
  // The immediate snapshot.
  expect(heard).toEqual([null]);
  const a = kept("2026-10-31T07:00:00Z", "a");
  const b = kept("2026-10-31T08:00:00Z", "bb");
  keepBriefing(a);
  keepBriefing(b);
  keepBriefing(null);
  expect(heard).toEqual([null, a, b, null]);
  off();
  keepBriefing(a);
  expect(heard).toEqual([null, a, b, null]);
});

test("resetTodayStoreForTests drops listeners and the briefing", () => {
  const heard: unknown[] = [];
  onTodayStore((s) => heard.push(s.briefing));
  keepBriefing(kept("2026-10-31T07:00:00Z"));
  resetTodayStoreForTests();
  expect(todayStore().briefing).toBeNull();
  const before = heard.length;
  keepBriefing(kept("2026-10-31T07:00:00Z"));
  expect(heard.length).toBe(before);
});

/* ── PB-M1 checkpoint MED: a mount's reads, and their invalidation at unmount ─────────────────────── */

/** A read the test answers by hand. */
function deferred(): { promise: Promise<BriefingFile | null>; resolve: (f: BriefingFile | null) => void; reject: (e: unknown) => void } {
  let resolve!: (f: BriefingFile | null) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<BriefingFile | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const fileOf = (text: string): BriefingFile => ({ path: "/state/briefing-latest.md", text, bytes: text.length });
const hashOf = (text: string): string => `h:${text}`;
const describe = (e: unknown): string => String(e);

test("briefingReads: a success keeps the file under the mtime it was read for, and answers loaded; no file keeps null and answers none", async () => {
  const reads = briefingReads(async () => fileOf("today"), describe, hashOf);
  expect(await reads.load("m1")).toEqual({ state: "loaded", file: fileOf("today") });
  expect(todayStore().briefing).toEqual({ file: fileOf("today"), key: "h:today", mtime: "m1" });
  const none = briefingReads(async () => null, describe, hashOf);
  expect(await none.load("m2")).toEqual({ state: "none" });
  expect(todayStore().briefing).toBeNull();
});

test("briefingReads: an error drops the kept briefing and answers the error", async () => {
  keepBriefing({ file: fileOf("kept"), key: "h:kept", mtime: "m0" });
  const reads = briefingReads(async () => {
    throw "unreadable";
  }, describe, hashOf);
  expect(await reads.load("m1")).toEqual({ state: "error", message: "unreadable" });
  expect(todayStore().briefing).toBeNull();
});

test("briefingReads: a read overtaken by a fresher one on the same mount keeps nothing and answers null", async () => {
  const first = deferred();
  const second = deferred();
  const queue = [first, second];
  const reads = briefingReads(() => queue.shift()!.promise, describe, hashOf);
  const a = reads.load("m1");
  const b = reads.load("m2");
  second.resolve(fileOf("new"));
  expect(await b).toEqual({ state: "loaded", file: fileOf("new") });
  first.resolve(fileOf("old"));
  expect(await a).toBeNull();
  expect(todayStore().briefing).toEqual({ file: fileOf("new"), key: "h:new", mtime: "m2" });
});

test("the MED regression: an old mount's read that lands after its unmount (success or error) never overwrites what a newer mount kept", async () => {
  for (const ending of ["success", "error"] as const) {
    resetTodayStoreForTests();
    const late = deferred();
    const oldMount = briefingReads(() => late.promise, describe, hashOf);
    const pending = oldMount.load("m-old");
    // Today unmounts (the route changed) with that read still pending: its cleanup invalidates it.
    oldMount.dispose();
    // A newer mount reads and keeps the fresher briefing.
    const newMount = briefingReads(async () => fileOf("fresh"), describe, hashOf);
    expect(await newMount.load("m-new")).toEqual({ state: "loaded", file: fileOf("fresh") });
    // The old read lands now.
    if (ending === "success") late.resolve(fileOf("stale"));
    else late.reject("late failure");
    expect({ ending, answer: await pending }).toEqual({ ending, answer: null });
    expect({ ending, kept: todayStore().briefing }).toEqual({ ending, kept: { file: fileOf("fresh"), key: "h:fresh", mtime: "m-new" } });
  }
});

/* ── PB-M3-T1: the store's status, its ordering, and the write chokepoint (spec §5) ────────────────── */

const statusJson = (o: Partial<CalendarStatusJson> = {}): CalendarStatusJson => ({
  schemaVersion: 1,
  enabled: true,
  enabledSet: true,
  macSupported: true,
  configWarnings: [],
  sources: [],
  ...o,
});
const outcomeOf = (payload: unknown): EngineOutcome => ({
  operation: "calendar-status",
  outcome: { kind: "delivered" },
  exitCode: 0,
  payload,
  stdout: "",
  stderr: "",
});
/** A promise the test settles by hand. */
function manual<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
type Field = keyof TodayStoreState;
const FIELDS: Field[] = ["briefing", "status", "writesInFlight", "notNowSettled", "notNowOrigin", "flow"];
/** R5C-L7: one transition changed exactly `changed`; every other field is the same value as before. PREMISE (checkpoint
 *  MED): the fields it claims unchanged are seeded non-null first (`seed`), so a transition that wrongly cleared one
 *  (the kept briefing, the stored reply, a held result) is seen. */
function onlyChanged(before: Readonly<TodayStoreState>, after: Readonly<TodayStoreState>, changed: Field[]): void {
  expect({ premise: "briefing seeded", ok: before.briefing !== null }).toEqual({ premise: "briefing seeded", ok: true });
  if (!changed.includes("status")) expect({ premise: "status seeded", ok: before.status !== null }).toEqual({ premise: "status seeded", ok: true });
  if (!changed.includes("flow")) expect({ premise: "result seeded", ok: before.flow.result !== null }).toEqual({ premise: "result seeded", ok: true });
  for (const f of FIELDS) {
    if (changed.includes(f)) continue;
    expect({ f, v: after[f] }).toEqual({ f, v: before[f] });
  }
}
/** A held result with no pending write: an accepted write never drops it. */
const HELD: FlowResult = { origin: "today", line: "Your calendar is on.", answered: true, drawn: true, pendingWrite: null };
/** A held result whose write failed ("Try again"): a later accepted write drops it. */
const HELD_PENDING: FlowResult = { origin: "today", line: "Not saved.", answered: true, drawn: true, pendingWrite: { enabled: true, then: "Your calendar is on." } };
/** Seed every field a calendar transition must leave alone: a kept briefing and a held result (and, with `status`, a
 *  stored reply, through an applied read). */
async function seed(o: { status?: CalendarStatusJson } = {}): Promise<void> {
  keepBriefing({ file: fileOf("kept"), key: "h:kept", mtime: "m-kept" });
  seedTodayStoreForTests({ flow: { running: null, result: HELD } });
  if (o.status !== undefined) expect((await readStatusThroughStore(async () => outcomeOf(o.status))).verdict).toBe("applied");
}
const SAVED: SaveOutcome = { kind: "saved", path: "/c.json", backupPath: "/c.json.bak", warnings: [] };
const INVALID: SaveOutcome = { kind: "invalid", errors: [], warnings: [] };

test("a failed read changes nothing: a throw, and a reply parseStatus refuses", async () => {
  const before = todayStore();
  const heard: unknown[] = [];
  const off = onTodayStore((s) => heard.push(s));
  const thrown = await readStatusThroughStore(async () => {
    throw "no engine";
  });
  expect(thrown).toEqual({ outcome: null, error: "no engine", verdict: "failed" });
  const bad = outcomeOf({ schemaVersion: 2 });
  expect(await readStatusThroughStore(async () => bad)).toEqual({ outcome: bad, error: null, verdict: "failed" });
  expect(todayStore()).toBe(before);
  expect(heard).toHaveLength(1);   // the immediate snapshot only
  off();
});

test("an applied read stores the whole parsed reply and publishes it (only status changes)", async () => {
  await seed();
  const before = todayStore();
  const heard: Readonly<TodayStoreState>[] = [];
  const off = onTodayStore((s) => heard.push(s));
  const reply = outcomeOf(statusJson({ enabled: false, enabledSet: false }));
  const r = await readStatusThroughStore(async () => reply);
  expect(r).toEqual({ outcome: reply, error: null, verdict: "applied" });
  expect(todayStore().status).toEqual(statusJson({ enabled: false, enabledSet: false }));
  onlyChanged(before, todayStore(), ["status"]);
  expect(heard).toHaveLength(2);
  expect(heard[1]!.status).toEqual(statusJson({ enabled: false, enabledSet: false }));
  // Each notification is a fresh snapshot.
  expect(heard[1]).not.toBe(heard[0]);
  off();
});

test("a read that overlapped a write is dropped; a read started while a write is in flight is dropped", async () => {
  // Overlapped: the read starts clean, a write starts and settles before it answers.
  const read = manual<EngineOutcome>();
  const pending = readStatusThroughStore(() => read.promise);
  await storeWrite(async () => SAVED, () => true);
  read.resolve(outcomeOf(statusJson()));
  expect((await pending).verdict).toBe("dropped");
  expect(todayStore().status).toBeNull();
  // Started during a write: dropped even though the write settles first.
  const write = manual<SaveOutcome>();
  const writing = storeWrite(() => write.promise, () => true);
  const during = readStatusThroughStore(async () => outcomeOf(statusJson()));
  write.resolve(SAVED);
  await writing;
  const r = await during;
  expect(r.verdict).toBe("dropped");
  // The caller still gets the outcome for its own display.
  expect(r.outcome).toEqual(outcomeOf(statusJson()));
  expect(todayStore().status).toBeNull();
});

test("an older read answering after a newer one is dropped", async () => {
  const older = manual<EngineOutcome>();
  const newer = manual<EngineOutcome>();
  const a = readStatusThroughStore(() => older.promise);
  const b = readStatusThroughStore(() => newer.promise);
  newer.resolve(outcomeOf(statusJson({ enabled: true })));
  expect((await b).verdict).toBe("applied");
  older.resolve(outcomeOf(statusJson({ enabled: false })));
  expect((await a).verdict).toBe("dropped");
  expect(todayStore().status?.enabled).toBe(true);
});

test("calendarConnectMac through storeWrite counts as a write (a read across it is dropped); connectWrote is its acceptance", async () => {
  const connect = manual<EngineOutcome>();
  const read = manual<EngineOutcome>();
  const reading = readStatusThroughStore(() => read.promise);
  const writing = storeWrite(() => connect.promise, connectWrote);
  expect(todayStore().writesInFlight).toBe(1);
  connect.resolve(outcomeOf({ status: "ok", configUpdated: true }));
  await writing;
  expect(todayStore().writesInFlight).toBe(0);
  read.resolve(outcomeOf(statusJson()));
  expect((await reading).verdict).toBe("dropped");
});

test("connectWrote: true only for payload.configUpdated === true", () => {
  expect(connectWrote(outcomeOf({ status: "ok", configUpdated: true }))).toBe(true);
  // `already` in the config, refused access, a failed insertion, and no or a malformed payload write nothing.
  expect(connectWrote(outcomeOf({ status: "ok", configUpdated: false, notAdded: "already" }))).toBe(false);
  expect(connectWrote(outcomeOf({ status: "not-granted", configUpdated: false }))).toBe(false);
  expect(connectWrote(outcomeOf({ status: "ok", configUpdated: false, notAdded: "write-failed" }))).toBe(false);
  expect(connectWrote(outcomeOf(null))).toBe(false);
  expect(connectWrote(outcomeOf([true]))).toBe(false);
  expect(connectWrote(outcomeOf({ status: "ok", configUpdated: "true" }))).toBe(false);
});

test("storeSaveBlock patches enabled/enabledSet on saved, created and unchanged; not on invalid; not when the block's enabled is absent or null", async () => {
  const created: SaveOutcome = { kind: "created", path: "/c.json", warnings: [] };
  const unchanged: SaveOutcome = { kind: "unchanged", path: "/c.json" };
  for (const [answer, enabled] of [[SAVED, true], [created, false], [unchanged, true]] as const) {
    resetTodayStoreForTests();
    await seed({ status: statusJson({ enabled: !enabled, enabledSet: false }) });
    const before = todayStore();
    const save = storeSaveBlock(async () => answer);
    expect(await save({ enabled, links: [] })).toBe(answer);
    expect({ k: answer.kind, s: todayStore().status }).toEqual({ k: answer.kind, s: statusJson({ enabled, enabledSet: true }) });
    onlyChanged(before, todayStore(), ["status"]);
  }
  for (const [answer, block] of [[INVALID, { enabled: true }], [SAVED, { links: [] }], [SAVED, { enabled: null }]] as const) {
    resetTodayStoreForTests();
    await readStatusThroughStore(async () => outcomeOf(statusJson({ enabled: false, enabledSet: false })));
    const before = todayStore();
    await storeSaveBlock(async () => answer)(block);
    expect({ block, s: todayStore().status }).toEqual({ block, s: before.status });
  }
  // With no stored reply there is nothing to patch: status stays null.
  resetTodayStoreForTests();
  await storeSaveBlock(async () => SAVED)({ enabled: true });
  expect(todayStore().status).toBeNull();
});

test("a deferred save publishes writesInFlight 0 → 1 → 0, accepted, invalid and thrown, and a subscriber sees both edges; nothing else changes", async () => {
  for (const ending of ["accepted", "invalid", "thrown"] as const) {
    resetTodayStoreForTests();
    await seed({ status: statusJson() });
    const save = manual<SaveOutcome>();
    const heard: Readonly<TodayStoreState>[] = [];
    const off = onTodayStore((s) => heard.push(s));
    const start = todayStore();
    const writing = storeSaveBlock(() => save.promise)({ links: [] });
    expect({ ending, n: heard.length, w: heard.map((s) => s.writesInFlight) }).toEqual({ ending, n: 2, w: [0, 1] });
    onlyChanged(start, heard[1]!, ["writesInFlight"]);
    if (ending === "accepted") save.resolve(SAVED);
    else if (ending === "invalid") save.resolve(INVALID);
    else save.reject("save failed");
    await writing.catch(() => {});
    expect({ ending, w: heard.map((s) => s.writesInFlight) }).toEqual({ ending, w: [0, 1, 0] });
    onlyChanged(heard[1]!, heard[2]!, ["writesInFlight"]);
    off();
  }
});

test("a thrown write still settles: storeWrite rethrows, and the counter returns to 0", async () => {
  await expect(storeWrite(async () => {
    throw new Error("link write failed");
  }, () => true)).rejects.toThrow("link write failed");
  expect(todayStore().writesInFlight).toBe(0);
});

test("applyCalendarOff: sent before a write → false after it; during an in-flight write → false; no write and null status → true, no reply fabricated; a stored reply → true and enabled patched false", async () => {
  await seed();
  // Sent before a write that has since settled.
  const sent = liveReadSent();
  await storeWrite(async () => SAVED, () => true);
  const before = todayStore();
  expect(applyCalendarOff(sent)).toBe(false);
  expect(todayStore()).toBe(before);
  // A refusal while a write is in flight.
  const write = manual<SaveOutcome>();
  const writing = storeWrite(() => write.promise, () => true);
  expect(applyCalendarOff(liveReadSent())).toBe(false);
  write.resolve(SAVED);
  await writing;
  // No write since, status null: the ordering verdict is true, and status stays null (nothing published).
  const quiet = todayStore();
  expect(applyCalendarOff(liveReadSent())).toBe(true);
  expect(todayStore()).toBe(quiet);
  expect(todayStore().status).toBeNull();
  // A stored reply: true, and enabled is patched false (only status changes).
  await readStatusThroughStore(async () => outcomeOf(statusJson({ enabled: true })));
  const on = todayStore();
  expect(applyCalendarOff(liveReadSent())).toBe(true);
  expect(todayStore().status).toEqual(statusJson({ enabled: false }));
  onlyChanged(on, todayStore(), ["status"]);
});

test("the derivations: calendarOn (null is off), neverAsked, malformed", () => {
  expect(calendarOn(null)).toBe(false);
  expect(calendarOn(statusJson({ enabled: false }))).toBe(false);
  expect(calendarOn(statusJson({ enabled: true }))).toBe(true);
  expect(neverAsked(null)).toBe(false);
  expect(neverAsked(statusJson({ enabledSet: false }))).toBe(true);
  expect(neverAsked(statusJson({ enabledSet: true }))).toBe(false);
  expect(malformed(statusJson({ configWarnings: ["calendar.emails must be a list — calendar off"] }))).toBe(true);
  expect(malformed(statusJson({ configWarnings: ["a url link was skipped"] }))).toBe(false);
  expect(malformed(statusJson())).toBe(false);
});

test("reset restores the counters too (after every write has settled)", async () => {
  await storeWrite(async () => SAVED, () => true);
  expect(liveReadSent()).toBe(2);
  await readStatusThroughStore(async () => outcomeOf(statusJson()));
  resetTodayStoreForTests();
  expect(liveReadSent()).toBe(0);
  expect(todayStore().status).toBeNull();
  expect((await readStatusThroughStore(async () => outcomeOf(statusJson()))).verdict).toBe("applied");
});

/* ── PB-M3 checkpoint MED: a link removal is a write once it resolves ───────────────────────────────── */

test("a link removal that resolves — even with its config step `invalid` (Rust deletes the file first) — wrote: it drops a held pendingWrite result; a held result without one survives", async () => {
  for (const config of [INVALID, SAVED, null] as const) {
    resetTodayStoreForTests();
    seedTodayStoreForTests({ flow: { running: null, result: HELD_PENDING } });
    const removed = await storeLinkRemove(async (id) => ({ id, file: "removed", config }))("work");
    expect(removed).toEqual({ id: "work", file: "removed", config });
    expect({ config: config?.kind ?? null, result: todayStore().flow.result }).toEqual({ config: config?.kind ?? null, result: null });
    expect(todayStore().writesInFlight).toBe(0);
  }
  resetTodayStoreForTests();
  seedTodayStoreForTests({ flow: { running: null, result: HELD } });
  await storeLinkRemove(async (id) => ({ id, file: "removed", config: INVALID }))("work");
  expect(todayStore().flow.result).toEqual(HELD);
});

test("PB r1 X8: a resolved removal is a write only when the file was removed or its config step saved — an idempotent one (file absent, config unchanged, none or invalid) keeps a held pendingWrite result", async () => {
  const UNCHANGED: SaveOutcome = { kind: "unchanged", path: "/c.json" };
  for (const [file, config, wrote] of [
    ["absent", UNCHANGED, false],
    ["absent", null, false],
    ["absent", INVALID, false],
    ["absent", SAVED, true],
    ["removed", INVALID, true],
    ["removed", UNCHANGED, true],
    ["removed", null, true],
  ] as const) {
    resetTodayStoreForTests();
    seedTodayStoreForTests({ flow: { running: null, result: HELD_PENDING } });
    expect(await storeLinkRemove(async (id) => ({ id, file, config }))("work")).toEqual({ id: "work", file, config });
    expect({ file, config: config?.kind ?? null, result: todayStore().flow.result })
      .toEqual({ file, config: config?.kind ?? null, result: wrote ? null : HELD_PENDING });
    expect(todayStore().writesInFlight).toBe(0);
  }
});

test("a link removal that rejects wrote nothing: the held pendingWrite result stays, and the counter settles", async () => {
  seedTodayStoreForTests({ flow: { running: null, result: HELD_PENDING } });
  await expect(storeLinkRemove(async () => {
    throw { kind: "io", detail: "busy" };
  })("work")).rejects.toEqual({ kind: "io", detail: "busy" });
  expect(todayStore().flow.result).toEqual(HELD_PENDING);
  expect(todayStore().writesInFlight).toBe(0);
});

/* ── PB-M5-T2: a removal Rust rejected AFTER deleting the file (`configAfterRemoval`) still wrote ──────── */

test("a link removal rejected with configAfterRemoval after the file was removed wrote: it drops a held pendingWrite result and still rejects; with the file absent it wrote nothing", async () => {
  const afterRemoval = (removed: "removed" | "absent") => ({ kind: "configAfterRemoval", removed, error: { kind: "conflict", path: "/c.json" } });
  seedTodayStoreForTests({ flow: { running: null, result: HELD_PENDING } });
  await expect(storeLinkRemove(async () => {
    throw afterRemoval("removed");
  })("work")).rejects.toEqual(afterRemoval("removed"));
  expect(todayStore().flow.result).toBeNull();
  expect(todayStore().writesInFlight).toBe(0);
  resetTodayStoreForTests();
  seedTodayStoreForTests({ flow: { running: null, result: HELD_PENDING } });
  await expect(storeLinkRemove(async () => {
    throw afterRemoval("absent");
  })("work")).rejects.toEqual(afterRemoval("absent"));
  expect(todayStore().flow.result).toEqual(HELD_PENDING);
});
