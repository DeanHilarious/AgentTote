import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct AttachmentPickerButton: View {
    @Binding var attachments: [TaskAttachment]
    @Binding var importing: Bool
    @Binding var errorMessage: String?
    let supported: Bool
    @State private var showPhotos = false
    @State private var showDocuments = false
    @State private var photos: [PhotosPickerItem] = []

    var body: some View {
        Menu {
            if supported {
                Button {
                    showPhotos = true
                } label: {
                    Label("Choose photos", systemImage: "photo.on.rectangle")
                }
                Button {
                    showDocuments = true
                } label: {
                    Label("Choose files", systemImage: "folder")
                }
            } else {
                Text("Update AgentTote on your Mac to send attachments.")
            }
        } label: {
            Image(systemName: "paperclip").frame(width: 44, height: 44)
                .foregroundStyle(Brand.relayText).background(Brand.paper, in: Circle())
        }
        .accessibilityLabel("Add attachments")
        .disabled(importing || attachments.count >= TaskAttachment.maxCount)
        .photosPicker(
            isPresented: $showPhotos, selection: $photos,
            maxSelectionCount: max(1, TaskAttachment.maxCount - attachments.count),
            matching: .images, preferredItemEncoding: .compatible
        )
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            load(count: items.count) {
                var files: [TaskAttachment] = []
                for item in items {
                    guard let photo = try await item.loadTransferable(type: PickedPhoto.self) else {
                        throw TaskAttachment.Failure.unreadablePhoto
                    }
                    files.append(photo.attachment)
                }
                return files
            }
        }
        .fileImporter(isPresented: $showDocuments, allowedContentTypes: [.data], allowsMultipleSelection: true) {
            result in
            switch result {
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError { errorMessage = error.localizedDescription }
            case .success(let urls):
                load(count: urls.count) {
                    var files: [TaskAttachment] = []
                    for url in urls { files.append(try await TaskAttachment.importDocument(url)) }
                    return files
                }
            }
        }
    }

    private func load(count: Int, _ operation: @escaping () async throws -> [TaskAttachment]) {
        guard count <= TaskAttachment.maxCount - attachments.count else {
            errorMessage = TaskAttachment.Failure.tooMany.localizedDescription
            return
        }
        importing = true
        errorMessage = nil
        Task {
            defer { importing = false }
            do { attachments += try await operation() } catch { errorMessage = error.localizedDescription }
        }
    }
}

private struct PickedPhoto: Transferable {
    let attachment: TaskAttachment

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            try Self(attachment: importPhoto(received.file))
        }
    }

    private static func importPhoto(_ url: URL) throws -> TaskAttachment {
        let file = try TaskAttachment(file: url)
        guard let source = CGImageSourceCreateWithData(file.bytes as CFData, nil),
            let typeID = CGImageSourceGetType(source),
            let type = UTType(typeID as String)
        else { throw TaskAttachment.Failure.unreadablePhoto }
        let stem = url.deletingPathExtension().lastPathComponent
        if [.jpeg, .png, .gif, .webP].contains(type) {
            if UTType(filenameExtension: url.pathExtension) == type { return file }
            let ext = type.preferredFilenameExtension ?? url.pathExtension
            return try TaskAttachment(name: "\(stem).\(ext)", bytes: file.bytes)
        }

        // Photos may still hand back HEIC or RAW. Bound decoding and apply camera orientation for agent input.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 4096,
        ]
        let jpeg = NSMutableData()
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
            let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil)
        else { throw TaskAttachment.Failure.unreadablePhoto }
        CGImageDestinationAddImage(
            destination, image, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw TaskAttachment.Failure.unreadablePhoto }
        return try TaskAttachment(name: "\(stem).jpg", bytes: jpeg as Data)
    }
}
