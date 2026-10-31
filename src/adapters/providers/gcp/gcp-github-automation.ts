import type { Environment } from '../../../domain/entities/environment.entity.js';
import { parseGcpGithubWorkloadIdentity } from './gcp-github-workload-identity.js';

/** The backup controller reuses only the separately reviewed backup workflow. */
export function gcpGithubRecoveryAuthentication(environment: Environment) {
  const raw = environment.platformBindings.gcpGithubWorkloadIdentity;
  if (raw === undefined) return undefined;
  const identity = parseGcpGithubWorkloadIdentity(raw);
  if (identity.projectId !== environment.platformBindings.projectId || identity.environment !== environment.name
    || identity.backupWorkflow !== `.github/workflows/hypervibe-backup-${environment.name}.yml`)
    throw new Error('The selected Google CI identity does not authorize this backup environment and workflow.');
  return { credentials: { projectId: identity.projectId, authMode: 'github-workload-identity', workloadIdentity: identity },
    environmentKeys: ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'], oidc: true };
}
