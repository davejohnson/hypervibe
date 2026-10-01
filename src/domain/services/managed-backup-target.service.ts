import { z } from 'zod';
import { canonicalJsonSha256 } from '../../lib/canonical-json.js';
import type { Environment } from '../entities/environment.entity.js';
import type { IStorageAdapter, StorageObjectClient } from '../ports/storage.port.js';
import { providerRegistry } from '../registry/provider.registry.js';
import type { BackupPolicyContext } from './backup-policy.service.js';
import { resolveBackupStrategy, withBackupStorageDefaults } from './backup-strategy.service.js';
import { objectRecoveryIdentitySchema, type ObjectRecoveryIdentity } from './object-recovery-set.service.js';
import { parseStorageBindings } from './storage-plan.service.js';
import { recoverySourceIdentitySchema } from './recovery-source.js';
import { createS3ObjectClient } from './object-storage-transfer.service.js';

const logicalName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/);
const selectedStorage = z.object({ name: logicalName, identity: objectRecoveryIdentitySchema }).strict();
/** The published recurring authority names every source, destination, query and immutable runner. */
export const managedBackupTargetSchema = z.object({ version: z.literal(1), project: logicalName, environment: logicalName,
  hosting: z.object({ provider: z.string().min(1), providerScope: z.record(z.string().min(1)) }).strict(),
  runnerImage: z.string().regex(/^[^@\s]+@sha256:[a-f0-9]{64}$/),
  destination: selectedStorage,
  database: z.object({ componentId: z.string().min(1), source: recoverySourceIdentitySchema }).strict().optional(),
  objects: z.array(selectedStorage).max(32),
  fileReferenceQueries: z.array(z.object({ storageName: logicalName, query: z.string().min(1).max(16000) }).strict()).max(32),
  retainSets: z.literal(7), maxDataAgeHours: z.literal(24), restoreEveryDays: z.literal(7),
}).strict();
export type ManagedBackupTarget = z.infer<typeof managedBackupTargetSchema>;
export const managedBackupTargetHash = (target: ManagedBackupTarget) => canonicalJsonSha256(managedBackupTargetSchema.parse(target));

/** Object-only recovery runs in the controller and requires no hosting credential. */
export function managedBackupProviderNames(target: {
  hosting: { provider: string }; database?: unknown;
  destination: { identity: { provider: string } }; objects: Array<{ identity: { provider: string } }>;
}): string[] {
  return [...new Set([...(target.database ? [target.hosting.provider] : []), target.destination.identity.provider,
    ...target.objects.map(item => item.identity.provider)])].sort();
}

export function managedBackupCredentialKeys(provider: string): Record<string, string> | undefined {
  const metadata = providerRegistry.getMetadata(provider);
  return metadata?.credentials?.automationSecretKeys ?? metadata?.orchestration?.ci?.secretCredentialKeys;
}

/** Preserve all provider-native storage scope fields without widening the secret-free public source schema. */
export function objectRecoverySourceIdentity(identity: ObjectRecoveryIdentity) {
  return recoverySourceIdentitySchema.parse({ provider: identity.provider, primaryExternalId: identity.externalId,
    providerScope: { storageScopeHash: canonicalJsonSha256(objectRecoveryIdentitySchema.parse(identity).instanceScope) }, resourceIdentity: {} });
}

export async function resolveManagedBackupTarget(context: BackupPolicyContext): Promise<
  { state: 'ready'; target: ManagedBackupTarget; contractHash: string; providerCredentialNames: string[] }
  | { state: 'blocked'; issues: string[] }
> {
  const spec = withBackupStorageDefaults(context.spec), strategy = resolveBackupStrategy(spec);
  if (strategy.mode !== 'daily') return { state: 'blocked', issues: ['Recurring backup execution is explicitly excluded.'] };
  const environment = context.environment;
  if (!environment || !context.project) return { state: 'blocked', issues: ['Backup execution requires the selected project and environment bindings.'] };
  const issues = [...strategy.issues];
  const hosting = providerRegistry.getMetadata(spec.hosting.provider);
  if (spec.database && !hosting?.lifecycle?.hosting?.recoveryTasks) issues.push('The hosting adapter does not implement private managed recovery tasks.');
  const bindings = parseStorageBindings(environment);
  const select = (name: string): z.infer<typeof selectedStorage> | undefined => {
    const binding = bindings[name], desired = spec.storage?.[name];
    const parsed = objectRecoveryIdentitySchema.safeParse(binding && { provider: binding.provider, externalId: binding.externalId, instanceScope: binding.instanceScope });
    if (!desired || !parsed.success || desired.provider !== parsed.data.provider || binding.region !== desired.region) {
      issues.push(`Backup storage identity for ${name} is not durably bound to the declared provider and region.`); return undefined;
    }
    return { name, identity: parsed.data };
  };
  const destination = strategy.destination ? select(strategy.destination) : undefined;
  const objects = Object.entries(spec.storage ?? {}).filter(([, storage]) => storage.purpose !== 'backup')
    .sort(([a], [b]) => a.localeCompare(b)).flatMap(([name]) => { const selected = select(name); return selected ? [selected] : []; });
  if (destination && objects.some(object => canonicalJsonSha256(object.identity) === canonicalJsonSha256(destination.identity))) issues.push('Backup destination aliases an application bucket.');
  let database: ManagedBackupTarget['database'];
  if (spec.database) {
    const components = context.components.filter(component => component.environmentId === environment.id
      && component.type === spec.database!.engine && component.bindings.provider === spec.database!.provider);
    if (components.length !== 1 || !components[0].externalId) issues.push('Backup execution requires one exact bound database.');
    else {
      // Scope comes from the database's durable binding. Hosting placement is
      // not authority for a database that may live in another provider/account.
      const bound = recoverySourceIdentitySchema.safeParse({ provider: components[0].bindings.provider,
        primaryExternalId: components[0].externalId, providerScope: components[0].bindings.providerScope, resourceIdentity: {} });
      if (!bound.success) issues.push('The database binding lacks valid durable recovery scope; re-import or re-plan the database before configuring backups.');
      else try {
        const adapter = await context.adapterFactory.getDatabaseAdapter(spec.database.provider, context.project);
        if (!adapter.success || adapter.adapter?.name !== bound.data.provider) throw new Error('Database adapter differs.');
        const observed = await adapter.adapter.dailyBackups?.observe({ environment, component: components[0] });
        const source = recoverySourceIdentitySchema.safeParse(observed?.state === 'known' ? observed.source : undefined);
        if (!source.success || source.data.provider !== bound.data.provider || source.data.primaryExternalId !== bound.data.primaryExternalId
          || Object.entries(bound.data.providerScope).some(([key, value]) => source.data.providerScope[key] !== value)) {
          issues.push('The current database recovery source differs from its durable binding or could not be independently observed.');
        } else database = { componentId: components[0].id, source: source.data };
      } catch { issues.push('The current database recovery source could not be independently observed.'); }
    }
  }
  const fileReferenceQueries = spec.backups?.mode === 'daily' ? spec.backups.fileReferenceQueries ?? [] : [];
  if (database && (fileReferenceQueries.length !== objects.length
    || objects.some(object => fileReferenceQueries.filter(query => query.storageName === object.name).length !== 1))) {
    issues.push('A reviewed read-only file-reference query is required for every bucket in a combined database/files set.');
  }
  const providers = destination ? managedBackupProviderNames({ hosting: spec.hosting, database, destination, objects }) : [];
  if (database) for (const provider of new Set([...objects.map(object => object.identity.provider), ...(destination ? [destination.identity.provider] : [])])) {
    try {
      const selected = await context.adapterFactory.getStorageAdapter(provider, context.project);
      if (!selected.success || selected.adapter?.capabilities?.recoveryCredentialScope !== 'bucket' || !selected.adapter.getCredentials) issues.push(`${provider} has no reviewed private-worker credential handoff for combined SQL/files recovery.`);
    } catch { issues.push(`${provider} private-worker credential handoff could not be resolved.`); }
  }
  const credentialNames = new Set<string>();
  for (const provider of providers) {
    const keys = managedBackupCredentialKeys(provider);
    if (!keys || !Object.keys(keys).length) issues.push(`${provider} has no reviewed CI credential contract for recovery execution.`);
    else for (const key of Object.keys(keys)) credentialNames.add(key);
  }
  const platform = environment.platformBindings;
  const providerScope = platform.providerScope ?? { projectId: platform.projectId, environmentId: platform.environmentId };
  const parsed = managedBackupTargetSchema.safeParse({ version: 1, project: context.project.name, environment: environment.name,
    hosting: { provider: spec.hosting.provider, providerScope }, runnerImage: strategy.runnerImage, destination, database,
    objects, fileReferenceQueries, retainSets: 7, maxDataAgeHours: 24, restoreEveryDays: 7 });
  if (!parsed.success) issues.push('The complete backup execution contract is not available yet.');
  if (issues.length || !parsed.success) return { state: 'blocked', issues: [...new Set(issues)] };
  return { state: 'ready', target: parsed.data, contractHash: managedBackupTargetHash(parsed.data), providerCredentialNames: [...credentialNames].sort() };
}

export async function openRecoveryStorage(adapter: IStorageAdapter, environment: Environment, identity: ObjectRecoveryIdentity): Promise<StorageObjectClient> {
  if (adapter.name !== identity.provider) throw new Error('Backup storage adapter identity differs.');
  const observed = await adapter.observe(environment, identity.instanceScope, { externalId: identity.externalId });
  const candidates = observed.filter(item => item.externalId === identity.externalId && item.provider === identity.provider
    && canonicalJsonSha256(item.instanceScope) === canonicalJsonSha256(identity.instanceScope));
  if (candidates.length !== 1 || candidates[0].status !== 'ready') throw new Error('The exact backup storage resource could not be observed.');
  if (adapter.openObjectTransfer) return adapter.openObjectTransfer(environment, identity.instanceScope, identity.externalId);
  if (adapter.getCredentials) return createS3ObjectClient(await adapter.getCredentials(environment, identity.instanceScope, identity.externalId));
  throw new Error('Backup storage does not support verified object streams.');
}
