import Foundation
import Testing
@testable import HypervibeCompanionCore

struct AggregateHealthTests {
    @Test
    func projectRefreshFailuresNeedAttentionEvenWithAHealthySnapshot() {
        let snapshot = makeSnapshot(health: .inSync)

        #expect(
            AggregateHealth.needsAttention(
                snapshots: [snapshot],
                hasRefreshFailure: true
            )
        )
        #expect(
            !AggregateHealth.needsAttention(
                snapshots: [snapshot],
                hasRefreshFailure: false
            )
        )
    }

    @Test
    func driftedBlockedAndFailedEnvironmentsNeedAttention() {
        for health in [EnvironmentHealth.drifted, .blocked, .failed] {
            #expect(
                AggregateHealth.needsAttention(
                    snapshots: [makeSnapshot(health: health)],
                    hasRefreshFailure: false
                )
            )
        }
    }

    @Test
    func failedPublicEndpointCheckNeedsAttentionIndependentlyFromDrift() {
        let snapshot = ProjectSnapshot(
            projectID: UUID(),
            projectName: "test",
            generatedAt: Date(timeIntervalSince1970: 1),
            environments: [
                EnvironmentSnapshot(
                    name: "production",
                    specRevision: 1,
                    resources: [],
                    observation: makeObservation(health: .inSync),
                    publicEndpointHealth: [
                        PublicEndpointHealth(
                            service: "web",
                            url: URL(string: "https://app.example.com")!,
                            ok: false,
                            status: 503,
                            latencyMs: 42,
                            checkedAt: Date(timeIntervalSince1970: 1)
                        ),
                    ]
                ),
            ],
            recentRuns: []
        )

        #expect(
            AggregateHealth.needsAttention(
                snapshots: [snapshot],
                hasRefreshFailure: false
            )
        )
    }

    @Test
    func singletonResourcesMatchProviderSpecificDriftNames() {
        let observation = makeObservation(
            health: .drifted,
            driftedResources: [
                DriftedResource(
                    kind: "ci",
                    name: "deploy-branch:production",
                    actionType: "update",
                    provider: "github"
                ),
                DriftedResource(
                    kind: "ios",
                    name: "External Testers",
                    actionType: "create",
                    provider: "appstoreconnect"
                ),
            ]
        )

        let ci = ResourceSummary(
            id: "ci:deploy",
            kind: .ci,
            name: "deploy",
            desiredProvider: "github-actions"
        )
        let ios = ResourceSummary(
            id: "ios:com.example.app",
            kind: .ios,
            name: "com.example.app",
            desiredProvider: "app-store-connect"
        )

        #expect(observation.driftedResource(matching: ci)?.name == "deploy-branch:production")
        #expect(observation.driftedResource(matching: ios)?.name == "External Testers")
    }

    @Test
    func preferredServiceURLResanitizesCachedEndpointValues() {
        let service = ServiceObservation(
            name: "web",
            status: .running,
            url: URL(
                string: "https://app.example.com/private/sentinel-path?token=sentinel-query"
            ),
            customDomains: ["bad/path"]
        )
        let credentialed = ServiceObservation(
            name: "worker",
            status: .failed,
            url: URL(string: "https://sentinel-user:sentinel-password@worker.example.com"),
            customDomains: []
        )

        #expect(service.preferredURL?.absoluteString == "https://app.example.com")
        #expect(credentialed.preferredURL == nil)
    }

    private func makeSnapshot(health: EnvironmentHealth) -> ProjectSnapshot {
        ProjectSnapshot(
            projectID: UUID(),
            projectName: "test",
            generatedAt: Date(timeIntervalSince1970: 1),
            environments: [
                EnvironmentSnapshot(
                    name: "production",
                    specRevision: 1,
                    resources: [],
                    observation: makeObservation(health: health)
                ),
            ],
            recentRuns: []
        )
    }

    private func makeObservation(
        health: EnvironmentHealth,
        driftedResources: [DriftedResource]? = nil
    ) -> ObservationSummary {
        ObservationSummary(
            health: health,
            verified: health != .unverified,
            driftCount: driftedResources?.count ?? 0,
            unmanagedCount: 0,
            blockedProviders: [],
            latestAttemptAt: Date(timeIntervalSince1970: 1),
            latestSuccessfulAt: Date(timeIntervalSince1970: 1),
            driftedResources: driftedResources
        )
    }
}
