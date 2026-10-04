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
   * for its verbatim test; the Advanced section is drawn collapsed (a `<details>` with no `open`) —
   * unless one of its fields has a live error. Save refuses with "fix the fields marked above", so a
   * marked field must be on screen: the section opens, and stays open while the error does. Closing it
   * while the error lives re-opens it in `ontoggle`: the `open` expression is still `true` then, so
   * Svelte never re-applies it, and the section would stay shut over the field Save refuses on
   * (cold verifier, LOW pass). Once the error is fixed the section is the user's again — it stays as
   * they left it (`ontoggle` records that), so fixing a field does not snap it shut under them.
   */
  import {
    hasPath,
    hasStoredApiKey,
    liveErrors,
    providerShape,
    readField,
    readNotifyCommand,
    readTime,
    sectionsFor,
    type Draft,
    type Field,
  } from "../lib/settings-model";
  import MorningTimeSelect from "../lib/MorningTimeSelect.svelte";

  interface Props {
    draft: Draft;
    errors: Record<string, string>;
    onfield: (field: Field, value: string) => void;
    onnotifycommand: (value: string) => void;
    /** `true`: remove the key (engine default); `false`: write an explicit empty list. */
    ondefault: (field: Field, useDefault: boolean) => void;
    onremovekey: () => void;
  }
  let { draft, errors, onfield, onnotifycommand, ondefault, onremovekey }: Props = $props();

  const value = (e: Event) => (e.currentTarget as HTMLInputElement).value;

  /** The errors Save refuses on (`formSubmission` checks the same `liveErrors`). */
  const live = $derived(liveErrors(draft, errors));
  /** Each collapsed section's open state as the user (or an error, below) last left it. */
  let opened = $state<Record<string, boolean>>({});
</script>

<div class="form">
  {#if providerShape(draft) === "api" && hasStoredApiKey(draft)}
    <div class="notice">
      <p>
        A literal API key is stored in the config file. Daily Briefing never shows it and cannot set
        or change it; it stays as it is unless you remove it here.
      </p>
      <button type="button" onclick={onremovekey}>Remove the stored key</button>
    </div>
  {/if}
  <p class="muted">
    Switching between a command-line provider and an API provider is done in the raw JSON tab: the
    engine refuses a config that has both.
  </p>

  {#snippet fieldList(fields: Field[])}
      {#each fields as field (field.id)}
        {@const current = readField(draft, field)}
        {@const usesDefault = field.defaultable === true && !hasPath(draft, field.path)}
        <div class="field">
          <label for="f-{field.id}">{field.label}</label>
          {#if field.kind === "text" || field.kind === "number"}
            <input
              id="f-{field.id}"
              type="text"
              value={current}
              placeholder={field.placeholder ?? ""}
              spellcheck="false"
              onchange={(e) => onfield(field, value(e))}
            />
          {:else if field.kind === "bool"}
            <select id="f-{field.id}" value={current} onchange={(e) => onfield(field, value(e))}>
              <option value="">Engine default</option>
              <option value="true">On</option>
              <option value="false">Off</option>
            </select>
          {:else if field.kind === "choice"}
            <select id="f-{field.id}" value={current} onchange={(e) => onfield(field, value(e))}>
              {#if !field.required}<option value="">Engine default</option>{/if}
              {#each field.options ?? [] as option (option)}
                <option value={option}>{option}</option>
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
            <textarea
              id="f-{field.id}"
              rows="3"
              spellcheck="false"
              disabled={usesDefault}
              value={current}
              placeholder={field.placeholder ?? ""}
              onchange={(e) => onfield(field, value(e))}
            ></textarea>
          {/if}
          {#if errors[field.id]}
            <p class="field-error">{errors[field.id]}</p>
          {/if}
          <p class="help">{field.help}</p>
          {#if field.note}
            <p class="note">{field.note}</p>
          {/if}
        </div>
      {/each}
  {/snippet}

  {#each sectionsFor(draft) as section (section.title)}
    {#if section.collapsed}
      <details
        class="collapsed"
        open={opened[section.title] === true || section.fields.some((f) => live[f.id] !== undefined)}
        ontoggle={(e) => {
          const el = e.currentTarget;
          if (!el.open && section.fields.some((f) => live[f.id] !== undefined)) el.open = true;
          opened[section.title] = el.open;
        }}
      >
        <summary>{section.title}</summary>
        <fieldset>
          {@render fieldList(section.fields)}
        </fieldset>
      </details>
    {:else}
      <fieldset>
        <legend>{section.title}</legend>
        {@render fieldList(section.fields)}
      </fieldset>
    {/if}
  {/each}
</div>

<style>
  fieldset {
    margin: 1rem 0 0;
    padding: 0.6rem 0.9rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 0.55rem;
  }
  legend {
    font-weight: 600;
    padding: 0 0.3rem;
  }
  .field {
    margin-top: 0.75rem;
  }
  .field > label {
    display: block;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .inline {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.85rem;
    margin: 0.2rem 0;
  }
  input[type="text"],
  select,
  textarea {
    font: inherit;
    width: 100%;
    margin-top: 0.25rem;
    padding: 0.35rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 0.4rem;
    background: var(--bg);
    color: inherit;
  }
  textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
  }
  .help,
  .note,
  .muted {
    margin: 0.25rem 0 0;
    font-size: 0.82rem;
    color: var(--muted);
  }
  details.collapsed {
    margin: 1rem 0 0;
  }
  details.collapsed > summary {
    font-weight: 600;
    cursor: pointer;
  }
  .field-error {
    margin: 0.25rem 0 0;
    color: var(--danger);
    font-size: 0.85rem;
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
  button {
    font: inherit;
    padding: 0.35rem 0.8rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
</style>
