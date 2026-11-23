import Foundation

/// Wait briefly for fresh addresses; let account recovery continue if its server is slow.
@MainActor
final class DeviceRefreshWait {
    private var continuation: CheckedContinuation<Void, Never>?
    private var timer: Task<Void, Never>?

    func wait(for refresh: Task<Void, Never>) async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
                timer = Task { @MainActor [weak self] in
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    self?.finish()
                }
                Task { @MainActor [weak self] in
                    await refresh.value
                    self?.finish()
                }
                if Task.isCancelled { finish() }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish() }
        }
    }

    private func finish() {
        timer?.cancel()
        timer = nil
        let waiting = continuation
        continuation = nil
        waiting?.resume()
    }
}
