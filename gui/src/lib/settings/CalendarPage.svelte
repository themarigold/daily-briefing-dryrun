<script lang="ts">
  /** Redesign D — Settings → Calendar: today's `CalendarSettings`; it reports its status outward (`onstatus`) for the
   *  sidebar's attention dot. Its own writes; the shell reloads after them. User-directed 2026-10-22: the panel draws
   *  its own two groups (the master switch's box and Connections), each a `Tile`, so this page adds no box of its own.
   *
   *  PB-M6 (wave-2 polish spec §4 "Flows"): while a calendar-question flow runs (from Today or the wizard) the panel is
   *  `locked` — its writing controls wait and its busy line shows; when the flow clears (`refreshAfterFlow`) the panel
   *  reloads its block (its `refresh()`), so it never edits from a view that predates the flow's writes. A Settings write
   *  of its own never locks it. The running flow is read now (a server render runs no `onMount`), then followed. */
  import { onMount } from "svelte";
  import type { Os } from "../platform";
  import CalendarSettings from "../CalendarSettings.svelte";
  import { refreshAfterFlow } from "../calendar-question";
  import { onTodayStore, todayStore } from "../today-store";

  interface Props {
    os: Os;
    onconfigchanged: () => void;
    onstatus: (ok: boolean) => void;
  }
  let { os, onconfigchanged, onstatus }: Props = $props();

  let running = $state(todayStore().flow.running);
  let panel = $state<ReturnType<typeof CalendarSettings> | undefined>(undefined);
  onMount(() =>
    onTodayStore((s) => {
      const was = running;
      running = s.flow.running;
      if (refreshAfterFlow(was, running)) void panel?.refresh();
    }),
  );
</script>

<!-- Final round 3 (V13): the group's 14px below it, as every page's last group. -->
<div class="group">
  <CalendarSettings bind:this={panel} {os} {onconfigchanged} {onstatus} locked={running !== null} />
</div>

<style>
  .group {
    margin: 0 0 14px;
  }
</style>
