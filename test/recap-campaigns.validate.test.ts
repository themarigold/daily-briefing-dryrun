// test/recap-campaigns.validate.test.ts — tier B, T1.4: the reply parser (§4.5) and validation (§4.6).
// Cases V1–V13 of spec §5.2 (plan §7). Every rule is evaluated on every campaign (D3), so a rule is
// pinned by asserting its D4 name is CONTAINED in — or absent from — the dropped campaign's `reasons`.
// Last block (M1 checkpoint fix): the commit population the offered ids come from (§4.3).
import { test, expect, describe } from "bun:test";
import {
  buildCampaignItems, parseCampaignReply, validateCampaigns, failingTitleRules, labelUniverse, scoreReply,
  TITLE_STOPWORDS, REPLY_MAX_BYTES, type CampaignItem, type CampaignReply, type CoverageUnits, type DropReason, type ValidationResult,
} from "../src/recapCampaigns";
import { MORNING_STRUCT, MORNING_RECAP, MORNING_COMMITS, MORNING_LABELS, A, B, C, D, full } from "./fixtures/campaign-morning";
import type { Activity } from "../src/types";

const ITEMS = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);
const LABELS = labelUniverse(MORNING_LABELS, ["personal_code"]);
const reply = (...campaigns: { title: string; items: string[] }[]): CampaignReply => ({ campaigns });
/** The reasons of the ONE campaign in a one-campaign reply, or [] when it was kept. */
const reasonsOf = (title: string, ids: string[]): DropReason[] => {
  const v = validateCampaigns(reply({ title, items: ids }), ITEMS, MORNING_RECAP, LABELS);
  if (!v.ok) throw new Error(`whole-reply ${v.reason}`);
  return v.dropped[0]?.reasons ?? [];
};
const rules = (title: string, ids = ["G1", "G2"]) => failingTitleRules(title, ids.map((id) => ITEMS.find((i) => i.id === id)!), MORNING_RECAP, LABELS);

describe("the reply parser (§4.5) and the whole-reply checks (§4.6)", () => {
  test("[TB-V13] schema key order is free — both orders valid; an extra or a missing key is `schema`", () => {
    expect(parseCampaignReply('{"campaigns":[{"title":"retry backoff","items":["G1","G2"]}]}')).toEqual({ ok: true, reply: reply({ title: "retry backoff", items: ["G1", "G2"] }) });
    expect(parseCampaignReply('{"campaigns":[{"items":["G1","G2"],"title":"retry backoff"}]}')).toEqual({ ok: true, reply: reply({ title: "retry backoff", items: ["G1", "G2"] }) });
    expect(parseCampaignReply('{"campaigns":[{"title":"x","items":["G1"],"note":"extra"}]}')).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply('{"campaigns":[{"title":"x"}]}')).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply('{"campaigns":[],"extra":1}')).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply('{"campaign":[]}')).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply('{"campaigns":[{"title":1,"items":["G1"]}]}')).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply('{"campaigns":[{"title":"x","items":[1]}]}')).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply('{"campaigns":{}}')).toEqual({ ok: false, reason: "schema" });
  });

  test("bare or single-fenced objects parse; prose, a second fence, invalid JSON, an array are `unparseable`; 16 384 bytes is the edge of `oversize`", () => {
    const obj = '{"campaigns":[]}';
    expect(parseCampaignReply(obj).ok).toBe(true);
    expect(parseCampaignReply(`  \n${obj}\n\n`).ok).toBe(true);
    expect(parseCampaignReply("```json\n" + obj + "\n```").ok).toBe(true);
    expect(parseCampaignReply("```\n" + obj + "\n```").ok).toBe(true);
    expect(parseCampaignReply(`Here you go: ${obj}`)).toEqual({ ok: false, reason: "unparseable" });
    expect(parseCampaignReply(`${obj} — done`)).toEqual({ ok: false, reason: "unparseable" });
    expect(parseCampaignReply("```json\n" + obj + "\n```\n```json\n" + obj + "\n```")).toEqual({ ok: false, reason: "unparseable" });
    expect(parseCampaignReply("sure:\n```json\n" + obj + "\n```")).toEqual({ ok: false, reason: "unparseable" });
    expect(parseCampaignReply('{"campaigns":[')).toEqual({ ok: false, reason: "unparseable" });
    expect(parseCampaignReply("[]")).toEqual({ ok: false, reason: "unparseable" });
    expect(parseCampaignReply("")).toEqual({ ok: false, reason: "unparseable" });
    // D5: UTF-8 BYTES, not characters. A 16 384-byte reply passes; one more byte is oversize; a
    // multi-byte character counts its bytes.
    const pad = (n: number) => `{"campaigns":[],"x":"${"a".repeat(n)}"}`;   // schema-invalid, but the size check runs first
    const base = Buffer.byteLength(pad(0), "utf8");
    expect(parseCampaignReply(pad(REPLY_MAX_BYTES - base))).toEqual({ ok: false, reason: "schema" });
    expect(parseCampaignReply(pad(REPLY_MAX_BYTES - base + 1))).toEqual({ ok: false, reason: "oversize" });
    const multi = `{"campaigns":[],"x":"${"é".repeat((REPLY_MAX_BYTES - base) / 2 + 1)}"}`;   // 2 bytes each → over
    expect(parseCampaignReply(multi)).toEqual({ ok: false, reason: "oversize" });
  });

  test("an id not offered is `unknown-id`; an id used twice is `duplicate-id` — whole-reply, checked before any rule", () => {
    expect(validateCampaigns(reply({ title: "retry backoff", items: ["G1", "G9"] }), ITEMS, MORNING_RECAP, LABELS)).toEqual({ ok: false, reason: "unknown-id", reasons: ["unknown-id"] });
    expect(validateCampaigns(reply({ title: "retry backoff", items: ["G1", "G2"] }, { title: "retry backoff also landed here", items: ["G2", "G7"] }), ITEMS, MORNING_RECAP, LABELS)).toEqual({ ok: false, reason: "duplicate-id", reasons: ["duplicate-id"] });
    // An accepted reply with no campaigns is not a rejection: nothing kept, nothing dropped, proposed 0.
    expect(validateCampaigns(reply(), ITEMS, MORNING_RECAP, LABELS)).toEqual({ ok: true, kept: [], dropped: [], proposed: 0 });
  });

  test("both whole-reply faults in one reply: `unknown-id` then `duplicate-id`, BOTH recorded (D3) in §4.6's order, whichever campaign carries which", () => {
    // Each check runs over the WHOLE reply, unknown-id first. A per-id walk in reply order reported
    // whichever fault came first — `unknown-id` for [G9],[G1,G1] but `duplicate-id` for [G1,G1],[G9].
    const both: ValidationResult = { ok: false, reason: "unknown-id", reasons: ["unknown-id", "duplicate-id"] };
    expect(validateCampaigns(reply({ title: "retry backoff", items: ["G9"] }, { title: "retry backoff", items: ["G1", "G1"] }), ITEMS, MORNING_RECAP, LABELS)).toEqual(both);
    expect(validateCampaigns(reply({ title: "retry backoff", items: ["G1", "G1"] }, { title: "retry backoff", items: ["G9"] }), ITEMS, MORNING_RECAP, LABELS)).toEqual(both);
  });
});

describe("the title rules (§4.6), each with a passing and a failing case", () => {
  test("[TB-V1] rule 1, verbatim span under the engine's word boundary: `retry backoff` passes; `backoff retry` and `etry backof` fail", () => {
    expect(rules("retry backoff")).not.toContain(1);
    expect(rules("backoff retry")).toContain(1);
    expect(rules("etry backof")).toContain(1);           // inside a word: no boundary, not verbatim
    expect(rules("Retry Backoff")).toContain(1);         // case-sensitive
    expect(reasonsOf("retry backoff", ["G1", "G2"])).toEqual([]);
    expect(reasonsOf("backoff retry", ["G1", "G2"])).toContain("title-rule-1");
  });

  test("[TB-V2] rule 2, 3–48 code points: `py` and a 49-char title fail; 3 and 48 pass; EVERY failing rule is listed (D3)", () => {
    expect(rules("py")).toContain(2);
    expect(rules("x".repeat(49))).toContain(2);
    expect(rules("abc")).not.toContain(2);
    expect(rules("x".repeat(48))).not.toContain(2);
    // code points, not UTF-16 units: three astral characters are 3 code points (6 units) — rule 2 passes
    expect(rules("😀😀😀")).not.toContain(2);
    expect(rules("😀😀")).toContain(2);
    // D3, the contains-case: `zz` fails rule 1 AND rule 2, and BOTH are recorded — not the first only.
    // (It passes rule 7: a letter that is no stopword carries meaning, however short.)
    const r = reasonsOf("zz", ["G1", "G2"]);
    expect(r).toContain("title-rule-1");
    expect(r).toContain("title-rule-2");
    expect(r).not.toContain("title-rule-7");
    expect(r).toEqual(["title-rule-1", "title-rule-2"]);
  });

  test("[TB-V3] rule 3, no ( ) [ ] or em-dash: `retry backoff (added)` and `retry — backoff` fail", () => {
    expect(rules("retry backoff (added)")).toContain(3);
    expect(rules("retry — backoff")).toContain(3);
    expect(rules("retry [backoff]")).toContain(3);
    expect(rules("retry backoff")).not.toContain(3);
    expect(rules("retry backoff - added")).not.toContain(3);   // a hyphen is not an em-dash
  });

  test("[TB-V4] rule 4, no 7-hex window: `defaced` fails, `deadbeef1 landed` fails, `retry backoff` passes", () => {
    expect(rules("defaced")).toContain(4);
    expect(rules("deadbeef1 landed", ["G4", "G2"])).toContain(4);
    expect(rules("retry backoff")).not.toContain(4);
    expect(rules("cafe f00d")).not.toContain(4);        // 4 + 4, no 7-run
  });

  test("[TB-V5] rule 5, no configured label: `accountant_ai queue continued` fails; the label universe is deduplicated", () => {
    expect(rules("accountant_ai queue continued", ["G5", "G2"])).toContain(5);
    expect(rules("Quant_Stocks guard", ["G3", "G2"])).toContain(5);       // lower-cased on both sides
    expect(rules("retry backoff")).not.toContain(5);
    expect(rules("accountant_aix queue", ["G5", "G2"])).not.toContain(5);  // boundary: not a label
    expect(labelUniverse(["a", "b", " a "], ["b", "", "c"])).toEqual(["a", "b", "c"]);
  });

  test("rule 5 reads the coverage rows' labels only: a row's repo is not a configured label", () => {
    // `scoreReply` builds rule 5's universe from check (c)'s rows. §4.6 defines it as every resolved unit
    // label and repo label — the rows' `labels`; a row's `repo` is its identity for `coverageGaps`, not a
    // label. A row whose `repo` spells a title word (`backoff`) must not widen the universe and refuse
    // the title; the same word as a LABEL does.
    const text = JSON.stringify({ campaigns: [{ title: "retry backoff", items: ["G1", "G2"] }] });
    const rows: CoverageUnits = [...MORNING_LABELS, "personal_code"].map((l) => ({ repo: `/w/${l}`, labels: [l] }));
    const asRepo = scoreReply(MORNING_STRUCT, ITEMS, text, [...rows, { repo: "backoff", labels: ["zq"] }], "trial");
    expect([asRepo.outcome, asRepo.kept, asRepo.dropped]).toEqual(["trial", 1, []]);
    const asLabel = scoreReply(MORNING_STRUCT, ITEMS, text, [...rows, { repo: "/w/backoff", labels: ["backoff"] }], "trial");
    expect([asLabel.outcome, asLabel.kept]).toEqual(["none", 0]);
    expect(asLabel.dropped).toEqual([{ title: "retry backoff", reasons: ["title-rule-5"] }]);
  });

  test("[TB-V6] rule 6's three shapes fail, `Phase C §10.6` passes, a bare token that is no file passes", () => {
    // (a) a single token containing `/`; (b) a single token ending in `.ext`; (c) a filename stem some
    // member text spells with an extension (`queue.py` appears in G1's texts).
    expect(rules("src/queue.py")).toContain(6);
    expect(rules("queue.py")).toContain(6);
    expect(rules("queue")).toContain(6);
    expect(rules("Phase C §10.6")).not.toContain(6);
    expect(rules("IM3")).not.toContain(6);
    expect(rules("retry backoff")).not.toContain(6);
    // (b)'s extension is letters only: `v1.2` is not a filename; a 7-letter tail is not an extension
    expect(rules("v1.2")).not.toContain(6);
    expect(rules("archive.tarball")).not.toContain(6);
  });

  test("[TB-V7] rule 7, carries meaning: §4.6's pass list passes and its fail list fails, in both directions", () => {
    for (const t of ["IM3", "Rev13", "exp017", "rev16", "Phase C §10.6"]) expect(rules(t)).not.toContain(7);
    for (const t of ["the", "and more", "2026", "§10.6", "the 2026", "a §10.6", "The And", "Not Now", "misc", "wip", "chore", "updates", "cleanup", "changes"]) {
      expect(rules(t)).toContain(7);
    }
    // the list is B's own: `clean-up` and `wip` are in it, `retry` is not
    expect(TITLE_STOPWORDS.has("clean-up")).toBe(true);
    expect(TITLE_STOPWORDS.has("retry")).toBe(false);
    expect(TITLE_STOPWORDS.size).toBe(82);   // §4.6's list, counted word by word
  });

  test("[TB-V8] rule 8, delivery-stable: a control byte or a credential-shaped run in the title fails; plain text passes", () => {
    expect(rules(`retry${String.fromCharCode(0x1b)} backoff`)).toContain(8);
    expect(rules(`retry ghp_${"A".repeat(24)} backoff`)).toContain(8);
    expect(rules("retry backoff")).not.toContain(8);
  });

  test("[TB-V9] rule 9, citation-inert header: `evidence: cafe, f00d1a, beef2c` fails; a plain title passes", () => {
    expect(rules("evidence: cafe, f00d1a, beef2c")).toContain(9);
    expect(rules("retry backoff")).not.toContain(9);
    // a paren-free `evidence:` channel is what the miner reads, so `evidence: retry` with no hex passes 9
    expect(rules("evidence: retry backoff")).not.toContain(9);
  });

  test("mixes-labels and too-few-items are recorded beside the title rules (D4 names), and the campaign is dropped", () => {
    expect(reasonsOf("retry backoff", ["G1", "G3"])).toContain("mixes-labels");
    expect(reasonsOf("retry backoff", ["G1"])).toContain("too-few-items");
    expect(reasonsOf("retry backoff", ["G1"])).not.toContain("mixes-labels");
    const v = validateCampaigns(reply({ title: "retry backoff", items: ["G1"] }), ITEMS, MORNING_RECAP, LABELS);
    expect(v.ok && v.kept).toEqual([]);
    expect(v.ok && v.proposed).toBe(1);
  });
});

describe("the duplicate-title rule and the three-pass order (§4.6)", () => {
  test("[TB-V10] a title equal to a SURVIVING Stage-1 header's name part is dropped; equal to an ABSORBED header's name part it is kept", () => {
    // G1's header is `queue.py retry path reworked — 2 commits`; its name part is the text before ` — `.
    // Over G6+G2 the group survives at level 1 → duplicate; over G1+G2 the group is absorbed → kept.
    expect(reasonsOf("queue.py retry path reworked", ["G6", "G2"])).toEqual(["duplicate-title"]);
    expect(reasonsOf("queue.py retry path reworked", ["G1", "G2"])).toEqual([]);
    expect(reasonsOf("Queue.py Retry Path Reworked", ["G1", "G6"])).toContain("title-rule-1");   // case matters for rule 1, but…
    // …the duplicate comparison is case-folded: the same title spelled in another case over G6+G2 is a
    // duplicate of the surviving header (and ALSO fails rule 1, in pass 2, so it never reaches pass 3).
    const v = validateCampaigns(reply({ title: "queue.py retry path reworked", items: ["G6", "G7"] }), ITEMS, MORNING_RECAP, LABELS);
    expect(v.ok && v.dropped[0]!.reasons).toEqual(["duplicate-title"]);
    // NOT the whole header: every Stage-1 header carries ` — ` and titles forbid the em-dash, so a
    // whole-header comparison could never fire — the name part is what is compared.
  });

  test("[TB-V11] three-pass order: a campaign dropped in pass 2 does not reserve its title for pass 3", () => {
    // X: `retry backoff` over G1+G3 mixes labels → dropped in pass 2. Y: the same title over G6+G7 (G7's
    // text carries `retry backoff`) → kept: X reserved nothing.
    const v = validateCampaigns(reply({ title: "retry backoff", items: ["G1", "G3"] }, { title: "retry backoff", items: ["G6", "G7"] }), ITEMS, MORNING_RECAP, LABELS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.dropped).toEqual([{ title: "retry backoff", reasons: ["mixes-labels"] }]);
    expect(v.kept.map((k) => [k.title, k.items.map((i) => i.id)])).toEqual([["retry backoff", ["G6", "G7"]]]);
    // …whereas two SURVIVORS with one title: the first is kept and the second is the duplicate.
    const w = validateCampaigns(reply({ title: "retry backoff", items: ["G1", "G2"] }, { title: "retry backoff", items: ["G6", "G7"] }), ITEMS, MORNING_RECAP, LABELS);
    expect(w.ok && w.kept.map((k) => k.items.map((i) => i.id))).toEqual([["G1", "G2"]]);
    expect(w.ok && w.dropped).toEqual([{ title: "retry backoff", reasons: ["duplicate-title"] }]);
    expect(w.ok && w.proposed).toBe(2);
  });

  test("[TB-V12] pass-3 order: A absorbs G and is dropped as a duplicate; B, titled G's name part, is KEPT — the absorbed set was fixed before the pass", () => {
    // Items, one label: G (group, header `xyz path — 2 commits`), S1..S5 singles.
    const mk = (id: string, kind: CampaignItem["kind"], entries: number[], commits: string[], texts: string[]): CampaignItem =>
      ({ id, kind, labelKey: "app", entries, commits, texts, fact: "no PR fact" });
    const items: CampaignItem[] = [
      mk("G1", "group", [0, 1], [A, B], ["xyz path — 2 commits", "xyz path one", "xyz path two"]),
      mk("G2", "single", [2], [C], ["tidy path first"]),
      mk("G3", "single", [3], [D], ["tidy path second"]),
      mk("G4", "single", [4], ["e".repeat(40)], ["something else"]),
      mk("G5", "single", [5], ["f".repeat(40)], ["the xyz path again"]),
      mk("G6", "single", [6], ["a".repeat(40)], ["xyz path once more"]),
    ];
    const recap = [
      { repo: "app", text: "xyz path one", group: "xyz path — 2 commits" }, { repo: "app", text: "xyz path two", group: "xyz path — 2 commits" },
      { repo: "app", text: "tidy path first" }, { repo: "app", text: "tidy path second" }, { repo: "app", text: "something else" },
      { repo: "app", text: "the xyz path again" }, { repo: "app", text: "xyz path once more" },
    ];
    // Over these items A fails rule 1 (no member text of G1 or G4 carries `tidy path`), so it is dropped in
    // PASS 2 and absorbs nothing: G stays at level 1 and B is the duplicate of its name part.
    const v = validateCampaigns(reply(
      { title: "tidy path", items: ["G2", "G3"] },     // K0: kept
      { title: "tidy path", items: ["G1", "G4"] },     // A: would absorb G (G1), but fails rule 1 here
      { title: "xyz path", items: ["G5", "G6"] },      // B: equals G's name part, and G is NOT absorbed
    ), items, recap, ["app"]);
    expect(v.ok).toBe(true);
    expect(v.ok && v.dropped).toEqual([{ title: "tidy path", reasons: ["title-rule-1"] }, { title: "xyz path", reasons: ["duplicate-title"] }]);
    // The case the spec names needs A to SURVIVE pass 2 (and fall in pass 3): give G4 the span.
    const items2 = items.map((it) => (it.id === "G4" ? { ...it, texts: ["tidy path elsewhere"] } : it));
    const recap2 = recap.map((r, i) => (i === 4 ? { ...r, text: "tidy path elsewhere" } : r));
    const w = validateCampaigns(reply(
      { title: "tidy path", items: ["G2", "G3"] },
      { title: "tidy path", items: ["G1", "G4"] },
      { title: "xyz path", items: ["G5", "G6"] },
    ), items2, recap2, ["app"]);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.dropped).toEqual([{ title: "tidy path", reasons: ["duplicate-title"] }]);
    expect(w.kept.map((k) => [k.title, k.items.map((i) => i.id)])).toEqual([["tidy path", ["G2", "G3"]], ["xyz path", ["G5", "G6"]]]);
    // …and G renders at level 1: it is stamped by no kept campaign.
    expect(w.kept.some((k) => k.items.some((i) => i.id === "G1"))).toBe(false);
    // The contrast, and the mutation's shape: had the absorbed set been RECOMPUTED after A's drop, G would
    // be unabsorbed when B is compared and B would be dropped as a duplicate of G's name part. Without A
    // in the reply at all, that is exactly what happens:
    const noA = validateCampaigns(reply({ title: "tidy path", items: ["G2", "G3"] }, { title: "xyz path", items: ["G5", "G6"] }), items2, recap2, ["app"]);
    expect(noA.ok && noA.dropped).toEqual([{ title: "xyz path", reasons: ["duplicate-title"] }]);
  });

  // Harden r1 (A3): the duplicate-title rule is scoped to ONE label (§4.6: "within its label") — on both
  // halves: (i) an earlier KEPT campaign and (ii) a surviving Stage-1 header's name part, each only when
  // it sits in the same label. Two labels, `app` and `lib`; every title below passes rules 1–9.
  test("the duplicate-title rule is per label: the same title, or a same-name-part header, in ANOTHER label is kept", () => {
    const mk = (id: string, kind: CampaignItem["kind"], labelKey: string, entries: number[], commits: string[], texts: string[]): CampaignItem =>
      ({ id, kind, labelKey, entries, commits, texts, fact: "no PR fact" });
    const items: CampaignItem[] = [
      mk("G1", "group", "lib", [0, 1], [A, B], ["xyz path — 2 commits", "xyz path one", "xyz path two"]),
      mk("G2", "single", "app", [2], [C], ["tidy path first"]),
      mk("G3", "single", "app", [3], [D], ["tidy path second"]),
      mk("G4", "single", "lib", [4], ["e".repeat(40)], ["tidy path third"]),
      mk("G5", "single", "lib", [5], ["f".repeat(40)], ["tidy path fourth"]),
      mk("G6", "single", "app", [6], ["a".repeat(40)], ["the xyz path again"]),
      mk("G7", "single", "app", [7], ["b".repeat(40)], ["xyz path once more"]),
    ];
    const recap = [
      { repo: "lib", text: "xyz path one", group: "xyz path — 2 commits" }, { repo: "lib", text: "xyz path two", group: "xyz path — 2 commits" },
      { repo: "app", text: "tidy path first" }, { repo: "app", text: "tidy path second" }, { repo: "lib", text: "tidy path third" },
      { repo: "lib", text: "tidy path fourth" }, { repo: "app", text: "the xyz path again" }, { repo: "app", text: "xyz path once more" },
    ];
    // (i) `tidy path` kept in `app`, then `tidy path` in `lib`: not a duplicate — both kept
    const v = validateCampaigns(reply({ title: "tidy path", items: ["G2", "G3"] }, { title: "tidy path", items: ["G4", "G5"] }), items, recap, ["app", "lib"]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.dropped).toEqual([]);
    expect(v.kept.map((k) => [k.title, k.labelKey, k.items.map((i) => i.id)])).toEqual([["tidy path", "app", ["G2", "G3"]], ["tidy path", "lib", ["G4", "G5"]]]);
    // (ii) `xyz path` in `app` while `lib`'s group header `xyz path — 2 commits` survives unabsorbed: kept
    const w = validateCampaigns(reply({ title: "xyz path", items: ["G6", "G7"] }), items, recap, ["app", "lib"]);
    expect(w.ok && w.dropped).toEqual([]);
    expect(w.ok && w.kept.map((k) => [k.title, k.labelKey])).toEqual([["xyz path", "app"]]);
    // the contrast, same label: `lib`'s own `xyz path` IS the duplicate of its surviving header
    const lib = items.map((it) => (it.id === "G4" || it.id === "G5" ? { ...it, texts: [`xyz path ${it.id}`] } : it));
    const x = validateCampaigns(reply({ title: "xyz path", items: ["G4", "G5"] }), lib, recap, ["app", "lib"]);
    expect(x.ok && x.dropped).toEqual([{ title: "xyz path", reasons: ["duplicate-title"] }]);
  });

  test("kept campaigns come back in reply order with their items in id order", () => {
    const v = validateCampaigns(reply({ title: "retry backoff also landed here", items: ["G7", "G6"] }, { title: "retry backoff", items: ["G2", "G1"] }), ITEMS, MORNING_RECAP, LABELS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.dropped).toEqual([]);
    expect(v.kept.map((k) => [k.title, k.labelKey, k.items.map((i) => i.id)])).toEqual([
      ["retry backoff also landed here", "accountant_ai", ["G6", "G7"]],
      ["retry backoff", "accountant_ai", ["G1", "G2"]],
    ]);
  });
});

describe("the offered items' commit population (§4.3)", () => {
  test("buildCampaignItems resolves only against commit activities with a string event_id — a branch tip, a stash or an id-less activity never resolves", () => {
    // clusterRecap's own filter (generator.ts `kind === "commit" && typeof event_id === "string"`), applied
    // inside the builder, not left to the caller: a bullet citing only a non-commit SHA is unresolved…
    const branchTip: Activity = { source: "git", kind: "branch", event_id: full("7e7e7e7e"), repo: "/r" };
    const stash: Activity = { source: "git", kind: "stash", event_id: full("6d6d6d6d"), repo: "/r" };
    const idless = { source: "git", kind: "commit", repo: "/r" } as unknown as Activity;
    expect(buildCampaignItems([{ repo: "app", text: "cites the branch tip", evidence: "7e7e7e7" }], [...MORNING_COMMITS, branchTip])).toEqual([]);
    expect(buildCampaignItems([{ repo: "app", text: "cites the stash", evidence: "6d6d6d6" }], [stash, ...MORNING_COMMITS])).toEqual([]);
    // …an id-less activity is skipped, never matched or thrown on, so the real commit beside it still resolves…
    expect(buildCampaignItems([{ repo: "app", text: "cites a real commit", evidence: "a1a1a1a" }], [idless, ...MORNING_COMMITS]).map((i) => i.commits)).toEqual([[A]]);
    // …and for a caller that already passes the population the filter changes nothing.
    expect(buildCampaignItems(MORNING_RECAP, [branchTip, idless, ...MORNING_COMMITS, stash])).toEqual(ITEMS);
  });
});
