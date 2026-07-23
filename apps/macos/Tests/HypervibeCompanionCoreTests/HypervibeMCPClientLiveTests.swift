import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct HypervibeMCPClientLiveTests {
    @Test
    func configuredLocalServerProducesASnapshot() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let repository = environment["HYPERVIBE_COMPANION_TEST_REPO"],
            let executable = environment["HYPERVIBE_COMPANION_TEST_EXECUTABLE"] else {
            return
        }

        let arguments = environment["HYPERVIBE_COMPANION_TEST_ARGUMENTS"]?
            .split(separator: "\n")
            .map(String.init)
        let project = CompanionProject(
            displayName: "live-probe",
            repositoryPath: repository,
            hypervibeExecutablePath: executable,
            hypervibeArguments: arguments,
            hypervibeDataDirectory: environment["HYPERVIBE_COMPANION_TEST_DATA_DIR"]
        )

        let client = HypervibeMCPClient(clientVersion: "integration-test")
        let refresh = try await client.refresh(project: project)
        let snapshot = refresh.snapshot

        #expect(!snapshot.projectName.isEmpty)
        #expect(!snapshot.environments.isEmpty)
        #expect(snapshot.environments.allSatisfy { !$0.resources.isEmpty })
        #expect(refresh.connections.allSatisfy { !$0.provider.isEmpty })

        let catalog = try await client.connectionCatalog(project: project)
        #expect(!catalog.providers.isEmpty)
        #expect(
            catalog.providers.first { $0.name == "railway" }?
                .credentialFields?.contains { $0.name == "apiToken" } == true
        )
    }
}
