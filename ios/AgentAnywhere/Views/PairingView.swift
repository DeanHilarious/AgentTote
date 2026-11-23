import SwiftUI
import VisionKit

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let isOnboarding: Bool
    var prefilled: PairingLink?

    @State private var hosts = ""
    @State private var port = "8787"
    @State private var token = ""
    @State private var deviceId: UUID?
    @State private var name = "My Mac"
    @State private var showScanner = false
    @State private var connecting = false
    @State private var error: String?

    private var scannerAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    BrandMark(size: 56)
                    BrandWordmark(size: 24)
                    Text("Connect your Mac")
                        .font(Brand.title(24, relativeTo: .title2))
                    MacSetupGuide()
                }
                .padding(.vertical, 6)
            }.brandRows()

            Section {
                Button {
                    showScanner = true
                } label: {
                    Label("Scan QR code", systemImage: "qrcode.viewfinder")
                }
                .buttonStyle(RelayButtonStyle())
                .listRowSeparator(.hidden, edges: .bottom)
                .disabled(!scannerAvailable)
                // PasteButton reads the clipboard without iOS's "Allow Paste?" prompt.
                HStack {
                    Text("Pairing link")
                    Spacer()
                    PasteButton(payloadType: String.self) { strings in
                        if let link = strings.lazy.compactMap(PairingLink.init(string:)).first { fill(from: link) }
                        else { error = "The clipboard doesn't contain an agentanywhere:// link." }
                    }
                    .labelStyle(.titleAndIcon)
                    .buttonBorderShape(.capsule)
                }
            } footer: {
                if !scannerAvailable {
                    Text("QR scanning needs a camera. You can also scan with the Camera app, or fill in the fields below.")
                }
            }.brandRows()

            Section("Or enter manually") {
                LabeledContent("Name") {
                    TextField("My Mac", text: $name).multilineTextAlignment(.trailing)
                }
                LabeledContent("Address") {
                    TextField("192.168.1.20, 100.x.y.z", text: $hosts)
                        .multilineTextAlignment(.trailing)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                LabeledContent("Port") {
                    TextField("8787", text: $port).multilineTextAlignment(.trailing).keyboardType(.numberPad)
                }
                LabeledContent("Token") {
                    SecureField("from the Mac pairing link", text: $token).multilineTextAlignment(.trailing)
                }
            }.brandRows()

            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Brand.failure)
                }.brandRows()
            }

            Section {
                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        Spacer()
                        if connecting { ProgressView() } else { Text("Connect").bold() }
                        Spacer()
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(connecting || parsedHosts.isEmpty || token.isEmpty)
            } footer: {
                Text("Away from your Mac's network? Sign in to the same account on Mac and iPhone to connect remotely. Local QR pairing needs the same Wi-Fi network, or Tailscale if you already use it.")
            }.brandRows()
        }
        .brandList()
        .toolbar(.visible, for: .navigationBar)
        .brandNavigationTitle(isOnboarding ? "AgentTote" : "Add Mac")
        .toolbar {
            if !isOnboarding {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .sheet(isPresented: $showScanner) {
            ScannerSheet { code in
                showScanner = false
                if let link = PairingLink(string: code) {
                    fill(from: link)
                    Task { await connect() }
                } else {
                    error = "That QR code isn't an AgentTote pairing code."
                }
            }
        }
        .onAppear {
            if let prefilled { fill(from: prefilled) }
        }
    }

    private var parsedHosts: [String] {
        hosts.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty }
    }

    private func fill(from link: PairingLink) {
        name = link.name
        hosts = link.hosts.joined(separator: ", ")
        port = String(link.port)
        token = link.token
        deviceId = link.deviceId
        error = nil
    }

    private func connect() async {
        connecting = true
        error = nil
        defer { connecting = false }
        let link = PairingLink(name: name.isEmpty ? "Mac" : name, hosts: parsedHosts, port: Int(port) ?? 8787, token: token, deviceId: deviceId)
        do {
            try await model.pair(with: link)
            if !isOnboarding { dismiss() }
            model.pendingPairing = nil
        } catch {
            self.error = error.localizedDescription + "\nMake sure AgentTote is open on your Mac and both devices are on the same network (or Tailscale)."
        }
    }
}

private struct ScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            QRScannerView(onCode: onCode)
                .ignoresSafeArea()
                .toolbar(.visible, for: .navigationBar)
                .brandNavigationTitle("Scan pairing code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                }
        }
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        DispatchQueue.main.async { try? scanner.startScanning() }
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var delivered = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let code) = item, let payload = code.payloadStringValue, !delivered {
                    delivered = true
                    onCode(payload)
                }
            }
        }
    }
}
