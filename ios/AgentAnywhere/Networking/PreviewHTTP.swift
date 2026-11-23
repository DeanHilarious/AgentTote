import Foundation

/// Pure HTTP/1.1 framing and URL rewriting, shared by the loopback listener and tests.
enum PreviewHTTP {
    static let bodyLimit = 50 * 1024 * 1024
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    struct Request {
        let method: String
        let target: String
        let headers: [String: String]
        let body: Data
    }
    static func parse(_ bytes: Data) throws -> Request? {
        guard let end = bytes.range(of: Data("\r\n\r\n".utf8)) else {
            if bytes.count > 65536 { throw Failure(message: "HTTP headers too large") }
            return nil
        }
        guard end.lowerBound <= 65536,
              let head = String(data: bytes[..<end.lowerBound], encoding: .utf8) else { throw Failure(message: "Invalid HTTP headers") }
        let lines = head.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1" || first[2] == "HTTP/1.0",
              ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(String(first[0])),
              first[1].hasPrefix("/"), !first[1].hasPrefix("//") else { throw Failure(message: "Invalid HTTP request") }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw Failure(message: "Invalid HTTP header") }
            let name = String(line[..<colon]).lowercased()
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, !name.contains(" "), headers[name] == nil else { throw Failure(message: "Duplicate HTTP header") }
            headers[name] = value
        }
        guard headers["transfer-encoding"] == nil else { throw Failure(message: "Chunked uploads aren't supported yet") }
        let length = Int(headers["content-length"] ?? "0")
        guard let length, length >= 0, length <= bodyLimit else { throw Failure(message: "Preview uploads are limited to 50 MiB") }
        guard bytes.count >= end.upperBound + length else { return nil }
        return Request(method: String(first[0]), target: String(first[1]), headers: headers,
                       body: bytes.subdata(in: end.upperBound..<(end.upperBound + length)))
    }
    static func upstreamPath(_ target: String, token: String) throws -> String {
        let prefix = "/\(token)/"
        let bare = "/\(token)"
        let result: String
        if target.hasPrefix(prefix) { result = "/" + target.dropFirst(prefix.count) }
        // "/<token>" and "/<token>?q" are the preview root.
        else if target == bare || target.hasPrefix(bare + "?") { result = "/" + target.dropFirst(bare.count) }
        else { throw Failure(message: "Invalid preview token") }
        guard !result.contains("\r"), !result.contains("\n"), !result.hasPrefix("//") else { throw Failure(message: "Invalid preview path") }
        return result
    }
    static func localURL(_ path: String, origin: String, token: String) -> String {
        origin + "/" + token + (path.hasPrefix("/") ? path : "/" + path)
    }
    static func rewriteURL(_ value: String, port: Int, origin: String, token: String) -> String {
        if value.hasPrefix(origin + "/" + token + "/") { return value }
        if value.hasPrefix("/"), !value.hasPrefix("//") { return localURL(value, origin: origin, token: token) }
        if let u = URLComponents(string: value), ["localhost", "127.0.0.1", "::1"].contains(u.host ?? ""),
           u.port == port, u.scheme == "http" || u.scheme == nil {
            let path = u.percentEncodedPath.isEmpty ? "/" : u.percentEncodedPath
            return localURL(path, origin: origin, token: token) + (u.percentEncodedQuery.map { "?" + $0 } ?? "") + (u.percentEncodedFragment.map { "#" + $0 } ?? "")
        }
        return value
    }
    static func rewriteText(_ text: String, port: Int, origin: String, token: String) -> String {
        var output = text
        // Rewrite URL-bearing syntax, not arbitrary strings (API JSON and router
        // route names such as "/settings" must keep their application meaning).
        let patterns = [
            #"(?i)((?:src|href|action|poster|srcset)\s*=\s*["'])(/[^/][^"'<>]*)"#,
            #"(?i)(url\(\s*["']?)(/[^/][^"'\s)]*)"#,
            #"((?:\bfrom\s*|\bimport\s*(?:\(\s*)?|@import\s*)["'`])(/[^/][^"'`\s]*)"#,
            #"(["'`(])((?:http:)?//(?:localhost|127\.0\.0\.1):[0-9]+(?:/[^"'`\s<>)]*)?)"#
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            for match in regex.matches(in: output, range: NSRange(output.startIndex..., in: output)).reversed() {
                guard let range = Range(match.range(at: 2), in: output) else { continue }
                let value = String(output[range])
                output.replaceSubrange(range, with: rewriteURL(value, port: port, origin: origin, token: token))
            }
        }
        // Exact root attributes (e.g. forms posting to "/").
        if let regex = try? NSRegularExpression(pattern: #"(?i)((?:src|href|action|poster)\s*=\s*["'])(/)(?=["'])"#) {
            for match in regex.matches(in: output, range: NSRange(output.startIndex..., in: output)).reversed() {
                if let range = Range(match.range(at: 2), in: output) { output.replaceSubrange(range, with: localURL("/", origin: origin, token: token)) }
            }
        }
        return output
    }
    static func response(status: Int, headers: [String: [String]], body: Data, headOnly: Bool = false) -> Data {
        let excluded = Set(["connection", "transfer-encoding", "content-length", "keep-alive", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization"])
        let length = headOnly ? (headers["content-length"]?.first.flatMap(Int.init) ?? body.count) : body.count
        var lines = ["HTTP/1.1 \(status) \(status < 400 ? "OK" : "Error")", "Connection: close", "Content-Length: \(max(0, length))", "Referrer-Policy: no-referrer"]
        for (name, values) in headers.sorted(by: { $0.key < $1.key }) where !excluded.contains(name.lowercased()) && name.lowercased() != "referrer-policy" {
            guard !name.contains("\r"), !name.contains("\n") else { continue }
            for value in values where !value.contains("\r") && !value.contains("\n") { lines.append("\(name): \(value)") }
        }
        var data = Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        if !headOnly { data.append(body) }
        return data
    }
    static func localLinks(in text: String) -> [URL] {
        let pattern = #"http://(?:localhost|127\.0\.0\.1):[0-9]{2,5}(?:/[^\s<>\"')\]]*)?"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        var seen = Set<String>()
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { m in
            guard let r = Range(m.range, in: text) else { return nil }
            let value = String(text[r]); guard seen.insert(value).inserted else { return nil }
            return URL(string: value)
        }
    }
}
