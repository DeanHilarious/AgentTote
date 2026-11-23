import SwiftUI
import IOKit.ps

struct MenuPanel: View {
    @State private var onPower = Self.isOnPower
    private static var isOnPower: Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return false }
        return source as String == kIOPSACPowerValue
    }
    @Environment(BridgeModel.self) private var model
    @Environment(SystemActions.self) private var system
    @Environment(Updater.self) private var updater
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            UpdateBanner()
            HStack(spacing: 10) {
                BrandMark(size: 28)
                BrandWordmark(size: 17)
                Spacer(minLength: 0)
                Text(runTitle).font(.caption.weight(.semibold))
                    .foregroundStyle(runForeground)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(runBackground, in: Capsule())
                    .accessibilityLabel(model.state.label)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.fatalCode == "port_in_use" {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.portConflictMessage).foregroundStyle(Brand.failureText).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Remove old login item") { Task { await system.removeOldLoginItem() } }
                            .buttonStyle(DestructiveButtonStyle(compact: true)).disabled(system.removingLoginItem)
                        Button("Retry") { Task { await model.restart() } }
                            .buttonStyle(PrimaryButtonStyle(fullWidth: false, compact: true)).disabled(model.restarting)
                    }
                }
                .padding(12).background(Brand.failureSoft, in: RoundedRectangle(cornerRadius: 16))
            }
            if case .failed(let message) = model.state, model.fatalCode != "port_in_use" {
                Text(message).font(.callout).foregroundStyle(Brand.failureText)
                    .fixedSize(horizontal: false, vertical: true).padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Brand.failureSoft, in: RoundedRectangle(cornerRadius: 16))
            }
            if model.isRunning && model.keepAwakeActive && (model.keepAwake == .always || model.keepAwake == .onPower && onPower) {
                Label("Keeping Mac awake", systemImage: "cup.and.saucer.fill")
                    .font(.caption).foregroundStyle(Brand.successText)
            }
            if !model.name.isEmpty { Text(model.name).font(.caption).foregroundStyle(Brand.muted) }
            HStack(spacing: 8) {
                statistic("Phones", value: "\(model.clients) connected", color: Brand.ink)
                statistic("Relay", value: relayTitle, color: model.relay.state == .online ? Brand.relayText : Brand.muted)
            }
            if model.relay.state == .off && model.account.user == nil {
                Text("Sign in to enable relay.").font(.caption).foregroundStyle(Brand.muted)
            }
            VStack(spacing: 0) {
                ForEach(Brand.agents.filter { !model.disabledAgents.contains($0.0) }, id: \.0) { kind, fallback in
                    let agent = model.agents.first { $0.kind == kind }
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 10) {
                            AgentIcon(kind: kind, iconPath: agent?.iconPath)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(agent?.name ?? fallback).font(.subheadline.weight(.medium))
                                if let version = agent?.version { Text(version).foregroundStyle(Brand.muted).font(.caption2) }
                            }
                            Spacer(minLength: 0)
                            if kind == "workbuddy", agent?.status == "needsLogin" {
                                Button("Connect…") { show("connect-workbuddy") }
                                    .buttonStyle(CompactConnectButtonStyle())
                                    .accessibilityLabel("Connect WorkBuddy")
                            } else if let status = agent?.status, status == "needsLogin" {
                                Button("Sign in…") { system.openAgentSetup(kind: kind, status: status) }
                                    .buttonStyle(CompactConnectButtonStyle())
                                    .accessibilityLabel("Sign in to \(agent?.name ?? fallback)")
                            } else if kind == "cursor", let status = agent?.status, status == "unavailable" {
                                Button("Install CLI…") { system.openAgentSetup(kind: kind, status: status) }
                                    .buttonStyle(CompactConnectButtonStyle())
                                    .accessibilityLabel("Install Cursor CLI")
                            } else {
                                Text(agent?.statusLabel ?? (model.isRunning ? "Not installed" : "—"))
                                    .font(.caption.weight(.semibold)).foregroundStyle(agent?.status == "ready" ? Brand.successText : Brand.muted)
                            }
                        }
                        .frame(minHeight: 44)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .help(agent?.detail ?? agent?.statusLabel ?? fallback)
                    .accessibilityHint(agent?.detail ?? "")
                    if kind != Brand.agents.map(\.0).last(where: { !model.disabledAgents.contains($0) }) { Rectangle().fill(Brand.separator).frame(height: 1).padding(.leading, 48) }
                }
            }
            .brandCard(radius: 12)
            HStack(spacing: 8) {
                Button { show("pairing") } label: { Label("Pair a phone", systemImage: "qrcode") }
                    .buttonStyle(RelayButtonStyle(compact: true)).disabled(!model.isRunning)
                Button("Account") { show("account") }.buttonStyle(TintedButtonStyle(compact: true))
            }
            VStack(alignment: .leading, spacing: 0) {
                Rectangle().fill(Brand.line).frame(height: 1).padding(.bottom, 6)
                menuItem("Settings…") { show("settings") }
                if updater.enabled {
                    menuItem("Check for Updates…") { Task { await updater.check() } }
                        .disabled(updater.checking || updater.installing)
                } else {
                    Text("Automatic updates are not enabled").font(.caption).foregroundStyle(Brand.muted).padding(6)
                }
                menuItem("Logs…") { show("logs") }
                menuItem("Restart bridge") { Task { await model.restart() } }.disabled(model.restarting)
                if let error = system.error {
                    Text(error).font(.caption).foregroundStyle(Brand.failureText).padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading).background(Brand.failureSoft, in: RoundedRectangle(cornerRadius: 12))
                }
                if let notice = system.notice { Text(notice).font(.caption).foregroundStyle(Brand.muted).padding(6) }
                menuItem("Quit AgentTote") { NSApp.terminate(nil) }.keyboardShortcut("q")
            }
        }
        .padding(16).frame(width: 360).brandScreen()
        .onAppear {
            onPower = Self.isOnPower
            if model.isRunning { Task { try? await model.refreshAgents() } }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if model.isRunning { Task { try? await model.refreshAgents() } }
        }
        .onReceive(Timer.publish(every: 10, on: .main, in: .common).autoconnect()) { _ in onPower = Self.isOnPower }
    }

    private var runTitle: String {
        switch model.state {
        case .running: "Running"
        case .starting: "Starting…"
        case .stopped: "Stopped"
        case .failed: "Failed"
        }
    }
    private var runForeground: Color {
        if case .failed = model.state { return Brand.failureText }
        return model.isRunning ? Brand.successText : Brand.warningText
    }
    private var runBackground: Color {
        if case .failed = model.state { return Brand.failureSoft }
        return model.isRunning ? Brand.successSoft : Brand.warningSoft
    }

    private var relayTitle: String {
        switch model.relay.state {
        case .off: "Off"
        case .connecting: "Connecting…"
        case .online: "Online"
        case .error: "Reconnecting…"
        }
    }
    private func statistic(_ label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(Brand.muted)
            Text(value).font(Brand.title(20, relativeTo: .title3)).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(12).brandCard(radius: 12)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Brand.line, lineWidth: 1))
    }
    private func agentColor(_ kind: String) -> Color {
        Brand.agentColor(kind)
    }
    private func menuItem(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 6).contentShape(Rectangle()) }
            .buttonStyle(.plain)
    }
    private func show(_ id: String) {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: id)
    }
}
