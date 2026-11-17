import Foundation
import Testing
@testable import HypervibeCompanionCore

struct ProjectStatusTests {
    private let projectID = UUID()
    private let appURL = URL(string: "https://app.example.com")!

    @Test
    func aRespondingAppIsReportedAsRunningWithItsAddress() {
        let status = evaluate([
            environment("staging", health: .inSync, endpointOK: true, url: URL(string: "https://staging.example.com")),
            environment("production", health: .inSync, endpointOK: true, url: appURL),
        ])

        #expect(status.level == .good)
        #expect(status.headline == "Everything is running")
        #expect(status.issues.isEmpty)
        #expect(status.liveURL == appURL)
    }

    @Test
    func anAppThatStopsRespondingOutranksWaitingChanges() {
        let status = evaluate([
            environment("staging", health: .drifted),
            environment("production", health: .inSync, endpointOK: false, httpStatus: 503),
        ])

        #expect(status.level == .down)
        #expect(status.headline == "1 service is down")
        #expect(status.issues.first?.title == "web is not responding in production (HTTP 503)")
        #expect(status.issues.map(\.level) == [.down, .attention])
        #expect(status.issues.first?.chatPrompt?.contains("production environment of shop") == true)
    }

    @Test
    func aServiceTheCloudReportsAsFailedIsDownEvenWithoutAPublicAddress() {
        let failed = EnvironmentSnapshot(
            name: "production",
            specRevision: 1,
            resources: [],
            observation: observation(.inSync, services: [
                ServiceObservation(name: "worker", status: .failed, url: nil, customDomains: []),
            ])
        )

        let status = EnvironmentStatus.evaluate(failed, projectName: "shop")

        #expect(status.level == .down)
        #expect(status.label == "Down")
        #expect(status.issues.map(\.title) == ["worker failed in production"])
    }

    @Test
    func aRespondingAppIsLiveWithoutClaimingItsCloudSettingsWereChecked() {
        let live = EnvironmentStatus.evaluate(
            environment("production", health: .unverified, endpointOK: true),
            projectName: "shop"
        )
        let unchecked = EnvironmentStatus.evaluate(
            environment("production", health: .unverified),
            projectName: "shop"
        )

        #expect(live.label == "Live")
        #expect(unchecked.level == .unknown)
        #expect(unchecked.label == "Not checked")
    }

    @Test
    func lastRunsCachedResultIsNeverPresentedAsCurrent() {
        let cached = snapshot([
            environment("production", health: .inSync, endpointOK: false),
        ]).markingObservationsStale()

        let status = ProjectStatus.evaluate(
            snapshot: cached,
            refreshError: nil,
            isInitialized: true
        )

        #expect(status.level == .unknown)
        #expect(status.headline == "Not checked yet")
        #expect(status.issues.isEmpty)
    }

    @Test
    func aFailedRefreshKeepsTheLastStatusAndSaysItIsOld() {
        let status = ProjectStatus.evaluate(
            snapshot: snapshot([environment("production", health: .inSync, endpointOK: true)]),
            refreshError: "Hypervibe did not start.",
            isInitialized: true
        )

        #expect(status.level == .attention)
        #expect(status.headline.contains("last known status"))
        #expect(status.issues.first?.chatPrompt == nil)
    }

    @Test
    func blockedAccessAndUndeployedAppsAreNamedPlainly() {
        let blocked = EnvironmentSnapshot(
            name: "production",
            specRevision: 1,
            resources: [],
            observation: observation(.blocked, blockedProviders: ["gcp"])
        )
        let empty = EnvironmentSnapshot(
            name: "production",
            specRevision: 1,
            resources: [],
            observation: observation(.inSync, services: [
                ServiceObservation(name: "web", status: .empty, url: nil, customDomains: []),
            ])
        )

        #expect(EnvironmentStatus.evaluate(blocked, projectName: "shop").label == "Needs access")
        #expect(evaluate([empty]).headline == "Not deployed yet")
        #expect(
            ProjectStatus.evaluate(snapshot: nil, refreshError: nil, isInitialized: false)
                .headline == "Ready for chat"
        )
    }

    @Test
    func noticesFireOnlyWhenAnAppGoesDownOrComesBack() {
        let up = snapshot([environment("production", health: .inSync, endpointOK: true)])
        let down = snapshot([environment("production", health: .inSync, endpointOK: false)])

        #expect(StatusChanges.notices(previous: nil, current: down).isEmpty)
        #expect(StatusChanges.notices(previous: up, current: up).isEmpty)
        #expect(StatusChanges.notices(previous: down, current: down).isEmpty)
        #expect(StatusChanges.notices(previous: up, current: down).map(\.title) == ["shop is down"])
        #expect(StatusChanges.notices(previous: down, current: up).map(\.title) == ["shop is back up"])
        // A stale cached result from the last launch is still a valid baseline.
        #expect(
            StatusChanges.notices(previous: up.markingObservationsStale(), current: down).count == 1
        )
    }

    private func evaluate(_ environments: [EnvironmentSnapshot]) -> ProjectStatus {
        ProjectStatus.evaluate(
            snapshot: snapshot(environments),
            refreshError: nil,
            isInitialized: true
        )
    }

    private func snapshot(_ environments: [EnvironmentSnapshot]) -> ProjectSnapshot {
        ProjectSnapshot(
            projectID: projectID,
            projectName: "shop",
            generatedAt: Date(timeIntervalSince1970: 1),
            environments: environments,
            recentRuns: []
        )
    }

    private func environment(
        _ name: String,
        health: EnvironmentHealth,
        endpointOK: Bool? = nil,
        httpStatus: Int? = nil,
        url: URL? = nil
    ) -> EnvironmentSnapshot {
        let address = url ?? URL(string: "https://\(name).example.com")!
        return EnvironmentSnapshot(
            name: name,
            specRevision: 1,
            resources: [
                ResourceSummary(id: "service:web", kind: .service, name: "web", desiredProvider: "gcp"),
            ],
            observation: observation(health, services: endpointOK == nil ? nil : [
                ServiceObservation(name: "web", status: .running, url: address, customDomains: []),
            ], driftCount: health == .drifted ? 2 : 0),
            publicEndpointHealth: endpointOK.map {
                [PublicEndpointHealth(
                    service: "web",
                    url: address,
                    ok: $0,
                    status: httpStatus,
                    latencyMs: 80,
                    checkedAt: Date(timeIntervalSince1970: 1)
                )]
            }
        )
    }

    private func observation(
        _ health: EnvironmentHealth,
        services: [ServiceObservation]? = nil,
        blockedProviders: [String] = [],
        driftCount: Int = 0
    ) -> ObservationSummary {
        ObservationSummary(
            health: health,
            verified: health != .unverified,
            driftCount: driftCount,
            unmanagedCount: 0,
            blockedProviders: blockedProviders,
            latestAttemptAt: Date(timeIntervalSince1970: 1),
            latestSuccessfulAt: Date(timeIntervalSince1970: 1),
            services: services,
            driftedResources: nil
        )
    }
}
