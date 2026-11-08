import type { PageIdentity } from "./page-version";

/** FILETIME's 100 ns ticks, converted exactly to Unix-epoch nanoseconds. */
export function windowsTicksToUnixNs(ticks: bigint): string {
  return ((ticks - 116444736000000000n) * 100n).toString();
}

/** FILE_ID_128 array-byte order, never GUID order. */
export function windowsFileId(bytes: Uint8Array): string | null {
  if (bytes.length !== 16) return null;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Open question 3 (a): no reliable Windows identity until a Windows smoke run. */
export async function windowsIdentity(_path: string): Promise<PageIdentity | null> {
  return null;
}
