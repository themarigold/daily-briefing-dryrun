<script lang="ts">
  /**
   * Step 0 — the `Card` surface (hub spec "The look"): the tinted `--panel` surface of `deck.html`,
   * for the deck's project cards ("stacked tinted cards"). An `<article>`, because each card is one
   * self-contained item. Presentation only.
   *
   * `id` makes it a jump target; `highlighted` draws the brief ring a jumped-to card gets (hub
   * "Motion": "a project you jump to gets a brief highlight"; the caller sets and clears it). The ring
   * fades in over `--open-ms`, which is 0 under "reduce motion", and the transition is also off there.
   */
  import type { Snippet } from "svelte";

  interface Props {
    /** The card's accessible name, when its content does not give one. */
    label?: string | undefined;
    id?: string | undefined;
    highlighted?: boolean | undefined;
    children: Snippet;
  }
  let { label, id, highlighted, children }: Props = $props();
</script>

<article class="card" class:highlighted {id} aria-label={label}>{@render children()}</article>

<style>
  .card {
    background: var(--panel);
    border-radius: 10px;
    padding: 0.7rem 0.9rem;
    transition: box-shadow var(--open-ms);
  }
  .highlighted {
    box-shadow: 0 0 0 2px var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .card {
      transition: none;
    }
  }
</style>
