import Foundation

/// Foundation parses Markdown semantics. SwiftUI needs separate views for block layout and images.
struct ConversationMarkdownDocument {
    enum Inline {
        case text(AttributedString)
        case image(alt: String, destination: String)
    }

    enum Content {
        case paragraph([Inline])
        case heading(Int, [Inline])
        case code(String)
        case diagram(String)
        case table(Table)
        case divider
    }

    struct Table {
        let id: Int
        let columns: [PresentationIntent.TableColumn]
        var rows: [Int: [Int: [Inline]]] = [:]
    }

    struct Block: Identifiable {
        let id: Int
        let content: Content
        let marker: String?
        let listDepth: Int
        let quoted: Bool
    }

    let blocks: [Block]

    init(_ source: String, streaming: Bool = false) {
        let options = AttributedString.MarkdownParsingOptions(appliesSourcePositionAttributes: streaming)
        guard let document = try? AttributedString(markdown: source, options: options) else {
            blocks = [
                Block(
                    id: 0, content: .paragraph([.text(AttributedString(source))]),
                    marker: nil, listDepth: 0, quoted: false)
            ]
            return
        }

        var result: [Block] = []
        var pendingTable: Table?
        var seenItems: Set<Int> = []

        func finishTable() {
            guard let table = pendingTable else { return }
            result.append(Block(id: table.id, content: .table(table), marker: nil, listDepth: 0, quoted: false))
            pendingTable = nil
        }

        for (intent, range) in document.runs[\.presentationIntent] {
            let parts = intent?.components ?? []
            let span = document[range]
            if case .tableCell(let column) = parts.first?.kind,
                let table = parts.dropFirst(2).first,
                case .table(let columns) = table.kind
            {
                if pendingTable?.id != table.identity {
                    finishTable()
                    pendingTable = Table(id: table.identity, columns: columns)
                }
                let row: Int
                if case .tableRow(let index) = parts.dropFirst().first?.kind { row = index } else { row = 0 }
                pendingTable?.rows[row, default: [:]][column] = Self.inline(span)
                continue
            }

            finishTable()
            let lists = parts.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
            var marker: String?
            if let item = parts.first(where: { if case .listItem = $0.kind { true } else { false } }),
                case .listItem(let ordinal) = item.kind, seenItems.insert(item.identity).inserted
            {
                marker = lists.first?.kind == .orderedList ? "\(ordinal)." : "•"
            }

            let content: Content
            switch parts.first?.kind {
            case .header(let level):
                content = .heading(level, Self.inline(span))
            case .codeBlock(let language):
                let code = String(span.characters)
                if language?.lowercased() == "mermaid", !streaming || Self.hasClosingFence(span, source: source) {
                    content = .diagram(code)
                } else {
                    content = .code(code)
                }
            case .thematicBreak:
                content = .divider
            default:
                content = .paragraph(Self.inline(span))
            }
            result.append(
                Block(
                    id: parts.first?.identity ?? 0, content: content, marker: marker,
                    listDepth: lists.count, quoted: parts.contains { $0.kind == .blockQuote }))
        }
        finishTable()
        blocks = result
    }

    private static func inline(_ span: AttributedSubstring) -> [Inline] {
        span.runs[\.imageURL].map { url, range in
            let fragment = span[range]
            if let url {
                let alt = String(fragment.characters)
                return .image(alt: alt == "\u{fffc}" ? "" : alt, destination: url.relativeString)
            }
            var text = AttributedString(fragment)
            text.presentationIntent = nil
            let string = String(text.characters)
            if string.contains("http://") {
                for url in PreviewHTTP.localLinks(in: string) {
                    if let range = text.range(of: url.absoluteString) { text[range].link = url }
                }
            }
            return .text(text)
        }
    }

    // CommonMark closes a fence at EOF. During streaming that EOF is temporary.
    private static func hasClosingFence(_ span: AttributedSubstring, source: String) -> Bool {
        guard let position = span.runs.first?.markdownSourcePosition,
            let range = Range(position, in: source)
        else { return false }
        let lines = source[range].split(whereSeparator: \.isNewline)
        guard lines.count >= 2, let first = lines.first, let last = lines.last,
            let marker = first.first, marker == "`" || marker == "~"
        else { return false }
        let closing = last.drop(while: { $0.isWhitespace || $0 == ">" })
        let fence = closing.prefix(while: { $0 == marker })
        return fence.count >= first.prefix(while: { $0 == marker }).count
            && closing.dropFirst(fence.count).allSatisfy(\.isWhitespace)
    }
}
