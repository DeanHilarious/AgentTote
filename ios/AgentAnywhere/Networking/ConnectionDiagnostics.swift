import Foundation
import os

@MainActor
enum ConnectionDiagnostics {
    static func reporter() -> @MainActor (String, ConnectionPath?, Duration) -> Void {
        #if DEBUG
        let logger = Logger(subsystem: "com.deanhilarious.agentanywhere", category: "connection")
        let id = UUID().uuidString
        return { phase, path, elapsed in
            let components = elapsed.components
            let milliseconds = Double(components.seconds) * 1000 + Double(components.attoseconds) / 1e15
            // Do not log credentials, error descriptions, hostnames or addresses.
            logger.debug("race=\(id, privacy: .public) phase=\(phase, privacy: .public) path=\(path?.kind ?? "all", privacy: .public) elapsed_ms=\(milliseconds, privacy: .public)")
        }
        #else
        return { _, _, _ in }
        #endif
    }
}
