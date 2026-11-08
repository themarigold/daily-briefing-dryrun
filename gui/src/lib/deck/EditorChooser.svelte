<script lang="ts">
  /**
   * B2-M6-T15: the editor chooser (B2 :71-73), a native non-modal `<dialog>` drawn in place inside the component that owns
   * the clicked control (`LeftOff`, `Launchpad`), never at Today's top level. It draws `chooserView`'s model and reports
   * the answer; `actions.ts`'s `editorFlow` makes every call, so it names no IPC. No `<form>`: Open is an ordinary button.
   *
   * It scrolls into view when it opens, and focus moves to the Editor control and returns to whatever had it when it closes, the clicked control
   * for a keyboard user, unless focus has already moved on elsewhere. Escape is Cancel, wherever the focus is while it is open, unless its slide is inert or a modal is
   * open: every slide stays mounted, so that press belongs to what is showing, such as a `MeetingCard`.
   */
  import { onMount, untrack } from "svelte";
  import type { ChooserView } from "../actions";
  import type { EditorId } from "../app-prefs-store";

  interface Props {
    view: Extract<ChooserView, { state: "choose" }>;
    onopen: (editor: EditorId, remember: boolean) => void;
    oncancel: () => void;
  }
  let { view, onopen, oncancel }: Props = $props();

  let editor = $state<EditorId>(untrack(() => view.selected));
  let remember = $state(untrack(() => view.remember));
  let control: HTMLSelectElement | undefined;
  let dialog: HTMLDialogElement | undefined;

  onMount(() => {
    const from = document.activeElement;
    const own = dialog;
    // It draws in place, so it can open below the fold with Open and Cancel out of view. Every slide stays mounted: not on one
    // that is not showing.
    if (dialog !== undefined && dialog.closest("[inert]") === null) dialog.scrollIntoView({ block: "nearest" });
    control?.focus({ preventScroll: true });
    return () => {
      // Focus that has moved on, as to another card's "Open in editor…", stays where it went.
      const now = document.activeElement;
      const lost = now === null || now === document.body || own?.contains(now) === true;
      if (lost && from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true });
    };
  });

  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.key !== "Escape") return;
    if (dialog === undefined || dialog.closest("[inert]") !== null || document.querySelector('[aria-modal="true"]') !== null) return;
    e.preventDefault(); oncancel();
  }
</script>

<svelte:window {onkeydown} />

<dialog bind:this={dialog} open class="chooser" aria-label="Choose an editor">
  <h3>Choose an editor</h3>
  <label class="field">
    <span>Editor</span>
    <select class="ctl" bind:this={control} bind:value={editor}>
      {#each view.editors as e (e.editor)}
        <option value={e.editor}>{e.label}</option>
      {/each}
    </select>
  </label>
  <label class="field">
    <input type="checkbox" bind:checked={remember} />
    <span>Always use this for this project</span>
  </label>
  <div class="buttons">
    <button type="button" class="ctl act" onclick={() => onopen(editor, remember)}>Open</button>
    <button type="button" class="ctl act" onclick={() => oncancel()}>Cancel</button>
  </div>
</dialog>

<style>
  .chooser {
    position: static;
    display: block;
    width: auto;
    max-width: 24rem;
    margin: 0.5rem 0 0;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
  }
  .field {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.4rem;
    font-size: 0.88rem;
  }
  /* The Settings selects' look (`EditorLinksPage`). The deck has no --surface, so this is --bg, in both themes. */
  select {
    font: inherit;
    font-size: 13px;
    max-width: 100%;
    margin: 0;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
  /* A native checkbox's own left margin, which would start it right of the title and the "Editor" label. */
  input[type="checkbox"] {
    margin-left: 0;
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .act {
    font: inherit;
    font-size: 0.88rem;
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
</style>
