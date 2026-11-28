import Foundation
import SwiftUI

// MARK: - Hub Navigation & Control Models

enum HubSection: String, CaseIterable, Identifiable, Hashable {
    case commandCenter
    case agentFlow

    var id: String { rawValue }

    var title: String {
        switch self {
        case .commandCenter: "Command Center"
        case .agentFlow: "Agent-Flow Studio"
        }
    }

    var symbol: String {
        switch self {
        case .commandCenter: "terminal"
        case .agentFlow: "point.3.connected.trianglepath.dotted"
        }
    }
}

enum HubPermissionMode: String, Codable, CaseIterable, Identifiable, Hashable {
    case readOnly
    case acceptEdits
    case full

    var id: String { rawValue }

    var label: String {
        switch self {
        case .readOnly: "Read only"
        case .acceptEdits: "Edit files"
        case .full: "Full access"
        }
    }

    var symbol: String {
        switch self {
        case .readOnly: "eye"
        case .acceptEdits: "pencil.and.outline"
        case .full: "bolt.shield"
        }
    }
}

enum HubTaskStatus: String, Codable, Equatable, Hashable {
    case running
    case completed
    case failed
    case cancelled

    var isTerminal: Bool { self != .running }

    var label: String {
        switch self {
        case .running: "Running"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }
}

struct HubModelOption: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String?
    let note: String?
    let isDefault: Bool
    let efforts: [String]?
    let defaultEffort: String?
}

struct HubAgentModelsResult: Codable, Equatable, Hashable {
    let agent: String
    let models: [HubModelOption]
}

struct HubSessionSummary: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let agent: String
    let title: String
    let cwd: String
    let updatedAt: Double
    let running: Bool
    let preview: String?
    let origin: String?
    let forkedFromId: String?

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if let preview {
            let clean = preview.trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty { return clean }
        }
        return "Untitled Session"
    }
}

struct HubChatMessage: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let role: String
    let text: String
    let timestamp: Double?

    var isUser: Bool { role == "user" }
}

struct HubProjectDir: Codable, Equatable, Identifiable, Hashable {
    let path: String
    let agents: [String]
    let updatedAt: Double

    var id: String { path }

    var folderName: String {
        URL(fileURLWithPath: path).lastPathComponent
    }
}

struct HubTaskInfo: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let agent: String
    let sessionId: String?
    let cwd: String
    let prompt: String
    let permissionMode: HubPermissionMode
    let model: String?
    let effort: String?
    let status: HubTaskStatus
    let startedAt: Double
    let endedAt: Double?
    let result: String?
    let error: String?
    let costUsd: Double?
    let watching: Bool?

    var promptSummary: String {
        let firstLine = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? prompt
        let trimmed = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Task" : trimmed
    }
}

struct HubTaskEvent: Codable, Equatable, Identifiable, Hashable {
    let seq: Int
    let ts: Double
    let kind: String
    let sessionId: String?
    let text: String?
    let path: String?
    let change: String?
    let name: String?
    let detail: String?
    let isError: Bool?

    var id: Int { seq }
}

struct HubTaskDraft: Codable, Equatable, Hashable {
    let messageId: String
    var text: String
}

struct HubTaskSnapshot: Codable, Equatable, Hashable {
    let task: HubTaskInfo
    let events: [HubTaskEvent]
    let draft: HubTaskDraft?
}

struct HubTaskEventEnvelope: Codable, Equatable, Hashable {
    let taskId: String
    let event: HubTaskEvent
}

struct HubTaskDeltaEnvelope: Codable, Equatable, Hashable {
    let taskId: String
    let messageId: String
    let text: String
    let offset: Int
}

// MARK: - Agent-Flow Studio Models

struct AgentFlowUsage: Codable, Equatable, Hashable {
    let inputTokens: Int
    let outputTokens: Int
    let thinkingTokens: Int
    let cacheReadTokens: Int
    let totalTokens: Int
    let cacheHitRate: Double
    let source: String?

    static let empty = AgentFlowUsage(
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        source: nil
    )

    /// Input tokens not served from prompt cache.
    var directInputTokens: Int {
        if inputTokens >= cacheReadTokens {
            return max(0, inputTokens - cacheReadTokens)
        }
        return max(0, inputTokens)
    }

    var segmentTotal: Int {
        max(1, directInputTokens + max(0, cacheReadTokens) + max(0, outputTokens) + max(0, thinkingTokens))
    }
}

struct AgentFlowTeamMember: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let shortName: String
    let account: String
    let tier: String
    let role: String
    let defaultModel: String
    let accent: String
    let badge: String
    let binName: String
    let status: String
    let runningProcesses: Int
    let version: String?
    let detail: String?
    let isBridgeAgent: Bool
}

struct AgentFlowNode: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let label: String
    let agent: String
    let model: String
    let effort: String?
    let status: String
    let round: Int
    let startedAt: Double
    let updatedAt: Double
    let durationMs: Double
    let summary: String
    let note: String?
    let artifacts: [String]
    let usage: AgentFlowUsage
    let eventCount: Int
}

struct AgentFlowEvent: Codable, Equatable, Identifiable, Hashable {
    let seq: Int
    let ts: Double
    let sub: String
    let event: String
    let agent: String
    let model: String
    let effort: String?
    let round: Int
    let summary: String
    let note: String?
    let artifacts: [String]
    let usage: AgentFlowUsage?

    var id: Int { seq }
}

struct AgentFlowRunSummary: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let slug: String
    let name: String
    let source: String
    let status: String
    let createdAt: Double
    let updatedAt: Double
    let durationMs: Double
    let agents: [String]
    let nodeCount: Int
    let acceptedCount: Int
    let rejectedCount: Int
    let eventCount: Int
    let hasSpec: Bool
    let artifacts: [String]
    let usage: AgentFlowUsage
}

struct AgentFlowRunDetail: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let slug: String
    let name: String
    let source: String
    let status: String
    let createdAt: Double
    let updatedAt: Double
    let durationMs: Double
    let agents: [String]
    let nodeCount: Int
    let acceptedCount: Int
    let rejectedCount: Int
    let eventCount: Int
    let hasSpec: Bool
    let artifacts: [String]
    let usage: AgentFlowUsage
    let nodes: [AgentFlowNode]
    let events: [AgentFlowEvent]
    let spec: String?
}

struct AgentFlowSnapshotSummary: Codable, Equatable, Hashable {
    let totalRuns: Int
    let activeRuns: Int
    let acceptedRuns: Int
    let onlineMembers: Int
    let totalMembers: Int
    let liveTasksCount: Int
    let usage: AgentFlowUsage
}

struct AgentFlowSnapshot: Codable, Equatable, Hashable {
    let updatedAt: Double
    let summary: AgentFlowSnapshotSummary
    let team: [AgentFlowTeamMember]
    let liveTasks: [HubTaskInfo]
    let runs: [AgentFlowRunSummary]
}

// MARK: - Formatting & Semantic Styling

enum AgentFlowFormat {
    private static let posix = Locale(identifier: "en_US_POSIX")

    static func tokens(_ count: Int) -> String {
        let clamped = max(0, count)
        if clamped < 1_000 {
            return "\(clamped)"
        }
        if clamped < 1_000_000 {
            let value = Double(clamped) / 1_000.0
            if value >= 100 {
                return String(format: "%.0fK", locale: posix, value)
            }
            return String(format: "%.1fK", locale: posix, value)
        }
        if clamped < 1_000_000_000 {
            let value = Double(clamped) / 1_000_000.0
            return String(format: "%.2fM", locale: posix, value)
        }
        let value = Double(clamped) / 1_000_000_000.0
        return String(format: "%.2fB", locale: posix, value)
    }

    static func exact(_ count: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = true
        formatter.groupingSize = 3
        formatter.groupingSeparator = ","
        return formatter.string(from: NSNumber(value: max(0, count))) ?? "\(max(0, count))"
    }

    static func duration(ms: Double) -> String {
        if !ms.isFinite || ms < 1_000 {
            return "<1s"
        }
        let totalSeconds = Int(ms / 1_000.0)
        if totalSeconds < 60 {
            return "\(totalSeconds)s"
        }
        let hours = totalSeconds / 3_600
        let minutes = (totalSeconds % 3_600) / 60
        let seconds = totalSeconds % 60
        if hours > 0 {
            return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h"
        }
        return seconds > 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m"
    }

    static func relativeTime(_ epochMs: Double, now: Date = Date(), locale: Locale = Locale(identifier: "en")) -> String {
        guard epochMs.isFinite, epochMs > 0 else { return "—" }
        let delta = max(0, now.timeIntervalSince1970 - (epochMs / 1_000.0))
        if locale.language.languageCode == "zh" {
            if delta < 10 { return "刚刚" }
            let formatter = RelativeDateTimeFormatter()
            formatter.locale = locale
            return formatter.localizedString(for: Date(timeIntervalSince1970: epochMs / 1000), relativeTo: now)
        }
        if delta < 10 { return "just now" }
        if delta < 60 { return "\(Int(delta))s ago" }
        if delta < 3_600 { return "\(Int(delta / 60))m ago" }
        if delta < 86_400 { return "\(Int(delta / 3_600))h ago" }
        if delta < 86_400 * 7 { return "\(Int(delta / 86_400))d ago" }
        let date = Date(timeIntervalSince1970: epochMs / 1_000.0)
        return date.formatted(.dateTime.month(.abbreviated).day().locale(locale))
    }

    static func clockTime(_ epochMs: Double) -> String {
        guard epochMs.isFinite, epochMs > 0 else { return "--:--:--" }
        let date = Date(timeIntervalSince1970: epochMs / 1_000.0)
        return date.formatted(date: .omitted, time: .standard)
    }

    static func shortPath(_ path: String) -> String {
        guard !path.isEmpty else { return "—" }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if path == home { return "~" }
        if path.hasPrefix(home + "/") {
            return "~" + path.dropFirst(home.count)
        }
        return path
    }

    static func agentAccent(_ agentId: String) -> Color {
        switch agentId.lowercased() {
        case "claude":
            return Brand.claude
        case "codex":
            return Color(light: 0x168055, dark: 0x34D399)
        case "workbuddy":
            return Brand.workbuddy
        case "antigravity":
            return Brand.antigravity
        case "cursor":
            return Brand.cursor
        case "agy2":
            return Color(light: 0x0891B2, dark: 0x22D3EE)
        case "codebuddy":
            return Color(light: 0xC27803, dark: 0xFBBF24)
        case "arkcli":
            return Color(light: 0xC83E7E, dark: 0xF472B6)
        default:
            return Brand.relay
        }
    }

    static func agentDisplayName(_ agentId: String) -> String {
        switch agentId.lowercased() {
        case "claude": "Claude Code"
        case "codex": "Codex"
        case "workbuddy": "WorkBuddy"
        case "antigravity": "Antigravity"
        case "cursor": "Cursor"
        case "agy2": "agy2"
        case "codebuddy": "codebuddy"
        case "arkcli": "arkcli"
        default: agentId
        }
    }

    static func statusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "dispatched": "Dispatched"
        case "delivered": "Delivered"
        case "accepted": "Accepted"
        case "rejected": "Rejected"
        case "idle": "Idle"
        case "event": "Event"
        default: status.capitalized
        }
    }

    static func statusForeground(_ status: String) -> Color {
        switch status.lowercased() {
        case "accepted": Brand.successText
        case "rejected": Brand.failureText
        case "dispatched": Brand.relayText
        case "delivered": Brand.warningText
        default: Brand.muted
        }
    }

    static func statusBackground(_ status: String) -> Color {
        switch status.lowercased() {
        case "accepted": Brand.successSoft
        case "rejected": Brand.failureSoft
        case "dispatched": Brand.relaySoft
        case "delivered": Brand.warningSoft
        default: Brand.separator
        }
    }

    static func statusStroke(_ status: String) -> Color {
        switch status.lowercased() {
        case "accepted": Brand.success
        case "rejected": Brand.failure
        case "dispatched": Brand.relay
        case "delivered": Brand.warning
        default: Brand.outline
        }
    }

    static func sourceLabel(_ source: String) -> String {
        switch source {
        case "agent-flow": "Flow"
        case "codex-runs": "Codex"
        case "bridge-live": "Live"
        default: source
        }
    }
}
