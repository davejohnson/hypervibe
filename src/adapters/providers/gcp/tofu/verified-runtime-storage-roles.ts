import { isDeepStrictEqual } from 'node:util';
import { backupAccessScopes, backupStorageRole, projectStorageDefinition, storageDefinitionCondition, unpackBackupCondition } from './backup-archive-access.js';
import { composeGcpProjectConfiguration, getGcpProjectSetupContributions } from './project-setup-executor.js';
import type { IamPolicy } from './secret-scope-setup.js';
import { isolationGrants, type TransferIsolationScope } from './transfer-isolation.js';

/** Match the complete live project grant. A second grant can restore access to protected objects. */
export function verifiedGcpRuntimeStorageRoles(policy: IamPolicy, localProjectId: string, gcpProjectId: string,
  runtimeEmail: string | undefined, isolation: TransferIsolationScope | undefined) {
  const restricted = new Set<string>();
  const bindingsFor = (role: string, member: string) =>
    (policy.bindings ?? []).filter(binding => binding.role === role && binding.members?.includes(member));
  for (const grant of isolation ? isolationGrants(isolation) : []) {
    const bindings = bindingsFor(grant.role, grant.member);
    const condition = bindings[0]?.condition;
    const base = grant.role === backupStorageRole ? unpackBackupCondition(condition).base : condition;
    if (policy.version !== 3 || bindings.length !== 1 || !isDeepStrictEqual(base, grant.condition)) {
      throw new Error(`The app's ${grant.role} migration access restriction does not match the saved project setup.`);
    }
    restricted.add(grant.role);
  }
  if (!runtimeEmail) return restricted;
  const contributions = getGcpProjectSetupContributions(localProjectId, gcpProjectId);
  if (!backupAccessScopes(contributions).some(scope => scope.runtimeEmail === runtimeEmail)) return restricted;
  const expected = storageDefinitionCondition(projectStorageDefinition(composeGcpProjectConfiguration(contributions), runtimeEmail));
  const bindings = bindingsFor(backupStorageRole, 'serviceAccount:' + runtimeEmail);
  if (policy.version !== 3 || bindings.length !== 1 || !isDeepStrictEqual(bindings[0]?.condition, expected)) {
    throw new Error('The Google application storage permission no longer excludes its saved daily backup archives. Review the daily backup plan.');
  }
  restricted.add(backupStorageRole);
  return restricted;
}
