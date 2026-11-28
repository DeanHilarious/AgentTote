import Foundation

enum BridgeReadRetry {
    static func allows(_ method: String) -> Bool {
        switch method {
        case "hello", "agents.list", "agents.icon", "sessions.list", "sessions.messages", "projects.recent", "tasks.list", "tasks.get", "agentFlow.snapshot", "agentFlow.run": true
        default: false
        }
    }

    /// The second attempt is deliberately outside the catch: a second failure is final.
    @MainActor
    static func call<T>(_ method: String, isDisconnected: (Error) -> Bool,
                        waitForReconnect: () async throws -> Void,
                        operation: () async throws -> T) async throws -> T {
        do { return try await operation() }
        catch {
            guard allows(method), isDisconnected(error) else { throw error }
            try await waitForReconnect()
        }
        return try await operation()
    }
}
