import Foundation

/// Transport errors carry a typed relay cause; UI text is never used to classify failures.
enum ConnectionFailureCause {
    case unreachable, bridgeOffline, other
}

struct ConnectionFailureHint: Equatable {
    let message: String
    let offersSignIn: Bool

    static func resolve(cause: ConnectionFailureCause, fallback: String, isPaired: Bool,
                        signedIn: Bool, accountDevice: AccountDevice?, now: Date = Date()) -> Self {
        guard cause != .other else { return Self(message: fallback, offersSignIn: false) }
        if cause == .bridgeOffline || accountDevice?.relayOnline == false {
            var message = "Your Mac is offline or asleep."
            if let seen = accountDevice?.lastSeenAt, seen.isFinite, seen > 0 {
                let seconds = max(0, now.timeIntervalSince1970 - seen / 1000)
                let age: String
                if seconds < 60 { age = "just now" }
                else if seconds < 3600 { age = "\(Int(seconds / 60)) min ago" }
                else if seconds < 86400 { age = "\(Int(seconds / 3600)) hr ago" }
                else { age = "\(Int(min(seconds / 86400, Double(Int.max / 2)))) days ago" }
                message += " Last seen \(age)."
            }
            return Self(message: message, offersSignIn: false)
        }
        if isPaired && !signedIn {
            return Self(message: "Can't reach this Mac on the local network. Sign in with the same account as your Mac to connect from anywhere.", offersSignIn: true)
        }
        if isPaired && signedIn && accountDevice == nil {
            return Self(message: "This Mac isn't signed in to your account, so it can only be reached on the same network.", offersSignIn: false)
        }
        return Self(message: fallback, offersSignIn: false)
    }
}
