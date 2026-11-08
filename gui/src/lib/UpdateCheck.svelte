<script lang="ts">
  /**
   * Phase E (E12) — the Settings screen's update panel: the engine's LAST recorded answer and a
   * "Check now" button. Presentation only: `Settings.svelte` owns the two reads and passes them in
   * (through `SettingsPages` and `GeneralPage`), so this renders the same with or without a live engine.
   *
   * ⚠ THE BUTTON IS DISABLED ONLY WHILE ITS OWN CHECK IS IN FLIGHT. There is deliberately no
   * `running` prop: `update --check` takes no in-flight guard in Rust (`Operation::UpdateCheck` is
   * not mutating), so "Check now" works while a briefing is generating, and nothing here may
   * reintroduce the coupling.
   *
   * ⚠ THE AUTOMATIC CHECK IS NOT SWITCHED HERE. It is the engine's `updateCheck` config, edited in
   * the two fields above this box (`lib/settings-model.ts`, whose help says it downloads and
   * installs nothing).
   *
   * Redesign D Part B (user-directed 2026-10-21): this box is the last part of General's one Updates group, whose
   * legend names it (so no heading of its own here), drawn under the engine's two fields (final round 2, V1: the S-A
   * mockup's order): a row — "Check now" and the last result on the left, the button on the right — then the
   * paragraph. It is privacy wording: `test/privacy-wording.test.ts` reads this file and refuses its retired phrases
   * (it pins no phrase of it). Only its locator changed in round 2 (V1, R2-L10): the automatic check is now labelled
   * "Check for updates automatically"; every other word is as before. Final round 3 (V15): the sentence names that
   * setting without saying where it is — the fields are not drawn while the config is unavailable or the JSON editor
   * is open, so "above" was not always true.
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
  <div class="row">
    <div class="words">
      <p class="name">Check now</p>
      <p class="help">{loading ? "Reading the last update check…" : updateLine(result)}</p>
      {#if releasePage(result) !== null}
        <p class="help">Release page (copy it into your browser): <code class="url">{releasePage(result)}</code></p>
      {/if}
    </div>
    <button type="button" class="check-now" disabled={checking} onclick={oncheck}>
      {checking ? "Checking…" : "Check now"}
    </button>
  </div>
  <p class="muted note">
    Check now asks once, right away, whatever the automatic setting says — one request to GitHub
    carrying the engine's version and nothing else about you. Automatic checks are the engine's
    "Check for updates automatically" setting: off unless you turn them on, and when on they
    run from the background schedule, right after it has delivered that day's briefing — never on a
    run that skipped or failed. No briefing ever waits for one, and Run now never checks. Nothing is
    ever downloaded or installed.
  </p>
  {#if error !== ""}
    <p class="bad">{error}</p>
  {/if}
</div>

<style>
  /* Part B: rows of the Updates group (its tile pads 0.65rem 0.8rem; the rows reach out to the mockup's 14px). */
  .updates {
    clear: both;
    margin: 0 -0.8rem -0.65rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 14px 6px;
  }
  .words {
    flex: 1 1 auto;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  .name {
    font-weight: 600;
    font-size: 13px;
  }
  .help {
    margin-top: 2px;
    font-size: 12px;
    color: var(--muted);
  }
  .note {
    padding: 0 14px 11px;
  }
  .url {
    overflow-wrap: anywhere;
    user-select: text;
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .bad {
    padding: 0 14px 11px;
    color: var(--danger);
    font-size: 12px;
    white-space: pre-wrap;
  }
  /* The mockup's .btn. */
  button {
    flex: 0 0 auto;
    font: inherit;
    font-size: 12.5px;
    padding: 5px 11px;
    border-radius: 6px;
    border: 1px solid var(--tile-border);
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  button:disabled {
    color: var(--muted);
    cursor: default;
  }
</style>
