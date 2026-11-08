<script lang="ts">
  /**
   * T15 — the Settings screen: the engine's config, as a form and in the JSON editor (Advanced's "Edit settings as
   * JSON"), saved through ONE path (`config_save`, `src-tauri/src/config_save.rs`).
   *
   * ⚠ THE FORM AND THE JSON EDITOR SEND THE SAME THING — JSON TEXT, plus the `base` token from the load. Rust decides
   * where it goes (`status --json`'s `paths.configPath`, never this app's own config directory),
   * refuses a `transcripts` change and a new literal API key from either one, has the ENGINE
   * validate it (errors block, warnings do not), and replaces the file atomically with a `.bak`.
   * Nothing here validates a config: a second validator is the drift the engine's
   * `config validate` exists to prevent.
   *
   * ⚠ IT EDITS AN EXISTING CONFIG. With no config file it points at the first-run wizard (B8's
   * `config_create` path — or `daily-briefing init` in a terminal) — unless an Uninstall removed the
   * settings in this app session, whose latch refuses that path too (M9 LOW pass, L1); with one that
   * is not JSON it says so and changes nothing.
   *
   * ⚠ AN UNSAVED EDIT SURVIVES LEAVING THE SCREEN. Switching to another screen unmounts this one;
   * a changed draft (or raw text) is kept in memory (`keepSettings`) and restored on return, with a
   * line saying so. A webview reload or an app restart starts from the file. The kept draft keeps
   * its `base` token, so a file that changed meanwhile is still refused as a conflict. A draft kept
   * while its own save was in flight is dropped when that save lands (`keptAfterSave`).
   *
   * Directory fields are plain text: `tauri-plugin-dialog` is not a dependency of this build
   * (docs/gui-seam.md §10). Copy and paste in these inputs rely on the macOS app menu's Edit
   * submenu, which `shell::app_menu_spec` keeps.
   *
   * v0.3.0 (plan M9): the Calendar panel (`lib/CalendarSettings.svelte`) writes the config's
   * `calendar` block through its own Rust command (`calendar_config_save`, no `base` token: a one-key
   * edit of the file as it is now). After each such write (and General's engine-notify offer) this screen RELOADS
   * the file — post-cap (R5-H1): at once when the form and the JSON editor hold no unsaved edit, a field still
   * showing a refused value keeping its mark, its error and its text (`backgroundReload`); while an unsaved edit is
   * on screen or a save runs, the reload is OWED and runs as soon as the draft is clean again (a save landed, a
   * Discard, or edits that bring it back to the file) — never while the JSON editor is open (final small fix, F3): it
   * runs when the editor is left. A save from an unsaved edit over a changed file is refused as a conflict and says so,
   * exactly as for any other outside change.
   *
   * Post-cap (R5-M2, pre-existing on main): an edit typed in the form while a save is in flight survives its landing —
   * the reload refreshes the document and keeps the edit, unsaved against the new file (`afterLanded`). A value the
   * form refused meanwhile (never in the draft) keeps its text, its mark and its error: the reload after a landed save
   * draws no field again and clears no error (final small fix, F1: `loadResets`). The JSON editor cannot be typed in
   * while a save is in flight — it is read-only then, with a line saying why (F2: `jsonEditorReadOnly`) — so nothing
   * typed there can be lost or undo the save.
   *
   * P3-M4-T1 — "Providers, in order" (`lib/ProvidersList.svelte`, its model in `lib/settings-model.ts`):
   *  - the rows' statuses are `status --json`'s `providers`, read with the update panel's status and again after every
   *    save, Test and Reset;
   *  - ⚠ THE SAVE GATE: before `configSave`, from the form or the JSON editor, the candidate is validated through
   *    `providerCandidateCheck(text, "validate")`, and the save is refused only for a STRUCTURAL `provider.accounts`
   *    warning ("— account failover disabled"); advisory warnings save (Q4). A check that cannot answer refuses;
   *  - a save that landed and changed `provider` shows the judge line (`JUDGE_LINE`);
   *  - the one-time network-check question (default yes) rides on the form's next save while an entry was added and
   *    `networkProbeHosts` is `[]`;
   *  - Test validates the DRAFT and tests its entry with that row's `testTimeoutMs`; Reset uses the SAVED index, and is
   *    disabled while the list has unsaved edits.
   *
   * P3-M4-T2 — Add and Remove with keys (`lib/provider-flows.ts`):
   *  - Add stores the pasted key (`key set`), tests the draft plus the new entry, and on Save sends that candidate
   *    through `submit` — the one save path, gate included — as `addSaveDecision` says (field errors refuse, an edited
   *    draft tests again). Discard deletes the unused key (once the saved settings show nothing uses it); so does
   *    "Discard changes" while an add waits, and leaving the screen: `leaveAdd` removes a waiting add's key at once,
   *    and an add whose `key set` or Save is still running (`addSteps.running`) removes it when that step ends unless
   *    its save landed (`orphanAfter`). "Discard changes" while a step of the add runs ends the add (`FlowSteps`): the
   *    step then removes the key as if the screen were left, and puts nothing back on screen. The network-check
   *    question rides on the add's Save when the engine says the added entry is remote (its candidate row
   *    `loopback: false`);
   *  - Remove edits the draft (P3-M4-T1) and remembers the label; the next save that lands without it reads the SAVED
   *    rows' `appKeyId` before the save and deletes a key only when the new rows reference it nowhere
   *    (`saveRemovingKeys`, in `submit`). The Save's outcome and reload come as soon as it lands; the deletes run on
   *    after it (a busy one retried), their lines added when they arrive (PR 3 final r2).
   *  - "key moved — add a key" is the SAVED config's `config validate` rows' `keyMoved` (`refreshSavedRows`, read on
   *    every load, a save's included), never a match on the entry's text: the app keeps no copy of the sentinel.
   *
   * P3-M4-T3 — Replace key (`lib/provider-flows.ts`, the store in `src-tauri/src/pending_resets.rs`):
   *  - "Replace key" on a saved API row stores the NEW key (`key set`) and tests the draft with that entry switched to
   *    it (`startReplace`); its Save runs `saveReplace` — the pre-save reset (`provider_pending_reset_add`), retried
   *    every 15 s while a briefing holds the run lock (the row shows `REPLACE_WAITING_LINE`), then `submit` (the one
   *    save path, gate included), then the post-save reset (`provider_pending_reset_flush`). The old key id is never
   *    deleted.
   *  - Discard, "Discard changes" and leaving the screen go through `discardReplace`, which AWAITS any save of the
   *    replacement still running before `provider_pending_reset_drop` (hub Q21) — drop then keeps the key if the saved
   *    settings use it. A wait is cancelled at once (`replaceWake`), not after its 15 s. Discard ends the replacement
   *    (`FlowSteps`): a step of it still running (a Test again, its start or Save) puts nothing back on screen when it
   *    ends, so a discarded replacement — whose key drop may have deleted — can never be saved.
   *
   * P3-M4-T4 — a key written in the settings file (`lib/provider-flows.ts` `migrateLiteral`, `removeWrittenKey`):
   *  - "Move this key to the Keychain" runs `key migrate` on the SAVED index, compares its `revision` with the row shown,
   *    and saves ONLY the literal removed and the reference added through `submit` (the one save path, gate included),
   *    then `key scrub-backup`. When a source of the user's own holds the reference's slot, the row offers "Remove the
   *    key written in settings" instead (confirmed on the row), saved the same way. Both are refused while the draft
   *    holds any unsaved edit (the save would carry it, and the reload after it would lose it).
   *  - The scrub on open is App's (`App.svelte`), whatever screen is shown.
   *  - An add's Test again that is running when the screen is left removes its key when it ENDS (`orphanAfter`), not
   *    beside it: the Test holds the engine, and a `key delete` then would be refused busy (P3-M4-T3 fix pass LOW).
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import {
    configRead,
    configSave,
    describeFailure,
    readLatestBriefing,
    settingsSaveRefusal,
    type ConfigDocument,
    type SaveOutcome,
  } from "../lib/files";
  import {
    afterLanded,
    applyNetworkAnswer,
    formSubmission,
    isDirty,
    judgeLineFor,
    keepSettings,
    markNetworkAsked,
    moveProvider,
    NETWORK_ASK,
    networkAsked,
    networkAskNeeded,
    keyStoreName,
    parseDraft,
    parseStatusProviders,
    providersView,
    rawFromDraft,
    removeProvider,
    removeStoredApiKey,
    resetResultLine,
    saveGate,
    saveGateFailure,
    setLoginFolder,
    settleKeptSettings,
    takeKeptSettings,
    testFailureLine,
    testPlan,
    testAllInTurn,
    testResultLines,
    useDefault,
    useEmptyList,
    writeField,
    writeNotifyCommand,
    type ConfigPage,
    type Draft,
    type Edit,
    type Field,
    type SaveGate,
    type SentSave,
    type StatusProviderRow,
  } from "../lib/settings-model";
  import SaveBar from "../lib/settings/SaveBar.svelte";
  import PrefsRows from "../lib/settings/PrefsRows.svelte";
  import SettingsPages from "../lib/settings/SettingsPages.svelte";
  import {
    attentionPages,
    backgroundReloadApplies,
    blockedPages,
    changedPages,
    configLoadFailed,
    configState,
    hasOutcome,
    initialPage,
    jsonEditorReadOnly,
    lastShownReport,
    loadResets,
    navigate,
    nextReveal,
    NO_REVEAL,
    owedAfterLoad,
    owedReloadRuns,
    revealFor,
    rememberedPage,
    rememberPage,
    rememberShownReport,
    NO_REDRAW,
    redrawAfterDefault,
    redrawAfterReset,
    saveBarShown,
    writtenBy,
    firstRowLabel,
    NO_TOOL_ROWS,
    fieldEdited,
    TOOL_FIELD_IDS,
    noteStamp,
    toolRowsAfter,
    toolRowsAfterSave,
    toolRowsDrawn,
    type ToolRows,
    type ChangeInput,
    type PageId,
    type Pressed,
    type Redraw,
    type Reveal,
    type RevealAction,
    type ScreenStamp,
  } from "../lib/settings/pages";
  import { editorLinksLive, type EditorLinksState } from "../lib/actions-live";
  import { setGithubLinks } from "../lib/app-prefs-store";
  import {
    editorChoiceSet,
    editorList,
    providerCandidateCheck,
    providerReset,
    status,
    updateCheck,
    type ProviderValidateRow,
    type UpdateCheckResult,
  } from "../lib/engine";
  import {
    addRequestFrom,
    addSaveDecision,
    discardAdd,
    leaveAdd,
    loginSource,
    networkAskFor,
    orphanAfter,
    retestAdd,
    saveRemovingKeys,
    startAdd,
    type AddForm,
    type AddHandlers,
    type AddRequest,
    type AddRunning,
    type PendingAdd,
    FlowSteps,
    discardReplace,
    leaveReplace,
    replaceOffered,
    replaceOrphanAfter,
    replacePendingNotes,
    retestReplace,
    saveReplace,
    startReplace,
    literalGuards,
    migrateLiteral,
    removeWrittenKey,
    type LiteralDeps,
    type LiteralScreen,
    type LiteralResult,
    type LiteralTarget,
    type PendingReplace,
    type ReplaceHandlers,
    type ReplaceRunning,
    type ReplaceSaveResult,
  } from "../lib/provider-flows";
  import { stripControl } from "../lib/briefing-struct";
  import { parseUpdateResult, updateFromStatus } from "../lib/update-check";
  import { summaryStatusFromStatus, type SummaryStatus } from "../lib/today";
  import {
    autostartIsEnabled,
    notifyStatus,
    type NotifyStatus,
  } from "../lib/notify";
  import type { Os } from "../lib/platform";
  import type { UninstallReport } from "../lib/app-uninstall";

  interface Props {
    onconfigsaved: () => Promise<void>;
    /** v0.2.1 §3.5: the OS this window runs on (App's `osFromUserAgent`), handed down to the app's own controls
     *  on General (the notification ask's wording) and Advanced (the Terminal command's refusals). REQUIRED, with no
     *  default, so a mount that forgets it fails `svelte-check` instead of silently getting one platform's wording. */
    os: Os;
    /** M9 round 3: the Uninstall execute's report and in-flight state, held by App so they outlive this
     *  screen (`App.svelte`), and its start and end — passed straight through to About's Uninstall panel. M9
     *  LOW pass (L5): REQUIRED, with no default, like `os`. */
    uninstallReport: UninstallReport | null;
    uninstallRunning: boolean;
    onuninstallstarted: () => void;
    onuninstallended: (report: UninstallReport | null) => void;
    /** M9 LOW pass (L1): an Uninstall in this app session removed `config.json` (App latches it for the
     *  session, as Rust's "settings removed" latch is never cleared), so every settings write — the Setup
     *  wizard's `config_create` included — is refused until the app restarts, and the no-config sentence says
     *  what still works instead of pointing at Setup. REQUIRED, with no default. */
    settingsRemovedByUninstall: boolean;
  }
  let {
    onconfigsaved,
    os,
    uninstallReport,
    uninstallRunning,
    onuninstallstarted,
    onuninstallended,
    settingsRemovedByUninstall,
  }: Props = $props();

  /** B7 (T18/T19): the app's own controls' state (General's "This app") — the notification opt-in and the REAL autostart
   *  state (`is_enabled()`, re-fetched after every change; never a cached boolean). */
  let appNotify = $state<NotifyStatus | null>(null);
  let appNotifyError = $state("");
  let appAutostart = $state<boolean | null>(null);
  let appAutostartError = $state("");

  async function loadApp(): Promise<void> {
    try {
      appNotify = await notifyStatus();
      appNotifyError = "";
    } catch (e) {
      appNotify = null;
      appNotifyError = describeFailure(e);
    }
    try {
      appAutostart = await autostartIsEnabled();
      appAutostartError = "";
    } catch (e) {
      appAutostart = null;
      appAutostartError = describeFailure(e);
    }
  }

  /** Phase E (E12): the update panel's state. `status --json` supplies the LAST recorded answer on
   *  mount (a pure read, no network); "Check now" replaces it with a fresh one. */
  let update = $state<UpdateCheckResult | null>(null);
  let updateLoading = $state(true);
  let updateChecking = $state(false);
  let updateError = $state("");
  /** A2 (Q-L9): General's AI summaries line, from this screen's own `status --json`, not App's ordered driver. */
  let aiSummaryStatus = $state<SummaryStatus>({ enabled: false, warnings: [] });

  async function loadUpdate(): Promise<void> {
    try {
      const report = await status();
      update = updateFromStatus(report);
      // A null payload says nothing about the setting, so the line already drawn stays.
      if (report.payload !== null) aiSummaryStatus = summaryStatusFromStatus(report.payload);
      // P3-M4-T1: the same `status --json` carries the providers' rows.
      providerRows = parseStatusProviders(report.payload);
      providersNow = new Date();
      void readLatestPage(report.payload);
      updateError = "";
    } catch (e) {
      updateError = describeFailure(e);
    } finally {
      updateLoading = false;
    }
  }

  /** THE ONE CALL SITE of `updateCheck()` in this webview — the "Check now" button. Nothing calls it
   *  on mount, on a timer or from the wizard. Not gated on a run being in flight: Rust admits it
   *  regardless (`Operation::UpdateCheck` takes no in-flight guard). */
  async function checkNow(): Promise<void> {
    if (updateChecking) return;
    updateChecking = true;
    updateError = "";
    try {
      const outcome = await updateCheck();
      const result = parseUpdateResult(outcome.payload);
      if (result === null) {
        const exit = outcome.exitCode === null ? "killed by a signal" : `exit ${outcome.exitCode}`;
        updateError = `The engine did not return an update-check result (${exit}).${outcome.stderr.trim() !== "" ? `\n${outcome.stderr.trim()}` : ""}`;
      } else {
        update = result;
      }
    } catch (e) {
      updateError = describeFailure(e);
    } finally {
      updateChecking = false;
    }
  }

  let doc = $state<ConfigDocument | null>(null);
  let loadFailure = $state("");
  let tab = $state<"form" | "raw">("form");
  let draft = $state<Draft | null>(null);
  let raw = $state("");
  let errors = $state<Record<string, string>>({});
  /** Round 9 (L6): per path, the page whose field last wrote it (`writtenBy`), so the unsaved dots follow the page the
   *  user edited on — kept FOR THE DRAFT IT WAS WRITTEN INTO (`for`): a new draft (a load, the JSON editor left, a kept
   *  edit restored) reads none of it. */
  let written = $state.raw<{ for: Draft | null; on: Record<string, ConfigPage> }>({ for: null, on: {} });
  let outcome = $state<SaveOutcome | null>(null);
  let failure = $state("");
  let saving = $state(false);
  /** True when this mount restored an unsaved edit from an earlier visit to the screen. */
  let restored = $state(false);

  /* ── Redesign D: the pages ── */
  /** The open page: the one last opened in this session (General if none) until the mount decides (`openInitial`). */
  let page = $state<PageId>(rememberedPage() ?? "general");
  /** Editor & links' driver, one per mount (P-M8). Every page is mounted, hidden or not, so mounting is not opening: this
   *  one effect covers both assignments of `page` (`openPage`, `openInitial`) and a mount on the remembered page (Q-L5). */
  const editorLinks = untrack(() => editorLinksLive({ os, editorList, editorChoiceSet, setGithubLinks, publish: (s) => (editorLinksState = s) }));
  let editorLinksState = $state.raw<EditorLinksState>(editorLinks.state());
  $effect(() => { if (page === "editor") untrack(() => editorLinks.open()); });
  onDestroy(() => editorLinks.dispose());
  /** The Calendar panel's last status summary (`onstatus`), or `null` before it reported. */
  let calendarOk = $state<boolean | null>(null);
  /** Final round 1 (H1), final rounds 3 and 4 (R3-M2, R4-M1, R4-M2): which fields may show something the draft does
   *  not hold — a value the form refused (never written into the draft; Svelte does not rewrite an input whose value
   *  prop did not change) — and, per field, how often it was drawn again (`settings/pages.ts`). Marked in `onfield`
   *  (unmarked there when a value is taken, and by the engine-default toggle, which draws its list again at once);
   *  where the user resets the errors (Discard, Reload, after a save, a left JSON editor) only the marked fields are
   *  drawn again, and a background reload (post-cap, R5-H1) keeps the marks and errors as they are and draws no field
   *  again, so a field the user types in keeps its input. */
  let redraw = $state.raw<Redraw>(NO_REDRAW);
  /** Round 10 (M1): row 1's tool rows — the row 1 they are drawn for, whether "Other…" is chosen on it and (round 11,
   *  M1) the note a refused tool value left (`fieldEdited`: never an error). ONE rule (`toolRowsAfter`): when another
   *  provider becomes row 1 — whatever made it so: a move, a removal, a load, a reload of a changed file — the Other
   *  choice and the note reset, with every row 1 field's error and marked input (round 11, L2), here and nowhere else;
   *  an edit that keeps row 1 (its login folder, a backup moved, a reload of the same file) keeps them. The user's load
   *  and a landed save (`load`) close Other and drop the note too — round 12 (M1): a landed save keeps a note born in the
   *  gesture that sent it. Round 12 (L1): the note also goes when its control stops being drawn, or row 1's logins change
   *  (`toolRowsDrawn`, the second effect below). */
  let toolRows = $state.raw<ToolRows>(NO_TOOL_ROWS);
  /** Round 11 (M1): the focus is in one of row 1's tool controls (the Tool choice, Other's command or arguments). */
  const typingInToolRows = (): boolean => TOOL_FIELD_IDS.some((id) => document.activeElement?.id === `f-${id}`);
  const rowOne = $derived(firstRowLabel(draft));
  $effect.pre(() => {
    const label = rowOne;
    untrack(() => {
      const next = toolRowsAfter(toolRows, label, errors, redraw);
      if (next === null) return;
      toolRows = next.rows;
      errors = next.errors;
      redraw = next.redraw;
    });
  });
  /** Round 12 (L1): the note goes when its control stops being drawn, or row 1's logins change (`toolRowsDrawn`). */
  $effect.pre(() => {
    const kept = toolRowsDrawn(draft, toolRows);
    if (kept !== toolRows) untrack(() => (toolRows = kept));
  });
  /** Round 12 (M1): the user's gestures, counted — every pointer press and key press, in the capture phase, so before
   *  the focus moves and a field's `change` fires. A note is stamped with the gesture it was born in, and a save with
   *  the gesture that pressed it (`toolRowsAfterSave`). Not state: nothing is drawn from it. */
  let gesture = 0;
  const gestured = (): void => {
    gesture += 1;
  };
  /** M1: a page change the user made in the sidebar moves focus to the new page's title; false until then, so opening
   *  the screen does not pull focus into it, and false after the bar's "fix the marked fields on …", whose reveal
   *  focuses the first marked field instead (final round 4, R4-M7). */
  let pageFocus = $state(false);
  /** Final round 3: where the result of the user's last action is shown (`settings/pages.ts` `Reveal`, acted on by
   *  SettingsPages). Asked only by `requestReveal`, from the user's actions — never a background reload. */
  let reveal = $state.raw<Reveal>(NO_REVEAL);

  /* ── P3-M4-T1: "Providers, in order" ── */
  /** `status --json`'s provider rows; `null` while unread or unavailable. */
  let providerRows = $state<StatusProviderRow[] | null>(null);
  let providersNow = $state(new Date());
  let providerTesting = $state<string | null>(null);
  let providerResetting = $state<string | null>(null);
  /** User-directed 2026-10-22 (P-A): Test all is running (each row's own Test, one after another). */
  let providerTestingAll = $state(false);
  /** P-A: the latest page and its write time, for "Today's briefing" above the list (`todaysBriefing`). */
  let latestPage = $state<string | null>(null);
  let latestMtime = $state<string | null>(null);
  /** P3-M4-T4: the label whose written key is being moved or removed, if any. */
  let providerMigrating = $state<string | null>(null);
  /** Per label, what its last Test or Reset answered. */
  let providerResults = $state<Record<string, string[]>>({});
  /** Why the last list edit was refused, or "". */
  let providersMessage = $state("");
  /** The network-check question's answer; it defaults to yes (spec §6). */
  let networkYes = $state(NETWORK_ASK.defaultYes);
  /** `JUDGE_LINE` after a save that landed and changed `provider`, else `null`. */
  let judgeLine = $state<string | null>(null);

  /** P3-M4-T2 checkpoint: the SAVED config's `config validate` rows — "key moved" is their `keyMoved` — with the text
   *  they were read for, so rows for an older text are never shown against a newer one. */
  let savedValidate = $state<{ text: string; rows: ProviderValidateRow[] | null } | null>(null);
  async function refreshSavedRows(text: string | null): Promise<void> {
    if (text === null) {
      savedValidate = null;
      return;
    }
    let rows: ProviderValidateRow[] | null = null;
    try {
      const check = await providerCandidateCheck(text, "validate");
      rows = check.kind === "validated" ? check.report.providers : null;
    } catch {
      rows = null;
    }
    // A late answer for a text no longer loaded is dropped (a newer load has asked for its own).
    if (doc?.text === text) savedValidate = { text, rows };
  }

  /** P3-M4-T3: the replacement in progress, on its row: its lines, whether it waits on a run, and what is pending. */
  let replacing = $state<{ label: string; busy: boolean; waiting: boolean; lines: string[]; pending: PendingReplace | null } | null>(null);
  /** P3-M4-T2: the add in progress: its lines, and the add waiting for Save / Save anyway / Test again / Discard
   *  (declared here, before the providers view that reads it). */
  let adding = $state<{ busy: boolean; lines: string[]; pending: PendingAdd | null } | null>(null);

  const providers = $derived(
    draft === null
      ? undefined
      : providersView({
          draft,
          savedText: doc?.text ?? null,
          rows: providerRows,
          validateRows: savedValidate !== null && savedValidate.text === doc?.text ? savedValidate.rows : null,
          now: providersNow,
          // PR 3 final r4 (H1): what makes the screen busy, handed to the view, which decides `busy` once.
          saving,
          adding: adding !== null,
          replacing: replacing?.label ?? null,
          testing: providerTesting,
          resetting: providerResetting,
          testingAll: providerTestingAll,
          latestPage: latestPage,
          latestMtime: latestMtime,
          results: providerResults,
          pending: replacePendingNotes(replacing?.label ?? null, replacing?.waiting === true),
          os,
          migrating: providerMigrating,
        }),
  );
  /** The view's busy state (H1) — the one answer to "may another step start?" for Replace key and the written-key
   *  actions, as for the list's controls. No list (no draft, or one that cannot be read) counts as busy. */
  const providersBusy = $derived(providers?.readable !== true || providers.busy);
  /** The form save's text the network-check question is on screen for, or `null`. Set by `saveForm` when
   *  `networkAskFor` — the engine's rows for that very text — says an added entry is remote; the next Save of the same
   *  text applies the answer. (The form only, `tab === "form"`: an answer edits the draft.) */
  let askNetworkFor = $state<string | null>(null);
  const askNetwork = $derived(tab === "form" && draft !== null && askNetworkFor !== null);

  /** Redesign D: the provider flow in progress — an Add or a Replace, running or waiting for its own Save or Discard
   *  (M4: the same rule for both; a refused Replace that shows only its Close is not pending) — which the bar names. */
  const pendingFlow = $derived<"add" | "replace" | null>(
    adding !== null && (adding.busy || adding.pending !== null) ? "add" : replacing !== null && (replacing.busy || replacing.pending !== null) ? "replace" : null,
  );
  const flowPending = $derived(pendingFlow !== null);
  /** What the page logic reads (`settings/pages.ts`): the config as loaded, the draft, the JSON text and the tab. */
  const changeInput = $derived<ChangeInput>({ tab, loadedText: doc?.text ?? null, draft, raw, flowPending, writtenOn: written.for !== null && written.for === draft ? written.on : undefined });
  const changed = $derived(changedPages(changeInput));
  /** The config's state as the pages draw it (the same function SettingsPages reads): the editor is drawn only when
   *  it is ready, which is what a page change is told. */
  const config = $derived(configState(loadFailure, doc, draft));
  /** L1: while the JSON editor is open its Save never reads the form's errors, so they neither mark a page nor block. */
  /** The pages holding a save-blocking field (none while the editor is open: L1), for the bar and for `reveal`. */
  const blocked = $derived(tab === "raw" ? [] : blockedPages(draft, errors));
  const attention = $derived(
    attentionPages({ providers: providers ?? null, calendarOk, loadFailed: configLoadFailed(loadFailure, doc, draft), draft, errors: tab === "raw" ? {} : errors }),
  );

  /* ── P3-M4-T2: Add and Remove with keys ── */
  /** The draft the pending add was tested on, as text: a Save after the draft changed tests again first. */
  let addBase = "";
  /** The add's steps, and which is running now: leaving the screen hands the add's key to it (`leaveAdd`,
   *  `orphanAfter`); "Discard changes" ends the add, so a step ending after it puts nothing back. */
  const addSteps = new FlowSteps<Exclude<AddRunning, "none">>();
  /** The screen was left (`onDestroy`): a step still running owns its add's key from then on. */
  let left = false;
  /** The entry another login would copy (a Claude command-line tool only), or `null`. */
  const login = $derived(draft === null ? null : loginSource(draft));
  /** Labels removed with Remove since the last load: their keys are looked at after the save that drops them. */
  let removedLabels = $state<string[]>([]);
  /** What happened to removed providers' keys, or to a discarded add's key. */
  let keyLines = $state<string[]>([]);
  /** Ask about the network check on the add's Save? Only when the engine says the added entry is remote. */
  const askNetworkAdd = $derived(
    adding?.pending != null &&
      networkAskNeeded(doc?.text ?? null, parseDraft(adding.pending.text), networkAsked(), adding.pending.rows),
  );
  const addHandlers = $derived<AddHandlers>({
    onadd: (form, key) => onprovideradd(form, key),
    adding:
      adding === null
        ? null
        : {
            busy: adding.busy,
            saving,
            lines: adding.lines,
            pending: adding.pending === null ? null : { passed: adding.pending.passed, ran: adding.pending.ran },
          },
    loginOf: login === null ? null : stripControl(login.label),
    onaddsave: () => void onprovideraddsave(),
    onaddretest: () => void onprovideraddretest(),
    onadddiscard: () => void onprovideradddiscard(),
    onaddclose: () => (adding = null),
  });

  /* ── P3-M4-T3: Replace key ── */
  /** The draft the pending replacement was tested on, as text. */
  let replaceBase = "";
  /** The replacement's steps, and which is running now (`leaveReplace`, `replaceOrphanAfter`); Discard ends the
   *  replacement, so a step ending after it puts nothing back. */
  const replaceSteps = new FlowSteps<Exclude<ReplaceRunning, "none">>();
  /** The replacement's Save while it runs: Discard awaits it before `drop` (hub Q21). A `$state` (final small fix, F2):
   *  the JSON editor is read-only while it runs (`jsonReadOnly`). */
  let replaceSaving = $state.raw<Promise<ReplaceSaveResult> | null>(null);
  /** Final small fix (F2): the JSON editor is read-only while any save is in flight (`jsonEditorReadOnly`). */
  const jsonReadOnly = $derived(jsonEditorReadOnly({ saving, replaceSaving: replaceSaving !== null }));
  /** Discard was pressed (or the screen left): a waiting Save stops before it saves. */
  let replaceCancelled = false;
  /** Ends the current 15 s wait at once (a Discard, or leaving). */
  let replaceWake: (() => void) | null = null;
  const replaceHandlers = $derived<ReplaceHandlers>({
    onreplace: (label, key) => void onproviderreplace(label, key),
    replacing:
      replacing === null
        ? null
        : {
            label: replacing.label,
            busy: replacing.busy,
            waiting: replacing.waiting,
            saving,
            lines: replacing.lines,
            pending: replacing.pending === null ? null : { passed: replacing.pending.passed, ran: replacing.pending.ran },
          },
    replaceable: (row) => replaceOffered(row, providersBusy),
    onreplacesave: () => void onproviderreplacesave(),
    onreplaceretest: () => void onproviderreplaceretest(),
    onreplacediscard: () => void onproviderreplacediscard(),
    onreplaceclose: () => (replacing = null),
  });

  /** Replace key: the key goes to `startReplace` (and from there to `key set` only); nothing here keeps it. */
  async function onproviderreplace(label: string, key: string): Promise<void> {
    if (draft === null || doc === null || adding !== null || replacing !== null) return;
    const base = $state.snapshot(draft) as Draft;
    replacing = { label, busy: true, waiting: false, lines: [], pending: null };
    replaceBase = rawFromDraft(base);
    replaceCancelled = false;
    const ticket = replaceSteps.start("start");
    const step = await startReplace(base, doc.text, label, key, os);
    // Left, or ended meanwhile ("Discard changes"): a key nobody can Discard any more goes to drop.
    const current = replaceSteps.ended(ticket);
    const orphan = replaceOrphanAfter(left || !current, { step });
    if (orphan !== null) {
      void discardReplace(orphan, null);
      return;
    }
    if (!current) return;
    replacing = { label, busy: false, waiting: false, lines: step.lines, pending: step.kind === "tested" ? step.pending : null };
    void refreshProviders();
  }

  async function onproviderreplaceretest(): Promise<void> {
    const r = replacing;
    if (r?.pending == null || r.busy || draft === null) return;
    const base = $state.snapshot(draft) as Draft;
    replacing = { ...r, busy: true, lines: [] };
    const ticket = replaceSteps.start("test");
    const out = await retestReplace(base, r.pending);
    // Discarded meanwhile: that Discard owns the key (drop may have deleted it) — the row never comes back.
    if (!replaceSteps.ended(ticket)) return;
    replaceBase = rawFromDraft(base);
    replacing = { ...r, busy: false, lines: out.lines, pending: out.pending };
    void refreshProviders();
  }

  /** Save, or Save anyway: the tested candidate (as `addSaveDecision` says), through `saveReplace`. */
  async function onproviderreplacesave(): Promise<void> {
    const r = replacing;
    const p = r?.pending;
    if (r == null || p == null || r.busy || saving || doc === null || draft === null) return;
    const next = addSaveDecision({
      draft: $state.snapshot(draft) as Draft,
      testedOn: replaceBase,
      errors: $state.snapshot(errors),
      pending: p,
      askNetwork: false,
      networkYes,
    });
    if (next.kind === "retest") {
      await onproviderreplaceretest();
      return;
    }
    if (next.kind === "refuse") {
      replacing = { ...r, lines: [next.message] };
      return;
    }
    // Final round 4 (R4-M6): where and when the Save was pressed — it may wait 15 s a try on a running briefing, and
    // its outcome is brought into view only if the user is still there and has done nothing since.
    replacing = { ...r, busy: true, lines: [] };
    replaceCancelled = false;
    const pressed: Pressed = { page, at: performance.now() };
    // Final round 3 (R3-M4): whether the one save path ran, so its outcome (and only a fresh one) is brought into view.
    let submitted = false;
    const ticket = replaceSteps.start("save");
    const run = saveReplace(p, next.text, {
      save: (text) => {
        submitted = true;
        return submit(text);
      },
      saving: () => saving,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            replaceWake = null;
            resolve();
          };
          const timer = setTimeout(done, ms);
          replaceWake = done;
        }),
      cancelled: () => left || replaceCancelled,
      current: () => draft !== null && rawFromDraft($state.snapshot(draft) as Draft) === replaceBase,
      waiting: (on) => {
        if (replacing !== null) replacing = { ...replacing, waiting: on };
      },
    });
    replaceSaving = run;
    const result = await run;
    if (replaceSaving === run) replaceSaving = null;
    // Discarded meanwhile: that Discard awaited this save and owns its key.
    if (!replaceSteps.ended(ticket)) return;
    // Left while it ran: a replacement that did not land leaves a key nobody can Discard now.
    const orphan = replaceOrphanAfter(left, { pending: p, result });
    if (orphan !== null) {
      void discardReplace(orphan, null);
      return;
    }
    // Cancelled by Discard: that Discard finishes it.
    if (result.kind === "cancelled") return;
    if (submitted) requestReveal("flow-save", pressed);
    if (result.kind === "notSaved") {
      replacing = { label: p.label, busy: false, waiting: false, lines: result.lines, pending: p };
      return;
    }
    replacing = null;
    keyLines = [...keyLines, ...result.lines];
    void refreshProviders();
  }

  /** Answers the lines it showed (the key's removal), so "Discard changes" can show them again after its reload. */
  async function onproviderreplacediscard(): Promise<string[]> {
    const r = replacing;
    if (r?.pending == null || replaceSteps.running === "discard") return [];
    replacing = { ...r, busy: true, waiting: false };
    replaceCancelled = true;
    replaceWake?.();
    // Every step of this replacement still running ends stale: none of them puts the row back.
    replaceSteps.discard();
    const ticket = replaceSteps.start("discard");
    const lines = await discardReplace(r.pending, replaceSaving);
    keyLines = lines;
    replaceSteps.ended(ticket);
    replacing = null;
    return lines;
  }

  /** Add: the key goes to `startAdd` (and from there to `key set` only); nothing here keeps it. Answers AT ONCE, before
   *  any await, whether the add was taken (PR 3 final r5, A3): a refused request (`addRequestFrom`) is shown and answers
   *  `false`, so the form keeps what was typed, the pasted key included. */
  function onprovideradd(form: AddForm, key: string): boolean {
    if (draft === null || adding !== null || replacing !== null) return false;
    const base = $state.snapshot(draft) as Draft;
    const req = addRequestFrom(base, form);
    if ("error" in req) {
      adding = { busy: false, lines: [req.error], pending: null };
      return false;
    }
    adding = { busy: true, lines: [], pending: null };
    addBase = rawFromDraft(base);
    void runProviderAdd(base, req, form.kind === "login" || form.kind === "cli" ? null : key);
    return true;
  }

  /** The taken add (`onprovideradd`): `startAdd`, then what is waiting — or, left or ended meanwhile, its key removed. */
  async function runProviderAdd(base: Draft, req: AddRequest, key: string | null): Promise<void> {
    const ticket = addSteps.start("start");
    const step = await startAdd(base, req, key, os);
    // Left, or ended meanwhile ("Discard changes"): a key nobody can Discard any more is removed.
    const current = addSteps.ended(ticket);
    const orphan = orphanAfter(left || !current, { step });
    if (orphan !== null) {
      void discardAdd(orphan, os);
      return;
    }
    if (!current) return;
    adding = { busy: false, lines: step.lines, pending: step.kind === "tested" ? step.pending : null };
    void refreshProviders();
  }

  async function onprovideraddretest(): Promise<void> {
    const p = adding?.pending;
    if (p == null || adding?.busy || draft === null) return;
    const base = $state.snapshot(draft) as Draft;
    adding = { busy: true, lines: [], pending: p };
    const ticket = addSteps.start("test");
    const r = await retestAdd(base, p);
    // Left, or ended meanwhile ("Discard changes"): the key goes now that the Test has released the engine.
    const current = addSteps.ended(ticket);
    const orphan = orphanAfter(left || !current, { pending: r.pending, landed: false });
    if (orphan !== null) {
      void discardAdd(orphan, os);
      return;
    }
    addBase = rawFromDraft(base);
    adding = { busy: false, lines: r.lines, pending: r.pending };
    void refreshProviders();
  }

  /** Save, or Save anyway: the tested candidate, through `submit` — as `addSaveDecision` says. */
  async function onprovideraddsave(): Promise<void> {
    const p = adding?.pending;
    if (p == null || adding?.busy || saving || doc === null || draft === null) return;
    const next = addSaveDecision({
      draft: $state.snapshot(draft) as Draft,
      testedOn: addBase,
      errors: $state.snapshot(errors),
      pending: p,
      askNetwork: askNetworkAdd,
      networkYes,
    });
    // The draft was edited after the Test: test the entry again on it, so the Save keeps those edits.
    if (next.kind === "retest") {
      await onprovideraddretest();
      return;
    }
    if (next.kind === "refuse") {
      adding = { busy: false, lines: [next.message], pending: p };
      return;
    }
    // Final round 4 (R4-M6): where and when the Save was pressed, as Replace key's.
    adding = { busy: true, lines: adding?.lines ?? [], pending: p };
    const pressed: Pressed = { page, at: performance.now() };
    const ticket = addSteps.start("save");
    const landed = await submit(next.text, next.asked);
    // Left, or ended meanwhile ("Discard changes"): a save that did not land leaves a key nobody can Discard now.
    const current = addSteps.ended(ticket);
    const orphan = orphanAfter(left || !current, { pending: p, landed });
    if (orphan !== null) {
      void discardAdd(orphan, os);
      return;
    }
    if (!current) return;
    if (landed) adding = null;
    else adding = { busy: false, lines: ["Not saved yet (see why below): Save again, or Discard."], pending: p };
    requestReveal("flow-save", pressed);
  }

  async function onprovideradddiscard(): Promise<void> {
    const p = adding?.pending;
    if (p == null || adding?.busy) return;
    adding = { busy: true, lines: [], pending: p };
    addSteps.discard();
    const ticket = addSteps.start("discard");
    keyLines = await discardAdd(p, os);
    // Ended meanwhile ("Discard changes"): a newer add on screen by then is not this one's to clear.
    if (addSteps.ended(ticket)) adding = null;
  }

  /** "Discard changes": a waiting add's key is removed too (`leaveAdd` decides which, as leaving the screen does), and
   *  so is a pending replacement's. A step of either still running ends with its flow (`FlowSteps.discard`): it puts
   *  nothing back, and a key it leaves nobody can Discard is removed when it ends. The add's key delete is NOT awaited
   *  before the reload (a busy one is retried for up to ~90 s, and edits made meanwhile would be reloaded over); its
   *  lines are added after the reload, which clears the old ones. Round 11 (L5): so are the pending replacement's — its
   *  key removal is awaited before the reload, whose report reset would otherwise wipe what it said. */
  async function discardChanges(): Promise<void> {
    const orphan = leaveAdd(addSteps.running, adding?.pending ?? null);
    const discarded = orphan === null ? null : discardAdd(orphan, os);
    addSteps.discard();
    adding = null;
    const replaced = replacing?.pending != null ? await onproviderreplacediscard() : [];
    replaceSteps.discard();
    replacing = null;
    await load(false);
    if (replaced.length > 0) keyLines = [...keyLines, ...replaced];
    if (discarded !== null) void discarded.then((lines) => (keyLines = [...keyLines, ...lines]));
  }

  async function refreshProviders(): Promise<void> {
    try {
      const payload = (await status()).payload;
      providerRows = parseStatusProviders(payload);
      // A landed save ends here, so a line about a setting just fixed normally goes with this read. Two reads can land out
      // of order; the worst case is a stale fixed sentence until the next read, which `providerRows` accepts too. A null
      // payload says nothing about the setting, so the line already drawn stays.
      if (payload !== null) aiSummaryStatus = summaryStatusFromStatus(payload);
      void readLatestPage(payload);
    } catch {
      providerRows = null;
    }
    providersNow = new Date();
  }

  /** P-A: the latest page, read again only when `status --json`'s `latestBriefingMtime` moved (Today's own rule). A
   *  page that cannot be read draws no "Today's briefing" line; it is never an error here. */
  async function readLatestPage(payload: unknown): Promise<void> {
    const raw = typeof payload === "object" && payload !== null ? (payload as { latestBriefingMtime?: unknown }).latestBriefingMtime : undefined;
    const m = typeof raw === "string" ? raw : null;
    if (m !== null && m === latestMtime && latestPage !== null) return;
    try {
      const file = await readLatestBriefing();
      latestPage = file?.text ?? null;
      latestMtime = m;
    } catch {
      latestPage = null;
      latestMtime = null;
    }
  }

  /** User-directed 2026-10-22 (P-A): Test all — each row's own Test (`onprovidertest`), one after another, holding the
   *  engine between them (`testingAll`, so no row's Test or Reset starts in a gap). Round 9 (H1): the run is
   *  `testAllInTurn`'s, which takes the rows to test BEFORE the hold disables every row's button; a row whose Test is
   *  not live (its own reason) is passed over, as its own button is disabled. */
  async function onprovidertestall(): Promise<void> {
    if (providers === undefined || providerTestingAll) return;
    await testAllInTurn(
      providers,
      () => providers,
      (on) => (providerTestingAll = on),
      (label, draftIndex) => onprovidertest(label, draftIndex, true),
    );
  }

  /** Round 10 (M1): a move or a removal resets row 1's tool rows only when another provider becomes row 1 — the shell's
   *  one rule (`toolRows`), which watches row 1 whatever changed it. */
  function onprovidermove(from: number, to: number): void {
    if (draft === null) return;
    const refused = moveProvider(draft, from, to, os);
    providersMessage = refused ?? "";
  }

  function onproviderremove(label: string): void {
    if (draft === null) return;
    const refused = removeProvider(draft, label, os);
    providersMessage = refused ?? "";
    if (refused === null && !removedLabels.includes(label)) removedLabels = [...removedLabels, label];
  }

  function onproviderfolder(label: string, dir: string): void {
    if (draft !== null) providersMessage = setLoginFolder(draft, label, dir) ?? "";
  }

  /** Test the DRAFT's entry: validate the candidate, then test it with that entry's own row. */
  async function onprovidertest(label: string, draftIndex: number, fromAll = false): Promise<void> {
    if (draft === null || providerTesting !== null || providerResetting !== null || (providerTestingAll && !fromAll)) return;
    providerTesting = label;
    const text = rawFromDraft($state.snapshot(draft));
    let lines: string[];
    try {
      const plan = testPlan(await providerCandidateCheck(text, "validate"), draftIndex);
      lines = plan.kind === "refuse" ? [plan.message] : testResultLines(await providerCandidateCheck(text, plan.mode));
    } catch (e) {
      lines = [testFailureLine(e)];
    } finally {
      providerTesting = null;
    }
    providerResults = { ...providerResults, [label]: lines };
    void refreshProviders();
  }

  /** Reset a SAVED entry by its saved index — never while the list has unsaved edits (spec §6). */
  async function onproviderreset(label: string, savedIndex: number): Promise<void> {
    if (providers === undefined || !providers.readable || providers.dirty) return;
    if (providerTesting !== null || providerResetting !== null || providerTestingAll) return;
    providerResetting = label;
    let line: string;
    try {
      line = resetResultLine(await providerReset({ index: savedIndex }));
    } catch (e) {
      line = `Not cleared: ${describeFailure(e)}`;
    } finally {
      providerResetting = null;
    }
    providerResults = { ...providerResults, [label]: [line] };
    // Round 10 (M4): awaited, so the row's "Try again now" — gone once the refreshed row has no mark — knows when to
    // hand the focus on (`ProvidersList`).
    await refreshProviders();
  }

  /** P3-M4-T4: a literal-key action on the SAVED entry `label`, or `null` while one cannot run (the list is edited, or
   *  another provider step, a save, an add or a replacement is in progress — the view's `busy`, which disables both
   *  buttons then, so this refusal is never a silent one). */
  function literalRun(label: string, savedIndex: number): { target: LiteralTarget; deps: LiteralDeps } | null {
    if (providers === undefined || !providers.readable || providers.dirty || draft === null || doc === null || doc.text === null) return null;
    if (providersBusy) return null;
    const savedText = doc.text;
    // What the guards read, now and again before the save (`literalGuards`, behaviour-tested): the tab, the saved
    // text and the draft. A JSON-editor edit is not in the draft until the editor is left, so the guards ask for
    // the form (`tab === "form"`) — the post-save reload would otherwise wipe it (P3-M4 checkpoint, finding 8).
    const screen = (): LiteralScreen => ({ savedText: doc?.text ?? null, tab, draft: draft === null ? null : ($state.snapshot(draft) as Draft) });
    const guards = literalGuards(screen(), screen);
    return {
      target: { savedText, label, index: savedIndex, os, unsaved: guards.unsaved },
      deps: {
        save: (text) => submit(text),
        current: guards.current,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      },
    };
  }

  /** "Move this key to the Keychain": `key migrate`, checked against the shown row's revision, then the save. */
  async function onprovidermigrate(label: string, savedIndex: number): Promise<void> {
    const run = literalRun(label, savedIndex);
    if (run === null || providers === undefined || !providers.readable) return;
    const row = providers.rows.find((r) => r.label === label);
    providerMigrating = label;
    providerResults = { ...providerResults, [label]: [`Moving the key to the ${keyStoreName(os)}…`] };
    let out: LiteralResult;
    try {
      out = await migrateLiteral({ ...run.target, shownRevision: row?.revision ?? null }, run.deps);
    } finally {
      providerMigrating = null;
    }
    providerResults = { ...providerResults, [label]: out.lines };
    void refreshProviders();
  }

  /** "Remove the key written in settings" (confirmed on the row): only the literal goes, then the scrub. */
  async function onproviderremoveliteral(label: string, savedIndex: number): Promise<void> {
    const run = literalRun(label, savedIndex);
    if (run === null) return;
    providerMigrating = label;
    let out: LiteralResult;
    try {
      out = await removeWrittenKey(run.target, run.deps);
    } finally {
      providerMigrating = null;
    }
    providerResults = { ...providerResults, [label]: out.lines };
    void refreshProviders();
  }

  /** The save gate (header): the candidate's `config validate` report, through the candidate check. */
  async function gateCheck(text: string): Promise<SaveGate> {
    try {
      return saveGate(await providerCandidateCheck(text, "validate"));
    } catch (e) {
      return saveGateFailure(e);
    }
  }

  /** The file `next`, drawn: the document, the draft and the editor's text (the saved rows asked for it). The user's
   *  resets — the marked fields drawn again, the errors cleared — are `load`'s when the user asked for it (`loadResets`),
   *  never a background reload's. */
  function draw(next: ConfigDocument): void {
    doc = next;
    void refreshSavedRows(next.text);
    draft = next.text === null ? null : parseDraft(next.text);
    raw = next.text ?? "";
    loadFailure = "";
  }

  /** The edit on screen now (R5-M2: `afterLanded`). */
  const editNow = (): Edit => ({ tab, draft: draft === null ? null : ($state.snapshot(draft) as Draft), raw });

  /** Reads the file and draws it, with the user's resets (`loadResets`); it reads the latest file, so it pays an owed
   *  background reload. After a save that `landed` (post-cap, R5-M2): an edit typed while it was in flight is kept
   *  instead (`afterLanded`), unsaved against the new file; and whether or not one was, the marks and the errors stay as
   *  they are (final small fix, F1). Round 10 (M1): the user's resets close "Other…" too, with every error (round 9's
   *  L5: never "Other…" over the file's own tool after a Discard or a Reload). Round 11 (M1, delta LOW): after a save
   *  that landed, the tool rows' note goes, and "Other…" stays open only while the user is typing in the tool rows
   *  (`toolRowsAfterSave`) — never over a saved file whose tool is a named one. Round 12 (M1): a note born in the gesture
   *  that sent the save (`landed.at`) stays, and keeps Other open while it is under Other's rows. */
  async function load(keepReport: boolean, landed: { sent: SentSave; from: Edit; at: number } | null = null): Promise<void> {
    restored = false;
    const asks = backgroundReloads;
    try {
      const next = await configRead();
      const kept = landed === null ? null : afterLanded(landed.sent, landed.from, editNow(), next);
      if (kept === null) {
        draw(next);
        if (loadResets(landed !== null)) {
          redraw = redrawAfterReset(redraw);
          errors = {};
          toolRows = { ...toolRows, other: false, note: null };
        }
        reloadOwed = owedAfterLoad(false, asks, backgroundReloads);
      } else {
        doc = kept.doc;
        void refreshSavedRows(kept.doc.text);
        draft = kept.draft;
        raw = kept.raw;
        loadFailure = "";
        reloadOwed = owedAfterLoad(kept.doc !== next, asks, backgroundReloads);
      }
      if (landed !== null) toolRows = toolRowsAfterSave(toolRows, typingInToolRows(), landed.at);
    } catch (e) {
      loadFailure = describeFailure(e);
    }
    providersMessage = "";
    askNetworkFor = null;
    if (!keepReport) {
      outcome = null;
      failure = "";
      judgeLine = null;
      keyLines = [];
      removedLabels = [];
    }
  }

  onMount(() => {
    void loadApp();
    void loadUpdate();
    const k = takeKeptSettings();
    if (k === null) {
      void load(false);
      openInitial(null);
      return;
    }
    // The path and flags are re-read; the edit and its base token are the kept ones. If the file
    // is gone or no longer JSON, the kept edit has nothing to apply to: show the file as it is.
    void configRead()
      .then((next) => {
        if (next.text === null) {
          doc = next;
          draft = null;
          raw = "";
          openInitial(null);
          return;
        }
        // Final round 4 (R4-M3, pre-existing on main): the kept errors do not come back. Every field is drawn afresh
        // from the kept draft, which never held a refused value, so an old error would mark text no longer on screen
        // (and refuse Save for it); a load restores none either. Final small fix (the LOWs): a reload owed when the
        // screen was left is owed still if the file moved on meanwhile (its base is not the kept one).
        doc = { ...next, base: k.base, text: k.loadedText };
        void refreshSavedRows(k.loadedText);
        tab = k.tab;
        draft = k.draft;
        raw = k.raw;
        restored = true;
        reloadOwed = next.base !== k.base;
        openInitial(k);
      })
      .catch((e) => {
        loadFailure = describeFailure(e);
        openInitial(null);
      });
  });

  onDestroy(() => {
    // An add still waiting when the screen goes: its key is removed (the kept draft does not carry the add) — unless a
    // step of it is still running (its `key set`, or its Save, which may land): that step decides when it ends.
    left = true;
    const orphan = leaveAdd(addSteps.running, adding?.pending ?? null);
    if (orphan !== null) void discardAdd(orphan, os);
    // A pending replacement goes the same way: a waiting one is woken and ends `cancelled` (its Save step then discards
    // it); one with no step running is discarded now.
    replaceWake?.();
    const replaced = leaveReplace(replaceSteps.running, replacing?.pending ?? null);
    if (replaced !== null) void discardReplace(replaced, replaceSaving);
    if (doc === null || doc.base === null || doc.text === null) return;
    keepSettings({
      base: doc.base,
      loadedText: doc.text,
      tab,
      draft: draft === null ? null : $state.snapshot(draft),
      raw,
      errors: $state.snapshot(errors),
    });
  });

  /** The one save path. Answers whether the save landed (`configSave` answered `saved`). `from`: the edit the text was
   *  made from (R5-M2) — the screen when it is called, unless the caller decided on an earlier one (the form's Save).
   *  `at` (round 12, M1): the gesture that sent it — the bar's Save press, else the gesture now (`toolRowsAfterSave`). */
  async function submit(text: string, askedNetwork = false, from: Edit = editNow(), at: number = gesture): Promise<boolean> {
    if (doc === null || doc.base === null || saving) return false;
    saving = true;
    outcome = null;
    failure = "";
    judgeLine = null;
    keyLines = [];
    const sent = { base: doc.base, text };
    // Set inside the save step's callback, so typed by a cast: an annotation alone would narrow it to "failed" here.
    let answered = "failed" as SaveOutcome["kind"] | "failed";
    // Tiny fix (T1, delta MED-1): a conflict refused on a clean draft runs its reload as soon as the save is over,
    // whatever the tab — the line says the file "is loaded again now", and with the JSON editor open `owedReloadRuns`
    // would wait (F3). The editor was read-only for the whole save (F2), so nothing typed there is drawn over.
    let reloadNow = false;
    try {
      const gate = await gateCheck(text);
      if (gate.kind === "refuse") {
        failure = gate.message;
        return false;
      }
      const judge = judgeLineFor(doc.text, text);
      // Remove (P3-M4-T2): the removed entries' app key ids from the SAVED config's rows before it is replaced, then
      // the save, then each key deleted only if the saved config's rows reference it nowhere now.
      const steps = await saveRemovingKeys(doc.text, text, removedLabels, os, async () => {
        const saved = await configSave(text, sent.base);
        answered = saved.kind;
        return saved;
      });
      const result = steps.result;
      outcome = result;
      if (result.kind === "saved") {
        void onconfigsaved();
        judgeLine = judge;
        keyLines = steps.lines;
        removedLabels = [];
        if (askedNetwork) markNetworkAsked();
        // The key deletes run on (a busy one is retried for up to ~90 s): never awaited here, so the outcome, the
        // reload and a free Save come at once; their lines are added when they arrive. Left running if the screen is
        // left — each retry checks the current saved settings first (`saveRemovingKeys`).
        void steps.deletes.then((lines) => (keyLines = [...keyLines, ...lines]));
        await load(true, { sent, from, at });
        void refreshProviders();
      }
    } catch (e) {
      // Post-cap (R5-M3): a conflict names the screen's own way to load the file, and owes the reload.
      const refused = settingsSaveRefusal(e, { editing, flow: pendingFlow !== null });
      failure = refused.line;
      if (refused.reload) {
        reloadOwed = true;
        conflictShown = refused;
        reloadNow = !editing;
      }
    } finally {
      saving = false;
      // If the screen was left while this save was in flight, `onDestroy` kept the draft with the
      // base it was sent from; a save that landed makes that draft current, not unsaved.
      settleKeptSettings(sent, answered);
      if (reloadNow && !left) void backgroundReload();
    }
    return answered === "saved";
  }

  /** The form's Save (`tab === "form"`; the JSON editor's is `submit(raw)`). `saving` is held from the start — through the network check's `config validate` too — so a
   *  second Save cannot start meanwhile; it is released just before `submit`, which takes it again at once. */
  async function saveForm(at: number = gesture): Promise<void> {
    if (draft === null || doc === null || saving) return;
    saving = true;
    let send: { text: string; askedNetwork: boolean } | null = null;
    try {
      let decision = formSubmission($state.snapshot(draft), doc.text, $state.snapshot(errors));
      let askedNetwork = false;
      if (decision.kind === "save") {
        if (askNetworkFor === decision.text) {
          // The question is on screen for exactly this text: apply the answer, then save.
          askedNetwork = askNetwork;
          if (askNetwork) applyNetworkAnswer(draft, networkYes);
          decision = formSubmission($state.snapshot(draft), doc.text, $state.snapshot(errors));
        } else if (await networkAskFor(doc.text, decision.text, networkAsked())) {
          askNetworkFor = decision.text;
          outcome = null;
          failure = "Answer the network-check question above, then press Save again.";
          return;
        }
      }
      askNetworkFor = null;
      switch (decision.kind) {
        case "blocked":
          outcome = null;
          failure = decision.message;
          return;
        case "unchanged":
          failure = "";
          outcome = { kind: "unchanged", path: doc.path };
          return;
        case "save":
          send = { text: decision.text, askedNetwork };
      }
    } finally {
      saving = false;
    }
    if (send !== null) await submit(send.text, send.askedNetwork, { tab: "form", draft: parseDraft(send.text), raw }, at);
  }

  /** The bar's Save: the form's, or with the JSON editor open its text — then where the result is shown, stamped with
   *  where and when it was pressed (post-cap, R5-M5), so a landing after the user moved on moves nothing. Round 12
   *  (M1): the save it sends carries the gesture that pressed it (`at`, for `toolRowsAfterSave`). */
  async function barSave(): Promise<void> {
    if (saving) return;
    const pressed: Pressed = { page, at: performance.now() };
    const at = gesture;
    if (tab === "form") await saveForm(at);
    else await submit(raw, false, editNow(), at);
    requestReveal("save", pressed);
  }

  /** The bar's Discard: "Discard changes", then the open page's title takes the focus (the bar is gone). */
  async function barDiscard(): Promise<void> {
    await discardChanges();
    requestReveal("discard");
  }

  /** Final round 3: ask SettingsPages to bring the result of the user's `action` into view (`revealFor`); a flow's
   *  Save says where and when it was `pressed` (final round 4, R4-M6). */
  function requestReveal(action: RevealAction, pressed?: Pressed): void {
    reveal = nextReveal(reveal, revealFor(action, { page, blocked, outcomeShown: hasOutcome({ outcome, failure, keyLines, judgeLine }), pressed }));
  }

  /** The bar's "fix the marked fields on <page>" (final round 4, R4-M7): the page opens at its first marked field,
   *  which takes the focus (the reveal's `field`; the page's title when none is drawn), not at its title. */
  function fixOn(to: PageId): void {
    if (openPage(to, false)) requestReveal("fix-page");
  }

  /** Advanced's "Edit settings as JSON": the draft becomes the editor's text. Leaving the editor parses it back, as
   *  the page change does (`openPage` → `navigate`), so no caller can switch to the form without that parse. */
  function showTab(): void {
    if (tab === "raw") return;
    if (draft !== null) {
      raw = rawFromDraft($state.snapshot(draft));
    }
    failure = "";
    tab = "raw";
  }

  /** Post-cap (R5-H1): a background reload that could not draw (an unsaved edit or a save in flight when it was
   *  asked or when its read answered, or the screen changed while it read) — run as soon as `owedReloadRuns` says
   *  (the `$effect` below), never lost. */
  let reloadOwed = $state(false);
  /** Final small fix (the LOWs): the background reloads asked so far — one per Calendar or notify write, and one per
   *  owed run — so a user load whose read started before the latest one keeps the reload owed (`owedAfterLoad`). */
  let backgroundReloads = 0;
  /** The conflict a save was last refused with, which owed the reload: once that reload draws the file, a line still
   *  pointing at Discard says it is loaded (`settingsSaveRefusal`'s `loaded`). */
  let conflictShown: { line: string; loaded: string } | null = null;
  /** The form or the JSON editor holds an unsaved edit: the same `isDirty` that keeps a draft across screens. */
  const editing = $derived(
    doc !== null &&
      doc.base !== null &&
      doc.text !== null &&
      isDirty({ base: doc.base, loadedText: doc.text, tab, draft: draft === null ? null : ($state.snapshot(draft) as Draft), raw, errors: {} }),
  );

  /** What a background reload compares when it is asked and when its read answers (`backgroundReloadApplies`). */
  function screenStamp(): ScreenStamp {
    return { editing, saving, text: `${tab}:${tab === "raw" ? raw : draft === null ? "" : rawFromDraft($state.snapshot(draft) as Draft)}`, marked: redraw.pending };
  }

  /** The Calendar panel (or General's engine-notify offer) changed `config.json` (header): `backgroundReload`. */
  function calendarChangedConfig(): void {
    void backgroundReload();
  }

  /** A reload the user did not ask for (post-cap, R5-H1, codex R5-M1): drawn only when the screen was quiet when it
   *  was asked AND is unchanged when the read answers (`backgroundReloadApplies`), else owed — a read that failed too
   *  (final small fix, high-rigor L3: the failure would have hidden an edit committed while it ran). It draws the file
   *  (`draw`) and nothing else: no field is drawn again and no error cleared, so a field still showing a refused value
   *  keeps its mark, error, text and focus (R4-M2) — a Calendar or notify write never changes a value such a field
   *  holds — and asks for no reveal. */
  async function backgroundReload(): Promise<void> {
    backgroundReloads += 1;
    const asked = screenStamp();
    reloadOwed = !backgroundReloadApplies(asked, asked);
    if (reloadOwed) return;
    let next: ConfigDocument;
    try {
      next = await configRead();
    } catch (e) {
      if (!backgroundReloadApplies(asked, screenStamp())) {
        reloadOwed = true;
        return;
      }
      loadFailure = describeFailure(e);
      return;
    }
    if (!backgroundReloadApplies(asked, screenStamp())) {
      reloadOwed = true;
      return;
    }
    restored = false;
    draw(next);
    if (conflictShown !== null && failure === conflictShown.line) failure = conflictShown.loaded;
    conflictShown = null;
    providersMessage = "";
    askNetworkFor = null;
  }

  $effect(() => {
    if (owedReloadRuns(reloadOwed, { editing, saving, tab })) void backgroundReload();
  });

  function onfield(field: Field, value: string): void {
    if (draft === null) return;
    const was = $state.snapshot(draft) as Draft;
    const refused = writeField(draft, field, value);
    // Round 11 (M1): the one decision (`fieldEdited`) — a refused value on row 1's tool controls is a note, never an
    // error (the draft holds nothing that Save must wait on); any other field's is an error, its input marked.
    const next = fieldEdited({ errors, redraw, tool: toolRows }, field, value, refused, noteStamp(draft, gesture));
    errors = next.errors;
    redraw = next.redraw;
    toolRows = next.tool;
    // Round 9 (L6): the page this edit was made on marks the paths it wrote — round 10 (L1): the ones it changed.
    if (refused === null) {
      written = { for: draft, on: { ...(written.for === draft ? written.on : {}), ...writtenBy(field, was, $state.snapshot(draft) as Draft) } };
    }
  }

  /** "Use the engine's default", ticked (the key removed) or unticked (an explicit empty list). The list is now
   *  disabled (or freshly enabled) and drawn again from the draft at once (SettingsForm keys it on the toggle, R3-M1),
   *  so its old complaint describes nothing and the field shows what the draft holds: its mark goes (final round 4,
   *  R4-M1), so no later reset draws the list again under the user typing in it. */
  function ondefault(f: Field, on: boolean): void {
    if (draft === null) return;
    if (on) useDefault(draft, f);
    else useEmptyList(draft, f);
    errors[f.id] = "";
    redraw = redrawAfterDefault(redraw, f.id);
  }

  /** Redesign D: every page change (the sidebar's, the save bar's "fix it on …"). `navigate` decides: leaving Advanced
   *  with the JSON editor open parses its text, refused (no page change, its message shown) or applied whole — all of
   *  what the old Form tab button did; any other change carries the tab as it is, unless no editor can be drawn (the
   *  config is not ready), when `tab` goes back to "form" (M2: nothing to leave, so nothing refuses). Leaving the editor
   *  draws its draft afresh, as a load does: round 10 (M1), "Other…" closes with the errors. The page is remembered
   *  for the session, and its title takes the focus (M1) — unless `title` is false (the bar's fix button: `fixOn`,
   *  whose reveal places the focus). Answers whether the page changed hands (not refused). */
  function openPage(to: PageId, title = true): boolean {
    const next = navigate(page, to, tab, raw, config === "ready");
    if (next.kind === "refused") {
      failure = next.message;
      requestReveal("refused-page");
      return false;
    }
    if (next.kind === "left-json") {
      redraw = redrawAfterReset(redraw);
      draft = next.draft;
      errors = next.errors;
      failure = next.failure;
      toolRows = { ...toolRows, other: false, note: null };
    }
    tab = next.tab;
    page = next.page;
    pageFocus = title;
    rememberPage(page);
    return true;
  }

  /** The page this mount opens (`initialPage`), on every way out of `onMount`: a newer uninstall report opens About
   *  (and is remembered as shown — the SAME object App passes, never a copy, which would never compare equal and
   *  would open About on every mount), a kept JSON editor opens Advanced, else the remembered page. */
  function openInitial(kept: { tab: "form" | "raw" } | null): void {
    const first = initialPage({ remembered: rememberedPage(), kept, report: uninstallReport, lastShownReport: lastShownReport() });
    if (first === "about") rememberShownReport(uninstallReport);
    page = first;
    rememberPage(first);
  }
</script>

<svelte:window onpointerdowncapture={gestured} onkeydowncapture={gestured} />

<!-- A-M7-T15: A's app-preference rows, General's reserved place (D's `prefsRows` contract). A snippet passed as a prop, so
     the SettingsPages tag stays self-closing; the rows write through the app-prefs store, never the draft. -->
{#snippet prefsRows()}
  <PrefsRows />
{/snippet}

{#snippet footer()}
  <SaveBar
    current={page}
    {changed}
    shown={saveBarShown(changeInput, config)}
    {blocked}
    {pendingFlow}
    {saving}
    onsave={() => void barSave()}
    ondiscard={() => void barDiscard()}
    onopenpage={fixOn}
    {askNetwork}
    bind:networkYes
    {outcome}
    {failure}
    {keyLines}
    {judgeLine}
  />
{/snippet}

<section class="settings">
  <h2>Settings</h2>

  <!-- Redesign D: the sidebar and its seven pages, every page mounted (the inactive ones hidden), the save bar
       under whichever is open (`footer`). The app's own controls (on General, Advanced and About) draw whatever
       the config's state — nothing here is guarded on it — so the notification ask is reachable even while the
       engine's config cannot be loaded at all. The Calendar panel writes on its own; this screen reloads after it
       (header). -->
  <SettingsPages
    {page}
    onpage={openPage}
    {attention}
    {changed}
    {tab}
    bind:raw
    {jsonReadOnly}
    onopenjson={() => showTab()}
    {loadFailure}
    {doc}
    {restored}
    {settingsRemovedByUninstall}
    onreload={() => load(false)}
    {draft}
    {errors}
    {onfield}
    onnotifycommand={(v) => draft !== null && writeNotifyCommand(draft, v)}
    {ondefault}
    onremovekey={() => draft !== null && removeStoredApiKey(draft)}
    {providers}
    {providersMessage}
    {onprovidermove}
    {onproviderremove}
    {onproviderfolder}
    onprovidertest={(label, i) => void onprovidertest(label, i)}
    onprovidertestall={() => void onprovidertestall()}
    onproviderreset={(label, i) => onproviderreset(label, i)}
    onprovidermigrate={(label, i) => void onprovidermigrate(label, i)}
    onproviderremoveliteral={(label, i) => void onproviderremoveliteral(label, i)}
    provideradd={addHandlers}
    providerreplace={replaceHandlers}
    toolOther={toolRows.other}
    toolNote={toolRows.note}
    networkAsk={askNetworkAdd}
    bind:networkYes
    notify={appNotify}
    notifyError={appNotifyError}
    autostart={appAutostart}
    autostartError={appAutostartError}
    onrefresh={loadApp}
    {os}
    {update}
    {updateLoading}
    {updateChecking}
    {updateError}
    oncheck={() => void checkNow()}
    onconfigchanged={calendarChangedConfig}
    onstatus={(ok) => (calendarOk = ok)}
    githubLinks={editorLinksState.githubLinks}
    linksBusy={editorLinksState.linksBusy}
    linksLine={editorLinksState.linksLine}
    onlinks={editorLinks.setLinks}
    editors={editorLinksState.editors}
    choiceLines={editorLinksState.choiceLines}
    onchoice={editorLinks.setChoice}
    {uninstallReport}
    {uninstallRunning}
    {onuninstallstarted}
    {onuninstallended}
    {footer}
    {prefsRows}
    version={__APP_VERSION__}
    redraw={redraw.count}
    focusTitle={pageFocus}
    {reveal}
    {aiSummaryStatus}
  />
</section>

<style>
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.15rem;
  }
</style>
