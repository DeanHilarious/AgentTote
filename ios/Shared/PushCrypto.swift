import Foundation
import CryptoKit

struct PushPlaintext: Codable, Equatable {
    let v: Int
    let deviceId: String
    let macName: String
    let taskId: String
    let agent: String
    let sessionId: String?
    let status: String
    let title: String
    let summary: String
    let endedAt: Double

    var notificationTitle: String {
        let name: String
        switch agent {
        case "claude": name = "Claude Code"
        case "codex": name = "ChatGPT"
        case "workbuddy": name = "WorkBuddy"
        case "antigravity": name = "Antigravity"
        case "cursor": name = "Cursor"
        default: name = agent
        }
        let outcome: String
        switch status {
        case "completed": outcome = "Done"
        case "failed": outcome = "Failed"
        default: outcome = "Cancelled"
        }
        return "\(name) · \(outcome)"
    }

    var notificationBody: String {
        if !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return summary }
        switch status {
        case "failed": return "Task failed on \(macName)."
        case "cancelled": return "Task cancelled on \(macName)."
        default: return "Task finished on \(macName)."
        }
    }

    var destination: PushDestination {
        PushDestination(deviceId: deviceId, taskId: taskId, agent: agent, sessionId: sessionId)
    }
}

struct PushDestination: Codable, Equatable {
    let deviceId: String
    let taskId: String
    let agent: String
    let sessionId: String?

    init(deviceId: String, taskId: String, agent: String, sessionId: String?) {
        self.deviceId = deviceId
        self.taskId = taskId
        self.agent = agent
        self.sessionId = sessionId
    }

    init?(userInfo: [AnyHashable: Any]) {
        guard let deviceId = userInfo["deviceId"] as? String,
              let taskId = userInfo["taskId"] as? String,
              let agent = userInfo["agent"] as? String else { return nil }
        self.init(deviceId: deviceId, taskId: taskId, agent: agent, sessionId: userInfo["sessionId"] as? String)
    }

    var userInfo: [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["deviceId": deviceId, "taskId": taskId, "agent": agent]
        if let sessionId { info["sessionId"] = sessionId }
        return info
    }

    func isSameSession(as visible: PushDestination?) -> Bool {
        guard let visible, deviceId.lowercased() == visible.deviceId.lowercased(), agent == visible.agent else { return false }
        if let sessionId, !sessionId.isEmpty, let visibleId = visible.sessionId { return sessionId == visibleId }
        return !taskId.isEmpty && taskId == visible.taskId
    }
}

enum PushCrypto {
    enum Failure: Error { case invalidEnvelope, invalidPlaintext, invalidKey }
    private static let context = Data("aa push v1".utf8)

    static func loadOrCreateKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let data = try PushKeyStore.load() {
            return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data)
        }
        let key = Curve25519.KeyAgreement.PrivateKey()
        // An extension never creates keys. If two callers race, load the winner.
        try PushKeyStore.save(key.rawRepresentation)
        guard let stored = try PushKeyStore.load() else { throw Failure.invalidKey }
        return try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: stored)
    }

    static func decrypt(_ base64: String, privateKey: Curve25519.KeyAgreement.PrivateKey) throws -> PushPlaintext {
        guard base64.utf8.count <= 3000, let envelope = Data(base64Encoded: base64),
              envelope.count >= 61, envelope.first == 1 else { throw Failure.invalidEnvelope }
        let peerBytes = Data(envelope[1..<33])
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peerBytes)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        guard shared.withUnsafeBytes({ $0.contains(where: { $0 != 0 }) }) else { throw Failure.invalidKey }
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self,
            salt: peerBytes + privateKey.publicKey.rawRepresentation, sharedInfo: context, outputByteCount: 32)
        let box = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: envelope[33..<45]),
            ciphertext: envelope[45..<(envelope.count - 16)], tag: envelope.suffix(16))
        let data = try ChaChaPoly.open(box, using: key, authenticating: context)
        let plain = try JSONDecoder().decode(PushPlaintext.self, from: data)
        guard plain.v == 1, ["completed", "failed", "cancelled"].contains(plain.status),
              !plain.deviceId.isEmpty, !plain.taskId.isEmpty, !plain.agent.isEmpty else { throw Failure.invalidPlaintext }
        return plain
    }

    static func decrypt(_ base64: String) throws -> PushPlaintext {
        guard let data = try PushKeyStore.load() else { throw Failure.invalidKey }
        return try decrypt(base64, privateKey: Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data))
    }
}
