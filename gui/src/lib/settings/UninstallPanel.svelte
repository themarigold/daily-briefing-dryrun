<script lang="ts">
  /**
   * B25 (T25): the uninstall action. Nothing loads and nothing is removed until the user asks —
   * the preview (two read-only engine spawns, `status --json` and `schedule status --json`, plus
   * stats) runs on the first click, both consent boxes default OFF, and the engine-data and
   * settings legs happen only with their box ticked. The consent view is its own component
   * (`UninstallConsent.svelte`, Batch 2 spec 3.6.2); this panel owns the execute call, its three
   * error branches (spec 3.3.8) and the done screen (spec 3.6.3). The wording is
   * `../app-uninstall`'s, pure and pinned; what may be removed at all is Rust's.
   * (Redesign D: split out of the old `AppSettings` panel; it goes on Settings → About & uninstall.)
   */
  import { describeFailure } from "../files";
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
  } from "../app-uninstall";
  import UninstallConsent from "../UninstallConsent.svelte";
  import Tile from "../ui/Tile.svelte";

  interface Props {
    /** Re-fetch the app's state after an execute lands (Settings' `loadApp`). */
    onrefresh: () => void | Promise<void>;
    /**
     * M9 round 3: the Uninstall execute's report — the done screen is drawn from it — and whether an execute
     * is in flight, both held by App (`App.svelte`) and passed down through Settings, so neither is lost when
     * this panel unmounts. It unmounts in two ways: a screen change mid-execute, and — since M9 round 4, by
     * design — App's remount of Settings when a report arrives, so the new mount draws the done screen from
     * the report it is handed. (A consented settings removal's not-configured snapshot no longer opens the
     * wizard: App stops that route once an execute starts.)
     *
     * M9 LOW pass (L5): these four are REQUIRED, with no default, so a mount that forgets one fails
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
    onrefresh,
    uninstallReport,
    uninstallRunning,
    onuninstallstarted,
    onuninstallended,
  }: Props = $props();

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
</script>

<!-- Redesign D: the Uninstall group, in Step 0's `Tile`. -->
<div class="group">
<Tile>
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
    <div class="row idle">
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
</Tile>
</div>

<style>
  /* Part B (the S-A mockup): the group's name in small capitals (in --muted: the mockup's faint grey is below 4.5:1
   * on a tile); at rest, the explanation on the left and "Uninstall app…" on the right. Step 0's Tile pads its content
   * 0.65rem 0.8rem (lib/ui is frozen in wave 1), so the block reaches out to the mockup's 14px from its edge. */
  .group {
    margin: 0 0 14px;
  }
  .block {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 12px;
    align-items: center;
    margin: 0 -0.8rem -0.65rem;
    padding: 0 14px 11px;
  }
  .block > * {
    grid-column: 1;
  }
  .block > .idle {
    grid-column: 2;
    grid-row: 1 / span 2;
    margin: 0;
  }
  /* V13: the last words end 11px from the tile's edge (the block's padding). */
  .block > p:last-of-type,
  .block > .row:last-child {
    margin-bottom: 0;
  }
  @media (max-width: 720px) {
    .block {
      grid-template-columns: minmax(0, 1fr);
    }
    .block > .idle {
      grid-column: 1;
      grid-row: auto;
    }
  }
  /* Final round 3 (V12): the group's name is its row's label (13px, 600), as the mockup's headerless group draws
   * "Uninstall"; still the group's <h4>. */
  h4 {
    margin: calc(11px - 0.65rem) 0 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  p {
    margin: 0 0 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .report,
  .still {
    margin: 0 0 6px;
    padding-left: 1.1rem;
    font-size: 12px;
  }
  .still-head {
    font-weight: 600;
    color: var(--fg);
  }
  .still {
    overflow-wrap: anywhere;
  }
  .still pre,
  pre.failure {
    margin: 0.3rem 0;
    padding: 0.5rem 0.7rem;
    border-radius: 6px;
    border: 1px solid var(--line);
    overflow-x: auto;
    font-size: 11.5px;
    white-space: pre-wrap;
  }
  pre.failure {
    margin-bottom: 6px;
  }
  .small {
    font-size: 11.5px;
  }
  .muted {
    color: var(--muted);
  }
  .bad {
    color: var(--danger);
    font-size: 12px;
  }
  /* The mockup's .btn. */
  button {
    font: inherit;
    font-size: 12.5px;
    padding: 5px 11px;
    border-radius: 6px;
    border: 1px solid var(--tile-border);
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  button:disabled {
    color: var(--muted);
    cursor: default;
  }
  /* Final round 2 (V5): the S-A mockup's danger button at rest (Step 0's --danger: about 6.9:1 light, 6.4:1 dark on
   * --tile); "Working…" keeps the disabled look. Final round 3 (V14): only the words are red, the border a pale tint of
   * it, as the mockup's `.btn.dan` (#e7b8b2 light / #5b2b26 dark). */
  .idle button:not(:disabled) {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 35%, var(--tile));
  }
</style>
