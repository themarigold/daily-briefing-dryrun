// test/recap-campaigns.format.test.ts — tier B, T1.4 (plan-added): the record line and the stderr line
// (§4.10 1–2), the `labels[]` and `prFacts` shapes (D1, D9), and the labelKey JOIN between `labels[]` and
// `campaigns[]` (plan §2, round 4 B8).
import { test, expect, describe } from "bun:test";
import {
  buildCampaignItems, validateCampaigns, recordLabels, recordCampaigns, formatRecapRecordLine, formatRecapStderrLine,
  RECAP_STDERR_PREFIX, STDERR_LATENCY_CAP, type RecapRecordV2,
} from "../src/recapCampaigns";
import { REDACTION, redactCredentials } from "../src/transcripts/credentials";
import { MORNING_RECAP, MORNING_COMMITS, MORNING_LABELS } from "./fixtures/campaign-morning";

const ITEMS = buildCampaignItems(MORNING_RECAP, MORNING_COMMITS);

const base = (over: Partial<RecapRecordV2> = {}): RecapRecordV2 => ({
  v: 2, date: "2026-09-24", mode: "trial", invoker: "scheduled", json: false, forced: false,
  gate: { fired: true, commits: 46, top: 13 }, outcome: "trial", reason: null,
  before: 13, after: 11, proposed: 2, kept: 2, dropped: [], latencyMs: 8421, gitMs: 212,
  prFacts: { merges: 8, read: 8, timedOut: 0, marked: 1, reposUnread: 0 }, hardening: "on", providerWarnings: [],
  ...over,
});

describe("the stderr line (§4.10 2)", () => {
  test("its field set is exactly the engine enums and integers, `dropped` is a count, `record` says whether the write succeeded", () => {
    const line = formatRecapStderrLine(base({ dropped: [{ title: "some title (with parens)", reasons: ["title-rule-3"] }] }), true);
    expect(line.startsWith(RECAP_STDERR_PREFIX)).toBe(true);
    const body = JSON.parse(line.slice(RECAP_STDERR_PREFIX.length));
    expect(Object.keys(body)).toEqual(["v", "date", "mode", "outcome", "reason", "before", "after", "proposed", "kept", "dropped", "latencyMs", "record"]);
    expect(body).toEqual({ v: 2, date: "2026-09-24", mode: "trial", outcome: "trial", reason: null, before: 13, after: 11, proposed: 2, kept: 2, dropped: 1, latencyMs: 8421, record: true });
    expect(formatRecapStderrLine(base(), false)).toContain('"record":false');
    // nothing an audit reader could mine: no title, no `(`, `)`, no `evidence`, no 7-hex run
    expect(line).not.toContain("some title");
    expect(line).not.toMatch(/[()]/);
    expect(line).not.toMatch(/evidence/i);
    expect(line).not.toMatch(/(?<![0-9a-f])[0-9a-f]{7}/i);
    expect(line).toBe('grouping-info [recap-campaigns]: {"v":2,"date":"2026-09-24","mode":"trial","outcome":"trial","reason":null,"before":13,"after":11,"proposed":2,"kept":2,"dropped":1,"latencyMs":8421,"record":true}');
  });

  test("latencyMs is capped at 999 999 on the stderr line only — the record keeps the true value", () => {
    const r = base({ latencyMs: 12_345_678 });
    expect(formatRecapStderrLine(r, true)).toContain(`"latencyMs":${STDERR_LATENCY_CAP}`);
    expect(STDERR_LATENCY_CAP).toBe(999_999);
    expect(JSON.parse(formatRecapRecordLine(r)).latencyMs).toBe(12_345_678);
    // a reason string is an engine enum and passes through; the prefix matches none of the EVAL greps
    expect(formatRecapStderrLine(base({ outcome: "rejected", reason: "provider-error:timeout" }), true)).toContain('"reason":"provider-error:timeout"');
    for (const g of ["postcheck [", "postcheck-info", "parse-info"]) expect(RECAP_STDERR_PREFIX.startsWith(g)).toBe(false);
  });
});

describe("the record line (§4.10 1)", () => {
  test("every text field passes stripControl before serialisation and the whole line passes redactCredentials", () => {
    const ESC = String.fromCharCode(0x1b), BEL = String.fromCharCode(7);
    const token = `ghp_${"A".repeat(24)}`;
    const r = base({
      outcome: "trial",
      dropped: [{ title: `bad${ESC}[31m title`, reasons: ["title-rule-8"] }],
      providerWarnings: [`warn${BEL}ing with ${token}`],
      labels: [{ label: `acc${ESC}ountant_ai`, offered: 6 }],
      campaigns: [{ label: "accountant_ai", title: `ti${BEL}tle`, header: `ti${BEL}tle — 2 commits`, commits: 2,
        items: [{ id: "G1", kind: "group", header: `hea${ESC}der`, bullets: [`bul${BEL}let`], prFact: `merged in PR #1 (${token})` }] }],
    });
    const line = formatRecapRecordLine(r);
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).not.toContain(token);
    expect(line).toContain(REDACTION);
    const parsed = JSON.parse(line);
    expect(parsed.dropped).toEqual([{ title: "bad[31m title", reasons: ["title-rule-8"] }]);
    expect(parsed.labels).toEqual([{ label: "accountant_ai", offered: 6 }]);
    expect(parsed.campaigns[0].items[0]).toEqual({ id: "G1", kind: "group", header: "header", bullets: ["bullet"], prFact: `merged in PR #1 (${REDACTION})` });
    expect(parsed.providerWarnings).toEqual([`warning with ${REDACTION}`]);
    // one line, no newline inside; the input record is not mutated
    expect(line).not.toContain("\n");
    expect(r.dropped[0]!.title).toBe(`bad${ESC}[31m title`);
  });

  test("a quoted or quote-adjacent credential is redacted per field BEFORE serialisation: the line parses and no secret survives", () => {
    // Redacting only the serialised line let JSON's `\"` escapes defeat the env-assignment pattern (shape 1:
    // the quoted secret survived) or be eaten by it (shapes 2–3: the line stopped parsing). Shape 4 is what
    // a per-field pass ALONE still misses: 7 characters are under the pattern's 8-character floor in the
    // raw text, but the escape's `\` makes 8 in the line, so the whole-line pass would eat the escape
    // again — such a field is replaced whole. The whole-line pass stays (§4.10 1) and finds nothing.
    const shapes = [
      { text: `export API_KEY="abcd1234efgh5678"`, secret: "abcd1234efgh5678", field: `export ${REDACTION}"` },
      { text: `API_KEY=12345678"tail`, secret: "12345678", field: `${REDACTION}"tail` },
      { text: `say "SECRET_TOKEN=abcdefgh" ok`, secret: "abcdefgh", field: `say "${REDACTION}" ok` },
      { text: `API_KEY=1234567"x`, secret: "1234567", field: REDACTION },
    ];
    for (const { text, secret, field } of shapes) {
      const r = base({
        dropped: [{ title: text, reasons: ["title-rule-8"] }],
        providerWarnings: [text],
        labels: [{ label: text, offered: 1 }],
        campaigns: [{ label: text, title: text, header: text, commits: 1, items: [{ id: "G1", kind: "group", header: text, bullets: [text], prFact: text }] }],
      });
      const line = formatRecapRecordLine(r);
      let parsed: RecapRecordV2 | undefined;
      expect(() => { parsed = JSON.parse(line); }).not.toThrow();
      expect(line).not.toContain(secret);
      expect(JSON.stringify(parsed)).not.toContain(secret);
      expect(parsed!.providerWarnings).toEqual([field]);
      expect(parsed!.dropped).toEqual([{ title: field, reasons: ["title-rule-8"] }]);
      expect(parsed!.labels).toEqual([{ label: field, offered: 1 }]);
      expect(parsed!.campaigns![0]!).toEqual({ label: field, title: field, header: field, commits: 1, items: [{ id: "G1", kind: "group", header: field, bullets: [field], prFact: field }] });
      expect(redactCredentials(line)).toBe(line);
    }
  });

  test("the `labels[]` shape is {label, offered} per label key, and `prFacts` carries merges, read, timedOut, marked AND reposUnread", () => {
    expect(recordLabels(ITEMS)).toEqual([{ label: "accountant_ai", offered: 6 }, { label: "quant_stocks", offered: 1 }]);
    const parsed = JSON.parse(formatRecapRecordLine(base({ labels: recordLabels(ITEMS), prFacts: { merges: 3, read: 2, timedOut: 1, marked: 1, reposUnread: 2 } })));
    expect(parsed.labels).toEqual([{ label: "accountant_ai", offered: 6 }, { label: "quant_stocks", offered: 1 }]);
    expect(Object.keys(parsed.prFacts)).toEqual(["merges", "read", "timedOut", "marked", "reposUnread"]);
    expect(parsed.prFacts.reposUnread).toBe(2);
    // the example's field order, `campaigns` last and absent unless given
    expect(Object.keys(JSON.parse(formatRecapRecordLine(base())))).toEqual([
      "v", "date", "mode", "invoker", "json", "forced", "gate", "outcome", "reason", "before", "after", "proposed", "kept", "dropped",
      "latencyMs", "gitMs", "prFacts", "hardening", "providerWarnings",
    ]);
  });

  test("labels[] and campaigns[] carry the same labelKey for a raw-vs-normalised label pair", () => {
    // Entries bracketed `Mono` and `mono` (and `Mono.`): ONE labels[] row and ONE campaign label, both
    // `mono` — the join key is norm(repo), never the raw bracket the page prints.
    const recap = [
      { repo: "Mono", text: "reworked the header", evidence: "a1a1a1a" },
      { repo: "mono", text: "reworked the footer", evidence: "b2b2b2b" },
      { repo: "Mono.", text: "reworked the grid", evidence: "c3c3c3c" },
    ];
    const items = buildCampaignItems(recap, MORNING_COMMITS);
    expect(items.map((i) => i.labelKey)).toEqual(["mono", "mono", "mono"]);
    expect(recordLabels(items)).toEqual([{ label: "mono", offered: 3 }]);
    const v = validateCampaigns({ campaigns: [{ title: "reworked the", items: ["G1", "G2", "G3"] }] }, items, recap, ["mono"]);
    expect(v.ok && v.kept).toHaveLength(1);
    if (!v.ok) return;
    const campaigns = recordCampaigns(v.kept);
    expect(campaigns.map((c) => c.label)).toEqual(["mono"]);
    expect(campaigns[0]).toEqual({
      label: "mono", title: "reworked the", header: "reworked the — 3 commits", commits: 3,
      items: [
        { id: "G1", kind: "single", bullets: ["reworked the header"], prFact: "no PR fact" },
        { id: "G2", kind: "single", bullets: ["reworked the footer"], prFact: "no PR fact" },
        { id: "G3", kind: "single", bullets: ["reworked the grid"], prFact: "no PR fact" },
      ],
    });
    // the join: the campaign's label finds exactly one labels[] row, and the share is computable
    const labels = recordLabels(items);
    const row = labels.find((l) => l.label === campaigns[0]!.label);
    expect(row).toEqual({ label: "mono", offered: 3 });
    expect(campaigns[0]!.items.length / row!.offered).toBe(1);
    // …and on the fixture morning a group item's record carries its header separately from its bullets
    const w = validateCampaigns({ campaigns: [{ title: "retry backoff", items: ["G1", "G2"] }] }, ITEMS, MORNING_RECAP, MORNING_LABELS);
    if (!w.ok) throw new Error(w.reason);
    expect(recordCampaigns(w.kept)[0]!.items[0]).toEqual({
      id: "G1", kind: "group", header: "queue.py retry path reworked — 2 commits", bullets: ["queue.py retry path reworked twice", "retry backoff added"], prFact: "no PR fact",
    });
  });
});
