<script lang="ts">
  /**
   * T13 — the History screen: the engine's dated archive, newest first, one briefing at a time.
   *
   * ⚠ NO PRUNE, NO DELETE, NO "CLEAN UP" — ANYWHERE, EVER. `briefings/` is the engine's calibration
   * corpus and its retention is deliberately unbounded (`src/marker.ts`, `archivedBriefingPath`:
   * "~8 KB/day ≈ 3 MB/year … pruning it defeats the entire purpose"). Deleting it destroys the one
   * record the engine's thresholds are calibrated against, and it cannot be rebuilt. The read
   * command behind this screen cannot write (`src-tauri/src/briefing_files.rs`), no command that can
   * delete a briefing exists, and the screen says so in words.
   *
   * ⚠ THE DATES ARE THE ENGINE'S (`status --json` → `archivedDates`); the file is fetched by DATE and
   * rendered through the escape-first renderer — the one HTML-shaped path in the app, over the least
   * controlled input, which is why it produces text nodes only.
   *
   * No "reveal in file manager" action (docs/gui-seam.md §10 deviation 40, upheld by B6's
   * deviation 82). Since B6 `tauri-plugin-opener` IS a dependency — Rust-side free functions
   * only, never registered, no webview grant (`tests/capability.rs` pins that `plugin:opener|*`
   * is refused and that no `opener:*` permission exists) — but a briefing reveal would need a
   * date- or path-derived operand with its own validator and review, so the decision stands. The
   * file's path is shown instead.
   */
  import BriefingView from "../lib/BriefingView.svelte";
  import { renderMarkdown } from "../lib/briefing-md";
  import { describeFailure, readArchivedBriefing, type BriefingFile } from "../lib/files";
  import { formatBytes, moveFrom } from "../lib/history";

  interface Props {
    /** Newest first (`lib/history.ts`, `keepArchive`): the last KNOWN list, `null` before any. */
    dates: string[] | null;
    /** Why the latest engine read failed, if it did — shown here, not only on Today. */
    error?: string | null;
    /** True when the latest snapshot did not carry a list, so `dates` is an earlier one. */
    stale?: boolean;
  }
  let { dates, error = null, stale = false }: Props = $props();

  let selected = $state<string | null>(null);
  let file = $state<BriefingFile | null>(null);
  let failure = $state("");
  let seq = 0;

  async function open(date: string): Promise<void> {
    selected = date;
    file = null;
    failure = "";
    const mine = ++seq;
    try {
      const got = await readArchivedBriefing(date);
      if (mine === seq) file = got;
    } catch (e) {
      if (mine === seq) failure = describeFailure(e);
    }
  }

  /** Arrow keys move from the button that has focus (review round 1), not from the selection. */
  function onkey(event: KeyboardEvent, focused: string): void {
    if (dates === null) return;
    const date = moveFrom(event.key, focused, dates);
    if (date === null) return;
    event.preventDefault();
    void open(date);
    document.getElementById(`history-${date}`)?.focus();
  }

  const blocks = $derived(file === null ? [] : renderMarkdown(file.text));
</script>

<section class="history">
  <h2>History</h2>
  <p class="retention">
    Every briefing is kept, on purpose: the archive grows by about 8 KB a day (roughly 3 MB a year)
    because it is the engine's calibration record. This screen never removes any of it. Only
    Uninstall (Settings › This app), with "Also remove the engine's data" ticked, does.
  </p>

  {#if error !== null}
    <p class="bad" role="status">{error}</p>
  {/if}
  {#if stale && dates !== null}
    <p class="muted">This list is from the last successful read of the engine's state.</p>
  {/if}

  {#if dates === null}
    {#if error === null}
      <p class="muted">Reading the archive list…</p>
    {/if}
  {:else if dates.length === 0}
    <p class="muted">No archived briefings yet.</p>
  {:else}
    <div class="layout">
      <nav aria-label="Archived briefings">
        <p class="muted count">{dates.length} {dates.length === 1 ? "briefing" : "briefings"}</p>
        <ul>
          {#each dates as date (date)}
            <li>
              <button
                id="history-{date}"
                class:selected={date === selected}
                aria-current={date === selected ? "true" : undefined}
                onclick={() => open(date)}
                onkeydown={(e) => onkey(e, date)}>{date}</button
              >
            </li>
          {/each}
        </ul>
      </nav>
      <div class="reader">
        {#if selected === null}
          <p class="muted">Choose a date. The arrow keys, Home and End move through the list.</p>
        {:else if failure !== ""}
          <p class="bad">{failure}</p>
        {:else if file === null}
          <p class="muted">Loading {selected}…</p>
        {:else}
          <p class="meta muted">{selected} · {formatBytes(file.bytes)} · {file.path}</p>
          <BriefingView {blocks} />
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.15rem;
  }
  .retention {
    margin: 0 0 1rem;
    color: var(--muted);
    font-size: 0.88rem;
    max-width: 44rem;
  }
  .layout {
    display: grid;
    grid-template-columns: 10rem 1fr;
    gap: 1rem;
    align-items: start;
  }
  nav {
    max-height: 70vh;
    overflow-y: auto;
    border-right: 1px solid var(--line);
    padding-right: 0.5rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li button {
    width: 100%;
    text-align: left;
    font: inherit;
    font-variant-numeric: tabular-nums;
    padding: 0.2rem 0.4rem;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  li button.selected {
    border-color: var(--line);
    background: var(--panel);
    font-weight: 600;
  }
  .muted {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .count {
    margin: 0 0 0.4rem;
  }
  .meta {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .bad {
    color: var(--danger);
    white-space: pre-wrap;
  }
</style>
