// Store.swift — the authorization gate every non-request mode passes BEFORE an event store exists.
//
// `EKEventStore.authorizationStatus(for:)` is a class method: reading it creates no store and can never raise the
// permission dialog. Only full access constructs a store (`authorizedStore`); every other status is answered as
// fixed text. Raw values, not case names, so the mapping does not depend on which SDK spelling of
// `.authorized` / `.fullAccess` the build machine has (macOS 14: 0 notDetermined, 1 restricted, 2 denied,
// 3 fullAccess, 4 writeOnly).

import EventKit
import Foundation

func authorizationText() -> String {
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0: return "not-granted"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "ok"
    case 4: return "write-only"
    default: return "denied"
    }
}

/// A store, or the status that stops the mode. The ONLY place a non-request mode may construct `EKEventStore`.
func authorizedStore() -> (EKEventStore?, String) {
    let status = authorizationText()
    guard status == "ok" else { return (nil, status) }
    return (EKEventStore(), "ok")
}

/// A flag set from a callback EventKit may run on any queue (its completion handlers and notification blocks are
/// `@Sendable`), read by the waiting loop. A locked reference, so no captured `var` is mutated across queues.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    func raise() { lock.lock(); raised = true; lock.unlock() }
    var isRaised: Bool { lock.lock(); defer { lock.unlock() }; return raised }
}

func helperVersion() -> String {
    return (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
}

/// Run the main run loop until `done()` or the deadline. EventKit delivers its notifications and completion
/// handlers through the main queue on some paths, and pumping the loop drains it.
func pumpRunLoop(until deadline: Date, _ done: () -> Bool) {
    while !done() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.1)))
    }
}

/// The calendars a read or a list covers: `editable` (you can edit it, Birthdays excluded — the default), `all`,
/// or the ids the engine passed.
func selectedCalendars(_ store: EKEventStore, _ inv: Invocation) -> [EKCalendar] {
    let all = store.calendars(for: .event)
    switch inv.select {
    case "all": return all
    case "ids":
        let wanted = Set(inv.calendarIds)
        return all.filter { wanted.contains($0.calendarIdentifier) }
    default: return all.filter { $0.allowsContentModifications && $0.type != .birthday }
    }
}

/// At most `max` Unicode scalars (a grapheme cluster can hold any number of scalars, so counting characters would
/// not bound the bytes).
func capped(_ s: String?, _ max: Int) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    if s.unicodeScalars.count <= max { return s }
    var out = String.UnicodeScalarView()
    out.append(contentsOf: s.unicodeScalars.prefix(max))
    return String(out)
}

func epochMs(_ d: Date) -> Int64 {
    return Int64((d.timeIntervalSince1970 * 1000).rounded())
}

/// The GREGORIAN calendar in the local zone: a Mac set to the Buddhist, Japanese or Hebrew calendar would otherwise
/// give non-Gregorian years and months for every day string the engine reads.
func gregorian() -> Calendar {
    var g = Calendar(identifier: .gregorian)
    g.timeZone = TimeZone.current
    return g
}

/// A date's LOCAL calendar day, `YYYY-MM-DD`.
func localDay(_ d: Date) -> String {
    let c = gregorian().dateComponents([.year, .month, .day], from: d)
    return String(format: "%04ld-%02ld-%02ld", c.year ?? 0, c.month ?? 0, c.day ?? 0)
}
