import Foundation
import Testing
@testable import HypervibeCompanionCore

// Runs the real client against the current server (see CurrentCoreConnectionsContractTests).
// A refresh must keep each environment's deployment settings, because they decide
// whether Deploy goes through CI or deploys directly. Nothing here dispatches.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["HYPERVIBE_COMPANION_CONNECTION_FIXTURE"] != nil))
struct CurrentCoreDeploymentContractTests {
    @Test
    func refreshKeepsEachEnvironmentsDeploymentRoute() async throws {
        let fixture = try #require(ProcessInfo.processInfo.environment["HYPERVIBE_COMPANION_CONNECTION_FIXTURE"])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let repository = root.appendingPathComponent("repository")
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let project = CompanionProject(
            displayName: "companion-contract",
            repositoryPath: repository.path,
            hypervibeExecutablePath: "/usr/bin/env",
            hypervibeArguments: ["node", fixture, "verified-github"],
            hypervibeDataDirectory: root.appendingPathComponent("data").path,
            enabledEnvironments: nil
        )
        let client = HypervibeMCPClient(clientVersion: "integration-test")
        let snapshot = try await client.refresh(project: project).snapshot
        func environment(_ name: String) throws -> EnvironmentSnapshot {
            try #require(snapshot.environments.first { $0.name == name })
        }

        // Production promotes from staging through CI on the release branch.
        let production = try environment("production")
        #expect(production.deployment?.usesManagedCI == true)
        #expect(production.deployment?.promoteFrom == "staging")
        let viaCI = try await client.prepareProductionDeployment(project: project, environment: production)
        #expect(viaCI.mechanism == .managedCI)
        #expect(viaCI.environment == "production")
        #expect(viaCI.branch == "release")
        #expect(viaCI.definitions.map(\.id) == ["101"])

        // A custom target is recognizable only through its settings. It keeps its
        // Deploy button and its CI route.
        let live = try environment("live")
        #expect(live.isProductionTarget)
        #expect(live.deployment?.promoteFrom == "staging")
        let liveRoute = try await client.prepareProductionDeployment(project: project, environment: live)
        #expect(liveRoute.mechanism == .managedCI)
        #expect(liveRoute.environment == "live")
        #expect(liveRoute.branch == "live")

        // No deploy settings declared: a direct deploy, and known to be one.
        let direct = try environment("production-eu")
        #expect(direct.deployment == nil)
        #expect(try await client.prepareProductionDeployment(project: project, environment: direct).mechanism == .direct)

        // Staging is not a promotion target.
        await #expect(throws: HypervibeClientError.self) {
            try await client.prepareProductionDeployment(project: project, environment: try environment("staging"))
        }

        // A snapshot cached before this fix has no deployment settings recorded.
        // Unknown settings must never be read as a direct deploy.
        let cached = try JSONDecoder().decode(
            EnvironmentSnapshot.self,
            from: Data(#"{"name":"production","specRevision":1,"resources":[]}"#.utf8)
        )
        await #expect(throws: HypervibeClientError.self) {
            try await client.prepareProductionDeployment(project: project, environment: cached)
        }
    }
}
