import Foundation
import Testing
@testable import HypervibeCompanionCore

// Shapes follow what hv_status returns today (src/tools/core.tools.ts); the JSON
// here is written by hand, not captured.
struct DashboardStatusEvidenceTests {
    private func status(_ observation: ObservationSummary) -> EnvironmentStatus {
        EnvironmentStatus.evaluate(
            EnvironmentSnapshot(name: "production", specRevision: 1, resources: [], observation: observation),
            projectName: "example"
        )
    }

    private func decode(_ json: String) throws -> ObservationSummary {
        try HypervibeResponseMapper.decodeObservation(Data(json.utf8), attemptedAt: Date(timeIntervalSince1970: 500), previous: nil)
    }

    @Test
    func partialBackupEvidenceIsShownAndNeverHealthy() throws {
        // A partial answer has no inSync at all.
        let observation = try decode(#"""
        {"ok":true,"data":{"environment":"production","partial":true,"verified":false,
          "retainedDatabases":[{"componentId":"c1","provider":"cloudsql","externalId":"db-1","observation":"present","status":"RUNNABLE"},
                               {"componentId":"c2","provider":"cloudsql","externalId":"db-2","observation":"unknown","reason":"The provider could not verify the exact bound database."}],
          "backupReadiness":{"ready":false,"policyReady":true,"recoveryPointReady":false,"restoreReady":false,"resources":[],"gaps":["No recovery point in the last day."]}},
         "warnings":["Full infrastructure drift is unavailable. Only the listed operations were observed."]}
        """#)
        #expect(observation.health == .unverified)
        #expect(!observation.verified)
        #expect(observation.latestSuccessfulAt == nil)
        let facts = try #require(observation.partialEvidence)
        #expect(facts.contains("Database db-1 (cloudsql): present, RUNNABLE"))
        #expect(facts.contains("Database db-2 (cloudsql): not verified"))
        #expect(facts.contains("Backups: not ready. No recovery point in the last day."))
        #expect(status(observation).level != .good)
    }

    @Test
    func partialEngineAnswerKeepsItsDatabaseFacts() throws {
        let observation = try decode(#"""
        {"ok":true,"data":{"environment":"production","engine":"opentofu","workers":"not read","partial":true,
          "retainedDatabases":[{"componentId":"c1","provider":"cloudsql","externalId":"db-1","observation":"present","status":"RUNNABLE"}]}}
        """#)
        #expect(observation.health == .unverified)
        #expect(observation.workers == nil)
        #expect(observation.partialEvidence == ["Database db-1 (cloudsql): present, RUNNABLE"])
    }

    @Test
    func partialEvidenceWithReadyBackupsStillIsNotHealthy() throws {
        let observation = try decode(#"""
        {"ok":true,"data":{"environment":"production","partial":true,"verified":false,
          "backupReadiness":{"ready":true,"policyReady":true,"recoveryPointReady":true,"restoreReady":true,"resources":[],"gaps":[]}}}
        """#)
        #expect(observation.health == .unverified)
        #expect(observation.partialEvidence == ["Backups: ready"])
        #expect(status(observation).level != .good)
    }

    @Test
    func completeHealthyAnswerIsUnchanged() throws {
        let observation = try decode(#"""
        {"ok":true,"data":{"environment":"production","verified":true,"inSync":true,"drift":[],"observedAt":"2026-11-17T12:00:00.000Z"}}
        """#)
        #expect(observation.health == .inSync)
        #expect(observation.partialEvidence == nil)
        #expect(status(observation).level == .good)
        #expect(status(observation).issues.isEmpty)
    }

    @Test
    func aCompleteAnswerMissingInSyncIsStillMalformed() throws {
        #expect(throws: DecodingError.self) {
            _ = try decode(#"{"ok":true,"data":{"environment":"production","verified":true}}"#)
        }
    }

    private func engineObservation(_ worker: WorkerObservation) -> ObservationSummary {
        ObservationSummary(health: .unverified, verified: false, driftCount: 0, unmanagedCount: 0, blockedProviders: [],
                           latestAttemptAt: Date(timeIntervalSince1970: 500), latestSuccessfulAt: nil, engine: "opentofu", workers: [worker])
    }

    @Test
    func failedAlwaysOnWorkerReportsTheWorkloadNotAWakeUpCheck() throws {
        let worker = WorkerObservation(service: "mailer", mode: "always-on", instances: 1, wakerState: nil, lastWakeAt: nil,
                                       pendingWork: nil, pendingWorkReadFailed: false, activity: "failed", running: 0)
        let issue = try #require(status(engineObservation(worker)).issues.first)
        #expect(issue.title == "mailer has failed in production")
        #expect(!issue.title.localizedCaseInsensitiveContains("wake"))
        #expect(issue.chatPrompt?.localizedCaseInsensitiveContains("wake") == false)
        #expect(status(engineObservation(worker)).label == "Worker failed")
    }

    @Test
    func wakeUpGuidanceAppearsOnlyForAWakeUpFailure() throws {
        let worker = WorkerObservation(service: "queue", mode: "on-demand", instances: 0, wakerState: "FAILED", lastWakeAt: nil,
                                       pendingWork: nil, pendingWorkReadFailed: false)
        let issue = try #require(status(engineObservation(worker)).issues.first)
        #expect(issue.title == "queue's wake-up check needs attention in production")
        #expect(issue.chatPrompt?.localizedCaseInsensitiveContains("wake-up") == true)
        #expect(status(engineObservation(worker)).label == "Worker needs attention")
    }
}
