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
    onrun: () => void;
  }
  let { model, running, progress, runResult, onrun }: Props = $props();
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
    <span class="hint">Generates today's briefing if it has not been generated yet and the morning floor has passed.</span>
  </div>
  {#if progress.length > 0}
    <pre class="progress">{progress.join("\n")}</pre>
  {/if}
  {#if runResult !== ""}
    <p class="result">{runResult}</p>
  {/if}

  {#if model.loading}
    <p class="muted">Loading the latest briefing…</p>
  {:else if model.empty}
    <div class="state empty">
      <h3>No briefing yet</h3>
      <p>
        The engine has not written a briefing on this machine yet. The first one is generated on the
        first check after the morning floor once the machine is awake, or when you run it now once the
        morning floor has passed.
      </p>
    </div>
  {:else if model.source.kind !== "none"}
    {#if model.staleDate !== null}
      <p class="state stale">
        This is the most recent briefing, from {model.staleDate} — not today's. Today's has not been
        generated yet; the status above says why.
      </p>
    {/if}
    {#if model.quiet}
      <p class="state quiet">A quiet day: there were no commits in the briefing's window.</p>
    {/if}
    <BriefingView blocks={model.source.blocks} />
    <p class="source muted">
      {model.source.kind === "struct"
        ? "Shown from the run this app just started."
        : "Shown from briefing-latest.md."}
    </p>
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
  .progress {
    margin-top: 0.8rem;
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
  .source {
    margin-top: 0.4rem;
  }
</style>
