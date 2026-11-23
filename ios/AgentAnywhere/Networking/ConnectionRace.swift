import Foundation

/// A route identity is local-only. Diagnostics deliberately emit only `kind`.
enum ConnectionPath: Hashable, Codable {
    case direct(host: String, port: Int)
    case relay

    var kind: String {
        switch self { case .direct: "direct"; case .relay: "relay" }
    }
}

enum ConnectionSchedule {
    static func delay(for path: ConnectionPath, preferred: ConnectionPath?) -> Duration {
        if path == preferred { return .zero }
        if case .relay = path { return preferred == .relay ? .zero : .milliseconds(400) }
        return preferred == nil ? .zero : .milliseconds(300)
    }
}

struct ConnectionRaceFailure: LocalizedError {
    struct Attempt { let path: ConnectionPath; let error: Error }
    let attempts: [Attempt]
    var errorDescription: String? { "All connection paths failed (\(attempts.count) attempts)." }
    /// Preserve existing authentication/offline hint semantics after collecting every failure.
    var underlyingError: Error {
        attempts.first(where: { $0.path == .relay })?.error ?? attempts.last?.error ?? URLError(.cannotConnectToHost)
    }
}

/// Isolated, injectable scheduling. A producer may add freshly discovered routes while
/// attempts are running. Only a hello-complete value can win; cancellation closes losers
/// synchronously, including operations which haven't responded to Task cancellation yet.
@MainActor
final class ConnectionRace<Value> {
    struct Candidate {
        let path: ConnectionPath
        let delay: Duration
        let operation: @MainActor () async throws -> Value
        let cancel: @MainActor () -> Void
    }
    private struct Running { let task: Task<Void, Never>; let cancel: @MainActor () -> Void }
    private let sleep: @MainActor (Duration) async throws -> Void
    private let now: @MainActor () -> Duration
    private let startedAt: Duration
    private let report: @MainActor (String, ConnectionPath?, Duration) -> Void
    private var running: [ConnectionPath: Running] = [:]
    private var seen: Set<ConnectionPath> = []
    private var failures: [ConnectionRaceFailure.Attempt] = []
    private var accepting = true
    private var result: Result<Value, Error>?
    private var waiter: CheckedContinuation<Value, Error>?

    init(sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
         now: @escaping @MainActor () -> Duration = { .seconds(ProcessInfo.processInfo.systemUptime) },
         report: @escaping @MainActor (String, ConnectionPath?, Duration) -> Void = { _, _, _ in }) {
        self.sleep = sleep
        self.now = now
        self.report = report
        startedAt = now()
        report("start", nil, .zero)
    }

    var isFinished: Bool { result != nil }

    func add(_ candidate: Candidate) {
        guard result == nil, seen.insert(candidate.path).inserted else { return }
        let task = Task { @MainActor in
            let remaining = candidate.delay - (self.now() - self.startedAt)
            do {
                if remaining > .zero { try await self.sleep(remaining) }
                try Task.checkCancellation()
                guard self.result == nil else { return }
                self.report("attempt-start", candidate.path, self.now() - self.startedAt)
                let value = try await candidate.operation()
                try Task.checkCancellation()
                guard self.result == nil else { candidate.cancel(); return }
                self.running.removeValue(forKey: candidate.path)
                self.report("winner", candidate.path, self.now() - self.startedAt)
                self.complete(.success(value))
            } catch {
                guard self.result == nil else { return }
                candidate.cancel()
                self.running.removeValue(forKey: candidate.path)
                self.failures.append(.init(path: candidate.path, error: error))
                self.report("attempt-failed", candidate.path, self.now() - self.startedAt)
                self.finishIfExhausted()
            }
        }
        running[candidate.path] = Running(task: task, cancel: candidate.cancel)
    }

    func finishAdding() { accepting = false; finishIfExhausted() }

    func value() async throws -> Value {
        try await withTaskCancellationHandler {
            if Task.isCancelled { cancel(); throw CancellationError() }
            if let result { return try result.get() }
            return try await withCheckedThrowingContinuation { waiter = $0 }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    func cancel() { if result == nil { complete(.failure(CancellationError())) } }

    private func finishIfExhausted() {
        if !accepting, running.isEmpty, result == nil {
            complete(.failure(ConnectionRaceFailure(attempts: failures)))
        }
    }

    private func complete(_ outcome: Result<Value, Error>) {
        guard result == nil else { return }
        result = outcome
        let losers = running
        running.removeAll()
        for (path, loser) in losers {
            loser.task.cancel()
            loser.cancel()
            report("attempt-cancelled", path, now() - startedAt)
        }
        report("end", nil, now() - startedAt)
        waiter?.resume(with: outcome)
        waiter = nil
    }
}

/// In-memory credentials only. Use the earlier of the signed expiry and five minutes
/// from request start, with a safety margin for the handshake and phone suspension.
struct ConnectionTicketCache {
    private struct Entry { let ticket: String; let expiresAt: Date }
    private var entries: [UUID: Entry] = [:]

    mutating func insert(_ ticket: String, for device: UUID, requestedAt: Date) {
        let parts = ticket.split(separator: ".")
        var expiry = requestedAt.addingTimeInterval(300)
        if parts.count == 3 {
            var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
            if let data = Data(base64Encoded: payload),
               let claims = try? JSONDecoder().decode(Expiry.self, from: data) {
                expiry = min(expiry, Date(timeIntervalSince1970: claims.exp))
            }
        }
        entries[device] = Entry(ticket: ticket, expiresAt: expiry)
    }

    mutating func ticket(for device: UUID, now: Date = Date()) -> String? {
        guard let entry = entries[device] else { return nil }
        guard entry.expiresAt.timeIntervalSince(now) > 30 else { entries[device] = nil; return nil }
        return entry.ticket
    }

    mutating func removeAll() { entries.removeAll() }
    private struct Expiry: Decodable { let exp: Double }
}
