// Calibration for `VOLUME_SHARE_FLOOR` (src/postcheck.ts). Committed so the table in that docblock
// is reproducible rather than a number you have to take on faith.
//
// Replays the archived briefings in the app's support dir and, for each, counts every unit's share
// of attributed recap bullets and whether ANY suggestion names it. Answers: "what share floor would
// have flagged the real misses without crying wolf?"
//
// ⚠ BULLETS ARE A PROXY. A rendered archive carries bullets, not `windowCommits` — the value the
// rule actually scores over — so this measures the shape of the distribution, not the rule's own
// inputs. That caveat is why the floor is stated as calibrated-from-16-days rather than derived.
//
// Run: bun run scripts/probe-volume-share.ts
// names it. Answers "what share threshold would have caught the real misses without crying wolf?"
import { readdirSync, readFileSync } from "node:fs";
const dir = `${process.env.HOME}/Library/Application Support/daily-briefing/briefings`;
type Row = { day: string; label: string; n: number; share: number; suggested: boolean; total: number };
const rows: Row[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(`${dir}/${f}`, "utf8");
  const lines = text.split("\n");
  const iRecap = lines.findIndex((l) => /What you did|▶ What/.test(l));
  const iToday = lines.findIndex((l, i) => i > iRecap && /Today so far/.test(l));
  const iSugg = lines.findIndex((l) => /Suggested next/.test(l));
  if (iRecap < 0 || iSugg < 0) continue;
  const recapEnd = iToday > 0 ? iToday : iSugg;
  const counts = new Map<string, number>();
  for (const l of lines.slice(iRecap, recapEnd)) {
    const m = l.match(/^\s+[•◦]\s*\[([^\]]+)\]/);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const suggText = lines.slice(iSugg, lines.length).join("\n").toLowerCase();
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (!total) continue;
  for (const [label, n] of counts) {
    rows.push({ day: f.replace(".md", ""), label, n, share: n / total, suggested: suggText.includes(label.toLowerCase()), total });
  }
}
const misses = rows.filter((r) => !r.suggested).sort((a, z) => z.share - a.share);
console.log("UNSUGGESTED units, by share of recap bullets (the candidates a threshold would flag):");
for (const r of misses.slice(0, 14)) console.log(`  ${r.day}  ${r.label.padEnd(28)} ${r.n}/${r.total}  share=${r.share.toFixed(2)}`);
console.log(`\nUnsuggested unit-days: ${misses.length} of ${rows.length}`);
for (const t of [0.5, 0.4, 0.34, 0.3, 0.25, 0.2]) {
  const flagged = misses.filter((r) => r.share >= t);
  const days = new Set(flagged.map((r) => r.day)).size;
  console.log(`  threshold ${t.toFixed(2)} → ${flagged.length} flags across ${days} of 16 days`);
}
const argmaxMisses = rows.filter((r) => !r.suggested && r.share === Math.max(...rows.filter((x) => x.day === r.day).map((x) => x.share)));
console.log(`\nArgmax rule (today's) would flag: ${argmaxMisses.length} unit-days`);
