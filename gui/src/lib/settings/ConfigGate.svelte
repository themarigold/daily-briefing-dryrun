<script lang="ts">
  /**
   * Redesign D: one place that holds config fields on a Settings page. It draws them only while the config is
   * loaded; otherwise one line (unless the page says why itself, as General does). While the JSON editor is open
   * (`tab === "raw"`) the fields stay MOUNTED but hidden — removing them would drop a typed Add or Replace and its
   * pasted key — and the line `RAW_TAB_LINE` shows instead (on Advanced the editor shows instead, `editorHere`).
   *
   * ⚠ `hidden` sits on a bare `<div>` that no rule styles with `display`: an author `display` rule on the same
   * element would override the browser's `[hidden] { display: none }` (pinned in `settings-pages.check.ts`).
   */
  import type { Snippet } from "svelte";
  import { CONFIG_UNAVAILABLE_LINE, RAW_TAB_LINE, type ConfigState } from "./pages";

  interface Props {
    config: ConfigState;
    tab: "form" | "raw";
    /** Say "General says why" when the config cannot load (false on General, which says why itself). */
    pointer: boolean;
    /** The JSON editor is drawn on this page in place of the line (Advanced). */
    editorHere: boolean;
    /** R2-L2: draw the line while the editor is open (false where another place on the same page already says it). */
    rawLine?: boolean | undefined;
    children: Snippet;
  }
  let { config, tab, pointer, editorHere, rawLine = true, children }: Props = $props();
</script>

{#if config === "ready"}
  <div hidden={tab === "raw"}>
    {@render children()}
  </div>
  {#if tab === "raw" && !editorHere && rawLine}
    <p class="muted">{RAW_TAB_LINE}</p>
  {/if}
{:else if config === "loading"}
  {#if pointer}
    <p class="muted">Loading the config…</p>
  {/if}
{:else if pointer}
  <p class="muted">{CONFIG_UNAVAILABLE_LINE}</p>
{/if}

<style>
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
</style>
