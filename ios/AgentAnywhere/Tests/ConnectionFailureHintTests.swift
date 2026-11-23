// Standalone macOS XCTest runner, excluded from the app unless explicitly enabled.
// Run from the repository root:
// aa_test_platform="$(xcode-select -p)/Platforms/MacOSX.platform/Developer"
// xcrun swiftc -D AA_CONNECTION_HINT_UNIT_TESTS -parse-as-library -swift-version 5 \
//   -module-cache-path mac/.build/module-cache \
//   -I "$aa_test_platform/usr/lib" -L "$aa_test_platform/usr/lib" \
//   -F "$aa_test_platform/Library/Frameworks" \
//   -Xlinker -rpath -Xlinker "$aa_test_platform/usr/lib" \
//   -Xlinker -rpath -Xlinker "$aa_test_platform/Library/Frameworks" \
//   ios/AgentAnywhere/Models/{PairedMac,MacSelection,ConnectionFailureHint}.swift \
//   ios/AgentAnywhere/Networking/{BonjourDiscovery,AccountClient}.swift \
//   ios/AgentAnywhere/Tests/ConnectionFailureHintTests.swift -o /tmp/aa-connection-hint-tests
// DYLD_FRAMEWORK_PATH="$aa_test_platform/Library/PrivateFrameworks" /tmp/aa-connection-hint-tests
#if AA_CONNECTION_HINT_UNIT_TESTS
import Foundation
import XCTest

final class ConnectionFailureHintTests: XCTestCase {
    let id = UUID()
    let now = Date(timeIntervalSince1970: 2_000_000_000)
    func device(relay: Bool? = true, seen: Double = 0) -> AccountDevice {
        AccountDevice(id: id, name: "Mac", hosts: [], port: 8787, online: true,
                      publicKey: "account-key", relayOnline: relay, lastSeenAt: seen)
    }
    func testOfflineFromRelayOrDirectoryAndLastSeen() {
        for cause in [ConnectionFailureCause.bridgeOffline, .unreachable] {
            let hint = ConnectionFailureHint.resolve(cause: cause, fallback: "socket failed", isPaired: false, signedIn: true,
                accountDevice: device(relay: false, seen: (now.timeIntervalSince1970 - 12 * 60) * 1000), now: now)
            XCTAssertEqual(hint.message, "Your Mac is offline or asleep. Last seen 12 min ago.")
            XCTAssertFalse(hint.offersSignIn)
        }
        let offline = ConnectionFailureHint.resolve(cause: .bridgeOffline, fallback: "socket", isPaired: false, signedIn: true, accountDevice: nil)
        XCTAssertEqual(offline.message, "Your Mac is offline or asleep.")
    }
    func testQRWithoutAccountOffersSignIn() {
        let hint = ConnectionFailureHint.resolve(cause: .unreachable, fallback: "socket", isPaired: true, signedIn: false, accountDevice: nil)
        XCTAssertEqual(hint.message, "Can't reach this Mac on the local network. Sign in with the same account as your Mac to connect from anywhere.")
        XCTAssertTrue(hint.offersSignIn)
    }
    func testQRNotInSignedInAccountExplainsNetworkLimit() {
        let hint = ConnectionFailureHint.resolve(cause: .unreachable, fallback: "socket", isPaired: true, signedIn: true, accountDevice: nil)
        XCTAssertEqual(hint.message, "This Mac isn't signed in to your account, so it can only be reached on the same network.")
        XCTAssertFalse(hint.offersSignIn)
    }
    func testOtherErrorsAndOnlineOrLegacyDevicesKeepOriginalText() {
        for relay in [true, nil] as [Bool?] {
            XCTAssertEqual(ConnectionFailureHint.resolve(cause: .unreachable, fallback: "original", isPaired: true, signedIn: true,
                accountDevice: device(relay: relay)).message, "original")
        }
        for fallback in ["Security key changed", "Pairing token missing", "Ticket rejected"] {
            XCTAssertEqual(ConnectionFailureHint.resolve(cause: .other, fallback: fallback, isPaired: true, signedIn: false,
                accountDevice: device(relay: false)), ConnectionFailureHint(message: fallback, offersSignIn: false))
        }
    }
    func testQRRecordsMergeIntoAccountRouteAndRetainPinnedKey() throws {
        let paired = PairedMac(id: UUID(), name: "QR Mac", hosts: ["192.0.2.1"], port: 8787, deviceId: id, publicKey: "qr-pin")
        let unrelated = PairedMac(id: UUID(), name: "Other", hosts: [], port: 8787, deviceId: UUID())
        let legacy = PairedMac(id: UUID(), name: "Mac", hosts: [], port: 8787)
        let account = device()
        let entries = MacSelection.available(paired: [paired, unrelated, legacy], devices: [account])
        XCTAssertEqual(entries, [.account(account), .paired(unrelated), .paired(legacy)])
        let merged = try XCTUnwrap(MacSelection.mergedAccount(for: MacSelection.paired(paired).id,
                                                             paired: [paired], devices: [account]))
        XCTAssertEqual(merged.id, paired.deviceId)
        XCTAssertEqual(entries.first?.id, MacSelection.account(merged).id)
        XCTAssertEqual(paired.usingAccountAddress(merged).publicKey, "qr-pin")
        XCTAssertNil(MacSelection.mergedAccount(for: MacSelection.paired(unrelated).id, paired: [unrelated], devices: [account]))
        XCTAssertNil(MacSelection.mergedAccount(for: MacSelection.paired(legacy).id, paired: [legacy], devices: [account]))
    }
}

@main
enum ConnectionFailureHintTestRunner {
    static func main() {
        let suite = ConnectionFailureHintTests.defaultTestSuite
        suite.run()
        guard let run = suite.testRun, run.executionCount == 5, run.totalFailureCount == 0 else { exit(1) }
    }
}
#endif
