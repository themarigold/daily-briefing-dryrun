// test/fixtures/temp-dirs.test.ts — the pins for the run-end temp-dir registry (`./temp-dirs.ts`),
// the module PR #488 added to end a leak of 827 TMPDIR directories per full run.
//
// ⚠ EVERY SHAPE RUNS IN A CHILD PROCESS, and that is the whole design of this file. `registered` is one
// module-level list that `test/preload.ts` drains from a single run-wide `afterAll`; calling
// `removeRegisteredTempDirs()` HERE would delete, mid-run, every directory the rest of the run registered
// — at #488's merge that was 36 other files under test/: 34 `*.test.ts` plus the fixtures `build-repo.ts`
// and `eval-repo.ts`, and this branch's own probe makes 37, though a probe's registrations go on ITS
// process's list and never reach this one — breaking the one contract the module promises: nothing is
// removed before run end.
// So the shapes live in `./temp-dirs.probe.ts` (NOT a `*.test.ts`: bun must not collect it), which gets
// its own module instance, its own list and a TMPDIR of its own, and prints one JSON object describing
// what happened.
//
// Everything the child creates sits under `privateBase`, a directory THIS file registers, so the run-end
// drain removes the lot — including the deliberately awkward fixtures (000 modes, `uchg` files), which
// the child and this file each unlock afterwards. A probe that left one behind would fail the whole
// `bun test` run at the drain, which is worse than any red test here.
//
// ⚠ THREE PROPERTIES OF `./temp-dirs.ts` ARE NOT PINNED HERE. Each was confirmed a survivor by mutation,
// and each is unpinnable for the SAME reason — it needs a concurrent deleter, an entry vanishing between
// two syscalls, which no test can stage deterministically:
//   • the ENOENT branch of the chmod walk (`makeRemovable`'s catch). `tryRemove` swallows the walk's
//     error into `walk` and reports it ONLY when the `rmSync` that follows ALSO fails — and the one
//     DETERMINISTIC way to make the walk raise ENOENT is a registered path that never existed, for which
//     the rm then succeeds. Every other ENOENT needs an entry to vanish between `readdirSync` and
//     `lstatSync`. The one non-racy candidate — a directory entry whose name is not valid UTF-8, which
//     `readdirSync` would hand back mangled — is unavailable: this filesystem refuses such a name
//     outright (EILSEQ, measured).
//   • `stillPresent`'s TRUE branch — the `still present after rm` result. It exists because bun's `force`
//     swallows the ENOENT a concurrent deleter INSIDE the tree provokes and returns with the directory
//     still there; absent that deleter, an `rmSync` that does not throw really did remove it. Removing
//     the whole check survives for the same reason and not a different one: its FALSE branch is exactly
//     `return undefined`, so without that deleter the check and its absence are the same function.
//   • the SECOND `tryRemove` attempt. It exists for a straggler still writing into the tree; the only
//     fixtures that fail here (u1/u2) fail identically on both attempts, so dropping the retry is
//     invisible.
// Two properties an earlier draft of this header ALSO excused as "structural" are in fact pinned below,
// and are not in the list above: the walk's `isDirectory` guard (via the outside targets' FILE modes) and
// `reasonOf`'s output (via the non-empty reason half of each `path: reason` line).
import { test, expect } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeAtRunEnd } from "./temp-dirs";

// `fileURLToPath`, not `.pathname`: a file URL percent-encodes, so a checkout under a path containing a
// space would hand `bun` a `%20` that does not exist and the failure would surface as "printed no JSON".
const PROBE = fileURLToPath(new URL("./temp-dirs.probe.ts", import.meta.url));

/** One registered directory holds every fixture of every spawn. The child's TMPDIR is `t/` INSIDE it and
 *  `outside/` is its sibling — so "outside the registry's reach" and "still cleaned at run end" are both
 *  true of the same directory, which is what lets this file plant victims the registry must not touch. */
const privateBase = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-tdprobe-")));
const childTmp = join(privateBase, "t");
const outside = join(privateBase, "outside");
mkdirSync(childTmp);
mkdirSync(outside);

type Probe = Record<string, any>;

/** Spawn the probe with `args` and parse its one JSON line; asserts nothing about what it reported.
 *  The probe's own variables come ONLY from `extra`: both are dropped from the inherited environment
 *  first, so a developer's shell cannot hand the sentinel to a spawn that is meant to lack it.
 *  `beforeUnlock` runs between the spawn and the unlock, for a caller whose evidence is a MODE that the
 *  unlock would rewrite. */
function spawnProbe(
  args: string[], tmp: string, extra: Record<string, string>, beforeUnlock: () => void = () => {},
): Probe {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DBA_PROBE_CHILD;
  delete env.DBA_PROBE_OUTSIDE;
  const r = Bun.spawnSync(["bun", PROBE, ...args], { env: { ...env, TMPDIR: tmp, ...extra } });
  const stdout = r.stdout.toString().trim();
  beforeUnlock();
  // Unlock BEFORE asserting anything: a probe that died mid-way can leave a `uchg` file or a 000
  // directory behind, and the run-end drain would then fail the whole run rather than this test.
  // Safe to do here because every post-state fact the assertions read was captured INSIDE the child
  // (or by `beforeUnlock`).
  for (const argv of [["chmod", "-R", "u+rwx", privateBase], ["chflags", "-R", "nouchg", privateBase]]) {
    try { Bun.spawnSync(argv); } catch { /* chflags is macOS-only; nothing to undo elsewhere */ }
  }
  // The LAST line, not the whole of stdout: anything bun itself prints would otherwise break the parse.
  try { return JSON.parse(stdout.split("\n").pop() ?? ""); } catch {
    throw new Error(`probe(${args.join(" ") || "<no mode>"}) printed no JSON (exit ${r.exitCode})\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${r.stderr.toString().slice(0, 2000)}`);
  }
}

/** A spawn the probe must accept: the sentinel is set, and it must not report a `fatal`. */
function runProbe(mode: string, tmp: string, extra: Record<string, string> = {}): Probe {
  const parsed = spawnProbe([mode], tmp, { DBA_PROBE_CHILD: "1", ...extra });
  expect(`probe(${mode}) fatal: ${parsed.fatal ?? "none"}`).toBe(`probe(${mode}) fatal: none`);
  return parsed;
}

/** The `main` spawn does the guard section AND the remover section in one process (the remover needs the
 *  guard's drain to have emptied the list first), so both tests below read one run. */
let mainRun: Probe | undefined;
const main = (): Probe => (mainRun ??= runProbe("main", childTmp, { DBA_PROBE_OUTSIDE: outside }));

test("removeAtRunEnd accepts only a DIRECT child of tmpdir(), whatever the spelling", () => {
  const p = main();
  // ACCEPTED: the shape every real caller passes, plus three spellings that `dirname` alone would
  // reject — `resolve` on the registrant's side is the only thing that reconciles them.
  expect(p.accepts).toEqual({ mkdtemp: "ok", doubleSlash: "ok", dotSegment: "ok", trailingSlash: "ok" });
  // …and the RETURN value is the caller's own string, byte for byte. That is what makes
  // `removeAtRunEnd(mkdtempSync(...))` a wrap-in-place rather than an edit to what the test then uses.
  expect(p.returnsRawInput).toEqual({ mkdtemp: true, doubleSlash: true, dotSegment: true, trailingSlash: true });

  // REFUSED: one boundary, so the recursive chmod-and-delete has exactly one. `baseItself` and
  // `baseWithSlash` are the never-register-the-root cases; `dotDot` walks out of the base; `relative` is
  // resolved from a cwd that is NOT the base. `symlinkedMiddle` is refused LEXICALLY, by exactly the same
  // clause as `nested`: `resolve` does not follow symlinks, so `<base>/guard-link/sub` is simply not a
  // direct child, and the link being a link never enters into it. It is NOT a symlink-following defence,
  // whatever the name suggests — that defence is T4 below, plus `rmSync` not following links.
  expect(Object.keys(p.refuses).sort()).toEqual(
    ["absoluteElsewhere", "baseItself", "baseWithSlash", "dotDot", "nested", "relative", "symlinkedMiddle"]);
  const accepted = Object.entries(p.refuses as Record<string, string>).filter(([, r]) => r === "ok").map(([k]) => k);
  expect(`wrongly accepted: ${accepted.join(", ") || "none"}`).toBe("wrongly accepted: none");
  const wrongMessage = Object.entries(p.refuses as Record<string, string>)
    .filter(([, r]) => !r.startsWith("removeAtRunEnd: ")).map(([k]) => k);
  expect(`refusal not from the guard: ${wrongMessage.join(", ") || "none"}`).toBe("refusal not from the guard: none");

  // Draining the guard section is itself a shape: three of the four accepted spellings resolve to the
  // same path that was never created, and a registered path which does not exist is not a failure.
  expect(p.drainAfterGuards).toBe("ok");
  expect(p.guardMadeGone).toBe(true);
});

test("removeRegisteredTempDirs removes every registered shape, never follows a link OUT, and forgets the list", () => {
  const p = main();
  // Gone: a 000 dir inside a 000 dir holding a file plus a 000 file (t1); a tree holding a symlink to an
  // outside directory (t2); a dangling symlink (t3); a registered path that IS a symlink, spelled with a
  // trailing slash (t4); an already-removed dir (t5); a twice-registered dir (t6); a plain FILE (t7);
  // and t9, registered AFTER the two that cannot be removed — one failure strands nothing.
  expect(p.gone).toEqual({ t1: true, t2: true, t3: true, t4: true, t5: true, t6: true, t7: true, t9: true });
  expect(p.t4RegisterReturn).toEndWith("/");   // returned raw, though what it REGISTERED was resolved

  // The two outside victims. `rmSync` does not follow symlinks, so survival alone is weak — the MODES are
  // the discriminating fact, and BOTH halves are needed because they catch different mutants (each
  // measured): a walk that used `stat` in place of `lstat` chmods the outside DIRECTORIES to 700 on its
  // way past, while a walk that kept `lstat` but dropped its `isDirectory` guard leaves the directories
  // alone and instead chmods the FILES inside them from 644 to 744 — `readdirSync` follows a symlinked
  // directory even though `lstat` does not, so the walk reaches through the link one level down.
  expect(p.victimSurvives).toBe(true);
  expect(p.linkTargetSurvives).toBe(true);
  expect({ victimDir: p.victimDirMode, linkTarget: p.linkTargetMode }).toEqual({ victimDir: "500", linkTarget: "500" });
  expect({ victimFile: p.victimFileMode, linkTargetFile: p.linkTargetFileMode })
    .toEqual({ victimFile: "644", linkTargetFile: "644" });

  // The probe's own unlock pass ran AND succeeded. Worth asserting only since the pass order was fixed:
  // while `chmod` ran before `chflags` this field was always false on darwin (chmod cannot touch a `uchg`
  // entry), so nothing could read it — a field that cannot be true is not a check. Asserted on every
  // platform: off darwin it is just the exit code of `chmod -R` (twice), which is measured only by the
  // Linux CI run — hence the probe removes its own `guard-link` before this pass, so the tree it walks
  // holds no symlink the probe planted.
  expect(p.unlocked).toBe(true);

  if (p.unremovableSupported) {
    // `uchg` is the only fixture that makes a directory genuinely unremovable for this uid without root,
    // so this branch is macOS-only; elsewhere the aggregate-failure shape goes unpinned and the drain is
    // simply expected to succeed. The flag is read back before it is trusted — a fixture that did not
    // apply would turn "survived" into "was never tested".
    expect(p.uchgApplied).toBe(true);
    expect(p.unremovableStillPresent).toEqual({ u1: true, u2: true });
    // ONE throw for BOTH, not one per directory and not a silent leak: the count is in the first line
    // and each path is named on its own.
    const lines = String(p.drainError).split("\n");
    expect(lines[0]).toBe("could not remove 2 temp dir(s):");
    expect(p.drainError).toContain(p.u1);
    expect(p.drainError).toContain(p.u2);
    // …and each line is `path: reason`, BOTH halves. Pinning the path alone left `reasonOf` free to
    // return "" (measured survivor). The reason's TEXT stays unpinned deliberately — bun reports a `uchg`
    // entry as EFAULT rather than EPERM, which is a bun detail, not a contract — so this pins only that
    // something was said, which is platform-free.
    for (const u of [p.u1, p.u2] as string[]) {
      const reason = (lines.find((l) => l.trim().startsWith(`${u}: `)) ?? "").trim().slice(`${u}: `.length);
      expect(`reason for ${u}: ${reason.length > 0 ? "non-empty" : "EMPTY"}`).toBe(`reason for ${u}: non-empty`);
    }
    // …and the list was drained BEFORE the throw, so a second call has nothing left to fail on. Without
    // that, the one unremovable directory would be retried by every subsequent caller forever.
    expect(p.secondDrain).toBe("ok");
  } else {
    expect(p.drainError).toBe("ok");
    expect(p.secondDrain).toBe("ok");
  }
});

test("TMPDIR=/ : the root itself is refused, a child of it is not", () => {
  // The one environment where `dirname(path) === base` is satisfiable BY THE BASE ITSELF
  // (dirname("/") === "/"), which is the only reason the explicit `path === base` clause exists. The
  // probe registers and creates nothing in this spawn and never drains — a drain here would be aimed at
  // every direct child of "/".
  const p = runProbe("root", "/");
  expect(p.base).toBe("/");
  expect(p.touchedFilesystem).toBe(false);
  expect(p.rootRefused).toBe(true);
  expect(p.rootChildAccepted).toBe(true);
});

test("a '//'-spelled TMPDIR still matches the paths callers build under it", () => {
  // `os.tmpdir()` returns TMPDIR nearly verbatim — one trailing slash stripped, nothing else normalised —
  // while `join(tmpdir(), …)`, which is what every caller writes, normalises the doubled separator away.
  // Only `resolve` on the BASE side reconciles the two; without it every registration in a shell with
  // such a TMPDIR throws, which is a suite that cannot run rather than a leak.
  const spelled = `${privateBase}//t`;
  const p = runProbe("doubleslash", spelled);
  expect(p.tmpdirRaw).toBe(spelled);          // the premise: nothing normalised it before the guard saw it
  expect(p.registered).toBe("ok");
});

test("run by hand, or missing any input a real spawn has, the probe refuses and touches NOTHING", () => {
  // The probe's `finally` runs `chmod -R u+rwx` (and `chflags -R nouchg`) over its TMPDIR, and a hand
  // run's TMPDIR is the developer's real one: before the gates, `bun test/fixtures/temp-dirs.probe.ts`
  // turned a 644 file there into 744 (measured). Each spawn here gets a private TMPDIR and outside
  // directory, each holding a 644 canary. The first row is that hand run exactly. Every other row lacks
  // exactly ONE thing a real spawn has, so dropping the gate it names lets the mode run in full — and
  // the listing, the canaries and `touchedFilesystem` all say so.
  // `gate` is a phrase from the refusal's own message, matched against the message line only (the
  // `fatal` field also carries a stack).
  const NO_SENTINEL = "DBA_PROBE_CHILD=1 is not set";
  const BAD_MODE = "is not one of main, root, doubleslash";
  const NO_OUTSIDE = "DBA_PROBE_OUTSIDE is required";
  const rows: [name: string, args: string[], sentinel: boolean, withOutside: boolean, gate: string][] = [
    ["hand run: no mode, no sentinel, no outside", [], false, false, NO_SENTINEL],
    ["mode main, no sentinel", ["main"], false, true, NO_SENTINEL],
    ["mode doubleslash, no sentinel", ["doubleslash"], false, true, NO_SENTINEL],
    ["sentinel, no mode", [], true, true, BAD_MODE],
    ["sentinel, typo'd mode", ["mian"], true, true, BAD_MODE],
    ["sentinel, mode main, no outside", ["main"], true, false, NO_OUTSIDE],
  ];
  const modeOf = (p: string): string => (lstatSync(p).mode & 0o7777).toString(8);
  const got: Record<string, unknown> = {};
  const want: Record<string, unknown> = {};
  rows.forEach(([name, args, sentinel, withOutside, gate], i) => {
    const tmp = join(privateBase, `refuse-${i}`, "t");
    const outsideDir = join(privateBase, `refuse-${i}`, "outside");
    for (const d of [tmp, outsideDir]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "canary"), "x");
      chmodSync(join(d, "canary"), 0o644);   // set explicitly: a umask-default mode would prove nothing
    }
    const env: Record<string, string> = {
      ...(sentinel ? { DBA_PROBE_CHILD: "1" } : {}),
      ...(withOutside ? { DBA_PROBE_OUTSIDE: outsideDir } : {}),
    };
    // Read BEFORE the unlock inside `spawnProbe`, which chmods everything under privateBase itself.
    let after: Record<string, unknown> = {};
    const p = spawnProbe(args, tmp, env, () => {
      after = {
        tmp: readdirSync(tmp), tmpCanary: modeOf(join(tmp, "canary")),
        outside: readdirSync(outsideDir), outsideCanary: modeOf(join(outsideDir, "canary")),
      };
    });
    const message = String(p.fatal ?? "").split("\n")[0]!;
    got[name] = {
      refusedBy: message.startsWith("refused: ") && message.includes(gate) ? gate : message || "no fatal",
      touchedFilesystem: p.touchedFilesystem, unlocked: p.unlocked ?? "never ran", ...after,
    };
    want[name] = {
      refusedBy: gate, touchedFilesystem: false, unlocked: "never ran",
      tmp: ["canary"], tmpCanary: "644", outside: ["canary"], outsideCanary: "644",
    };
  });
  expect(got).toEqual(want);
});
