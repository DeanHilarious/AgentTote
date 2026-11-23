// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentAnywhere",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "AgentAnywhere", targets: ["AgentAnywhereMac"])],
    targets: [
        .executableTarget(name: "AgentAnywhereMac", resources: [.process("Resources")]),
        .testTarget(name: "AgentAnywhereMacTests", dependencies: ["AgentAnywhereMac"])
    ],
    swiftLanguageModes: [.v5]
)
