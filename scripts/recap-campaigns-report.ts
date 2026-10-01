// scripts/recap-campaigns-report.ts — tier B (Stage-2 recap campaigns): the trial record's READER
// (spec §4.10 3; Appendix D1 + addendum, D9 addendum).
//
//   run: bun scripts/recap-campaigns-report.ts [record files…]
//        (default: the state dir's `recap-campaigns.jsonl`, `statePaths().recapCampaignsPath` — D11)
//
// READ-ONLY. It constructs no provider, writes nothing, and a missing record file reads as EMPTY (§4.10 1:
// the user may delete the file at any time).
//
// The rules it applies, each the spec's:
//   • Same-date lines: lines are grouped by `date`; the line used for a date is the LAST line (in file
//     order, the files in argument order) whose `gate.fired` is true. Every other line for that date is
//     reported beside it — count, `invoker`, `json`, `forced`, outcome — never silently dropped. A date
//     with no gate-fired line is not a gated morning.
//   • Per gated date: mode, outcome, reason, before → after, the campaigns with their members and PR
//     facts, each absorbed item marked `merged across PRs` flagged for criterion C(ii); `prFacts` in full,
//     `reposUnread` included (D9 addendum) — reported, never gated. A line without `prFacts` (a `skipped`
//     line, or an `exception` whose throw came before the git reads returned) says so; nothing crashes.
//   • The summary, over the chosen lines: gated dates; outcome counts; the mean `after`; the rejection
//     count and reasons; dropped / proposed — those four from `summariseRecapOutcomes`, the ONE summariser
//     the replay's `--score` also uses (plan §2 `Simple:`) — then the absorbed marked items, the page-length
//     delta (Σ kept campaigns), the largest campaign's share of its label's items (D1: `max(campaign
//     items) / offered`, joined on the `labelKey` both `campaigns[].label` and `labels[].label` carry),
//     latency, and the `timedOut` / `reposUnread` totals.
import { readFile } from "node:fs/promises";
import { statePaths } from "../src/json";
import { summariseRecapOutcomes, isMarkedItem, type RecapRecordV2, type RecapSummary } from "../src/recapCampaigns";

/** One record line as read: its file, its 1-based line number, and the parsed record. */
export type ReadLine = { file: string; line: number; record: RecapRecordV2 };

export type ReadResult = {
  lines: ReadLine[];
  /** Files that did not exist: read as empty. */
  missing: string[];
  /** Lines that are not a JSON object carrying a string `date` — reported, skipped, never fatal. */
  problems: string[];
};

/** Read every record file in order. A missing file is empty (§4.10 1); any other read error propagates. */
export async function readRecordFiles(paths: readonly string[]): Promise<ReadResult> {
  const out: ReadResult = { lines: [], missing: [], problems: [] };
  for (const file of paths) {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { out.missing.push(file); continue; }
      throw e;
    }
    text.split("\n").forEach((raw, i) => {
      if (raw.trim() === "") return;
      let v: unknown;
      try { v = JSON.parse(raw); } catch { out.problems.push(`${file}:${i + 1}: not JSON — skipped`); return; }
      if (typeof v !== "object" || v === null || Array.isArray(v) || typeof (v as { date?: unknown }).date !== "string") {
        out.problems.push(`${file}:${i + 1}: not a record line (no string \`date\`) — skipped`);
        return;
      }
      out.lines.push({ file, line: i + 1, record: v as RecapRecordV2 });
    });
  }
  return out;
}

/** The records grouped by `date`, dates ascending, each date's lines in read order. */
export function groupByDate(lines: readonly ReadLine[]): Map<string, ReadLine[]> {
  const by = new Map<string, ReadLine[]>();
  for (const l of lines) (by.get(l.record.date) ?? by.set(l.record.date, []).get(l.record.date)!).push(l);
  return new Map([...by].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** §4.10 3's same-date rule: the LAST line whose `gate.fired` is true, or `undefined` (not a gated
 *  morning). */
export function chosenLine(lines: readonly ReadLine[]): ReadLine | undefined {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.record.gate?.fired === true) return lines[i];
  return undefined;
}

/** D1: the largest campaign's share of its label's items — `max(campaign items) / offered`, `offered`
 *  looked up in the record's `labels[]` on the labelKey. Ties on size go to the larger share. `share` is
 *  `null` when the line has no campaigns, or the label has no `labels[]` entry. */
export type LargestShare = { label: string; title: string; items: number; offered: number | null; share: number | null };
export function largestCampaignShare(r: RecapRecordV2): LargestShare | undefined {
  let best: LargestShare | undefined;
  for (const c of r.campaigns ?? []) {
    const offered = r.labels?.find((l) => l.label === c.label)?.offered ?? null;
    const cand: LargestShare = { label: c.label, title: c.title, items: c.items.length, offered, share: offered ? c.items.length / offered : null };
    if (!best || cand.items > best.items || (cand.items === best.items && (cand.share ?? -1) > (best.share ?? -1))) best = cand;
  }
  return best;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const markedCount = (r: RecapRecordV2): number =>
  (r.campaigns ?? []).reduce((n, c) => n + c.items.filter((it) => isMarkedItem({ fact: it.prFact })).length, 0);
const gateText = (r: RecapRecordV2): string =>
  r.gate === null || r.gate === undefined ? "gate not evaluated" : `gate ${r.gate.fired ? "fired" : "not fired"} (commits ${r.gate.commits}, top ${r.gate.top})`;
const prFactsText = (r: RecapRecordV2): string => {
  const p = r.prFacts;
  return p === undefined
    ? "prFacts: absent on this line (no git read returned)"
    : `prFacts: merges ${p.merges} · read ${p.read} · timedOut ${p.timedOut} · marked ${p.marked} · reposUnread ${p.reposUnread}`;
};

export type Report = { text: string[]; summary: RecapSummary };

/** The whole report as lines, plus the summariser's result (for tests). Pure over what was read. */
export function buildReport(read: ReadResult, files: readonly string[]): Report {
  const L: string[] = [];
  L.push(`recap-campaigns report — ${files.length} record file(s), ${read.lines.length} line(s) read`);
  for (const f of read.missing) L.push(`  ${f}: missing — read as empty`);
  for (const p of read.problems) L.push(`  ${p}`);
  const byDate = groupByDate(read.lines);
  const chosen: RecapRecordV2[] = [];
  const notGated: string[] = [];
  for (const [date, lines] of byDate) {
    const pick = chosenLine(lines);
    if (!pick) {
      notGated.push(`  ${date}: ${lines.length} line(s), none gate-fired — ${lines.map((l) => `${l.record.outcome}${l.record.reason ? `/${l.record.reason}` : ""}`).join(", ")}`);
      continue;
    }
    const r = pick.record;
    chosen.push(r);
    L.push("");
    L.push(`${date} — gated: line ${pick.file}:${pick.line} (the last gate-fired line of ${lines.length} for this date)`);
    L.push(`  mode ${r.mode} · outcome ${r.outcome} · reason ${r.reason ?? "—"} · before ${r.before} → after ${r.after}`);
    L.push(`  proposed ${r.proposed} · kept ${r.kept} · dropped ${r.dropped?.length ?? 0} · latency ${r.latencyMs} ms · git ${r.gitMs} ms · hardening ${r.hardening}`);
    L.push(`  ${prFactsText(r)}`);
    for (const d of r.dropped ?? []) L.push(`  dropped "${d.title}": ${d.reasons.join(", ")}`);
    const shareOf = new Map((r.labels ?? []).map((l) => [l.label, l.offered] as const));
    for (const c of r.campaigns ?? []) {
      const offered = shareOf.get(c.label);
      L.push(`  campaign [${c.label}] "${c.title}" — ${c.header} · ${c.items.length} item(s)${offered ? ` of ${offered} offered (${pct(c.items.length / offered)})` : " (no labels[] entry)"}`);
      for (const it of c.items) {
        const flag = isMarkedItem({ fact: it.prFact }) ? "  ⚑ C(ii): absorbed an item marked merged across PRs" : "";
        L.push(`    ${it.id} (${it.kind})${it.header !== undefined ? ` ${it.header}` : ""}${flag}`);
        for (const b of it.bullets) L.push(`      - ${b}`);
        L.push(`      fact: ${it.prFact}`);
      }
    }
    const others = lines.filter((l) => l !== pick);
    L.push(`  other lines for this date: ${others.length}`);
    for (const o of others) {
      const x = o.record;
      L.push(`    ${o.file}:${o.line}: invoker ${x.invoker} · json ${x.json} · forced ${x.forced} · outcome ${x.outcome}${x.reason ? ` (${x.reason})` : ""} · ${gateText(x)}`);
    }
  }
  if (notGated.length) {
    L.push("");
    L.push("not gated mornings (no gate-fired line):");
    L.push(...notGated);
  }

  const s = summariseRecapOutcomes(chosen);
  const shares = chosen.flatMap((r) => { const b = largestCampaignShare(r); return b && b.share !== null ? [{ date: r.date, ...b }] : []; });
  const top = shares.reduce<(typeof shares)[number] | undefined>((a, b) => (!a || b.share! > a.share! ? b : a), undefined);
  const lat = chosen.map((r) => r.latencyMs);
  const withFacts = chosen.filter((r) => r.prFacts !== undefined);
  const reposUnread = withFacts.reduce((n, r) => n + r.prFacts!.reposUnread, 0);
  L.push("");
  L.push(`summary — over the chosen line of each gated date`);
  L.push(`  gated dates: ${chosen.length}`);
  L.push(`  outcomes: applied ${s.outcomes.applied} · trial ${s.outcomes.trial} · none ${s.outcomes.none} · rejected ${s.outcomes.rejected}`);
  L.push(`  mean after (applied/trial/none, a none at its before): ${s.meanAfter === null ? "n/a" : s.meanAfter.toFixed(2)} over ${s.meanAfterOver} date(s)`);
  const reasons = Object.entries(s.rejectionReasons).map(([k, n]) => `${k} ×${n}`).join(", ");
  L.push(`  rejections: ${s.rejections}${reasons ? ` — ${reasons}` : ""}`);
  L.push(`  dropped / proposed: ${s.dropped} / ${s.proposed}${s.droppedShare === null ? "" : ` (${pct(s.droppedShare)})`}`);
  L.push(`  absorbed items marked merged across PRs (C(ii)): ${chosen.reduce((n, r) => n + markedCount(r), 0)}`);
  L.push(`  page-length delta (Σ kept campaigns): +${chosen.reduce((n, r) => n + (r.campaigns?.length ?? 0), 0)}`);
  L.push(`  largest campaign's share of its label's items: ${top ? `${pct(top.share!)} (${top.date} [${top.label}] "${top.title}", ${top.items} of ${top.offered})` : "n/a"}`);
  L.push(`  latency: ${lat.length ? `mean ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)} ms · max ${Math.max(...lat)} ms` : "n/a"}`);
  L.push(`  prFacts: timedOut total ${withFacts.reduce((n, r) => n + r.prFacts!.timedOut, 0)} · reposUnread total ${reposUnread} · dates with reposUnread > 0: ${withFacts.filter((r) => r.prFacts!.reposUnread > 0).length}${withFacts.length < chosen.length ? ` · lines without prFacts: ${chosen.length - withFacts.length}` : ""}`);
  return { text: L, summary: s };
}

export async function main(argv: readonly string[], out: (line: string) => void = (l) => console.log(l)): Promise<number> {
  const files = argv.length ? [...argv] : [statePaths().recapCampaignsPath];
  const read = await readRecordFiles(files);
  for (const l of buildReport(read, files).text) out(l);
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`recap-campaigns-report failed: ${e}`); process.exit(1); });
}
