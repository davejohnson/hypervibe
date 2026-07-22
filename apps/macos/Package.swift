// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "HypervibeCompanion",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "HypervibeCompanionCore",
            targets: ["HypervibeCompanionCore"]
        ),
        .executable(
            name: "HypervibeCompanion",
            targets: ["HypervibeCompanion"]
        ),
        .executable(
            name: "HypervibeMCPLauncher",
            targets: ["HypervibeMCPLauncher"]
        ),
        .executable(
            name: "HypervibeCompanionUpdater",
            targets: ["HypervibeCompanionUpdater"]
        ),
    ],
    dependencies: [
        .package(
            url: "https://github.com/modelcontextprotocol/swift-sdk.git",
            exact: "0.12.1"
        ),
        .package(
            url: "https://github.com/apple/swift-system.git",
            from: "1.0.0"
        ),
    ],
    targets: [
        .target(
            name: "HypervibeCompanionCore",
            dependencies: [
                .product(name: "MCP", package: "swift-sdk"),
                .product(name: "SystemPackage", package: "swift-system"),
            ]
        ),
        .executableTarget(
            name: "HypervibeCompanion",
            dependencies: ["HypervibeCompanionCore"]
        ),
        .executableTarget(
            name: "HypervibeMCPLauncher"
        ),
        .executableTarget(
            name: "HypervibeCompanionUpdater"
        ),
        .testTarget(
            name: "HypervibeCompanionCoreTests",
            dependencies: ["HypervibeCompanionCore"]
        ),
    ]
)
