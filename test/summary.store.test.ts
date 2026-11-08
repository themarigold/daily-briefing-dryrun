import "./fixtures/isolate-state";
import { describe, expect, spyOn, test } from "bun:test";
import { constants, mkdtempSync, promises as fs, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { readPageIdentity } from "../src/summary/page-version";
import type { SummaryCard } from "../src/summary/cards";
import {
  parseSummaryRecord, pruneSummaryRecords, readSummaryRecord, serializeSummaryRecord,
  summaryRecordPath, writeSummaryRecord,
} from "../src/summary/store";
import type { SummaryBinding, SummaryRecord } from "../src/summary/store";

const vectors = JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/summary-record-vectors.json", import.meta.url), "utf8")) as {
  binding: SummaryBinding; cards: SummaryCard[];
  valid: { name: string; record: SummaryRecord }[];
  invalid: { name: string; raw: string }[];
  invalidMembership: { name: string; raw: string }[];
  storedKeys: { name: string; raw: string; accepted: boolean }[];
  dates: { date: string; valid: boolean }[];
};
const cards = vectors.cards;
const ready = vectors.valid.find((v) => v.name === "ready")!.record;
const scratch = () => removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-summary-store-")));
/** A record that only its size can refuse: valid JSON, padded with JSON whitespace to exactly `bytes`. */
const padded = (value: SummaryRecord, bytes: number): string => {
  const raw = JSON.stringify(value);
  return raw + " ".repeat(bytes - Buffer.byteLength(raw));
};
const record = (binding: SummaryBinding, state: SummaryRecord["state"]): SummaryRecord => ({
  ...ready, ...binding, state, revision: state === "pending" ? 0 : 1,
  projects: state === "ready" ? ready.projects : [],
  goodMorningSentence: state === "ready" ? ready.goodMorningSentence : null,
  warnings: [],
});

async function setup() {
  const root = scratch(), dir = join(root, "briefings"), page = join(root, "latest.md");
  await fs.mkdir(dir);
  await fs.writeFile(page, "first page bytes");
  const identity = await readPageIdentity(page);
  if (identity === null) throw new Error("A fixture page must have a reliable identity");
  return { root, dir, page, binding: { pageDate: "2026-01-11", ...identity } };
}

describe("schema 1 runtime record contract", () => {
  test.each(vectors.valid)("literal $name serializes and parses exactly", ({ record: value }) => {
    const raw = JSON.stringify(value);
    expect(serializeSummaryRecord(value, cards)).toBe(raw);
    expect(parseSummaryRecord(raw, vectors.binding, cards)).toEqual(value);
  });
  test.each(vectors.invalid)("refuses $name, with or without the page's cards", ({ raw }) => {
    expect(parseSummaryRecord(raw, vectors.binding, cards)).toBeNull();
    expect(parseSummaryRecord(raw, vectors.binding, null)).toBeNull();
  });
  test.each(vectors.invalidMembership)("$name is refused only by card membership", ({ raw }) => {
    expect(parseSummaryRecord(raw, vectors.binding, cards)).toBeNull();
    expect(parseSummaryRecord(raw, vectors.binding, null)).toEqual(JSON.parse(raw));
  });
  test.each(vectors.valid)("literal $name also parses without the page's cards", ({ record: value }) => {
    expect(parseSummaryRecord(JSON.stringify(value), vectors.binding, null)).toEqual(value);
  });
  // Both readers run these and give every row the same answer (tests/summary.rs).
  test.each(vectors.storedKeys)("stored key syntax, with no trim: $name", ({ raw, accepted }) => {
    expect(parseSummaryRecord(raw, vectors.binding, null) !== null).toBe(accepted);
  });
  test("a lone surrogate in a key is refused even when a card holds that key", () => {
    const rows = vectors.storedKeys.filter((row) => row.name.startsWith("lone "));
    expect(rows).toHaveLength(4);
    for (const { raw } of rows) {
      const record = JSON.parse(raw) as SummaryRecord;
      const holding = [{ key: record.projects[0]!.key, label: "Held" }];
      expect(parseSummaryRecord(raw, vectors.binding, holding)).toBeNull();
      expect(serializeSummaryRecord(record, holding)).toBeNull();
    }
  });
  test.each(vectors.dates)("the valid-date rule both readers apply: $date", ({ date, valid }) => {
    const named = () => summaryRecordPath("/briefings", { ...vectors.binding, pageDate: date });
    if (valid) expect(named()).toContain(date);
    else expect(named).toThrow();
  });
  test("the vector lists are whole: the 64-entry record is members only and the cap vector holds 65 distinct members", () => {
    const entries = JSON.parse(vectors.invalid.find((v) => v.name === "too many entries")!.raw).projects as SummaryRecord["projects"];
    const members = new Set(cards.map((card) => card.key));
    expect(entries).toHaveLength(65);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(65);
    expect(entries.every((entry) => members.has(entry.key))).toBe(true);
    expect(vectors.valid.find((v) => v.name === "64 entries")!.record.projects).toHaveLength(64);
    expect(vectors.invalid.some((v) => v.name === "unknown card")).toBe(false);
  });
  test("JSON field order is immaterial when every stored field and value is valid", () => {
    const reordered = { ...ready, projects: ready.projects.map(({ key, points }) => ({ points, key })) };
    expect(parseSummaryRecord(JSON.stringify(reordered), vectors.binding, cards)).toEqual(ready);
  });
  test("date, lowercase identities and exact basename binding are mandatory", () => {
    for (const mutation of [{ pageDate: "2026-02-30" }, { pageDate: "2026-1-11" }, { pageHash: "A".repeat(64) }, { pageVersion: "../escape" }]) {
      expect(serializeSummaryRecord({ ...ready, ...mutation }, cards)).toBeNull();
      expect(() => summaryRecordPath(scratch(), { ...vectors.binding, ...mutation })).toThrow();
    }
    expect(parseSummaryRecord(JSON.stringify(ready), { ...vectors.binding, pageDate: "2026-01-12" }, cards)).toBeNull();
    expect(parseSummaryRecord(JSON.stringify(ready), { ...vectors.binding, pageHash: "c".repeat(64) }, cards)).toBeNull();
    expect(parseSummaryRecord(JSON.stringify(ready), { ...vectors.binding, pageVersion: "d".repeat(64) }, cards)).toBeNull();
  });
  test("entire UTF-8 record cap is inclusive, and includes whitespace and diagnostics", () => {
    const raw = JSON.stringify(ready);
    const atCap = raw + " ".repeat(65536 - Buffer.byteLength(raw));
    expect(parseSummaryRecord(atCap, vectors.binding, cards)).toEqual(ready);
    expect(parseSummaryRecord(atCap + " ", vectors.binding, cards)).toBeNull();
    expect(parseSummaryRecord(atCap + "🦀", vectors.binding, cards)).toBeNull();
    const key = "project:" + "x".repeat(65536);
    expect(serializeSummaryRecord({ ...ready, projects: [{ key, points: ["Safe point"] }] }, [{ key, label: "large" }])).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("bound atomic storage", () => {
  test("pending then ready uses mode 0600 and only the exact final filename", async () => {
    const { dir, page, binding } = await setup();
    expect(await writeSummaryRecord(dir, page, record(binding, "pending"), cards)).toBe(true);
    expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "pending"));
    const rename = spyOn(fs, "rename");
    try {
      expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards)).toBe(true);
      const call = rename.mock.calls[0]!;
      expect(String(call[0])).toMatch(new RegExp(`\\.summary\\.${process.pid}\\.[0-9a-f]{32}\\.tmp$`));
      expect(call[1]).toBe(summaryRecordPath(dir, binding));
    } finally { rename.mockRestore(); }
    expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "ready"));
    // The bytes on disk are the store's own serialization, field for field in schema order.
    expect(await fs.readFile(summaryRecordPath(dir, binding), "utf8")).toBe(serializeSummaryRecord(record(binding, "ready"), cards)!);
    expect((await fs.stat(summaryRecordPath(dir, binding))).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual([`${binding.pageDate}.${binding.pageHash}.${binding.pageVersion}.summary.json`]);
    // Final records cannot be overwritten by a late second completion.
    expect(await writeSummaryRecord(dir, page, record(binding, "unavailable"), cards)).toBe(false);
  });

  test.each([false, true])("older work finishing last cannot attach after replacement (same bytes: %s)", async (sameBytes) => {
    const { root, dir, page, binding } = await setup();
    expect(await writeSummaryRecord(dir, page, record(binding, "pending"), cards)).toBe(true);
    await fs.writeFile(join(root, "replacement"), sameBytes ? "first page bytes" : "new page bytes");
    await fs.rename(join(root, "replacement"), page);
    const identity = await readPageIdentity(page);
    if (identity === null) throw new Error("Replacement fixture identity missing");
    const newer = { pageDate: binding.pageDate, ...identity };
    expect(newer.pageVersion).not.toBe(binding.pageVersion);
    expect(newer.pageHash === binding.pageHash).toBe(sameBytes);
    expect(await writeSummaryRecord(dir, page, record(newer, "pending"), cards)).toBe(true);
    expect(await writeSummaryRecord(dir, page, record(newer, "ready"), cards)).toBe(true);
    expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards)).toBe(false);
    expect(await readSummaryRecord(dir, newer, cards)).toEqual(record(newer, "ready"));
  });

  test("a missing or pruned pending record is never recreated, even if that page returns", async () => {
    const { dir, page, binding } = await setup();
    expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards)).toBe(false);
    expect(await writeSummaryRecord(dir, page, record(binding, "pending"), cards)).toBe(true);
    await pruneSummaryRecords(dir, { ...binding, pageVersion: "e".repeat(64) });
    expect(await fs.readdir(dir)).toEqual([]);
    expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards)).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  test("identity is checked again after the temp write and immediately before publication", async () => {
    const { root, dir, page, binding } = await setup();
    expect(await writeSummaryRecord(dir, page, record(binding, "pending"), cards)).toBe(true);
    const originalOpen = fs.open.bind(fs);
    const open = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        await fs.writeFile(join(root, "replacement"), "changed during final write");
        await fs.rename(join(root, "replacement"), page);
      }
      return handle;
    }) as typeof originalOpen);
    try { expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards)).toBe(false); }
    finally { open.mockRestore(); }
    expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "pending"));
    expect((await fs.readdir(dir)).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  test("malformed, capped, symlinked and non-file records are absent; unsafe writes are refused", async () => {
    const { root, dir, page, binding } = await setup();
    const path = summaryRecordPath(dir, binding);
    expect(await readSummaryRecord(dir, binding, cards)).toBeNull();
    for (const raw of ["{", padded(record(binding, "ready"), 65537), JSON.stringify({ ...record(binding, "ready"), extra: true })]) {
      await fs.writeFile(path, raw);
      expect(await readSummaryRecord(dir, binding, cards)).toBeNull();
    }
    // The same valid record one byte smaller reads, so nothing but the cap refused it above.
    await fs.writeFile(path, padded(record(binding, "ready"), 65536));
    expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "ready"));
    await fs.unlink(path);
    const target = join(root, "target");
    await fs.writeFile(target, JSON.stringify(record(binding, "pending")));
    await fs.symlink(target, path);
    expect(await readSummaryRecord(dir, binding, cards)).toBeNull();
    expect(await writeSummaryRecord(dir, page, record(binding, "pending"), cards)).toBe(false);
    expect(await fs.readFile(target, "utf8")).toBe(JSON.stringify(record(binding, "pending")));
    await fs.unlink(path); await fs.mkdir(path);
    expect(await readSummaryRecord(dir, binding, cards)).toBeNull();
    expect(await writeSummaryRecord(dir, page, record(binding, "pending"), cards)).toBe(false);
    const linkedDir = join(root, "linked-dir");
    await fs.symlink(dir, linkedDir);
    expect(await writeSummaryRecord(linkedDir, page, record(binding, "pending"), cards)).toBe(false);
  });

  test("a leading byte order mark on disk reaches the parser and is refused", async () => {
    const { dir, binding } = await setup();
    const raw = JSON.stringify(record(binding, "ready"));
    await fs.writeFile(summaryRecordPath(dir, binding), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)]));
    expect(await readSummaryRecord(dir, binding, cards)).toBeNull();
    await fs.writeFile(summaryRecordPath(dir, binding), raw);
    expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "ready"));
  });

  test("reading with cards: null applies every stored rule except membership", async () => {
    const { dir } = await setup();
    const path = summaryRecordPath(dir, vectors.binding);
    for (const { raw } of vectors.invalidMembership) {
      await fs.writeFile(path, raw);
      expect(await readSummaryRecord(dir, vectors.binding, cards)).toBeNull();
      expect(await readSummaryRecord(dir, vectors.binding, null)).toEqual(JSON.parse(raw));
    }
    for (const { raw } of vectors.invalid) {
      await fs.writeFile(path, raw);
      expect(await readSummaryRecord(dir, vectors.binding, null)).toBeNull();
    }
  });

  describe("the beforePublish gate", () => {
    async function pendingOnDisk() {
      const fixture = await setup();
      expect(await writeSummaryRecord(fixture.dir, fixture.page, record(fixture.binding, "pending"), cards)).toBe(true);
      return fixture;
    }
    const temps = async (dir: string) => (await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));

    test.each([
      ["false", () => false],
      ["a resolved false", async () => false],
      ["a throw", () => { throw new Error("gate failure"); }],
      ["a rejection", async () => { throw new Error("gate failure"); }],
    ] as [string, () => boolean | Promise<boolean>][])("%s publishes nothing and removes the temp file", async (_name, gate) => {
      const { dir, page, binding } = await pendingOnDisk();
      expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards, gate)).toBe(false);
      expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "pending"));
      expect(await temps(dir)).toEqual([]);
    });

    test("it runs before the final pending and identity checks, with the temp file written", async () => {
      const { dir, page, binding } = await pendingOnDisk();
      const rename = spyOn(fs, "rename");
      let calls = 0;
      try {
        expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards, async () => {
          calls++;
          expect(rename).not.toHaveBeenCalled();
          expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "pending"));
          const [temp] = await temps(dir);
          expect(await fs.readFile(join(dir, temp!), "utf8")).toBe(serializeSummaryRecord(record(binding, "ready"), cards)!);
          return true;
        })).toBe(true);
        expect(rename).toHaveBeenCalledTimes(1);
      } finally { rename.mockRestore(); }
      expect(calls).toBe(1);
      expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "ready"));
      expect(await temps(dir)).toEqual([]);
    });

    test("it still runs when the temp write changed the page; the final identity check then refuses it", async () => {
      const { root, dir, page, binding } = await pendingOnDisk();
      const originalOpen = fs.open.bind(fs);
      const open = spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof originalOpen>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith(".tmp")) {
          await fs.writeFile(join(root, "replacement"), "changed during final write");
          await fs.rename(join(root, "replacement"), page);
        }
        return handle;
      }) as typeof originalOpen);
      let calls = 0;
      try {
        expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards, () => { calls++; return true; })).toBe(false);
      } finally { open.mockRestore(); }
      expect(calls).toBe(1);
    });

    test.each(["page replacement", "pending pruning"])("an async gate's %s prevents publication", async (change) => {
      const { root, dir, page, binding } = await pendingOnDisk();
      expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards, async () => {
        if (change === "page replacement") {
          await fs.writeFile(join(root, "replacement"), "a newer page");
          await fs.rename(join(root, "replacement"), page);
        } else await fs.unlink(summaryRecordPath(dir, binding));
        return true;
      })).toBe(false);
      expect(await readSummaryRecord(dir, binding, cards)).toEqual(change === "page replacement" ? record(binding, "pending") : null);
      expect(await temps(dir)).toEqual([]);
    });

    test("the synchronous clock gate runs after the final identity read, immediately before rename", async () => {
      const { dir, page, binding } = await pendingOnDisk();
      let checks = 0;
      const rename = spyOn(fs, "rename");
      try {
        expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards, async () => true, () => {
          checks++;
          expect(rename).not.toHaveBeenCalled();
          return false;
        })).toBe(false);
        expect(checks).toBe(1);
        expect(rename).not.toHaveBeenCalled();
      } finally { rename.mockRestore(); }
      expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "pending"));
      expect(await temps(dir)).toEqual([]);
    });

    test("without a gate, publication is unchanged", async () => {
      const { dir, page, binding } = await pendingOnDisk();
      expect(await writeSummaryRecord(dir, page, record(binding, "ready"), cards)).toBe(true);
      expect(await readSummaryRecord(dir, binding, cards)).toEqual(record(binding, "ready"));
    });
  });

  test("record reads use capped no-follow descriptors and refuse a changed read", async () => {
    const { dir, binding } = await setup();
    const path = summaryRecordPath(dir, binding);
    await fs.writeFile(path, JSON.stringify(record(binding, "ready")));
    const handle = await fs.open(path, "r");
    const realStat = handle.stat.bind(handle);
    const stat = spyOn(handle, "stat").mockImplementationOnce(realStat).mockImplementationOnce((async (...args: Parameters<typeof realStat>) => {
      await fs.appendFile(path, " "); return realStat(...args);
    }) as typeof realStat);
    const open = spyOn(fs, "open").mockResolvedValue(handle);
    try {
      expect(await readSummaryRecord(dir, binding, cards)).toBeNull();
      expect(open.mock.calls[0]?.[1]).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } finally { open.mockRestore(); stat.mockRestore(); await handle.close(); }
  });
});

describe.skipIf(process.platform === "win32")("the standalone handoff producer's start check", () => {
  const producer = new URL("../gui/src-tauri/tests/fixtures/summary-roundtrip.ts", import.meta.url).pathname;
  // A temp HOME or none at all: the producer must stop on this alone, before any write or engine import.
  test.each([["elsewhere", (home: string) => home], ["absent", () => undefined]] as [string, (home: string) => string | undefined][])(
    "refuses, writing nothing, when HOME is %s rather than <root>/home",
    (_name, homeFor) => {
      const root = realpathSync(scratch());
      const env: Record<string, string | undefined> = { ...process.env, DBA_SUMMARY_ROUNDTRIP_DIR: root, HOME: homeFor(realpathSync(scratch())) };
      if (env.HOME === undefined) delete env.HOME;
      const child = Bun.spawnSync([process.execPath, producer, "engine-write", root], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
      // Anchored on the error line: Bun also prints nearby source, which names this sentence for other throws.
      expect(child.stderr.toString()).toMatch(/^error: summary-handoff: HOME must be <root>\/home in the start environment$/mu);
      expect(child.exitCode).not.toBe(0);
      expect(child.stdout.toString()).toBe("");
      expect(readdirSync(root)).toEqual([]);
    },
  );

  // Past the HOME check: the after-run check needs the real home by name, and Bun's cache must stay out of the root.
  test.each([
    ["the transpiler cache on", (root: string) => ({ DBA_SUMMARY_REAL_HOME: "/unused-real-home", BUN_RUNTIME_TRANSPILER_CACHE_PATH: undefined, root }), /^error: summary-handoff: BUN_RUNTIME_TRANSPILER_CACHE_PATH must be 0$/mu],
    ["no real home", (root: string) => ({ DBA_SUMMARY_REAL_HOME: undefined, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", root }), /^error: summary-handoff: DBA_SUMMARY_REAL_HOME must be an absolute path outside the root$/mu],
    ["a relative real home", (root: string) => ({ DBA_SUMMARY_REAL_HOME: "home", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", root }), /^error: summary-handoff: DBA_SUMMARY_REAL_HOME must be an absolute path outside the root$/mu],
    ["a real home inside the root", (root: string) => ({ DBA_SUMMARY_REAL_HOME: join(root, "home"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", root }), /^error: summary-handoff: DBA_SUMMARY_REAL_HOME must be an absolute path outside the root$/mu],
  ] as [string, (root: string) => { DBA_SUMMARY_REAL_HOME: string | undefined; BUN_RUNTIME_TRANSPILER_CACHE_PATH: string | undefined; root: string }, RegExp][])(
    "refuses, with no state written, on %s",
    (_name, varsFor, message) => {
      const root = realpathSync(scratch());
      const { root: _root, ...vars } = varsFor(root);
      const env: Record<string, string | undefined> = { ...process.env, DBA_SUMMARY_ROUNDTRIP_DIR: root, HOME: join(root, "home"), ...vars };
      for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
      const child = Bun.spawnSync([process.execPath, producer, "engine-write", root], { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
      expect(child.stderr.toString()).toMatch(message);
      expect(child.exitCode).not.toBe(0);
      expect(child.stdout.toString()).toBe("");
      expect(readdirSync(root).filter((n) => n !== "home")).toEqual([]);
    },
  );
});

describe.skipIf(process.platform === "win32")("same-date pruning", () => {
  test("only obsolete regular records and confirmed-dead-owner temps go", async () => {
    const { root, dir, binding } = await setup();
    const old = { ...binding, pageVersion: "e".repeat(64) };
    const oldBase = summaryRecordPath(dir, old).slice(0, -"json".length);
    const names = {
      current: summaryRecordPath(dir, binding), old: summaryRecordPath(dir, old),
      otherDate: summaryRecordPath(dir, { ...old, pageDate: "2026-01-10" }),
      page: join(dir, "2026-01-11.md"),
      dead: `${oldBase}12341.${"a".repeat(32)}.tmp`,
      reused: `${oldBase}12342.${"b".repeat(32)}.tmp`,
      denied: `${oldBase}12343.${"c".repeat(32)}.tmp`,
      unknown: `${oldBase}12344.${"d".repeat(32)}.tmp`,
      currentTemp: summaryRecordPath(dir, binding).replace(/json$/, `12341.${"e".repeat(32)}.tmp`),
      malformed: `${oldBase}012341.${"a".repeat(32)}.tmp`,
      hugePid: `${oldBase}999999999999999999999.${"a".repeat(32)}.tmp`,
      badNonce: `${oldBase}12341.ABC.tmp`,
      invalidDate: join(dir, `2026-02-30.${old.pageHash}.${old.pageVersion}.summary.json`),
    };
    for (const path of Object.values(names)) await fs.writeFile(path, "untouched bytes");
    const link = summaryRecordPath(dir, { ...old, pageHash: "f".repeat(64) });
    const target = join(root, "outside-record"); await fs.writeFile(target, "target"); await fs.symlink(target, link);
    const directory = summaryRecordPath(dir, { ...old, pageHash: "d".repeat(64) }); await fs.mkdir(directory);
    const kill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(signal).toBe(0);
      if (pid === 12342) return true; // A reused PID is indistinguishable from a live owner.
      throw Object.assign(new Error("fixture"), { code: pid === 12341 ? "ESRCH" : pid === 12343 ? "EPERM" : "EIO" });
    });
    try {
      await pruneSummaryRecords(dir, binding);
      expect(kill.mock.calls.map((c) => c[0]).sort()).toEqual([12341, 12342, 12343, 12344]);
    } finally { kill.mockRestore(); }
    for (const [key, path] of Object.entries(names)) {
      if (key === "old" || key === "dead") expect(await fs.lstat(path).catch(() => null)).toBeNull();
      else expect(await fs.readFile(path, "utf8")).toBe("untouched bytes");
    }
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(directory)).isDirectory()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("target");
  });

  describe("a prune told to stop", () => {
    async function threeSuperseded() {
      const fixture = await setup();
      for (const v of ["1", "2", "3"]) await fs.writeFile(summaryRecordPath(fixture.dir, { ...fixture.binding, pageVersion: v.repeat(64) }), "old");
      return fixture;
    }

    test("stopping mid-way removes no more", async () => {
      const { dir, binding } = await threeSuperseded();
      await pruneSummaryRecords(dir, binding, () => readdirSync(dir).length < 3);
      expect(readdirSync(dir)).toHaveLength(2);
    });

    test("stopped once the listing is read, it looks at no entry", async () => {
      const { dir, binding } = await threeSuperseded();
      const lstat = spyOn(fs, "lstat");
      try {
        await pruneSummaryRecords(dir, binding, () => true);
        expect(lstat.mock.calls.map((c) => String(c[0]))).toEqual([dir]);       // the folder's own check, nothing inside it
      } finally { lstat.mockRestore(); }
      expect(readdirSync(dir)).toHaveLength(3);
    });

    test("never told to stop, it removes them all", async () => {
      const { dir, binding } = await threeSuperseded();
      await pruneSummaryRecords(dir, binding, () => false);
      expect(readdirSync(dir)).toEqual([]);
    });
  });
});
