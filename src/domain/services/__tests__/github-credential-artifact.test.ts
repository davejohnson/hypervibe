import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import '../../../adapters/providers/railway/railway.adapter.js';
import { buildBranchDeployWorkflow, releaseEvidenceValidationRuntime } from '../github-ops.service.js';
import { managedCiReleaseTarget } from '../managed-ci-targets.js';
import { extractGitHubScript, installReleaseEvidenceValidator, releaseEvidenceValidatorRequire } from './managed-ci-workflow.test-utils.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
it('pins the reviewed server validator for the version-aware activation producer', () => {
  // Reviewed with the versioned-activation migration at server renderer revision 8.
  // This migration must not silently change locked server-only workflows.
  expect(createHash('sha256').update(releaseEvidenceValidationRuntime().trim() + '\n').digest('hex'))
    .toBe('d610f35e8cd7d4fc90bb876cc9db305cf05f71835e3f34f854b0074003f96349');
});
it('joins accepted credential operations only to exact native deployment output in the executed producer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hv-credential-artifact-')); dirs.push(dir);
  const target = { kind: 'production' as const, environmentName: 'production', branch: 'main', providerProjectId: 'project', providerEnvironmentId: 'environment', providerServiceIds: ['service-a'], serviceNames: ['web'], autoDeployOnPush: false,
    programFingerprint: 'c'.repeat(64), releaseTarget: managedCiReleaseTarget({ provider: 'railway', environmentName: 'production', scope: { providerProjectId: 'project', providerEnvironmentId: 'environment' }, resources: [{ logicalName: 'web', providerResourceId: 'service-a', providerResourceType: 'service', workloadKind: 'web' }] }) };
  const workflow = buildBranchDeployWorkflow('railway', target, { includeStep: false });
  const validator = installReleaseEvidenceValidator(workflow.content, dir);
  const env = { HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath, HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
    HYPERVIBE_RELEASE_SHA: 'a'.repeat(40), HYPERVIBE_RELEASE_PROVIDER: 'railway', HYPERVIBE_RELEASE_ENVIRONMENT: 'production', HYPERVIBE_RELEASE_SERVICES: JSON.stringify(target.serviceNames),
    HYPERVIBE_RELEASE_TARGET_SCOPE: JSON.stringify(target.releaseTarget.scope), HYPERVIBE_RELEASE_RESOURCES: JSON.stringify(target.releaseTarget.resources), HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: target.releaseTarget.bindingsFingerprint,
    HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: target.programFingerprint, HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: 'b'.repeat(64), HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: 'false', GITHUB_REPOSITORY: 'owner/repo',
    HYPERVIBE_CREDENTIAL_OPERATIONS: JSON.stringify({ web: { operationId: 'reviewed-operation', serviceId: 'service-a', configurationVersion: 42 } }),
    HYPERVIBE_CREDENTIAL_DEPLOYMENTS: JSON.stringify([{ serviceId: 'service-a', deploymentIds: ['deployment-new'], configurationVersion: 42 }]),
  };
  let output = '';
  const execute = () => new AsyncFunction('require', 'process', 'core', extractGitHubScript(workflow.content, 'Write server release evidence'))(releaseEvidenceValidatorRequire(validator, { writeFileSync: (_file, content) => { output = String(content); } }), { env }, {});
  await execute();
  const evidence = JSON.parse(output);
  expect(evidence.credentialActivation).toEqual({ version: 1, operations: [{ service: 'web', serviceId: 'service-a', operationId: 'reviewed-operation', deploymentIds: ['deployment-new'], configurationVersion: 42 }] });
  const module = { exports: {} as any }; new Function('require', 'module', 'exports', releaseEvidenceValidationRuntime())(createRequire(import.meta.url), module, module.exports);
  expect(() => module.exports.validateReleaseEvidence(evidence, { label: 'test', provider: 'railway', environment: 'production', programFingerprint: target.programFingerprint, deploymentContractFingerprint: 'b'.repeat(64), repository: 'owner/repo', sha: 'a'.repeat(40), target: target.releaseTarget })).not.toThrow();
  for (const version of [undefined, 41, 43]) {
    env.HYPERVIBE_CREDENTIAL_DEPLOYMENTS = JSON.stringify([{ serviceId: 'service-a', deploymentIds: ['deployment-new'], ...(version !== undefined ? { configurationVersion: version } : {}) }]);
    await expect(execute()).rejects.toThrow(/configuration version/i);
  }
  env.HYPERVIBE_CREDENTIAL_DEPLOYMENTS = JSON.stringify([{ serviceId: 'unreviewed', deploymentIds: ['deployment-new'] }]);
  await expect(execute()).rejects.toThrow(/credential/i);
  env.HYPERVIBE_CREDENTIAL_DEPLOYMENTS = '[]';
  await expect(execute()).rejects.toThrow(/configuration version/i);
  env.HYPERVIBE_CREDENTIAL_OPERATIONS = '{}'; await execute();
  expect(JSON.parse(output).credentialActivation.operations).toEqual([]);
});

it.each(['staging', 'production'] as const)('checks %s version support before deploying and writes evidence from the deployment output', async kind => {
  const resources = ['web', 'worker'].map((logicalName, i) => ({
    logicalName, providerResourceId: 'service-' + i, providerResourceType: 'service' as const,
    workloadKind: i === 0 ? 'web' as const : 'worker' as const,
  }));
  const target = { kind, environmentName: kind, branch: 'main', providerProjectId: 'project', providerEnvironmentId: 'environment',
    providerServiceIds: resources.map(r => r.providerResourceId), serviceNames: resources.map(r => r.logicalName), autoDeployOnPush: false,
    programFingerprint: 'c'.repeat(64), releaseTarget: managedCiReleaseTarget({ provider: 'railway', environmentName: kind,
      scope: { providerProjectId: 'project', providerEnvironmentId: 'environment' }, resources }) };
  const { content } = buildBranchDeployWorkflow('railway', target, { includeStep: false });
  const dir = mkdtempSync(join(tmpdir(), 'activation-producer-')); dirs.push(dir);
  const validator = installReleaseEvidenceValidator(content, dir);
  const sha = 'a'.repeat(40);
  const inputs = { credential_operations: '' };
  const outputs: Record<string, string> = {};
  const core = { info() {}, setOutput(key: string, value: string) { outputs[key] = value; } };
  const env: Record<string, string> = { GITHUB_SHA: sha, RAILWAY_API_TOKEN: 'test', RAILWAY_ENVIRONMENT_ID: 'environment',
    RAILWAY_SERVICE_IDS: target.providerServiceIds.join(','), IMAGE_REGISTRY_USERNAME: 'test', IMAGE_REGISTRY_TOKEN: 'test', IMAGE_URI: 'registry/image', DEPLOY_SHA: sha,
    HYPERVIBE_RELEASE_VALIDATOR_PATH: validator.validatorPath, HYPERVIBE_RELEASE_VALIDATOR_SHA256: validator.validatorSha256,
    HYPERVIBE_RELEASE_SHA: sha, HYPERVIBE_RELEASE_PROVIDER: 'railway', HYPERVIBE_RELEASE_ENVIRONMENT: kind, HYPERVIBE_RELEASE_SERVICES: JSON.stringify(target.serviceNames),
    HYPERVIBE_RELEASE_TARGET_SCOPE: JSON.stringify(target.releaseTarget.scope), HYPERVIBE_RELEASE_RESOURCES: JSON.stringify(target.releaseTarget.resources),
    HYPERVIBE_RELEASE_BINDINGS_FINGERPRINT: target.releaseTarget.bindingsFingerprint, HYPERVIBE_RELEASE_PROGRAM_FINGERPRINT: target.programFingerprint,
    HYPERVIBE_RELEASE_DEPLOYMENT_CONTRACT_FINGERPRINT: 'b'.repeat(64), HYPERVIBE_RELEASE_REQUIRES_IMMUTABLE_IMAGE: 'false', GITHUB_REPOSITORY: 'owner/repo' };
  const calls: string[] = [];
  const fetchRailway = async (_: string, request: { body: string }) => {
    const { query, variables } = JSON.parse(request.body);
    const op = query.split(' ')[1].split('(')[0]; calls.push(op);
    const responses: Record<string, unknown> = { ServiceEnvironmentInstance: { service: { serviceInstances: { edges: [{ node: { environmentId: 'environment' } }] } } },
      UpdateServiceImage: { serviceInstanceUpdate: true }, DeployServiceImage: { serviceInstanceDeployV2: 'deployment-' + variables.serviceId },
      DeploymentStatus: { deployment: { id: variables.id, status: 'SUCCESS' } } };
    if (!responses[op]) throw new Error('Unexpected Railway operation ' + op);
    return { ok: true, text: async () => JSON.stringify({ data: responses[op] }) };
  };
  const execute = async (operations: Record<string, unknown>) => {
    inputs.credential_operations = JSON.stringify(operations);
    await new AsyncFunction('context', 'process', 'core', extractGitHubScript(content, 'Resolve deploy SHA'))({ payload: { inputs } }, { env }, core);
    await new AsyncFunction('fetch', 'process', 'core', extractGitHubScript(content, 'Deploy image to Railway'))(fetchRailway, { env }, core);
    env.HYPERVIBE_CREDENTIAL_OPERATIONS = inputs.credential_operations;
    env.HYPERVIBE_CREDENTIAL_DEPLOYMENTS = outputs.credential_deployments;
    let evidence = '';
    await new AsyncFunction('require','process','core',extractGitHubScript(content,'Write server release evidence'))(
      releaseEvidenceValidatorRequire(validator, { writeFileSync: (_, bytes) => { evidence = String(bytes); } }), { env }, core);
    return JSON.parse(evidence).credentialActivation.operations;
  };
  const operations = Object.fromEntries(resources.map(r => [r.logicalName, { serviceId: r.providerResourceId, operationId: 'accepted' }]));
  await expect(execute({ ...operations, worker: { ...operations.worker, configurationVersion: 42 } })).rejects.toThrow(/configuration version/i);
  expect(calls).toEqual([]);
  expect(await execute(operations)).toEqual(resources.map(r => ({ service: r.logicalName, ...operations[r.logicalName], deploymentIds: ['deployment-' + r.providerResourceId] })));
});
