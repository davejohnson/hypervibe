import Foundation
import Testing
@testable import HypervibeCompanionCore

struct CurrentCoreStatusContractTests {
    private func fixture(_ name: String) throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "current-core-status", withExtension: "json"))
        let captured = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: #require(captured[name]))
    }

    @Test(arguments: ["gcp", "gcpNoWorkers", "aws", "azure"])
    func engineStatusFromCurrentCoreDoesNotInventDrift(_ name: String) throws {
        let observation = try HypervibeResponseMapper.decodeObservation(
            fixture(name), attemptedAt: Date(timeIntervalSince1970: 500), previous: nil
        )
        #expect(observation.health == .unverified)
        #expect(!observation.verified)
        #expect(observation.latestSuccessfulAt == nil)
        #expect(observation.engine == "opentofu")
        #expect(observation.infrastructureStatus?.contains("Drift not observed here") == true)
        #expect(observation.infrastructureStatus?.contains("hv_plan scope=\"infrastructure\"") == true)
        if name == "aws" || name == "azure" { #expect(observation.workers == []) }
        if name == "gcpNoWorkers" { #expect(observation.workers == []) }
    }

    @Test
    func decodesObservedWorkerActivityAndOlderServers() throws {
        let object = try #require(JSONSerialization.jsonObject(with: fixture("aws")) as? [String: Any])
        var payload = try #require(object["data"] as? [String: Any])
        for (state, expected) in [("idle", "Idle · scaled to zero"), ("unknown", "Current activity unknown")] {
            payload["workers"] = [["service": "queue", "mode": "on-demand", "activity": state]]
            let response = object.merging(["data": payload]) { _, latest in latest }
            let result = try HypervibeResponseMapper.decodeObservation(JSONSerialization.data(withJSONObject: response), attemptedAt: Date(), previous: nil)
            #expect(result.workers?.first?.activitySummary == expected)
        }
        payload["workers"] = "not read"
        let previous = object.merging(["data": payload]) { _, latest in latest }
        let legacy = try HypervibeResponseMapper.decodeObservation(JSONSerialization.data(withJSONObject: previous), attemptedAt: Date(), previous: nil)
        #expect(legacy.workers == nil)
    }

    @Test
    func lifecycleAndPlannedProviderResponsesKeepTheirOwnContracts() throws {
        let observation = try HypervibeResponseMapper.decodeObservation(
            fixture("railway"), attemptedAt: Date(timeIntervalSince1970: 500), previous: nil
        )
        #expect(observation.verified)
        #expect(observation.engine == nil)
        #expect(throws: HypervibeClientError.self) {
            try HypervibeResponseMapper.decodeObservation(
                fixture("plannedProvider"), attemptedAt: Date(timeIntervalSince1970: 500), previous: nil
            )
        }
    }

    @Test
    func workersKeepZeroAndUnknownDistinctWithoutClaimingApplicationHealth() throws {
        let observation = try HypervibeResponseMapper.decodeObservation(
            fixture("gcp"), attemptedAt: Date(timeIntervalSince1970: 500), previous: nil
        )
        let workers = try #require(observation.workers)
        #expect(workers.count == 4)
        let sleeping = try #require(workers.first { $0.service == "queue-worker" })
        #expect(sleeping.instances == 0)
        #expect(sleeping.pendingWork == 0)
        #expect(sleeping.lastWakeAt != nil)
        #expect(sleeping.configurationSummary == "On demand · 0 configured instances")
        #expect(sleeping.activitySummary == "0 pending tasks")
        #expect(!sleeping.needsAttention)
        #expect(workers.first { $0.service == "always-worker" }?.configurationSummary == "Always on · 2 configured instances")
        #expect(workers.first { $0.service == "unobserved-worker" }?.instances == nil)
        #expect(workers.first { $0.service == "unobserved-worker" }?.configurationSummary.contains("not observed") == true)
        #expect(workers.first { $0.service == "blocked-worker" }?.activitySummary == "Wake-up check cannot read pending work")
        #expect(observation.services == nil)
        let environment = EnvironmentSnapshot(name: "testing", specRevision: 1, resources: [], observation: observation)
        let status = EnvironmentStatus.evaluate(environment, projectName: "example")
        #expect(status.level == .attention)
        #expect(status.label == "Worker needs attention")
        #expect(status.issues.count == 1)
    }

    @Test
    func unobservedWorkersAndFailedRefreshDoNotBecomeHealthyOrLoseEngineContext() throws {
        let observation = try HypervibeResponseMapper.decodeObservation(
            fixture("aws"), attemptedAt: Date(timeIntervalSince1970: 500), previous: nil
        )
        let environment = EnvironmentSnapshot(name: "testing", specRevision: 1, resources: [], observation: observation)
        let status = EnvironmentStatus.evaluate(environment, projectName: "example")
        #expect(status.level == .unknown)
        #expect(status.label == "Drift not checked")
        let failed = HypervibeResponseMapper.failedObservation(attemptedAt: Date(timeIntervalSince1970: 900), previous: observation)
        #expect(failed.health == .failed)
        #expect(failed.engine == "opentofu")
        #expect(failed.workers == nil)
        #expect(failed.latestSuccessfulAt == nil)
        #expect(try JSONDecoder().decode(ObservationSummary.self, from: JSONEncoder().encode(failed)) == failed)
    }

    @Test
    func malformedLifecycleEvidenceStillFailsInsteadOfDefaultingToSuccess() throws {
        var envelope = try #require(JSONSerialization.jsonObject(with: fixture("railway")) as? [String: Any])
        var data = try #require(envelope["data"] as? [String: Any])
        data.removeValue(forKey: "verified"); envelope["data"] = data
        let malformed = try JSONSerialization.data(withJSONObject: envelope)
        #expect(throws: DecodingError.self) {
            try HypervibeResponseMapper.decodeObservation(malformed, attemptedAt: Date(), previous: nil)
        }
    }
}
