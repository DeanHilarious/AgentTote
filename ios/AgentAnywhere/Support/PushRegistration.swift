import UIKit
import UserNotifications
import Observation

@MainActor
@Observable
final class PushRegistration {
    static let shared = PushRegistration()
    static let autoWatchPreference = "notifyStartedTasks"
    private(set) var token: String?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var registrationFailed = false
    var visibleSession: PushDestination?
    @ObservationIgnored private var visibleSessionOwner: UUID?
    private(set) var pendingDestination: PushDestination?
    @ObservationIgnored var onToken: (() -> Void)?
    @ObservationIgnored var onOpen: (() -> Void)?
    @ObservationIgnored private var permissionRequest: Task<Bool, Never>?

    private init() {
        UserDefaults.standard.register(defaults: [Self.autoWatchPreference: true])
        if let data = UserDefaults.standard.data(forKey: "pendingPushDestination") {
            pendingDestination = try? JSONDecoder().decode(PushDestination.self, from: data)
        }
    }

    var installationId: String {
        if let saved = UserDefaults.standard.string(forKey: "pushInstallationId") { return saved }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "pushInstallationId")
        return id
    }

    var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    var isAuthorized: Bool { [.authorized, .provisional, .ephemeral].contains(authorization) }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        if isAuthorized { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// Called only by a task submission or bell action, never at launch.
    func requestWhenNeeded() async -> Bool {
        if let permissionRequest { return await permissionRequest.value }
        let request = Task { @MainActor in
            await self.refreshAuthorization()
            if self.authorization == .notDetermined {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                await self.refreshAuthorization()
            }
            // APNs completes asynchronously. Do not hold task submission indefinitely.
            if self.isAuthorized {
                for _ in 0..<50 {
                    if self.token != nil || self.registrationFailed || Task.isCancelled { break }
                    try? await Task.sleep(for: .milliseconds(100))
                }
            }
            return self.isAuthorized
        }
        permissionRequest = request
        let result = await request.value
        permissionRequest = nil
        return result
    }

    func registered(_ data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        registrationFailed = false
        onToken?()
    }

    func failedToRegister() { registrationFailed = true }

    func destination(from info: [AnyHashable: Any]) -> PushDestination? {
        if let route = PushDestination(userInfo: info) { return route }
        // Also handles a notification whose service extension could not run at delivery.
        guard let encrypted = info["aa"] as? String else { return nil }
        return try? PushCrypto.decrypt(encrypted).destination
    }

    func open(_ destination: PushDestination?) {
        pendingDestination = destination
        UserDefaults.standard.set(try? destination.map { try JSONEncoder().encode($0) }, forKey: "pendingPushDestination")
        onOpen?()
    }

    func consumeDestination() {
        pendingDestination = nil
        UserDefaults.standard.removeObject(forKey: "pendingPushDestination")
    }

    func setVisibleSession(_ destination: PushDestination?, owner: UUID) {
        visibleSession = destination
        visibleSessionOwner = owner
    }

    func clearVisibleSession(owner: UUID) {
        guard visibleSessionOwner == owner else { return }
        visibleSession = nil
        visibleSessionOwner = nil
    }
}

@MainActor
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task { await PushRegistration.shared.refreshAuthorization() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistration.shared.registered(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistration.shared.failedToRegister()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            let push = PushRegistration.shared
            push.open(push.destination(from: response.notification.request.content.userInfo))
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            let push = PushRegistration.shared
            let route = push.destination(from: notification.request.content.userInfo)
            completionHandler(route?.isSameSession(as: push.visibleSession) == true ? [] : [.banner, .sound, .list])
        }
    }
}
