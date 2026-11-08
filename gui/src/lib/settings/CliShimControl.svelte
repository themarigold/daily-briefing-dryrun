<script lang="ts">
  /**
   * B8 (dev 63): the command-line tool's state and actions. EXPLICIT user actions only — the
   * status read happens on mount (read-only: two engine reads and one `lstat`), and nothing is
   * written except by the two buttons. What counts as ours vs foreign is Rust's
   * (`cli_shim::classify`); a permission refusal surfaces the exact manual command.
   * (Redesign D: split out of the old `AppSettings` panel; it goes on Settings → Advanced.)
   */
  import { onMount } from "svelte";
  import {
    cliShimInstall,
    cliShimRemove,
    cliShimStatus,
    describeShimFailure,
    placementLine,
    type CliShimStatus,
  } from "../shim";
  import type { Os } from "../platform";
  import Tile from "../ui/Tile.svelte";

  interface Props {
    /** The OS this window runs on, for the refusal's wording (`describeShimFailure`). REQUIRED, with no
     *  default, like the other parts' `os`. */
    os: Os;
  }
  let { os }: Props = $props();

  let shim = $state<CliShimStatus | null>(null);
  let shimError = $state("");
  let shimBusy = $state(false);

  async function loadShim(): Promise<void> {
    try {
      shim = await cliShimStatus();
      shimError = "";
    } catch (e) {
      shim = null;
      shimError = describeShimFailure(e, os);
    }
  }

  onMount(() => {
    void loadShim();
  });

  async function shimAction(action: () => Promise<CliShimStatus>): Promise<void> {
    if (shimBusy) return;
    shimBusy = true;
    shimError = "";
    try {
      shim = await action();
    } catch (e) {
      shimError = describeShimFailure(e, os);
    } finally {
      shimBusy = false;
    }
  }
</script>

{#if shim === null || shim.supported}
  <!-- Redesign D: the Terminal command's group, in Step 0's `Tile`; a row, its words on the left and its buttons on
       the right (one column below 720 px). -->
  <div class="group">
  <Tile>
  <div class="block">
    <h4>The daily-briefing command in Terminal</h4>
    {#if shim === null}
      {#if shimError !== ""}
        <pre class="bad">{shimError}</pre>
      {:else}
        <p class="muted">Checking…</p>
      {/if}
    {:else}
      <p>
        Puts <code>daily-briefing</code> on your PATH — a link at {shim.shimPath} to the
        background engine copy — so the same engine works from a terminal
        (<code>daily-briefing status</code>, <code>daily-briefing run --force</code>).
      </p>
      <p class="muted small">{placementLine(shim)}</p>
      {#if shim.target !== null}
        <p class="muted small">It links to: {shim.target}</p>
      {:else}
        <p class="muted small">
          Install the background scheduler first — the engine copy it makes is what this links
          to.
        </p>
      {/if}
      <div class="row">
        {#if shim.state === "absent" || shim.state === "stale"}
          <button disabled={shimBusy || shim.target === null}
            onclick={() => void shimAction(cliShimInstall)}>
            {shim.state === "stale" ? "Repair command-line tool" : "Install command-line tool"}
          </button>
        {/if}
        {#if shim.state === "current" || shim.state === "stale"}
          <button disabled={shimBusy} onclick={() => void shimAction(cliShimRemove)}>
            Remove command-line tool
          </button>
        {/if}
      </div>
      {#if shimError !== ""}
        <pre class="bad">{shimError}</pre>
      {/if}
    {/if}
  </div>
  </Tile>
  </div>
{/if}

<style>
  /* Part B (the S-A mockup): one row, its words on the left and its buttons on the right, 11px 14px. Final round 3
   * (V12): a headerless group as the mockup draws it — the group's name is the row's LABEL (13px, 600), still the
   * group's <h4> so heading navigation finds it as every other group's name. Step 0's Tile pads its content
   * 0.65rem 0.8rem (lib/ui is frozen in wave 1), so the row reaches out to its edges. */
  .group {
    margin: 0 0 14px;
  }
  h4 {
    margin: calc(11px - 0.65rem) 0 2px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  .block {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-auto-flow: row dense;
    column-gap: 12px;
    align-items: center;
    margin: 0 -0.8rem -0.65rem;
    padding: 0 14px 11px;
  }
  .block > * {
    grid-column: 1;
  }
  .block > .row {
    grid-column: 2;
    grid-row: 1 / span 4;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  /* V13: the row's last words end 11px from the tile's edge (the block's padding), not 15. */
  .block > p:last-of-type {
    margin-bottom: 0;
  }
  @media (max-width: 720px) {
    .block {
      grid-template-columns: minmax(0, 1fr);
    }
    .block > .row {
      grid-column: 1;
      grid-row: auto;
      justify-content: flex-start;
      margin-top: 6px;
    }
  }
  p {
    margin: 0 0 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .small {
    font-size: 11.5px;
  }
  .muted {
    color: var(--muted);
  }
  /* Final round 4 (visual LOW): the error ends at the row's 11px inset, as the words do (a <pre>'s own margin put
   * 25px under it); 4px over it, as between the lines. */
  .bad {
    margin: 4px 0 0;
    color: var(--danger);
    font-size: 12px;
  }
  /* The mockup's .btn. */
  button {
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
