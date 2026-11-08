// scripts/eval-calendar.ts — the CALENDAR EVAL SET, run on demand (v0.3.0 plan M6b, user-directed; spec r4 §10).
//   run: bun run scripts/eval-calendar.ts [--case <name>] [--variant locked|unlocked] [--json]
//
// SEPARATE FROM `bun run eval` (scripts/eval.ts) AND FROM THE RELEASE GATE. It runs the calendar cases
// (src/eval/calendar-cases.ts) through the REAL pipeline with YOUR configured provider, once per case per
// variant, and writes its own report to `<state dir>/eval-calendar-<date>.md`. It never touches EVAL.md, the
// gold set or the gate, and its exit code (1 when any case fails or errors) is for whoever runs it — nothing
// in the release path reads it. Not run in `bun test`: it calls the real provider and costs one model call
// per case per variant.
//
// The two variants (spec §6):
//   • locked   — your provider as configured. It counts as locked only if the attempt really sent the locked
//                prompt: a claude CLI with hardening on and only allow-listed argv, or an API provider. A case
//                whose attempt sent the other variant is reported as an ERROR (it measured something else).
//   • unlocked — the same provider with `harden: false`.
// The calendar itself is synthetic (a fake calendar step), so no calendar link, app or network is read.
import { loadConfig, resolveAccounts } from "../src/config";
import { resolveForScript } from "../src/account";
import { buildProvider } from "../src/providerFactory";
import { supportDir, localDateStr } from "../src/marker";
import { postureLine, mergeWarnings } from "../src/eval/posture";
import { CALENDAR_CASES, runCalendarCase, type CalendarFinding } from "../src/eval/calendar-cases";
import { stripControlLines } from "../src/render";
import { redactCredentials } from "../src/transcripts/credentials";
import type { PromptVariant } from "../src/types";
import { homedir } from "node:os";
import { join } from "node:path";

type Row = { name: string; variant: PromptVariant; pass: boolean; findings: CalendarFinding[]; error?: string; posture: string };

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : undefined; };
  const caseFilter = flag("--case");
  const variantFilter = flag("--variant");
  const json = argv.includes("--json");
  if (variantFilter !== undefined && variantFilter !== "locked" && variantFilter !== "unlocked") {
    console.error(`--variant must be locked or unlocked, got ${JSON.stringify(variantFilter)}`);
    return 2;
  }
  const cases = CALENDAR_CASES.filter((c) => caseFilter === undefined || c.name === caseFilter);
  if (cases.length === 0) {
    console.error(`no calendar case named ${JSON.stringify(caseFilter)}; known: ${CALENDAR_CASES.map((c) => c.name).join(", ")}`);
    return 2;
  }
  const variants: PromptVariant[] = variantFilter ? [variantFilter as PromptVariant] : ["locked", "unlocked"];
  const cfg = await loadConfig();
  const rows: Row[] = [];
  for (const cc of cases) {
    for (const variant of variants) {
      const providerCfg = variant === "unlocked" ? { ...cfg.provider, harden: false } : cfg.provider;
      // Same account selection as scripts/eval.ts: the injected provider honours limit marks, records none.
      const acct = await resolveForScript(resolveAccounts(cfg.provider.accounts, homedir()).accounts, new Date());
      const provider = buildProvider(providerCfg, { timeoutMs: cfg.provider.timeoutMs, ...(acct.env ? { env: acct.env } : {}) }).provider;
      if (!json) console.error(`calendar eval: ${cc.name} (${variant})…`);
      try {
        const r = await runCalendarCase(cc, variant, provider, providerCfg);
        rows.push({ name: cc.name, variant, pass: r.pass, findings: r.findings, posture: postureLine(mergeWarnings(r.struct, provider)) });
      } catch (e) {
        rows.push({ name: cc.name, variant, pass: false, findings: [], error: String(e), posture: postureLine(mergeWarnings(provider, e)) });
      }
    }
  }
  const anyFail = rows.some((r) => !r.pass);
  const date = localDateStr(new Date());
  if (json) {
    console.log(JSON.stringify({ pass: !anyFail, rows }, null, 2));
  } else {
    const lines = [
      `# Calendar eval — ${date}`,
      "",
      "Separate from the gold-set eval and the release gate (spec r4 §10); one live run per case per variant. The",
      "checks are text heuristics over model output plus a read-back of the prompt each attempt sent; a FAIL names",
      "the line that tripped it, so read it before acting.",
      "",
    ];
    for (const r of rows) {
      const cc = CALENDAR_CASES.find((c) => c.name === r.name)!;
      lines.push(`## ${r.name} — ${r.variant}: ${r.error ? "ERROR" : r.pass ? "PASS" : "FAIL"}`);
      lines.push(`failure mode: ${cc.failureMode}`);
      lines.push(r.posture);
      if (r.error) lines.push(`error: ${r.error}`);
      for (const f of r.findings) lines.push(`- [${f.rule}] ${f.detail}`);
      lines.push("");
    }
    lines.push(`summary: ${rows.filter((r) => r.pass).length}/${rows.length} pass`);
    const report = redactCredentials(stripControlLines(lines.join("\n")));
    console.log(report);
    const out = join(supportDir(), `eval-calendar-${date}.md`);
    try { await Bun.write(out, report); console.error(`\nSaved: ${out}`); } catch (e) { console.error(`could not save report: ${e}`); }
  }
  return anyFail ? 1 : 0;
}

if (import.meta.main) main().then((code) => process.exit(code)).catch((e) => { console.error(`calendar eval failed: ${e}`); process.exit(1); });
