<script lang="ts">
  /**
   * Run now, its hint, the run's result line and the Details disclosure (the briefing redesign's A-M2):
   * moved out of `routes/TodayView.svelte` unchanged, so the classic view and the deck's Good morning
   * slide draw ONE copy. No wrapper element: the template is the moved elements as a fragment, so the
   * rendered markup is the same as before the move.
   *
   * `hint` (user-directed 2026-10-22, Good morning option 2): `"inline"`, the default and the classic
   * view's, draws the hint beside the button exactly as before (`today.check.ts`'s snapshots). `"info"`,
   * Good morning's alone, draws ONE centred row — the caller's `status` (the badge), Run now on its own
   * tile surface (not filled: Start is the slide's one filled button), and an "i" icon button — then its
   * note, which holds the hint word for word and sits IN THE FLOW under the row (it pushes what follows
   * down, so it covers neither the result line nor Details; checkpoint M1) — then the caller's
   * `banners`, then the result line and Details as before. The note closes on a second click, on Esc, on
   * a click or a focus anywhere outside the button and the note (so Tab away closes it), and when
   * `shown` turns false (the slide went off-screen). It never takes focus, so Esc leaves focus on the
   * button.
   *
   * ⚠ EVERY STRING IS `{}`-INTERPOLATED. The engine's stderr can carry repo-controlled text
   * (`docs/gui-seam.md` §5).
   *
   * ⚠ RUN NOW IS `run --json --now`, WITHOUT `--force`: it generates today's briefing whenever it is
   * clicked, but only if the engine has not already done so today (`--now` lifts the morning floor and
   * keeps the once-a-day guard, `src/main.ts`), and says that beside the button rather than in a help
   * page.
   */
  import type { Snippet } from "svelte";

  interface Props {
    running: boolean;
    /** The engine's stderr for the current run, verbatim, one line per entry. */
    progress: string[];
    runResult: string;
    /** Whether the Details disclosure starts open (`detailsOpen`, `lib/engine.ts`): open after a run that
     *  failed, was refused (configError) or threw; collapsed otherwise. REQUIRED, no default. */
    detailsOpen: boolean;
    onrun: () => void;
    /** Where the hint is drawn: beside the button (the default), or behind an "i" button (Good morning). */
    hint?: "inline" | "info" | undefined;
    /** `"info"` only: drawn first in the Run now row (Good morning's status badge). */
    status?: Snippet | undefined;
    /** `"info"` only: drawn between the row and the result line (Good morning's banners, today's order). */
    banners?: Snippet | undefined;
    /** `"info"` only: false while the controls are off-screen (Good morning not the current slide); the note closes. */
    shown?: boolean | undefined;
  }
  let { running, progress, runResult, detailsOpen, onrun, hint = "inline", status, banners, shown = true }: Props = $props();

  /**
   * Whether the Details disclosure is open: the prop's value whenever the PROP changes, and the user's
   * own toggle in between (M2 checkpoint).
   *
   * ⚠ NOT `<details open={detailsOpen}>`. Svelte 5 compiles that attribute into the SAME render effect
   * as the `<pre>`'s text, and `App.svelte` appends each stderr line as a new array — so every line
   * that streamed in re-applied `open = <prop>` and snapped a disclosure the user had opened shut.
   * A writable `$derived` re-derives only when `detailsOpen` changes (App holds the prop in an explicit
   * `$derived`, `detailsOpenNow`, so a run that ends `delivered` after a run-start `null` — false to
   * false — is no change);
   * `bind:open` writes the user's toggle back into it, through the `toggle` event, in an effect of its
   * own that the streaming text does not touch. It lives here, outside the `{#if}`, so a new run that
   * re-creates the element keeps it. Server rendering evaluates the derived, so the `open` attribute is
   * still emitted when the prop is true. `gui/tests-web/today.check.ts` pins the compiled shape.
   */
  let open = $derived(detailsOpen);

  /** The "i" note (`hint: "info"`): closed until the button is clicked. */
  const noteId = $props.id();
  let infoOpen = $state(false);
  let infoButton = $state<HTMLButtonElement | undefined>();
  let note = $state<HTMLElement | undefined>();
  function onwindowkey(e: KeyboardEvent): void {
    if (infoOpen && e.key === "Escape") infoOpen = false;
  }
  /** Whether an event's target is the i button or its note: a click or a focus there keeps the note open.
   *  ⚠ It reads both through `bind:this`: without the button's, the click that OPENS the note would reach
   *  the window as "outside" and close it again at once. */
  function inside(t: EventTarget | null): boolean {
    return t instanceof Node && (infoButton?.contains(t) === true || note?.contains(t) === true);
  }
  /** A click anywhere else closes the note (the button's own click toggles it). */
  function onwindowclick(e: MouseEvent): void {
    if (infoOpen && !inside(e.target)) infoOpen = false;
  }
  /** Focus moving anywhere else (Tab to Details, a slide's heading) closes it, so it never covers what has focus. */
  function onwindowfocus(e: FocusEvent): void {
    if (infoOpen && !inside(e.target)) infoOpen = false;
  }
  $effect(() => {
    if (!shown) infoOpen = false;
  });
</script>

<svelte:window onkeydown={onwindowkey} onclick={onwindowclick} onfocusin={onwindowfocus} />

<!-- The hint, ONE copy of its words for both places it can be drawn. -->
{#snippet hintText()}Generates today's briefing now, if it has not been generated yet.{/snippet}

{#if hint === "inline"}
  <div class="actions">
    <button onclick={onrun} disabled={running}>{running ? "Running…" : "Run now"}</button>
    <span class="hint">{@render hintText()}</span>
  </div>
{:else}
  <div class="actions row">
    {@render status?.()}
    <button type="button" class="ctl run" onclick={onrun} disabled={running}>{running ? "Running…" : "Run now"}</button>
    <button
      type="button"
      class="ctl info"
      aria-label="What Run now does"
      aria-expanded={infoOpen}
      aria-controls={noteId}
      onclick={() => (infoOpen = !infoOpen)}
      bind:this={infoButton}
    >
      <!-- An icon, not the letter "i" as text: the button's name is its whole label (WCAG 2.5.3). -->
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="4.2" r="1.15" /><path d="M8 7.2v5.3" /></svg>
    </button>
  </div>
  <p id={noteId} class="note" hidden={!infoOpen} bind:this={note}>{@render hintText()}</p>
  {@render banners?.()}
{/if}
<!-- The result line sits ABOVE the disclosure: a refused run's text says "See Details." -->
{#if runResult !== ""}
  <p class="result">{runResult}</p>
{/if}
{#if progress.length > 0}
  <!-- v0.2.1 §2.1: the engine's stderr, verbatim, behind a disclosure — developer diagnostics on a
       run that went fine, the explanation on one that did not (`detailsOpen`, via `open` above). -->
  <details class="details" bind:open>
    <summary>Details</summary>
    <pre class="progress">{progress.join("\n")}</pre>
  </details>
{/if}

<style>
  .actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.8rem;
    align-items: center;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    padding: 0.55rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .hint {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .details {
    margin-top: 0.8rem;
  }
  .details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .progress {
    margin: 0.4rem 0 0;
    padding: 0.8rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--panel);
    font-size: 0.82rem;
    white-space: pre-wrap;
    overflow-x: auto;
    text-align: left;
  }
  .result {
    margin: 0.6rem 0 0;
  }

  /* hint: "info" (Good morning, on the sunrise card). Each control has its own surface — a --tile fill
     and a --muted edge, 3:1 on every sunrise stop and blend (look.check.ts); --control is not. The note
     is in the flow under the row: opening it pushes what follows down and covers nothing (checkpoint M1). */
  .row {
    justify-content: center;
    gap: 0.6rem;
    margin-top: 0.4rem;
  }
  .run {
    padding: 0.2rem 0.85rem;
    font-size: 0.9rem;
    line-height: 1.35;
    border: 1px solid var(--muted);
    border-radius: 0.45rem;
    background: var(--tile);
    color: var(--fg);
  }
  .info {
    display: inline-grid;
    place-items: center;
    width: 1.6rem;
    height: 1.6rem;
    padding: 0;
    border: 1px solid var(--muted);
    border-radius: 50%;
    background: var(--tile);
    color: var(--fg);
  }
  .info svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }
  .info circle {
    fill: currentColor;
    stroke: none;
  }
  /* Open: its own look, an inset --fg ring on the --panel fill — never app.css's focus outline, which would
     make an open i look focused after focus has left it. */
  .info[aria-expanded="true"] {
    border-color: var(--fg);
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--fg);
  }
  .note {
    width: min(20rem, 100%);
    margin: 0.4rem auto 0;
    padding: 0.45rem 0.75rem;
    border: 1px solid var(--muted);
    border-radius: 8px;
    background: var(--tile);
    box-shadow: var(--tile-shadow);
    color: var(--fg);
    font-size: 0.85rem;
    line-height: 1.4;
    text-align: left;
  }
  /* After a run, the result line and Details sit tight under the row (checkpoint M2: the slide still fits
     900×640 with Start). `.row` exists only with hint="info", so TodayView keeps its spacing above. */
  .row ~ .result {
    margin-top: 0.3rem;
    line-height: 1.35;
  }
  .row ~ .details {
    margin-top: 0.15rem;
    line-height: 1.3;
  }
</style>
