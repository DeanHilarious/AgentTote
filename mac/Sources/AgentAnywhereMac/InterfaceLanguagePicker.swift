import SwiftUI

struct InterfaceLanguagePicker: View {
    static let preferenceKey = "interfaceLanguage"
    static let initialLanguage = "zh-Hans"

    @AppStorage(InterfaceLanguagePicker.preferenceKey) private var language = InterfaceLanguagePicker.initialLanguage

    var body: some View {
        Picker("Language", selection: $language) {
            Text(verbatim: "简体中文").tag("zh-Hans")
            Text(verbatim: "English").tag("en")
        }
        .accessibilityIdentifier("interfaceLanguage")
    }
}
