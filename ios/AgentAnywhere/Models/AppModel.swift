import Foundation
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class AppModel {
    enum Connection: Equatable {
        case idle
        case connecting
        case connected(host: String, viaRelay: Bool)
        case failed(String)
    }

    private(set) var macs: [PairedMac]
    private(set) var selectedMacId: String? { didSet { updateBonjourConnection() } }
    let account: AccountStore
    private(set) var connection: Connection = .idle {
        didSet {
            if case .failed = connection {} else { connectionFailureNeedsSignIn = false }
            updateBonjourConnection()
        }
    }
    private(set) var connectionFailureNeedsSignIn = false
    private(set) var isReconnecting = false
    private(set) var bridgeVersion: String?
    let agentIcons = AgentIconStore()
    let modelSelections = ModelSelectionStore()
    private(set) var agents: [AgentInfo] = []
    private(set) var sessions: [AgentKind: [SessionSummary]] = [:]
    private(set) var tasks: [String: TaskInfo] = [:]
    private(set) var events: [String: [TaskEvent]] = [:]
    // Draft observations belong to the draft bubble, not the conversation's event list.
    let draftStore = TaskDraftStore()
    var drafts: [String: TaskDraft] { draftStore.drafts }
    /// A pairing link opened from the system camera, waiting for the user to confirm.
    var pendingPairing: PairingLink?
    var navigationPath = NavigationPath()
    private(set) var notificationNavigationRevision = 0
    let notifications = PushRegistration.shared
    private(set) var pushStatus: PushStatus?
    private(set) var pushRegistrationFailed = false
    private(set) var bridgeDeviceId: String?

    @ObservationIgnored private var registeredPushToken: String?
    @ObservationIgnored private var pushRegistrationTask: Task<Bool, Never>?
    @ObservationIgnored private var watchRevisions: [String: Int] = [:]

    @ObservationIgnored private var client = BridgeClient()
    @ObservationIgnored private var connectionTask: Task<Void, Error>?
    @ObservationIgnored private var connectionGeneration = 0
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    @ObservationIgnored private var reconnectAttempt = 0
    @ObservationIgnored private var inForeground = true
    @ObservationIgnored private var leftForegroundAt: ContinuousClock.Instant?
    @ObservationIgnored private var recoveryDeadlineTask: Task<Void, Never>?
    @ObservationIgnored private let networkMonitor = PhoneNetworkMonitor()
    @ObservationIgnored private var needsAddressRefresh = false
    @ObservationIgnored private var lastAddressRefresh: [UUID: ContinuousClock.Instant] = [:]
    @ObservationIgnored private var addressRefreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshingConnectionGeneration: Int?
    @ObservationIgnored private var knownDeviceHosts: [UUID: Set<String>] = [:]
    @ObservationIgnored private let bonjour = BonjourDiscovery()
    @ObservationIgnored private var bonjourAddresses: [UUID: BonjourAddress] = [:]
    @ObservationIgnored private var pairingInProgress = false
    @ObservationIgnored private var activeRace: ConnectionRace<BridgeClient.Connected>?
    @ObservationIgnored private var racePreferredPath: ConnectionPath?
    @ObservationIgnored private var recoveryStartedAt: ContinuousClock.Instant?
    @ObservationIgnored private var recoveryError: Error = BridgeClient.ClientError.notConnected
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var backgroundTimeExpired = false
    @ObservationIgnored private var ticketPrefetchTask: Task<Void, Never>?
    @ObservationIgnored private var backgroundPrefetchTask: Task<Void, Never>?
    @ObservationIgnored private var lastPaths: [String: ConnectionPath] = {
        guard let data = UserDefaults.standard.data(forKey: "lastConnectionPaths") else { return [:] }
        return (try? JSONDecoder().decode([String: ConnectionPath].self, from: data)) ?? [:]
    }()

    init(account: AccountStore? = nil) {
        self.account = account ?? AccountStore()
        macs = MacStore.load()
        let saved = MacStore.selectedId.flatMap { id in macs.first { $0.id == id } } ?? macs.first
        selectedMacId = saved.map { MacSelection.paired($0).id }
        self.account.onChange = { [weak self] in self?.accountDidChange() }
        client.onPush = { [weak self] in self?.handlePush($0) }
        client.onDisconnect = { [weak self] in self?.handleDisconnect($0) }
        notifications.onToken = { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.registeredPushToken = nil
                guard await self.registerPush() else { return }
                await self.syncTasks()
            }
        }
        notifications.onOpen = { [weak self] in self?.openPendingNotification() }
        bonjour.onAddress = { [weak self] id, address in self?.discoveredAddress(address, for: id) }
        networkMonitor.onChange = { [weak self] in
            guard let self, self.inForeground else { return }
            if self.isConnected { self.client.ping() }
            else { self.reconnectImmediately() }
        }
        knownDeviceHosts = Dictionary(uniqueKeysWithValues: self.account.devices.map { ($0.id, Set($0.hosts)) })
        reconcileMacs()
    }

    deinit {
        ticketPrefetchTask?.cancel()
        backgroundPrefetchTask?.cancel()
        recoveryDeadlineTask?.cancel()
        reconnectTask?.cancel()
        connectionTask?.cancel()
        let identifier = backgroundTask
        if identifier != .invalid {
            Task { @MainActor in UIApplication.shared.endBackgroundTask(identifier) }
        }
    }

    var availableMacs: [MacSelection] {
        MacSelection.available(paired: macs, devices: account.devices)
    }

    var selectedMac: MacSelection? { availableMacs.first { $0.id == selectedMacId } }
    var selectedPairedMac: PairedMac? { pairedMac(for: selectedMac) }

    private var selectedDeviceId: UUID? {
        switch selectedMac {
        case .account(let device): device.id
        case .paired(let paired): paired.deviceId
        case nil: nil
        }
    }

    private func updateBonjourConnection() {
        bonjour.updateConnection(selectedDeviceId: inForeground ? selectedDeviceId : nil,
                                 isConnected: isConnected)
    }

    private func pairedMac(for selection: MacSelection?) -> PairedMac? {
        switch selection {
        case .paired(let paired): return macs.first { $0.id == paired.id }
        case .account(let device):
            let matches = macs.filter { $0.deviceId == device.id }
            return matches.first { Keychain.token(for: $0.id) != nil } ?? matches.first
        case nil: return nil
        }
    }

    var isConnected: Bool {
        if case .connected = connection { return true }
        return false
    }

    func agent(_ kind: AgentKind) -> AgentInfo? { agents.first { $0.kind == kind } }

    var enabledAgentKinds: [AgentKind] { agents.map(\.kind) }

    var recentTasks: [TaskInfo] { tasks.values.filter { $0.status == .running || enabledAgentKinds.contains($0.agent) }.sorted { $0.startedAt > $1.startedAt } }

    func tasks(agent: AgentKind, sessionId: String?) -> [TaskInfo] {
        guard let sessionId else { return [] }
        return tasks.values.filter { $0.agent == agent && $0.sessionId == sessionId }.sorted { $0.startedAt < $1.startedAt }
    }

    // MARK: - Pairing & connection

    func start() {
        openPendingNotification()
        if inForeground {
            bonjour.start()
            Task { await connect() }
        }
        updateBonjourConnection()
    }

    /// Connects with a scanned/typed link and, if the Mac answers, remembers it.
    func pair(with link: PairingLink) async throws {
        let mac = PairedMac(id: UUID(), name: link.name, hosts: link.hosts, port: link.port, lastGoodHost: nil, deviceId: link.deviceId, publicKey: link.publicKey)
        invalidateConnection()
        let epoch = connectionGeneration
        connection = .connecting
        pairingInProgress = true
        defer { pairingInProgress = false }
        let task = Task { @MainActor in
            do {
                let result = try await BridgeClient.connect(to: mac, token: link.token)
                do { try self.checkConnection(epoch) }
                catch { result.client.disconnect(); throw error }
                try self.install(result.client)
                let (host, hello) = (result.host, result.hello)
                let deviceId = hello.deviceId.flatMap(UUID.init(uuidString:)) ?? link.deviceId
                let matches = PairedMac.pairingMatches(in: self.macs, deviceId: deviceId, name: link.name, port: link.port)
                let existing = matches.first
                let saved = PairedMac(id: existing?.id ?? mac.id, name: hello.name, hosts: link.hosts,
                                      port: link.port, lastGoodHost: host, deviceId: deviceId ?? existing?.deviceId, publicKey: link.publicKey ?? existing?.publicKey)
                let replacedIds = Set(matches.map(\.id))
                for id in replacedIds { Keychain.deleteToken(for: id) }
                Keychain.setToken(link.token, for: saved.id)
                self.macs.removeAll { replacedIds.contains($0.id) }
                self.macs.append(saved)
                MacStore.save(self.macs)
                self.selectedMacId = MacSelection.paired(saved).id
                MacStore.selectedId = saved.id
                self.rememberPath(result.path, for: .paired(saved))
                self.didConnect(host: host, hello: hello)
                self.reconcileMacs()
            } catch {
                let error = self.connectionError(error)
                if epoch == self.connectionGeneration { self.failConnection(error, selection: .paired(mac)) }
                throw error
            }
        }
        connectionTask = task
        defer { if epoch == connectionGeneration { connectionTask = nil } }
        try await task.value
    }

    func select(_ mac: MacSelection) {
        guard mac.id != selectedMacId else { return }
        invalidateConnection()
        navigationPath = NavigationPath()
        selectedMacId = mac.id
        if case .paired(let paired) = mac { MacStore.selectedId = paired.id }
        Task { await connect() }
    }

    private var removingMac = false
    private(set) var removingMacIDs: Set<String> = []

    func removeMac(_ mac: MacSelection) async throws {
        guard removingMacIDs.isEmpty else { return }
        removingMacIDs.insert(mac.id)
        defer { removingMacIDs.remove(mac.id) }
        switch mac {
        case .paired(let paired): forget(paired)
        case .account(let device):
            // The account callback must not temporarily select the hidden QR duplicate.
            removingMac = true
            defer { removingMac = false; reconcileMacs() }
            try await account.removeDevice(device)
            clearPairings(for: mac)
        }
    }

    func forget(_ mac: PairedMac) {
        clearPairings(for: .paired(mac))
        reconcileMacs()
    }

    private func clearPairings(for mac: MacSelection) {
        let ids = mac.pairingIDsToRemove(from: macs)
        macs = mac.removingPairings(from: macs) { Keychain.deleteToken(for: $0) }
        MacStore.save(macs)
        if let saved = MacStore.selectedId, ids.contains(saved) { MacStore.selectedId = nil }
    }

    func connect() async {
        guard let mac = selectedMac else { return }
        if isConnected || connection == .connecting || connectionTask != nil { return }
        if case .paired(let paired) = mac, Keychain.token(for: paired.id) == nil {
            connection = .failed("Pairing token missing. Scan the QR code again.")
            return
        }
        reconnectTask?.cancel()
        if recoveryStartedAt == nil || isReconnecting { connection = .connecting }
        let epoch = connectionGeneration
        let task = Task { @MainActor in
            let race = ConnectionRace<BridgeClient.Connected>(report: ConnectionDiagnostics.reporter())
            self.activeRace = race
            self.racePreferredPath = self.lastPaths[self.pathKey(for: mac)] ?? self.pairedMac(for: mac)?.lastGoodHost.map {
                ConnectionPath.direct(host: $0, port: self.directAddress(for: mac).port)
            }
            self.addDirectRoutes(for: mac, to: race, epoch: epoch)
            if case .account(let device) = mac, self.account.isSignedIn, device.publicKey != nil {
                let candidate = BridgeClient()
                race.add(.init(path: .relay, delay: ConnectionSchedule.delay(for: .relay, preferred: self.racePreferredPath), operation: {
                    let key = try self.relayPublicKey(for: device)
                    async let ticket = self.account.connectionTicket(for: device)
                    async let access = self.account.validAccessToken()
                    let credentials = try await (ticket, access)
                    try self.checkConnection(epoch)
                    let hello = try await candidate.connectRelay(server: self.account.serverAddress, deviceId: device.id,
                                                                 publicKey: key, accessToken: credentials.1, ticket: credentials.0)
                    return BridgeClient.Connected(client: candidate, path: .relay, hello: hello)
                }, cancel: { candidate.disconnect() }))
            }
            // Address discovery is an additional producer, never a gate before dialing.
            let refresh = Task { @MainActor in
                if case .account(let device) = mac, self.needsAddressRefresh {
                    self.refreshingConnectionGeneration = epoch
                    await self.refreshAddresses(for: device.id)
                    if self.refreshingConnectionGeneration == epoch { self.refreshingConnectionGeneration = nil }
                    if !Task.isCancelled, epoch == self.connectionGeneration, let latest = self.selectedMac {
                        self.addDirectRoutes(for: latest, to: race, epoch: epoch)
                        self.needsAddressRefresh = false
                    }
                }
                race.finishAdding()
            }
            defer {
                refresh.cancel()
                if self.activeRace === race { self.activeRace = nil }
            }
            let result = try await race.value()
            do { try self.checkConnection(epoch) }
            catch { result.client.disconnect(); throw error }
            try self.install(result.client)
            let path = result.path
            self.rememberPath(path, for: mac)
            self.rememberDirectConnection(result, selection: mac)
            self.didConnect(host: result.host, hello: result.hello, viaRelay: path == .relay)
            self.reconcileMacs()
        }
        connectionTask = task
        defer { if epoch == connectionGeneration { connectionTask = nil } }
        do { try await task.value }
        catch {
            guard epoch == connectionGeneration, !(error is CancellationError) else { return }
            needsAddressRefresh = true
            let error = self.connectionError(error)
            if case .account = mac,
               case BridgeClient.ClientError.unauthorized = error {
                failConnection(BridgeClient.RemoteError(message: "The Mac rejected the connection ticket. Sign in to the same account on the Mac and try again."), selection: mac)
                return
            }
            failConnection(error, selection: selectedMac ?? mac)
            if case BridgeClient.ClientError.unauthorized = error { return }
            scheduleReconnect()
        }
    }

    private func install(_ winner: BridgeClient) throws {
        guard winner.isReady else { winner.disconnect(); throw BridgeClient.ClientError.notConnected }
        client.onDisconnect = nil
        client.onPush = nil
        client.disconnect()
        client = winner
        client.onPush = { [weak self] in self?.handlePush($0) }
        client.onDisconnect = { [weak self] in self?.handleDisconnect($0) }
    }

    private func pathKey(for mac: MacSelection) -> String {
        switch mac {
        case .account(let device): return device.id.uuidString
        case .paired(let paired): return (paired.deviceId ?? paired.id).uuidString
        }
    }

    private func rememberPath(_ path: ConnectionPath, for mac: MacSelection) {
        lastPaths[pathKey(for: mac)] = path
        UserDefaults.standard.set(try? JSONEncoder().encode(lastPaths), forKey: "lastConnectionPaths")
    }

    private func directAddress(for mac: MacSelection) -> PairedMac {
        switch mac {
        case .paired(let paired):
            return paired.deviceId.map { withBonjourAddress(paired, deviceId: $0) } ?? paired
        case .account(let device):
            return withBonjourAddress(pairedMac(for: mac)?.usingAccountAddress(device) ?? device.bridgeAddress, deviceId: device.id)
        }
    }

    private func relayPublicKey(for device: AccountDevice) throws -> String {
        guard let key = device.publicKey else { throw BridgeClient.ClientError.notConnected }
        let pins = macs.filter { $0.deviceId == device.id }.compactMap(\.publicKey)
        guard pins.allSatisfy({ $0 == key }) else {
            throw BridgeClient.RemoteError(message: "This Mac's security key changed. Scan its QR code again.")
        }
        return pins.first ?? key
    }

    private func addDirectRoutes(for selection: MacSelection, to race: ConnectionRace<BridgeClient.Connected>, epoch: Int) {
        let address = directAddress(for: selection)
        var paths = address.orderedHosts.map { ConnectionPath.direct(host: $0, port: address.port) }
        if let preferred = racePreferredPath, case .direct = preferred, !paths.contains(preferred) {
            paths.insert(preferred, at: 0)
        }
        let pairedToken = pairedMac(for: selection).flatMap { Keychain.token(for: $0.id) }
        for path in paths {
            guard case .direct(let host, let port) = path else { continue }
            let candidate = BridgeClient()
            race.add(.init(path: path, delay: ConnectionSchedule.delay(for: path, preferred: racePreferredPath), operation: {
                let token: String
                if let pairedToken { token = pairedToken }
                else if case .account(let device) = selection { token = try await self.account.connectionTicket(for: device) }
                else { throw BridgeClient.ClientError.unauthorized }
                try self.checkConnection(epoch)
                let hello: HelloResult
                do { hello = try await candidate.open(host: host, port: port, token: token) }
                catch BridgeClient.ClientError.unauthorized {
                    guard pairedToken != nil, case .account(let device) = selection else { throw BridgeClient.ClientError.unauthorized }
                    let ticket = try await self.account.connectionTicket(for: device)
                    try self.checkConnection(epoch)
                    hello = try await candidate.open(host: host, port: port, token: ticket)
                }
                return BridgeClient.Connected(client: candidate, path: path, hello: hello)
            }, cancel: { candidate.disconnect() }))
        }
    }

    private func rememberDirectConnection(_ result: BridgeClient.Connected, selection: MacSelection) {
        guard !result.host.isEmpty, let paired = pairedMac(for: selection),
              let index = macs.firstIndex(where: { $0.id == paired.id }) else { return }
        var updated = macs[index]
        let address = directAddress(for: selection)
        updated.hosts = address.hosts.contains(result.host) ? address.hosts : [result.host] + address.hosts
        if case .direct(_, let port) = result.path { updated.port = port }
        updated.lastGoodHost = result.host
        if let deviceId = result.hello.deviceId.flatMap(UUID.init(uuidString:)) { updated.deviceId = deviceId }
        macs[index] = updated
        MacStore.save(macs)
        if case .account(let device) = selection, let id = updated.deviceId, id != device.id {
            selectedMacId = MacSelection.paired(updated).id
            MacStore.selectedId = updated.id
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        if phase == .background, leftForegroundAt == nil { leftForegroundAt = .now }
        inForeground = phase == .active
        account.setForeground(inForeground)
        updateBonjourConnection()
        if phase == .background {
            bonjour.stop()
            beginBackgroundExecution()
            backgroundPrefetchTask?.cancel()
            backgroundPrefetchTask = Task { [weak self] in await self?.prefetchTicket() }
        } else { bonjour.start() }
        if phase == .active {
            endBackgroundExecution()
            Task {
                await notifications.refreshAuthorization()
                openPendingNotification()
            }
            reconnectAttempt = 0
            Task {
                await account.restore()
            }
            // After suspension, discard the stale socket immediately. A background
            // lease keeps short trips alive; a live socket only needs a quick pong.
            if backgroundTimeExpired || leftForegroundAt.map({ $0.duration(to: .now) > .seconds(30) }) == true {
                reconnectImmediately()
            } else if isConnected {
                client.ping(timeout: 1.5, replacingPending: true)
            } else if connectionTask == nil { reconnectImmediately() }
            backgroundTimeExpired = false
            leftForegroundAt = nil
        }
    }

    private func beginBackgroundExecution() {
        guard backgroundTask == .invalid else { return }
        backgroundTimeExpired = false
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Bridge heartbeat") { [weak self] in
            // UIKit invokes expiration on the main thread. End the lease synchronously
            // before returning; a scheduled Task could miss the system's deadline.
            MainActor.assumeIsolated {
                guard let self else { return }
                self.backgroundTimeExpired = true
                self.backgroundPrefetchTask?.cancel()
                self.endBackgroundExecution()
            }
        }
        if backgroundTask == .invalid { backgroundTimeExpired = true }
    }

    private func endBackgroundExecution() {
        guard backgroundTask != .invalid else { return }
        let identifier = backgroundTask
        backgroundTask = .invalid
        UIApplication.shared.endBackgroundTask(identifier)
    }

    private func prefetchTicket() async {
        guard let deviceId = selectedDeviceId,
              let device = account.devices.first(where: { $0.id == deviceId }), account.isSignedIn else { return }
        await account.prefetchConnectionTicket(for: device)
        // Warm the account access token used by relay authentication as well.
        _ = try? await account.validAccessToken()
    }

    private func startTicketPrefetch() {
        ticketPrefetchTask?.cancel()
        ticketPrefetchTask = Task { @MainActor [weak self] in
            await self?.prefetchTicket()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(240)) } catch { return }
                guard let self, self.isConnected else { return }
                await self.prefetchTicket()
            }
        }
    }

    private func refreshAddresses(for deviceId: UUID) async {
        let now = ContinuousClock.now
        if let last = lastAddressRefresh[deviceId], last.duration(to: now) < .seconds(5) { return }
        lastAddressRefresh[deviceId] = now
        let refresh: Task<Void, Never>
        if let current = addressRefreshTask { refresh = current }
        else {
            let task = Task { @MainActor in await self.account.refreshDevices() }
            addressRefreshTask = task
            refresh = task
            Task { @MainActor [weak self] in
                await task.value
                self?.addressRefreshTask = nil
            }
        }
        await DeviceRefreshWait().wait(for: refresh)
    }

    private func accountDidChange() {
        let previous = knownDeviceHosts
        knownDeviceHosts = Dictionary(uniqueKeysWithValues: account.devices.map { ($0.id, Set($0.hosts)) })
        reconcileMacs()
        openPendingNotification()
        guard case .account(let device) = selectedMac, !isConnected else { return }
        if let race = activeRace { addDirectRoutes(for: .account(device), to: race, epoch: connectionGeneration) }
        else if let oldHosts = previous[device.id], oldHosts != Set(device.hosts),
                refreshingConnectionGeneration != connectionGeneration { reconnectImmediately() }
    }

    private func withBonjourAddress(_ paired: PairedMac, deviceId: UUID) -> PairedMac {
        guard let address = bonjourAddresses[deviceId] else { return paired }
        return paired.usingBonjourAddress(address)
    }

    private func discoveredAddress(_ address: BonjourAddress, for deviceId: UUID) {
        let changed = bonjourAddresses[deviceId] != address
        bonjourAddresses[deviceId] = address
        var pairedChanged = false
        for index in macs.indices where macs[index].deviceId == deviceId {
            let updated = macs[index].usingBonjourAddress(address)
            if updated != macs[index] { macs[index] = updated; pairedChanged = true }
        }
        if pairedChanged { MacStore.save(macs) }
        // Let an explicit QR connection finish installing its new token.
        if (changed || pairedChanged), selectedDeviceId == deviceId, !isConnected, !pairingInProgress {
            if let race = activeRace, let selectedMac { addDirectRoutes(for: selectedMac, to: race, epoch: connectionGeneration) }
            else { reconnectImmediately() }
        }
    }

    private func reconnectImmediately() {
        guard inForeground, selectedMac != nil else { return }
        guard !pairingInProgress, connectionTask == nil else { return }
        client.disconnect()
        connection = .idle
        beginRecovery()
        reconnectAttempt = 0
        needsAddressRefresh = true
        Task { [weak self] in await self?.connect() }
    }

    private func reconcileMacs() {
        guard !removingMac else { return }
        let deviceIds = Set(macs.compactMap(\.deviceId) + account.devices.map(\.id))
        bonjour.updateDeviceIds(deviceIds)
        updateBonjourConnection()
        bonjourAddresses = bonjourAddresses.filter { deviceIds.contains($0.key) }
        guard !availableMacs.contains(where: { $0.id == selectedMacId }) else { return }
        if let device = MacSelection.mergedAccount(for: selectedMacId, paired: macs, devices: account.devices) {
            // Merging two directory entries must not interrupt an already usable local connection.
            selectedMacId = MacSelection.account(device).id
            if !isConnected, connectionTask == nil, inForeground { Task { await connect() } }
            return
        }
        invalidateConnection()
        navigationPath = NavigationPath()
        selectedMacId = MacSelection.selectionAfterRemoval(selectedId: selectedMacId, remaining: availableMacs)
        if case .paired(let paired) = selectedMac { MacStore.selectedId = paired.id }
        if availableMacs.isEmpty { MacStore.selectedId = nil }
        if selectedMac != nil { Task { await connect() } }
    }

    private func invalidateConnection() {
        activeRace?.cancel()
        activeRace = nil
        ticketPrefetchTask?.cancel()
        backgroundPrefetchTask?.cancel()
        recoveryStartedAt = nil
        recoveryDeadlineTask?.cancel()
        isReconnecting = false
        connectionGeneration += 1
        pushRegistrationTask?.cancel()
        pushRegistrationTask = nil
        registeredPushToken = nil
        connectionTask?.cancel()
        connectionTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        refreshingConnectionGeneration = nil
        client.disconnect()
        resetRemoteState()
        connection = .idle
    }

    private func checkConnection(_ epoch: Int) throws {
        try Task.checkCancellation()
        guard epoch == connectionGeneration else { throw CancellationError() }
    }

    private func didConnect(host: String, hello: HelloResult, viaRelay: Bool = false) {
        recoveryDeadlineTask?.cancel()
        recoveryStartedAt = nil
        recoveryError = BridgeClient.ClientError.notConnected
        isReconnecting = false
        reconnectAttempt = 0
        connection = .connected(host: host, viaRelay: viaRelay)
        bridgeVersion = hello.version
        agents = hello.agents
        bridgeDeviceId = hello.deviceId ?? selectedDeviceId?.uuidString
        pushStatus = hello.push
        startTicketPrefetch()
        registeredPushToken = nil
        let epoch = connectionGeneration
        Task {
            _ = await registerPush()
            guard epoch == connectionGeneration, isConnected else { return }
            await syncTasks()
            openPendingNotification()
        }
    }

    private func connectionError(_ error: Error) -> Error {
        guard let failure = error as? ConnectionRaceFailure else { return error }
        if let relay = failure.attempts.first(where: { $0.path == .relay }) { return relay.error }
        if let rejected = failure.attempts.first(where: {
            if case BridgeClient.ClientError.unauthorized = $0.error { return true }
            return false
        }) { return rejected.error }
        return failure.underlyingError
    }

    private func failConnection(_ error: Error, selection: MacSelection?) {
        let error = connectionError(error)
        recoveryError = error
        if isReconnecting { connection = .idle; return }
        let cause: ConnectionFailureCause
        switch error {
        case BridgeClient.ClientError.bridgeOffline: cause = .bridgeOffline
        case BridgeClient.ClientError.timeout, BridgeClient.ClientError.notConnected: cause = .unreachable
        case let error as URLError where [.timedOut, .cannotFindHost, .cannotConnectToHost,
             .networkConnectionLost, .dnsLookupFailed, .notConnectedToInternet].contains(error.code): cause = .unreachable
        case let error as NSError where error.domain == NSPOSIXErrorDomain && [50, 51, 54, 60, 61, 64, 65].contains(error.code): cause = .unreachable
        default: cause = .other
        }
        let device: AccountDevice?
        let isPaired: Bool
        switch selection {
        case .paired(let mac):
            isPaired = true
            device = account.devices.first { $0.id == mac.deviceId }
        case .account(let selected):
            isPaired = false
            device = account.devices.first { $0.id == selected.id } ?? selected
        case nil: isPaired = false; device = nil
        }
        let hint = ConnectionFailureHint.resolve(cause: cause, fallback: error.localizedDescription,
                                                isPaired: isPaired, signedIn: account.isSignedIn, accountDevice: device)
        connection = .failed(hint.message)
        connectionFailureNeedsSignIn = hint.offersSignIn
    }

    private func handleDisconnect(_ error: Error) {
        registeredPushToken = nil
        ticketPrefetchTask?.cancel()
        recoveryError = error
        connection = .idle
        needsAddressRefresh = true
        guard inForeground, selectedMac != nil else { return }
        beginRecovery()
        // The socket has already been torn down. Preserve visible tasks/history and
        // start a fresh route race immediately, without backoff.
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            guard let self else { return }
            // A drop can arrive just after hello, before connect() has released
            // its task slot. Wait for that cleanup rather than losing this reconnect.
            while self.connectionTask != nil {
                do { try await Task.sleep(for: .milliseconds(10)) } catch { return }
            }
            guard !Task.isCancelled, self.inForeground else { return }
            self.reconnectTask = nil
            await self.connect()
        }
    }

    private func beginRecovery() {
        guard recoveryStartedAt == nil else { return }
        recoveryStartedAt = .now
        isReconnecting = true
        recoveryDeadlineTask?.cancel()
        recoveryDeadlineTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, !self.isConnected else { return }
            self.isReconnecting = false
            self.failConnection(self.recoveryError, selection: self.selectedMac)
        }
    }

    private func scheduleReconnect() {
        guard inForeground, selectedMac != nil else { return }
        reconnectTask?.cancel()
        reconnectAttempt += 1
        let delay = min(30.0, pow(2.0, Double(min(reconnectAttempt, 5))))
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.reconnectTask = nil
            await self?.connect()
        }
    }

    private func resetRemoteState() {
        agents = []
        sessions = [:]
        tasks = [:]
        events = [:]
        draftStore.reset()
        bridgeVersion = nil
        bridgeDeviceId = nil
        pushStatus = nil
        pushRegistrationFailed = false
        watchRevisions = [:]
        notifications.visibleSession = nil
    }

    // MARK: - Bridge calls

    private func bridgeCall<T: Decodable>(_ method: String, _ params: [String: Any?] = [:]) async throws -> T {
        let selection = selectedMacId
        let epoch = connectionGeneration
        return try await BridgeReadRetry.call(method, isDisconnected: {
            if case BridgeClient.ClientError.notConnected = $0 { return true }
            return false
        }, waitForReconnect: {
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while true {
                try self.checkConnection(epoch)
                guard selection != nil, selection == self.selectedMacId, self.inForeground else {
                    throw BridgeClient.ClientError.notConnected
                }
                if self.isConnected { return }
                guard ContinuousClock.now < deadline else { throw BridgeClient.ClientError.notConnected }
                try await Task.sleep(for: .milliseconds(50))
            }
        }, operation: {
            guard self.isConnected else { throw BridgeClient.ClientError.notConnected }
            let result: T = try await self.client.call(method, params)
            try self.checkConnection(epoch)
            guard selection == self.selectedMacId else { throw CancellationError() }
            return result
        })
    }

    func loadAgentIcon(_ kind: AgentKind) async {
        guard isConnected, let hash = agent(kind)?.iconHash else { return }
        await agentIcons.load(agent: kind, hash: hash) { [self] in
            try await bridgeCall("agents.icon", ["agent": kind.rawValue])
        }
    }

    func refreshAgents() async throws {
        agents = try await bridgeCall("agents.list")
    }

    /// Keep an old catalog when refresh fails; only a successful response can invalidate a selection.
    func refreshModels(_ agent: AgentKind) async throws -> Bool {
        guard let deviceId = bridgeDeviceId else { return false }
        let epoch = connectionGeneration
        let result: AgentModelsResult = try await bridgeCall("agents.models", ["agent": agent.rawValue])
        try checkConnection(epoch)
        guard bridgeDeviceId == deviceId, result.agent == agent else { return false }
        return modelSelections.updateModels(result.models, deviceId: deviceId, agent: agent)
    }

    @discardableResult
    func loadSessions(_ agent: AgentKind) async throws -> [SessionSummary] {
        let list: [SessionSummary] = try await bridgeCall("sessions.list", ["agent": agent.rawValue, "limit": 50])
        sessions[agent] = list
        return list
    }

    func messages(agent: AgentKind, sessionId: String) async throws -> [ChatMessage] {
        try await bridgeCall("sessions.messages", ["agent": agent.rawValue, "sessionId": sessionId, "limit": 80])
    }

    /// Capture the actual transport client for a preview window. A Mac switch or
    /// reconnect closes it, so in-flight reads cannot silently target another Mac.
    func contentClient() throws -> BridgeClient {
        guard isConnected else { throw BridgeClient.ClientError.notConnected }
        return client
    }

    var contentUsesRelay: Bool {
        if case .connected(_, let viaRelay) = connection { return viaRelay }
        return false
    }

    func previewTargets() async throws -> [WebPreviewTarget] { try await bridgeCall("preview.targets") }

    func loadTaskEvents(_ id: String) async {
        guard let snap: TaskSnapshot = try? await bridgeCall("tasks.get", ["taskId": id]) else { return }
        for event in snap.events { append(event, to: id) }
    }

    func recentProjects() async throws -> [ProjectDir] {
        try await bridgeCall("projects.recent", ["limit": 40])
    }

    func startTask(agent: AgentKind, sessionId: String?, cwd: String?, prompt: String, mode: PermissionMode, fork: Bool = false) async throws -> TaskInfo {
        let epoch = connectionGeneration
        let watch = UserDefaults.standard.bool(forKey: PushRegistration.autoWatchPreference)
        if watch {
            _ = await notifications.requestWhenNeeded()
            _ = await registerPush()
            try checkConnection(epoch)
        }
        let selection = bridgeDeviceId.map { modelSelections.selection(deviceId: $0, agent: agent) } ?? ModelSelection()
        let task: TaskInfo = try await client.call("tasks.start", [
            "agent": agent.rawValue,
            "sessionId": sessionId,
            "cwd": cwd,
            "prompt": prompt,
            "permissionMode": mode.rawValue,
            "model": selection.model,
            "effort": selection.effort,
            "watch": watch,
            "fork": fork ? true : nil,
        ])
        try checkConnection(epoch)
        merge(task)
        rememberWatch(task.id, watch: watch && tasks[task.id]?.status == .running)
        // If the APNs token arrived after the start RPC, restore the requested watch.
        if watch, task.status == .running, notifications.token != nil, task.watching != true {
            _ = try? await setTaskWatch(task.id, watch: true)
        }
        return task
    }

    func cancelTask(_ id: String) async throws {
        let task: TaskInfo = try await client.call("tasks.cancel", ["taskId": id])
        merge(task)
    }

    /// After (re)connecting, pick up tasks that ran or finished while the phone was away.
    func syncTasks() async {
        let epoch = connectionGeneration
        let watchSnapshot = watchRevisions
        guard let list: [TaskInfo] = try? await bridgeCall("tasks.list") else { return }
        guard epoch == connectionGeneration, isConnected else { return }
        for task in list {
            var incoming = task
            if watchSnapshot[task.id, default: 0] != watchRevisions[task.id, default: 0] {
                incoming.watching = tasks[task.id]?.watching
            }
            merge(incoming)
        }
        for task in list where task.status == .running && rememberedWatches.contains(task.id) && task.watching != true {
            if registeredPushToken != nil { _ = try? await setTaskWatch(task.id, watch: true) }
            guard epoch == connectionGeneration else { return }
        }
        for task in list where task.status == .running || events[task.id] != nil {
            let since = events[task.id]?.last?.seq ?? 0
            let draftRevision = draftStore.revision(task.id)
            let watchRevision = watchRevisions[task.id, default: 0]
            if let snap: TaskSnapshot = try? await bridgeCall("tasks.get", ["taskId": task.id, "sinceSeq": since]) {
                guard epoch == connectionGeneration else { return }
                var incoming = snap.task
                if watchRevision != watchRevisions[task.id, default: 0] { incoming.watching = tasks[task.id]?.watching }
                merge(incoming)
                let newerEvents = (events[task.id]?.last?.seq ?? 0) > (snap.events.last?.seq ?? since)
                for e in snap.events { append(e, to: task.id, clearingDraft: false) }
                if tasks[task.id]?.status == .running && !newerEvents {
                    draftStore.restore(snap.draft, taskId: task.id, sinceRevision: draftRevision)
                }
            }
        }
    }

    // MARK: - Push handling

    private func handlePush(_ push: PushMessage) {
        switch push {
        case .agentsUpdated(let agents):
            self.agents = agents
        case .pushStatus(let status):
            pushStatus = status
        case .taskEvent(let taskId, let event):
            append(event, to: taskId)
            if event.kind == "session", let sid = event.sessionId { tasks[taskId]?.sessionId = sid }
        case .taskDelta(let delta):
            guard tasks[delta.taskId]?.status == .running || tasks[delta.taskId] == nil else { return }
            draftStore.append(delta)
        case .taskUpdated(let task):
            merge(task)
        }
    }

    private func merge(_ task: TaskInfo) {
        // Never let a stale response flip a finished task back to running.
        if let current = tasks[task.id], current.status != .running, task.status == .running { return }
        tasks[task.id] = task.preservingWatching(from: tasks[task.id])
        if task.status == .running, task.watching == true { rememberWatch(task.id, watch: true) }
        if task.status != .running { rememberWatch(task.id, watch: false) }
        if task.status != .running { draftStore.clear(task.id) }
    }

    private func append(_ event: TaskEvent, to taskId: String, clearingDraft: Bool = true) {
        var list = events[taskId] ?? []
        guard event.seq > (list.last?.seq ?? 0) else { return }
        if clearingDraft && event.kind == "text" { draftStore.clear(taskId) }
        if event.kind == "file", let path = event.path { list.removeAll { $0.kind == "file" && $0.path == path } }
        list.append(event)
        events[taskId] = list
    }

    // MARK: - Notification registration, watch intent and navigation

    @discardableResult
    func registerPush() async -> Bool {
        guard isConnected, let token = notifications.token else { return false }
        if registeredPushToken == token { return true }
        if let pending = pushRegistrationTask {
            let epoch = connectionGeneration
            let result = await pending.value
            guard epoch == connectionGeneration, isConnected else { return false }
            if result, registeredPushToken != notifications.token { return await registerPush() }
            return result
        }
        let epoch = connectionGeneration
        let registration = Task { @MainActor in
            defer { if epoch == connectionGeneration { pushRegistrationTask = nil } }
            do {
                let key = try PushCrypto.loadOrCreateKey()
                let result: PushRegisterResult = try await client.call("push.register", [
                    "installationId": notifications.installationId, "apnsToken": token,
                    "environment": notifications.environment, "publicKey": key.publicKey.rawRepresentation.base64EncodedString(),
                ])
                try checkConnection(epoch)
                guard isConnected else { return false }
                pushStatus = result.push
                registeredPushToken = token
                pushRegistrationFailed = false
                return true
            } catch {
                if epoch == connectionGeneration { pushRegistrationFailed = true }
                return false
            }
        }
        pushRegistrationTask = registration
        let result = await registration.value
        guard epoch == connectionGeneration, isConnected else { return false }
        if result, registeredPushToken != notifications.token { return await registerPush() }
        return result
    }

    var notificationUnavailableMessage: String? {
        if notifications.authorization == .denied { return "Turn on notifications for AgentTote in Settings." }
        switch pushStatus?.reason {
        case "signed_out": return "Sign in on your Mac to get notifications when the app is closed."
        case "server_disabled": return "Notifications aren't set up on the server yet."
        default: break
        }
        if notifications.registrationFailed || pushRegistrationFailed { return "Notifications couldn't connect. Try again in a moment." }
        if !isConnected { return "Connect to your Mac to set up notifications." }
        if !notifications.isAuthorized { return "Allow notifications to get task updates." }
        if notifications.token == nil { return "Notifications are still connecting. Try again in a moment." }
        if pushStatus?.available != true { return "Notifications aren't available on this Mac yet." }
        return nil
    }

    @discardableResult
    func setTaskWatch(_ id: String, watch: Bool) async throws -> Bool {
        let epoch = connectionGeneration
        watchRevisions[id, default: 0] += 1
        guard await registerPush() else { throw BridgeClient.RemoteError(message: notificationUnavailableMessage ?? "Notifications couldn't connect. Try again in a moment.") }
        try checkConnection(epoch)
        let result: TaskWatchResult = try await client.call("tasks.watch", ["taskId": id, "watch": watch])
        try checkConnection(epoch)
        // A terminal status in this response must not flip a newer task back to running.
        if result.status != .running { tasks[id]?.status = result.status }
        let watching = result.watching && tasks[id]?.status == .running
        tasks[id]?.watching = watching
        watchRevisions[id, default: 0] += 1
        rememberWatch(id, watch: watching)
        return watching
    }

    private var watchStoreKey: String? { bridgeDeviceId.map { "pushWatchedTasks." + $0.lowercased() } }
    private var rememberedWatches: Set<String> {
        guard let watchStoreKey else { return [] }
        return Set(UserDefaults.standard.stringArray(forKey: watchStoreKey) ?? [])
    }

    private func rememberWatch(_ taskId: String, watch: Bool) {
        guard let watchStoreKey else { return }
        var ids = rememberedWatches
        if watch { ids.insert(taskId) } else { ids.remove(taskId) }
        UserDefaults.standard.set(Array(ids), forKey: watchStoreKey)
    }

    func openPendingNotification() {
        guard let destination = notifications.pendingDestination else { return }
        let matching = availableMacs.first { mac in
            switch mac {
            case .account(let device): return device.id.uuidString.lowercased() == destination.deviceId.lowercased()
            case .paired(let paired): return paired.deviceId?.uuidString.lowercased() == destination.deviceId.lowercased()
            }
        }
        guard let matching else { return } // Keep cold-start intent until account restoration has found the Mac.
        if matching.id != selectedMacId { select(matching); return }
        guard isConnected, bridgeDeviceId?.lowercased() == destination.deviceId.lowercased() else {
            Task { await connect() }
            return
        }
        navigationPath = NavigationPath()
        if let sid = destination.sessionId, !sid.isEmpty, let agent = AgentKind(rawValue: destination.agent) {
            let task = tasks[destination.taskId]
            navigationPath.append(SessionRoute(agent: agent, sessionId: sid, title: task?.prompt ?? "Task", cwd: task?.cwd ?? ""))
        }
        notificationNavigationRevision += 1
        notifications.consumeDestination()
    }
}
