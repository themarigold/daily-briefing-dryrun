<script lang="ts">
  /**
   * "Something else owns the background schedule" — KEEP-EXISTING first, take-over second.
   *
   * ⚠ ITS OWN COMPONENT SO THE ORDER IS TESTABLE. `gui/tests-web/render.check.ts` renders it and
   * asserts that the default (primary, first) choice leaves the existing schedule alone and that
   * taking over is the second, explicit one — never replace a configuration the user set up
   * deliberately.
   *
   * ⚠ `message` IS THE ENGINE'S STDERR, VERBATIM, and it names paths — text, never markup.
   */
  interface Props {
    message: string;
    /** What the take-over does, in the button: "install the background scheduler", … */
    purpose: string;
    onkeep: () => void;
    ontakeover: () => void;
  }
  let { message, purpose, onkeep, ontakeover }: Props = $props();
</script>

<div class="dialog" role="group" aria-label="Another scheduler owns this trigger">
  <p class="lead">Something else already owns the background schedule.</p>
  {#if message !== ""}
    <pre>{message}</pre>
  {/if}
  <p>
    You can leave it exactly as it is — Daily Briefing will read it and show you what it does, and
    will not change it. Or you can take the schedule over, which replaces whoever set it up.
  </p>
  <div class="row">
    <button class="primary" onclick={onkeep}>Keep the existing one</button>
    <button class="danger" onclick={ontakeover}>Take over and {purpose}</button>
  </div>
</div>

<style>
  .dialog {
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.8rem 1rem;
    background: var(--panel);
    max-width: 38rem;
  }
  .lead {
    margin: 0 0 0.5rem;
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-top: 0.6rem;
  }
  pre {
    margin: 0.4rem 0;
    padding: 0.5rem 0.7rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    overflow-x: auto;
    font-size: 0.78rem;
    white-space: pre-wrap;
  }
  button {
    font: inherit;
    padding: 0.45rem 0.9rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: var(--panel);
    color: inherit;
    cursor: pointer;
  }
  button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: transparent;
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
