import SwiftUI

/// Where a session screen should open: an existing session, or a new one in `cwd`.
struct SessionRoute: Hashable {
    let agent: AgentKind
    let sessionId: String?
    let title: String
    let cwd: String
}

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var showAddMac = false
    @State private var showAccount = false
    @State private var showAgentRequest = false
    @ScaledMetric(relativeTo: .subheadline) private var agentCardHeight: CGFloat = 136
    @State private var newAgent: AgentKind?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                topBar
                if let message = model.account.recoveryMessage {
                    Label(message, systemImage: "wifi.slash").font(.footnote).foregroundStyle(Brand.muted)
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading).brandCard()
                }
                VStack(alignment: .leading, spacing: 0) {
                    ConnectionHeader()
                }
                if !model.availableMacs.isEmpty {
                    DisclosureGroup("Your Macs") {
                        VStack(spacing: 0) {
                            ForEach(model.availableMacs) { mac in
                                MacManagementRow(mac: mac).padding(.vertical, 8)
                                if mac.id != model.availableMacs.last?.id { Divider().overlay(Brand.separator) }
                            }
                        }
                    }
                    .font(.subheadline).padding(16).brandCard()
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        MacSetupGuide()
                        if model.account.isSignedIn {
                            Text("After you sign in on your Mac with the same account, pull to refresh.")
                                .font(.subheadline).foregroundStyle(Brand.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                if model.account.hasSession, let message = model.account.errorMessage {
                    Text(message).font(.footnote).foregroundStyle(Brand.failureText)
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Brand.failureSoft, in: RoundedRectangle(cornerRadius: 20))
                }
                HStack {
                    Text("Agents").font(Brand.title(20, relativeTo: .title3))
                    Spacer()
                    Text("\(model.enabledAgentKinds.filter { model.agent($0)?.status == .ready }.count) ready")
                        .font(.caption).foregroundStyle(Brand.muted)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: typeSize.isAccessibilitySize ? 1 : 2), spacing: 10) {
                    ForEach(model.enabledAgentKinds) { kind in
                        NavigationLink(value: kind) { AgentRow(kind: kind, info: model.agent(kind)) }
                            .buttonStyle(.plain).disabled(!model.isConnected)
                    }
                    if !typeSize.isAccessibilitySize {
                        Button { showAgentRequest = true } label: {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(systemName: "plus").font(.title2.weight(.medium)).frame(height: 40)
                                Text("Want another agent?").font(.subheadline.weight(.semibold)).multilineTextAlignment(.leading)
                            }.foregroundStyle(Brand.relayText).padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading).frame(height: agentCardHeight, alignment: .topLeading)
                                .overlay { RoundedRectangle(cornerRadius: 20).strokeBorder(Brand.relayText.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [5, 4])) }
                        }.buttonStyle(.plain)
                    }
                }
                if typeSize.isAccessibilitySize {
                    Button { showAgentRequest = true } label: { Label("Want another agent?", systemImage: "plus") }
                        .font(.subheadline.weight(.medium)).foregroundStyle(Brand.relayText).frame(minHeight: 44)
                }
                if model.isConnected && model.agentFlowSupported {
                    AgentFlowHomeCard()
                }
                WebPreviewsSection()
                if let claude = model.agent(.claude), claude.status == .needsLogin, let detail = claude.detail {
                    Label(detail, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(Brand.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(16).frame(maxWidth: .infinity, alignment: .leading).brandCard()
                }
                if !model.recentTasks.isEmpty {
                    Text("Recent tasks").font(Brand.title(20, relativeTo: .title3))
                    VStack(spacing: 0) {
                        ForEach(model.recentTasks.prefix(15)) { task in
                            NavigationLink(value: SessionRoute(agent: task.agent, sessionId: task.sessionId, title: task.prompt, cwd: task.cwd)) {
                                TaskRow(task: task).padding(16)
                            }
                            .buttonStyle(.plain).disabled(task.sessionId == nil)
                            if task.id != model.recentTasks.prefix(15).last?.id {
                                Rectangle().fill(Brand.separator).frame(height: 1).padding(.leading, 60)
                            }
                        }
                    }
                    .brandCard()
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .frame(maxWidth: 700).frame(maxWidth: .infinity)
        }
        .safeAreaPadding(.bottom, 16)
        .safeAreaInset(edge: .bottom, spacing: 0) { newTaskControl }
        .brandScreen()
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: AgentKind.self) { SessionsView(agent: $0) }
        .navigationDestination(for: SessionRoute.self) { SessionDetailView(route: $0) }
        .navigationDestination(for: AgentFlowRoute.self) { route in
            switch route {
            case .studio: AgentFlowView()
            case .run(let id): AgentFlowRunDetailView(runId: id)
            }
        }
        .refreshable {
            await model.account.restore()
            if model.isConnected {
                try? await model.refreshAgents()
                await model.syncTasks()
                await model.refreshAgentFlow()
            } else {
                await model.connect()
            }
        }
        .sheet(item: $newAgent) { agent in
            NewSessionSheet(agent: agent) { cwd in
                newAgent = nil
                model.navigationPath.append(SessionRoute(agent: agent, sessionId: nil, title: "New session", cwd: cwd))
            }
        }
        .sheet(isPresented: $showAddMac) { NavigationStack { PairingView(isOnboarding: false) } }
        .sheet(isPresented: $showAgentRequest) { FeedbackView(initialKind: .agentRequest) }
        .sheet(isPresented: $showAccount) { NavigationStack { AccountView() } }
        .onChange(of: model.notificationNavigationRevision) { _, _ in
            showAddMac = false
            showAccount = false
            newAgent = nil
        }
        .task { await model.connect() }
    }

    private var newTaskControl: some View {
        Menu {
            ForEach(model.enabledAgentKinds) { kind in
                Button { newAgent = kind } label: { Label { Text(kind.displayName) } icon: { AgentIcon(kind: kind, size: 24) } }
                    .disabled(model.agent(kind)?.status != .ready)
            }
        } label: { Label("New task", systemImage: "plus").frame(maxWidth: .infinity) }
            .buttonStyle(RelayButtonStyle())
            .disabled(!model.isConnected || !model.enabledAgentKinds.contains { model.agent($0)?.status == .ready })
            .padding(.horizontal, 20).padding(.vertical, 12)
            .background { Brand.paper.ignoresSafeArea(edges: .bottom) }
            .overlay(alignment: .top) {
                LinearGradient(colors: [Brand.paper.opacity(0), Brand.paper], startPoint: .top, endPoint: .bottom)
                    .frame(height: 12).offset(y: -12).allowsHitTesting(false)
            }
    }

    private var topBar: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { identity; Spacer(minLength: 0); controls }
            VStack(alignment: .leading, spacing: 12) { identity; HStack { Spacer(); controls } }
        }
    }
    private var identity: some View {
        HStack(spacing: 10) { BrandMark(size: 30); BrandWordmark(size: 19) }
    }
    private var controls: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(model.availableMacs) { mac in
                    Button { model.select(mac) } label: {
                        let title = mac.online.map { mac.name + ($0 ? " · Online" : " · Offline") } ?? mac.name
                        if mac.id == model.selectedMacId { Label(title, systemImage: "checkmark") } else { Text(title) }
                    }
                }
                Divider()
                Button { showAddMac = true } label: { Label("Add Mac…", systemImage: "plus") }

            } label: { Image(systemName: "laptopcomputer") }
                .buttonStyle(CircleIconButtonStyle()).accessibilityLabel("Switch Mac")
            Button { showAccount = true } label: { Image(systemName: "person.crop.circle.fill") }
                .buttonStyle(CircleIconButtonStyle(filled: true, stopping: true)).accessibilityLabel("Account")
        }
    }
}

private struct ConnectionHeader: View {
    @State private var showLogin = false
    @Environment(AppModel.self) private var model
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your Mac").font(.caption).foregroundStyle(Color(hex: 0xB9BBC6))
                    (model.selectedMac.map { Text(verbatim: $0.name) } ?? Text("No Mac")).font(Brand.title(24, relativeTo: .title2)).foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "laptopcomputer").font(.system(size: 36)).foregroundStyle(.white).accessibilityHidden(true)
            }
            status
        }
        .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        .background(Brand.logoInk, in: RoundedRectangle(cornerRadius: 24))
        .sheet(isPresented: $showLogin) { NavigationStack { LoginView() } }
    }
    @ViewBuilder private var status: some View {
        if model.isReconnecting {
            HStack { ProgressView().tint(.white); capsule("Reconnecting…", foreground: .white, background: .white.opacity(0.1)) }
        } else {
            switch model.connection {
            case .idle:
                capsule("Not connected", foreground: Color(hex: 0xE4E5EA), background: .white.opacity(0.1))
            case .connecting:
                HStack { ProgressView().tint(.white); capsule("Connecting…", foreground: .white, background: .white.opacity(0.1)) }
            case .connected(let host, let viaRelay):
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { connected; transport(host, viaRelay: viaRelay) }
                    VStack(alignment: .leading, spacing: 8) { connected; transport(host, viaRelay: viaRelay) }
                }
            case .failed(let message):
                VStack(alignment: .leading, spacing: 8) {
                    capsule("Connection failed", foreground: Color(hex: 0xFF9C8C), background: Color(hex: 0x39201E))
                    Text(message).font(.caption).foregroundStyle(Color(hex: 0xFF9C8C)).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        Button("Retry") { Task { await model.connect() } }
                        if model.connectionFailureNeedsSignIn { Button("Sign in") { showLogin = true } }
                    }
                    .buttonStyle(TintedButtonStyle(fullWidth: false, compact: true))
                }
            }
        }
    }
    private var connected: some View { capsule("● Connected", foreground: Color(hex: 0x7EE2A6), background: Color(hex: 0x1F8A4C).opacity(0.25)) }
    private func transport(_ host: String, viaRelay: Bool) -> some View {
        capsule(viaRelay ? "via relay" : "\(host)", foreground: Color(hex: 0xE4E5EA), background: .white.opacity(0.1))
    }
    private func capsule(_ text: LocalizedStringKey, foreground: Color, background: Color) -> some View {
        Text(text).font(.caption.weight(.medium)).foregroundStyle(foreground)
            .padding(.horizontal, 12).padding(.vertical, 8).background(background, in: Capsule())
    }
}

private struct AgentRow: View {
    let kind: AgentKind
    let info: AgentInfo?
    @ScaledMetric(relativeTo: .subheadline) private var cardHeight: CGFloat = 136
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            AgentIcon(kind: kind, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(kind == .claude ? "Claude" : kind.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(subtitle).font(.caption2).foregroundStyle(info?.status == .ready ? Brand.successText : info?.status == .needsLogin ? Brand.warning : Brand.muted)
                    .lineLimit(1)
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: cardHeight, alignment: .topLeading).brandCard()
    }
    private var subtitle: LocalizedStringKey {
        guard let info else { return "Waiting for Mac…" }
        switch info.status {
        case .ready: return "Ready · \(info.runningProcesses) open"
        case .needsLogin: return kind == .claude ? "Needs sign-in" : "Connect on Mac"
        case .unavailable: return "Not installed"
        }
    }
}

private struct TaskRow: View {
    let task: TaskInfo
    var body: some View {
        HStack(spacing: 12) {
            AgentIcon(kind: task.agent, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.prompt).font(.subheadline.weight(.medium)).lineLimit(2)
                Text(task.startedDate.shortRelative).font(.caption).foregroundStyle(Brand.muted)
            }
            Spacer(minLength: 0)
            TaskStatusBadge(status: task.status)
            if task.status == .running, task.watching == true {
                Image(systemName: "bell.fill").font(.caption).foregroundStyle(Brand.relayText)
                    .accessibilityLabel("Notification enabled")
            }
        }
        .frame(minHeight: 44)
    }
}
