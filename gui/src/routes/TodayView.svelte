<script lang="ts">
  /**
   * The Today screen's markup (T12), drawn from a `TodayModel` (`lib/today.ts`). Split from
   * `Today.svelte` so a test can render every state without IPC: server rendering runs no effects.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED. The status line, a skip's `detail`, the engine's stderr and
   * the briefing itself can all carry repo-controlled text (`docs/gui-seam.md` §5).
   *
   * Run now, its result line and the Details disclosure are `lib/RunControls.svelte` (the briefing
   * redesign's A-M2), rendered where they were, with the same props passed through.
   *
   * PB-M6-T3 (wave-2 polish spec §4 "Focus"): with the slides switch off, Today's land request (after the calendar card's
   * Close or "Not now") focuses the "Today" heading — `landHere`, false in every other render, so the heading is drawn
   * exactly as before (an undefined `tabindex` is no attribute; an action draws nothing).
   */
  import BriefingView from "../lib/BriefingView.svelte";
  import RunControls from "../lib/RunControls.svelte";
  import type { TodayModel } from "../lib/today";
  import { focusHeading } from "../lib/ui/a11y";

  interface Props {
    model: TodayModel;
    running: boolean;
    /** The engine's stderr for the current run, verbatim, one line per entry. */
    progress: string[];
    runResult: string;
    /** Whether the Details disclosure starts open (`detailsOpen`, `lib/engine.ts`): open after a run that
     *  failed, was refused (configError) or threw; collapsed otherwise. REQUIRED, no default. */
    detailsOpen: boolean;
    onrun: () => void;
    /** PB-M6-T3: the land request's target is this heading (DeckOrClassic, the slides switch off). Default false. */
    landHere?: boolean;
  }
  let { model, running, progress, runResult, detailsOpen, onrun, landHere = false }: Props = $props();
</script>

<section class="today">
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <h2 tabindex={landHere ? -1 : undefined} use:focusHeading={landHere}>Today</h2>

  {#if model.status !== null}
    <div class="badge {model.status.tone}">{model.status.text}</div>
  {:else}
    <p class="muted">Checking…</p>
  {/if}

  {#each model.banners as banner, i (i)}
    <p class="banner {banner.tone}">{banner.text}</p>
  {/each}

  <RunControls {running} {progress} {runResult} {detailsOpen} {onrun} />

  {#if model.loading}
    <p class="muted">Loading the latest briefing…</p>
  {:else if model.empty}
    <div class="state empty">
      <h3>No briefing yet</h3>
      <p>
        The engine has not written a briefing on this machine yet. The first one is generated on the
        first check after your morning time once the machine is awake, or when you run it now.
      </p>
    </div>
  {:else if model.source.kind !== "none"}
    {#if model.staleDate !== null}
      <p class="state stale">
        This is the most recent briefing, from {model.staleDate} — not today's. Today's has not been
        generated yet; the status above says why.
      </p>
    {/if}
    {#if model.quietWithWarning}
      <p class="state quiet">A quiet day: no commits in the window. See the warning below.</p>
    {:else if model.quiet}
      <p class="state quiet">A quiet day: there were no commits in the briefing's window.</p>
    {/if}
    <BriefingView blocks={model.source.blocks} />
  {/if}
</section>

<style>
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.15rem;
  }
  h3 {
    margin: 0 0 0.3rem;
    font-size: 1rem;
  }
  .badge {
    display: inline-block;
    padding: 0.25rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    font-weight: 600;
  }
  .badge.bad,
  .banner.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  .badge.info,
  .banner.info {
    background: var(--panel);
  }
  .badge.warn,
  .banner.warn {
    border-color: var(--danger);
  }
  .banner {
    margin: 0.6rem 0 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.45rem;
    white-space: pre-wrap;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .state {
    margin-top: 1rem;
  }
  .stale {
    color: var(--muted);
  }
</style>
