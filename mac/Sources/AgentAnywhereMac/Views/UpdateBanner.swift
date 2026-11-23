import SwiftUI

struct UpdateBanner: View {
    @Environment(Updater.self) private var updater
    @Environment(BridgeModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let release = updater.available {
                Text("AgentTote v\(release.version) is available").font(.headline)
                Text("Build \(release.build)").font(.caption).foregroundStyle(Brand.muted)
                if let notes = release.notes, !notes.isEmpty {
                    ScrollView { Text(notes).font(.caption).frame(maxWidth: .infinity, alignment: .leading) }
                        .frame(maxHeight: 90)
                }
                if updater.installing {
                    ProgressView(value: updater.progress)
                    if updater.canCancel { Button("Cancel") { updater.cancel() } }
                } else if let reason = updater.fallbackReason {
                    Text(reason).font(.caption)
                    Button("Download from website") { NSWorkspace.shared.open(UpdatePolicy.downloadPage) }
                } else {
                    Button("Update and Restart") { updater.install(model: model) }.disabled(updater.checking)
                }
            }
            if let status = updater.status { Text(status).font(.caption).foregroundStyle(Brand.muted) }
            if let failure = updater.failure { Text(failure).font(.caption).foregroundStyle(Brand.failureText) }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
