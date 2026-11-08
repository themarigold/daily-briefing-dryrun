<script lang="ts">
  /**
   * B1 (wave-2 plan B1-M6-T17): a What-you-did card's rows from the live git check, in scheme 1's shapes
   * (`tag-colors.html:32-36`): the status tag (a merged PR purple, a branch blue, the default branch grey, work no
   * remote holds the dashed amber outline), then the PR title or the branch name, the commit count, the amber push
   * words, and "only on this Mac" at the row's right. Every word is the model's (`git-detail.ts`'s `GitRow`); this
   * component draws them and computes none.
   *
   * Each row is a native `<details>` that starts closed and opens to its commits: the short SHA and the page's own
   * sentence for it (a NOT-shown or hidden commit's subject muted). Its open state is the row's own, so Open all /
   * Close all (the deck reducer's `open`) never reach it.
   *
   * The tag sits inside the `<summary>`, a control, so its whole text shows on keyboard focus (`StatusTag`'s
   * contract); it keeps its width at the row's start and never shrinks for the name. The name (a PR title or a
   * branch name) is drawn whole and wraps onto further lines, breaking anywhere when it has no spaces (polish §1);
   * the commit count and the amber push words follow it and are never cut.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED: branch names, PR titles and commit subjects are repo-controlled text.
   *
   * B2-M6-T15: `actions` gives a row its one GitHub button, beside the disclosure and never inside `<summary>`, and a
   * commit its own arrow. No row has Copy. A click names only the held handle; Rust judges it again.
   */
  import { getContext, untrack } from "svelte";
  import { actionRuns, onNewPage, type ActionLine, type RowActions } from "../actions";
  import { ACTIONS_ANNOUNCE, ACTIONS_PAGE, type ActionsAnnounce, type ActionsPage } from "../actions-live";
  import { openGithub } from "../engine";
  import type { GitRow } from "../git-detail";
  import StatusTag from "../ui/StatusTag.svelte";

  interface Props {
    rows: GitRow[];
    /** B2: this card's row actions; absent before a current answer. */
    actions?: RowActions[] | undefined;
  }
  let { rows, actions }: Props = $props();

  let answer = $state.raw<ActionLine | null>(null);
  const announce = getContext<ActionsAnnounce | undefined>(ACTIONS_ANNOUNCE) ?? (() => {});
  const runs = actionRuns((line) => (answer = line), announce);
  const pageKey = getContext<ActionsPage | undefined>(ACTIONS_PAGE) ?? (() => null);
  const newPage = onNewPage(() => { runs.reset(); });
  $effect.pre(() => { const key = pageKey(); untrack(() => newPage(key)); });
</script>

<ul class="rows">
  {#each rows as row, i (row.key)}
    {@const acts = actions?.find((a) => a.row === i) ?? null}
    <li class:acted={acts !== null && acts.button !== null}>
      <details class="row">
        <summary>
          <span class="chev" aria-hidden="true">›</span>
          <StatusTag kind={row.tag.kind} label={row.tag.label} />
          <span class="what"
            >{#if row.name !== null}<span class="name">{row.name}</span><span class="sep">{" · "}</span>{/if}<span class="count">{row.count}</span>{#if row.amber !== null}<span
                class="sep">{" · "}</span
              ><span class="amber">{row.amber}</span>{/if}</span
          >
          {#if row.here !== null}<span class="here">{row.here}</span>{/if}
        </summary>
        <ul class="commits">
          {#each row.commits as c, j (j)}
            {@const arrow = acts?.commits.find((x) => x.sha === c.sha) ?? null}
            <li class="commit"
              ><span class="sha">{c.short}</span> <span class="said"
                >{#each c.lines as line, k (k)}<span class="line" class:muted={line.muted}>{line.text}</span>{/each}</span
              >{#if arrow !== null}<button type="button" class="ctl arrow" aria-label={arrow.button.label} onclick={() => runs.github(`${row.key}:${c.sha}`, arrow.button.handle, openGithub)}><span aria-hidden="true">↗</span></button>{/if}</li
            >
            {#if answer?.key === `${row.key}:${c.sha}`}{#each answer.lines as text, k (k)}<li class="reply">{text}</li>{/each}{/if}
          {/each}
        </ul>
      </details>{#if acts !== null && acts.button !== null}
        {@const button = acts.button}
        <button type="button" class="ctl act" onclick={() => runs.github(`${row.key}:row`, button.handle, openGithub)}>{button.label}</button>
      {/if}{#if answer?.key === `${row.key}:row`}{#each answer.lines as text, k (k)}<p class="reply">{text}</p>{/each}{/if}</li>
  {/each}
</ul>

<style>
  .rows {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
  }
  .row {
    border-top: 1px dashed var(--line);
  }
  summary {
    display: flex;
    gap: 0.45rem;
    align-items: baseline;
    min-width: 0;
    padding: 0.35rem 0 0.35rem 0.3rem;
    list-style: none;
    font-size: 0.9rem;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* The disclosure's own mark (the native one is hidden so the row can be a flex line): turned when open. */
  .chev {
    flex: none;
    color: var(--muted);
  }
  .row[open] > summary .chev {
    transform: rotate(90deg);
  }
  /* The tag keeps its whole width (`StatusTag`'s `.tag` hides its overflow, so as a flex item it would shrink). */
  summary > :global(.tag) {
    flex: none;
  }
  /* Inline text, so the words read as one phrase (innerText, copy): the name wraps, breaking anywhere (a long
     branch name has no spaces); the count and the push words never break or shrink, and follow the name's last
     line, or move to the next when it leaves them no room. */
  .what {
    min-width: 0;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .count,
  .amber {
    white-space: nowrap;
  }
  /* The push words: the local-work colour, ≥ 4.5:1 as text on the card's --panel (look.check.ts). */
  .amber {
    color: var(--tag-local);
  }
  .here {
    flex: none;
    margin-left: auto;
    padding-left: 0.5rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .commits {
    list-style: none;
    margin: 0 0 0.35rem;
    padding: 0 0 0 1.4rem;
    font-size: 0.85rem;
  }
  .commit {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.15rem;
  }
  .sha {
    flex: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--muted);
  }
  .said {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--muted);
  }
  /* B2: a row with a button: the disclosure takes the line, the button sits at its right, an answer wraps below. */
  .acted {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    align-items: flex-start;
    border-top: 1px dashed var(--line);
  }
  .acted > .row {
    flex: 1 1 0;
    min-width: 0;
    border-top: 0;
  }
  .act {
    flex: none;
    margin: 0.25rem 0;
    padding: 0.15rem 0.5rem;
    font: inherit;
    font-size: 0.8rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  .arrow {
    flex: none;
    margin-left: auto;
    padding: 0 0.35rem;
    font: inherit;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  /* Under a row with a button the disclosure ends where that button starts, and buttons differ in width, so the arrow is
     placed from the row: it ends at the edge the buttons share, in the column their width leaves it, on its commit's first
     line. Out of the flow it no longer makes the line taller, so the padding keeps two arrows apart, and its -1px sets its
     text on that line. A row with no button is the disclosure's full width, so its in-flow arrow ends at that edge too. */
  .acted .commit {
    padding-block: 1px;
  }
  .acted .arrow {
    position: absolute;
    right: 0;
    margin-top: -1px;
  }
  .reply {
    flex-basis: 100%;
    margin: 0.15rem 0 0.35rem;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
</style>
