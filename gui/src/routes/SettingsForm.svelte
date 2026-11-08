<script lang="ts">
  /**
   * T15's form, drawn from `lib/settings-model.ts` over the PARSED config (`draft`). Presentation
   * only: every change goes back to `Settings.svelte` through a callback, which applies it to the
   * draft in place.
   *
   * ⚠ NO `transcripts` FIELD, NOT EVEN A DISABLED ONE (plan R1). ⚠ NO LITERAL KEY IS EVER SHOWN: the
   * config arrives with a stored `provider.api.apiKey` replaced by a placeholder in Rust, and this
   * form does not render that value at all — it says a key is stored, and offers to remove it.
   *
   * Inputs commit on `change` (blur or Enter), not on every keystroke, so a half-typed number is not
   * normalised under the cursor.
   *
   * v0.2.1 §4.1: each field shows its plain `help`, never the engine-source `quote` the model keeps
   * for its verbatim test.
   *
   * Redesign D: `sections` names the sections to draw (by title, in the model's order); without it every section
   * is drawn. Each Settings page draws its own, so Advanced is a plain section, drawn open on its own page; a field
   * Save refuses on is named by the save bar, which opens its page.
   *
   * P3-M4-T1: "Providers, in order" (`lib/ProvidersList.svelte`) is drawn just before the first provider section, in
   * place of the old "Failover accounts" text field. Redesign D: the list, the stored-key notice and the note on
   * making another provider the first (user-directed 2026-10-22, P4) are drawn only when a provider section is drawn. `Settings.svelte` passes the view
   * (with the engine's row statuses) and the handlers; a mount without them — a test, or a caller with no status —
   * still draws the list from the draft, with every status unknown and no controls.
   *
   * P3-M4 checkpoint: the old "A literal API key is stored" notice (remove with no confirmation, no source check and no
   * scrub) is drawn only while the providers list cannot be read — a duplicate label, an unreadable `provider.accounts`
   * or `fallbacks`, an invalid `provider.label` — when no row exists to carry the banner. The scrub on the next open
   * still cleans the backup after it.
   */
  import {
    hasPath,
    hasStoredApiKey,
    providerShape,
    readField,
    readNotifyCommand,
    readTime,
    providersView,
    rawFromDraft,
    sectionKey,
    sectionsFor,
    TOOL_ARGS_FIELD,
    TOOL_COMMAND_FIELD,
    TOOL_OTHER_LABEL,
    TOOL_PRESETS,
    type Draft,
    type Field,
    type ProvidersView,
  } from "../lib/settings-model";
  import { BACKUP_SETTINGS_NOTE } from "../lib/settings-model";
  import MorningTimeSelect from "../lib/MorningTimeSelect.svelte";
  import ProvidersList from "../lib/ProvidersList.svelte";
  import type { AddHandlers, ReplaceHandlers } from "../lib/provider-flows";
  import Tile from "../lib/ui/Tile.svelte";
  import { PAGES, toolShown } from "../lib/settings/pages";
  import { tick } from "svelte";

  interface Props {
    draft: Draft;
    errors: Record<string, string>;
    onfield: (field: Field, value: string) => void;
    onnotifycommand: (value: string) => void;
    /** `true`: remove the key (engine default); `false`: write an explicit empty list. */
    ondefault: (field: Field, useDefault: boolean) => void;
    onremovekey: () => void;
    /** Redesign D: the titles of the sections to draw, drawn in the model's order; absent, every section. */
    sections?: string[] | undefined;
    /** P3-M4-T1: the providers list, and its handlers (`ProvidersList.svelte`'s props). */
    providers?: ProvidersView | undefined;
    providersMessage?: string | undefined;
    onprovidermove?: ((from: number, to: number) => void) | undefined;
    onproviderremove?: ((label: string) => void) | undefined;
    onproviderfolder?: ((label: string, dir: string) => void) | undefined;
    onprovidertest?: ((label: string, draftIndex: number) => void) | undefined;
    /** User-directed 2026-10-22 (P-A): Test all. */
    onprovidertestall?: (() => void) | undefined;
    onproviderreset?: ((label: string, savedIndex: number) => void | Promise<unknown>) | undefined;
    /** P3-M4-T4: move a saved entry's written key to the Keychain, or remove it (confirmed on the row). */
    onprovidermigrate?: ((label: string, savedIndex: number) => void) | undefined;
    onproviderremoveliteral?: ((label: string, savedIndex: number) => void) | undefined;
    /** P3-M4-T2: Add, and the add in progress (`lib/provider-flows.ts`), handed to the list as they come. */
    provideradd?: AddHandlers | undefined;
    /** P3-M4-T3: Replace key, and the replacement in progress, handed to the list as they come. */
    providerreplace?: ReplaceHandlers | undefined;
    /** Redesign D: a pending Add's network-check question and its answer, passed to the list (bound both ways). */
    networkAsk?: boolean | undefined;
    networkYes?: boolean | undefined;
    /** Redesign D final round 1 (H1), final round 3 (R3-M2): per field id, how often the shell had the field drawn
     *  again (`settings/pages.ts` `Redraw`). Each field is keyed on its OWN count, so an input that still shows a
     *  refused value — never written into the draft — shows the draft's after a reset, and every other field, the
     *  one being typed in included, keeps its input. */
    redraw?: Record<string, number> | undefined;
    /** Redesign D Part B: draw the sections' fields only — no box, no fieldset, no legend, no providers list — for a
     *  page group that draws its own box around them (General's one Updates group, with the update-check box). */
    bare?: boolean | undefined;
    /** Round 10 (M1): "Other…" is chosen on row 1's Tool (the shell's `ToolRows.other`). Round 11 (M1): the note under
     *  the tool control whose value was just refused (`ToolRows.note`), which blocks nothing. */
    toolOther?: boolean | undefined;
    toolNote?: { id: string; text: string } | null | undefined;
  }
  let {
    draft,
    errors,
    onfield,
    onnotifycommand,
    ondefault,
    onremovekey,
    sections,
    providers,
    providersMessage = "",
    onprovidermove,
    onproviderremove,
    onproviderfolder,
    onprovidertest,
    onprovidertestall,
    onproviderreset,
    onprovidermigrate,
    onproviderremoveliteral,
    provideradd,
    providerreplace,
    networkAsk = false,
    networkYes = $bindable(),
    redraw = {},
    bare = false,
    toolOther = false,
    toolNote = null,
  }: Props = $props();

  const value = (e: Event) => (e.currentTarget as HTMLInputElement).value;

  const drawn = $derived(sectionsFor(draft).filter((s) => sections === undefined || sections.includes(s.title)));
  /** The providers list goes just before the first provider section drawn; -1 when none is, and then no list. */
  const providersAt = $derived(drawn.findIndex((s) => s.title.startsWith("Provider (")));
  const providersShown = $derived(
    providers ?? providersView({ draft, savedText: rawFromDraft(draft), rows: null, now: new Date() }),
  );
  /** Final round 3 (V11): a group named as its page ("Advanced" under the page title "Advanced") keeps the name for
   *  the fieldset and for heading navigation, but does not show it a second time. Final round 4 (V20): nor does a
   *  one-field group named as its field ("Notifications from the engine" over its one row of that label). */
  const nameShownElsewhere = (s: { title: string; page: string; fields: Field[] }): boolean =>
    PAGES.find((p) => p.id === s.page)?.label === s.title || (s.fields.length === 1 && s.fields[0]!.label === s.title);

  /** User-directed 2026-10-22 (P2): "Other…" chosen on the Command choice while the file still names a tool. Other
   *  writes nothing by itself, so without the shell's choice (`toolOther`) the select would show the tool again; a typed
   *  command or argument keeps Other open even when the result reads as a named tool. Round 10 (M1): the choice is the
   *  SHELL's, and belongs to row 1 as the list names it (`settings/pages.ts` `toolRowsAfter`).
   *  Round 11 (M1): every tool control SHOWS THE DRAFT (`toolShown`) — the shell decides an edit (`fieldEdited`), and a
   *  value it refused is never written and never an error: the control is given the draft's value back once the edit is
   *  handled (`showDraft`), and the refusal is a note under it (`toolNote`). */
  const shown = (field: Field): string => toolShown(draft, field, toolOther);
  /** The fields drawn: Other's command and arguments follow the Command choice while Other is shown. */
  const withToolRows = (fields: Field[]): Field[] =>
    fields.flatMap((f) => (f.kind === "tool" && shown(f) === "other" ? [f, TOOL_COMMAND_FIELD, TOOL_ARGS_FIELD] : [f]));
  const isToolRow = (field: Field): boolean => field === TOOL_COMMAND_FIELD || field === TOOL_ARGS_FIELD;
  /** Round 11 (M1): a tool control, once its edit is handled (after the flush), shows what the draft holds. A refused
   *  value was never written, and Svelte does not rewrite a control whose value prop did not change, so without this
   *  the select would keep the tool it refused and Other's inputs the text they refused. Its own element, so the focus
   *  stays where the user left it. */
  function showDraft(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, field: Field): void {
    void tick().then(() => {
      if (el.isConnected) el.value = shown(field);
    });
  }
  function changed(field: Field, e: Event): void {
    onfield(field, value(e));
    if (isToolRow(field)) showDraft(e.currentTarget as HTMLInputElement | HTMLTextAreaElement, field);
  }

  /** User-directed 2026-10-22 (P-A): the provider sections are no boxes of their own any more — their fields are row
   *  1's own settings, drawn in its opened row (`firstFields`). Every field they drew is still drawn, once, there. */
  const isProviderSection = (s: { title: string }): boolean => s.title.startsWith("Provider (");
  const firstSectionFields = $derived(drawn.filter(isProviderSection).flatMap((s) => withToolRows(s.fields)));
  /** Row 1 opens while one of its fields carries an error, so a refused Save can bring it into view. */
  const firstNeedsOpen = $derived(firstSectionFields.some((f) => errors[f.id] !== undefined && errors[f.id] !== ""));
</script>

<!-- P-A: row 1's own settings (Tool and Account, Other's command and arguments; the API fields for an API row 1). -->
{#snippet firstFields()}
  <div class="rowfields">
    {@render fieldList(firstSectionFields)}
  </div>
{/snippet}

{#snippet fieldList(fields: Field[])}
  <!-- H1, R3-M2: each field keyed on its own count, so the shell draws again only the fields it marked. -->
  {#each fields as field (field.id)}
    {#key redraw[field.id] ?? 0}
        {@const current = readField(draft, field)}
        {@const usesDefault = field.defaultable === true && !hasPath(draft, field.path)}
        <div class="field" class:wide={field.kind === "text" || field.kind === "lines" || field.kind === "subprojects" || field.kind === "hosts" || (field.kind === "notify" && current === "command")}>
          <label for="f-{field.id}">{field.label}</label>
          {#if field.kind === "text" || field.kind === "number"}
            <input
              id="f-{field.id}"
              type="text"
              class:num={field.kind === "number"}
              value={current}
              placeholder={field.placeholder ?? ""}
              spellcheck="false"
              onchange={(e) => changed(field, e)}
            />
          {:else if field.kind === "tool"}
            <select
              id="f-{field.id}"
              value={shown(field)}
              onchange={(e) => {
                onfield(field, value(e));
                showDraft(e.currentTarget as HTMLSelectElement, field);
              }}
            >
              {#each TOOL_PRESETS as t (t.id)}
                <option value={t.id}>{t.label}</option>
              {/each}
              <option value="other">{TOOL_OTHER_LABEL}</option>
            </select>
          {:else if field.kind === "bool"}
            <select id="f-{field.id}" value={current} onchange={(e) => onfield(field, value(e))}>
              <option value="">Engine default</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          {:else if field.kind === "choice"}
            <!-- P3: a choice the engine reads absent as one of its values draws absent as that value, with no
                 "Engine default" beside it; absent is written only on a change (`absentAs`). -->
            <select id="f-{field.id}" value={current === "" && field.absentAs !== undefined ? field.absentAs : current} onchange={(e) => onfield(field, value(e))}>
              {#if !field.required && field.absentAs === undefined}<option value="">Engine default</option>{/if}
              {#each field.options ?? [] as option (option)}
                <option value={option}>{field.optionLabels?.[option] ?? option}</option>
              {/each}
              {#if current !== "" && !(field.options ?? []).includes(current)}
                <option value={current}>{current} (not a valid value)</option>
              {/if}
            </select>
          {:else if field.kind === "time"}
            <!-- v0.2.1 §3.2: the stored value is SHOWN the engine's way; the draft keeps it raw
                 until a dropdown changes or the button below is pressed (`readTime`). -->
            {@const time = readTime(draft, field)}
            <MorningTimeSelect id="f-{field.id}" value={time.hhmm} onchange={(hhmm) => onfield(field, hhmm)} />
            {#if time.note !== null}
              <p class="note">
                {time.note}
                <button type="button" onclick={() => onfield(field, time.hhmm)}>Use HH:MM</button>
              </p>
            {/if}
          {:else if field.kind === "notify"}
            <select id="f-{field.id}" value={current} onchange={(e) => onfield(field, value(e))}>
              <option value="">Engine default (off)</option>
              <option value="off">Off</option>
              <option value="auto">Auto</option>
              <option value="command">A command</option>
            </select>
            {#if current === "command"}
              <textarea
                aria-label="Notification command, one argument per line"
                rows="3"
                spellcheck="false"
                value={readNotifyCommand(draft)}
                onchange={(e) => onnotifycommand(value(e))}
              ></textarea>
            {/if}
          {:else}
            {#if field.defaultable}
              <label class="inline">
                <input
                  type="checkbox"
                  checked={usesDefault}
                  onchange={(e) => ondefault(field, (e.currentTarget as HTMLInputElement).checked)}
                />
                Use the engine's default
              </label>
            {/if}
            <!-- R3-M1: drawn again from the draft when the toggle flips (a refused text in it would stay unmarked). -->
            {#key usesDefault}
              <textarea
                id="f-{field.id}"
                rows="3"
                spellcheck="false"
                disabled={usesDefault}
                value={current}
                placeholder={field.placeholder ?? ""}
                onchange={(e) => changed(field, e)}
              ></textarea>
            {/key}
          {/if}
          {#if errors[field.id]}
            <p class="field-error">{errors[field.id]}</p>
          {/if}
          {#if toolNote !== null && toolNote.id === field.id}
            <!-- Round 11 (M1): a tool control's refusal — the control shows the draft again; nothing waits on this. -->
            <p class="note refused" role="status">{toolNote.text}</p>
          {/if}
          <p class="help">{field.help}</p>
          {#if field.note}
            <p class="note">{field.note}</p>
          {/if}
        </div>
    {/key}
  {/each}
{/snippet}

{#if bare}
  {#each drawn as section (section.title)}
    {@render fieldList(section.fields)}
  {/each}
{:else}
<div class="form">
  {#if providersAt !== -1}
    <!-- P3-M4 checkpoint: only while the providers list cannot be read. Otherwise item 1's row banner owns its key
         (migrate, or remove behind a confirmation, with the source check and the scrub); this notice has none of them. -->
    {#if !providersShown.readable && providerShape(draft) === "api" && hasStoredApiKey(draft)}
      <div class="notice">
        <p>
          A literal API key is stored in the config file. Daily Briefing never shows it and cannot set
          or change it; it stays as it is unless you remove it here.
        </p>
        <button type="button" onclick={onremovekey}>Remove the stored key</button>
      </div>
    {/if}
  {/if}

  {#each drawn as section, i (sectionKey(section.title))}
    {#if i === providersAt}
      <!-- P-A: "Today's briefing" above the list, only from today's page's own lines (`todaysBriefing`); the skipped
           provider struck through and the one used in green — and the words say both, so colour is never the only signal.
           Round 10 (M2): a page that names no winner says "another provider wrote it" — the entry not tried may come
           after the one that won (the engine passes over a marked entry wherever it stands). -->
      {#if providersShown.readable && providersShown.today !== null}
        {@const today = providersShown.today}
        <p class="today">
          Today's briefing:
          {#each today.skipped as s, n (n)}{#if n > 0};{/if}
            <span class="chip skip">{s.name}</span> {s.why}{/each}{#if today.used !== null},
            so <span class="chip used">{today.used}</span> wrote it{:else}, so another provider wrote it{/if}{#if today.at !== null}{" "}at {today.at}{/if}.
        </p>
      {/if}
      <Tile>
        <ProvidersList
          view={providersShown}
          message={providersMessage}
          onmove={onprovidermove}
          onremove={onproviderremove}
          onfolder={onproviderfolder}
          ontest={onprovidertest}
          ontestall={onprovidertestall}
          onreset={onproviderreset}
          onmigrate={onprovidermigrate}
          onremoveliteral={onproviderremoveliteral}
          firstFields={firstSectionFields.length > 0 && providersShown.readable ? firstFields : undefined}
          {firstNeedsOpen}
          {...provideradd}
          {...providerreplace}
          {networkAsk}
          bind:networkYes
        />
      </Tile>
    {/if}
    <!-- Redesign D: each section is a Settings group, drawn in Step 0's `Tile`; the fieldset and its legend stay
         inside it (the legend is the group's heading, and tests find the sections by it). Final round 1 (H1), round 3 (R3-M2):
         each field is keyed on its own count (in `fieldList`); the providers list above (a typed Add, a pasted key) is never
         redrawn — post-cap (R5-M4): not by a kind switch either, the section's item being kept by `sectionKey`.
         User-directed 2026-10-22 (P-A): a provider section draws no box of its own; its fields are row 1's (above) —
         except while the list cannot be read, when there is no row 1 to hold them: then its box stays, as before. -->
    {#if !isProviderSection(section) || !providersShown.readable}
      <Tile>
        <fieldset>
          <!-- R2-L3: the group's name is a heading inside its legend (legend content may be a heading), as every other
               Settings group's name is an <h4>: heading navigation finds them all, and the legend still names the fieldset. -->
          <legend class:same={nameShownElsewhere(section)}><h4>{section.title}</h4></legend>
          {@render fieldList(withToolRows(section.fields))}
        </fieldset>
      </Tile>
    {/if}
  {/each}
  {#if providersAt !== -1 && providersShown.readable && providersShown.rows.length > 1}
    <!-- Final round 2 (V4): the note after the groups, muted, as the S-A mockup's. P-A: once, under the list — a
         backup's settings are shown, not edited, in its row. -->
    <p class="muted">{BACKUP_SETTINGS_NOTE}</p>
  {/if}
</div>
{/if}

<style>
  /* The groups (each a `Tile`) stacked 14px apart (Part B, the S-A mockup's spacing). */
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0 0 14px;
  }
  /* The Tile is the group's box, so the fieldset draws none of its own. */
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  /* Part B: the group's name in the mockup's small capitals, in --muted (the mockup's faint grey is below 4.5:1 on a
   * tile). Step 0's Tile pads its content 0.65rem 0.8rem (lib/ui is frozen in wave 1), so the name and the rows
   * reach out to the mockup's 12px / 14px from the tile's edge, and the rows' lines run edge to edge. */
  legend {
    float: left;
    width: 100%;
    margin: calc(12px - 0.65rem) 0 0;
    padding: 0 calc(14px - 0.8rem) 0;
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  legend h4 {
    margin: 0;
    font: inherit;
  }
  /* P-A: "Today's briefing" — the mockup's callout above the list: a tile-coloured box, the skipped provider in a
   * struck-through muted chip, the one used in a green one (`--state-done`, ≥ 4.5:1 on --tile in both themes, app.css). */
  .today {
    margin: 0;
    padding: 9px 12px;
    border: 1px solid var(--tile-border);
    border-radius: 9px;
    background: var(--tile);
    font-size: 12.5px;
    line-height: 1.9;
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    border: 1px solid var(--tile-border);
    background: var(--surface, var(--bg));
    white-space: nowrap;
  }
  .chip.skip {
    color: var(--muted);
    text-decoration: line-through;
  }
  .chip.used {
    color: var(--state-done);
    border-color: var(--state-done);
    font-weight: 600;
  }
  /* P-A: row 1's own settings inside its opened row (ProvidersList's `.details`): one column — the label, the control,
   * its help — with no row hairlines and no reach to the tile's edges. */
  .rowfields {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 4px;
  }
  .rowfields .field {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 3px;
    margin: 0;
    padding: 6px 0;
    border-top: 0;
  }
  .rowfields .field > *,
  .rowfields .field > label:not(.inline),
  .rowfields .field > .help,
  .rowfields .field > .help ~ .note {
    grid-column: 1;
    grid-row: auto;
    justify-self: start;
  }
  .rowfields .field > label:not(.inline) {
    font-size: 12.5px;
  }
  .rowfields .field.wide > input,
  .rowfields .field.wide > textarea {
    justify-self: stretch;
  }
  /* Redesign D, "Look and wording": each setting is a row, the label and its one-line help on the left, the control
   * (and its error) on the right. `dense` lets the help fill the left cell under the label beside a tall control;
   * a note after the help stays with it, on the left. One column below the 720 px breakpoint. Part B: the mockup's
   * row — the words take the room, the control is as wide as it is — 11px 14px, a line between rows. Final round 2
   * (R2-M4): the control's column is at most half the row, so a long line in it (Morning time's stored-time note
   * with its button, a field's error) wraps there instead of squeezing the label column to nothing. */
  .field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) fit-content(50%);
    grid-auto-flow: row dense;
    column-gap: 12px;
    align-items: center;
    clear: both;
    margin: 0 -0.8rem;
    padding: 11px 14px;
    border-top: 1px solid var(--tile-border);
  }
  legend + .field {
    border-top: 0;
  }
  /* V11: the group's name, kept for the fieldset and heading navigation, drawn nowhere; the first row then starts at
   * the tile's top as the mockup's headerless groups do (its 11px padding from the edge). */
  legend.same {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  legend.same + .field {
    margin-top: -0.65rem;
  }
  /* Drawn bare (General's Updates), the first field follows the page's own legend: no line above it either. */
  .field:first-child {
    border-top: 0;
  }
  fieldset > .field:last-child {
    margin-bottom: -0.65rem;
  }
  /* A control spans two rows, so the help (row 2) sits right under the label beside a tall control (preview pass). */
  .field > * {
    grid-column: 2;
    grid-row: span 2;
    justify-self: end;
  }
  /* Final round 4 (V17): Morning time's control is MorningTimeSelect's own span (shared with the Wizard, unchanged),
   * which the scoped `.field > *` never matches: placed as every other control, in the row's control column. */
  .field > :global(.time) {
    grid-column: 2;
    grid-row: span 2;
    justify-self: end;
  }
  .field > label:not(.inline),
  .field > .help,
  .field > .help ~ .note {
    grid-column: 1;
    grid-row: auto;
    justify-self: stretch;
  }
  .field > label:not(.inline) {
    font-weight: 600;
    font-size: 13px;
  }
  /* Beside a control taller than the words, the label and its help stay together, centred on it (the spanning
   * control's extra height goes above the label and below the help, not between them). */
  .field > label:not(.inline) {
    align-self: end;
  }
  .field > .help {
    align-self: start;
  }
  /* Final round 2 (V2): a text or list row is one column at every width — the label, its help, then the control the
   * row's full width — as narrow rows are; beside a 240px box the words had 180px and the rows ran 100-250px tall. */
  .field.wide {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 6px;
  }
  .field.wide > *,
  .field.wide > label:not(.inline),
  .field.wide > .help,
  .field.wide > .help ~ .note {
    grid-column: 1;
    grid-row: auto;
    justify-self: stretch;
  }
  .field.wide > label:not(.inline) {
    order: -2;
  }
  .field.wide > .help {
    order: -1;
  }
  .field.wide > input,
  .field.wide > textarea {
    width: 100%;
  }
  /* V9: the engine-notifications row, one column while it shows its command's lines: the select keeps its width. */
  .field.wide > select {
    justify-self: start;
  }
  /* V6: Morning time's two selects (MorningTimeSelect, shared with the Wizard, unchanged) in the row's input look. */
  .field :global(.time select) {
    font-size: 13px;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
  }
  .field :global(.time) {
    margin-top: 0;
  }
  @media (max-width: 720px) {
    .field {
      grid-template-columns: minmax(0, 1fr);
      row-gap: 4px;
    }
    .field > *,
    .field > label:not(.inline),
    .field > .help,
    .field > .help ~ .note {
      grid-column: 1;
      grid-row: auto;
      justify-self: start;
    }
    .field > :global(.time) {
      grid-column: 1;
      grid-row: auto;
      justify-self: start;
    }
  }
  .inline {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 12px;
    margin: 0.2rem 0;
  }
  /* Part B: the mockup's inputs — 13px, 5px 9px, the tile's hairline, the surface colour. A number is short and
   * right-aligned; text and lists are wider, and never wider than the row. */
  input[type="text"],
  select,
  textarea {
    font: inherit;
    font-size: 13px;
    max-width: 100%;
    margin-top: 0;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
  /* Final round 4 (visual LOW): a placeholder in --muted, ≥ 4.5:1 on the surface (Chrome's own grey is 4.23:1 light,
   * 3.93:1 dark). */
  input::placeholder,
  textarea::placeholder {
    color: var(--muted);
    opacity: 1;
  }
  input[type="text"] {
    width: 15rem;
  }
  input.num {
    width: 90px;
    text-align: right;
  }
  select {
    min-width: 90px;
  }
  textarea {
    width: 15rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .help,
  .note,
  .muted {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .field-error {
    margin: 4px 0 0;
    color: var(--danger);
    font-size: 12px;
  }
  /* Round 11 (M1): a tool control's refusal, under it — read, not an error: the control already shows the file again. */
  .note.refused {
    margin-top: 4px;
    color: var(--fg);
  }
  .notice {
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    background: var(--panel);
  }
  .notice p {
    margin: 0 0 0.4rem;
  }
  /* The mockup's .btn (local buttons; Step 0's ActionButton has its own look). */
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
</style>
