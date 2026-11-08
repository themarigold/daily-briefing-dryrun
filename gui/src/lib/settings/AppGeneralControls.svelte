<script lang="ts">
  /**
   * B7 (T18/T19) — the "This app" controls on the Settings screen: the notification opt-in and the
   * autostart toggle. These are APP settings, not engine config — they never touch `config_save`
   * except through the one existing offer command. (Redesign D: split out of the old `AppSettings`
   * panel with the state these controls share — the one `busy` flag and the failure line; the
   * command-line tool is `CliShimControl`, Uninstall is `UninstallPanel`.)
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
  import { configOfferNotifyAuto, configRead, describeFailure, type SaveOutcome } from "../files";
  import {
    autostartSetEnabled,
    engineNotifyLine,
    notifyAskExplanation,
    notifySetEnabled,
    suppressedLine,
    type NotifyStatus,
  } from "../notify";
  import type { Os } from "../platform";
  import { notifyOffer, offerNote, offerTakeable, type NotifyOffer } from "../settings-model";
  import Tile from "../ui/Tile.svelte";

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
    /** Redesign D final round 1 (L8): the engine-notify offer saved `config.json`; the Settings form reloads it (as
     *  after the Calendar's own writes), so its "Notifications from the engine" field does not show the old value. */
    onconfigchanged?: (() => void) | undefined;
  }
  let {
    notify,
    notifyError = "",
    autostart,
    autostartError = "",
    onrefresh,
    os,
    onconfigchanged,
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
      const outcome = await configOfferNotifyAuto();
      offerResult = describeOffer(outcome);
      if (outcome.kind === "saved") onconfigchanged?.();
    } catch (e) {
      offerResult = `Not changed: ${describeFailure(e)}`;
    } finally {
      busy = false;
    }
  }
</script>

<!-- Redesign D: the This app group, in Step 0's `Tile`. Each block is a row: its words on the left, its buttons
     on the right (one column below 720 px). -->
<div class="group">
<Tile>
<div class="app-settings">
  <h4>This app</h4>

  <div class="block">
    <h5>Notifications</h5>
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
    <h5>Start at login</h5>
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

  {#if failure !== ""}
    <p class="bad">{failure}</p>
  {/if}
</div>
</Tile>
</div>

<style>
  /* Part B (the S-A mockup): the group's name in small capitals (in --muted: the mockup's faint grey is below 4.5:1
   * on a tile), then rows of words on the left and buttons on the right, 11px 14px, a line between rows. Step 0's
   * Tile pads its content 0.65rem 0.8rem (lib/ui is frozen in wave 1), so the rows reach out to its edges. */
  .group {
    margin: 0 0 14px;
  }
  h4 {
    margin: calc(12px - 0.65rem) 0 0;
    padding: 0 calc(14px - 0.8rem);
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  h5 {
    margin: 0 0 2px;
    font-size: 13px;
    font-weight: 600;
  }
  /* A row: the heading and its words on the left, the buttons on the right (`dense` puts them beside the heading);
   * the engine-notify offer spans both. One column below the 720 px breakpoint. */
  .block {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-auto-flow: row dense;
    column-gap: 12px;
    align-items: center;
    margin: 0 -0.8rem;
    padding: 11px 14px;
  }
  .block > * {
    grid-column: 1;
  }
  .block > .row {
    grid-column: 2;
    grid-row: 1 / span 2;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .block > .offer {
    grid-column: 1 / -1;
  }
  .block + .block {
    border-top: 1px solid var(--tile-border);
  }
  .block:last-of-type {
    margin-bottom: -0.65rem;
  }
  /* Final round 3 (V13): a row's last words end at its 11px padding, not 4px below it. */
  .block > p:last-of-type {
    margin-bottom: 0;
  }
  @media (max-width: 720px) {
    .block {
      grid-template-columns: minmax(0, 1fr);
    }
    .block > .row {
      grid-column: 1;
      grid-row: auto;
      justify-content: flex-start;
      margin-top: 6px;
    }
  }
  p {
    margin: 0 0 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .offer {
    border-top: 1px dashed var(--line);
    padding-top: 8px;
    margin-top: 6px;
  }
  .offer-label {
    font-weight: 600;
    color: var(--fg);
  }
  .result {
    overflow-wrap: anywhere;
  }
  .suppressed {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .bad {
    color: var(--danger);
    font-size: 12px;
  }
  .app-settings > .bad {
    margin: 6px calc(14px - 0.8rem) 0;
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
</style>
