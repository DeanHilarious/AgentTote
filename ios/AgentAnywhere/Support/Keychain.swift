import Foundation
import Security

/// Stores each Mac's bridge token as a generic password keyed by the Mac's id.
enum Keychain {
    private static let service = "com.agentanywhere.bridge-token"
    private static let accountService = "com.agentanywhere.account"
    private static let accountKey = "refresh-token"

    private static var accountQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: accountService, kSecAttrAccount as String: accountKey]
    }

    static func setAccountRefreshToken(_ token: String) throws {
        let data = Data(token.utf8)
        var status = SecItemUpdate(accountQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = accountQuery
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw StorageError() }
    }

    static func accountRefreshToken() -> String? {
        var query = accountQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteAccountRefreshToken() {
        SecItemDelete(accountQuery as CFDictionary)
    }

    private struct StorageError: LocalizedError {
        var errorDescription: String? { "Couldn't save your session securely. Try signing in again." }
    }

    static func setToken(_ token: String, for id: UUID) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id.uuidString]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func token(for id: UUID) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteToken(for id: UUID) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id.uuidString]
        SecItemDelete(query as CFDictionary)
    }
}
