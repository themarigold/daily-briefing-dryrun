// test/cluster.golden.test.ts — the CLUSTER GOLDEN (tier B, T1.0). Every input in
// `test/fixtures/cluster-corpus.ts` clusters to the JSON frozen in `__snapshots__/cluster.golden.test.ts.snap`
// at the build's base. T1.2 moves `resolveOne` out of `clusterRecap` (`resolveRecapEvidence`) and this is
// the committed evidence the move changed no Stage-1 outcome (plan §8 K1); `off` mode never reaches
// anything else in the generator.
//
// Same guard as the render golden: `CI=true` at every checkpoint (F-7 part d), the corpus size pinned,
// the `.snap` held to the latest freeze commit and this file to T1.0's.
import { test, expect } from "bun:test";
import { clusterRecap } from "../src/generator";
import { CLUSTER_CORPUS } from "./fixtures/cluster-corpus";

test("every cluster corpus input clusters to its frozen output", () => {
  expect(CLUSTER_CORPUS.length).toBe(11);
  expect(new Set(CLUSTER_CORPUS.map((c) => c.name)).size).toBe(CLUSTER_CORPUS.length);
  for (const { name, recap, ctx, units, rootsByRepo } of CLUSTER_CORPUS) {
    const out = clusterRecap(recap, ctx, units, rootsByRepo);
    expect(JSON.stringify(out, null, 2)).toMatchSnapshot(name);
  }
});
