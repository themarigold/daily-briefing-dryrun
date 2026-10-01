// test/fixtures/git-flush.ts — a short post-exit flush window for runGit, for FULLY-FAKED held-pipe tests.
//
// runGit races its pipe reads against GIT_FLUSH_MS (500 ms) after git exits. A test whose faked
// `Bun.spawn` returns a stdout that never EOFs pays that whole window on every runGit call it
// provokes, and nothing in the test depends on the length — the fake never closes, so any window
// ends the same way. Shortening it is what makes those tests cheap.
//
// ⚠ Use it ONLY when EVERY spawn in the test is faked. The window is process-global, so it also
// applies to any REAL git the test passes through — and under load the test process's event loop can
// stall past a short window after a healthy child exits, turning it into a false "held pipe".
// Measured 2026-09-24: the mixed tests in extractor.incomplete-read (one command faked, the rest
// real git) flaked 7/220 under a 100 ms window at high load, 0/320 on the default; they keep the
// default. The seam also assumes tests run serially (bun's default here): under `test.concurrent`
// the short window would leak into neighbouring real-git tests.
import { setGitFlushMsForTests } from "../../src/git";

/** Shorten runGit's flush window to 100 ms until `restore()` is called. Pair it with the spy that
 *  fakes EVERY spawn: `const flush = fastGitFlush(); try { … } finally { flush.restore(); spy.mockRestore(); }`. */
export function fastGitFlush(): { restore(): void } {
  setGitFlushMsForTests(100);
  return { restore: () => setGitFlushMsForTests(undefined) };
}
