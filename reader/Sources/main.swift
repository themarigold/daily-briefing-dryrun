// Daily Briefing Calendar Reader — entry point (v0.3.0 calendar connection, spec r4 §4.1; plan p4 M10a).
//
// A tiny, read-only EventKit helper. The engine copies it to
// `<state>/calendar/reader/Daily Briefing Calendar Reader.app`, re-signs the copy with the stable local identity,
// and starts it through LaunchServices (`open -g -j -n -W <copy> --args <mode> …`, gate G1's trigger (a)), so the
// helper — not the engine, not Terminal — is the process that holds the Calendars permission.
//
//   <mode> --fifo <run>/<id>.fifo --id <id> [--select editable|all] [--calendar <calendar id>]… [--wait <10…120>]
//          [--refresh-wait <0…2>] [--with-url]
//   (`--wait`: `request` only — how many seconds to wait for the person, so the dialog's wait ends inside the
//   engine's own deadline; default and maximum 120.)
//   (`--refresh-wait`: `read` only — how many seconds to wait for the calendar to refresh before reading; default
//   and maximum 2, `refreshWait` in ModeRead.swift; 0 skips the wait. Added at version 2: an older copy refuses it
//   with exit 2, so the engine sends it only to a copy at version 2 or later.)
//
// Modes, one file each: `request` (ModeRequest.swift, the ONLY caller of requestFullAccessToEvents — attended
// flows only, 120 s), `read` (ModeRead.swift), `list` (ModeList.swift), `status` (ModeStatus.swift). `read`, `list`
// and `status` check the authorization status FIRST (Store.swift `authorizedStore`) and answer `not-granted`,
// `write-only`, `denied` or `restricted` without ever creating an event store, so a scheduled run can never raise
// the permission dialog. Nothing here writes to a calendar (test/calendar-reader-source.test.ts scans for it).
//
// Output goes only to the engine's named pipe (Fifo.swift): one JSON document carrying the invocation id and a
// status. LaunchServices connects no stdout and passes no environment, so nothing else could carry it.
//
// Exit codes: 0 a document was written; 1 the pipe was refused or no reader came within 10 s; 2 a usage error;
// 3 the self-deadline (30 s; `request` 135 s) passed.

import Foundation

struct Invocation {
    let mode: String
    let fifo: String
    let id: String
    let select: String           // "editable" | "all" | "ids"
    let calendarIds: [String]
    let wait: TimeInterval
    let withUrl: Bool
    let refreshWait: TimeInterval
}

/// The engine's invocation id: 32 lowercase hex characters (16 random bytes).
func isInvocationId(_ s: String) -> Bool {
    return s.count == 32 && s.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}

func parseArguments(_ args: [String]) -> Invocation? {
    guard let mode = args.first, ["request", "read", "list", "status"].contains(mode) else { return nil }
    var fifo: String?, id: String?, select: String?, wait: Int?, refresh: Int?
    var withUrl = false
    var ids: [String] = []
    var i = 1
    while i < args.count {
        let flag = args[i]
        if flag == "--with-url" {
            guard mode == "read", !withUrl else { return nil }
            withUrl = true
            i += 1
            continue
        }
        guard i + 1 < args.count else { return nil }
        let value = args[i + 1]
        switch flag {
        case "--fifo": if fifo != nil { return nil }; fifo = value
        case "--id": if id != nil { return nil }; id = value
        case "--select":
            guard select == nil, value == "editable" || value == "all" else { return nil }
            select = value
        case "--calendar":
            guard !value.isEmpty, ids.count < 1000 else { return nil }
            ids.append(value)
        case "--wait":
            guard wait == nil, mode == "request", let n = Int(value), n >= 10, n <= 120 else { return nil }
            wait = n
        case "--refresh-wait":
            guard refresh == nil, mode == "read", let n = Int(value), n >= 0, n <= 2 else { return nil }
            refresh = n
        default: return nil
        }
        i += 2
    }
    guard let f = fifo, let inv = id, isInvocationId(inv) else { return nil }
    if select != nil && !ids.isEmpty { return nil }
    return Invocation(mode: mode, fifo: f, id: inv, select: ids.isEmpty ? (select ?? "editable") : "ids", calendarIds: ids,
                      wait: TimeInterval(wait ?? 120), withUrl: withUrl, refreshWait: refresh.map { TimeInterval($0) } ?? refreshWait)
}

guard let invocation = parseArguments(Array(CommandLine.arguments.dropFirst())) else { exit(2) }
// A SELF-DEADLINE: the engine abandons a read at 15 s (a request at 128 s); a helper stuck inside EventKit after
// that must not live on, one more each morning (`open -n` starts a new instance every time).
let selfLimit: TimeInterval = invocation.mode == "request" ? requestTimeout + 15 : 30
DispatchQueue.global().asyncAfter(deadline: .now() + selfLimit) { exit(3) }
// The pipe is checked BEFORE any EventKit call, so a refused path costs nothing and reveals nothing.
guard let pipe = FifoWriter(path: invocation.fifo, id: invocation.id) else { exit(1) }

let document: [String: Any]
switch invocation.mode {
case "request": document = runRequest(invocation)
case "read": document = runRead(invocation)
case "list": document = runList(invocation)
default: document = runStatus()
}
exit(pipe.write(document) ? 0 : 1)
