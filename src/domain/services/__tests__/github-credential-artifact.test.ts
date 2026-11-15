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
it('preserves the accepted server validator bytes when sharing credential activation validation', () => {
  // Captured at 0c74fd26, before extracting the validator for mobile consumers.
  // This migration must not silently change locked server-only workflows.
  expect(createHash('sha256').update(releaseEvidenceValidationRuntime().trim() + '\n').digest('hex'))
    .toBe('09cd0133c555baff8384ddc759c0de94671a0d0c3397d04a2a85afff8272cba9');
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
  env.HYPERVIBE_CREDENTIAL_DEPLOYMENTS = '[]'; await execute();
  expect(JSON.parse(output).credentialActivation.operations).toEqual([]);
});
