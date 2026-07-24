import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct ProjectRegistryStoreTests {
    @Test
    func registryRoundTripsAndSortsProjects() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = ProjectRegistryStore(
            fileURL: root.appendingPathComponent("projects.json")
        )
        let later = Date(timeIntervalSince1970: 200)
        let alpha = CompanionProject(
            displayName: "Alpha",
            repositoryPath: "/repos/alpha",
            hypervibeExecutablePath: "/usr/local/bin/hypervibe",
            createdAt: later,
            updatedAt: later
        )
        let zulu = CompanionProject(
            displayName: "Zulu",
            repositoryPath: "/repos/zulu",
            hypervibeExecutablePath: "/usr/local/bin/hypervibe",
            createdAt: later,
            updatedAt: later
        )

        _ = try await store.upsert(zulu)
        _ = try await store.upsert(alpha)

        #expect(try await store.load() == [alpha, zulu])
    }

    @Test
    func registryRejectsIncompleteProcessContext() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let store = ProjectRegistryStore(
            fileURL: root.appendingPathComponent("projects.json")
        )
        let invalid = CompanionProject(
            displayName: "Example",
            repositoryPath: "",
            hypervibeExecutablePath: "/usr/local/bin/hypervibe"
        )

        await #expect(throws: ProjectRegistryError.invalidRepositoryPath) {
            try await store.upsert(invalid)
        }
    }

    @Test
    func legacyRegistryDefaultsReadinessToUnknown() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("projects.json")
        let id = UUID()
        try Data(
            """
            {
              "schemaVersion": 1,
              "projects": [{
                "id": "\(id.uuidString)",
                "displayName": "Legacy",
                "repositoryPath": "/repos/legacy",
                "hypervibeExecutablePath": "/Applications/Hypervibe.app/Contents/MacOS/hypervibe-mcp",
                "scheduledRefreshEnabled": false,
                "refreshIntervalMinutes": 30,
                "createdAt": "2026-07-23T00:00:00Z",
                "updatedAt": "2026-07-23T00:00:00Z"
              }]
            }
            """.utf8
        ).write(to: file)

        let projects = try await ProjectRegistryStore(fileURL: file).load()

        #expect(projects.first?.readiness == .unknown)
        #expect(ProjectRegistryStore.hasStoredProjects(fileURL: file))
    }

    @Test
    func removingAProjectDoesNotTouchItsRepository() async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let repository = root.appendingPathComponent("repo", isDirectory: true)
        try FileManager.default.createDirectory(
            at: repository,
            withIntermediateDirectories: true
        )
        let marker = repository.appendingPathComponent("keep-me")
        try Data("authoritative state".utf8).write(to: marker)

        let store = ProjectRegistryStore(
            fileURL: root.appendingPathComponent("app/projects.json")
        )
        let project = CompanionProject(
            displayName: "Example",
            repositoryPath: repository.path,
            hypervibeExecutablePath: "/usr/local/bin/hypervibe"
        )

        _ = try await store.upsert(project)
        _ = try await store.remove(id: project.id)

        #expect(FileManager.default.fileExists(atPath: marker.path))
        #expect(try await store.load().isEmpty)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("hypervibe-companion-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: url,
            withIntermediateDirectories: true
        )
        return url
    }
}
