import { isCalendarHeading } from "../calendar/render-contract";
import { NOTICE_PREFIX } from "../failover";
import { FOOTER_LINE_PREFIX, OUTAGE_LINE_PREFIX, TITLE_MACHINE_CLAUSE, TITLE_PREFIX, WARNING_LINE_PREFIX } from "../render";

/** Only the already-built unlocked projection and an event-presence bit leave the snapshot. */
export interface CapturedCalendar {
  unlockedBlock: string | null;
  hasEvents: boolean;
}

/** The page less what describes this computer and its setup rather than the work (user decision 2026-11-04): the title's
 *  computer name, the provider walk's notices (entry names, the cost line), the outage line (an account's name), the
 *  warnings block (a key file's path, a folder, CLI output) and the closing line (a CLI's path, which can hold the user's
 *  name). Every other byte stays. That includes the commit-coverage
 *  line, whose `⚠` is indented and whose rows are commits. The render builds these lines from fixed prefixes and
 *  strips control characters from each, and every line of model or repository text is indented under a bullet, so a
 *  prefix at the start of a line can only be the renderer's own. */
function workOnly(page: string): string {
  return page.split("\n")
    .filter((line) => ![NOTICE_PREFIX, OUTAGE_LINE_PREFIX, WARNING_LINE_PREFIX, FOOTER_LINE_PREFIX].some((prefix) => line.startsWith(prefix)))
    .map((line) => {
      const clause = line.startsWith(TITLE_PREFIX) ? line.indexOf(TITLE_MACHINE_CLAUSE) : -1;
      return clause === -1 ? line : line.slice(0, clause);
    })
    .join("\n");
}

/** What a request may carry of the saved page, or null when this attempt cannot safely receive it. The saved page itself
 *  never changes, and `pageHashOf` binds the record to that page, not to this text. */
export function summaryInput(page: string, morningLocked: boolean, summaryLocked: true, calendar: CapturedCalendar): string;
export function summaryInput(page: string, morningLocked: boolean, summaryLocked: boolean, calendar: CapturedCalendar): string | null;
export function summaryInput(saved: string, morningLocked: boolean, summaryLocked: boolean, calendar: CapturedCalendar): string | null {
  const page = workOnly(saved);
  if (summaryLocked) return page;
  // A locked morning may have echoed meeting details outside the calendar section.
  if (morningLocked) return null;

  const lines = page.split("\n");
  const heading = lines.findIndex(isCalendarHeading);
  if (heading === -1) return page;
  if (calendar.unlockedBlock === null) return calendar.hasEvents ? null : page;

  let end = heading + 1;
  while (end < lines.length && !lines[end]!.startsWith("▶ ")) end++;
  // Splitting only at LF preserves every other byte, including a CR on the heading.
  const before = lines.slice(0, heading + 1).join("\n");
  const after = end < lines.length ? "\n" + lines.slice(end).join("\n") : "";
  return before + "\n" + calendar.unlockedBlock + after;
}
