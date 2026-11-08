<script lang="ts">
  /**
   * A-M7-T15 — A's two rows on Settings → General, in D's reserved `prefsRows` slot (`Settings.svelte`'s snippet).
   * The rows themselves are `PrefsRowsBody.svelte`; this is their GATE (round-3 M1).
   *
   * The rows read the app-prefs store once, at mount. Settings can mount before startup's `app_prefs_get` has
   * settled (only Today waits for it, `App.svelte`), and the rows would then keep the defaults — an empty name,
   * slides on, no load-failure line — for the whole visit. So until the store has settled this draws a muted
   * "Loading…" in the rows' place, and draws the rows once it has (`appPrefsSettled`, heard through
   * `onAppPrefsChange`). Settled also waits for any SET in flight (round-4 M3): Settings reopened while an earlier
   * visit's set is still going draws the rows once it lands, with what it saved. Nothing of D's page is drawn any
   * differently.
   */
  import { onMount, untrack } from "svelte";
  import { appPrefsSettled, onAppPrefsChange } from "../app-prefs-store";
  import PrefsRowsBody from "./PrefsRowsBody.svelte";
  import type { RowLine as Line } from "./prefs-rows";

  interface Props {
    /** Passed to the rows (the checks' way to draw the state a set leaves; the app passes nothing). */
    initial?: { name?: string; nameLine?: Line; slidesLine?: Line } | undefined;
  }
  let { initial }: Props = $props();
  const seed = untrack(() => initial);

  let settled = $state(appPrefsSettled());
  onMount(() => {
    // Re-read, then follow until settled: nothing can settle between the two (one synchronous block).
    settled = appPrefsSettled();
    if (settled) return;
    const stop = onAppPrefsChange(() => {
      if (appPrefsSettled()) {
        settled = true;
        stop();
      }
    });
    return stop;
  });
</script>

{#if settled}
  <PrefsRowsBody initial={seed} />
{:else}
  <p class="loading">Loading…</p>
{/if}

<style>
  /* App's "Loading…" line (round-1 L7), in the rows' place: the group's margin, so nothing below moves twice. */
  .loading {
    margin: 0 0 14px;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
