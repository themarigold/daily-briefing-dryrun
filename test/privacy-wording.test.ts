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
  // Wave-2 polish §4: the calendar question's explanation says where today's events go. Read as text, never imported.
  "gui/src/lib/calendar-question.ts": () => read("gui/src/lib/calendar-question.ts"),
};

/** Each destination, as phrases BOTH the README's Privacy section and the site's must carry. */
const DESTINATIONS: [string, string[]][] = [
  ["the AI provider", ["the ai provider you choose", "provider.cli", "provider.api", "local model"]],
  ["the calendar links, only if the calendar is on", ["the calendar links you add", "only if you turn the calendar on", "one https get per private calendar link"]],
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
  "in five places, and no others",          // site — and six since B2's Open on GitHub buttons
  "in six places, and no others",           // site — and seven: the README also lists the calendar links
  "only offers these for work already on github", // README — git's local record is all the app can know
  // Wave-2 polish §4: the calendar's events go to the AI that writes the briefing, so they do not stay put.
  "stays on this computer",
  // A2 final round 1. The first is false once `aiSummary` is on; the second since the request leaves lines out.
  "transcript text is not added to the prompt",
  "gets the full saved page",
  "every other byte of the page stays",
  // A2 final round 4. A failed source's line gives its id, which can hold a name.
  "with no title, location or names",
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
    expect(plain).toContain("one https get per private calendar link");
  });
});

// B2 final round 2: the site said "six places, and no others" while the README's list had seven. The README's list is the
// one that is counted; a destination added there with no word changed here fails on the hand-written names below.
describe("the count each surface states is the README's list", () => {
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const listed = (): string[] => {
    const section = readmePrivacy();
    const start = section.indexOf("reaches the network in these places, and no others:");
    if (start === -1) throw new Error("README.md ## Privacy no longer introduces its list");
    return [...section.slice(start, section.indexOf("\nApart from that", start)).matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]!);
  };
  test("the README's list is these destinations", () => {
    expect(listed()).toEqual([
      "The AI provider you choose.",
      "The calendar links you add, only if you turn the calendar on",
      "A connectivity check",
      "GitHub, only if you ask.",
      "GitHub, when you press an Open on GitHub button in the desktop app.",
      "Your repository's own remote, only in a partial clone.",
      "The Bun runtime, only if Bun itself crashes.",
    ]);
  });
  test("the site states that count", () => {
    expect(strip(sitePrivacy())).toContain(`it reaches the network in ${WORDS[listed().length]} places, and no others`);
  });
  test("SECURITY.md states that count", () => {
    expect(strip(read("SECURITY.md"))).toContain(`lists all ${WORDS[listed().length]} destinations the tool itself reaches`);
  });
});

// Briefing redesign C (wave-2 plan C-M5-T15; C "The privacy rule", user-directed 2026-10-19: "read live and never
// save"): the desktop app's calendar slide reads today's meeting links, attendee names and notes live. The README's
// Privacy section must say what that read holds, for how long, and where it never goes; and Settings' line says it
// in one sentence. A hand-written pin, like the lists above: it cannot notice a new live field in code.
describe("C PIN: the live calendar read is described where the calendar's privacy is", () => {
  test("README.md ## Privacy names the live read, what it holds, and that it is never saved or sent", () => {
    const plain = strip(readmePrivacy());
    for (const needle of [
      "read live in the desktop app, never saved",
      "today's meeting links, attendee names and notes",
      "only in the app's memory",
      "never written to disk",
      "never sent to the ai",
      "the app's window never receives a meeting link",
      "asks first",
      "a calendar link whose address comes from a command (such as a password manager)",
      "remembered in the app's memory while the app is open",
      "remembered in the app's memory while the app is open, never saved to disk",
      // When the command runs (calendar_details.rs `decide`: a move onto the calendar or the last slide runs commands
      // with no held read, and again only while a command link holds no URL; focus and timer reads never run one).
      "the command runs on your first move onto the calendar slide or the last slide after the app starts",
      "and again on such a move only while no address is remembered",
      "dropped the first time the app uses them after the day changes",
    ]) {
      expect({ needle, found: plain.includes(needle) }).toEqual({ needle, found: true });
    }
    // The morning's cleaning still governs everything stored or sent; the live read's link is the one exception, kept
    // inside the app for Join.
    expect(readmePrivacy()).toMatch(/every web address becomes\s+`<host> link`/);   // raw: `strip` drops `<host>` as a tag
    expect(plain).toContain("the tool never stores attendee names or emails");
  });

  test("Settings → Calendar says it in one line (the GUI's own constant)", () => {
    expect(strip(read("gui/src/lib/calendar-settings.ts"))).toContain(
      'live_read_line = "meeting links, people and notes are read live and never saved."',
    );
  });
});

// B2 final round 1: the desktop app's Open on GitHub and Open in editor buttons and its copied push command. A hand-written
// pin, like the lists above. Pressing a GitHub button hands an address to the browser, so what that address holds goes to
// github.com; the app makes no request of its own, and it never pushes.
describe("B2 PIN: what the opening buttons send and start is said on every surface that lists the traffic", () => {
  const NAMED = ["open on github", "owner, repository and branch names", "github.com", "through your browser", "github links switch"];
  for (const [surface, text] of [["README.md ## Privacy", readmePrivacy], ["SECURITY.md", () => read("SECURITY.md")], ["site/index.html #privacy", sitePrivacy]] as const) {
    test(`${surface} says what Open on GitHub sends, and how to turn it off`, () => {
      const plain = strip(text());
      expect(NAMED.filter((n) => !plain.includes(n))).toEqual([]);
    });
  }
  for (const [surface, text] of [["README.md ## Privacy", readmePrivacy], ["SECURITY.md", () => read("SECURITY.md")], ["site/index.html #privacy", sitePrivacy]] as const) {
    test(`${surface} names the buttons`, () => {
      const plain = strip(text());
      expect(["open pr", "open branch", "compare", "commit's arrow"].filter((n) => !plain.includes(n))).toEqual([]);
    });
  }
  test("README.md ## Privacy offers the buttons for what local git records, not for what is on GitHub", () => {
    expect(strip(readmePrivacy())).toContain("only offers these for work your local git records on a github remote");
  });
  test("README.md ## Privacy says the app never pushes, and what Copy does instead", () => {
    const plain = strip(readmePrivacy());
    for (const needle of ["the desktop app never pushes", "copy push command puts a git push command on your clipboard for you to run"]) {
      expect({ needle, found: plain.includes(needle) }).toEqual({ needle, found: true });
    }
  });
  test("the README's program list names the editor launch, and that the editor may run workspace tasks", () => {
    expect(readmePrivacy()).toMatch(/`\/usr\/bin\/open -b <editor> <project folder>`/); // raw: `strip` drops `<editor>` as a tag
    expect(strip(readmePrivacy())).toContain("may run workspace tasks");
  });
});

// B2 final round 3: "one HTTPS GET per link" is a run's count; the desktop app's live read fetches every link again.
describe("C PIN: every surface that lists the calendar links' traffic counts the live read's fetches and bounds the redirects", () => {
  const READ_SENTENCE = "fetches every link the same way each time it reads: when you move onto the calendar slide or the last slide and, while either is shown, when the window regains focus, when you turn the calendar on, when a meeting card or join button finds the last read out of date, and every five minutes";
  const SECURITY_CLAUSE = "each time the desktop app reads them live (when you move onto the calendar slide or the last slide and, while either is shown, when its window regains focus, when you turn the calendar on, when a meeting card or join button finds the last read out of date, and every five minutes)";
  for (const [surface, text, live] of [["README.md ## Privacy", readmePrivacy, READ_SENTENCE], ["SECURITY.md", () => read("SECURITY.md"), SECURITY_CLAUSE], ["site/index.html #privacy", sitePrivacy, READ_SENTENCE]] as const) {
    test(surface, () => {
      const plain = strip(text());
      const needles = ["one https get per private calendar link", "at most three redirects and only within the same domain", live];
      expect(needles.filter((n) => !plain.includes(n))).toEqual([]);
    });
  }
  test("README.md's calendar section lists the same reads", () => {
    expect(strip(read("README.md"))).toContain("read live from your calendars when you move onto the calendar slide or the last slide and, while either is shown, again when the window regains focus, when you turn the calendar on, when a meeting card or join button finds the last read out of date, and every five minutes (only while the calendar is on)");
  });
});

// A2-M5-T16 (A2 :98; Open question 3 (a), user decision 2026-11-03): the AI summary's second call, on every surface that
// lists what reaches the AI. A hand-written wording pin, like the lists above: it reads no code and cannot notice a change
// in what the call really sends. No eval material lives here.
/** A Markdown file's level-2 section, up to the next level-2 heading. */
function markdownSection(rel: string, heading: string): string {
  const md = read(rel);
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`${rel} has no \`## ${heading}\` section — the pin cannot find what it pins`);
  const end = md.indexOf("\n## ", start + 1);
  return md.slice(start, end === -1 ? undefined : end);
}

/** The README's AI summaries subsection, so a phrase elsewhere in Privacy cannot satisfy these pins. */
function readmeSummaries(): string {
  const privacy = readmePrivacy();
  const start = privacy.indexOf("\n### AI summaries (optional, off by default)\n");
  if (start === -1) throw new Error("README.md ## Privacy has no AI summaries subsection — the pin cannot find what it pins");
  return privacy.slice(start);
}

/** The site's privacy section, from where it starts on AI summaries up to the connectivity check, the next destination. */
function siteSummaries(): string {
  const privacy = sitePrivacy();
  const start = privacy.indexOf("AI summaries are off unless");
  if (start === -1) throw new Error("site/index.html #privacy has no sentence about AI summaries — the pin cannot find what it pins");
  return privacy.slice(start, privacy.indexOf("A connectivity check", start));
}

const SUMMARY_SURFACES: [string, () => string][] = [
  ["README.md ## Privacy", readmeSummaries],
  ["docs/PROVIDERS.md ## AI summaries", () => markdownSection("docs/PROVIDERS.md", "AI summaries: the second call")],
  ["SECURITY.md ## Threat model", () => markdownSection("SECURITY.md", "Threat model")],
  ["site/index.html #privacy", siteSummaries],
];

/** What every surface says, sentence by sentence (A2 :98's list, in the plan's order). */
const SUMMARY_WORDING: [string, string][] = [
  ["off by default", "ai summaries are off unless you turn them on"],
  ["a non-quiet delivered day makes a second call", "a delivered briefing on a day that is not quiet makes a second ai call"],
  ["a same-day delivered regeneration can make another", "generating the same day's briefing again can make another when it is delivered"],
  ["the winning entry", "it goes to the same provider entry that wrote the briefing, with one try and no fallback"],
  ["the fresh key-helper run", "your apikeycommand runs again for this call"],
  ["the page on a locked attempt", "a locked attempt gets the saved page"],
  // User decision 2026-11-04: test/summary.input.test.ts and test/summary.run.test.ts pin what the code really leaves out.
  ["the computer's name, warnings and provider line are left out", "every attempt leaves out the computer's name, the page's warning and notice lines and the line that names the provider"],
  ["transcript quotes go when they are on the page", "if you turned transcripts on, the call includes the page's — you wrote quotes from your sessions, up to 600 characters each"],
  ["schedule shape on unlocked/unlocked", "an unlocked attempt after an unlocked morning gets the saved page with the calendar section's body replaced by schedule shape"],
  ["no call on locked-morning/unlocked-summary", "an unlocked attempt after a locked morning makes no call"],
  ["no call when off or quiet", "no call is made when ai summaries are off or on a quiet day"],
  ["no live details", "no live details are added"],
  ["Windows, in G-TEXT's words", "ai summaries are not available on windows yet."],
  ["no summary call on Windows", "no summary call is made on windows"],
  ["the result stays when the switch goes off", "it stays after you turn ai summaries off, and other dates' files are not pruned"],
  ["where the result goes", "it goes with the briefing archive when uninstall removes the engine's data"],
  ["a meeting may be named", "a locked attempt's text may name a meeting"],
  ["slides only", "the result shows only on the desktop app's slides"],
  ["the engine cannot read that setting", "the call is still made with the slides off or with no desktop app, because the engine cannot read that app setting"],
];
/** `strip` drops `<state>` as a tag, so the stored path is read raw, with the site's entities decoded. */
const SUMMARY_FILE = "<state>/briefings/<date>.<hash>.<version>.summary.json";
const unescaped = (text: string): string => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">");

describe("A2 PIN: the AI summary's second call is described wherever the traffic is", () => {
  describe.each(SUMMARY_SURFACES)("%s", (_surface, text) => {
    test.each(SUMMARY_WORDING)("%s", (_fact, needle) => {
      expect(strip(text())).toContain(needle);
    });
  });

  test.each(SUMMARY_SURFACES)("%s names the stored file", (_surface, text) => {
    expect(unescaped(text())).toContain(SUMMARY_FILE);
  });

  test("the README's list of what a run starts counts the summary's call and its --help", () => {
    expect(strip(read("README.md"))).toContain("the opt-in recapcampaigns adds one more call to the same provider, and ai summaries add one more call and, with a claude cli, one more --help check");
    expect(strip(read("README.md"))).not.toContain("each add one more call");
  });

  test("the README says a run waits for the summary, and what is stored names its file", () => {
    expect(strip(readmeSummaries())).toContain("a run with ai summaries on can return up to 30 seconds after the briefing is delivered, and the desktop app's run now stays running until then");
    const stored = readmePrivacy().slice(readmePrivacy().indexOf("**What is stored.**"), readmePrivacy().indexOf("**Read live in the desktop app"));
    expect(stored).toContain(SUMMARY_FILE);
    expect(strip(stored)).toContain("a locked attempt's text may name a meeting");
  });

  test("docs/CONFIG.md: transcripts says the quotes reach the summary, and aiSummary points at the details", () => {
    const config = read("docs/CONFIG.md");
    const section = (heading: string) => strip(config.slice(config.indexOf(`\n### \`${heading}\`\n`), config.indexOf("\n### ", config.indexOf(`\n### \`${heading}\`\n`) + 1)));
    expect(section("transcripts")).toContain("with aisummary on, the page's quotes are sent in the summary's call, up to 600 characters each");
    const summary = section("aiSummary");
    expect(summary).toContain("what the call sends and where the result is stored are in providers.md");
    expect(config).toContain("[PROVIDERS.md](PROVIDERS.md#ai-summaries-the-second-call)");
    expect(summary).toContain("ai summaries are not available on windows yet. no summary call is made on windows");
    expect(summary).toContain("every attempt leaves out the computer's name, the page's warning and notice lines and the line that names the provider");
    expect(summary).toContain("the result shows only on the desktop app's slides");
  });

  // `scheduleShape`, `src/calendar/prompt.ts`: the span, busy or free, and `(3 people)`.
  const SHAPE = "schedule shape: times, busy blocks and attendee counts, with no event title, location or attendee names";
  // `calendarPromptHeader` and `fixedLines`, same file: the block's other lines reach an unlocked attempt too.
  const SHAPE_ALSO = "the calendar section also carries today's date, the current time and your time zone and, when a calendar source could not be read fully, that source's id, which can hold a name, as in work-alice";
  const LOCKED = "an attempt is locked when it cannot act on what it reads";

  test("the site and SECURITY.md say the same about what schedule shape holds, and what locked means", () => {
    for (const text of [siteSummaries(), markdownSection("SECURITY.md", "Threat model")]) {
      expect(strip(text)).toContain(SHAPE);
      expect(strip(text)).toContain(SHAPE_ALSO);
      expect(strip(text)).toContain(LOCKED);
    }
  });

  // `summaryInput` over `promptBlocksFor`: test/summary.input.test.ts holds both branches to the code.
  test.each(["README.md", "docs/PROVIDERS.md"])("%s says which budget stops an unlocked attempt's call, and which does not", (rel) => {
    const plain = strip(read(rel));
    expect(plain).toContain("if the prompt budget left room only for the line today's calendar omitted: prompt budget too small, that line replaces the body and the call goes with no meeting text");
    expect(plain).toContain("if it had events and there was no room even for that line, or the schedule shape could not be built, no call is made");
    expect(plain).not.toContain("if it had events but no schedule shape, no call is made");
  });

  test.each(["README.md", "docs/PROVIDERS.md"])("%s says what else an unlocked attempt's calendar section carries, at both its definitions", (rel) => {
    expect(strip(read(rel)).split(SHAPE_ALSO).length - 1).toBe(2);
    expect(strip(read(rel)).split("with no event title, location or attendee names").length - 1).toBe(2);
  });

  test("SECURITY.md links to the table that defines locked and unlocked attempts", () => {
    expect(markdownSection("SECURITY.md", "Threat model")).toContain("](docs/PROVIDERS.md#calendar-locked-and-unlocked-attempts)");
    expect(read("docs/PROVIDERS.md")).toContain("\n## Calendar: locked and unlocked attempts\n");
  });

  test("SECURITY.md no longer calls the page the same text as the prompt", () => {
    const plain = strip(markdownSection("SECURITY.md", "Threat model"));
    expect(plain).not.toContain("the same repository text");
    expect(plain).toContain("the saved page is not the same text as the morning's prompt");
  });

  test("docs/gui-seam.md: the wait, and the two summary drivers with the dropped minute tick", () => {
    // Raw, whitespace collapsed: this file's `<…>` shapes would make `strip` drop whole passages as if they were tags.
    const seam = read("docs/gui-seam.md").replace(/\s+/g, " ");
    expect(seam).toContain("With AI summaries on, a run returns up to 30 s after its envelope, and Run now stays running until then");
    expect(seam).toContain("`summaryStatusDriver`");
    expect(seam).toContain("`summaryReader`");
    expect(seam).toContain("There is no minute tick");
    expect(seam).toContain("Only a Settings save publishes `known: false` synchronously");
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
