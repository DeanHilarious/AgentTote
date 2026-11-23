import Foundation
import Security

enum PushKeyStore {
    struct Failure: Error { let status: OSStatus }
    private static let service = "com.agentanywhere.push-key"

    private static func query() throws -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "x25519"]
        #if os(iOS)
        // Expanded from AppIdentifierPrefix by Xcode in both targets' Info.plist.
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PushKeychainAccessGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { throw Failure(status: errSecMissingEntitlement) }
        query[kSecAttrAccessGroup as String] = group
        #endif
        return query
    }

    static func load() throws -> Data? {
        var request = try query()
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure(status: status) }
        return data
    }

    static func save(_ data: Data) throws {
        var request = try query()
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(request as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else { throw Failure(status: status) }
    }
}
