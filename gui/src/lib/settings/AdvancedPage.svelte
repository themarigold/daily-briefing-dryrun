<script lang="ts">
  /**
   * Redesign D — Settings → Advanced: the Advanced fields, then the engine's own notification setting (the spec's
   * order), the Terminal command (`CliShimControl`), and "Edit settings as JSON". The button turns the draft into
   * text (the shell's `showTab()`); while the editor is open (`tab === "raw"`) the two form groups stay mounted but
   * hidden and the editor shows instead. Leaving this page parses the text back (`navigate`, `pages.ts`). The button
   * and the editor are drawn only while the config is loaded: a file that is not a JSON object offers no editor.
   * Final round 1 (M1): the button replaces itself with the editor, so the editor takes the focus when it opens from
   * the button (not when a kept editor comes back with the screen).
   */
  import type { Action } from "svelte/action";
  import type { Os } from "../platform";
  import ActionButton from "../ui/ActionButton.svelte";
  import Tile from "../ui/Tile.svelte";
  import SettingsForm from "../../routes/SettingsForm.svelte";
  import CliShimControl from "./CliShimControl.svelte";
  import ConfigGate from "./ConfigGate.svelte";
  import type { FormProps } from "./form-props";
  import { JSON_SAVING_LINE, type ConfigState } from "./pages";

  interface Props {
    form: FormProps | null;
    tab: "form" | "raw";
    config: ConfigState;
    /** The JSON editor's text, bound both ways: the shell saves it and parses it back. */
    raw: string;
    /** Final small fix (F2): a save is in flight, so the editor is read-only (`jsonEditorReadOnly`), with a line saying
     *  why. Read-only, not disabled: it keeps the focus, the selection and its scroll. */
    readOnly: boolean;
    /** Open the JSON editor. */
    onopenjson: () => void;
    /** The stored API key is shown as a placeholder in the text. */
    apiKeyRedacted: boolean;
    os: Os;
  }
  let { form, tab, config, raw = $bindable(), readOnly, onopenjson, apiKeyRedacted, os }: Props = $props();

  /** The user opened the editor here (M1), so it takes the focus as it appears. */
  let opened = $state(false);
  function openJson(): void {
    opened = true;
    onopenjson();
  }

  /** M1, final round 4 (R4-L2): the editor opened from the button takes the focus, and its group is brought to the
   *  window's top. Opening it hides the form groups above, so the page gets shorter and the browser clamps the scroll:
   *  the group's heading was left above the window (560x420: at -93px). Once, on the microtask after the flush that
   *  drew the editor, as Step 0's heading helper (`ui/a11y.ts`) focuses, which this replaces here: that one never
   *  scrolls. */
  const openedHere: Action<HTMLTextAreaElement, boolean> = (node, active) => {
    if (active)
      queueMicrotask(() => {
        if (!node.isConnected) return;
        node.focus({ preventScroll: true });
        node.closest(".group")?.scrollIntoView({ block: "start" });
      });
  };
</script>

<ConfigGate {config} {tab} pointer={true} editorHere={true}>
  {#if form !== null}
    <SettingsForm {...form} sections={["Advanced"]} />
    <SettingsForm {...form} sections={["Notifications from the engine"]} />
  {/if}
</ConfigGate>

<CliShimControl {os} />

{#if config === "ready"}
  <!-- Part B: its own group (the S-A mockup's row: the words on the left, the button on the right). -->
  <div class="group"><Tile><div class="json">
    <h4>Settings file as JSON</h4>
    {#if tab === "raw"}
      <label class="raw-label" for="raw-config">The whole settings file, as JSON</label>
      {#if readOnly}
        <p class="muted saving" id="raw-saving">{JSON_SAVING_LINE}</p>
      {/if}
      <textarea id="raw-config" rows="24" spellcheck="false" bind:value={raw} readonly={readOnly} aria-describedby={readOnly ? "raw-saving" : undefined} use:openedHere={opened}></textarea>
      {#if apiKeyRedacted}
        <p class="muted">
          The stored API key is shown as a placeholder. Leave the placeholder to keep the key, or
          delete the whole <code>apiKey</code> line to remove it.
        </p>
      {/if}
    {:else}
      <div class="row">
        <p class="muted">For experts: the whole file in one place. It is checked before it is saved, as the form is.</p>
        <span class="action"><ActionButton onclick={openJson}>Edit settings as JSON</ActionButton></span>
      </div>
    {/if}
  </div></Tile></div>
{/if}

<style>
  .group {
    margin: 0 0 14px;
  }
  /* Step 0's Tile pads its content 0.65rem 0.8rem (lib/ui is frozen in wave 1): the row sits the mockup's 11px / 14px
   * from its edge. Final round 3 (V12): a headerless group as the mockup's "Edit settings as JSON" — the group's name
   * is the row's label (13px, 600; still its <h4>), its help under it, the button on the right beside both. With the
   * editor open, the editor takes the row's whole width under the label. */
  .json {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 12px;
    align-items: center;
    margin: calc(11px - 0.65rem) calc(14px - 0.8rem);
  }
  .json > * {
    grid-column: 1 / -1;
  }
  .json > h4 {
    grid-column: 1;
    margin: 0 0 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  .row {
    display: contents;
  }
  .row > p {
    grid-column: 1;
    margin: 0;
  }
  /* The button keeps its words on one line (ActionButton is Step 0's; its wrapper sets that, inherited). */
  .action {
    grid-column: 2;
    grid-row: 1 / span 2;
    white-space: nowrap;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  /* Final round 4 (V21): under the group's name (the row's 13px label), the textarea's own label is the row's help —
   * 12px, muted — not a second bold line. */
  .raw-label {
    display: block;
    font-size: 12px;
    color: var(--muted);
  }
  .saving {
    margin: 4px 0 0;
  }
  textarea {
    width: 100%;
    margin-top: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    padding: 8px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
</style>
