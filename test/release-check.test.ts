// test/release-check.test.ts — scripts/release-check.sh (Phase E, E7): the local pre-release gate.
//
// Nothing real is checked, built, evaluated or exported here. Each case runs the REAL script copied into a
// throwaway git repo shaped like this one — the project in a subdirectory (the monorepo layout) or at the
// root (the exported layout) — with stubs for `bun`, `bunx` and `cargo` first on PATH, and the project's
// own helpers (check-versions.sh, build-sidecar.sh, export-public.sh) committed into the fixture as stubs.
// Every stub appends `<cwd>|<argv>` to one log, so a case asserts which command ran, where, in what order.
//
// The one real thing is the eval predicate: the stub `bun` hands `bun -e` to the real bun
// (process.execPath), so the payload table below drives the script's own parse of the eval contract.
// The release check itself runs `bun run eval --json` against the real provider; no test ever does.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "release-check.sh");
const BASH = Bun.which("bash")!;
const GIT = Bun.which("git")!;
const V = "0.2.0";
/** The payload scripts/eval.ts prints on a clean run (its `--json` branch). */
const FULL = { pass: true, posture: "full", postureDetail: "posture: full", truncated: false, perRule: {}, findings: [] };

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([GIT, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd, env: { PATH: `${dirname(GIT)}:/usr/bin:/bin`, ...GIT_ENV }, stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Every stub appends `<cwd>|<argv>` to $STUB_LOG (the run's own log). */
const REC = (who: string) => `printf '%s|%s\\n' "$PWD" "${who} $*" >> "$STUB_LOG"\n`;

/** The PATH stubs, written ONCE per file and shared by every fixture: on macOS the first exec of a freshly
 *  written executable cost ~0.2 s each here (measured), so per-fixture stubs cost seconds. `bun -e` goes to
 *  the real bun before anything is logged: it is the predicate under test. */
let sharedBin: string | undefined;
function stubBin(): string {
  if (sharedBin) return sharedBin;
  const bin = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-release-check-stubs-"))), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bun"), [
    "#!/bin/sh",
    'if [ "$1" = "-e" ]; then exec "$REAL_BUN" "$@"; fi',
    REC("bun").trimEnd(),
    // Inside the export (check 8) only STUB_EXPORT_GATES_RC decides, so a worktree-side knob never leaks there.
    'case "$PWD" in */export) exit "${STUB_EXPORT_GATES_RC:-0}" ;; esac',
    'case "$*" in',
    '  "install --frozen-lockfile") exit "${STUB_INSTALL_RC:-0}" ;;',
    // STUB_TEST_READY: say so, then hold the check open for a second (the hangup case signals it there).
    '  "test") if [ -n "${STUB_TEST_READY:-}" ]; then : > "$STUB_TEST_READY"; sleep 1; fi',
    '    if [ "${STUB_TEST_RC:-0}" != 0 ]; then echo "(fail) a stub test [1.00ms]" >&2; fi; exit "${STUB_TEST_RC:-0}" ;;',
    '  "run test") exit "${STUB_GUI_TEST_RC:-0}" ;;',
    '  "run check") exit "${STUB_GUI_CHECK_RC:-0}" ;;',
    // STUB_EVAL_RECOVERIES=N: N recap-evidence parse-info lines on stderr first (the eval prints one per
    // generation that recovered a bullet), which check 6 counts for its report-only note.
    '  "run eval --json")',
    '    i=0; while [ "$i" -lt "${STUB_EVAL_RECOVERIES:-0}" ]; do',
    '      echo "parse-info [recap-evidence-pipeless]: 1 of 1 recap bullet(s) recovered (stub)" >&2; i=$((i + 1))',
    "    done",
    '    cat "$STUB_EVAL_STDOUT"',
    '    echo "[stub] eval diagnostics go to stderr" >&2',
    '    exit "${STUB_EVAL_RC:-0}" ;;',
    "esac",
    'echo "bun stub: unexpected argv: $*" >&2',
    "exit 99",
    "",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "bunx"), `#!/bin/sh\n${REC("bunx")}[ "$*" = "tsc --noEmit" ] || exit 99\ncase "$PWD" in */export) exit "\${STUB_EXPORT_GATES_RC:-0}" ;; esac\nexit "\${STUB_TSC_RC:-0}"\n`, { mode: 0o755 });
  // STUB_CARGO_REWRITES_LOCK: rewrite the tracked lockfile, as a resolution change without --locked would.
  writeFileSync(join(bin, "cargo"), [
    "#!/bin/sh",
    REC("cargo").trimEnd(),
    '[ "$*" = "test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast" ] || exit 99',
    'if [ -n "${STUB_CARGO_REWRITES_LOCK:-}" ]; then echo "# re-resolved" >> src-tauri/Cargo.lock; fi',
    'exit "${STUB_CARGO_RC:-0}"',
    "",
  ].join("\n"), { mode: 0o755 });
  return (sharedBin = bin);
}

interface Fx { base: string; repo: string; project: string; bin: string; home: string; tmp: string; log: string }

/** `layout: "monorepo"` puts the project at `repo/proj/` beside a sibling project; `"export"` puts it at
 *  the repo root with no scripts/export-public.sh, exactly as the export ships. */
function fixture(layout: "monorepo" | "export" = "monorepo"): Fx {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-release-check-")));
  const repo = join(base, "repo");
  const project = layout === "export" ? repo : join(repo, "proj");
  const bin = stubBin();
  const home = join(base, "home");
  const tmp = join(base, "tmp");
  const log = join(base, "calls.log");
  for (const d of [join(project, "scripts"), join(project, "gui", "scripts"), join(project, "gui", "src-tauri"), home, tmp]) mkdirSync(d, { recursive: true });

  copyFileSync(SCRIPT, join(project, "scripts", "release-check.sh"));
  writeFileSync(join(project, "scripts", "check-versions.sh"), `#!/bin/sh\n${REC("check-versions")}exit "\${STUB_VERSIONS_RC:-0}"\n`);
  writeFileSync(join(project, "gui", "scripts", "build-sidecar.sh"), `#!/bin/sh\n${REC("build-sidecar")}exit "\${STUB_SIDECAR_RC:-0}"\n`);
  writeFileSync(join(project, "gui", "src-tauri", "Cargo.lock"), "# a tracked lockfile\n");
  if (layout === "monorepo") {
    // The real script's output shape: the soft section sits between its own "— soft residuals" header and
    // the next "— " line, and holds either "  (none)" or one path per line. Like the real one, it creates
    // and populates the target BEFORE its sweeps, so a failed sweep leaves a populated, unswept target.
    writeFileSync(join(project, "scripts", "export-public.sh"), [
      "#!/bin/sh",
      REC("export-public").trimEnd(),
      '[ -e "$1" ] && { echo "refusing: $1 exists" >&2; exit 1; }',
      'mkdir -p "$1" && echo "{}" > "$1/package.json"',
      'echo "— export complete: $1"',
      'if [ "${STUB_EXPORT_RC:-0}" != 0 ]; then echo "✗ HARD residuals found" >&2; exit "$STUB_EXPORT_RC"; fi',
      'echo "— hard residual sweep: clean"',
      'echo "— soft residuals (fixture references to private projects; sign off before publishing):"',
      // Like the real one, it prints each residual as a path under the export target.
      'if [ -n "${STUB_SOFT:-}" ]; then printf \'%s/%s\\n\' "$1" "$STUB_SOFT"; else echo "  (none)"; fi',
      'echo "— now run the gates INSIDE the export: (cd \\"$1\\" && bun install --frozen-lockfile && bunx tsc --noEmit && bun test)"',
      "",
    ].join("\n"));
    mkdirSync(join(repo, "other"));
    writeFileSync(join(repo, "other", "README.md"), "a sibling project\n");
  }

  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  return { base, repo, project, bin, home, tmp, log };
}

interface Run { code: number; out: string; err: string; status: Record<string, string>; calls: string[] }

/** `<cwd>|<argv>` with the run-specific paths replaced by roles: wt, wt/gui, export, <export>. */
function calls(fx: Fx): string[] {
  if (!existsSync(fx.log)) return [];
  return readFileSync(fx.log, "utf8").trimEnd().split("\n").filter(Boolean).map((line) => {
    const i = line.indexOf("|");
    const cwd = line.slice(0, i).replace(/\/+$/, "");
    const argv = line.slice(i + 1).trim().replace(/\S*\/export$/, "<export>");
    const where = /\/export$/.test(cwd) ? "export"
      : /\/worktree(?:\/proj)?\/gui$/.test(cwd) ? "wt/gui"
      : /\/worktree(?:\/proj)?$/.test(cwd) ? "wt"
      : cwd;
    return `${where}| ${argv}`;
  });
}

function run(fx: Fx, args: string[], env: Record<string, string> = {}, payload: string = JSON.stringify(FULL, null, 2)): Run {
  writeFileSync(fx.log, "");
  const stdoutFile = join(fx.base, "eval.stdout");
  writeFileSync(stdoutFile, payload);
  const r = Bun.spawnSync([BASH, join(fx.project, "scripts", "release-check.sh"), ...args], {
    cwd: fx.base,
    env: {
      PATH: `${fx.bin}:${dirname(GIT)}:/usr/bin:/bin`,
      HOME: fx.home,
      REAL_BUN: process.execPath,
      RELEASE_CHECK_TMPDIR: fx.tmp,
      STUB_LOG: fx.log,
      STUB_EVAL_STDOUT: stdoutFile,
      ...GIT_ENV,
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString();
  const status: Record<string, string> = {};
  for (const m of out.matchAll(/^\[(\w+)\] .*? (PASS|FAIL|SKIP)$/gm)) status[m[1]!] = m[2]!;
  return { code: r.exitCode, out, err: r.stderr.toString(), status, calls: calls(fx) };
}

const ALL_PASS: Record<string, string> = { "1": "PASS", setup: "PASS", "2": "PASS", "3": "PASS", "4": "PASS", "5": "PASS", "6": "PASS", "7": "PASS", "8": "PASS", "9": "PASS" };
/** Check 6's report-only count of the eval's `parse-info [recap-evidence-…]` stderr lines, as printed under it. */
const RECOVERY_NOTE = (n: number) => `      recap evidence recoveries during eval: ${n} line(s) (report only; never changes the verdict)`;
/** The whole sequence an all-PASS monorepo run makes, in order. */
const EVERY_CALL = [
  "wt| bun install --frozen-lockfile",
  "wt| bunx tsc --noEmit",
  "wt| bun test",
  `wt| check-versions ${V}`,
  "wt/gui| bun install --frozen-lockfile",
  "wt/gui| build-sidecar",
  "wt/gui| bun run test",
  "wt/gui| bun run check",
  "wt/gui| cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast",
  "wt| bun run eval --json",
  "wt| export-public <export>",
  "export| bun install --frozen-lockfile",
  "export| bunx tsc --noEmit",
  "export| bun test",
];

/** One shared monorepo fixture for the cases that do not change it (each run makes and removes its own
 *  worktree; the fixture repo itself is never modified). */
let shared: Fx | undefined;
const mono = () => (shared ??= fixture("monorepo"));

describe("release-check.sh: the all-PASS run", () => {
  test("every check runs, in order, inside a detached worktree of HEAD; PASS prints the next commands", () => {
    const fx = mono();
    const head = git(fx.repo, "rev-parse", "HEAD").trim();
    const before = readdirSync(fx.tmp).sort();
    const r = run(fx, [V]);
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expect(r.status).toEqual(ALL_PASS);
    expect(r.calls).toEqual(EVERY_CALL);
    expect(r.out).toContain(`release-check: PASS — every check passed for ${V} at ${head}`);
    // The exact next commands: export THAT commit from a fresh worktree of it, then the gates inside.
    expect(r.out).toContain(`worktree add --detach "${fx.tmp}/dba-release-${V}-${head.slice(0, 12)}" ${head}`);
    expect(r.out).toContain(`/dba-release-${V}-${head.slice(0, 12)}/proj/scripts/export-public.sh" "${fx.tmp}/dba-export-${V}-${head.slice(0, 12)}"`);
    // …and the release worktree is removed afterwards, as docs/RELEASE.md step 4 does.
    expect(r.out).toContain(`worktree remove "${fx.tmp}/dba-release-${V}-${head.slice(0, 12)}"`);
    expect(r.out).toContain(`git push --no-follow-tags origin v${V}`);
    // Check 6's recovery count, exactly: the stub's default stderr line does not match, so grep -c prints
    // its one 0 (and exits 1, which the count must absorb without printing a second 0).
    expect(r.out.split("\n")).toContain(RECOVERY_NOTE(0));
    // The worktree and the whole run directory are gone, and the invoking checkout was never touched.
    expect(git(fx.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
    expect(readdirSync(fx.tmp).sort()).toEqual(before);
    expect(git(fx.repo, "status", "--porcelain")).toBe("");
    // A whole run (worktree add, every check's stub, worktree remove) in one test: under a loaded machine
    // the 5 s default expired mid-run, bun TERMed the script, and its trap made it exit 130.
  }, 60_000);

  test("the eval-integrity header is there: wiring only, the accepted posture set is the literal {\"full\"}", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("EVAL-INTEGRITY: WIRING ONLY");
    expect(src).toContain('the accepted posture set is the literal\n# {"full"}');
    expect(src).toContain("No gold case, check, threshold, rubric or counted-flag semantic is touched here.");
  });
});

describe("release-check.sh: the eval predicate (check 6) over fixture payloads", () => {
  const payload = (over: Record<string, unknown>) => JSON.stringify({ ...FULL, ...over }, null, 2);

  test("pass, posture full, not truncated, exit 0 -> PASS", () => {
    const r = run(mono(), [V], {}, payload({}));
    expect(r.code).toBe(0);
    expect(r.status["6"]).toBe("PASS");
    expect(r.out).toContain('pass: true, posture: "full", truncated: false');
  });

  // Every rejected shape fails check 6 and ONLY check 6, so the FAIL is attributable to the predicate.
  const REJECTED: [string, string, number, RegExp][] = [
    ["pass: false (a case failed; eval exits 1)", payload({ pass: false }), 1, /exited 1/],
    ["pass: false with exit 0", payload({ pass: false }), 0, /pass is false/],
    ["pass as the string \"true\"", payload({ pass: "true" }), 0, /pass is "true"/],
    ["posture degraded", payload({ posture: "degraded" }), 0, /posture is "degraded"/],
    ["posture off (by config)", payload({ posture: "off (by config)" }), 0, /posture is "off \(by config\)"/],
    ["posture unhardened (non-claude CLI)", payload({ posture: "unhardened (non-claude CLI)" }), 0, /posture is "unhardened \(non-claude CLI\)"/],
    ["posture unhardened (api provider)", payload({ posture: "unhardened (api provider)" }), 0, /posture is "unhardened \(api provider\)"/],
    ["truncated", payload({ truncated: true }), 0, /truncated is true/],
    ["truncated missing", JSON.stringify({ pass: true, posture: "full" }), 0, /truncated is undefined/],
    ["exit 2 (unknown --case filter), payload otherwise clean", payload({}), 2, /exited 2/],
    ["exit 1, payload otherwise clean", payload({}), 1, /exited 1/],
    ["empty stdout, exit 0", "", 0, /printed nothing on stdout/],
    ["garbage stdout, exit 0", "=== SUMMARY ===\nday8-tie: PASS\n", 0, /not JSON/],
    ["a JSON array", "[]", 0, /not a JSON object/],
    ["JSON null", "null", 0, /not a JSON object/],
  ];
  for (const [name, body, rc, why] of REJECTED) {
    test(`${name} -> FAIL`, () => {
      const r = run(mono(), [V], { STUB_EVAL_RC: String(rc) }, body);
      expect(r.code).toBe(1);
      expect(r.status).toEqual({ ...ALL_PASS, "6": "FAIL" });
      expect(r.out).toMatch(why);
      expect(r.out).toContain("release-check: FAIL — 1 check(s) failed");
    });
  }

  // The recovery count is a note, never part of the verdict. Its place is asserted by position inside
  // check 6's block (between its `[6] ` and the `[7] ` status lines), not as an exact list of the block's
  // lines: on a FAIL, report also prints the "failing tests:" and "last lines of" tail there.
  test("recap evidence recoveries on the eval's stderr -> counted in a note under check 6, before its verdict; check 6 still PASS", () => {
    const r = run(mono(), [V], { STUB_EVAL_RECOVERIES: "3" });
    expect(r.code).toBe(0);
    expect(r.status).toEqual(ALL_PASS);
    const lines = r.out.split("\n");
    const six = lines.findIndex((l) => l.startsWith("[6] "));
    const seven = lines.findIndex((l) => l.startsWith("[7] "));
    const note = lines.indexOf(RECOVERY_NOTE(3));
    const verdict = lines.indexOf('      pass: true, posture: "full", truncated: false');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(six);
    expect(note).toBeLessThan(verdict);
    expect(verdict).toBeLessThan(seven);
  }, 60_000);

  // The same inputs as the "exit 1, payload otherwise clean" row above, plus the knob: the count is taken
  // before check 6's early return, so a failing eval still reports it.
  test("recap evidence recoveries on a failing eval (exit 1) -> the note still prints, before the exited note; check 6 still FAIL", () => {
    const r = run(mono(), [V], { STUB_EVAL_RC: "1", STUB_EVAL_RECOVERIES: "2" }, payload({}));
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "6": "FAIL" });
    const lines = r.out.split("\n");
    const six = lines.findIndex((l) => l.startsWith("[6] "));
    const seven = lines.findIndex((l) => l.startsWith("[7] "));
    const note = lines.indexOf(RECOVERY_NOTE(2));
    const exited = lines.findIndex((l) => l.startsWith("      bun run eval --json exited 1;"));
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(six);
    expect(note).toBeLessThan(exited);
    expect(exited).toBeLessThan(seven);
  }, 60_000);
});

describe("release-check.sh: every check runs, whatever failed before it", () => {
  test("a failing early check (tsc) -> FAIL, and every later check still ran", () => {
    const r = run(mono(), [V], { STUB_TSC_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "2": "FAIL" });
    expect(r.calls).toEqual(EVERY_CALL);
  });

  test("several failing checks -> each reported FAIL, the rest PASS, nothing skipped", () => {
    const r = run(mono(), [V], { STUB_TSC_RC: "1", STUB_TEST_RC: "1", STUB_VERSIONS_RC: "1", STUB_CARGO_RC: "1", STUB_EXPORT_GATES_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "2": "FAIL", "3": "FAIL", "4": "FAIL", "5": "FAIL", "8": "FAIL" });
    expect(r.out).toContain("release-check: FAIL — 5 check(s) failed");
    // export| bun install is the one command check 8 reaches before its stub fails the chain.
    expect(r.calls).toEqual(EVERY_CALL.slice(0, -2));
  });

  test("a failing GUI suite still runs svelte-check and cargo test", () => {
    const r = run(mono(), [V], { STUB_GUI_TEST_RC: "1" });
    expect(r.status).toEqual({ ...ALL_PASS, "5": "FAIL" });
    expect(r.calls).toEqual(EVERY_CALL);
    expect(r.out).toContain("failed: 'bun run test'");
  });

  test("the GUI gate needs the host sidecar: a failed build-sidecar.sh fails check 5 before cargo", () => {
    const r = run(mono(), [V], { STUB_SIDECAR_RC: "1" });
    expect(r.status).toEqual({ ...ALL_PASS, "5": "FAIL" });
    expect(r.calls.filter((c) => c.startsWith("wt/gui|"))).toEqual(["wt/gui| bun install --frozen-lockfile", "wt/gui| build-sidecar"]);
    expect(r.calls).toContain("wt| bun run eval --json");
  });

  test("a failed export -> check 7 FAIL, check 8 FAIL as not run, though the failed export left a populated target", () => {
    const r = run(mono(), [V], { STUB_EXPORT_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "7": "FAIL", "8": "FAIL" });
    expect(r.calls).toContain("wt| export-public <export>");
    expect(r.out).toContain("not run: check 7 produced no export that passed its sweep");
    expect(r.calls.some((c) => c.startsWith("export|"))).toBe(false);
  });

  test("a check that rewrites a tracked file (a re-resolved Cargo.lock) -> check 7 refuses to export, 8 not run, 9 FAIL naming it", () => {
    const r = run(mono(), [V], { STUB_CARGO_REWRITES_LOCK: "1" });
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "7": "FAIL", "8": "FAIL", "9": "FAIL" });
    expect(r.out).toContain("the worktree's tracked files no longer match HEAD");
    expect(r.out).toMatch(/^ +M proj\/gui\/src-tauri\/Cargo\.lock$/m);
    // Nothing was exported from the rewritten tree, and nothing was gated as if it had been.
    expect(r.calls.some((c) => c.startsWith("wt| export-public"))).toBe(false);
    expect(r.calls.some((c) => c.startsWith("export|"))).toBe(false);
  });

  test("the exported layout: a rewritten tracked file still fails check 9", () => {
    const fx = fixture("export");
    const r = run(fx, [V], { STUB_CARGO_REWRITES_LOCK: "1" });
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "7": "SKIP", "8": "SKIP", "9": "FAIL" });
    expect(r.out).toMatch(/^ +M gui\/src-tauri\/Cargo\.lock$/m);
  });

  test("a hangup -> the run exits 129 through its trap, and the worktree is still removed", async () => {
    const fx = fixture("monorepo");
    writeFileSync(fx.log, "");
    const ready = join(fx.base, "test-started");
    const proc = Bun.spawn([BASH, join(fx.project, "scripts", "release-check.sh"), V], {
      cwd: fx.base,
      env: {
        PATH: `${fx.bin}:${dirname(GIT)}:/usr/bin:/bin`, HOME: fx.home, REAL_BUN: process.execPath,
        RELEASE_CHECK_TMPDIR: fx.tmp, STUB_LOG: fx.log, STUB_EVAL_STDOUT: join(fx.base, "none"), STUB_TEST_READY: ready, ...GIT_ENV,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(ready)).toBe(true);
    proc.kill("SIGHUP");
    const code = await proc.exited;
    // A trapped hangup is a normal exit (129) once the in-flight check returns; untrapped, bash dies of the
    // signal itself (no exit code), which is what this pins against.
    expect({ code, signal: proc.signalCode }).toEqual({ code: 129, signal: null });
    expect(git(fx.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
  }, 60_000);

  test("the logs are kept when anything failed, and the worktree is removed all the same", () => {
    const fx = mono();
    const r = run(fx, [V], { STUB_TEST_RC: "1" });
    expect(r.code).toBe(1);
    // The failing test is named, not just counted.
    expect(r.out).toContain("failing tests:\n      | (fail) a stub test");
    const kept = /logs kept in (\S+)/.exec(r.out + r.err)?.[1];
    expect(kept && existsSync(join(kept, "3.log"))).toBe(true);
    expect(git(fx.repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(1);
    expect(existsSync(join(dirname(kept!), "worktree"))).toBe(false);
  });
});

describe("release-check.sh: the soft residuals (check 7)", () => {
  const RESIDUAL = "test/fixtures/some-private-project.test.ts";

  test("residuals without --soft-ok -> FAIL, printed, and check 8 still runs", () => {
    const r = run(mono(), [V], { STUB_SOFT: RESIDUAL });
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "7": "FAIL" });
    // Listed relative to the export (the script prints absolute paths), so it reads as the repo's own.
    expect(r.out).toContain(`\n        ${RESIDUAL}\n`);
    expect(r.out).toContain("re-run with --soft-ok");
    expect(r.calls).toEqual(EVERY_CALL);
  });

  test("residuals with --soft-ok -> PASS, and still printed", () => {
    const r = run(mono(), [V, "--soft-ok"], { STUB_SOFT: RESIDUAL });
    expect(r.code).toBe(0);
    expect(r.status).toEqual(ALL_PASS);
    expect(r.out).toContain(RESIDUAL);
    expect(r.out).toContain("accepted with --soft-ok");
  });

  test("the (none) line -> PASS without --soft-ok", () => {
    const r = run(mono(), [V]);
    expect(r.status["7"]).toBe("PASS");
    expect(r.out).toContain("soft residuals: (none)");
  });
});

describe("release-check.sh: check 1 and the worktree", () => {
  test("an untracked file in the project -> check 1 FAIL; the rest still run against HEAD", () => {
    const fx = fixture("monorepo");
    writeFileSync(join(fx.project, "stray.txt"), "x");
    const r = run(fx, [V]);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "1": "FAIL" });
    expect(r.out).toMatch(/\?\? (?:proj\/)?stray\.txt/);
    expect(r.calls).toEqual(EVERY_CALL);
  });

  test("an untracked file still fails check 1 when the repo sets status.showUntrackedFiles=no", () => {
    const fx = fixture("monorepo");
    git(fx.repo, "config", "status.showUntrackedFiles", "no");
    // Inside an untracked directory too: `all` lists the file itself.
    mkdirSync(join(fx.project, "stray-dir"));
    writeFileSync(join(fx.project, "stray-dir", "stray.txt"), "x");
    expect(git(fx.repo, "status", "--porcelain")).toBe("");   // the config does hide it from a plain status
    const r = run(fx, [V]);
    expect(r.code).toBe(1);
    expect(r.status["1"]).toBe("FAIL");
    expect(r.out).toMatch(/\?\? proj\/stray-dir\/stray\.txt/);
  });

  test("check 1 notes, without failing, whether HEAD is in origin/main (as last fetched)", () => {
    const fx = fixture("monorepo");
    // No origin/main at all.
    let r = run(fx, [V]);
    expect(r.status["1"]).toBe("PASS");
    expect(r.out).toContain("NOTE: there is no origin/main here");
    // origin/main at HEAD: nothing to note.
    git(fx.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    r = run(fx, [V]);
    expect(r.status["1"]).toBe("PASS");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("NOTE:");
    // HEAD one commit past origin/main: noted, and still a PASS.
    appendFileSync(join(fx.repo, "other", "README.md"), "more\n");
    git(fx.repo, "commit", "-qam", "unmerged");
    r = run(fx, [V]);
    expect(r.status["1"]).toBe("PASS");
    expect(r.code).toBe(0);
    expect(r.out).toContain("NOTE: HEAD is not in origin/main (as last fetched)");
  });

  test("a modified tracked file -> check 1 FAIL", () => {
    const fx = fixture("monorepo");
    writeFileSync(join(fx.project, "scripts", "check-versions.sh"), "#!/bin/sh\nexit 0\n");
    const r = run(fx, [V]);
    expect(r.status["1"]).toBe("FAIL");
    expect(r.code).toBe(1);
  });

  test("dirt in a sibling project of the monorepo is not this project's -> check 1 PASS", () => {
    const fx = fixture("monorepo");
    writeFileSync(join(fx.repo, "other", "README.md"), "changed\n");
    const r = run(fx, [V]);
    expect(r.code).toBe(0);
    expect(r.status["1"]).toBe("PASS");
  });

  test("not a git checkout -> FAIL, and no check runs against anything", () => {
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-release-check-nogit-")));
    mkdirSync(join(base, "scripts"));
    mkdirSync(join(base, "tmp"));
    copyFileSync(SCRIPT, join(base, "scripts", "release-check.sh"));
    const fx = mono();
    const r = Bun.spawnSync([BASH, join(base, "scripts", "release-check.sh"), V], {
      cwd: base,
      env: { PATH: `${fx.bin}:${dirname(GIT)}:/usr/bin:/bin`, HOME: fx.home, REAL_BUN: process.execPath, RELEASE_CHECK_TMPDIR: join(base, "tmp"), ...GIT_ENV, GIT_CEILING_DIRECTORIES: dirname(base) },
      stdout: "pipe", stderr: "pipe",
    });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(1);
    expect(out.match(/ FAIL$/gm)?.length).toBe(10);
    expect(out).toContain("not run: there is no worktree");
  });

  test("the exported layout (no export-public.sh) -> checks 7-8 SKIP with a note; PASS says not to tag this tree", () => {
    const fx = fixture("export");
    const head = git(fx.repo, "rev-parse", "HEAD").trim();
    const r = run(fx, [V]);
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expect(r.status).toEqual({ ...ALL_PASS, "7": "SKIP", "8": "SKIP" });
    expect(r.out).toContain("scripts/export-public.sh is absent: this is the exported tree");
    expect(r.calls).toEqual(EVERY_CALL.slice(0, 10));
    // The exported tree is never tagged from here: only the sha docs/RELEASE.md step 5 recorded, from a
    // monorepo export, is (never a commit made directly in the public repo).
    expect(r.out).toContain("this checkout is the exported tree: do not tag it");
    expect(r.out).toContain(`tag only the sha docs/RELEASE.md step 5 recorded for the monorepo export of v${V}`);
    expect(r.out).toContain("steps 5-7");
    expect(r.out).not.toContain(`git tag v${V} ${head}`);
    expect(r.out).not.toMatch(/^\s*git tag /m);
  }, 60_000);
});

describe("release-check.sh: arguments", () => {
  test("no version, two versions, an unknown flag, or the dropped --allow-dirty -> usage, exit 2, nothing run", () => {
    for (const args of [[], [V, "0.2.1"], [V, "--force"], [V, "--allow-dirty"]]) {
      const r = run(mono(), args);
      expect(`${JSON.stringify(args)} -> ${r.code}`).toBe(`${JSON.stringify(args)} -> 2`);
      expect(r.err).toContain("usage: bash scripts/release-check.sh <version> [--soft-ok]");
      expect(r.calls).toEqual([]);
    }
  });
});
