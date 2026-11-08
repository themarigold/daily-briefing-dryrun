<script lang="ts">
  /**
   * Step 0 — the live region (hub spec "Accessibility"): announces updates that are NOT focused,
   * such as a run's progress, politely. Never a slide change (focus announces that, `a11y.ts`
   * `focusHeading`). Markup only, visually hidden by app.css's `.sr-only`; the caller sets `text`
   * through `nextLiveText`.
   * Keep it mounted: a live region added together with its text is often not announced.
   * ⚠ Place it OUTSIDE any `inert` or `hidden` subtree (at the deck root or the app shell, not inside
   * a slide): inert and hidden content is not announced.
   */
  interface Props {
    text: string;
  }
  let { text }: Props = $props();
</script>

<p class="live sr-only" aria-live="polite">{text}</p>
