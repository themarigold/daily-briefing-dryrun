import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyTransport, pushTransport } from "../src/repos/transport";

const vectors: { transport: { url: string; expected: string }[] } =
  JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/github-target-vectors.json", import.meta.url), "utf8"));

for (const v of vectors.transport) {
  test(`push destination: ${JSON.stringify(v.url)}`, () => {
    expect<string>(classifyTransport(v.url)).toBe(v.expected);
  });
}

for (const url of ["ssh://user@%2Dhost/x", "ssh://user@%2dhost/x", "ssh://%2Duser@host/x", "ssh://%2duser@host/x"]) {
  test(`decoded SSH authority refuses a leading hyphen: ${url}`, () => {
    expect(classifyTransport(url)).toBe("refused");
  });
}

test("ordinary percent-encoded SSH user and host remain network transports", () => {
  expect(classifyTransport("ssh://%75ser@ho%73t/x")).toBe("network");
});

test("every destination must be a network transport; vcs presence, even empty, refuses", () => {
  expect(pushTransport(["https://host/repo", "user@host:repo"], false)).toBe("network");
  expect(pushTransport(["https://host/repo", "/local"], false)).toBe("refused");
  expect(pushTransport([], false)).toBe("refused");
  expect(pushTransport(["https://host/repo"], true)).toBe("refused");
  expect(pushTransport(null, false)).toBeNull();
});
