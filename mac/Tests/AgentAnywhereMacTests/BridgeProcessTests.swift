import XCTest
import Darwin
@testable import AgentAnywhereMac

final class BridgeProcessTests: XCTestCase {
    func testPackagedRuntimeAndFontResolveWithoutDevelopmentEnvironment() throws {
        let app = FileManager.default.temporaryDirectory.appendingPathComponent("aa-package-\(UUID().uuidString).app")
        defer { try? FileManager.default.removeItem(at: app) }
        let resources = app.appendingPathComponent("Contents/Resources")
        let fontBundle = resources.appendingPathComponent("AgentAnywhere_AgentAnywhereMac.bundle")
        try FileManager.default.createDirectory(at: fontBundle, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: resources.appendingPathComponent("bridge"), withIntermediateDirectories: true)
        let plist: [String: Any] = ["CFBundleIdentifier": "com.test.aa", "CFBundlePackageType": "APPL", "CFBundleExecutable": "AgentAnywhere"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        let node = resources.appendingPathComponent("node"), script = resources.appendingPathComponent("bridge/bridge.mjs")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try Data().write(to: script)
        let font = fontBundle.appendingPathComponent("SpaceGrotesk.ttf")
        try Data().write(to: font)
        let bundle = try XCTUnwrap(Bundle(url: app))
        let runtime = try BridgeRuntime.locate(bundle: bundle, environment: [:])
        XCTAssertEqual(runtime.node.path, node.path)
        XCTAssertEqual(runtime.script.path, script.path)
        XCTAssertEqual(Brand.fontURL(in: bundle), font)
    }

    private func script(_ contents: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aa-mac-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let script = directory.appendingPathComponent("fake.sh")
        try contents.write(to: script, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return script
    }

    @MainActor
    private func waitUntil(seconds: Double = 3, _ condition: () -> Bool) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(seconds))
        while !condition() {
            guard ContinuousClock.now < end else { throw IPCFailure(code: "test_timeout", message: "Condition timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    func testRealPipeReadsRequestsAndShutdown() async throws {
        let file = try script("""
        test "$1" = '--ipc' || exit 9
        printf '%s' '{"event":"cli'
        printf '%s\\n' 'ents","data":{"count":3}}'
        printf '%s\\n' 'diagnostic' >&2
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
          case "$line" in
            *shutdown*) printf '{"id":%s,"result":null}\\n' "$id"; exit 0 ;;
            *hang*) : ;;
            *) printf '{"id":%s,"result":{"ok":true}}\\n' "$id" ;;
          esac
        done
        """)
        let bridge = BridgeProcess(runtime: BridgeRuntime(node: URL(fileURLWithPath: "/bin/sh"), script: file))
        var clients = 0
        var logs: [(String, String)] = []
        bridge.onEvent = { if case .clients(let value) = $0 { clients = value } }
        bridge.onLog = { logs.append(($0, $1)) }
        bridge.start()
        let pid = try XCTUnwrap(bridge.processID)
        try await waitUntil { clients == 3 && !logs.isEmpty }
        XCTAssertEqual(logs.first?.0, "diagnostic")
        XCTAssertEqual(logs.first?.1, "stderr")
        let result = try await bridge.request("status")
        XCTAssertEqual(result, .object(["ok": .bool(true)]))
        do { _ = try await bridge.request("hang", timeout: 0.02); XCTFail("Expected timeout") }
        catch let error as IPCFailure { XCTAssertEqual(error.code, "timeout") }
        let pending = Task { try await bridge.request("hang") }
        try await Task.sleep(for: .milliseconds(20))
        await bridge.stop()
        do { _ = try await pending.value; XCTFail("Expected failure on exit") }
        catch let error as IPCFailure { XCTAssertTrue(["exited", "stopped"].contains(error.code)) }
        XCTAssertNil(bridge.processID)
        XCTAssertEqual(kill(pid, 0), -1)
    }

    @MainActor
    func testWorkBuddyModelUsesIPCAndRefreshesConnectionWithoutLoggingKey() async throws {
        let file = try script("""
        while IFS= read -r line; do
          id=$(printf '%s' "$line" | /usr/bin/sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
          case "$line" in
            *workbuddy.setKey*)
              case "$line" in
                *test-workbuddy-key-123456*)
                  printf '%s\\n' '{"event":"agents","data":[{"kind":"workbuddy","name":"WorkBuddy","status":"ready","runningProcesses":0}]}'
                  printf '{"id":%s,"result":{"ok":true}}\\n' "$id" ;;
                *) printf '{"id":%s,"error":{"code":"invalid_key","message":"Authentication failed."}}\\n' "$id" ;;
              esac ;;
            *workbuddy.clearKey*)
              printf '%s\\n' '{"event":"agents","data":[{"kind":"workbuddy","name":"WorkBuddy","status":"needsLogin","runningProcesses":0,"detail":"Connect WorkBuddy in the AgentAnywhere app on your Mac."}]}'
              printf '{"id":%s,"result":{"ok":true}}\\n' "$id" ;;
            *shutdown*) printf '{"id":%s,"result":null}\\n' "$id"; exit 0 ;;
            *) exit 9 ;;
          esac
        done
        """)
        let bridge = BridgeProcess(runtime: BridgeRuntime(node: URL(fileURLWithPath: "/bin/sh"), script: file))
        let model = BridgeModel(bridge: bridge)
        model.start()
        try await model.connectWorkBuddy(apiKey: "test-workbuddy-key-123456")
        XCTAssertEqual(model.agents.first?.status, "ready")
        do {
            try await model.connectWorkBuddy(apiKey: "invalid-workbuddy-key-123456")
            XCTFail("Expected invalid key")
        } catch let error as IPCFailure { XCTAssertEqual(error.code, "invalid_key") }
        XCTAssertEqual(model.agents.first?.status, "ready")
        try await model.disconnectWorkBuddy()
        XCTAssertEqual(model.agents.first?.status, "needsLogin")
        XCTAssertEqual(model.agents.first?.detail, "Connect WorkBuddy in the AgentAnywhere app on your Mac.")
        XCTAssertTrue(model.logs.lines.isEmpty)
        await model.shutdown()
    }

    @MainActor
    func testPortConflictDoesNotRestart() async throws {
        let file = try script("""
        printf '%s\\n' '{"event":"fatal","data":{"code":"port_in_use","message":"Bridge port is already in use"}}'
        exit 2
        """)
        let bridge = BridgeProcess(runtime: BridgeRuntime(node: URL(fileURLWithPath: "/bin/sh"), script: file))
        var starts = 0
        var fatal: IPCFailure?
        bridge.onState = { if $0 == .starting { starts += 1 } }
        bridge.onEvent = { if case .fatal(let error) = $0 { fatal = error } }
        bridge.start()
        try await waitUntil { fatal != nil && bridge.processID == nil }
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertEqual(starts, 1)
        XCTAssertEqual(fatal?.code, "port_in_use")
        await bridge.restart()
        try await waitUntil { starts == 2 && bridge.processID == nil }
        await bridge.stop()
    }

    @MainActor
    func testUnexpectedExitRestartsAndExplicitStopCancelsRetry() async throws {
        let file = try script("exit 7\n")
        let bridge = BridgeProcess(runtime: BridgeRuntime(node: URL(fileURLWithPath: "/bin/sh"), script: file))
        var starts = 0
        bridge.onState = { if $0 == .starting { starts += 1 } }
        bridge.start()
        try await waitUntil { starts == 2 && bridge.processID == nil }
        await bridge.stop()
        try await Task.sleep(for: .milliseconds(2100))
        XCTAssertEqual(starts, 2)
    }

    @MainActor
    func testStubbornProcessIsKilled() async throws {
        let file = try script("""
        trap '' TERM
        while IFS= read -r line; do :; done
        """)
        let bridge = BridgeProcess(runtime: BridgeRuntime(node: URL(fileURLWithPath: "/bin/sh"), script: file))
        bridge.start()
        let pid = try XCTUnwrap(bridge.processID)
        try await Task.sleep(for: .milliseconds(50))
        let started = ContinuousClock.now
        await bridge.stop()
        XCTAssertGreaterThanOrEqual(started.duration(to: .now), .seconds(5))
        XCTAssertLessThan(started.duration(to: .now), .seconds(7))
        XCTAssertEqual(kill(pid, 0), -1)
    }

    @MainActor
    func testRuntimeArgumentsAndMissingRuntime() throws {
        let ts = BridgeRuntime(node: URL(fileURLWithPath: "/bin/sh"), script: URL(fileURLWithPath: "/tmp/bridge.ts"))
        XCTAssertEqual(ts.scriptArguments, ["--no-warnings", "/tmp/bridge.ts"])
        let file = try script("exit 0\n")
        let found = try BridgeRuntime.locate(environment: ["AA_BRIDGE_NODE": "/bin/sh", "AA_BRIDGE_SCRIPT": file.path])
        XCTAssertEqual(found.node.path, "/bin/sh")
        XCTAssertEqual(found.script, file)
        XCTAssertThrowsError(try BridgeRuntime.locate(environment: [:]))
    }
}
