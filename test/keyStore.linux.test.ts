// test/keyStore.linux.test.ts — the file key store under `<state>/keys/` (provider-fallback plan P2-M2-T2; spec r9 §6
// "Linux"). The store is POSIX code, not Linux-only code, so these cases run on every POSIX host — each call passes
// `platform: "linux"` and its own temp `dir`, never the real state folder (the isolate-state baseline is the default
// should one forget).
//
// What is pinned: `keys/` 0700 and each key 0600 under a 022 umask; the key published EXCLUSIVELY by link(2) from an
// O_EXCL temp file, so publication can never replace an existing key; the fallback to an exclusive create only when
// link fails as a filesystem without hard links does; a bounded id-collision retry; cleanup that only ever removes this
// call's own temp file and its own published key; the read-back through the strict reader with the `keys/` parameters,
// after the temp name is gone (`nlink === 1`), under one deadline; on that deadline, nothing of this call's left on
// disk the moment the call returns, and nothing new created by the attempt it abandoned. Delete and delete-all refuse a
// keys/ that is a link or not a folder, and win32, under the same deadline.
//
// No literal here names the Keychain tool (the darwin dispatch case builds nothing; argv comes from the store).
import "./fixtures/isolate-state";
import { test, expect, describe, afterEach } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { link as fsLink, open as fsOpen } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { readStrictFile } from "../src/strictFile";
import { isAppOwnedKey, type ListEntry } from "../src/providerList";
import type { RunResult } from "../src/proc";
import {
  appKeyDelete, appKeyDeleteAll, appKeySet, fileKeyDelete, fileKeyDeleteAll, fileKeySet, keyFilePath, keyFileReadOpts,
  KEY_FILE_MAX_BYTES, KEY_ID_ATTEMPTS, type FileKeyStoreDeps, type KeyExec,
} from "../src/keyStore";

const KEY = "sk-ant-api03_AbC.def~ghi+jkl/mno=pqr-STU";
const A = "k-aaaaaaaaaaaa";
const B = "k-bbbbbbbbbbbb";
const C = "k-cccccccccccc";

/** A fresh `<root>/state/keys` that does NOT exist yet (the store creates it). */
function keysFolder(): string {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-keystore-file-")));
  mkdirSync(join(root, "state"));
  return join(root, "state", "keys");
}
/** The same folder, created 0700, holding `name` = `content` at 0600 — an EXISTING key the store must never touch. */
function withExisting(name: string, content: string): { dir: string; file: string } {
  const dir = keysFolder();
  mkdirSync(dir);
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  return { dir, file };
}
/** An id source that hands out `ids` in order, then fails loudly. */
function ids(...list: string[]) {
  const asked: string[] = [];
  const next = () => {
    const id = list.shift();
    if (id === undefined) throw new Error("id source exhausted");
    asked.push(id);
    return id;
  };
  return { next, asked };
}
const deps = (dir: string, extra: FileKeyStoreDeps = {}): FileKeyStoreDeps => ({ dir, platform: "linux", ...extra });
const mode = (p: string): number => statSync(p).mode & 0o777;
const outcome = (r: { ok: boolean; reason?: string; cleanup?: string }): string => (r.ok ? "ok" : `${r.reason}/${r.cleanup ?? "none"}`);
const fileEntry = (apiKeyFile: string): ListEntry =>
  ({ provider: { api: { kind: "anthropic", model: "m", apiKeyFile } } } as unknown as ListEntry);

/** A promise the test releases by hand: a fake link parks on it, so the deadline — never a sleep — decides the order. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
}
/** Poll `cond` every 5 ms until it holds, failing after a generous cap (a loaded CI runner is slow, not wrong). */
async function until(cond: () => boolean, what: string, capMs = 4000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > capMs) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(5);
  }
}
/** A link(2) failure with `code`, as the filesystem would report it. */
const linkErr = (code: string) => Object.assign(new Error(`link: ${code}`), { code });
/** The deadline for a test whose premise is "a step past the temp write (link(2), the read-back) is in flight when the
 *  deadline fires". The store must reach that step first — a temp write and its fsync — which took over 100 ms on a
 *  loaded CI runner (2026-10-30, twice), so the deadline fired before link was ever called. The step is gated or never
 *  settles, so a long deadline still fires with it in flight. */
const IN_FLIGHT_DEADLINE_MS = 1000;
/** A read-back `open` that records it was reached — it is reached only once a key has been PUBLISHED. */
function openSpy() {
  const calls: string[] = [];
  const open = (p: string, flags: number) => { calls.push(p); return fsOpen(p, flags); };
  return { open, calls };
}

let savedUmask: number | undefined;
afterEach(() => { if (savedUmask !== undefined) { process.umask(savedUmask); savedUmask = undefined; } });

describe("fileKeySet: the folder, the file, the reference", () => {
  test("under a 022 umask keys/ is 0700 and the key 0600; the key holds exactly the trimmed key; no temp file is left", async () => {
    savedUmask = process.umask(0o022);
    const dir = keysFolder();
    const r = await fileKeySet(`  ${KEY}\n`, deps(dir));
    expect(outcome(r)).toBe("ok");
    if (!r.ok) return;
    expect(r.keyId).toMatch(/^k-[0-9a-f]{12}$/);
    expect(r.apiKeyFile).toBe(join(dir, `${r.keyId}.key`));
    expect(r.apiKeyFile).toBe(keyFilePath(dir, r.keyId));
    expect(mode(dir).toString(8)).toBe("700");
    expect(mode(r.apiKeyFile).toString(8)).toBe("600");
    expect(readFileSync(r.apiKeyFile, "utf8")).toBe(KEY);
    expect(statSync(r.apiKeyFile).nlink).toBe(1);
    expect(readdirSync(dir)).toEqual([`${r.keyId}.key`]);
  });

  test("an existing keys/ at 0755 is chmodded to 0700 (mkdir's mode alone does not survive a 022 umask)", async () => {
    savedUmask = process.umask(0o022);
    const dir = keysFolder();
    mkdirSync(dir, { mode: 0o755 });
    expect(mode(dir).toString(8)).toBe("755");
    const r = await fileKeySet(KEY, deps(dir));
    expect(outcome(r)).toBe("ok");
    expect(mode(dir).toString(8)).toBe("700");
  });

  test("the reference it returns is app-owned by isAppOwnedKey, judged against the same keys/ folder", async () => {
    const dir = keysFolder();
    const r = await fileKeySet(KEY, deps(dir));
    expect(outcome(r)).toBe("ok");
    if (!r.ok) return;
    expect(isAppOwnedKey(fileEntry(r.apiKeyFile), dir)).toBe(true);
  });

  test("a new id per key: the same key stored twice is two files, and neither replaced the other", async () => {
    const dir = keysFolder();
    const a = await fileKeySet(KEY, deps(dir));
    const b = await fileKeySet(KEY, deps(dir));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.keyId).not.toBe(a.keyId);
    expect(readdirSync(dir).sort()).toEqual([`${a.keyId}.key`, `${b.keyId}.key`].sort());
  });

  test("the temp file is `.<keyId>.<pid>.<seq>.tmp` in keys/, created 0600, and link(2) publishes it as <keyId>.key", async () => {
    const dir = keysFolder();
    const links: { from: string; to: string; mode: number; content: string }[] = [];
    const link = async (from: string, to: string) => {
      links.push({ from, to, mode: mode(from), content: readFileSync(from, "utf8") });
      await fsLink(from, to);
    };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link }));
    expect(outcome(r)).toBe("ok");
    expect(links.length).toBe(1);
    const l = links[0]!;
    expect(l.to).toBe(join(dir, `${A}.key`));
    expect(l.from.startsWith(`${dir}/`)).toBe(true);
    expect(l.from.slice(dir.length + 1)).toMatch(new RegExp(`^\\.${A}\\.${process.pid}\\.\\d+\\.tmp$`));
    expect(l.mode.toString(8)).toBe("600");
    expect(l.content).toBe(KEY);
    expect(existsSync(l.from)).toBe(false);
  });

  test("the charset is refused BEFORE anything is written: keys/ is not even created", async () => {
    const dir = keysFolder();
    for (const bad of ["short", `${KEY} x`, `${KEY}"`, "a".repeat(513), ""]) {
      const r = await fileKeySet(bad, deps(dir));
      expect(`${JSON.stringify(bad.slice(0, 20))} → ${outcome(r)}`).toBe(`${JSON.stringify(bad.slice(0, 20))} → invalid-key/none`);
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("win32 is refused before anything is written (the strict reader has no owners or modes there)", async () => {
    const dir = keysFolder();
    const r = await fileKeySet(KEY, deps(dir, { platform: "win32" }));
    expect(outcome(r)).toBe("unsupported-platform/none");
    expect(existsSync(dir)).toBe(false);
  });

  test("a keys/ that is a symlink, or not a folder, is refused and nothing is written through it", async () => {
    const elsewhere = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-keystore-elsewhere-")));
    const dir = keysFolder();
    symlinkSync(elsewhere, dir);
    const r = await fileKeySet(KEY, deps(dir));
    expect(outcome(r)).toBe("keys-folder/none");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);

    const notDir = keysFolder();
    writeFileSync(notDir, "x");
    const r2 = await fileKeySet(KEY, deps(notDir));
    expect(outcome(r2)).toBe("keys-folder/none");
    expect(readFileSync(notDir, "utf8")).toBe("x");
  });
});

describe("the strict reader with the keys/ parameters, on what the store wrote", () => {
  test("it reads the published key, and refuses a symlink, another owner and a second hard link", async () => {
    const dir = keysFolder();
    const r = await fileKeySet(KEY, deps(dir));
    expect(outcome(r)).toBe("ok");
    if (!r.ok) return;
    const opts = keyFileReadOpts(dir);
    expect(opts.maxBytes).toBe(KEY_FILE_MAX_BYTES);
    expect(await readStrictFile(r.apiKeyFile, opts)).toEqual({ status: "ok", text: KEY });

    // Another owner, through the injected owner check (a test cannot chown without root).
    expect(await readStrictFile(r.apiKeyFile, { ...opts, ownerCheck: (_st, which) => which !== "file" }))
      .toEqual({ status: "refused", reason: "file-owner" });
    // A symlink at a key name, pointing at the real key.
    const alias = join(dir, `${C}.key`);
    symlinkSync(r.apiKeyFile, alias);
    expect(await readStrictFile(alias, opts)).toEqual({ status: "refused", reason: "file-symlink" });
    // A second hard link to the key.
    linkSync(r.apiKeyFile, join(dir, "second-link"));
    expect(await readStrictFile(r.apiKeyFile, opts)).toEqual({ status: "refused", reason: "file-hardlinked" });
    // A name outside k-<12 hex>.key (a temp name, say) is refused unread.
    const tmpName = join(dir, `.${A}.1.1.tmp`);
    writeFileSync(tmpName, KEY);
    chmodSync(tmpName, 0o600);
    expect(await readStrictFile(tmpName, opts)).toEqual({ status: "refused", reason: "name-invalid" });
  });

  test("the read-back runs AFTER the temp name is unlinked: the open it decides on sees nlink === 1 and no temp file", async () => {
    const dir = keysFolder();
    const seen: { nlink: number; names: string[] }[] = [];
    const open = async (p: string, flags: number) => {
      const fh = await fsOpen(p, flags);
      seen.push({ nlink: (await fh.stat()).nlink, names: readdirSync(dir) });
      return fh;
    };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, open }));
    expect(outcome(r)).toBe("ok");
    expect(seen).toEqual([{ nlink: 1, names: [`${A}.key`] }]);
  });
});

describe("exclusive publication: an existing key is never replaced", () => {
  test("a forced id collision publishes under a NEW id and leaves the existing key byte-identical (same inode)", async () => {
    const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
    const before = statSync(file);
    const src = ids(A, B);
    const r = await fileKeySet(KEY, deps(dir, { newId: src.next }));
    expect(outcome(r)).toBe("ok");
    if (!r.ok) return;
    expect(r.keyId).toBe(B);
    expect(src.asked).toEqual([A, B]);
    expect(readFileSync(file, "utf8")).toBe("existing-key-AAAA");
    expect(statSync(file).ino).toBe(before.ino);
    expect(readFileSync(join(dir, `${B}.key`), "utf8")).toBe(KEY);
    expect(readdirSync(dir).sort()).toEqual([`${A}.key`, `${B}.key`]);
  });

  test("the retry is bounded: an id source that only repeats an existing id fails as a collision, touching nothing", async () => {
    const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
    const src = ids(...Array.from({ length: KEY_ID_ATTEMPTS + 5 }, () => A));
    const r = await fileKeySet(KEY, deps(dir, { newId: src.next }));
    expect(outcome(r)).toBe("collision/none");
    expect(src.asked.length).toBe(KEY_ID_ATTEMPTS);
    expect(readFileSync(file, "utf8")).toBe("existing-key-AAAA");
    expect(readdirSync(dir)).toEqual([`${A}.key`]);
  });

  test("a link failure other than EEXIST falls back to an exclusive create of the final name — which still never replaces a key", async () => {
    savedUmask = process.umask(0o022);
    const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
    const noLinks = async () => { throw Object.assign(new Error("no hard links here"), { code: "EPERM" }); };
    const src = ids(A, B);
    const r = await fileKeySet(KEY, deps(dir, { newId: src.next, link: noLinks }));
    expect(outcome(r)).toBe("ok");
    if (!r.ok) return;
    expect(r.keyId).toBe(B);
    expect(readFileSync(file, "utf8")).toBe("existing-key-AAAA");
    expect(readFileSync(r.apiKeyFile, "utf8")).toBe(KEY);
    expect(mode(r.apiKeyFile).toString(8)).toBe("600");
    expect(statSync(r.apiKeyFile).nlink).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([`${A}.key`, `${B}.key`]);
  });
});

describe("the fallback is for a filesystem without hard links, and nothing else (P2-M2-T2 checkpoint LOW 1)", () => {
  test("each no-hard-links errno falls back to the exclusive create and publishes", async () => {
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "ENOSYS"]) {
      const dir = keysFolder();
      const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link: async () => { throw linkErr(code); } }));
      expect(`${code} → ${outcome(r)} ${JSON.stringify(readdirSync(dir))}`).toBe(`${code} → ok ${JSON.stringify([`${A}.key`])}`);
    }
  });

  test("a link ENOENT (the temp already removed) fails WITHOUT creating the final name; so does any other errno", async () => {
    for (const code of ["ENOENT", "EIO", "EACCES", "EXDEV", "ENOSPC"]) {
      const dir = keysFolder();
      const spy = openSpy();
      const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link: async () => { throw linkErr(code); }, open: spy.open }));
      expect(`${code} → ${outcome(r)} ${JSON.stringify(readdirSync(dir))} reads:${spy.calls.length}`)
        .toBe(`${code} → write-failed/not-found [] reads:0`);
    }
  });
});

describe("cleanup removes only this call's own temp file and key", () => {
  // A3: a temp file holds the key, so a cleanup that could not unlink it must never answer "not-found" (confirmed).
  test("a temp that cannot be unlinked (keys/ made 0500 after it was written) is cleanup failed, with the keyId", async () => {
    const dir = keysFolder();
    const link = async (_from: string, _to: string): Promise<void> => {
      chmodSync(dir, 0o500);                                  // the temp exists; nothing in keys/ can be unlinked now
      throw Object.assign(new Error("io"), { code: "EIO" });   // not EEXIST, not a no-hard-links errno: write-failed
    };
    try {
      const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link }));
      expect(r.ok ? "ok" : `${r.reason}/${r.cleanup ?? "none"}/${r.keyId ?? "no-id"}`).toBe(`write-failed/failed/${A}`);
      expect(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length).toBe(1);   // it IS still there
    } finally { chmodSync(dir, 0o700); }
  });

  // PR 2 final r2 M1: when the id's final name is TAKEN (EEXIST) — another writer's key — and the temp then sticks, the
  // failure must NOT carry that id: the contract's retry `key delete --id <keyId>` would delete the other key. Both
  // EEXIST branches: link(2)'s, and the no-hard-links fallback's exclusive create.
  for (const branch of ["link", "fallback create"] as const) {
    test(`a taken name (${branch} EEXIST) whose temp then sticks fails WITHOUT the id; the existing key is untouched`, async () => {
      const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
      const before = statSync(file);
      const stick = (): Error => { chmodSync(dir, 0o500); return linkErr("EEXIST"); };   // nothing in keys/ unlinks now
      const extra: FileKeyStoreDeps = branch === "link"
        ? { link: async () => { throw stick(); } }
        : {
          link: async () => { throw linkErr("EPERM"); },                                  // no hard links: the fallback
          createFile: async (p, flags, m) => { if (p.endsWith(".key")) throw stick(); return fsOpen(p, flags, m); },
        };
      try {
        const r = await fileKeySet(KEY, deps(dir, { newId: ids(A, B).next, ...extra }));
        expect(r.ok ? "ok" : `${r.reason}/${r.cleanup ?? "none"}/${r.keyId ?? "no-id"}`).toBe("write-failed/failed/no-id");
        expect(readFileSync(file, "utf8")).toBe("existing-key-AAAA");
        expect(statSync(file).ino).toBe(before.ino);
        expect(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length).toBe(1);   // the stuck temp, named by no id
      } finally { chmodSync(dir, 0o700); }
    });
  }

  test("a read-back failure removes the new key and nothing else", async () => {
    const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(B).next, ownerCheck: (_st, which) => which !== "file" }));
    expect(outcome(r)).toBe("readback-failed/deleted");
    expect(readdirSync(dir)).toEqual([`${A}.key`]);
    expect(readFileSync(file, "utf8")).toBe("existing-key-AAAA");
  });

  test("a read-back that does not match removes the new key and nothing else", async () => {
    const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
    // The read-back's open is pointed at the EXISTING key (same folder, same checks), so what it reads differs.
    const open = (_p: string, flags: number) => fsOpen(file, flags);
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(B).next, open }));
    expect(outcome(r)).toBe("readback-mismatch/deleted");
    expect(readdirSync(dir)).toEqual([`${A}.key`]);
    expect(readFileSync(file, "utf8")).toBe("existing-key-AAAA");
  });

  test("cleanup re-checks the inode: a key name that now holds SOMEONE ELSE'S file is left alone", async () => {
    const dir = keysFolder();
    // During the read-back the published key is swapped for another file at the same name (another writer's). The old
    // inode is kept alive by a hard link OUTSIDE keys/, so the new file cannot reuse its number (ext4 reuses freed ones).
    const open = async (p: string, flags: number) => {
      linkSync(p, join(dirname(dir), "kept-old-inode"));
      const other = join(dirname(dir), "other");
      writeFileSync(other, "someone-elses-key");
      chmodSync(other, 0o600);
      renameSync(other, p);
      return fsOpen(p, flags);
    };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, open }));
    expect(outcome(r)).toBe("readback-mismatch/not-found");
    expect(readFileSync(join(dir, `${A}.key`), "utf8")).toBe("someone-elses-key");
  });

  test("the fallback's exclusive create treats ANY entry at the name (here a folder) as taken: a fresh id, no temp left", async () => {
    const dir = keysFolder();
    const noLinks = async () => { throw linkErr("EPERM"); };
    // The fallback's exclusive create is made to fail by a FOLDER already sitting at the final name.
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    mkdirSync(join(dir, `${A}.key`));
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A, B, C, A, B).next, link: noLinks }));
    // A folder at the name reads as EEXIST, so the id is retried and B publishes through the fallback.
    expect(outcome(r)).toBe("ok");
    expect(readdirSync(dir).sort()).toEqual([`${A}.key`, `${B}.key`]);
    expect(lstatSync(join(dir, `${A}.key`)).isDirectory()).toBe(true);
  });
});

describe("one deadline over the write and the read-back", () => {
  // LOW 6: no fixed sleeps decide an order here. Each fake link parks on a gate the test opens; the deadline
  // (`IN_FLIGHT_DEADLINE_MS`: 300 ms was not always enough for the folder and the temp write on a loaded runner) is what
  // returns the call; conditions are polled.
  test("a slow link hits the deadline: the caller removes the temp, the late link finds it gone, and NO fallback create follows", async () => {
    const dir = keysFolder();
    const g = gate();
    let linkCode: unknown = "not-called";
    const spy = openSpy();
    const link = async (from: string, to: string) => {
      linkCode = "parked";
      await g.wait;
      try { await fsLink(from, to); linkCode = "landed"; } catch (e) { linkCode = (e as { code?: unknown }).code; throw e; }
    };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, open: spy.open, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
    expect(linkCode).toBe("parked");
    expect(outcome(r)).toBe("timeout/not-found");
    expect(readdirSync(dir)).toEqual([]);
    g.open();
    await until(() => linkCode !== "parked", "the late link to settle");
    expect(linkCode).toBe("ENOENT");
    await Bun.sleep(100);                       // a negative check: a fallback create would have published by now
    expect(readdirSync(dir)).toEqual([]);
    expect(spy.calls).toEqual([]);              // the read-back runs only after a publish: none happened
  });

  // P2-M2-T2 checkpoint MED: `main.ts` ends in `process.exit(await main(argv))`, so an abandoned attempt gets NO
  // further turn once the caller returns. The key a landed-but-unreturned link published must already be gone then.
  test("a link that LANDS and only then is slow to return: the key is gone the moment the call returns, with no later turn", async () => {
    const dir = keysFolder();
    const g = gate();
    let landed = false;
    let returned = false;
    const link = async (from: string, to: string) => { await fsLink(from, to); landed = true; await g.wait; returned = true; };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
    const atReturn = readdirSync(dir);          // synchronously: the abandoned attempt is still parked in its link
    expect(landed).toBe(true);
    expect(returned).toBe(false);
    expect(atReturn).toEqual([]);
    expect(outcome(r)).toBe("timeout/deleted");
    g.open();
    await until(() => returned, "the late link to return");
    await Bun.sleep(100);                       // a negative check: the resumed attempt publishes nothing
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a no-hard-links failure that arrives AFTER the deadline does not fall back: nothing is created after the caller gave up", async () => {
    const dir = keysFolder();
    const g = gate();
    let rejected = false;
    const spy = openSpy();
    const link = async () => { await g.wait; rejected = true; throw linkErr("EPERM"); };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, open: spy.open, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
    expect(outcome(r)).toBe("timeout/not-found");
    g.open();
    await until(() => rejected, "the late link to fail");
    await Bun.sleep(100);                       // a negative check: a fallback create would have published by now
    expect(readdirSync(dir)).toEqual([]);
    expect(spy.calls).toEqual([]);
  });

  // PR 2 final r3 L1: the TIMEOUT answer follows r2 M1's rule. The answer is built while link(2) is still in flight, so
  // the EEXIST has not been seen: the cleanup's own finding — another inode under `<id>.key` — keeps the id out. The
  // contrast pins the other direction: the same race on a FREE name still names the id (the key may land there).
  test("a deadline while link(2) is in flight on a TAKEN name: the timeout answer names no id; on a FREE name it does", async () => {
    for (const taken of [true, false]) {
      const { dir, file } = withExisting(taken ? `${A}.key` : `${B}.key`, "another writer's key");
      const g = gate();
      let entered = false;
      let rejected = false;
      const link = async () => { entered = true; await g.wait; rejected = true; throw linkErr(taken ? "EEXIST" : "EIO"); };
      const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
      expect([entered, rejected]).toEqual([true, false]);      // the premise: the answer was built with the link in flight
      expect(`${taken}: ${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe(`${taken}: timeout/not-found ${taken ? "undefined" : A}`);
      g.open();
      await until(() => rejected, "the late link to fail");
      expect(readFileSync(file, "utf8")).toBe("another writer's key");
      expect(readdirSync(dir)).toEqual([basename(file)]);
    }
  });

  // P3-M1-T0 (PR 2 final r3 scoped review, probes P2 and P3): the answer was still built naming the id when nothing had
  // looked at its final name yet — the temp's O_EXCL open in flight (nothing published, so the cleanup never looks), or
  // the cleanup itself cut (`cleanupMs: 0`) with link(2) in flight. The store now looks at `<id>.key` the moment the id
  // is issued, so a name another key holds keeps the id out of the answer either way; the other key is untouched.
  test("probe P2: a fresh id equal to an existing key, the deadline firing while its temp's open is in flight: no keyId", async () => {
    const { dir, file } = withExisting(`${A}.key`, "another writer's key");
    const g = gate();
    let entered = false;
    let opened = false;
    const createFile = async (p: string, flags: number, m: number) => { entered = true; await g.wait; const fh = await fsOpen(p, flags, m); opened = true; return fh; };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, createFile, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
    expect([entered, opened]).toEqual([true, false]);          // the premise: the temp's open was in flight at the deadline
    expect(`${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe("timeout/not-found undefined");
    g.open();
    await until(() => opened, "the late temp open to return");
    expect(r.ok ? undefined : await r.abandoned?.settle()).toBe("not-found");
    expect(readFileSync(file, "utf8")).toBe("another writer's key");
    expect(readdirSync(dir)).toEqual([basename(file)]);
  });

  test("probe P3: `cleanupMs: 0` with link(2) in flight on a TAKEN name: cleanup timeout and no keyId; on a FREE name the id stays", async () => {
    for (const taken of [true, false]) {
      const { dir, file } = withExisting(taken ? `${A}.key` : `${B}.key`, "another writer's key");
      const g = gate();
      let entered = false;
      let rejected = false;
      const link = async () => { entered = true; await g.wait; rejected = true; throw linkErr(taken ? "EEXIST" : "EIO"); };
      const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 0 }));
      expect([entered, rejected]).toEqual([true, false]);      // the premise: link(2) in flight, and no cleanup budget at all
      expect(`${taken}: ${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe(`${taken}: timeout/timeout ${taken ? "undefined" : A}`);
      g.open();
      await until(() => rejected, "the late link to fail");
      if (!r.ok) await r.abandoned?.settle();
      expect(readFileSync(file, "utf8")).toBe("another writer's key");
    }
  });

  // The look at the name is awaited on the timeout path within what is left of the cleanup budget; one that answers
  // later than that keeps today's answer (the id named): a stalled key folder is no evidence of another key there.
  test("the look at the name answering AFTER the deadline but inside the cleanup budget still keeps the id out", async () => {
    // The look starts when the id is issued, after the folder is prepared: 1.5 s answers after the 1 s deadline and before
    // the 2 s budget runs out (about 3 s), with a second of headroom for a slow folder; 5 s answers after it.
    for (const [lookMs, expected] of [[1_500, "undefined"], [5_000, A]] as const) {
      const { dir, file } = withExisting(`${A}.key`, "another writer's key");
      const g = gate();
      const nameLstat = async (p: string) => { await Bun.sleep(lookMs); return lstatSync(p); };
      // Probe P2's shape (the temp's open in flight), where nothing else looks at the name before the answer.
      let entered = false;
      const createFile = async (p: string, flags: number, m: number) => { entered = true; await g.wait; return fsOpen(p, flags, m); };
      const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, createFile, nameLstat, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 2_000 }));
      expect(entered).toBe(true);                              // the premise: the temp's open was in flight at the deadline
      // With the look held past the whole budget the answer is today's — the id, and the CLI's unconfirmed-cleanup retry.
      expect(`${lookMs}: ${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe(`${lookMs}: timeout/not-found ${expected}`);
      g.open();
      if (!r.ok) await r.abandoned?.settle();
      expect(readFileSync(file, "utf8")).toBe("another writer's key");
    }
  }, 15_000);

  test("a look that sees THIS call's own published inode is not taken: the id stays for the retry", async () => {
    const dir = keysFolder();
    const g = gate();
    let landed = false;
    const link = async (from: string, to: string) => { await fsLink(from, to); landed = true; await g.wait; };
    // The look answers only once the link has landed, so it sees this call's own key under the name.
    const nameLstat = async (p: string) => { await until(() => landed, "the link to land"); return lstatSync(p); };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, nameLstat, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 600 }));
    expect(`${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe(`timeout/deleted ${A}`);
    g.open();
    if (!r.ok) await r.abandoned?.settle();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a look answering for an id no longer in flight is dropped: A's late answer never marks B", async () => {
    const { dir } = withExisting(`${A}.key`, "another writer's key");
    const g = gate();
    let bLinking = false;
    const link = async (from: string, to: string) => {
      if (basename(to) === `${A}.key`) return fsLink(from, to);          // EEXIST: a fresh id follows
      bLinking = true;
      await g.wait;
      return fsLink(from, to);
    };
    // A's look answers (A.key is there) only once B is in flight; B's own look answers at once (nothing there).
    const nameLstat = async (p: string) => {
      if (basename(p) === `${A}.key`) await until(() => bLinking, "B's link to start");
      return lstatSync(p);
    };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A, B).next, link, nameLstat, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 600 }));
    expect(`${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe(`timeout/not-found ${B}`);
    g.open();
    if (!r.ok) await r.abandoned?.settle();
  });

  test("a look at the name that fails (not ENOENT) counts as taken: fail closed", async () => {
    const dir = keysFolder();
    const g = gate();
    const nameLstat = async () => { throw Object.assign(new Error("lstat: EIO"), { code: "EIO" }); };
    const link = async () => { await g.wait; throw linkErr("EIO"); };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, link, nameLstat, deadlineMs: 100, cleanupMs: 600 }));
    expect(`${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe("timeout/not-found undefined");
    g.open();
    if (!r.ok) await r.abandoned?.settle();
    expect(readdirSync(dir)).toEqual([]);
  });

  // L1b (PR 2 final r3 scoped review, probe P1): `taken` belongs to the id in flight. A first id whose name is really
  // taken (link(2) answers EEXIST) must not leave its `taken` on the NEXT id: B's link held past the deadline is B's own
  // key possibly landing, so the answer names B for the app's retry. (Deleting the reset on a fresh id survived every
  // suite before this test.)
  test("probe P1: a taken first id does not leak to the next — B's link held past the deadline names B", async () => {
    const { dir, file } = withExisting(`${A}.key`, "another writer's key");
    const g = gate();
    const tried: string[] = [];
    const codes: unknown[] = [];
    let lateCode: unknown = "not-settled";
    const link = async (from: string, to: string) => {
      tried.push(basename(to));
      if (basename(to) === `${A}.key`) {
        try { await fsLink(from, to); } catch (e) { codes.push((e as { code?: unknown }).code); throw e; }
        return;
      }
      await g.wait;
      try { await fsLink(from, to); lateCode = "landed"; } catch (e) { lateCode = (e as { code?: unknown }).code; throw e; }
    };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A, B).next, link, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
    expect(tried).toEqual([`${A}.key`, `${B}.key`]);
    expect(codes).toEqual(["EEXIST"]);                         // the premise: A's link really hit its taken name
    expect(`${outcome(r)} ${String((r as { keyId?: string }).keyId)}`).toBe(`timeout/not-found ${B}`);
    g.open();
    await until(() => lateCode !== "not-settled", "B's late link to settle");
    expect(lateCode).toBe("ENOENT");                           // the cleanup removed B's temp first
    expect(readFileSync(file, "utf8")).toBe("another writer's key");
    expect(readdirSync(dir)).toEqual([basename(file)]);
  });

  test("a name found taken AFTER the deadline issues no fresh id: the abandoned attempt starts no new file", async () => {
    const dir = keysFolder();
    const g = gate();
    let rejected = false;
    const src = ids(A, B, C);
    const link = async () => { await g.wait; rejected = true; throw linkErr("EEXIST"); };
    const r = await fileKeySet(KEY, deps(dir, { newId: src.next, link, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 1000 }));
    expect(outcome(r)).toBe("timeout/not-found");
    g.open();
    await until(() => rejected, "the late link to fail");
    await Bun.sleep(100);                       // a negative check: a retry would have asked for B by now
    expect(src.asked).toEqual([A]);
    expect(readdirSync(dir)).toEqual([]);
  });

  // P2-M2 milestone checkpoint MED: the abandon check before a fresh id ran BEFORE the temp's O_EXCL open, and nothing
  // re-checked between that open returning and link(2). An open still in flight at the deadline is not yet recorded, so
  // the caller's cleanup finds nothing — and the late open then linked a real `.key` after the call had returned.
  test("a temp open still in flight at the deadline links NOTHING once it returns, and its temp is removed", async () => {
    const dir = keysFolder();
    const g = gate();
    let opened = false;
    const linked: string[] = [];
    const spy = openSpy();
    const createFile = async (p: string, flags: number, m: number) => { await g.wait; const fh = await fsOpen(p, flags, m); opened = true; return fh; };
    const link = async (from: string, to: string) => { linked.push(to); await fsLink(from, to); };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, createFile, link, open: spy.open, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 2000 }));
    expect(opened).toBe(false);                 // the open was parked when the deadline fired
    expect(outcome(r)).toBe("timeout/not-found");
    expect(readdirSync(dir)).toEqual([]);
    g.open();
    await until(() => opened, "the late temp open to return");
    expect(r.ok).toBe(false);
    const late = r.ok ? undefined : await r.abandoned?.settle();
    expect(late).toBe("not-found");             // the attempt ended, removing its own temp
    expect(linked).toEqual([]);                 // and it never called link(2)
    expect(readdirSync(dir)).toEqual([]);       // no temp, no key
    expect(spy.calls).toEqual([]);
  });

  test("a fallback create still in flight at the deadline is removed the moment it returns: no read-back follows", async () => {
    const dir = keysFolder();
    const g = gate();
    let finalOpened = false;
    const spy = openSpy();
    const createFile = async (p: string, flags: number, m: number) => {
      if (p.endsWith(".key")) { await g.wait; const fh = await fsOpen(p, flags, m); finalOpened = true; return fh; }
      return fsOpen(p, flags, m);
    };
    const link = async () => { throw linkErr("EPERM"); };
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, createFile, link, open: spy.open, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 2000 }));
    expect(finalOpened).toBe(false);
    expect(outcome(r)).toBe("timeout/not-found");
    expect(readdirSync(dir)).toEqual([]);
    g.open();
    await until(() => finalOpened, "the late fallback create to return");
    const late = r.ok ? undefined : await r.abandoned?.settle();
    expect(late).toBe("deleted");               // the attempt removed the final name it had just created
    expect(readdirSync(dir)).toEqual([]);
    expect(spy.calls).toEqual([]);              // without going on to a read-back
  });

  test("a stalled read-back hits the deadline and the published key is deleted", async () => {
    const dir = keysFolder();
    let reached = false;
    const open = () => { reached = true; return new Promise<never>(() => {}); };
    const t0 = performance.now();
    const r = await fileKeySet(KEY, deps(dir, { newId: ids(A).next, open, deadlineMs: IN_FLIGHT_DEADLINE_MS, cleanupMs: 200 }));
    expect(performance.now() - t0).toBeLessThan(3000);   // bounded at all (the open never settles), not a race
    expect(reached).toBe(true);                          // the premise: the read-back was what stalled
    expect(outcome(r)).toBe("timeout/deleted");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the timeout message is about the key folder, never the Keychain", async () => {
    const dir = keysFolder();
    const open = () => new Promise<never>(() => {});
    const r = await fileKeySet(KEY, deps(dir, { open, deadlineMs: 20, cleanupMs: 100 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message.toLowerCase()).not.toContain("keychain");
  });
});

describe("fileKeyDelete and fileKeyDeleteAll", () => {
  test("delete validates the id first, removes that one key, and answers deleted:false for a missing one", async () => {
    const { dir, file } = withExisting(`${A}.key`, "existing-key-AAAA");
    writeFileSync(join(dir, `${B}.key`), "b");
    for (const bad of ["k-AAAAAAAAAAAA", "../x", `${A}.key`, ""]) {
      const r = await fileKeyDelete(bad, deps(dir));
      expect(`${JSON.stringify(bad)} → ${r.ok ? "ok" : r.reason}`).toBe(`${JSON.stringify(bad)} → invalid-id`);
    }
    expect(await fileKeyDelete(A, deps(dir))).toEqual({ ok: true, deleted: true });
    expect(existsSync(file)).toBe(false);
    expect(await fileKeyDelete(A, deps(dir))).toEqual({ ok: true, deleted: false });
    expect(readdirSync(dir)).toEqual([`${B}.key`]);
  });

  // PR 2 final r2 L1: the contract's retry `key delete --id <keyId>` after a cleanup `failed` must reach a temp file that
  // stuck (it holds the key): delete also removes THAT id's temps whose writer is gone, and says so in `deleted`. A live
  // writer's temp (a set still in flight) and another id's temp are never touched.
  test("delete also removes that id's dead-writer temps (deleted:true even with no key file); never a live pid's or another id's", async () => {
    const { dir } = withExisting(`.${A}.111.1.tmp`, "dead writer's temp");
    for (const n of [`.${A}.222.3.tmp`, `.${A}.4242.1.tmp`, `.${B}.111.1.tmp`]) writeFileSync(join(dir, n), "t");
    const isAlive = (pid: number): boolean => pid === 4242;
    expect(await fileKeyDelete(A, deps(dir, { isAlive }))).toEqual({ ok: true, deleted: true });
    expect(readdirSync(dir).sort()).toEqual([`.${A}.4242.1.tmp`, `.${B}.111.1.tmp`]);
    expect(await fileKeyDelete(A, deps(dir, { isAlive }))).toEqual({ ok: true, deleted: false });   // only the live one left
    writeFileSync(join(dir, `${A}.key`), "k");
    writeFileSync(join(dir, `.${A}.111.2.tmp`), "t");
    expect(await fileKeyDelete(A, deps(dir, { isAlive }))).toEqual({ ok: true, deleted: true });
    expect(readdirSync(dir).sort()).toEqual([`.${A}.4242.1.tmp`, `.${B}.111.1.tmp`]);
  });

  test("delete of a dead-writer temp that cannot be unlinked is failed, never deleted:false", async () => {
    const { dir } = withExisting(`.${A}.111.1.tmp`, "stuck temp");
    chmodSync(dir, 0o500);
    try {
      const r = await fileKeyDelete(A, deps(dir, { isAlive: () => false }));
      expect(r.ok ? "ok" : r.reason).toBe("failed");
    } finally { chmodSync(dir, 0o700); }
    expect(readdirSync(dir)).toEqual([`.${A}.111.1.tmp`]);
  });

  // PR 2 final r3 L2: an UNLISTABLE keys/ (0300: a file still unlinks by name, the folder cannot be read). The key goes,
  // but the id's temps cannot be looked for, so the answer fails closed — `failed`, never `deleted: true` — and the key
  // file is gone all the same (the documented case: retrying is harmless). Kills mutant `sweep-readdir-stuck`.
  test("delete on an unlistable keys/ removes the key file yet answers failed: the temp sweep could not look", async () => {
    const { dir, file } = withExisting(`${A}.key`, "the key");
    chmodSync(dir, 0o300);
    let r;
    try { r = await fileKeyDelete(A, deps(dir, { isAlive: () => false })); }
    finally { chmodSync(dir, 0o700); }
    expect(r.ok ? "ok" : r.reason).toBe("failed");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  // C1: delete-all is the uninstall leg (spec §6: it removes <state>/keys/ on Linux). Every APP-SHAPED file goes —
  // each published key AND each temp, whatever its pid (a live pid's, pid 1's, this process's: a temp holds the key) —
  // and then the folder itself when nothing else is in it. A file that is not the app's stays, with the folder, and is
  // counted in `kept`. `deleted` counts published keys only.
  test("deleteAll removes every key and every app temp (any pid), keeps a stranger's file and counts it; a missing keys/ is zero deleted", async () => {
    const { dir } = withExisting(`${A}.key`, "a");
    writeFileSync(join(dir, `${B}.key`), "b");
    writeFileSync(join(dir, "notes.txt"), "n");
    for (const pid of [1, process.pid, 2147483646]) writeFileSync(join(dir, `.${C}.${pid}.1.tmp`), "t");
    writeFileSync(join(dir, `.${C}.0.1.tmp`), "not app-shaped: pid 0");
    expect(await fileKeyDeleteAll(deps(dir))).toEqual({ ok: true, deleted: 2, kept: 2 });
    expect(readdirSync(dir).sort()).toEqual([`.${C}.0.1.tmp`, "notes.txt"]);
    expect(await fileKeyDeleteAll(deps(keysFolder()))).toEqual({ ok: true, deleted: 0 });
  });

  test("deleteAll removes the emptied keys/ itself (C1), and a symlinked keys/ is still refused, never removed", async () => {
    const { dir } = withExisting(`${A}.key`, "a");
    writeFileSync(join(dir, `.${B}.1.1.tmp`), "t");
    expect(await fileKeyDeleteAll(deps(dir))).toEqual({ ok: true, deleted: 1 });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(dirname(dir))).toBe(true);           // the state folder itself is untouched
    const real = withExisting(`${A}.key`, "a").dir;
    const link = join(dirname(keysFolder()), "keys");
    symlinkSync(real, link);
    const r = await fileKeyDeleteAll(deps(link));
    expect(r.ok ? "ok" : r.reason).toBe("keys-folder");
    expect([lstatSync(link).isSymbolicLink(), readdirSync(real)]).toEqual([true, [`${A}.key`]]);
  });
});

describe("fileKeyDelete and fileKeyDeleteAll refuse an unsafe keys/ (P2-M2-T2 checkpoint LOW 5)", () => {
  test("a keys/ that is a symlink is refused by both, and nothing is unlinked through it", async () => {
    const elsewhere = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-keystore-elsewhere-")));
    writeFileSync(join(elsewhere, `${A}.key`), "a");
    writeFileSync(join(elsewhere, `${B}.key`), "b");
    const dir = keysFolder();
    symlinkSync(elsewhere, dir);
    const d = await fileKeyDelete(A, deps(dir));
    expect(d.ok ? "ok" : d.reason).toBe("keys-folder");
    const all = await fileKeyDeleteAll(deps(dir));
    expect(all.ok ? "ok" : `${all.reason}/${all.deleted}`).toBe("keys-folder/0");
    expect(readdirSync(elsewhere).sort()).toEqual([`${A}.key`, `${B}.key`]);
  });

  test("a keys/ that is not a folder is refused by both; a missing one is still nothing to delete", async () => {
    const notDir = keysFolder();
    writeFileSync(notDir, "x");
    const d = await fileKeyDelete(A, deps(notDir));
    expect(d.ok ? "ok" : d.reason).toBe("keys-folder");
    const all = await fileKeyDeleteAll(deps(notDir));
    expect(all.ok ? "ok" : `${all.reason}/${all.deleted}`).toBe("keys-folder/0");
    expect(readFileSync(notDir, "utf8")).toBe("x");
    expect(await fileKeyDelete(A, deps(keysFolder()))).toEqual({ ok: true, deleted: false });
    expect(await fileKeyDeleteAll(deps(keysFolder()))).toEqual({ ok: true, deleted: 0 });
  });

  test("win32 is refused by both before anything is touched", async () => {
    const { dir, file } = withExisting(`${A}.key`, "a");
    const d = await fileKeyDelete(A, deps(dir, { platform: "win32" }));
    expect(d.ok ? "ok" : d.reason).toBe("unsupported-platform");
    const all = await fileKeyDeleteAll(deps(dir, { platform: "win32" }));
    expect(all.ok ? "ok" : `${all.reason}/${all.deleted}`).toBe("unsupported-platform/0");
    expect(existsSync(file)).toBe(true);
  });

  test("both run under the one deadline: an exhausted one answers timeout", async () => {
    const { dir } = withExisting(`${A}.key`, "a");
    const d = await fileKeyDelete(A, deps(dir, { deadlineMs: 0 }));
    expect(d.ok ? "ok" : d.reason).toBe("timeout");
    const all = await fileKeyDeleteAll(deps(dir, { deadlineMs: 0 }));
    expect(all.ok ? "ok" : `${all.reason}/${all.deleted}`).toBe("timeout/0");
  });
});

describe("the platform dispatch", () => {
  test("darwin goes to the Keychain store (through the injected exec), every other POSIX platform to the file store", async () => {
    const calls: string[][] = [];
    const exec: KeyExec = async (cmd) => {
      calls.push(cmd);
      return { out: "", err: "", code: 44, complete: true, spawned: true, signal: null, timedOut: false } satisfies RunResult;
    };
    const dir = keysFolder();
    const mac = await appKeySet(KEY, { platform: "darwin", exec, home: "/Users/fake", env: {}, dir });
    expect(mac.ok).toBe(false);                      // the fake's add exits 44
    expect(calls.length).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);

    const linux = await appKeySet(KEY, { platform: "linux", exec, dir });
    expect(outcome(linux)).toBe("ok");
    if (!linux.ok || !("apiKeyFile" in linux)) throw new Error("expected a file reference");
    expect(existsSync(linux.apiKeyFile)).toBe(true);
    const n = calls.length;
    expect(await appKeyDelete(linux.keyId, { platform: "linux", exec, dir })).toEqual({ ok: true, deleted: true });
    expect(await appKeyDeleteAll({ platform: "linux", exec, dir })).toEqual({ ok: true, deleted: 0 });
    expect(calls.length).toBe(n);                   // the file store never reached the exec
  });
});
