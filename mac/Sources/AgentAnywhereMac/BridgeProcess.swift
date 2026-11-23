import Foundation
import Darwin

struct BridgeRuntime: Equatable {
    let node: URL
    let script: URL

    var scriptArguments: [String] {
        (script.pathExtension == "ts" ? ["--no-warnings"] : []) + [script.path]
    }

    static func locate(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) throws -> BridgeRuntime {
        let resources = bundle.resourceURL
        let bundledNode = resources?.appendingPathComponent("node")
        let bundledScript = resources?.appendingPathComponent("bridge/bridge.mjs")
        let fm = FileManager.default
        func nodeExists(_ url: URL?) -> Bool { url.map { fm.isExecutableFile(atPath: $0.path) } ?? false }
        func scriptExists(_ url: URL?) -> Bool { url.map { fm.isReadableFile(atPath: $0.path) } ?? false }
        let node = nodeExists(bundledNode) ? bundledNode : environment["AA_BRIDGE_NODE"].map { URL(fileURLWithPath: $0) }
        let script = scriptExists(bundledScript) ? bundledScript : environment["AA_BRIDGE_SCRIPT"].map { URL(fileURLWithPath: $0) }
        guard nodeExists(node), scriptExists(script), let node, let script else {
            throw IPCFailure(code: "missing_runtime", message: "Bridge runtime not found. Use an app with bundled node and bridge/bridge.mjs, or set AA_BRIDGE_NODE and AA_BRIDGE_SCRIPT to valid paths.")
        }
        return BridgeRuntime(node: node, script: script)
    }
}

enum BridgeRunState: Equatable {
    case starting, running, stopped, failed(String)
    var label: String {
        switch self {
        case .starting: "Starting bridge…"
        case .running: "Bridge running"
        case .stopped: "Bridge stopped"
        case .failed(let message): message
        }
    }
}

@MainActor
final class BridgeProcess {
    var onEvent: ((IPCEvent) -> Void)?
    var onState: ((BridgeRunState) -> Void)?
    var onLog: ((String, String) -> Void)?
    private(set) var runtime: BridgeRuntime?
    private(set) var processID: Int32?
    private let environment: [String: String]
    private let providedRuntime: BridgeRuntime?
    private var process: Process?
    private var input: FileHandle?
    private let requests = IPCRequests()
    private var stdoutLines = NDJSONLines()
    private var stderrLines = NDJSONLines()
    private var stdoutEnded = false
    private var stderrEnded = false
    private var exitStatus: Int32?
    private var generation = 0
    private var wantsRunning = false
    private var fatal: IPCFailure?
    private var backoff = RestartBackoff()
    private var restartTask: Task<Void, Never>?
    private var stableTask: Task<Void, Never>?
    private var stopTask: Task<Void, Never>?
    private var drainTask: Task<Void, Never>?

    init(runtime: BridgeRuntime? = nil, environment: [String: String] = ProcessInfo.processInfo.environment) {
        providedRuntime = runtime
        self.environment = environment
    }

    func start() {
        guard process == nil, stopTask == nil else { return }
        restartTask?.cancel()
        restartTask = nil
        wantsRunning = true
        fatal = nil
        onState?(.starting)
        do {
            let runtime = try providedRuntime ?? BridgeRuntime.locate(environment: environment)
            self.runtime = runtime
            let child = Process()
            let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
            child.executableURL = runtime.node
            child.arguments = runtime.scriptArguments + ["--ipc"]
            child.environment = environment
            child.standardInput = stdin
            child.standardOutput = stdout
            child.standardError = stderr
            generation += 1
            let epoch = generation
            stdoutLines = NDJSONLines()
            stderrLines = NDJSONLines()
            stdoutEnded = false
            stderrEnded = false
            exitStatus = nil
            child.terminationHandler = { [weak self] child in
                let status = child.terminationStatus
                DispatchQueue.main.async {
                    guard let self, self.generation == epoch else { return }
                    self.exitStatus = status
                    self.finishExitIfDrained()
                    if self.process != nil {
                        self.drainTask = Task { [weak self] in
                            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                            guard let self, self.generation == epoch else { return }
                            // A descendant may keep a pipe open after the bridge exits.
                            self.stdoutEnded = true
                            self.stderrEnded = true
                            self.finishExitIfDrained()
                        }
                    }
                }
            }
            try child.run()
            process = child
            processID = child.processIdentifier
            input = stdin.fileHandleForWriting
            try? stdin.fileHandleForReading.close()
            try? stdout.fileHandleForWriting.close()
            try? stderr.fileHandleForWriting.close()
            read(stdout.fileHandleForReading, source: "stdout", epoch: epoch)
            read(stderr.fileHandleForReading, source: "stderr", epoch: epoch)
        } catch {
            wantsRunning = false
            onState?(.failed(error.localizedDescription))
        }
    }

    private func read(_ handle: FileHandle, source: String, epoch: Int) {
        DispatchQueue(label: "AgentAnywhere.\(source).\(epoch)").async { [weak self] in
            defer { try? handle.close() }
            var bytes = [UInt8](repeating: 0, count: 16_384)
            while true {
                let count = Darwin.read(handle.fileDescriptor, &bytes, bytes.count)
                if count < 0 && errno == EINTR { continue }
                let data = count > 0 ? Data(bytes.prefix(count)) : Data()
                DispatchQueue.main.async {
                    guard let self, self.generation == epoch else { return }
                    self.receive(data, source: source)
                }
                if data.isEmpty { return }
            }
        }
    }

    private func receive(_ data: Data, source: String) {
        if source == "stderr" {
            let lines = data.isEmpty ? stderrLines.finish() : stderrLines.append(data)
            for line in lines { onLog?(String(decoding: line, as: UTF8.self), "stderr") }
            if data.isEmpty { stderrEnded = true }
        } else {
            let lines = data.isEmpty ? stdoutLines.finish() : stdoutLines.append(data)
            for line in lines {
                if let event = try? JSONDecoder().decode(IPCEvent.self, from: line) {
                    if case .fatal(let reason) = event {
                        fatal = reason
                        if reason.code == "port_in_use" { wantsRunning = false }
                        onState?(.failed(reason.message))
                    }
                    if case .ready = event {
                        onState?(.running)
                        stableTask?.cancel()
                        stableTask = Task { [weak self] in
                            do { try await Task.sleep(for: .seconds(60)) } catch { return }
                            self?.backoff.reset()
                        }
                    }
                    onEvent?(event)
                } else if let response = try? JSONDecoder().decode(IPCResponse.self, from: line) {
                    requests.receive(response)
                } else {
                    // Never echo protocol text: a malformed ready line may contain pairing secrets.
                    onLog?("Ignored an invalid IPC line.", "app")
                }
            }
            if data.isEmpty { stdoutEnded = true }
        }
        finishExitIfDrained()
    }

    private func finishExitIfDrained() {
        guard let status = exitStatus, stdoutEnded, stderrEnded else { return }
        drainTask?.cancel()
        drainTask = nil
        generation += 1
        stableTask?.cancel()
        stableTask = nil
        requests.failAll(IPCFailure(code: "exited", message: "Bridge process exited (\(status))."))
        try? input?.close()
        input = nil
        process = nil
        processID = nil
        exitStatus = nil
        if !wantsRunning {
            if fatal == nil { onState?(.stopped) }
            return
        }
        let delay = backoff.next()
        onState?(.failed(fatal?.message ?? "Bridge exited (\(status)). Retrying in \(Int(delay)) s…"))
        onLog?("Bridge exited (\(status)); restarting in \(Int(delay)) s.", "app")
        restartTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            guard let self, self.wantsRunning else { return }
            self.start()
        }
    }

    func request(_ method: String, params: [String: JSONValue] = [:], timeout: TimeInterval? = nil) async throws -> JSONValue {
        guard let child = process, child.isRunning, let input else {
            throw IPCFailure(code: "not_running", message: "The bridge is not running.")
        }
        return try await requests.request(method: method, params: params, timeout: timeout) { request in
            var data = try JSONEncoder().encode(request)
            data.append(10)
            try input.write(contentsOf: data)
        }
    }

    func stop() async {
        if let stopTask { await stopTask.value; return }
        wantsRunning = false
        fatal = nil
        restartTask?.cancel()
        stableTask?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            guard let child = self.process else { self.onState?(.stopped); return }
            let shutdown = Task { _ = try? await self.request("shutdown", timeout: 3) }
            await self.waitForExit(child, seconds: 3)
            shutdown.cancel()
            if child.isRunning { child.terminate() }
            await self.waitForExit(child, seconds: 2)
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            // Closing stdin also covers early startup and the parent's normal teardown.
            try? self.input?.close()
            self.requests.failAll(IPCFailure(code: "stopped", message: "Bridge stopped."))
            while self.process != nil {
                try? await Task.sleep(for: .milliseconds(25))
            }
            self.onState?(.stopped)
        }
        stopTask = task
        await task.value
        stopTask = nil
    }

    private func waitForExit(_ child: Process, seconds: TimeInterval) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while child.isRunning && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    func restart(shouldStart: () -> Bool = { true }) async {
        await stop()
        backoff.reset()
        if shouldStart() { start() }
    }
}
