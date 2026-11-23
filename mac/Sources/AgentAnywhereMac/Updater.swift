import AppKit
import Foundation
import Observation
import Security
import UserNotifications

/// Reject all redirects, including HTTPS redirects, so no request escapes the signed origin.
final class UpdateDownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let limit: Int64
    let progress: @Sendable (Double) -> Void
    init(limit: Int64, progress: @escaping @Sendable (Double) -> Void) {
        self.limit = limit
        self.progress = progress
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit { downloadTask.cancel() }
        progress(min(1, Double(totalBytesWritten) / Double(limit)))
    }
}

enum UpdateInstaller {
    static func teamID(at app: URL) throws -> String? {
        var code: SecStaticCode?
        let created = SecStaticCodeCreateWithPath(app as CFURL, [], &code)
        guard created == errSecSuccess, let code else { throw UpdateFailure("Cannot read the app's code signature (\(created)).") }
        var info: CFDictionary?
        let status = SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
        guard status == errSecSuccess, let values = info as? [String: Any] else {
            throw UpdateFailure("Cannot read the app's signing team (\(status)).")
        }
        if let flags = values[kSecCodeInfoFlags as String] as? UInt32, flags & 2 != 0 { return nil } // CS_ADHOC
        return values[kSecCodeInfoTeamIdentifier as String] as? String
    }

    static func ineligibility(at app: URL) -> String? {
        let resolved = app.resolvingSymlinksInPath()
        let values = try? resolved.resourceValues(forKeys: [.volumeIsReadOnlyKey])
        return UpdatePolicy.ineligibility(.init(teamID: try? teamID(at: resolved), appPath: resolved.path,
            readOnlyVolume: values?.volumeIsReadOnly ?? true,
            parentWritable: FileManager.default.isWritableFile(atPath: resolved.deletingLastPathComponent().path)))
    }

    static func run(_ executable: String, _ arguments: [String]) async throws -> String {
        try await Task.detached(priority: .utility) {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let output = String(decoding: data, as: UTF8.self)
            guard process.terminationStatus == 0 else {
                throw UpdateFailure("\(URL(fileURLWithPath: executable).lastPathComponent) failed (\(process.terminationStatus)): \(output.prefix(2000))")
            }
            return output
        }.value
    }

    static func validate(app: URL, current: Bundle, manifest: UpdateManifest) async throws {
        _ = try await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        guard let currentTeam = try teamID(at: current.bundleURL), !currentTeam.isEmpty,
              try teamID(at: app) == currentTeam else { throw UpdateFailure("The update's signing team does not match this app.") }
        // Read the plist directly: Bundle caches metadata for paths across repeated attempts.
        let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let identifier = current.bundleIdentifier, info["CFBundleIdentifier"] as? String == identifier,
              let version = info["CFBundleShortVersionString"] as? String,
              let build = info["CFBundleVersion"] as? String else {
            throw UpdateFailure("The update's bundle identifier or version metadata is invalid.")
        }
        let candidate = try UpdateVersion(version: version, build: build)
        let installed = try installedVersion(current)
        guard candidate == (try manifest.release), candidate > installed else {
            throw UpdateFailure("The update app is not the newer release described by the signed manifest.")
        }
        guard let minimum = info["LSMinimumSystemVersion"] as? String,
              try UpdateVersion(version: minimum, build: "0") <= systemVersion() else {
            throw UpdateFailure("The update app requires a newer version of macOS.")
        }
    }

    static func installedVersion(_ bundle: Bundle) throws -> UpdateVersion {
        // Pre-OTA builds used the dotted marketing version as CFBundleVersion.
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return try UpdateVersion(version: version, build: UpdateVersion.isDecimal(build) ? build : "0")
    }
    static func systemVersion() throws -> UpdateVersion {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return try UpdateVersion(version: "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", build: "0")
    }
}

@MainActor @Observable
final class Updater: NSObject, UNUserNotificationCenterDelegate {
    private(set) var available: UpdateManifest?
    private(set) var checking = false
    private(set) var installing = false
    private(set) var canCancel = false
    private(set) var progress: Double = 0
    private(set) var status: String?
    private(set) var failure: String?
    private(set) var fallbackReason: String?
    private(set) var enabled = false
    @ObservationIgnored private var schedule: Task<Void, Never>?
    @ObservationIgnored private var installation: Task<Void, Never>?
    @ObservationIgnored private var notifiedRelease: String?
    @ObservationIgnored private let bundle: Bundle
    @ObservationIgnored private let publicKey: String?
    @ObservationIgnored private let feed: URL?

    init(bundle: Bundle = .main) {
        self.bundle = bundle
        publicKey = bundle.object(forInfoDictionaryKey: "AAUpdatePublicKey") as? String
        feed = URL(string: bundle.object(forInfoDictionaryKey: "AAUpdateFeedURL") as? String ?? UpdatePolicy.defaultFeed)
        super.init()
        enabled = publicKey.flatMap { Data(base64Encoded: $0) }?.count == 32 && feed != nil
        fallbackReason = UpdateInstaller.ineligibility(at: bundle.bundleURL)
    }

    func start() {
        guard enabled, schedule == nil else { return }
        removeFinishedUpdates()
        UNUserNotificationCenter.current().delegate = self
        schedule = Task { [weak self] in
            do {
                try await Task.sleep(for: .seconds(10))
                while !Task.isCancelled {
                    await self?.check()
                    try await Task.sleep(for: .seconds(6 * 60 * 60))
                }
            } catch { /* App termination cancels the timer. */ }
        }
    }

    func stop() { schedule?.cancel(); installation?.cancel() }

    /// This app is running, so any earlier update has finished or been rolled back; drop its
    /// staging folder (which holds the previous app) rather than leaving a hidden copy beside it.
    private func removeFinishedUpdates() {
        let parent = bundle.bundleURL.resolvingSymlinksInPath().deletingLastPathComponent()
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: parent.path)) ?? [] where name.hasPrefix(".AgentAnywhere-update-") {
            try? fm.removeItem(at: parent.appendingPathComponent(name))
        }
    }

    func check() async {
        guard enabled, !checking, !installing, let publicKey, let feed else { return }
        checking = true
        failure = nil
        status = "Checking for updates…"
        defer { checking = false }
        do {
            let file = try await download(feed, limit: 1_048_576)
            defer { try? FileManager.default.removeItem(at: file) }
            let manifest = try UpdatePolicy.verifyManifest(Data(contentsOf: file), publicKey: publicKey, feed: feed)
            guard try manifest.release > UpdateInstaller.installedVersion(bundle) else {
                available = nil
                status = "You're up to date."
                return
            }
            available = manifest
            fallbackReason = UpdateInstaller.ineligibility(at: bundle.bundleURL)
            if try UpdateVersion(version: manifest.minimumSystemVersion, build: "0") > UpdateInstaller.systemVersion() {
                fallbackReason = "This update requires macOS \(manifest.minimumSystemVersion) or later."
            }
            status = nil
            await notify(manifest)
        } catch {
            status = nil
            failure = error.localizedDescription
        }
    }

    private func download(_ url: URL, limit: Int64, progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        guard let feed else { throw UpdateFailure("Invalid update feed URL.") }
        try UpdatePolicy.validateURL(url, feed: feed)
        let delegate = UpdateDownloadDelegate(limit: limit, progress: progress)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3600
        config.urlCache = nil
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (file, response) = try await session.download(from: url, delegate: delegate)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.url == url else {
            try? FileManager.default.removeItem(at: file)
            throw UpdateFailure("Update server returned an error or a redirect. Redirects are not allowed.")
        }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= limit else {
            try? FileManager.default.removeItem(at: file)
            throw UpdateFailure("Update response exceeds its allowed size.")
        }
        return file
    }

    func cancel() { if canCancel { installation?.cancel() } }
    func install(model: BridgeModel) {
        guard !installing, !checking, let manifest = available else { return }
        fallbackReason = UpdateInstaller.ineligibility(at: bundle.bundleURL)
        guard fallbackReason == nil else { return }
        installing = true
        canCancel = true
        failure = nil
        progress = 0
        installation = Task { [self] in
            let fm = FileManager.default
            var transaction: URL?
            var cache: URL?
            var handedOff = false
            var bridgeStopped = false
            defer {
                if !handedOff, let transaction { try? fm.removeItem(at: transaction) }
                if let cache { try? fm.removeItem(at: cache) }
                installing = false
                canCancel = false
                installation = nil
            }
            do {
                guard try UpdateVersion(version: manifest.minimumSystemVersion, build: "0") <= UpdateInstaller.systemVersion() else {
                    throw UpdateFailure("This update requires macOS \(manifest.minimumSystemVersion) or later.")
                }
                let base = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                    .appendingPathComponent(bundle.bundleIdentifier ?? "com.deanhilarious.agentanywhere.mac")
                    .appendingPathComponent("Updates")
                let work = base.appendingPathComponent(UUID().uuidString)
                try fm.createDirectory(at: work, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                cache = work
                status = "Downloading update…"
                let temporary = try await download(manifest.url, limit: manifest.size) { [weak self] value in
                    Task { @MainActor in self?.progress = value }
                }
                let zip = work.appendingPathComponent("update.zip")
                try fm.moveItem(at: temporary, to: zip)
                try Task.checkCancellation()
                status = "Verifying update…"
                let verification = Task.detached(priority: .utility) { try UpdatePolicy.verifyArchive(at: zip, manifest: manifest) }
                try await withTaskCancellationHandler { try await verification.value } onCancel: { verification.cancel() }
                let entries = try await UpdateInstaller.run("/usr/bin/zipinfo", ["-1", zip.path])
                try UpdatePolicy.validateArchivePaths(entries)
                let extracted = work.appendingPathComponent("extracted")
                _ = try await UpdateInstaller.run("/usr/bin/ditto", ["-x", "-k", zip.path, extracted.path])
                try Task.checkCancellation()
                let app = extracted.appendingPathComponent("AgentAnywhere.app")
                try await UpdateInstaller.validate(app: app, current: bundle, manifest: manifest)
                if let reason = UpdateInstaller.ineligibility(at: bundle.bundleURL) { throw UpdateFailure(reason) }
                // Stage on the destination filesystem, making both final renames atomic.
                let destination = bundle.bundleURL.resolvingSymlinksInPath()
                let stage = destination.deletingLastPathComponent().appendingPathComponent(".AgentAnywhere-update-\(UUID().uuidString)")
                try fm.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                transaction = stage
                let stagedApp = stage.appendingPathComponent("AgentAnywhere.app")
                _ = try await UpdateInstaller.run("/usr/bin/ditto", [app.path, stagedApp.path])
                try await UpdateInstaller.validate(app: stagedApp, current: bundle, manifest: manifest)
                guard let resource = Bundle.module.url(forResource: "install-update", withExtension: "sh") else {
                    throw UpdateFailure("The update installer resource is missing.")
                }
                let helper = stage.appendingPathComponent("install-update.sh")
                try fm.copyItem(at: resource, to: helper)
                try Task.checkCancellation()
                canCancel = false
                status = "Restarting…"
                await model.shutdown()
                bridgeStopped = true
                // All user-controlled paths are separate argv entries, never interpolated into shell code.
                _ = try await UpdateInstaller.run("/bin/sh", ["-c",
                    """
                    /usr/bin/nohup /bin/sh "$1" "$2" "$3" "$4" </dev/null >>"$5" 2>&1 &
                    helper_pid=$!
                    attempt=0
                    while [ ! -f "$4/ready" ]; do
                        kill -0 "$helper_pid" 2>/dev/null || exit 1
                        attempt=$((attempt + 1))
                        if [ "$attempt" -gt 10 ]; then kill "$helper_pid"; exit 1; fi
                        sleep 1
                    done
                    """,
                    "agentanywhere-update", helper.path, String(ProcessInfo.processInfo.processIdentifier),
                    destination.path, stage.path, base.appendingPathComponent("install.log").path])
                handedOff = true
                NSApp.terminate(nil)
            } catch {
                if bridgeStopped { model.resumeAfterFailedUpdate() }
                status = nil
                failure = Task.isCancelled ? "Update cancelled." : error.localizedDescription
            }
        }
    }

    private func notify(_ manifest: UpdateManifest) async {
        let release = "\(manifest.version)-\(manifest.build)"
        guard notifiedRelease != release else { return }
        do {
            let center = UNUserNotificationCenter.current()
            guard try await center.requestAuthorization(options: [.alert, .sound]) else { return }
            let content = UNMutableNotificationContent()
            content.title = "AgentTote v\(manifest.version) is available"
            content.body = String((manifest.notes ?? "Open AgentTote to update.").prefix(500))
            content.sound = .default
            try await center.add(UNNotificationRequest(identifier: "agentanywhere-update", content: content, trigger: nil))
            notifiedRelease = release
        } catch { /* Notification permission does not block updates. */ }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in NotificationCenter.default.post(name: .showMainWindow, object: nil) }
        completionHandler()
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
