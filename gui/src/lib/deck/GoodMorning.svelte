<script lang="ts">
  /**
   * Good morning (A spec, "Good morning (M1)"; rebuilt to the user's option 2 with the "COMMITS" column
   * header, user-directed 2026-10-22). ONE sunrise card the slide's height, everything centred: a small
   * sun, the greeting and the date, then one row — the status badge, Run now and an "i" whose note holds
   * Run now's hint (`RunControls`, `hint="info"`) — then EVERYTHING the classic Today screen shows above
   * the briefing, in today's order: every banner verbatim, the run's result line and Details, the loading
   * and first-run texts, the quiet-day line. Then "Your recent work", the commit bars (projects with counted
   * commits only) under a small-caps COMMITS header, the glance tiles, and Start › alone last. On an
   * older page the greeting is the sentence with its date, and no second date line is drawn.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED (status, banners, labels and suggestions carry repo-controlled
   * text, `docs/gui-seam.md` §5). The loading and first-run texts are `TodayView.svelte`'s, word for word
   * (pinned by `tests-web/deck-render.check.ts`).
   *
   * The gradient now holds controls, and `--control` is not 3:1 on its stops (app.css): so Run now and the
   * i have their own --tile surface with a --muted edge, Start is the --accent fill, and text on the card
   * is --fg, --muted or --danger (each measured on every stop and blend, `tests-web/look.check.ts`).
   *
   * B1 (wave-2 plan B1-M6-T18), from the live git check (`git`, the model's words): "Your recent work" carries the
   * live PR count once the detail arrives, and the Needs-a-look tile appends "N commits exist only on this Mac. See
   * Suggested." after the page's own lines, showing with that line alone too (`needsALookShown`). The
   * first-suggestion tile stays the page's first card, never a push card.
   */
  import type { GlanceMeeting, GoodMorning } from "../deck";
  import { startLabel, WORK_LABEL } from "../deck";
  import { needsALookShown, type GitDetailView } from "../git-detail";
  import { paletteClass } from "../project-color";
  import RunControls from "../RunControls.svelte";
  import type { TodayModel } from "../today";
  import { focusHeading } from "../ui/a11y";
  import { clampPct } from "../ui/geometry";
  import Pill from "../ui/Pill.svelte";
  import Tile from "../ui/Tile.svelte";

  interface Props {
    gm: GoodMorning;
    model: TodayModel;
    /** The next-meeting glance tile: only on today's page when its deck has the calendar slide — a calendar section, or
     *  (PB-M4) a live calendar day (the caller decides). Headed
     *  "Now" while its meeting runs, else "Next meeting" (`glanceMeeting`, round-2 M1). */
    meeting: GlanceMeeting | null;
    /** The slide's heading takes focus when this turns true (a slide change). */
    active: boolean;
    /** Good morning is the slide on screen (unlike `active`, true before the first move too): the "i" note
     *  closes when it is not. */
    current: boolean;
    /** Start ›: to the next slide; null when Good morning is the only slide. */
    onstart: (() => void) | null;
    running: boolean;
    progress: string[];
    runResult: string;
    detailsOpen: boolean;
    onrun: () => void;
    /** B1: the live git check's view; null (or absent) before a page or before it answers. */
    git?: GitDetailView | null | undefined;
  }
  let { gm, model, meeting, active, current, onstart, running, progress, runResult, detailsOpen, onrun, git }: Props = $props();

  const maxCommits = $derived(Math.max(1, ...gm.bars.map((b) => b.commits)));
  /** B1's live line for the Needs-a-look tile, and whether the tile shows. */
  const liveLine = $derived(git?.goodMorningLine ?? null);
  const liveAsOf = $derived(git?.goodMorningAsOf ?? null);
  const lookShown = $derived(needsALookShown(gm.needsALook, git ?? null));
</script>

<div class="sunrise">
  <span class="sun" aria-hidden="true"></span>
  <h2 tabindex="-1" use:focusHeading={active}>{gm.greeting}</h2>
  <!-- On an older page the title is the sentence ("Your last briefing, from …"): its date is not said twice. -->
  {#if !gm.stale}<p class="date">{gm.date}</p>{/if}

  <RunControls hint="info" shown={current} {running} {progress} {runResult} {detailsOpen} {onrun}>
    {#snippet status()}
      {#if gm.status !== null}
        <div class="badge {gm.status.tone}">{gm.status.text}</div>
      {:else}
        <p class="muted">Checking…</p>
      {/if}
    {/snippet}
    {#snippet banners()}
      {#each gm.banners as banner, i (i)}
        <p class="banner {banner.tone}">{banner.text}</p>
      {/each}
    {/snippet}
  </RunControls>

  {#if model.loading}
    <p class="muted state">Loading the latest briefing…</p>
  {:else if model.empty}
    <div class="state empty">
      <h3>No briefing yet</h3>
      <p>
        The engine has not written a briefing on this machine yet. The first one is generated on the
        first check after your morning time once the machine is awake, or when you run it now.
      </p>
    </div>
  {/if}

  {#if gm.quietLine !== null}
    <p class="state quiet">{gm.quietLine}</p>
  {/if}

  {#if gm.aiSentence !== null}<p class="ai-sentence">{gm.aiSentence}</p>{/if}

  {#if (git?.workLine ?? gm.workLine) !== null}
    <!-- `workLine` is WORK_LABEL, a space, then the counts (deck.ts; B1's live one the same form): the label is drawn bold. -->
    <p class="work"><strong>{WORK_LABEL}</strong> {(git?.workLine ?? gm.workLine)!.slice(WORK_LABEL.length + 1)}</p>
  {/if}

  {#if gm.bars.length > 0}
    <div class="chart">
      <!-- The column header is for the eye only: each row's count already says " commit(s)" to a screen reader. -->
      <p class="caps head" aria-hidden="true">Commits</p>
      <ul class="bars" aria-label="Commits per project">
        {#each gm.bars as bar (bar.key)}
          <li>
            <span class="who"><Pill palette={bar.slot} label={bar.label} wrap /></span>
            <span class="lane"><span class="bar {paletteClass(bar.slot)}" style:--w={clampPct(bar.commits, maxCommits)}></span></span>
            <span class="count">{bar.commits}<span class="sr-only">{bar.commits === 1 ? " commit" : " commits"}</span></span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if meeting !== null || gm.firstSuggestion !== null || lookShown}
    <div class="tiles">
      {#if meeting !== null}
        <Tile>
          <p class="caps">{meeting.heading}</p>
          <p class="tile-text">{startLabel(meeting.event)} · {meeting.event.title}</p>
        </Tile>
      {/if}
      {#if gm.firstSuggestion !== null}
        <Tile>
          <p class="caps">First suggestion</p>
          <p class="tile-text">{gm.firstSuggestion.text}</p>
        </Tile>
      {/if}
      {#if lookShown}
        <Tile>
          <p class="caps">Needs a look</p>
          <ul class="look">
            {#each gm.needsALook as line, i (i)}
              <li>{line}</li>
            {/each}
            {#if liveLine !== null}<li class:dim={liveAsOf !== null}>{liveLine}{#if liveAsOf !== null}{" "}<span class="as-of">{liveAsOf}</span>{/if}</li>{/if}
          </ul>
        </Tile>
      {/if}
    </div>
  {/if}

  {#if onstart !== null}
    <div class="go"><button type="button" class="ctl start" onclick={onstart}>Start ›</button></div>
  {/if}
</div>

<style>
  /* The whole slide is the card (option 2): at least the slide's height, and it grows (the slide scrolls,
     "More below") when a state draws more. Its content, Start included, is one group centred in the card
     (spacing option A, user-directed 2026-10-22), so a window taller than the default shares the spare height
     above and below instead of leaving it all above Start. Tight enough that the default sample fits the
     window's default 900×640 with Start, and still does after a run (its result line and the collapsed
     Details; checkpoint M2, measured with Start hit-tested, not boxed). That sample has no AI sentence: the
     sentence is asked to stay near two lines and may run to about three, so with it Start can sit below the
     fold, with "More below" showing (user decision 2026-11-04). */
  .sunrise {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 100%;
    padding: 0.45rem 1.2rem 0.4rem;
    border-radius: 14px;
    background: linear-gradient(140deg, var(--sunrise-1), var(--sunrise-2) 55%, var(--sunrise-3));
  }
  /* Decorative (aria-hidden), CSS only: the mockup's sun, the same in both themes. Its colours paint no text
     and no control, so they are not theme tokens. */
  .sun {
    flex: none;
    width: 30px;
    height: 30px;
    margin: 0 0 0.1rem;
    border-radius: 50%;
    background: radial-gradient(circle at 40% 40%, #ffd58a, #f59e0b);
    box-shadow: 0 0 26px rgba(245, 158, 11, 0.45);
  }
  /* The greeting and the date: bigger, with a little more room before the status row (user-directed
     2026-10-22). At 900×640 Start still shows after a run; with the "i" note open it is just below the fold. */
  h2 {
    margin: 0;
    font-size: 36px;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }
  h2:focus {
    outline: none;
  }
  h3 {
    margin: 0 0 0.3rem;
    font-size: 1rem;
  }
  .date {
    margin: 0 0 0.5rem;
    font-size: 20px;
    line-height: 1.25;
    color: var(--muted);
  }
  /* TodayView's status and banner look, the same declarations, on the --tile surface (the card is a gradient). */
  .badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    background: var(--tile);
    font-size: 0.9rem;
    font-weight: 600;
    line-height: 1.35;
  }
  .badge.bad,
  .banner.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  .badge.info,
  .banner.info {
    background: var(--panel);
  }
  .badge.warn,
  .banner.warn {
    border-color: var(--danger);
  }
  .banner {
    width: fit-content;
    max-width: 100%;
    margin: 0.6rem auto 0;
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 0.45rem;
    background: var(--tile);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .muted {
    margin: 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .state {
    margin: 0.6rem 0 0;
  }
  /* The work line's type and spacing, on the slide's text colour. */
  .ai-sentence {
    margin: 0.4rem 0 0;
    font-size: 1rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .work {
    margin: 0.4rem 0 0;
    font-size: 1rem;
    line-height: 1.4;
  }
  .work strong {
    font-weight: 600;
  }
  .chart {
    width: 100%;
    max-width: 470px;
    margin-top: 0.2rem;
  }
  /* The COMMITS column header: right-aligned, so it ends where the right-aligned counts end. */
  .head {
    margin: 0;
    line-height: 1.1;
    text-align: right;
  }
  .bars {
    list-style: none;
    margin: 0;
    padding: 0;
    text-align: left;
  }
  .bars li {
    display: grid;
    grid-template-columns: minmax(0, 7.5rem) 1fr minmax(1.5rem, auto);
    gap: 0.6rem;
    align-items: center;
    margin: 0;
    line-height: 1.3;
  }
  .who {
    min-width: 0;
  }
  .lane {
    height: 0.45rem;
  }
  /* The width is a clamped number (lib/ui/geometry.ts); the colour is the slot's --pc-fg. */
  .bar {
    display: block;
    height: 100%;
    min-width: 2px;
    width: calc(var(--w) * 1%);
    border-radius: 3px;
    background: var(--pc-fg);
  }
  .count {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.6rem;
    width: 100%;
    max-width: 640px;
    margin-top: 0.4rem;
    text-align: left;
  }
  .tiles p {
    margin: 0;
  }
  /* The mockup's tile text: a little smaller and tighter than body text, so three tiles stay short. */
  .tile-text,
  .look {
    font-size: 0.9rem;
    line-height: 1.35;
  }
  .tile-text {
    overflow-wrap: anywhere;
  }
  .dim {
    color: var(--muted);
  }
  .as-of {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .look {
    margin: 0;
    padding-left: 1.1rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  /* Start: last in the centred group, alone in its block, the one filled button. Its gap above grows from
     nothing at the default 640px-tall window (where the fit after a run, with no AI sentence, has only a few
     pixels spare) to 1rem once the window is 16px taller. */
  .go {
    margin-top: clamp(0px, calc(100vh - 640px), 1rem);
    padding-top: 0.4rem;
  }
  .start {
    font: inherit;
    font-weight: 600;
    padding: 0.25rem 1.6rem;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
</style>
