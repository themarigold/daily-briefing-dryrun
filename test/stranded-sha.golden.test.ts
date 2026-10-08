// test/stranded-sha.golden.test.ts — the STRANDED-SHA NEAR-MISS GOLDEN (T0.3). `generateBriefing`, called
// with fixed arguments (a fixed `ctx` holding two commits, a fake provider returning one fixed text, a
// fixed META and units), returns a struct frozen as JSON in `__snapshots__/stranded-sha.golden.test.ts.snap`.
// The text's RECAP holds only near-miss inputs: tails that border the date-tagged pipe-less shape seen in
// a 2026-10-06 `day8-tie` eval capture (`… — evidence: <sha> (Oct 5)`) without matching it, plus a bullet
// that opens with a bare SHA and one that cites nothing. Every one of the seven keeps its SHA in the text
// both before the date-tag rule and after it, so this struct must not move when the rule lands; it is the
// committed evidence that the rule touches nothing outside its shape. Both commits are the ones the
// near-misses name, so a near-miss wrongly split would also move `recapCoverage`, not just `evidence`.
//
// Frozen from the build's base commit, before the date-tag rule (T0.3); any refreeze re-captures from that
// base. Same guard as the render and cluster goldens: every later run carries `CI=true`, so a missing entry
// fails instead of being silently written; the input count is pinned; this file and its `.snap` are held to
// the latest freeze commit. Deterministic by construction: fixed timestamps, no clock, hostname or random
// input (`runCore`'s envelope is not used, since it carries the hostname and the run date).
import { test, expect } from "bun:test";
import { generateBriefing } from "../src/generator";
import type { Activity, Provider, ReducedContext } from "../src/types";
import type { Unit } from "../src/subprojects";

const META = { date: "2026-10-06", machineScope: "host", provider: "fake" };
const at = "2026-10-05T10:00:00-07:00";
/** Full 40-char ids, so a 7-char cite is a PREFIX of the id and prefix semantics are the real ones. */
const full = (prefix: string): string => (prefix + "0123456789abcdef0123456789abcdef01234567").slice(0, 40);
const commit = (sha: string, file: string): Activity => ({
  source: "git", kind: "commit", event_id: full(sha), repo: "/r", timestamp: at, text: `c-${sha}`,
  meta: { diffstat: [{ file, added: 5, removed: 1 }] },
});
const CTX: ReducedContext = { repos: [{ repo: "/r", summary: "s", activities: [
  commit("d08ee51", "src/a.ts"),
  commit("abc1234", "src/b.ts"),
] }] };
const UNITS: Unit[] = [{ repo: "/r", root: null, label: "repo", hasResumptionState: false,
  hasWindowContent: true, resumptionNote: "", dirtyFiles: [], latestCommitTime: null }];

// One bullet per near-miss, in this order:
const NEAR_MISS = [
  "[repo] Retry loop bounded — evidence: d08ee51 (see log)",          // a non-date parenthetical
  "[repo] Config loader reads defaults — evidence: d08ee51 (Sept 4)", // a four-letter month
  "[repo] Cache key normalised — evidence: d08ee51(Oct 4)",           // a tag glued to the SHA
  "[repo] Two parser fixes landed — evidence: abc1234, def5678 (Oct 5)", // two SHAs before the tag
  "[repo] Join order corrected — evidence: abc(1234) (Oct 5)",        // a parenthesis inside the token
  "[repo] abc1234 — Fixed the join",                                  // a leading bare SHA, no `evidence:`
  "[repo] Readme wording tidied",                                     // uncited
];
const TEXT = `## RECAP\n${NEAR_MISS.map((l) => `- ${l}`).join("\n")}`;

test("near-miss recap inputs produce the frozen struct through generateBriefing", async () => {
  expect(NEAR_MISS.length).toBe(7);
  const provider: Provider = { generate: async () => TEXT };
  const struct = await generateBriefing(CTX, provider, META, UNITS);
  expect(JSON.stringify(struct, null, 2)).toMatchSnapshot("near-miss recap inputs");
});
