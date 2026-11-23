import Foundation
import Observation
import CryptoKit

struct AgentIconReply: Codable {
    let agent: AgentKind
    let iconHash: String
    let png: String
}

/// Content-addressed across Macs: identical artwork shares one cache entry.
@MainActor @Observable
final class AgentIconStore {
    private(set) var images: [String: Data] = [:]
    @ObservationIgnored private var pending: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var failedAt: [String: Date] = [:]
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let now: () -> Date

    init(directory: URL? = nil, now: @escaping () -> Date = Date.init) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AgentIcons", isDirectory: true)
        self.now = now
    }

    static func key(agent: AgentKind, hash: String) -> String { "\(agent.rawValue)-\(hash)" }

    func image(agent: AgentKind, hash: String?) -> Data? {
        guard let hash else { return nil }
        return images[Self.key(agent: agent, hash: hash)]
    }

    func load(agent: AgentKind, hash: String, fetch: @escaping @MainActor () async throws -> AgentIconReply) async {
        // Hashes come from the bridge; validate before using one as a filename.
        guard hash.count == 16, hash.allSatisfy({ "0123456789abcdef".contains($0) }) else { return }
        let key = Self.key(agent: agent, hash: hash)
        if images[key] != nil { return }
        if let task = pending[key] { await task.value; return }
        let path = directory.appendingPathComponent(key).appendingPathExtension("png")
        if let data = try? Data(contentsOf: path), Self.valid(data, hash: hash) {
            images[key] = data
            return
        }
        if let failed = failedAt[key], now().timeIntervalSince(failed) < 600 { return }
        let task = Task { @MainActor in
            do {
                let reply = try await fetch()
                guard reply.agent == agent, reply.iconHash == hash,
                      let data = Data(base64Encoded: reply.png), Self.valid(data, hash: hash) else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                images[key] = data
                failedAt[key] = nil
                try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try? data.write(to: path, options: .atomic)
            } catch is CancellationError {
                // A Mac switch is not an icon failure on the next connection.
            } catch {
                failedAt[key] = now()
            }
        }
        pending[key] = task
        await task.value
        pending[key] = nil
    }

    private static func valid(_ data: Data, hash: String) -> Bool {
        data.count <= 64 * 1024 && data.count >= 24 &&
            data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) &&
            SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().hasPrefix(hash)
    }
}
