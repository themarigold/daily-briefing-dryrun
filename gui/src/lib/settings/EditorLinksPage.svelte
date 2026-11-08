<script lang="ts">
  /**
   * B2-M6-T16 — Settings → Editor & links (B2 :71-77, P-M8). Props only: `routes/Settings.svelte` owns the driver
   * (`editorLinksLive`), and this page calls no IPC and reads no store. Every string is §0's approved table.
   *
   * macOS: the GitHub links switch, the Copy help in its own box, then one row per project from `editor_list`. Off macOS: the switch alone (B2 :77).
   * `idle` and `loading` draw nothing in the editors region, so no placeholder text exists (Q-L10).
   *
   * A row's control is a native `<select>`, the keyboard's way to choose again (B2 :71). "Not chosen yet" and an editor
   * no longer installed are shown as what the row holds and cannot be picked: `editor_choice_set` never stores `null`.
   *
   * The switch is never `disabled` while a set is in flight (WebKit then drops focus to the page: `PrefsRowsBody`,
   * round-4 M2); the driver drops a second click and `aria-busy` says it is working.
   */
  import type { Action } from "svelte/action";
  import { EDITOR_LABELS } from "../actions";
  import type { EditorLinksLine, EditorLinksView } from "../actions-live";
  import type { EditorChoice, EditorId } from "../app-prefs-store";
  import type { EditorProjectRow } from "../engine";
  import type { Os } from "../platform";
  import Switch from "../Switch.svelte";
  import Tile from "../ui/Tile.svelte";

  interface Props {
    os: Os;
    githubLinks: boolean;
    linksBusy: boolean;
    linksLine: EditorLinksLine | null;
    onlinks: (on: boolean) => void;
    editors: EditorLinksView;
    choiceLines: ReadonlyMap<string, EditorLinksLine>;
    onchoice: (project: string, choice: EditorChoice) => void;
  }
  let { os, githubLinks, linksBusy, linksLine, onlinks, editors, choiceLines, onchoice }: Props = $props();

  /** The row's stored editor when it is not among the installed ones (P-M10). */
  function gone(row: EditorProjectRow, installed: readonly { editor: EditorId }[]): EditorId | null {
    const choice = row.choice;
    return choice !== null && choice !== "ask" && !installed.some((e) => e.editor === choice) ? choice : null;
  }

  /** Svelte does not rewrite a select whose `value` prop did not change, so after a refused save the box would go on
   *  showing what was refused (`Switch`'s round-10 H1, for a select). A new line, or a new stored value, puts it back. */
  const showsStored: Action<HTMLSelectElement, { value: string; line: EditorLinksLine | undefined }> = (node) => ({
    update(next) { node.value = next.value; },
  });
</script>

<div class="group">
  <Tile>
    <div class="block">
      <div class="words">
        <label for="editor-links-github">GitHub links</label>
        <p id="editor-links-github-help">Show buttons that open your work on GitHub.</p>
      </div>
      <div class="control" aria-busy={linksBusy ? "true" : undefined}><Switch id="editor-links-github" describedby="editor-links-github-help" checked={githubLinks} onchange={(on) => onlinks(on)} /></div>
      <p class="line" class:bad={linksLine !== null && !linksLine.ok} aria-live="polite">{linksLine?.text ?? ""}</p>
    </div>
  </Tile>
</div>

{#if os === "macos"}
  <div class="group">
    <Tile>
      <div class="copy-help">
        <h4>Copy push command</h4>
        <p class="note">Running copied text is the same as typing git push in that repository. Hooks, SSH commands and other repository settings still apply. Your shell environment or settings may differ or change after copying. On Windows, use Git Bash.</p>
      </div>
    </Tile>
  </div>
{/if}

{#if os === "macos" && (editors.state === "failed" || editors.state === "ready")}
  <div class="group">
    <Tile>
      <fieldset>
        <legend><h4>Editors</h4></legend>
        {#if editors.state === "failed"}
          <p class="note bad">Could not list installed editors</p>
        {:else if editors.projects.length === 0}
          {#if editors.discoveryConfigured}
            <p class="note">Projects will appear here after the next briefing checks your discovery folders.</p>
          {:else}
            <p class="note">No projects are configured. Add projects in Settings → Projects.</p>
          {/if}
        {:else}
          <p class="note">Choose an installed editor, or ask each time. Hold Option while opening a project to choose again.</p>
          <ul>
            {#each editors.projects as row, i}
              <li class="block">
                {#if row.availability === "ready" && row.project !== null}
                  {@const project = row.project}
                  {@const selected = row.choice ?? ""}
                  {@const line = choiceLines.get(project)}
                  {@const missing = gone(row, editors.editors)}
                  <div class="words"><label for="editor-choice-{i}">Editor for {row.label}</label></div>
                  <div class="control">
                    <select id="editor-choice-{i}" value={selected} use:showsStored={{ value: selected, line }} onchange={(e) => onchoice(project, e.currentTarget.value as EditorChoice)}>
                      {#if row.choice === null}<option value="" disabled>Not chosen yet</option>{/if}
                      {#if missing !== null}<option value={missing} disabled>{EDITOR_LABELS[missing]}</option>{/if}
                      {#each editors.editors as e (e.editor)}<option value={e.editor}>{e.label}</option>{/each}
                      <option value="ask">Ask each time</option>
                    </select>
                  </div>
                  {#if missing !== null}<p class="note">The chosen editor is no longer installed.</p>{/if}
                  <p class="line" class:bad={line !== undefined && !line.ok} aria-live="polite">{line?.text ?? ""}</p>
                {:else}
                  {#if row.label !== "Not checked yet"}<div class="words"><span class="name">{row.label}</span></div>{/if}
                  <p class="note">Not checked yet</p>
                {/if}
              </li>
            {/each}
          </ul>
          <p class="note">Your editor may run workspace tasks according to its trust settings.</p>
        {/if}
      </fieldset>
    </Tile>
  </div>
{/if}

<style>
  /* The look of `PrefsRowsBody`'s rows: the group's name in small capitals, the words on the left and the control on
   * the right (one column below 720 px), 11px 14px, a line between rows. Step 0's Tile pads its content 0.65rem 0.8rem,
   * so the rows reach out to its edges. */
  .group {
    margin: 0 0 14px;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    padding: 0;
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
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .block {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 12px;
    align-items: center;
    margin: 0 -0.8rem;
    padding: 11px 14px;
  }
  li.block + li.block {
    border-top: 1px solid var(--tile-border);
  }
  .block > * {
    grid-column: 1 / -1;
  }
  .block > .words {
    grid-column: 1;
    min-width: 0;
  }
  .block > .control {
    grid-column: 2;
    display: flex;
    justify-content: flex-end;
  }
  @media (max-width: 720px) {
    .block {
      grid-template-columns: minmax(0, 1fr);
    }
    .block > .control {
      grid-column: 1;
      justify-content: flex-start;
      margin-top: 6px;
    }
  }
  label,
  .name {
    display: block;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  p {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  fieldset > .note,
  .copy-help > .note {
    margin: 6px calc(14px - 0.8rem);
  }
  .line:empty {
    margin: 0;
  }
  .line {
    margin-top: 6px;
  }
  .bad {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  /* SettingsForm's text input (Part B): 13px, 5px 9px, the tile's hairline, the surface colour. */
  select {
    font: inherit;
    font-size: 13px;
    max-width: 100%;
    margin: 0;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
</style>
