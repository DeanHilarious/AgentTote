import Foundation
import Network
import Observation

@MainActor @Observable
final class LocalPreviewProxy {
    enum Source {
        case service(port: Int)
        case files(agent: AgentKind, cwd: String)
    }
    private(set) var origin: String?
    private(set) var failures: [String] = []
    private(set) var error: String?
    private(set) var token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private let client: BridgeClient
    private let source: Source
    @ObservationIgnored private var listener: NWListener?
    @ObservationIgnored private var connections: [UUID: NWConnection] = [:]
    @ObservationIgnored private var requests: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var deadlines: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var ready: CheckedContinuation<String, Error>?

    init(client: BridgeClient, source: Source) { self.client = client; self.source = source }

    func start() async throws -> String {
        if let origin { return origin }
        token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        error = nil
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        return try await withCheckedThrowingContinuation { continuation in
            ready = continuation
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                Task { @MainActor in
                    guard let self, let listener, self.listener === listener else { return }
                    switch state {
                    case .ready:
                        guard let port = listener.port else { self.fail("Unable to start local preview"); return }
                        let origin = "http://127.0.0.1:\(port.rawValue)"
                        self.origin = origin; self.ready?.resume(returning: origin); self.ready = nil
                    case .failed(let error): self.fail(error.localizedDescription)
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in self?.accept(connection) }
            }
            listener.start(queue: .main)
        }
    }
    func stop() {
        listener?.cancel(); listener = nil; origin = nil
        ready?.resume(throwing: CancellationError()); ready = nil
        for task in requests.values { task.cancel() }; requests.removeAll()
        for task in deadlines.values { task.cancel() }; deadlines.removeAll()
        for connection in connections.values { connection.cancel() }; connections.removeAll()
    }
    private func fail(_ message: String) { error = message; stop() }
    private func accept(_ connection: NWConnection) {
        guard listener != nil, connections.count < 32 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.start(queue: .main)
        deadlines[id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(40)) } catch { return }
            self?.finish(id)
        }
        receive(connection, id: id, data: Data())
    }
    private func finish(_ id: UUID) {
        deadlines.removeValue(forKey: id)?.cancel()
        requests.removeValue(forKey: id)?.cancel()
        connections.removeValue(forKey: id)?.cancel()
    }
    private func receive(_ connection: NWConnection, id: UUID, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] part, _, complete, error in
            Task { @MainActor in
                guard let self, self.connections[id] != nil else { return }
                var data = data
                if let part { data.append(part) }
                do {
                    if let request = try PreviewHTTP.parse(data) {
                        self.deadlines.removeValue(forKey: id)?.cancel()
                        self.requests[id] = Task { [weak self] in await self?.respond(request, connection: connection, id: id) }
                    } else if complete || error != nil { self.finish(id) }
                    else { self.receive(connection, id: id, data: data) }
                } catch { self.sendError(error.localizedDescription, status: 400, connection: connection, id: id) }
            }
        }
    }
    private func respond(_ request: PreviewHTTP.Request, connection: NWConnection, id: UUID) async {
        do {
            guard let origin, request.headers["host"] == String(origin.dropFirst("http://".count)) else {
                throw PreviewHTTP.Failure(message: "Invalid preview host")
            }
            if let caller = request.headers["origin"], caller != origin {
                throw PreviewHTTP.Failure(message: "Invalid preview origin")
            }
            let path = try PreviewHTTP.upstreamPath(request.target, token: token)
            var body: Data
            var headers: [String: [String]]
            let status: Int
            let targetPort: Int
            switch source {
            case .service(let port):
                targetPort = port
                var outbound = request.headers
                // Browser security headers must describe the upstream origin to dev servers.
                if outbound["origin"] != nil { outbound["origin"] = "http://localhost:\(port)" }
                if let referrer = outbound["referer"], referrer.hasPrefix(origin + "/" + token) {
                    outbound["referer"] = "http://localhost:\(port)" + referrer.dropFirst((origin + "/" + token).count)
                }
                outbound.removeValue(forKey: "host")
                var bodyId: String?
                if request.body.count > 512 * 1024 {
                    var offset = 0
                    while offset < request.body.count {
                        try Task.checkCancellation()
                        let end = min(request.body.count, offset + 512 * 1024)
                        let uploaded: PreviewUpload = try await client.call("preview.upload", ["bodyId": bodyId, "offset": offset, "data": request.body.subdata(in: offset..<end).base64EncodedString()])
                        guard uploaded.offset == end else { throw PreviewHTTP.Failure(message: "Incomplete upload") }
                        bodyId = uploaded.bodyId; offset = end
                    }
                }
                var chunk: PreviewChunk = try await client.call("preview.request", ["port": port, "method": request.method, "path": path,
                    "headers": outbound, "bodyId": bodyId, "body": request.body.isEmpty || bodyId != nil ? nil : request.body.base64EncodedString()], timeout: 35)
                body = chunk.data; headers = chunk.headers; status = chunk.status
                while !chunk.eof {
                    try Task.checkCancellation()
                    guard let stream = chunk.streamId else { throw PreviewHTTP.Failure(message: "Incomplete preview response") }
                    chunk = try await client.call("preview.chunk", ["streamId": stream])
                    body.append(chunk.data)
                    guard body.count <= 50 * 1024 * 1024 else { throw PreviewHTTP.Failure(message: "Preview response too large") }
                }
            case .files(let agent, let cwd):
                targetPort = 0
                guard request.method == "GET" || request.method == "HEAD" else { throw PreviewHTTP.Failure(message: "File previews are read only") }
                let relative = String(path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0].dropFirst())
                guard let decoded = relative.removingPercentEncoding else { throw PreviewHTTP.Failure(message: "Invalid resource path") }
                var chunk: RemoteFileChunk = try await client.call("files.read", ["agent": agent.rawValue, "cwd": cwd, "path": decoded])
                body = chunk.data; headers = ["content-type": [chunk.mime]]; status = 200
                while !chunk.eof {
                    try Task.checkCancellation()
                    chunk = try await client.call("files.read", ["agent": agent.rawValue, "cwd": cwd, "path": decoded, "offset": body.count])
                    guard chunk.offset == body.count, !chunk.data.isEmpty else { throw PreviewHTTP.Failure(message: "File changed during download") }
                    body.append(chunk.data)
                    guard body.count <= 20 * 1024 * 1024 else { throw PreviewHTTP.Failure(message: "File too large") }
                }
            }
            try Task.checkCancellation()
            guard self.origin == origin else { return }
            if let locations = headers["location"] {
                headers["location"] = locations.map { PreviewHTTP.rewriteURL($0, port: targetPort, origin: origin, token: token) }
            }
            if let cookies = headers["set-cookie"] {
                headers["set-cookie"] = cookies.map { cookie in
                    cookie.components(separatedBy: ";").filter { !$0.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("domain=") }
                        .map { part in
                            let trimmed = part.trimmingCharacters(in: .whitespaces)
                            if trimmed.lowercased().hasPrefix("path=") {
                                return " Path=/\(token)" + trimmed.dropFirst(5)
                            }
                            return part
                        }.joined(separator: ";")
                }
            }
            let mime = headers["content-type"]?.first ?? ""
            if headers["content-encoding"] == nil,
               mime.hasPrefix("text/") || mime.contains("javascript") || mime.contains("svg"),
               let text = String(data: body, encoding: .utf8) {
                body = Data(PreviewHTTP.rewriteText(text, port: targetPort, origin: origin, token: token).utf8)
                headers.removeValue(forKey: "etag"); headers.removeValue(forKey: "content-md5")
            }
            send(PreviewHTTP.response(status: status, headers: headers, body: body, headOnly: request.method == "HEAD"), connection: connection, id: id)
        } catch {
            if Task.isCancelled { finish(id); return }
            let name = URL(string: request.target)?.lastPathComponent ?? "resource"
            if failures.count < 12 { failures.append("\(name): \(error.localizedDescription)") }
            sendError(error.localizedDescription, status: 502, connection: connection, id: id)
        }
    }
    private func sendError(_ message: String, status: Int, connection: NWConnection, id: UUID) {
        send(PreviewHTTP.response(status: status, headers: ["content-type": ["text/plain; charset=utf-8"]], body: Data(message.utf8)), connection: connection, id: id)
    }
    private func send(_ data: Data, connection: NWConnection, id: UUID) {
        connection.send(content: data, completion: .contentProcessed { [weak self] _ in
            Task { @MainActor in self?.finish(id) }
        })
    }

    /// WKUserScript runs in the page world before application scripts. It covers
    /// computed fetch/XHR/navigation URLs that static response rewriting cannot see.
    func routingScript() -> String {
        guard let origin else { return "" }
        let port: Int
        if case .service(let value) = source { port = value } else { port = 0 }
        return """
        (() => {
          const origin = '\(origin)', prefix = '/\(token)', macPort = '\(port)';
          const route = value => {
            if (typeof value !== 'string') return value;
            if (value === prefix || value === origin + prefix || value.startsWith(prefix + '/') || value.startsWith(origin + prefix + '/')) return value;
            try {
              const u = new URL(value, location.href);
              if (u.origin === origin && (u.pathname === prefix || u.pathname.startsWith(prefix + '/'))) return u.href;
              if ((u.origin === origin || (['localhost','127.0.0.1'].includes(u.hostname) && u.port === macPort)) && u.protocol === 'http:')
                return origin + prefix + u.pathname + u.search + u.hash;
            } catch (_) {}
            return value;
          };
          const fetch = window.fetch;
          window.fetch = (input, init) => fetch.call(window, input instanceof Request ? new Request(route(input.url), input) : route(String(input)), init);
          const open = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...args) { return open.call(this, method, route(String(url)), ...args); };
          for (const name of ['pushState','replaceState']) {
            const original = history[name]; history[name] = function(state, title, url) { return original.call(this, state, title, url == null ? url : route(String(url))); };
          }
          const setAttribute = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function(name, value) { return setAttribute.call(this, name, ['src','href','action'].includes(name.toLowerCase()) ? route(value) : value); };
          for (const [type, key] of [[HTMLScriptElement,'src'],[HTMLImageElement,'src'],[HTMLLinkElement,'href'],[HTMLIFrameElement,'src'],[HTMLAnchorElement,'href'],[HTMLFormElement,'action']]) {
            const d = Object.getOwnPropertyDescriptor(type.prototype,key);
            if (d && d.set) Object.defineProperty(type.prototype,key,{...d,set(value){ d.set.call(this,route(String(value))); }});
          }
          if (window.Worker) { const Worker = window.Worker; window.Worker = function(url, options) { return new Worker(route(String(url)), options); }; }
          document.addEventListener('click', event => { const a = event.target.closest && event.target.closest('a[href]'); if (a) a.setAttribute('href', route(a.getAttribute('href'))); }, true);
          document.addEventListener('submit', event => { const f = event.target; if (f.action) f.action = route(f.action); }, true);
        })();
        """
    }
}
