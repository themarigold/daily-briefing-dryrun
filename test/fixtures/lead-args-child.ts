// test/fixtures/lead-args-child.ts — run as a CHILD process by test/git.lead-args.test.ts, so that git's
// own `GIT_TRACE` record can be taken of the morning's calls: Bun hands a spawned child the environment
// it started with, not later edits to `process.env` (measured, bun 1.3.14), and `runGit` takes no `env`,
// so the variable has to be in this process's environment from the start. A fresh process also starts
// with `windowArgs`' version cache empty, so the probe is part of the record.
//
// argv: <repo> <windowStartIso> <nowIso>. Prints the merges' PR numbers and the members' read count as JSON.
import { listDefaultRefMerges, mergeMembers, type GitBudget } from "../../src/git";

const [repo, ws, now] = process.argv.slice(2) as [string, string, string];
function seqBudget(vals: number[]): GitBudget {
  let i = 0;
  return { remainingMs: () => 60_000, callTimeoutMs: () => vals[i++] };
}
const r = await listDefaultRefMerges(repo, new Date(ws), new Date(now), seqBudget([7001, 7002, 7003]));
const m = await mergeMembers(repo, r.merges, seqBudget([7004]));
console.log(JSON.stringify({ prs: r.merges.map((x) => x.pr?.number ?? null), read: m.read }));
