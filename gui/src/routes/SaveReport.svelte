<script lang="ts">
  /**
   * What a Settings save did. ERRORS and WARNINGS are shown DISTINCTLY: an error means the engine
   * refused the config and nothing was written; a warning (a bad `morningTime` degrades to the
   * default, an uncompilable exclude pattern is ignored) did not block the save. Both are the
   * engine's own words, verbatim, as text.
   */
  import type { SaveOutcome } from "../lib/files";

  interface Props {
    outcome: SaveOutcome | null;
    /** A refusal before the engine was asked, or a failure around it — already one sentence. */
    failure: string;
  }
  let { outcome, failure }: Props = $props();

  const warnings = $derived(outcome === null || outcome.kind === "unchanged" ? [] : outcome.warnings);
</script>

{#if failure !== ""}
  <p class="report failure">{failure}</p>
{/if}
{#if outcome !== null}
  {#if outcome.kind === "saved"}
    <p class="report saved">
      Saved to {outcome.path}. The previous version is kept at {outcome.backupPath}.
    </p>
  {:else if outcome.kind === "created"}
    <!-- B8: the wizard's create. Settings itself never produces this; typed for completeness. -->
    <p class="report saved">Created {outcome.path}.</p>
  {:else if outcome.kind === "unchanged"}
    <p class="report unchanged">Nothing changed, so nothing was written.</p>
  {:else}
    <div class="report errors">
      <p>Not saved — the engine refused this config:</p>
      <ul>
        {#each outcome.errors as note, i (i)}
          <li>{#if note.field !== ""}<code>{note.field}</code> {/if}{note.message}</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if warnings.length > 0}
    <div class="report warnings">
      <p>{outcome.kind === "saved" ? "Saved with warnings" : "Warnings"} — these do not block saving:</p>
      <ul>
        {#each warnings as note, i (i)}
          <li>{#if note.field !== ""}<code>{note.field}</code> {/if}{note.message}</li>
        {/each}
      </ul>
    </div>
  {/if}
{/if}

<style>
  .report {
    margin: 0.8rem 0 0;
    padding: 0.55rem 0.8rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .report p {
    margin: 0;
  }
  .report ul {
    margin: 0.3rem 0 0;
    padding-left: 1.2rem;
  }
  .failure,
  .errors {
    border-color: var(--danger);
    color: var(--danger);
  }
  .warnings {
    background: var(--panel);
  }
</style>
