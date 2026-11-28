import AppKit
import XCTest
@testable import AgentAnywhereMac

@MainActor
final class HubWindowTests: XCTestCase {
    func testHubCanReenterFullScreenWhenSwiftUIRestoresTheAuxiliaryRole() {
        let delegate = AppDelegate()
        delegate.applicationWillFinishLaunching(Notification(name: NSApplication.willFinishLaunchingNotification))
        withExtendedLifetime(delegate) {
            let hub = makeAuxiliaryWindow(id: "hub")
            for _ in 0..<2 {
                hub.collectionBehavior = [.auxiliary, .fullScreenAuxiliary, .managed]
                NotificationCenter.default.post(name: NSWindow.didUpdateNotification, object: hub)
                XCTAssertEqual(hub.collectionBehavior, [.primary, .fullScreenPrimary, .managed])
            }
        }
    }

    func testSettingsRetainsItsAuxiliaryRole() {
        let delegate = AppDelegate()
        delegate.applicationWillFinishLaunching(Notification(name: NSApplication.willFinishLaunchingNotification))
        withExtendedLifetime(delegate) {
            let settings = makeAuxiliaryWindow(id: "settings")
            let original = settings.collectionBehavior
            NotificationCenter.default.post(name: NSWindow.didUpdateNotification, object: settings)
            XCTAssertEqual(settings.collectionBehavior, original)
        }
    }

    private func makeAuxiliaryWindow(id: String) -> NSWindow {
        _ = TestApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400),
                              styleMask: [.titled, .resizable], backing: .buffered, defer: true)
        window.identifier = NSUserInterfaceItemIdentifier(id)
        window.collectionBehavior = [.auxiliary, .fullScreenAuxiliary, .managed]
        return window
    }
}
