# Publishing to npm — ON HOLD

> ## ⏸ ON HOLD since 2026-10-01
>
> **npm publication is deferred** (maintainer decision, 2026-10-01). Releases ship through GitHub
> Releases and the Homebrew tap only, and **the release runbook is [`docs/RELEASE.md`](RELEASE.md)**:
> bump, release check, export, push, tag, verify. Nothing in this file is part of a release today. It is
> kept so the npm path can be picked up later without being rediscovered, and because
> `test/publish-prep.test.ts` still guards the npm tarball on every `bun test`.

> ## ⛔ RELEASE-READY-ONLY ⛔
>
> **Nothing in this document is a maintenance task, and no part of it is pre-approved.**
> Every step below that leaves this machine — flipping `private`, `npm publish` — is **irreversible
> in the way that matters**: a published version cannot be un-published out of anyone's lockfile or
> cache, and `npm unpublish` is refused after 72 hours (and is itself a hostile act against anyone who
> already depends on it).
>
> **Each public action needs its own explicit "yes" from the maintainer, at the moment it is
> taken.** Approval of the release as a whole is NOT approval of the individual steps. An agent
> reading this file has read a runbook, not a permission: it may prepare, inspect, and report —
> it may not flip `private`, tag, push, or publish.
>
> The repository ships `"private": true` on purpose. `test/publish-prep.test.ts` pins it, so an
> accidental flip turns the suite red. That test is meant to be edited **by a human, deliberately,
> as step 2 of the sequence below** — the edit is the gate being read, not an obstacle to route around.

---

## What is already prepared (no action needed)

| Thing | State | Where |
| --- | --- | --- |
| `bin` → `daily-briefing` | wired, and `src/main.ts` carries `#!/usr/bin/env bun` | `package.json`, `src/main.ts:1` |
| `engines.bun` | `>=1.3.14`, pinned equal to the workflows' `bun-version` | `package.json`, `publish/.github/workflows/*.yml` |
| `files` allowlist | present — it cut the tarball by roughly two thirds (it was 208 files / 3.51 MB with no allowlist at all) | `package.json#files` |
| version == tag guard | `scripts/check-versions.sh` (all four version carriers), run by `release.yml`'s `gate` job against the tag | `publish/.github/workflows/release.yml`, step *Versions must match tag* |
| tarball assertions | run in the suite on every `bun test` | `test/publish-prep.test.ts` |
| `private: true` | **kept** — the flip is step 2 below | `package.json` |

The allowlist deliberately **excludes** `EVAL.md` (the author's private day-by-day briefing log),
`STATE.md`, `test/`, `publish/`, and the dated personal measurement scripts — the same set
`scripts/export-public.sh` classifies as private. Without it those all shipped.
**No absolute file count is quoted here on purpose**: any new doc or source file moves it, and a
number in prose that nothing asserts drifts silently (it already did — the count stated here was
invalidated by the two docs added in the same commit that measured it). `bun pm pack --dry-run` is
the source of truth; `test/publish-prep.test.ts` reads that list rather than a pinned number.

### Repo-only tooling (deliberately NOT in the tarball)

| `package.json` entry | Path | Why it does not ship |
| --- | --- | --- |
| `scripts.eval` | `scripts/eval.ts` | **repo-only** dev tooling. The eval harness reaches `test/fixtures/`, which the allowlist excludes, so a shipped copy could not resolve its own imports — `bun build scripts/eval.ts` against the packed tree failed on `../../test/fixtures/eval-repo`. It has no consumer story either: the published CLI advertises no `eval` subcommand. It stays fully working **in the repo** (`bun run eval`), which is its only audience. |

`test/publish-prep.test.ts` asserts this both ways: every path a `scripts` entry references must
either ship **or** be listed as `repo-only` here. Removing this row without removing the script
entry turns the suite red, so the two cannot drift apart.

---

## Inspect at any time (local, safe, no approval needed)

```sh
bun pm pack --dry-run          # exact file list npm would upload — writes nothing
bun test test/publish-prep.test.ts
bunx tsc --noEmit && bun test  # the same gates release.yml runs
```

`bun pm pack` (no `--dry-run`) writes a local `.tgz` and is also safe — it is gitignored and
touches no registry. **`npm publish` is not safe in any form, `--dry-run` included**: the dry-run
still authenticates against the registry. Use `bun pm pack` / `npm pack` to inspect instead.

---

## The npm sequence (ON HOLD; each step needs its own yes)

1. **Release the version through `docs/RELEASE.md` first.** The bump, the release check, the export,
   the tag and the GitHub Release all happen there; the npm package is published from the same
   version afterwards, never instead. On `main`, clean, CI green; read the `bun pm pack --dry-run`
   list in full.

2. **Flip `private` — maintainer only.** Remove `"private": true` from `package.json`, and update
   `test/publish-prep.test.ts`'s `RELEASE GATE` case in the same commit so the suite states the new
   truth rather than being silenced. Re-run `bun test`.

3. **Publish — the irreversible step, its own explicit yes.**

   ```sh
   npm publish --access public      # ← never run by an agent, never "just to test"
   ```

   Then verify: `npm view daily-briefing version`, and install it somewhere clean
   (`bunx daily-briefing --help`) before telling anyone it is out.

4. **Rollback is deprecation, not deletion.** If a bad version ships, publish a fixed one and
   `npm deprecate daily-briefing@X.Y.Z "<why>"`. Do not reach for `npm unpublish`.

---

## Notes

- **The GitHub Release and the npm package are separate artefacts.** `release.yml` builds and
  attaches the cross-compiled binaries and the desktop bundles; it does **not** publish to npm, and
  nothing in Phase E added that. Whoever adds an npm step to that workflow owns re-checking this
  document.
- **The npm package ships TypeScript source, not a compiled binary.** `bin` runs `src/main.ts`
  under bun — which is why `engines.bun` is a hard requirement and why the tarball is source-only.
  The compiled binaries are the GitHub Release's job.
- **The public *repo* export is a different path with its own scrub gate** —
  `scripts/export-public.sh`, which fails on identity/vault residuals; `docs/RELEASE.md` runs it.
  `test/publish-prep.test.ts` applies that same residual pattern to the npm tarball, because the
  tarball is the other way this repo's content reaches strangers. It **reads** the identity half from
  the script's `HARD='…'` line rather than restating it, since the test ships and the script does not.
  In the exported tree that half is inert: the export's own sweep covered every file at export time,
  which holds only while the public repo changes **by re-export alone** — a commit made directly there
  gets no identity check from this test. The credential and personal-email shapes stay live in both
  trees.
- **The export is exercised on every monorepo `bun test`.** `test/export-public.test.ts` exports into
  a temp directory and requires exit 0, `hard residual sweep: clean` and no `grep:` error on stderr.
  It then runs `test/publish-prep.test.ts` inside the exported tree, where the workflow files sit at
  `.github/workflows/` rather than `publish/.github/workflows/`, and requires it to pass with nothing
  skipped. It is skipped in the exported tree itself. It exports tracked files as they sit in the
  working tree, so a plain `rm` of a tracked file fails it (`tar: … Cannot stat`) until `git rm`.
