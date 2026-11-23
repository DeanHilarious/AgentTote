import Foundation
import Network

struct BonjourAddress: Equatable {
    let host: String
    let port: Int

    init?(endpoint: NWEndpoint?) {
        guard case .hostPort(.ipv4(let address), let port) = endpoint, port.rawValue > 0,
              let host = Self.ipv4Host(rawValue: address.rawValue) else { return nil }
        self.host = host
        self.port = Int(port.rawValue)
    }

    /// Interface scopes belong to routing, not the host in an IPv4 WebSocket URL.
    static func ipv4Host(rawValue: Data) -> String? {
        let octets = Array(rawValue)
        guard octets.count == 4, octets[0] > 0, octets[0] < 224 else { return nil }
        return octets.map(String.init).joined(separator: ".")
    }
}

struct BonjourResolutionPolicy {
    var deviceIds: Set<UUID> = []
    var selectedDeviceId: UUID?
    var isConnected = false

    var pollingDeviceId: UUID? {
        guard !isConnected, let id = selectedDeviceId, deviceIds.contains(id) else { return nil }
        return id
    }

    func changedTargets(in results: [NWEndpoint: UUID], endpoints: Set<NWEndpoint>) -> Set<NWEndpoint> {
        Set(endpoints.filter { endpoint in
            results[endpoint].map { deviceIds.contains($0) } ?? false
        })
    }

    func pollingTargets(in results: [NWEndpoint: UUID]) -> Set<NWEndpoint> {
        guard let id = pollingDeviceId else { return [] }
        return Set(results.filter { $0.value == id }.keys)
    }
}

/// Bonjour supplies candidates only. BridgeClient still authenticates every connection.
@MainActor
final class BonjourDiscovery {
    var onAddress: ((UUID, BonjourAddress) -> Void)?
    private let queue = DispatchQueue(label: "AgentAnywhere.bonjour")
    private var browser: NWBrowser?
    private var results: Set<NWBrowser.Result> = []
    private var policy = BonjourResolutionPolicy()
    private struct Resolution {
        let deviceId: UUID
        let connection: NWConnection
    }
    private var resolutions: [NWEndpoint: Resolution] = [:]
    private var deadlines: [NWEndpoint: Task<Void, Never>] = [:]
    private var pollTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var active = false
    private var retryAttempt = 0

    func updateDeviceIds(_ ids: Set<UUID>) {
        guard policy.deviceIds != ids else { return }
        let added = ids.subtracting(policy.deviceIds)
        policy.deviceIds = ids
        let endpoints = Set(resultDevices().filter { added.contains($0.value) }.keys)
        resolveResults(endpoints: endpoints)
        updatePolling()
    }

    func updateConnection(selectedDeviceId: UUID?, isConnected: Bool) {
        guard policy.selectedDeviceId != selectedDeviceId || policy.isConnected != isConnected else { return }
        policy.selectedDeviceId = selectedDeviceId
        policy.isConnected = isConnected
        updatePolling()
        resolveResults(endpoints: policy.pollingTargets(in: resultDevices()))
    }

    func start() {
        guard !active else { return }
        active = true
        retryAttempt = 0
        browse()
        updatePolling()
    }

    private func updatePolling() {
        guard active, policy.pollingDeviceId != nil else {
            pollTask?.cancel()
            pollTask = nil
            return
        }
        guard pollTask == nil else { return }
        pollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard let self else { return }
                self.resolveResults(endpoints: self.policy.pollingTargets(in: self.resultDevices()))
            }
        }
    }

    func stop() {
        active = false
        pollTask?.cancel()
        pollTask = nil
        retryTask?.cancel()
        retryTask = nil
        browser?.cancel()
        browser = nil
        results = []
        cancelResolutions()
    }

    deinit {
        pollTask?.cancel()
        retryTask?.cancel()
        browser?.cancel()
        for resolution in resolutions.values { resolution.connection.cancel() }
        for deadline in deadlines.values { deadline.cancel() }
    }

    private func browse() {
        guard active, browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_agentanywhere._tcp", domain: nil), using: .tcp)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self, weak browser] results, changes in
            Task { @MainActor [weak self, weak browser] in
                guard let self, let browser, self.browser === browser, self.active else { return }
                var changed = Set(results.subtracting(self.results).map(\.endpoint))
                for change in changes {
                    switch change {
                    case .added(let result), .changed(_, let result, _): changed.insert(result.endpoint)
                    default: break
                    }
                }
                self.results = results
                // Discard any resolution started before an interface/TXT update.
                for endpoint in changed { self.finish(endpoint) }
                let targets = self.policy.changedTargets(in: self.resultDevices(), endpoints: changed)
                self.resolveResults(endpoints: targets)
            }
        }
        browser.stateUpdateHandler = { [weak self, weak browser] state in
            Task { @MainActor [weak self, weak browser] in
                guard let self, let browser, self.browser === browser, self.active else { return }
                switch state {
                case .ready: self.retryAttempt = 0
                case .failed:
                    self.browser = nil
                    browser.cancel()
                    self.results = []
                    self.cancelResolutions()
                    let delay = min(30.0, pow(2.0, Double(min(self.retryAttempt, 5))))
                    self.retryAttempt += 1
                    self.retryTask = Task { @MainActor [weak self] in
                        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                        guard let self, self.active else { return }
                        self.retryTask = nil
                        self.browse()
                    }
                default: break
                }
            }
        }
        browser.start(queue: queue)
    }

    private func resultDevices() -> [NWEndpoint: UUID] {
        var devices: [NWEndpoint: UUID] = [:]
        for result in results {
            if let id = Self.deviceId(in: result.metadata) { devices[result.endpoint] = id }
        }
        return devices
    }

    private func resolveResults(endpoints: Set<NWEndpoint>) {
        guard active else { return }
        let eligible = resultDevices().filter { policy.deviceIds.contains($0.value) }
        for endpoint in Array(resolutions.keys) where eligible[endpoint] != resolutions[endpoint]?.deviceId { finish(endpoint) }
        for endpoint in endpoints where resolutions[endpoint] == nil {
            if let id = eligible[endpoint] { resolve(endpoint, deviceId: id) }
        }
    }

    static func deviceId(in metadata: NWBrowser.Result.Metadata) -> UUID? {
        guard case .bonjour(let txt) = metadata, let value = txt.dictionary["device"] else { return nil }
        return UUID(uuidString: value)
    }

    private func resolve(_ endpoint: NWEndpoint, deviceId: UUID) {
        let parameters = NWParameters.tcp
        (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        let connection = NWConnection(to: endpoint, using: parameters)
        resolutions[endpoint] = Resolution(deviceId: deviceId, connection: connection)
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            Task { @MainActor [weak self, weak connection] in
                guard let self, let connection, self.active, self.policy.deviceIds.contains(deviceId),
                      self.resolutions[endpoint]?.connection === connection else { return }
                switch state {
                case .ready:
                    // TXT identity may have changed while this endpoint was resolving.
                    guard self.results.contains(where: { $0.endpoint == endpoint && Self.deviceId(in: $0.metadata) == deviceId }) else {
                        self.finish(endpoint)
                        return
                    }
                    let address = BonjourAddress(endpoint: connection.currentPath?.remoteEndpoint)
                    self.finish(endpoint)
                    if let address { self.onAddress?(deviceId, address) }
                case .failed, .cancelled: self.finish(endpoint)
                default: break
                }
            }
        }
        deadlines[endpoint] = Task { @MainActor [weak self, weak connection] in
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard let self, let connection, self.resolutions[endpoint]?.connection === connection else { return }
            self.finish(endpoint)
        }
        connection.start(queue: queue)
    }

    private func finish(_ endpoint: NWEndpoint) {
        deadlines.removeValue(forKey: endpoint)?.cancel()
        resolutions.removeValue(forKey: endpoint)?.connection.cancel()
    }

    private func cancelResolutions() {
        for endpoint in Array(resolutions.keys) { finish(endpoint) }
    }
}
