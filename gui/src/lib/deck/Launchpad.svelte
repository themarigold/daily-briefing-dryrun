<script lang="ts">
  /**
   * You're all set, or "Before you start" while an amber tile waits (the launchpad, A spec S1; polish §6:
   * `launchpadHeading`, the same rule the deck's dots read): the mood line (today's page only), the meeting tile
   * (today's page only, from the page's event times and the deck's clock), and the two buttons: "Full briefing" (the
   * classic view of the same file) and "Past briefings" (History, through App's route callback).
   *
   * B1 (wave-2 plan B1-M6-T18), from the live git check (`git`): after the meeting tile, S1's git tiles ("Only on
   * this Mac", then at most 3 "Not committed", then "+N more repos not committed"), each `GitTile`, chosen by the
   * model at the deck's clock (`launchpadTiles(git, now)`: a green tile leaves 5 minutes after it turned green), and
   * the mood line through `liveMoodLine` (a meeting wins; else the amber tiles' "A couple of things are waiting." /
   * "One thing is waiting."; else A's line). The live tiles show on an older page too; its mood line does not.
   *
   * B2-M6-T15, from `actions` (`actions.ts`): the "Only on this Mac" tile carries Copy push command, and the Resume tiles
   * follow all of B1's tiles and its overflow line, neutral, so they move neither the heading nor the cap. This component
   * owns the Resume control, so the chooser is drawn here, under the tiles; Today's save publication arrives by context.
   */
  import { getContext, untrack } from "svelte";
  import { actionRuns, EDITOR_FLOW_IDLE, editorFlow, liveEditorButton, onNewPage, type ActionLine, type ActionsView, type EditorFlowState } from "../actions";
  import { ACTIONS_ANNOUNCE, ACTIONS_PAGE, ACTIONS_SAVED, type ActionsAnnounce, type ActionsPage, type ActionsSaved } from "../actions-live";
  import { liveDayLine, liveOf, tileEvents, type CalendarDetailView } from "../calendar-detail";
  import { meetingTile, type DeckPage } from "../deck";
  import { copyPushCommand, editorChoiceSet, editorList, editorOpen } from "../engine";
  import { launchpadHeading, launchpadTiles, liveMoodLine, type GitDetailView } from "../git-detail";
  import ActionButton from "../ui/ActionButton.svelte";
  import { focusHeading } from "../ui/a11y";
  import Tile from "../ui/Tile.svelte";
  import EditorChooser from "./EditorChooser.svelte";
  import GitTile from "./GitTile.svelte";
  import MeetingTile from "./MeetingTile.svelte";

  interface Props {
    page: DeckPage;
    /** The deck's clock (ms since the epoch), re-read by Today every minute and on focus. */
    now: number;
    /** C (wave-2 plan C-M5-T14): today's calendar details read live; the tile follows the live events once a read has
     *  answered, and a live event's tile carries Join. */
    live?: CalendarDetailView | null | undefined;
    /** PB-M4: the deck has the calendar slide (a section, or a live calendar day): the tile and the live read count. */
    calendarDay: boolean;
    active: boolean;
    onfull: () => void;
    onhistory: () => void;
    /** B1: the live git check's view; null (or absent) before a page. */
    git?: GitDetailView | null | undefined;
    /** B2: the buttons from current held handles; null (or absent) before any. */
    actions?: ActionsView | null | undefined;
  }
  let { page, now, live, calendarDay, active, onfull, onhistory, git, actions }: Props = $props();

  const tile = $derived(calendarDay && !page.stale ? meetingTile(page.pageDate, tileEvents(page, live ?? null), now) : null);
  const gitTiles = $derived(launchpadTiles(git ?? null, now));
  const resume = $derived(actions?.resume ?? []);
  const copy = $derived(actions?.tile ?? null);

  let answer = $state.raw<ActionLine | null>(null);
  const announce = getContext<ActionsAnnounce | undefined>(ACTIONS_ANNOUNCE) ?? (() => {});
  const runs = actionRuns((line) => (answer = line), announce);
  const applySaved = getContext<ActionsSaved | undefined>(ACTIONS_SAVED) ?? (() => {});
  let editing = $state.raw<EditorFlowState>(EDITOR_FLOW_IDLE);
  const editors = editorFlow({ editorList, editorOpen, editorChoiceSet, applySaved, publish: (s) => (editing = s), announce });
  const pageKey = getContext<ActionsPage | undefined>(ACTIONS_PAGE) ?? (() => null);
  const newPage = onNewPage(() => { runs.reset(); editors.reset(); });
  $effect.pre(() => { const key = pageKey(); untrack(() => newPage(key)); });
</script>

<h2 tabindex="-1" use:focusHeading={active}>{launchpadHeading(git ?? null)}</h2>

<!-- Round-2 L5: the mood line is a claim about NOW, so an older page draws none (A spec: labels relative to the
     page's date, never to now). Today's page draws it, the calendar off included ("Nothing needs you right now."). -->
{#if !page.stale}<p class="mood">{liveMoodLine(tile, gitTiles, liveDayLine(live?.readState ?? null))}</p>{/if}

{#if tile !== null}
  <div class="tile"><MeetingTile {tile} live={liveOf(live ?? null, tile.event)} /></div>
{/if}

{#if gitTiles.tiles.length > 0 || gitTiles.more !== null || resume.length > 0 || editing.card !== null}
  <div class="git-tiles">
    {#each gitTiles.tiles as t (t.key)}
      <GitTile tile={t}>
        {#if t.key === "onlyHere"}
          {#if copy !== null}<button type="button" class="ctl act" onclick={() => runs.copy("onlyHere", copy.handles, copyPushCommand)}>{copy.label}{#if copy.suffix !== null}{" "}{copy.suffix}{/if}</button>{/if}
          {#if answer?.key === "onlyHere"}{#each answer.lines as text, k (k)}<p class="reply">{text}</p>{/each}{/if}
        {/if}
      </GitTile>
    {/each}
    {#if gitTiles.more !== null}
      <Tile>
        <p class="value" class:dim={gitTiles.moreAsOf !== null}>{gitTiles.more}</p>
        {#if gitTiles.moreAsOf !== null}<p class="as-of">{gitTiles.moreAsOf}</p>{/if}
      </Tile>
    {/if}
    {#each resume as r (r.key)}
      <Tile>
        <button type="button" class="ctl resume" aria-disabled={editing.busy} onclick={(e) => editors.click(r.key, r.button, e.altKey)}>{r.label}</button>
      </Tile>
    {/each}
    {#if editing.card !== null}
      <div class="wide">
        {#if editing.saveLine !== null}<p class="reply">{editing.saveLine}</p>{/if}
        {#if editing.line !== null}<p class="reply">{editing.line}</p>{/if}
        {#if editing.chooser !== null}<EditorChooser view={editing.chooser} onopen={(editor, remember) => editors.open(editor, remember, liveEditorButton(resume.filter((r) => r.key === editing.card).map((r) => r.button), editing.project))} oncancel={() => editors.cancel()} />{/if}
      </div>
    {/if}
    {#if resume.length > 0 && actions !== null && actions !== undefined && actions.editorError !== null}
      <p class="reply wide">{actions.editorError}</p>
    {/if}
  </div>
{/if}

<div class="buttons">
  <ActionButton onclick={onfull}>Full briefing</ActionButton>
  <ActionButton onclick={onhistory}>Past briefings</ActionButton>
</div>

<style>
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.3rem;
  }
  h2:focus {
    outline: none;
  }
  .mood {
    margin: 0 0 0.8rem;
    color: var(--muted);
  }
  .tile {
    max-width: 22rem;
    margin-bottom: 0.8rem;
  }
  /* S1's tiles after the meeting tile: the same width, side by side while they fit. */
  .git-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 0.6rem;
    max-width: 36rem;
    margin-bottom: 0.8rem;
  }
  .value {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .dim, .as-of {
    color: var(--muted);
  }
  .as-of {
    margin: 0.2rem 0 0;
    font-size: 0.8rem;
  }
  .act {
    margin-top: 0.4rem;
    font: inherit;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  /* A Resume tile's one control is its words, drawn as the tile's text. */
  .resume {
    padding: 0;
    font: inherit;
    text-align: left;
    overflow-wrap: anywhere;
    border: 0;
    background: none;
    color: var(--fg);
    cursor: pointer;
    text-decoration: underline;
  }
  .reply {
    margin: 0.3rem 0 0;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .wide {
    grid-column: 1 / -1;
  }
</style>
