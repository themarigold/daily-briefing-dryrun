// test/export-public.test.ts — the PUBLIC-REPO boundary, exercised rather than assumed.
//
// WHY THIS EXISTS. `scripts/export-public.sh` builds the tree that gets pushed to the public repo, and
// it refuses (exit 1) when that tree carries an identity/vault residual. Nothing ran it between
// releases, so `main` was found unexportable on 2026-09-19, with the oldest residual dating from
// 2026-09-08: two test files carried residuals, and separately `test/publish-prep.test.ts` could not find
// its own inputs in the exported layout, which would have failed the public CI and release.yml's gate
// step after the next re-export. CI runs `bun test`, so the export now runs inside it.
//
// Monorepo only. The exported tree carries neither `publish/` nor the export script (the script
// excludes itself), so there this reports as a skip. In the monorepo a missing script FAILS rather than
// skips: `publish/` is the layout marker, the same one publish-prep.test.ts uses.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const IN_MONOREPO = existsSync(`${ROOT}publish`);
const SCRIPT = `${ROOT}scripts/export-public.sh`;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

test.skipIf(!IN_MONOREPO)("⚠ the public export passes its HARD residual sweep, and the npm-boundary suite passes inside it", () => {
  expect(existsSync(SCRIPT), "scripts/export-public.sh is missing from a monorepo checkout").toBe(true);
  // The script refuses an existing target, so export into a fresh child of a temp dir. Registered as a
  // safety net, but removed HERE: the run-end drain is one afterAll with bun's 5000 ms budget that
  // already overruns under load, and a whole exported tree (~380 files) should not ride on it.
  const parent = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-export-public-")));
  const target = join(parent, "tree");
  try {
    const exp = Bun.spawnSync(["bash", SCRIPT, target], { stdout: "pipe", stderr: "pipe" });
    const out = text(exp.stdout), err = text(exp.stderr);
    // The script prints each residual hit on stdout and its verdict on stderr; show both on failure.
    expect(exp.exitCode, `export-public.sh failed:\n${out}\n${err}`).toBe(0);
    expect(out).toContain("hard residual sweep: clean");
    // ⚠ Belt to the script's own exit-code check. Until 2026-09-21 the sweep was `if grep …; then exit
    // 1; fi`, which read a grep ERROR (exit 2 — e.g. a HARD edit that is valid JS but invalid ERE) as
    // "no match" and printed "clean" over a tree it never searched (measured in review, BSD and GNU
    // grep both). The script now fails closed; any `grep:` on stderr still voids the verdict here, so
    // a regression of that fix cannot pass silently.
    expect(err, `the HARD sweep's grep errored, so its "clean" verdict is void:\n${err}`).not.toMatch(/grep:/);

    // v0.2.1 §5: the bug-report form ships at the export ROOT, through the tracked `publish/**` overlay.
    // Tracked-only, so a form left uncommitted (or only on disk) is missing here and this fails.
    expect(existsSync(join(target, ".github", "ISSUE_TEMPLATE", "bug.yml")), "the export has no .github/ISSUE_TEMPLATE/bug.yml — is publish/.github/ISSUE_TEMPLATE/bug.yml tracked?").toBe(true);

    // Paths that resolve in the monorepo can be missing in the exported layout; this is the suite that
    // guards the npm tarball, and the public CI and release.yml run it there. No `bun install` needed:
    // it imports only bun:test and node builtins (measured: 0.11 s in an uninstalled export).
    // The inner run's preload arms its OWN isolation baselines (test/fixtures/isolate-state.ts) under its
    // TMPDIR and, by design, never removes them. Left to inherit ours, that was a second
    // `dba-isolated-*` set in TMPDIR after every full run, against the documented one set (measured when
    // it was a pair; Batch 2 added `dba-isolated-units-*`, which the assertion below lists since the M9 LOW
    // pass, L19).
    // So its TMPDIR lives inside `parent`, which the `finally` below removes. It is handed over through
    // `env` (wrapping the command in `env TMPDIR=…` would also work); assigning process.env.TMPDIR here
    // would not, because a child spawned without `env` gets bun's STARTUP environment. The spread also forwards what earlier test files left
    // in process.env (measured: audit-main's DAILY_BRIEFING_STATE_DIR / XDG_CONFIG_HOME); the child's
    // own preload overrides both, so it still starts isolated.
    const innerTmp = join(parent, "tmp");
    mkdirSync(innerTmp);
    const inner = Bun.spawnSync(["bun", "test", "test/publish-prep.test.ts"], {
      cwd: target, env: { ...process.env, TMPDIR: innerTmp }, stdout: "pipe", stderr: "pipe",
    });
    const innerOut = `${text(inner.stdout)}\n${text(inner.stderr)}`;
    expect(inner.exitCode, `publish-prep.test.ts failed INSIDE the export:\n${innerOut}`).toBe(0);
    // …and they did land there, which also shows the exported tree's own isolation is live. Missing
    // entries mean one of two things: the redirect stopped reaching the child (the pair is back in the
    // shared TMPDIR), or the export no longer arms its preload (bunfig.toml or the fixture dropped).
    const armed = readdirSync(innerTmp).map((n) => /^dba-isolated-(config|state|units)-/.exec(n)?.[1]).filter(Boolean).sort();
    expect(armed, "the inner run's isolation baselines are not in its own TMPDIR: either `env` no longer hands the child innerTmp, or the exported tree no longer loads its preload").toEqual(["config", "state", "units"]);
    // A green exit is also what a test "fixed" by skipping it in the exported layout produces. That file
    // has no conditional tests, so any skip there is exactly that.
    expect(innerOut, `publish-prep.test.ts SKIPPED tests inside the export:\n${innerOut}`).not.toMatch(/^\s*[1-9]\d* skip\s*$/m);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 60_000);

// ── The SOFT sweep fails closed too (review L3, 2026-10-01) ─────────────────────────────────────────────
// It was `grep … | grep -v … | grep -v … || echo "  (none)"`: a first grep that could not search (exit 2)
// left the filters an empty input, the pipeline exited 1, and "(none)" was printed — which release-check
// reads as a clean sweep. Driven here on a tiny fixture repo with a PATH `grep` that fails only for the
// soft pattern, so the HARD sweep (which runs first, over the same tree) still runs for real. The private
// names are built by concatenation so this file never becomes a soft residual of the real export.
const SOFT_NAME = "quant_" + "stocks";
const AUTHOR = "Harsh" + "il";
const GIT = Bun.which("git")!;

function softFixture(): { repo: string; target: string; stubs: string } {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-export-soft-")));
  const repo = join(base, "repo");
  for (const d of ["scripts", "test", "publish"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, "scripts", "export-public.sh"), readFileSync(SCRIPT));
  writeFileSync(join(repo, "a.txt"), "hello\n");
  writeFileSync(join(repo, "LICENSE"), `Copyright (c) 2026 ${AUTHOR}\n`);
  writeFileSync(join(repo, "README.md"), `MIT (c) ${AUTHOR}\n`);
  // Names that merely START with the two exempt ones: listed like any other file (exact-match exemption).
  writeFileSync(join(repo, "LICENSE-THIRD-PARTY"), `bundled by ${AUTHOR}\n`);
  writeFileSync(join(repo, "README.md.orig"), `old copy, ${AUTHOR}\n`);
  writeFileSync(join(repo, "test", "fixture.ts"), `export const repoName = "${SOFT_NAME}";\n`);
  writeFileSync(join(repo, "publish", "overlay.txt"), "overlay\n");
  const env = { PATH: `${dirname(GIT)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=f", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]]) {
    const r = Bun.spawnSync([GIT, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${text(r.stderr)}`);
  }
  const stubs = join(base, "bin");
  mkdirSync(stubs);
  // Fails only the soft sweep's search; every other grep (the HARD sweep, any filter) is the real one.
  writeFileSync(join(stubs, "grep"), `#!/bin/sh\ncase "$*" in *"${SOFT_NAME}"*) echo "grep: simulated read error" >&2; exit 2 ;; esac\nexec "${Bun.which("grep")}" "$@"\n`, { mode: 0o755 });
  return { repo, target: join(base, "export"), stubs };
}
function exportWith(fx: { repo: string; target: string }, PATH: string) {
  const r = Bun.spawnSync(["bash", join(fx.repo, "scripts", "export-public.sh"), fx.target], {
    env: { PATH, HOME: fx.repo }, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: text(r.stdout), err: text(r.stderr) };
}

test.skipIf(!IN_MONOREPO)("the SOFT sweep lists its residuals, never LICENSE or README.md themselves, and prints (none) only when there are none", () => {
  const fx = softFixture();
  const r = exportWith(fx, `${dirname(GIT)}:/usr/bin:/bin`);
  expect(r.code, r.out + r.err).toBe(0);
  const soft = r.out.split("— soft residuals")[1]!.split("\n— ")[0]!.split("\n").slice(1).filter(Boolean);
  expect(soft.sort()).toEqual([join(fx.target, "LICENSE-THIRD-PARTY"), join(fx.target, "README.md.orig"), join(fx.target, "test", "fixture.ts")].sort());
});

test.skipIf(!IN_MONOREPO)("a SOFT sweep that could not run fails the export (exit 1), never prints (none)", () => {
  const fx = softFixture();
  const r = exportWith(fx, `${fx.stubs}:${dirname(GIT)}:/usr/bin:/bin`);
  expect(r.out).toContain("— hard residual sweep: clean");   // the HARD sweep ran for real and passed
  expect(r.code, r.out + r.err).toBe(1);
  expect(r.err).toContain("SOFT residual sweep could not run (grep exit 2)");
  expect(r.out).not.toContain("(none)");
});
