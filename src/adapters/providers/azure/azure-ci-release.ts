import { strictHealthCheck } from '../../../domain/services/release-health.js';
import { azureCiRegistry } from './azure-ci-registry.js';
import type { EngineCiReleaseTarget, GitHubOidcContext } from '../../../domain/ports/engine-ci.port.js';
import type { EngineCiBinding } from '../../../domain/spec/engine-ci-binding.js';
import type { ProjectSpec } from '../../../domain/spec/spec.schema.js';
import { AzureCiTokens } from './azure-ci-auth.js';
import { ARM, AZURE_SCOPES, azureRest } from './azure-ops.client.js';
import { APPS_API, AZURE_DOCKERFILE, azureReleaseDockerfile, buildWithAcrTasks, releaseAzureApp, releaseAzureJob, runsImage } from './azure-release.client.js';

export async function createAzureCiReleaseTarget(binding: EngineCiBinding, context: GitHubOidcContext, spec: ProjectSpec): Promise<EngineCiReleaseTarget> {
  const a = binding.azure!; const deadline = context.deadlineMs ?? Date.now() + 35 * 60_000;
  if (!a.buildTaskId) throw new Error('Azure CI requires the applied environment build task.');
  const tokens = new AzureCiTokens(binding, context); await tokens.get(AZURE_SCOPES.arm);
  const inspect = async (name: string) => {
    if (Date.now() + 30_000 >= deadline) throw new Error('The release observation deadline has elapsed.');
    const w = binding.services[name]!;
    const r = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${w.serviceId}?${APPS_API}`);
    const p = r.body.properties as { environmentId?: string; managedEnvironmentId?: string; template?: Record<string, unknown> } | undefined;
    if (r.status !== 200 || typeof r.body.id !== 'string' || r.body.id.toLowerCase() !== w.serviceId.toLowerCase()
      || String(r.body.location).toLowerCase() !== w.region.toLowerCase() || !w.managedEnvironmentId
      || (p?.environmentId ?? p?.managedEnvironmentId)?.toLowerCase() !== w.managedEnvironmentId.toLowerCase()
      || !Array.isArray(p?.template?.containers) || !(p.template.containers as Array<{ name?: string }>).some((c) => c.name === 'app')) throw new Error('Azure did not confirm the exact workload and its managed environment before release.');
    return r.body;
  };
  return { cloudName: 'Azure', buildPhrase: 'with ACR Tasks', format: 'tar.gz', dockerfileName: AZURE_DOCKERFILE,
    dockerfileFor: azureReleaseDockerfile, redact: tokens.redact,
    preflight: async () => {
      const expected = azureCiRegistry({ subscriptionId: a.subscriptionId, resourceGroup: a.resourceGroup, environmentId: binding.environmentId });
      if (a.registryId.toLowerCase() !== expected.id.toLowerCase() || a.registryLoginServer !== expected.loginServer) throw new Error('CI can build only in its applied environment registry.');
      // This version reports the permission mode that ACR Tasks data-plane access depends on.
      const observed = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${a.registryId}?api-version=2025-11-01`);
      const tags = observed.body.tags as Record<string, unknown> | undefined;
      const properties = observed.body.properties as { loginServer?: string; provisioningState?: string; roleAssignmentMode?: string } | undefined;
      if (observed.status !== 200 || String(observed.body.id).toLowerCase() !== a.registryId.toLowerCase() || properties?.loginServer !== a.registryLoginServer
        || properties.provisioningState !== 'Succeeded' || properties.roleAssignmentMode !== 'LegacyRegistryPermissions'
        || tags?.['managed-by'] !== 'hypervibe' || tags?.['hv-environment'] !== binding.environmentId.toLowerCase()) throw new Error('Azure did not confirm the dedicated build registry identity, supported permissions mode and environment ownership.');
      const task = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${a.buildTaskId}?api-version=2019-06-01-preview`);
      if (task.status !== 200 || String(task.body.id).toLowerCase() !== a.buildTaskId!.toLowerCase() || (task.body.properties as { status?: string } | undefined)?.status !== 'Enabled') throw new Error('Azure did not confirm the exact enabled environment build task.');
      for (const name of Object.keys(binding.services).sort()) await inspect(name);
    },
    build: (source) => buildWithAcrTasks(tokens, { registryId: a.registryId, loginServer: a.registryLoginServer, taskId: a.buildTaskId, source, deadlineMs: deadline }),
    releaseWorkload: async ({ name, image }) => {
      await inspect(name); const w = binding.services[name]!;
      const result = w.workloadKind === 'cron' ? await releaseAzureJob(tokens, { id: w.serviceId, name, image, requireExactIdentity: true })
        : await releaseAzureApp(tokens, { id: w.serviceId, name, image, requireExactIdentity: true, waitMs: Math.max(1, deadline - Date.now()), fetchTimeoutMs: Math.max(1, Math.min(3 * 60_000, deadline - Date.now())), web: w.workloadKind === 'web', healthCheckPath: spec.environments[binding.environmentName]!.services[name]!.healthCheckPath, strictHealth: strictHealthCheck(spec.environments[binding.environmentName]!.services[name]!) });
      if (result.status !== 'released') return result;
      for (let attempt = 0; attempt < 60 && Date.now() < deadline; attempt++) {
        const current = await inspect(name); const p = current.properties as { provisioningState?: string; template?: Record<string, unknown>; latestRevisionName?: string; latestReadyRevisionName?: string };
        if (p.provisioningState === 'Failed') return { ...result, status: 'failed', message: 'Azure reports that the released workload failed to provision.' };
        if (p.provisioningState === 'Succeeded' && runsImage(p.template, image)) {
          if (w.workloadKind === 'cron') return result;
          if (p.latestRevisionName && p.latestRevisionName === p.latestReadyRevisionName) {
            const id = `${w.serviceId}/revisions/${p.latestRevisionName}`;
            const revision = await azureRest(tokens, AZURE_SCOPES.arm, 'GET', `${ARM}${id}?${APPS_API}`);
            const health = revision.body.properties as { healthState?: string; provisioningState?: string } | undefined;
            if (revision.status === 200 && typeof revision.body.id === 'string' && revision.body.id.toLowerCase() === id.toLowerCase() && health?.healthState === 'Healthy' && health.provisioningState === 'Provisioned') {
              if (w.workloadKind === 'web' && (!result.health || result.health.status < 200 || result.health.status >= 400)) return { ...result, status: 'failed', message: 'The current Azure revision did not pass its application HTTP check.' };
              return result;
            }
            if (health?.healthState === 'Unhealthy') return { ...result, status: 'failed', message: 'Azure reports that the released revision is unhealthy.' };
          }
        }
        if (attempt < 59) await new Promise((done) => setTimeout(done, 5000));
      }
      return { ...result, status: 'unknown', message: 'Azure did not confirm the exact current image and ready revision before the observation deadline.' };
    },
  };
}
