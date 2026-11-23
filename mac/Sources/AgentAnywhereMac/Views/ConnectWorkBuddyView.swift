import SwiftUI
import AppKit

struct ConnectWorkBuddyView: View {
    @Environment(BridgeModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var apiKey = ""
    @State private var clipboard = WorkBuddyClipboard()
    @State private var pasted = false
    @State private var verifying = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect WorkBuddy").font(Brand.title(24, relativeTo: .title2))
            Text("WorkBuddy keeps its sign-in private, so AgentTote needs an API key once.")
                .foregroundStyle(Brand.muted).fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 8) {
                Text("1. Create an API key").font(.headline)
                Button("Open CodeBuddy API Keys") { NSWorkspace.shared.open(WorkBuddyConnection.keysURL) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("2. Copy and paste your key").font(.headline)
                HStack {
                    SecureField("API key", text: $apiKey)
                    Button("Paste") { paste(automatic: false) }
                }.disabled(verifying)
                if pasted { Text("Key pasted from clipboard").font(.caption).foregroundStyle(Brand.muted) }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("3. Connect").font(.headline)
                Button("Verify and Save") { Task { await save() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(verifying || !model.isRunning || WorkBuddyConnection.normalizedKey(apiKey) == nil)
                if verifying {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Verifying… This can take a few minutes.").font(.caption)
                    }
                }
                if let error { Text(error).foregroundStyle(Brand.failure).fixedSize(horizontal: false, vertical: true) }
                if !model.isRunning { Text("Start the bridge to connect WorkBuddy.").font(.caption).foregroundStyle(Brand.muted) }
            }
        }
        .textFieldStyle(BrandTextFieldStyle())
        .buttonStyle(TintedButtonStyle(fullWidth: false, compact: true))
        .padding(24).frame(width: 460).brandScreen()
        .onAppear { paste(automatic: true) }
        .onDisappear { apiKey = ""; pasted = false }
        .onChange(of: apiKey) { _, _ in error = nil }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            paste(automatic: true)
        }
    }

    private func paste(automatic: Bool) {
        guard !verifying, let text = NSPasteboard.general.string(forType: .string) else { return }
        let newKey = clipboard.newKey(from: text)
        let key = automatic ? newKey : WorkBuddyConnection.normalizedKey(text)
        if let key { apiKey = key; pasted = true; error = nil }
    }

    private func save() async {
        guard !verifying, let key = WorkBuddyConnection.normalizedKey(apiKey) else { return }
        verifying = true
        error = nil
        defer { verifying = false }
        do {
            try await model.connectWorkBuddy(apiKey: key)
            apiKey = ""
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
