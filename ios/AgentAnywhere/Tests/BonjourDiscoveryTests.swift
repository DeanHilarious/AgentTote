// Standalone XCTest runner; excluded from the application unless explicitly enabled.
// Run from the repository root on macOS with Xcode installed:
// aa_test_platform="$(xcode-select -p)/Platforms/MacOSX.platform/Developer"
// xcrun swiftc -D AA_BONJOUR_UNIT_TESTS -parse-as-library -swift-version 5 \
//   -I "$aa_test_platform/usr/lib" -L "$aa_test_platform/usr/lib" \
//   -F "$aa_test_platform/Library/Frameworks" \
//   -Xlinker -rpath -Xlinker "$aa_test_platform/usr/lib" \
//   -Xlinker -rpath -Xlinker "$aa_test_platform/Library/Frameworks" \
//   ios/AgentAnywhere/Networking/{BonjourDiscovery,AccountClient}.swift \
//   ios/AgentAnywhere/Models/PairedMac.swift ios/AgentAnywhere/Tests/BonjourDiscoveryTests.swift \
//   -o /tmp/aa-bonjour-unit-tests
// DYLD_FRAMEWORK_PATH="$aa_test_platform/Library/PrivateFrameworks" /tmp/aa-bonjour-unit-tests
#if AA_BONJOUR_UNIT_TESTS
import Foundation
import Network
import XCTest

final class BonjourDiscoveryTests: XCTestCase {
    func testRelayFieldsPreserveLegacyDataAndPinnedKey() throws {
        let id = "00112233-4455-6677-8899-aabbccddeeff"
        let legacy = Data("{\"id\":\"\(id)\",\"name\":\"Mac\",\"hosts\":[\"localhost\"],\"port\":8787}".utf8)
        let paired = try JSONDecoder().decode(PairedMac.self, from: legacy)
        XCTAssertNil(paired.publicKey)
        let deviceJSON = Data("{\"id\":\"\(id)\",\"name\":\"Mac\",\"hosts\":[],\"port\":8787,\"online\":false,\"lastSeenAt\":0}".utf8)
        let device = try JSONDecoder().decode(AccountDevice.self, from: deviceJSON)
        XCTAssertNil(device.publicKey)
        XCTAssertNil(device.relayOnline)
        let pk = "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8"
        let link = try XCTUnwrap(PairingLink(string: "agentanywhere://pair?hosts=localhost&token=test&device=\(id)&pk=\(pk)"))
        XCTAssertEqual(link.publicKey, pk)
        var pinned = paired
        pinned.publicKey = pk
        let restored = try JSONDecoder().decode(PairedMac.self, from: JSONEncoder().encode(pinned))
        XCTAssertEqual(restored.publicKey, pk)
        XCTAssertEqual(restored.usingAccountAddress(device).publicKey, pk)
        let address = try XCTUnwrap(BonjourAddress(endpoint: .hostPort(host: .ipv4(.loopback), port: 8787)))
        XCTAssertEqual(restored.usingBonjourAddress(address).publicKey, pk)
    }

    private func service(_ name: String) -> NWEndpoint {
        .service(name: name, type: "_agentanywhere._tcp", domain: "local.", interface: nil)
    }

    func testScopedIPv4BecomesAValidWebSocketHost() throws {
        let scoped = try XCTUnwrap(IPv4Address("192.168.11.128%en0"))
        XCTAssertTrue(scoped.debugDescription.contains("%en0"), "The regression must exercise an interface-scoped address")
        let address = try XCTUnwrap(BonjourAddress(endpoint: .hostPort(host: .ipv4(scoped), port: 8800)))
        XCTAssertEqual(address.host, "192.168.11.128")
        XCTAssertEqual(address.port, 8800)
        let url = try XCTUnwrap(URL(string: "ws://\(address.host):\(address.port)/"))
        XCTAssertEqual(url.host, "192.168.11.128")
        XCTAssertEqual(url.port, 8800)
    }

    func testIPv4BytesRejectInvalidDestinationsAndAllowLoopback() throws {
        for bytes: [UInt8] in [[], [192, 168, 11], [192, 168, 11, 128, 1], [0, 0, 0, 0],
                              [0, 1, 2, 3], [224, 0, 0, 251], [240, 0, 0, 1], [255, 255, 255, 255]] {
            XCTAssertNil(BonjourAddress.ipv4Host(rawValue: Data(bytes)))
        }
        XCTAssertEqual(BonjourAddress.ipv4Host(rawValue: Data([192, 168, 11, 128])), "192.168.11.128")
        XCTAssertEqual(BonjourAddress.ipv4Host(rawValue: Data([100, 64, 1, 2])), "100.64.1.2")
        XCTAssertEqual(BonjourAddress.ipv4Host(rawValue: Data([127, 0, 0, 1])), "127.0.0.1")
    }

    func testEndpointRejectsUnresolvedNamesIPv6AndZeroPort() throws {
        XCTAssertNil(BonjourAddress(endpoint: nil))
        XCTAssertNil(BonjourAddress(endpoint: .hostPort(host: .name("mac.local", nil), port: 8800)))
        XCTAssertNil(BonjourAddress(endpoint: .hostPort(host: .ipv6(try XCTUnwrap(IPv6Address("::1"))), port: 8800)))
        XCTAssertNil(BonjourAddress(endpoint: .hostPort(host: .ipv4(.loopback), port: 0)))
    }

    func testPortChangeUpdatesPairedMacAndNewAddressPriority() throws {
        let ip = try XCTUnwrap(IPv4Address("192.168.11.128%en0"))
        let old = try XCTUnwrap(BonjourAddress(endpoint: .hostPort(host: .ipv4(ip), port: 8799)))
        let new = try XCTUnwrap(BonjourAddress(endpoint: .hostPort(host: .ipv4(ip), port: 8800)))
        XCTAssertNotEqual(old, new, "A port change must trigger the existing immediate reconnect branch")
        let paired = PairedMac(id: UUID(), name: "Mac", hosts: ["192.168.0.105", "192.168.11.128%en0"],
                               port: 8799, lastGoodHost: "192.168.0.105", deviceId: UUID())
        let updated = paired.usingBonjourAddress(new)
        XCTAssertEqual(updated.orderedHosts.first, "192.168.11.128")
        XCTAssertEqual(updated.port, 8800)
        XCTAssertNil(updated.lastGoodHost)
        XCTAssertNotEqual(updated, paired)
        XCTAssertEqual(updated.usingBonjourAddress(new), updated)
    }

    func testBrowseChangesResolveOnlyChangedKnownServices() throws {
        let first = UUID(), second = UUID(), unknown = UUID()
        let a = service("A"), b = service("B"), c = service("Unknown")
        let policy = BonjourResolutionPolicy(deviceIds: [first, second], selectedDeviceId: first)
        let results = [a: first, b: second, c: unknown]
        XCTAssertEqual(policy.changedTargets(in: results, endpoints: [a, c]), [a])
        XCTAssertTrue(policy.changedTargets(in: results, endpoints: []).isEmpty)
        XCTAssertTrue(policy.changedTargets(in: results, endpoints: [service("Removed")]).isEmpty)
    }

    func testTXTOrInterfaceChangeStillResolvesOnceWhileConnected() throws {
        let id = UUID(), endpoint = service("Mac")
        let policy = BonjourResolutionPolicy(deviceIds: [id], selectedDeviceId: id, isConnected: true)
        // The endpoint can be identical while TXT/interface metadata changes.
        XCTAssertEqual(policy.changedTargets(in: [endpoint: id], endpoints: [endpoint]), [endpoint])
        XCTAssertTrue(policy.pollingTargets(in: [endpoint: id]).isEmpty)
        XCTAssertNil(policy.pollingDeviceId)
    }

    func testPollingOnlyResolvesSelectedDisconnectedMac() throws {
        let first = UUID(), second = UUID()
        let a = service("A"), b = service("B")
        let results = [a: first, b: second]
        var policy = BonjourResolutionPolicy(deviceIds: [first, second], selectedDeviceId: first)
        XCTAssertEqual(policy.pollingTargets(in: results), [a])
        policy.selectedDeviceId = second
        XCTAssertEqual(policy.pollingTargets(in: results), [b])
        policy.isConnected = true
        XCTAssertTrue(policy.pollingTargets(in: results).isEmpty)
        policy.isConnected = false
        policy.selectedDeviceId = nil
        XCTAssertTrue(policy.pollingTargets(in: results).isEmpty)
        policy.selectedDeviceId = UUID()
        XCTAssertTrue(policy.pollingTargets(in: results).isEmpty)
        policy.selectedDeviceId = first
        policy.deviceIds = [second]
        XCTAssertTrue(policy.pollingTargets(in: results).isEmpty)
    }
}

@main
enum BonjourDiscoveryTestRunner {
    static func main() {
        let suite = BonjourDiscoveryTests.defaultTestSuite
        suite.run()
        guard let run = suite.testRun, run.executionCount == 8, run.totalFailureCount == 0 else { exit(1) }
    }
}
#endif
