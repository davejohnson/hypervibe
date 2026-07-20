import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct MCPHostConfiguratorTests {
    @Test
    func claudeConfigurationMergesBacksUpAndDisconnectsManagedProjects() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let initial: [String: Any] = [
            "theme": "dark",
            "mcpServers": [
                "existing": [
                    "command": "/usr/bin/existing",
                    "args": ["serve"],
                ],
            ],
        ]
        let initialData = try JSONSerialization.data(
            withJSONObject: initial,
            options: [.prettyPrinted, .sortedKeys]
        )
        try initialData.write(to: fixture.claudeConfigURL)

        try await fixture.configurator.connect(
            .claudeDesktop,
            projects: [fixture.project],
            launcherURL: fixture.launcherURL
        )

        let connected = try JSONSerialization.jsonObject(
            with: Data(contentsOf: fixture.claudeConfigURL)
        ) as? [String: Any]
        let servers = connected?["mcpServers"] as? [String: Any]
        let managed = servers?[MCPHostConfigurator.serverName(
            for: fixture.project
        )] as? [String: Any]
        #expect(connected?["theme"] as? String == "dark")
        #expect(servers?["existing"] != nil)
        #expect(managed?["command"] as? String == fixture.launcherURL.path)
        #expect(managed?["args"] as? [String] == [
            "--project-root", fixture.project.repositoryPath,
            "--data-dir", fixture.project.hypervibeDataDirectory!,
        ])
        #expect(FileManager.default.fileExists(
            atPath: fixture.claudeConfigURL
                .appendingPathExtension("hypervibe-backup").path
        ))

        let status = try await fixture.configurator.status(
            for: .claudeDesktop,
            projects: [fixture.project],
            launcherURL: fixture.launcherURL
        )
        #expect(status.isFullyConnected)

        try await fixture.configurator.disconnect(
            .claudeDesktop,
            projects: [fixture.project]
        )
        let disconnected = try JSONSerialization.jsonObject(
            with: Data(contentsOf: fixture.claudeConfigURL)
        ) as? [String: Any]
        let remainingServers = disconnected?["mcpServers"] as? [String: Any]
        #expect(remainingServers?["existing"] != nil)
        #expect(remainingServers?[MCPHostConfigurator.serverName(
            for: fixture.project
        )] == nil)
    }

    @Test
    func codexConfigurationUsesIdempotentManagedBlocksAndPreservesUserSettings() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let initial = """
        model = "gpt-5"

        [mcp_servers.existing]
        command = "/usr/bin/existing"
        """ + "\n"
        try Data(initial.utf8).write(to: fixture.codexConfigURL)

        for _ in 0..<2 {
            try await fixture.configurator.connect(
                .codex,
                projects: [fixture.project],
                launcherURL: fixture.launcherURL
            )
        }

        let connected = try String(
            contentsOf: fixture.codexConfigURL,
            encoding: .utf8
        )
        let identifier = fixture.project.id.uuidString.lowercased()
        #expect(connected.contains("model = \"gpt-5\""))
        #expect(connected.contains("[mcp_servers.existing]"))
        #expect(connected.contains(
            "[mcp_servers.\"\(MCPHostConfigurator.serverName(for: fixture.project))\"]"
        ))
        #expect(connected.contains("command = \"\(fixture.launcherURL.path)\""))
        #expect(connected.components(
            separatedBy: "# BEGIN HYPERVIBE COMPANION \(identifier)"
        ).count == 2)

        let status = try await fixture.configurator.status(
            for: .codex,
            projects: [fixture.project],
            launcherURL: fixture.launcherURL
        )
        #expect(status.isFullyConnected)

        try await fixture.configurator.disconnect(
            .codex,
            projects: [fixture.project]
        )
        let disconnected = try String(
            contentsOf: fixture.codexConfigURL,
            encoding: .utf8
        )
        #expect(disconnected.contains("model = \"gpt-5\""))
        #expect(disconnected.contains("[mcp_servers.existing]"))
        #expect(!disconnected.contains("HYPERVIBE COMPANION"))
    }

    @Test
    func malformedClaudeConfigurationIsPreserved() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let malformed = Data("{ not json".utf8)
        try malformed.write(to: fixture.claudeConfigURL)

        await #expect(throws: MCPHostConfigurationError.self) {
            try await fixture.configurator.connect(
                .claudeDesktop,
                projects: [fixture.project],
                launcherURL: fixture.launcherURL
            )
        }
        #expect(try Data(contentsOf: fixture.claudeConfigURL) == malformed)
    }

    @Test
    func mismatchedCodexMarkersArePreserved() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let malformed = Data("""
        # BEGIN HYPERVIBE COMPANION first
        [mcp_servers.broken]
        command = "/tmp/broken"
        # END HYPERVIBE COMPANION second
        """.utf8)
        try malformed.write(to: fixture.codexConfigURL)

        await #expect(throws: MCPHostConfigurationError.self) {
            try await fixture.configurator.connect(
                .codex,
                projects: [fixture.project],
                launcherURL: fixture.launcherURL
            )
        }
        #expect(try Data(contentsOf: fixture.codexConfigURL) == malformed)
    }

    private final class Fixture: @unchecked Sendable {
        let root: URL
        let launcherURL: URL
        let claudeConfigURL: URL
        let codexConfigURL: URL
        let project: CompanionProject
        let configurator: MCPHostConfigurator

        init() throws {
            let fileManager = FileManager.default
            root = fileManager.temporaryDirectory
                .appendingPathComponent("hypervibe-mcp-host-tests-\(UUID())")
            let repository = root.appendingPathComponent("repo", isDirectory: true)
            let dataDirectory = root.appendingPathComponent("data", isDirectory: true)
            launcherURL = root.appendingPathComponent("HypervibeMCPLauncher")
            claudeConfigURL = root
                .appendingPathComponent("Claude", isDirectory: true)
                .appendingPathComponent("claude_desktop_config.json")
            codexConfigURL = root
                .appendingPathComponent("Codex", isDirectory: true)
                .appendingPathComponent("config.toml")
            try fileManager.createDirectory(at: repository, withIntermediateDirectories: true)
            try fileManager.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            try fileManager.createDirectory(
                at: claudeConfigURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try fileManager.createDirectory(
                at: codexConfigURL.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            fileManager.createFile(atPath: launcherURL.path, contents: Data())
            try fileManager.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: launcherURL.path
            )

            project = CompanionProject(
                id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!,
                displayName: "Invoice Express",
                repositoryPath: repository.path,
                hypervibeExecutablePath: launcherURL.path,
                hypervibeDataDirectory: dataDirectory.path
            )
            configurator = MCPHostConfigurator(
                claudeConfigURL: claudeConfigURL,
                codexConfigURL: codexConfigURL
            )
        }

        func remove() {
            try? FileManager.default.removeItem(at: root)
        }
    }
}
