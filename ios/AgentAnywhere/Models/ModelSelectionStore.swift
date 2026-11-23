import Foundation
import Observation

struct ModelSelection: Codable, Equatable {
    var model: String? = nil
    var effort: String? = nil

    func resolvedModel(in models: [ModelOption]) -> ModelOption? {
        if let model { return models.first { $0.id == model } }
        return models.first { $0.isDefault }
    }

    func capsuleTitle(models: [ModelOption]) -> String {
        let option = resolvedModel(in: models)
        let name = model.map { option?.name ?? $0 } ?? option?.name ?? "Auto"
        return name + (effort.map { " · \(Self.effortTitle($0))" } ?? "")
    }

    func accessibilityLabel(models: [ModelOption]) -> String {
        let name = resolvedModel(in: models)?.name ?? model ?? "Auto"
        let defaultLabel = model == nil ? ", default" : ""
        return "Model: \(name)" + defaultLabel + (effort.map { ", effort \($0)" } ?? "")
    }

    static func effortTitle(_ effort: String) -> String {
        switch effort {
        case "xhigh": "XHigh"
        default: effort.prefix(1).uppercased() + effort.dropFirst()
        }
    }

    static func taskLabel(model: String?, effort: String?, models: [ModelOption]) -> String? {
        guard let model else { return effort.map { "Default · \($0)" } }
        let name = models.first { $0.id == model }?.name ?? model
        return name + (effort.map { " · \($0)" } ?? "")
    }
}

/// Catalogs stay in memory; selections survive app restarts, isolated by Mac and Agent.
@MainActor
#if !AA_MODEL_UNIT_TESTS
@Observable
#endif
final class ModelSelectionStore {
    private(set) var catalogs: [String: [ModelOption]] = [:]
    private var selections: [String: ModelSelection] = [:]
    // The standalone runner exercises the same state/persistence logic without
    // requiring Xcode's macro subprocess (unavailable in restricted sandboxes).
#if !AA_MODEL_UNIT_TESTS
    @ObservationIgnored
#endif
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func key(deviceId: String, agent: AgentKind) -> String {
        "modelSelection.\(deviceId.lowercased()).\(agent.rawValue)"
    }

    func models(deviceId: String, agent: AgentKind) -> [ModelOption] {
        catalogs[key(deviceId: deviceId, agent: agent)] ?? []
    }

    func selection(deviceId: String, agent: AgentKind) -> ModelSelection {
        let key = key(deviceId: deviceId, agent: agent)
        if let cached = selections[key] { return cached }
        guard let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(ModelSelection.self, from: data) else {
            return ModelSelection()
        }
        return saved
    }

    func save(_ selection: ModelSelection, deviceId: String, agent: AgentKind) {
        let key = key(deviceId: deviceId, agent: agent)
        selections[key] = selection
        defaults.set(try? JSONEncoder().encode(selection), forKey: key)
    }

    /// Returns true once when a saved model disappears. Failed refreshes never call this.
    @discardableResult
    func updateModels(_ models: [ModelOption], deviceId: String, agent: AgentKind) -> Bool {
        catalogs[key(deviceId: deviceId, agent: agent)] = models
        var selection = selection(deviceId: deviceId, agent: agent)
        if let model = selection.model, !models.contains(where: { $0.id == model }) {
            save(ModelSelection(), deviceId: deviceId, agent: agent)
            return true
        }
        if let effort = selection.effort, selection.resolvedModel(in: models)?.efforts?.contains(effort) != true {
            selection.effort = nil
            save(selection, deviceId: deviceId, agent: agent)
        }
        return false
    }
}
