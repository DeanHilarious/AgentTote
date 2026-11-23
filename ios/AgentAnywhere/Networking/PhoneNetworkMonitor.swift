import Foundation
import Network

/// Reduce NWPath to the properties that should interrupt reconnect backoff.
struct PhoneNetworkPath: Equatable {
    let available: Bool
    let interfaces: [String]

    func shouldReconnect(after previous: PhoneNetworkPath?) -> Bool {
        guard available else { return false }
        guard let previous else { return false }
        return !previous.available || interfaces != previous.interfaces
    }
}

@MainActor
final class PhoneNetworkMonitor {
    var onChange: (() -> Void)?
    private let monitor = NWPathMonitor()
    private var previous: PhoneNetworkPath?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let types: [(NWInterface.InterfaceType, String)] = [
                (.wifi, "wifi"), (.cellular, "cellular"), (.wiredEthernet, "ethernet"),
                (.loopback, "loopback"), (.other, "other")
            ]
            let snapshot = PhoneNetworkPath(available: path.status == .satisfied,
                                            interfaces: types.filter { path.usesInterfaceType($0.0) }.map { $0.1 })
            Task { @MainActor [weak self] in
                guard let self else { return }
                let changed = snapshot.shouldReconnect(after: self.previous)
                self.previous = snapshot
                if changed { self.onChange?() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "AgentAnywhere.network"))
    }

    deinit { monitor.cancel() }
}
