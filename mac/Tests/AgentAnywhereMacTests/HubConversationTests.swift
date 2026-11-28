import XCTest
@testable import AgentAnywhereMac

final class HubConversationTests: XCTestCase {
    func testSuccessfulResultRepeatingTextBlockIsHiddenBeforeHistoryIsWritten() {
        let reply = "Patched the duplicated reply.\nKept the tool row."
        let text = event(seq: 1, ts: 101_600, kind: "text", text: reply)
        let result = event(seq: 2, ts: 102_000, kind: "result", text: reply)
        let conversation = HubConversation(
            task: task(status: .completed, result: reply),
            messages: [],
            events: [text, result]
        )

        XCTAssertTrue(conversation.showsTaskPrompt)
        XCTAssertEqual(conversation.visibleTaskEvents, [text])
    }

    func testTranscriptReplacesPromptAndStreamedReplyBlocksButLeavesToolEvent() {
        let first = "alpha\nbeta"
        let second = "gamma"
        let tool = event(seq: 2, ts: 101_800, kind: "tool", name: "shell")
        let conversation = HubConversation(
            task: task(status: .completed, result: second),
            messages: [
                message(id: "user-current", role: "user", text: prompt, timestamp: 101_000),
                message(id: "assistant-current", role: "assistant", text: "\(first)\n\n\(second)", timestamp: 102_000),
                message(id: "user-next", role: "user", text: "Another prompt", timestamp: 103_000),
            ],
            events: [
                event(seq: 1, ts: 101_650, kind: "text", text: first),
                tool,
                event(seq: 3, ts: 101_900, kind: "text", text: second),
                event(seq: 4, ts: 102_200, kind: "result", text: second),
            ]
        )

        XCTAssertFalse(conversation.showsTaskPrompt)
        XCTAssertEqual(conversation.visibleTaskEvents, [tool])
    }

    func testResultOnlyResponseStaysVisibleWhenHistoryIsMissingOrPartial() {
        let reply = "first line\nsecond line"
        let result = event(seq: 1, ts: 102_000, kind: "result", text: reply)
        let missing = HubConversation(
            task: task(status: .completed, result: reply),
            messages: [],
            events: [result]
        )
        let partial = HubConversation(
            task: task(status: .completed, result: reply),
            messages: [
                message(id: "user-current", role: "user", text: prompt, timestamp: 101_000),
                message(id: "assistant-partial", role: "assistant", text: "first line", timestamp: 102_000),
            ],
            events: [result]
        )

        XCTAssertTrue(missing.showsTaskPrompt)
        XCTAssertEqual(missing.visibleTaskEvents, [result])
        XCTAssertFalse(partial.showsTaskPrompt)
        XCTAssertEqual(partial.visibleTaskEvents, [result])
    }

    func testResultOnlyResponseMovesIntoHistoryWhenTheReplyIsRecorded() {
        let reply = "Plain result"
        let conversation = HubConversation(
            task: task(status: .completed, result: reply),
            messages: [
                message(id: "user-current", role: "user", text: prompt, timestamp: 101_000),
                message(id: "assistant-current", role: "assistant", text: reply, timestamp: 102_000),
            ],
            events: [event(seq: 1, ts: 102_200, kind: "result", text: reply)]
        )

        XCTAssertFalse(conversation.showsTaskPrompt)
        XCTAssertTrue(conversation.visibleTaskEvents.isEmpty)
    }

    func testOlderIdenticalPromptAndReplyDoNotHideTheActiveTurn() {
        let reply = "Same words as an earlier turn."
        let text = event(seq: 1, ts: 101_700, kind: "text", text: reply)
        let tool = event(seq: 2, ts: 101_900, kind: "tool", name: "shell")
        let conversation = HubConversation(
            task: task(status: .running, result: nil),
            messages: [
                message(id: "user-old", role: "user", text: prompt, timestamp: 90_000),
                message(id: "assistant-old", role: "assistant", text: reply, timestamp: 90_500),
            ],
            events: [text, tool]
        )

        XCTAssertTrue(conversation.showsTaskPrompt)
        XCTAssertEqual(conversation.visibleTaskEvents, [text, tool])
    }

    func testAnUndatedMatchingTurnDoesNotHideTheCompletedTask() {
        let reply = "Same words as an undated turn."
        let text = event(seq: 1, ts: 101_700, kind: "text", text: reply)
        let conversation = HubConversation(
            task: task(status: .completed, result: reply),
            messages: [
                message(id: "user-undated", role: "user", text: prompt, timestamp: nil),
                message(id: "assistant-undated", role: "assistant", text: reply, timestamp: nil),
            ],
            events: [text]
        )

        XCTAssertTrue(conversation.showsTaskPrompt)
        XCTAssertEqual(conversation.visibleTaskEvents, [text])
    }

    func testLegitimateFailedResultStaysVisible() {
        let streamed = "Ran the command."
        let failure = "Command exited with status 1."
        let text = event(seq: 1, ts: 101_700, kind: "text", text: streamed)
        let result = event(seq: 2, ts: 102_100, kind: "result", text: failure, isError: true)
        let conversation = HubConversation(
            task: task(status: .failed, result: nil, error: failure),
            messages: [],
            events: [text, result]
        )

        XCTAssertEqual(conversation.visibleTaskEvents, [text, result])
    }

    private let prompt = "Ship the fix"

    private func task(
        status: HubTaskStatus,
        result: String?,
        error: String? = nil
    ) -> HubTaskInfo {
        HubTaskInfo(
            id: "task-1",
            agent: "codex",
            sessionId: "session-1",
            cwd: "/tmp/workspace",
            prompt: prompt,
            permissionMode: .readOnly,
            model: nil,
            effort: nil,
            status: status,
            startedAt: 101_500,
            endedAt: status.isTerminal ? 102_500 : nil,
            result: result,
            error: error,
            costUsd: nil,
            watching: nil
        )
    }

    private func message(id: String, role: String, text: String, timestamp: Double?) -> HubChatMessage {
        HubChatMessage(id: id, role: role, text: text, timestamp: timestamp)
    }

    private func event(
        seq: Int,
        ts: Double,
        kind: String,
        name: String? = nil,
        text: String? = nil,
        isError: Bool? = nil
    ) -> HubTaskEvent {
        HubTaskEvent(
            seq: seq,
            ts: ts,
            kind: kind,
            sessionId: nil,
            text: text,
            path: nil,
            change: nil,
            name: name,
            detail: nil,
            isError: isError
        )
    }
}
