import SwiftUI

struct LogsView: View {
    @Environment(BridgeModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(model.logs.lines.count) / 1000 lines").foregroundStyle(Brand.muted)
                Spacer()
                Button("Copy all") { copyText(model.logs.lines.map(\.formatted).joined(separator: "\n")) }
                Button("Clear") { model.clearLogs() }
            }.buttonStyle(TintedButtonStyle(fullWidth: false, compact: true)).padding(12)
            Divider()
            ScrollViewReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(model.logs.lines) { line in
                            Text(line.formatted).textSelection(.enabled)
                                .foregroundStyle(line.source == "stderr" ? Brand.warning : Brand.ink)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .font(.system(.caption, design: .monospaced))
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: model.logs.lines.last?.id) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .brandScreen()
        .frame(minWidth: 500, minHeight: 300)
    }
}
