// Standalone macOS runner, excluded from the iOS app unless AA_AGENT_FLOW_TESTS is set.
// From the repository root:
// xcrun swiftc -D AA_AGENT_FLOW_TESTS -parse-as-library -swift-version 5 -warnings-as-errors \
//   -module-cache-path /tmp/aa-agent-flow-module-cache \
//   ios/AgentAnywhere/Models/{Protocol,AgentFlowModels}.swift \
//   ios/AgentAnywhere/Tests/AgentFlowModelsTests.swift -o /tmp/aa-agent-flow-tests
// /tmp/aa-agent-flow-tests
#if AA_AGENT_FLOW_TESTS
import Foundation

@main
private enum AgentFlowModelsTestRunner {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() {
            throw NSError(domain: "AgentFlowModelsTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    static func main() throws {
        let decoder = JSONDecoder()

        // 1. Decode AgentFlowSnapshot payload matching bridge/src/types.ts
        let snapshotJSON = #"""
        {
          "updatedAt": 1764148800000,
          "summary": {
            "totalRuns": 12,
            "activeRuns": 2,
            "acceptedRuns": 9,
            "onlineMembers": 7,
            "totalMembers": 8,
            "liveTasksCount": 1,
            "usage": {
              "inputTokens": 1200000,
              "outputTokens": 250000,
              "thinkingTokens": 150000,
              "cacheReadTokens": 900000,
              "totalTokens": 1600000,
              "cacheHitRate": 75.0,
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
              "role": "总控大脑 · 统筹规划、派单与验收",
              "defaultModel": "Antigravity Orchestrator",
              "accent": "#A78BFA",
              "badge": "BRAIN",
              "binName": "agy",
              "status": "ready",
              "runningProcesses": 2,
              "version": "2.0.1",
              "isBridgeAgent": true
            },
            {
              "id": "agy2",
              "name": "agy2 CLI",
              "shortName": "agy2 · Neon",
              "account": "Account B",
              "tier": "executor",
              "role": "高审美界面设计与通用执行手",
              "defaultModel": "Gemini 4 Neon",
              "accent": "#22D3EE",
              "badge": "DESIGN · OPS",
              "binName": "agy2",
              "status": "ready",
              "runningProcesses": 1,
              "isBridgeAgent": false
            }
          ],
          "liveTasks": [
            {
              "id": "task-1",
              "agent": "codex",
              "sessionId": "sess-1",
              "cwd": "/Users/rongyaozu/AgentTote",
              "prompt": "Implement Agent-Flow Studio",
              "permissionMode": "acceptEdits",
              "model": "gpt-5-codex",
              "effort": "high",
              "status": "running",
              "startedAt": 1764148700000
            }
          ],
          "runs": [
            {
              "id": "agent-flow:agenttote-agent-flow",
              "slug": "agenttote-agent-flow",
              "name": "AgentTote Agent-Flow Studio",
              "source": "agent-flow",
              "status": "dispatched",
              "createdAt": 1764140000000,
              "updatedAt": 1764148750000,
              "durationMs": 125000,
              "agents": ["antigravity", "codex", "agy2"],
              "nodeCount": 3,
              "acceptedCount": 2,
              "rejectedCount": 0,
              "eventCount": 8,
              "hasSpec": true,
              "artifacts": ["/Users/rongyaozu/AgentTote/ios/AgentAnywhere/Views/AgentFlowView.swift"],
              "usage": {
                "inputTokens": 42000,
                "outputTokens": 12000,
                "thinkingTokens": 6000,
                "cacheReadTokens": 30000,
                "totalTokens": 60000,
                "cacheHitRate": 71.4
              }
            }
          ]
        }
        """#

        let snapshot = try decoder.decode(AgentFlowSnapshot.self, from: Data(snapshotJSON.utf8))
        try expect(snapshot.summary.totalRuns == 12, "Snapshot totalRuns")
        try expect(snapshot.summary.onlineMembers == 7 && snapshot.summary.totalMembers == 8, "Snapshot team counts")
        try expect(snapshot.summary.usage.totalTokens == 1_600_000, "Snapshot totalTokens")
        try expect(snapshot.summary.usage.directInputTokens == 300_000, "Combined input subtracts cacheRead")
        try expect(snapshot.summary.usage.source == "mixed", "Usage source")
        try expect(snapshot.team.count == 2 && snapshot.team[0].tier == "orchestrator" && snapshot.team[1].isBridgeAgent == false, "Team members")
        try expect(snapshot.liveTasks.count == 1 && snapshot.liveTasks[0].agent == .codex, "Live tasks")
        try expect(snapshot.runs.count == 1 && snapshot.runs[0].slug == "agenttote-agent-flow", "Runs summary")

        // 2. Decode AgentFlowRunDetail payload (with spec and with null spec)
        let detailJSON = #"""
        {
          "id": "agent-flow:agenttote-agent-flow",
          "slug": "agenttote-agent-flow",
          "name": "AgentTote Agent-Flow Studio",
          "source": "agent-flow",
          "status": "accepted",
          "createdAt": 1764140000000,
          "updatedAt": 1764148750000,
          "durationMs": 3720000,
          "agents": ["codex", "agy2"],
          "nodeCount": 2,
          "acceptedCount": 2,
          "rejectedCount": 0,
          "eventCount": 2,
          "hasSpec": true,
          "artifacts": ["/Users/rongyaozu/AgentTote/ios/AgentAnywhere/Views/AgentFlowView.swift"],
          "usage": {
            "inputTokens": 10000,
            "outputTokens": 5000,
            "thinkingTokens": 2000,
            "cacheReadTokens": 40000,
            "totalTokens": 57000,
            "cacheHitRate": 80.0
          },
          "nodes": [
            {
              "id": "phase-2b-ios",
              "label": "Native iOS SwiftUI Agent-Flow Studio",
              "agent": "agy2",
              "model": "gemini-4-neon",
              "effort": "high",
              "status": "accepted",
              "round": 1,
              "startedAt": 1764145000000,
              "updatedAt": 1764148720000,
              "durationMs": 45200,
              "summary": "Implemented native iOS views, models, and tests.",
              "note": "Verified clean Xcode build.",
              "artifacts": ["/Users/rongyaozu/AgentTote/ios/AgentAnywhere/Views/AgentFlowView.swift"],
              "usage": {
                "inputTokens": 42600,
                "outputTokens": 8400,
                "thinkingTokens": 3100,
                "cacheReadTokens": 32000,
                "totalTokens": 54100,
                "cacheHitRate": 75.1,
                "source": "rollout"
              },
              "eventCount": 2
            }
          ],
          "events": [
            {
              "seq": 1,
              "ts": 1764145000000,
              "sub": "phase-2b-ios",
              "event": "dispatched",
              "agent": "agy2",
              "model": "gemini-4-neon",
              "effort": "high",
              "round": 1,
              "summary": "Dispatched Phase 2B iOS task.",
              "artifacts": []
            },
            {
              "seq": 2,
              "ts": 1764148720000,
              "sub": "phase-2b-ios",
              "event": "accepted",
              "agent": "agy2",
              "model": "gemini-4-neon",
              "round": 1,
              "summary": "Accepted with zero warnings.",
              "note": "Ship it",
              "artifacts": ["/Users/rongyaozu/AgentTote/ios/AgentAnywhere/Views/AgentFlowView.swift"],
              "usage": {
                "inputTokens": 42600,
                "outputTokens": 8400,
                "thinkingTokens": 3100,
                "cacheReadTokens": 32000,
                "totalTokens": 54100,
                "cacheHitRate": 75.1
              }
            }
          ],
          "spec": "# Phase 2B Spec\nBuild native iOS Studio."
        }
        """#

        let detail = try decoder.decode(AgentFlowRunDetail.self, from: Data(detailJSON.utf8))
        try expect(detail.id == "agent-flow:agenttote-agent-flow", "Run detail id")
        try expect(detail.usage.directInputTokens == 10_000, "Split input keeps directInput when input < cacheRead")
        try expect(detail.nodes.count == 1 && detail.nodes[0].effort == "high" && detail.nodes[0].note == "Verified clean Xcode build.", "Node fields")
        try expect(detail.events.count == 2 && detail.events[0].usage == nil && detail.events[1].usage?.totalTokens == 54_100, "Event fields")
        try expect(detail.spec?.contains("# Phase 2B Spec") == true, "Spec decoded")

        let nullSpecJSON = detailJSON.replacingOccurrences(of: ##""# Phase 2B Spec\nBuild native iOS Studio.""##, with: "null")
        let detailWithoutSpec = try decoder.decode(AgentFlowRunDetail.self, from: Data(nullSpecJSON.utf8))
        try expect(detailWithoutSpec.spec == nil, "Null spec decodes to nil")

        // 3. Verify AgentFlowFormat.tokens
        try expect(AgentFlowFormat.tokens(-10) == "0", "Negative tokens clamp to 0")
        try expect(AgentFlowFormat.tokens(0) == "0", "Zero tokens")
        try expect(AgentFlowFormat.tokens(999) == "999", "Sub-1K tokens")
        try expect(AgentFlowFormat.tokens(1_000) == "1.0K", "1K boundary")
        try expect(AgentFlowFormat.tokens(42_600) == "42.6K", "42.6K tokens")
        try expect(AgentFlowFormat.tokens(999_950) == "1.00M", "K->M rounding boundary")
        try expect(AgentFlowFormat.tokens(1_280_000) == "1.28M", "1.28M tokens")
        try expect(AgentFlowFormat.tokens(1_600_000) == "1.60M", "1.60M tokens")
        try expect(AgentFlowFormat.tokens(2_500_000_000) == "2.50B", "2.50B tokens")

        // 4. Verify AgentFlowFormat.exact
        try expect(AgentFlowFormat.exact(1_280_450) == "1,280,450", "Exact grouped tokens")
        try expect(AgentFlowFormat.exact(0) == "0", "Exact zero")

        // 5. Verify AgentFlowFormat.duration
        try expect(AgentFlowFormat.duration(ms: -5) == "—", "Negative duration")
        try expect(AgentFlowFormat.duration(ms: 0) == "0s", "Zero duration")
        try expect(AgentFlowFormat.duration(ms: 450) == "450ms", "Sub-second duration")
        try expect(AgentFlowFormat.duration(ms: 4_200) == "4.2s", "Single-digit seconds duration")
        try expect(AgentFlowFormat.duration(ms: 45_000) == "45s", "Seconds duration")
        try expect(AgentFlowFormat.duration(ms: 120_000) == "2m", "Exact minutes duration")
        try expect(AgentFlowFormat.duration(ms: 125_000) == "2m 5s", "Minutes + seconds duration")
        try expect(AgentFlowFormat.duration(ms: 3_600_000) == "1h", "Exact hours duration")
        try expect(AgentFlowFormat.duration(ms: 3_720_000) == "1h 2m", "Hours + minutes duration")

        // 6. Verify cacheRate, relativeTime, route Hashable, and agentTint
        try expect(AgentFlowFormat.cacheRate(0) == "0%", "Zero cache rate")
        try expect(AgentFlowFormat.cacheRate(78.4) == "78.4%", "Fractional cache rate")
        try expect(AgentFlowFormat.cacheRate(100) == "100%", "Full cache rate")
        try expect(AgentFlowFormat.relativeTime(0) == "—", "Zero epoch relativeTime")
        try expect(!AgentFlowFormat.relativeTime(Date().timeIntervalSince1970 * 1000 - 60_000).isEmpty, "Valid relativeTime")

        let routes: Set<AgentFlowRoute> = [.studio, .run("r1"), .run("r2"), .run("r1")]
        try expect(routes.count == 3, "AgentFlowRoute Hashable uniqueness")

        for agent in ["agy2", "codebuddy", "arkcli", "antigravity", "codex", "claude", "workbuddy", "cursor", "unknown"] {
            _ = AgentFlowFormat.agentTint(agent)
            try expect(!AgentFlowFormat.agentDisplayName(agent).isEmpty, "Agent display name for \(agent)")
        }

        print("AgentFlowModels checks passed: snapshot/detail JSON decoding, direct input accounting, token/exact/duration/cacheRate formatters, routes and tints.")
    }
}
#endif
