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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Paths that resolve in the monorepo can be missing in the exported layout; this is the suite that
    // guards the npm tarball, and the public CI and release.yml run it there. No `bun install` needed:
    // it imports only bun:test and node builtins (measured: 0.11 s in an uninstalled export).
    // The inner run's preload arms its OWN isolation baselines (test/fixtures/isolate-state.ts) under its
    // TMPDIR and, by design, never removes them. Left to inherit ours, that was a second
    // `dba-isolated-*` pair in TMPDIR after every full run, against the documented one pair (measured).
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
    const armed = readdirSync(innerTmp).map((n) => /^dba-isolated-(config|state)-/.exec(n)?.[1]).filter(Boolean).sort();
    expect(armed, "the inner run's isolation baselines are not in its own TMPDIR: either `env` no longer hands the child innerTmp, or the exported tree no longer loads its preload").toEqual(["config", "state"]);
    // A green exit is also what a test "fixed" by skipping it in the exported layout produces. That file
    // has no conditional tests, so any skip there is exactly that.
    expect(innerOut, `publish-prep.test.ts SKIPPED tests inside the export:\n${innerOut}`).not.toMatch(/^\s*[1-9]\d* skip\s*$/m);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}, 60_000);
