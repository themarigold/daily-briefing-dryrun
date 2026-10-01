// test/publish-prep.test.ts — the npm PUBLISH boundary, pinned.
//
// WHY THIS EXISTS. `npm publish` is irreversible in the way that matters: a tarball that ships the
// author's private EVAL log, a vault path, or a `.env` cannot be unpublished out of anyone's cache.
// Before this file the package had NO `files` allowlist, so `bun pm pack --dry-run` shipped 208
// files / 3.51MB — including `EVAL.md` (0.40MB of the author's personal day-by-day briefing log),
// `STATE.md` (vault-coupled agent orientation), the whole `test/` tree, the `publish/` CI overlay,
// and the dated personal measurement scripts that `scripts/export-public.sh` already classifies as
// private. The allowlist cuts that by roughly two thirds; these tests are what stop it drifting back.
//
// ⚠ NO ABSOLUTE FILE COUNT IS PINNED, here or in docs/publishing.md. The first version of both quoted
// one, and the two docs added in the same commit invalidated it before the commit even landed. The
// pack list is the source of truth and every assertion below reads it live.
//
// ⚠ THE `private: true` PIN IS DELIBERATELY IN THE WAY. The flip to publishable is a USER-GATED
// release action (see docs/publishing.md), not a maintenance edit — so an accidental or incidental
// flip must break the suite loudly, and the real release flow must EDIT THIS TEST on purpose,
// which is the moment the gate gets read.
//
// ⚠ THIS FILE RUNS IN TWO LAYOUTS. In the monorepo checkout, and in the PUBLIC tree that
// `scripts/export-public.sh` builds — whose own CI and release.yml run this suite. The export moves
// `publish/`'s contents to the tree root and excludes the export script itself, so every path this
// file reads must resolve in both (see `workflowText` and the residual test below).
// `test/export-public.test.ts` runs this file inside a fresh export on every monorepo `bun test`.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";

// `decodeURIComponent` is load-bearing, not decoration: `URL.pathname` is percent-encoded, so a
// checkout under a path containing a space (or any other escaped char) would otherwise produce
// "%20" in every file path this suite builds and fail with a confusing ENOENT rather than a real
// finding. The repo's own docs recommend no particular checkout location, so this must not care.
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);

// `publish/` exists only in the monorepo: the export strips it onto the tree root. It is the layout
// marker because it is the monorepo-only path this file already depends on.
const IN_MONOREPO = existsSync(`${ROOT}publish`);

const pkg = async () => JSON.parse(await Bun.file(`${ROOT}package.json`).text());

/** A publish workflow's text. They live under `publish/.github/workflows/` in the monorepo and at
 *  `.github/workflows/` in the exported tree; reading only the first made this suite fail with ENOENT
 *  in the public tree, i.e. in the public CI and in release.yml's own gate step. */
async function workflowText(wf: string): Promise<string> {
  for (const dir of ["publish/.github/workflows", ".github/workflows"]) {
    const f = Bun.file(`${ROOT}${dir}/${wf}`);
    if (await f.exists()) return f.text();
  }
  throw new Error(`${wf} found under neither publish/.github/workflows/ nor .github/workflows/`);
}

/** The pack list, straight from the tool that will build the real tarball. `--dry-run` writes
 *  nothing, takes ~10ms, and — unlike a hand-maintained expectation — cannot disagree with what
 *  `npm publish` would actually upload. Memoised: one spawn for the whole file. */
let packedCache: string[] | null = null;
async function packedFiles(): Promise<string[]> {
  if (packedCache) return packedCache;
  const p = Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(p.stdout);
  expect(p.exitCode, `bun pm pack --dry-run failed: ${new TextDecoder().decode(p.stderr)}`).toBe(0);
  // "packed 50.34KB scripts/audit.ts" — strip the literal and the size token, keep the rest as the
  // path (a trailing-token split would shatter a path containing a space).
  packedCache = out.split("\n").filter((l) => l.startsWith("packed "))
    .map((l) => l.replace(/^packed \S+ /, "").trim()).filter(Boolean);
  expect(packedCache.length).toBeGreaterThan(0);
  return packedCache;
}

// ── the gate itself ──────────────────────────────────────────────────────────────────────────────

test("⚠ RELEASE GATE: package.json still carries private:true", async () => {
  // Publishing is a per-action, user-approved step. `private: true` is what makes `npm publish`
  // refuse outright, so it is the last mechanical thing between an automated agent and an
  // irreversible public upload. If you are reading this because the test went red: the flip is only
  // legitimate as part of the documented release sequence in docs/publishing.md, performed by a
  // human who said yes to THAT action. Anything else is a bug — restore the flag.
  expect((await pkg()).private).toBe(true);
});

test("version is BARE semver — the tag guard only strips a leading 'v'", async () => {
  // release.yml's gate runs `scripts/check-versions.sh "${GITHUB_REF_NAME#v}"`, which compares
  // `package.json#version` (and the other version carriers) against the tag minus its "v". A version
  // that itself carried a "v", or a non-semver string, would make that comparison unsatisfiable for
  // every tag shape the workflow triggers on.
  const v = (await pkg()).version;
  expect(v).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});

test("bin target exists, is inside the allowlist, and carries a shebang", async () => {
  // On POSIX, npm links a bin by symlink and the kernel reads line 1. A `bin` pointing at a
  // TypeScript file with no shebang installs cleanly and fails only on the consumer's first
  // invocation — the worst shape of publish defect, invisible to every local gate.
  const p = await pkg();
  const targets = Object.values(p.bin as Record<string, string>);
  expect(targets.length).toBeGreaterThan(0);
  for (const t of targets) {
    expect(await Bun.file(`${ROOT}${t}`).exists()).toBe(true);
    const first = (await Bun.file(`${ROOT}${t}`).text()).split("\n")[0]!;
    expect(first).toStartWith("#!");
    expect(await packedFiles()).toContain(t);   // a bin outside `files` ships a broken package
  }
});

test("engines.bun floor agrees with the bun version the publish workflows pin", async () => {
  // Two sources of truth for "which bun this needs" WILL drift. The workflows are owned elsewhere
  // (release.yml is not this task's to edit), so this asserts agreement rather than dictating
  // either side: if it goes red, one of the two moved and the other has to follow.
  const engines = (await pkg()).engines?.bun as string | undefined;
  expect(engines).toBeTruthy();
  const floor = engines!.replace(/^[^\d]*/, "");
  for (const wf of ["ci.yml", "release.yml"]) {
    const text = await workflowText(wf);
    const pinned = text.match(/bun-version:\s*"([^"]+)"/)?.[1];
    expect(pinned, `${wf} has no pinned bun-version`).toBeTruthy();
    expect(pinned, `engines.bun (${engines}) vs ${wf} bun-version (${pinned})`).toBe(floor);
  }
});

// ── the pack list ────────────────────────────────────────────────────────────────────────────────

test("the tarball ships the source set the bin actually needs", async () => {
  const files = await packedFiles();
  for (const f of ["package.json", "README.md", "LICENSE", "src/main.ts", "src/core.ts",
                   "src/eval/checks.ts", "src/transcripts/scan.ts", "src/providers/http.ts"]) {
    expect(files, `${f} missing from the tarball`).toContain(f);
  }
});

test("⚠ the tarball ships NO private, state, archive, env or build artefact", async () => {
  // The enumerated shapes are the ones this repo actually produces. `EVAL.md` and `STATE.md` are
  // named individually because they are TRACKED, in the repo root, and therefore invisible to every
  // .gitignore-shaped intuition about what packs — they are exactly what shipped before the
  // allowlist existed.
  const files = await packedFiles();
  const forbidden: [RegExp, string][] = [
    [/^EVAL\.md$/, "the author's private day-by-day briefing log"],
    [/^STATE\.md$/, "vault-coupled agent orientation"],
    [/^test\//, "the test tree"],
    [/^publish\//, "the CI/release overlay"],
    [/^(dist|node_modules|out|coverage|logs)\//, "a build/dep/output directory"],
    [/(^|\/)\.env/, "an env file"],
    [/\.(tgz|exe|bun-build|lcov|log)$/, "a build artefact"],
    [/(^|\/)\.(git|claude|idea|DS_Store)/, "tooling/editor state"],
    [/(^|\/)(last-run|last-skip|briefings?|archive)(\/|$)/, "run state or a briefing archive"],
    [/^scripts\/(measure|probe|sample|commits-per-unit-day|derive-user-turn|export-public)/,
      "a dated personal measurement script (see scripts/export-public.sh EXCLUDES)"],
  ];
  for (const f of files) {
    for (const [re, why] of forbidden) {
      expect(re.test(f), `tarball ships ${f} — ${why}`).toBe(false);
    }
  }
});

test("⚠ every packed path is covered by the `files` allowlist", async () => {
  // The complement of the blocklist above: a blocklist alone only catches shapes someone thought of.
  // This fails on anything NEW that starts packing, which is the case a forbidden-list cannot see.
  const p = await pkg();
  const allow: string[] = p.files;
  expect(Array.isArray(allow)).toBe(true);
  const covered = (f: string) =>
    f === "package.json" || allow.some((a) => f === a || f.startsWith(`${a}/`));
  for (const f of await packedFiles()) {
    expect(covered(f), `${f} is packed but matches no entry in package.json#files`).toBe(true);
  }
});

test("⚠ every path a shipped `scripts` entry references either ships or is documented repo-only", async () => {
  // The `files` allowlist and `package.json#scripts` are two hands that must agree, and npm ships
  // package.json VERBATIM — every script entry travels whether or not its target does. A shipped
  // entry pointing at an absent file is a dead advertised command; this repo had one
  // (`scripts.eval` → scripts/eval.ts, whose import graph reaches test/fixtures/, which the
  // allowlist deliberately excludes — `bun build` against the packed tree failed to resolve it).
  //
  // The ruling was to keep the script working IN THE REPO and stop shipping the file, which leaves
  // exactly one honest obligation: say so where a reader looks. So a referenced path must either be
  // in the tarball or be listed as `repo-only` in docs/publishing.md. A presence check alone could
  // not see this — the file was present, it just could not resolve.
  const p = await pkg();
  const doc = await Bun.file(`${ROOT}docs/publishing.md`).text();
  const repoOnly = new Set(
    doc.split("\n").filter((l) => /repo-only/i.test(l))
      .flatMap((l) => [...l.matchAll(/`([\w./-]+\.(?:ts|sh|js))`/g)].map((m) => m[1]!)));
  const packed = await packedFiles();
  for (const [name, cmd] of Object.entries(p.scripts as Record<string, string>)) {
    for (const ref of [...cmd.matchAll(/(?:src|scripts|test)\/[\w./-]+\.(?:ts|sh|js)/g)].map((m) => m[0])) {
      expect(packed.includes(ref) || repoOnly.has(ref),
        `scripts.${name} references ${ref}, which neither ships nor is listed as repo-only in docs/publishing.md`)
        .toBe(true);
    }
  }
});

test("⚠ no packed FILE CONTENT carries an identity, vault or CREDENTIAL residual", async () => {
  // The HARD pattern `scripts/export-public.sh` gates its public export on, applied to the npm
  // tarball — the other way this repo's content reaches strangers. A path-level allowlist cannot
  // see a personal absolute path embedded in a shipped source file.
  // `/Users/me` and `/x` fixture placeholders are deliberately NOT matched.
  //
  // ⚠ THE IDENTITY HALF IS READ FROM THE EXPORT SCRIPT, NEVER WRITTEN HERE. This file ships to the
  // public repo; the export script does not (it excludes itself for exactly this reason). The first
  // version declared the author's identity tokens literally on this line, so the check shipped the
  // residual it exists to catch and the export's own sweep refused the tree. So: in the monorepo the
  // identity half is the script's `HARD='…'` line, one list for both gates. In the exported tree the
  // script is absent and the identity half is inert by design: every file there passed that sweep at
  // export time. That covers the public repo only while it changes by re-export alone (the ruling of
  // 2026-08-29); a commit made directly there gets the credential and email shapes from this test and
  // no identity check.
  //
  // ⚠ THE CREDENTIAL SHAPES ARE THE SECOND HALF, added in round-2 review. `src` and `docs` are
  // WHOLESALE allowlist entries, so a new file under either ships silently; before this, the only
  // thing that could stop it was one of four IDENTITY tokens appearing in it. A pasted key — the
  // residual with the worst consequences — carries none of them and sailed through. The shapes are
  // deliberately prefix-anchored and length-bounded so ordinary prose about a key ("an sk-ant- key
  // goes in the env") does not trip them; only something key-SHAPED does. They and the personal-
  // email shape name no one, so they stay literal and stay live in BOTH layouts.
  const SHAPES = /[A-Za-z0-9._%+-]+@(gmail|icloud|hotmail|yahoo)\.|sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{12,}/;
  const script = Bun.file(`${ROOT}scripts/export-public.sh`);
  let identity: string | undefined;
  if (await script.exists()) {
    identity = (await script.text()).match(/^HARD='([^']+)'/m)?.[1];
    // Loud, not lenient: an unparseable line would otherwise drop the identity half without a sound.
    expect(identity, "scripts/export-public.sh has no parseable single-line HARD='…' pattern").toBeTruthy();
    // The script's pattern is grep ERE. Two ERE spellings mean something else in a JS RegExp, so the
    // gates would silently disagree: a POSIX class anywhere in a bracket (`[[:alpha:]]`, `[_[:space:]]`)
    // and GNU's word boundaries `\<` / `\>` (JS reads those as a literal `<` / `>`).
    expect(identity!, "HARD uses an ERE-only construct ([:class:], \\< or \\>) that a JS RegExp reads differently")
      .not.toMatch(/\[:|\\[<>]/);
  } else {
    expect(IN_MONOREPO, "scripts/export-public.sh is missing from a monorepo checkout").toBe(false);
  }
  // `m`: grep matches line by line, so `^`/`$` in the script's pattern mean start/end of LINE there.
  const HARD = new RegExp(identity ? `${identity}|${SHAPES.source}` : SHAPES.source, "m");
  if (identity) {
    // Positive control: the combined pattern must still catch the script's own first plain-literal
    // token. Without it, dropping the identity half from the line above left every test green.
    const probe = identity.split("|").find((alt) => /^[\w ./-]+$/.test(alt));
    expect(probe, "HARD has no plain-literal alternative to probe the identity half with").toBeTruthy();
    expect(HARD.test(probe!), "the identity half of HARD is not being applied").toBe(true);
  }
  const hits: string[] = [];
  for (const f of await packedFiles()) {
    const text = await Bun.file(`${ROOT}${f}`).text().catch(() => "");
    if (HARD.test(text)) hits.push(f);
  }
  expect(hits, `identity/vault/credential residuals in the tarball: ${hits.join(", ")}`).toEqual([]);
});

test("the publish runbook exists and is RELEASE-READY-ONLY", async () => {
  // The executable artefact in that doc (the publish sequence) is the thing an agent would otherwise
  // reconstruct from memory. Pinning its existence and its banner keeps the gate attached to it.
  const doc = await Bun.file(`${ROOT}docs/publishing.md`).text();
  expect(doc).toContain("RELEASE-READY-ONLY");
  expect(doc).toContain("npm publish");
  expect(doc).toContain("private");
});
