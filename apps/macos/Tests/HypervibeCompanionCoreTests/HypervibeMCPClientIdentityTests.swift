import Foundation
import Testing
@testable import HypervibeCompanionCore

struct HypervibeMCPClientIdentityTests {
    @Test
    func usesTheInjectedCompanionVersion() {
        let client = HypervibeMCPClient(clientVersion: "2.4.6")
        #expect(client.clientVersion == "2.4.6")
    }

    @Test
    func givesDevelopmentBuildsAnHonestFallbackIdentity() {
        let client = HypervibeMCPClient(clientVersion: "  ")
        #expect(client.clientVersion == "development")
    }

    @Test
    func nonresponsiveRuntimeReturnsATargetedTimeout() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("hypervibe-client-timeout-\(UUID())", isDirectory: true)
        let executable = root.appendingPathComponent("nonresponsive-server")
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: root) }

        try Data("#!/bin/sh\nwhile IFS= read -r line; do :; done\n".utf8)
            .write(to: executable)
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: executable.path
        )

        let project = CompanionProject(
            displayName: "timeout-fixture",
            repositoryPath: root.path,
            hypervibeExecutablePath: executable.path
        )
        let client = HypervibeMCPClient(
            clientVersion: "test",
            handshakeTimeout: .milliseconds(100),
            toolTimeout: .milliseconds(100)
        )

        do {
            _ = try await client.probe(project: project)
            Issue.record("Expected the nonresponsive runtime to time out.")
        } catch let error as HypervibeClientError {
            #expect(error == .timedOut("starting the project MCP runtime"))
        }
    }
}
