<script lang="ts">
  /**
   * Where you left off (A spec): one card per project, from the page's resume bullets and branch lines.
   * The branch is a tag, parsed only from `src/git.ts`'s shapes (`deck.ts`'s `parseBranch`), with its
   * counts beside it (`branchCounts`, user-directed 2026-10-21): "ahead N · behind N", each only when N is
   * above 0; `(no upstream)` and a detached HEAD show neither.
   *
   * A card holding only a branch line is drawn even when the page also says "(nothing in progress)"
   * (`leftOff.empty`): the engine writes both on one page, and the empty line then follows the cards.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED. The branch tag passes `wrap`: it is outside any control, so its
   * whole text must show (`StatusTag`'s note); "On branch" is said in words for a screen reader, since
   * the tag's label replaces its kind's word.
   *
   * B1 (wave-2 plan B1-M6-T18; user decision D1), from the live git check (`git`, the model's words): once it
   * answers, the branch's live words REPLACE A's counts — "N not pushed" or "never pushed" as the dashed amber tag
   * beside the branch tag, and "behind N" muted in A's counts span — with "as of HH:MM" when not current; and the
   * card's "N files not committed" tag (the repo's live count, seeded from the page's "Uncommitted changes: …"
   * bullet until then). A branch no longer there, a detached HEAD and a repo with no remote keep A's words.
   *
   * B2-M6-T15: each card's Open branch, Compare with {default}, Copy push command and the editor control, from
   * `actions` (`actions.ts`). This component owns the editor control, so the chooser is drawn here, under it; Today's
   * save publication arrives by context. Every line under a control is a fixed row from `actions.ts`. A full check re-mints
   * every handle, so nothing here is keyed by one: the buttons by target, the lines and the chooser by card.
   */
  import { getContext, untrack } from "svelte";
  import { actionKey, actionRuns, EDITOR_FLOW_IDLE, editorFlow, lineOf, liveEditorButton, onNewPage, type ActionLine, type ActionsView, type EditorFlowState } from "../actions";
  import { ACTIONS_ANNOUNCE, ACTIONS_PAGE, ACTIONS_SAVED, type ActionsAnnounce, type ActionsPage, type ActionsSaved } from "../actions-live";
  import { branchCounts, type LeftOff } from "../deck";
  import { copyPushCommand, editorChoiceSet, editorList, editorOpen, openGithub } from "../engine";
  import type { GitDetailView } from "../git-detail";
  import { focusHeading } from "../ui/a11y";
  import Card from "../ui/Card.svelte";
  import Pill from "../ui/Pill.svelte";
  import StatusTag from "../ui/StatusTag.svelte";
  import EditorChooser from "./EditorChooser.svelte";

  interface Props {
    leftOff: LeftOff;
    active: boolean;
    /** B1: the live git check's view; null (or absent) before a page. */
    git?: GitDetailView | null | undefined;
    /** B2: the buttons from current held handles; null (or absent) before any. */
    actions?: ActionsView | null | undefined;
  }
  let { leftOff, active, git, actions }: Props = $props();

  /** A card's live words (`git-detail.ts`'s `LeftOffGit`), or null without the view. */
  const liveOf = (key: string) => git?.leftOff.find((x) => x.key === key) ?? null;

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

<h2 tabindex="-1" use:focusHeading={active}>Where you left off</h2>

{#each leftOff.cards as card (card.key)}
  {@const live = liveOf(card.key)}
  {@const acts = actions?.leftOff.find((a) => a.key === card.key) ?? null}
  <div class="slot">
    <Card>
      <div class="head">
        <Pill palette={card.slot} label={card.label} wrap />
        {#if card.branch !== null}
          {#if card.branch.kind === "branch"}
            {@const counts = live?.counts ?? branchCounts(card.branch)}
            <span class="sr-only">{"On branch "}</span><StatusTag kind="branch" label={card.branch.name} wrap />
            {#if live !== null && live.pushTag !== null}<StatusTag kind="local" label={live.pushTag} wrap />{/if}
            {#if counts.length > 0}<span class="counts caps">{counts.join(" · ")}</span>{/if}
            {#if live !== null && live.asOf !== null}<span class="as-of">{live.asOf}</span>{/if}
          {:else}
            <StatusTag kind="branch" label={`Detached HEAD at ${card.branch.sha}`} wrap />
          {/if}
        {/if}
        {#if live !== null && live.uncommitted !== null}
          <StatusTag kind="local" label={live.uncommitted} wrap />
          {#if live.uncommittedAsOf !== null}<span class="as-of">{live.uncommittedAsOf}</span>{/if}
        {/if}
      </div>
      {#each card.why as why, j (j)}
        <p class="why">{why}</p>
      {/each}
      {#if card.items.length > 0}
        <ul class="items">
          {#each card.items as item, j (j)}
            <li>{item}</li>
          {/each}
        </ul>
      {/if}
      {#if acts !== null && (acts.buttons.length > 0 || acts.copy !== null)}
        <div class="acts">
          {#each acts.buttons as b (b.target)}
            {#if b.target !== "editor"}<button type="button" class="ctl act" onclick={() => runs.github(actionKey(card.key, b.target), b.handle, openGithub)}>{b.label}</button>{/if}
          {/each}
          {#if acts.copy !== null}
            {@const copy = acts.copy}
            <button type="button" class="ctl act" onclick={() => runs.copy(actionKey(card.key, "copy"), copy.handles, copyPushCommand)}>{copy.label}{#if copy.suffix !== null}{" "}{copy.suffix}{/if}</button>
          {/if}
          {#each acts.buttons as b (b.target)}
            {#if b.target === "editor"}<button type="button" class="ctl act" aria-disabled={editing.busy} onclick={(e) => editors.click(card.key, b, e.altKey)}>{b.label}</button>{/if}
          {/each}
        </div>
      {/if}
      {#each lineOf(answer, card.key) as text, k (k)}<p class="reply">{text}</p>{/each}
      {#if editing.card === card.key}
        {#if editing.saveLine !== null}<p class="reply">{editing.saveLine}</p>{/if}
        {#if editing.line !== null}<p class="reply">{editing.line}</p>{/if}
        {#if editing.chooser !== null}<EditorChooser view={editing.chooser} onopen={(editor, remember) => editors.open(editor, remember, liveEditorButton(acts?.buttons ?? [], editing.project))} oncancel={() => editors.cancel()} />{/if}
      {/if}
    </Card>
  </div>
{/each}

{#if actions !== null && actions !== undefined && actions.editorError !== null}
  <p class="reply">{actions.editorError}</p>
{/if}

{#if leftOff.empty}
  <p class="empty">Nothing in progress.</p>
{/if}

<style>
  h2 {
    margin: 0 0 0.7rem;
    font-size: 1.3rem;
  }
  h2:focus {
    outline: none;
  }
  .slot {
    margin-bottom: 0.6rem;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    min-width: 0;
  }
  .as-of {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .why {
    margin: 0.4rem 0 0;
    color: var(--muted);
    font-style: italic;
    overflow-wrap: anywhere;
  }
  .items {
    margin: 0.4rem 0 0;
    padding-left: 1.1rem;
    overflow-wrap: anywhere;
  }
  .empty {
    margin: 0.5rem 0;
    color: var(--muted);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }
  .act {
    font: inherit;
    font-size: 0.88rem;
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  .reply {
    margin: 0.4rem 0 0;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
</style>
