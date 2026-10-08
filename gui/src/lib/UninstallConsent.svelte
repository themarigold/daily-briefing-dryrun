<script lang="ts">
  /**
   * Batch 2 (spec 3.3.8, 3.6.2) — the Uninstall action's CONSENT VIEW: what the user sees and answers
   * between the preview and the execute call. `AppSettings.svelte` owns the call, its errors and the
   * done screen; this component only draws the preview it is given and hands back what the Uninstall
   * button will send ({@link executeArgs}, or {@link uninstallAnyway}'s after a failed scheduler step).
   *
   * ⚠ ITS OWN COMPONENT SO WHAT IT RENDERS IS MEASURED. `tests-web/coexistence.check.ts`
   * server-renders it with the preview as a prop and counts the words before the Uninstall button
   * (spec 3.6.2: at most 100), pins the time sentence beside that button, and pins the radio group's
   * order and default: "Keep it running" FIRST and preselected, as `ForeignOwnerDialog` puts Keep
   * first, so keeping a scheduler this app did not set up is the default.
   *
   * ⚠ NO SCHEDULER FACT IS READ HERE. The scheduler line, the radio group and the boxes' lock come
   * from `./app-uninstall`'s pure helpers ({@link schedulerBranch}, {@link consentBoxes}); the record
   * facts of the preview are theirs alone, and a source pin holds this file to that. What may be
   * removed at all stays Rust's: what this view sends is a request, and Rust's detection and
   * refusals stand behind it (spec 3.3.3, 3.3.5).
   *
   * ⚠ THE BOXES ARE OFF BY DEFAULT, and under "Keep it running" (or "Uninstall anyway" with a
   * scheduler detected) they are drawn unticked and disabled — and sent as false whatever the user
   * ticked before ({@link executeArgs}), so what is drawn is what is sent. Choosing "Keep it running"
   * also CLEARS their values ({@link chooseSchedulerOption}, checkpoint M6a F1), so "Remove it"
   * afterwards does not bring back ticks the screen showed cleared.
   */
  import {
    chooseSchedulerOption,
    consentBoxes,
    consentLabel,
    DEFAULT_SCHEDULER_OPTION,
    executeArgs,
    executeLabel,
    schedulerBranch,
    SCHEDULER_OPTIONS,
    settingsLabel,
    UNINSTALL_EXPLANATION,
    UNINSTALL_TIME_SENTENCE,
    uninstallAnyway,
    type ExecuteArgs,
    type SchedulerOption,
    type UninstallPreview,
  } from "./app-uninstall";

  interface Props {
    /** `uninstall_preview`'s answer — the only source of what is drawn. */
    preview: UninstallPreview;
    /** The execute call answered `ScheduleForeign`: the radio group is ALWAYS shown (spec 3.3.8). */
    foreign?: boolean;
    /** "Uninstall anyway" was chosen after `ScheduleFailed`: the scheduler stays, in one of the two
     *  forms {@link uninstallAnyway} gives, and its sentence replaces the scheduler line. */
    anyway?: boolean;
    /** A call is in flight: nothing can be changed or pressed. */
    busy?: boolean;
    /** The engine-data box, as ticked. Off by default. */
    removeEngineState?: boolean;
    /** The settings box, as ticked. Off by default. */
    removeSettings?: boolean;
    /** The radio group's answer; "Keep it running" by default. */
    option?: SchedulerOption;
    onexecute: (args: ExecuteArgs) => void;
    oncancel: () => void;
  }
  let {
    preview,
    foreign = false,
    anyway = false,
    busy = false,
    removeEngineState = $bindable(false),
    removeSettings = $bindable(false),
    option = $bindable(DEFAULT_SCHEDULER_OPTION),
    onexecute,
    oncancel,
  }: Props = $props();

  const branch = $derived(schedulerBranch(preview, foreign));
  const consents = $derived({ removeEngineState, removeSettings });
  const rescue = $derived(uninstallAnyway(branch, consents));
  const boxes = $derived(consentBoxes(branch, option));
  const locked = $derived(anyway ? rescue.locked : boxes.locked);
  const args = $derived(anyway ? rescue.args : executeArgs(branch, consents, option));

  /** The radio group's answer, through {@link chooseSchedulerOption}: "Keep it running" clears both
   *  boxes' values, not only how they are drawn. */
  function choose(choice: SchedulerOption): void {
    const next = chooseSchedulerOption(choice, { removeEngineState, removeSettings });
    option = next.option;
    removeEngineState = next.removeEngineState;
    removeSettings = next.removeSettings;
  }
</script>

<div class="consent-view">
  <p>{UNINSTALL_EXPLANATION}</p>
  {#if anyway}
    <p>{rescue.sentence}</p>
  {:else if branch.kind === "own" || branch.kind === "unchecked"}
    <p>{branch.line}</p>
  {:else if branch.kind === "other"}
    <fieldset class="scheduler" disabled={busy}>
      <legend>{branch.lead}</legend>
      {#each SCHEDULER_OPTIONS as choice (choice.choice)}
        <label class="choice">
          <input
            type="radio"
            name="uninstall-scheduler"
            value={choice.choice}
            checked={option === choice.choice}
            onchange={() => choose(choice.choice)}
          />
          <span>{choice.label}</span>
        </label>
      {/each}
    </fieldset>
  {/if}
  <label class="consent">
    <input
      type="checkbox"
      checked={!locked && removeEngineState}
      disabled={busy || locked}
      onchange={(e) => (removeEngineState = e.currentTarget.checked)}
    />
    <span>{consentLabel(preview)}</span>
  </label>
  <label class="consent">
    <input
      type="checkbox"
      checked={!locked && removeSettings}
      disabled={busy || locked}
      onchange={(e) => (removeSettings = e.currentTarget.checked)}
    />
    <span>{settingsLabel(preview)}</span>
  </label>
  {#if !anyway && boxes.note !== null}
    <p class="muted small">{boxes.note}</p>
  {/if}
  <p class="muted small">{UNINSTALL_TIME_SENTENCE}</p>
  <div class="row">
    <!-- B6's ScheduleUninstall affordance (round-1 fix M2): the destructive action is marked as one —
         its consented legs can remove the briefing archive and the settings. Its words say what
         clicking WILL do (`executeLabel`, from the arguments it sends). -->
    <button class="danger" disabled={busy} onclick={() => onexecute(args)}>
      {executeLabel(args, preview)}
    </button>
    <button disabled={busy} onclick={oncancel}>Cancel</button>
  </div>
</div>

<style>
  p {
    margin: 0 0 0.6rem;
  }
  .scheduler {
    border: 1px solid var(--line);
    border-radius: 0.45rem;
    padding: 0.5rem 0.8rem;
    margin: 0 0 0.6rem;
  }
  .scheduler legend {
    padding: 0 0.3rem;
  }
  .choice {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .consent {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin-bottom: 0.6rem;
  }
  .consent input {
    margin-top: 0.2rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
  }
  .small {
    font-size: 0.8rem;
  }
  .muted {
    color: var(--muted);
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
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
