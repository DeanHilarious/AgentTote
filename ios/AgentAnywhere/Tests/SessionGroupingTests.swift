// xcrun swiftc -parse-as-library -D AA_SESSION_GROUPING_TESTS Protocol.swift
// SessionGrouping.swift SessionGroupingTests.swift -o /tmp/aa-session-grouping-tests
#if AA_SESSION_GROUPING_TESTS
import Foundation

@main
private enum SessionGroupingTestRunner {
    static func main() throws {
        func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
            if !condition() { throw NSError(domain: "SessionGroupingTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func session(_ id: String, _ cwd: String, _ updatedAt: Double, running: Bool = false) -> SessionSummary {
            SessionSummary(id: id, agent: .workbuddy, title: id, cwd: cwd, updatedAt: updatedAt, running: running, preview: nil)
        }
        for cwdField in ["", #","cwd":null"#] {
            let wire = Data((#"{"id":"missing","agent":"codex","title":"Missing","updatedAt":1,"running":false"# + cwdField + "}").utf8)
            let decoded = try JSONDecoder().decode(SessionSummary.self, from: wire)
            try expect(SessionGrouping.groups([decoded])[0].isOther, "Missing or null cwd decodes into Other")
        }
        let fixtures = [session("old", "~/Workbuddy/policy-workspace/", 10),
                        session("latest", "~/WorkBuddy/policy-workspace///", 40),
                        session("other", "", 100), session("second", "/Users/person/code", 30),
                        session("root", "/", 1), session("mid", "~/WORKBUDDY/policy-workspace", 20)]
        let groups = SessionGrouping.groups(fixtures)
        try expect(groups.count == 4, "Case variants and trailing slashes must merge")
        try expect(groups[0].sessions.map(\.id) == ["latest", "mid", "old"], "Newest session first within group")
        try expect(groups[0].path == "~/WorkBuddy/policy-workspace///", "Latest original path must be preserved")
        try expect(groups.map(\.id) == ["~/workbuddy/policy-workspace", "/users/person/code", "/", ""], "Groups sort by newest update; Other is always last")
        try expect(groups.last?.projectName() == "Other", "Missing cwd uses Other")
        try expect(groups[0].projectName() == "policy-workspace", "Title strips trailing separators")
        try expect(groups[1].displayPath == "~/code", "Remote Mac home abbreviated")
        let home = SessionGrouping.groups([session("home", "/Users/person/", 1)])[0]
        try expect(home.displayPath == "~", "Home itself abbreviated")
        try expect(SessionGrouping.normalizedPath("////") == "/", "Root stays distinct from missing cwd")
        try expect(SessionGrouping.groups([]).isEmpty, "Empty input")
        let timestamp = SessionGrouping.groups([session("auto", "~/WorkBuddy/2026-08-17-20-37-00", 1)])[0]
        try expect(timestamp.projectName(locale: Locale(identifier: "en_US")) == "Untitled workspace · Aug 17", "Timestamp workspace gets localized date title")
        try expect(timestamp.projectName(locale: Locale(identifier: "zh_CN")).contains("8月17日"), "Date uses supplied locale")
        let invalid = SessionGrouping.groups([session("invalid", "/2026-99-17-20-37-00", 1)])[0]
        try expect(invalid.projectName() == "2026-99-17-20-37-00", "Invalid date remains literal folder name")
        let many = SessionGrouping.groups((0..<6).map { session("\($0)", "/project\($0)", Double(10 - $0), running: $0 == 5) })
        try expect(SessionGrouping.initiallyExpanded(many) == Set(["/project0", "/project1", "/project2", "/project5"]), "Six projects expand newest three plus running group")
        let five = Array(many.prefix(5))
        try expect(SessionGrouping.initiallyExpanded(five).count == 5, "Five projects expand all")
        let key = SessionGrouping.persistenceKey(deviceId: "MAC-A", agent: .codex, path: "/Project/")
        try expect(key == SessionGrouping.persistenceKey(deviceId: "mac-a", agent: .codex, path: "/project"), "Collapse key normalizes path and Mac ID")
        try expect(key != SessionGrouping.persistenceKey(deviceId: "mac-b", agent: .codex, path: "/project"), "Collapse state isolated by Mac")
        try expect(key != SessionGrouping.persistenceKey(deviceId: "mac-a", agent: .workbuddy, path: "/project"), "Collapse state isolated by Agent")
        let suite = "AgentAnywhere.SessionGroupingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: key)
        try expect(UserDefaults(suiteName: suite)!.object(forKey: key) as? Bool == true, "Collapse state survives defaults reload")
        let tied = [session("b", "/b", 1), session("a", "/a", 1)]
        try expect(SessionGrouping.groups(tied).map(\.id) == SessionGrouping.groups(tied.reversed()).map(\.id), "Ties have deterministic ordering")
        print("SessionGrouping checks passed: normalization, order, original paths, Other, localized titles, expansion policy and persistence isolation.")
    }
}
#endif
