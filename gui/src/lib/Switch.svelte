<script lang="ts">
  /**
   * User-directed 2026-10-22 — an on/off switch: a NATIVE `<input type="checkbox" role="switch">` (so Space toggles it,
   * a `<label for>` names it, and assistive technology says "switch, on/off"), drawn as a switch by this component's
   * own CSS. Used by Settings → Calendar only (the calendar's master switch and the Mac Calendar app row; it overrides,
   * for those two, the 2026-10-21 rule "buttons, not switches"). The wizard never draws it.
   *
   * The look, measured in tests-web/settings-layout.check.ts against app.css's tokens: the track is `--muted` off and
   * `--state-done` on, the thumb `--tile` — the track against the thumb and against the tile both ≥ 3:1 in both themes;
   * the focus ring is app.css's `--accent` 2px outline (≥ 3:1 on the tile); the thumb's slide is off under
   * `prefers-reduced-motion`. Every string is the caller's, `{}`-interpolated.
   *
   * Round 10 (H1): ⚠ THE BOX ALWAYS COMES BACK TO `checked` ONCE THE CHANGE IS HANDLED. The browser flips the box
   * before `onchange` runs, and `{checked}` compiles to Svelte's `set_checked`, which writes the DOM only when the prop
   * differs from the value it last wrote — so after a write that was REFUSED (the prop never changed) the box went on
   * showing the opposite of the file. `onchange` may answer the write's promise: the box is set to `checked` when it
   * settles (at once, for an answer that is no promise), whatever the write did.
   */
  interface Props {
    checked: boolean;
    disabled?: boolean;
    /** The input's id, for a visible `<label for>` (the master switch's title). */
    id?: string | undefined;
    /** The accessible name when no visible label names it (the Mac row's "Read the Mac Calendar app"). */
    label?: string | undefined;
    /** The id of the line that describes it (the master's "The AI then fits…"). */
    describedby?: string | undefined;
    /** The new value; may answer the write's promise (the box shows `checked` again once it settles). */
    onchange: (on: boolean) => void | Promise<unknown>;
  }
  let { checked, disabled = false, id, label, describedby, onchange }: Props = $props();

  async function changed(box: HTMLInputElement): Promise<void> {
    try {
      await onchange(box.checked);
    } finally {
      box.checked = checked;
    }
  }
</script>

<input
  {id}
  type="checkbox"
  role="switch"
  class="switch"
  aria-label={label}
  aria-describedby={describedby}
  {checked}
  {disabled}
  onchange={(e) => void changed(e.currentTarget)}
/>

<style>
  .switch {
    appearance: none;
    -webkit-appearance: none;
    flex: none;
    position: relative;
    width: 38px;
    height: 22px;
    margin: 0;
    border-radius: 999px;
    background: var(--muted);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .switch::before {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--tile);
    transition: transform 0.15s ease;
  }
  .switch:checked {
    background: var(--state-done);
  }
  .switch:checked::before {
    transform: translateX(16px);
  }
  .switch:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .switch:disabled {
    opacity: 0.6;
    cursor: default;
  }
  @media (prefers-reduced-motion: reduce) {
    .switch,
    .switch::before {
      transition: none;
    }
  }
</style>
