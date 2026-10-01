<script lang="ts">
  /**
   * T20 — the post-install verification loop, driven by B4's `state:changed` stream.
   *
   * ⚠ IT NEVER POLLS `launchctl`, AND IT NEVER POLLS ANYTHING. The kick is ENGINE-SIDE
   * (`schedule verify`, plan R1), and what decides whether to kick AGAIN is the live snapshot the
   * watcher already pushes: a new `last-skip.json` record — one the loop's OWN kick did not write
   * (`verify-flow.ts`'s `onEvidence` absorbs those) — while a delivery ENDS the loop. The app's
   * exec surface stays engine-only — there is no launchctl command, and the capability grants
   * none.
   *
   * ⚠ A DELIVERY DOES NOT LOOP (plan R1, final-check M3). On a fresh install the kickstarted run
   * exercises the repo reads and may deliver a THIN briefing; the panel falls through to the
   * next-tick watch and lets the folder-access checks carry the thinness. Retrying would generate a
   * second briefing for no new fact.
   *
   * ⚠ AND `already-delivered-before-kick` IS NEVER RENDERED AS SUCCESS (`docs/gui-seam.md` §3). The
   * wording lives in `lib/verify-flow.ts`, which is pure and tested; this component draws it.
   *
   * ⚠ THE LIVE LEG IS UNRUN IN THIS BUILD: `schedule verify` kicks a real LaunchAgent. What is
   * tested is the argv (through IPC, against a fake sidecar) and the pure outcome → stage rule.
   */
  import { scheduleVerify, type EngineOutcome } from "./engine";
  import { describeFailure } from "./files";
  import {
    afterKick,
    afterKickRefusal,
    armLoop,
    beginKick,
    initialLoop,
    MAX_VERIFY_ATTEMPTS,
    onEvidence,
    type LoopState,
    type VerifyEvidence,
  } from "./verify-flow";

  interface Props {
    /** The live facts the loop watches — from the pushed `Snapshot`. */
    evidence: VerifyEvidence;
    /**
     * Bumped by the parent after an install SUCCEEDS, which arms the loop. A NUMBER rather than a
     * boolean so a second install re-arms it. (Round 1: a refused or failed install no longer
     * bumps it — see `install-flow.ts`'s `armsVerify`.)
     */
    trigger?: number;
    onfinished?: (outcome: EngineOutcome) => void;
  }
  let { evidence, trigger = 0, onfinished }: Props = $props();

  /**
   * The whole loop lives in `lib/verify-flow.ts`'s pure state machine; this component only feeds
   * it events (round 1 — the event rules themselves were the HIGH, so they are all pure and
   * table-tested now).
   */
  let loop = $state<LoopState>(initialLoop());
  let seenTrigger = $state(0);

  async function kick(which: number): Promise<void> {
    loop = beginKick(evidence, which);
    try {
      const outcome = await scheduleVerify();
      loop = afterKick(loop, outcome, which, evidence);
      onfinished?.(outcome);
    } catch (e) {
      // A `busy` refusal means a run or an install is already in flight; nothing was started.
      loop = afterKickRefusal(loop, describeFailure(e));
    }
  }

  // The parent's trigger arms the loop — a delivery already on the books confirms WITHOUT a kick
  // (plan R1, final-check M3; `armLoop`).
  $effect(() => {
    if (trigger > seenTrigger) {
      seenTrigger = trigger;
      const armed = armLoop(evidence);
      loop = armed.state;
      if (armed.kick !== null) void kick(armed.kick);
    }
  });

  // And the watcher's pushes feed the machine, which decides absorb / confirm / kick
  // (`onEvidence` — the own-kick absorption and the delivery-ends-the-loop rule live there).
  $effect(() => {
    const next = onEvidence(loop, evidence);
    if (next.state !== loop) loop = next.state;
    if (next.kick !== null) void kick(next.kick);
  });
</script>

<div class="verify">
  <button
    onclick={() => {
      seenTrigger = trigger;
      void kick(1);
    }}
    disabled={loop.stage.stage === "verifying"}
  >
    {loop.stage.stage === "verifying" ? "Checking…" : "Check the background scheduler now"}
  </button>
  <p class="muted small">
    This asks the background scheduler to run the engine once, right now, and reports what came
    back. It can generate today's briefing.
  </p>

  {#if loop.stage.stage === "verifying"}
    <p class="muted">Check {loop.stage.attempt} of {MAX_VERIFY_ATTEMPTS} — waiting for the engine.</p>
  {:else if loop.stage.stage === "watching"}
    <p class="ok">{loop.stage.message}</p>
  {:else if loop.stage.stage === "retrying"}
    <p class="muted">{loop.stage.message}</p>
  {:else if loop.stage.stage === "stopped"}
    <p class="warn-text">{loop.stage.message}</p>
  {:else if loop.stage.stage === "refused"}
    <p class="bad">{loop.stage.message}</p>
  {/if}
</div>

<style>
  .verify {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    align-items: flex-start;
    max-width: 44rem;
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
  p {
    margin: 0;
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
  .bad {
    color: var(--danger);
    white-space: pre-wrap;
  }
</style>
