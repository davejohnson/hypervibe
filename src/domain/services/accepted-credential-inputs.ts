import { isDeepStrictEqual } from 'node:util';
import { EnvironmentRepository } from '../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../adapters/db/repositories/run.repository.js';
import { getSecretStore } from '../../adapters/secrets/secret-store.js';
import type { Project } from '../entities/project.entity.js';
import { SpecStore } from '../spec/spec.store.js';
import { credentialActionId, type CredentialTarget } from '../plan/credential-plan.contract.js';
import type { CredentialTracking } from '../spec/credential.schema.js';
import { githubActionsCanonicalEnvironment } from '../spec/devops-selection.js';
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Reuse accepted encrypted plan input for an explicitly declared CI destination.
 * Never re-read the local candidate during an ordinary CI reconciliation. */
export function acceptedCredentialCiInputs(project: Project, repository: string, environmentName: string): Array<{ name: string; value?: string }> {
  const spec = new SpecStore().getForInspection(project)?.spec;
  if (!spec) return [];
  const canonical = githubActionsCanonicalEnvironment(spec);
  const environment = canonical ? new EnvironmentRepository().findByProjectAndName(project.id, canonical) : null;
  return Object.entries(spec.secrets).flatMap(([name, slot]) => {
    if (slot.ownership !== 'delegated' || !slot.credential || !slot.githubActions?.environments.includes(environmentName)) return [];
    const tracking = obj(obj(environment?.platformBindings.credentialUpdates)[slot.credential.role]);
    if (!environment || tracking.state !== 'accepted' || typeof tracking.planId !== 'string' || !isDeepStrictEqual(tracking.descriptor, slot.credential)) return [{ name }];
    const run = new RunRepository().findById(tracking.planId);
    const encrypted = obj(obj(run?.plan).overrides).delegatedSecretVarsEncrypted;
    if (run?.projectId !== project.id || typeof encrypted !== 'string') return [{ name }];
    const frozen = getSecretStore().decryptObject<{ value: string; descriptor: CredentialTracking; reviewedActions: Array<{ metadata?: { target?: CredentialTarget } }> }>(encrypted);
    const target = frozen.reviewedActions.map(action => action.metadata?.target).find(target => target?.kind === 'github' && target.key === name && target.repository === repository && target.scope === environmentName);
    if (!target || !isDeepStrictEqual(frozen.descriptor, slot.credential) || !Array.isArray(tracking.completed) || !tracking.completed.includes(credentialActionId(slot.credential.role, target))) return [{ name }];
    return [{ name, value: frozen.value }];
  });
}

export function credentialSourceInputKeys(spec: import('../spec/spec.schema.js').ProjectSpec): string[] {
  return Object.values(spec.secrets).flatMap(slot => {
    const source = slot.credential?.source;
    if (!source) return [];
    if (source.startsWith('dotenv:')) return [source.slice(source.lastIndexOf('#') + 1)];
    if (source.startsWith('env:')) return [source.slice(4)];
    return [];
  });
}
