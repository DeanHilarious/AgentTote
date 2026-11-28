// Standalone macOS runner, compiled with the same networking sources as BridgeRecoveryTests,
// TaskAttachment.swift and TaskAttachmentUpload.swift, using -D AA_ATTACHMENT_UNIT_TESTS.
#if AA_ATTACHMENT_UNIT_TESTS
import Foundation

@main
@MainActor
private enum TaskAttachmentTestRunner {
    static func main() async throws {
        let client = BridgeClient()
        let transport = AttachmentTransport()
        _ = try await client.open(transport, helloTimeout: 1)
        defer { client.disconnect() }
        let binary = Data((0..<250_000).map { UInt8(truncatingIfNeeded: $0) })
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pdf")
        try binary.write(to: url)
        defer { try! FileManager.default.removeItem(at: url) }
        let document = try await TaskAttachment.importDocument(url)
        let empty = try TaskAttachment(name: "empty.txt", bytes: Data())
        let params = ["prompt": "Review"]
        var progress: [Double] = []
        let task = try await client.startTask(params, attachments: [document, empty]) { progress.append($0) }
        precondition(task.id == "task" && transport.startCount == 1)
        precondition(transport.idsAtStart == ["1", "2"] && transport.files == [binary, Data()])
        precondition(transport.names == [url.lastPathComponent, "empty.txt"])
        precondition(transport.offsets == [0, 192 * 1024] && progress.count == 2 && progress.last == 1)

        transport.badAck = true
        do {
            _ = try await client.startTask(params, attachments: [empty, document]) { _ in }
            preconditionFailure("An incorrect acknowledgement must prevent task submission")
        } catch TaskAttachment.Failure.invalidOffset {}
        precondition(transport.startCount == 1 && transport.discarded == ["3", "4"])

        _ = try await client.startTask(params, attachments: []) { _ in preconditionFailure() }
        precondition(transport.startCount == 2 && transport.idsAtStart == nil)
        do {
            _ = try await client.startTask(params, attachments: Array(repeating: empty, count: 5)) { _ in }
            preconditionFailure("Too many attachments")
        } catch TaskAttachment.Failure.tooMany {}
        precondition(transport.files.count == 4 && transport.startCount == 2)

        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(TaskAttachment.maxBytes + 1))
        try handle.close()
        do {
            _ = try await TaskAttachment.importDocument(url)
            preconditionFailure("Oversized picked file")
        } catch TaskAttachment.Failure.tooLarge {}
        print(
            "Attachment checks passed: coordinated import, exact binary bytes, chunk offsets, ordered IDs, empty files, cleanup on failed acknowledgement, legacy text-only start and limits."
        )
    }
}

@MainActor
private final class AttachmentTransport: BridgeTransport {
    var files: [Data] = []
    var names: [String] = []
    var offsets: [Int] = []
    var discarded: [String] = []
    var idsAtStart: [String]?
    var startCount = 0
    var badAck = false
    private var replies: [String] = []
    private var waiter: CheckedContinuation<String, Error>?

    func start() async throws {}
    func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void) {
        let request = try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        let params = request["params"] as! [String: Any]
        let result: [String: Any]
        switch request["method"] as! String {
        case "hello":
            result = ["name": "QA", "version": "test", "agents": [], "supportsAttachments": true]
        case "attachments.begin":
            files.append(Data())
            names.append(params["name"] as! String)
            result = ["id": String(files.count)]
        case "attachments.chunk":
            let index = Int(params["id"] as! String)! - 1
            let offset = params["offset"] as! Int
            precondition(offset == files[index].count)
            offsets.append(offset)
            files[index].append(Data(base64Encoded: params["data"] as! String)!)
            result = ["offset": files[index].count + (badAck ? 1 : 0)]
        case "attachments.discard":
            discarded.append(params["id"] as! String)
            result = [:]
        case "tasks.start":
            startCount += 1
            idsAtStart = params["attachmentIds"] as? [String]
            result = [
                "id": "task", "agent": "codex", "cwd": "/tmp", "prompt": "Review",
                "permissionMode": "readOnly", "status": "running", "startedAt": 1,
            ]
        default: preconditionFailure("Unexpected request")
        }
        let data = try! JSONSerialization.data(withJSONObject: ["id": request["id"]!, "result": result])
        let reply = String(decoding: data, as: UTF8.self)
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: reply)
        } else {
            replies.append(reply)
        }
        completion(nil)
    }

    func receive() async throws -> String {
        if !replies.isEmpty { return replies.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }

    func ping(completion: @escaping @Sendable (Error?) -> Void) { completion(nil) }
    func mappedError(_ error: Error) -> Error { error }
    func close() {
        waiter?.resume(throwing: URLError(.cancelled))
        waiter = nil
    }
}
#endif
