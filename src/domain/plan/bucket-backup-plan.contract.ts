import { z } from 'zod';
import { engineSegmentOf } from '../ports/infrastructure-engine.port.js';
import type { PlanAction } from './plan.types.js';

const cloud = z.enum(['gcp', 'aws', 'azure']);
const nonempty = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const program = z.object({
  storageName: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),
  source: nonempty, archive: nonempty, planId: nonempty, scopeFingerprint: digest, configurationDigest: digest,
  state: z.object({ provider: cloud, projectId: nonempty, environmentId: nonempty, partition: z.literal('environment') }).strict(),
}).strict();

export const bucketBackupDescriptorSchema = z.object({ provider: cloud, programs: z.array(program).min(1) }).strict();
export const googleBackupAccessDescriptorSchema = z.object({ provider: z.literal('gcp'), stage: z.literal('restrict-application-storage'),
  storageName: program.shape.storageName, source: nonempty, archive: nonempty, projectId: nonempty, runtimeEmail: z.email(),
  setupPlanId: z.string().regex(/^setup-[a-f0-9-]{36}$/), scopeFingerprint: digest }).strict();
export const anyBucketBackupDescriptorSchema = z.union([bucketBackupDescriptorSchema, googleBackupAccessDescriptorSchema]);

export function validBucketBackupActions(raw: unknown, actions: PlanAction[]) {
  const grant = googleBackupAccessDescriptorSchema.safeParse(raw);
  if (grant.success) {
    const [action] = actions, desc = grant.data;
    return actions.length === 1 && action?.id === 'bucket-backup:' + desc.storageName + ':app-access' && action.type === 'replace' &&
      action.resource.provider === 'gcp' && action.resource.kind === 'project' && action.resource.name === desc.runtimeEmail && action.verified === true &&
      action.requiresConfirm === true && !action.billable && !action.dataBearing && !action.dependsOn?.length && !action.background && !action.metadata && desc.source !== desc.archive;
  }
  const descriptor = bucketBackupDescriptorSchema.safeParse(raw);
  if (!descriptor.success) return false;
  const { provider, programs } = descriptor.data;
  const programsByName = new Map(programs.map(p => [p.storageName, p]));
  if (programsByName.size !== programs.length || new Set(programs.map(p => p.planId)).size !== programs.length
    || new Set(programs.map(p => p.state.environmentId)).size !== programs.length
    || programs.some(p => p.state.provider !== provider || p.source === p.archive)) return false;
  const ids = new Set<string>();
  return actions.every(action => {
    const [prefix, name] = action.id.split(':');
    const entry = programsByName.get(name ?? '');
    if (prefix !== 'bucket-backup' || !entry || action.resource.provider !== provider || !action.verified
      || ids.has(action.id) || action.metadata?.operation || action.metadata?.engineAdopt) return false;
    ids.add(action.id);
    if (action.type === 'noop') return action.metadata?.engineSegment === undefined;
    const segment = engineSegmentOf(action);
    return (action.type === 'create' || action.type === 'update') && action.requiresConfirm === true
      && segment?.id === `opentofu:${entry.planId}` && segment.configurationDigest === entry.configurationDigest
      && digest.safeParse(segment.planDigest).success && segment.addresses.length > 0
      && segment.addresses.every(address => typeof address === 'string' && address.length > 0);
  });
}
