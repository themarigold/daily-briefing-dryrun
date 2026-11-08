/**
 * Redesign D: what every Settings page hands its `SettingsForm` (the draft, its errors and the shell's handlers),
 * bundled once by `SettingsPages` so the four pages that draw config sections (General, Projects, AI providers,
 * Advanced) need not each forward seventeen props. Each page adds its own `sections`.
 */
import type { ComponentProps } from "svelte";
import type SettingsForm from "../../routes/SettingsForm.svelte";

export type FormProps = Omit<ComponentProps<typeof SettingsForm>, "sections" | "networkAsk" | "networkYes">;
