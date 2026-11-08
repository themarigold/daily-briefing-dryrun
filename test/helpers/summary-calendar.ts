// test/helpers/summary-calendar.ts — calendar snapshots for the AI summary's job and run tests, built through the real
// pipeline and budget (plan M11, A2 :104); only the source reader is a fixture.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCalendar } from "../../src/calendar/config";
import { createCalendarStep } from "../../src/calendar/pipeline";
import type { CalendarStepResult } from "../../src/calendar/step";
import type { CalEvent } from "../../src/calendar/types";
import type { CapturedCalendar } from "../../src/summary/input";
import { removeAtRunEnd } from "../fixtures/temp-dirs";

export const CALENDAR_RUN = "2026-01-11";
const FIXTURE_NOW = new Date(2026, 0, 11, 8).getTime();
export const MEETING_SENTINELS = ["PRIVATE_MEETING_TITLE", "PRIVATE_ROOM", "PRIVATE_ORGANIZER", "PRIVATE_ATTENDEE", "PRIVATE_NOTES"];
const event = (now: number): CalEvent => ({
  uid: "summary-fixture", sources: [{ kind: "macos", id: "macos", calendarId: "fixture" }],
  time: { kind: "timed", startMs: now + 2 * 3600000, endMs: now + 3 * 3600000 },
  title: MEETING_SENTINELS[0]!, location: MEETING_SENTINELS[1]!, organizer: { name: MEETING_SENTINELS[2]! },
  attendees: [{ name: MEETING_SENTINELS[3]!, email: "fixture@example.com", status: "accepted" }],
  description: MEETING_SENTINELS[4]!, selfStatus: "accepted", organizerVerified: false,
  transparency: "busy", status: "confirmed", provenance: {},
});

type CalendarOptions = { configured?: boolean; events?: boolean; incomplete?: boolean; maxChars?: number };

/** The real step, reading one fixture event two hours after `now`. */
export function calendarStep(options: CalendarOptions = {}, now = FIXTURE_NOW) {
  const configured = options.configured !== false;
  const resolved = resolveCalendar({ enabled: true, ...(configured ? { macos: {} } : {}) }, { platform: "darwin" });
  return createCalendarStep(resolved, {
    stateDir: removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-summary-calendar-"))),
    platform: "darwin", env: {}, now: () => now, maxChars: options.maxChars ?? 200000,
    readMac: async () => ({ status: options.incomplete ? "incomplete" : "ok", events: options.events === false ? [] : [event(now)] }),
    fetch: async () => { throw new Error("A summary fixture must never fetch"); },
  });
}

export async function calendarSnapshot(options: CalendarOptions = {}): Promise<CalendarStepResult> {
  const result = await calendarStep(options)({ runDate: CALENDAR_RUN, startedAt: FIXTURE_NOW, offline: false, force: false, owned: false, trigger: "manual" });
  if (result === undefined) throw new Error("Expected enabled fixture calendar");
  return result;
}

export const capturedCalendar = (r: CalendarStepResult): CapturedCalendar => ({
  unlockedBlock: r.promptBlocks?.unlocked ?? null, hasEvents: r.struct.events.length > 0,
});
