import Foundation

/// The composer owns a bounded copy so Files and Photos can revoke their URLs as soon as import finishes.
struct TaskAttachment: Identifiable, Sendable {
    static let maxCount = 4
    static let maxBytes = 10 * 1024 * 1024
    let id = UUID()
    let name: String
    let bytes: Data

    enum Failure: String, LocalizedError {
        case tooMany = "Choose up to four attachments per message."
        case tooLarge = "Each attachment must be 10 MiB or smaller."
        case unreadablePhoto = "This photo could not be loaded. Try choosing it again."
        case invalidOffset = "The Mac acknowledged an unexpected upload offset. Send again to retry."
        case unsupported = "Update AgentTote on your Mac to send attachments."

        var errorDescription: String? { rawValue }
    }

    init(name: String, bytes: Data) throws {
        guard bytes.count <= Self.maxBytes else { throw Failure.tooLarge }
        self.name = name
        self.bytes = bytes
    }

    init(file url: URL) throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw CocoaError(.fileReadUnsupportedScheme) }
        if let size = values.fileSize, size > Self.maxBytes { throw Failure.tooLarge }

        let handle = try FileHandle(forReadingFrom: url)
        // Limit the actual read too, in case a provider returned a stale file size.
        var contents = Data()
        while let part = try handle.read(upToCount: Self.maxBytes + 1 - contents.count), !part.isEmpty {
            contents.append(part)
            guard contents.count <= Self.maxBytes else { throw Failure.tooLarge }
        }
        try handle.close()
        try self.init(name: url.lastPathComponent, bytes: contents)
    }

    static func importDocument(_ url: URL) async throws -> Self {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var result: Result<Self, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { coordinatedURL in
            result = Result { try Self(file: coordinatedURL) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw CocoaError(.fileReadUnknown) }
        return try result.get()
    }
}
