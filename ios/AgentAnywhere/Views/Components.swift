import SwiftUI
import UIKit

struct AgentIcon: View {
    @Environment(AppModel.self) private var model
    let kind: AgentKind
    var size: CGFloat = 34

    var body: some View {
        Group {
            if let data = model.agentIcons.image(agent: kind, hash: model.agent(kind)?.iconHash),
               let image = UIImage(data: data) {
                Image(uiImage: image)
                    .renderingMode(.original).resizable().interpolation(.high).scaledToFit()
                    .frame(width: size, height: size)
            } else {
                Image(systemName: kind.symbol)
                    .font(.system(size: size * 0.45, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: size, height: size)
                    .background(tint, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            }
        }
        .accessibilityLabel(kind.displayName)
        .task(id: "\(model.bridgeDeviceId ?? "")-\(model.isConnected)-\(model.agent(kind)?.iconHash ?? "")") {
            await model.loadAgentIcon(kind)
        }
    }

    private var tint: Color {
        switch kind {
        case .claude: Brand.claude
        case .codex: Brand.codex
        case .workbuddy: Brand.workbuddy
        case .antigravity: Brand.antigravity
        case .cursor: Brand.cursor
        }
    }
}

/// Green pulsing dot for sessions an agent is working on right now.
struct RunningDot: View {
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(Brand.success)
            .frame(width: 8, height: 8)
            .overlay(Circle().stroke(Brand.success.opacity(0.5), lineWidth: 4).scaleEffect(pulse ? 1.8 : 1).opacity(pulse ? 0 : 1))
            .onAppear {
                withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { pulse = true }
            }
            .accessibilityLabel("Running")
    }
}

struct TaskStatusBadge: View {
    let status: TaskStatus

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(background, in: Capsule())
    }

    private var title: LocalizedStringKey {
        switch status {
        case .running: "Running"
        case .completed: "Done"
        case .failed: "Failed"
        case .cancelled: "Stopped"
        }
    }

    private var symbol: String {
        switch status {
        case .running: "circle.dotted"
        case .completed: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .cancelled: "stop.circle"
        }
    }

    private var color: Color {
        switch status {
        case .running: Brand.relayText
        case .completed: Brand.successText
        case .failed: Brand.failureText
        case .cancelled: Brand.muted
        }
    }
    private var background: Color {
        switch status {
        case .running: Brand.relaySoft
        case .completed: Brand.successSoft
        case .failed: Brand.failureSoft
        case .cancelled: Brand.line
        }
    }
}

struct MessageBubble: View {
    let role: ChatMessage.Role
    let text: String
    var cursorVisible: Bool? = nil

    var body: some View {
        HStack {
            if role == .user { Spacer(minLength: 40) }
            Group {
                if role == .assistant {
                    VStack(alignment: .leading, spacing: 2) {
                        ConversationMarkdown(text: text, streaming: cursorVisible != nil)
                        if let cursorVisible {
                            Text(verbatim: "▏").foregroundStyle(cursorVisible ? Brand.ink : .clear)
                                .accessibilityHidden(true)
                        }
                    }
                } else {
                    Text(markdown).textSelection(.enabled)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .foregroundStyle(role == .user ? Color.white : Brand.ink)
            .background(
                role == .user ? AnyShapeStyle(Brand.inkFill) : AnyShapeStyle(Brand.surface),
                in: ConversationShape(user: role == .user)
            )
            .shadow(color: .black.opacity(role == .assistant ? 0.04 : 0), radius: 2, y: 1)
            if role == .assistant { Spacer(minLength: 24) }
        }
    }

    private var markdown: AttributedString {
        var value = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        for url in PreviewHTTP.localLinks(in: text) {
            if let range = value.range(of: url.absoluteString) { value[range].link = url }
        }
        return value
    }
}

/// One line in a task's activity feed: a tool call or a status note.
struct ActivityRow: View {
    let symbol: String
    let title: String
    let detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: activitySymbol)
                .font(.caption)
                .foregroundStyle(Brand.muted)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
                ForEach(PreviewHTTP.localLinks(in: title + " " + (detail ?? "")), id: \.absoluteString) { url in
                    Link(url.absoluteString, destination: url).font(.caption).foregroundStyle(Brand.relayText)
                }
                if let detail, !detail.isEmpty {
                    if isCommand {
                        Text(detail).font(.caption.monospaced()).foregroundStyle(Color(hex: 0xD7D9E0))
                            .textSelection(.enabled).padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Brand.logoInk, in: RoundedRectangle(cornerRadius: 14))
                    } else {
                        Text(detail).font(.caption2.monospaced()).foregroundStyle(Brand.muted).lineLimit(2)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    private var activitySymbol: String {
        let name = title.lowercased()
        if isCommand { return "terminal" }
        if name.contains("read") { return "doc.text.magnifyingglass" }
        if ["edit", "write", "patch"].contains(where: name.contains) { return "pencil" }
        return symbol
    }

    private var isCommand: Bool {
        ["bash", "shell", "exec", "command", "terminal"].contains { title.lowercased().contains($0) }
    }
}

/// Only the trailing corner of each speaker's card is small.
struct ConversationShape: Shape {
    let user: Bool
    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: user ? 20 : 6, bottomTrailingRadius: user ? 6 : 20, topTrailingRadius: 20)
            .path(in: rect)
    }
}

struct MacSetupGuide: View {
    private static let macDownloadURL = URL(string: "https://agent-anywhere.nuts-claw.tech/download/")!
    @State private var linkCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Set up your Mac first")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Brand.ink)
            Text("1. Download, install, and open AgentTote on your Mac.")
                .font(.subheadline)
                .foregroundStyle(Brand.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text("2. Sign in with the same account, or choose \"Pair a phone\" from the menu bar icon and scan the QR code with this iPhone.")
                .font(.subheadline)
                .foregroundStyle(Brand.muted)
                .fixedSize(horizontal: false, vertical: true)

            Link("Get Mac app", destination: Self.macDownloadURL)
                .font(.body.weight(.semibold))
                .foregroundStyle(Brand.relayText)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)

            Button {
                UIPasteboard.general.url = Self.macDownloadURL
                linkCopied = true
            } label: {
                Text(linkCopied ? "Link copied" : "Copy download link")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(OutlineButtonStyle(compact: true))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

extension Date {
    var shortRelative: String {
        formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
