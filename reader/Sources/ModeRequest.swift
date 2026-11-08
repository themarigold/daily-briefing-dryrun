// ModeRequest.swift — `request`: ask for full Calendar access. ATTENDED FLOWS ONLY (Settings' "Allow access" and
// `daily-briefing calendar connect mac`); a scheduled run never launches this mode. The ONLY file that may call
// `requestFullAccessToEvents` (pinned by test/calendar-reader-source.test.ts). A 120 s limit, so a person has time
// to read and answer the dialog (spec r4 §4.1); the engine waits a little longer than that.

import EventKit
import Foundation

let requestTimeout: TimeInterval = 120

func runRequest(_ inv: Invocation) -> [String: Any] {
    let before = authorizationText()
    // Already decided: asking again shows nothing (macOS answers from its stored decision), so say what it is.
    // Write-only access is still asked, but measured on macOS 26.6.2 (W3 VM sitting, 2026-10-12): no upgrade dialog
    // appears and the answer is write-only at once — the person changes it in System Settings instead.
    if before != "not-granted" && before != "write-only" { return ["status": before, "helperVersion": helperVersion()] }
    let store = EKEventStore()
    let finished = Flag()
    store.requestFullAccessToEvents { _, _ in finished.raise() }
    pumpRunLoop(until: Date().addingTimeInterval(min(requestTimeout, inv.wait))) { finished.isRaised }
    if !finished.isRaised { return ["status": "timeout", "helperVersion": helperVersion()] }
    return ["status": authorizationText(), "helperVersion": helperVersion()]
}
