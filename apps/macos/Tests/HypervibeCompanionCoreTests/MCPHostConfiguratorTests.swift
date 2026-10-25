import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct MCPHostConfiguratorTests {
    @Test
    func codexConnectInstallsBundledGuidanceWithoutASeparateRuntimeOrClient() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try await fixture.configurator.connect(
            .codex,
            projects: [fixture.project],
            launcherURL: fixture.launcherURL
        )
        #expect(FileManager.default.fileExists(atPath: fixture.skillInstalledURL.path))
        let calls = try String(contentsOf: fixture.skillCallsURL, encoding: .utf8)
        #expect(calls.contains("install codex --skill-only --check"))
        #expect(calls.contains("install codex --skill-only\n"))
    }

    @Test
    func checkingGuidanceDoesNotInstallItOrCreateMCPConfiguration() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let status = try await fixture.configurator.status(for: .codex, projects: [fixture.project], launcherURL: fixture.launcherURL)
        #expect(status.skill.state == .missing)
        #expect(status.skill.needsUpdate)
        #expect(!FileManager.default.fileExists(atPath: fixture.skillInstalledURL.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.codexConfigURL.path))
        #expect(try String(contentsOf: fixture.skillCallsURL, encoding: .utf8) == "install codex --skill-only --check\n")
    }

    @Test
    func modifiedGuidanceIsPreservedWhileMCPStillConnects() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.setLauncher("printf '%s\\n' '{\"schema\":1,\"client\":\"codex\",\"state\":\"modified\",\"packageVersion\":\"0.1.43\"}'")
        try await fixture.configurator.connect(.codex, projects: [fixture.project], launcherURL: fixture.launcherURL)
        let status = try await fixture.configurator.status(for: .codex, projects: [fixture.project], launcherURL: fixture.launcherURL)
        #expect(status.isFullyConnected)
        #expect(!status.isReady)
        #expect(status.skill.state == .modified)
        #expect(!status.skill.needsUpdate)
        await #expect(throws: MCPHostSkillError.self) {
            try await fixture.configurator.updateSkill(for: .codex, launcherURL: fixture.launcherURL)
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.skillInstalledURL.path))
    }

    @Test
    func installationFailureKeepsMCPAndReportsMissingGuidance() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.setLauncher("""
        if [ "$*" = 'install codex --skill-only --check' ]; then
          printf '%s\\n' '{"schema":1,"client":"codex","state":"missing","packageVersion":"0.1.43"}'
        else
          printf '%s' 'synthetic-private-credential' >&2
          exit 1
        fi
        """)
        await #expect(throws: MCPHostSkillError.self) {
            try await fixture.configurator.connect(.codex, projects: [fixture.project], launcherURL: fixture.launcherURL)
        }
        let status = try await fixture.configurator.status(for: .codex, projects: [fixture.project], launcherURL: fixture.launcherURL)
        #expect(status.isFullyConnected)
        #expect(status.skill.state == .missing)
        #expect(!status.isReady)
    }

    @Test
    func unknownLaunchersAndUnsafeReceiptsNeverClaimCurrentGuidance() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        for output in ["legacy launcher", "{\"schema\":1,\"client\":\"codex\",\"state\":\"current\",\"packageVersion\":\"synthetic-private-credential\"}"] {
            try fixture.setLauncher("printf '%s' '\(output)'")
            let status = await MCPHostSkillManager().status(launcherURL: fixture.launcherURL)
            #expect(status.state == .unavailable)
            #expect(status.packageVersion == nil)
        }
        try await fixture.configurator.connect(.codex, projects: [fixture.project], launcherURL: fixture.launcherURL)
        #expect(try await fixture.configurator.status(for: .codex, projects: [fixture.project], launcherURL: fixture.launcherURL).isFullyConnected)
    }

    @Test
    func guidanceProcessHasBoundedTimeAndOutput() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try fixture.setLauncher("exec /bin/sleep 5")
        let start = Date()
        #expect(await MCPHostSkillManager(timeoutSeconds: 0.05).status(launcherURL: fixture.launcherURL).state == .unavailable)
        #expect(Date().timeIntervalSince(start) < 2)
        try fixture.setLauncher("/usr/bin/head -c 16384 /dev/zero")
        #expect(await MCPHostSkillManager().status(launcherURL: fixture.launcherURL).state == .unavailable)
    }

    @Test
    func claudeDesktopAndEmptyProjectStatusDoNotRunSkillSetup() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        #expect(try await fixture.configurator.status(for: .claudeDesktop, projects: [fixture.project], launcherURL: fixture.launcherURL).skill.state == .notSupported)
        #expect(try await fixture.configurator.status(for: .codex, projects: [], launcherURL: fixture.launcherURL).skill.state == .unavailable)
        #expect(!FileManager.default.fileExists(atPath: fixture.skillCallsURL.path))
    }

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
        let skillInstalledURL: URL
        let skillCallsURL: URL
        let project: CompanionProject
        let configurator: MCPHostConfigurator

        init() throws {
            let fileManager = FileManager.default
            root = fileManager.temporaryDirectory
                .appendingPathComponent("hypervibe-mcp-host-tests-\(UUID())")
            let repository = root.appendingPathComponent("repo", isDirectory: true)
            let dataDirectory = root.appendingPathComponent("data", isDirectory: true)
            launcherURL = root.appendingPathComponent("HypervibeMCPLauncher")
            skillInstalledURL = root.appendingPathComponent("skill-installed")
            skillCallsURL = root.appendingPathComponent("skill-calls")
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
            let script = """
            #!/bin/sh
            printf '%s\\n' "$*" >> '\(skillCallsURL.path)'
            if [ "$*" = 'install codex --skill-only --check' ]; then
              if [ -f '\(skillInstalledURL.path)' ]; then state=current; else state=missing; fi
              printf '{"schema":1,"client":"codex","state":"%s","packageVersion":"0.1.43"}\\n' "$state"
            elif [ "$*" = 'install codex --skill-only' ]; then
              /usr/bin/touch '\(skillInstalledURL.path)'
            else
              exit 2
            fi
            """ + "\n"
            fileManager.createFile(atPath: launcherURL.path, contents: Data(script.utf8))
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

        func setLauncher(_ body: String) throws {
            try Data(("#!/bin/sh\n" + body + "\n").utf8).write(to: launcherURL)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcherURL.path)
        }
    }
}
