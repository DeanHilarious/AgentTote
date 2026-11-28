import SwiftUI
import CoreText
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Semantic colors keep text and surfaces legible in both appearances.
enum Brand {
    static let ink = adaptive(0x12141A, 0xF2F2F0)
    static let inkFill = adaptive(0x12141A, 0x343947)
    static let logoInk = Color(hex: 0x12141A)
    static let markBackground = adaptive(0x12141A, 0x2A2D35)
    static let relay = Color(hex: 0x4B3AF0)
    static let relayPressed = Color(hex: 0x3326C4)
    static let relayText = adaptive(0x3326C4, 0xB8B0FF)
    static let relaySoft = adaptive(0xECEAFE, 0x292344)
    static let paper = adaptive(0xF4F4F1, 0x0F1115)
    static let surface = adaptive(0xFFFFFF, 0x1A1D23)
    static let line = adaptive(0xE3E3DE, 0x2A2D35)
    static let separator = adaptive(0xEFEFEA, 0x2A2D35)
    static let outline = adaptive(0xD6D6D0, 0x555A68)
    static let muted = adaptive(0x5E6270, 0x9A9EAB)
    static let success = adaptive(0x1F8A4C, 0x7EE2A6)
    static let successSoft = adaptive(0xE6F4EC, 0x162E22)
    static let successText = adaptive(0x145C33, 0x7EE2A6)
    static let warning = adaptive(0xB4540A, 0xF0B675)
    static let warningSoft = adaptive(0xFCEFE3, 0x352619)
    static let warningText = adaptive(0x7A3906, 0xF0B675)
    static let failure = adaptive(0xC2341F, 0xFF9C8C)
    static let failureSoft = adaptive(0xFBE9E6, 0x39201E)
    static let failureText = adaptive(0x8A2010, 0xFF9C8C)
    static let claude = Color(hex: 0xD97757)
    static let codex = adaptive(0x1F2328, 0x3A3F47)
    static let workbuddy = Color(hex: 0x2F6BFF)
    static let antigravity = Color(hex: 0x8E5CF7)
    static let cursor = adaptive(0x383D47, 0x555D6B)

    private static func adaptive(_ light: UInt, _ dark: UInt) -> Color {
        Color(light: light, dark: dark)
    }

    static func title(_ size: CGFloat, relativeTo style: Font.TextStyle = .title, weight: Font.Weight = .semibold) -> Font {
        #if os(iOS)
        let available = UIFont(name: "SpaceGrotesk-Regular", size: size) != nil
        #else
        let available = NSFont(name: "SpaceGrotesk-Regular", size: size) != nil
        #endif
        return available ? .custom("SpaceGrotesk-Regular", size: size, relativeTo: style).weight(weight) : .system(style).weight(weight)
    }

    #if os(macOS)
    static func registerFonts() {
        guard let url = Bundle.module.url(forResource: "SpaceGrotesk", withExtension: "ttf") else { return }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
    #endif
}

extension Color {
    init(hex: UInt) {
        self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1)
    }

    init(light: UInt, dark: UInt) {
        #if os(iOS)
        self.init(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        })
        #else
        self.init(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        })
        #endif
    }
}

struct BrandArch: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 72, sy = rect.height / 72
        var path = Path()
        path.move(to: CGPoint(x: 20 * sx, y: 50 * sy))
        path.addCurve(to: CGPoint(x: 52 * sx, y: 50 * sy), control1: CGPoint(x: 20 * sx, y: 26 * sy), control2: CGPoint(x: 52 * sx, y: 26 * sy))
        return path
    }
}

struct BrandMark: View {
    var size: CGFloat = 56

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 72
            context.fill(Path(roundedRect: CGRect(origin: .zero, size: canvasSize), cornerRadius: 20 * scale), with: .color(Brand.markBackground))
            context.stroke(BrandArch().path(in: CGRect(origin: .zero, size: canvasSize)), with: .color(.white), style: StrokeStyle(lineWidth: 4 * scale, lineCap: .round))
            for (x, y, radius, color) in [(20.0, 50.0, 6.0, Color.white), (52.0, 50.0, 6.0, Brand.relay), (36.0, 32.0, 3.5, Brand.relay)] {
                context.fill(Path(ellipseIn: CGRect(x: (x - radius) * scale, y: (y - radius) * scale, width: radius * 2 * scale, height: radius * 2 * scale)), with: .color(color))
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("AgentTote")
    }
}

struct BrandWordmark: View {
    var size: CGFloat = 32
    var body: some View {
        (Text(verbatim: "Agent").foregroundColor(Brand.ink) + Text(verbatim: "Tote").foregroundColor(Color(light: 0x4B3AF0, dark: 0xA59AFF)))
            .font(Brand.title(size, relativeTo: size >= 28 ? .largeTitle : .headline, weight: .bold))
            .accessibilityLabel("AgentTote")
    }
}

struct BrandButtonStyle: ButtonStyle {
    enum Kind { case primary, relay, tinted, outline, destructive }
    var kind: Kind = .primary
    var fullWidth = true
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(compact ? .caption.weight(.semibold) : .body.weight(.semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, compact ? 12 : 18)
            .padding(.vertical, compact ? 8 : 12)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: compact ? 44 : 54)
            .background(configuration.isPressed && kind == .relay ? Brand.relayPressed : background, in: RoundedRectangle(cornerRadius: compact ? 10 : 16))
            .overlay(RoundedRectangle(cornerRadius: compact ? 10 : 16).strokeBorder(kind == .outline ? Brand.outline : .clear, lineWidth: 1.5))
            .overlay(RoundedRectangle(cornerRadius: compact ? 10 : 16).fill(Color.black.opacity(configuration.isPressed && kind != .relay ? 0.15 : 0)))
            .modifier(BrandEnabledOpacity())
            .contentShape(RoundedRectangle(cornerRadius: compact ? 10 : 16))
    }

    private var foreground: Color {
        switch kind {
        case .primary, .relay: .white
        case .tinted: Brand.relayText
        case .outline: Brand.ink
        case .destructive: Brand.failureText
        }
    }
    private var background: Color {
        switch kind {
        case .primary: Brand.inkFill
        case .relay: Brand.relay
        case .tinted: Brand.relaySoft
        case .outline: .clear
        case .destructive: Brand.failureSoft
        }
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var fullWidth = true
    var compact = false
    func makeBody(configuration: Configuration) -> some View { BrandButtonStyle(kind: .primary, fullWidth: fullWidth, compact: compact).makeBody(configuration: configuration) }
}
struct RelayButtonStyle: ButtonStyle {
    var fullWidth = true
    var compact = false
    func makeBody(configuration: Configuration) -> some View { BrandButtonStyle(kind: .relay, fullWidth: fullWidth, compact: compact).makeBody(configuration: configuration) }
}
struct TintedButtonStyle: ButtonStyle {
    var fullWidth = true
    var compact = false
    func makeBody(configuration: Configuration) -> some View { BrandButtonStyle(kind: .tinted, fullWidth: fullWidth, compact: compact).makeBody(configuration: configuration) }
}
struct OutlineButtonStyle: ButtonStyle {
    var fullWidth = true
    var compact = false
    func makeBody(configuration: Configuration) -> some View { BrandButtonStyle(kind: .outline, fullWidth: fullWidth, compact: compact).makeBody(configuration: configuration) }
}
struct DestructiveButtonStyle: ButtonStyle {
    var fullWidth = true
    var compact = false
    func makeBody(configuration: Configuration) -> some View { BrandButtonStyle(kind: .destructive, fullWidth: fullWidth, compact: compact).makeBody(configuration: configuration) }
}

struct CircleIconButtonStyle: ButtonStyle {
    var filled = false
    var stopping = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(filled ? Color.white : Brand.ink)
            .frame(width: 48, height: 48)
            .background(filled ? (stopping ? Brand.inkFill : Brand.relay) : Brand.surface, in: Circle())
            .overlay(Circle().fill(Color.black.opacity(configuration.isPressed ? 0.15 : 0)))
            .modifier(BrandEnabledOpacity())
            .contentShape(Circle())
    }
}

struct BrandChannelPicker: View {
    let channels: [IdentityChannel]
    @Binding var selection: IdentityChannel
    var body: some View {
        HStack(spacing: 6) {
            ForEach(channels) { channel in
                Button { selection = channel } label: {
                    Text(LocalizedStringKey(channel.label)).font(.body.weight(.semibold))
                        .foregroundStyle(selection == channel ? Brand.ink : Brand.muted)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(selection == channel ? Brand.surface : .clear, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == channel ? .isSelected : [])
            }
        }
        .padding(4)
        .background(Brand.line, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityLabel("Sign in with")
    }
}

extension View {
    func brandCard(radius: CGFloat = 20) -> some View {
        background(Brand.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
    }

    func brandScreen() -> some View {
        foregroundStyle(Brand.ink).tint(Brand.relayText).background(Brand.paper)
    }

    #if os(iOS)
    func brandRows() -> some View {
        listRowBackground(Brand.surface).listRowSeparatorTint(Brand.separator)
    }

    func brandNavigationTitle(_ title: LocalizedStringKey) -> some View {
        navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .principal) { Text(title).font(Brand.title(20, relativeTo: .headline)) } }
    }

    func brandList() -> some View {
        foregroundStyle(Brand.ink).scrollContentBackground(.hidden)
            .background(Brand.paper)
            .tint(Brand.relayText)
            .environment(\.defaultMinListRowHeight, 44)
    }
    #endif
}

struct BrandPasswordField: View {
    let title: String
    @Binding var text: String
    var newPassword = false
    var externalFocus: FocusState<Bool>.Binding? = nil
    @State private var visible = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(LocalizedStringKey(title)).font(.caption.weight(.semibold)).foregroundStyle(Brand.muted)
            HStack(spacing: 0) {
                Group {
                    if visible { TextField(title, text: $text) }
                    else { SecureField(title, text: $text) }
                }
                .textContentType(newPassword ? .newPassword : .password)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused(externalFocus ?? $focused)
                Button { visible.toggle() } label: {
                    Image(systemName: visible ? "eye.slash" : "eye")
                        .foregroundStyle(Brand.muted).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(visible ? "Hide password" : "Show password")
            }
            .brandInput(focused: externalFocus?.wrappedValue ?? focused)
        }
    }
}

extension View {
    func brandInput(focused: Bool = false) -> some View {
        padding(.horizontal, 16).padding(.vertical, 5)
            .frame(minHeight: 54)
            .background(Brand.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(focused ? Brand.relay : Brand.line, lineWidth: focused ? 2 : 1.5))
    }
}

private struct BrandEnabledOpacity: ViewModifier {
    @Environment(\.isEnabled) private var enabled
    func body(content: Content) -> some View { content.opacity(enabled ? 1 : 0.45) }
}

struct TintedCapsuleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold)).foregroundStyle(Brand.relayText)
            .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 44)
            .background(Brand.relaySoft, in: Capsule())
            .overlay(Capsule().fill(Color.black.opacity(configuration.isPressed ? 0.15 : 0)))
            .modifier(BrandEnabledOpacity()).contentShape(Capsule())
    }
}
