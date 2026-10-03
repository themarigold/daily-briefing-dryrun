# Flake chase — the 2026-09-01 "transient 6 failures" sighting

**Verdict: REPRODUCED, ATTRIBUTED, and NO CODE CHANGE.** The failures are `bun test`'s **default
5000 ms per-test timeout** tripping on the suite's spawn-heavy tests when the CPU is oversubscribed —
not a product timing window, and not a defect in `src/`. The measurement below is the deliverable;
the timeout is deliberately **not** raised.

> **Scope.** That verdict covers **this sighting**, not the suite. A second, unrelated intermittent —
> non-timeout, reproducible on an idle machine — was found afterwards by a reviewer and fixed in the
> test that owned it; see *Found afterwards, on a QUIET machine* below.

- Machine: 18-core arm64 macOS, 48 GiB, bun 1.3.14, no `bunfig.toml` (so the per-test timeout is
  bun's default 5000 ms; no test in the suite overrides it).
- Tree: the A4 branch at the point of measurement — 1917 tests across 115 files.

---

## The sighting being chased

2026-09-01: six test failures observed under heavy I/O, **unreproducible on three retries** and
**unattributed**. The honest prior going in was that it was environmental and there was nothing to
fix. That prior held, but it is now measured rather than assumed.

## Method — the induction (C1 round-6 pattern)

`scripts/`-external harness (not committed; reproduced verbatim here so the run can be repeated):

- **CPU:** 36 busy-loop spinners = **2× oversubscription** of the 18 cores, so every test process is
  descheduled repeatedly rather than merely slowed.
- **Disk, bulk:** 8 concurrent `dd if=/dev/zero bs=1m count=64 conv=fsync` write-then-unlink loops.
- **Disk, metadata:** 4 loops each creating 400 empty files, `ls -la`-ing the directory, and
  unlinking them — the shape that perturbs `mkdtemp`, `readdir` and the marker/state writes the
  suite performs constantly.
- Load is allowed to land for 5 s, then one full `env -u ANTHROPIC_API_KEY bun test` runs under it.
- Observed 1-minute load average during the runs: **57–82** (baseline ~3.4).

```sh
NCPU=$(sysctl -n hw.ncpu)
for _ in $(seq $((NCPU*2))); do ( while :; do :; done ) & done
for i in $(seq 8); do ( while :; do dd if=/dev/zero of="$CHURN/blob.$i" bs=1m count=64 conv=fsync 2>/dev/null; rm -f "$CHURN/blob.$i"; done ) & done
for i in $(seq 4); do ( d="$CHURN/meta.$i"; mkdir -p "$d"; while :; do for n in $(seq 400); do : > "$d/f$n"; done; ls -la "$d" >/dev/null; rm -f "$d"/f*; done ) & done
sleep 5
env -u ANTHROPIC_API_KEY bun test
```

## Counts — recorded BEFORE anything was changed

| Run | Load | pass | skip | fail | "errors" blocks | wall |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | none | 1916 | 1 | **0** | 0 | 87 s |
| induction 1 | full | 1909 | 1 | **7** | 3 | 343 s |
| induction 2 | full | 1914 | 1 | **2** | 0 | 267 s |
| induction 3 | full | 1911 | 1 | **5** | 4 | 309 s |
| diagnostic | full, `--timeout 30000` | 1916 | 1 | **0** | 0 | 873 s |

**Reproduced 3/3.** The failure COUNT (7 / 2 / 5) and the failing SET both vary run to run, which is
exactly the "six failures, then unreproducible on retry" character of the original sighting.

## Which tests, and the shape they share

10 distinct tests failed across 14 failure events. Two failed in all three runs:

| Test | Runs | Duration |
| --- | --- | --- |
| `transcripts-safety` — T8.1 CALL SITE, sinks 1-3 | 3/3 | 5004–5124 ms |
| `main` — output credential scan … `transcripts.enabled=true` | 3/3 | 5001–5031 ms |
| `transcripts-render` — T7.3 collision over ALL units | 1/3 | 5096 ms |
| `harden.argv` — B7 `--setting-sources` | 1/3 | 5275 ms |
| `git` — listCommits/committerDaysWithCommits, refs/remotes [Tier-5] | 1/3 | 5005 ms |
| `transcripts-wiring` — T4.4 degradation routes | 1/3 | 5000 ms |
| `extractor` — resumptionSignals stash date (§5.2 drift) | 1/3 | 5001 ms |
| `extractor` — gitActivity mergedToday | 1/3 | 5175 ms |
| `eval/mutations` — mutation: file-not-in-diffstat → G2 | 1/3 | 5021 ms |
| `json-envelope` — `--json-out` markdown BYTE-IDENTICAL to stdout | 1/3 | 885 ms |

**13 of the 14 failure events are `this test timed out after 5000ms`, and every one of those
durations sits in 5000–5275 ms** — i.e. pinned to the runner's default, not to any window in `src/`.
All 10 tests spawn real subprocesses (`git`, a fake provider CLI) or drive the full `run()` path.

## Attribution

1. **Primary.** Under 2× CPU oversubscription the whole suite takes 3–4× longer (87 s → 267–343 s).
   Any test whose real work is a few hundred ms of subprocess spawning crosses 5 s and is killed by
   the runner. Which tests cross is scheduler-dependent, hence the varying set.

2. **Collateral — this is why one timeout produces several failures.** A timed-out test leaves
   children behind; bun reaps them (`killed 1 dangling process`) and the kill lands on whatever is
   running next. That surfaces as an `# Unhandled error between tests` block attributed to an
   innocent neighbour, with the tell-tale signature of a killed child rather than a real error:
   `git init -q -b main:` with **empty stderr**, and
   `ProviderError: … was killed (signal SIGTERM)`. Three such blocks in run 1, four in run 3.

3. **The one non-timeout failure is downstream of the same cause.** `json-envelope`'s byte-identity
   assertion compared this test's envelope against a **different test's** briefing text
   (`dba-repo-2mrol1` vs `dba-repo-rxnWwc`) — a timed-out test's async continuation outlived its test
   body and kept writing into the shared stdout capture. It cannot occur without a timeout first.

4. **No product deadline is implicated.** The suite's own windows are `GIT_FLUSH_MS` 500 ms,
   `PROBE_FLUSH_MS` 1 s, `PROBE_MS` 10 s, `GIT_TIMEOUT_MS` / `DEFAULT_TIMEOUT_MS` 30 s, provider
   `TIMEOUT_MS` 120 s. None is near the 5 s that actually fired, and **not one failure was an
   assertion about truncated, missing or partial output** — the shape a real flush-window or
   `raceFlush` regression takes. Nothing was found to bound.

5. **The discriminating measurement.** Same induction, same load average, **only** the runner's
   per-test timeout raised (`bun test --timeout 30000`): **1916 pass / 1 skip / 0 fail**, 873 s.
   Holding the load fixed and moving only the runner deadline flips the whole result, which is what
   separates "the runner's clock" from "the code's clock". That run is a **measurement, not a fix** —
   nothing in the repo was changed for it.

## Verdict and what was deliberately NOT done

- **No code change.** Nothing in `src/` is implicated in **this sighting** — the 2026-09-01
  "transient 6 failures" report, whose entire failure set is accounted for above.
  ⚠ Deliberately narrowed: the first draft read "nothing in `src/` is at fault", full stop, which is a
  claim about the whole suite that this method cannot support. The induction looks for what crosses a
  5 s deadline under load; an intermittent with any other mechanism is invisible to it, and one was
  found on a quiet machine the same day (below).
- **The per-test timeout is NOT raised** — not globally, not per-test, not via a new `bunfig.toml`.
  That is the blanket timeout raise this chase was explicitly forbidden to perform: it would hide the
  next *real* hang behind a 30 s wait, and the failures it suppresses are a property of the machine
  the suite happens to be running on.
- **Read a red suite on a loaded machine accordingly.** If the failures are all
  `timed out after 5000ms` and the durations cluster at 5000–5300 ms, check the load average before
  reaching for `git bisect`. Re-run on a quiet machine; that is the cheap discriminator **for this
  shape only** — a quiet-machine re-run is silent about intermittents that do not involve the clock,
  which is exactly how the one below survived the chase.

## Found afterwards, on a QUIET machine — and FIXED

- **`test/provider.anthropic.test.ts` — "the response body is CAPPED".** Surfaced by a round-2
  reviewer running the full suite twice on an idle machine: 1915/1/**1**, then 1916/1/0. The failure
  was not a timeout (3.58 ms) and did not involve load at all.
- **Reproduced**: that file alone, 30 iterations on an idle machine → **2 failures**, both
  `expect(e?.code).toBe("nonzero-exit")` receiving `undefined` — i.e. nothing threw.
- **Attributed to the TEST, not to `src/`.** The case drove a 200 KB body over a real loopback
  socket against a 4 096-byte injected cap and relied on `fetch` splitting it into several chunks.
  `readCapped` appends a chunk and *then* checks the ceiling (the "cap plus one chunk" bound, which
  is deliberate and documented at the function), so on the runs where the whole body arrived as ONE
  chunk the complete body was read, parsed fine, and the request SUCCEEDED. The fixture was
  asserting a property of TCP delivery it does not control.
- **Fix**: the body is now streamed in explicit fixed-size writes, so the ceiling is crossed
  mid-body by construction; the case additionally asserts the read stopped early rather than merely
  that the parse failed. 30/30 green afterwards (see the commit's receipts).
- **Method note.** This is the lesson of the whole chase: an induction that pressures ONE mechanism
  (the clock) certifies only that mechanism. It swept past a chunk-boundary race in a file it ran
  fourteen times, because that race never crosses a deadline.

## Left open (not this task's to fix)

- **Test isolation after a timeout.** The `json-envelope` cross-talk shows the stdout capture is not
  fenced against a timed-out test's outliving async work, so one timeout can corrupt a *later* test's
  evidence rather than merely failing its own. Harmless today (it needs a timeout to trigger) but it
  makes a loaded-machine failure report harder to read than it should be.
  ⚠ **Corrected 2026-09-19 — it was not harmless.** The same outliving continuation also cleared
  `DAILY_BRIEFING_STATE_DIR` mid-way through the next test: `transcripts-safety.test.ts` runs first and
  saved `undefined` before isolating, its timed-out T8.1 restored that `undefined` while json-envelope
  was mid-`run()`, and json-envelope's briefing (`dba-repo-2mrol1`, the label recorded in item 3 above)
  was written into the developer's LIVE state dir as `briefings/2026-09-15.md` at 14:26 PDT during one
  of these induction runs. The same cleanup also deleted `XDG_CONFIG_HOME`, which exposed the real
  `~/.config/daily-briefing/config.json` the same way; nothing wrote it that time. Closed for both
  variables, in-process: `test/fixtures/isolate-state.ts` is armed from `test/preload.ts` AND imported by
  every state- or config-touching test file (so it holds from any cwd — bunfig's preload loads only from
  the package root), and each variable is a tripwire that cannot be removed. A child spawned WITHOUT an
  `env` option gets the startup environment and is not covered. Mechanism, reproduction and proof in
  `test/fixtures/isolate-state.ts` and `test/state-tripwire.test.ts`.
- **Other non-clock intermittents, if any.** One was found and fixed above; the search that found it
  was a reviewer running the suite twice, not a method. Nothing here establishes that the suite is
  now deterministic — only that the two sightings on record AT THE TIME are accounted for (two more
  have been added below since: the run-lock identity gap and the 2026-09-24 shutdown wait). A cheap standing
  check is to run the full suite twice back to back and compare, which is what this commit's
  receipts do.

## 2026-09-15 — the run-lock release identity gap (CI-only; fixed in `f29b332c3`, pinned here)

Same day, same class as the section above: a non-timeout intermittent that the induction could not
see, found by reading CI rather than by a method. Recorded after the fix landed, because two
independent reviews of a parallel (discarded) hotfix for the same defect found gaps that applied to
the landed version too — the tests and the temp-dir cleanup in this note's PR close them.

- **What CI is.** Exactly **one** job: `check` on `ubuntu-latest`
  (`.github/workflows/daily-briefing-ci.yml`). There is no macOS CI job; the only macOS runs are
  developer laptops. That platform split is the whole story below.
- **The failing assertion.** `test/run-lock.test.ts:236` at the failing revisions — the
  `expect(existsSync(runLockPath())).toBe(true)` in *"release is a NO-OP once the lock has been
  legitimately reclaimed by a successor"*: the overrunning holder's `release()` had deleted the
  successor's lock. Every red run below failed on that one line and nothing else in this file.
- **History on `main`** (the lock landed in the A1 merge `eaa55dc85`, 2026-09-15T02:13Z):

  | run | created (UTC) | commit | result |
  | --- | --- | --- | --- |
  | 34920361181 | 2026-09-15T02:13 | `eaa55dc85` (A1 merge) | **red** |
  | 34926145240 | 03:44 | `3ab5feb43` | green |
  | 35020822748 | 20:37 | `2cc6c6537` | **red** |
  | 35021566439 | 20:45 | `54d0da035` | green |
  | 35024240061 | 21:12 | `c636eb0d2` (A3 merge) | **red** |
  | 35027511576 | 21:46 | `94beef159` | **red** |
  | 35032828244 | 22:49 | `7db9889c4` | **red** |
  | 35037062555 | 23:45 | `de9488cb7` | **red** |
  | 35046753868 | 2026-09-16T02:07 | `f29b332c3` (the nonce fix) | green |

  Intermittent before the A3 merge (2 of 4 runs red), red on **every** run after it until the fix.
  **Why it turned from intermittent to consistent at A3 is unmeasured** — no run captured inode
  numbers or allocator state, and this note deliberately does not supply an allocator story for it.
- **Why the lock's contents never discriminated.** Both holders in that test are the same process,
  so they share a pid; and two acquires in one ISO millisecond share `startedIso`. Measured share of
  acquire pairs landing in the same millisecond: **176/200, 180/200, 172/200** (the reviewers, macOS)
  and **167/200, 170/200, 175/200** re-measured for this note (macOS, bun 1.3.14) — roughly 85-90 %.
  So `{pid, startedIso}` agreed on nearly every run, everywhere.
- **Why the inode did — on macOS only.** The pre-fix `release` compared the inode recorded at acquire
  against the file on disk first. APFS handed back the same inode number on unlink+create in
  **0/200** attempts (three runs of 200), so on every developer laptop the successor's reclaim moved
  the inode and the fast path carried the refusal: the test was green locally without exception.
  **The ext4 side is inference from that platform split, not an observation**: the story that the
  runner's filesystem hands a freed inode straight back to the next create accounts for green-on-APFS
  / red-on-ubuntu, but no run captured inode numbers on the runner, so it remains the leading
  explanation rather than a measured cause.
- **Reproducing the collision on macOS.** Rewriting the lock **in place** (`writeFileSync` opens with
  `O_TRUNC`, which preserves the inode) produces the same three-way collision deterministically
  without depending on any allocator — which is what the landed regression test *"release is a NO-OP
  when the successor's lock REUSES the inode and collides on pid + startedIso"* does.
- **Production exposure: none before the fix, by accident of process shape.** There is one
  `acquireRunLock` call site (`src/main.ts:273`) in a one-shot process (`src/main.ts:1023` exits via
  `process.exit(await dispatch(...))`), so a real successor always has a different pid and the
  pre-fix contents check already refused. The hole was test-harness-only. The per-acquire nonce
  (`f29b332c3`) makes the invariant hold **by construction** for the desktop app that will embed
  `run()` in a long-lived process, where two holders sharing a pid — and, at ~85-90 %, a millisecond —
  stops being a test artefact.
- **What this note's PR adds, and how each addition was checked.**
  - `pid` and `startedIso` are pinned as conjuncts **separately** (in-place overwrite, nonce copied
    verbatim, one field changed). Measured by mutation on a fresh copy: replacing the ownership
    check with a nonce-only comparison left all 22 pre-existing tests in the file green and turned
    exactly these two red.
  - The **unknown-inode branch** (`remember()` failed, so the inode check is skipped and contents
    alone decide) is pinned in both directions: a stranger's nonce is still refused, and the holder's
    own nonce still releases. The seam is `stat` failed for the duration of the acquire only; the
    call count asserts the injected failure was the one `remember()` swallowed. Mutations
    "unknown inode ⇒ refuse" and "unknown inode ⇒ skip the contents check" each turned exactly the
    intended case red.
  - `withEnv`'s cleanup now removes its two `mkdtemp` directories. Measured before: one run of this
    file left **26 `dba-cfg-*` and 26 `dba-state-*`** directories in the OS temp dir (one pair per
    call, the landed inode test's included); after: **0** of either across five runs. The
    `dba-repo-*` directories from the shared `buildRepo` fixture (8 per run of this file, used by
    many files) were left as they were by this chase — a fixture-wide change, not this test's. #482
    then removed them from a run-wide preload `afterAll` (`test/preload.ts`), and the registry that
    followed (`test/fixtures/temp-dirs.ts`, `removeAtRunEnd`) extended that to every temp directory
    the suite leaked, bar the one `dba-isolated-state-*` kept on purpose.

## 2026-09-24 — `fakeApi.stop()` waits on a handler that never answers (fixed, pinned)

A **fourth** sighting and a **third** mechanism this file's induction cannot see: not the runner's
clock under load, not a chunk boundary, but a **shutdown that waits on a promise the test deliberately
never settles**. Recorded here because the induction's own verdict warns that it certifies one
mechanism only.

- **The failure.** `main` at `b7b9f9538`, run 36002014603 in the private development repository,
  attempt 1 — one red test out of **2147** (2145 pass / 1 skip / 1 fail, 127 files):

  ```
  (fail) T6 — buildProvider > ⚠ the api branch HONOURS opts.timeoutMs … [5276.12ms]
    ^ a beforeEach/afterEach hook timed out for this test.
  ```

  Attempt 2 of the same commit was green, as was the commit on its branch.

- **Reading the number.** `5276.12 ms` = a **276 ms body** (T6's two aborts are 150 ms + 120 ms) plus
  bun's **whole 5000 ms hook budget** — a hook timeout is reported as body + 5000, reproduced on a
  scratch probe. So the test did its work correctly and at full speed, and the `afterEach` then hung
  for the entire deadline. Not the loaded-machine shape from the top of this file: nothing is *slow*,
  one thing is *stuck*.

- **⚠ A test's own timeout does not extend its hooks.** Measured on bun 1.3.14: a test declaring
  `}, 15_000)` whose `afterEach` sleeps 6 s still fails at ~5000 ms with this exact message. Hooks get
  a flat 5000 ms. T6 carries `}, 15_000)` and it buys the teardown nothing.

- **The mechanism.** T6 serves `() => new Promise<Response>(() => {})` and relies on the CLIENT
  aborting at 150 ms; the `afterEach` then calls `stop()`. `server.stop(true)` closes idle and active
  connections — that part was already right, and is **not** the gap — but it still waits on a handler
  promise that has not settled. **Counts, not a derived rate** (four hang events across three pre-fix
  arms is too few to quote one), each arm an abort→stop cycle against the real helper:

  | arm | platform | result |
  | --- | --- | --- |
  | pre-fix, 800 cycles | linux, `oven/bun:1.3.14`, `--cpus=2` | **2 hangs**, each ≥12 000 ms |
  | post-fix, 800 cycles | same | **0 hangs**, worst `stop()` 1 ms |
  | pre-fix, 320 cycles | linux, same | **1 hang**, 12 001 ms |
  | pre-fix, 320 cycles | **darwin arm64**, unmutated | **1 hang**, 12 002 ms |
  | post-fix, 320 cycles | darwin arm64 | **0 hangs**, worst `stop()` 1 ms |

  The wait is **unbounded**, not slow: once it fires, nothing ends it. That is why one CI run in many
  goes red and a re-run passes. It reproduces on both platforms without touching the code.

- **Why the file-alone loop is silent.** `bun test test/core.api-provider.test.ts` × 50 is green
  **both before and after**, on darwin and on linux; on the pristine tree a full linux suite run and a
  darwin run under this file's own CPU/disk induction both left T6's teardown at **1 ms**. The race
  needs the abort and the shutdown to land in the same narrow window. The loop is worth running as a
  regression check; it is worthless as a reproduction — the cycle probes above are the measurement.

- **The fix.** `stop()` now releases any still-in-flight handler before `server.stop(true)`, by racing
  every handler against a `null` sentinel the shutdown settles. It removes the wait **by construction,
  for all four callers**, rather than asking each never-answering handler to remember to settle itself
  — the same reasoning that made the lifecycle a harness property in the first place. **T6 is
  unchanged**: the server still never answers while the client waits, so `code === "timeout"`, the
  `150ms` in the message and the under-3 s elapsed bound all still assert exactly what they did.

- **⚠ It releases ANY handler in flight, not only one that would never answer.** `provider.anthropic`
  and `provider.openai-compat` each drive a `slow(2_000)` handler against a 60 ms client timeout, and
  their teardown no longer sits out the remaining sleep: those two files measured **4.41 s → 0.524 s**.
  No client reads the substituted 503 — `server.stop(true)` closes the socket first — but the change
  is wider than "never-answering handlers" and is recorded here rather than left to be discovered.

- **The pin, and the honest reason for its shape.** `test/fakeApi.test.ts` asserts `releasedParked`
  flipped rather than asserting a duration. ⚠ **Not** because a duration assertion would be weak
  today: with `releaseParked()` removed, that test hangs at the 5 s deadline on **every** run, so a
  clock assertion would fail too. (An earlier draft of this section claimed it would pass "on 319 of
  every 320 runs" — that transplanted T6's *incidental* rate onto a test that forces the park by
  construction. Wrong, and caught in review.) The flag earns its place against the **future**: if a
  later bun cancels the handler on client abort, or the request stops landing, nothing is parked,
  `stop()` is trivially fast, and a timing assertion goes green while proving nothing. The flag fails
  instead, because the release it names never fired.

- **What the negative control does and does not prove.** With `releaseParked()` removed the pin fails
  deterministically, at `[10000.01ms]` with `^ a beforeEach/afterEach hook timed out for this test.` —
  CI's message exactly, though not its duration (`5276.12ms`). The 10 s is two stacked 5 s deadlines
  and is worth reading: the body's own
  `await s.stop()` burns the test's 5000 ms, then the `afterEach`'s second `stop()` burns the hook's
  5000 ms, and bun attributes the failure to the hook. ⚠ **That signature is a property of the pin
  being registered with `track()`, not of the defect.** An earlier draft of this test stopped the
  server only in its body; the same mutation then read `[5000.06ms]` / `^ this test timed out after
  5000ms.` — the same 5 s unbounded wait, attributed to the body. Do not read the hook wording as
  independent confirmation of the CI path.
  And in either form the deterministic arm is a control for the **landed** code — it shows the release
  is load-bearing — not a reproduction of the pre-fix defect, whose rate arms are the table above. The
  two regimes differ by two orders of magnitude; the race wrapper appears to keep the handler's
  continuation reachable where the pre-fix per-request promise could be collected, but that mechanism
  is **UNVERIFIED** and only the rates are measured.

- **One alternative, considered and rejected on evidence.** Simply not awaiting `server.stop(true)`
  also removes the hang and leaves the harness's "a later fetch FAILS" test green. Rejected: `stop()`
  would stop meaning "shut down", and the parked handler would outlive it silently.
