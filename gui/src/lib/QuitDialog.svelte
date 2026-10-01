<script lang="ts">
  /**
   * The explicit-Quit notice (T11), as plan R1 reworded it for delegated scheduling.
   *
   * ⚠ THE COPY IS NOT WRITTEN HERE. Every string below arrives in the `app:quit-requested`
   * payload from `shell::quit_dialog`, so the wording has ONE owner and `tests/shell.rs` can
   * assert it. A second copy in TypeScript is how the tray and the dialog end up saying different
   * things about whether quitting stops your briefings.
   *
   * ⚠ WHY THE WORDING CHANGED. The appendix's warning was "briefings will stop until you reopen".
   * Under R1 that is FALSE — the OS scheduler delivers them and the app is a viewer. Rust words the
   * body for the state it last derived (a working schedule, nothing scheduled, no usable config, or
   * unknown) and offers the Schedule screen when the body points there. Since B7 (T18) the app CAN
   * post the arrival notification behind its own opt-in, and the Scheduled body names that as what
   * quitting stops — conditionally, never claiming the opt-in is on.
   *
   * ⚠ THE `notify: "auto"` OFFER IS TAKEABLE SINCE B5 (plan R1's T11 rework) where Rust says it can
   * work, and its result sentence is built in the script below — so the markup still adds no claim
   * of its own about what quitting does.
   *
   * ⚠ AND ONLY WHEN IT WOULD CHANGE SOMETHING (review round 1). `offer` is the config as it is
   * (`settings-model.ts`, `notifyOffer`, read by App.svelte when the dialog opens): already
   * `"auto"` → no button; the user's own command → no button (Rust refuses it too); a value the
   * engine does not accept → the button, saying the engine currently posts nothing.
   */
  import { configOfferNotifyAuto, describeFailure, type SaveOutcome } from "./files";
  import { offerNote, offerTakeable, type NotifyOffer } from "./settings-model";
  import { appQuit, type QuitDialog } from "./state";

  interface Props {
    dialog: QuitDialog;
    /** The engine's current `notify`, classified. `unknown` keeps the button (Rust answers). */
    offer?: NotifyOffer;
    oncancel: () => void;
    /** Close the dialog and show the Schedule screen (offered when `dialog.scheduleLabel` is set). */
    onschedule?: () => void;
  }
  let { dialog, offer = { kind: "unknown" }, oncancel, onschedule }: Props = $props();
  let failure = $state("");
  let offerBusy = $state(false);
  let offerResult = $state("");

  /** What taking the offer did, in one sentence (the engine's own words for a refusal). */
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

  /** The offer, through the same validated, atomic save as the Settings screen. */
  async function takeOffer(): Promise<void> {
    if (offerBusy) return;
    offerBusy = true;
    offerResult = "";
    try {
      offerResult = describeOffer(await configOfferNotifyAuto());
    } catch (e) {
      offerResult = `Not changed: ${describeFailure(e)}`;
    } finally {
      offerBusy = false;
    }
  }

  async function confirm(): Promise<void> {
    try {
      await appQuit();
    } catch (e) {
      // If the app is still here, the quit was refused — say so rather than leaving a dead button.
      failure = e instanceof Error ? e.message : JSON.stringify(e);
    }
  }
</script>

<div class="scrim" role="dialog" aria-modal="true" aria-label={dialog.title}>
  <div class="panel">
    <h2>{dialog.title}</h2>
    <p>{dialog.body}</p>

    <div class="offer">
      <!-- The label and, when the offer cannot be taken here, the reason are Rust's
           (`shell::quit_dialog_for`). The button calls `config_offer_notify_auto`: the Settings
           screen's validated, atomic save with a one-field change. -->
      {#if dialog.offerAvailable}
        {#if offerTakeable(offer)}
          <button class="offer-button" disabled={offerBusy} onclick={takeOffer}>{dialog.offerLabel}</button>
        {:else}
          <p class="offer-label">{dialog.offerLabel}</p>
        {/if}
        {#if offerNote(offer) !== null}
          <p class="muted offer-note">{offerNote(offer)}</p>
        {/if}
        {#if offerResult !== ""}
          <p class="muted offer-result">{offerResult}</p>
        {/if}
      {:else}
        <p class="offer-label">{dialog.offerLabel}</p>
        {#if dialog.offerUnavailableReason !== null}
          <p class="muted">{dialog.offerUnavailableReason}</p>
        {/if}
      {/if}
    </div>

    {#if failure !== ""}
      <p class="bad">{failure}</p>
    {/if}

    <div class="row">
      {#if dialog.scheduleLabel !== null && onschedule !== undefined}
        <button onclick={onschedule}>{dialog.scheduleLabel}</button>
      {/if}
      <button class="primary" onclick={oncancel}>{dialog.cancelLabel}</button>
      <button onclick={confirm}>{dialog.confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.35);
  }
  .panel {
    max-width: 30rem;
    margin: 1rem;
    padding: 1.1rem 1.25rem;
    border-radius: 0.6rem;
    border: 1px solid var(--line);
    background: var(--panel);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.05rem;
  }
  p {
    margin: 0 0 0.75rem;
  }
  .offer {
    border-top: 1px solid var(--line);
    padding-top: 0.75rem;
  }
  .offer-label {
    font-weight: 600;
    margin-bottom: 0.35rem;
  }
  .offer-button {
    margin-bottom: 0.5rem;
  }
  .offer-result {
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .bad {
    color: var(--danger);
    font-size: 0.85rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    justify-content: flex-end;
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
  button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: transparent;
  }
</style>
