import AppKit
import SwiftUI

struct AgentHubView: View {
    @Environment(\.locale) private var locale
    @Environment(BridgeModel.self) private var model
    @Environment(SystemActions.self) private var system
    @Environment(Updater.self) private var updater
    @Environment(\.openWindow) private var openWindow

    @State private var section: HubSection = .commandCenter
    @State private var selectedAgent: String = Brand.agents.first?.0 ?? "claude"
    @State private var selectedSessionId: String?
    @State private var selectedTaskId: String?

    @State private var sessionSearch = ""
    @State private var messages: [HubChatMessage] = []
    @State private var loadingSessions = false
    @State private var loadingMessages = false

    @State private var selectedCwd: String = ""
    @State private var selectedModelId: String = ""
    @State private var selectedEffort: String = ""
    @State private var permissionMode: HubPermissionMode = .acceptEdits
    @State private var promptText = ""
    @State private var sending = false
    @State private var cancelling = false
    @State private var composerError: String?
    @State private var stageNotice: String?

    var body: some View {
        HStack(spacing: 0) {
            leftNavigationRail
                .frame(width: 232)
            Divider().overlay(Brand.line)

            Group {
                if section == .agentFlow {
                    AgentFlowView()
                } else if !model.isRunning {
                    bridgeOfflineStage
                } else {
                    HStack(spacing: 0) {
                        sessionsColumn
                            .frame(width: 264)
                        Divider().overlay(Brand.line)
                        conversationStage
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 1020, minHeight: 680)
        .brandScreen()
        .onAppear {
            section = model.hubInitialSection
            ensureValidSelectedAgent()
        }
        .onChange(of: model.hubInitialSection) { _, newValue in
            section = newValue
        }
        .onChange(of: model.disabledAgents) { _, _ in
            ensureValidSelectedAgent()
        }
        .task(id: model.isRunning) {
            guard model.isRunning else {
                messages = []
                return
            }
            ensureValidSelectedAgent()
            await bootstrapBridgeData()
        }
        .onChange(of: selectedAgent) { _, nextAgent in
            guard model.isRunning else { return }
            Task { await loadAgentResources(agent: nextAgent) }
        }
        .onChange(of: activeTask?.sessionId) { _, boundSessionId in
            guard let boundSessionId, !boundSessionId.isEmpty else { return }
            if selectedSessionId == nil, activeTask?.id == selectedTaskId {
                selectedSessionId = boundSessionId
                Task {
                    _ = try? await model.loadSessions(agent: selectedAgent)
                }
            }
        }
        .onChange(of: activeTask?.status) { oldStatus, newStatus in
            guard oldStatus == .running, let newStatus, newStatus.isTerminal else { return }
            Task {
                _ = try? await model.loadSessions(agent: selectedAgent)
                if let sessionId = selectedSessionId ?? activeTask?.sessionId {
                    await reloadMessages(agent: selectedAgent, sessionId: sessionId)
                }
            }
        }
    }

    // MARK: - Derived State

    private var enabledAgents: [(String, String)] {
        Brand.agents.filter { !model.disabledAgents.contains($0.0) }
    }

    private var selectedAgentInfo: AgentInfo? {
        model.agents.first { $0.kind == selectedAgent }
    }

    private var selectedAgentSessions: [HubSessionSummary] {
        let all = model.sessionsByAgent[selectedAgent] ?? []
        let query = sessionSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return all }
        return all.filter { session in
            session.displayTitle.lowercased().contains(query)
                || session.cwd.lowercased().contains(query)
                || (session.preview?.lowercased().contains(query) ?? false)
        }
    }

    private var selectedSession: HubSessionSummary? {
        guard let selectedSessionId else { return nil }
        return (model.sessionsByAgent[selectedAgent] ?? []).first { $0.id == selectedSessionId }
    }

    private var activeTask: HubTaskInfo? {
        if let selectedTaskId, let task = model.tasks[selectedTaskId] {
            return task
        }
        if let selectedSessionId {
            return model.sortedTasks.first { $0.agent == selectedAgent && $0.sessionId == selectedSessionId }
        }
        return nil
    }

    private var activeTaskEvents: [HubTaskEvent] {
        guard let task = activeTask else { return [] }
        return model.taskEvents[task.id] ?? []
    }

    private var activeTaskDraft: HubTaskDraft? {
        guard let task = activeTask, task.status == .running else { return nil }
        return model.taskDrafts[task.id]
    }

    private var availableModels: [HubModelOption] {
        model.modelsByAgent[selectedAgent] ?? []
    }

    private var currentModelOption: HubModelOption? {
        if let match = availableModels.first(where: { $0.id == selectedModelId }) {
            return match
        }
        return availableModels.first(where: { $0.isDefault }) ?? availableModels.first
    }

    private var activeEfforts: [String] {
        currentModelOption?.efforts ?? []
    }

    private var effectiveCwd: String {
        if let session = selectedSession, !session.cwd.isEmpty {
            return session.cwd
        }
        if !selectedCwd.isEmpty {
            return selectedCwd
        }
        return model.recentProjects.first?.path ?? FileManager.default.homeDirectoryForCurrentUser.path
    }

    private var canSend: Bool {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard model.isRunning, !trimmed.isEmpty, !sending else { return false }
        if activeTask?.status == .running { return false }
        if selectedSessionId == nil && effectiveCwd.isEmpty { return false }
        return true
    }

    // MARK: - Left Navigation Rail

    private var leftNavigationRail: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 9) {
                BrandMark(size: 26)
                BrandWordmark(size: 17)
                Spacer(minLength: 4)
                bridgeStatusPill
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)

            // Primary mode switcher
            VStack(spacing: 4) {
                ForEach(HubSection.allCases) { item in
                    let isSelected = section == item
                    Button {
                        section = item
                        model.hubInitialSection = item
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: item.symbol)
                                .font(.system(size: 13, weight: .semibold))
                                .frame(width: 18)
                            Text(LocalizedStringKey(item.title))
                                .font(.subheadline.weight(.semibold))
                            Spacer(minLength: 0)
                            if item == .agentFlow {
                                let runningCount = model.tasks.values.filter { $0.status == .running }.count
                                if runningCount > 0 {
                                    Text("\(runningCount)")
                                        .font(.caption2.weight(.bold).monospacedDigit())
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Brand.relay, in: Capsule())
                                }
                            }
                        }
                        .foregroundStyle(isSelected ? Brand.relayText : Brand.ink)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            isSelected ? Brand.relaySoft : .clear,
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)

            Divider().overlay(Brand.separator).padding(.horizontal, 12)

            if section == .commandCenter {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        // Agents section
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("AGENTS")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(Brand.muted)
                                Spacer()
                                Button {
                                    Task { try? await model.refreshAgents() }
                                } label: {
                                    Image(systemName: "arrow.clockwise")
                                        .font(.caption2)
                                        .foregroundStyle(Brand.muted)
                                }
                                .buttonStyle(.plain)
                                .help("Refresh agents")
                            }
                            .padding(.horizontal, 14)

                            ForEach(enabledAgents, id: \.0) { kind, fallback in
                                agentRailRow(kind: kind, fallback: fallback)
                            }
                        }

                        // Tasks section
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("TASKS")
                                    .font(.system(size: 10, weight: .bold))
                                    .foregroundStyle(Brand.muted)
                                Spacer()
                                if !model.tasks.isEmpty {
                                    Text("\(model.tasks.count)")
                                        .font(.caption2.monospacedDigit())
                                        .foregroundStyle(Brand.muted)
                                }
                            }
                            .padding(.horizontal, 14)

                            if model.sortedTasks.isEmpty {
                                Text("No recent tasks")
                                    .font(.caption)
                                    .foregroundStyle(Brand.muted)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 4)
                            } else {
                                ForEach(Array(model.sortedTasks.prefix(12))) { task in
                                    taskRailRow(task)
                                }
                            }
                        }
                    }
                    .padding(.bottom, 10)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("STUDIO OVERVIEW")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Brand.muted)
                    Text("Inspect multi-agent DAG dispatches, token cache efficiency, team readiness, and run specs.")
                        .font(.caption)
                        .foregroundStyle(Brand.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    let runningTasks = model.sortedTasks.filter { $0.status == .running }
                    if !runningTasks.isEmpty {
                        Divider().overlay(Brand.separator).padding(.vertical, 4)
                        Text("RUNNING NOW (\(runningTasks.count))")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Brand.relayText)
                        ForEach(runningTasks.prefix(5)) { task in
                            taskRailRow(task)
                                .padding(.horizontal, -14)
                        }
                    }
                }
                .padding(.horizontal, 14)
                Spacer(minLength: 0)
            }

            Divider().overlay(Brand.separator)

            // Bottom utility footer
            VStack(spacing: 6) {
                HStack(spacing: 6) {
                    utilityButton("Pairing", symbol: "qrcode", windowId: "pairing")
                    utilityButton("Account", symbol: "person.crop.circle", windowId: "account")
                }
                HStack(spacing: 6) {
                    utilityButton("Settings", symbol: "gearshape", windowId: "settings")
                    utilityButton("Logs", symbol: "doc.plaintext", windowId: "logs")
                }
            }
            .padding(10)
        }
        .background(Brand.surface)
    }

    private func agentRailRow(kind: String, fallback: String) -> some View {
        let info = model.agents.first { $0.kind == kind }
        let isSelected = selectedAgent == kind
        let runningTasksCount = model.tasks.values.filter { $0.agent == kind && $0.status == .running }.count
        let liveCount = max(runningTasksCount, info?.runningProcesses ?? 0)

        return HStack(spacing: 8) {
            Button {
                selectAgent(kind, startNewSession: false)
            } label: {
                HStack(spacing: 8) {
                    AgentIcon(kind: kind, iconPath: info?.iconPath, size: 22)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(info?.name ?? fallback)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Brand.ink)
                            .lineLimit(1)
                        HStack(spacing: 4) {
                            Circle()
                                .fill(agentDotColor(info?.status))
                                .frame(width: 6, height: 6)
                            Text(LocalizedStringKey(info?.statusLabel ?? "Checking…"))
                                .font(.system(size: 10))
                                .foregroundStyle(Brand.muted)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 2)
                    if liveCount > 0 {
                        Text("\(liveCount)")
                            .font(.system(size: 10, weight: .bold).monospacedDigit())
                            .foregroundStyle(Brand.successText)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Brand.successSoft, in: Capsule())
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                selectAgent(kind, startNewSession: true)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Brand.muted)
                    .frame(width: 22, height: 22)
                    .background(Brand.paper, in: Circle())
                    .overlay(Circle().strokeBorder(Brand.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .help("New \(info?.name ?? fallback) session")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            isSelected ? Brand.paper : .clear,
            in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isSelected ? Brand.line : .clear, lineWidth: 1)
        )
        .padding(.horizontal, 8)
    }

    private func taskRailRow(_ task: HubTaskInfo) -> some View {
        let isSelected = activeTask?.id == task.id && section == .commandCenter
        return Button {
            openTask(task)
        } label: {
            HStack(spacing: 8) {
                taskStatusIcon(task.status)
                    .frame(width: 14, height: 14)

                VStack(alignment: .leading, spacing: 2) {
                    Text(task.promptSummary)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Brand.ink)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text(Brand.agentName(task.agent))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(AgentFlowFormat.agentAccent(task.agent))
                        Text("·")
                            .font(.system(size: 10))
                            .foregroundStyle(Brand.muted)
                        Text(AgentFlowFormat.relativeTime(task.startedAt, locale: locale))
                            .font(.system(size: 10))
                            .foregroundStyle(Brand.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isSelected ? Brand.relaySoft.opacity(0.7) : .clear,
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
    }

    private func utilityButton(_ title: String, symbol: String, windowId: String) -> some View {
        Button {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: windowId)
        } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.caption2.weight(.semibold))
                Text(LocalizedStringKey(title))
                    .font(.caption2.weight(.semibold))
            }
            .foregroundStyle(Brand.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(Brand.paper, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var bridgeStatusPill: some View {
        let title: String
        let fg: Color
        let bg: Color
        switch model.state {
        case .running:
            title = "Live"
            fg = Brand.successText
            bg = Brand.successSoft
        case .starting:
            title = "Starting"
            fg = Brand.warningText
            bg = Brand.warningSoft
        case .stopped:
            title = "Off"
            fg = Brand.muted
            bg = Brand.separator
        case .failed:
            title = "Error"
            fg = Brand.failureText
            bg = Brand.failureSoft
        }
        return Text(LocalizedStringKey(title))
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(fg)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(bg, in: Capsule())
    }

    // MARK: - Sessions Column

    private var sessionsColumn: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Text(selectedAgentInfo?.name ?? Brand.agentName(selectedAgent))
                    .font(Brand.title(15, relativeTo: .headline, weight: .bold))
                    .foregroundStyle(Brand.ink)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if loadingSessions {
                    ProgressView().controlSize(.small)
                }
                Button {
                    Task { await reloadSessions(agent: selectedAgent) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                        .frame(width: 26, height: 26)
                        .background(Brand.surface, in: Circle())
                        .overlay(Circle().strokeBorder(Brand.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("Refresh sessions")
            }

            Button {
                startNewSessionDraft()
            } label: {
                Label("New Session", systemImage: "square.and.pencil")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Brand.relay, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)

            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(Brand.muted)
                TextField("Filter sessions…", text: $sessionSearch)
                    .textFieldStyle(.plain)
                    .font(.caption)
                if !sessionSearch.isEmpty {
                    Button {
                        sessionSearch = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(Brand.muted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))

            ScrollView {
                LazyVStack(spacing: 6) {
                    if selectedAgentSessions.isEmpty {
                        VStack(spacing: 6) {
                            Text(loadingSessions ? "Loading sessions…" : "No sessions yet")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Brand.muted)
                            Text("Start a new session below to run your first prompt.")
                                .font(.caption2)
                                .foregroundStyle(Brand.muted)
                                .multilineTextAlignment(.center)
                        }
                        .padding(.vertical, 28)
                        .padding(.horizontal, 10)
                    } else {
                        ForEach(selectedAgentSessions) { session in
                            sessionRow(session, isSelected: session.id == selectedSessionId)
                                .onTapGesture {
                                    selectSession(session)
                                }
                        }
                    }
                }
                .padding(.bottom, 10)
            }
        }
        .padding(12)
        .background(Brand.paper)
    }

    private func sessionRow(_ session: HubSessionSummary, isSelected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                if session.running {
                    Circle()
                        .fill(Brand.success)
                        .frame(width: 7, height: 7)
                }
                Text(session.displayTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.ink)
                    .lineLimit(2)
                Spacer(minLength: 2)
            }

            HStack(spacing: 6) {
                Text(AgentFlowFormat.shortPath(session.cwd))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Brand.muted)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 4)
                if let origin = session.origin, !origin.isEmpty {
                    Text(origin.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(Brand.muted)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Brand.separator, in: Capsule())
                }
                Text(AgentFlowFormat.relativeTime(session.updatedAt, locale: locale))
                    .font(.system(size: 10))
                    .foregroundStyle(Brand.muted)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isSelected ? Brand.relaySoft.opacity(0.65) : Brand.surface,
            in: RoundedRectangle(cornerRadius: 11, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(isSelected ? Brand.relay : Brand.line, lineWidth: isSelected ? 1.5 : 1)
        )
        .contentShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    }

    // MARK: - Conversation & Task Stage

    private var conversationStage: some View {
        VStack(spacing: 0) {
            stageTopBar
            Divider().overlay(Brand.line)
            feedScrollArea
            Divider().overlay(Brand.line)
            composerDock
        }
        .background(Brand.paper)
    }

    private var stageTopBar: some View {
        HStack(spacing: 10) {
            AgentIcon(kind: selectedAgent, iconPath: selectedAgentInfo?.iconPath, size: 28)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    (selectedSession.map { Text(verbatim: $0.displayTitle) } ?? Text("New Session"))
                        .font(Brand.title(16, relativeTo: .headline, weight: .bold))
                        .foregroundStyle(Brand.ink)
                        .lineLimit(1)

                    if let task = activeTask {
                        taskStatusBadge(task.status)
                    }
                }
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                    Text(AgentFlowFormat.shortPath(effectiveCwd))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(Brand.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer(minLength: 8)

            if loadingMessages {
                ProgressView().controlSize(.small)
            }

            if let sessionId = selectedSessionId {
                Button {
                    Task { await reloadMessages(agent: selectedAgent, sessionId: sessionId) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.muted)
                        .padding(7)
                        .background(Brand.surface, in: Circle())
                        .overlay(Circle().strokeBorder(Brand.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help("Reload messages")
            }

            if let task = activeTask, task.status == .running {
                Button {
                    Task { await stopActiveTask(task.id) }
                } label: {
                    Label(cancelling ? "Stopping…" : "Stop Task", systemImage: "stop.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.failureText)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 7)
                        .background(Brand.failureSoft, in: Capsule())
                        .overlay(Capsule().strokeBorder(Brand.failure.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(cancelling)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .background(Brand.surface.opacity(0.7))
    }

    private var feedScrollArea: some View {
        let task = activeTask
        let conversation = task.map { HubConversation(task: $0, messages: messages, events: activeTaskEvents) }
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if messages.isEmpty && activeTaskEvents.isEmpty && activeTaskDraft == nil && activeTask == nil {
                        emptyConversationPlaceholder
                    } else {
                        ForEach(messages) { message in
                            chatBubble(message)
                        }

                        if let task, let conversation {
                            if conversation.showsTaskPrompt {
                                userPromptBubble(text: task.prompt, timestamp: task.startedAt)
                            }

                            ForEach(conversation.visibleTaskEvents) { event in
                                taskEventCard(event)
                            }

                            if let draft = activeTaskDraft, !draft.text.isEmpty {
                                streamingDraftBubble(draft)
                            } else if task.status == .running {
                                runningIndicatorRow
                            }

                            if task.status == .failed, let error = task.error, !error.isEmpty {
                                resultBanner(text: error, isError: true)
                            } else if task.status == .cancelled {
                                resultBanner(text: "Task cancelled.", isError: false)
                            }
                        }
                    }

                    if let stageNotice {
                        Text(stageNotice)
                            .font(.caption)
                            .foregroundStyle(Brand.muted)
                            .padding(.top, 4)
                    }

                    Color.clear.frame(height: 2).id("hub-feed-bottom")
                }
                .padding(18)
            }
            .onChange(of: feedScrollAnchorKey) { _, _ in
                withAnimation(.easeOut(duration: 0.18)) {
                    proxy.scrollTo("hub-feed-bottom", anchor: .bottom)
                }
            }
        }
    }

    private var feedScrollAnchorKey: String {
        let msgKey = messages.last?.id ?? ""
        let evKey = activeTaskEvents.last?.seq ?? 0
        let draftLen = activeTaskDraft?.text.count ?? 0
        let taskKey = activeTask?.id ?? ""
        return "\(taskKey)-\(msgKey)-\(evKey)-\(draftLen)"
    }

    private var emptyConversationPlaceholder: some View {
        VStack(spacing: 12) {
            AgentIcon(kind: selectedAgent, iconPath: selectedAgentInfo?.iconPath, size: 42)
            Text("Command \(selectedAgentInfo?.name ?? Brand.agentName(selectedAgent))")
                .font(Brand.title(20, relativeTo: .title3, weight: .bold))
                .foregroundStyle(Brand.ink)
            Text("Choose a project folder, model, and permission level below, then send a prompt with ⌘↩.")
                .font(.callout)
                .foregroundStyle(Brand.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let detail = selectedAgentInfo?.detail, selectedAgentInfo?.status != "ready" {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(Brand.warningText)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Brand.warningSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 56)
    }

    private func chatBubble(_ message: HubChatMessage) -> some View {
        HStack {
            if message.isUser { Spacer(minLength: 60) }
            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                Text(message.text)
                    .font(.body)
                    .foregroundStyle(message.isUser ? .white : Brand.ink)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        message.isUser ? Brand.relay : Brand.surface,
                        in: RoundedRectangle(cornerRadius: 15, style: .continuous)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 15, style: .continuous)
                            .strokeBorder(message.isUser ? .clear : Brand.line, lineWidth: 1)
                    )
                if let ts = message.timestamp {
                    Text(AgentFlowFormat.relativeTime(ts, locale: locale))
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                        .padding(.horizontal, 4)
                }
            }
            if !message.isUser { Spacer(minLength: 60) }
        }
    }

    private func userPromptBubble(text: String, timestamp: Double) -> some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 4) {
                Text(text)
                    .font(.body)
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Brand.relay, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                Text(AgentFlowFormat.relativeTime(timestamp, locale: locale))
                    .font(.caption2)
                    .foregroundStyle(Brand.muted)
                    .padding(.horizontal, 4)
            }
        }
    }

    @ViewBuilder
    private func taskEventCard(_ event: HubTaskEvent) -> some View {
        switch event.kind {
        case "text":
            if let text = event.text, !text.isEmpty {
                HStack {
                    Text(text)
                        .font(.body)
                        .foregroundStyle(Brand.ink)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
                    Spacer(minLength: 60)
                }
            }
        case "tool":
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .font(.caption)
                    .foregroundStyle(Brand.relayText)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(event.name ?? "Tool")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Brand.ink)
                    if let detail = event.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(Brand.muted)
                            .lineLimit(3)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
        case "file":
            let change = event.change ?? "modified"
            let badgeColor: Color = change == "created" ? Brand.success : (change == "deleted" ? Brand.failure : Brand.relay)
            let badgeSoft: Color = change == "created" ? Brand.successSoft : (change == "deleted" ? Brand.failureSoft : Brand.relaySoft)
            let badgeText: Color = change == "created" ? Brand.successText : (change == "deleted" ? Brand.failureText : Brand.relayText)
            HStack(spacing: 8) {
                Text(change.uppercased())
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(badgeText)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(badgeSoft, in: Capsule())
                Image(systemName: "doc.fill")
                    .font(.caption2)
                    .foregroundStyle(badgeColor)
                Text(AgentFlowFormat.shortPath(event.path ?? ""))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Brand.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
        case "status":
            if let text = event.text, !text.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "info.circle")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(Brand.muted)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Brand.separator.opacity(0.65), in: Capsule())
            }
        case "result":
            if let text = event.text, !text.isEmpty {
                resultBanner(text: text, isError: event.isError == true)
            }
        default:
            EmptyView()
        }
    }

    private func streamingDraftBubble(_ draft: HubTaskDraft) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Streaming response…")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Brand.relayText)
                }
                Text(draft.text)
                    .font(.body)
                    .foregroundStyle(Brand.ink)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .strokeBorder(Brand.relay.opacity(0.45), lineWidth: 1.2)
            )
            Spacer(minLength: 60)
        }
    }

    private var runningIndicatorRow: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("\(selectedAgentInfo?.name ?? Brand.agentName(selectedAgent)) is working…")
                .font(.caption.weight(.medium))
                .foregroundStyle(Brand.muted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Brand.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
    }

    private func resultBanner(text: String, isError: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(isError ? Brand.failureText : Brand.successText)
                .padding(.top, 2)
            Text(text)
                .font(.callout)
                .foregroundStyle(isError ? Brand.failureText : Brand.ink)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(
            isError ? Brand.failureSoft : Brand.successSoft.opacity(0.65),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder((isError ? Brand.failure : Brand.success).opacity(0.35), lineWidth: 1)
        )
    }

    // MARK: - Bottom Composer Dock

    private var composerDock: some View {
        VStack(alignment: .leading, spacing: 9) {
            // Project folder bar
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .font(.caption)
                    .foregroundStyle(Brand.relayText)

                if selectedSession != nil {
                    Text(AgentFlowFormat.shortPath(effectiveCwd))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Brand.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("Session workspace")
                        .font(.caption2)
                        .foregroundStyle(Brand.muted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Brand.separator, in: Capsule())
                } else {
                    Menu {
                        if model.recentProjects.isEmpty {
                            Text("No recent projects")
                        } else {
                            ForEach(model.recentProjects) { project in
                                Button {
                                    selectedCwd = project.path
                                } label: {
                                    Text("\(project.folderName) — \(AgentFlowFormat.shortPath(project.path))")
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Text(AgentFlowFormat.shortPath(effectiveCwd))
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(Brand.ink)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(Brand.muted)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Brand.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Brand.line, lineWidth: 1))
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize(horizontal: true, vertical: false)

                    Button("Choose Folder…") {
                        chooseFolder()
                    }
                    .buttonStyle(.plain)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Brand.relayText)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(Brand.relaySoft, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }

                Spacer(minLength: 4)
            }

            // Inline controls: Model, Effort, Permission Mode
            HStack(spacing: 8) {
                if !availableModels.isEmpty {
                    Menu {
                        ForEach(availableModels) { option in
                            Button {
                                selectedModelId = option.id
                                syncEffortForModel(option)
                            } label: {
                                Text(option.isDefault ? "\(option.name) (Default)" : option.name)
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "cpu")
                                .font(.caption2)
                                .foregroundStyle(Brand.muted)
                            (currentModelOption.map { Text(verbatim: $0.name) } ?? Text("Default model"))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Brand.ink)
                                .lineLimit(1)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Brand.muted)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Brand.surface, in: Capsule())
                        .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize(horizontal: true, vertical: false)
                }

                if !activeEfforts.isEmpty {
                    Menu {
                        ForEach(activeEfforts, id: \.self) { effort in
                            Button {
                                selectedEffort = effort
                            } label: {
                                Text(LocalizedStringKey(effort.capitalized))
                            }
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "gauge.with.dots.needle.67percent")
                                .font(.caption2)
                                .foregroundStyle(Brand.muted)
                            Text(LocalizedStringKey((selectedEffort.isEmpty ? (currentModelOption?.defaultEffort ?? activeEfforts.first ?? "") : selectedEffort).capitalized))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Brand.ink)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(Brand.muted)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(Brand.surface, in: Capsule())
                        .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize(horizontal: true, vertical: false)
                }

                Menu {
                    ForEach(HubPermissionMode.allCases) { mode in
                        Button {
                            permissionMode = mode
                        } label: {
                            Label(LocalizedStringKey(mode.label), systemImage: mode.symbol)
                        }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: permissionMode.symbol)
                            .font(.caption2)
                            .foregroundStyle(permissionMode == .full ? Brand.warningText : Brand.muted)
                        Text(LocalizedStringKey(permissionMode.label))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Brand.ink)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Brand.muted)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(Brand.surface, in: Capsule())
                    .overlay(Capsule().strokeBorder(Brand.line, lineWidth: 1))
                }
                .menuStyle(.borderlessButton)
                .fixedSize(horizontal: true, vertical: false)

                Spacer(minLength: 4)

                Text("⌘↩ to send")
                    .font(.caption2)
                    .foregroundStyle(Brand.muted)
            }

            // Prompt input + Send button
            HStack(alignment: .bottom, spacing: 10) {
                ZStack(alignment: .topLeading) {
                    if promptText.isEmpty {
                        Text(selectedSession == nil
                             ? "Ask \(selectedAgentInfo?.name ?? Brand.agentName(selectedAgent)) to build, inspect, or debug…"
                             : "Send a follow-up to this session…")
                            .font(.body)
                            .foregroundStyle(Brand.muted)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .allowsHitTesting(false)
                    }
                    TextEditor(text: $promptText)
                        .font(.body)
                        .foregroundStyle(Brand.ink)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 5)
                        .frame(minHeight: 54, maxHeight: 120)
                }
                .background(Brand.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(Brand.line, lineWidth: 1.2))

                Button {
                    Task { await sendPrompt() }
                } label: {
                    HStack(spacing: 6) {
                        if sending {
                            ProgressView().controlSize(.small).tint(.white)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 13, weight: .bold))
                        }
                        Text("Send")
                            .font(.callout.weight(.semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .background(canSend ? Brand.relay : Brand.relay.opacity(0.4), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .keyboardShortcut(.return, modifiers: .command)
            }

            if let composerError {
                Text(composerError)
                    .font(.caption)
                    .foregroundStyle(Brand.failureText)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Brand.surface.opacity(0.65))
    }

    // MARK: - Bridge Offline Stage

    private var bridgeOfflineStage: some View {
        VStack(spacing: 14) {
            Image(systemName: model.state == .starting ? "arrow.triangle.2.circlepath" : "bolt.slash.circle")
                .font(.system(size: 38))
                .foregroundStyle(model.state == .starting ? Brand.relay : Brand.warning)

            Text(LocalizedStringKey(model.state.label))
                .font(Brand.title(20, relativeTo: .title3, weight: .bold))
                .foregroundStyle(Brand.ink)

            if model.fatalCode == "port_in_use" {
                Text(model.portConflictMessage)
                    .font(.callout)
                    .foregroundStyle(Brand.failureText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
            } else if case .failed(let message) = model.state {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(Brand.failureText)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 440)
            } else {
                Text("Waiting for the local AgentTote Bridge to become ready before loading agents and sessions.")
                    .font(.callout)
                    .foregroundStyle(Brand.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }

            HStack(spacing: 10) {
                Button("Retry Bridge") {
                    Task { await model.restart() }
                }
                .buttonStyle(RelayButtonStyle(fullWidth: false, compact: true))
                .disabled(model.restarting)

                if model.fatalCode == "port_in_use" {
                    Button("Remove old login item") {
                        Task { await system.removeOldLoginItem() }
                    }
                    .buttonStyle(DestructiveButtonStyle(fullWidth: false, compact: true))
                    .disabled(system.removingLoginItem)
                }

                Button("Open Logs") {
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "logs")
                }
                .buttonStyle(OutlineButtonStyle(fullWidth: false, compact: true))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }

    // MARK: - Helper Views

    private func agentDotColor(_ status: String?) -> Color {
        switch status {
        case "ready": Brand.success
        case "needsLogin": Brand.warning
        default: Brand.muted.opacity(0.45)
        }
    }

    @ViewBuilder
    private func taskStatusIcon(_ status: HubTaskStatus) -> some View {
        switch status {
        case .running:
            ProgressView().controlSize(.mini)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(Brand.success)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .font(.caption)
                .foregroundStyle(Brand.failure)
        case .cancelled:
            Image(systemName: "slash.circle.fill")
                .font(.caption)
                .foregroundStyle(Brand.muted)
        }
    }

    private func taskStatusBadge(_ status: HubTaskStatus) -> some View {
        let fg: Color
        let bg: Color
        switch status {
        case .running: (fg, bg) = (Brand.relayText, Brand.relaySoft)
        case .completed: (fg, bg) = (Brand.successText, Brand.successSoft)
        case .failed: (fg, bg) = (Brand.failureText, Brand.failureSoft)
        case .cancelled: (fg, bg) = (Brand.muted, Brand.separator)
        }
        return Text(LocalizedStringKey(status.label))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(bg, in: Capsule())
    }

    // MARK: - Actions & RPC Coordination

    private func ensureValidSelectedAgent() {
        let enabled = enabledAgents.map(\.0)
        if !enabled.contains(selectedAgent), let first = enabled.first {
            selectedAgent = first
        }
    }

    @MainActor
    private func bootstrapBridgeData() async {
        async let dirsResult = try? model.loadRecentProjects(limit: 30)
        async let tasksResult = try? model.syncTasks()
        async let agentTask: Void = loadAgentResources(agent: selectedAgent)

        let dirs = await dirsResult
        _ = await tasksResult
        await agentTask

        if selectedCwd.isEmpty, let first = dirs?.first {
            selectedCwd = first.path
        }
    }

    @MainActor
    private func loadAgentResources(agent: String) async {
        async let sessionsCall: Void = reloadSessions(agent: agent)
        async let modelsResult = try? model.loadModels(agent: agent)

        let models = await modelsResult
        await sessionsCall

        if let models, selectedAgent == agent {
            if let def = models.first(where: { $0.isDefault }) ?? models.first {
                selectedModelId = def.id
                syncEffortForModel(def)
            } else {
                selectedModelId = ""
                selectedEffort = ""
            }
        }
    }

    private func reloadSessions(agent: String) async {
        loadingSessions = true
        defer { loadingSessions = false }
        do {
            _ = try await model.loadSessions(agent: agent, limit: 40)
        } catch {
            if selectedAgent == agent {
                stageNotice = error.localizedDescription
            }
        }
    }

    private func reloadMessages(agent: String, sessionId: String) async {
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let fetched = try await model.loadMessages(agent: agent, sessionId: sessionId, limit: 100)
            if selectedAgent == agent, selectedSessionId == sessionId {
                messages = fetched
                stageNotice = nil
            }
        } catch {
            if selectedAgent == agent, selectedSessionId == sessionId {
                stageNotice = error.localizedDescription
            }
        }
    }

    private func selectAgent(_ kind: String, startNewSession: Bool) {
        section = .commandCenter
        model.hubInitialSection = .commandCenter
        composerError = nil
        stageNotice = nil
        if selectedAgent != kind {
            selectedAgent = kind
            selectedSessionId = nil
            selectedTaskId = nil
            messages = []
        } else if startNewSession {
            startNewSessionDraft()
        }
    }

    private func startNewSessionDraft() {
        selectedSessionId = nil
        selectedTaskId = nil
        messages = []
        composerError = nil
        stageNotice = nil
    }

    private func selectSession(_ session: HubSessionSummary) {
        if selectedSessionId != session.id {
            messages = []
        }
        selectedSessionId = session.id
        selectedTaskId = model.sortedTasks.first { $0.agent == session.agent && $0.sessionId == session.id }?.id
        composerError = nil
        stageNotice = nil
        Task {
            await reloadMessages(agent: session.agent, sessionId: session.id)
            if let taskId = selectedTaskId {
                _ = try? await model.loadTaskSnapshot(taskId: taskId)
            }
        }
    }

    private func openTask(_ task: HubTaskInfo) {
        section = .commandCenter
        model.hubInitialSection = .commandCenter
        composerError = nil
        stageNotice = nil
        selectedAgent = task.agent
        selectedTaskId = task.id
        selectedSessionId = task.sessionId
        if !task.cwd.isEmpty {
            selectedCwd = task.cwd
        }
        messages = []
        Task {
            _ = try? await model.loadTaskSnapshot(taskId: task.id)
            if let sessionId = task.sessionId {
                await reloadMessages(agent: task.agent, sessionId: sessionId)
            }
        }
    }

    private func syncEffortForModel(_ option: HubModelOption) {
        if let efforts = option.efforts, !efforts.isEmpty {
            if let def = option.defaultEffort, efforts.contains(def) {
                selectedEffort = def
            } else {
                selectedEffort = efforts[0]
            }
        } else {
            selectedEffort = ""
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Select Workspace"
        if !effectiveCwd.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: effectiveCwd)
        }
        if panel.runModal() == .OK, let url = panel.url {
            selectedCwd = url.path
        }
    }

    private func sendPrompt() async {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, canSend else { return }
        sending = true
        composerError = nil
        defer { sending = false }

        let modelParam = selectedModelId.isEmpty ? nil : selectedModelId
        let effortParam = activeEfforts.isEmpty || selectedEffort.isEmpty ? nil : selectedEffort
        let cwdParam = selectedSessionId == nil ? effectiveCwd : nil

        do {
            let task = try await model.startTask(
                agent: selectedAgent,
                sessionId: selectedSessionId,
                cwd: cwdParam,
                prompt: trimmed,
                permissionMode: permissionMode,
                model: modelParam,
                effort: effortParam
            )
            promptText = ""
            selectedTaskId = task.id
            if let sid = task.sessionId {
                selectedSessionId = sid
            }
            _ = try? await model.loadTaskSnapshot(taskId: task.id)
        } catch {
            composerError = error.localizedDescription
        }
    }

    private func stopActiveTask(_ taskId: String) async {
        cancelling = true
        defer { cancelling = false }
        do {
            _ = try await model.cancelTask(taskId: taskId)
        } catch {
            composerError = error.localizedDescription
        }
    }
}
