<script lang="ts">
  /** Redesign D — Settings → Projects: the repositories and your git author names and emails. */
  import SettingsForm from "../../routes/SettingsForm.svelte";
  import ConfigGate from "./ConfigGate.svelte";
  import type { FormProps } from "./form-props";
  import type { ConfigState } from "./pages";

  interface Props {
    form: FormProps | null;
    tab: "form" | "raw";
    config: ConfigState;
  }
  let { form, tab, config }: Props = $props();
</script>

<ConfigGate {config} {tab} pointer={true} editorHere={false}>
  {#if form !== null}
    <SettingsForm {...form} sections={["Repositories", "You"]} />
  {/if}
</ConfigGate>
