import SwiftUI
import UIKit
import Darwin

struct FeedbackView: View {
    let initialKind: FeedbackKind
    @Environment(AccountStore.self) private var account
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var kind: FeedbackKind = .bug
    @State private var selected: Set<String> = []
    @State private var other = ""
    @State private var message = ""
    @State private var contactOk = false
    @State private var includeDiagnostics = true
    @State private var diagnostics: FeedbackDiagnostics?
    @State private var busy = false
    @State private var success = false
    @State private var error: String?
    @State private var retryAt: Date?

    private var requesting: Bool { initialKind == .agentRequest }
    private var contactEmail: String? { account.isSignedIn ? account.user?.email : nil }
    private var payload: FeedbackPayload {
        FeedbackPayload(kind: requesting ? .agentRequest : kind,
                        agents: FeedbackAgent.candidates.filter { selected.contains($0.id) }.map(\.id),
                        otherAgent: other, message: message, contactOk: contactOk && contactEmail != nil,
                        diagnostics: includeDiagnostics ? diagnostics : nil)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                if success {
                    VStack(spacing: 20) {
                        Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Brand.relayText)
                        Text("Thanks!").font(Brand.title(30, relativeTo: .largeTitle))
                        Text(requesting ? "We read every request." : "We read every message.")
                            .foregroundStyle(Brand.muted)
                        Button("Done") { dismiss() }.buttonStyle(RelayButtonStyle())
                    }.padding(24).frame(maxWidth: 600).frame(maxWidth: .infinity).padding(.top, 60)
                } else {
                    VStack(alignment: .leading, spacing: 24) {
                        if requesting {
                            Text("Which agents should we support?").font(Brand.title(28, relativeTo: .title))
                            Text("Choose up to 10. Your requests help us decide what to build next.")
                                .font(.subheadline).foregroundStyle(Brand.muted)
                            agentChoices
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Other").font(.headline)
                                TextField("Agent name", text: $other).textInputAutocapitalization(.words)
                                    .padding(14).brandCard()
                                if other.unicodeScalars.count > 60 {
                                    Text("Keep the agent name within 60 characters.").font(.caption).foregroundStyle(Brand.failure)
                                }
                            }
                        } else {
                            Picker("Feedback type", selection: $kind) {
                                Text("Bug").tag(FeedbackKind.bug)
                                Text("Idea").tag(FeedbackKind.idea)
                                Text("Other").tag(FeedbackKind.other)
                            }.pickerStyle(.segmented)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text(requesting ? "How would you use it? (optional)" : "Your message").font(.headline)
                            TextEditor(text: $message).frame(minHeight: 140).scrollContentBackground(.hidden)
                                .padding(10).brandCard().accessibilityLabel(requesting ? "How would you use it?" : "Your message")
                            Text("\(message.unicodeScalars.count) / 2,000")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(message.unicodeScalars.count > 2000 ? Brand.failure : Brand.muted)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        VStack(alignment: .leading, spacing: 14) {
                            if let email = contactEmail {
                                Toggle(requesting ? "Email me when it's supported" : "You can email me about this", isOn: $contactOk)
                                Text(maskedEmail(email)).font(.caption).foregroundStyle(Brand.muted)
                            }
                            Toggle("Include diagnostics", isOn: $includeDiagnostics)
                            if includeDiagnostics, let diagnostics {
                                DisclosureGroup("Diagnostics to be sent") {
                                    Text(diagnostics.preview).font(.caption.monospaced()).foregroundStyle(Brand.muted)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
                                }
                            }
                            Text("Diagnostics contain app and device versions, language, and enabled agents. They do not include conversations, paths or credentials.")
                                .font(.caption).foregroundStyle(Brand.muted)
                        }.tint(Brand.relay).padding(16).brandCard()
                        if let error {
                            Text(error).font(.footnote).foregroundStyle(Brand.failure).accessibilityAddTraits(.updatesFrequently)
                        }
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            let waiting = retryAt.map { $0 > context.date } ?? false
                            VStack(alignment: .leading, spacing: 8) {
                                if waiting, let retryAt {
                                    Text("Try again in \(max(1, Int(ceil(retryAt.timeIntervalSince(context.date))))) s.")
                                        .font(.footnote).foregroundStyle(Brand.muted)
                                }
                                Button { Task { await submit() } } label: {
                                    HStack {
                                        Spacer()
                                        if busy { ProgressView().tint(.white) }
                                        Text(busy ? "Sending…" : "Send")
                                        Spacer()
                                    }
                                }.buttonStyle(RelayButtonStyle()).disabled(busy || waiting || payload.validationError != nil)
                            }
                        }
                    }.padding(20).frame(maxWidth: 650).frame(maxWidth: .infinity).disabled(busy)
                }
            }
            .brandScreen()
            .brandNavigationTitle(requesting ? "Request an agent" : "Send feedback")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
            .interactiveDismissDisabled(busy)
            .onAppear {
                kind = initialKind
                diagnostics = captureDiagnostics()
            }
            .onChange(of: contactEmail) { _, _ in contactOk = false }
            .onChange(of: account.serverAddress) { _, _ in dismiss() }
        }
    }

    private var agentChoices: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 10)], spacing: 10) {
            ForEach(FeedbackAgent.candidates) { agent in
                let checked = selected.contains(agent.id)
                Button {
                    if checked { selected.remove(agent.id) }
                    else if selected.count < 10 { selected.insert(agent.id) }
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top) {
                            Text(agent.name).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.ink)
                            Spacer(minLength: 4)
                            Image(systemName: checked ? "checkmark.circle.fill" : "circle").foregroundStyle(checked ? Brand.relayText : Brand.muted)
                        }
                        Text(agent.detail).font(.caption).foregroundStyle(Brand.muted).frame(maxWidth: .infinity, alignment: .leading)
                    }.padding(14).frame(maxWidth: .infinity, minHeight: 108, alignment: .topLeading)
                        .background(checked ? Brand.relaySoft : Brand.surface, in: RoundedRectangle(cornerRadius: 18))
                        .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(checked ? Brand.relay : Brand.separator, lineWidth: checked ? 2 : 1) }
                }.buttonStyle(.plain).accessibilityAddTraits(checked ? .isSelected : [])
                    .disabled(!checked && selected.count >= 10)
            }
        }
    }

    private func maskedEmail(_ email: String) -> String {
        let parts = email.split(separator: "@", maxSplits: 1)
        return parts.count == 2 ? "\(parts[0].prefix(2))***@\(parts[1])" : "***"
    }
    private func captureDiagnostics() -> FeedbackDiagnostics {
        let info = Bundle.main.infoDictionary ?? [:]
        var machine = utsname()
        uname(&machine)
        let device = withUnsafeBytes(of: &machine.machine) { bytes in
            String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        var strings = ["appVersion": info["CFBundleShortVersionString"] as? String ?? "unknown",
                       "build": info["CFBundleVersion"] as? String ?? "unknown",
                       "osVersion": UIDevice.current.systemVersion, "deviceModel": device,
                       "locale": Locale.current.identifier]
        if model.isConnected, let version = model.bridgeVersion { strings["bridgeVersion"] = version }
        return FeedbackDiagnostics(strings: strings, enabledAgents: model.enabledAgentKinds)
    }
    private func submit() async {
        guard !busy, payload.validationError == nil else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await account.submitFeedback(payload)
            success = true
        } catch is CancellationError { }
        catch {
            if let failure = error as? AccountError, let seconds = failure.retryAfter, failure.code == "rate_limited" {
                retryAt = Date().addingTimeInterval(TimeInterval(seconds))
            }
            self.error = error.localizedDescription
        }
    }
}
