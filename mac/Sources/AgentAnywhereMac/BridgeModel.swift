import Foundation
import Observation

struct LogLine: Identifiable, Equatable {
    let id = UUID()
    let time: Date
    let source: String
    let message: String
    var formatted: String { "[\(time.formatted(date: .omitted, time: .standard))] [\(source)] \(message)" }
}

struct LogBuffer {
    private(set) var lines: [LogLine] = []
    let capacity: Int
    init(capacity: Int = 1000) { self.capacity = max(0, capacity) }
    mutating func append(_ line: LogLine) {
        lines.append(line)
        if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
    }
    mutating func clear() { lines.removeAll() }
}

struct LogRedactor {
    private var tokens: Set<String> = []
    mutating func remember(pairingURL: String) {
        if let token = URLComponents(string: pairingURL)?.queryItems?.first(where: { $0.name == "token" })?.value {
            tokens.insert(token)
            if let encoded = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { tokens.insert(encoded) }
        }
    }
    func redact(_ message: String) -> String {
        var safe = message.replacingOccurrences(of: "agentanywhere://pair[^\\s\"'<>]*", with: "[pairing URL redacted]", options: [.regularExpression, .caseInsensitive])
        safe = safe.replacingOccurrences(of: "\\btoken(?:=|%3d)[^\\s&\"'<>]+", with: "token=[redacted]", options: [.regularExpression, .caseInsensitive])
        for token in tokens where !token.isEmpty { safe = safe.replacingOccurrences(of: token, with: "[redacted]") }
        return safe
    }
}

@MainActor
@Observable
final class BridgeModel {
    private(set) var state: BridgeRunState = .stopped
    private(set) var keepAwake = KeepAwakeMode.onPower
    private(set) var keepAwakeActive = false
    private(set) var version = ""
    private(set) var name = ""
    private(set) var port = 8787
    private(set) var deviceId = ""
    private(set) var pairingUrl = ""
    private(set) var hosts: [HostAddress] = []
    private(set) var clients = 0
    private(set) var agents: [AgentInfo] = []
    private(set) var disabledAgents: [String] = []
    private(set) var relay = RelayStatus.off
    private(set) var account = AccountStatus.signedOut
    private(set) var logs = LogBuffer()
    private(set) var fatalCode: String?
    private(set) var restarting = false
    private(set) var shuttingDown = false
    @ObservationIgnored let bridge: BridgeProcess
    @ObservationIgnored private var redactor = LogRedactor()

    init(bridge: BridgeProcess? = nil) {
        self.bridge = bridge ?? BridgeProcess()
        self.bridge.onState = { [weak self] in self?.setState($0) }
        self.bridge.onEvent = { [weak self] in self?.handle($0) }
        self.bridge.onLog = { [weak self] message, source in self?.appendLog(message, source: source) }
    }

    var isRunning: Bool { state == .running }
    var symbol: String {
        switch state {
        case .running: clients > 0 ? "iphone.radiowaves.left.and.right" : "desktopcomputer"
        case .starting: "arrow.triangle.2.circlepath"
        case .stopped: "desktopcomputer"
        case .failed: "exclamationmark.triangle.fill"
        }
    }
    var portConflictMessage: String {
        "Port \(port) is in use — another AgentTote bridge (Terminal or the old login item) is probably running."
    }

    func start() {
        guard !shuttingDown else { return }
        readConfiguredPort()
        bridge.start()
    }

    private func readConfiguredPort() {
        let env = ProcessInfo.processInfo.environment
        let directory = env["AGENTANYWHERE_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".agentanywhere")
        if let data = try? Data(contentsOf: directory.appendingPathComponent("bridge.json")),
           let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let port = config["port"] as? Int { self.port = port }
    }

    private func setState(_ state: BridgeRunState) {
        self.state = state
        if state == .starting { fatalCode = nil; readConfiguredPort() }
        if state != .running {
            keepAwakeActive = false
            relay = .off
            clients = 0
            pairingUrl = ""
            hosts = []
            agents = []
        }
    }

    func handle(_ event: IPCEvent) {
        switch event {
        case .ready(let snapshot): apply(snapshot); state = .running; fatalCode = nil
        case .network(let network):
            redactor.remember(pairingURL: network.pairingUrl)
            hosts = network.hosts
            pairingUrl = network.pairingUrl
        case .keepAwake(let status): keepAwake = status.keepAwake; keepAwakeActive = status.active
        case .relay(let relay): self.relay = relay
        case .clients(let count): clients = count
        case .agents(let agents):
            self.agents = agents
            disabledAgents = agents.filter { !$0.isEnabled }.map(\.kind)
        case .account(let account): self.account = account
        case .log(let log): appendLog(log.message, source: "bridge", time: Self.logDate(log.time))
        case .fatal(let reason):
            fatalCode = reason.code
            setState(.failed(redactor.redact(reason.message)))
            appendLog(reason.message, source: "bridge")
        case .unknown: break
        }
    }

    private func apply(_ snapshot: BridgeSnapshot) {
        redactor.remember(pairingURL: snapshot.pairingUrl)
        keepAwake = snapshot.keepAwake ?? .onPower
        keepAwakeActive = snapshot.keepAwakeActive ?? false
        version = snapshot.version
        name = snapshot.name
        port = snapshot.port
        deviceId = snapshot.deviceId
        pairingUrl = snapshot.pairingUrl
        hosts = snapshot.hosts
        clients = snapshot.clients
        agents = snapshot.agents
        disabledAgents = snapshot.disabledAgents ?? snapshot.agents.filter { !$0.isEnabled }.map(\.kind)
        account = snapshot.account
        relay = snapshot.relay ?? .off
    }

    private static func logDate(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value) ?? Date()
    }

    func appendLog(_ message: String, source: String, time: Date = Date()) {
        for line in redactor.redact(message).components(separatedBy: .newlines) {
            logs.append(LogLine(time: time, source: source, message: line))
        }
    }
    func clearLogs() { logs.clear() }

    func refreshStatus() async throws {
        let snapshot: BridgeSnapshot = try await bridge.request("status").decode()
        apply(snapshot)
    }

    func refreshAgents() async throws {
        let list: [AgentInfo] = try await bridge.request("agents.refresh").decode()
        agents = list
        disabledAgents = list.filter { !$0.isEnabled }.map(\.kind)
    }

    func connectWorkBuddy(apiKey: String) async throws {
        _ = try await bridge.request("workbuddy.setKey", params: ["apiKey": .string(apiKey)])
    }

    func disconnectWorkBuddy() async throws {
        _ = try await bridge.request("workbuddy.clearKey")
    }

    func rotatePairing() async throws {
        struct Rotation: Decodable { let pairingUrl: String }
        let rotation: Rotation = try await bridge.request("pairing.rotate").decode()
        redactor.remember(pairingURL: rotation.pairingUrl)
        pairingUrl = rotation.pairingUrl
        try await refreshStatus()
    }

    func setConfig(name: String, port: Int, keepAwake: KeepAwakeMode) async throws -> Bool {
        var params: [String: JSONValue] = ["name": .string(name), "keepAwake": .string(keepAwake.rawValue)]
        if port != self.port { params["port"] = .number(Double(port)) }
        struct Result: Decodable { let restartRequired: Bool }
        let result: Result = try await bridge.request("config.set", params: params).decode()
        try await refreshStatus()
        return result.restartRequired
    }

    func setAgent(_ kind: String, enabled: Bool) async throws {
        let next = enabled ? disabledAgents.filter { $0 != kind } : Array(Set(disabledAgents + [kind])).sorted()
        _ = try await bridge.request("config.set", params: ["disabledAgents": .array(next.map { .string($0) })])
        try await refreshStatus()
    }

    func restart() async {
        guard !restarting, !shuttingDown else { return }
        restarting = true
        defer { restarting = false }
        readConfiguredPort()
        await bridge.restart { !self.shuttingDown }
    }

    func shutdown() async {
        shuttingDown = true
        await bridge.stop()
    }

    /// The updater has stopped the bridge but could not hand off to its installer.
    func resumeAfterFailedUpdate() {
        shuttingDown = false
        start()
    }
}
