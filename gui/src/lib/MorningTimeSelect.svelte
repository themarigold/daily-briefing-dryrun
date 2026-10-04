<script lang="ts">
  /**
   * v0.2.1 §3.2 — the morning-time picker: an hour `<select>` (00–23) and a minute `<select>`
   * (00–59), 24-hour, like the rest of the app. ONE component for the wizard's morning-time step
   * and the Settings form, so the two screens offer the same two controls.
   *
   * Chosen over `<input type="time">` (spec §3.2): its behaviour in the Linux WebKitGTK 4.1 webview
   * is unverified, it looks different on each OS, and the GUI tests are server-rendered.
   *
   * Presentation only. `value` is the time to SHOW, already `HH:MM` — the caller reads a stored
   * value through `lib/morning-time.ts` first — and a change hands the new `HH:MM` to `onchange`;
   * the caller decides what to write. A `<select>` fires no change when the option already shown is
   * picked again, which is why Settings carries its own "Use HH:MM" button for a stored value that
   * is not written as HH:MM.
   */
  import { HOURS, MINUTES } from "./morning-time";

  interface Props {
    /** The hour select's `id`, for the caller's `<label for>`; the minute select is `{id}-minute`. */
    id: string;
    /** `HH:MM`. */
    value: string;
    onchange: (hhmm: string) => void;
  }
  let { id, value, onchange }: Props = $props();

  const hour = $derived(value.slice(0, 2));
  const minute = $derived(value.slice(3, 5));
</script>

<span class="time">
  <select {id} value={hour} onchange={(e) => onchange(`${e.currentTarget.value}:${minute}`)}>
    {#each HOURS as h (h)}
      <option value={h}>{h}</option>
    {/each}
  </select>
  <span class="colon" aria-hidden="true">:</span>
  <select id="{id}-minute" aria-label="Minute" value={minute}
    onchange={(e) => onchange(`${hour}:${e.currentTarget.value}`)}>
    {#each MINUTES as m (m)}
      <option value={m}>{m}</option>
    {/each}
  </select>
</span>

<style>
  .time {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-top: 0.25rem;
  }
  select {
    font: inherit;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg);
    color: inherit;
  }
  .colon {
    font-weight: 600;
  }
</style>
