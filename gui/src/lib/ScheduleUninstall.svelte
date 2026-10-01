<script lang="ts">
  /**
   * T20 — removing the background scheduler, behind an explicit confirmation.
   *
   * ⚠ TWO CONFIRMATIONS, NOT ONE, AND THE SECOND IS A DIFFERENT QUESTION. The first names the unit
   * FILE (from `schedule status --json`'s `unitPath`, never a path this app computed) and the
   * CONSEQUENCE — under plan R1 the OS trigger is the only thing that delivers, so removing it
   * stops the product. The second appears only when the engine refuses because somebody ELSE owns
   * the record (`docs/gui-seam.md` §3): the app is a viewer of a CLI-owned schedule, KEEP-EXISTING
   * is the default, and taking it over is explicit.
   *
   * ⚠ THE FIRST ATTEMPT NEVER TAKES OVER — the same rule `ScheduleInstall.svelte` follows. Only the
   * foreign-owner dialog's second button retries with `takeOver: true`.
   *
   * ⚠ THE LIVE LEG IS UNRUN IN THIS BUILD. `schedule uninstall` unloads a real LaunchAgent from the
   * user's login domain; `docs/gui-seam.md` §1b records that the suite never executes it against
   * the real engine. What is tested is the argv (through IPC, against a fake sidecar), the
   * confirmation copy and the outcome → stage rule.
   */
  import { scheduleUninstall, type EngineOutcome } from "./engine";
  import { describeFailure } from "./files";
  import ForeignOwnerDialog from "./ForeignOwnerDialog.svelte";
  import type { Stage } from "./install-flow";
  import { afterUninstall, uninstallConfirmation } from "./uninstall-flow";
  import type { ScheduleState } from "./state";

  interface Props {
    /**
     * `ScheduleState` as the screen last saw it — the unit path and the owner come from it.
     *
     * ⚠ NAMED `scheduleState`, NOT `state`, AND THAT IS NOT A PREFERENCE. A local binding called
     * `state` makes `$state(...)` parse as a STORE SUBSCRIPTION to it (`svelte.dev/e/store_rune_conflict`),
     * so every rune below would silently stop being reactive. Measured: `svelte-check` reports it as
     * three errors and three "is updated, but is not declared with `$state(...)`" warnings.
     */
    scheduleState: ScheduleState | null;
    onfinished?: (outcome: EngineOutcome) => void;
  }
  let { scheduleState, onfinished }: Props = $props();

  let asking = $state(false);
  let stage = $state<Stage>("idle");
  let message = $state("");

  const confirmation = $derived(uninstallConfirmation(scheduleState));

  async function remove(takeOver: boolean): Promise<void> {
    asking = false;
    stage = "running";
    message = "";
    try {
      const outcome = await scheduleUninstall({ takeOver });
      const next = afterUninstall(outcome, takeOver, scheduleState?.owner ?? null);
      stage = next.stage;
      message = next.message;
      onfinished?.(outcome);
    } catch (e) {
      // A `busy` refusal means a run or an install is already in flight; nothing was removed.
      stage = "failed";
      message = describeFailure(e);
    }
  }
</script>

<div class="uninstaller">
  {#if !asking}
    <button
      class="danger"
      onclick={() => {
        asking = true;
        stage = "idle";
        message = "";
      }}
      disabled={stage === "running"}
    >
      {stage === "running" ? "Working…" : "Remove background scheduler…"}
    </button>
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
    <ForeignOwnerDialog
      {message}
      purpose="remove the background scheduler"
      onkeep={() => {
        stage = "idle";
        message = "";
      }}
      ontakeover={() => remove(true)}
    />
  {:else if stage === "done"}
    <p class="ok">{message === "" ? "Removed." : message}</p>
  {:else if stage === "failed"}
    <p class="bad">{message === "" ? "That did not work." : message}</p>
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
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .ok {
    margin: 0;
    color: var(--muted);
    white-space: pre-wrap;
  }
  .bad {
    margin: 0;
    color: var(--danger);
    white-space: pre-wrap;
  }
</style>
