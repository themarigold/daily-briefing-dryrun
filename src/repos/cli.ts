// src/repos/cli.ts — the `repos` verb (B1-M3-T9, wave-2 plan): `daily-briefing repos status --json`, the
// desktop app's live git check. The request arrives on STDIN, never on argv (the way `provider reset
// --label-stdin` gets its label), bounded at `REPOS_STDIN_MAX_BYTES` before it is parsed. Every refusal is
// exit 2 with ONE fixed line on stderr and nothing on stdout; nothing from the request is ever echoed.
import { readStdinBounded } from "../providerCli";
import { parseReposRequest, reposStatus, REPOS_STDIN_MAX_BYTES } from "./status";
import type { ReposRequest } from "./types";

export type ReposCliCtx = {
  isTTY?: boolean;
  readStdin?: (maxBytes: number) => Promise<string>;
  write?: (s: string) => void;
  error?: (s: string) => void;
  /** The check itself (the real one by default): injectable so the contract is tested without git. */
  status?: (req: ReposRequest) => Promise<unknown>;
};

const USAGE = "repos: usage: daily-briefing repos status --json (the request on STDIN)";

export async function reposMain(args: string[], ctx: ReposCliCtx = {}): Promise<number> {
  const error = ctx.error ?? ((s: string) => console.error(s));
  // console.log, as every other `--json` command prints: one line, and it is flushed before `main`'s exit.
  const write = ctx.write ?? ((s: string) => console.log(s));
  if (args.length !== 2 || args[0] !== "status" || args[1] !== "--json") { error(USAGE); return 2; }
  if (ctx.isTTY ?? Boolean(process.stdin.isTTY)) { error("repos status: the request is read from STDIN, which is a terminal here"); return 2; }
  let text: string;
  try { text = await (ctx.readStdin ?? readStdinBounded)(REPOS_STDIN_MAX_BYTES); } catch { error("repos status: could not read STDIN"); return 2; }
  if (Buffer.byteLength(text, "utf8") > REPOS_STDIN_MAX_BYTES) { error("repos status: the request on STDIN is too large"); return 2; }
  const req = parseReposRequest(text);
  if (req === null) { error("repos status: the request on STDIN is malformed"); return 2; }
  const reply = await (ctx.status ?? ((r: ReposRequest) => reposStatus(r)))(req);
  write(JSON.stringify(reply));
  return 0;
}
