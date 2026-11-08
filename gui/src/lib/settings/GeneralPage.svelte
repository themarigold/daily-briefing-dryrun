<script lang="ts">
  /**
   * Redesign D — Settings → General: the config's state (moved from the shell, as it was), Briefing, This app
   * (`AppGeneralControls`: notifications, start at login and the engine-notify offer), and Updates. The reserved
   * rows (`prefsRows`) follow; later projects fill them. The app's own controls work whether or not the config
   * loaded; the config's fields follow `ConfigGate`'s rules.
   *
   * Part B (user-directed 2026-10-21): Updates is ONE group — the engine's Update check fields, drawn bare, and the
   * update-check box (`UpdateCheck`: Check now, its last result and its paragraph) in one Tile under one "Updates"
   * legend. Final round 2 (V1): the S-A mockup's order, the two fields first, then Check now and its paragraph, which
   * names the engine's "Check for updates automatically" setting without saying where (final round 3, V15: the
   * fields are not always drawn). Check now is drawn whether or not the config loaded; the line above its row is
   * drawn only while the fields are.
   */
  import type { Snippet } from "svelte";
  import type { ConfigDocument } from "../files";
  import type { NotifyStatus } from "../notify";
  import type { Os } from "../platform";
  import { summaryStatusLines } from "../settings-model";
  import type { SummaryStatus } from "../today";
  import type { UpdateCheckResult } from "../engine";
  import SettingsForm from "../../routes/SettingsForm.svelte";
  import UpdateCheck from "../UpdateCheck.svelte";
  import ActionButton from "../ui/ActionButton.svelte";
  import Tile from "../ui/Tile.svelte";
  import AppGeneralControls from "./AppGeneralControls.svelte";
  import ConfigGate from "./ConfigGate.svelte";
  import type { FormProps } from "./form-props";
  import type { ConfigState } from "./pages";

  interface Props {
    /** The form's props, or `null` while the config is not loaded. */
    form: FormProps | null;
    tab: "form" | "raw";
    config: ConfigState;
    /** The config's state, as the shell holds it: a read failure, the document, a restored edit. */
    loadFailure: string;
    doc: ConfigDocument | null;
    restored: boolean;
    settingsRemovedByUninstall: boolean;
    /** Read the file again (Try again, Reload). */
    onreload: () => void;
    /** This app (`AppGeneralControls`). */
    notify: NotifyStatus | null;
    notifyError: string;
    autostart: boolean | null;
    autostartError: string;
    onrefresh: () => void | Promise<void>;
    os: Os;
    /** Updates (`UpdateCheck`): all five of its props. */
    result: UpdateCheckResult | null;
    loading: boolean;
    checking: boolean;
    error: string;
    oncheck: () => void;
    /** The reserved rows (A's app preferences), drawn after Updates. */
    prefsRows?: Snippet | undefined;
    /** The engine-notify offer saved `config.json` (L8): the shell reloads the form, as after the Calendar's writes. */
    onconfigchanged: () => void;
    /** A2: the status the line under the Briefing form reports (`summaryStatusLines`). */
    aiSummaryStatus?: SummaryStatus | undefined;
  }
  let {
    form,
    tab,
    config,
    loadFailure,
    doc,
    restored,
    settingsRemovedByUninstall,
    onreload,
    notify,
    notifyError,
    autostart,
    autostartError,
    onrefresh,
    os,
    result,
    loading,
    checking,
    error,
    oncheck,
    prefsRows,
    onconfigchanged,
    aiSummaryStatus = { enabled: false, warnings: [] },
  }: Props = $props();
</script>

{#if loadFailure !== ""}
  <p class="bad">{loadFailure}</p>
  <ActionButton onclick={onreload}>Try again</ActionButton>
{:else if doc === null}
  <p class="muted">Loading the config…</p>
{:else}
  {#if restored}
    <p class="kept">
      Your unsaved changes from earlier are still here. Save them, or discard them to reload the
      file.
    </p>
  {/if}
  {#if !doc.exists}
    {#if settingsRemovedByUninstall}
      <!-- M9 LOW pass (L1): the settings were removed by an Uninstall in this session, and its latch refuses
           every settings write until the app restarts — the wizard's `config_create` too — so Setup is not
           offered as the way back. -->
      <p>
        Your settings were removed by Uninstall. To set up again, quit and reopen the app, or run
        <code>daily-briefing init</code> in a terminal.
      </p>
    {:else}
      <p>
        There is no config at this path yet. The Setup wizard creates one (press Setup in the
        header); alternatively run
        <code>daily-briefing init</code> in a terminal. This screen edits an existing config and
        does not create one.
      </p>
    {/if}
  {:else if doc.parseError !== null}
    <p class="bad">
      This file could not be read as a JSON object ({doc.parseError}). Fix it in an editor, or restore
      <code>config.json.bak</code>; Daily Briefing will not replace a file it cannot read.
    </p>
    <ActionButton onclick={onreload}>Reload</ActionButton>
  {:else if form === null}
    <!-- D-M4-T8 checkpoint (L1): valid JSON that is not an object (`[]`, `null`, `42`) parses with no error and no
         draft; the other pages point here, so this says why. -->
    <p class="bad">
      This file is JSON but not a JSON object, so the settings cannot be shown here. Fix it in an editor, or restore
      <code>config.json.bak</code> if there is one.
    </p>
    <ActionButton onclick={onreload}>Reload</ActionButton>
  {/if}
{/if}

<ConfigGate {config} {tab} pointer={false} editorHere={false}>
  {#if form !== null}
    <SettingsForm {...form} sections={["Briefing"]} />
    {#each summaryStatusLines(aiSummaryStatus, os) as line}
      <p class="muted">{line}</p>
    {/each}
  {/if}
</ConfigGate>

<AppGeneralControls {notify} {notifyError} {autostart} {autostartError} {onrefresh} {os} {onconfigchanged} />

<div class="group">
  <Tile>
    <fieldset>
      <legend><h4>Updates</h4></legend>
      <!-- R2-L2: the line about the open JSON editor is said once on this page, under Briefing. -->
      <ConfigGate {config} {tab} pointer={false} editorHere={false} rawLine={false}>
        {#if form !== null}
          <SettingsForm {...form} sections={["Update check"]} bare />
        {/if}
      </ConfigGate>
      <div class:sep={config === "ready" && tab === "form" && form !== null}>
        <UpdateCheck {result} {loading} {checking} {error} {oncheck} />
      </div>
    </fieldset>
  </Tile>
</div>

{@render prefsRows?.()}

<style>
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  p {
    margin: 0 0 8px;
  }
  .bad {
    color: var(--danger);
    white-space: pre-wrap;
  }
  .group {
    margin: 0 0 14px;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  /* The group's name, as SettingsForm draws its legends (Part B). */
  legend {
    float: left;
    width: 100%;
    margin: calc(12px - 0.65rem) 0 0;
    padding: 0 calc(14px - 0.8rem) 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  legend h4 {
    margin: 0;
    font: inherit;
  }
  /* V1: the row line between the hours field and Check now (UpdateCheck's box reaches the tile's edges itself). */
  .sep :global(.updates) {
    border-top: 1px solid var(--tile-border);
  }
</style>
