import XCTest
import CryptoKit
@testable import AgentAnywhereMac

final class UpdaterTests: XCTestCase {
    private let feed = URL(string: UpdatePolicy.defaultFeed)!
    private func payload(url: String = "https://agent-anywhere.nuts-claw.tech/updates/mac/test.zip") -> UpdateManifest {
        UpdateManifest(version: "2026.10.18", build: "20261018123000", url: URL(string: url)!,
            sha256: SHA256.hash(data: Data("zip fixture".utf8)).map { String(format: "%02x", $0) }.joined(),
            size: 11, notes: "A test update", minimumSystemVersion: "14.0", publishedAt: "2026-10-18T12:30:00Z")
    }
    private func envelope(_ manifest: UpdateManifest, key: Curve25519.Signing.PrivateKey) throws -> Data {
        let bytes = try JSONEncoder().encode(manifest)
        return try JSONSerialization.data(withJSONObject: ["payload": bytes.base64EncodedString(),
            "signature": try key.signature(for: bytes).base64EncodedString()])
    }

    func testNumericVersionAndSameDayBuildComparison() throws {
        func v(_ version: String, _ build: String) throws -> UpdateVersion { try UpdateVersion(version: version, build: build) }
        XCTAssertLessThan(try v("2026.9.30", "999"), try v("2026.10.1", "1"))
        XCTAssertLessThan(try v("2026.10.18", "20261018123000"), try v("2026.10.18", "20261018123001"))
        XCTAssertLessThan(try v("2026.10.18", "9"), try v("2026.10.18", "10"))
        XCTAssertEqual(try v("2026.01.0", "0004"), try v("2026.1", "4"))
        XCTAssertLessThan(try v("1", "99999999999999999999"), try v("1", "100000000000000000000"))
        for invalid in ["", "1..2", "1.beta", "-1", "1.２"] { XCTAssertThrowsError(try v(invalid, "1")) }
        for invalid in ["", "-1", "1.0", "1e3"] { XCTAssertThrowsError(try v("1", invalid)) }
    }

    func testValidSignature() throws {
        let key = Curve25519.Signing.PrivateKey() // Ephemeral test key only.
        let decoded = try UpdatePolicy.verifyManifest(envelope(payload(), key: key),
            publicKey: key.publicKey.rawRepresentation.base64EncodedString(), feed: feed)
        XCTAssertEqual(decoded.version, "2026.10.18")
        XCTAssertEqual(decoded.build, "20261018123000")
        XCTAssertEqual(decoded.notes, "A test update")
    }

    func testWrongKeyWrongSignatureAndPayloadTampering() throws {
        let key = Curve25519.Signing.PrivateKey()
        let data = try envelope(payload(), key: key)
        let publicKey = key.publicKey.rawRepresentation.base64EncodedString()
        XCTAssertThrowsError(try UpdatePolicy.verifyManifest(data,
            publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString(), feed: feed))
        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        let original = envelope
        envelope["signature"] = Data(repeating: 0, count: 64).base64EncodedString()
        XCTAssertThrowsError(try UpdatePolicy.verifyManifest(JSONSerialization.data(withJSONObject: envelope), publicKey: publicKey, feed: feed))
        envelope = original
        var bytes = try XCTUnwrap(Data(base64Encoded: envelope["payload"]!))
        bytes.append(32) // Even semantically identical JSON must verify the exact original bytes.
        envelope["payload"] = bytes.base64EncodedString()
        XCTAssertThrowsError(try UpdatePolicy.verifyManifest(JSONSerialization.data(withJSONObject: envelope), publicKey: publicKey, feed: feed))
        XCTAssertThrowsError(try UpdatePolicy.verifyManifest(data, publicKey: "bad key", feed: feed))
    }

    func testSignedManifestRejectsNonHTTPSAndDifferentHost() throws {
        let key = Curve25519.Signing.PrivateKey()
        for url in ["http://agent-anywhere.nuts-claw.tech/a.zip", "https://evil.example/a.zip",
                    "https://agent-anywhere.nuts-claw.tech.evil.example/a.zip", "https://agent-anywhere.nuts-claw.tech:444/a.zip",
                    "https://user@agent-anywhere.nuts-claw.tech/a.zip", "https://agent-anywhere.nuts-claw.tech/a.zip#fragment"] {
            XCTAssertThrowsError(try UpdatePolicy.verifyManifest(envelope(payload(url: url), key: key),
                publicKey: key.publicKey.rawRepresentation.base64EncodedString(), feed: feed), url)
        }
        XCTAssertThrowsError(try UpdatePolicy.validateURL(feed, feed: URL(string: "http://agent-anywhere.nuts-claw.tech/latest.json")!))
        XCTAssertNoThrow(try UpdatePolicy.validateURL(URL(string: "https://AGENT-ANYWHERE.NUTS-CLAW.TECH/a.zip")!, feed: feed))
    }

    func testSizeAndSHA256Validation() throws {
        let manifest = payload()
        XCTAssertNoThrow(try UpdatePolicy.verifyArchive(size: 11, digest: manifest.sha256, manifest: manifest))
        XCTAssertThrowsError(try UpdatePolicy.verifyArchive(size: 12, digest: manifest.sha256, manifest: manifest))
        XCTAssertThrowsError(try UpdatePolicy.verifyArchive(size: 11, digest: String(repeating: "0", count: 64), manifest: manifest))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("zip fixture".utf8).write(to: file)
        XCTAssertNoThrow(try UpdatePolicy.verifyArchive(at: file, manifest: manifest))
        try Data("ZIP fixture".utf8).write(to: file)
        XCTAssertThrowsError(try UpdatePolicy.verifyArchive(at: file, manifest: manifest))
    }

    func testInstallationEligibility() {
        func reason(team: String? = "TESTTEAM01", path: String = "/Applications/AgentAnywhere.app",
                    readOnly: Bool = false, writable: Bool = true) -> String? {
            UpdatePolicy.ineligibility(.init(teamID: team, appPath: path, readOnlyVolume: readOnly, parentWritable: writable))
        }
        XCTAssertNil(reason())
        XCTAssertNotNil(reason(team: nil))
        XCTAssertNotNil(reason(team: ""))
        XCTAssertNotNil(reason(path: "/Volumes/AgentAnywhere/AgentAnywhere.app"))
        XCTAssertNotNil(reason(path: "/private/var/folders/test/AppTranslocation/id/d/AgentAnywhere.app"))
        XCTAssertNotNil(reason(path: "/tmp/AgentAnywhere"))
        XCTAssertNotNil(reason(readOnly: true))
        XCTAssertNotNil(reason(writable: false))
    }

    @MainActor
    func testLegacyBuildMigrationAndMissingKey() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("Fixture.app")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        let info = ["CFBundleIdentifier": "test.ota.fixture", "CFBundleShortVersionString": "2026.10.18", "CFBundleVersion": "2026.10.18"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: root.appendingPathComponent("Contents/Info.plist"))
        let bundle = try XCTUnwrap(Bundle(url: root))
        XCTAssertEqual(try UpdateInstaller.installedVersion(bundle), try UpdateVersion(version: "2026.10.18", build: "0"))
        XCTAssertFalse(Updater(bundle: bundle).enabled)
    }

    func testDittoMetadataAndArchiveTraversal() {
        XCTAssertNoThrow(try UpdatePolicy.validateArchivePaths("AgentAnywhere.app/\nAgentAnywhere.app/Contents/Info.plist\n__MACOSX/\n__MACOSX/._AgentAnywhere.app\n__MACOSX/AgentAnywhere.app/._Contents\n"))
        for listing in ["", "/tmp/evil", "Other.app/Contents/file", "AgentAnywhere.app/../../evil",
                        "__MACOSX/Other.app/file", "AgentAnywhere.app/..\\evil"] {
            XCTAssertThrowsError(try UpdatePolicy.validateArchivePaths(listing))
        }
    }

    func testRedirectsAreRefusedWithoutNetwork() {
        let delegate = UpdateDownloadDelegate(limit: 100) { _ in }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: feed) // Never resumed; no network request.
        let response = HTTPURLResponse(url: feed, statusCode: 302, httpVersion: nil, headerFields: nil)!
        for destination in [feed, URL(string: "http://evil.example/test")!] {
            var called = false
            delegate.urlSession(session, task: task, willPerformHTTPRedirection: response,
                newRequest: URLRequest(url: destination)) { request in
                    called = true
                    XCTAssertNil(request)
                }
            XCTAssertTrue(called)
        }
    }
}
