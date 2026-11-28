import SwiftUI

struct SessionsView: View {
    @Environment(AppModel.self) private var model
    let agent: AgentKind

    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var showNew = false
    @State private var newSession: SessionRoute?

    @State private var collapsed: [String: Bool] = [:]

    private var groups: [SessionGroup] { SessionGrouping.groups(model.sessions[agent] ?? []) }

    private var visibleGroups: [SessionGroup] {
        guard !query.isEmpty else { return groups }
        return groups.compactMap { group in
            let matches = group.sessions.filter {
                $0.title.localizedCaseInsensitiveContains(query) || $0.cwd.localizedCaseInsensitiveContains(query)
            }
            return matches.isEmpty ? nil : SessionGroup(id: group.id, path: group.path, sessions: matches)
        }
    }

    private func storageKey(_ group: SessionGroup) -> String {
        SessionGrouping.persistenceKey(deviceId: model.bridgeDeviceId ?? "", agent: agent, path: group.id)
    }

    private func isExpanded(_ group: SessionGroup) -> Bool {
        let running = groups.first(where: { $0.id == group.id })?.hasRunningSession == true
        return running || !query.isEmpty || !(collapsed[storageKey(group)] ?? !SessionGrouping.initiallyExpanded(groups).contains(group.id))
    }

    private func restoreExpansion() {
        guard model.bridgeDeviceId != nil else { return }
        let expanded = SessionGrouping.initiallyExpanded(groups)
        for group in groups {
            let key = storageKey(group)
            if let saved = UserDefaults.standard.object(forKey: key) as? Bool {
                collapsed[key] = saved
            } else {
                let value = !expanded.contains(group.id)
                collapsed[key] = value
                UserDefaults.standard.set(value, forKey: key)
            }
        }
    }

    private func groupHeader(_ group: SessionGroup) -> some View {
        let name = group.projectName()
        let expanded = isExpanded(group)
        let running = groups.first(where: { $0.id == group.id })?.hasRunningSession == true
        return HStack(spacing: 4) {
            Button {
                let key = storageKey(group)
                withAnimation(.easeInOut(duration: 0.2)) { collapsed[key] = expanded }
                if model.bridgeDeviceId != nil { UserDefaults.standard.set(expanded, forKey: key) }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "folder.fill").foregroundStyle(Brand.relayText)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink).lineLimit(1)
                        if !group.isOther {
                            Text(group.displayPath).font(.caption).foregroundStyle(Brand.muted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer(minLength: 4)
                    Text(group.sessions.count.formatted()).font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold)).foregroundStyle(Brand.relayText)
                }
                .frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(running || !query.isEmpty)
            .accessibilityLabel(name)
            .accessibilityValue(running ? "Expanded, running sessions" : (expanded ? "Expanded" : "Collapsed"))
            if !group.isOther {
                Button {
                    newSession = SessionRoute(agent: agent, sessionId: nil, title: "New session", cwd: group.path)
                } label: {
                    Image(systemName: "plus").font(.body.weight(.semibold))
                        .foregroundStyle(Brand.relayText).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New session in \(name)")
                .disabled(model.agent(agent)?.status == .unavailable)
            }
        }
    }

    var body: some View {
        List {
            if agent == .cursor {
                Section {
                    Text("Cursor chats started in AgentTote appear here. Existing editor chats aren't imported.")
                        .font(.footnote).foregroundStyle(Brand.muted)
                }.brandRows()
            }
            if let info = model.agent(agent), info.status != .ready {
                Section {
                    Label(info.detail ?? "Not available", systemImage: info.status == .needsLogin ? "person.crop.circle.badge.exclamationmark" : "xmark.circle")
                        .foregroundStyle(Brand.warning)
                        .font(.callout)
                }.brandRows()
            }
            if model.isReconnecting {
                Section {
                    Label("Reconnecting to your Mac…", systemImage: "arrow.triangle.2.circlepath")
                        .foregroundStyle(Brand.muted)
                }.brandRows()
            } else if let error {
                Section { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Brand.failure) }.brandRows()
            }
            ForEach(visibleGroups) { group in
                Section {
                    groupHeader(group)
                    if isExpanded(group) {
                        ForEach(group.sessions) { session in
                            NavigationLink(value: SessionRoute(agent: agent, sessionId: session.id, title: session.title, cwd: session.cwd)) {
                                SessionRow(session: session)
                            }
                        }
                    }
                }.brandRows()
            }
            if visibleGroups.isEmpty && !loading {
                Section {} footer: {
                    Text(query.isEmpty ? "No sessions yet. Tap + to start one." : "No matches.")
                }.brandRows()
            }
        }
        .overlay {
            if loading && (model.sessions[agent] ?? []).isEmpty { ProgressView() }
        }
        .brandList()
        .listStyle(.insetGrouped)
        .toolbar(.visible, for: .navigationBar)
        .brandNavigationTitle("\(agent.displayName)")
        .searchable(text: $query, prompt: "Search sessions")
        .refreshable { await load() }
        .task { await load() }
        .onChange(of: model.sessions[agent], initial: true) { _, _ in restoreExpansion() }
        .onChange(of: model.bridgeDeviceId) { _, _ in restoreExpansion() }
        .onChange(of: model.isConnected) { _, connected in
            if connected && !loading { Task { await load() } }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNew = true } label: {
                    Image(systemName: "square.and.pencil").font(.system(size: 20, weight: .medium))
                        .foregroundStyle(Brand.relayText).frame(minWidth: 44, minHeight: 44)
                }
                    .buttonStyle(.automatic)
                    .accessibilityLabel("New session")
                    .disabled(model.agent(agent)?.status == .unavailable)
            }
        }
        .sheet(isPresented: $showNew) {
            NewSessionSheet(agent: agent) { cwd in
                showNew = false
                newSession = SessionRoute(agent: agent, sessionId: nil, title: "New session", cwd: cwd)
            }
        }
        .navigationDestination(item: $newSession) { SessionDetailView(route: $0) }
    }

    private func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            try await model.loadSessions(agent)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct SessionRow: View {
    let session: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if session.running { RunningDot() }
                Text(session.title).font(.body.weight(.medium)).lineLimit(2)
            }
            HStack(spacing: 6) {
                Text(session.updatedDate.shortRelative)
                if session.origin == "mac" {
                    SessionTag(symbol: "desktopcomputer", title: "Mac", label: "Started on your Mac")
                }
                if session.forkedFromId != nil {
                    SessionTag(symbol: "arrow.triangle.branch", title: "Copy", label: "Copy of another conversation")
                }
            }
            .font(.caption)
            .foregroundStyle(Brand.muted)
            if let preview = session.preview, preview != session.title {
                Text(preview).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A compact tag beside a session's timestamp, e.g. where it was started.
private struct SessionTag: View {
    let symbol: String
    let title: String
    let label: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).imageScale(.small)
            Text(title)
        }
            .font(.caption2.weight(.medium))
            .foregroundStyle(Brand.muted)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Brand.line, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label)
    }
}

/// Pick the folder a new session runs in: a recent project, or a typed path.
struct NewSessionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let agent: AgentKind
    let onPick: (String) -> Void

    @State private var projects: [ProjectDir] = []
    @State private var customPath = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("/Users/you/project", text: $customPath)
                            .font(.system(.body, design: .monospaced))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Use") { onPick(customPath) }
                            .buttonStyle(RelayButtonStyle(fullWidth: false, compact: true))
                            .disabled(!customPath.hasPrefix("/"))
                    }
                } header: {
                    Text("Folder on your Mac")
                }.brandRows()
                if let error {
                    Section { Text(error).foregroundStyle(Brand.failure) }.brandRows()
                }
                Section("Recent projects") {
                    ForEach(projects) { p in
                        Button { onPick(p.path) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(p.path.lastPathComponentName).foregroundStyle(.primary)
                                HStack(spacing: 4) {
                                    Text(p.path.abbreviatedPath).lineLimit(1).truncationMode(.head)
                                    Spacer()
                                    ForEach(p.agents, id: \.self) { AgentIcon(kind: $0, size: 16) }
                                }
                                .font(.caption)
                                .foregroundStyle(Brand.muted)
                            }
                        }
                        .tint(.primary)
                    }
                }.brandRows()
            }
            .brandList()
            .toolbar(.visible, for: .navigationBar)
            .brandNavigationTitle("New \(agent.displayName) session")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task {
                do { projects = try await model.recentProjects() } catch { self.error = error.localizedDescription }
            }
        }
    }
}
