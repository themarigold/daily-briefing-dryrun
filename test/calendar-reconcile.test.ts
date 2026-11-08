// test/calendar-reconcile.test.ts — today's window and RECONCILE, THEN FILTER (v0.3.0 plan M3a; spec r4 §5).
//
// Pure tables: inputs are `CalEvent`s built here, except the accepted-risk PIN case that exercises the Mac producer.
// M3a must not depend on the M2c parser.
// Instants are built with LOCAL constructors, so the in-process tables hold in any zone; the DST days run in
// child processes under a FORCED zone, because `bun test` runs in UTC, where no day is 23 or 25 hours long,
// and bun cannot put an unset TZ back once a test has assigned one (test/in10-stash-suggestions.test.ts).
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { collapseIndexEntry,
  CALENDAR_G6_PASSED, addDays, allDayFromInclusiveEnd, calendarToday, isNotAccepted, mergeCopies, newerThan,
  nearDupTitle, normaliseTitle, overlapsToday, placeFactsVeto, reconcileCalendar, reconcileWindow, titlesRelated, type CalG6Switches,
  type KeyCFacts, canonicalViewHash, coreOrder, keyCOrder, reconcileBeforeFilter, selectNearDupCore, tierOf,
} from "../src/calendar/reconcile";
import { producerKeys } from "../src/calendar/join";
import { macEventFrom } from "../src/calendar/mac-events";
import { formatLockedEvent } from "../src/calendar/prompt";
import type { CalEvent, CalSelfStatus, CalSourceRef, CalTime, CalUidIndex } from "../src/calendar/types";

const RUN = "2026-10-09";
/** A local instant on the run date (or `day` days after it). */
const at = (h: number, m = 0, day = 0): number => new Date(2026, 9, 9 + day, h, m).getTime();
const timed = (sh: number, sm: number, eh: number, em: number, day = 0): CalTime =>
  ({ kind: "timed", startMs: at(sh, sm, day), endMs: at(eh, em, day) });

const MAC: CalSourceRef = { kind: "macos", id: "macos", calendarId: "cal-home" };
const MAC_WORK: CalSourceRef = { kind: "macos", id: "macos", calendarId: "cal-work" };
const WORK: CalSourceRef = { kind: "link", id: "work", calendarId: "work" };
const HOME: CalSourceRef = { kind: "link", id: "home", calendarId: "home" };
const TEAM: CalSourceRef = { kind: "link", id: "team", calendarId: "team" };

function ev(source: CalSourceRef, over: Partial<CalEvent> = {}): CalEvent {
  return {
    sources: [source], time: timed(9, 0, 9, 30), title: "Standup", attendees: [], selfStatus: "accepted",
    organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {}, ...over,
  };
}
const titles = (list: CalEvent[]): string[] => list.map((e) => e.title);

// ── the today window ─────────────────────────────────────────────────────────────────────────────────

/** `calendarToday` / `reconcileWindow` evaluated in a CHILD process whose zone is forced to `zone`. */
async function windowsIn(zone: string, dates: string[]): Promise<Record<string, [string, string, number]>> {
  const code = `const { calendarToday, reconcileWindow } = await import(${JSON.stringify(join(import.meta.dir, "../src/calendar/reconcile.ts"))});
const out = {};
for (const d of ${JSON.stringify(dates)}) {
  const w = calendarToday(d), l = reconcileWindow(d, "link"), m = reconcileWindow(d, "macos");
  out[d] = [new Date(w.startMs).toISOString(), new Date(w.endMs).toISOString(), (w.endMs - w.startMs) / 3600000];
  out[d + "/link"] = [new Date(l.startMs).toISOString(), new Date(l.endMs).toISOString(), (l.endMs - l.startMs) / 3600000];
  out[d + "/macos"] = [new Date(m.startMs).toISOString(), new Date(m.endMs).toISOString(), (m.endMs - m.startMs) / 3600000];
}
console.log(JSON.stringify(out));`;
  const p = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`window child (${zone}) exited ${p.exitCode}: ${err}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("today window (spec §5: [local midnight, next local midnight) by date arithmetic)", () => {
  test("DST days are 23 and 25 hours long; a zone whose midnight does not exist starts at its first instant", async () => {
    // Expectations are literal instants, not recomputed with the code's own arithmetic.
    const ny = await windowsIn("America/New_York", ["2026-03-08", "2026-11-01", "2026-10-09"]);
    expect(ny["2026-03-08"]).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23]);   // spring forward
    expect(ny["2026-11-01"]).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25]);   // fall back
    expect(ny["2026-10-09"]).toEqual(["2026-10-09T04:00:00.000Z", "2026-10-10T04:00:00.000Z", 24]);
    // The reconcile windows straddle the change: today ± 2 (links) is 5 local days, one of them 23 h.
    expect(ny["2026-03-08/link"]).toEqual(["2026-03-06T05:00:00.000Z", "2026-03-11T04:00:00.000Z", 119]);
    expect(ny["2026-03-08/macos"]).toEqual(["2026-03-07T05:00:00.000Z", "2026-03-10T04:00:00.000Z", 71]);
    const ldn = await windowsIn("Europe/London", ["2026-03-29", "2026-10-25"]);
    expect(ldn["2026-03-29"]).toEqual(["2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z", 23]);
    expect(ldn["2026-10-25"]).toEqual(["2026-10-24T23:00:00.000Z", "2026-10-26T00:00:00.000Z", 25]);
    // Chile's DST starts AT midnight (00:00 → 01:00): the day begins at 01:00 local, its first instant.
    const scl = await windowsIn("America/Santiago", ["2026-09-06"]);
    expect(scl["2026-09-06"]).toEqual(["2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z", 23]);
  }, 30_000);

  test("a run that crosses midnight keeps its day: the window is a function of the run date alone", () => {
    const w = calendarToday(RUN);
    expect(w).toEqual({ startMs: at(0), endMs: at(0, 0, 1) });
    // An event late on the run date stays today's, and one just after midnight stays tomorrow's, whatever the
    // clock says when the reconcile runs — no clock is read.
    const out = reconcileCalendar({ runDate: RUN, copies: [
      ev(WORK, { title: "Late", time: timed(23, 0, 23, 30) }),
      ev(WORK, { title: "After midnight", time: timed(0, 15, 0, 45, 1) }),
    ] });
    expect(titles(out)).toEqual(["Late"]);
  });

  test("date arithmetic: month and year ends, leap day; a malformed date throws", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(() => addDays("2026-02-30", 1)).toThrow();
    expect(() => calendarToday("10/09/2026")).toThrow();
  });
});

describe("overlap with today", () => {
  test("timed: half-open; zero-length counts inside the day; ending at midnight is yesterday's", () => {
    expect(overlapsToday(timed(9, 0, 10, 0), RUN)).toBe(true);
    expect(overlapsToday({ kind: "timed", startMs: at(22, 0, -1), endMs: at(0) }, RUN)).toBe(false);   // ends at today's 00:00
    expect(overlapsToday({ kind: "timed", startMs: at(22, 0, -1), endMs: at(0, 1) }, RUN)).toBe(true);
    expect(overlapsToday({ kind: "timed", startMs: at(0, 0, 1), endMs: at(1, 0, 1) }, RUN)).toBe(false); // starts at tomorrow's 00:00
    expect(overlapsToday({ kind: "timed", startMs: at(0), endMs: at(0) }, RUN)).toBe(true);
    expect(overlapsToday({ kind: "timed", startMs: at(0, 0, 1), endMs: at(0, 0, 1) }, RUN)).toBe(false);
    expect(overlapsToday({ kind: "timed", startMs: at(9, 0, -7), endMs: at(9, 0, 1) }, RUN)).toBe(true);  // a week-long trip
    expect(overlapsToday({ kind: "timed", startMs: Number.NaN, endMs: at(10) }, RUN)).toBe(false);
  });

  test("all-day (exclusive end) and unclear (inclusive wall dates); malformed dates never overlap", () => {
    expect(overlapsToday({ kind: "allDay", startDate: RUN, endDateExclusive: "2026-10-10" }, RUN)).toBe(true);
    expect(overlapsToday({ kind: "allDay", startDate: "2026-10-08", endDateExclusive: RUN }, RUN)).toBe(false);
    expect(overlapsToday({ kind: "allDay", startDate: "2026-10-05", endDateExclusive: "2026-10-12" }, RUN)).toBe(true);
    expect(overlapsToday({ kind: "allDay", startDate: RUN, endDateExclusive: RUN }, RUN)).toBe(true);     // end ≤ start: one day
    expect(overlapsToday({ kind: "allDay", startDate: "2026-10-10", endDateExclusive: "2026-10-11" }, RUN)).toBe(false);
    const u = (startDate: string, endDate: string): CalTime => ({ kind: "unclear", startDate, endDate, wallStart: "14:00", wallEnd: "15:00", tzid: "Custom/Zone" });
    expect(overlapsToday(u(RUN, RUN), RUN)).toBe(true);
    expect(overlapsToday(u("2026-10-08", RUN), RUN)).toBe(true);
    expect(overlapsToday(u("2026-10-10", "2026-10-10"), RUN)).toBe(false);
    expect(overlapsToday({ kind: "allDay", startDate: "2026-10-09zzz", endDateExclusive: "2026-10-10" }, RUN)).toBe(false);
    expect(overlapsToday(u("2026-02-30", "2026-12-31"), RUN)).toBe(false);
  });

  test("both all-day conventions: an EventKit inclusive end, normalised, merges with the iCalendar copy", () => {
    expect(allDayFromInclusiveEnd(RUN, RUN)).toEqual({ kind: "allDay", startDate: RUN, endDateExclusive: "2026-10-10" });
    expect(allDayFromInclusiveEnd("2026-10-08", "2026-10-11")).toEqual({ kind: "allDay", startDate: "2026-10-08", endDateExclusive: "2026-10-12" });
    expect(allDayFromInclusiveEnd(RUN, "2026-10-01")).toEqual({ kind: "allDay", startDate: RUN, endDateExclusive: "2026-10-10" });
    const link = ev(WORK, { title: "Offsite", time: { kind: "allDay", startDate: "2026-10-08", endDateExclusive: "2026-10-12" } });
    const mac = ev(MAC, { title: "Offsite", time: allDayFromInclusiveEnd("2026-10-08", "2026-10-11") });
    const out = reconcileCalendar({ runDate: RUN, copies: [link, mac] });
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toEqual([WORK, MAC]);
    // An all-day event that ENDED yesterday under the inclusive convention is not today's.
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(MAC, { time: allDayFromInclusiveEnd("2026-10-07", "2026-10-08") })] })).toEqual([]);
  });
});

// ── key a / key b ────────────────────────────────────────────────────────────────────────────────────

describe("key a: same UID and recurrenceKey, any sources", () => {
  test("merges across sources and within one (the same event in two Mac calendars); a different occurrence does not", () => {
    const a = ev(WORK, { uid: "u1", recurrenceKey: String(at(9)), title: "Sync", lastModified: 1 });
    const b = ev(MAC, { uid: "u1", recurrenceKey: String(at(9)), title: "Sync (renamed)", lastModified: 2 });
    const c = ev(MAC_WORK, { uid: "u1", recurrenceKey: String(at(9)), title: "Sync (renamed)", lastModified: 2 });
    const other = ev(WORK, { uid: "u1", recurrenceKey: String(at(9, 0, -1)), title: "Sync", time: timed(9, 0, 9, 30) });
    const out = reconcileCalendar({ runDate: RUN, copies: [a, b, c, other] });
    expect(out).toHaveLength(2);
    const merged = out.find((e) => e.sources.length === 3)!;
    expect(merged.title).toBe("Sync (renamed)");
    expect(merged.sources).toEqual([WORK, MAC, MAC_WORK]);
  });

  test("a single event (no recurrenceKey) merges with its copy that also has none, never with an occurrence", () => {
    const single = ev(WORK, { uid: "u2", title: "One-off" });
    const copy = ev(HOME, { uid: "u2", title: "One-off", time: timed(9, 0, 9, 30) });
    const occ = ev(TEAM, { uid: "u2", recurrenceKey: String(at(9)), title: "Different" , time: timed(11, 0, 11, 30) });
    expect(reconcileCalendar({ runDate: RUN, copies: [single, copy, occ] }).map((e) => e.sources.length).sort()).toEqual([1, 2]);
  });
});

describe("key b: across different sources only, unique candidates only", () => {
  test("same normalised title + same time across two sources → one event", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { title: "  Weekly   SYNC " }), ev(MAC, { title: "weekly sync" })] });
    expect(out).toHaveLength(1);
    expect(normaliseTitle("  Weekly   SYNC ")).toBe("weekly sync");
    expect(normaliseTitle("ｗｅｅｋｌｙ")).toBe("weekly");   // NFKC
  });

  test("different time, or two different organizer emails → not merged; one missing organizer → merged", () => {
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK), ev(MAC, { time: timed(9, 0, 9, 45) })] })).toHaveLength(2);
    const o1 = { organizer: { email: "a@example.com" } }, o2 = { organizer: { email: "b@example.com" } };
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, o1), ev(MAC, o2)] })).toHaveLength(2);
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, o1), ev(MAC, { organizer: { email: "A@Example.com" } })] })).toHaveLength(1);
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, o1), ev(MAC)] })).toHaveLength(1);
  });

  // User-directed migration (decision 19 exception for key c, 2026-10-31): key b is unchanged, and the three tests
  // below keep its intent. Key c would now merge their location-free copies, so each copy is given its own physical
  // place (with the matching producer keys) and key c's place veto keeps the key-b separation visible. The original
  // location-free fixtures are now key-c merges: M16/M02, M25 and M26 in the key-c blocks below.
  const at_ = (place: string): Partial<CalEvent> => ({ location: place, ...producerKeys({ location: place }) });

  test("key b does not merge within one source, including two Mac calendars; key c vetoed by distinct places", () => {
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, at_("Clinic A")), ev(WORK, at_("Clinic B"))] })).toHaveLength(2);
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(MAC, at_("Clinic A")), ev(MAC_WORK, at_("Clinic B"))] })).toHaveLength(2);
  });

  test("key b refuses every ambiguous pair with two Mac lookalikes; distinct places veto key c", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [
      ev(WORK, { title: "Focus", ...at_("Clinic A") }), ev(MAC, { title: "Focus", ...at_("Clinic B") }), ev(MAC_WORK, { title: "Focus", ...at_("Clinic C") }),
    ] });
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.sources.length === 1)).toBe(true);
  });

  test("key b merges the unique WORK–HOME pair despite ambiguous Mac lookalikes; distinct places veto key c", () => {
    // WORK and HOME each have one "Sync"; the Mac source has two (two calendars). WORK–HOME is unambiguous and
    // merges; every pair with a Mac copy is ambiguous, so both Mac copies stay on their own.
    const out = reconcileCalendar({ runDate: RUN, copies: [
      ev(WORK, { title: "Sync", ...at_("Clinic A") }), ev(HOME, { title: "Sync", ...at_("Clinic B") }),
      ev(MAC, { title: "Sync", ...at_("Clinic C") }), ev(MAC_WORK, { title: "Sync", ...at_("Clinic D") }),
    ] });
    expect(out.map((e) => e.sources.map((s) => s.calendarId).join("+")).sort()).toEqual(["cal-home", "cal-work", "work+home"]);
  });

  test("the same meeting through three sources is ONE event (uniqueness is per source)", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [ev(WORK), ev(HOME), ev(MAC)] });
    expect(out).toHaveLength(1);
    expect(out[0]!.sources).toEqual([WORK, HOME, MAC]);
  });

  test("a chain joining two DIFFERENT organizers through a copy with none is split back apart", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [
      ev(WORK, { organizer: { email: "a@example.com" } }), ev(HOME), ev(TEAM, { organizer: { email: "b@example.com" } }),
    ] });
    expect(out).toHaveLength(3);
  });

  test("key b compares the key-a-merged view: a stale copy's old time does not block the match", () => {
    // WORK has two copies of u3 (moved 09:00 → 10:00, the newer at 10:00); MAC has the meeting at 10:00 with no UID.
    const out = reconcileCalendar({ runDate: RUN, copies: [
      ev(WORK, { uid: "u3", title: "Review", time: timed(9, 0, 9, 30), lastModified: 1 }),
      ev(WORK, { uid: "u3", title: "Review", time: timed(10, 0, 10, 30), lastModified: 2 }),
      ev(MAC, { title: "Review", time: timed(10, 0, 10, 30) }),
    ] });
    expect(out).toHaveLength(1);
    expect(out[0]!.time).toEqual(timed(10, 0, 10, 30));
  });
});

// ── the merged copy ──────────────────────────────────────────────────────────────────────────────────

describe("merge (spec §5 step 3)", () => {
  test("attendees unioned by email (case-insensitive), each from the latest copy listing it; name-only ones from the latest copy", () => {
    const older = ev(WORK, { lastModified: 1, attendees: [
      { name: "Ann (old)", email: "ann@example.com", status: "accepted" }, { name: "Bo", email: "bo@example.com" }, { name: "Walk-in" },
    ] });
    const newer = ev(MAC, { lastModified: 2, attendees: [{ name: "Ann", email: "ANN@example.com", status: "declined" }, { name: "Cy" }] });
    const m = mergeCopies([older, newer]);
    expect(m.attendees).toEqual([
      { name: "Ann", email: "ANN@example.com", status: "declined" }, { name: "Cy" }, { name: "Bo", email: "bo@example.com" },
    ]);
  });

  test("text, time, status and organizer from the most recently modified copy, with provenance kept", () => {
    const g6: CalG6Switches = { eventkit: true, googleLink: true };
    const older = ev(MAC, { lastModified: 100, title: "Planning", location: "Room 4", description: "agenda v1", organizer: { email: "me@example.com" }, organizerVerified: true });
    const newer = ev(WORK, { lastModified: 200, title: "Planning (moved)", description: "agenda v2", organizer: { name: "Guest", email: "guest@example.com" } });
    // Different organizers rule out key b; the shared UID is what makes them one event (key a). (Fix-round 1: the
    // two sources agree on the time — sources that disagree are not merged at all, see "the cross-source rule".)
    expect(reconcileCalendar({ runDate: RUN, g6, copies: [older, newer] })).toHaveLength(2);
    const withUid = reconcileCalendar({ runDate: RUN, g6, copies: [{ ...older, uid: "p1" }, { ...newer, uid: "p1" }] });
    expect(withUid).toHaveLength(1);
    const e = withUid[0]!;
    expect(e.title).toBe("Planning (moved)");
    expect(e.location).toBeUndefined();            // from the latest copy, which has none
    expect(e.description).toBe("agenda v2");
    expect(e.organizer).toEqual({ name: "Guest", email: "guest@example.com" });
    // ORGANIZER PROVENANCE AFTER MERGE: the text came from a copy where you are NOT the verified organizer, so the
    // unlocked variant may not use it — even though the merged event is organizer-verified through the other copy.
    expect(e.organizerVerified).toBe(true);
    expect(e.provenance).toEqual({
      title: { ...WORK, organizerVerified: false },
      description: { ...WORK, organizerVerified: false },
    });
    // And the other way round: the verified copy is the latest, so its fields carry the verified flag.
    const flipped = reconcileCalendar({ runDate: RUN, g6, copies: [{ ...older, uid: "p1", lastModified: 300 }, { ...newer, uid: "p1" }] })[0]!;
    expect(flipped.title).toBe("Planning");
    expect(flipped.provenance).toEqual({
      title: { ...MAC, organizerVerified: true }, location: { ...MAC, organizerVerified: true }, description: { ...MAC, organizerVerified: true },
    });
  });

  test("a producer's own provenance is ignored: it is rebuilt from the copy", () => {
    const forged = ev(WORK, { provenance: { title: { ...MAC, organizerVerified: true } } });
    expect(reconcileCalendar({ runDate: RUN, copies: [forged], g6: { eventkit: true, googleLink: true } })[0]!.provenance)
      .toEqual({ title: { ...WORK, organizerVerified: false } });
  });

  test("selfStatus (decision 19): a decline hides the meeting only from the provably NEWEST revision of its OWN source", () => {
    const accepted = ev(WORK, { uid: "d1", selfStatus: "organizer", lastModified: 500 });
    const declined = ev(MAC, { uid: "d1", selfStatus: "declined", lastModified: 1 });
    // A STALE decline (older than the accept): the meeting stays, with the strongest remaining answer.
    expect(mergeCopies([accepted, declined]).selfStatus).toBe("organizer");
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [accepted, declined] }))).toEqual(["Standup"]);
    // The NEWEST revision declines WITHIN ONE SOURCE: hidden.
    expect(reconcileCalendar({ runDate: RUN, copies: [{ ...accepted, lastModified: 1 }, { ...declined, sources: [WORK], lastModified: 500 }] })).toEqual([]);
    // Final harden r3: ACROSS sources a decline is a hide, which another calendar's copy may never do — the newer
    // decline from the Mac does not hide the link's accepted meeting.
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [{ ...accepted, lastModified: 1 }, { ...declined, lastModified: 500 }] }))).toEqual(["Standup"]);
    // An UNPROVABLE decline (no revisions — through key b, no UIDs): the meeting stays.
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { selfStatus: "accepted" }), ev(MAC, { selfStatus: "declined" })] }).map((e) => e.selfStatus)).toEqual(["accepted"]);
    // A lone decline, or every copy declining: hidden.
    expect(reconcileCalendar({ runDate: RUN, copies: [declined] })).toEqual([]);
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { selfStatus: "declined" }), ev(MAC, { selfStatus: "declined" })] })).toEqual([]);
  });

  test("selfStatus otherwise: the strongest of organizer > accepted > tentative > needs-action > unknown", () => {
    const order: CalSelfStatus[] = ["unknown", "needs-action", "tentative", "accepted", "organizer"];
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        const m = mergeCopies([ev(WORK, { selfStatus: order[i]! }), ev(MAC, { selfStatus: order[j]! })]);
        expect(m.selfStatus).toBe(order[Math.max(i, j)]!);
      }
    }
  });

  test("CANCELLED: a provably newer tombstone hides the event; an older one, a tie or an unknown does not", () => {
    // SAME source (the cross-source rule: only a source's own tombstone cancels its copy — pinned below).
    const live = (lm?: number) => ev(WORK, { uid: "c1", ...(lm !== undefined ? { lastModified: lm } : {}) });
    const dead = (lm?: number, sequence?: number) => ev(WORK, { uid: "c1", status: "cancelled", ...(lm !== undefined ? { lastModified: lm } : {}), ...(sequence !== undefined ? { sequence } : {}) });
    expect(reconcileCalendar({ runDate: RUN, copies: [live(1), dead(2)] })).toEqual([]);
    expect(reconcileCalendar({ runDate: RUN, copies: [live(2), dead(1)] })).toHaveLength(1);
    expect(reconcileCalendar({ runDate: RUN, copies: [live(2), dead(2)] })).toHaveLength(1);       // tie
    expect(reconcileCalendar({ runDate: RUN, copies: [live(), dead(2)] })).toHaveLength(1);        // cannot tell
    expect(reconcileCalendar({ runDate: RUN, copies: [dead(5)] })).toEqual([]);                    // a lone tombstone
    // SEQUENCE beats LAST-MODIFIED when both copies carry one.
    expect(reconcileCalendar({ runDate: RUN, copies: [{ ...live(9), sequence: 1 }, dead(1, 2)] })).toEqual([]);
    expect(reconcileCalendar({ runDate: RUN, copies: [{ ...live(1), sequence: 3 }, dead(9, 2)] })).toHaveLength(1);
  });

  test("the copy ranking is a total order: a mixed-SEQUENCE triple merges the same way in all 6 input orders", () => {
    // M2b checkpoint LOW. "SEQUENCE when both have one, else LAST-MODIFIED" cycles on this triple (a > b > c > a), and
    // `newerThan` itself cycles on it too, so no copy is maximal and the RANKING alone picks the text.
    const a = ev(WORK, { uid: "cyc", title: "A", sequence: 1, lastModified: 10 });
    const b = ev(HOME, { uid: "cyc", title: "B", lastModified: 5 });
    const c = ev(TEAM, { uid: "cyc", title: "C", sequence: 2, lastModified: 1 });
    const perms = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const merged = perms.map((p) => mergeCopies(p, RUN));
    const reconciled = perms.map((p) => reconcileCalendar({ runDate: RUN, copies: p }));
    for (const m of merged) expect(m.title).toBe("A");   // the most recent LAST-MODIFIED, whatever the order
    for (const r of reconciled) expect(r.map((e) => e.title)).toEqual(["A"]);
    for (const m of merged) expect(m.sources.map((x) => x.id).sort()).toEqual(["home", "team", "work"]);
  });

  test("newerThan: SEQUENCE first, then LAST-MODIFIED, else cannot tell", () => {
    expect(newerThan({ sequence: 2 }, { sequence: 1 })).toBe(true);
    expect(newerThan({ sequence: 1, lastModified: 9 }, { sequence: 2, lastModified: 1 })).toBe(false);
    expect(newerThan({ sequence: 2, lastModified: 1 }, { sequence: 2, lastModified: 0 })).toBe(true);
    expect(newerThan({ lastModified: 2 }, {})).toBe(false);
    expect(newerThan({}, {})).toBe(false);
    expect(newerThan({ lastModified: Number.NaN }, { lastModified: 1 })).toBe(false);
  });

  test("when nothing is provable, the merged time is the copy that overlaps TODAY — whatever the input order", () => {
    // M3a checkpoint LOW. Same UID (key a), no SEQUENCE, no LAST-MODIFIED: nothing says which copy is newer. One copy
    // has the meeting today, the other tomorrow. Input order used to decide, and the "tomorrow" copy winning hid a
    // real meeting; the tie now breaks toward the copy that keeps it visible.
    // The today copy is deliberately the one the stable SOURCE order ranks last ("link" < "macos"), so it is the
    // overlap step, and only it, that picks it (seen surviving a mutation when the sources were the other way round).
    const today = ev(MAC, { uid: "t1", title: "Review", time: timed(15, 0, 15, 30) });
    const tomorrow = ev(WORK, { uid: "t1", title: "Review", time: timed(15, 0, 15, 30, 1) });
    for (const copies of [[today, tomorrow], [tomorrow, today]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out.map((e) => [e.title, e.time])).toEqual([["Review", timed(15, 0, 15, 30)]]);
      // Fix-round 1: the two sources disagree about the time, so they are not merged; tomorrow's copy is not today.
      expect(out[0]!.sources.map((x) => x.id)).toEqual(["macos"]);
    }
    // …and the same through mergeCopies directly, given the run date, and within ONE source too.
    expect(mergeCopies([{ ...tomorrow, sources: [MAC] }, today], RUN).time).toEqual(timed(15, 0, 15, 30));
    expect(mergeCopies([tomorrow, today], RUN).time).toEqual(timed(15, 0, 15, 30));
  });

  test("…and between copies that BOTH overlap today, a stable source order (kind, then id) — never input order", () => {
    const fromWork = ev(WORK, { uid: "t2", title: "Sync (work copy)" });
    const fromHome = ev(HOME, { uid: "t2", title: "Sync (home copy)" });
    const fromMac = ev(MAC, { uid: "t2", title: "Sync (mac copy)" });
    // "link" sorts before "macos"; within links, "home" before "work".
    for (const copies of [[fromWork, fromHome, fromMac], [fromMac, fromWork, fromHome], [fromHome, fromMac, fromWork]]) {
      expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["Sync (home copy)"]);
    }
    for (const copies of [[fromWork, fromMac], [fromMac, fromWork]]) {
      expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["Sync (work copy)"]);
    }
    // A provable revision still beats both tie-breaks: the newer copy wins even though it is a later source.
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [{ ...fromHome, lastModified: 1 }, { ...fromMac, lastModified: 2 }] })))
      .toEqual(["Sync (mac copy)"]);
  });
});

// ── moved and cancelled occurrences ──────────────────────────────────────────────────────────────────

describe("moved / cancelled occurrences (spec §5 step 1)", () => {
  const RK_TODAY_10 = String(at(10));
  const RK_TOMORROW_10 = String(at(10, 0, 1));

  test("moved INTO today: the override (newer) wins over a stale copy at the original slot", () => {
    // The same source (a move needs evidence from the copy's own source — the cross-source rule).
    const stale = ev(WORK, { uid: "s1", recurrenceKey: RK_TOMORROW_10, title: "1:1", time: timed(10, 0, 10, 30, 1), lastModified: 1 });
    const override = ev(WORK, { uid: "s1", recurrenceKey: RK_TOMORROW_10, title: "1:1", time: timed(15, 0, 15, 30), lastModified: 2 });
    const out = reconcileCalendar({ runDate: RUN, copies: [stale, override] });
    expect(out).toHaveLength(1);
    expect(out[0]!.time).toEqual(timed(15, 0, 15, 30));
    expect(out[0]!.sources).toEqual([WORK]);
  });

  test("moved OUT of today (within the window): the merged event takes the new time and leaves today", () => {
    const stale = ev(WORK, { uid: "s2", recurrenceKey: RK_TODAY_10, time: timed(10, 0, 10, 30), lastModified: 1 });
    const override = ev(WORK, { uid: "s2", recurrenceKey: RK_TODAY_10, time: timed(15, 0, 15, 30, 1), lastModified: 2 });
    expect(reconcileCalendar({ runDate: RUN, copies: [stale, override] })).toEqual([]);
  });

  test("a cancelled override of today's occurrence (a tombstone) hides the stale copy", () => {
    const stale = ev(WORK, { uid: "s3", recurrenceKey: RK_TODAY_10, time: timed(10, 0, 10, 30), lastModified: 1 });
    const tomb = ev(WORK, { uid: "s3", recurrenceKey: RK_TODAY_10, time: timed(10, 0, 10, 30), status: "cancelled", lastModified: 2 });
    expect(reconcileCalendar({ runDate: RUN, copies: [stale, tomb] })).toEqual([]);
  });

  test("moved FAR out of the window: the link's UID index supersedes the stale in-window copy — only when it proves it", () => {
    const stale = ev(WORK, { uid: "s4", recurrenceKey: RK_TODAY_10, time: timed(10, 0, 10, 30), lastModified: 100, title: "Planning" });
    const idx = (entry: Partial<CalUidIndex["entries"][number]>): CalUidIndex[] =>
      [{ sourceId: "work", entries: [{ uid: "s4", recurrenceId: RK_TODAY_10, startMs: at(10, 0, 7), lastModified: 200, ...entry }] }];
    const run = (indexes: CalUidIndex[], copy: CalEvent = stale) => titles(reconcileCalendar({ runDate: RUN, copies: [copy], indexes }));
    expect(run(idx({}))).toEqual([]);                                             // next week, newer: superseded
    expect(run(idx({ startMs: at(10, 0, -9) }))).toEqual([]);                     // moved far into the past: same
    // Negative controls — each keeps the meeting visible:
    expect(run(idx({ lastModified: 50 }))).toEqual(["Planning"]);                 // older
    expect(run(idx({ lastModified: undefined }))).toEqual(["Planning"]);          // cannot tell
    expect(run(idx({ startMs: null }))).toEqual(["Planning"]);                    // start unreadable
    expect(run(idx({ startMs: at(10, 0, 2) }))).toEqual(["Planning"]);            // still inside today ± 2 (key a's job)
    expect(run(idx({ recurrenceId: RK_TOMORROW_10 }))).toEqual(["Planning"]);     // another occurrence
    expect(run(idx({ recurrenceId: undefined }))).toEqual(["Planning"]);          // the series master
    expect(run(idx({ uid: "other" }))).toEqual(["Planning"]);
    expect(run([])).toEqual(["Planning"]);
    // SEQUENCE decides first: a higher sequence supersedes even with an older LAST-MODIFIED.
    expect(run(idx({ sequence: 3, lastModified: 1 }), { ...stale, sequence: 2 })).toEqual([]);
    // The window's edges: today − 2 days' first instant is inside; one ms before it is outside.
    const linkWin = reconcileWindow(RUN, "link");
    expect(run(idx({ startMs: linkWin.startMs }))).toEqual(["Planning"]);
    expect(run(idx({ startMs: linkWin.startMs - 1 }))).toEqual([]);
    expect(run(idx({ startMs: linkWin.endMs }))).toEqual([]);
    expect(run(idx({ startMs: linkWin.endMs - 1 }))).toEqual(["Planning"]);
  });

  test("final harden r3: a huge duplicate-UID index is folded per (UID, recurrence id, source) — linear, same verdicts", () => {
    // 300,000 entries for ONE uid: the parent used to walk every entry for every copy of that uid (37.8 s measured).
    const N = 300_000;
    const entries: CalUidIndex["entries"][number][] = Array.from({ length: N }, (_, i) => ({ uid: "dup", startMs: at(10, 0, 0), sequence: i % 7 }));
    const copies = Array.from({ length: 5_000 }, (_, i) => ev(WORK, { uid: "dup", title: `Dup ${i}`, time: timed(10, 0, 10, 30), sequence: 100 }));
    const t0 = performance.now();
    const out = reconcileCalendar({ runDate: RUN, copies, indexes: [{ sourceId: "work", entries }] });
    const took = performance.now() - t0;
    expect(out.length).toBeGreaterThan(0);
    expect(took).toBeLessThan(3_000);   // the unfolded walk: 5,000 copies × 300,000 entries — measured 11.6 s here, 37.8 s on the reviewer's machine
    // The fold keeps the NEWEST revision: a newer far-moved entry anywhere in the crowd still supersedes…
    const stale = ev(WORK, { uid: "dup", title: "Stale", time: timed(10, 0, 10, 30), sequence: 3 });
    const farNewest = [...entries.slice(0, 1000), { uid: "dup", startMs: at(10, 0, 30), sequence: 50 }, ...entries.slice(0, 1000)];
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [stale], indexes: [{ sourceId: "work", entries: farNewest }] }))).toEqual([]);
    // …and a newest revision that is still in the window keeps it visible, whatever older far entries say.
    const inWindowNewest = [{ uid: "dup", startMs: at(10, 0, 30), sequence: 8 }, { uid: "dup", startMs: at(10, 0, 0), sequence: 9 }];
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [stale], indexes: [{ sourceId: "work", entries: inWindowNewest }] }))).toEqual(["Stale"]);
    // A series master folded with a same-key single entry carries `recurs`: it never supersedes.
    const withMaster = [{ uid: "dup", startMs: at(10, 0, 30), sequence: 9 }, { uid: "dup", startMs: at(10, 0, -400), sequence: 1, recurs: true as const }];
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [stale], indexes: [{ sourceId: "work", entries: withMaster }] }))).toEqual(["Stale"]);
    // The fold is per source: another link's entries never fold into (or supersede for) this one.
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [stale], indexes: [{ sourceId: "home", entries: farNewest }] }))).toEqual(["Stale"]);
  }, 30_000);

  test("collapseIndexEntry: newest revision, recurs OR-ed, a disputed start at one revision is null; order-independent", () => {
    const a = { uid: "u", startMs: 1, sequence: 2 }, b = { uid: "u", startMs: 2, sequence: 5 }, c = { uid: "u", startMs: 3, sequence: 5 };
    expect(collapseIndexEntry(a, b)).toEqual(b);
    expect(collapseIndexEntry(b, a)).toEqual(b);
    expect(collapseIndexEntry(b, c)).toEqual({ uid: "u", startMs: null, sequence: 5 });
    expect(collapseIndexEntry(c, b)).toEqual({ uid: "u", startMs: null, sequence: 5 });
    expect(collapseIndexEntry(b, { ...a, recurs: true })).toEqual({ ...b, recurs: true });
  });

  test("a single (non-recurring) event moved far away supersedes its stale copy elsewhere", () => {
    const stale = ev(HOME, { uid: "s5", title: "Dentist", lastModified: 1 });
    const indexes: CalUidIndex[] = [{ sourceId: "home", entries: [{ uid: "s5", startMs: at(9, 0, 30), lastModified: 2 }] }];
    expect(reconcileCalendar({ runDate: RUN, copies: [stale], indexes })).toEqual([]);
  });

  test("⚠ a recurring series' MASTER entry (`recurs`) never supersedes — not even a copy of that series with no recurrenceKey", () => {
    // M3a checkpoint MEDIUM, the reviewer's probe: the master's entry has the series' UID, no RECURRENCE-ID, a start at
    // the series' FIRST DTSTART (years outside the window) and a LAST-MODIFIED bumped by any edit to the series. A copy
    // of today's occurrence that arrives without a recurrenceKey shares that key, and was hidden: `[]` for a real
    // meeting today.
    const todays = ev(WORK, { uid: "weekly-1", title: "Weekly 1:1", time: timed(14, 0, 14, 30), lastModified: 100 });
    const master = { uid: "weekly-1", startMs: new Date(2023, 0, 2, 14, 0).getTime(), lastModified: 500 };
    const run = (entry: CalUidIndex["entries"][number]) => titles(reconcileCalendar({ runDate: RUN, copies: [todays], indexes: [{ sourceId: "work", entries: [entry] }] }));
    expect(run({ ...master, recurs: true })).toEqual(["Weekly 1:1"]);
    // The same entry WITHOUT the flag is indistinguishable from a single event moved far away — which does supersede
    // (the test above). So the flag, set by M2c's text pass from RRULE:/RDATE:, is exactly what tells them apart.
    expect(run(master)).toEqual([]);
    // And with a SEQUENCE that would otherwise prove it newer: still never.
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [{ ...todays, sequence: 1 }], indexes: [{ sourceId: "work", entries: [{ ...master, sequence: 9, recurs: true }] }] })))
      .toEqual(["Weekly 1:1"]);
  });
});

// ── the cross-source rule (decision 19, 2026-10-09) ─────────────────────────────────────────────────────

describe("the cross-source rule: another source may merge, never cancel, move or supersede", () => {
  const RK = String(at(10));
  const real = ev(WORK, { uid: "m1", recurrenceKey: RK, title: "Work meeting", time: timed(10, 0, 11, 0), sequence: 1, lastModified: 10,
    attendees: [{ name: "Ann", email: "ann@example.com" }] });

  test("1. a second source carrying the UID with SEQUENCE 99 and a far DTSTART: the real meeting stays", () => {
    const indexes: CalUidIndex[] = [{ sourceId: "home", entries: [{ uid: "m1", recurrenceId: RK, startMs: at(10, 0, 30), sequence: 99, lastModified: 999 }] }];
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [real], indexes }))).toEqual(["Work meeting"]);
    // Control: the SAME entry from the meeting's own link supersedes it.
    expect(reconcileCalendar({ runDate: RUN, copies: [real], indexes: [{ ...indexes[0]!, sourceId: "work" }] })).toEqual([]);
  });

  test("2. the same with STATUS:CANCELLED (a copy in the window): the real meeting stays — and merges", () => {
    const tomb = ev(HOME, { uid: "m1", recurrenceKey: RK, title: "Work meeting", time: timed(10, 0, 11, 0), status: "cancelled", sequence: 99, lastModified: 999,
      attendees: [{ name: "Bo", email: "bo@example.com" }] });
    for (const copies of [[real, tomb], [tomb, real]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(titles(out)).toEqual(["Work meeting"]);
      expect(out[0]!.status).toBe("confirmed");
      expect(out[0]!.sources).toEqual(expect.arrayContaining([WORK, HOME]));                       // merged: sources …
      expect(out[0]!.attendees.map((a) => a.email).sort()).toEqual(["ann@example.com", "bo@example.com"]);   // … and attendees
    }
    // Every source cancelling (each with its own tombstone): gone.
    expect(reconcileCalendar({ runDate: RUN, copies: [{ ...real, status: "cancelled" }, tomb] })).toEqual([]);
  });

  test("3. the same with a moved time: the real copy's time is shown, and an unmergeable duplicate may appear", () => {
    const moved = ev(HOME, { uid: "m1", recurrenceKey: RK, title: "Work meeting", time: timed(16, 0, 17, 0), sequence: 99, lastModified: 999 });
    for (const copies of [[real, moved], [moved, real]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out.map((e) => [e.sources.map((x) => x.id).join("+"), e.time])).toEqual([["work", timed(10, 0, 11, 0)], ["home", timed(16, 0, 17, 0)]]);
    }
    // Moved far (out of today) by the other source: the real copy alone, at its own time.
    const far = { ...moved, time: timed(16, 0, 17, 0, 1) };
    expect(reconcileCalendar({ runDate: RUN, copies: [real, far] }).map((e) => e.time)).toEqual([timed(10, 0, 11, 0)]);
  });

  test("4. same-source cancel and move still work", () => {
    const cancelled = { ...real, status: "cancelled" as const, sequence: 2 };
    expect(reconcileCalendar({ runDate: RUN, copies: [real, cancelled] })).toEqual([]);
    const moved = { ...real, time: timed(16, 0, 17, 0), sequence: 2 };
    expect(reconcileCalendar({ runDate: RUN, copies: [real, moved] }).map((e) => e.time)).toEqual([timed(16, 0, 17, 0)]);
    const movedAway = { ...real, time: timed(16, 0, 17, 0, 1), sequence: 2 };
    expect(reconcileCalendar({ runDate: RUN, copies: [real, movedAway] })).toEqual([]);
  });

  test("5. SEQUENCE 1 declined + SEQUENCE 2 accepted: the meeting stays", () => {
    for (const other of [WORK, HOME]) {
      const out = reconcileCalendar({ runDate: RUN, copies: [{ ...real, selfStatus: "declined" }, ev(other, { ...real, sources: [other], selfStatus: "accepted", sequence: 2 })] });
      expect(out.map((e) => [e.title, e.selfStatus])).toEqual([["Work meeting", "accepted"]]);
    }
  });

  test("6. newest-revision declined: hidden within its own source — never by another source (final harden r3)", () => {
    expect(reconcileCalendar({ runDate: RUN, copies: [{ ...real, selfStatus: "accepted" }, ev(WORK, { ...real, sources: [WORK], selfStatus: "declined", sequence: 2 })] })).toEqual([]);
    // Link A accepted at SEQUENCE 1, link B declined at SEQUENCE 99: B's copy may not hide A's meeting.
    const merged = reconcileCalendar({ runDate: RUN, copies: [{ ...real, selfStatus: "accepted" }, ev(HOME, { ...real, sources: [HOME], selfStatus: "declined", sequence: 99 })] });
    expect(titles(merged)).toEqual(["Work meeting"]);
    expect(merged[0]!.selfStatus).toBe("accepted");
    // Every source's own newest copy declining: hidden.
    expect(reconcileCalendar({ runDate: RUN, copies: [{ ...real, selfStatus: "declined" }, ev(HOME, { ...real, sources: [HOME], selfStatus: "declined", sequence: 99 })] })).toEqual([]);
    // SEQUENCE before LAST-MODIFIED, as newerThan proves: a higher SEQUENCE accept beats a later-modified decline.
    expect(titles(reconcileCalendar({ runDate: RUN, copies: [{ ...real, selfStatus: "declined", sequence: 1, lastModified: 99 }, { ...real, selfStatus: "accepted", sequence: 2, lastModified: 1 }] })))
      .toEqual(["Work meeting"]);
  });
});

// ── gate G6 ──────────────────────────────────────────────────────────────────────────────────────────

describe("organizerVerified behind the per-kind G6 switch", () => {
  const verifiedCopies = (): CalEvent[] => [
    ev(MAC, { title: "Mine on Mac", organizerVerified: true, selfStatus: "organizer", description: "d" }),
    ev(WORK, { title: "Mine on link", organizerVerified: true, selfStatus: "organizer", location: "l", time: timed(11, 0, 12, 0) }),
    ev(HOME, { uid: "g1", title: "Merged", organizerVerified: true, time: timed(13, 0, 14, 0) }),
    ev(MAC_WORK, { uid: "g1", title: "Merged", organizerVerified: true, time: timed(13, 0, 14, 0) }),
    { ...ev(TEAM, { title: "Two-source copy", organizerVerified: true, time: timed(15, 0, 16, 0) }), sources: [TEAM, MAC] },
  ];

  test("SHIPPED OFF: both switches are false, and with them off nothing is ever organizer-verified, whatever the input says", () => {
    expect(CALENDAR_G6_PASSED).toEqual({ eventkit: false, googleLink: false });
    expect(Object.isFrozen(CALENDAR_G6_PASSED)).toBe(true);
    for (const g6 of [undefined, CALENDAR_G6_PASSED, { eventkit: false, googleLink: false }]) {
      const out = reconcileCalendar({ runDate: RUN, copies: verifiedCopies(), ...(g6 ? { g6 } : {}) });
      expect(out.length).toBeGreaterThan(0);
      for (const e of out) {
        expect(e.organizerVerified).toBe(false);
        for (const p of Object.values(e.provenance)) expect(p!.organizerVerified).toBe(false);
      }
    }
  });

  test("test-only override ON: each kind's switch governs only that kind's copies", () => {
    const flags = (g6: CalG6Switches) => Object.fromEntries(reconcileCalendar({ runDate: RUN, copies: verifiedCopies(), g6 }).map((e) => [e.title, e.organizerVerified]));
    expect(flags({ eventkit: true, googleLink: false })).toEqual({ "Mine on Mac": true, "Mine on link": false, Merged: true, "Two-source copy": false });
    expect(flags({ eventkit: false, googleLink: true })).toEqual({ "Mine on Mac": false, "Mine on link": true, Merged: true, "Two-source copy": false });
    expect(flags({ eventkit: true, googleLink: true })).toEqual({ "Mine on Mac": true, "Mine on link": true, Merged: true, "Two-source copy": true });
    // A copy that never claimed the signal stays unverified with every switch on.
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(MAC)], g6: { eventkit: true, googleLink: true } })[0]!.organizerVerified).toBe(false);
  });
});

// ── filter and order ─────────────────────────────────────────────────────────────────────────────────

describe("filter and order (spec §5 steps 4–6)", () => {
  test("`unknown` is NOT accepted (like needs-action); tentative, accepted and organizer are", () => {
    const statuses: CalSelfStatus[] = ["organizer", "accepted", "tentative", "needs-action", "unknown", "declined"];
    expect(statuses.filter((s) => isNotAccepted({ selfStatus: s }))).toEqual(["needs-action", "unknown"]);
    // Not accepted is still listed (only declined is dropped).
    expect(reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { selfStatus: "unknown" })] })).toHaveLength(1);
  });

  test("drops cancelled, declined and not-today; orders all-day first, then by start (an unclear one at its wall time), then end, then title", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [
      ev(WORK, { title: "Lunch", time: timed(12, 0, 13, 0) }),
      ev(WORK, { title: "Vendor", time: { kind: "unclear", startDate: RUN, endDate: RUN, wallStart: "14:00", wallEnd: "15:00", tzid: "Custom/Zone" } }),
      ev(WORK, { title: "Holiday", time: { kind: "allDay", startDate: RUN, endDateExclusive: "2026-10-10" } }),
      ev(WORK, { title: "Overnight", time: { kind: "timed", startMs: at(22, 0, -1), endMs: at(2) } }),
      ev(WORK, { title: "B long", time: timed(9, 0, 11, 0) }),
      ev(WORK, { title: "A short", time: timed(9, 0, 9, 30) }),
      ev(WORK, { title: "C short", time: timed(9, 0, 9, 30) }),
      ev(WORK, { title: "Trip", time: { kind: "allDay", startDate: "2026-10-05", endDateExclusive: "2026-10-12" } }),
      ev(WORK, { title: "Cancelled", status: "cancelled", time: timed(8, 0, 9, 0) }),
      ev(WORK, { title: "Declined", selfStatus: "declined", time: timed(8, 0, 9, 0) }),
      ev(WORK, { title: "Tomorrow", time: timed(9, 0, 10, 0, 1) }),
      ev(WORK, { title: "Yesterday", time: { kind: "allDay", startDate: "2026-10-08", endDateExclusive: RUN } }),
    ] });
    expect(titles(out)).toEqual(["Trip", "Holiday", "Overnight", "A short", "C short", "B long", "Lunch", "Vendor"]);
  });

  test("`g6` is a TEST-ONLY override: no production code passes it (a scan of src/)", async () => {
    // M3a checkpoint LOW, widened at the M3b merge. Two modules take a test-only override of CALENDAR_G6_PASSED —
    // `ReconcileInput.g6` here and `CalendarPromptInput.g6` in prompt.ts — and a production call site passing either
    // would switch organizer verification on without the G6 gate. So, exactly:
    //   • outside those two DEFINITIONS, no module names `g6` in code, builds a switches object (the keys
    //     `eventkit` / `googleLink` appear nowhere else), or calls a function that takes the override positionally
    //     (`formatUnlockedEvent`) or trusts its input's gating (`mergeCopies`) — src/core.ts and src/generator.ts
    //     included, which is where M4 will call the two entry points;
    //   • each definition reads its override exactly once (`const g6 = input.g6 ?? CALENDAR_G6_PASSED;`) and never
    //     calls its own entry point;
    //   • prompt.ts builds no switches and keeps no copy of the kind→switch mapping (it imports `g6PassedFor`), and
    //     its one internal `formatUnlockedEvent` call passes that resolved `g6`.
    const SRC = join(import.meta.dir, "../src");
    const code = (f: string) => readFileSync(join(SRC, f), "utf8").split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*\*.*$/, "")).join("\n");
    const DEFINITIONS = ["calendar/reconcile.ts", "calendar/prompt.ts"];
    const offenders: string[] = [];
    let scanned = 0;
    for await (const f of new Glob("**/*.ts").scan({ cwd: SRC })) {
      if (DEFINITIONS.includes(f) || f.startsWith("calendar/vendor/")) continue;
      scanned++;
      const c = code(f);
      if (/(?<![\w$])g6(?![\w$])/.test(c)) offenders.push(`${f}: names g6`);
      if (/\b(?:eventkit|googleLink)\b/.test(c)) offenders.push(`${f}: builds G6 switches`);
      if (/\bformatUnlockedEvent\s*\(/.test(c)) offenders.push(`${f}: calls formatUnlockedEvent`);
      if (/\bmergeCopies\s*\(/.test(c)) offenders.push(`${f}: calls mergeCopies`);
    }
    expect(offenders).toEqual([]);
    expect(scanned).toBeGreaterThan(50);   // the scan really walked src/ (a broken Glob passes vacuously)

    const own = code("calendar/reconcile.ts");
    expect(own.match(/\binput\s*\.\s*g6\b/g)).toEqual(["input.g6"]);
    expect(own).toContain("const g6 = input.g6 ?? CALENDAR_G6_PASSED;");
    expect(own.match(/\breconcileCalendar\s*\(/g)).toEqual(["reconcileCalendar("]);   // its own declaration only

    const prompt = code("calendar/prompt.ts");
    expect(prompt.match(/\binput\s*\.\s*g6\b/g)).toEqual(["input.g6"]);
    expect(prompt).toContain("const g6 = input.g6 ?? CALENDAR_G6_PASSED;");
    expect(prompt.match(/\bbuildCalendarPromptBlocks\s*\(/g)).toEqual(["buildCalendarPromptBlocks("]);
    // Its calls of formatUnlockedEvent (the declaration aside): exactly one, passing the resolved switches.
    expect(prompt.match(/(?<!function\s)\bformatUnlockedEvent\s*\([^)]*\)/g)).toEqual(["formatUnlockedEvent(ev, d, input.runDate, g6)"]);
    expect(prompt).not.toMatch(/\b(?:eventkit|googleLink)\b/);
    expect(prompt).toMatch(/import \{[^}]*\bg6PassedFor\b[^}]*\} from "\.\/reconcile"/);
  });

  test("never throws on sparse input: no sources, no attendees array, an empty title, empty everything", () => {
    expect(reconcileCalendar({ runDate: RUN, copies: [] })).toEqual([]);
    const sparse = { ...ev(WORK, { title: "" }), sources: [], attendees: undefined } as unknown as CalEvent;
    const out = reconcileCalendar({ runDate: RUN, copies: [sparse, sparse], g6: { eventkit: true, googleLink: true } });
    expect(out).toHaveLength(2);   // no source ⇒ never a key-b match, never verified
    expect(out[0]!.organizerVerified).toBe(false);
  });
});

// ── key c: near-duplicates across calendars (spec 2026-10-31 §3) ──────────────────────────────────────

describe("key c: title normalisation and rule 3 (T2.1: M21 helper half, S03, S04, S30, P19)", () => {
  test("M21 nearDupTitle: NFKC, case-fold, punctuation and symbols to spaces, whitespace collapsed, trimmed — each step alone", () => {
    expect(nearDupTitle("ｘ")).toBe("x");                 // NFKC (full-width)
    expect(nearDupTitle("ﬁle")).toBe("file");             // NFKC (ligature)
    expect(nearDupTitle("Dentist")).toBe("dentist");      // case-fold
    expect(nearDupTitle("a,b")).toBe("a b");              // punctuation (\p{P})
    expect(nearDupTitle("a_b")).toBe("a b");              // connector punctuation is \p{P}
    expect(nearDupTitle("a+b")).toBe("a b");              // symbol (\p{S})
    expect(nearDupTitle("a🎉b")).toBe("a b");             // symbol (emoji)
    expect(nearDupTitle("a \t\n b")).toBe("a b");         // whitespace collapse
    expect(nearDupTitle(" a ")).toBe("a");                // trim
    expect(nearDupTitle("Ticket: X")).toBe("ticket x");
    expect(nearDupTitle("Reservation – X")).toBe("reservation x");
    expect(nearDupTitle("X (venue)")).toBe("x venue");
    // Case-fold is toLowerCase (plan §1.1): "Straße" and "STRASSE" stay apart, which only fails safe.
    expect(nearDupTitle("STRASSE")).not.toBe(nearDupTitle("Straße"));
    expect(nearDupTitle(undefined as unknown as string)).toBe("");
  });

  test("M21 each normalisation step alone makes two titles related (and equal)", () => {
    for (const [a, b] of [["ｘ", "x"], ["DENTIST", "dentist"], ["Dentist!", "Dentist"], ["Dentist ★", "Dentist"], ["Den  tist", "Den tist"], [" Dentist ", "Dentist"]] as const) {
      expect(`${a}|${b}: ${titlesRelated(a, b, true)} ${titlesRelated(b, a, true)}`).toBe(`${a}|${b}: true true`);
    }
  });

  test("S03 an empty or punctuation-only normalised title never matches, against empty or non-empty, both directions", () => {
    for (const empty of ["", "   ", "!!!", "— · –", "🎉"]) {
      for (const other of ["", "!!!", "X", "Ticket: X"]) {
        for (const shared of [false, true]) {
          expect(`${JSON.stringify(empty)}|${other}|${shared}: ${titlesRelated(empty, other, shared)}`).toBe(`${JSON.stringify(empty)}|${other}|${shared}: false`);
          expect(`${other}|${JSON.stringify(empty)}|${shared}: ${titlesRelated(other, empty, shared)}`).toBe(`${other}|${JSON.stringify(empty)}|${shared}: false`);
        }
      }
    }
  });

  test("S04 containment is whole-token: Art/Party and Standup/Standups are unrelated, both directions", () => {
    for (const [a, b] of [["Art", "Party"], ["Standup", "Standups"], ["Dent", "Dentist"]] as const) {
      expect(titlesRelated(a, b, false)).toBe(false);
      expect(titlesRelated(b, a, false)).toBe(false);
    }
  });

  test("S30 titles that differ without containment are unrelated (no fuzzy matching)", () => {
    expect(titlesRelated("Dinner w/ Sam", "Dinner with Sam", false)).toBe(false);
    expect(titlesRelated("Dinner with Sam", "Dinner w/ Sam", false)).toBe(false);
    // Contiguous tokens only: "a c" is not contained in "a b c".
    expect(titlesRelated("Lunch Sam", "Lunch with Sam", false)).toBe(false);
  });

  test("different calendars: equal, or contiguous whole-token containment (suffix, prefix label, middle); shared calendar: equal only", () => {
    for (const [a, b] of [["X", "Ticket: X"], ["X", "X (venue)"], ["X", "Reservation – X"], ["Team sync", "Weekly team sync call"]] as const) {
      expect(titlesRelated(a, b, false)).toBe(true);
      expect(titlesRelated(b, a, false)).toBe(true);
      expect(titlesRelated(a, b, true)).toBe(false);
      expect(titlesRelated(b, a, true)).toBe(false);
    }
    expect(titlesRelated("Dentist", "Dentist – Sam", true)).toBe(false);
    expect(titlesRelated("X!", "x", true)).toBe(true);
    expect(titlesRelated("X", "X", false)).toBe(true);
    // Two different decorations never contain each other.
    expect(titlesRelated("Ticket: X", "Reservation – X", false)).toBe(false);
  });

  test("P19 key b's normaliseTitle is unchanged for the same inputs: no punctuation or symbol folding", () => {
    expect(normaliseTitle("ｘ")).toBe("x");
    expect(normaliseTitle("Dentist")).toBe("dentist");
    expect(normaliseTitle("a,b")).toBe("a,b");
    expect(normaliseTitle("a+b")).toBe("a+b");
    expect(normaliseTitle("a \t\n b")).toBe("a b");
    expect(normaliseTitle(" a ")).toBe("a");
    expect(normaliseTitle("Ticket: X")).toBe("ticket: x");
    expect(normaliseTitle("Reservation – X")).toBe("reservation – x");
    expect(normaliseTitle("!!!")).toBe("!!!");
    expect(normaliseTitle("Dentist!")).not.toBe(normaliseTitle("Dentist"));
  });
});

// Key-c fixtures (spec §7): distinct UIDs, distinct Mac calendars unless a test says otherwise, producer keys computed by
// `producerKeys` from the raw location and notes (never hand-written hashes), every pair run in both input orders.
const macCal = (calendarId: string): CalSourceRef => ({ kind: "macos", id: "macos", calendarId });
const CAL_A = macCal("cal-a"), CAL_B = macCal("cal-b"), CAL_C = macCal("cal-c"), CAL_D = macCal("cal-d");
let kcN = 0;
/** A key-c view: one copy with its own UID, its raw location/notes as given, and the producer keys of those. */
function kc(source: CalSourceRef, title: string, raw: { location?: string; notes?: string } = {}, over: Partial<CalEvent> = {}): CalEvent {
  return ev(source, {
    uid: `kc-${++kcN}`, title,
    ...(raw.location !== undefined ? { location: raw.location } : {}), ...(raw.notes !== undefined ? { description: raw.notes } : {}),
    ...producerKeys(raw), ...over,
  });
}
/** The reconciled event counts for [a, b] and [b, a]. */
const pairCounts = (a: CalEvent, b: CalEvent): number[] =>
  [reconcileCalendar({ runDate: RUN, copies: [a, b] }).length, reconcileCalendar({ runDate: RUN, copies: [b, a] }).length];
const expectMerged = (a: CalEvent, b: CalEvent): void => expect(pairCounts(a, b)).toEqual([1, 1]);
const expectSeparate = (a: CalEvent, b: CalEvent): void => expect(pairCounts(a, b)).toEqual([2, 2]);
/** A view's key facts from the producer keys of its constituents' raw fields (calendars left empty). */
function factsOf(...raws: { location?: string; notes?: string }[]): KeyCFacts {
  const f = { P: new Set<string>(), L: new Set<string>(), meetingKeys: new Set<string>(), calendars: new Set<string>() };
  for (const raw of raws) {
    const k = producerKeys(raw);
    if (k.placeKey) f.P.add(k.placeKey);
    for (const l of k.linkKeys ?? []) f.L.add(l);
    if (k.meetingKey) f.meetingKeys.add(k.meetingKey);
  }
  return f;
}
/** Every input order, shared by the cluster, merge and invariance checks. */
const permutations = <T,>(xs: readonly T[]): T[][] =>
  xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
/** A view with no UID (the field deleted, not undefined). */
const noUid = (e: CalEvent): CalEvent => { const { uid: _u, ...rest } = e; return rest; };
/** A view's facts include its raw location and description, plus every source calendar. */
const factsFor = (views: readonly CalEvent[]): Map<CalEvent, KeyCFacts> =>
  new Map(views.map((v) => [v, { ...factsOf({ ...(v.location !== undefined ? { location: v.location } : {}), ...(v.description !== undefined ? { notes: v.description } : {}) }), calendars: new Set(v.sources.map((x) => `${x.kind}\u0000${x.id}\u0000${x.calendarId}`)) }]));
const ZOOM_A = "https://us02web.zoom.us/j/81234567890?pwd=a", ZOOM_B = "https://zoom.us/j/81234567890", ZOOM_OTHER = "https://zoom.us/j/81234567891";
const WHEREBY = "https://whereby.com/acme-hr", GOTO = "https://meet.goto.com/111";
const MAP_A = "https://maps.google.com/?q=clinic+a", MAP_B = "https://maps.google.com/?q=clinic+b";

describe("key c: placeFactsVeto, each veto isolated (T2.2)", () => {
  const both = (a: KeyCFacts, b: KeyCFacts): boolean[] => [placeFactsVeto(a, b), placeFactsVeto(b, a)];
  test("S24 a shared keyless link never lifts the place veto: distinct places, same Whereby link → veto stands", () => {
    expect(both(factsOf({ location: `Clinic A ${WHEREBY}` }), factsOf({ location: `Clinic B ${WHEREBY}` }))).toEqual([true, true]);
  });
  test("S12 different single meeting keys, same place → the meeting-key veto stands", () => {
    expect(both(factsOf({ location: `Clinic A ${ZOOM_B}` }), factsOf({ location: `Clinic A ${ZOOM_OTHER}` }))).toEqual([true, true]);
  });
  test("M06 distinct places, one shared single meeting key → (b) lifts the place veto: none stands", () => {
    expect(both(factsOf({ location: `Clinic A, 1 Main St ${ZOOM_B}` }), factsOf({ location: `Clinic B, 9 Oak Ave ${ZOOM_A}` }))).toEqual([false, false]);
  });
  test("meeting-key vetoes: a view with two meeting keys, or two disjoint key sets — (b) never lifts them", () => {
    const two = factsOf({ location: `Clinic A ${ZOOM_B}` }, { location: `Clinic A ${ZOOM_OTHER}` });
    expect(two.meetingKeys.size).toBe(2);
    expect(both(two, factsOf({ location: `Clinic A ${ZOOM_B}` }))).toEqual([true, true]);
    expect(both(factsOf({ notes: ZOOM_B }), factsOf({ notes: ZOOM_OTHER }))).toEqual([true, true]);
  });
  test("cross-kind veto: Office 3B vs a Zoom URL — both F non-empty, nothing shared", () => {
    expect(both(factsOf({ location: "Office 3B" }), factsOf({ location: "https://zoom.us/j/555" }))).toEqual([true, true]);
    // Different link services alone (P empty): the link veto, subsumed by the cross-kind veto.
    expect(both(factsOf({ location: GOTO }), factsOf({ location: WHEREBY }))).toEqual([true, true]);
    expect(both(factsOf({ location: MAP_A }), factsOf({ location: MAP_B }))).toEqual([true, true]);
  });
  test("plain distinct places (Clinic A vs Clinic B, no links, no keys): the place and cross-kind vetoes both fire — S24 isolates the place veto", () => {
    expect(both(factsOf({ location: "Clinic A" }), factsOf({ location: "Clinic B" }))).toEqual([true, true]);
  });
  test("no veto: same place; one side empty; a shared link with no place; a shared place beside disjoint links", () => {
    expect(both(factsOf({ location: "Clinic A" }), factsOf({ location: "Clinic A" }))).toEqual([false, false]);
    expect(both(factsOf({ location: "Clinic A" }), factsOf({}))).toEqual([false, false]);
    expect(both(factsOf({ location: WHEREBY }), factsOf({ location: WHEREBY }))).toEqual([false, false]);
    expect(both(factsOf({ location: `Clinic A ${GOTO}` }), factsOf({ location: `Clinic A ${WHEREBY}` }))).toEqual([false, false]);
  });
});

describe("key c: the pair rules through reconcileCalendar (T2.2)", () => {
  test("S30 unrelated titles at the same clinic, in distinct Mac calendars at the same time → two events", () => {
    expectSeparate(kc(CAL_A, "Dentist", { location: "Clinic North" }), kc(CAL_B, "Board meeting", { location: "Clinic North" }));
  });
  test("M02 identical titles in two Mac calendars, no location on either → one event", () => {
    expectMerged(kc(CAL_A, "Dentist"), kc(CAL_B, "Dentist"));
  });
  test("M04 related titles, no physical place, one Zoom meeting key from host/query variants (linkKeys differ) → one event", () => {
    const a = kc(CAL_A, "X", { location: ZOOM_A }), b = kc(CAL_B, "Ticket: X", { location: ZOOM_B });
    expect(a.linkKeys).not.toEqual(b.linkKeys);
    expect(a.meetingKey).toBe(b.meetingKey!);
    expectMerged(a, b);
  });
  test("M06 disjoint places, one shared Zoom key: (b) lifts the place veto → one event; equal-title variant too", () => {
    expectMerged(kc(CAL_A, "X", { location: `Clinic A, 1 Main St ${ZOOM_B}` }), kc(CAL_B, "Ticket: X", { location: `Clinic B, 9 Oak Ave ${ZOOM_A}` }));
    expectMerged(kc(CAL_A, "X", { location: `Clinic A, 1 Main St ${ZOOM_B}` }), kc(CAL_B, "X", { location: `Clinic B, 9 Oak Ave ${ZOOM_A}` }));
  });
  test("M08 the same map query, equal titles, no physical place → one event (shared L, no veto, equal titles)", () => {
    expectMerged(kc(CAL_A, "Clinic visit", { location: MAP_A }), kc(CAL_B, "Clinic visit", { location: MAP_A }));
  });
  test("M09 equal titles, one place missing → one event", () => {
    expectMerged(kc(CAL_A, "Dentist", { location: "Clinic A" }), kc(CAL_B, "Dentist"));
  });
  test("M10 a shared place beats disjoint links: related titles, same clinic, GoTo vs Whereby → one event", () => {
    expectMerged(kc(CAL_A, "X", { location: `Clinic A ${GOTO}` }), kc(CAL_B, "Ticket: X", { location: `Clinic A ${WHEREBY}` }));
  });
  test("M20 a constituent placeKey matches through key a, though the displayed location differs", () => {
    // The key-a view (one UID in two calendars) shows the newer copy's "Clinic North"; its older copy was at "Clinic South".
    const newer = kc(CAL_A, "X", { location: "Clinic North" }, { uid: "m20", lastModified: 2 });
    const older = kc(CAL_B, "X", { location: "Clinic South" }, { uid: "m20", lastModified: 1 });
    const other = kc(CAL_C, "Ticket: X", { location: "Clinic South" });
    for (const copies of [[newer, older, other], [other, older, newer]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.sources).toEqual(expect.arrayContaining([CAL_A, CAL_B, CAL_C]));
    }
  });
  test("M20 a constituent placeKey and meeting key survive key b", () => {
    // Key b merges a link copy (shown: "Clinic South", the stable source order's base) with a Mac copy at "Clinic North".
    const link = kc(WORK, "X", { location: "Clinic South" }), mac = kc(CAL_A, "X", { location: "Clinic North" });
    const viaPlace = kc(CAL_B, "Ticket: X", { location: "Clinic North" });
    expect(reconcileCalendar({ runDate: RUN, copies: [link, mac] })[0]!.location).toBe("Clinic South");
    expect(reconcileCalendar({ runDate: RUN, copies: [link, mac, viaPlace] })).toHaveLength(1);
    expect(reconcileCalendar({ runDate: RUN, copies: [viaPlace, mac, link] })).toHaveLength(1);
    // The meeting key held by the non-base constituent alone, against a view with no physical place.
    const linkK = kc(WORK, "Y"), macK = kc(CAL_A, "Y", { notes: ZOOM_B }), viaKey = kc(CAL_B, "Ticket: Y", { location: ZOOM_A });
    expect(reconcileCalendar({ runDate: RUN, copies: [linkK, macK, viaKey] })).toHaveLength(1);
    expect(reconcileCalendar({ runDate: RUN, copies: [viaKey, macK, linkK] })).toHaveLength(1);
  });
  test("M20 a constituent linkKey survives key a: the shown Office 3B view's older copy carried the Whereby link", () => {
    // The key-a view shows the newer copy's "Office 3B"; its older copy's location was the Whereby room. Against a
    // Whereby-only view with an equal title, the shared linkKey keeps the cross-kind veto from firing.
    const newer = kc(CAL_A, "Standup", { location: "Office 3B" }, { uid: "m20c", lastModified: 2 });
    const older = kc(CAL_B, "Standup", { location: WHEREBY }, { uid: "m20c", lastModified: 1 });
    const other = kc(CAL_C, "Standup", { location: WHEREBY });
    expect(older.linkKeys).toEqual(other.linkKeys!);
    expect(other.meetingKey).toBeUndefined();
    expect(other.placeKey).toBeUndefined();
    for (const copies of [[newer, older, other], [other, older, newer]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.sources).toEqual(expect.arrayContaining([CAL_A, CAL_B, CAL_C]));
    }
    // Control: without the older copy's link, Office 3B against the Whereby room is the cross-kind veto → two events.
    const olderNoLink = kc(CAL_B, "Standup", { location: "Office 3B" }, { uid: "m20c", lastModified: 1 });
    expect(reconcileCalendar({ runDate: RUN, copies: [newer, olderNoLink, other] })).toHaveLength(2);
    expect(reconcileCalendar({ runDate: RUN, copies: [other, olderNoLink, newer] })).toHaveLength(2);
  });
  test("M20 non-empty disjoint placeKey sets fail without a shared meeting key, whatever the constituents", () => {
    const newer = kc(CAL_A, "X", { location: "Clinic North" }, { uid: "m20b", lastModified: 2 });
    const older = kc(CAL_B, "X", { location: "Clinic South" }, { uid: "m20b", lastModified: 1 });
    expect(reconcileCalendar({ runDate: RUN, copies: [newer, older, kc(CAL_C, "X", { location: "Clinic East" })] })).toHaveLength(2);
  });
  test("S01 \"Interview\" (a Zoom room) vs \"Interview prep\" (no location) → two events", () => {
    expectSeparate(kc(CAL_A, "Interview", { location: "https://zoom.us/my/sam.lee" }), kc(CAL_B, "Interview prep"));
  });
  test("S02 key-c half: the same title at two places in two Mac calendars, no keys → two events", () => {
    expectSeparate(kc(CAL_A, "Dentist", { location: "Clinic A" }), kc(CAL_B, "Dentist", { location: "Clinic B" }));
  });
  test("S05 a one-minute difference in start or in end → two events", () => {
    expectSeparate(kc(CAL_A, "Dentist"), kc(CAL_B, "Dentist", {}, { time: timed(9, 1, 9, 30) }));
    expectSeparate(kc(CAL_A, "Dentist"), kc(CAL_B, "Dentist", {}, { time: timed(9, 0, 9, 31) }));
  });
  test("S10 one calendar, related unequal titles at the same clinic (Dentist / Dentist – Sam) → two events", () => {
    expectSeparate(kc(CAL_A, "Dentist", { location: "Clinic A" }), kc(CAL_A, "Dentist – Sam", { location: "Clinic A" }));
  });
  test("S11 conflicting organizers → two events", () => {
    expectSeparate(kc(CAL_A, "Dentist", {}, { organizer: { email: "a@example.com" } }), kc(CAL_B, "Dentist", {}, { organizer: { email: "b@example.com" } }));
  });
  test("S12 related titles, different meeting keys, the same place → two events", () => {
    expectSeparate(kc(CAL_A, "X", { location: `Clinic A ${ZOOM_B}` }), kc(CAL_B, "Ticket: X", { location: `Clinic A ${ZOOM_OTHER}` }));
  });
  test("S13 equal titles, a missing location, different meeting keys: the equal-title exception cannot override the veto", () => {
    expectSeparate(kc(CAL_A, "Dentist", { location: "Clinic A", notes: ZOOM_B }), kc(CAL_B, "Dentist", { notes: ZOOM_OTHER }));
  });
  test("S14 URL-only locations with different Zoom IDs → two events (related and equal titles)", () => {
    expectSeparate(kc(CAL_A, "X", { location: ZOOM_B }), kc(CAL_B, "Ticket: X", { location: ZOOM_OTHER }));
    expectSeparate(kc(CAL_A, "X", { location: ZOOM_B }), kc(CAL_B, "X", { location: ZOOM_OTHER }));
  });
  test("S16 a view with two meeting keys never matches key c, even at a matching place; its key-a merge stays", () => {
    const k1 = kc(CAL_A, "X", { location: `Clinic A ${ZOOM_B}` }, { uid: "s16" });
    const k2 = kc(CAL_B, "X", { location: `Clinic A ${ZOOM_OTHER}` }, { uid: "s16" });
    const other = kc(CAL_C, "X", { location: `Clinic A ${ZOOM_B}` });
    for (const copies of [[k1, k2, other], [other, k2, k1]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out.map((e) => e.sources.map((x) => x.calendarId).sort().join("+")).sort()).toEqual(["cal-a+cal-b", "cal-c"]);
    }
  });
  test("S17 unrelated titles with the same meeting key (a personal-room double-booking) → two events", () => {
    expectSeparate(kc(CAL_A, "Interview: Sam", { location: ZOOM_B }), kc(CAL_B, "Budget review", { location: ZOOM_A }));
  });
  test("S19 cross-kind veto: Standup at Office 3B vs Standup at a Zoom URL → two events", () => {
    expectSeparate(kc(CAL_A, "Standup", { location: "Office 3B" }), kc(CAL_B, "Standup", { location: "https://zoom.us/j/555" }));
  });
  test("S20 different map queries, equal titles, URL-only → two events", () => {
    expectSeparate(kc(CAL_A, "Clinic visit", { location: MAP_A }), kc(CAL_B, "Clinic visit", { location: MAP_B }));
  });
  test("S22 the same link alone never enables related unequal titles (X / Ticket: X, one Whereby room) → two events", () => {
    expectSeparate(kc(CAL_A, "X", { location: WHEREBY }), kc(CAL_B, "Ticket: X", { location: WHEREBY }));
  });
  test("S24 a shared link never lifts the place veto: equal titles, Clinic A vs Clinic B, one Whereby link → two events", () => {
    expectSeparate(kc(CAL_A, "X", { location: `Clinic A ${WHEREBY}` }), kc(CAL_B, "X", { location: `Clinic B ${WHEREBY}` }));
  });
  test("S15 Webex: different MTIDs, or no MTID, stay separate; a /meet and /join room merge on site and name, not on another name", () => {
    expectSeparate(kc(CAL_A, "X", { location: "https://acme.webex.com/acme/j.php?MTID=m1" }), kc(CAL_B, "Ticket: X", { location: "https://acme.webex.com/acme/j.php?MTID=m2" }));
    expectSeparate(kc(CAL_A, "X", { location: "https://acme.webex.com/acme/j.php" }), kc(CAL_B, "Ticket: X", { location: "https://acme.webex.com/acme/j.php" }));
    expectMerged(kc(CAL_A, "X", { location: "https://acme.webex.com/meet/sam.lee" }), kc(CAL_B, "Ticket: X", { location: "https://ACME.webex.com/join/Sam.Lee/" }));
    expectSeparate(kc(CAL_A, "X", { location: "https://acme.webex.com/meet/sam.lee" }), kc(CAL_B, "Ticket: X", { location: "https://acme.webex.com/meet/priya" }));
  });
  test("S25 the first field has two different meeting keys: no key, and the other view's key in its notes is never retried", () => {
    expectSeparate(kc(CAL_A, "X", { location: "https://zoom.us/j/111 https://zoom.us/j/222", notes: "https://zoom.us/j/222" }), kc(CAL_B, "Ticket: X", { location: "https://zoom.us/j/222" }));
  });
  test("S25b the several location keys include the other view's key: still two events", () => {
    expectSeparate(kc(CAL_A, "X", { location: "https://meet.google.com/abc-defg-hij https://zoom.us/j/222", notes: "https://zoom.us/j/222" }), kc(CAL_B, "Ticket: X", { location: "https://zoom.us/j/222" }));
  });
  test("S29 the same /j/<digits> on zoom.us and zoomgov.com: different providers → two events", () => {
    expectSeparate(kc(CAL_A, "X", { location: "https://zoom.us/j/1612345678" }), kc(CAL_B, "Ticket: X", { location: "https://zoomgov.com/j/1612345678" }));
  });
});

describe("key c: clusters and the merge (T2.3)", () => {
  const CLINIC = "Clinic North, 12 Main Street";
  /** Reconciled event counts over every input order of `views`. */
  const counts = (views: CalEvent[]): number[] => [...new Set(permutations(views).map((p) => reconcileCalendar({ runDate: RUN, copies: p }).length))];

  test("M01 the observed pair: Ticket: X vs X in two Mac calendars, Street/St and a country form → one event", () => {
    expectMerged(kc(CAL_A, "Ticket: X", { location: "Clinic North, 12 Main Street, Springfield, USA" }), kc(CAL_B, "X", { location: "Clinic North, 12 Main St, Springfield" }));
  });
  test("M03 containment as a suffix (X (venue)) and as a prefix label (Reservation – X), at the same clinic → one event", () => {
    expectMerged(kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "X (venue)", { location: CLINIC }));
    expectMerged(kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "Reservation – X", { location: CLINIC }));
  });
  test("M05 a Meet code in one view's notes and the same code in the other's location → one event", () => {
    expectMerged(kc(CAL_A, "X", { notes: "Join: https://meet.google.com/abc-defg-hij" }), kc(CAL_B, "Ticket: X", { location: "https://meet.google.com/abc-defg-hij" }));
  });
  test("M07 (Mac half) equal titles, the same Whereby link, no physical place → one event", () => {
    expectMerged(kc(CAL_A, "Interview", { location: WHEREBY }), kc(CAL_B, "Interview", { location: WHEREBY }));
  });
  test("M13 a Mac view against a link view, X / Ticket: X at the same clinic: only key c joins them", () => {
    expectMerged(kc(WORK, "X", { location: CLINIC }), kc(CAL_A, "Ticket: X", { location: CLINIC }));
  });
  test("M14 (merge half) three views: X (Gmail) + X (Work) + Ticket: X (Home), same clinic → one event, every input order", () => {
    expect(counts([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "X", { location: CLINIC }), kc(CAL_C, "Ticket: X", { location: CLINIC })])).toEqual([1]);
  });
  test("M15 four equal-title views in four Mac calendars → one event", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [kc(CAL_A, "Offsite"), kc(CAL_B, "Offsite"), kc(CAL_C, "Offsite"), kc(CAL_D, "Offsite")] });
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.map((x) => x.calendarId).sort()).toEqual(["cal-a", "cal-b", "cal-c", "cal-d"]);
  });
  test("M16 (merge half) the same calendar, equal titles (different event IDs) → one event; punctuation/symbol variants too", () => {
    expectMerged(kc(CAL_A, "X", { location: CLINIC }), kc(CAL_A, "X", { location: CLINIC }));
    expectMerged(kc(CAL_A, "X!", { location: CLINIC }), kc(CAL_A, "x ★", { location: CLINIC }));
    // Two copies in one link calendar (the old "within one source" fixture, location-free).
    expectMerged(kc(WORK, "Standup"), kc(WORK, "Standup"));
  });
  test("M17 (merge half) mixed: X (Gmail) twice plus Ticket: X (Home), same clinic → one event", () => {
    expect(counts([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_A, "X", { location: CLINIC }), kc(CAL_C, "Ticket: X", { location: CLINIC })])).toEqual([1]);
  });
  test("M24 identical unclear time keys merge; a different unclear field stays separate", () => {
    const u = (over: Partial<Extract<CalTime, { kind: "unclear" }>> = {}): CalTime =>
      ({ kind: "unclear", startDate: RUN, endDate: RUN, wallStart: "14:00", wallEnd: "15:00", tzid: "Custom/Zone", ...over });
    expectMerged(kc(CAL_A, "Vendor", {}, { time: u() }), kc(CAL_B, "Vendor", {}, { time: u() }));
    for (const diff of [{ tzid: "Other/Zone" }, { wallStart: "14:01" }, { wallEnd: "15:01" }, { endDate: "2026-10-10" }]) {
      expectSeparate(kc(CAL_A, "Vendor", {}, { time: u() }), kc(CAL_B, "Vendor", {}, { time: u(diff) }));
    }
  });
  test("M21 (integration half) each normalisation step alone gives one event at the same clinic, distinct Mac calendars", () => {
    for (const [a, b] of [["Ｄentist", "Dentist"], ["DENTIST", "dentist"], ["Dentist!", "Dentist"], ["Dentist ★", "Dentist"], ["Den  tist", "Den tist"], [" Dentist ", "Dentist"]] as const) {
      expect(`${a}|${b}: ${pairCounts(kc(CAL_A, a, { location: CLINIC }), kc(CAL_B, b, { location: CLINIC }))}`).toBe(`${a}|${b}: 1,1`);
    }
  });
  test("M25 the original location-free AMBIGUOUS fixture (one link, two Mac calendars) → one event", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { title: "Focus", uid: "f1" }), ev(MAC, { title: "Focus", uid: "f2" }), ev(MAC_WORK, { title: "Focus", uid: "f3" })] });
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.map((x) => x.calendarId).sort()).toEqual(["cal-home", "cal-work", "work"]);
  });
  test("M26 the original location-free per-pair uniqueness fixture → one event, the WORK–HOME view with both Mac views", () => {
    const out = reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { title: "Sync" }), ev(HOME, { title: "Sync" }), ev(MAC, { title: "Sync" }), ev(MAC_WORK, { title: "Sync" })] });
    expect(out).toHaveLength(1);
    expect(out[0]!.sources.map((x) => x.calendarId).sort()).toEqual(["cal-home", "cal-work", "home", "work"]);
  });
  test("X18 key c joins what key b's per-source onlyOne refused: a link and two Mac lookalikes at one clinic → one event", () => {
    const views = [kc(WORK, "Sync", { location: CLINIC }), kc(MAC, "Sync", { location: CLINIC }), kc(MAC_WORK, "Sync", { location: CLINIC })];
    expect(counts(views)).toEqual([1]);
  });
  test("S02 key-b half (D2): a link view and a Mac view, equal titles, Clinic A vs Clinic B → ONE event through key b", () => {
    expectMerged(kc(WORK, "Dentist", { location: "Clinic A" }), kc(CAL_A, "Dentist", { location: "Clinic B" }));
  });
  test("S06 Standup + Standup – Sam + Standup – Priya with one shared Zoom key: the cluster is not all-pairs → three events", () => {
    expect(counts([kc(CAL_A, "Standup", { location: ZOOM_B }), kc(CAL_B, "Standup – Sam", { location: ZOOM_A }), kc(CAL_C, "Standup – Priya", { location: ZOOM_B })])).toEqual([3]);
  });
  test("S07 Ticket: X + Reservation – X + X at one clinic: two different decorations → three events", () => {
    expect(counts([kc(CAL_A, "Ticket: X", { location: CLINIC }), kc(CAL_B, "Reservation – X", { location: CLINIC }), kc(CAL_C, "X", { location: CLINIC })])).toEqual([3]);
  });
  test("S08 X (Gmail) + Ticket: X (Home) + X (Home) at one clinic: a shared-calendar pair inside the cluster → three events", () => {
    expect(counts([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "Ticket: X", { location: CLINIC }), kc(CAL_B, "X", { location: CLINIC })])).toEqual([3]);
  });
  test("S09 the A–B–C chain: A–B on the place, B–C only on key K, A–C fails rule 4 → three events", () => {
    const a = kc(CAL_A, "X", { location: "Clinic One" });
    const b = kc(CAL_B, "Ticket: X", { location: "Clinic One https://zoom.us/j/7001" });
    const c = kc(CAL_C, "Ticket: X added", { location: "Clinic Two https://us02web.zoom.us/j/7001?pwd=z" });
    expectMerged(a, b);
    expectMerged(b, c);
    expectSeparate(a, c);
    expect(counts([a, b, c])).toEqual([3]);
  });
  test("S18 (Mac half) different link services, equal titles: GoTo vs Whereby → two events", () => {
    expectSeparate(kc(CAL_A, "Interview", { location: GOTO }), kc(CAL_B, "Interview", { location: WHEREBY }));
  });
  test("S21 mirrors of the shared meeting-key shape with different keys stay separate: Zoom, Teams, zoomgov", () => {
    expectSeparate(kc(CAL_A, "X", { location: ZOOM_A }), kc(CAL_B, "Ticket: X", { location: ZOOM_OTHER }));
    expectSeparate(kc(CAL_A, "X", { location: "https://teams.microsoft.com/l/meetup-join/19%3Ameeting_x%40thread.v2/0" }),
      kc(CAL_B, "Ticket: X", { location: "https://teams.live.com/l/meetup-join/19:meeting_y@thread.v2" }));
    expectSeparate(kc(CAL_A, "X", { location: "https://zoomgov.com/j/1612345678" }), kc(CAL_B, "Ticket: X", { location: "https://agency.zoomgov.com/j/1612345679?pwd=x" }));
  });
  test("S23 (Mac half) the same map link at two clinics: P disjoint and the queries differ → two events", () => {
    expectSeparate(kc(CAL_A, "Dentist", { location: `Clinic A, 1 Main St ${MAP_A}` }), kc(CAL_B, "Dentist", { location: `Clinic B, 9 Oak Ave ${MAP_B}` }));
  });
  test("S31 the key-c bucket is by time alone, capped at 50: 50 nested-title views merge, 51 do not", () => {
    const calendars = Array.from({ length: 51 }, (_, i) => macCal(`cal-${String(i).padStart(2, "0")}`));
    const views = calendars.map((cal, i) => kc(cal, ["X", ...Array.from({ length: i }, () => "x")].join(" "), { location: CLINIC }));
    // Nested titles differ, so no two share key b's title+time bucket; every pair is related by containment.
    expect(new Set(views.map((v) => normaliseTitle(v.title))).size).toBe(51);
    expect(reconcileCalendar({ runDate: RUN, copies: views.slice(0, 50) })).toHaveLength(1);
    expect(reconcileCalendar({ runDate: RUN, copies: views })).toHaveLength(51);
  });
  test("no key-c merge routes through mergeCopies: a newer view in another Mac calendar never hides a live one", () => {
    // Within one Mac source, mergeCopies would let the provably newer cancelled copy decide; key c keeps the live view.
    const live = kc(CAL_A, "X", { location: CLINIC }, { lastModified: 1 });
    const dead = kc(CAL_B, "X", { location: CLINIC }, { lastModified: 9, status: "cancelled" });
    for (const copies of [[live, dead], [dead, live]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.status).toBe("confirmed");
      expect(out[0]!.sources).toEqual([CAL_A, CAL_B]);
    }
  });
});

describe("key c: tiers, core, merge order and the assemble inputs (T2.3: X05, X06, X07, X08, X12, X17)", () => {
  const CLINIC = "Clinic North";
  const OWN: Partial<CalEvent> = { selfStatus: "unknown" };                                          // tier 2
  const INVITE: Partial<CalEvent> = { selfStatus: "needs-action", organizer: { email: "host@example.com" }, attendees: [{ email: "host@example.com" }] };   // tier 3
  const pick = (views: CalEvent[]): CalEvent | undefined => selectNearDupCore(Object.freeze([...views]), RUN, factsFor(views));

  test("factsFor includes meeting keys from description as well as location", () => {
    const view = kc(CAL_A, "X", { notes: ZOOM_B });
    expect(factsFor([view]).get(view)!.meetingKeys).toEqual(factsOf({ notes: ZOOM_B }).meetingKeys);
    expect(factsFor([view]).get(view)!.meetingKeys.size).toBe(1);
  });

  test("X06 tierOf: answered = 1; own entry = 2; unanswered invitation = 3 — from the view's own fields", () => {
    const t = (over: Partial<CalEvent>): number => tierOf(ev(CAL_A, over));
    expect(t({ selfStatus: "accepted" })).toBe(1);
    expect(t({ selfStatus: "tentative" })).toBe(1);
    expect(t({ selfStatus: "accepted", organizer: { email: "h@example.com" }, attendees: [{ email: "h@example.com" }] })).toBe(1);
    expect(t({ selfStatus: "organizer", organizerVerified: true })).toBe(1);
    expect(t({ selfStatus: "organizer", organizerVerified: true, attendees: [{ email: "a@example.com" }] })).toBe(1);
    // An UNVERIFIED organizer (EventKit's forgeable isCurrentUser): tier 2 with no attendees, else tier 3.
    expect(t({ selfStatus: "organizer", organizerVerified: false })).toBe(2);
    expect(t({ selfStatus: "organizer", organizerVerified: false, attendees: [{ email: "a@example.com" }] })).toBe(3);
    expect(t({ selfStatus: "unknown" })).toBe(2);
    expect(t({ selfStatus: "unknown", organizer: { email: "h@example.com" } })).toBe(3);
    expect(t({ selfStatus: "unknown", organizer: {} })).toBe(3);
    expect(t({ selfStatus: "unknown", attendees: [{ name: "Walk-in" }] })).toBe(3);
    expect(t({ selfStatus: "needs-action" })).toBe(3);
    expect(t({ selfStatus: "declined" })).toBe(3);
  });

  test("X06 through reconcile: a claimed organizer counts as tier 1 only once G6 verifies it (never while G6 is off)", () => {
    const claimed = kc(CAL_A, "Ticket: X", { location: CLINIC }, { selfStatus: "organizer", organizerVerified: true });
    const own = kc(CAL_B, "X", { location: CLINIC }, OWN);
    for (const copies of [[claimed, own], [own, claimed]]) {
      // G6 off: step 0 clears the flag, so both are tier 2 and the shorter title is the core.
      expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["X"]);
      expect(titles(reconcileCalendar({ runDate: RUN, copies, g6: { eventkit: true, googleLink: false } }))).toEqual(["Ticket: X"]);
    }
  });

  test("X05 coreOrder: tier before title length; scalar length (not UTF-16) before merge order; merge order breaks the rest", () => {
    const answeredLong = ev(CAL_A, { title: "A much longer answered title", selfStatus: "accepted" });
    const ownShort = ev(CAL_B, { title: "X", ...OWN });
    let order = coreOrder(RUN, factsFor([answeredLong, ownShort]));
    expect(Math.sign(order(answeredLong, ownShort))).toBe(-1);
    expect(Math.sign(order(ownShort, answeredLong))).toBe(1);
    expect(pick([answeredLong, ownShort])).toBe(answeredLong);
    expect(pick([ownShort, answeredLong])).toBe(answeredLong);

    const astral = ev(CAL_A, { title: "𐐀𐐂", selfStatus: "accepted" }), latin = ev(CAL_B, { title: "abc", selfStatus: "accepted" });
    expect([[...nearDupTitle("𐐀𐐂")].length, [...nearDupTitle("abc")].length]).toEqual([2, 3]);
    expect(["𐐀𐐂".length, "abc".length]).toEqual([4, 3]);
    order = coreOrder(RUN, factsFor([astral, latin]));
    expect(Math.sign(order(astral, latin))).toBe(-1);
    expect(Math.sign(order(latin, astral))).toBe(1);
    expect(pick([astral, latin])).toBe(astral);
    expect(pick([latin, astral])).toBe(astral);

    // Same tier, same scalar length: merge order (here the provably newer revision) decides.
    const older = ev(CAL_A, { title: "Sync", lastModified: 1 }), newer = ev(CAL_B, { title: "sync!", lastModified: 2 });
    order = coreOrder(RUN, factsFor([older, newer]));
    expect(Math.sign(order(newer, older))).toBe(-1);
    expect(Math.sign(order(older, newer))).toBe(1);
    expect(Math.sign(keyCOrder(RUN, factsFor([older, newer]))(newer, older))).toBe(-1);
    expect(pick([older, newer])).toBe(newer);
    expect(pick([newer, older])).toBe(newer);
  });

  test("X05 selectNearDupCore excludes cancelled views, returns the original object, undefined when none remain; inputs untouched", () => {
    const deadAnswered = ev(CAL_A, { title: "X", selfStatus: "accepted", status: "cancelled" });
    const invite = ev(CAL_B, { title: "Ticket: X", ...INVITE });
    expect(pick([deadAnswered, invite])).toBe(invite);
    expect(pick([invite, deadAnswered])).toBe(invite);
    expect(pick([deadAnswered])).toBeUndefined();
    expect(pick([])).toBeUndefined();
  });

  test("X07 D3: a forged tier-3 invite with a shorter title loses to a tier-2 own entry; tier 1 beats tier 2; the 2026-10-31 shape shows \"Ticket: …\"", () => {
    const forged = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "unknown", attendees: [{ email: "forger@example.com" }] });
    const own = kc(CAL_B, "Ticket: X", { location: CLINIC }, OWN);
    for (const copies of [[forged, own], [own, forged]]) expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["Ticket: X"]);
    const answered = kc(CAL_A, "Ticket: X", { location: CLINIC }, { selfStatus: "accepted" }), ownShort = kc(CAL_B, "X", { location: CLINIC }, OWN);
    for (const copies of [[answered, ownShort], [ownShort, answered]]) expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["Ticket: X"]);
    // 2026-10-31: the unanswered Gmail invitation "X" and the Home own entry "Ticket: X" at the same place.
    const gmail = kc(CAL_A, "X", { location: "Clinic North, 12 Main St" }, INVITE);
    const home = kc(CAL_C, "Ticket: X", { location: "Clinic North, 12 Main Street, USA" }, OWN);
    for (const copies of [[gmail, home], [home, gmail]]) expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["Ticket: X"]);
  });

  test("X08 (title/description half) the core supplies title, location and description, each with its provenance", () => {
    const invite = kc(CAL_A, "X", { location: "Clinic North", notes: "invite agenda" }, INVITE);
    const own = kc(CAL_B, "Ticket: X", { location: "Clinic North, ", notes: "own notes" }, OWN);
    for (const copies of [[invite, own], [own, invite]]) {
      const [e] = reconcileCalendar({ runDate: RUN, copies });
      expect([e!.title, e!.location, e!.description]).toEqual(["Ticket: X", "Clinic North, ", "own notes"]);
      expect(e!.provenance).toEqual({
        title: { ...CAL_B, organizerVerified: false }, location: { ...CAL_B, organizerVerified: false }, description: { ...CAL_B, organizerVerified: false },
      });
    }
  });

  test("X12 assemble inputs: sources over every view in merge order, cancelled last; a cancelled view adds nothing else", () => {
    const g6: CalG6Switches = { eventkit: true, googleLink: true };
    // Merge order: dead (newest), b, a. Core: a (tier 2, shortest title). The cancelled view is newest, so only the
    // "cancelled last" rule puts its source at the end; b before a shows the union follows merge order, not core first.
    const a = noUid(kc(CAL_A, "X", { location: CLINIC }, { ...OWN, lastModified: 2 }));
    const b = noUid(kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, lastModified: 3 }));
    const dead = kc(CAL_C, "X", { location: CLINIC }, {
      uid: "dead-uid", status: "cancelled", lastModified: 99, organizer: { email: "dead@example.com" }, organizerVerified: true,
      attendees: [{ email: "dead@example.com" }], recurrenceKey: "dead-rk",
    });
    for (const copies of [[a, b, dead], [dead, b, a], [b, dead, a]]) {
      const [e] = reconcileCalendar({ runDate: RUN, copies, g6 });
      expect(e!.title).toBe("X");
      expect(e!.sources).toEqual([CAL_B, CAL_A, CAL_C]);
      expect(e!.attendees).toEqual([]);
      expect([e!.uid, e!.recurrenceKey, e!.organizer, e!.lastModified, e!.organizerVerified]).toEqual([undefined, undefined, undefined, 3, false]);
      expect(e!.status).toBe("confirmed");
    }
  });

  test("X17 (selector half) the absent-UID tie: equal revisions and text, confirmed vs tentative — the canonical hash picks one core in both orders", () => {
    const confirmed = noUid(ev(CAL_A, { title: "Sync", location: CLINIC }));
    const tentative = noUid(ev(CAL_A, { title: "Sync", location: CLINIC, status: "tentative" }));
    const facts = factsFor([confirmed, tentative]);
    const hc = canonicalViewHash(confirmed, facts.get(confirmed)!), ht = canonicalViewHash(tentative, facts.get(tentative)!);
    expect(hc).not.toBe(ht);
    const want = hc < ht ? confirmed : tentative;
    expect(pick([confirmed, tentative])).toBe(want);
    expect(pick([tentative, confirmed])).toBe(want);
    // A complete tie: either choice is the same output.
    const twin1 = noUid(ev(CAL_A, { title: "Sync", location: CLINIC })), twin2 = noUid(ev(CAL_A, { title: "Sync", location: CLINIC }));
    expect(canonicalViewHash(twin1, factsFor([twin1]).get(twin1)!)).toBe(canonicalViewHash(twin2, factsFor([twin2]).get(twin2)!));
    expect(pick([twin1, twin2])).toEqual(pick([twin2, twin1])!);
  });

  test("keyCOrder compares each view's sorted MINIMUM source, not sources[0]", () => {
    const viewA = ev(macCal("z-cal"), { title: "Sync" });
    viewA.sources = [macCal("z-cal"), macCal("a-cal")];
    const viewB = ev(macCal("m-cal"), { title: "Sync" });
    const order = keyCOrder(RUN, factsFor([viewA, viewB]));
    expect(Math.sign(order(viewA, viewB))).toBe(-1);
    expect(Math.sign(order(viewB, viewA))).toBe(1);
  });

  test("canonicalViewHash: absent differs from present; sources and key sets are sorted, so their order does not matter", () => {
    const base = noUid(ev(CAL_A, { title: "Sync" }));
    const f = factsFor([base]).get(base)!;
    expect(canonicalViewHash({ ...base, description: "" }, f)).not.toBe(canonicalViewHash(base, f));
    expect(canonicalViewHash({ ...base, sources: [CAL_A, CAL_B] }, f)).toBe(canonicalViewHash({ ...base, sources: [CAL_B, CAL_A] }, f));
    const p1 = { ...f, P: new Set(["b", "a"]) }, p2 = { ...f, P: new Set(["a", "b"]) };
    expect(canonicalViewHash(base, p1)).toBe(canonicalViewHash(base, p2));
    expect(canonicalViewHash(base, p1)).not.toBe(canonicalViewHash(base, { ...f, L: new Set(["a", "b"]) }));
    expect(canonicalViewHash(base, f)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("reconcileBeforeFilter returns the completed outputs before step 4, cancelled and declined included; reconcileCalendar filters them", () => {
    const copies = [
      ev(WORK, { title: "Cancelled", status: "cancelled", time: timed(8, 0, 9, 0) }),
      ev(WORK, { title: "Declined", selfStatus: "declined", time: timed(10, 0, 11, 0) }),
      ev(WORK, { title: "Tomorrow", time: timed(9, 0, 10, 0, 1) }),
      ev(WORK, { title: "Kept", time: timed(12, 0, 13, 0) }),
    ];
    expect(titles(reconcileBeforeFilter({ runDate: RUN, copies })).sort()).toEqual(["Cancelled", "Declined", "Kept", "Tomorrow"]);
    expect(titles(reconcileCalendar({ runDate: RUN, copies }))).toEqual(["Kept"]);
    // An all-cancelled key-c cluster passes through unmerged (each view stays), and step 4 then hides each one.
    const d1 = kc(CAL_A, "X", { location: CLINIC }, { status: "cancelled" }), d2 = kc(CAL_B, "X", { location: CLINIC }, { status: "cancelled" });
    expect(reconcileBeforeFilter({ runDate: RUN, copies: [d1, d2] }).map((e) => e.sources)).toEqual([[CAL_A], [CAL_B]]);
    expect(reconcileCalendar({ runDate: RUN, copies: [d1, d2] })).toEqual([]);
  });
});

describe("key c: status, selfStatus, transparency and cancelled views (T3.1: X01, X02, X03, X04, X13, X14, X15)", () => {
  const CLINIC = "Clinic North";
  const OWN: Partial<CalEvent> = { selfStatus: "unknown" };                                          // tier 2
  const INVITE: Partial<CalEvent> = { selfStatus: "needs-action", organizer: { email: "host@example.com" }, attendees: [{ email: "host@example.com" }] };   // tier 3
  /** The key-c result(s) before step 4, for both input orders of a pair (or the given orders). */
  const before = (...copies: CalEvent[]): CalEvent[] => reconcileBeforeFilter({ runDate: RUN, copies });
  const orders = (a: CalEvent, b: CalEvent): CalEvent[][] => [[a, b], [b, a]];

  test("T3.1 a provably newer decline in one calendar never hides an accepted view in another: crossSourceSelfStatus over the views", () => {
    // Within one source, `selfStatusOf` lets a provably newer decline win; across key-c views each view is its own
    // source, so the decline hides the event only when EVERY non-cancelled view declines (spec §2 "Never declines").
    const accepted = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "accepted", sequence: 1, lastModified: 1 });
    const declined = kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "declined", sequence: 5, lastModified: 9 });
    expect(newerThan(declined, accepted)).toBe(true);
    for (const copies of orders(accepted, declined)) {
      const pre = before(...copies);
      expect(pre).toHaveLength(1);
      expect(pre[0]!.selfStatus).toBe("accepted");
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.sources).toEqual(expect.arrayContaining([CAL_A, CAL_B]));
    }
    // The strongest answer among the non-declined views wins, whatever the revisions say.
    const tentative = kc(CAL_C, "X", { location: CLINIC }, { selfStatus: "tentative", sequence: 1 });
    expect(before(declined, tentative, accepted)[0]!.selfStatus).toBe("accepted");
    expect(before(declined, tentative)[0]!.selfStatus).toBe("tentative");
  });

  test("X02 every view cancelled: the cluster passes through unmerged, each view's own fields and sources intact; step 4 hides each", () => {
    const d1 = kc(CAL_A, "X", { location: CLINIC }, { status: "cancelled", selfStatus: "accepted", lastModified: 3, attendees: [{ email: "a@example.com" }] });
    const d2 = kc(CAL_B, "Ticket: X", { location: CLINIC }, { status: "cancelled", ...OWN, transparency: "free" });
    for (const copies of orders(d1, d2)) {
      const pre = before(...copies);
      // Exactly what each view gives alone: no aggregate, no merge mark, no per-view carrier.
      expect(pre).toEqual(copies.map((c) => before(c)[0]!));
      for (const e of pre) { expect(e.nearDuplicate).toBeUndefined(); expect(e.viewDetails).toBeUndefined(); }
      expect(reconcileCalendar({ runDate: RUN, copies })).toEqual([]);
    }
  });

  test("X02 every non-cancelled view declined → hidden, including beside a cancelled view; one decline → stays", () => {
    const decA = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "declined" });
    const decB = kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "declined" });
    const deadAccepted = kc(CAL_C, "X", { location: CLINIC }, { status: "cancelled", selfStatus: "accepted" });
    for (const copies of [[decA, decB], [decB, decA], [decA, decB, deadAccepted], [deadAccepted, decB, decA], [decA, deadAccepted]]) {
      const pre = before(...copies);
      expect(pre).toHaveLength(1);
      expect([pre[0]!.selfStatus, pre[0]!.status]).toEqual(["declined", "confirmed"]);
      expect(reconcileCalendar({ runDate: RUN, copies })).toEqual([]);
    }
    const live = kc(CAL_B, "X", { location: CLINIC }, OWN);
    for (const copies of orders(decA, live)) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.selfStatus).toBe("unknown");
    }
  });

  test("X01 one view cancelled: the event stays, confirmed, with the live view's answer; a cancelled decline hides nothing", () => {
    const live = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "tentative", status: "confirmed" });
    const deadDeclined = kc(CAL_B, "X", { location: CLINIC }, { status: "cancelled", selfStatus: "declined", lastModified: 99, sequence: 9 });
    for (const copies of orders(live, deadDeclined)) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect([out[0]!.status, out[0]!.selfStatus]).toEqual(["confirmed", "tentative"]);
      expect(out[0]!.sources).toEqual([CAL_A, CAL_B]);
    }
  });

  test("X03 transparency: key c free + free → free; free + busy → busy even with a free core", () => {
    const freeCore = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "accepted", transparency: "free" });   // tier 1: the core
    const busyOwn = kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, transparency: "busy" });
    const freeOwn = kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, transparency: "free" });
    for (const copies of orders(freeCore, busyOwn)) {
      const [e] = reconcileCalendar({ runDate: RUN, copies });
      expect([e!.title, e!.transparency]).toEqual(["X", "busy"]);
    }
    for (const copies of orders(freeCore, freeOwn)) expect(reconcileCalendar({ runDate: RUN, copies })[0]!.transparency).toBe("free");
  });

  test("X03 key b keeps its base's transparency, and a within-source later revision still turns busy into free", () => {
    // Key b: the link view is the base by the stable source order, so its transparency stands either way round.
    for (const [linkT, macT] of [["free", "busy"], ["busy", "free"]] as const) {
      const link = ev(WORK, { title: "Sync", uid: "kb-1", transparency: linkT }), mac = ev(MAC, { title: "Sync", uid: "kb-2", transparency: macT });
      for (const copies of orders(link, mac)) {
        const out = reconcileCalendar({ runDate: RUN, copies });
        expect(out).toHaveLength(1);
        expect(out[0]!.sources.map((x) => x.calendarId).sort()).toEqual(["cal-home", "work"]);
        expect(out[0]!.transparency).toBe(linkT);
      }
    }
    // Within one source (key a, one UID): the latest revision decides, so busy can become free.
    const oldBusy = ev(MAC, { title: "Sync", uid: "rev", transparency: "busy", lastModified: 1 });
    const newFree = ev(MAC, { title: "Sync", uid: "rev", transparency: "free", lastModified: 2 });
    for (const copies of orders(oldBusy, newFree)) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.transparency).toBe("free");
    }
  });

  test("X04 busy-wins skips declined views; when every non-cancelled view declines it counts them all (before step 4)", () => {
    const acceptedFree = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "accepted", transparency: "free" });
    const declinedBusy = kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "declined", transparency: "busy" });
    for (const copies of orders(acceptedFree, declinedBusy)) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect([out[0]!.selfStatus, out[0]!.transparency]).toEqual(["accepted", "free"]);
    }
    const decFree = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "declined", transparency: "free" });
    const decBusy = kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "declined", transparency: "busy" });
    const decFree2 = kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "declined", transparency: "free" });
    const deadBusy = kc(CAL_C, "X", { location: CLINIC }, { status: "cancelled", selfStatus: "accepted", transparency: "busy" });
    for (const copies of orders(decFree, decBusy)) {
      const pre = before(...copies);
      expect(pre).toHaveLength(1);
      expect([pre[0]!.selfStatus, pre[0]!.transparency]).toEqual(["declined", "busy"]);
    }
    for (const copies of [[decFree, decFree2], [decFree2, decFree], [decFree, decFree2, deadBusy], [deadBusy, decFree2, decFree]]) {
      const pre = before(...copies);
      expect(pre).toHaveLength(1);
      expect([pre[0]!.selfStatus, pre[0]!.transparency]).toEqual(["declined", "free"]);
    }
  });

  test("X13 status within one tier, both directions: confirmed + tentative → confirmed; tentative + tentative → tentative; cancelled + tentative → tentative", () => {
    // Both tier 1; the tentative view has the shorter title, so it is the core and only the status rule confirms.
    const tentCore = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "accepted", status: "tentative" });
    const confirmed = kc(CAL_B, "Ticket: X", { location: CLINIC }, { selfStatus: "accepted", status: "confirmed" });
    const tentative = kc(CAL_B, "Ticket: X", { location: CLINIC }, { selfStatus: "accepted", status: "tentative" });
    const dead = kc(CAL_B, "Ticket: X", { location: CLINIC }, { selfStatus: "accepted", status: "cancelled" });
    for (const copies of orders(tentCore, confirmed)) expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["X", "confirmed"]]);
    for (const copies of orders(tentCore, tentative)) expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["X", "tentative"]]);
    // A cancelled view is never confirmed, so within one tier it cannot change the answer either way; the case that can
    // tell a cancelled view counting in the status tier apart is across tiers, in X15 (status half).
    for (const copies of orders(tentCore, dead)) expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["X", "tentative"]]);
    // Tier 2 alike: two own entries.
    const ownTent = kc(CAL_A, "X", { location: CLINIC }, { ...OWN, status: "tentative" });
    const ownConf = kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, status: "confirmed" });
    for (const copies of orders(ownTent, ownConf)) expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["X", "confirmed"]]);
  });

  test("X14 status across tiers: a forged confirmed tier-3 invite never confirms a real tentative own entry (tier 2)", () => {
    const forged = kc(CAL_A, "X", { location: CLINIC }, { ...INVITE, status: "confirmed" });
    const own = kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, status: "tentative" });
    for (const copies of orders(forged, own)) expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["Ticket: X", "tentative"]]);
    // And a tentative answered view (tier 1) is not confirmed by a confirmed own entry (tier 2).
    const answeredTent = kc(CAL_A, "Ticket: X", { location: CLINIC }, { selfStatus: "accepted", status: "tentative" });
    const ownConf = kc(CAL_B, "X", { location: CLINIC }, { ...OWN, status: "confirmed" });
    for (const copies of orders(answeredTent, ownConf)) expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["Ticket: X", "tentative"]]);
  });

  test("X15 (busy half) a cancelled view never makes the result busy", () => {
    const liveFree = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "accepted", transparency: "free" });
    const deadBusy = kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "accepted", transparency: "busy", status: "cancelled", lastModified: 9 });
    for (const copies of orders(liveFree, deadBusy)) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.transparency).toBe("free");
    }
  });

  test("X15 (status half) a cancelled view never sets the status, even from a higher tier", () => {
    const deadAnswered = kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "accepted", status: "cancelled", lastModified: 9 });   // tier 1
    const deadOwnSameTier = kc(CAL_C, "X", { location: CLINIC }, { ...OWN, status: "cancelled" });                                  // tier 2
    const ownTent = kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, status: "tentative" });
    for (const copies of [[deadAnswered, ownTent], [ownTent, deadAnswered], [deadAnswered, deadOwnSameTier, ownTent], [ownTent, deadOwnSameTier, deadAnswered]]) {
      expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["Ticket: X", "tentative"]]);
    }
    // The discriminating shape: a live CONFIRMED tier-2 view beside a CANCELLED tier-1 view. The top tier among the
    // live views is 2, so the event is confirmed; taking the top tier over every view would pick tier 1, where the only
    // view is cancelled (never confirmed), and give tentative.
    const ownConf = kc(CAL_B, "Ticket: X", { location: CLINIC }, { ...OWN, status: "confirmed" });
    for (const copies of orders(deadAnswered, ownConf)) {
      expect(before(...copies).map((e) => [e.title, e.status])).toEqual([["Ticket: X", "confirmed"]]);
      expect(reconcileCalendar({ runDate: RUN, copies }).map((e) => e.status)).toEqual(["confirmed"]);
    }
  });
});

describe("key c: organizer, location fallback, provenance and description (T3.2: X08, X09, X10, X11, X15)", () => {
  const OWN: Partial<CalEvent> = { selfStatus: "unknown" };                                          // tier 2
  const INVITE: Partial<CalEvent> = { selfStatus: "needs-action", organizer: { name: "Forger" }, attendees: [{ email: "forger@example.com" }] };   // tier 3
  const prov = (s: CalSourceRef) => ({ ...s, organizerVerified: false });
  const one = (copies: CalEvent[]): CalEvent => {
    const out = reconcileCalendar({ runDate: RUN, copies });
    expect(out).toHaveLength(1);
    return out[0]!;
  };

  test("X09/X08 location fallback: with no core location, the first view by TIER then merge order supplies it, with its provenance", () => {
    // The tier-3 invite is first in merge order (newest), yet the tier-2 own entry supplies the location.
    const core = kc(CAL_A, "X", {}, { selfStatus: "accepted", lastModified: 1 });
    const invite = kc(CAL_B, "X", { location: "Clinic A" }, { ...INVITE, lastModified: 9 });
    const own = kc(CAL_C, "X", { location: "Clinic A, USA" }, { ...OWN, lastModified: 2 });
    expect(own.placeKey).toBe(invite.placeKey!);
    for (const copies of permutations([core, invite, own])) {
      const e = one(copies);
      expect(e.title).toBe("X");
      expect(e.location).toBe("Clinic A, USA");
      expect(e.provenance).toEqual({ title: prov(CAL_A), location: prov(CAL_C) });
      expect(e.description).toBeUndefined();
    }
    // Within one tier, merge order: the newer own entry first.
    const ownNewer = kc(CAL_D, "X", { location: "Clinic A, United States" }, { ...OWN, lastModified: 5 });
    for (const copies of permutations([core, own, ownNewer])) {
      const e = one(copies);
      expect([e.location, e.provenance.location]).toEqual(["Clinic A, United States", prov(CAL_D)]);
    }
  });

  test("X09 a core with its own location keeps it; the fallback never replaces it", () => {
    const core = kc(CAL_A, "X", { location: "Clinic A" }, { selfStatus: "accepted" });
    const own = kc(CAL_B, "X", { location: "Clinic A, USA" }, { ...OWN, lastModified: 9 });
    for (const copies of [[core, own], [own, core]]) expect([one(copies).location, one(copies).provenance.location]).toEqual(["Clinic A", prov(CAL_A)]);
  });

  test("X15 (location half) a cancelled view never supplies the location fallback", () => {
    const core = kc(CAL_A, "X", {}, { selfStatus: "accepted" });
    const dead = kc(CAL_B, "X", { location: "Clinic A" }, { selfStatus: "accepted", status: "cancelled", lastModified: 9 });
    const invite = kc(CAL_C, "X", { location: "Clinic A, USA" }, INVITE);
    for (const copies of permutations([core, dead, invite])) expect([one(copies).location, one(copies).provenance.location]).toEqual(["Clinic A, USA", prov(CAL_C)]);
    for (const copies of [[core, dead], [dead, core]]) {
      const e = one(copies);
      expect(e.location).toBeUndefined();
      expect(e.provenance.location).toBeUndefined();
    }
  });

  test("X10 organizer: the core's; else the first tier-1 view in merge order with one; a tier-3 view never supplies it", () => {
    const boss = { name: "Boss", email: "boss@example.com" };
    // The core (tier 1, shortest title) has no organizer; the tier-3 invite is newer than the tier-1 view that has one.
    // Nested titles (X ⊂ X x ⊂ X x x) keep every pair related.
    const core = kc(CAL_A, "X", { location: "Clinic A" }, { selfStatus: "accepted", lastModified: 1 });
    const answered = kc(CAL_B, "X x", { location: "Clinic A" }, { selfStatus: "accepted", organizer: boss, lastModified: 2 });
    const invite = kc(CAL_C, "X", { location: "Clinic A" }, { ...INVITE, lastModified: 9 });
    for (const copies of permutations([core, answered, invite])) expect(one(copies).organizer).toEqual(boss);
    // Two tier-1 views with organizers: merge order (newer first) decides.
    const answered2 = kc(CAL_D, "X x x", { location: "Clinic A" }, { selfStatus: "tentative", organizer: { name: "Boss" }, lastModified: 5 });
    for (const copies of permutations([core, answered, answered2])) expect(one(copies).organizer).toEqual({ name: "Boss" });
    // The core's own organizer wins over a newer tier-1 one.
    const coreWithOrg = kc(CAL_A, "X", { location: "Clinic A" }, { selfStatus: "accepted", organizer: { name: "Core" }, lastModified: 1 });
    for (const copies of [[coreWithOrg, answered2], [answered2, coreWithOrg]]) expect(one(copies).organizer).toEqual({ name: "Core" });
    // No tier-1 view has one: the tier-3 invite's organizer is never taken (a tier-2 core has none by definition).
    const ownCore = kc(CAL_A, "X", { location: "Clinic A" }, OWN);
    for (const copies of [[ownCore, invite], [invite, ownCore]]) {
      const e = one(copies);
      expect(e.title).toBe("X");
      expect("organizer" in e).toBe(false);
    }
  });

  test("X10 a tier-3 core keeps its own organizer (every view tier 3)", () => {
    const a = kc(CAL_A, "X", { location: "Clinic A" }, { ...INVITE, organizer: { name: "Host A" } });
    const b = kc(CAL_B, "Ticket: X", { location: "Clinic A" }, { ...INVITE, organizer: { name: "Host B" }, lastModified: 9 });
    for (const copies of [[a, b], [b, a]]) expect([one(copies).title, one(copies).organizer]).toEqual(["X", { name: "Host A" }]);
  });

  test("X15 (organizer and core halves) a cancelled view never supplies the organizer and is never the core", () => {
    const core = kc(CAL_A, "Ticket: X", { location: "Clinic A" }, { selfStatus: "accepted" });
    const dead = kc(CAL_B, "X", { location: "Clinic A" }, { selfStatus: "accepted", status: "cancelled", organizer: { name: "Dead" }, lastModified: 9, description: "dead notes" });
    for (const copies of [[core, dead], [dead, core]]) {
      const e = one(copies);
      expect(e.title).toBe("Ticket: X");
      expect("organizer" in e).toBe(false);
      expect(e.description).toBeUndefined();
      expect(e.sources).toEqual([CAL_A, CAL_B]);
    }
  });

  test("X11 description invariant through reconcileCalendar: an answered merge takes the answered core's description; a not-accepted merge sends none to the prompt", () => {
    const answered = kc(CAL_A, "Ticket: X", { location: "Clinic A", notes: "SNTL-ANSWERED agenda" }, { selfStatus: "accepted" });
    const own = kc(CAL_B, "X", { location: "Clinic A", notes: "SNTL-OWN notes" }, OWN);
    const invite = kc(CAL_C, "X", { location: "Clinic A", notes: "SNTL-INVITE agenda" }, { ...INVITE, lastModified: 9 });
    for (const copies of permutations([answered, own, invite])) {
      const e = one(copies);
      expect([e.selfStatus, e.description, e.provenance.description]).toEqual(["accepted", "SNTL-ANSWERED agenda", prov(CAL_A)]);
      expect(formatLockedEvent(e, { description: true, attendees: true, ended: false }, RUN)).toContain("SNTL-ANSWERED agenda");
    }
    // Nobody answered: the own entry is the core, the merged selfStatus is not accepted, and no description is sent.
    for (const copies of [[own, invite], [invite, own]]) {
      const e = one(copies);
      expect([e.selfStatus, e.description]).toEqual(["needs-action", "SNTL-OWN notes"]);
      const line = formatLockedEvent(e, { description: true, attendees: true, ended: false }, RUN);
      expect(line).toContain("invited, not accepted");
      expect(line).not.toContain("SNTL-");
    }
  });

  test("ACCEPTED RISK (spec §3, user decision 2026-11-01): an unverified organizer view (tier 3) beside an unanswered tier-3 invite core sends the invite's description", () => {
    // Pinned so a change is deliberate, NOT because this is desired: spec §3 "Description" and the last "Accepted risks
    // (forged views)" bullet accept it. The unverified `organizer` answer is not tier 1 (G6 is off), and with attendees it
    // is tier 3, so the shorter-titled invite becomes the core; the merged selfStatus is still `organizer`
    // (crossSourceSelfStatus), so the prompt receives the invite's description and an organizer line "Stranger <…> (you)".
    const invite = kc(CAL_A, "X", { location: "Clinic A", notes: "SNTL-INVITE agenda" },
      { selfStatus: "needs-action", organizer: { name: "Stranger", email: "stranger@example.com" }, attendees: [{ email: "stranger@example.com" }] });
    const claimed = kc(CAL_B, "Ticket: X", { location: "Clinic A", notes: "SNTL-CLAIMED notes" },
      { selfStatus: "organizer", organizerVerified: true, attendees: [{ email: "guest@example.com" }] });
    for (const copies of [[invite, claimed], [claimed, invite]]) {
      const e = one(copies);
      expect([tierOf(invite), e.title, e.selfStatus, e.description, e.provenance.description]).toEqual([3, "X", "organizer", "SNTL-INVITE agenda", prov(CAL_A)]);
      const line = formatLockedEvent(e, { description: true, attendees: true, ended: false }, RUN);
      expect(line).toContain("SNTL-INVITE agenda");
      expect(line).toContain("| Stranger <stranger@example.com> (you) |");
      expect(line).not.toContain("SNTL-CLAIMED");
    }
  });
});

describe("key c: the decided mark, nearDuplicate (T3.3: M14, M16, M17, M18, M19, R01, X01, X15)", () => {
  const CLINIC = "Clinic North, 12 Main Street";
  /** The one event's nearDuplicate over every input order (each order must give one event and the same mark). */
  const marks = (views: CalEvent[]): unknown[] => [...new Set(permutations(views).map((p) => {
    const out = reconcileCalendar({ runDate: RUN, copies: p });
    return out.length === 1 ? JSON.stringify(out[0]!.nearDuplicate ?? null) : `${out.length} events`;
  }))].map((s) => (s.endsWith("events") ? s : JSON.parse(s)));

  test("ACCEPTED RISK (spec §3, user decision 2026-11-02): Call and Call with Bob sharing a Zoom personal room → on 2 calendars", () => {
    const location = "https://zoom.us/j/5551234567";
    expect(marks([kc(MAC_WORK, "Call", { location }), kc(MAC, "Call with Bob", { location })]))
      .toEqual([{ mark: "calendars", count: 2 }]);
  });
  test("ACCEPTED RISK (spec §3, user decision 2026-11-02): distinct PINs cleaned from same-calendar Call titles → 2 copies", () => {
    const views = ["Call PIN: 1234", "Call PIN: 5678"].map((title, i) => {
      const event = macEventFrom({
        calendarId: "cal-work", uid: `accepted-risk-pin-${i}`, title, startMs: at(9), endMs: at(9, 30),
      }, new Set<string>());
      if (event === undefined) throw new Error("accepted-risk Mac fixture was rejected");
      return event;
    });
    expect(views.map((e) => e.title)).toEqual(["Call PIN: [redacted]", "Call PIN: [redacted]"]);
    expect(marks(views)).toEqual([{ mark: "copies", count: 2 }]);
  });

  test("M14 X (Gmail) + X (Work) + Ticket: X (Home): three disjoint calendars → on 3 calendars", () => {
    expect(marks([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "X", { location: CLINIC }), kc(CAL_C, "Ticket: X", { location: CLINIC })]))
      .toEqual([{ mark: "calendars", count: 3 }]);
  });
  test("M16 two copies in one calendar → 2 copies; punctuation and symbol variants too; a link calendar alike", () => {
    expect(marks([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_A, "X", { location: CLINIC })])).toEqual([{ mark: "copies", count: 2 }]);
    expect(marks([kc(CAL_A, "X!", { location: CLINIC }), kc(CAL_A, "x ★", { location: CLINIC })])).toEqual([{ mark: "copies", count: 2 }]);
    expect(marks([kc(WORK, "Standup"), kc(WORK, "Standup")])).toEqual([{ mark: "copies", count: 2 }]);
  });
  test("M17 mixed: X (Gmail) twice plus Ticket: X (Home) → 3 copies, not a calendar mark", () => {
    expect(marks([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_A, "X", { location: CLINIC }), kc(CAL_C, "Ticket: X", { location: CLINIC })]))
      .toEqual([{ mark: "copies", count: 3 }]);
  });
  test("M18 a key-a view spanning {A,B} plus a view in {C} → on 3 calendars (the key-a view counts once, its calendars twice)", () => {
    const a = kc(CAL_A, "X", { location: CLINIC }, { uid: "m18" }), b = kc(CAL_B, "X", { location: CLINIC }, { uid: "m18" });
    const c = kc(CAL_C, "Ticket: X", { location: CLINIC });
    expect(marks([a, b, c])).toEqual([{ mark: "calendars", count: 3 }]);
    expect(reconcileCalendar({ runDate: RUN, copies: [a, b, c] })[0]!.sources.map((s) => s.calendarId).sort()).toEqual(["cal-a", "cal-b", "cal-c"]);
  });
  test("M19 key-a views {A,B} + {B,C}, equal titles, one clinic → 2 copies (three calendars cannot decide the mark)", () => {
    const v1 = [kc(CAL_A, "X", { location: CLINIC }, { uid: "m19-1" }), kc(CAL_B, "X", { location: CLINIC }, { uid: "m19-1" })];
    const v2 = [kc(CAL_B, "X", { location: CLINIC }, { uid: "m19-2" }), kc(CAL_C, "X", { location: CLINIC }, { uid: "m19-2" })];
    expect(marks([...v1, ...v2])).toEqual([{ mark: "copies", count: 2 }]);
  });
  test("R01 (engine half) key a and key b merges and lone events carry no nearDuplicate", () => {
    const keyA = reconcileCalendar({ runDate: RUN, copies: [ev(CAL_A, { uid: "r01" }), ev(CAL_B, { uid: "r01" })] });
    expect(keyA).toHaveLength(1);
    expect(keyA[0]!.sources).toHaveLength(2);
    expect("nearDuplicate" in keyA[0]!).toBe(false);
    const keyB = reconcileCalendar({ runDate: RUN, copies: [ev(WORK, { uid: "r01-w" }), ev(MAC, { uid: "r01-m" })] });
    expect(keyB).toHaveLength(1);
    expect(keyB[0]!.sources).toHaveLength(2);
    expect("nearDuplicate" in keyB[0]!).toBe(false);
    expect("nearDuplicate" in reconcileCalendar({ runDate: RUN, copies: [ev(WORK)] })[0]!).toBe(false);
  });
  test("X01/X15 (mark half) cancelled views add neither views nor calendars; fewer than two live views → no mark", () => {
    const live = (cal: CalSourceRef, title = "X") => kc(cal, title, { location: CLINIC });
    const dead = (cal: CalSourceRef) => kc(cal, "X", { location: CLINIC }, { status: "cancelled", lastModified: 9 });
    // One live view + one cancelled: the event stays (it still merges), unmarked.
    for (const copies of permutations([live(CAL_A), dead(CAL_B)])) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out).toHaveLength(1);
      expect(out[0]!.sources).toEqual([CAL_A, CAL_B]);
      expect("nearDuplicate" in out[0]!).toBe(false);
    }
    // Two live in two calendars, plus a cancelled one in a third calendar: on 2 calendars, not 3.
    expect(marks([live(CAL_A), live(CAL_B), dead(CAL_C)])).toEqual([{ mark: "calendars", count: 2 }]);
    // A cancelled copy sharing a live view's calendar does not break disjointness.
    expect(marks([live(CAL_A), live(CAL_B), dead(CAL_B)])).toEqual([{ mark: "calendars", count: 2 }]);
    // Two live copies in one calendar plus a cancelled one elsewhere: 2 copies, not 3.
    expect(marks([live(CAL_A), live(CAL_A), dead(CAL_C)])).toEqual([{ mark: "copies", count: 2 }]);
  });
  test("the mark's count is always at least two: views with no sources fall back to copies (spec §6, integer ≥ 2)", () => {
    // Empty calendar sets are trivially disjoint, but a union of fewer than two calendars cannot give "on N calendars"
    // with N ≥ 2, so the mark falls back to the views counted as copies.
    const bare = (title = "X") => kc(CAL_A, title, { location: CLINIC }, { sources: [] });
    expect(marks([bare(), bare()])).toEqual([{ mark: "copies", count: 2 }]);
    expect(marks([bare(), kc(CAL_A, "X", { location: CLINIC })])).toEqual([{ mark: "copies", count: 2 }]);
    expect(marks([bare(), bare(), kc(CAL_A, "X", { location: CLINIC })])).toEqual([{ mark: "copies", count: 3 }]);
    // Two calendars among three views, the third sourceless: still disjoint with two calendars, so on 2 calendars.
    expect(marks([bare(), kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "X", { location: CLINIC })])).toEqual([{ mark: "calendars", count: 2 }]);
  });

  test("the mark is decided before step 4: an all-declined merge carries it though step 4 hides the event", () => {
    const pre = reconcileBeforeFilter({ runDate: RUN, copies: [kc(CAL_A, "X", { location: CLINIC }, { selfStatus: "declined" }), kc(CAL_B, "X", { location: CLINIC }, { selfStatus: "declined" })] });
    expect(pre.map((e) => e.nearDuplicate)).toEqual([{ mark: "calendars", count: 2 }]);
  });
});

describe("key c is input-order-independent (T3.4: X16 morning pass, X17)", () => {
  const CLINIC = "Clinic North";
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

  /** Every permutation of one-copy-per-view input gives the identical (strictly deep-equal) result, before and after
   *  step 4; returns the filtered result of the first order. */
  function invariant(views: CalEvent[]): CalEvent[] {
    const perms = permutations(views);
    expect(perms.length).toBeLessThanOrEqual(24);
    const first = reconcileCalendar({ runDate: RUN, copies: perms[0]! }), firstPre = reconcileBeforeFilter({ runDate: RUN, copies: perms[0]! });
    for (const p of perms.slice(1)) {
      expect(reconcileCalendar({ runDate: RUN, copies: p })).toStrictEqual(first);
      expect(reconcileBeforeFilter({ runDate: RUN, copies: p })).toStrictEqual(firstPre);
    }
    return first;
  }

  test("X16 M14 shape: three calendars, distinct UIDs, equal (absent) revision data", () => {
    const out = invariant([kc(CAL_A, "X", { location: CLINIC }), kc(CAL_B, "X", { location: CLINIC }), kc(CAL_C, "Ticket: X", { location: CLINIC })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.nearDuplicate).toEqual({ mark: "calendars", count: 3 });
  });

  test("X16 M17 shape with equal revision data: two copies in one calendar plus another calendar → 3 copies", () => {
    const rev = { lastModified: 5, sequence: 2 };
    const out = invariant([kc(CAL_A, "X", { location: CLINIC }, rev), kc(CAL_A, "X", { location: CLINIC }, rev), kc(CAL_C, "Ticket: X", { location: CLINIC }, rev)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.nearDuplicate).toEqual({ mark: "copies", count: 3 });
  });

  test("X16 text-hash tie-break: one calendar, no UIDs, equal revisions and titles, different descriptions", () => {
    // Descriptions chosen so the two hash steps DISAGREE: the text hash (SHA-256 of title\0location\0description) orders
    // "agenda A" first, the canonical hash alone would pick "agenda B" (measured on a copy with the text-hash step
    // removed). Without that, removing the step keeps every permutation agreeing and this test green.
    const views = ["agenda A", "agenda B", "agenda C"].map((notes) => noUid(kc(CAL_A, "X", { location: CLINIC, notes })));
    const out = invariant(views);
    expect(out).toHaveLength(1);
    expect(out[0]!.nearDuplicate).toEqual({ mark: "copies", count: 3 });
    // Pinned winner: the text-hash winner is the core and supplies the description.
    expect(out[0]!.description).toBe("agenda A");
  });

  test("X16 canonical-hash tie-break: one calendar, no UIDs, identical text, differing status, transparency and attendees", () => {
    const views = [
      noUid(kc(CAL_A, "X", { location: CLINIC }, { status: "confirmed" })),
      noUid(kc(CAL_A, "X", { location: CLINIC }, { status: "tentative" })),
      noUid(kc(CAL_A, "X", { location: CLINIC }, { transparency: "free", attendees: [{ email: "b@example.com" }, { email: "a@example.com" }] })),
    ];
    const out = invariant(views);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("confirmed");
    expect(out[0]!.transparency).toBe("busy");
    expect(out[0]!.attendees).toEqual([{ email: "b@example.com" }, { email: "a@example.com" }]);
  });

  test("X16 UIDs present and absent together, one calendar shared", () => {
    const out = invariant([
      kc(CAL_A, "X", { location: CLINIC }, { uid: "u1" }), noUid(kc(CAL_A, "X", { location: CLINIC })),
      noUid(kc(CAL_B, "X", { location: CLINIC })), kc(CAL_C, "Ticket: X", { location: CLINIC }, { uid: "u0" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.nearDuplicate).toEqual({ mark: "copies", count: 4 });
  });

  test("X16 four views, mixed tiers, a cancelled view, the location and organizer fallbacks, a decline: all 24 orders agree", () => {
    const out = invariant([
      kc(CAL_A, "X", {}, { selfStatus: "accepted", transparency: "free" }),
      kc(CAL_B, "X", { location: "Clinic A, USA" }, { selfStatus: "unknown", transparency: "busy" }),
      kc(CAL_C, "X", { location: "Clinic A" }, { selfStatus: "declined", organizer: { name: "Host" }, attendees: [{ email: "h@example.com" }], lastModified: 4 }),
      kc(CAL_D, "X", { location: "Clinic A" }, { selfStatus: "accepted", status: "cancelled", lastModified: 9 }),
    ]);
    expect(out).toHaveLength(1);
    const e = out[0]!;
    expect([e.location, e.provenance.location?.calendarId, e.transparency, e.selfStatus, "organizer" in e]).toEqual(["Clinic A, USA", "cal-b", "busy", "accepted", false]);
    expect(e.sources).toEqual([CAL_C, CAL_A, CAL_B, CAL_D]);
    expect(e.nearDuplicate).toEqual({ mark: "calendars", count: 3 });
  });

  test("X17 absent-UID tie: coreOrder is nonzero by the canonical hash, opposite in reverse, one core object in both orders; status confirmed", () => {
    // Fixed instants, not local wall times: the canonical hash covers `time`, so a zone-dependent startMs would flip
    // which view the pin below expects (M4a checkpoint LOW: it failed under TZ=Australia/Sydney). 09:00Z–13:00Z
    // overlaps the run date in every zone from UTC−12 to UTC+14, so step 4 keeps the event everywhere.
    const time: CalTime = { kind: "timed", startMs: Date.UTC(2026, 9, 9, 9, 0), endMs: Date.UTC(2026, 9, 9, 13, 0) };
    const confirmed = noUid(ev(CAL_A, { title: "Sync", time, location: CLINIC, ...producerKeys({ location: CLINIC }) }));
    const tentative = noUid(ev(CAL_A, { title: "Sync", time, location: CLINIC, ...producerKeys({ location: CLINIC }), status: "tentative" }));
    const facts = factsFor([confirmed, tentative]);
    expect(tierOf(confirmed)).toBe(tierOf(tentative));
    const hc = canonicalViewHash(confirmed, facts.get(confirmed)!), ht = canonicalViewHash(tentative, facts.get(tentative)!);
    const order = coreOrder(RUN, facts);
    const forward = order(confirmed, tentative);
    expect(forward).not.toBe(0);
    expect(Math.sign(forward)).toBe(cmp(hc, ht));
    expect(Math.sign(order(tentative, confirmed))).toBe(-Math.sign(forward));
    const a = selectNearDupCore([confirmed, tentative], RUN, facts), b = selectNearDupCore([tentative, confirmed], RUN, facts);
    expect(a).toBe(b!);
    // Pinned for this fixed fixture: the canonical hash picks the TENTATIVE view as the core.
    expect(a).toBe(tentative);
    expect(hc > ht).toBe(true);
    // The status rule then confirms the merged event in both orders (it alone cannot identify the core).
    for (const copies of [[confirmed, tentative], [tentative, confirmed]]) {
      const out = reconcileCalendar({ runDate: RUN, copies });
      expect(out.map((e) => e.status)).toEqual(["confirmed"]);
    }
  });

  test("X17 a complete tie: either view as the core gives the identical output", () => {
    const twin = (): CalEvent => noUid(ev(CAL_A, { title: "Sync", location: CLINIC, ...producerKeys({ location: CLINIC }) }));
    const t1 = twin(), t2 = twin();
    const facts = factsFor([t1, t2]);
    expect(coreOrder(RUN, facts)(t1, t2)).toBe(0);
    expect(reconcileBeforeFilter({ runDate: RUN, copies: [t1, t2] })).toStrictEqual(reconcileBeforeFilter({ runDate: RUN, copies: [t2, t1] }));
  });

  test("X17 canonicalViewHash changes when any one output-relevant field alone changes", () => {
    const base: CalEvent = {
      sources: [CAL_A, CAL_B], uid: "u", recurrenceKey: "r", time: timed(9, 0, 10, 0), title: "Sync", location: "Clinic North",
      organizer: { name: "Host", email: "h@example.com" }, attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
      selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", description: "notes",
      lastModified: 5, sequence: 2, provenance: { title: { ...CAL_A, organizerVerified: false } },
      details: { url: "https://example.com/a", location: "Clinic North", notes: "notes", people: [{ name: "A", organiser: true }, { name: "B", organiser: false }] },
      meetingKey: "m".repeat(64), placeKey: "p".repeat(64), linkKeys: ["l".repeat(64)],
    };
    const f: KeyCFacts = { P: new Set(["p1"]), L: new Set(["l1"]), meetingKeys: new Set(["k1"]), calendars: new Set(["c"]) };
    const h0 = canonicalViewHash(base, f);
    const changes: [string, Partial<CalEvent>][] = [
      ["time", { time: timed(9, 0, 10, 1) }], ["title", { title: "Sync!" }], ["location", { location: "Clinic South" }],
      ["description", { description: "other" }], ["uid", { uid: "v" }], ["recurrenceKey", { recurrenceKey: "s" }],
      ["sequence", { sequence: 3 }], ["lastModified", { lastModified: 6 }], ["status", { status: "tentative" }],
      ["selfStatus", { selfStatus: "tentative" }], ["transparency", { transparency: "free" }],
      ["organizer", { organizer: { name: "Host", email: "x@example.com" } }],
      ["attendees order", { attendees: [{ email: "b@example.com" }, { email: "a@example.com" }] }],
      ["organizerVerified", { organizerVerified: true }],
      ["provenance", { provenance: { title: { ...CAL_B, organizerVerified: false } } }],
      ["details", { details: { ...base.details!, notes: "other" } }],
      ["details people order", { details: { ...base.details!, people: [...base.details!.people].reverse() } }],
      ["meetingKey", { meetingKey: "n".repeat(64) }], ["placeKey", { placeKey: "q".repeat(64) }], ["linkKeys", { linkKeys: ["k".repeat(64)] }],
      ["sources", { sources: [CAL_A, CAL_C] }],
    ];
    for (const [name, over] of changes) expect(`${name}: ${canonicalViewHash({ ...base, ...over }, f) !== h0}`).toBe(`${name}: true`);
    for (const k of ["uid", "recurrenceKey", "location", "description", "organizer", "lastModified", "sequence", "details", "meetingKey", "placeKey", "linkKeys"] as const) {
      const { [k]: _gone, ...rest } = base;
      expect(`${k} absent: ${canonicalViewHash(rest as CalEvent, f) !== h0}`).toBe(`${k} absent: true`);
    }
    for (const [name, ff] of [["P", { ...f, P: new Set(["p2"]) }], ["L", { ...f, L: new Set(["l2"]) }], ["meetingKeys", { ...f, meetingKeys: new Set(["k2"]) }]] as const) {
      expect(`${name}: ${canonicalViewHash(base, ff) !== h0}`).toBe(`${name}: true`);
    }
  });
});
