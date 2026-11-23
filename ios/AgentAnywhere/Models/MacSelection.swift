import Foundation

enum MacSelection: Identifiable, Equatable {
    case paired(PairedMac)
    case account(AccountDevice)

    /// Account entries supersede QR entries by deviceId, retaining the QR records
    /// separately for token lookup and public-key pinning during relay fallback.
    static func available(paired: [PairedMac], devices: [AccountDevice]) -> [MacSelection] {
        let accountIds = Set(devices.map(\.id))
        return devices.map(MacSelection.account) + paired.filter {
            guard let id = $0.deviceId else { return true }
            return !accountIds.contains(id)
        }.map(MacSelection.paired)
    }

    static func mergedAccount(for selectionId: String?, paired: [PairedMac], devices: [AccountDevice]) -> AccountDevice? {
        guard let saved = paired.first(where: { MacSelection.paired($0).id == selectionId }) else { return nil }
        return devices.first { $0.id == saved.deviceId }
    }

    /// Keep a surviving selection; otherwise prefer a known-online Mac.
    static func selectionAfterRemoval(selectedId: String?, remaining: [MacSelection]) -> String? {
        if remaining.contains(where: { $0.id == selectedId }) { return selectedId }
        return (remaining.first { $0.online == true } ?? remaining.first)?.id
    }

    func pairingIDsToRemove(from paired: [PairedMac]) -> Set<UUID> {
        switch self {
        case .account(let device): Set(paired.filter { $0.deviceId == device.id }.map(\.id))
        case .paired(let mac): [mac.id]
        }
    }

    func removingPairings(from paired: [PairedMac], deleteToken: (UUID) -> Void) -> [PairedMac] {
        let ids = pairingIDsToRemove(from: paired)
        for id in ids { deleteToken(id) }
        return paired.filter { !ids.contains($0.id) }
    }

    var removalMessage: String {
        switch self {
        case .account:
            "This Mac will be signed out of your account and removed from this phone. To add it back, sign in again in AgentTote on that Mac."
        case .paired:
            "This phone will forget the pairing. Scan the Mac's QR code to pair again."
        }
    }

    var id: String {
        switch self {
        case .paired(let mac): "paired:" + mac.id.uuidString
        case .account(let device): "account:" + device.id.uuidString
        }
    }

    var name: String {
        switch self {
        case .paired(let mac): mac.name
        case .account(let device): device.name
        }
    }

    var online: Bool? {
        if case .account(let device) = self { return device.online }
        return nil
    }
}
