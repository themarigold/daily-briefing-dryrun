<script lang="ts">
  /**
   * Redesign D — the save bar at the bottom of whichever Settings page is open, the draft's network-check question
   * above its Save, and the outcome area below it. Props only, so it can be server-rendered (`tests-web/
   * settings-pages.check.ts`); the draft, the save functions and every decision stay in `routes/Settings.svelte`,
   * which computes `shown`, `changed` and `blocked` with `settings/pages.ts`.
   *
   * - The bar is shown while the draft (or the JSON editor's text) differs from what was loaded. A pending provider
   *   Add or Replace alone does not show it (its Save and Discard are its own); while both are true, Discard also ends
   *   the flow — the shell's `discardChanges`, exactly as today's "Discard changes" — and the bar says so.
   * - The outcome area (the save report, the key lines, the judge line) has its own visibility: a save that lands
   *   makes the draft clean and hides the bar, and its outcome must still show.
   * - Final round 1 (H2), final round 2 (R2-M2): the question and the bar sit in ONE dock pinned to the bottom of the
   *   window; the outcome area is NOT in it (in the dock it covered up to half of a 420px window, and the control
   *   the user was on). It is the next element, in the page's flow at its bottom, under the bar, and whatever the
   *   user's Save produces (a result, a refusal, "Answer the network-check question above…") is brought into view
   *   once it arrives (the shell's `reveal`, final round 3), so it shows beside the bar without the user scrolling. While the bar is drawn, the pages'
   *   controls keep the dock's height clear below them when scrolled into view (`--dock-clear`, final round 3), so a
   *   control the keyboard moves to is never placed under the bar (WCAG 2.4.11). The outcome is announced politely
   *   (`aria-live`), and the region is always drawn so a change in it is heard.
   * - Final round 3: where focus and the view go after the user's Save or Discard is NOT decided here: the shell asks
   *   (`reveal`, `settings/pages.ts`) and SettingsPages acts — the outcome area, the first marked field, or the
   *   page's title. This component only draws; the outcome area takes the focus by script (`tabindex="-1"`).
   * - The buttons are Step 0's `ActionButton` (M2).
   */
  import type { SaveOutcome } from "../files";
  import { NETWORK_ASK } from "../settings-model";
  import SaveReport from "../../routes/SaveReport.svelte";
  import ActionButton from "../ui/ActionButton.svelte";
  import { hasOutcome, PAGES, type PageId } from "./pages";

  interface Props {
    /** The page on screen. */
    current: PageId;
    /** The pages with unsaved edits (`changedPages`), in the sidebar's order. */
    changed: PageId[];
    /** Draw the bar (`saveBarShown`). */
    shown: boolean;
    /** The pages holding a save-blocking field (`blockedPages`). */
    blocked: PageId[];
    /** The provider flow that is pending (running, or waiting for its own Save or Discard), if any: the bar's Discard
     *  ends it too, and says so in its words. */
    pendingFlow: "add" | "replace" | null;
    saving: boolean;
    onsave: () => void;
    ondiscard: () => void;
    /** Open a page: the button naming a page with a field to fix. */
    onopenpage: (page: PageId) => void;
    /** The draft's network-check question is on screen (`askNetwork`). */
    askNetwork: boolean;
    /** Its answer; it defaults to yes (spec §6). */
    networkYes: boolean;
    outcome: SaveOutcome | null;
    failure: string;
    keyLines: string[];
    judgeLine: string | null;
  }
  let {
    current,
    changed,
    shown,
    blocked,
    pendingFlow,
    saving,
    onsave,
    ondiscard,
    onopenpage,
    askNetwork,
    networkYes = $bindable(),
    outcome,
    failure,
    keyLines,
    judgeLine,
  }: Props = $props();

  const label = (page: PageId): string => PAGES.find((p) => p.id === page)?.label ?? page;
  const others = $derived(changed.filter((p) => p !== current).map(label));
  const fixOn = $derived(blocked.filter((p) => p !== current));
  const outcomeShown = $derived(hasOutcome({ outcome, failure, keyLines, judgeLine }));
</script>

<div class="dock">
  <!-- L4: the question goes with the bar: an edit put back leaves nothing to save, so nothing to answer. -->
  {#if askNetwork && shown}
    <div class="ask">
      <p>{NETWORK_ASK.question}</p>
      <label class="inline">
        <input type="checkbox" bind:checked={networkYes} />
        {NETWORK_ASK.yes}
      </label>
    </div>
  {/if}
  {#if shown}
    <!-- Part B: the S-A mockup's strip — the words on the left, Discard and Save on the right. -->
    <div class="bar">
      <div class="words">
      <p class="unsaved">
        You have unsaved changes{changed.includes(current) ? " on this page" : ""}{#if others.length > 0}{changed.includes(current) ? " — also on " : " on "}{others.join(", ")}{/if}.
      </p>
      {#if fixOn.length > 0}
        <!-- L5: the names joined as words, "on Projects and Advanced". -->
        <p class="fix">
          To save, fix the marked fields on
          {#each fixOn as page, i (page)}{#if i > 0}{i === fixOn.length - 1 ? " and " : ", "}{/if}<ActionButton
              onclick={() => onopenpage(page)}>{label(page)}</ActionButton
            >{/each}
        </p>
      {/if}
      {#if pendingFlow === "add"}
        <p class="muted">Discard also cancels the provider being added.</p>
      {:else if pendingFlow === "replace"}
        <p class="muted">Discard also cancels the key being replaced.</p>
      {/if}
      </div>
      <div class="actions">
        <ActionButton disabled={saving} onclick={ondiscard}>Discard</ActionButton>
        <ActionButton kind="primary" disabled={saving} onclick={onsave}
          >{saving ? "Checking with the engine…" : "Save"}</ActionButton
        >
      </div>
    </div>
  {/if}
</div>
<!-- R2-M2: under the dock, in the page's flow; R2-L7: always drawn, so a result arriving in it is announced. -->
<div class="outcome" aria-live="polite" tabindex="-1">
  {#if outcomeShown}
    <div class="report">
      <SaveReport {outcome} {failure} />
      {#each keyLines as line, n (n)}
        <p class="muted">{line}</p>
      {/each}
      {#if judgeLine !== null}
        <p class="muted judge">{judgeLine}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* H2: one pinned dock for the question and the bar (the page scrolls under it). Part B: a full-width strip on the
   * tile colour with a top line only, bleeding across the content's side padding (`--gutter`, set by SettingsPages). */
  .dock {
    position: sticky;
    bottom: 0;
    margin: 0 calc(-1 * var(--gutter, 0px));
    font-size: 13px;
  }
  .ask {
    padding: 10px 28px;
    background: var(--tile);
    border-top: 1px solid var(--tile-border);
  }
  /* Final round 3 (R3-H1): how much room the dock takes at the window's bottom, `--dock-clear`, which the pages'
   * controls keep below themselves when the browser scrolls one into view (SettingsPages' `scroll-margin-bottom`), so
   * a control the keyboard or a reveal moves to lands above the bar, not under it (WCAG 2.4.11). Round 2 put this on
   * the document as a bottom scroll padding, and then focusing or clicking the bar's OWN buttons scrolled the page by
   * half a window; the bar's buttons, outside every page, now get none. CSS cannot read the dock's height, so each
   * part the dock can hold adds its measured upper bound plus a margin (Chrome, 560x420 and 900x640, the PR body's
   * table): the bar 51.8px; with the pending flow's line 72.5px; with the pages to fix, alone or with that line, up
   * to 138.1px; the question adds 92.8px. Where `:has()` is missing, nothing sets it and the controls keep 64px. */
  :global(html):has(.bar) {
    --dock-clear: calc(var(--dock-bar, 64px) + var(--dock-ask, 0px));
  }
  :global(html):has(.bar .muted) {
    --dock-bar: 88px;
  }
  :global(html):has(.bar .fix) {
    --dock-bar: 152px;
  }
  :global(html):has(.ask) {
    --dock-ask: 100px;
  }
  .ask p {
    margin: 0 0 4px;
  }
  .inline {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 28px;
    background: var(--tile);
    border-top: 1px solid var(--tile-border);
  }
  .words {
    flex: 1 1 14rem;
    min-width: 0;
  }
  .bar p {
    margin: 0;
  }
  .bar p + p {
    margin-top: 4px;
  }
  .unsaved {
    font-weight: 400;
    font-size: 13px;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .judge {
    margin-top: 6px;
  }
  /* The outcome at the page's bottom, under the bar's place; it scrolls with the page (R2-M2). */
  .report {
    padding: 4px 0 14px;
  }
  .report p {
    margin: 0 0 4px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  /* Below 720 px the content's side padding is 16px (SettingsPages). */
  @media (max-width: 720px) {
    .ask,
    .bar {
      padding-inline: 16px;
    }
  }
</style>
