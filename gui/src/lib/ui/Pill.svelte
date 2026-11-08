<script lang="ts">
  /**
   * Step 0 — a project pill (hub spec "The look", "Project pills"). Presentation only.
   *
   * `palette` is a palette slot from `lib/project-color.ts` (`assignSlots`); `paletteClass` there turns
   * it into the global palette class from `app.css`: a number draws `pc-{slot}`, and `null` draws the
   * neutral `pc-other` (the deck's "Other" card). The class only sets `--pc-bg` and `--pc-fg`; the
   * pill paints itself from them. A label with `norm(label) === ""` is not a project and arrives here
   * as `null`. A slot outside 0-11 is clamped (a fraction is truncated, `NaN` is neutral), so no
   * unknown class is ever drawn and no colour is ever built from engine text. (The prop is not called
   * `slot`: that name is reserved by Svelte on a component's child, so `<Card><Pill slot={s} /></Card>`
   * would not compile.)
   *
   * The label is drawn as text nodes: its "_"-ended parts with a `<wbr>` after each "_" (wave 2 polish §6, a
   * user-directed lib/ui change), so a wrapping label breaks after "_" first ("daily_briefing_" / "application",
   * never "daily_briefing_a" / "pplication"). Every pill draws them, with or without `wrap`: a non-wrap pill wraps
   * too while its holder has keyboard focus. `overflow-wrap: anywhere` stays, so a part still wider than the pill
   * breaks inside itself as a last resort (`break-word` would overflow under `wrap`'s `max-width: none`). No
   * character is added: the text, the title and the accessible name are the label unchanged.
   * Long labels ellipsize by CSS only: the full text stays in the DOM, is
   * in `title` for hover, and the ellipsis lifts when the button or summary holding the pill has
   * keyboard focus (A spec: "the full text on hover or focus"). The pill itself is never focusable.
   * ⚠ So a long label OUTSIDE a button or summary has no keyboard way to its full text (`title` is
   * hover only): a caller that may draw a long label outside a control passes `wrap`, which draws the
   * whole label, wrapped, with no ellipsis, and a little more room top and bottom.
   * The radius is half a one-line pill's height (0.78rem × 1.4 + 0.2rem padding ≈ 1.29rem), so one
   * line is fully round and a wrapped pill gets soft rectangular corners (user's choice, "option F").
   * `title` repeats the visible text, and some screen readers read both; that is accepted, for the
   * hover requirement.
   */
  import { paletteClass } from "../project-color";

  interface Props {
    /** A palette slot 0-11, or `null` for the neutral pill. */
    palette: number | null;
    label: string;
    /** Draw the whole label, wrapped, with no ellipsis (for a long label outside a control). */
    wrap?: boolean | undefined;
  }
  let { palette, label, wrap }: Props = $props();

  const cls = $derived(paletteClass(palette));
  /** The label split AFTER each "_", every character kept (`parts.join("") === label`); no "_" is one part. */
  const parts = $derived(label.match(/[^_]*_|[^_]+$/g) ?? [label]);
</script>

<span class="pill {cls}" class:wrap title={label}>{#each parts as p, i (i)}{p}{#if i < parts.length - 1}<wbr />{/if}{/each}</span>

<style>
  .pill {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    padding: 0.1rem 0.6rem;
    border-radius: 0.65rem;
    background: var(--pc-bg);
    color: var(--pc-fg);
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.4;
  }
  /* `wrap`: the whole label, always (two classes outrank `.pill`). */
  .pill.wrap {
    padding-top: 0.2rem;
    padding-bottom: 0.2rem;
    max-width: none;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  /* The button or summary holding the pill has keyboard focus: show the whole label. */
  :global(:is(button, summary):focus-visible) .pill {
    white-space: normal;
    overflow: visible;
    overflow-wrap: anywhere;
  }
</style>
