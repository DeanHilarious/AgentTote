import XCTest
@testable import AgentAnywhereMac

final class AgentFlowModelsTests: XCTestCase {
    func testAgentFlowSnapshotDecoding() throws {
        let json = """
        {
          "updatedAt": 1764140000000,
          "summary": {
            "totalRuns": 3,
            "activeRuns": 1,
            "acceptedRuns": 2,
            "onlineMembers": 6,
            "totalMembers": 8,
            "liveTasksCount": 1,
            "usage": {
              "inputTokens": 50000,
              "outputTokens": 12000,
              "thinkingTokens": 4000,
              "cacheReadTokens": 35000,
              "totalTokens": 66000,
              "cacheHitRate": 70.0,
              "source": "mixed"
            }
          },
          "team": [
            {
              "id": "antigravity",
              "name": "Antigravity",
              "shortName": "总控大脑",
              "account": "Orchestrator",
              "tier": "orchestrator",
              "role": "总控大脑",
              "defaultModel": "Antigravity Orchestrator",
              "accent": "#A78BFA",
              "badge": "BRAIN",
              "binName": "agy",
              "status": "ready",
              "runningProcesses": 1,
              "version": "1.2.0",
              "detail": "Ready",
              "isBridgeAgent": true
            },
            {
              "id": "agy2",
              "name": "agy2 CLI",
              "shortName": "agy2 · Neon",
              "account": "Account B",
              "tier": "executor",
              "role": "Design & Ops",
              "defaultModel": "Gemini 4 Neon",
              "accent": "#22D3EE",
              "badge": "DESIGN · OPS",
              "binName": "agy2",
              "status": "ready",
              "runningProcesses": 0,
              "detail": "/usr/local/bin/agy2",
              "isBridgeAgent": false
            }
          ],
          "liveTasks": [
            {
              "id": "task-1",
              "agent": "claude",
              "sessionId": "sess-1",
              "cwd": "/Users/test/repo",
              "prompt": "Implement AgentHub",
              "permissionMode": "acceptEdits",
              "model": "claude-sonnet-4-5",
              "effort": "high",
              "status": "running",
              "startedAt": 1764139990000,
              "costUsd": 0.12
            }
          ],
          "runs": [
            {
              "id": "agenttote-agent-flow",
              "slug": "agenttote-agent-flow",
              "name": "AgentTote Studio",
              "source": "agent-flow",
              "status": "dispatched",
              "createdAt": 1764139000000,
              "updatedAt": 1764140000000,
              "durationMs": 45000,
              "agents": ["antigravity", "agy2", "codex"],
              "nodeCount": 2,
              "acceptedCount": 1,
              "rejectedCount": 0,
              "eventCount": 4,
              "hasSpec": true,
              "artifacts": ["/Users/test/repo/mac/Sources/AgentAnywhereMac/App.swift"],
              "usage": {
                "inputTokens": 40000,
                "outputTokens": 10000,
                "thinkingTokens": 2000,
                "cacheReadTokens": 30000,
                "totalTokens": 52000,
                "cacheHitRate": 75.0
              }
            }
          ]
        }
        """

        let snapshot = try JSONDecoder().decode(AgentFlowSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.summary.totalRuns, 3)
        XCTAssertEqual(snapshot.summary.onlineMembers, 6)
        XCTAssertEqual(snapshot.summary.usage.cacheHitRate, 70.0)
        XCTAssertEqual(snapshot.summary.usage.directInputTokens, 15000)
        XCTAssertEqual(snapshot.team.count, 2)
        XCTAssertEqual(snapshot.team[1].isBridgeAgent, false)
        XCTAssertEqual(snapshot.liveTasks.first?.status, .running)
        XCTAssertEqual(snapshot.liveTasks.first?.permissionMode, .acceptEdits)
        XCTAssertEqual(snapshot.runs.first?.id, "agenttote-agent-flow")
        XCTAssertEqual(snapshot.runs.first?.hasSpec, true)
    }

    func testAgentFlowRunDetailDecoding() throws {
        let json = """
        {
          "id": "codex:phase-2a",
          "slug": "phase-2a",
          "name": "Phase 2A Native Mac",
          "source": "codex-runs",
          "status": "accepted",
          "createdAt": 1764139000000,
          "updatedAt": 1764140000000,
          "durationMs": 128000,
          "agents": ["agy2"],
          "nodeCount": 1,
          "acceptedCount": 1,
          "rejectedCount": 0,
          "eventCount": 2,
          "hasSpec": true,
          "artifacts": ["/tmp/output.swift"],
          "usage": {
            "inputTokens": 20000,
            "outputTokens": 8000,
            "thinkingTokens": 1500,
            "cacheReadTokens": 12000,
            "totalTokens": 29500,
            "cacheHitRate": 60.0,
            "source": "rollout"
          },
          "nodes": [
            {
              "id": "sub-mac-ui",
              "label": "Native macOS Studio",
              "agent": "agy2",
              "model": "gemini-4-neon",
              "effort": "high",
              "status": "accepted",
              "round": 1,
              "startedAt": 1764139000000,
              "updatedAt": 1764139128000,
              "durationMs": 128000,
              "summary": "Implemented AgentHub and Agent-Flow Studio",
              "note": "All SwiftPM tests pass",
              "artifacts": ["/tmp/output.swift"],
              "usage": {
                "inputTokens": 20000,
                "outputTokens": 8000,
                "thinkingTokens": 1500,
                "cacheReadTokens": 12000,
                "totalTokens": 29500,
                "cacheHitRate": 60.0
              },
              "eventCount": 2
            }
          ],
          "events": [
            {
              "seq": 1,
              "ts": 1764139000000,
              "sub": "sub-mac-ui",
              "event": "dispatched",
              "agent": "agy2",
              "model": "gemini-4-neon",
              "round": 1,
              "summary": "Dispatched subtask",
              "artifacts": []
            },
            {
              "seq": 2,
              "ts": 1764139128000,
              "sub": "sub-mac-ui",
              "event": "accepted",
              "agent": "agy2",
              "model": "gemini-4-neon",
              "effort": "high",
              "round": 1,
              "summary": "Verified build and tests",
              "note": "Clean",
              "artifacts": ["/tmp/output.swift"],
              "usage": {
                "inputTokens": 20000,
                "outputTokens": 8000,
                "thinkingTokens": 1500,
                "cacheReadTokens": 12000,
                "totalTokens": 29500,
                "cacheHitRate": 60.0
              }
            }
          ],
          "spec": "# Spec\\nImplement native macOS Studio."
        }
        """

        let detail = try JSONDecoder().decode(AgentFlowRunDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.id, "codex:phase-2a")
        XCTAssertEqual(detail.nodes.count, 1)
        XCTAssertEqual(detail.nodes.first?.effort, "high")
        XCTAssertEqual(detail.events.count, 2)
        XCTAssertEqual(detail.events.last?.usage?.totalTokens, 29500)
        XCTAssertEqual(detail.spec, "# Spec\nImplement native macOS Studio.")
    }

    @MainActor
    func testTaskIPCEventsAndBridgeModelState() throws {
        let model = BridgeModel()

        let taskUpdatedJSON = """
        {
          "event": "task.updated",
          "data": {
            "id": "t-1",
            "agent": "codex",
            "sessionId": "s-1",
            "cwd": "/Users/test/project",
            "prompt": "Fix build error",
            "permissionMode": "full",
            "model": "gpt-5-codex",
            "status": "running",
            "startedAt": 1764140000000
          }
        }
        """
        let updatedEvent = try JSONDecoder().decode(IPCEvent.self, from: Data(taskUpdatedJSON.utf8))
        guard case .taskUpdated(let taskInfo) = updatedEvent else {
            return XCTFail("Expected .taskUpdated")
        }
        XCTAssertEqual(taskInfo.id, "t-1")
        XCTAssertEqual(taskInfo.permissionMode, .full)
        model.handle(updatedEvent)
        XCTAssertEqual(model.tasks["t-1"]?.status, .running)

        // Task events: out of order + duplicate seq should deduplicate and sort by seq.
        let ev2JSON = #"{"event":"task.event","data":{"taskId":"t-1","event":{"seq":2,"ts":1764140002000,"kind":"file","path":"/tmp/a.swift","change":"modified"}}}"#
        let ev1JSON = #"{"event":"task.event","data":{"taskId":"t-1","event":{"seq":1,"ts":1764140001000,"kind":"tool","name":"Read","detail":"App.swift"}}}"#
        let ev2DupJSON = #"{"event":"task.event","data":{"taskId":"t-1","event":{"seq":2,"ts":1764140002500,"kind":"file","path":"/tmp/a.swift","change":"created"}}}"#

        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(ev2JSON.utf8)))
        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(ev1JSON.utf8)))
        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(ev2DupJSON.utf8)))

        let events = model.taskEvents["t-1"] ?? []
        XCTAssertEqual(events.map(\.seq), [1, 2])
        XCTAssertEqual(events[0].name, "Read")
        XCTAssertEqual(events[1].change, "created")

        // Task deltas: UTF-16 offset handling (including emoji surrogate pair = 2 UTF-16 units)
        let d1JSON = #"{"event":"task.delta","data":{"taskId":"t-1","messageId":"m-1","text":"Hi 🚀 ","offset":0}}"#
        let d2JSON = #"{"event":"task.delta","data":{"taskId":"t-1","messageId":"m-1","text":"world","offset":6}}"#
        let d3JSON = #"{"event":"task.delta","data":{"taskId":"t-1","messageId":"m-2","text":"Fresh","offset":0}}"#

        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(d1JSON.utf8)))
        XCTAssertEqual(model.taskDrafts["t-1"]?.text, "Hi 🚀 ")
        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(d2JSON.utf8)))
        XCTAssertEqual(model.taskDrafts["t-1"]?.text, "Hi 🚀 world")
        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(d3JSON.utf8)))
        XCTAssertEqual(model.taskDrafts["t-1"]?.messageId, "m-2")
        XCTAssertEqual(model.taskDrafts["t-1"]?.text, "Fresh")

        // Terminal task update clears active draft.
        let completedJSON = """
        {
          "event": "task.updated",
          "data": {
            "id": "t-1",
            "agent": "codex",
            "sessionId": "s-1",
            "cwd": "/Users/test/project",
            "prompt": "Fix build error",
            "permissionMode": "full",
            "status": "completed",
            "startedAt": 1764140000000,
            "endedAt": 1764140010000,
            "result": "Done"
          }
        }
        """
        model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(completedJSON.utf8)))
        XCTAssertEqual(model.tasks["t-1"]?.status, .completed)
        XCTAssertNil(model.taskDrafts["t-1"])

        // IPC timeout rules
        XCTAssertEqual(IPCRequests.timeout(for: "workbuddy.setKey"), 210)
        XCTAssertEqual(IPCRequests.timeout(for: "tasks.start"), 30)
        XCTAssertEqual(IPCRequests.timeout(for: "sessions.list"), 30)
        XCTAssertEqual(IPCRequests.timeout(for: "sessions.messages"), 30)
        XCTAssertEqual(IPCRequests.timeout(for: "agents.models"), 30)
        XCTAssertEqual(IPCRequests.timeout(for: "agentFlow.snapshot"), 15)
    }

    func testAgentFlowFormatting() {
        XCTAssertEqual(AgentFlowFormat.tokens(0), "0")
        XCTAssertEqual(AgentFlowFormat.tokens(-10), "0")
        XCTAssertEqual(AgentFlowFormat.tokens(960), "960")
        XCTAssertEqual(AgentFlowFormat.tokens(42_600), "42.6K")
        XCTAssertEqual(AgentFlowFormat.tokens(1_280_000), "1.28M")

        XCTAssertEqual(AgentFlowFormat.exact(0), "0")
        XCTAssertEqual(AgentFlowFormat.exact(42_600), "42,600")
        XCTAssertEqual(AgentFlowFormat.exact(1_280_000), "1,280,000")

        XCTAssertEqual(AgentFlowFormat.duration(ms: 0), "<1s")
        XCTAssertEqual(AgentFlowFormat.duration(ms: 999), "<1s")
        XCTAssertEqual(AgentFlowFormat.duration(ms: 1_500), "1s")
        XCTAssertEqual(AgentFlowFormat.duration(ms: 42_000), "42s")
        XCTAssertEqual(AgentFlowFormat.duration(ms: 60_000), "1m")
        XCTAssertEqual(AgentFlowFormat.duration(ms: 125_000), "2m 5s")
        XCTAssertEqual(AgentFlowFormat.duration(ms: 3_660_000), "1h 1m")

        let now = Date(timeIntervalSince1970: 1_764_140_000)
        XCTAssertEqual(AgentFlowFormat.relativeTime(1_764_139_995_000, now: now), "just now")
        let chinese = Locale(identifier: "zh-Hans")
        XCTAssertEqual(AgentFlowFormat.relativeTime(1_764_139_995_000, now: now, locale: chinese), "刚刚")
        XCTAssertTrue(AgentFlowFormat.relativeTime(1_764_139_400_000, now: now, locale: chinese).contains("分钟前"))
        XCTAssertEqual(AgentFlowFormat.relativeTime(1_764_139_960_000, now: now), "40s ago")
        XCTAssertEqual(AgentFlowFormat.relativeTime(1_764_139_400_000, now: now), "10m ago")
        XCTAssertEqual(AgentFlowFormat.relativeTime(1_764_132_800_000, now: now), "2h ago")
    }
}
