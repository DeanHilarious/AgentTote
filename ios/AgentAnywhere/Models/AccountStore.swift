import Foundation
import Observation

@MainActor
@Observable
final class AccountStore {
    private(set) var user: AccountUser?
    private(set) var devices: [AccountDevice] = []
    private(set) var serverAddress: String
    private(set) var hasSession: Bool
    private(set) var isRestoring: Bool
    private(set) var recoveryMessage: String?
    private(set) var errorMessage: String?

    @ObservationIgnored var onChange: (() -> Void)?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var accessToken: String?
    @ObservationIgnored private var refreshTask: Task<String, Error>?
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    @ObservationIgnored private var retryAttempt = 0
    @ObservationIgnored private var inForeground = true
    @ObservationIgnored private var needsRestore: Bool
    @ObservationIgnored private let retryDelays: [Duration]
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var deviceRevision = 0
    @ObservationIgnored private var ticketCache = ConnectionTicketCache()
    @ObservationIgnored private var ticketRequests: [UUID: Task<String, Error>] = [:]
    @ObservationIgnored private var ticketRevision = 0

    init(defaults: UserDefaults = .standard, session: URLSession = .shared, retryDelays: [Duration] = [.seconds(5), .seconds(15), .seconds(30), .seconds(60)]) {
        self.defaults = defaults
        self.session = session
        let saved = defaults.string(forKey: "accountServerAddress") ?? "https://agent-anywhere.nuts-claw.tech"
        let address = (try? AccountClient.serverURL(saved)) == nil ? "https://agent-anywhere.nuts-claw.tech" : saved
        serverAddress = address
        self.retryDelays = retryDelays.isEmpty ? [.seconds(60)] : retryDelays
        let hasToken = Keychain.accountRefreshToken() != nil
        hasSession = hasToken
        needsRestore = hasToken
        isRestoring = hasToken
        if hasToken,
           let data = defaults.data(forKey: Self.cacheKey),
           let cache = try? JSONDecoder().decode(AccountCache.self, from: data),
           cache.serverAddress == address {
            user = cache.user
            isRestoring = false
            // A persisted heartbeat cannot establish that a Mac is online now.
            devices = cache.devices.map { var device = $0; device.online = false; return device }
        } else {
            defaults.removeObject(forKey: Self.cacheKey)
        }
    }

    var isSignedIn: Bool { user != nil }

    private var client: AccountClient {
        // Only validated addresses enter this store.
        AccountClient(baseURL: URL(string: serverAddress)!, session: session)
    }

    func restore() async {
        guard hasSession else { return }
        if let recoveryTask { await recoveryTask.value; return }
        retryTask?.cancel()
        retryTask = nil
        isRestoring = true
        let epoch = generation
        let task = Task { @MainActor in
            defer {
                if epoch == self.generation { self.recoveryTask = nil; self.isRestoring = false }
            }
            do {
                let restored: AccountUser = try await self.authorized { try await $0.me(token: $1) }
                try self.checkGeneration(epoch)
                if let previous = self.user, previous.id != restored.id { self.devices = [] }
                self.user = restored
                self.needsRestore = false
                self.saveCache()
                self.onChange?()
                await self.refreshDevices()
            } catch is CancellationError {
            } catch {
                if epoch == self.generation { self.recordRecoveryFailure(error) }
            }
        }
        recoveryTask = task
        await task.value
    }

    func setForeground(_ active: Bool) {
        inForeground = active
        if active { retryAttempt = 0 }
        else { retryTask?.cancel(); retryTask = nil }
    }

    func sendCode(email: String, purpose: String) async throws -> CodeDelivery {
        if purpose == "bind" {
            return try await authorized { try await $0.sendCode(email: email, purpose: purpose, token: $1) }
        }
        return try await client.sendCode(email: email, purpose: purpose)
    }

    func signIn(email: String, password: String) async throws {
        let epoch = generation
        let api = client
        let result = try await api.signIn(email: email, password: password)
        try await acceptSession(result, api: api, epoch: epoch)
    }

    func register(email: String, code: String, password: String) async throws {
        let epoch = generation
        let api = client
        let result = try await api.register(email: email, code: code, password: password)
        try await acceptSession(result, api: api, epoch: epoch)
    }

    func resetPassword(email: String, code: String, password: String) async throws {
        let epoch = generation
        let api = client
        let result = try await api.resetPassword(email: email, code: code, password: password)
        try await acceptSession(result, api: api, epoch: epoch)
    }

    private func acceptSession(_ result: AccountLogin, api: AccountClient, epoch: Int) async throws {
        guard epoch == generation else {
            try? await api.logout(result.refreshToken)
            throw CancellationError()
        }
        do { try Keychain.setAccountRefreshToken(result.refreshToken) }
        catch {
            try? await api.logout(result.refreshToken)
            throw error
        }
        generation += 1
        clearConnectionTickets()
        refreshTask = nil
        recoveryTask?.cancel()
        recoveryTask = nil
        hasSession = true
        needsRestore = false
        isRestoring = false
        finishRecovery()
        accessToken = result.accessToken
        user = result.user
        saveCache()
        errorMessage = nil
        onChange?()
        await refreshDevices()
    }

    func bind(channel: IdentityChannel, target: String, code: String) async throws {
        let epoch = generation
        let updated: AccountUser = try await authorized {
            try await $0.bind(channel: channel, target: target, code: code, token: $1)
        }
        try checkGeneration(epoch)
        user = updated
        saveCache()
        onChange?()
    }

    func changePassword(current: String?, new: String) async throws {
        let epoch = generation
        let updated: AccountUser = try await authorized { try await $0.changePassword(current: current, new: new, token: $1) }
        try checkGeneration(epoch)
        user = updated
        saveCache()
        onChange?()
    }

    func refreshDevices() async {
        guard hasSession else { return }
        if needsRestore && !isRestoring { await restore(); return }
        guard isSignedIn else { return }
        let epoch = generation
        deviceRevision += 1
        let revision = deviceRevision
        do {
            let list: [AccountDevice] = try await authorized { try await $0.devices(token: $1) }
            try checkGeneration(epoch)
            guard revision == deviceRevision else { return }
            devices = list
            saveCache()
            finishRecovery()
            onChange?()
        } catch is CancellationError {
        } catch {
            if epoch == generation, revision == deviceRevision { recordRecoveryFailure(error) }
        }
    }

    func removeDevice(_ device: AccountDevice) async throws {
        let epoch = generation
        try await authorized { try await $0.removeDevice(device.id, token: $1) }
        try checkGeneration(epoch)
        // An older list response must not bring back a device removed in the meantime.
        deviceRevision += 1
        clearConnectionTickets()
        devices.removeAll { $0.id == device.id }
        saveCache()
        onChange?()
    }

    func validAccessToken() async throws -> String {
        try await authorized { _, token in token }
    }

    func connectionTicket(for device: AccountDevice) async throws -> String {
        if let cached = ticketCache.ticket(for: device.id) { return cached }
        if let request = ticketRequests[device.id] {
            let revision = ticketRevision
            let ticket = try await request.value
            guard revision == ticketRevision else { throw CancellationError() }
            try Task.checkCancellation()
            return ticket
        }
        return try await fetchConnectionTicket(for: device)
    }

    /// Refresh even a still-usable ticket, so the four-minute cadence renews it.
    func prefetchConnectionTicket(for device: AccountDevice) async {
        guard isSignedIn, ticketRequests[device.id] == nil else { return }
        _ = try? await fetchConnectionTicket(for: device)
    }

    private func fetchConnectionTicket(for device: AccountDevice) async throws -> String {
        let epoch = generation
        let requestedAt = Date()
        let revision = ticketRevision
        let task = Task { @MainActor in
            try await self.authorized { try await $0.ticket(device.id, token: $1) }
        }
        ticketRequests[device.id] = task
        defer { if epoch == generation, revision == ticketRevision { ticketRequests[device.id] = nil } }
        do {
            let ticket = try await task.value
            try checkGeneration(epoch)
            guard revision == ticketRevision else { throw CancellationError() }
            ticketCache.insert(ticket, for: device.id, requestedAt: requestedAt)
            try Task.checkCancellation()
            return ticket
        } catch {
            if epoch == generation, let failure = error as? AccountError,
               failure.code == "network" || failure.statusCode >= 500 {
                recordRecoveryFailure(error)
            }
            throw error
        }
    }

    private func clearConnectionTickets() {
        ticketRevision += 1
        ticketCache.removeAll()
        for request in ticketRequests.values { request.cancel() }
        ticketRequests.removeAll()
    }

    func signOut() async {
        let api = client
        let token = Keychain.accountRefreshToken()
        clearCredentials()
        if let token {
            try? await api.logout(token)
        }
    }

    func deleteAccount() async throws {
        let epoch = generation
        try await authorized { try await $0.deleteAccount(token: $1) }
        try checkGeneration(epoch)
        clearCredentials()
    }

    func updateServer(_ address: String) throws {
        let url = try AccountClient.serverURL(address)
        let validated = url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard validated != serverAddress else { return }
        let api = client
        let token = Keychain.accountRefreshToken()
        // A refresh token belongs to one server; never forward it to a new address.
        clearCredentials()
        serverAddress = validated
        defaults.set(validated, forKey: "accountServerAddress")
        if let token { Task { try? await api.logout(token) } }
    }

    func submitFeedback(_ payload: FeedbackPayload) async throws {
        if hasSession {
            let _: String = try await authorized { try await $0.submitFeedback(payload, token: $1) }
        } else {
            _ = try await client.submitFeedback(payload)
        }
    }

    private func authorized<T>(_ operation: (AccountClient, String) async throws -> T) async throws -> T {
        let epoch = generation
        let api = client
        let token: String
        if let current = accessToken, Self.expiry(of: current).timeIntervalSinceNow >= 60 {
            token = current
        } else {
            token = try await refreshAccessToken()
        }
        try checkGeneration(epoch)
        try Task.checkCancellation()
        do {
            let result = try await operation(api, token)
            try checkGeneration(epoch)
            return result
        } catch let error as AccountError where error.statusCode == 401 && error.code == "unauthorized" {
            try checkGeneration(epoch)
            // A delayed 401 may refer to the token another request already replaced.
            let replacement: String
            if let current = accessToken, current != token { replacement = current }
            else { replacement = try await refreshAccessToken() }
            try checkGeneration(epoch)
            try Task.checkCancellation()
            let result = try await operation(api, replacement)
            try checkGeneration(epoch)
            return result
        }
    }

    private func refreshAccessToken() async throws -> String {
        if let refreshTask { return try await refreshTask.value }
        guard let token = Keychain.accountRefreshToken() else { throw AccountError.local("unauthorized") }
        let epoch = generation
        let api = client
        let task = Task { @MainActor () throws -> String in
            defer { if epoch == self.generation { self.refreshTask = nil } }
            do {
                let tokens = try await api.refresh(token)
                guard epoch == self.generation else {
                    try? await api.logout(tokens.refreshToken)
                    throw CancellationError()
                }
                do { try Keychain.setAccountRefreshToken(tokens.refreshToken) }
                catch {
                    self.clearCredentials()
                    try? await api.logout(tokens.refreshToken)
                    throw error
                }
                self.accessToken = tokens.accessToken
                return tokens.accessToken
            } catch let error as AccountError where error.statusCode == 401 {
                if epoch == self.generation { self.clearCredentials() }
                throw error
            }
        }
        refreshTask = task
        return try await task.value
    }

    private func clearCredentials() {
        generation += 1
        clearConnectionTickets()
        // Let an in-flight rotation finish so its new token can be revoked, not resurrected.
        refreshTask = nil
        accessToken = nil
        Keychain.deleteAccountRefreshToken()
        user = nil
        devices = []
        hasSession = false
        needsRestore = false
        recoveryTask?.cancel()
        recoveryTask = nil
        isRestoring = false
        defaults.removeObject(forKey: Self.cacheKey)
        finishRecovery()
        onChange?()
    }

    private static let cacheKey = "accountProfileCache"

    private struct AccountCache: Codable {
        let serverAddress: String
        let user: AccountUser
        let devices: [AccountDevice]
    }

    private func saveCache() {
        guard hasSession, let user else { return }
        let cache = AccountCache(serverAddress: serverAddress, user: user, devices: devices)
        if let data = try? JSONEncoder().encode(cache) { defaults.set(data, forKey: Self.cacheKey) }
    }

    private func recordRecoveryFailure(_ error: Error) {
        guard hasSession else { return }
        needsRestore = true
        if let failure = error as? AccountError, failure.code == "network" {
            recoveryMessage = "Can't reach the AgentTote service. Retrying…"
        } else {
            recoveryMessage = "Can't restore your account right now. Retrying…"
        }
        devices = devices.map { var device = $0; device.online = false; return device }
        onChange?()
        scheduleRetry()
    }

    private func finishRecovery() {
        needsRestore = false
        recoveryMessage = nil
        errorMessage = nil
        retryAttempt = 0
        retryTask?.cancel()
        retryTask = nil
    }

    private func scheduleRetry() {
        guard inForeground, hasSession, recoveryMessage != nil, retryTask == nil else { return }
        let delay = retryDelays[min(retryAttempt, retryDelays.count - 1)]
        retryAttempt += 1
        let epoch = generation
        retryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, !Task.isCancelled, epoch == self.generation, self.inForeground else { return }
            self.retryTask = nil
            await self.restore()
        }
    }

    private func checkGeneration(_ epoch: Int) throws {
        guard epoch == generation else { throw CancellationError() }
    }

    private static func expiry(of token: String) -> Date {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return .distantPast }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONDecoder().decode(Expiry.self, from: data)
        else { return .distantPast }
        return Date(timeIntervalSince1970: claims.exp)
    }

    private struct Expiry: Decodable { let exp: Double }
}
