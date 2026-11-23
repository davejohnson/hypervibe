import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { admitEngineCiRelease, parseEngineCiBinding, type EngineCiBinding } from '../../domain/spec/engine-ci-binding.js';
import { environmentDeploymentContractHash } from '../../domain/services/deployment-contract.service.js';
import { renderEngineCiWorkflow, writeEngineCiWorkflow } from '../engine-ci-workflow.js';
import { removeReleaseWorkflow } from '../infrastructure-engine-ci.js';
import { azureCiRegistry } from '../../adapters/providers/azure/azure-ci-registry.js';

const rawSpec = { version: 1, project: 'app', gitRemoteUrl: 'https://github.com/owner/app', environments: {
  dev: { hosting: { provider: 'aws', region: 'us-west-2' }, deploy: { strategy: 'branch', branch: 'main' }, services: { web: { workloadKind: 'web' } } },
} };
const binding: EngineCiBinding = { version: 1, provider: 'aws', repository: 'owner/app', branch: 'main', environmentName: 'dev', environmentId: 'env1',
  prefix: 'hv-app-dev', region: 'us-west-2', appliedContractHash: environmentDeploymentContractHash(rawSpec, 'dev'),
  aws: { accountId: '111122223333', roleArn: 'arn:aws:iam::111122223333:role/hypervibe/app/hv-app-dev-ci',
    buildProjectArn: 'arn:aws:codebuild:us-west-2:111122223333:project/hv-app-dev-images', sourceBucket: 'hv-app-dev-build-111122223333', repositoryUrl: '111122223333.dkr.ecr.us-west-2.amazonaws.com/hv-app-dev' },
  services: { web: { serviceId: 'arn:aws:ecs:us-west-2:111122223333:service/hv-app-dev/hv-app-dev-web', workloadKind: 'web', resourceType: 'ecs-express', region: 'us-west-2' } },
};
const request = (value: unknown = binding) => ({ rawSpec, environmentName: 'dev', repository: 'owner/app', ref: 'refs/heads/main', sha: 'a'.repeat(40),
  bindings: { version: 1, project: 'app', environments: { dev: { platformBindings: { engineCi: value } } } } });

describe('applied engine CI admission', () => {
  it('admits the exact raw committed contract, independently of schema defaults', () => {
    expect(admitEngineCiRelease(request())).toMatchObject({ status: 'ready', binding });
  });
  it('uses a neutral bootstrap when no applied marker exists', () => {
    expect(admitEngineCiRelease(request(null))).toMatchObject({ status: 'skipped' });
  });
  it('distinguishes malformed binding exports from an absent applied marker', () => {
    expect(() => admitEngineCiRelease({ ...request(), bindings: { version: 1, project: 'app', environments: 'unreadable' } })).toThrow();
    expect(() => admitEngineCiRelease({ ...request(), bindings: { ...request().bindings, accessToken: 'unexpected' } })).toThrow();
  });
  it.each([
    { repository: 'fork/app' }, { ref: 'refs/heads/other' }, { sha: 'bad' },
    { rawSpec: { ...rawSpec, environments: { dev: { ...rawSpec.environments.dev, envVars: { MODE: 'changed' } } } } },
  ])('refuses a changed execution or deployment contract before effects', (patch) => {
    expect(() => admitEngineCiRelease({ ...request(), ...patch })).toThrow();
  });
  it('rejects extra fields, incomplete workloads and another environment’s resource', () => {
    expect(() => parseEngineCiBinding({ ...binding, accessToken: 'never-export-me' })).toThrow();
    expect(() => admitEngineCiRelease(request({ ...binding, services: {} }))).toThrow(/Every declared/);
    expect(() => parseEngineCiBinding({ ...binding, services: { web: { ...binding.services.web, serviceId: binding.services.web!.serviceId.replace('hv-app-dev-', 'hv-app-other-') } } })).toThrow(/scope/);
  });
  it('requires the exact dedicated Azure registry, build task and managed environment before authentication', () => {
    const subscriptionId = '11111111-2222-4333-a444-555555555555';
    const group = `/subscriptions/${subscriptionId}/resourceGroups/hv-app`;
    const registry = azureCiRegistry({ subscriptionId, resourceGroup: 'hv-app', environmentId: 'env1' });
    const azure = { ...binding, provider: 'azure', aws: undefined, region: 'westus2',
      azure: { subscriptionId, tenantId: subscriptionId, clientId: subscriptionId, resourceGroup: 'hv-app', registryId: registry.id, registryLoginServer: registry.loginServer, buildTaskId: `${registry.id}/tasks/hv-app-dev-images` },
      services: { web: { workloadKind: 'web', resourceType: 'container-app', region: 'westus2', serviceId: `${group}/providers/Microsoft.App/containerApps/hv-app-dev-web`, managedEnvironmentId: `${group}/providers/Microsoft.App/managedEnvironments/hv-app-dev-apps` } },
    };
    expect(parseEngineCiBinding(azure).azure?.registryId).toBe(registry.id);
    expect(() => parseEngineCiBinding({ ...azure, azure: { ...azure.azure, buildTaskId: undefined } })).toThrow();
    expect(() => parseEngineCiBinding({ ...azure, azure: { ...azure.azure, registryId: `${group}/providers/Microsoft.ContainerRegistry/registries/shared` } })).toThrow();
    expect(() => parseEngineCiBinding({ ...azure, services: { web: { ...azure.services.web, managedEnvironmentId: undefined } } })).toThrow();
  });
});

describe('native engine CI workflow', () => {
  it('writes a workflow that teardown recognises as its own and deletes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-workflow-'));
    try {
      const written = writeEngineCiWorkflow(dir, binding);
      expect(removeReleaseWorkflow(dir, parseEngineCiBinding(binding).environmentName)).toContain('Hypervibe deleted');
      expect(fs.existsSync(written.path)).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses the shared packaged runner with exact branch guards, OIDC and bounded receipts', () => {
    const text = renderEngineCiWorkflow(binding, '0.1.99'); const workflow = YAML.parse(text);
    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.jobs.release.if).toContain("github.repository == 'owner/app'");
    expect(workflow.jobs.release).not.toHaveProperty('environment'); // Default OIDC subject must stay the exact branch ref.
    expect(workflow.jobs.release.env.HYPERVIBE_CI_ENVIRONMENT).toBe('dev');
    expect(workflow.jobs.release.steps[2].run).toContain('@hypervibe/hypervibe@0.1.99');
    expect(workflow.jobs.release.steps[3].run).toContain('runEngineCiReleaseFromProcess');
    expect(workflow.jobs.release.steps.at(-1)).toMatchObject({ if: 'always()', uses: 'actions/upload-artifact@v7' });
    expect(text).not.toMatch(/client.secret|secrets\.|tofu apply|aws .*create|az .*create/);
  });
  it('rejects syntax-bearing branch/repository data before rendering a workflow', () => {
    expect(() => renderEngineCiWorkflow({ ...binding, branch: "main' || true || '" })).toThrow();
    expect(() => renderEngineCiWorkflow({ ...binding, repository: 'owner/app\nrun: nope' })).toThrow();
  });
});
