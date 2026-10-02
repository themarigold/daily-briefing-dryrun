<script lang="ts">
  /**
   * B7 (T18/T19) — the "This app" panel on the Settings screen: the notification opt-in and the
   * autostart toggle. These are APP settings, not engine config — they live above the engine's
   * form and never touch `config_save` except through the one existing offer command.
   *
   * ⚠ THE NOTIFICATION ASK IS EXPLAINED, AND NOTHING POSTS BEFORE IT IS ANSWERED. Rust suppresses
   * every firing while the opt-in record says never-asked or off (`notifications::on_snapshot`);
   * this panel is where the record is set, with `NOTIFY_ASK_EXPLANATION` on screen — plan T18's
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
    autostartLine,
    consentLabel,
    doneNotes,
    executeLabel,
    outcomeLine,
    uninstallExecute,
    uninstallPreview,
    SCHEDULER_NOTE,
    UNINSTALL_EXPLANATION,
    type UninstallPreview,
    type UninstallReport,
  } from "./app-uninstall";
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
    notifySetEnabled,
    suppressedLine,
    NOTIFY_ASK_EXPLANATION,
    type NotifyStatus,
  } from "./notify";
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
  }
  let { notify, notifyError = "", autostart, autostartError = "", onrefresh }: Props = $props();

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
      shimError = describeShimFailure(e);
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
      shimError = describeShimFailure(e);
    } finally {
      shimBusy = false;
    }
  }

  /**
   * B25 (T25): the uninstall action. Nothing loads and nothing is removed until the user asks —
   * the preview (one `status --json` spawn plus stats) runs on the first click, the consent
   * checkbox defaults OFF, and the engine-data leg happens only with it ticked. The wording is
   * `./app-uninstall`'s, pure and pinned; what may be removed at all is Rust's.
   */
  let uninstall = $state<UninstallPreview | null>(null);
  let uninstallReport = $state<UninstallReport | null>(null);
  let uninstallError = $state("");
  let uninstallBusy = $state(false);
  let consent = $state(false);

  async function openUninstall(): Promise<void> {
    if (uninstallBusy) return;
    uninstallBusy = true;
    uninstallError = "";
    try {
      uninstall = await uninstallPreview();
      consent = false;
    } catch (e) {
      uninstall = null;
      uninstallError = describeFailure(e);
    } finally {
      uninstallBusy = false;
    }
  }

  function cancelUninstall(): void {
    uninstall = null;
    consent = false;
    uninstallError = "";
  }

  async function runUninstall(): Promise<void> {
    if (uninstallBusy || uninstall === null) return;
    uninstallBusy = true;
    uninstallError = "";
    try {
      uninstallReport = await uninstallExecute(consent);
      uninstall = null;
      consent = false;
      await onrefresh();
    } catch (e) {
      uninstallError = describeFailure(e);
    } finally {
      uninstallBusy = false;
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
        <p>{NOTIFY_ASK_EXPLANATION}</p>
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
        <p>Notifications are off. {NOTIFY_ASK_EXPLANATION}</p>
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
    {#if uninstallReport !== null}
      <p>Done. What happened to each piece:</p>
      <ul class="muted report">
        <li>{autostartLine(uninstallReport.autostart)}</li>
        {#each uninstallReport.app as line (line.name)}
          <li>{outcomeLine(line)}</li>
        {/each}
        {#each uninstallReport.engine as line (line.name)}
          <li>engine: {outcomeLine(line)}</li>
        {/each}
        {#if uninstallReport.engineStateDir !== null}
          <!-- Round-1 fix M3: the report says WHERE the engine-data leg landed — the execute-time
               `status --json` answer, so the consented target is auditable after the fact. -->
          <li>engine state directory: {uninstallReport.engineStateDir}</li>
        {/if}
        {#if uninstallReport.engineRefused !== null}
          <!-- Phase E final harden round 2: a schedule record refuses the WHOLE engine leg — the
               schedule would keep running the engine copy and re-create what was removed — so the
               one line says nothing was removed and names the way out (`uninstall.rs`). -->
          <li class="bad">engine data: nothing removed — {uninstallReport.engineRefused}</li>
        {/if}
        {#if uninstallReport.engineError !== null}
          <li class="bad">engine data: not removed — {uninstallReport.engineError}</li>
        {/if}
      </ul>
      <!-- R4: the warning that a schedule outlives the app comes BEFORE the finish line; both are
           `doneNotes`'s words, from the report's EXECUTE-time schedule facts (round 3, A3-L2), and
           pinned in `tests-web/coexistence.check.ts`. -->
      {@const notes = doneNotes(uninstallReport)}
      {#if notes.warning !== null}
        <p class="bad">{notes.warning}</p>
      {/if}
      <p class="muted">{notes.finish}</p>
    {:else if uninstall === null}
      <p>{UNINSTALL_EXPLANATION}</p>
      <div class="row">
        <button disabled={uninstallBusy} onclick={() => void openUninstall()}>Uninstall app…</button>
      </div>
    {:else}
      <p>{UNINSTALL_EXPLANATION}</p>
      <p class="muted small">{SCHEDULER_NOTE}</p>
      <label class="consent">
        <input type="checkbox" bind:checked={consent} disabled={uninstallBusy} />
        <span>{consentLabel(uninstall)}</span>
      </label>
      {#if uninstall.engineError !== null}
        <p class="muted small">
          The engine could not report where its data lives ({uninstall.engineError}) — the
          engine-data box above will not remove anything until it can.
        </p>
      {/if}
      <div class="row">
        <!-- B6's ScheduleUninstall affordance (round-1 fix M2): the destructive action is marked
             as one — this button's consented leg can remove the briefing archive. Its words say
             what clicking WILL do (`executeLabel`, round 3): ticked under a schedule, engine data
             stays. -->
        <button class="danger" disabled={uninstallBusy} onclick={() => void runUninstall()}>
          {executeLabel(consent, uninstall)}
        </button>
        <button disabled={uninstallBusy} onclick={cancelUninstall}>Cancel</button>
      </div>
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
  .report {
    margin: 0 0 0.6rem;
    padding-left: 1.1rem;
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
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
