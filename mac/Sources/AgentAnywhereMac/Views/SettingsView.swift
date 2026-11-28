import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @Environment(BridgeModel.self) private var model
    @Environment(SystemActions.self) private var system
    @Environment(Updater.self) private var updater
    @Environment(\.openWindow) private var openWindow
    @State private var disconnecting = false
    @State private var name = ""
    @State private var port = ""
    @State private var keepAwake = KeepAwakeMode.onPower
    @State private var changingAgent = false
    @State private var saving = false
    @State private var restartRequired = false
    @State private var error: String?
    @State private var saved = false
    @State private var pendingPort: Int?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                InterfaceLanguagePicker()
                    .pickerStyle(.segmented)
                BrandFormSection("Updates") {
                    UpdateBanner()
                    if updater.enabled {
                        Button("Check for Updates…") { Task { await updater.check() } }
                            .disabled(updater.checking || updater.installing)
                    } else {
                        Text("Automatic updates are not enabled").font(.caption).foregroundStyle(Brand.muted)
                    }
                }
                BrandFormSection("Bridge") {
                    Text("Mac name").font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
                    TextField("Mac name", text: $name)
                    Text("Port").font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
                    TextField("Port", text: $port).monospaced()
                    Picker("Keep Mac awake", selection: $keepAwake) {
                        ForEach(KeepAwakeMode.allCases) { mode in Text(LocalizedStringKey(mode.label)).tag(mode) }
                    }
                    Text("Closing the lid still puts the Mac to sleep unless an external display is connected. A sleeping Mac can't be reached from your phone.")
                        .font(.caption).foregroundStyle(Brand.muted)
                    Button("Save") { Task { await save() } }.disabled(saving || !model.isRunning || restartRequired)
                    if saved && !restartRequired { Text("Saved.").foregroundStyle(Brand.muted) }
                    if restartRequired {
                        Text("Restart the bridge to use port \(pendingPort ?? model.port).").foregroundStyle(Brand.muted)
                        Button("Restart bridge") { Task { await model.restart() } }.disabled(model.restarting)
                    }
                    if let error { Text(error).foregroundStyle(Brand.failure) }
                }.disabled(saving)
                BrandFormSection("Agents") {
                    ForEach(Brand.agents, id: \.0) { kind, name in
                        let enabled = !model.disabledAgents.contains(kind)
                        Toggle(isOn: Binding(get: { !model.disabledAgents.contains(kind) }, set: { value in
                            Task { await setAgent(kind, enabled: value) }
                        })) {
                            Label {
                                Text(model.agents.first(where: { $0.kind == kind })?.name ?? name)
                            } icon: {
                                AgentIcon(kind: kind, iconPath: model.agents.first(where: { $0.kind == kind })?.iconPath)
                            }
                        }
                        .disabled(!model.isRunning || changingAgent || (enabled && model.disabledAgents.count == 2))
                    }
                    if model.disabledAgents.count == 2 {
                        Text("At least one agent must stay on.").font(.caption).foregroundStyle(Brand.muted)
                    }
                }
                BrandFormSection("Login") {
                    Toggle("Launch at login", isOn: Binding(get: { system.loginEnabled }, set: { system.setLoginEnabled($0) }))
                        .frame(minHeight: 44)
                        .disabled(!system.isAppBundle)
                    if !system.isAppBundle {
                        Text("Launch at login is available when running inside an .app bundle.").font(.caption).foregroundStyle(Brand.muted)
                    }
                    if system.loginNeedsApproval {
                        Text("Approve AgentTote in System Settings → General → Login Items.").font(.caption)
                        Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }
                    }
                    Button("Remove old login item") { Task { await system.removeOldLoginItem() } }
                        .disabled(system.removingLoginItem)
                    if let error = system.error { Text(error).foregroundStyle(Brand.failure) }
                    if let notice = system.notice { Text(notice).foregroundStyle(Brand.muted) }
                }
                BrandFormSection("WorkBuddy") {
                    if let agent = model.agents.first(where: { $0.kind == "workbuddy" }), agent.status == "ready" || agent.status == "needsLogin" {
                        if agent.status == "needsLogin" {
                            Button("Connect WorkBuddy…") {
                                NSApp.activate(ignoringOtherApps: true)
                                openWindow(id: "connect-workbuddy")
                            }
                        }
                        Button("Disconnect WorkBuddy") {
                            Task {
                                disconnecting = true
                                defer { disconnecting = false }
                                do { try await model.disconnectWorkBuddy() }
                                catch { self.error = error.localizedDescription }
                            }
                        }.disabled(!model.isRunning || disconnecting)
                    }
                }
                if !model.version.isEmpty { Text("AgentTote v\(model.version)").font(.caption).foregroundStyle(Brand.muted) }
            }
            .padding(16)
        }
        .textFieldStyle(BrandTextFieldStyle())
        .buttonStyle(TintedButtonStyle(fullWidth: false, compact: true))
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top) {
            HStack(spacing: 10) { BrandMark(size: 28); BrandWordmark(size: 20); Spacer() }.padding(.horizontal, 24).padding(.top, 16)
        }
        .brandScreen()
        .padding(8).frame(width: 460, height: 520)
        .onAppear {
            name = model.name
            keepAwake = model.keepAwake
            port = String(pendingPort ?? model.port)
            system.refreshLoginStatus()
        }
        .onChange(of: model.name) { _, value in if !saving { name = value } }
        .onChange(of: model.state) { _, state in
            if state == .running, pendingPort == model.port {
                pendingPort = nil
                restartRequired = false
                port = String(model.port)
            }
        }
        .onChange(of: model.keepAwake) { _, value in if !saving { keepAwake = value } }
        .onChange(of: keepAwake) { _, _ in saved = false }
        .onChange(of: name) { _, _ in saved = false }
        .onChange(of: port) { _, _ in saved = false }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            system.refreshLoginStatus()
        }
    }

    private func setAgent(_ kind: String, enabled: Bool) async {
        changingAgent = true
        error = nil
        defer { changingAgent = false }
        do { try await model.setAgent(kind, enabled: enabled) }
        catch { self.error = error.localizedDescription }
    }

    private func save() async {
        guard let number = Int(port), (1...65535).contains(number), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = "Enter a Mac name and a port from 1 to 65535."
            return
        }
        saving = true
        error = nil
        saved = false
        defer { saving = false }
        do {
            restartRequired = try await model.setConfig(name: name, port: number, keepAwake: keepAwake)
            pendingPort = restartRequired ? number : nil
            name = model.name
            saved = true
        } catch { self.error = error.localizedDescription }
    }
}
