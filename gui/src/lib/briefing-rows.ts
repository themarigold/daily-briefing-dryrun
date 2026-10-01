/**
 * `BriefingView.svelte`'s rows — its grouping pass over the block list, and the key each row is
 * drawn under. Pure, and out of the component, so a test can pin the key without a DOM.
 *
 * ⚠ THE KEY IS WHAT KEEPS ONE BRIEFING'S DISCLOSURE STATE OUT OF THE NEXT (fix round, MED-1). A
 * recap group is a native `<details>`, and `open` is DOM state the view never writes: Svelte does
 * not reset it when it REUSES the element. Today swaps briefings in place — Run Now replaces
 * `latest` (`routes/Today.svelte`) and `routes/TodayView.svelte` keeps the same `BriefingView` — so
 * a row keyed by its index alone kept the `<details>` at that index, open, under the NEXT
 * briefing's header (reproduced in Chromium). Keyed by index AND header, a different group at that
 * index is a different row, drawn as a fresh, closed element. History unmounts the view between
 * dates, so it never had the leak.
 *
 * ⚠ AND NOT `{#key blocks}`. `lib/today.ts`'s `todayModel` builds a fresh `blocks` array on every
 * `state:changed`, so re-creating the view on a new array would close every open group on every
 * state update. A briefing whose lines did not change keeps its keys, and an open group stays open.
 *
 * TIER B (spec §4.7 "The GUI mirrors", D12): a THIRD level. A campaign is a `bullet` header whose
 * members are `nested` lines — and, for a Stage-1 group the campaign absorbed, a `nested` header
 * followed by that group's members as `nested2` lines. Inside a group, a `nested` plus the run of
 * `nested2` right after it is a SUB-GROUP: its own `<details>`, closed by default, keyed by the same
 * MED-1 rule (index AND header) so a new briefing never inherits an open sub-group either. A two-level
 * page has no `nested2` line, so its rows are exactly what they were.
 */
import { blockText, type Block, type BlockKind } from "./briefing-md";

/** Inside a group: a member on its own, or a sub-group — a `nested` header and the `nested2` run
 *  right after it. */
export type Member = { group: true; header: Block; members: Block[] } | { group: false; block: Block };

/** A row of the view: one block on its own, or a group — a header and the members under it. */
export type Row = { group: true; header: Block; members: Member[] } | { group: false; block: Block };

const isMemberKind = (kind: BlockKind | undefined): boolean => kind === "nested" || kind === "nested2";

/** The grouping pass, over the block list only: a `bullet` and the run of `nested`/`nested2` blocks
 *  right after it are one group; inside it a `nested` block and the run of `nested2` blocks right
 *  after it are one sub-group; every other block is a row (or member) of its own. */
export function groupRows(list: Block[]): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < list.length; i++) {
    const block = list[i]!;
    if (block.kind !== "bullet" || !isMemberKind(list[i + 1]?.kind)) {
      rows.push({ group: false, block });
      continue;
    }
    const members: Member[] = [];
    while (isMemberKind(list[i + 1]?.kind)) {
      const m = list[++i]!;
      if (m.kind === "nested" && list[i + 1]?.kind === "nested2") {
        const subs: Block[] = [];
        while (list[i + 1]?.kind === "nested2") subs.push(list[++i]!);
        members.push({ group: true, header: m, members: subs });
      } else {
        members.push({ group: false, block: m });
      }
    }
    rows.push({ group: true, header: block, members });
  }
  return rows;
}

/** The `{#each}` key of row `i`: its index, and for a group its header's text as well. The
 *  index keeps keys unique (two groups may share a header) and never contains the `\u0001`
 *  separator, so no two (index, header) pairs share a key. A plain row keeps the index alone: it
 *  holds no DOM state to leak. */
export function rowKey(row: Row, i: number): string {
  return row.group ? `${i}\u0001${blockText(row.header)}` : `${i}`;
}

/** The `{#each}` key of member `j` inside a group, by the same rule: index alone for a plain
 *  member, index AND header for a sub-group — so a different sub-group at the same position under
 *  the next briefing's campaign is a fresh, closed element. */
export function subRowKey(member: Member, j: number): string {
  return member.group ? `${j}\u0001${blockText(member.header)}` : `${j}`;
}
