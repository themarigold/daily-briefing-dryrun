<script lang="ts">
  /**
   * Briefing redesign C (wave-2 plan C-M5-T13): a live event's people and notes on the meeting card, as the card holds
   * them while it is open (`MeetingCard.svelte`). People: one initials chip per SHOWN name, the names underneath
   * (`peopleLine`, `lib/calendar-detail.ts`: the organiser first and marked, the cut at 5, "Just you"). Notes: one box per
   * merged view (calendar near-duplicates spec §5, D1; `NotesBox`), core first, then each other view's box, headed
   * **Other copy** and then its title when shown; each body shows about four lines and scrolls to the rest. Presentation
   * only.
   *
   * ⚠ PLAIN TEXT ONLY: names and notes are calendar text, and notes may hold link-shaped text, which stays inert text.
   */
  import type { NotesBoxList, PeopleLine } from "../calendar-detail";

  interface Props {
    people: PeopleLine;
    notes: NotesBoxList;
  }
  let { people, notes }: Props = $props();
</script>

<div class="kv">
  <span class="k">People</span>
  <div>
    {#if people.chips.length > 0}
      <!-- The names follow as text; the chips repeat them as initials, so a screen reader hears each name once. -->
      <ul class="chips" aria-hidden="true">
        {#each people.chips as chip, i (i)}<li class="av" title={chip.name}>{chip.initials}</li>{/each}
      </ul>
    {/if}
    <p class="who">{people.text}</p>
  </div>
  {#if notes.length > 0}
    <span class="k">Notes</span>
    <div class="boxes">
      {#each notes as box, i (i)}
        <div class="box">
          {#if box.notes !== null}
            {#if box.kind === "other"}
              <p class="copy">Other copy</p>
              {#if box.title !== null}<p class="title">{box.title}</p>{/if}
            {/if}
            <!-- The body scrolls past about four lines, so the keyboard must reach it to scroll (axe's
                 scrollable-region-focusable), named by its label. Svelte counts a region as non-interactive; a focusable
                 scroll container is the one case where that is wanted (as Deck.svelte's slides). -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div role="region" class="notes" tabindex="0" aria-label={box.label}>
              <p class="body">{box.notes}</p>
            </div>
          {:else}
            <!-- A title-only other box keeps its heading and title inside the focusable region. -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div role="region" tabindex="0" aria-label={box.label}>
              <p class="copy">Other copy</p>
              {#if box.title !== null}<p class="title">{box.title}</p>{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .kv {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    gap: 0.3rem 0.6rem;
    margin-top: 0.6rem;
    font-size: 0.88rem;
  }
  .k {
    color: var(--muted);
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0 0 0.2rem;
    padding: 0;
    list-style: none;
  }
  /* The card is --tile, and --panel is the same colour as --tile in dark mode: the --line hairline is what draws the
     chips and the notes box there. */
  .av {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--panel);
    color: var(--muted);
    font-size: 0.66rem;
    font-weight: 700;
  }
  .boxes {
    display: grid;
    gap: 0.4rem;
  }
  .box {
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--panel);
  }
  /* About four lines of body, then scroll; the heading, title, padding and border sit outside this cap. */
  .notes {
    max-height: calc(4 * 1.4em);
    overflow-y: auto;
    line-height: 1.4;
  }
  .body {
    white-space: pre-line;
  }
  [role="region"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .copy {
    color: var(--muted);
    font-size: 0.8rem;
    font-weight: 700;
  }
  .title {
    font-weight: 600;
  }
</style>
