import Foundation
import SwiftUI

// Wire contract shared with Mac bridge (`bridge/src/types.ts`). Keep camelCase field names in sync.

struct AgentFlowUsage: Codable, Hashable {
    let inputTokens: Int
    let outputTokens: Int
    let thinkingTokens: Int
    let cacheReadTokens: Int
    let totalTokens: Int
    let cacheHitRate: Double
    var source: String? = nil

    static let empty = AgentFlowUsage(
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
        source: nil
    )

    /// Uncached direct input tokens. Handles both combined (`input >= cacheRead`) and split token accounting.
    var directInputTokens: Int {
        let input = max(0, inputTokens)
        let cached = max(0, cacheReadTokens)
        return input >= cached ? (input - cached) : input
    }

    var breakdownTotal: Int {
        directInputTokens + max(0, cacheReadTokens) + max(0, outputTokens) + max(0, thinkingTokens)
    }

    var hasTokens: Bool {
        totalTokens > 0 || breakdownTotal > 0
    }
}

struct AgentFlowTeamMember: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let shortName: String
    let account: String
    /// `"orchestrator"` | `"executor"` | `"bridge"`
    let tier: String
    let role: String
    let defaultModel: String
    let accent: String
    let badge: String
    let binName: String
    let status: AgentStatus
    let runningProcesses: Int
    var version: String? = nil
    var detail: String? = nil
    let isBridgeAgent: Bool
}

struct AgentFlowNode: Codable, Hashable, Identifiable {
    let id: String
    let label: String
    let agent: String
    let model: String
    var effort: String? = nil
    /// `"dispatched"` | `"delivered"` | `"accepted"` | `"rejected"` | `"event"`
    let status: String
    let round: Int
    let startedAt: Double
    let updatedAt: Double
    let durationMs: Double
    let summary: String
    var note: String? = nil
    let artifacts: [String]
    let usage: AgentFlowUsage
    let eventCount: Int
}

struct AgentFlowEvent: Codable, Hashable, Identifiable {
    let seq: Int
    let ts: Double
    let sub: String
    let event: String
    let agent: String
    let model: String
    var effort: String? = nil
    let round: Int
    let summary: String
    var note: String? = nil
    let artifacts: [String]
    var usage: AgentFlowUsage? = nil

    var id: Int { seq }
}

struct AgentFlowRunSummary: Codable, Hashable, Identifiable {
    let id: String
    let slug: String
    let name: String
    /// `"agent-flow"` | `"codex-runs"` | `"bridge-live"`
    let source: String
    /// `"dispatched"` | `"delivered"` | `"accepted"` | `"rejected"` | `"idle"`
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

struct AgentFlowRunDetail: Codable, Hashable, Identifiable {
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
    var spec: String? = nil
}

struct AgentFlowSnapshotSummary: Codable, Hashable {
    let totalRuns: Int
    let activeRuns: Int
    let acceptedRuns: Int
    let onlineMembers: Int
    let totalMembers: Int
    let liveTasksCount: Int
    let usage: AgentFlowUsage
}

struct AgentFlowSnapshot: Codable, Hashable {
    let updatedAt: Double
    let summary: AgentFlowSnapshotSummary
    let team: [AgentFlowTeamMember]
    let liveTasks: [TaskInfo]
    let runs: [AgentFlowRunSummary]
}

enum AgentFlowRoute: Hashable {
    case studio
    case run(String)
}

enum AgentFlowFormat {
    static func tokens(_ count: Int) -> String {
        let value = max(0, count)
        if value < 1_000 {
            return "\(value)"
        }
        if value < 999_950 {
            return String(format: "%.1fK", locale: Locale(identifier: "en_US_POSIX"), Double(value) / 1_000.0)
        }
        if value < 999_995_000 {
            return String(format: "%.2fM", locale: Locale(identifier: "en_US_POSIX"), Double(value) / 1_000_000.0)
        }
        return String(format: "%.2fB", locale: Locale(identifier: "en_US_POSIX"), Double(value) / 1_000_000_000.0)
    }

    static func exact(_ count: Int) -> String {
        max(0, count).formatted(.number.locale(Locale(identifier: "en_US")))
    }

    static func duration(ms: Double) -> String {
        guard ms.isFinite, ms >= 0 else { return "—" }
        if ms == 0 { return "0s" }
        if ms < 1_000 {
            return "\(Int(ms.rounded()))ms"
        }
        let totalSeconds = ms / 1_000.0
        if totalSeconds < 10 {
            return String(format: "%.1fs", locale: Locale(identifier: "en_US_POSIX"), totalSeconds)
        }
        let roundedSeconds = Int(totalSeconds.rounded())
        if roundedSeconds < 60 {
            return "\(roundedSeconds)s"
        }
        let hours = roundedSeconds / 3_600
        let minutes = (roundedSeconds % 3_600) / 60
        let seconds = roundedSeconds % 60
        if hours > 0 {
            return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h"
        }
        return seconds > 0 ? "\(minutes)m \(seconds)s" : "\(minutes)m"
    }

    static func relativeTime(_ epochMs: Double, locale: Locale = .current) -> String {
        guard epochMs.isFinite, epochMs > 0 else { return "—" }
        return Date(timeIntervalSince1970: epochMs / 1_000.0)
            .formatted(.relative(presentation: .named, unitsStyle: .abbreviated).locale(locale))
    }

    static func cacheRate(_ rate: Double) -> String {
        guard rate.isFinite, rate >= 0 else { return "0%" }
        let clamped = min(100, rate)
        if clamped == 0 { return "0%" }
        if clamped >= 99.95 { return "100%" }
        return String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), clamped)
    }

    static func agentTint(_ agentId: String) -> Color {
        let key = agentId.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if key == "agy2" || key.contains("agy2") || key.contains("neon") || key.contains("gemini") {
            return Color(red: 0.05, green: 0.65, blue: 0.78)
        }
        if key == "workbuddy" || key.contains("workbuddy") {
            return Color(red: 47 / 255, green: 107 / 255, blue: 255 / 255)
        }
        if key == "codebuddy" || key.contains("codebuddy") || key.contains("buddy") {
            return Color(red: 0.85, green: 0.54, blue: 0.04)
        }
        if key == "antigravity" || key.contains("antigravity") || key.contains("brain") || key.contains("orchestrator") || key == "agy" {
            return Color(red: 142 / 255, green: 92 / 255, blue: 247 / 255)
        }
        if key == "codex" || key.contains("codex") || key.contains("gpt") {
            return Color(red: 0.12, green: 0.65, blue: 0.45)
        }
        if key == "claude" || key.contains("claude") || key.contains("anthropic") {
            return Color(red: 217 / 255, green: 119 / 255, blue: 87 / 255)
        }
        if key == "cursor" || key.contains("cursor") {
            return Color(red: 0.35, green: 0.40, blue: 0.48)
        }
        if key == "arkcli" || key.contains("arkcli") || key.contains("volcengine") || key.contains("ark") {
            return Color(red: 0.86, green: 0.24, blue: 0.54)
        }
        return Color(red: 75 / 255, green: 58 / 255, blue: 240 / 255)
    }

    static func agentDisplayName(_ agentId: String) -> String {
        let key = agentId.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        switch key {
        case "agy2": return "agy2"
        case "codebuddy": return "codebuddy"
        case "arkcli": return "arkcli"
        case "antigravity": return "Antigravity"
        case "codex": return "Codex"
        case "claude": return "Claude"
        case "workbuddy": return "WorkBuddy"
        case "cursor": return "Cursor"
        default: return agentId.isEmpty ? "Agent" : agentId
        }
    }

    static func agentSymbol(_ agentId: String) -> String {
        let key = agentId.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if key.contains("agy2") || key.contains("neon") { return "sparkles" }
        if key.contains("workbuddy") { return "briefcase.fill" }
        if key.contains("codebuddy") { return "wrench.and.screwdriver.fill" }
        if key.contains("antigravity") || key.contains("brain") || key.contains("orchestrator") { return "atom" }
        if key.contains("codex") { return "chevron.left.forwardslash.chevron.right" }
        if key.contains("claude") { return "sparkle" }
        if key.contains("cursor") { return "cursorarrow" }
        if key.contains("arkcli") || key.contains("ark") { return "waveform.and.magnifyingglass" }
        return "cpu"
    }

    static func sourceLabel(_ source: String) -> String {
        switch source.lowercased() {
        case "agent-flow": return "Flow"
        case "codex-runs": return "Codex"
        case "bridge-live": return "Live"
        default: return source
        }
    }

    static func statusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "dispatched": return "Running"
        case "delivered": return "Review"
        case "accepted": return "Accepted"
        case "rejected": return "Rejected"
        case "idle": return "Idle"
        case "event": return "Event"
        default: return status.capitalized
        }
    }
}
