<script lang="ts">
  /**
   * T15 — the Settings screen: the engine's config, as a form and as raw JSON, saved through ONE
   * path (`config_save`, `src-tauri/src/config_save.rs`).
   *
   * ⚠ BOTH TABS SEND THE SAME THING — JSON TEXT, plus the `base` token from the load. Rust decides
   * where it goes (`status --json`'s `paths.configPath`, never this app's own config directory),
   * refuses a `transcripts` change and a new literal API key from either tab, has the ENGINE
   * validate it (errors block, warnings do not), and replaces the file atomically with a `.bak`.
   * Nothing here validates a config: a second validator is the drift the engine's
   * `config validate` exists to prevent.
   *
   * ⚠ IT EDITS AN EXISTING CONFIG. With no config file it points at the first-run wizard (B8's
   * `config_create` path — or `daily-briefing init` in a terminal) — unless an Uninstall removed the
   * settings in this app session, whose latch refuses that path too (M9 LOW pass, L1); with one that
   * is not JSON it says so and changes nothing.
   *
   * ⚠ AN UNSAVED EDIT SURVIVES LEAVING THE SCREEN. Switching to another screen unmounts this one;
   * a changed draft (or raw text) is kept in memory (`keepSettings`) and restored on return, with a
   * line saying so. A webview reload or an app restart starts from the file. The kept draft keeps
   * its `base` token, so a file that changed meanwhile is still refused as a conflict. A draft kept
   * while its own save was in flight is dropped when that save lands (`keptAfterSave`).
   *
   * Directory fields are plain text: `tauri-plugin-dialog` is not a dependency of this build
   * (docs/gui-seam.md §10). Copy and paste in these inputs rely on the macOS app menu's Edit
   * submenu, which `shell::app_menu_spec` keeps.
   */
  import { onDestroy, onMount } from "svelte";
  import {
    configRead,
    configSave,
    describeFailure,
    type ConfigDocument,
    type SaveOutcome,
  } from "../lib/files";
  import {
    formSubmission,
    keepSettings,
    parseDraft,
    rawFromDraft,
    removeStoredApiKey,
    settleKeptSettings,
    takeKeptSettings,
    useDefault,
    useEmptyList,
    writeField,
    writeNotifyCommand,
    type Draft,
    type Field,
  } from "../lib/settings-model";
  import AppSettings from "../lib/AppSettings.svelte";
  import UpdateCheck from "../lib/UpdateCheck.svelte";
  import { status, updateCheck, type UpdateCheckResult } from "../lib/engine";
  import { parseUpdateResult, updateFromStatus } from "../lib/update-check";
  import {
    autostartIsEnabled,
    notifyStatus,
    type NotifyStatus,
  } from "../lib/notify";
  import type { Os } from "../lib/platform";
  import type { UninstallReport } from "../lib/app-uninstall";
  import SaveReport from "./SaveReport.svelte";
  import SettingsForm from "./SettingsForm.svelte";

  interface Props {
    /** v0.2.1 §3.5: the OS this window runs on (App's `osFromUserAgent`), handed to the "This app"
     *  panel for the notification ask's wording. REQUIRED, with no default, so a mount that
     *  forgets it fails `svelte-check` instead of silently getting one platform's wording. */
    os: Os;
    /** M9 round 3: the Uninstall execute's report and in-flight state, held by App so they outlive this
     *  screen (`App.svelte`), and its start and end — passed straight through to the "This app" panel. M9
     *  LOW pass (L5): REQUIRED, with no default, like `os`. */
    uninstallReport: UninstallReport | null;
    uninstallRunning: boolean;
    onuninstallstarted: () => void;
    onuninstallended: (report: UninstallReport | null) => void;
    /** M9 LOW pass (L1): an Uninstall in this app session removed `config.json` (App latches it for the
     *  session, as Rust's "settings removed" latch is never cleared), so every settings write — the Setup
     *  wizard's `config_create` included — is refused until the app restarts, and the no-config sentence says
     *  what still works instead of pointing at Setup. REQUIRED, with no default. */
    settingsRemovedByUninstall: boolean;
  }
  let {
    os,
    uninstallReport,
    uninstallRunning,
    onuninstallstarted,
    onuninstallended,
    settingsRemovedByUninstall,
  }: Props = $props();

  /** B7 (T18/T19): the "This app" panel's state — the notification opt-in and the REAL autostart
   *  state (`is_enabled()`, re-fetched after every change; never a cached boolean). */
  let appNotify = $state<NotifyStatus | null>(null);
  let appNotifyError = $state("");
  let appAutostart = $state<boolean | null>(null);
  let appAutostartError = $state("");

  async function loadApp(): Promise<void> {
    try {
      appNotify = await notifyStatus();
      appNotifyError = "";
    } catch (e) {
      appNotify = null;
      appNotifyError = describeFailure(e);
    }
    try {
      appAutostart = await autostartIsEnabled();
      appAutostartError = "";
    } catch (e) {
      appAutostart = null;
      appAutostartError = describeFailure(e);
    }
  }

  /** Phase E (E12): the update panel's state. `status --json` supplies the LAST recorded answer on
   *  mount (a pure read, no network); "Check now" replaces it with a fresh one. */
  let update = $state<UpdateCheckResult | null>(null);
  let updateLoading = $state(true);
  let updateChecking = $state(false);
  let updateError = $state("");

  async function loadUpdate(): Promise<void> {
    try {
      update = updateFromStatus(await status());
      updateError = "";
    } catch (e) {
      updateError = describeFailure(e);
    } finally {
      updateLoading = false;
    }
  }

  /** THE ONE CALL SITE of `updateCheck()` in this webview — the "Check now" button. Nothing calls it
   *  on mount, on a timer or from the wizard. Not gated on a run being in flight: Rust admits it
   *  regardless (`Operation::UpdateCheck` takes no in-flight guard). */
  async function checkNow(): Promise<void> {
    if (updateChecking) return;
    updateChecking = true;
    updateError = "";
    try {
      const outcome = await updateCheck();
      const result = parseUpdateResult(outcome.payload);
      if (result === null) {
        const exit = outcome.exitCode === null ? "killed by a signal" : `exit ${outcome.exitCode}`;
        updateError = `The engine did not return an update-check result (${exit}).${outcome.stderr.trim() !== "" ? `\n${outcome.stderr.trim()}` : ""}`;
      } else {
        update = result;
      }
    } catch (e) {
      updateError = describeFailure(e);
    } finally {
      updateChecking = false;
    }
  }

  let doc = $state<ConfigDocument | null>(null);
  let loadFailure = $state("");
  let tab = $state<"form" | "raw">("form");
  let draft = $state<Draft | null>(null);
  let raw = $state("");
  let errors = $state<Record<string, string>>({});
  let outcome = $state<SaveOutcome | null>(null);
  let failure = $state("");
  let saving = $state(false);
  /** True when this mount restored an unsaved edit from an earlier visit to the screen. */
  let restored = $state(false);

  async function load(keepReport: boolean): Promise<void> {
    restored = false;
    try {
      const next = await configRead();
      doc = next;
      draft = next.text === null ? null : parseDraft(next.text);
      raw = next.text ?? "";
      errors = {};
      loadFailure = "";
    } catch (e) {
      loadFailure = describeFailure(e);
    }
    if (!keepReport) {
      outcome = null;
      failure = "";
    }
  }

  onMount(() => {
    void loadApp();
    void loadUpdate();
    const k = takeKeptSettings();
    if (k === null) {
      void load(false);
      return;
    }
    // The path and flags are re-read; the edit and its base token are the kept ones. If the file
    // is gone or no longer JSON, the kept edit has nothing to apply to: show the file as it is.
    void configRead()
      .then((next) => {
        if (next.text === null) {
          doc = next;
          draft = null;
          raw = "";
          return;
        }
        doc = { ...next, base: k.base, text: k.loadedText };
        tab = k.tab;
        draft = k.draft;
        raw = k.raw;
        errors = k.errors;
        restored = true;
      })
      .catch((e) => {
        loadFailure = describeFailure(e);
      });
  });

  onDestroy(() => {
    if (doc === null || doc.base === null || doc.text === null) return;
    keepSettings({
      base: doc.base,
      loadedText: doc.text,
      tab,
      draft: draft === null ? null : $state.snapshot(draft),
      raw,
      errors: $state.snapshot(errors),
    });
  });

  async function submit(text: string): Promise<void> {
    if (doc === null || doc.base === null || saving) return;
    saving = true;
    outcome = null;
    failure = "";
    const sent = { base: doc.base, text };
    let answered: SaveOutcome["kind"] | "failed" = "failed";
    try {
      const result = await configSave(text, sent.base);
      answered = result.kind;
      outcome = result;
      if (result.kind === "saved") await load(true);
    } catch (e) {
      failure = describeFailure(e);
    } finally {
      saving = false;
      // If the screen was left while this save was in flight, `onDestroy` kept the draft with the
      // base it was sent from; a save that landed makes that draft current, not unsaved.
      settleKeptSettings(sent, answered);
    }
  }

  function saveForm(): void {
    if (draft === null || doc === null) return;
    const decision = formSubmission($state.snapshot(draft), doc.text, $state.snapshot(errors));
    switch (decision.kind) {
      case "blocked":
        outcome = null;
        failure = decision.message;
        return;
      case "unchanged":
        failure = "";
        outcome = { kind: "unchanged", path: doc.path };
        return;
      case "save":
        void submit(decision.text);
    }
  }

  function showTab(next: "form" | "raw"): void {
    if (next === tab) return;
    if (next === "raw" && draft !== null) {
      raw = rawFromDraft($state.snapshot(draft));
    }
    if (next === "form") {
      const parsed = parseDraft(raw);
      if (parsed === null) {
        failure = "The raw JSON is not a JSON object, so the form cannot show it. Fix it or reload.";
        return;
      }
      draft = parsed;
      errors = {};
    }
    failure = "";
    tab = next;
  }

  function onfield(field: Field, value: string): void {
    if (draft === null) return;
    errors[field.id] = writeField(draft, field, value) ?? "";
  }
</script>

<section class="settings">
  <h2>Settings</h2>

  <!-- B7: app settings first — they are this app's own, not engine config, and the notification
       ask must be reachable even while the engine's config cannot be loaded at all. -->
  <AppSettings
    notify={appNotify}
    notifyError={appNotifyError}
    autostart={appAutostart}
    autostartError={appAutostartError}
    onrefresh={loadApp}
    {os}
    {uninstallReport}
    {uninstallRunning}
    {onuninstallstarted}
    {onuninstallended}
  />

  <!-- Phase E (E12): the update panel — the last answer and "Check now". The AUTOMATIC check is the
       engine's `updateCheck` config, edited in the form below (v0.2.1 §4.1: with plain help text). -->
  <UpdateCheck
    result={update}
    loading={updateLoading}
    checking={updateChecking}
    error={updateError}
    oncheck={() => void checkNow()}
  />

  {#if loadFailure !== ""}
    <p class="bad">{loadFailure}</p>
    <button type="button" onclick={() => load(false)}>Try again</button>
  {:else if doc === null}
    <p class="muted">Loading the config…</p>
  {:else}
    <p class="path muted">Config file: <code>{doc.path}</code></p>
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
      <button type="button" onclick={() => load(false)}>Reload</button>
    {:else}
      <div class="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "form"} class:active={tab === "form"}
          onclick={() => showTab("form")}>Form</button
        >
        <button type="button" role="tab" aria-selected={tab === "raw"} class:active={tab === "raw"}
          onclick={() => showTab("raw")}>Raw JSON</button
        >
      </div>

      {#if tab === "form" && draft !== null}
        <SettingsForm
          {draft}
          {errors}
          {onfield}
          onnotifycommand={(v) => draft !== null && writeNotifyCommand(draft, v)}
          ondefault={(f, on) => {
            if (draft === null) return;
            if (on) useDefault(draft, f);
            else useEmptyList(draft, f);
            // The input is now disabled (or freshly enabled): its old complaint describes nothing.
            errors[f.id] = "";
          }}
          onremovekey={() => draft !== null && removeStoredApiKey(draft)}
        />
      {:else if tab === "raw"}
        <label class="raw-label" for="raw-config">The whole config file</label>
        <textarea id="raw-config" rows="24" spellcheck="false" bind:value={raw}></textarea>
        {#if doc.apiKeyRedacted}
          <p class="muted">
            The stored API key is shown as a placeholder. Leave the placeholder to keep the key, or
            delete the whole <code>apiKey</code> line to remove it.
          </p>
        {/if}
      {/if}

      <div class="actions">
        <button
          type="button"
          class="primary"
          disabled={saving}
          onclick={() => (tab === "form" ? saveForm() : void submit(raw))}
          >{saving ? "Checking with the engine…" : "Save"}</button
        >
        <button type="button" disabled={saving} onclick={() => load(false)}>Discard changes</button>
      </div>
      <SaveReport {outcome} {failure} />
    {/if}
  {/if}
</section>

<style>
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.15rem;
  }
  .path {
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .bad {
    color: var(--danger);
    white-space: pre-wrap;
  }
  .kept {
    font-size: 0.88rem;
  }
  .tabs {
    display: flex;
    gap: 0.3rem;
    margin-top: 0.6rem;
  }
  button {
    font: inherit;
    padding: 0.4rem 0.9rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .tabs button.active {
    background: var(--panel);
    font-weight: 600;
  }
  button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: transparent;
  }
  .raw-label {
    display: block;
    margin-top: 1rem;
    font-weight: 600;
    font-size: 0.9rem;
  }
  textarea {
    width: 100%;
    margin-top: 0.3rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    padding: 0.5rem;
    border: 1px solid var(--line);
    border-radius: 0.45rem;
    background: var(--bg);
    color: inherit;
  }
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.6rem;
  }
</style>
