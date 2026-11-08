/**
 * The briefing redesign's A-M6-T13 — the local, READ-ONLY archive probe. It maps every archived briefing
 * page with the deck's own model (`src/lib/deck.ts`) and reports what the deck could not map, and every
 * card whose count could differ from the engine's.
 *
 *     cd daily_briefing_application/gui && bun tests-web/probes/deck-probe.ts <briefingsDir>
 *
 * `<briefingsDir>` is `status --json`'s `paths.briefingsDir` (the dated `YYYY-MM-DD.md` pages).
 *
 * ⚠ IT REPORTS STRUCTURE AND COUNTS, NEVER A LINE'S TEXT (so its output can go in a PR body, and a fixture
 * can be synthesised from it). A failure is named by the page's date, the section, the block's index, its
 * kind and its prefix class (the line's leading shape: spaces, then a `[label]`, a letter, a digit or the
 * one leading symbol); a card by the page's date, the section and the card's index, never its label.
 * The folder's path is not printed either.
 *
 * What it reports:
 * - a page the deck cannot map, and why (`CannotMapReason`);
 * - a What-you-did card whose count by the deck's display rule (a token under 7 characters counts only
 *   with a digit, A spec "Counting") differs from the engine's 4-40 hex SHA shape (`src/sha.ts`): where the
 *   display limit could have miscounted (an all-letter short SHA, or a hex-shaped word);
 * - a page whose `— X of Y commits` header disagrees with its cards plus its `(+N more)` remainder: the gap
 *   (`Y − cards − more`), the page's evidence-less commit lines, and UNEXPLAINED when those lines cannot
 *   account for the gap (it is not above 0, or it is above their count);
 * - a page it could not read (a folder under a page's name, no permission), by date; the run goes on.
 *
 * ⚠ WHERE IT LIVES, AND WHAT IT MAY CALL. `tests-web/probes/`: outside `bun run test`'s one-level
 * `./tests-web/*.check.ts` glob (`gui/package.json`), not a `*.test.ts` (which the engine suite would
 * collect), and not under `gui/scripts/` (a CI cargo input). Two recursive scans read it
 * (`coexistence.check.ts`, `test/schedule.install.test.ts`): only static imports, nothing reaching
 * `src/schedule/install`, no `require`, no computed `import()`. It only reads: `node:fs`'s read calls, no
 * write of any kind (pinned by `deck.check.ts`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { blockText, renderMarkdown } from "../../src/lib/briefing-md";
import { lineTokens, mapPage, sectionKeyOf, splitTokens, type CannotMapReason, type CardLine } from "../../src/lib/deck";

/** A page that could not be mapped. `block` is -1 for a page with no title (no block decides it). */
export interface ProbeFailure {
  date: string;
  section: string;
  block: number;
  kind: string;
  prefix: string;
  reason: CannotMapReason;
}

/** A What-you-did card whose two counts differ. */
export interface ProbeCountDiff {
  date: string;
  section: "whatYouDid";
  card: number;
  /** The deck's count (its display rule). */
  deck: number;
  /** The engine's 4-40 hex SHA shape over the same lines. */
  hexShape: number;
}

/** A page whose `X of Y` header's Y is not its cards' distinct SHAs plus the `(+N more)` remainder. */
export interface ProbeTotalDiff {
  date: string;
  section: "whatYouDid";
  shown: number;
  more: number;
  stated: number;
  /** `stated − shown − more`: the commits the header counts that the deck could not. */
  gap: number;
  /** Commit lines (not cluster headers) with no SHA at all: shown commits whose evidence was stripped,
   *  which the header's Y counts and the deck cannot (its "Details ›" cards). The usual explanation. */
  noEvidence: number;
  /** The evidence-less lines do not account for the gap: it is not above 0, or it is above their count. */
  unexplained: boolean;
}

export type ProbeReport =
  | { kind: "skipped"; why: string }
  | {
      kind: "ran";
      pages: number;
      mapped: number;
      /** Pages that could not be read (a folder under a page's name, no permission), by date. */
      unreadable: string[];
      failures: ProbeFailure[];
      byReason: Partial<Record<CannotMapReason, number>>;
      countDiffs: ProbeCountDiff[];
      totalDiffs: ProbeTotalDiff[];
    };

const PAGE_NAME = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** A line's leading SHAPE: how many spaces, then a `[label]`, a letter, a digit, or the one leading symbol. */
export function prefixClass(text: string): string {
  const lead = /^\s*/.exec(text)![0].length;
  const rest = text.slice(lead);
  const first = [...rest][0] ?? "";
  const shape =
    first === ""
      ? "empty"
      : first === "["
        ? /^\[[^\]]*\]/.test(rest)
          ? "[label]"
          : "["
        : /\p{L}/u.test(first)
          ? "letter"
          : /\p{Nd}/u.test(first)
            ? "digit"
            : first;
  return `${lead}sp ${shape}`;
}

/** The engine's SHA shape (`src/sha.ts`: any 4-40 hex token), over one card line's evidence or SHA field. */
function hexShapeTokens(line: CardLine): string[] {
  let field: string[];
  if (line.kind === "notShown") {
    field = line.text.split(" ").slice(0, 1);
  } else {
    const at = line.text.lastIndexOf("  (");
    field = at === -1 ? [] : splitTokens(line.text.slice(at + 2));
  }
  return field.filter((t) => /^[0-9a-f]{4,40}$/i.test(t)).map((t) => t.toLowerCase());
}

/** Map every page in `dir`. Never writes; never throws for a missing or empty folder (it says it skipped). */
export function probeArchive(dir: string | undefined): ProbeReport {
  if (dir === undefined || dir === "") return { kind: "skipped", why: "no archive folder was given (pass status --json's paths.briefingsDir)" };
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return { kind: "skipped", why: "there is no folder at the path given" };
    names = readdirSync(dir);
  } catch {
    return { kind: "skipped", why: "there is no folder at the path given" };
  }
  const pages = names.filter((n) => PAGE_NAME.test(n)).sort();
  if (pages.length === 0) return { kind: "skipped", why: "the folder holds no briefing pages (YYYY-MM-DD.md)" };

  const failures: ProbeFailure[] = [];
  const byReason: Partial<Record<CannotMapReason, number>> = {};
  const countDiffs: ProbeCountDiff[] = [];
  const totalDiffs: ProbeTotalDiff[] = [];
  const unreadable: string[] = [];
  let mapped = 0;
  for (const name of pages) {
    const date = PAGE_NAME.exec(name)![1]!;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      unreadable.push(date);
      continue;
    }
    const blocks = renderMarkdown(text);
    const r = mapPage(blocks, date);
    if (!r.ok) {
      let section = r.index === -1 ? "-" : "outside";
      for (let i = 0; i < r.index; i++) {
        const b = blocks[i]!;
        if (b.kind === "heading") section = sectionKeyOf(blockText(b)) ?? "unknown";
      }
      failures.push({
        date,
        section,
        block: r.index,
        kind: r.index === -1 ? "-" : blocks[r.index]!.kind,
        prefix: r.index === -1 ? "-" : prefixClass(r.line),
        reason: r.reason,
      });
      byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
      continue;
    }
    mapped++;
    const w = r.page.whatYouDid;
    const shown = new Set<string>();
    let noEvidence = 0;
    w.cards.forEach((card, i) => {
      const hex = new Set(card.lines.flatMap(hexShapeTokens));
      for (const t of card.lines.flatMap(lineTokens)) shown.add(t);
      noEvidence += card.lines.filter((l) => !l.header && hexShapeTokens(l).length === 0).length;
      if (hex.size !== card.commits) countDiffs.push({ date, section: "whatYouDid", card: i, deck: card.commits, hexShape: hex.size });
    });
    const heading = r.page.sections.find((s) => s.key === "whatYouDid")?.heading ?? "";
    const ofTotal = /— \d+ of (\d+) commits?\b/.exec(heading);
    if (ofTotal !== null && shown.size + w.remainder.moreCount !== Number(ofTotal[1])) {
      const stated = Number(ofTotal[1]);
      const gap = stated - shown.size - w.remainder.moreCount;
      totalDiffs.push({ date, section: "whatYouDid", shown: shown.size, more: w.remainder.moreCount, stated, gap, noEvidence, unexplained: gap <= 0 || gap > noEvidence });
    }
  }
  return { kind: "ran", pages: pages.length, mapped, unreadable, failures, byReason, countDiffs, totalDiffs };
}

/** The report as plain lines: counts and structure only. */
export function formatReport(r: ProbeReport): string {
  if (r.kind === "skipped") return `deck-probe: skipped — ${r.why}`;
  const out = [`deck-probe: ${r.pages} pages, ${r.mapped} mapped, ${r.failures.length} could not be mapped`];
  const reasons = Object.entries(r.byReason).map(([k, n]) => `${k} ${n}`);
  if (reasons.length > 0) out.push(`  by reason: ${reasons.join(", ")}`);
  if (r.failures.length > 0) {
    out.push("failures (date, section, block index, kind, prefix class, reason):");
    for (const f of r.failures) out.push(`  ${f.date}  section=${f.section}  block=${f.block}  kind=${f.kind}  prefix="${f.prefix}"  reason=${f.reason}`);
  }
  out.push(`card count differences (deck rule vs the engine's 4-40 hex shape): ${r.countDiffs.length}`);
  for (const d of r.countDiffs) out.push(`  ${d.date}  section=${d.section}  card=${d.card}  deck=${d.deck}  hex-shape=${d.hexShape}`);
  out.push(`header total differences (cards + (+N more) vs the header's Y): ${r.totalDiffs.length}`);
  for (const d of r.totalDiffs) {
    out.push(
      `  ${d.date}  section=${d.section}  shown=${d.shown}  more=${d.more}  stated=${d.stated}  gap=${d.gap}  lines-without-evidence=${d.noEvidence}  ${d.unexplained ? "UNEXPLAINED" : "explained"}`,
    );
  }
  out.push(`unreadable pages: ${r.unreadable.length}`);
  for (const date of r.unreadable) out.push(`  ${date}`);
  return out.join("\n");
}

if (import.meta.main) console.log(formatReport(probeArchive(process.argv[2])));
