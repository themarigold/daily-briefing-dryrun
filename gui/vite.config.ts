import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The app is a LOCAL-FIRST desktop shell: the production build is loaded from `dist/` by the
// Tauri webview over the `tauri://` custom protocol, never over http. Nothing here may introduce
// a remote origin — the CSP in src-tauri/tauri.conf.json refuses one, and this config is the
// other half of that promise (no CDN externals, no remote base, assets emitted relative).
export default defineConfig({
  plugins: [svelte()],

  // Tauri reads `build.devUrl` from tauri.conf.json and expects the dev server here. strictPort
  // makes a port collision a loud failure rather than a silent move to 1421 that the shell then
  // cannot find.
  server: {
    port: 1420,
    strictPort: true,
  },

  // Relative asset URLs: the webview serves the bundle from a custom protocol root, so absolute
  // "/assets/..." paths resolve against the wrong origin.
  base: "./",

  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Tauri 2 targets modern WebKit/WebView2 only; there is no legacy browser to down-level for.
    target: "es2022",
    // A debug-profile Tauri build still wants readable frames.
    sourcemap: true,
  },

  // Only variables the desktop shell deliberately exposes. Vite's default `VITE_` prefix plus
  // Tauri's own, so `import.meta.env` cannot accidentally leak the build machine's environment.
  envPrefix: ["VITE_", "TAURI_ENV_", "TAURI_PLATFORM"],
});
