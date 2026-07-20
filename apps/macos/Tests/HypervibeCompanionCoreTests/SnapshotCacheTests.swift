import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct SnapshotCacheTests {
    @Test
    func snapshotsAreDisposableAndReplaceable() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("hypervibe-snapshots-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }

        let cache = SnapshotCache(
            fileURL: root.appendingPathComponent("snapshots.json")
        )
        let projectID = UUID()
        let initial = makeSnapshot(
            projectID: projectID,
            health: .drifted,
            generatedAt: Date(timeIntervalSince1970: 100)
        )
        let refreshed = makeSnapshot(
            projectID: projectID,
            health: .inSync,
            generatedAt: Date(timeIntervalSince1970: 200)
        )

        try await cache.replace(initial)
        #expect(try await cache.snapshot(for: projectID) == initial)

        try await cache.replace(refreshed)
        #expect(try await cache.load() == [refreshed])

        try await cache.removeAll()
        #expect(try await cache.load().isEmpty)
    }

    private func makeSnapshot(
        projectID: UUID,
        health: EnvironmentHealth,
        generatedAt: Date
    ) -> ProjectSnapshot {
        let observation = ObservationSummary(
            health: health,
            verified: true,
            driftCount: health == .drifted ? 1 : 0,
            unmanagedCount: 0,
            blockedProviders: [],
            latestAttemptAt: generatedAt,
            latestSuccessfulAt: generatedAt
        )
        return ProjectSnapshot(
            projectID: projectID,
            projectName: "Example",
            generatedAt: generatedAt,
            environments: [
                EnvironmentSnapshot(
                    name: "staging",
                    specRevision: 3,
                    resources: [
                        ResourceSummary(
                            id: "service:api",
                            kind: .service,
                            name: "api",
                            desiredProvider: "railway"
                        ),
                    ],
                    observation: observation
                ),
            ],
            recentRuns: []
        )
    }

    @Test
    func cachedObservationsCanBePresentedAsStale() throws {
        let successfulAt = Date(timeIntervalSince1970: 100)
        let snapshot = ProjectSnapshot(
            projectID: UUID(),
            projectName: "example",
            generatedAt: successfulAt,
            environments: [
                EnvironmentSnapshot(
                    name: "production",
                    specRevision: 1,
                    resources: [],
                    observation: ObservationSummary(
                        health: .inSync,
                        verified: true,
                        driftCount: 0,
                        unmanagedCount: 0,
                        blockedProviders: [],
                        latestAttemptAt: successfulAt,
                        latestSuccessfulAt: successfulAt
                    )
                ),
            ],
            recentRuns: []
        )

        let stale = snapshot.markingObservationsStale()
        let observation = try #require(stale.environments.first?.observation)

        #expect(observation.health == .stale)
        #expect(observation.verified)
        #expect(observation.latestSuccessfulAt == successfulAt)
    }
}
