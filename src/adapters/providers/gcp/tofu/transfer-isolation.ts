import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import { railwayExportPrefix } from '../../../../domain/services/railway-export-prefix.js';
import type { TransferSlotEvidence } from '../gcp-transfer-slot-evidence.js';
import { projectIamAddress } from './gcp-setup.backend.js';
import { matchesExistingTransferSecret, matchesTransferState, transferSlot } from './transfer-slot.js';

const identifier = z.string().min(1).max(256);
const numberId = z.string().regex(/^[1-9][0-9]*$/);
const scopeSchema = z.strictObject({
  target: z.strictObject({
    projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    targetRegion: identifier,
    sourceEnvironmentId: identifier,
    sourceRailwayProjectId: identifier,
    sourceRailwayEnvironmentId: identifier,
    targetEnvironmentId: identifier,
  }),
  targetEnvironmentName: identifier,
  projectNumber: numberId,
  runtimeEmail: z.email(),
  runtimeUniqueId: numberId,
  bucket: identifier,
  bucketTimeCreated: z.iso.datetime({ offset: true }),
  copyUniqueId: numberId,
  secretCreateTime: z.iso.datetime({ offset: true }),
});

export type TransferIsolationScope = z.infer<typeof scopeSchema>;
export interface TransferIsolationEvidence {
  slot: TransferSlotEvidence;
  scope: TransferIsolationScope;
  grants: Record<string, 'broad' | 'restricted'>;
  evidenceDigest: string;
}

const isolationPrefix = 'transfer-isolation-';
const memberType = 'google_project_iam_member';
const provider = 'registry.opentofu.org/hashicorp/google';
type Contributions = Record<string, EngineConfiguration>;
const invalid = () =>
  new Error(
    'The saved transfer isolation does not match the original project resources. Preview the original transfer setup again.',
  );
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function markerId(runtimeEmail: string) {
  return isolationPrefix + createHash('sha256').update(runtimeEmail).digest('hex').slice(0, 20);
}
export function isolationGrants(scope: TransferIsolationScope) {
  const slot = transferSlot(scope.target);
  const member = 'serviceAccount:' + scope.runtimeEmail;
  const secret = 'projects/' + scope.projectNumber + '/secrets/' + slot.secretId;
  const prefix = railwayExportPrefix(scope.targetEnvironmentName);
  const objects = 'projects/_/buckets/' + scope.bucket + '/objects/' + prefix;
  const grants = [
    {
      role: 'roles/secretmanager.secretAccessor',
      name: 'Exclude the Railway copy secret ' + slot.secretId + ' from app access',
      expression:
        '(resource.type != "secretmanager.googleapis.com/Secret" && resource.type != "secretmanager.googleapis.com/SecretVersion") || (resource.name != ' +
        JSON.stringify(secret) +
        ' && !resource.name.startsWith(' +
        JSON.stringify(secret + '/versions/') +
        '))',
      title: 'hv-copy-secret-' + slot.id.slice('transfer-'.length),
      description: 'Keep the app runtime out of the Railway copy secret and its versions.',
    },
    {
      role: 'roles/storage.objectUser',
      name: 'Exclude temporary database exports in gs://' + scope.bucket + '/' + prefix + ' from app object access',
      expression:
        'resource.type != "storage.googleapis.com/Object" || !resource.name.startsWith(' +
        JSON.stringify(objects) +
        ')',
      title: 'hv-copy-exports-' + slot.id.slice('transfer-'.length),
      description: 'Keep the app runtime out of temporary database export objects. Bucket listing stays available.',
    },
  ];
  return grants.map(({ role, name, title, expression, description }) => ({
    address: projectIamAddress(member, role),
    member,
    role,
    name,
    condition: { title, expression, description },
  }));
}

export function transferIsolationContribution(scope: TransferIsolationScope) {
  scopeSchema.parse(scope);
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(scope.runtimeEmail.split('@')[0]!) ||
    !scope.runtimeEmail.endsWith('@' + scope.target.projectId + '.iam.gserviceaccount.com') ||
    scope.runtimeEmail === transferSlot(scope.target).accountEmail ||
    scope.runtimeUniqueId === scope.copyUniqueId ||
    scope.bucket !== scope.target.projectId + '-hv-build-source'
  )
    throw invalid();
  const id = markerId(scope.runtimeEmail);
  const resources: EngineConfiguration['resources'] = {};
  const members: Record<string, unknown> = {};
  for (const { address, member, role, condition } of isolationGrants(scope)) {
    const name = address.split('.')[1]!;
    // Bootstrap and preparation can both own this address. Compose one native
    // definition by overlaying the condition on those identical members.
    members[name] = {
      project: scope.target.projectId,
      member,
      role,
      condition: [condition],
      lifecycle: { create_before_destroy: true },
    };
    resources[address] = {
      actionId: 'project-setup:' + memberType + ':' + name,
      kind: 'project',
      name: member + ' ' + role,
      requiresConfirm: true,
    };
  }
  const configuration: EngineConfiguration = {
    files: {
      [id + '.tf.json']: { locals: { [id.replaceAll('-', '_')]: scope } },
      'project-setup.tf.json': { resource: { [memberType]: members } },
    },
    resources,
  };
  return { id, configuration };
}

export function retainedIsolations(contributions: Contributions, projectId: string) {
  const scopes: TransferIsolationScope[] = [];
  for (const [id, configuration] of Object.entries(contributions)) {
    if (!id.startsWith(isolationPrefix)) continue;
    const raw = record(record(configuration.files[id + '.tf.json'])?.locals)?.[id.replaceAll('-', '_')];
    const parsed = scopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.target.projectId !== projectId) throw invalid();
    const expected = transferIsolationContribution(parsed.data);
    if (id !== expected.id || !equal(configuration, expected.configuration)) throw invalid();
    scopes.push(parsed.data);
  }
  return scopes;
}

export const isIsolationContribution = (id: string) => id.startsWith(isolationPrefix);

export function assertIsolationReview(
  contributions: Contributions,
  submitted: { id: string; configuration: EngineConfiguration },
  projectId: string,
  evidence: TransferIsolationEvidence,
) {
  const { scope, slot: live, grants } = evidence;
  const marker = transferIsolationContribution(scope);
  const slot = transferSlot(scope.target);
  if (
    projectId !== scope.target.projectId ||
    !equal(submitted, marker) ||
    !equal(contributions[slot.id], slot.configuration) ||
    !/^[a-f0-9]{64}$/.test(evidence.evidenceDigest) ||
    live.projectNumber !== scope.projectNumber ||
    live.directAccessor !== true ||
    live.account?.email !== slot.accountEmail ||
    live.account.uniqueId !== scope.copyUniqueId ||
    live.account.description !== slot.description ||
    live.account.name !== 'projects/' + projectId + '/serviceAccounts/' + slot.accountEmail ||
    live.secret?.name !== 'projects/' + scope.projectNumber + '/secrets/' + slot.secretId ||
    live.secret.createTime !== scope.secretCreateTime ||
    !Object.entries(slot.labels).every(([k, v]) => live.secret?.labels[k] === v)
  )
    throw invalid();
  const previous = contributions[marker.id];
  if (previous && !equal(previous, marker.configuration)) throw invalid();
  if (
    Object.keys(grants).length !== 2 ||
    !isolationGrants(scope).every(
      ({ role }) => ['broad', 'restricted'].includes(grants[role] ?? '') && (previous || grants[role] === 'broad'),
    )
  )
    throw invalid();
  assertOriginalIsolationOwners(contributions, scope);
}

/** Only the durable overlay may supply the condition; reject a second resource for the same broad member. */
export function assertOriginalIsolationOwners(contributions: Contributions, scope: TransferIsolationScope) {
  const projectId = scope.target.projectId;
  const marker = transferIsolationContribution(scope);
  const slot = transferSlot(scope.target);
  if (!equal(contributions[slot.id], slot.configuration)) throw invalid();
  for (const grant of isolationGrants(scope)) {
    let owners = 0;
    for (const [id, config] of Object.entries(contributions)) {
      if (id === marker.id) continue;
      if (Object.values(slot.addresses).some((address) => id !== slot.id && Object.hasOwn(config.resources, address)))
        throw invalid();
      let found = false;
      for (const doc of Object.values(config.files)) {
        const members = record(record(record(doc)?.resource)?.[memberType]);
        for (const [key, raw] of Object.entries(members ?? {})) {
          const definition = record(raw);
          const address = memberType + '.' + key;
          if (address !== grant.address && (definition?.member !== grant.member || definition.role !== grant.role))
            continue;
          if (
            found ||
            address !== grant.address ||
            !definition ||
            definition.project !== projectId ||
            definition.member !== grant.member ||
            definition.role !== grant.role ||
            Object.keys(definition).some((k) => !['project', 'member', 'role', 'depends_on'].includes(k)) ||
            !Object.hasOwn(config.resources, address) ||
            Object.hasOwn(config.imports ?? {}, address)
          )
            throw invalid();
          found = true;
        }
      }
      if (Object.hasOwn(config.resources, grant.address) !== found) throw invalid();
      if (found) owners++;
    }
    if (!owners) throw invalid();
  }
}

export const isolationRecoveryRequired =
  'The broad grant may still let the app read transfer data. Keep the transfer secret empty and pause the copy. Request recovery of this grant through Hypervibe’s managed Google Cloud setup, then preview the app restrictions again.';

export function hasDeposedIsolationGrant(document: unknown, scope: TransferIsolationScope): boolean {
  const root = record(document);
  const rows = root?.resource_changes ?? record(record(root?.values)?.root_module)?.resources;
  if (!Array.isArray(rows)) return false;
  const grants = new Set(isolationGrants(scope).map((grant) => grant.address));
  return rows.some((raw) => {
    const row = record(raw);
    return (
      row?.mode === 'managed' &&
      row.provider_name === provider &&
      row.type === memberType &&
      typeof row.address === 'string' &&
      grants.has(row.address) &&
      [row.deposed, row.deposed_key].some((key) => typeof key === 'string' && key.length > 0)
    );
  });
}

type Grant = ReturnType<typeof isolationGrants>[number];
function validMember(raw: unknown, grant: Grant, scope: TransferIsolationScope, status: 'broad' | 'restricted') {
  const value = record(raw);
  return (
    !!value &&
    value.project === scope.target.projectId &&
    value.member === grant.member &&
    value.role === grant.role &&
    equal(value.condition, status === 'restricted' ? [grant.condition] : []) &&
    Object.keys(value).every((key) => ['project', 'member', 'role', 'condition', 'etag', 'id'].includes(key))
  );
}
function validRow(row: Record<string, unknown>, type: string) {
  return (
    row.mode === 'managed' &&
    row.provider_name === provider &&
    row.type === type &&
    !('index' in row) &&
    !row.module_address &&
    !row.tainted &&
    !row.deposed &&
    !row.deposed_key &&
    !row.previous_address
  );
}

/** The Google provider can refresh absent map attributes as empty objects. Accept this only
 * on the original transfer secret when the saved plan separately leaves that exact value unchanged. */
function verifiedSecretRefresh(
  plan: Record<string, unknown>,
  changes: unknown[],
  evidence: TransferIsolationEvidence,
): boolean {
  const drift = plan.resource_drift;
  if (drift === undefined || equal(drift, [])) return true;
  if (!Array.isArray(drift) || drift.length !== 1) return false;
  const slot = transferSlot(evidence.scope.target);
  const row = record(drift[0]);
  const change = record(row?.change);
  if (
    !row ||
    row.address !== slot.addresses.secret ||
    !validRow(row, 'google_secret_manager_secret') ||
    !change ||
    !equal(change.actions, ['update']) ||
    change.importing ||
    change.forget
  )
    return false;
  const before = record(change.before);
  const after = record(change.after);
  if (
    !before ||
    !after ||
    !matchesExistingTransferSecret(slot, evidence.slot, before) ||
    !matchesExistingTransferSecret(slot, evidence.slot, after)
  )
    return false;
  const { annotations: oldAnnotations, version_aliases: oldAliases, ...oldIdentity } = before;
  const { annotations: newAnnotations, version_aliases: newAliases, ...newIdentity } = after;
  if (
    ![oldAnnotations, newAnnotations, oldAliases, newAliases].every((value) => value == null || equal(value, {})) ||
    !equal(oldIdentity, newIdentity)
  )
    return false;
  const matching = changes.map(record).filter((candidate) => candidate?.address === row.address);
  const noop = matching[0];
  const saved = record(noop?.change);
  return (
    matching.length === 1 &&
    !!noop &&
    validRow(noop, 'google_secret_manager_secret') &&
    !!saved &&
    equal(saved.actions, ['no-op']) &&
    equal(saved.before, after) &&
    equal(saved.after, after)
  );
}

export function verifyIsolationPlan(document: unknown, evidence: TransferIsolationEvidence) {
  const plan = record(document);
  if (
    !Array.isArray(plan?.resource_changes) ||
    plan.errored === true ||
    plan.complete === false ||
    !equal(plan.deferred_changes ?? [], []) ||
    !verifiedSecretRefresh(plan, plan.resource_changes, evidence)
  )
    return false;
  const required = new Map(isolationGrants(evidence.scope).map((grant) => [grant.address, grant]));
  const seen = new Set<string>();
  for (const raw of plan.resource_changes) {
    const row = record(raw),
      change = record(row?.change);
    if (
      !row ||
      !change ||
      typeof row.address !== 'string' ||
      seen.has(row.address) ||
      row.previous_address ||
      row.deposed ||
      row.deposed_key ||
      change.importing ||
      change.forget ||
      row.tainted
    )
      return false;
    seen.add(row.address);
    const grant = required.get(row.address);
    if (!grant) {
      if (!equal(change.actions, ['no-op'])) return false;
      continue;
    }
    required.delete(row.address);
    const beforeStatus = evidence.grants[grant.role];
    if (
      !beforeStatus ||
      !validRow(row, memberType) ||
      !validMember(change.before, grant, evidence.scope, beforeStatus) ||
      !validMember(change.after, grant, evidence.scope, 'restricted')
    )
      return false;
    const unknown = record(change.after_unknown);
    if (change.after_unknown !== undefined && !unknown) return false;
    if (
      unknown &&
      (!Object.keys(unknown).every((key) => ['id', 'etag', 'condition'].includes(key)) ||
        (!equal(unknown.condition ?? [], []) && !equal(unknown.condition, [{}])))
    )
      return false;
    if (beforeStatus === 'restricted') {
      if (!equal(change.actions, ['no-op'])) return false;
    } else if (
      !equal(change.actions, ['create', 'delete']) ||
      row.action_reason !== 'replace_because_cannot_update' ||
      !Array.isArray(change.replace_paths) ||
      !change.replace_paths.length ||
      !change.replace_paths.every((path) => Array.isArray(path) && path[0] === 'condition')
    )
      return false;
  }
  return required.size === 0;
}

export function matchesIsolationState(document: unknown, evidence: TransferIsolationEvidence) {
  const { scope, slot: live } = evidence;
  if (!matchesTransferState(document, transferSlot(scope.target), live)) return false;
  const rows = record(record(record(document)?.values)?.root_module)?.resources;
  if (!Array.isArray(rows)) return false;
  const lookup = (address: string, type: string) => {
    const selected = rows.map(record).filter((row) => row?.address === address);
    return selected.length === 1 && selected[0] && validRow(selected[0], type) ? record(selected[0].values) : undefined;
  };
  const runtime = lookup('google_service_account.runtime', 'google_service_account');
  const bucket = lookup('google_storage_bucket.build_source', 'google_storage_bucket');
  if (
    runtime?.email !== scope.runtimeEmail ||
    runtime.unique_id !== scope.runtimeUniqueId ||
    runtime.project !== scope.target.projectId ||
    runtime.disabled === true ||
    bucket?.name !== scope.bucket ||
    bucket.project !== scope.target.projectId ||
    String(bucket.project_number) !== scope.projectNumber ||
    bucket.time_created !== scope.bucketTimeCreated
  )
    return false;
  return isolationGrants(scope).every((grant) =>
    validMember(lookup(grant.address, memberType), grant, scope, evidence.grants[grant.role]!),
  );
}
