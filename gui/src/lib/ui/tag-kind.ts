/**
 * Step 0 — the status tag kinds (hub spec "The look", "Status tags"), in a plain `.ts` module so a
 * pure `.ts` model (A's `deck.ts`) can import the type: a `.ts` file that imports a type from a
 * `.svelte` file fails `bun run typecheck` (TS2614: the ambient `*.svelte` module has only a default
 * export). `StatusTag.svelte` re-exports `Kind` for component callers.
 */

/** The tag kinds: a merged PR, a branch, main, and local work (not pushed). */
export type Kind = "merged" | "branch" | "main" | "local";

/**
 * The word each kind draws when it is given no label. `local` MEANS the hub's "work only on this
 * Mac" (hub spec "The look", "Status tags", :40), but its word is the platform-neutral "not pushed":
 * the app ships for macOS, Windows and Linux (hub "Platforms", :57), and B1's own labels for these
 * tags are "never pushed" / "N not pushed".
 */
export const TAG_WORDS: Readonly<Record<Kind, string>> = { merged: "merged", branch: "branch", main: "main", local: "not pushed" };
