import SwiftUI

/// A session's conversation, the live activity of tasks sent from the phone, and the composer.
struct SessionDetailView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    @Environment(\.locale) private var locale
    let route: SessionRoute

    @State private var sessionId: String?
    @State private var history: [ChatMessage] = []
    @State private var loadingHistory = false
    @State private var historyError: String?
    /// Tasks shown below the history: started here, or already running when the screen opened.
    @State private var liveTaskIds: [String] = []
    @State private var draft = ""
    @State private var attachments: [TaskAttachment] = []
    @State private var importingAttachments = false
    @State private var uploadProgress = 0.0
    @State private var followsBottom = true
    @State private var scrollTracking = ConversationScrollTracking()
    @State private var viewportHeight: CGFloat = 0
    @State private var didScrollToHistory = false
    @State private var sending = false
    @State private var sendError: String?
    @State private var notificationMessage: String?
    @State private var showNotificationMessage = false
    @State private var updatingWatch = false
    @State private var visibilityOwner = UUID()
    @State private var showFiles = false
    @State private var webPreview: WebPreviewDestination?
    @State private var localFile: FilePreviewDestination?
    @State private var showModelPicker = false
    @State private var modelNotice: String?
    @State private var modelListError: String?
    /// This page already started a task, so the "started on your Mac" tip is moot.
    @State private var startedHere = false
    @State private var macCardDismissed = false
    /// Set from the Mac strip: the next message forks the conversation instead of replying in it.
    @State private var continueInCopy = false
    @State private var copyNotice: String?
    @State private var showBusyDialog = false
    @State private var busyPrompt = ""
    @State private var busySessionId: String?
    @State private var busyFork = false
    @AppStorage("permissionMode") private var mode: PermissionMode = .acceptEdits
    @FocusState private var composerFocused: Bool

    init(route: SessionRoute) {
        self.route = route
        _sessionId = State(initialValue: route.sessionId)
        _macCardDismissed = State(initialValue: route.sessionId.map { Self.macCardKey($0) }
            .map { UserDefaults.standard.bool(forKey: $0) } ?? false)
    }

    private static func macCardKey(_ sessionId: String) -> String { "macSessionCardDismissed.\(sessionId)" }

    private var fileCwd: String {
        if !route.cwd.isEmpty { return route.cwd }
        return model.sessions[route.agent]?.first(where: { $0.id == sessionId })?.cwd ?? liveTasks.first(where: { !$0.cwd.isEmpty })?.cwd ?? ""
    }

    private var liveTasks: [TaskInfo] { liveTaskIds.compactMap { model.tasks[$0] } }
    private var currentSession: SessionSummary? {
        guard let sessionId else { return nil }
        return model.sessions[route.agent]?.first { $0.id == sessionId }
    }
    private var showMacSessionCard: Bool {
        !macCardDismissed && !startedHere && currentSession?.origin == "mac"
    }
    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var runningTask: TaskInfo? {
        liveTasks.last { $0.status == .running } ?? model.tasks(agent: route.agent, sessionId: sessionId).last { $0.status == .running }
    }
    private var workBuddyNeedsConnection: Bool {
        route.agent == .workbuddy && model.agent(.workbuddy)?.status == .needsLogin
    }

    private var modelOptions: [ModelOption] {
        guard let deviceId = model.bridgeDeviceId else { return [] }
        return model.modelSelections.models(deviceId: deviceId, agent: route.agent)
    }

    private var modelSelection: ModelSelection {
        guard let deviceId = model.bridgeDeviceId else { return ModelSelection() }
        return model.modelSelections.selection(deviceId: deviceId, agent: route.agent)
    }

    private var selectionBinding: Binding<ModelSelection> {
        Binding(get: { modelSelection }, set: { selection in
            guard let deviceId = model.bridgeDeviceId else { return }
            model.modelSelections.save(selection, deviceId: deviceId, agent: route.agent)
        })
    }

    private func modelLabel(_ task: TaskInfo) -> String? {
        ModelSelection.taskLabel(model: task.model, effort: task.effort, models: modelOptions)
    }

    /// Completed turns move into transcript history. Match from newest to oldest
    /// so repeated prompts retain the model belonging to each individual task.
    private var historyTasks: [String: TaskInfo] {
        var candidates = model.tasks(agent: route.agent, sessionId: sessionId).filter { !liveTaskIds.contains($0.id) }
        var matched: [String: TaskInfo] = [:]
        for message in history.reversed() where message.role == .user {
            if let index = candidates.lastIndex(where: { $0.prompt == message.text }) {
                matched[message.id] = candidates.remove(at: index)
            }
        }
        return matched
    }

    var body: some View {
        let recordedTasks = historyTasks
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if loadingHistory && history.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding()
                    }
                    if model.isReconnecting {
                        Label("Reconnecting to your Mac…", systemImage: "arrow.triangle.2.circlepath")
                            .font(.caption).foregroundStyle(Brand.muted)
                    } else if let historyError {
                        Label(historyError, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(Brand.failure)
                    }
                    ForEach(history) { m in
                        VStack(alignment: .leading, spacing: 4) {
                            MessageBubble(role: m.role, text: m.text)
                            if let task = recordedTasks[m.id] {
                                ChangedFilesView(task: task, cwd: fileCwd, events: model.events[task.id] ?? [])
                                    .task(id: task.id) { await model.loadTaskEvents(task.id) }
                            }
                            if let task = recordedTasks[m.id], let label = modelLabel(task) {
                                Text(label).font(.caption2).foregroundStyle(Brand.muted).padding(.leading, 4)
                            }
                        }
                    }
                    if !history.isEmpty, liveTasks.isEmpty,
                       let lastTask = model.tasks(agent: route.agent, sessionId: sessionId).last,
                       lastTask.status != .running {
                        TaskStatusBadge(status: lastTask.status)
                            .accessibilityLabel("Last task from this phone: \(lastTask.status.rawValue)")
                    }
                    ForEach(liveTasks) { task in
                        LiveTaskView(task: task, cwd: fileCwd, events: model.events[task.id] ?? [], modelLabel: modelLabel(task), onDraftChange: {
                            followBottom(proxy)
                        }).equatable()
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal)
                .padding(.top, 8)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ConversationBottomKey.self,
                        value: geometry.frame(in: .named("conversation")))
                })
            }
            .coordinateSpace(name: "conversation")
            .background(GeometryReader { geometry in
                Color.clear.onAppear { viewportHeight = geometry.size.height }
                    .onChange(of: geometry.size.height) { _, height in viewportHeight = height }
            })
            .onPreferenceChange(ConversationBottomKey.self) { frame in
                let previous = scrollTracking.frame
                scrollTracking.frame = frame
                // Text reflow changes the height, not the user's scroll position.
                let reflow = previous.map { $0.minY == frame.minY && $0.height != frame.height } ?? false
                if !scrollTracking.following && !reflow {
                    followsBottom = frame.maxY <= viewportHeight + 100
                }
            }
            .simultaneousGesture(DragGesture().onChanged { _ in
                scrollTracking.dragging = true
                scrollTracking.following = false
                followsBottom = (scrollTracking.frame?.maxY ?? 0) <= viewportHeight + 100
            }.onEnded { _ in scrollTracking.dragging = false })
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: scrollSignature) { _, _ in
                followBottom(proxy)
            }
            .onChange(of: history.count) { _, _ in
                if !didScrollToHistory {
                    proxy.scrollTo("bottom", anchor: .bottom)
                    didScrollToHistory = true
                } else { followBottom(proxy) }
            }
        }
        .brandScreen()
        .safeAreaInset(edge: .top) { header }
        .safeAreaInset(edge: .bottom) { composer }
        .toolbar(.hidden, for: .navigationBar)
        .navigationTitle(sessionId == nil ? "New session" : route.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await initialLoad() }
        .task(id: "\(model.bridgeDeviceId ?? ""):\(model.isConnected)") { await refreshModelOptions() }
        .task(id: modelNotice) {
            guard modelNotice != nil else { return }
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            modelNotice = nil
        }
        .environment(\.markdownImageLocation, MarkdownImageLocation(
            client: try? model.contentClient(), agent: route.agent, root: fileCwd, directory: fileCwd
        ))
        .environment(\.openURL, OpenURLAction { url in
            if let path = LocalFileLink.resolve(url: url, cwd: fileCwd) {
                localFile = FilePreviewDestination(path: path)
                return .handled
            }
            guard ["localhost", "127.0.0.1"].contains(url.host ?? ""), let port = url.port, url.scheme == "http" else { return .systemAction }
            webPreview = WebPreviewDestination(target: WebPreviewTarget(port: port, process: "Task", pid: 0, url: url.absoluteString, source: "task"), path: url.path.isEmpty ? "/" + (url.query.map { "?" + $0 } ?? "") : url.path + (url.query.map { "?" + $0 } ?? ""))
            return .handled
        })
        .fullScreenCover(item: $webPreview) { WebPreviewView(destination: $0) }
        .sheet(item: $localFile) { file in
            LocalFilePreviewView(agent: route.agent, cwd: fileCwd, path: file.path)
        }
        .sheet(isPresented: $showFiles) { FilesView(agent: route.agent, cwd: fileCwd, sessionId: sessionId) }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(models: modelOptions, selection: selectionBinding, error: modelListError) {
                await refreshModelOptions()
            }
        }
        .onChange(of: model.isConnected) { _, connected in
            if connected && !loadingHistory { Task { await loadHistory() } }
        }
        .onAppear { updateVisibleSession() }
        .onChange(of: sessionId) { _, _ in updateVisibleSession() }
        .onChange(of: runningTask?.id) { _, _ in updateVisibleSession() }
        .onChange(of: model.bridgeDeviceId) { _, _ in
            showModelPicker = false
            modelNotice = nil
            modelListError = nil
            updateVisibleSession()
        }
        .onChange(of: liveTasks.compactMap(\.sessionId)) { _, ids in
            if sessionId == nil { sessionId = ids.first }
            updateVisibleSession()
        }
        .onDisappear { model.notifications.clearVisibleSession(owner: visibilityOwner) }
        .alert("Notifications", isPresented: $showNotificationMessage) {
            if model.notifications.authorization == .denied {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            Button("OK", role: .cancel) { }
        } message: { Text(notificationMessage ?? "") }
        .confirmationDialog("This conversation is open on your Mac", isPresented: $showBusyDialog, titleVisibility: .visible) {
            Button("Continue in a copy") {
                Task { await start(prompt: busyPrompt, sessionId: busySessionId, fork: true) }
            }
            Button("Try again") {
                Task { await start(prompt: busyPrompt, sessionId: busySessionId, fork: busyFork) }
            }
            Button("Cancel", role: .cancel) { draft = busyPrompt }
        } message: {
            Text("Codex only lets one app write to a conversation at a time. Continue in a copy to keep going from your phone, or close the conversation in the Codex app on your Mac and try again.")
        }
        .refreshable { await loadHistory() }
        .onChange(of: liveStatuses) { old, new in
            Task { await liveTasksChanged(old: old, new: new) }
        }
    }

    private func followBottom(_ proxy: ScrollViewProxy) {
        guard followsBottom, !scrollTracking.dragging else { return }
        if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) }
        else {
            scrollTracking.following = true
            scrollTracking.generation += 1
            let generation = scrollTracking.generation
            withAnimation(.easeOut(duration: 0.1), completionCriteria: .logicallyComplete) {
                proxy.scrollTo("bottom", anchor: .bottom)
            } completion: {
                if scrollTracking.generation == generation { scrollTracking.following = false }
            }
        }
    }

    // MARK: - Pieces

    private var header: some View {
        HStack(spacing: 12) {
            Button { dismiss() } label: { Image(systemName: "chevron.left") }
                .buttonStyle(CircleIconButtonStyle()).accessibilityLabel("Back")
            VStack(alignment: .leading, spacing: 3) {
                Text(sessionId == nil ? "New session" : route.title)
                    .font(Brand.title(18, relativeTo: .headline)).lineLimit(2)
                HStack(spacing: 6) {
                    AgentIcon(kind: route.agent, size: 16)
                    Text(route.agent.displayName).font(.caption)
                    Text("·")
                    Text(route.cwd.abbreviatedPath).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                }
                .foregroundStyle(Brand.muted)
            }
            Spacer(minLength: 0)
            if !fileCwd.isEmpty {
                Button { showFiles = true } label: { Image(systemName: "folder") }
                    .buttonStyle(CircleIconButtonStyle()).accessibilityLabel("Files")
            }
            if let task = runningTask {
                Button { Task { await toggleWatch(task) } } label: {
                    Image(systemName: task.watching == true ? "bell.fill" : "bell")
                        .foregroundStyle(task.watching == true ? Brand.relayText : Brand.ink)
                }
                .buttonStyle(CircleIconButtonStyle())
                .disabled(updatingWatch)
                .accessibilityLabel(task.watching == true ? "Stop notifying" : "Notify me when this task finishes")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10).background(Brand.paper)
    }

    /// Shown above the composer so it is visible when the conversation opens scrolled to the end.
    private var macSessionStrip: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "desktopcomputer").font(.subheadline).foregroundStyle(Brand.relayText)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(continueInCopy ? "Your next message starts a copy of this conversation." : "Started on your Mac")
                    .font(.caption.weight(.semibold)).foregroundStyle(Brand.ink)
                if !continueInCopy {
                    Text("If it's still open in the Codex app on your Mac, replies from here can't be added to it. A copy keeps the full history and also shows up on your Mac.")
                        .font(.caption2).foregroundStyle(Brand.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button(continueInCopy ? "Reply in this conversation instead" : "Continue in a copy") {
                    continueInCopy.toggle()
                    if continueInCopy { composerFocused = true }
                }
                .font(.caption.weight(.semibold)).foregroundStyle(Brand.relayText)
                .buttonStyle(.plain)
                .disabled(sending)
            }
            Spacer(minLength: 0)
            if !continueInCopy {
                Button { dismissMacCard() } label: {
                    Image(systemName: "xmark").font(.caption2.weight(.semibold)).foregroundStyle(Brand.muted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
        }
        .padding(12)
        .background(Brand.paper, in: RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .contain)
    }

    private func dismissMacCard() {
        macCardDismissed = true
        if let sessionId { UserDefaults.standard.set(true, forKey: Self.macCardKey(sessionId)) }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showMacSessionCard || continueInCopy { macSessionStrip }
            if workBuddyNeedsConnection {
                Text("Connect WorkBuddy in the AgentTote app on your Mac to send tasks.")
                    .font(.caption).foregroundStyle(Brand.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let sendError { Text(LocalizedStringKey(sendError)).font(.caption).foregroundStyle(Brand.failure) }
            if let copyNotice {
                Text(copyNotice).font(.caption).foregroundStyle(Brand.muted)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let modelNotice {
                Text(modelNotice).font(.caption).foregroundStyle(Brand.muted)
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let modelListError, modelOptions.isEmpty, route.agent != .claude {
                Button { Task { await refreshModelOptions() } } label: {
                    Label(modelListError, systemImage: "arrow.clockwise").font(.caption).foregroundStyle(Brand.muted)
                }
            }
            GeometryReader { geometry in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        permissions.fixedSize(horizontal: true, vertical: false)
                        modelChip(maxWidth: geometry.size.width * 0.6)
                    }
                }
            }
            .frame(height: 44)
            if !attachments.isEmpty { attachmentStrip }
            if importingAttachments {
                ProgressView("Loading attachments…").font(.caption)
            } else if sending, !attachments.isEmpty {
                ProgressView(value: uploadProgress) { Text("Sending attachments…").font(.caption) }
            }
            HStack(alignment: .bottom, spacing: 8) {
                AttachmentPickerButton(attachments: $attachments, importing: $importingAttachments,
                                       errorMessage: $sendError, supported: model.supportsAttachments)
                    .disabled(sending || !model.isConnected || workBuddyNeedsConnection)
                TextField(continueInCopy ? "Message a copy of this conversation…" : "Tell \(route.agent.displayName) what to do…", text: $draft, axis: .vertical)
                    .disabled(workBuddyNeedsConnection || sending)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .frame(minHeight: 48)
                    .background(Brand.paper, in: RoundedRectangle(cornerRadius: 24))
                    .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(composerFocused ? Brand.relay : Brand.line, lineWidth: 1.5))
                if let running = runningTask {
                    Button { Task { try? await model.cancelTask(running.id) } } label: {
                        RoundedRectangle(cornerRadius: 4).fill(.white).frame(width: 16, height: 16)
                    }
                    .buttonStyle(CircleIconButtonStyle(filled: true, stopping: true))
                    .accessibilityLabel("Stop task")
                } else {
                    Button { Task { await send() } } label: {
                        if sending { ProgressView().tint(.white) }
                        else { Image(systemName: "arrow.up") }
                    }
                    .buttonStyle(CircleIconButtonStyle(filled: true))
                    .disabled(!canSend).accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Brand.surface)
        .overlay(alignment: .top) { Rectangle().fill(Brand.line).frame(height: 1) }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { file in
                    HStack(spacing: 6) {
                        Image(systemName: "paperclip")
                        Text(verbatim: file.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 160)
                        Button { attachments.removeAll { $0.id == file.id } } label: {
                            Image(systemName: "xmark.circle.fill").frame(minWidth: 28, minHeight: 32)
                        }
                        .disabled(sending || importingAttachments)
                        .accessibilityLabel(Text("Remove \(file.name)"))
                    }
                    .font(.caption).padding(.leading, 10).padding(.trailing, 4)
                    .background(Brand.paper, in: Capsule())
                }
            }
        }
    }

    private var permissions: some View {
        Menu {
            Picker("Permissions", selection: $mode) {
                ForEach(PermissionMode.allCases) { m in
                    Label { Text(LocalizedStringKey(m.label)); Text(LocalizedStringKey(m.explanation)) } icon: { Image(systemName: m.symbol) }.tag(m)
                }
            }
        } label: {
            Label(mode.label, systemImage: mode.symbol).font(.caption.weight(.semibold)).lineLimit(1)
                .foregroundStyle(mode == .full ? Brand.warningText : Brand.relayText)
        }
            .buttonStyle(TintedCapsuleButtonStyle())
            .accessibilityLabel("Permission mode: \(mode.label)")
    }

    @ViewBuilder private func modelChip(maxWidth: CGFloat) -> some View {
        if !modelOptions.isEmpty {
            Button { showModelPicker = true } label: {
                Label(modelSelection.capsuleTitle(models: modelOptions), systemImage: "cpu")
                    .font(.caption.weight(.semibold)).foregroundStyle(Brand.relayText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: max(0, maxWidth - 24))
            }
            .buttonStyle(TintedCapsuleButtonStyle())
            .accessibilityLabel(modelSelection.accessibilityLabel(models: modelOptions))
        }
    }

    private var canSend: Bool {
        !sending && !importingAttachments && !workBuddyNeedsConnection && model.isConnected
            && (!trimmedDraft.isEmpty || !attachments.isEmpty)
            && (attachments.isEmpty || model.supportsAttachments)
            && model.agent(route.agent)?.status != .unavailable
    }

    private var liveStatuses: [TaskStatus?] { liveTaskIds.map { model.tasks[$0]?.status } }

    private var scrollSignature: Int {
        liveTaskIds.reduce(0) { $0 + (model.events[$1]?.count ?? 0) } + liveTaskIds.count
    }

    // MARK: - Actions

    private func refreshModelOptions() async {
        guard model.isConnected else { return }
        let deviceId = model.bridgeDeviceId
        do {
            let didReset = try await model.refreshModels(route.agent)
            modelListError = nil
            if didReset { modelNotice = "Your saved model is no longer available. Switched to Default." }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, model.bridgeDeviceId == deviceId else { return }
            modelListError = "Couldn't refresh models. Tap to retry."
        }
    }

    private func updateVisibleSession() {
        guard let deviceId = model.bridgeDeviceId else { return }
        model.notifications.setVisibleSession(PushDestination(deviceId: deviceId,
            taskId: runningTask?.id ?? liveTasks.last?.id ?? "", agent: route.agent.rawValue, sessionId: sessionId), owner: visibilityOwner)
    }

    private func toggleWatch(_ task: TaskInfo) async {
        guard !updatingWatch else { return }
        updatingWatch = true
        defer { updatingWatch = false }
        _ = await model.notifications.requestWhenNeeded()
        _ = await model.registerPush()
        if let reason = model.notificationUnavailableMessage {
            notificationMessage = reason
            showNotificationMessage = true
            return
        }
        do { try await model.setTaskWatch(task.id, watch: task.watching != true) }
        catch {
            notificationMessage = model.notificationUnavailableMessage ?? "Couldn't update notifications. Try again in a moment."
            showNotificationMessage = true
        }
    }

    private func initialLoad() async {
        await model.syncTasks()
        if route.cwd.isEmpty { _ = try? await model.loadSessions(route.agent) }
        for t in model.tasks(agent: route.agent, sessionId: sessionId) where t.status == .running && !liveTaskIds.contains(t.id) {
            liveTaskIds.append(t.id)
        }
        await loadHistory()
    }

    private func loadHistory() async {
        guard let sessionId else { return }
        loadingHistory = true
        historyError = nil
        defer { loadingHistory = false }
        do {
            history = try await model.messages(agent: route.agent, sessionId: sessionId)
            historyError = nil
        } catch {
            historyError = error.localizedDescription
        }
    }

    private func send() async {
        guard canSend else { return }
        let prompt = trimmedDraft.isEmpty ? String(localized: "Please review the attached files.", locale: locale) : trimmedDraft
        await start(prompt: prompt, sessionId: sessionId, fork: continueInCopy)
    }

    private func showBusy(prompt: String, sessionId: String?, fork: Bool) {
        busyPrompt = prompt
        busySessionId = sessionId
        busyFork = fork
        draft = prompt
        showBusyDialog = true
    }

    private func start(prompt: String, sessionId targetSessionId: String?, fork: Bool) async {
        guard !sending else { return }
        sending = true
        uploadProgress = 0
        sendError = nil
        defer { sending = false }
        do {
            let task = try await model.startTask(agent: route.agent, sessionId: targetSessionId,
                cwd: targetSessionId == nil ? route.cwd : nil, prompt: prompt, mode: mode, fork: fork,
                attachments: attachments, uploadProgress: { uploadProgress = $0 })
            // The bridge reports a busy session as a task that failed at once, not as an RPC error.
            if task.status == .failed, let error = task.error, error.hasPrefix("SESSION_BUSY:") {
                showBusy(prompt: prompt, sessionId: targetSessionId, fork: fork)
                return
            }
            startedHere = true
            liveTaskIds.append(task.id)
            if task.status != .failed || attachments.isEmpty {
                draft = ""
                attachments = []
            }
            if fork {
                continueInCopy = false
                if let newId = task.sessionId, newId != sessionId {
                    sessionId = newId
                    history = []
                    didScrollToHistory = false
                    await loadHistory()
                    copyNotice = "Continuing in a copy of the conversation."
                }
            }
            if task.status == .failed { sendError = task.error }
        } catch {
            let message = error.localizedDescription
            if message.hasPrefix("SESSION_BUSY:") {
                showBusy(prompt: prompt, sessionId: targetSessionId, fork: fork)
            } else {
                sendError = message
            }
        }
    }

    /// When a task finishes, its turn is in the agent's transcript; reload and drop the live copy.
    private func liveTasksChanged(old: [TaskStatus?], new: [TaskStatus?]) async {
        if sessionId == nil, let sid = liveTasks.compactMap(\.sessionId).first { sessionId = sid }
        let finishedOK = liveTasks.filter { $0.status == .completed }.map(\.id)
        guard !finishedOK.isEmpty else { return }
        await loadHistory()
        if historyError == nil { liveTaskIds.removeAll { finishedOK.contains($0) } }
    }
}

/// The prompt, streamed activity and outcome of one task.
private struct LiveTaskView: View, Equatable {
    let task: TaskInfo
    let cwd: String
    let events: [TaskEvent]
    let modelLabel: String?
    let onDraftChange: () -> Void

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.task == rhs.task && lhs.cwd == rhs.cwd && lhs.events == rhs.events && lhs.modelLabel == rhs.modelLabel }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            MessageBubble(role: .user, text: task.prompt)
            if let modelLabel {
                Text(modelLabel).font(.caption2).foregroundStyle(Brand.muted).padding(.leading, 4)
            }
            ForEach(visibleEvents) { e in
                switch e.kind {
                case "tool":
                    ActivityRow(symbol: "wrench.and.screwdriver", title: e.name ?? "Tool", detail: e.detail)
                case "status":
                    ActivityRow(symbol: "info.circle", title: e.text ?? "", detail: nil)
                case "text":
                    MessageBubble(role: .assistant, text: e.text ?? "")
                case "result" where e.isError == true:
                    Label(e.text ?? "Failed", systemImage: "xmark.octagon.fill")
                        .font(.callout)
                        .foregroundStyle(Brand.failure)
                        .padding(10)
                        .background(Brand.failureSoft, in: RoundedRectangle(cornerRadius: 12))
                default:
                    EmptyView()
                }
            }
            TaskDraftBubble(taskId: task.id, onChange: onDraftChange)
            footer
            ChangedFilesView(task: task, cwd: cwd, events: events)
        }
    }

    /// The success `result` repeats the last text block, so it is not shown twice.
    private var visibleEvents: [TaskEvent] {
        events.filter { $0.kind != "session" && !($0.kind == "result" && $0.isError != true) }
    }

    @ViewBuilder private var footer: some View {
        switch task.status {
        case .running:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Working on your Mac…").font(.caption).foregroundStyle(Brand.muted)
                Text(task.startedDate, style: .timer).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
            }
            .padding(.leading, 4)
        case .failed:
            TaskStatusBadge(status: .failed)
            if let error = task.error, !events.contains(where: { $0.kind == "result" }) {
                Label(error, systemImage: "xmark.octagon.fill").font(.callout).foregroundStyle(Brand.failure)
            }
        case .cancelled:
            TaskStatusBadge(status: .cancelled)
        case .completed:
            TaskStatusBadge(status: .completed)
        }
    }
}


// Geometry bookkeeping must not invalidate the conversation on every text reflow.
private final class ConversationScrollTracking {
    var frame: CGRect?
    var following = false
    var dragging = false
    var generation = 0
}

private struct ConversationBottomKey: PreferenceKey {
    static let defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

/// Only this view observes streaming text; the event list stays unchanged at 20 Hz.
private struct TaskDraftBubble: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let taskId: String
    let onChange: () -> Void

    var body: some View {
        let draft = model.draftStore.drafts[taskId]
        Group {
            if let draft {
                if reduceMotion {
                    MessageBubble(role: .assistant, text: draft.text, cursorVisible: true)
                } else {
                    TimelineView(.periodic(from: .now, by: 0.6)) { context in
                        let visible = Int(context.date.timeIntervalSince1970 / 0.6).isMultiple(of: 2)
                        MessageBubble(role: .assistant, text: draft.text, cursorVisible: visible)
                    }
                }
            }
        }
        .onChange(of: draft) { _, _ in onChange() }
    }
}
