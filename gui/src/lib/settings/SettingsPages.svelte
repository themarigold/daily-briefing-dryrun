<script lang="ts">
  /**
   * Redesign D — the Settings page outlet: the sidebar (seven entries, a "More" divider before the last two, an
   * attention dot and an unsaved-changes dot per entry, each said once to a screen reader in hidden text; the tooltip
   * is the label only, final round 3) and every page, ALL MOUNTED, the inactive ones hidden — so
   * in-flight work on a page (the shim's state, the uninstall preview, the calendar's long flows, a typed Add)
   * survives switching away. Props only, so it can be server-rendered; the draft, the save path and every decision
   * stay in `routes/Settings.svelte`, which passes them through here.
   *
   * ⚠ Each page's wrapper is a bare `<div hidden>` that no rule styles with `display` (an author `display` would
   * override `[hidden]`). The sidebar's buttons carry `aria-current="page"` on the open page; below 720 px (the window
   * opens at 900 and may shrink to 560) they shrink to icons, the label kept as the accessible name and the tooltip.
   * They are plain buttons in the tab order (Tab, then Enter or Space), with app.css's shared `.ctl` focus ring.
   *
   * Final round 1: each page opens with its title, an `<h3>` that takes the focus when the user opens the page (M1:
   * the pressed control may vanish — the bar's "fix it on …" names the page just left — and focus would fall to
   * the body) and scrolls into view (L3). The entry's two marks differ in shape — a filled dot "needs a look", a
   * ring "unsaved changes" — and the hidden text says which (M3; the tooltip is the label only, final round 3).
   *
   * Final round 3: the one place a user action's result is brought into view — the shell's `reveal` request
   * (`settings/pages.ts`), acted on once per new number by `revealOn` on the content: the outcome area under the bar,
   * the open page's first marked field, or its title.
   */
  import { tick, type Snippet } from "svelte";
  import type { Action } from "svelte/action";
  import type { UninstallReport } from "../app-uninstall";
  import type { UpdateCheckResult } from "../engine";
  import type { EditorLinksLine, EditorLinksView } from "../actions-live";
  import type { EditorChoice } from "../app-prefs-store";
  import type { ConfigDocument } from "../files";
  import type { NotifyStatus } from "../notify";
  import type { Os } from "../platform";
  import type { AddHandlers, ReplaceHandlers } from "../provider-flows";
  import type { Draft, Field, ProvidersView } from "../settings-model";
  import type { SummaryStatus } from "../today";
  import AboutPage from "./AboutPage.svelte";
  import AdvancedPage from "./AdvancedPage.svelte";
  import CalendarPage from "./CalendarPage.svelte";
  import EditorLinksPage from "./EditorLinksPage.svelte";
  import GeneralPage from "./GeneralPage.svelte";
  import ProjectsPage from "./ProjectsPage.svelte";
  import ProvidersPage from "./ProvidersPage.svelte";
  import { focusHeading } from "../ui/a11y";
  import type { FormProps } from "./form-props";
  import {
    configState,
    keepClearScrolls,
    PAGES,
    revealStillWanted,
    revealTakesFocus,
    shownFocus,
    type ConfigState,
    type FocusAt,
    type PageId,
    type Reveal,
  } from "./pages";

  interface Props {
    /** The open page. */
    page: PageId;
    /** A sidebar entry was chosen (the shell runs `navigate`). */
    onpage: (page: PageId) => void;
    /** The pages with an attention dot (`attentionPages`) and with unsaved edits (`changedPages`). */
    attention: PageId[];
    changed: PageId[];
    /** The JSON editor is open while `tab === "raw"`; its text, bound both ways. */
    tab: "form" | "raw";
    raw: string;
    /** Final small fix (F2): a save is in flight, so the editor is read-only (the shell's `jsonEditorReadOnly`). */
    jsonReadOnly: boolean;
    onopenjson: () => void;
    /** The config's state (the shell's own). */
    loadFailure: string;
    doc: ConfigDocument | null;
    restored: boolean;
    settingsRemovedByUninstall: boolean;
    onreload: () => void;
    /** The form (`SettingsForm`'s props), handed to every page that draws config sections. */
    draft: Draft | null;
    errors: Record<string, string>;
    onfield: (field: Field, value: string) => void;
    onnotifycommand: (value: string) => void;
    ondefault: (field: Field, useDefault: boolean) => void;
    onremovekey: () => void;
    providers?: ProvidersView | undefined;
    providersMessage?: string | undefined;
    onprovidermove?: ((from: number, to: number) => void) | undefined;
    onproviderremove?: ((label: string) => void) | undefined;
    onproviderfolder?: ((label: string, dir: string) => void) | undefined;
    onprovidertest?: ((label: string, draftIndex: number) => void) | undefined;
    /** User-directed 2026-10-22 (P-A): Test all, each row's own Test in turn. */
    onprovidertestall?: (() => void) | undefined;
    /** Round 10 (M4): answers the reset's promise (its status refresh included), for the row's focus. */
    onproviderreset?: ((label: string, savedIndex: number) => void | Promise<unknown>) | undefined;
    onprovidermigrate?: ((label: string, savedIndex: number) => void) | undefined;
    onproviderremoveliteral?: ((label: string, savedIndex: number) => void) | undefined;
    provideradd?: AddHandlers | undefined;
    /** Round 10 (M1): row 1's "Other…" choice (the shell's `toolRows.other`); round 11 (M1): the note under a tool
     *  control whose value was refused (`toolRows.note`). */
    toolOther?: boolean | undefined;
    toolNote?: { id: string; text: string } | null | undefined;
    providerreplace?: ReplaceHandlers | undefined;
    /** A pending Add's network question (AI providers), and its answer, bound both ways. */
    networkAsk: boolean;
    networkYes: boolean;
    /** This app. */
    notify: NotifyStatus | null;
    notifyError: string;
    autostart: boolean | null;
    autostartError: string;
    onrefresh: () => void | Promise<void>;
    os: Os;
    /** Updates. */
    update: UpdateCheckResult | null;
    updateLoading: boolean;
    updateChecking: boolean;
    updateError: string;
    oncheck: () => void;
    /** Calendar. */
    onconfigchanged: () => void;
    onstatus: (ok: boolean) => void;
    /** Editor & links (P-M8): the driver's published state and its two actions, from the shell. */
    githubLinks?: boolean | undefined;
    linksBusy?: boolean | undefined;
    linksLine?: EditorLinksLine | null | undefined;
    onlinks?: ((on: boolean) => void) | undefined;
    editors?: EditorLinksView | undefined;
    choiceLines?: ReadonlyMap<string, EditorLinksLine> | undefined;
    onchoice?: ((project: string, choice: EditorChoice) => void) | undefined;
    /** About & uninstall. */
    version?: string | undefined;
    uninstallReport: UninstallReport | null;
    uninstallRunning: boolean;
    onuninstallstarted: () => void;
    onuninstallended: (report: UninstallReport | null) => void;
    /** General's reserved rows. */
    prefsRows?: Snippet | undefined;
    /** A2: the status General's line under the Briefing form reports. */
    aiSummaryStatus?: SummaryStatus | undefined;
    /** Drawn under the open page (the save bar and the outcome area). */
    footer?: Snippet | undefined;
    /** Per field id, how often the shell had it drawn again (H1, R3-M2; `settings/pages.ts` `Redraw`). */
    redraw: Record<string, number>;
    /** The user opened the page (M1): its title takes the focus. */
    focusTitle: boolean;
    /** Final round 3: where the result of the user's last action is shown (`revealOn`). */
    reveal: Reveal;
  }
  let {
    page,
    onpage,
    attention,
    changed,
    tab,
    raw = $bindable(),
    jsonReadOnly,
    onopenjson,
    loadFailure,
    doc,
    restored,
    settingsRemovedByUninstall,
    onreload,
    draft,
    errors,
    onfield,
    onnotifycommand,
    ondefault,
    onremovekey,
    providers,
    providersMessage,
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
    toolOther,
    toolNote,
    networkAsk,
    networkYes = $bindable(),
    notify,
    notifyError,
    autostart,
    autostartError,
    onrefresh,
    os,
    update,
    updateLoading,
    updateChecking,
    updateError,
    oncheck,
    onconfigchanged,
    onstatus,
    githubLinks = true,
    linksBusy = false,
    linksLine = null,
    onlinks = () => {},
    editors = { state: "idle" },
    choiceLines = new Map(),
    onchoice = () => {},
    version,
    uninstallReport,
    uninstallRunning,
    onuninstallstarted,
    onuninstallended,
    prefsRows,
    aiSummaryStatus = { enabled: false, warnings: [] },
    footer,
    redraw,
    focusTitle,
    reveal,
  }: Props = $props();

  /** Loaded and shown, still loading, or not loadable (General says why): the shell reads the same function. */
  const config: ConfigState = $derived(configState(loadFailure, doc, draft));
  const form: FormProps | null = $derived(
    draft === null
      ? null
      : {
          draft,
          errors,
          onfield,
          onnotifycommand,
          ondefault,
          onremovekey,
          providers,
          providersMessage,
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
          redraw,
          toolOther,
          toolNote,
        },
  );
  const shown = PAGES.filter((p) => !p.hidden);
  const label = (id: PageId): string => PAGES.find((p) => p.id === id)?.label ?? id;
  const lead = (id: PageId): string => {
    const p = PAGES.find((x) => x.id === id);
    return (os === "macos" ? undefined : p?.leadOffMacos) ?? p?.lead ?? "";
  };

  /** L3: when the user opens a page (the argument turns true), its title is scrolled into view, so the page starts at
   *  its top rather than at the last page's scroll position. (Step 0's `focusHeading` moves focus without scrolling.) */
  const toTop: Action<HTMLElement, boolean> = (node, active) => {
    let last = active;
    return {
      update(next: boolean) {
        if (next && !last) queueMicrotask(() => node.isConnected && node.scrollIntoView({ block: "nearest" }));
        last = next;
      },
    };
  };

  /** Final round 4 (R4-M5, R4-M6): a pointer press in progress (down, not yet up), and when the user last pressed,
   *  typed or scrolled (`performance.now()`). Read from the window, so a press that ends outside the content ends
   *  here too, and a key clears a press whose release was never seen. */
  let pressing = false;
  let lastInput = 0;
  const pressed = (): void => {
    pressing = true;
    lastInput = performance.now();
  };
  const released = (): void => {
    pressing = false;
  };
  const keyed = (): void => {
    pressing = false;
    lastInput = performance.now();
  };
  const scrolled = (): void => {
    lastInput = performance.now();
  };

  /** Final round 3 (R3-H1, measured): Chrome moves the focus to a control the keyboard reaches WITHOUT scrolling when
   *  part of it is already in the window, whatever its `scroll-margin`, so a control just above the window's bottom
   *  stayed under the save dock (up to fully hidden, 560x420). When a page's control takes the focus under the dock,
   *  it is scrolled into view, which keeps its `scroll-margin-bottom` (the dock's height) clear below it. Only
   *  inside a page: the dock's own buttons never scroll the page. `keepClearScrolls` decides (`settings/pages.ts`):
   *  only for a focus the browser shows (`shownFocus`), and never for one a pointer press gave (final round 4,
   *  R4-M5) — a press on a button half under the dock must not move it away before the release, or the press would
   *  not count as a click, and a press on a text field must not move it under the pointer, or a drag or a double
   *  click would select the wrong text. */
  function keepClear(e: FocusEvent): void {
    const el = e.target;
    if (!(el instanceof HTMLElement) || el.closest("[data-page]") === null) return;
    const dock = (e.currentTarget as HTMLElement).querySelector(".dock");
    if (dock === null) return;
    if (keepClearScrolls({ pointer: pressing, focusVisible: shownFocus(el), el: el.getBoundingClientRect(), dock: dock.getBoundingClientRect() }))
      el.scrollIntoView({ block: "nearest" });
  }

  /** Final round 3: acts on each NEW request number once (an identical second result too), never on the value it
   *  mounts with, after the flush that drew the result (a microtask: Svelte's flush is synchronous). */
  const revealOn: Action<HTMLElement, Reveal> = (node, first) => {
    let seen = first.seq;
    return {
      update(next: Reveal) {
        if (next.seq === seen) return;
        seen = next.seq;
        queueMicrotask(() => node.isConnected && show(node, next));
      },
    };
  };

  /** Where the focus is now, for `revealTakesFocus` (`settings/pages.ts`). */
  function focusAt(): FocusAt {
    const a = document.activeElement;
    if (a === null || a === document.body) return "nothing";
    if (a.matches(":disabled")) return "disabled";
    return a.closest(".dock") !== null ? "dock" : "elsewhere";
  }

  /** Brings `r`'s target into view (the targets: `settings/pages.ts` `Reveal`) — nothing at all for a flow's Save the
   *  user moved on from (`revealStillWanted`, final round 4). The outcome area takes the focus only when asked, or
   *  when the focus is on no control (the pressed button disabled while it ran, or gone); a refused Save whose marked
   *  field is not drawn falls to the page's title, which, like a Discard's, takes the focus (and the view) only from
   *  nothing, a disabled control or the dock (`revealTakesFocus`). A marked field is brought into view whole — its control
   *  and its error — and then its control focused (final small fix, F4: scrolling the error alone left the control
   *  above the window when the page was scrolled down). User-directed 2026-10-22 (P-A): a marked field inside a CLOSED
   *  row (AI providers' row 1 holds the first provider's fields) opens that row first — by its own head, so the row's
   *  open state stays the user's to change — and is brought into view once the row is drawn open. */
  function show(content: HTMLElement, r: Reveal): void {
    if (!revealStillWanted(r, lastInput)) return;
    if (r.target === "outcome") {
      const o = content.querySelector(".outcome");
      if (!(o instanceof HTMLElement)) return;
      o.scrollIntoView({ block: "nearest" });
      if (revealTakesFocus("outcome", r.focus, focusAt())) o.focus({ preventScroll: true });
      return;
    }
    const box = content.querySelector(`[data-page="${page}"]`);
    if (box === null) return;
    if (r.target === "field") {
      const field = box.querySelector(".field-error")?.closest(".field");
      const control = field?.querySelector('[id^="f-"]');
      if (field instanceof HTMLElement && control instanceof HTMLElement) {
        const closed = field.closest("[hidden][id]");
        const head = closed === null ? null : box.querySelector(`[aria-controls="${closed.id}"][aria-expanded="false"]`);
        if (head instanceof HTMLElement) {
          head.click();
          void tick().then(() => {
            field.scrollIntoView({ block: "nearest" });
            control.focus({ preventScroll: true });
          });
          return;
        }
        field.scrollIntoView({ block: "nearest" });
        control.focus({ preventScroll: true });
        return;
      }
    }
    const title = box.querySelector("h3.title");
    if (title instanceof HTMLElement && revealTakesFocus("title", r.focus, focusAt())) {
      title.focus({ preventScroll: true });
      title.scrollIntoView({ block: "nearest" });
    }
  }
</script>

<svelte:window onpointerdown={pressed} onpointerup={released} onpointercancel={released} onkeydown={keyed} onwheel={scrolled} />

<div class="layout">
  <div class="side">
  <nav class="sidebar" aria-label="Settings pages">
    {#each shown as p, i (p.id)}
      {#if p.more && !(shown[i - 1]?.more ?? false)}
        <p class="more">More</p>
      {/if}
      <button type="button" class="entry ctl" aria-current={page === p.id ? "page" : undefined} title={p.label} onclick={() => onpage(p.id)}>
        <!-- Part B: the S-A mockup's icons (its own paths, a 24-unit box): a gear, a folder, a sparkle, a calendar, the
             code brackets, three lines of falling length, an info circle. -->
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          {#if p.id === "general"}
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
          {:else if p.id === "projects"}
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          {:else if p.id === "providers"}
            <path d="M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z" />
          {:else if p.id === "calendar"}
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          {:else if p.id === "editor"}
            <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />
          {:else if p.id === "advanced"}
            <path d="M4 6h16M4 12h10M4 18h7" />
          {:else}
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v5M12 16h.01" />
          {/if}
        </svg>
        <span class="label">{p.label}</span>
        {#if attention.includes(p.id)}
          <span class="dot attention" aria-hidden="true"></span><span class="sr">(needs a look)</span>
        {/if}
        {#if changed.includes(p.id)}
          <span class="dot unsaved" aria-hidden="true"></span><span class="sr">(unsaved changes)</span>
        {/if}
      </button>
    {/each}
  </nav>
  </div>

  {#snippet title(id: PageId)}
    <h3 class="title" tabindex="-1" use:focusHeading={focusTitle && page === id} use:toTop={focusTitle && page === id}>{label(id)}</h3>
    {#if lead(id) !== ""}
      <p class="lead">{lead(id)}</p>
    {/if}
  {/snippet}

  <div class="content" onfocusin={keepClear} use:revealOn={reveal}>
    <div data-page="general" hidden={page !== "general"}>
      {@render title("general")}
      <GeneralPage
        {form}
        {tab}
        {config}
        {loadFailure}
        {doc}
        {restored}
        {settingsRemovedByUninstall}
        {onreload}
        {notify}
        {notifyError}
        {autostart}
        {autostartError}
        {onrefresh}
        {os}
        result={update}
        loading={updateLoading}
        checking={updateChecking}
        error={updateError}
        {oncheck}
        {prefsRows}
        {onconfigchanged}
        {aiSummaryStatus}
      />
    </div>
    <div data-page="projects" hidden={page !== "projects"}>
      {@render title("projects")}
      <ProjectsPage {form} {tab} {config} />
    </div>
    <div data-page="providers" hidden={page !== "providers"}>
      {@render title("providers")}
      <ProvidersPage {form} {tab} {config} {networkAsk} bind:networkYes />
    </div>
    <div data-page="calendar" hidden={page !== "calendar"}>
      {@render title("calendar")}
      <CalendarPage {os} {onconfigchanged} {onstatus} />
    </div>
    <div data-page="editor" hidden={page !== "editor"}>
      {@render title("editor")}
      <EditorLinksPage {os} {githubLinks} {linksBusy} {linksLine} {onlinks} {editors} {choiceLines} {onchoice} />
    </div>
    <div data-page="advanced" hidden={page !== "advanced"}>
      {@render title("advanced")}
      <AdvancedPage {form} {tab} {config} bind:raw readOnly={jsonReadOnly} {onopenjson} apiKeyRedacted={doc?.apiKeyRedacted === true} {os} />
    </div>
    <div data-page="about" hidden={page !== "about"}>
      {@render title("about")}
      <AboutPage
        {version}
        path={doc?.path ?? null}
        {onrefresh}
        {uninstallReport}
        {uninstallRunning}
        {onuninstallstarted}
        {onuninstallended}
      />
    </div>
    {@render footer?.()}
  </div>
</div>

<style>
  /* Part B (user-directed 2026-10-21): the approved S-A mockup's look. The panel, the selected entry and the content
   * surface have no Step 0 token, so they are this component's own custom properties, light and dark (the mockup's
   * values); everything else is Step 0's tokens. The whole screen is a rounded box in the app's content column: the
   * tinted side panel on the left, the content on the surface colour, its groups the white tiles. `overflow: clip`
   * rounds the corners without making a scroll box, so the sidebar and the save dock still stick to the window. */
  .layout {
    --side: #efebe5;
    --sel: #e2ddd5;
    --surface: #f7f5f1;
    display: flex;
    align-items: stretch;
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: clip;
    background: var(--surface);
    font-size: 13px;
    /* The mockup's rows, entries and buttons are 27-30px tall at 12.5-13px. */
    line-height: 1.25;
  }
  .side {
    flex: 0 0 200px;
    background: var(--side);
    border-right: 1px solid var(--line);
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 12px 8px;
    position: sticky;
    top: 0;
  }
  /* `--gutter` is the content's side padding; the save dock (SaveBar) bleeds across it, edge to edge. */
  .content {
    --gutter: 28px;
    flex: 1 1 auto;
    min-width: 0;
    padding: 22px var(--gutter) 0;
    background: var(--surface);
  }
  /* V7: each page ends the mockup's ~58px above the box (its last group's 14px and this), on the page and not the
   * content's padding, which would put a gap under the pinned bar. */
  [data-page] {
    padding-bottom: 44px;
  }
  /* Final round 3 (R3-H1): a page's control (or a marked field, which a refused Save brings into view: final small fix,
   * F4) that the browser scrolls into view keeps the save dock's height clear below it (`--dock-clear`, set by SaveBar
   * from the dock's parts; 64px, the plain bar's, wherever nothing sets it). On the controls, not the document, so the
   * bar's own buttons — outside every page — never scroll the page when they take the focus. */
  [data-page] :global(:is(input, select, textarea, button, .field, .field-error)) {
    scroll-margin-bottom: var(--dock-clear, 64px);
  }
  .more {
    margin: 0;
    padding: 10px 10px 4px;
    font-size: 10.5px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .entry {
    display: flex;
    align-items: center;
    gap: 9px;
    font: inherit;
    font-size: 13px;
    text-align: left;
    padding: 7px 10px;
    border-radius: 7px;
    border: 0;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }
  .entry[aria-current="page"] {
    background: var(--sel);
    font-weight: 600;
  }
  .icon {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
    color: var(--muted);
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
  }
  .label {
    flex: 1 1 auto;
  }
  /* M3: told apart by shape, not only colour: "needs a look" is the mockup's filled amber dot, "unsaved changes" a
   * ring. Each is ≥ 3:1 against the side panel in both themes (settings-pages.check.ts computes it from the tokens). */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .dot.attention {
    background: var(--tag-local);
  }
  .dot.unsaved {
    background: transparent;
    border: 1.5px solid var(--accent);
  }
  .title {
    margin: 0 0 2px;
    font-size: 20px;
    letter-spacing: -0.01em;
  }
  .lead {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--muted);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @media (max-width: 720px) {
    .side {
      flex-basis: auto;
    }
    .label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .more {
      font-size: 0;
      padding: 0;
      margin: 6px 4px;
      border-top: 1px solid var(--line);
    }
    .content {
      --gutter: 16px;
      padding-top: 18px;
    }
  }
  @media (prefers-color-scheme: dark) {
    .layout {
      --side: #1b1820;
      --sel: #2b2731;
      --surface: #17151a;
    }
  }
</style>
