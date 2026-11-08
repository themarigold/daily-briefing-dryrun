<script lang="ts">
  /**
   * Briefing redesign C (wave-2 plan C-M5-T13): the ask-first question before a Join on a host that is not one of the
   * four known services ("Open this link on {host}?", or "Open this {serviceName} link on {host}?"; hub item 3), as
   * text, with two buttons, "Yes" and "No" (proposed labels, checked in the screenshot pass). Presentation only: the
   * caller (`JoinButton.svelte`) decides what each does. The question takes focus when it appears, so a keyboard user
   * lands on it.
   */
  import ActionButton from "../ui/ActionButton.svelte";
  import { focusHeading } from "../ui/a11y";

  interface Props {
    question: string;
    onyes: () => void;
    onno: () => void;
  }
  let { question, onyes, onno }: Props = $props();
</script>

<div class="ask">
  <p class="question" tabindex="-1" use:focusHeading>{question}</p>
  <div class="buttons">
    <ActionButton kind="primary" onclick={onyes}>Yes</ActionButton>
    <ActionButton onclick={onno}>No</ActionButton>
  </div>
</div>

<style>
  .ask {
    margin-top: 0.5rem;
  }
  .question {
    margin: 0 0 0.4rem;
    overflow-wrap: anywhere;
  }
  .question:focus {
    outline: none;
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
  }
</style>
