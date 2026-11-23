import OSLog
import UserNotifications

/// Stages and error types only; never log payloads, keys or decrypted text.
private let log = Logger(subsystem: "com.deanhilarious.agentanywhere", category: "push")

final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        log.notice("Push received")
        lock.lock()
        handler = contentHandler
        original = request.content
        lock.unlock()
        guard let encrypted = request.content.userInfo["aa"] as? String,
              let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            log.error("Push without encrypted content")
            finish(request.content)
            return
        }
        let plain: PushPlaintext
        do {
            plain = try PushCrypto.decrypt(encrypted)
        } catch {
            log.error("Push decryption failed: \(String(describing: error), privacy: .public)")
            finish(request.content)
            return
        }
        content.title = plain.notificationTitle
        content.subtitle = plain.title
        content.body = plain.notificationBody
        content.threadIdentifier = plain.deviceId
        content.userInfo.removeValue(forKey: "sessionId")
        content.userInfo.merge(plain.destination.userInfo) { _, new in new }
        finish(content)
    }

    override func serviceExtensionTimeWillExpire() {
        lock.lock()
        let fallback = original
        lock.unlock()
        if let fallback { finish(fallback) }
    }

    private func finish(_ content: UNNotificationContent) {
        lock.lock()
        let callback = handler
        handler = nil
        lock.unlock()
        callback?(content)
    }
}
