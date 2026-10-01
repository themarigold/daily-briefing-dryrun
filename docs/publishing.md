# Publishing to npm — the user-gated release sequence

> ## ⛔ RELEASE-READY-ONLY ⛔
>
> **Nothing in this document is a maintenance task, and no part of it is pre-approved.**
> Every step below that leaves this machine — flipping `private`, pushing a tag, `npm publish`,
> creating a GitHub Release — is **irreversible in the way that matters**: a published version
> cannot be un-published out of anyone's lockfile or cache, and `npm unpublish` is refused after
> 72 hours (and is itself a hostile act against anyone who already depends on it).
>
> **Each public action needs its own explicit "yes" from the maintainer, at the moment it is
> taken.** Approval of the release as a whole is NOT approval of the individual steps. An agent
> reading this file has read a runbook, not a permission: it may prepare, inspect, and report —
> it may not flip `private`, tag, push, or publish.
>
> The repository ships `"private": true` on purpose. `test/publish-prep.test.ts` pins it, so an
> accidental flip turns the suite red. That test is meant to be edited **by a human, deliberately,
> as step 2 of this sequence** — the edit is the gate being read, not an obstacle to route around.

---

## What is already prepared (no action needed)

| Thing | State | Where |
| --- | --- | --- |
| `bin` → `daily-briefing` | wired, and `src/main.ts` carries `#!/usr/bin/env bun` | `package.json`, `src/main.ts:1` |
| `engines.bun` | `>=1.3.14`, pinned equal to the workflows' `bun-version` | `package.json`, `publish/.github/workflows/*.yml` |
| `files` allowlist | present — it cut the tarball by roughly two thirds (it was 208 files / 3.51 MB with no allowlist at all) | `package.json#files` |
| version == tag guard | present, and **verified to fail red** on a mismatch | `publish/.github/workflows/release.yml`, step *Version must match tag* |
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

## The sequence (each step needs its own yes)

1. **Confirm the tree is release-ready.** On `main`, clean, CI green.
   `bunx tsc --noEmit && bun test` locally; read the `bun pm pack --dry-run` list in full.

2. **Flip `private` — maintainer only.** Remove `"private": true` from `package.json`, and update
   `test/publish-prep.test.ts`'s `RELEASE GATE` case in the same commit so the suite states the new
   truth rather than being silenced. Re-run `bun test`.

3. **Bump the version.** `package.json#version` only — bare semver, no leading `v`
   (`npm version <x.y.z> --no-git-tag-version` does this, or edit it by hand). Commit.

3a. **Re-export into the public repo — the tag goes on an exported tree.** Steps 1–3 happen in the
   monorepo, which stays the source of truth; the public repo is updated by re-export per release
   (ruled 2026-08-29). From the monorepo run `bash scripts/export-public.sh <fresh-dir>`, which must
   print `hard residual sweep: clean`, and run the gates inside the export
   (`bun install --frozen-lockfile && bunx tsc --noEmit && bun test`). Then, in the public repo
   checkout, sync that tree in and commit it — exactly this way:

   ```sh
   rsync -a --checksum --delete --exclude=.git --exclude=node_modules <export>/ ./
   git add -A && git commit -m "Release X.Y.Z"
   ```

   `--checksum`, because the export's `tar` keeps the monorepo's mtimes and rsync's default quick
   check skips a file whose size and mtime already match, leaving the old content in place.
   `--delete`, so a file gone from the export goes from the public repo too. The two excludes keep the
   public repo's `.git` and leave out the `node_modules` the gates just installed in the export.
   `git add -A`, not `git commit -a`, which stages only files git already tracks and so leaves a file
   new in this export out of the commit. **Then check that the commit's tree is the export**, before
   recording anything:

   ```sh
   T=$(mktemp -d) && git archive HEAD | tar -x -C "$T"
   diff -r --exclude=node_modules <export> "$T"   # must print nothing
   ```

   This reads the commit, not the working tree. A `diff` against `.` passes over a file that rsync
   copied in but the commit left out, whether through `commit -a` or because `.gitignore` ignores it.
   If it prints anything, stop, fix the sync, commit again and re-run the check. **Record the full
   sha** once the check prints nothing: `git rev-parse HEAD`, before any push. That commit's tree is
   the export and nothing else, and the check just showed it. Then push — a public action, its own
   yes — and **confirm the push published exactly that sha**: `git ls-remote origin refs/heads/main`
   must print it. (The push's own output will not do: its `old..new  main -> main` line gives only a
   short form, and a first push prints `[new branch]` and no sha at all.) Step 4 tags that sha and
   nothing else. Steps 4–6 run in the public repo, where `release.yml` lives.
   **If the push is rejected** (`! [rejected] main -> main (fetch first)`: someone pushed to public
   `main` since your last fetch), **do not follow git's hint to `git pull`**, and do not merge or
   rebase in any form: the result is a commit whose tree the export sweep never saw, and a sha
   recorded *after* it would pass every later check — tag, `rev-parse`, `[new tag]`. Instead carry the
   contributor's change back to the monorepo (the rule just below), re-run the export, rebuild the
   commit on the fetched branch without merging (`git fetch origin && git checkout -B main
   origin/main`, then sync, commit and check the tree exactly as above), record the new sha, and
   push again. If `ls-remote` ever prints anything but the recorded sha, stop: nothing gets tagged.
   **Never tag a commit made directly in the public repo:** that tree's `test/publish-prep.test.ts`
   has no identity check (the pattern lives in the export script, which does not ship), so the export
   sweep is the only identity gate. A change merged there (e.g. a contributor PR) must be carried
   back to the monorepo first, or the next re-export reverts it.

4. **Tag it, matching exactly — the commit step 3a pushed, named by its sha.** In the public repo
   checkout: `git tag vX.Y.Z <sha>`, where `<sha>` is the one 3a recorded. The tag is the version
   with a `v` prefix and nothing else. **Name the sha:** a bare `git tag vX.Y.Z` tags whatever HEAD
   is by now. Checking `HEAD == origin/main` after a fetch does not stand in for it. A commit that
   reached the public branch some other way (a contributor PR merged there) and was then pulled
   passes that check. Tagging it releases a tree the export sweep never saw, which is exactly what
   3a's *never tag a commit made directly in the public repo* forbids. Before pushing,
   `git rev-parse 'vX.Y.Z^{commit}'` must print 3a's sha.
   Then push **that tag by name**: `git push --no-follow-tags origin vX.Y.Z` (`origin` being the public
   repo), and check the output has a `[new tag]` line for `vX.Y.Z`. **Not `git push --follow-tags`:** it
   carries only *annotated* tags, so the lightweight tag `git tag vX.Y.Z <sha>` makes is silently left
   behind — exit 0, just `Everything up-to-date`, because step 3a already pushed the branch — and
   `release.yml` never fires. It also sweeps up every other annotated tag reachable from the branch
   that the remote lacks. A named refspec works for either tag type. It fails loudly if the name
   matches no local ref (`src refspec vX.Y.Z does not match any`), or more than one (a branch and a
   tag of that name: `matches more than one`). It does **not** fail when the only match is a
   *branch* named `vX.Y.Z`. That pushes as `[new branch]` and exits 0, and `release.yml` never fires,
   which is why the check is the `[new tag]` line and not the exit code. `--no-follow-tags` keeps the
   push to that one tag even when `push.followTags` is set in git config. Measured in a throwaway bare
   repo: the tag types 2026-09-21; the pulled contributor commit, the branch and ambiguity cases, and
   the rejected-push-then-pull case (merge and rebase both publish a tree that is not the export;
   `ls-remote` then differs from the commit-time sha) 2026-09-22, and 3a's sync on the same day
   (with `commit -a`, and with plain `rsync -a` on a same-size, same-mtime file, a commit whose tree
   is not the export is pushed, and `ls-remote` still matches; the tree check prints the difference
   in both cases, and the commands above leave it with nothing to print).

5. **The guard runs.** `release.yml` fires on `v*` and, after install + typecheck + tests, compares
   `package.json#version` against `${GITHUB_REF_NAME#v}` and **fails the release** on a mismatch
   before any binary is built or uploaded. Verified red 2026-09-15 against two mismatch shapes
   (right version / wrong tag, and wrong version / right tag) on a disposable copy.

6. **Publish — the irreversible step, its own explicit yes.**

   ```sh
   npm publish --access public      # ← never run by an agent, never "just to test"
   ```

   Then verify: `npm view daily-briefing version`, and install it somewhere clean
   (`bunx daily-briefing --help`) before telling anyone it is out.

7. **Rollback is deprecation, not deletion.** If a bad version ships, publish a fixed one and
   `npm deprecate daily-briefing@X.Y.Z "<why>"`. Do not reach for `npm unpublish`.

---

## Notes

- **The GitHub Release and the npm package are separate artefacts.** `release.yml` builds and
  attaches the cross-compiled binaries; it does **not** publish to npm, and this task did not add
  that (workflow files are owned elsewhere). Whoever adds an npm step to that workflow owns
  re-checking this document.
- **The npm package ships TypeScript source, not a compiled binary.** `bin` runs `src/main.ts`
  under bun — which is why `engines.bun` is a hard requirement and why the tarball is source-only.
  The compiled binaries are the GitHub Release's job.
- **The public *repo* export is a different path with its own scrub gate** —
  `scripts/export-public.sh`, which fails on identity/vault residuals. `test/publish-prep.test.ts`
  applies that same residual pattern to the npm tarball, because the tarball is the other way this
  repo's content reaches strangers. It **reads** the identity half from the script's `HARD='…'` line
  rather than restating it, since the test ships and the script does not. In the exported tree that
  half is inert: the export's own sweep covered every file at export time, which holds only while the
  public repo changes **by re-export alone** — a commit made directly there gets no identity check
  from this test. The credential and personal-email shapes stay live in both trees.
- **The export is exercised on every monorepo `bun test`.** `test/export-public.test.ts` exports into
  a temp directory and requires exit 0, `hard residual sweep: clean` and no `grep:` error on stderr.
  It then runs `test/publish-prep.test.ts` inside the exported tree, where the workflow files sit at
  `.github/workflows/` rather than `publish/.github/workflows/`, and requires it to pass with nothing
  skipped. It is skipped in the exported tree itself. It exports tracked files as they sit in the
  working tree, so a plain `rm` of a tracked file fails it (`tar: … Cannot stat`) until `git rm`.
