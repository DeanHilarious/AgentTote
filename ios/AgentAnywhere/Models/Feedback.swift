import Foundation

struct FeedbackAgent: Identifiable {
    let id: String
    let name: String
    let detail: String

    // The server also accepts retired candidates from older app versions.
    static let candidates: [FeedbackAgent] = [
        .init(id: "gemini-cli", name: "Gemini CLI", detail: "Google's terminal coding agent"),
        .init(id: "copilot-cli", name: "GitHub Copilot CLI", detail: "GitHub's terminal assistant"),
        .init(id: "qwen-code", name: "Qwen Code", detail: "Qwen-powered coding in the terminal"),
        .init(id: "kimi-cli", name: "Kimi CLI", detail: "Kimi's terminal coding agent"),
        .init(id: "trae", name: "Trae", detail: "An AI partner for development"),
        .init(id: "tongyi-lingma", name: "通义灵码", detail: "Tongyi Lingma coding assistant"),
        .init(id: "opencode", name: "OpenCode", detail: "Open source terminal coding agent"),
        .init(id: "aider", name: "Aider", detail: "Pair programming in your terminal"),
        .init(id: "cline", name: "Cline", detail: "An agent for your coding workspace"),
        .init(id: "amp", name: "Amp", detail: "An agent for complex coding tasks"),
        .init(id: "iflow-cli", name: "iFlow CLI", detail: "An assistant for terminal workflows"),
        .init(id: "claude-code", name: "Claude Code", detail: "Anthropic's terminal coding agent")
    ]
}

enum FeedbackKind: String, Encodable, Identifiable {
    case agentRequest = "agent_request", bug, idea, other
    var id: String { rawValue }
}

/// An explicit encoding whitelist. No paths, session text, phone numbers or credentials.
struct FeedbackDiagnostics: Encodable {
    private let strings: [String: String]
    let enabledAgents: [AgentKind]
    static let stringKeys = ["appVersion", "build", "osVersion", "deviceModel", "bridgeVersion", "locale"]

    init(strings: [String: String], enabledAgents: [AgentKind]) {
        self.strings = strings.filter { Self.stringKeys.contains($0.key) }.mapValues {
            String(String.UnicodeScalarView($0.unicodeScalars.prefix(64)))
        }
        self.enabledAgents = AgentKind.allCases.filter { enabledAgents.contains($0) }
    }

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.init(stringValue) }
        init?(intValue: Int) { return nil }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        for (key, value) in strings { try container.encode(value, forKey: Key(key)) }
        try container.encode(enabledAgents, forKey: Key("enabledAgents"))
    }
    var preview: String {
        (Self.stringKeys.compactMap { key in strings[key].map { "\(key): \($0)" } } +
         ["enabledAgents: \(enabledAgents.map(\.rawValue).joined(separator: ", "))"]).joined(separator: "\n")
    }
}

struct FeedbackPayload: Encodable {
    let kind: FeedbackKind
    var agents: [String] = []
    var otherAgent = ""
    var message = ""
    var contactOk = false
    var diagnostics: FeedbackDiagnostics?

    var validationError: String? {
        if agents.count > 10 { return "Choose up to 10 agents." }
        if agents.contains(where: { id in !FeedbackAgent.candidates.contains { $0.id == id } }) { return "Choose an agent from the list." }
        if otherAgent.unicodeScalars.count > 60 { return "Keep the agent name within 60 characters." }
        if message.unicodeScalars.count > 2000 { return "Keep your message within 2,000 characters." }
        if kind == .agentRequest {
            if agents.isEmpty && otherAgent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Choose an agent or enter a name in Other." }
        } else if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Please add a message."
        }
        return nil
    }
}
