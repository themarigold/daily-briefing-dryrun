<script lang="ts">
  /**
   * The app shell's webview half (T10/T11/T14, and B5's T12/T13/T15 screens).
   *
   * What it owns: the four screens' routing, the tray's navigation events, the live
   * `state:changed` feed, the Run Now state (the tray's Run Now lands here, so its progress has a
   * screen), the Quit notice and the one-time tray-unavailable notice. What it deliberately does NOT own: any
   * opinion about what the engine's state means — that is one Rust function
   * (`schedule_state::derive`), and this file renders its output. The tray's status line renders
   * the same object.
   *
   * ⚠ NOTHING RUNS THE ENGINE ON MOUNT EXCEPT `state_snapshot`, which is `status --json` plus
   * `schedule status --json` — both pure reads. An auto-`run()` would generate a briefing and
   * stamp the day before the user agreed to anything.
   *
   * ⚠ THE LISTENERS ARE REGISTERED BEFORE THE FIRST `state_snapshot`. That call is where Rust
   * delivers the one-time tray-unavailable notice, precisely because it is the first moment the
   * webview is known to be listening.
   *
   * ⚠ EVERY ENGINE-DERIVED STRING IS `{}`-INTERPOLATED (`docs/gui-seam.md` §5). No `{@html}`.
   */
  import { onMount } from "svelte";
  import {
    accessProbe,
    accessSnapshot,
    describeAccessFailure,
    launchActions,
    type AccessSnapshot,
    type ProbeResult,
  } from "./lib/access";
  import {
    detailsOpen,
    onProgress,
    run,
    type EngineOutcome,
    type LastRunResult,
    type ProgressEvent,
  } from "./lib/engine";
  import { configRead, describeFailure } from "./lib/files";
  import { archiveList, keepArchive } from "./lib/history";
  import { notifySetEnabled, notifyStatus } from "./lib/notify";
  import { osFromUserAgent } from "./lib/platform";
  import { notifyOffer, type NotifyOffer } from "./lib/settings-model";
  import QuitDialog from "./lib/QuitDialog.svelte";
  import { envelopeOf, type RunEnvelope } from "./lib/today";
  import History from "./routes/History.svelte";
  import Schedule from "./routes/Schedule.svelte";
  import Settings from "./routes/Settings.svelte";
  import Today from "./routes/Today.svelte";
  import Wizard from "./routes/Wizard.svelte";
  import {
    onNavigate,
    onQuitRequested,
    onRunNow,
    onStateChanged,
    onTrayUnavailable,
    stateSnapshot,
    type QuitDialog as QuitDialogCopy,
    type Route,
    type Snapshot,
  } from "./lib/state";

  let route = $state<Route>("today");
  /** v0.2.1 §3.5: the OS wording (the wizard's, and the notification ask's on Schedule and
   *  Settings) comes from the webview's own user agent — no Tauri command (that would change the
   *  pinned capability surface). */
  const os = osFromUserAgent(navigator.userAgent);
  let snapshot = $state<Snapshot | null>(null);
  /** Why the very first snapshot could not be fetched at all (a missing sidecar, typically). */
  let snapshotError = $state<string | null>(null);
  let quit = $state<QuitDialogCopy | null>(null);
  /** What the open Quit dialog offers for the engine's `notify` (read when it opens). */
  let quitOffer = $state<NotifyOffer>({ kind: "checking" });
  let quitSeq = 0;
  /** History's list: the last KNOWN `archivedDates` (`null` until a status read succeeds), kept
   *  across a failed read so an open briefing does not vanish (review round 1, M6). */
  let archive = $state<string[] | null>(null);
  let trayNotice = $state<string | null>(null);

  /** B6 (T17): the last `access_snapshot`, the launch-time revocation check, and their trouble. */
  let access = $state<AccessSnapshot | null>(null);
  let accessError = $state<string | null>(null);
  let accessRefreshing = $state(false);
  let launchProbe = $state<ProbeResult | null>(null);
  /** Set when the launch-time revocation check found the app's grant gone. */
  let revoked = $state(false);
  /**
   * B6 (T20): bumped after a SUCCESSFUL install (round 1: `ScheduleInstall` gates `onfinished` on
   * `armsVerify` — a refused or failed install must not kick the live scheduler), which starts
   * the post-install verification loop on the Schedule screen.
   *
   * ⚠ IT LIVES HERE RATHER THAN IN `Schedule.svelte` because that component's `state` prop makes
   * `$state(...)` parse as a store subscription to it (`svelte.dev/e/store_rune_conflict`), so a
   * rune declared there would silently stop being reactive.
   */
  let verifyTrigger = $state(0);

  /**
   * B7 (T18): the app's notification opt-in as last read — `undefined` before the first read (no
   * ask shown yet), `null` = never asked (the Schedule screen surfaces the explained ask),
   * `true`/`false` = answered. The record and every posting decision are Rust's; this is only
   * which UI to show. One `notify_status` at mount (one `status --json` spawn); the Settings
   * screen re-reads its own on entry.
   */
  let notifyEnabled = $state<boolean | null | undefined>(undefined);
  /** Why the last ask choice could not be recorded — shown under the ask, which stays actionable. */
  let notifyAskError = $state<string | null>(null);

  async function chooseNotifications(enabled: boolean): Promise<void> {
    notifyAskError = null;
    try {
      await notifySetEnabled(enabled);
      notifyEnabled = enabled;
    } catch (e) {
      // The ask stays (notifyEnabled is still null) — but a click that did nothing must say
      // why, or Enable looks broken and "Not now" looks accepted (Gemini B1, B7 fix round).
      notifyAskError = describeFailure(e);
    }
  }

  let running = $state(false);
  let progress = $state<string[]>([]);
  let runResult = $state("");
  /** The last Run Now's result — whether Today's Details disclosure starts open (`detailsOpen`). */
  let lastRunResult = $state.raw<LastRunResult>(null);
  /** Today's `detailsOpen` prop, held in an explicit `$derived` so it changes only when its VALUE does:
   *  a run that ends `delivered` after the run-start `null` (false to false) is no change, and Today's
   *  disclosure keeps the user's toggle (`routes/TodayView.svelte`, the comment on `open`). */
  const detailsOpenNow = $derived(detailsOpen(lastRunResult));
  /** The envelope of the last run this app started — Today shows its struct while it is the file. */
  let lastRun = $state.raw<RunEnvelope | null>(null);

  /**
   * B8 (T16): the wizard's entry is the existing no-config state (`docs/gui-seam.md` :1180) —
   * ONCE per session, on the first snapshot that reports it, so leaving the wizard ("Set up
   * later") is respected rather than re-routed on the next `state:changed`.
   */
  let wizardOffered = $state(false);

  function applySnapshot(next: Snapshot): void {
    snapshot = next;
    snapshotError = next.error;
    archive = keepArchive(archive, next);
    if (!wizardOffered && next.scheduleState?.phase.phase === "not-configured") {
      wizardOffered = true;
      route = "wizard";
    }
  }

  function openQuit(dialog: QuitDialogCopy): void {
    quit = dialog;
    const mine = ++quitSeq;
    if (!dialog.offerAvailable) return;
    quitOffer = { kind: "checking" };
    configRead()
      .then((doc) => {
        if (mine === quitSeq) quitOffer = notifyOffer(doc.text);
      })
      .catch(() => {
        if (mine === quitSeq) quitOffer = { kind: "unknown" };
      });
  }

  async function refresh(): Promise<void> {
    try {
      applySnapshot(await stateSnapshot());
    } catch (e) {
      // A `#[tauri::command]` rejection arrives as the serialised `EngineError`, not as an Error.
      snapshotError = describeFailure(e);
    }
  }

  /**
   * The folder-access snapshot — the Re-check button, and the app's own launch check.
   *
   * ⚠ NOT ON A TIMER AND NOT ON `state:changed`. It runs `doctor --json`, a repo walk that can take
   * up to 20 s; on mount and on demand is the whole of it.
   *
   * ⚠ AND THE LAUNCH-TIME READ IS GATED IN RUST. `launchActions` reads `probeAdvice`, which is
   * `revocation-check` only when a protected root is in scope AND a grant has already been observed
   * (`access::probe_advice`). Without that gate this call would raise an unexplained macOS
   * permission dialog at every launch — exactly what plan R1's deselected-by-default protected-roots
   * graft exists to prevent.
   */
  async function refreshAccess(atLaunch: boolean): Promise<void> {
    accessRefreshing = true;
    try {
      const next = await accessSnapshot();
      access = next;
      accessError = null;
      if (!atLaunch) return;
      const actions = launchActions(next);
      if (actions.probe === null) return;
      launchProbe = await accessProbe(actions.probe);
      revoked = launchProbe.access.kind === "denied";
    } catch (e) {
      accessError = describeAccessFailure(e);
    } finally {
      accessRefreshing = false;
    }
  }

  /** One human sentence for a finished run. The engine's own lines are in `progress`. */
  function describe(outcome: EngineOutcome): string {
    switch (outcome.outcome.kind) {
      case "delivered":
        return "Done — today's briefing was generated.";
      case "skipped":
        return `The engine did not generate a briefing (${outcome.outcome.reason ?? "no reason given"}).`;
      case "failed":
        return `The run failed (${outcome.outcome.reason ?? `exit ${outcome.exitCode ?? "by signal"}`}).`;
      case "configError":
        return "The engine refused to run — see Details below.";
    }
  }

  async function runNow(): Promise<void> {
    if (running) return;
    running = true;
    progress = [];
    runResult = "";
    lastRunResult = null;
    try {
      const outcome = await run({ force: false });
      runResult = describe(outcome);
      lastRunResult = { outcome };
      const envelope = envelopeOf(outcome.payload);
      if (envelope !== null) lastRun = envelope;
    } catch (e) {
      // A `busy` refusal says which operation is already running; nothing was started.
      runResult = describeFailure(e);
      lastRunResult = { threw: true };
    } finally {
      running = false;
      // The watcher will push a `state:changed` of its own once the engine's files settle; this
      // is for the case where the run changed nothing on disk (a skip) and no event follows.
      await refresh();
    }
  }

  onMount(() => {
    const unlisteners: Promise<() => void>[] = [
      onStateChanged((next) => {
        applySnapshot(next);
      }),
      onNavigate((next) => {
        route = next;
      }),
      onRunNow(() => {
        void runNow();
      }),
      onQuitRequested((dialog) => {
        openQuit(dialog);
      }),
      onTrayUnavailable((notice) => {
        trayNotice = notice;
      }),
      onProgress((event: ProgressEvent) => {
        // Only a RUN's lines belong on Today; an install's stderr is the Schedule screen's.
        if (event.operation === "run") progress = [...progress, event.line];
      }),
    ];
    // `allSettled`, not `all`: a listener that failed to register must not also stop the first
    // snapshot from being fetched.
    void Promise.allSettled(unlisteners).then(() => refresh());
    // The access check is separate and deliberately NOT awaited with it: it runs `doctor --json`,
    // which walks the repositories and can take 20 s, and the Today screen must not wait for it.
    void refreshAccess(true);
    // B7 (T18): whether the notification ask has ever been answered — for the Schedule screen's
    // explained ask. A failed read shows no ask (Settings still carries the toggle).
    void notifyStatus()
      .then((s) => (notifyEnabled = s.enabled))
      .catch(() => {});
    return () => {
      for (const pending of unlisteners) void pending.then((off) => off()).catch(() => {});
    };
  });
</script>

<main>
  <header>
    <h1>Daily Briefing</h1>
    <nav>
      {#if route === "wizard" || snapshot?.scheduleState?.phase.phase === "not-configured"}
        <button class:active={route === "wizard"} onclick={() => (route = "wizard")}>Setup</button>
      {/if}
      <button class:active={route === "today"} onclick={() => (route = "today")}>Today</button>
      <button class:active={route === "history"} onclick={() => (route = "history")}
        >History</button
      >
      <button class:active={route === "schedule"} onclick={() => (route = "schedule")}
        >Schedule</button
      >
      <button class:active={route === "settings"} onclick={() => (route = "settings")}
        >Settings</button
      >
    </nav>
  </header>

  {#if trayNotice !== null}
    <div class="notice" role="status">
      <p>{trayNotice}</p>
      <button onclick={() => (trayNotice = null)}>Dismiss</button>
    </div>
  {/if}

  <!-- B6 (T17): the launch-time REVOCATION detector found the app's folder access gone. This is the
       failure plan R1 calls the worst user-visible outcome in the design — the app updates, the
       next morning's briefing is empty, and the cause is invisible. -->
  {#if revoked}
    <div class="notice" role="status">
      <p>
        macOS is no longer letting Daily Briefing read {launchProbe?.path ?? "a protected folder"}.
        Until that is granted again, repositories in there are skipped and your briefing will be
        thinner than it should be.
      </p>
      <button
        onclick={() => {
          revoked = false;
          route = "schedule";
        }}>Fix it</button
      >
    </div>
  {/if}

  <div class="screen">
  {#if route === "today"}
    <Today
      {snapshot}
      {lastRun}
      {running}
      {progress}
      {runResult}
      detailsOpen={detailsOpenNow}
      onrun={runNow}
    />
    {#if snapshot === null && snapshotError !== null}
      <pre class="failed">{snapshotError}</pre>
    {/if}
  {:else if route === "history"}
    <History dates={archive} error={snapshotError} stale={archiveList(snapshot) === null} />
  {:else if route === "schedule"}
    <Schedule
      state={snapshot?.scheduleState ?? null}
      error={snapshotError}
      stale={snapshot?.scheduleStale ?? false}
      stopped={snapshot?.updatesStopped ?? false}
      {access}
      {launchProbe}
      {accessError}
      {accessRefreshing}
      onaccessrefresh={() => refreshAccess(false)}
      {verifyTrigger}
      oninstalled={() => (verifyTrigger += 1)}
      evidence={{
        skipIso: snapshot?.lastSkip?.iso ?? null,
        delivered: snapshot?.scheduleState?.phase.phase === "delivered",
      }}
      notifyAsk={notifyEnabled === null}
      {notifyAskError}
      onnotifychoice={(enabled) => void chooseNotifications(enabled)}
      {os}
    />
  {:else if route === "wizard"}
    <!-- B8 (T16): the first-run wizard. It performs its OWN config_read / access_snapshot /
         doctor calls; what it takes from here is only the live pushed state its step 6 watches
         and the notification ask's record state (dev 107: same command, same copy). -->
    <Wizard
      scheduleState={snapshot?.scheduleState ?? null}
      {os}
      evidence={{
        skipIso: snapshot?.lastSkip?.iso ?? null,
        delivered: snapshot?.scheduleState?.phase.phase === "delivered",
      }}
      notifyAsk={notifyEnabled === null}
      {notifyAskError}
      onnotifychoice={(enabled) => void chooseNotifications(enabled)}
      oncancel={() => (route = "today")}
      onfinished={() => {
        route = "today";
        void refresh();
        void refreshAccess(false);
      }}
    />
  {:else}
    <Settings {os} />
  {/if}
  </div>
</main>

{#if quit !== null}
  <QuitDialog
    dialog={quit}
    offer={quitOffer}
    oncancel={() => (quit = null)}
    onschedule={() => {
      quit = null;
      route = "schedule";
    }}
  />
{/if}

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h1 {
    margin: 0;
    font-size: 1.6rem;
    letter-spacing: -0.01em;
  }
  .screen {
    margin-top: 1.75rem;
  }
  nav {
    display: flex;
    gap: 0.35rem;
  }
  nav button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    padding: 0.3rem 0.6rem;
  }
  nav button.active {
    color: inherit;
    border-color: var(--line);
    background: var(--panel);
  }
  button {
    font: inherit;
    padding: 0.55rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  pre {
    margin-top: 1rem;
    padding: 0.9rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--panel);
    overflow-x: auto;
    font-size: 0.82rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  pre.failed {
    border-color: var(--danger);
    color: var(--danger);
  }
  .notice {
    margin-top: 1rem;
    padding: 0.7rem 0.9rem;
    border: 1px solid var(--danger);
    border-radius: 0.5rem;
    display: flex;
    gap: 0.8rem;
    align-items: flex-start;
    justify-content: space-between;
  }
  .notice p {
    margin: 0;
  }
  .notice button {
    background: transparent;
    color: inherit;
    padding: 0.2rem 0.6rem;
  }
</style>
