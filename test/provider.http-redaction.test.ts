import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { diagnostic, postJson } from "../src/providers/http";
import { ProviderError } from "../src/types";
import { REDACTION } from "../src/transcripts/credentials";

describe("literal key scrubbing composes with URL userinfo redaction", () => {
  const key = "api-key-value";
  for (const [position, url] of [
    ["username", `https://${key}:SECRETMARK@host/repo`],
    ["password", `https://SECRETMARK:${key}@host/repo`],
  ]) {
    const text = `${url} echoed ${key}`;
    test(`diagnostic: key in ${position}`, () => {
      expect(diagnostic(text, key)).toBe(`https://${REDACTION}@host/repo echoed ${REDACTION}`);
    });
    for (const site of ["fetch failure", "HTTP error", "invalid JSON"] as const) {
      test(`${site}: key in ${position}`, async () => {
        const fetchImpl = (async () => {
          if (site === "fetch failure") throw new Error(text);
          return new Response(text, { status: site === "HTTP error" ? 502 : 200 });
        }) as unknown as typeof fetch;
        const error = await postJson({
          url: "https://provider.example/v1", headers: {}, body: {}, timeoutMs: 1000,
          label: "test", kind: "openai-compatible", secret: key, fetchImpl,
        }).then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        const message = (error as ProviderError).message;
        expect(message).toContain(`https://${REDACTION}@host/repo echoed ${REDACTION}`);
        expect(message).not.toContain("SECRETMARK");
        expect(message).not.toContain(key);
      });
    }
  }
});

describe("literal and shape spans are redacted together on the original diagnostic", () => {
  const shaped = "sk-proj-" + "a".repeat(25);
  const cases = [
    { name: "shape ends inside key", key: shaped + "_SECRETMARK", text: shaped + "_SECRETMARK" },
    { name: "key ends inside shape", key: "SECRETMARK_" + shaped, text: "SECRETMARK_" + shaped + "b".repeat(25) },
    { name: "adjacent literal spans", key: "SECRETMARK", text: "SECRETMARKSECRETMARK" },
    { name: "adjacent literal and shape spans", key: "SECRETMARK_", text: "SECRETMARK_" + shaped },
    { name: "whitespace inside literal", key: "SECRETMARK\tvalue", text: "SECRETMARK\tvalue" },
  ];
  for (const { name, key, text } of cases) {
    test(`diagnostic: ${name}`, () => {
      expect(diagnostic(`before ${text} after`, key)).toBe(`before ${REDACTION} after`);
    });
    for (const site of ["fetch failure", "HTTP error", "invalid JSON"] as const) {
      test(`${site}: ${name}`, async () => {
        const fetchImpl = (async () => {
          if (site === "fetch failure") throw new Error(`before ${text} after`);
          return new Response(`before ${text} after`, { status: site === "HTTP error" ? 502 : 200 });
        }) as unknown as typeof fetch;
        const error = await postJson({
          url: "https://provider.example/v1", headers: {}, body: {}, timeoutMs: 1000,
          label: "test", kind: "openai-compatible", secret: key, fetchImpl,
        }).then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).message).toContain(`before ${REDACTION} after`);
        expect((error as ProviderError).message).not.toContain("SECRETMARK");
      });
    }
  }

  test("redacts every overlap before the diagnostic clip", () => {
    const key = shaped + "_SECRETMARK";
    expect(diagnostic("x".repeat(285) + " " + key, key)).toBe("x".repeat(285) + " " + REDACTION);
    expect(diagnostic(`before ${key} middle ${key} after`, key)).toBe(`before ${REDACTION} middle ${REDACTION} after`);
    for (const absent of [undefined, ""]) expect(diagnostic("ordinary text", absent)).toBe("ordinary text");
  });

  test("timing: union redaction stays bounded on many matches and adversarial non-matches", () => {
    const key = shaped + "_SECRETMARK";
    for (const unit of [`${key} `, "_eyJ", "SECRET", "https://user:" + ":".repeat(30) + "/"]) {
      diagnostic(unit.repeat(10), key); // compile/warm before measuring CPU time
      const best = [Infinity, Infinity];
      for (let round = 0; round < 2; round++) for (const [i, size] of [100_000, 200_000].entries()) {
        const text = unit.repeat(Math.ceil(size / unit.length));
        const before = process.cpuUsage();
        const result = diagnostic(text, key);
        const elapsed = process.cpuUsage(before);
        const ms = (elapsed.user + elapsed.system) / 1000;
        expect(result.length).toBeLessThanOrEqual(300);
        expect(result).not.toContain("SECRETMARK");
        expect(ms).toBeLessThan(500);
        best[i] = Math.min(best[i]!, ms);
      }
      expect(best[1]!).toBeLessThan(3 * best[0]! + 5);
    }
  }, 30_000);
});

const partials = [
  "https://user:SECRETMARK",
  "sk-SECRETMARK",
  "AKIASECRETMARK",
  "ghp_SECRETMARK",
  "xoxb-SECRET",
  "eyJSECRETMARK",
  "PASSWORD=SECRET",
  "Authorization: Bearer SECRET",
  "-----BEGIN RSA PRIVATE KEY-----SECRETMARK",
];

describe("HTTP incomplete diagnostics drop the final partial token before redaction", () => {
  for (const status of [200, 502]) for (const ending of ["error", "cap"] as const) {
    for (const partial of partials) test(`${status} ${ending}: ${partial}`, async () => {
      const text = `gateway refused ${partial}`;
      const mark = partial.endsWith("SECRET") ? "SECRET" : "SECRETMARK";
      expect(diagnostic(text)).toContain(mark); // a complete-string redactor cannot infer this cut
      let pulls = 0, canceled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (pulls++ === 0) c.enqueue(new TextEncoder().encode(text));
          else if (ending === "error") c.error(new Error("broken stream"));
          else c.enqueue(new TextEncoder().encode("@host/repo trailing bytes"));
        },
        cancel() { canceled = true; },
      });
      const fetchImpl = (async () => new Response(stream, { status })) as unknown as typeof fetch;
      const error = await postJson({
        url: "https://provider.example/v1", headers: {}, body: {}, timeoutMs: 1000,
        label: "test", kind: "openai-compatible", fetchImpl,
        ...(ending === "cap" ? { maxBytes: new TextEncoder().encode(text).byteLength } : {}),
      }).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      const e = error as ProviderError;
      expect(e.httpStatus).toBe(status);
      expect(e.message).toContain("gateway refused");
      expect(e.message).not.toContain(mark);
      if (ending === "cap") expect(canceled).toBe(true); // cap branch really ran
      else expect(pulls).toBe(2); // partial bytes preceded the error
    });
  }

  test("incomplete text with no whitespace is withheld entirely", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) {
      if (pulls++ === 0) c.enqueue(new TextEncoder().encode("https://user:SECRETMARK"));
      else c.error(new Error("broken stream"));
    } });
    const fetchImpl = (async () => new Response(stream, { status: 502 })) as unknown as typeof fetch;
    await expect(postJson({ url: "https://provider.example", headers: {}, body: {}, timeoutMs: 1000,
      label: "test", kind: "openai-compatible", fetchImpl })).rejects.toThrow("(no body)");
  });

  test("a trailing whitespace confirms the prior URL token is complete and can be redacted", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) {
      if (pulls++ === 0) c.enqueue(new TextEncoder().encode("gateway https://user:SECRETMARK@host/repo \n"));
      else c.error(new Error("broken stream"));
    } });
    const fetchImpl = (async () => new Response(stream, { status: 502 })) as unknown as typeof fetch;
    await expect(postJson({ url: "https://provider.example", headers: {}, body: {}, timeoutMs: 1000,
      label: "test", kind: "openai-compatible", fetchImpl })).rejects.toThrow("gateway https://[redacted]@host/repo");
  });
});
