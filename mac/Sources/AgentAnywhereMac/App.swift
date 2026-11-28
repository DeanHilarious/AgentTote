import SwiftUI
import AppKit

let hubWindowID = "hub"

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = BridgeModel()
    let system = SystemActions()
    let updater = Updater()
    private enum TerminationState { case running, shuttingDown, ready }
    private var terminationState = TerminationState.running

    static var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || NSClassFromString("XCTestCase") != nil
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(self, selector: #selector(configureHubWindow(_:)),
            name: NSWindow.didUpdateNotification, object: nil)
    }

    @objc private func configureHubWindow(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, window.identifier?.rawValue == hubWindowID,
              !window.collectionBehavior.contains([.primary, .fullScreenPrimary]) else { return }
        // SwiftUI can restore the singleton window's auxiliary role when leaving full screen.
        var behavior = window.collectionBehavior
        behavior.subtract([.auxiliary, .canJoinAllApplications, .fullScreenAuxiliary, .fullScreenNone])
        behavior.formUnion([.primary, .fullScreenPrimary])
        window.collectionBehavior = behavior
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Brand.registerFonts()
        signal(SIGPIPE, SIG_IGN)
        NSApp.setActivationPolicy(.regular)
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let modifiers = event.modifierFlags.intersection([.command, .control, .shift, .option, .function])
            guard let window = event.window, window.identifier?.rawValue == hubWindowID,
                  modifiers == [.control, .command],
                  event.charactersIgnoringModifiers?.lowercased() == "f" else { return event }
            if !event.isARepeat { window.toggleFullScreen(nil) }
            return nil
        }
        model.start()
        updater.start()
        if !Self.isRunningTests {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .showMainWindow, object: nil)
            }
        }
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
    @State private var didOpenOnLaunch = false

    var body: some View {
        Image(nsImage: Brand.menuBarImage).accessibilityLabel("AgentTote: \(model.state.label)")
            .task {
                guard !didOpenOnLaunch, !AppDelegate.isRunningTests else { return }
                didOpenOnLaunch = true
                openWindow(id: hubWindowID)
                NSApp.activate(ignoringOtherApps: true)
            }
            .onReceive(NotificationCenter.default.publisher(for: .showMainWindow)) { _ in
                openWindow(id: hubWindowID)
                NSApp.activate(ignoringOtherApps: true)
            }
    }
}

@main
struct AgentAnywhereMacApp: App {
    @AppStorage(InterfaceLanguagePicker.preferenceKey) private var language = InterfaceLanguagePicker.initialLanguage
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuPanel().environment(delegate.model).environment(delegate.system).environment(delegate.updater)
                .environment(\.locale, Locale(identifier: language))
        } label: {
            MenuBarLabel(model: delegate.model)
                .environment(\.locale, Locale(identifier: language))
        }
        .menuBarExtraStyle(.window)

        Window("AgentTote Hub", id: hubWindowID) {
            AgentHubView().environment(delegate.model).environment(delegate.system).environment(delegate.updater)
                .environment(\.locale, Locale(identifier: language))
        }
        .defaultSize(width: 1240, height: 800)

        Window("Pairing", id: "pairing") {
            PairingView().environment(delegate.model)
                .environment(\.locale, Locale(identifier: language))
        }
        .defaultSize(width: 420, height: 560)
        .windowResizability(.contentSize)
        Window("Account", id: "account") {
            AccountView().environment(delegate.model)
                .environment(\.locale, Locale(identifier: language))
        }
        .defaultSize(width: 440, height: 520)
        .windowResizability(.contentSize)
        Window("Settings", id: "settings") {
            SettingsView().environment(delegate.model).environment(delegate.system).environment(delegate.updater)
                .environment(\.locale, Locale(identifier: language))
        }
        .defaultSize(width: 460, height: 520)
        .windowResizability(.contentSize)
        Window("Connect WorkBuddy", id: "connect-workbuddy") {
            ConnectWorkBuddyView().environment(delegate.model)
                .environment(\.locale, Locale(identifier: language))
        }
        .defaultSize(width: 460, height: 400)
        .windowResizability(.contentSize)
        Window("Logs", id: "logs") {
            LogsView().environment(delegate.model)
                .environment(\.locale, Locale(identifier: language))
        }
        .defaultSize(width: 760, height: 460)
    }
}
