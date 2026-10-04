// test/discoverySummary.test.ts — v0.2.1 §2.4.2 / §2.4.5 (plan T1.2): the discovery-issue summary, its
// counting rule, its label rule, and the discovery-blocked predicate. All pure; the wiring through runCore,
// run() and doctor is pinned in test/core.discovery-blocked.test.ts, test/main.test.ts and
// test/json-surfaces.test.ts.
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import {
  countedIssues, discoveryBlocked, discoverySummary, LABEL_DENYLIST, HIDDEN_LABEL, MAX_LABELS_PER_CLAUSE,
  DISCOVERY_SUMMARY_LEADS, isDiscoverySummary,
} from "../src/discoverySummary";
import { API_NOTICE_TEXTS, renderBriefing, stripControl } from "../src/render";
import type { PathIssue } from "../src/protectedPath";
// Tests may import eval code (spec §1); runtime code may not, which is why the module under test mirrors it.
import {
  isPostureWarning, isTruncationWarning,
  TRUNCATION_SENTINEL, API_TRUNCATION_SENTINEL, API_TRANSPORT_SENTINEL, API_CLEARTEXT_SENTINEL,
} from "../src/eval/posture";

const HOME = "/Users/me";
const tcc = (path: string): PathIssue => ({ path, kind: "tcc-denied", protectedRoot: path });
const unreadable = (path: string): PathIssue => ({ path, kind: "unreadable" });
const notFound = (path: string): PathIssue => ({ path, kind: "not-found" });
const notARepo = (path: string): PathIssue => ({ path, kind: "not-a-repo" });
const SENTINELS = [TRUNCATION_SENTINEL, API_TRUNCATION_SENTINEL, API_TRANSPORT_SENTINEL, API_CLEARTEXT_SENTINEL];

describe("countedIssues", () => {
  test("keeps tcc-denied and unreadable at any depth; not-found only for a configured root; never not-a-repo", () => {
    const cfg = { discoverRoots: [`${HOME}/code`, `${HOME}/typo`] };
    const issues = [
      tcc(`${HOME}/Desktop`), unreadable(`${HOME}/code/a/locked`),
      notFound(`${HOME}/typo`),               // a configured root that does not exist: counted
      notFound(`${HOME}/code/vanished`),      // nested not-found (a walk race): not counted
      notARepo(`${HOME}/code/file.txt`),      // not counted
    ];
    expect(countedIssues(issues, cfg).map((i) => i.path)).toEqual([`${HOME}/Desktop`, `${HOME}/code/a/locked`, `${HOME}/typo`]);
  });

  test("drops a path excludeRepos excludes — by full path and by basename, the check discovery applies to repos", () => {
    const issues = [unreadable(`${HOME}/code/private`), unreadable(`${HOME}/work/old-checkout`), unreadable(`${HOME}/code/kept`)];
    expect(countedIssues(issues, { excludeRepos: [`${HOME}/code/private`, "old-checkout"] }).map((i) => i.path))
      .toEqual([`${HOME}/code/kept`]);
  });

  test("search folders [~, ~/Desktop] with Desktop denied: one issue, not two — trailing slash included", () => {
    // discoverRepos records the denial once while walking `~` and once as a root; issues are not deduped upstream.
    const twice = [tcc(`${HOME}/Desktop`), tcc(`${HOME}/Desktop`)];
    expect(countedIssues(twice, { discoverRoots: [HOME, `${HOME}/Desktop`] })).toHaveLength(1);
    const spelledTwoWays = [tcc(`${HOME}/Desktop`), tcc(`${HOME}/Desktop/`)];
    const counted = countedIssues(spelledTwoWays, { discoverRoots: [HOME, `${HOME}/Desktop/`] });
    expect(counted).toHaveLength(1);
    // …and the survivor still identifies the configured root, whichever spelling it carries.
    expect(discoveryBlocked([], counted, [HOME, `${HOME}/Desktop/`])).toBe(true);
    expect(discoverySummary(counted, { noRepos: false, home: HOME })).toContain("Couldn't read 1 folder (~/Desktop)");
  });

  // On POSIX a backslash is an ordinary filename character, not a separator: a folder literally named
  // `Desktop\` is NOT the configured root `Desktop`. Only the platform separator is a trailing separator.
  test.skipIf(sep !== "/")("POSIX: a folder named `Desktop\\` is not the configured root `Desktop` (only `/` is stripped)", () => {
    const root = "/scan/Desktop";
    const roots = { discoverRoots: [root] };
    // a missing `Desktop\` is a nested not-found, not the configured root's → not counted
    expect(countedIssues([notFound(`${root}\\`)], roots)).toEqual([]);
    // a denied `Desktop\` is counted (any depth) but stays distinct from the root, and never blocks
    const counted = countedIssues([tcc(`${root}\\`), tcc(root)], roots);
    expect(counted.map((i) => i.path)).toEqual([`${root}\\`, root]);
    expect(discoveryBlocked([], [tcc(`${root}\\`)], [root])).toBe(false);
    // the real root still matches, with or without its trailing `/`
    expect(discoveryBlocked([], [tcc(`${root}/`)], [root])).toBe(true);
  });
});

describe("discoveryBlocked", () => {
  const roots = [`${HOME}/Documents`, HOME];
  test("a counted issue for a CONFIGURED root, with zero repos, blocks", () => {
    expect(discoveryBlocked([], [tcc(`${HOME}/Documents`)], roots)).toBe(true);
    expect(discoveryBlocked([], [notFound(`${HOME}/Documents`)], roots)).toBe(true);
  });
  test("an INCIDENTAL child of a root never blocks — the no-stamp-loop invariant", () => {
    expect(discoveryBlocked([], [tcc(`${HOME}/Desktop`)], roots)).toBe(false);
  });
  test("any repo found means not discovery-blocked", () => {
    expect(discoveryBlocked([`${HOME}/code/x`], [tcc(`${HOME}/Documents`)], roots)).toBe(false);
  });
  test("no counted issue, no block", () => {
    expect(discoveryBlocked([], [], roots)).toBe(false);
  });
});

describe("discoverySummary wording", () => {
  test("no counted issue → no summary, even with zero repos", () => {
    expect(discoverySummary([], { noRepos: true, home: HOME })).toBeUndefined();
  });

  test("each kind alone produces only its own clause", () => {
    const t = discoverySummary([tcc(`${HOME}/Desktop`), tcc(`${HOME}/Documents`)], { noRepos: false, home: HOME })!;
    expect(t).toBe("Couldn't read 2 folders (~/Desktop, ~/Documents) because macOS blocked access, so repos in them may be missing. Allow access in System Settings → Privacy & Security → Files & Folders (in the app: Schedule → Folder access).");
    const u = discoverySummary([unreadable(`${HOME}/x`)], { noRepos: false, home: HOME })!;
    expect(u).toBe("Couldn't read 1 folder (~/x) — check its permissions — so repos in it may be missing.");
    const f = discoverySummary([notFound(`${HOME}/y`)], { noRepos: false, home: HOME })!;
    expect(f).toBe("Couldn't find 1 folder listed in Folders to search (~/y).");
  });

  test("mixed kinds produce ONE summary carrying each clause once, in a fixed order", () => {
    const s = discoverySummary([notFound("/srv/y"), unreadable(`${HOME}/x`), tcc(`${HOME}/Desktop`)], { noRepos: false, home: HOME })!;
    const at = (needle: string) => s.indexOf(needle);
    expect(at("Couldn't read 1 folder (~/Desktop) because macOS")).toBe(0);
    expect(at("Couldn't read 1 folder (~/x) — check its permissions")).toBeGreaterThan(0);
    expect(at("Couldn't find 1 folder listed in Folders to search (/srv/y).")).toBeGreaterThan(at("check its permissions"));
    expect(s.split("Couldn't").length - 1).toBe(3);
  });

  test("the 'No repositories were found…' prefix appears only when noRepos", () => {
    const issues = [unreadable(`${HOME}/x`)];
    expect(discoverySummary(issues, { noRepos: true, home: HOME })!.startsWith("No repositories were found in Folders to search. Couldn't read")).toBe(true);
    expect(discoverySummary(issues, { noRepos: false, home: HOME })).not.toContain("No repositories");
  });

  test("paths under home use ~; other paths are shown as they are; home itself is ~", () => {
    const s = discoverySummary([unreadable(HOME), unreadable(`${HOME}/a`), unreadable("/Volumes/ext/b"), unreadable("/Users/meX/c")], { noRepos: false, home: HOME })!;
    expect(s).toContain("(~, ~/a, /Volumes/ext/b, and 1 more)");   // "/Users/meX" is not under "/Users/me"
  });

  test("a trailing separator is not shown: `~/Desktop/` is `~/Desktop`, home spelled `home/` is `~`", () => {
    expect(discoverySummary([unreadable(`${HOME}/Desktop/`)], { noRepos: false, home: HOME })).toContain("(~/Desktop) —");
    expect(discoverySummary([unreadable(`${HOME}/`)], { noRepos: false, home: HOME })).toContain("(~) —");
    expect(discoverySummary([unreadable(`${HOME}/`)], { noRepos: false, home: `${HOME}/` })).toContain("(~) —");
    expect(discoverySummary([unreadable("/Volumes/ext/b/")], { noRepos: false, home: HOME })).toContain("(/Volumes/ext/b) —");
  });

  test(`at most ${MAX_LABELS_PER_CLAUSE} folders are named per clause, then "and N more"`, () => {
    const five = ["a", "b", "c", "d", "e"].map((n) => unreadable(`${HOME}/${n}`));
    expect(discoverySummary(five, { noRepos: false, home: HOME })).toContain("Couldn't read 5 folders (~/a, ~/b, ~/c, and 2 more) — check their permissions — so repos in them may be missing.");
    const three = five.slice(0, 3);
    expect(discoverySummary(three, { noRepos: false, home: HOME })).toContain("(~/a, ~/b, ~/c) —");
  });
});

describe("hostile labels", () => {
  // Every posture marker word, all four sentinels, "didn't resolve", a newline, and markup.
  const HOSTILE = [...LABEL_DENYLIST, "work\ning directory", "a\nb", "<img src=x onerror=alert(1)>"];

  test("a label carrying deny-listed text is replaced; an ordinary one is not", () => {
    const s = discoverySummary([unreadable(`${HOME}/projects/working directory`)], { noRepos: false, home: HOME })!;
    expect(s).toContain(`(${HIDDEN_LABEL})`);
    expect(s).not.toContain("working directory");
    // Case-insensitive: the audit's own filter for the generator's warning is /didn't resolve…/i.
    expect(discoverySummary([unreadable(`${HOME}/Didn't Resolve`)], { noRepos: false, home: HOME })).toContain(HIDDEN_LABEL);
    expect(discoverySummary([unreadable(`${HOME}/ordinary`)], { noRepos: false, home: HOME })).not.toContain(HIDDEN_LABEL);
  });

  test("the full interpolated summary, in every clause, is never a posture or truncation warning, carries no sentinel and renders on one line", () => {
    const mk = [tcc, unreadable, notFound];
    for (const bad of HOSTILE) {
      for (const kind of mk) {
        const issue = kind(`${HOME}/${bad}`);
        for (const noRepos of [true, false]) {
          const s = discoverySummary([issue], { noRepos, home: HOME })!;
          const where = `${JSON.stringify(bad)} as ${issue.kind}`;
          expect(`${where}: posture=${isPostureWarning(s)} truncation=${isTruncationWarning(s)}`).toBe(`${where}: posture=false truncation=false`);
          for (const needle of [...SENTINELS, "didn't resolve"]) expect(`${where}: ${s.includes(needle)}`).toBe(`${where}: false`);
          expect(s).not.toContain("\n");
          // Rendered: the summary is exactly one `⚠` line of the briefing, and it is the whole summary.
          const md = renderBriefing({ date: "2026-10-03", machineScope: "m", provider: "p", resume: [], recap: [], suggestions: [], warnings: [s] });
          const warnLines = md.split("\n").filter((l) => l.startsWith("⚠ "));
          expect(warnLines).toEqual([`⚠ ${s}`]);
        }
      }
    }
    // And all of them at once, past the per-clause cap, in one summary.
    const all = discoverySummary(HOSTILE.map((b) => unreadable(`${HOME}/${b}`)), { noRepos: true, home: HOME })!;
    expect(isPostureWarning(all) || isTruncationWarning(all)).toBe(false);
  });
});

describe("⚠ LABEL_DENYLIST drift: the runtime mirror covers the eval vocabulary it shadows", () => {
  // Read as TEXT: POSTURE_MARKERS is a non-exported const, and runtime code may not import eval code.
  const src = readFileSync(new URL("../src/eval/posture.ts", import.meta.url), "utf8");

  test("every POSTURE_MARKERS entry and every exported sentinel is in LABEL_DENYLIST", () => {
    const block = /const POSTURE_MARKERS = \[([\s\S]*?)\] as const;/.exec(src)?.[1];
    expect(block).toBeDefined();
    // Comments first: the list's own comments quote "working directory" in prose.
    const code = block!.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const markers = [...new Set([...code.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!))];
    const sentinels = [...src.matchAll(/^export const (\w+_SENTINEL) = "([^"\n]*)";/gm)].map((m) => ({ name: m[1]!, value: m[2]! }));
    // Set AT the measured counts (2026-10-03), the policy test/posture.test.ts states for its own floors:
    // a parser that silently stops matching must fail here, not pass vacuously.
    expect(markers).toHaveLength(6);
    expect(sentinels.map((s) => s.name).sort()).toEqual(["API_CLEARTEXT_SENTINEL", "API_TRANSPORT_SENTINEL", "API_TRUNCATION_SENTINEL", "TRUNCATION_SENTINEL"]);
    // The text parse agrees with the real exported values (the parse is not reading something else).
    expect(sentinels.map((s) => s.value).sort()).toEqual([...SENTINELS].sort());
    for (const m of markers) expect(`${m}: ${isPostureWarning(m)}`).toBe(`${m}: true`);
    for (const needle of [...markers, ...sentinels.map((s) => s.value), "didn't resolve"]) {
      expect(`${needle}: ${LABEL_DENYLIST.includes(needle)}`).toBe(`${needle}: true`);
    }
  });
});

/* ── r9 (user-directed 2026-10-03, Q2 = D): recognising the summary, and its own ⚠ line ─────────────── */

describe("DISCOVERY_SUMMARY_LEADS / isDiscoverySummary: every summary is recognised, nothing else is", () => {
  test("the leads are the three the builder opens with, frozen", () => {
    expect(DISCOVERY_SUMMARY_LEADS).toEqual(["No repositories were found in Folders to search.", "Couldn't read ", "Couldn't find "]);
    expect(Object.isFrozen(DISCOVERY_SUMMARY_LEADS)).toBe(true);
  });

  test("PROPERTY: every summary the builder can produce passes isDiscoverySummary (raw and control-stripped), opening with the lead its first part implies", () => {
    // Every non-empty subset of the three counted kinds × noRepos × label shapes (one, past the cap, deny-listed,
    // lead-shaped, carrying a newline, empty) × both arrival orders.
    const makers: Record<string, (p: string) => PathIssue> = { "tcc-denied": tcc, unreadable, "not-found": notFound };
    const kinds = Object.keys(makers);
    const shapes = [["a"], ["a", "b", "c", "d"], ["working directory"], ["Couldn't read x"], ["a\nb"], [""]];
    let checked = 0;
    for (let mask = 1; mask < 1 << kinds.length; mask++) {
      const present = kinds.filter((_, i) => mask & (1 << i));
      for (const names of shapes) {
        for (const noRepos of [true, false]) {
          const issues = present.flatMap((k) => names.map((n) => makers[k]!(`${HOME}/${k}/${n}`)));
          for (const order of [issues, [...issues].reverse()]) {
            const s = discoverySummary(order, { noRepos, home: HOME });
            const lead = noRepos ? "No repositories were found in Folders to search."
              : present.some((k) => k !== "not-found") ? "Couldn't read " : "Couldn't find ";
            const where = `${present.join("+")} ${JSON.stringify(names)} noRepos=${noRepos}`;
            expect(`${where}: ${s !== undefined && s.startsWith(lead) && isDiscoverySummary(s) && isDiscoverySummary(stripControl(s))}`)
              .toBe(`${where}: true`);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(7 * 6 * 2 * 2);   // non-vacuity: the loops ran
  });

  test("an issue of a kind countedIssues never keeps yields NO summary — not an empty one, not a bare no-repos sentence", () => {
    expect(discoverySummary([notARepo(`${HOME}/file.txt`)], { noRepos: true, home: HOME })).toBeUndefined();
    expect(discoverySummary([notARepo(`${HOME}/file.txt`)], { noRepos: false, home: HOME })).toBeUndefined();
    // …and beside a counted kind, it changes nothing.
    expect(discoverySummary([notARepo(`${HOME}/f`), unreadable(`${HOME}/x`)], { noRepos: true, home: HOME }))
      .toBe("No repositories were found in Folders to search. Couldn't read 1 folder (~/x) — check its permissions — so repos in it may be missing.");
  });

  test("negatives: near-misses and every other warning shape are not summaries", () => {
    for (const w of [
      "",
      "couldn't read 1 folder (~/x)",                       // case matters: the builder's text, exactly
      " Couldn't read 1 folder (~/x)",                      // a lead, not a substring
      "Couldn't reach the network",
      "No repositories were found in Folders to search",    // no full stop
      // main.ts's blocked stderr line — a different sentence that shares the opening words
      "No repositories were found, and a folder listed in Folders to search could not be read or found — today NOT marked done. Fix access (see warnings above) and re-run.",
      ...API_NOTICE_TEXTS,
      'working-tree changed while generating: [app] was clean → now "M x.ts" — re-verify "Where you left off" before acting',
      '[settings] subprojects root "x" matched no directory — typo, or a project not scaffolded yet? Its commits will fall to the catch-all label.',
      "a real warning; Couldn't read 1 folder (~/x) — check its permissions — so repos in it may be missing.",
    ]) {
      expect(`${JSON.stringify(w)}: ${isDiscoverySummary(w)}`).toBe(`${JSON.stringify(w)}: false`);
    }
  });

  test("no other source in src/ opens a string with a lead — the summary is the only warning that can begin with one", () => {
    // A static scan for a string or template literal that BEGINS with a lead (a quote or backtick, then the
    // lead; the `\'` spelling too). It sees literals only: a warning assembled as `Couldn${x}` would slip by.
    // The warnings whose text opens with an interpolation were read by hand on 2026-10-03 (M2 checkpoint
    // fixer's report): a config value (`${cfg.cli} exited…`, `${this.label}: …`), a count, or a fixed
    // reduce note — none opens with repo-, filename- or CLI-output text.
    const SRC = new URL("../src/", import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(dir, e.name));
      }
    };
    walk(SRC);
    const opens = (text: string) =>
      [...new Set(DISCOVERY_SUMMARY_LEADS.flatMap((lead) => [lead, lead.replace("'", "\\'")]))]
        .flatMap((spelled) => ['"', "'", "`"].map((q) => q + spelled))
        .filter((needle) => text.includes(needle));
    const hits = files
      .filter((f) => !f.endsWith(`${sep}discoverySummary.ts`))
      .flatMap((f) => opens(readFileSync(f, "utf8")).map((n) => `${f.slice(SRC.length)}: ${n}`));
    expect(hits).toEqual([]);
    // Non-vacuity: the walk read the real tree, and the scan DOES see the builder's own leads.
    expect(files.length).toBeGreaterThan(50);
    expect(opens(readFileSync(join(SRC, "discoverySummary.ts"), "utf8"))).toHaveLength(3);
  });
});

describe("r9: the summary renders on its OWN ⚠ line, after the joined line of every other warning", () => {
  const S = discoverySummary([tcc(`${HOME}/Desktop`)], { noRepos: true, home: HOME })!;
  /** The briefing's lines after the "Suggested next" placeholder: the warnings block, then the footer. */
  const tail = (warnings: string[]): string[] => {
    const lines = renderBriefing({ date: "2026-10-03", machineScope: "m", provider: "p", resume: [], recap: [], suggestions: [], warnings }).split("\n");
    return lines.slice(lines.lastIndexOf("   (none)") + 1);
  };
  const FOOT = ["", "— generated via p"];

  test("alone: one blank line, then the summary's own line", () => {
    expect(tail([S])).toEqual(["", `⚠ ${S}`, ...FOOT]);
  });

  test("with other warnings: they keep the joined line, and the summary follows it — wherever it sat in the list", () => {
    expect(tail(["a", S, "b"])).toEqual(["", "⚠ a; b", `⚠ ${S}`, ...FOOT]);
    expect(tail([S, "a"])).toEqual(["", "⚠ a", `⚠ ${S}`, ...FOOT]);
  });

  test("with the API notice (§2.3): the notice is still left out, alone or beside an ordinary warning", () => {
    expect(tail([API_NOTICE_TEXTS[0]!, S])).toEqual(["", `⚠ ${S}`, ...FOOT]);
    expect(tail(["a", API_NOTICE_TEXTS[1]!, S])).toEqual(["", "⚠ a", `⚠ ${S}`, ...FOOT]);
  });

  test("nothing shown → no blank line and no ⚠ line, as before", () => {
    expect(tail([])).toEqual(FOOT);
    expect(tail([API_NOTICE_TEXTS[0]!])).toEqual(FOOT);
  });

  test("classified as DISPLAYED: a control byte before a lead still puts the element on its own (stripped) line", () => {
    const BEL = String.fromCharCode(7);
    expect(tail([`${BEL}${S}`, `x${BEL}\ny`])).toEqual(["", "⚠ xy", `⚠ ${S}`, ...FOOT]);
  });
});
