import Foundation
import Testing
@testable import HypervibeCompanionCore

// The macOS contract check supplies the fixture entry point after building the current core.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["HYPERVIBE_COMPANION_CONNECTION_FIXTURE"] != nil))
struct CurrentCoreConnectionsContractTests {
    @Test(arguments: ["refresh", "catalog"])
    func savedConnectionsFromTheCurrentServer(_ operation: String) async throws {
        let fixture = try #require(ProcessInfo.processInfo.environment["HYPERVIBE_COMPANION_CONNECTION_FIXTURE"])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let repository = root.appendingPathComponent("repository")
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let project = CompanionProject(
            displayName: "companion-contract",
            repositoryPath: repository.path,
            hypervibeExecutablePath: "/usr/bin/env",
            hypervibeArguments: ["node", fixture],
            hypervibeDataDirectory: root.appendingPathComponent("data").path,
            enabledEnvironments: []
        )
        let client = HypervibeMCPClient(clientVersion: "integration-test")
        let saved = ConnectionSummary(provider: "github", scope: "example/companion-contract",
                                      status: .pending, lastVerifiedAt: nil)
        if operation == "refresh" {
            let refresh = try await client.refresh(project: project)
            #expect(refresh.snapshot.projectName == "companion-contract")
            #expect(refresh.connections == [saved])
        } else {
            let catalog = try await client.connectionCatalog(project: project)
            #expect(catalog.connections == [saved])
            #expect(catalog.providers.contains { $0.name == "railway" })
        }
    }
}
