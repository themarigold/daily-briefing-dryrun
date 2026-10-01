import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/vite-plugin-svelte').Config} */
export default {
  // vitePreprocess is what lets <script lang="ts"> compile; without it every typed component
  // fails at build time rather than at typecheck time, which is a slower way to learn the same
  // thing.
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Svelte 5 runes mode, explicitly rather than by inference: a component that happens to use
    // no runes would otherwise compile in legacy mode and silently accept Svelte 4 idioms.
    runes: true,
  },
};
