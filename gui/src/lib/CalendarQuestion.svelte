<script lang="ts">
  /**
   * The calendar question (wave-2 polish spec §4; plan PB-M6-T2): ONE component draws the question, its explanation,
   * its buttons, the busy line and the result, for Today's card (`origin="today"`) and the wizard's step
   * (`origin="wizard"`, PB-M7). Its words are `calendar-question.ts`'s; every decision is a pure helper there
   * (`cardView`, `focusAfter`, `answeredKind`, `refusalAfter`, `linkSessionStep`); the flows are the Today store's.
   *
   * - The store is read at once (a server render runs no `onMount`), then re-read and followed while mounted.
   * - A press that starts a flow sends the focus to the busy line (the pressed button disables, and WebKit drops its
   *   focus); its end sends it where `focusAfter` says, found inside this card. `onanswered` is called once per settled
   *   answer — also after this card unmounted (the wizard latches it); the focus is skipped then.
   * - The busy refusal and the Link session are THIS MOUNT's state, never store fields. The Link path keeps the question
   *   and draws Settings' own panel in place of the buttons, in its wizard mode, link only, adding at once — never
   *   `locked` — with the card's own way out below it (`LINK_BACK_BUTTON`, PB r1 X1: the panel cannot draw its Done or
   *   Cancel over a config it cannot read) — hidden while the panel offers "Remove that saved link", waiting while the
   *   panel's own write runs (`linkBackButton`, from its `onpanelstate`; PB final LOW L1/L2). `onsession(true)` when the session opens; `onsession(false)` once, when it
   *   ends (after the closing flow has started) or when the card unmounts while it is open (no flow, no answer then).
   * - Per mount too (PB r1 X10, X11): `ownPress`, whether this card's press started the running flow with the gate open
   *   (the question then stays through it); `pressPath`, the path "Show my calendar" took, sent with each answer.
   * - The wizard's step unmounting (Continue, skip, a route change) drops a wizard result and its held write
   *   (`leaveWizard`; a wizard flow still running drops both when it settles).
   *
   * Every dynamic string is `{}`-interpolated text.
   */
  import { onMount, tick } from "svelte";
  import CalendarSettings from "./CalendarSettings.svelte";
  import { calendarConfigSave } from "./calendar";
  import type { CalendarStatusJson } from "./calendar-contract";
  import { LINK_PANEL_IDLE, type LinkPanelState } from "./calendar-settings";
  import {
    answeredKind,
    BUSY_REFUSAL_LINE,
    cardView,
    CLOSE_BUTTON,
    explanationFor,
    FOCUS_ON_START,
    focusAfter,
    LINK_BACK_BUTTON,
    LINK_CLOSED,
    linkBackButton,
    linkSessionStep,
    NOT_NOW_BUTTON,
    pathOf,
    QUESTION,
    refusalAfter,
    SHOW_BUTTON,
    TRY_AGAIN_BUTTON,
    type FocusTarget,
    type LinkEvent,
    type LinkSession,
    type StartingState,
  } from "./calendar-question";
  import { calendarConnectMac, calendarStatus } from "./engine";
  import { configRead } from "./files";
  import type { Os } from "./platform";
  import { close, closeLinkSession, leaveWizard, notNow, onTodayStore, startShow, todayStore, tryAgain, type FlowEnd, type FlowIo } from "./today-store";

  interface Props {
    origin: "today" | "wizard";
    os: Os;
    /** The stored status reply, for the explanation (the path "Show my calendar" takes); none drawn without one. */
    status: CalendarStatusJson | null;
    /** The caller's question gate (Today: `todayCard`; the wizard: its entry decision). Default: asked. */
    ask?: boolean;
    /** A settled answer: turned on, written off, or Not now (a retry's too), with the path the press behind it took
     *  (`null` for Not now) — the wizard tells a grant from it (`wizardAnswer`). */
    onanswered?: ((kind: "on" | "off" | "notNow", path: StartingState | null) => void) | undefined;
    /** The local link session opened (`true`) or ended (`false`). */
    onsession?: ((open: boolean) => void) | undefined;
    /** Today's Close, after the result is cleared: Today hides the card for this visit and lands the focus. */
    onclose?: (() => void) | undefined;
  }
  let { origin, os, status, ask = true, onanswered, onsession, onclose }: Props = $props();
  const uid = $props.id();

  /** The engine calls a flow makes (the store's `io`). */
  const io: FlowIo = { status: () => calendarStatus(), connectMac: () => calendarConnectMac(), readConfig: configRead, saveBlock: calendarConfigSave };

  let store = $state.raw(todayStore());
  let refusal = $state(false);
  let session = $state<LinkSession>(LINK_CLOSED);
  let ownPress = $state(false);
  let pressPath: StartingState | null = null;
  let rootEl = $state<HTMLElement | undefined>(undefined);
  let destroyed = false;

  const view = $derived(cardView({ origin, ask, ownPress, running: store.flow.running, writesInFlight: store.writesInFlight, result: store.flow.result, linkSession: session.open, refusal }));
  /** PB final LOW L1/L2 — the embedded panel's own write and its leftover offer (per mount, from its `onpanelstate`;
   *  idle again when the session ends), and the way out they decide. */
  let panel = $state.raw<LinkPanelState>(LINK_PANEL_IDLE);
  const back = $derived(linkBackButton(view.disabled, panel));

  onMount(() => {
    store = todayStore();
    const off = onTodayStore((next) => (store = next));
    return () => {
      off();
      destroyed = true;
      sessionEvent({ kind: "destroy" });
      if (origin === "wizard") leaveWizard();
    };
  });

  /** The focus target, inside this card, once the change is drawn. */
  async function focusOn(target: FocusTarget): Promise<void> {
    await tick();
    if (destroyed) return;
    rootEl?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus();
  }

  /** A press whose flow started (set synchronously by the store): the busy line takes the focus. */
  function started(): void {
    if (todayStore().flow.running?.origin === origin) void focusOn(FOCUS_ON_START);
  }

  /** A flow (or a press that started none) ended. */
  function ended(end: FlowEnd): void {
    ownPress = false;
    const kind = answeredKind(end);
    if (kind !== null) onanswered?.(kind, pressPath);
    if (end === "link") return sessionEvent({ kind: "open" });
    refusal = refusalAfter(refusal, end);
    const target = focusAfter(origin, end);
    if (target !== null && !destroyed) void focusOn(target);
  }

  function show(): void {
    refusal = refusalAfter(refusal, "press");
    pressPath = pathOf(todayStore().status);
    ownPress = ask;
    const run = startShow(origin, io);
    started();
    void run.then(ended);
  }

  function notNowPress(): void {
    refusal = refusalAfter(refusal, "press");
    pressPath = null;
    ownPress = ask;
    const run = notNow(origin, io);
    started();
    void run.then(ended);
  }

  function retry(): void {
    ownPress = ask;
    const run = tryAgain(io);
    started();
    void run.then(ended);
  }

  /** The link session's one transition: the closing flow starts (synchronously) before `onsession(false)` is sent. */
  function sessionEvent(e: LinkEvent): void {
    const r = linkSessionStep(session, e);
    session = r.next;
    if (!session.open) panel = LINK_PANEL_IDLE;
    const closing = r.closeFlow ? closeLinkSession(origin, io) : null;
    if (r.notify !== null) onsession?.(r.notify);
    if (closing !== null) void closing.then(ended);
  }

  /** The card's own way out of the link session (PB r1 X1): as "Done" / "Cancel" with nothing left over. */
  function leaveLinkSession(): void {
    sessionEvent({ kind: "addClosed", leftover: false });
  }

  function closeCard(): void {
    close();
    onclose?.();
  }
</script>

<section class="card" aria-label="Your calendar" bind:this={rootEl}>
  {#if view.result !== null}
    {@const r = view.result}
    <p class="line" class:bad={r.pendingWrite !== null} id="{uid}-line" tabindex="-1" data-focus="resultLine">{r.line}</p>
    <div class="row">
      {#if r.pendingWrite !== null}
        <button type="button" class="ctl action" disabled={view.disabled} aria-describedby="{uid}-line" onclick={retry}>{TRY_AGAIN_BUTTON}</button>
      {/if}
      {#if origin === "today"}
        <button type="button" class="ctl action" data-focus="close" disabled={view.closeDisabled} aria-describedby={r.pendingWrite !== null ? `${uid}-line` : undefined} onclick={closeCard}>{CLOSE_BUTTON}</button>
      {/if}
    </div>
  {/if}
  {#if view.link}
    <p class="q" id="{uid}-q">{QUESTION}</p>
    <CalendarSettings mode="wizard" {os} linkOnly startAdding onaddclosed={({ leftover }) => sessionEvent({ kind: "addClosed", leftover })} onleftovercleared={() => sessionEvent({ kind: "leftoverCleared" })} onpanelstate={(p) => (panel = p)} />
    {#if back.shown}
      <div class="row">
        <button type="button" class="ctl action" disabled={back.disabled} onclick={leaveLinkSession}>{LINK_BACK_BUTTON}</button>
      </div>
    {/if}
  {:else if view.question}
    <div class="ask" role="group" aria-labelledby="{uid}-q" aria-describedby={status !== null ? `${uid}-why` : undefined}>
      <p class="q" id="{uid}-q">{QUESTION}</p>
      {#if status !== null}
        <p class="why" id="{uid}-why">{explanationFor(status)}</p>
      {/if}
      <div class="row">
        <button type="button" class="ctl action primary" data-focus="show" disabled={view.disabled} aria-describedby={view.refusal ? `${uid}-refusal` : undefined} onclick={show}>{SHOW_BUTTON}</button>
        <button type="button" class="ctl action" disabled={view.disabled} onclick={notNowPress}>{NOT_NOW_BUTTON}</button>
      </div>
    </div>
    {#if view.refusal}
      <p class="refusal" id="{uid}-refusal">{BUSY_REFUSAL_LINE}</p>
    {/if}
  {/if}
  {#if view.busyLine !== null}
    <p class="busy" tabindex="-1" data-focus="busyLine">{view.busyLine}</p>
  {/if}
</section>

<style>
  /* A compact card above the deck (spec §4 "Layout"): it never grows into the deck's space, which shrinks instead
     (Deck's own min-height and scroll apply at the 560×420 minimum). */
  .card {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0 0 0.75rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--tile-border);
    border-radius: 0.5rem;
    background: var(--tile);
  }
  /* The question, then its explanation (a smaller line that wraps), then the two buttons on their own row below it,
     left-aligned, "Show my calendar" first (user-directed 2026-10-31, "Option 1": the buttons had sat on the question's
     row as small chips, and a click-through missed "Not now"). The explanation sits inside the group it describes. */
  .ask {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
  }
  .q {
    font-weight: 600;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  /* Every button in the card, full size in ActionButton's look (lib/ui/ActionButton.svelte `.action`, `.primary`;
     user-directed 2026-10-31). Native buttons, not ActionButton, because they carry `data-focus` and
     `aria-describedby`, which its explicit props do not take. The focus ring and the disabled look are app.css's
     `.ctl` (`.ctl.ctl:disabled` outranks these one-class rules, so Show's fill never survives under muted text); no
     rule here restyles `:focus-visible` or `:disabled`. "Show my calendar" alone is primary. */
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
  p {
    margin: 0;
  }
  .why,
  .busy {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .refusal,
  .line.bad {
    color: var(--danger);
  }
  /* Focus targets by script only, as the slides' headings are: no ring. */
  .line:focus,
  .busy:focus {
    outline: none;
  }
</style>
