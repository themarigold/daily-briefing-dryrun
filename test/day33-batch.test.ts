// Day-33 decision batch (2026-08-18, user-directed): near-miss telemetry, twin dedupe,
// window merges, rename delete-half. One file so the batch's behaviour pins live together.
// IN-1 (Phase C, 2026-09-17) extends the twin dedupe to the window list; its pins live here too.
import "./fixtures/isolate-state";   // A0 — the IN-1 block calls runCore(), which falls back to supportDir() (test/isolation.meta.test.ts)
import { describe, expect, test } from "bun:test";
import { checkSuggestionRestatement, NEAR_MISS_FLOOR, RESTATEMENT_THRESHOLD } from "../src/postcheck";
import { chmodSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renamedFromOf, displayFile, runGit, patchIds } from "../src/git";
import { ANCESTRY_CHECK_CAP, dedupeTwins, gitActivity } from "../src/extractor";
import { activityLine } from "../src/generator";
import { renderBriefing } from "../src/render";
import { runCore } from "../src/core";
import { NOT_SHOWN_PREFIX } from "../src/subprojects";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import type { Activity, BriefingStruct, Config } from "../src/types";

// ── Near-miss telemetry (postcheck) ────────────────────────────────────────────────────────────
describe("suggestion-restates near-miss telemetry", () => {
  // The REAL day-33 pair, verbatim from briefings/2026-08-18.md — measured 0.423/11, under the
  // 0.45 threshold. It must surface as info telemetry, NOT as a finding.
  const sugg = [{ text: "Switch on the transcript layer in `daily_briefing_application` — the day-32 audit (`3da8804`) records it was never enabled, so `src/transcripts/discover.ts` and its restored old-self-prompt guard (`46159b3`) are likely still dormant in the real run path." }];
  const bullet = [{ repo: "daily_briefing_application", text: "You left off at the day-32 audit follow-up (`23a76d3`), which concluded `46159b3`'s HIGH was latent rather than live — so no incident to chase. The open observation from the same audit day is that the transcript layer was never switched on (`3da8804`), while `46159b3` fixed the guard `db22f09` had silently dropped for old self-prompts. Looks like the first-wake briefing rework (`db22f09`) is the live shape of the app now." }];

  test("day-33 pair emits info near-miss, not a finding", () => {
    const out = checkSuggestionRestatement(sugg, bullet);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("suggestion-restates-near");
    expect(out[0]!.info).toBe(true);
    expect(out[0]!.detail).toContain("0.42"); // the measured containment, so the log carries the number
  });

  test("a tripping pair is still a finding, not telemetry", () => {
    const dup = [{ text: "reconcile the editor setup interpreter still resolves per-sub-project settings workspace" }];
    const b = [{ repo: "quant_stocks", text: "reconcile the editor setup interpreter still resolves per-sub-project settings workspace gone" }];
    const out = checkSuggestionRestatement(dup, b);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("suggestion-restates");
    expect(out[0]!.info).toBeUndefined();
  });

  test("below the near-miss floor emits nothing", () => {
    const out = checkSuggestionRestatement(
      [{ text: "wire the verify script into whatever runs on commit continuous integration" }],
      [{ repo: "x", text: "completely unrelated prose about calendars and vaults and mornings" }],
    );
    expect(out).toHaveLength(0);
  });

  test("floor sits between noise and threshold", () => {
    expect(NEAR_MISS_FLOOR).toBeGreaterThan(0.143);
    expect(NEAR_MISS_FLOOR).toBeLessThan(RESTATEMENT_THRESHOLD);
  });
});

// ── Rename delete-half (defect C) ──────────────────────────────────────────────────────────────
describe("renamedFromOf", () => {
  test("plain rename keeps old side; displayFile keeps new", () => {
    const raw = "accountant_ai/scripts/verify-b2a.sh => accountant_ai/scripts/verify-safe-subset.sh";
    expect(renamedFromOf(raw)).toBe("accountant_ai/scripts/verify-b2a.sh");
    expect(displayFile(raw)).toBe("accountant_ai/scripts/verify-safe-subset.sh");
  });
  test("brace-collapsed rename (the real ff1622f row)", () => {
    const raw = "accountant_ai/scripts/{verify-b2a.sh => verify-safe-subset.sh}";
    expect(renamedFromOf(raw)).toBe("accountant_ai/scripts/verify-b2a.sh");
    expect(displayFile(raw)).toBe("accountant_ai/scripts/verify-safe-subset.sh");
  });
  test("intermediate-directory brace with suffix", () => {
    expect(renamedFromOf("src/{old => new}/f.ts")).toBe("src/old/f.ts");
  });
  test("non-rename returns undefined", () => {
    expect(renamedFromOf("src/main.ts")).toBeUndefined();
  });
});

describe("activityLine renders both rename sides", () => {
  const act: Activity = {
    source: "git", kind: "commit", event_id: "ff1622ff00", repo: "/r", timestamp: "2026-08-16T22:16:59-07:00",
    text: "repurpose the frozen relay verify script",
    meta: { diffstat: [{ file: "scripts/verify-safe-subset.sh", added: 8, removed: 1, renamedFrom: "scripts/verify-b2a.sh" }] },
  };
  test("evidence shows old → new", () => {
    expect(activityLine(act)).toContain("scripts/verify-b2a.sh → scripts/verify-safe-subset.sh");
  });
});

// ── Twin dedupe (defect E) ─────────────────────────────────────────────────────────────────────
describe("dedupeTwins", () => {
  const mk = (sha: string, subject: string, ts: string, repo = "/r"): Activity =>
    ({ source: "git", kind: "commit", event_id: sha, repo, timestamp: ts, text: subject });

  /** These are hand-built Activities in a repo that does not exist, so the real ancestry gate could
   *  only ever answer "unknown" (= keep both). `unrelated` is the divergent-histories answer a real
   *  rebase/cherry-pick pair gives — the case each of these tests is about. IN-1 round 1. */
  const unrelated = async () => false;

  test("patch-identical same-subject pair keeps the NEWER copy", async () => {
    const branch = mk("aaa", "fix: the barrier", "2026-08-18T02:36:00-07:00");
    const mainline = mk("bbb", "fix: the barrier", "2026-08-18T03:06:00-07:00");
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P1"]]);
    const out = await dedupeTwins([branch, mainline], ids, unrelated);
    expect(out.map((a) => a.event_id)).toEqual(["bbb"]);
  });

  test("ancestor-related copies are NOT twins: a do-revert-redo keeps both (IN-1 r1)", async () => {
    // Same subject, same patch-id — and a real pair of commits, because re-landing reverted work
    // reproduces the content exactly. `git patch-id` cannot tell this from a rebase copy; ancestry can.
    const original = mk("aaa", "feat: add b", "2026-08-18T01:00:00Z");
    const reland = mk("ccc", "feat: add b", "2026-08-18T03:00:00Z");
    const ids = async () => new Map([["aaa", "P1"], ["ccc", "P1"]]);
    expect(await dedupeTwins([original, reland], ids, async () => true)).toHaveLength(2);
  });

  test("an ancestry check that cannot answer keeps both (fail open on the gate)", async () => {
    const a = mk("aaa", "same", "2026-08-18T01:00:00Z");
    const b = mk("bbb", "same", "2026-08-18T02:00:00Z");
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P1"]]);
    expect(await dedupeTwins([a, b], ids, async () => undefined)).toHaveLength(2);   // git errored
    expect(await dedupeTwins([a, b], ids, async () => { throw new Error("git gone"); })).toHaveLength(2);
  });

  test("a throwing patchIds provider degrades to no dedupe, never to a thrown briefing", async () => {
    const a = mk("aaa", "same", "2026-08-18T01:00:00Z");
    const b = mk("bbb", "same", "2026-08-18T02:00:00Z");
    const ids = async () => { throw new Error("patch-id gone"); };
    expect(await dedupeTwins([a, b], ids, unrelated)).toHaveLength(2);
  });

  test("committer-date ties resolve deterministically (lexicographically smaller SHA survives)", async () => {
    const same = "2026-08-18T01:00:00Z";                       // `git am -C` / --committer-date-is-author-date
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P1"]]);
    expect((await dedupeTwins([mk("bbb", "s", same), mk("aaa", "s", same)], ids, unrelated)).map((a) => a.event_id))
      .toEqual(["aaa"]);
    expect((await dedupeTwins([mk("aaa", "s", same), mk("bbb", "s", same)], ids, unrelated)).map((a) => a.event_id))
      .toEqual(["aaa"]);                                       // same survivor whichever order they arrive in
  });

  test("the drop set is applied to COMMITS only, never to a same-id activity of another kind", async () => {
    const branch = mk("aaa", "fix: x", "2026-08-18T01:00:00Z");
    const mainline = mk("bbb", "fix: x", "2026-08-18T02:00:00Z");
    const other: Activity = { source: "claude-code", kind: "edit", event_id: "aaa", repo: "/r", timestamp: "2026-08-18T01:30:00Z" };
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P1"]]);
    const out = await dedupeTwins([branch, mainline, other], ids, unrelated);
    expect(out.map((a) => `${a.kind}:${a.event_id}`)).toEqual(["commit:bbb", "edit:aaa"]);
  });

  test("same subject but DIFFERENT patches both survive", async () => {
    const a = mk("aaa", "fix typo", "2026-08-18T01:00:00Z");
    const b = mk("bbb", "fix typo", "2026-08-18T02:00:00Z");
    const ids = async () => new Map([["aaa", "P1"], ["bbb", "P2"]]);
    expect(await dedupeTwins([a, b], ids)).toHaveLength(2);
  });

  test("fails open: unmapped SHAs are never dropped", async () => {
    const a = mk("aaa", "same", "2026-08-18T01:00:00Z");
    const b = mk("bbb", "same", "2026-08-18T02:00:00Z");
    const ids = async () => new Map<string, string>(); // patch-id failed entirely
    expect(await dedupeTwins([a, b], ids)).toHaveLength(2);
  });

  test("no subject collision → patchIds never called", async () => {
    let called = 0;
    const ids = async () => { called++; return new Map<string, string>(); };
    const out = await dedupeTwins([mk("aaa", "one", "2026-08-18T01:00:00Z"), mk("bbb", "two", "2026-08-18T02:00:00Z")], ids);
    expect(out).toHaveLength(2);
    expect(called).toBe(0);
  });

  test("same subject across DIFFERENT repos is not a twin group", async () => {
    let called = 0;
    const ids = async () => { called++; return new Map<string, string>(); };
    await dedupeTwins([mk("aaa", "same", "2026-08-18T01:00:00Z", "/r1"), mk("bbb", "same", "2026-08-18T02:00:00Z", "/r2")], ids);
    expect(called).toBe(0);
  });
});

// ── Window merges render (defect D) ────────────────────────────────────────────────────────────
describe("windowMerges rendering", () => {
  const base: BriefingStruct = {
    date: "2026-08-18", machineScope: "test", provider: "test",
    resume: [], suggestions: [{ text: "s" }],
    recap: [{ repo: "r", text: "did a thing", evidence: "abc1234" }],
    windowMerges: [{ repo: "personal_code", text: "🔀 Merged #241 (test/split-accuracy-gate) (Aug 17)  (21db663)" }],
  };
  // Since 2026-09-24 (S3b) the foot is ONE line per label — `🔀 1 PR merged (#241) (Aug 17)  (21db663)`
  // — collapsed at render time; the struct text above keeps the per-merge shape (see
  // test/merge-foot-collapse.test.ts for why).
  test("dated 🔀 line lands at the foot of What you did", () => {
    const out = renderBriefing(base);
    const lines = out.split("\n");
    const recapIdx = lines.findIndex((l) => l.includes("What you did"));
    const mergeIdx = lines.findIndex((l) => l.includes("#241"));
    const nextIdx = lines.findIndex((l) => l.includes("Suggested next"));
    expect(mergeIdx).toBeGreaterThan(recapIdx);
    expect(mergeIdx).toBeLessThan(nextIdx);
    expect(lines[mergeIdx]).toBe("   • [personal_code] 🔀 1 PR merged (#241) (Aug 17)  (21db663)");
  });
});

// ── Features echo (decision 3, 2026-08-18) ─────────────────────────────────────────────────────
import { featuresLine } from "../src/audit";
import { PROMPT_HEADER } from "../src/generator";
import { HISTORICAL_PROMPT_HEADERS, isSelfPrompt } from "../src/transcripts/discover";

describe("featuresLine", () => {
  test("enabled transcripts + subprojects + defaults render as on", () => {
    const line = featuresLine(
      { transcripts: { enabled: true }, subprojects: [{ repo: "/r", roots: ["a", "b"] }], provider: { timeoutMs: 300000 }, verdictPaths: ["gate/"] },
      { enabled: true, root: "/home/u/.claude/projects" },
    );
    expect(line).toContain("transcripts=on (root=/home/u/.claude/projects)");
    expect(line).toContain("subprojects=2 root(s)");
    expect(line).toContain("harden=on");
    expect(line).toContain("timeout=300s");
    expect(line).toContain("verdictPaths=on (gate)");   // IN-2
  });
  test("the day-29/32 failure shape renders LOUDLY as OFF", () => {
    const line = featuresLine({ provider: {} }, { enabled: false, root: "/x" });
    expect(line).toContain("transcripts=OFF");
    expect(line).toContain("subprojects=OFF (single-unit repos)");
    expect(line).toContain("timeout=120s"); // the default, stated rather than implied
    expect(line).toContain("verdictPaths=OFF"); // IN-2: the marker's default, stated rather than implied
  });
});

// ── The Daily-briefing rename's coupling guard (the db22f092 regression class) ─────────────────
describe("PROMPT_HEADER rename coupling", () => {
  test("every historical header is still recognised as a self-prompt", () => {
    for (const h of HISTORICAL_PROMPT_HEADERS) expect(isSelfPrompt(h + "\nGIT ACTIVITY: …")).toBe(true);
    expect(isSelfPrompt(PROMPT_HEADER + "\nGIT ACTIVITY: …")).toBe(true);
  });
  test("the pre-rename header (2026-08-17 spelling) is in the FROZEN list", () => {
    // The literal, not a derivation — if the rename had been done without growing the list, this fails.
    expect(HISTORICAL_PROMPT_HEADERS).toContain(
      "You are writing a developer's resumption-focused briefing from LOCAL GIT ACTIVITY on THIS machine only.",
    );
  });
  test("the current header carries the final name", () => {
    expect(PROMPT_HEADER).toContain("daily briefing");
  });
});

// ── Twin dedupe over the WINDOW list (IN-1, Phase C) ──────────────────────────────────────────────
// Lands under the stacked comparability boundary the user declared 2026-09-17 (EVAL.md, after row
// 63). Since day 33 `dedupeTwins` ran on the same-day list only, so a rebase copy's patch-identical
// twin still double-rendered in "What you did" (day 34: five pairs, 22 items for ~17 changes). These
// pins are FIXTURE-driven on purpose: the IN-3 Part-1 diagnosis measured 0/0/0/0 twins on days
// 49-52, so the change is a no-op on recent real history and only a constructed twin can show it.
describe("dedupeTwins over the WINDOW list (IN-1)", () => {
  const cfg: Config = { repos: [], excludeCommitPatterns: [], lookbackCapDays: 4, provider: { cli: "echo", argv: [], promptVia: "stdin" } };
  /** Local wall-clock, `daysAgo` days back at `hour`:00 — the window is local-midnight based. */
  const localAt = (daysAgo: number, hour: number): string => {
    const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.toISOString();
  };
  const commitShas = (acts: Activity[]) => acts.filter((a) => a.kind === "commit").map((a) => a.event_id);
  /** The day-34 shape: `fix: <name>` committed on a branch at t1, then cherry-picked onto main at t2 —
   *  same subject, same patch (same parent), a NEW sha, and the stale branch ref still walked by
   *  `--branches`. Returns [branchSha, mainSha]; the newer (main) copy is the one dedupe must keep. */
  async function twinPair(repo: string, name: string, t1: string, t2: string, subject = `fix: ${name}`): Promise<[string, string]> {
    await runGit(["checkout", "-q", "-b", `tw-${name}`], repo);
    const branchSha = await commitFiles(repo, [`${name}.txt`], { message: subject, isoDate: t1 });
    await runGit(["checkout", "-q", "main"], repo);
    const p = Bun.spawn(["git", "cherry-pick", `tw-${name}`], {
      cwd: repo, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_COMMITTER_DATE: t2 } as Record<string, string>,
    });
    await p.exited;
    if (p.exitCode !== 0) throw new Error(`cherry-pick: ${await new Response(p.stderr).text()}`);
    const mainSha = (await runGit(["rev-parse", "HEAD"], repo)).trim();
    expect(mainSha).not.toBe(branchSha);
    return [branchSha, mainSha];
  }

  test("a window-dated patch-identical pair collapses to the NEWER copy (real git patch-id)", async () => {
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]); // parent, out of window
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(1, 10), localAt(1, 11));
    const { activities, today } = await gitActivity(cfg, [repo]);
    expect(commitShas(activities)).toEqual([mainSha]);   // the rebase copy (newest committer date) survives
    expect(commitShas(activities)).not.toContain(branchSha);
    expect(today).toHaveLength(0);                       // nothing same-day: the collapse happened in the WINDOW list
  });

  test("the same-day path is unchanged: a today-dated pair still collapses in `today`, and only there", async () => {
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const baseSha = (await runGit(["rev-parse", "HEAD"], repo)).trim();
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(0, 10), localAt(0, 11));
    const { activities, today } = await gitActivity(cfg, [repo]);
    expect(commitShas(today)).toEqual([mainSha]);        // exactly the pre-IN-1 same-day behaviour
    expect(commitShas(today)).not.toContain(branchSha);
    expect(commitShas(activities)).toEqual([baseSha]);   // the window (2 days back, no same-day work) is untouched
  });

  test("scope is per list, as before: a window commit and its same-day rebase copy are NOT collapsed across lists", async () => {
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(1, 10), localAt(0, 10));
    const { activities, today } = await gitActivity(cfg, [repo]);
    expect(commitShas(activities)).toEqual([branchSha]); // yesterday's branch commit stays in the recap
    expect(commitShas(today)).toEqual([mainSha]);        // today's rebase copy stays in Today so far
  });

  test("fails open over the window list: an unmapped SHA is never dropped", async () => {
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(1, 10), localAt(1, 11));
    const both = [branchSha, mainSha].sort();
    // The `called` counters are load-bearing: without them this test passes with the dedupe call
    // REMOVED ALTOGETHER — it cannot tell "not dropped" from "never reached" (round-1 LOW-1).
    let failedCalls = 0, partialCalls = 0;
    const failed = await gitActivity(cfg, [repo], { patchIds: async () => { failedCalls++; return new Map(); } });
    expect(failedCalls).toBe(1);                       // patch-id failed entirely, over a real collision group
    expect(commitShas(failed.activities).sort()).toEqual(both);
    const partial = await gitActivity(cfg, [repo], {
      patchIds: async () => { partialCalls++; return new Map([[mainSha, "P1"]]); },                       // one of the pair unmapped
    });
    expect(partialCalls).toBe(1);
    expect(commitShas(partial.activities).sort()).toEqual(both);
  });

  test("fails open over the window list: an ancestry check that cannot answer never drops", async () => {
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(1, 10), localAt(1, 11));
    const both = [branchSha, mainSha].sort();
    let calls = 0;
    const r = await gitActivity(cfg, [repo], { ancestryRelated: async () => { calls++; return undefined; } });
    expect(calls).toBe(1);                             // real patch-id DID match the pair — the gate is what saved it
    expect(commitShas(r.activities).sort()).toEqual(both);
  });

  test("a do-revert-redo trio survives intact: same subject, same patch-id, ancestor-related (real git)", async () => {
    // The false positive the ancestry gate exists for. `git patch-id` fingerprints CONTENT, and
    // re-landing reverted work reproduces it byte for byte — so copies 1 and 3 collide on subject
    // AND on patch-id while being three genuinely distinct commits. Before the gate the ORIGINAL was
    // dropped: the recap then showed a revert of a commit absent from its own population, and
    // `windowCommits` read 2 where the day had 3.
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const add = await commitFiles(repo, ["b.txt"], { content: "bee", message: "feat: add b", isoDate: localAt(1, 9) });
    unlinkSync(join(repo, "b.txt"));
    const revert = await commitFiles(repo, [], { message: `Revert "feat: add b"`, isoDate: localAt(1, 10) });
    const reland = await commitFiles(repo, ["b.txt"], { content: "bee", message: "feat: add b", isoDate: localAt(1, 11) });
    // the premise: copies 1 and 3 really are patch-identical, so the gate (not the fingerprint) is what saves them
    const ids = await patchIds(repo, [add, revert, reland]);
    expect(ids.get(add)).toBe(ids.get(reland));
    expect(ids.get(revert)).not.toBe(ids.get(add));
    const { activities } = await gitActivity(cfg, [repo]);
    expect(commitShas(activities).sort()).toEqual([add, revert, reland].sort());
  });

  test("excluded commits still enter the collision set, and still collapse (pin, not endorsement)", async () => {
    // The `meta.excluded` tightening was PROPOSED and deferred to a user decision; lens-3 measured
    // that applying it left the whole suite green, i.e. the current behaviour was unpinned. This is
    // the pin: an excluded patch-identical pair IS fingerprinted (one batched call for the group)
    // and DOES collapse. Batching (round 1) made the cost of that a constant, which is why the
    // tightening is now moot rather than pending.
    const excl: Config = { ...cfg, excludeCommitPatterns: ["^vault backup:"] };
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const baseSha = (await runGit(["rev-parse", "HEAD"], repo)).trim();
    const [branchSha, mainSha] = await twinPair(repo, "vault", localAt(1, 10), localAt(1, 11), "vault backup: 2026-09-17 09:00");
    const calls: string[][] = [];
    const r = await gitActivity(excl, [repo], {
      patchIds: async (repoArg, shas) => { calls.push([...shas].sort()); return patchIds(repoArg, shas); },
    });
    expect(calls).toEqual([[branchSha, mainSha].sort()]);          // ONE batched call, the excluded pair in it
    // Survivor count: 1 of the 2 twins. `baseSha` is here as well — an EXCLUDED pair is filtered out
    // of `committerDaysWithCommits`' day set, so the window stretches PAST them to the last
    // non-excluded day instead of collapsing onto them (lens-2's measured correction, round 1).
    expect(commitShas(r.activities).sort()).toEqual([baseSha, mainSha].sort());
    expect(commitShas(r.activities)).not.toContain(branchSha);
    expect(r.activities.find((a) => a.event_id === mainSha)?.meta?.excluded).toBe(true);
  });

  test("cost bound holds over the window list: patch-ids only for subject collisions, never for the rest", async () => {
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(1, 9) }]); // in-window, unique subject
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(1, 10), localAt(1, 11));
    const calls: string[][] = [];
    await gitActivity(cfg, [repo], { patchIds: async (_repo, shas) => { calls.push([...shas].sort()); return new Map(); } });
    expect(calls).toEqual([[branchSha, mainSha].sort()]); // ONE group, exactly the colliding pair — the base commit never reaches git
    // and a window with no subject collision at all never spawns patch-id
    const quiet = await buildRepo([
      { file: "a.txt", content: "a", isoDate: localAt(1, 9) }, { file: "b.txt", content: "b", isoDate: localAt(1, 10) },
    ]);
    const quietCalls: string[][] = [];
    await gitActivity(cfg, [quiet], { patchIds: async (_repo, shas) => { quietCalls.push(shas); return new Map(); } });
    expect(quietCalls).toEqual([]);
    // and the gate is not paid on a no-collision window either: no candidate pair, no ancestry call
    let ancestry = 0;
    await gitActivity(cfg, [quiet], { ancestryRelated: async () => { ancestry++; return false; } });
    expect(ancestry).toBe(0);
  });

  test("patchIds spawns O(1) git processes per group, not O(N) (IN-1 r1 batching)", async () => {
    // The seam above pins how OFTEN patchIds is called; this pins what ONE call costs, which is the
    // 50x cliff round 1 removed (two spawns per SHA, sequentially). Counted with a PATH shim, which
    // Bun.spawn only honours for a CHILD process (see day36-deinversion.test.ts's shim note).
    const repo = await buildRepo(Array.from({ length: 6 }, (_, i) => (
      { file: `f${i}.txt`, content: `c${i}`, isoDate: localAt(1, 9) }
    )));
    const shas = (await runGit(["log", "--format=%H"], repo)).trim().split("\n");
    expect(shas).toHaveLength(6);
    const shimDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-in1-shim-")));
    const logFile = join(shimDir, "spawns.log");
    const realGit = (await Bun.$`which git`.text()).trim();
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(shimDir, "git"), 0o755);
    const gitTs = resolve(import.meta.dir, "../src/git.ts");
    const runInChild = async (batch: string[]): Promise<{ spawns: number; ids: Record<string, string> }> => {
      writeFileSync(logFile, "");
      const p = Bun.spawn(["bun", "-e", `
        const { patchIds } = await import(${JSON.stringify(gitTs)});
        const m = await patchIds(${JSON.stringify(repo)}, ${JSON.stringify(batch)});
        console.log(JSON.stringify(Object.fromEntries(m)));
      `], { cwd: import.meta.dir, env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
      await p.exited;
      expect(p.exitCode).toBe(0);
      const ids = JSON.parse((await new Response(p.stdout).text()).trim());
      const spawns = readFileSync(logFile, "utf8").split("\n").filter((l) => l.length > 0).length;
      return { spawns, ids };
    };
    const two = await runInChild(shas.slice(0, 2));
    const six = await runInChild(shas);
    expect(two.spawns).toBe(2);                                   // `git log ... | git patch-id` — and that is all
    expect(six.spawns).toBe(2);                                   // 3x the SHAs, the SAME spawn count
    expect(Object.keys(six.ids).sort()).toEqual([...shas].sort()); // every SHA still fingerprinted
    for (const sha of shas.slice(0, 2)) expect(six.ids[sha]).toBe(two.ids[sha]!); // batch size does not move an id
  });

  test("patchIds does not pipe the patch stream through this process (IN-1 r2 memory shape)", async () => {
    // Round 1 handed patch-id the log's stdout as `stdin: log.stdout` and this file's docstring
    // called it an OS-level pipe with flat memory. Measured false: Bun pumps such a stream THROUGH
    // THE PARENT with no backpressure, so a consumer slower than the producer (exactly patch-id vs
    // `log -p`) accumulates the difference in-process — ~3 MB of RSS per MB of patch stream, i.e.
    // O(whole collision group) with no cap on group size. The spool-to-a-tempfile form is flat.
    // This pins the SHAPE, not a number: RSS growth must be a small fraction of the added stream.
    const big = (s: number) => Array.from({ length: 20_000 }, (_, i) => `line ${s}-${i} ${"y".repeat(60)}`).join("\n");
    const N = 16;
    const repo = await buildRepo(Array.from({ length: N }, (_, i) => (
      { file: `big${i}.txt`, content: big(i), isoDate: localAt(1, 9) }
    )));
    const shas = (await runGit(["log", "--format=%H"], repo)).trim().split("\n");
    expect(shas).toHaveLength(N);
    const gitTs = resolve(import.meta.dir, "../src/git.ts");
    // Own process per measurement: RSS is a high-water mark and does not come back down, so two
    // batches in ONE process would report the larger for both.
    const rssAfter = async (batch: string[]): Promise<{ rss: number; size: number }> => {
      const p = Bun.spawn(["bun", "-e", `
        const { patchIds } = await import(${JSON.stringify(gitTs)});
        const m = await patchIds(${JSON.stringify(repo)}, ${JSON.stringify(batch)});
        console.log(JSON.stringify({ rss: process.memoryUsage.rss(), size: m.size }));
      `], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
      await p.exited;
      expect(p.exitCode).toBe(0);
      return JSON.parse((await new Response(p.stdout).text()).trim());
    };
    const small = await rssAfter(shas.slice(0, 2));
    const large = await rssAfter(shas);
    expect(small.size).toBe(2);
    expect(large.size).toBe(N);                               // every SHA still fingerprinted
    // Bytes of patch text the LARGE batch streams beyond the small one (each commit adds one file).
    const addedStream = big(0).length * (N - 2);
    // Round 1 grew by ~3x the added stream; spooling grows by ~0. A quarter of it is a wide margin
    // in both directions — this fails loudly if the OS-pipe form ever comes back.
    expect(large.rss - small.rss).toBeLessThan(addedStream * 0.25);
  }, 60_000);

  test("the ancestry gate is capped per collision group, and the cap keeps EVERYTHING (IN-1 r2)", async () => {
    // Checks are linear in the group (K-1 for K patch-identical copies) at ~15.6 ms each, paid again
    // by scripts/audit.ts — so an uncapped group of a few hundred revert-cycle copies adds ~10 s.
    // Over budget, the whole group is kept: the same fail-open direction as an unanswered question.
    const mk = (sha: string, mins: number): Activity => ({
      source: "git", kind: "commit", event_id: sha, repo: "/r", timestamp: localAt(1, 9 + mins / 60), text: "feat: same",
    } as Activity);
    const run = async (n: number) => {
      let calls = 0;
      const items = Array.from({ length: n }, (_, i) => mk(`s${String(i).padStart(3, "0")}`, i));
      const ids = async () => new Map(items.map((a) => [a.event_id, "P1"]));
      const kept = await dedupeTwins(items, ids, async () => { calls++; return false; });
      return { calls, kept: kept.length };
    };
    // Under budget: the feature still works — ANCESTRY_CHECK_CAP-1 candidates, all droppable.
    const under = await run(ANCESTRY_CHECK_CAP);
    expect(under.calls).toBe(ANCESTRY_CHECK_CAP - 1);
    expect(under.kept).toBe(1);                              // survivor only — dedupe happened
    // Over budget: checking stops AT the cap and the group is kept whole, including the copies
    // already decided droppable before the budget ran out.
    const over = await run(ANCESTRY_CHECK_CAP + 8);
    expect(over.calls).toBe(ANCESTRY_CHECK_CAP);             // never more than the cap
    expect(over.kept).toBe(ANCESTRY_CHECK_CAP + 8);          // nothing dropped at all
  });

  test("NAMED RESIDUAL pin: three copies with the stale one newest lose both real commits (IN-1 r2)", async () => {
    // The gate compares each candidate only against the CHOSEN SURVIVOR, never pairwise, so a
    // patch-id group is treated as one equivalence class when it is two. This asserts the CURRENT
    // (lossy) behaviour deliberately — documented in dedupeTwins' docstring as a bounded residual
    // that pre-dates IN-1 (the pre-IN-1 gate-less path drops the same two commits). If the survivor
    // rule is ever repaired, this test is the thing that must change, loudly rather than silently.
    const dated = async (repo: string, message: string, iso: string, body: string | null) => {
      if (body === null) unlinkSync(join(repo, "b.txt")); else await Bun.write(join(repo, "b.txt"), body);
      const p = Bun.spawn(["git", "add", "-A"], { cwd: repo, stdout: "ignore", stderr: "ignore" });
      await p.exited;
      const c = Bun.spawn(["git", "commit", "-q", "-m", message], {
        cwd: repo, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } as Record<string, string>,
      });
      await c.exited;
      if (c.exitCode !== 0) throw new Error(`commit: ${await new Response(c.stderr).text()}`);
      return (await runGit(["rev-parse", "HEAD"], repo)).trim();
    };
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]);
    const base = (await runGit(["rev-parse", "HEAD"], repo)).trim();
    const A = await dated(repo, "feat: add b", localAt(1, 7), "bee");          // the original — REAL
    await dated(repo, 'Revert "feat: add b"', localAt(1, 8), null);
    const C = await dated(repo, "feat: add b", localAt(1, 9), "bee");          // the re-land — REAL
    await runGit(["checkout", "-q", "-b", "stale", base], repo);               // a stale local branch…
    const A2 = await dated(repo, "feat: add b", localAt(1, 11), "bee");        // …committed LAST
    await runGit(["checkout", "-q", "main"], repo);
    // Premise first: all three really do share one patch-id, or the test proves nothing.
    const ids = await patchIds(repo, [A, C, A2]);
    expect(new Set([ids.get(A), ids.get(C), ids.get(A2)]).size).toBe(1);
    const kept = commitShas((await gitActivity(cfg, [repo])).activities);
    expect(kept).toContain(A2);      // the stale duplicate survives…
    expect(kept).not.toContain(A);   // …and BOTH real commits are dropped. This is the residual.
    expect(kept).not.toContain(C);
  }, 30_000);

  test("#424 reconciliation: the header, recapCoverage, the prompt and windowCommits all read the DEDUPED list", async () => {
    // The dedupe runs at gitActivity's RETURN, upstream of resolveUnits (windowCommits), reduce (the
    // prompt) and recapCoverage (the header's `total`). Before IN-1 this exact fixture rendered
    // "▶ What you did — 1 of 2 commits" plus a NOT-shown line naming the branch copy — a header that
    // disagreed with its own bullets by the number of twins, the day-49 shape #424 exists to expose.
    const repo = await buildRepo([{ file: "base.txt", content: "b", isoDate: localAt(2, 9) }]); // parent, out of window
    const [branchSha, mainSha] = await twinPair(repo, "barrier", localAt(1, 10), localAt(1, 11));
    const stub = { generate: async () => `## RESUME\n- [x] resume\n## RECAP\n- [x] fixed the barrier | evidence: ${mainSha.slice(0, 7)}\n## SUGGESTIONS\n- next` };
    const r = await runCore({ ...cfg, repos: [repo] }, { provider: stub, netProbe: async () => true });
    expect(r.ctx.repos.flatMap((x) => x.activities).filter((a) => a.kind === "commit").map((a) => a.event_id)).toEqual([mainSha]);
    expect(r.units.map((u) => u.windowCommits)).toEqual([1]);   // the S3 share denominator
    expect(r.struct.recapCoverage).toBeUndefined();              // one bullet covers the ONE in-window commit → absent
    const out = renderBriefing(r.struct);
    expect(out).toContain("▶ What you did — 1 commit\n");
    expect(out).not.toContain(NOT_SHOWN_PREFIX);
    expect(out).not.toContain(branchSha.slice(0, 7));
  });
});
