import Foundation
import OSLog

extension BridgeClient {
    private struct Upload: Decodable { let id: String }
    private struct Chunk: Decodable { let offset: Int }
    private struct Discarded: Decodable {}

    /// Uploads and their consuming start RPC share this client even if the app reconnects to another Mac.
    func startTask(_ params: [String: Any?], attachments: [TaskAttachment], progress: (Double) -> Void) async throws
        -> TaskInfo
    {
        guard !attachments.isEmpty else { return try await call("tasks.start", params) }
        guard attachments.count <= TaskAttachment.maxCount else { throw TaskAttachment.Failure.tooMany }
        let totalBytes = attachments.reduce(0) { $0 + $1.bytes.count }
        var sentBytes = 0
        var ids: [String] = []
        do {
            for file in attachments {
                try Task.checkCancellation()
                let upload: Upload = try await call("attachments.begin", ["name": file.name, "size": file.bytes.count])
                ids.append(upload.id)
                var offset = 0
                while offset < file.bytes.count {
                    try Task.checkCancellation()
                    let end = min(offset + Self.attachmentChunkBytes, file.bytes.count)
                    let data = file.bytes.subdata(in: offset..<end).base64EncodedString()
                    let ack: Chunk = try await call(
                        "attachments.chunk", ["id": upload.id, "offset": offset, "data": data])
                    guard ack.offset == end else { throw TaskAttachment.Failure.invalidOffset }
                    sentBytes += end - offset
                    offset = end
                    progress(Double(sentBytes) / Double(totalBytes))
                }
            }
            try Task.checkCancellation()
            var start = params
            start["attachmentIds"] = ids
            return try await call("tasks.start", start)
        } catch {
            // A disconnected client has already released its unclaimed files on the bridge.
            for id in ids where isReady {
                do {
                    let _: Discarded = try await call("attachments.discard", ["id": id], timeout: 3)
                } catch {
                    Logger(subsystem: "com.deanhilarious.agentanywhere", category: "attachments")
                        .debug("Could not confirm attachment discard on this connection.")
                }
            }
            throw error
        }
    }

    // The relay's 1 MiB frame must hold the base64 chunk, JSON and transport framing.
    private static let attachmentChunkBytes = 192 * 1024
}
