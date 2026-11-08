import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("final3 M3 the complete program list includes the desktop live git check", () => {
  const words = read("README.md").split("Outside a briefing run:")[1]!.split("**But your AI CLI")[0]!;
  for (const phrase of ["repos status --json", "while the slides are shown", "on page load", "on window focus", "git metadata changes", "once a minute", "launchpad", "hooks", "fsmonitor", "lazy fetching", "the repository's own filters off", "global or system git config", "Git LFS", "still run", "never fetches"]) expect(words).toContain(phrase);
  // final6 L2: the over-cap repo is a full check every minute (`stat_targets`, `Fingerprint::OverCap`).
  expect(words).toContain("more than 2 000 entries under `refs/` gets a full check every minute while the slides are shown");
  // final5 M1: only the repository's own filters are emptied (src/repos/harden.ts driverOverrides); a
  // global filter such as Git LFS's clean filter still runs, so the words must not say "filters … off".
  expect(words).not.toMatch(/hooks,\s+filters,/);
});
test("final5 L1 the capability and the Rust module header name every minute that is not quiet", () => {
  const capability = JSON.parse(read("gui/src-tauri/capabilities/default.json")).description as string;
  const b1 = capability.slice(capability.indexOf("`repos_status`"), capability.indexOf("It takes no path and writes nothing."));
  const header = read("gui/src-tauri/src/repos.rs").split("\n").filter((l) => l.startsWith("//!")).join(" ").replace(/\s*\/\/!\s*/g, " ");
  const seam = read("docs/gui-seam.md").split("\n").find((l) => l.startsWith("| `repos_status`"))!;
  for (const [where, text] of [["capability", b1], ["repos.rs header", header], ["gui-seam row", seam]] as const) {
    // On the launchpad the "Not committed" status runs every minute (`decide` row 5); an `unknown` repo is retried
    // on a backoff; a repo past the stat cap counts as changed every minute (`stat_targets`, `Fingerprint::OverCap`).
    // final6 L4: each "every minute" is pinned on its own; final6 L1: with nothing held (`decide` row 3) a failed check
    // is followed by a full check every minute until one succeeds, and the retry settles at every 5 minutes.
    for (const phrase of ["Not committed\" status runs every minute", "1, 2, 4, then 5 minutes", "every 5 minutes", "counts as changed every minute", "2 000 entries", "after a failed check", "until one succeeds"]) expect([where, text.includes(phrase)]).toEqual([where, true]);
    expect([where, /the one exception|three exceptions/.test(text)]).toEqual([where, false]);
  }
});
test("final5 L4 the repos_status errors in gui-seam match the code: every failure is the fixed `spawn` sentence", () => {
  const seam = read("docs/gui-seam.md").split("\n").find((l) => l.startsWith("| `repos_status`"))!;
  expect(seam).not.toContain('{kind: "timeout"}');
  for (const phrase of ['{kind: "spawn", detail}', "30 s bound", "`STAT_LIMIT`"]) expect(seam).toContain(phrase);
});
/** The body of `function name(…) { … }` in `src`, by brace matching from its opening brace. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no function ${name}`);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${name}`);
}
test("final4 L7 B1 drives no live git check from Today's onMove (only C may add lines there)", () => {
  const today = read("gui/src/routes/Today.svelte");
  const body = functionBody(today, "onMove");
  // PREMISE: the extraction found the body (C's driver call; the second lander removed W2-S's `void slide;`).
  expect(body).toContain("cal.onMove(slide, from, deck);");
  expect(body).not.toMatch(/\bgit\s*\./);
  // control: the drivers B1 does use call it, so the same extraction would see a call there
  expect(functionBody(today, "onMinute")).toMatch(/\bgit\s*\./);
});
