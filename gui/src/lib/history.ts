/**
 * T13's pure pieces: the date list and the keyboard rule. `History.svelte` draws them.
 *
 * ⚠ THE LIST IS `status --json`'s `archivedDates` — the engine's own `readdir` of its own
 * directory (`src/json.ts`, `statusReport`) — and nothing else. The app lists no directory itself.
 */
import type { Snapshot } from "./state";

/**
 * `archivedDates` from the raw status envelope, newest first, duplicates and non-strings dropped —
 * or `null` when this snapshot does not KNOW the list: no snapshot yet, or a `status --json` read
 * that failed (`status` is then null). An unknown list is not an empty archive (review round 1, M6).
 */
export function archiveList(snapshot: Snapshot | null): string[] | null {
  const status = snapshot?.status;
  if (typeof status !== "object" || status === null) return null;
  const raw = (status as { archivedDates?: unknown }).archivedDates;
  if (!Array.isArray(raw)) return null;
  const dates = [...new Set(raw.filter((d): d is string => typeof d === "string"))];
  return dates.sort((a, z) => (a < z ? 1 : a > z ? -1 : 0));
}

/** [`archiveList`], with an unknown list read as empty. */
export function archivedDates(snapshot: Snapshot | null): string[] {
  return archiveList(snapshot) ?? [];
}

/** The list History shows after `next` arrives: its list when it knows one, else the last known. */
export function keepArchive(previous: string[] | null, next: Snapshot | null): string[] | null {
  return archiveList(next) ?? previous;
}

/** The date a key moves to from the FOCUSED button's date (`null` = no button focused), or null. */
export function moveFrom(key: string, focused: string | null, dates: string[]): string | null {
  const next = nextIndex(key, focused === null ? -1 : dates.indexOf(focused), dates.length);
  return next === null ? null : (dates[next] ?? null);
}

/** Where a key moves the selection in a list of `length` (`-1` = nothing selected). */
export function nextIndex(key: string, current: number, length: number): number | null {
  if (length === 0) return null;
  const last = length - 1;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp":
      return current < 0 ? 0 : Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    case "PageDown":
      return current < 0 ? 0 : Math.min(current + 10, last);
    case "PageUp":
      return current < 0 ? 0 : Math.max(current - 10, 0);
    default:
      return null;
  }
}

/** `8.1 KB` / `512 B` — the file size shown beside a briefing. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
