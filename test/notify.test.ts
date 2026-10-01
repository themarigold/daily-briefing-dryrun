// Slice 4 T7 — the optional desktop notification.
//
// `notifyArgv` is PURE, so most of this file needs no isolation at all; the two `notify()` cases
// inject both the exec and the PATH resolver, so nothing is spawned here either.
import { test, expect, describe } from "bun:test";
import {
  notifyArgv, notifyBody, notifyPayload, notify, resolveNotify, NOTIFY_TITLE,
} from "../src/notify";
import type { Config } from "../src/types";

/** ⚠ CONSTRUCTED, never written as literal bytes in this file. An earlier revision embedded real
 *  ESC / BEL / NUL characters directly in the source, which made git classify this file as BINARY
 *  (`Bin 0 -> 7961 bytes` in the commit stat): diffs become unreadable, review is impossible, and a
 *  NUL in a source file is a hazard for any tool that treats it as a terminator. The test still
 *  exercises REAL control bytes at runtime; only the file's own bytes stay plain text. */
const ESC = String.fromCharCode(0x1b), BEL = String.fromCharCode(0x07), NUL = String.fromCharCode(0);
const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]");

const P = notifyPayload("2026-09-14", "/state/briefing-latest.md");
const cfg = (notify: Config["notify"]) => ({ notify }) as Pick<Config, "notify">;

describe("the default is OFF", () => {
  test("an ABSENT notify field resolves to null on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(`${platform} → ${notifyArgv(platform, {}, P)}`).toBe(`${platform} → null`);
    }
  });

  test('explicit "off" is null too, and a MALFORMED value degrades to off with a warning', () => {
    expect(notifyArgv("darwin", cfg("off"), P)).toBeNull();
    // B1 style, like resolveTranscripts/resolveProbeHosts: a typo'd block warns and disables — it must
    // never throw out of the delivery path, because the user cannot act on a briefing they never got.
    for (const bad of ["ON", 42, [], {}, { command: [] }, { command: ["ok", 5] }, { cmd: ["x"] }]) {
      const r = resolveNotify(bad);
      expect(`${JSON.stringify(bad)} → ${r.cfg} warned=${Boolean(r.warning)}`)
        .toBe(`${JSON.stringify(bad)} → off warned=true`);
      expect(notifyArgv("darwin", { notify: bad as Config["notify"] }, P)).toBeNull();
    }
    expect(resolveNotify(undefined)).toEqual({ cfg: "off" });
    expect(resolveNotify(null)).toEqual({ cfg: "off" });
  });
});

describe('"auto" — best effort per OS', () => {
  test("darwin uses osascript; linux uses notify-send; win32 resolves to NOTHING", () => {
    const d = notifyArgv("darwin", cfg("auto"), P)!;
    expect(d[0]).toBe("osascript");
    expect(d[1]).toBe("-e");
    expect(d[2]).toContain("display notification");
    expect(d[2]).toContain(`with title "${NOTIFY_TITLE}"`);

    expect(notifyArgv("linux", cfg("auto"), P)).toEqual(["notify-send", NOTIFY_TITLE, P.body]);
    // ⚠ Windows has no built-in CLI toast. An honest null is what lets the GUI suppression rule work:
    // keying suppression off the CONFIG VALUE would produce a DOUBLE SILENCE here — the engine posting
    // nothing because it cannot, and the app posting nothing because it thought the engine would.
    expect(notifyArgv("win32", cfg("auto"), P)).toBeNull();
  });

  test("the AppleScript string is escaped — a quote or backslash in the path cannot end it early", () => {
    const evil = notifyPayload("2026-09-14", '/state/a"b\\c/briefing.md');
    const argv = notifyArgv("darwin", cfg("auto"), evil)!;
    expect(argv[2]).toContain('a\\"b\\\\c');
    // The literal must still be balanced: count unescaped quotes.
    const unescaped = [...argv[2]!.matchAll(/(?<!\\)"/g)].length;
    expect(`unescaped quotes = ${unescaped}`).toBe("unescaped quotes = 4");   // two string literals
  });
});

describe('{ command: [...] } — an explicit argv, never a shell string', () => {
  test("⚠ placeholders land as SEPARATE argv elements — a space or semicolon never splits one", () => {
    // This is the whole reason `command` is string[] and not a command line. A value containing a
    // space would word-split through a shell; a semicolon would be a command separator.
    const evil = notifyPayload("2026-09-14", "/state/my briefings; rm -rf ~/important.md");
    const argv = notifyArgv("linux", cfg({ command: ["curl", "-d", "{body}", "--url", "{path}", "{title}"] }), evil)!;
    expect(argv.length).toBe(6);
    expect(argv[4]).toBe("/state/my briefings; rm -rf ~/important.md");   // ONE element, verbatim
    expect(argv[5]).toBe(NOTIFY_TITLE);
    expect(argv[2]).toContain("/state/my briefings; rm -rf ~/important.md");
    // …and no element is a shell.
    expect(argv.some((a) => a === "sh" || a === "bash" || a === "-c")).toBe(false);
  });

  test("substitution happens INSIDE an element, so a template mixing literal text and a placeholder works", () => {
    const argv = notifyArgv("linux", cfg({ command: ["push", "--msg=[{title}] {body}"] }), P)!;
    expect(argv).toEqual(["push", `--msg=[${NOTIFY_TITLE}] ${P.body}`]);
  });

  test("a command is platform-independent — it is the self-hosted push path", () => {
    for (const platform of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(notifyArgv(platform, cfg({ command: ["notifier", "{body}"] }), P)).toEqual(["notifier", P.body]);
    }
  });

  test("an executable that substitutes away to nothing is not a command", () => {
    expect(notifyArgv("linux", cfg({ command: ["{title}"] }), { ...P, title: "" })).toBeNull();
  });
});

describe("⚠ THE BODY IS A FIXED TEMPLATE — the injection class is closed, not sanitised around", () => {
  test("it carries the date and the path and NOTHING else — never briefing text", () => {
    const body = notifyBody("2026-09-14", "/state/briefing-latest.md");
    expect(body).toBe("Your briefing for 2026-09-14 is ready — /state/briefing-latest.md");
    // Repo-controlled strings — branch names, commit subjects, filenames — flow raw through this
    // codebase. None of them is an input here, so none of them can reach a notification.
    for (const repoText of [`feat: pwn${ESC}[2J`, "origin/main", "## RESUME", "did y | evidence: abc123"]) {
      expect(body).not.toContain(repoText);
    }
  });

  test("control bytes are stripped from BOTH interpolated components", () => {
    const body = notifyBody(`2026-09-14${BEL}`, `/state/${ESC}[31mred${NUL}.md`);
    expect(CONTROL_RE.test(body)).toBe(false);
    expect(body).not.toContain(ESC);
  });

  test("notifyPayload's title is a constant — no caller text reaches it", () => {
    expect(notifyPayload("2026-01-01", "/x").title).toBe(NOTIFY_TITLE);
  });
});

describe("notify() — total, and silent in both directions", () => {
  test("off ⇒ nothing spawned", async () => {
    let spawned = 0;
    const ran = await notify({}, P, { platform: "darwin", exec: async () => { spawned++; return { code: 0 }; } });
    expect(`${ran} ${spawned}`).toBe("false 0");
  });

  test("linux: an ABSENT notify-send is silence, not an error", async () => {
    // notifyArgv is pure and cannot look at PATH, so notify() does — and a missing binary must
    // degrade to nothing rather than raise on the delivery path.
    let spawned = 0;
    const ran = await notify(cfg("auto"), P, {
      platform: "linux", which: async () => undefined, exec: async () => { spawned++; return { code: 0 }; },
    });
    expect(`${ran} ${spawned}`).toBe("false 0");
    const present = await notify(cfg("auto"), P, {
      platform: "linux", which: async () => "/usr/bin/notify-send", exec: async () => { spawned++; return { code: 0 }; },
    });
    expect(`${present} ${spawned}`).toBe("true 1");
  });

  test("an ABSOLUTE configured command is not PATH-checked — that path is the user's to get right", async () => {
    let asked = 0, spawned = 0;
    await notify(cfg({ command: ["/opt/bin/push", "{body}"] }), P, {
      platform: "linux",
      which: async () => { asked++; return undefined; },
      exec: async () => { spawned++; return { code: 0 }; },
    });
    expect(`asked=${asked} spawned=${spawned}`).toBe("asked=0 spawned=1");
  });

  test("a THROWING or non-zero notifier never propagates — a delivered morning must not be lost to it", async () => {
    expect(await notify(cfg({ command: ["/x/boom"] }), P, {
      platform: "linux", exec: async () => { throw new Error("ENOENT"); },
    })).toBe(false);
    expect(await notify(cfg({ command: ["/x/fails"] }), P, {
      platform: "linux", exec: async () => ({ code: 1 }),
    })).toBe(true);   // it ran; its exit code is not ours to interpret
  });
});
