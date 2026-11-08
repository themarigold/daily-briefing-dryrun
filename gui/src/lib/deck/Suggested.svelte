<script lang="ts">
  /**
   * Suggested for today (A spec): numbered cards, each with its project pill (none for a suggestion with
   * no label), the suggestion's own text (provenance such as "(from resume)" kept), and the verdict
   * marker line on the suggestion it belongs to. On an older page the title is "Suggested then".
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED.
   *
   * B1 (wave-2 plan B1-M6-T18; user decision U3), from the live git check (`git`, the model's words): one
   * "Push your work: …" card per repo with work only on this Mac, UNNUMBERED and drawn FIRST, before the page's
   * `<ol>` and outside it (so a screen reader never counts it as item 1), keyed `push:<repo>`, with the repo's
   * first card's pill (or the repo's name) and the why line "Not backed up anywhere yet". With a push card and no
   * page suggestion, "No suggestions in this briefing." is not drawn. None on an older page (the model's rule).
   *
   * B2-M6-T15, from `actions` (`actions.ts`): a push card's Copy push command, and at most one inline GitHub button on a
   * suggestion. Every line under a button is a fixed row from `actions.ts`.
   */
  import { getContext, untrack } from "svelte";
  import { actionRuns, onNewPage, type ActionLine, type ActionsView } from "../actions";
  import { ACTIONS_ANNOUNCE, ACTIONS_PAGE, type ActionsAnnounce, type ActionsPage } from "../actions-live";
  import type { Suggested } from "../deck";
  import { copyPushCommand, openGithub } from "../engine";
  import { noSuggestionsShown, type GitDetailView } from "../git-detail";
  import { focusHeading } from "../ui/a11y";
  import Card from "../ui/Card.svelte";
  import Pill from "../ui/Pill.svelte";

  interface Props {
    suggested: Suggested;
    active: boolean;
    /** B1: the live git check's view; null (or absent) before a page. */
    git?: GitDetailView | null | undefined;
    /** B2: the buttons from current held handles; null (or absent) before any. */
    actions?: ActionsView | null | undefined;
  }
  let { suggested, active, git, actions }: Props = $props();

  const pushCards = $derived(git?.pushCards ?? []);

  let answer = $state.raw<ActionLine | null>(null);
  const announce = getContext<ActionsAnnounce | undefined>(ACTIONS_ANNOUNCE) ?? (() => {});
  const runs = actionRuns((line) => (answer = line), announce);
  const pageKey = getContext<ActionsPage | undefined>(ACTIONS_PAGE) ?? (() => null);
  const newPage = onNewPage(() => { runs.reset(); });
  $effect.pre(() => { const key = pageKey(); untrack(() => newPage(key)); });
</script>

<h2 tabindex="-1" use:focusHeading={active}>{suggested.title}</h2>

{#each pushCards as p (p.key)}
  <div class="push">
    <Card>
      <div class="head">
        {#if p.pill !== null}<Pill palette={p.pill.slot} label={p.pill.label} wrap />{:else if p.name !== null}<span class="repo">{p.name}</span>{/if}
      </div>
      <p class="text">{p.text}</p>
      <p class="why">{p.why}</p>
      {#if p.asOf !== null}<p class="as-of">{p.asOf}</p>{/if}
      {#each actions?.push.filter((a) => a.key === p.key) ?? [] as { copy } (p.key)}
        <p class="act-line"><button type="button" class="ctl act" onclick={() => runs.copy(p.key, copy.handles, copyPushCommand)}>{copy.label}{#if copy.suffix !== null}{" "}{copy.suffix}{/if}</button></p>
      {/each}
      {#if answer?.key === p.key}{#each answer.lines as text, k (k)}<p class="reply">{text}</p>{/each}{/if}
    </Card>
  </div>
{/each}

{#if suggested.cards.length > 0}
  <ol class="list">
    {#each suggested.cards as s (s.n)}
      <li>
        <Card>
          <div class="head">
            <span class="n caps">{s.n}</span>
            {#if s.key !== null && s.label !== null}<Pill palette={s.slot} label={s.label} wrap />{/if}
          </div>
          <p class="text">{s.text}</p>
          {#if s.marker !== null}<p class="marker">{s.marker}</p>{/if}
          {#each actions?.suggestions.filter((a) => a.n === s.n && a.button !== null) ?? [] as a (a.n)}
            {@const button = a.button!}
            <p class="act-line"><button type="button" class="ctl act" onclick={() => runs.github(`suggestion:${s.n}`, button.handle, openGithub)}>{button.label}</button></p>
          {/each}
          {#if answer?.key === `suggestion:${s.n}`}{#each answer.lines as text, k (k)}<p class="reply">{text}</p>{/each}{/if}
        </Card>
      </li>
    {/each}
  </ol>
{:else if noSuggestionsShown(suggested, git ?? null)}
  <p class="empty">No suggestions in this briefing.</p>
{/if}

<style>
  h2 {
    margin: 0 0 0.7rem;
    font-size: 1.3rem;
  }
  h2:focus {
    outline: none;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li {
    margin-bottom: 0.6rem;
  }
  .head {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .text {
    margin: 0.3rem 0 0;
    overflow-wrap: anywhere;
  }
  .push {
    margin-bottom: 0.6rem;
  }
  .repo {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  /* The push card's why line (the mockup's `.why`) and its "as of", muted. */
  .why,
  .as-of {
    margin: 0.3rem 0 0;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .marker {
    margin: 0.3rem 0 0;
    font-size: 0.85rem;
  }
  .empty {
    margin: 0.5rem 0;
    color: var(--muted);
  }
  .act-line {
    margin: 0.5rem 0 0;
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
    margin: 0.3rem 0 0;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
</style>
