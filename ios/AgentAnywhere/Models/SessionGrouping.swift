import Foundation

struct SessionGroup: Identifiable {
    /// Empty is reserved for Other; real paths (including /) remain distinct.
    let id: String
    let path: String
    let sessions: [SessionSummary]

    var hasRunningSession: Bool { sessions.contains(where: \.running) }
    var isOther: Bool { id.isEmpty }

    func projectName(locale: Locale = .current) -> String {
        guard !isOther else { return "Other" }
        let name = (SessionGrouping.trimTrailingSlashes(path) as NSString).lastPathComponent
        guard name.range(of: #"^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return name }
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.calendar = Calendar(identifier: .gregorian)
        parser.timeZone = TimeZone(secondsFromGMT: 0)
        parser.dateFormat = "yyyy-MM-dd-HH-mm-ss"
        parser.isLenient = false
        guard let date = parser.date(from: name), parser.string(from: date) == name else { return name }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = parser.timeZone
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return "Untitled workspace · \(formatter.string(from: date))"
    }

    var displayPath: String {
        let path = SessionGrouping.trimTrailingSlashes(path)
        let parts = path.split(separator: "/")
        if path.hasPrefix("/"), parts.count >= 2, parts[0].lowercased() == "users" {
            let suffix = parts.dropFirst(2).joined(separator: "/")
            return suffix.isEmpty ? "~" : "~/" + suffix
        }
        return path
    }
}

/// Pure grouping and presentation policy, independent of SwiftUI or persistence.
enum SessionGrouping {
    static func trimTrailingSlashes(_ path: String) -> String {
        var result = path
        while result.count > 1 && result.hasSuffix("/") { result.removeLast() }
        return result
    }

    static func normalizedPath(_ path: String) -> String {
        trimTrailingSlashes(path).lowercased()
    }

    static func groups(_ sessions: [SessionSummary]) -> [SessionGroup] {
        let sorted = sessions.sorted {
            $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt
        }
        let buckets = Dictionary(grouping: sorted) { normalizedPath($0.cwd) }
        return buckets.map { key, sessions in
            SessionGroup(id: key, path: sessions[0].cwd, sessions: sessions)
        }.sorted {
            if $0.isOther != $1.isOther { return !$0.isOther }
            let lhs = $0.sessions[0].updatedAt, rhs = $1.sessions[0].updatedAt
            return lhs == rhs ? $0.id < $1.id : lhs > rhs
        }
    }

    static func initiallyExpanded(_ groups: [SessionGroup]) -> Set<String> {
        let projectCount = groups.filter { !$0.isOther }.count
        let defaults = projectCount <= 5 ? groups : Array(groups.prefix(3))
        return Set((defaults + groups.filter(\.hasRunningSession)).map(\.id))
    }

    static func persistenceKey(deviceId: String, agent: AgentKind, path: String) -> String {
        // Encode components independently so delimiters inside paths cannot collide.
        let parts = [deviceId.lowercased(), agent.rawValue, normalizedPath(path)]
        let data = try! JSONEncoder().encode(parts)
        return "sessionGroup.collapsed." + data.base64EncodedString()
    }
}
