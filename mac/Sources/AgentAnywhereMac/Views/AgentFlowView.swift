import AppKit
import SwiftUI

private enum FlowSourceFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case flow = "Flow"
    case codex = "Codex"
    case live = "Live"

    var id: String { rawValue }

    func matches(_ source: String) -> Bool {
        switch self {
        case .all: true
        case .flow: source == "agent-flow"
        case .codex: source == "codex-runs"
        case .live: source == "bridge-live"
        }
    }
}

private enum FlowInspectorTab: String, CaseIterable, Identifiable {
    case details = "Details"
    case timeline = "Timeline"
    case spec = "Spec"

    var id: String { rawValue }
}

private struct FlowAnchorFramesKey: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

struct AgentFlowView: View {
    @Environment(\.locale) private var locale
    @Environment(BridgeModel.self) private var model

    @State private var snapshot: AgentFlowSnapshot?
    @State private var selectedRunId: String?
    @State private var selectedRunDetail: AgentFlowRunDetail?
    @State private var selectedNodeId: String?
    @State private var searchText = ""
    @State private var sourceFilter: FlowSourceFilter = .all
    @State private var inspectorTab: FlowInspectorTab = .details
    @State private var autoRefresh = true
    @State private var loadingSnapshot = false
    @State private var loadingDetail = false
    @State private var errorMessage: String?
    @State private var copiedArtifactPath: String?

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider().overlay(Brand.line)

            if !model.isRunning {
                bridgeOfflineState
            } else {
                HStack(spacing: 0) {
                    runListColumn
                        .frame(width: 286)
                    Divider().overlay(Brand.line)
                    detailWorkspace
                }
            }
        }
        .brandScreen()
        .task(id: model.isRunning) {
            guard model.isRunning else {
                snapshot = nil
                selectedRunDetail = nil
                return
            }
            await refreshAll(showSpinner: snapshot == nil)
        }
        .task(id: autoRefreshLoopKey) {
            guard model.isRunning, autoRefresh else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(5))
                } catch {
                    return
                }
                guard model.isRunning, autoRefresh else { return }
                await refreshAll(showSpinner: false)
            }
        }
        .onChange(of: selectedRunId) { _, newId in
            guard let newId else {
                selectedRunDetail = nil
                selectedNodeId = nil
                return
            }
            Task { await loadRunDetail(id: newId, showSpinner: true) }
        }
    }

    private var autoRefreshLoopKey: String {
        "\(model.isRunning)-\(autoRefresh)"
    }

    private var filteredRuns: [AgentFlowRunSummary] {
        guard let runs = snapshot?.runs else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return runs.filter { run in
            guard sourceFilter.matches(run.source) else { return false }
            if query.isEmpty { return true }
            return run.name.lowercased().contains(query)
                || run.slug.lowercased().contains(query)
                || run.id.lowercased().contains(query)
                || run.agents.contains(where: { $0.lowercased().contains(query) })
        }
    }

    private var selectedNode: AgentFlowNode? {
        guard let detail = selectedRunDetail else { return nil }
        if let selectedNodeId, let match = detail.nodes.first(where: { $0.id == selectedNodeId }) {
            return match
        }
        return detail.nodes.first
    }

    private var activeRunAgents: Set<String> {
        if let detail = selectedRunDetail {
            return Set(detail.agents.map { $0.lowercased() } + detail.nodes.map { $0.agent.lowercased() })
        }
        if let run = filteredRuns.first(where: { $0.id == selectedRunId }) {
            return Set(run.agents.map { $0.lowercased() })
        }
        return []
    }

    // MARK: - Top Command Header

    private var headerBar: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text("Agent-Flow Studio")
                        .font(Brand.title(21, relativeTo: .title2, weight: .bold))
                        .foregroundStyle(Brand.ink)
                    if loadingSnapshot {
                        ProgressView().controlSize(.small)
                    }
                }
                if let updatedAt = snapshot?.updatedAt {
                    Text("Updated \(AgentFlowFormat.relativeTime(updatedAt, locale: locale))")
                        .font(.caption)
                        .foregroundStyle(Brand.muted)
                } else {
                    Text("Multi-agent orchestration & token telemetry")
                        .font(.caption)
                        .foregroundStyle(Brand.muted)
                }
            }

            Spacer(minLength: 8)

            if let summary = snapshot?.summary {
                HStack(spacing: 8) {
                    kpiCapsule(
                        label: "Runs",
                        value: "\(summary.totalRuns)",
                        detail: summary.activeRuns > 0 ? "\(summary.activeRuns) active" : "\(summary.acceptedRuns) accepted",
                        accent: summary.activeRuns > 0 ? Brand.relayText : Brand.ink
                    )
                    kpiCapsule(
                        label: "Team Online",
                        value: "\(summary.onlineMembers)/\(summary.totalMembers)",
                        detail: nil,
                        accent: summary.onlineMembers > 0 ? Brand.successText : Brand.muted
                    )
                    kpiCapsule(
                        label: "Live Tasks",
                        value: "\(summary.liveTasksCount)",
                        detail: nil,
                        accent: summary.liveTasksCount > 0 ? Brand.relayText : Brand.ink
                    )
                    kpiCapsule(
                        label: "Total Tokens",
                        value: AgentFlowFormat.tokens(summary.usage.totalTokens),
                        detail: summary.usage.cacheHitRate > 0 ? "\(Int(summary.usage.cacheHitRate.rounded()))% cache" : nil,
                        accent: Brand.ink
                    )
                }
            }

            HStack(spacing: 8) {
                Button {
                    autoRefresh.toggle()
                } label: {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(autoRefresh ? Brand.success : Brand.muted.opacity(0.45))
                            .frame(width: 7, height: 7)
                        Text("5s Live")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(autoRefresh ? Brand.successText : Brand.muted)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(autoRefresh ? Brand.successSoft : Brand.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(autoRefresh ? Brand.success.opacity(0.35) : Brand.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("Toggle 5-second auto refresh")

                Button {
                    Task { await refreshAll(showSpinner: true) }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Brand.surface, in: Capsule())
                        .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(!model.isRunning || loadingSnapshot)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Brand.paper)
    }

    private func kpiCapsule(label: String, value: String, detail: LocalizedStringKey?, accent: Color) -> some View {
        HStack(spacing: 7) {
            VStack(alignment: .leading, spacing: 1) {
                Text(LocalizedStringKey(label))
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Brand.muted)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(value)
                        .font(Brand.title(14, relativeTo: .callout, weight: .bold))
                        .foregroundStyle(accent)
                    if let detail {
                        Text(detail)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Brand.successText)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Brand.successSoft, in: Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
    }

    // MARK: - Left Run List Column

    private var runListColumn: some View {
        VStack(spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(Brand.muted)
                TextField("Search runs or agents…", text: $searchText)
                    .textFieldStyle(.plain)
                    .font(.callout)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(Brand.muted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))

            HStack(spacing: 4) {
                ForEach(FlowSourceFilter.allCases) { item in
                    Button {
                        sourceFilter = item
                    } label: {
                        Text(LocalizedStringKey(item.rawValue))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(sourceFilter == item ? Brand.ink : Brand.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(
                                sourceFilter == item ? Brand.surface : .clear,
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
            .background(Brand.line.opacity(0.65), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            if let errorMessage {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Brand.failureText)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(Brand.failureText)
                        .lineLimit(2)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Brand.failureSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            ScrollView {
                LazyVStack(spacing: 8) {
                    if filteredRuns.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "point.3.connected.trianglepath.dotted")
                                .font(.title2)
                                .foregroundStyle(Brand.muted)
                            Text(snapshot == nil ? "Loading runs…" : "No matching runs")
                                .font(.callout.weight(.medium))
                                .foregroundStyle(Brand.muted)
                            Text("Runs from Agent-Flow, Codex, and live Bridge tasks appear here.")
                                .font(.caption)
                                .foregroundStyle(Brand.muted)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.vertical, 32)
                        .padding(.horizontal, 12)
                    } else {
                        ForEach(filteredRuns) { run in
                            runCard(run, isSelected: run.id == selectedRunId)
                                .onTapGesture {
                                    selectedRunId = run.id
                                }
                        }
                    }
                }
                .padding(.bottom, 12)
            }
        }
        .padding(12)
        .background(Brand.paper)
    }

    private func runCard(_ run: AgentFlowRunSummary, isSelected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                statusPill(run.status)
                Text(LocalizedStringKey(AgentFlowFormat.sourceLabel(run.source)))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Brand.muted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Brand.separator, in: Capsule())
                Spacer(minLength: 4)
                Text(AgentFlowFormat.relativeTime(run.updatedAt, locale: locale))
                    .font(.caption2)
                    .foregroundStyle(Brand.muted)
            }

            Text(run.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Brand.ink)
                .lineLimit(2)
                .multilineTextAlignment(.leading)

            HStack(spacing: 5) {
                ForEach(Array(run.agents.prefix(3)), id: \.self) { agentId in
                    agentTinyBadge(agentId)
                }
                if run.agents.count > 3 {
                    Text("+\(run.agents.count - 3)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                }
                Spacer(minLength: 4)
                Text("\(AgentFlowFormat.tokens(run.usage.totalTokens)) tok")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Brand.ink)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Brand.paper, in: Capsule())
                    .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isSelected ? Brand.relaySoft.opacity(0.65) : Brand.surface,
            in: RoundedRectangle(cornerRadius: 13, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .strokeBorder(isSelected ? Brand.relay : Brand.line, lineWidth: isSelected ? 1.5 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
    }

    // MARK: - Main Detail Workspace

    private var detailWorkspace: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let team = snapshot?.team, !team.isEmpty {
                    teamMatrixStrip(team)
                }

                if let detail = selectedRunDetail {
                    runTelemetryCard(detail)
                    flowDiagramCard(detail)
                    inspectorCard(detail)
                } else if loadingDetail {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading run topology & telemetry…")
                            .font(.callout)
                            .foregroundStyle(Brand.muted)
                    }
                    .frame(maxWidth: .infinity, minHeight: 220)
                    .brandCard(radius: 16)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "sparkles.rectangle.stack")
                            .font(.system(size: 30))
                            .foregroundStyle(Brand.muted)
                        Text("Select a run to inspect its Agent-Flow graph")
                            .font(Brand.title(16, relativeTo: .headline))
                            .foregroundStyle(Brand.ink)
                        Text("View orchestrator dispatches, per-node token usage, timeline events, and spec documents.")
                            .font(.callout)
                            .foregroundStyle(Brand.muted)
                    }
                    .frame(maxWidth: .infinity, minHeight: 240)
                    .brandCard(radius: 16)
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
                }
            }
            .padding(16)
        }
        .background(Brand.paper)
    }

    // MARK: - Team Matrix Strip

    private func teamMatrixStrip(_ team: [AgentFlowTeamMember]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Team Matrix")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.muted)
                Spacer()
                Text("\(team.filter { $0.status == "ready" }.count) ready · \(team.count) agents & CLIs")
                    .font(.caption2)
                    .foregroundStyle(Brand.muted)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 9) {
                    ForEach(team) { member in
                        let participating = activeRunAgents.contains(member.id.lowercased())
                        let accent = AgentFlowFormat.agentAccent(member.id)
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(memberStatusColor(member.status))
                                    .frame(width: 8, height: 8)
                                Text(member.name)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Brand.ink)
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                Text(LocalizedStringKey(member.badge))
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(participating ? accent : Brand.muted)
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(
                                        (participating ? accent : Brand.muted).opacity(0.14),
                                        in: Capsule()
                                    )
                            }
                            Text(member.defaultModel)
                                .font(.caption2)
                                .foregroundStyle(Brand.muted)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                Text(member.isBridgeAgent ? "Bridge" : "Local CLI")
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(Brand.muted)
                                if member.runningProcesses > 0 {
                                    Text("· \(member.runningProcesses) active")
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(Brand.successText)
                                }
                            }
                        }
                        .padding(.horizontal, 11)
                        .padding(.vertical, 9)
                        .frame(width: 178, alignment: .leading)
                        .background(
                            participating ? accent.opacity(0.08) : Brand.surface,
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(participating ? accent : Brand.line, lineWidth: participating ? 1.5 : 1)
                        )
                        .help(member.detail.map { Text(verbatim: $0) } ?? Text(LocalizedStringKey(member.role)))
                    }
                }
                .padding(.vertical, 1)
            }
        }
    }

    // MARK: - Run Token Telemetry Card

    private func runTelemetryCard(_ detail: AgentFlowRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text(detail.name)
                            .font(Brand.title(18, relativeTo: .title3, weight: .bold))
                            .foregroundStyle(Brand.ink)
                        statusPill(detail.status)
                        Text(LocalizedStringKey(AgentFlowFormat.sourceLabel(detail.source)))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Brand.muted)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(Brand.separator, in: Capsule())
                    }
                    HStack(spacing: 12) {
                        Label(AgentFlowFormat.duration(ms: detail.durationMs), systemImage: "clock")
                        Label("\(detail.acceptedCount)/\(detail.nodeCount) accepted", systemImage: "checkmark.circle")
                        Label("\(detail.eventCount) events", systemImage: "list.bullet")
                        Text("Updated \(AgentFlowFormat.relativeTime(detail.updatedAt, locale: locale))")
                    }
                    .font(.caption)
                    .foregroundStyle(Brand.muted)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(AgentFlowFormat.tokens(detail.usage.totalTokens))
                            .font(Brand.title(24, relativeTo: .title2, weight: .bold))
                            .foregroundStyle(Brand.ink)
                        Text("\(detail.usage.cacheHitRate, specifier: "%.1f")% Cache Hit")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(detail.usage.cacheHitRate > 0 ? Brand.successText : Brand.muted)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(
                                detail.usage.cacheHitRate > 0 ? Brand.successSoft : Brand.separator,
                                in: Capsule()
                            )
                    }
                    Text("\(AgentFlowFormat.exact(detail.usage.totalTokens)) total tokens")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Brand.muted)
                }
            }

            usageTelemetryBar(detail.usage)
        }
        .padding(16)
        .brandCard(radius: 16)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
    }

    private func usageTelemetryBar(_ usage: AgentFlowUsage) -> some View {
        let direct = usage.directInputTokens
        let cached = max(0, usage.cacheReadTokens)
        let output = max(0, usage.outputTokens)
        let thinking = max(0, usage.thinkingTokens)
        let total = CGFloat(usage.segmentTotal)

        return VStack(alignment: .leading, spacing: 8) {
            GeometryReader { geo in
                let w = max(0, geo.size.width)
                HStack(spacing: 2) {
                    if direct > 0 {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Brand.relay)
                            .frame(width: max(3, w * CGFloat(direct) / total))
                    }
                    if cached > 0 {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Brand.success)
                            .frame(width: max(3, w * CGFloat(cached) / total))
                    }
                    if output > 0 {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Brand.claude)
                            .frame(width: max(3, w * CGFloat(output) / total))
                    }
                    if thinking > 0 {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Brand.antigravity)
                            .frame(width: max(3, w * CGFloat(thinking) / total))
                    }
                    if direct + cached + output + thinking == 0 {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(Brand.line)
                    }
                }
            }
            .frame(height: 10)
            .clipShape(Capsule())

            HStack(spacing: 16) {
                tokenLegendItem(color: Brand.relay, title: "Direct Input", count: direct)
                tokenLegendItem(color: Brand.success, title: "Cache Hit", count: cached)
                tokenLegendItem(color: Brand.claude, title: "Output", count: output)
                tokenLegendItem(color: Brand.antigravity, title: "Thinking", count: thinking)
                Spacer(minLength: 0)
                if let source = usage.source {
                    Text(source)
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                }
            }
        }
    }

    private func tokenLegendItem(color: Color, title: String, count: Int) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(LocalizedStringKey(title))
                .font(.caption2)
                .foregroundStyle(Brand.muted)
            Text(AgentFlowFormat.exact(count))
                .font(.caption2.weight(.semibold).monospacedDigit())
                .foregroundStyle(Brand.ink)
        }
    }

    // MARK: - Native SwiftUI Flow Diagram

    private func flowDiagramCard(_ detail: AgentFlowRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Orchestration Flow")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.muted)
                Spacer()
                Text("Click any subtask node to inspect details & artifacts")
                    .font(.caption2)
                    .foregroundStyle(Brand.muted)
            }

            if detail.nodes.isEmpty {
                Text("No subtask nodes recorded for this run yet.")
                    .font(.callout)
                    .foregroundStyle(Brand.muted)
                    .frame(maxWidth: .infinity, minHeight: 90)
            } else {
                AgentFlowDiagramCanvas(
                    run: detail,
                    selectedNodeId: selectedNode?.id,
                    onSelect: { nodeId in
                        selectedNodeId = nodeId
                        inspectorTab = .details
                    }
                )
            }
        }
        .padding(16)
        .brandCard(radius: 16)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
    }

    // MARK: - Inspector Tabs

    private func inspectorCard(_ detail: AgentFlowRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(FlowInspectorTab.allCases) { tab in
                        Button {
                            inspectorTab = tab
                        } label: {
                            HStack(spacing: 5) {
                                Text(LocalizedStringKey(tab.rawValue))
                                    .font(.caption.weight(.semibold))
                                if tab == .timeline {
                                    Text("\(detail.events.count)")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(Brand.muted)
                                } else if tab == .spec, detail.hasSpec {
                                    Circle().fill(Brand.relay).frame(width: 5, height: 5)
                                }
                            }
                            .foregroundStyle(inspectorTab == tab ? Brand.ink : Brand.muted)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                inspectorTab == tab ? Brand.surface : .clear,
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(3)
                .background(Brand.line.opacity(0.65), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                Spacer()

                if inspectorTab == .spec, let spec = detail.spec, !spec.isEmpty {
                    Button {
                        copyText(spec)
                    } label: {
                        Label("Copy Spec", systemImage: "doc.on.doc")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Brand.relayText)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Brand.relaySoft, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }

            Divider().overlay(Brand.separator)

            switch inspectorTab {
            case .details:
                nodeDetailsTab(detail)
            case .timeline:
                timelineTab(detail.events)
            case .spec:
                specTab(detail.spec)
            }
        }
        .padding(16)
        .brandCard(radius: 16)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
    }

    @ViewBuilder
    private func nodeDetailsTab(_ detail: AgentFlowRunDetail) -> some View {
        if let node = selectedNode {
            let accent = AgentFlowFormat.agentAccent(node.agent)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(accent)
                        .frame(width: 4, height: 22)
                    Text(node.label)
                        .font(Brand.title(15, relativeTo: .headline, weight: .bold))
                        .foregroundStyle(Brand.ink)
                    statusPill(node.status)
                    agentTinyBadge(node.agent)
                    if !node.model.isEmpty {
                        Text(node.model)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Brand.muted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Brand.paper, in: Capsule())
                    }
                    if let effort = node.effort, !effort.isEmpty {
                        Text(effort)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(Brand.muted)
                    }
                    Spacer()
                    Text("Round \(node.round) · \(AgentFlowFormat.duration(ms: node.durationMs))")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Brand.muted)
                }

                if !node.summary.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Summary")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Brand.muted)
                        Text(node.summary)
                            .font(.callout)
                            .foregroundStyle(Brand.ink)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let note = node.note, !note.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Review / Note")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Brand.warningText)
                        Text(note)
                            .font(.callout)
                            .foregroundStyle(Brand.ink)
                            .textSelection(.enabled)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Brand.warningSoft.opacity(0.65), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Node Token Breakdown")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Brand.muted)
                        Spacer()
                        Text("\(AgentFlowFormat.tokens(node.usage.totalTokens)) (\(AgentFlowFormat.exact(node.usage.totalTokens)))")
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Brand.ink)
                    }
                    usageTelemetryBar(node.usage)
                }
                .padding(11)
                .background(Brand.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                let artifacts = node.artifacts.isEmpty ? detail.artifacts : node.artifacts
                VStack(alignment: .leading, spacing: 6) {
                    Text(node.artifacts.isEmpty ? "Run Artifacts (\(artifacts.count))" : "Node Artifacts (\(artifacts.count))")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                    if artifacts.isEmpty {
                        Text("No file artifacts recorded.")
                            .font(.caption)
                            .foregroundStyle(Brand.muted)
                    } else {
                        ForEach(artifacts, id: \.self) { path in
                            artifactRow(path)
                        }
                    }
                }
            }
        } else {
            Text("No subtask selected.")
                .font(.callout)
                .foregroundStyle(Brand.muted)
        }
    }

    private func artifactRow(_ path: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text")
                .font(.caption)
                .foregroundStyle(Brand.relayText)
            Text(AgentFlowFormat.shortPath(path))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(Brand.ink)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(path)
            Spacer(minLength: 6)
            Button {
                copyText(path)
                copiedArtifactPath = path
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    if copiedArtifactPath == path { copiedArtifactPath = nil }
                }
            } label: {
                Label(copiedArtifactPath == path ? "Copied" : "Copy Path", systemImage: copiedArtifactPath == path ? "checkmark" : "doc.on.doc")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Brand.ink)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Brand.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
            }
            .buttonStyle(.plain)

            Button {
                let expanded = NSString(string: path).expandingTildeInPath
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: expanded)])
            } label: {
                Label("Reveal in Finder", systemImage: "folder")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Brand.relayText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Brand.relaySoft, in: Capsule())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Brand.paper, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func timelineTab(_ events: [AgentFlowEvent]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if events.isEmpty {
                Text("No timeline events recorded.")
                    .font(.callout)
                    .foregroundStyle(Brand.muted)
                    .padding(.vertical, 12)
            } else {
                ForEach(events) { ev in
                    HStack(alignment: .top, spacing: 10) {
                        Text(AgentFlowFormat.clockTime(ev.ts))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(Brand.muted)
                            .frame(width: 68, alignment: .leading)
                            .padding(.top, 2)

                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                statusPill(ev.event)
                                Text(ev.sub)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Brand.ink)
                                agentTinyBadge(ev.agent)
                                if !ev.model.isEmpty {
                                    Text(ev.model)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(Brand.muted)
                                }
                                Spacer(minLength: 4)
                                if let usage = ev.usage, usage.totalTokens > 0 {
                                    Text("\(AgentFlowFormat.tokens(usage.totalTokens)) tok")
                                        .font(.caption2.weight(.semibold).monospacedDigit())
                                        .foregroundStyle(Brand.ink)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Brand.paper, in: Capsule())
                                }
                            }
                            if !ev.summary.isEmpty {
                                Text(ev.summary)
                                    .font(.caption)
                                    .foregroundStyle(Brand.ink)
                                    .textSelection(.enabled)
                            }
                            if let note = ev.note, !note.isEmpty {
                                Text(note)
                                    .font(.caption2)
                                    .foregroundStyle(Brand.muted)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Brand.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
    }

    private func specTab(_ spec: String?) -> some View {
        Group {
            if let spec, !spec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ScrollView {
                    Text(spec)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Brand.ink)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(minHeight: 180, maxHeight: 380)
                .background(Brand.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                Text("No spec.md found for this run.")
                    .font(.callout)
                    .foregroundStyle(Brand.muted)
                    .padding(.vertical, 16)
            }
        }
    }

    // MARK: - Offline State & Reusable Badges

    private var bridgeOfflineState: some View {
        VStack(spacing: 12) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 34))
                .foregroundStyle(Brand.muted)
            Text(LocalizedStringKey(model.state.label))
                .font(Brand.title(18, relativeTo: .title3))
                .foregroundStyle(Brand.ink)
            Text("Agent-Flow Studio connects through the local AgentTote Bridge to stream live tasks and run telemetry.")
                .font(.callout)
                .foregroundStyle(Brand.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
            Button("Retry Bridge") {
                Task { await model.restart() }
            }
            .buttonStyle(RelayButtonStyle(fullWidth: false, compact: true))
            .disabled(model.restarting)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
    }

    private func statusPill(_ status: String) -> some View {
        Text(LocalizedStringKey(AgentFlowFormat.statusLabel(status)))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(AgentFlowFormat.statusForeground(status))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(AgentFlowFormat.statusBackground(status), in: Capsule())
    }

    private func agentTinyBadge(_ agentId: String) -> some View {
        let accent = AgentFlowFormat.agentAccent(agentId)
        return HStack(spacing: 4) {
            Circle().fill(accent).frame(width: 6, height: 6)
            Text(AgentFlowFormat.agentDisplayName(agentId))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Brand.ink)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(accent.opacity(0.12), in: Capsule())
    }

    private func memberStatusColor(_ status: String) -> Color {
        switch status {
        case "ready": Brand.success
        case "needsLogin": Brand.warning
        default: Brand.muted.opacity(0.45)
        }
    }

    // MARK: - Data Loading

    private func refreshAll(showSpinner: Bool) async {
        guard model.isRunning else { return }
        if showSpinner { loadingSnapshot = true }
        defer { if showSpinner { loadingSnapshot = false } }
        do {
            let fetched = try await model.fetchAgentFlowSnapshot(limit: 40)
            snapshot = fetched
            errorMessage = nil

            let resolvedId: String?
            if let current = selectedRunId, fetched.runs.contains(where: { $0.id == current }) {
                resolvedId = current
            } else {
                resolvedId = fetched.runs.first?.id
            }

            if selectedRunId != resolvedId {
                selectedRunId = resolvedId
            } else if let resolvedId {
                await loadRunDetail(id: resolvedId, showSpinner: false)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadRunDetail(id: String, showSpinner: Bool) async {
        guard model.isRunning else { return }
        if showSpinner { loadingDetail = true }
        defer { if showSpinner { loadingDetail = false } }
        do {
            let detail = try await model.fetchAgentFlowRun(id: id)
            guard selectedRunId == id else { return }
            selectedRunDetail = detail
            if let existingNode = selectedNodeId, detail.nodes.contains(where: { $0.id == existingNode }) {
                selectedNodeId = existingNode
            } else {
                selectedNodeId = detail.nodes.first?.id
            }
        } catch {
            if selectedRunId == id {
                errorMessage = error.localizedDescription
            }
        }
    }
}

// MARK: - Interactive Native SwiftUI Bézier Flow Diagram

private struct AgentFlowDiagramCanvas: View {
    let run: AgentFlowRunDetail
    let selectedNodeId: String?
    let onSelect: (String) -> Void

    @State private var frames: [String: CGRect] = [:]

    var body: some View {
        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                guard let hubFrame = frames["__orchestrator__"] else { return }
                let start = CGPoint(x: hubFrame.maxX, y: hubFrame.midY)

                for node in run.nodes {
                    guard let nodeFrame = frames[node.id] else { continue }
                    let end = CGPoint(x: nodeFrame.minX, y: nodeFrame.midY)
                    let dx = max(36, (end.x - start.x) * 0.52)

                    var curve = Path()
                    curve.move(to: start)
                    curve.addCurve(
                        to: end,
                        control1: CGPoint(x: start.x + dx, y: start.y),
                        control2: CGPoint(x: end.x - dx, y: end.y)
                    )

                    let isSelected = node.id == selectedNodeId
                    let strokeColor = isSelected
                        ? AgentFlowFormat.agentAccent(node.agent)
                        : AgentFlowFormat.statusStroke(node.status).opacity(0.65)

                    context.stroke(
                        curve,
                        with: .color(strokeColor),
                        style: StrokeStyle(
                            lineWidth: isSelected ? 2.5 : 1.75,
                            lineCap: .round,
                            dash: node.status == "dispatched" ? [6, 4] : []
                        )
                    )

                    // Terminal dot on the node inlet
                    let dot = CGRect(x: end.x - 3.5, y: end.y - 3.5, width: 7, height: 7)
                    context.fill(Path(ellipseIn: dot), with: .color(strokeColor))
                }

                // Origin dot on the orchestrator hub
                let originDot = CGRect(x: start.x - 4, y: start.y - 4, width: 8, height: 8)
                context.fill(Path(ellipseIn: originDot), with: .color(Brand.relay))
            }
            .allowsHitTesting(false)

            HStack(alignment: .center, spacing: 56) {
                orchestratorHubCard
                    .frame(width: 190)
                    .background(frameReporter(id: "__orchestrator__"))

                VStack(alignment: .leading, spacing: 10) {
                    ForEach(run.nodes) { node in
                        subtaskNodeCard(node, isSelected: node.id == selectedNodeId)
                            .background(frameReporter(id: node.id))
                            .onTapGesture {
                                onSelect(node.id)
                            }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
        }
        .coordinateSpace(name: "AgentFlowDiagramSpace")
        .onPreferenceChange(FlowAnchorFramesKey.self) { next in
            if next != frames {
                frames = next
            }
        }
    }

    private var orchestratorHubCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Brand.relay, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text("Orchestrator")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Brand.ink)
                    Text("Brain Hub")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                }
            }

            Divider().overlay(Brand.separator)

            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Subtasks")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                    Spacer()
                    Text("\(run.nodes.count)")
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(Brand.ink)
                }
                HStack {
                    Text("Accepted")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                    Spacer()
                    Text("\(run.acceptedCount)")
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(Brand.successText)
                }
                HStack {
                    Text("Tokens")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                    Spacer()
                    Text(AgentFlowFormat.tokens(run.usage.totalTokens))
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(Brand.ink)
                }
            }
        }
        .padding(12)
        .background(Brand.paper, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Brand.relay.opacity(0.65), lineWidth: 1.5)
        )
    }

    private func subtaskNodeCard(_ node: AgentFlowNode, isSelected: Bool) -> some View {
        let accent = AgentFlowFormat.agentAccent(node.agent)
        return HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 3)
                .fill(accent)
                .frame(width: 4)
                .padding(.vertical, 2)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(node.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(LocalizedStringKey(AgentFlowFormat.statusLabel(node.status)))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(AgentFlowFormat.statusForeground(node.status))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(AgentFlowFormat.statusBackground(node.status), in: Capsule())
                }

                HStack(spacing: 8) {
                    Text(AgentFlowFormat.agentDisplayName(node.agent))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(accent)
                    if !node.model.isEmpty {
                        Text(node.model)
                            .font(.caption2.monospaced())
                            .foregroundStyle(Brand.muted)
                            .lineLimit(1)
                    }
                    Text("R\(node.round)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Brand.separator, in: Capsule())
                    Spacer(minLength: 4)
                    Text(AgentFlowFormat.duration(ms: node.durationMs))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(Brand.muted)
                    Text("\(AgentFlowFormat.tokens(node.usage.totalTokens)) tok")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Brand.ink)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isSelected ? accent.opacity(0.09) : Brand.paper,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(isSelected ? accent : Brand.line, lineWidth: isSelected ? 1.6 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func frameReporter(id: String) -> some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: FlowAnchorFramesKey.self,
                value: [id: geo.frame(in: .named("AgentFlowDiagramSpace"))]
            )
        }
    }
}
