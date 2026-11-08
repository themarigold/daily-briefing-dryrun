// test/calendar-link-scrub.test.ts — the calendar-scoped scrub for link-shaped strings (v0.3.0 plan M2a; spec r4
// §4.2 "Never leaks": `status --json`'s `configError` additionally passes it). Built and pinned now; M5 wires it.
//
// Two directions, both pinned: every spelling of a secret link an error message could quote loses the secret
// (the sentinel sweep), and the text such a message legitimately carries — the config file's path, field names,
// the resolver's own fixed warnings, an email address — survives untouched.
import { test, expect } from "bun:test";
import { CALENDAR_LINK_SCRUBBED, scrubCalendarLinks } from "../src/calendar/link-scrub";
import { CALENDAR_CONFIG_WARNINGS } from "../src/calendar/config";

const TOKEN = "ZZSENTINELcafe0000";
const G = `https://calendar.google.com/calendar/ical/me%40example.com/private-${TOKEN}/basic.ics`;

test("URL-LEAK SENTINEL: every spelling of a link an error could quote loses the secret", () => {
  const spellings: [string, string][] = [
    ["the URL alone", G],
    ["quoted in a JSON parse error", `JSON Parse error: Unexpected token near "url": "${G}",`],
    ["in single quotes", `bad value '${G}' at line 4`],
    ["in angle brackets", `<${G}>`],
    ["in backticks", `\`${G}\``],
    ["followed by punctuation", `${G}, then more`],
    ["webcal://", `webcal://p01-calendars.icloud.com/published/2/${TOKEN}`],
    ["http://", G.replace("https:", "http:")],
    ["any other scheme", `webcals://p01-calendars.icloud.com/published/2/${TOKEN}`],
    ["scheme in capitals", G.replace("https:", "HTTPS:")],
    ["JSON-escaped slashes", G.replace(/\//g, "\\/")],
    // Final harden r3: the backslash spellings a WHATWG parser reads as `//` for the special schemes.
    ["backslashes", G.replace(/\//g, "\\")],
    ["mixed slash and backslash", G.replace("https://", "https:/\\")],
    ["percent-encoded backslashes", `https%3A%5C%5Cp01-calendars.icloud.com%5Cpublished%5C2%5C${TOKEN}`],
    ["backslash host path, no scheme", `p01-calendars.icloud.com\\published\\2\\${TOKEN}`],
    // Post-convergence LOW: ONE separator for http/https/webcal, and a host with no dot the host rule cannot see.
    ["one backslash, undotted host", `https:\\intranet\\published\\${TOKEN}`],
    ["one slash, undotted host", `webcal:/intranet/published/${TOKEN}`],
    ["percent-encoded, one separator", `HTTPS%3A%2Fintranet%2F${TOKEN}`],
    ["percent-encoded", encodeURIComponent(G)],
    ["percent-encoded, upper-case escapes", encodeURIComponent(G).toUpperCase().replace(TOKEN.toUpperCase(), TOKEN)],
    // No `.ics` and no literal `/` after the host: only the percent-encoded scheme rule can catch this one.
    ["percent-encoded, no .ics", encodeURIComponent(`webcal://p01-calendars.icloud.com/published/2/${TOKEN}`)],
    ["no scheme at all", G.slice("https://".length)],
    ["a quote that began mid-URL", `ical/me%40example.com/private-${TOKEN}/basic.ics`],
    ["a path with no host", `/private-${TOKEN}/basic.ics`],
    ["an .ics file name with a query", `basic.ics?token=${TOKEN}`],
    ["userinfo", `https://me:${TOKEN}@calendar.google.com/x`],
    ["glued to a percent-encoded prefix", `me%40https://calendar.example.org/${TOKEN}`],
    ["two links in one message", `first ${G} and second webcal://x.example.net/${TOKEN}`],
    ["across lines", `line one\n${G}\nline three`],
  ];
  for (const [label, text] of spellings) {
    const out = scrubCalendarLinks(text);
    expect(`${label}: ${out}`).not.toContain(TOKEN);
    expect(`${label}: ${out.includes(CALENDAR_LINK_SCRUBBED)}`).toBe(`${label}: true`);
  }
  // The surrounding text of a message survives around the hole.
  expect(scrubCalendarLinks(`JSON Parse error near "url": "${G}",`)).toBe(`JSON Parse error near "url": "${CALENDAR_LINK_SCRUBBED}",`);
  expect(scrubCalendarLinks(`line one\n${G}\nline three`)).toBe(`line one\n${CALENDAR_LINK_SCRUBBED}\nline three`);
});

test("KNOWN MISS rows — the mid-URL gap the header documents (a quote begun after the host, naming no .ics)", () => {
  // Pinned as MISSES so the header cannot drift from the code in either direction: if a rule starts catching one
  // of these, this fails and the header's gap paragraph must be rewritten; if a caught shape starts surviving, the
  // sentinel sweep above fails. M2a checkpoint LOW: the `.ics` rule covers a mid-URL quote only when the quote still
  // names the file — Google's case.
  const misses: [string, string][] = [
    ["iCloud, the path after the host", `published/2/${TOKEN}`],
    ["Outlook, guid and token with no domain", `owa/calendar/0f1e2d3c4b5a69788796a5b4c3d2e1f0/${TOKEN}/`],
    ["Outlook, the token alone, cut before calendar.ics", `${TOKEN}/`],
  ];
  for (const [label, text] of misses) expect(`${label}: ${scrubCalendarLinks(`x ${text} y`)}`).toBe(`${label}: x ${text} y`);
  // …and the shapes beside them that ARE caught: the same Outlook fragment holding the mailbox's `@<domain>/`
  // (the host rule, from the domain on — the guid before it stays), and either link quoted far enough to name
  // its host or its `.ics` file.
  expect(scrubCalendarLinks(`x owa/calendar/0f1e2d3c@contoso.com/${TOKEN}/ y`)).toBe(`x owa/calendar/0f1e2d3c@${CALENDAR_LINK_SCRUBBED} y`);
  expect(scrubCalendarLinks(`x ${TOKEN}/calendar.ics y`)).toBe(`x ${CALENDAR_LINK_SCRUBBED} y`);
  expect(scrubCalendarLinks(`x p01-calendars.icloud.com/published/2/${TOKEN} y`)).toBe(`x ${CALENDAR_LINK_SCRUBBED} y`);
});

test("what such a message legitimately carries survives untouched", () => {
  const keep = [
    "/Users/me/Library/Application Support/daily-briefing/config.json: Unexpected token } at line 3",
    "/home/me/.config/daily-briefing/config.json is not valid JSON",
    "~/.local/state/daily-briefing/calendar/links/work.url",
    "C:\\Users\\me\\AppData\\Roaming\\daily-briefing\\config.json",
    'config: "repos" must be an array of paths',
    "JSON Parse error: Expected '}'",
    "owner me@example.com is not confirmed",
    "calendar.links[0].urlEnv",
    "version 0.3.0 (build 2026.10.09)",
    ...Object.values(CALENDAR_CONFIG_WARNINGS),
  ];
  for (const text of keep) expect(scrubCalendarLinks(text)).toBe(text);
});

test("idempotent, never throws, and a non-string comes back unchanged", () => {
  const once = scrubCalendarLinks(`a ${G} b`);
  expect(scrubCalendarLinks(once)).toBe(once);
  expect(scrubCalendarLinks("")).toBe("");
  for (const v of [undefined, null, 720, { url: G }]) expect(scrubCalendarLinks(v as unknown as string)).toBe(v as unknown as string);
});

test("linear: adversarial inputs of 200,000 characters scrub in well under a second", () => {
  // `"a.".repeat(…)` is the input the first version did not finish in two minutes (quadratic in two patterns).
  const inputs = [
    "a".repeat(200_000) + ":", "a".repeat(200_000) + ".icsx", "ab/".repeat(70_000), "a.".repeat(100_000), "%3a".repeat(70_000),
    "1a".repeat(100_000), "a-".repeat(100_000) + "/", "a.b".repeat(70_000) + "/", "a+".repeat(100_000) + ":",
    "https:" + "\\".repeat(200_000), "http:/".repeat(40_000), "webcal:" + "%2f".repeat(70_000),
  ];
  for (const text of inputs) {
    const t = performance.now();
    scrubCalendarLinks(text);
    expect(performance.now() - t).toBeLessThan(1_000);
  }
});
