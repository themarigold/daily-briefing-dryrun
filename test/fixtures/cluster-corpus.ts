// test/fixtures/cluster-corpus.ts — the CLUSTER CORPUS (tier B, T1.0): hand-built
// `(recap, ctx, units, rootsByRepo)` inputs to `clusterRecap` whose outputs are frozen, as JSON, at the
// build's base by `test/cluster.golden.test.ts`. T1.2 extracts `resolveOne` out of `clusterRecap`
// (`resolveRecapEvidence`) and this golden is what proves the extraction moved nothing (plan §8 K1).
//
// One row per behaviour the plan names (plan §4 T1.0), each the shape an existing pin already drives —
// the goldens freeze BYTES, the pins say WHY; both are cited so a red here can be read:
//   · a file cluster, with the day-53 denominator            (test/day53-cluster-churn.test.ts:26)
//   · a tier-2 campaign-key merge of two file clusters       (test/in3-campaign-keys.test.ts:507)
//   · a tier-3 (leading-phrase) campaign-key merge           (the same mechanism, `phrase:` key)
//   · a one-atom campaign reverting to its file cluster      (generator.ts, "gathered exactly ONE atom")
//   · a `readsAsSameDaySha` refusal                          (generator.ts:1072; in3 round 4)
//   · a one-name-per-bracket dissolve                        (test/in3-campaign-keys.test.ts:341)
//   · an unresolved bullet                                   (test/day36-deinversion.test.ts:61)
//   · an ambiguous first cite                                (test/cluster-resolver-alldigit.test.ts:171)
//   · an all-digit abbreviation                              (test/cluster-resolver-alldigit.test.ts:40)
//   · a zero-hit (branch-tip) token, then a resolving one    (test/cluster-resolver-alldigit.test.ts:189)
//   · a cross-label split, git's denominator kept            (test/in3-campaign-keys.test.ts:284)
//
// Dates: `bun test` runs in UTC (plan §1), so a `-07:00` stamp at 10:00 is the same calendar day in
// `shortDate`'s `en-US` output locally and in CI.
//
// ⚠ FROZEN. Held to the freeze commit by F-7 (plan §10) exactly as `render-corpus.ts` is.
import type { Activity, BriefingStruct, ReducedContext } from "../../src/types";
import type { Unit } from "../../src/subprojects";

type Row = { file: string; added: number; removed: number };
type Entry = BriefingStruct["recap"][number];

export type ClusterCase = {
  name: string;
  recap: Entry[];
  ctx: ReducedContext;
  units?: Unit[];
  rootsByRepo?: Map<string, string[]>;
};

const d2 = "2026-09-02T10:00:00-07:00", d3 = "2026-09-03T10:00:00-07:00", d4 = "2026-09-04T10:00:00-07:00", d6 = "2026-09-06T10:00:00-07:00";
/** Full 40-char ids, so a 7-char cite is a PREFIX of the id and prefix semantics are the real ones. */
const full = (prefix: string): string => (prefix + "0123456789abcdef0123456789abcdef01234567").slice(0, 40);
const row = (file: string, churn = 10): Row => ({ file, added: churn, removed: 0 });
const commit = (sha: string, subject: string, diffstat: Row[], iso = d4, repo = "/r"): Activity =>
  ({ source: "git", kind: "commit", event_id: full(sha), repo, timestamp: iso, text: subject, meta: { diffstat } });
const ctxOf = (acts: Activity[], repo = "/r"): ReducedContext => ({ repos: [{ repo, summary: "", activities: acts }] });
const bullets = (lane: string, acts: Activity[]): Entry[] => acts.map((a) => ({ repo: lane, text: `prose ${a.event_id!.slice(0, 7)}`, evidence: a.event_id!.slice(0, 7) }));

const fileCluster = (() => {
  const acts = [
    commit("aaaa111", "c-aaaa111", [{ file: "dup.py", added: 30, removed: 2 }], d6),
    commit("bbbb222", "c-bbbb222", [{ file: "dup.py", added: 20, removed: 1 }], d6),
    commit("cccc333", "c-cccc333", [{ file: "router.py", added: 90, removed: 0 }, { file: "dup.py", added: 3, removed: 0 }], d6),
    commit("dddd444", "c-dddd444", [{ file: "ledger.py", added: 80, removed: 0 }, { file: "dup.py", added: 2, removed: 0 }], d6),
    commit("eeee555", "c-eeee555", [{ file: "match.py", added: 70, removed: 0 }, { file: "dup.py", added: 1, removed: 0 }], d6),
  ];
  return { recap: bullets("app", acts), ctx: ctxOf(acts) };
})();

const tier2Merge = (() => {
  const acts = [
    commit("aaaa111", "feat: M7.5a agent loop hardening", [row("agent/loop.py", 30)], d2),
    commit("bbbb222", "fix: M7.5a loop retry", [row("agent/loop.py", 20)], d3),
    commit("cccc333", "feat: M7.5a spike runner", [row("agent/spike_run.py", 30)], d2),
    commit("dddd444", "fix: M7.5a spike runner budget", [row("agent/spike_run.py", 20)], d3),
  ];
  return { recap: bullets("accountant_ai", acts), ctx: ctxOf(acts) };
})();

const tier3Merge = (() => {
  const acts = [
    commit("aaaa111", "feat(accountant_ai): provider seam for the loop", [row("llm/provider.py", 30)]),
    commit("bbbb222", "fix(accountant_ai): provider seam retries", [row("llm/provider.py", 20)]),
    commit("cccc333", "feat(accountant_ai): Provider seam in the spike runner", [row("agent/spike_run.py", 30)]),
    commit("dddd444", "fix(accountant_ai): provider seam budget in the runner", [row("agent/spike_run.py", 20)]),
  ];
  return { recap: bullets("accountant_ai", acts), ctx: ctxOf(acts) };
})();

const oneAtomReverts = (() => {
  const acts = [
    commit("aaaa111", "feat: M8 context assembly", [row("agent/context.py", 30)]),
    commit("bbbb222", "fix: M8 context window bounds", [row("agent/context.py", 20)]),
    commit("cccc333", "chore: bump the lockfile", [row("bun.lock")]),
  ];
  return { recap: bullets("accountant_ai", acts), ctx: ctxOf(acts) };
})();

const sameDayShaRefusal = (() => {
  // `rev 4760499` keys tier 2 (`revn`) on all four; the label carries a 7-hex run the same-day scan
  // would read, so the campaign dissolves to its two file clusters.
  const acts = [
    commit("aaaa111", "feat: rev 4760499 ledger contract", [row("core/ledger.py", 30)]),
    commit("bbbb222", "fix: rev 4760499 ledger rounding", [row("core/ledger.py", 20)]),
    commit("cccc333", "feat: rev 4760499 export path", [row("core/export.py", 30)]),
    commit("dddd444", "fix: rev 4760499 export budget", [row("core/export.py", 20)]),
  ];
  return { recap: bullets("accountant_ai", acts), ctx: ctxOf(acts) };
})();

const oneNamePerBracket = (() => {
  // `rev 13` (tier 2) and `rev-13 …` (tier 3, the hyphen defeats `revn`) print ONE name in one bracket:
  // both dissolve, and with one file per commit nothing is left grouped.
  const acts = [
    commit("aaaa111", "feat: rev 13 ledger contract", [row("core/ledger.py")]),
    commit("bbbb222", "fix: rev 13 rounding", [row("core/rounding.py")]),
    commit("cccc333", "feat: rev-13 export path", [row("core/export.py")]),
    commit("dddd444", "fix: rev-13 import path", [row("core/import.py")]),
  ];
  return { recap: bullets("accountant_ai", acts), ctx: ctxOf(acts) };
})();

const unresolved = (() => {
  const acts = [
    commit("aaaa111", "c-aaaa111", [row("f.ts")], d3),
    commit("bbbb222", "c-bbbb222", [row("f.ts")], d3),
  ];
  return {
    recap: [
      { repo: "app", text: "no evidence at all" },
      { repo: "app", text: "evidence naming no commit in the window", evidence: "9f9f9f9" },
      { repo: "app", text: "one", evidence: "aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ] as Entry[],
    ctx: ctxOf(acts),
  };
})();

const ambiguousFirstCite = (() => {
  const acts = [commit("abc1234dead", "c-1", [row("f.ts")], d3), commit("abc1234feed", "c-2", [row("g.ts")], d3), commit("cccc333", "c-3", [row("f.ts")], d3)];
  return {
    recap: [
      { repo: "app", text: "ambiguous then unique", evidence: "abc1234, cccc333" },
      { repo: "app", text: "unique", evidence: "cccc333" },
      { repo: "app", text: "unique too", evidence: "abc1234d" },
    ] as Entry[],
    ctx: ctxOf(acts),
  };
})();

const allDigit = (() => {
  const acts = [
    commit("3316617", "c-1", [row("agent/loop.py")], d3), commit("aaaa111", "c-2", [row("agent/loop.py")], d3),
    commit("7343129", "c-3", [row("agent/spike_run.py")], d3), commit("cccc333", "c-4", [row("agent/spike_run.py")], d3),
    commit("bbbb222", "c-5", [row("other.py")], d3),
  ];
  return {
    recap: [
      { repo: "app", text: "one", evidence: "3316617" },
      { repo: "app", text: "two", evidence: "aaaa111" },
      { repo: "app", text: "three", evidence: "`7343129` (Sep 3)" },
      { repo: "app", text: "four", evidence: "cccc333" },
      { repo: "app", text: "five", evidence: "bbbb222" },
    ] as Entry[],
    ctx: ctxOf(acts),
  };
})();

const zeroHitThenResolving = (() => {
  const ctx: ReducedContext = { repos: [{ repo: "/r", summary: "", activities: [
    commit("aaaa111", "c-1", [row("f.ts")], d3), commit("bbbb222", "c-2", [row("f.ts")], d3),
    { source: "git", kind: "branch", event_id: "br-1", repo: "/r", timestamp: d3, text: "feat/auth", meta: { tip: full("eeee555") } },
  ] }] };
  return {
    recap: [
      { repo: "app", text: "branch tip first, then the real sha", evidence: "eeee555, aaaa111" },
      { repo: "app", text: "two", evidence: "bbbb222" },
    ] as Entry[],
    ctx,
  };
})();

const crossLabelSplit = (() => {
  const m8 = (sha: string, f: string) => commit(sha, `fix(accountant_ai): M8 ${f}`, [row(`accountant_ai/agent/${f}.py`)]);
  const acts = [m8("aaaa111", "context"), m8("bbbb222", "provenance"), m8("cccc333", "replay")];
  return {
    recap: [
      { repo: "accountant_ai", text: "a", evidence: "aaaa111" },
      { repo: "accountant_ai", text: "b", evidence: "bbbb222" },
      { repo: "Accountant AI", text: "c", evidence: "cccc333" },
    ] as Entry[],
    ctx: ctxOf(acts),
    units: [] as Unit[],
    rootsByRepo: new Map([["/r", ["accountant_ai", "quant_stocks"]]]),
  };
})();

export const CLUSTER_CORPUS: readonly ClusterCase[] = [
  { name: "file cluster with the day-53 denominator", ...fileCluster },
  { name: "tier-2 campaign key merges two file clusters", ...tier2Merge },
  { name: "tier-3 phrase key merges two file clusters", ...tier3Merge },
  { name: "one-atom campaign reverts to its file cluster", ...oneAtomReverts },
  { name: "readsAsSameDaySha refusal dissolves the campaign", ...sameDayShaRefusal },
  { name: "one name per bracket dissolves tier-2 and tier-3 twins", ...oneNamePerBracket },
  { name: "unresolved bullets stay flat beside a real cluster", ...unresolved },
  { name: "an ambiguous first cite ends the scan", ...ambiguousFirstCite },
  { name: "an all-digit abbreviation resolves", ...allDigit },
  { name: "a zero-hit branch-tip token, then a resolving one", ...zeroHitThenResolving },
  { name: "a cross-label split keeps git's denominator", ...crossLabelSplit },
];
