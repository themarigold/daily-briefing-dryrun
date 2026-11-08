<script lang="ts">
  /**
   * Step 0 — the `Tile` surface (hub spec "The look"; the S1 decision): white with a hairline border
   * and a soft shadow in light mode, the app's dark panel colour in dark mode (`--tile`,
   * `--tile-border`, `--tile-shadow`, `app.css`), for the launchpad tiles and the Settings groups.
   * A `<section>`. Presentation only.
   *
   * ⚠ A `label` gives the section an accessible name, which makes it a landmark REGION that screen
   * readers list. Pass one only for a tile that should be a landmark; a Settings group puts a heading
   * inside and passes no `label`.
   *
   * `state` outlines the tile in a state colour (hub "State outlines"): `live` orange (a meeting in
   * progress), `done` green (something just finished). There is no third outline: a meeting that is
   * close colours only its LABEL (the `--state-live` text, A's), as the mockup's waiting tile does.
   * The outline is never the only signal: the tile's own text says what the state is, and its label
   * colour and pulsing dot are the caller's (A's meeting tile).
   */
  import type { Snippet } from "svelte";

  interface Props {
    /** The tile's accessible name, making it a landmark region (see above). */
    label?: string | undefined;
    state?: "live" | "done" | undefined;
    children: Snippet;
  }
  let { label, state, children }: Props = $props();
</script>

<section class="tile" class:live={state === "live"} class:done={state === "done"} aria-label={label}>
  {@render children()}
</section>

<style>
  .tile {
    background: var(--tile);
    border: 1px solid var(--tile-border);
    box-shadow: var(--tile-shadow);
    border-radius: 8px;
    padding: 0.65rem 0.8rem;
  }
  .live {
    border-color: var(--state-live);
    box-shadow: 0 0 0 1px var(--state-live);
  }
  .done {
    border-color: var(--state-done);
    box-shadow: 0 0 0 1px var(--state-done);
  }
</style>
