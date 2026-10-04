<script lang="ts">
  /**
   * T14's Schedule screen — the one that makes `last-tick` mean something to a stranger.
   *
   * ⚠ PRESENTATION ONLY (phase → copy and colour); NO DERIVATION. Which phase applies, the tick
   * figures and every threshold come from `src-tauri/src/schedule_state.rs`'s `derive`; this file
   * picks the paragraph and the tone for the phase it is handed, and the badge IS
   * `state.statusLine` — the exact string the tray shows — so the two cannot disagree about the
   * state. The only arithmetic here is unit conversion for display (seconds → minutes) and the
   * browser's own local rendering of an instant.
   *
   * ⚠ EVERY DYNAMIC STRING IS `{}`-INTERPOLATED, NEVER `{@html}` (`docs/gui-seam.md` §5). The
   * engine's skip `detail`, the config loader's message, the unit path and `error` can all carry
   * repo- or user-controlled text; `gui/tests-web/render.check.ts` renders an `<img onerror>`
   * through them and requires it to stay literal.
   */
  import type { AccessSnapshot, ProbeResult } from "../lib/access";
  import { notifyAskExplanation } from "../lib/notify";
  import type { Os } from "../lib/platform";
  import type { ScheduleState } from "../lib/state";
  import type { VerifyEvidence } from "../lib/verify-flow";
  import ScheduleAccess from "../lib/ScheduleAccess.svelte";
  import ScheduleInstall from "../lib/ScheduleInstall.svelte";
  import ScheduleUninstall from "../lib/ScheduleUninstall.svelte";
  import ScheduleVerify from "../lib/ScheduleVerify.svelte";
  // The phase → tone rule lives in one module because the Today screen paints the same status
  // line, and two colourings of one state would be the disagreement this file exists to prevent.
  import { tone } from "../lib/tone";

  interface Props {
    state: ScheduleState | null;
    error?: string | null;
    /** `Snapshot.scheduleStale`: the schedule facts below come from an earlier read. */
    stale?: boolean;
    /** `Snapshot.updatesStopped`: the watcher has stopped, and `error` leads with why. */
    stopped?: boolean;
    /** B6 (T17): the last `access_snapshot`. `null` before the first one. */
    access?: AccessSnapshot | null;
    /** The launch-time revocation check's result, when one ran. */
    launchProbe?: ProbeResult | null;
    accessError?: string | null;
    onaccessrefresh?: () => void | Promise<void>;
    accessRefreshing?: boolean;
    /** B6 (T20): what the verification loop watches — from the same pushed `Snapshot`. */
    evidence?: VerifyEvidence;
    /**
     * Bumped by the parent after an install finishes, which starts the post-install verification
     * loop.
     *
     * ⚠ THE COUNTER LIVES IN `App.svelte`, NOT HERE, AND THAT IS NOT A PREFERENCE. This component's
     * `state` prop makes `$state(...)` parse as a STORE SUBSCRIPTION to it
     * (`svelte.dev/e/store_rune_conflict`), so a rune declared in this file would silently stop
     * being reactive — measured: `svelte-check` reports it as an error plus an "is updated, but is
     * not declared with `$state(...)`" warning. The counter is a plain prop instead.
     *
     * ⚠ IT IS BUMPED ONLY FOR A SUCCESSFUL INSTALL (round 1 — this comment used to call the
     * every-completed-attempt bump deliberate). The loop's kick runs the LIVE scheduler, so a
     * refused install (a foreign-owner exit 2, say) must not carry that side effect; the gate is
     * `install-flow.ts`'s `armsVerify`, applied inside `ScheduleInstall`. An attempt that never
     * reached the engine (an IPC rejection) never called `onfinished` in the first place.
     */
    verifyTrigger?: number;
    oninstalled?: () => void;
    /**
     * B7 (T18): true while the app's notification opt-in has NEVER been asked — the explained
     * ask is surfaced here (and on Settings) because plan T18 forbids a prompt, or a first
     * notification, from a background fire. The choice is `onnotifychoice`; the record and every
     * suppression decision are Rust's (`notifications::on_snapshot`).
     */
    notifyAsk?: boolean;
    /** Why the last choice could not be recorded (Gemini B1, B7 fix round): the ask stays
     *  actionable, and a click that changed nothing says why instead of looking accepted. */
    notifyAskError?: string | null;
    onnotifychoice?: (enabled: boolean) => void;
    /** v0.2.1 §3.5: the OS this window runs on (App's `osFromUserAgent`), for the ask's wording.
     *  REQUIRED, with no default, so a mount that forgets it fails `svelte-check` instead of
     *  silently getting one platform's wording. */
    os: Os;
  }
  let {
    state,
    error = null,
    stale = false,
    stopped = false,
    access = null,
    launchProbe = null,
    accessError = null,
    onaccessrefresh = () => {},
    accessRefreshing = false,
    evidence = { skipIso: null, delivered: false },
    verifyTrigger = 0,
    oninstalled = () => {},
    notifyAsk = false,
    notifyAskError = null,
    onnotifychoice = () => {},
    os,
  }: Props = $props();

  /** A local date-and-time for a UTC instant. The browser's own conversion — no date maths here. */
  function day(iso: string | null): string {
    if (iso === null) return "";
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
  }

</script>

<section class="schedule">
  <h2>Schedule</h2>

  {#if notifyAsk}
    <!-- B7 (T18): the explained notification ask, never a system prompt. "Not now" records the
         choice so the ask does not nag; Settings keeps the toggle either way. -->
    <div class="notify-ask">
      <p>{notifyAskExplanation(os)}</p>
      <div class="ask-row">
        <button type="button" onclick={() => onnotifychoice(true)}>Enable notifications</button>
        <button type="button" onclick={() => onnotifychoice(false)}>Not now</button>
      </div>
      {#if notifyAskError !== null}
        <p class="bad">Your choice could not be recorded: {notifyAskError}</p>
      {/if}
    </div>
  {/if}

  {#if error !== null}
    <!-- The heading names the KIND of error: a stopped watcher is not a failed read, and its
         notice would read wrongly under "could not be read". -->
    <p class="bad">
      {stopped
        ? "This screen is no longer updating on its own:"
        : "Part of the engine's state could not be read:"}
    </p>
    <pre class="bad">{error}</pre>
  {/if}

  {#if state === null}
    <p class="muted">Checking…</p>
  {:else}
    <div class="badge {tone(state)}">{state.statusLine}</div>

    {#if stale}
      <p class="warn-text stale">
        The scheduler's details below are from an earlier check — the latest one failed — so
        today's check counts are shown as unknown.
      </p>
    {/if}

    <div class="sentence">
      {#if state.phase.phase === "not-configured"}
        <p>There is no config yet, so nothing will be generated. Set one up to start.</p>
      {:else if state.phase.phase === "config-error"}
        <p>
          Your config file exists but could not be loaded, so no briefing will be generated until it
          is fixed.
        </p>
        <pre>{state.phase.detail}</pre>
        {#if state.phase.deliveredToday}
          <p class="muted">Today's briefing had already been delivered before this happened.</p>
        {/if}
      {:else if state.phase.phase === "not-scheduled"}
        <p>
          Nothing owns the background trigger, so no briefing will arrive on its own. Installing
          one takes a second and does not change anything else.
        </p>
        {#if state.unitPresent || state.registered === true}
          <p class="muted">
            A scheduler unit does exist on this machine
            {state.unitPath !== null ? ` (${state.unitPath})` : ""}, but there is no ownership
            record beside it — so Daily Briefing cannot tell what it will do.
          </p>
        {/if}
      {:else if state.phase.phase === "scheduler-broken"}
        <p>
          Daily Briefing has a record of the background scheduler being installed, but
          {state.unitPresent
            ? "the operating system does not have it loaded"
            : "its trigger file is missing"}, so no briefing will arrive on its own. Repairing it
          installs the same schedule again.
        </p>
        <div class="prompt">
          <ScheduleInstall
            label="Repair background scheduler"
            purpose="repair the background scheduler"
            owner={state.owner}
            onfinished={oninstalled}
          />
        </div>
      {:else if state.phase.phase === "delivered"}
        <p>
          Today's briefing was delivered. Next: tomorrow, on the first check after {state.floor}.
        </p>
      {:else if state.phase.phase === "waiting-for-floor"}
        <p>
          Nothing is due yet. {state.phase.minutesUntilFloor} minutes until {state.phase.floor}.
        </p>
      {:else if state.phase.phase === "waiting-for-wake"}
        <p>
          It is past {state.floor} and today's briefing has not been generated yet. The checks are
          running; the next one that finds your machine awake will generate it.
        </p>
      {:else if state.phase.phase === "skipped"}
        {#if state.phase.reason === "marker-fail"}
          <p>
            Today's briefing was written, but the engine could not record that it was — so a later
            check today may generate it again.
          </p>
        {:else}
          <p>The last check ran and did not generate a briefing. The engine's reason:</p>
        {/if}
        {#if state.phase.detail !== null}
          <!-- The ENGINE's own line, verbatim. For a usage limit it names a reset time only when
               the engine actually parsed one — this screen never invents one. -->
          <pre>{state.phase.detail}</pre>
        {/if}
        {#if state.phase.iso !== null}
          <p class="muted">Recorded {day(state.phase.iso)}.</p>
        {/if}
      {:else if state.phase.phase === "agent-stale"}
        {#if state.phase.lastTick === null}
          <p>
            No check has been recorded at all, and it is past {state.floor} — by now the background
            scheduler should have run at least once today.
          </p>
        {:else}
          <p>
            The last check was {day(state.phase.lastTick)}, which is more than
            {Math.round(state.phase.staleAfterSecs / 60)} minutes ago.
          </p>
        {/if}
        <p class="muted">
          If your machine was asleep or shut down, this is expected — the next check happens shortly
          after it wakes. If it has been awake, the background scheduler is not running and
          reinstalling it will fix that.
        </p>
      {:else if state.phase.cause === "future"}
        <p>
          The last check is recorded as happening later than this machine's clock says it is now
          {state.lastTick !== null ? ` (${day(state.lastTick.iso)})` : ""}. That usually means the
          clock was changed; until the next check, Daily Briefing cannot tell whether the scheduler
          is running.
        </p>
      {:else if state.phase.cause === "unreadable-instant"}
        <p>
          The heartbeat file records its last check at a time this version cannot read, so whether
          the scheduler is running cannot be judged. It will correct itself at the next check.
        </p>
      {:else}
        <p>
          The heartbeat file is in a format this version does not recognise, so the number of checks
          today is <strong>unknown</strong> — not zero. It will correct itself at the next check.
        </p>
      {/if}
    </div>

    <p class="first-wake">{state.firstWake}</p>
    {#if state.floorWarning !== null}
      <p class="warn-text">{state.floorWarning}</p>
    {/if}

    <dl class="facts">
      <dt>Checks today</dt>
      <dd class="ticks">
        <!-- ⚠ `null` IS RENDERED AS "unknown", NEVER AS 0. `0` is the value that reads as "the
             scheduler never fired" (`docs/gui-seam.md` §2). -->
        {#if state.ticksToday === null}
          unknown
        {:else}
          {state.ticksToday}{state.ticksExpectedSinceFloor !== null
            ? ` (about ${state.ticksExpectedSinceFloor} expected since ${state.floor})`
            : ""}
        {/if}
      </dd>

      <dt>Last check</dt>
      <dd>{state.lastTick !== null ? day(state.lastTick.iso) : "never"}</dd>

      <dt>Scheduled by</dt>
      <dd>
        {#if state.owner === null}
          nothing
        {:else}
          {state.owner === "app" ? "this app" : "the command line"}{state.invoker !== null &&
          state.invoker !== state.owner
            ? ` (installed by ${state.invoker})`
            : ""}
        {/if}
      </dd>

      <dt>Trigger file</dt>
      <dd>{state.unitPath ?? "none"}</dd>

      <dt>Registered</dt>
      <dd>
        {state.registered === null ? "unknown" : state.registered ? "yes" : "no"} · record
        {state.recordPresent ? "present" : "absent"} · unit
        {state.unitPresent ? "present" : "absent"}
      </dd>

      <dt>Interval</dt>
      <dd>
        {state.intervalSec !== null
          ? `every ${Math.round(state.intervalSec / 60)} minutes`
          : "unknown"}
      </dd>

      <dt>Engine</dt>
      <dd>
        {state.engineVersion ?? "unknown"}{state.installedEngineVersion !== null
          ? ` · background copy ${state.installedEngineVersion}`
          : ""}
      </dd>
    </dl>

    {#if state.experimental}
      <p class="warn-text">
        Scheduling on this platform is experimental: there is no runtime evidence that the trigger
        fired, so treat what this screen says about it as unconfirmed.
      </p>
    {/if}
    {#if state.lingerState === "disabled"}
      <p class="warn-text">
        Lingering is disabled for your user, so the timer will not fire while you are logged out.
      </p>
    {/if}

    {#if state.engineUpdateAvailable}
      <div class="prompt">
        <p>
          The background copy of the engine is version {state.installedEngineVersion}, and this app
          ships {state.engineVersion}. Re-installing the schedule updates it and keeps your existing
          notification setting and owner.
        </p>
        <ScheduleInstall
          label="Update background engine"
          purpose="update the background engine"
          owner={state.owner}
          onfinished={oninstalled}
        />
      </div>
    {/if}

    <!-- ⚠ ONE install/repair control per screen: SCHEDULER-BROKEN already offers its repair above,
         so the generic one is not repeated there. -->
    {#if state.phase.phase !== "scheduler-broken"}
      <div class="actions">
        <ScheduleInstall owner={state.owner} onfinished={oninstalled} />
      </div>
    {/if}

    <!-- B6 (T20): the post-install verification loop, and the removal. Both are offered only where
         there is a record to verify or remove — `recordPresent` is authoritative (gui-seam §3). -->
    {#if state.recordPresent}
      <div class="actions">
        <ScheduleVerify {evidence} trigger={verifyTrigger} />
      </div>
      <div class="actions">
        <ScheduleUninstall scheduleState={state} />
      </div>
    {/if}
  {/if}

  <!-- B6 (T17): the folder-access flow. ALWAYS rendered — it is the Schedule & Access panel plan R1
       makes available to existing-config users — and it draws nothing at all off macOS, or when no
       protected folder is in scope beyond a line saying so. -->
  <ScheduleAccess
    snapshot={access}
    {launchProbe}
    error={accessError}
    onrefresh={onaccessrefresh}
    refreshing={accessRefreshing}
  />
</section>

<style>
  .schedule {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .notify-ask {
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    padding: 0.7rem 0.9rem;
  }
  .notify-ask p {
    margin: 0 0 0.6rem;
  }
  .ask-row {
    display: flex;
    gap: 0.6rem;
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
  }
  .badge {
    align-self: flex-start;
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .badge.info {
    background: var(--panel);
  }
  .badge.warn {
    border-color: var(--danger);
  }
  .badge.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  .sentence p {
    margin: 0 0 0.5rem;
    max-width: 44rem;
  }
  .first-wake {
    margin: 0;
    max-width: 44rem;
    color: var(--muted);
  }
  .warn-text {
    margin: 0;
    max-width: 44rem;
    color: var(--danger);
  }
  .muted {
    color: var(--muted);
  }
  .facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0;
    font-size: 0.88rem;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .prompt {
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.8rem 1rem;
    background: var(--panel);
    max-width: 44rem;
  }
  .prompt p {
    margin: 0 0 0.6rem;
  }
  pre {
    margin: 0.3rem 0 0.6rem;
    padding: 0.55rem 0.75rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    background: var(--panel);
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: 0.8rem;
  }
  .bad {
    color: var(--danger);
  }
</style>
