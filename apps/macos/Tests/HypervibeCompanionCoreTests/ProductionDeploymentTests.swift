import Foundation
import MCP
import Testing
@testable import HypervibeCompanionCore

@Suite
struct ProductionDeploymentTests {
    @Test
    func productionTargetUsesPromotionIntentAsWellAsConventionalName() {
        let promoted = EnvironmentSnapshot(
            name: "live",
            specRevision: 1,
            resources: [],
            deployment: DeploymentConfiguration(
                strategy: "branch",
                promoteFrom: "staging"
            ),
            observation: nil
        )
        let ordinary = EnvironmentSnapshot(
            name: "preview",
            specRevision: 1,
            resources: [],
            observation: nil
        )

        #expect(promoted.isProductionTarget)
        #expect(!ordinary.isProductionTarget)
    }

    @Test
    func reviewedDefinitionSelectionDoesNotGuessAcrossAmbiguousMatches() {
        let definitions = [
            CIDefinitionSummary(
                id: "prod-a",
                name: "Deploy production A",
                path: "deploy-production-a.yml",
                state: "active"
            ),
            CIDefinitionSummary(
                id: "prod-b",
                name: "Deploy production B",
                path: "deploy-production-b.yml",
                state: "active"
            ),
        ]
        let preparation = ProductionDeploymentPreparation(
            mechanism: .managedCI,
            environment: "production",
            specRevision: 1,
            branch: "main",
            definitions: definitions
        )

        #expect(preparation.suggestedDefinitionID() == nil)
    }

    @Test
    func reviewedDefinitionSelectionPrefersTheExactEnvironmentCandidate() {
        let preparation = ProductionDeploymentPreparation(
            mechanism: .managedCI,
            environment: "production",
            specRevision: 1,
            branch: "main",
            definitions: [
                CIDefinitionSummary(
                    id: "staging",
                    name: "Deploy staging",
                    path: "deploy-staging.yml",
                    state: "active"
                ),
                CIDefinitionSummary(
                    id: "production",
                    name: "Deploy production",
                    path: "deploy-production.yml",
                    state: "active"
                ),
            ]
        )

        #expect(preparation.suggestedDefinitionID() == "production")
    }

    @Test
    func reviewedDefinitionSelectionRejectsUnrelatedOrInactiveDefinitions() {
        let preparation = ProductionDeploymentPreparation(
            mechanism: .managedCI,
            environment: "production",
            specRevision: 1,
            branch: "main",
            definitions: [
                CIDefinitionSummary(
                    id: "staging",
                    name: "Deploy staging",
                    path: "deploy-staging.yml",
                    state: "active"
                ),
                CIDefinitionSummary(
                    id: "production-old",
                    name: "Deploy production old",
                    path: "deploy-production-old.yml",
                    state: "disabled_manually"
                ),
            ]
        )

        #expect(preparation.eligibleDefinitions.isEmpty)
        #expect(preparation.suggestedDefinitionID() == nil)
    }

    @Test
    func ciDefinitionCatalogNormalizesCanonicalAndLegacyIdentifiers() throws {
        let canonical = Data(
            """
            {
              "ok": true,
              "data": {
                "ciProvider": "gitlab-ci",
                "definitions": [{
                  "id": ".gitlab-ci.yml",
                  "name": "GitLab pipeline",
                  "path": ".gitlab-ci.yml",
                  "state": "active"
                }]
              }
            }
            """.utf8
        )
        let legacy = Data(
            """
            {
              "ok": true,
              "data": {
                "repository": "owner/example",
                "definitions": [{
                  "id": 42,
                  "name": "Deploy production",
                  "path": ".github/workflows/deploy-production.yml",
                  "state": "active"
                }]
              }
            }
            """.utf8
        )

        let canonicalCatalog = try HypervibeResponseMapper.decodeCIDefinitionCatalog(
            canonical
        )
        let legacyCatalog = try HypervibeResponseMapper.decodeCIDefinitionCatalog(legacy)

        #expect(canonicalCatalog.usesCanonicalBindings)
        #expect(canonicalCatalog.definitions.first?.id == ".gitlab-ci.yml")
        #expect(!legacyCatalog.usesCanonicalBindings)
        #expect(legacyCatalog.definitions.first?.id == "42")
    }

    @Test
    func deploymentReceiptsKeepOnlySafeRunAndPlanIdentity() throws {
        let direct = Data(
            """
            {
              "ok": true,
              "data": {
                "status": "succeeded",
                "message": "Deployment completed for 2 services",
                "planId": "plan-1",
                "applyRunId": "apply-1",
                "runId": "deploy-1",
                "primaryUrl": "https://example.com"
              }
            }
            """.utf8
        )
        let ci = Data(
            """
            {
              "ok": true,
              "data": {
                "ciProvider": "github-actions",
                "run": {
                  "id": 99,
                  "phase": "queued",
                  "webUrl": "https://example.com/runs/99"
                }
              }
            }
            """.utf8
        )

        let directResult = try HypervibeResponseMapper.decodeDirectDeployment(direct)
        let ciResult = try HypervibeResponseMapper.decodeCIDeployment(ci)

        #expect(directResult.status == "succeeded")
        #expect(directResult.planID == "plan-1")
        #expect(directResult.applyRunID == "apply-1")
        #expect(directResult.webURL?.host() == "example.com")
        #expect(ciResult.status == "queued")
        #expect(ciResult.runID == "99")
        #expect(ciResult.webURL?.path == "/runs/99")
    }

    @Test
    func directDeploymentArgumentsAlwaysConfirmTheProtectedEnvironment() {
        let arguments = HypervibeMCPClient.directDeploymentArguments(
            projectName: "example",
            environment: "production"
        )

        #expect(arguments["project"]?.stringValue == "example")
        #expect(arguments["env"]?.stringValue == "production")
        #expect(arguments["confirm"]?.boolValue == true)
    }

    @Test
    func canonicalSharedCIDefinitionCarriesExactShaAndEnvironment() throws {
        let sha = String(repeating: "a", count: 40)
        let definition = CIDefinitionSummary(
            id: ".gitlab-ci.yml",
            name: "GitLab pipeline",
            path: ".gitlab-ci.yml",
            state: "active"
        )
        let preparation = ProductionDeploymentPreparation(
            mechanism: .managedCI,
            environment: "production",
            specRevision: 1,
            branch: "main",
            definitions: [definition],
            requiresExactRefSHA: true
        )

        let arguments = HypervibeMCPClient.ciDeploymentArguments(
            projectName: "example",
            environment: "production",
            preparation: preparation,
            definition: definition,
            commitSHA: sha
        )
        let inputs = try #require(arguments["inputs"]?.objectValue)

        #expect(arguments["definition"]?.stringValue == ".gitlab-ci.yml")
        #expect(arguments["ref"]?.stringValue == "main")
        #expect(arguments["sha"]?.stringValue == sha)
        #expect(inputs["commit_sha"]?.stringValue == sha)
        #expect(inputs["environment"]?.stringValue == "production")
    }

    @Test
    func environmentScopedLegacyDefinitionDoesNotInventExtraAuthority() throws {
        let sha = String(repeating: "b", count: 40)
        let definition = CIDefinitionSummary(
            id: "deploy-production.yml",
            name: "Deploy production",
            path: ".github/workflows/deploy-production.yml",
            state: "active"
        )
        let preparation = ProductionDeploymentPreparation(
            mechanism: .managedCI,
            environment: "production",
            specRevision: 1,
            branch: "main",
            definitions: [definition],
            requiresExactRefSHA: false
        )

        let arguments = HypervibeMCPClient.ciDeploymentArguments(
            projectName: "example",
            environment: "production",
            preparation: preparation,
            definition: definition,
            commitSHA: sha
        )
        let inputs = try #require(arguments["inputs"]?.objectValue)

        #expect(arguments["sha"] == nil)
        #expect(inputs["commit_sha"]?.stringValue == sha)
        #expect(inputs["environment"] == nil)
    }
}
