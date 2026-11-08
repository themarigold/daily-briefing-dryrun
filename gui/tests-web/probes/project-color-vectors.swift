// The INDEPENDENT oracle for `gui/src/lib/project-color.ts` (Step 0, plan S0-M1-T1).
//
// Run by hand, never by a suite, from `gui/`:
//
//     swift tests-web/probes/project-color-vectors.swift
//
// It prints the literal block that `tests-web/look.check.ts` holds between its
// `// BEGIN swift-vectors` and `// END swift-vectors` lines, so the committed literals can be
// regenerated and compared byte for byte (empty output means identical):
//
//     swift tests-web/probes/project-color-vectors.swift \
//       | diff - <(sed -n '/^\/\/ BEGIN swift-vectors/,/^\/\/ END swift-vectors/p' tests-web/look.check.ts)
//
// Why a second language: the vectors must not come from the code under test, or the check could
// not fail. This file shares no code with the GUI. It takes the RAW labels and implements, itself:
//   - the engine's `norm` (`src/subprojects.ts`, `norm`): lowercase, remove `*` and backticks, trim,
//     then remove trailing `.,;:!?`. So the GUI's port of `norm` (`gui/src/lib/briefing-struct.ts`)
//     is under test too. Three Swift defaults differ from JS and are not used: `String` keys (they
//     merge canonically equivalent labels), Foundation's whitespace set (not JS's `trim` set), and
//     `lowercased()` on a word-final capital sigma (U+03A3, refused below; see `norm`);
//   - the old local app's hash (`daily_briefing/BriefingSlides/SlideContent.swift`, `pillHue`):
//     `h = h &* 33 &+ u.value` over `unicodeScalars`, a 32-bit wrap, then `% 12` instead of `% 360`;
//   - the page rule (hub spec, "The look"): labels in order of first appearance, a taken preferred
//     slot moves to the next free slot (wrapping), and with all 12 taken the preferred slot is reused;
//     a label that normalises to nothing is not a project: it gets `nil` (printed `null`) and takes
//     no slot.
//
// Every non-ASCII label is written with `\u{…}` escapes so no editor or file system can change its
// code points (a composed and a decomposed `é` are different labels, and both are vectors).

import Foundation

let slots: UInt32 = 12

// JavaScript's `String.prototype.trim` set, spelled out from the ECMAScript spec (WhiteSpace plus
// LineTerminator), because Foundation's `.whitespacesAndNewlines` differs from it: it keeps U+FEFF,
// which JS trims, and trims U+0085, which JS keeps.
//   WhiteSpace: U+0009, U+000B, U+000C, U+FEFF, and every Zs scalar (U+0020, U+00A0, U+1680,
//   U+2000-U+200A, U+202F, U+205F, U+3000). LineTerminator: U+000A, U+000D, U+2028, U+2029.
let jsTrim: Set<UInt32> = Set([0x09, 0x0B, 0x0C, 0xFEFF, 0x20, 0xA0, 0x1680, 0x202F, 0x205F, 0x3000,
                               0x0A, 0x0D, 0x2028, 0x2029] + Array(0x2000...0x200A))

// Lowercasing: Swift's `lowercased()` and JS's `toLowerCase()` agree on every label below, but NOT on
// a word-final capital sigma (U+03A3): JS applies the Final_Sigma rule and gives U+03C2, Swift gives
// U+03C3 (measured 2026-10-20). So no label may contain U+03A3; the check below refuses one.
func norm(_ s: String) -> [Unicode.Scalar] {
    precondition(!s.unicodeScalars.contains("\u{3A3}"), "U+03A3 lowercases differently in Swift and JS")
    var t: [Unicode.Scalar] = s.lowercased().unicodeScalars.filter { $0 != "*" && $0 != "`" }
    while let f = t.first, jsTrim.contains(f.value) { t.removeFirst() }
    while let l = t.last, jsTrim.contains(l.value) { t.removeLast() }
    let trailing: Set<Unicode.Scalar> = [".", ",", ";", ":", "!", "?"]
    while let l = t.last, trailing.contains(l) { t.removeLast() }
    return t
}

func preferredSlot(_ label: String) -> Int {
    var h: UInt32 = 5381
    for u in norm(label) { h = h &* 33 &+ u.value }
    return Int(h % slots)
}

// Keyed by the scalar VALUES, never by `String`: Swift's `String` equality is canonical equivalence,
// so a `[String: Int]` would merge a composed and a decomposed `é`, which JS (and the GUI) keep apart.
func assignSlots(_ labels: [String]) -> [Int?] {
    var byKey: [[UInt32]: Int] = [:]
    var taken = Set<Int>()
    var out: [Int?] = []
    for label in labels {
        let key = norm(label).map { $0.value }
        if key.isEmpty { out.append(nil); continue }
        if let s = byKey[key] { out.append(s); continue }
        let pref = preferredSlot(label)
        var s = pref
        if taken.count < Int(slots) {
            while taken.contains(s) { s = (s + 1) % Int(slots) }
        }
        taken.insert(s)
        byKey[key] = s
        out.append(s)
    }
    return out
}

/// A TypeScript string literal: printable ASCII as itself, everything else as `\u{HEX}`.
func tsString(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case " "..."~": out.unicodeScalars.append(u)
        default: out += "\\u{" + String(u.value, radix: 16, uppercase: true) + "}"
        }
    }
    return out + "\""
}

let labels: [String] = [
    "mono",
    "Mono",
    "**Mono**",
    "`mono`",
    "Mono.",
    "  Mono!? ",
    "\tMONO\n",
    "accountant_ai",
    "quant_stocks",
    "quant_options",
    "daily_briefing_application",
    "btc_forecaster_live",
    "ai_news",
    "Personal Code",
    "personal_code",
    "Mixed_Case-Name",
    "`**Deep**`",
    "a.b.c.",
    "x",
    "",
    "**",
    "Caf\u{E9}",
    "\u{C9}COLE",
    "e\u{301}cole",
    "na\u{EF}ve-app",
    "\u{1F680} launch",
    "rocket \u{1F680}",
    "\u{65E5}\u{672C}\u{8A9E}",
    "cafe\u{301}",
    "\u{FEFF}mono",
    "mono\u{85}",
    "\u{3000}mono\u{2028}",
    "proj-y",
]

// Page 1: thirteen distinct labels. proj-m collides with proj-a (next free slot), proj-b then
// collides with proj-m's slot, proj-v collides at slot 11 and wraps to 0, proj-w is pushed on to 1,
// and with all 12 slots taken the 13th (proj-n) reuses its preferred slot.
// Page 2: decorated spellings of one project share one slot and take no second one.
// Page 3: twelve distinct labels where the TWELFTH collides: eleven slots are taken, proj-y prefers
// a taken one (2) and must get the one free slot left (1), not its preferred slot.
// Page 4: a composed and a decomposed `é` are two labels (two slots); `Café` is the composed one again.
// Page 5: labels that normalise to nothing (`""`, `"**"`) get no slot, so proj-c keeps its preferred
// slot, which `""` would otherwise have taken.
let pages: [[String]] = [
    ["proj-a", "proj-m", "proj-b", "proj-j", "proj-v", "proj-w", "proj-d", "proj-e", "proj-f", "proj-g",
     "proj-h", "proj-i", "proj-n"],
    ["Mono", "proj-x", "mono", "**Mono**", "`mono`.", "proj-l"],
    ["proj-a", "proj-m", "proj-b", "proj-c", "proj-d", "proj-e", "proj-f", "proj-g", "proj-h", "proj-i",
     "proj-k", "proj-y"],
    ["caf\u{E9}", "cafe\u{301}", "Caf\u{E9}"],
    ["Mono", "", "**", "mono", "dba", "proj-c"],
]

print("// BEGIN swift-vectors (generated, from gui/: swift tests-web/probes/project-color-vectors.swift)")
print("const SLOT_VECTORS: ReadonlyArray<readonly [string, number]> = [")
for l in labels { print("  [\(tsString(l)), \(preferredSlot(l))],") }
print("];")
print("const PAGE_VECTORS: ReadonlyArray<readonly [readonly string[], readonly (number | null)[]]> = [")
for p in pages {
    let ls = p.map(tsString).joined(separator: ", ")
    let ss = assignSlots(p).map { $0.map(String.init) ?? "null" }.joined(separator: ", ")
    print("  [[\(ls)], [\(ss)]],")
}
print("];")
print("// END swift-vectors")
