import Foundation

enum VerificationCode {
    static func normalized(_ value: String) -> String {
        String(value.filter { $0 >= "0" && $0 <= "9" }.prefix(6))
    }
}
