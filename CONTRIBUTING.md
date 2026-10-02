# Contributing

Thanks for your interest in `daily-briefing`! This is a small, focused tool — a local, resumption-focused
morning briefing for developers who work with AI coding assistants. Contributions are welcome; this guide
covers how to get set up and what to expect.

## Ground rules

- **Open an issue first for anything non-trivial.** For bugs, a small reproduction helps. For features,
  a quick "here's the problem / here's the shape of the fix" discussion avoids wasted work — the tool has
  a deliberate scope (read local git → generate a resumption briefing), and not every idea fits it.
- **Keep it local-first and provider-agnostic.** The tool reads *local* git history and calls the
  **bring-your-own** AI the user configures. Please don't add telemetry, a hardcoded or bundled AI
  provider, or a new network destination: the README's [Privacy](README.md#privacy) section lists every
  place the tool connects to, and a change that adds one has to add it there and say why in the pull
  request.
- **Keep changes scoped to this tool.** One fix or feature at a time, inside this project's own
  tree.

## How it fits together

- **Stack.** The engine is TypeScript on **Bun**, shipped as a single binary (`bun build --compile`).
  The desktop app in `gui/` is a **Tauri 2** shell (Rust + Svelte) that bundles that same engine as a
  sidecar and talks to it over argv and stdout; [docs/gui-seam.md](docs/gui-seam.md) is the contract
  between the two. The engine stays Bun; only the desktop shell is Rust.
- **The engine's pipeline**, in the order a run goes through it: load and validate the config
  (`src/config.ts`), read git history (`src/extractor.ts`, `src/git.ts`), trim the context to the
  budget (`src/reduce.ts`), build the prompt, call the configured AI provider and parse its reply
  (`src/generator.ts`, with the transports in `src/provider.ts` and `src/providers/`), render the briefing (`src/render.ts`), and record that the day
  is done (`src/marker.ts`). `src/core.ts` runs that sequence and `src/main.ts` is the command line.
- **Self-audit and EVAL tooling** for checking briefing quality is described in
  [docs/AUDIT.md](docs/AUDIT.md).

## Prerequisites

- [Bun](https://bun.sh) **1.3.14+** (CI pins `1.3.14` for reproducibility).
- Git (the tool shells out to it).
- macOS for `scripts/install.sh` (it builds and signs a launchd-scheduled binary); the engine,
  including `schedule install`, is cross-platform.
- **Only for changes under `gui/` (the desktop app):** Rust at the exact version `gui/rust-toolchain.toml`
  pins (`rustup toolchain install <that channel>`, as CI does), and on Linux the Tauri 2 system packages.
  CI installs these on Ubuntu 22.04: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
  libxdo-dev libssl-dev build-essential curl wget file patchelf libfuse2 xdg-utils`; other distributions
  are covered by Tauri's own prerequisites guide. An engine-only change needs none of this.

## Setup

```bash
bun install --frozen-lockfile
bun run start          # run the briefing against your own repos (see README for config)
```

## The gate — run this before every push

The CI workflow, `.github/workflows/ci.yml`, is the authoritative list, and a PR won't merge until every
one of its jobs passes:

- **`check`**, on Ubuntu and on macOS: a frozen-lockfile install (`bun install --frozen-lockfile`, so a
  dependency change must be committed to `bun.lock`), the strict type-check and the full engine suite.
- **`actionlint`**: lints the workflows themselves (and, through shellcheck, every `run:` script in them).
- **`gui`**, on Ubuntu 22.04, in `gui/`: the desktop app's own suite, svelte-check, and the Rust shell's
  `cargo test --locked`, with the one Linux skip the workflow names.
- **`cargo-macos`**, on macOS: the Rust shell's full `cargo test --locked`, nothing skipped.

For an engine change, run the engine's checks locally first:

```bash
bunx tsc --noEmit      # strict type-check (or: bun run typecheck)
bun test               # the full suite (or: bun run test)
```

For a change under `gui/`, also run the desktop app's (with the Rust prerequisites above):

```bash
cd gui
bun install --frozen-lockfile
bash scripts/build-sidecar.sh   # the Rust shell does not compile without the engine sidecar
bun run test                    # the app's suite
bun run check                   # svelte-check
cargo test --locked --manifest-path src-tauri/Cargo.toml --no-fail-fast
```

On anything but an Apple-silicon Mac, one Rust test, the size-budget stale-row test in
`gui/src-tauri/tests/packaging.rs`, re-stats artifacts recorded from an Apple-silicon build (the
`aarch64-apple-darwin` sidecar among them) and fails where they are absent: skip it as CI's Linux job does,
by appending `-- --skip the_recorded_actuals_match_a_re_stat_of_what_exists_here` to the `cargo test`
line. Everything else must be clean.

## Tests

This project is **test-driven** — a change should come with tests, and existing behavior must stay green.

- **Write the failing test first**, then the fix. New tests must be **non-vacuous**: a good check is that
  reverting your source change makes the new test *fail*. (Reviews explicitly look for this.)
- Prefer small, focused test cases over broad end-to-end ones. Use the existing fixtures
  (`test/fixtures/`) and patterns (`buildRepo`, `withEnv`, `captureConsole`, `spyOn(Bun, "spawn")`), and
  register the PATH of every new temp entry created directly under `tmpdir()` with `removeAtRunEnd(...)`
  (`test/fixtures/temp-dirs.ts`) — wrap a `mkdtemp` call in place, or for a fixed-name `mkdir`/file
  `const d = removeAtRunEnd(join(tmpdir(), "x")); mkdirSync(d);` — nested entries go with their parent, and
  registering one the test also removes is a harmless no-op.
- Pure logic belongs in `src/` (unit-testable); CLI orchestration lives in `scripts/`. If you're adding
  logic to a script, factor the testable part into `src/` so it gets coverage.

## Frozen contracts

`src/types.ts` defines `Activity`, `BriefingStruct`, and `ReducedContext`. These are **frozen**: only
**additive, optional** fields may be appended. Never rename, remove, retype, or change the required-ness
of an existing field — downstream consumers depend on the shape. The type-check gate will catch most
violations, but be deliberate here.

## Commits & pull requests

- **Conventional Commits**: `type(dba): summary` — e.g. `feat(dba): …`, `fix(dba): …`, `perf(dba): …`,
  `docs(dba): …`, `test(dba): …`.
- Keep PRs **small and single-purpose** — one fix or feature per PR, with its tests. A focused PR is far
  easier to review and merge than a large mixed one.
- In the PR description, say what changed and how you verified it (which of the checks above you ran,
  and their results).
- Branch off `main`, push your branch, and open the PR against `main`. CI runs automatically.

## Reporting security issues

If you find a security issue (e.g. something that lets a hostile repo's data escape the local boundary),
please do **not** file it publicly. Report it privately through GitHub private vulnerability reporting,
as described in [SECURITY.md](SECURITY.md), which also covers what is in and out of scope.

## Questions

Not sure whether something fits, or how to test it? Open an issue and ask — happy to help.
