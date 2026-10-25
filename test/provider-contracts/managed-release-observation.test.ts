import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import '../../src/application/providers.js';
import '../../src/application/devops-providers.js';
import { SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../src/adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../src/adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../src/adapters/db/repositories/connection.repository.js';
import { SecretStore, getSecretStore } from '../../src/adapters/secrets/secret-store.js';
import { GitHubAdapter } from '../../src/adapters/providers/github/github.adapter.js';
import * as deploymentAccess from '../../src/adapters/cloud/deployment-access.client.js';
import { SpecStore } from '../../src/domain/spec/spec.store.js';
import { canonicalJsonSha256 } from '../../src/lib/canonical-json.js';
import { azurePreparedCoordinates } from '../../src/adapters/providers/azure/azure-prepared-hosting.js';
import { azurePreparedApplicationConfiguration, azurePreparedApplicationDigest } from '../../src/adapters/providers/azure/azure-prepared-release.js';
import { azurePreparedFixture } from './helpers/azure-prepared-fixture.js';
import { resolveManagedWorkflowContract, workflowFiles } from '../../src/domain/services/ci-deploy.service.js';
import { releaseEvidenceValidationRuntime } from '../../src/domain/services/github-ops.service.js';
import { observeManagedReleaseEvidence } from '../../src/domain/services/managed-release-observation.js';
import { MANAGED_CI_RELEASE_EVIDENCE_FILE, managedCiReleaseArtifactName } from '../../src/domain/services/managed-ci-evidence.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'hv-release-provenance-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory); vi.stubEnv('HYPERVIBE_DISABLE_REPO_SPEC', 'true');
  SecretStore.resetInstance(); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); SecretStore.resetInstance(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });

describe('actual managed first-release provenance recovery', () => {
  it('uses the reviewed prior preparation when SQLite completion precedes repository export', async () => {
    const installed = await azurePreparedFixture(), connection = installed.driver.deployment!.connection(installed.installed), prepared = connection.preparedResources!;
    const c = azurePreparedCoordinates(connection), runtime = connection.runtimeIdentities[0].principal;
    if (runtime.kind !== 'azure-managed-identity') throw new Error('Invalid fixture');
    const project = new ProjectRepository().create({ name: 'sequence', defaultPlatform: 'azure-container-apps', gitRemoteUrl: 'https://github.com/studio/sequence' });
    const { spec } = new SpecStore().replace(project, { version: 1, project: project.name, gitRemoteUrl: project.gitRemoteUrl, runtime: { kind: 'node', version: '24' },
      environments: { staging: { hosting: { provider: 'azure-container-apps', region: 'eastus' }, services: { web: { workloadKind: 'web', startCommand: 'node server.js', healthCheckPath: '/health' } },
        deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' }, envVars: { NODE_ENV: 'production' }, email: { enabled: false }, envFile: { mode: 'off' },
        backups: { mode: 'disabled', reason: 'Read-only synthetic release proof.' } } } });
    vi.spyOn(deploymentAccess, 'selectedDeploymentAccess').mockReturnValue({ receipt: connection, binding: { baseUrl: 'https://hypercloud.example', projectId: connection.appId,
      connectionId: connection.installationId, source: connection.source } } as any);
    const preparation = { schemaVersion: 1, installationId: connection.installationId, planDigest: connection.planDigest, receiptDigest: canonicalJsonSha256(connection),
      pendingFirstRelease: ['web'], firstReleaseConfigurationDigests: { web: azurePreparedApplicationDigest(azurePreparedApplicationConfiguration({
        identityId: runtime.identityResourceId, environmentId: prepared.project.id, registryServer: c.registryServer,
        envVars: spec.environments.staging.envVars, secretVersionRefs: {}, startCommand: 'node server.js', healthCheckPath: '/health' })) } };
    const environments = new EnvironmentRepository(), environment = environments.create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'azure-container-apps', projectId: c.group, environmentId: prepared.project.id,
      providerScope: { registryResourceId: prepared.registry.id, registryCreatedAt: prepared.registry.lifetimeId, registryServer: c.registryServer, managedEnvironmentCreatedAt: prepared.project.lifetimeId },
      services: { web: { serviceId: prepared.workloads[0].id, resourceUid: prepared.workloads[0].lifetimeId, resourceType: 'service', workloadKind: 'web', imageUri: prepared.workloads[0].holding.image } }, preparedHosting: preparation,
    } });
    const connections = new ConnectionRepository(); connections.updateStatus(connections.create({ provider: 'github', scope: 'studio/sequence',
      credentialsEncrypted: getSecretStore().encryptObject({ apiToken: 'synthetic-github-token' }) }).id, 'verified');
    const contract = resolveManagedWorkflowContract({ project, environmentName: 'staging', environmentSpec: spec.environments.staging, environment });
    if (!contract.ok) throw new Error(contract.error);
    const files = workflowFiles(contract.workflow), sha = 'a'.repeat(40), imageUri = `${c.registryServer}/sequence@sha256:${'e'.repeat(64)}`;
    const run = { id: 101, name: 'Deploy Azure staging', created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z',
      path: contract.workflow.path, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, head_branch: 'main', event: 'workflow_dispatch',
      html_url: 'https://github.com/studio/sequence/actions/runs/101', repository: { full_name: 'studio/sequence' }, head_repository: { full_name: 'studio/sequence' } };
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockImplementation(async (_owner, _repo, file) => files.find(item => item.path === file)?.content ?? null);
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getRef').mockResolvedValue({ ref: 'refs/heads/main', object: { sha } });
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRuns').mockResolvedValue({ total_count: 1, workflow_runs: [run] });
    vi.spyOn(GitHubAdapter.prototype, 'getWorkflowRun').mockResolvedValue(run);
    vi.spyOn(GitHubAdapter.prototype, 'listWorkflowRunArtifacts').mockResolvedValue({ total_count: 1, artifacts: [{ id: 201,
      name: managedCiReleaseArtifactName('staging', sha), expired: false, created_at: run.created_at, updated_at: run.updated_at,
      workflow_run: { id: run.id, head_sha: sha, head_branch: 'main', repository_id: 123, head_repository_id: 123 } }] });
    const producer = parse(contract.workflow.content).jobs.deploy.steps.find((step: any) => step.name === 'Write server release evidence');
    let evidence = ''; const realRequire = createRequire(import.meta.url);
    new Function('require', 'process', producer.with.script)((name: string) => name === 'fs' ? {
      readFileSync: () => `${releaseEvidenceValidationRuntime().trim()}\n`, writeFileSync: (_path: string, value: string) => { evidence = value; },
    } : realRequire(name), { env: { ...producer.env, GITHUB_REPOSITORY: 'studio/sequence', HYPERVIBE_RELEASE_SHA: sha,
      HYPERVIBE_RELEASE_IMAGE_URI: imageUri, HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: contract.target.deploymentContractFingerprint } });
    vi.spyOn(GitHubAdapter.prototype, 'readArtifactFiles').mockResolvedValue({ [MANAGED_CI_RELEASE_EVIDENCE_FILE]: evidence });
    const reviewed = await observeManagedReleaseEvidence({ project, spec, environment });
    expect(GitHubAdapter.prototype.readArtifactFiles).toHaveBeenCalledOnce();
    expect(reviewed).toBeDefined();
    // The exact metadata action committed, then exporting bindings failed. No DB
    // rollback or provider mutation may be used to reconstruct the producer hash.
    environments.updatePlatformBindings(environment.id, { preparedHosting: { ...preparation, pendingFirstRelease: [], firstReleaseConfigurationDigests: {} },
      services: { web: { ...(environment.platformBindings.services as Record<string, object>).web, imageUri } } });
    const complete = environments.findById(environment.id)!;
    expect((complete.platformBindings.preparedHosting as any).pendingFirstRelease).toEqual([]);
    const recovery = { ...complete, platformBindings: { ...complete.platformBindings, preparedHosting: preparation } };
    expect(await observeManagedReleaseEvidence({ project, spec, environment: recovery, reviewed })).toEqual(reviewed);
    for (const wrong of [{ ...recovery, projectId: 'other-project' }, { ...recovery, name: 'production' }])
      expect(await observeManagedReleaseEvidence({ project, spec, environment: wrong, reviewed })).toBeUndefined();
    expect(environments.findById(environment.id)!.platformBindings).toEqual(complete.platformBindings);
  });
});
