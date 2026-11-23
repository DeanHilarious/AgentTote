// Standalone runner: compile Protocol.swift, ModelSelectionStore.swift and this
// file with -D AA_MODEL_UNIT_TESTS -parse-as-library. No Xcode project edits.
#if AA_MODEL_UNIT_TESTS
import Foundation

@main
@MainActor
private enum ModelSelectionTestRunner {
    static func main() throws {
        let suite = "AgentAnywhere.ModelSelectionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
            if !condition() { throw NSError(domain: "ModelSelectionTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        let auto = ModelOption(id: "auto", name: "Auto", isDefault: true)
        let glm = ModelOption(id: "glm-5.2", name: "GLM-5.2", isDefault: false, efforts: ["low", "high"], defaultEffort: "high")
        let models = [auto, glm]
        let chosen = ModelSelection(model: glm.id, effort: "high")
        let store = ModelSelectionStore(defaults: defaults)
        store.save(chosen, deviceId: "MAC-A", agent: .workbuddy)
        let restored = ModelSelectionStore(defaults: defaults)
        try expect(restored.selection(deviceId: "mac-a", agent: .workbuddy) == chosen, "Selection must survive restart and normalize device ID")
        try expect(restored.selection(deviceId: "mac-b", agent: .workbuddy) == ModelSelection(), "Mac selections must be isolated")
        try expect(restored.selection(deviceId: "mac-a", agent: .codex) == ModelSelection(), "Agent selections must be isolated")
        try expect(!restored.updateModels(models, deviceId: "mac-a", agent: .workbuddy), "A present model must stay selected")
        try expect(restored.models(deviceId: "mac-a", agent: .workbuddy) == models, "Catalog must be cached per Mac and Agent")
        try expect(restored.models(deviceId: "mac-b", agent: .workbuddy).isEmpty, "Catalog must not leak across Macs")
        try expect(restored.models(deviceId: "mac-a", agent: .codex).isEmpty, "Catalog must not leak across Agents")
        try expect(restored.updateModels([auto], deviceId: "mac-a", agent: .workbuddy), "Missing model must trigger a notice")
        try expect(restored.selection(deviceId: "mac-a", agent: .workbuddy) == ModelSelection(), "Missing model must clear model AND effort")
        try expect(!restored.updateModels([auto], deviceId: "mac-a", agent: .workbuddy), "Fallback notice must happen only once")
        try expect(ModelSelectionStore(defaults: defaults).selection(deviceId: "mac-a", agent: .workbuddy) == ModelSelection(), "Fallback must persist")
        restored.save(chosen, deviceId: "mac-a", agent: .workbuddy)
        var changed = glm
        changed.efforts = ["low"]
        try expect(!restored.updateModels([auto, changed], deviceId: "mac-a", agent: .workbuddy), "Effort-only change must preserve model")
        try expect(restored.selection(deviceId: "mac-a", agent: .workbuddy) == ModelSelection(model: glm.id), "Unsupported saved effort must clear")
        restored.save(chosen, deviceId: "mac-a", agent: .workbuddy)
        try expect(restored.updateModels([], deviceId: "mac-a", agent: .workbuddy), "Successful empty catalog must reset a removed model")
        try expect(ModelSelection().capsuleTitle(models: []) == "Auto", "Unknown default title")
        try expect(ModelSelection().capsuleTitle(models: models) == "Auto", "Known default title")
        try expect(chosen.capsuleTitle(models: models) == "GLM-5.2 · High", "Explicit model and effort title")
        try expect(ModelSelection(model: glm.id).capsuleTitle(models: models) == "GLM-5.2", "Unselected effort must not be displayed")
        try expect(ModelSelection(effort: "high").capsuleTitle(models: [glm]) == "Auto · High", "Default effort title")
        try expect(ModelSelection(model: "old-id").capsuleTitle(models: []) == "old-id", "Unrefreshed selection retains identifier")
        try expect(ModelSelection.effortTitle("xhigh") == "XHigh", "XHigh label")
        try expect(ModelSelection.taskLabel(model: glm.id, effort: "high", models: models) == "GLM-5.2 · high", "Task label resolves display name")
        try expect(ModelSelection.taskLabel(model: "removed", effort: "high", models: []) == "removed · high", "History retains removed model ID")
        try expect(ModelSelection().accessibilityLabel(models: models) == "Model: Auto, default", "Default VoiceOver label")
        try expect(chosen.accessibilityLabel(models: models) == "Model: GLM-5.2, effort high", "Explicit VoiceOver label")
        try expect(ModelSelection(effort: "high").accessibilityLabel(models: models) == "Model: Auto, default, effort high", "Default model with explicit effort VoiceOver")
        let legacy = Data(#"{"id":"t","agent":"codex","cwd":"/tmp","prompt":"p","permissionMode":"readOnly","status":"completed","startedAt":1}"#.utf8)
        let legacyTask = try JSONDecoder().decode(TaskInfo.self, from: legacy)
        try expect(legacyTask.model == nil, "Legacy task decoding")
        let wire = Data(#"{"agent":"workbuddy","models":[{"id":"glm","name":"GLM","note":"x0.79 credits","isDefault":true,"efforts":["high"],"defaultEffort":"high"}]}"#.utf8)
        let result = try JSONDecoder().decode(AgentModelsResult.self, from: wire)
        try expect(result.models[0].note == "x0.79 credits" && result.models[0].defaultEffort == "high", "Wire capabilities decode")
        let cursorWire = Data(#"{"agent":"cursor","models":[{"id":"auto","name":"Auto","isDefault":true}]}"#.utf8)
        let cursorModels = try JSONDecoder().decode(AgentModelsResult.self, from: cursorWire)
        try expect(cursorModels.agent == .cursor && cursorModels.models[0].id == "auto", "Cursor catalog decodes")
        let cursorTask = try JSONDecoder().decode(TaskInfo.self, from: Data(String(decoding: legacy, as: UTF8.self)
            .replacingOccurrences(of: "codex", with: "cursor").utf8))
        try expect(cursorTask.agent == .cursor, "Cursor tasks decode")
        store.save(ModelSelection(model: "auto"), deviceId: "MAC-A", agent: .cursor)
        try expect(store.selection(deviceId: "MAC-A", agent: .cursor).model == "auto", "Cursor model selection persists")
        print("Model selection checks passed: persistence, Mac/Agent isolation, catalogs, fallback once, effort changes, capsule/task labels and legacy wire compatibility.")
    }
}
#endif
