import type { Project } from '../domain/entities/project.entity.js';
import type { ProjectSpec } from '../domain/spec/spec.schema.js';
import { getCloudPreparation } from '../domain/services/cloud-prepare.js';
import { getDefaultAdminAccessToken } from '../domain/services/cloud-prepare.execute.js';
import type { CommandContext } from './context.js';
import { prepareGcpSecretScope } from './gcp-secret-scope.js';

/**
 * Previews or confirms the cloud access that makes secrets limited to named
 * services a boundary. Only Google Cloud needs a separate administrator step;
 * AWS and Azure build the identities inside the environment's own plan.
 */
export async function prepareSecretScopeAccess(ctx: Pick<CommandContext, 'repos'>, params: {
  project: Project; spec: ProjectSpec | undefined; environmentName: string; requestedGcpProjectId?: string;
  adminAccessToken?: string; confirm?: boolean;
}): Promise<Record<string, unknown> & { success: boolean }> {
  const environment = params.spec?.environments[params.environmentName];
  if (!params.spec || !environment || environment.hosting.provider !== 'cloudrun') {
    return { success: false, error: 'Choose a Cloud Run environment of this project. Other clouds need no separate access step for secrets limited to named services.' };
  }
  const gcpProjectId = environment.hosting.gcpProjectId ?? getCloudPreparation(params.project, 'cloudrun')?.gcpProjectId;
  if (!gcpProjectId || (params.requestedGcpProjectId !== undefined && params.requestedGcpProjectId !== gcpProjectId)) {
    return { success: false, error: 'The selected environment has no prepared Google Cloud project matching this request. Complete base setup for it first.' };
  }
  return prepareGcpSecretScope(ctx, { project: params.project, spec: params.spec, environmentName: params.environmentName, gcpProjectId, confirm: params.confirm,
    adminToken: async () => params.adminAccessToken ?? getDefaultAdminAccessToken() });
}
