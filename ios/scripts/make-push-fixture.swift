// Generate a simctl payload for the installed app's PUBLIC key; never export its private key.
// Run from the repository root:
// xcrun swiftc -module-cache-path /tmp/aa-push-fixture-cache ios/scripts/make-push-fixture.swift -o /tmp/aa-make-push-fixture
// /tmp/aa-make-push-fixture PUBLIC_KEY DEVICE_ID SESSION_ID [AGENT] [TASK_ID]
import Foundation
import CryptoKit

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3, let publicData = Data(base64Encoded: args[0]), publicData.count == 32 else {
    fatalError("Usage: make-push-fixture.swift PUBLIC_KEY_BASE64 DEVICE_ID SESSION_ID [AGENT] [TASK_ID]")
}
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let vectorData = try Data(contentsOf: root.appendingPathComponent("docs/push-test-vectors.json"))
let vector = try JSONSerialization.jsonObject(with: vectorData) as! [String: Any]
var plain = try JSONSerialization.jsonObject(with: Data((vector["plaintext"] as! String).utf8)) as! [String: Any]
plain["deviceId"] = args[1]
plain["sessionId"] = args[2].isEmpty ? nil : args[2]
plain["agent"] = args.count > 3 ? args[3] : "codex"
plain["taskId"] = args.count > 4 ? args[4] : UUID().uuidString
plain["endedAt"] = Date().timeIntervalSince1970 * 1000
let ephemeral = Curve25519.KeyAgreement.PrivateKey()
let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicData)
let shared = try ephemeral.sharedSecretFromKeyAgreement(with: peer)
let context = Data("aa push v1".utf8)
let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
    salt: ephemeral.publicKey.rawRepresentation + publicData, sharedInfo: context, outputByteCount: 32)
let box = try ChaChaPoly.seal(JSONSerialization.data(withJSONObject: plain), using: key, authenticating: context)
let envelope = (Data([1]) + ephemeral.publicKey.rawRepresentation + box.combined).base64EncodedString()
let payload: [String: Any] = ["aps": ["alert": ["title": "AgentAnywhere", "body": "A task you follow has an update."],
    "mutable-content": 1, "sound": "default"], "aa": envelope]
print(String(decoding: try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
