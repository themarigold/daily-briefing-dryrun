// test/privacy-wording.test.ts — Phase E E13 (M5b): the amended privacy commitment, on every surface.
//
// ⚠ THIS IS A PIN, NOT A DRIFT GUARD. Both lists below are HAND-WRITTEN: the destinations the README's
// Privacy section and the site must name, and the superseded phrases no surface may carry any more. It
// cannot notice a NEW destination appearing in code — nothing here reads `src/` for network calls — and a
// new destination must be added to the README, the site and the DESTINATIONS list here by hand. What it
// does catch: a surface that stops naming a destination, and a retired promise ("the one network call",
// "no phone-home", …) coming back on any surface after the update check made it false.
//
// WHY MARKUP IS STRIPPED FIRST. The README said "The **one** network call": a raw substring test for "one
// network call" passes vacuously against that text. Every surface is compared as plain text — Markdown
// emphasis, inline code and links, HTML tags and the three text entities removed, whitespace collapsed,
// lower-cased — so the wording is what is pinned, not its formatting. `strip` is unit-tested below
// against exactly the shapes that made the raw test vacuous.
//
// The destinations, and where the code reaches each (the README carries the user-facing wording):
//   • the AI provider — a spawned `provider.cli` (src/provider.ts BYOCliProvider) or one HTTP(S) POST per
//     attempt to `provider.api`'s endpoint (src/providers/http.ts `postJson`; plain http warned,
//     src/providers/base.ts; a redirect refused, never followed — `redirect: "error"`);
//   • git — local subcommands only (src/git.ts `runGit`): never fetch/pull/push;
//   • a repository's own remote, ONLY in a partial clone — not a call the tool makes but one git makes
//     for it: in a clone made with `--filter`, the tool's own `git log --numstat` / `log -p` reads make
//     git spawn `fetch origin … --filter=blob:none` for the blobs it lacks (measured, git 2.50.1;
//     user-directed 2026-10-02: say so on every surface that lists destinations, change no behaviour);
//   • the `networkProbeHosts` TCP probe — connect, then close, no data (src/net.ts `tcpProbe`);
//   • api.github.com — only when the update check is on or invoked (src/updateCheck.ts);
//   • bun.report — not a call this tool's code makes but one the Bun RUNTIME makes, only if Bun itself
//     crashes, by default on macOS and Windows (Bun v1.3.14 src/crash_handler/crash_handler.zig,
//     `isReportingEnabled`). The desktop app's spawns and the launchd/systemd units set
//     BUN_ENABLE_CRASH_REPORTING=0 (gui/src-tauri/src/engine.rs, src/schedule/units.ts, both pinned by
//     their own tests); a terminal run and the Windows task do not, and the surfaces say so.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const read = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

/** Plain, lower-cased, whitespace-collapsed text: Markdown emphasis/code/links and HTML tags removed. */
function strip(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")                         // HTML / Svelte tags
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")          // [text](url) → text
    .replace(/\*\*|__|\*|`/g, "")                     // emphasis and inline code
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/** The README's `## Privacy` section, up to the next level-2 heading. */
function readmePrivacy(): string {
  const md = read("README.md");
  const start = md.indexOf("\n## Privacy\n");
  if (start === -1) throw new Error("README.md has no `## Privacy` section — the pin cannot find what it pins");
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start, end === -1 ? undefined : end);
}

/** src/main.ts's help text — `printUsage`'s body only: the rest of that file is code, whose comments
 *  are not a surface anyone reads as a promise. */
function mainUsage(): string {
  const src = read("src/main.ts");
  const start = src.indexOf("function printUsage(): void {");
  if (start === -1) throw new Error("src/main.ts has no `printUsage` — the pin cannot find the help text");
  return src.slice(start, src.indexOf("\n}\n", start));
}

/** site/index.html's `<section id="privacy">`. */
function sitePrivacy(): string {
  const html = read("site/index.html");
  const start = html.indexOf('<section class="wrap" id="privacy">');
  if (start === -1) throw new Error('site/index.html has no `<section class="wrap" id="privacy">`');
  return html.slice(start, html.indexOf("</section>", start));
}

/** Every surface that makes a privacy or network claim (E13's list, as grown during M5's reviews). */
const SURFACES: Record<string, () => string> = {
  "README.md": () => read("README.md"),
  "site/index.html": () => read("site/index.html"),
  "gui/src/routes/Wizard.svelte": () => read("gui/src/routes/Wizard.svelte"),
  "CONTRIBUTING.md": () => read("CONTRIBUTING.md"),
  "docs/INSTALL.md": () => read("docs/INSTALL.md"),
  "docs/PROVIDERS.md": () => read("docs/PROVIDERS.md"),
  "SECURITY.md": () => read("SECURITY.md"),
  "package.json (description)": () => (JSON.parse(read("package.json")) as { description: string }).description,
  // Phase E M5b checkpoint: the surfaces that also describe the network or the update check.
  "docs/CONFIG.md": () => read("docs/CONFIG.md"),
  "docs/TROUBLESHOOTING.md": () => read("docs/TROUBLESHOOTING.md"),
  "src/main.ts (help text)": mainUsage,
  "gui/src/lib/update-check.ts": () => read("gui/src/lib/update-check.ts"),
  "gui/src/lib/UpdateCheck.svelte": () => read("gui/src/lib/UpdateCheck.svelte"),
  // The Settings screen quotes src/types.ts's field comments VERBATIM (gui/src/lib/settings-model.ts).
  "src/types.ts (quoted by Settings)": () => read("src/types.ts"),
};

/** Each destination, as phrases BOTH the README's Privacy section and the site's must carry. */
const DESTINATIONS: [string, string[]][] = [
  ["the AI provider", ["the ai provider you choose", "provider.cli", "provider.api", "local model"]],
  ["git, local only", ["reads your local repositories", "helper program"]],
  ["the networkProbeHosts TCP probe, dataless", ["networkprobehosts", "no data"]],
  ["api.github.com, only if enabled or invoked", ["api.github.com", "update check", "only if you"]],
  ["the repository's own remote, only in a partial clone", ["partial clone", "own remote", "a normal clone never does this"]],
  ["bun.report, only if the Bun runtime itself crashes", ["bun.report", "only if bun itself crashes", "do_not_track=1"]],
];

/** Retired promises: false since the update check exists, or superseded by the destination list. */
const SUPERSEDED = [
  "one network call",                       // README "The **one** network call …"
  "only network call",                      // site "The only network call the tool itself makes …"
  "no phone-home",
  "no telemetry — and never will",
  "no telemetry. nothing about you or your code is reported anywhere", // the Wizard's welcome bullet
  "don't add network calls",                // CONTRIBUTING
  "nothing leaves your machine",            // README / site / INSTALL / PROVIDERS (local model)
  "nothing leaves your mac",                // the Wizard's local-model path
  "either stays on your machine or sends nothing", // README "In short"
  "send data anywhere other than the provider you configured", // SECURITY's in-scope example
  // Decision (1), user-directed 2026-10-01: the automatic update check runs only right after a
  // DELIVERED briefing. M4's wording placed it at the end of any regular run, often an early one.
  "at the end of one of its regular runs",  // update-check.ts consent copy / UpdateCheck.svelte (M4)
  "hours before that day's briefing",       // update-check.ts / CONFIG.md / src/types.ts (M4)
  "often an early run",                     // update-check.ts consent copy (M4)
  // User-directed 2026-10-02: false for a partial clone, where git itself fetches from the remote.
  "only ever reads your local repositories", // README "`git` only ever reads your local repositories"
  "in three places, and no others",         // site — the list is four since the partial-clone case
  "in four places, and no others",          // site — and five since the Bun runtime's crash report
];

describe("strip: the comparison is over words, not formatting", () => {
  test("the shapes that made a raw substring test vacuous are normalised", () => {
    expect(strip("The **one** network call")).toBe("the one network call");
    expect(strip("no\n        phone-home and")).toBe("no phone-home and");
    expect(strip("<li><strong>No telemetry.</strong> Nothing about you or your code is reported anywhere.</li>"))
      .toBe("no telemetry. nothing about you or your code is reported anywhere.");
    expect(strip("a `networkProbeHosts` and [Privacy](README.md#privacy) &amp; <code>git</code>"))
      .toBe("a networkprobehosts and privacy & git");
    expect(strip('"The software" — *it* `x`')).toBe('"the software" — it x');
  });
});

describe("E13 PIN: the README's Privacy section and the site each name every destination", () => {
  for (const [surface, text] of [["README.md ## Privacy", readmePrivacy], ["site/index.html #privacy", sitePrivacy]] as const) {
    test(surface, () => {
      const plain = strip(text());
      expect(plain.length).toBeGreaterThan(200);   // non-vacuity: the section was found and has text
      const missing = DESTINATIONS.flatMap(([name, needles]) =>
        needles.filter((n) => !plain.includes(n)).map((n) => `${name}: "${n}"`));
      expect(missing).toEqual([]);
    });
  }
});

describe("E13 PIN: SECURITY.md's threat model, which also lists the traffic, names the partial-clone case", () => {
  test("SECURITY.md", () => {
    const plain = strip(read("SECURITY.md"));
    expect(plain).toContain("its only other network traffic is");  // non-vacuity: the list is still there
    expect(plain).toContain("partial clone");
    expect(plain).toContain("bun.report");
  });
});

describe("E13 PIN: no surface carries a superseded promise", () => {
  for (const [surface, text] of Object.entries(SURFACES)) {
    test(surface, () => {
      const plain = strip(text());
      expect(plain.length).toBeGreaterThan(20);    // non-vacuity: the surface was read
      expect(SUPERSEDED.filter((p) => plain.includes(p))).toEqual([]);
    });
  }
});
