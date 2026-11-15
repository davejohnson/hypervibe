import { parseGitHubRepoFromRemote } from '../../lib/git-remote.js';
import { getGitHubAdapter } from './github-ops.service.js';
import type { BackupPolicyContext, BackupResource } from './backup-policy.service.js';
import { compileBackupWorkflow } from './backup-workflow.service.js';
import { objectRecoverySourceIdentity, resolveManagedBackupTarget, type ManagedBackupTarget } from './managed-backup-target.service.js';

export function managedRecoverySource(target: ManagedBackupTarget, resource: BackupResource) {
  if (resource.retained || resource.bindingState !== 'bound') return undefined;
  if (resource.kind === 'database' && target.database && resource.componentId === target.database.componentId) return target.database.source;
  if (resource.kind === 'storage') {
    const object = target.objects.find(item => item.name === resource.name && item.identity.provider === resource.provider);
    return object ? objectRecoverySourceIdentity(object.identity) : undefined;
  }
  return undefined;
}

/** The scheduler is configured only when its exact reviewed files exist and the workflow is active. */
export async function observeManagedBackupProgram(context: BackupPolicyContext) {
  const resolved = await resolveManagedBackupTarget(context);
  if (resolved.state !== 'ready') return resolved;
  try {
    const repository = parseGitHubRepoFromRemote(context.project?.gitRemoteUrl);
    if (!repository) return { state: 'blocked' as const, issues: ['Managed backup scheduling requires a scoped GitHub repository.'] };
    const [owner, repo] = repository.split('/');
    const connected = getGitHubAdapter(repository);
    if ('error' in connected) return { state: 'blocked' as const, issues: ['The managed backup schedule could not be observed.'] };
    const files = compileBackupWorkflow({ project: resolved.target.project, environment: resolved.target.environment,
      contractHash: resolved.contractHash, runnerImage: resolved.target.runnerImage,
      providerCredentialNames: resolved.providerCredentialNames, contract: resolved.target });
    for (const file of files) if (await connected.adapter.getFileContent(owner, repo, file.path) !== file.content) {
      return { state: 'blocked' as const, issues: ['The managed backup workflow and exact resource contract await publication.'] };
    }
    const workflows = await connected.adapter.listWorkflows(owner, repo);
    const selected = workflows.workflows.filter(item => item.path === `.github/workflows/hypervibe-backup-${resolved.target.environment}.yml`);
    if (workflows.total_count !== workflows.workflows.length || selected.length !== 1 || selected[0].state !== 'active') {
      return { state: 'blocked' as const, issues: ['The managed backup schedule is not active or its inventory is incomplete.'] };
    }
    return resolved;
  } catch { return { state: 'blocked' as const, issues: ['The managed backup schedule observation is unknown.'] }; }
}
