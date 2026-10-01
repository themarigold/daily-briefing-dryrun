<script lang="ts">
  /**
   * One briefing, drawn from the block model (`briefing-md.ts` for a file, `briefing-struct.ts` for
   * an envelope's struct). Used by Today and History.
   *
   * ⚠ TEXT ONLY. Every string below is `{}`-interpolated, which Svelte turns into a text node; there
   * is no `{@html}` and no HTML setter (`gui/tests-web/static.check.ts` refuses both across
   * `gui/src`). A link span has NO `href`: it is shown as its label and its target, because an anchor
   * in this webview would navigate the app's own window away (docs/gui-seam.md §10).
   *
   * `data-block` marks each line for the golden-order test; `white-space: pre-wrap` keeps the
   * engine's double spaces, which are part of its text.
   *
   * A RECAP GROUP IS COLLAPSED (2026-09-24). A `bullet` block immediately followed by one or more
   * `nested` blocks — the shape `src/render.ts`'s group-aware recap walk emits, and the only
   * source of a `      ◦ ` line: the code-built story line, then each member three spaces
   * deeper — is drawn as one native `<details>`, CLOSED by default, with the header ON its
   * `<summary>` and the members as its body. Over nine archived busy mornings that is ~65 recap
   * lines with ~24 shown on open (means, measured 2026-09-24), and it is a VIEW change only: every
   * member stays in the DOM (the golden in `tests-web/briefing.check.ts` counts `summary` as a
   * drawn line and still requires every engine line, in order), and the markdown page is not
   * touched. `<details>` brings keyboard and screen-reader disclosure with no JS state. The header
   * sits on the summary itself because summary takes phrasing content — a `<p>` inside it would be
   * non-conforming. The engine pushes a why line BEFORE the story line, never between it and its
   * members, so a why stays outside the group. The walk has emitted the story line right before
   * its members since `◦` lines first existed (#363), so only a HAND-EDITED page can hold a
   * `nested` line with no bullet before it; it is drawn as the plain line it always was.
   *
   * Rows come from `lib/briefing-rows.ts` and are keyed by `rowKey` — index AND header — so a
   * new briefing on the same Today view never inherits an open group, and one whose lines did not
   * change keeps its open groups open (that file says why neither the index alone nor `{#key}`
   * will do).
   *
   * TIER B (spec §4.7 "The GUI mirrors", D12): A CAMPAIGN COLLAPSES ITS WHOLE SUBTREE. A campaign
   * is a `bullet` header whose members are `nested` lines, and a Stage-1 group the campaign absorbed
   * is a `nested` header followed by its members as `nested2` lines (the engine's nine-space `▪`
   * prefix). Inside a group's `<details>`, such a `nested` + `nested2` run is a SUB-GROUP: its own
   * native `<details>`, CLOSED by default, its header on the `<summary>` at the `◦` level and the
   * level-3 lines as its body — so, collapsed, only level-1 lines show; expanding the campaign shows
   * its level-2 lines with each Stage-1 group among them still collapsed until clicked. Sub-groups are
   * keyed by `subRowKey` — index AND header — for the same reason rows are. No `open` attribute is
   * ever written, at either level. A two-level page has no `nested2` line and draws as before.
   */
  import type { Block, Span } from "./briefing-md";
  import { groupRows, rowKey, subRowKey, type Member } from "./briefing-rows";

  interface Props {
    blocks: Block[];
  }
  let { blocks }: Props = $props();
  const rows = $derived(groupRows(blocks));
</script>

{#snippet spans(list: Span[])}{#each list as s, i (i)}{#if s.kind === "strong"}<strong>{s.text}</strong>{:else if s.kind === "code"}<code>{s.text}</code>{:else if s.kind === "sha"}<code class="sha">{s.text}</code>{:else if s.kind === "link"}<span class="link">{s.text}</span><span class="target">{` (${s.href ?? ""})`}</span>{:else}{s.text}{/if}{/each}{/snippet}

{#snippet line(block: Block)}{#if block.kind === "title"}<h3 class="b title" data-block>{@render spans(block.spans)}</h3>{:else if block.kind === "heading"}<h4 class="b heading" data-block>{@render spans(block.spans)}</h4>{:else}<p class="b {block.kind}" data-block>{@render spans(block.spans)}</p>{/if}{/snippet}

{#snippet member(m: Member)}{#if m.group}<details><summary class="b nested" data-block>{@render spans(m.header.spans)}</summary>{#each m.members as sub, k (k)}{@render line(sub)}{/each}</details>{:else}{@render line(m.block)}{/if}{/snippet}

<article class="briefing">
  {#each rows as row, i (rowKey(row, i))}
    {#if row.group}
      <details><summary class="b bullet" data-block>{@render spans(row.header.spans)}</summary>{#each row.members as m, j (subRowKey(m, j))}{@render member(m)}{/each}</details>
    {:else}
      {@render line(row.block)}
    {/if}
  {/each}
</article>

<style>
  .briefing {
    margin-top: 1rem;
    padding: 1rem 1.1rem;
    border: 1px solid var(--line);
    border-radius: 0.6rem;
    background: var(--panel);
    line-height: 1.5;
  }
  .b {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .title {
    font-size: 1rem;
    margin-bottom: 0.4rem;
  }
  .heading {
    font-size: 0.95rem;
    margin-top: 0.9rem;
  }
  .bullet,
  .why,
  .placeholder,
  .coverage,
  .legend {
    padding-left: 1.1rem;
  }
  .bullet::before {
    content: "•";
    display: inline-block;
    width: 1.1rem;
    margin-left: -1.1rem;
    color: var(--muted);
  }
  /* A collapsed group's header: at the `•` level, with the disclosure marker in the glyph's own box
     so it aligns with the bullets around it. The native marker is hidden because it sits INSIDE
     the summary — the UA sheet gives it `list-style: disclosure-closed inside`, and WebKit's
     `::-webkit-details-marker` is an inline box — so it would push the header text off the
     bullet column. The ▸/▾ carry empty alt text: `<details>` already tells a screen reader open
     or closed, and the glyph's name would be read on top of it. The bare `content` line before
     each is the fallback for an engine without the alt syntax, which drops the whole second
     declaration. */
  summary {
    list-style: none;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary.bullet::before {
    content: "▸";
    content: "▸" / "";
  }
  details[open] > summary.bullet::before {
    content: "▾";
    content: "▾" / "";
  }
  .nested,
  .notShown {
    padding-left: 2.2rem;
  }
  .nested::before {
    content: "◦";
    display: inline-block;
    width: 1.1rem;
    margin-left: -1.1rem;
    color: var(--muted);
  }
  /* A sub-group's header (tier B): the disclosure marker in the `◦` glyph's box, one level in. */
  summary.nested::before {
    content: "▸";
    content: "▸" / "";
  }
  details[open] > summary.nested::before {
    content: "▾";
    content: "▾" / "";
  }
  /* A level-3 line (tier B): the engine's `▪`, one level deeper than `◦`. */
  .nested2 {
    padding-left: 3.3rem;
  }
  .nested2::before {
    content: "▪";
    display: inline-block;
    width: 1.1rem;
    margin-left: -1.1rem;
    color: var(--muted);
  }
  .notShown::before {
    content: "·";
    display: inline-block;
    width: 1.1rem;
    margin-left: -1.1rem;
    color: var(--muted);
  }
  .why,
  .legend,
  .placeholder,
  .footer {
    color: var(--muted);
  }
  .outage,
  .coverage,
  .warnings {
    color: var(--danger);
  }
  .footer {
    margin-top: 0.9rem;
    font-size: 0.85rem;
  }
  code {
    font-size: 0.88em;
  }
  .sha {
    color: var(--muted);
  }
  .link {
    text-decoration: underline;
  }
  .target {
    color: var(--muted);
    font-size: 0.85em;
  }
</style>
