// T22 — canonicalise the element order inside an ICNS file, in place.
//
// WHY THIS EXISTS (docs/gui-seam.md §14a): `tauri icon` 2.11.4's ICNS writer iterates a hash
// map, so two runs over the SAME source SVG emit the SAME elements (byte-identical each) in a
// DIFFERENT order — measured: two consecutive runs, twelve elements, identical per-element
// bytes, shuffled sequence. The T22 pipeline promises byte-identical regeneration
// (generate-branding.sh --check), so this script rewrites the container with its elements
// sorted by their four-byte type code. Pure reordering: every element's bytes are untouched,
// and macOS reads ICNS elements by type, never by position.
//
// Fails loudly on anything it does not fully understand (a 'TOC ' element records element
// order and would lie after sorting; truncated or oversized containers mean a writer this
// script has never seen) — the T22 discipline is "fail loudly, never silently skip".

const path = process.argv[2];
if (!path) {
  console.error("usage: bun icns-canonical.ts <icon.icns>");
  process.exit(2);
}

const die = (msg: string): never => {
  console.error(`icns-canonical: ${path}: ${msg}`);
  process.exit(1);
};

const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
const u32 = (off: number): number =>
  ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;

if (buf.length < 8) die(`too short for an ICNS header (${buf.length} bytes)`);
if (String.fromCharCode(...buf.slice(0, 4)) !== "icns") die("magic is not 'icns'");
if (u32(4) !== buf.length) die(`header length ${u32(4)} != file length ${buf.length}`);

type Element = { type: string; bytes: Uint8Array };
const elements: Element[] = [];
let off = 8;
while (off < buf.length) {
  if (off + 8 > buf.length) die(`truncated element header at offset ${off}`);
  const type = String.fromCharCode(...buf.slice(off, off + 4));
  const len = u32(off + 4);
  if (len < 8 || off + len > buf.length) die(`element '${type}' has bad length ${len} at offset ${off}`);
  if (type === "TOC ") die("carries a 'TOC ' element, which records element ORDER and would lie after sorting — teach this script to rebuild it before trusting the new CLI's output");
  elements.push({ type, bytes: buf.slice(off, off + len) });
  off += len;
}

elements.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));

const out = new Uint8Array(buf.length);
out.set(buf.slice(0, 8), 0);
let pos = 8;
for (const e of elements) {
  out.set(e.bytes, pos);
  pos += e.bytes.length;
}
if (pos !== buf.length) die(`reassembly landed at ${pos}, expected ${buf.length}`);

await Bun.write(path, out);
