<script lang="ts">
  /**
   * T20 — removing the background scheduler, behind an explicit confirmation.
   *
   * ⚠ TWO CONFIRMATIONS, NOT ONE, AND THE SECOND IS A DIFFERENT QUESTION. The first names the unit
   * FILE when one is there (from `schedule status --json`'s `unitPath`, never a path this app
   * computed; Batch 2 spec 3.4.8) and the CONSEQUENCE — under plan R1 the OS trigger is the only thing
   * that delivers, so removing it stops the product. The second appears whenever the engine refuses
   * because the scheduler is not this app's (exit 2, Batch 2 spec 3.4.3: a terminal record, a
   * malformed one, a unit or a registration with no record): KEEP-EXISTING is the default, and taking
   * it over is explicit, with what the engine found shown verbatim.
   *
   * ⚠ THE FIRST ATTEMPT NEVER TAKES OVER — the same rule `ScheduleInstall.svelte` follows. Only the
   * foreign-owner dialog's second button retries with `takeOver: true`, and Try again repeats the
   * attempt it follows, take-over or not.
   *
   * ⚠ THE LIVE LEG IS UNRUN IN THIS BUILD. `schedule uninstall` unregisters a real job by its label —
   * `launchctl bootout` in the user's launchd domains, `systemctl --user stop` and `disable` on Linux —
   * then deletes its files once a check finds it gone; `docs/gui-seam.md` §1b records that the suite
   * never executes it against the real engine. What is tested is the argv (through IPC, against a fake
   * sidecar), the confirmation copy and the outcome → stage rule.
   *
   * ⚠ THE OUTCOME LINE IS NOT DRAWN HERE (Batch 2 spec 3.4.4). A removal takes away what this
   * component's mount keys on (`Schedule.svelte`: a record file, a unit or a registration), so a line
   * drawn here would unmount with the success it reports (known limit 104). Every ended attempt hands
   * its line up through `onfinished` instead; `App.svelte` holds it and the screen draws it below.
   */
  import { scheduleUninstall } from "./engine";
  import { UNINSTALL_TIME_SENTENCE } from "./app-uninstall";
  import { describeFailure } from "./files";
  import ForeignOwnerDialog from "./ForeignOwnerDialog.svelte";
  import type { Stage, StageResult } from "./install-flow";
  import type { Os } from "./platform";
  import {
    afterKeep,
    afterUninstall,
    foreignOwnerLead,
    uninstallConfirmation,
    uninstallLine,
    type UninstallLine,
  } from "./uninstall-flow";
  import type { ScheduleState } from "./state";

  interface Props {
    /**
     * `ScheduleState` as the screen last saw it — the unit path and the owner come from it. `null` when the
     * screen has none (a refresh that read nothing, M9 round 1); then the confirmation and the dialog's lead
     * claim nothing from it (M9 round 2).
     *
     * ⚠ NAMED `scheduleState`, NOT `state`, AND THAT IS NOT A PREFERENCE. A local binding called
     * `state` makes `$state(...)` parse as a STORE SUBSCRIPTION to it (`svelte.dev/e/store_rune_conflict`),
     * so every rune below would silently stop being reactive. Measured: `svelte-check` reports it as
     * three errors and three "is updated, but is not declared with `$state(...)`" warnings.
     */
    scheduleState: ScheduleState | null;
    /** The OS this window runs on, for what the confirmation says stops (spec 3.4.8). */
    os: Os;
    /**
     * Where the panel starts: always `idle` on the screen, which passes none. A server render passes
     * another stage to draw it — SSR runs no click handler, and Try again (spec 3.4.6) and the running
     * state's time sentence (spec 3.1.4) exist only after a click (`tests-web/access.check.ts`,
     * `tests-web/render.check.ts`).
     */
    stage?: Stage;
    /** Spec 3.4.4: a removal is starting — the first attempt, a take-over or Try again. From here until
     *  `onfinished`, App keeps this control mounted whatever a refresh reads (M9 round 2). */
    onstarted?: () => void;
    /**
     * Spec 3.4.4: an attempt has ended, with the line to show for it — the engine's answer, an IPC
     * error or busy refusal (nothing was removed), or "Keep the existing one". Not called while the
     * foreign-owner dialog asks: that is not an end.
     */
    onfinished?: (line: UninstallLine) => void;
  }
  let { scheduleState, os, stage = "idle", onstarted, onfinished }: Props = $props();

  let asking = $state(false);
  let message = $state("");
  /** Whether the last attempt passed `--take-over` — what Try again repeats. */
  let lastTakeOver = false;

  const confirmation = $derived(uninstallConfirmation(scheduleState, os));

  /** Where an attempt lands; an ENDED one (done, failed) hands its line up (spec 3.4.4). */
  function settle(next: StageResult): void {
    stage = next.stage;
    message = next.message;
    const ended = uninstallLine(next);
    if (ended !== null) onfinished?.(ended);
  }

  async function remove(takeOver: boolean): Promise<void> {
    lastTakeOver = takeOver;
    asking = false;
    onstarted?.();
    stage = "running";
    message = "";
    try {
      const outcome = await scheduleUninstall({ takeOver });
      const next = afterUninstall(outcome, takeOver);
      settle(next);
    } catch (e) {
      // A `busy` refusal means a run or an install is already in flight; nothing was removed.
      settle({ stage: "failed", message: describeFailure(e) });
    }
  }
</script>

<div class="uninstaller">
  {#if !asking}
    <div class="row">
      <!-- M9 round 3: disabled while the foreign-owner dialog asks too, so its Keep and Take over are the only
           ways out — and both report an end (App's `removalInProgress` is cleared by it). Pressed there, this
           went back to idle through a first confirmation whose "Keep it" reports nothing. -->
      <button
        class="danger"
        onclick={() => {
          asking = true;
          stage = "idle";
          message = "";
        }}
        disabled={stage === "running" || stage === "foreign-owner"}
      >
        {stage === "running" ? "Working…" : "Remove background scheduler…"}
      </button>
      {#if stage === "failed"}
        <!-- Spec 3.4.6: a failed attempt can be repeated as it was; its line is drawn below. -->
        <button onclick={() => remove(lastTakeOver)}>Try again</button>
      {/if}
    </div>
    {#if stage === "running"}
      <!-- Spec 3.1.4 ("User-facing time"): the Uninstall screen's own sentence. -->
      <p class="ok">{UNINSTALL_TIME_SENTENCE}</p>
    {/if}
  {:else}
    <div class="confirm" role="alertdialog" aria-label={confirmation.title}>
      <p class="title">{confirmation.title}</p>
      <p>{confirmation.body}</p>
      <div class="actions">
        <button onclick={() => (asking = false)}>Keep it</button>
        <button class="danger" onclick={() => remove(false)}>{confirmation.confirmLabel}</button>
      </div>
    </div>
  {/if}

  {#if stage === "foreign-owner"}
    <!-- What the engine found, verbatim (its exit-2 stderr names the record and the unit files a
         take-over removes), under the lead for the owner the screen last read (spec 3.4.3) — or, with
         no state read at all, the dialog's own default lead (M9 round 2: unknown is not "nothing records"). -->
    <ForeignOwnerDialog
      {message}
      lead={scheduleState === null ? undefined : foreignOwnerLead(scheduleState.owner)}
      purpose="remove the background scheduler"
      onkeep={() => settle(afterKeep())}
      ontakeover={() => remove(true)}
    />
  {/if}
</div>

<style>
  .uninstaller {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    align-items: flex-start;
  }
  button {
    font: inherit;
    padding: 0.45rem 0.9rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: var(--panel);
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  .confirm {
    border: 1px solid var(--danger);
    border-radius: 0.5rem;
    padding: 0.8rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 44rem;
  }
  .confirm p {
    margin: 0;
  }
  .title {
    font-weight: 600;
  }
  .actions,
  .row {
    display: flex;
    gap: 0.5rem;
  }
  .ok {
    margin: 0;
    color: var(--muted);
  }
</style>
