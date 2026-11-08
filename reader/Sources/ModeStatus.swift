// ModeStatus.swift — `status`: the authorization status and this helper's version. Never creates an event store.

import Foundation

func runStatus() -> [String: Any] {
    return ["status": authorizationText(), "helperVersion": helperVersion()]
}
