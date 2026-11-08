<script lang="ts" module>
  /** The tag kinds, defined in `tag-kind.ts` (a `.ts` model can import them from there) and
   *  re-exported here so D's and A's component props can be typed by them. */
  import type { Kind } from "./tag-kind";
  export type { Kind };
</script>

<script lang="ts">
  /**
   * Step 0 — a status tag (hub spec "The look", "Status tags"): merged PR purple, branch blue, main
   * grey, and local work (not pushed) a dashed amber outline on a transparent fill. Presentation only.
   *
   * `kind` is closed and sets only the colour (`--tag-{kind}` for the word and outline,
   * `--tag-{kind}-bg` for the fill, `app.css`). The tag ALWAYS draws text — `label` when it has any
   * non-blank text (A's branch tag passes the branch name or "Detached HEAD at <sha7>"), otherwise the
   * kind's own word (`TAG_WORDS`, `tag-kind.ts`) — so colour is never the only signal.
   *
   * ⚠ A given `label` REPLACES the kind's word: a caller that passes `label` must keep the kind clear
   * in words, in the label itself ("PR #644") or next to the tag, since the colour alone does not say it.
   *
   * The text ellipsizes as `Pill`'s does: CSS only, the full text in `title`, and the ellipsis lifts
   * when the button or summary holding the tag has keyboard focus (hub: "long labels, branch names and
   * PR titles ellipsize, with the full text reachable"). The tag itself is never focusable.
   * ⚠ So a long label OUTSIDE a button or summary has no keyboard way to its full text (`title` is
   * hover only): a caller that may draw a long label outside a control passes `wrap`, which draws the
   * whole label, wrapped, with no ellipsis (A's resume-card branch tag).
   * `title` repeats the visible text, and some screen readers read both; that is accepted, for the
   * hover requirement.
   */
  import { TAG_WORDS } from "./tag-kind";

  interface Props {
    kind: Kind;
    /** The text to draw; a missing or blank label draws the kind's word. */
    label?: string | undefined;
    /** Draw the whole label, wrapped, with no ellipsis (for a long label outside a control). */
    wrap?: boolean | undefined;
  }
  let { kind, label, wrap }: Props = $props();

  const text = $derived(label !== undefined && label.trim() !== "" ? label : TAG_WORDS[kind]);
</script>

<span class="tag {kind}" class:wrap title={text}>{text}</span>

<style>
  .tag {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    padding: 0.05rem 0.4rem;
    border: 1px solid transparent;
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1.4;
  }
  /* `wrap`: the whole label, always (two classes outrank `.tag`). */
  .tag.wrap {
    max-width: none;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .merged {
    color: var(--tag-merged);
    background: var(--tag-merged-bg);
  }
  .branch {
    color: var(--tag-branch);
    background: var(--tag-branch-bg);
  }
  .main {
    color: var(--tag-main);
    background: var(--tag-main-bg);
  }
  .local {
    color: var(--tag-local);
    background: var(--tag-local-bg);
    border: 1px dashed var(--tag-local);
  }
  /* The button or summary holding the tag has keyboard focus: show the whole text. */
  :global(:is(button, summary):focus-visible) .tag {
    white-space: normal;
    overflow: visible;
    overflow-wrap: anywhere;
  }
</style>
