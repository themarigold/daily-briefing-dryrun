<script lang="ts">
  /**
   * The launchpad's meeting tile (A spec, "You're all set"; the S1 decision): from 30 minutes before a
   * meeting, its label turns orange at 5 minutes or less, and during the meeting the tile has the orange
   * outline and a pulsing dot. Clock maths only (`deck.ts`'s `meetingTile`).
   *
   * Briefing redesign C (wave-2 plan C-M5-T14): once a read has answered, the tile is built from the live events
   * (`tileEvents`, `lib/calendar-detail.ts`), and a live event with a usable link gets a real Join inside the tile:
   * "Join ↗" before the meeting, "Join now on {name} ↗" while it is on (`tileJoinLabel`), by handle, through
   * `JoinButton.svelte` (which asks first for a host that is not one of the four known services). Before the first read
   * the tile is A's, with no Join.
   *
   * ⚠ NOT A LIVE REGION. The countdown changes every minute, and a countdown is not announced on every
   * tick (hub, Accessibility): nothing here is `aria-live` or a `LiveRegion`. The state is in words
   * ("In 4 minutes", "Now"), so colour is never the only signal.
   */
  import { tileJoinLabel, type LiveEvent } from "../calendar-detail";
  import { meetingTileText, startLabel, type MeetingTile } from "../deck";
  import Tile from "../ui/Tile.svelte";
  import JoinButton from "./JoinButton.svelte";

  interface Props {
    tile: MeetingTile;
    /** C: the tile's live event (its Join), or null before a read and for a page row. */
    live?: LiveEvent | null | undefined;
  }
  let { tile, live }: Props = $props();

  const joinLabel = $derived(live === null || live === undefined ? null : tileJoinLabel(live, tile.state === "now"));
</script>

<Tile state={tile.state === "now" ? "live" : undefined}>
  <p class="label" class:close={tile.state !== "soon"}>
    {#if tile.state === "now"}<span class="pulse"></span>{/if}{meetingTileText(tile)}
  </p>
  <p class="title">{tile.event.title}</p>
  <p class="time caps">{startLabel(tile.event)}</p>
  {#if live !== null && live !== undefined && joinLabel !== null}
    <div class="join"><JoinButton handle={live.handle} label={joinLabel} /></div>
  {/if}
</Tile>

<style>
  p {
    margin: 0;
  }
  .label {
    font-weight: 600;
  }
  /* 5 minutes or less, and during: the label in the state colour (4.5:1 on --tile, look.check.ts). */
  .close {
    color: var(--state-live);
  }
  .title {
    margin-top: 0.2rem;
    overflow-wrap: anywhere;
  }
  .join {
    margin-top: 0.5rem;
  }
  .pulse {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    margin-right: 0.4rem;
    border-radius: 50%;
    background: var(--state-live);
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
    }
  }
</style>
