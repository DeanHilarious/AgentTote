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
    private(set) var tasks: [String: HubTaskInfo] = [:]
    private(set) var taskEvents: [String: [HubTaskEvent]] = [:]
    private(set) var taskDrafts: [String: HubTaskDraft] = [:]
    private(set) var sessionsByAgent: [String: [HubSessionSummary]] = [:]
    private(set) var modelsByAgent: [String: [HubModelOption]] = [:]
    private(set) var recentProjects: [HubProjectDir] = []
    var hubInitialSection: HubSection = .commandCenter
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
            tasks = [:]
            taskEvents = [:]
            taskDrafts = [:]
            sessionsByAgent = [:]
            modelsByAgent = [:]
            recentProjects = []
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
        case .taskUpdated(let task):
            tasks[task.id] = task
            if task.status != .running {
                taskDrafts.removeValue(forKey: task.id)
            }
        case .taskEvent(let envelope):
            mergeTaskEvents(taskId: envelope.taskId, incoming: [envelope.event])
            if envelope.event.kind == "text" {
                taskDrafts.removeValue(forKey: envelope.taskId)
            }
        case .taskDelta(let delta):
            taskDrafts[delta.taskId] = Self.applyDelta(current: taskDrafts[delta.taskId], delta: delta)
        case .unknown: break
        }
    }

    var sortedTasks: [HubTaskInfo] {
        tasks.values.sorted { lhs, rhs in
            if (lhs.status == .running) != (rhs.status == .running) {
                return lhs.status == .running
            }
            if lhs.startedAt != rhs.startedAt {
                return lhs.startedAt > rhs.startedAt
            }
            return lhs.id < rhs.id
        }
    }

    private func mergeTaskEvents(taskId: String, incoming: [HubTaskEvent]) {
        guard !incoming.isEmpty else { return }
        var bySeq: [Int: HubTaskEvent] = [:]
        for existing in taskEvents[taskId] ?? [] {
            bySeq[existing.seq] = existing
        }
        for event in incoming {
            bySeq[event.seq] = event
        }
        taskEvents[taskId] = bySeq.values.sorted { $0.seq < $1.seq }
    }

    static func applyDelta(current: HubTaskDraft?, delta: HubTaskDeltaEnvelope) -> HubTaskDraft {
        guard let existing = current, existing.messageId == delta.messageId, delta.offset > 0 else {
            return HubTaskDraft(messageId: delta.messageId, text: delta.text)
        }
        let utf16 = existing.text.utf16
        let clampedOffset = min(delta.offset, utf16.count)
        let prefixUnits = Array(utf16.prefix(clampedOffset))
        let prefix = String(decoding: prefixUnits, as: UTF16.self)
        return HubTaskDraft(messageId: delta.messageId, text: prefix + delta.text)
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

    // MARK: - Desktop AgentHub & Agent-Flow RPCs

    @discardableResult
    func loadSessions(agent: String, limit: Int = 40) async throws -> [HubSessionSummary] {
        let sessions: [HubSessionSummary] = try await bridge.request(
            "sessions.list",
            params: ["agent": .string(agent), "limit": .number(Double(limit))]
        ).decode()
        sessionsByAgent[agent] = sessions
        return sessions
    }

    func loadMessages(agent: String, sessionId: String, limit: Int = 100) async throws -> [HubChatMessage] {
        try await bridge.request(
            "sessions.messages",
            params: [
                "agent": .string(agent),
                "sessionId": .string(sessionId),
                "limit": .number(Double(limit))
            ]
        ).decode()
    }

    @discardableResult
    func loadModels(agent: String) async throws -> [HubModelOption] {
        let result: HubAgentModelsResult = try await bridge.request(
            "agents.models",
            params: ["agent": .string(agent)]
        ).decode()
        modelsByAgent[agent] = result.models
        return result.models
    }

    @discardableResult
    func loadRecentProjects(limit: Int = 30) async throws -> [HubProjectDir] {
        let dirs: [HubProjectDir] = try await bridge.request(
            "projects.recent",
            params: ["limit": .number(Double(limit))]
        ).decode()
        recentProjects = dirs
        return dirs
    }

    @discardableResult
    func syncTasks() async throws -> [HubTaskInfo] {
        let list: [HubTaskInfo] = try await bridge.request("tasks.list").decode()
        var next: [String: HubTaskInfo] = [:]
        for item in list {
            next[item.id] = item
        }
        tasks = next
        let liveIds = Set(next.keys)
        taskDrafts = taskDrafts.filter { liveIds.contains($0.key) && next[$0.key]?.status == .running }
        return list
    }

    @discardableResult
    func loadTaskSnapshot(taskId: String, sinceSeq: Int = 0) async throws -> HubTaskSnapshot {
        let snapshot: HubTaskSnapshot = try await bridge.request(
            "tasks.get",
            params: [
                "taskId": .string(taskId),
                "sinceSeq": .number(Double(sinceSeq))
            ]
        ).decode()
        tasks[snapshot.task.id] = snapshot.task
        mergeTaskEvents(taskId: snapshot.task.id, incoming: snapshot.events)
        if snapshot.task.status == .running, let draft = snapshot.draft {
            taskDrafts[snapshot.task.id] = draft
        } else if snapshot.task.status != .running {
            taskDrafts.removeValue(forKey: snapshot.task.id)
        }
        return snapshot
    }

    @discardableResult
    func startTask(
        agent: String,
        sessionId: String? = nil,
        cwd: String? = nil,
        prompt: String,
        permissionMode: HubPermissionMode = .acceptEdits,
        model: String? = nil,
        effort: String? = nil,
        fork: Bool = false
    ) async throws -> HubTaskInfo {
        var params: [String: JSONValue] = [
            "agent": .string(agent),
            "prompt": .string(prompt),
            "permissionMode": .string(permissionMode.rawValue)
        ]
        if let sessionId, !sessionId.isEmpty {
            params["sessionId"] = .string(sessionId)
        }
        if let cwd, !cwd.isEmpty {
            params["cwd"] = .string(cwd)
        }
        if let model, !model.isEmpty {
            params["model"] = .string(model)
        }
        if let effort, !effort.isEmpty {
            params["effort"] = .string(effort)
        }
        if fork {
            params["fork"] = .bool(true)
        }
        let info: HubTaskInfo = try await bridge.request("tasks.start", params: params).decode()
        tasks[info.id] = info
        return info
    }

    @discardableResult
    func cancelTask(taskId: String) async throws -> HubTaskInfo {
        let info: HubTaskInfo = try await bridge.request(
            "tasks.cancel",
            params: ["taskId": .string(taskId)]
        ).decode()
        tasks[info.id] = info
        if info.status != .running {
            taskDrafts.removeValue(forKey: info.id)
        }
        return info
    }

    func fetchAgentFlowSnapshot(limit: Int = 40) async throws -> AgentFlowSnapshot {
        try await bridge.request(
            "agentFlow.snapshot",
            params: ["limit": .number(Double(limit))]
        ).decode()
    }

    func fetchAgentFlowRun(id: String) async throws -> AgentFlowRunDetail {
        try await bridge.request(
            "agentFlow.run",
            params: ["id": .string(id)]
        ).decode()
    }
}
