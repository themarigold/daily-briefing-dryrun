<script lang="ts">
  /**
   * B8 (T16) — the first-run wizard: six steps for a stranger with nothing configured, plus Phase
   * E's update-check consent (E12) and v0.3.0's optional calendar step — eight in all, the access
   * step conditional. Step numbers in the comments below are plan R1's (5 = floor and the save gate,
   * 6 = delivery); the screen numbers come from `stepHeading` (`lib/wizard.ts`), which counts only
   * the steps that show.
   *
   * ⚠ THE CONFIG IS WRITTEN ONCE, AT THE END, THROUGH THE VALIDATED PATH. Steps 1–5 build a draft
   * in webview memory and perform NO write of any kind; the one write is the gate into step 6
   * (`config_create`, or `config_save` with the base token when a config already exists —
   * `lib/wizard.ts`'s `savePlan`). Cancelling on any step before that writes NOTHING.
   *
   * ⚠ RE-RUNNING OVER AN EXISTING CONFIG PRE-POPULATES AND DOES NOT CLOBBER. The draft is seeded
   * from `config_read` (`draftFromConfig`), the save is the base-token-guarded EDIT path, unknown
   * fields ride through untouched (`mergeConfig` edits the parsed document in place), and a
   * config that APPEARS mid-wizard (a terminal `daily-briefing init`) is never replaced —
   * `config_create` is exclusive, and its `alreadyExists` refusal (like an edit-path `conflict`)
   * re-reads, RE-SEEDS the draft from what is really there, and requires an explicit
   * acknowledgement before any second write (round 1). A document whose fields cannot be seeded
   * keeps the save gate SHUT (`saveGateBlocker`) — an unseeded draft never reaches a merge.
   *
   * ⚠ STEPS 4 AND 6 ARE THE EXISTING FLOW COMPONENTS, NOT COPIES. `ScheduleAccess.svelte` IS
   * step 4 and `ScheduleInstall.svelte` IS step 6's install (plan R1: "the SAME flow component");
   * the verification is the existing `ScheduleVerify` loop — the install's own engine-side
   * kickstart IS the live test run (T20), no second run path is invented here.
   *
   * ⚠ THE NATIVE-KEY PATH DEFAULTS TO PASTE, AND THE KEY GOES ONLY TO THE ENGINE'S KEY STORE
   * (provider fallback P3-M6-T3, spec r9 §6). The pasted key lives in `pasteInput`, bound to a
   * password field, until "Store and test": `submitPaste` clears the field as it hands the key to
   * `runPaste`, whose argument goes to `lib/wizard-key.ts`'s `pasteKey` → `providerKeySet` and is
   * dropped. The draft keeps only the reference the engine answers (`draft.pasted`), so the one
   * write still carries a reference and `config_create` still refuses a literal key at any spelling.
   * A key file or command stays under "Advanced". A stored key the draft will not use is released
   * once (`releaseIfUnused`, which drops `draft.pasted` first): on Back after a failed Test, on
   * Continue onto another path, and when the wizard goes away before its save (Set up later, or
   * the screen unmounting — since design 2026-10-31 D3 only when setup really ends, never on a tab
   * switch, which hides it mounted) — and `releaseKey` never deletes one a saved config references. A leave
   * waits for a save in flight and decides by whether it landed (`releaseOnLeave`, checkpoint
   * P3-M6); Set up later and Back wait while saving; the recovery re-seed releases the key the
   * replaced draft held; a Test belongs to the model it ran on (`setApiModel`, `pastedForModel`).
   *
   * ⚠ THE LOGIN ITEM IS THE LAST STEP'S CHOICE, APPLIED ON FINISH (Phase E M5b, user-directed).
   * "Start Daily Briefing at login" is pre-ticked from `autostart_wizard_default` — ON for a fresh
   * install (plan R1's default), otherwise the REAL current state, so a re-run never re-creates a
   * login item the user removed — and NOTHING is registered until Finish calls
   * `autostart_set_enabled` with the box's value. Finish waits while that default is still being
   * read, and if it could not be read Finish leaves the login item alone unless the user ticks or
   * unticks the box (`lib/wizard.ts`'s `loginItemPlan`). While the box is untouched the default is
   * read again each time setup is shown (`loginDefaultRereads`), since Settings › This app can
   * change the login item while setup is hidden. The app registers nothing at launch any more
   * (`src-tauri/src/autostart.rs`), so "nothing is installed until you confirm at the last step"
   * holds for the login item too.
   *
   * ⚠ v0.3.0 (plan M9): THE OPTIONAL CALENDAR STEP, AFTER THE ONE WRITE AND BEFORE DELIVERY. It
   * shows the same link controls as Settings → Calendar (`lib/CalendarSettings.svelte`,
   * `mode="wizard"`), hidden until the user ticks "Add a calendar now" — off by default, and Continue
   * with it unticked writes nothing. It follows the save because a link's URL may not wait in the
   * draft and its owner confirmation needs the engine to read a config that exists (`lib/wizard.ts`).
   * Its writes are the calendar commands' own; this component still calls `configSave` once.
   * Wave-2 polish (PB-M7-T1): that box is now Windows' (and an unknown OS's). On macOS and Linux the
   * step reads status on entry and asks the calendar question (`CalendarQuestion`, origin "wizard")
   * for a block never asked, else shows a state line (see the calendar step's script below).
   *
   * ⚠ THE UPDATE-CHECK CONSENT (E12) DEFAULTS TO NO AND SENDS NOTHING. Its answer is a draft field
   * written by the one save like every other step's; this component never invokes the update check
   * itself (the Settings screen's "Check now" is the webview's only call site).
   *
   * ⚠ EVERY DYNAMIC STRING IS `{}`-INTERPOLATED, NEVER `{@html}` (`docs/gui-seam.md` §5).
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import { accessSnapshot, describeAccessFailure, type AccessSnapshot } from "../lib/access";
  import { calendarStatus, doctor, type EngineOutcome } from "../lib/engine";
  import {
    configCreate,
    configRead,
    configSave,
    describeFailure,
    type ConfigDocument,
    type FieldNote,
    type SaveOutcome,
  } from "../lib/files";
  import {
    autostartSetEnabled,
    autostartWizardDefault,
    engineNotifyLine,
    notifyAskExplanation,
    notifyStatus,
    type NotifyStatus,
  } from "../lib/notify";
  import type { Os } from "../lib/platform";
  import type { ScheduleState } from "../lib/state";
  import type { VerifyEvidence } from "../lib/verify-flow";
  import ScheduleAccess from "../lib/ScheduleAccess.svelte";
  import ScheduleInstall from "../lib/ScheduleInstall.svelte";
  import ScheduleVerify from "../lib/ScheduleVerify.svelte";
  import MorningTimeSelect from "../lib/MorningTimeSelect.svelte";
  import UpdateConsent from "../lib/UpdateConsent.svelte";
  import CalendarSettings from "../lib/CalendarSettings.svelte";
  import CalendarQuestion from "../lib/CalendarQuestion.svelte";
  import {
    calendarEntryAction,
    CHECKING_LINE,
    CONTINUE_WITHOUT_BUTTON,
    WIZARD_ENTRY_START,
    WIZARD_NOT_NOW_LINE,
    wizardAnswer,
    wizardCalendarEntry,
    wizardCalendarStep,
    type WizardAnswer,
    type WizardEntry,
  } from "../lib/calendar-question";
  import { leaveWizard, malformed, neverAsked, onTodayStore, readStatusThroughStore, todayStore } from "../lib/today-store";
  import { focusHeading } from "../lib/ui/a11y";
  import { CONSENT_TITLE } from "../lib/update-check";
  import {
    cancelWritesNothing,
    doctorRepoNotes,
    draftFromConfig,
    draftPaths,
    emptyDraft,
    finishLoginItem,
    firstWakeSentence,
    focusStepLine,
    JUDGE_LINE,
    loginDefaultRereads,
    loginItemChecked,
    loginItemNote,
    loginItemPlan,
    settleLoginItemDefault,
    type LoginItemDefault,
    nextStep,
    pastedForModel,
    previousStep,
    releaseOnLeave,
    saveGateBlocker,
    savePlan,
    seedDrops,
    setApiModel,
    stepBlocker,
    stepHeading,
    stepNumber,
    PREFILL_API_MODEL,
    ROOT_DESKTOP,
    ROOT_DOCUMENTS,
    ROOT_DOWNLOADS,
    type StepCtx,
    type StepId,
    useAnywayOffered,
    type WizardDraft,
    wizardNav,
    wizardOsWording,
  } from "../lib/wizard";
  import { pasteKey, pasteKeyNote, releaseKey, retestKey } from "../lib/wizard-key";

  interface Props {
    /** ⚠ Named `scheduleState`, not `state` — a `state` prop makes `$state(...)` parse as a
     *  store subscription (`svelte.dev/e/store_rune_conflict`, deviation 91). */
    scheduleState: ScheduleState | null;
    /** v0.2.1 §3.5: the OS this window runs on (`osFromUserAgent`, from App). REQUIRED, with no
     *  default, so a caller that forgets it fails `svelte-check` instead of silently getting one
     *  platform's wording. */
    os: Os;
    /** Design 2026-10-31 r6 §4 (M3): whether setup is on screen (`route === "wizard"`, from App), which keeps it
     *  mounted while another tab is shown. REQUIRED, with no default, like `os`. While false the calendar step's body
     *  is not drawn and the verification loop is suspended; showing it again on the calendar step re-enters that step,
     *  and focuses the step line. */
    shown: boolean;
    /** The live facts the step-6 verification loop watches — from the pushed `Snapshot`. */
    evidence?: VerifyEvidence;
    /** True while the notification opt-in has never been asked (the explained ask shows). */
    notifyAsk?: boolean;
    notifyAskError?: string | null;
    onnotifychoice?: (enabled: boolean) => void;
    /** Leave without writing (steps 1–5) — the parent routes away; the draft is dropped. */
    oncancel?: () => void;
    /** Done (Finish, or "Finish setup later") — the parent closes setup, and routes to Today only if setup is the
     *  screen shown (a Finish that completes behind another tab leaves the user where they went). */
    onfinished?: () => void;
  }
  let {
    scheduleState,
    os,
    shown,
    evidence = { skipIso: null, delivered: false },
    notifyAsk = false,
    notifyAskError = null,
    onnotifychoice = () => {},
    oncancel = () => {},
    onfinished = () => {},
  }: Props = $props();

  let step = $state<StepId>("welcome");
  /** True until the first step change or the first hide (design 2026-10-31 r6 §4 "Focus"): the step line then takes
   *  focus on every step change and every show (`focusStepLine`), never on the first mount. Never set back. */
  let firstMount = $state(true);
  /** v0.2.1 §3.5: every OS-dependent string the steps below show (macOS: the pre-v0.2.1 text). */
  const wording = $derived(wizardOsWording(os));
  let draft = $state(emptyDraft());
  /** The loaded document — `null` until `config_read` answers. Its `exists` picks create vs edit. */
  let doc = $state<ConfigDocument | null>(null);
  let docError = $state<string | null>(null);
  /** True when the draft was pre-populated from an existing config (the re-run path). */
  let prePopulated = $state(false);
  /** An existing config could not be read into the draft's fields: the save gate stays SHUT —
   *  an empty draft must never fall through to a merge (round 1). */
  let seedFailed = $state(false);
  /** The recovery path ran (`alreadyExists`/`conflict`: the draft was RE-SEEDED from disk) and
   *  the second write needs the explicit acknowledgement below. */
  let recovered = $state(false);
  let recoverAck = $state(false);

  /** Step 4's data: the access snapshot computed over the DRAFT's paths. */
  let access = $state<AccessSnapshot | null>(null);
  let accessError = $state<string | null>(null);
  let accessLoading = $state(false);
  /** Whether step 4 applies at all — darwin AND a protected root reached by the draft. */
  let accessInScope = $state(false);
  /** Whether that check has run (either way it ended): set by `continueFromRepos`, never cleared — a recovery
   *  re-seed keeps it, like `accessInScope`. Until then the screen counts the access step on macOS. */
  let accessKnown = $state(false);
  /** What the screen numbers depend on (`stepHeading`, `stepNumber`). */
  const stepCtx: StepCtx = $derived({ os, accessKnown, accessInScope });

  /** P3-M6-T3: the paste field's text — the ONE place the key sits, cleared as it is handed over (`submitPaste`). */
  let pasteInput = $state("");
  /** A key step (`pasteKey` / `retestKey`) is running: the step's buttons wait for it. */
  let keyBusy = $state(false);
  /** What the last key step or release said. */
  let keyLines = $state<string[]>([]);
  /** The wizard went away: a key step that ends now releases the key it stored. Gates, not shown. */
  let destroyed = false;

  /** The optional calendar step's "Add a calendar now" — OFF by default; it only reveals the controls. */
  let calendarOpen = $state(false);

  /** The save gate's state. */
  let saving = $state(false);
  let saveFailure = $state<string | null>(null);
  let saveErrors = $state<FieldNote[]>([]);
  let saveWarnings = $state<FieldNote[]>([]);
  let saved = $state<SaveOutcome | null>(null);
  /** The save in flight, resolving to whether it LANDED (`saveOnce`); `null` when none runs. A leave awaits it before
   *  it releases a key (`releaseOnLeave`, checkpoint P3-M6). Gates, not shown. */
  let saveInFlight: Promise<boolean> | null = null;
  /** The save changed `provider`, so the audit judge's configuration (requirement 10): show `JUDGE_LINE`. */
  let judgeChanged = $state(false);

  /** Step 6: the post-save provider check (`doctor --json`) and the engine-notify line. */
  let providerCheck = $state<EngineOutcome | null>(null);
  let providerCheckError = $state<string | null>(null);
  let notify = $state<NotifyStatus | null>(null);
  /** Arms the verification loop after a SUCCESSFUL install (`armsVerify` gates `onfinished`). */
  let verifyTrigger = $state(0);
  /** The install control is busy (`ScheduleInstall`'s `onbusy`: running, or its foreign-owner dialog open), and a
   *  verify call is in flight (`ScheduleVerify`'s `onbusy`). The nav waits on both (`wizardNav`). */
  let installBusy = $state(false);
  let verifyInFlight = $state(false);

  /** The last step's "Start Daily Briefing at login" (Phase E M5b), APPLIED ONLY ON FINISH. Two
   *  separate facts, so a late default read can never overwrite the user (checkpoint fix): what
   *  `autostart_wizard_default` said — pending until it answers — and the user's own tick, `null`
   *  until they touch the box. `loginItemPlan` (lib/wizard.ts) turns them into what Finish does:
   *  WAIT while the read is pending and the box untouched (no provisional value is ever applied),
   *  LEAVE the system as it is if the read failed and the box is untouched, else APPLY. */
  let loginDefault = $state<LoginItemDefault>({ kind: "pending" });
  let loginChoice = $state<boolean | null>(null);
  const loginPlan = $derived(loginItemPlan(loginDefault, loginChoice));
  let loginItemError = $state<string | null>(null);
  let finishing = $state(false);
  /** Bumped on each read of the login-item default, so an earlier read's late reply never overwrites a newer one (final
   *  harden r1, MED 3: setup shown again reads it once more). Gates, not shown. */
  let loginReads = 0;

  /** Read the login-item default: `pending` until this read answers. A READ — it enables nothing. It sets only
   *  `loginDefault`; the user's tick is a separate fact it never touches. A failure is a state of its own (`failed`),
   *  never an OFF. Run on mount and, while the box is untouched, each time setup is shown again (`loginDefaultRereads`). */
  function readLoginItemDefault(): void {
    const mine = ++loginReads;
    loginDefault = { kind: "pending" };
    void settleLoginItemDefault(() => autostartWizardDefault(), describeFailure).then((settled) => {
      if (mine === loginReads) loginDefault = settled;
    });
  }

  /** Seed the draft from a loaded document — the pre-populate path (onMount) AND the recovery
   *  path (the save catch). A document whose fields cannot be read sets `seedFailed`, which
   *  keeps the save gate shut: the wizard must never merge a draft the user was not shown. */
  function seedFromDocument(next: ConfigDocument): void {
    doc = next;
    docError = null;
    if (!next.exists) {
      seedFailed = false;
      return;
    }
    const seeded = next.text !== null ? draftFromConfig(next.text) : null;
    if (seeded === null) {
      seedFailed = true;
      return;
    }
    const before = draft;
    draft = seeded;
    // The recovery path's re-seed drops the draft's stored key: released, through the same decision as a leave
    // (after the failed save has ended; checkpoint P3-M6).
    if (seedDrops(before, seeded)) releaseIfUnused("leave", () => before);
    prePopulated = true;
    seedFailed = false;
  }

  onMount(() => {
    void configRead()
      .then((next) => seedFromDocument(next))
      .catch((e) => {
        docError = describeFailure(e);
      });
    // The login-item default: a READ, which enables nothing (`readLoginItemDefault`).
    readLoginItemDefault();
  });

  /** Hand the pasted key over and clear the field, in one step. */
  function submitPaste(): void { const pasted = pasteInput; pasteInput = ""; void runPaste(pasted); }

  /** Store and test (`lib/wizard-key.ts`). The argument is handed to `pasteKey` and dropped. */
  async function runPaste(key: string): Promise<void> {
    keyBusy = true;
    keyLines = [];
    try {
      const model = draft.apiModel;
      const r = await pasteKey(doc, draft, key, os);
      if (destroyed) { if (r.pasted !== null) void releaseKey(r.pasted, os); return; }
      // A model edited while the Test ran: its answer was about the other model (`pastedForModel`).
      draft.pasted = pastedForModel(r.pasted, model, draft.apiModel);
      keyLines = r.lines;
    } finally {
      keyBusy = false;
    }
  }

  /** Test the stored key again, on the draft as it is now. */
  async function runRetest(): Promise<void> {
    if (draft.pasted === null) return;
    keyBusy = true;
    try {
      const model = draft.apiModel;
      const r = await retestKey(doc, draft);
      if (destroyed) { if (r.pasted !== null) void releaseKey(r.pasted, os); return; }
      draft.pasted = pastedForModel(r.pasted, model, draft.apiModel);
      keyLines = r.lines;
    } finally {
      keyBusy = false;
    }
  }

  /** After a failed Test that RAN: the user chooses to use the key anyway (requirement 6). */
  function useAnyway(): void {
    if (draft.pasted !== null && useAnywayOffered(draft.pasted)) draft.pasted = { ...draft.pasted, useAnyway: true };
  }

  /** Discard (or "Use a different key"): the stored key is released now. */
  function discardPasted(): void {
    const p = draft.pasted;
    if (p === null) return;
    draft.pasted = null;
    void releaseKey(p, os).then((lines) => (keyLines = lines));
  }

  /** Release the pasted key when leaving this way would leave it unused (`releaseOnLeave`): once any save in flight
   *  has settled, decided by whether it landed — once: the draft lets go of it before the release is awaited. `from`:
   *  the draft to release from (a re-seed passes the one it replaced). */
  function releaseIfUnused(how: "continue" | "back" | "leave", from: () => WizardDraft = () => draft): void {
    void releaseOnLeave({ inFlight: saveInFlight, landed: () => saved !== null, how, draft: from, release: (p) => releaseKey(p, os) }).then((lines) => { if (lines !== null) keyLines = lines; });
  }

  // A save that landed (before, or while this waits for it) releases only a key the saved draft does not use; before
  // it, any — `releaseOnLeave` decides which.
  onDestroy(() => { destroyed = true; releaseIfUnused("leave"); });

  /* ── the calendar step (wave-2 polish spec §4 "The wizard"; plan PB-M7-T1) ─────────────────────────────────
   * macOS and Linux: on entering the step, a status read through the Today store decides ONCE what it shows — the
   * calendar question (CalendarQuestion, origin "wizard": the same words, paths and flows as Today's card) for a block
   * never asked and not malformed, else a state line. Windows keeps the optional box below. Every decision is
   * calendar-question.ts's (`wizardCalendarEntry`, `wizardCalendarStep`); a server render never reaches the step. */

  /** The store, read at once and followed while mounted: a running flow, its held result. */
  let calendarStore = $state.raw(todayStore());
  let offCalendarStore: (() => void) | null = null;
  /** The step's entry read: `null` until the step is entered, then checking until it decides. */
  let calendarEntry = $state<WizardEntry | null>(null);
  /** The question's answer, latched from CalendarQuestion's `onanswered` (no destroyed-guard: it is this step's), with a
   *  grant told apart (`wizardAnswer`): only a grant shows the wizard-mode controls. */
  let calendarAnswer = $state<WizardAnswer | null>(null);
  /** Bumped on each entry, so an earlier entry's late read decides nothing. Gates, not shown. */
  let calendarEntries = 0;
  /** Design 2026-10-31 r6 §4 (M3): an entry is due. Set at exactly three moments — the first entry (the save), setup
   *  shown again on the step, and Back from delivery — and NOWHERE else, so a flow started by the step's own question
   *  never re-enters it. The entry effect clears it once `calendarEntryAction` says "enter"; until then the step draws
   *  its checking line (`entryWaiting`). */
  let calendarEntryPending = $state(false);
  /** Setup was hidden since it was last shown. Gates, not shown. */
  let hiddenSinceShown = false;

  const calendarView = $derived(wizardCalendarStep({ os, entry: calendarEntry, answer: calendarAnswer, running: calendarStore.flow.running, result: calendarStore.flow.result, entryWaiting: calendarEntryPending }));
  /** The generic Continue waits on the calendar step while checking, while a flow runs, and until answered. */
  const calendarHold = $derived(step === "calendar" && calendarView.continueBlocked);

  onMount(() => {
    calendarStore = todayStore();
    offCalendarStore = onTodayStore((s) => (calendarStore = s));
  });
  onDestroy(() => offCalendarStore?.());

  /** On entering the step: read status through the store (a reply its ordering dropped is read once more), then decide. */
  async function enterCalendarStep(): Promise<void> {
    const mine = ++calendarEntries;
    calendarEntry = WIZARD_ENTRY_START;
    calendarAnswer = null;
    let readAgain = true;
    while (readAgain) {
      const r = await readStatusThroughStore(() => calendarStatus());
      if (mine !== calendarEntries || destroyed) return;
      const s = todayStore().status;
      const decided = wizardCalendarEntry(calendarEntry, r.verdict, r.verdict === "applied" && s !== null ? { neverAsked: neverAsked(s), malformed: malformed(s), enabled: s.enabled === true } : null);
      calendarEntry = decided.next;
      readAgain = decided.readAgain;
    }
  }

  /** After a failed write: drop the held write and its result, then go on (the step's unmount then finds nothing). */
  function continueWithoutCalendar(): void {
    leaveWizard();
    step = nextStep(step, accessInScope) ?? step;
  }

  // The entry: once pending and no flow runs or calendar write is in flight. Windows keeps the box, which reads nothing.
  $effect(() => {
    if (calendarEntryAction({ pending: calendarEntryPending, running: calendarStore.flow.running, writesInFlight: calendarStore.writesInFlight }) !== "enter") return;
    calendarEntryPending = false;
    if (os === "macos" || os === "linux") untrack(() => void enterCalendarStep());
  });
  // Shown again while on the calendar step: its body was not drawn while hidden, so an answer given on Today or in
  // Settings meanwhile is read by a fresh entry. `$effect.pre` (final harden r1, MED 1): it runs before the DOM update,
  // so the flag is set before `{#if shown}` draws the body — the first render after a show is the checking line, never
  // the previous entry's view (which would mount CalendarQuestion / CalendarSettings for one flush). And while the
  // login box is untouched, the login-item default is read again: Settings › This app may have changed it meanwhile.
  $effect.pre(() => {
    if (!shown) {
      hiddenSinceShown = true;
    } else if (hiddenSinceShown) {
      hiddenSinceShown = false;
      if (untrack(() => step) === "calendar") calendarEntryPending = true;
      if (loginDefaultRereads(untrack(() => loginChoice))) untrack(() => readLoginItemDefault());
    }
  });
  $effect(() => {
    if (step !== "welcome" || !shown) firstMount = false;
  });

  /** Finish: carry out the login-item plan — the ONE place this screen registers or removes it —
   *  then leave. The button is disabled while the plan is `wait`; a `leave` plan finishes without
   *  touching the login item. A failure keeps the user here with the reason; unticking the box
   *  and pressing Finish again finishes without a login item. */
  async function finish(): Promise<void> {
    if (finishing) return;
    const plan = loginItemPlan(loginDefault, loginChoice);
    finishing = true;
    loginItemError = null;
    try {
      if (await finishLoginItem(plan, (enabled) => autostartSetEnabled(enabled))) onfinished();
    } catch (e) {
      const turning = plan.kind === "apply" && plan.enabled ? "turned on" : "turned off";
      loginItemError = `Start at login could not be ${turning}: ${describeFailure(e)}. Press Finish to try again, or change the box above and press Finish.`;
    } finally {
      finishing = false;
    }
  }

  /** "Finish setup later" (calendar and delivery steps, design 2026-10-31 D3): leave WITHOUT `finish()` — nothing is
   *  installed and the login-item plan is not applied. The config was already saved, once. */
  function finishLater(): void {
    onfinished();
  }

  /** Continue from step 3: compute the draft's protected-root scope, then route past or into
   *  step 4. A failed snapshot is reported and the flow continues to step 5 — the Schedule &
   *  Access panel remains available for existing-config users after the save. It routes only if the
   *  wizard is still on step 3 when the snapshot lands: a Back meanwhile must not be undone by a late
   *  answer. */
  async function continueFromRepos(): Promise<void> {
    accessLoading = true;
    accessError = null;
    try {
      const snapshot = await accessSnapshot(draftPaths(draft));
      access = snapshot;
      accessInScope = snapshot.supported && snapshot.roots.length > 0;
      accessKnown = true;
    } catch (e) {
      access = null;
      accessInScope = false;
      accessKnown = true;
      accessError = describeAccessFailure(e);
    } finally {
      accessLoading = false;
    }
    if (step === "repos") step = nextStep("repos", accessInScope) ?? "floor";
  }

  async function refreshAccess(): Promise<void> {
    accessLoading = true;
    try {
      access = await accessSnapshot(draftPaths(draft));
      accessError = null;
    } catch (e) {
      accessError = describeAccessFailure(e);
    } finally {
      accessLoading = false;
    }
  }

  /** THE one write — the gate from step 5 into step 6. The save in flight is kept (`saveInFlight`) until it ends, so a
   *  leave meanwhile waits for it. */
  async function saveAndContinue(): Promise<void> {
    if (saving) return;
    const run = saveOnce(); saveInFlight = run;
    try {
      await run;
    } finally {
      if (saveInFlight === run) saveInFlight = null;
    }
  }

  /** The save itself: whether it LANDED (`saved`, `created`, `unchanged`), or not (refused, or it threw). */
  async function saveOnce(): Promise<boolean> {
    saving = true;
    saveFailure = null;
    saveErrors = [];
    saveWarnings = [];
    judgeChanged = false;
    try {
      const current = doc ?? { exists: false, text: null, base: null };
      const plan = savePlan(current, draft);
      const outcome =
        plan.kind === "create"
          ? await configCreate(plan.text)
          : await configSave(plan.text, plan.base);
      if (outcome.kind === "invalid") {
        saveErrors = outcome.errors;
        saveWarnings = outcome.warnings;
        return false;
      }
      // `saved`, `created` and `unchanged` all proceed to step 6 — explicitly: `unchanged` is a
      // real success (the untouched re-run), and the step-6 copy names which of the three
      // happened. Only `unchanged` and `created` carry no warnings.
      saved = outcome;
      judgeChanged = plan.kind === "save" && plan.judgeChanged && outcome.kind === "saved";
      saveWarnings = outcome.kind === "saved" || outcome.kind === "created" ? outcome.warnings : [];
      recovered = false;
      // v0.3.0: the optional calendar step, then delivery (`nextStep`).
      step = nextStep("floor", accessInScope) ?? "delivery";
      calendarEntryPending = true;
      void doctor()
        .then((check) => (providerCheck = check))
        .catch((e) => (providerCheckError = describeFailure(e)));
      void notifyStatus()
        .then((s) => (notify = s))
        .catch(() => {});
      return true;
    } catch (e) {
      // `alreadyExists` / `conflict`: the file changed under the wizard (a terminal init, an
      // edit). Nothing was replaced — and the refusal's "reload and edit it instead" is now
      // something this component actually DOES (round 1): re-read, RE-SEED the draft from what
      // is really there (so the banner and every step show the real file), and require the
      // explicit acknowledgement below before any second write. The draft as it stood described
      // a FRESH setup; merging it un-reseeded over the just-protected config was the clobber.
      saveFailure = describeFailure(e);
      const kind =
        typeof e === "object" && e !== null && "kind" in e ? String((e as { kind: unknown }).kind) : "";
      if (kind === "alreadyExists" || kind === "conflict") {
        try {
          const next = await configRead();
          seedFromDocument(next);
          recovered = true;
          recoverAck = false;
        } catch {
          /* the failure line above already says what happened */
        }
      }
      return false;
    } finally {
      saving = false;
    }
  }

  const blocker = $derived(stepBlocker(step, draft));
  const gateBlocker = $derived(
    saveGateBlocker({ seedFailed, recovered, acknowledged: recoverAck }),
  );
  const engineOwner = $derived(scheduleState?.owner ?? null);
  /** A calendar flow running or a calendar write in flight: "Finish setup later" on the calendar step waits for it. */
  const calendarBusy = $derived(calendarStore.flow.running !== null || calendarStore.writesInFlight > 0);
  /** Every nav button (design 2026-10-31 r6 §3, `wizardNav`). */
  const nav = $derived(wizardNav(step, { saving, keyBusy, accessLoading, installBusy, verifyInFlight, verifyTriggered: verifyTrigger > 0, finishing, calendarBusy }));
</script>

<section class="wizard">
  <header class="head">
    <h2>Set up Daily Briefing</h2>
    {#key step}
      <p class="muted" tabindex="-1" use:focusHeading={focusStepLine(firstMount, shown)}>{stepHeading(step, stepCtx)}</p>
    {/key}
  </header>

  {#if docError !== null}
    <pre class="bad">{docError}</pre>
  {/if}
  {#if seedFailed}
    <pre class="bad">A configuration already exists{doc !== null ? ` at ${doc.path}` : ""}, but it
could not be read into this wizard's fields. Nothing was changed, and saving from here is
disabled — it could overwrite settings you have never been shown. Edit the file directly, or use
the Settings screen.</pre>
  {/if}
  {#if prePopulated && cancelWritesNothing(step)}
    <p class="muted small">
      A config already exists{doc !== null ? ` at ${doc.path}` : ""}. The steps below show what it
      says; finishing saves only what you change, and everything this wizard does not ask about is
      kept as it is.
    </p>
  {/if}

  {#if step === "welcome"}
    <div class="body">
      <p>
        Daily Briefing writes you a short morning briefing about your own repositories — what you
        did, where you left off, and what to pick up next.
      </p>
      <ul>
        <li>
          <strong>Local-first.</strong> Everything runs on {wording.machine}. Your repositories are read
          here, the briefing is written here, and the archive stays here
          {doc !== null ? ` (the configuration this wizard creates lives at ${doc.path})` : ""}.
        </li>
        <li>
          <strong>No telemetry:</strong> no analytics, no usage or crash reports, no account, and
          this app turns off the crash reports of Bun, the runtime the engine is built with, for the
          runs it starts and schedules. What the briefing is built from (commit subjects, short hashes and dates,
          the names of changed and uncommitted files, repository and branch names, stash messages)
          goes only to the AI you choose in the next step. The engine also checks that the network is
          up before it writes, and whenever this app checks your setup{wording.checkOnOpen} (a connection that
          sends no data), and asks GitHub whether a newer version exists only if you say yes in step
          {stepNumber("updates", stepCtx)}, turn it on later in Settings, or press Check now there. In a partial clone, git itself
          may also download missing file contents from that repository's own remote.
        </li>
        <li>
          <strong>Bring your own AI.</strong> The engine talks to an AI you already have — an
          installed CLI, your own API key, or a local model server. This app never calls a
          provider itself; the next step chooses which one the engine uses.
        </li>
        <li>
          <strong>Nothing happens until the end.</strong> No configuration is written and nothing
          is installed until you confirm at the last step{wording.folderAccessClause}.
          Cancelling now changes nothing.
        </li>
      </ul>
    </div>
  {:else if step === "provider"}
    <div class="body">
      <p>
        The engine needs a way to reach a language model. Every option below is a CLI or an
        endpoint the <strong>engine</strong> talks to when it generates your briefing — this app
        never calls a provider itself.
      </p>
      <label class="choice">
        <input type="radio" name="provider-path" checked={draft.providerPath === "cli"}
          onchange={() => (draft.providerPath = "cli")} />
        <span>
          <strong>An installed CLI (recommended).</strong> Uses a coding CLI you already have and
          its existing login — no key to manage.
        </span>
      </label>
      {#if draft.providerPath === "cli"}
        <div class="indent">
          <label class="choice">
            <input type="radio" name="cli" checked={draft.cli === "claude"}
              onchange={() => (draft.cli = "claude")} />
            <span><code>claude</code> — the default the engine's own setup picks first</span>
          </label>
          <label class="choice">
            <input type="radio" name="cli" checked={draft.cli === "codex"}
              onchange={() => (draft.cli = "codex")} />
            <span><code>codex</code></span>
          </label>
          <p class="muted small">
            Whether the CLI is actually installed is checked by the engine once the configuration
            is written — the last step runs its health check and shows what it found.
          </p>
        </div>
      {/if}
      <label class="choice">
        <input type="radio" name="provider-path" checked={draft.providerPath === "api"}
          onchange={() => (draft.providerPath = "api")} />
        <span>
          <strong>An Anthropic API key.</strong> The engine calls the API directly — billed to
          your key, no CLI needed.
        </span>
      </label>
      {#if draft.providerPath === "api"}
        <div class="indent">
          <label class="field">
            <span>Model</span>
            <input type="text" value={draft.apiModel}
              oninput={(e) => setApiModel(draft, e.currentTarget.value)} />
          </label>
          <label class="choice">
            <input type="checkbox" checked={draft.apiModelConfirmed}
              onchange={(e) => (draft.apiModelConfirmed = e.currentTarget.checked)} />
            <span>
              Use this model. <span class="muted">{PREFILL_API_MODEL} is prefilled, not chosen
              for you — the model decides what your briefing costs and reads like.</span>
            </span>
          </label>
          {#if !draft.apiKeyAdvanced}
            <p class="muted small">{pasteKeyNote(os)}</p>
            {#if draft.pasted === null}
              <label class="field">
                <span>API key</span>
                <input type="password" autocomplete="off" spellcheck="false" bind:value={pasteInput} />
              </label>
              <div class="buttons">
                <button type="button" disabled={keyBusy || pasteInput.trim() === ""} onclick={submitPaste}>
                  {keyBusy ? "Storing and testing…" : "Store and test"}
                </button>
              </div>
            {:else}
              <p>
                {draft.pasted.test === "passed"
                  ? "Your key is stored and passed its test."
                  : draft.pasted.test === "failed"
                    ? draft.pasted.useAnyway
                      ? "Your key is stored. It failed its test, and you chose to use it anyway."
                      : "Your key is stored, but it failed its test."
                    : "Your key is stored, but it has not been tested yet."}
              </p>
              <div class="buttons">
                {#if draft.pasted.test !== "passed"}
                  <button type="button" disabled={keyBusy} onclick={() => void runRetest()}>
                    {keyBusy ? "Testing…" : "Test again"}
                  </button>
                {/if}
                {#if useAnywayOffered(draft.pasted)}
                  <button type="button" disabled={keyBusy} onclick={useAnyway}>Use it anyway</button>
                {/if}
                <button type="button" disabled={keyBusy} onclick={discardPasted}>
                  {draft.pasted.test === "passed" ? "Use a different key" : "Discard"}
                </button>
              </div>
            {/if}
            {#each keyLines as line, i (i)}
              <p class="muted small">{line}</p>
            {/each}
          {:else}
            <p class="muted small">
              Instead of pasting, point the engine at where your key lives — a file only you can
              read, or a command that prints it (a keychain helper, say). An environment variable
              will not work here: neither this app nor the background scheduler passes your
              shell's environment to the engine.
            </p>
            <label class="field">
              <span>Key file (e.g. ~/.config/daily-briefing/anthropic-key — chmod 600)</span>
              <input type="text" value={draft.apiKeyFile}
                oninput={(e) => (draft.apiKeyFile = e.currentTarget.value)} />
            </label>
            <label class="field">
              <span>…or a command that prints the key (one argument per line)</span>
              <textarea rows="2" value={draft.apiKeyCommand}
                oninput={(e) => (draft.apiKeyCommand = e.currentTarget.value)}></textarea>
            </label>
          {/if}
          <label class="choice">
            <input type="checkbox" checked={draft.apiKeyAdvanced}
              onchange={(e) => (draft.apiKeyAdvanced = e.currentTarget.checked)} />
            <span>Advanced: point at a key file or a command instead of pasting</span>
          </label>
        </div>
      {/if}
      <label class="choice">
        <input type="radio" name="provider-path" checked={draft.providerPath === "local"}
          onchange={() => (draft.providerPath = "local")} />
        <span>
          <strong>A local model server.</strong> Ollama, LM Studio, vLLM — an OpenAI-compatible
          endpoint on this machine. The prompt built from your repositories never leaves
          {wording.localModelStaysOn}.
        </span>
      </label>
      {#if draft.providerPath === "local"}
        <div class="indent">
          <label class="field">
            <span>Endpoint URL (for Ollama: http://127.0.0.1:11434/v1)</span>
            <input type="text" value={draft.localBaseUrl}
              oninput={(e) => (draft.localBaseUrl = e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>Model</span>
            <input type="text" value={draft.localModel}
              oninput={(e) => (draft.localModel = e.currentTarget.value)} />
          </label>
          <p class="muted small">
            Two settings are prefilled for a local model: a longer per-call timeout (a local model
            can take minutes where a hosted one takes seconds), and the morning internet check is
            turned off (networkProbeHosts: []) — your briefing needs no internet when the model
            runs on this machine (unless one of your repositories is a partial clone, whose missing
            file contents git downloads from its remote).
          </p>
        </div>
      {/if}
    </div>
  {:else if step === "repos"}
    <div class="body">
      <p>
        The briefing is built from your git repositories. Choose where the engine looks for them —
        it scans the folders below (two levels deep) on every run, so new repositories are picked
        up on their own.
      </p>
      <label class="choice">
        <input type="checkbox" checked={draft.rootHome}
          onchange={(e) => (draft.rootHome = e.currentTarget.checked)} />
        <span>
          <strong>Home folder (~)</strong> — what the engine's own setup uses.
          <span class="muted">The scan looks inside every non-hidden folder, including Desktop,
          Documents and Downloads{wording.homeScanAsks}. Untick this and list folders yourself to
          keep the scan narrow.</span>
        </span>
      </label>
      {#if wording.protectedFoldersNote}
        <p class="muted small">
          These three are macOS-protected and start UNTICKED on purpose: nothing should trigger a
          permission dialog you did not choose. Tick one only if your repositories live there —
          the next step then walks you through the grant.
        </p>
      {/if}
      <label class="choice">
        <input type="checkbox" checked={draft.rootDesktop}
          onchange={(e) => (draft.rootDesktop = e.currentTarget.checked)} />
        <span>{ROOT_DESKTOP}</span>
      </label>
      <label class="choice">
        <input type="checkbox" checked={draft.rootDocuments}
          onchange={(e) => (draft.rootDocuments = e.currentTarget.checked)} />
        <span>{ROOT_DOCUMENTS}</span>
      </label>
      <label class="choice">
        <input type="checkbox" checked={draft.rootDownloads}
          onchange={(e) => (draft.rootDownloads = e.currentTarget.checked)} />
        <span>{ROOT_DOWNLOADS}</span>
      </label>
      <label class="field">
        <span>Other folders to scan (one per line, e.g. ~/dev)</span>
        <textarea rows="2" value={draft.customRoots}
          oninput={(e) => (draft.customRoots = e.currentTarget.value)}></textarea>
      </label>
      <label class="field">
        <span>Or list repositories directly (one per line — scanning is then skipped)</span>
        <textarea rows="2" value={draft.explicitRepos}
          oninput={(e) => (draft.explicitRepos = e.currentTarget.value)}></textarea>
      </label>
      <label class="field">
        <span>Repositories to leave out (one per line — a full path, or just a folder name like
          an old work checkout)</span>
        <textarea rows="2" value={draft.excludeRepos}
          oninput={(e) => (draft.excludeRepos = e.currentTarget.value)}></textarea>
      </label>
      <p class="muted small">
        The last step shows what the engine actually finds; anything noisy can be excluded later
        on the Settings screen.
      </p>
    </div>
  {:else if step === "access"}
    <div class="body">
      <p>
        Some folders you chose are ones macOS protects. The engine cannot read them — and your
        briefing is quietly thinner — until access is granted. This is the same panel the
        Schedule screen carries, so you can redo any of it later.
      </p>
      <ScheduleAccess snapshot={access} error={accessError} onrefresh={refreshAccess}
        refreshing={accessLoading} />
      <p class="muted small">
        The second check names a background engine copy — that copy exists only after the last
        step installs background delivery. Come back to the Schedule screen afterwards if it is
        not listed yet.
      </p>
    </div>
  {:else if step === "updates"}
    <div class="body">
      <h3 class="step-title">{CONSENT_TITLE}</h3>
      <UpdateConsent value={draft.updateCheck} onchange={(v) => (draft.updateCheck = v)} />
    </div>
  {:else if step === "floor"}
    <div class="body">
      <p>
        When should your briefing be ready? This is the <strong>earliest</strong> time, not an
        exact one.
      </p>
      <!-- v0.2.1 §3.2: two dropdowns writing HH:MM (`lib/MorningTimeSelect.svelte`), not free
           text. A re-run seed is already normalised (`draftFromConfig`), and a stored value the
           engine cannot read is named in the note below — as text. Picking a time clears that
           note: it describes the stored value, which the pick has just replaced. -->
      <div class="field">
        <label for="wizard-morning-time">Morning time</label>
        <MorningTimeSelect id="wizard-morning-time" value={draft.floor}
          onchange={(hhmm) => { draft.floor = hhmm; draft.floorNote = null; }} />
      </div>
      {#if draft.floorNote !== null}
        <p class="warn-text">{draft.floorNote}</p>
      {/if}
      <p class="first-wake">{firstWakeSentence(draft.floor)}</p>
      <p class="muted small">
        The background check runs every ten minutes while {wording.awake} is awake. A closed laptop
        generates nothing — the briefing arrives shortly after the first wake past this time.
      </p>
    </div>
  {:else if step === "calendar"}
    {#if shown}
      <div class="body">
        {#if saved !== null}
          <p class="ok">
            {saved.kind === "created"
              ? "Your configuration was created"
              : saved.kind === "saved"
                ? "Your configuration was saved"
                : "Your configuration is unchanged"}{doc !== null ? ` at ${doc.path}` : ""}. You can change these settings in Settings after setup.
          </p>
        {/if}
        {#if judgeChanged}
          <p class="muted small">{JUDGE_LINE}</p>
        {/if}
        {#if calendarView.box}
          <p>
            Your briefing can also show today's calendar, and the AI then fits its suggestions around your
            meetings. This is optional and off unless you add a calendar — here, or any time later in
            Settings.
          </p>
          <label class="choice">
            <input type="checkbox" checked={calendarOpen}
              onchange={(e) => (calendarOpen = e.currentTarget.checked)} />
            <span><strong>Add a calendar now</strong> — a private calendar link from Google, Outlook, iCloud
              or another calendar.</span>
          </label>
          {#if calendarOpen}
            <CalendarSettings {os} mode="wizard" />
          {/if}
        {:else if calendarView.checking}
          <p class="muted">{CHECKING_LINE}</p>
        {:else if calendarView.stateLine !== null}
          <p>{calendarView.stateLine}</p>
        {:else if calendarView.notNowLine}
          <p tabindex="-1" use:focusHeading>{WIZARD_NOT_NOW_LINE}</p>
        {:else if calendarView.question}
          <CalendarQuestion origin="wizard" {os} status={calendarStore.status} ask={calendarAnswer === null && calendarStore.flow.running === null} onanswered={(kind, path) => (calendarAnswer = wizardAnswer(kind, path))} />
          {#if calendarView.continueWithout}
            <div class="buttons">
              <button type="button" disabled={calendarView.continueWithoutDisabled} onclick={continueWithoutCalendar}>{CONTINUE_WITHOUT_BUTTON}</button>
            </div>
          {/if}
          {#if calendarView.controls}
            <CalendarSettings {os} mode="wizard" />
          {/if}
        {/if}
      </div>
    {/if}
  {:else}
    <div class="body">
      {#if saved !== null}
        <p class="ok">
          {saved.kind === "created"
            ? "Your configuration was created"
            : saved.kind === "saved"
              ? "Your configuration was saved"
              : "Your configuration is unchanged"}{doc !== null ? ` at ${doc.path}` : ""}.
        </p>
      {/if}
      {#if judgeChanged}
        <p class="muted small">{JUDGE_LINE}</p>
      {/if}
      <!-- Keyed by INDEX (round 3, D3-L3): two notes can share a field and message — the engine
           redacts every note before it reaches here (`src/json.ts`, `redactNote`), and two
           different texts can redact alike — and a duplicate each-key is a Svelte runtime error,
           not a render quirk. -->
      {#each saveWarnings as warning, i (i)}
        <p class="warn-text">{warning.field !== "" ? `${warning.field}: ` : ""}{warning.message}</p>
      {/each}

      <div class="block">
        <h3>Provider check</h3>
        {#if providerCheckError !== null}
          <pre class="bad">{providerCheckError}</pre>
        {:else if providerCheck === null}
          <p class="muted">Asking the engine…</p>
        {:else}
          {@const payload = providerCheck.payload as {
            provider?: { cli?: string; found?: boolean; path?: string | null;
              anomalies?: string[]; notes?: string[] };
            discoveredCount?: number; reposTimedOut?: boolean; verdict?: string;
            repos?: { path: string; partialClone?: true; notes?: string[] }[];
          } | null}
          {#if payload?.provider !== undefined}
            <p>
              {payload.provider.found
                ? `The engine can reach your provider (${payload.provider.cli ?? ""}${payload.provider.path ? ` at ${payload.provider.path}` : ""}).`
                : `The engine could NOT find your provider (${payload.provider.cli ?? ""}). The briefing will fail until it is installed or the Settings screen points at it.`}
            </p>
            {#each payload.provider.anomalies ?? [] as anomaly (anomaly)}
              <p class="warn-text">{anomaly}</p>
            {/each}
            {#each payload.provider.notes ?? [] as note (note)}
              <p class="muted small">{note}</p>
            {/each}
            <p class="muted small">
              {payload.reposTimedOut
                ? "The repository scan ran out of time; the count is incomplete."
                : `Repositories found by scanning: ${payload.discoveredCount ?? 0}.`}
              {payload.verdict !== undefined ? ` Engine verdict: ${payload.verdict}.` : ""}
            </p>
          {:else}
            <p class="muted">The engine's health check did not include a provider report.</p>
          {/if}
          <!-- Per-repo notes (today only the partial-clone one), the engine's sentence verbatim after
               the repo's path; an older engine sends none. Unkeyed: the rows carry no identity. -->
          {#each doctorRepoNotes(payload?.repos) as row}
            <p class="muted small">{row.path}: {row.note}</p>
          {/each}
        {/if}
      </div>

      <div class="block">
        <h3>Background delivery</h3>
        <p>
          This installs the scheduler that generates your briefing every morning without the app
          being open. Installing runs a first check right away — that live run is the test that
          the delivery path works.
        </p>
        <ScheduleInstall
          label="Install background delivery"
          purpose="install the background scheduler"
          owner={engineOwner}
          onfinished={() => (verifyTrigger += 1)}
          onbusy={(busy) => (installBusy = busy)}
        />
        {#if engineOwner === "cli"}
          <p class="muted small">
            A command-line install already owns the schedule. Keeping it is fine — this app then
            shows its state without changing it, and whether a notification comes from the engine
            depends on the engine's own notification setting{notify !== null
              ? ` — ${engineNotifyLine(notify.engine)}`
              : "."}
          </p>
        {/if}
        <ScheduleVerify {evidence} trigger={verifyTrigger} suspended={!shown} onbusy={(busy) => (verifyInFlight = busy)} />
      </div>

      <div class="block">
        <h3>Start at login</h3>
        <label class="choice">
          <input type="checkbox" checked={loginItemChecked(loginDefault, loginChoice)}
            onchange={(e) => (loginChoice = e.currentTarget.checked)} />
          <span>
            <strong>Start Daily Briefing at login.</strong> The app opens in the background when
            you log in, so it is there to show and announce each morning's briefing. It is applied
            when you press Finish, and you can change it any time under Settings › This app.
          </span>
        </label>
        {#if loginItemNote(loginDefault, loginChoice) !== null}
          <p class="muted small">{loginItemNote(loginDefault, loginChoice)}</p>
        {/if}
        {#if loginItemError !== null}
          <p class="bad">{loginItemError}</p>
        {/if}
      </div>

      {#if notifyAsk}
        <div class="block notify-ask">
          <p>{notifyAskExplanation(os)}</p>
          <div class="buttons">
            <button type="button" onclick={() => onnotifychoice(true)}>Enable notifications</button>
            <button type="button" onclick={() => onnotifychoice(false)}>Not now</button>
          </div>
          {#if notifyAskError !== null}
            <p class="bad">Your choice could not be recorded: {notifyAskError}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if blocker !== null}
    <p class="muted small">{blocker}</p>
  {/if}
  {#if saveFailure !== null && step === "floor"}
    <pre class="bad">{saveFailure}</pre>
  {/if}
  {#if recovered && step === "floor"}
    <div class="block">
      <p>
        A configuration appeared on disk while you were setting up — nothing was replaced. The
        steps now show what that file says; what you had entered here was set aside so your next
        save edits the real file and keeps everything it does not change.
      </p>
      <label class="choice">
        <input type="checkbox" checked={recoverAck}
          onchange={(e) => (recoverAck = e.currentTarget.checked)} />
        <span>Continue with the loaded configuration — I have looked over the steps again.</span>
      </label>
    </div>
  {/if}
  {#if gateBlocker !== null && step === "floor"}
    <p class="muted small">{gateBlocker}</p>
  {/if}
  <!-- Keyed by index, like `saveWarnings` above: an error list can repeat a field + message too. -->
  {#each saveErrors as error, i (i)}
    <pre class="bad">{error.field !== "" ? `${error.field}: ` : ""}{error.message}</pre>
  {/each}

  <div class="nav-row">
    {#if nav.setUpLater.shown}
      <button class="quiet" disabled={nav.setUpLater.disabled} onclick={() => { releaseIfUnused("leave"); oncancel(); }}>Set up later</button>
    {/if}
    {#if nav.finishLater.shown}
      <button class="quiet" disabled={nav.finishLater.disabled} onclick={finishLater}>Finish setup later</button>
    {/if}
    {#if nav.back.shown}
      <button class="quiet" disabled={nav.back.disabled} onclick={() => {
        if (step === "provider") releaseIfUnused("back");
        step = previousStep(step, accessInScope) ?? "welcome";
        if (step === "calendar") calendarEntryPending = true;
      }}>
        Back
      </button>
    {/if}
    {#if step === "repos"}
      <button disabled={blocker !== null || accessLoading} onclick={() => void continueFromRepos()}>
        {accessLoading ? "Checking folders…" : "Continue"}
      </button>
    {:else if step === "floor"}
      <button disabled={blocker !== null || gateBlocker !== null || saving}
        onclick={() => void saveAndContinue()}>
        {saving
          ? "Saving…"
          : doc !== null && doc.exists
            ? "Save configuration & continue"
            : "Create configuration & continue"}
      </button>
    {:else if step === "delivery"}
      <button disabled={nav.finish.disabled || loginPlan.kind === "wait"} onclick={() => void finish()}>
        {finishing ? "Finishing…" : "Finish"}
      </button>
    {:else}
      <button disabled={blocker !== null || keyBusy || calendarHold}
        onclick={() => {
          if (step === "provider") releaseIfUnused("continue");
          step = nextStep(step, accessInScope) ?? step;
        }}>
        Continue
      </button>
    {/if}
  </div>
  {#if step === "delivery"}
    <p class="muted small">You can install background delivery any time from the Schedule screen.</p>
  {/if}
</section>

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 44rem;
  }
  .head h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  .head p {
    margin: 0.2rem 0 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .body p,
  .body ul {
    margin: 0;
  }
  .body ul {
    padding-left: 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .block {
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.9rem 1rem;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .block h3,
  .step-title {
    margin: 0;
    font-size: 1rem;
  }
  .choice {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
  }
  .choice input {
    margin-top: 0.25rem;
  }
  .indent {
    margin-left: 1.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field span,
  .field > label {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .field input,
  .field textarea {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
  }
  .first-wake {
    font-weight: 600;
  }
  .nav-row,
  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button.quiet,
  .buttons button {
    background: var(--panel);
    color: inherit;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.85rem;
  }
  .ok {
    color: var(--muted);
  }
  .warn-text {
    color: var(--danger);
  }
  pre {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    white-space: pre-wrap;
    font-size: 0.82rem;
  }
  pre.bad,
  p.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  p.bad {
    margin: 0;
  }
  .notify-ask {
    border-color: var(--accent);
  }
</style>
