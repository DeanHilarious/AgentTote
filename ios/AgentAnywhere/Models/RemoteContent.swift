import Foundation

struct RemoteFileEntry: Decodable, Identifiable, Hashable {
    let name: String
    let path: String
    let kind: String
    let size: Int
    let modifiedAt: Double
    let hidden: Bool
    let blocked: Bool
    var id: String { path }
}
struct RemoteFileList: Decodable {
    let root: String
    let path: String
    let entries: [RemoteFileEntry]
    let truncated: Bool?
}
struct RemoteFileChunk: Decodable {
    let root: String?
    let path: String
    let size: Int
    let mime: String
    let offset: Int
    let data: Data // JSONDecoder decodes base64.
    let eof: Bool
}
struct WebPreviewTarget: Decodable, Identifiable, Hashable {
    let port: Int
    let process: String
    let pid: Int
    let url: String
    let source: String
    var taskIds: [String]? = nil
    var cwd: String? = nil
    var project: String? = nil
    var id: Int { port }
}
struct PreviewChunk: Decodable {
    let status: Int
    let headers: [String: [String]]
    let data: Data
    let streamId: String?
    let eof: Bool
    private enum CodingKeys: String, CodingKey { case status, headers, data, streamId, eof }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(Int.self, forKey: .status)
        data = try c.decode(Data.self, forKey: .data)
        streamId = try c.decodeIfPresent(String.self, forKey: .streamId)
        eof = try c.decode(Bool.self, forKey: .eof)
        let values = try c.nestedContainer(keyedBy: HeaderKey.self, forKey: .headers)
        var result: [String: [String]] = [:]
        for key in values.allKeys {
            if let array = try? values.decode([String].self, forKey: key) { result[key.stringValue.lowercased()] = array }
            else { result[key.stringValue.lowercased()] = [try values.decode(String.self, forKey: key)] }
        }
        headers = result
    }
    private struct HeaderKey: CodingKey {
        let stringValue: String
        init?(stringValue: String) { self.stringValue = stringValue }
        var intValue: Int? { nil }
        init?(intValue: Int) { return nil }
    }
}

enum RemoteFileType: Equatable {
    case text, markdown, image, pdf, html, other
    static func classify(path: String, mime: String) -> Self {
        let ext = (path as NSString).pathExtension.lowercased()
        if ["md", "markdown"].contains(ext) || mime == "text/markdown" { return .markdown }
        if ["html", "htm"].contains(ext) || mime.hasPrefix("text/html") { return .html }
        if ext == "pdf" || mime == "application/pdf" { return .pdf }
        if mime.hasPrefix("image/") { return .image }
        if mime.hasPrefix("text/") || ["application/json", "application/xml", "application/javascript"].contains(mime) { return .text }
        return .other
    }
}

struct PreviewUpload: Decodable { let bodyId: String; let offset: Int }

/// Resolves Mac paths without consulting the phone's filesystem. Authorization
/// (including traversal and symlink checks) remains the bridge's responsibility.
enum LocalFileLink {
    static func resolve(url: URL, cwd: String) -> String? {
        let raw = url.relativeString.replacingOccurrences(of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
        guard let components = URLComponents(string: raw),
              components.scheme == nil || components.scheme?.lowercased() == "file",
              components.host == nil || components.host == "" ||
                (components.scheme?.lowercased() == "file" && components.host?.lowercased() == "localhost"),
              var path = components.percentEncodedPath.removingPercentEncoding,
              !path.isEmpty else { return nil }
        path = path.replacingOccurrences(of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
        guard !path.isEmpty, !path.contains("\0") else { return nil }
        if !path.hasPrefix("/") {
            guard cwd.hasPrefix("/") else { return nil }
            path = cwd + "/" + path
        }
        return URL(fileURLWithPath: path).standardizedFileURL.path
    }
}
