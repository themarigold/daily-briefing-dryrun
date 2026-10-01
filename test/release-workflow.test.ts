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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
}
interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: unknown;
  "continue-on-error"?: unknown;
  permissions?: unknown;
  strategy?: { "fail-fast"?: unknown; matrix?: { include?: Record<string, string>[] } };
  defaults?: { run?: { "working-directory"?: string } };
  env?: Env;
  outputs?: Env;
  steps: Step[];
}
interface Workflow { on: unknown; permissions?: unknown; env?: Env; defaults?: unknown; jobs: Record<string, Job> }

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
    expect(run).toMatch(/got="\$\("\$sidecar" --version\)"/);
    expect(run).toMatch(/arch -x86_64 \/usr\/bin\/true/);
    expect(run).toMatch(/SKIP: x86_64 sidecar --version/);
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
  // (built here with `tar`) as the package's data member, and a stub AppImage extracts a sidecar that
  // prints the version. The tarball is built in BOTH member-name forms: BARE (`usr/bin/…`, what
  // tauri-bundler writes — debian.rs `strip_prefix`) and `./`-prefixed (what `dpkg-deb --build` writes).
  // The old `dpkg-deb --contents | sed -n 's|^.* \./|./|p'` listing found nothing in the bare form, so
  // every healthy Linux leg was marked build-failed; this test fails on that sed.
  test("Linux smoke, run: the deb member check passes for bare AND ./-prefixed member names, fails on a missing one", () => {
    const script = stepById(linux, "smoke").run!;
    const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-linux-smoke-")));
    const version = "0.2.0";
    const required = ["usr/bin/daily-briefing-gui", "usr/bin/daily-briefing", "usr/share/applications/Daily Briefing.desktop"];
    const sh = (cmd: string[], cwd?: string) => {
      const r = Bun.spawnSync(cmd, { cwd, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
      expect(`${cmd.join(" ")}: ${r.exitCode} ${r.stderr}`).toBe(`${cmd.join(" ")}: 0 `);
    };
    const smoke = (name: string, members: string[], prefixed: boolean) => {
      const dir = join(base, name);
      const root = join(dir, "root");
      for (const m of members) {
        mkdirSync(join(root, m, ".."), { recursive: true });
        writeFileSync(join(root, m), "");
      }
      const tarball = join(dir, "data.tar");
      sh(prefixed ? ["tar", "-cf", tarball, "-C", root, "."] : ["tar", "-cf", tarball, "-C", root, "usr"]);
      const bin = join(dir, "bin");
      const temp = join(dir, "runner-temp");
      const stage = join(temp, "stage");
      for (const d of [bin, stage]) mkdirSync(d, { recursive: true });
      writeFileSync(join(bin, "dpkg-deb"),
        "#!/bin/sh\n" +
        "case \"$1\" in\n" +
        `  --info) printf ' Package: daily-briefing\\n Version: ${version}\\n Architecture: amd64\\n' ;;\n` +
        `  --fsys-tarfile) cat "${tarball}" ;;\n` +
        // What the OLD smoke called: an `ls -l`-style listing, as dpkg-deb --contents prints it.
        `  --contents) tar -tvf "${tarball}" ;;\n` +
        "  *) echo \"dpkg-deb stub: unexpected $*\" >&2; exit 2 ;;\n" +
        "esac\n", { mode: 0o755 });
      writeFileSync(join(stage, `daily-briefing-${version}-linux-x86_64.AppImage`),
        "#!/bin/sh\n" +
        "[ \"$1\" = --appimage-extract ] || exit 2\n" +
        "mkdir -p squashfs-root/usr/bin\n" +
        `printf '#!/bin/sh\\necho ${version}\\n' > squashfs-root/usr/bin/daily-briefing\n` +
        "chmod +x squashfs-root/usr/bin/daily-briefing\n", { mode: 0o755 });
      writeFileSync(join(stage, `daily-briefing_${version}_amd64.deb`), "stub: dpkg-deb never reads it\n");
      const r = Bun.spawnSync(["bash", "-c", script], {
        env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TEMP: temp, GITHUB_REF_NAME: `v${version}`, LEG: "linux-x86_64" },
        stdout: "pipe", stderr: "pipe",
      });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    for (const prefixed of [false, true]) {
      const form = prefixed ? "./-prefixed" : "bare";
      const ok = smoke(`ok-${form.replace(/\W/g, "")}`, required, prefixed);
      expect(`${form}: ${ok.code} ${ok.out}`).toStartWith(`${form}: 0 `);
      expect(ok.out).toContain("smoke: ok (linux-x86_64)");
      // Exact-line match: a missing file is caught even when a longer sibling name starts with it.
      for (const drop of required) {
        const r = smoke(`missing-${form.replace(/\W/g, "")}-${required.indexOf(drop)}`, required.filter((m) => m !== drop), prefixed);
        expect(`${form} without ${drop}: ${r.code}`).toBe(`${form} without ${drop}: 1`);
        expect(r.out).toContain(`deb: ${drop} is missing from the package contents`);
      }
    }
    // Eight full smoke runs, each executing three freshly written scripts: macOS scans every new
    // executable on first exec (~0.2 s each, measured 2026-10-01), so the 5 s default is too tight.
  }, 30_000);

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
    expect(macRun).toMatch(/^cargo test --manifest-path src-tauri\/Cargo\.toml --no-fail-fast$/m);
    expect(macRun).not.toContain("--skip");
    expect(linRun).toMatch(new RegExp(`^cargo test --manifest-path src-tauri/Cargo\\.toml --no-fail-fast -- --skip ${SKIP}$`, "m"));
    expect(linRun.match(/--skip/g)?.length).toBe(1);
    // No other step of either workflow file skips anything.
    expect(Object.values(J).flatMap((j) => j.steps).filter((s) => s.run?.includes("--skip")).length).toBe(1);
  });

  test("bundle-windows turns off CRLF conversion BEFORE its checkout (no .gitattributes is tracked)", () => {
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

  test("bundle-linux runs on the pinned ubuntu-22.04 image; macOS on macos-14", () => {
    expect(linux["runs-on"]).toBe("ubuntu-22.04");
    expect(mac["runs-on"]).toBe("macos-14");
    expect(win["runs-on"]).toBe("windows-latest");
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
    expect(create.run).toContain('gh release create "$TAG" dist/* --title "$TAG" --notes-file "$RUNNER_TEMP/notes.md"');
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
    expect(check.steps.map((s) => s.run ?? s.uses)).toEqual([
      "actions/checkout@v4", "oven-sh/setup-bun@v2", "bun install --frozen-lockfile", "bunx tsc --noEmit", "bun test",
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
    expect(r).toContain(`cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --skip ${SKIP}`);
    expect(r.join("\n").match(/--skip/g)?.length).toBe(1);
    expect(gui.defaults?.run?.["working-directory"]).toBe("gui");
  });

  test("a full, unskipped cargo test on macos-14", () => {
    const mac = C.jobs["cargo-macos"]!;
    expect(mac["runs-on"]).toBe("macos-14");
    expect(runs(mac)).toContain("cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast");
    expect(runs(mac).join("\n")).not.toContain("--skip");
    expect(runs(mac)).toContain("bash scripts/build-sidecar.sh");
  });

  test("the only --skip in the public CI is that one", () => {
    expect(Object.values(C.jobs).flatMap((j) => runs(j)).join("\n").match(/--skip [\w-]+/g)).toEqual([`--skip ${SKIP}`]);
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
  expect(r).toContain(`cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --skip ${SKIP}`);
  expect(Object.values(M.jobs).flatMap((j) => runs(j)).join("\n").match(/--skip [\w-]+/g)).toEqual([`--skip ${SKIP}`]);
  // No macOS job in the private monorepo (billed at a multiple).
  expect(Object.values(M.jobs).map((j) => j["runs-on"]).filter((o) => String(o).startsWith("macos"))).toEqual([]);
});
