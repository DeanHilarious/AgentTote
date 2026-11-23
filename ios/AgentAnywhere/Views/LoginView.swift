import SwiftUI

struct LoginView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    var onSkip: (() -> Void)?
    @State private var showServer = false
    @State private var showPairing = false
    @State private var flow = "login"

    var body: some View {
        EmailAuthForm(
            purpose: flow,
            showMacSetupGuide: onSkip != nil && flow != "reset",
            openServer: { showServer = true }
        ) { email, code, password in
            if flow == "register" { try await account.register(email: email, code: code, password: password) }
            else if flow == "reset" { try await account.resetPassword(email: email, code: code, password: password) }
            else { try await account.signIn(email: email, password: password) }
            dismiss()
        } footer: {
            if flow == "login" {
                Button("Create an account") { flow = "register" }
                Button("Forgot password?") { flow = "reset" }
            } else {
                Button("Back to sign in") { flow = "login" }
            }
            HStack {
                Rectangle().fill(Brand.line).frame(height: 1)
                Text("or").font(.caption).foregroundStyle(Brand.muted)
                Rectangle().fill(Brand.line).frame(height: 1)
            }
            Button {
                if let onSkip { onSkip() } else { showPairing = true }
            } label: { Label("Pair with a QR code", systemImage: "qrcode") }
                .buttonStyle(OutlineButtonStyle())
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top) {
            if typeSize.isAccessibilitySize {
                utilityControls.frame(maxWidth: .infinity, alignment: .trailing).padding(.horizontal, 24).background(Brand.paper)
            }
        }
        .overlay(alignment: .topTrailing) {
            if !typeSize.isAccessibilitySize { utilityControls.padding(.trailing, 24).padding(.top, 24) }
        }
        .sheet(isPresented: $showPairing) { NavigationStack { PairingView(isOnboarding: false) } }
        .sheet(isPresented: $showServer) { NavigationStack { AccountServerView() } }
        .onChange(of: account.isSignedIn) { _, signedIn in if signedIn { dismiss() } }
    }
    private var utilityControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { utilityButtons }
            VStack(alignment: .trailing, spacing: 8) { utilityButtons }
        }
        .font(.footnote).foregroundStyle(Brand.muted).buttonStyle(.plain)
    }

    @ViewBuilder private var utilityButtons: some View {
        if onSkip == nil { Button("Cancel") { dismiss() }.frame(minWidth: 44, minHeight: 44) }
    }

}

struct BindIdentityView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    let channel: IdentityChannel

    var body: some View {
        EmailAuthForm(purpose: "bind") { target, code, _ in
            try await account.bind(channel: channel, target: target, code: code)
            dismiss()
        } footer: { EmptyView() }
        .brandNavigationTitle("Bind \(channel.label.lowercased())")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .onChange(of: account.isSignedIn) { _, signedIn in if !signedIn { dismiss() } }
    }
}

private struct EmailAuthForm<Footer: View>: View {
    @Environment(AccountStore.self) private var account
    let purpose: String
    var showMacSetupGuide = false
    var openServer: () -> Void = {}
    let submitAction: (String, String, String) async throws -> Void
    @ViewBuilder let footer: () -> Footer
    @State private var email = ""
    @State private var code = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var sentEmail: String?
    @State private var busy = false
    @State private var resendAt = Date.distantPast
    @State private var now = Date()
    @State private var error: String?
    @FocusState private var focus: Field?
    @FocusState private var passwordFocused: Bool
    private enum Field { case email, code }
    private var normalizedEmail: String { IdentityChannel.email.normalized(email) }
    private var remaining: Int { max(0, Int(ceil(resendAt.timeIntervalSince(now)))) }
    private var needsCode: Bool { purpose != "login" }
    private var needsPassword: Bool { purpose != "bind" }
    private var title: String {
        switch purpose {
        case "register": "Create account"
        case "reset": "Reset password"
        case "bind": "Bind email"
        default: "Sign in"
        }
    }
    private var canSubmit: Bool {
        !busy && !normalizedEmail.isEmpty && (!needsCode || (sentEmail == normalizedEmail && code.count == 6)) &&
        (!needsPassword || (!password.isEmpty && (purpose == "login" || !confirmation.isEmpty)))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                BrandMark(size: 56).onLongPressGesture(minimumDuration: 2, perform: openServer)
                BrandWordmark()
                Text(title).font(.title2.bold())
                if showMacSetupGuide {
                    MacSetupGuide()
                }
                if purpose == "reset" {
                    Text("Resetting your password signs out your other devices, including your Macs.")
                        .font(.subheadline).foregroundStyle(Brand.muted)
                }
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Email").font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
                        TextField("Email address", text: $email)
                            .keyboardType(.emailAddress).textContentType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($focus, equals: .email).brandInput(focused: focus == .email)
                    }
                    if needsCode {
                        Button(remaining > 0 ? "Send code in \(remaining) s" : "Send code") { Task { await sendCode() } }
                            .buttonStyle(TintedButtonStyle()).disabled(busy || remaining > 0 || normalizedEmail.isEmpty)
                        if sentEmail != nil {
                            TextField("6-digit code", text: $code)
                                .keyboardType(.numberPad).textContentType(.oneTimeCode)
                                .focused($focus, equals: .code).brandInput(focused: focus == .code)
                                .onChange(of: code) { _, value in
                                    code = VerificationCode.normalized(value)
                                    if code.count == 6 {
                                        if needsPassword { focus = nil; passwordFocused = true }
                                        else { Task { await submit() } }
                                    }
                                }
                        }
                    }
                    if needsPassword && (!needsCode || code.count == 6) {
                        BrandPasswordField(title: purpose == "login" ? "Password" : "New password", text: $password, newPassword: needsCode, externalFocus: $passwordFocused)
                        if needsCode { BrandPasswordField(title: "Confirm password", text: $confirmation, newPassword: true) }
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Brand.failure) }
                    Button { Task { await submit() } } label: {
                        if busy { ProgressView().tint(.white) } else { Text(title) }
                    }.buttonStyle(PrimaryButtonStyle()).disabled(!canSubmit)
                }.disabled(busy)
                VStack(spacing: 16) { footer() }.disabled(busy).frame(maxWidth: .infinity)
            }.padding(24).frame(maxWidth: 520).frame(maxWidth: .infinity)
        }
        .brandScreen()
        .onChange(of: email) { _, _ in clearCode() }
        .onChange(of: purpose) { _, _ in clearCode() }
        .onChange(of: account.serverAddress) { _, _ in clearCode(); resendAt = .distantPast }
        .task {
            if !showMacSetupGuide { focus = .email }
            while !Task.isCancelled {
                now = Date()
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }
    private func clearCode() { code = ""; password = ""; confirmation = ""; sentEmail = nil; error = nil }
    private func sendCode() async {
        guard !busy, remaining == 0 else { return }
        busy = true; error = nil
        let address = account.serverAddress
        let target = normalizedEmail
        defer { busy = false }
        do {
            let result = try await account.sendCode(email: target, purpose: purpose)
            guard address == account.serverAddress else { return }
            sentEmail = target; code = ""; now = Date()
            resendAt = now.addingTimeInterval(Double(result.resendAfter))
            focus = .code
        } catch {
            guard address == account.serverAddress else { return }
            self.error = error.localizedDescription
            if let retry = (error as? AccountError)?.retryAfter { resendAt = Date().addingTimeInterval(Double(retry)) }
        }
    }
    private func submit() async {
        guard canSubmit else { return }
        if needsCode && needsPassword && password != confirmation { error = "Passwords don't match."; return }
        busy = true; error = nil
        defer { busy = false }
        do {
            try await submitAction(normalizedEmail, code, password)
            password = ""; confirmation = ""; code = ""
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
