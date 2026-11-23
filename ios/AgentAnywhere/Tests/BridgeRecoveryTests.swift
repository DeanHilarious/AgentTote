// Standalone macOS runner, excluded from the app unless AA_BRIDGE_RECOVERY_UNIT_TESTS is set.
// From the repository root:
// xcrun swiftc -D AA_BRIDGE_RECOVERY_UNIT_TESTS -parse-as-library -swift-version 5 -warnings-as-errors \
//   -module-cache-path /tmp/aa-recovery-module-cache \
//   ios/AgentAnywhere/Models/{Protocol,PairedMac,Feedback}.swift \
//   ios/AgentAnywhere/Networking/{AccountClient,BonjourDiscovery,RelayCrypto,BridgeTransport,BridgeClient,BridgeReadRetry,ConnectionRace,ConnectionDiagnostics}.swift \
//   ios/AgentAnywhere/Tests/BridgeRecoveryTests.swift -o /tmp/aa-bridge-recovery-tests
// /tmp/aa-bridge-recovery-tests
#if AA_BRIDGE_RECOVERY_UNIT_TESTS
import Foundation

@MainActor
private final class RecoveryTransport: BridgeTransport {
    var receiver: CheckedContinuation<String, Error>?
    var buffered: [String] = []
    var sent = 0
    var failSend = false
    var autoHello = true
    var helloReply: String?
    var helloAgents: [String]?
    var closes = 0
    var holdStart = false
    var startWaiter: CheckedContinuation<Void, Error>?
    var pings: [@Sendable (Error?) -> Void] = []

    func start() async throws {
        if holdStart { try await withCheckedThrowingContinuation { startWaiter = $0 } }
    }
    func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void) {
        sent += 1
        if failSend { completion(URLError(.networkConnectionLost)); return }
        let request = try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        if request["method"] as? String == "hello" {
            helloAgents = (request["params"] as? [String: Any])?["agents"] as? [String]
            let reply = "{\"id\":\(request["id"]!),\"result\":{\"name\":\"Mac\",\"version\":\"test\",\"agents\":[]}}"
            if autoHello { deliver(reply) }
            else { helloReply = reply }
        }
        completion(nil)
    }
    func receive() async throws -> String {
        if !buffered.isEmpty { return buffered.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }
    func ping(completion: @escaping @Sendable (Error?) -> Void) { pings.append(completion) }
    func deliver(_ reply: String) {
        if let receiver { self.receiver = nil; receiver.resume(returning: reply) }
        else { buffered.append(reply) }
    }
    func completeHello() { if let reply = helloReply { helloReply = nil; deliver(reply) } }
    func close() {
        closes += 1
        let starting = startWaiter
        startWaiter = nil
        starting?.resume(throwing: CancellationError())
        drop()
    }
    func drop() { let waiting = receiver; receiver = nil; waiting?.resume(throwing: URLError(.networkConnectionLost)) }
    func mappedError(_ error: Error) -> Error { error }
}

@main
@MainActor
private enum BridgeRecoveryTestRunner {
    enum Failure: Error { case disconnected, remote, deadline }
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw NSError(domain: "BridgeRecoveryTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    static func main() async throws {
        for method in ["hello", "agents.list", "agents.icon", "sessions.list", "sessions.messages", "projects.recent", "tasks.list", "tasks.get"] {
            try expect(BridgeReadRetry.allows(method), "Read method missing: \(method)")
        }
        for method in ["tasks.start", "tasks.cancel", "tasks.watch", "push.register", "unknown"] {
            try expect(!BridgeReadRetry.allows(method), "Write/unknown method must not retry: \(method)")
        }
        let disconnected: (Error) -> Bool = { if case Failure.disconnected = $0 { return true }; return false }
        var calls = 0, waits = 0
        let value: Int = try await BridgeReadRetry.call("sessions.messages", isDisconnected: disconnected, waitForReconnect: { waits += 1 }, operation: {
            calls += 1
            if calls == 1 { throw Failure.disconnected }
            return 42
        })
        try expect(value == 42 && calls == 2 && waits == 1, "Read should wait and retry once")
        for method in ["sessions.messages", "tasks.start", "tasks.cancel", "tasks.watch", "push.register"] {
            calls = 0; waits = 0
            do {
                let _: Int = try await BridgeReadRetry.call(method, isDisconnected: disconnected, waitForReconnect: { waits += 1 }, operation: {
                    calls += 1; throw Failure.disconnected
                })
                throw Failure.remote
            } catch Failure.disconnected {}
            try expect(calls == (method == "sessions.messages" ? 2 : 1), "At most one read retry; no write retries")
        }
        for failure in [Failure.remote, .deadline] {
            calls = 0; waits = 0
            do {
                let _: Int = try await BridgeReadRetry.call("tasks.list", isDisconnected: disconnected, waitForReconnect: {
                    waits += 1; throw Failure.deadline
                }, operation: { calls += 1; throw failure == .remote ? Failure.remote : Failure.disconnected })
                throw Failure.disconnected
            } catch Failure.remote {} catch Failure.deadline {}
            try expect(calls == 1, "Remote errors and reconnection deadlines must not retry")
        }

        // Exercise the real client and continuation table with three outstanding RPCs.
        for mode in ["receive", "send", "ping", "pingTimeout", "disconnect"] {
            let client = BridgeClient(), transport = RecoveryTransport()
            var disconnects = 0, failures = 0, unexpected = 0
            client.onDisconnect = { _ in disconnects += 1 }
            _ = try await client.open(transport, helloTimeout: 1)
            try expect(transport.helloAgents == AgentKind.allCases.map(\.rawValue), "hello must list every agent this build decodes")
            let requests = (0..<3).map { _ in Task { @MainActor in
                do { let _: [String] = try await client.call("sessions.messages"); unexpected += 1 }
                catch BridgeClient.ClientError.notConnected { failures += 1 }
                catch { unexpected += 1 }
            } }
            while transport.sent < 4 { await Task.yield() }
            switch mode {
            case "receive": transport.drop()
            case "send":
                transport.failSend = true
                let _: [String]? = try? await client.call("tasks.start")
            case "ping": client.ping(); transport.pings.last?(URLError(.networkConnectionLost))
            case "pingTimeout":
                client.ping(timeout: 30)
                let stale = transport.pings.last
                client.ping(timeout: 0.02, replacingPending: true)
                stale?(nil) // An old pong must not cancel the replacement's deadline.
            default: client.disconnect()
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(1))
            while failures < 3 && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
            try expect(failures == 3 && unexpected == 0, "\(mode): all pending calls must fail immediately as disconnected")
            try expect(disconnects == (mode == "disconnect" ? 0 : 1), "Only one unexpected-disconnect notification")
            for request in requests { await request.value }
        }
        // Race the real client/hello/receive loops, rather than only fake operations.
        for simultaneous in [false, true] {
            let direct = BridgeClient(), relay = BridgeClient()
            let directTransport = RecoveryTransport(), relayTransport = RecoveryTransport()
            directTransport.autoHello = false
            relayTransport.autoHello = false
            let race = ConnectionRace<BridgeClient.Connected>()
            let directPath = ConnectionPath.direct(host: "192.168.1.2", port: 8787)
            var disconnects = 0
            direct.onDisconnect = { _ in disconnects += 1 }
            relay.onDisconnect = { _ in disconnects += 1 }
            race.add(.init(path: directPath, delay: .zero, operation: {
                let hello = try await direct.open(directTransport, helloTimeout: 1)
                return .init(client: direct, path: directPath, hello: hello)
            }, cancel: { direct.disconnect() }))
            race.add(.init(path: .relay, delay: .zero, operation: {
                let hello = try await relay.open(relayTransport, helloTimeout: 1)
                return .init(client: relay, path: .relay, hello: hello)
            }, cancel: { relay.disconnect() }))
            race.finishAdding()
            let result = Task { try await race.value() }
            while directTransport.helloReply == nil || relayTransport.helloReply == nil { await Task.yield() }
            relayTransport.completeHello()
            if simultaneous { directTransport.completeHello() }
            let winner = try await result.value
            for _ in 0..<30 { await Task.yield() }
            try expect(winner.client.isReady && (direct.isOpen != relay.isOpen), "Only the winning real client remains open")
            try expect(directTransport.closes + relayTransport.closes == 1 && disconnects == 0, "Loser closes silently, without reconnect callbacks")
            if !simultaneous { try expect(winner.path == .relay, "First hello must win") }
            winner.client.disconnect()
        }
        // Cancellation during transport startup must close the socket and finish the await.
        let starting = BridgeClient(), startingTransport = RecoveryTransport()
        startingTransport.holdStart = true
        let startup = Task { try await starting.open(startingTransport, helloTimeout: 1) }
        while startingTransport.startWaiter == nil { await Task.yield() }
        startup.cancel()
        do { _ = try await startup.value; throw Failure.remote } catch is CancellationError {}
        try expect(!starting.isOpen && startingTransport.closes == 1, "Cancellation closes a transport blocked in its handshake")

        // Agent enablement updates use the same receive loop as task pushes.
        let client = BridgeClient(), transport = RecoveryTransport()
        var receivedAgents: [AgentInfo] = []
        client.onPush = { push in
            if case .agentsUpdated(let agents) = push { receivedAgents = agents }
        }
        _ = try await client.open(transport, helloTimeout: 1)
        let push = #"{"event":"agents.updated","data":[{"kind":"codex","name":"ChatGPT","status":"ready","runningProcesses":0},{"kind":"workbuddy","name":"WorkBuddy","status":"ready","runningProcesses":0}]}"#
        if let receiver = transport.receiver { transport.receiver = nil; receiver.resume(returning: push) }
        else { transport.buffered.append(push) }
        let pushDeadline = ContinuousClock.now.advanced(by: .seconds(1))
        while receivedAgents.isEmpty && ContinuousClock.now < pushDeadline { await Task.yield() }
        try expect(receivedAgents.map(\.kind) == [.codex, .workbuddy], "Agent update must replace the enabled list")
        client.disconnect()
        print("Bridge recovery checks passed, including real hello races, startup cancellation and agents.updated push decoding.")
    }
}
#endif
