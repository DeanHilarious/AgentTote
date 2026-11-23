// Standalone macOS runner from the repository root:
// xcrun swiftc -swift-version 5 -module-cache-path /tmp/aa-swift-cache -warnings-as-errors \
//   -D AA_PUSH_UNIT_TESTS -parse-as-library ios/Shared/*.swift \
//   ios/AgentAnywhere/Models/Protocol.swift ios/AgentAnywhere/Tests/PushCryptoTests.swift \
//   -o /tmp/aa-push-tests && /tmp/aa-push-tests
#if AA_PUSH_UNIT_TESTS
import Foundation
import CryptoKit

@main
private enum PushCryptoTests {
    struct Vector: Decodable { let phonePrivate, phonePublic, plaintext, ciphertext: String }
    static func hex(_ s: String) -> Data {
        let chars = Array(s)
        return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0...($0 + 1)]), radix: 16)! })
    }
    static func rejects(_ label: String, _ operation: () throws -> Void) {
        do { try operation(); fatalError("Accepted \(label)") } catch { }
    }
    static func main() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let v = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: root.appendingPathComponent("docs/push-test-vectors.json")))
        let privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(v.phonePrivate))
        precondition(privateKey.publicKey.rawRepresentation.base64EncodedString() == v.phonePublic)
        let expected = try JSONDecoder().decode(PushPlaintext.self, from: Data(v.plaintext.utf8))
        let plain = try PushCrypto.decrypt(v.ciphertext, privateKey: privateKey)
        precondition(plain == expected)
        let bytes = Data(base64Encoded: v.ciphertext)!
        for offset in bytes.indices {
            var altered = bytes
            altered[offset] ^= 1
            rejects("tamper at \(offset)") { _ = try PushCrypto.decrypt(altered.base64EncodedString(), privateKey: privateKey) }
        }
        var wrongVersion = bytes; wrongVersion[0] = 2
        rejects("version 2") { _ = try PushCrypto.decrypt(wrongVersion.base64EncodedString(), privateKey: privateKey) }
        rejects("short envelope") { _ = try PushCrypto.decrypt(Data(bytes.prefix(60)).base64EncodedString(), privateKey: privateKey) }
        rejects("bad base64") { _ = try PushCrypto.decrypt("!", privateKey: privateKey) }
        rejects("different phone") { _ = try PushCrypto.decrypt(v.ciphertext, privateKey: .init()) }

        // Authenticate malformed plaintext to exercise validation after AEAD succeeds.
        let eph = Curve25519.KeyAgreement.PrivateKey()
        let shared = try eph.sharedSecretFromKeyAgreement(with: privateKey.publicKey)
        let context = Data("aa push v1".utf8)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
            salt: eph.publicKey.rawRepresentation + privateKey.publicKey.rawRepresentation, sharedInfo: context, outputByteCount: 32)
        func encrypt(_ json: String) throws -> String {
            let box = try ChaChaPoly.seal(Data(json.utf8), using: key, authenticating: context)
            return (Data([1]) + eph.publicKey.rawRepresentation + box.combined).base64EncodedString()
        }
        for json in [v.plaintext.replacingOccurrences(of: "\"v\":1", with: "\"v\":2"),
                     v.plaintext.replacingOccurrences(of: "completed", with: "running"), "not JSON"] {
            rejects("invalid plaintext") { _ = try PushCrypto.decrypt(encrypt(json), privateKey: privateKey) }
        }
        precondition(plain.notificationTitle == "ChatGPT · Done")
        precondition(plain.notificationBody == "Done ✓")
        for (agent, name) in [("claude", "Claude Code"), ("codex", "ChatGPT"), ("workbuddy", "WorkBuddy"), ("antigravity", "Antigravity"), ("cursor", "Cursor")] {
            for (status, label) in [("completed", "Done"), ("failed", "Failed"), ("cancelled", "Cancelled")] {
                let message = PushPlaintext(v: 1, deviceId: "mac", macName: "My Mac", taskId: "t", agent: agent,
                    sessionId: nil, status: status, title: "title", summary: "", endedAt: 1)
                precondition(message.notificationTitle == "\(name) · \(label)")
                precondition(message.notificationBody.contains("My Mac"))
            }
        }
        precondition(plain.destination.isSameSession(as: plain.destination))
        precondition(!plain.destination.isSameSession(as: nil))
        for other in [PushDestination(deviceId: "other", taskId: plain.taskId, agent: plain.agent, sessionId: plain.sessionId),
                      PushDestination(deviceId: plain.deviceId, taskId: plain.taskId, agent: "claude", sessionId: plain.sessionId),
                      PushDestination(deviceId: plain.deviceId, taskId: plain.taskId, agent: plain.agent, sessionId: "other")] {
            precondition(!plain.destination.isSameSession(as: other))
        }
        let base = #"{"id":"t","agent":"codex","cwd":"/tmp","prompt":"p","permissionMode":"readOnly","status":"running","startedAt":1}"#
        let unknown = try JSONDecoder().decode(TaskInfo.self, from: Data(base.utf8))
        var watched = unknown; watched.watching = true
        precondition(unknown.preservingWatching(from: watched).watching == true)
        var unwatched = unknown; unwatched.watching = false
        precondition(unwatched.preservingWatching(from: watched).watching == false)
        precondition(unknown.preservingWatching(from: nil).watching == nil)
        precondition(PushDestination(userInfo: plain.destination.userInfo) == plain.destination)
        if CommandLine.arguments.count > 1 {
            let payload = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
            let generated = try PushCrypto.decrypt(payload["aa"] as! String, privateKey: privateKey)
            precondition(generated.deviceId == plain.deviceId && generated.sessionId == plain.sessionId)
            precondition(generated.title == plain.title && generated.summary == plain.summary)
            print("PASS: generated simctl fixture interoperates with shared decryptor")
        }
        print("PASS: push vector; every-byte tamper; versions, envelope/key/JSON/status rejection; notification text, foreground matching, watching merge, route roundtrip")
    }
}
#endif
