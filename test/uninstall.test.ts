// test/uninstall.test.ts — scripts/uninstall.sh: the background scheduler, which it hands to a new enough
// engine first or else checks read-only and stops (Batch 2, spec 3.6.6), and the opt-in
// --remove-signing-identity flag (Phase E, E10).
//
// ⚠ NOTHING HERE MAY REACH THE REAL KEYCHAIN, LAUNCHD OR INSTALLED BINARY. Every run is boxed in four ways,
// and `run()` asserts the first two before it spawns anything:
//   • PATH is ONE scratch directory holding recording stubs for the keychain tool, launchd's tool and pmset,
//     plus links to the two real utilities the script needs (rm, grep). The real binaries are not on PATH
//     at all, so a stub that went missing would be "command not found", never the real thing. launchd's
//     stub runs nothing: it records its argv and answers the two read-only verbs (`print`, `list`) per
//     case, "Could not find service" with exit 113 by default; any other verb is recorded and refused, and
//     `run()` fails a case that sent one.
//   • DBA_TEST_DIR, DBA_TEST_PLIST and DBA_TEST_KEYCHAIN point at scratch paths (the keychain INSIDE
//     DBA_TEST_DIR, which the script requires), and HOME is scratch. The cases that test the keychain
//     variable's own validation pass a bad value or omit DBA_TEST_DIR on purpose; the stub PATH and the
//     scratch HOME still box them, and each asserts the script refused before calling anything.
//   • The default fixture writes NO plist (spec 3.6.6). The cases that need one write a label-less
//     `<plist/>`, so nothing could name a live job even if something read it.
//   • The "managed binary" at $DBA_TEST_DIR/daily-briefing is a link to a VERB-AWARE stub engine outside
//     PATH: `schedule status --json` prints a status with or without `removeSteps` (a new enough engine,
//     or an older one), `schedule uninstall` prints its stdout line and exits with the case's code (0 also
//     unlinks the record, as the engine does). It APPENDS one line per call — argv, HOME, state dir and
//     DBA_TEST_UNIT_DIR — and `run()` asserts every call carried the scratch unit folder (spec 3.1.3).
//     The script runs it only once a static read of its TEXT finds the word removeSteps (spec 16, the M7
//     build correction: an engine built before 2026-07-15 ran a briefing for any first argument but
//     `init`), so the stub's text carries the word, and `run()` asserts that the script ran the managed
//     binary only in cases whose binary carried it. The "wordless" stub lacks it and must never run.
// What is left decides parity (M9 round 4): the support dir is seeded with every name the desktop app's
// ENGINE_STATE_REMOVALS removes and with SURVIVORS no list names, so a run that carries on must remove
// exactly the first, and a stop nothing at all.
// The two binary names are built by concatenation: test/isolation.meta.test.ts flags any literal that
// names them in command position, and this file adds no exemption. The engine imports are the PURE
// manual-steps function, which the printed-steps pin compares the script's stderr with, and the label
// constant (src/schedule/units.ts, which imports nothing), which the label pin compares the script's with.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import {
  chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { manualRemoveSteps } from "../src/schedule/install";
import { SCHEDULE_LABEL } from "../src/schedule/units";
import { stripComments } from "./helpers/importClosure";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
// Spelled as one literal so test/isolation.meta.test.ts's INSTALLER_REDIRECTABLE scan sees this spawn and
// holds it to DBA_TEST_DIR + DBA_TEST_PLIST (it reads code, not comments).
const SCRIPT = join(ROOT, "scripts/uninstall.sh");
const BASH = Bun.which("bash")!;
const KEYCHAIN_TOOL = "sec" + "urity";
const LAUNCHD_TOOL = "launch" + "ctl";
const SIGN_ID = "Daily Briefing (local) Signing";
const FLAG = "--remove-signing-identity";
const LABEL = "local.daily-briefing";
const UID = process.getuid!();
/** Everything uninstall.sh removes from the support dir, created first so removal is meaningful. */
const ARTIFACTS = [
  "daily-briefing", "wake-schedule.json", "briefing.log", "briefing-latest.md",
  "briefing.log.1", "transcript-health.json", "audit-2026-07-30.md", "audit-2026-07-31.md",
  "update-check.json",   // Phase E (E11): the opt-in update check's record
  // Batch 2 (spec 3.5.1): the rest of what the engine owns at the state root.
  "last-run", "last-tick", "last-skip.json", "run.lock", "account-state.json", "recap-campaigns.jsonl",
];
/** …and the two folders it removes with their contents: the archive and the provider's scratch folder. */
const DIRS = ["briefings", "provider-cwd"];
/** M9 round 4 (S1b): what `fixture()` also plants in the support dir that NO removal list names — an unlisted
 *  file (named like the audit glob, outside it), an unlisted folder with nested content, and a dotfile — as
 *  `entryAt` reads them. Every run must leave them byte for byte (`left`, `ALL_REMOVED`, `nothingRemoved`), so
 *  a run that removes MORE than the list — an ANSI-C quoted command word, an eval, `rm -rf "$SUPPORT"` —
 *  fails every case that carries on, whatever the static parse in gui/src-tauri/tests/uninstall.rs saw.
 *
 *  M9 LOW pass (L12): and NEAR MISSES, one or more per listed family, so a glob widened INSIDE a family —
 *  `"$SUPPORT"/briefing*`, `last-*`, `*.md`, `run.lock*`, `provider-cwd*`, `audit-*.md*` — removes one and fails
 *  `ALL_REMOVED` too, where the three above sat outside every family and could not see it. The pin "the fixture
 *  seeds exactly …" holds that no list entry matches any of them. `fixture()` seeds them FROM THIS MAP (`seed`),
 *  so the map and the disk cannot differ. */
const SURVIVORS: Record<string, string | Record<string, string | null>> = {
  "audit-notes.txt": "file: unlisted, named like the audit glob but outside it",
  ".unlisted-dotfile": "file: a dotfile no list names",
  "unlisted-folder": {
    "inside.md": "file: an unlisted folder",
    nested: "dir",
    [join("nested", "deeper.md")]: "file: an unlisted folder, one level down",
  },
  // Near misses (L12), by the family each sits beside.
  "briefing-notes.txt": "file: beside briefing.log and briefing-latest.md, in neither",
  "briefings.old": {
    "2026-08-14.md": "file: beside the briefings archive, not it",
    nested: "dir",
    [join("nested", "deeper.md")]: "file: beside the briefings archive, one level down",
  },
  "last-run.bak": "file: beside last-run",
  "notes.md": "file: a .md outside the audit glob",
  "audit-2026-07-30.md.bak": "file: named like an audit report, past the glob's .md",
  "run.lock.d": "file: beside run.lock",
  "provider-cwd-old": {
    "inside.md": "file: beside the provider's scratch folder, not it",
  },
};

/** Plants `SURVIVORS` in `support`, from the map: a string is a file (`file: <bytes>`), a map a folder whose
 *  entries are `tree`'s (`dir`, or `file: <bytes>`), each folder before what is in it. */
function seed(support: string): void {
  for (const [name, entry] of Object.entries(SURVIVORS)) {
    const at = join(support, name);
    if (typeof entry === "string") {
      expect(entry.startsWith("file: ")).toBe(true);
      writeFileSync(at, entry.slice("file: ".length));
      continue;
    }
    mkdirSync(at);
    for (const [rel, what] of Object.entries(entry)) {
      if (what === "dir") mkdirSync(join(at, rel), { recursive: true });
      else {
        expect(what?.startsWith("file: ")).toBe(true);
        writeFileSync(join(at, rel), what!.slice("file: ".length));
      }
    }
  }
}

/** M9 round 4 (S1a): one entry of the desktop app's consented engine-state list. */
interface EngineEntry { token: string; kind: "File" | "Glob" | "Dir" }
/** That list — `ENGINE_STATE_REMOVALS` in gui/src-tauri/src/uninstall.rs, read as TEXT with its `//` comments
 *  stripped (this file imports no Rust), the way the PLIST pin below reads `DELETER_WORDS`. The Rust parity
 *  parse holds it token for token to the script's own list; the pin "the fixture seeds exactly …" holds the
 *  fixture's seeded names to it, so a run that stops removing ANY listed name fails `ALL_REMOVED`. */
function rustEngineList(): EngineEntry[] {
  const src = readFileSync(join(ROOT, "gui/src-tauri/src/uninstall.rs"), "utf8");
  const start = src.indexOf("pub const ENGINE_STATE_REMOVALS: &[EngineEntry] = &[");
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n];", start)).replace(/\/\/[^\n]*/g, "");
  const entries = [...block.matchAll(/EngineEntry \{\s*token: "([^"]+)",\s*kind: EntryKind::(File|Glob|Dir),\s*\}/g)]
    .map((m) => ({ token: m[1]!, kind: m[2] as EngineEntry["kind"] }));
  // Every entry in the block is read: none in a shape the pattern would skip.
  expect(entries.length).toBe(block.split("EngineEntry {").length - 1);
  return entries;
}
/** Whether `name`, a direct child of the support dir, is what `e` removes: the name itself, or a one-star
 *  glob's match (the Rust list pins one star per glob). */
function matchesEntry(e: EngineEntry, name: string): boolean {
  if (e.kind !== "Glob") return e.token === name;
  const parts = e.token.split("*");
  expect(parts.length).toBe(2);
  const [pre, post] = parts as [string, string];
  return name.length >= pre.length + post.length && name.startsWith(pre) && name.endsWith(post);
}

/** The app's own Schedule-screen button, as the app names it: `REMOVE_SCHEDULE_BUTTON` in
 *  gui/src/lib/app-uninstall.ts, read as TEXT (this file imports no webview code), the way the PLIST pin reads
 *  Rust's `DELETER_WORDS` — so the script's way out cannot drift from the button's label (M9 LOW pass, L15).
 *  That constant is itself pinned to the rendered button in gui/tests-web/coexistence.check.ts. */
function removeScheduleButton(): string {
  const src = readFileSync(join(ROOT, "gui/src/lib/app-uninstall.ts"), "utf8");
  const hits = [...src.matchAll(/^export const REMOVE_SCHEDULE_BUTTON = "([^"]+)";$/gm)];
  expect(hits.length).toBe(1);
  return hits[0]![1]!;
}

/** The script's own closing line after the manual steps (spec 3.1.8 "Framing"). */
const SCRIPT_CLOSING = "Then run this script again.";
/** The engine's `--invoker cli` closing line, which the script replaces in place (spec 3.6.6). Pinned to
 *  the engine's source text below, read as data: this file imports no other text from the engine. */
const CLI_CLOSING = "Then run `daily-briefing schedule uninstall` again.";
const APP_LEAD = "Remove it on the app's Schedule screen, if the app is still installed.";
// The installer's path is split: test/isolation.meta.test.ts bans any file that names it (it would
// reload the live agent if run), and this is only the text the script prints.
const UPDATE_HINT = "Or update the engine with scripts/" + "install.sh, which re-installs the background schedule and may generate a briefing, then run this again.";
/** How the no-new-enough refusals end their list of reasons: the branch also covers a new engine whose
 *  status read failed or printed nothing (Checkpoint M7 F9). */
const NOT_NEW_ENOUGH = "too old, or could not report its status";
const SETTINGS_KEPT = "Kept your settings folder, ~/.config/daily-briefing: this script never removes it, and it may hold your API key file.";
/** The engine's manual steps for the DEFAULT macOS paths — the text the script prints (spec 3.6.6). The
 *  output does not depend on the home it is computed against: every path under it is written "$HOME"/'…'. */
const STEPS_HOME = "/Users/steps-pin";
const STEPS = manualRemoveSteps("launchd", {
  units: [join(STEPS_HOME, "Library", "LaunchAgents", `${LABEL}.plist`)],
  record: join(STEPS_HOME, "Library", "Application Support", "daily-briefing", "schedule.json"),
  home: STEPS_HOME,
});
/** The one-shot read-only check, in order, once each: no polling, no other verb (spec 3.6.6). */
const READ_ONLY_CHECK = [["print", `gui/${UID}/${LABEL}`], ["print", `user/${UID}/${LABEL}`], ["list", LABEL]];
const NOT_FOUND = "Could not find service in domain for port";
const NO_DOMAIN = "Could not find domain for port";

/** A record in writeScheduleRecord's own format: pretty-printed, with a trailing newline. */
const prettyRecord = (owner: "app" | "cli") => `${JSON.stringify({
  owner, invoker: owner, kind: "launchd", unitPath: "/nowhere/agent.plist", binPath: "/nowhere/daily-briefing",
  installedAt: "2026-10-05T07:00:00.000Z", engineVersion: "0.2.1",
}, null, 2)}\n`;

interface Fx {
  base: string; support: string; plist: string; home: string; keychain: string; calls: string; managedLog: string; record: string;
  /** The support-dir artifacts this fixture actually created, each as `snapshot` read it BEFORE any run (the
   *  managed binary's shape depends on the case): what a run that removes nothing must leave, byte for byte —
   *  M9 LOW pass (L11), where existence alone let a stop that truncated or replaced a state file pass. */
  artifactsBefore: Record<string, string>;
  /** The two scheduler files as the fixture made them, taken BEFORE any run (`snapshot`): what a run that
   *  removes nothing must leave, byte for byte. Never read back from after the run (Checkpoint M7 F6). */
  plistBefore: string | null; recordBefore: string | null;
  /** The two removed folders' CONTENTS as the fixture made them (`tree`), taken before any run the same way:
   *  a stop that emptied one would still leave the folder, so its existence alone proves nothing (M9 round 1). */
  dirsBefore: Record<string, Record<string, string | null>>;
  managedRc: number | null; keychainRc: number;
}

/** The managed binary's path, where the script looks for it ($SUPPORT/daily-briefing). */
const binOf = (fx: Fx) => join(fx.support, "daily-briefing");

/** What is at `p` without following it or opening it (a FIFO is never read): null when lstat finds nothing,
 *  else its kind and, for a regular file its bytes, for a link its target. */
function snapshot(p: string): string | null {
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return `link -> ${readlinkSync(p)}`;
  if (st.isFIFO()) return "fifo";
  if (st.isFile()) return `file: ${readFileSync(p, "utf8")}`;
  return st.isDirectory() ? "dir" : "other";
}

/** A folder's contents, recursively: each entry's path under it → its `snapshot`. A link is not followed. */
function tree(dir: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const at = rel === "" ? name : join(rel, name);
      out[at] = snapshot(join(dir, at));
      if (out[at] === "dir") walk(at);
    }
  };
  walk("");
  return out;
}

/** What is at `p`: its `snapshot`, with a folder's contents (`tree`) in place of "dir". */
function entryAt(p: string): Record<string, string | null> | string | null {
  const s = snapshot(p);
  return s === "dir" ? tree(p) : s;
}

/** The survivors as they are in `support` now, by `entryAt` (null where one is gone). */
const survivorsIn = (support: string) => Object.fromEntries(Object.keys(SURVIVORS).map((n) => [n, entryAt(join(support, n))]));

/** The listed artifacts still in `support`, each by `snapshot` (lstat: a dangling link is THERE, never "removed";
 *  a file's bytes, so a truncated or replaced one is not the one the fixture made) — M9 LOW pass (L11). */
const artifactsIn = (support: string): Record<string, string> =>
  Object.fromEntries(ARTIFACTS.flatMap((f) => {
    const s = snapshot(join(support, f));
    return s === null ? [] : [[f, s]];
  }));

/** The stubs, written ONCE per file and shared: on macOS the first exec of a freshly written executable
 *  cost ~0.2 s each here (measured), so per-fixture stubs made this file several times slower. Each stub reads
 *  where to record, and what to answer, from the run's environment. */
let shared: { bin: string; engine: string; wordless: string } | undefined;
function stubs(): { bin: string; engine: string; wordless: string } {
  if (shared) return shared;
  const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-uninstall-stubs-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const record = (name: string) => `{ printf '%s' "${name}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"`;
  writeFileSync(join(bin, KEYCHAIN_TOOL), `#!/bin/sh\n${record(KEYCHAIN_TOOL)}\nexit "\${STUB_KEYCHAIN_RC:-0}"\n`, { mode: 0o755 });
  // pmset: silent by default; STUB_PMSET_SCHED is what `pmset -g sched` prints, followed by STUB_PMSET_PAD more
  // lines (M9 LOW pass, L10) — enough to outlast a pipe buffer, so a reader that stops at its first match
  // (`grep -q`) closes the pipe while pmset is still writing, and pmset dies of SIGPIPE.
  writeFileSync(join(bin, "pmset"), [
    "#!/bin/sh",
    record("pmset"),
    'if [ -n "${STUB_PMSET_SCHED:-}" ]; then',
    '  printf \'%s\\n\' "$STUB_PMSET_SCHED"',
    '  i=0',
    '  while [ "$i" -lt "${STUB_PMSET_PAD:-0}" ]; do printf \'padding %s ............................................................\\n\' "$i"; i=$((i + 1)); done',
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  // launchd's tool: the READ-ONLY verbs only, each with its own answer. `${VAR-default}` (no colon) keeps a
  // set-but-empty value, so a case can answer with a silent exit 113. It never runs anything.
  writeFileSync(join(bin, LAUNCHD_TOOL), [
    "#!/bin/sh",
    record(LAUNCHD_TOOL),
    'case "$1 $2" in',
    `  "print gui/"*) rc="\${STUB_LD_GUI_RC:-113}"; err="\${STUB_LD_GUI_ERR-${NOT_FOUND}}" ;;`,
    `  "print user/"*) rc="\${STUB_LD_USER_RC:-113}"; err="\${STUB_LD_USER_ERR-${NOT_FOUND}}" ;;`,
    `  "list "*) rc="\${STUB_LD_LIST_RC:-113}"; err="\${STUB_LD_LIST_ERR-${NOT_FOUND}}" ;;`,
    '  *) rc=99; err="stub: refused, not a read-only verb: $*" ;;',
    "esac",
    '[ -z "$err" ] || printf \'%s\\n\' "$err" >&2',
    'exit "$rc"',
    "",
  ].join("\n"), { mode: 0o755 });
  for (const real of ["rm", "grep"]) symlinkSync(Bun.which(real)!, join(bin, real));
  // The managed binary: VERB-AWARE, outside PATH. One line APPENDED per call. `schedule status --json`
  // never touches the record; `schedule uninstall` exiting 0 unlinks it, the way the engine does
  // (src/schedule/install.ts uninstallSchedule).
  const engine = join(dir, "engine");
  writeFileSync(engine, [
    "#!/bin/sh",
    `printf '%s\\t%s\\t%s\\t%s\\n' "$*" "$HOME" "$DAILY_BRIEFING_STATE_DIR" "\${DBA_TEST_UNIT_DIR-<unset>}" >> "$STUB_MANAGED_LOG"`,
    'case "$*" in',
    '  "schedule status --json")',
    '    case "${STUB_STATUS:-new}" in',
    `      new) printf '{"registered":%s,"recordPresent":true,"removeSteps":"Run these in a terminal"}\\n' "\${STUB_REGISTERED:-false}" ;;`,
    `      old) printf '{"registered":%s,"recordPresent":true}\\n' "\${STUB_REGISTERED:-false}" ;;`,
    // JSON.stringify(report, null, 2)'s spelling: one space after each colon.
    `      indented) printf '{\\n  "registered": %s,\\n  "recordPresent": true,\\n  "removeSteps": "Run these"\\n}\\n' "\${STUB_REGISTERED:-false}" ;;`,
    "    esac",
    '    exit "${STUB_STATUS_RC:-0}" ;;',
    '  "schedule uninstall")',
    '    rc="${STUB_MANAGED_RC:-0}"',
    '    if [ -n "${STUB_MANAGED_OUT+set}" ]; then out="$STUB_MANAGED_OUT"',
    '    elif [ "$rc" = 0 ]; then out="Removed the background scheduler."',
    '    elif [ "$rc" = 1 ]; then out="Nothing installed by daily-briefing was found."',
    '    else out=""; fi',
    '    [ -z "$out" ] || printf \'%s\\n\' "$out"',
    '    echo "stub engine: schedule uninstall -> exit $rc" >&2',
    // STUB_MANAGED_ERR: what a real engine prints on that exit (an owner refusal, the manual steps).
    '    [ -z "${STUB_MANAGED_ERR:-}" ] || printf \'%s\\n\' "$STUB_MANAGED_ERR" >&2',
    '    case "${STUB_MANAGED_RECORD:-}" in',
    "      keep) ;;",
    '      drop) rm -f "$DAILY_BRIEFING_STATE_DIR/schedule.json" ;;',
    '      *) if [ "$rc" = 0 ]; then rm -f "$DAILY_BRIEFING_STATE_DIR/schedule.json"; fi ;;',
    "    esac",
    '    exit "$rc" ;;',
    '  *) echo "stub engine: unexpected call: $*" >&2; exit 64 ;;',
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  // The static gate reads this text: the stub must carry the word, or every "new enough" case below would
  // silently become a no-new-enough case.
  expect(readFileSync(engine, "utf8")).toContain("removeSteps");
  // An engine whose FILE lacks the word — the shape of a managed binary built before 2026-07-15, whose
  // dispatcher ran a briefing for any first argument but `init`. If it were ever run it would record the
  // call and answer exactly like a new enough engine (the word is assembled at run time, so the file never
  // holds it): only the static read can tell, which is the point. It must never run.
  const wordless = join(dir, "wordless-engine");
  writeFileSync(wordless, [
    "#!/bin/sh",
    `printf '%s\\t%s\\t%s\\t%s\\n' "$*" "$HOME" "$DAILY_BRIEFING_STATE_DIR" "\${DBA_TEST_UNIT_DIR-<unset>}" >> "$STUB_MANAGED_LOG"`,
    'case "$*" in',
    `  "schedule status --json") printf '{"registered":false,"recordPresent":true,"remove%s":"Run these"}\\n' Steps ;;`,
    '  "schedule uninstall") echo "Removed the background scheduler."; rm -f "$DAILY_BRIEFING_STATE_DIR/schedule.json" ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  expect(readFileSync(wordless, "utf8")).not.toContain("removeSteps");
  return (shared = { bin, engine, wordless });
}

/** `record`: none (default), today's compact terminal record (true), or the file's exact text.
 *  `recordShape`: instead, a FIFO, or a symlink to nothing, at the record's path.
 *  `managed`: absent, present but not executable (its text lacking removeSteps), its text holding removeSteps
 *  but mode 0644 (M9 LOW pass, L14), executable but impossible to run (its text holding
 *  removeSteps, so only the launch fails), the "wordless" stub
 *  (executable, would answer like a new engine, but its text lacks removeSteps), an executable FIFO, or the
 *  stub engine exiting with that code from `schedule uninstall`. `plist`: a label-less agent file at
 *  DBA_TEST_PLIST. */
type Managed = "absent" | "not-executable" | "worded-not-executable" | "unrunnable" | "wordless" | "fifo" | number;
function fixture(opts: {
  record?: boolean | string; recordShape?: "fifo" | "dangling-link"; plist?: boolean; managed?: Managed; keychainExit?: number;
} = {}): Fx {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-uninstall-")));
  const support = join(base, "support");
  const home = join(base, "home");
  for (const d of [support, home, join(base, "LaunchAgents")]) mkdirSync(d, { recursive: true });
  const managed = opts.managed ?? "absent";
  const fx: Fx = {
    base, support, home,
    plist: join(base, "LaunchAgents", "fake.plist"),
    keychain: join(support, "scratch.keychain-db"),
    calls: join(base, "calls.log"),
    managedLog: join(base, "managed.log"),
    record: join(support, "schedule.json"),
    artifactsBefore: {},
    plistBefore: null, recordBefore: null, dirsBefore: {},
    managedRc: typeof managed === "number" ? managed : null,
    keychainRc: opts.keychainExit ?? 0,
  };
  // The managed binary is one of the artifacts, but its shape is the case's: absent, inert, or the stub.
  for (const f of ARTIFACTS) if (f !== "daily-briefing") writeFileSync(join(support, f), "x");
  // Each folder with a file in it and one a level down, each file's bytes its own, so `tree` has depth to see.
  for (const d of DIRS) {
    mkdirSync(join(support, d, "nested"), { recursive: true });
    writeFileSync(join(support, d, "inside.md"), "x");
    writeFileSync(join(support, d, "nested", "deeper.md"), `${d}, one level down`);
  }
  // M9 round 4 (S1b): the names no list holds, which every run must leave — planted from `SURVIVORS` itself
  // (M9 LOW pass, L12).
  seed(support);
  if (opts.plist) writeFileSync(fx.plist, "<plist/>");
  if (opts.record === true) writeFileSync(fx.record, '{"owner":"cli","unitPath":"/nowhere"}\n');
  else if (typeof opts.record === "string") writeFileSync(fx.record, opts.record);
  else if (opts.recordShape === "fifo") mkfifo(fx.record);
  else if (opts.recordShape === "dangling-link") symlinkSync(join(base, "no-such-record.json"), fx.record);
  const bin = binOf(fx);
  if (managed === "not-executable") writeFileSync(bin, "x", { mode: 0o644 });
  // Executable, but exec fails: its interpreter does not exist. Its text CARRIES the word, so the static gate
  // passes and the script reaches the status read, which itself cannot launch (M9 round 1: wordless, it
  // stopped at the gate, and the launch failure was never exercised).
  else if (managed === "unrunnable") {
    writeFileSync(bin, "#!/nonexistent/interpreter\n# removeSteps: the static gate reads this word; nothing can run it\n", { mode: 0o755 });
  }
  else if (managed === "wordless") symlinkSync(stubs().wordless, bin);
  // Executable but not a regular file: reading it would block until a writer came, and none ever does.
  else if (managed === "fifo") { mkfifo(bin); chmodSync(bin, 0o755); }
  // M9 LOW pass (L14): a regular file whose text DOES hold the word, but mode 0644 — so only the gate's
  // `[ -x "$BIN" ]` leg can turn it away (the not-executable shape above lacks the word: grep fails first).
  else if (managed === "worded-not-executable") {
    writeFileSync(bin, readFileSync(stubs().engine, "utf8"), { mode: 0o644 });
    chmodSync(bin, 0o644);
  }
  else if (typeof managed === "number") symlinkSync(stubs().engine, bin);
  fx.artifactsBefore = artifactsIn(support);
  fx.plistBefore = snapshot(fx.plist);
  fx.recordBefore = snapshot(fx.record);
  fx.dirsBefore = Object.fromEntries(DIRS.map((d) => [d, tree(join(support, d))]));
  // prove-it 3b: the pre-run snapshots are what the fixture asked for, so "unchanged" is never vacuous.
  expect(fx.plistBefore !== null).toBe(opts.plist === true);
  expect(fx.recordBefore !== null).toBe(opts.record === true || typeof opts.record === "string" || opts.recordShape !== undefined);
  for (const d of DIRS) {
    expect(fx.dirsBefore[d]).toEqual({ "inside.md": "file: x", nested: "dir", [join("nested", "deeper.md")]: `file: ${d}, one level down` });
  }
  expect(survivorsIn(support)).toEqual(SURVIVORS);
  return fx;
}

/** A FIFO, made by the system tool by absolute path (node:fs has no mkfifo). */
function mkfifo(p: string): void {
  const r = Bun.spawnSync(["/usr/bin/mkfifo", p], { stdout: "pipe", stderr: "pipe" });
  expect(`${r.exitCode} ${r.stderr.toString()}`).toBe("0 ");
  expect(lstatSync(p).isFIFO()).toBe(true);
}

/** Releases any reader a FIFO still holds: a non-blocking open for writing succeeds only when a reader is
 *  waiting, and closing it hands that reader end-of-file. A no-op otherwise. So a run that blocked on one
 *  (a regression the FIFO cases exist to catch) leaves no process behind once it is timed out. */
function releaseFifo(p: string): void {
  try {
    if (!lstatSync(p).isFIFO()) return;
    closeSync(openSync(p, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch { /* no reader (ENXIO) or no file: nothing to release */ }
}

interface ManagedCall { argv: string; home: string; stateDir: string; unitDir: string }
interface Run { code: number | null; out: string; stdout: string; err: string; calls: string[][]; managed: ManagedCall[] }
type Answer = readonly [rc: number, err: string];
interface RunOpts {
  keychain?: boolean | string; testDir?: boolean; record?: "keep" | "drop"; engineErr?: string; engineOut?: string;
  status?: "new" | "old" | "none" | "indented"; statusRc?: number; registered?: "true" | "false" | "null";
  launchd?: { gui?: Answer; user?: Answer; list?: Answer };
  /** What `pmset -g sched` prints, then `pad` more lines (M9 LOW pass, L10). */
  pmset?: { sched: string; pad: number };
  /** Kill the run after this long, for the cases where a regression would BLOCK (a FIFO read). */
  timeoutMs?: number;
}

/** `keychain`: the scratch keychain inside DBA_TEST_DIR (default), omitted (false), or an explicit value
 *  for the variable's own validation cases. `testDir: false` omits DBA_TEST_DIR (HOME stays scratch).
 *  `record`: the stub engine's STUB_MANAGED_RECORD. `status`: what its `schedule status --json` prints —
 *  with `removeSteps` (new, the default), without (old), or nothing. `launchd`: a read-only verb's answer.
 *  The script's stdout and stderr go to FILES, not pipes: a child left blocked on a FIFO would hold a pipe
 *  open past the timeout, and the timeout must end the run. */
function run(fx: Fx, args: string[] = [], opts: RunOpts = {}): Run {
  const { bin } = stubs();
  const keychain = opts.keychain === undefined || opts.keychain === true ? fx.keychain : opts.keychain;
  const answers: Record<string, string> = {};
  for (const [verb, key] of [["gui", "GUI"], ["user", "USER"], ["list", "LIST"]] as const) {
    const a = opts.launchd?.[verb];
    if (a) { answers[`STUB_LD_${key}_RC`] = String(a[0]); answers[`STUB_LD_${key}_ERR`] = a[1]; }
  }
  const env: Record<string, string> = {
    PATH: bin,
    HOME: fx.home,
    ...(opts.testDir === false ? {} : { DBA_TEST_DIR: fx.support }),
    DBA_TEST_PLIST: fx.plist,
    ...(keychain === false ? {} : { DBA_TEST_KEYCHAIN: keychain }),
    STUB_LOG: fx.calls,
    STUB_MANAGED_LOG: fx.managedLog,
    STUB_MANAGED_RC: String(fx.managedRc ?? 0),
    STUB_KEYCHAIN_RC: String(fx.keychainRc),
    ...(opts.record ? { STUB_MANAGED_RECORD: opts.record } : {}),
    ...(opts.engineErr ? { STUB_MANAGED_ERR: opts.engineErr } : {}),
    ...(opts.engineOut !== undefined ? { STUB_MANAGED_OUT: opts.engineOut } : {}),
    ...(opts.status ? { STUB_STATUS: opts.status } : {}),
    ...(opts.statusRc !== undefined ? { STUB_STATUS_RC: String(opts.statusRc) } : {}),
    ...(opts.registered ? { STUB_REGISTERED: opts.registered } : {}),
    ...(opts.pmset ? { STUB_PMSET_SCHED: opts.pmset.sched, STUB_PMSET_PAD: String(opts.pmset.pad) } : {}),
    ...answers,
  };
  // The interlocks, asserted before anything runs: PATH is the stub directory alone, the stubs are what it
  // resolves, and every redirected path is scratch (HOME too, which is where the default support dir and
  // keychain would resolve when DBA_TEST_DIR is omitted).
  expect(env.PATH).toBe(bin);
  for (const name of [KEYCHAIN_TOOL, LAUNCHD_TOOL, "pmset"]) expect(Bun.which(name, { PATH: env.PATH })).toBe(join(bin, name));
  expect([env.HOME, env.DBA_TEST_DIR, env.DBA_TEST_PLIST].filter((p) => p !== undefined).every((p) => p!.startsWith(fx.base + "/"))).toBe(true);
  if (args.includes(FLAG) && opts.keychain === undefined) expect(env.DBA_TEST_KEYCHAIN!.startsWith(fx.support + "/")).toBe(true);
  // Whether the managed binary's TEXT holds the word the script's static gate reads, taken BEFORE the run
  // (a run that carries on deletes it) and only from a regular file (a FIFO is never opened).
  const binHasWord = (() => {
    try { return statSync(binOf(fx)).isFile() && readFileSync(binOf(fx), "latin1").includes("removeSteps"); } catch { return false; }
  })();

  const stdoutPath = join(fx.base, "run.stdout"), stderrPath = join(fx.base, "run.stderr");
  const outFd = openSync(stdoutPath, "w"), errFd = openSync(stderrPath, "w");
  const r = (() => {
    try {
      return Bun.spawnSync([BASH, SCRIPT, ...args], {
        cwd: fx.base, env, stdout: outFd, stderr: errFd,
        ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
  })();
  const timedOut = r.exitedDueToTimeout === true;
  if (timedOut) for (const p of [fx.record, binOf(fx)]) releaseFifo(p);
  const calls = existsSync(fx.calls) ? readFileSync(fx.calls, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  const managed: ManagedCall[] = existsSync(fx.managedLog)
    ? readFileSync(fx.managedLog, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => {
      const [argv, home, stateDir, unitDir] = l.split("\t");
      return { argv: argv!, home: home!, stateDir: stateDir!, unitDir: unitDir! };
    })
    : [];
  const stdout = readFileSync(stdoutPath, "utf8"), err = readFileSync(stderrPath, "utf8");
  // The invariants every case holds, whatever its branch (spec 3.6.6, 3.1.3, the M7 build correction): the
  // run ends by itself; the script sends launchd's tool nothing but the read-only verbs; it runs the managed
  // binary only when that binary's text holds removeSteps; and every engine call — the status read and the
  // uninstall — carries the scratch unit folder beside the scratch HOME and state dir.
  expect(timedOut, `the run blocked and was killed after ${opts.timeoutMs} ms`).toBe(false);
  for (const c of calls.filter((c) => c[0] === LAUNCHD_TOOL)) expect(["print", "list"]).toContain(c[1]!);
  if (managed.length > 0) expect(binHasWord, `the script ran a managed binary whose text lacks removeSteps: ${managed.map((m) => m.argv).join(", ")}`).toBe(true);
  if (opts.testDir === false) expect(managed).toEqual([]);
  for (const m of managed) {
    expect(m).toEqual({ argv: m.argv, home: join(fx.support, "home"), stateDir: fx.support, unitDir: join(fx.support, "units") });
  }
  return { code: r.exitCode, out: stdout + err, stdout, err, calls, managed };
}

const callsTo = (r: Run, name: string) => r.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const engineVerbs = (r: Run) => r.managed.map((m) => m.argv);
/** What is still on disk: the listed artifacts (M9 LOW pass, L11) and the two scheduler files as `snapshot`s
 *  (kind and bytes, lstat), and each removed folder still there with its contents (`tree`; anything else at its
 *  path as its `snapshot`), compared with the fixture's own pre-run snapshots, never with anything read back
 *  after the run — and (M9 round 4) the support dir itself and the `SURVIVORS` in it, by `entryAt`. */
function left(fx: Fx) {
  const dirs: Record<string, Record<string, string | null> | string> = {};
  for (const d of DIRS) {
    const s = entryAt(join(fx.support, d));
    if (s !== null) dirs[d] = s;
  }
  return {
    artifacts: artifactsIn(fx.support),
    dirs,
    plist: snapshot(fx.plist),
    record: snapshot(fx.record),
    support: snapshot(fx.support),
    survivors: survivorsIn(fx.support),
  };
}
/** A run that removed nothing: everything the fixture made is still there — the artifacts (M9 LOW pass, L11),
 *  the scheduler files, both folders' contents and the survivors — byte for byte, in a support dir that is still
 *  a directory. */
const nothingRemoved = (fx: Fx) => ({
  artifacts: fx.artifactsBefore, dirs: fx.dirsBefore, plist: fx.plistBefore, record: fx.recordBefore, support: "dir", survivors: SURVIVORS,
});
/** A run that carried on: every artifact and folder gone, no plist or record left — and (M9 round 4) nothing
 *  MORE: the support dir still a directory, every survivor in it byte for byte. */
const ALL_REMOVED = { artifacts: {}, dirs: {}, plist: null, record: null, support: "dir", survivors: SURVIVORS };
/** A stop: the steps, then the script's own closing line, on stderr (spec 3.1.8, 3.6.6). */
const STEPS_AND_CLOSING = `${STEPS}\n${SCRIPT_CLOSING}\n`;

// M9 ROUND 4 (S1; GPT found three more shapes past the Rust static parse, the fourth round on that pin):
// parity is decided BEHAVIOURALLY. Every case below runs the real script under bash against a support dir
// seeded with exactly the desktop app's list (`rustEngineList`) plus names no list holds (`SURVIVORS`), and
// checks what is left: a run that carries on must remove every listed name (REMOVES LESS fails `ALL_REMOVED`)
// and nothing else (REMOVES MORE fails it too); a stop must remove nothing at all. The static parse stays
// as the first line. These two tests prove the expectations decide both ways, without running the script.
describe("uninstall.sh: parity decided by bash — the seeded names and the expectations (M9 round 4)", () => {
  test("the fixture seeds exactly the desktop app's ENGINE_STATE_REMOVALS (read as text): every entry on disk, nothing outside it, and survivors none of it matches", () => {
    const list = rustEngineList();
    expect(list.length).toBe(16);   // the Rust parity parse's own count at M9 round 4
    const listed = (name: string, dir: boolean) => list.some((e) => (e.kind === "Dir") === dir && matchesEntry(e, name));
    // ARTIFACTS ∪ DIRS holds nothing outside the list, each of its own kind.
    for (const f of ARTIFACTS) expect([f, listed(f, false)]).toEqual([f, true]);
    for (const d of DIRS) expect([d, listed(d, true)]).toEqual([d, true]);
    // Every entry is seeded ON DISK by a fixture whose managed binary is there: a file as a file (the binary
    // as the stub's link), a glob by at least one matching file, a folder with nested content.
    const fx = fixture({ managed: 0 });
    const names = readdirSync(fx.support);
    for (const e of list) {
      const hits = names.filter((n) => matchesEntry(e, n));
      expect([e.token, hits.length > 0]).toEqual([e.token, true]);
      for (const n of hits) {
        const st = lstatSync(join(fx.support, n));
        if (e.kind === "Dir") expect([n, st.isDirectory() && Object.values(tree(join(fx.support, n))).includes("dir")]).toEqual([n, true]);
        else expect([n, st.isFile() || st.isSymbolicLink()]).toEqual([n, true]);
      }
    }
    // The survivors are on disk and no entry matches them, or a run would remove them by right.
    for (const s of Object.keys(SURVIVORS)) {
      expect([s, names.includes(s), list.some((e) => matchesEntry(e, s))]).toEqual([s, true, false]);
    }
    // prove-it 3b: the reader and matcher are not vacuous — an entry nothing seeds matches no name here, and
    // the glob matches its seeded files but not its near miss.
    expect(names.some((n) => matchesEntry({ token: "not-seeded.json", kind: "File" }, n))).toBe(false);
    const glob = list.find((e) => e.kind === "Glob")!;
    expect([matchesEntry(glob, "audit-2026-07-30.md"), matchesEntry(glob, "audit-notes.txt")]).toEqual([true, false]);
  });

  test("ALL_REMOVED and nothingRemoved decide both ways: removing exactly the list meets ALL_REMOVED; leaving any listed name, or removing the support dir or any survivor, fails it", () => {
    const list = rustEngineList();
    /** By hand, no script: remove what the list names from the support dir, all but `skip`'s entry. */
    const removeListed = (fx: Fx, skip?: string): void => {
      for (const e of list) {
        if (e.token === skip) continue;
        for (const n of readdirSync(fx.support).filter((n) => matchesEntry(e, n))) {
          rmSync(join(fx.support, n), { recursive: e.kind === "Dir", force: true });
        }
      }
    };
    const exact = fixture({ managed: 0 });
    removeListed(exact);
    expect(left(exact)).toEqual(ALL_REMOVED);
    // REMOVES LESS: any one entry left behind fails it.
    for (const e of list) {
      const fx = fixture({ managed: 0 });
      removeListed(fx, e.token);
      expect(left(fx), `${e.token} left behind`).not.toEqual(ALL_REMOVED);
    }
    // REMOVES MORE: the support dir itself, or any one survivor, fails it…
    const whole = fixture({ managed: 0 });
    rmSync(whole.support, { recursive: true, force: true });
    expect(left(whole), "the support dir removed whole").not.toEqual(ALL_REMOVED);
    for (const s of Object.keys(SURVIVORS)) {
      const fx = fixture({ managed: 0 });
      removeListed(fx);
      rmSync(join(fx.support, s), { recursive: true, force: true });
      expect(left(fx), `${s} removed too`).not.toEqual(ALL_REMOVED);
    }
    // …and a stop that removed a survivor, or changed one byte of it, is no stop.
    for (const s of Object.keys(SURVIVORS)) {
      const fx = fixture({ managed: 0 });
      rmSync(join(fx.support, s), { recursive: true, force: true });
      expect(left(fx), `${s} removed by a stop`).not.toEqual(nothingRemoved(fx));
    }
    const edited = fixture({ managed: 0 });
    writeFileSync(join(edited.support, "unlisted-folder", "nested", "deeper.md"), "changed");
    expect(left(edited), "a survivor's bytes changed").not.toEqual(nothingRemoved(edited));
    // M9 LOW pass (L11): the listed artifacts are read by content, lstat — so a stop that truncated or replaced a
    // state file is no stop, and a listed name left behind as a link to nothing is not "removed" (existsSync
    // follows the link and reads it as gone).
    const truncated = fixture({ managed: 0 });
    writeFileSync(join(truncated.support, "last-run"), "");
    expect(left(truncated), "a listed file truncated by a stop").not.toEqual(nothingRemoved(truncated));
    const replaced = fixture({ managed: 0 });
    rmSync(join(replaced.support, "run.lock"));
    symlinkSync(join(replaced.base, "elsewhere"), join(replaced.support, "run.lock"));
    expect(left(replaced), "a listed file replaced by a link").not.toEqual(nothingRemoved(replaced));
    const dangling = fixture({ managed: 0 });
    removeListed(dangling);
    symlinkSync(join(dangling.base, "no-such-file"), join(dangling.support, "briefing.log"));
    expect(existsSync(join(dangling.support, "briefing.log"))).toBe(false);   // what an existence check reads
    expect(left(dangling), "a listed name left as a dangling link").not.toEqual(ALL_REMOVED);
    // …and the managed binary, a link to the stub engine, is compared as that link.
    expect(nothingRemoved(fixture({ managed: 0 })).artifacts["daily-briefing"]).toBe(`link -> ${stubs().engine}`);
  });
});

describe("uninstall.sh: a new enough engine is asked first, with or without a record", () => {
  test("record + a new enough engine exiting 0 -> it reads the status, then uninstalls; the removals proceed and launchd is not called", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(engineVerbs(r)).toEqual(["schedule status --json", "schedule uninstall"]);
    expect(left(fx)).toEqual(ALL_REMOVED);   // the engine unlinked the record
    expect(r.calls.filter((c) => c[0] !== "pmset")).toEqual([]);  // no launchd call, no keychain call
    // The engine's stderr is shown, and its stdout line is printed back.
    expect(r.err).toContain("stub engine: schedule uninstall -> exit 0");
    expect(r.stdout).toContain("Removed the background scheduler.");
    expect(r.stdout).toMatch(/^Uninstalled\.$/m);
  });

  // The plist is the engine's to remove (spec 3.6.6): even when an engine reports success and leaves one
  // behind, the script carries on without touching it.
  test("a new enough engine exiting 0 that leaves the plist in place -> the script carries on, and the plist is still there byte for byte", () => {
    const fx = fixture({ plist: true, managed: 0 });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(engineVerbs(r)).toEqual(["schedule status --json", "schedule uninstall"]);
    expect(fx.plistBefore).toBe("file: <plist/>");
    expect(left(fx)).toEqual({ ...ALL_REMOVED, plist: fx.plistBefore });
    expect(r.stdout).toMatch(/^Uninstalled\.$/m);
  });

  test("no record + a new enough engine -> still asked (the routine's own first check decides), and the removals proceed on exit 0", () => {
    const fx = fixture({ managed: 0 });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(engineVerbs(r)).toEqual(["schedule status --json", "schedule uninstall"]);
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual([]);
    expect(left(fx)).toEqual(ALL_REMOVED);
  });

  // (M9 LOW pass, L13: a test that every engine call carries DBA_TEST_UNIT_DIR beside the scratch HOME and state
  // dir was here. It ran the first test's case and asserted its two verbs — which that test asserts — and the
  // three variables on each call, which `run()` asserts for EVERY case; so it was deleted as a duplicate.)

  test("exit 1 with nothing on disk, its line on stdout and a status that did not say registered -> the removals proceed", () => {
    for (const [registered, status] of [["false", "new"], ["null", "new"], ["false", "indented"]] as const) {
      const fx = fixture({ managed: 1 });
      const r = run(fx, [], { registered, status });
      expect(`${registered} ${status}: ${r.code}`).toBe(`${registered} ${status}: 0`);
      expect(r.stdout).toContain("Nothing installed by daily-briefing was found.");
      expect(left(fx)).toEqual(ALL_REMOVED);
    }
  });

  // A crash also exits 1, so exit 1 is trusted only when all three hold (spec 3.6.6, mirroring Rust's 3.3.4.3).
  test("exit 1 with the record or a plist still there, nothing on stdout, or a status that said registered -> it stops with the steps, nothing removed", () => {
    const cases: { name: string; fx: () => Fx; opts: RunOpts }[] = [
      { name: "the record is still there", fx: () => fixture({ record: true, managed: 1 }), opts: {} },
      { name: "a plist is still there", fx: () => fixture({ plist: true, managed: 1 }), opts: {} },
      { name: "nothing on stdout (a crash)", fx: () => fixture({ managed: 1 }), opts: { engineOut: "" } },
      { name: "only whitespace on stdout", fx: () => fixture({ managed: 1 }), opts: { engineOut: "   " } },
      { name: "the status said registered", fx: () => fixture({ managed: 1 }), opts: { registered: "true" } },
      // JSON.stringify's indented spelling ("registered": true) must keep the doubt too: losing it fails open.
      { name: "an indented status said registered", fx: () => fixture({ managed: 1 }), opts: { registered: "true", status: "indented" } },
    ];
    for (const c of cases) {
      const fx = c.fx();
      const r = run(fx, [], c.opts);
      expect(`${c.name}: ${r.code}`).toBe(`${c.name}: 1`);
      expect(engineVerbs(r)).toEqual(["schedule status --json", "schedule uninstall"]);
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(existsSync(join(fx.support, "daily-briefing"))).toBe(true);
      expect(r.calls).toEqual([]);
      expect(r.err).toContain("schedule uninstall exited 1");
      expect(r.err).toContain(STEPS_AND_CLOSING);
      expect(r.out).not.toMatch(/^Uninstalled/m);
      expect(r.out).not.toContain(SETTINGS_KEPT);
    }
  });

  test("exit 2 (another owner, typically the app) -> refused: the engine's reason without its --take-over advice, then the script's own take-over hint; nothing removed", () => {
    const fx = fixture({ record: true, managed: 2 });
    const r = run(fx, [], { engineErr: 'schedule uninstall: the trigger is owned by "app", not "cli" — removing only what we own. Re-run with --take-over to remove it anyway.' });
    expect(r.code).toBe(1);
    expect(engineVerbs(r)).toEqual(["schedule status --json", "schedule uninstall"]);
    expect(r.err).toContain('schedule uninstall: the trigger is owned by "app", not "cli" — removing only what we own.');
    expect(r.err).not.toContain("Re-run with --take-over");
    // The way out is the app's own button — named as the app names it, `REMOVE_SCHEDULE_BUTTON` read as text (M9
    // LOW pass, L15) — and, when the app is already gone, the engine's take-over by its exact path.
    expect(r.err).toContain(`Schedule screen ("${removeScheduleButton()}")`);
    expect(r.err).toContain(`If the app is already gone, run "${join(fx.support, "daily-briefing")}" schedule uninstall --take-over, then run this script again.`);
    expect(r.err).not.toContain("stale");
    // The managed binary the app's trigger runs is still there, and so is everything else.
    expect(left(fx)).toEqual(nothingRemoved(fx));
    expect(existsSync(join(fx.support, "daily-briefing"))).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.out).not.toMatch(/^Uninstalled/m);
  });

  test("exit 3 -> it stops with the engine's message, whose closing line becomes the script's IN ITS PLACE (details first, or steps first for a stable reason); nothing more removed", () => {
    const details = "Couldn't finish removing the background scheduler: it is still registered after unregistering it.\nStill present: the registered job.\nThis attempt removed no files.";
    for (const stepsFirst of [false, true]) {
      const fx = fixture({ record: true, managed: 3 });
      const engineErr = stepsFirst ? `${STEPS}\n${CLI_CLOSING}\n${details}` : `${details}\n${STEPS}\n${CLI_CLOSING}`;
      const r = run(fx, [], { engineErr });
      expect(r.code).toBe(3);
      expect(engineVerbs(r)).toEqual(["schedule status --json", "schedule uninstall"]);
      expect(r.err).toContain(stepsFirst ? `${STEPS}\n${SCRIPT_CLOSING}\n${details}\n` : `${details}\n${STEPS}\n${SCRIPT_CLOSING}\n`);
      expect(r.err).not.toContain(CLI_CLOSING);
      expect(r.err).toContain("schedule uninstall failed (exit 3). This script removed nothing; the engine's message above says what it removed, if anything.");
      expect(r.err).not.toContain(`delete ${fx.record}`);   // the old "delete $RECORD and re-run" advice is gone
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.calls).toEqual([]);
    }
  });

  test("an exit code outside the contract stops too -> that code, nothing removed", () => {
    const fx = fixture({ record: true, managed: 7 });
    const r = run(fx);
    expect(r.code).toBe(7);
    expect(r.err).toContain("schedule uninstall failed (exit 7).");
    expect(left(fx)).toEqual(nothingRemoved(fx));
  });

  // Source pins read the engine's CODE, comments stripped (plan 1.5), with the suite's own stripper — and
  // each pinned line must also be a WHOLE line of that code, so a commented-out copy cannot satisfy it
  // even if the stripper were to keep a comment (its hand-written predecessor kept every comment after a
  // template literal holding `${…}`; it now takes comment ranges from TypeScript's parser, #591).
  const codeLines = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8")).split("\n").map((l) => l.trim());
  test("the closing line the script replaces is the engine's own (src/schedule/install.ts, read as text)", () => {
    const line = `export const MANUAL_STEPS_CLI_CLOSING = ${JSON.stringify(CLI_CLOSING)};`;
    expect(codeLines("src/schedule/install.ts").filter((l) => l === line)).toEqual([line]);
    // prove-it 3b: a commented-out copy is no whole-line match, whether or not the stripper removes it.
    expect(`// ${line}` === line).toBe(false);
    expect(stripComments(`// ${line}`)).not.toContain("MANUAL_STEPS_CLI_CLOSING");
  });

  // The script's two `case` patterns read the status as JSON.stringify writes it, and the stub engine
  // above answers compact, as src/main.ts's `schedule status` arm prints it: JSON.stringify(report), no
  // indent. Pinned so a change to that arm is seen beside the patterns (and the stub) that assume it.
  test("the status the script reads is compact: main.ts's schedule-status arm prints JSON.stringify(report), no indent (read as text)", () => {
    // The arm's one output line, whole: renderScheduleStatus names the schedule-status arm.
    const arm = /^console\.log\(wantsJson \? JSON\.stringify\((.*)\) : statusMod\.renderScheduleStatus\(report\)\);$/;
    const hits = codeLines("src/main.ts").map((l) => arm.exec(l)).filter((m) => m !== null);
    expect(hits.length).toBe(1);
    expect(hits[0]![1]).toBe("report");   // no replacer, no indent argument
    // prove-it 3b: an indented form, or a commented-out compact one, is no match.
    expect(arm.exec("console.log(wantsJson ? JSON.stringify(report, null, 2) : statusMod.renderScheduleStatus(report));")![1]).not.toBe("report");
    expect(arm.test("// console.log(wantsJson ? JSON.stringify(report) : statusMod.renderScheduleStatus(report));")).toBe(false);
  });
});

describe("uninstall.sh: no new enough engine, so it is never asked to remove anything", () => {
  // "New enough" = an executable regular file whose TEXT holds removeSteps (read, never run: spec 16, M7
  // build correction) AND whose `schedule status --json` then carries removeSteps (spec 3.6.6). An older
  // engine still has the unchecked uninstall, so a record it cannot be asked about stops the script.
  test("record + an engine that is absent, not executable, unrunnable, older (no removeSteps), silent, or whose status read fails -> refused with the steps and the update hint, nothing removed", () => {
    const shapes: { name: string; managed: Managed; opts: RunOpts }[] = [
      { name: "absent", managed: "absent", opts: {} },
      { name: "not executable", managed: "not-executable", opts: {} },
      { name: "unrunnable", managed: "unrunnable", opts: {} },
      { name: "older engine", managed: 0, opts: { status: "old" } },
      { name: "silent status", managed: 0, opts: { status: "none" } },
      { name: "failing status read", managed: 0, opts: { statusRc: 3 } },
    ];
    for (const s of shapes) {
      const fx = fixture({ record: true, managed: s.managed });
      const r = run(fx, [], s.opts);
      expect(`${s.name}: ${r.code}`).toBe(`${s.name}: 1`);
      expect(engineVerbs(r)).not.toContain("schedule uninstall");
      expect(r.calls).toEqual([]);   // no launchd call (a record needs no check), no keychain call
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.err).toContain(`a schedule record exists (${fx.record})`);
      // The branch also covers a new engine whose status read failed or printed nothing, so it says so.
      expect(r.err).toContain(`${join(fx.support, "daily-briefing")}, is missing, not executable, ${NOT_NEW_ENOUGH},`);
      expect(r.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);
      expect(r.err).not.toContain(APP_LEAD);   // a terminal record
      expect(r.out).not.toMatch(/^Uninstalled/m);
    }
  });

  // The M7 build correction (spec 16): the status read RUNS $BIN, and a managed binary built from a checkout
  // before 2026-07-15 ran a briefing for any first argument but `init`. So the script reads the FILE first
  // and runs it only when its text holds removeSteps. The wordless stub would answer exactly like a new
  // engine if it were run (the word is assembled at run time), so only the static read can stop it.
  test("an executable managed binary whose TEXT lacks removeSteps is never run, not even for the status -> a record or a plist stops with the steps, nothing on disk takes the read-only check", () => {
    const withRecord = fixture({ record: true, managed: "wordless" });
    const r1 = run(withRecord);
    expect(r1.managed).toEqual([]);   // never executed
    expect(r1.code).toBe(1);
    expect(r1.calls).toEqual([]);
    expect(left(withRecord)).toEqual(nothingRemoved(withRecord));
    expect(r1.err).toContain(`a schedule record exists (${withRecord.record})`);
    expect(r1.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);

    const withPlist = fixture({ plist: true, managed: "wordless" });
    const r2 = run(withPlist);
    expect(r2.managed).toEqual([]);
    expect(r2.code).toBe(1);
    expect(r2.calls).toEqual([]);
    expect(left(withPlist)).toEqual(nothingRemoved(withPlist));
    expect(r2.err).toContain(`a launchd agent file is at ${withPlist.plist}`);
    expect(r2.err).toContain(STEPS_AND_CLOSING);

    const nothing = fixture({ managed: "wordless" });
    const r3 = run(nothing);
    expect(r3.managed).toEqual([]);
    expect(r3.code).toBe(0);
    expect(callsTo(r3, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
    expect(left(nothing)).toEqual(ALL_REMOVED);
  });

  // The static read must never block either: an executable FIFO at $BIN is not a regular file, so it is
  // neither read nor run. A short timeout turns a block into a failure instead of a hang.
  test("an executable managed binary that is a FIFO is never read or run -> no block; a record stops with the steps, nothing on disk takes the read-only check", () => {
    const withRecord = fixture({ record: true, managed: "fifo" });
    const r1 = run(withRecord, [], { timeoutMs: 5_000 });
    expect(r1.managed).toEqual([]);
    expect(r1.code).toBe(1);
    expect(r1.calls).toEqual([]);
    expect(left(withRecord)).toEqual(nothingRemoved(withRecord));
    expect(r1.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);

    const nothing = fixture({ managed: "fifo" });
    const r2 = run(nothing, [], { timeoutMs: 5_000 });
    expect(r2.managed).toEqual([]);
    expect(r2.code).toBe(0);
    expect(callsTo(r2, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
    expect(left(nothing)).toEqual(ALL_REMOVED);
  });

  // The record as the engine looks for it (spec 3.1.2, lstat): a FIFO and a dangling symlink are both
  // present, so both stop the script; neither is a regular file, so neither is read for its owner (no app
  // lead), and nothing blocks. A short timeout turns a block into a failure instead of a hang.
  test("no engine + a record that is a FIFO, or a symlink to nothing -> it still stops: exit 1, the steps and the update hint, no app lead, nothing removed, never blocks", () => {
    for (const recordShape of ["fifo", "dangling-link"] as const) {
      const fx = fixture({ recordShape, managed: "absent" });
      const r = run(fx, [], { timeoutMs: 5_000 });
      expect(`${recordShape}: ${r.code}`).toBe(`${recordShape}: 1`);
      expect(r.calls).toEqual([]);
      expect(r.err).toContain(`a schedule record exists (${fx.record})`);
      expect(r.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);
      expect(r.err).not.toContain(APP_LEAD);
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.out).not.toMatch(/^Uninstalled/m);
    }
  });

  test("an app-owned record in writeScheduleRecord's own format (pretty-printed, trailing newline) -> the message leads with the app's Schedule screen", () => {
    for (const [name, text, lead] of [
      ["app, pretty-printed", prettyRecord("app"), true],
      ["app, compact", '{"owner":"app","unitPath":"/nowhere"}\n', true],
      ["cli, pretty-printed", prettyRecord("cli"), false],
    ] as const) {
      const fx = fixture({ record: text, managed: "absent" });
      const r = run(fx);
      expect(`${name}: ${r.code}`).toBe(`${name}: 1`);
      expect(`${name}: ${r.err.split("\n")[0] === APP_LEAD}`).toBe(`${name}: ${lead}`);
      expect(`${name}: ${r.err.includes(APP_LEAD)}`).toBe(`${name}: ${lead}`);
      expect(r.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);
      expect(left(fx)).toEqual(nothingRemoved(fx));
    }
  });

  test("no record + a plist + no new enough engine -> it stops with the same steps; no launchd call, nothing removed", () => {
    for (const managed of ["absent", "not-executable"] as const) {
      const fx = fixture({ plist: true, managed });
      const r = run(fx);
      expect(`${managed}: ${r.code}`).toBe(`${managed}: 1`);
      expect(r.calls).toEqual([]);
      expect(r.err).toContain(`a launchd agent file is at ${fx.plist}`);
      expect(r.err).toContain(`(${join(fx.support, "daily-briefing")} is missing, not executable,\n       ${NOT_NEW_ENOUGH}). Nothing was removed.\n`);
      expect(r.err).toContain(STEPS_AND_CLOSING);
      expect(r.err).not.toContain(UPDATE_HINT);
      expect(left(fx)).toEqual(nothingRemoved(fx));
    }
  });

  test("the printed steps are the engine's own text for the default paths, as PRINTED: \"$HOME\" and $(id -u) reach stderr unexpanded", () => {
    const fx = fixture({ record: true, managed: "absent" });
    const r = run(fx);
    // prove-it 3b: the comparison is not vacuous — the engine's text carries both shell expansions.
    expect(STEPS).toContain('"$HOME"/');
    expect(STEPS).toContain("$(id -u)");
    expect(r.err).toContain(STEPS_AND_CLOSING);
    expect(r.stdout).not.toContain(STEPS.split("\n")[0]!);
    expect(r.err).not.toContain(fx.home);
    expect(r.err).not.toContain(`gui/${UID}/`);
    expect(left(fx)).toEqual(nothingRemoved(fx));   // a stop (M9 LOW pass, L13)
  });

  // M9 LOW pass (L14): the gate's `[ -x "$BIN" ]` leg, on its own — a regular file whose text DOES hold the word,
  // but mode 0644. (The not-executable shape above lacks the word, so its grep fails first.) A mode-0644 file
  // cannot be exec'd at all, so `managed` would stay empty either way: what this pins is the branch taken.
  test("a managed binary whose text holds removeSteps but which is not executable is never run -> a record stops with the steps and the update hint, nothing on disk takes the read-only check", () => {
    const withRecord = fixture({ record: true, managed: "worded-not-executable" });
    const st = statSync(binOf(withRecord));
    expect([st.isFile(), (st.mode & 0o111) === 0, readFileSync(binOf(withRecord), "latin1").includes("removeSteps")])
      .toEqual([true, true, true]);
    const r1 = run(withRecord);
    expect(r1.managed).toEqual([]);   // no status read, no uninstall
    expect(r1.code).toBe(1);
    expect(r1.calls).toEqual([]);
    expect(left(withRecord)).toEqual(nothingRemoved(withRecord));
    expect(r1.err).toContain(`a schedule record exists (${withRecord.record})`);
    expect(r1.err).toContain(`${join(withRecord.support, "daily-briefing")}, is missing, not executable, ${NOT_NEW_ENOUGH},`);
    expect(r1.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);
    expect(r1.err).not.toContain("schedule uninstall failed");

    const nothing = fixture({ managed: "worded-not-executable" });
    const r2 = run(nothing);
    expect(r2.managed).toEqual([]);
    expect(r2.code).toBe(0);
    expect(callsTo(r2, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
    expect(left(nothing)).toEqual(ALL_REMOVED);
  });
});

describe("uninstall.sh: the one-shot read-only check (no record, no plist, no new enough engine)", () => {
  test("each reports not found -> it carries on: print gui, print user and list, once each, and nothing else", () => {
    const fx = fixture({ managed: "not-executable" });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
    expect(left(fx)).toEqual(ALL_REMOVED);
    expect(r.stdout).toMatch(/^Uninstalled\.$/m);
  });

  test("3.1.5's not-found rule: a silent exit 113, the service text with any code, and print user's missing domain all carry on", () => {
    for (const [name, launchd] of [
      ["silent 113", { gui: [113, ""], user: [113, ""], list: [113, ""] }],
      ["service text, other codes", { gui: [3, NOT_FOUND], user: [5, NOT_FOUND], list: [1, NOT_FOUND] }],
      ["print user: no domain (113)", { user: [113, NO_DOMAIN] }],
      ["print user: no domain (other code)", { user: [125, NO_DOMAIN] }],
    ] as const) {
      const fx = fixture({ managed: "not-executable" });
      const r = run(fx, [], { launchd: launchd as RunOpts["launchd"] });
      expect(`${name}: ${r.code}`).toBe(`${name}: 0`);
      expect(callsTo(r, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
      expect(left(fx)).toEqual(ALL_REMOVED);
    }
  });

  test("anything else stops with the steps and removes nothing: print gui's missing domain, any exit 0, a code with no text", () => {
    for (const [name, launchd] of [
      ["print gui: no domain", { gui: [113, NO_DOMAIN] }],
      ["print gui: no domain and the service text", { gui: [113, `${NOT_FOUND}\n${NO_DOMAIN}`] }],
      ["print gui finds it", { gui: [0, ""] }],
      ["print user finds it", { user: [0, ""] }],
      ["list finds it", { list: [0, ""] }],
      ["list: another code, no text", { list: [1, ""] }],
      ["list: 113 with the domain text", { list: [113, NO_DOMAIN] }],   // the domain text never counts, whatever the code
      ["print gui: another code, other text", { gui: [5, "Bad request."] }],
    ] as const) {
      const fx = fixture({ managed: "not-executable" });
      const r = run(fx, [], { launchd: launchd as RunOpts["launchd"] });
      expect(`${name}: ${r.code}`).toBe(`${name}: 1`);
      expect(callsTo(r, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);   // once each, no polling
      expect(r.err).toContain("no schedule record or launchd agent file was found");
      expect(r.err).toContain(STEPS_AND_CLOSING);
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.out).not.toMatch(/^Uninstalled/m);
    }
  });

  // A job left loaded with no files (item 21's end state) is never mistaken for nothing scheduled — and an
  // older engine that is there is still never asked to remove it.
  test("both prints say not found and list exits 0 -> it stops, removes nothing, and never asks the engine to uninstall", () => {
    const fx = fixture({ managed: 0 });
    const r = run(fx, [], { status: "old", launchd: { list: [0, ""] } });
    expect(r.code).toBe(1);
    expect(engineVerbs(r)).toEqual(["schedule status --json"]);
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
    expect(r.err).toContain(STEPS_AND_CLOSING);
    expect(left(fx)).toEqual(nothingRemoved(fx));
    expect(existsSync(join(fx.support, "daily-briefing"))).toBe(true);
  });

  test("an older engine (status without removeSteps) with nothing on disk -> the read-only check decides, the engine is never asked to uninstall, and its copy is removed", () => {
    for (const opts of [{ status: "old" }, { status: "none" }, { statusRc: 2 }, { status: "old", registered: "true" }] as RunOpts[]) {
      const fx = fixture({ managed: 0 });
      const r = run(fx, [], opts);
      expect(r.code).toBe(0);
      expect(engineVerbs(r)).toEqual(["schedule status --json"]);
      expect(callsTo(r, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
      expect(left(fx)).toEqual(ALL_REMOVED);
    }
  });

  // M9 round 1 (GPT): the unrunnable binary's TEXT holds the word, so the static gate passes and the script
  // RUNS the status read — whose launch fails. That failure must read as not new enough (the read's own
  // `|| STATUS_JSON=""`, under `set -e`): never end the script there, and never lead to an uninstall attempt.
  test("a managed binary that passes the static gate but cannot be launched -> its status read fails, so not new enough: a record stops with the steps, nothing on disk takes the read-only check, and no uninstall is attempted", () => {
    const withRecord = fixture({ record: true, managed: "unrunnable" });
    // premise: the script's gate passes on this file — `[ -f ] && [ -x ] && grep -aqF removeSteps` — so the
    // status read is reached; and nothing can launch it, so the stub log stays empty whatever is asked.
    const st = statSync(binOf(withRecord));
    expect([st.isFile(), (st.mode & 0o111) !== 0, readFileSync(binOf(withRecord), "latin1").includes("removeSteps")])
      .toEqual([true, true, true]);
    const r1 = run(withRecord);
    expect(r1.code).toBe(1);
    expect(r1.managed).toEqual([]);
    expect(r1.calls).toEqual([]);
    expect(left(withRecord)).toEqual(nothingRemoved(withRecord));
    expect(r1.err).toContain(`a schedule record exists (${withRecord.record})`);
    expect(r1.err).toContain(`${STEPS_AND_CLOSING}${UPDATE_HINT}\n`);
    // No uninstall was attempted: one that failed to launch would end in the new-enough branch's own line.
    expect(r1.err).not.toContain("schedule uninstall failed");

    const nothing = fixture({ managed: "unrunnable" });
    const r2 = run(nothing);
    expect(r2.code).toBe(0);
    expect(r2.managed).toEqual([]);
    expect(callsTo(r2, LAUNCHD_TOOL)).toEqual(READ_ONLY_CHECK);
    expect(left(nothing)).toEqual(ALL_REMOVED);
    expect(r2.err).not.toContain("schedule uninstall failed");
  });

  // M9 round 2 (decision-feeding): the label this check asks launchd about, and the default agent file the
  // script judges, are hand-typed in the script — and decide whether it carries on. A label that drifted from
  // the one the engine installs would ask about a job nobody installs, hear "not found" and carry on. So both
  // are pinned to the engine's ONE label (`SCHEDULE_LABEL`, src/schedule/units.ts, which imports nothing).
  test("the label it asks about and the default agent file it judges are the engine's SCHEDULE_LABEL", () => {
    // Whole lines, read as text — each assigned exactly once, at the top level. M9 LOW pass (L16): a declaration
    // assigns it too — `readonly`, `export`, `local`, `declare`/`typeset` with flags — so every form is read, and
    // exactly one line may assign it.
    const lines = readFileSync(SCRIPT, "utf8").split("\n");
    const assignsLabel = /^\s*(?:(?:readonly|export|local|declare|typeset)(?:\s+-[A-Za-z]+)*\s+)?LABEL=/;
    expect(lines.filter((l) => assignsLabel.test(l))).toEqual([`LABEL="${SCHEDULE_LABEL}"`]);
    // prove-it 3b: each declaration form is caught, and a mention or a longer name is not.
    for (const form of ['LABEL="x"', 'readonly LABEL="x"', 'export LABEL="x"', '  local LABEL="x"', 'declare -r LABEL="x"', 'typeset -r -x LABEL=x']) {
      expect(`${form}: ${assignsLabel.test(form)}`).toBe(`${form}: true`);
    }
    for (const other of ['echo "$LABEL"', 'SCRIPT_LABEL="x"', 'XLABEL=1', '# LABEL="x"']) {
      expect(`${other}: ${assignsLabel.test(other)}`).toBe(`${other}: false`);
    }
    const plist = lines.filter((l) => /^\s*PLIST=/.test(l));
    expect(plist).toHaveLength(1);
    const fallback = /^PLIST="\$\{DBA_TEST_PLIST:-([^}]+)\}"$/.exec(plist[0] ?? "")?.[1] ?? null;
    expect(fallback?.endsWith(`/${SCHEDULE_LABEL}.plist`)).toBe(true);
  });
});

describe("uninstall.sh: what a finished run says, and what the script can never do", () => {
  test("a run that finishes says the settings folder is kept; a run that stops does not", () => {
    const doneFx = fixture({ managed: "not-executable" });
    const done = run(doneFx);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain(`${SETTINGS_KEPT}\n`);
    expect(left(doneFx)).toEqual(ALL_REMOVED);   // M9 LOW pass (L13)
    const stoppedFx = fixture({ record: true, managed: "absent" });
    const stopped = run(stoppedFx);
    expect(stopped.code).toBe(1);
    expect(stopped.out).not.toContain(SETTINGS_KEPT);
    expect(left(stoppedFx)).toEqual(nothingRemoved(stoppedFx));
  });

  // M9 LOW pass (L10): under `set -o pipefail`, `pmset -g sched | grep -qi …` could hide the note exactly when it
  // matched: `grep -q` exits at its first match, and a pmset still writing then dies of SIGPIPE, failing the
  // pipeline. The check now reads all of pmset's output. The padding outlasts any pipe buffer.
  test("a repeating power schedule is flagged however much pmset prints after it; no repeating schedule, no note", () => {
    const NOTE = "NOTE: a repeating power schedule is still set — if it's an orphaned daily-briefing wake, clear it with: sudo pmset repeat cancel";
    const SCHED = "Repeating power events:\n  wakepoweron at 7:15AM every day";
    for (const pad of [0, 5_000]) {
      const fx = fixture({ managed: "not-executable" });
      const r = run(fx, [], { pmset: { sched: SCHED, pad } });
      expect(`${pad}: ${r.code}`).toBe(`${pad}: 0`);
      expect(callsTo(r, "pmset")).toEqual([["-g", "sched"]]);
      expect(`${pad}: ${r.err.includes(NOTE)}`).toBe(`${pad}: true`);
      expect(left(fx)).toEqual(ALL_REMOVED);
    }
    for (const sched of ["", "Scheduled power events:\n [0]  wake at 10/06/2026 07:00:00 by 'com.apple.alarm'"]) {
      const fx = fixture({ managed: "not-executable" });
      const r = run(fx, [], sched === "" ? {} : { pmset: { sched, pad: 5_000 } });
      expect(r.code).toBe(0);
      expect(r.err).not.toContain("NOTE: a repeating power schedule");
    }
  });

  test("the script runs launchd's tool only to print and list, outside the printed steps, and removes no plist", () => {
    const src = readFileSync(SCRIPT, "utf8");
    // The printed manual steps: the one quoted here-document, which is text, never run.
    const steps = /<<'EOF_STEPS'\n[\s\S]*?\nEOF_STEPS\n/.exec(src);
    expect(steps).not.toBeNull();
    const code = src.replace(steps![0], "\n").split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const launchd = code.filter((l) => new RegExp(`\\b${LAUNCHD_TOOL}\\b`).test(l));
    expect(launchd.length).toBe(3);
    for (const l of launchd) expect(l).toMatch(new RegExp(`\\b${LAUNCHD_TOOL} (print|list) `));
    expect(code.filter((l) => new RegExp(`\\b${"system" + "ctl"}\\b`).test(l))).toEqual([]);
    // No deleter on a line naming PLIST: rm, and every other way to make the file go — unlink, rmdir, mv,
    // shred, find's -delete (Checkpoint M7 F3; an `unlink "$PLIST"` survived the old rm-only pin).
    // ⚠ M9 round 3: THE WORD LIST IS ONE LIST, and its source is `DELETER_WORDS` in
    // gui/src-tauri/tests/uninstall.rs — the Rust parity parse's matcher, which its code-line rule and its
    // comment rule share. It is read from there below, so this copy cannot drift from it again; it is
    // matched the same way: every `\`, `"` and `'` deleted, the rest ASCII-lowercased as Rust's
    // `to_ascii_lowercase` does (macOS looks a command up case-insensitively), then a whole word, or the text
    // `-delete` (M9 round 4: in any case, as Rust reads it — it lowercases first).
    const DELETER_WORDS = ["rm", "rmdir", "unlink", "mv", "shred"];
    const rustSource = readFileSync(join(ROOT, "gui/src-tauri/tests/uninstall.rs"), "utf8");
    const rustList = /\bconst DELETER_WORDS: \[&str; \d+\] = \[([^\]]*)\];/.exec(rustSource);
    expect(rustList).not.toBeNull();
    expect(rustList![1]!.split(",").map((w) => w.trim().replace(/^"|"$/g, "")).filter((w) => w !== "")).toEqual(DELETER_WORDS);
    const namesDeleter = (l: string): boolean => {
      const bare = l.replace(/[\\"']/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
      return new RegExp(`\\b(?:${DELETER_WORDS.join("|")})\\b`).test(bare) || bare.includes("-delete");
    };
    const deletesPlist = (l: string) => l.includes("PLIST") && namesDeleter(l);
    // prove-it 3b: each deleter shape is caught, so the empty list below is not vacuous.
    for (const shape of [
      'rm -f "$PLIST"',
      'unlink "$PLIST"',
      'rmdir "$PLIST"',
      'mv "$PLIST" "$PLIST.old"',
      'find "${PLIST%/*}" -name x -delete',
      'shred -u "$PLIST"',
      '"rm" -f "$PLIST"',
      'r\\m -f "$PLIST"',
      'RM -f "$PLIST"',
      'printf "%s" "$PLIST" | xargs rm',
      // M9 round 4: the Rust matcher lowercases first, so find's `-delete` counts in any case there too.
      'find "${PLIST%/*}" -name x -DELETE',
    ]) {
      expect(`${shape}: ${deletesPlist(shape)}`).toBe(`${shape}: true`);
    }
    // …and a word that only holds one is not one.
    expect(deletesPlist('echo "$PLIST" is confirmed; inform the format')).toBe(false);
    expect(code.filter((l) => l.includes("PLIST")).length).toBeGreaterThan(0);   // the filter reads lines that name it
    expect(code.filter(deletesPlist)).toEqual([]);
  });
});

describe("uninstall.sh --remove-signing-identity", () => {
  test("flag + no record -> exactly one delete-identity call, naming the identity and the scratch keychain, never the login keychain", () => {
    const fx = fixture({ record: false, managed: "not-executable" });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(0);
    expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([["delete-identity", "-c", SIGN_ID, fx.keychain]]);
    expect(r.calls.flat().some((a) => /login\.keychain/.test(a))).toBe(false);
    expect(left(fx)).toEqual(ALL_REMOVED);
    expect(r.out).toContain(`Removed the '${SIGN_ID}' code-signing identity`);
  });

  test("flag + record whose engine is absent or not executable -> refused, non-zero, nothing removed, no keychain call", () => {
    for (const managed of ["absent", "not-executable"] as const) {
      const fx = fixture({ record: true, managed });
      const r = run(fx, [FLAG]);
      expect(`${managed}: ${r.code}`).toBe(`${managed}: 1`);
      expect(r.calls).toEqual([]);
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.err).toContain(STEPS_AND_CLOSING);
    }
  });

  test("flag + a record the engine reported removing (exit 0) but left behind -> the flag's own refusal: nothing removed, no keychain call", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx, [FLAG], { record: "keep" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual(nothingRemoved(fx));
    expect(r.out).toContain("refusing --remove-signing-identity: a schedule record still exists");
    // The refusal ends at its way out. The old "the record is stale: delete $RECORD yourself" lines were
    // false in every state that reaches them (spec 3.6.6 dropped that advice; Checkpoint M7 F8).
    expect(r.err).toContain(`app's Schedule screen if the app owns it, else: "${binOf(fx)}" schedule uninstall), then re-run.\n`);
    expect(r.err.endsWith(`schedule uninstall), then re-run.\n`)).toBe(true);
    expect(r.out).not.toContain("stale");
    expect(r.out).not.toContain("yourself");
    // The engine exited 0, so it HAS removed the trigger: the refusal must not claim nothing was removed.
    expect(r.out).toContain("The engine has already removed the schedule's trigger (above); nothing else was removed.");
    expect(r.out).not.toContain("Nothing was removed");
    // Without the flag the same shape proceeds: the engine removed the trigger, so nothing still runs the
    // binary; only the identity is held back by the leftover record.
    const fx2 = fixture({ record: true, managed: 0 });
    const r2 = run(fx2, [], { record: "keep" });
    expect(r2.code).toBe(0);
    expect(left(fx2)).toEqual({ ...ALL_REMOVED, record: fx2.recordBefore });
  });

  test("flag + record kept by another owner (exit 2) -> refused: nothing removed, no keychain or launchd call", () => {
    const fx = fixture({ record: true, managed: 2 });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual(nothingRemoved(fx));
  });

  test("flag + a record the engine removes (exit 0) -> the removals proceed and the identity is deleted", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(0);
    expect(left(fx)).toEqual(ALL_REMOVED);
    expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([["delete-identity", "-c", SIGN_ID, fx.keychain]]);
  });

  test("no flag -> no keychain call, in every shape above", () => {
    // M9 LOW pass (L13): with what each shape leaves — the two that carry on remove the list, the refusal nothing.
    for (const [opts, carriesOn] of [
      [{}, true],
      [{ record: true, managed: 0 }, true],
      [{ record: true, managed: 2 }, false],
      [{ record: false, managed: "not-executable" as const }, true],
    ] as const) {
      const fx = fixture(opts);
      const r = run(fx);
      expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([]);
      expect(left(fx)).toEqual(carriesOn ? ALL_REMOVED : nothingRemoved(fx));
    }
  });

  test("DBA_TEST_DIR set without DBA_TEST_KEYCHAIN -> the flag refuses before anything runs", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx, [FLAG], { keychain: false });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.managed).toEqual([]);
    expect(left(fx)).toEqual(nothingRemoved(fx));
    expect(r.out).toContain("DBA_TEST_DIR is set without DBA_TEST_KEYCHAIN");
  });

  test("a DBA_TEST_KEYCHAIN that is not an absolute path inside DBA_TEST_DIR -> refused before anything runs (an option like -t never reaches the keychain tool)", () => {
    for (const value of [
      "-t",                                    // would parse as delete-identity's -t, leaving no keychain operand
      "-",
      "scratch.keychain-db",                   // relative
      "/elsewhere/scratch.keychain-db",        // absolute, outside DBA_TEST_DIR
    ]) {
      for (const args of [[FLAG], []]) {
        const fx = fixture({ record: true, managed: 0 });
        const r = run(fx, args, { keychain: value });
        expect(`${value} ${args.join(" ")}: ${r.code}`).toBe(`${value} ${args.join(" ")}: 1`);
        expect(r.calls).toEqual([]);
        expect(r.managed).toEqual([]);
        expect(left(fx)).toEqual(nothingRemoved(fx));
        expect(r.out).toContain("DBA_TEST_KEYCHAIN must be an absolute path inside DBA_TEST_DIR");
      }
    }
    // Never a real keychain, even inside DBA_TEST_DIR (which may be an ancestor such as $HOME): a
    // login.keychain*, anything under a Library/Keychains directory, or a symlink (here to a login-named
    // file elsewhere, so only the symlink rule and the physical check can see it).
    for (const make of [
      (fx: Fx) => `${fx.support}/login.keychain-db`,
      (fx: Fx) => `${fx.support}/login.keychain`,
      (fx: Fx) => `${fx.support}/Library/Keychains/scratch.keychain-db`,
      (fx: Fx) => { mkdirSync(join(fx.base, "elsewhere"), { recursive: true }); symlinkSync(join(fx.base, "elsewhere", "login.keychain-db"), join(fx.support, "kc-link")); return join(fx.support, "kc-link"); },
      (fx: Fx) => { mkdirSync(join(fx.base, "Library", "Keychains"), { recursive: true }); symlinkSync(join(fx.base, "Library", "Keychains"), join(fx.support, "kcdir")); return join(fx.support, "kcdir", "scratch.keychain-db"); },
    ]) {
      const fx = fixture({ record: false, managed: "not-executable" });
      const value = make(fx);
      const r = run(fx, [FLAG], { keychain: value });
      expect(`${value}: ${r.code}`).toBe(`${value}: 1`);
      expect(r.calls).toEqual([]);
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.out).toContain("never a real keychain (login.keychain*, anything under Library/Keychains) or a symlink");
    }
    // Outside DBA_TEST_DIR by a sibling path, and by a ".." escape (spelled out: join() would normalise it).
    for (const make of [(fx: Fx) => join(fx.base, "outside.keychain-db"), (fx: Fx) => `${fx.support}/../outside.keychain-db`, (fx: Fx) => `${fx.support}-sibling/x.keychain-db`, (fx: Fx) => fx.support, (fx: Fx) => `${fx.support}/`]) {
      const fx = fixture({ record: false, managed: "not-executable" });
      const value = make(fx);
      const r = run(fx, [FLAG], { keychain: value });
      expect(`${value}: ${r.code}`).toBe(`${value}: 1`);
      expect(r.calls).toEqual([]);
      expect(left(fx)).toEqual(nothingRemoved(fx));
    }
  });

  // Round 4 (G4-2): "inside DBA_TEST_DIR" is judged PHYSICALLY as well as as written. A symlinked ancestor
  // inside it — the keychain's own directory, or one further up — can carry the operand to a directory
  // outside it (here a scratch one outside the test root) where no name rule sees anything wrong; and a
  // directory that cannot be resolved refuses instead of passing on its spelling alone.
  test("a DBA_TEST_KEYCHAIN that leaves DBA_TEST_DIR through a symlinked ancestor, or whose directory cannot be resolved -> refused before anything runs", () => {
    for (const make of [
      (fx: Fx) => { const out = join(fx.base, "outside"); mkdirSync(out); symlinkSync(out, join(fx.support, "kcdir")); return join(fx.support, "kcdir", "scratch.keychain-db"); },
      (fx: Fx) => { const out = join(fx.base, "outside"); mkdirSync(join(out, "deeper"), { recursive: true }); symlinkSync(out, join(fx.support, "up")); return join(fx.support, "up", "deeper", "scratch.keychain-db"); },
      (fx: Fx) => join(fx.support, "no-such-dir", "scratch.keychain-db"),
    ]) {
      for (const args of [[FLAG], []]) {
        const fx = fixture({ record: false, managed: "not-executable" });
        const value = make(fx);
        const r = run(fx, args, { keychain: value });
        expect(`${value} ${args.join(" ")}: ${r.code}`).toBe(`${value} ${args.join(" ")}: 1`);
        expect(r.calls).toEqual([]);
        expect(left(fx)).toEqual(nothingRemoved(fx));
        expect(r.out).toContain("its directory inside DBA_TEST_DIR once both are resolved physically");
      }
    }
    // A case variant of a Library/Keychains directory inside DBA_TEST_DIR: on a case-insensitive volume it
    // IS that directory, which only the canonical spelling (/bin/pwd -P) shows the case-sensitive rule;
    // where case matters the directory does not exist, so it refuses there too.
    const fx = fixture({ record: false, managed: "not-executable" });
    mkdirSync(join(fx.support, "Library", "Keychains"), { recursive: true });
    const r = run(fx, [FLAG], { keychain: `${fx.support}/library/keychains/scratch.keychain-db` });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual(nothingRemoved(fx));
  });

  test("a DBA_TEST_DIR that does not exist -> a DBA_TEST_KEYCHAIN inside it is refused (neither side resolves), before anything runs", () => {
    const fx = fixture({ record: false, plist: true, managed: "not-executable" });
    rmSync(fx.support, { recursive: true, force: true });
    const r = run(fx, [FLAG], { keychain: fx.keychain });
    expect(fx.keychain.startsWith(fx.support + "/")).toBe(true);   // inside it, as written
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(existsSync(fx.plist)).toBe(true);
    expect(r.out).toContain("its directory inside DBA_TEST_DIR once both are resolved physically");
    // M9 LOW pass (L13): refused before anything — the plist byte for byte, and nothing re-created where the
    // support dir was (the test removed it, so no listed name or survivor is there to remove).
    expect(left(fx)).toEqual({
      artifacts: {}, dirs: {}, plist: fx.plistBefore, record: null, support: null,
      survivors: Object.fromEntries(Object.keys(SURVIVORS).map((n) => [n, null])),
    });
  });

  test("…while a symlink that stays inside DBA_TEST_DIR is accepted: the operand goes to the keychain tool as written", () => {
    const fx = fixture({ record: false, managed: "not-executable" });
    mkdirSync(join(fx.support, "inner"));
    symlinkSync(join(fx.support, "inner"), join(fx.support, "alias"));
    const value = join(fx.support, "alias", "scratch.keychain-db");
    const r = run(fx, [FLAG], { keychain: value });
    expect(r.code).toBe(0);
    expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([["delete-identity", "-c", SIGN_ID, value]]);
    // M9 LOW pass (L13): the run carried on, so the list is gone — and the folder and the link this case planted
    // in SUPPORT, which no list names, are still there as they were.
    expect(left(fx)).toEqual(ALL_REMOVED);
    expect(entryAt(join(fx.support, "inner"))).toEqual({});
    expect(snapshot(join(fx.support, "alias"))).toBe(`link -> ${join(fx.support, "inner")}`);
  });

  // Set but EMPTY: without DBA_TEST_DIR it is still "set" (refused); with it, the flag still needs a real
  // scratch keychain (refused), and without the flag nothing ever reaches the keychain tool.
  test("a set-but-empty DBA_TEST_KEYCHAIN -> refused wherever the identity could be reached, never a keychain call", () => {
    const noDir = fixture({ record: false, managed: "not-executable" });
    const r1 = run(noDir, [FLAG], { keychain: "", testDir: false });
    expect(r1.code).toBe(1);
    expect(r1.out).toContain("DBA_TEST_KEYCHAIN is set but DBA_TEST_DIR is not");
    expect(r1.calls).toEqual([]);
    const flag = fixture({ record: false, managed: "not-executable" });
    const r2 = run(flag, [FLAG], { keychain: "" });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("DBA_TEST_DIR is set without DBA_TEST_KEYCHAIN");
    expect(r2.calls).toEqual([]);
    expect(left(flag)).toEqual(nothingRemoved(flag));
    const noFlag = fixture({ record: false, managed: "not-executable" });
    const r3 = run(noFlag, [], { keychain: "" });
    expect(r3.code).toBe(0);
    expect(callsTo(r3, KEYCHAIN_TOOL)).toEqual([]);
    expect(left(noFlag)).toEqual(ALL_REMOVED);
  });

  test("DBA_TEST_KEYCHAIN without DBA_TEST_DIR -> refused before anything runs, with or without the flag", () => {
    for (const args of [[FLAG], []]) {
      const fx = fixture({ record: false, managed: "not-executable" });
      // Without DBA_TEST_DIR the support dir resolves under HOME, which is scratch: seed it, so a run that
      // got past the refusal would visibly remove something.
      const defaultSupport = join(fx.home, "Library", "Application Support", "daily-briefing");
      mkdirSync(defaultSupport, { recursive: true });
      writeFileSync(join(defaultSupport, "briefing.log"), "x");
      const r = run(fx, args, { testDir: false });
      expect(`${args.join(" ")}: ${r.code}`).toBe(`${args.join(" ")}: 1`);
      expect(r.calls).toEqual([]);
      expect(r.managed).toEqual([]);
      expect(existsSync(join(defaultSupport, "briefing.log"))).toBe(true);
      expect(left(fx)).toEqual(nothingRemoved(fx));
      expect(r.out).toContain("DBA_TEST_KEYCHAIN is set but DBA_TEST_DIR is not");
    }
  });

  test("a failed deletion -> the files are still removed, and the exit is non-zero with a warning and an honest last line", () => {
    const fx = fixture({ record: false, keychainExit: 44 });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(1);
    expect(left(fx)).toEqual(ALL_REMOVED);
    expect(r.out).toContain("WARN: could not delete");
    expect(r.out).toContain(`Uninstalled, except the '${SIGN_ID}' identity, which could not be deleted`);
    expect(r.out).not.toMatch(/^Uninstalled\.$/m);
    expect(r.stdout).toContain(SETTINGS_KEPT);   // the run finished its removals, so the kept folder is named
  });

  test("an unknown argument -> usage, exit 2, nothing removed and nothing called", () => {
    const fx = fixture({ record: false });
    const r = run(fx, ["--remove-signing-identiy"]);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual(nothingRemoved(fx));
  });

  test("the script calls the keychain tool by NAME, never by an absolute path (the PATH stub must be able to intercept it)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    for (const dir of ["/usr/bin/", "/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"]) expect(src).not.toContain(dir + KEYCHAIN_TOOL);
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const uses = code.filter((l) => new RegExp(`(^|[\\s;&|(])\\S*${KEYCHAIN_TOOL}\\s`).test(l));
    expect(uses.map((l) => l.trim())).toEqual([`if ${KEYCHAIN_TOOL} delete-identity -c "$SIGN_ID" "$KEYCHAIN"; then`]);
  });
});
