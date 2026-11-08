import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import { windowsIdentity } from "./win-identity";

export interface PageIdentity { pageHash: string; pageVersion: string }
export interface PageVersionFields {
  platform: "unix" | "windows";
  volume: string;
  fileId: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

const UNSIGNED = /^(0|[1-9][0-9]*)$/u;
const SIGNED = /^(0|-?[1-9][0-9]*)$/u;
// Same page cap as briefing_files.rs; the extra read byte detects growth.
const MAX_PAGE_BYTES = 1024 * 1024;
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** `PageIdentity.pageHash` of a page's bytes; a string is hashed as the UTF-8 it is saved as. */
export const pageHashOf = (page: Uint8Array | string): string => sha256(page);

/** Canonical v1 fields never pass through a Number, locale formatter or JSON. */
export function canonicalPageVersion(fields: PageVersionFields): string | null {
  if (fields.platform !== "unix" && fields.platform !== "windows") return null;
  const integers = [fields.volume, fields.size, fields.mtimeNs, fields.ctimeNs];
  if (integers.some((v) => typeof v !== "string") || typeof fields.fileId !== "string") return null;
  if (!UNSIGNED.test(fields.volume) || !UNSIGNED.test(fields.size) || !SIGNED.test(fields.mtimeNs) || !SIGNED.test(fields.ctimeNs)) return null;
  if (fields.platform === "unix" ? !UNSIGNED.test(fields.fileId) : !/^[0-9a-f]{32}$/u.test(fields.fileId)) return null;
  return ["summary-page-v1", fields.platform, fields.volume, fields.fileId, fields.size, fields.mtimeNs, fields.ctimeNs, ""].join("\n");
}

export function pageVersionFor(fields: PageVersionFields): string | null {
  const canonical = canonicalPageVersion(fields);
  return canonical === null ? null : sha256(canonical);
}

function unixFields(stat: BigIntStats): PageVersionFields {
  return {
    platform: "unix", volume: stat.dev.toString(), fileId: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(),
  };
}

/** One capped, no-follow opened-file read. Any unstable/unreliable identity is absent. */
export async function readPageIdentity(path: string): Promise<PageIdentity | null> {
  if (process.platform === "win32") return windowsIdentity(path);
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") return null;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_PAGE_BYTES)) return null;
    const pageVersion = pageVersionFor(unixFields(before));
    if (pageVersion === null) return null;

    const bytes = Buffer.alloc(MAX_PAGE_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (used > MAX_PAGE_BYTES || BigInt(used) !== before.size || !after.isFile() || pageVersionFor(unixFields(after)) !== pageVersion) return null;
    // lstat refuses a symlink replacement and binds the descriptor back to the name.
    const current = await fs.lstat(path, { bigint: true });
    if (!current.isFile() || pageVersionFor(unixFields(current)) !== pageVersion) return null;
    return { pageHash: pageHashOf(bytes.subarray(0, used)), pageVersion };
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch { /* Identity failure is silent, including cleanup. */ }
  }
}
