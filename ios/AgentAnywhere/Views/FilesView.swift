import SwiftUI
import PDFKit
import UIKit

struct FilePreviewDestination: Identifiable {
    let path: String
    var id: String { path }
}

struct FilesView: View {
    @Environment(AppModel.self) private var model
    let agent: AgentKind
    let cwd: String
    let sessionId: String?
    @State private var client: BridgeClient?
    @State private var directories: [String] = []
    @State private var listing: RemoteFileList?
    @State private var error: String?
    @State private var loading = false
    @State private var showHidden = false
    @State private var selected: FilePreviewDestination?
    init(agent: AgentKind, cwd: String, sessionId: String?, initialPath: String? = nil) {
        self.agent = agent
        self.cwd = cwd
        self.sessionId = sessionId
        _directories = State(initialValue: initialPath.map { [$0] } ?? [])
    }
    var body: some View {
        NavigationStack {
            List {
                if !directories.isEmpty {
                    Button { directories.removeLast(); Task { await refresh() } } label: { Label("Back", systemImage: "arrow.up") }.disabled(loading)
                }
                if let error { Text(error).foregroundStyle(Brand.failureText) }
                if loading { ProgressView() }
                ForEach(listing?.entries ?? []) { entry in
                    Button {
                        if entry.kind == "dir" { directories.append(entry.path); Task { await refresh() } }
                        else { selected = FilePreviewDestination(path: entry.path) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: entry.blocked ? "lock.fill" : entry.kind == "dir" ? "folder.fill" : "doc")
                                .foregroundStyle(entry.blocked ? Brand.muted : Brand.relayText)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.name).foregroundStyle(entry.blocked ? Brand.muted : Brand.ink)
                                if entry.kind == "file" { Text(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file)).font(.caption).foregroundStyle(Brand.muted) }
                            }
                            Spacer()
                            if entry.kind == "dir" { Image(systemName: "chevron.right").font(.caption) }
                        }
                    }.disabled(entry.blocked || loading)
                }
                if listing?.truncated == true { Text("Showing the first 500 entries.").font(.caption).foregroundStyle(Brand.muted) }
            }
            .scrollContentBackground(.hidden).brandScreen()
            .navigationTitle(directories.last?.lastPathComponentName ?? "Files")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { ClosePreviewButton() }
                ToolbarItem(placement: .primaryAction) {
                    Toggle(isOn: $showHidden) { Label("Show hidden files", systemImage: "eye") }.toggleStyle(.button)
                }
            }
            .refreshable { await refresh() }
            .onChange(of: showHidden) { _, _ in Task { await refresh() } }
            .task { do { client = try model.contentClient(); await refresh() } catch { self.error = error.localizedDescription } }
            .sheet(item: $selected) { file in
                if let client { FilePreviewView(client: client, agent: agent, cwd: cwd, path: file.path, viaRelay: model.contentUsesRelay) }
            }
        }
    }
    private func refresh() async {
        guard let client, !loading else { return }
        loading = true; error = nil; listing = nil
        defer { loading = false }
        do { listing = try await client.call("files.list", ["agent": agent.rawValue, "sessionId": sessionId, "cwd": cwd, "path": directories.last, "showHidden": showHidden]) }
        catch { self.error = error.localizedDescription }
    }
}

struct ChangedFilesView: View {
    @Environment(AppModel.self) private var model
    let task: TaskInfo
    let cwd: String
    let events: [TaskEvent]
    @State private var selected: FilePreviewDestination?
    @State private var client: BridgeClient?
    @State private var error: String?
    private var files: [TaskEvent] {
        var byPath: [String: TaskEvent] = [:]
        for event in events where event.kind == "file" { if let path = event.path { byPath[path] = event } }
        return byPath.values.sorted { ($0.path ?? "") < ($1.path ?? "") }
    }
    var body: some View {
        if !files.isEmpty {
            DisclosureGroup("Changed files (\(files.count))") {
                ForEach(files) { event in
                    if let path = event.path {
                        Button {
                            do { client = try model.contentClient(); selected = FilePreviewDestination(path: path) }
                            catch { self.error = error.localizedDescription }
                        } label: {
                            HStack {
                                Image(systemName: event.change == "deleted" ? "trash" : "doc")
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(path.lastPathComponentName).font(.subheadline)
                                    Text(path.hasPrefix(cwd + "/") ? String(path.dropFirst(cwd.count + 1)) : path)
                                        .font(.caption2).lineLimit(2).truncationMode(.middle)
                                }
                                Spacer()
                            }.foregroundStyle(event.change == "deleted" ? Brand.muted : Brand.relayText).padding(.vertical, 5)
                        }.disabled(event.change == "deleted" || cwd.isEmpty)
                    }
                }
                if let error { Text(error).font(.caption).foregroundStyle(Brand.failureText) }
            }.font(.caption.weight(.medium)).padding(12).brandCard()
            .sheet(item: $selected) { file in
                if let client { FilePreviewView(client: client, agent: task.agent, cwd: cwd, path: file.path, viaRelay: model.contentUsesRelay) }
            }
        }
    }
}

/// Acquire the connection inside the sheet so connection failures are visible too.
struct LocalFilePreviewView: View {
    @Environment(AppModel.self) private var model
    let agent: AgentKind
    let cwd: String
    let path: String
    @State private var client: BridgeClient?
    @State private var error: String?

    var body: some View {
        Group {
            if let client {
                FilePreviewView(client: client, agent: agent, cwd: cwd, path: path,
                                viaRelay: model.contentUsesRelay, allowsDirectory: true)
            } else {
                NavigationStack {
                    VStack {
                        if let error {
                            Text("Unable to open this file").font(.headline)
                            Text(error).foregroundStyle(Brand.failureText).textSelection(.enabled)
                        } else { ProgressView() }
                    }.padding().brandScreen()
                    .navigationTitle(path.lastPathComponentName)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { ClosePreviewButton() } }
                }
            }
        }
        .task {
            do { client = try model.contentClient() }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct FilePreviewView: View {
    let client: BridgeClient
    let agent: AgentKind
    let cwd: String
    let path: String
    let viaRelay: Bool
    var allowsDirectory = false
    @State private var showsDirectory = false
    @State private var data = Data()
    @State private var mime = "application/octet-stream"
    @State private var size = 0
    @State private var loading = true
    @State private var error: String?
    @State private var source = false
    @State private var resolvedRoot: String?
    @State private var resolvedPath: String?
    @State private var shareURL: URL?
    @State private var directory: URL?
    private var type: RemoteFileType { .classify(path: path, mime: mime) }
    private var text: String { String(decoding: data.prefix(1024 * 1024), as: UTF8.self) }
    var body: some View {
        if showsDirectory {
            FilesView(agent: agent, cwd: cwd, sessionId: nil, initialPath: path)
        } else {
            preview
        }
    }
    private var preview: some View {
        NavigationStack {
            VStack(spacing: 8) {
                if loading {
                    ProgressView(value: size == 0 ? nil : Double(data.count), total: Double(max(size, 1)))
                    Text("Downloading \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))")
                        .font(.caption).foregroundStyle(Brand.muted)
                }
                if let error {
                    VStack(spacing: 8) {
                        Text("Unable to open this file").font(.headline)
                        Text(error).foregroundStyle(Brand.failureText).textSelection(.enabled)
                    }.padding()
                }
                if !loading, error == nil { content }
                if loading { Spacer() }
            }.brandScreen()
            .navigationTitle(path.lastPathComponentName).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { ClosePreviewButton() }
                ToolbarItemGroup(placement: .primaryAction) {
                    if type == .markdown { Button(source ? "Rendered" : "Source") { source.toggle() } }
                    if let shareURL { ShareLink(item: shareURL) { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Share or save to Files") }
                }
            }
            .task { await download() }
            .onDisappear { if let directory { try? FileManager.default.removeItem(at: directory) } }
        }
    }
    @ViewBuilder private var content: some View {
        switch type {
        case .text, .markdown:
            if size > 1024 * 1024 { Text("Showing the first 1 MiB. Share to save the complete file.").font(.caption).foregroundStyle(Brand.muted).padding(.horizontal) }
            if type == .markdown && !source {
                ScrollView {
                    ConversationMarkdown(text: text)
                        .frame(maxWidth: 700, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
                .environment(\.markdownImageLocation, MarkdownImageLocation(
                    client: client, agent: agent, root: resolvedRoot ?? cwd,
                    directory: ((resolvedPath ?? path) as NSString).deletingLastPathComponent
                ))
            } else {
                ScrollView([.vertical, .horizontal]) {
                    Text(text).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                }
            }
        case .image:
            if let image = UIImage(data: data) { ZoomableFileImage(image: image) }
            else { fileWebPreview }
        case .pdf: FilePDFView(data: data)
        case .html: fileWebPreview
        case .other:
            VStack(spacing: 16) {
                Image(systemName: "doc.fill").font(.largeTitle).foregroundStyle(Brand.relayText)
                Text(path.lastPathComponentName)
                Text("\(mime) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))").font(.caption).foregroundStyle(Brand.muted)
                if let shareURL { ShareLink("Save to Files", item: shareURL) }
            }.padding(); Spacer()
        }
    }
    private var fileWebPreview: some View {
        let root = resolvedRoot ?? cwd
        let actual = resolvedPath ?? path
        let relative = actual.hasPrefix(root + "/") ? String(actual.dropFirst(root.count)) : "/" + actual.lastPathComponentName
        let encoded = relative.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "?#%"))) ?? relative
        return ContentWebPreview(client: client, source: .files(agent: agent, cwd: cwd), title: path.lastPathComponentName, path: encoded, viaRelay: viaRelay, showsClose: false)
    }
    private func download() async {
        loading = true; error = nil; data = Data()
        do {
            var done = false
            while !done {
                try Task.checkCancellation()
                let chunk: RemoteFileChunk = try await client.call("files.read", ["agent": agent.rawValue, "cwd": cwd, "path": path, "offset": data.count])
                guard chunk.offset == data.count, data.isEmpty || chunk.size == size, chunk.eof || !chunk.data.isEmpty else { throw PreviewHTTP.Failure(message: "File changed during download; reopen it to retry.") }
                resolvedRoot = chunk.root; resolvedPath = chunk.path
                size = chunk.size; mime = chunk.mime; data.append(chunk.data); done = chunk.eof
                guard data.count <= 20 * 1024 * 1024 else { throw PreviewHTTP.Failure(message: "File exceeds 20 MiB") }
            }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("Preview-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            self.directory = directory
            let url = directory.appendingPathComponent(path.lastPathComponentName)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            shareURL = url
        } catch is CancellationError { } catch {
            // files.read checks the authorized target's type before returning bytes.
            // Only this explicit directory/type response triggers browsing; all
            // access-denied, sensitive-file and missing-file errors stay visible.
            if allowsDirectory, data.isEmpty,
               let remote = error as? BridgeClient.RemoteError,
               remote.message == "Not a regular file" {
                showsDirectory = true
            } else { self.error = error.localizedDescription }
        }
        loading = false
    }
}

private struct FilePDFView: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.document = PDFDocument(data: data); return view }
    func updateUIView(_ view: PDFView, context: Context) { }
}
private struct ZoomableFileImage: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView(); scroll.minimumZoomScale = 1; scroll.maximumZoomScale = 6; scroll.delegate = context.coordinator
        let view = UIImageView(image: image); view.contentMode = .scaleAspectFit; view.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(view); context.coordinator.image = view
        NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), view.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor), view.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), view.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor), view.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor), view.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor)])
        return scroll
    }
    func updateUIView(_ view: UIScrollView, context: Context) { }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var image: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { image }
    }
}
