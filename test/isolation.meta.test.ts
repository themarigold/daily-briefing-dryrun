// A0 — the test-suite isolation meta-test. Three static scanners over test/, in the shape
// `posture.test.ts` already established (scan the SOURCE, keep an allowlist whose every entry carries a
// written reason, and floor the match count so a regex that stops matching fails loudly instead of
// passing vacuously).
//
// WHY it exists, measured rather than assumed. `src/marker.ts:9-14` resolves the state directory from
// `DAILY_BRIEFING_STATE_DIR` first and from the real user location otherwise
// (`~/Library/Application Support/daily-briefing` on macOS). Only 8 of 96 test files set that variable.
// A probe run of the whole suite with `HOME` redirected at a scratch directory created
// `<HOME>/Library/Application Support/daily-briefing/provider-cwd` — i.e. against a developer's real
// `HOME` the suite was writing into the same directory that holds `account-state.json`, `last-run` and
// the archived briefings. Per-file probing attributed it to `harden.activation.test.ts` and
// `provider.credential.test.ts`, both of which call `hardenedProvider(...)` with no `stateDir`, and
// `src/harden.ts` (`cwdOnce`) falls back to `supportDir()` for the provider cwd.
//
// So this is NOT a hypothetical guard: it was written against a live leak, and the fix it forced is the
// one-line `import "./fixtures/isolate-state"` that now appears in the files it caught.
//
// The SECOND scanner covers the other never-reach class: a test must not drive a privileged, machine-wide
// binary (`launchctl` and friends), and must not run `scripts/uninstall.sh` without the
// `DBA_TEST_DIR` / `DBA_TEST_PLIST` redirections that script reads (its `SUPPORT=` and `PLIST=` lines). One
// dropped variable there is a `launchctl unload` of the author's LIVE agent. `scripts/install.sh` is
// BANNED outright rather than conditioned, because it reads no redirection at all — see INSTALLER_BANNED.
//
// The THIRD scanner covers the sibling live-user-state sink the first one does not reach: the config
// file under `XDG_CONFIG_HOME ?? ~/.config` (`src/config.ts:47,303`).

import { test, expect } from "bun:test";
import { Glob } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const TEST_DIR = new URL("./", import.meta.url).pathname;
/** Sibling surface the walk below also follows into: test files import `../scripts/*` directly
 *  (`test/audit-main.test.ts:21`, `test/inspect-whys.test.ts:13`) and those modules reach the same
 *  sinks — `scripts/audit.ts:64` calls `supportDir()`, `scripts/eval.ts:135` calls `resolveForScript()`. */
const SCRIPTS_DIR = resolve(TEST_DIR, "../scripts") + "/";
const SELF = "isolation.meta.test.ts";

/** Every test file, as a path relative to test/ (e.g. "eval/gold.test.ts"), sorted for stable output. */
async function testFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Glob("**/*.test.ts").scan({ cwd: TEST_DIR })) out.push(f);
  return out.sort();
}

/** Strip comments before matching. A trigger named only in prose is not a call — `posture.test.ts` and
 *  `transcripts-join.test.ts` both DISCUSS `supportDir()`/`hardenedProvider(` in comments and touch no
 *  state (measured), and forcing an allowlist entry for a comment would train the reader to wave entries
 *  through.
 *
 *  This is a small hand-rolled TOKENISER rather than a regex, because both regex attempts failed in the
 *  DANGEROUS direction — silently deleting code, which turns a real offender into a pass:
 *   1. stripping block comments with a regex of their own: `render.legend.test.ts:318` contains the glob
 *      string "packages" followed by a slash-star, which opened a phantom block comment that ran to the
 *      next genuine terminator and swallowed the `DAILY_BRIEFING_STATE_DIR` line the guard looks for.
 *   2. consuming string/template literals first (the previous fix): a REGEX literal is not a string
 *      literal, so `/pkgs\/*\.ts/` — an ordinary workspace-glob regex — reopened exactly the same hole.
 *      Reproduced end-to-end before this rewrite: a file with a real `hardenedProvider({})` call, that
 *      regex above it and a `/** … *\/` block below it, dropped out of the touching set entirely.
 *  A tokeniser has no third case of this kind: every construct that can contain a slash is consumed as
 *  itself.
 *
 *  String and template literals are handed back UNCHANGED (scanner 2 reads them; see `literals()`).
 *  Comments AND regex literals become a single space: both are data, never a call — which is also why
 *  `posture.test.ts` (whose `hardenedProvider(` occurrences are regex literals matched against other
 *  files' text) no longer needs a state allowlist entry.
 *
 *  Regex-vs-division is decided from the preceding significant token, the standard heuristic: after
 *  `)` only when that paren closed an `if`/`for`/`while`/`switch`/`catch` condition, after `}`, after an
 *  operator or opener, or after a keyword that cannot be followed by division. Stripping is applied per
 *  FILE and only then joined, so no mis-strip can cross a file boundary. */
function stripComments(src: string): string {
  const out: string[] = [];
  const OPENERS = new Set("(,=:[!&|?{;+-*%~^<>".split(""));
  const REGEX_OK_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await|throw)$/;
  const CONTROL_WORD = /(?:^|[^\w$])(?:if|for|while|switch|catch|with)$/;
  const parens: boolean[] = [];
  let prev = "";              // last significant (non-whitespace) character kept
  let word = "";              // identifier run ending at `prev`, for `return /re/`
  let lastParenControl = false;
  const keep = (chunk: string): void => {
    out.push(chunk);
    for (const ch of chunk) {
      if (/\s/.test(ch)) continue;
      if (ch === "(") parens.push(CONTROL_WORD.test(word));
      else if (ch === ")") lastParenControl = parens.pop() ?? false;
      prev = ch;
      word = /[\w$]/.test(ch) ? word + ch : "";
    }
  };
  const regexAllowed = (): boolean => {
    if (prev === "") return true;
    if (prev === ")") return lastParenControl;
    if (prev === "}") return true;
    if (OPENERS.has(prev)) return true;
    return REGEX_OK_AFTER_WORD.test(word);
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {              // line comment
      while (i < n && src[i] !== "\n") i++;
      out.push(" ");
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {              // block comment
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out.push(" ");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {          // string / template literal — kept verbatim
      const start = i;
      i++;
      while (i < n) {
        const d = src[i]!;
        if (d === "\\") { i += 2; continue; }
        if (d === c) { i++; break; }
        if (d === "\n" && c !== "`") break;             // unterminated quote: bail, never eat the file
        i++;
      }
      keep(src.slice(start, i));
      continue;
    }
    if (c === "/" && regexAllowed()) {                  // regex literal — the hole that reopened twice
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;                          // a regex literal cannot span lines
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { j++; closed = true; break; }
        j++;
      }
      if (closed && j > start + 2) {                    // `//` is a comment, handled above
        while (j < n && /[dgimsuvy]/.test(src[j]!)) j++;
        i = j;
        out.push(" ");
        prev = "/"; word = "";
        continue;
      }
    }
    keep(c);
    i++;
  }
  return out.join("");
}

/** A test file's own source plus the source of every helper it imports from inside test/ OR scripts/ —
 *  transitively. Both scanners read this union, so "sets the env var via a shared helper", "spawns via a
 *  helper" and "reaches supportDir() through scripts/audit.ts" are all visible.
 *
 *  The walk runs over the STRIPPED text, not the raw text. Over the raw text a commented-out
 *  `// import "./fixtures/isolate-state";` still pulled the fixture's source into the union, so the guard
 *  read the fixture's assignment and reported a file that had just disabled its own isolation as
 *  isolated — reproduced before this fix. Type-only imports are dropped for the same reason: they are
 *  erased at runtime and their module never evaluates. */
function sourceWithHelpers(rel: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const visit = (abs: string): void => {
    if (seen.has(abs)) return;
    seen.add(abs);
    let txt: string;
    try { txt = readFileSync(abs, "utf8"); } catch { return; }
    const stripped = stripComments(txt);
    parts.push(stripped);   // per FILE — see stripComments: a mis-strip must not cross files
    const runtime = stripped.replace(/\bimport\s+type\b[^;\n]*/g, " ");
    for (const m of runtime.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      const spec = m[1]!;
      for (const cand of [spec, `${spec}.ts`, `${spec}/index.ts`]) {
        const p = resolve(dirname(abs), cand);
        if ((p.startsWith(TEST_DIR) || p.startsWith(SCRIPTS_DIR)) && existsSync(p) && statSync(p).isFile()) { visit(p); break; }
      }
    }
  };
  visit(resolve(TEST_DIR, rel));
  return parts.join("\n");
}

test("the comment stripper keeps prose out and code in — including the glob and regex-literal cases", () => {
  // Every finding of scanner 1 rests on this function, so its two failure directions are pinned rather
  // than assumed. Direction 1: prose must not count as a call (or the allowlist fills with noise).
  expect(stripComments("// calls supportDir( here\nconst x = 1;")).not.toContain("supportDir(");
  expect(stripComments("/** discusses runCore( at length */\nconst y = 2;")).not.toContain("runCore(");
  // Direction 2, the one that actually bit twice: something containing a slash-star must not eat what
  // follows. (a) a STRING containing a glob.
  const glob = 'const r = { roots: ["packages/' + '*"] };\nprocess.env.DAILY_BRIEFING_STATE_DIR = d;\n/** later doc */';
  expect(stripComments(glob)).toContain("DAILY_BRIEFING_STATE_DIR");
  // (b) a REGEX literal containing one — the reproduced case that defeated the string-literal fix.
  const re = 'const GLOB_RE = /pkgs\\/' + '*\\.ts/;\nhardenedProvider({});\nprocess.env.DAILY_BRIEFING_STATE_DIR = d;\n/** doc */';
  const reStripped = stripComments(re);
  expect(reStripped).toContain("hardenedProvider(");
  expect(reStripped).toContain("DAILY_BRIEFING_STATE_DIR");
  // A regex literal is DATA, so a trigger spelled inside one is not a call (posture.test.ts's shape).
  expect(stripComments("const t = /hardenedProvider\\(/;")).not.toContain("hardenedProvider(");
  // Division must not be mistaken for a regex opener, or real code would be deleted silently.
  expect(stripComments("const q = (a + b) / c; const r = d / e;\nrunCore();"))
    .toContain("runCore()");
  expect(stripComments("if (x) { a = 1; }\nconst z = y / 2;\nstampToday();")).toContain("stampToday()");
  // A comment after code on one line goes; the code and the literal stay.
  expect(stripComments('const u = "https://x/y"; // supportDir( in a trailing comment'))
    .toBe('const u = "https://x/y";  ');
});

// ── scanner 1: state-dir isolation ──────────────────────────────────────────────────────────────────

type Trigger = { token: string; why: string; re?: RegExp };

/** A file is STATE-TOUCHING when it names any of these. Each entry is a call site that can reach the
 *  REAL state directory, and each carries the reason it can — an entry whose reason no longer holds
 *  should be deleted, not silently tolerated.
 *
 *  Tuned against the source, not guessed. Two candidates from the original brief are deliberately ABSENT:
 *   • `resolveAccount(` — PURE (`src/account.ts:63` takes the already-loaded state as an argument), so it
 *     cannot reach disk; including it would have flagged `account.test.ts` for a function that reads
 *     nothing.
 *   • `from "../src/core"` — importing `core` is not itself a state touch (most importers pull pure
 *     helpers); `runCore(` below is the entry point that actually reaches the sink.
 *  `account-state` is absent because no test names the file directly; `accountStatePath(` covers it. */
const STATE_TRIGGERS: Trigger[] = [
  { token: "hardenedProvider(", why: "src/harden.ts `cwdOnce` — `opts.stateDir ?? supportDir()`; a call omitting stateDir writes <real state>/provider-cwd. This is the trigger that caught the live leak." },
  { token: "runCore(", why: "src/core.ts `persistHealth` — writes transcript-health.json under supportDir() unless deps.persistHealth is injected." },
  // A regex, not a literal: the string form pinned ONE depth and ONE quote style, so `../../src/main`
  // (what the 14 files under test/eval/ must write), `../src/main.ts` and `'../src/main'` all slipped it.
  // ⚠ The dynamic form too: transcripts-safety.test.ts reaches run() through `await import("../src/main")`
  // inside a test body, which the static `from` spelling missed — so the file behind the 2026-09-15
  // live-state write (see test/fixtures/isolate-state.ts) was never classified as touching state at all.
  { token: 'from "../src/main"', re: /(?:from|import)\s*\(?\s*["'](?:\.\.\/)+src\/main(?:\.ts)?["']/, why: "run()/dispatch() drive the whole marker + account state machine (last-run, briefing-latest.md, account-state.json)." },
  { token: "supportDir(", why: "src/marker.ts:16 — resolves the real state dir directly." },
  { token: "logPath(", why: "src/marker.ts:21 — <state>/briefing.log; rotation truncates it in place." },
  { token: "tickPath(", why: "src/marker.ts:57 — <state>/last-tick." },
  { token: "markerPath(", why: "src/marker.ts:99 — <state>/last-run, the ran-today marker." },
  { token: "latestBriefingPath(", why: "src/marker.ts:111 — <state>/briefing-latest.md, overwritten per run." },
  { token: "archivedBriefingPath(", why: "src/marker.ts:140 — <state>/briefings/<date>.md." },
  { token: "rotateLogIfLarge(", why: "src/marker.ts:29 — defaults to logPath(); truncates the real log." },
  { token: "stampToday(", why: "src/marker.ts:227 — writes the ran-today marker. No stateDir parameter exists." },
  { token: "stampTick(", why: "src/marker.ts:82 — writes the heartbeat. No stateDir parameter exists." },
  { token: "markerExists(", why: "src/marker.ts:105 — reads the real marker." },
  { token: "checkRanToday(", why: "src/marker.ts:200 — reads the real marker." },
  { token: "alreadyRanToday(", why: "src/marker.ts:221 — reads the real marker." },
  { token: "readLastRunDate(", why: "src/marker.ts:163 — reads the real marker." },
  { token: "accountStatePath(", why: "src/account.ts:40 — stateDir DEFAULTS to supportDir()." },
  { token: "loadAccountState(", why: "src/account.ts:89 — stateDir is OPTIONAL; omitting it reads the real account-state.json." },
  { token: "recordLimit(", why: "src/account.ts:146 — stateDir OPTIONAL; omitting it REWRITES the real account-state.json (the corruption class this test exists for)." },
  { token: "recordAuthProbe(", why: "src/account.ts:174 — stateDir OPTIONAL; rewrites the real account-state.json." },
  { token: "clearMark(", why: "src/account.ts:158 — stateDir OPTIONAL; rewrites the real account-state.json." },
  { token: "clearLastLimit(", why: "src/account.ts:186 — stateDir OPTIONAL; rewrites the real account-state.json." },
  { token: "resolveForScript(", why: "src/account.ts:361 — the script-side account resolver; reaches the same store." },
  // ── A1's new state-dir sinks. Added WITH the code that created them, not after a leak: every one
  // resolves through `supportDir()` with no stateDir parameter, which is the same shape as the
  // entries above and the same shape as the live leak this file was written against.
  { token: "lastSkipPath(", why: "src/marker.ts — <state>/last-skip.json; resolves via supportDir()." },
  { token: "writeLastSkip(", why: "src/marker.ts — WRITES <state>/last-skip.json. No stateDir parameter exists." },
  { token: "clearLastSkip(", why: "src/marker.ts — UNLINKS <state>/last-skip.json." },
  { token: "readLastSkip(", why: "src/marker.ts — reads <state>/last-skip.json." },
  { token: "runLockPath(", why: "src/runlock.ts — <state>/run.lock; stateDir DEFAULTS to supportDir()." },
  { token: "acquireRunLock(", why: "src/runlock.ts — CREATES <state>/run.lock when `path` is omitted, and can unlink an existing one." },
  { token: "statePaths(", why: "src/json.ts — resolves every state path through supportDir()/configPath()." },
  { token: "statusReport(", why: "src/json.ts — reads the real state dir (marker, tick, log, briefings) when unisolated." },
  { token: "doctorReport(", why: "src/json.ts — reads the real config and walks the configured repos." },
  // ── A2's new state-dir sinks (Slice 4 scheduling). Added WITH the code, same policy as A1's block
  // above: every one resolves through `supportDir()`/`stateDirFor()` with no stateDir parameter.
  { token: "schedulePath(", why: "src/schedule/install.ts — <state>/schedule.json; resolves via supportDir()." },
  { token: "readScheduleRecord(", why: "src/schedule/install.ts — READS <state>/schedule.json when `path` is omitted." },
  { token: "writeScheduleRecord(", why: "src/schedule/install.ts — WRITES <state>/schedule.json when `path` is omitted." },
  { token: "installSchedule(", why: "src/schedule/install.ts — copies a binary into the state dir and writes <state>/schedule.json." },
  { token: "uninstallSchedule(", why: "src/schedule/install.ts — UNLINKS <state>/schedule.json and the unit file." },
  { token: "verifySchedule(", why: "src/schedule/install.ts — reads the real last-run and last-skip.json while polling for evidence." },
  { token: "scheduleStatusReport(", why: "src/schedule/status.ts — reads the whole state dir (schedule.json, tick, marker, last-skip)." },
  { token: "managedBinPath(", why: "src/schedule/install.ts — resolves through stateDirFor(); on darwin that IS the state dir." },
  // ── A3's new state-dir sink. Added WITH the code, same policy as A1's and A2's blocks above.
  // ⚠ NOT OPTIONAL: `buildProvider` is now the ONLY construction path for a CLI provider, and its CLI
  // arm returns `hardenedProvider(cfg, opts)` — so a call omitting `stateDir` writes
  // <real state>/provider-cwd exactly as the direct call did. The `hardenedProvider(` trigger above no
  // longer sees those sites, so without this entry A3 would have REMOVED coverage from the very trigger
  // whose comment records catching the live leak.
  { token: "buildProvider(", why: "src/providerFactory.ts — the CLI arm returns hardenedProvider(cfg, opts); a call omitting stateDir writes <real state>/provider-cwd. This replaced the direct hardenedProvider( calls at all four construction sites." },
  // ── Tier B's state-dir sink (T4.3). Added WITH the code, same policy as the A1–A3 blocks above.
  { token: "recapCampaignsPath(", why: "src/marker.ts — <state>/recap-campaigns.jsonl, tier B's append-only trial record; resolves via supportDir()." },
  // T4.4: the phase itself. Its caller hands it the record writer, but a test that drives it with the
  // production-shaped writer (core.ts's fallback appends to recapCampaignsPath()) writes the state dir.
  { token: "runRecapCampaignsPhase(", why: "src/recapCampaignsPhase.ts — tier B's phase; with core.ts's fallback writer it appends <state>/recap-campaigns.jsonl." },
  // ── Phase E (E11)'s state-dir sink: the opt-in update check. Added WITH the code, same policy as the
  // blocks above — every one defaults its `path` to `updateCheckPath()`, i.e. supportDir().
  { token: "updateCheckPath(", why: "src/marker.ts — <state>/update-check.json, the update check's last answer; resolves via supportDir()." },
  { token: "checkForUpdate(", why: "src/updateCheck.ts — the manual check; READS and REWRITES <state>/update-check.json when `path` is omitted." },
  { token: "autoUpdateCheck(", why: "src/updateCheck.ts — the automatic path; reads the config and <state>/update-check.json, and rewrites the latter, when `path` is omitted." },
  { token: "readUpdateCheckState(", why: "src/updateCheck.ts — READS <state>/update-check.json when `path` is omitted." },
  { token: "writeUpdateCheckState(", why: "src/updateCheck.ts — WRITES <state>/update-check.json when `path` is omitted." },
];

/** Does this source name the trigger? Call-shape tokens (`name(`) also match an ALIASED import
 *  (`import { hardenedProvider as mkProvider } from "../src/harden"`), which otherwise bypasses the whole
 *  table — reproduced: an aliased `hardenedProvider` call was classified as not-touching. */
function triggerMatches(t: Trigger, src: string): boolean {
  if (t.re?.test(src)) return true;
  if (src.includes(t.token)) return true;
  if (t.token.endsWith("(")) {
    const name = t.token.slice(0, -1);
    return new RegExp(`\\b${name}\\s+as\\s+[A-Za-z_$]`).test(src);
  }
  return false;
}

/** Does this source (a file plus the helpers it imports — see `sourceWithHelpers`, whose text is already
 *  comment-stripped) STATICALLY import `fixtures/isolate-state`, so the baseline and the tripwire exist
 *  before the file's first line runs?
 *
 *  This replaced a check that the file SETS the variable, and the 2026-09-15 live-state write is why: the
 *  file that caused it, transcripts-safety.test.ts, set DAILY_BRIEFING_STATE_DIR correctly — it saved the
 *  prior value first, and the prior value was `undefined` because nothing had armed a baseline yet (see
 *  test/fixtures/isolate-state.ts). test/preload.ts arms it before every file, but only when bun runs from
 *  the package root; the import is what holds from any cwd. Type-only imports are erased at runtime, and a
 *  dynamic `import()` of the fixture runs after whatever preceded it, so neither counts in the file itself.
 *  ⚠ One gap, stated rather than closed: `sourceWithHelpers` also follows a dynamic `import()` of a HELPER,
 *  so a helper loaded late that statically imports the fixture is still credited. No test does this today. */
function importsIsolation(src: string): boolean {
  const runtime = src.replace(/\bimport\s+type\b[^;\n]*/g, " ");
  return /\bimport\s*(?:[\w$*{},\s]+\sfrom\s*)?["'](?:\.\.?\/)+(?:fixtures\/)?isolate-state(?:\.ts)?["']/.test(runtime);
}

/** State-touching files that legitimately do NOT import the fixture. Every entry needs a reason that is
 *  a PROPERTY of the file, not "it seemed fine" — the difference between an allowlist and simply
 *  deleting the guard. */
const STATE_ALLOW: Record<string, string> = {
  [SELF]: "this file IS the scanner: every trigger above appears here as a table entry, never as a call.",
  "posture.test.ts": "a SOURCE scanner over scripts/*.ts. Its regex-literal occurrences of `hardenedProvider(` are now stripped as data; what still matches is the failure-message template at test/posture.test.ts:271, which is text, not a call. Measured: a HOME-redirected run of it alone creates no state directory.",
};

test("every state-touching test file isolates DAILY_BRIEFING_STATE_DIR", async () => {
  const files = await testFiles();
  // Floors, so a broken Glob or a broken trigger table fails loudly rather than passing vacuously.
  // ⚠ RE-MEASURED AND RE-FLOORED WITH A1, which is the policy this guard's own comment below states
  // and which the first cut of A1 broke: it added 9 STATE_TRIGGERS, 2 CONFIG_TRIGGERS and 4
  // state-touching test files while leaving both floors where A0 put them, so 90-vs-97 quietly became
  // 90-vs-101 and the state-touching margin went from the stated 2 to ~6 — i.e. six files could stop
  // matching (or be deleted) with the guard still green, in a guard whose documented failure mode is
  // exactly that. Measured at THIS commit by raising each floor until it failed and reading the
  // reported value: files 101, STATE_TRIGGERS 32, touching 32. Each floored two below.
  // A2: re-measured at THIS commit by raising each floor until it failed and reading the reported
  // value — files 107, STATE_TRIGGERS 40, touching 36. Each floored two below, per the policy the
  // paragraph above states and the first cut of A1 broke.
  // A3: re-measured the same way — files 114, STATE_TRIGGERS 39, touching 39. Each floored two below.
  // ⚠ STATE_TRIGGERS went 40 → 39 rather than up, and that is NOT a trigger rotting: A3 replaced the
  // four direct `hardenedProvider(` construction sites with `buildProvider(`, so the table gained one
  // entry while `isolation.meta.test.ts` itself stopped matching one of the old ones. Reading the count
  // alone would have looked like a regression; the entry is right there in the table above.
  // Tier B (T4.3): added `recapCampaignsPath(`; STATE_TRIGGERS re-measured the same way at 42, floored two
  // below. (Also measured, floors NOT moved by T4.3: files 141, touching 46 — the new trigger matches no
  // file that was not already touching state.)
  // Tier B (T4.4): added `runRecapCampaignsPhase(` and four test files (recap-campaigns.{slot,phase,dark,
  // imports}), three of them state-touching. Re-measured the same way at THIS commit — files 144 (141 at
  // T4.3, −1 for the M4a sync's upstream deletion of smoke.test.ts, +4), STATE_TRIGGERS 43, touching 49 —
  // and ALL THREE floored two below, closing the two T4.3 left wide (files 112, touching 37).
  // Tier B (T4.5): + recap-campaigns.failure (state-touching). Re-measured the same way: files 145,
  // STATE_TRIGGERS 43 (unchanged, floor stays 41), touching 50; files and touching floored two below.
  // Tier B (T4.6): + recap-campaigns.{pins,wiring,deadline}, all three state-touching. Re-measured: files
  // 148, STATE_TRIGGERS 43 (unchanged, floor stays 41), touching 53; files and touching floored two below.
  // Tier B (T5.1): + recap-campaigns.report (state-touching: it imports scripts/recap-campaigns-report.ts,
  // which names `statePaths(`). Re-measured: files 149, STATE_TRIGGERS 43 (unchanged, floor stays 41),
  // touching 54; files and touching floored two below.
  // Tier B (T5.2): + recap-campaigns.replay (state-touching: it imports scripts/recap-campaigns-replay.ts,
  // which names `statePaths(`). Re-measured: files 150, STATE_TRIGGERS 43 (floor stays 41), touching 55;
  // files and touching floored two below.
  // Phase E (M2 fix, 2026-10-01): re-measured the same way — files 158, STATE_TRIGGERS 43 (floor stays
  // 41), touching 56; files and touching floored two below.
  // Phase E (M3, 2026-10-01): re-measured the same way — files 163 (this milestone's release-check and
  // uninstall tests, plus three added on main since the M2 note), STATE_TRIGGERS 43 (floor stays 41),
  // touching 56 (unchanged: neither new file touches state); files floored two below.
  // Phase E (M4, E11, 2026-10-01): + five STATE_TRIGGERS for the update check's state file
  // (`updateCheckPath(`, `checkForUpdate(`, `autoUpdateCheck(`, `readUpdateCheckState(`,
  // `writeUpdateCheckState(`) and test/update-check.test.ts (state-touching; it isolates). Re-measured
  // the same way — files 164, STATE_TRIGGERS 48, touching 57 — and ALL THREE floored two below.
  // Phase E (M5, 2026-10-01): + four docs tests (docs-config, docs-links, reporting-channel, site), none
  // state-touching. Re-measured with this file's own Glob: files 168; STATE_TRIGGERS 48 and touching 57
  // unchanged (floors stay 46 and 55); files floored two below.
  // Phase E final harden (2026-10-02): re-measured with this file's own Glob at 174 (170 on main at
  // 98d4514db, + dispatch.help-anywhere, git.show-signature, credentials.gaps and
  // credentials.anthropic-keys — the round-1 note here said 172 and the round-3 one 173, each written
  // before a later file landed); files floored two below (round-4 harden B4-L4: it sat three below).
  expect(files.length).toBeGreaterThanOrEqual(172);
  expect(STATE_TRIGGERS.length).toBeGreaterThanOrEqual(46);

  const touching: string[] = [];
  const offenders: string[] = [];
  for (const f of files) {
    const src = sourceWithHelpers(f);
    const hit = STATE_TRIGGERS.find((t) => triggerMatches(t, src));
    if (!hit) continue;
    touching.push(f);
    if (f in STATE_ALLOW) continue;
    if (!importsIsolation(src)) {
      offenders.push(`${f} reaches real state via \`${hit.token}\` (${hit.why}) but does not import "./fixtures/isolate-state" — setting DAILY_BRIEFING_STATE_DIR in the file is not enough (a save before any baseline captures undefined; see importsIsolation) — add the import or an allowlist entry with a reason`);
    }
  }
  // A second floor: if this drops, the triggers stopped matching rather than the suite getting cleaner.
  // Re-measured by replaying the scanner at this commit rather than carried over: 28 state-touching
  // files. The previous comment claimed 22 and floored at 18; replaying the ORIGINAL scanner verbatim
  // gives 27, so neither number reproduced, and the margin it justified was nine files wide — in a guard
  // whose documented failure mode is files silently dropping out of the checked set. The new 28 is the
  // old 27 plus `audit-main.test.ts`, which the scripts/ walk now classifies (strict superset — verified
  // by diffing both sets, so none of the tokeniser changes lost a file). Floored two below the
  // measurement: deleting a couple of test files is normal, nine ceasing to match is not.
  // A1: re-measured at 32 (28 at A0 + this slice's 4 new state-touching files, all of which isolate —
  // 3 assign DAILY_BRIEFING_STATE_DIR directly and all 4 import test/fixtures/isolate-state). Floored
  // two below again, because carrying A0's 26 forward is how the margin above rotted.
  // A2: re-measured at 36 (32 at A1 + this slice's 4 state-touching files: schedule.install,
  // schedule.status, schedule.second-trigger and dispatch.schedule — all of which isolate). Floored
  // two below again, because carrying A1's 30 forward is how the margin rots.
  // Tier B (T4.4): re-measured at 49 (see the T4.4 note above); floored two below.
  // Tier B (T4.5): re-measured at 50 (see the T4.5 note above); floored two below.
  // Tier B (T4.6): re-measured at 53 (see the T4.6 note above); floored two below.
  // Tier B (T5.1): re-measured at 54 (see the T5.1 note above); floored two below.
  // Tier B (T5.2): re-measured at 55 (see the T5.2 note above); floored two below.
  // Phase E (M2 fix, 2026-10-01): re-measured at 56 (see the M2 note above); floored two below.
  // Phase E (M4, 2026-10-01): re-measured at 57 (see the M4 note above); floored two below.
  // Phase E final harden (2026-10-02, round-4 harden B4-L4): re-measured at 59 — 57 on main at 98d4514db
  // (replayed there), + dispatch.help-anywhere (new) and clip-redacts-first (round 1 gave it a `runCore(`
  // test; it isolates) — measured by diffing the two sets; floored two below.
  expect(touching.length).toBeGreaterThanOrEqual(57);
  expect(offenders).toEqual([]);
});

test("the trigger table and the set-check discriminate the shapes that slipped them", () => {
  const MAIN = STATE_TRIGGERS.find((t) => t.token === 'from "../src/main"')!;
  // The string token pinned ONE depth and ONE quote style. All three of these were measured NOT matching.
  expect(triggerMatches(MAIN, 'import { run } from "../../src/main";')).toBe(true);   // test/eval/*'s depth
  expect(triggerMatches(MAIN, 'import { run } from "../src/main.ts";')).toBe(true);
  expect(triggerMatches(MAIN, "import { run } from '../src/main';")).toBe(true);
  expect(triggerMatches(MAIN, 'import { run } from "../src/mainline";')).toBe(false);
  expect(triggerMatches(MAIN, 'const { run } = await import("../src/main");')).toBe(true);   // transcripts-safety's shape
  // Every other trigger is a call shape, which an aliased import bypassed entirely.
  const HP = STATE_TRIGGERS.find((t) => t.token === "hardenedProvider(")!;
  expect(triggerMatches(HP, 'import { hardenedProvider as mkProvider } from "../src/harden";')).toBe(true);
  expect(triggerMatches(HP, "const p = hardenedProvider({});")).toBe(true);
  expect(triggerMatches(HP, "// prose about hardenedProvider generally")).toBe(false);

  // "Isolated" means the fixture is imported statically, at any depth and through any binding form.
  expect(importsIsolation('import "./fixtures/isolate-state";')).toBe(true);
  expect(importsIsolation("import '../fixtures/isolate-state';")).toBe(true);           // test/eval/*'s depth
  expect(importsIsolation('import "./isolate-state.ts";')).toBe(true);                  // a helper inside fixtures/
  expect(importsIsolation('import { takeIsolationViolations } from "./fixtures/isolate-state";')).toBe(true);
  // …and nothing else is: a runtime SET was exactly the 2026-09-15 shape, a type-only import is erased, a
  // dynamic import runs late, a commented-out import is prose, and a longer name is a different module.
  const D = "DAILY_BRIEFING_STATE_DIR";
  expect(importsIsolation(`process.env.${D} = dir;`)).toBe(false);
  expect(importsIsolation(`env: { ...process.env, ${D}: dir }`)).toBe(false);
  expect(importsIsolation('import type { X } from "./fixtures/isolate-state";')).toBe(false);
  expect(importsIsolation('await import("./fixtures/isolate-state");')).toBe(false);
  expect(importsIsolation(stripComments('// import "./fixtures/isolate-state";\nconst x = 1;'))).toBe(false);
  expect(importsIsolation('import "./fixtures/isolate-state-extra";')).toBe(false);
});

// ── the disarm scanner ──────────────────────────────────────────────────────────────────────────────

/** The two variables test/fixtures/isolate-state.ts arms: the disarm scanner below watches both for a
 *  clear, and scanner 6 demands both of a child's env. HOME is deliberately absent; see scanner 6's rule. */
const ISOLATING_VARS = ["DAILY_BRIEFING_STATE_DIR", "XDG_CONFIG_HOME"];

/** Which of ISOLATING_VARS a disarm match names. */
const watchedIn = (text: string): string => ISOLATING_VARS.find((v) => text.includes(v))!;

/** Every way to take the isolation back off, not one spelling of it. `bun test` runs the whole suite in
 *  ONE process, so a file that clears the variable un-isolates every file scheduled AFTER it.
 *  Both armed variables are watched. The state dir came first, for the leak measured below. A cleared
 *  config dir falls back the same way: test/fixtures/isolate-state.ts records it doing so in the
 *  2026-09-15 incident, though nothing wrote it that time. `src/config.ts:51` resolves it with `??`, so
 *  `= undefined` reaches the real `~/.config` and `= ""` a path relative to the cwd. Neither is the
 *  isolated dir.
 *
 *  Measured on the run that produced this test: with `marker.test.ts` ending three of its tests with a
 *  bare `delete process.env.DAILY_BRIEFING_STATE_DIR`, a full-suite run under a redirected HOME created
 *  `<HOME>/Library/Application Support/daily-briefing/provider-cwd`; dropping ONLY marker.test.ts from
 *  the same run left the directory absent. Both halves of the suite were clean on their own, which is
 *  why per-file probing never found it — the leak lives in the ORDERING, not in any one file.
 *
 *  The needle was the literal string `delete process.env.DAILY_BRIEFING_STATE_DIR`, i.e. one spelling of
 *  the class the file exists for. Each alternative below is a disarm that spelling missed, verified by
 *  probe; `= ""` and `= undefined` matter because `src/marker.ts:10` resolves on TRUTHINESS, and because
 *  the fixture's original `??=` re-arm could not see them (an empty string is not nullish, and `= undefined`
 *  leaves the variable unset under Bun 1.3.14 — Node stores the STRING "undefined" instead — measured).
 *  Since 2026-09-19 the fixture's tripwire also blocks every one of these at RUNTIME, including spellings
 *  this regex cannot read: a clear is recorded and fails the test, `delete` throws, and
 *  `Reflect.deleteProperty` returns false. This scanner stays because it names the offending line before
 *  anything runs. */
const WATCHED = String.raw`(?:${ISOLATING_VARS.join("|")})`;
const DISARM_RE = new RegExp(
  [
    // `delete process.env.X`, and the same through any alias (`const e: any = process.env; delete e.X`)
    String.raw`delete\s+[\w$][\w$.]*\s*\.\s*${WATCHED}\b`,
    // the bracket form, on process.env or an alias
    String.raw`delete\s+[\w$][\w$.]*\s*\[\s*["'\`]${WATCHED}["'\`]\s*\]`,
    // the reflective form
    String.raw`Reflect\s*\.\s*deleteProperty\s*\(\s*[\w$][\w$.]*\s*,\s*["'\`]${WATCHED}["'\`]\s*\)`,
    // assignment to a falsy/undefined value — disarms exactly as a delete does, and cannot be a restore
    String.raw`(?:[\w$][\w$.]*\s*\.\s*${WATCHED}|[\w$][\w$.]*\s*\[\s*["'\`]${WATCHED}["'\`]\s*\])\s*=\s*(?:undefined\b|""|''|\`\`)`,
  ].join("|"),
  "g",
);

/** Is this disarm site a correct save/restore rather than an unconditional clear? Accepted shapes, all
 *  of them equally correct — the old predicate demanded the brace-less one-liner and reported the three
 *  ordinary spellings as leaks (reproduced), which is a guard prescribing an idiom narrower than its own
 *  rule:
 *    (a) `if (<cond>) delete …; else … = prev;`            — one-liner, including a nested-paren <cond>
 *    (b) `if (<cond>) { delete …; } else { … = prev; }`    — braced
 *    (c) `if (<cond>) { … = prev; } else { delete …; }`    — reversed branches
 *    (d) `cond ? delete … : (… = prev)`                    — ternary
 *  A bare `delete` with no restore anywhere in the window stays an offender, which is the whole point.
 *  The restore must be of the SAME variable `name`: restoring the other armed one guards nothing. */
function disarmGuarded(src: string, at: number, name: string): boolean {
  const before = src.slice(Math.max(0, at - 320), at);
  const after = src.slice(at, at + 320);
  const RESTORE = String.raw`(?:process\.env\s*\.\s*${name}|process\.env\s*\[\s*["'\`]${name}["'\`]\s*\])\s*=[^=]`;
  // one level of nested parens in the condition; `[^)]*` could not span `!keep(env)`
  const COND_BEFORE = /\bif\s*\((?:[^()]|\([^()]*\))*\)\s*\{?\s*$/;
  const ELSE_BEFORE = /\belse\s*\{?\s*$/;
  const TERNARY_BEFORE = /\?\s*$/;
  const elseRestoresAfter = new RegExp(String.raw`\belse\b[\s{]*` + RESTORE).test(after);
  const ternaryRestoresAfter = new RegExp(String.raw`:\s*\(?\s*` + RESTORE).test(after);
  const restoredBefore = new RegExp(RESTORE).test(before);
  if (COND_BEFORE.test(before) && elseRestoresAfter) return true;      // (a) + (b)
  if (ELSE_BEFORE.test(before) && restoredBefore) return true;         // (c)
  if (TERNARY_BEFORE.test(before) && ternaryRestoresAfter) return true; // (d)
  return false;
}

/** Descriptions of every UNGUARDED disarm in a source, plus the total number of sites seen. */
function disarms(src: string): { sites: number; unguarded: string[] } {
  const unguarded: string[] = [];
  let sites = 0;
  for (const m of src.matchAll(DISARM_RE)) {
    sites++;
    const isClear = /=\s*(?:undefined\b|""|''|``)\s*$/.test(m[0]);
    if (isClear || !disarmGuarded(src, m.index, watchedIn(m[0]))) unguarded.push(m[0]);
  }
  return { sites, unguarded };
}

test("no test file DISARMS the isolation for the files that follow it", async () => {
  const offenders: string[] = [];
  const sites = new Map(ISOLATING_VARS.map((v) => [v, 0]));
  for (const f of await testFiles()) {
    if (f === SELF) continue;   // names every disarm shape as data, in DISARM_RE above
    const text = sourceWithHelpers(f);
    for (const m of text.matchAll(DISARM_RE)) sites.set(watchedIn(m[0]), sites.get(watchedIn(m[0]))! + 1);
    for (const u of disarms(text).unguarded) {
      const v = watchedIn(u);
      offenders.push(`${f} clears ${v} unconditionally (\`${u.trim()}\`) — save and restore the prior value instead (any of the if/else, braced, reversed or ternary forms), or every test file scheduled after this one runs against the REAL ${v === "XDG_CONFIG_HOME" ? "config" : "state"} dir`);
    }
  }
  // The restore idiom is in use across the suite; if this drops the matcher stopped matching. Measured
  // at 11 sites at this commit (identical under the old literal needle — the broadened matcher adds
  // future coverage, not current noise), floored three below.
  // A2: re-measured at 17 (11 at A1 + this slice's 6 save/restore sites, which the new scheduling
  // suites need because they swap DAILY_BRIEFING_STATE_DIR, XDG_CONFIG_HOME and DBA_TEST_UNIT_DIR
  // per test). Floored three below, as before.
  // Floored PER VARIABLE since XDG_CONFIG_HOME joined the matcher: a total would let the config dir's
  // sites hide a state-dir matcher that stopped matching, and the reverse. Measured when it joined:
  // 19 state-dir sites (its floor stays at 15) and 14 config-dir sites, every one a guarded
  // save/restore. The config floor sits three below the measurement.
  expect(sites.get("DAILY_BRIEFING_STATE_DIR")).toBeGreaterThanOrEqual(15);
  expect(sites.get("XDG_CONFIG_HOME")).toBeGreaterThanOrEqual(11);
  expect(offenders).toEqual([]);
});

test("the disarm matcher sees the whole class, and the restore predicate accepts the whole idiom", () => {
  // Every row runs for BOTH armed variables. The state-dir rows are the originals; XDG_CONFIG_HOME
  // joined 2026-09-22, when the runtime tripwire already caught its clears and this scanner did not.
  for (const D of ISOLATING_VARS) {
    // Shapes the literal-string needle missed (each verified to pass the old scanner 7/0), then the
    // rest of the spellings DISARM_RE claims: the other quote styles, the bracket form on an alias and
    // as an assignment target, Reflect on an alias, and the other empty literals.
    for (const s of [
      `delete process.env.${D};`,
      `delete process.env["${D}"];`,
      `delete  process.env.${D};`,
      `const e: any = process.env; delete e.${D};`,
      `Reflect.deleteProperty(process.env, "${D}");`,
      `process.env.${D} = undefined as any;`,
      `process.env.${D} = "";`,
      `delete process.env['${D}'];`,
      `delete process.env[\`${D}\`];`,
      `const e: any = process.env; delete e["${D}"];`,
      `const e: any = process.env; Reflect.deleteProperty(e, '${D}');`,
      `process.env["${D}"] = undefined;`,
      `process.env.${D} = '';`,
      `process.env.${D} = \`\`;`,
    ]) {
      const { unguarded } = disarms(s);
      expect(unguarded.length, s).toBeGreaterThan(0);
      expect(watchedIn(unguarded[0]!), s).toBe(D);   // the offender message names the right variable
    }
    // …and the four correct restores, every one of which the old predicate called a leak.
    const guarded = [
      `const prev = process.env.${D};\nif (prev === undefined) delete process.env.${D}; else process.env.${D} = prev;`,
      `const prev = process.env.${D};\nif (prev === undefined) {\n  delete process.env.${D};\n} else {\n  process.env.${D} = prev;\n}`,
      `const prev = process.env.${D};\nif (prev !== undefined) { process.env.${D} = prev; } else { delete process.env.${D}; }`,
      `const prev = process.env.${D};\nif (typeof prev === "undefined" && !keep(env)) delete process.env.${D}; else process.env.${D} = prev;`,
      `const prev = process.env.${D};\nprev === undefined ? delete process.env.${D} : (process.env.${D} = prev);`,
    ];
    for (const g of guarded) {
      expect(disarms(g)).toEqual({ sites: 1, unguarded: [] });
    }
    // The guard must still be a guard: a bare delete, and a delete whose `else` restores a DIFFERENT
    // variable, are both offenders — including the OTHER armed one, which guards nothing here.
    const other = ISOLATING_VARS.find((v) => v !== D)!;
    expect(disarms(`afterEach(() => { delete process.env.${D}; });`).unguarded.length).toBe(1);
    expect(disarms(`if (p === undefined) delete process.env.${D}; else process.env.OTHER = p;`).unguarded.length).toBe(1);
    expect(disarms(`if (p === undefined) delete process.env.${D}; else process.env.${other} = p;`).unguarded.length).toBe(1);
  }
  // A longer name that merely starts with a watched one is not it.
  expect(disarms("delete process.env.XDG_CONFIG_HOME_OLD; delete process.env.DAILY_BRIEFING_STATE_DIR2;").sites).toBe(0);
  // Scanner 6's KNOWN MISS "a clear through an alias of the env binding" says this scanner catches it.
  expect(disarms('const env = { ...process.env };\nconst e2 = env;\ndelete e2.XDG_CONFIG_HOME;').unguarded).toEqual(["delete e2.XDG_CONFIG_HOME"]);
});

test("every allowlist entry still names a real file, and still covers something", async () => {
  // A stale exemption is worse than none: it reads as a considered decision while covering nothing.
  // REACH_ALLOW gets the same treatment as STATE_ALLOW — it is the higher-consequence list, and the
  // asymmetry meant the first real entry added there would have been unprotected by the rule this file
  // argues for elsewhere.
  const files = new Set(await testFiles());
  expect(Object.keys(STATE_ALLOW).filter((k) => !files.has(k))).toEqual([]);
  expect(Object.keys(REACH_ALLOW).filter((k) => !files.has(k))).toEqual([]);
  expect(Object.keys(CONFIG_ALLOW).filter((k) => !files.has(k))).toEqual([]);
  // Beyond existing: a STATE_ALLOW entry for a file that is no longer state-touching is dead text.
  const dead = Object.keys(STATE_ALLOW).filter((k) => !STATE_TRIGGERS.some((t) => triggerMatches(t, sourceWithHelpers(k))));
  expect(dead).toEqual([]);
});

// ── scanner 2: never-reach ──────────────────────────────────────────────────────────────────────────

/** Machine-wide binaries a test must never drive directly. `launchctl` is the sharp one — the author's
 *  own briefing agent is a launchd job, so a stray `launchctl unload` in a test unloads the LIVE agent —
 *  but the rest are the same class: they mutate state outside the repo and outside any tmpdir. */
const FORBIDDEN_BINARIES = ["launchctl", "systemctl", "schtasks", "security", "codesign"];

/** Command position only, so prose cannot false-fail this. `security` appears inside ordinary test names
 *  ("a security invariant now", test/provider.incomplete-read.test.ts:352) and must not match.
 *
 *  Three gaps, all measured, all in the direction of missing a real spawn — and since the suite names
 *  none of these binaries today, the case missed IS the case the guard exists for:
 *   • no `\n` in the prefix class while `literals()` deliberately captures MULTI-LINE template literals,
 *     so a `bash -c` shell script was invisible past its first line — the single most likely way a future
 *     test would drive launchctl;
 *   • no quote in the prefix class, so `bash -c 'launchctl unload x'` did not match either;
 *   • no path prefix, so `/bin/launchctl`, `/usr/bin/security` and `/usr/bin/codesign` all passed.
 *  `;` is now also a terminator (`"launchctl;"` was neither `\s` nor end-of-string). */
const commandUse = (literal: string, bin: string): boolean =>
  new RegExp(`(?:^|[;&|(\\n'"\`]\\s*|\\bsudo\\s+)(?:[\\w.-]*/)*${bin}(?:\\s|$|[;&|)'"\`])`).test(literal);

/** String literals of a source, contents only. */
function literals(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) {
    out.push(m[0].slice(1, -1));
  }
  return out;
}

/** Files allowed to name a forbidden binary in command position, with the seam that makes it safe. */
const REACH_ALLOW: Record<string, string> = {
  [SELF]: "this file IS the scanner: the binary names above are its subject matter, never a spawn.",
};

/**
 * ⚠ A CONDITIONAL exemption, not a blanket one — and the distinction is the whole reason it exists.
 *
 * `schedule.install.test.ts` is the suite's ONLY exerciser of the scheduler installer, so it ASSERTS
 * argv: `expect(...).toContain("launchctl unload <path>")`. Those are expectations about what a fake
 * exec recorded, not spawns — but `commandUse` cannot tell the two apart, and it is right not to try.
 *
 * A plain REACH_ALLOW entry would have exempted that file from EVERY forbidden binary forever, in the
 * one file most likely to grow a real spawn. So it is exempted only while it PROVES the property
 * instead: it must contain no process-spawning construct at all. Modelled on the
 * INSTALLER_REDIRECTABLE rule below, which demands proof (`DBA_TEST_*`) rather than granting trust.
 */
const REACH_CONDITIONAL: Record<string, string> = {
  "schedule.install.test.ts":
    "the suite's only installer exerciser: every forbidden-binary literal is an ASSERTION about argv recorded by an injected fake exec. Exempt ONLY while the file spawns nothing at all — asserted below.",
};

/**
 * Every way a file could start a process. Two callers depend on it and both are REVOCATION clauses
 * rather than advisories: a conditionally-exempt TEST file must contain none of these (that is what
 * turns "it only asserts argv" from a claim into a checkable property), and scanner 4's R1 states
 * that nothing under `src/schedule/` may spawn AT ALL.
 *
 * ⚠ MEASURED GAP, 2026-09-14: the first version named `Bun.spawn`/`spawnSync`/`execSync`/
 * `execFileSync` and the two `child_process` specifiers, and MISSED every idiom below — so both
 * clauses were non-revoking for the shortest, most likely spellings. `Bun.$\`launchctl load …\`` in
 * particular is one line, reads as innocuous, and spawns exactly as hard as `Bun.spawn`. Each
 * alternative added here was SEEN RED first: applied as a mutation to a disposable copy of the tree,
 * confirmed present in the file, and observed to fail R1 before being removed.
 *
 * Composed from named parts rather than written as one literal: the single-line form was already
 * unreadable at six alternatives, and an unreadable guard is one nobody extends.
 */
const SPAWN_RE = new RegExp([
  /\bBun\s*\.\s*spawn(?:Sync)?\s*\(/,                     // Bun.spawn( / Bun.spawnSync(
  /\bBun\s*\.\s*\$/,                                      // Bun.$`…` — the shell-template form
  /import\s*\{[^}]*\$[^}]*\}\s*from\s*["']bun["']/,       // import { $ } from "bun"
  /(?<![\w.$])\$\s*`/,                                    // …and its use as a template tag: $`…`
  /(?<![\w.$])spawn(?:Sync)?\s*\(/,                       // a bare spawn(/spawnSync( call, however it was bound
  /\{[^}]*\bspawn(?:Sync)?\b[^}]*\}\s*=\s*(?:Bun\b|await\s+import|import\s*\(|require\s*\()/,  // the destructuring itself, incl. aliases
  /\bexecSync\s*\(/,
  /\bexecFileSync\s*\(/,
  /["']node:child_process["']/,
  /["']child_process["']/,
  /\bnew\s+Worker\s*\(/,                                  // a worker is a child too, and can spawn freely
].map((r) => r.source).join("|"));

test("no test spawns a privileged machine-wide binary", async () => {
  const files = await testFiles();
  // ⚠ RE-MEASURED WITH A2 and re-floored, per this file's own policy: carrying a stale floor forward
  // is how the margin rots. Measured at THIS commit: 107 test files (101 at A1 + this slice's 6).
  // Floored two below.
  // Tier B (T4.4): re-measured at 144 test files, the same `testFiles()` count as scanner 1; floored two below.
  // Tier B (T4.5): re-measured at 145; floored two below.
  // Tier B (T4.6): re-measured at 148; floored two below.
  // Tier B (T5.1): re-measured at 149; floored two below.
  // Tier B (T5.2): re-measured at 150; floored two below.
  // Phase E (M1b fix, 2026-10-01): re-measured at 155 `testFiles()`; floored two below.
  // Phase E (M2 fix, 2026-10-01): re-measured at 158 `testFiles()`; floored two below.
  // Phase E (M3, 2026-10-01): re-measured at 163 `testFiles()`; floored two below.
  // Phase E (M4, 2026-10-01): re-measured at 164 `testFiles()` (+ update-check.test.ts); floored two below.
  // Phase E (M5, 2026-10-01): re-measured at 168 `testFiles()` (+ the four docs tests); floored two below.
  // Phase E final harden (2026-10-02): re-measured at 174 `testFiles()` (round 1 said 172, round 3 173);
  // floored two below.
  expect(files.length).toBeGreaterThanOrEqual(172);
  const offenders: string[] = [];
  const conditional: string[] = [];
  for (const f of files) {
    if (f in REACH_ALLOW) continue;
    const src = sourceWithHelpers(f);
    const lits = literals(src);
    const named = FORBIDDEN_BINARIES.filter((bin) => lits.some((l) => commandUse(l, bin)));
    if (named.length === 0) continue;
    if (f in REACH_CONDITIONAL) {
      conditional.push(f);
      // The condition, checked rather than trusted. A single `Bun.spawn(` added to this file — even
      // one unrelated to scheduling — revokes the exemption loudly.
      const spawn = SPAWN_RE.exec(src);
      if (spawn) {
        offenders.push(`${f} is conditionally exempt from the never-reach scanner ONLY while it spawns nothing, and it now contains \`${spawn[0]}\` — either remove the spawn or delete the REACH_CONDITIONAL entry and drive the binaries through an injected exec`);
      }
      continue;
    }
    for (const bin of named) {
      const hit = lits.find((l) => commandUse(l, bin))!;
      offenders.push(`${f} invokes \`${bin}\` in command position ("${hit.slice(0, 60)}") — drive it through an injected exec seam instead`);
    }
  }
  // The conditional entry must still describe a file that actually names a forbidden binary; a stale
  // exemption reads as a considered decision while covering nothing.
  expect(Object.keys(REACH_CONDITIONAL).sort()).toEqual(conditional.sort());
  expect(offenders).toEqual([]);
});

test("the conditional exemption is a real condition — a spawn in an exempt file is caught", () => {
  // Non-vacuity for the branch above: the predicate must actually discriminate.
  for (const spawner of [
    'Bun.spawn(["launchctl", "load", p])',
    "Bun . spawn ( [x] )",
    'const { spawnSync } = await import("node:child_process");',
    'import { execSync } from "child_process";',
    "execFileSync(bin, args);",
    // ⚠ THE 2026-09-14 ADDITIONS. Every one of these was MISSED by the original pattern, which means
    // both the conditional exemption and R1 were non-revoking for the shortest spellings there are.
    // Each was seen red as an R1 mutation on a disposable copy before it was added here.
    "await Bun.$`launchctl load ${unit}`;",          // the shell-template form
    'import { $ } from "bun";',                      // the bare tag's import…
    "await $`launchctl unload ${unit}`;",            // …and its use
    "const { spawn } = Bun;",                        // destructured off Bun
    'const { spawn: sp } = require("child_process");',  // …and aliased
    "spawn(['launchctl', 'load', unit]);",           // the call, however it was bound
    'new Worker("./unload-agent.ts");',              // a worker is a child, and can spawn freely
  ]) {
    expect(`${spawner} → ${SPAWN_RE.test(spawner)}`).toBe(`${spawner} → true`);
  }
  for (const innocent of [
    'const exec: Exec = async (cmd) => { calls.push(cmd); return { code: 0 }; };',
    'expect(f.ran("launchctl")).toEqual([]);',
    "// a comment about Bun spawn in prose",
    // The discrimination the new alternatives must NOT lose. An ordinary template substitution is
    // `${`, never `$` followed by a backtick; `import { Glob } from "bun"` is this very file's own
    // import and must stay legal; and a method named `respawn` is not `spawn`.
    "const msg = `wrote ${path} at ${iso}`;",
    'import { Glob } from "bun";',
    "await pool.respawn(worker);",
    "d.say(`Wrote ${p}`);",
  ]) {
    expect(`${innocent} → ${SPAWN_RE.test(innocent)}`).toBe(`${innocent} → false`);
  }
});

test("the never-reach matcher is not vacuous", () => {
  // The guard above passes today because the suite is clean, which is indistinguishable from a matcher
  // that matches nothing. These pin the discrimination it claims: command position fails, prose does not.
  expect(commandUse("launchctl unload /x.plist", "launchctl")).toBe(true);
  expect(commandUse("launchctl", "launchctl")).toBe(true);
  expect(commandUse("cd /tmp && codesign --verify x", "codesign")).toBe(true);
  expect(commandUse("sudo systemctl restart x", "systemctl")).toBe(true);
  expect(commandUse("a security invariant now", "security")).toBe(false);
  expect(commandUse("§4e's whole security argument", "security")).toBe(false);
  expect(literals('const a = "launchctl unload"; // x').at(0)).toBe("launchctl unload");
  // The reproduced misses. A multi-line shell script — `literals()` returns the whole template as ONE
  // literal, and this is the `launchctl unload` of the author's live agent.
  expect(commandUse("set -euo pipefail\nlaunchctl unload ~/Library/LaunchAgents/x.plist\n", "launchctl")).toBe(true);
  expect(commandUse("cd /tmp\nsystemctl restart x", "systemctl")).toBe(true);
  expect(commandUse("bash -c 'launchctl unload x'", "launchctl")).toBe(true);
  expect(commandUse("/bin/launchctl unload x", "launchctl")).toBe(true);
  expect(commandUse("/usr/bin/security import x", "security")).toBe(true);
  expect(commandUse("launchctl;", "launchctl")).toBe(true);
  // …without losing the prose discrimination, including across a line break.
  expect(commandUse("the codesigning story\nand more prose", "codesign")).toBe(false);
  expect(commandUse("insecurity is not security-relevant", "security")).toBe(false);
});

/** `scripts/uninstall.sh` reads `DBA_TEST_DIR` and `DBA_TEST_PLIST` (its `SUPPORT=`/`PLIST=` lines) and falls
 *  back to the REAL support dir and the REAL LaunchAgents plist when either is missing. So a file is
 *  allowed to spawn it — `maintenance.test.ts` is the sanctioned exerciser — but only while it passes
 *  BOTH. It is asserted, not exempted.
 *
 *  `scripts/install.sh` is BANNED outright instead, because the conditional form was inert for it:
 *  `grep -n DBA_TEST scripts/install.sh` returns ZERO hits (re-measured at this commit). It hardcodes
 *  `$HOME/Library/Application Support/daily-briefing` and
 *  `$HOME/Library/LaunchAgents/local.daily-briefing.plist`, then runs `security import … login.keychain-db`,
 *  `codesign --force --sign`, `launchctl unload "$PLIST"` and `launchctl load "$PLIST"`. There is no
 *  redirection to demand, so demanding one let a future spawner satisfy the guard by merely MENTIONING
 *  the two variable names while it rebuilt the real binary and reloaded the author's live agent. An
 *  outright ban is the honest guard; if install.sh ever learns DBA_TEST_*, move it back to the list below
 *  and say so here.
 *
 *  Residual, stated rather than hidden: the check below is `src.includes(v)` over the file union, so a
 *  file with TWO uninstall.sh spawns still passes on the strength of one of them carrying the variables.
 *  Narrowing that needs per-spawn argument analysis, which is beyond a source scanner; the ban above
 *  removes the sharper half of the exposure. */
const INSTALLER_REDIRECTABLE = ["scripts/uninstall.sh"];
const INSTALLER_BANNED = ["scripts/install.sh"];

test("any test spawning scripts/uninstall.sh passes BOTH DBA_TEST_DIR and DBA_TEST_PLIST", async () => {
  const files = await testFiles();
  const spawners: string[] = [];
  const offenders: string[] = [];
  for (const f of files) {
    if (f === SELF) continue;   // names the scripts as data, in the constants above
    const src = sourceWithHelpers(f);
    for (const banned of INSTALLER_BANNED) {
      if (src.includes(banned)) {
        offenders.push(`${f} names ${banned}, which reads NO DBA_TEST_* redirection — it would rebuild the real binary, import a keychain identity, overwrite the real plist and launchctl-reload the author's LIVE agent. No test may spawn it.`);
      }
    }
    if (!INSTALLER_REDIRECTABLE.some((s) => src.includes(s))) continue;
    spawners.push(f);
    const missing = ["DBA_TEST_DIR", "DBA_TEST_PLIST"].filter((v) => !src.includes(v));
    if (missing.length) {
      offenders.push(`${f} spawns ${INSTALLER_REDIRECTABLE[0]} without ${missing.join(" and ")} — it would launchctl-unload and delete the REAL installed agent`);
    }
  }
  // The exerciser exists; if it ever stops existing this guard would pass over an empty set.
  expect(spawners).toContain("maintenance.test.ts");
  // Phase E (E10): the flag's exerciser is a spawner too, and is held to the same two variables.
  expect(spawners).toContain("uninstall.test.ts");
  expect(offenders).toEqual([]);
});

/** Phase E M5b fix round 2: the source install's codesign lines carry `--timestamp=none`, as
 *  `src/schedule/install.ts`'s do (pinned in schedule.install.test.ts) — codesign's default for asking a
 *  timestamp server is per-identity and unspecified, and the README's Privacy section lists no timestamp
 *  server. Pinned HERE, by READING the script as data, because this is the one test file the ban above
 *  exempts (SELF): any other file that so much as names the script fails that scan, by design. Never
 *  spawned. Comment lines are dropped and backslash continuations joined first. */
test("scripts/install.sh: every codesign it runs carries --timestamp=none (read as data, never run)", () => {
  const lines = readFileSync(resolve(SCRIPTS_DIR, "install.sh"), "utf8")
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  // `codesign` in COMMAND position (line start, after `if`/`then`/`else`/`do`, or after `;`, `&`, `|`)
  // — not `-p codesigning` (security's policy name), and not the word inside an `echo`'d warning.
  const signs = lines.filter((line) => /(^|[;&|]|\b(?:if|then|else|do))\s*codesign\s/.test(line));
  // prove-it 3b: both shapes were found, so the filter below is not vacuous.
  expect(signs.some((c) => c.includes('--sign "$SIGN_ID"'))).toBe(true);
  expect(signs.some((c) => c.includes("codesign -s -"))).toBe(true);
  expect(signs.length).toBeGreaterThanOrEqual(3);
  expect(signs.filter((c) => !c.split(/\s+/).includes("--timestamp=none"))).toEqual([]);
});

/** Phase E (E10): `scripts/uninstall.sh --remove-signing-identity` DELETES a keychain identity, from the
 *  keychain named by DBA_TEST_KEYCHAIN when it is set and from the LOGIN keychain otherwise. The script's
 *  own interlock refuses the flag under DBA_TEST_DIR without that variable; this is the suite-side half, a
 *  conditional rule in the INSTALLER_REDIRECTABLE shape rather than an exemption: any test file that passes
 *  the flag must also set DBA_TEST_KEYCHAIN. It reads code, not comments (`sourceWithHelpers`), and carries
 *  the same file-union residual stated above. Seen failing once before it was relied on: a disposable copy
 *  of the tree with a fixture test that passed the flag and omitted the variable turned it red. */
const IDENTITY_FLAG = "--remove-signing-identity";

test("any test passing --remove-signing-identity also sets DBA_TEST_KEYCHAIN", async () => {
  const files = await testFiles();
  const users: string[] = [];
  const offenders: string[] = [];
  for (const f of files) {
    if (f === SELF) continue;   // names the flag as data, in the constant above
    const src = sourceWithHelpers(f);
    if (!src.includes(IDENTITY_FLAG)) continue;
    users.push(f);
    if (!src.includes("DBA_TEST_KEYCHAIN")) {
      offenders.push(`${f} passes ${IDENTITY_FLAG} without DBA_TEST_KEYCHAIN — uninstall.sh would delete the identity from the LOGIN keychain`);
    }
  }
  // The exerciser exists; without it this rule would pass over an empty set.
  expect(users).toContain("uninstall.test.ts");
  expect(offenders).toEqual([]);
});

// ── scanner 3: the config dir ───────────────────────────────────────────────────────────────────────

/** The sibling live-state sink scanner 1 does not cover. `src/config.ts:47` resolves
 *  `XDG_CONFIG_HOME ?? ~/.config` + `daily-briefing/config.json`, and `initConfig()` (src/config.ts:303)
 *  WRITES it — a real write into the developer's user state, of exactly the class this file exists to
 *  close, guarded until now only by the convention that `config.test.ts` happens to set the variable.
 *  Blast radius is bounded (initConfig early-returns when the file exists, so it creates rather than
 *  overwrites, and it drives a homedir-wide repo-discovery walk), which is why this is a separate, small
 *  scanner rather than an entry in STATE_TRIGGERS: the remedy is a different variable. */
const CONFIG_TRIGGERS: Trigger[] = [
  { token: "initConfig(", why: "src/config.ts:303,334 — `Bun.write(configPath(), …)` creates the real user config." },
  { token: "configPath(", why: "src/config.ts:47 — resolves the real user config path directly." },
  // A1: both READ the installed config through configPath(). Read-only, so the blast radius is
  // smaller than initConfig's — but an unisolated `doctor` test would report on, and be shaped by,
  // whatever the developer happens to have configured, which is the same class of accident.
  { token: "statusReport(", why: "src/json.ts — reads the real user config via configPath()/loadConfig()." },
  { token: "doctorReport(", why: "src/json.ts — reads the real user config via configPath()." },
  // A2: the scheduling status surface calls loadConfig() for `morningTime`, so an unisolated run's
  // reported floor — and every ticks-vs-expected number derived from it — would be shaped by whatever
  // the developer happens to have configured. Read-only, same class as the two above.
  { token: "scheduleStatusReport(", why: "src/schedule/status.ts — reads the real user config via loadConfig() for morningTime." },
  // 2026-09-19: the entry point every reader above goes through, named directly. A test calling only this
  // was invisible to the table, and from any cwd but the package root nothing would have isolated it.
  { token: "loadConfig(", why: "src/config.ts — reads the real user config via configPath()." },
  // Phase E (E11): the automatic update check calls loadConfig() itself unless one is injected, and a test
  // driving it unisolated would be enabled or disabled by the developer's own `updateCheck` setting.
  { token: "autoUpdateCheck(", why: "src/updateCheck.ts — reads the real user config via loadConfig() unless `loadConfig` is injected." },
];

const CONFIG_ALLOW: Record<string, string> = {
  [SELF]: "this file IS the scanner: both triggers appear here as table entries, never as calls.",
};

test("every config-writing test file redirects XDG_CONFIG_HOME", async () => {
  const files = await testFiles();
  const touching: string[] = [];
  const offenders: string[] = [];
  for (const f of files) {
    const src = sourceWithHelpers(f);
    const hit = CONFIG_TRIGGERS.find((t) => triggerMatches(t, src));
    if (!hit) continue;
    touching.push(f);
    if (f in CONFIG_ALLOW) continue;
    if (!importsIsolation(src)) {
      offenders.push(`${f} reaches the real user config via \`${hit.token}\` (${hit.why}) but does not import "./fixtures/isolate-state", which arms XDG_CONFIG_HOME before the file's first save (see importsIsolation)`);
    }
  }
  // Measured at this commit: 2 — `config.test.ts` (four real `initConfig()` calls, all of which set
  // XDG_CONFIG_HOME) and this file. Floored AT the measurement because the set is small enough that any
  // drop is the trigger table rotting rather than the suite getting cleaner.
  // A1: re-measured at 3 (A1's 2 CONFIG_TRIGGERS pulled in one more file). Floored AT the measurement
  // again, per the same reasoning.
  // A2: re-measured at 4 (scheduleStatusReport pulled in test/schedule.status.test.ts, which now sets
  // XDG_CONFIG_HOME — it did not before this scanner caught it, and its ticks-vs-expected assertions
  // were being shaped by the developer's own morningTime).
  // A3: re-measured at 5 — test/api-surfaces.test.ts calls initConfig()/configPath()/doctorReport() and
  // redirects XDG_CONFIG_HOME for the whole file. Floored AT the measurement, per the same reasoning.
  // Phase E (M4, E11): CONFIG_TRIGGERS gained `autoUpdateCheck(` (it calls loadConfig() itself unless
  // one is injected). Re-measured at 8 — the set had grown to 7 since A3 without a re-floor, and
  // test/update-check.test.ts (which redirects XDG_CONFIG_HOME) is the eighth. Floored AT the
  // measurement, per the same reasoning.
  expect(touching.length).toBeGreaterThanOrEqual(8);
  expect(offenders).toEqual([]);
});

// ── scanner 4: the SRC side — A2 (T3a) ──────────────────────────────────────────────────────────
//
// ⚠ THE THREE SCANNERS ABOVE ALL READ `test/`. That was enough while every effectful path in `src/`
// already had an injected seam somebody else had built. Slice 4 adds `src/schedule/install.ts`, which
// exists to drive `launchctl`, `systemctl`, `schtasks`, `loginctl`, `xattr`, `codesign` and
// `security` — i.e. it is the first module in this repo whose JOB is the thing the other scanners
// forbid. A guard that only watches the tests would be watching the wrong file: the way this breaks
// is a future edit adding a bare `Bun.spawn(["launchctl", …])` to SRC, at which point no test needs to
// name a forbidden binary for the suite to unload the author's live agent.
//
// So this scanner asserts the property at the source:
//   R1  nothing under src/schedule/ may spawn a process AT ALL — the only way out is the `exec`
//       parameter, whose default is the one `proc.run` reference allowed by R3.
//   R2  the scheduler binaries may appear in command position ONLY in src/schedule/install.ts.
//   R3  src/schedule/install.ts references proc's `run` exactly once, in the default-exec definition.
//   R4  `unitDir` consults DBA_TEST_UNIT_DIR, so unit writes are redirectable at all.
//
// Together those mean: every OS command is `exec(...)`, every `exec` is injectable, and every unit
// write is redirectable. Seen RED against a bare-launchctl probe before being committed.

const SRC_DIR = resolve(TEST_DIR, "../src") + "/";

/** The binaries the scheduling code drives. A superset of FORBIDDEN_BINARIES: `loginctl` and `xattr`
 *  are here and NOT there deliberately — they belong to this slice's src surface, while adding them
 *  to the test-side list would have forced a blanket exemption on the one test file that asserts
 *  their argv. See REACH_CONDITIONAL. */
const SCHED_BINARIES = ["launchctl", "systemctl", "schtasks", "loginctl", "xattr", "codesign", "security"];

/** Every .ts under src/, relative to src/. */
async function srcFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Glob("**/*.ts").scan({ cwd: SRC_DIR })) out.push(f);
  return out.sort();
}

/** The ONE file allowed to name the scheduler binaries, because driving them is its entire purpose —
 *  and it may do so only under R1 and R3. */
const SCHED_OWNER = "schedule/install.ts";

test("R1: nothing under src/schedule/ spawns a process — the injected exec is the only way out", async () => {
  const files = (await srcFiles()).filter((f) => f.startsWith("schedule/"));
  // Floor: the slice ships three modules there. If this drops, the glob broke rather than the code
  // getting tidier.
  expect(files.length).toBeGreaterThanOrEqual(3);
  const offenders: string[] = [];
  for (const f of files) {
    const src = stripComments(readFileSync(resolve(SRC_DIR, f), "utf8"));
    const m = SPAWN_RE.exec(src);
    if (m) offenders.push(`src/${f} contains \`${m[0]}\` — scheduler effects must leave through the injected \`exec\` parameter (default src/proc.ts run()), never a direct spawn`);
  }
  expect(offenders).toEqual([]);
});

test("R2: the scheduler binaries are named in command position ONLY by src/schedule/install.ts", async () => {
  const offenders: string[] = [];
  let ownerNamed = 0;
  for (const f of await srcFiles()) {
    const src = stripComments(readFileSync(resolve(SRC_DIR, f), "utf8"));
    const lits = literals(src);
    const named = SCHED_BINARIES.filter((b) => lits.some((l) => commandUse(l, b)));
    if (named.length === 0) continue;
    if (f === SCHED_OWNER) { ownerNamed = named.length; continue; }
    offenders.push(`src/${f} names ${named.join(", ")} in command position — scheduler registration belongs in src/${SCHED_OWNER}, behind its injected exec`);
  }
  expect(offenders).toEqual([]);
  // ⚠ NOT VACUOUS: the owner must actually name several of them, or the matcher has stopped matching
  // and this test would pass over an empty set. Measured at 7 at this commit; floored two below.
  expect(ownerNamed).toBeGreaterThanOrEqual(5);
});

test("R3: install.ts reaches proc.run exactly ONCE, as the default exec", () => {
  const src = stripComments(readFileSync(resolve(SRC_DIR, SCHED_OWNER), "utf8"));
  // One import, and one call — the `defaultExec` body. A second `run(` would be a path around the
  // seam that R1 cannot see, because it is not a spawn.
  expect(/import\s*\{[^}]*\brun\b[^}]*\}\s*from\s*["']\.\.\/proc["']/.test(src)).toBe(true);
  const calls = [...src.matchAll(/(?<![\w.$])run\s*\(/g)];
  expect(`proc.run call sites in src/${SCHED_OWNER} = ${calls.length}`).toBe(`proc.run call sites in src/${SCHED_OWNER} = 1`);
  // …and that one call is inside the default-exec definition, not somewhere else in the file.
  const defAt = src.indexOf("const defaultExec");
  expect(`the single run( is inside defaultExec: ${calls[0]!.index > defAt && calls[0]!.index < defAt + 400}`)
    .toBe("the single run( is inside defaultExec: true");
});

test("R4: unit writes are redirectable — unitDir consults DBA_TEST_UNIT_DIR before anything else", () => {
  const src = stripComments(readFileSync(resolve(SRC_DIR, SCHED_OWNER), "utf8"));
  const fn = src.slice(src.indexOf("export function unitDir"), src.indexOf("export function unitPaths"));
  expect(fn).toContain("DBA_TEST_UNIT_DIR");
  // FIRST, not merged in: the real location is ~/Library/LaunchAgents, and a test that wrote there
  // would install a second copy of the author's live agent.
  const guardAt = fn.indexOf("DBA_TEST_UNIT_DIR");
  const darwinAt = fn.indexOf("LaunchAgents");
  expect(`override precedes the real path: ${guardAt >= 0 && guardAt < darwinAt}`).toBe("override precedes the real path: true");
});

test("no test names a REAL unit directory — those writes go through DBA_TEST_UNIT_DIR", async () => {
  // The unit-file half of the same contract. A literal `~/Library/LaunchAgents` in a test is a second
  // copy of the author's live agent waiting to happen, and `Library/LaunchAgents` appears in the
  // source only inside `unitDir`'s non-test branch.
  const offenders: string[] = [];
  for (const f of await testFiles()) {
    if (f === SELF) continue;   // names both paths as data, right here
    const src = sourceWithHelpers(f);
    for (const lit of literals(src)) {
      // The HOME-relative forms only: a test may legitimately BUILD `join(HOME, "Library",
      // "LaunchAgents")` from a scratch HOME to assert what `unitDir` computes, and does.
      if (/(?:^|\/)\.config\/systemd\/user|^~\/Library\/LaunchAgents|\$HOME\/Library\/LaunchAgents/.test(lit)) {
        offenders.push(`${f} names a real unit directory ("${lit.slice(0, 60)}") — write units under DBA_TEST_UNIT_DIR instead`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

// ── scanner 5: the run-end temp-dir registry ────────────────────────────────────────────────────────
//
// The sibling leak the four scanners above do not reach. Those keep the suite off the developer's REAL
// user state; this one keeps it from leaving behind the scratch directories it creates instead. Measured
// in PR #488: a full run left 827 `dba-*` directories in TMPDIR. The fix was `test/fixtures/temp-dirs.ts`
// plus ONE run-wide `afterAll` in `test/preload.ts`, and the files that make temp dirs registering them,
// by wrapping each mkdtemp in place — `removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-x-")))`. At #488's
// merge that was 36 files under test/: 34 `*.test.ts` plus the fixtures `build-repo.ts` and
// `eval-repo.ts`. Nothing then stopped the next file from being written unwrapped, and a leak that
// returns file by file is exactly the shape nobody notices. This is that stop.
//
// ⚠ WHAT THIS PIN DOES NOT PROVE: that the allowlisted files actually clean up after themselves. That is
// a claim about their BODIES — an `afterEach`, an `afterAll`, an `rm` in a `finally` — and it was verified
// by MEASUREMENT during #488 (a full run then left exactly one TMPDIR entry, `dba-isolated-state-*`; since 2026-09-19 it leaves the two
// `dba-isolated-*` baselines from fixtures/isolate-state.ts), not by
// this scan, which only reads lines. All the scan pins is that a NEW unwrapped site cannot appear outside
// the list. If an allowlisted file's cleanup were deleted tomorrow this test would still be green.
//
// Two conventions differ from the scanners above, both on purpose:
//   • it walks every `.ts` under test/, not only `*.test.ts` — the registration contract binds fixtures
//     too, and `fixtures/isolate-state.ts` and `fixtures/build-repo.ts` both mkdtemp;
//   • keys and offender lines therefore carry the `test/` prefix, because a bare
//     `fixtures/isolate-state.ts` is not a locator anyone can paste.
// `test/fixtures/temp-dirs.ts` itself needs no entry in either list: it never calls mkdtemp.

/** Every `.ts` under test/, sorted — the `*.test.ts`-only walk of `testFiles()` widened to the fixtures
 *  that register (or deliberately do not register) temp directories of their own. */
async function testSources(): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Glob("**/*.ts").scan({ cwd: TEST_DIR })) out.push(f);
  return out.sort();
}

/** A mkdtemp CALL rooted at `tmpdir()` on the same line — the only shape this repo writes, and the only
 *  one a line-oriented rule can speak about. Global: EVERY call on a line is a site of its own. Each
 *  match runs from the call to the FIRST `tmpdir()` after it and may not cross another mkdtemp call; the
 *  greedy single match this replaces ran to the LAST `tmpdir()` on the line, so a second, unwrapped call
 *  hid behind a wrapped first one. Of those two, only the LOOKAHEAD is load-bearing: the lazy `*?`
 *  shortens the match TEXT and never `m.index`, which is the only thing the verdict reads, so making the
 *  quantifier greedy changes no verdict (measured: that mutant survives, while dropping the lookahead or
 *  the `/g` turns the table test red). The optional `name.` segments take in a namespace-qualified callee
 *  (`fs.mkdtempSync(`, `fs.promises.mkdtemp(`), so the wrap test below sees the whole of it.
 *  REGEX LITERALS on purpose, here and below: `stripComments` erases regex literals, so the scanner
 *  cannot match its own source (the same reason `posture.test.ts` needs no state entry). */
const MKDTEMP_RE = /(?:[\w$]+\s*\.\s*)*\bmkdtemp(?:Sync)?\((?:(?!\bmkdtemp(?:Sync)?\().)*?\btmpdir\(\)/g;

/** A wrap that wraps THIS call: the code before the call must END in the wrap's open paren. The bare
 *  substring test this replaced scored `const d = <unwrapped call>; removeAtRunEnd(other);` as wrapped —
 *  the token present, around something else — which is a silent false NEGATIVE, the only direction that
 *  matters here. `await` is allowed between them: `removeAtRunEnd(await mkdtemp(…))` is the async
 *  spelling half this repo uses. */
const WRAP_BEFORE_RE = /\bremoveAtRunEnd\(\s*(?:await\s+)?$/;

/** `import { mkdtempSync as mkTmp }` hides every call site in that file from MKDTEMP_RE, which reads the
 *  names literally — the scan would report a clean file with no sites at all — and an aliased `tmpdir`
 *  import does the same from the other end. Resolving aliases needs a parser; REFUSING them needs a line,
 *  and nothing under test/ aliases either today (measured), so the refusal costs nothing and closes that
 *  hole outright. It covers the `import { x as y }` spelling only; see the scan for what stays open. */
const IMPORT_ALIAS_RE = /\b(?:mkdtemp(?:Sync)?|tmpdir)\s+as\s+[\w$]+/;

/** Scanner 5's decision for ONE source line — called by the scan and pinned by its own table test.
 *  `strippedFile` is the comment-stripped text of the whole file the line came from.
 *
 *  The line is matched AFTER `stripComments`, so a trailing `// …` or an inline block comment — even one
 *  that names `tmpdir()` itself — changes nothing. A match counts only if the code from it to the end of
 *  the line also appears in `strippedFile`: `stripComments` collapses a multi-line block comment to one
 *  space, so a line from INSIDE one (which the line-level strip cannot recognise, never having seen the
 *  opening) is absent there and is dropped as prose. A substring test rather than a line index, because
 *  that same collapse means the stripped text does not line up with the source. Measured over the real
 *  corpus, `live()` rejects 0 of 219 matches: it is future-proofing, and the table test's two
 *  block-comment rows are its only live input — which is the reason to keep it, not to simplify it away. */
function tmpSitesOnLine(line: string, strippedFile: string): { sites: number; unwrapped: number; alias: boolean } {
  const code = stripComments(line);
  const live = (at: number): boolean => strippedFile.includes(code.slice(at).trimEnd());
  let sites = 0;
  let unwrapped = 0;
  for (const m of code.matchAll(MKDTEMP_RE)) {
    if (!live(m.index)) continue;
    sites++;
    if (!WRAP_BEFORE_RE.test(code.slice(0, m.index))) unwrapped++;
  }
  const a = IMPORT_ALIAS_RE.exec(code);
  return { sites, unwrapped, alias: a !== null && live(a.index) };
}

/** Files whose unwrapped sites are NOT leaks because they clean up themselves. Every entry names the
 *  MECHANISM and where it is, so the entry can be re-checked rather than trusted — an allowlist whose
 *  reasons are "it's fine" is a deleted guard with extra steps. Each mechanism below was read at this
 *  commit; line numbers are where it lives, not proof that it runs. */
const TMP_SELF_CLEANING: Record<string, string> = {
  "test/account.test.ts": "every `await dir()` is paired with `await rm(d, { recursive: true, force: true })` at the end of the same test — 8 of each, counted at this commit (first at test/account.test.ts:72).",
  "test/account.config.test.ts": "same per-test pairing as account.test.ts — `await rm(d, …)` at test/account.config.test.ts:76, :96, :105, :111.",
  "test/account.failover.integration.test.ts": "an `afterAll` removes the shared `failover-state-` dir (test/account.failover.integration.test.ts:81-84), and each `fake-cli-` dir is removed at the end of its own test (:130, :154, …).",
  "test/apiKey.test.ts": "each dir is created and removed inside one `try`/`finally` in the same test (test/apiKey.test.ts:88-89, :165-166, :229-230).",
  "test/api-surfaces.test.ts": "an `afterAll` removes both file-scope dirs (test/api-surfaces.test.ts:40-43).",
  "test/core.api-provider.test.ts": "an `afterAll` removes the file-scope `stateDir` (test/core.api-provider.test.ts:67-72) and each of the three per-test dirs (:268, :356, :378) goes in a `finally` (:284-285, :372-373, :405-406).",
  "test/tick-heartbeat.test.ts": "an `afterEach` removes the per-test dir (test/tick-heartbeat.test.ts:14-16).",
  "test/run-lock.test.ts": "both dirs are removed by `env.cleanup()` (test/run-lock.test.ts:55-56), which every test calls from a `finally`.",
  "test/fixtures/isolate-state.ts": "DELIBERATELY never registered and never removed: its two baselines (`dba-isolated-state-*`, `dba-isolated-config-*`) are the only TMPDIR entries a full run is expected to leave, and the reason is recorded at test/fixtures/isolate-state.ts:21 and test/preload.ts:42-44. Registering them would delete the process-wide state and config dirs mid-drain.",
};

/** Files excluded from the scan outright, each with the reason. Distinct from the list above: these are
 *  not self-cleaning, they are files for which "unwrapped" is the subject matter. */
const TMP_SCAN_EXCLUDE: Record<string, string> = {
  "test/fixtures/temp-dirs.probe.ts": "the CHILD-PROCESS probe for the registry itself (see test/fixtures/temp-dirs.test.ts). Its two unwrapped sites are the inputs it then hands to `removeAtRunEnd` to observe what the call RETURNS and whether it throws — wrapping them in place would erase the shape under test. Everything it creates lives under a directory the parent test registered, so the run-end drain still removes it.",
};

test("every mkdtemp under tmpdir() in test/ is registered for run-end removal", async () => {
  const files = await testSources();
  // Floored two below the measurement at this commit (125 `.ts` files under test/), per this file's
  // policy: a couple of deletions are normal, a collapse is the Glob breaking.
  // Tier B (T4.4): re-measured at 161 `.ts` files (four recap-campaigns test files and the
  // fixtures/recap-busy.ts helper among the additions since); floored two below.
  // Tier B (T4.5): re-measured at 162 (+ recap-campaigns.failure); floored two below.
  // Tier B (T4.6): re-measured at 165 (+ recap-campaigns.{pins,wiring,deadline}); floored two below.
  // Tier B (T5.1): re-measured at 166 (+ recap-campaigns.report); floored two below.
  // Tier B (T5.2): re-measured at 167 (+ recap-campaigns.replay); floored two below.
  // Phase E (M2 fix, 2026-10-01): re-measured at 175 `testSources()`; floored two below.
  // Phase E (M3, 2026-10-01): re-measured at 180 `testSources()`; floored two below.
  // Phase E (M4, 2026-10-01): re-measured at 181 `testSources()` (+ update-check.test.ts); floored two below.
  // Phase E final harden (2026-10-02): re-measured at 191 `testSources()` (187 on main at 98d4514db, +
  // the four test files named at scanner 1; round 1 said 189, round 3 190); floored two below.
  expect(files.length).toBeGreaterThanOrEqual(189);

  const offenders: string[] = [];
  const unwrapped: Record<string, number> = {};
  let sites = 0;
  for (const rel of files) {
    const file = `test/${rel}`;
    const raw = readFileSync(resolve(TEST_DIR, rel), "utf8");
    // The per-line rule is `tmpSitesOnLine`. What it still gets wrong, stated exactly — and nothing under
    // test/ writes any of these shapes today (measured):
    //   SILENT, so a real leak passes —
    //     • a call split across lines, with `tmpdir()` not on the line that opens the mkdtemp call;
    //     • a base that is not a literal `tmpdir()` call on that line: a variable holding its result
    //       (`const T = tmpdir();` then `join(T, …)` inside the call), or any rebinding of either name
    //       other than the aliased import refused below (a destructured `{ tmpdir: td }` is not);
    //     • a line that strips differently read alone than read in file context — one opening with a
    //       division operator, or one inside a multi-line template literal — which `live()` then drops as
    //       prose. Contrived, and nothing here writes it, but it is the one miss `live()` itself creates.
    //   LOUD, so it costs a rewrite and never a leak —
    //     • a wrap split across lines (`removeAtRunEnd(` ending the line above the call);
    //     • a callee qualified by anything but plain `name.` segments (`require("node:fs").…`);
    //     • a commented-out site whose code, from the call to the end of its line, also appears live in
    //       the same file — counted as live.
    const stripped = stripComments(raw);
    raw.split("\n").forEach((line, i) => {
      const v = tmpSitesOnLine(line, stripped);
      sites += v.sites;
      // Neither allowlist can excuse an ALIASED import, and that asymmetry is deliberate: both lists
      // excuse an unwrapped SITE, whereas an alias leaves the scan with no site to excuse at all.
      if (v.alias) offenders.push(`${file}:${i + 1}: an aliased mkdtemp/tmpdir import defeats this scan: ${line.trim()}`);
      if (v.unwrapped === 0) return;               // no site, or every site on the line wrapped in place
      unwrapped[file] = (unwrapped[file] ?? 0) + v.unwrapped;
      if (file in TMP_SELF_CLEANING || file in TMP_SCAN_EXCLUDE) return;
      offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  // Non-vacuity: 219 live sites at this commit. Floored well below, unlike the floors above, and the
  // reason is measured rather than cautious — the largest single file holds 32 of them
  // (subprojects.test.ts), so the floor has to be 219 − 32 = 187. Anything tighter fires on deleting that
  // one file rather than on the regex rotting, which is the only thing this floor is for; 188 did.
  // Re-measured when the per-line rule became per-call (`tmpSitesOnLine`): still 125 files, 219 sites and
  // 32 at most in one file — identical to the old rule file for file, since no line here holds two calls.
  // Tier B (T4.4): re-measured at 240 live sites, still at most 32 in one file (subprojects.test.ts), so
  // the same rule gives 240 − 32 = 208.
  // Tier B (T4.5): re-measured at 241 live sites (+1, recap-campaigns.failure's state dir), still at most
  // 32 in one file, so 241 − 32 = 209.
  // Tier B (T4.6): re-measured at 244 (+1 wiring state dir, +2 pins' per-run cfg/state dirs), still at
  // most 32 in one file, so 244 − 32 = 212.
  // Tier B (T5.1): re-measured at 246 (+2, recap-campaigns.report's two record dirs), still at most 32 in
  // one file, so 246 − 32 = 214.
  // Tier B (T5.2): re-measured at 247 (+1, recap-campaigns.replay's `tmp` helper), still at most 32 in one
  // file, so 247 − 32 = 215.
  // Tier B (harden r1): re-measured at 248 (+1, recap-campaigns.report's second-date record dir), still at
  // most 32 in one file, so 248 − 32 = 216.
  // Phase E (M3, 2026-10-01): re-measured at 268 live sites (+6 this milestone: release-check's three and
  // uninstall's two fixture/stub dirs, maintenance's stub dir; the rest added on main since), still at most
  // 32 in one file (subprojects.test.ts), so 268 − 32 = 236.
  expect(sites).toBeGreaterThanOrEqual(236);
  expect(offenders).toEqual([]);

  // A stale entry reads as a considered decision while covering nothing — and a file that no longer
  // exists fails here too, since a missing file has no unwrapped site. Same rule as the allowlist
  // staleness test above, applied to both lists.
  const stale = [...Object.keys(TMP_SELF_CLEANING), ...Object.keys(TMP_SCAN_EXCLUDE)].filter((f) => !unwrapped[f]);
  expect(`stale allowlist entry: ${stale.join(", ") || "none"}`).toBe("stale allowlist entry: none");
});

test("scanner 5's per-line rule judges EVERY call on a line, after comments are stripped", () => {
  // ⚠ Every fixture is assembled from split tokens. Scanner 5 reads THIS file too, and `stripComments`
  // keeps string literals, so a whole mkdtemp-under-tmpdir call — or an aliased import — written out in
  // a string here would be a live offender of the very scan these rows pin.
  const MK = "mkdtemp" + "Sync";
  const TMP = "tmp" + "dir";
  const call = (tag: string): string => `${MK}(join(${TMP}(), "${tag}"))`;
  type Verdict = { sites: number; unwrapped: number; alias: boolean };
  const offender = (sites: number, unwrapped: number): Verdict => ({ sites, unwrapped, alias: false });
  const aliased: Verdict = { sites: 0, unwrapped: 0, alias: true };
  const noSite: Verdict = { sites: 0, unwrapped: 0, alias: false };
  // [name, line, verdict, whole-file text when the line is not a file on its own]
  // The S-numbers are the names the round-2 mutation scratch files used, kept so a row can be traced back
  // to the mutant that prompted it. S5 is not missing: it was "the base held in a const", which is now the
  // first KNOWN MISS row at the bottom of this table.
  const rows: [string, string, Verdict, string?][] = [
    ["S1 plain, unwrapped", `const d = ${call("x")};`, offender(1, 1)],
    ["S2 aliased mkdtemp import", `import { ${MK} as mk } from "node:fs";`, aliased],
    ["S3 trailing comment that names the base", `const d = ${call("x")}; // lives under ${TMP}()`, offender(1, 1)],
    ["S4 block comment inside the call", `const d = ${MK}(/* base */ join(${TMP}(), "x"));`, offender(1, 1)],
    ["S6 aliased tmpdir import", `import { ${TMP} as td } from "node:os";`, aliased],
    ["S7 wrapped call, then an unwrapped one", `const a = removeAtRunEnd(${call("a")}), b = ${call("b")};`, offender(2, 1)],
    ["S7b wrapped call on another base, then an unwrapped one",
      `const a = removeAtRunEnd(${MK}(join(base, "a"))), b = ${call("b")};`, offender(1, 1)],
    ["S8 the wrap is around something else", `const d = ${call("x")}; removeAtRunEnd(other);`, offender(1, 1)],
    ["S9 namespace-qualified, wrapped", `const d = removeAtRunEnd(fs.${call("x")});`, offender(1, 0)],
    ["two-segment namespace, awaited and wrapped", `const d = removeAtRunEnd(await fs.promises.mkdtemp(join(${TMP}(), "x")));`, offender(1, 0)],
    ["wrapped, sync", `const d = removeAtRunEnd(${call("x")});`, offender(1, 0)],
    ["wrapped, await", `dir = removeAtRunEnd(await mkdtemp(join(${TMP}(), "x")));`, offender(1, 0)],
    ["comment-only line", `// const d = ${call("x")};`, noSite],
    ["line inside a multi-line block comment", ` *   const d = ${call("x")};`, noSite, `/**\n *   const d = ${call("x")};\n */\nconst y = 1;`],
    ["alias named inside a multi-line block comment", ` *   import { ${MK} as mk } from "node:fs";`, noSite,
      `/**\n *   import { ${MK} as mk } from "node:fs";\n */\nconst y = 1;`],
    // KNOWN MISSES, pinned so they stay deliberate — see the list in the scan above.
    ["KNOWN MISS: base held in a variable", `const d = ${MK}(join(T, "x"));`, noSite],
    ["KNOWN MISS: call split across lines", `const d = ${MK}(`, noSite, `const d = ${MK}(\n  join(${TMP}(), "x"),\n);`],
  ];
  const got = Object.fromEntries(rows.map(([name, line, , file]) => [name, tmpSitesOnLine(line, stripComments(file ?? line))]));
  const want = Object.fromEntries(rows.map(([name, , verdict]) => [name, verdict]));
  expect(got).toEqual(want);
});

// ── scanner 6: a child `bun` running an entry point gets the isolated env ───────────────────────────
//
// Every guard above isolates THIS process. The fixture arms DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME
// in `process.env` at runtime, and the tripwire watches them there. A child started without an `env`
// option sees neither. Measured on bun 1.3.14: a parent set one plain variable and one tripwire-style
// accessor at runtime, then had a child print both.
//   • `Bun.spawn`, `Bun.spawnSync`, and node:child_process's `spawnSync` / `execFileSync` / `execSync`,
//     each with no `env`: the child printed NEITHER. It got the process's STARTUP environment.
//   • The same spawns with `env: { ...process.env }`, `env: process.env` or `env: { ...Bun.env }`: both,
//     accessor included. The fixture's accessors are enumerable, so a spread copies their armed values.
//   • node:child_process's async `spawn`, `execFile` and `exec`, and `Bun.$`, with no `env`: both.
// So a test that runs `bun src/main.ts …` or a scripts/*.ts entry without `env` resolves the developer's
// REAL `~/Library/Application Support/daily-briefing` and `~/.config/daily-briefing`. Neither the
// per-file import nor the tripwire can reach that child. Found during PR #518. The one instance then was
// dispatch.json.test.ts's `config validate --stdin` spawn; it only reads, and it now passes
// `env: { ...process.env }`.
//
// The rule, for each spawn of `bun` (or `process.execPath` / `argv0`) whose command names an entry:
//   • No `env` option: offender.
//   • `env` spreads process.env: fine when the file imports the fixture, because the spread copies the
//     armed values. Without the import it must set DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME itself,
//     AFTER the spread. From outside the package root nothing armed the values it copies, and the
//     developer's shell may export either variable.
//   • `env` is a fresh object: it must set both variables. HOME alone is not accepted. The scan cannot
//     see a value, and the usual scrubbed env, `{ PATH, HOME: process.env.HOME }`, carries the REAL home,
//     under which both the state dir and the config resolve. A fresh env without HOME is no better:
//     `homedir()` then falls back to the password database, i.e. the real home again (measured:
//     `env -i bun -e` printing `os.homedir()`).
//   • Either variable set to `undefined` / `null` / `""` / `void 0`, or cleared on the env's binding
//     (`delete env.X`, `delete (env as any).X`, `Reflect.deleteProperty(env, "X")`, `env.X = undefined`,
//     `Object.assign(env, { X: undefined })`): offender. `src/marker.ts:10` resolves the state dir on
//     truthiness, and Bun drops an `undefined` key.
//   • A variable COPIED from process.env (`X: process.env.X`, `process.env[k]`, `e.X` through an alias
//     given process.env or a snapshot of it, a binding holding such a read, or a shorthand key
//     destructured from process.env) is the spread by another name: it counts only when the file
//     imports the fixture. A value built from HOME (`process.env.HOME`, an alias's `.HOME`, a destructured
//     `HOME`), `homedir()` (under any imported name) or `userInfo().homedir` is the real location and
//     never counts.
//   • Anything the scan cannot read in full is an offender: an env or options value built by a call, a
//     binding that is also a parameter, destructured, or looped over, an options object with a spread.
// The async child_process calls measured safe and are flagged anyway. "Always pass env" is one idiom;
// a per-API table of which spawns are safe would be one more thing to get wrong. `Bun.$` is left out
// because it measured safe.
//
// ⚠ The scan has no scopes. A name is looked up in every place the file and its helpers give it a
// value (a declaration, a later declarator, a defaulted parameter, a plain reassignment), and only what
// ALL of them do counts toward isolation; a binding it cannot follow to a value makes the spawn an
// offender. The first cut merged the declarations instead, which let a sibling test's `const env =
// { ...process.env }` vouch for this test's `const env = { PATH }` (review round 1, reproduced), and the
// next let a parameter or a destructured `env` borrow a sibling's (verify round, reproduced). For the
// COMMAND the union is right: more text can only find more entries, so a stray declaration errs loud.
//
// src/proc.ts `run()` is read too, under the name a named import or a destructured `await import(…)` or
// `require(…)` gives it (aliased or not, `.ts`, `.js` or bare specifier, called plainly or as
// `run?.(…)`). It hands its child `{ ...process.env }` and takes no `env`, so each call that runs an
// entry is judged as a spread: isolated when the file imports the fixture. scripts/audit.ts
// regenerates a briefing this way, and audit-main.test.ts reaches that call through its import of the
// script.
//
// Known limits, silent (a real miss passes) — each has a KNOWN MISS row:
//   • a spawn through any other wrapper, or through `run()` reached as a member of the module
//     (`proc.run(…)` after a namespace import, `(await import(…)).run(…)`, `require(…).run(…)`);
//     an aliased callee (`const sp = Bun.spawnSync`, `const sh = run`); a callee reached through a
//     call or a computed member (`require(…).spawnSync`, `cp["spawnSync"]`); an entry handed to a
//     helper as an argument;
//   • a command array spread from a binding (`[...BASE, "src/main.ts"]`), for a spawn and `run()` alike:
//     the runtime named inside BASE is never looked up;
//   • a clear through an alias of the env binding (`const e = env; delete e.X`). The disarm scanner
//     above still sees the delete, for either variable (pinned there with this row's source).
// Silent, with no row (spellings rare enough that a row would pin noise): a flag value given after a
// space (`bun --env-file .env start`); a name inside a template's `${…}` (`bun ${"start"}`); the runtime
// renamed while destructured (`const { execPath: bin } = process`) or taken from `process.argv` by
// destructuring; assignment destructuring (`({ env } = mk())`); a copy through `import { env } from
// "node:process"` or a destructure of an alias; a clear through `Reflect.set`, a generic cast with a
// comma inside `Reflect.deleteProperty(…)`, or an optional computed member (`delete env?.["X"]`); the
// options' env removed through `Reflect`/`defineProperties`/a getter; a parameter declared inside a
// template's `${…}`; a pattern whose type annotation runs past 300 characters; an Object.assign onto the
// options written inside a template's `${…}`; an isolating variable written onto the env AFTER it is
// built (`env.XDG_CONFIG_HOME = join(homedir(), …)`, `Object.assign(env, { … })` with a non-clearing
// value); a copy through a two-level alias (`a = process.env; b = a; b.X`); src/proc.ts `run()` bound
// any way but the three read above — inside a `.then(({ run }) => …)`, by a destructure with a default
// (`{ run: sh = x }`) or a type annotation (`const { run }: T = …`), or by a string-named import
// (`import { "run" as sh }`) — or called as `run.call(…)`/`run.apply(…)`.
// Loud (costs a rewrite, never a leak): `bun build src/main.ts` is flagged on purpose, since a compiled
// binary may run next; `bun test` with a flag value that happens to be an entry name; a `bun -e` script
// that quotes an entry name right after the flag; a binding that spreads itself (`env = { ...env, X }`),
// which the three-hop walk cannot close.

/** An entry spelled as a path wherever a path can start, including mid-shell-string after other flags
 *  (`bun --smol main.ts`): main.ts at any depth, or scripts/<name> with `.ts` optional, because bun
 *  resolves it (measured: `bun run scripts/x` runs scripts/x.ts). The scripts form also covers a script
 *  not on disk yet. `src/main` without `.ts` needs no alternative here: ENTRY_NAME_RE's `/main` has it.
 *  Read over the command text with SEGMENT_JOIN applied. */
const ENTRY_RE = /(?<![\w.-])(?:main\.ts|scripts\/[\w-]+(?:\.ts)?)(?![\w.-])/;

/** Entries reachable WITHOUT their directory: the scripts/*.ts basenames, read from disk so a new
 *  script is covered the day it lands (`join(SCRIPTS_DIR, "eval.ts")`, `${dir}/audit`), `main` (so
 *  `src/main`, which bun runs without `.ts`, measured), and every package.json script that runs one of
 *  them (`bun run audit`, `bun start`). */
const ENTRY_NAMES: string[] = (() => {
  const scripts = readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith(".ts")).map((f) => f.slice(0, -3));
  const pkg = JSON.parse(readFileSync(resolve(TEST_DIR, "../package.json"), "utf8")) as { scripts: Record<string, string> };
  const run = Object.entries(pkg.scripts).filter(([, cmd]) => /\bbun\b/.test(cmd) && ENTRY_RE.test(cmd) && !/\bbun\s+build\b/.test(cmd));
  return [...new Set(["main", ...scripts, ...run.map(([name]) => name)])].sort();
})();
/** A name, judged against ONE string literal's contents at a time. It counts as the whole literal
 *  (`"audit"`), as the literal's last path segment (`"../src/main"`, `${SCRIPTS}/eval.ts`), or, in a
 *  shell string, as a word after a slash or after `bun`, its flags and an optional `run` with its own
 *  flags (`bun --env-file=.env start`, `bun run --silent audit`), quoted or not and possibly followed
 *  by a shell operator (`bun run 'audit'`, `bun start>/dev/null`). Per literal, so a quoted word INSIDE
 *  a `bun -e` script (`console.log('eval')`) is not an entry: round 2 of review caught the text-wide
 *  form reading it as one. A flag is one `-[\w-]+` token, so the loop cannot split `--x` two ways; the
 *  `--?` it replaced backtracked exponentially (measured in review: about 3 s at 24 flags). */
const ENTRY_NAME_RE = new RegExp(String.raw`(?:^|\/|\bbun(?:\s+-[\w-]+(?:=\S+)?)*\s+(?:run(?:\s+-[\w-]+(?:=\S+)?)*\s+)?["'\`]?)(?:${ENTRY_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:\.ts)?(?=["'\`]?(?:\s|$|[;&|)<>]))`);

/** The runtime: the word `bun`, bare or at the end of a path, `process.execPath` or `process.argv0`
 *  (or either destructured under its own name), or `argv[0]`. */
const BUN_RE = /(?<![\w$.-])bun(?![\w$.-])|(?<![\w$])(?:process\s*\.\s*)?(?:execPath|argv0)\b|\b(?:process|Bun)\s*\.\s*argv\s*\[\s*0\s*\]/;

/** Every spawning call this scanner reads. `(?:name.)*` takes `Bun.`, `cp.`, `cp?.`, `cp!.` and
 *  `childProcess.`; a bare `spawn(` also covers `const { spawn } = Bun`; a type argument
 *  (`Bun.spawnSync<"pipe">(`) is allowed. `exec(` matches `RegExp#exec` too, which is harmless: a call
 *  counts only when its command names both the runtime and an entry. */
const SPAWN_CALL_RE = /(?<![\w$.])(?:[\w$]+\s*[!?]?\.\s*)*(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*(?:<[^<>()]*>\s*)?\(/g;

/** The local names src/proc.ts's `run()` is imported under, at any depth, aliased or not: a named
 *  import (`import { run } from "../src/proc"`, `import { run as sh, type RunResult } from "./proc.ts"`)
 *  or a destructured dynamic import or `require` (`const { run } = await import("../src/proc")`,
 *  `const { run: sh } = require("../src/proc")`, this repo's own idiom for src modules in tests).
 *  The specifier may end in `.ts` or `.js`. A `run` from anywhere else is some other function. A
 *  type-only import brings no callable. The braces' contents exclude `{`, so an unclosed `const {`
 *  cannot scan on to a far `}`: with `[^}]*` that was quadratic (measured 1.2 s on 16,000 of them). */
function procRunNames(src: string): string[] {
  const names: string[] = [];
  const PROC = String.raw`\s*["']\.[^"']*\/proc(?:\.[jt]s)?["']`;
  for (const m of src.matchAll(new RegExp(String.raw`\bimport\s*\{([^{}]*)\}\s*from${PROC}`, "g"))) {
    for (const spec of m[1]!.split(",")) {
      const s = /^\s*run(?:\s+as\s+([\w$]+))?\s*$/.exec(spec);
      if (s) names.push(s[1] ?? "run");
    }
  }
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+import|require)\s*\(${PROC}\s*\)`, "g"))) {
    for (const spec of m[1]!.split(",")) {
      const s = /^\s*run(?:\s*:\s*([\w$]+))?\s*$/.exec(spec);
      if (s) names.push(s[1] ?? "run");
    }
  }
  return names;
}

/** Adjacent string arguments, joined so `join(ROOT, "scripts", "eval.ts")` reads as `scripts/eval.ts`. */
const SEGMENT_JOIN = /["'`]\s*,\s*["'`]/g;

/** A value that leaves a variable unset or falsy in the child. */
const CLEARING = String.raw`(?:undefined\b|null\b|""|''|\`\`|void\s*\(?\s*0\s*\)?)`;

/** A value without a trailing `as T` cast or non-null `!`. An object literal is cut at its own closing
 *  brace instead, so a cast after it cannot eat into it. */
function bare(value: string): string {
  const v = value.trim();
  if (v.startsWith("{")) { const end = closeOf(v, 0); return end < 0 ? v : v.slice(0, end); }
  return v.replace(/\s+as\s+[\w$<>[\]{}"',.\s|]+$/, "").replace(/!$/, "");
}

/** Index of the last character of the string or template literal opening at `i`. A template's `${…}` is
 *  walked as code, so a nested template cannot end it early. */
function literalEnd(src: string, i: number): number {
  const q = src[i]!;
  for (let j = i + 1; j < src.length; j++) {
    const d = src[j]!;
    if (d === "\\") { j++; continue; }
    if (d === q) return j;
    if (d === "\n" && q !== "`") return j;               // unterminated quote: stop at the line
    if (q === "`" && d === "$" && src[j + 1] === "{") {
      const end = closeOf(src, j + 1);
      if (end < 0) return src.length;
      j = end - 1;
    }
  }
  return src.length;
}

/** Index just past the bracket that closes the one at `open`, or -1. Literals may hold any bracket. */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { i = literalEnd(src, i); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (--depth === 0) return i + 1; }
  }
  return -1;
}

/** The contents of every string and template literal in `code`, in order. */
function literalsOf(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c !== '"' && c !== "'" && c !== "`") continue;
    const end = literalEnd(code, i);
    out.push(code.slice(i + 1, end));
    i = end;
  }
  return out;
}

/** `code` with every string and template literal's contents blanked to spaces, same length, so a
 *  regex over it finds only code and its match indexes still point into `code`. */
function blankLiterals(code: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c !== '"' && c !== "'" && c !== "`") continue;
    const end = literalEnd(code, i);
    out += code.slice(last, i + 1) + code.slice(i + 1, end).replace(/[^\n]/g, " ");
    last = end;
    i = end;
  }
  return out + code.slice(last);
}

/** A bracket's contents, split at its top-level commas. */
function splitTop(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '"' || c === "'" || c === "`") { i = literalEnd(inner, i); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(inner.slice(start, i).trim()); start = i + 1; }
  }
  const last = inner.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** End of the expression starting at `from`: a top-level `;` or `,`, the bracket that closes the
 *  enclosing one, or a line break where the statement is complete. A semicolon-free declaration must
 *  not swallow the next one, and an arrow (`=>`) or operator at a line end continues it. */
function exprEnd(src: string, from: number): number {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") { i = literalEnd(src, i); continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth-- === 0) return i; }
    else if (depth === 0 && (c === ";" || c === ",")) return i;
    else if (depth === 0 && c === "\n") {
      const before = src.slice(from, i).trim();
      const next = src.slice(i).trimStart()[0] ?? "";
      if (before && !/[=+\-*/%&|?:,(>]$/.test(before) && !".?:+-*/%&|".includes(next)) return i;
    }
  }
  return src.length;
}

/** Every value `src` gives `name`: `const|let|var name =`, a later declarator or a defaulted parameter
 *  (`, name =`, `(name: T =`), and a plain reassignment (`name = …`). */
function initializers(src: string, name: string): string[] {
  const n = name.replace(/\$/g, "\\$");
  const re = new RegExp(String.raw`(?:(?<![\w$.])(?:const|let|var)\s+${n}\s*(?::[^=;]*)?|[(,]\s*${n}\s*(?::[^=,()]*)?|(?<![\w$.]|(?:const|let|var)\s+|[(,]\s*)${n}\s*)=(?![=>])`, "g");
  return [...src.matchAll(re)].map((m) => {
    const from = m.index + m[0].length;
    return src.slice(from, exprEnd(src, from)).trim();
  });
}

/** `text` plus the initializer of every binding it names, three hops deep (`argv` → `entry` → `rel`).
 *  Used for the COMMAND only, where a union errs loud. Identifiers inside a template's `${…}` count; the
 *  literal text around them is kept too, because an entry can be spelled there. */
function withDeclarations(text: string, src: string): string {
  const seen = new Set<string>();
  let frontier = text;
  let all = text;
  for (let hop = 0; hop < 3 && frontier; hop++) {
    const code = frontier.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      (l) => [...l.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(" "));
    const found: string[] = [];
    for (const [id] of code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(...initializers(src, id));
    }
    frontier = found.join("\n");
    all += "\n" + frontier;
  }
  return all;
}

/** Value text of the top-level property `name` of an object literal; a shorthand `{ env }` returns the
 *  binding's name. */
function prop(obj: string, name: string): string | undefined {
  const body = obj.slice(1, Math.max(1, closeOf(obj, 0) - 1));
  for (const p of splitTop(body)) {
    const m = new RegExp(String.raw`^["']?${name}["']?\s*(?::\s*([\s\S]*))?$`).exec(p);
    if (m) return m[1] ?? name;
  }
  return undefined;
}

/** Is `name` ALSO bound somewhere the scan cannot follow to a value: a parameter (its caller decides,
 *  TS parameter properties included), a destructuring pattern (its type annotation read up to 300
 *  characters), or
 *  a for-of/for-in loop variable? Then no declaration speaks for it.
 *  Parameter lists and patterns are walked with `closeOf`/`splitTop`, not a regex: `[^()]*` stopped at
 *  a parenthesised type (`env: (A | B)`) and `[^=;]*` at a default inside a pattern (`{ env = {} }`),
 *  both silent misses (verify round 3). Errs loud: `if|for|while|switch|with (…)` are excluded, and
 *  any other `(…) {` or `(…) =>` outside a string counts as a parameter list. */
function opaqueBinding(src: string, name: string): boolean {
  const n = name.replace(/\$/g, "\\$");
  const bound = new RegExp(String.raw`(?<![\w$.])${n}(?![\w$])(?!\s*:(?!:))`);  // `{ env: e }` binds e
  /** Does one parameter (or declarator pattern) bind `name`? A pattern binds the names in it that are
   *  not keys; a plain parameter binds its leading identifier, whatever its type or default says. */
  const binds = (param: string): boolean => {
    const p = param.trim()
      .replace(/^(?:@[\w$.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|readonly|override)\s+)*/, "")   // TS parameter properties
      .replace(/^\.\.\.\s*/, "");
    if (p.startsWith("{") || p.startsWith("[")) {
      const end = closeOf(p, 0);
      return bound.test(end < 0 ? p : p.slice(0, end));
    }
    return new RegExp(String.raw`^${n}(?![\w$])`).test(p);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    // Walk code only: a `(` inside a string would send closeOf to the end of the file, once per paren.
    if (c === '"' || c === "'" || c === "`") { i = literalEnd(src, i); continue; }
    if (c !== "(" || /\b(?:if|for|while|switch|with)\s*$/.test(src.slice(Math.max(0, i - 10), i))) continue;
    const close = closeOf(src, i);
    if (close < 0 || !/^\s*(?::[^{};=]*?)?\s*(?:=>|\{)/.test(src.slice(close, close + 200))) continue;
    if (splitTop(src.slice(i + 1, close - 1)).some(binds)) return true;   // a parameter, typed, defaulted or not
  }
  if (new RegExp(String.raw`(?<![\w$.])${n}\s*=>`).test(src)) return true;                     // x => …
  for (const m of src.matchAll(/\b(?:const|let|var)\s*(?=[{[])/g)) {
    const at = m.index + m[0].length;
    const end = closeOf(src, at);
    // `const { env } = …`, `const [env] = …`, and the same pattern as a for-of / for-in variable.
    if (end > 0 && /^\s*(?:(?::(?:[^=]|=>)*?)?=(?![=>])|(?:of|in)\b)/.test(src.slice(end, end + 300)) && binds(src.slice(at, end))) return true;
  }
  return new RegExp(String.raw`\b(?:const|let|var)\s+${n}\s+(?:of|in)\b`).test(src);
}

/** Object literals a value can be: itself, or every value the binding it names is given. `opaque` when
 *  that binding also takes a value the scan cannot read (a call, another binding, a parameter…). */
function objectCandidates(value: string, src: string): { objs: string[]; opaque: boolean } {
  const v = bare(value);
  if (v.startsWith("{")) return { objs: [v], opaque: false };
  if (!/^[\w$]+$/.test(v)) return { objs: [], opaque: false };
  const inits = initializers(src, v).map(bare);
  return { objs: inits.filter((t) => t.startsWith("{")), opaque: opaqueBinding(src, v) || inits.some((t) => !t.startsWith("{")) };
}

/** What an env value provably does. `set` holds keys given a non-empty value, `cleared` keys given
 *  `undefined`/`null`/`""` or deleted, `spreads` a copy of process.env; `unread` is anything the scan
 *  cannot follow (a call, a binding with no declaration). A binding counts only for what EVERY one of its
 *  declarations does: see the scopes note above. */
type EnvFacts = { spreads: boolean; set: Set<string>; copied: Set<string>; cleared: Set<string>; unread: boolean };

function envFacts(value: string, src: string, hops = 0): EnvFacts {
  const v = bare(value);
  const facts = (): EnvFacts => ({ spreads: false, set: new Set(), copied: new Set(), cleared: new Set(), unread: false });
  if (/^(?:process|Bun)\s*\.\s*env$/.test(v)) return { ...facts(), spreads: true };
  if (/^[\w$]+$/.test(v)) {
    const decls = hops < 3 ? initializers(src, v) : [];
    if (decls.length === 0 || opaqueBinding(src, v)) return { ...facts(), unread: true };
    const each = decls.map((d) => envFacts(d, src, hops + 1));
    const out: EnvFacts = {
      spreads: each.every((f) => f.spreads),
      set: new Set([...each[0]!.set].filter((k) => each.every((f) => f.set.has(k)))),
      copied: new Set(each.flatMap((f) => [...f.copied, ...f.set]).filter((k) => each.every((f) => f.set.has(k) || f.copied.has(k)) && !each.every((f) => f.set.has(k)))),
      cleared: new Set(each.flatMap((f) => [...f.cleared])),
      unread: each.some((f) => f.unread),
    };
    // A delete or a clearing assignment on the binding, anywhere: `const env = {...}; delete env.X`.
    for (const k of clearsOn(v.replace(/\$/g, "\\$"), src)) {
      out.cleared.add(k);
      out.set.delete(k);
    }
    return out;
  }
  if (!v.startsWith("{")) return { ...facts(), unread: true };
  const out = facts();
  for (const p of splitTop(v.slice(1, Math.max(1, closeOf(v, 0) - 1)))) {
    if (p.startsWith("...")) {
      const f = envFacts(p.slice(3), src, hops);
      // A process.env spread can overwrite any key written before it, with whatever the parent holds.
      if (f.spreads) { out.spreads = true; for (const k of ISOLATING_VARS) { out.set.delete(k); out.copied.delete(k); } }
      for (const k of f.set) { out.set.add(k); out.copied.delete(k); out.cleared.delete(k); }
      for (const k of f.copied) { out.copied.add(k); out.set.delete(k); out.cleared.delete(k); }
      for (const k of f.cleared) { out.cleared.add(k); out.set.delete(k); }
      out.unread ||= f.unread;
      continue;
    }
    const m = /^(?:\[\s*["'`]([\w$]+)["'`]\s*\]|["'`]?([\w$]+)["'`]?)\s*(?::\s*([\s\S]*))?$/.exec(p);   // `X:`, `"X":`, `["X"]:`
    if (!m) continue;                                     // `[expr]:`: a key this scan cannot name
    const key = m[1] ?? m[2];
    const val = m[3];
    if (val !== undefined && new RegExp(`^${CLEARING}$`).test(val.trim().replace(/\s+as\s+[\s\S]*$/, ""))) {
      out.cleared.add(key!);
      out.set.delete(key!);
      out.copied.delete(key!);
    } else if (ISOLATING_VARS.includes(key!) && underRealHome(val ?? key!, src)) {
      out.cleared.add(key!);                              // pointed under the real home: as bad as a clear
      out.set.delete(key!);
      out.copied.delete(key!);
    } else if (readsEnv(val ?? key!, key!, src)) {
      out.copied.add(key!);                               // `X: process.env.X` — a spread by another name
      out.set.delete(key!);
      out.cleared.delete(key!);
    } else {
      out.set.add(key!);
      out.copied.delete(key!);
      out.cleared.delete(key!);
    }
  }
  return out;
}

/** A value that IS the parent's env object, or a copy of all of it: `process.env` (cast or not), a
 *  snapshot `{ ...process.env }`, `structuredClone(process.env)`, `Object.assign({}, process.env)`. */
const WHOLE_ENV = /^\(?\s*(?:\{\s*\.\.\.\s*|structuredClone\s*\(\s*|Object\s*\.\s*assign\s*\(\s*\{\s*\}\s*,\s*)?(?:process|Bun)\s*\.\s*env\b/;

/** Does this value COPY the parent's `key` rather than choose its own: `process.env.X`, a computed
 *  read `process.env[k]`, a read through an alias of the env object (`e.X`, where `e` is given
 *  WHOLE_ENV below, by
 *  declaration, later declarator or reassignment), a binding holding such a read, or a shorthand key
 *  destructured from process.env? Such a value counts only when the file imports the fixture. A value
 *  built FROM another variable (`join(process.env.TMPDIR, "cfg")`) chooses its own directory. Followed
 *  through bindings as a union, which errs loud: more text can only make a value look more like a copy. */
function readsEnv(value: string, key: string, src: string): boolean {
  const text = withDeclarations(value, src);
  const k = key.replace(/\$/g, "\\$");
  const at = String.raw`\s*(?:\??\.\s*${k}\b|\[\s*["'\`]${k}["'\`]\s*\])`;
  if (new RegExp(String.raw`\b(?:process|Bun)\s*\.\s*env(?:${at}|\s*\[\s*(?!["'\`]))`).test(text)) return true;
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])([\w$]+)${at}`, "g"))) {
    if (initializers(src, m[1]!).some((init) => WHOLE_ENV.test(bare(init)))) return true;   // an alias
  }
  const n = value.trim();
  if (!/^[\w$]+$/.test(n)) return false;
  const bound = new RegExp(String.raw`(?<![\w$.])${n.replace(/\$/g, "\\$")}(?![\w$])(?!\s*:(?!:))`);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*(?=\{)/g)) {
    const start = m.index + m[0].length;
    const end = closeOf(src, start);
    if (end > 0 && /^\s*(?::(?:[^=]|=>)*?)?=\s*(?:process|Bun)\s*\.\s*env\b/.test(src.slice(end, end + 300)) && bound.test(src.slice(start, end))) return true;
  }
  return false;
}

/** Does this value point under the REAL home? The fixture never redirects HOME, so
 *  `XDG_CONFIG_HOME: join(homedir(), ".config")` is the developer's real config dir, fixture import or
 *  not. Read: `process.env.HOME`, `e.HOME` through an alias of the env object, a `HOME` destructured
 *  from process.env, `homedir()` (also imported under another name), and `userInfo().homedir`. */
function underRealHome(value: string, src: string): boolean {
  const text = withDeclarations(value, src);
  const HOME_AT = String.raw`\s*(?:\??\.\s*HOME\b|\[\s*["'\`]HOME["'\`]\s*\])`;
  if (new RegExp(String.raw`\b(?:process|Bun)\s*\.\s*env${HOME_AT}|\bhomedir\s*\(|\buserInfo\s*\(\s*\)\s*\.\s*homedir\b`).test(text)) return true;
  for (const m of src.matchAll(/\bhomedir\s+as\s+([\w$]+)/g)) {
    if (new RegExp(String.raw`(?<![\w$.])${m[1]!.replace(/\$/g, "\\$")}\s*\(`).test(text)) return true;   // import { homedir as h }
  }
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])([\w$]+)${HOME_AT}`, "g"))) {
    if (initializers(src, m[1]!).some((init) => WHOLE_ENV.test(bare(init)))) return true;   // e.HOME
  }
  if (/(?<![\w$.])HOME(?![\w$])/.test(text.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""'))) {
    for (const m of src.matchAll(/\b(?:const|let|var)\s*(?=\{)/g)) {                           // const { HOME } = process.env
      const start = m.index + m[0].length;
      const end = closeOf(src, start);
      if (end > 0 && /^\s*(?::(?:[^=]|=>)*?)?=\s*(?:process|Bun)\s*\.\s*env\b/.test(src.slice(end, end + 300)) && /(?<![\w$.])HOME(?![\w$])(?!\s*:(?!:))/.test(src.slice(start, end))) return true;
    }
  }
  return false;
}

/** Isolating variables that a statement anywhere in `src` deletes or clears on `member`, a binding or
 *  a path to one given as a regex source (`env`, `opts\s*\.\s*env`): `delete env.X`,
 *  `delete (env as any).X`, `opts.env["X"] = undefined`, `Reflect.deleteProperty(env, "X")`,
 *  `Object.assign(env, { X: undefined })`. Scope-blind like the rest, which here errs loud. */
function clearsOn(member: string, src: string): string[] {
  return ISOLATING_VARS.filter((k) => {
    const key = String.raw`(?:\??\.\s*${k}\b|\[\s*["'\`]${k}["'\`]\s*\])`;
    const cast = String.raw`\(\s*${member}(?:\s+as\s+[^()]+)?\s*\)`;             // (env as Record<…>)
    const target = String.raw`(?:${member}|${cast})`;
    const castArg = String.raw`${member}(?:\s+as\s+[^,()]+)?`;                      // f(env as any, …)
    return [
      String.raw`\bdelete\s+${target}\s*${key}`,
      String.raw`(?<![\w$.])${target}\s*${key}\s*=\s*${CLEARING}`,
      String.raw`\bReflect\s*\.\s*deleteProperty\s*\(\s*${castArg}\s*,\s*["'\`]${k}["'\`]`,
      String.raw`\bObject\s*\.\s*assign\s*\(\s*${castArg}\s*,[^;]*?["'\`]?\b${k}["'\`]?\s*:\s*${CLEARING}`,
    ].some((re) => new RegExp(re).test(src));
  });
}

/** What is wrong with the env one options object hands its child, or null when the child is isolated.
 *  `via` names the binding the options came through, so `delete opts.env.X` is seen too. */
function envProblem(opts: string | undefined, src: string, via?: string): string | null {
  if (opts !== undefined && splitTop(opts.slice(1, Math.max(1, closeOf(opts, 0) - 1))).some((p) => p.startsWith("..."))) {
    return "the options object spreads another object, which may replace its `env` — write the options out in full";
  }
  const value = opts === undefined ? undefined : prop(opts, "env");
  if (value === undefined) return "no `env` option, so the child gets bun's STARTUP environment, which the isolation fixture never touched — pass `env: { ...process.env }`";
  const f = envFacts(value, src);
  if (via) {
    const v = via.replace(/\$/g, "\\$");
    for (const k of clearsOn(String.raw`${v}\s*\??\.\s*env`, src)) f.cleared.add(k);
    // A write to the binding's `env` replaces what the literal says: `opts.env = …`, `(opts as any).env =
    // …`, `opts["env"] = …`, `delete opts.env`, `Object.defineProperty(opts, "env", …)`, and an
    // Object.assign onto the binding whose source may carry `env` — `{ env: … }`, the shorthand `{ env }`
    // (verify round 4: missed), a spread, or an object the scan cannot see into. The Object.assign check
    // reads that call's own arguments, so a later, unrelated `env:` is not mistaken for one.
    const target = String.raw`(?:${v}|\(\s*${v}(?:\s+as\s+[^()]+)?\s*\))`;
    const member = String.raw`\s*(?:\??\.\s*env\b|\[\s*["'\`]env["'\`]\s*\])`;
    const writes = new RegExp(String.raw`(?<![\w$.])${target}${member}\s*=(?!=)|\bdelete\s+${target}${member}(?!\s*(?:\??\.|\[))|\bObject\s*\.\s*defineProperty\s*\(\s*${v}\b[^,]*,\s*["'\`]env["'\`]`).test(src);
    const assigns = [...blankLiterals(src).matchAll(/\bObject\s*\.\s*assign\s*\(/g)].some((m) => {
      const open = m.index + m[0].length - 1;
      const close = closeOf(src, open);
      const args = close < 0 ? [] : splitTop(src.slice(open + 1, close - 1));
      if (args.length < 2 || bare(args[0]!) !== via) return false;
      return args.slice(1).some((a) => {
        const o = bare(a);
        if (!o.startsWith("{")) return true;                // a binding or call: may carry env
        return splitTop(o.slice(1, Math.max(1, closeOf(o, 0) - 1))).some((p) => /^(?:\.\.\.|\[|["'`]?env["'`]?\s*(?::|$))/.test(p));
      });
    });
    if (writes || assigns) {
      return "the options binding's `env` is replaced or removed elsewhere (`opts.env = …`, `delete opts.env`, Object.assign/defineProperty), so the literal does not say what the child gets — pass the options inline";
    }
  }
  const cleared = ISOLATING_VARS.filter((k) => f.cleared.has(k));
  if (cleared.length) return `\`env\` clears ${cleared.join(" and ")} (undefined, null, "" or a delete) or points it under the real home (HOME, homedir()), so the child reaches the REAL location`;
  if (f.unread) return "`env` is built by something this scanner cannot follow to a value (a call, a parameter, a binding with no declaration, or one that refers back to itself) — write it as an object literal, or add an allowlist entry with a reason";
  const imports = importsIsolation(src);
  if (f.spreads && imports) return null;
  if (ISOLATING_VARS.every((k) => f.set.has(k) || (imports && f.copied.has(k)))) return null;
  return f.spreads || f.copied.size
    ? "`env` spreads (or copies) process.env, but the file does not import ./fixtures/isolate-state, so from outside the package root nothing armed the values it copies — import the fixture, or set DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME to your own directories after the spread"
    : "a fresh `env` must set BOTH DAILY_BRIEFING_STATE_DIR and XDG_CONFIG_HOME — HOME alone does not count (the scan cannot see its value, and a copied HOME is the real one), and whatever is missing resolves under the real home";
}

type EntrySpawn = { call: string; problem: string | null };

/** Does this command text, with its bindings followed, run `bun` on an entry point? One test for both
 *  call shapes below, so the spawn scan and the `run()` scan cannot disagree about what an entry is. */
function runsEntry(command: string, src: string): boolean {
  const resolved = withDeclarations(command, src);
  const entry = ENTRY_RE.test(resolved.replace(SEGMENT_JOIN, "/")) || literalsOf(resolved).some((l) => ENTRY_NAME_RE.test(l));
  return BUN_RE.test(resolved) && entry;
}

/** Every spawn of `bun` running an entry point in `src` (comment-stripped), each with what is wrong
 *  with its env, or null when the child is isolated. An options object held in a binding is judged in
 *  every declaration of that binding, and the first problem wins. */
function entrySpawns(src: string): EntrySpawn[] {
  const out: EntrySpawn[] = [];
  // src/proc.ts's `run(cmd, opts)`. It hands its child `{ ...process.env }` (pinned by
  // test/proc.env.test.ts) and RunOpts has no `env`, so every such call is a spread of process.env and
  // is judged by the spread rule: isolated when the file imports the fixture. Read over code only, so a
  // test NAMED "run() …" is not a call.
  for (const name of procRunNames(src)) {
    for (const m of blankLiterals(src).matchAll(new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, "\\$")}\s*(?:\?\.\s*)?\(`, "g"))) {
      const open = m.index + m[0].length - 1;
      const close = closeOf(src, open);
      if (close < 0 || !runsEntry(splitTop(src.slice(open + 1, close - 1))[0] ?? "", src)) continue;
      out.push({
        call: src.slice(m.index, close).replace(/\s+/g, " ").slice(0, 90),
        problem: importsIsolation(src) ? null : "src/proc.ts `run()` hands its child a copy of process.env, but the file does not import ./fixtures/isolate-state, so from outside the package root nothing armed the values it copies — import the fixture",
      });
    }
  }
  for (const m of src.matchAll(SPAWN_CALL_RE)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(src, open);
    if (close < 0) continue;
    const args = splitTop(src.slice(open + 1, close - 1));
    let optsList: string[];
    let command: string;
    let via: string | undefined;
    // Bun.spawn({ cmd: [...], env }) — the command lives INSIDE the options, written in place or bound.
    const oneArg = args.length === 1 ? objectCandidates(args[0]!, src) : { objs: [], opaque: false };
    const cmdForm = oneArg.objs.filter((o) => prop(o, "cmd") !== undefined);
    let opaque = false;
    const binding = (a: string): string | undefined => (/^[\w$]+$/.test(bare(a)) ? bare(a) : undefined);
    if (cmdForm.length) {
      optsList = cmdForm;
      command = cmdForm.map((o) => prop(o, "cmd")).join(", ");
      via = binding(args[0]!);
      opaque = oneArg.opaque || cmdForm.length < oneArg.objs.length;
    } else {
      const at = args.findIndex((a, k) => k > 0 && objectCandidates(a, src).objs.length > 0);
      const oc = at < 0 ? { objs: [], opaque: false } : objectCandidates(args[at]!, src);
      optsList = oc.objs;
      opaque = oc.opaque;
      command = args.filter((_, k) => k !== at).join(", ");
      via = at < 0 ? undefined : binding(args[at]!);
    }
    if (!runsEntry(command, src)) continue;
    const problems = optsList.length ? optsList.map((o) => envProblem(o, src, via)) : [envProblem(undefined, src)];
    if (opaque) problems.push("the options come through a binding that also takes a value this scanner cannot read (a call, another binding, a parameter) — pass the options inline");
    out.push({ call: src.slice(m.index, close).replace(/\s+/g, " ").slice(0, 90), problem: problems.find((p) => p !== null) ?? null });
  }
  return out;
}

/** Test files whose entry spawn legitimately runs without the isolated env. Every entry needs a reason
 *  that is a PROPERTY of the file. Empty: the one instance there was got `env` instead. */
const SPAWN_ENV_ALLOW: Record<string, string> = {};

test("every child bun that runs an entry point is handed the isolated env", async () => {
  const files = await testFiles();
  // Tier B (T4.4): re-measured at 144 (scanner 1's count); floored two below.
  // Tier B (T4.5): re-measured at 145; floored two below.
  // Tier B (T4.6): re-measured at 148; floored two below.
  // Tier B (T5.1): re-measured at 149; floored two below.
  // Tier B (T5.2): re-measured at 150; floored two below.
  // Phase E (M2 fix, 2026-10-01): re-measured at 158 (scanner 1's count); floored two below.
  // Phase E (M3, 2026-10-01): re-measured at 163 (scanner 1's count); floored two below.
  // Phase E (M4, 2026-10-01): re-measured at 164 (scanner 1's count); floored two below.
  // Phase E (M5, 2026-10-01): re-measured at 168 (scanner 1's count); floored two below.
  // Phase E final harden (2026-10-02): re-measured at 174 (scanner 1's count; round 1 said 172, round 3
  // 173); floored two below.
  expect(files.length).toBeGreaterThanOrEqual(172);
  // The names that stand for an entry without its path. If these stop being read, every
  // `join(SCRIPTS, "x.ts")` and `bun run audit` spawn silently drops out of the scan.
  expect(ENTRY_NAMES).toEqual(expect.arrayContaining(["audit", "eval", "inspect-whys", "main", "start"]));
  const offenders: string[] = [];
  const spawners: string[] = [];
  const flagged = new Set<string>();
  let sites = 0;
  for (const f of files) {
    if (f === SELF) continue;   // names every spawn shape as data, in the table below
    const found = entrySpawns(sourceWithHelpers(f));
    if (found.length === 0) continue;
    spawners.push(f);
    sites += found.length;
    for (const s of found) {
      if (!s.problem) continue;
      flagged.add(f);
      if (!(f in SPAWN_ENV_ALLOW)) offenders.push(`${f}: \`${s.call}\` — ${s.problem}`);
    }
  }
  // Non-vacuity. Measured at this commit: 5 sites in 5 files — dispatch.json, json-surfaces, run-lock,
  // inspect-whys and diag.credential-redaction. Floored AT the measurement, like scanner 3: the set is
  // small enough that any drop is the matcher rotting rather than the suite getting cleaner.
  // Re-measured at 7 in 7 once src/proc.ts `run()` calls were read: audit-main (through its import of
  // scripts/audit.ts, whose regeneration runs `bun run src/main.ts run --force`) and
  // proc.incomplete-read.
  expect(sites).toBeGreaterThanOrEqual(7);
  // The two shapes that carry the rest. dispatch.json names its entry through a `const entry` binding,
  // so it is found only if the declaration walk works; diag.credential-redaction spells the path
  // literally and hands the child a fresh env.
  expect(spawners).toContain("dispatch.json.test.ts");
  expect(spawners).toContain("diag.credential-redaction.test.ts");
  // The `run()` scan, found only if it reads a helper's import: audit-main reaches the real
  // regeneration call through scripts/audit.ts, whose cmd is a `const cmd = … ? … : …` binding.
  expect(spawners).toContain("audit-main.test.ts");
  expect(offenders).toEqual([]);
  // A stale exemption reads as a considered decision while covering nothing. Same rule as the other
  // allowlists: an entry must still name a file with a flagged spawn.
  const stale = Object.keys(SPAWN_ENV_ALLOW).filter((f) => !flagged.has(f));
  expect(`stale allowlist entry: ${stale.join(", ") || "none"}`).toBe("stale allowlist entry: none");
});

test("scanner 6 judges each bun entry spawn by the env it hands the child", () => {
  // [name, source, one verdict per entry spawn found]. `ISO` is the fixture import the spread rule reads.
  const ISO = 'import "./fixtures/isolate-state";\n';
  const MAIN = 'Bun.spawn(["bun", "src/main.ts"], ';
  type Verdict = "offender" | "isolated";
  const rows: [string, string, Verdict[]][] = [
    // ── no env: the class this scanner exists for ──
    ["dispatch.json's shape: entry through a binding", ISO + 'const entry = resolve(new URL("../src/main.ts", import.meta.url).pathname);\nconst p = Bun.spawn(["bun", entry, "config", "validate", "--json", "--stdin"], { stdin: x, stdout: "pipe" });', ["offender"]],
    ["literal path, no options at all", ISO + 'Bun.spawnSync(["bun", "run", "scripts/audit.ts"]);', ["offender"]],
    ["the cmd form", ISO + 'Bun.spawn({ cmd: ["bun", "src/main.ts", "run"], stdout: "pipe" });', ["offender"]],
    ["child_process, bare main.ts", ISO + 'spawnSync("bun", ["main.ts", "run"], { cwd: root });', ["offender"]],
    ["execPath and a segmented path", ISO + 'execFileSync(process.execPath, [join(ROOT, "scripts", "eval.ts")]);', ["offender"]],
    ["argv[0] as the runtime", ISO + 'Bun.spawnSync([process.argv[0], "src/main.ts"]);', ["offender"]],
    ["the runtime by absolute path", ISO + 'Bun.spawnSync(["/opt/homebrew/bin/bun", "src/main.ts"]);', ["offender"]],
    ["a shell string", ISO + 'execSync("bun src/main.ts doctor --json");', ["offender"]],
    ["a shell string, extensionless (bun resolves it)", ISO + 'execSync("bun src/main doctor --json");', ["offender"]],
    ["extensionless, followed by another argument", ISO + 'Bun.spawnSync(["bun", "src/main", "run"]);', ["offender"]],
    ["flags before a package script", ISO + 'execSync("bun --env-file=.env start");', ["offender"]],
    ["flags before an extensionless path", ISO + 'execSync("bun --smol src/main doctor");', ["offender"]],
    ["a shell string with a flag before a bare main.ts", ISO + 'execSync("bun --smol main.ts doctor");', ["offender"]],
    ["a script that is not on disk yet", ISO + 'Bun.spawnSync(["bun", "scripts/not-written-yet.ts"]);', ["offender"]],
    ["async exec, measured safe, flagged anyway", ISO + 'cp.exec("bun src/main.ts doctor", (e) => done(e));', ["offender"]],
    ["a template naming the entry binding", ISO + 'const entry = "../src/main.ts";\nexecSync(`bun ${entry} doctor`);', ["offender"]],
    ["namespace-qualified, with a callback", ISO + 'cp.execFile("bun", ["src/main.ts"], (e) => done(e));', ["offender"]],
    ["the async spawn, measured safe, flagged anyway", ISO + 'cp.spawn("bun", ["src/main.ts"]);', ["offender"]],
    ["argv0 destructured from process", ISO + 'const { argv0 } = process;\nBun.spawnSync([argv0, "src/main.ts"]);', ["offender"]],
    ["a quoted name and a shell operator in a shell string", ISO + 'execSync("bun run \'audit\'"); execSync("bun start>/dev/null");', ["offender", "offender"]],
    ["a non-null-asserted callee", ISO + 'cp!.spawnSync("bun", ["src/main.ts"]);', ["offender"]],
    ["execPath destructured from process", ISO + 'const { execPath } = process;\nBun.spawnSync([execPath, "src/main.ts"]);', ["offender"]],
    ["a first-position defaulted parameter", ISO + 'function f(entry = "src/main.ts") { Bun.spawnSync(["bun", entry]); }', ["offender"]],
    ["a typed later declarator", ISO + 'const a = 1, entry: string = "src/main.ts";\nBun.spawnSync(["bun", entry]);', ["offender"]],
    ["flags after `run` before a package script", ISO + 'execSync("bun run --silent audit");', ["offender"]],
    ["bun build is flagged on purpose: a compiled binary may run next", ISO + 'Bun.spawnSync(["bun", "build", "src/main.ts", "--compile"]);', ["offender"]],
    ["optional-chained and type-argumented callees", ISO + 'cp?.spawnSync("bun", ["src/main.ts"]); Bun.spawnSync<"pipe">(["bun", "src/main.ts"]);', ["offender", "offender"]],
    ["options through a binding without env", ISO + 'const opts = { stdout: "pipe" };\nBun.spawn(["bun", "src/main.ts"], opts);', ["offender"]],
    ["three hops: argv, then entry, then rel", ISO + 'const rel = "../src/main.ts";\nconst entry = resolve(ROOT, rel);\nconst argv = ["bun", entry, "run"];\nBun.spawnSync(argv);', ["offender"]],
    ["a later declarator in a list", ISO + 'const bin = "bun", entry = "src/main.ts";\nBun.spawnSync([bin, entry]);', ["offender"]],
    ["an arrow split across lines", ISO + 'const argv = () =>\n  ["bun", "src/main.ts"];\nBun.spawnSync(argv());', ["offender"]],
    ["a script through a directory binding", ISO + 'Bun.spawnSync(["bun", join(SCRIPTS, "audit.ts")]); Bun.spawnSync(["bun", `${SCRIPTS}/eval`]);', ["offender", "offender"]],
    ["package.json scripts that run an entry", ISO + 'Bun.spawnSync(["bun", "run", "audit"]); Bun.spawnSync(["bun", "start"]); execSync("bun run eval --x");', ["offender", "offender", "offender"]],
    ["a nested template in the argv does not end the call early", ISO + MAIN.slice(0, -3) + ', `${f(`)`)}`], { env: { ...process.env } });', ["isolated"]],
    // ── an env that does not isolate ──
    ["env copies PATH, which is not a spread", ISO + MAIN + '{ env: { PATH: process.env.PATH } });', ["offender"]],
    ["fresh env with the state dir only: config falls back", ISO + MAIN + '{ env: { PATH: p, DAILY_BRIEFING_STATE_DIR: d } });', ["offender"]],
    ["fresh env with HOME only: the scan cannot see it is not the real one", ISO + MAIN + '{ env: { PATH: process.env.PATH!, HOME: process.env.HOME! } });', ["offender"]],
    ["a template naming HOME in a value is not a key", ISO + 'const env = { PATH: `${HOME}/bin:${XDG_CONFIG_HOME},${DAILY_BRIEFING_STATE_DIR}` };\n' + MAIN + '{ env });', ["offender"]],
    ["spread, no fixture import", MAIN + '{ env: { ...process.env } });', ["offender"]],
    ["spread plus HOME, no fixture import", MAIN + '{ env: { ...process.env, HOME: h } });', ["offender"]],
    ["both variables BEFORE a spread, no import: the spread overwrites them", MAIN + '{ env: { XDG_CONFIG_HOME: c, DAILY_BRIEFING_STATE_DIR: s, ...process.env } });', ["offender"]],
    ["a spread that clears a variable", ISO + MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: undefined } }); ' + MAIN + '{ env: { ...process.env, DAILY_BRIEFING_STATE_DIR: "" } });', ["offender", "offender"]],
    ["void 0 clears a variable too", ISO + MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: void 0 } });', ["offender"]],
    ["a delete through the options binding", ISO + 'const opts = { env: { ...process.env } };\ndelete opts.env.XDG_CONFIG_HOME;\n' + MAIN + 'opts);', ["offender"]],
    ["a delete on the env binding", ISO + 'const env = { ...process.env };\ndelete env.XDG_CONFIG_HOME;\n' + MAIN + '{ env });', ["offender"]],
    ["an env built by a call", ISO + MAIN + '{ env: makeEnv(dir) });', ["offender"]],
    ["a call spread after process.env could clear anything", ISO + MAIN + '{ env: { ...process.env, ...extra() } });', ["offender"]],
    ["a semicolon-free env binding does not borrow the next line's keys", ISO + 'const env = { PATH: p }\nconst other = { XDG_CONFIG_HOME: c, DAILY_BRIEFING_STATE_DIR: s }\n' + MAIN + '{ env });', ["offender"]],
    ["a sibling test's same-named env does not vouch for this one", ISO + 'test("a", () => { const env = { ...process.env }; });\ntest("b", () => { const env = { PATH: p };\n' + MAIN + '{ env }); });', ["offender"]],
    ["a sibling test's same-named options do not vouch either", ISO + 'const opts = { env: { ...process.env } };\nconst opts = { stdout: "pipe" };\n' + MAIN + 'opts);', ["offender"]],
    ["…nor when the good env is declared LAST", ISO + 'test("b", () => { const env = { PATH: p };\n' + MAIN + '{ env }); });\ntest("a", () => { const env = { ...process.env }; });', ["offender"]],
    ["…nor when the good options are declared LAST", ISO + 'const opts = { stdout: "pipe" };\nconst opts = { env: { ...process.env } };\n' + MAIN + 'opts);', ["offender"]],
    ["a parameter named env borrows nothing from a sibling", ISO + 'test("a", () => { const env = { ...process.env }; });\nfunction runIt(env: Record<string, string>) { return ' + MAIN + '{ env }); }', ["offender"]],
    ["an arrow parameter named env", ISO + 'const env = { ...process.env };\nconst go = (env) => ' + MAIN + '{ env });', ["offender"]],
    ["a destructured env", ISO + 'const env = { ...process.env };\nconst { env } = mk();\n' + MAIN + '{ env });', ["offender"]],
    ["a loop variable named env", ISO + 'const env = { ...process.env };\nfor (const env of envs) ' + MAIN + '{ env });', ["offender"]],
    ["a parameter whose type holds parentheses", ISO + 'test("a", () => { const env = { ...process.env }; });\nfunction run(env: (Record<string, string> | null)) { ' + MAIN + '{ env }); }', ["offender"]],
    ["an options parameter with a function type in it", ISO + 'test("a", () => { const opts = { env: { ...process.env } }; });\nfunction run(opts: { log: () => void }) { ' + MAIN + 'opts); }', ["offender"]],
    ["a destructured env whose default isolates: the real value comes from config", ISO + 'test("a", () => { const env = { ...process.env }; });\nconst { env = { ...process.env } } = config;\n' + MAIN + '{ env });', ["offender"]],
    ["a destructured loop variable", ISO + 'const env = { ...process.env };\nfor (const { env } of list) ' + MAIN + '{ env });', ["offender"]],
    ["a TS parameter property named env", ISO + 'test("a", () => { const env = { ...process.env }; });\nclass R { constructor(private readonly env: E) { ' + MAIN + '{ env }); } }', ["offender"]],
    ["a destructured env whose type annotation holds an arrow and semicolons", ISO + 'test("a", () => { const env = { ...process.env }; });\nconst { env, log }: { env: E; log: () => void } = cfg;\n' + MAIN + '{ env });', ["offender"]],
    ["an arrow returned straight from a function", ISO + 'const env = { ...process.env };\nconst mk = () => { return (env: E) => ' + MAIN + '{ env }); };', ["offender"]],
    ["an unquoted computed key names nothing", MAIN + '{ env: { [XDG_CONFIG_HOME]: c, DAILY_BRIEFING_STATE_DIR: s } });', ["offender"]],
    ["a reassigned env", ISO + 'let env = { ...process.env };\nenv = { PATH: p };\n' + MAIN + '{ env });', ["offender"]],
    ["options built by a call beside a sibling literal", ISO + 'const opts = { env: { ...process.env } };\nconst opts = baseOpts();\n' + MAIN + 'opts);', ["offender"]],
    ["an options spread that may replace env", ISO + MAIN + '{ env: { ...process.env }, ...extra });', ["offender"]],
    ["Reflect.deleteProperty on the env binding", ISO + 'const env = { ...process.env };\nReflect.deleteProperty(env, "XDG_CONFIG_HOME");\n' + MAIN + '{ env });', ["offender"]],
    ["a delete through a cast", ISO + 'const env = { ...process.env };\ndelete (env as any).XDG_CONFIG_HOME;\n' + MAIN + '{ env });', ["offender"]],
    ["Object.assign clearing a variable", ISO + 'const env = { ...process.env };\nObject.assign(env, { XDG_CONFIG_HOME: undefined });\n' + MAIN + '{ env });', ["offender"]],
    ["a copy destructured from process.env, shorthand keys, no import", 'const { XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR } = process.env;\n' + MAIN + '{ env: { XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR } });', ["offender"]],
    ["a copy held in a binding, no import", 'const XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;\nconst s = process.env.DAILY_BRIEFING_STATE_DIR;\n' + MAIN + '{ env: { XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: s } });', ["offender"]],
    ["a copy through an alias of process.env, no import", 'const e = process.env;\n' + MAIN + '{ env: { XDG_CONFIG_HOME: e.XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: e.DAILY_BRIEFING_STATE_DIR } });', ["offender"]],
    ["env replaced through the options binding", ISO + 'const opts = { env: { ...process.env } };\nopts.env = { PATH: p };\n' + MAIN + 'opts);', ["offender"]],
    ["env replaced through Object.assign on the options binding", ISO + 'const opts = { env: { ...process.env } };\nObject.assign(opts, { env: { PATH: p } });\n' + MAIN + 'opts);', ["offender"]],
    ["Object.assign with a shorthand env on the options binding", ISO + 'const opts = { env: { ...process.env } };\nconst env = { PATH: p };\nObject.assign(opts, { env });\n' + MAIN + 'opts);', ["offender"]],
    ["env deleted from the options binding inside a block", ISO + 'const opts = { env: { ...process.env } };\nif (x) { delete opts.env }\n' + MAIN + 'opts);', ["offender"]],
    ["env deleted from the options binding", ISO + 'const opts = { env: { ...process.env } };\ndelete opts.env;\n' + MAIN + 'opts);', ["offender"]],
    ["env redefined on the options binding", ISO + 'const opts = { env: { ...process.env } };\nObject.defineProperty(opts, "env", { value: {} });\n' + MAIN + 'opts);', ["offender"]],
    ["a delete through an optional chain on the options binding", ISO + 'const opts = { env: { ...process.env } };\ndelete opts?.env.XDG_CONFIG_HOME;\n' + MAIN + 'opts);', ["offender"]],
    ["Reflect.deleteProperty through a cast", ISO + 'const env = { ...process.env };\nReflect.deleteProperty(env as any, "XDG_CONFIG_HOME");\n' + MAIN + '{ env });', ["offender"]],
    ["Object.assign with a quoted key", ISO + 'const env = { ...process.env };\nObject.assign(env, { "XDG_CONFIG_HOME": undefined });\n' + MAIN + '{ env });', ["offender"]],
    ["a delete through a generic cast", ISO + 'const env = { ...process.env };\ndelete (env as Record<string, string>).XDG_CONFIG_HOME;\n' + MAIN + '{ env });', ["offender"]],
    ["a clearing assignment through a cast", ISO + 'const env = { ...process.env };\n(env as any).XDG_CONFIG_HOME = undefined;\n' + MAIN + '{ env });', ["offender"]],
    ["a computed quoted key and void(0) in the literal", ISO + MAIN + '{ env: { ...process.env, ["XDG_CONFIG_HOME"]: undefined } }); ' + MAIN + '{ env: { ...process.env, DAILY_BRIEFING_STATE_DIR: void(0) } });', ["offender", "offender"]],
    ["values copied from process.env, no fixture import", MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: process.env.DAILY_BRIEFING_STATE_DIR } });', ["offender"]],
    // ── isolated ──
    ["spread, fixture imported", ISO + MAIN + '{ env: { ...process.env } });', ["isolated"]],
    ["process.env passed whole", ISO + MAIN + '{ env: process.env as any });', ["isolated"]],
    ["an env literal with a cast after it", ISO + MAIN + '{ env: { ...process.env } as Record<string, string> });', ["isolated"]],
    ["Bun.env, the same object, spread", ISO + MAIN + '{ env: { ...Bun.env } });', ["isolated"]],
    ["the cmd form, env in the same object", ISO + 'Bun.spawn({ cmd: ["bun", "src/main.ts", "run"], env: { ...process.env } });', ["isolated"]],
    ["an options binding behind a cast or a non-null assertion", ISO + 'const opts = { env: { ...process.env } };\n' + MAIN + 'opts as any); ' + MAIN + 'opts!);', ["isolated", "isolated"]],
    ["the cmd form through a binding", ISO + 'const o = { cmd: ["bun", "src/main.ts"], env: { ...process.env } };\nBun.spawn(o);', ["isolated"]],
    ["a comma inside another parameter's default does not make env a parameter", ISO + 'function helper(config = { port: 8080, env: "prod" }) {}\nconst env = { ...process.env };\n' + MAIN + '{ env });', ["isolated"]],
    ["copies through a cast alias, a later declarator, a reassignment and a snapshot, no import", 'const e = process.env as Record<string, string>;\nconst a = 1, f = process.env;\nlet g; g = { ...process.env };\n' + MAIN + '{ env: { XDG_CONFIG_HOME: e.XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: f.DAILY_BRIEFING_STATE_DIR } }); ' + MAIN + '{ env: { XDG_CONFIG_HOME: g.XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: s } });', ["offender", "offender"]],
    ["a computed read of process.env is a copy, no import", MAIN + '{ env: { XDG_CONFIG_HOME: process.env[k], DAILY_BRIEFING_STATE_DIR: s } });', ["offender"]],
    ["a directory under the real home, even with the fixture imported", ISO + MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: join(process.env.HOME!, ".config") } }); ' + MAIN + '{ env: { PATH: p, XDG_CONFIG_HOME: join(homedir(), ".cfg"), DAILY_BRIEFING_STATE_DIR: s } });', ["offender", "offender"]],
    ["the real home by other spellings, even with the fixture imported", ISO + 'const { HOME } = process.env;\nconst e = process.env;\nimport { homedir as h } from "node:os";\n' + MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: join(HOME!, ".config") } }); ' + MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: join(e.HOME!, ".config") } }); ' + MAIN + '{ env: { ...process.env, XDG_CONFIG_HOME: join(h(), ".config") } }); ' + MAIN + '{ env: { ...process.env, DAILY_BRIEFING_STATE_DIR: join(userInfo().homedir, "s") } });', ["offender", "offender", "offender", "offender"]],
    ["a copy through Object.assign({}, process.env), no import", 'const e = Object.assign({}, process.env);\n' + MAIN + '{ env: { XDG_CONFIG_HOME: e.XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: s } });', ["offender"]],
    ["a delete of another key through the options binding's env is not a removal of env", ISO + 'const opts = { env: { ...process.env } };\ndelete opts.env.PATH;\n' + MAIN + 'opts);', ["isolated"]],
    ["a directory built FROM another variable is not a copy", 'const tmp = process.env.TMPDIR;\n' + MAIN + '{ env: { XDG_CONFIG_HOME: join(tmp, "cfg"), DAILY_BRIEFING_STATE_DIR: join(tmp, "state") } });', ["isolated"]],
    ["Object.assign onto the options binding without env, then an unrelated env key", ISO + 'const opts = { env: { ...process.env } }\nObject.assign(opts, { stdout: "pipe" })\nconst other = { env: 1 }\n' + MAIN + 'opts);', ["isolated"]],
    ["values copied from process.env, fixture imported", ISO + MAIN + '{ env: { PATH: p, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR: process.env["DAILY_BRIEFING_STATE_DIR"] } });', ["isolated"]],
    ["spread plus both variables, no import", 'Bun.spawn(["bun", entry, "doctor"], { env: { ...process.env, XDG_CONFIG_HOME: c, DAILY_BRIEFING_STATE_DIR: s } });\nconst entry = resolve(new URL("../src/main.ts", import.meta.url).pathname);', ["isolated"]],
    ["fresh env with both variables and HOME (diag.credential-redaction's shape)", 'Bun.spawn(["bun", "run", "src/main.ts"], { env: { PATH: p, HOME: h, XDG_CONFIG_HOME: c, DAILY_BRIEFING_STATE_DIR: s } });', ["isolated"]],
    ["fresh env with both variables as shorthand", MAIN + '{ env: { PATH, XDG_CONFIG_HOME, DAILY_BRIEFING_STATE_DIR } });', ["isolated"]],
    ["env shorthand, resolved through its binding", ISO + 'const env = { ...process.env };\n' + MAIN + '{ cwd, env });', ["isolated"]],
    // ── src/proc.ts run(): it passes { ...process.env }, so the spread rule decides ──
    ["run() imported from src/proc, fixture imported", ISO + 'import { run } from "../src/proc";\nawait run(["bun", "run", "src/main.ts"]);', ["isolated"]],
    ["run() imported from src/proc, no fixture import", 'import { run } from "../src/proc";\nawait run(["bun", "run", "src/main.ts"]);', ["offender"]],
    ["run() aliased, beside a type import, no fixture import", 'import { type RunResult, run as sh } from "./proc.ts";\nawait sh(["bun", "src/main.ts", "doctor"]);', ["offender"]],
    ["scripts/audit.ts's regeneration shape, no fixture import", 'import { run } from "../src/proc";\nconst cmd = (await Bun.file(BIN).exists()) ? [BIN, "run", "--force"] : ["bun", "run", "src/main.ts", "run", "--force"];\nconst outcome = await run(cmd, { cwd: ROOT, flushMs: F, timeoutMs: T });', ["offender"]],
    ["run() destructured from a dynamic import, plain and renamed, no fixture import", 'const { run } = await import("../src/proc");\nawait run(["bun", "run", "src/main.ts"]);\nconst { run: sh } = await import("./proc.ts");\nawait sh(["bun", "src/main.ts"]);', ["offender", "offender"]],
    ["run() imported with a .js specifier, no fixture import", 'import { run } from "../src/proc.js";\nawait run(["bun", "run", "src/main.ts"]);', ["offender"]],
    ["run() called through an optional call, no fixture import", 'import { run } from "../src/proc";\nawait run?.(["bun", "run", "src/main.ts"]);', ["offender"]],
    ["run() from a dynamic import, fixture imported", ISO + 'const { run } = await import("../src/proc");\nawait run(["bun", "run", "src/main.ts"]);', ["isolated"]],
    ["run() destructured from require, plain and renamed, no fixture import", 'const { run } = require("../src/proc");\nawait run(["bun", "run", "src/main.ts"]);\nconst { run: sh } = require("./proc.ts");\nawait sh(["bun", "src/main.ts"]);', ["offender", "offender"]],
    ["run() destructured from require, fixture imported", ISO + 'const { run } = require("../src/proc");\nawait run(["bun", "run", "src/main.ts"]);', ["isolated"]],
    ["…and with the fixture imported", ISO + 'import { run } from "../src/proc";\nconst cmd = (await Bun.file(BIN).exists()) ? [BIN, "run", "--force"] : ["bun", "run", "src/main.ts", "run", "--force"];\nconst outcome = await run(cmd, { cwd: ROOT, flushMs: F, timeoutMs: T });', ["isolated"]],
    // ── not an entry spawn at all ──
    ["git naming main.ts", 'Bun.spawn(["git", "add", "src/main.ts"], {});', []],
    ["bun running a probe fixture", 'const PROBE = join(import.meta.dir, "fixtures/state-tripwire.probe.ts");\nBun.spawn(["bun", "test", PROBE], {});', []],
    ["bun -e importing a src module", 'const gitTs = resolve(import.meta.dir, "../src/git.ts");\nBun.spawn(["bun", "-e", `await import(${JSON.stringify(gitTs)})`], {});', []],
    ["quoted words inside a bun -e script are not entries", 'Bun.spawn(["bun", "-e", "console.log(\'eval\', \'start\', \'main\')"], {});', []],
    ["bun pm pack", 'Bun.spawnSync(["bun", "pm", "pack", "--dry-run"], {});', []],
    ["names that only look like entries", 'Bun.spawn(["bun", "src/mainline.ts"]); Bun.spawn(["bun", "domain.ts"]); Bun.spawn(["bun", "myscripts/x.ts"]); Bun.spawn(["bun", "scripts/uninstall.sh"]);', []],
    ["an in-process dispatch, not a spawn", 'await dispatch(["bun", "bin", "run"], deps); const argv = ["bun", "main.ts", "init"]; await main(argv);', []],
    ["RegExp#exec", 'const hit = SPAWN_RE.exec(src);', []],
    ["Bun.$, measured to pass the runtime env", 'await Bun.$`bun src/main.ts doctor`;', []],
    ["run() from src/proc running no entry, a test named after it, a call quoted in a string", 'import { run } from "../src/proc";\nconst doc = \'await run(["bun", "src/main.ts"])\';\ntest("run() works", async () => { await run(["git", "log"]); await run(["bun", "pm", "pack"]); });', []],
    ["a run() not imported from src/proc is some other function", 'import { run } from "../src/main";\nimport type { RunResult } from "../src/proc";\nawait run(["bun", "run", "src/main.ts"]);', []],
    // KNOWN MISSES, pinned so they stay deliberate. Silent, so a real spawn passes.
    ["KNOWN MISS: src/proc.ts run() as a member of the module", 'import * as proc from "../src/proc";\nawait proc.run(["bun", "run", "src/main.ts"]);\nawait (await import("../src/proc")).run(["bun", "src/main.ts"]);\nawait require("../src/proc").run(["bun", "src/main.ts"]);', []],
    ["KNOWN MISS: a callee qualified by a call", 'require("node:child_process").spawnSync("bun", ["src/main.ts"]);', []],
    ["KNOWN MISS: an aliased callee", 'const sp = Bun.spawnSync;\nsp(["bun", "src/main.ts"]);', []],
    ["KNOWN MISS: the entry handed to a helper as an argument", 'const bunRun = (...a) => Bun.spawnSync(["bun", ...a]);\nbunRun("src/main.ts");', []],
    ["KNOWN MISS: a computed-member callee", 'cp["spawnSync"]("bun", ["src/main.ts"]);', []],
    ["KNOWN MISS: src/proc.ts run() through an alias binding", 'import { run } from "../src/proc";\nconst sh = run;\nawait sh(["bun", "run", "src/main.ts"]);', []],
    ["KNOWN MISS: a command array spread from a binding", 'const BASE = ["bun", "run"];\nBun.spawnSync([...BASE, "src/main.ts"]);\nimport { run } from "../src/proc";\nawait run([...BASE, "src/main.ts"]);', []],
    ["KNOWN MISS: a clear through an alias of the env binding", 'import "./fixtures/isolate-state";\nconst env = { ...process.env };\nconst e2 = env;\ndelete e2.XDG_CONFIG_HOME;\nBun.spawn(["bun", "src/main.ts"], { env });', ["isolated"]],
  ];
  // Two scan costs that must stay linear. The flag loop's `--?[\w-]+` predecessor could split `--f` two
  // ways: review measured 1.1-3 s at 24 flags and 2.25-2.6 s at 26 on different machines, against
  // ~0.1 ms now. And opaqueBinding once ran closeOf from every `(`, strings included, so each unbalanced
  // `(` in a string scanned to the end of the file: review measured 3.9 s on the 16,000-line input
  // below without the literal skip, against ~6 ms with it.
  const t0 = performance.now();
  ENTRY_NAME_RE.test("bun" + " --f".repeat(26) + " x");
  expect(`flag loop: ${performance.now() - t0 < 250 ? "fast" : "SLOW"}`).toBe("flag loop: fast");
  const t1 = performance.now();
  opaqueBinding('const s = "(";\n'.repeat(16000), "env");
  expect(`paren walk: ${performance.now() - t1 < 250 ? "fast" : "SLOW"}`).toBe("paren walk: fast");
  // The options-binding check's Object.assign scan, the same defect class: review measured 1.6 s on the
  // 8,000-line input below while it matched calls inside strings, against ~15 ms reading code only.
  const t2 = performance.now();
  envProblem("{ env: { ...process.env } }", 'const s = "Object.assign(";\n'.repeat(8000) + "const opts = {};", "opts");
  expect(`Object.assign scan: ${performance.now() - t2 < 250 ? "fast" : "SLOW"}`).toBe("Object.assign scan: fast");
  const t3 = performance.now();
  procRunNames("const {".repeat(16000) + "import {".repeat(16000) + 'const { run } = require("./'.repeat(16000));
  expect(`run() import scan: ${performance.now() - t3 < 250 ? "fast" : "SLOW"}`).toBe("run() import scan: fast");
  const got = Object.fromEntries(rows.map(([name, src]) => [name, entrySpawns(stripComments(src)).map((s): Verdict => (s.problem ? "offender" : "isolated"))]));
  const want = Object.fromEntries(rows.map(([name, , verdict]) => [name, verdict]));
  expect(got).toEqual(want);
});
