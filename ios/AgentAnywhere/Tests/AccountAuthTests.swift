// Standalone runner; uses an in-memory Keychain substitute and never touches real credentials.
// Compile with AA_ACCOUNT_UNIT_TESTS plus AccountClient, AccountStore, PairedMac, Protocol, Feedback, BonjourDiscovery and ConnectionRace;
// omit Support/Keychain.swift. The regular app build leaves this runner disabled.
#if AA_ACCOUNT_UNIT_TESTS
import Foundation

@MainActor
enum Keychain {
    static var token: String?
    static func accountRefreshToken() -> String? { token }
    static func setAccountRefreshToken(_ value: String) throws { token = value }
    static func deleteAccountRefreshToken() { token = nil }
}

private final class AccountHTTPMock: URLProtocol, @unchecked Sendable {
    struct Call {
        let method: String
        let path: String
        let body: [String: String]
        let authorized: Bool
    }
    private static let lock = NSLock()
    private static var history: [Call] = []
    private static var delayed = false
    private static var deletionStatus = 200
    private static var deletionDelayed = false
    private static var profileStatus = 200
    private static var profileDelayed = false
    static func configureProfile(status: Int = 200, delayed: Bool = false) {
        lock.withLock {
            profileStatus = status
            profileDelayed = delayed
        }
    }
    static func delayLogin() { lock.withLock { delayed = true } }
    static func configureDeletion(status: Int = 200, delayed: Bool = false) {
        lock.withLock { deletionStatus = status; deletionDelayed = delayed }
    }
    static var calls: [Call] { lock.withLock { history } }
    static func reset() { lock.withLock { history = [] } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        var data = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                data.append(contentsOf: bytes.prefix(count))
            }
        }
        let body = (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
        let path = request.url!.path
        Self.lock.withLock {
            Self.history.append(Call(method: request.httpMethod!, path: path, body: body,
                                     authorized: request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true))
        }
        let deletion = path == "/v1/me" && request.httpMethod == "DELETE"
        let deletionStatus = Self.lock.withLock { Self.deletionStatus }
        if deletion && deletionStatus == 0 {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let emailUser: [String: Any] = [
            "id": "user", "email": "user@example.com", "hasPassword": true
        ]
        var status = 200
        let result: [String: Any]
        switch path {
        case "/v1/auth/register", "/v1/auth/password", "/v1/auth/reset", "/v1/auth/refresh":
            let payload = Data("{\"exp\":\(Int(Date().timeIntervalSince1970) + 900)}".utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            result = ["accessToken": "header.\(payload).signature", "refreshToken": "session-refresh", "user": emailUser]
        case "/v1/auth/code": result = ["resendAfter": 60]
        case "/v1/me" where deletion:
            status = deletionStatus
            result = status == 200 ? ["ok": true] : ["error": ["code": "internal_error", "message": "tc-test-failure"]]
        case "/v1/me":
            status = Self.lock.withLock { Self.profileStatus }
            result = status == 200 ? emailUser : ["error": ["code": "internal_error", "message": "tc-test-failure"]]
        case "/v1/me/identities": result = emailUser
        case "/v1/me/password":
            if body["currentPassword"] == "wrong" {
                status = 401
                result = ["error": ["code": "invalid_credentials", "message": "hidden"]]
            } else { result = emailUser }
        case "/v1/devices": result = ["devices": []]
        case let path where path.hasSuffix("/ticket"):
            result = ["ticket": "test-connection-ticket"]
        default: result = ["ok": true]
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        let responseData = try! JSONSerialization.data(withJSONObject: result)
        let deliver = { [self] in
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: responseData)
            client?.urlProtocolDidFinishLoading(self)
        }
        let shouldDelay = Self.lock.withLock {
            (path == "/v1/auth/password" && Self.delayed) || (deletion && Self.deletionDelayed) ||
                (path == "/v1/me" && !deletion && Self.profileDelayed)
        }
        if shouldDelay {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.1, execute: deliver)
        } else { deliver() }
    }
}

@main
@MainActor
private enum AccountAuthTestRunner {
    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw NSError(domain: "AccountAuthTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }

    static func main() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountHTTPMock.self]
        let session = URLSession(configuration: configuration)
        let suite = "AgentAnywhere-auth-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite); Keychain.token = nil }
        AccountHTTPMock.reset()
        let store = AccountStore(defaults: defaults, session: session)
        let password = "  private password  "
        try await store.register(email: "USER@example.com", code: "123456", password: password)
        try expect(store.hasSession && store.user?.hasPassword == true, "Registration did not establish the account")
        try expect(Keychain.token == "session-refresh", "Only the refresh token should enter Keychain")
        for (code, message) in [
            ("email_taken", "This email already has an account. Sign in instead."),
            ("invalid_code", "That code is wrong or has expired."),
            ("invalid_credentials", "Wrong email or password."),
            ("phone_login_disabled", "Phone sign-in is disabled. Use your bound email."),
            ("rate_limited", "Too many attempts. Try again in 60 s.")
        ] {
            let error = AccountError(code: code, message: "hidden", retryAfter: 60)
            try expect(error.localizedDescription == message, "Error mapping changed: \(code)")
        }
        let registration = AccountHTTPMock.calls.first!
        try expect(registration.body["email"] == "user@example.com", "Email normalization changed")
        try expect(registration.body["code"] == "123456" && registration.body["phone"] == nil, "Registration code or email-only contract changed")
        try expect(registration.body["password"] == password, "Password whitespace changed")
        await store.signOut()
        try await store.signIn(email: "user@example.com", password: password)
        let count = AccountHTTPMock.calls.count
        do {
            try await store.changePassword(current: "wrong", new: "next password")
            throw NSError(domain: "AccountAuthTests", code: 2)
        } catch let error as AccountError {
            try expect(error.code == "invalid_credentials", "Wrong current password lost its error")
            try expect(error.localizedDescription == "Wrong email or password.", "Credential copy changed")
        }
        try expect(AccountHTTPMock.calls.count == count + 1, "Credential failure must not refresh the session")
        try expect(store.hasSession, "Credential failure signed out the account")
        try await store.changePassword(current: password, new: "next password")
        let cache = defaults.data(forKey: "accountProfileCache")!
        try expect(!String(decoding: cache, as: UTF8.self).contains(password), "Password entered the user cache")
        try expect(!String(describing: defaults.dictionaryRepresentation()).contains(password), "Password entered UserDefaults")
        let restored = AccountStore(defaults: defaults, session: session)
        try expect(restored.user?.hasPassword == true && restored.hasSession, "Profile cache lost password availability")
        await store.signOut()
        _ = try await store.sendCode(email: "USER@example.com", purpose: "reset")
        let delivery = AccountHTTPMock.calls.last!
        try expect(delivery.body == ["channel": "email", "target": "user@example.com", "purpose": "reset"], "Reset delivery body changed")
        try await store.resetPassword(email: "USER@example.com", code: "654321", password: password)
        let reset = AccountHTTPMock.calls.first { $0.path == "/v1/auth/reset" }!
        try expect(reset.body["email"] == "user@example.com" && reset.body["code"] == "654321" && reset.body["password"] == password, "Reset request changed")
        try expect(store.hasSession && store.user?.hasPassword == true, "Reset must sign in")
        let device = AccountDevice(id: UUID(), name: "Test Mac", hosts: [], port: 8787, online: true, publicKey: nil, relayOnline: nil, lastSeenAt: 0)
        let ticketCalls = { AccountHTTPMock.calls.filter { $0.path.hasSuffix("/ticket") }.count }
        let beforeTickets = ticketCalls()
        async let firstTicket = store.connectionTicket(for: device)
        async let secondTicket = store.connectionTicket(for: device)
        let tickets = try await (firstTicket, secondTicket)
        try expect(tickets.0 == tickets.1 && ticketCalls() == beforeTickets + 1, "Concurrent routes must share a single ticket request")
        _ = try await store.connectionTicket(for: device)
        try expect(ticketCalls() == beforeTickets + 1, "Reconnect should reuse a prefetched ticket")
        await store.prefetchConnectionTicket(for: device)
        try expect(ticketCalls() == beforeTickets + 2, "Periodic prefetch must renew a still-valid ticket")
        try expect(!String(describing: defaults.dictionaryRepresentation()).contains("test-connection-ticket"), "Connection tickets must stay in memory")
        await store.signOut()
        try await store.signIn(email: "user@example.com", password: password)
        _ = try await store.connectionTicket(for: device)
        try expect(ticketCalls() == beforeTickets + 3, "Sign-out must invalidate cached connection tickets")

        _ = try await store.sendCode(email: "bound@example.com", purpose: "bind")
        try expect(AccountHTTPMock.calls.last?.authorized == true, "Binding code requires authentication")
        try await store.bind(channel: .email, target: "bound@example.com", code: "123456")
        try await store.changePassword(current: nil, new: "next password")
        try expect(AccountHTTPMock.calls.last?.body["currentPassword"] == nil, "Optional current password was not omitted")
        let legacy = try JSONDecoder().decode(AccountUser.self, from: Data(#"{"id":"legacy","email":"old@example.com"}"#.utf8))
        try expect(!legacy.hasPassword, "Legacy profiles should decode safely")
        try await checkProfileRestore(store: store, defaults: defaults, session: session)
        try await store.signIn(email: "user@example.com", password: password)
        try await checkAccountDeletion(store: store, defaults: defaults, device: device)
        await store.signOut()
        let previousCalls = AccountHTTPMock.calls.count
        AccountHTTPMock.delayLogin()
        let staleLogin = Task { try await store.signIn(email: "user@example.com", password: password) }
        while AccountHTTPMock.calls.count == previousCalls { await Task.yield() }
        try store.updateServer("https://other.example.com")
        do {
            try await staleLogin.value
            throw NSError(domain: "AccountAuthTests", code: 3)
        } catch is CancellationError { }
        try expect(!store.hasSession && store.user == nil && Keychain.token == nil, "A stale login resurrected credentials")
        try expect(AccountHTTPMock.calls.last?.path == "/v1/auth/logout", "A stale login session was not revoked")
        print("Account authentication checks passed (requests, sessions, cache, ticket prefetch/dedup/sign-out, credential errors, legacy profile, stale login).")
    }

    private static func checkProfileRestore(store: AccountStore, defaults: UserDefaults, session: URLSession) async throws {
        await store.restore()
        let restored = AccountStore(defaults: defaults, session: session)
        try expect(restored.user?.email == "user@example.com", "The current profile must survive restart")
        AccountHTTPMock.configureProfile(status: 503)
        await restored.restore()
        try expect(restored.user?.email == "user@example.com", "A temporary outage must preserve the profile")
        try expect(restored.recoveryMessage != nil, "A service failure must be visible")
        restored.setForeground(false)
        AccountHTTPMock.configureProfile(delayed: true)
        let previousCalls = AccountHTTPMock.calls.count
        let staleRestore = Task { await store.restore() }
        while AccountHTTPMock.calls.count == previousCalls { await Task.yield() }
        await store.signOut()
        await staleRestore.value
        try expect(store.user == nil, "A stale profile response must not restore a signed-out user")
        AccountHTTPMock.configureProfile()
    }

    private static func checkAccountDeletion(store: AccountStore, defaults: UserDefaults, device: AccountDevice) async throws {
        for status in [0, 500] {
            AccountHTTPMock.configureDeletion(status: status)
            do {
                try await store.deleteAccount()
                throw NSError(domain: "AccountAuthTests", code: 4)
            } catch let error as AccountError {
                try expect(error.code == (status == 0 ? "network" : "internal_error"), "Deletion failure lost its cause")
            }
            try expect(store.hasSession && store.user != nil && Keychain.token != nil, "Failed deletion cleared credentials")
            try expect(defaults.data(forKey: "accountProfileCache") != nil, "Failed deletion cleared the profile cache")
        }
        AccountHTTPMock.configureDeletion()
        let ticketCount = AccountHTTPMock.calls.filter { $0.path.hasSuffix("/ticket") }.count
        var accountChanged = false
        store.onChange = { accountChanged = true }
        try await store.deleteAccount()
        let deletion = AccountHTTPMock.calls.last!
        try expect(deletion.method == "DELETE" && deletion.path == "/v1/me" && deletion.authorized,
                   "Deletion must use the authenticated DELETE endpoint")
        try expect(!store.hasSession && store.user == nil && store.devices.isEmpty, "Successful deletion retained account state")
        try expect(Keychain.token == nil && defaults.data(forKey: "accountProfileCache") == nil,
                   "Successful deletion retained credentials or cached personal data")
        try expect(accountChanged, "Account deletion did not notify the Mac connection owner")
        try await store.signIn(email: "user@example.com", password: "tc-test-password")
        _ = try await store.connectionTicket(for: device)
        try expect(AccountHTTPMock.calls.filter { $0.path.hasSuffix("/ticket") }.count == ticketCount + 1,
                   "Deletion retained a cached connection ticket")

        AccountHTTPMock.configureDeletion(delayed: true)
        let count = AccountHTTPMock.calls.count
        let staleDeletion = Task { try await store.deleteAccount() }
        while AccountHTTPMock.calls.count == count { await Task.yield() }
        try await store.signIn(email: "user@example.com", password: "tc-test-password")
        do {
            try await staleDeletion.value
            throw NSError(domain: "AccountAuthTests", code: 5)
        } catch is CancellationError { }
        try expect(store.hasSession && store.user != nil && Keychain.token != nil, "A stale deletion cleared a newer session")
        AccountHTTPMock.configureDeletion()
        print("Account deletion checks passed (network/server errors, authenticated DELETE, credentials/cache/tickets, change notification, stale response).")
    }
}
#endif
