import SwiftUI
import UIKit

// MARK: - Home Card

struct AgentFlowHomeCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationLink(value: AgentFlowRoute.studio) {
            VStack(alignment: .leading, spacing: 12) {
                headerRow
                kpiRow
                if let usage = model.agentFlow?.summary.usage, usage.hasTokens {
                    AgentFlowTokenBar(usage: usage, height: 6)
                }
                if let latest = model.agentFlow?.runs.first {
                    Divider().overlay(Brand.separator)
                    latestRunRow(latest)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .brandCard()
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .task(id: "\(model.selectedMacId ?? ""):\(model.isConnected)") {
            if model.isConnected && model.agentFlow == nil {
                await model.refreshAgentFlow()
            }
        }
    }

    private var headerRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Brand.relayText)
                .frame(width: 30, height: 30)
                .background(Brand.relaySoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))

            Text("Agent-Flow Studio")
                .font(Brand.title(18, relativeTo: .headline))
                .foregroundStyle(Brand.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.85)

            Spacer(minLength: 4)

            if let summary = model.agentFlow?.summary {
                HStack(spacing: 5) {
                    Circle()
                        .fill(summary.onlineMembers > 0 ? Brand.success : Brand.muted)
                        .frame(width: 6, height: 6)
                    Text("\(summary.onlineMembers)/\(summary.totalMembers) online")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(summary.onlineMembers > 0 ? Brand.successText : Brand.muted)
                        .lineLimit(1)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(summary.onlineMembers > 0 ? Brand.successSoft : Brand.line, in: Capsule())
            } else {
                Text("Loading…")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(Brand.muted)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Brand.line, in: Capsule())
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Brand.muted)
        }
    }

    private var kpiRow: some View {
        let summary = model.agentFlow?.summary
        let totalTokens = summary?.usage.totalTokens ?? 0
        let cacheHitRate = summary?.usage.cacheHitRate ?? 0
        let activeRuns = summary?.activeRuns ?? 0
        let totalRuns = summary?.totalRuns ?? 0

        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                tokenHeadline(totalTokens)
                cachePill(cacheHitRate)
                Spacer(minLength: 4)
                runsBadge(active: activeRuns, total: totalRuns)
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    tokenHeadline(totalTokens)
                    cachePill(cacheHitRate)
                }
                runsBadge(active: activeRuns, total: totalRuns)
            }
        }
    }

    private func tokenHeadline(_ count: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(AgentFlowFormat.tokens(count))
                .font(Brand.title(22, relativeTo: .title3, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(Brand.ink)
            Text("tok")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Brand.muted)
        }
    }

    private func cachePill(_ rate: Double) -> some View {
        Text("\(AgentFlowFormat.cacheRate(rate)) cache")
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(rate > 0 ? Brand.successText : Brand.muted)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(rate > 0 ? Brand.successSoft : Brand.line, in: Capsule())
    }

    private func runsBadge(active: Int, total: Int) -> some View {
        HStack(spacing: 4) {
            if active > 0 {
                Text("\(active) active")
                    .foregroundStyle(Brand.relayText)
                Text("·")
                    .foregroundStyle(Brand.muted)
            }
            Text("\(total) runs")
                .foregroundStyle(Brand.muted)
        }
        .font(.caption.weight(.semibold))
        .monospacedDigit()
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(active > 0 ? Brand.relaySoft : Brand.paper, in: Capsule())
    }

    private func latestRunRow(_ run: AgentFlowRunSummary) -> some View {
        HStack(spacing: 8) {
            AgentFlowStatusDot(status: run.status)
            Text(run.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Brand.ink)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text("\(AgentFlowFormat.tokens(run.usage.totalTokens)) tok")
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
    }
}

// MARK: - Studio Overview Screen

struct AgentFlowView: View {
    @Environment(\.locale) private var locale
    @Environment(AppModel.self) private var model
    @State private var filter: SourceFilter = .all
    @State private var query = ""
    @State private var isRefreshing = false

    private enum SourceFilter: String, CaseIterable, Identifiable {
        case all = "All"
        case flow = "Flow"
        case codex = "Codex"
        case live = "Live"

        var id: String { rawValue }

        func matches(_ source: String) -> Bool {
            switch self {
            case .all: return true
            case .flow: return source == "agent-flow"
            case .codex: return source == "codex-runs"
            case .live: return source == "bridge-live"
            }
        }
    }

    private var snapshot: AgentFlowSnapshot? { model.agentFlow }

    private var filteredRuns: [AgentFlowRunSummary] {
        let all = snapshot?.runs ?? []
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return all.filter { run in
            guard filter.matches(run.source) else { return false }
            guard !trimmed.isEmpty else { return true }
            return run.name.localizedCaseInsensitiveContains(trimmed)
                || run.slug.localizedCaseInsensitiveContains(trimmed)
                || run.id.localizedCaseInsensitiveContains(trimmed)
                || run.status.localizedCaseInsensitiveContains(trimmed)
                || run.agents.contains { $0.localizedCaseInsensitiveContains(trimmed) }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let snapshot {
                    overviewTelemetryCard(snapshot)
                    if !snapshot.team.isEmpty {
                        teamRosterSection(snapshot)
                    }
                    runsSection(snapshot)
                } else if isRefreshing {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Loading Agent-Flow Studio…")
                            .font(.subheadline)
                            .foregroundStyle(Brand.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 64)
                } else {
                    emptyStudioCard
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
        }
        .brandScreen()
        .toolbar(.visible, for: .navigationBar)
        .brandNavigationTitle("Agent-Flow Studio")
        .searchable(text: $query, prompt: "Search runs, agents, or slugs")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await refresh() }
                } label: {
                    if isRefreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(Brand.relayText)
                    }
                }
                .disabled(isRefreshing || !model.isConnected)
                .accessibilityLabel("Refresh Agent-Flow Studio")
            }
        }
        .refreshable { await refresh() }
        .task {
            if model.agentFlow == nil {
                await refresh()
            }
        }
    }

    private func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await model.refreshAgentFlow()
    }

    private func overviewTelemetryCard(_ snapshot: AgentFlowSnapshot) -> some View {
        let summary = snapshot.summary
        let usage = summary.usage

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TOKEN TELEMETRY")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Brand.muted)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(AgentFlowFormat.tokens(usage.totalTokens))
                            .font(Brand.title(28, relativeTo: .title, weight: .bold))
                            .monospacedDigit()
                            .foregroundStyle(Brand.ink)
                        Text("total tokens")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Brand.muted)
                    }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 3) {
                    Text("\(AgentFlowFormat.cacheRate(usage.cacheHitRate))")
                        .font(.subheadline.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(usage.cacheHitRate > 0 ? Brand.successText : Brand.muted)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(usage.cacheHitRate > 0 ? Brand.successSoft : Brand.line, in: Capsule())
                    Text("Cache hit")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                }
            }

            AgentFlowTokenBar(usage: usage, height: 10)
            AgentFlowTokenLegend(usage: usage)

            Divider().overlay(Brand.separator)

            HStack(spacing: 8) {
                metricTile(title: "Runs", value: "\(summary.totalRuns)", accent: Brand.ink)
                metricTile(title: "Active", value: "\(summary.activeRuns)", accent: summary.activeRuns > 0 ? Brand.relayText : Brand.muted)
                metricTile(title: "Live Tasks", value: "\(summary.liveTasksCount)", accent: summary.liveTasksCount > 0 ? Brand.successText : Brand.muted)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .brandCard()
    }

    private func metricTile(title: String, value: String, accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(Brand.title(19, relativeTo: .headline, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(accent)
            Text(LocalizedStringKey(title))
                .font(.caption2.weight(.medium))
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func teamRosterSection(_ snapshot: AgentFlowSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Team Roster")
                    .font(Brand.title(18, relativeTo: .headline))
                Spacer()
                Text("\(snapshot.summary.onlineMembers)/\(snapshot.summary.totalMembers) online")
                    .font(.caption.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Brand.muted)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(snapshot.team) { member in
                        teamChip(member)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func teamChip(_ member: AgentFlowTeamMember) -> some View {
        let tint = AgentFlowFormat.agentTint(member.id)
        let statusColor: Color = {
            switch member.status {
            case .ready: return Brand.success
            case .needsLogin: return Brand.warning
            case .unavailable: return Brand.muted
            }
        }()

        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: AgentFlowFormat.agentSymbol(member.id))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(tint, in: RoundedRectangle(cornerRadius: 7, style: .continuous))

                Text(LocalizedStringKey(member.shortName))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Brand.ink)
                    .lineLimit(1)

                Spacer(minLength: 2)

                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
            }

            HStack(spacing: 5) {
                Text(LocalizedStringKey(member.badge))
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(tint.opacity(0.14), in: Capsule())

                if member.runningProcesses > 0 {
                    Text("\(member.runningProcesses) live")
                        .font(.system(size: 10, weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Brand.successText)
                        .lineLimit(1)
                }
            }

            (member.defaultModel.isEmpty ? Text(LocalizedStringKey(member.role)) : Text(verbatim: member.defaultModel))
                .font(.caption2)
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
        }
        .padding(12)
        .frame(width: 158, alignment: .leading)
        .brandCard(radius: 16)
    }

    private func runsSection(_ snapshot: AgentFlowSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Runs")
                    .font(Brand.title(18, relativeTo: .headline))
                Spacer()
                Text("\(filteredRuns.count) shown")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Brand.muted)
            }

            Picker("Source", selection: $filter) {
                ForEach(SourceFilter.allCases) { option in
                    Text(LocalizedStringKey(option.rawValue)).tag(option)
                }
            }
            .pickerStyle(.segmented)

            if filteredRuns.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "tray")
                        .font(.title3)
                        .foregroundStyle(Brand.muted)
                    Text(query.isEmpty ? "No runs in \(filter.rawValue)" : "No matching runs")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                    Text(query.isEmpty ? "Orchestrated workflows and Codex runs from your Mac appear here." : "Try another search term or switch the source filter.")
                        .font(.caption)
                        .foregroundStyle(Brand.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .brandCard()
            } else {
                LazyVStack(spacing: 10) {
                    ForEach(filteredRuns) { run in
                        NavigationLink(value: AgentFlowRoute.run(run.id)) {
                            runCard(run)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func runCard(_ run: AgentFlowRunSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                AgentFlowStatusPill(status: run.status)
                Text(LocalizedStringKey(AgentFlowFormat.sourceLabel(run.source)))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Brand.muted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Brand.paper, in: Capsule())
                Spacer(minLength: 4)
                Text(AgentFlowFormat.relativeTime(run.updatedAt, locale: locale))
                    .font(.caption2)
                    .foregroundStyle(Brand.muted)
                    .lineLimit(1)
            }

            Text(run.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Brand.ink)
                .lineLimit(2)
                .multilineTextAlignment(.leading)

            HStack(spacing: 6) {
                agentBadgesRow(run.agents)
                Spacer(minLength: 6)
                if run.nodeCount > 0 {
                    Text("\(run.acceptedCount)/\(run.nodeCount)")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Brand.muted)
                }
                Text("\(AgentFlowFormat.tokens(run.usage.totalTokens)) tok")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Brand.ink)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Brand.paper, in: Capsule())
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Brand.muted)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .brandCard(radius: 18)
    }

    private func agentBadgesRow(_ agents: [String]) -> some View {
        let visible = Array(agents.prefix(3))
        let overflow = max(0, agents.count - visible.count)
        return HStack(spacing: 4) {
            ForEach(visible, id: \.self) { agentId in
                let tint = AgentFlowFormat.agentTint(agentId)
                Text(AgentFlowFormat.agentDisplayName(agentId))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint)
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(tint.opacity(0.14), in: Capsule())
            }
            if overflow > 0 {
                Text("+\(overflow)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Brand.muted)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(Brand.line, in: Capsule())
            }
        }
    }

    private var emptyStudioCard: some View {
        VStack(spacing: 12) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.largeTitle)
                .foregroundStyle(Brand.relayText)
            Text("Agent-Flow Studio")
                .font(Brand.title(20, relativeTo: .title3))
            Text(model.isConnected ? "Pull down to refresh runs and token telemetry from your Mac." : "Connect to your Mac to view orchestrated runs and live token telemetry.")
                .font(.subheadline)
                .foregroundStyle(Brand.muted)
                .multilineTextAlignment(.center)
            if model.isConnected {
                Button("Refresh") {
                    Task { await refresh() }
                }
                .buttonStyle(RelayButtonStyle(fullWidth: false, compact: true))
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .brandCard()
    }
}

// MARK: - Run Detail Screen

struct AgentFlowRunDetailView: View {
    @Environment(\.locale) private var locale
    @Environment(AppModel.self) private var model
    let runId: String

    @State private var detail: AgentFlowRunDetail?
    @State private var loading = false
    @State private var error: String?
    @State private var selectedTab: DetailTab = .flow
    @State private var expandedNodes: Set<String> = []
    @State private var copiedText: String?

    private enum DetailTab: String, CaseIterable, Identifiable {
        case flow = "Flow"
        case events = "Events"
        case spec = "Spec"

        var id: String { rawValue }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let detail {
                    runHeaderAndTelemetryCard(detail)
                    Picker("View", selection: $selectedTab) {
                        ForEach(DetailTab.allCases) { tab in
                            Text(tabLabel(tab, detail: detail)).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)

                    switch selectedTab {
                    case .flow:
                        flowPipelineSection(detail)
                    case .events:
                        eventsTimelineSection(detail)
                    case .spec:
                        specSection(detail)
                    }
                } else if loading {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Loading run details…")
                            .font(.subheadline)
                            .foregroundStyle(Brand.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 64)
                } else if let error {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.title2)
                            .foregroundStyle(Brand.failure)
                        Text("Couldn't load run")
                            .font(.headline)
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Brand.muted)
                            .multilineTextAlignment(.center)
                        Button("Retry") {
                            Task { await load() }
                        }
                        .buttonStyle(RelayButtonStyle(fullWidth: false, compact: true))
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity)
                    .brandCard()
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
        }
        .brandScreen()
        .toolbar(.visible, for: .navigationBar)
        .brandNavigationTitle(detail.map { "\($0.slug)" } ?? "Run Detail")
        .refreshable { await load() }
        .task(id: runId) { await load() }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let loaded = try await model.loadAgentFlowRun(id: runId)
            detail = loaded
            if expandedNodes.isEmpty, let first = loaded.nodes.first {
                expandedNodes.insert(first.id)
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func tabLabel(_ tab: DetailTab, detail: AgentFlowRunDetail) -> LocalizedStringKey {
        switch tab {
        case .flow: return "Flow (\(detail.nodes.count))"
        case .events: return "Events (\(detail.events.count))"
        case .spec: return "Spec"
        }
    }

    private func runHeaderAndTelemetryCard(_ detail: AgentFlowRunDetail) -> some View {
        let usage = detail.usage
        return VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    AgentFlowStatusPill(status: detail.status)
                    Text(LocalizedStringKey(AgentFlowFormat.sourceLabel(detail.source)))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(Brand.paper, in: Capsule())
                    Spacer(minLength: 4)
                    Label(AgentFlowFormat.duration(ms: detail.durationMs), systemImage: "clock")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(Brand.muted)
                }

                Text(detail.name)
                    .font(Brand.title(20, relativeTo: .title3))
                    .foregroundStyle(Brand.ink)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 10) {
                    Text(detail.slug)
                        .font(.caption.monospaced())
                        .foregroundStyle(Brand.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text(AgentFlowFormat.relativeTime(detail.updatedAt, locale: locale))
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                }
            }

            Divider().overlay(Brand.separator)

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Token Breakdown")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                    Spacer()
                    Text("\(AgentFlowFormat.cacheRate(usage.cacheHitRate)) cache hit")
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(usage.cacheHitRate > 0 ? Brand.successText : Brand.muted)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(usage.cacheHitRate > 0 ? Brand.successSoft : Brand.line, in: Capsule())
                }

                AgentFlowTokenBar(usage: usage, height: 10)

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                    exactTokenCell(label: "Input", value: usage.inputTokens, color: AgentFlowTokenBar.inputColor)
                    exactTokenCell(label: "Cache Read", value: usage.cacheReadTokens, color: AgentFlowTokenBar.cacheColor)
                    exactTokenCell(label: "Output", value: usage.outputTokens, color: AgentFlowTokenBar.outputColor)
                    exactTokenCell(label: "Thinking", value: usage.thinkingTokens, color: AgentFlowTokenBar.thinkingColor)
                }

                HStack {
                    Text("Total Tokens")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                    Spacer()
                    Text(AgentFlowFormat.exact(usage.totalTokens))
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle(Brand.ink)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Brand.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .brandCard()
    }

    private func exactTokenCell(label: String, value: Int, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(LocalizedStringKey(label))
                .font(.caption2.weight(.medium))
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(AgentFlowFormat.exact(value))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(Brand.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Brand.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: Flow Pipeline Tab

    private func flowPipelineSection(_ detail: AgentFlowRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            orchestratorHeaderNode(detail)

            if detail.nodes.isEmpty {
                pipelineConnector(tint: Brand.line)
                Text("No subtask nodes recorded for this run yet.")
                    .font(.subheadline)
                    .foregroundStyle(Brand.muted)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .brandCard(radius: 16)
            } else {
                ForEach(Array(detail.nodes.enumerated()), id: \.element.id) { _, node in
                    pipelineConnector(tint: AgentFlowFormat.agentTint(node.agent))
                    subtaskNodeCard(node)
                }
            }
        }
    }

    private func orchestratorHeaderNode(_ detail: AgentFlowRunDetail) -> some View {
        let tint = AgentFlowFormat.agentTint("antigravity")
        return HStack(spacing: 12) {
            Image(systemName: "atom")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(tint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("Orchestrator Brain")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Brand.ink)
                    Text("BRAIN")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(tint.opacity(0.14), in: Capsule())
                }
                Text("\(detail.nodes.count) nodes · \(detail.acceptedCount) accepted · \(detail.eventCount) events")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(Brand.muted)
            }
            Spacer(minLength: 4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .brandCard(radius: 18)
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(tint.opacity(0.35), lineWidth: 1.5)
        )
    }

    private func pipelineConnector(tint: Color) -> some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                Rectangle()
                    .fill(tint.opacity(0.45))
                    .frame(width: 2, height: 12)
                Circle()
                    .fill(tint)
                    .frame(width: 6, height: 6)
                Rectangle()
                    .fill(tint.opacity(0.45))
                    .frame(width: 2, height: 12)
            }
            .padding(.leading, 31)
            Spacer()
        }
        .accessibilityHidden(true)
    }

    private func subtaskNodeCard(_ node: AgentFlowNode) -> some View {
        let tint = AgentFlowFormat.agentTint(node.agent)
        let isExpanded = expandedNodes.contains(node.id)

        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    if isExpanded { expandedNodes.remove(node.id) }
                    else { expandedNodes.insert(node.id) }
                }
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: AgentFlowFormat.agentSymbol(node.agent))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(width: 24, height: 24)
                            .background(tint, in: RoundedRectangle(cornerRadius: 7, style: .continuous))

                        Text(AgentFlowFormat.agentDisplayName(node.agent))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(tint)
                            .lineLimit(1)

                        Text("R\(node.round)")
                            .font(.caption2.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(Brand.muted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Brand.paper, in: Capsule())

                        Spacer(minLength: 4)

                        AgentFlowStatusPill(status: node.status)

                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Brand.muted)
                    }

                    Text(node.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        Text(nodeModelCaption(node))
                            .font(.caption2.monospaced())
                            .foregroundStyle(Brand.muted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 4)
                        Text(AgentFlowFormat.duration(ms: node.durationMs))
                            .font(.caption2.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(Brand.muted)
                        if node.usage.hasTokens {
                            Text("\(AgentFlowFormat.tokens(node.usage.totalTokens)) tok")
                                .font(.caption2.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(Brand.ink)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Brand.paper, in: Capsule())
                        }
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 12) {
                    Divider().overlay(Brand.separator)

                    if !node.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(node.summary)
                            .font(.footnote)
                            .foregroundStyle(Brand.ink)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let note = node.note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "note.text")
                                .font(.caption)
                                .foregroundStyle(Brand.warning)
                                .padding(.top, 2)
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(Brand.warningText)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Brand.warningSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    if node.usage.hasTokens {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("Node Tokens")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(Brand.muted)
                                Spacer()
                                Text("\(AgentFlowFormat.cacheRate(node.usage.cacheHitRate)) cache")
                                    .font(.caption2.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(node.usage.cacheHitRate > 0 ? Brand.successText : Brand.muted)
                            }
                            AgentFlowTokenBar(usage: node.usage, height: 6)
                            AgentFlowTokenLegend(usage: node.usage)
                        }
                        .padding(10)
                        .background(Brand.paper, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    if !node.artifacts.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Artifacts (\(node.artifacts.count))")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Brand.muted)
                            ForEach(node.artifacts, id: \.self) { artifact in
                                copyableArtifactRow(artifact)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 14)
            }
        }
        .brandCard(radius: 18)
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 0, topTrailingRadius: 0)
                .fill(tint)
                .frame(width: 4)
        }
    }

    private func nodeModelCaption(_ node: AgentFlowNode) -> String {
        if let effort = node.effort, !effort.isEmpty {
            return "\(node.model) · \(effort)"
        }
        return node.model
    }

    private func copyableArtifactRow(_ path: String) -> some View {
        let isCopied = copiedText == path
        return Button {
            UIPasteboard.general.string = path
            copiedText = path
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .font(.caption)
                    .foregroundStyle(Brand.relayText)
                VStack(alignment: .leading, spacing: 1) {
                    Text(path.lastPathComponentName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                        .lineLimit(1)
                    Text(path.abbreviatedPath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Brand.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 4)
                Image(systemName: isCopied ? "checkmark" : "doc.on.doc")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(isCopied ? Brand.successText : Brand.muted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Brand.paper, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy artifact path \(path.lastPathComponentName)")
    }

    // MARK: Events Timeline Tab

    private func eventsTimelineSection(_ detail: AgentFlowRunDetail) -> some View {
        let sorted = detail.events.sorted { $0.seq < $1.seq }
        return Group {
            if sorted.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "list.bullet.rectangle")
                        .font(.title3)
                        .foregroundStyle(Brand.muted)
                    Text("No timeline events recorded.")
                        .font(.subheadline)
                        .foregroundStyle(Brand.muted)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .brandCard()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(sorted.enumerated()), id: \.element.id) { index, event in
                        eventRow(event)
                        if index < sorted.count - 1 {
                            Divider().overlay(Brand.separator).padding(.leading, 36)
                        }
                    }
                }
                .padding(.vertical, 4)
                .brandCard()
            }
        }
    }

    private func eventRow(_ event: AgentFlowEvent) -> some View {
        let tint = AgentFlowFormat.agentTint(event.agent)
        return HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 4) {
                Circle()
                    .fill(tint)
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)
                Text("#\(event.seq)")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Brand.muted)
            }
            .frame(width: 28)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    AgentFlowStatusPill(status: event.event)
                    Text(event.sub)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(AgentFlowFormat.relativeTime(event.ts, locale: locale))
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                        .lineLimit(1)
                }

                HStack(spacing: 6) {
                    Text(AgentFlowFormat.agentDisplayName(event.agent))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(tint)
                    Text("·")
                        .foregroundStyle(Brand.muted)
                    Text(event.model)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Brand.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("· R\(event.round)")
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(Brand.muted)
                    Spacer(minLength: 4)
                    if let usage = event.usage, usage.hasTokens {
                        Text("\(AgentFlowFormat.tokens(usage.totalTokens)) tok")
                            .font(.caption2.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(Brand.muted)
                    }
                }

                if !event.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(event.summary)
                        .font(.caption)
                        .foregroundStyle(Brand.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let note = event.note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text(note)
                        .font(.caption2)
                        .foregroundStyle(Brand.warningText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: Spec Tab

    private func specSection(_ detail: AgentFlowRunDetail) -> some View {
        Group {
            if let spec = detail.spec, !spec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Label("spec.md", systemImage: "doc.plaintext")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Brand.muted)
                        Spacer()
                        Button {
                            UIPasteboard.general.string = spec
                            copiedText = "__spec__"
                        } label: {
                            Label(copiedText == "__spec__" ? "Copied" : "Copy", systemImage: copiedText == "__spec__" ? "checkmark" : "doc.on.doc")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(copiedText == "__spec__" ? Brand.successText : Brand.relayText)
                        }
                        .buttonStyle(.plain)
                    }
                    Divider().overlay(Brand.separator)
                    ConversationMarkdown(text: spec)
                        .foregroundStyle(Brand.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
                .brandCard()
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "doc.text")
                        .font(.title3)
                        .foregroundStyle(Brand.muted)
                    Text("No Spec Attached")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                    Text("This run does not include a spec.md or brief document.")
                        .font(.caption)
                        .foregroundStyle(Brand.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
                .brandCard()
            }
        }
    }
}

// MARK: - Shared Agent-Flow UI Primitives

struct AgentFlowTokenBar: View {
    let usage: AgentFlowUsage
    var height: CGFloat = 8

    static let inputColor = Brand.relay
    static let cacheColor = Brand.success
    static let outputColor = Color(red: 0.85, green: 0.54, blue: 0.04)
    static let thinkingColor = Brand.antigravity

    var body: some View {
        GeometryReader { proxy in
            let total = Double(usage.breakdownTotal)
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Brand.line)
                if total > 0, width > 0 {
                    HStack(spacing: 1) {
                        segment(value: usage.directInputTokens, total: total, color: Self.inputColor, totalWidth: width)
                        segment(value: usage.cacheReadTokens, total: total, color: Self.cacheColor, totalWidth: width)
                        segment(value: usage.outputTokens, total: total, color: Self.outputColor, totalWidth: width)
                        segment(value: usage.thinkingTokens, total: total, color: Self.thinkingColor, totalWidth: width)
                    }
                    .clipShape(Capsule())
                }
            }
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Token breakdown: \(AgentFlowFormat.tokens(usage.totalTokens)) total, \(AgentFlowFormat.cacheRate(usage.cacheHitRate)) cache hit")
    }

    @ViewBuilder
    private func segment(value: Int, total: Double, color: Color, totalWidth: CGFloat) -> some View {
        if value > 0 {
            let fraction = CGFloat(Double(value) / total)
            Rectangle()
                .fill(color)
                .frame(width: max(3, totalWidth * fraction))
        }
    }
}

struct AgentFlowTokenLegend: View {
    let usage: AgentFlowUsage

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 6) {
            item(color: AgentFlowTokenBar.inputColor, title: "Input", count: usage.directInputTokens)
            item(color: AgentFlowTokenBar.cacheColor, title: "Cache Hit", count: usage.cacheReadTokens)
            item(color: AgentFlowTokenBar.outputColor, title: "Output", count: usage.outputTokens)
            item(color: AgentFlowTokenBar.thinkingColor, title: "Thinking", count: usage.thinkingTokens)
        }
    }

    private func item(color: Color, title: String, count: Int) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
            Text(LocalizedStringKey(title))
                .font(.caption2)
                .foregroundStyle(Brand.muted)
                .lineLimit(1)
            Spacer(minLength: 2)
            Text(AgentFlowFormat.tokens(count))
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(Brand.ink)
                .lineLimit(1)
        }
    }
}

struct AgentFlowStatusDot: View {
    let status: String

    var body: some View {
        if status.lowercased() == "dispatched" {
            RunningDot()
        } else {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
        }
    }

    private var dotColor: Color {
        switch status.lowercased() {
        case "accepted": return Brand.success
        case "delivered": return Brand.relay
        case "rejected": return Brand.failure
        default: return Brand.muted
        }
    }
}

struct AgentFlowStatusPill: View {
    let status: String

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(dotColor)
                .frame(width: 6, height: 6)
            Text(LocalizedStringKey(AgentFlowFormat.statusLabel(status)))
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(foreground)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(background, in: Capsule())
    }

    private var normalized: String { status.lowercased() }

    private var dotColor: Color {
        switch normalized {
        case "dispatched": return Brand.relay
        case "delivered": return Brand.warning
        case "accepted": return Brand.success
        case "rejected": return Brand.failure
        default: return Brand.muted
        }
    }

    private var foreground: Color {
        switch normalized {
        case "dispatched": return Brand.relayText
        case "delivered": return Brand.warningText
        case "accepted": return Brand.successText
        case "rejected": return Brand.failureText
        default: return Brand.muted
        }
    }

    private var background: Color {
        switch normalized {
        case "dispatched": return Brand.relaySoft
        case "delivered": return Brand.warningSoft
        case "accepted": return Brand.successSoft
        case "rejected": return Brand.failureSoft
        default: return Brand.line
        }
    }
}
