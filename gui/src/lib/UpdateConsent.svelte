<script lang="ts">
  /**
   * Phase E (E12) — the first-run wizard's update-check consent step. Presentation only: the answer
   * is a field of the wizard's DRAFT (`lib/wizard.ts`, `updateCheck`), written to the config once, at
   * the wizard's one save — so answering here sends nothing and starts nothing.
   *
   * ⚠ "NO" IS THE DEFAULT (`emptyDraft().updateCheck === false`) and is listed first. The copy is
   * `CONSENT_PARAGRAPHS` (`lib/update-check.ts`), which says exactly what the engine's request
   * carries; this file adds no wording of its own about it.
   */
  import { CONSENT_NO, CONSENT_PARAGRAPHS, CONSENT_YES } from "./update-check";

  interface Props {
    /** The draft's answer: `false` = no (the default), `true` = yes. */
    value: boolean;
    onchange: (value: boolean) => void;
  }
  let { value, onchange }: Props = $props();
</script>

<div class="consent">
  {#each CONSENT_PARAGRAPHS as paragraph (paragraph)}
    <p>{paragraph}</p>
  {/each}
  <label class="choice">
    <input type="radio" name="update-check" value="no" checked={!value} onchange={() => onchange(false)} />
    <span>{CONSENT_NO}</span>
  </label>
  <label class="choice">
    <input type="radio" name="update-check" value="yes" checked={value} onchange={() => onchange(true)} />
    <span>{CONSENT_YES}</span>
  </label>
</div>

<style>
  .consent {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  p {
    margin: 0;
  }
  .choice {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
  }
  .choice input {
    margin-top: 0.25rem;
  }
</style>
