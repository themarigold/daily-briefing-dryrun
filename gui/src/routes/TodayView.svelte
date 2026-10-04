<script lang="ts">
  /**
   * The Today screen's markup (T12), drawn from a `TodayModel` (`lib/today.ts`). Split from
   * `Today.svelte` so a test can render every state without IPC: server rendering runs no effects.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED. The status line, a skip's `detail`, the engine's stderr and
   * the briefing itself can all carry repo-controlled text (`docs/gui-seam.md` §5).
   *
   * ⚠ RUN NOW IS `run --json` WITHOUT `--force`: it generates today's briefing only if the engine
   * has not already done so and the morning floor has passed (the app's spawn is not a terminal, so
   * the engine applies its floor, `src/main.ts`), and says that beside the button rather than in a
   * help page.
   */
  import BriefingView from "../lib/BriefingView.svelte";
  import type { TodayModel } from "../lib/today";

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
  }
  let { model, running, progress, runResult, detailsOpen, onrun }: Props = $props();

  /**
   * Whether the Details disclosure is open: the prop's value whenever the PROP changes, and the user's
   * own toggle in between (M2 checkpoint).
   *
   * ⚠ NOT `<details open={detailsOpen}>`. Svelte 5 compiles that attribute into the SAME render effect
   * as the `<pre>`'s text, and `App.svelte` appends each stderr line as a new array — so every line
   * that streamed in re-applied `open = <prop>` and snapped a disclosure the user had opened shut.
   * A writable `$derived` re-derives only when `detailsOpen` changes (App holds the prop in an explicit
   * `$derived`, `detailsOpenNow`, so a run that ends `delivered` after a run-start `null` — false to
   * false — is no change);
   * `bind:open` writes the user's toggle back into it, through the `toggle` event, in an effect of its
   * own that the streaming text does not touch. It lives here, outside the `{#if}`, so a new run that
   * re-creates the element keeps it. Server rendering evaluates the derived, so the `open` attribute is
   * still emitted when the prop is true. `gui/tests-web/today.check.ts` pins the compiled shape.
   */
  let open = $derived(detailsOpen);
</script>

<section class="today">
  <h2>Today</h2>

  {#if model.status !== null}
    <div class="badge {model.status.tone}">{model.status.text}</div>
  {:else}
    <p class="muted">Checking…</p>
  {/if}

  {#each model.banners as banner, i (i)}
    <p class="banner {banner.tone}">{banner.text}</p>
  {/each}

  <div class="actions">
    <button onclick={onrun} disabled={running}>{running ? "Running…" : "Run now"}</button>
    <span class="hint">Generates today's briefing if it has not been generated yet and your morning time has passed.</span>
  </div>
  <!-- The result line sits ABOVE the disclosure: a refused run's text says "see Details below". -->
  {#if runResult !== ""}
    <p class="result">{runResult}</p>
  {/if}
  {#if progress.length > 0}
    <!-- v0.2.1 §2.1: the engine's stderr, verbatim, behind a disclosure — developer diagnostics on a
         run that went fine, the explanation on one that did not (`detailsOpen`, via `open` above). -->
    <details class="details" bind:open>
      <summary>Details</summary>
      <pre class="progress">{progress.join("\n")}</pre>
    </details>
  {/if}

  {#if model.loading}
    <p class="muted">Loading the latest briefing…</p>
  {:else if model.empty}
    <div class="state empty">
      <h3>No briefing yet</h3>
      <p>
        The engine has not written a briefing on this machine yet. The first one is generated on the
        first check after your morning time once the machine is awake, or when you run it now once
        your morning time has passed.
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
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.8rem;
    align-items: center;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    padding: 0.55rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint,
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .details {
    margin-top: 0.8rem;
  }
  .details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .progress {
    margin: 0.4rem 0 0;
    padding: 0.8rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--panel);
    font-size: 0.82rem;
    white-space: pre-wrap;
    overflow-x: auto;
  }
  .result {
    margin: 0.6rem 0 0;
  }
  .state {
    margin-top: 1rem;
  }
  .stale {
    color: var(--muted);
  }
</style>
