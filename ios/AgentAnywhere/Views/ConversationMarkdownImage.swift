import ImageIO
import SwiftUI

struct MarkdownImageLocation {
    let client: BridgeClient?
    let agent: AgentKind
    let root: String
    let directory: String
}

private struct MarkdownImageLocationKey: EnvironmentKey {
    static let defaultValue: MarkdownImageLocation? = nil
}

extension EnvironmentValues {
    var markdownImageLocation: MarkdownImageLocation? {
        get { self[MarkdownImageLocationKey.self] }
        set { self[MarkdownImageLocationKey.self] = newValue }
    }
}

struct ConversationMarkdownImage: View {
    @Environment(\.markdownImageLocation) private var location
    let alt: String
    let destination: String
    @State private var image: UIImage?
    @State private var error: String?

    private struct Request: Hashable {
        let connection: ObjectIdentifier?
        let agent: AgentKind?
        let root: String?
        let path: String?
    }

    var body: some View {
        if let url = URL(string: destination), url.scheme?.lowercased() == "https" {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let loaded): figure(loaded)
                case .failure: Link(alt.isEmpty ? destination : alt, destination: url)
                default: ProgressView()
                }
            }
        } else {
            let path = URL(string: destination).flatMap {
                LocalFileLink.resolve(url: $0, cwd: location?.directory ?? "")
            }
            let request = Request(
                connection: location?.client.map(ObjectIdentifier.init),
                agent: location?.agent, root: location?.root, path: path)
            Group {
                if let image {
                    figure(Image(uiImage: image))
                } else if let error {
                    VStack(alignment: .leading) {
                        Label(alt.isEmpty ? destination : alt, systemImage: "photo")
                        Text(LocalizedStringKey(error)).font(.caption).foregroundStyle(.secondary)
                    }
                } else {
                    ProgressView()
                }
            }
            .task(id: request) {
                image = nil
                error = nil
                do {
                    guard let location, let client = location.client, let path else {
                        throw PreviewHTTP.Failure(message: "Image unavailable")
                    }
                    let loaded = try await Self.read(path, from: client, in: location)
                    try Task.checkCancellation()
                    image = loaded
                } catch {
                    if !Task.isCancelled { self.error = error.localizedDescription }
                }
            }
        }
    }

    private func figure(_ image: Image) -> some View {
        image.resizable().scaledToFit().accessibilityLabel(Text(alt.isEmpty ? destination : alt))
    }

    @MainActor private static func read(
        _ path: String, from client: BridgeClient,
        in location: MarkdownImageLocation
    ) async throws -> UIImage {
        var data = Data()
        var size: Int?
        repeat {
            try Task.checkCancellation()
            let chunk: RemoteFileChunk = try await client.call(
                "files.read",
                [
                    "agent": location.agent.rawValue, "cwd": location.root, "path": path, "offset": data.count,
                ])
            guard chunk.mime.hasPrefix("image/"), (1...20 * 1024 * 1024).contains(chunk.size),
                size == nil || size == chunk.size, chunk.offset == data.count, !chunk.data.isEmpty,
                data.count + chunk.data.count <= chunk.size
            else {
                throw PreviewHTTP.Failure(message: "Unable to read image")
            }
            size = chunk.size
            data.append(chunk.data)
            if chunk.eof {
                guard data.count == chunk.size else {
                    throw PreviewHTTP.Failure(message: "Unable to read image")
                }
                break
            }
        } while true
        let imageData = data
        return try await Task.detached(priority: .userInitiated) { try thumbnail(from: imageData) }.value
    }

    nonisolated private static func thumbnail(from data: Data) throws -> UIImage {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
        ]
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
            let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        {
            return UIImage(cgImage: thumbnail)
        }
        // UIKit additionally supports vector image formats on recent iOS versions.
        guard let image = UIImage(data: data) else {
            throw PreviewHTTP.Failure(message: "Unable to read image")
        }
        return image
    }
}
