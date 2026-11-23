import Foundation
import SwiftUI

// Wire protocol shared with the Mac bridge (bridge/src/types.ts). Keep field names in sync.

enum AgentKind: String, Codable, CaseIterable, Identifiable, Hashable {
    case claude, codex, workbuddy, antigravity, cursor

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claude: "Claude Code"
        case .codex: "ChatGPT"
        case .workbuddy: "WorkBuddy"
        case .antigravity: "Antigravity"
        case .cursor: "Cursor"
        }
    }

    var symbol: String {
        switch self {
        case .claude: "sparkle"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .workbuddy: "briefcase.fill"
        case .antigravity: "atom"
        case .cursor: "cursorarrow"
        }
    }

    var tint: Color {
        switch self {
        case .claude: Color(red: 0.85, green: 0.47, blue: 0.34)
        case .codex: Color(red: 0.25, green: 0.25, blue: 0.30)
        case .workbuddy: Color(red: 0.24, green: 0.48, blue: 0.96)
        case .antigravity: Color(red: 0.56, green: 0.36, blue: 0.97)
        case .cursor: Color(red: 0.22, green: 0.24, blue: 0.28)
        }
    }
}

enum AgentStatus: String, Codable {
    case ready, unavailable, needsLogin
}

struct AgentInfo: Codable, Identifiable, Hashable {
    let kind: AgentKind
    let name: String
    let status: AgentStatus
    let version: String?
    let runningProcesses: Int
    let detail: String?
    var iconHash: String? = nil

    var id: AgentKind { kind }
}

struct ModelOption: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    var description: String? = nil
    var note: String? = nil
    let isDefault: Bool
    var efforts: [String]? = nil
    var defaultEffort: String? = nil
}

struct AgentModelsResult: Decodable {
    let agent: AgentKind
    let models: [ModelOption]
}

struct SessionSummary: Codable, Identifiable, Hashable {
    let id: String
    let agent: AgentKind
    let title: String
    let cwd: String
    let updatedAt: Double
    let running: Bool
    let preview: String?
    /// "mac", "phone" or "cli" when the bridge knows where the session was started.
    var origin: String? = nil
    /// The session this one was copied from.
    var forkedFromId: String? = nil

    var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }
}

// Older or unassigned sessions may omit cwd (or return null).
extension SessionSummary {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        agent = try values.decode(AgentKind.self, forKey: .agent)
        title = try values.decode(String.self, forKey: .title)
        cwd = try values.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        updatedAt = try values.decode(Double.self, forKey: .updatedAt)
        running = try values.decode(Bool.self, forKey: .running)
        preview = try values.decodeIfPresent(String.self, forKey: .preview)
        origin = try values.decodeIfPresent(String.self, forKey: .origin)
        forkedFromId = try values.decodeIfPresent(String.self, forKey: .forkedFromId)
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    enum Role: String, Codable { case user, assistant }
    let id: String
    let role: Role
    let text: String
    let timestamp: Double?
}

enum PermissionMode: String, Codable, CaseIterable, Identifiable {
    case readOnly, acceptEdits, full

    var id: String { rawValue }

    var label: String {
        switch self {
        case .readOnly: "Read only"
        case .acceptEdits: "Edit files"
        case .full: "Full access"
        }
    }

    var explanation: String {
        switch self {
        case .readOnly: "Can read and plan, no changes"
        case .acceptEdits: "Can edit files in the project"
        case .full: "Can run any command without asking"
        }
    }

    var symbol: String {
        switch self {
        case .readOnly: "eye"
        case .acceptEdits: "pencil"
        case .full: "exclamationmark.shield"
        }
    }
}

enum TaskStatus: String, Codable {
    case running, completed, failed, cancelled
}

struct TaskInfo: Codable, Identifiable, Hashable {
    let id: String
    let agent: AgentKind
    var sessionId: String?
    let cwd: String
    let prompt: String
    let permissionMode: PermissionMode
    var status: TaskStatus
    let startedAt: Double
    var endedAt: Double?
    var result: String?
    var error: String?
    var costUsd: Double?
    var watching: Bool?
    var model: String? = nil
    var effort: String? = nil

    func preservingWatching(from current: TaskInfo?) -> TaskInfo {
        var updated = self
        if updated.watching == nil { updated.watching = current?.watching }
        return updated
    }

    var startedDate: Date { Date(timeIntervalSince1970: startedAt / 1000) }
}

struct TaskEvent: Codable, Identifiable, Hashable {
    let seq: Int
    let ts: Double
    /// session | text | tool | status | result. Kept as a string so newer bridges don't break older apps.
    let kind: String
    let sessionId: String?
    let text: String?
    let name: String?
    let detail: String?
    let isError: Bool?
    var path: String? = nil
    var change: String? = nil

    var id: Int { seq }
}

struct ProjectDir: Codable, Identifiable, Hashable {
    let path: String
    let agents: [AgentKind]
    let updatedAt: Double

    var id: String { path }
}

struct HelloResult: Codable {
    let name: String
    let version: String
    let agents: [AgentInfo]
    var deviceId: String?
    var push: PushStatus?
}

struct PushStatus: Codable, Equatable {
    let available: Bool
    let reason: String?
}

struct PushRegisterResult: Decodable { let push: PushStatus }
struct TaskWatchResult: Decodable {
    let taskId: String
    let watching: Bool
    let status: TaskStatus
}

struct TaskDraft: Codable, Equatable {
    let messageId: String
    var text: String
}

struct TaskDelta: Codable {
    let taskId: String
    let messageId: String
    let text: String
    /// UTF-16 code units, matching JavaScript String.length.
    let offset: Int
}

struct TaskSnapshot: Codable {
    let task: TaskInfo
    let events: [TaskEvent]
    let draft: TaskDraft?
}

/// Server pushes: `task.event` and `task.updated`.
enum PushMessage {
    case agentsUpdated([AgentInfo])
    case pushStatus(PushStatus)
    case taskEvent(taskId: String, event: TaskEvent)
    case taskUpdated(TaskInfo)
    case taskDelta(TaskDelta)
}

extension String {
    /// `/Users/me/code/app` → `~/code/app`, which reads better on a phone.
    var abbreviatedPath: String {
        let parts = split(separator: "/", omittingEmptySubsequences: true)
        if parts.count >= 2, parts[0] == "Users" {
            return "~/" + parts.dropFirst(2).joined(separator: "/")
        }
        return self
    }

    var lastPathComponentName: String {
        (self as NSString).lastPathComponent
    }
}
