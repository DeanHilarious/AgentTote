import SwiftUI

struct AccountView: View {
    @Environment(AccountStore.self) private var account
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var showLogin = false
    @State private var showChangePassword = false
    @State private var showServer = false
    @State private var showSignOut = false
    @State private var showDeleteAccount = false
    @State private var isDeletingAccount = false
    @State private var deletionError: String?
    @State private var feedbackKind: FeedbackKind?
    @State private var bindingChannel: IdentityChannel?
    @State private var emailVisible = false
    @State private var emailRevealTask: Task<Void, Never>?
    @AppStorage("notifyStartedTasks") private var notifyStartedTasks = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    Text("Account").font(Brand.title(34, relativeTo: .largeTitle))
                    Spacer()
                    Button("Done") { dismiss() }.frame(minWidth: 44, minHeight: 44)
                }
                InterfaceLanguagePicker()
                    .pickerStyle(.menu)
                profile
                if account.user?.phone != nil && account.user?.email == nil {
                    Button { bindingChannel = .email } label: {
                        Label("Add an email to keep signing in — phone sign-in is going away.", systemImage: "envelope.badge")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.relayText)
                            .padding(18).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Brand.relaySoft, in: RoundedRectangle(cornerRadius: 20))
                    }.buttonStyle(.plain)
                }
                if account.user != nil {
                    group("Security") {
                        VStack(spacing: 0) {
                            Button { showChangePassword = true } label: {
                                securityRow("Change password", icon: "key.fill")
                            }
                            rowDivider
                            Button { bindingChannel = .email } label: {
                                securityRow("Email", icon: "envelope.fill", value: account.user?.email ?? "Add")
                            }
                        }.buttonStyle(.plain).brandCard(radius: 24)
                    }
                }
                group("Your Macs") {
                    VStack(spacing: 0) {
                        if model.availableMacs.isEmpty {
                            Text(account.isSignedIn ? "Sign in to the same account on your Mac's bridge to see it here." : "Pair a Mac with a QR code, or sign in to your account.")
                                .font(.subheadline).foregroundStyle(Brand.muted)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(18)
                        }
                        ForEach(model.availableMacs) { mac in
                            MacManagementRow(mac: mac).padding(.horizontal, 16).padding(.vertical, 8)
                            if mac.id != model.availableMacs.last?.id { rowDivider }
                        }
                    }.brandCard(radius: 24)
                }
                if let message = account.recoveryMessage {
                    Text(message).font(.footnote).foregroundStyle(Brand.muted)
                }
                if let message = account.errorMessage {
                    Text(message).font(.footnote).foregroundStyle(Brand.failure)
                }
                group("Feedback") {
                    VStack(spacing: 0) {
                        Button { feedbackKind = .agentRequest } label: { securityRow("Request an agent", icon: "sparkles") }
                        rowDivider
                        Button { feedbackKind = .bug } label: { securityRow("Send feedback", icon: "bubble.left.and.text.bubble.right") }
                    }.buttonStyle(.plain).brandCard(radius: 24)
                }
                group("Notifications") {
                    VStack(alignment: .leading, spacing: 10) {
                        Toggle(isOn: $notifyStartedTasks) {
                            HStack(spacing: 12) {
                                AccountIcon(symbol: "bell.fill")
                                Text("Notify me when tasks I start finish").font(.subheadline)
                            }
                        }.tint(Brand.relay)
                        Text("Get a notification on this phone when a task you started finishes.")
                            .font(.caption).foregroundStyle(Brand.muted).padding(.leading, 40)
                    }.padding(16).brandCard(radius: 24)
                }
                if account.hasSession {
                    Button("Sign out", role: .destructive) { showSignOut = true }
                        .font(.body.weight(.medium)).foregroundStyle(Brand.failure)
                        .frame(maxWidth: .infinity, minHeight: 56).brandCard(radius: 24)
                        .buttonStyle(.plain)
                }
                if account.isSignedIn {
                    Button(role: .destructive) { showDeleteAccount = true } label: {
                        HStack(spacing: 10) {
                            if isDeletingAccount { ProgressView() }
                            Text(isDeletingAccount ? "Deleting account…" : "Delete account")
                        }
                        .font(.body.weight(.medium)).foregroundStyle(Brand.failure)
                        .frame(maxWidth: .infinity, minHeight: 56).brandCard(radius: 24)
                    }.buttonStyle(.plain)
                }
                if let deletionError {
                    Text(deletionError).font(.footnote).foregroundStyle(Brand.failure)
                        .accessibilityLabel("Account deletion failed. \(deletionError)")
                }
                Text(version)
                    .font(.caption).foregroundStyle(Brand.muted)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                    .onLongPressGesture(minimumDuration: 2) { showServer = true }
            }
            .padding(20).frame(maxWidth: 700).frame(maxWidth: .infinity)
        }
        .disabled(isDeletingAccount)
        .interactiveDismissDisabled(isDeletingAccount)
        .brandScreen()
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await account.restore() }
        .sheet(item: $feedbackKind) { FeedbackView(initialKind: $0) }
        .sheet(isPresented: $showLogin) { NavigationStack { LoginView() } }
        .sheet(isPresented: $showChangePassword) { NavigationStack { PasswordSettingsView() } }
        .sheet(isPresented: $showServer) { NavigationStack { AccountServerView() } }
        .sheet(item: $bindingChannel) { channel in NavigationStack { BindIdentityView(channel: channel) } }
        .confirmationDialog("Sign out?", isPresented: $showSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await account.signOut() } }
            Button("Cancel", role: .cancel) { }
        }
        .alert("Delete account?", isPresented: $showDeleteAccount) {
            Button("Delete account", role: .destructive) { Task { await deleteAccount() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Permanently delete your account, registered Macs, sign-in sessions and account-linked feedback " +
                 "from the service. This cannot be undone. Files and agents on your Mac and independent QR " +
                 "pairings are kept.")
        }
        .onDisappear { hideEmail() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { hideEmail() } }
        .onChange(of: account.user?.email) { _, _ in hideEmail() }
        .onChange(of: showChangePassword || showServer || bindingChannel != nil || feedbackKind != nil) { _, presented in
            if presented { hideEmail() }
        }
    }

    private func deleteAccount() async {
        isDeletingAccount = true
        deletionError = nil
        defer { isDeletingAccount = false }
        do {
            try await account.deleteAccount()
            dismiss()
        } catch {
            deletionError = error.localizedDescription
        }
    }

    private var profile: some View {
        HStack(spacing: 16) {
            Image(systemName: "person.fill").font(.system(size: 25))
                .foregroundStyle(Brand.relayText).frame(width: 56, height: 56)
                .background(Brand.relaySoft, in: Circle()).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                if let user = account.user {
                    if let email = user.email {
                        Button { revealEmail() } label: {
                            Text(emailVisible ? email : maskedEmail(email))
                                .font(Brand.title(20, relativeTo: .title3)).multilineTextAlignment(.leading)
                        }.buttonStyle(.plain)
                        .accessibilityLabel(emailVisible ? email : "Email hidden, double tap to show")
                    } else {
                        Text("Your account").font(Brand.title(20, relativeTo: .title3))
                    }
                    Text("AgentTote account").font(.subheadline).foregroundStyle(Brand.muted)
                        .textSelection(.enabled)
                } else if account.hasSession {
                    Text("Restoring your account…").foregroundStyle(Brand.muted)
                    Button("Retry") { Task { await account.restore() } }.disabled(account.isRestoring)
                } else {
                    Button("Sign in") { showLogin = true }.buttonStyle(PrimaryButtonStyle())
                }
            }
            Spacer(minLength: 0)
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).brandCard(radius: 24)
    }

    private var version: String {
        let info = Bundle.main.infoDictionary ?? [:]
        return "AgentTote v\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
    }

    private var rowDivider: some View {
        Rectangle().fill(Brand.separator).frame(height: 1).padding(.leading, 56)
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LocalizedStringKey(title)).font(Brand.title(20, relativeTo: .title3)).padding(.leading, 4)
            content()
        }
    }

    private func securityRow(_ title: String, icon: String, value: String? = nil) -> some View {
        HStack(spacing: 12) {
            AccountIcon(symbol: icon)
            Text(LocalizedStringKey(title)).font(.subheadline)
            Spacer(minLength: 8)
            if let value { Text(value).font(.subheadline).foregroundStyle(Brand.muted).multilineTextAlignment(.trailing) }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Brand.muted).accessibilityHidden(true)
        }.padding(16).frame(minHeight: 60).contentShape(Rectangle())
    }

    private func maskedEmail(_ email: String) -> String {
        let parts = email.split(separator: "@", maxSplits: 1)
        guard parts.count == 2 else { return "***" }
        return "\(parts[0].prefix(2))***@\(parts[1])"
    }

    private func revealEmail() {
        emailRevealTask?.cancel()
        emailVisible = true
        emailRevealTask = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            emailVisible = false
        }
    }

    private func hideEmail() {
        emailRevealTask?.cancel()
        emailRevealTask = nil
        emailVisible = false
    }
}

struct AccountIcon: View {
    let symbol: String
    var body: some View {
        Image(systemName: symbol).font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Brand.relayText).frame(width: 28, height: 28)
            .background(Brand.relaySoft, in: RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
    }
}

/// Shared by Account and Home so every removal has the same confirmation and error handling.
struct MacManagementRow: View {
    @Environment(AppModel.self) private var model
    let mac: MacSelection
    @State private var confirmingRemoval = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Button { model.select(mac) } label: {
                    HStack(spacing: 12) {
                        AccountIcon(symbol: "laptopcomputer")
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(mac.name).font(.subheadline.weight(.semibold))
                                if mac.id == model.selectedMacId {
                                    Text("In use").font(.caption2.weight(.medium)).foregroundStyle(Brand.relayText)
                                        .padding(.horizontal, 7).padding(.vertical, 3).background(Brand.relaySoft, in: Capsule())
                                }
                            }
                            if case .account(let device) = mac {
                                HStack(spacing: 5) {
                                    Circle().fill(device.online ? Brand.success : Brand.muted).frame(width: 6, height: 6)
                                    Text("\(device.online ? "Online" : "Offline") · Last seen \(device.lastSeenDate.shortRelative)")
                                }.font(.caption).foregroundStyle(Brand.muted)
                            } else {
                                Text("Paired with QR code").font(.caption).foregroundStyle(Brand.muted)
                            }
                        }
                        Spacer(minLength: 0)
                    }.frame(maxWidth: .infinity, minHeight: 52, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityElement(children: .combine)
                Menu {
                    Button { model.select(mac) } label: { Label("Use this Mac", systemImage: "laptopcomputer") }
                    Button(role: .destructive) { confirmingRemoval = true } label: { Label("Remove…", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis").font(.body.weight(.semibold))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }.accessibilityLabel("Options for \(mac.name)")
            }.disabled(!model.removingMacIDs.isEmpty)
            if model.removingMacIDs.contains(mac.id) { ProgressView().accessibilityLabel("Removing \(mac.name)") }
            if let error { Text(error).font(.caption).foregroundStyle(Brand.failure).padding(.leading, 40) }
        }
        .confirmationDialog("Remove \(mac.name)?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    error = nil
                    do { try await model.removeMac(mac) }
                    catch is CancellationError { }
                    catch { self.error = error.localizedDescription }
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: { Text(mac.removalMessage) }
    }
}

struct AccountServerView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("https://agent-anywhere.nuts-claw.tech", text: $address)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Account server")
            } footer: {
                Text("On a physical iPhone, use your Mac's LAN address, for example http://192.168.1.20:8790. Changing the server signs you out.")
            }.brandRows()
            if let error { Section { Text(error).foregroundStyle(Brand.failure) }.brandRows() }
            Section {
                Button("Save") {
                    do { try account.updateServer(address); dismiss() }
                    catch { self.error = error.localizedDescription }
                }
            }.brandRows()
        }
        .brandList()
        .toolbar(.visible, for: .navigationBar)
        .brandNavigationTitle("Server")
        .onAppear { address = account.serverAddress }
    }
}

struct PasswordSettingsView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                if account.user?.hasPassword == true {
                    SecureField("Current password", text: $current).textContentType(.password)
                }
                SecureField("New password", text: $password).textContentType(.newPassword)
            }.brandRows()
            if let error { Section { Text(error).font(.footnote).foregroundStyle(Brand.failure) }.brandRows() }
            Section {
                Button { Task { await submit() } } label: {
                    HStack {
                        Text("Change password")
                        if busy { Spacer(); ProgressView() }
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(busy || password.isEmpty)
            }.brandRows()
        }
        .disabled(busy)
        .brandList()
        .toolbar(.visible, for: .navigationBar)
        .brandNavigationTitle("Change password")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        .onChange(of: account.isSignedIn) { _, signedIn in if !signedIn { dismiss() } }
        .onChange(of: account.serverAddress) { _, _ in dismiss() }
    }

    private func submit() async {
        guard !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await account.changePassword(current: account.user?.hasPassword == true ? current : nil, new: password)
            password = ""
            current = ""
            dismiss()
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
}
