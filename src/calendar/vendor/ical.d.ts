// src/calendar/vendor/ical.d.ts — OURS, not vendored (see README.md beside it): the minimal type surface the
// engine uses from the vendored `ical.js` (2.2.1), so the vendored file itself never has to change. M2b used only
// `parse`; M2c's parser (`../ics.ts`) reads the feed's text itself and drives only the recurrence engine — `Recur`
// and its iterator over floating `Time`s — so this declares exactly that, and nothing more. `../ics.ts` names the
// same surface structurally (`IcalRecurLib`), and the loader (`../parse-job.ts`) hands this module to it, so the
// compiler checks the two agree.

type IcalTimeData = { year: number; month: number; day: number; hour: number; minute: number; second: number; isDate: boolean };

/** `ICAL.Time`: constructed without a zone it is FLOATING (`Timezone.localTimezone`, offset 0 in comparisons). */
declare class IcalTime {
  constructor(data: IcalTimeData);
  year: number; month: number; day: number; hour: number; minute: number; second: number; isDate: boolean;
}

/** `ICAL.Recur`: an RRULE value. `fromString` throws on a malformed rule; `iterator(start)` yields `start` first
 *  (DTSTART is always an instance), then each occurrence in order, then `null`; its constructor throws on an invalid
 *  BY-part combination. The yielded `Time` is the iterator's own, reused by the next call. */
declare class IcalRecur {
  static fromString(rule: string): IcalRecur;
  until: IcalTime | null;
  iterator(start: IcalTime): { next(): IcalTime | null };
}

declare const ICAL: { Recur: typeof IcalRecur; Time: typeof IcalTime };
export default ICAL;
