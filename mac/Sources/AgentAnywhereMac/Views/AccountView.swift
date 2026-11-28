import SwiftUI

enum IdentityChannel: String, CaseIterable, Identifiable {
    case email
    var id: String { rawValue }
    var label: String { "Email" }
    func normalized(_ target: String) -> String {
        target.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct CodeDelivery: Decodable {
    let expiresIn: Int
    let resendAfter: Int
}

struct AccountView: View {
    @Environment(BridgeModel.self) private var model
    private let channel: IdentityChannel = .email
    @State private var target = ""
    @State private var code = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var flow = "login"
    private var creating: Bool { flow != "login" }
    @State private var sentTarget: String?
    @State private var sentChannel: IdentityChannel?
    @State private var server = ""
    @State private var busy = false
    @State private var resendAt = Date.distantPast
    @State private var retryAt = Date.distantPast
    @State private var now = Date()
    @State private var error: String?

    private var remaining: Int { max(0, Int(ceil(max(resendAt, retryAt).timeIntervalSince(now)))) }
    private var retryRemaining: Int { max(0, Int(ceil(retryAt.timeIntervalSince(now)))) }
    private var canVerify: Bool {
        !busy && model.isRunning && retryRemaining == 0 && code.count == 6 &&
        sentTarget == channel.normalized(target) && sentChannel == channel
    }

    private var canSubmitPassword: Bool {
        !busy && model.isRunning && retryRemaining == 0 && !channel.normalized(target).isEmpty &&
        !password.isEmpty && (!creating || (!confirmation.isEmpty && canVerify))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if let user = model.account.user {
                    BrandFormSection("Account") {
                        Text(user.identity).font(.headline)
                        Text(LocalizedStringKey(model.account.statusLabel)).foregroundStyle(model.account.state == "online" ? Brand.muted : Brand.failure)
                        Button("Sign out") { Task { await signOut() } }.buttonStyle(DestructiveButtonStyle(fullWidth: false, compact: true)).disabled(busy || !model.isRunning)
                    }
                } else {
                    if model.account.state == "revoked" {
                        Text(LocalizedStringKey(model.account.statusLabel)).foregroundStyle(Brand.failure)
                    }
                    BrandFormSection(flow == "register" ? "Create account" : flow == "reset" ? "Reset password" : "Sign in") {
                        TextField("Email address", text: $target).textContentType(.emailAddress).disabled(busy)
                        if creating {
                            if flow == "reset" {
                                Text("Resetting your password signs out your other devices, including your Macs.").font(.caption).foregroundStyle(Brand.muted)
                            }
                            Button(remaining > 0 ? "Send code in \(remaining) s" : "Send code") { Task { await sendCode() } }
                                .disabled(busy || remaining > 0 || !model.isRunning || channel.normalized(target).isEmpty)
                            TextField("6-digit code", text: $code).textContentType(.oneTimeCode)
                                .disabled(busy || sentTarget == nil)
                                .onChange(of: code) { _, value in code = String(value.filter { $0 >= "0" && $0 <= "9" }.prefix(6)) }
                        }
                        if !creating || code.count == 6 {
                            SecureField(creating ? "New password" : "Password", text: $password)
                                .textContentType(creating ? .newPassword : .password).disabled(busy)
                            if creating {
                                SecureField("Confirm password", text: $confirmation).textContentType(.newPassword).disabled(busy)
                            }
                        }
                        Button(flow == "register" ? "Create account" : flow == "reset" ? "Reset password" : "Sign in") { Task { await submitPassword() } }
                            .buttonStyle(PrimaryButtonStyle()).disabled(!canSubmitPassword)
                        if creating {
                            Button("Back to sign in") { flow = "login"; resetCode() }.disabled(busy)
                        } else {
                            Button("Create account") { flow = "register"; resetCode() }.disabled(busy)
                            Button("Forgot password?") { flow = "reset"; resetCode() }.disabled(busy)
                        }
                    }
                    BrandFormSection("Account server") {
                        TextField("http://localhost:8790", text: $server).disabled(busy)
                        Button("Save server") { Task { await saveServer() } }
                            .disabled(busy || !model.isRunning || server.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || server == model.account.serverUrl)
                    }
                }
                if busy { ProgressView().controlSize(.small) }
                if retryRemaining > 0 { Text("Try again in \(retryRemaining) s.").foregroundStyle(Brand.muted) }
                if let error { Text(error).foregroundStyle(Brand.failure).font(.callout) }
                if !model.isRunning { Text("Start the bridge to manage your account.").foregroundStyle(Brand.muted) }
            }
            .padding(16)
        }
        .textFieldStyle(BrandTextFieldStyle())
        .buttonStyle(TintedButtonStyle(fullWidth: false, compact: true))
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top) {
            HStack(spacing: 10) { BrandMark(size: 28); BrandWordmark(size: 20); Spacer() }.padding(.horizontal, 24).padding(.top, 16)
        }
        .brandScreen()
        .padding(8).frame(width: 440, height: 520)
        .onAppear { server = model.account.serverUrl }
        .onChange(of: target) { _, _ in resetCode() }
        .onChange(of: model.account.serverUrl) { _, value in
            server = value
            resetCode()
            resendAt = .distantPast
            retryAt = .distantPast
        }
        .onChange(of: model.account.user) { _, _ in resetCode() }
        .task {
            while !Task.isCancelled {
                now = Date()
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }

    private func resetCode() { code = ""; password = ""; confirmation = ""; sentTarget = nil; sentChannel = nil; error = nil }
    private func showError(_ error: Error) {
        self.error = error.localizedDescription
        if let failure = error as? IPCFailure, failure.code == "rate_limited", let retryAfter = failure.retryAfter {
            now = Date()
            retryAt = now.addingTimeInterval(Double(retryAfter))
        }
    }
    private func sendCode() async {
        guard !busy, remaining == 0 else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let delivery: CodeDelivery = try await model.bridge.request("account.sendCode", params: [
                "email": .string(channel.normalized(target)), "purpose": .string(flow)
            ]).decode()
            sentTarget = channel.normalized(target)
            sentChannel = channel
            code = ""
            now = Date()
            resendAt = now.addingTimeInterval(Double(delivery.resendAfter))
        } catch { showError(error) }
    }
    private func submitPassword() async {
        guard canSubmitPassword else { return }
        if creating, password != confirmation { error = "Passwords don't match."; return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            _ = try await model.bridge.request(flow == "register" ? "account.register" : flow == "reset" ? "account.resetPassword" : "account.login", params: [
                "email": .string(channel.normalized(target)), "password": .string(password), "code": .string(code)
            ])
            password = ""
            confirmation = ""
        } catch { showError(error) }
    }
    private func signOut() async {
        busy = true
        error = nil
        defer { busy = false }
        do { _ = try await model.bridge.request("account.logout") }
        catch { showError(error) }
    }
    private func saveServer() async {
        busy = true
        error = nil
        defer { busy = false }
        do { _ = try await model.bridge.request("account.setServer", params: ["url": .string(server)]) }
        catch { showError(error) }
    }
}
