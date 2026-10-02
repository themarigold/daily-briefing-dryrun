// test/reporting-channel.test.ts — the vulnerability-reporting channel is the private one, everywhere a
// contributor would look for it (Phase E, E17).
//
// WHY THIS EXISTS. CONTRIBUTING.md used to tell people to report a security problem by opening a public
// issue, which publishes the problem before a fix exists. The repository has GitHub private
// vulnerability reporting enabled, and SECURITY.md now names it as the only channel. Two documents
// describing one channel drift independently, so this pins both: SECURITY.md names the private channel
// (and offers no email address — none exists, and an address would also trip the export's identity
// sweep), and CONTRIBUTING.md's section points to SECURITY.md instead of to the issue tracker.
//
// The export-residual sweep over these files already runs on every `bun test`
// (test/export-public.test.ts); nothing here repeats it.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const POLICY = readFileSync(`${ROOT}SECURITY.md`, "utf8");
const CONTRIBUTING = readFileSync(`${ROOT}CONTRIBUTING.md`, "utf8");

/** GitHub's private-reporting form for the public repository. */
const PRIVATE_FORM = "https://github.com/themarigold/daily-briefing/security/advisories/new";

/** The body of a `## ` section, up to the next `## ` heading. */
function section(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

test("SECURITY.md names GitHub private vulnerability reporting, links its form, and offers no email", () => {
  const reporting = section(POLICY, "Reporting a vulnerability");
  expect(reporting.length, "SECURITY.md has no '## Reporting a vulnerability' section").toBeGreaterThan(0);
  expect(reporting).toMatch(/private vulnerability reporting/i);
  expect(reporting).toContain(`](${PRIVATE_FORM})`);
  // No address to write to, anywhere in the policy: the private form is the channel.
  expect(POLICY).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
  expect(POLICY).not.toMatch(/mailto:/i);
  // The rest of the policy the plan requires, so a rewrite cannot silently drop it.
  expect(section(POLICY, "Supported versions")).toMatch(/latest release/i);
  expect(POLICY).toMatch(/no bug bounty/i);
});

test("CONTRIBUTING.md's security section points to SECURITY.md, not to a public issue", () => {
  const s = section(CONTRIBUTING, "Reporting security issues");
  expect(s.length, "CONTRIBUTING.md has no '## Reporting security issues' section").toBeGreaterThan(0);
  expect(s).toContain("](SECURITY.md)");
  expect(s).toMatch(/private/i);
  expect(s, "the section still sends reporters to the public issue tracker").not.toMatch(/open an issue/i);
});
