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
   */
  import {
    hasPath,
    hasStoredApiKey,
    providerShape,
    readField,
    readNotifyCommand,
    sectionsFor,
    type Draft,
    type Field,
  } from "../lib/settings-model";

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

  {#each sectionsFor(draft) as section (section.title)}
    <fieldset>
      <legend>{section.title}</legend>
      {#each section.fields as field (field.id)}
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
          {#if field.quote}
            <p class="help"><q>{field.quote.text}</q> <span class="src">({field.quote.source})</span></p>
          {/if}
          {#if field.note}
            <p class="note">{field.note}</p>
          {/if}
        </div>
      {/each}
    </fieldset>
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
  .src {
    font-size: 0.75rem;
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
