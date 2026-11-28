#if AA_CONVERSATION_MARKDOWN_TESTS
import Foundation

@main private enum ConversationMarkdownTests {
    static func main() throws {
        let source = """
            # 标题

            **重点** [报告](docs/report.md) http://localhost:3141/

            1. First
               - Second

            > 引用

            | A | B | C |
            |---|:-:|--:|
            |   | **2** | 3 |

            ```swift
            let text = "# not a heading"
            ```

            ![chart](out.png)

            ```mermaid
            graph LR
            A-->B
            ```
            """
        let doc = ConversationMarkdownDocument(source, streaming: true)
        try expect(doc.blocks.count == 9, "nine semantic blocks")
        guard case .heading(1, let heading) = doc.blocks[0].content, case .text(let title) = heading.first else {
            throw failure("heading")
        }
        try expect(String(title.characters) == "标题", "heading marker removed")
        guard case .paragraph(let paragraph) = doc.blocks[1].content, case .text(let inline) = paragraph.first else {
            throw failure("paragraph")
        }
        try expect(
            inline.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true },
            "inline emphasis")
        try expect(inline.runs.contains { $0.link?.relativeString == "docs/report.md" }, "relative link")
        try expect(inline.runs.contains { $0.link?.host == "localhost" }, "localhost preview")
        try expect(doc.blocks[2].marker == "1.", "ordered list")
        try expect(doc.blocks[3].marker == "•" && doc.blocks[3].listDepth == 2, "nested list")
        try expect(doc.blocks[4].quoted, "blockquote")
        guard case .table(let table) = doc.blocks[5].content else { throw failure("table") }
        try expect(table.columns.map(\.alignment) == [.left, .center, .right], "column alignment")
        try expect(table.rows[1]?[0] == nil && table.rows[1]?[1] != nil, "empty cells preserve column positions")
        guard case .code(let code) = doc.blocks[6].content else { throw failure("code") }
        try expect(code.contains("# not a heading"), "verbatim fenced code")
        guard case .paragraph(let image) = doc.blocks[7].content, case .image(let alt, let path) = image.first else {
            throw failure("image")
        }
        try expect(alt == "chart" && path == "out.png", "local chart reference")
        guard case .diagram(let mermaid) = doc.blocks[8].content else { throw failure("trailing diagram") }
        try expect(mermaid == "graph LR\nA-->B\n", "closed diagram at EOF without newline")

        let incomplete = "~~~~mermaid\nflowchart LR\nA-->B\n~~~"
        guard case .code = ConversationMarkdownDocument(incomplete, streaming: true).blocks.first?.content else {
            throw failure("shorter fence cannot finish a streaming diagram")
        }
        guard case .diagram = ConversationMarkdownDocument(incomplete + "~", streaming: true).blocks.first?.content
        else {
            throw failure("matching tilde fence closes streamed diagram")
        }
        guard case .diagram = ConversationMarkdownDocument("~~~mermaid\nflowchart LR\nA-->B").blocks.first?.content
        else {
            throw failure("CommonMark implicitly closes a final fence at EOF")
        }
        let mixed = ConversationMarkdownDocument("前 ![](https://example.org/chart.png) 后")
        guard case .paragraph(let parts) = mixed.blocks.first?.content, parts.count == 3,
            case .text = parts[0], case .image(let emptyAlt, let remote) = parts[1], case .text = parts[2]
        else {
            throw failure("inline chart preserves surrounding text")
        }
        try expect(emptyAlt.isEmpty && remote == "https://example.org/chart.png", "image without alt")
        print(
            "Conversation Markdown checks passed (blocks, inline links and images, tables, streaming and EOF diagrams)."
        )
    }

    private static func expect(_ condition: Bool, _ message: String) throws {
        if !condition { throw failure(message) }
    }

    private static func failure(_ message: String) -> NSError {
        NSError(domain: "ConversationMarkdownTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
#endif
