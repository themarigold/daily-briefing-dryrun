import "./fixtures/isolate-state";
import { describe, expect, spyOn, test } from "bun:test";
import { BYOCliProvider } from "../src/provider";
import { parseBriefing } from "../src/generator";
import { renderBriefing } from "../src/render";
import * as streams from "../src/stream";
import { redactCredentials, REDACTION } from "../src/transcripts/credentials";

const PARTIAL = "https://user:SECRETMARK";
const encoder = new TextEncoder();
const cli = () => new BYOCliProvider({ cli: "ignored", argv: [], promptVia: "stdin" }, { flushMs: 20 });
const closed = (text: string) => new ReadableStream<Uint8Array>({ start(c) {
  c.enqueue(encoder.encode(text)); c.close();
} });

function incomplete(text: string, ending: "held" | "error" | "cap") {
  const state = { pulls: 0, canceled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (state.pulls++ === 0) c.enqueue(encoder.encode(text));
      else if (ending === "error") c.error(new Error("EIO"));
      // Held and capped streams never EOF; the provider must abandon the reader.
    },
    cancel() { state.canceled = true; },
  });
  return { stream, state };
}

function spawnResult(stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>, code: number) {
  return {
    stdout, stderr, stdin: { write() {}, end() {} },
    exited: Promise.resolve(code), exitCode: code, signalCode: null, kill() {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe("CLI incomplete diagnostic tokens", () => {
  for (const side of ["stdout", "stderr"] as const) for (const ending of ["held", "error", "cap"] as const) {
    test(`${side} ${ending}: withhold the partial URL and keep the complete peer's last token`, async () => {
      const broken = incomplete(`cause ${PARTIAL}`, ending);
      const peer = closed("complete peer-tail");
      const spawn = spyOn(Bun, "spawn").mockImplementation(() => spawnResult(
        side === "stdout" ? broken.stream : peer, side === "stderr" ? broken.stream : peer, 1,
      ));
      // BYOCliProvider currently drains without a cap. Exercise the capped-sink state through the
      // real shared drain, whose truncated flag prevents complete=true even after cancellation.
      const realDrain = streams.drain;
      const sinks: streams.Sink[] = [];
      const drain = ending === "cap" ? spyOn(streams, "drain").mockImplementation((s) => {
        const read = realDrain(s, { maxBytes: 24 });
        sinks.push(read.sink);
        return read;
      }) : undefined;
      try {
        const error = await cli().generate("x").then(() => undefined, (e: unknown) => e);
        expect(error).toMatchObject({ code: "nonzero-exit", partialRead: true });
        const message = (error as Error).message;
        expect(message).toContain("cause");
        expect(message).toContain("complete peer-tail");
        expect(message).not.toContain("SECRETMARK");
        if (ending === "error") expect(broken.state.pulls).toBe(2);
        else expect(broken.state.canceled).toBe(true);
        if (ending === "cap") expect(sinks.filter((s) => s.truncated && !s.complete)).toHaveLength(1);
      } finally { drain?.mockRestore(); spawn.mockRestore(); }
    });
  }

  test("whitespace terminates a complete URL token in an incomplete stream", async () => {
    const broken = incomplete(`cause ${PARTIAL}@host/repo \n`, "held");
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => spawnResult(broken.stream, closed(""), 1));
    try {
      await expect(cli().generate("x")).rejects.toThrow(`cause https://${REDACTION}@host/repo`);
    } finally { spawn.mockRestore(); }
  });

  test("an incomplete stream with no whitespace contributes no diagnostic", async () => {
    const broken = incomplete(PARTIAL, "held");
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => spawnResult(broken.stream, closed(""), 1));
    try {
      await expect(cli().generate("x")).rejects.toThrow("(no output)");
    } finally { spawn.mockRestore(); }
  });
});

test("CLI successful incomplete stdout is safe through parsing and the rendered briefing", async () => {
  const text = "## RESUME\n- [demo] Keep working\n## RECAP\n- [demo] Finished setup | evidence: abc1234\n## SUGGESTIONS\n- Inspect " + PARTIAL;
  const warnings: string[] = [];
  const provider = new BYOCliProvider({
    cli: "sh", argv: ["-c", `printf '%s' '${text}'; sleep 1 &`], promptVia: "stdin",
  }, { flushMs: 40, onWarning: (w) => warnings.push(w) });
  const output = await provider.generate("x");
  expect(warnings.some((w) => w.includes("its output stream never closed"))).toBe(true);
  const page = redactCredentials(renderBriefing(parseBriefing(output, {
    date: "2026-10-24", machineScope: "test", provider: "sh",
  })));
  expect(page).toContain("Keep working");
  expect(page).toContain("Inspect");
  expect(page).not.toContain("SECRETMARK");
  expect(output).not.toContain(PARTIAL);
});

test("CLI incomplete stdout containing only a partial token is empty-output", async () => {
  const broken = incomplete(PARTIAL, "held");
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => spawnResult(broken.stream, closed(""), 0));
  try {
    await expect(cli().generate("x")).rejects.toMatchObject({ code: "empty-output" });
  } finally { spawn.mockRestore(); }
});

test("CLI complete stdout keeps its final token without requiring whitespace", async () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => spawnResult(closed("complete final-token"), closed(""), 0));
  try { expect(await cli().generate("x")).toBe("complete final-token"); }
  finally { spawn.mockRestore(); }
});

for (const ending of ["timeout", "killed"] as const) test(`CLI ${ending} never echoes buffered partial tokens`, async () => {
  const provider = new BYOCliProvider({ cli: "sh", argv: ["-c",
    `printf '%s' '${PARTIAL}'; printf '%s' '${PARTIAL}' >&2; ` + (ending === "timeout" ? "sleep 1" : "kill -KILL $$"),
  ], promptVia: "stdin" }, { timeoutMs: 50, killGraceMs: 20, flushMs: 20 });
  const error = await provider.generate("x").then(() => undefined, (e: unknown) => e);
  expect(error).toMatchObject({ code: ending === "timeout" ? "timeout" : "nonzero-exit" });
  expect((error as Error).message).not.toContain("SECRETMARK");
});
