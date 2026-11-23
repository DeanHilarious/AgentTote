// Standalone runner, disabled in the app. See docs/feedback.md for the compile command.
#if AA_FEEDBACK_UNIT_TESTS
import Foundation

private final class FeedbackHTTPMock: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var captured: [URLRequest] = []
    static var requests: [URLRequest] { lock.withLock { captured } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Self.lock.withLock { Self.captured.append(request) }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"ok":true,"id":"feedback-id"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@main
@MainActor
private enum FeedbackTestRunner {
    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw NSError(domain: "FeedbackTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func main() async throws {
        var payload = FeedbackPayload(kind: .agentRequest)
        try expect(payload.validationError != nil, "Requests need an agent")
        payload.otherAgent = "  "
        try expect(payload.validationError != nil, "Whitespace is not a name")
        payload.otherAgent = "New agent"
        try expect(payload.validationError == nil, "Other agent is sufficient")
        payload.otherAgent = String(repeating: "😀", count: 61)
        try expect(payload.validationError != nil, "Other agent bound")
        payload.otherAgent = ""
        payload.agents = ["copilot-cli"]
        try expect(payload.validationError == nil, "A candidate is sufficient")
        payload.message = String(repeating: "😀", count: 2000)
        try expect(payload.validationError == nil, "Unicode codepoint bound matches server")
        payload.message += "x"
        try expect(payload.validationError != nil, "Overlong message rejected")
        payload.message = ""
        for kind in [FeedbackKind.bug, .idea, .other] {
            var feedback = FeedbackPayload(kind: kind)
            try expect(feedback.validationError != nil, "Non-request feedback needs a message")
            feedback.message = "Details"
            try expect(feedback.validationError == nil, "Valid message")
        }
        payload.agents = ["codex"]
        try expect(payload.validationError != nil, "Unknown candidate rejected")
        payload.agents = Array(repeating: "copilot-cli", count: 11)
        try expect(payload.validationError != nil, "At most ten selections")
        payload.agents = ["copilot-cli", "gemini-cli"]
        let diagnostics = FeedbackDiagnostics(strings: [
            "appVersion": "1.0", "build": "42", "osVersion": "17", "deviceModel": "iPhone16,1",
            "bridgeVersion": "0.1", "locale": String(repeating: "x", count: 65),
            "token": "secret", "path": "/private", "phone": "123", "session": "content"
        ], enabledAgents: [.codex, .codex, .workbuddy, .cursor])
        payload.diagnostics = diagnostics
        payload.contactOk = true
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
        let encodedDiagnostics = object["diagnostics"] as! [String: Any]
        try expect(Set(encodedDiagnostics.keys) == Set(FeedbackDiagnostics.stringKeys + ["enabledAgents"]), "Diagnostics whitelist")
        try expect((encodedDiagnostics["locale"] as? String)?.count == 64, "Diagnostic strings capped")
        try expect((encodedDiagnostics["enabledAgents"] as? [String]) == ["codex", "workbuddy", "cursor"], "Enabled agents use protocol IDs")
        try expect(object["contactEmail"] == nil && object["contact_email"] == nil, "Client never sends an email address")
        try expect(object["kind"] as? String == "agent_request", "Wire kind")
        payload.diagnostics = nil
        let excluded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
        try expect(excluded["diagnostics"] == nil, "Diagnostics opt-out omits data")

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FeedbackHTTPMock.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let client = AccountClient(baseURL: URL(string: "https://feedback.invalid")!, session: session)
        let id = try await client.submitFeedback(payload)
        try expect(id == "feedback-id", "Receipt decoded")
        _ = try await client.submitFeedback(payload, token: "test-only-token")
        let requests = FeedbackHTTPMock.requests
        try expect(requests.count == 2, "Anonymous and authenticated requests")
        try expect(requests[0].url?.path == "/v1/feedback", "Uses account endpoint")
        try expect(requests[0].httpMethod == "POST", "Uses POST")
        try expect(requests[0].value(forHTTPHeaderField: "Authorization") == nil, "Anonymous has no bearer")
        try expect(requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer test-only-token", "Signed in uses bearer")
        payload.agents = []
        do { _ = try await client.submitFeedback(payload); throw NSError(domain: "MissingValidation", code: 1) }
        catch let error as AccountError { try expect(error.code == "invalid_request", "Invalid payload rejected before network") }
        print("Feedback checks passed: validation, Unicode bounds, whitelist, opt-out, contact privacy, anonymous/authenticated HTTP and receipt.")
    }
}
#endif
