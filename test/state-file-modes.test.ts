// test/state-file-modes.test.ts — the three provider-walk state files are written 0600 through ONE atomic writer
// (PR 1 final review round 1, M9): `account-state.json`, `provider-status.json` and `last-failure.json` are each a
// unique exclusive temp file created 0600, then renamed over the destination — so a permissive umask cannot widen
// them and a torn write cannot leave half a record.
import "./fixtures/isolate-state";
import { test, expect, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { recordLimit, accountStatePath } from "../src/account";
import { writeProviderStatus } from "../src/providerStatus";
import { lastFailurePath, providerStatusPath, writeLastFailure } from "../src/marker";
import { freshStateDir } from "./helpers/walk";

const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });

test("under a permissive umask (0o022) all three files are 0600, replace an existing file atomically, and leave no temp file", async () => {
  const d = freshStateDir();
  const prev = process.umask(0o022);
  try {
    // Pre-existing files at a WIDER mode: the writer must replace them, not inherit their mode.
    for (const p of [accountStatePath(d), providerStatusPath(), lastFailurePath()]) writeFileSync(p, "{}", { mode: 0o644 });
    expect(await recordLimit("A", new Date(Date.now() + 3600e3), new Date(), { reason: "usage", isProbe: false })).toBe(true);
    expect(await writeProviderStatus({ labels: { A: { revision: "r" } } })).toBe(true);
    await writeLastFailure({ localDate: "2026-10-16", reason: "provider-fail", detail: "x" });
    for (const p of [accountStatePath(d), providerStatusPath(), lastFailurePath()]) {
      expect(`${p}: ${(statSync(p).mode & 0o777).toString(8)}`).toBe(`${p}: 600`);
    }
    expect(readdirSync(d).filter((n) => n.includes(".tmp"))).toEqual([]);
  } finally { process.umask(prev); }
});

test("round 2 L6: the private writer creates a missing parent folder, as Bun.write did", async () => {
  const { writePrivateAtomic } = await import("../src/strictFile");
  const d = freshStateDir();
  const target = `${d}/not-yet/there/file.json`;
  await writePrivateAtomic(target, "{}");
  expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
});

test("round 3 L5: last-skip.json is written 0600 through the private writer, under a permissive umask, content unchanged", async () => {
  const { writeLastSkip, lastSkipPath, readLastSkip } = await import("../src/marker");
  freshStateDir();
  const prev = process.umask(0o022);
  try {
    await writeLastSkip({ iso: "2026-10-16T07:20:00.000Z", localDate: "2026-10-16", reason: "provider-fail", detail: "nonzero-exit: boom" });
  } finally { process.umask(prev); }
  expect((statSync(lastSkipPath()).mode & 0o777).toString(8)).toBe("600");
  expect(readFileSync(lastSkipPath(), "utf8")).toBe(`${JSON.stringify({ iso: "2026-10-16T07:20:00.000Z", localDate: "2026-10-16", reason: "provider-fail", detail: "nonzero-exit: boom" })}\n`);
  expect((await readLastSkip())?.detail).toBe("nonzero-exit: boom");
});
