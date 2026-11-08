<script lang="ts">
  /**
   * P3-M4-T1 — Settings → "Providers, in order" (spec r9 §6). Presentation only: the rows come from
   * `providersView` (`lib/settings-model.ts`), and every action goes back through a callback — the list edits to the
   * draft, Test and Reset to `Settings.svelte`, which owns the IPC.
   *
   * ⚠ LABELS ARE DRAWN AS `display` — control characters stripped (spec §4) — and as text, never markup. `label` (the
   * entry's identity, as written) is only ever passed back to a callback.
   *
   * ⚠ A CONTROL IS DRAWN ONLY WHEN ITS HANDLER IS PASSED: there is no button that does nothing. Remove here edits the
   * list only; deleting the app key a removed entry referenced is the parent's, after the save (`lib/provider-flows.ts`).
   *
   * User-directed 2026-10-22 — layout P-A: ONE COMPACT ROW PER PROVIDER (the drag grip, its position, a header button
   * with the chevron, the name, a muted line saying what it is — `row.subline` — and the status tag), OPENING IN PLACE
   * (Calendar option A's `<button aria-expanded aria-controls>`: focus stays on the button, Enter and Space toggle it,
   * the user's open or closed choice is kept while the page is mounted — keyed by label — and a status refresh never
   * closes a row: `nextOpenRows`). Rows start closed; one opens by itself only when something in it needs the user — row
   * 1 when one of its fields carries an error (`firstNeedsOpen`, so a refused Save can reveal it), a row whose
   * replacement or written-key confirmation is open, a row holding a key written in the settings file (its banner), a
   * row whose last Test failed or did not run (Test all's results), and (round 9) a row whose status is bad. A row
   * never moves the focus (only "Add a provider…" does, to the form it opened — and, round 10 (M4), the user's own Move
   * up / Move down, Try again now, refused Add and its Close hand it on once the button pressed is gone, `focusAfter`).
   * The opened row holds, in order: the status sentence
   * (`row.sentence`) with "Try again now" (Reset, renamed; drawn only on a row with a mark, `row.marked`), the row's own
   * settings — row 1's are the form's fields for `provider` (`firstFields`, drawn by `SettingsForm`), a backup's are
   * read-only lines (`row.facts`) — the login folder where the engine reads one, and the row's buttons.
   *
   * P3-M4-T4 — an entry holding a key written in the settings file shows its `banner`, and either "Move this key to the
   * Keychain" (`onmigrate`) or, when a source of the user's own holds the place the moved key would take, "Remove the
   * key written in settings" — which only opens a confirmation on the row; "Remove it" there calls `onremoveliteral`.
   * Test stays disabled on such a row (the row's `test`).
   *
   * P3-M4-T2 — Add (`onadd`): user-directed 2026-10-22 (P-Add), a GUIDED form — three choices (`AddChoice`): a
   * subscription already had (a command-line tool: Claude Code, Codex or another command, `TOOL_PRESETS`), an API key
   * (a named service, `API_SERVICES`, that fills in its address — "Other" types one; a keyless local service draws no key
   * field), or another Claude account (only where the parent's `loginOf` offers one). Each choice makes today's
   * `AddForm` (`guidedForm`), handed to the parent, which runs the add flow and passes back `adding` (its lines, and what
   * is waiting: Save after a pass, Save anyway after a failed Test that ran, Test again after one that did not, Discard
   * always). Each input keeps what was typed while the choice changes. ⚠ THE KEY INPUT IS CLEARED AS THE KEY IS HANDED
   * OVER: this component keeps no copy once `onadd` took it (answered `true`; a refusal leaves it in its field), and the
   * input is a password field the browser does not autofill or remember.
   *
   * P3-M4-T3 — Replace key (`onreplace`): on a row the parent's `replaceable` allows (a SAVED API entry, nothing else in
   * progress), a key field for the NEW key, handed to the parent with the row's label; the parent runs the replace flow
   * and passes back `replacing` — drawn on that row: its lines, then Save / Save anyway / Test again, and Discard, which
   * stays available while the replacement waits on a running briefing (`waiting`). ⚠ THE REPLACE KEY INPUT IS CLEARED
   * AS THE KEY IS HANDED OVER, exactly as Add's.
   *
   * Reorder: drag a row by its grip onto another (round 10, M5: the grip alone is draggable), or use its Move up /
   * Move down buttons (the keyboard way; each drawn only where it can act — and round 10, M4: after a move the focus
   * stays with the moved row, `focusAfter`). A move the list writer refuses (a stored literal key would change place)
   * changes nothing; the parent shows why.
   *
   * PR 3 final r4 (H1) — ⚠ WHILE THE SCREEN IS BUSY (`view.busy`: a save, an add, a replacement, or a row's Test, Reset
   * or key move), Add and test, Move this key, Remove the key written in settings and Remove are drawn disabled, and an
   * open Replace field's Replace and test asks `replaceable` again: the parent would refuse each of them, and a control
   * must never silently do nothing. The busy state is the parent's (the view's); this component never decides it. A
   * pasted key is cleared only once the parent took it, so a refused submit keeps it in its field — a busy screen's,
   * and (PR 3 final r5, A3) one whose request the parent refuses (`onadd` answering `false`). Remove is not drawn on
   * the row whose replacement is in progress (`row.remove` `null`): that row carries the replacement's own buttons.
   * A pending add's or replacement's Save / Save anyway also waits for the form's Save (`pendingSaveLive`, the
   * parent's `saving` on the flow's view); its Test again and Discard follow only that flow's own step.
   */
  import { tick, untrack, type Snippet } from "svelte";
  import { guidedForm, guidedTakesKey, pendingSaveLive, replaceDiscardable, serviceOf, type AddChoice, type AddView, type ReplaceView } from "./provider-flows";
  import type { ProviderRowView, ProvidersView } from "./settings-model";
  import { ADD_LOCAL_KEY_NOTE, API_SERVICES, CLI_TEST_NOTE, PROVIDERS_HELP, PROVIDERS_TITLE, REMOVE_LITERAL_BUTTON, REMOVE_LITERAL_CONFIRM, serviceLabel } from "./settings-model";
  import { TOOL_OTHER_LABEL, TOOL_PRESETS, TRY_AGAIN_LABEL, type ApiServiceId, type ToolChoice } from "./settings-model";
  import { FIRST_FOLDER_HELP, NETWORK_ASK, TEST_FAILED_PREFIX } from "./settings-model";
  import { isSet, keyed, nextOpenRows, withRowOpen, type OpenRows } from "./calendar-settings";
  import type { AddForm } from "./provider-flows";

  interface Props {
    view: ProvidersView;
    /** Why the last list edit was refused, or "". */
    message?: string;
    onmove?: ((from: number, to: number) => void) | undefined;
    onremove?: ((label: string) => void) | undefined;
    onfolder?: ((label: string, dir: string) => void) | undefined;
    ontest?: ((label: string, draftIndex: number) => void) | undefined;
    /** P-A: Test all (the view's `testAll`), each row's own Test in turn (`Settings.svelte`). */
    ontestall?: (() => void) | undefined;
    /** Round 10 (M4): may answer the reset's promise (its status refresh included): the focus waits for it. */
    onreset?: ((label: string, savedIndex: number) => void | Promise<unknown>) | undefined;
    /** P3-M4-T2: run the add flow for the form, with the pasted key (`""` for a login). Answers at once whether the
     *  parent took it (`false`: refused, and the parent shows why — the form keeps what was typed). */
    onadd?: ((form: AddForm, key: string) => boolean) | undefined;
    /** The add in progress, or `null`. */
    adding?: AddView | null;
    /** The label (as drawn) of the entry another login copies (`provider-flows.ts` `loginSource`: a Claude command-line
     *  tool only), or `null`: no login offered. */
    loginOf?: string | null;
    onaddsave?: (() => void) | undefined;
    onaddretest?: (() => void) | undefined;
    onadddiscard?: (() => void) | undefined;
    /** Close a refused add's lines. */
    onaddclose?: (() => void) | undefined;
    /** P3-M4-T4: "Move this key to the Keychain" (the key folder off macOS: `migrate.text`) on a row whose `migrate` is
     *  offered. */
    onmigrate?: ((label: string, savedIndex: number) => void) | undefined;
    /** P3-M4-T4: remove the key written in settings, once its confirmation was answered "Remove it". */
    onremoveliteral?: ((label: string, savedIndex: number) => void) | undefined;
    /** P-A: row 1's own settings — the form's fields for `provider`, drawn in its opened row (`SettingsForm`). */
    firstFields?: Snippet | undefined;
    /** P-A: one of row 1's fields carries an error: row 1 opens, so a refused Save can bring that field into view. */
    firstNeedsOpen?: boolean;
    /** TEST ONLY — the rows (by label) that start open (a server render has no click). */
    openRows?: string[];
    /** TEST ONLY — the row (by label) whose remove confirmation starts open (a server render has no click). */
    confirmRemoveFor?: string | null;
    /** TEST ONLY — the Add form starts open. */
    addFormOpen?: boolean;
    /** TEST ONLY — the open Add form's choice, service and command-line tool (a server render has no input). */
    addFormChoice?: AddChoice;
    addFormService?: ApiServiceId;
    addFormTool?: ToolChoice;
    /** TEST ONLY — the row (by label) whose Replace key field starts open. */
    replaceOpenFor?: string | null;
    /** P3-M4-T3: run the replace flow for the row `label`, with the pasted NEW key. */
    onreplace?: ((label: string, key: string) => void) | undefined;
    /** The replacement in progress, or `null`. */
    replacing?: ReplaceView | null;
    /** Whether a row is offered "Replace key" (`provider-flows.ts` `replaceOffered`, busy state applied). */
    replaceable?: ((row: { isCli: boolean; savedIndex: number | null }) => boolean) | undefined;
    onreplacesave?: (() => void) | undefined;
    onreplaceretest?: (() => void) | undefined;
    onreplacediscard?: (() => void) | undefined;
    onreplaceclose?: (() => void) | undefined;
    /** Redesign D: a pending Add's network-check question (the shell's `askNetworkAdd`), drawn just before the Add's
     *  first button, and its answer, bound both ways (the Add's Save applies it). */
    networkAsk?: boolean | undefined;
    networkYes?: boolean | undefined;
  }
  let {
    view,
    message = "",
    onmove,
    onremove,
    onfolder,
    ontest,
    ontestall,
    onreset,
    onadd,
    adding = null,
    loginOf = null,
    onaddsave,
    onaddretest,
    onadddiscard,
    onaddclose,
    onmigrate,
    onremoveliteral,
    firstFields,
    firstNeedsOpen = false,
    openRows = [],
    confirmRemoveFor = null,
    addFormOpen = false,
    addFormChoice = "subscription",
    addFormService = "anthropic",
    addFormTool = "claude",
    replaceOpenFor = null,
    onreplace,
    replacing = null,
    replaceable,
    onreplacesave,
    onreplaceretest,
    onreplacediscard,
    onreplaceclose,
    networkAsk = false,
    networkYes = $bindable(),
  }: Props = $props();

  /** The parent's busy state (H1): an unreadable list draws no control, so it counts as busy. */
  const busy = $derived(!view.readable || view.busy);

  /** The row (by label) whose "Remove the key written in settings" confirmation is open. */
  let confirmFor = $state<string | null>(untrack(() => confirmRemoveFor));

  /** The row being dragged, by its draft index. */
  let dragging = $state<number | null>(null);

  /** Final round 4 (R4-M4, pre-existing on main): the login folder the draft holds for `label`, which its input shows
   *  again once a change was handled (after the flush). A refused folder is never written into the draft and Svelte
   *  does not rewrite an input whose value prop did not change, so the refused text stayed on screen after its message
   *  went, and was never saved; the refusal's message says why the folder went back. */
  const shownFolder = (label: string): string => (view.readable ? (view.rows.find((r) => r.label === label)?.configDir ?? "") : "");

  function drop(to: number): void {
    const from = dragging;
    dragging = null;
    if (from !== null && from !== to) onmove?.(from, to);
  }

  /* ── round 10 (M4): the focus after the user's own action ── */

  let rootEl = $state<HTMLElement | undefined>(undefined);
  let listEl = $state<HTMLElement | undefined>(undefined);
  /** Row `label`'s element, at its place now. */
  const rowEl = (label: string): HTMLElement | null => {
    if (!view.readable || listEl === undefined) return null;
    const i = view.rows.findIndex((r) => r.label === label);
    return i === -1 ? null : ((listEl.children[i] as HTMLElement | undefined) ?? null);
  };
  const buttonIn = (row: HTMLElement | null, text: string): HTMLElement | null =>
    row === null ? null : ([...row.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null);
  const headOf = (row: HTMLElement | null): HTMLElement | null => row?.querySelector<HTMLElement>("button.head") ?? null;
  /** The button the user pressed is gone once its action is drawn (Move up on row 2, a "Try again now" whose refresh
   *  cleared the mark, a refused Add's form), or lost the focus while it was disabled: the focus, fallen to the page,
   *  goes to the first of `targets` still drawn and enabled. Never when the focus is anywhere else, and only after the
   *  user's own action (a row that changes by itself never moves the focus). */
  async function focusAfter(targets: () => (HTMLElement | null)[]): Promise<void> {
    await tick();
    const now = document.activeElement;
    if (now !== null && now !== document.body) return;
    targets()
      .find((t) => t !== null && t.isConnected && !(t instanceof HTMLButtonElement && t.disabled))
      ?.focus();
  }
  /** Move up / Move down: the moved row's own button in the same direction, its other one at an end, else its head. */
  function move(label: string, from: number, to: number): void {
    onmove?.(from, to);
    const [same, other] = to < from ? ["Move up", "Move down"] : ["Move down", "Move up"];
    void focusAfter(() => {
      const li = rowEl(label);
      return [buttonIn(li, same!), buttonIn(li, other!), headOf(li)];
    });
  }
  /** Try again now: once its reset and the status refresh are done, the row's own button if it is still drawn (the
   *  mark stayed), else the row's head. */
  async function tryAgain(label: string, savedIndex: number): Promise<void> {
    await onreset?.(label, savedIndex);
    await focusAfter(() => {
      const li = rowEl(label);
      return [buttonIn(li, TRY_AGAIN_LABEL), headOf(li)];
    });
  }
  /** "Add and test" (`submitAdd`). A refusal the parent shows replaces the form, and this button with it: the form is
   *  still open (only a take closes it), so the refusal's Close takes the focus. Round 11 (L6): a take closes the form,
   *  and the panel says "Adding and testing…" with no control until the add answers: the focus is owed to the panel's
   *  first control once it is drawn (`addFocusOwed`). */
  function addAndTest(): void {
    submitAdd();
    if (formOpen) void focusAfter(() => [closeIn()]);
    else addFocusOwed = adding !== null;
  }
  /** Round 11 (L6): set by the user's own "Add and test" when it was taken; paid once, when the add's panel first draws
   *  a control (its Save, Save anyway, Test again or Discard; the network question's box first when it is asked) — and
   *  only if the focus is still on the page then (`focusAfter`). */
  let addFocusOwed = false;
  const firstAddControl = (): HTMLElement | null => rootEl?.querySelector<HTMLElement>(".list ~ .adding input, .list ~ .adding button") ?? null;
  $effect(() => {
    if (adding === null || adding.busy) return;
    if (!addFocusOwed) return;
    addFocusOwed = false;
    void focusAfter(() => [firstAddControl()]);
  });
  /** A refused Add's lines replace the form: the refusal's Close. Closing them: the form's chosen card again, else
   *  "Add a provider…". */
  const closeIn = (): HTMLElement | null =>
    rootEl === undefined ? null : ([...rootEl.querySelectorAll<HTMLButtonElement>(".adding .actions button")].find((b) => b.textContent?.trim() === "Close") ?? null);
  function closeAdding(): void {
    onaddclose?.();
    void focusAfter(() => [
      rootEl?.querySelector<HTMLElement>('.add.guided input[name="prov-add-choice"]:checked') ?? null,
      rootEl === undefined ? null : ([...rootEl.querySelectorAll<HTMLButtonElement>(".foot button")].find((b) => b.textContent?.trim() === "Add a provider…") ?? null),
    ]);
  }

  /* ── Replace key ── */
  /** The row whose "Replace key" field is open, by label. */
  let replaceFor = $state<string | null>(untrack(() => replaceOpenFor));
  /** The pasted NEW key: cleared the moment it is handed to `onreplace`. */
  let replaceKey = $state("");

  function closeReplace(): void {
    replaceFor = null;
    replaceKey = "";
  }

  /** Refused, with the key kept in its field, while the parent's `replaceable` says no (its button is disabled then). */
  function submitReplace(row: ProviderRowView): void {
    if (onreplace === undefined || replaceable?.(row) !== true) return;
    const pasted = replaceKey;
    replaceKey = "";
    onreplace(row.label, pasted);
    closeReplace();
  }

  /* ── P-A: the open rows ── */

  /** Which rows need to be open now (by label): row 1 with a field error, a row whose replacement or written-key
   *  confirmation is open, a row holding a key written in the settings file (its banner asks the user to move or
   *  remove it), a row whose last Test failed or did not run (so Test all's failures are never hidden), and (round 9,
   *  L3) a row whose status is bad — invalid, its key moved out, not working — so its reason and remedy are on screen,
   *  as Calendar opens a row whose tag is a warning. */
  const failedTest = (line: string): boolean => line.startsWith(TEST_FAILED_PREFIX) || line.startsWith("Not tested");
  const needs = $derived.by((): Record<string, boolean> => {
    // Round 12 (L4): keyed by label with no prototype (`keyed`), so a `__proto__` or `constructor` label is a row too.
    const out = keyed<boolean>();
    if (!view.readable) return out;
    view.rows.forEach((r, i) => {
      out[r.label] =
        (i === 0 && firstNeedsOpen) || replacing?.label === r.label || replaceFor === r.label || confirmFor === r.label || r.banner !== null || r.notes.some(failedTest) || r.status.tone === "bad";
    });
    return out;
  });
  /** Seeded from the first snapshot (a server render runs no effect), then moved on by every change of the needs —
   *  never closing a row the user opened, never reopening one they closed while it still needs them. */
  let rows = $state.raw<OpenRows>(
    nextOpenRows({ open: Object.fromEntries(untrack(() => openRows).map((l) => [l, true])), needed: {} }, untrack(() => needs)),
  );
  $effect(() => {
    const now = needs;
    untrack(() => (rows = nextOpenRows(rows, now)));
  });
  const isOpen = (label: string): boolean => isSet(rows.open, label);
  /** A header button's click: its own row only. Focus stays on the button (it is not redrawn). */
  function toggle(label: string): void {
    rows = withRowOpen(rows, label, !isOpen(label));
  }

  /* ── the add form (P-Add) ── */
  let formOpen = $state(untrack(() => addFormOpen));
  let choice = $state<AddChoice>(untrack(() => addFormChoice));
  /** "Another Claude account" is offered only while there is a Claude first tool to copy (`loginOf`). */
  const shownChoice = $derived<AddChoice>(choice === "login" && loginOf === null ? "subscription" : choice);
  let service = $state<ApiServiceId>(untrack(() => addFormService));
  let label = $state("");
  let model = $state("");
  /** "Other OpenAI-compatible service"'s address — the only one typed. */
  let baseUrl = $state("");
  let configDir = $state("");
  /** The subscription choice's tool (user-directed 2026-10-22, P1), and Other's command and arguments (one per line). */
  let tool = $state<ToolChoice>(untrack(() => addFormTool));
  let command = $state("");
  let args = $state("");
  /** The pasted key: cleared the moment it is handed to `onadd`. */
  let key = $state("");
  const chosen = $derived(serviceOf(service));
  const here = $derived(view.readable ? view.here : "on this Mac");
  const keyStore = $derived(view.readable ? view.keyStore : "Keychain");

  const CHOICES = $derived<{ id: AddChoice; title: string; line: string }[]>([
    { id: "subscription", title: "A subscription you already have", line: "Claude Code, Codex, or another command-line tool you're logged into. No key needed." },
    // Round 10 (L5): Ollama and LM Studio are keyless (`API_SERVICES`' `keyless`), and the line says so.
    {
      id: "api",
      title: "An API key",
      line: `Anthropic, OpenAI, or a local model (Ollama, LM Studio). Pay per use; the app keeps the key in your ${keyStore}. A local model ${here} needs no key.`,
    },
    { id: "login", title: "Another Claude account", line: "A second Claude login, used when the first runs out." },
  ]);

  /** Round 9 (L8): "Add a provider…" is gone once the form is drawn, so the focus moves to the form's first choice
   *  (the button pressed would leave it on the page). The only focus this component moves: a row that opens by itself
   *  never takes it. */
  async function openForm(): Promise<void> {
    formOpen = true;
    await tick();
    document.querySelector<HTMLElement>('.add.guided input[name="prov-add-choice"]:checked')?.focus();
  }

  function closeForm(): void {
    formOpen = false;
    key = "";
    label = model = baseUrl = configDir = command = args = "";
    tool = "claude";
    choice = "subscription";
    service = "anthropic";
  }

  /** Refused, with the key kept in its field, while the screen is busy (its button is disabled then), and when the
   *  parent refuses the request (PR 3 final r5, A3: `onadd` answers `false` — no name, no model — and shows why): the
   *  form and the pasted key stay as typed. Cleared only once the parent took the add. A choice that takes no key hands
   *  over none. */
  function submitAdd(): void {
    if (onadd === undefined || busy) return;
    const form: AddForm = guidedForm(shownChoice, { label, tool, command, args, service, model, address: baseUrl, configDir });
    if (!onadd(form, guidedTakesKey(shownChoice, service) ? key : "")) return;
    key = "";
    closeForm();
  }
</script>

<fieldset class="providers" bind:this={rootEl}>
  <!-- Redesign D final round 2 (R2-L3): the group's name is a heading inside its legend, as on every Settings group. -->
  <legend><h4>{PROVIDERS_TITLE}</h4></legend>
  <p class="help">{PROVIDERS_HELP}</p>
  {#if !view.readable}
    <p class="bad">{view.message}</p>
  {:else}
    {#if view.note !== null}
      <p class="note">{view.note}</p>
    {/if}
    <ol class="list" bind:this={listEl}>
      {#each view.rows as row, i (row.label)}
        <!-- Round 10 (M5): a row is dragged by its GRIP only (`draggable` is the grip's). On a draggable row, a drag that
             selects text in row 1's inputs started a row drag — it replaced the drag's text, could reorder the rows on
             drop and cancelled a text drop. The whole row is still the drag image, and still where a drag lands. -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li
          class="row"
          class:dragging={dragging === i}
          ondragover={(e) => {
            if (dragging !== null) e.preventDefault();
          }}
          ondrop={(e) => {
            // Round 9 (L4): only a row's drag is this list's; text dropped into row 1's inputs is the input's.
            if (dragging === null) return;
            e.preventDefault();
            drop(i);
          }}
        >
          <div class="line">
            {#if onmove !== undefined}
              <span
                class="grip"
                aria-hidden="true"
                draggable="true"
                ondragstart={(e) => {
                  dragging = i;
                  e.dataTransfer?.setData("text/plain", String(i));
                  const li = (e.currentTarget as HTMLElement).closest("li");
                  if (li !== null) e.dataTransfer?.setDragImage(li, 12, 12);
                }}
                ondragend={() => (dragging = null)}>⋮⋮</span
              >
            {/if}
            <span class="position" aria-hidden="true">{i + 1}</span>
            <button type="button" class="head ctl" aria-expanded={isOpen(row.label)} aria-controls="prov-row-{i}" onclick={() => toggle(row.label)}>
              <svg class="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
              <span class="words"><span class="label">{row.display}</span> <span class="sub">· {row.subline}</span></span>
              <span class="status tone-{row.status.tone}"><span aria-hidden="true">●</span> {row.tag}</span>
            </button>
          </div>
          <div class="details" id="prov-row-{i}" hidden={!isOpen(row.label)}>
            <p class="sentence">
              <strong>{row.sentence.lead}</strong>{#if row.sentence.rest !== null}{" "}{row.sentence.rest}{/if}
              {#if onreset !== undefined && row.reset !== null && row.savedIndex !== null && row.marked}
                {@const savedIndex = row.savedIndex}
                <button
                  type="button"
                  disabled={!row.reset.enabled}
                  title={row.reset.why ?? ""}
                  onclick={() => void tryAgain(row.label, savedIndex)}>{TRY_AGAIN_LABEL}</button
                >
              {/if}
            </p>
            {#if onreset !== undefined && row.reset !== null && row.marked && !row.reset.enabled && row.reset.why !== null}
              <p class="why">{row.reset.why}</p>
            {/if}
            {#if row.sentence.remedy !== null}
              <p class="remedy">{row.sentence.remedy}</p>
            {/if}
            {#if row.banner !== null}
              <p class="banner">{row.banner}</p>
            {/if}
            {#each row.notes as line, n (n)}
              <p class="note">{line}</p>
            {/each}
            {#each row.facts as line, n (n)}
              <p class="fact">{line}</p>
            {/each}
            {#if i === 0 && firstFields !== undefined}
              <div class="own">{@render firstFields()}</div>
            {/if}
            <!-- User-directed 2026-10-22 (P5): only where the engine reads a login folder (a Claude tool), or where one is
                 already written (the engine reports it there; it stays so it can be cleared). -->
            {#if row.folder && onfolder !== undefined}
              <label class="folder">
                Login folder (Claude logins only; empty means the tool's own login)
                <input
                  type="text"
                  spellcheck="false"
                  value={row.configDir ?? ""}
                  onchange={async (e) => {
                    const input = e.currentTarget as HTMLInputElement;
                    onfolder(row.label, input.value);
                    await tick();
                    input.value = shownFolder(row.label);
                  }}
                />
              </label>
              <!-- Round 9 (L15): row 1's, the mockup's help line. -->
              {#if i === 0}
                <p class="help folder-help">{FIRST_FOLDER_HELP}</p>
              {/if}
            {/if}
            <div class="actions">
              {#if ontest !== undefined}
                <button
                  type="button"
                  disabled={!row.test.enabled}
                  title={row.test.why ?? ""}
                  onclick={() => ontest(row.label, row.draftIndex)}>{row.test.text}</button
                >
              {/if}
              {#if onmove !== undefined && i > 0}
                <button type="button" onclick={() => move(row.label, i, i - 1)}>Move up</button>
              {/if}
              {#if onmove !== undefined && i < view.rows.length - 1}
                <button type="button" onclick={() => move(row.label, i, i + 1)}>Move down</button>
              {/if}
              {#if onmigrate !== undefined && row.migrate !== null && row.savedIndex !== null}
                {@const savedIndex = row.savedIndex}
                <button
                  type="button"
                  disabled={!row.migrate.enabled}
                  title={row.migrate.why ?? ""}
                  onclick={() => onmigrate(row.label, savedIndex)}>{row.migrate.text}</button
                >
              {/if}
              {#if onremoveliteral !== undefined && row.removeLiteral !== null && row.savedIndex !== null && confirmFor !== row.label}
                <button type="button" disabled={!row.removeLiteral.enabled} title={row.removeLiteral.why ?? ""} onclick={() => (confirmFor = row.label)}>{REMOVE_LITERAL_BUTTON}</button>
              {/if}
              {#if onreplace !== undefined && replaceable?.(row) === true && replaceFor !== row.label}
                <button type="button" onclick={() => (replaceFor = row.label)}>Replace key</button>
              {/if}
              {#if onremove !== undefined && row.remove !== null}
                <button type="button" disabled={!row.remove.enabled} onclick={() => onremove(row.label)}>Remove</button>
              {/if}
            </div>
            {#if onremoveliteral !== undefined && row.removeLiteral !== null && row.savedIndex !== null && confirmFor === row.label}
              {@const savedIndex = row.savedIndex}
              <div class="add">
                <p class="note">{REMOVE_LITERAL_CONFIRM}</p>
                <div class="actions">
                  <button type="button" class="primary" disabled={!row.removeLiteral.enabled} onclick={() => { confirmFor = null; onremoveliteral(row.label, savedIndex); }}>Remove it</button>
                  <button type="button" onclick={() => (confirmFor = null)}>Cancel</button>
                </div>
              </div>
            {/if}
            {#if replaceFor === row.label}
              <div class="add">
                <label>
                  New API key (the app stores it for you)
                  <input type="password" autocomplete="off" spellcheck="false" bind:value={replaceKey} />
                </label>
                <div class="actions">
                  <button type="button" class="primary" disabled={replaceable?.(row) !== true} onclick={() => submitReplace(row)}>Replace and test</button>
                  <button type="button" onclick={closeReplace}>Cancel</button>
                </div>
              </div>
            {/if}
            {#if replacing !== null && replacing.label === row.label}
              <div class="adding" aria-live="polite">
                {#if replacing.busy && !replacing.waiting}
                  <p class="note">Working on the new key…</p>
                {/if}
                {#each replacing.lines as line, n (n)}
                  <p class="note">{line}</p>
                {/each}
                <div class="actions">
                  {#if replacing.pending !== null}
                    {#if replacing.pending.passed}
                      <button type="button" class="primary" disabled={!pendingSaveLive(replacing)} onclick={() => onreplacesave?.()}>Save</button>
                    {:else if replacing.pending.ran}
                      <button type="button" disabled={!pendingSaveLive(replacing)} onclick={() => onreplacesave?.()}>Save anyway</button>
                      <button type="button" disabled={replacing.busy} onclick={() => onreplaceretest?.()}>Test again</button>
                    {:else}
                      <button type="button" disabled={replacing.busy} onclick={() => onreplaceretest?.()}>Test again</button>
                    {/if}
                    <button type="button" disabled={!replaceDiscardable(replacing)} onclick={() => onreplacediscard?.()}>Discard</button>
                  {:else if !replacing.busy}
                    <button type="button" onclick={() => onreplaceclose?.()}>Close</button>
                  {/if}
                </div>
              </div>
            {/if}
            {#if !row.test.enabled && row.test.why !== null}
              <p class="why">{row.test.why}</p>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
    {#if message !== ""}
      <p class="bad">{message}</p>
    {/if}
    <!-- P-A: the footer row — Test all, and the primary "Add a provider…" (the S-A mockup's, on the right). -->
    {#if (ontestall !== undefined && view.testAll !== null) || (onadd !== undefined && adding === null && !formOpen)}
      <div class="foot">
        {#if ontestall !== undefined && view.testAll !== null}
          <button type="button" disabled={!view.testAll.enabled} title={view.testAll.why ?? ""} onclick={() => ontestall()}>{view.testAll.text}</button>
        {/if}
        {#if onadd !== undefined && adding === null && !formOpen}
          <button type="button" class="primary" onclick={openForm}>Add a provider…</button>
        {/if}
      </div>
      {#if ontestall !== undefined && view.testAll !== null && !view.testAll.enabled && view.testAll.why !== null}
        <p class="why foot-why">{view.testAll.why}</p>
      {/if}
    {/if}
    {#if onadd !== undefined}
      {#if adding !== null}
        <div class="adding" aria-live="polite">
          {#if adding.busy}
            <p class="note">Adding and testing the new provider…</p>
          {/if}
          {#each adding.lines as line, n (n)}
            <p class="note">{line}</p>
          {/each}
          <div class="actions">
            {#if adding.pending !== null}
              {#if networkAsk}
                <div class="network">
                  <p class="note">{NETWORK_ASK.question}</p>
                  <label class="inline">
                    <input type="checkbox" bind:checked={networkYes} />
                    {NETWORK_ASK.yes}
                  </label>
                </div>
              {/if}
              {#if adding.pending.passed}
                <button type="button" class="primary" disabled={!pendingSaveLive(adding)} onclick={() => onaddsave?.()}>Save</button>
              {:else if adding.pending.ran}
                <button type="button" disabled={!pendingSaveLive(adding)} onclick={() => onaddsave?.()}>Save anyway</button>
                <button type="button" disabled={adding.busy} onclick={() => onaddretest?.()}>Test again</button>
              {:else}
                <button type="button" disabled={adding.busy} onclick={() => onaddretest?.()}>Test again</button>
              {/if}
              <button type="button" disabled={adding.busy} onclick={() => onadddiscard?.()}>Discard</button>
            {:else if !adding.busy}
              <button type="button" onclick={closeAdding}>Close</button>
            {/if}
          </div>
        </div>
      {:else if formOpen}
        <div class="add guided">
          <fieldset class="choose">
            <legend>Add a provider: what do you want to use?</legend>
            {#each CHOICES.filter((c) => c.id !== "login" || loginOf !== null) as c (c.id)}
              <label class="card" class:on={shownChoice === c.id}>
                <input type="radio" name="prov-add-choice" value={c.id} checked={shownChoice === c.id} onchange={() => (choice = c.id)} />
                <span class="card-words"><span class="card-title">{c.title}</span><span class="card-line">{c.line}</span></span>
              </label>
            {/each}
          </fieldset>
          {#if shownChoice === "subscription"}
            <label>
              Tool
              <select bind:value={tool}>
                {#each TOOL_PRESETS as t (t.id)}
                  <option value={t.id}>{t.label}</option>
                {/each}
                <option value="other">{TOOL_OTHER_LABEL}</option>
              </select>
            </label>
            {#if tool === "other"}
              <label>
                Command (its name if it is on your PATH, or its full path)
                <input type="text" spellcheck="false" bind:value={command} />
              </label>
              <label>
                Arguments (one per line; the prompt is passed on standard input)
                <textarea rows="3" spellcheck="false" bind:value={args}></textarea>
              </label>
            {/if}
          {:else if shownChoice === "api"}
            <label>
              Service
              <select bind:value={service}>
                {#each API_SERVICES as s (s.id)}
                  <option value={s.id}>{s.local ? `${s.name} ${here}` : serviceLabel(s, undefined)}</option>
                {/each}
              </select>
            </label>
            {#if chosen.id === "other"}
              <label>
                Address (for example https://host/v1; a key the app stores is sent only over https to another machine)
                <input type="text" spellcheck="false" bind:value={baseUrl} />
              </label>
            {:else if chosen.baseUrl !== null}
              <p class="note">Address: {chosen.baseUrl} (filled in for you)</p>
            {/if}
            <label>
              Model
              <input type="text" spellcheck="false" bind:value={model} />
            </label>
            {#if guidedTakesKey(shownChoice, service)}
              <label>
                API key (the app stores it for you, never in the settings file)
                <input type="password" autocomplete="off" spellcheck="false" bind:value={key} />
              </label>
              {#if chosen.id === "other"}
                <p class="note">{ADD_LOCAL_KEY_NOTE}</p>
              {/if}
            {:else}
              <p class="note">No key is needed for a model running {here}.</p>
            {/if}
          {:else}
            <label>
              Login folder (the second account's own; it shares {loginOf}'s tool and account)
              <input type="text" spellcheck="false" bind:value={configDir} />
            </label>
          {/if}
          <label>
            Name (it cannot be changed later)
            <input type="text" spellcheck="false" bind:value={label} />
          </label>
          <div class="actions end">
            <button type="button" onclick={closeForm}>Cancel</button>
            <button type="button" class="primary" disabled={busy} onclick={addAndTest}>{shownChoice === "api" ? "Add and test" : `Add and test — ${CLI_TEST_NOTE}`}</button>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</fieldset>

<style>
  /* Redesign D: Settings draws the list in a `Tile` (SettingsForm), which is the group's box. */
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  /* Final round 2 (V4): the group's name as every Settings group's, the S-A mockup's small capitals in --muted; its
   * help at the rows' 12px. Final round 3 (V16): placed exactly as SettingsForm's legends are — 12px from the tile's
   * top, 14px from its side (Step 0's Tile pads its content 0.65rem 0.8rem; lib/ui is frozen in wave 1). */
  legend {
    float: left;
    width: 100%;
    margin: calc(12px - 0.65rem) 0 0;
    padding: 0 calc(14px - 0.8rem);
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .providers > .help {
    clear: both;
    font-size: 12px;
  }
  /* What follows the legend sits 14px from the tile's sides, as the rows' words do. */
  .providers > :not(legend, .list, .foot) {
    margin-inline: calc(14px - 0.8rem);
  }
  legend h4 {
    margin: 0;
    font: inherit;
  }
  /* P-A: the S-A mockup's `.item` rows — flat, edge to edge across the tile, a hairline between them: the grip, the
   * number, then the header button (chevron, name · what it is, the status tag at the right in 11.5px). */
  .list {
    list-style: none;
    margin: 8px -0.8rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .list:last-child {
    margin-bottom: -0.65rem;
  }
  .row {
    border-top: 1px solid var(--tile-border);
    font-size: 13px;
  }
  .row.dragging {
    opacity: 0.6;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 14px;
  }
  .grip {
    flex: none;
    color: var(--muted);
    letter-spacing: -2px;
    font-size: 13px;
    cursor: grab;
    /* Round 11 (L3): a hit area of at least 24×24 px around the 7×16 px glyph; the negative margin gives the padding
       back, so the row is laid out exactly as before. */
    padding: 4px 9px;
    margin: -4px -9px;
  }
  .position {
    flex: none;
    min-width: 14px;
    text-align: right;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  button.head {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    margin: 0;
    padding: 9px 14px 9px 2px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    /* The focus ring inside the row, clear of the hairlines above and below it (Calendar's rows). */
    outline-offset: -2px;
  }
  /* Round 9 (L9): app.css's `.ctl.ctl:focus-visible` (0,3,0) sets a 2px offset; this rule outranks it, as Calendar's
   * `.panel button.head` does, so both pages' rows draw the ring inside the row. */
  button.head:focus-visible {
    outline-offset: -2px;
  }
  .chev {
    flex: none;
    align-self: center;
    width: 10px;
    height: 10px;
    color: var(--muted);
    transition: transform 0.15s ease;
  }
  .head[aria-expanded="true"] .chev {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
  .words {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .label {
    font-weight: 600;
  }
  .sub {
    color: var(--muted);
    font-size: 12px;
  }
  .status {
    flex: none;
    max-width: 45%;
    font-size: 11.5px;
    text-align: right;
  }
  /* Final round 4 (V18): the S-A mockup's status tones. Its green has no Step 0 token, so it is this component's own
   * custom property, light and dark (the mockup's values: 5.0:1 and 9.5:1 on the tile); waiting (out of usage,
   * paused) is the mockup's amber, Step 0's --tag-local (≥ 4.5:1 on the tile in both themes, settings-pages.check.ts). */
  .providers {
    --tone-ok: #15803d;
  }
  .tone-ok {
    color: var(--tone-ok);
  }
  .tone-warn {
    color: var(--tag-local);
  }
  .tone-bad {
    color: var(--danger);
  }
  .tone-quiet {
    color: var(--muted);
  }
  @media (prefers-color-scheme: dark) {
    .providers {
      --tone-ok: #4ade80;
    }
  }
  /* The opened row: under the name (the mockup's 50px: the grip, the number and the chevron's columns). */
  .details {
    padding: 2px 14px 12px 50px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .details[hidden] {
    display: none;
  }
  .sentence {
    margin: 0;
    font-size: 13px;
  }
  .sentence button {
    margin-left: 6px;
  }
  .banner {
    margin: 4px 0 0;
    font-size: 12px;
  }
  .help,
  .remedy,
  .note,
  .fact,
  .why {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
    white-space: pre-wrap;
  }
  .bad {
    color: var(--danger);
    white-space: pre-wrap;
  }
  .folder {
    display: block;
    margin-top: 6px;
    font-size: 12px;
    font-weight: 600;
  }
  /* Round 9 (L15): row 1's help line under its Login folder, the rows' muted 12px. */
  .folder-help {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--muted);
  }
  .folder input {
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    width: 100%;
    margin-top: 4px;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
  .actions {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .actions.end {
    justify-content: flex-end;
  }
  .network {
    flex-basis: 100%;
  }
  .network .inline {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.85rem;
  }
  /* Final round 3 (V10): D's local button look (the mockup's .btn): 12.5px, 5px 11px, radius 6, the tile's fill and
   * hairline; the primary one on the accent. */
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
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  /* P-A: the footer row (the mockup's `.foot`): a hairline above, the buttons on the right, edge to edge. */
  .foot {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 -0.8rem;
    padding: 9px 14px;
    border-top: 1px solid var(--tile-border);
  }
  .providers > .foot:last-child {
    margin-bottom: -0.65rem;
  }
  .foot-why {
    text-align: right;
  }
  .add,
  .adding {
    margin-top: 8px;
    padding: 9px 12px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* The pending Add sits after the list as the row of buttons does: its bottom 11px from the tile's edge. */
  .providers > :last-child:not(.list, .foot) {
    margin-bottom: calc(11px - 0.65rem);
  }
  .add label {
    display: block;
    font-size: 12px;
  }
  .add input:not([type="radio"]),
  .add select,
  .add textarea {
    font: inherit;
    font-size: 13px;
    width: 100%;
    margin-top: 4px;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
    color: inherit;
  }
  /* P-Add: the three choices as radio cards (the mockup's `.choice`): a title and one muted line; the chosen one's
   * border in the accent (≥ 3:1 on the tile in both themes, the focus ring's colour). */
  .choose {
    display: grid;
    gap: 8px;
  }
  .choose legend {
    float: none;
    width: auto;
    margin: 0 0 4px;
    padding: 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    color: var(--fg);
  }
  .card {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 9px 12px;
    border: 1px solid var(--tile-border);
    border-radius: 9px;
    background: var(--surface, var(--bg));
    cursor: pointer;
  }
  .card.on {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  /* Round 9 (L10): the card whose radio has the focus shows it — the focus ring's own 2px accent outline. */
  .card:focus-within {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .card input {
    margin: 2px 0 0;
    flex: none;
  }
  .card-words {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
  }
  .card-line {
    font-size: 12px;
    color: var(--muted);
  }
</style>
