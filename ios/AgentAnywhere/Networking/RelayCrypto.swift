import Foundation
import CryptoKit

/// Phone side of AA-RELAY-1. Counters are implicit and authenticated by AEAD.
final class RelayCrypto {
    enum Failure: LocalizedError {
        case invalidKey, invalidHandshake, invalidMessage, exhausted
        var errorDescription: String? { "The encrypted connection to your Mac could not be verified." }
    }

    private let ephemeral: Curve25519.KeyAgreement.PrivateKey
    private let staticPublic: Data
    private let deviceId: UUID
    private(set) var transcript = Data()
    private(set) var phoneKey: SymmetricKey?
    private(set) var bridgeKey: SymmetricKey?
    private var sending: UInt64? = 0
    private var receiving: UInt64? = 1

    init(deviceId: UUID, publicKey: String, ephemeralPrivate: Data? = nil) throws {
        guard publicKey.count == 43,
              publicKey.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              let key = Data(base64Encoded: publicKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="), key.count == 32
        else { throw Failure.invalidKey }
        staticPublic = key
        self.deviceId = deviceId
        ephemeral = try ephemeralPrivate.map { try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? Curve25519.KeyAgreement.PrivateKey()
    }

    var message1: Data { Data([1]) + ephemeral.publicKey.rawRepresentation }

    func accept(_ message2: Data) throws {
        guard phoneKey == nil, message2.count == 60, message2.first == 1 else { throw Failure.invalidHandshake }
        let peer = Data(message2.dropFirst().prefix(32))
        func shared(_ bytes: Data) throws -> Data {
            let secret = try ephemeral.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: bytes))
            let data = secret.withUnsafeBytes { Data($0) }
            guard data.contains(where: { $0 != 0 }) else { throw Failure.invalidKey }
            return data
        }
        var uuid = deviceId.uuid
        let t = Data("AA-RELAY-1".utf8) + withUnsafeBytes(of: &uuid) { Data($0) } + staticPublic + ephemeral.publicKey.rawRepresentation + peer
        let ikm = try shared(staticPublic) + shared(peer)
        let material = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(SHA256.hash(data: t)), info: Data("aa relay v1 keys".utf8), outputByteCount: 64).withUnsafeBytes { Data($0) }
        let p = SymmetricKey(data: material.prefix(32)), b = SymmetricKey(data: material.suffix(32))
        guard try Self.decrypt(Data(message2.dropFirst(33)), key: b, counter: 0, aad: t) == Data("AA-RELAY-OK".utf8) else { throw Failure.invalidHandshake }
        transcript = t
        phoneKey = p
        bridgeKey = b
    }

    static func nonce(_ counter: UInt64) throws -> ChaChaPoly.Nonce {
        var big = counter.bigEndian
        return try ChaChaPoly.Nonce(data: Data(repeating: 0, count: 4) + withUnsafeBytes(of: &big) { Data($0) })
    }

    static func encrypt(_ plain: Data, key: SymmetricKey, counter: UInt64, aad: Data = Data()) throws -> Data {
        let box = try ChaChaPoly.seal(plain, using: key, nonce: nonce(counter), authenticating: aad)
        return box.ciphertext + box.tag
    }

    static func decrypt(_ bytes: Data, key: SymmetricKey, counter: UInt64, aad: Data = Data()) throws -> Data {
        guard bytes.count >= 16 else { throw Failure.invalidMessage }
        let box = try ChaChaPoly.SealedBox(nonce: nonce(counter), ciphertext: bytes.dropLast(16), tag: bytes.suffix(16))
        return try ChaChaPoly.open(box, using: key, authenticating: aad)
    }

    func seal(_ text: String) throws -> Data {
        guard let key = phoneKey, let counter = sending else { throw Failure.exhausted }
        let data = try Self.encrypt(Data(text.utf8), key: key, counter: counter)
        sending = counter == .max ? nil : counter + 1
        return data
    }

    func open(_ bytes: Data) throws -> String {
        guard let key = bridgeKey, let counter = receiving else { throw Failure.exhausted }
        let data = try Self.decrypt(bytes, key: key, counter: counter)
        guard let text = String(data: data, encoding: .utf8) else { throw Failure.invalidMessage }
        receiving = counter == .max ? nil : counter + 1
        return text
    }
}
