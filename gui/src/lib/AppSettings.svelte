<script lang="ts">
  /**
   * B7 (T18/T19) — the "This app" panel on the Settings screen: the notification opt-in and the
   * autostart toggle. These are APP settings, not engine config — they live above the engine's
   * form and never touch `config_save` except through the one existing offer command.
   *
   * ⚠ THE NOTIFICATION ASK IS EXPLAINED, AND NOTHING POSTS BEFORE IT IS ANSWERED. Rust suppresses
   * every firing while the opt-in record says never-asked or off (`notifications::on_snapshot`);
   * this panel is where the record is set, with `notifyAskExplanation`'s text on screen — plan T18's
   * "requested with an explanation, never on first fire".
   *
   * ⚠ THE AUTOSTART TOGGLE REFLECTS REAL STATE. `autostart` is `is_enabled()`'s answer (a stat of
   * the LaunchAgent plist), fetched by the parent and re-fetched after every change — never a
   * cached boolean (plan T19).
   *
   * ⚠ TURNING AUTOSTART OFF OFFERS ENGINE `notify: "auto"` (T11 rework): with no login item, the
   * app may not be running at 07:20 to notify, and the engine's own notifier is the fallback. The
   * offer is the SAME classification (`notifyOffer`) and the SAME validated one-field save
   * (`config_offer_notify_auto`) the Quit dialog uses — one save path, one wording module.
   */
  import { onMount } from "svelte";
  import { configOfferNotifyAuto, configRead, describeFailure, type SaveOutcome } from "./files";
  import {
    anywayNote,
    autostartLine,
    engineDataLine,
    executeFailure,
    finishLine,
    outcomeLine,
    removedList,
    schedulerBranch,
    schedulerOutcomeLine,
    stateAfterFailure,
    stillOnThisMachine,
    uninstallExecute,
    uninstallPreview,
    DEFAULT_SCHEDULER_OPTION,
    TRY_AGAIN,
    UNINSTALL_ANYWAY,
    UNINSTALL_EXPLANATION,
    UNINSTALL_TIME_SENTENCE,
    type ExecuteArgs,
    type ExecuteFailure,
    type SchedulerOption,
    type UninstallPreview,
    type UninstallReport,
  } from "./app-uninstall";
  import UninstallConsent from "./UninstallConsent.svelte";
  import {
    cliShimInstall,
    cliShimRemove,
    cliShimStatus,
    describeShimFailure,
    placementLine,
    type CliShimStatus,
  } from "./shim";
  import {
    autostartSetEnabled,
    engineNotifyLine,
    notifyAskExplanation,
    notifySetEnabled,
    suppressedLine,
    type NotifyStatus,
  } from "./notify";
  import type { Os } from "./platform";
  import { notifyOffer, offerNote, offerTakeable, type NotifyOffer } from "./settings-model";

  interface Props {
    /** `notify_status`'s answer; `null` while loading or failed (`notifyError` says why). */
    notify: NotifyStatus | null;
    notifyError?: string;
    /** `is_enabled()`'s answer; `null` while loading or failed (`autostartError` says why). */
    autostart: boolean | null;
    autostartError?: string;
    /** Re-fetch both after a change. */
    onrefresh: () => void | Promise<void>;
    /** v0.2.1 §3.5: the OS this window runs on (App's `osFromUserAgent`, through Settings), for
     *  the ask's wording. REQUIRED, with no default, so a mount that forgets it fails
     *  `svelte-check` instead of silently getting one platform's wording. */
    os: Os;
    /**
     * M9 round 3: the Uninstall execute's report — the done screen is drawn from it — and whether an execute
     * is in flight, both held by App (`App.svelte`) and passed down through Settings, so neither is lost when
     * this panel unmounts. It unmounts in two ways: a screen change mid-execute, and — since M9 round 4, by
     * design — App's remount of Settings when a report arrives, so the new mount draws the done screen from
     * the report it is handed. (A consented settings removal's not-configured snapshot no longer opens the
     * wizard: App stops that route once an execute starts.)
     *
     * M9 LOW pass (L5): these four are REQUIRED, with no default, like `os`, so a mount that forgets one fails
     * `svelte-check` instead of silently showing no done screen.
     */
    uninstallReport: UninstallReport | null;
    uninstallRunning: boolean;
    /** M9 round 3: an execute is starting — said BEFORE the IPC call (App stops routing to the wizard, and
     *  since the M9 LOW pass replaces the report it holds: L2). */
    onuninstallstarted: () => void;
    /** M9 round 3: the execute ended, with its report, or `null` when it was rejected. */
    onuninstallended: (report: UninstallReport | null) => void;
  }
  let {
    notify,
    notifyError = "",
    autostart,
    autostartError = "",
    onrefresh,
    os,
    uninstallReport,
    uninstallRunning,
    onuninstallstarted,
    onuninstallended,
  }: Props = $props();

  let busy = $state(false);
  let failure = $state("");
  /** The T11 offer, shown after autostart is turned OFF. `null` = not offered right now. */
  let offer = $state<NotifyOffer | null>(null);
  let offerResult = $state("");
  /** Guards the async `configRead` continuation in `setAutostart`: a read started for an OFF
   *  that has since been superseded (autostart turned back on, or a newer OFF) must not write
   *  a stale offer over the current state (Gemini B3, B7 fix round). */
  let offerToken = 0;

  async function setNotifications(enabled: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    failure = "";
    try {
      await notifySetEnabled(enabled);
      await onrefresh();
    } catch (e) {
      failure = describeFailure(e);
    } finally {
      busy = false;
    }
  }

  async function setAutostart(enabled: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    failure = "";
    offerResult = "";
    try {
      if (enabled) {
        offerToken += 1; // invalidate any in-flight offer read; its answer is for a dead OFF
        offer = null;
        await autostartSetEnabled(true);
      } else {
        await autostartSetEnabled(false);
        // The offer is decided from the config AS IT IS (the Quit dialog's rule, §10e): the
        // button appears only where taking it would change something.
        const mine = ++offerToken;
        offer = { kind: "checking" };
        try {
          const text = (await configRead()).text;
          if (mine === offerToken) offer = notifyOffer(text);
        } catch {
          if (mine === offerToken) offer = { kind: "unknown" };
        }
      }
      await onrefresh();
    } catch (e) {
      failure = describeFailure(e);
    } finally {
      busy = false;
    }
  }

  /**
   * B8 (dev 63): the command-line tool's state and actions. EXPLICIT user actions only — the
   * status read happens on mount (read-only: two engine reads and one `lstat`), and nothing is
   * written except by the two buttons. What counts as ours vs foreign is Rust's
   * (`cli_shim::classify`); a permission refusal surfaces the exact manual command.
   */
  let shim = $state<CliShimStatus | null>(null);
  let shimError = $state("");
  let shimBusy = $state(false);

  async function loadShim(): Promise<void> {
    try {
      shim = await cliShimStatus();
      shimError = "";
    } catch (e) {
      shim = null;
      shimError = describeShimFailure(e, os);
    }
  }

  onMount(() => {
    void loadShim();
  });

  async function shimAction(action: () => Promise<CliShimStatus>): Promise<void> {
    if (shimBusy) return;
    shimBusy = true;
    shimError = "";
    try {
      shim = await action();
    } catch (e) {
      shimError = describeShimFailure(e, os);
    } finally {
      shimBusy = false;
    }
  }

  /**
   * B25 (T25): the uninstall action. Nothing loads and nothing is removed until the user asks —
   * the preview (two read-only engine spawns, `status --json` and `schedule status --json`, plus
   * stats) runs on the first click, both consent boxes default OFF, and the engine-data and
   * settings legs happen only with their box ticked. The consent view is its own component
   * (`UninstallConsent.svelte`, Batch 2 spec 3.6.2); this panel owns the execute call, its three
   * error branches (spec 3.3.8) and the done screen (spec 3.6.3). The wording is
   * `./app-uninstall`'s, pure and pinned; what may be removed at all is Rust's.
   */
  let uninstall = $state<UninstallPreview | null>(null);
  let uninstallError = $state("");
  let uninstallBusy = $state(false);
  let removeEngineState = $state(false);
  let removeSettings = $state(false);
  let schedulerOption = $state<SchedulerOption>(DEFAULT_SCHEDULER_OPTION);
  /** The execute call answered `ScheduleForeign`: the radio group always shows (spec 3.3.8). */
  let foreign = $state(false);
  /** "Uninstall anyway" was chosen after `ScheduleFailed` (spec 3.3.8). */
  let anyway = $state(false);
  /** The last execute call's failure of spec 3.3.8's three kinds; `null` otherwise. */
  let executeError = $state<ExecuteFailure | null>(null);
  /** What the last execute call sent — what Try again sends again. */
  let lastArgs: ExecuteArgs | null = null;
  /**
   * M9 LOW pass (L2): the flow "Uninstall again…" opened is drawn IN PLACE of the done screen, over the report
   * App still holds — set once its preview has landed, cleared by Cancel. So a preview that fails, or a Cancel,
   * shows the done screen again, its manual steps included; App replaces the report only when the next execute
   * starts (`onuninstallstarted`). Nothing else writes it: an execute that lands remounts this panel (App's key).
   */
  let againOpen = $state(false);

  /** Back to the defaults: both boxes off, "Keep it running" selected, no error branch. */
  function resetConsent(): void {
    removeEngineState = false;
    removeSettings = false;
    schedulerOption = DEFAULT_SCHEDULER_OPTION;
    foreign = false;
    anyway = false;
    executeError = null;
    lastArgs = null;
  }

  async function openUninstall(): Promise<void> {
    if (uninstallBusy || uninstallRunning) return;
    uninstallBusy = true;
    uninstallError = "";
    try {
      uninstall = await uninstallPreview();
      resetConsent();
    } catch (e) {
      uninstall = null;
      uninstallError = describeFailure(e);
    } finally {
      uninstallBusy = false;
    }
  }

  function cancelUninstall(): void {
    uninstall = null;
    resetConsent();
    uninstallError = "";
    againOpen = false;
  }

  /** M9 round 4: "Uninstall again…" on the done screen — the way out its refusals and the app's closing line
   *  after manual steps name ("run Uninstall again"), which the done screen otherwise offers no control for.
   *  The flow opens exactly as "Uninstall app…" opens it, and since the M9 LOW pass (L2) without clearing the
   *  report: the done screen stays, its button disabled, while the preview loads, and gives way to the flow only
   *  when the preview lands. */
  async function uninstallAgain(): Promise<void> {
    if (uninstallBusy || uninstallRunning) return;
    await openUninstall();
    againOpen = uninstall !== null;
  }

  /**
   * The execute call. Its three Batch 2 rejections are `executeFailure`'s, never `describeFailure`'s
   * (whose `busy` arm reads another error's shape): on each, Rust removed nothing (spec 3.3.4.3). What
   * each leaves the screen in is `stateAfterFailure`'s, applied whole (checkpoint M6a F4) — nothing
   * else here writes those five:
   *   • `ScheduleForeign` — the preview is re-read and the radio group always shows, Keep selected
   *     (its boxes cleared); the refusal is itself the detection, so a re-read that fails keeps the
   *     preview we have.
   *   • `ScheduleFailed` — the message, Try again and "Uninstall anyway", with what that does.
   *   • `Busy` — the message and Try again.
   * M9 round 3: its start is said BEFORE the IPC call and its end the moment it answers (the report, or
   * `null` for a rejection), so App holds both whatever happens to this panel meanwhile.
   */
  async function runUninstall(args: ExecuteArgs): Promise<void> {
    if (uninstallBusy || uninstallRunning || uninstall === null) return;
    uninstallBusy = true;
    uninstallError = "";
    executeError = null;
    lastArgs = args;
    onuninstallstarted();
    try {
      const report = await uninstallExecute(args.removeEngineState, args.removeSettings, args.schedule);
      onuninstallended(report);
      uninstall = null;
      resetConsent();
      await onrefresh();
    } catch (e) {
      onuninstallended(null);
      const known = executeFailure(e);
      if (known === null) {
        uninstallError = describeFailure(e);
      } else {
        const next = stateAfterFailure(known, { removeEngineState, removeSettings, option: schedulerOption, foreign, anyway });
        removeEngineState = next.removeEngineState;
        removeSettings = next.removeSettings;
        schedulerOption = next.option;
        foreign = next.foreign;
        anyway = next.anyway;
        if (next.reread) {
          try {
            uninstall = await uninstallPreview();
          } catch {
            // Not re-read: the preview we have stands, and `foreign` shows the group either way.
          }
        }
        executeError = known;
      }
    } finally {
      uninstallBusy = false;
    }
  }

  function tryAgain(): void {
    if (lastArgs !== null) void runUninstall(lastArgs);
  }

  /** "Uninstall anyway": back to the consent view in its keep form, which says what that keeps
   *  before anything is sent. */
  function chooseAnyway(): void {
    anyway = true;
    executeError = null;
  }

  function describeOffer(outcome: SaveOutcome): string {
    switch (outcome.kind) {
      case "saved":
        return `Done: the engine's setting is now "auto" (saved to ${outcome.path}; the previous file is ${outcome.backupPath}).`;
      case "created":
        // Unreachable from the offer (it edits an existing config); typed for completeness.
        return `Done: the engine's setting is now "auto" (saved to ${outcome.path}).`;
      case "unchanged":
        return 'The engine\'s setting was already "auto"; nothing was changed.';
      case "invalid":
        return `Not changed — the engine refused the config: ${outcome.errors.map((e) => e.message).join("; ")}`;
    }
  }

  async function takeOffer(): Promise<void> {
    if (busy) return;
    busy = true;
    offerResult = "";
    try {
      offerResult = describeOffer(await configOfferNotifyAuto());
    } catch (e) {
      offerResult = `Not changed: ${describeFailure(e)}`;
    } finally {
      busy = false;
    }
  }
</script>

<div class="app-settings">
  <h3>This app</h3>

  <div class="block">
    <h4>Notifications</h4>
    {#if notifyError !== ""}
      <p class="bad">{notifyError}</p>
    {:else if notify === null}
      <p class="muted">Checking…</p>
    {:else}
      {#if notify.enabled === null}
        <!-- Never asked: the explained ask, plan T18. Nothing has been posted and nothing will
             be until Enable is pressed. -->
        <p>{notifyAskExplanation(os)}</p>
        <div class="row">
          <button disabled={busy} onclick={() => setNotifications(true)}>Enable notifications</button>
          <button disabled={busy} onclick={() => setNotifications(false)}>Not now</button>
        </div>
      {:else if notify.enabled}
        <p>Notifications are on: briefing arrivals, failed runs and blocked runs.</p>
        <div class="row">
          <button disabled={busy} onclick={() => setNotifications(false)}>Turn off</button>
        </div>
      {:else}
        <p>Notifications are off. {notifyAskExplanation(os)}</p>
        <div class="row">
          <button disabled={busy} onclick={() => setNotifications(true)}>Enable notifications</button>
        </div>
      {/if}
      <p class="muted">{engineNotifyLine(notify.engine)}</p>
      {#if notify.suppressed.length > 0}
        <ul class="muted suppressed">
          <!-- The key carries the index (Gemini B2): the log CAN hold two identical entries
               (the same class suppressed for the same date and reason on separate firings),
               and duplicate each-keys are a Svelte runtime error, not a render quirk. -->
          {#each notify.suppressed.slice(-3) as s, i (s.class + s.date + s.reason + i)}
            <li>{suppressedLine(s)}</li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>

  <div class="block">
    <h4>Start at login</h4>
    {#if autostartError !== ""}
      <p class="bad">{autostartError}</p>
    {:else if autostart === null}
      <p class="muted">Checking…</p>
    {:else if autostart}
      <p>
        Daily Briefing starts when you log in (the default), so it is there to show and announce
        the morning briefing.
      </p>
      <div class="row">
        <button disabled={busy} onclick={() => setAutostart(false)}>Turn off</button>
      </div>
    {:else}
      <p>
        Daily Briefing does not start at login. The background scheduler still generates briefings;
        what you miss is this app's window and its notifications until you open it.
      </p>
      <div class="row">
        <button disabled={busy} onclick={() => setAutostart(true)}>Start at login</button>
      </div>
    {/if}
    {#if offer !== null}
      <div class="offer">
        <!-- T11's rework: autostart just went off, so the engine's own notifier is offered as the
             fallback — same classification and same save path as the Quit dialog's offer. -->
        {#if offerTakeable(offer)}
          <button disabled={busy} onclick={takeOffer}>Switch engine notifications to auto</button>
        {:else}
          <p class="offer-label">Switch engine notifications to auto</p>
        {/if}
        {#if offerNote(offer) !== null}
          <p class="muted">{offerNote(offer)}</p>
        {/if}
        {#if offerResult !== ""}
          <p class="muted result">{offerResult}</p>
        {/if}
      </div>
    {/if}
  </div>

  {#if shim === null || shim.supported}
    <div class="block">
      <h4>Command-line tool</h4>
      {#if shim === null}
        {#if shimError !== ""}
          <pre class="bad">{shimError}</pre>
        {:else}
          <p class="muted">Checking…</p>
        {/if}
      {:else}
        <p>
          Puts <code>daily-briefing</code> on your PATH — a link at {shim.shimPath} to the
          background engine copy — so the same engine works from a terminal
          (<code>daily-briefing status</code>, <code>daily-briefing run --force</code>).
        </p>
        <p class="muted small">{placementLine(shim)}</p>
        {#if shim.target !== null}
          <p class="muted small">It links to: {shim.target}</p>
        {:else}
          <p class="muted small">
            Install the background scheduler first — the engine copy it makes is what this links
            to.
          </p>
        {/if}
        <div class="row">
          {#if shim.state === "absent" || shim.state === "stale"}
            <button disabled={shimBusy || shim.target === null}
              onclick={() => void shimAction(cliShimInstall)}>
              {shim.state === "stale" ? "Repair command-line tool" : "Install command-line tool"}
            </button>
          {/if}
          {#if shim.state === "current" || shim.state === "stale"}
            <button disabled={shimBusy} onclick={() => void shimAction(cliShimRemove)}>
              Remove command-line tool
            </button>
          {/if}
        </div>
        {#if shimError !== ""}
          <pre class="bad">{shimError}</pre>
        {/if}
      {/if}
    </div>
  {/if}

  <div class="block">
    <h4>Uninstall</h4>
    {#if uninstallReport !== null && !againOpen}
      <!-- The done screen (Batch 2, spec 3.6.3), every line from the REPORT — the execute-time facts,
           never the preview's: the scheduler's outcome once, then what happened to each piece and
           what was removed, then "Still on this machine" — only what remains, the scheduler with its
           steps included — and the finish LAST, so what stays is read before the app is deleted; after
           it, the one control, "Uninstall again…" (M9 round 4).
           Every string is `{}`-interpolated, never raw markup: the engine's and Rust's words are text. -->
      {@const report = uninstallReport}
      {@const dataLine = engineDataLine(report)}
      {@const still = stillOnThisMachine(report)}
      <p>Done. What happened to each piece:</p>
      <ul class="muted report">
        <li>{schedulerOutcomeLine(report.schedule.outcome)}</li>
        <li>{autostartLine(report.autostart, report.os)}</li>
        {#each report.app as line (line.name)}
          <li>{outcomeLine(line)}</li>
        {/each}
        {#each report.engine as line (line.name)}
          <li>engine: {outcomeLine(line)}</li>
        {/each}
        {#if report.engineStateDir !== null}
          <!-- Round-1 fix M3: the report says WHERE the engine-data leg landed — the execute-time
               `status --json` answer, so the consented target is auditable after the fact. -->
          <li>engine state directory: {report.engineStateDir}</li>
        {/if}
        {#if dataLine !== null}
          <!-- A refused leg removes NOTHING: one line, the refusal verbatim (`uninstall.rs`). -->
          <li class="bad">{dataLine}</li>
        {/if}
        {#each removedList(report) as line, i (i)}
          <li>{line}</li>
        {/each}
      </ul>
      {#if still.length > 0}
        <p class="still-head">Still on this machine:</p>
        <ul class="still">
          {#each still as line, i (i)}
            {#if line.kind === "code"}
              <li><pre>{line.text}</pre></li>
            {:else}
              <li>{line.text}</li>
            {/if}
          {/each}
        </ul>
      {/if}
      <p class="muted">{finishLine(report.os)}</p>
      <div class="row">
        <button disabled={uninstallBusy || uninstallRunning} onclick={() => void uninstallAgain()}
          >Uninstall again…</button
        >
      </div>
    {:else if uninstall === null}
      <p>{UNINSTALL_EXPLANATION}</p>
      <!-- M9 round 3: an execute App says is running, that this mount did not start (the screen was left and
           re-entered mid-run): its Working… state, never a fresh "Uninstall app…" beside it. -->
      <div class="row">
        <button disabled={uninstallBusy || uninstallRunning} onclick={() => void openUninstall()}
          >{uninstallRunning ? "Working…" : "Uninstall app…"}</button
        >
      </div>
      {#if uninstallRunning}
        <p class="muted small">{UNINSTALL_TIME_SENTENCE}</p>
      {/if}
    {:else if executeError !== null && executeError.kind !== "scheduleForeign"}
      <!-- `ScheduleFailed` or `Busy` (spec 3.3.8): the message verbatim — the engine's stderr, which
           may carry the manual steps, then the app's closing line once — and `executeFailure`'s
           buttons: Try again, and for `ScheduleFailed` "Uninstall anyway", with what it does said under
           it before it is clicked (checkpoint M6a F6) — from the branch the consent view will draw. -->
      {@const anywayLine = anywayNote(executeError, schedulerBranch(uninstall, foreign), { removeEngineState, removeSettings })}
      <pre class="bad failure">{executeError.message}</pre>
      {#if executeError.closing !== null}
        <p class="muted">{executeError.closing}</p>
      {/if}
      <div class="row">
        {#if executeError.buttons.includes(TRY_AGAIN)}
          <button disabled={uninstallBusy} onclick={tryAgain}>{TRY_AGAIN}</button>
        {/if}
        {#if executeError.buttons.includes(UNINSTALL_ANYWAY)}
          <button disabled={uninstallBusy} onclick={chooseAnyway}>{UNINSTALL_ANYWAY}</button>
        {/if}
        <button disabled={uninstallBusy} onclick={cancelUninstall}>Cancel</button>
      </div>
      {#if anywayLine !== null}
        <p class="muted small">{anywayLine}</p>
      {/if}
    {:else}
      {#if executeError !== null}
        <!-- `ScheduleForeign`: what the engine found, verbatim, above the radio group it asks. -->
        <pre class="bad failure">{executeError.message}</pre>
      {/if}
      <UninstallConsent
        preview={uninstall}
        {foreign}
        {anyway}
        busy={uninstallBusy}
        bind:removeEngineState
        bind:removeSettings
        bind:option={schedulerOption}
        onexecute={(args) => void runUninstall(args)}
        oncancel={cancelUninstall}
      />
    {/if}
    {#if uninstallError !== ""}
      <p class="bad">{uninstallError}</p>
    {/if}
  </div>

  {#if failure !== ""}
    <p class="bad">{failure}</p>
  {/if}
</div>

<style>
  .app-settings {
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    padding: 0.9rem 1rem;
    margin-bottom: 1.5rem;
  }
  h3 {
    margin: 0 0 0.6rem;
    font-size: 1rem;
  }
  h4 {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
  }
  .block {
    padding: 0.5rem 0;
  }
  .block + .block {
    border-top: 1px solid var(--line);
  }
  p {
    margin: 0 0 0.6rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
  }
  .offer {
    border-top: 1px dashed var(--line);
    padding-top: 0.6rem;
  }
  .offer-label {
    font-weight: 600;
  }
  .result {
    overflow-wrap: anywhere;
  }
  .suppressed {
    margin: 0;
    padding-left: 1.1rem;
  }
  .report,
  .still {
    margin: 0 0 0.6rem;
    padding-left: 1.1rem;
  }
  .still-head {
    font-weight: 600;
  }
  .still {
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .still pre,
  pre.failure {
    margin: 0.3rem 0;
    padding: 0.5rem 0.7rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    overflow-x: auto;
    font-size: 0.78rem;
    white-space: pre-wrap;
  }
  pre.failure {
    margin-bottom: 0.6rem;
  }
  .small {
    font-size: 0.8rem;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .bad {
    color: var(--danger);
    font-size: 0.85rem;
  }
  button {
    font: inherit;
    padding: 0.45rem 0.9rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
