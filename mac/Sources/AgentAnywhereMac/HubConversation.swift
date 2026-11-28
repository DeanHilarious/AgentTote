import Foundation

struct HubConversation {
    let showsTaskPrompt: Bool
    let visibleTaskEvents: [HubTaskEvent]

    init(task: HubTaskInfo, messages: [HubChatMessage], events: [HubTaskEvent]) {
        let promptIndex = Self.historyPromptIndex(for: task, in: messages)
        showsTaskPrompt = promptIndex == nil

        let textBlocks = events.filter { $0.kind == "text" }.compactMap { Self.normalized($0.text) }
        let liveReply = textBlocks.joined(separator: "\n\n")
        let historyReply: String?
        if task.status.isTerminal, let promptIndex {
            historyReply = messages.dropFirst(promptIndex + 1)
                .prefix { !$0.isUser }
                .compactMap { Self.normalized($0.text) }
                .joined(separator: "\n\n")
        } else {
            historyReply = nil
        }

        visibleTaskEvents = events.filter { event in
            switch event.kind {
            case "text":
                return liveReply != historyReply
            case "result" where event.isError != true:
                // Some adapters repeat the final text block in their successful result.
                guard let text = Self.normalized(event.text) else { return false }
                return text != textBlocks.last && text != liveReply && text != historyReply
            default:
                return true
            }
        }
    }

    private static func historyPromptIndex(for task: HubTaskInfo, in messages: [HubChatMessage]) -> Int? {
        // Codex's transcript timestamps have second precision.
        let earliest = task.agent == "codex" ? floor(task.startedAt / 1_000) * 1_000 : task.startedAt
        let latest = task.endedAt ?? .infinity
        let prompt = normalized(task.prompt)
        return messages.lastIndex { message in
            guard message.isUser, normalized(message.text) == prompt, let timestamp = message.timestamp else {
                return false
            }
            return timestamp >= earliest && timestamp <= latest
        }
    }

    private static func normalized(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
