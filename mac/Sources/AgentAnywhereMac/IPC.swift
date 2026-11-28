import Foundation

enum JSONValue: Codable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }
}

struct IPCFailure: Error, Decodable, LocalizedError, Equatable {
    let code: String
    let message: String
    var retryAfter: Int? = nil

    var errorDescription: String? {
        switch code {
        case "network": return "Can't reach the account server"
        case "invalid_code", "code_expired", "too_many_attempts": return "That code is wrong or has expired."
        case "invalid_credentials": return "Wrong email or password."
        case "email_taken": return "This email already has an account. Sign in instead."
        case "phone_login_disabled": return "Phone sign-in is disabled. Use your bound email."
        case "weak_password": return "Use at least 8 characters."
        case "invalid_key": return "That key didn't work. Check that it was created for this account."
        case "verify_failed": return "Couldn't verify the key: \(message)"
        case "rate_limited":
            if let retryAfter { return "Too many attempts. Try again in \(retryAfter) s." }
            return "Too many attempts. Try again later."
        default: return message
        }
    }
}

struct IPCRequest: Encodable {
    let id: Int
    let method: String
    let params: [String: JSONValue]
}

struct IPCResponse: Decodable {
    let id: Int
    let result: JSONValue?
    let error: IPCFailure?
}

struct HostAddress: Codable, Identifiable, Equatable {
    let address: String
    let kind: String
    var id: String { "\(kind):\(address)" }
}

struct AgentInfo: Codable, Identifiable, Equatable {
    let kind: String
    let name: String
    let status: String
    let enabled: Bool?
    var isEnabled: Bool { enabled ?? true }
    let version: String?
    let runningProcesses: Int
    let detail: String?
    var iconHash: String? = nil
    var iconPath: String? = nil
    var id: String { kind }
    var statusLabel: String {
        switch status {
        case "ready": "Ready"
        case "needsLogin": "Needs sign-in"
        default: "Not installed"
        }
    }
}

struct AccountUser: Codable, Equatable {
    let id: String
    let phone: String?
    let email: String?
    var identity: String { email ?? phone ?? id }
}

struct AccountStatus: Codable, Equatable {
    var user: AccountUser?
    var serverUrl: String
    var state: String
    static let signedOut = AccountStatus(serverUrl: "http://localhost:8790", state: "signedOut")
    var statusLabel: String {
        switch state {
        case "online": "Online"
        case "unreachable": "Can't reach the account server"
        case "revoked": "This Mac's sign-in is no longer valid. Sign in again."
        default: "Signed out"
        }
    }
}

struct RelayStatus: Decodable, Equatable {
    enum State: String, Decodable { case off, connecting, online, error }
    let state: State
    let channels: Int
    static let off = RelayStatus(state: .off, channels: 0)
    var label: String {
        switch state {
        case .off: "Relay: Off"
        case .connecting: "Relay: Connecting…"
        case .online: "Relay: Online · \(channels) \(channels == 1 ? "phone" : "phones")"
        case .error: "Relay: Reconnecting…"
        }
    }
}

enum KeepAwakeMode: String, Decodable, CaseIterable, Identifiable {
    case off, onPower, always
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: "Off"
        case .onPower: "On power adapter"
        case .always: "Always"
        }
    }
}

struct KeepAwakeStatus: Decodable {
    let keepAwake: KeepAwakeMode
    let active: Bool
}

struct BridgeSnapshot: Decodable {
    let disabledAgents: [String]?
    let keepAwake: KeepAwakeMode?
    let keepAwakeActive: Bool?
    let version: String
    let name: String
    let port: Int
    let deviceId: String
    let pairingUrl: String
    let hosts: [HostAddress]
    let clients: Int
    let agents: [AgentInfo]
    let account: AccountStatus
    let relay: RelayStatus?
}

struct BridgeLog: Decodable {
    let time: String
    let message: String
}

struct BridgeNetwork: Decodable {
    let hosts: [HostAddress]
    let pairingUrl: String
}

enum IPCEvent: Decodable {
    case keepAwake(KeepAwakeStatus), relay(RelayStatus), ready(BridgeSnapshot), network(BridgeNetwork), clients(Int), agents([AgentInfo]), account(AccountStatus), log(BridgeLog), fatal(IPCFailure), taskUpdated(HubTaskInfo), taskEvent(HubTaskEventEnvelope), taskDelta(HubTaskDeltaEnvelope), unknown
    private enum Keys: String, CodingKey { case event, data }
    private struct Clients: Decodable { let count: Int }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .event) {
        case "keepAwake": self = .keepAwake(try c.decode(KeepAwakeStatus.self, forKey: .data))
        case "relay": self = .relay(try c.decode(RelayStatus.self, forKey: .data))
        case "ready": self = .ready(try c.decode(BridgeSnapshot.self, forKey: .data))
        case "network": self = .network(try c.decode(BridgeNetwork.self, forKey: .data))
        case "clients": self = .clients(try c.decode(Clients.self, forKey: .data).count)
        case "agents": self = .agents(try c.decode([AgentInfo].self, forKey: .data))
        case "account": self = .account(try c.decode(AccountStatus.self, forKey: .data))
        case "log": self = .log(try c.decode(BridgeLog.self, forKey: .data))
        case "fatal": self = .fatal(try c.decode(IPCFailure.self, forKey: .data))
        case "task.updated": self = .taskUpdated(try c.decode(HubTaskInfo.self, forKey: .data))
        case "task.event": self = .taskEvent(try c.decode(HubTaskEventEnvelope.self, forKey: .data))
        case "task.delta": self = .taskDelta(try c.decode(HubTaskDeltaEnvelope.self, forKey: .data))
        default: self = .unknown
        }
    }
}

struct NDJSONLines {
    private var buffer = Data()
    mutating func append(_ data: Data) -> [Data] {
        buffer.append(data)
        var lines: [Data] = []
        while let end = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<end])
            buffer.removeSubrange(...end)
            if !line.allSatisfy({ $0 == 13 || $0 == 32 || $0 == 9 }) { lines.append(line) }
        }
        return lines
    }
    mutating func finish() -> [Data] {
        defer { buffer.removeAll() }
        return buffer.isEmpty ? [] : [buffer]
    }
}

@MainActor
final class IPCRequests {
    private struct Pending {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeout: Task<Void, Never>
    }
    private var nextID = 0
    private var pending: [Int: Pending] = [:]
    var count: Int { pending.count }
    static func timeout(for method: String) -> TimeInterval {
        if method == "workbuddy.setKey" { return 210 } // Two 90-second verification attempts plus IPC overhead.
        if method.hasPrefix("account.") || method == "tasks.start" || method.hasPrefix("sessions.") || method == "agents.models" {
            return 30
        }
        return 15
    }

    func request(method: String, params: [String: JSONValue] = [:], timeout: TimeInterval? = nil,
                 send: (IPCRequest) throws -> Void) async throws -> JSONValue {
        nextID += 1
        let id = nextID
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                let timer = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(timeout ?? Self.timeout(for: method))) }
                    catch { return }
                    self?.complete(id, with: .failure(IPCFailure(code: "timeout", message: "Bridge request timed out.")))
                }
                pending[id] = Pending(continuation: continuation, timeout: timer)
                do { try send(IPCRequest(id: id, method: method, params: params)) }
                catch { complete(id, with: .failure(error)) }
            }
        } onCancel: {
            Task { @MainActor in self.complete(id, with: .failure(CancellationError())) }
        }
    }

    func receive(_ response: IPCResponse) {
        if let error = response.error { complete(response.id, with: .failure(error)) }
        else { complete(response.id, with: .success(response.result ?? .null)) }
    }

    private func complete(_ id: Int, with result: Result<JSONValue, Error>) {
        guard let item = pending.removeValue(forKey: id) else { return }
        item.timeout.cancel()
        item.continuation.resume(with: result)
    }

    func failAll(_ error: Error) {
        for id in Array(pending.keys) { complete(id, with: .failure(error)) }
    }
}

struct RestartBackoff {
    private var attempt = 0
    mutating func next() -> TimeInterval {
        defer { attempt += 1 }
        return [1.0, 2, 5, 10][safe: attempt] ?? 30
    }
    mutating func reset() { attempt = 0 }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
