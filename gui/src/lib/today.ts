/**
 * What the Today screen shows, decided purely (T12). `Today.svelte` gathers the inputs over IPC;
 * `TodayView.svelte` draws this model; `gui/tests-web/today.check.ts` drives it directly.
 *
 * ## Which renderer
 *
 * Under plan R1 the morning briefing is delivered by launchd, so the app never sees a `run --json`
 * envelope for it — the common case is `briefing-latest.md`, markdown only, through the
 * escape-first renderer. The STRUCT renderer is used only when the app itself ran the engine, the
 * run delivered, its envelope's `markdown` is byte-identical to the file's text, AND the struct
 * view's blocks carry exactly the same visible text (and kinds) as the markdown renderer's blocks
 * for that same `markdown`. A later CLI `--force` on the same day rewrites the file and switches
 * Today back to the file. There is no struct companion file for `briefing-latest.md` (the
 * appendix's T12 text assumed one; docs/gui-seam.md §10).
 *
 * ⚠ THE BLOCK-TEXT CHECK IS A SECURITY CHECK, NOT A NICETY. `markdown === file` proves the envelope
 * belongs to the file; it does NOT prove the struct says what the file says. The engine used to redact
 * credentials in the RENDERED STRING ONLY (`src/main.ts`: `redactCredentials(renderBriefing(r.struct))`)
 * and put the raw `r.struct` in the envelope (`src/json.ts`, `envelopeFrom`), so a key the file
 * showed as `[redacted]` was still in the struct. Rendering the struct because the markdown matched
 * put that key on screen (review round 1, H1, reproduced with the real sidecar). Phase E's E1 now
 * redacts the envelope's struct too (`src/json.ts`, `redactStruct`, applied once in `emit`), but this
 * check stays and does not rely on it: per-leaf redaction does NOT always render byte-equal to the
 * redacted file — in TWO known shapes, both failing closed to the file: D2 (an `env-assignment`
 * value ending a leaf swallows the renderer's following punctuation only in the post-render scan;
 * measured, test/envelope-redaction.test.ts) and key over-redaction (`redactStruct` redacts `whys`
 * KEYS case-insensitively, so a key such as `myapi_token=…` is redacted where the file's
 * case-sensitive pass leaves its label, e.g. `MyAPI_TOKEN=…`, and the struct render loses that why
 * line; `src/json.ts`'s `redactStruct` note) — and an envelope from an engine older than E1 still
 * carries the raw struct. So the struct is
 * used only when it renders to the SAME text the file renders to; any difference — redaction, a
 * model-written `**x**` the markdown renderer interprets, a future engine-side rewrite — falls back
 * to the file. Fail-closed, and with no copy of the engine's credential patterns in this app.
 *
 * ## What is NOT decided here
 *
 * Which schedule phase applies, whether today was delivered, what a skip means: that is
 * `schedule_state::derive`, in Rust. This model RENDERS `scheduleState.statusLine`, its tone and a
 * skip's own `detail` line. The one comparison it makes is the briefing's OWN date (from its title
 * line) against the local date, to label an older briefing as not today's.
 */
import { renderMarkdown, blockText, type Block } from "./briefing-md";
import { renderStruct, type BriefingStruct } from "./briefing-struct";
import type { BriefingFile } from "./files";
import type { Snapshot } from "./state";
import { tone, type Tone } from "./tone";

/** The `run --json` envelope fields Today reads (`src/json.ts`, `RunEnvelope`). */
export interface RunEnvelope {
  runDate: string;
  delivered: boolean;
  markdown: string;
  struct: BriefingStruct | null;
}

export type LatestLoad =
  | { state: "loading" }
  | { state: "none" }
  | { state: "loaded"; file: BriefingFile }
  | { state: "error"; message: string };

export type Source =
  | { kind: "struct"; blocks: Block[] }
  | { kind: "markdown"; blocks: Block[] }
  | { kind: "none" };

export interface Banner {
  tone: Tone;
  text: string;
}

export interface TodayModel {
  /** `scheduleState.statusLine` — the tray's words — and its tone; null before the first snapshot. */
  status: { text: string; tone: Tone } | null;
  /** Engine-authored explanations (a skip's `detail`, a config error), verbatim, plus read errors. */
  banners: Banner[];
  source: Source;
  /** Set when a briefing is shown and its own date is not today's. */
  staleDate: string | null;
  quiet: boolean;
  /**
   * A quiet day whose DISPLAYED briefing carries a `warnings` block (v0.2.1 §2.4.3): Today then says
   * "See the warning below." Read off the rendered blocks, never `struct.warnings`, so a warning the
   * renderers leave out (the API notice, §2.3) never points at a line that is not there. The wording is
   * neutral because a quiet day can carry unrelated warnings too (an invalid morning time, transcripts).
   */
  quietWithWarning: boolean;
  loading: boolean;
  /** Nothing has been written yet (and the read succeeded). */
  empty: boolean;
}

/** True when both block lists show the same lines, of the same kinds, in the same order. */
export function sameVisibleText(a: Block[], b: Block[]): boolean {
  return (
    a.length === b.length &&
    a.every((block, i) => {
      const other = b[i];
      return other !== undefined && block.kind === other.kind && blockText(block) === blockText(other);
    })
  );
}

/**
 * The struct when the envelope IS the file AND the struct renders to the file's text; the file
 * otherwise. See the module header for why the second condition exists (credential redaction).
 */
export function chooseSource(latest: BriefingFile | null, lastRun: RunEnvelope | null): Source {
  if (latest === null) return { kind: "none" };
  const fromFile = renderMarkdown(latest.text);
  if (lastRun !== null && lastRun.delivered && lastRun.struct !== null && lastRun.markdown === latest.text) {
    // `fromFile` IS `renderMarkdown(lastRun.markdown)`: the two strings were just compared equal.
    const fromStruct = renderStruct(lastRun.struct);
    if (sameVisibleText(fromStruct, fromFile)) return { kind: "struct", blocks: fromStruct };
  }
  return { kind: "markdown", blocks: fromFile };
}

/** The date in a briefing's own title line, if it has one. */
export function briefingDate(blocks: Block[]): string | null {
  const title = blocks.find((b) => b.kind === "title");
  if (title === undefined) return null;
  return /briefing — (\d{4}-\d{2}-\d{2})/.exec(blockText(title))?.[1] ?? null;
}

/** `YYYY-MM-DD` in this machine's zone — the same zone the engine's `localDateStr` uses. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayModel(input: {
  snapshot: Snapshot | null;
  latest: LatestLoad;
  lastRun: RunEnvelope | null;
  today: string;
}): TodayModel {
  const { snapshot, latest, lastRun, today } = input;
  const state = snapshot?.scheduleState ?? null;
  const banners: Banner[] = [];
  if (snapshot?.error) banners.push({ tone: "bad", text: snapshot.error });
  if (state !== null) {
    const p = state.phase;
    if (p.phase === "skipped" && p.detail !== null && p.detail !== "") {
      banners.push({ tone: tone(state), text: p.detail });
    }
    if (p.phase === "config-error") banners.push({ tone: "bad", text: p.detail });
  }
  if (latest.state === "error") banners.push({ tone: "bad", text: latest.message });

  const source = chooseSource(latest.state === "loaded" ? latest.file : null, lastRun);
  const blocks = source.kind === "none" ? [] : source.blocks;
  const date = briefingDate(blocks);
  const quiet = blocks.some((b) => b.kind === "placeholder" && blockText(b) === "(no commits in the window)");
  return {
    status: state === null ? null : { text: state.statusLine, tone: tone(state) },
    banners,
    source,
    staleDate: date !== null && date !== today ? date : null,
    quiet,
    quietWithWarning: quiet && blocks.some((b) => b.kind === "warnings"),
    loading: latest.state === "loading",
    empty: latest.state === "none",
  };
}

/** The envelope inside a finished `engine_run` outcome, when it has the fields Today reads. */
export function envelopeOf(payload: unknown): RunEnvelope | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Partial<RunEnvelope>;
  if (typeof p.markdown !== "string" || typeof p.runDate !== "string" || typeof p.delivered !== "boolean") {
    return null;
  }
  return {
    runDate: p.runDate,
    delivered: p.delivered,
    markdown: p.markdown,
    struct: typeof p.struct === "object" && p.struct !== null ? p.struct : null,
  };
}

/** `latestBriefingMtime` from the raw `status --json` envelope — the key Today re-reads on. */
export function latestMtime(snapshot: Snapshot | null): string | null {
  const status = snapshot?.status;
  if (typeof status !== "object" || status === null) return null;
  const m = (status as { latestBriefingMtime?: unknown }).latestBriefingMtime;
  return typeof m === "string" ? m : null;
}
