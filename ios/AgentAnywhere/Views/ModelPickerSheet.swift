import SwiftUI

struct ModelPickerSheet: View {
    let models: [ModelOption]
    @Binding var selection: ModelSelection
    let error: String?
    let refresh: () async -> Void
    @Environment(\.dismiss) private var dismiss

    private var selectedModel: ModelOption? { selection.resolvedModel(in: models) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    modelRow(name: "Default", description: models.first(where: \.isDefault).map { "Use the agent default (\($0.name))" },
                             note: nil, isSelected: selection.model == nil) {
                        selection = ModelSelection()
                    }
                }
                if let efforts = selectedModel?.efforts, !efforts.isEmpty {
                    Section("Reasoning effort") {
                        Toggle("Use model default", isOn: Binding(
                            get: { selection.effort == nil },
                            set: { useDefault in
                                selection.effort = useDefault ? nil : (selectedModel?.defaultEffort.flatMap { efforts.contains($0) ? $0 : nil } ?? efforts.first)
                            }))
                        Picker("Reasoning effort", selection: Binding(
                            get: { selection.effort ?? selectedModel?.defaultEffort ?? efforts[0] },
                            set: { selection.effort = $0 })) {
                                ForEach(efforts, id: \.self) { effort in
                                    Text(segmentTitle(effort)).tag(effort)
                                }
                            }
                            .pickerStyle(.segmented)
                            .disabled(selection.effort == nil)
                        if let defaultEffort = selectedModel?.defaultEffort {
                            Text("Model default: \(ModelSelection.effortTitle(defaultEffort))")
                                .font(.caption).foregroundStyle(Brand.muted)
                        }
                    }
                    .listRowBackground(Brand.surface)
                }
                Section("Models") {
                    ForEach(models) { option in
                        modelRow(name: option.name, description: option.description, note: option.note,
                                 isSelected: selection.model == option.id) {
                            guard selection.model != option.id else { return }
                            selection = ModelSelection(model: option.id)
                        }
                    }
                }
                if let error {
                    Section {
                        Button { Task { await refresh() } } label: {
                            Label(error, systemImage: "arrow.clockwise").font(.caption)
                        }
                    }
                    .listRowBackground(Brand.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Brand.paper)
            .foregroundStyle(Brand.ink)
            .tint(Brand.relayText)
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await refresh() }
        }
        .presentationDragIndicator(.visible)
    }

    private func segmentTitle(_ effort: String) -> String {
        switch effort {
        case "minimal": "Min"
        case "medium": "Med"
        default: ModelSelection.effortTitle(effort)
        }
    }

    private func modelRow(name: String, description: String?, note: String?, isSelected: Bool,
                          select: @escaping () -> Void) -> some View {
        Button(action: select) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).font(.body.weight(.medium)).foregroundStyle(Brand.ink)
                    if let description, !description.isEmpty {
                        Text(description).font(.caption).foregroundStyle(Brand.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let note, !note.isEmpty {
                        Text(note).font(.caption.weight(.medium)).foregroundStyle(Brand.relayText)
                    }
                }
                Spacer(minLength: 0)
                if isSelected { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Brand.relayText) }
            }
            .padding(.vertical, 4).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .listRowBackground(Brand.surface)
    }
}
