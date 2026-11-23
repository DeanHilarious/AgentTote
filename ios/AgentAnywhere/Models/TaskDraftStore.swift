import Observation

/// Isolates high-frequency Observation invalidations from the durable event list.
@MainActor
@Observable
final class TaskDraftStore {
    private(set) var drafts: [String: TaskDraft] = [:]
    @ObservationIgnored private var rejected: [String: Set<String>] = [:]
    @ObservationIgnored private var revisions: [String: Int] = [:]

    func revision(_ taskId: String) -> Int { revisions[taskId, default: 0] }

    func append(_ delta: TaskDelta) {
        guard !rejected[delta.taskId, default: []].contains(delta.messageId) else { return }
        var draft = drafts[delta.taskId]
        if draft?.messageId != delta.messageId {
            drafts[delta.taskId] = nil
            draft = TaskDraft(messageId: delta.messageId, text: "")
        }
        guard var current = draft else { return }
        guard delta.offset == current.text.utf16.count else {
            rejected[delta.taskId, default: []].insert(delta.messageId)
            return
        }
        current.text += delta.text
        drafts[delta.taskId] = current
        revisions[delta.taskId, default: 0] += 1
    }

    func restore(_ draft: TaskDraft?, taskId: String, sinceRevision: Int) {
        // Pushes can arrive while tasks.get is in flight; don't overwrite a newer valid draft.
        if revision(taskId) != sinceRevision, let current = drafts[taskId] {
            if current.messageId != draft?.messageId || current.text.utf16.count >= (draft?.text.utf16.count ?? 0) { return }
        }
        drafts[taskId] = draft
        rejected[taskId] = nil
        revisions[taskId, default: 0] += 1
    }

    func clear(_ taskId: String) {
        drafts[taskId] = nil
        rejected[taskId] = nil
        revisions[taskId, default: 0] += 1
    }

    func reset() {
        drafts = [:]
        rejected = [:]
        revisions = [:]
    }
}
