// test/render.golden.test.ts — the RENDER GOLDEN (tier B, T1.0). Every struct in
// `test/fixtures/render-corpus.ts` renders to the bytes frozen in `__snapshots__/render.golden.test.ts.snap`
// at the build's base (upstream code, no B). It is layer L1 of the dark-ship proof (plan §6): with
// `recapCampaigns.mode` off — the default — the page must be byte-identical to base, and this is the
// committed evidence that `renderBriefing` still is.
//
// Run under `CI=true` at every checkpoint (F-7 part d): a MISSING entry then fails instead of being
// silently written, and the corpus-size assertion means a dropped row cannot pass either. The `.snap`
// is held to the latest freeze commit by F-7 part (c); the corpus and this file to T1.0's by (a)–(b).
import { test, expect } from "bun:test";
import { renderBriefing } from "../src/render";
import { RENDER_CORPUS } from "./fixtures/render-corpus";

test("every render corpus struct renders its frozen bytes", () => {
  expect(RENDER_CORPUS.length).toBe(11);
  // Snapshot keys are `<test title>: <name> 1`, so names must be distinct or two rows share an entry.
  expect(new Set(RENDER_CORPUS.map((c) => c.name)).size).toBe(RENDER_CORPUS.length);
  for (const { name, struct } of RENDER_CORPUS) {
    expect(renderBriefing(struct)).toMatchSnapshot(name);
  }
});
