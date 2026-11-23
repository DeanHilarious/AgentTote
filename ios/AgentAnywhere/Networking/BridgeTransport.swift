import Foundation

@MainActor
protocol BridgeTransport: AnyObject {
    func start() async throws
    func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void)
    func receive() async throws -> String
    func ping(completion: @escaping @Sendable (Error?) -> Void)
    func close()
    func mappedError(_ error: Error) -> Error
}

@MainActor
class DirectTransport: BridgeTransport {
    let socket: URLSessionWebSocketTask

    init(session: URLSession, request: URLRequest) {
        socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 16 * 1024 * 1024
    }

    func start() async throws { socket.resume() }
    func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void) {
        socket.send(.string(text), completionHandler: completion)
    }
    func receive() async throws -> String {
        switch try await socket.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: throw BridgeClient.ClientError.notConnected
        }
    }
    func ping(completion: @escaping @Sendable (Error?) -> Void) { socket.sendPing(pongReceiveHandler: completion) }
    func close() { socket.cancel(with: .goingAway, reason: nil) }
    func mappedError(_ error: Error) -> Error {
        (socket.response as? HTTPURLResponse)?.statusCode == 401 ? BridgeClient.ClientError.unauthorized : error
    }
}

@MainActor
final class RelayTransport: DirectTransport {
    private let crypto: RelayCrypto
    private let ticket: String
    private static let rejected = BridgeClient.RemoteError(message: "The Mac rejected the relay connection.")

    init(session: URLSession, server: String, deviceId: UUID, publicKey: String, accessToken: String, ticket: String) throws {
        guard var url = URLComponents(string: server), ["http", "https"].contains(url.scheme), url.host != nil else {
            throw BridgeClient.ClientError.badAddress(server)
        }
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        url.path = "/v1/relay/phone"
        url.queryItems = [URLQueryItem(name: "device", value: deviceId.uuidString.lowercased())]
        url.fragment = nil
        guard let address = url.url else { throw BridgeClient.ClientError.badAddress(server) }
        var request = URLRequest(url: address, timeoutInterval: 10)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        crypto = try RelayCrypto(deviceId: deviceId, publicKey: publicKey)
        self.ticket = ticket
        super.init(session: session, request: request)
        socket.maximumMessageSize = 1024 * 1024
    }

    override func start() async throws {
        socket.resume()
        // Closing the socket bounds all handshake awaits, including a silent peer.
        let deadline = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            self.close()
        }
        defer { deadline.cancel() }
        do {
            try await socket.send(.data(crypto.message1))
            try crypto.accept(try await binary())
            let auth = try JSONSerialization.data(withJSONObject: ["auth": ticket])
            try await socket.send(.data(crypto.seal(String(decoding: auth, as: UTF8.self))))
            let reply: String
            do { reply = try crypto.open(try await binary()) }
            catch {
                if socket.closeCode.rawValue == 4404 { throw mappedError(error) }
                throw Self.rejected
            }
            guard let object = try? JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: String], object == ["auth": "ok"] else {
                throw Self.rejected
            }
        } catch { throw mappedError(error) }
    }
    private func binary() async throws -> Data {
        guard case .data(let bytes) = try await socket.receive() else { throw RelayCrypto.Failure.invalidMessage }
        return bytes
    }
    override func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void) {
        do { socket.send(.data(try crypto.seal(text)), completionHandler: completion) }
        catch { completion(error) }
    }
    override func receive() async throws -> String { try crypto.open(try await binary()) }
    override func mappedError(_ error: Error) -> Error {
        if socket.closeCode.rawValue == 4404 {
            return BridgeClient.ClientError.bridgeOffline
        }
        if (socket.response as? HTTPURLResponse)?.statusCode == 401 {
            return AccountError.local("unauthorized")
        }
        return error
    }
}
