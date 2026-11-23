import Foundation

struct AccountUser: Codable, Equatable {
    let id: String
    let phone: String?
    let email: String?
    let hasPassword: Bool

    enum CodingKeys: String, CodingKey { case id, phone, email, hasPassword }

    init(id: String, phone: String? = nil, email: String? = nil, hasPassword: Bool = false) {
        self.id = id
        self.phone = phone
        self.email = email
        self.hasPassword = hasPassword
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        phone = try values.decodeIfPresent(String.self, forKey: .phone)
        email = try values.decodeIfPresent(String.self, forKey: .email)
        hasPassword = try values.decodeIfPresent(Bool.self, forKey: .hasPassword) ?? false
    }
}

struct AccountDevice: Codable, Identifiable, Hashable {
    let id: UUID
    let name: String
    let hosts: [String]
    let port: Int
    var online: Bool
    var publicKey: String?
    var relayOnline: Bool?
    let lastSeenAt: Double

    var lastSeenDate: Date { Date(timeIntervalSince1970: lastSeenAt / 1000) }
    var bridgeAddress: PairedMac {
        PairedMac(id: id, name: name, hosts: hosts, port: port, lastGoodHost: nil)
    }
}

enum IdentityChannel: String, CaseIterable, Identifiable {
    case email
    var id: String { rawValue }
    var label: String { "Email" }
    func normalized(_ target: String) -> String {
        target.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct AccountError: LocalizedError, Decodable {
    let code: String
    let message: String
    let retryAfter: Int?
    var statusCode: Int = 0

    enum CodingKeys: String, CodingKey { case code, message, retryAfter }

    var errorDescription: String? {
        switch code {
        case "invalid_code", "code_expired", "too_many_attempts": return "That code is wrong or has expired."
        case "invalid_credentials": return "Wrong email or password."
        case "email_taken": return "This email already has an account. Sign in instead."
        case "phone_login_disabled": return "Phone sign-in is disabled. Use your bound email."
        case "weak_password": return "Use at least 8 characters."
        case "rate_limited":
            if let retryAfter { return "Too many attempts. Try again in \(retryAfter) s." }
            return "Too many attempts. Try again later."
        case "invalid_target": return "Enter a valid email address."
        case "unauthorized": return "Your session has expired. Sign in again."
        case "conflict": return "Already used by another account."
        case "not_found": return "This Mac is no longer in your account."
        case "delivery_failed": return "Couldn't send the code. Try again later."
        case "network": return "Can't reach the AgentTote service."
        case "invalid_server": return "Enter a valid HTTP or HTTPS server address."
        case "invalid_request", "body_too_large": return "The AgentTote service couldn't accept this request."
        default: return "The AgentTote service couldn't complete the request. Try again later."
        }
    }

    static func local(_ code: String) -> AccountError {
        AccountError(code: code, message: "", retryAfter: nil)
    }
}

struct AccountTokens: Decodable {
    let accessToken: String
    let refreshToken: String
}

struct AccountLogin: Decodable {
    let accessToken: String
    let refreshToken: String
    let user: AccountUser
}

struct CodeDelivery: Decodable {
    let resendAfter: Int
}

@MainActor
struct AccountClient {
    let baseURL: URL
    var session: URLSession = .shared

    static func serverURL(_ address: String) throws -> URL {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil
        else { throw AccountError.local("invalid_server") }
        return url
    }

    func sendCode(email: String, purpose: String, token: String? = nil) async throws -> CodeDelivery {
        try await request("POST", "auth/code", token: token, body: ["channel": "email", "target": IdentityChannel.email.normalized(email), "purpose": purpose])
    }

    func signIn(email: String, password: String) async throws -> AccountLogin {
        try await request("POST", "auth/password", body: ["email": IdentityChannel.email.normalized(email), "password": password, "deviceLabel": "AgentTote iOS"])
    }

    func register(email: String, code: String, password: String) async throws -> AccountLogin {
        try await request("POST", "auth/register", body: ["email": IdentityChannel.email.normalized(email), "code": code, "password": password, "deviceLabel": "AgentTote iOS"])
    }

    func resetPassword(email: String, code: String, password: String) async throws -> AccountLogin {
        try await request("POST", "auth/reset", body: ["email": IdentityChannel.email.normalized(email), "code": code, "password": password, "deviceLabel": "AgentTote iOS"])
    }

    func changePassword(current: String?, new: String, token: String) async throws -> AccountUser {
        var body = ["newPassword": new]
        if let current { body["currentPassword"] = current }
        return try await request("POST", "me/password", token: token, body: body)
    }

    func refresh(_ token: String) async throws -> AccountTokens {
        try await request("POST", "auth/refresh", body: ["refreshToken": token])
    }

    func logout(_ token: String) async throws {
        let _: Acknowledgement = try await request("POST", "auth/logout", body: ["refreshToken": token])
    }

    func me(token: String) async throws -> AccountUser {
        try await request("GET", "me", token: token)
    }

    func deleteAccount(token: String) async throws {
        let _: Acknowledgement = try await request("DELETE", "me", token: token)
    }

    func bind(channel: IdentityChannel, target: String, code: String, token: String) async throws -> AccountUser {
        try await request("POST", "me/identities", token: token, body: ["channel": channel.rawValue, "target": channel.normalized(target), "code": code])
    }

    func devices(token: String) async throws -> [AccountDevice] {
        let result: DeviceList = try await request("GET", "devices", token: token)
        return result.devices
    }

    func removeDevice(_ id: UUID, token: String) async throws {
        let _: Acknowledgement = try await request("DELETE", "devices/\(id.uuidString.lowercased())", token: token)
    }

    func ticket(_ id: UUID, token: String) async throws -> String {
        let result: Ticket = try await request("POST", "devices/\(id.uuidString.lowercased())/ticket", token: token, body: [:])
        return result.ticket
    }

    func submitFeedback(_ payload: FeedbackPayload, token: String? = nil) async throws -> String {
        if payload.validationError != nil { throw AccountError.local("invalid_request") }
        let result: FeedbackReceipt = try await request("POST", "feedback", token: token, encodedBody: JSONEncoder().encode(payload))
        return result.id
    }

    private struct FeedbackReceipt: Decodable { let ok: Bool; let id: String }

    private func request<T: Decodable>(_ method: String, _ path: String, token: String? = nil, body: [String: String]? = nil, encodedBody: Data? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/" + path), timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let data = try encodedBody ?? body.map({ try JSONEncoder().encode($0) }) {
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw AccountError.local("network")
        }
        guard let http = response as? HTTPURLResponse else { throw AccountError.local("network") }
        guard (200..<300).contains(http.statusCode) else {
            var error = (try? JSONDecoder().decode(ErrorBody.self, from: data).error)
                ?? AccountError(code: http.statusCode == 401 ? "unauthorized" : "internal_error", message: "", retryAfter: Int(http.value(forHTTPHeaderField: "Retry-After") ?? ""))
            error.statusCode = http.statusCode
            throw error
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw AccountError.local("invalid_response") }
    }

    private struct ErrorBody: Decodable { let error: AccountError }
    private struct Acknowledgement: Decodable { let ok: Bool }
    private struct DeviceList: Decodable { let devices: [AccountDevice] }
    private struct Ticket: Decodable { let ticket: String }
}
