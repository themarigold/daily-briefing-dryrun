/**
 * Run now's result in plain words (wave 2 polish spec §6, "Run now's result in plain words").
 *
 * One sentence for a run that delivered nothing, mapped from the engine's skip reason (`SKIP_REASONS`,
 * `src/json.ts:82-97`) whether it arrives as a skipped or a failed run, from Rust's own codes for a failed run with no
 * engine reason (`malformed-json`, `exit-N`, `signalled`, `gui/src-tauri/src/engine.rs`), and from the `configError`
 * outcome (exit 2). Today (`App.svelte`'s `describe`) and Schedule's skipped phase both call `runResultSentence`;
 * Schedule has no Details control, so `place: "schedule"` leaves every " See Details." out.
 *
 * ⚠ NO IMPORTS AT ALL. An engine test loads this module by path at run time (`test/run-result.format.test.ts`) and CI
 * runs the engine's tests before it installs the GUI's packages, so nothing here may reach a package
 * (`test/engine-imports-no-gui.test.ts`, `RUNTIME_GUI_MODULES`). Keep it that way: no `import`, not even of a type.
 */

/** A finished run that delivered nothing: its outcome kind and the reason it carries (null when it has none). */
export type RunOutcome = { kind: "skipped" | "failed" | "configError"; reason: string | null };

/** The run envelope's `limited` (`src/json.ts:177`, typed at `src/core.ts:744`), the two fields this file reads. */
export type Limited = { until: string; isProbe: boolean };

// ── The engine's reset formatter, copied (the GUI cannot import the engine) ─────────────────────────────────────────
// A line-for-line copy of `src/failover.ts`'s `formatResetTime` with its `WEEKDAYS`, `MONTHS` and `pad2`. ⚠ Change
// the two together: `test/run-result.format.test.ts` checks both give the same string, a DST day included.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A reset for a reader, in LOCAL time: `HH:MM` when it falls on `now`'s local date, `Ddd HH:MM` on any other day
 *  within 5 days, and `Ddd D Mon HH:MM` six or more calendar days away. An unreadable instant reads "its reset". */
export function formatResetTime(instant: string | Date, now: Date): string {
  const t = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(t.getTime())) return "its reset";
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  // Calendar days between the two LOCAL dates (rounded: a DST day is 23 or 25 hours long).
  const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400e3);
  if (days === 0) return hm;
  return Math.abs(days) >= 6 ? `${WEEKDAYS[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()]} ${hm}` : `${WEEKDAYS[t.getDay()]} ${hm}`;
}

// ── The sentences ───────────────────────────────────────────────────────────────────────────────────────────────────

const SEE_DETAILS = " See Details.";

/**
 * The line Today draws for the last Run now. It is about the briefing that was there when the run finished, so a newer one
 * (a scheduled run, or one from the terminal) takes it away for good. A delivered run's new page is the one its line means, so
 * the line takes its date from the run's own refresh, or from the first good read after it when that one said nothing. For a
 * run that didn't deliver, that later read could already be a newer page, and the line then stays until the next: accepted,
 * since it needs every read to fail until a delivery. `mtime` is `undefined` when the status can't be read, which says nothing
 * either way. `null` is no page read, which can be a stat that failed, so it never takes the line.
 */
export interface RunLine {
  /** Which Run now this is, so an earlier run's refresh, still outstanding, can't touch a later run's line. */
  run: number;
  text: string;
  about: string | null | undefined;
  /** This run's own refresh has finished. */
  settled: boolean;
}

export const NO_RUN_LINE: RunLine = { run: 0, text: "", about: undefined, settled: false };

export function runLineStarted(line: RunLine): RunLine {
  return { run: line.run + 1, text: "", about: undefined, settled: false };
}

/** A status read arrived. */
export function runLineSeen(line: RunLine, mtime: string | null | undefined): RunLine {
  if (!line.settled || mtime === undefined) return line;
  if (line.about === undefined) return { ...line, about: mtime };
  // `toISOString` times (`src/json.ts`), so they compare as strings. A slower read of an older page can land after a newer one.
  const newer = mtime !== null && (line.about === null || mtime > line.about);
  return newer ? { ...line, text: "" } : line;
}

/** Run `run`'s own refresh finished: `read` is whether a snapshot came back, and `mtime` is what it says. */
export function runLineSettled(line: RunLine, run: number, read: boolean, mtime: string | null | undefined): RunLine {
  if (line.run !== run) return line;
  const settled = { ...line, settled: true };
  return read ? runLineSeen(settled, mtime) : settled;
}

const SETTINGS_PROBLEM = `Your settings file has a problem, so nothing ran.${SEE_DETAILS}`;

/** The sentence for each engine reason, on Today. `limited` is built below (it may name a time). A Map, so a reason
 *  that happens to be an object-prototype name (`toString`) is not found. */
const REASON_SENTENCES: ReadonlyMap<string, string> = new Map([
  ["already-ran", "Run now makes one briefing a day, and today's is already made."],
  ["no-config", "Daily Briefing isn't set up yet. Open Setup to finish."],
  ["config-error", SETTINGS_PROBLEM],
  ["below-floor", "It's before your morning time, so the scheduled check waited."],
  ["concurrent", "A briefing is already being made. It will show here when it's done."],
  ["offline", "You were offline, so nothing ran. Try again once you're connected."],
  ["darkwake", "The Mac was only partly awake, so the briefing waited for the next check."],
  ["blocked", `A repository couldn't be read, so nothing ran.${SEE_DETAILS}`],
  ["provider-fail", `The AI provider didn't answer.${SEE_DETAILS}`],
  ["parse-empty", `The AI's answer had nothing usable in it.${SEE_DETAILS}`],
  // Schedule's own sentence, as it was written there before this mapping existed.
  ["marker-fail", "Today's briefing was written, but the engine could not record that it was — so a later check today may generate it again."],
  ["write-fail", `The briefing couldn't be saved. The next check will try again.${SEE_DETAILS}`],
  ["crashed", `Something went wrong and the run stopped.${SEE_DETAILS}`],
]);

/** Rust's reasons for a failed run that carried no engine reason (`engine.rs`: zero exit with no JSON, another exit
 *  code, a signal). The exit code is an i32 (`format!("exit-{other}")`), so a Windows crash reads `exit--1073741819`. */
const RUST_CODE = /^(?:malformed-json|exit--?\d+|signalled)$/;

/** Schedule's `concurrent`: by the time Schedule shows it, the other run has ended. */
const SCHEDULE_CONCURRENT = "A briefing was already being made.";

/** `limited` adds " until {time}" only when the envelope carries a non-empty `until` and `isProbe` is false — the rule
 *  of the engine's `outOfUsageLine` (`src/failover.ts`). No time otherwise: the app never invents one. */
function limitedSentence(limited: Limited | null, now: Date): string {
  const when = limited !== null && limited.until && !limited.isProbe ? ` until ${formatResetTime(limited.until, now)}` : "";
  return `Every AI account you set up is at its usage limit${when}.`;
}

function todaySentence(outcome: RunOutcome, limited: Limited | null, now: Date): string {
  if (outcome.kind === "configError") return SETTINGS_PROBLEM;
  const { reason } = outcome;
  if (reason === "limited") return limitedSentence(limited, now);
  if (reason !== null) {
    const known = REASON_SENTENCES.get(reason);
    if (known !== undefined) return known;
  }
  if (outcome.kind === "failed" && (reason === null || RUST_CODE.test(reason))) {
    return `The run stopped unexpectedly (${reason ?? "no reason given"}).${SEE_DETAILS}`;
  }
  if (reason === null) return "The briefing wasn't made this time.";
  return `The briefing wasn't made (${reason}).${SEE_DETAILS}`;
}

/** The one sentence for a run that delivered nothing, for Today (`place: "today"`) or Schedule (`"schedule"`: no
 *  " See Details.", and its own `concurrent`). */
export function runResultSentence(outcome: RunOutcome, limited: Limited | null, now: Date, place: "today" | "schedule"): string {
  const text = todaySentence(outcome, limited, now);
  if (place === "today") return text;
  if (outcome.kind !== "configError" && outcome.reason === "concurrent") return SCHEDULE_CONCURRENT;
  return text.endsWith(SEE_DETAILS) ? text.slice(0, -SEE_DETAILS.length) : text;
}

/** The run envelope's `limited`, when the payload carries one of the right shape (`until` a string, `isProbe` a
 *  boolean); null otherwise. */
export function limitedOf(payload: unknown): Limited | null {
  if (typeof payload !== "object" || payload === null) return null;
  const limited = (payload as { limited?: unknown }).limited;
  if (typeof limited !== "object" || limited === null) return null;
  const { until, isProbe } = limited as { until?: unknown; isProbe?: unknown };
  return typeof until === "string" && typeof isProbe === "boolean" ? { until, isProbe } : null;
}
