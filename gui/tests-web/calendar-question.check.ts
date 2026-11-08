/**
 * PB-M5 — the calendar question (`src/lib/calendar-question.ts`, and the flows in `src/lib/today-store.ts`; wave-2
 * polish spec §4).
 *
 * PB-M5-T1, the words: the explanation by starting state (Mac, a link already added with and without a readable Mac
 * source, the Link path), the busy lines (MAC_DIALOG_NOTE whole), and the composed result lines.
 *
 * PB-M5-T2, the flows in the store, with fake IO over a fake config file: each starting state's path and the Mac
 * outcomes; Not now and its settled-event counter; a failed follow-up write, Try again (its own retry, exempt from the
 * later-choice rule) and the later accepted writes that drop it (Settings saves, Allow access by `connectWrote`, link
 * writes and removals, another flow); results drawn, closed, and left on Today or in the wizard; the accepted-write patch
 * that keeps the question hidden after a failed re-read; and Today hearing Not now through `notNowEvent`.
 *
 * Isolation (plan §0.6): every test starts from `resetTodayStoreForTests()` and ends with no write in flight and no
 * flow running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

import CalendarSettings from "../src/lib/CalendarSettings.svelte";
import CalendarPage from "../src/lib/settings/CalendarPage.svelte";
import * as question from "../src/lib/calendar-question";
import type { CalendarListJson, CalendarStatusJson, CalendarStatusSource } from "../src/lib/calendar-contract";
import {
  ACCESS_TIMEOUT_LINE,
  accessRefusedLine,
  accessThrewLine,
  BUSY_ACCESS_LINE,
  BUSY_SAVING_LINE,
  calendarBusyLine,
  explanationFor,
  MAC_NOT_ADDED_LINE,
  MAC_NOT_CHECKED_LINE,
  notNowEvent,
  ON_LINE,
  startingState,
} from "../src/lib/calendar-question";
import { addLink, CONFIG_OFF_SUFFIX, LINK_PANEL_IDLE, linkPanelState, MAC_DIALOG_NOTE, type CalendarBlock } from "../src/lib/calendar-settings";
import type { EngineOutcome } from "../src/lib/engine";
import { describeFailure, type SaveOutcome } from "../src/lib/files";
import {
  canStart,
  close,
  closeLinkSession,
  connectWrote,
  keepBriefing,
  leaveToday,
  malformed,
  leaveWizard,
  markDrawn,
  neverAsked,
  notNow,
  onTodayStore,
  readStatusThroughStore,
  resetTodayStoreForTests,
  seedTodayStoreForTests,
  startShow,
  storeLinkRemove,
  storeSaveBlock,
  storeWrite,
  todayStore,
  tryAgain,
  type FlowIo,
  type FlowResult,
  type TodayStoreState,
} from "../src/lib/today-store";

beforeEach(() => {
  resetTodayStoreForTests();
});

afterEach(() => {
  expect(todayStore().writesInFlight).toBe(0);
  expect(todayStore().flow.running).toBeNull();
});

const MAC: CalendarStatusSource = { id: "macos", kind: "macos", lastScheduledRead: null };
const LINK: CalendarStatusSource = { id: "home", kind: "link", name: "Home", lastScheduledRead: null };
const statusOf = (sources: CalendarStatusSource[], macSupported: boolean): CalendarStatusJson => ({
  schemaVersion: 1, enabled: false, enabledSet: false, macSupported, configWarnings: [], sources,
});
const outcomeOf = (payload: unknown, exitCode: number | null = 0): EngineOutcome => ({
  operation: "calendar-connect-mac", outcome: { kind: "delivered" } as never, exitCode, payload, stdout: "", stderr: "",
}) as EngineOutcome;

const REST =
  ". They go to the AI that writes your briefing, with your morning request, so it can fit its suggestions around your " +
  "meetings. You can change this any time in Settings → Calendar.";

describe("PB-M5-T1: the words", () => {
  test("the explanation follows the path Show my calendar takes, never only the platform", () => {
    const cases: [string, CalendarStatusJson, ReturnType<typeof startingState>, string][] = [
      ["Mac: macSupported, no link", statusOf([], true), "mac", "from the Calendar app on this Mac"],
      ["Mac: macSupported, the Mac source already there, no link", statusOf([MAC], true), "mac", "from the Calendar app on this Mac"],
      ["a link with the Mac source, macSupported", statusOf([MAC, LINK], true), "link", "from the calendar link you've added and the Calendar app on this Mac"],
      // status lists a `macos` source on any darwin, even where macOS is too old to read it: the Mac is not named.
      ["a link with the Mac source, no macSupported", statusOf([MAC, LINK], false), "link", "from the calendar link you've added"],
      ["a link alone (macSupported)", statusOf([LINK], true), "link", "from the calendar link you've added"],
      ["a link alone (Linux)", statusOf([LINK], false), "link", "from the calendar link you've added"],
      ["no link, no macSupported: the Link path", statusOf([], false), "linkPath", "from a private calendar link you add (for example your Google Calendar's secret address)"],
      ["a Mac source on an old macOS, no link: the Link path", statusOf([MAC], false), "linkPath", "from a private calendar link you add (for example your Google Calendar's secret address)"],
    ];
    for (const [label, status, state, from] of cases) {
      expect({ label, state: startingState(status), text: explanationFor(status) })
        .toEqual({ label, state, text: `Daily Briefing reads today's events ${from}${REST}` });
    }
  });

  test("calendarBusyLine: saving, access (with the whole dialog note), and none", () => {
    expect(calendarBusyLine("saving")).toBe("Saving your calendar choice…");
    expect(calendarBusyLine("access")).toBe(`Waiting for calendar access. ${MAC_DIALOG_NOTE}`);
    expect(calendarBusyLine("access")).toBe(
      'Waiting for calendar access. macOS asks for permission in a dialog that names "Daily Briefing Calendar Reader", not this app.',
    );
    expect(calendarBusyLine(undefined)).toBeNull();
    expect<(string | null)[]>([BUSY_SAVING_LINE, BUSY_ACCESS_LINE]).toEqual([calendarBusyLine("saving"), calendarBusyLine("access")]);
  });

  test("the composed access lines: a grant has none; a refusal says the engine's reason then where to allow it; a throw", () => {
    expect(accessRefusedLine(outcomeOf({ schemaVersion: 1, status: "ok", configUpdated: true }))).toBeNull();
    expect(accessRefusedLine(outcomeOf({ schemaVersion: 1, status: "denied" }, 1))).toBe(
      "Mac Calendar: calendar access was denied — allow it in System Settings → Privacy & Security → Calendars. You can allow it later in Settings → Calendar.",
    );
    expect(accessRefusedLine(outcomeOf({ schemaVersion: 1, status: "helper-missing", reason: "sign-failed" }, 1))).toMatch(
      /^Mac Calendar: .+ — the calendar reader could not be signed .+ Try again\. You can allow it later in Settings → Calendar\.$/,
    );
    expect(accessRefusedLine(outcomeOf(null, 2))).toBe(
      "The engine did not answer the calendar access request (exit 2). You can allow it later in Settings → Calendar.",
    );
    expect(accessThrewLine({ kind: "timeout", operation: "calendar-connect-mac", seconds: 150 })).toBe(ACCESS_TIMEOUT_LINE);
    expect(ACCESS_TIMEOUT_LINE).toBe("Allowing calendar access took too long and was stopped. You can try again in Settings → Calendar.");
    // PB r1 X2: a description with no closing punctuation gets its period before the advice (no run-on sentence).
    expect(accessThrewLine({ kind: "spawn", detail: "the engine could not be started" })).toBe(
      "Couldn't ask for calendar access: the engine could not be started. You can try again in Settings → Calendar.",
    );
    expect(accessThrewLine({ kind: "unsupported", detail: "Mac Calendar is macOS only." })).toBe(
      "Couldn't ask for calendar access: Mac Calendar is macOS only. You can try again in Settings → Calendar.",
    );
  });

  test("PB r1 X2: the advice follows a full sentence and comes before any stderr tail (no run-on, no advice after the engine's trace)", () => {
    expect(accessThrewLine({ kind: "invalidInput", field: "calendar", reason: "is not allowed here" })).toBe(
      "Couldn't ask for calendar access: calendar is not allowed here. You can try again in Settings → Calendar.",
    );
    expect(accessThrewLine({ kind: "engine", detail: "Is the engine installed?" })).toBe(
      "Couldn't ask for calendar access: Is the engine installed? You can try again in Settings → Calendar.",
    );
    expect(accessThrewLine({ kind: "spawn", detail: "the engine stopped\nTrace: line 2" })).toBe(
      "Couldn't ask for calendar access: the engine stopped. You can try again in Settings → Calendar.\nTrace: line 2",
    );
    const noJson = { ...outcomeOf(null, 2), stderr: "panic: reader\nat main" };
    expect(accessRefusedLine(noJson)).toBe(
      "The engine did not answer the calendar access request (exit 2). You can allow it later in Settings → Calendar.\npanic: reader\nat main",
    );
  });
});

/* ── PB-M5-T2: the flows in the store ─────────────────────────────────────────────────────────────── */

const SAVED: SaveOutcome = { kind: "saved", path: "/c.json", backupPath: "/c.json.bak", warnings: [] };
const INVALID: SaveOutcome = { kind: "invalid", errors: [{ field: "calendar", message: "bad" }], warnings: [] };
const BUSY = { kind: "busy", running: "run" };
/** A write the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const statusReply = (o: Partial<CalendarStatusJson> = {}): CalendarStatusJson => ({
  schemaVersion: 1, enabled: false, enabledSet: false, macSupported: false, configWarnings: [], sources: [], ...o,
});
const connectReply = (payload: unknown): EngineOutcome => outcomeOf(payload, (payload as { status?: unknown } | null)?.status === "ok" ? 0 : 1);
const GRANTED = { schemaVersion: 1, status: "ok", configUpdated: true };
const ALREADY = { schemaVersion: 1, status: "ok", configUpdated: false, macos: "already" };

/** Fake IO over a fake config file: saves write the block to it; status answers from a queue, then from the file. */
function fakeIo(o: {
  calendar?: CalendarBlock;
  sources?: CalendarStatusSource[];
  macSupported?: boolean;
  reads?: ("throw" | "bad" | "drop" | CalendarStatusJson)[];
  save?: (block: CalendarBlock) => Promise<SaveOutcome>;
  connect?: () => Promise<EngineOutcome>;
} = {}) {
  let disk: CalendarBlock | undefined = o.calendar;
  const saved: CalendarBlock[] = [];
  const counts = { reads: 0, connects: 0 };
  const queue = [...(o.reads ?? [])];
  const fromDisk = (): CalendarStatusJson => statusReply({
    enabled: disk?.["enabled"] === true,
    enabledSet: disk !== undefined && disk["enabled"] !== undefined && disk["enabled"] !== null,
    macSupported: o.macSupported ?? false,
    sources: o.sources ?? [],
  });
  const io: FlowIo = {
    status: async () => {
      counts.reads++;
      const next = queue.shift();
      if (next === "throw") throw { kind: "spawn", detail: "no engine" };
      if (next === "bad") return outcomeOf({ schemaVersion: 2 });
      if (next === "drop") {
        await storeWrite(async () => undefined, () => false); // a write overlaps this read: the store drops it
        return outcomeOf(fromDisk());
      }
      return outcomeOf(next ?? fromDisk());
    },
    connectMac: async () => {
      counts.connects++;
      return o.connect ? o.connect() : connectReply(GRANTED);
    },
    readConfig: async () => ({
      path: "/c.json", exists: true, text: JSON.stringify(disk === undefined ? { repos: [] } : { repos: [], calendar: disk }),
      base: null, parseError: null, apiKeyRedacted: false,
    }),
    saveBlock: async (block) => {
      saved.push(block);
      const outcome = o.save ? await o.save(block) : SAVED;
      if (outcome.kind !== "invalid") disk = block;
      return outcome;
    },
  };
  return { io, saved, counts, disk: () => disk };
}
/** Store the reply, as the app-start read does. */
async function stored(s: CalendarStatusJson): Promise<void> {
  expect((await readStatusThroughStore(async () => outcomeOf(s))).verdict).toBe("applied");
}
/** Every published `flow` and `writesInFlight`, in order. */
function recorder() {
  const seen: Pick<TodayStoreState, "flow" | "writesInFlight">[] = [];
  const off = onTodayStore((s) => seen.push({ flow: s.flow, writesInFlight: s.writesInFlight }));
  const phases = () => seen.map((s) => (s.flow.running === null ? null : `${s.flow.running.origin}:${s.flow.running.phase}`))
    .filter((p, i, all) => i === 0 || p !== all[i - 1]);
  return { seen, off, phases };
}

describe("PB-M5-T2: canStart, and no flow while any write is in flight", () => {
  test("a Settings write in flight blocks both flows (nothing written); its settle — accepted, invalid or thrown — re-enables", async () => {
    await stored(statusReply({ sources: [LINK] }));
    for (const settle of ["accepted", "invalid", "thrown"] as const) {
      const f = fakeIo({ calendar: {}, sources: [LINK] });
      const save = deferred<SaveOutcome>();
      const settings = storeSaveBlock(() => save.promise)({ enabled: true });
      expect({ settle, canStart: canStart(), writes: todayStore().writesInFlight }).toEqual({ settle, canStart: false, writes: 1 });
      expect(await startShow("today", f.io)).toBe("blocked");
      expect(await notNow("today", f.io)).toBe("blocked");
      expect(f.saved).toEqual([]);
      expect(todayStore().flow.running).toBeNull();
      if (settle === "thrown") {
        save.reject(BUSY);
        await expect(settings).rejects.toEqual(BUSY);
      } else {
        save.resolve(settle === "accepted" ? SAVED : INVALID);
        await settings;
      }
      expect({ settle, canStart: canStart() }).toEqual({ settle, canStart: true });
    }
  });

  test("a double press makes one write: the second press finds the flow running", async () => {
    await stored(statusReply({ sources: [LINK] }));
    const f = fakeIo({ calendar: {}, sources: [LINK] });
    const [a, b] = await Promise.all([startShow("today", f.io), startShow("today", f.io)]);
    expect([a, b]).toEqual(["on", "blocked"]);
    expect(f.saved).toEqual([{ enabled: true }]);
    const n = fakeIo({ calendar: {} });
    expect(await Promise.all([notNow("today", n.io), notNow("today", n.io)])).toEqual(["notNow", "blocked"]);
    expect(n.saved).toEqual([{ enabled: false }]);
  });

  test("no stored status: Show my calendar starts nothing", async () => {
    const f = fakeIo();
    expect(await startShow("today", f.io)).toBe("blocked");
    expect([f.saved, f.counts]).toEqual([[], { reads: 0, connects: 0 }]);
  });
});

describe("PB-M5-T2: Show my calendar by starting state", () => {
  test("D3 — a link already added: one withEnabled(true) save (the link kept), phase saving, a re-read, 'Your calendar is on.'", async () => {
    const block = { links: [{ id: "home", name: "Home" }] };
    await stored(statusReply({ sources: [LINK] }));
    const f = fakeIo({ calendar: block, sources: [LINK] });
    const r = recorder();
    expect(await startShow("today", f.io)).toBe("on");
    expect(f.saved).toEqual([{ ...block, enabled: true }]);
    expect(f.counts).toEqual({ reads: 1, connects: 0 });
    expect(r.phases()).toEqual([null, "today:saving", null]);
    expect(todayStore().flow).toEqual({ running: null, result: { origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null } });
    r.off();
  });

  test("a literal-url link is not listed by the engine, so it is not D3: no link source and no macSupported is the Link path — no flow", async () => {
    await stored(statusReply({ sources: [] }));
    const f = fakeIo({ calendar: { links: [{ id: "work", url: "https://x.example/c.ics" }] } });
    expect(await startShow("today", f.io)).toBe("link");
    expect([f.saved, f.counts, todayStore().flow]).toEqual([[], { reads: 0, connects: 0 }, { running: null, result: null }]);
  });

  test("Mac — granted and added: phase access (connect is a write), then saving; the re-read lists macos → withEnabled(true)", async () => {
    await stored(statusReply({ macSupported: true }));
    const connect = deferred<EngineOutcome>();
    const f = fakeIo({ calendar: {}, macSupported: true, sources: [MAC], connect: () => connect.promise });
    const r = recorder();
    const run = startShow("today", f.io);
    await Promise.resolve();
    expect({ running: todayStore().flow.running, writes: todayStore().writesInFlight })
      .toEqual({ running: { origin: "today", phase: "access" }, writes: 1 });
    connect.resolve(connectReply(GRANTED));
    expect(await run).toBe("on");
    expect(r.phases()).toEqual([null, "today:access", "today:saving", null]);
    expect(f.saved).toEqual([{ enabled: true }]);
    expect(todayStore().flow.result?.line).toBe(ON_LINE);
    r.off();
  });

  test("Mac — an existing Mac source reported `already` (configUpdated false) is not an access failure: re-read lists it, turned on", async () => {
    await stored(statusReply({ macSupported: true, sources: [MAC] }));
    const f = fakeIo({ calendar: { macos: {} }, macSupported: true, sources: [MAC], connect: async () => connectReply(ALREADY) });
    expect(await startShow("today", f.io)).toBe("on");
    expect(f.saved).toEqual([{ macos: {}, enabled: true }]);
    expect(todayStore().flow.result).toEqual({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null });
  });

  test("Mac — granted, but the re-read lists no macos source: written off, 'couldn't be added'", async () => {
    await stored(statusReply({ macSupported: true }));
    const f = fakeIo({ calendar: {}, macSupported: true, sources: [], connect: async () => connectReply({ ...GRANTED, configUpdated: false }) });
    expect(await startShow("today", f.io)).toBe("off");
    expect(f.saved).toEqual([{ enabled: false }]);
    expect(todayStore().flow.result).toEqual({ origin: "today", line: MAC_NOT_ADDED_LINE, answered: true, drawn: false, pendingWrite: null });
  });

  test("Mac — granted, both re-reads fail (a throw, then an unparseable reply): written off, 'couldn't be checked'", async () => {
    await stored(statusReply({ macSupported: true }));
    const f = fakeIo({ calendar: {}, macSupported: true, sources: [MAC], reads: ["throw", "bad"] });
    expect(await startShow("today", f.io)).toBe("off");
    expect(f.saved).toEqual([{ enabled: false }]);
    expect(todayStore().flow.result?.line).toBe(MAC_NOT_CHECKED_LINE);
  });

  test("Mac — the first re-read fails or is dropped, the second lists macos: turned on (read twice)", async () => {
    for (const first of ["throw", "drop"] as const) {
      resetTodayStoreForTests();
      await stored(statusReply({ macSupported: true }));
      const f = fakeIo({ calendar: {}, macSupported: true, sources: [MAC], reads: [first] });
      expect({ first, end: await startShow("today", f.io) }).toEqual({ first, end: "on" });
      expect({ first, saved: f.saved }).toEqual({ first, saved: [{ enabled: true }] });
    }
  });

  test("Mac — refused or failed (any status but ok, or no JSON answer): written off with connectMacMessage's line + where to allow it", async () => {
    for (const payload of [{ schemaVersion: 1, status: "denied" }, { schemaVersion: 1, status: "helper-missing", reason: "copy-failed" }, null]) {
      resetTodayStoreForTests();
      await stored(statusReply({ macSupported: true }));
      const reply = connectReply(payload);
      const f = fakeIo({ calendar: {}, macSupported: true, connect: async () => reply });
      expect(await startShow("today", f.io)).toBe("off");
      expect(f.saved).toEqual([{ enabled: false }]);
      expect(todayStore().flow.result).toEqual({ origin: "today", line: accessRefusedLine(reply) ?? "(a grant)", answered: true, drawn: false, pendingWrite: null });
      expect(todayStore().flow.result?.line).toEndWith(" You can allow it later in Settings → Calendar.");
    }
  });

  test("Mac — the connect call threw busy: nothing written, no result, no re-read (the only busy test, R5C-L5)", async () => {
    await stored(statusReply({ macSupported: true }));
    const f = fakeIo({ calendar: {}, macSupported: true, connect: async () => {
      throw BUSY;
    } });
    expect(await startShow("today", f.io)).toBe("busy");
    expect([f.saved, f.counts.reads, todayStore().flow, todayStore().writesInFlight]).toEqual([[], 0, { running: null, result: null }, 0]);
  });

  test("Mac — the connect call threw timeout or another kind: written off with its line", async () => {
    for (const [e, line] of [
      [{ kind: "timeout", operation: "calendar-connect-mac", seconds: 150 }, ACCESS_TIMEOUT_LINE],
      [{ kind: "spawn", detail: "the engine could not be started" }, accessThrewLine({ kind: "spawn", detail: "the engine could not be started" })],
    ] as const) {
      resetTodayStoreForTests();
      await stored(statusReply({ macSupported: true }));
      const f = fakeIo({ calendar: {}, macSupported: true, connect: async () => {
        throw e;
      } });
      // PB final LOW L4: the write-off after a non-busy throw runs in phase saving (its busy line), as a grant's does.
      const r = recorder();
      expect(await startShow("today", f.io)).toBe("off");
      expect(f.saved).toEqual([{ enabled: false }]);
      expect(todayStore().flow.result?.line).toBe(line);
      expect({ kind: e.kind, phases: r.phases() }).toEqual({ kind: e.kind, phases: [null, "today:access", "today:saving", null] });
      r.off();
    }
  });

  test("a busy-style failure on a D3 block save is a failed write (editBlock's { ok: false }), with pendingWrite held", async () => {
    await stored(statusReply({ sources: [LINK] }));
    const f = fakeIo({ calendar: {}, sources: [LINK], save: async () => {
      throw BUSY;
    } });
    expect(await startShow("today", f.io)).toBe("failed");
    expect(todayStore().flow.result).toEqual({
      origin: "today", line: describeFailure(BUSY), answered: false, drawn: false, pendingWrite: { enabled: true, then: ON_LINE },
    });
  });

  test("the Link path closes through closeLinkSession: phase saving, one re-read, no write; enabledSet true → on, else unanswered", async () => {
    await stored(statusReply());
    const on = fakeIo({ calendar: { enabled: true, links: [{ id: "home" }] }, sources: [LINK] });
    const r = recorder();
    expect(await closeLinkSession("today", on.io)).toBe("on");
    expect(r.phases()).toEqual([null, "today:saving", null]);
    expect([on.saved, on.counts.reads]).toEqual([[], 1]);
    expect(todayStore().flow.result).toEqual({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null });
    r.off();
    resetTodayStoreForTests();
    await stored(statusReply());
    const none = fakeIo({ calendar: {} });
    expect(await closeLinkSession("wizard", none.io)).toBe("unanswered");
    expect([none.saved, todayStore().flow]).toEqual([[], { running: null, result: null }]);
  });
});

describe("PB-M5-T2: Not now", () => {
  test("writes enabled: false, leaves flow.result null, and counts one settled event with its origin; a failure counts nothing", async () => {
    await stored(statusReply());
    const f = fakeIo({ calendar: {} });
    const r = recorder();
    expect(await notNow("today", f.io)).toBe("notNow");
    expect(f.saved).toEqual([{ enabled: false }]);
    expect(r.phases()).toEqual([null, "today:saving", null]);
    expect(todayStore()).toMatchObject({ notNowSettled: 1, notNowOrigin: "today", flow: { running: null, result: null } });
    r.off();
    const failing = fakeIo({ calendar: {}, save: async () => INVALID });
    expect(await notNow("wizard", failing.io)).toBe("failed");
    expect(todayStore()).toMatchObject({ notNowSettled: 1, notNowOrigin: "today" });
    expect(todayStore().flow.result).toEqual({
      origin: "wizard", line: "Not saved: calendar: bad", answered: false, drawn: false, pendingWrite: { enabled: false, then: null },
    });
  });
});

describe("PB-M5-T2: a failed follow-up write, Try again, and a later choice", () => {
  const failures: [string, (io: FlowIo) => Promise<string>, () => Promise<void>, { enabled: boolean; then: string | null }][] = [
    ["D3", (io) => startShow("today", io), () => stored(statusReply({ sources: [LINK] })), { enabled: true, then: ON_LINE }],
    ["the Mac flow (written off)", (io) => startShow("today", io), () => stored(statusReply({ macSupported: true })), { enabled: false, then: MAC_NOT_ADDED_LINE }],
    ["Not now", (io) => notNow("today", io), () => stored(statusReply()), { enabled: false, then: null }],
  ];
  for (const [label, run, before, pendingWrite] of failures) {
    test(`${label}: the save fails → result with pendingWrite; a remount retries nothing; Try again succeeds with then`, async () => {
      await before();
      let fail = true;
      const f = fakeIo({
        calendar: {}, sources: label === "D3" ? [LINK] : [], macSupported: label !== "D3",
        connect: async () => connectReply({ ...GRANTED, configUpdated: false }),
        save: async () => (fail ? INVALID : SAVED),
      });
      expect(await run(f.io)).toBe("failed");
      const held = todayStore().flow.result;
      expect(held).toEqual({ origin: "today", line: "Not saved: calendar: bad", answered: false, drawn: false, pendingWrite });
      // "Remount": a new subscriber on the kept store — the result is there, and nothing is retried by itself.
      const remount = recorder();
      expect(remount.seen[0]?.flow.result).toEqual(held);
      expect(f.saved).toHaveLength(1);
      fail = false;
      const settled = todayStore().notNowSettled;
      const end = await tryAgain(f.io);
      expect(f.saved).toHaveLength(2);
      expect(f.saved[1]).toEqual({ enabled: pendingWrite.enabled });
      // The retry is the held result's own write: the settle hook never drops it on the way (no intermediate null).
      expect(remount.seen.slice(1, -1).every((s) => s.flow.result === held)).toBe(true);
      if (pendingWrite.then === null) {
        expect(end).toBe("notNow");
        expect(todayStore().flow.result).toBeNull();
        expect(todayStore().notNowSettled).toBe(settled + 1);
      } else {
        expect(end).toBe(pendingWrite.enabled ? "on" : "off");
        expect(todayStore().flow.result).toEqual({ origin: "today", line: pendingWrite.then, answered: true, drawn: false, pendingWrite: null });
      }
      remount.off();
    });
  }

  test("Try again with nothing held, or while a write is in flight, starts nothing", async () => {
    const f = fakeIo({ calendar: {} });
    expect(await tryAgain(f.io)).toBe("blocked");
    seedTodayStoreForTests({ flow: { running: null, result: { origin: "today", line: "x", answered: true, drawn: true, pendingWrite: null } } });
    expect(await tryAgain(f.io)).toBe("blocked");
    expect(f.saved).toEqual([]);
  });

  /** A failed Not now, held. */
  async function heldNotNow(): Promise<FlowResult> {
    await stored(statusReply());
    expect(await notNow("today", fakeIo({ calendar: {}, save: async () => INVALID }).io)).toBe("failed");
    const held = todayStore().flow.result!;
    expect(held.pendingWrite).toEqual({ enabled: false, then: null });
    return held;
  }

  test("a later accepted Settings save drops both the pendingWrite and its result; an invalid or thrown one keeps both", async () => {
    const held = await heldNotNow();
    await storeSaveBlock(async () => INVALID)({ enabled: true });
    expect(todayStore().flow.result).toBe(held);
    await expect(storeSaveBlock(async () => {
      throw BUSY;
    })({ enabled: true })).rejects.toEqual(BUSY);
    expect(todayStore().flow.result).toBe(held);
    await storeSaveBlock(async () => SAVED)({ enabled: true });
    expect(todayStore().flow.result).toBeNull();
  });

  test("after a failed Not now, Settings' Allow access (calendarConnectMac only) that wrote clears both; already, refused and failed-insert keep both", async () => {
    for (const [payload, clears] of [
      [{ schemaVersion: 1, status: "ok", configUpdated: false, macos: "already" }, false],
      [{ schemaVersion: 1, status: "denied" }, false],
      [{ schemaVersion: 1, status: "ok", configUpdated: false }, false],   // granted, insertion failed
      [GRANTED, true],
    ] as const) {
      resetTodayStoreForTests();
      const held = await heldNotNow();
      await storeWrite(async () => connectReply(payload), connectWrote);
      expect({ payload, result: todayStore().flow.result }).toEqual({ payload, result: clears ? null : held });
    }
  });

  test("an accepted link write or link removal clears both", async () => {
    await heldNotNow();
    await storeWrite(async () => ({ id: "home", path: "/s/home.url", replaced: false, confirmationCleared: false }), () => true);
    expect(todayStore().flow.result).toBeNull();
    resetTodayStoreForTests();
    await heldNotNow();
    await storeLinkRemove(async (id) => ({ id, file: "removed", config: SAVED }))("home");
    expect(todayStore().flow.result).toBeNull();
  });

  test("another flow's accepted write drops the held result too (a later choice wins), then shows its own", async () => {
    await heldNotNow();
    const f = fakeIo({ calendar: {}, sources: [LINK] });
    await stored(statusReply({ sources: [LINK] }));
    expect(await startShow("today", f.io)).toBe("on");
    expect(todayStore().flow.result).toEqual({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null });
  });
});

describe("PB-M5-T2: results — drawn, Close, leaving Today and the wizard", () => {
  test("markDrawn returns a Today result's line once; never a wizard result's; leaveToday clears only a drawn result with no pendingWrite", async () => {
    await stored(statusReply({ sources: [LINK] }));
    expect(markDrawn()).toBeNull();
    expect(await startShow("today", fakeIo({ calendar: {}, sources: [LINK] }).io)).toBe("on");
    leaveToday();   // not drawn yet (reached while Today was away): kept for the next Today view
    expect(todayStore().flow.result?.drawn).toBe(false);
    expect(markDrawn()).toBe(ON_LINE);
    expect(markDrawn()).toBeNull();
    expect(todayStore().flow.result?.drawn).toBe(true);
    leaveToday();
    expect(todayStore().flow.result).toBeNull();
    // A drawn result with a pendingWrite survives leaving Today.
    const pending: FlowResult = { origin: "today", line: "Not saved.", answered: false, drawn: true, pendingWrite: { enabled: true, then: ON_LINE } };
    seedTodayStoreForTests({ flow: { running: null, result: pending } });
    leaveToday();
    expect(todayStore().flow.result).toBe(pending);
    const wizard: FlowResult = { ...pending, origin: "wizard", drawn: false, pendingWrite: null };
    seedTodayStoreForTests({ flow: { running: null, result: wizard } });
    expect(markDrawn()).toBeNull();
    leaveToday();
    expect(todayStore().flow.result).toBe(wizard);
  });

  test("Close clears the result (a pendingWrite included) and nothing on disk", async () => {
    await stored(statusReply({ sources: [LINK] }));
    const f = fakeIo({ calendar: {}, sources: [LINK], save: async () => INVALID });
    expect(await startShow("today", f.io)).toBe("failed");
    close();
    expect(todayStore().flow.result).toBeNull();
    expect(f.disk()).toEqual({});
    const ok = fakeIo({ calendar: {}, sources: [LINK] });
    expect(await startShow("today", ok.io)).toBe("on");
    close();
    expect([todayStore().flow.result, ok.disk()]).toEqual([null, { enabled: true }]);
  });

  test("leaveWizard drops a wizard result and its pendingWrite, never a Today one", async () => {
    const wizard: FlowResult = { origin: "wizard", line: "Not saved.", answered: false, drawn: false, pendingWrite: { enabled: false, then: null } };
    seedTodayStoreForTests({ flow: { running: null, result: wizard } });
    leaveWizard();
    expect(todayStore().flow.result).toBeNull();
    const today: FlowResult = { ...wizard, origin: "today" };
    seedTodayStoreForTests({ flow: { running: null, result: today } });
    leaveWizard();
    expect(todayStore().flow.result).toBe(today);
  });

  test("a wizard flow still running at leaveWizard finishes in the store and drops its result (pendingWrite included) on settle; its kind still reaches onanswered", async () => {
    for (const fails of [false, true]) {
      resetTodayStoreForTests();
      await stored(statusReply({ sources: [LINK] }));
      const save = deferred<SaveOutcome>();
      const f = fakeIo({ calendar: {}, sources: [LINK], save: () => save.promise });
      const run = startShow("wizard", f.io);
      await Promise.resolve();
      await Promise.resolve();
      expect(todayStore().flow.running).toEqual({ origin: "wizard", phase: "saving" });
      leaveWizard();
      save.resolve(fails ? INVALID : SAVED);
      expect({ fails, end: await run }).toEqual({ fails, end: fails ? "failed" : "on" });
      expect({ fails, flow: todayStore().flow }).toEqual({ fails, flow: { running: null, result: null } });
    }
  });

  test("leaveWizard does not reach a later flow: the next flow's result is kept", async () => {
    await stored(statusReply({ sources: [LINK] }));
    leaveWizard();
    expect(await startShow("wizard", fakeIo({ calendar: {}, sources: [LINK] }).io)).toBe("on");
    expect(todayStore().flow.result?.line).toBe(ON_LINE);
  });
});

describe("PB-M5-T2: an accepted write patches the store, so a failed re-read keeps the question hidden (B-F3)", () => {
  const neverAskedReply = statusReply({ macSupported: true, sources: [] });
  test("successful Not now, D3, and a failure written off — each re-read failing", async () => {
    const cases: [string, (io: FlowIo) => Promise<string>, CalendarStatusJson, boolean][] = [
      ["Not now", (io) => notNow("today", io), neverAskedReply, false],
      ["D3", (io) => startShow("today", io), statusReply({ sources: [LINK] }), true],
      ["Mac refused, written off", (io) => startShow("today", io), neverAskedReply, false],
    ];
    for (const [label, run, before, enabled] of cases) {
      resetTodayStoreForTests();
      await stored(before);
      expect({ label, asked: neverAsked(todayStore().status) }).toEqual({ label, asked: true });
      const f = fakeIo({
        calendar: {}, sources: before.sources, macSupported: true, reads: ["throw", "throw", "throw"],
        connect: async () => connectReply({ schemaVersion: 1, status: "denied" }),
      });
      await run(f.io);
      expect({ label, enabled: todayStore().status?.enabled, enabledSet: todayStore().status?.enabledSet, asked: neverAsked(todayStore().status) })
        .toEqual({ label, enabled, enabledSet: true, asked: false });
    }
  });

  test("the add-link save (the Link session's panel) patches through the same storeSaveBlock", async () => {
    await stored(statusReply());
    let disk: CalendarBlock = {};
    const result = await addLink({ id: "home", name: "Home", takeUrl: () => "https://cal.example/secret.ics" }, {
      writeLink: async (id) => ({ id, path: `/s/${id}.url`, replaced: false, confirmationCleared: false }),
      readConfig: async () => ({ path: "/c.json", exists: true, text: JSON.stringify({ calendar: disk }), base: null, parseError: null, apiKeyRedacted: false }),
      saveBlock: storeSaveBlock(async (block) => {
        disk = block;
        return SAVED;
      }),
      list: async () => {
        throw { kind: "spawn", detail: "no engine" };
      },
    }, describeFailure, { turnOn: true });
    expect(result.kind).toBe("added");
    expect({ enabled: todayStore().status?.enabled, enabledSet: todayStore().status?.enabledSet }).toEqual({ enabled: true, enabledSet: true });
    expect(todayStore().writesInFlight).toBe(0);
  });
});

describe("PB-M5-T2: Today hears Not now through the store (notNowEvent), whoever started it", () => {
  test("notNowEvent fires only for a new Today-origin event, and always returns the counter", () => {
    expect(notNowEvent(0, { notNowSettled: 0, notNowOrigin: null })).toEqual({ seen: 0, fire: false });
    expect(notNowEvent(0, { notNowSettled: 1, notNowOrigin: "today" })).toEqual({ seen: 1, fire: true });
    expect(notNowEvent(1, { notNowSettled: 1, notNowOrigin: "today" })).toEqual({ seen: 1, fire: false });
    expect(notNowEvent(1, { notNowSettled: 2, notNowOrigin: "wizard" })).toEqual({ seen: 2, fire: false });
  });

  test("A-M1: the card's subscription tears down before Not now settles; Today's own subscriber still fires once (and for its retry)", async () => {
    await stored(statusReply());
    // Today: seeded from the counter at script init, then its own subscription runs the production notNowEvent.
    let seen = todayStore().notNowSettled;
    const announced: number[] = [];
    const today = onTodayStore((s) => {
      const step = notNowEvent(seen, s);
      seen = step.seen;
      if (step.fire) announced.push(s.notNowSettled);
    });
    // The card: visible while never asked; it unsubscribes when its visibility turns false (the accepted save's patch).
    let cardOff: (() => void) | null = null;
    cardOff = onTodayStore((s) => {
      if (!neverAsked(s.status) && cardOff !== null) {
        cardOff();
        cardOff = null;
      }
    });
    const save = deferred<SaveOutcome>();
    let failNext = false;
    // The first Not now's save is held until the card has seen its patch; later saves reuse the settled promise.
    const f = fakeIo({ calendar: {}, save: async () => (failNext ? INVALID : save.promise) });
    const run = notNow("today", f.io);
    await Promise.resolve();
    save.resolve(SAVED);
    expect(await run).toBe("notNow");
    expect(cardOff).toBeNull();          // the card's subscription is gone
    expect(announced).toEqual([1]);
    keepBriefing(null);                  // an unrelated notification never replays it
    expect(announced).toEqual([1]);
    // A retried Not now announces once more.
    failNext = true;
    expect(await notNow("today", f.io)).toBe("failed");
    expect(announced).toEqual([1]);      // a failure counts nothing
    failNext = false;
    expect(await tryAgain(f.io)).toBe("notNow");
    expect(announced).toEqual([1, 2]);
    // A wizard-origin Not now is consumed without firing; a fresh Today seeded from the counter does not replay.
    expect(await notNow("wizard", f.io)).toBe("notNow");
    expect(announced).toEqual([1, 2]);
    let fresh = todayStore().notNowSettled;
    const freshFired: boolean[] = [];
    const remount = onTodayStore((s) => {
      const step = notNowEvent(fresh, s);
      fresh = step.seen;
      freshFired.push(step.fire);
    });
    expect(freshFired).toEqual([false]);
    remount();
    today();
  });
});

/* ── PB-M6-T1: the Settings lock follows the store's running flow; its end reloads Settings ─────────────── */

describe("PB-M6-T1: Settings → Calendar reloads once when a flow clears (refreshAfterFlow)", () => {
  type Running = TodayStoreState["flow"]["running"];
  const refreshAfterFlow = (a: Running, b: Running): boolean =>
    (question as unknown as { refreshAfterFlow: (a: Running, b: Running) => boolean }).refreshAfterFlow(a, b);
  const saving: Running = { origin: "today", phase: "saving" };
  const access: Running = { origin: "wizard", phase: "access" };

  test("the pure decision: running → null asks for one refresh; null → null, null → running and a phase change do not", () => {
    expect(refreshAfterFlow(saving, null)).toBe(true);
    expect(refreshAfterFlow(access, null)).toBe(true);
    expect(refreshAfterFlow(null, null)).toBe(false);
    expect(refreshAfterFlow(null, saving)).toBe(false);
    expect(refreshAfterFlow(access, { origin: "wizard", phase: "saving" })).toBe(false);
    expect(refreshAfterFlow(saving, saving)).toBe(false);
  });

  test("over the store's real notifications: a flow (access → saving → cleared) requests exactly one refresh; a Settings-only write requests none", async () => {
    await stored(statusReply({ macSupported: true }));
    let running: Running = todayStore().flow.running;
    let refreshes = 0;
    const locks: boolean[] = [];
    // CalendarPage's subscription, with the production decision.
    const off = onTodayStore((s) => {
      const was = running;
      running = s.flow.running;
      locks.push(running !== null);
      if (refreshAfterFlow(was, running)) refreshes++;
    });
    // A Settings-only write (its own save, accepted, invalid or thrown): never locks, never asks for a refresh.
    for (const outcome of [SAVED, INVALID]) await storeSaveBlock(async () => outcome)({ enabled: true });
    await expect(storeSaveBlock(async () => Promise.reject(BUSY))({ enabled: true })).rejects.toEqual(BUSY);
    expect({ refreshes, locked: locks.some(Boolean) }).toEqual({ refreshes: 0, locked: false });
    // The Mac flow: access, then saving, then cleared — one refresh, after it cleared.
    const f = fakeIo({ calendar: {}, macSupported: true, sources: [MAC] });
    expect(await startShow("today", f.io)).toBe("on");
    expect(refreshes).toBe(1);
    expect(locks.at(-1)).toBe(false);
    // Not now: one more.
    const n = fakeIo({ calendar: {} });
    expect(await notNow("wizard", n.io)).toBe("notNow");
    expect(refreshes).toBe(2);
    off();
  });
});

describe("PB-M6-T1: a locked Settings panel, one server render per phase (the store seeded by a real flow held open)", () => {
  const draw = (component: unknown, props: Record<string, unknown>): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(component as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "");
  const CONFIG = JSON.stringify({ calendar: { enabled: true, macos: { calendars: "editable" }, links: [{ id: "home" }] } });
  const LIST: CalendarListJson = {
    schemaVersion: 1,
    macos: { status: "not-granted", calendars: [{ id: "A", title: "Home", account: "iCloud", editable: true, type: "standard", selected: true }] },
    links: [{ id: "home", name: "Home (Google)", urlPathOwner: "me@personal.example", confirmedOwner: null, urlFrom: "file", fileStatus: "ok" }],
  };
  const STATUS = statusReply({ enabled: true, enabledSet: true, macSupported: true, sources: [MAC, LINK] });
  const panel = (extra: Record<string, unknown>): string =>
    draw(CalendarSettings, { os: "macos", macAvailable: true, initial: { configText: CONFIG, list: LIST, status: STATUS }, ...extra });
  /** The opening tags of every button labelled `label`, except a row's own action (`class="act"`): it writes nothing —
   *  it opens its row and moves the focus to the control in the details, which is the one that writes. */
  const buttons = (html: string, label: string): string[] =>
    html.split(`>${label}</button>`).slice(0, -1).map((before) => before.slice(before.lastIndexOf("<button")) + ">").filter((t) => !/class="act\b/.test(t));
  const disabled = (tag: string): boolean => /\sdisabled(=""|\s|>)/.test(tag);
  /** Whether every (non-action) button labelled `label` is disabled — `null` when none is drawn. */
  const allDisabled = (html: string, label: string): boolean | null => {
    const tags = buttons(html, label);
    return tags.length === 0 ? null : tags.every(disabled);
  };
  const WRITERS = ["Add a connection…", "Allow access", "It's mine", "No, it belongs to someone else", "Remove…"];
  const master = (html: string): string => /<input id="cal-master"[^>]*>/.exec(html)?.[0] ?? "<none>";
  const macSwitch = (html: string): string => /<input[^>]*aria-label="Read the Mac Calendar app"[^>]*>/.exec(html)?.[0] ?? "<none>";
  const busyLineOf = (html: string): string | null => /<p class="mline svelte-\w+" tabindex="-1">([^<]*)<\/p>/.exec(html)?.[1] ?? null;

  /** Hold a flow open in the given phase while `body` runs, then let it finish (and await it). */
  async function during(phase: "saving" | "access", body: () => void): Promise<void> {
    if (phase === "saving") {
      const save = deferred<SaveOutcome>();
      const f = fakeIo({ calendar: {}, save: () => save.promise });
      await stored(statusReply());
      const run = notNow("today", f.io);
      expect(todayStore().flow.running).toEqual({ origin: "today", phase: "saving" });
      body();
      save.resolve(SAVED);
      expect(await run).toBe("notNow");
    } else {
      const connect = deferred<EngineOutcome>();
      const f = fakeIo({ calendar: {}, macSupported: true, sources: [MAC], connect: () => connect.promise });
      await stored(statusReply({ macSupported: true }));
      const run = startShow("today", f.io);
      expect(todayStore().flow.running).toEqual({ origin: "today", phase: "access" });
      body();
      connect.resolve(connectReply(GRANTED));
      expect(await run).toBe("on");
    }
  }

  for (const [phase, line] of [["saving", "Saving your calendar choice…"], ["access", `Waiting for calendar access. ${MAC_DIALOG_NOTE}`]] as const) {
    test(`${phase}: the busy line "${line.slice(0, 32)}…" shows, and the writing controls reachable from the seed are disabled`, async () => {
      await during(phase, () => {
        const html = panel({ locked: true });
        expect(busyLineOf(html)).toBe(line);
        // Before the master switch's Tile, as its sibling (no wrapper).
        expect(html.indexOf(`>${line}</p>`)).toBeLessThan(html.indexOf('class="tile'));
        expect(disabled(master(html))).toBe(true);
        expect(disabled(macSwitch(html))).toBe(true);
        for (const label of WRITERS) expect({ label, disabled: allDisabled(html, label) }).toEqual({ label, disabled: true });
        // Test now writes nothing: it stays live (disagreement 6); so do the rows' own action buttons (they only open).
        expect(allDisabled(html, "Test now")).toBe(false);
        expect(html).toMatch(/<button type="button" class="act svelte-\w+">Allow access<\/button>/);
        // Settings → Calendar's own page, as the app draws it: locked from the store at init (its first render).
        const page = draw(CalendarPage, { os: "macos", onconfigchanged: () => {}, onstatus: () => {} });
        expect(busyLineOf(page)).toBe(line);
        // The default props (not locked) keep the usual controls, with the same flow running.
        const usual = panel({});
        expect(busyLineOf(usual)).toBeNull();
        expect(disabled(master(usual))).toBe(false);
        for (const label of WRITERS) expect({ label, disabled: allDisabled(usual, label) }).toEqual({ label, disabled: false });
        // The wizard's mode never draws the Settings busy line (an embedded panel is never locked; even if it were).
        for (const locked of [false, true]) {
          const wiz = panel({ mode: "wizard", locked });
          expect({ locked, line: wiz.includes(line) }).toEqual({ locked, line: false });
          expect({ locked, busyLine: busyLineOf(wiz) }).toEqual({ locked, busyLine: null });
        }
      });
      // The flow settled: the page is unlocked again.
      expect(busyLineOf(draw(CalendarPage, { os: "macos", onconfigchanged: () => {}, onstatus: () => {} }))).toBeNull();
    });
  }

  test("locked with no flow running (no phase) draws no busy line; no flow and not locked is today's panel", () => {
    expect(todayStore().flow.running).toBeNull();
    expect(busyLineOf(panel({ locked: true }))).toBeNull();
    const html = panel({});
    expect(busyLineOf(html)).toBeNull();
    expect(disabled(master(html))).toBe(false);
    expect(busyLineOf(draw(CalendarPage, { os: "macos", onconfigchanged: () => {}, onstatus: () => {} }))).toBeNull();
  });
});

/* ── PB-M6-T2: CalendarQuestion.svelte — its pure decisions, its reachable server renders, its wiring ───────── */

type Q = typeof question & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const q = question as Q;
type Running = TodayStoreState["flow"]["running"];
const QSRC = new URL("../src/lib/CalendarQuestion.svelte", import.meta.url).pathname;
const qSource = (): string => readFileSync(QSRC, "utf8");
/** The component, loaded when a test needs it (so a missing file fails those tests, not the whole file). */
async function card(props: Record<string, unknown>): Promise<string> {
  const { default: CalendarQuestion } = await import("../src/lib/CalendarQuestion.svelte");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(CalendarQuestion as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "");
}
const disabledTag = (html: string, label: string): boolean | null => {
  const at = html.indexOf(`>${label}</button>`);
  if (at === -1) return null;
  return /\sdisabled(=""|\s|>)/.test(html.slice(html.lastIndexOf("<button", at), at + 1));
};
const tagWithId = (html: string, id: string): string | null => {
  const m = new RegExp(`<[a-z0-9]+[^>]*\\sid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]*)<`).exec(html);
  return m === null ? null : m[1]!;
};
const MAC_STATUS = statusReply({ macSupported: true });

describe("PB-M6-T2: the buttons wait while a flow runs or any calendar write is in flight", () => {
  test("buttonsDisabled: (running, writesInFlight) → disabled", () => {
    expect(q.buttonsDisabled(null, 0)).toBe(false);
    expect(q.buttonsDisabled(null, 1)).toBe(true);
    expect(q.buttonsDisabled({ origin: "today", phase: "saving" }, 0)).toBe(true);
    expect(q.buttonsDisabled({ origin: "wizard", phase: "access" }, 2)).toBe(true);
  });

  for (const settle of ["accepted", "invalid", "thrown"] as const) {
    test(`a Settings save (${settle}): the store's real notifications 0 → 1 → 0 give disabled → enabled, and the card renders each`, async () => {
      await stored(MAC_STATUS);
      const seen: boolean[] = [];
      const off = onTodayStore((s) => seen.push(q.buttonsDisabled(s.flow.running, s.writesInFlight)));
      const save = deferred<SaveOutcome>();
      const writing = storeSaveBlock(() => save.promise)({ enabled: true });
      const during = await card({ origin: "today", os: "macos", status: MAC_STATUS });
      expect([disabledTag(during, "Show my calendar"), disabledTag(during, "Not now")]).toEqual([true, true]);
      if (settle === "thrown") {
        save.reject(BUSY);
        await expect(writing).rejects.toEqual(BUSY);
      } else {
        save.resolve(settle === "accepted" ? SAVED : INVALID);
        await writing;
      }
      off();
      expect(seen.filter((v, i, all) => i === 0 || v !== all[i - 1])).toEqual([false, true, false]);
      const after = await card({ origin: "today", os: "macos", status: MAC_STATUS });
      expect([disabledTag(after, "Show my calendar"), disabledTag(after, "Not now")]).toEqual([false, false]);
    });
  }
});

describe("PB-M6-T2: the card's visible state (cardView)", () => {
  const base = { origin: "today", ask: true, ownPress: false, running: null, writesInFlight: 0, result: null, linkSession: false, refusal: false };
  const result = (o: Partial<FlowResult> = {}): FlowResult => ({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null, ...o });

  test("each state: the question; busy (either origin's flow); a result; a held write (no question); the link session; a refusal", () => {
    expect(q.cardView(base)).toEqual({ question: true, busyLine: null, result: null, link: false, refusal: false, disabled: false, closeDisabled: false });
    expect(q.cardView({ ...base, running: { origin: "wizard", phase: "access" } }))
      .toEqual({ question: true, busyLine: BUSY_ACCESS_LINE, result: null, link: false, refusal: false, disabled: true, closeDisabled: true });
    expect(q.cardView({ ...base, running: { origin: "today", phase: "saving" } }).busyLine).toBe(BUSY_SAVING_LINE);
    const on = result();
    expect(q.cardView({ ...base, result: on })).toEqual({ question: false, busyLine: null, result: on, link: false, refusal: false, disabled: false, closeDisabled: false });
    const held = result({ line: "Couldn't save", answered: false, pendingWrite: { enabled: false, then: null } });
    expect(q.cardView({ ...base, result: held })).toMatchObject({ question: false, result: held });
    expect(q.cardView({ ...base, linkSession: true, running: { origin: "today", phase: "saving" } }))
      .toEqual({ question: false, busyLine: null, result: null, link: true, refusal: false, disabled: true, closeDisabled: true });
    expect(q.cardView({ ...base, refusal: true }).refusal).toBe(true);
    expect(q.cardView({ ...base, refusal: true, result: on }).refusal).toBe(false);
  });

  test("a result shows only in its own origin's card; the caller's gate (`ask`) hides the question, never a busy line or a result", () => {
    expect(q.cardView({ ...base, result: result({ origin: "wizard" }) }).result).toBeNull();
    expect(q.cardView({ ...base, origin: "wizard", result: result() }).result).toBeNull();
    expect(q.cardView({ ...base, ask: false })).toMatchObject({ question: false, result: null });
    expect(q.cardView({ ...base, ask: false, running: { origin: "today", phase: "saving" } }).busyLine).toBe(BUSY_SAVING_LINE);
    expect(q.cardView({ ...base, ask: false, result: result() }).result).not.toBeNull();
  });
});

describe("PB-M6-T2: focus targets, answers and the busy refusal (pure)", () => {
  test("focus: a started flow → the busy line; an answer or a failed write → Close on Today, the result line in the wizard; busy or an unanswered Link → Show my calendar", () => {
    expect(q.FOCUS_ON_START).toBe("busyLine");
    for (const end of ["on", "off", "failed"]) {
      expect({ end, today: q.focusAfter("today", end), wizard: q.focusAfter("wizard", end) }).toEqual({ end, today: "close", wizard: "resultLine" });
    }
    for (const end of ["busy", "unanswered"]) {
      expect({ end, today: q.focusAfter("today", end), wizard: q.focusAfter("wizard", end) }).toEqual({ end, today: "show", wizard: "show" });
    }
    // Not now: Today lands on the slide (its land request); the wizard's step owns its line (PB-M7). Link: the panel's
    // startAdding. Blocked: nothing happened.
    for (const end of ["notNow", "link", "blocked"]) {
      expect({ end, today: q.focusAfter("today", end), wizard: q.focusAfter("wizard", end) }).toEqual({ end, today: null, wizard: null });
    }
  });

  test("onanswered: on, off and notNow only — never failed, busy, unanswered, link or blocked", () => {
    expect(["on", "off", "notNow", "failed", "busy", "unanswered", "link", "blocked"].map((e) => q.answeredKind(e)))
      .toEqual(["on", "off", "notNow", null, null, null, null, null]);
  });

  test("the busy refusal line: set by a busy end, cleared by the next press before its outcome settles, and by any other end", () => {
    expect(q.refusalAfter(false, "busy")).toBe(true);
    expect(q.refusalAfter(true, "press")).toBe(false);
    for (const end of ["on", "off", "failed", "unanswered", "link", "blocked"]) expect({ end, r: q.refusalAfter(true, end) }).toEqual({ end, r: false });
  });

  test("over the store: a successful Not now (and its retry) answers notNow once with flow.result null; busy, an unanswered Link and a failed save answer nothing", async () => {
    const answers: (string | null)[] = [];
    let failNext = true;
    const f = fakeIo({ calendar: {}, save: async () => (failNext ? INVALID : SAVED) });
    await stored(statusReply());
    answers.push(q.answeredKind(await notNow("today", f.io)));          // failed: nothing
    failNext = false;
    answers.push(q.answeredKind(await tryAgain(f.io)));                 // the retry succeeds: notNow
    expect(todayStore().flow.result).toBeNull();
    const busy = fakeIo({ calendar: {}, macSupported: true, connect: async () => Promise.reject({ kind: "busy", running: "run" }) });
    await stored(statusReply({ macSupported: true }));
    answers.push(q.answeredKind(await startShow("today", busy.io)));    // busy: nothing
    const link = fakeIo({ calendar: {} });
    await stored(statusReply());
    answers.push(q.answeredKind(await closeLinkSession("today", link.io))); // unanswered: nothing
    expect(answers).toEqual([null, "notNow", null, null]);
  });
});

describe("PB-M6-T2: the local link session (pure transitions, and the store's close)", () => {
  type S = { open: boolean; leftover: boolean };
  const step = (s: S, e: Record<string, unknown>) => q.linkSessionStep(s, e) as { next: S; closeFlow: boolean; notify: boolean | null };

  test("open reports true once; Done or Cancel with no leftover closes, runs the closing flow, and reports false once", () => {
    const opened = step(q.LINK_CLOSED, { kind: "open" });
    expect(opened).toEqual({ next: { open: true, leftover: false }, closeFlow: false, notify: true });
    expect(step(opened.next, { kind: "open" })).toEqual({ next: opened.next, closeFlow: false, notify: null });
    const closed = step(opened.next, { kind: "addClosed", leftover: false });
    expect(closed).toEqual({ next: q.LINK_CLOSED, closeFlow: true, notify: false });
    // Nothing more once closed: no second false, no second flow.
    expect(step(closed.next, { kind: "addClosed", leftover: false })).toEqual({ next: q.LINK_CLOSED, closeFlow: false, notify: null });
    expect(step(closed.next, { kind: "destroy" })).toEqual({ next: q.LINK_CLOSED, closeFlow: false, notify: null });
  });

  test("Done or Cancel with a leftover keeps the session open (the card stays, whatever enabledSet says) until onleftovercleared, which then closes it", () => {
    const open = step(q.LINK_CLOSED, { kind: "open" }).next;
    const kept = step(open, { kind: "addClosed", leftover: true });
    expect(kept).toEqual({ next: { open: true, leftover: true }, closeFlow: false, notify: null });
    // The card's visibility input stays true with enabledSet already true (PB-M6-T3's helper reads `open`).
    expect(kept.next.open).toBe(true);
    expect(step(kept.next, { kind: "leftoverCleared" })).toEqual({ next: q.LINK_CLOSED, closeFlow: true, notify: false });
    // A leftover cleared while the add panel is still open (nothing reported yet) closes nothing.
    expect(step(open, { kind: "leftoverCleared" })).toEqual({ next: open, closeFlow: false, notify: null });
  });

  test("unmount while open: closed, reported false once, no flow and no answer", () => {
    const open = step(q.LINK_CLOSED, { kind: "open" }).next;
    expect(step(open, { kind: "destroy" })).toEqual({ next: q.LINK_CLOSED, closeFlow: false, notify: false });
    expect(step({ open: true, leftover: true }, { kind: "destroy" })).toEqual({ next: q.LINK_CLOSED, closeFlow: false, notify: false });
  });

  test("the store side: a link saved through the panel (owner stages, then Done) answers on; Cancel with nothing saved is unanswered", async () => {
    await stored(statusReply());
    const f = fakeIo({ calendar: {} });
    // The panel's add saves the link's entry with enabled: true (wizard mode), through the store's save.
    expect((await addLink({ id: "home", name: "Home", takeUrl: () => "https://x.example/c.ics" },
      { writeLink: async () => ({ id: "home" }) as never, readConfig: f.io.readConfig, saveBlock: storeSaveBlock(f.io.saveBlock), list: async () => ({ schemaVersion: 1, macos: null, links: [] }) as never },
      describeFailure, { turnOn: true })).kind).toBe("added");
    expect(await closeLinkSession("today", f.io)).toBe("on");
    expect(todayStore().flow.result?.line).toBe(ON_LINE);
    resetTodayStoreForTests();
    await stored(statusReply());
    expect(await closeLinkSession("wizard", fakeIo({ calendar: {} }).io)).toBe("unanswered");
    expect(todayStore().flow.result).toBeNull();
  });
});

describe("PB-M6-T2: CalendarQuestion's reachable server renders", () => {
  test("the question: a group labelled by the question (the id resolves to its text), both buttons, the explanation for the path", async () => {
    await stored(MAC_STATUS);
    const html = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    const group = /<div[^>]*role="group"[^>]*aria-labelledby="([^"]+)"/.exec(html);
    expect(group).not.toBeNull();
    expect(tagWithId(html, group![1]!)).toBe("Show today's meetings in your briefing?");
    expect(disabledTag(html, "Show my calendar")).toBe(false);
    expect(disabledTag(html, "Not now")).toBe(false);
    expect(html).toContain(q.explanationFor(MAC_STATUS));
    expect(html).not.toContain("Close");
    expect(html).not.toContain(BUSY_SAVING_LINE);
  });

  test("busy (a flow held open, each phase): the busy line (tabindex -1) and disabled buttons, whichever origin started it", async () => {
    // saving, from the wizard
    await stored(statusReply());
    const save = deferred<SaveOutcome>();
    const run = notNow("wizard", fakeIo({ calendar: {}, save: () => save.promise }).io);
    const saving = await card({ origin: "today", os: "linux", status: statusReply() });
    expect(saving).toMatch(new RegExp(`<p class="busy svelte-\\w+" tabindex="-1" data-focus="busyLine">${BUSY_SAVING_LINE}</p>`));
    expect([disabledTag(saving, "Show my calendar"), disabledTag(saving, "Not now")]).toEqual([true, true]);
    save.resolve(SAVED);
    expect(await run).toBe("notNow");
    // access
    await stored(MAC_STATUS);
    const connect = deferred<EngineOutcome>();
    const show = startShow("today", fakeIo({ calendar: {}, macSupported: true, sources: [MAC], connect: () => connect.promise }).io);
    const access = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    expect(access).toContain(`data-focus="busyLine">${BUSY_ACCESS_LINE}</p>`);
    connect.resolve(connectReply(GRANTED));
    expect(await show).toBe("on");
  });

  test("a Today result: its line and Close; no question, no Try again", async () => {
    seedTodayStoreForTests({ flow: { running: null, result: { origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null } } });
    const html = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    expect(html).toContain(`>${ON_LINE}</p>`);
    expect(html).toMatch(/<button type="button" class="ctl action svelte-[a-z0-9]+" data-focus="close"[^>]*>Close<\/button>/);
    expect(html).not.toContain("Show my calendar");
    expect(html).not.toContain("Try again");
  });

  test("a failed write: Try again (and Close) described by the displayed error line's id — no dangling description; no question", async () => {
    const line = "The calendar setting could not be saved: busy.";
    seedTodayStoreForTests({ flow: { running: null, result: { origin: "today", line, answered: false, drawn: false, pendingWrite: { enabled: true, then: ON_LINE } } } });
    const html = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((m) => m[1]!);
    expect(described.length).toBeGreaterThan(0);
    for (const id of described) expect({ id, text: tagWithId(html, id) }).toEqual({ id, text: line });
    const tryTag = html.slice(html.lastIndexOf("<button", html.indexOf(">Try again</button>")), html.indexOf(">Try again</button>"));
    expect(tryTag).toMatch(/aria-describedby="[^"]+"/);
    expect(html).not.toContain("Show my calendar");
    expect(html).not.toContain("Continue without a calendar");   // the wizard's own button (PB-M7)
  });

  test("a wizard result: its line takes the focus target (tabindex -1), no Close; never in Today's card", async () => {
    seedTodayStoreForTests({ flow: { running: null, result: { origin: "wizard", line: ON_LINE, answered: true, drawn: false, pendingWrite: null } } });
    const wiz = await card({ origin: "wizard", os: "linux", status: statusReply() });
    expect(wiz).toMatch(new RegExp(`<p[^>]*tabindex="-1"[^>]*data-focus="resultLine"[^>]*>${ON_LINE}</p>`));
    expect(wiz).not.toContain(">Close</button>");
    const today = await card({ origin: "today", os: "linux", status: statusReply() });
    expect(today).not.toContain(ON_LINE);
    expect(today).toContain("Show my calendar");
  });
});

describe("PB-M6-T2: CalendarQuestion's wiring (source pins: a server render clicks nothing and runs no onMount)", () => {
  test("store state at init, re-read and followed on mount; every decision is the pure helpers'", () => {
    const s = qSource();
    expect(s).toContain("let store = $state.raw(todayStore());");
    expect(s).toMatch(/onMount\(\(\) => \{\n\s*store = todayStore\(\);\n\s*const off = onTodayStore\(\(next\) => \(store = next\)\);/);
    expect(s).toContain("const view = $derived(cardView({ origin, ask, ownPress, running: store.flow.running, writesInFlight: store.writesInFlight, result: store.flow.result, linkSession: session.open, refusal }));");
    expect(s).toMatch(/focusAfter\(origin, end\)/);
    expect(s).toContain("const kind = answeredKind(end);");
    expect(s).toContain("if (kind !== null) onanswered?.(kind, pressPath);");
    expect(s).toContain("refusal = refusalAfter(refusal, end);");
  });

  test("the presses: a press clears the refusal first; a started flow sends the focus to the busy line; the flows are the store's", () => {
    const s = qSource();
    // PB r1 X10 / X11: each press latches the caller's gate (`ownPress`); Show records the path it takes (`pressPath`),
    // Not now has none, and Try again keeps the path of the press it retries.
    expect(s).toMatch(/function show\(\): void \{\n\s*refusal = refusalAfter\(refusal, "press"\);\n\s*pressPath = pathOf\(todayStore\(\)\.status\);\n\s*ownPress = ask;\n\s*const run = startShow\(origin, io\);\n\s*started\(\);\n\s*void run\.then\(ended\);\n\s*\}/);
    expect(s).toMatch(/function notNowPress\(\): void \{\n\s*refusal = refusalAfter\(refusal, "press"\);\n\s*pressPath = null;\n\s*ownPress = ask;\n\s*const run = notNow\(origin, io\);\n\s*started\(\);\n\s*void run\.then\(ended\);\n\s*\}/);
    expect(s).toMatch(/function retry\(\): void \{\n\s*ownPress = ask;\n\s*const run = tryAgain\(io\);\n\s*started\(\);\n\s*void run\.then\(ended\);\n\s*\}/);
    expect(s).toMatch(/function started\(\): void \{\n\s*if \(todayStore\(\)\.flow\.running\?\.origin === origin\) void focusOn\(FOCUS_ON_START\);\n\s*\}/);
    // The engine calls, injected as the store's io.
    expect(s).toContain("const io: FlowIo = { status: () => calendarStatus(), connectMac: () => calendarConnectMac(), readConfig: configRead, saveBlock: calendarConfigSave };");
    // onanswered after settlement, even if the card unmounted (no destroyed guard before it); focus is skipped then.
    const ended = s.slice(s.indexOf("function ended("), s.indexOf("\n  }\n", s.indexOf("function ended(")));
    expect(ended.indexOf("onanswered?.(kind)")).toBeLessThan(ended.indexOf("destroyed"));
  });

  test("the link session: per-mount state; the closing flow starts before onsession(false); destroy reports false while open; the wizard's cleanup is leaveWizard", () => {
    const s = qSource();
    expect(s).toContain("let session = $state<LinkSession>(LINK_CLOSED);");
    // PB final LOW L1 (moved): an ended session also drops the departed panel's last reported state.
    expect(s).toMatch(/function sessionEvent\(e: LinkEvent\): void \{\n\s*const r = linkSessionStep\(session, e\);\n\s*session = r\.next;\n\s*if \(!session\.open\) panel = LINK_PANEL_IDLE;\n\s*const closing = r\.closeFlow \? closeLinkSession\(origin, io\) : null;\n\s*if \(r\.notify !== null\) onsession\?\.\(r\.notify\);\n\s*if \(closing !== null\) void closing\.then\(ended\);\n\s*\}/);
    expect(s.match(/onsession\?\.\(/g)).toHaveLength(1);
    expect(s).toContain('if (end === "link") return sessionEvent({ kind: "open" });');
    // The cleanup: destroyed, the session (false if open, no flow), and the wizard's leave.
    expect(s).toMatch(/return \(\) => \{\n\s*off\(\);\n\s*destroyed = true;\n\s*sessionEvent\(\{ kind: "destroy" \}\);\n\s*if \(origin === "wizard"\) leaveWizard\(\);\n\s*\};/);
    // The embedded panel: wizard mode, link only, adding at once — never locked; its two callbacks feed the session, and
    // (PB final LOW L1/L2) its panel state feeds the way out.
    expect(s).toContain('<CalendarSettings mode="wizard" {os} linkOnly startAdding onaddclosed={({ leftover }) => sessionEvent({ kind: "addClosed", leftover })} onleftovercleared={() => sessionEvent({ kind: "leftoverCleared" })} onpanelstate={(p) => (panel = p)} />');
    expect(s).not.toMatch(/<CalendarSettings[^>]*locked/);
  });

  test("Close: the store's close, then the caller's onclose (Today hides the card and lands); the card's own style holds flex: none; Deck's min-height is untouched", () => {
    const s = qSource();
    expect(s).toMatch(/function closeCard\(\): void \{\n\s*close\(\);\n\s*onclose\?\.\(\);\n\s*\}/);
    expect(s).toMatch(/\.card \{[^}]*flex: none;/);
    expect(readFileSync(new URL("../src/lib/deck/Deck.svelte", import.meta.url).pathname, "utf8")).toMatch(/min-height: 14rem;/);
  });
});

describe("Option 1 (user-directed 2026-10-31): the question, its explanation, then full-size buttons below it, Show primary", () => {
  test("source: in the asking group the explanation comes before the buttons' row, Show before Not now; every button is ctl in ActionButton's look", () => {
    const s = qSource();
    const asking = s.slice(s.indexOf("{:else if view.question}"), s.indexOf("{#if view.refusal}"));
    const why = asking.indexOf('<p class="why" id="{uid}-why">');
    const row = asking.indexOf('<div class="row">');
    const showAt = asking.indexOf("{SHOW_BUTTON}</button>");
    const notNowAt = asking.indexOf("{NOT_NOW_BUTTON}</button>");
    expect([why, row, showAt, notNowAt].every((i) => i > -1)).toBe(true);
    expect(asking.indexOf('<p class="q" id="{uid}-q">')).toBeLessThan(why);
    expect(why).toBeLessThan(row);
    expect(row).toBeLessThan(showAt);
    expect(showAt).toBeLessThan(notNowAt);
    // The explanation sits inside the group it describes (before the group's closing tag).
    expect(why).toBeLessThan(asking.indexOf("</div>\n    </div>"));
    expect(asking).toContain('<button type="button" class="ctl action primary" data-focus="show" disabled={view.disabled}');
    expect(asking).toContain('<button type="button" class="ctl action" disabled={view.disabled} onclick={notNowPress}>{NOT_NOW_BUTTON}</button>');
    // Every button in the card takes .ctl and the local ActionButton look; Show alone is primary.
    const markup = s.slice(s.indexOf("</script>"), s.indexOf("<style>"));
    const buttons = markup.match(/<button [^>]*>/g) ?? [];
    expect(buttons).toHaveLength(5);
    for (const b of buttons) expect({ b, ctl: /\sclass="ctl action( primary)?"/.test(b) }).toEqual({ b, ctl: true });
    expect(buttons.filter((b) => b.includes("primary"))).toEqual([buttons.find((b) => b.includes('data-focus="show"'))]);
  });

  test("style: the group stacks (no longer one row); the local .action and .primary are ActionButton's own declarations; no local focus or disabled rule", () => {
    const style = (src: string): string => src.slice(src.indexOf("<style>"));
    const decls = (src: string, selector: string): string[] => {
      const m = new RegExp(`\\n\\s*${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(style(src));
      return (m?.[1] ?? "").split(";").map((d) => d.trim()).filter((d) => d !== "");
    };
    const s = qSource();
    const ab = readFileSync(new URL("../src/lib/ui/ActionButton.svelte", import.meta.url).pathname, "utf8");
    expect(decls(s, ".ask")).toContain("flex-direction: column");
    expect(decls(s, ".ask")).toContain("align-items: flex-start");
    for (const sel of [".action", ".primary"]) {
      expect(decls(ab, sel).length).toBeGreaterThan(0);
      expect({ sel, card: decls(s, sel) }).toEqual({ sel, card: decls(ab, sel) });
    }
    expect(style(s).replace(/\/\*[^]*?\*\//g, "")).not.toMatch(/:focus-visible|:disabled/);
  });

  test("server render: the explanation's text comes before Show my calendar, which comes before Not now", async () => {
    await stored(MAC_STATUS);
    const html = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    const why = html.indexOf(q.explanationFor(MAC_STATUS));
    const showAt = html.indexOf(">Show my calendar</button>");
    const notNowAt = html.indexOf(">Not now</button>");
    expect([why, showAt, notNowAt].every((i) => i > -1)).toBe(true);
    expect(why).toBeLessThan(showAt);
    expect(showAt).toBeLessThan(notNowAt);
  });
});

/* ── PB-M6-T3: the card on Today — when it shows, and what it leaves behind ─────────────────────────────── */

const CONFIG_OFF = CONFIG_OFF_SUFFIX;

describe("PB-M6-T3: the Today card's visibility (todayCard, every input explicit)", () => {
  const CONFIGURED = { phase: { phase: "idle" } } as never;
  const NOT_CONFIGURED = { phase: { phase: "not-configured" } } as never;
  /** Today's composition: the store's own never-asked and malformed rules over the stored reply. */
  const input = (o: Partial<Record<string, unknown>> & { status?: CalendarStatusJson | null } = {}) => {
    const status = o.status === undefined ? statusReply() : o.status;
    return {
      hasPage: true, scheduleState: CONFIGURED, os: "macos", closed: false, running: null, result: null, linkSession: false,
      ...o,
      neverAsked: neverAsked(status), malformed: status !== null && malformed(status),
    };
  };
  const shown = (o: Parameters<typeof input>[0] = {}) => q.todayCard(input(o)) as { shown: boolean; question: boolean };
  const todayResult = (o: Partial<FlowResult> = {}): FlowResult => ({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null, ...o });

  test("never asked (enabledSet false — no block, no enabled, enabled: null) asks; enabledSet true hides; a malformed block hides", () => {
    expect(shown()).toEqual({ shown: true, question: true });
    expect(shown({ status: statusReply({ enabledSet: true, enabled: false }) })).toEqual({ shown: false, question: false });
    expect(shown({ status: statusReply({ enabledSet: true, enabled: true }) })).toEqual({ shown: false, question: false });
    expect(shown({ status: statusReply({ configWarnings: [`calendar: the block is malformed${CONFIG_OFF}`] }) })).toEqual({ shown: false, question: false });
  });

  test("the two warnings that are not malformations (literalUrl, macosNotHere) alone still ask; prepared link-only and Mac-only blocks ask", () => {
    for (const w of ["calendar.links[0]: a literal url is skipped", "calendar.macos: the Mac Calendar app is macOS only"]) {
      expect({ w, card: shown({ status: statusReply({ configWarnings: [w] }) }) }).toEqual({ w, card: { shown: true, question: true } });
    }
    expect(shown({ status: statusReply({ sources: [LINK] }) }).question).toBe(true);
    expect(shown({ status: statusReply({ sources: [MAC], macSupported: true }) }).question).toBe(true);
  });

  test("Windows and an unknown OS hide; no status yet hides; no or null scheduleState, or not configured, hides", () => {
    expect(shown({ os: "windows" }).shown).toBe(false);
    expect(shown({ os: "other" }).shown).toBe(false);
    expect(shown({ os: "linux" }).shown).toBe(true);
    expect(shown({ status: null }).shown).toBe(false);
    expect(shown({ scheduleState: null }).shown).toBe(false);
    expect(shown({ scheduleState: undefined }).shown).toBe(false);
    expect(shown({ scheduleState: NOT_CONFIGURED }).shown).toBe(false);
  });

  test("loading, a read error and the first run (no page) hide everything — a running flow and a held result wait for a page", () => {
    expect(shown({ hasPage: false })).toEqual({ shown: false, question: false });
    expect(shown({ hasPage: false, running: { origin: "today", phase: "saving" } }).shown).toBe(false);
    expect(shown({ hasPage: false, result: todayResult() }).shown).toBe(false);
    // The pending result on a loaded-page revisit: drawn, without the question.
    expect(shown({ result: todayResult({ pendingWrite: { enabled: false, then: null }, answered: false }) })).toEqual({ shown: true, question: false });
  });

  test("a running flow (either origin) or a Today result shows the card without the gate; a wizard result never does", () => {
    const answered = statusReply({ enabledSet: true });
    expect(shown({ status: answered, running: { origin: "wizard", phase: "access" } })).toEqual({ shown: true, question: false });
    expect(shown({ status: answered, result: todayResult() })).toEqual({ shown: true, question: false });
    expect(shown({ status: answered, result: todayResult({ origin: "wizard" }) }).shown).toBe(false);
  });

  test("R5B-F1: the link session keeps the card whatever enabledSet says; the same inputs with the session closed hide it", () => {
    const patched = statusReply({ enabledSet: true, enabled: true });
    expect(shown({ status: patched, linkSession: true })).toEqual({ shown: true, question: false });
    expect(shown({ status: patched, linkSession: false })).toEqual({ shown: false, question: false });
  });

  test("Close hides it for this visit (whatever else holds); the next visit asks again only if still never asked", () => {
    expect(shown({ closed: true })).toEqual({ shown: false, question: false });
    expect(shown({ closed: true, result: todayResult() }).shown).toBe(false);
    expect(shown({ closed: false })).toEqual({ shown: true, question: true });
  });

  test("B-F3: after a grant on a no-block config the accepted-write patch keeps the next visit hidden, even when the re-read fails", async () => {
    await stored(statusReply());
    const f = fakeIo({ macSupported: true, sources: [MAC], reads: ["throw", "throw", "throw"] });
    await stored(statusReply({ macSupported: true }));
    // PB r1 X13 — PREMISE: the grant's two re-reads both failed (and the one after the write): written off, "couldn't be
    // checked" — three reads through the fake, one connect.
    expect(await startShow("today", f.io)).toBe("off");
    expect(todayStore().flow.result?.line).toBe(MAC_NOT_CHECKED_LINE);
    expect(f.counts).toEqual({ reads: 3, connects: 1 });
    // Both re-reads failed: written off — but answered: the patch says enabledSet, so nothing asks again.
    expect(todayStore().status?.enabledSet).toBe(true);
    close();
    expect(q.todayCard({ ...input({ status: todayStore().status }), result: todayStore().flow.result, closed: false }).shown).toBe(false);
  });

  test("Not now removes the card with flow.result null; visibility turns false in the settling publish; Today's own step still fires once", async () => {
    await stored(statusReply());
    const f = fakeIo({ calendar: {} });
    const visible: boolean[] = [];
    let seen = todayStore().notNowSettled;
    let lands = 0;
    let announced = 0;
    const off = onTodayStore((s) => {
      visible.push((q.todayCard(input({ status: s.status, running: s.flow.running, result: s.flow.result })) as { shown: boolean }).shown);
      const step = notNowEvent(seen, s);
      seen = step.seen;
      if (step.fire) {
        announced++;
        lands++;
      }
    });
    expect(await notNow("today", f.io)).toBe("notNow");
    off();
    expect(visible[0]).toBe(true);
    expect(visible.at(-1)).toBe(false);
    expect(todayStore().flow.result).toBeNull();
    expect({ announced, lands }).toEqual({ announced: 1, lands: 1 });
    // A fresh Today, seeded from the counter, replays nothing.
    let fresh = todayStore().notNowSettled;
    const replay: boolean[] = [];
    const again = onTodayStore((s) => {
      const step = notNowEvent(fresh, s);
      fresh = step.seen;
      replay.push(step.fire);
    });
    again();
    expect(replay).toEqual([false]);
  });

  test("result announcements: a result settled while away is drawn (and announced) once on the next view with a page; a drawn held result never again", async () => {
    await stored(statusReply({ sources: [LINK] }));
    // Settled while away (no Today mounted): nothing marks it.
    expect(await startShow("today", fakeIo({ calendar: { links: [{ id: "home" }] }, sources: [LINK] }).io)).toBe("on");
    expect(todayStore().flow.result?.drawn).toBe(false);
    // The next Today view with a page draws it: the card shows, markDrawn answers its line once.
    expect(q.todayCard({ ...input({ status: todayStore().status }), result: todayStore().flow.result }).shown).toBe(true);
    expect(markDrawn()).toBe(ON_LINE);
    expect(markDrawn()).toBeNull();
    leaveToday();
    expect(todayStore().flow.result).toBeNull();
    // A held result: drawn, kept across leaving, and never announced again on the remount.
    seedTodayStoreForTests({ flow: { running: null, result: todayResult({ answered: false, pendingWrite: { enabled: true, then: ON_LINE } }) } });
    expect(markDrawn()).toBe(ON_LINE);
    leaveToday();
    expect(todayStore().flow.result?.pendingWrite).not.toBeNull();
    expect(markDrawn()).toBeNull();
  });
});

/* ── PB-M6 checkpoint fixes: Close waits for a running flow; the question stays through its own flow; the refusal ── */

describe("PB-M6 checkpoint (MED): Close is disabled while a flow runs — a Try again retry can no longer be closed under itself", () => {
  const held = (o: Partial<FlowResult> = {}): FlowResult => ({ origin: "today", line: "Couldn't save.", answered: false, drawn: true, pendingWrite: { enabled: false, then: null }, ...o });
  const base = { origin: "today", ask: true, ownPress: false, running: null, writesInFlight: 0, result: held(), linkSession: false, refusal: false };

  test("cardView: closeDisabled for a running flow (either origin), never for a write in flight alone (Close writes nothing)", () => {
    expect(q.cardView(base).closeDisabled).toBe(false);
    expect(q.cardView({ ...base, running: { origin: "today", phase: "saving" } }).closeDisabled).toBe(true);
    expect(q.cardView({ ...base, running: { origin: "wizard", phase: "access" } }).closeDisabled).toBe(true);
    expect(q.cardView({ ...base, writesInFlight: 1 })).toMatchObject({ closeDisabled: false, disabled: true });
  });

  test("the store scenario: a held failed Not now, Try again in flight — every published state while it runs has Close disabled; the failed retry's own result then holds, closable", async () => {
    await stored(statusReply());
    let mode: "fail" | "hold" = "fail";
    const hold = deferred<SaveOutcome>();
    const f = fakeIo({ calendar: {}, save: async () => (mode === "fail" ? INVALID : hold.promise) });
    expect(await notNow("today", f.io)).toBe("failed");
    expect(markDrawn()).not.toBeNull();                       // the card drew it
    const views: { running: boolean; closeDisabled: boolean; result: boolean }[] = [];
    const off = onTodayStore((s) => {
      const v = q.cardView({ origin: "today", ask: true, ownPress: false, running: s.flow.running, writesInFlight: s.writesInFlight, result: s.flow.result, linkSession: false, refusal: false });
      views.push({ running: s.flow.running !== null, closeDisabled: v.closeDisabled, result: v.result !== null });
    });
    mode = "hold";
    const run = tryAgain(f.io);
    const during = views.filter((v) => v.running);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((v) => v.closeDisabled && v.result)).toBe(true);   // the held result stays drawn, Close disabled
    hold.resolve(INVALID);                                                  // the retry fails again
    expect(await run).toBe("failed");
    off();
    expect(views.at(-1)).toEqual({ running: false, closeDisabled: false, result: true });
    // Close now (enabled) clears it for good; leaving Today leaves nothing behind.
    expect(markDrawn()).not.toBeNull();
    close();
    leaveToday();
    expect(todayStore().flow.result).toBeNull();
  });

  test("server render: a held result with its retry running — Try again AND Close disabled; with only a Settings write in flight — Try again disabled, Close live", async () => {
    await stored(statusReply());
    let mode: "fail" | "hold" = "fail";
    const hold = deferred<SaveOutcome>();
    const f = fakeIo({ calendar: {}, save: async () => (mode === "fail" ? INVALID : hold.promise) });
    expect(await notNow("today", f.io)).toBe("failed");
    mode = "hold";
    const run = tryAgain(f.io);
    const retrying = await card({ origin: "today", os: "linux", status: statusReply() });
    expect({ tryAgain: disabledTag(retrying, "Try again"), close: disabledTag(retrying, "Close") }).toEqual({ tryAgain: true, close: true });
    hold.resolve(INVALID);
    expect(await run).toBe("failed");
    // A Settings save in flight (no flow): Try again waits (no flow may start), Close does not.
    const save = deferred<SaveOutcome>();
    const settings = storeSaveBlock(() => save.promise)({ enabled: true });
    const writing = await card({ origin: "today", os: "linux", status: statusReply() });
    expect({ tryAgain: disabledTag(writing, "Try again"), close: disabledTag(writing, "Close") }).toEqual({ tryAgain: true, close: false });
    save.resolve(INVALID);
    await settings;
    const idle = await card({ origin: "today", os: "linux", status: statusReply() });
    expect({ tryAgain: disabledTag(idle, "Try again"), close: disabledTag(idle, "Close") }).toEqual({ tryAgain: false, close: false });
  });
});

describe("PB-M6 checkpoint (LOW 2): the question stays drawn, buttons disabled, through a flow this card started", () => {
  test("cardView: ask false with this origin's flow running keeps the question; another origin's flow does not", () => {
    // PB r1 X10: `ownPress` — this card's own press started the flow with the gate open (the latch Show / Not now set).
    const base = { origin: "today", ask: false, ownPress: true, running: null, writesInFlight: 0, result: null, linkSession: false, refusal: false };
    expect(q.cardView({ ...base, running: { origin: "today", phase: "access" } })).toMatchObject({ question: true, disabled: true, busyLine: BUSY_ACCESS_LINE });
    expect(q.cardView({ ...base, running: { origin: "wizard", phase: "saving" } })).toMatchObject({ question: false, busyLine: BUSY_SAVING_LINE });
    expect(q.cardView({ ...base, origin: "wizard", running: { origin: "wizard", phase: "saving" } }).question).toBe(true);
    expect(q.cardView(base).question).toBe(false);
  });

  test("over the store: the Mac path patches enabledSet true before it ends, yet every published state while it runs keeps Today's question", async () => {
    await stored(statusReply({ macSupported: true }));
    const f = fakeIo({ calendar: {}, macSupported: true, sources: [MAC] });
    const states: { running: boolean; ask: boolean; question: boolean }[] = [];
    const off = onTodayStore((s) => {
      const gate = (q.todayCard({ hasPage: true, scheduleState: { phase: { phase: "idle" } } as never, neverAsked: neverAsked(s.status), malformed: s.status !== null && malformed(s.status), os: "macos", closed: false, running: s.flow.running, result: s.flow.result, linkSession: false }) as { question: boolean }).question;
      // ownPress: Show my calendar was pressed with the gate open (the component's latch, PB r1 X10).
      const v = q.cardView({ origin: "today", ask: gate, ownPress: true, running: s.flow.running, writesInFlight: s.writesInFlight, result: s.flow.result, linkSession: false, refusal: false });
      states.push({ running: s.flow.running !== null, ask: gate, question: v.question });
    });
    expect(await startShow("today", f.io)).toBe("on");
    off();
    const running = states.filter((s) => s.running);
    expect(running.some((s) => !s.ask)).toBe(true);           // PREMISE: the gate closed mid-flow (the save's patch)
    expect(running.every((s) => s.question)).toBe(true);
    expect(states.at(-1)).toEqual({ running: false, ask: false, question: false });   // answered: the result replaces it
  });
});

describe("PB-M6 checkpoint (LOW 1): after a busy refusal, Show my calendar is described by the refusal line", () => {
  test("source pins: the refusal line has an id, and Show's aria-describedby names it exactly while the refusal shows", () => {
    const s = qSource();
    expect(s).toContain('<p class="refusal" id="{uid}-refusal">{BUSY_REFUSAL_LINE}</p>');
    expect(s).toContain('aria-describedby={view.refusal ? `${uid}-refusal` : undefined} onclick={show}>{SHOW_BUTTON}</button>');
  });

  test("with no refusal, Show carries no description (server render)", async () => {
    await stored(MAC_STATUS);
    const html = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    const show = html.slice(html.lastIndexOf("<button", html.indexOf(">Show my calendar</button>")), html.indexOf(">Show my calendar</button>"));
    expect(show).not.toContain("aria-describedby");
  });
});

/* ── PB-M7-T1: the wizard's step — its entry read and answer state (pure), over the store's real verdicts ─────── */

describe("PB-M7-T1: the wizard's entry read (wizardCalendarEntry), decided once per entry", () => {
  /** The wizard's composition: the store's own rules over the stored reply (the ONE never-asked rule). */
  const reply = (s: CalendarStatusJson) => ({ neverAsked: neverAsked(s), malformed: malformed(s), enabled: s.enabled === true });
  const START = { kind: "checking", retried: false };
  const after = (verdict: string, s: CalendarStatusJson | null, from: unknown = START) =>
    q.wizardCalendarEntry(from, verdict, s === null ? null : reply(s)) as { next: unknown; readAgain: boolean };
  const stateLine = (line: string) => ({ kind: "state", line: `${line}. You can change this in Settings → Calendar after setup.` });

  test("entering checks: 'Checking your calendar settings…', the start state", () => {
    expect(q.CHECKING_LINE).toBe("Checking your calendar settings…");
    expect(q.WIZARD_ENTRY_START).toEqual(START);
  });

  test("an applied reply decides at once: never asked (no block, no enabled, enabled: null) asks; on, off and malformed are state lines", () => {
    // enabled: null and an absent block both arrive as enabledSet false (the engine's own() rule).
    expect(after("applied", statusReply({ enabledSet: false, enabled: false }))).toEqual({ next: { kind: "ask" }, readAgain: false });
    expect(after("applied", statusReply({ enabledSet: true, enabled: true }))).toEqual({ next: stateLine("Your calendar is on"), readAgain: false });
    expect(after("applied", statusReply({ enabledSet: true, enabled: false }))).toEqual({ next: stateLine("Your calendar is off"), readAgain: false });
    // Malformed wins even over never asked: no question over a block the engine could not read.
    const bad = statusReply({ configWarnings: [`calendar: the block is malformed${CONFIG_OFF}`] });
    expect(after("applied", bad)).toEqual({ next: stateLine("Your calendar settings can't be read"), readAgain: false });
    expect(after("applied", { ...bad, enabledSet: true, enabled: true })).toEqual({ next: stateLine("Your calendar settings can't be read"), readAgain: false });
    // The two warnings that are not malformations do not stop the question.
    expect(after("applied", statusReply({ configWarnings: ["calendar: a literal url is skipped"] }))).toEqual({ next: { kind: "ask" }, readAgain: false });
  });

  test("a dropped reply is read once more; a second drop, or a failed read (at once or on the retry), is the failed-check line", () => {
    const failedLine = stateLine("Your calendar settings couldn't be checked right now");
    const once = after("dropped", statusReply());
    expect(once).toEqual({ next: { kind: "checking", retried: true }, readAgain: true });
    expect(after("dropped", statusReply(), once.next)).toEqual({ next: failedLine, readAgain: false });
    expect(after("failed", null)).toEqual({ next: failedLine, readAgain: false });
    expect(after("failed", null, once.next)).toEqual({ next: failedLine, readAgain: false });
    expect(after("applied", statusReply(), once.next)).toEqual({ next: { kind: "ask" }, readAgain: false });
    // An applied verdict with no reply to read (never in the app) is a failed check, never a question.
    expect(after("applied", null)).toEqual({ next: failedLine, readAgain: false });
  });

  test("decided once: a settled entry ignores any later reply", () => {
    for (const settled of [{ kind: "ask" }, stateLine("Your calendar is on")]) {
      for (const verdict of ["applied", "dropped", "failed"]) {
        expect({ settled, verdict, r: after(verdict, statusReply({ enabledSet: true, enabled: false }), settled) })
          .toEqual({ settled, verdict, r: { next: settled, readAgain: false } });
      }
    }
  });

  test("over the store's real ordering: a read overlapped by a write is dropped, read once more, then applied — as the wizard's loop runs it", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls === 1) await storeWrite(async () => undefined, () => false); // a calendar write overlaps the first read
      return outcomeOf(statusReply());
    };
    let entry: unknown = q.WIZARD_ENTRY_START;
    let again = true;
    while (again) {
      const r = await readStatusThroughStore(read);
      const s = todayStore().status;
      const step = q.wizardCalendarEntry(entry, r.verdict, r.verdict === "applied" && s !== null ? reply(s) : null) as { next: unknown; readAgain: boolean };
      entry = step.next;
      again = step.readAgain;
    }
    expect(calls).toBe(2);
    expect(entry).toEqual({ kind: "ask" });
  });
});

describe("PB-M7-T1: what the wizard's step draws, and when Continue waits (wizardCalendarStep)", () => {
  const ASK = { kind: "ask" };
  const wizardResult = (o: Partial<FlowResult> = {}): FlowResult => ({ origin: "wizard", line: ON_LINE, answered: true, drawn: false, pendingWrite: null, ...o });
  const view = (o: Record<string, unknown> = {}) =>
    q.wizardCalendarStep({ os: "macos", entry: ASK, answer: null, running: null, result: null, entryWaiting: false, ...o }) as Record<string, unknown>;
  const NONE = { box: false, checking: false, stateLine: null, question: false, notNowLine: false, controls: false, continueWithout: false, continueWithoutDisabled: false, continueBlocked: false };

  test("Windows (and an unknown OS) keep today's box, and Continue as it was — whatever the store holds", () => {
    for (const os of ["windows", "other"]) {
      expect(view({ os, entry: null })).toEqual({ ...NONE, box: true });
      expect(view({ os, entry: null, running: { origin: "today", phase: "saving" } })).toEqual({ ...NONE, box: true });
    }
  });

  test("macOS and Linux: checking (before and during the entry read) draws the checking line and holds Continue", () => {
    for (const os of ["macos", "linux"]) {
      expect(view({ os, entry: null })).toEqual({ ...NONE, checking: true, continueBlocked: true });
      expect(view({ os, entry: { kind: "checking", retried: true } })).toEqual({ ...NONE, checking: true, continueBlocked: true });
    }
  });

  test("a state line: no question, Continue enabled (a No can never switch off a working calendar)", () => {
    const line = "Your calendar is on. You can change this in Settings → Calendar after setup.";
    expect(view({ entry: { kind: "state", line } })).toEqual({ ...NONE, stateLine: line });
  });

  test("asked: the question, Continue held until answered — a busy refusal or a Link session closed unanswered answers nothing", () => {
    expect(view()).toEqual({ ...NONE, question: true, continueBlocked: true });
    // Only answeredKind's kinds latch an answer; every other end leaves the answer null, so Continue still waits.
    for (const end of ["busy", "unanswered", "failed", "link", "blocked"]) expect(q.answeredKind(end)).toBeNull();
  });

  test("answered: on keeps the question's card (its result) and shows the wizard-mode controls; off keeps the result alone; Not now swaps in its line", () => {
    // PB r1 X11: the controls follow a GRANT only (an "on" from the Mac path); D3's or a link session's "on" draws none.
    expect(view({ answer: "granted", result: wizardResult() })).toEqual({ ...NONE, question: true, controls: true });
    expect(view({ answer: "on", result: wizardResult() })).toEqual({ ...NONE, question: true });
    expect(view({ answer: "off", result: wizardResult({ line: MAC_NOT_ADDED_LINE }) })).toEqual({ ...NONE, question: true });
    expect(view({ answer: "notNow" })).toEqual({ ...NONE, notNowLine: true });
    expect(q.WIZARD_NOT_NOW_LINE).toBe("Your calendar is off. You can change this in Settings → Calendar after setup.");
  });

  test("while a flow runs (either origin) Continue waits, answered or not, in every macOS/Linux state", () => {
    for (const running of [{ origin: "wizard", phase: "access" }, { origin: "today", phase: "saving" }]) {
      for (const o of [{}, { answer: "on" }, { answer: "notNow" }, { entry: { kind: "state", line: "x" } }]) {
        expect({ running, o, blocked: view({ running, ...o }).continueBlocked }).toEqual({ running, o, blocked: true });
      }
    }
  });

  test("a failed write: 'Continue without a calendar' beside Try again — only for a wizard result holding a write; disabled while a flow runs", () => {
    const held = wizardResult({ line: "Not saved: calendar: bad", answered: false, pendingWrite: { enabled: false, then: null } });
    expect(q.CONTINUE_WITHOUT_BUTTON).toBe("Continue without a calendar");
    expect(view({ result: held })).toEqual({ ...NONE, question: true, continueWithout: true, continueBlocked: true });
    expect(view({ result: held, running: { origin: "wizard", phase: "saving" } })).toMatchObject({ continueWithout: true, continueWithoutDisabled: true });
    expect(view({ result: { ...held, origin: "today" } }).continueWithout).toBe(false);
    expect(view({ answer: "on", result: wizardResult() }).continueWithout).toBe(false);
  });

  test("the store scenario: a failed wizard Not now holds Try again; 'Continue without a calendar' (leaveWizard) drops the write and its result; Today never shows it", async () => {
    await stored(statusReply());
    expect(await notNow("wizard", fakeIo({ calendar: {}, save: async () => INVALID }).io)).toBe("failed");
    const held = todayStore().flow.result;
    expect(held).toMatchObject({ origin: "wizard", pendingWrite: { enabled: false, then: null } });
    expect(view({ result: held }).continueWithout).toBe(true);
    // A wizard result is never Today's: Today's card neither draws it nor is shown for it.
    const today = q.cardView({ origin: "today", ask: false, ownPress: false, running: null, writesInFlight: 0, result: held, linkSession: false, refusal: false });
    expect(today.result).toBeNull();
    leaveWizard();
    expect(todayStore().flow).toEqual({ running: null, result: null });
    expect(view({ result: todayStore().flow.result }).continueWithout).toBe(false);
  });
});

/* ── Design 2026-10-31 r6 §4 (M3): when the step (re-)enters, and what it draws while that waits ──────────────────── */

describe("M3: calendarEntryAction — the step re-enters on a pending entry once no flow runs and no calendar write is in flight", () => {
  test("the table (literal): none when not pending; wait while a flow (either origin) runs or a write is in flight; else enter", () => {
    const WIZ = { origin: "wizard", phase: "access" };
    const TODAY = { origin: "today", phase: "saving" };
    const rows: [boolean, unknown, number, string][] = [
      [false, null, 0, "none"],
      [false, WIZ, 0, "none"],
      [false, TODAY, 0, "none"],
      [false, null, 1, "none"],
      [false, TODAY, 2, "none"],
      [true, null, 0, "enter"],
      [true, WIZ, 0, "wait"],
      [true, TODAY, 0, "wait"],
      [true, null, 1, "wait"],
      [true, null, 2, "wait"],
      [true, TODAY, 1, "wait"],
      [true, WIZ, 3, "wait"],
    ];
    for (const [pending, running, writesInFlight, want] of rows) {
      expect({ pending, running, writesInFlight, got: q.calendarEntryAction({ pending, running, writesInFlight }) })
        .toEqual({ pending, running, writesInFlight, got: want });
    }
  });
});

describe("M3: wizardCalendarStep's entryWaiting — a pending entry draws the checking line and holds Continue, never the last entry's view", () => {
  const view = (o: Record<string, unknown>) =>
    q.wizardCalendarStep({ os: "macos", entry: { kind: "ask" }, answer: null, running: null, result: null, entryWaiting: false, ...o }) as Record<string, unknown>;
  const NONE = { box: false, checking: false, stateLine: null, question: false, notNowLine: false, controls: false, continueWithout: false, continueWithoutDisabled: false, continueBlocked: false };
  const CHECKING = { ...NONE, checking: true, continueBlocked: true };
  const line = "Your calendar is on. You can change this in Settings → Calendar after setup.";
  const held = { origin: "wizard", line: "Not saved: calendar: bad", answered: false, drawn: false, pendingWrite: { enabled: false, then: null } };

  test("entryWaiting: true — checking, whatever the previous entry decided and whatever was answered (macOS and Linux)", () => {
    for (const os of ["macos", "linux"]) {
      for (const o of [
        { entry: null },
        { entry: { kind: "checking", retried: true } },
        { entry: { kind: "ask" } },
        { entry: { kind: "ask" }, answer: "granted" },
        { entry: { kind: "ask" }, answer: "notNow" },
        { entry: { kind: "ask" }, result: held },
        { entry: { kind: "state", line } },
        { entry: { kind: "state", line }, running: { origin: "today", phase: "saving" } },
      ]) {
        expect({ os, o, v: view({ os, entryWaiting: true, ...o }) }).toEqual({ os, o, v: CHECKING });
      }
    }
  });

  test("entryWaiting: false — the same rows as before it existed (it is required now: final harden r2, LOW 5)", () => {
    expect(view({ entryWaiting: false, entry: { kind: "state", line } })).toEqual({ ...NONE, stateLine: line });
    expect(view({ entryWaiting: false })).toEqual({ ...NONE, question: true, continueBlocked: true });
    expect(view({ entryWaiting: false, answer: "granted" })).toEqual({ ...NONE, question: true, controls: true });
    expect(view({ entryWaiting: false, entry: null })).toEqual(CHECKING);
    // Required, not optional: the field is declared without `?`, and the view tests it directly.
    const lib = readFileSync(new URL("../src/lib/calendar-question.ts", import.meta.url).pathname, "utf8");
    expect(lib).toContain("  entryWaiting: boolean;\n}");
    expect(lib).not.toContain("entryWaiting?");
    expect(lib).toContain("  if (i.entryWaiting) return { ...view, checking: true, continueBlocked: true };");
  });

  test("Windows (and an unknown OS) keep the box whatever entryWaiting says — the box reads nothing, so it never waits", () => {
    for (const os of ["windows", "other"]) {
      for (const entryWaiting of [true, false]) {
        expect({ os, entryWaiting, v: view({ os, entryWaiting, entry: null }) }).toEqual({ os, entryWaiting, v: { ...NONE, box: true } });
      }
    }
  });

  test("a decided state entry ignores a late answer: an on / off / Not now / grant arriving after it draws the state line alone", () => {
    for (const answer of ["on", "off", "notNow", "granted"]) {
      expect({ answer, v: view({ entryWaiting: false, entry: { kind: "state", line }, answer }) }).toEqual({ answer, v: { ...NONE, stateLine: line } });
    }
  });
});

describe("PB-M7-T1: the step's children, server-rendered from their own inputs and a seeded store", () => {
  test("a failed wizard write: CalendarQuestion draws Try again and no Close (the wizard's own 'Continue without' is Wizard.svelte's)", async () => {
    const line = "Not saved: calendar: bad";
    seedTodayStoreForTests({ flow: { running: null, result: { origin: "wizard", line, answered: false, drawn: false, pendingWrite: { enabled: false, then: null } } } });
    const html = await card({ origin: "wizard", os: "linux", status: statusReply() });
    expect(html).toMatch(new RegExp(`data-focus="resultLine"[^>]*>${line}</p>`));
    expect(disabledTag(html, "Try again")).toBe(false);
    expect(html).not.toContain(">Close</button>");
    expect(html).not.toContain("Show my calendar");
  });

  test("after a grant: the wizard result line, and the wizard-mode CalendarSettings draws its link controls", async () => {
    seedTodayStoreForTests({ flow: { running: null, result: { origin: "wizard", line: ON_LINE, answered: true, drawn: false, pendingWrite: null } } });
    const html = await card({ origin: "wizard", os: "macos", status: MAC_STATUS, ask: false });
    expect(html).toContain(`data-focus="resultLine">${ON_LINE}</p>`);
    expect(html).not.toContain("Show my calendar");
    const panel = render(CalendarSettings as never, { props: { os: "macos", mode: "wizard" } }).body;
    expect(panel).toContain('<section class="calendar');
    expect(panel).not.toContain("Saving your calendar choice");
  });
});

/* ── PR-B final review round 1, fixer X (items X1, X3-X12) ─────────────────────────────────────────────────── */

describe("PB r1 X1 (MED): the link session has a card-owned way out — the panel cannot always draw Done or Cancel", () => {
  test("PREMISE: the embedded panel over a missing config (configExists false) draws its sentence only — no Done, Cancel or Remove that saved link", () => {
    const html = render(CalendarSettings as never, {
      props: { os: "linux", mode: "wizard", linkOnly: true, startAdding: true, initial: { configText: null, list: null, status: null } },
    }).body;
    expect(html).toContain("Calendar links are saved in your configuration, which does not exist yet.");
    for (const label of ["Done", "Cancel", "Remove that saved link"]) {
      expect({ label, drawn: html.includes(`>${label}</button>`) }).toEqual({ label, drawn: false });
    }
  });

  test("the way out: below the panel in the link branch, disabled while a write is in flight or a flow runs; it ends the session as Done / Cancel with nothing left over would", () => {
    const s = qSource();
    const link = s.slice(s.indexOf("{#if view.link}"), s.indexOf("{:else if view.question}"));
    expect(link.indexOf("<CalendarSettings ")).toBeGreaterThan(-1);
    // PB final LOW L1/L2 (moved): drawn and disabled by `linkBackButton` over the card's `disabled` and the panel's state.
    expect(link).toMatch(/\{#if back\.shown\}\n\s*<div class="row">\n\s*<button type="button" class="ctl action" disabled=\{back\.disabled\} onclick=\{leaveLinkSession\}>\{LINK_BACK_BUTTON\}<\/button>\n\s*<\/div>\n\s*\{\/if\}/);
    expect(s).toContain("const back = $derived(linkBackButton(view.disabled, panel));");
    expect(link.indexOf("{LINK_BACK_BUTTON}")).toBeGreaterThan(link.indexOf("<CalendarSettings "));
    expect(s).toMatch(/function leaveLinkSession\(\): void \{\n\s*sessionEvent\(\{ kind: "addClosed", leftover: false \}\);\n\s*\}/);
    expect(q.LINK_BACK_BUTTON).toBe("Back to the question");
    const base = { origin: "today", ask: true, ownPress: false, running: null, writesInFlight: 0, result: null, linkSession: true, refusal: false };
    expect(q.cardView(base)).toMatchObject({ link: true, disabled: false });
    expect(q.cardView({ ...base, writesInFlight: 1 })).toMatchObject({ link: true, disabled: true });
    expect(q.cardView({ ...base, running: { origin: "wizard", phase: "saving" } })).toMatchObject({ link: true, disabled: true });
    // PB final LOW L1 (moved): the way out never strands a leftover link file. While the panel offers "Remove that saved
    // link" it is not drawn, so it cannot end the session over the offer (spec §4 "Link": the panel stays drawn until
    // onleftovercleared); the session's step still closes from the leftover state, but only the way out reaches that
    // event, and only once the panel can no longer draw the offer (its config unreadable or missing: no dead end).
    expect(q.linkBackButton(false, { working: false, leftoverOffered: true })).toEqual({ shown: false, disabled: false });
    expect(q.linkBackButton(false, { working: false, leftoverOffered: false })).toEqual({ shown: true, disabled: false });
    for (const from of [{ open: true, leftover: false }, { open: true, leftover: true }]) {
      expect({ from, r: q.linkSessionStep(from, { kind: "addClosed", leftover: false }) })
        .toEqual({ from, r: { next: q.LINK_CLOSED, closeFlow: true, notify: false } });
    }
  });

  for (const origin of ["today", "wizard"] as const) {
    test(`${origin}: after the way out with the config unreadable, the closing flow decides — nothing saved is unanswered (Show takes focus, the question returns, the wizard's Continue waits); a save that landed answers on`, async () => {
      const unreadable = async (): Promise<never> => {
        throw { kind: "configUnreadable", detail: "config.json could not be read" };
      };
      await stored(statusReply());
      const none = fakeIo({ calendar: {} });
      expect(await closeLinkSession(origin, { ...none.io, readConfig: unreadable })).toBe("unanswered");
      expect([none.saved, none.counts.reads]).toEqual([[], 1]);
      expect([q.focusAfter(origin, "unanswered"), q.answeredKind("unanswered")]).toEqual(["show", null]);
      expect(q.wizardCalendarStep({ os: "linux", entry: { kind: "ask" }, answer: null, running: null, result: todayStore().flow.result, entryWaiting: false }))
        .toMatchObject({ question: true, continueBlocked: true });
      // The panel's add saved (its patch says enabledSet), then its refresh could not read the config: the way out
      // still answers — "Your calendar is on.", and the wizard's Continue goes.
      resetTodayStoreForTests();
      await stored(statusReply());
      const landed = fakeIo({ calendar: {} });
      await storeSaveBlock(landed.io.saveBlock)({ enabled: true, links: [{ id: "home" }] });
      expect(await closeLinkSession(origin, { ...landed.io, readConfig: unreadable })).toBe("on");
      expect(todayStore().flow.result).toEqual({ origin, line: ON_LINE, answered: true, drawn: false, pendingWrite: null });
      const answer = q.wizardAnswer(q.answeredKind("on"), "linkPath");
      expect(q.wizardCalendarStep({ os: "linux", entry: { kind: "ask" }, answer, running: null, result: todayStore().flow.result, entryWaiting: false }))
        .toMatchObject({ question: true, controls: false, continueBlocked: false });
      close();
    });
  }
});

describe("PB r1 X3: Try again waits for a write in flight, and a double press makes one write", () => {
  test("a deferred Settings save in flight: Try again starts nothing; once it settles (invalid: the held result stays), a double press saves exactly once", async () => {
    await stored(statusReply());
    let fail = true;
    const f = fakeIo({ calendar: {}, save: async () => (fail ? INVALID : SAVED) });
    expect(await notNow("today", f.io)).toBe("failed");
    const held = todayStore().flow.result;
    expect(held?.pendingWrite).toEqual({ enabled: false, then: null });
    const save = deferred<SaveOutcome>();
    const settings = storeSaveBlock(() => save.promise)({ enabled: true });
    expect(todayStore()).toMatchObject({ writesInFlight: 1, flow: { running: null } });
    expect(await tryAgain(f.io)).toBe("blocked");
    expect(f.saved).toHaveLength(1);
    save.resolve(INVALID);
    await settings;
    expect(todayStore().flow.result).toBe(held);
    fail = false;
    expect(await Promise.all([tryAgain(f.io), tryAgain(f.io)])).toEqual(["notNow", "blocked"]);
    expect(f.saved).toHaveLength(2);
  });
});

describe("PB r1 X4: closeLinkSession — blocked by a running flow; decided by enabledSet, not enabled", () => {
  test("(a) a flow held open: the closing flow is blocked — no read, the running flow untouched", async () => {
    await stored(statusReply());
    const save = deferred<SaveOutcome>();
    const run = notNow("today", fakeIo({ calendar: {}, save: () => save.promise }).io);
    const f = fakeIo({ calendar: {} });
    expect(await closeLinkSession("wizard", f.io)).toBe("blocked");
    expect(f.counts.reads).toBe(0);
    expect(todayStore().flow.running).toEqual({ origin: "today", phase: "saving" });
    save.resolve(SAVED);
    expect(await run).toBe("notNow");
  });

  test("(b) enabledSet true with enabled false (a block `{ enabled: false }`): the spec's rule reads enabledSet — answered, 'Your calendar is on.'", async () => {
    await stored(statusReply());
    const f = fakeIo({ calendar: { enabled: false } });
    expect(await closeLinkSession("today", f.io)).toBe("on");
    expect(todayStore().status).toMatchObject({ enabled: false, enabledSet: true });   // PREMISE: the two differ
    expect(todayStore().flow.result).toEqual({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null });
  });

  test("(c) its comment says a write in flight does not block it, and why that is harmless", () => {
    const src = readFileSync(new URL("../src/lib/today-store.ts", import.meta.url).pathname, "utf8");
    const doc = src.slice(src.lastIndexOf("/**", src.indexOf("export async function closeLinkSession(")), src.indexOf("export async function closeLinkSession("));
    expect(doc).toContain("a write in flight does not block it");
  });
});

describe("PB r1 X5-X7: a busy refusal, leaveWizard and the one result slot keep what they did not replace", () => {
  test("X5: a busy refusal keeps an undrawn Today result held before it — the same object", async () => {
    await stored(statusReply({ macSupported: true }));
    const undrawn: FlowResult = { origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null };
    seedTodayStoreForTests({ flow: { running: null, result: undrawn } });
    const f = fakeIo({ calendar: {}, macSupported: true, connect: async () => {
      throw BUSY;
    } });
    expect(await startShow("today", f.io)).toBe("busy");
    expect(todayStore().flow.result).toBe(undrawn);
    expect([f.saved, f.counts.reads]).toEqual([[], 0]);
  });

  test("X6: leaveWizard while a Today flow runs reaches nothing — the Today result is kept when it settles", async () => {
    await stored(statusReply({ sources: [LINK] }));
    const save = deferred<SaveOutcome>();
    const run = startShow("today", fakeIo({ calendar: {}, sources: [LINK], save: () => save.promise }).io);
    expect(todayStore().flow.running).toEqual({ origin: "today", phase: "saving" });
    leaveWizard();
    save.resolve(SAVED);
    expect(await run).toBe("on");
    expect(todayStore().flow.result).toEqual({ origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null });
  });

  test("X7: a wizard flow abandoned under leaveWizard never wipes a held Today result it did not replace; its own accepted write still wins", async () => {
    const pending = (): Promise<FlowResult> => (async () => {
      await stored(statusReply());
      expect(await notNow("today", fakeIo({ calendar: {}, save: async () => INVALID }).io)).toBe("failed");
      return todayStore().flow.result!;
    })();
    const undrawn: FlowResult = { origin: "today", line: ON_LINE, answered: true, drawn: false, pendingWrite: null };
    for (const [label, seed, outcome, end, kept] of [
      ["a held Today write, the wizard's save invalid (nothing accepted)", "pending", INVALID, "failed", true],
      ["a held Today write, the wizard's save accepted (a later choice wins)", "pending", SAVED, "on", false],
      ["an undrawn Today result (no write held), the wizard's save accepted", "undrawn", SAVED, "on", true],
    ] as const) {
      resetTodayStoreForTests();
      let held: FlowResult;
      if (seed === "pending") held = await pending();
      else {
        held = undrawn;
        seedTodayStoreForTests({ flow: { running: null, result: undrawn } });
      }
      await stored(statusReply({ sources: [LINK] }));
      const save = deferred<SaveOutcome>();
      const run = startShow("wizard", fakeIo({ calendar: {}, sources: [LINK], save: () => save.promise }).io);
      expect(todayStore().flow.running).toEqual({ origin: "wizard", phase: "saving" });
      leaveWizard();
      save.resolve(outcome);
      expect({ label, end: await run }).toEqual({ label, end });
      expect({ label, flow: todayStore().flow }).toEqual({ label, flow: { running: null, result: kept ? held : null } });
    }
  });
});

describe("PB r1 X9: the privacy header names the retired calendar promise without quoting a phrase the list does not hold", () => {
  test("the header no longer names a phrase that is not in SUPERSEDED", () => {
    const src = readFileSync(new URL("../src/lib/calendar-question.ts", import.meta.url).pathname, "utf8");
    expect(src.slice(0, src.indexOf("*/"))).toContain("SUPERSEDED");
    expect(src).not.toContain("never leaves this computer");
  });
});

describe("PB r1 X10: the question stays through a flow only when this card's own press started it with the gate open", () => {
  test("cardView: a same-origin flow keeps the question with the latch (ownPress), never without it", () => {
    const base = { origin: "today", ask: false, ownPress: false, running: { origin: "today", phase: "saving" }, writesInFlight: 0, result: null, linkSession: false, refusal: false };
    expect(q.cardView(base)).toMatchObject({ question: false, busyLine: BUSY_SAVING_LINE });
    expect(q.cardView({ ...base, ownPress: true })).toMatchObject({ question: true, busyLine: BUSY_SAVING_LINE, disabled: true });
    expect(q.cardView({ ...base, origin: "wizard", ask: true })).toMatchObject({ question: true });   // the gate alone still asks
  });

  test("over the store: a link session whose own save turned the calendar on — its closing flow's re-read never draws the question (the latch is off: no press started it)", async () => {
    await stored(statusReply({ enabled: true, enabledSet: true, sources: [LINK] }));
    const read = deferred<EngineOutcome>();
    const f = fakeIo({ calendar: { enabled: true, links: [{ id: "home" }] }, sources: [LINK] });
    const states: { running: boolean; question: boolean; busy: string | null }[] = [];
    const off = onTodayStore((s) => {
      const gate = (q.todayCard({ hasPage: true, scheduleState: { phase: { phase: "idle" } } as never, neverAsked: neverAsked(s.status), malformed: s.status !== null && malformed(s.status), os: "linux", closed: false, running: s.flow.running, result: s.flow.result, linkSession: false }) as { question: boolean }).question;
      const v = q.cardView({ origin: "today", ask: gate, ownPress: false, running: s.flow.running, writesInFlight: s.writesInFlight, result: s.flow.result, linkSession: false, refusal: false });
      states.push({ running: s.flow.running !== null, question: v.question, busy: v.busyLine });
    });
    const flow = closeLinkSession("today", { ...f.io, status: () => read.promise });
    read.resolve(outcomeOf(statusReply({ enabled: true, enabledSet: true, sources: [LINK] })));
    expect(await flow).toBe("on");
    off();
    const running = states.filter((s) => s.running);
    expect(running.length).toBeGreaterThan(0);
    expect(running.every((s) => !s.question && s.busy === BUSY_SAVING_LINE)).toBe(true);
  });

  test("wiring: the latch is per mount, set by the presses (above), cleared first when any flow ends, and never by the session event", () => {
    const s = qSource();
    expect(s).toContain("let ownPress = $state(false);");
    expect(s).toMatch(/function ended\(end: FlowEnd\): void \{\n\s*ownPress = false;\n/);
    const session = s.slice(s.indexOf("function sessionEvent("), s.indexOf("\n  }\n", s.indexOf("function sessionEvent(")));
    expect(session).not.toContain("ownPress");
    expect(s.match(/ownPress = ask;/g)).toHaveLength(3);
  });
});

describe("PB r1 X11: the wizard's controls follow a grant only", () => {
  test("wizardAnswer: an 'on' from the Mac path is a grant; D3's, the link session's, off and Not now are as they are", () => {
    expect(q.wizardAnswer("on", "mac")).toBe("granted");
    expect(q.wizardAnswer("on", "link")).toBe("on");
    expect(q.wizardAnswer("on", "linkPath")).toBe("on");
    expect(q.wizardAnswer("on", null)).toBe("on");
    expect(q.wizardAnswer("off", "mac")).toBe("off");
    expect(q.wizardAnswer("notNow", null)).toBe("notNow");
  });

  test("over the store, the path read before the press: a Mac grant shows the controls; D3 and a closed link session do not; every one lets Continue go", async () => {
    const step = (answer: unknown) => q.wizardCalendarStep({ os: "macos", entry: { kind: "ask" }, answer, running: null, result: todayStore().flow.result, entryWaiting: false }) as Record<string, unknown>;
    // The Mac path: granted, listed.
    await stored(statusReply({ macSupported: true }));
    let path = q.pathOf(todayStore().status);
    expect(await startShow("wizard", fakeIo({ calendar: {}, macSupported: true, sources: [MAC] }).io)).toBe("on");
    expect(step(q.wizardAnswer("on", path))).toMatchObject({ controls: true, continueBlocked: false });
    // D3: a link already added.
    resetTodayStoreForTests();
    await stored(statusReply({ macSupported: true, sources: [LINK] }));
    path = q.pathOf(todayStore().status);
    expect(await startShow("wizard", fakeIo({ calendar: {}, macSupported: true, sources: [LINK] }).io)).toBe("on");
    expect(step(q.wizardAnswer("on", path))).toMatchObject({ controls: false, continueBlocked: false });
    // The Link path on a Mac without macSupported: the session's save, then its closing flow.
    resetTodayStoreForTests();
    await stored(statusReply({ macSupported: false }));
    path = q.pathOf(todayStore().status);
    const f = fakeIo({ calendar: {} });
    expect(await startShow("wizard", f.io)).toBe("link");
    await storeSaveBlock(f.io.saveBlock)({ enabled: true, links: [{ id: "home" }] });
    expect(await closeLinkSession("wizard", f.io)).toBe("on");
    expect(step(q.wizardAnswer("on", path))).toMatchObject({ controls: false, continueBlocked: false });
    leaveWizard();
  });

  test("pathOf: the stored status's starting state, null with none", () => {
    expect(q.pathOf(null)).toBeNull();
    expect(q.pathOf(statusReply({ macSupported: true }))).toBe("mac");
    expect(q.pathOf(statusReply({ sources: [LINK] }))).toBe("link");
    expect(q.pathOf(statusReply())).toBe("linkPath");
  });
});

describe("PB r1 X12: the Link path keeps the question; the explanation describes the question's group", () => {
  test("the link branch draws the question text above the embedded panel (the card replaces its buttons, not the question)", () => {
    const s = qSource();
    const link = s.slice(s.indexOf("{#if view.link}"), s.indexOf("{:else if view.question}"));
    expect(link).toContain('<p class="q" id="{uid}-q">{QUESTION}</p>');
    expect(link.indexOf("{QUESTION}")).toBeLessThan(link.indexOf("<CalendarSettings "));
  });

  test("server render: the group is described by the explanation (its id resolves to the text); with no status, no description", async () => {
    await stored(MAC_STATUS);
    const html = await card({ origin: "today", os: "macos", status: MAC_STATUS });
    const group = /<div[^>]*role="group"[^>]*>/.exec(html)?.[0] ?? "";
    const described = /aria-describedby="([^"]+)"/.exec(group);
    expect(described).not.toBeNull();
    expect(tagWithId(html, described![1]!)).toBe(q.explanationFor(MAC_STATUS));
    const none = await card({ origin: "today", os: "macos", status: null });
    expect(/<div[^>]*role="group"[^>]*>/.exec(none)?.[0] ?? "<none>").not.toContain("aria-describedby");
  });
});

/* ── PR-B post-convergence LOW pass (L1-L3, L5) ──────────────────────────────────────────────────────────── */

describe("PB final LOW L1/L2: the link session's way out follows the embedded panel — never over its leftover offer, never mid-write", () => {
  test("linkPanelState: the offer exactly where the wizard branch draws it (a leftover, loaded, the config read, not missing); working as given", () => {
    const base = { working: false, leftover: "home", loaded: true, configError: null, configExists: true };
    expect(linkPanelState(base)).toEqual({ working: false, leftoverOffered: true });
    expect(linkPanelState({ ...base, working: true })).toEqual({ working: true, leftoverOffered: true });
    // The branch's `{:else if configExists === false}` reads only false, so a null (never set) still reaches the offer.
    expect(linkPanelState({ ...base, configExists: null }).leftoverOffered).toBe(true);
    for (const [label, patch] of [
      ["no leftover", { leftover: null }],
      ["not loaded", { loaded: false }],
      ["the config unreadable", { configError: "config.json could not be read" }],
      ["no config", { configExists: false }],
    ] as const) {
      expect({ label, s: linkPanelState({ ...base, ...patch, working: true }) }).toEqual({ label, s: { working: true, leftoverOffered: false } });
    }
    expect(LINK_PANEL_IDLE).toEqual({ working: false, leftoverOffered: false });
  });

  test("linkBackButton: hidden while the panel offers Remove; drawn again once it cannot (no dead end); disabled while the card waits or the panel's own write runs", () => {
    for (const cardDisabled of [false, true]) {
      for (const working of [false, true]) {
        for (const leftoverOffered of [false, true]) {
          expect({ cardDisabled, working, leftoverOffered, b: q.linkBackButton(cardDisabled, { working, leftoverOffered }) })
            .toEqual({ cardDisabled, working, leftoverOffered, b: { shown: !leftoverOffered, disabled: cardDisabled || working } });
        }
      }
    }
  });

  test("PREMISE (L2): mid-add, between the panel's link write and its block save, no write is in flight and no flow runs — the card's own disabled alone lets the way out go; the panel's working holds it", async () => {
    await stored(statusReply());
    const f = fakeIo({ calendar: {} });
    const config = deferred<Awaited<ReturnType<FlowIo["readConfig"]>>>();
    const add = addLink({ id: "home", name: "Home", takeUrl: () => "https://x.example/c.ics" }, {
      writeLink: (id) => storeWrite(async () => ({ id, confirmationCleared: false }) as never, () => true),
      readConfig: () => config.promise,
      saveBlock: storeSaveBlock(f.io.saveBlock),
      list: async () => ({ schemaVersion: 1, macos: null, links: [] }) as never,
    }, describeFailure, { turnOn: true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect([todayStore().writesInFlight, todayStore().flow.running, f.saved]).toEqual([0, null, []]);
    const view = q.cardView({ origin: "today", ask: true, ownPress: false, running: null, writesInFlight: 0, result: null, linkSession: true, refusal: false });
    expect(view.disabled).toBe(false);
    expect(q.linkBackButton(view.disabled, { working: true, leftoverOffered: false })).toEqual({ shown: true, disabled: true });
    config.resolve(await f.io.readConfig());
    expect((await add).kind).toBe("added");
    expect(f.saved).toEqual([{ links: [{ id: "home", name: "Home" }], enabled: true }]);
  });

  test("wiring: CalendarSettings reports its state from an effect after its first mount (nothing without the callback); only the card passes it; the card resets it when the session ends", () => {
    const cs = readFileSync(new URL("../src/lib/CalendarSettings.svelte", import.meta.url).pathname, "utf8");
    const script = cs.slice(0, cs.indexOf("</script>"));
    expect(script).toContain("    onpanelstate?: ((state: LinkPanelState) => void) | undefined;\n");
    const end = script.indexOf("$props()");
    expect(script.slice(script.lastIndexOf("let {", end), end)).toContain("\n    onpanelstate,\n");
    const effect = script.indexOf("$effect(() => {\n    onpanelstate?.(linkPanelState({ working, leftover, loaded, configError, configExists }));\n  });");
    expect(effect).toBeGreaterThan(script.indexOf("onMount("));
    expect(cs.match(/onpanelstate\?\.\(/g)).toHaveLength(1);
    // The template is untouched: the callback appears in the script only.
    expect(cs.slice(cs.indexOf("</script>"))).not.toContain("onpanelstate");
    const s = qSource();
    expect(s).toContain("let panel = $state.raw<LinkPanelState>(LINK_PANEL_IDLE);");
    expect(s).toMatch(/function sessionEvent\(e: LinkEvent\): void \{\n\s*const r = linkSessionStep\(session, e\);\n\s*session = r\.next;\n\s*if \(!session\.open\) panel = LINK_PANEL_IDLE;\n/);
    expect(s.match(/onpanelstate=/g)).toHaveLength(1);
    for (const other of ["routes/Wizard.svelte", "lib/settings/CalendarPage.svelte", "routes/Today.svelte"]) {
      const text = readFileSync(new URL(`../src/${other}`, import.meta.url).pathname, "utf8");
      expect({ other, passes: text.includes("onpanelstate") }).toEqual({ other, passes: false });
    }
  });
});

describe("PB final LOW L3: the wizard asks no question while a flow runs that its own press did not start (the link session's closing flow)", () => {
  /** Wizard.svelte's `ask`, as its CalendarQuestion tag computes it. */
  const wizardAsk = (answer: unknown, running: Running): boolean => answer === null && running === null;
  const view = (running: Running, ownPress: boolean) =>
    q.cardView({ origin: "wizard", ask: wizardAsk(null, running), ownPress, running, writesInFlight: 0, result: null, linkSession: false, refusal: false });

  test("the closing flow running: no question (the busy line alone); ended unanswered: the question is back; a press of its own keeps it", () => {
    const closing: Running = { origin: "wizard", phase: "saving" };
    expect(view(closing, false)).toMatchObject({ question: false, busyLine: BUSY_SAVING_LINE });
    expect(view(null, false)).toMatchObject({ question: true, busyLine: null, disabled: false });
    // Show my calendar / Not now / Try again: the press latched `ownPress` from the open gate, so the question stays.
    expect(view(closing, true)).toMatchObject({ question: true, busyLine: BUSY_SAVING_LINE, disabled: true });
  });

  test("source pin: the tag's gate also waits for a running flow — and never reads neverAsked (a blocked close would leave no question and Continue held)", () => {
    const wiz = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url).pathname, "utf8");
    const tag = wiz.slice(wiz.indexOf('<CalendarQuestion origin="wizard"'), wiz.indexOf("/>", wiz.indexOf('<CalendarQuestion origin="wizard"')));
    expect(tag).toContain("ask={calendarAnswer === null && calendarStore.flow.running === null}");
    expect(tag).not.toContain("neverAsked");
  });
});

describe("PB final LOW L5: closeLinkSession is not blocked by a write in flight (only by a running flow)", () => {
  for (const landed of [false, true]) {
    test(`a deferred Settings save in flight: the closing flow still runs and decides from the stored status — ${landed ? "on" : "unanswered"}, never blocked`, async () => {
      await stored(statusReply());
      const f = fakeIo({ calendar: {} });
      // `landed`: an earlier accepted save already patched enabledSet (the panel's add).
      if (landed) await storeSaveBlock(f.io.saveBlock)({ enabled: true, links: [{ id: "home" }] });
      const save = deferred<SaveOutcome>();
      const settings = storeSaveBlock(() => save.promise)({ enabled: true, links: [{ id: "home" }] });
      expect([todayStore().writesInFlight, canStart()]).toEqual([1, false]);
      expect(await closeLinkSession("today", f.io)).toBe(landed ? "on" : "unanswered");
      expect(f.counts.reads).toBe(1);
      expect(todayStore().flow.result?.line ?? null).toBe(landed ? ON_LINE : null);
      save.resolve(SAVED);
      await settings;
      close();
    });
  }
});
