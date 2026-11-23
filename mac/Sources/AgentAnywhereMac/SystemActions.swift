import AppKit
import Observation
import ServiceManagement

@MainActor
@Observable
final class SystemActions {
    private(set) var loginEnabled = false
    private(set) var loginNeedsApproval = false
    private(set) var removingLoginItem = false
    var error: String?
    var notice: String?
    var isAppBundle: Bool { Bundle.main.bundleURL.pathExtension == "app" }

    init() { refreshLoginStatus() }

    func refreshLoginStatus() {
        guard isAppBundle else { return }
        loginEnabled = SMAppService.mainApp.status == .enabled
        loginNeedsApproval = SMAppService.mainApp.status == .requiresApproval
    }

    func setLoginEnabled(_ enabled: Bool) {
        error = nil
        do {
            if enabled { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        } catch { self.error = error.localizedDescription }
        refreshLoginStatus()
    }

    private func runtime() throws -> BridgeRuntime { try BridgeRuntime.locate() }

    /// Returns the shell command to run in Terminal to sign in or install an agent CLI.
    static func setupCommand(for kind: String, status: String) -> String? {
        switch (kind, status) {
        case ("claude", "needsLogin"): return "claude"
        case ("codex", "needsLogin"): return "codex login"
        case ("cursor", "needsLogin"): return "cursor-agent login"
        case ("cursor", "unavailable"): return "curl -fsSL https://cursor.com/install | bash && cursor-agent login"
        default: return nil
        }
    }

    func openAgentSetup(kind: String, status: String) {
        error = nil
        notice = nil
        if kind == "antigravity" {
            let appURL = URL(fileURLWithPath: "/Applications/Antigravity.app")
            if FileManager.default.fileExists(atPath: appURL.path) {
                NSWorkspace.shared.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
                notice = status == "needsLogin"
                    ? "Opened Antigravity. Sign in there, then click AgentTote again."
                    : "Opened Antigravity. Install the 'agy' command from its Command Palette."
                return
            }
        }
        guard let cmd = Self.setupCommand(for: kind, status: status) else { return }
        if Self.runInTerminal(cmd) {
            notice = "Opened Terminal to run `\(cmd)`."
        } else {
            copyText(cmd)
            notice = "Copied `\(cmd)` to clipboard — run it in Terminal."
        }
    }

    private static func runInTerminal(_ command: String) -> Bool {
        let escaped = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let source = "tell application \"Terminal\"\nactivate\ndo script \"\(escaped)\"\nend tell"
        var errorDict: NSDictionary?
        if let script = NSAppleScript(source: source) {
            _ = script.executeAndReturnError(&errorDict)
            if errorDict == nil { return true }
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        child.arguments = ["-e", source]
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        do {
            try child.run()
            child.waitUntilExit()
            return child.terminationStatus == 0
        } catch {
            return false
        }
    }
    func removeOldLoginItem() async {
        guard !removingLoginItem else { return }
        removingLoginItem = true
        error = nil
        notice = nil
        defer { removingLoginItem = false }
        do {
            let runtime = try runtime()
            let result = try await Self.runUtility(runtime: runtime, arguments: ["--uninstall-login-item"])
            if result == 0 { notice = "Removed the old bridge login item. You can retry the bridge now." }
            else { error = "Could not remove the old login item (exit \(result))." }
        } catch { self.error = error.localizedDescription }
    }

    private static func runUtility(runtime: BridgeRuntime, arguments: [String]) async throws -> Int32 {
        let child = Process()
        child.executableURL = runtime.node
        child.arguments = runtime.scriptArguments + arguments
        child.environment = ProcessInfo.processInfo.environment
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        return try await withCheckedThrowingContinuation { continuation in
            child.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do { try child.run() } catch { continuation.resume(throwing: error) }
        }
    }
}

@MainActor
func copyText(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
