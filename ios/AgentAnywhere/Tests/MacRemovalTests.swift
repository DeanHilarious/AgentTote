// Standalone: swiftc -D AA_MAC_REMOVAL_TESTS -parse-as-library
// AccountClient.swift PairedMac.swift BonjourDiscovery.swift MacSelection.swift MacRemovalTests.swift
#if AA_MAC_REMOVAL_TESTS
import Foundation

@main
private enum MacRemovalTestRunner {
    static func main() throws {
        func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
            if !condition() { throw NSError(domain: "MacRemovalTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func device(_ name: String, online: Bool) -> AccountDevice {
            AccountDevice(id: UUID(), name: name, hosts: [], port: 8787, online: online, lastSeenAt: 0)
        }
        let removed = device("Removed", online: true)
        let offline = MacSelection.account(device("Offline", online: false))
        let online = MacSelection.account(device("Online", online: true))
        let paired = PairedMac(id: UUID(), name: "QR", hosts: [], port: 8787)
        let qr = MacSelection.paired(paired)
        let selected = MacSelection.account(removed)
        try expect(MacSelection.selectionAfterRemoval(selectedId: selected.id, remaining: [offline, qr, online]) == online.id, "Prefer online over offline and unknown QR status")
        try expect(MacSelection.selectionAfterRemoval(selectedId: offline.id, remaining: [offline, online]) == offline.id, "Removing another Mac preserves selection")
        try expect(MacSelection.selectionAfterRemoval(selectedId: selected.id, remaining: [offline, qr]) == offline.id, "Stable fallback when no Mac is online")
        try expect(MacSelection.selectionAfterRemoval(selectedId: qr.id, remaining: [online]) == online.id, "Removing current QR Mac selects remaining Mac")
        try expect(MacSelection.selectionAfterRemoval(selectedId: selected.id, remaining: []) == nil, "Last removal returns to empty state")
        let duplicateA = PairedMac(id: UUID(), name: "Old QR", hosts: [], port: 8787, deviceId: removed.id)
        let duplicateB = PairedMac(id: UUID(), name: "Other QR", hosts: [], port: 8787, deviceId: removed.id)
        let records = [duplicateA, paired, duplicateB]
        var tokens = Dictionary(uniqueKeysWithValues: records.map { ($0.id, "fake-token") })
        let remaining = selected.removingPairings(from: records) { tokens.removeValue(forKey: $0) }
        try expect(remaining == [paired], "Remove all QR records sharing the account deviceId")
        try expect(Set(tokens.keys) == [paired.id], "Delete matching tokens and preserve unrelated token")
        try expect(MacSelection.available(paired: remaining, devices: []).map(\.id) == [qr.id], "Removed account Mac cannot reappear as QR")
        var deleted: [UUID] = []
        let qrRemaining = MacSelection.paired(duplicateA).removingPairings(from: records) { deleted.append($0) }
        try expect(qrRemaining == [paired, duplicateB] && deleted == [duplicateA.id], "QR-only removal forgets exactly that pairing and token")
        try expect(selected.removalMessage.contains("signed out") && qr.removalMessage.contains("QR code"), "Removal explanations reflect account versus pairing")
        print("Mac removal checks passed: online preference, stable selection, QR fallback, empty state, duplicate records and token cleanup.")
    }
}
#endif
