<script lang="ts">
  /**
   * What you did (A spec, "What you did (V4)"): the subtitle (with the coverage remainder behind it), the
   * pill row that jumps to a card, Open all / Close all, and one tinted card per project with its count
   * (`cardCountLabel`: never "0 commits"), the user's own why lines (`— you wrote: "…"`, before the points),
   * up to 3 points, its "Today so far" lines and its disclosure (every commit line as on the page, the
   * cluster headers marked, and a "Merged: #…" row).
   *
   * A jump from the pill row gives the target card `Card`'s brief highlight ring for `HIGHLIGHT_MS` (hub,
   * Motion); a card's detail opens with a short height transition (`slide`, `OPEN_MS`), 0 under reduced
   * motion. Which cards are open is the deck's reducer state (`open`), so Open all and Close all reach
   * every card.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED: labels, points and lines are repo-controlled text. A point is
   * the line's text as the reader shows it (A-M5's decision: inline formatting is not carried), and its whole
   * sentence is drawn, wrapped, whether the card is open or closed (polish §1: no cut, no "…").
   *
   * B1 (wave-2 plan B1-M6-T17), once the live git check answers (`git`, `git-detail.ts`'s view; every word is the
   * model's): the heading is the window title ("Yesterday", "Since Thursday", …), the subtitle carries the live PR
   * count in both places it is drawn, the remainder drops "(+N more)" when the model says so (and with nothing left
   * the subtitle is the plain line, never an empty disclosure), and a card the check answered ends in its summary
   * line, which REPLACES A's "N commits ›" as the disclosure: opened, it shows the rows (`GitRows`), then the page
   * lines no row holds — a pile heading with nothing left under it dropped, the rest shortened to "{name} · {K}
   * commits" (polish §2, `git-detail.ts`'s `pileRest`) — and the 🔀 PRs no row holds, as A draws them. A's disclosure
   * stays before the detail, for a repo the check could not answer, and for a card with no SHA (the model's
   * `mode: "page"`).
   */
  import { onDestroy } from "svelte";
  import { slide } from "svelte/transition";
  import { cardCountLabel, type DeckAction, type DeckPage } from "../deck";
  import type { ActionsView } from "../actions";
  import type { GitDetailView } from "../git-detail";
  import ActionButton from "../ui/ActionButton.svelte";
  import { focusHeading } from "../ui/a11y";
  import Card from "../ui/Card.svelte";
  import { durations, HIGHLIGHT_MS, prefersReducedMotion } from "../ui/motion";
  import Pill from "../ui/Pill.svelte";
  import GitRows from "./GitRows.svelte";

  interface Props {
    page: DeckPage;
    /** The open cards' keys (the reducer's `open`). */
    open: string[];
    active: boolean;
    ondispatch: (a: DeckAction) => void;
    /** B1: the live git check's view; null (or absent) before it answers. */
    git?: GitDetailView | null | undefined;
    /** B2: the buttons from current held handles; null (or absent) before any. */
    actions?: ActionsView | null | undefined;
  }
  let { page, open, active, ondispatch, git, actions }: Props = $props();

  const w = $derived(page.whatYouDid);
  /** The subtitle and its remainder: the model's once the detail arrives, the page's before. */
  const subtitle = $derived(git?.subtitle ?? w.subtitle);
  const remainder = $derived(git?.remainder ?? w.remainder);
  /** A card's live detail, or null for A's disclosure (no detail yet, a repo `unknown`, a card with no SHA). */
  const detailOf = (key: string) => {
    const c = git?.cards.find((x) => x.key === key);
    return c !== undefined && c.mode === "detail" ? c : null;
  };
  let highlighted = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cardId = (i: number): string => `deck-card-${i}`;
  const openMs = (): number => durations(prefersReducedMotion()).openMs;

  /** The pill row's jump: scroll the card into view and give it the brief highlight. */
  function jump(key: string, i: number): void {
    highlighted = key;
    clearTimeout(timer);
    timer = setTimeout(() => (highlighted = null), HIGHLIGHT_MS);
    document.getElementById(cardId(i))?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
  onDestroy(() => clearTimeout(timer));
</script>

<h2 tabindex="-1" use:focusHeading={active}>{git?.title ?? "What you did"}</h2>

{#if remainder.header !== null || remainder.more !== null}
  <details class="subtitle">
    <summary>{subtitle}</summary>
    {#if remainder.header !== null}<p>{remainder.header}</p>{/if}
    {#if remainder.more !== null}<p>{remainder.more}</p>{/if}
  </details>
{:else}
  <p class="subtitle">{subtitle}</p>
{/if}

{#if w.emptyText !== null}
  <p class="empty">{w.emptyText}</p>
{/if}

{#if w.cards.length > 0}
  <div class="pills" role="group" aria-label="Jump to a project">
    {#each w.cards as card, i (card.key)}
      <button type="button" class="ctl jump" onclick={() => jump(card.key, i)}><Pill palette={card.slot} label={card.label} /></button>
    {/each}
  </div>
  <div class="bulk">
    <ActionButton onclick={() => ondispatch({ type: "openAll", keys: w.cards.map((c) => c.key) })}>Open all</ActionButton>
    <ActionButton onclick={() => ondispatch({ type: "closeAll" })}>Close all</ActionButton>
  </div>
{/if}

{#each w.cards as card, i (card.key)}
  {@const isOpen = open.includes(card.key)}
  {@const detail = detailOf(card.key)}
  <div class="slot">
    <Card id={cardId(i)} highlighted={highlighted === card.key}>
      <div class="head">
        <Pill palette={card.slot} label={card.label} wrap />
        {#if cardCountLabel(card) !== null}<span class="caps">{cardCountLabel(card)}</span>{/if}
      </div>
      {#each card.why as why, j (j)}
        <p class="why">{why}</p>
      {/each}
      {#if card.points.length > 0}
        <ul class="points">
          {#each card.points as point, j (j)}
            <li>{point.text}</li>
          {/each}
        </ul>
      {/if}
      {#if card.lines.length > 0 || card.mergedRow !== null || (detail !== null && detail.rows.length > 0)}
        <button type="button" class="ctl more" aria-expanded={isOpen} onclick={() => ondispatch({ type: "toggle", key: card.key })}
          >{#if detail === null}{card.commits > 0 ? `${cardCountLabel(card)} ›` : "Details ›"}{:else}{#if detail.summary.length > 0}{#each detail.summary as part, j (j)}{#if j > 0}<span
                    class="sep">{" · "}</span
                  >{/if}<span class="part {part.tone}">{part.text}</span>{/each}{:else}{cardCountLabel(card) ?? "Details"}{/if}{#if detail.asOf !== null}<span class="sep"
                >{" · "}</span
              ><span class="part muted">{detail.asOf}</span>{/if}{" ›"}{/if}</button
        >
        {#if isOpen}
          <div class="detail" transition:slide={{ duration: openMs() }}>
            {#if detail === null}
              <ul class="lines">
                {#each card.lines as line, j (j)}
                  <li class={line.kind} class:header={line.header}>{line.text}</li>
                {/each}
              </ul>
              {#if card.mergedRow !== null}<p class="merged">{card.mergedRow}</p>{/if}
            {:else}
              <GitRows rows={detail.rows} actions={actions?.did.find((d) => d.key === card.key)?.rows} />
              {#if detail.rest.length > 0}
                <ul class="lines">
                  {#each detail.rest as line, j (j)}
                    <li class={line.kind} class:header={line.header}>{line.text}</li>
                  {/each}
                </ul>
              {/if}
              {#if detail.restMerged !== null}<p class="merged">{detail.restMerged}</p>{/if}
            {/if}
          </div>
        {/if}
      {/if}
      {#if card.todaySoFar.length > 0}
        <p class="caps later">{page.labels.todaySoFar}</p>
        <ul class="lines">
          {#each card.todaySoFar as line, j (j)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
    </Card>
  </div>
{/each}

<style>
  h2 {
    margin: 0 0 0.3rem;
    font-size: 1.3rem;
  }
  h2:focus {
    outline: none;
  }
  .subtitle {
    margin: 0 0 0.7rem;
    color: var(--muted);
  }
  .subtitle summary {
    cursor: pointer;
  }
  .subtitle p {
    margin: 0.3rem 0 0;
    white-space: pre-wrap;
  }
  .empty {
    margin: 0.5rem 0;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.5rem;
  }
  .jump {
    max-width: 16rem;
    padding: 0;
    border: none;
    border-radius: 0.65rem;
    background: none;
    cursor: pointer;
  }
  .bulk {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.7rem;
  }
  .slot {
    margin-bottom: 0.6rem;
  }
  .head {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    min-width: 0;
  }
  /* The user's own words for the project (`— you wrote: "…"`), as on Where you left off. */
  .why {
    margin: 0.4rem 0 0;
    color: var(--muted);
    font-style: italic;
    overflow-wrap: anywhere;
  }
  .points {
    margin: 0.4rem 0 0;
    padding-left: 1.1rem;
    overflow-wrap: anywhere;
  }
  .more {
    margin-top: 0.4rem;
    padding: 0.1rem 0;
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }
  /* B1's summary line (the mockup's `.sumline`): its parts in --fg, the "no remote" and "not matched" tails and
     "as of" in --muted, the separators muted. A narrow card wraps it between parts, never inside one. */
  .more .part {
    color: var(--fg);
    font-weight: 600;
    white-space: nowrap;
  }
  .more .part.grey,
  .more .part.muted {
    color: var(--muted);
    font-weight: 400;
  }
  .lines {
    margin: 0.3rem 0 0;
    padding-left: 1.1rem;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }
  .lines .nested {
    margin-left: 1rem;
  }
  .lines .nested2 {
    margin-left: 2rem;
  }
  .lines .notShown {
    color: var(--muted);
  }
  .lines .header {
    font-weight: 600;
  }
  .merged {
    margin: 0.3rem 0 0;
    font-size: 0.9rem;
  }
  .later {
    margin: 0.5rem 0 0;
  }
</style>
