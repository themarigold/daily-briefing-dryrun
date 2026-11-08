<script lang="ts">
  /**
   * Briefing redesign C (wave-2 plan C-M5-T13): the condensed meeting card, opened by clicking an event on the calendar
   * slide (C "Clicking an event opens a condensed meeting card"): title, time and place; Join ↗; people (initials, names
   * underneath); the notes, one scrolling box per merged view, as plain text; Open in Calendar (macOS); "Read live at HH:MM · not saved".
   * What it says per state is `cardView` (`lib/calendar-detail.ts`): the live event, the page's facts while loading or
   * after a failed read, "This event changed since your briefing", or a fallback row after a partial read.
   *
   * ⚠ PEOPLE AND NOTES LIVE ONLY WHILE THE CARD IS OPEN, the event has not ended and the day has not changed (C "What the
   * webview gets"): they are asked by handle (`calendarDetailsGet`, which reads nothing) when the card shows a live event,
   * dropped on close (and the card is remounted for each event it opens on, `CalendarSlide.svelte`'s `{#key}`), and
   * dropped at the event's end and at the day change on Today's clock (`now`). A stale handle reaches Today's calendar
   * driver through the `CALENDAR_STALE` context (one `focus` ask); with no context (a test render) nothing happens.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED: titles, places, names and notes are calendar text, and notes may hold
   * link-shaped text, which stays inert text. Nothing here builds a link; Join is by handle (`JoinButton.svelte`).
   */
  import { getContext, onDestroy, untrack } from "svelte";
  import {
    CARD_JOIN_LABEL,
    cardFacts,
    cardView,
    CHANGED_LINE,
    cardDetailsReply,
    expireCardDetails,
    resetCardDetails,
    shownCardDetails,
    joinName,
    LOADING_LINE,
    markWords,
    openInCalendar,
    SEVERAL_LINKS_LINE,
    type CalendarDetailView,
    type CardKey,
    type CardDetails,
  } from "../calendar-detail";
  import { CALENDAR_STALE, type CalendarStale } from "../calendar-live";
  import { calendarAppOpen, calendarDetailsGet, type CalendarDetailsGetReply } from "../engine";
  import { osFromUserAgent, type Os } from "../platform";
  import ActionButton from "../ui/ActionButton.svelte";
  import { focusHeading } from "../ui/a11y";
  import JoinButton from "./JoinButton.svelte";
  import MeetingDetails from "./MeetingDetails.svelte";

  interface Props {
    view: CalendarDetailView;
    key: CardKey;
    /** The deck's clock: the data life is checked on every tick and focus. */
    now: number;
    onclose: () => void;
    id?: string;
    os?: Os;
  }
  let { view, key, now, onclose, id, os = typeof navigator === "undefined" ? "other" : osFromUserAgent(navigator.userAgent) }: Props = $props();

  const stale = getContext<CalendarStale | undefined>(CALENDAR_STALE);
  const card = $derived(cardView(view, key));
  const facts = $derived(cardFacts(card));
  const lines = $derived(card.kind === "changed" ? [CHANGED_LINE] : card.lines);
  const handle = $derived(card.kind === "live" ? card.event.handle : null);

  /** The shown live event's people and notes, by handle, with when they must be dropped. */
  let details = $state<CardDetails | null>(null);
  let closed = false;
  onDestroy(() => { closed = true; details = null; });

  async function load(h: string): Promise<void> {
    let reply: CalendarDetailsGetReply;
    try {
      reply = await calendarDetailsGet(h);
    } catch {
      return;   // An IPC failure: no people or notes; the rest of the card stands.
    }
    if (closed) return;
    const step = cardDetailsReply(h, card, view.pageDate, reply, Date.now());
    if (step.kind === "stale") { stale?.onStale(); return; }
    if (step.kind === "details") details = step.details;
  }

  // Asked once per handle: a read that re-keys the card to a new handle drops the old details and asks again.
  $effect(() => {
    const h = handle;
    untrack(() => {
      details = resetCardDetails(details, h);
      if (h !== null) void load(h);
    });
  });
  // The data life: dropped at the event's end and at the day change.
  $effect(() => { details = expireCardDetails(details, now); });
  const shown = $derived(shownCardDetails(details, handle, now));

  function close(): void { closed = true; details = null; onclose(); }
  function onkeydown(e: KeyboardEvent): void {
    if (!e.defaultPrevented && e.key === "Escape") { e.preventDefault(); close(); }
  }

  function openCalendar(): void {
    calendarAppOpen().catch(() => undefined);
  }
</script>

<svelte:window {onkeydown} />

<section {id} class="card" aria-label={facts.title}>
  <div class="head">
    <h3 tabindex="-1" use:focusHeading>{facts.title}</h3>
    <ActionButton onclick={close}>Close</ActionButton>
  </div>
  <p class="when">{facts.when}{#each facts.marks as mark (typeof mark === "string" ? mark : mark.kind)}{` · ${markWords(mark)}`}{/each}</p>
  {#if facts.place !== null && facts.place.trim() !== ""}<p class="place">{facts.place}</p>{/if}

  {#if card.kind === "live"}
    {#if card.event.linkState === "several"}
      <p class="line">{SEVERAL_LINKS_LINE}</p>
    {:else if joinName(card.event) !== null}
      <div class="join"><JoinButton handle={card.event.handle} label={CARD_JOIN_LABEL} /></div>
    {/if}
    {#if shown !== null}<MeetingDetails people={shown.people} notes={shown.notes} />{/if}
  {:else if card.kind === "page" && card.loading}
    <p class="loading">{LOADING_LINE}</p>
  {/if}
  {#each lines as line (line)}<p class="line">{line}</p>{/each}

  {#if openInCalendar(view, card, os)}<div class="open"><ActionButton onclick={openCalendar}>Open in Calendar</ActionButton></div>{/if}
  {#if card.kind === "live"}<p class="foot">{card.footnote}</p>{/if}
</section>

<style>
  .card {
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--tile-border);
    border-radius: 10px;
    background: var(--tile);
    box-shadow: var(--tile-shadow);
    overflow-wrap: anywhere;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }
  /* The heading takes the free width (basis 0), so a long title wraps in it and never squeezes Close, which the
     card's `overflow-wrap: anywhere` would otherwise let break mid-word. */
  h3 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 1.05rem;
  }
  h3:focus {
    outline: none;
  }
  p {
    margin: 0.3rem 0 0;
  }
  .when,
  .place,
  .loading,
  .foot {
    color: var(--muted);
    font-size: 0.88rem;
  }
  .join,
  .open {
    margin-top: 0.5rem;
  }
  .line {
    margin-top: 0.5rem;
  }
  .foot {
    margin-top: 0.6rem;
    font-size: 0.78rem;
  }
</style>
