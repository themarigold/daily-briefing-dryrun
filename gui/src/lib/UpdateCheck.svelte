<script lang="ts">
  /**
   * Phase E (E12) — the Settings screen's update panel: the engine's LAST recorded answer and a
   * "Check now" button. Presentation only: `Settings.svelte` owns the two reads and passes them in
   * (the `AppSettings` pattern), so this renders the same with or without a live engine.
   *
   * ⚠ THE BUTTON IS DISABLED ONLY WHILE ITS OWN CHECK IS IN FLIGHT. There is deliberately no
   * `running` prop: `update --check` takes no in-flight guard in Rust (`Operation::UpdateCheck` is
   * not mutating), so "Check now" works while a briefing is generating, and nothing here may
   * reintroduce the coupling.
   *
   * ⚠ THE AUTOMATIC CHECK IS NOT SWITCHED HERE. It is the engine's `updateCheck` config, edited in
   * the form further down this screen (`lib/settings-model.ts`, whose help says it downloads and
   * installs nothing).
   *
   * ⚠ EVERY ENGINE-DERIVED STRING IS `{}`-INTERPOLATED, and the release page is shown as TEXT to
   * copy, never as a link the webview would navigate to.
   */
  import type { UpdateCheckResult } from "./engine";
  import { releasePage, updateLine } from "./update-check";

  interface Props {
    /** The last answer — `status --json`'s `updateCheck`, or the one a Check-now just returned. */
    result: UpdateCheckResult | null;
    /** True until the first `status --json` read has answered. */
    loading: boolean;
    /** True while a Check-now is in flight — the ONLY thing that disables the button. */
    checking: boolean;
    error?: string;
    oncheck: () => void;
  }
  let { result, loading, checking, error = "", oncheck }: Props = $props();
</script>

<div class="updates">
  <h3>Updates</h3>
  <p>{loading ? "Reading the last update check…" : updateLine(result)}</p>
  {#if releasePage(result) !== null}
    <p class="muted">Release page (copy it into your browser): <code class="url">{releasePage(result)}</code></p>
  {/if}
  <div class="row">
    <button type="button" class="check-now" disabled={checking} onclick={oncheck}>
      {checking ? "Checking…" : "Check now"}
    </button>
  </div>
  <p class="muted">
    Check now asks once, right away, whatever the automatic setting says — one request to GitHub
    carrying the engine's version and nothing else about you. Automatic checks are the engine's
    "Update check" setting further down this screen: off unless you turn them on, and when on they
    run from the background schedule, right after it has delivered that day's briefing — never on a
    run that skipped or failed. No briefing ever waits for one, and Run now never checks. Nothing is
    ever downloaded or installed.
  </p>
  {#if error !== ""}
    <p class="bad">{error}</p>
  {/if}
</div>

<style>
  .updates {
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    padding: 0.9rem 1rem;
    margin-bottom: 1.5rem;
  }
  h3 {
    margin: 0 0 0.6rem;
    font-size: 1rem;
  }
  p {
    margin: 0 0 0.6rem;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
  }
  .url {
    overflow-wrap: anywhere;
    user-select: text;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .bad {
    color: var(--danger);
    font-size: 0.85rem;
    white-space: pre-wrap;
  }
  button {
    font: inherit;
    padding: 0.45rem 0.9rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
