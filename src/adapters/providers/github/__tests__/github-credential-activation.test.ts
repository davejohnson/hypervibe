import { GitHubAdapter } from '../github.adapter.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { getSecretStore } from '../../../secrets/secret-store.js';
import * as githubOps from '../../../../domain/services/github-ops.service.js';
import * as workflows from '../../../../domain/services/ci-deploy.service.js';
import { projectSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { managedCiReleaseTarget } from '../../../../domain/services/managed-ci-targets.js';
import { environmentDeploymentContractHashForApply } from '../../../../domain/services/deployment-contract.service.js';
import { managedCiReleaseArtifactName, MANAGED_CI_RELEASE_EVIDENCE_FILE } from '../../../../domain/services/managed-ci-evidence.js';
import { prepareGitHubCredentialRollout, observeGitHubCredentialRollout } from '../github-credential-activation.js';
import '../../../providers/railway/railway.adapter.js';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hv-gh-activation-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(join(dir, 'state.db')).migrate(); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const project = new ProjectRepository().create({ name: 'credential-app', defaultPlatform: 'railway', gitRemoteUrl: 'https://github.com/acme/app.git' });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: { provider: 'railway', projectId: 'p', environmentId: 'e', services: { web: { serviceId: 's' } }, runtimeRollouts: [{ provider: 'railway', service: 'web', serviceExternalId: 's', providerProjectId: 'p', providerEnvironmentId: 'e', requiredAt: '2026-10-25T00:00:00Z', applyRunId: 'apply', actionIds: ['credential:key'], baselineDeployment: { state: 'present', id: 'old', activeDeploymentIds: ['old'] }, operationId: 'op', configurationExpectationEncrypted: getSecretStore().encryptObject({ API_KEY: 'a'.repeat(64) }), configurationAccepted: 'acknowledgement', configurationAcceptedKeys: ['API_KEY'] }] } });
  const spec = projectSpecSchema.parse({ version: 1, project: 'credential-app', environments: { production: { hosting: { provider: 'railway' }, services: { web: {} } } } });
  const target = managedCiReleaseTarget({ provider: 'railway', environmentName: 'production', scope: { providerProjectId: 'p', providerEnvironmentId: 'e' }, resources: [{ logicalName: 'web', providerResourceId: 's', providerResourceType: 'service', workloadKind: 'web' }] });
  const workflow = '.github/workflows/deploy-railway-production.yml'; const files = [{ path: workflow, content: 'reviewed producer credential_operations:' }]; const contentHash = workflows.workflowFilesContentHash(files);
  const contract: any = { ok: true, workflow: { path: workflow, branch: 'main' }, inputHash: 'input', target: { releaseTarget: target, programFingerprint: 'b'.repeat(64) }, environment };
  const run = { id: 20, path: workflow, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40), head_branch: 'main', event: 'workflow_dispatch', run_started_at: '2026-10-25T00:01:00Z', repository: { full_name: 'acme/app' }, head_repository: { full_name: 'acme/app' } };
  const evidence: any = { version: 4, provider: 'railway', environment: 'production', programFingerprint: 'b'.repeat(64), deploymentContractFingerprint: environmentDeploymentContractHashForApply(spec, 'production'), source: { repository: 'acme/app', sha: 'a'.repeat(40) }, target: { ...target, resources: target.resources.map(resource => ({ ...resource, imageUri: null })) }, verifiedAt: '2026-10-25T00:02:00Z', credentialActivation: { version: 1, operations: [{ service: 'web', serviceId: 's', operationId: 'op', deploymentIds: ['new'] }] } };
  const adapter = { getWorkflow: vi.fn(async () => ({ id: 9, path: workflow, state: 'active' })), listWorkflows: vi.fn(async () => ({ total_count: 1, workflows: [{ id: 9, path: workflow, state: 'active' }] })), getWorkflowRun: vi.fn(async () => run), getRef: vi.fn(async () => ({ ref: 'refs/heads/main', object: { sha: run.head_sha } })), compareCommits: vi.fn(async () => ({ status: 'identical', behind_by: 0 })), listWorkflowRunArtifacts: vi.fn(async () => ({ total_count: 1, artifacts: [{ id: 30, name: managedCiReleaseArtifactName('production', evidence.source.sha), expired: false, workflow_run: { id: 20, head_sha: run.head_sha, repository_id: 40, head_repository_id: 40 } }] })), readArtifactFiles: vi.fn(async () => ({ [MANAGED_CI_RELEASE_EVIDENCE_FILE]: JSON.stringify(evidence) })), getFileContent: vi.fn(async () => files[0].content) };
  vi.spyOn(githubOps, 'getGitHubAdapter').mockReturnValue({ adapter } as any);
  vi.spyOn(workflows, 'resolveManagedWorkflowContract').mockReturnValue(contract);
  vi.spyOn(workflows, 'observeManagedWorkflowFiles').mockResolvedValue({ acceptance: 'rendered', desiredFiles: files, liveContentHash: contentHash, retiredPaths: [], retiredFilePresent: false });
  return { project, environment, spec, adapter, run, evidence, workflow };
}
it('prepares reviewed non-secret operation inputs and accepts exact proven deployments despite source SHA differing from producer SHA', async () => {
  const f = fixture(); const inputs = await prepareGitHubCredentialRollout({ project: f.project, spec: f.spec, definition: '9', ref: 'main', inputs: { commit_sha: 'a'.repeat(40) } });
  expect(JSON.parse(inputs.credential_operations)).toEqual({ web: { operationId: 'op', serviceId: 's' } });
  expect(JSON.stringify(inputs)).not.toContain('API_KEY');
  expect(await observeGitHubCredentialRollout({ project: f.project, spec: f.spec, runId: '20' })).toEqual([{ service: 'web', serviceId: 's', operationId: 'op', deploymentIds: ['new'] }]);
  expect((new EnvironmentRepository().findById(f.environment.id)!.platformBindings.runtimeRollouts as any[])[0].expectedDeploymentId).toBe('new');
});
it.each(['producer', 'repository', 'old-run', 'operation', 'old-deployment', 'tag'])('rejects unproven managed credential activation: %s', async kind => {
  const f = fixture();
  if (kind === 'producer') f.adapter.getFileContent.mockResolvedValue('unreviewed producer');
  if (kind === 'repository') f.run.head_repository.full_name = 'attacker/fork';
  if (kind === 'old-run') f.run.run_started_at = '2026-10-24T00:00:00Z';
  if (kind === 'operation') f.evidence.credentialActivation.operations[0].operationId = 'different-operation';
  if (kind === 'old-deployment') f.evidence.credentialActivation.operations[0].deploymentIds = ['old'];
  if (kind === 'tag') f.adapter.getRef.mockResolvedValue({ ref: 'refs/tags/main', object: { sha: f.run.head_sha } });
  await expect(observeGitHubCredentialRollout({ project: f.project, spec: f.spec, runId: '20' })).rejects.toThrow();
  expect((new EnvironmentRepository().findById(f.environment.id)!.platformBindings.runtimeRollouts as any[])[0].expectedDeploymentId).toBeUndefined();
});

// Official GET /actions/workflows/{workflow_id} permits a numeric id or file
// name, not a repository-relative path. These wire responses are reconstructed.
it.each(['9', '.github/workflows/deploy.yml'])('reads an exact workflow through the native workflow identity endpoint: %s', async definition => {
  const adapter = new GitHubAdapter(); adapter.connect({ apiToken: 'synthetic-private-token' });
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 9, path: '.github/workflows/deploy.yml', state: 'active' }));
  await expect(adapter.getWorkflow('acme', 'app', definition)).resolves.toMatchObject({ id: 9, state: 'active' });
  expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/app/actions/workflows/' + (definition === '9' ? '9' : 'deploy.yml'));
});
