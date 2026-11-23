// Standalone macOS runner: compile Protocol.swift, AgentIconStore.swift and this file
// with -D AA_ICON_UNIT_TESTS -parse-as-library -warnings-as-errors.
#if AA_ICON_UNIT_TESTS
import Foundation
import AppKit
import CryptoKit

@main @MainActor
private enum AgentIconStoreTests {
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var clock = Date(timeIntervalSince1970: 1000)
        let store = AgentIconStore(directory: directory, now: { clock })
        func artwork(_ value: UInt8) -> Data {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1, pixelsHigh: 1, bitsPerSample: 8,
                samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 4, bitsPerPixel: 32)!
            bitmap.bitmapData![0] = value
            bitmap.bitmapData![1] = 0
            bitmap.bitmapData![2] = 0
            bitmap.bitmapData![3] = 255
            return bitmap.representation(using: .png, properties: [:])!
        }
        func hash(_ data: Data) -> String {
            String(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16))
        }
        let png = artwork(30), changed = artwork(200)
        let first = hash(png), second = hash(changed)
        precondition(AgentKind.codex.displayName == "ChatGPT")
        precondition(AgentKind.codex.rawValue == "codex")
        precondition(AgentIconStore.key(agent: .codex, hash: first) == "codex-\(first)")
        precondition(AgentIconStore.key(agent: .codex, hash: first) != AgentIconStore.key(agent: .claude, hash: first))
        var requests = 0
        let fetch: @MainActor () async throws -> AgentIconReply = {
            requests += 1
            await Task.yield()
            return AgentIconReply(agent: .codex, iconHash: first, png: png.base64EncodedString())
        }
        async let a: Void = store.load(agent: .codex, hash: first, fetch: fetch)
        async let b: Void = store.load(agent: .codex, hash: first, fetch: fetch)
        _ = await (a, b)
        precondition(requests == 1)
        precondition(store.image(agent: .codex, hash: first) == png)
        // A second Mac with the same hash and a restarted store both reuse the cached PNG.
        await store.load(agent: .codex, hash: first, fetch: fetch)
        let restarted = AgentIconStore(directory: directory)
        await restarted.load(agent: .codex, hash: first, fetch: fetch)
        precondition(requests == 1)
        await store.load(agent: .codex, hash: second) {
            requests += 1
            return AgentIconReply(agent: .codex, iconHash: second, png: changed.base64EncodedString())
        }
        precondition(requests == 2 && store.image(agent: .codex, hash: second) == changed)
        precondition(store.image(agent: .codex, hash: nil) == nil)
        var failures = 0
        let fail: @MainActor () async throws -> AgentIconReply = {
            failures += 1
            throw CocoaError(.fileReadNoSuchFile)
        }
        await store.load(agent: .claude, hash: first, fetch: fail)
        clock += 599
        await store.load(agent: .claude, hash: first, fetch: fail)
        precondition(failures == 1)
        clock += 1
        await store.load(agent: .claude, hash: first, fetch: fail)
        precondition(failures == 2)
        // A different hash bypasses the old hash's failure backoff.
        await store.load(agent: .claude, hash: second) {
            AgentIconReply(agent: .claude, iconHash: second, png: changed.base64EncodedString())
        }
        precondition(store.image(agent: .claude, hash: second) == changed)
        // Reject a mismatched reply (e.g. icon changed during a fetch), and unsafe filenames.
        await store.load(agent: .workbuddy, hash: first) {
            AgentIconReply(agent: .workbuddy, iconHash: second, png: changed.base64EncodedString())
        }
        precondition(store.image(agent: .workbuddy, hash: first) == nil)
        await store.load(agent: .workbuddy, hash: "../../bad", fetch: fail)
        precondition(failures == 2)
        let legacy = Data(#"{"kind":"codex","name":"ChatGPT","status":"ready","runningProcesses":0}"#.utf8)
        let modern = Data("{\"kind\":\"codex\",\"name\":\"ChatGPT\",\"status\":\"ready\",\"runningProcesses\":0,\"iconHash\":\"\(first)\"}".utf8)
        let legacyInfo = try JSONDecoder().decode(AgentInfo.self, from: legacy)
        let modernInfo = try JSONDecoder().decode(AgentInfo.self, from: modern)
        precondition(legacyInfo.iconHash == nil)
        precondition(modernInfo.iconHash == first)
        print("Icon store checks passed: keys, coalescing, cross-Mac/disk reuse, hash update, 10-minute backoff, invalid replies and legacy decoding.")
    }
}
#endif
