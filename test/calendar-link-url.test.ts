// test/calendar-link-url.test.ts — the link-URL credential ladder (v0.3.0 plan M1; spec r4 §2).
//
// Every rung and every refusal path, against temp state folders only (never the real state directory: the
// ladder takes `stateDir` with no default), with the command rung driven through an injected runner — the
// 5 s ceiling is asserted as the value handed to the runner, never waited out. A short real-child block
// proves the default runner's success, failure and kill paths.
//
// ⚠ THE SENTINEL SWEEP AT THE END IS THE POINT OF THIS FILE (the `test/apiKey.test.ts` rule): a URL-shaped
// sentinel goes in through every rung, and every byte that comes back out other than an `ok` outcome's `url`
// — the other outcome fields, the resolver's warnings, anything written to the console — is searched for it.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { chmodSync, constants, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import {
  LINK_URL_COMMAND_MAX_OUT_BYTES, LINK_URL_COMMAND_MAX_ERR_BYTES, LINK_URL_COMMAND_TIMEOUT_MS, LINK_URL_MAX_BYTES, calendarLinkFilePath, calendarLinksDir, resolveLinkUrl,
  type LinkUrlFailedReason, type LinkUrlFrom, type LinkUrlMissingReason, type LinkUrlOutcome, type LinkUrlRefusedReason,
} from "../src/calendar/link-url";
import { resolveCalendar } from "../src/calendar/config";
import type { RunOpts, RunResult } from "../src/proc";

guardNetworkForThisFile();

/** A secret-link-shaped value, and the distinctive part of it a partial leak would still carry. */
const SENTINEL_URL = "https://calendar.google.com/calendar/ical/me%40example.com/private-ZZSENTINELcafe0000/basic.ics";
const TOKEN = "ZZSENTINELcafe0000";

const fileLink = (id = "work") => ({ id, urlFrom: "file" as const });
const envLink = (urlEnv = "WORK_CAL_URL") => ({ id: "work", urlFrom: "env" as const, urlEnv });
const cmdLink = (urlCommand: string[] = ["pass", "show", "cal/work"]) => ({ id: "work", urlFrom: "command" as const, urlCommand });

/** A temp state folder with `calendar/links/` at `dirMode` and, unless `content` is undefined, `<id>.url`
 *  holding `content` at `fileMode`. Modes are set by chmod, after creation, so the umask cannot soften them. */
function state(o: { content?: string; dirMode?: number; fileMode?: number; id?: string } = {}): { state: string; dir: string; file: string } {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cal-link-")));
  const dir = calendarLinksDir(root);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, o.dirMode ?? 0o700);
  const file = calendarLinkFilePath(root, o.id ?? "work");
  if (o.content !== undefined) {
    writeFileSync(file, o.content);
    chmodSync(file, o.fileMode ?? 0o600);
  }
  return { state: root, dir, file };
}

const fakeRun = (r: Partial<RunResult>, seen?: { argv?: string[]; opts?: RunOpts }) =>
  async (argv: string[], opts?: RunOpts): Promise<RunResult> => {
    if (seen) { seen.argv = argv; seen.opts = opts; }
    return { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false, ...r };
  };

// Typed, so a misspelt reason in an expectation is a compile error rather than a test that cannot pass.
const refused = (from: LinkUrlFrom, reason: LinkUrlRefusedReason): LinkUrlOutcome => ({ status: "refused", from, reason });
const missing = (from: LinkUrlFrom, reason: LinkUrlMissingReason): LinkUrlOutcome => ({ status: "missing", from, reason });
const failed = (from: LinkUrlFrom, reason: LinkUrlFailedReason): LinkUrlOutcome => ({ status: "failed", from, reason });

// ── the managed file ───────────────────────────────────────────────────────────────────────────────

describe("rung: the managed file <state>/calendar/links/<id>.url", () => {
  test("a 0600 file in a 0700 folder resolves; surrounding whitespace is trimmed", async () => {
    const s = state({ content: `\n  ${SENTINEL_URL}\n` });
    expect(s.file).toBe(join(s.state, "calendar", "links", "work.url"));
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual({ status: "ok", from: "file", url: SENTINEL_URL });
  });

  test("stricter modes are fine: a 0400 file in a 0500 folder resolves", async () => {
    const s = state({ content: SENTINEL_URL, fileMode: 0o400 });
    chmodSync(s.dir, 0o500);
    expect((await resolveLinkUrl(fileLink(), { stateDir: s.state })).status).toBe("ok");
  });

  test("missing: no folder at all, and a folder without the file", async () => {
    const bare = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cal-link-")));
    expect(await resolveLinkUrl(fileLink(), { stateDir: bare })).toEqual(missing("file", "file-missing"));
    const s = state();
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(missing("file", "file-missing"));
  });

  test("an empty or whitespace-only file is missing, not an empty URL", async () => {
    for (const content of ["", "\n  \n"]) {
      const s = state({ content });
      expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(missing("file", "file-empty"));
    }
  });

  test("a symlinked FILE is refused, even pointing at a perfectly private file", async () => {
    const s = state();
    const target = join(s.state, "elsewhere.url");
    writeFileSync(target, SENTINEL_URL);
    chmodSync(target, 0o600);
    symlinkSync(target, s.file);
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(refused("file", "file-symlink"));
  });

  test("a symlinked FOLDER is refused, even pointing at a perfectly private folder", async () => {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cal-link-")));
    const real = join(root, "real-links");
    mkdirSync(real);
    chmodSync(real, 0o700);
    writeFileSync(join(real, "work.url"), SENTINEL_URL);
    chmodSync(join(real, "work.url"), 0o600);
    mkdirSync(join(root, "calendar"));
    symlinkSync(real, calendarLinksDir(root));
    expect(await resolveLinkUrl(fileLink(), { stateDir: root })).toEqual(refused("file", "dir-symlink"));
  });

  for (const mode of [0o644, 0o640, 0o604, 0o620, 0o602, 0o610, 0o601]) {
    test(`a file at mode ${mode.toString(8)} is refused (any group or other bit, write included)`, async () => {
      const s = state({ content: SENTINEL_URL, fileMode: mode });
      expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(refused("file", "file-permissions"));
    });
  }

  for (const mode of [0o755, 0o750, 0o711, 0o701, 0o770, 0o707]) {
    test(`a folder at mode ${mode.toString(8)} is refused`, async () => {
      const s = state({ content: SENTINEL_URL, dirMode: mode });
      expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(refused("file", "dir-permissions"));
    });
  }

  test("a folder that is not a folder is refused", async () => {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cal-link-")));
    mkdirSync(join(root, "calendar"));
    writeFileSync(calendarLinksDir(root), SENTINEL_URL);
    chmodSync(calendarLinksDir(root), 0o600);
    expect(await resolveLinkUrl(fileLink(), { stateDir: root })).toEqual(refused("file", "dir-not-directory"));
  });

  test("a file that is not a regular file is refused", async () => {
    const s = state();
    mkdirSync(s.file);
    chmodSync(s.file, 0o700);
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(refused("file", "file-not-regular"));
  });

  test("the wrong owner is refused — folder, then file (owner check injected: a test cannot chown)", async () => {
    const s = state({ content: SENTINEL_URL });
    const seen: string[] = [];
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state, ownerCheck: (_st, which) => { seen.push(which); return false; } }))
      .toEqual(refused("file", "dir-owner"));
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state, ownerCheck: (_st, which) => which === "dir" }))
      .toEqual(refused("file", "file-owner"));
    // The injected check is handed the real stat, and the default (this process's uid) accepts our own files.
    let uidSeen: number | undefined;
    await resolveLinkUrl(fileLink(), { stateDir: s.state, ownerCheck: (st) => { uidSeen = st.uid; return true; } });
    expect(uidSeen).toBe(process.getuid!());
    expect(seen).toEqual(["dir"]);
  });

  test("a file with a second hard link is refused", async () => {
    const s = state({ content: SENTINEL_URL });
    linkSync(s.file, join(s.dir, "other.url"));
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state })).toEqual(refused("file", "file-hardlinked"));
  });

  test(`a file over ${LINK_URL_MAX_BYTES} bytes is refused unread; exactly ${LINK_URL_MAX_BYTES} is accepted`, async () => {
    const big = state({ content: "a".repeat(LINK_URL_MAX_BYTES + 1) });
    expect(await resolveLinkUrl(fileLink(), { stateDir: big.state })).toEqual(refused("file", "too-long"));
    const edge = state({ content: "a".repeat(LINK_URL_MAX_BYTES) });
    expect((await resolveLinkUrl(fileLink(), { stateDir: edge.state })).status).toBe("ok");
  });

  test("the open that decides passes O_NOFOLLOW and O_NONBLOCK, read-only (open injected: the race they guard cannot be staged)", async () => {
    // M1 checkpoint LOW: dropping O_NOFOLLOW left the whole file green, because a symlink swapped in between
    // the lstat and the open is a race no test can reproduce. So the FLAGS are pinned, at the one open call.
    const s = state({ content: SENTINEL_URL });
    const seen: { path: string; flags: number }[] = [];
    const r = await resolveLinkUrl(fileLink(), {
      stateDir: s.state,
      open: (path, flags) => { seen.push({ path, flags }); return open(path, flags); },
    });
    expect(r).toEqual({ status: "ok", from: "file", url: SENTINEL_URL });
    expect(seen.map((o) => o.path)).toEqual([s.file]);
    const flags = seen[0]!.flags;
    expect(`O_NOFOLLOW set: ${(flags & constants.O_NOFOLLOW) === constants.O_NOFOLLOW}`).toBe("O_NOFOLLOW set: true");
    expect(`O_NONBLOCK set: ${(flags & constants.O_NONBLOCK) === constants.O_NONBLOCK}`).toBe("O_NONBLOCK set: true");
    // Read-only: no write or create bit can ride along (O_RDONLY is 0, so it is the absence of the others).
    expect(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)).toBe(0);
  });

  test("the race's two outcomes, as the open reports them: ELOOP is file-symlink, ENOENT is file-missing", async () => {
    const s = state({ content: SENTINEL_URL });
    const raising = (code: string) => async (): Promise<never> => { throw Object.assign(new Error(`${code} ${SENTINEL_URL}`), { code }); };
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state, open: raising("ELOOP") })).toEqual(refused("file", "file-symlink"));
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state, open: raising("ENOENT") })).toEqual(missing("file", "file-missing"));
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state, open: raising("EACCES") })).toEqual(failed("file", "read-error"));
  });

  test("Windows: the managed file is refused outright (no O_NOFOLLOW, no POSIX modes to check)", async () => {
    const s = state({ content: SENTINEL_URL });
    expect(await resolveLinkUrl(fileLink(), { stateDir: s.state, platform: "win32" })).toEqual(refused("file", "unsupported-platform"));
  });

  test("an id outside the grammar never reaches a file name, and the ladder still does not throw", async () => {
    const s = state({ content: SENTINEL_URL });
    expect(() => calendarLinkFilePath(s.state, "../work")).toThrow();
    expect(await resolveLinkUrl(fileLink("../work"), { stateDir: s.state })).toEqual(failed("file", "read-error"));
  });

  test("an id that only NORMALIZES into the grammar (`x/../work`) is still outside it: read-error, never the file", async () => {
    // P1-M1 checkpoint MED: `join` folds `links/x/../work.url` to `links/work.url`, a real, valid managed file.
    const s = state({ content: SENTINEL_URL });
    expect(() => calendarLinkFilePath(s.state, "x/../work")).toThrow();
    expect(await resolveLinkUrl(fileLink("x/../work"), { stateDir: s.state })).toEqual(failed("file", "read-error"));
  });
});

// ── urlEnv ─────────────────────────────────────────────────────────────────────────────────────────

describe("rung: urlEnv", () => {
  test("a set variable resolves, trimmed", async () => {
    expect(await resolveLinkUrl(envLink(), { stateDir: "/nonexistent", env: { WORK_CAL_URL: ` ${SENTINEL_URL}\n` } }))
      .toEqual({ status: "ok", from: "env", url: SENTINEL_URL });
  });

  test("unset, empty and whitespace-only are all missing", async () => {
    for (const env of [{}, { WORK_CAL_URL: "" }, { WORK_CAL_URL: "  \n" }]) {
      expect(await resolveLinkUrl(envLink(), { stateDir: "/nonexistent", env })).toEqual(missing("env", "env-unset"));
    }
  });

  test("ONLY the configured rung is tried: an unset variable never falls back to a valid managed file", async () => {
    const s = state({ content: SENTINEL_URL });
    expect(await resolveLinkUrl(envLink(), { stateDir: s.state, env: {} })).toEqual(missing("env", "env-unset"));
  });

  test("an over-long value is refused", async () => {
    expect(await resolveLinkUrl(envLink(), { stateDir: "/nonexistent", env: { WORK_CAL_URL: "a".repeat(LINK_URL_MAX_BYTES + 1) } }))
      .toEqual(refused("env", "too-long"));
  });
});

// ── urlCommand (injected runner) ───────────────────────────────────────────────────────────────────

describe("rung: urlCommand, through an injected runner", () => {
  test("success: the FIRST line of stdout is the URL; the argv, the 5 s ceiling and the flush are handed to the runner", async () => {
    const seen: { argv?: string[]; opts?: RunOpts } = {};
    const exec = fakeRun({ out: `${SENTINEL_URL}\nlogin: me@example.com\nurl: ${SENTINEL_URL}\n`, err: `stderr names ${SENTINEL_URL}` }, seen);
    expect(await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec })).toEqual({ status: "ok", from: "command", url: SENTINEL_URL });
    expect(seen.argv).toEqual(["pass", "show", "cal/work"]);
    expect(seen.opts).toEqual({ timeoutMs: LINK_URL_COMMAND_TIMEOUT_MS, flushMs: 500, maxOutBytes: LINK_URL_COMMAND_MAX_OUT_BYTES, maxErrBytes: LINK_URL_COMMAND_MAX_ERR_BYTES });
    expect(LINK_URL_COMMAND_TIMEOUT_MS).toBe(5_000);
  });

  test("timeout: reported as command-timeout, with nothing from either stream (no real 5 s wait)", async () => {
    const seen: { opts?: RunOpts } = {};
    const r = await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ timedOut: true, code: -1, signal: "SIGKILL", out: SENTINEL_URL, err: SENTINEL_URL }, seen) });
    expect(r).toEqual(failed("command", "command-timeout"));
    expect(seen.opts?.timeoutMs).toBe(5_000);
  });

  test("a non-zero exit, a signal death and an unfinished stdout are command-exit — even with a URL on stdout", async () => {
    for (const res of [{ code: 1 }, { code: 1, signal: "SIGTERM" }, { code: -1, complete: false }]) {
      expect(await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ ...res, out: SENTINEL_URL, err: SENTINEL_URL }) }))
        .toEqual(failed("command", "command-exit"));
    }
  });

  test("a command that could not be started is command-not-run", async () => {
    expect(await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ spawned: false, code: -1 }) }))
      .toEqual(failed("command", "command-not-run"));
  });

  test("exit 0 with nothing (or only whitespace) on stdout is missing — whatever stderr said", async () => {
    for (const out of ["", "  \n\n"]) {
      expect(await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ out, err: SENTINEL_URL }) }))
        .toEqual(missing("command", "command-empty"));
    }
  });

  test("a runner that throws is a failed read, never a throw", async () => {
    const exec = async (): Promise<RunResult> => { throw new Error(`boom ${SENTINEL_URL}`); };
    expect(await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec })).toEqual(failed("command", "read-error"));
  });

  test("ONLY the configured rung is tried: a failing command never falls back to a valid managed file", async () => {
    const s = state({ content: SENTINEL_URL });
    expect(await resolveLinkUrl(cmdLink(), { stateDir: s.state, exec: fakeRun({ code: 2 }) })).toEqual(failed("command", "command-exit"));
  });
});

// ── urlCommand (real children, through the default runner) ────────────────────────────────────────

describe("rung: urlCommand, real children", () => {
  test("a real child's first stdout line is the URL", async () => {
    expect(await resolveLinkUrl(cmdLink(["printf", "%s\\nsecond line\\n", SENTINEL_URL]), { stateDir: "/nonexistent" }))
      .toEqual({ status: "ok", from: "command", url: SENTINEL_URL });
  });

  test("a real child that prints the URL on stderr and exits 3: command-exit, and the outcome carries nothing of it", async () => {
    const r = await resolveLinkUrl(cmdLink(["sh", "-c", 'printf "%s\\n" "$1" >&2; printf "%s\\n" "$1"; exit 3', "sh", SENTINEL_URL]), { stateDir: "/nonexistent" });
    expect(r).toEqual(failed("command", "command-exit"));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("a real child past the ceiling is killed and reported as a timeout (ceiling shortened for the test)", async () => {
    const t0 = Date.now();
    expect(await resolveLinkUrl(cmdLink(["sleep", "5"]), { stateDir: "/nonexistent", commandTimeoutMs: 200 })).toEqual(failed("command", "command-timeout"));
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test("a real child that prints without end (`yes`) is killed at the stdout cap, long before the ceiling: refused too-long", async () => {
    const t0 = Date.now();
    // The ceiling is left at its 5 s default: only the cap can end this early.
    expect(await resolveLinkUrl(cmdLink(["yes", SENTINEL_URL]), { stateDir: "/nonexistent" })).toEqual(refused("command", "too-long"));
    expect(Date.now() - t0).toBeLessThan(3_000);
    // A child that prints a URL and then just under the cap still works (the cap is not a URL-length rule).
    const pad = "x".repeat(60 * 1024);
    expect(await resolveLinkUrl(cmdLink(["printf", "%s\\n%s\\n", SENTINEL_URL, pad]), { stateDir: "/nonexistent" }))
      .toEqual({ status: "ok", from: "command", url: SENTINEL_URL });
  });

  test("the injected runner is asked for the stdout cap; an over-cap result is refused too-long, its partial stdout unread", async () => {
    let asked: number | undefined;
    const exec = (async (_argv: string[], o?: { maxOutBytes?: number }) => {
      asked = o?.maxOutBytes;
      return { out: `${SENTINEL_URL}\n`, err: "", code: -1, complete: false, spawned: true, signal: "SIGKILL", timedOut: false, outTruncated: true };
    }) as never;
    expect(await resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec })).toEqual(refused("command", "too-long"));
    expect(asked).toBe(LINK_URL_COMMAND_MAX_OUT_BYTES);
  });

  test("final harden r2: a real child that floods STDERR is killed at the stderr cap, long before the ceiling: refused too-long", async () => {
    const t0 = Date.now();
    // Without the cap this buffers every byte (2 GiB would be read until the 5 s kill); with it, the read stops
    // at ~64 KiB and the child is SIGKILLed. The URL on stdout is never handed back.
    const flood = ["sh", "-c", `printf '%s\\n' '${SENTINEL_URL}'; head -c 2147483648 /dev/zero >&2`];
    expect(await resolveLinkUrl(cmdLink(flood), { stateDir: "/nonexistent" })).toEqual(refused("command", "too-long"));
    expect(Date.now() - t0).toBeLessThan(3_000);
    // A chatty-but-bounded stderr (a password manager's notice) under the cap still works.
    const chatty = ["sh", "-c", `printf '%s\\n' '${SENTINEL_URL}'; head -c 30000 /dev/zero | tr '\\0' x >&2`];
    expect(await resolveLinkUrl(cmdLink(chatty), { stateDir: "/nonexistent" })).toEqual({ status: "ok", from: "command", url: SENTINEL_URL });
  });

  test("proc.run: maxErrBytes stops the stderr read and kills the child; unset, stderr is read whole as before", async () => {
    const { run } = await import("../src/proc");
    const capped = await run(["sh", "-c", "head -c 2147483648 /dev/zero >&2"], { timeoutMs: 5_000, maxErrBytes: 4096 });
    expect(capped.errTruncated).toBe(true);
    expect(capped.err.length).toBeLessThan(1024 * 1024);
    expect(capped.signal).toBe("SIGKILL");
    const whole = await run(["sh", "-c", "head -c 200000 /dev/zero | tr '\\0' y >&2"], { timeoutMs: 5_000 });
    expect(whole.errTruncated).toBeUndefined();
    expect(whole.err.length).toBe(200_000);
  });

  test("a binary that does not exist is command-not-run", async () => {
    expect(await resolveLinkUrl(cmdLink(["/nonexistent/dba-no-such-url-helper"]), { stateDir: "/nonexistent" })).toEqual(failed("command", "command-not-run"));
  });
});

// ── the sentinel sweep ─────────────────────────────────────────────────────────────────────────────

/** Run `fn` with every console method and both process streams captured; returns what was written. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; written: string }> {
  const chunks: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  const out = process.stdout.write, err = process.stderr.write;
  for (const m of methods) console[m] = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
  process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    return { value: await fn(), written: chunks.join("\n") };
  } finally {
    methods.forEach((m, i) => { console[m] = saved[i]!; });
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Everything a caller could print or store from an outcome: every field except an `ok` outcome's `url`.
 *  ONLY an `ok` outcome's: a refused, missing or failed outcome is printed whole, so a URL leaked under a
 *  `url` key there is found by the sweep (M1 checkpoint LOW — this used to strip `url` from every outcome,
 *  and a mutant `too-long` outcome carrying `url: <contents>` passed it). */
const printable = (o: LinkUrlOutcome): string => {
  if (o.status !== "ok") return JSON.stringify(o);
  const { url: _url, ...rest } = o;
  return JSON.stringify(rest);
};

test("URL-LEAK SENTINEL: the URL reaches no outcome field but `url`, no warning, and nothing written anywhere", async () => {
  const s = (o: Parameters<typeof state>[0] = {}) => state({ content: `${SENTINEL_URL}\n`, ...o }).state;
  const symlinked = (() => {
    const st = state();
    const target = join(st.state, "elsewhere.url");
    writeFileSync(target, SENTINEL_URL);
    chmodSync(target, 0o600);
    symlinkSync(target, st.file);
    return st.state;
  })();
  const hardlinked = (() => { const st = state({ content: SENTINEL_URL }); linkSync(st.file, join(st.dir, "x.url")); return st.state; })();
  const runs: [string, () => Promise<LinkUrlOutcome>, LinkUrlOutcome["status"]][] = [
    ["file ok", () => resolveLinkUrl(fileLink(), { stateDir: s() }), "ok"],
    ["file 0644", () => resolveLinkUrl(fileLink(), { stateDir: s({ fileMode: 0o644 }) }), "refused"],
    ["dir 0755", () => resolveLinkUrl(fileLink(), { stateDir: s({ dirMode: 0o755 }) }), "refused"],
    ["file symlink", () => resolveLinkUrl(fileLink(), { stateDir: symlinked }), "refused"],
    ["file hardlinked", () => resolveLinkUrl(fileLink(), { stateDir: hardlinked }), "refused"],
    ["file wrong owner", () => resolveLinkUrl(fileLink(), { stateDir: s(), ownerCheck: (_st, w) => w === "dir" }), "refused"],
    ["file on win32", () => resolveLinkUrl(fileLink(), { stateDir: s(), platform: "win32" }), "refused"],
    ["file too long", () => resolveLinkUrl(fileLink(), { stateDir: state({ content: `${SENTINEL_URL}${"x".repeat(LINK_URL_MAX_BYTES)}` }).state }), "refused"],
    ["env ok", () => resolveLinkUrl(envLink(), { stateDir: "/nonexistent", env: { WORK_CAL_URL: SENTINEL_URL } }), "ok"],
    ["env unset (the URL in another variable)", () => resolveLinkUrl(envLink(), { stateDir: "/nonexistent", env: { OTHER: SENTINEL_URL } }), "missing"],
    ["env too long", () => resolveLinkUrl(envLink(), { stateDir: "/nonexistent", env: { WORK_CAL_URL: SENTINEL_URL.repeat(100) } }), "refused"],
    ["command ok (fake)", () => resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ out: SENTINEL_URL, err: SENTINEL_URL }) }), "ok"],
    ["command exit (fake)", () => resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ code: 1, out: SENTINEL_URL, err: SENTINEL_URL }) }), "failed"],
    ["command timeout (fake)", () => resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ timedOut: true, out: SENTINEL_URL, err: SENTINEL_URL }) }), "failed"],
    ["command empty, stderr full (fake)", () => resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: fakeRun({ out: "", err: SENTINEL_URL }) }), "missing"],
    ["command throws (fake)", () => resolveLinkUrl(cmdLink(), { stateDir: "/nonexistent", exec: async () => { throw new Error(SENTINEL_URL); } }), "failed"],
    ["command ok (real)", () => resolveLinkUrl(cmdLink(["printf", "%s", SENTINEL_URL]), { stateDir: "/nonexistent" }), "ok"],
    ["command exit + stderr (real)", () => resolveLinkUrl(cmdLink(["sh", "-c", 'printf "%s" "$1" >&2; printf "%s" "$1"; exit 9', "sh", SENTINEL_URL]), { stateDir: "/nonexistent" }), "failed"],
  ];

  const { value: outcomes, written } = await captured(async () => {
    const got: LinkUrlOutcome[] = [];
    for (const [, run] of runs) got.push(await run());
    return got;
  });

  outcomes.forEach((o, i) => {
    const [label, , status] = runs[i]!;
    expect(`${label}: ${o.status}`).toBe(`${label}: ${status}`);
    // Not vacuous: every `ok` really carries the sentinel in `url`, and only there.
    if (o.status === "ok") expect(o.url).toBe(SENTINEL_URL);
    // …and a non-`ok` outcome has no `url` key at all, whatever it would hold.
    else expect(`${label}: url key ${"url" in o}`).toBe(`${label}: url key false`);
    expect(`${label}: ${printable(o)}`).not.toContain(TOKEN);
  });
  expect(outcomes.filter((o) => o.status === "ok").length).toBe(4);
  expect(written).not.toContain(TOKEN);

  // The resolver, with the sentinel pasted into every field a user could paste it into.
  const configs: unknown[] = [
    SENTINEL_URL,
    { enabled: true, url: SENTINEL_URL },
    { enabled: true, emails: [SENTINEL_URL] },
    { enabled: true, macos: { calendars: SENTINEL_URL } },
    { enabled: true, links: SENTINEL_URL },
    { enabled: true, links: [SENTINEL_URL] },
    ...["id", "name", "owner", "confirmedOwner", "urlEnv", "urlCommand", "url", "URL"].map((k) => ({ enabled: true, links: [{ id: "work", [k]: SENTINEL_URL }] })),
    { enabled: true, links: [{ id: "work", name: `Home ${SENTINEL_URL}` }] },
  ];
  const { value: resolved, written: written2 } = await captured(async () => configs.map((c) => resolveCalendar(c, { platform: "linux" })));
  for (const r of resolved) {
    expect(r.warnings.length).toBe(1);                       // each one is refused or skipped, visibly
    expect(r.warnings.join("\n")).not.toContain(TOKEN);
    expect(JSON.stringify(r.links)).not.toContain(TOKEN);    // nothing carrying it was kept
  }
  expect(written2).not.toContain(TOKEN);
});
