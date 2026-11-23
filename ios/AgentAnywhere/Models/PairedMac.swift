import Foundation

/// A Mac running the AgentAnywhere bridge. The token lives in the Keychain, everything else in UserDefaults.
struct PairedMac: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    /// Addresses to try in order: LAN first, then Tailscale.
    var hosts: [String]
    var port: Int
    /// Last address that worked; tried first next time.
    var lastGoodHost: String?
    var deviceId: UUID?
    var publicKey: String?

    var orderedHosts: [String] {
        guard let good = lastGoodHost, hosts.contains(good) else { return hosts }
        return [good] + hosts.filter { $0 != good }
    }

    func usingAccountAddress(_ device: AccountDevice) -> PairedMac {
        var updated = self
        var seen = Set<String>()
        updated.hosts = (device.hosts + hosts).filter { seen.insert($0).inserted }
        updated.port = device.port
        // Account addresses take priority even when the last QR address used to work.
        updated.lastGoodHost = nil
        return updated
    }

    func usingBonjourAddress(_ address: BonjourAddress) -> PairedMac {
        guard hosts.first != address.host || port != address.port || (lastGoodHost != nil && lastGoodHost != address.host) else { return self }
        var updated = self
        var seen = Set<String>()
        updated.hosts = ([address.host] + hosts).filter { seen.insert($0).inserted }
        updated.port = address.port
        updated.lastGoodHost = nil
        return updated
    }

    static func pairingMatches(in macs: [PairedMac], deviceId: UUID?, name: String, port: Int) -> [PairedMac] {
        if let deviceId {
            let identified = macs.filter { $0.deviceId == deviceId }
            let legacy = macs.filter { $0.deviceId == nil && $0.name == name && $0.port == port }
            return identified + legacy
        }
        return macs.filter { $0.name == name }
    }
}

/// Parsed form of the bridge's QR code: `agentanywhere://pair?name=…&port=…&token=…&hosts=a,b&device=…`.
struct PairingLink: Equatable {
    var name: String
    var hosts: [String]
    var port: Int
    var token: String
    var deviceId: UUID?
    var publicKey: String?

    init(name: String, hosts: [String], port: Int, token: String, deviceId: UUID? = nil, publicKey: String? = nil) {
        self.name = name
        self.hosts = hosts
        self.port = port
        self.token = token
        self.deviceId = deviceId
        self.publicKey = publicKey
    }

    init?(string: String) {
        guard let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        self.init(url: url)
    }

    init?(url: URL) {
        guard url.scheme == "agentanywhere", url.host == "pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        else { return nil }
        func value(_ key: String) -> String? { items.first { $0.name == key }?.value }
        guard let token = value("token"), !token.isEmpty,
              let hosts = value("hosts")?.split(separator: ",").map(String.init), !hosts.isEmpty
        else { return nil }
        self.init(name: value("name") ?? "Mac", hosts: hosts, port: Int(value("port") ?? "") ?? 8787, token: token, deviceId: value("device").flatMap(UUID.init(uuidString:)), publicKey: value("pk"))
    }
}

@MainActor
enum MacStore {
    private static let key = "pairedMacs"
    private static let selectedKey = "selectedMac"

    static func load() -> [PairedMac] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([PairedMac].self, from: data)) ?? []
    }

    static func save(_ macs: [PairedMac]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(macs), forKey: key)
    }

    static var selectedId: UUID? {
        get { UserDefaults.standard.string(forKey: selectedKey).flatMap(UUID.init) }
        set { UserDefaults.standard.set(newValue?.uuidString, forKey: selectedKey) }
    }
}
