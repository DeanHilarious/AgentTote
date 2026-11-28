import AppKit
import XCTest
@testable import AgentAnywhereMac

@MainActor
final class TestApplication: NSApplication {
    var onTerminate: (() -> Void)?

    override func terminate(_ sender: Any?) {
        onTerminate?()
    }
}

final class AppTerminationTests: XCTestCase {
    @MainActor
    func testQuitReturnsToRunLoopUntilShutdownFinishes() async throws {
        let application = try XCTUnwrap(TestApplication.shared as? TestApplication)
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
