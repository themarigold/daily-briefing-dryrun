// Tier B (Stage-2 recap campaigns), T4.4 — the TRANSITIVE import guard (plan §2 "Import rule"; D17; K5).
//
// `core.ts` value-imports the phase module. If following VALUE imports from any of B's three new modules
// ever reached `src/core`, `src/runlock` or `src/main` — by any route, `src/json.ts` included, which
// reaches `runlock` in one hop — the app would crash at LOAD on every run, mode `off` included: under
// `bun` as a TDZ `ReferenceError` ("Cannot access … before initialization"), in the compiled binary as
// a `TypeError`. So the runtime backstop (the `bun -e` LOAD-OK guard and the compiled binary's
// `--version`, run at the checkpoints) judges exit code and output, never the error class.
//
// This static walk is the in-suite half. It OVER-approximates (a value-import that names only types
// still counts), so it can raise a false alarm but not miss a route — and it catches an import that is
// never used as a value, which the transpiler elides and the runtime guard therefore cannot see (C13).
// `importClosure` takes its comment ranges from TypeScript's own parser (since 2026-10-05). The
// hand-rolled stripper before it could misread a regex literal containing `/*` as a comment opener and
// miss imports after it — the caveat T1.1's checkpoint carried here; the load guard still backstops both.
import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { importClosure } from "./helpers/importClosure";

const PKG = resolve(import.meta.dir, "..");
const NEW_MODULES = ["src/recapCampaigns.ts", "src/recapCampaignsPhase.ts", "src/recapBudget.ts"];
const FORBIDDEN = ["src/core.ts", "src/runlock.ts", "src/main.ts", "src/json.ts"];

test("the new modules reach none of core, runlock, main", () => {
  for (const root of NEW_MODULES) {
    const closure = importClosure([root], PKG);
    expect({ root, self: closure.includes(root) }).toEqual({ root, self: true });            // the walk ran
    expect({ root, reached: FORBIDDEN.filter((f) => closure.includes(f)) }).toEqual({ root, reached: [] });
  }
  // non-vacuity: the phase's closure is the real one — it reaches the pure core and the git reader
  const phase = importClosure(["src/recapCampaignsPhase.ts"], PKG);
  for (const f of ["src/recapCampaigns.ts", "src/recapBudget.ts", "src/git.ts", "src/diag.ts"]) expect(phase).toContain(f);
  // …and the walker does see the routes it guards against, where they exist
  expect(importClosure(["src/main.ts"], PKG)).toEqual(expect.arrayContaining(["src/core.ts", "src/runlock.ts", "src/recapCampaignsPhase.ts"]));
  expect(importClosure(["src/json.ts"], PKG)).toContain("src/runlock.ts");
});

test("config.ts reaches recapCampaigns.ts by a TYPE import only (its RecapMode import stays `import type`)", () => {
  // T4.1 checkpoint (q): `config.ts` imports `RecapMode` as a type. A value edge would put the pure core
  // in the closure of `config.ts` — and so of the render and cluster goldens, whose closures hold
  // `config.ts` — and close config → recapCampaigns → audit → config.
  expect(importClosure(["src/config.ts"], PKG)).not.toContain("src/recapCampaigns.ts");
});
