// Child-process probe for test/run-tmp.test.ts (NOT a *.test.ts: run only by that file, by path, as
// `bun <this file> <dir>`). Sweeps <dir> once and prints the result as JSON, so the parent can judge a marker
// that might block the sweep (a FIFO) from outside, with a timeout. Importing run-tmp makes this process's own
// run root in its TMPDIR, which the parent points at a dir it registered.
import { sweepDeadRunRoots } from "./run-tmp";

console.log(JSON.stringify(sweepDeadRunRoots(process.argv[2]!)));
