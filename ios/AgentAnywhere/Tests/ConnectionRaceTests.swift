// Standalone runner (no Xcode project changes):
// xcrun swiftc -D AA_CONNECTION_RACE_UNIT_TESTS -parse-as-library -swift-version 5 -warnings-as-errors \
//   -module-cache-path /tmp/aa-race-module-cache ios/AgentAnywhere/Networking/ConnectionRace.swift \
//   ios/AgentAnywhere/Tests/ConnectionRaceTests.swift -o /tmp/aa-connection-race-tests
// /tmp/aa-connection-race-tests
#if AA_CONNECTION_RACE_UNIT_TESTS
import Foundation

@MainActor
private final class TestClock {
    var time: Duration = .zero
    private var waits: [UUID: (Duration, CheckedContinuation<Void, Error>)] = [:]
    func sleep(_ delay: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waits[id] = (time + delay, continuation)
                if Task.isCancelled { cancel(id) }
            }
        } onCancel: { Task { @MainActor in self.cancel(id) } }
    }
    func advance(to time: Duration) {
        self.time = time
        for (id, (deadline, continuation)) in waits where deadline <= time {
            waits[id] = nil
            continuation.resume()
        }
    }
    private func cancel(_ id: UUID) { waits.removeValue(forKey: id)?.1.resume(throwing: CancellationError()) }
}

@MainActor
private final class Attempt {
    var starts = 0
    var closes = 0
    var continuation: CheckedContinuation<Int, Error>?
    func run() async throws -> Int {
        starts += 1
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func succeed(_ value: Int) { let waiting = continuation; continuation = nil; waiting?.resume(returning: value) }
    func fail() { let waiting = continuation; continuation = nil; waiting?.resume(throwing: URLError(.timedOut)) }
    func close() { closes += 1; let waiting = continuation; continuation = nil; waiting?.resume(throwing: CancellationError()) }
}

@main
@MainActor
private enum ConnectionRaceTests {
    static let lan = ConnectionPath.direct(host: "192.168.1.2", port: 8787)
    static let other = ConnectionPath.direct(host: "100.64.1.2", port: 8787)
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
        if !value() { throw NSError(domain: "ConnectionRaceTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func drain() async { for _ in 0..<30 { await Task.yield() } }
    static func candidate(_ path: ConnectionPath, _ attempt: Attempt, delay: Duration = .zero) -> ConnectionRace<Int>.Candidate {
        .init(path: path, delay: delay, operation: { try await attempt.run() }, cancel: { attempt.close() })
    }
    static func main() async throws {
        // First hello wins, every loser closes, and a late completion cannot replace it.
        let direct = Attempt(), relay = Attempt()
        let race = ConnectionRace<Int>()
        race.add(candidate(lan, direct)); race.add(candidate(.relay, relay)); race.finishAdding()
        let value = Task { try await race.value() }
        await drain()
        relay.succeed(2)
        let winner = try await value.value
        try expect(winner == 2 && direct.closes == 1 && relay.closes == 0, "First hello wins; only loser closes")
        direct.succeed(1)
        await drain()
        let retainedWinner = try await race.value()
        try expect(retainedWinner == 2, "Late completion cannot replace winner")

        // Equal-turn successes still leave exactly one winner, regardless of task order.
        let a = Attempt(), b = Attempt(), simultaneous = ConnectionRace<Int>()
        simultaneous.add(candidate(lan, a)); simultaneous.add(candidate(.relay, b)); simultaneous.finishAdding()
        let simultaneousValue = Task { try await simultaneous.value() }
        await drain(); a.succeed(10); b.succeed(20)
        let simultaneousWinner = try await simultaneousValue.value
        try expect([10, 20].contains(simultaneousWinner) && a.closes + b.closes == 1, "Simultaneous success keeps exactly one socket")

        // Verify priority and stagger with a virtual clock, without wall-clock sleeps.
        for preferred: ConnectionPath? in [nil, lan, .relay] {
            let clock = TestClock(), first = Attempt(), second = Attempt(), remote = Attempt()
            let scheduled = ConnectionRace<Int>(sleep: { try await clock.sleep($0) }, now: { clock.time })
            scheduled.add(candidate(lan, first, delay: ConnectionSchedule.delay(for: lan, preferred: preferred)))
            scheduled.add(candidate(other, second, delay: ConnectionSchedule.delay(for: other, preferred: preferred)))
            scheduled.add(candidate(.relay, remote, delay: ConnectionSchedule.delay(for: .relay, preferred: preferred)))
            scheduled.finishAdding()
            await drain()
            try expect(first.starts == (preferred == .relay ? 0 : 1), "Last successful direct starts immediately")
            try expect(second.starts == (preferred == nil ? 1 : 0), "Other direct paths wait 300ms after preferred")
            try expect(remote.starts == (preferred == .relay ? 1 : 0), "Relay starts immediately only when preferred")
            clock.advance(to: .milliseconds(299)); await drain()
            try expect(second.starts == (preferred == nil ? 1 : 0), "No early direct start")
            clock.advance(to: .milliseconds(300)); await drain()
            try expect(first.starts == 1 && second.starts == 1, "All direct candidates join at 300ms")
            try expect(remote.starts == (preferred == .relay ? 1 : 0), "Relay still waits until 400ms")
            clock.advance(to: .milliseconds(400)); await drain()
            try expect(remote.starts == 1, "Relay joins at 400ms")
            scheduled.cancel(); await drain()
            try expect(first.closes == 1 && second.closes == 1 && remote.closes == 1, "Cancellation closes all attempts")
        }

        // All failures are retained, rather than aborting on the first path error.
        let failed = ConnectionRace<Int>(), f1 = Attempt(), f2 = Attempt()
        failed.add(candidate(lan, f1)); failed.add(candidate(.relay, f2)); failed.finishAdding()
        let failure = Task { try await failed.value() }
        await drain(); f1.fail(); await drain()
        try expect(!failed.isFinished, "A failed direct path must not abort relay")
        f2.fail()
        do { _ = try await failure.value; throw URLError(.unknown) }
        catch let error as ConnectionRaceFailure {
            try expect(Set(error.attempts.map(\.path)) == [lan, .relay], "Aggregate includes every failed path")
        }

        // Address refresh can publish a new route after initial dialing has begun.
        let dynamic = ConnectionRace<Int>(), old = Attempt(), fresh = Attempt()
        dynamic.add(candidate(lan, old)); await drain(); old.fail(); await drain()
        try expect(!dynamic.isFinished, "Do not finish while address producer is active")
        dynamic.add(candidate(other, fresh)); dynamic.add(candidate(other, fresh)); dynamic.finishAdding()
        let dynamicValue = Task { try await dynamic.value() }
        await drain(); fresh.succeed(3)
        let refreshedWinner = try await dynamicValue.value
        try expect(refreshedWinner == 3 && fresh.starts == 1, "Fresh address joins once")

        // Cancelling a waiter closes active and not-yet-started paths.
        let clock = TestClock(), cancelled = ConnectionRace<Int>(sleep: { try await clock.sleep($0) }, now: { clock.time })
        let active = Attempt(), delayed = Attempt()
        cancelled.add(candidate(lan, active)); cancelled.add(candidate(.relay, delayed, delay: .milliseconds(400)))
        cancelled.finishAdding()
        let waiting = Task { try await cancelled.value() }
        await drain(); waiting.cancel()
        do { _ = try await waiting.value; throw URLError(.unknown) } catch is CancellationError {}
        await drain()
        try expect(active.closes == 1 && delayed.closes == 1 && delayed.starts == 0, "Waiter cancellation closes delayed and active paths")

        var cache = ConnectionTicketCache()
        let id = UUID(), otherID = UUID(), date = Date(timeIntervalSince1970: 1000)
        cache.insert("opaque-ticket", for: id, requestedAt: date)
        try expect(cache.ticket(for: id, now: date.addingTimeInterval(269)) != nil, "Ticket usable before safety margin")
        try expect(cache.ticket(for: otherID, now: date) == nil, "Tickets are device scoped")
        try expect(cache.ticket(for: id, now: date.addingTimeInterval(270)) == nil, "Discard at 30-second expiry margin")
        try expect(cache.ticket(for: id, now: date) == nil, "Discarded ticket stays removed")
        let payload = Data(#"{"exp":1100}"#.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "")
        cache.insert("header.\(payload).signature", for: id, requestedAt: date)
        try expect(cache.ticket(for: id, now: date.addingTimeInterval(69)) != nil, "Signed earlier expiry is honored")
        try expect(cache.ticket(for: id, now: date.addingTimeInterval(70)) == nil, "Signed expiry safety margin")
        cache.insert("opaque-ticket", for: id, requestedAt: date)
        cache.removeAll()
        try expect(cache.ticket(for: id, now: date) == nil, "Sign-out invalidates credentials")
        print("Connection race checks passed: winner/loser cleanup, simultaneous success, priority, relay stagger, aggregate failure, dynamic discovery, cancellation, ticket expiry.")
    }
}
#endif
