// test/docs-links.test.ts — every relative link in the stranger-facing docs resolves (Phase E, E19).
//
// WHY THIS EXISTS. The README restructure moved most of its depth into docs/ and left one-line pointers
// behind, so the README is now mostly links. A pointer to a file that was renamed, never committed, or
// to a heading whose wording changed is a dead end for exactly the reader the restructure is for.
//
// WHAT "RESOLVES" MEANS. A relative link's path must name a file (or a directory) that exists — and,
// when this runs inside a git checkout, one that git TRACKS, because only tracked files reach the
// public export (scripts/export-public.sh copies `git ls-files`). The export itself has no `.git`
// (release-check step 8 runs `bun test` there), so outside a checkout only existence is checked: the
// same two-layout rule test/publish-prep.test.ts follows. A `#fragment` must also match a heading in the
// target Markdown file, slugged the way GitHub does it, because that is where these files are read.
// External links (a scheme, or `//`) are not followed: this suite makes no network calls.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");

/** The documents a stranger reads. README first: the plan's requirement is about it. */
const DOCS = [
  "README.md", "CONTRIBUTING.md", "SECURITY.md",
  "docs/INSTALL.md", "docs/TROUBLESHOOTING.md", "docs/CONFIG.md", "docs/PROVIDERS.md", "docs/AUDIT.md",
];

/** Tracked paths relative to ROOT, or null when ROOT is not inside a git checkout that tracks it. */
function trackedFiles(): Set<string> | null {
  const r = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  const files = new TextDecoder().decode(r.stdout).split("\0").filter(Boolean);
  // A checkout of THIS project tracks its own README; an export that happens to sit inside some other
  // repository tracks nothing here, and is treated as the no-git layout it is.
  return files.includes("README.md") ? new Set(files) : null;
}

/** Markdown with fenced blocks and inline code spans blanked, so a link-shaped string in code is not a link. */
function prose(md: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; out.push(""); continue; }
    out.push(fenced ? "" : line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length)));
  }
  return out.join("\n");
}

/** Inline links and images `[text](target)`, plus reference definitions `[ref]: target`. */
function links(md: string): string[] {
  const text = prose(md);
  const out: string[] = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push(m[1]!);
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) out.push(m[1]!);
  return out;
}

/** GitHub's heading anchors: lower-case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = h[1]!.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const isExternal = (t: string) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t) || t.startsWith("//");

type Checked = { problems: string[]; relativeLinks: number; fragments: number; perDoc: Map<string, number> };

function check(docs: string[], tracked: Set<string> | null): Checked {
  const problems: string[] = [];
  const perDoc = new Map<string, number>();
  let relativeLinks = 0, fragments = 0;
  for (const doc of docs) {
    const file = join(ROOT, doc);
    const md = readFileSync(file, "utf8");
    let count = 0;
    for (const target of links(md)) {
      if (isExternal(target)) continue;
      count++;
      const [rawPath, frag] = target.split("#", 2) as [string, string | undefined];
      const path = decodeURIComponent(rawPath.split("?")[0]!);
      const abs = path === "" ? file : resolve(dirname(file), path);
      const rel = relative(ROOT, abs);
      if (rel.startsWith("..")) { problems.push(`${doc}: ${target} points outside the project`); continue; }
      if (!existsSync(abs)) { problems.push(`${doc}: ${target} names ${rel}, which does not exist`); continue; }
      const isDir = statSync(abs).isDirectory();
      if (tracked) {
        const ok = isDir ? [...tracked].some((f) => f.startsWith(`${rel}/`)) : tracked.has(rel);
        if (!ok) { problems.push(`${doc}: ${target} names ${rel}, which git does not track (it would not reach the export)`); continue; }
      }
      if (frag !== undefined && frag !== "") {
        if (isDir || !abs.endsWith(".md")) { problems.push(`${doc}: ${target} has a #fragment on a non-Markdown target`); continue; }
        fragments++;
        if (!anchors(readFileSync(abs, "utf8")).has(decodeURIComponent(frag).toLowerCase())) {
          problems.push(`${doc}: ${target} — ${rel} has no heading with the anchor #${frag}`);
        }
      }
    }
    perDoc.set(doc, count);
    relativeLinks += count;
  }
  return { problems, relativeLinks, fragments, perDoc };
}

test("the link extractor and the slugger see what GitHub sees", () => {
  // Non-vacuity for the helpers themselves, on planted text rather than the real docs.
  expect(links("see [a](docs/X.md#y), ![i](img.png) and `[not](a-link)`\n```\n[nor](this)\n```\n[r]: ref.md"))
    .toEqual(["docs/X.md#y", "img.png", "ref.md"]);
  const a = anchors("# Which credential gets used — subscription or API credits\n## `provider.cli`\n## macOS: the desktop app\n## Twice\n## Twice\n```\n# not a heading\n```");
  expect([...a]).toEqual(["which-credential-gets-used--subscription-or-api-credits", "providercli", "macos-the-desktop-app", "twice", "twice-1"]);
});

test("every relative link in the stranger-facing docs names an existing (and, in a checkout, tracked) file and heading", () => {
  const tracked = trackedFiles();
  const { problems, relativeLinks, fragments, perDoc } = check(DOCS, tracked);
  expect(problems).toEqual([]);
  // Floors, measured at this commit (README 26 relative links, 72 across all eight files, 46 of them with
  // a #fragment) and set below, so an extractor that stopped matching fails instead of passing an empty
  // list, while ordinary editing of the docs does not.
  expect(perDoc.get("README.md")!).toBeGreaterThanOrEqual(20);
  expect(relativeLinks).toBeGreaterThanOrEqual(60);
  expect(fragments).toBeGreaterThanOrEqual(30);
});

test("in a git checkout the tracked-file branch is actually exercised", () => {
  // In the monorepo this must run the tracked check; in the export (no .git) it is the existence-only
  // layout by design. `publish/` is the monorepo-only marker the other two-layout suites use.
  if (!existsSync(join(ROOT, "publish"))) return;
  expect(trackedFiles(), "inside the monorepo, git ls-files should list this project's files").not.toBeNull();
});
