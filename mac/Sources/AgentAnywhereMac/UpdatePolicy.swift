import Foundation
import CryptoKit

struct UpdateFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// Decimal strings avoid overflow and compare date versions numerically (10 > 9).
struct UpdateVersion: Comparable, Equatable {
    let components: [String]
    let build: String

    init(version: String, build: String) throws {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard !parts.isEmpty, parts.allSatisfy(Self.isDecimal), Self.isDecimal(build) else {
            throw UpdateFailure("Invalid update version or build number.")
        }
        components = parts.map(Self.normalized)
        self.build = Self.normalized(build)
    }

    static func isDecimal(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy { (48...57).contains($0) }
    }
    private static func normalized(_ value: String) -> String {
        let result = value.drop(while: { $0 == "0" })
        return result.isEmpty ? "0" : String(result)
    }
    private static func compare(_ a: String, _ b: String) -> ComparisonResult {
        if a == b { return .orderedSame }
        return (a.count == b.count ? a < b : a.count < b.count) ? .orderedAscending : .orderedDescending
    }
    private static func ordering(_ lhs: Self, _ rhs: Self) -> ComparisonResult {
        for i in 0..<max(lhs.components.count, rhs.components.count) {
            let c = compare(i < lhs.components.count ? lhs.components[i] : "0",
                            i < rhs.components.count ? rhs.components[i] : "0")
            if c != .orderedSame { return c }
        }
        return compare(lhs.build, rhs.build)
    }
    static func == (lhs: Self, rhs: Self) -> Bool { ordering(lhs, rhs) == .orderedSame }
    static func < (lhs: Self, rhs: Self) -> Bool { ordering(lhs, rhs) == .orderedAscending }
}

struct UpdateManifest: Codable {
    let version: String
    let build: String
    let url: URL
    let sha256: String
    let size: Int64
    let notes: String?
    let minimumSystemVersion: String
    let publishedAt: String

    var release: UpdateVersion { get throws { try UpdateVersion(version: version, build: build) } }
}

enum UpdatePolicy {
    static let defaultFeed = "https://agent-anywhere.nuts-claw.tech/updates/mac/latest.json"
    static let downloadPage = URL(string: "https://agent-anywhere.nuts-claw.tech/download/")!

    static func validateURL(_ url: URL, feed: URL) throws {
        guard feed.scheme?.lowercased() == "https", let host = feed.host, !host.isEmpty,
              feed.user == nil, feed.password == nil,
              url.scheme?.lowercased() == "https", url.host?.lowercased() == host.lowercased(),
              url.user == nil, url.password == nil, url.fragment == nil,
              (url.port ?? 443) == (feed.port ?? 443) else {
            throw UpdateFailure("Update URLs must use HTTPS on the feed's host and port.")
        }
    }

    static func verifyManifest(_ data: Data, publicKey: String, feed: URL) throws -> UpdateManifest {
        struct Envelope: Decodable { let payload: String; let signature: String }
        try validateURL(feed, feed: feed)
        guard data.count <= 1_048_576 else { throw UpdateFailure("Update manifest is too large.") }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard let key = Data(base64Encoded: publicKey), key.count == 32,
              let bytes = Data(base64Encoded: envelope.payload),
              let signature = Data(base64Encoded: envelope.signature), signature.count == 64 else {
            throw UpdateFailure("Invalid update key or signature encoding.")
        }
        let verifier = try Curve25519.Signing.PublicKey(rawRepresentation: key)
        guard verifier.isValidSignature(signature, for: bytes) else {
            throw UpdateFailure("Update manifest signature verification failed.")
        }
        let manifest = try JSONDecoder().decode(UpdateManifest.self, from: bytes)
        _ = try manifest.release
        _ = try UpdateVersion(version: manifest.minimumSystemVersion, build: "0")
        try validateURL(manifest.url, feed: feed)
        let dateParser = ISO8601DateFormatter()
        let basicDate = dateParser.date(from: manifest.publishedAt)
        dateParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard manifest.url.pathExtension.lowercased() == "zip", manifest.size > 0,
              manifest.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              basicDate != nil || dateParser.date(from: manifest.publishedAt) != nil else {
            throw UpdateFailure("Invalid update archive metadata.")
        }
        return manifest
    }

    static func validateArchivePaths(_ listing: String) throws {
        let entries = listing.split(separator: "\n")
        guard !entries.isEmpty, entries.allSatisfy({ entry in
            // ditto can emit AppleDouble records for stapling and Finder metadata.
            let allowed = entry.hasPrefix("AgentAnywhere.app/") || entry == "__MACOSX/" ||
                entry == "__MACOSX/._AgentAnywhere.app" || entry.hasPrefix("__MACOSX/AgentAnywhere.app/")
            return allowed && !entry.split(separator: "/").contains("..") && !entry.contains("\\")
        }) else { throw UpdateFailure("Update archive contains unexpected paths.") }
    }

    static func verifyArchive(size: Int64, digest: String, manifest: UpdateManifest) throws {
        guard size == manifest.size else { throw UpdateFailure("Update download size does not match the signed manifest.") }
        guard digest == manifest.sha256 else { throw UpdateFailure("Update download SHA-256 does not match the signed manifest.") }
    }

    static func verifyArchive(at url: URL, manifest: UpdateManifest) throws {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        var size: Int64 = 0
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            try Task.checkCancellation()
            size += Int64(chunk.count)
            hash.update(data: chunk)
        }
        try verifyArchive(size: size, digest: hash.finalize().map { String(format: "%02x", $0) }.joined(), manifest: manifest)
    }

    struct Installation {
        let teamID: String?
        let appPath: String
        let readOnlyVolume: Bool
        let parentWritable: Bool
    }

    static func ineligibility(_ installation: Installation) -> String? {
        guard let team = installation.teamID, !team.isEmpty else { return "This app has no Developer ID team signature." }
        guard installation.appPath.hasSuffix(".app") else { return "Run the installed app to update." }
        if installation.appPath.contains("/AppTranslocation/") { return "Move the app to Applications before updating." }
        // External volumes are deliberately conservative: this also excludes mounted DMG images.
        if installation.readOnlyVolume || installation.appPath.hasPrefix("/Volumes/") {
            return "Install the app on your Mac before updating."
        }
        if !installation.parentWritable { return "The app's folder is not writable." }
        return nil
    }
}
