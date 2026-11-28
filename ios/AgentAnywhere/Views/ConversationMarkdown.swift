import SwiftUI

struct ConversationMarkdown: View {
    let text: String
    var streaming = false

    @State private var blocks: [ConversationMarkdownDocument.Block] = []
    @State private var pending: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks) { block in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let marker = block.marker {
                        Text(verbatim: marker).monospacedDigit().accessibilityHidden(true)
                    }
                    content(block.content)
                }
                .padding(.leading, CGFloat(min(block.listDepth, 8)) * 10 + (block.quoted ? 10 : 0))
                .overlay(alignment: .leading) {
                    if block.quoted { RoundedRectangle(cornerRadius: 2).fill(Brand.separator).frame(width: 3) }
                }
            }
        }
        .textSelection(.enabled)
        .onChange(of: text, initial: true) { _, value in pending = value }
        .task(id: pending != nil) {
            // Keep one parse in flight and coalesce newer snapshots while the bridge streams at 20 Hz.
            while let source = pending, !Task.isCancelled {
                let isStreaming = streaming
                let parsed = await Task.detached(priority: .userInitiated) {
                    ConversationMarkdownDocument(source, streaming: isStreaming)
                }.value
                guard !Task.isCancelled else { return }
                blocks = parsed.blocks
                if isStreaming {
                    do { try await Task.sleep(for: .milliseconds(160)) } catch { return }
                }
                if pending == source { pending = nil }
            }
        }
    }

    @ViewBuilder private func content(_ block: ConversationMarkdownDocument.Content) -> some View {
        switch block {
        case .paragraph(let parts): inline(parts)
        case .heading(let level, let parts):
            inline(parts)
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .accessibilityAddTraits(.isHeader)
        case .divider: Divider()
        case .code(let code):
            ScrollView(.horizontal) {
                Text(verbatim: code.hasSuffix("\n") ? String(code.dropLast()) : code)
                    .font(.system(.footnote, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(10)
            }
            .background(Brand.line.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
        case .diagram(let source): ConversationDiagram(source: source)
        case .table(let table):
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 1, verticalSpacing: 1) {
                    ForEach(table.rows.keys.sorted(), id: \.self) { row in
                        GridRow {
                            ForEach(table.columns.indices, id: \.self) { col in
                                let alignment = table.columns[col].alignment
                                inline(table.rows[row]?[col] ?? [])
                                    .font(row == 0 ? .subheadline.bold() : .subheadline)
                                    .padding(7)
                                    .frame(
                                        maxWidth: 240,
                                        alignment: alignment == .right
                                            ? .trailing : alignment == .center ? .center : .leading
                                    )
                                    .background(row == 0 ? Brand.separator.opacity(0.7) : Brand.surface)
                            }
                        }
                    }
                }.background(Brand.line)
            }
        }
    }

    private func inline(_ parts: [ConversationMarkdownDocument.Inline]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(parts.indices, id: \.self) { index in
                switch parts[index] {
                case .text(let value): Text(value).fixedSize(horizontal: false, vertical: true)
                case .image(let alt, let destination): ConversationMarkdownImage(alt: alt, destination: destination)
                }
            }
        }
    }
}
