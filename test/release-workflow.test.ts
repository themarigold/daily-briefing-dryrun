// test/release-workflow.test.ts — the release workflow's structure, pinned (Phase E, E5/E6).
//
// WHY THIS EXISTS. release.yml is the only path to the public repo's releases, and it runs only on a tag:
// nothing exercises it between releases, and a regression in it is found at the worst possible moment.
// actionlint (the public ci.yml's `actionlint` job) catches what is malformed; this pins what is
// well-formed but WRONG — a dropped `fail-fast: false`, a marker derivation that reads `.conclusion`, a
// secret mapped to a name Tauri reads, a retyped cross-compile loop.
//
// It parses the YAML with `Bun.YAML.parse` (no new dependency; under bun 1.3.14 it keeps `on` as a string
// key) and asserts on the PARSED structure, so comments can say anything and only behaviour is pinned.
//
// ⚠ THIS FILE RUNS IN TWO LAYOUTS, like test/publish-prep.test.ts: in the monorepo (workflows under
// publish/.github/workflows/) and in the exported public tree (.github/workflows/), whose own CI and
// release gate run `bun test`. The frozen loop copy is a tracked file under test/fixtures/, which ships.
//
// ⚠ ISOLATION SCANNER. test/isolation.meta.test.ts flags any STRING literal naming a machine-wide binary
// in command position, so every assertion about the signing commands below is a REGEX literal (the
// scanner strips those before it looks).
import { test, expect, describe } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const IN_MONOREPO = existsSync(`${ROOT}publish`);

function workflowFile(wf: string): string {
  for (const dir of ["publish/.github/workflows", ".github/workflows"]) {
    const p = `${ROOT}${dir}/${wf}`;
    if (existsSync(p)) return p;
  }
  throw new Error(`${wf} found under neither publish/.github/workflows/ nor .github/workflows/`);
}

// ── a typed view of the parsed workflow ────────────────────────────────────────────────────────────
type Env = Record<string, string>;
interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Env;
  with?: Record<string, unknown>;
  "continue-on-error"?: unknown;
  "working-directory"?: string;
  shell?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: unknown;
  "continue-on-error"?: unknown;
  permissions?: unknown;
  strategy?: { "fail-fast"?: unknown; matrix?: { include?: Record<string, string>[] } };
  defaults?: { run?: { shell?: string; "working-directory"?: string } };
  env?: Env;
  outputs?: Env;
  steps: Step[];
}
interface Workflow { on: unknown; permissions?: unknown; env?: Env; defaults?: { run?: { shell?: string; "working-directory"?: string } }; jobs: Record<string, Job> }

const parse = (wf: string): Workflow => Bun.YAML.parse(readFileSync(workflowFile(wf), "utf8")) as Workflow;
const W = parse("release.yml");
const J = W.jobs;

const BUNDLE_JOBS = ["bundle-macos", "bundle-linux", "bundle-windows"];
const ENUMERATED = ["gui-tests", "build", "stage", "size", "smoke"];
const SKIP = "the_recorded_actuals_match_a_re_stat_of_what_exists_here";

const stepById = (job: Job, id: string): Step => {
  const hits = job.steps.filter((s) => s.id === id);
  expect(`${id}: ${hits.length} step(s)`).toBe(`${id}: 1 step(s)`);
  return hits[0]!;
};
const indexOfId = (job: Job, id: string): number => job.steps.findIndex((s) => s.id === id);
const workdir = (job: Job, step: Step): string | undefined => step["working-directory"] ?? job.defaults?.run?.["working-directory"];
const allEnvMaps = (wf: Workflow): [string, Env][] => {
  const out: [string, Env][] = [];
  if (wf.env) out.push(["workflow", wf.env]);
  for (const [jn, job] of Object.entries(wf.jobs)) {
    if (job.env) out.push([jn, job.env]);
    job.steps.forEach((s, i) => { if (s.env) out.push([`${jn}.steps[${i}]`, s.env]); });
  }
  return out;
};
const runs = (job: Job): string[] => job.steps.map((s) => s.run ?? "");
/** Every runner label a job can land on, as `<job>: <label>`: its literal `runs-on`, or — for
 *  `${{ matrix.<key> }}` — every value that key takes, from the matrix's own list and its `include` rows. */
const runnerLabels = (wf: Workflow): string[] =>
  Object.entries(wf.jobs).flatMap(([jn, job]) => {
    const on = String(job["runs-on"]);
    const key = /^\$\{\{ matrix\.([\w-]+) \}\}$/.exec(on)?.[1];
    if (key === undefined) return [`${jn}: ${on}`];
    const matrix = (job.strategy?.matrix ?? {}) as Record<string, unknown> & { include?: Record<string, string>[] };
    const values = [...((matrix[key] as string[] | undefined) ?? []), ...(matrix.include ?? []).map((row) => row[key])];
    // A matrix-valued runs-on that resolves to nothing would make every assertion over it vacuous.
    expect(`${jn}: ${values.length > 0 && values.every((v) => typeof v === "string")}`).toBe(`${jn}: true`);
    return values.map((v) => `${jn}: ${v}`);
  });
/** The shell a `run:` step gets, resolved the way the runner resolved it in the M2b release run
 *  (2026-10-01): the step's own `shell`, else — when the job HAS a `defaults.run` block — that block's
 *  `shell`, else the workflow's. A job-level block REPLACES the workflow-level one; it does not merge per
 *  key: with only `working-directory: gui` at job level, bundle-windows ran every step in PowerShell and
 *  the macOS/Linux legs ran `bash -e {0}` (no pipefail), under a workflow-level `shell: bash`. */
const shellOf = (wf: Workflow, job: Job, step: Step): string | undefined =>
  step.shell ?? (job.defaults?.run !== undefined ? job.defaults.run.shell : wf.defaults?.run?.shell);
/** Every `run:` step of every job that carries its own `defaults.run` block, with its resolved shell. */
const shellsUnderJobDefaults = (wf: Workflow): string[] =>
  Object.entries(wf.jobs).filter(([, job]) => job.defaults?.run !== undefined).flatMap(([jn, job]) =>
    job.steps.flatMap((s, i) => (s.run === undefined ? [] : [`${jn}/${s.id ?? s.name ?? i}: ${shellOf(wf, job, s)}`])));

describe("release.yml: trigger, permissions, jobs", () => {
  test("the trigger is exactly a v* tag push — no pull_request leg, so secrets stay unreachable from forks", () => {
    expect(W.on).toEqual({ push: { tags: ["v*"] } });
    expect(JSON.stringify(W.on)).not.toContain("pull_request");
  });

  test("the job graph: gate -> cli-binaries || three bundle jobs -> release", () => {
    expect(Object.keys(J).sort()).toEqual(["bundle-linux", "bundle-macos", "bundle-windows", "cli-binaries", "gate", "release"]);
    for (const j of ["cli-binaries", ...BUNDLE_JOBS]) expect(`${j}: ${J[j]!.needs}`).toBe(`${j}: gate`);
    expect(J.gate!.needs).toBeUndefined();
  });

  test("workflow permissions are contents: read; only `release` gets contents: write", () => {
    expect(W.permissions).toEqual({ contents: "read" });
    expect(J.release!.permissions).toEqual({ contents: "write" });
    for (const [jn, job] of Object.entries(J)) {
      if (jn !== "release") expect(`${jn}: ${JSON.stringify(job.permissions)}`).toBe(`${jn}: undefined`);
    }
  });

  test("every bundle job has a timeout-minutes bound (and so does every other job)", () => {
    for (const [jn, job] of Object.entries(J)) {
      const t = job["timeout-minutes"];
      expect(`${jn}: ${typeof t === "number" && t > 0 && t <= 360}`).toBe(`${jn}: true`);
    }
  });

  test("the macOS matrix is fail-fast: false, so one failing leg never cancels the other", () => {
    expect(J["bundle-macos"]!.strategy?.["fail-fast"]).toBe(false);
    expect(J["bundle-macos"]!.strategy?.matrix?.include?.map((l) => [l.leg, l.triple])).toEqual([
      ["macos-arm64", "aarch64-apple-darwin"],
      ["macos-x64", "x86_64-apple-darwin"],
    ]);
  });

  test("each macOS leg runs NATIVELY: arm64 on macos-26, x64 on macos-26-intel (user-directed 2026-10-01)", () => {
    const mac = J["bundle-macos"]!;
    expect(mac["runs-on"]).toBe("${{ matrix.runner }}");
    expect(mac.strategy?.matrix?.include?.map((l) => [l.leg, l.runner, l.triple, l["lipo-arch"]])).toEqual([
      ["macos-arm64", "macos-26", "aarch64-apple-darwin", "arm64"],
      ["macos-x64", "macos-26-intel", "x86_64-apple-darwin", "x86_64"],
    ]);
  });

  test("no job in either public workflow runs on macos-14 (retired: actions/runner-images#13518)", () => {
    const C = parse("ci.yml");
    const labels = [...runnerLabels(W), ...runnerLabels(C)];
    // \b after the 14: every macos-14 variant (-large, -xlarge) is caught too.
    expect(labels.filter((l) => /\bmacos-14\b/.test(l))).toEqual([]);
    // Non-vacuity: the resolver reaches both a matrix-valued runs-on and a literal one.
    expect(labels).toContain("bundle-macos: macos-26-intel");
    expect(labels).toContain("cargo-macos: macos-26");
    // Backstop over everything a job carries (comments are not parsed, so prose may still name it).
    for (const wf of [W, C]) expect(JSON.stringify(wf.jobs)).not.toMatch(/macos-14/);
  });

  test("every run step resolves to shell: bash (Git Bash on Windows) — a job-level defaults block replaces the workflow's", () => {
    // The resolver models REPLACEMENT, not a per-key merge (a merge would have hidden the M2b failure).
    expect(shellOf({ on: null, defaults: { run: { shell: "bash" } }, jobs: {} }, { steps: [], defaults: { run: { "working-directory": "gui" } } }, { run: "x" })).toBeUndefined();
    expect(shellOf({ on: null, defaults: { run: { shell: "bash" } }, jobs: {} }, { steps: [] }, { run: "x" })).toBe("bash");
    for (const [jn, job] of Object.entries(J)) {
      const resolved = job.steps.flatMap((s, i) => (s.run === undefined ? [] : [`${jn}/${s.id ?? s.name ?? i}: ${shellOf(W, job, s)}`]));
      // Non-vacuity: every job has run steps to resolve.
      expect(`${jn}: ${resolved.length > 0}`).toBe(`${jn}: true`);
      for (const r of resolved) expect(r).toEndWith(": bash");
    }
    // The bundle jobs' blocks name it themselves (they set working-directory: gui, so the workflow's
    // `shell: bash` never reaches them).
    for (const jn of BUNDLE_JOBS) expect(`${jn}: ${J[jn]!.defaults?.run?.shell}`).toBe(`${jn}: bash`);
  });

  test("bundle-windows is informational: job-level continue-on-error: true (C3)", () => {
    expect(J["bundle-windows"]!["continue-on-error"]).toBe(true);
    for (const j of ["gate", "cli-binaries", "bundle-macos", "bundle-linux", "release"]) {
      expect(`${j}: ${J[j]!["continue-on-error"]}`).toBe(`${j}: undefined`);
    }
  });
});

describe("release.yml: bun pin and installs", () => {
  test('every job that sets up bun pins bun-version "1.3.14" in exactly that quoted form', () => {
    const text = readFileSync(workflowFile("release.yml"), "utf8");
    let setups = 0;
    for (const [jn, job] of Object.entries(J)) {
      for (const s of job.steps.filter((st) => st.uses?.startsWith("oven-sh/setup-bun@"))) {
        setups++;
        expect(`${jn}: ${s.with?.["bun-version"]}`).toBe(`${jn}: 1.3.14`);
      }
    }
    // The QUOTED form, once per setup (test/publish-prep.test.ts reads only the first match per file).
    expect(text.match(/^\s*bun-version: "1\.3\.14"\s*$/gm)?.length).toBe(setups);
    expect(text.match(/bun-version:/g)?.length).toBe(setups);
  });

  test("every job except `release` sets up bun exactly once; `release` needs no bun (collect is bash)", () => {
    // Deliberate: setup-bun is a third-party action, and `release` is the one job holding contents: write.
    for (const [jn, job] of Object.entries(J)) {
      const n = job.steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@")).length;
      expect(`${jn}: ${n}`).toBe(`${jn}: ${jn === "release" ? 0 : 1}`);
    }
  });

  test("every bundle job runs `bun install --frozen-lockfile` in gui/", () => {
    for (const jn of BUNDLE_JOBS) {
      const job = J[jn]!;
      const installs = job.steps.filter((s) => s.run?.trim() === "bun install --frozen-lockfile");
      expect(`${jn}: ${installs.map((s) => workdir(job, s)).join(",")}`).toBe(`${jn}: gui`);
    }
  });
});

describe("release.yml: gate", () => {
  const gate = J.gate!;

  test("the engine gate: frozen install, tsc, bun test, then the four-carrier version guard", () => {
    const r = runs(gate);
    const i = r.indexOf("bun install --frozen-lockfile");
    const t = r.findIndex((x) => /bunx tsc --noEmit\nbun test\n?$/.test(x));
    const v = r.indexOf('bash scripts/check-versions.sh "${GITHUB_REF_NAME#v}"');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(i);
    expect(v).toBeGreaterThan(t);
    // The old package.json-only guard is gone (check-versions.sh replaces it).
    expect(r.join("\n")).not.toMatch(/JSON\.parse\(await Bun\.file\("package\.json"\)/);
  });

  test("the signing mode is computed once, in step `signing-mode`, from the two secrets' emptiness only", () => {
    const s = stepById(gate, "signing-mode");
    expect(s.run).toContain("${{ secrets.DBA_SIGNING_P12 != '' }}");
    expect(s.run).toContain("${{ secrets.DBA_SIGNING_P12_PASSWORD != '' }}");
    expect(s.run).toMatch(/echo "mode=\$mode" >> "\$GITHUB_OUTPUT"/);
    expect(s.run).toMatch(/exactly one of DBA_SIGNING_P12 \/ DBA_SIGNING_P12_PASSWORD is set/);
    // The secrets appear ONLY as `!= ''` comparisons: no secret value is materialised anywhere in the
    // gate, in env or in the script.
    expect(JSON.stringify(s.env ?? {})).not.toContain("secrets.");
    expect(s.run!.match(/secrets\.[A-Z_0-9]+/g)).toEqual(["secrets.DBA_SIGNING_P12", "secrets.DBA_SIGNING_P12_PASSWORD"]);
    expect(s.run!.match(/\$\{\{ secrets\.[A-Z_0-9]+ != '' \}\}/g)?.length).toBe(2);
    // The identity's name is a repo VARIABLE with the documented default, exposed beside the mode.
    expect(s.env?.IDENTITY_VAR).toBe("${{ vars.DBA_SIGNING_IDENTITY }}");
    expect(s.run).toContain('identity="${IDENTITY_VAR:-Daily Briefing Release Signing}"');
    expect(gate.outputs).toEqual({
      signing: "${{ steps.signing-mode.outputs.mode }}",
      identity: "${{ steps.signing-mode.outputs.identity }}",
    });
  });

  test("the signing-mode script itself: both -> signed, neither -> unsigned, exactly one -> named failure", () => {
    const script = stepById(gate, "signing-mode").run!;
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-signing-mode-")));
    const cases: [string, string, string, number, string][] = [
      ["true", "true", "", 0, "mode=signed\nidentity=Daily Briefing Release Signing\n"],
      ["false", "false", "", 0, "mode=unsigned\nidentity=Daily Briefing Release Signing\n"],
      ["false", "false", "Developer ID Application: X (T)", 0, "mode=unsigned\nidentity=Developer ID Application: X (T)\n"],
      ["true", "false", "", 1, ""],
      ["false", "true", "", 1, ""],
    ];
    cases.forEach(([p12, pw, identity, code, output], i) => {
      const out = join(base, `out-${i}`);
      writeFileSync(out, "");
      const body = script
        .replace("${{ secrets.DBA_SIGNING_P12 != '' }}", p12)
        .replace("${{ secrets.DBA_SIGNING_P12_PASSWORD != '' }}", pw);
      const r = Bun.spawnSync(["bash", "-c", body], {
        env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: out, IDENTITY_VAR: identity },
        stdout: "pipe", stderr: "pipe",
      });
      expect(`${p12}/${pw}: ${r.exitCode}`).toBe(`${p12}/${pw}: ${code}`);
      expect(readFileSync(out, "utf8")).toBe(output);
    });
  });
});

describe("release.yml: cli-binaries", () => {
  test("the 5-target cross-compile loop is byte-identical to the mechanically extracted frozen copy", () => {
    const frozen = readFileSync(`${ROOT}test/fixtures/release-build-binaries.frozen.txt`, "utf8");
    const hits = Object.values(J).flatMap((j) => j.steps).filter((s) => s.name === "Build binaries");
    expect(hits.length).toBe(1);
    expect(J["cli-binaries"]!.steps.includes(hits[0]!)).toBe(true);
    expect(hits[0]!.run).toBe(frozen);
    // Non-vacuity: the frozen copy really is the 5-target loop.
    expect(frozen.match(/bun build --compile/g)?.length).toBe(2);
    expect(frozen).toContain("for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do");
  });

  test("the binaries are uploaded flat as `cli-binaries`", () => {
    const up = J["cli-binaries"]!.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(up.map((s) => s.with)).toEqual([{ name: "cli-binaries", path: "dist/daily-briefing-*", "if-no-files-found": "error" }]);
  });
});

describe("release.yml: bundle legs", () => {
  const mac = J["bundle-macos"]!;
  const linux = J["bundle-linux"]!;
  const win = J["bundle-windows"]!;

  test("exactly one ci-tauri-build.sh call per leg, step id `build`, each with an explicit mode argument", () => {
    for (const [jn, job] of Object.entries(J)) {
      const calls = job.steps.filter((s) => s.run?.includes("ci-tauri-build.sh"));
      expect(`${jn}: ${calls.length}`).toBe(`${jn}: ${BUNDLE_JOBS.includes(jn) ? 1 : 0}`);
      if (calls.length) expect(`${jn}: ${calls[0]!.id}`).toBe(`${jn}: build`);
    }
    const macBuild = stepById(mac, "build");
    expect(macBuild.run).toBe('bash scripts/ci-tauri-build.sh "$TRIPLE" "$SIGNING"');
    expect(macBuild.env?.SIGNING).toBe("${{ needs.gate.outputs.signing }}");
    expect(mac.env?.TRIPLE).toBe("${{ matrix.triple }}");
    expect(stepById(linux, "build").run).toBe("bash scripts/ci-tauri-build.sh x86_64-unknown-linux-gnu unsigned");
    expect(stepById(win, "build").run).toBe("bash scripts/ci-tauri-build.sh x86_64-pc-windows-msvc unsigned");
    for (const job of [mac, linux, win]) expect(workdir(job, stepById(job, "build"))).toBe("gui");
  });

  test("the macOS legs read the gate's signing mode (import, build, smoke); Linux and Windows never do", () => {
    const imp = mac.steps.find((s) => s.name?.startsWith("Import signing identity"))!;
    expect(imp.if).toBe("needs.gate.outputs.signing == 'signed'");
    expect(stepById(mac, "smoke").env?.SIGNING).toBe("${{ needs.gate.outputs.signing }}");
    expect(stepById(mac, "smoke").env?.IDENTITY).toBe("${{ needs.gate.outputs.identity }}");
    for (const job of [linux, win]) expect(JSON.stringify(job)).not.toContain("needs.gate.outputs");
  });

  test("the import step: a named keychain, the identity to $GITHUB_ENV, before the build", () => {
    const i = mac.steps.findIndex((s) => s.name?.startsWith("Import signing identity"));
    const imp = mac.steps[i]!;
    expect(i).toBeGreaterThan(indexOfId(mac, "gui-tests"));
    expect(i).toBeLessThan(indexOfId(mac, "build"));
    expect(imp.env).toEqual({
      P12_BASE64: "${{ secrets.DBA_SIGNING_P12 }}",
      P12_PASSWORD: "${{ secrets.DBA_SIGNING_P12_PASSWORD }}",
      IDENTITY: "${{ needs.gate.outputs.identity }}",
    });
    const run = imp.run!;
    expect(run).toMatch(/keychain="\$RUNNER_TEMP\/dba-signing\.keychain-db"/);
    // Tauri's own sequence (tauri-macos-sign keychain.rs), in order.
    const order = [/ create-keychain -p /, / unlock-keychain -p /, / set-keychain-settings -t \d+ -u /, / import "\$p12" -k "\$keychain" -P "\$P12_PASSWORD" -T \/usr\/bin\/codesign/, / set-key-partition-list -S apple-tool:,apple:,codesign: -s -k /, / list-keychains -d user -s "\$keychain"/];
    const at = order.map((re) => run.search(re));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The keychain stays unlocked for longer than the job can run.
    const lock = Number(/set-keychain-settings -t (\d+) -u/.exec(run)![1]);
    expect(lock).toBeGreaterThanOrEqual(Number(mac["timeout-minutes"]) * 60);
    expect(run).toMatch(/echo "APPLE_SIGNING_IDENTITY=\$IDENTITY" >> "\$GITHUB_ENV"/);
    expect(run).not.toMatch(/export APPLE_SIGNING_IDENTITY/);
  });

  test("the import step proves the identity is LISTED in the CI keychain (not -v) before handing it on", () => {
    const run = mac.steps.find((s) => s.name?.startsWith("Import signing identity"))!.run!;
    // Listed, not -v: a self-signed identity is untrusted ("0 valid") yet codesign signs with it
    // (measured, docs/spikes/spk-2-gatekeeper-signing.md §2.2(ii)), so -v would refuse a usable
    // identity. The listing still catches a failed import or a wrong identity name, by name.
    const find = run.search(/^\s*listed="\$\(\/usr\/bin\/security find-identity -p codesigning "\$keychain"\)"$/m);
    const check = run.search(/^\s*printf '%s\\n' "\$listed" \| grep -Fq "\\"\$IDENTITY\\"" \|\| \{$/m);
    const searchList = run.search(/ list-keychains -d user -s "\$keychain"/);
    const handOff = run.search(/echo "APPLE_SIGNING_IDENTITY=\$IDENTITY" >> "\$GITHUB_ENV"/);
    expect([searchList, find, check, handOff].every((n) => n >= 0)).toBe(true);
    expect(searchList).toBeLessThan(find);
    expect(find).toBeLessThan(check);
    expect(check).toBeLessThan(handOff);
    expect(run).toMatch(/signing identity '\$IDENTITY' is not a codesigning identity in the CI keychain — check the p12 and the DBA_SIGNING_IDENTITY variable" >&2\n\s*exit 1\n\s*\}/);
    // Exactly one identity lookup, and it is NOT the -v form.
    expect(run.match(/ find-identity /g)?.length).toBe(1);
    expect(run).not.toMatch(/find-identity -v/);
    // It never CHANGES trust (that needs measuring on a dry-run repo first).
    expect(run).not.toMatch(/add-trusted-cert|trust-settings-import|add-trust/);
  });

  test("the import and cleanup steps call security/openssl/base64 by absolute path (setup-bun writes $GITHUB_PATH)", () => {
    const imp = mac.steps.find((s) => s.name?.startsWith("Import signing identity"))!.run!;
    const cleanup = mac.steps.at(-1)!.run!;
    for (const [where, run] of [["import", imp], ["cleanup", cleanup]] as const) {
      const code = run.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      // A bare name in command position: at a line start, or after a pipe, `$(`, `<(`, `;` or `&&`.
      expect(`${where}: ${code.match(/(?:^\s*|[|;&(]\s*)(?:security|openssl|base64)\b/gm)}`).toBe(`${where}: null`);
    }
    expect(imp).toMatch(/"\$\(\/usr\/bin\/openssl rand -hex 32\)"/);
    expect(imp).toMatch(/\| \/usr\/bin\/base64 --decode > "\$p12"/);
    expect(imp.match(/\/usr\/bin\/security /g)?.length).toBe(8);
    expect(cleanup).toMatch(/\/usr\/bin\/security delete-keychain "\$keychain"/);
  });

  test("the derivation order: gui-tests, build, stage, size, smoke, marker, bundle upload, marker upload", () => {
    for (const job of [mac, linux]) {
      const at = [...ENUMERATED, "marker"].map((id) => indexOfId(job, id));
      expect(at.every((n) => n >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      const uploads = job.steps.map((s, i) => [s, i] as const).filter(([s]) => s.uses?.startsWith("actions/upload-artifact@"));
      expect(uploads.length).toBe(2);
      expect(uploads.every(([, i]) => i > indexOfId(job, "marker"))).toBe(true);
      expect((uploads[0]![0].with?.name as string)).toMatch(/^bundle-/);
      expect((uploads[1]![0].with?.name as string)).toMatch(/^marker-/);
    }
    const winUploads = win.steps.map((s, i) => [s, i] as const).filter(([s]) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(winUploads.map(([s]) => s.with?.name)).toEqual(["windows-nsis", "marker-windows-x64"]);
    expect(winUploads.every(([, i]) => i > indexOfId(win, "marker"))).toBe(true);
    expect(indexOfId(win, "marker")).toBeGreaterThan(indexOfId(win, "build"));
  });

  test("the marker step: id `marker`, if: always(), reads .outcome of exactly the enumerated step ids", () => {
    for (const [job, ids] of [[mac, ENUMERATED], [linux, ENUMERATED], [win, ["build"]]] as const) {
      const m = stepById(job, "marker");
      expect(m.if).toBe("always()");
      const refs = Object.values(m.env ?? {}).sort();
      expect(refs).toEqual(ids.map((id) => `\${{ steps.${id}.outcome }}`).sort());
      expect(JSON.stringify(m)).not.toContain("conclusion");
      // Nothing else in the marker step reads another step.
      expect((m.run ?? "").includes("steps.")).toBe(false);
    }
  });

  test("no enumerated step carries continue-on-error (nor does any other step of a bundle leg)", () => {
    for (const job of [mac, linux, win]) {
      for (const s of job.steps) expect(`${s.id ?? s.name}: ${s["continue-on-error"]}`).toBe(`${s.id ?? s.name}: undefined`);
    }
  });

  test("uploads: the bundle only when the marker says built; the marker always", () => {
    for (const [job, leg] of [[mac, "${{ matrix.leg }}"], [linux, "linux-x86_64"]] as const) {
      const [bundle, marker] = job.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
      expect(bundle!.if).toBe("always() && steps.marker.outputs.status == 'built'");
      expect(bundle!.with).toEqual({ name: `bundle-${leg}`, path: "${{ runner.temp }}/stage/*", "if-no-files-found": "error" });
      expect(marker!.if).toBe("always()");
      expect(marker!.with).toEqual({ name: `marker-${leg}`, path: `\${{ runner.temp }}/marker/${leg}.status`, "if-no-files-found": "error" });
    }
    const [nsis, wmarker] = win.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(nsis!.if).toBe("always() && steps.marker.outputs.status == 'built'");
    expect(wmarker!.if).toBe("always()");
    expect(wmarker!.with?.path).toBe("${{ runner.temp }}/marker/windows-x64.status");
  });

  test("D-11: the Windows installer artifact is kept for one day, and no other upload sets a retention", () => {
    // The maintainer's D-11 decision. Nothing in the workflow downloads `windows-nsis` (the pattern test
    // under "release.yml: release" pins that), so the retention affects only a person fetching it by hand.
    const [nsis] = win.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(nsis!.with).toEqual({
      name: "windows-nsis",
      path: "gui/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    // Every OTHER upload in the workflow keeps the repository's default retention.
    const others = Object.entries(J).flatMap(([job, j]) => j.steps
      .filter((s) => s.uses?.startsWith("actions/upload-artifact@") && s.with?.name !== "windows-nsis")
      .map((s) => `${job}/${String(s.with?.name)}: ${String(s.with?.["retention-days"])}`));
    expect(others.length).toBeGreaterThanOrEqual(6);   // cli-binaries, 2 macOS, 2 Linux, the Windows marker
    for (const o of others) expect(o).toMatch(/: undefined$/);
  });

  test("the marker derivation, run: size failure -> size-rejected; all success -> built; anything else -> build-failed", () => {
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-marker-")));
    const derive = (script: string, leg: string, outcomes: Record<string, string>): string => {
      const temp = join(base, `t-${Math.random().toString(36).slice(2)}`);
      const out = `${temp}.out`;
      writeFileSync(out, "");
      const r = Bun.spawnSync(["bash", "-c", script], {
        env: { PATH: "/usr/bin:/bin", RUNNER_TEMP: temp, GITHUB_OUTPUT: out, LEG: leg, ...outcomes },
        stdout: "pipe", stderr: "pipe",
      });
      expect(r.exitCode).toBe(0);
      const body = readFileSync(join(temp, "marker", `${leg}.status`), "utf8");
      expect(readFileSync(out, "utf8")).toBe(`status=${body.trimEnd()}\n`);
      return body;
    };
    const keys = { "gui-tests": "GUI_TESTS", build: "BUILD", stage: "STAGE", size: "SIZE", smoke: "SMOKE" } as const;
    const all = (v: string) => Object.fromEntries(Object.values(keys).map((k) => [k, v]));
    for (const [job, leg] of [[mac, "macos-arm64"], [linux, "linux-x86_64"]] as const) {
      const script = stepById(job, "marker").run!;
      // The env names the script reads are the ones the step maps from the enumerated outcomes.
      expect(Object.keys(stepById(job, "marker").env!).sort()).toEqual(Object.values(keys).sort());
      expect(derive(script, leg, all("success"))).toBe("built\n");
      expect(derive(script, leg, { ...all("success"), SIZE: "failure" })).toBe("size-rejected\n");
      for (const k of Object.values(keys)) {
        for (const bad of ["failure", "cancelled", "skipped"]) {
          const want = k === "SIZE" && bad === "failure" ? "size-rejected\n" : "build-failed\n";
          expect(`${k}=${bad}: ${derive(script, leg, { ...all("success"), [k]: bad })}`).toBe(`${k}=${bad}: ${want}`);
        }
      }
      // A size failure wins even when an earlier step also failed (the size gate ran, and rejected).
      expect(derive(script, leg, { ...all("success"), GUI_TESTS: "failure", SIZE: "failure" })).toBe("size-rejected\n");
      expect(derive(script, leg, all("skipped"))).toBe("build-failed\n");
    }
    const wscript = stepById(win, "marker").run!;
    expect(derive(wscript, "windows-x64", { BUILD: "success" })).toBe("built\n");
    for (const bad of ["failure", "cancelled", "skipped"]) expect(derive(wscript, "windows-x64", { BUILD: bad })).toBe("build-failed\n");
  });

  test("macOS: the keychain cleanup is the job's LAST step, unconditional", () => {
    const last = mac.steps.at(-1)!;
    expect(last.if).toBe("always()");
    expect(last.run).toMatch(/keychain="\$RUNNER_TEMP\/dba-signing\.keychain-db"/);
    expect(last.run).toMatch(/ delete-keychain "\$keychain"/);
    expect(last.id).toBeUndefined();   // outside the derivation
  });

  test("macOS smoke: mounted staged DMG, both binaries' arch, a sealed bundle, and codesign -dvv proving the mode", () => {
    const run = stepById(mac, "smoke").run!;
    expect(run).toMatch(/hdiutil attach "\$dmg" -nobrowse -readonly -mountpoint "\$mnt"/);
    expect(run).toMatch(/dmg="\$RUNNER_TEMP\/stage\/daily-briefing-\$version-darwin-\$ASSET_ARCH\.dmg"/);
    expect(run).toMatch(/main="\$app\/Contents\/MacOS\/daily-briefing-gui"/);
    expect(run).toMatch(/sidecar="\$app\/Contents\/MacOS\/daily-briefing"/);
    expect(run).toMatch(/for bin in "\$main" "\$sidecar"; do\n\s*archs="\$\(lipo -archs "\$bin"\)"/);
    expect(run).toMatch(/codesign --verify --deep --strict "\$app"/);
    expect(run).toMatch(/\[ -f "\$app\/Contents\/_CodeSignature\/CodeResources" \] \|\| fail/);
    expect(run).toMatch(/for bin in "\$main" "\$sidecar"; do\n\s*info="\$\(codesign -dvv "\$bin" 2>&1\)"/);
    expect(run).toMatch(/\*,runtime,\*\) ;; \*\) fail/);
    expect(run).toMatch(/\*,linker-signed,\*\) fail/);
    expect(run).toMatch(/grep -Fxq "Authority=\$IDENTITY" \|\| fail/);
    expect(run).toMatch(/grep -Fxq "Signature=adhoc" \|\| fail/);
    expect(run).toMatch(/if \[ "\$SIGNING" = signed \]; then/);
    // --version runs NATIVELY on both legs, unconditionally: no Rosetta branch, no arch switch, no SKIP.
    expect(run).toMatch(/^\s*got="\$\("\$sidecar" --version\)"\n\s*\[ "\$got" = "\$version" \] \|\| fail "sidecar --version printed '\$got', expected '\$version'"$/m);
    expect(run.match(/"\$sidecar" --version/g)?.length).toBe(1);
    expect(run).not.toMatch(/\barch -|Rosetta|SKIP/);
    expect(run).not.toMatch(/if \[ "\$LIPO_ARCH"/);
    // The image never stays attached: an EXIT trap set right after the attach, BEFORE the copy, force-
    // detaches on any exit; the normal detach gets one forced retry and then fails the step.
    // ⚠ AND THE TRAP IS CLEARED ON THE LINE RIGHT AFTER THAT DETACH — so the forced detach never runs
    // against a path that is no longer a mount — and NOT before it, where a detach that failed would
    // exit the step with nothing left to force it.
    const attach = run.search(/\/usr\/bin\/hdiutil attach "\$dmg"/);
    const trap = run.search(/^\s*trap '\/usr\/bin\/hdiutil detach "\$mnt" -force >\/dev\/null 2>&1 \|\| true' EXIT$/m);
    const copy = run.search(/cp -R "\$mnt\/Daily Briefing\.app" "\$copy\/"/);
    const detach = run.search(/^\s*\/usr\/bin\/hdiutil detach "\$mnt" \|\| \{ sleep 2; \/usr\/bin\/hdiutil detach "\$mnt" -force; \}$/m);
    const cleared = run.search(/^\s*trap - EXIT$/m);
    expect([attach, trap, copy, detach, cleared].every((n) => n >= 0)).toBe(true);
    expect([attach, trap, copy, detach, cleared]).toEqual([attach, trap, copy, detach, cleared].sort((a, b) => a - b));
    expect(run).toMatch(/^\s*\/usr\/bin\/hdiutil detach "\$mnt" \|\| \{ sleep 2; \/usr\/bin\/hdiutil detach "\$mnt" -force; \}\n\s*trap - EXIT$/m);
    expect(run.match(/^\s*trap /gm)?.length).toBe(2);
    // Still fail-closed: nothing else in the step swallows a failure.
    expect(run.match(/\|\| true/g)?.length).toBe(1);
    expect(run).toMatch(/^set -euo pipefail$/m);
  });

  // The Linux smoke, RUN — not pattern-matched. A stub `dpkg-deb` first on PATH serves a real tarball
  // (built here with `tar`, binaries 0755 and the desktop entry 0644, as tauri-bundler writes them) as the
  // package's data member, and a stub AppImage extracts the layout tauri-bundler and the conf ship: the
  // TRACKED wrapper at usr/bin/daily-briefing and the built engine at
  // usr/libexec/daily-briefing/daily-briefing (gui/src-tauri/tauri.linux.conf.json,
  // bundle.linux.appimage.files), both copied from a fake gui/ tree that is the step's working
  // directory; the app's main executable at usr/bin/daily-briefing-gui; its desktop entry at
  // usr/share/applications/Daily Briefing.desktop, linked from the AppDir root. The engine is a stub
  // printing a version, and the step's `--version` runs it THROUGH the real wrapper; the GUI stub exits
  // 99 and is never run. `layout`, `app` and `debModes` swap in each broken variant the smoke must refuse.
  interface LinuxSmokeOpts {
    debMembers?: string[];
    /** Mode overrides for the deb's data members (default: 0755 for usr/bin/*, 0644 otherwise). */
    debModes?: Record<string, number>;
    prefixed?: boolean;
    /** What the AppImage puts at usr/bin/daily-briefing and at usr/libexec/daily-briefing/daily-briefing. */
    layout?: { bin: "wrapper" | "engine" | "edited-wrapper" | "wrapper-0644" | "missing"; libexec: "engine" | "engine-0644" | "patched-engine" | "missing" };
    /** The app's own files in the AppImage: its main executable, and its desktop entry (in
     *  usr/share/applications and linked from the AppDir root). */
    app?: { gui: "exe" | "exe-0644" | "missing"; desktop: "both" | "renamed-root" | "no-root" | "no-share" | "none" };
    /** What the built engine prints for --version; null makes it exit 3 instead. */
    engineVersion?: string | null;
    /** The fake tree's copy of the tracked wrapper (default: the real one), which the AppImage stub copies. */
    wrapperText?: string;
  }
  const SMOKE_VERSION = "0.2.0";
  const DEB_REQUIRED = ["usr/bin/daily-briefing-gui", "usr/bin/daily-briefing", "usr/share/applications/Daily Briefing.desktop"];
  const TRACKED_WRAPPER = readFileSync(`${ROOT}gui/src-tauri/linux/daily-briefing-appimage-wrapper.sh`, "utf8");
  const linuxSmoke = (dir: string, o: LinuxSmokeOpts = {}): { code: number; out: string } => {
    const members = o.debMembers ?? DEB_REQUIRED;
    const layout = o.layout ?? { bin: "wrapper", libexec: "engine" };
    const app = o.app ?? { gui: "exe", desktop: "both" };
    const engineVersion = o.engineVersion === undefined ? SMOKE_VERSION : o.engineVersion;
    const triple = linux.env!.TRIPLE!;
    const sh = (cmd: string[], cwd?: string) => {
      const r = Bun.spawnSync(cmd, { cwd, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
      expect(`${cmd.join(" ")}: ${r.exitCode} ${r.stderr}`).toBe(`${cmd.join(" ")}: 0 `);
    };
    const root = join(dir, "root");
    for (const m of members) {
      mkdirSync(join(root, m, ".."), { recursive: true });
      writeFileSync(join(root, m), m.startsWith("usr/bin/") ? "#!/bin/sh\nexit 99\n" : "[Desktop Entry]\n");
      chmodSync(join(root, m), o.debModes?.[m] ?? (m.startsWith("usr/bin/") ? 0o755 : 0o644));   // chmod: not subject to the umask
    }
    const tarball = join(dir, "data.tar");
    sh(o.prefixed ? ["tar", "-cf", tarball, "-C", root, "."] : ["tar", "-cf", tarball, "-C", root, "usr"]);
    const bin = join(dir, "bin");
    const temp = join(dir, "runner-temp");
    const stage = join(temp, "stage");
    const gui = join(dir, "gui");
    for (const d of [bin, stage, join(gui, "src-tauri", "linux"), join(gui, "src-tauri", "binaries")]) mkdirSync(d, { recursive: true });
    const wrapperSrc = join(gui, "src-tauri", "linux", "daily-briefing-appimage-wrapper.sh");
    const engineSrc = join(gui, "src-tauri", "binaries", `daily-briefing-${triple}`);
    writeFileSync(wrapperSrc, o.wrapperText ?? TRACKED_WRAPPER, { mode: 0o755 });
    // The real engine is ELF; the stub only has to differ from the wrapper in its first line, so bash.
    writeFileSync(engineSrc, engineVersion === null ? "#!/bin/bash\nexit 3\n" : `#!/bin/bash\n[ "$1" = --version ] || exit 2\necho ${engineVersion}\n`, { mode: 0o755 });
    // macOS keeps sha256sum in /sbin, off this PATH; shasum -a 256 prints the same "<hash>  <file>" line.
    if (!existsSync("/usr/bin/sha256sum") && !existsSync("/bin/sha256sum")) {
      writeFileSync(join(bin, "sha256sum"), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
    }
    writeFileSync(join(bin, "dpkg-deb"),
      "#!/bin/sh\n" +
      "case \"$1\" in\n" +
      `  --info) printf ' Package: daily-briefing\\n Version: ${SMOKE_VERSION}\\n Architecture: amd64\\n' ;;\n` +
      `  --fsys-tarfile) cat "${tarball}" ;;\n` +
      // What the OLD smoke called: an `ls -l`-style listing, as dpkg-deb --contents prints it.
      `  --contents) tar -tvf "${tarball}" ;;\n` +
      "  *) echo \"dpkg-deb stub: unexpected $*\" >&2; exit 2 ;;\n" +
      "esac\n", { mode: 0o755 });
    const ub = "squashfs-root/usr/bin/daily-briefing";
    const ul = "squashfs-root/usr/libexec/daily-briefing/daily-briefing";
    const binStep = {
      wrapper: `cp "${wrapperSrc}" ${ub}; chmod 755 ${ub}`,
      engine: `cp "${engineSrc}" ${ub}; chmod 755 ${ub}`,
      "edited-wrapper": `cp "${wrapperSrc}" ${ub}; chmod 755 ${ub}; printf '# edited\\n' >> ${ub}`,
      "wrapper-0644": `cp "${wrapperSrc}" ${ub}; chmod 644 ${ub}`,
      missing: ":",
    }[layout.bin];
    const libexecStep = {
      engine: `cp "${engineSrc}" ${ul}; chmod 755 ${ul}`,
      "engine-0644": `cp "${engineSrc}" ${ul}; chmod 644 ${ul}`,
      // Grown by a few bytes and still runnable, as linuxdeploy's rpath rewrite left it.
      "patched-engine": `cp "${engineSrc}" ${ul}; chmod 755 ${ul}; printf '# patched\\n' >> ${ul}`,
      missing: ":",
    }[layout.libexec];
    const ug = "squashfs-root/usr/bin/daily-briefing-gui";
    const guiStep = {
      exe: `printf '#!/bin/sh\\nexit 99\\n' > ${ug}; chmod 755 ${ug}`,
      "exe-0644": `printf '#!/bin/sh\\nexit 99\\n' > ${ug}; chmod 644 ${ug}`,
      missing: ":",
    }[app.gui];
    const share = '"squashfs-root/usr/share/applications/Daily Briefing.desktop"';
    const entry = `printf '[Desktop Entry]\\nExec=daily-briefing-gui\\n' > ${share}`;
    const desktopStep = {
      both: `${entry}; ln -s "usr/share/applications/Daily Briefing.desktop" "squashfs-root/Daily Briefing.desktop"`,
      // Another name at the root is still an entry AppRun can launch through.
      "renamed-root": `${entry}; ln -s "usr/share/applications/Daily Briefing.desktop" "squashfs-root/daily-briefing.desktop"`,
      "no-root": entry,
      // A root link left dangling: the entry it names is not there.
      "no-share": `ln -s "usr/share/applications/Daily Briefing.desktop" "squashfs-root/Daily Briefing.desktop"`,
      none: ":",
    }[app.desktop];
    writeFileSync(join(stage, `daily-briefing-${SMOKE_VERSION}-linux-x86_64.AppImage`),
      "#!/bin/sh\nset -e\n" +
      "[ \"$1\" = --appimage-extract ] || exit 2\n" +
      "mkdir -p squashfs-root/usr/bin squashfs-root/usr/libexec/daily-briefing squashfs-root/usr/share/applications\n" +
      `${binStep}\n${libexecStep}\n${guiStep}\n${desktopStep}\n`, { mode: 0o755 });
    writeFileSync(join(stage, `daily-briefing_${SMOKE_VERSION}_amd64.deb`), "stub: dpkg-deb never reads it\n");
    const r = Bun.spawnSync(["bash", "-c", stepById(linux, "smoke").run!], {
      cwd: gui,
      env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: temp, GITHUB_REF_NAME: `v${SMOKE_VERSION}`, LEG: "linux-x86_64", TRIPLE: triple },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  // The deb half. The tarball is built in BOTH member-name forms: BARE (`usr/bin/…`, what tauri-bundler
  // writes — debian.rs `strip_prefix`) and `./`-prefixed (what `dpkg-deb --build` writes). The old
  // `dpkg-deb --contents | sed -n 's|^.* \./|./|p'` listing found nothing in the bare form, so every
  // healthy Linux leg was marked build-failed; this test fails on that sed.
  test("Linux smoke, run: the deb member check passes for bare AND ./-prefixed member names, fails on a missing one", () => {
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-linux-smoke-")));
    for (const prefixed of [false, true]) {
      const form = prefixed ? "./-prefixed" : "bare";
      const ok = linuxSmoke(join(base, `ok-${form.replace(/\W/g, "")}`), { prefixed });
      expect(`${form}: ${ok.code} ${ok.out}`).toStartWith(`${form}: 0 `);
      expect(ok.out).toContain("smoke: ok (linux-x86_64)");
      // Exact-line match: a missing file is caught even when a longer sibling name starts with it.
      for (const drop of DEB_REQUIRED) {
        const r = linuxSmoke(join(base, `missing-${form.replace(/\W/g, "")}-${DEB_REQUIRED.indexOf(drop)}`),
          { debMembers: DEB_REQUIRED.filter((m) => m !== drop), prefixed });
        expect(`${form} without ${drop}: ${r.code}`).toBe(`${form} without ${drop}: 1`);
        expect(r.out).toContain(`deb: ${drop} is missing from the package contents`);
      }
      // Present but not executable by everyone: each of the two executables, at 0644 and at 0700 (root-
      // owned once installed, so a user could not run it).
      for (const exe of ["usr/bin/daily-briefing-gui", "usr/bin/daily-briefing"]) {
        for (const mode of [0o644, 0o700]) {
          const r = linuxSmoke(join(base, `mode-${form.replace(/\W/g, "")}-${exe.replace(/\W/g, "")}-${mode.toString(8)}`), { prefixed, debModes: { [exe]: mode } });
          expect(`${form} ${exe} ${mode.toString(8)}: ${r.code}`).toBe(`${form} ${exe} ${mode.toString(8)}: 1`);
          expect(r.out).toContain(`deb: ${exe} is not one regular file executable by everyone (mode '-rw`);
          expect(r.out).not.toContain("smoke: ok");
        }
      }
    }
    // Sixteen full smoke runs, each executing several freshly written scripts: macOS scans every new
    // executable on first exec (~0.2 s each, measured 2026-10-01), so the 5 s default is too tight.
  }, 90_000);

  // The AppImage half (user-directed 2026-10-01, "B: try AppImage, else .deb"): the layout the conf sets
  // up, checked on the extracted AppImage, each broken variant refused by name.
  test("Linux smoke, run: the AppImage carries the tracked wrapper at usr/bin and the built engine, byte-identical, at usr/libexec; --version goes through the wrapper", () => {
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-linux-appimage-smoke-")));
    const ok = linuxSmoke(join(base, "ok"));
    expect(`healthy layout: ${ok.code} ${ok.out}`).toStartWith("healthy layout: 0 ");
    expect(ok.out).toContain("smoke: ok (linux-x86_64)");
    expect(ok.out).toMatch(/^smoke: AppImage engine sha256 ([0-9a-f]{64}), build-sidecar\.sh output sha256 \1$/m);
    const misdirected = TRACKED_WRAPPER.replace("/../libexec/", "/../lib/");
    expect(misdirected).not.toBe(TRACKED_WRAPPER);
    const refused: [string, LinuxSmokeOpts, RegExp][] = [
      ["the engine itself at usr/bin (the layout linuxdeploy broke)", { layout: { bin: "engine", libexec: "engine" } },
        /AppImage: usr\/bin\/daily-briefing is not the shell wrapper/],
      ["an edited wrapper", { layout: { bin: "edited-wrapper", libexec: "engine" } },
        /AppImage: usr\/bin\/daily-briefing differs from src-tauri\/linux\/daily-briefing-appimage-wrapper\.sh/],
      ["a non-executable wrapper", { layout: { bin: "wrapper-0644", libexec: "engine" } },
        /AppImage: usr\/bin\/daily-briefing is not executable/],
      ["no wrapper", { layout: { bin: "missing", libexec: "engine" } },
        /AppImage: usr\/bin\/daily-briefing is missing/],
      ["no engine in usr/libexec", { layout: { bin: "wrapper", libexec: "missing" } },
        /AppImage: usr\/libexec\/daily-briefing\/daily-briefing is missing/],
      ["a non-executable engine", { layout: { bin: "wrapper", libexec: "engine-0644" } },
        /AppImage: usr\/libexec\/daily-briefing\/daily-briefing is not executable/],
      ["a patched engine", { layout: { bin: "wrapper", libexec: "patched-engine" } },
        /AppImage: the engine is not byte-identical to src-tauri\/binaries\/daily-briefing-x86_64-unknown-linux-gnu/],
      ["an engine printing another version", { engineVersion: "0.1.9" },
        /AppImage: --version through the wrapper printed '0\.1\.9', expected '0\.2\.0'/],
      ["an engine that fails", { engineVersion: null },
        /AppImage: --version through the wrapper exited non-zero/],
      // Wrapper and engine both match their sources, but the wrapper points nowhere: only a --version
      // that goes THROUGH the wrapper can catch this (one run against the engine directly would pass).
      ["a wrapper whose target is wrong", { wrapperText: misdirected },
        /AppImage: --version through the wrapper exited non-zero/],
      // The app's own files.
      ["no GUI main executable", { app: { gui: "missing", desktop: "both" } },
        /AppImage: usr\/bin\/daily-briefing-gui \(the app's main executable\) is missing/],
      ["a non-executable GUI main executable", { app: { gui: "exe-0644", desktop: "both" } },
        /AppImage: usr\/bin\/daily-briefing-gui is not executable/],
      ["no desktop entry at all", { app: { gui: "exe", desktop: "none" } },
        /AppImage: usr\/share\/applications\/Daily Briefing\.desktop is missing/],
      ["a root link to a desktop entry that is not there", { app: { gui: "exe", desktop: "no-share" } },
        /AppImage: usr\/share\/applications\/Daily Briefing\.desktop is missing/],
      ["no desktop entry at the AppDir root", { app: { gui: "exe", desktop: "no-root" } },
        /AppImage: no \.desktop entry at the AppDir root/],
    ];
    refused.forEach(([what, opts, why], i) => {
      const r = linuxSmoke(join(base, `refused-${i}`), opts);
      expect(`${what}: ${r.code}`).toBe(`${what}: 1`);
      expect(r.out).toMatch(why);
      expect(r.out).not.toContain("smoke: ok");
    });
    // A root entry under another name is still one AppRun can launch through: accepted.
    const renamed = linuxSmoke(join(base, "renamed-root"), { app: { gui: "exe", desktop: "renamed-root" } });
    expect(`renamed root entry: ${renamed.code} ${renamed.out}`).toStartWith("renamed root entry: 0 ");
    // Seventeen full smoke runs (see the deb test's timing note).
  }, 90_000);

  test("the size step checks the staged DMG and the built .app against their matrix rows", () => {
    const run = stepById(mac, "size").run!;
    expect(run).toContain('bun ../scripts/check-size-budget.ts "$RUNNER_TEMP/stage/daily-briefing-${GITHUB_REF_NAME#v}-darwin-$ASSET_ARCH.dmg" "$DMG_ROW"');
    expect(run).toContain('bun ../scripts/check-size-budget.ts "src-tauri/target/$TRIPLE/release/bundle/macos/Daily Briefing.app" "$APP_ROW"');
    const rows = mac.strategy!.matrix!.include!.map((l) => [l["dmg-row"], l["app-row"]]);
    expect(rows).toEqual([["dmg-aarch64-apple-darwin", "app-aarch64-apple-darwin"], ["dmg-x86_64-apple-darwin", "app-x86_64-apple-darwin"]]);
    const lrun = stepById(linux, "size").run!;
    expect(lrun).toContain("appimage-x86_64-unknown-linux-gnu");
    expect(lrun).toContain("deb-x86_64-unknown-linux-gnu");
  });

  test("stage uses the frozen-name script on the --target bundle tree", () => {
    expect(stepById(mac, "stage").run).toBe('bash scripts/stage-bundles.sh "src-tauri/target/$TRIPLE/release/bundle" "${GITHUB_REF_NAME#v}" "$RUNNER_TEMP/stage" dmg');
    expect(stepById(linux, "stage").run).toBe('bash scripts/stage-bundles.sh "src-tauri/target/$TRIPLE/release/bundle" "${GITHUB_REF_NAME#v}" "$RUNNER_TEMP/stage" appimage,deb');
  });

  test("GUI gates in both bundle legs; bundle-linux's cargo test carries exactly the one --skip, macOS none", () => {
    const macRun = stepById(mac, "gui-tests").run!;
    const linRun = stepById(linux, "gui-tests").run!;
    for (const r of [macRun, linRun]) {
      expect(r).toMatch(/^bun run test$/m);
      expect(r).toMatch(/^bun run check$/m);
    }
    expect(macRun).toMatch(/^cargo test --locked --manifest-path src-tauri\/Cargo\.toml --no-fail-fast$/m);
    expect(macRun).not.toContain("--skip");
    expect(linRun).toMatch(new RegExp(`^cargo test --locked --manifest-path src-tauri/Cargo\\.toml --no-fail-fast -- --skip ${SKIP}$`, "m"));
    expect(linRun.match(/--skip/g)?.length).toBe(1);
    // No other step of either workflow file skips anything.
    expect(Object.values(J).flatMap((j) => j.steps).filter((s) => s.run?.includes("--skip")).length).toBe(1);
  });

  test("bundle-windows turns off CRLF conversion BEFORE its checkout (the tracked .gitattributes covers only site/**)", () => {
    const checkout = win.steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
    const lf = win.steps.findIndex((s) => /^git config --global core\.autocrlf false$/m.test(s.run ?? ""));
    expect(lf).toBe(0);
    expect(checkout).toBe(1);
    const step = win.steps[lf]!;
    expect(step.run).toMatch(/^git config --global core\.eol lf$/m);
    // gui/ (the job's default working directory) does not exist before the checkout.
    expect(step["working-directory"]).toBe(".");
    // Windows only: the other legs' checkouts are the first step, untouched.
    for (const job of [mac, linux]) expect(job.steps[0]!.uses).toMatch(/^actions\/checkout@/);
  });

  test("bundle-linux runs on the pinned ubuntu-22.04 image; macOS per leg (matrix.runner, pinned above)", () => {
    expect(linux["runs-on"]).toBe("ubuntu-22.04");
    expect(mac["runs-on"]).toBe("${{ matrix.runner }}");
    expect(win["runs-on"]).toBe("windows-latest");
  });

  // Disk headroom (release dry run 2, 2026-10-02: the runner ran out of disk inside the Linux smoke, after
  // the debug and release Rust targets, and died without writing a marker). The step DELETES things as
  // root, so what it may delete is pinned twice: an exact allowlist, and — independently of that list, so
  // editing the list cannot quietly widen the blast radius — the classes of path the job itself uses.
  const FREE_DISK = "Free disk space (unused preinstalled toolchains)";
  const FREED = ["/usr/share/dotnet", "/usr/local/lib/android", "/usr/local/.ghcup", "/opt/hostedtoolcache/CodeQL"];
  /** A run script's code lines: continuations joined, comments and blank lines dropped. */
  const codeLines = (run: string): string[] =>
    run.replace(/\\\n/g, " ").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  /** Why the free-disk step must never delete `p`, or null when it may. On a hosted runner the workspace,
   *  $RUNNER_TEMP, ~/.cargo, ~/.rustup and ~/.bun all live under /home/runner. */
  const forbiddenDeletion = (p: string): string | null => {
    if (!/^(?:\/[\w.+-]+)+$/.test(p)) return "not a literal absolute path (a variable, ~, a glob or a relative path)";
    const parts = p.split("/").slice(1);
    if (parts.some((c) => c === "." || c === "..")) return "has a . or .. component";
    if (parts.length < 3) return "a top-level system directory";
    if (p.startsWith("/home/") || p.startsWith("/root/")) return "under a home directory (workspace, $RUNNER_TEMP, cargo, rustup, bun)";
    if (p.startsWith("/opt/hostedtoolcache/") && p !== "/opt/hostedtoolcache/CodeQL") return "the hosted tool cache outside CodeQL";
    if (/\/\.?(?:cargo|rustup|bun|node|nodejs|npm|python[\d.]*|apt|dpkg)(?:\/|$)/i.test(p)) return "a toolchain this job uses";
    return null;
  };

  test("bundle-linux frees disk in ONE step of its own: after the checkout, before System packages, outside the derivation", () => {
    // Only here: no other job of release.yml carries it.
    const where = Object.entries(J).flatMap(([jn, job]) => job.steps.filter((s) => s.name === FREE_DISK).map(() => jn));
    expect(where).toEqual(["bundle-linux"]);
    const at = linux.steps.findIndex((s) => s.name === FREE_DISK);
    const checkout = linux.steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
    const packages = linux.steps.findIndex((s) => s.name === "System packages");
    expect([checkout, packages].every((n) => n >= 0)).toBe(true);
    // After the checkout: gui/ (the job's default working directory) does not exist before it.
    expect(at).toBeGreaterThan(checkout);
    expect(at).toBeLessThan(packages);
    for (const id of ENUMERATED) expect(`${id}: ${indexOfId(linux, id) > at}`).toBe(`${id}: true`);
    // No id (the marker never reads it) and no condition: it runs on every release, and its failure skips
    // every later step, which the derivation already reads as build-failed.
    const step = linux.steps[at]!;
    expect(step.id).toBeUndefined();
    expect(step.if).toBeUndefined();
  });

  test("the free-disk step deletes exactly the named toolchains, between two df -h prints, and none is a path the job uses", () => {
    const step = linux.steps.find((s) => s.name === FREE_DISK)!;
    const lines = codeLines(step.run!);
    const rm = lines.filter((l) => /\brm\b/.test(l));
    expect(rm.length).toBe(1);
    // One plain command: no chaining, no redirection, every argument a path.
    const args = /^sudo rm -rf((?: [^\s;&|<>]+)+)$/.exec(rm[0]!)?.[1]?.trim().split(" ");
    expect(`${rm[0]}: ${args !== undefined}`).toBe(`${rm[0]}: true`);
    expect([...args!].sort()).toEqual([...FREED].sort());
    expect(new Set(args).size).toBe(args!.length);
    for (const p of args!) expect(`${p}: ${forbiddenDeletion(p)}`).toBe(`${p}: null`);
    // The whole step: the root filesystem and $RUNNER_TEMP's printed before and after, and nothing else.
    const df = 'df -h / "$RUNNER_TEMP"';
    expect(lines).toEqual(["set -euo pipefail", df, rm[0]!, df]);
    // Nowhere else: no other step of any job deletes as root or names a path freed here.
    for (const [jn, job] of Object.entries(J)) {
      job.steps.forEach((s, i) => {
        if (s === step) return;
        const run = s.run ?? "";
        const hit = /\bsudo\s+rm\b/.test(run) || FREED.some((p) => run.includes(p));
        expect(`${jn}/${s.id ?? s.name ?? i}: ${hit}`).toBe(`${jn}/${s.id ?? s.name ?? i}: false`);
      });
    }
    // Non-vacuity: the class check refuses each kind of path the job relies on, whatever the list says.
    for (const p of ["$GITHUB_WORKSPACE", "/home/runner/work/repo/repo", "$RUNNER_TEMP", "/home/runner/work/_temp",
      "$HOME/.cargo", "/home/runner/.cargo", "~/.rustup", "/home/runner/.rustup", "~/.bun", "/home/runner/.bun",
      "/opt/hostedtoolcache", "/opt/hostedtoolcache/node", "/opt/hostedtoolcache/Python/3.12.14", "gui/src-tauri/target",
      "/usr/local", "/usr/share/*", "/usr/local/lib/../../../home/runner", "/usr/local/cargo", "/usr/lib/apt"]) {
      expect(`${p}: ${forbiddenDeletion(p) !== null}`).toBe(`${p}: true`);
    }
  });

  // The macOS toolchain step, RUN against stub rustup/rustc: native legs add no target, and a host that
  // is not the leg's triple (a runner label resolving to the other architecture) fails the step, named.
  test("macOS toolchain step, run: installs the pinned toolchain, adds no target, refuses a non-native host", () => {
    const step = mac.steps.filter((s) => s.name === "Rust toolchain");
    expect(step.length).toBe(1);
    const script = step[0]!.run!;
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-mac-toolchain-")));
    const run = (host: string, triple: string) => {
      const dir = join(base, `${host}--${triple}`);
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(dir, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.98.1"\n');
      const calls = join(dir, "calls");
      writeFileSync(calls, "");
      writeFileSync(join(bin, "rustup"), `#!/bin/sh\necho "rustup $*" >> "${calls}"\n`, { mode: 0o755 });
      writeFileSync(join(bin, "rustc"),
        `#!/bin/sh\necho "rustc $*" >> "${calls}"\n[ "$2 $3" = "--print host-tuple" ] && echo ${host}\nexit 0\n`, { mode: 0o755 });
      const r = Bun.spawnSync(["bash", "-c", script], {
        cwd: dir, env: { PATH: `${bin}:/usr/bin:/bin`, TRIPLE: triple, LEG: "macos-test" }, stdout: "pipe", stderr: "pipe",
      });
      return { code: r.exitCode, err: r.stderr.toString(), calls: readFileSync(calls, "utf8") };
    };
    for (const { triple } of mac.strategy!.matrix!.include!) {
      const ok = run(triple!, triple!);
      expect(`${triple}: ${ok.code} ${ok.err}`).toBe(`${triple}: 0 `);
      // Exactly these two calls: no `rustup target add` on a native leg.
      expect(ok.calls).toBe("rustup toolchain install 1.98.1\nrustc +1.98.1 --print host-tuple\n");
    }
    const bad = run("aarch64-apple-darwin", "x86_64-apple-darwin");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("the macos-test leg builds x86_64-apple-darwin natively, but this runner's host is 'aarch64-apple-darwin'");
  });

  test("the Intel leg also builds the aarch64 sidecar size-budget.json records: after the host sidecar, before gui-tests", () => {
    const host = mac.steps.findIndex((s) => s.run === "bash scripts/build-sidecar.sh");
    const extra = mac.steps.map((s, i) => [s, i] as const).filter(([s]) => /build-sidecar\.sh \S/.test(s.run ?? ""));
    expect(extra.length).toBe(1);
    const [step, at] = extra[0]!;
    const built = /^bash scripts\/build-sidecar\.sh ([\w-]+)$/.exec(step.run!)?.[1];
    expect(built).toBe("aarch64-apple-darwin");
    // It is the triple of the row packaging.rs's stale-row test re-stats — read, not retyped.
    const budget = JSON.parse(readFileSync(`${ROOT}gui/size-budget.json`, "utf8")) as { sidecar: { path: string } };
    expect(budget.sidecar.path).toBe(`src-tauri/binaries/daily-briefing-${built}`);
    expect(host).toBeGreaterThanOrEqual(0);
    expect(host).toBeLessThan(at);
    expect(at).toBeLessThan(indexOfId(mac, "gui-tests"));
    // It runs on exactly the legs whose host sidecar is NOT that one, i.e. the Intel leg.
    expect(step.if).toBe("matrix.triple == 'x86_64-apple-darwin'");
    const legs = mac.strategy!.matrix!.include!;
    const runsOn = legs.filter((l) => `matrix.triple == '${l.triple}'` === step.if).map((l) => l.leg);
    expect(runsOn).toEqual(legs.filter((l) => l.triple !== built).map((l) => l.leg));
    expect(runsOn).toEqual(["macos-x64"]);
    // And outside the derivation: no id, so the marker never reads it.
    expect(step.id).toBeUndefined();
  });
});

describe("release.yml: credentials and secrets", () => {
  const FORBIDDEN_KEY = /^APPLE_(CERTIFICATE\w*|ID|PASSWORD|TEAM_ID|API_\w*)$/;

  test("no APPLE_CERTIFICATE*/APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID/APPLE_API_* key in any env map", () => {
    const maps = allEnvMaps(W);
    expect(maps.length).toBeGreaterThan(5);
    for (const [where, env] of maps) {
      expect(`${where}: ${Object.keys(env).filter((k) => FORBIDDEN_KEY.test(k))}`).toBe(`${where}: `);
    }
    // …and no script assigns or exports one either.
    for (const s of Object.values(J).flatMap((j) => j.steps)) {
      expect(s.run ?? "").not.toMatch(/\bAPPLE_(CERTIFICATE\w*|ID|PASSWORD|TEAM_ID|API_\w*)=/);
    }
  });

  test("the notarization secrets are mapped only to DBA_NOTARIZE_* names, on the macOS build step", () => {
    const want = {
      DBA_NOTARIZE_APPLE_ID: "${{ secrets.APPLE_ID }}",
      DBA_NOTARIZE_APPLE_PASSWORD: "${{ secrets.APPLE_PASSWORD }}",
      DBA_NOTARIZE_APPLE_TEAM_ID: "${{ secrets.APPLE_TEAM_ID }}",
      DBA_NOTARIZE_API_KEY: "${{ secrets.APPLE_API_KEY }}",
      DBA_NOTARIZE_API_ISSUER: "${{ secrets.APPLE_API_ISSUER }}",
      DBA_NOTARIZE_API_KEY_P8: "${{ secrets.APPLE_API_KEY_P8 }}",
    };
    const build = stepById(J["bundle-macos"]!, "build");
    for (const [k, v] of Object.entries(want)) expect(build.env?.[k]).toBe(v);
    for (const [where, env] of allEnvMaps(W)) {
      for (const [k, v] of Object.entries(env)) {
        if (/secrets\.APPLE_/.test(v)) expect(`${where}.${k}`).toMatch(/\.DBA_NOTARIZE_[A-Z0-9_]+$/);
      }
    }
    // Nowhere else, and never inside a script.
    const mapped = allEnvMaps(W).flatMap(([, env]) => Object.values(env)).filter((v) => /secrets\.APPLE_/.test(v));
    expect(mapped.length).toBe(6);
    for (const s of Object.values(J).flatMap((j) => j.steps)) expect(s.run ?? "").not.toMatch(/secrets\.APPLE_/);
  });

  test("TAURI_BUNDLER_DMG_IGNORE_CI is absent everywhere (v0.2.0 ships a brandless DMG)", () => {
    for (const [where, env] of allEnvMaps(W)) expect(`${where}: ${"TAURI_BUNDLER_DMG_IGNORE_CI" in env}`).toBe(`${where}: false`);
    for (const s of Object.values(J).flatMap((j) => j.steps)) expect(JSON.stringify(s)).not.toContain("TAURI_BUNDLER_DMG_IGNORE_CI");
  });

  test("secrets are referenced only by the gate's mode check, the import step and the macOS build step", () => {
    for (const [jn, job] of Object.entries(J)) {
      job.steps.forEach((s) => {
        const refs = JSON.stringify(s).match(/secrets\.[A-Z_0-9]+/g) ?? [];
        if (!refs.length) return;
        const where = `${jn}/${s.id ?? s.name}`;
        expect(["gate/signing-mode", "bundle-macos/Import signing identity (signed mode only)", "bundle-macos/build"]).toContain(where);
      });
      if (jn !== "bundle-macos" && jn !== "gate") expect(`${jn}: ${JSON.stringify(job).includes("secrets.")}`).toBe(`${jn}: false`);
    }
  });
});

describe("release.yml: release", () => {
  const rel = J.release!;

  test("needs every job, and runs whenever the gate and the CLI floor succeeded", () => {
    expect([...(rel.needs as string[])].sort()).toEqual(["bundle-linux", "bundle-macos", "bundle-windows", "cli-binaries", "gate"]);
    expect(rel.if).toBe("always() && !cancelled() && needs.gate.result == 'success' && needs.cli-binaries.result == 'success'");
  });

  test("no secrets.* reference anywhere in the release job; GH_TOKEN is the run's own token", () => {
    expect(JSON.stringify(rel)).not.toContain("secrets.");
    const create = rel.steps.find((s) => s.run?.includes("gh release create"))!;
    expect(create.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(create.run).toContain('gh release create "$TAG" dist/* --verify-tag --title "$TAG" --notes-file "$RUNNER_TEMP/notes.md"');
  });

  test("checks out the repo (collect and the notes template live in it)", () => {
    expect(rel.steps[0]!.uses).toMatch(/^actions\/checkout@/);
  });

  test("downloads: cli-binaries and bundle-* into dist/, marker-* into markers/, all merge-multiple", () => {
    const dl = rel.steps.filter((s) => s.uses?.startsWith("actions/download-artifact@"));
    expect(dl.map((s) => [s.with?.pattern, s.with?.path, s.with?.["merge-multiple"], s.id ?? null, s["continue-on-error"] ?? null])).toEqual([
      ["cli-binaries", "dist", true, null, null],
      ["bundle-*", "dist", true, "dl-bundles", true],
      ["marker-*", "markers", true, "dl-markers", true],
    ]);
    // Every download step carries merge-multiple: true (pinned above), and none names a single artifact.
    for (const s of dl) expect(s.with?.name).toBeUndefined();
  });

  test("no download pattern matches the Windows installer artifact (C3: never attached)", () => {
    const patterns = rel.steps.filter((s) => s.uses?.startsWith("actions/download-artifact@")).map((s) => String(s.with?.pattern));
    for (const p of patterns) expect(`${p}: ${new Glob(p).match("windows-nsis")}`).toBe(`${p}: false`);
    // Non-vacuity: the patterns do match what they are meant to.
    expect(new Glob("bundle-*").match("bundle-macos-arm64")).toBe(true);
    expect(new Glob("marker-*").match("marker-windows-x64")).toBe(true);
  });

  test("collect runs between the downloads and the release, with the gate's mode and the dl-bundles outcome", () => {
    const i = rel.steps.findIndex((s) => s.run?.includes("scripts/release-collect.sh"));
    const c = rel.steps[i]!;
    expect(c.run).toContain('bash scripts/release-collect.sh dist markers "${TAG#v}" "$SIGNING" "${{ steps.dl-bundles.outcome }}" "$RUNNER_TEMP/notes.md"');
    expect(c.run).toContain('TAG="${GITHUB_REF_NAME}"');
    expect(c.env).toEqual({ SIGNING: "${{ needs.gate.outputs.signing }}" });
    expect(i).toBeGreaterThan(rel.steps.findIndex((s) => s.id === "dl-markers"));
    expect(i).toBeLessThan(rel.steps.findIndex((s) => s.run?.includes("gh release create")));
  });
});

// ── E6: the public ci.yml ──────────────────────────────────────────────────────────────────────────
describe("ci.yml (public)", () => {
  const C = parse("ci.yml");

  test("the existing engine matrix and bun pin are unchanged", () => {
    expect(C.on).toEqual({ push: { branches: ["main"] }, pull_request: null });
    const check = C.jobs.check!;
    expect((check.strategy?.matrix as unknown as { os: string[] }).os).toEqual(["ubuntu-latest", "macos-latest"]);
    // The two actions by name (their refs are SHA pins, checked in "action pins" below).
    expect(check.steps.map((s) => s.run ?? s.uses?.replace(/@.*$/, "@<pin>"))).toEqual([
      "actions/checkout@<pin>", "oven-sh/setup-bun@<pin>", "bun install --frozen-lockfile", "bunx tsc --noEmit", "bun test",
    ]);
  });

  test("read-only: workflow permissions are contents: read, no job widens them, and no checkout persists the token", () => {
    expect(C.permissions).toEqual({ contents: "read" });
    for (const [jn, job] of Object.entries(C.jobs)) expect(`${jn}: ${JSON.stringify(job.permissions)}`).toBe(`${jn}: undefined`);
    const checkouts = Object.entries(C.jobs).flatMap(([jn, j]) => j.steps.filter((s) => s.uses?.startsWith("actions/checkout@")).map((s) => [jn, s] as const));
    expect(checkouts.length).toBe(Object.keys(C.jobs).length);
    for (const [jn, s] of checkouts) expect(`${jn}: ${s.with?.["persist-credentials"]}`).toBe(`${jn}: false`);
  });

  test("actionlint runs over the workflows", () => {
    const steps = Object.values(C.jobs).flatMap((j) => j.steps).filter((s) => s.uses?.startsWith("docker://rhysd/actionlint:"));
    expect(steps.length).toBe(1);
  });

  test("a Linux GUI job: suite, svelte-check, and cargo test with exactly the one --skip", () => {
    const gui = C.jobs.gui!;
    expect(gui["runs-on"]).toBe("ubuntu-22.04");
    const r = runs(gui);
    expect(r).toContain("bun install --frozen-lockfile");
    expect(r).toContain("bun run test");
    expect(r).toContain("bun run check");
    expect(r).toContain(`cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --skip ${SKIP}`);
    expect(r.join("\n").match(/--skip/g)?.length).toBe(1);
    expect(gui.defaults?.run?.["working-directory"]).toBe("gui");
  });

  test("a full, unskipped cargo test on macos-26", () => {
    const mac = C.jobs["cargo-macos"]!;
    expect(mac["runs-on"]).toBe("macos-26");
    expect(runs(mac)).toContain("cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast");
    expect(runs(mac).join("\n")).not.toContain("--skip");
    expect(runs(mac)).toContain("bash scripts/build-sidecar.sh");
  });

  test("cargo-macos installs the GUI deps (frozen) in gui/ before its cargo test", () => {
    // tests/icons.rs `regeneration_check_gate` (macOS-only) runs scripts/generate-branding.sh --check,
    // which needs gui/node_modules/.bin/tauri; without the install it failed (M2b CI run, 2026-10-01).
    const mac = C.jobs["cargo-macos"]!;
    const r = runs(mac);
    const install = r.indexOf("bun install --frozen-lockfile");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(r.indexOf("cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast"));
    expect(workdir(mac, mac.steps[install]!)).toBe("gui");
  });

  test("every job-level defaults block names shell: bash (it replaces, never merges with, a workflow-level one)", () => {
    const resolved = shellsUnderJobDefaults(C);
    expect(resolved.length).toBeGreaterThan(5);
    for (const r of resolved) expect(r).toEndWith(": bash");
  });

  test("the only --skip in the public CI is that one", () => {
    expect(Object.values(C.jobs).flatMap((j) => runs(j)).join("\n").match(/--skip [\w-]+/g)).toEqual([`--skip ${SKIP}`]);
  });
});

// ── action pins: a moved tag must not change what runs (C1) ────────────────────────────────────────
// setup-bun is third-party and runs in the macOS legs before the signing keychain is unlocked; a tag is
// a mutable pointer. So every `uses:` names a full 40-hex commit SHA with its release in a trailing
// `# vX.Y.Z` comment, and a docker:// image carries an @sha256: digest. Read from the RAW text (the
// parsed YAML drops comments), and cross-checked against the parsed `uses` values so no step escapes the
// line scan. The monorepo's own CI runs the same actions and is held to the same form where it exists.
const MONO_CI = `${ROOT}../.github/workflows/daily-briefing-ci.yml`;
const ACTION_PIN = /^\s*(?:- )?uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/;
const DOCKER_PIN = /^\s*(?:- )?uses: (docker:\/\/[\w./-]+):([\w.-]+)@sha256:[0-9a-f]{64}$/;
/** A `uses:` line's problem, or null when it is a pin in one of the two accepted forms. */
const pinProblem = (line: string): string | null =>
  ACTION_PIN.test(line) || DOCKER_PIN.test(line) ? null : `not a SHA pin with a # vX.Y.Z comment, nor a docker digest: ${line.trim()}`;
/** Every line whose key is `uses:` (a YAML comment line starts with `#`, so it never matches). */
const usesLines = (text: string): string[] => text.split("\n").filter((l) => /^\s*(?:- )?uses:/.test(l));

describe("action pins (release.yml, ci.yml, and the monorepo's daily-briefing-ci.yml)", () => {
  const files = [workflowFile("release.yml"), workflowFile("ci.yml"), ...(IN_MONOREPO ? [MONO_CI] : [])];

  test("the matcher accepts exactly the two pinned forms (negative controls)", () => {
    const sha = "11d5960a326750d5838078e36cf38b85af677262";
    const digest = "b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667";
    for (const ok of [`      - uses: actions/checkout@${sha} # v4.4.0`, `        uses: actions/upload-artifact@${sha} # v4.6.2`,
      `        uses: docker://rhysd/actionlint:1.7.12@sha256:${digest}`]) {
      expect(`${ok}: ${pinProblem(ok)}`).toBe(`${ok}: null`);
    }
    for (const bad of ["      - uses: actions/checkout@v4", `      - uses: actions/checkout@${sha}`, `      - uses: actions/checkout@${sha.slice(1)} # v4.4.0`,
      `      - uses: actions/checkout@${sha} # v4`, `      - uses: actions/checkout@${sha.toUpperCase()} # v4.4.0`, "      - uses: actions/checkout@main # v4.4.0",
      "        uses: docker://rhysd/actionlint:1.7.12", `        uses: docker://rhysd/actionlint@sha256:${digest.slice(1)}`]) {
      expect(`${bad}: ${pinProblem(bad) !== null}`).toBe(`${bad}: true`);
    }
  });

  test("every uses: in every file is pinned, and the line scan saw every parsed step", () => {
    if (IN_MONOREPO) expect(existsSync(MONO_CI), `${MONO_CI} is missing from a monorepo checkout`).toBe(true);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const lines = usesLines(text);
      for (const l of lines) expect(`${f}: ${pinProblem(l)}`).toBe(`${f}: null`);
      const parsed = Object.values((Bun.YAML.parse(text) as Workflow).jobs).flatMap((j) => j.steps).flatMap((s) => (s.uses === undefined ? [] : [s.uses]));
      // Same refs in the same order: a `uses` written any other way (a flow mapping, a quoted key) would
      // show up here as a parsed ref the line scan never checked.
      expect(lines.map((l) => /uses: (\S+)/.exec(l)![1])).toEqual(parsed);
      expect(parsed.length).toBeGreaterThan(3);
    }
  });

  test("one action, one pin: every file names the same SHA and release for the same action", () => {
    const seen = new Map<string, string>();
    for (const f of files) {
      for (const l of usesLines(readFileSync(f, "utf8"))) {
        const m = ACTION_PIN.exec(l) ?? DOCKER_PIN.exec(l);
        const name = m![1]!;
        const ref = l.trim().replace(/^(?:- )?uses: /, "");
        expect(`${name} in ${f}: ${seen.get(name) ?? ref}`).toBe(`${name} in ${f}: ${ref}`);
        seen.set(name, ref);
      }
    }
    // Non-vacuity: the actions this pipeline runs today are all reached.
    expect([...seen.keys()].sort()).toEqual(["actions/checkout", "actions/download-artifact", "actions/upload-artifact", "docker://rhysd/actionlint", "oven-sh/setup-bun"]);
  });

  test("every cargo test/build in every file is --locked (a resolution change fails, never rewrites Cargo.lock)", () => {
    let n = 0;
    for (const f of files) {
      const parsed = Bun.YAML.parse(readFileSync(f, "utf8")) as Workflow;
      for (const s of Object.values(parsed.jobs).flatMap((j) => j.steps)) {
        for (const line of (s.run ?? "").split("\n").filter((l) => /^\s*cargo (?:test|build)\b/.test(l))) {
          n++;
          expect(`${line.trim()}   (${f})`).toMatch(/^cargo (?:test|build) --locked /);
        }
      }
    }
    // release.yml's two legs, ci.yml's gui and cargo-macos, and the monorepo's cargo job.
    expect(n).toBe(IN_MONOREPO ? 5 : 4);
  });
});

// ── E6: the private monorepo's own CI (monorepo only: the export does not carry it) ─────────────────
test.skipIf(!IN_MONOREPO)("daily-briefing-ci.yml (monorepo): an ubuntu cargo test job with exactly the one --skip", () => {
  const p = `${ROOT}../.github/workflows/daily-briefing-ci.yml`;
  expect(existsSync(p), `${p} is missing from a monorepo checkout`).toBe(true);
  const M = Bun.YAML.parse(readFileSync(p, "utf8")) as Workflow;
  const cargo = M.jobs.cargo!;
  expect(cargo["runs-on"]).toBe("ubuntu-22.04");
  expect(cargo.defaults?.run?.["working-directory"]).toBe("daily_briefing_application/gui");
  const r = runs(cargo);
  expect(r).toContain("bash scripts/build-sidecar.sh");
  expect(r).toContain(`cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --skip ${SKIP}`);
  expect(Object.values(M.jobs).flatMap((j) => runs(j)).join("\n").match(/--skip [\w-]+/g)).toEqual([`--skip ${SKIP}`]);
  // No macOS job in the private monorepo (billed at a multiple).
  expect(Object.values(M.jobs).map((j) => j["runs-on"]).filter((o) => String(o).startsWith("macos"))).toEqual([]);
  // Every job-level defaults block names shell: bash (it replaces the workflow-level block wholesale).
  const resolved = shellsUnderJobDefaults(M);
  expect(resolved.length).toBeGreaterThan(5);
  for (const r of resolved) expect(r).toEndWith(": bash");
});

// Round 4 (D4-L3): read-only, as the public ci.yml is — a workflow-level read-only token, no job widening
// it, and no checkout leaving it on disk for the steps after it.
test.skipIf(!IN_MONOREPO)("daily-briefing-ci.yml (monorepo): permissions are contents: read, no job widens them, and no checkout persists the token", () => {
  const M = Bun.YAML.parse(readFileSync(MONO_CI, "utf8")) as Workflow;
  expect(M.permissions).toEqual({ contents: "read" });
  for (const [jn, job] of Object.entries(M.jobs)) expect(`${jn}: ${JSON.stringify(job.permissions)}`).toBe(`${jn}: undefined`);
  const checkouts = Object.entries(M.jobs).flatMap(([jn, j]) => j.steps.filter((s) => s.uses?.startsWith("actions/checkout@")).map((s) => [jn, s] as const));
  expect(checkouts.map(([jn]) => jn)).toEqual(["check", "gui", "cargo"]);
  for (const [jn, s] of checkouts) expect(`${jn}: ${s.with?.["persist-credentials"]}`).toBe(`${jn}: false`);
});
