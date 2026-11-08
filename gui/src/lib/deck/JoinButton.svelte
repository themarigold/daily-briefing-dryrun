<script lang="ts">
  /** Join by handle: the pure model binds Yes to the question's handle and drops obsolete replies. */
  import { getContext, onDestroy, untrack } from "svelte";
  import { dismissJoin, idleJoin, joinClick, joinHandle, joinReply, type JoinCall } from "../calendar-detail";
  import { CALENDAR_STALE, type CalendarStale } from "../calendar-live";
  import { calendarJoin, type CalendarJoinReply } from "../engine";
  import AskFirst from "./AskFirst.svelte";

  interface Props { handle: string; label: string }
  let { handle, label }: Props = $props();
  const stale = getContext<CalendarStale | undefined>(CALENDAR_STALE);
  let model = $state(untrack(() => idleJoin(handle)));
  let button: HTMLButtonElement | undefined;
  let closed = false;
  const current = $derived(joinHandle(model, handle));
  $effect(() => {
    const h = handle;
    untrack(() => (model = joinHandle(model, h)));
  });
  onDestroy(() => { closed = true; model = idleJoin(handle); });

  async function send(call: JoinCall): Promise<void> {
    let reply: CalendarJoinReply | null;
    try { reply = await calendarJoin(call.handle, call.confirmed); }
    catch { reply = null; }
    if (closed) return;
    const result = joinReply(joinHandle(model, handle), call, reply);
    model = result.model;
    if (result.stale) stale?.onStale();
  }
  function join(yes = false): void {
    const result = joinClick(joinHandle(model, handle), yes);
    model = result.model;
    if (result.call !== null) void send(result.call);
    if (yes) focusJoin();
  }
  function focusJoin(): void {
    queueMicrotask(() => { if (button?.isConnected) button.focus({ preventScroll: true }); });
  }
  function dismiss(): void { model = dismissJoin(current); focusJoin(); }
  function onkeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && current.state.kind === "asking") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  }
</script>

<!-- aria-disabled keeps Join focusable while the confirmed call is outstanding; the model gates repeat clicks. -->
<div class="join-flow" onkeydown={onkeydown} role="presentation">
  <button type="button" class="ctl join-button" aria-disabled={current.busy} bind:this={button} onclick={() => join()}>{label}</button>
  {#if current.state.kind === "asking"}
    <AskFirst question={current.state.question} onyes={() => join(true)} onno={dismiss} />
  {:else if current.state.kind === "failed"}
    <p class="reply">{current.state.line}</p>
  {/if}
</div>

<style>
  .join-button { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  .join-button[aria-disabled="true"] { opacity: 0.55; cursor: default; }
  .reply { margin: 0.5rem 0 0; overflow-wrap: anywhere; }
</style>
