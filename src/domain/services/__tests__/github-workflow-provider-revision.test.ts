import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import '../../../application/providers.js';
import { parse, stringify } from 'yaml';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ConnectionRepository } from '../../../adapters/db/repositories/connection.repository.js';
import { GitHubAdapter } from '../../../adapters/providers/github/github.adapter.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { canonicalJsonSha256 } from '../../../lib/canonical-json.js';
import type { BranchDeployTarget } from '../../ports/ci-deploy.port.js';
import { providerRegistry } from '../../registry/provider.registry.js';
import { environmentSpecSchema } from '../../spec/spec.schema.js';
import { SpecStore } from '../../spec/spec.store.js';
import {
  buildBranchDeployWorkflow,
  githubActionsServerProgramFingerprint,
  githubActionsWorkflowInputHash,
  resolveBranchDeployTargets,
} from '../github-ops.service.js';
import { planGitHubActionsDeploy, workflowFilesContentHash } from '../ci-deploy.service.js';

// Published input contract before provider-scoped renderer migrations. Keep the
// literal revision and omission of provider metadata independent of production.
function previousInputHash(provider: string, inputTarget: BranchDeployTarget,
  migration: { includeStep: boolean; command?: string }): string {
  const target = { ...inputTarget };
  delete target.providerImageUris;
  delete target.programFingerprint;
  delete target.deploymentContractFingerprint;
  return canonicalJsonSha256({
    version: 1, rendererRevision: 6, provider, target,
    migration: { includeStep: migration.includeStep,
      ...(migration.includeStep && migration.command ? { command: migration.command } : {}) },
  });
}

beforeEach(() => {
  SqliteAdapter.resetInstance();
  SqliteAdapter.getInstance(':memory:').migrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  SqliteAdapter.resetInstance();
});

describe('provider-scoped managed workflow migrations', () => {
  it('requires publication of an accepted Cloud Run workflow using the old Job PATCH mask', async () => {
    const project = new ProjectRepository().create({
      name: 'cloud-app', defaultPlatform: 'cloudrun',
      gitRemoteUrl: 'https://github.com/example/cloud-app',
    });
    const environmentSpec = environmentSpecSchema.parse({
      hosting: { provider: 'cloudrun', region: 'us-west1' },
      services: { cron: { workloadKind: 'cron', startCommand: 'npm run cron', cronSchedule: '0 * * * *' } },
      deploy: { strategy: 'branch', trigger: 'ci', branch: 'main' },
    });
    const environments = new EnvironmentRepository();
    const environment = environments.create({ projectId: project.id, name: 'test', platformBindings: {
      provider: 'cloudrun', projectId: 'cloud-app-test',
      providerScope: { projectId: 'gcp-project', region: 'us-west1' },
      // A pre-existing binding has no new UID or pending marker. The renderer
      // migration must work without relying on those independent input changes.
      services: { cron: { serviceId: 'cloud-app-test-cron', jobName: 'cloud-app-test-cron',
        workloadKind: 'cron', resourceType: 'scheduledJob' } },
    } });
    new SpecStore().replace(project, { version: 1, project: project.name,
      environments: { test: environmentSpec } });
    const connections = new ConnectionRepository();
    for (const [provider, credentials] of [
      ['github', { apiToken: 'synthetic-github-token' }],
      ['cloudrun', { projectId: 'gcp-project', credentials: '{"type":"service_account"}' }],
    ] as const) {
      const connection = connections.create({ provider,
        credentialsEncrypted: getSecretStore().encryptObject(credentials) });
      connections.updateStatus(connection.id, 'verified');
    }
    const { targets, migration } = resolveBranchDeployTargets(project);
    const target = targets[0]!;
    expect(target.providerJobNames).toEqual(['cloud-app-test-cron']);
    const workflow = buildBranchDeployWorkflow('cloudrun', target, migration);
    expect(workflow.content).not.toContain('?updateMask=template.template.containers');
    const accepted = parse(workflow.content);
    const deploy = accepted.jobs.deploy.steps.find((step: { name?: string }) => step.name === 'Deploy image to Cloud Run');
    expect(deploy).toBeDefined();
    // Reconstruct the affected accepted step from 5d862de's
    // cloudrun-ci.workflow.ts:440-458, not by transforming the new request.
    // This fixture proves workflow publication; transport tests separately
    // establish the API contract (Job PATCH has no updateMask parameter).
    deploy.with.script = [
      'for (const jobName of jobNames) {',
      "  const url = 'https://run.googleapis.com/v2/projects/' + process.env.GCP_PROJECT_ID + '/locations/' + process.env.GCP_REGION + '/jobs/' + encodeURIComponent(jobName);",
      "  const operation = await googleJson(url + '?updateMask=template.template.containers', {",
      "    method: 'PATCH', headers,",
      '    body: JSON.stringify({ ...(filesystem.etag ? { etag: filesystem.etag } : {}), template }),',
      "  }, 'Cloud Run job deployment for ' + jobName);",
      "  await waitOperation(operation, 'job ' + jobName + ' deployment');",
      '}',
    ].join('\n');
    const acceptedContent = stringify(accepted);
    const oldInputHash = previousInputHash('cloudrun', target, migration);
    const secretValues = { GCP_PROJECT_ID: 'gcp-project', GCP_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}' };
    environments.updatePlatformBindings(environment.id, { ci: { deployBranch: { [workflow.path]: {
      inputHash: oldInputHash,
      contentHash: workflowFilesContentHash([{ path: workflow.path, content: acceptedContent }]),
      managedPaths: [workflow.path],
      syncedEnvironmentSecrets: Object.keys(secretValues),
      syncedEnvironmentSecretHashes: Object.fromEntries(Object.entries(secretValues)
        .map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')])),
    } } } });
    vi.spyOn(GitHubAdapter.prototype, 'getRepository').mockResolvedValue({ default_branch: 'main' });
    vi.spyOn(GitHubAdapter.prototype, 'getFileContent').mockResolvedValue(acceptedContent);
    const readSecrets = vi.spyOn(GitHubAdapter.prototype, 'listEnvironmentSecrets').mockResolvedValue(Object.keys(secretValues));

    const result = await planGitHubActionsDeploy({ project, environmentName: 'test', environmentSpec,
      environment: environments.findById(environment.id) });

    expect(result.error).toBeUndefined();
    expect(result.action).toMatchObject({ type: 'update', verified: true,
      reason: `GitHub Actions deploy workflow inputs changed for ${workflow.path}`,
      metadata: { workflowPublicationRequired: true } });
    expect((result.action?.metadata?.workflow as { inputHash: string }).inputHash).not.toBe(oldInputHash);
    expect(readSecrets).not.toHaveBeenCalled();
  });

  const target: BranchDeployTarget = {
    environmentName: 'test', kind: 'test', branch: 'main', autoDeployOnPush: false,
    serviceNames: ['web'], providerServiceIds: ['bound-web'],
  };
  const migration = { includeStep: false };

  it('preserves the previous input hash for every other named hosting provider', () => {
    const unchanged = ['azure-container-apps', 'digitalocean', 'ecs', 'fly', 'railway', 'vercel'];
    expect(providerRegistry.namesFor('hosting').sort()).toEqual([...unchanged, 'cloudrun'].sort());
    for (const provider of unchanged) {
      expect(githubActionsWorkflowInputHash({ provider, target, migration }), provider)
        .toBe(previousInputHash(provider, target, migration));
    }
    expect(githubActionsWorkflowInputHash({ provider: 'cloudrun', target, migration }))
      .not.toBe(previousInputHash('cloudrun', target, migration));
  });

  it('uses declared provider revisions generically without changing the server program', () => {
    const provider = 'railway';
    const inputBefore = githubActionsWorkflowInputHash({ provider, target, migration });
    const programBefore = githubActionsServerProgramFingerprint({ provider, target, migration });
    const lookup = providerRegistry.getMetadata.bind(providerRegistry);
    vi.spyOn(providerRegistry, 'getMetadata').mockImplementation(name => {
      const metadata = lookup(name);
      return name === provider ? { ...metadata!, orchestration: { ...metadata!.orchestration,
        ci: { ...metadata!.orchestration!.ci!, rendererRevision: 99 } } } : metadata;
    });
    expect(githubActionsWorkflowInputHash({ provider, target, migration })).not.toBe(inputBefore);
    expect(githubActionsServerProgramFingerprint({ provider, target, migration })).toBe(programBefore);
  });
});
