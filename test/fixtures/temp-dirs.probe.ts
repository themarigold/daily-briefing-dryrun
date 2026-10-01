// test/fixtures/temp-dirs.probe.ts — the CHILD PROCESS behind test/fixtures/temp-dirs.test.ts.
//
// ⚠ NOT a `*.test.ts`, deliberately: bun must not collect it, because the only honest way to exercise
// `removeRegisteredTempDirs()` is to actually CALL it, and `registered` is one module-level list that
// `test/preload.ts` drains once for the whole run. Calling it from inside the run would delete the
// hundreds of directories every other test file registered, mid-run — precisely the "nothing is removed
// before run end" contract that module exists to hold. A child process gets its own module instance, its
// own list and its own TMPDIR, so the drain it performs is over its own fixtures and nothing else.
//
// Contract with the parent:
//   • it does NOTHING unless the parent launched it. Two gates run before any filesystem work, in every
//     mode: `DBA_PROBE_CHILD=1` (set only by the parent's own spawns) and argv[2] being one of
//     the MODES below. Failing either — a hand run such as `bun test/fixtures/temp-dirs.probe.ts`, or a
//     typo'd mode — reports a `fatal` starting "refused:" and creates, chmods and chflags nothing. That
//     matters because the `finally` walks TMPDIR recursively, and a hand run's TMPDIR is the developer's
//     REAL one: before these gates, a no-argument run defaulted to `main`, threw on the missing
//     `DBA_PROBE_OUTSIDE` and still unlocked the ambient TMPDIR — a 644 file there came back 744
//     (measured). The parent pins the refusal with a canary.
//   • `touchedFilesystem` becomes true only after both gates (and, in `main`, the `DBA_PROBE_OUTSIDE`
//     check, which refuses the same way) have passed, immediately before the first write — and the
//     `finally` walks nothing unless it is true.
//   • `TMPDIR` is whatever the parent handed us and is the base every shape is built under.
//   • `main` also needs `DBA_PROBE_OUTSIDE`: a directory OUTSIDE this TMPDIR (so the registry may not
//     touch it) but inside a directory the PARENT registered (so the run-end drain still cleans it).
//   • exactly ONE line of stdout, a JSON object. Every assertion lives in the parent; this file only
//     reports what happened, including its own `fatal`.
//   • it must leave NOTHING the parent's run-end drain cannot remove — hence the `finally`, which undoes
//     every `uchg` flag and every 000 mode before exiting. A probe that failed to do that would fail the
//     whole `bun test` run at the drain, which is the one outcome worse than a red test.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd, removeRegisteredTempDirs } from "./temp-dirs";

const MODES = ["main", "root", "doubleslash"] as const;
const isMode = (m: string | undefined): m is (typeof MODES)[number] => (MODES as readonly string[]).includes(m ?? "");

const out: Record<string, unknown> = {};
const mode = process.argv[2];
out.mode = mode ?? null;
out.touchedFilesystem = false;

/** Run `fn` and report "ok" or the thrown message — the shape every guard/drain result is reported in,
 *  so the parent can assert on "threw at all" and on WHAT it said with the same field. */
function attempt(fn: () => void): string {
  try { fn(); return "ok"; } catch (e) { return e instanceof Error ? e.message : String(e); }
}
const exists = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };
const modeOf = (p: string): string => (lstatSync(p).mode & 0o7777).toString(8);
/** `chflags`/`chmod` via the CLI: node exposes no `chflags` binding, and `uchg` is the only fixture that
 *  makes a directory genuinely unremovable for this uid without being root. macOS only. */
const sh = (argv: string[]): { code: number; text: string } => {
  const r = Bun.spawnSync(argv);
  return { code: r.exitCode, text: `${r.stdout?.toString() ?? ""}${r.stderr?.toString() ?? ""}` };
};

const base = resolve(tmpdir());
out.base = base;
out.tmpdirRaw = tmpdir();
const darwin = process.platform === "darwin";
out.unremovableSupported = darwin;

try {
  // The two gates (see the contract above), before anything that can write.
  if (process.env.DBA_PROBE_CHILD !== "1") {
    throw new Error("refused: DBA_PROBE_CHILD=1 is not set — this probe is spawned by "
      + "test/fixtures/temp-dirs.test.ts, never run by hand");
  }
  if (!isMode(mode)) throw new Error(`refused: mode ${JSON.stringify(mode ?? null)} is not one of ${MODES.join(", ")}`);

  if (mode === "root") {
    // TMPDIR=/ — the one environment in which `dirname(path) === base` is satisfiable BY THE BASE
    // ITSELF (dirname("/") === "/"), i.e. the only reason the `path === base` clause exists. Nothing is
    // created and nothing is drained here (`touchedFilesystem` stays false): a drain in this process
    // would be aimed at "/".
    out.rootRefused = attempt(() => { removeAtRunEnd("/"); }) !== "ok";
    out.rootChildAccepted = attempt(() => { removeAtRunEnd("/dba-probe-never-created"); }) === "ok";
  } else if (mode === "doubleslash") {
    // `os.tmpdir()` hands back TMPDIR very nearly verbatim, so a TMPDIR spelled with a doubled separator
    // reaches the guard spelled that way while `join(tmpdir(), …)` — what every caller writes — has
    // already normalised it. Only `resolve` on the BASE side reconciles the two.
    out.touchedFilesystem = true;
    const d = mkdtempSync(join(tmpdir(), "dba-dslash-"));
    out.made = d;
    out.registered = attempt(() => { removeAtRunEnd(d); });
    // No drain: the directory sits inside the parent's registered base and goes at ITS run end.
  } else {
    // mode === "main" — the only one left after the gate.
    const outside = process.env.DBA_PROBE_OUTSIDE;
    if (!outside) throw new Error("refused: DBA_PROBE_OUTSIDE is required for mode=main");
    out.touchedFilesystem = true;

    // ── the GUARD ────────────────────────────────────────────────────────────────────────────────
    // A middle segment that is a symlink OUT of the base, for the refusal table below. Note what that
    // table can and cannot show: `resolve` does not follow symlinks, so this one is refused LEXICALLY,
    // on its shape alone — see the REFUSED comment in the parent.
    const guardLink = join(base, "guard-link");
    symlinkSync(outside, guardLink);

    const made = mkdtempSync(join(tmpdir(), "dba-guard-"));
    const accepts: Record<string, string> = {};
    const returnsRawInput: Record<string, boolean> = {};
    for (const [name, spelling] of [
      ["mkdtemp", made],                 // the shape every real caller passes
      ["doubleSlash", `${base}//x`],     // …and three spellings only `resolve` reconciles with `dirname`
      ["dotSegment", `${base}/./x`],
      ["trailingSlash", `${base}/x/`],
    ] as const) {
      accepts[name] = attempt(() => { returnsRawInput[name] = removeAtRunEnd(spelling) === spelling; });
    }
    out.accepts = accepts;
    out.returnsRawInput = returnsRawInput;

    // The relative case needs a cwd that is NOT the base — otherwise `resolve("x")` lands inside it and
    // the refusal would be an accident of where `bun test` happened to run.
    const cwdBefore = process.cwd();
    process.chdir(outside);
    const refuses: Record<string, string> = {};
    for (const [name, spelling] of [
      ["nested", `${base}/a/b`],
      ["dotDot", `${base}/../x`],
      ["baseItself", base],
      ["baseWithSlash", `${base}/`],
      ["absoluteElsewhere", "/etc/x"],
      ["relative", "x"],
      ["symlinkedMiddle", join(guardLink, "sub")],
    ] as const) refuses[name] = attempt(() => { removeAtRunEnd(spelling); });
    process.chdir(cwdBefore);
    out.refuses = refuses;
    // The link's only job is the row above. Remove it now so the `finally`'s unlock passes walk no
    // symlink this probe planted: on darwin both passes step over it (measured: exit 0, and the
    // directories behind the link kept mode 500 through the pass over `base`), but on the Linux CI runner
    // `chmod -R`'s handling of one is unmeasured, and `unlocked` is asserted on every platform. On the
    // normal path no other link reaches the `finally` either: T2's and T3's sit inside registered
    // directories and T4's is itself registered, so the drain below removes all three (measured: after
    // it, the only link left under either root was this one).
    unlinkSync(guardLink);

    // Drain what the guard section registered. Three of the four accepted spellings resolve to the same
    // NON-EXISTENT `${base}/x`, so this also pins that a registered path which never existed is not a
    // failure — `force` plus the walk's ENOENT branch.
    out.drainAfterGuards = attempt(() => { removeRegisteredTempDirs(); });
    out.guardMadeGone = !exists(made);

    // ── the REMOVER ──────────────────────────────────────────────────────────────────────────────
    // Two victims OUTSIDE the base. Mode 0o500, not 0o700: a walk that followed symlinks (`stat` in
    // place of `lstat`) would chmod the TARGET to 0o700, and the mode is the only trace it leaves —
    // `rmSync` does not follow links, so the files survive either way.
    const victimDir = join(outside, "victim-dir");
    const linkTarget = join(outside, "link-target");
    for (const d of [victimDir, linkTarget]) {
      mkdirSync(d, { recursive: true });
      // 0o644 SET EXPLICITLY, not left to the umask: the file mode is a discriminator below (a walk that
      // dropped its `isDirectory` guard chmods these to 0o744 on its way past), and it can only
      // discriminate if it is missing a bit of `u+rwx` to begin with. A 0o755 umask default would make
      // the same assertion pass no matter what the walk did. It is INSURANCE, so dropping it survives
      // wherever the umask is already 022 (measured here) — it earns its keep on the machine whose umask
      // is not, which is exactly the machine nobody runs this on before it breaks.
      const keep = join(d, "keep.txt");
      writeFileSync(keep, "keep me");
      chmodSync(keep, 0o644);
      chmodSync(d, 0o500);
    }

    // T1 — a 000 directory inside a 000 directory holding a file, plus a 000 file.
    const t1 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t1-")));
    const d1 = join(t1, "d1");
    const d2 = join(d1, "d2");
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, "deep.txt"), "x");
    const f000 = join(t1, "f000");
    writeFileSync(f000, "x");
    chmodSync(f000, 0o000);
    chmodSync(d2, 0o000);                 // child before parent: a 000 parent cannot be entered to fix it
    chmodSync(d1, 0o000);

    // T2 — a symlink INSIDE a registered tree pointing at an outside directory.
    const t2 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t2-")));
    symlinkSync(victimDir, join(t2, "to-outside"));

    // T3 — a dangling symlink inside a registered tree.
    const t3 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t3-")));
    symlinkSync(join(t3, "no-such-target"), join(t3, "dangling"));

    // T4 — the registered path IS a symlink to an outside directory, registered with a TRAILING SLASH.
    // That spelling is what makes this the sharpest shape in the file: a trailing slash makes both lstat
    // and rm FOLLOW the link, so a registrant side that skipped `resolve` would empty `linkTarget`.
    const t4 = join(base, "dba-t4-link");
    symlinkSync(linkTarget, t4);
    out.t4RegisterReturn = removeAtRunEnd(`${t4}/`);

    // T5 — registered, then removed by its own test before the drain.
    const t5 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t5-")));
    rmSync(t5, { recursive: true, force: true });

    // T6 — registered twice.
    const t6 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t6-")));
    removeAtRunEnd(t6);

    // T7 — a registered plain FILE (the registry's contract is "direct child of tmpdir()", not "dir").
    const t7 = join(base, "dba-t7-file");
    writeFileSync(t7, "x");
    removeAtRunEnd(t7);

    // T8 — two GENUINELY unremovable directories: each holds a `uchg` file, which no chmod walk can fix.
    const u1 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-u1-")));
    const u2 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-u2-")));
    out.u1 = u1;
    out.u2 = u2;
    if (darwin) {
      const flagged: boolean[] = [];
      for (const u of [u1, u2]) {
        const f = join(u, "immutable.txt");
        writeFileSync(f, "x");
        sh(["chflags", "uchg", f]);
        // The fixture is only evidence if it APPLIED — read the flag back rather than trusting exit 0.
        // Trusting the exit code instead survives wherever `chflags` works (measured), which is the point:
        // this line exists for the filesystem where it exits 0 and sets nothing, and there it is the only
        // thing standing between a silently vacuous fixture and a green suite.
        flagged.push(sh(["ls", "-lO", f]).text.includes("uchg"));
      }
      out.uchgApplied = flagged.every(Boolean);
    }

    // T9 — registered AFTER the unremovable pair: one failure must not strand the rest of the list.
    const t9 = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-t9-")));

    out.drainError = attempt(() => { removeRegisteredTempDirs(); });
    out.secondDrain = attempt(() => { removeRegisteredTempDirs(); });

    out.gone = { t1: !exists(t1), t2: !exists(t2), t3: !exists(t3), t4: !exists(t4),
                 t5: !exists(t5), t6: !exists(t6), t7: !exists(t7), t9: !exists(t9) };
    out.unremovableStillPresent = { u1: exists(u1), u2: exists(u2) };
    // Both halves of each victim: the DIRECTORY mode catches `lstat`->`stat`, the FILE mode inside it
    // catches a walk that reaches through the link because it no longer skips non-directories. `lstat`,
    // so a mode here is always the entry's own. Captured before the `finally` below unlocks the tree.
    out.victimSurvives = exists(join(victimDir, "keep.txt"));
    out.victimDirMode = modeOf(victimDir);
    out.victimFileMode = modeOf(join(victimDir, "keep.txt"));
    out.linkTargetSurvives = exists(join(linkTarget, "keep.txt"));
    out.linkTargetMode = modeOf(linkTarget);
    out.linkTargetFileMode = modeOf(join(linkTarget, "keep.txt"));
  }
} catch (e) {
  out.fatal = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
} finally {
  // Hand the parent's run-end drain a tree it can actually remove. THREE passes, and the order is
  // measured rather than obvious:
  //   1. `chmod -R u+rwx` — the only pass that can open a 000 directory, because it fixes each mode on
  //      the way down (measured: exit 0 through a 000-inside-000 nest). Its exit code is DISCARDED on
  //      purpose: a `uchg` entry refuses chmod with EPERM (measured: exit 1), which is this tree's
  //      normal state at this point, not a failure.
  //   2. `chflags -R nouchg` — after (1), because it changes no modes: it cannot enter a 000 directory
  //      (measured: "Permission denied", exit 1), so a `uchg` entry INSIDE one keeps its flag, while
  //      flagged siblings outside it are still cleared (measured). This probe never builds that shape,
  //      so over its own trees a flipped order still clears every flag (measured), and it is NOT
  //      caught: on the normal path the drain has already removed the only 000 nest (T1) and the flip
  //      changes nothing observable (a surviving mutant), and on a run that dies before the drain it
  //      shows only as `unlocked: false` beside a `fatal` that already fails the parent. The order is
  //      kept for the general case, not because these fixtures need it.
  //   3. `chmod -R u+rwx` again — nothing is immutable any more, so this pass CAN be clean, and it is
  //      the one `unlocked` reports alongside (2). Reporting (1)'s code was what made `unlocked` always
  //      false on darwin, i.e. a field the parent could never assert on.
  // All best-effort — a failure here is reported, never thrown.
  //
  // ⛔ NEVER over "/", whatever `touchedFilesystem` says. The `root` mode runs with TMPDIR=/, so anything
  // that set the flag there — a regression, or a mutant — turns these passes into `chmod -R u+rwx /` over
  // the whole machine. That is not hypothetical: a mutation run of this file that moved the flag above
  // the gates did exactly that, and the walk changed modes outside the test tree before it was killed.
  // Two independent refusals, so neither alone is load-bearing: no walk in `root` mode, and no root that
  // resolves to "/".
  if (out.touchedFilesystem === true && mode !== "root") {
    const roots = [base, process.env.DBA_PROBE_OUTSIDE]
      .filter((p): p is string => typeof p === "string" && p !== "" && resolve(p) !== "/");
    const codes: number[] = [];
    for (const r of roots) {
      sh(["chmod", "-R", "u+rwx", r]);
      if (darwin) codes.push(sh(["chflags", "-R", "nouchg", r]).code);
      codes.push(sh(["chmod", "-R", "u+rwx", r]).code);
    }
    out.unlocked = codes.every((c) => c === 0);
  }
}

console.log(JSON.stringify(out));
