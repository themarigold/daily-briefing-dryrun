/**
 * v0.2.1 §3.2 — the morning time AS THE ENGINE READS IT, for the time picker in the wizard and in
 * Settings.
 *
 * ⚠ A MIRROR, NOT A SECOND RULE. `parseFloor` (`src/schedule.ts`) decides which time the engine
 * uses: it trims the value, matches `^(\d{1,2}):(\d{2})$`, accepts hours 0–23 and minutes 0–59, and
 * reads anything else as 07:20 (with a warning). The dropdowns must show THAT time for a stored
 * value, so this file repeats the rule step for step. It cannot import the engine (a webview
 * bundle), so `tests-web/morning-time.check.ts` pins it twice: to the engine source as text (the
 * regex literal and the bounds) and to `parseFloor` itself over a corpus of values.
 *
 * The dropdowns always WRITE `HH:MM` (two digits each). A stored value that is not already in that
 * form is shown the way the engine reads it, with a note ([`storedTimeNote`]); nothing here writes.
 */

/** The engine's default (`DEFAULT_MORNING_TIME`, `src/schedule.ts`): what it uses for an absent or
 *  unreadable value. */
export const DEFAULT_MORNING_TIME = "07:20";

/** `parseFloor`'s pattern, matched against the TRIMMED value. */
export const MORNING_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

export interface MorningTime {
  hour: number;
  minute: number;
  /** `HH:MM`, two digits each: what the dropdowns show, and what a change writes. */
  hhmm: string;
  /** The stored value is one the engine cannot read, so it uses 07:20 (and warns). An absent value
   *  is NOT unparseable: the engine uses 07:20 for it without a warning. */
  unparseable: boolean;
}

const two = (n: number): string => String(n).padStart(2, "0");

/** The 24 hour options, `"00"`–`"23"`. */
export const HOURS: string[] = Array.from({ length: 24 }, (_, i) => two(i));
/** The 60 minute options, `"00"`–`"59"`. */
export const MINUTES: string[] = Array.from({ length: 60 }, (_, i) => two(i));

const [DEFAULT_HOUR, DEFAULT_MINUTE] = DEFAULT_MORNING_TIME.split(":").map(Number) as [number, number];

/** The time the engine uses for `stored` (a config's raw `morningTime`, of any JSON type) — the
 *  `parseFloor` rule, step for step. */
export function parseMorningTime(stored: unknown): MorningTime {
  const fallback: MorningTime = {
    hour: DEFAULT_HOUR,
    minute: DEFAULT_MINUTE,
    hhmm: DEFAULT_MORNING_TIME,
    unparseable: true,
  };
  if (stored === undefined) return { ...fallback, unparseable: false };
  if (typeof stored !== "string") return fallback;
  const m = MORNING_TIME_PATTERN.exec(stored.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m ? Number(m[2]) : NaN;
  if (!m || hh < 0 || hh > 23 || mm < 0 || mm > 59) return fallback;
  return { hour: hh, minute: mm, hhmm: `${two(hh)}:${two(mm)}`, unparseable: false };
}

/** A stored value as text, for a note: a string as it is, anything else as its JSON. Untrusted — a
 *  caller renders the note as text, never as markup. */
const asText = (stored: unknown): string => (typeof stored === "string" ? stored : JSON.stringify(stored));

/** The note for a stored value the engine cannot read — spec §3.2's wording — or `null` when the
 *  engine can read it (or there is none). */
export function unparseableNote(stored: unknown): string | null {
  if (!parseMorningTime(stored).unparseable) return null;
  return `The stored morning time "${asText(stored)}" wasn't understood; the engine uses ${DEFAULT_MORNING_TIME}.`;
}

/** The line under the dropdowns when the stored value is not already `HH:MM` — or `null` when it is,
 *  or when there is none (the engine's default applies, and nothing needs saying). A value the
 *  engine reads leniently (`7:05`, ` 07:05 `) is shown as it reads it; one it cannot read is shown
 *  as 07:20 with [`unparseableNote`]. */
export function storedTimeNote(stored: unknown): string | null {
  if (stored === undefined) return null;
  const time = parseMorningTime(stored);
  if (time.unparseable) return unparseableNote(stored);
  if (stored === time.hhmm) return null;
  return `The stored morning time "${asText(stored)}" is not written as HH:MM; the engine reads it as ${time.hhmm}.`;
}
