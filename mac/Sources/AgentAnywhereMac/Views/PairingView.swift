import SwiftUI
import CoreImage.CIFilterBuiltins

struct PairingView: View {
    @Environment(BridgeModel.self) private var model
    @State private var confirmingRotation = false
    @State private var rotating = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Text(model.name.isEmpty ? "Pair this Mac" : model.name).font(Brand.title(24, relativeTo: .title2))
            if model.isRunning, !model.pairingUrl.isEmpty {
                if let image = QRCode.image(for: model.pairingUrl) {
                    Image(nsImage: image).interpolation(.none).resizable()
                        .frame(width: 280, height: 280).padding(12).background(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                        .accessibilityLabel("Pairing QR code")
                } else { Text("Couldn't generate the pairing QR code.").foregroundStyle(Brand.failure) }
                BrandWordmark(size: 24)
                Text("Scan with AgentTote on your iPhone.").foregroundStyle(Brand.muted)
                ForEach(model.hosts) { host in
                    HStack {
                        Text("\(host.address):\(model.port)").font(.system(.body, design: .monospaced))
                        Spacer()
                        Text(host.kind == "tailscale" ? "Tailscale" : "LAN").foregroundStyle(Brand.muted)
                    }
                }
                if model.hosts.isEmpty { Text("No reachable network addresses. Connect to Wi-Fi or Tailscale.").foregroundStyle(Brand.muted) }
                Text(model.pairingUrl).font(.caption).textSelection(.enabled).lineLimit(3)
                HStack {
                    Button("Copy link") { copyText(model.pairingUrl) }.buttonStyle(RelayButtonStyle(compact: true))
                    Button("Rotate token…") { confirmingRotation = true }.buttonStyle(OutlineButtonStyle(compact: true)).disabled(rotating)
                    if rotating { ProgressView().controlSize(.small) }
                }
            } else { Text("Start the bridge to pair this Mac.").foregroundStyle(Brand.muted) }
            if let error { Text(error).foregroundStyle(Brand.failure).font(.caption) }
        }
        .padding(24).frame(width: 420).brandScreen()
        .confirmationDialog("Rotate the pairing token?", isPresented: $confirmingRotation, titleVisibility: .visible) {
            Button("Rotate token", role: .destructive) {
                Task {
                    rotating = true
                    error = nil
                    defer { rotating = false }
                    do { try await model.rotatePairing() } catch { self.error = error.localizedDescription }
                }
            }
        } message: {
            Text("All phones paired with this token will be disconnected and must scan the new QR code to pair again.")
        }
    }
}

enum QRCode {
    static func image(for text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
}
