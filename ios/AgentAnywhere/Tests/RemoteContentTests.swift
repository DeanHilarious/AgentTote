// swiftc -D AA_REMOTE_CONTENT_TESTS RemoteContent.swift PreviewHTTP.swift RemoteContentTests.swift -o /tmp/aa-content-tests
#if AA_REMOTE_CONTENT_TESTS
import Foundation
@main private enum RemoteContentTestRunner {
    static func main() throws {
        func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
            if try !condition() { throw PreviewHTTP.Failure(message: message) }
        }
        try expect(RemoteFileType.classify(path: "README.md", mime: "text/plain") == .markdown, "Markdown extension")
        try expect(RemoteFileType.classify(path: "photo", mime: "image/png") == .image, "Image MIME")
        try expect(RemoteFileType.classify(path: "code", mime: "text/plain") == .text, "Sniffed text")
        try expect(RemoteFileType.classify(path: "x.PDF", mime: "application/pdf") == .pdf, "PDF")
        try expect(RemoteFileType.classify(path: "x.html", mime: "text/html") == .html, "HTML")
        try expect(RemoteFileType.classify(path: "x.zip", mime: "application/octet-stream") == .other, "Download fallback")
        let cwd = "/Users/test/project"
        let localLinks: [(String, String)] = [
            ("/Users/test/project/report.md", "/Users/test/project/report.md"),
            ("file:///Users/test/project/report.md", "/Users/test/project/report.md"),
            ("file://localhost/Users/test/project/report.md", "/Users/test/project/report.md"),
            ("/Users/test/project/report.md#L12", "/Users/test/project/report.md"),
            ("/Users/test/project/report.md#L12-L20", "/Users/test/project/report.md"),
            ("/Users/test/project/report.md:12", "/Users/test/project/report.md"),
            ("/Users/test/project/report.md:12:3", "/Users/test/project/report.md"),
            ("/Users/test/project/%E6%8A%A5%E5%91%8A.md#L12", "/Users/test/project/报告.md"),
            ("file:///Users/test/project/%E6%8A%A5%E5%91%8A.md:12", "/Users/test/project/报告.md"),
            ("docs/a.md", cwd + "/docs/a.md"),
            ("./a.md", cwd + "/a.md"),
            ("a.md:12", cwd + "/a.md"),
            ("docs/../a.md#L12", cwd + "/a.md"),
            ("../other/a.md", "/Users/test/other/a.md"),
            ("docs/", cwd + "/docs"),
            ("/Users/test/project/100%25.md", cwd + "/100%.md"),
            ("/Users/test/project/a%23b.md", cwd + "/a#b.md"),
        ]
        for (input, expected) in localLinks {
            try expect(LocalFileLink.resolve(url: URL(string: input)!, cwd: cwd) == expected, "Local path: \(input)")
            let markdown = try AttributedString(markdown: "[Report](\(input))")
            let link = markdown.runs.compactMap { $0.link }.first!
            try expect(LocalFileLink.resolve(url: link, cwd: cwd) == expected, "Markdown path: \(input)")
        }
        for input in ["http://example.com/a.md", "https://example.com/a.md#L12", "http://localhost:3000/", "mailto:test@example.com", "//example.com/a.md", "file://remote/a.md", "#L12"] {
            try expect(LocalFileLink.resolve(url: URL(string: input)!, cwd: cwd) == nil, "Nonlocal link: \(input)")
        }
        try expect(LocalFileLink.resolve(url: URL(string: "docs/a.md")!, cwd: "") == nil, "Relative path requires a session cwd")
        try expect(LocalFileLink.resolve(url: URL(string: "/Users/test/report.md")!, cwd: "") == "/Users/test/report.md", "Absolute path still opens an error-capable preview without cwd")
        let head = "POST /secret/api?q=1 HTTP/1.1\r\nHost: 127.0.0.1:12345\r\nContent-Length: 3\r\nCookie: a=b\r\n\r\n"
        try expect(try PreviewHTTP.parse(Data((head + "ab").utf8)) == nil, "Partial body waits")
        let request = try PreviewHTTP.parse(Data((head + "abc").utf8))!
        try expect(request.method == "POST" && request.body == Data("abc".utf8) && request.headers["cookie"] == "a=b", "Parse body and cookie")
        try expect(try PreviewHTTP.upstreamPath(request.target, token: "secret") == "/api?q=1", "Strip exact token")
        try expect(try PreviewHTTP.upstreamPath("/secret", token: "secret") == "/", "Bare token is the root")
        try expect(try PreviewHTTP.upstreamPath("/secret?x=1", token: "secret") == "/?x=1", "Bare token keeps the query")
        try expect(try PreviewHTTP.upstreamPath("/secret/secret", token: "secret") == "/secret", "Only one prefix is stripped")
        for target in ["/api", "/secretish/api", "/%73ecret/api", "/secret/../api".replacingOccurrences(of: "secret", with: "wrong")] {
            do { _ = try PreviewHTTP.upstreamPath(target, token: "secret"); throw NSError(domain: "token accepted", code: 1) }
            catch is PreviewHTTP.Failure { }
        }
        for malformed in ["GET http://evil HTTP/1.1\r\n\r\n", "POST /x HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n", "POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", "POST /x HTTP/1.1\r\nContent-Length: 52428801\r\n\r\n"] {
            do { _ = try PreviewHTTP.parse(Data(malformed.utf8)); throw NSError(domain: "malformed accepted", code: 1) }
            catch is PreviewHTTP.Failure { }
        }
        let origin = "http://127.0.0.1:12345"
        for input in ["/assets/app.js?q=1#x", "http://localhost:3000/assets/app.js?q=1#x", "http://127.0.0.1:3000/assets/app.js?q=1#x", "//localhost:3000/assets/app.js?q=1#x"] {
            try expect(PreviewHTTP.rewriteURL(input, port: 3000, origin: origin, token: "secret") == origin + "/secret/assets/app.js?q=1#x", "Rewrite URL: \(input)")
        }
        try expect(PreviewHTTP.rewriteURL("http://localhost:4000/x", port: 3000, origin: origin, token: "secret") == "http://localhost:4000/x", "Other ports stay separate")
        try expect(PreviewHTTP.rewriteURL("https://example.com/x", port: 3000, origin: origin, token: "secret") == "https://example.com/x", "External URLs stay external")
        let html = #"<script type="module" src="/@vite/client"></script><img src="./photo.png"><a href="http://localhost:3000/path">Go</a>"#
        let rewritten = PreviewHTTP.rewriteText(html, port: 3000, origin: origin, token: "secret")
        try expect(rewritten.contains(origin + "/secret/@vite/client") && rewritten.contains("./photo.png") && rewritten.contains(origin + "/secret/path"), "HTML root and localhost resources")
        let js = #"import x from '/src/app.js'; fetch('/api'); const css='url(/image.png)';"#
        let script = PreviewHTTP.rewriteText(js, port: 3000, origin: origin, token: "secret")
        try expect(script.contains(origin + "/secret/src/app.js") && script.contains(origin + "/secret/image.png"), "Vite imports and CSS")
        try expect(PreviewHTTP.rewriteText(#"const routes = [{ path: '/settings' }]; const data = '/';"#, port: 3000, origin: origin, token: "secret") == #"const routes = [{ path: '/settings' }]; const data = '/';"#, "Do not corrupt route names or data")
        let bytes = PreviewHTTP.response(status: 302, headers: ["set-cookie": ["a=b", "c=d"], "transfer-encoding": ["chunked"], "content-length": ["999"]], body: Data([0, 255, 10]))
        let response = String(decoding: bytes, as: UTF8.self)
        try expect(response.contains("Content-Length: 3") && response.contains("set-cookie: a=b\r\nset-cookie: c=d") && !response.contains("chunked"), "HTTP framing and multiple cookies")
        try expect(bytes.suffix(3) == Data([0, 255, 10]), "Binary body preserved")
        let wire = Data(#"{"status":200,"headers":{"content-type":"text/html","set-cookie":["a=b","c=d"]},"data":"YWJj","eof":true}"#.utf8)
        let chunk = try JSONDecoder().decode(PreviewChunk.self, from: wire)
        try expect(chunk.data == Data("abc".utf8) && chunk.headers["set-cookie"]?.count == 2, "Base64 and flexible headers")
        let links = PreviewHTTP.localLinks(in: "Ready http://localhost:3000/ and http://127.0.0.1:4000/path?x=1")
        try expect(links.count == 2 && links[1].port == 4000, "Task links")
        print("Remote content checks passed: local file links, file types, HTTP framing, binary bodies, token isolation, URL rewriting, Vite imports and cookies.")
    }
}
#endif
