import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../../../db/sqlite.adapter.js';
import { ProjectRepository } from '../../../db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../db/repositories/environment.repository.js';
import { getSecretStore } from '../../../secrets/secret-store.js';
import { projectSpecSchema } from '../../../../domain/spec/spec.schema.js';
import { hashEnvValue } from '../../../../domain/ports/observe.port.js';
const program = vi.hoisted(() => vi.fn());
const producer = vi.hoisted(() => vi.fn());
vi.mock('../gitlab-ci.lifecycle.js', () => ({ observeGitLabManagedProgram: program, verifyGitLabCredentialProducer: producer }));
import { prepareGitLabCredentialRollout, observeGitLabCredentialRollout } from '../gitlab-credential-activation.js';
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-gitlab-credential-lifecycle-')); SqliteAdapter.resetInstance(); SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate(); producer.mockResolvedValue(true); });
afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const project = new ProjectRepository().create({ name: 'gitlab-credential', defaultPlatform: 'railway' });
  const spec = projectSpecSchema.parse({ version: 1, project: project.name, environments: { production: { hosting: { provider: 'railway' }, services: { web: {} } } } });
  const environment = new EnvironmentRepository().create({ projectId: project.id, name: 'production', platformBindings: { provider: 'railway', projectId: 'p1', environmentId: 'e1', services: { web: { serviceId: 's1' } }, runtimeRollouts: [{
    service: 'web', provider: 'railway', serviceExternalId: 's1', providerProjectId: 'p1', providerEnvironmentId: 'e1', operationId: 'plan-one',
    configurationExpectationEncrypted: getSecretStore().encryptObject({ API_KEY: hashEnvValue('private-value') }), configurationAccepted: 'readback', configurationAcceptedKeys: ['API_KEY'],
    baselineDeployment: { state: 'present', id: 'old' }, requiredAt: '2026-10-20T00:00:00Z', applyRunId: 'apply-one', actionIds: ['credential:role:hosting:production:API_KEY'],
  }] } });
  const evidence = { version: 2, provider: 'railway', repository: 'https://gitlab.com/acme/app', environment: 'production', sha: 'a'.repeat(40), programFingerprint: 'b'.repeat(64), deploymentContractFingerprint: 'c'.repeat(64), services: ['web'], providerIdentity: { projectId: 'p1', environmentId: 'e1' }, providerResources: [], ci: { projectId: '42', pipelineId: '20', jobId: '200' }, deployments: [{ serviceId: 's1', deploymentId: 'new' }],
    credentialActivation: { version: 1, operations: [{ service: 'web', serviceId: 's1', operationId: 'plan-one', deploymentIds: ['new'] }] } };
  const adapter = { observeManagedCredentialRun: vi.fn().mockResolvedValue({ state: 'present', value: { id: '20', phase: 'succeeded', sha: evidence.sha, createdAt: '2026-10-25T00:00:00Z' } }),
    listJobs: vi.fn().mockResolvedValue([{ id: '200', name: 'deploy-production', phase: 'succeeded', attempt: 'current' }]),
    readJobArtifactFile: vi.fn().mockImplementation(async () => ({ state: 'present', value: JSON.stringify(evidence) })) };
  program.mockResolvedValue({ adapter, repository: { nativeId: '42', canonicalScope: evidence.repository }, ref: 'main', rootPath: '.gitlab-ci.yml', programHash: evidence.programFingerprint,
    deployJobName: 'deploy-production', hostingProvider: 'railway', releaseEvidence: { services: ['web'], providerIdentity: evidence.providerIdentity, providerResources: [], deploymentContractFingerprint: evidence.deploymentContractFingerprint, requiresImmutableImage: false } });
  return { project, spec, environment, adapter, evidence };
}
it('dispatches the frozen operation and consumes exact successful producer evidence through existing rollout state', async () => {
  const f = fixture();
  const inputs = await prepareGitLabCredentialRollout({ ...f, definition: '.gitlab-ci.yml', ref: 'main', inputs: { environment: 'production' } });
  expect(JSON.parse(inputs.credential_operations)).toEqual({ web: { operationId: 'plan-one', serviceId: 's1' } });
  expect(await observeGitLabCredentialRollout({ ...f, runId: '20' })).toEqual(f.evidence.credentialActivation.operations);
  expect((new EnvironmentRepository().findById(f.environment.id)!.platformBindings.runtimeRollouts as any[])[0]).toMatchObject({ expectedDeploymentIds: ['new'] });
});
it.each(['producer', 'operation', 'service', 'prior-deployment', 'before-acceptance'] as const)('keeps activation pending for wrong %s evidence', async mismatch => {
  const f = fixture();
  if (mismatch === 'producer') producer.mockResolvedValue(false);
  if (mismatch === 'operation') f.evidence.credentialActivation.operations[0].operationId = 'other-plan';
  if (mismatch === 'service') f.evidence.credentialActivation.operations[0].serviceId = 'other-service';
  if (mismatch === 'prior-deployment') f.evidence.credentialActivation.operations[0].deploymentIds = ['old'];
  if (mismatch === 'before-acceptance') f.adapter.observeManagedCredentialRun.mockResolvedValue({ state: 'present', value: { id: '20', phase: 'succeeded', sha: f.evidence.sha, createdAt: '2026-10-19T00:00:00Z' } });
  await expect(observeGitLabCredentialRollout({ ...f, runId: '20' })).rejects.toThrow();
  expect((new EnvironmentRepository().findById(f.environment.id)!.platformBindings.runtimeRollouts as any[])[0]).not.toHaveProperty('expectedDeploymentIds');
});
