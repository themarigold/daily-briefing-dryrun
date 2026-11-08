// ModeList.swift — `list`: the Mac's event calendars, for Settings' checklist (spec r4 §8). Titles and account
// names only; no events. Gated by `authorizedStore` like `read`.

import EventKit
import Foundation

func calendarType(_ c: EKCalendar) -> String {
    switch c.type {
    case .subscription: return "subscribed"
    case .birthday: return "birthdays"
    default: return "standard"
    }
}

func runList(_ inv: Invocation) -> [String: Any] {
    let (maybeStore, status) = authorizedStore()
    guard let store = maybeStore else { return ["status": status, "helperVersion": helperVersion()] }
    let calendars: [[String: Any]] = store.calendars(for: .event).prefix(500).map { (c: EKCalendar) -> [String: Any] in
        [
            "id": c.calendarIdentifier,
            "title": capped(c.title, 200) ?? "",
            "account": capped(c.source?.title, 200) ?? "",
            "editable": c.allowsContentModifications,
            "type": calendarType(c),
        ]
    }
    return ["status": "ok", "helperVersion": helperVersion(), "calendars": calendars]
}
