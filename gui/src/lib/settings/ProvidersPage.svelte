<script lang="ts">
  /**
   * Redesign D — Settings → AI providers: the two provider sections, which draw "Providers, in order"
   * (`ProvidersList`), the stored-key notice and the note on switching kinds (`SettingsForm` draws those only with a
   * provider section). A pending Add's network question goes into the list's Add, beside its Save (`networkAsk`,
   * bound both ways from the shell).
   */
  import SettingsForm from "../../routes/SettingsForm.svelte";
  import ConfigGate from "./ConfigGate.svelte";
  import type { FormProps } from "./form-props";
  import type { ConfigState } from "./pages";

  interface Props {
    form: FormProps | null;
    tab: "form" | "raw";
    config: ConfigState;
    /** A pending Add's network-check question is on screen (`askNetworkAdd`). */
    networkAsk: boolean;
    /** Its answer, bound both ways. */
    networkYes: boolean;
  }
  let { form, tab, config, networkAsk, networkYes = $bindable() }: Props = $props();
</script>

<ConfigGate {config} {tab} pointer={true} editorHere={false}>
  {#if form !== null}
    <SettingsForm {...form} sections={["Provider (command-line tool)", "Provider (API)"]} {networkAsk} bind:networkYes />
  {/if}
</ConfigGate>
