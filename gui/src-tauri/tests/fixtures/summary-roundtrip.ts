// Standalone runtime handoff producer: the real job and store with an injected fake provider (T9). It never calls
// `run()` or `runBriefing`, so it reaches no update check, notification or real provider.
// Built-ins only at startup: engine modules are imported after explicit isolation.
import { lstatSync, promises as fs, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const inheritedEnv = { ...process.env };
const inheritedHome = homedir();
const HANDOFF_DATE = "2026-01-11";
const [mode, rootArg, ...extra] = process.argv.slice(2);
const requiredRoot = process.env.DBA_SUMMARY_ROUNDTRIP_DIR;
if (mode !== "engine-write" || extra.length !== 0 || !rootArg || !requiredRoot || rootArg !== requiredRoot || !isAbsolute(rootArg)) {
  throw new Error("summary-handoff: an explicit matching test root is required");
}

const root = realpathSync(rootArg);
const under = (base: string, path: string): boolean => {
  const rel = relative(base, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
// Only an empty, canonical, same-user directory under a real temp location is caller-owned; an
// arbitrary HOME/state/config directory never qualifies. No mode test: the SUMMARY_HANDOFF leg makes
// its root with a plain `mkdir` inside its private mktemp directory, so the root itself is umask-mode.
const rootStat = lstatSync(rootArg);
const tempBases = [realpathSync(tmpdir()), realpathSync("/tmp")];
if (root !== resolve(rootArg) || !rootStat.isDirectory() || rootStat.isSymbolicLink()
  || typeof process.getuid !== "function" || rootStat.uid !== process.getuid()
  || !tempBases.some((base) => under(base, root)) || readdirSync(root).length !== 0) {
  throw new Error("summary-handoff: root must be an empty test-owned temp directory");
}
// Bun's homedir() follows only a HOME present at process start, never a later assignment, so the leg
// starts this file with HOME=<root>/home. Anything else stops here: no write and no engine import yet.
if (inheritedHome !== join(root, "home")) {
  throw new Error("summary-handoff: HOME must be <root>/home in the start environment");
}
// With HOME in the root, Bun's transpile cache would land there before this file runs, once the source is large.
if (process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== "0") {
  throw new Error("summary-handoff: BUN_RUNTIME_TRANSPILER_CACHE_PATH must be 0");
}
// homedir() now names the sandbox, so the after-run check gets the real home by name.
const realHome = process.env.DBA_SUMMARY_REAL_HOME;
if (!realHome || !isAbsolute(realHome) || realHome === root || under(root, realHome)) {
  throw new Error("summary-handoff: DBA_SUMMARY_REAL_HOME must be an absolute path outside the root");
}

const writes: string[] = [];
function assertDestination(path: string): void {
  if (!isAbsolute(path) || !under(root, path)) throw new Error("summary-handoff: outside write refused");
  // Resolve every existing component, including a destination that already exists.
  // A symlink escape is refused before a mkdir/open/rename, not just in the final scan.
  let ancestor = path;
  for (;;) {
    try {
      const resolved = realpathSync(ancestor);
      if (resolved !== root && !under(root, resolved)) throw new Error("summary-handoff: symlink escape refused");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // A dangling symlink also has no realpath, but is never a missing component.
      try {
        if (lstatSync(ancestor).isSymbolicLink()) throw new Error("summary-handoff: dangling symlink refused");
      } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
      ancestor = dirname(ancestor);
    }
  }
}
function noteWrite(path: string): void {
  assertDestination(path);
  if (writes.length >= 64) throw new Error("summary-handoff: write ledger limit exceeded");
  writes.push(path);
}
async function directory(path: string): Promise<void> {
  noteWrite(path); await fs.mkdir(path, { recursive: true, mode: 0o700 });
}
async function write(path: string, text: string): Promise<void> {
  noteWrite(path); await fs.writeFile(path, text, { flag: "wx", mode: 0o600 });
}

// Assignments deliberately override even inherited explicit state/config/temp values.
process.env.DAILY_BRIEFING_STATE_DIR = join(root, "state");
process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.DBA_TEST_UNIT_DIR = join(root, "units");
process.env.TMPDIR = join(root, "tmp");
for (const name of ["state", "xdg", "home", "units", "tmp"]) await directory(join(root, name));

const { stampToday, stateDirFor } = await import("../../../../src/marker");
const { statePaths, statusReport } = await import("../../../../src/json");
const { readPageIdentity } = await import("../../../../src/summary/page-version");
const { summaryCardsFromPage } = await import("../../../../src/summary/cards");
const { runSummaryJob } = await import("../../../../src/summary/job");
const { readSummaryRecord, summaryRecordPath } = await import("../../../../src/summary/store");

const realState = stateDirFor(process.platform, inheritedEnv, realHome);
const realConfig = join(inheritedEnv.XDG_CONFIG_HOME ?? join(realHome, ".config"), "daily-briefing", "config.json");
async function realMetadata(): Promise<string> {
  const config = await fs.lstat(realConfig, { bigint: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null; throw e;
  });
  const names = await fs.readdir(join(realState, "briefings")).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return []; throw e;
  });
  return JSON.stringify({
    config: config === null ? null : [config.dev, config.ino, config.mode, config.size, config.mtimeNs, config.ctimeNs].map(String),
    summaries: names.filter((name) => name.includes(".summary")).sort(),
  });
}
const before = await realMetadata();
const paths = statePaths();
for (const path of [paths.configPath, paths.markerPath, paths.latestBriefingPath, paths.briefingsDir]) assertDestination(path);
await directory(dirname(paths.configPath));
await directory(paths.briefingsDir);
await write(paths.configPath, JSON.stringify({
  provider: { cli: "summary-handoff-never-run", argv: [], promptVia: "stdin" },
  aiSummary: { enabled: true },
}));

// The real marker writer uses Bun.write. Its one resolved destination is in the ledger.
noteWrite(paths.markerPath);
await stampToday(HANDOFF_DATE);
const page = `☀️  Daily briefing — ${HANDOFF_DATE}  (this machine: fixture)\n`
  + "▶ Where you left off\n   • [Orchard] Finish the harvest view\n"
  + "▶ What you did\n   • [Orchard] Added the fallback point\n"
  + "▶ Suggested next\n   • [Orchard] Check the harvest view\n";
await write(paths.latestBriefingPath, page);
const identity = await readPageIdentity(paths.latestBriefingPath);
if (identity === null) throw new Error("summary-handoff: fixture identity unavailable");
const cards = summaryCardsFromPage(page);
const HANDOFF_PROJECTS = [{ key: "project:orchard", points: ["Harvest view storage handoff is ready."] }];
const HANDOFF_SENTENCE = "The orchard handoff is ready for the next pass.";
let sent = 0;
const fakeProvider = {
  // The page travels as data inside the prompt, less the computer's name: anything else is a producer failure, as an
  // empty record would be.
  generate: async (prompt: string) => {
    sent++;
    if (!prompt.includes(page.replace("  (this machine: fixture)", "")) || prompt.includes("this machine: ")) throw new Error("summary-handoff: the fake provider did not receive the page");
    return JSON.stringify({ projects: HANDOFF_PROJECTS, goodMorningSentence: HANDOFF_SENTENCE });
  },
};

// Observe the actual store temp/final destinations rather than predicting its nonce.
const originalOpen = fs.open.bind(fs), originalRename = fs.rename.bind(fs);
const originalMkdir = fs.mkdir.bind(fs), originalUnlink = fs.unlink.bind(fs);
fs.open = (async (...args: Parameters<typeof originalOpen>) => {
  if (typeof args[1] === "string" && /[wax+]/u.test(args[1])) noteWrite(String(args[0]));
  return originalOpen(...args);
}) as typeof fs.open;
fs.rename = async (from, to) => { assertDestination(String(from)); noteWrite(String(to)); await originalRename(from, to); };
fs.mkdir = (async (...args: Parameters<typeof originalMkdir>) => {
  noteWrite(String(args[0])); return originalMkdir(...args);
}) as typeof fs.mkdir;
fs.unlink = async (path) => { noteWrite(String(path)); await originalUnlink(path); };
const binding = { pageDate: HANDOFF_DATE, ...identity };
const T = 30_000;
const startedAt = performance.now();
const deadline = startedAt + T;
const controller = new AbortController();
try {
  await runSummaryJob({
    page, date: HANDOFF_DATE, identity, emptyWindow: false, startedAt, deadline, workCutoff: deadline - Math.min(5_000, T), controller,
    seed: {
      // Never run: the fake provider above is the transport.
      winner: { provider: { cli: "summary-handoff-never-run", argv: [], promptVia: "stdin" } },
      morningLocked: false,
      calendarCapture: { unlockedBlock: null, hasEvents: false },
    },
  }, cards, { provider: fakeProvider });
  const stored = await readSummaryRecord(paths.briefingsDir, binding, cards);
  if (sent !== 1 || stored?.state !== "ready" || JSON.stringify(stored.projects) !== JSON.stringify(HANDOFF_PROJECTS)
    || stored.goodMorningSentence !== HANDOFF_SENTENCE || stored.warnings.length !== 0) throw new Error("summary-handoff: stored values differ");
} finally {
  controller.abort();
  fs.open = originalOpen; fs.rename = originalRename; fs.mkdir = originalMkdir; fs.unlink = originalUnlink;
}
if (!writes.includes(summaryRecordPath(paths.briefingsDir, binding))) throw new Error("summary-handoff: the final sidecar is not in the write ledger");

const receipt = { HANDOFF_DATE, ...identity, projects: HANDOFF_PROJECTS, goodMorningSentence: HANDOFF_SENTENCE };
function scan(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    assertDestination(path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("summary-handoff: unexpected symlink");
    if (stat.isDirectory()) scan(path);
  }
}
scan(root);
for (const path of writes) assertDestination(path);
if (before !== await realMetadata()) throw new Error("summary-handoff: inherited real locations changed");
await write(join(root, "page-receipt.json"), JSON.stringify(receipt));
// R5-M5: the real status report, in this process, after the sidecar landed. T10 adds its summary members.
await write(join(root, "status-report.json"), JSON.stringify(await statusReport()));
for (const path of writes) assertDestination(path);
console.log(JSON.stringify(receipt));
console.log("summary-handoff: page ok");
