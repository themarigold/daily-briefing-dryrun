// The private monorepo's CI runs `cargo test` only when a pull request's diff reaches the cargo leg's
// inputs (.github/workflows/daily-briefing-ci.yml, step `cargo-gate`). A skipped cargo leg reports as
// passing to scripts/merge-pr.sh, so the gate is only as safe as its input list is complete. This file
// holds it to that:
//
//   1. the gate script itself, run as GitHub runs it (`shell: bash`) against a fake `gh`: it fails OPEN
//      (runs cargo) on a push, a gh failure, an empty list and a list at the compare API's 300-file cap,
//      and it skips only when no changed path is under a listed prefix or equal to a listed file;
//   2. coverage: every path a cargo source (gui/src-tauri/**/*.rs) names that resolves to an existing
//      FILE outside src-tauri is covered by the list;
//   3. the cache workflow (daily-briefing-cargo-cache.yml) saves what the CI restores: the same key,
//      the same paths and the same CARGO_* environment.
//
// What (2) does NOT prove: it reads string literals, so a path assembled at run time (format!, a
// loop over a directory, a path read out of a data file such as size-budget.json) is invisible to it;
// and it checks files only, so a literal naming a DIRECTORY outside src-tauri (a join base such as
// engine_root()'s "../..") is ignored — the files read under it are literals of their own and are
// checked. A new cross-read written any of those ways must be added to CARGO_INPUTS by hand.
//
// Monorepo only: the public export carries neither workflow.
import { test, expect, describe } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const IN_MONOREPO = existsSync(`${ROOT}publish`);
const REPO = resolve(ROOT, "..");
const CI = join(REPO, ".github/workflows/daily-briefing-ci.yml");
const CACHE = join(REPO, ".github/workflows/daily-briefing-cargo-cache.yml");
const SRC_TAURI = join(ROOT, "gui/src-tauri");

type Step = { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> };
type Workflow = { env?: Record<string, string>; jobs: Record<string, { steps: Step[] }> };
const load = (p: string): Workflow => Bun.YAML.parse(readFileSync(p, "utf8")) as Workflow;
const steps = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((j) => j.steps);

/** CARGO_INPUTS, one entry per non-blank line. */
const inputsOf = (gate: Step): string[] => gate.env!.CARGO_INPUTS!.split("\n").map((l) => l.trim()).filter(Boolean);
const covered = (path: string, inputs: string[]): boolean =>
  inputs.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));

/** The jq expression the gate hands gh; the fake gh below refuses any other, so the rename handling
 * this file relies on cannot change unseen. */
const JQ = ".files[]? | .filename, (.previous_filename // empty)";

describe.skipIf(!IN_MONOREPO)("daily-briefing-ci.yml cargo-gate", () => {
  const wf = IN_MONOREPO ? load(CI) : ({ jobs: {} } as Workflow);
  const gate = steps(wf).find((s) => s.id === "cargo-gate");

  test("the gate exists, and every cargo-leg step is conditional on it", () => {
    expect(gate?.run).toBeDefined();
    const all = steps(wf);
    const cargoSteps = all.filter((s) => /cargo test|build-sidecar|apt-get|rustup|actions\/cache@/.test(`${s.run ?? ""} ${s.uses ?? ""}`));
    expect(cargoSteps.length).toBe(5);
    for (const s of cargoSteps) expect(`${s.name ?? s.uses}: ${(s as { if?: string }).if}`).toBe(`${s.name ?? s.uses}: steps.cargo-gate.outputs.run == 'true'`);
    // Nothing after the gate other than the cargo leg and the vite build, and the gate comes after every
    // other suite (so a failing engine or GUI suite never pays for a cargo build).
    const at = all.indexOf(gate!);
    expect(all.slice(at + 1).filter((s) => !cargoSteps.includes(s)).map((s) => s.run)).toEqual(["bun run build"]);
    expect(all.slice(0, at).map((s) => s.run).filter((r) => r?.startsWith("bun "))).toEqual([
      "bun install --frozen-lockfile", "bun test", "bun install --frozen-lockfile", "bun run test", "bun run check",
    ]);
  });

  // ── 1. the script, against a fake gh ──────────────────────────────────────────────────────────
  const dir = IN_MONOREPO ? removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cargo-gate-"))) : "";
  if (IN_MONOREPO) {
    writeFileSync(join(dir, "gh"), [
      "#!/bin/bash",
      `[ "$1 $2" = "api repos/o/r/compare/main...abc" ] || { echo "fake gh: unexpected args: $*" >&2; exit 9; }`,
      `[ "$3" = "--jq" ] && [ "$4" = '${JQ}' ] || { echo "fake gh: unexpected jq: $4" >&2; exit 9; }`,
      `[ "$FAKE_GH" = fail ] && { echo "gh: HTTP 502" >&2; exit 1; }`,
      `cat "$FAKE_FILES"`,
    ].join("\n"));
    chmodSync(join(dir, "gh"), 0o755);
  }
  /** Run the gate as GitHub's `shell: bash` does; returns the `run` output and the log. */
  const runGate = (event: string, files: string[] | "fail"): { run: string; log: string; code: number } => {
    const out = join(dir, `out-${Math.random().toString(36).slice(2)}`);
    const list = join(dir, `files-${Math.random().toString(36).slice(2)}`);
    writeFileSync(out, "");
    writeFileSync(list, files === "fail" ? "" : files.map((f) => `${f}\n`).join(""));
    const script = join(dir, "gate.sh");
    writeFileSync(script, gate!.run!);
    const p = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`, GITHUB_OUTPUT: out, EVENT: event, REPO: "o/r", BASE: "main", HEAD_SHA: "abc",
        CARGO_INPUTS: gate!.env!.CARGO_INPUTS!, FAKE_GH: files === "fail" ? "fail" : "ok", FAKE_FILES: list,
      },
    });
    const outputs = readFileSync(out, "utf8").trim().split("\n");
    expect(outputs.length).toBe(1);
    return { run: outputs[0]!, log: p.stdout.toString() + p.stderr.toString(), code: p.exitCode };
  };
  const D = "daily_briefing_application";
  const engineOnly = [`${D}/test/render.test.ts`, `${D}/src/generator.ts`, `${D}/docs/INSTALL.md`];

  test("a push always runs cargo (main is never gated)", () => {
    const r = runGate("push", engineOnly);
    expect([r.code, r.run]).toEqual([0, "run=true"]);
  });

  test("fails open: a gh failure, an empty list and a list at the 300-path cap all run cargo", () => {
    for (const files of ["fail", [], Array.from({ length: 300 }, (_, i) => `${D}/test/t${i}.test.ts`)] as const) {
      const r = runGate("pull_request", files as string[] | "fail");
      expect(`${r.code} ${r.run}: ${r.log}`).toStartWith("0 run=true: ");
    }
  });

  test("skips only when no changed path is a cargo input — and 299 non-inputs still skip", () => {
    expect(runGate("pull_request", engineOnly).run).toBe("run=false");
    expect(runGate("pull_request", Array.from({ length: 299 }, (_, i) => `${D}/test/t${i}.test.ts`)).run).toBe("run=false");
  });

  test("a prefix entry matches everything under it; an exact entry matches only itself", () => {
    for (const hit of [`${D}/gui/src-tauri/src/lib.rs`, `${D}/gui/src-tauri/Cargo.lock`, `${D}/src/schedule/units.ts`, `${D}/src/json.ts`,
      `${D}/LICENSE`, ".github/workflows/daily-briefing-ci.yml"]) {
      expect(`${hit}: ${runGate("pull_request", [...engineOnly, hit]).run}`).toBe(`${hit}: run=true`);
    }
    for (const miss of [`${D}/src/json.tsx`, `${D}/src/jsonx.ts`, `${D}/src/schedule`, `${D}/LICENSE.md`, `${D}/gui/src-tauri-notes.md`,
      `x/${D}/src/json.ts`]) {
      expect(`${miss}: ${runGate("pull_request", [...engineOnly, miss]).run}`).toBe(`${miss}: run=false`);
    }
  });

  test("CARGO_INPUTS: every exact entry is an existing file and every prefix an existing directory", () => {
    const inputs = inputsOf(gate!);
    expect(inputs.length).toBeGreaterThan(10);
    for (const p of inputs) {
      const abs = join(REPO, p);
      const ok = existsSync(abs) && (p.endsWith("/") ? statSync(abs).isDirectory() : statSync(abs).isFile());
      expect(`${p}: ${ok}`).toBe(`${p}: true`);
    }
  });

  // ── 2. coverage ───────────────────────────────────────────────────────────────────────────────
  /** Every .rs file under src-tauri (target/ and the generated gen/ excluded). */
  const rustFiles = (): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "target" || e.name === "gen" || e.name === "node_modules") continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".rs")) out.push(p);
      }
    };
    walk(SRC_TAURI);
    return out;
  };
  /** Repo-relative paths of existing FILES outside src-tauri that a literal in `text` (from file `at`)
   * resolves to, against each base a cargo source uses: the file's own directory (include_str!), the
   * crate (CARGO_MANIFEST_DIR, src_tauri()), the GUI package, and the engine root (engine_root()). */
  const crossReads = (at: string, text: string): string[] => {
    const bases = [dirname(at), SRC_TAURI, join(ROOT, "gui"), ROOT];
    const hits = new Set<string>();
    for (const m of text.matchAll(/"((?:[^"\\\n]|\\.){1,200})"/g)) {
      const lit = m[1]!;
      if (/\s|^\/|:\/\/|[{}$*<>|]/.test(lit) || !/[./]/.test(lit)) continue;
      for (const b of bases) {
        const abs = resolve(b, lit);
        if (!abs.startsWith(REPO + "/") || abs.startsWith(SRC_TAURI + "/") || abs === SRC_TAURI) continue;
        if (existsSync(abs) && statSync(abs).isFile()) hits.add(relative(REPO, abs));
      }
    }
    return [...hits];
  };

  test("every file a cargo source names outside src-tauri is a cargo input", () => {
    const inputs = inputsOf(gate!);
    const all = new Map<string, string>();
    for (const f of rustFiles()) for (const h of crossReads(f, readFileSync(f, "utf8"))) all.set(h, relative(REPO, f));
    const uncovered = [...all].filter(([h]) => !covered(h, inputs)).map(([h, f]) => `${h} (named in ${f})`);
    expect(uncovered).toEqual([]);
    // Non-vacuity: the cross-reads the gate was built from are all found by the scan.
    // (scripts/uninstall.sh is a cross-read too, but is not named here: isolation.meta.test.ts treats any
    // test file naming it as a spawner of it.)
    for (const known of [`${D}/src/render.ts`, `${D}/src/schedule/units.ts`, `${D}/LICENSE`,
      `${D}/reader/build.sh`, `${D}/gui/src/lib/ScheduleUninstall.svelte`, `${D}/src/json.ts`]) {
      expect(`${known}: ${all.has(known)}`).toBe(`${known}: true`);
    }
  });

  test("negative control: an uncovered cross-read is reported, through each base", () => {
    const at = join(SRC_TAURI, "tests/synthetic.rs");
    for (const lit of ["../../src/main.ts", "../../../src/main.ts", "../package.json", "src/main.ts"]) {
      const hits = crossReads(at, `let x = std::fs::read_to_string("${lit}");`);
      expect(`${lit}: ${hits.some((h) => !covered(h, inputsOf(gate!)))}`).toBe(`${lit}: true`);
    }
    // ...and a literal inside src-tauri, or one naming nothing, is not.
    expect(crossReads(at, `include_str!("../src/lib.rs"); "../../etc/passwd"; "../out.json"`)).toEqual([]);
  });

  // ── 3. the cache workflow matches ─────────────────────────────────────────────────────────────
  test("daily-briefing-cargo-cache.yml saves exactly what the CI restores, built with the same settings", () => {
    const cache = load(CACHE);
    expect(cache.env).toEqual(wf.env);
    expect(Object.keys(wf.env ?? {}).sort()).toEqual(["CARGO_INCREMENTAL", "CARGO_PROFILE_DEV_DEBUG", "CARGO_PROFILE_TEST_DEBUG"]);
    const restore = steps(wf).filter((s) => s.uses?.startsWith("actions/cache@"));
    const save = steps(cache).filter((s) => s.uses?.startsWith("actions/cache@"));
    expect([restore.length, save.length]).toEqual([1, 1]);
    expect(save[0]!.uses).toBe(restore[0]!.uses);
    expect(save[0]!.with).toEqual(restore[0]!.with);
    // The cache workflow is never reachable from a pull request.
    expect(readFileSync(CACHE, "utf8")).not.toContain("pull_request");
  });
});
