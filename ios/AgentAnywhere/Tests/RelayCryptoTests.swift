// Standalone runner, from the repository root on macOS:
// xcrun swiftc -swift-version 5 -module-cache-path /tmp/aa-swift-cache -warnings-as-errors -D AA_RELAY_UNIT_TESTS -parse-as-library \
//   ios/AgentAnywhere/Networking/RelayCrypto.swift ios/AgentAnywhere/Tests/RelayCryptoTests.swift \
//   -o /tmp/aa-relay-tests && /tmp/aa-relay-tests
#if AA_RELAY_UNIT_TESTS
import Foundation
import CryptoKit

@main
struct RelayCryptoTests {
    struct Vectors: Decodable {
        let deviceId, phonePrivate, ephemeralPrivate, staticPublic, publicKey, transcript, msg1, msg2, k_p2b, k_b2p: String
        let messages: [Message]
    }
    struct Message: Decodable { let direction, counter, plaintext, ciphertext: String }
    static func hex(_ s: String) -> Data {
        let chars = Array(s)
        return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0...($0 + 1)]), radix: 16)! })
    }
    static func check(_ value: @autoclosure () throws -> Bool) throws { let result = try value(); precondition(result) }
    static func rejects(_ label: String, _ operation: () throws -> Void) {
        do { try operation(); fatalError("Accepted \(label)") } catch { }
    }
    static func main() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let v = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: root.appendingPathComponent("docs/relay-test-vectors.json")))
        func session(key: String? = nil) throws -> RelayCrypto {
            try RelayCrypto(deviceId: UUID(uuidString: v.deviceId)!, publicKey: key ?? v.publicKey, ephemeralPrivate: hex(v.phonePrivate))
        }
        let c = try session()
        precondition(c.message1 == hex(v.msg1))
        try c.accept(hex(v.msg2))
        precondition(c.transcript == hex(v.transcript))
        precondition(c.phoneKey!.withUnsafeBytes { Data($0) } == hex(v.k_p2b))
        precondition(c.bridgeKey!.withUnsafeBytes { Data($0) } == hex(v.k_b2p))
        let confirmation = try RelayCrypto.encrypt(Data("AA-RELAY-OK".utf8), key: c.bridgeKey!, counter: 0, aad: c.transcript)
        let peer = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(v.ephemeralPrivate)).publicKey.rawRepresentation
        precondition(Data([1]) + peer + confirmation == hex(v.msg2))
        for m in v.messages {
            let key = m.direction == "p2b" ? c.phoneKey! : c.bridgeKey!
            let bytes = hex(m.ciphertext), counter = UInt64(m.counter)!
            try check(RelayCrypto.encrypt(Data(m.plaintext.utf8), key: key, counter: counter) == bytes)
            try check(RelayCrypto.decrypt(bytes, key: key, counter: counter) == Data(m.plaintext.utf8))
            if m.direction == "p2b" { try check(c.seal(m.plaintext) == bytes) }
            else { try check(c.open(bytes) == m.plaintext) }
            var altered = bytes; altered[0] ^= 1
            rejects("tamper") { _ = try RelayCrypto.decrypt(altered, key: key, counter: counter) }
            rejects("wrong counter") { _ = try RelayCrypto.decrypt(bytes, key: key, counter: counter + 1) }
        }
        rejects("replay") { _ = try c.open(hex(v.messages[2].ciphertext)) }
        var altered = hex(v.msg2); altered[59] ^= 1
        rejects("handshake tamper") { try session().accept(altered) }
        rejects("wrong identity") { try session(key: Data(repeating: 1, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: "")).accept(hex(v.msg2)) }
        rejects("zero static secret") { try session(key: String(repeating: "A", count: 43)).accept(hex(v.msg2)) }
        var zeroPeer = hex(v.msg2); zeroPeer.replaceSubrange(1..<33, with: Data(repeating: 0, count: 32))
        rejects("zero ephemeral secret") { try session().accept(zeroPeer) }
        rejects("short handshake") { try session().accept(Data([1])) }
        rejects("duplicate handshake") { try c.accept(hex(v.msg2)) }
        print("PASS: transcript, msg1, msg2, k_p2b, k_b2p; 3 ciphertext/decryption vectors; tamper, counters, replay, identity, zero secrets, malformed handshake")
    }
}
#endif
