import Foundation
import CryptoKit

enum WorkBuddyConnection {
    static let keysURL = URL(string: "https://www.codebuddy.cn/profile/keys")!
    // Match JavaScript trim()/\s used by the bridge, including the byte order mark.
    private static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    static func normalizedKey(_ value: String) -> String? {
        let key = value.trimmingCharacters(in: whitespace)
        guard (16...512).contains(key.utf16.count),
              key.rangeOfCharacter(from: whitespace) == nil else { return nil }
        return key
    }
}

struct WorkBuddyClipboard {
    private var lastDigest: SHA256.Digest?

    mutating func newKey(from text: String) -> String? {
        let digest = SHA256.hash(data: Data(text.utf8))
        defer { lastDigest = digest }
        guard lastDigest != digest else { return nil }
        return WorkBuddyConnection.normalizedKey(text)
    }
}
