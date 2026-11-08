// Fifo.swift — the ONLY output channel (spec r4 §4.1 "Output: a pipe, never a file at rest").
//
// The engine creates `<state>/calendar/reader/run/<id>.fifo` (the folder 0700, BESIDE the bundle, never inside it —
// writing inside a signed bundle breaks its seal), opens the read end without blocking, holds its own write end, and
// polls until one JSON document parses. This side:
//   • derives the run folder from its OWN bundle location (`<bundle>/../run`), never from the environment (which
//     LaunchServices does not pass) or from an argument;
//   • accepts only `<that folder>/<id>.fifo`, after resolving symlinks on both sides, and only when `lstat` shows a
//     FIFO — a regular file, a symlink or anything else is refused, so the helper can never be made to write event
//     data to a file at rest or outside its folder;
//   • opens it O_WRONLY|O_NONBLOCK|O_NOFOLLOW, retrying while no reader is connected (ENXIO) for at most 10 s, then
//     exits; and re-checks the opened descriptor is a FIFO;
//   • refuses a `run` folder that is a symlink, another user's, or open to others (group/world bits);
//   • writes one document, newline-terminated, carrying the invocation id, capped at 4 MB (events are dropped from
//     the end and `truncated` set until it fits), within a 10 s write deadline (a reader that stops draining
//     cannot hang the helper, or `open -W`, forever).

import Darwin
import Foundation

let payloadCapBytes = 4 * 1024 * 1024
let noReaderTimeout: TimeInterval = 10
let writeTimeout: TimeInterval = 10

final class FifoWriter {
    private let fd: Int32
    private let id: String

    init?(path: String, id: String) {
        self.id = id
        signal(SIGPIPE, SIG_IGN)   // an engine that gave up closes its end: EPIPE, not a killed helper
        let runDir = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("run", isDirectory: true)
        var dst = stat()
        guard lstat(runDir.path, &dst) == 0, (dst.st_mode & S_IFMT) == S_IFDIR, dst.st_uid == getuid(),
              (dst.st_mode & 0o077) == 0 else { return nil }
        let wanted = runDir.resolvingSymlinksInPath().appendingPathComponent("\(id).fifo").path
        let given = URL(fileURLWithPath: path).deletingLastPathComponent().resolvingSymlinksInPath()
            .appendingPathComponent(URL(fileURLWithPath: path).lastPathComponent).path
        guard given == wanted else { return nil }
        var st = stat()
        guard lstat(wanted, &st) == 0, (st.st_mode & S_IFMT) == S_IFIFO else { return nil }

        let deadline = Date().addingTimeInterval(noReaderTimeout)
        var opened: Int32 = -1
        while opened < 0 {
            opened = open(wanted, O_WRONLY | O_NONBLOCK | O_NOFOLLOW)
            if opened >= 0 { break }
            guard errno == ENXIO, Date() < deadline else { return nil }
            usleep(100_000)
        }
        var fst = stat()
        guard fstat(opened, &fst) == 0, (fst.st_mode & S_IFMT) == S_IFIFO else { close(opened); return nil }
        // Stays non-blocking: `write` waits with poll() under a deadline instead.
        self.fd = opened
    }

    /// Serialise, cap and write the document. True when every byte was written.
    func write(_ document: [String: Any]) -> Bool {
        defer { close(fd) }
        var doc = document
        doc["v"] = 1
        doc["id"] = id
        guard var data = serialise(doc) else { return false }
        if data.count > payloadCapBytes, var events = doc["events"] as? [Any] {
            while data.count > payloadCapBytes && !events.isEmpty {
                events.removeLast(max(1, events.count / 4))
                doc["events"] = events
                doc["truncated"] = true
                guard let smaller = serialise(doc) else { return false }
                data = smaller
            }
        }
        guard data.count <= payloadCapBytes else { return false }
        data.append(0x0A)
        let deadline = Date().addingTimeInterval(writeTimeout)
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n >= 0 { offset += n; continue }
                if errno == EINTR { continue }
                guard errno == EAGAIN else { return false }
                let left = deadline.timeIntervalSinceNow
                if left <= 0 { return false }
                var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = poll(&p, 1, Int32(min(left, 1) * 1000))
            }
            return true
        }
    }

    private func serialise(_ doc: [String: Any]) -> Data? {
        // An invalid object raises an Objective-C exception that `try?` cannot catch: check first.
        guard JSONSerialization.isValidJSONObject(doc) else { return nil }
        return try? JSONSerialization.data(withJSONObject: doc, options: [])
    }
}
