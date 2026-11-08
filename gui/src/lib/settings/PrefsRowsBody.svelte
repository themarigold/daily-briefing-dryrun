<script lang="ts">
  /**
   * A-M7-T15 — A's two rows on Settings → General (redesign A spec, "The slides switch" and "First name"), drawn in
   * D's reserved `prefsRows` slot after Updates: "Your first name" (used only in Today's greeting) and "Show the
   * briefing as slides" (on by default; off brings back the classic Today view).
   *
   * ⚠ APP PREFERENCES, APPLIED AT ONCE. Both write through `app-prefs-store.ts` (Rust's `app_prefs_set`), never the
   * config draft: they mark no page and never show the save bar (they are not inputs of D's `changedPages`). Each
   * row has its own saved / failed line, an always-drawn polite live region (round-1 M8), so a refusal is announced
   * as "Saved." is. Today follows the store (round-1 M1), so a change shows there even if it lands after Today mounted.
   *
   * The name is saved on blur or Enter, once per value typed (Enter then blur sends one set). Rust trims it, refuses
   * one that is too long or holds control or bidi characters, and an empty one unsets it: the input then shows what
   * the store kept, and a refusal keeps what was typed with Rust's sentence under it. Text typed while a save is in
   * flight is kept and sent once it ends; after a store failure (not a refusal) Enter or blur retries. Every string
   * is a text node.
   *
   * The slides control is a Turn on / Turn off button, as General's other app controls are (the 2026-10-21 decision
   * kept buttons, not switches, on General; `Switch.svelte` is the Calendar page's override). ONE button whose label
   * and action follow the value (round-3 L6), so focus stays on it after a set instead of falling to the page.
   *
   * `initial` is the rows' state at mount: the checks draw each state a set leaves (a server render runs no
   * handler). The app passes nothing, and the rows start from the store.
   *
   * Round-3 M1: drawn only once the store has settled (`PrefsRows.svelte`, the gate: no load and no set in flight), so
   * "read once, at mount" reads the stored values, never the defaults of a load or the old value of a set still in
   * flight. The rows do NOT follow the store after that (post-cap M1: following it overwrote a refused name when the
   * other row's set landed): these rows are the store's only writer, and each row takes its own set's answer
   * (`nameAfterSet` / `slidesAfterSet`, read after the store's revision ordering).
   */
  import {
    appPrefs,
    appPrefsLoadFailure,
    setFirstName,
    setSlides,
  } from "../app-prefs-store";
  import { onDestroy, untrack } from "svelte";
  import Tile from "../ui/Tile.svelte";
  import { flushesOnUnmount, nameAfterSet, sendsName, sendsSlides, slidesAfterSet, type RowLine as Line } from "./prefs-rows";

  interface Props {
    initial?: { name?: string; nameLine?: Line; slidesLine?: Line } | undefined;
  }
  let { initial }: Props = $props();
  /** Read once, at mount (the rows then hold their own state). */
  const seed = untrack(() => initial);

  const start = appPrefs();
  const loadFailure = appPrefsLoadFailure();
  let name = $state(seed?.name ?? start.firstName ?? "");
  let slides = $state(start.slides);
  let nameLine = $state<Line>(seed?.nameLine ?? null);
  let slidesLine = $state<Line>(seed?.slidesLine ?? null);
  let busyName = $state(false);
  let busySlides = $state(false);
  /** The last value sent (or, at mount, the stored one): blur after Enter, or a blur with no edit, sends nothing. */
  let lastSent = start.firstName ?? "";
  /** The rows have unmounted: a follow-up save queued by an answer must not run after that (scoped-review M1). */
  let destroyed = false;

  // Scoped-review M1: unmounting FLUSHES the name (`flushesOnUnmount`): sent now, so it is in flight before the rows are
  // gone, and a reopened Settings' gate waits for it instead of a follow-up landing after the new rows were drawn.
  onDestroy(() => {
    destroyed = true;
    if (flushesOnUnmount({ name, lastSent, line: nameLine })) void setFirstName(name);
  });

  // What each answer does is decided in `prefs-rows.ts` (pure, tested there); this keeps the flags and the calls.
  async function saveName(): Promise<void> {
    const sent = name;
    if (!sendsName({ value: sent, lastSent, busy: busyName })) return;
    busyName = true;
    lastSent = sent;
    nameLine = null;
    let again = false;
    try {
      const outcome = await setFirstName(sent);
      const after = nameAfterSet({ sent, input: name, outcome, stored: appPrefs().firstName ?? "" });
      name = after.name;
      lastSent = after.lastSent;
      nameLine = after.line;
      again = after.again;
    } finally {
      busyName = false;
    }
    if (again && !destroyed) void saveName();
  }

  async function setSlidesTo(on: boolean): Promise<void> {
    if (!sendsSlides(busySlides)) return;
    busySlides = true;
    slidesLine = null;
    try {
      const outcome = await setSlides(on);
      const after = slidesAfterSet({ requested: on, outcome, stored: appPrefs().slides });
      slides = after.slides;
      slidesLine = after.line;
    } finally {
      busySlides = false;
    }
  }
</script>

<!-- A-M7-T15: one group in Step 0's `Tile`, its rows drawn as "This app"'s are: the words on the left, the control
     on the right (one column below 720 px). -->
<div class="group">
<Tile>
<div class="prefs">
  <h4>Today</h4>

  {#if loadFailure !== ""}
    <p class="bad top">Your app preferences could not be read, so the defaults are in use: {loadFailure}</p>
  {/if}

  <div class="block">
    <h5><label for="pref-first-name">Your first name</label></h5>
    <p>Optional, used only in Today's greeting. Leave it empty for a plain "Good morning".</p>
    <div class="row">
      <input
        id="pref-first-name"
        type="text"
        autocomplete="given-name"
        spellcheck="false"
        aria-describedby={nameLine !== null ? "pref-first-name-line" : undefined}
        aria-invalid={nameLine !== null && !nameLine.ok ? "true" : undefined}
        bind:value={name}
        onblur={() => void saveName()}
        onkeydown={(e) => { if (e.key === "Enter") void saveName(); }}
      />
    </div>
    <!-- Round-1 M8: ONE polite live region per row, always drawn (SaveBar's outcome area, SaveBar.svelte), so a refusal
         is announced as "Saved." is: its text is "", "Saved." or the sentence. -->
    <p class="line" class:bad={nameLine !== null && !nameLine.ok} id="pref-first-name-line" aria-live="polite">{nameLine?.text ?? ""}</p>
  </div>

  <div class="block">
    <h5>Show the briefing as slides</h5>
    <p>{slides ? "Today shows the briefing as slides, one slide at a time (the default)." : "Today shows the whole briefing on one page, the classic view."}</p>
    <div class="row">
      <!-- Round-4 M2: never `disabled` while a set is in flight (WebKit then drops focus to the page, measured in a
           WKWebView); a second click is dropped by `sendsSlides`, and `aria-busy` says it is working. -->
      <button aria-busy={busySlides ? "true" : undefined} onclick={() => void setSlidesTo(!slides)}>{slides ? "Turn off" : "Turn on"}</button>
    </div>
    <p class="line" class:bad={slidesLine !== null && !slidesLine.ok} aria-live="polite">{slidesLine?.text ?? ""}</p>
  </div>
</div>
</Tile>
</div>

<style>
  /* The look of `AppGeneralControls`' "This app" group (D's Part B, the S-A mockup): the group's name in small
   * capitals, rows of words on the left and the control on the right, 11px 14px, a line between rows. Step 0's Tile
   * pads its content 0.65rem 0.8rem (lib/ui is frozen in wave 1), so the rows reach out to its edges. */
  .group {
    margin: 0 0 14px;
  }
  h4 {
    margin: calc(12px - 0.65rem) 0 0;
    padding: 0 calc(14px - 0.8rem);
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  h5 {
    margin: 0 0 2px;
    font-size: 13px;
    font-weight: 600;
  }
  h5 label {
    font: inherit;
  }
  .block {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-auto-flow: row dense;
    column-gap: 12px;
    align-items: center;
    margin: 0 -0.8rem;
    padding: 11px 14px;
  }
  .block > * {
    grid-column: 1;
  }
  .block > .row {
    grid-column: 2;
    grid-row: 1 / span 2;
    justify-content: flex-end;
  }
  /* A row's saved / failed line spans the row, under its words and its control. Always drawn (it is the row's live
     region); with nothing to say it is empty and takes no room. */
  .block > .line {
    grid-column: 1 / -1;
    margin: 6px 0 0;
  }
  .block > .line:empty {
    margin: 0;
  }
  .block + .block {
    border-top: 1px solid var(--tile-border);
  }
  .block:last-of-type {
    margin-bottom: -0.65rem;
  }
  .block > p:last-of-type {
    margin-bottom: 0;
  }
  @media (max-width: 720px) {
    .block {
      grid-template-columns: minmax(0, 1fr);
    }
    .block > .row {
      grid-column: 1;
      grid-row: auto;
      justify-content: flex-start;
      margin-top: 6px;
    }
  }
  p {
    margin: 0 0 4px;
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .line {
    color: var(--muted);
  }
  .bad {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .prefs > .bad.top {
    margin: 6px calc(14px - 0.8rem) 0;
  }
  /* SettingsForm's text input (Part B): 13px, 5px 9px, the tile's hairline, the surface colour. */
  input[type="text"] {
    font: inherit;
    font-size: 13px;
    width: 12rem;
    max-width: 100%;
    margin: 0;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
  /* The mockup's .btn, as "This app" draws it. */
  button {
    font: inherit;
    font-size: 12.5px;
    padding: 5px 11px;
    border-radius: 6px;
    border: 1px solid var(--tile-border);
    background: var(--tile);
    color: var(--fg);
    cursor: pointer;
  }
  /* Busy (a set in flight): the same muted look the disabled button had, but it keeps focus (round-4 M2). */
  button[aria-busy="true"] {
    color: var(--muted);
    cursor: progress;
  }
</style>
