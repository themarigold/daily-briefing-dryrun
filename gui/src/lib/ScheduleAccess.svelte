<script lang="ts">
  /**
   * T17 — the macOS folder-access grant flow, as ONE reusable component.
   *
   * ⚠ THIS IS THE COMPONENT T16's WIZARD STEP 4 REUSES, exactly as `ScheduleInstall.svelte` is its
   * step 6. Plan R1: *"The wizard is the first-run path only; the Schedule & Access panel is the
   * SAME flow component for existing-config users"*. It therefore takes no route, owns no layout
   * beyond its own controls, and asks its parent to refresh rather than deciding what the
   * surrounding screen does next.
   *
   * ⚠ TWO PRINCIPALS, BOTH GUIDED, AND THAT IS DELIBERATE OVER-SERVICE. The appendix assumes the
   * sidecar inherits the app's grant; plan R1 splits the product into two TCC principals and
   * SPK-1(b)'s inheritance leg is UNRUN. Guiding both costs one extra step in the branch where
   * inheritance turns out to hold, and is the difference between a working briefing and a silently
   * empty one in the branch where it does not.
   *
   * ⚠ NOTHING HERE IS SHOWN OFF macOS (`snapshot.supported`) — appendix T17: *"Assert non-macOS
   * builds never show this step."*
   *
   * ⚠ EVERY DYNAMIC STRING IS `{}`-INTERPOLATED, NEVER `{@html}` (`docs/gui-seam.md` §5). The
   * engine's `advice`, the folder paths and the managed copy's path all come from a config a user
   * wrote; `gui/tests-web/render.check.ts` and `static.check.ts` refuse markup on every surface.
   * The System Settings URLs are printed as TEXT and never rendered as links — this app has no
   * anchors at all (deviation 39).
   */
  import {
    accessOpenSettings,
    accessProbe,
    accessRevealEngine,
    describeAccess,
    describeAccessFailure,
    type AccessSnapshot,
    type ProbeResult,
    type ProtectedRootKey,
    type SettingsPane,
  } from "./access";

  interface Props {
    /** The last `access_snapshot`. `null` before the first one has arrived. */
    snapshot: AccessSnapshot | null;
    /** The launch-time revocation check's result, when one ran. */
    launchProbe?: ProbeResult | null;
    /** Why there is no snapshot, or why the last refresh failed. */
    error?: string | null;
    /** Re-run `access_snapshot` (which re-runs `doctor --json`). The parent owns the call. */
    onrefresh?: () => void | Promise<void>;
    /** True while the parent's refresh is in flight. */
    refreshing?: boolean;
  }
  let {
    snapshot,
    launchProbe = null,
    error = null,
    onrefresh,
    refreshing = false,
  }: Props = $props();

  /** The most recent read this component started, or the launch check's. */
  let probe = $state<ProbeResult | null>(null);
  let probing = $state(false);
  let probeError = $state<string | null>(null);

  let revealed = $state<string | null>(null);
  let revealError = $state<string | null>(null);

  let opened = $state<string | null>(null);
  let openError = $state<string | null>(null);

  /** The launch check's result until this component runs one of its own. */
  const shown = $derived(probe ?? launchProbe);

  async function runProbe(root: ProtectedRootKey): Promise<void> {
    probing = true;
    probeError = null;
    try {
      probe = await accessProbe(root);
    } catch (e) {
      probeError = describeAccessFailure(e);
    } finally {
      probing = false;
    }
  }

  async function reveal(): Promise<void> {
    revealError = null;
    try {
      revealed = await accessRevealEngine();
    } catch (e) {
      revealError = describeAccessFailure(e);
    }
  }

  async function openSettings(pane: SettingsPane): Promise<void> {
    openError = null;
    try {
      opened = await accessOpenSettings(pane);
    } catch (e) {
      openError = describeAccessFailure(e);
    }
  }
</script>

{#if snapshot !== null && snapshot.supported}
  <section class="access">
    <h3>Folder access</h3>

    {#if error !== null}
      <pre class="bad">{error}</pre>
    {/if}

    {#if snapshot.versionChange.kind === "changed" && snapshot.roots.length > 0}
      <!-- The kept half of T21: an ad-hoc-signed app has a cdhash-bound designated requirement, so
           macOS treats every update as a different program and drops the grant. -->
      <p class="warn-text">
        Daily Briefing was updated from {snapshot.versionChange.from} to {snapshot.appVersion}.
        macOS asks for folder access again after an update, so the checks below are worth re-running.
      </p>
    {/if}

    {#if snapshot.roots.length === 0}
      <p class="muted">
        None of the folders your briefing reads is one macOS protects, so nothing needs a folder
        grant. If you add a repository under Desktop, Documents, Downloads or iCloud Drive later,
        the steps for it appear here.
      </p>
    {:else}
      <p>
        Some of the folders your briefing reads are ones macOS protects. Until access is granted,
        the engine skips those repositories and the briefing is quietly thinner than it should be.
      </p>

      <ul class="roots">
        {#each snapshot.roots as root (root.key)}
          <li>
            <p class="root-path">{root.path}</p>
            <p class="muted small">
              In use for: {root.because.join(", ")}
            </p>
            {#each root.denied as denied (denied.path)}
              <!-- ⚠ THE ENGINE'S OWN ADVICE, VERBATIM (appendix T17: displayed unmodified). This
                   app neither rewrites nor summarises it; `access.check.ts` compares this text with
                   `warnFor()`'s own output. -->
              <pre class="advice">{denied.advice}</pre>
            {/each}
          </li>
        {/each}
      </ul>

      {#if snapshot.reposTimedOut}
        <p class="warn-text">
          The engine's folder check ran out of time, so this list may be incomplete.
        </p>
      {/if}

      <!-- ── principal 1: this app ─────────────────────────────────────────────────────────── -->
      <div class="step">
        <h4>1. This app</h4>
        <p>
          A briefing you start from this window is read by <strong>Daily Briefing itself</strong>,
          so this app needs the grant. Checking it asks macOS, which shows its own permission
          dialog the first time. Nothing is read but the folder's listing.
        </p>
        <div class="buttons">
          {#each snapshot.roots as root (root.key)}
            <button onclick={() => runProbe(root.key)} disabled={probing}>
              {probing ? "Checking…" : `Check access to ${root.path}`}
            </button>
          {/each}
        </div>
        {#if shown !== null}
          <p class={shown.access.kind === "ok" ? "ok" : "warn-text"}>{describeAccess(shown)}</p>
          {#if shown.note !== null}
            <p class="muted small">{shown.note}</p>
          {/if}
        {/if}
        {#if probeError !== null}
          <pre class="bad">{probeError}</pre>
        {/if}
      </div>

      <!-- ── principal 2: the managed engine copy ──────────────────────────────────────────── -->
      <div class="step">
        <h4>2. The background copy of the engine</h4>
        <p>
          Your morning briefing is not generated by this app. It is generated by a copy of the engine
          that the background scheduler installed and that macOS treats as a separate program — so
          it needs its own grant, and granting it to this app does not cover it.
        </p>
        {#if snapshot.managedEnginePath !== null}
          <p class="muted small">{snapshot.managedEnginePath}</p>
        {:else}
          <p class="muted small">
            No background scheduler is installed yet, so that copy does not exist. Install one
            first; this step then names the file.
          </p>
        {/if}
        <div class="buttons">
          <button onclick={reveal} disabled={snapshot.managedEnginePath === null}>
            Show it in Finder
          </button>
          <button onclick={() => openSettings("files-and-folders")}>
            Open Files &amp; Folders settings
          </button>
          <button onclick={() => openSettings("full-disk-access")}>
            Open Full Disk Access settings
          </button>
        </div>
        <p class="muted small">
          <strong>Files &amp; Folders</strong> grants access to one protected folder at a time — the
          narrow choice, and the one to prefer. <strong>Full Disk Access</strong> grants access to
          everything on the Mac, including other apps' data; it is the broader alternative, and
          worth choosing only if the narrow one does not work for you. Daily Briefing never needs
          more than the folders your repositories are in.
        </p>
        {#if revealed !== null}
          <p class="muted small">Shown in Finder: {revealed}</p>
        {/if}
        {#if revealError !== null}
          <pre class="bad">{revealError}</pre>
        {/if}
        {#if opened !== null}
          <p class="muted small">Opened: {opened}</p>
        {/if}
        {#if openError !== null}
          <pre class="bad">{openError}</pre>
        {/if}

        <!-- ⚠ THE DEEP LINKS ARE UNVERIFIED ON macOS 26 (appendix T17 names them; nothing in this
             build has opened one). The manual path below is the fallback, and it is always shown
             rather than revealed on failure — a deep link that lands on the wrong pane does not
             report an error. -->
        <details>
          <summary>If the button opens the wrong page</summary>
          <p class="muted small">
            macOS moves these settings between versions, so the button may land on the Privacy &amp;
            Security list instead of the exact pane. From there:
          </p>
          <ol class="muted small">
            <li>Open System Settings, then Privacy &amp; Security.</li>
            <li>Choose Files &amp; Folders, or Full Disk Access for the broader grant.</li>
            <li>
              Use the + button and pick the file shown above, or drag it in from the Finder window
              the first button opens.
            </li>
            <li>Come back here and press Re-check.</li>
          </ol>
          <div class="buttons">
            <button onclick={() => openSettings("privacy-root")}>
              Open Privacy &amp; Security
            </button>
          </div>
          <p class="muted small">
            The buttons open these addresses:
          </p>
          <pre class="muted small">x-apple.systempreferences:com.apple.preference.security?Privacy_Files
x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles
x-apple.systempreferences:com.apple.preference.security?Privacy</pre>
        </details>
      </div>
    {/if}

    <div class="buttons">
      <button onclick={() => onrefresh?.()} disabled={refreshing}>
        {refreshing ? "Checking…" : "Re-check"}
      </button>
    </div>
    <!-- v0.2.1 §3.4: with no config yet (the wizard is still open) doctor can only say `blocked`,
         and that is not news; the check means something once setup has written the config. -->
    {#if snapshot.configMissing}
      <p class="muted small">Engine check: available once setup is finished.</p>
    {:else if snapshot.doctorVerdict !== null}
      <p class="muted small">Engine check: {snapshot.doctorVerdict}.</p>
    {/if}

    {#each snapshot.notes as note (note)}
      <p class="muted small">{note}</p>
    {/each}
  </section>
{/if}

<style>
  .access {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.9rem 1rem;
    background: var(--panel);
    max-width: 44rem;
  }
  h3 {
    margin: 0;
    font-size: 1rem;
  }
  h4 {
    margin: 0 0 0.4rem;
    font-size: 0.92rem;
  }
  p {
    margin: 0;
  }
  .step {
    border-top: 1px solid var(--line);
    padding-top: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .roots {
    margin: 0;
    padding-left: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .root-path {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button {
    font: inherit;
    padding: 0.4rem 0.8rem;
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
  ol {
    margin: 0.3rem 0;
    padding-left: 1.2rem;
  }
  pre {
    margin: 0.3rem 0;
    padding: 0.5rem 0.7rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: 0.8rem;
  }
  pre.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  summary {
    cursor: pointer;
    font-size: 0.85rem;
    color: var(--muted);
  }
</style>
