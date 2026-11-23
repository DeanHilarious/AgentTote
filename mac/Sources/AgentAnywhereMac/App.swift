import SwiftUI
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = BridgeModel()
    let system = SystemActions()
    let updater = Updater()
    private enum TerminationState { case running, shuttingDown, ready }
    private var terminationState = TerminationState.running

    func applicationDidFinishLaunching(_ notification: Notification) {
        Brand.registerFonts()
        signal(SIGPIPE, SIG_IGN)
        NSApp.setActivationPolicy(.accessory)
        model.start()
        updater.start()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationState == .ready { return .terminateNow }
        guard terminationState == .running else { return .terminateCancel }
        terminationState = .shuttingDown
        updater.stop()
        Task {
            await model.shutdown()
            terminationState = .ready
            sender.terminate(nil)
        }
        // terminateLater enters an AppKit modal loop that can starve this MainActor task.
        return .terminateCancel
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Opening the app again from Finder or Spotlight would otherwise do nothing visible, and the
    /// menu bar icon can be hidden behind the notch, so show a window the person can act on.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NotificationCenter.default.post(name: .showMainWindow, object: nil)
        return false
    }
}

extension Notification.Name {
    static let showMainWindow = Notification.Name("AgentAnywhere.showMainWindow")
}

/// The menu bar label is always alive, so it owns the window opener used when the app is reopened.
private struct MenuBarLabel: View {
    let model: BridgeModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image(nsImage: Brand.menuBarImage).accessibilityLabel("AgentTote: \(model.state.label)")
            .onReceive(NotificationCenter.default.publisher(for: .showMainWindow)) { _ in
                openWindow(id: "settings")
                NSApp.activate(ignoringOtherApps: true)
            }
    }
}

@main
struct AgentAnywhereMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuPanel().environment(delegate.model).environment(delegate.system).environment(delegate.updater)
        } label: {
            MenuBarLabel(model: delegate.model)
        }
        .menuBarExtraStyle(.window)

        Window("Pairing", id: "pairing") {
            PairingView().environment(delegate.model)
        }
        .defaultSize(width: 420, height: 560)
        .windowResizability(.contentSize)
        Window("Account", id: "account") {
            AccountView().environment(delegate.model)
        }
        .defaultSize(width: 440, height: 520)
        .windowResizability(.contentSize)
        Window("Settings", id: "settings") {
            SettingsView().environment(delegate.model).environment(delegate.system).environment(delegate.updater)
        }
        .defaultSize(width: 460, height: 520)
        .windowResizability(.contentSize)
        Window("Connect WorkBuddy", id: "connect-workbuddy") {
            ConnectWorkBuddyView().environment(delegate.model)
        }
        .defaultSize(width: 460, height: 400)
        .windowResizability(.contentSize)
        Window("Logs", id: "logs") {
            LogsView().environment(delegate.model)
        }
        .defaultSize(width: 760, height: 460)
    }
}
