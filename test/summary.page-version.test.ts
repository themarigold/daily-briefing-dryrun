import "./fixtures/isolate-state";
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants, mkdtempSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { canonicalPageVersion, pageVersionFor, readPageIdentity } from "../src/summary/page-version";
import type { PageIdentity, PageVersionFields } from "../src/summary/page-version";
import { windowsFileId, windowsIdentity, windowsTicksToUnixNs } from "../src/summary/win-identity";

const vectors = JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/summary-page-version.json", import.meta.url), "utf8")) as {
  vectors: { fields: PageVersionFields; canonical: string; sha256: string }[];
  windowsTicks: { ticks: string; unixNs: string }[];
  windowsIds: { bytes: number[]; hex: string }[];
};

const fields = (overrides: Partial<PageVersionFields> = {}): PageVersionFields => ({
  platform: "unix", volume: "1", fileId: "2", size: "3", mtimeNs: "4", ctimeNs: "5", ...overrides,
});
const scratch = () => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-summary-identity-")));
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("canonical pageVersion v1", () => {
  test.each(vectors.vectors)("literal vector: $canonical", (v) => {
    const input = v.fields as PageVersionFields;
    expect(canonicalPageVersion(input)).toBe(v.canonical);
    expect(sha(v.canonical)).toBe(v.sha256);
    expect(pageVersionFor(input)).toBe(v.sha256);
  });

  test("every metadata field changes the version", () => {
    const mutations: Partial<PageVersionFields>[] = [
      { platform: "windows", fileId: "000102030405060708090a0b0c0d0e0f" },
      { volume: "2" }, { fileId: "3" }, { size: "4" }, { mtimeNs: "5" }, { ctimeNs: "6" },
    ];
    const original = pageVersionFor(fields());
    for (const mutation of mutations) {
      expect(pageVersionFor(fields(mutation))).toMatch(/^[0-9a-f]{64}$/);
      expect(pageVersionFor(fields(mutation))).not.toBe(original);
    }
    const win = fields({ platform: "windows", fileId: "000102030405060708090a0b0c0d0e0f" });
    expect(pageVersionFor({ ...win, fileId: "010102030405060708090a0b0c0d0e0f" })).not.toBe(pageVersionFor(win));
    const both = fields({ fileId: "1".repeat(32) });
    expect(pageVersionFor(both)).not.toBeNull();
    expect(pageVersionFor({ ...both, platform: "windows" })).not.toBeNull();
    expect(pageVersionFor({ ...both, platform: "windows" })).not.toBe(pageVersionFor(both));
  });

  test("precision boundaries remain decimal strings with no floating-point roundtrip", () => {
    for (const field of ["volume", "fileId", "size", "mtimeNs", "ctimeNs"] as const) {
      for (const value of ["0", "18446744073709551615"]) {
        expect(canonicalPageVersion(fields({ [field]: value }))).toBe([
          "summary-page-v1", "unix", ...["volume", "fileId", "size", "mtimeNs", "ctimeNs"].map((key) => key === field ? value : fields()[key as keyof PageVersionFields]), "",
        ].join("\n"));
      }
    }
    expect(canonicalPageVersion(fields({ mtimeNs: "-1", ctimeNs: "-1" }))).toBe("summary-page-v1\nunix\n1\n2\n3\n-1\n-1\n");
    expect(pageVersionFor(fields({ volume: "18446744073709551614" }))).not.toBe(pageVersionFor(fields({ volume: "18446744073709551615" })));
  });

  test("noncanonical or inexact fields cannot produce an identity", () => {
    for (const field of ["volume", "fileId", "size", "mtimeNs", "ctimeNs"] as const) {
      for (const value of ["+1", "01", "-0", " 1", "1\n", "1.0", "1e3", ""]) expect(canonicalPageVersion(fields({ [field]: value }))).toBeNull();
    }
    for (const field of ["volume", "fileId", "size"] as const) expect(pageVersionFor(fields({ [field]: "-1" }))).toBeNull();
    // Runtime boundary: JSON numbers are refused even if a caller bypasses the TS type.
    for (const field of ["volume", "fileId", "size", "mtimeNs", "ctimeNs"] as const) {
      expect(pageVersionFor(fields({ [field]: 1 as unknown as string }))).toBeNull();
    }
    for (const fileId of ["ABCDEF01234567890123456789012345", "00", "g".repeat(32)]) expect(pageVersionFor(fields({ platform: "windows", fileId }))).toBeNull();
  });

  test.each(vectors.windowsTicks)("Windows tick conversion: $ticks", ({ ticks, unixNs }) => {
    expect(windowsTicksToUnixNs(BigInt(ticks))).toBe(unixNs);
  });
  test.each(vectors.windowsIds)("Windows ID array-byte order: $hex", ({ bytes, hex }) => {
    expect(windowsFileId(Uint8Array.from(bytes))).toBe(hex);
  });
  test("Windows IDs must have exactly 16 bytes", () => {
    for (const size of [0, 15, 17]) expect(windowsFileId(new Uint8Array(size))).toBeNull();
  });
  test("Windows branch (a) has no native loader and reports no reliable identity", async () => {
    const source = readFileSync(new URL("../src/summary/win-identity.ts", import.meta.url), "utf8");
    expect(source).not.toContain("bun:ffi");
    expect(source).not.toContain("dlopen");
    expect(source).not.toContain("kernel32.dll");
    expect(await windowsIdentity("/unopened-fixture-page")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("Unix opened-file identity", () => {
  test("hashes exact bytes and derives the version from bigint metadata, without writes", async () => {
    const path = join(scratch(), "page.md");
    const bytes = Buffer.from("☀️ exact\r\nUTF-8 🦀\n");
    await fs.writeFile(path, bytes);
    const before = await fs.lstat(path, { bigint: true });
    const identity = await readPageIdentity(path);
    const pageVersion = pageVersionFor({
      platform: "unix", volume: before.dev.toString(), fileId: before.ino.toString(), size: before.size.toString(),
      mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString(),
    });
    if (pageVersion === null) throw new Error("Expected fixture metadata to produce a page version");
    const expected: PageIdentity = { pageHash: sha(bytes), pageVersion };
    expect(identity).toEqual(expected);
    const after = await fs.lstat(path, { bigint: true });
    expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.size, before.mtimeNs, before.ctimeNs]);
    expect(await fs.readFile(path)).toEqual(bytes);
  });

  test("same bytes in a replacement file have the same hash and a new version", async () => {
    const root = scratch();
    const path = join(root, "page.md");
    await fs.writeFile(path, "same bytes");
    const first = await readPageIdentity(path);
    await fs.writeFile(join(root, "new.md"), "same bytes");
    await fs.rename(join(root, "new.md"), path);
    const second = await readPageIdentity(path);
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(second?.pageHash).toBe(first?.pageHash);
    expect(second?.pageVersion).not.toBe(first?.pageVersion);
  });

  test("unsafe, missing and oversized files have no identity; the page cap is exact", async () => {
    const root = scratch();
    expect(await readPageIdentity(join(root, "missing"))).toBeNull();
    expect(await readPageIdentity(root)).toBeNull();
    const path = join(root, "page.md");
    await fs.writeFile(path, Buffer.alloc(1024 * 1024, 120));
    expect(await readPageIdentity(path)).not.toBeNull();
    await fs.appendFile(path, "x");
    expect(await readPageIdentity(path)).toBeNull();
    await fs.symlink(path, join(root, "link"));
    expect(await readPageIdentity(join(root, "link"))).toBeNull();
  });

  test("a write between descriptor stats is refused and the descriptor is closed", async () => {
    const path = join(scratch(), "page.md");
    await fs.writeFile(path, "original");
    const handle = await fs.open(path, "r");
    const realStat = handle.stat.bind(handle);
    const stat = spyOn(handle, "stat")
      .mockImplementationOnce(realStat)
      // Forward the original options and preserve stat's overloaded type.
      .mockImplementationOnce(((...args: Parameters<typeof realStat>) => {
        writeFileSync(path, "changed between stats");
        return realStat(...args);
      }) as typeof realStat);
    const close = spyOn(handle, "close");
    const open = spyOn(fs, "open").mockResolvedValue(handle);
    try {
      expect(await readPageIdentity(path)).toBeNull();
      expect(stat).toHaveBeenCalledTimes(2);
      expect(stat).toHaveBeenNthCalledWith(1, { bigint: true });
      expect(stat).toHaveBeenNthCalledWith(2, { bigint: true });
      expect(open.mock.calls[0]?.[1]).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      expect(close).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); stat.mockRestore(); close.mockRestore(); await handle.close(); }
  });

  test("a replaced path after stable descriptor stats is refused", async () => {
    const root = scratch();
    const path = join(root, "page.md");
    await fs.writeFile(path, "original");
    await fs.writeFile(join(root, "new.md"), "original");
    const realLstat = fs.lstat.bind(fs);
    // Forward the original path/options and preserve lstat's overloaded type.
    const lstat = spyOn(fs, "lstat").mockImplementationOnce((async (...args: Parameters<typeof realLstat>) => {
      await fs.rename(join(root, "new.md"), path);
      return realLstat(...args);
    }) as typeof realLstat);
    try { expect(await readPageIdentity(path)).toBeNull(); expect(lstat).toHaveBeenCalledTimes(1); }
    finally { lstat.mockRestore(); }
  });

  test("a readable file has no identity on win32, by the platform branch alone", async () => {
    const path = join(scratch(), "page.md");
    await fs.writeFile(path, "readable");
    expect(await readPageIdentity(path)).not.toBeNull();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try { expect(await readPageIdentity(path)).toBeNull(); }
    finally { Object.defineProperty(process, "platform", platform); }
  });
});
