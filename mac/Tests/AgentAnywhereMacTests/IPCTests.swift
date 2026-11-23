import XCTest
@testable import AgentAnywhereMac

final class IPCTests: XCTestCase {
    @MainActor
    func testCursorAppearsInAgentStateAndCanBeDisabled() throws {
        let model = BridgeModel()
        let payload = Data(#"{"event":"agents","data":[{"kind":"cursor","name":"Cursor","status":"ready","runningProcesses":1,"enabled":false}]}"#.utf8)
        model.handle(try JSONDecoder().decode(IPCEvent.self, from: payload))
        XCTAssertEqual(model.agents.first?.kind, "cursor")
        XCTAssertEqual(model.disabledAgents, ["cursor"])
        XCTAssertEqual(Brand.agentName("cursor"), "Cursor")
        XCTAssertEqual(Brand.agentSymbol("cursor"), "cursorarrow")
        XCTAssertEqual(SystemActions.setupCommand(for: "claude", status: "needsLogin"), "claude")
        XCTAssertEqual(SystemActions.setupCommand(for: "codex", status: "needsLogin"), "codex login")
        XCTAssertEqual(SystemActions.setupCommand(for: "cursor", status: "needsLogin"), "cursor-agent login")
        XCTAssertEqual(SystemActions.setupCommand(for: "cursor", status: "unavailable"), "curl -fsSL https://cursor.com/install | bash && cursor-agent login")
        XCTAssertNil(SystemActions.setupCommand(for: "codex", status: "ready"))
    }

    func testAgentIconMetadataAndLegacyDecoding() throws {
        let modern = Data(#"{"kind":"codex","name":"ChatGPT","status":"ready","runningProcesses":0,"iconHash":"0123456789abcdef","iconPath":"/tmp/agent-icon.png"}"#.utf8)
        let info = try JSONDecoder().decode(AgentInfo.self, from: modern)
        XCTAssertEqual(info.kind, "codex")
        XCTAssertEqual(info.name, "ChatGPT")
        XCTAssertEqual(info.iconHash, "0123456789abcdef")
        XCTAssertEqual(info.iconPath, "/tmp/agent-icon.png")
        let legacy = Data(#"{"kind":"codex","name":"ChatGPT","status":"ready","runningProcesses":0}"#.utf8)
        let old = try JSONDecoder().decode(AgentInfo.self, from: legacy)
        XCTAssertNil(old.iconHash)
        XCTAssertNil(old.iconPath)
    }

    @MainActor
    func testAgentEnablementEventsAndSnapshot() throws {
        let model = BridgeModel()
        let event = try JSONDecoder().decode(IPCEvent.self, from: Data(#"{"event":"agents","data":[{"kind":"claude","name":"Claude Code","status":"unavailable","runningProcesses":0,"enabled":false},{"kind":"codex","name":"ChatGPT","status":"ready","runningProcesses":0,"enabled":true}]}"#.utf8))
        model.handle(event)
        XCTAssertEqual(model.agents.count, 2)
        XCTAssertEqual(model.agents.map(\.isEnabled), [false, true])
        XCTAssertEqual(model.disabledAgents, ["claude"])
        let json = String(Fixtures.snapshot.dropLast()) + #", "disabledAgents":["claude","workbuddy"]}"#
        let snapshot = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(json.utf8))
        model.handle(.ready(snapshot))
        XCTAssertEqual(model.disabledAgents, ["claude", "workbuddy"])
        model.handle(.ready(try JSONDecoder().decode(BridgeSnapshot.self, from: Data(Fixtures.snapshot.utf8))))
        XCTAssertEqual(model.disabledAgents, [])
        XCTAssertTrue(model.agents[0].isEnabled, "Older bridges default to enabled")
        let request = IPCRequest(id: 1, method: "config.set", params: ["disabledAgents": .array([.string("claude")])])
        let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
        XCTAssertEqual((value["params"] as? [String: [String]])?["disabledAgents"], ["claude"])
    }

    @MainActor
    func testKeepAwakeSnapshotAndEvents() throws {
        let model = BridgeModel()
        for mode in KeepAwakeMode.allCases {
            let json = String(Fixtures.snapshot.dropLast()) + ", \"keepAwake\":\"\(mode.rawValue)\", \"keepAwakeActive\":true}"
            let snapshot = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(json.utf8))
            model.handle(.ready(snapshot))
            XCTAssertEqual(model.keepAwake, mode)
            XCTAssertTrue(model.keepAwakeActive)
            let event = "{\"event\":\"keepAwake\",\"data\":{\"keepAwake\":\"\(mode.rawValue)\",\"active\":false}}"
            model.handle(try JSONDecoder().decode(IPCEvent.self, from: Data(event.utf8)))
            XCTAssertEqual(model.keepAwake, mode)
            XCTAssertFalse(model.keepAwakeActive)
        }
        model.handle(.ready(try JSONDecoder().decode(BridgeSnapshot.self, from: Data(Fixtures.snapshot.utf8))))
        XCTAssertEqual(model.keepAwake, .onPower)
        XCTAssertFalse(model.keepAwakeActive)
        XCTAssertThrowsError(try JSONDecoder().decode(IPCEvent.self, from: Data(#"{"event":"keepAwake","data":{"keepAwake":"invalid","active":true}}"#.utf8)))
    }

    func testWorkBuddyFormatAndClipboardDeduplication() {
        let key = "test-workbuddy-key-123456"
        XCTAssertEqual(WorkBuddyConnection.normalizedKey(" \(key)\n"), key)
        XCTAssertEqual(WorkBuddyConnection.normalizedKey(String(repeating: "x", count: 16)), String(repeating: "x", count: 16))
        XCTAssertNotNil(WorkBuddyConnection.normalizedKey(String(repeating: "x", count: 512)))
        for value in ["", "too-short", String(repeating: "x", count: 513), "12345678 12345678", "12345678\n12345678", "12345678\u{FEFF}12345678"] {
            XCTAssertNil(WorkBuddyConnection.normalizedKey(value))
        }
        var clipboard = WorkBuddyClipboard()
        XCTAssertEqual(clipboard.newKey(from: key), key)
        XCTAssertNil(clipboard.newKey(from: key))
        XCTAssertNil(clipboard.newKey(from: "short"))
        XCTAssertEqual(clipboard.newKey(from: key), key)
    }

    @MainActor
    func testWorkBuddyRequestsResponsesAndState() async throws {
        let requests = IPCRequests()
        let key = "test-workbuddy-key-123456"
        for method in ["workbuddy.setKey", "workbuddy.clearKey"] {
            let params: [String: JSONValue] = method == "workbuddy.setKey" ? ["apiKey": .string(key)] : [:]
            let result = try await requests.request(method: method, params: params) { request in
                let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
                XCTAssertEqual(encoded["method"] as? String, method)
                XCTAssertEqual((encoded["params"] as? [String: String])?["apiKey"], method == "workbuddy.setKey" ? key : nil)
                requests.receive(try JSONDecoder().decode(IPCResponse.self, from: Data("{\"id\":\(request.id),\"result\":{\"ok\":true}}".utf8)))
            }
            XCTAssertEqual(result, .object(["ok": .bool(true)]))
        }
        XCTAssertEqual(IPCRequests.timeout(for: "workbuddy.setKey"), 210)
        XCTAssertEqual(IPCRequests.timeout(for: "workbuddy.clearKey"), 15)
        let invalid = try JSONDecoder().decode(IPCResponse.self, from: Data(#"{"id":1,"error":{"code":"invalid_key","message":"Authentication failed."}}"#.utf8))
        XCTAssertEqual(invalid.error?.localizedDescription, "That key didn't work. Check that it was created for this account.")
        let failed = try JSONDecoder().decode(IPCResponse.self, from: Data(#"{"id":2,"error":{"code":"verify_failed","message":"Verification timed out."}}"#.utf8))
        XCTAssertEqual(failed.error?.localizedDescription, "Couldn't verify the key: Verification timed out.")
        let model = BridgeModel()
        for state in ["needsLogin", "ready", "needsLogin"] {
            let event = try JSONDecoder().decode(IPCEvent.self, from: Data("{\"event\":\"agents\",\"data\":[{\"kind\":\"workbuddy\",\"name\":\"WorkBuddy\",\"status\":\"\(state)\",\"runningProcesses\":0,\"detail\":\"Connect WorkBuddy in the AgentAnywhere app on your Mac.\"}]}".utf8))
            model.handle(event)
            XCTAssertEqual(model.agents.first?.status, state)
            XCTAssertEqual(model.agents.first?.detail, "Connect WorkBuddy in the AgentAnywhere app on your Mac.")
        }
    }

    @MainActor
    func testRelayEventAndStatus() throws {
        let model = BridgeModel()
        for state in ["off", "connecting", "online", "error"] {
            let data = Data("{\"event\":\"relay\",\"data\":{\"state\":\"\(state)\",\"channels\":1}}".utf8)
            let event = try JSONDecoder().decode(IPCEvent.self, from: data)
            model.handle(event)
            XCTAssertEqual(model.relay.state.rawValue, state)
            XCTAssertEqual(model.relay.channels, 1)
        }
        let snapshotJSON = String(Fixtures.snapshot.dropLast()) + #", "relay":{"state":"online","channels":1}}"#
        let snapshot = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(snapshotJSON.utf8))
        XCTAssertEqual(snapshot.relay?.label, "Relay: Online · 1 phone")
        model.handle(.ready(snapshot))
        XCTAssertEqual(model.relay, snapshot.relay)
        let old = try JSONDecoder().decode(BridgeSnapshot.self, from: Data(Fixtures.snapshot.utf8))
        model.handle(.ready(old))
        XCTAssertEqual(model.relay, .off)
        XCTAssertThrowsError(try JSONDecoder().decode(IPCEvent.self,
            from: Data(#"{"event":"relay","data":{"state":"invalid","channels":0}}"#.utf8)))
    }

    @MainActor
    func testNetworkEventRefreshesPairingWithoutChangingOtherState() throws {
        let model = BridgeModel()
        let ready = try JSONDecoder().decode(IPCEvent.self, from: Data("{\"event\":\"ready\",\"data\":\(Fixtures.snapshot)}".utf8))
        model.handle(ready)
        let json = #"{"event":"network","data":{"hosts":[{"address":"192.0.2.20","kind":"lan"},{"address":"100.64.1.2","kind":"tailscale"}],"pairingUrl":"agentanywhere://pair?hosts=192.0.2.20,100.64.1.2&token=new-secret"}}"#
        let event = try JSONDecoder().decode(IPCEvent.self, from: Data(json.utf8))
        guard case .network(let network) = event else { return XCTFail("Missing network event") }
        XCTAssertEqual(network.hosts.map(\.address), ["192.0.2.20", "100.64.1.2"])
        model.handle(event)
        XCTAssertEqual(model.hosts, network.hosts)
        XCTAssertEqual(model.pairingUrl, network.pairingUrl)
        XCTAssertEqual(model.state, .running)
        XCTAssertEqual(model.clients, 2)
        XCTAssertEqual(model.name, "Test Mac")
        model.appendLog("test-token new-secret", source: "bridge")
        XCTAssertEqual(model.logs.lines.last?.message, "[redacted] [redacted]")
        XCTAssertThrowsError(try JSONDecoder().decode(IPCEvent.self, from: Data(#"{"event":"network","data":{"hosts":[]}}"#.utf8)))
    }

    func testLineSplitting() throws {
        var lines = NDJSONLines()
        XCTAssertEqual(lines.append(Data("{\"event\":\"cli".utf8)), [])
        let result = lines.append(Data("ents\",\"data\":{\"count\":2}}\n\n \t\r\nnot json\n{\"id\":1}\nunfinished".utf8))
        XCTAssertEqual(result.count, 3)
        let event = try JSONDecoder().decode(IPCEvent.self, from: result[0])
        guard case .clients(2) = event else { return XCTFail("Wrong event") }
        XCTAssertThrowsError(try JSONDecoder().decode(IPCEvent.self, from: result[1]))
        XCTAssertEqual(String(decoding: lines.finish().first ?? Data(), as: UTF8.self), "unfinished")
        XCTAssertTrue(lines.finish().isEmpty)
    }

    func testUTF8Split() {
        var lines = NDJSONLines()
        let data = Data("你好\nfirst\r\nsecond\n".utf8)
        XCTAssertTrue(lines.append(Data(data.prefix(2))).isEmpty)
        XCTAssertEqual(lines.append(Data(data.dropFirst(2))).map { String(decoding: $0, as: UTF8.self) }, ["你好", "first\r", "second"])
    }

    func testEventsDecodeAgainstBridgeSchema() throws {
        let samples = [
            "{\"event\":\"ready\",\"data\":\(Fixtures.snapshot)}",
            #"{"event":"clients","data":{"count":4}}"#,
            #"{"event":"agents","data":[{"kind":"workbuddy","name":"WorkBuddy","status":"needsLogin","runningProcesses":0,"detail":"Sign in"}]}"#,
            #"{"event":"account","data":{"user":{"id":"u","email":"a@example.test"},"serverUrl":"https://account.test","state":"online"}}"#,
            #"{"event":"log","data":{"time":"2026-10-13T01:02:03.123Z","message":"OK"}}"#,
            #"{"event":"fatal","data":{"code":"port_in_use","message":"Busy"}}"#,
            #"{"event":"future","data":null}"#
        ]
        let events = try samples.map { try JSONDecoder().decode(IPCEvent.self, from: Data($0.utf8)) }
        guard case .ready(let snapshot) = events[0] else { return XCTFail("Missing ready") }
        XCTAssertEqual(snapshot.hosts.first?.kind, "lan")
        XCTAssertEqual(snapshot.port, 8787)
        guard case .agents(let agents) = events[2] else { return XCTFail("Missing agents") }
        XCTAssertEqual(agents.first?.statusLabel, "Needs sign-in")
        guard case .account(let account) = events[3] else { return XCTFail("Missing account") }
        XCTAssertEqual(account.user?.identity, "a@example.test")
        guard case .fatal(let error) = events[5] else { return XCTFail("Missing fatal") }
        XCTAssertEqual(error.code, "port_in_use")
        guard case .unknown = events[6] else { return XCTFail("Unknown event should be ignored") }
    }

    @MainActor
    func testPasswordRequestsAndErrorDecoding() throws {
        for method in ["account.login", "account.register", "account.resetPassword"] {
            let request = IPCRequest(id: 1, method: method, params: ["email": .string("user@example.com"), "code": .string("123456"), "password": .string("  password  ")])
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
            XCTAssertEqual(object["method"] as? String, method)
            XCTAssertEqual((object["params"] as? [String: String])?["password"], "  password  ")
            XCTAssertEqual((object["params"] as? [String: String])?["email"], "user@example.com")
            XCTAssertEqual((object["params"] as? [String: String])?["code"], "123456")
            XCTAssertNil((object["params"] as? [String: String])?["phone"])
            XCTAssertEqual(IPCRequests.timeout(for: method), 30)
        }
        for (code, message) in [
            ("invalid_credentials", "Wrong email or password."),
            ("email_taken", "This email already has an account. Sign in instead."),
            ("phone_login_disabled", "Phone sign-in is disabled. Use your bound email."),
            ("invalid_code", "That code is wrong or has expired."),
            ("weak_password", "Use at least 8 characters."),
            ("rate_limited", "Too many attempts. Try again in 17 s.")
        ] {
            let data = Data("{\"id\":1,\"error\":{\"code\":\"\(code)\",\"message\":\"hidden\",\"retryAfter\":17}}".utf8)
            let response = try JSONDecoder().decode(IPCResponse.self, from: data)
            XCTAssertEqual(response.error?.localizedDescription, message)
        }
        let profile = try JSONDecoder().decode(AccountStatus.self, from: Data(#"{"user":{"id":"phone-user","phone":"+8613800000000","hasPassword":true},"serverUrl":"https://account.test","state":"online"}"#.utf8))
        XCTAssertEqual(profile.user?.identity, "+8613800000000")
    }

    func testBackoff() {
        var backoff = RestartBackoff()
        XCTAssertEqual((0..<7).map { _ in backoff.next() }, [1, 2, 5, 10, 30, 30, 30])
        backoff.reset()
        XCTAssertEqual(backoff.next(), 1)
    }

    func testLogRingAndRedaction() {
        var buffer = LogBuffer()
        for i in 0..<1005 { buffer.append(LogLine(time: .distantPast, source: "stderr", message: "\(i)")) }
        XCTAssertEqual(buffer.lines.count, 1000)
        XCTAssertEqual(buffer.lines.first?.message, "5")
        XCTAssertEqual(buffer.lines.last?.source, "stderr")
        buffer.clear()
        XCTAssertTrue(buffer.lines.isEmpty)
        var redactor = LogRedactor()
        redactor.remember(pairingURL: "agentanywhere://pair?token=old-secret")
        redactor.remember(pairingURL: "agentanywhere://pair?token=new-secret")
        let safe = redactor.redact("old-secret new-secret agentanywhere://pair?token=future token=unknown")
        for token in ["old-secret", "new-secret", "future", "unknown", "agentanywhere://pair"] { XCTAssertFalse(safe.contains(token)) }
    }

    func testCommandErrorsAndIdentityNormalization() {
        XCTAssertEqual(IPCFailure(code: "network", message: "hidden").localizedDescription, "Can't reach the account server")
        for code in ["invalid_code", "code_expired", "too_many_attempts"] {
            XCTAssertEqual(IPCFailure(code: code, message: "hidden").localizedDescription, "That code is wrong or has expired.")
        }
        XCTAssertEqual(IdentityChannel.allCases, [.email])
        XCTAssertEqual(IdentityChannel.email.normalized(" A@Example.test "), "a@example.test")
    }

    @MainActor
    func testRequestMatchingErrorsAndNull() async throws {
        let requests = IPCRequests()
        var sent: [IPCRequest] = []
        let first = Task { try await requests.request(method: "first") { sent.append($0) } }
        let second = Task { try await requests.request(method: "second") { sent.append($0) } }
        while sent.count < 2 { await Task.yield() }
        XCTAssertEqual(sent.map(\.id), [1, 2])
        requests.receive(IPCResponse(id: 99, result: .string("unknown"), error: nil))
        requests.receive(IPCResponse(id: 2, result: .null, error: nil))
        requests.receive(IPCResponse(id: 1, result: .string("first"), error: nil))
        let firstValue = try await first.value
        let secondValue = try await second.value
        XCTAssertEqual(firstValue, .string("first"))
        XCTAssertEqual(secondValue, .null)
        XCTAssertEqual(requests.count, 0)
        do {
            _ = try await requests.request(method: "error") { request in
                requests.receive(IPCResponse(id: request.id, result: nil, error: IPCFailure(code: "rate_limited", message: "Retry", retryAfter: 17)))
            }
            XCTFail("Expected error")
        } catch let error as IPCFailure { XCTAssertEqual(error.retryAfter, 17) }
    }

    @MainActor
    func testTimeoutCancellationAndExit() async throws {
        let requests = IPCRequests()
        XCTAssertEqual(IPCRequests.timeout(for: "status"), 15)
        XCTAssertEqual(IPCRequests.timeout(for: "account.resetPassword"), 30)
        do {
            _ = try await requests.request(method: "timeout", timeout: 0.01) { _ in }
            XCTFail("Expected timeout")
        } catch let error as IPCFailure { XCTAssertEqual(error.code, "timeout") }
        XCTAssertEqual(requests.count, 0)
        let cancelled = Task { try await requests.request(method: "cancel") { _ in } }
        while requests.count == 0 { await Task.yield() }
        cancelled.cancel()
        do { _ = try await cancelled.value; XCTFail("Expected cancellation") } catch is CancellationError { }
        let stopped = Task { try await requests.request(method: "stop") { _ in } }
        while requests.count == 0 { await Task.yield() }
        requests.failAll(IPCFailure(code: "exited", message: "Exit"))
        do { _ = try await stopped.value; XCTFail("Expected exit") }
        catch let error as IPCFailure { XCTAssertEqual(error.code, "exited") }
        XCTAssertEqual(requests.count, 0)
    }

    @MainActor
    func testModelFullRefreshAndFatal() throws {
        let model = BridgeModel()
        let ready = try JSONDecoder().decode(IPCEvent.self, from: Data("{\"event\":\"ready\",\"data\":\(Fixtures.snapshot)}".utf8))
        model.handle(ready)
        XCTAssertEqual(model.state, .running)
        XCTAssertEqual(model.clients, 2)
        model.handle(.clients(9))
        XCTAssertEqual(model.clients, 9)
        model.appendLog("test-token", source: "stderr")
        XCTAssertEqual(model.logs.lines.last?.message, "[redacted]")
        model.handle(.fatal(IPCFailure(code: "port_in_use", message: "Busy")))
        XCTAssertEqual(model.fatalCode, "port_in_use")
        XCTAssertTrue(model.pairingUrl.isEmpty)
        XCTAssertEqual(model.clients, 0)
        model.handle(ready)
        XCTAssertNil(model.fatalCode)
        XCTAssertEqual(model.clients, 2)
    }
}

enum Fixtures {
    static let snapshot = #"{"version":"0.1.0","name":"Test Mac","port":8787,"deviceId":"test-device","pairingUrl":"agentanywhere://pair?name=Test&token=test-token&port=8787&hosts=127.0.0.1&device=test-device","hosts":[{"address":"127.0.0.1","kind":"lan"}],"clients":2,"agents":[{"kind":"claude","name":"Claude Code","status":"ready","version":"1","runningProcesses":0}],"account":{"user":null,"serverUrl":"http://localhost:8790","state":"signedOut"}}"#
}
