// src/preflight.ts — the repo-access preflight, extracted from main.ts (A1).
//
// ⚠ WHY IT MOVED, because "it felt tidier" would not justify touching it. `doctor --json`
// (src/json.ts) needs exactly this walk, and json.ts is imported BY main.ts — so reaching back for
// it closed a module cycle. A dynamic `import("./main")` looked like a way out and is not: MEASURED,
// `bun src/main.ts doctor --json` took 20.04 s and reported `reposTimedOut: true`, because when
// main.ts is the process ENTRY its top-level `await dispatch(...)` has not finished, the module is
// still evaluating, and an `import()` of it never settles. Only doctor's own deadline broke the
// deadlock. Its own tests did not see it — they inject `preflight`, and the cycle only exists for
// the real default.
//
// The function itself is UNCHANGED, and `main.ts` re-exports it so every existing
// `import { preflightRepos } from "../src/main"` keeps working.
import { discoverRepos } from "./config";
import { probeRepos, type ProbeOpts } from "./extractor";
import type { PathIssue } from "./protectedPath";

// init-time preflight (§5.11): probe every repo we'd actually read, AND — when repos are given
// explicitly (so discovery is skipped) — still walk discoverRoots to surface a blocked root the
// user may have meant to include (e.g. a TCC-gated ~/Desktop). Reports access problems while a
// human is present to fix them, rather than silent empty briefings on the first unattended run.
export async function preflightRepos(
  cfg: Parameters<typeof discoverRepos>[0],
  opts?: ProbeOpts,
): Promise<PathIssue[]> {
  const { repos, issues } = await discoverRepos(cfg, opts);
  issues.push(...await probeRepos(repos, opts));
  if (cfg.repos?.length && cfg.discoverRoots?.length) {
    const rootWalk = await discoverRepos({ ...cfg, repos: undefined }, opts);
    issues.push(...rootWalk.issues);
  }
  // Dedup by path: an explicit repo under a discoverRoot (the normal generated config) would
  // otherwise be reported twice — once by the per-repo probe, once by the root walk.
  return [...new Map(issues.map((i) => [i.path, i])).values()];
}
