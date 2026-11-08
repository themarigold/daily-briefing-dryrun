<script lang="ts">
  /**
   * Redesign D — Settings → About & uninstall: the app's version (a prop: the shell passes the build's `define`,
   * which does not exist under the test loader, so this never reads it itself), the settings file's path as text
   * (no reveal: gui-seam deviations 40/82), and Uninstall with its full flow (`UninstallPanel`).
   *
   * Part B (the S-A mockup): the version is the page's lead line, "Daily Briefing <version>", under the title
   * SettingsPages draws; the path is its own group, "Settings file".
   */
  import type { UninstallReport } from "../app-uninstall";
  import Tile from "../ui/Tile.svelte";
  import UninstallPanel from "./UninstallPanel.svelte";

  interface Props {
    version?: string | undefined;
    /** The config file's path (`status --json`'s `paths.configPath`), or `null` before it is known. */
    path: string | null;
    onrefresh: () => void | Promise<void>;
    uninstallReport: UninstallReport | null;
    uninstallRunning: boolean;
    onuninstallstarted: () => void;
    onuninstallended: (report: UninstallReport | null) => void;
  }
  let {
    version,
    path,
    onrefresh,
    uninstallReport,
    uninstallRunning,
    onuninstallstarted,
    onuninstallended,
  }: Props = $props();
</script>

{#if version !== undefined}
  <p class="lead">Daily Briefing {version}</p>
{/if}
{#if path !== null}
  <!-- Final round 1 (M5): the group has a heading of its own, under the page's title. -->
  <div class="group">
    <Tile>
      <h4>Settings file</h4>
      <p class="path"><code>{path}</code></p>
    </Tile>
  </div>
{/if}
<UninstallPanel {onrefresh} {uninstallReport} {uninstallRunning} {onuninstallstarted} {onuninstallended} />

<style>
  .lead {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--muted);
  }
  .group {
    margin: 0 0 14px;
  }
  /* Final round 3 (V12): a headerless group's row, as the mockup's "Settings file": the group's name is the row's
   * label (13px, 600; still its <h4>), the path under it, 11px 14px from the tile's edge (Step 0's Tile pads its
   * content 0.65rem 0.8rem). */
  h4 {
    margin: calc(11px - 0.65rem) 0 2px;
    padding: 0 calc(14px - 0.8rem);
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  .path {
    margin: 0 0 calc(11px - 0.65rem);
    padding: 0 calc(14px - 0.8rem);
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
</style>
