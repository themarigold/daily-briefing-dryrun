/**
 * The STRUCT renderer (T12; plan R1: "Today struct/textContent").
 *
 * When the app itself ran the engine (Run Now → `engine_run`), the `run --json` envelope carries
 * the `BriefingStruct` the markdown was rendered from. This turns that struct into the same
 * `Block[]` model the escape-first renderer produces, so `BriefingView.svelte` shows either — and
 * every string goes into a TEXT span. No inline markdown is interpreted here at all: a model-written
 * `**x**` is shown as the four asterisks it is.
 *
 * ⚠ IT MIRRORS `renderBriefing`'s ORDER EXACTLY (`src/render.ts`), and that is not a style
 * preference: two presentations of one briefing that drift apart are the failure the appendix names
 * (RISK:MEDIUM). `gui/tests-web/briefing.check.ts` runs the ENGINE's own `renderBriefing` over a
 * set of fixtures and requires the visible text of these blocks, in order, to equal the engine's
 * lines with only their structural prefix (indent and bullet glyph) removed. A reordered, dropped
 * or reworded line fails it. Which fixture takes which of `renderBriefing`'s branches is a table at
 * the top of that file, enumerated from the engine's conditionals — review round 1 found two
 * branches (a why before a grouped story line; merges under an empty recap) that the first fixture
 * set did not take, and both are in it now.
 *
 * ⚠ TODAY SHOWS THIS VIEW ONLY WHEN IT RENDERS TO THE FILE'S TEXT (`lib/today.ts`): the struct is
 * the engine's RAW value, and the engine redacts credentials in the rendered string only.
 *
 * ⚠ AND IT RE-APPLIES THE ENGINE'S SANITISER (`stripControl`, `src/render.ts`) to every line,
 * as `docs/gui-seam.md` §5 requires of a new render surface. The struct is the RAW pipeline value:
 * the engine strips control bytes only when it renders.
 */
import type { Block, BlockKind } from "./briefing-md";

/** `src/types.ts`, `BriefingStruct` — the fields this renderer reads (the engine's type is the source). */
export interface BriefingStruct {
  date: string;
  machineScope: string;
  provider: string;
  resume: { repo: string; text: string; ref?: string }[];
  /** `campaign?` (tier B, spec §4.7): the level-1 campaign header text, spelled identically on every
   *  member entry, as `group` carries Stage 1's — the `--json` envelope carries the struct verbatim. */
  recap: { repo: string; text: string; evidence?: string; group?: string; campaign?: string }[];
  suggestions: { text: string; repo?: string; promoted?: true; stash?: { branch?: string; ageDays?: number } }[];
  today?: { repo: string; text: string }[];
  outage?: { missedDays: number; label: string };
  windowMerges?: { repo: string; text: string }[];
  warnings?: string[];
  stateAsOf?: string;
  morningFloor?: string;
  branchState?: { repo: string; text: string }[];
  labelLegend?: { repo: string; labels: string[] }[];
  recapCoverage?: {
    shown: number;
    total: number;
    notShown: { label: string; sha: string; subject: string }[];
  };
  whys?: Record<string, string>;
}

/** `src/render.ts`, `LEGEND_LABEL_CAP`. */
export const LEGEND_LABEL_CAP = 8;

/** `src/render.ts`, `stripControl`: every C0 control, DEL and C1 byte. */
export function stripControl(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/** `src/render.ts`, `stashLabel` (IN-10): the provenance label on a code-built stash suggestion. */
export function stashLabel(s: { branch?: string; ageDays?: number }): string {
  const where = s.branch === "(no branch)" ? "no branch" : null;
  const age =
    s.ageDays === undefined ? null : s.ageDays === 0 ? "made today" : `${s.ageDays} day${s.ageDays === 1 ? "" : "s"} old`;
  return `  (${["from stash", where, age].filter((x) => x !== null).join(" · ")})`;
}

/** `src/subprojects.ts`, `norm` — the key `whys` and recap clusters are matched on. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*`]/g, "")
    .trim()
    .replace(/[.,;:!?]+$/, "");
}

/** `src/render.ts`, `collapseWindowMerges` (shape S3b, 2026-09-24): the 🔀 foot block as ONE line per
 *  label — `🔀 2 PRs merged (#533, #531) (Sep 21–Sep 22)  (e7b732b, d27d108)` — from the per-merge
 *  `🔀 Merged #N (branch) (Mon D)  (sha7)` texts the struct carries. The struct is deliberately NOT
 *  reshaped by the engine (its suggestion guard reads the per-merge texts), so this mirror collapses
 *  at render time exactly as the engine does. A text that does not parse is re-emitted verbatim,
 *  after its label's collapsed line.
 *  Byte-parallel to the engine's, including the `\S*?` branch group (a ref name can never contain a
 *  space — the engine's header records what a laxer group cost), the run-date anchor that supplies
 *  the missing year, the `norm(label)` grouping key and the explicit `"en"` collation. Every reason
 *  is written down once, at the engine's copy; `tests-web/briefing.check.ts` pins the two on shared
 *  inputs. */
const WINDOW_MERGE_TEXT =
  /^🔀 Merged #(\d+) \((\S*?)\)(?: \(((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})\))?  \(([0-9a-f]{7})\)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function mergeDateRange(dates: string[], runDate: string): string {
  if (!dates.length) return "";
  const ord = (d: string) => MONTHS.indexOf(d.slice(0, 3)) * 31 + Number(d.slice(4));
  const a = /^\d{4}-(\d{2})-(\d{2})$/.exec(runDate);
  const anchor = a ? (Number(a[1]) - 1) * 31 + Number(a[2]) : null;
  const os = dates.map((d) => { const o = ord(d); return { d, o: anchor !== null && o > anchor ? o - 372 : o }; });
  const first = os.reduce((x, y) => (y.o < x.o ? y : x));
  const last = os.reduce((x, y) => (y.o > x.o ? y : x));
  return first.d === last.d ? ` (${first.d})` : ` (${first.d}–${last.d})`;
}

export function collapseWindowMerges(
  merges: { repo: string; text: string }[], runDate: string,
): { repo: string; text: string }[] {
  type Slot = { label: string; parsed: { pr: string; date?: string; sha: string }[]; rest: { repo: string; text: string }[] };
  const byLabel = new Map<string, Slot>();
  for (const m of [...merges].sort((a, z) => norm(a.repo).localeCompare(norm(z.repo), "en"))) {
    let slot = byLabel.get(norm(m.repo));
    if (!slot) { slot = { label: m.repo, parsed: [], rest: [] }; byLabel.set(norm(m.repo), slot); }
    const hit = WINDOW_MERGE_TEXT.exec(m.text);
    if (hit) slot.parsed.push(hit[3] ? { pr: hit[1]!, date: hit[3], sha: hit[4]! } : { pr: hit[1]!, sha: hit[4]! });
    else slot.rest.push(m);
  }
  const out: { repo: string; text: string }[] = [];
  for (const { label, parsed, rest } of byLabel.values()) {
    if (parsed.length) {
      const n = parsed.length;
      const prs = parsed.map((p) => `#${p.pr}`).join(", ");
      const shas = parsed.map((p) => p.sha).join(", ");
      const when = mergeDateRange(parsed.flatMap((p) => (p.date ? [p.date] : [])), runDate);
      out.push({ repo: label, text: `🔀 ${n} PR${n === 1 ? "" : "s"} merged (${prs})${when}  (${shas})` });
    }
    for (const m of rest) out.push({ repo: m.repo, text: m.text });
  }
  return out;
}

export function renderStruct(b: BriefingStruct): Block[] {
  const out: Block[] = [];
  const push = (kind: BlockKind, text: string) =>
    out.push({ kind, spans: [{ kind: "text", text: stripControl(text) }] });

  push("title", `☀️  Daily briefing — ${b.date}  (this machine: ${b.machineScope})`);
  if (b.outage) {
    const n = b.outage.missedDays;
    push(
      "outage",
      `⚠️  No briefing for ${n} day${n === 1 ? "" : "s"} — account "${b.outage.label}" was at its usage limit.`,
    );
  }
  const legend = (b.labelLegend ?? []).filter((g) => g.labels.length > 0);
  if (legend.length > 0) {
    const groups = legend.map((g) => {
      const shown = g.labels.slice(0, LEGEND_LABEL_CAP);
      const more = g.labels.length - shown.length;
      return `${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""} ${g.labels.length === 1 ? "is an area" : "are areas"} of repo ${g.repo}`;
    });
    push("legend", `(labels: ${groups.join("; ")})`);
  }

  // The whys pre-pass: a label that appears in the recap gets its line there, every other in resume.
  const whys = b.whys ?? {};
  const recapKeys = new Set(b.recap.map((r) => norm(r.repo)));
  const emitted = new Set<string>();
  const whyFor = (label: string, section: "resume" | "recap"): string | null => {
    const key = norm(label);
    const turn = whys[key];
    if (turn === undefined || emitted.has(key)) return null;
    const home = recapKeys.has(key) ? "recap" : "resume";
    if (home !== section) return null;
    emitted.add(key);
    return `— you wrote: "${turn}"`;
  };

  const stamp = b.stateAsOf
    ? `  (${b.morningFloor ? `first wake past ${b.morningFloor} · ` : "first wake · "}state as of ${b.stateAsOf})`
    : "";
  push("heading", `Where you left off${stamp}`);
  for (const s of b.branchState ?? []) push("bullet", `[${s.repo}] ${s.text}`);
  if (b.resume.length > 0) {
    for (const r of b.resume) {
      const w = whyFor(r.repo, "resume");
      if (w !== null) push("why", w);
      push("bullet", `[${r.repo}] ${r.text}`);
    }
  } else {
    push("placeholder", "(nothing in progress)");
  }

  const cov = b.recapCoverage;
  const headCount = cov ? `${cov.shown} of ${cov.total}` : b.recap.length ? `${b.recap.length}` : "";
  const headPlural = (cov ? cov.total : b.recap.length) === 1 ? "" : "s";
  push("heading", `What you did${headCount ? ` — ${headCount} commit${headPlural}` : ""}`);
  if (cov) {
    const hidden = cov.total - cov.shown - cov.notShown.length;
    push("coverage", `⚠ ${cov.total - cov.shown} in-window commit(s) NOT shown above:`);
    for (const n of cov.notShown) push("notShown", `[${n.label}] ${n.sha} ${n.subject}`);
    if (hidden > 0) push("notShown", `(+${hidden} more)`);
  }
  if (b.recap.length > 0) {
    const emittedClusters = new Set<string>();
    const line = (r: BriefingStruct["recap"][number]) =>
      `[${r.repo}] ${r.text}${r.evidence ? `  (${r.evidence})` : ""}`;
    // Tier B (spec §4.7 "Render", D16), the engine's three-level walk mirrored: a campaign renders at
    // its FIRST member's position as a `bullet` header, its members beneath in Stage-1 order — a
    // member's Stage-1 group as a `nested` header with that group's members as `nested2`, a single
    // member as `nested`. `emittedClusters` is SHARED with the two-level walk below, exactly as in the
    // engine. Tested on `!== undefined`, as the engine tests it.
    const emittedCampaigns = new Set<string>();
    for (const r of b.recap) {
      if (r.campaign !== undefined) {
        const ck = `${norm(r.repo)}\x1f${r.campaign}`;
        if (emittedCampaigns.has(ck)) continue;
        emittedCampaigns.add(ck);
        const w = whyFor(r.repo, "recap");
        if (w !== null) push("why", w);
        push("bullet", `[${r.repo}] ${r.campaign}`);
        for (const m of b.recap) {
          if (m.campaign !== r.campaign || norm(m.repo) !== norm(r.repo)) continue;
          if (m.group !== undefined) {
            const gk = `${norm(m.repo)}\x1f${m.group}`;
            if (emittedClusters.has(gk)) continue;
            emittedClusters.add(gk);
            push("nested", `[${m.repo}] ${m.group}`);
            for (const g of b.recap) {
              if (g.group === m.group && norm(g.repo) === norm(m.repo)) push("nested2", line(g));
            }
          } else {
            push("nested", line(m));
          }
        }
        continue;
      }
      if (!r.group) {
        const w = whyFor(r.repo, "recap");
        if (w !== null) push("why", w);
        push("bullet", line(r));
        continue;
      }
      const key = `${norm(r.repo)}\x1f${r.group}`;
      if (emittedClusters.has(key)) continue;
      emittedClusters.add(key);
      const w = whyFor(r.repo, "recap");
      if (w !== null) push("why", w);
      push("bullet", `[${r.repo}] ${r.group}`);
      for (const m of b.recap) {
        if (m.group === r.group && norm(m.repo) === norm(r.repo)) push("nested", line(m));
      }
    }
  } else if (!cov) {
    push("placeholder", "(no commits in the window)");
  }
  for (const m of collapseWindowMerges(b.windowMerges ?? [], b.date)) push("bullet", `[${m.repo}] ${m.text}`);

  if (b.today?.length) {
    push("heading", "Today so far");
    for (const t of b.today) push("bullet", `[${t.repo}] ${t.text}`);
  }

  push("heading", "Suggested next");
  if (b.suggestions.length > 0) {
    for (const s of b.suggestions) {
      push(
        "bullet",
        `${s.repo ? `[${s.repo}] ` : ""}${s.text}${s.promoted ? "  (from resume)" : ""}${s.stash ? stashLabel(s.stash) : ""}`,
      );
    }
  } else {
    push("placeholder", "(none)");
  }
  if (b.warnings?.length) push("warnings", `⚠ ${b.warnings.join("; ")}`);
  push("footer", `— generated locally via ${b.provider}`);
  return out;
}
