// src/repos/hgit.ts — the live git check's spawn helper (B1-M1-T2, wave-2 plan).
//
// A SECOND spawn helper beside `runGit` (src/git.ts), over the same stream.ts primitives (`drain`,
// `raceFlush`, `sinkText`), because `runGit` throws on every non-zero exit and the live check reads exit
// codes as answers: `merge-tree` exit 1 is a conflict, `config --get-regexp` exit 1 is "no match",
// `rev-parse --verify --quiet` exit 1 is "absent". It copies none of `runGit`'s policy: it never throws
// on an exit code, and every caller decides what a result means.
//
// ⚠ Every call names the repo with `-C <repo>` and puts the caller's `lead` (the hardening, harden.ts)
// before the command. Callers follow one argv rule (plan B1-M1-T2, "Argv safety"): every revision is a
// full ref name (`refs/heads/-n`) or a 40-hex object name, never a short name and never a name from the
// page, and the revisions come after `--end-of-options` (an exclusion is `^<full ref>`, since git refuses
// `--not` after `--end-of-options`).
import { writeFile } from "node:fs/promises";
import { cleanGitEnv } from "./env";
import { drain, raceFlush, sinkText } from "../stream";
import { GIT_FLUSH_MS, GitTimeoutError, type GitBudget } from "../git";

/** The default stdout cap, 1 MiB. Commit and ref listings pass `LISTING_MAX_BYTES`. */
export const HGIT_MAX_BYTES = 1024 * 1024;
/** The cap for every `rev-list`, the "(#N)" and hidden-subjects `log` listings and every `for-each-ref`:
 *  16 MiB, about 400 000 lines of a 41-byte SHA, so a long but legitimate listing is never cut. No
 *  `--max-count` is added anywhere: a cut listing would answer WRONGLY, where a capped one answers
 *  `unknown`. */
export { LISTING_MAX_BYTES } from "../git";
/** stderr is read only to classify "dubious ownership"; this bounds what is kept of it. */
const STDERR_MAX_BYTES = 64 * 1024;

export type HgitOpts = {
  /** Global options and `-c` pairs put before `args` (the hardening). */
  lead: readonly string[];
  /** Bun's per-call timeout (ms, an integer ≥ 1: a budget's `callTimeoutMs()`); SIGKILL when it passes. */
  timeoutMs: number;
  /** Added after inherited GIT_* and SSH_ASKPASS variables are removed (squash check object dirs). */
  env?: Record<string, string>;
  /** stdin from this file; none otherwise. */
  stdinPath?: string;
  /** stdout written to this file only after a complete read within `maxBytes` (raw bytes). */
  stdoutPath?: string;
  /** The stdout cap; default `HGIT_MAX_BYTES`. A call whose stdout passes it is killed at once and
   *  answers `complete: false`. */
  maxBytes?: number;
};

export type HgitResult = {
  /** git's exit code; `null` when it died by a signal (a timeout, the cap's kill) or never started. */
  code: number | null;
  /** stdout, decoded once ("" for a spooled call). Meaningful only when `complete`. */
  out: string;
  /** Killed by its timeout (Bun's SIGKILL), not by the cap. */
  timedOut: boolean;
  /** stdout was read to EOF within the cap, including spooled calls. */
  complete: boolean;
  /** git refused the repo for "dubious ownership" (`safe.directory`); read from stderr, which is
   *  never returned. */
  dubious: boolean;
};

/** Run `git [-C repo] ...lead ...args`. `repo` null runs no `-C` (the version probes). Never throws: a
 *  git that cannot be spawned at all answers `{ code: null, complete: false }`. */
export async function hgit(repo: string | null, args: readonly string[], opts: HgitOpts): Promise<HgitResult> {
  const argv = ["git", ...(repo === null ? [] : ["-C", repo]), ...opts.lead, ...args];
  const env = cleanGitEnv();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      env: { ...env, ...opts.env, LC_ALL: "C", LANGUAGE: "C" },
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
      stdin: opts.stdinPath ? Bun.file(opts.stdinPath) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { code: null, out: "", timedOut: false, complete: false, dubious: false };
  }
  const spooled = opts.stdoutPath !== undefined;
  const maxBytes = opts.maxBytes ?? HGIT_MAX_BYTES;
  let bytes = 0;
  // A spool retains at most the cap plus one sentinel byte. Kill as soon as that byte arrives;
  // never let a child fill a file while waiting for it to exit.
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const o = drain(spooled ? stdout.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const keep = Math.min(chunk.byteLength, maxBytes + 1 - bytes);
      if (keep > 0) { controller.enqueue(chunk.slice(0, keep)); bytes += keep; }
    },
  })) : stdout, { maxBytes });
  // Keep reading after the retention cap: abandoning stderr lets Bun buffer everything the child
  // writes. Copy the retained prefix so a small slice cannot keep a large backing buffer alive.
  let stderrBytes = 0;
  const e = drain((proc.stderr as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const keep = Math.min(chunk.byteLength, STDERR_MAX_BYTES - stderrBytes);
      if (keep > 0) { controller.enqueue(chunk.slice(0, keep)); stderrBytes += keep; }
    },
  })));
  // KILL AT THE CAP, AT ONCE. `drain` stops reading when it sets `truncated` but does not cancel the
  // stream (its `abandon` is separate), so a git still writing would sit blocked on the full pipe until
  // its timeout's SIGKILL. `done` resolves as soon as the read loop breaks. Kill BEFORE abandoning:
  // abandoning closes the pipe, and a child that ignores SIGPIPE (as on CI's Linux runner) would then
  // exit on its own with EPIPE before the kill, so a capped call could report that exit code instead.
  let capped = false;
  void o.done.then(() => {
    if (o.sink.truncated) {
      capped = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      o.abandon();
    }
  });
  await proc.exited;
  await raceFlush(o, e, GIT_FLUSH_MS);
  const err = sinkText(e.sink);
  const code = proc.exitCode;
  const timedOut = !capped && code === null && proc.signalCode === "SIGKILL";
  let complete = !capped && o.sink.complete;
  if (complete && opts.stdoutPath !== undefined) {
    try { await writeFile(opts.stdoutPath, Buffer.concat(o.sink.chunks)); } catch { complete = false; }
  }
  return {
    code,
    out: complete && !spooled ? sinkText(o.sink) : "",
    timedOut,
    complete,
    dubious: code !== 0 && /detected dubious ownership/.test(err),
  };
}

const SHA40 = /^[0-9a-f]{40}$/;

/** One resolution's three outcomes (plan B1-M1-T2, "Resolving a revision"): exactly one 40-hex line and
 *  exit 0 is the answer; exit 1 with empty output is ABSENT, the caller's own answer and never a failure;
 *  any other output or exit is `unknown` for the repo. */
export type Resolved = { sha: string } | { absent: true } | { unknown: "timeout" | "error" };

function resolved(r: HgitResult): Resolved {
  if (r.timedOut) return { unknown: "timeout" };
  if (!r.complete) return { unknown: "error" };
  const lines = r.out.split("\n").filter((l) => l !== "");
  if (r.code === 0 && lines.length === 1 && SHA40.test(lines[0]!)) return { sha: lines[0]! };
  if (r.code === 1 && r.out.trim() === "") return { absent: true };
  return { unknown: "error" };
}

/** `rev-parse --verify --quiet --end-of-options <rev>^{commit}`: `rev` is a FULL ref name or a 40-hex
 *  object name (a bare `rev-parse --end-of-options` prints the option itself as a line, so `--verify` is
 *  what makes the output the SHA alone; measured, git 2.50.1). */
export async function resolveCommit(repo: string, lead: readonly string[], timeoutMs: number, rev: string): Promise<Resolved> {
  return resolved(await hgit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { lead, timeoutMs }));
}

/** `merge-base --end-of-options <a> <b> [<more>…]`, each a full ref name or a 40-hex object name. With more
 *  than two, git's own rule: the best common ancestor of `a` and a hypothetical merge of the rest (the
 *  default ref is a UNION, never a precedence). Exit 1 with no output (no common ancestor) is absent. */
export async function mergeBase(repo: string, lead: readonly string[], timeoutMs: number, a: string, b: string, ...more: string[]): Promise<Resolved> {
  return resolved(await hgit(repo, ["merge-base", "--end-of-options", a, b, ...more], { lead, timeoutMs }));
}

/** `rev-parse --verify --quiet --end-of-options <rev>`, where `rev` carries its own peel (`<sha>^{tree}`). */
export async function resolveRev(repo: string, lead: readonly string[], timeoutMs: number, rev: string): Promise<Resolved> {
  return resolved(await hgit(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", rev], { lead, timeoutMs }));
}

// ── one repo's calls, under its budget (B1-M2) ─────────────────────────────────────────────────────────

/** One hardened repo: its path, `hardenArgs`' lead, and the repo's own budget slice. Every B1-M2 call
 *  in a repo goes through `gitIn` (or `src/git.ts`'s shared functions with `{ lead }`). */
export type RepoGit = { repo: string; lead: readonly string[]; budget: GitBudget };

/** The repo cannot be answered: a call could not start for lack of budget or was killed by its timeout
 *  (`timeout`), or its output was cut, unreadable or not what git prints (`error`). Thrown by a repo's
 *  calls and caught once, where the repo is answered: that repo alone answers `unknown`. */
export class RepoUnknown extends Error {
  constructor(readonly reason: "timeout" | "error", detail = "") { super(`repo unknown (${reason})${detail ? `: ${detail}` : ""}`); }
}

/** `hgit` in one repo, started only when the budget allows. A call that cannot start, times out, or
 *  passes its cap throws `RepoUnknown`; any exit code is returned for the caller to read. */
export async function gitIn(rg: RepoGit, args: readonly string[], opts: Omit<HgitOpts, "lead" | "timeoutMs"> = {}): Promise<HgitResult> {
  const timeoutMs = rg.budget.callTimeoutMs();
  if (timeoutMs === undefined) throw new RepoUnknown("timeout", "no budget left");
  const r = await hgit(rg.repo, args, { ...opts, lead: rg.lead, timeoutMs });
  if (r.timedOut) throw new RepoUnknown("timeout", args[0] ?? "");
  if (!r.complete) throw new RepoUnknown("error", `${args[0] ?? ""}: incomplete`);
  return r;
}

/** `gitIn` whose only answer is exit 0: its stdout. Any other exit throws `RepoUnknown("error")`. */
export async function gitOut(rg: RepoGit, args: readonly string[], opts: Omit<HgitOpts, "lead" | "timeoutMs"> = {}): Promise<string> {
  const r = await gitIn(rg, args, opts);
  if (r.code !== 0) throw new RepoUnknown("error", `${args[0] ?? ""}: exit ${r.code}`);
  return r.out;
}

/** A resolution in `rg` under its budget: the SHA, `null` when absent, `RepoUnknown` otherwise. */
export async function resolveIn(rg: RepoGit, rev: string): Promise<string | null> {
  const t = rg.budget.callTimeoutMs();
  if (t === undefined) throw new RepoUnknown("timeout", "no budget left");
  const r = await resolveRev(rg.repo, rg.lead, t, rev);
  if ("sha" in r) return r.sha;
  if ("absent" in r) return null;
  throw new RepoUnknown(r.unknown, `rev-parse ${rev}`);
}

/** Run one of `src/git.ts`'s shared functions for this repo: its throws become `RepoUnknown` (a kill by
 *  its timeout is `timeout`; every other throw, `error`), so they answer the repo, never the call. */
export async function sharedIn<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if (e instanceof RepoUnknown) throw e;
    throw new RepoUnknown(e instanceof GitTimeoutError ? "timeout" : "error", e instanceof Error ? e.message.slice(0, 200) : "");
  }
}
