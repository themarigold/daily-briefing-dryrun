<script lang="ts">
  /**
   * B1 (wave-2 plan B1-M6-T18): one of the launchpad's live git tiles (S1, `launchpad-sharp.html:217-222`): "Only
   * on this Mac · N commits on M branches" and "Not committed · N files in {name}" while amber (the label in
   * `--state-wait`, the mockup's waiting tile), then "✓ Pushed" / "✓ Committed" with `Tile`'s green `done` outline
   * until the model drops it. A tile from a check that is not current is dimmed (its words in `--muted`) and says
   * "as of HH:MM". Every word is the model's (`launchpadTiles`); colour is never the only signal, the label says the
   * state in words. `Tile` has no `wait` state (`look.check.ts`), so the amber is this component's own.
   *
   * ⚠ NOT A LIVE REGION: the tiles change with each check, and nothing here is announced.
   *
   * B2-M6-T15: `children` is what the tile carries after its words, the launchpad's Copy push command.
   */
  import type { Snippet } from "svelte";
  import type { GitTile } from "../git-detail";
  import Tile from "../ui/Tile.svelte";

  interface Props {
    tile: GitTile;
    children?: Snippet | undefined;
  }
  let { tile, children }: Props = $props();

  const dim = $derived(tile.asOf !== null);
</script>

<Tile state={tile.state === "done" ? "done" : undefined}>
  <p class="label caps" class:wait={tile.state === "wait" && !dim} class:dim>{tile.label}</p>
  <p class="value" class:dim>{tile.value}</p>
  {#if tile.asOf !== null}<p class="as-of">{tile.asOf}</p>{/if}
  {@render children?.()}
</Tile>

<style>
  p {
    margin: 0;
  }
  .label {
    font-weight: 600;
  }
  /* Waiting: the label in the state colour (≥ 4.5:1 as text on --tile, look.check.ts). */
  .wait {
    color: var(--state-wait);
  }
  .value {
    margin-top: 0.2rem;
    overflow-wrap: anywhere;
  }
  /* Not current: dimmed by colour alone, so its text keeps the --muted contrast. */
  .dim {
    color: var(--muted);
  }
  .as-of {
    margin-top: 0.2rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
</style>
