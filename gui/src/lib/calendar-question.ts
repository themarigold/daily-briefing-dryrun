/**
 * The calendar question's words (wave-2 polish spec §4, "The words"; plan PB-M5-T1): the question Today's card and
 * the wizard's step ask a user whose calendar block was never answered, the explanation for the path "Show my
 * calendar" will take, the buttons, the busy lines, every result line and the wizard's state lines. One component,
 * `CalendarQuestion.svelte`, draws them for both; `CalendarSettings.svelte` draws the busy line while a flow runs.
 *
 * ⚠ A PRIVACY SURFACE: `test/privacy-wording.test.ts` reads this file as text (never imports it) and refuses every
 * retired promise in it (its `SUPERSEDED` list, which since this wave also holds the old claim that the calendar's
 * events stay local). The explanation says where the events go: to the AI that writes the briefing.
 *
 * ⚠ IN NO `RUNTIME_GUI_MODULES` CHAIN (plan §0.6): no engine test loads it, and no module an engine test loads may
 * import it. Its run-time imports reach `files.ts` and so `@tauri-apps/api/core`.
 */
import type { CalendarStatusJson } from "./calendar-contract";
import { connectMacMessage, MAC_DIALOG_NOTE } from "./calendar-settings";
import type { LinkPanelState } from "./calendar-settings";
import type { EngineOutcome } from "./engine";
import { describeFailure } from "./files";
import type { Os } from "./platform";
import type { ScheduleState } from "./state";
import type { FlowEnd, FlowResult, FlowRunning, TodayStoreState } from "./today-store";

/* ── the question ─────────────────────────────────────────────────────────────────────────────── */

export const QUESTION = "Show today's meetings in your briefing?";
export const SHOW_BUTTON = "Show my calendar";
/** Shared with the notification ask (`routes/Schedule.svelte`). */
export const NOT_NOW_BUTTON = "Not now";
export const TRY_AGAIN_BUTTON = "Try again";
export const CLOSE_BUTTON = "Close";
/** The wizard's way on after a failed write (the add panel's owner stage already says "Skip for now"). */
export const CONTINUE_WITHOUT_BUTTON = "Continue without a calendar";

/**
 * The path "Show my calendar" takes, from the stored status (spec §4, "by starting state"):
 * - `link`: status lists a `link` source (D3: turn the calendar on with it, no access prompt). A literal-`url` link is
 *   skipped by the engine and never listed, so it does not count;
 * - `mac`: no `link` source, and Mac Calendar can be connected here (`macSupported`);
 * - `linkPath`: neither (Linux, or a Mac without `macSupported`): the card opens a link session.
 */
export type StartingState = "link" | "mac" | "linkPath";

export function startingState(status: CalendarStatusJson): StartingState {
  if (status.sources.some((s) => s.kind === "link")) return "link";
  return status.macSupported ? "mac" : "linkPath";
}

/** The path a "Show my calendar" press takes from the stored status, `null` with none (the press then starts nothing).
 *  The card records it at the press, so an answer can say which path it came from (PB r1 X11, `wizardAnswer`). */
export function pathOf(status: CalendarStatusJson | null): StartingState | null {
  return status === null ? null : startingState(status);
}

const FROM_MAC = "from the Calendar app on this Mac";
const FROM_LINK = "from the calendar link you've added";
const FROM_LINK_AND_MAC = "from the calendar link you've added and the Calendar app on this Mac";
const FROM_NEW_LINK = "from a private calendar link you add (for example your Google Calendar's secret address)";

const explained = (from: string): string =>
  `Daily Briefing reads today's events ${from}. They go to the AI that writes your briefing, with your morning ` +
  "request, so it can fit its suggestions around your meetings. You can change this any time in Settings → Calendar.";

/** The explanation, true for the path "Show my calendar" will take — never only the platform. With a link already
 *  added, the Mac is named too only when the block has the Mac source AND it can be read here: status lists a `macos`
 *  source on any darwin (`src/calendar/status.ts`), even one too old to read it. */
export function explanationFor(status: CalendarStatusJson): string {
  switch (startingState(status)) {
    case "link":
      return explained(status.macSupported && status.sources.some((s) => s.kind === "macos") ? FROM_LINK_AND_MAC : FROM_LINK);
    case "mac":
      return explained(FROM_MAC);
    case "linkPath":
      return explained(FROM_NEW_LINK);
  }
}

/* ── while a flow runs ────────────────────────────────────────────────────────────────────────── */

export const BUSY_SAVING_LINE = "Saving your calendar choice…";
export const BUSY_ACCESS_LINE = `Waiting for calendar access. ${MAC_DIALOG_NOTE}`;

/** The busy line for a running flow's phase (the card, the wizard's step and Settings → Calendar), or `null` when no
 *  flow runs. */
export function calendarBusyLine(phase: "saving" | "access" | undefined): string | null {
  if (phase === "saving") return BUSY_SAVING_LINE;
  if (phase === "access") return BUSY_ACCESS_LINE;
  return null;
}

/** Settings → Calendar, on each store notification (spec §4 "Flows"; plan PB-M6-T1): reload its block (its `refresh()`)
 *  when a running flow has just cleared — running → null, once — so it never edits from a view that predates the flow's
 *  writes. Never for null → null (a Settings write of its own never locks it), null → running, or a phase change. */
export function refreshAfterFlow(previous: FlowRunning | null, current: FlowRunning | null): boolean {
  return previous !== null && current === null;
}

/** The Mac path's connect call was refused `busy` (a run or another engine change is going): not an answer, nothing
 *  written. The card's own per-mount line, never a store result. */
export const BUSY_REFUSAL_LINE = "Daily Briefing is busy — try again in a moment.";

/* ── results ──────────────────────────────────────────────────────────────────────────────────── */

export const ON_LINE = "Your calendar is on.";
/** Granted, but the re-read lists no `macos` source (`enableMacSource` failed after the grant). */
export const MAC_NOT_ADDED_LINE =
  "Calendar access is allowed, but the calendar couldn't be added to your settings. You can add it in Settings → Calendar.";
/** Granted, but both re-reads failed: the safe side, written off. */
export const MAC_NOT_CHECKED_LINE =
  "Calendar access is allowed, but your calendar settings couldn't be checked. You can turn the calendar on in Settings → Calendar.";
/** The connect call outlived its 150 s bound. */
export const ACCESS_TIMEOUT_LINE =
  "Allowing calendar access took too long and was stopped. You can try again in Settings → Calendar.";
/** Today's live region after "Not now" (and a retried "Not now") settles. */
export const NOT_NOW_ANNOUNCEMENT = "You can turn the calendar on any time in Settings → Calendar.";

/**
 * Today's one step over the store's "Not now" events (R5A-N4): `fire` only for a NEW settled event (`notNowSettled`
 * past what Today has `seen`) that Today started; a wizard-origin event is consumed without firing. Always answers
 * `seen: notNowSettled`, so an unrelated notification, or a fresh Today seeded from the current counter, never replays
 * an event. Today runs it from its own store subscription, independently of the card (which may have left already).
 */
export function notNowEvent(
  seen: number,
  state: Pick<TodayStoreState, "notNowSettled" | "notNowOrigin">,
): { seen: number; fire: boolean } {
  return { seen: state.notNowSettled, fire: state.notNowSettled > seen && state.notNowOrigin === "today" };
}

/** `message` then `advice` (PB r1 X2): the message's first line ends as a sentence — a period added when it has no
 *  closing punctuation (engine details often have none) — and the advice follows it, BEFORE any further lines (the
 *  engine's stderr tail that `noAnswer` appends), so the advice never trails the engine's trace. */
function withAdvice(message: string, advice: string): string {
  const nl = message.indexOf("\n");
  const head = (nl === -1 ? message : message.slice(0, nl)).trimEnd();
  const tail = nl === -1 ? "" : message.slice(nl);
  return `${/[.!?…]["'”’)\]]*$/.test(head) ? head : `${head}.`} ${advice}${tail}`;
}

/** A refused or failed access request (any reply but `ok`, or no JSON answer): `connectMacMessage`'s line, which says
 *  the real reason, then where to allow it later. `null` for a grant. */
export function accessRefusedLine(outcome: EngineOutcome): string | null {
  const message = connectMacMessage(outcome);
  return message === null ? null : withAdvice(message, "You can allow it later in Settings → Calendar.");
}

/** The connect call threw (an `EngineError`) with any kind but `busy`: the timeout's own line, else
 *  `describeFailure`'s sentence. */
export function accessThrewLine(e: unknown): string {
  if (typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "timeout") return ACCESS_TIMEOUT_LINE;
  return withAdvice(`Couldn't ask for calendar access: ${describeFailure(e)}`, "You can try again in Settings → Calendar.");
}

/* ── the card: CalendarQuestion.svelte's decisions (plan PB-M6-T2) ───────────────────────────────────── */

/** The question's buttons (and "Try again") wait while a flow runs (either origin's) or any calendar write is in
 *  flight, Settings' included (spec §5: no flow can start then). */
export function buttonsDisabled(running: FlowRunning | null, writesInFlight: number): boolean {
  return running !== null || writesInFlight > 0;
}

export interface CardInput {
  origin: FlowRunning["origin"];
  /** The caller's question gate: Today's visibility helper (`todayCard`), the wizard's entry decision (PB-M7). */
  ask: boolean;
  /** PB r1 X10 — this card's own press (Show my calendar, Not now, Try again) started the running flow while the gate
   *  was open (per mount; set by the press from `ask`, cleared when the flow ends; never by the link session). */
  ownPress: boolean;
  running: FlowRunning | null;
  writesInFlight: number;
  result: FlowResult | null;
  /** The card's own link session is open (per mount; never a store field). */
  linkSession: boolean;
  /** The card's own busy-refusal line is set (per mount; never a store result). */
  refusal: boolean;
}

/** What the card draws. `result` only for its own origin (a wizard result never shows on Today, and back); the question
 *  only when asked — or while a flow this card's own press started with the gate open runs (`ownPress`: its write may
 *  already have answered the gate, so the card keeps the question, its buttons disabled, and the busy line, spec §4
 *  "Flows"; never for the link session's closing flow, which no press started, so a question its panel's save already
 *  answered does not flash back between the panel and the result, PB r1 X10) — with no result held (a held
 *  write's "Try again" is the way on) and no link session (the panel replaces the buttons); the busy line for a running
 *  flow's phase, whichever origin started it, but none while the link session is open (the panel's own `busy` guards
 *  it). `disabled` (the question's buttons, Try again) also waits for any write in flight; `closeDisabled` only for a
 *  running flow — Close writes nothing, but closing a result its own retry is about to replace would lose the retry's
 *  answer (it would land undrawn after the card left). */
export interface CardView {
  question: boolean;
  busyLine: string | null;
  result: FlowResult | null;
  link: boolean;
  refusal: boolean;
  disabled: boolean;
  closeDisabled: boolean;
}

export function cardView(i: CardInput): CardView {
  const link = i.linkSession;
  const result = !link && i.result !== null && i.result.origin === i.origin ? i.result : null;
  const question = (i.ask || (i.ownPress && i.running?.origin === i.origin)) && !link && result === null;
  return {
    question,
    busyLine: link ? null : calendarBusyLine(i.running?.phase),
    result,
    link,
    refusal: question && i.refusal,
    disabled: buttonsDisabled(i.running, i.writesInFlight),
    closeDisabled: i.running !== null,
  };
}

/** Where the card puts the focus (spec §4 "Focus"); the component finds the target inside its own root. */
export type FocusTarget = "busyLine" | "close" | "resultLine" | "show";

/** A press started a flow: the pressed button disables (WebKit then drops its focus), so the busy line takes it. */
export const FOCUS_ON_START: FocusTarget = "busyLine";

/** After a flow (or a press that started none) ended: an answer or a failed write → the result's Close on Today, the
 *  result line in the wizard (which has no live region); a busy refusal or a Link session closed unanswered → "Show
 *  my calendar". `null`: Not now (Today lands on the slide through its land request; the wizard's step owns its line),
 *  the Link path (the panel's `startAdding` takes it), or nothing started. */
export function focusAfter(origin: FlowRunning["origin"], end: FlowEnd): FocusTarget | null {
  switch (end) {
    case "on":
    case "off":
    case "failed":
      return origin === "today" ? "close" : "resultLine";
    case "busy":
    case "unanswered":
      return "show";
    default:
      return null;
  }
}

/** `onanswered`'s kind for a settled end: an accepted answer (turned on, a failure written off, Not now — a retry's
 *  too); never a failed write, a busy refusal, an unanswered Link session, the Link path or a blocked press. */
export function answeredKind(end: FlowEnd): "on" | "off" | "notNow" | null {
  return end === "on" || end === "off" || end === "notNow" ? end : null;
}

/** The busy-refusal line (per mount): set by a `busy` end; cleared by the next "Show my calendar" press — before its
 *  outcome settles — and by any other end. */
export function refusalAfter(_shown: boolean, event: "press" | FlowEnd): boolean {
  return event === "busy";
}

/** The card's local link session (spec §4 "Link"): open while the embedded panel is drawn; `leftover` once "Done" or
 *  "Cancel" reported a link file left over (the panel then stays, offering "Remove that saved link"). */
export interface LinkSession {
  open: boolean;
  leftover: boolean;
}
export const LINK_CLOSED: LinkSession = { open: false, leftover: false };
/** PB r1 X1 — the card's own way out of the link session, drawn below the embedded panel: the panel draws "Done" and
 *  "Cancel" only once it has read the config, so over a config it cannot read (or one that does not exist) they never
 *  show. It ends the session as "Done" / "Cancel" with nothing left over would (proposed wording). */
export const LINK_BACK_BUTTON = "Back to the question";

/**
 * PB final LOW L1/L2 — the way out, from the card's own `disabled` and the embedded panel's state (`onpanelstate`):
 * - hidden while the panel offers "Remove that saved link": leaving then would strand the private link file with no
 *   config entry and no offer again (spec §4 "Link": with a leftover the card keeps the panel drawn until
 *   `onleftovercleared`). The offer — or Cancel, then the offer — is the way on. When the panel cannot draw the offer
 *   (its refresh found the config unreadable or missing) the way out shows again, so the session never dead-ends;
 * - disabled while the card's buttons wait, and while the panel's own write runs (its add's config read sits between
 *   two writes with none in flight: leaving then would let its save land after the closing flow answered).
 */
export function linkBackButton(cardDisabled: boolean, panel: LinkPanelState): { shown: boolean; disabled: boolean } {
  return { shown: !panel.leftoverOffered, disabled: cardDisabled || panel.working };
}

export type LinkEvent =
  | { kind: "open" }
  | { kind: "addClosed"; leftover: boolean }
  | { kind: "leftoverCleared" }
  | { kind: "destroy" };

/**
 * One link-session transition: the next state, whether to run the closing flow (`closeLinkSession`: a re-read, no
 * write), and what to tell `onsession` (`true` on open, `false` once when the session actually ends, `null` nothing).
 * - open: opens (reported once);
 * - Done / Cancel with no leftover: ends, with the closing flow;
 * - Done / Cancel with a leftover: stays open, remembering it, until `leftoverCleared`, which ends it with the flow
 *   (a leftover cleared before any Done / Cancel reported one closes nothing: the add panel is still open);
 * - destroy (the card unmounts): ends with no flow and no answer.
 */
export function linkSessionStep(s: LinkSession, e: LinkEvent): { next: LinkSession; closeFlow: boolean; notify: boolean | null } {
  const none = { next: s, closeFlow: false, notify: null };
  switch (e.kind) {
    case "open":
      return s.open ? none : { next: { open: true, leftover: false }, closeFlow: false, notify: true };
    case "addClosed":
      if (!s.open) return none;
      if (e.leftover) return { next: { open: true, leftover: true }, closeFlow: false, notify: null };
      return { next: LINK_CLOSED, closeFlow: true, notify: false };
    case "leftoverCleared":
      return s.open && s.leftover ? { next: LINK_CLOSED, closeFlow: true, notify: false } : none;
    case "destroy":
      return s.open ? { next: LINK_CLOSED, closeFlow: false, notify: false } : none;
  }
}

/* ── the card on Today (plan PB-M6-T3) ─────────────────────────────────────────────────────────────────── */

export interface TodayCardInput {
  /** Today has a page (a loaded briefing): never during the single loading, error or first-run state. */
  hasPage: boolean;
  /** `snapshot?.scheduleState`: a config exists when it is non-null and not `not-configured` (the signal App routes on). */
  scheduleState: ScheduleState | null | undefined;
  /** The store's own rules over its stored reply (`neverAsked`, `malformed` in today-store.ts — the ONE "never asked"
   *  rule the card and the wizard share); false with no reply. */
  neverAsked: boolean;
  malformed: boolean;
  os: Os;
  /** Close was pressed on this visit (per mount). */
  closed: boolean;
  running: FlowRunning | null;
  result: FlowResult | null;
  /** The card's link session is open (Today's per-mount state, set by the card's `onsession`). */
  linkSession: boolean;
}

/**
 * Whether Today draws the card, and whether it asks (spec §4 "When the Today card shows"). Only with a page, and not
 * after Close on this visit. Then: the question gate (a config, a stored reply never asked and not malformed, macOS or
 * Linux) — or a running flow from either origin, an open link session (whatever `enabledSet` says: the panel's own save
 * patches it at once), or a Today result not closed. A result holding a write hides the question ("Try again" is the
 * way on). Visibility never reads `enabledSet` except through the gate.
 */
export function todayCard(i: TodayCardInput): { shown: boolean; question: boolean } {
  if (!i.hasPage || i.closed) return { shown: false, question: false };
  const result = i.result !== null && i.result.origin === "today" ? i.result : null;
  const gate =
    i.scheduleState != null &&
    i.scheduleState.phase.phase !== "not-configured" &&
    i.neverAsked &&
    !i.malformed &&
    (i.os === "macos" || i.os === "linux");
  const question = gate && (result === null || result.pendingWrite === null);
  return { shown: gate || i.running !== null || i.linkSession || result !== null, question };
}

/* ── the wizard's step ────────────────────────────────────────────────────────────────────────── */

export const CHECKING_LINE = "Checking your calendar settings…";
export const WIZARD_ON_LINE = "Your calendar is on";
export const WIZARD_OFF_LINE = "Your calendar is off";
export const WIZARD_MALFORMED_LINE = "Your calendar settings can't be read";
export const WIZARD_READ_FAILED_LINE = "Your calendar settings couldn't be checked right now";
export const AFTER_SETUP_LINE = "You can change this in Settings → Calendar after setup.";
/** After "Not now" in the step, which has no result line. */
export const WIZARD_NOT_NOW_LINE = `${WIZARD_OFF_LINE}. ${AFTER_SETUP_LINE}`;

/**
 * The step's entry read (spec §4 "The wizard"; plan PB-M7-T1): `checking` until a status read through the store answers
 * (Continue waits); then, decided ONCE per entry, the question (`ask`) or a state line. `retried`: a reply dropped by
 * the store's ordering has been read once more already.
 */
export type WizardEntry = { kind: "checking"; retried: boolean } | { kind: "ask" } | { kind: "state"; line: string };
export const WIZARD_ENTRY_START: WizardEntry = { kind: "checking", retried: false };

/** The applied reply, through the store's own rules (`neverAsked`, `malformed` in today-store.ts — the ONE "never
 *  asked" rule the card and the wizard share) and its `enabled`. */
export interface WizardReply {
  neverAsked: boolean;
  malformed: boolean;
  enabled: boolean;
}

const stateEntry = (line: string): WizardEntry => ({ kind: "state", line: `${line}. ${AFTER_SETUP_LINE}` });

/**
 * One answered entry read: an applied reply decides — malformed → its line (no question over a block the engine could
 * not read), never asked → the question, else on / off; a dropped reply is read once more (`readAgain`), and a second
 * drop or a failed read is the "couldn't be checked" line. An entry already decided ignores any later reply.
 */
export function wizardCalendarEntry(
  e: WizardEntry,
  verdict: "applied" | "dropped" | "failed",
  reply: WizardReply | null,
): { next: WizardEntry; readAgain: boolean } {
  if (e.kind !== "checking") return { next: e, readAgain: false };
  if (verdict === "dropped" && !e.retried) return { next: { kind: "checking", retried: true }, readAgain: true };
  if (verdict !== "applied" || reply === null) return { next: stateEntry(WIZARD_READ_FAILED_LINE), readAgain: false };
  if (reply.malformed) return { next: stateEntry(WIZARD_MALFORMED_LINE), readAgain: false };
  if (reply.neverAsked) return { next: { kind: "ask" }, readAgain: false };
  return { next: stateEntry(reply.enabled ? WIZARD_ON_LINE : WIZARD_OFF_LINE), readAgain: false };
}

/** What the wizard's step latches from CalendarQuestion's `onanswered` (PB r1 X11): `granted` is an "on" from the Mac
 *  path (access granted and the Mac source listed — its "Try again" too, which keeps the press's path); an "on" from a
 *  link already added (D3) or from a link session stays `on`. */
export type WizardAnswer = "granted" | "on" | "off" | "notNow";

export function wizardAnswer(kind: "on" | "off" | "notNow", path: StartingState | null): WizardAnswer {
  return kind === "on" && path === "mac" ? "granted" : kind;
}

export interface WizardStepInput {
  os: Os;
  /** `null` before the entry read starts (the step was just entered): checking. */
  entry: WizardEntry | null;
  /** Latched from CalendarQuestion's `onanswered` (`wizardAnswer`); a busy refusal or an unanswered Link session never
   *  sets it. */
  answer: WizardAnswer | null;
  running: FlowRunning | null;
  result: FlowResult | null;
  /** Design 2026-10-31 r6 §4 (M3): an entry is pending (`calendarEntryPending`, the wizard's) — the first render after
   *  a show or a Back is already the checking line, never the previous entry's view. Required (spec r5 §4): every
   *  caller says whether an entry is pending. */
  entryWaiting: boolean;
}

/** What the step draws (one of `box`, `checking`, `stateLine`, `notNowLine`, `question` — CalendarQuestion mounted —
 *  with `controls` and `continueWithout` beside it) and whether the generic Continue waits. */
export interface WizardStepView {
  box: boolean;
  checking: boolean;
  stateLine: string | null;
  question: boolean;
  notNowLine: boolean;
  controls: boolean;
  continueWithout: boolean;
  continueWithoutDisabled: boolean;
  continueBlocked: boolean;
}

/**
 * The calendar step: Windows (and an unknown OS) keeps today's optional box and its Continue. macOS and Linux: checking
 * until the entry read decides; a state line; or the question — CalendarQuestion stays mounted to draw an answer's
 * result (a grant, and only a grant, also shows the wizard-mode controls: spec §4 "The wizard"; a link answer on a Mac
 * without `macSupported` must never see the Mac checkbox), while "Not now", which has no result, swaps in the step's own
 * off line. "Continue without a calendar" shows beside "Try again" for a wizard result holding a write (disabled while a
 * flow runs). Continue waits while checking, while any flow runs, and, when asked, until answered. While an entry is
 * pending (`entryWaiting`) it is the checking line, whatever the last entry decided.
 */
export function wizardCalendarStep(i: WizardStepInput): WizardStepView {
  const view: WizardStepView = {
    box: false, checking: false, stateLine: null, question: false, notNowLine: false, controls: false,
    continueWithout: false, continueWithoutDisabled: false, continueBlocked: false,
  };
  if (i.os !== "macos" && i.os !== "linux") return { ...view, box: true };
  if (i.entryWaiting) return { ...view, checking: true, continueBlocked: true };
  const entry = i.entry ?? WIZARD_ENTRY_START;
  const asked = entry.kind === "ask";
  const question = asked && i.answer !== "notNow";
  const held = i.result !== null && i.result.origin === "wizard" && i.result.pendingWrite !== null;
  return {
    ...view,
    checking: entry.kind === "checking",
    stateLine: entry.kind === "state" ? entry.line : null,
    question,
    notNowLine: asked && i.answer === "notNow",
    controls: asked && i.answer === "granted",
    continueWithout: question && held,
    continueWithoutDisabled: question && held && i.running !== null,
    continueBlocked: i.running !== null || entry.kind === "checking" || (asked && i.answer === null),
  };
}

/**
 * When the step (re-)enters (design 2026-10-31 r6 §4, M3). The wizard sets its pending flag at three moments only — the
 * first entry, a show on the step, and Back from delivery — so a flow started by the step's own question never re-enters
 * it (a grant keeps its controls, a failed write its "Try again"). A pending entry waits while a flow of either origin
 * runs or a calendar write is in flight (Settings' included), then enters: the wizard clears the flag and reads.
 */
export function calendarEntryAction(i: { pending: boolean; running: FlowRunning | null; writesInFlight: number }): "enter" | "wait" | "none" {
  if (!i.pending) return "none";
  if (i.running !== null || i.writesInFlight > 0) return "wait";
  return "enter";
}
