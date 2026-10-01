<script lang="ts">
  /**
   * "Install / repair scheduler", with the foreign-owner dialog.
   *
   * ⚠ THIS IS THE COMPONENT T16's WIZARD STEP 6 REUSES. Plan R1: *"The wizard is the first-run
   * path only; the Schedule & Access panel is the SAME flow component for existing-config users"*.
   * It therefore takes no route, owns no layout beyond its own buttons, and reports a SUCCESSFUL
   * install through `onfinished` instead of deciding what the surrounding screen should do next.
   * (Round 1: `onfinished` fires only when `afterInstall` says `done` — `armsVerify` — because its
   * one consumer arms the verification loop, whose kick runs the LIVE scheduler; a refused or
   * failed install used to fire it too, so a foreign-owner refusal kicked the CLI's live job.)
   *
   * ⚠ THE FIRST ATTEMPT NEVER TAKES OVER. The button below always installs with
   * `takeOver: false`; the engine refuses a record owned by someone else (exit 2), and only THEN —
   * and only when `schedule status` says the record's `owner` is not this app — does
   * `ForeignOwnerDialog` offer KEEP-EXISTING (the default, first) and take-over (second, explicit).
   * The engine's refusal keys on the record's `owner`, and this dialog is the only thing standing
   * between it and a silent clobber. Every other exit-2 refusal shows the engine's stderr verbatim
   * (`afterInstall`, `./install-flow.ts`).
   *
   * ⚠ THE LIVE LEG IS UNRUN IN THIS BUILD. `schedule install` registers a real LaunchAgent in the
   * user's login domain; `docs/gui-seam.md` §1b records that the suite never executes it against
   * the real engine, so what is tested here is the argv (through IPC, against a fake sidecar), the
   * outcome → stage rule and the dialog's order — not the registration.
   */
  import { scheduleInstall, type EngineOutcome } from "./engine";
  import { describeFailure } from "./files";
  import ForeignOwnerDialog from "./ForeignOwnerDialog.svelte";
  import { afterInstall, armsVerify, type Stage } from "./install-flow";

  interface Props {
    /** Rendered on the primary button. */
    label?: string;
    /** What to call this action in the foreign-owner dialog's button. */
    purpose?: string;
    /** `ScheduleState.owner` — who the engine says owns the trigger now. */
    owner?: string | null;
    onfinished?: (outcome: EngineOutcome) => void;
  }
  let {
    label = "Install / repair scheduler",
    purpose = "install the background scheduler",
    owner = null,
    onfinished,
  }: Props = $props();

  let stage = $state<Stage>("idle");
  let message = $state("");

  async function install(takeOver: boolean): Promise<void> {
    stage = "running";
    message = "";
    try {
      const outcome = await scheduleInstall({ takeOver });
      const next = afterInstall(outcome, takeOver, owner);
      stage = next.stage;
      message = next.message;
      if (armsVerify(next.stage)) onfinished?.(outcome);
    } catch (e) {
      // A `busy` refusal means a run or another install is already in flight; nothing was started.
      stage = "failed";
      message = describeFailure(e);
    }
  }
</script>

<div class="installer">
  <button onclick={() => install(false)} disabled={stage === "running"}>
    {stage === "running" ? "Working…" : label}
  </button>

  {#if stage === "foreign-owner"}
    <ForeignOwnerDialog
      {message}
      {purpose}
      onkeep={() => {
        stage = "idle";
        message = "";
      }}
      ontakeover={() => install(true)}
    />
  {:else if stage === "done"}
    <p class="ok">Done.{message !== "" ? ` ${message}` : ""}</p>
  {:else if stage === "failed"}
    <p class="bad">{message === "" ? "That did not work." : message}</p>
  {/if}
</div>

<style>
  .installer {
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
