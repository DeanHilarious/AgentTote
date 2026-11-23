import AppKit
import XCTest
@testable import AgentAnywhereMac

final class AppTerminationTests: XCTestCase {
    @MainActor
    private final class Application: NSApplication {
        var onTerminate: (() -> Void)?

        override func terminate(_ sender: Any?) {
            onTerminate?()
        }
    }

    @MainActor
    func testQuitReturnsToRunLoopUntilShutdownFinishes() async {
        let application = Application()
        let delegate = AppDelegate()
        let terminated = expectation(description: "Shutdown requests a second quit")
        var terminationRequests = 0
        application.onTerminate = {
            terminationRequests += 1
            XCTAssertEqual(delegate.applicationShouldTerminate(application), .terminateNow)
            terminated.fulfill()
        }

        XCTAssertEqual(delegate.applicationShouldTerminate(application), .terminateCancel)
        XCTAssertEqual(delegate.applicationShouldTerminate(application), .terminateCancel)
        XCTAssertEqual(terminationRequests, 0)

        await fulfillment(of: [terminated], timeout: 3)
        XCTAssertEqual(terminationRequests, 1)
        XCTAssertEqual(delegate.applicationShouldTerminate(application), .terminateNow)
        application.onTerminate = nil
    }
}
