<script lang="ts">
  /**
   * T12 — the Today screen: the latest briefing, its freshness, and Run Now.
   *
   * This file only GATHERS: it reads `briefing-latest.md` through `read_latest_briefing` and hands
   * everything to `lib/today.ts`'s `todayModel`, which decides what is shown, and to
   * `TodayView.svelte`, which draws it.
   *
   * ⚠ ONE FILE READ PER CHANGE, NOT PER EVENT. Every `state:changed` re-renders this screen, but the
   * file is re-read only when `status --json`'s `latestBriefingMtime` or the app's own last run
   * changed (each read is one `status --json` spawn in Rust). A slow answer that arrives after a
   * newer one is dropped.
   */
  import { onMount } from "svelte";
  import { describeFailure, readLatestBriefing } from "../lib/files";
  import type { Snapshot } from "../lib/state";
  import {
    latestMtime,
    localDate,
    todayModel,
    type LatestLoad,
    type RunEnvelope,
  } from "../lib/today";
  import TodayView from "./TodayView.svelte";

  interface Props {
    snapshot: Snapshot | null;
    /** The envelope of the last run THIS app started, if any (App.svelte keeps it). */
    lastRun: RunEnvelope | null;
    running: boolean;
    progress: string[];
    runResult: string;
    onrun: () => void;
  }
  let { snapshot, lastRun, running, progress, runResult, onrun }: Props = $props();

  let latest = $state<LatestLoad>({ state: "loading" });
  let seq = 0;
  // What the current read was for. Plain variables, not state: they gate reads, they are not shown.
  let mounted = false;
  let readForMtime: string | null = null;
  let readForRun: RunEnvelope | null = null;

  async function load(): Promise<void> {
    const mine = ++seq;
    try {
      const file = await readLatestBriefing();
      if (mine !== seq) return;
      latest = file === null ? { state: "none" } : { state: "loaded", file };
    } catch (e) {
      if (mine !== seq) return;
      latest = { state: "error", message: describeFailure(e) };
    }
  }

  onMount(() => {
    mounted = true;
    readForMtime = latestMtime(snapshot);
    readForRun = lastRun;
    void load();
  });

  $effect(() => {
    const mtime = latestMtime(snapshot);
    const run = lastRun;
    if (!mounted || (mtime === readForMtime && run === readForRun)) return;
    readForMtime = mtime;
    readForRun = run;
    void load();
  });

  const model = $derived(
    todayModel({ snapshot, latest, lastRun, today: localDate(new Date()) }),
  );
</script>

<TodayView {model} {running} {progress} {runResult} {onrun} />
