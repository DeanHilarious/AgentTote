import SwiftUI

@main
struct AgentAnywhereApp: App {
    @AppStorage(InterfaceLanguagePicker.preferenceKey) private var language = InterfaceLanguagePicker.initialLanguage
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.account)
                .environment(\.locale, Locale(identifier: language))
                .tint(Brand.relayText)
                .task {
                    model.start()
                    await model.account.restore()
                }
                // Scanning the bridge's QR code with the system Camera opens agentanywhere://pair?...
                .onOpenURL { url in
                    if let link = PairingLink(url: url) { model.pendingPairing = link }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            model.scenePhaseChanged(phase)
        }
    }
}

struct RootView: View {
    var body: some View {
        WorkspaceView()
    }
}

private struct WorkspaceView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("skippedAccountLogin") private var skippedLogin = false
    @State private var showPairing = false

    var body: some View {
        @Bindable var model = model
        Group {
            if model.account.hasSession && !model.account.isSignedIn && model.macs.isEmpty {
                AccountRecoveryView()
            } else if !model.account.isSignedIn && model.macs.isEmpty && !skippedLogin {
                NavigationStack {
                    LoginView {
                        skippedLogin = true
                        showPairing = true
                    }
                }
            } else {
                NavigationStack(path: $model.navigationPath) { HomeView() }
            }
        }
        .sheet(isPresented: $showPairing) {
            NavigationStack { PairingView(isOnboarding: false) }
        }
        .sheet(item: $model.pendingPairing) { link in
            NavigationStack { PairingView(isOnboarding: false, prefilled: link) }
        }
    }
}

extension PairingLink: Identifiable {
    var id: String { token }
}

private struct AccountRecoveryView: View {
    @Environment(AccountStore.self) private var account

    var body: some View {
        VStack(spacing: 20) {
            if account.isRestoring { ProgressView() }
            else { Image(systemName: "wifi.slash").font(.largeTitle).foregroundStyle(.secondary) }
            Text("Restoring your account…").font(.headline)
            if let message = account.recoveryMessage {
                Text(message).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Button("Retry") { Task { await account.restore() } }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(account.isRestoring)
            Button("Sign out", role: .destructive) { Task { await account.signOut() } }.buttonStyle(DestructiveButtonStyle())
        }
        .padding()
        .brandScreen()
    }
}
