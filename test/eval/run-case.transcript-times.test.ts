// T8.6's synthetic turn/edit pair must share one local day at ANY time of day (see `evalTranscriptTimes`,
// src/eval/run-case.ts). Pinned on the pure function with an injected `now` — not on `setSystemTime`,
// which is process-wide (test/postcheck.suggestion-volume-sameday.test.ts:47–62 says why that is costly).
import { test, expect } from "bun:test";
import { evalTranscriptTimes } from "../../src/eval/run-case";

const at = (h: number, m: number): number => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const localDay = (iso: string): string => new Date(iso).toDateString();

test("the T8.6 turn and edit share one local day, in the past and in order, at every minute of the day", () => {
  for (const mbe of [1, 5, 30]) {
    for (let minute = 0; minute < 24 * 60; minute++) {
      const now = at(Math.floor(minute / 60), minute % 60);
      const { editAt, turnAt } = evalTranscriptTimes(now, mbe);
      const where = `now ${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}, minutesBeforeEdit ${mbe}`;
      expect(localDay(turnAt), where).toBe(localDay(editAt));
      expect(Date.parse(turnAt), where).toBe(Date.parse(editAt) - mbe * 60_000);
      expect(Date.parse(editAt), where).toBeLessThan(now);
    }
  }
});

test("away from midnight the pair is where it always was: the edit 10 minutes back", () => {
  const now = at(12, 0);
  expect(evalTranscriptTimes(now, 5)).toEqual({
    editAt: new Date(now - 10 * 60_000).toISOString(), turnAt: new Date(now - 15 * 60_000).toISOString(),
  });
});
