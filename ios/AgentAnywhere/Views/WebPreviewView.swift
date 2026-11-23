import SwiftUI
import WebKit

struct WebPreviewDestination: Identifiable {
    let id = UUID()
    let target: WebPreviewTarget
    var path = "/"
}

struct WebPreviewView: View {
    @Environment(AppModel.self) private var model
    let destination: WebPreviewDestination
    @State private var client: BridgeClient?
    @State private var error: String?
    var body: some View {
        Group {
            if let client {
                ContentWebPreview(client: client, source: .service(port: destination.target.port),
                    title: "localhost:\(destination.target.port) · \(destination.target.process)",
                    path: destination.path, viaRelay: model.contentUsesRelay)
            } else {
                NavigationStack {
                    Text(error ?? "Connecting…").padding()
                        .toolbar { ToolbarItem(placement: .cancellationAction) { ClosePreviewButton() } }
                }
            }
        }.task { do { client = try model.contentClient() } catch { self.error = error.localizedDescription } }
    }
}

struct ClosePreviewButton: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View { Button("Close") { dismiss() } }
}

@MainActor @Observable
private final class PreviewBrowserState {
    var web: WKWebView?
    var canGoBack = false
    var canGoForward = false
    var error: String?
    func update(_ web: WKWebView) { canGoBack = web.canGoBack; canGoForward = web.canGoForward }
}

struct ContentWebPreview: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    let client: BridgeClient
    let source: LocalPreviewProxy.Source
    let title: String
    let path: String
    let viaRelay: Bool
    var showsClose = true
    @State private var proxy: LocalPreviewProxy?
    @State private var browser = PreviewBrowserState()
    @State private var url: URL?
    @State private var error: String?
    @State private var showFailures = false
    @State private var boundMacId: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if showsClose { ClosePreviewButton() }
                Text(title).font(.caption.monospaced()).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Button { browser.web?.goBack() } label: { Image(systemName: "chevron.left") }.disabled(!browser.canGoBack).accessibilityLabel("Back")
                Button { browser.web?.goForward() } label: { Image(systemName: "chevron.right") }.disabled(!browser.canGoForward).accessibilityLabel("Forward")
                Button { browser.web?.reload() } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Refresh")
            }.padding(12).background(Brand.paper)
            if viaRelay {
                Text("Loaded through your Mac over an encrypted connection; live reload isn't supported yet.")
                    .font(.caption2).foregroundStyle(Brand.muted).padding(.horizontal, 12).padding(.bottom, 8)
            }
            if let error = error ?? proxy?.error ?? browser.error {
                Text(error).font(.caption).foregroundStyle(Brand.failureText).padding()
                Button("Retry") { Task { await start() } }
            }
            if let proxy, !proxy.failures.isEmpty {
                DisclosureGroup("Some resources couldn't load (\(proxy.failures.count))", isExpanded: $showFailures) {
                    ForEach(Array(proxy.failures.enumerated()), id: \.offset) { _, failure in Text(failure).font(.caption2).textSelection(.enabled) }
                }.font(.caption).padding(8)
            }
            if let url, let proxy { ProxyWebView(url: url, proxy: proxy, state: browser).id(url) }
            else { Spacer(); ProgressView(); Spacer() }
        }
        .background(Brand.paper)
        .task { await start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await start() } }
            else { browser.web?.stopLoading(); proxy?.stop(); url = nil }
        }
        .onChange(of: model.isConnected) { _, connected in
            if connected { Task { await start() } }
            else { browser.web?.stopLoading(); proxy?.stop(); url = nil }
        }
        .onChange(of: model.selectedMacId) { _, _ in
            browser.web?.stopLoading(); proxy?.stop(); url = nil
            error = "This preview belongs to a different Mac. Close it and open a new preview."
        }
        .onDisappear { browser.web?.stopLoading(); proxy?.stop() }
    }
    private func start() async {
        guard scenePhase == .active, proxy?.origin == nil else { return }
        if boundMacId == nil { boundMacId = model.selectedMacId }
        guard boundMacId == model.selectedMacId else { return }
        error = nil; browser.error = nil
        do {
            // Reconnect only to the originally selected Mac when returning to foreground.
            let currentClient = client.isReady ? client : try model.contentClient()
            proxy?.stop()
            let proxy = LocalPreviewProxy(client: currentClient, source: source); self.proxy = proxy
            let origin = try await proxy.start()
            guard self.proxy === proxy, scenePhase == .active, boundMacId == model.selectedMacId else { proxy.stop(); return }
            url = URL(string: PreviewHTTP.localURL(path, origin: origin, token: proxy.token))
        } catch is CancellationError { } catch { self.error = error.localizedDescription }
    }
}

private struct ProxyWebView: UIViewRepresentable {
    let url: URL
    let proxy: LocalPreviewProxy
    let state: PreviewBrowserState
    func makeCoordinator() -> Coordinator { Coordinator(proxy: proxy, state: state) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source: proxy.routingScript(), injectionTime: .atDocumentStart, forMainFrameOnly: false))
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        state.web = web
        web.load(URLRequest(url: url))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) { }
    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) { web.stopLoading(); web.navigationDelegate = nil }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        let proxy: LocalPreviewProxy
        let state: PreviewBrowserState
        init(proxy: LocalPreviewProxy, state: PreviewBrowserState) { self.proxy = proxy; self.state = state }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { state.update(webView) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { state.error = error.localizedDescription; state.update(webView) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { state.error = error.localizedDescription }
            state.update(webView)
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // `URL.path` drops a trailing slash, which made "/<token>/" look unprefixed and get prefixed twice.
            let prefix = "/\(proxy.token)"
            if let url = action.request.url, let origin = proxy.origin,
               url.host == "127.0.0.1", url.port == URL(string: origin)?.port,
               case let path = url.path(percentEncoded: true), path != prefix, !path.hasPrefix(prefix + "/") {
                var request = action.request
                request.url = URL(string: origin + prefix + (path.isEmpty ? "/" : path) + (url.query(percentEncoded: true).map { "?" + $0 } ?? ""))
                decisionHandler(.cancel); webView.load(request); return
            }
            decisionHandler(.allow)
        }
    }
}

struct WebPreviewsSection: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var targets: [WebPreviewTarget] = []
    @State private var destination: WebPreviewDestination?
    private struct ProjectGroup { let name: String; let cwd: String?; let targets: [WebPreviewTarget] }
    /// Servers grouped by the project that started them; ones with no known project go last.
    private var groups: [ProjectGroup] {
        let byProject = Dictionary(grouping: targets) { $0.project ?? "" }
        return byProject.map { ProjectGroup(name: $0.key.isEmpty ? String(localized: "Other") : $0.key, cwd: $0.value.first?.cwd, targets: $0.value) }
            .sorted { ($0.cwd == nil ? 1 : 0, $0.name.localizedLowercase) < ($1.cwd == nil ? 1 : 0, $1.name.localizedLowercase) }
    }
    var body: some View {
        // An empty Group never appears, so a task attached to it would never run; poll from an
        // always-present zero-height view and show the section only when there is something to list.
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 0)
            if !targets.isEmpty, model.isConnected {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Running on your Mac").font(Brand.title(20, relativeTo: .title3))
                    ForEach(groups, id: \.name) { group in
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Image(systemName: group.cwd == nil ? "questionmark.folder" : "folder.fill").foregroundStyle(Brand.relayText)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: group.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    if let cwd = group.cwd {
                                        Text(verbatim: cwd.abbreviatedPath).font(.caption).foregroundStyle(Brand.muted)
                                            .lineLimit(1).truncationMode(.head)
                                    }
                                }
                            }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
                            ForEach(group.targets) { target in
                                Button { destination = WebPreviewDestination(target: target) } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: "globe").foregroundStyle(Brand.muted)
                                        Text(verbatim: "localhost:\(target.port)").font(.subheadline.monospaced())
                                        Text(target.process).font(.caption).foregroundStyle(Brand.muted)
                                        Spacer()
                                        if target.source == "task" { Text("from task").font(.caption2).foregroundStyle(Brand.relayText) }
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(Brand.muted)
                                    }.frame(minHeight: 44).padding(.horizontal, 16).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                            }
                            Spacer().frame(height: 4)
                        }.frame(maxWidth: .infinity, alignment: .leading).brandCard()
                    }
                }
            }
        }
        .task(id: "\(model.selectedMacId ?? ""):\(model.isConnected):\(scenePhase)") {
            targets = []
            guard model.isConnected, scenePhase == .active else { return }
            while !Task.isCancelled {
                do { targets = try await model.previewTargets() } catch { targets = [] }
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
            }
        }
        .fullScreenCover(item: $destination) { WebPreviewView(destination: $0) }
        .onChange(of: model.selectedMacId) { _, _ in destination = nil; targets = [] }
    }
}
