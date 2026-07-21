import Foundation
import Testing
@testable import HypervibeCompanionCore

@Suite
struct HypervibeResponseMapperTests {
    @Test
    func topologyMapsOnlyResourceIdentityProviderAndRelationships() throws {
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "project": { "id": "project-1", "name": "invoice-perfect" },
                "revision": 14,
                "spec": {
                  "project": "invoice-perfect",
                  "envVars": { "DO_NOT_CACHE": "sentinel-secret-value" },
                  "environments": {
                    "staging": {
                      "hosting": { "provider": "railway" },
                      "services": {
                        "api": { "startCommand": "npm start" },
                        "worker": { "startCommand": "npm run worker" }
                      },
                      "database": { "provider": "supabase" },
                      "storage": {
                        "documents": {
                          "provider": "railway",
                          "injectInto": ["api"]
                        }
                      },
                      "queues": { "mail": { "ackDeadlineSeconds": 30 } },
                      "domain": "example.com",
                      "domainRegistration": { "provider": "cloudflare" },
                      "deploy": { "strategy": "branch" },
                      "ios": { "bundleId": "com.example.invoice" }
                    }
                  }
                }
              }
            }
            """.utf8
        )

        let topology = try HypervibeResponseMapper.decodeTopology(data)
        let environment = try #require(topology.environments.first)

        #expect(topology.projectName == "invoice-perfect")
        #expect(topology.specRevision == 14)
        #expect(environment.name == "staging")
        #expect(environment.resources.map(\.id) == [
            "service:api",
            "service:worker",
            "database:primary",
            "storage:documents",
            "queue:mail",
            "domain:example.com",
            "ci:deploy",
            "ios:com.example.invoice",
        ])
        #expect(
            environment.resources.first { $0.id == "database:primary" }?
                .desiredProvider == "supabase"
        )
        #expect(
            environment.resources.first { $0.id == "domain:example.com" }?
                .desiredProvider == "cloudflare"
        )
        #expect(
            environment.resources.first { $0.id == "service:api" }?
                .relationships == [
                    ResourceRelationship(
                        kind: .uses,
                        targetResourceID: "database:primary"
                    ),
                ]
        )

        let encoded = try JSONEncoder().encode(environment)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("sentinel-secret-value"))
    }

    @Test
    func observationCountsDriftWithoutRetainingActionPayloads() throws {
        let attemptedAt = Date(timeIntervalSince1970: 500)
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "environment": "staging",
                "verified": true,
                "inSync": false,
                "drift": [{
                  "id": "service:api",
                  "metadata": { "token": "sentinel-secret-value" }
                }],
                "unmanaged": [{ "name": "old-worker" }],
                "blocked": [],
                "inputRequired": []
              },
              "warnings": ["sentinel-secret-value"]
            }
            """.utf8
        )

        let observation = try HypervibeResponseMapper.decodeObservation(
            data,
            attemptedAt: attemptedAt,
            previous: nil
        )

        #expect(observation.health == .drifted)
        #expect(observation.verified)
        #expect(observation.driftCount == 1)
        #expect(observation.unmanagedCount == 1)
        #expect(observation.latestSuccessfulAt == attemptedAt)
        let encoded = try JSONEncoder().encode(observation)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("sentinel-secret-value"))
    }

    @Test
    func failedAttemptPreservesLastSuccessfulObservationTime() {
        let successfulAt = Date(timeIntervalSince1970: 100)
        let previous = ObservationSummary(
            health: .inSync,
            verified: true,
            driftCount: 0,
            unmanagedCount: 0,
            blockedProviders: [],
            latestAttemptAt: successfulAt,
            latestSuccessfulAt: successfulAt
        )
        let failedAt = Date(timeIntervalSince1970: 200)

        let failed = HypervibeResponseMapper.failedObservation(
            attemptedAt: failedAt,
            previous: previous
        )

        #expect(failed.health == .failed)
        #expect(failed.latestAttemptAt == failedAt)
        #expect(failed.latestSuccessfulAt == successfulAt)
    }

    @Test
    func runListDropsErrorsAndArbitraryRunDetails() throws {
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "count": 1,
                "runs": [{
                  "id": "run-1",
                  "type": "apply",
                  "status": "failed",
                  "project": "invoice-perfect",
                  "environment": "staging",
                  "startedAt": "2026-07-20T10:00:00.123Z",
                  "completedAt": "2026-07-20T10:01:00.000Z",
                  "error": "sentinel-secret-value",
                  "receipts": [{ "raw": "sentinel-secret-value" }]
                }]
              }
            }
            """.utf8
        )

        let runs = try HypervibeResponseMapper.decodeRuns(data)
        let run = try #require(runs.first)

        #expect(run.id == "run-1")
        #expect(run.status == .failed)
        #expect(run.startedAt != nil)
        let encoded = try JSONEncoder().encode(run)
        #expect(!String(decoding: encoded, as: UTF8.self).contains("sentinel-secret-value"))
    }

    @Test
    func connectionListKeepsOnlySafeInMemorySummaries() throws {
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "connections": [
                  {
                    "provider": "cloudflare",
                    "scope": "example.com",
                    "status": "verified",
                    "lastVerifiedAt": "2026-07-20T10:00:00.123Z",
                    "credentialsEncrypted": "sentinel-secret-value"
                  },
                  {
                    "provider": "github",
                    "scope": "global",
                    "status": "failed",
                    "lastVerifiedAt": null
                  }
                ],
                "availableProviders": {
                  "hosting": [{
                    "name": "railway",
                    "credentialExample": "sentinel-secret-value"
                  }]
                }
              }
            }
            """.utf8
        )

        let connections = try HypervibeResponseMapper.decodeConnections(data)

        #expect(connections.map(\.provider) == ["cloudflare", "github"])
        #expect(connections.first?.status == .verified)
        #expect(connections.first?.lastVerifiedAt != nil)
        #expect(connections.last?.status == .failed)
    }

    @Test
    func connectionCatalogMapsStructuredGuidanceAndSupportsOlderServers() throws {
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "connections": [],
                "availableProviders": {
                  "deployment": [{
                    "name": "railway",
                    "displayName": "Railway",
                    "setupHelpUrl": "https://railway.com/account/tokens",
                    "setupHelpUrls": [{
                      "label": "Token setup",
                      "url": "https://railway.com/account/tokens"
                    }],
                    "tokenType": "Railway Account API token",
                    "requiredPermissions": ["Create services"],
                    "notes": ["Use an account token"],
                    "defaultScalarKey": "apiToken",
                    "credentialFields": [{
                      "name": "apiToken",
                      "label": "API Token",
                      "required": true,
                      "sensitive": true,
                      "inputKind": "secret"
                    }, {
                      "name": "workspaceId",
                      "label": "Workspace ID",
                      "required": false,
                      "sensitive": false,
                      "inputKind": "text"
                    }]
                  }],
                  "legacy": [{ "name": "old-provider" }]
                }
              }
            }
            """.utf8
        )

        let catalog = try HypervibeResponseMapper.decodeConnectionCatalog(data)
        let railway = try #require(catalog.providers.first { $0.name == "railway" })
        let legacy = try #require(catalog.providers.first { $0.name == "old-provider" })

        #expect(railway.category == "deployment")
        #expect(railway.setupLinks.count == 1)
        #expect(railway.defaultScalarKey == "apiToken")
        #expect(railway.credentialFields?.map(\.name) == ["apiToken", "workspaceId"])
        #expect(railway.credentialFields?.first?.inputKind == .secret)
        #expect(legacy.displayName == "old-provider")
        #expect(legacy.credentialFields == nil)
    }

    @Test
    func connectionMutationKeepsSafeIdentityAndWarnings() throws {
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "provider": "github",
                "scope": "global",
                "status": "verified",
                "message": "github connection verified",
                "login": "davejohnson",
                "credentialsSource": "env",
                "credentialsEncrypted": "sentinel-secret-value"
              },
              "warnings": ["Token lacks an optional permission"]
            }
            """.utf8
        )

        let result = try HypervibeResponseMapper.decodeConnectionMutation(data)
        #expect(result.status == .verified)
        #expect(result.identity == "davejohnson")
        #expect(result.warnings == ["Token lacks an optional permission"])
        #expect(!String(describing: result).contains("sentinel-secret-value"))
    }

    @Test
    func toolFailurePreservesActionableHint() {
        let data = Data(
            """
            {
              "ok": false,
              "error": {
                "code": "PROVIDER_ERROR",
                "message": "invalid token"
              },
              "hint": "The connection was saved but failed verification. Replace it or verify again."
            }
            """.utf8
        )

        #expect(throws: HypervibeClientError.tool(
            code: "PROVIDER_ERROR",
            message: "invalid token",
            hint: "The connection was saved but failed verification. Replace it or verify again."
        )) {
            try HypervibeResponseMapper.decodeConnectionMutation(data)
        }
    }

    @Test
    func connectionRequestBuildsDirectAndReferenceToolArguments() {
        let direct = ConnectionRequest(
            provider: "railway",
            source: .direct(["apiToken": "token", "workspaceId": "workspace"]),
            scope: " team "
        ).toolArguments()
        #expect(direct["action"]?.stringValue == "add")
        #expect(direct["scope"]?.stringValue == "team")
        #expect(direct["credentials"]?.objectValue?["apiToken"]?.stringValue == "token")

        let reference = ConnectionRequest(
            provider: "cloudrun",
            source: .reference(value: "file:/tmp/gcp.json", credentialKey: " credentials ")
        ).toolArguments()
        #expect(reference["credentialsRef"]?.stringValue == "file:/tmp/gcp.json")
        #expect(reference["credentialsKey"]?.stringValue == "credentials")
        #expect(reference["credentials"] == nil)
    }

    @Test
    func upgradeStatusBlocksPendingMigrations() {
        let data = Data(
            """
            {
              "ok": true,
              "data": {
                "sqlite": { "needsMigration": true }
              }
            }
            """.utf8
        )

        #expect(throws: HypervibeClientError.schemaMigrationRequired) {
            try HypervibeResponseMapper.decodeUpgradeStatus(data)
        }
    }
}
