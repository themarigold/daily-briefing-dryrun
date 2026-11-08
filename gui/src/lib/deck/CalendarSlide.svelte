<script lang="ts">
  /**
   * Today's calendar (A spec): when the page has a calendar section, or (PB-M4, wave-2 polish spec §5) on a live
   * calendar day, today's page with no section while the calendar is on, when `calendar` is null and the slide draws
   * only the live read's no-section view (its read-state line, then the events and the sources' lines). On today's
   * page with a section it holds the section as the page has it — event rows AND status lines ("not connected",
   * "unavailable", each failed source's line), so a failed read never looks like an empty day. On an older page it
   * says only "Calendar shows on today's briefing", and the heading makes no claim to be today's.
   *
   * Briefing redesign C (wave-2 plan C-M5-T13): with today's live view (`live`, `lib/calendar-detail.ts`'s
   * `calendarDetailView`, built by `deckView`), the slide is the day you can act on: the subtitle ("N events · Xh Ym in
   * meetings · next in N minutes"), one line per failure under it, the page's status rows before the first read and after
   * a whole-read failure, the all-day strip, the next-meeting bar with Join, the day timeline (hour marks, the events as
   * buttons, the "now" line, the free gaps as space), the page's "+N more" line under it, and the meeting card of the
   * event clicked (`MeetingCard.svelte`). With no live view (no `calendarDetail` input) the slide draws A's rows.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED: event titles, places, names and notes are calendar text. Positions come from
   * numbers only (`ui/geometry.ts`'s clamping helpers, in custom properties).
   */
  import { untrack } from "svelte";
  import { CALENDAR_NO_EVENTS_TEXT } from "../calendar-contract";
  import {
    CARD_JOIN_LABEL,
    carryOpenKey,
    countdown,
    joinName,
    marksOf,
    markWords,
    sameOpenCard,
    subtitle,
    TIMELINE_MIN_BLOCK_MS,
    timelineLayout,
    timeOf,
    toggleOpenCard,
    type CalendarDetailView,
    type CardKey,
    type LiveEvent,
  } from "../calendar-detail";
  import { nextMeeting, type CalendarSlide } from "../deck";
  import { focusHeading } from "../ui/a11y";
  import { clampInt, clampPct } from "../ui/geometry";
  import JoinButton from "./JoinButton.svelte";
  import MeetingCard from "./MeetingCard.svelte";

  interface Props {
    /** PB-M4: null on a live calendar day (no section on the page): the slide draws the live read only. */
    calendar: CalendarSlide | null;
    /** C: today's live view, or null (an older page, or no live detail input). */
    live?: CalendarDetailView | null | undefined;
    /** The deck's clock (ms since the epoch), re-read by Today every minute and on focus. */
    now: number;
    active: boolean;
  }
  let { calendar, live, now, active }: Props = $props();

  const HOUR = 3_600_000;
  const v = $derived(live ?? null);
  /** The phases that draw the page's rows: before the first read, after a whole-read failure, the calendar off. */
  const pagePhase = $derived(v !== null && (v.phase === "before" || v.phase === "failed" || v.phase === "off"));
  /** The page's rows; none on a live calendar day. */
  const rows = $derived(calendar?.rows ?? []);
  const statusRows = $derived(pagePhase ? rows.filter((r) => r.kind === "status" && r.text !== CALENDAR_NO_EVENTS_TEXT) : []);
  const moreRows = $derived(pagePhase ? rows.filter((r) => r.kind === "more") : []);
  /** No subtitle over the page's status rows on a day with no event ("No calendar is connected" is not "No events today"). */
  const sub = $derived(v === null ? null : subtitle(v, now));
  const showSub = $derived(sub !== null && v !== null && (v.events.length > 0 || !pagePhase || statusRows.length === 0));
  const lay = $derived(v === null ? null : timelineLayout(v, now));
  const next = $derived.by(() => {
    if (v === null) return null;
    const n = nextMeeting(v.pageDate, v.events, now);
    return v.events.find((e) => e === n) ?? null;
  });
  const until = $derived.by(() => {
    if (v === null) return "";
    const c = countdown(v, now);
    return c.kind === "now" ? "Now" : c.kind === "next" ? `In ${c.minutes} ${c.minutes === 1 ? "minute" : "minutes"}` : "";
  });

  /** The card shown: the item it was opened on — its text, its live event's handle and its page-row identity (re-keyed by
   *  the model after a read). Near-duplicates spec §5 "Slide state": a page card is open by its row index and a
   *  handle-only live card by its handle (`sameOpenCard`), so two items with identical text open separately. */
  const cardId = $props.id();
  let opener: HTMLButtonElement | null = null;
  let heading = $state<HTMLHeadingElement | null>(null);
  let cardSlot = $state<HTMLDivElement | null>(null);
  let openKey = $state<CardKey | null>(null);
  // A page carry updates the row without remounting the card; only user actions change this generation.
  let openGeneration = $state(0);
  const rowTexts = $derived(rows.map((r) => r.text));
  let previousRows = untrack(() => rowTexts);
  // Only page-row content changes carry the key. Live reads and identical replacement pages leave it alone.
  $effect.pre(() => {
    const after = rowTexts;
    untrack(() => {
      if (previousRows.length === after.length && previousRows.every((text, i) => text === after[i])) return;
      const next = carryOpenKey(openKey, previousRows, after, v);
      if (openKey !== null && next === null && cardSlot?.contains(document.activeElement)) restoreFocus();
      openKey = next;
      previousRows = after;
    });
  });
  function restoreFocus(): void {
    const target = opener;
    queueMicrotask(() => {
      if (target?.isConnected) target.focus({ preventScroll: true });
      else if (heading?.isConnected) heading.focus({ preventScroll: true });
    });
  }
  function closeCard(): void {
    openKey = null;
    openGeneration++;
    restoreFocus();
  }
  function toggle(rowText: string, e: LiveEvent | null, row: number | null, button: HTMLButtonElement): void {
    const clicked: CardKey = { rowText, handle: e?.handle ?? null, row };
    // `v` is not narrowed in here: with no view nothing is open, so a click opens.
    const next = v === null ? clicked : toggleOpenCard(openKey, clicked, v);
    if (next === null) { closeCard(); return; }
    opener = button;
    openKey = next;
    openGeneration++;
  }
  const isOpen = (rowText: string, e: LiveEvent | null, row: number | null): boolean =>
    v !== null && sameOpenCard(openKey, { rowText, handle: e?.handle ?? null, row }, v);

  /** The lines of text a timeline block has room for (at least 1; the markup takes the whole part), from the numbers
   *  its height is drawn from: 2.4rem an hour (`.timeline`), at least TIMELINE_MIN_BLOCK_MS, less 2px of border and
   *  0.15rem of top padding, over the 1rem line (0.8rem × 1.25, `.block`). `.block` spreads its line-height over exactly
   *  that many lines, so a count that is a little off only loosens or tightens the lines; it never shows a cut one. */
  function roomOf(hours: number, h: number, minH: number): number {
    return Math.max(1, (hours * 2.4 * Math.max(h, minH)) / 100 - 0.125 - 0.15);
  }
</script>

<h2 tabindex="-1" use:focusHeading={active} bind:this={heading}>{calendar !== null && calendar.stale ? "Calendar" : "Today's calendar"}</h2>

{#if calendar !== null && calendar.stale}
  <p class="status">{calendar.staleText}</p>
{:else if v === null || lay === null}
  <ul class="rows">
    {#each rows as row, i (i)}
      <!-- C-M4-T12: the all-day and "time unclear" rows are their own kinds in the model; with no live view the slide
           still draws them as event lines, as A did. -->
      <li class={row.kind === "status" || row.kind === "more" ? row.kind : "event"}>{row.text}</li>
    {/each}
  </ul>
{:else}
  {#if showSub}<p class="sub">{sub}</p>{/if}
  {#each v.lines as line (line)}<p class="line">{line}</p>{/each}

  {#if statusRows.length > 0}
    <ul class="rows">
      {#each statusRows as row, i (i)}<li class="status">{row.text}</li>{/each}
    </ul>
  {/if}

  {#if v.strip.length > 0}
    <ul class="strip">
      {#each v.strip as item, i (i)}
        <li>
          <button type="button" class="strip-item" class:fallback={item.fallback} aria-expanded={isOpen(item.text, item.live, item.row)} aria-controls={cardId} onclick={(e) => toggle(item.text, item.live, item.row, e.currentTarget)}
            >{item.text}</button
          >
        </li>
      {/each}
    </ul>
  {/if}

  {#if next !== null}
    <div class="next">
      <span class="in">{until}</span>
      <button type="button" class="next-what" aria-expanded={isOpen(next.rowText, next.live, next.row)} aria-controls={cardId} onclick={(e) => toggle(next.rowText, next.live, next.row, e.currentTarget)}>
        <strong>{next.title}</strong> <span class="muted">{timeOf(next.rowText)}</span>
      </button>
      {#if next.live !== null && joinName(next.live) !== null}<JoinButton handle={next.live.handle} label={CARD_JOIN_LABEL} />{/if}
    </div>
  {/if}

  <div class="day">
    {#if lay.blocks.length > 0}
      <div class="timeline" style:--hours={clampInt(lay.len / HOUR, 25)} style:--min-block-h={clampPct(TIMELINE_MIN_BLOCK_MS, lay.len)}>
        {#each lay.marks as m (m.at)}
          <div class="hour" style:--top={clampPct(m.at - lay.from, lay.len)} aria-hidden="true"><span>{m.label}</span></div>
        {/each}
        {#each lay.blocks as b, i (i)}
          {@const room = roomOf(clampInt(lay.len / HOUR, 25), clampPct(b.to - b.from, lay.len), clampPct(TIMELINE_MIN_BLOCK_MS, lay.len))}
          <button
            type="button"
            class="block event"
            class:tentative={b.e.tentative}
            class:ended={b.e.ended}
            class:fallback={b.e.fallback}
            style:--top={clampPct(b.from - lay.from, lay.len)}
            style:--h={clampPct(b.to - b.from, lay.len)}
            style:--lane={clampInt(b.lane, 8)}
            style:--lanes={clampInt(b.lanes, 8)}
            style:--lines={clampInt(room, 60)}
            class:one={room < 2}
            aria-expanded={isOpen(b.e.rowText, b.e.live, b.e.row)}
            aria-controls={cardId}
            onclick={(e) => toggle(b.e.rowText, b.e.live, b.e.row, e.currentTarget)}
            ><span class="when">{timeOf(b.e.rowText)}</span> <span class="what">{b.e.title}{#each marksOf(b.e.rowText) as mark (typeof mark === "string" ? mark : mark.kind)}{` · ${markWords(mark)}`}{/each}</span></button
          >
        {/each}
        {#if lay.nowAt !== null}<div class="now" style:--top={clampPct(lay.nowAt - lay.from, lay.len)} aria-hidden="true"></div>{/if}
      </div>
    {/if}
    {#each moreRows as row, i (i)}<p class="more">{row.text}</p>{/each}

    {#if openKey !== null}
      <div class="card-slot" bind:this={cardSlot}>
        {#key openGeneration}
          <MeetingCard id={cardId} view={v} key={openKey} {now} onclose={closeCard} />
        {/key}
      </div>
    {/if}
  </div>
{/if}

<style>
  h2 {
    margin: 0 0 0.7rem;
    font-size: 1.3rem;
  }
  h2:focus {
    outline: none;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .rows li {
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--line);
    overflow-wrap: anywhere;
  }
  .rows .status,
  .rows .more,
  .status,
  .sub,
  .more,
  .muted {
    color: var(--muted);
  }
  .sub {
    margin: -0.4rem 0 0.6rem;
  }
  .line {
    margin: 0 0 0.5rem;
  }
  .more {
    margin: 0.4rem 0 0;
  }
  .strip {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0 0 0.6rem;
    padding: 0;
  }
  button {
    font: inherit;
    color: var(--fg);
    cursor: pointer;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .strip-item {
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 0.65rem;
    background: var(--panel);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .next {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin-bottom: 0.8rem;
    padding: 0.55rem 0.75rem;
    border-radius: 8px;
    background: var(--panel);
  }
  .in {
    font-weight: 700;
    color: var(--state-live);
  }
  .next-what {
    flex: 1 1 10rem;
    min-width: 0;
    padding: 0;
    border: none;
    background: none;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .day {
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem;
    align-items: flex-start;
  }
  /* The window's height follows its hours (a whole number from clampInt); each mark, block and the now line sit at a
     clamped percentage of it (geometry.ts: the unit is added here). */
  .timeline {
    position: relative;
    flex: 1 1 16rem;
    min-width: 0;
    height: calc(var(--hours) * 2.4rem);
    margin: 0.5rem 0 0.5rem 3rem;
    border-left: 1px solid var(--line);
  }
  .hour {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(var(--top) * 1%);
    border-top: 1px dashed var(--line);
  }
  .hour span {
    position: absolute;
    left: -3rem;
    width: 2.6rem;
    transform: translateY(-50%);
    text-align: right;
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .block {
    position: absolute;
    z-index: 1;
    top: calc(var(--top) * 1%);
    left: calc(0.4rem + (100% - 0.6rem) * var(--lane) / var(--lanes));
    width: calc((100% - 0.6rem) / var(--lanes) - 0.2rem);
    height: max(calc(var(--h) * 1%), calc(var(--min-block-h) * 1%));
    padding: 0.15rem 0.5rem 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    background: var(--tile);
    text-align: left;
    font-size: 0.8rem;
    /* The inner height (the drawn height less 2px of border and the top padding; no bottom padding, so the clip edge
       is the content edge) over the --lines the markup counted: the last line ends exactly at the clip edge, and a
       line that does not fit is hidden whole, never cut. */
    line-height: calc((var(--hours) * 2.4rem * max(var(--h), var(--min-block-h)) / 100 - 2px - 0.15rem) / var(--lines));
  }
  /* Room for one line only: the line ends in an ellipsis; the time comes first, so it stays readable. */
  .block.one {
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .block .when {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .block.tentative {
    border-style: dashed;
    border-left-style: dashed;
  }
  .block.ended {
    color: var(--muted);
  }
  /* The event whose card is open, wherever it was opened from. */
  .strip-item[aria-expanded="true"],
  .next-what[aria-expanded="true"],
  .block[aria-expanded="true"] {
    outline: 2px solid var(--accent);
  }
  /* The bar's button has no border or padding of its own: keep the outline off its text. */
  .next-what[aria-expanded="true"] {
    outline-offset: 3px;
  }
  .now {
    position: absolute;
    z-index: 2;
    left: -4px;
    right: 0;
    top: calc(var(--top) * 1%);
    border-top: 2px solid var(--state-live);
    pointer-events: none;
  }
  .card-slot {
    flex: 1 1 16rem;
    min-width: 0;
  }
</style>
