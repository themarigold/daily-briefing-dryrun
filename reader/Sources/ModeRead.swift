// ModeRead.swift — `read`: the selected calendars' events from LOCAL YESTERDAY 00:00 TO LOCAL TOMORROW 24:00, by
// this helper's own clock (spec r4 §4.1). The window is computed here and nothing the engine passes can widen it;
// the engine filters to today itself. At most 500 events (EventKit's enumeration stop flag), then `truncated`.
//
// First `refreshSourcesIfNecessary()` and a wait of up to 2 s for `EKEventStoreChanged` (`--refresh-wait <0…2>`
// shortens or skips it, version 2), so a Mac that slept overnight sees changes made on another device. (C5, refresh after a real night's sleep, is untested: the G1 VM
// never slept. The engine does not rely on it.)
//
// Raw facts only: the engine cleans every text field, applies the caps and decides who "you" are. Text fields are
// capped here too, so one huge note cannot crowd out the day.

import EventKit
import Foundation

let readMaxEvents = 500
let refreshWait: TimeInterval = 2

func participantStatus(_ p: EKParticipant) -> String? {
    switch p.participantStatus {
    case .accepted: return "accepted"
    case .declined: return "declined"
    case .tentative: return "tentative"
    case .pending: return "needs-action"
    default: return nil
    }
}

func participant(_ p: EKParticipant) -> [String: Any] {
    var out: [String: Any] = ["isCurrentUser": p.isCurrentUser]
    if let name = capped(p.name, 200) { out["name"] = name }
    let url = p.url.absoluteString
    if url.lowercased().hasPrefix("mailto:") { out["email"] = capped(String(url.dropFirst(7)), 320) }
    if let s = participantStatus(p) { out["status"] = s }
    return out
}

func availability(_ e: EKEvent) -> String {
    switch e.availability {
    case .free: return "free"
    case .tentative: return "tentative"
    default: return "busy"
    }
}

func eventStatus(_ e: EKEvent) -> String {
    switch e.status {
    case .canceled: return "cancelled"
    case .tentative: return "tentative"
    default: return "confirmed"
    }
}

/// One second before the end, but never before the start (a zero-length event's last day is its first).
func lastMoment(_ e: EKEvent) -> Date {
    let start: Date = e.startDate
    let end: Date = e.endDate
    let last = end.addingTimeInterval(-1)
    return last < start ? start : last
}

func eventRecord(_ e: EKEvent, withUrl: Bool) -> [String: Any] {
    var out: [String: Any] = [
        "calendarId": e.calendar?.calendarIdentifier ?? "",
        "editable": e.calendar?.allowsContentModifications ?? false,
        "allDay": e.isAllDay,
        "startMs": epochMs(e.startDate),
        "endMs": epochMs(e.endDate),
        "startDay": localDay(e.startDate),
        "endDay": localDay(e.endDate),
        // The last day the event touches (EventKit's all-day end is the last moment of the last day, or the next
        // midnight): the engine's inclusive end date, decided in THIS process's zone, the one Calendar shows.
        "lastDay": localDay(lastMoment(e)),
        "title": capped(e.title, 1000) ?? "",
        "availability": availability(e),
        "status": eventStatus(e),
    ]
    // The FULL identifier (bounded at 4,096 scalars): the engine applies the link parser's rule — kept up to 512,
    // hashed beyond — so a long UID spells the same from both sources and two long UIDs never collide on a prefix.
    if let uid = capped(e.calendarItemExternalIdentifier, 4096) { out["uid"] = uid }
    if e.hasRecurrenceRules || e.isDetached, let occurrence = e.occurrenceDate as Date? {
        out["occurrenceMs"] = epochMs(occurrence)
        out["occurrenceDay"] = localDay(occurrence)
    }
    if let location = capped(e.location, 1000) { out["location"] = location }
    if let notes = capped(e.notes, 4000) { out["notes"] = notes }
    // The URL field is details-only: even its payload bytes must not change a morning read's truncation.
    if withUrl, let url = capped(e.url?.absoluteString, 1000) { out["url"] = url }
    if let modified = e.lastModifiedDate { out["lastModifiedMs"] = epochMs(modified) }
    if let organizer = e.organizer { out["organizer"] = participant(organizer) }
    if let attendees = e.attendees, !attendees.isEmpty { out["attendees"] = attendees.prefix(200).map(participant) }
    return out
}

/// What the enumeration collects. A reference, so the callback mutates no captured `var` (EventKit calls it
/// synchronously, but its block type may be `@Sendable` depending on the SDK).
final class Collector: @unchecked Sendable {
    var events: [[String: Any]] = []
    var truncated = false
}

func runRead(_ inv: Invocation) -> [String: Any] {
    let (maybeStore, status) = authorizedStore()
    guard let store = maybeStore else { return ["status": status, "helperVersion": helperVersion()] }

    let changed = Flag()
    let observer = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { _ in
        changed.raise()
    }
    store.refreshSourcesIfNecessary()
    pumpRunLoop(until: Date().addingTimeInterval(inv.refreshWait)) { changed.isRaised }
    NotificationCenter.default.removeObserver(observer)

    let calendars = selectedCalendars(store, inv)
    // An EMPTY selection must not reach the predicate: `calendars: []`/nil there means EVERY calendar.
    if calendars.isEmpty {
        var none: [String: Any] = ["status": "ok", "helperVersion": helperVersion(), "events": [Any]()]
        if inv.select == "ids" && !inv.calendarIds.isEmpty { none["missingCalendars"] = Set(inv.calendarIds).count }
        return none
    }
    let cal = gregorian()
    let today = cal.startOfDay(for: Date())
    guard let start = cal.date(byAdding: .day, value: -1, to: today),
          let end = cal.date(byAdding: .day, value: 2, to: today) else {
        return ["status": "error", "helperVersion": helperVersion()]
    }
    let found = Collector()
    store.enumerateEvents(matching: store.predicateForEvents(withStart: start, end: end, calendars: calendars)) { e, stop in
        if found.events.count >= readMaxEvents { found.truncated = true; stop.pointee = true; return }
        found.events.append(eventRecord(e, withUrl: inv.withUrl))
    }
    // EventKit's enumeration order is unspecified: put today's events first (then by start), so the 4 MB cap's
    // drop-from-the-end (Fifo.swift) loses yesterday's and tomorrow's before today's.
    let todayStart = epochMs(today)
    let todayEnd = epochMs(cal.date(byAdding: .day, value: 1, to: today) ?? end)
    func key(_ e: [String: Any]) -> (Int, Int64) {
        let s = e["startMs"] as? Int64 ?? 0, t = e["endMs"] as? Int64 ?? 0
        return ((s < todayEnd && t >= todayStart) ? 0 : 1, s)
    }
    let ordered = found.events.sorted { key($0) < key($1) }
    var out: [String: Any] = ["status": "ok", "helperVersion": helperVersion(), "events": ordered]
    if found.truncated { out["truncated"] = true }
    // Chosen calendar ids that no longer exist: the engine reports the read incomplete rather than a free day.
    if inv.select == "ids" {
        let missing = Set(inv.calendarIds).subtracting(calendars.map { $0.calendarIdentifier }).count
        if missing > 0 { out["missingCalendars"] = missing }
    }
    return out
}
