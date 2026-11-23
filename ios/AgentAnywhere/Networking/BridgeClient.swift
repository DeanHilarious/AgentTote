import Foundation

/// JSON-RPC over a WebSocket to the Mac bridge. Requests are `{id, method, params}`;
/// the bridge answers `{id, result}` / `{id, error}` and pushes `{event, data}`.
@MainActor
final class BridgeClient {
    enum ClientError: LocalizedError {
        case bridgeOffline
        case notConnected
        case timeout
        case unauthorized
        case badAddress(String)

        var errorDescription: String? {
            switch self {
            case .bridgeOffline: "Your Mac is offline or asleep."
            case .notConnected: "Not connected to your Mac."
            case .timeout: "The Mac didn't answer in time."
            case .unauthorized: "The Mac rejected the pairing token. Scan the QR code again."
            case .badAddress: "Invalid connection address. Check your Mac connection or the AgentTote service settings."
            }
        }
    }

    struct RemoteError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    var onPush: ((PushMessage) -> Void)?
    /// Called when an established connection drops (not when `disconnect()` is called).
    var onDisconnect: ((Error) -> Void)?

    private let urlSession = URLSession(configuration: .default)
    private var socket: (any BridgeTransport)?
    /// Bumped on every new socket so callbacks from an old one are ignored.
    private var generation = 0
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var heartbeatTask: Task<Void, Never>?
    private var pongTimeoutTask: Task<Void, Never>?
    private var pingID: UUID?
    private var established = false
    private var receiveTask: Task<Void, Never>?
    private var requestTimeouts: [Int: Task<Void, Never>] = [:]

    deinit {
        heartbeatTask?.cancel()
        pongTimeoutTask?.cancel()
        receiveTask?.cancel()
        for task in requestTimeouts.values { task.cancel() }
        urlSession.invalidateAndCancel()
    }

    struct Connected {
        let client: BridgeClient
        let path: ConnectionPath
        let hello: HelloResult
        var host: String {
            if case .direct(let host, _) = path { return host }
            return ""
        }
    }

    /// Each candidate owns its continuation table, generation and receive loop.
    /// The caller installs only the winning client after checking its own epoch.
    static func connect(to mac: PairedMac, token: String) async throws -> Connected {
        let race = ConnectionRace<Connected>(report: ConnectionDiagnostics.reporter())
        for host in mac.orderedHosts {
            let candidate = BridgeClient()
            let path = ConnectionPath.direct(host: host, port: mac.port)
            let preferred = mac.lastGoodHost.map { ConnectionPath.direct(host: $0, port: mac.port) }
            race.add(.init(path: path, delay: ConnectionSchedule.delay(for: path, preferred: preferred), operation: {
                let hello = try await candidate.open(host: host, port: mac.port, token: token)
                return Connected(client: candidate, path: path, hello: hello)
            }, cancel: { candidate.disconnect() }))
        }
        race.finishAdding()
        return try await race.value()
    }

    func disconnect() {
        teardown(error: ClientError.notConnected, notify: false)
    }

    var isOpen: Bool { socket != nil }
    var isReady: Bool { established && socket != nil }

    /// Also used to check an established socket immediately after a phone path change.
    func ping(timeout: Double = 5, replacingPending: Bool = false) {
        guard established, let ws = socket else { return }
        if replacingPending {
            pongTimeoutTask?.cancel()
            pingID = nil
        }
        guard pingID == nil else { return }
        let id = UUID()
        let epoch = generation
        pingID = id
        pongTimeoutTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
            guard let self, self.generation == epoch, self.pingID == id else { return }
            self.teardown(error: ClientError.timeout, notify: true)
        }
        ws.ping { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self, self.generation == epoch, self.socket === ws, self.pingID == id else { return }
                self.pongTimeoutTask?.cancel()
                self.pongTimeoutTask = nil
                self.pingID = nil
                if let error { self.teardown(error: ws.mappedError(error), notify: true) }
            }
        }
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self else { return }
                self.ping()
            }
        }
    }

    func call<T: Decodable>(_ method: String, _ params: [String: Any?] = [:], timeout: Double = 30) async throws -> T {
        guard let ws = socket else { throw ClientError.notConnected }
        let id = nextId
        nextId += 1
        let body: [String: Any] = ["id": id, "method": method, "params": params.compactMapValues { $0 }]
        let payload = String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
        let data: Data = try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            ws.send(payload) { [self] error in
                guard let error else { return }
                Task { @MainActor [weak self] in
                    guard let self, self.socket === ws else { return }
                    self.teardown(error: ws.mappedError(error), notify: self.established)
                }
            }
            requestTimeouts[id] = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .seconds(timeout)) } catch { return }
                self?.fail(id, ClientError.timeout)
            }
        }
        return try JSONDecoder().decode(ResultBox<T>.self, from: data).result
    }

    // MARK: - Internals

    func open(host: String, port: Int, token: String) async throws -> HelloResult {
        let hostPart = host.contains(":") ? "[\(host)]" : host
        guard let url = URL(string: "ws://\(hostPart):\(port)/") else { throw ClientError.badAddress(host) }
        var request = URLRequest(url: url, timeoutInterval: 1.5)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await open(DirectTransport(session: urlSession, request: request), helloTimeout: 3)
    }

    func connectRelay(server: String, deviceId: UUID, publicKey: String, accessToken: String, ticket: String) async throws -> HelloResult {
        disconnect()
        return try await open(RelayTransport(session: urlSession, server: server, deviceId: deviceId,
                                             publicKey: publicKey, accessToken: accessToken, ticket: ticket), helloTimeout: 6)
    }

    func open(_ ws: any BridgeTransport, helloTimeout: Double) async throws -> HelloResult {
        generation += 1
        let epoch = generation
        socket = ws
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                try await ws.start()
                try Task.checkCancellation()
                guard socket === ws, generation == epoch else { throw ClientError.notConnected }
                receiveLoop(ws, generation: epoch)
                // The bridge hides agents this build cannot decode.
                let hello: HelloResult = try await call("hello", ["agents": AgentKind.allCases.map(\.rawValue)], timeout: helloTimeout)
                try Task.checkCancellation()
                guard socket === ws, generation == epoch else { throw ClientError.notConnected }
                established = true
                startHeartbeat()
                return hello
            } catch {
                let mapped = ws.mappedError(error)
                if socket === ws { teardown(error: mapped, notify: false) }
                throw mapped
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.generation == epoch else { return }
                self.disconnect()
            }
        }
    }

    private func receiveLoop(_ ws: any BridgeTransport, generation gen: Int) {
        receiveTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    let text = try await ws.receive()
                    guard let self, gen == self.generation else { return }
                    self.handle(Data(text.utf8))
                } catch {
                    guard let self, gen == self.generation else { return }
                    self.teardown(error: ws.mappedError(error), notify: self.established)
                    return
                }
            }
        }
    }

    private func handle(_ data: Data) {
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return }
        if let id = envelope.id {
            requestTimeouts.removeValue(forKey: id)?.cancel()
            guard let cont = pending.removeValue(forKey: id) else { return }
            if let error = envelope.error { cont.resume(throwing: RemoteError(message: error.message)) }
            else { cont.resume(returning: data) }
            return
        }
        switch envelope.event {
        case "agents.updated":
            if let push = try? JSONDecoder().decode(PushBox<[AgentInfo]>.self, from: data) {
                onPush?(.agentsUpdated(push.data))
            }
        case "push.status":
            if let push = try? JSONDecoder().decode(PushBox<PushStatus>.self, from: data) {
                onPush?(.pushStatus(push.data))
            }
        case "task.event":
            if let push = try? JSONDecoder().decode(PushBox<TaskEventPush>.self, from: data) {
                onPush?(.taskEvent(taskId: push.data.taskId, event: push.data.event))
            }
        case "task.delta":
            if let push = try? JSONDecoder().decode(PushBox<TaskDelta>.self, from: data) {
                onPush?(.taskDelta(push.data))
            }
        case "task.updated":
            if let push = try? JSONDecoder().decode(PushBox<TaskInfo>.self, from: data) {
                onPush?(.taskUpdated(push.data))
            }
        default:
            break
        }
    }

    private func fail(_ id: Int, _ error: Error) {
        requestTimeouts.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    private func teardown(error: Error, notify: Bool) {
        receiveTask?.cancel()
        receiveTask = nil
        for task in requestTimeouts.values { task.cancel() }
        requestTimeouts.removeAll()
        heartbeatTask?.cancel()
        heartbeatTask = nil
        pongTimeoutTask?.cancel()
        pongTimeoutTask = nil
        pingID = nil
        established = false
        let ws = socket
        socket = nil
        generation += 1
        ws?.close()
        let waiting = pending
        pending.removeAll()
        // RPC consumers need a stable disconnection error, independent of the transport
        // or ping failure that triggered teardown. Keep the original cause for connection UI.
        for cont in waiting.values { cont.resume(throwing: ClientError.notConnected) }
        if notify, ws != nil { onDisconnect?(error) }
    }

    private struct Envelope: Decodable {
        struct RpcError: Decodable { let message: String }
        let id: Int?
        let event: String?
        let error: RpcError?
    }

    private struct ResultBox<T: Decodable>: Decodable { let result: T }
    private struct PushBox<T: Decodable>: Decodable { let data: T }
    private struct TaskEventPush: Decodable {
        let taskId: String
        let event: TaskEvent
    }
}
