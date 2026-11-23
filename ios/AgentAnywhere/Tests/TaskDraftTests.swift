// Standalone macOS runner: compile Protocol.swift, TaskDraftStore.swift and this file
// with -D AA_DRAFT_UNIT_TESTS -parse-as-library; disabled in the regular iOS build.
#if AA_DRAFT_UNIT_TESTS
import Foundation

@main
@MainActor
private enum TaskDraftTestRunner {
    static func main() throws {
        let store = TaskDraftStore()
        func delta(_ text: String, _ offset: Int, _ message: String = "one") {
            store.append(TaskDelta(taskId: "task", messageId: message, text: text, offset: offset))
        }
        func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
            if !condition() { throw NSError(domain: "TaskDraftTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        delta("你😀", 0)
        delta("好", 3)
        try expect(store.drafts["task"]?.text == "你😀好", "UTF-16 offsets must match the bridge")
        delta("duplicate", 0)
        delta("must wait for final", 4)
        try expect(store.drafts["task"]?.text == "你😀好", "A mismatch must reject the rest of that message")
        store.clear("task")
        try expect(store.drafts.isEmpty, "Final messages and terminal statuses must clear drafts")
        delta("missing prefix", 10)
        try expect(store.drafts.isEmpty, "Missing initial batches must not render a truncated message")
        let revision = store.revision("task")
        store.restore(TaskDraft(messageId: "one", text: "snapshot"), taskId: "task", sinceRevision: revision)
        delta("!", 8)
        try expect(store.drafts["task"]?.text == "snapshot!", "A snapshot must recover a rejected stream")
        let oldRevision = store.revision("task")
        delta("new", 0, "two")
        store.restore(TaskDraft(messageId: "one", text: "old snapshot"), taskId: "task", sinceRevision: oldRevision)
        try expect(store.drafts["task"]?.messageId == "two", "A response must not overwrite a newer message")
        let secondRevision = store.revision("task")
        delta("er", 3, "two")
        store.restore(TaskDraft(messageId: "two", text: "new"), taskId: "task", sinceRevision: secondRevision)
        try expect(store.drafts["task"]?.text == "newer", "A response must not truncate a newer draft")
        let snapshotData = Data(#"{"task":{"id":"t","agent":"codex","cwd":"/tmp","prompt":"p","permissionMode":"readOnly","status":"running","startedAt":1},"events":[],"draft":{"messageId":"item","text":"half"}}"#.utf8)
        let snapshot = try JSONDecoder().decode(TaskSnapshot.self, from: snapshotData)
        try expect(snapshot.draft?.text == "half", "tasks.get draft decoding failed")
        let legacyData = Data(#"{"task":{"id":"t","agent":"codex","cwd":"/tmp","prompt":"p","permissionMode":"readOnly","status":"running","startedAt":1},"events":[]}"#.utf8)
        let legacy = try JSONDecoder().decode(TaskSnapshot.self, from: legacyData)
        try expect(legacy.draft == nil, "Legacy snapshots must remain compatible")
        store.reset()
        try expect(store.drafts.isEmpty, "Changing Mac must reset streaming state")
        print("Draft checks passed: UTF-16, gaps/duplicates, snapshots, stale responses, message switch, clear and legacy decoding.")
    }
}
#endif
