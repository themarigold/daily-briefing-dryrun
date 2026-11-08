<script lang="ts">
  /**
   * Step 0 — an action button (hub spec "Accessibility": every control is a real button). A native
   * `<button type="button">`, so it is keyboard-reachable and never submits anything. Presentation
   * only: the caller decides what a click does. Icons, if a caller adds one, are inline `<svg>`.
   *
   * ⚠ It is for ordinary text buttons (Save, Discard, Full briefing, Open all…), in one tile-like
   * look with no class hook. Navigation controls (D's sidebar entries, A's round arrows and slide
   * dots) are not ActionButtons: they are local `<button>`s in D's and A's own components (`lib/ui`
   * is frozen during wave 1, hub "Shared files register"). They add `class="ctl"`, app.css's opt-in
   * class with this file's focus ring and disabled look (the same declarations as
   * `.action:focus-visible` and `.action:disabled`, compared in look.check.ts), so every control
   * looks focused and disabled the same way. `.ctl` outranks a plain local one-class rule
   * (`.chev { … }`), but TIES with a local class plus a pseudo-class or attribute selector
   * (`.chev:hover`, `.chev[aria-current]`), which then wins by order: so a local rule writes
   * `:hover:not(:disabled)` (and the like) for any property the disabled look sets, and a `.ctl`
   * button does not restyle `:focus-visible` locally.
   *
   * The default kind's border (`--line`) is about 1.3:1, below the 3:1 of a non-text signal. That is
   * allowed: a text button's boundary is not required to be visible (WCAG 1.4.11); its text says
   * it is a button, and its focus ring meets 3:1.
   *
   * Explicit props only (a spread onto the element is refused by `tests-web/static.check.ts`):
   * - `label`: the accessible name, for a button whose content is only an icon;
   * - `title`: a hover tooltip, general-purpose; never the only name, since hover is not
   *   keyboard-reachable;
   * - `kind`: `default` (the tile look), `primary` (`--accent` fill, `--on-accent` text) or `danger`
   *   (`--danger` text and border);
   * - `expanded`: `aria-expanded`, for a button that opens and closes a detail;
   * - `current`: `aria-current="page"` when true, absent otherwise, general-purpose (no wave-1
   *   ActionButton uses it). It sets ONLY the attribute, for a screen reader; ActionButton draws no
   *   "current" look.
   */
  import type { Snippet } from "svelte";

  interface Props {
    onclick: () => void;
    disabled?: boolean | undefined;
    label?: string | undefined;
    title?: string | undefined;
    kind?: "default" | "primary" | "danger" | undefined;
    expanded?: boolean | undefined;
    current?: boolean | undefined;
    children: Snippet;
  }
  let { onclick, disabled, label, title, kind, expanded, current, children }: Props = $props();
</script>

<button
  type="button"
  class="action"
  class:primary={kind === "primary"}
  class:danger={kind === "danger"}
  {disabled}
  {title}
  aria-label={label}
  aria-expanded={expanded}
  aria-current={current ? "page" : undefined}
  {onclick}>{@render children()}</button
>

<style>
  .action {
    font: inherit;
    font-size: 0.88rem;
    padding: 0.35rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  .primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  .danger {
    color: var(--danger);
    border-color: var(--danger);
  }
  .action:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* One disabled look for every kind: --muted on --tile (≥ 4.5:1, look.check.ts). `.action:disabled`
     outranks `.primary` / `.danger`, so a kind's fill never survives under muted text. */
  .action:disabled {
    background: var(--tile);
    color: var(--muted);
    border-color: var(--line);
    cursor: default;
  }
</style>
