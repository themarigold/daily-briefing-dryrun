// test/strictFile.test.ts — the shared strict reader (`src/strictFile.ts`, provider-fallback plan P1-M1-T1).
//
// The calendar-link reader's checks, extracted so PR 2's `<state>/keys/` files are read the same way. Every
// refusal is driven against a temp folder only; the owner check and the open are injected where a test
// cannot stage the condition (another uid needs root; the lstat→open race cannot be timed). The calendar
// reader's own behaviour through this module is pinned, unedited, by test/calendar-link-url.test.ts.
import "./fixtures/isolate-state";
import { test, expect, describe, spyOn } from "bun:test";
import { chmodSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { canonicalPath, readStrictFile, type StrictReadOutcome, type StrictReadOpts } from "../src/strictFile";

const NAME_RE = /^k-[0-9a-f]{12}\.key$/;
const NAME = "k-0123456789ab.key";
const CONTENT = "sk-strict-ZZSENTINEL0000";
const MAX = 64;

/** A temp folder `<root>/keys` at `dirMode` holding `NAME` with `content` at `fileMode` (chmod after
 *  creation, so the umask cannot soften either). */
function folder(o: { content?: string; dirMode?: number; fileMode?: number; name?: string } = {}): { root: string; dir: string; file: string } {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-strict-")));
  const dir = join(root, "keys");
  mkdirSync(dir);
  chmodSync(dir, o.dirMode ?? 0o700);
  const file = join(dir, o.name ?? NAME);
  if (o.content !== undefined) {
    writeFileSync(file, o.content);
    chmodSync(file, o.fileMode ?? 0o600);
  }
  return { root, dir, file };
}

const read = (file: string, dir: string, extra: Partial<StrictReadOpts> = {}): Promise<StrictReadOutcome> =>
  readStrictFile(file, { folder: dir, idPattern: NAME_RE, maxBytes: MAX, ...extra });

describe("readStrictFile", () => {
  test("a 0600 file in a 0700 folder is read whole and verbatim (no trimming — that is the caller's)", async () => {
    const s = folder({ content: `\n${CONTENT}\n` });
    expect(await read(s.file, s.dir)).toEqual({ status: "ok", text: `\n${CONTENT}\n` });
  });

  test("stricter modes are fine: a 0400 file in a 0500 folder is read", async () => {
    const s = folder({ content: CONTENT, fileMode: 0o400 });
    chmodSync(s.dir, 0o500);
    expect(await read(s.file, s.dir)).toEqual({ status: "ok", text: CONTENT });
  });

  test("missing: no folder, and a folder without the file", async () => {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-strict-")));
    expect(await read(join(root, "keys", NAME), join(root, "keys"))).toEqual({ status: "missing", reason: "file-missing" });
    const s = folder();
    expect(await read(s.file, s.dir)).toEqual({ status: "missing", reason: "file-missing" });
  });

  test("a symlinked FILE is refused, even pointing at a private file", async () => {
    const s = folder();
    const target = join(s.root, "elsewhere.key");
    writeFileSync(target, CONTENT);
    chmodSync(target, 0o600);
    symlinkSync(target, s.file);
    expect(await read(s.file, s.dir)).toEqual({ status: "refused", reason: "file-symlink" });
  });

  test("a symlinked FOLDER is refused, even pointing at a private folder", async () => {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-strict-")));
    const real = join(root, "real");
    mkdirSync(real);
    chmodSync(real, 0o700);
    writeFileSync(join(real, NAME), CONTENT);
    chmodSync(join(real, NAME), 0o600);
    symlinkSync(real, join(root, "keys"));
    expect(await read(join(root, "keys", NAME), join(root, "keys"))).toEqual({ status: "refused", reason: "dir-symlink" });
  });

  test("another owner is refused — folder first, then file (owner check injected: a test cannot chown)", async () => {
    const s = folder({ content: CONTENT });
    const seen: string[] = [];
    expect(await read(s.file, s.dir, { ownerCheck: (_st, which) => { seen.push(which); return false; } }))
      .toEqual({ status: "refused", reason: "dir-owner" });
    expect(seen).toEqual(["dir"]);
    expect(await read(s.file, s.dir, { ownerCheck: (_st, which) => which === "dir" }))
      .toEqual({ status: "refused", reason: "file-owner" });
    // The default (this process's uid) accepts our own files, and the injected check is handed the real stat.
    let uid: number | undefined;
    expect((await read(s.file, s.dir, { ownerCheck: (st) => { uid = st.uid; return true; } })).status).toBe("ok");
    expect(uid).toBe(process.getuid!());
  });

  test("a file with a second hard link is refused", async () => {
    const s = folder({ content: CONTENT });
    linkSync(s.file, join(s.root, "other"));
    expect(await read(s.file, s.dir)).toEqual({ status: "refused", reason: "file-hardlinked" });
  });

  for (const mode of [0o640, 0o620, 0o604, 0o602, 0o610]) {
    test(`a file at mode ${mode.toString(8)} is refused (any group or other bit)`, async () => {
      const s = folder({ content: CONTENT, fileMode: mode });
      expect(await read(s.file, s.dir)).toEqual({ status: "refused", reason: "file-permissions" });
    });
  }

  for (const mode of [0o750, 0o740, 0o705, 0o770, 0o701]) {
    test(`a folder at mode ${mode.toString(8)} is refused`, async () => {
      const s = folder({ content: CONTENT, dirMode: mode });
      expect(await read(s.file, s.dir)).toEqual({ status: "refused", reason: "dir-permissions" });
    });
  }

  test("a folder that is not a folder, and a file that is not a regular file, are refused", async () => {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-strict-")));
    writeFileSync(join(root, "keys"), CONTENT);
    chmodSync(join(root, "keys"), 0o600);
    expect(await read(join(root, "keys", NAME), join(root, "keys"))).toEqual({ status: "refused", reason: "dir-not-directory" });
    const s = folder();
    mkdirSync(s.file);
    chmodSync(s.file, 0o700);
    expect(await read(s.file, s.dir)).toEqual({ status: "refused", reason: "file-not-regular" });
  });

  test(`over maxBytes is refused unread; exactly maxBytes is read`, async () => {
    const big = folder({ content: "a".repeat(MAX + 1) });
    expect(await read(big.file, big.dir)).toEqual({ status: "refused", reason: "too-long" });
    const edge = folder({ content: "a".repeat(MAX) });
    expect(await read(edge.file, edge.dir)).toEqual({ status: "ok", text: "a".repeat(MAX) });
  });

  test("a name outside the pattern, or a file not DIRECTLY in the folder, is refused and never opened", async () => {
    const s = folder({ content: CONTENT });
    writeFileSync(join(s.dir, "notes.txt"), CONTENT);
    chmodSync(join(s.dir, "notes.txt"), 0o600);
    const opened: string[] = [];
    const spy = { open: (p: string, f: number) => { opened.push(p); return open(p, f); } };
    expect(await read(join(s.dir, "notes.txt"), s.dir, spy)).toEqual({ status: "refused", reason: "name-invalid" });
    // A matching basename one level down: the intermediate folder was never checked, so it is not read.
    mkdirSync(join(s.dir, "sub"), { mode: 0o700 });
    writeFileSync(join(s.dir, "sub", NAME), CONTENT);
    chmodSync(join(s.dir, "sub", NAME), 0o600);
    expect(await read(join(s.dir, "sub", NAME), s.dir, spy)).toEqual({ status: "refused", reason: "name-invalid" });
    // And one that walks out of the folder by `..`.
    expect(await read(join(s.dir, "..", NAME), s.dir, spy)).toEqual({ status: "refused", reason: "name-invalid" });
    expect(opened).toEqual([]);
  });

  test("the path must be EXACTLY <folder>/<basename>: an unnormalized `sub/..` through a symlinked `sub` is refused", async () => {
    // P1-M1 checkpoint MED: a lexical dirname check accepted `<folder>/sub/../NAME`, which the kernel resolves
    // through `sub`'s target — here a folder OUTSIDE the checked one, whose parent holds a private NAME.
    const s = folder({ content: CONTENT });
    const outside = join(s.root, "elsewhere", "inner");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(s.root, "elsewhere", NAME), "OUTSIDE");
    chmodSync(join(s.root, "elsewhere", NAME), 0o600);
    symlinkSync(outside, join(s.dir, "sub"));
    const raw = `${s.dir}/sub/../${NAME}`;
    const opened: string[] = [];
    const r = await read(raw, s.dir, { open: (p, f) => { opened.push(p); return open(p, f); } });
    expect(r).toEqual({ status: "refused", reason: "name-invalid" });
    expect(opened).toEqual([]);
    // Other spellings that are not the exact string: `.` and a doubled separator.
    expect(await read(`${s.dir}/./${NAME}`, s.dir)).toEqual({ status: "refused", reason: "name-invalid" });
    expect(await read(`${s.dir}//${NAME}`, s.dir)).toEqual({ status: "refused", reason: "name-invalid" });
    // The exact string still reads.
    expect(await read(join(s.dir, NAME), s.dir)).toEqual({ status: "ok", text: CONTENT });
  });

  test("the open that decides passes O_NOFOLLOW and O_NONBLOCK, read-only (open injected: the race cannot be staged)", async () => {
    const s = folder({ content: CONTENT });
    const seen: { path: string; flags: number }[] = [];
    const r = await read(s.file, s.dir, { open: (path, flags) => { seen.push({ path, flags }); return open(path, flags); } });
    expect(r).toEqual({ status: "ok", text: CONTENT });
    expect(seen.map((o) => o.path)).toEqual([s.file]);
    const flags = seen[0]!.flags;
    expect(`O_NOFOLLOW set: ${(flags & constants.O_NOFOLLOW) === constants.O_NOFOLLOW}`).toBe("O_NOFOLLOW set: true");
    expect(`O_NONBLOCK set: ${(flags & constants.O_NONBLOCK) === constants.O_NONBLOCK}`).toBe("O_NONBLOCK set: true");
    expect(flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND)).toBe(0);
  });

  test("the race's outcomes as the open reports them: ELOOP is file-symlink, ENOENT file-missing, else read-error", async () => {
    const s = folder({ content: CONTENT });
    const raising = (code: string) => async (): Promise<never> => { throw Object.assign(new Error(`${code} ${CONTENT}`), { code }); };
    expect(await read(s.file, s.dir, { open: raising("ELOOP") })).toEqual({ status: "refused", reason: "file-symlink" });
    expect(await read(s.file, s.dir, { open: raising("ENOENT") })).toEqual({ status: "missing", reason: "file-missing" });
    expect(await read(s.file, s.dir, { open: raising("EACCES") })).toEqual({ status: "failed", reason: "read-error" });
  });

  test("a read that throws part-way is read-error, never a throw, and carries nothing from the error", async () => {
    const s = folder({ content: CONTENT });
    const r = await read(s.file, s.dir, {
      open: async (path, flags) => {
        const fh = await open(path, flags);
        return Object.assign(fh, { read: async () => { throw new Error(`boom ${CONTENT}`); } });
      },
    });
    expect(r).toEqual({ status: "failed", reason: "read-error" });
    expect(JSON.stringify(r)).not.toContain("ZZSENTINEL");
  });

  test("Windows is refused outright, before touching the filesystem", async () => {
    const s = folder({ content: CONTENT });
    const opened: string[] = [];
    expect(await read(s.file, s.dir, { platform: "win32", open: (p, f) => { opened.push(p); return open(p, f); } }))
      .toEqual({ status: "refused", reason: "unsupported-platform" });
    expect(opened).toEqual([]);
  });

  test("no outcome other than ok carries the file's bytes", async () => {
    const cases = [
      folder({ content: CONTENT, fileMode: 0o644 }),
      folder({ content: CONTENT.repeat(10) }),
    ];
    for (const s of cases) {
      const r = await read(s.file, s.dir);
      expect(r.status).toBe("refused");
      expect(JSON.stringify(r)).not.toContain("ZZSENTINEL");
    }
  });
});

describe("canonicalPath (moved from src/json.ts, unchanged)", () => {
  test("collapses `//` and `.`, resolves symlinks in the existing prefix, and folds case on darwin", () => {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-strict-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const viaLink = canonicalPath(`${root}/link/./a//b`);
    const direct = canonicalPath(join(root, "real", "a", "b"));
    expect(viaLink).toBe(direct);
    if (process.platform === "darwin") expect(canonicalPath(join(root, "REAL", "A"))).toBe(canonicalPath(join(root, "real", "a")));
  });
});

describe("PR 1 final review round 3 L4: writePrivateAtomic's temp files", () => {
  const dirOf = (tag: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-strict-r3-${tag}-`)));

  test("an EEXIST on the temp open never unlinks a file this call did not create", async () => {
    const { writePrivateAtomic } = await import("../src/strictFile");
    const dir = dirOf("eexist");
    const path = join(dir, "state.json");
    const fixed = 0.123456789;
    const tmp = `${path}.tmp-${process.pid}-${fixed.toString(36).slice(2)}`;
    writeFileSync(tmp, "someone else's");
    const spy = spyOn(Math, "random").mockReturnValue(fixed);
    try {
      await expect(writePrivateAtomic(path, "mine")).rejects.toMatchObject({ code: "EEXIST" });
    } finally { spy.mockRestore(); }
    expect(readFileSync(tmp, "utf8")).toBe("someone else's");
    expect(existsSync(path)).toBe(false);
  });

  test("a successful write removes stale crash leftovers (older than 10 minutes) and leaves fresh ones and other files", async () => {
    const { writePrivateAtomic } = await import("../src/strictFile");
    const dir = dirOf("sweep");
    const path = join(dir, "state.json");
    const old = new Date(Date.now() - 11 * 60e3), fresh = new Date(Date.now() - 60e3);
    const names = { stale: "state.json.tmp-1-old", fresh: "state.json.tmp-2-new", other: "other.json.tmp-3-old", plain: "state.json.bak" };
    for (const n of Object.values(names)) writeFileSync(join(dir, n), "x");
    for (const n of [names.stale, names.other, names.plain]) utimesSync(join(dir, n), old, old);
    utimesSync(join(dir, names.fresh), fresh, fresh);
    await writePrivateAtomic(path, "mine");
    expect(readFileSync(path, "utf8")).toBe("mine");
    expect(readdirSync(dir).sort()).toEqual([names.other, names.plain, "state.json", names.fresh].sort());
  });
});
