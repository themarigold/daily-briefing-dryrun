// test/bug-template.test.ts — the public repo's bug-report form (v0.2.1 spec §5).
//
// The form lives at `publish/.github/ISSUE_TEMPLATE/bug.yml` in the monorepo and ships as
// `.github/ISSUE_TEMPLATE/bug.yml` in the public export (export-public.sh overlays tracked `publish/**`
// at the root). `bun test` runs in both layouts, so the file is looked up in both, monorepo path first —
// the same rule as test/release-workflow.test.ts's `workflowFile`.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);

function bugTemplate(): string {
  for (const dir of ["publish/.github/ISSUE_TEMPLATE", ".github/ISSUE_TEMPLATE"]) {
    const p = `${ROOT}${dir}/bug.yml`;
    if (existsSync(p)) return p;
  }
  throw new Error("bug.yml found under neither publish/.github/ISSUE_TEMPLATE/ nor .github/ISSUE_TEMPLATE/");
}

interface Field { type: string; id?: string; attributes: Record<string, unknown>; validations?: { required?: boolean } }
const form = Bun.YAML.parse(readFileSync(bugTemplate(), "utf8")) as { name?: string; description?: string; body: Field[] };
const byId = (id: string): Field => {
  const f = form.body.find((b) => b.id === id);
  if (f === undefined) throw new Error(`no field with id "${id}"`);
  return f;
};

// The two log commands, character for character as spec §5 gives them. Each pipes the log through a
// Perl scrub: `\Q…\E` replaces the home path literally even when it holds regex characters, `uname -n`
// is the machine name the briefing title shows, `/i` covers case, and `if length $ENV{H}` keeps an empty
// name from matching everywhere.
const SCRUB = `H="$(uname -n)" perl -pe 's/\\Q$ENV{HOME}\\E/~/g; s/\\Q$ENV{H}\\E/<this-machine>/gi if length $ENV{H}'`;
const MACOS_LOG = `tail -n 30 ~/Library/Application\\ Support/daily-briefing/briefing.log | ${SCRUB}`;
const LINUX_LOG = `journalctl --user -u daily-briefing.service -n 30 --no-pager -o cat | ${SCRUB}`;

test("CONTRIBUTING.md points bug reports at this form, by the name GitHub lists it under", () => {
  const contributing = readFileSync(`${ROOT}CONTRIBUTING.md`, "utf8").replace(/\s+/g, " ");
  expect(contributing).toContain(`For bugs, use the bug report form (New issue → ${form.name});`);
});

test("the form has a name, a description, and every field spec §5 lists, in order", () => {
  expect(form.name).toBe("Bug report");
  expect(typeof form.description).toBe("string");
  expect(form.description!.length).toBeGreaterThan(0);
  expect(form.body.filter((b) => b.id !== undefined).map((b) => b.id)).toEqual([
    "os", "arch", "app-version", "install-type", "steps", "expected", "actual", "screenshots", "log", "privacy",
  ]);
});

test("install type is a dropdown with exactly the five ways the app ships", () => {
  const f = byId("install-type");
  expect(f.type).toBe("dropdown");
  expect(f.attributes.options).toEqual(["DMG", "AppImage", ".deb", "command-line binary", "built from source"]);
});

test("the log field carries both scrub commands verbatim, and the Details-box alternative", () => {
  const f = byId("log");
  expect(f.type).toBe("textarea");
  const d = String(f.attributes.description);
  const blocks = [...d.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  expect(blocks).toEqual([MACOS_LOG, LINUX_LOG]);
  expect(d).toContain("**Details** box");
});

test("the screenshots field asks for the Schedule screen on a missing or late briefing", () => {
  const f = byId("screenshots");
  expect(f.type).toBe("textarea");
  expect(String(f.attributes.description)).toContain("missing or late briefing, include the Schedule screen");
});

test("the privacy checkbox is required, and says what to blank out", () => {
  const f = byId("privacy");
  expect(f.type).toBe("checkboxes");
  const opts = f.attributes.options as { label: string; required?: boolean }[];
  expect(opts).toHaveLength(1);
  expect(opts[0]!.required).toBe(true);
  expect(opts[0]!.label).toBe(
    "I blanked out repo names, commit messages, paths and my machine's name where I don't want other testers to see them.",
  );
});

test("a negative control: the command check fails on a scrub with a dropped \\Q", () => {
  const broken = MACOS_LOG.replace("\\Q$ENV{HOME}", "$ENV{HOME}");
  expect(broken).not.toBe(MACOS_LOG);
  const d = String(byId("log").attributes.description);
  expect(d.includes(broken)).toBe(false);
  expect(d.includes(MACOS_LOG)).toBe(true);
});
