import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EngineConfiguration } from '../../../../domain/ports/infrastructure-engine.port.js';
import type { TransferSlotEvidence } from '../gcp-transfer-slot-evidence.js';

export interface TransferSlotTarget {
  projectId: string;
  sourceEnvironmentId: string;
  sourceRailwayProjectId: string;
  sourceRailwayEnvironmentId: string;
  targetRegion: string;
  targetEnvironmentId: string;
}
export function transferSlot(target: TransferSlotTarget) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        target.projectId,
        target.targetRegion,
        target.sourceEnvironmentId,
        target.sourceRailwayProjectId,
        target.sourceRailwayEnvironmentId,
        target.targetEnvironmentId,
      ]),
    )
    .digest('hex')
    .slice(0, 20);
  const accountId = 'hv-copy-' + hash,
    secretId = 'hv-transfer-' + hash;
  const accountEmail = accountId + '@' + target.projectId + '.iam.gserviceaccount.com';
  const key = 'transfer_' + hash;
  const account = 'google_service_account.' + key,
    secret = 'google_secret_manager_secret.' + key,
    grant = 'google_secret_manager_secret_iam_member.' + key;
  const labels = { 'managed-by': 'hypervibe', 'hv-transfer': hash, 'hv-purpose': 'railway-copy' };
  const description = 'Hypervibe Railway copy ' + hash;
  const role = 'roles/secretmanager.secretAccessor',
    member = 'serviceAccount:' + accountEmail;
  const configuration: EngineConfiguration = {
    files: {
      ['transfer-' + hash + '.tf.json']: {
        resource: {
          google_service_account: {
            [key]: {
              project: target.projectId,
              account_id: accountId,
              display_name: 'Hypervibe copy job',
              description,
              lifecycle: { prevent_destroy: true },
            },
          },
          google_secret_manager_secret: {
            [key]: {
              project: target.projectId,
              secret_id: secretId,
              labels,
              replication: [{ auto: [{}] }],
              deletion_protection: true,
              lifecycle: { prevent_destroy: true },
            },
          },
          google_secret_manager_secret_iam_member: {
            [key]: { project: target.projectId, secret_id: secretId, role, member, depends_on: [account, secret] },
          },
        },
      },
    },
    resources: {
      [account]: {
        actionId: 'transfer-slot:account:' + hash,
        kind: 'project',
        name: 'Copy-job service account · ' + accountEmail,
        requiresConfirm: true,
      },
      [secret]: {
        actionId: 'transfer-slot:secret:' + hash,
        kind: 'secret',
        name: 'Empty migration secret container · ' + secretId,
        dataBearing: true,
        requiresConfirm: true,
      },
      [grant]: {
        actionId: 'transfer-slot:read:' + hash,
        kind: 'project',
        name: 'Allow the copy-job account to read ' + secretId,
        requiresConfirm: true,
      },
    },
  };
  return {
    id: 'transfer-' + hash,
    configuration,
    target,
    accountEmail,
    accountId,
    secretId,
    addresses: { account, secret, grant },
    labels,
    description,
    member,
    role,
  };
}
type Slot = ReturnType<typeof transferSlot>;
export interface TransferSlotReview {
  target: TransferSlotTarget;
  evidence: TransferSlotEvidence;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function exists(address: string, slot: Slot, evidence: TransferSlotEvidence) {
  if (address === slot.addresses.account) return !!evidence.account;
  if (address === slot.addresses.secret) return !!evidence.secret;
  return evidence.directAccessor;
}
function emptySetting(value: unknown): boolean {
  return value == null || value === '' || isDeepStrictEqual(value, []) || isDeepStrictEqual(value, {});
}
function onlyAutomaticReplication(value: unknown): boolean {
  return (
    isDeepStrictEqual(value, [{ auto: [{}] }]) ||
    isDeepStrictEqual(value, [{ auto: [{ customer_managed_encryption: [] }], user_managed: [] }])
  );
}
function matchesResource(address: string, raw: unknown, slot: Slot, evidence: TransferSlotEvidence, existing: boolean) {
  const value = record(raw);
  if (!value || value.project !== slot.target.projectId) return false;
  if (address === slot.addresses.account)
    return (
      value.account_id === slot.accountId &&
      value.description === slot.description &&
      value.disabled !== true &&
      value.create_ignore_already_exists !== true &&
      (!existing || (value.email === slot.accountEmail && value.unique_id === evidence.account?.uniqueId))
    );
  if (address === slot.addresses.secret)
    return (
      value.secret_id === slot.secretId &&
      isDeepStrictEqual(value.labels, slot.labels) &&
      value.deletion_protection === true &&
      onlyAutomaticReplication(value.replication) &&
      [
        'rotation',
        'topics',
        'ttl',
        'expire_time',
        'version_destroy_ttl',
        'tags',
        'version_aliases',
        'annotations',
        'secret_type',
      ].every((field) => emptySetting(value[field])) &&
      (!existing || value.create_time === evidence.secret?.createTime)
    );
  return (
    address === slot.addresses.grant &&
    [
      slot.secretId,
      'projects/' + slot.target.projectId + '/secrets/' + slot.secretId,
      'projects/' + evidence.projectNumber + '/secrets/' + slot.secretId,
    ].includes(String(value.secret_id)) &&
    value.member === slot.member &&
    value.role === slot.role &&
    (value.condition == null || isDeepStrictEqual(value.condition, []))
  );
}
/** Require the already-owned native secret, including its original creation time and configuration. */
export function matchesExistingTransferSecret(slot: Slot, evidence: TransferSlotEvidence, value: unknown): boolean {
  return !!evidence.secret && matchesResource(slot.addresses.secret, value, slot, evidence, true);
}
function validRow(row: Record<string, unknown>, address: string) {
  return (
    row.mode === 'managed' &&
    row.provider_name === 'registry.opentofu.org/hashicorp/google' &&
    row.type === address.split('.')[0] &&
    !('index' in row) &&
    !row.tainted &&
    !row.deposed &&
    !row.deposed_key &&
    !row.previous_address
  );
}
export function verifyTransferSlotPlan(document: unknown, slot: Slot, evidence: TransferSlotEvidence): boolean {
  const plan = record(document),
    rows = plan?.resource_changes;
  if (
    !Array.isArray(rows) ||
    plan?.errored === true ||
    plan?.complete === false ||
    (plan?.deferred_changes !== undefined && !isDeepStrictEqual(plan.deferred_changes, []))
  )
    return false;
  const remaining = new Set(Object.values(slot.addresses));
  for (const raw of rows) {
    const row = record(raw),
      change = record(row?.change);
    if (!row || !change || typeof row.address !== 'string' || row.previous_address || change.importing || row.deposed)
      return false;
    const address = row.address;
    if (!Object.hasOwn(slot.configuration.resources, address)) {
      if (!isDeepStrictEqual(change.actions, ['no-op'])) return false;
      continue;
    }
    const present = exists(address, slot, evidence);
    if (
      !remaining.delete(address) ||
      !validRow(row, address) ||
      !isDeepStrictEqual(change.actions, present ? ['no-op'] : ['create']) ||
      (!present && change.before !== null) ||
      !matchesResource(address, change.after, slot, evidence, present)
    )
      return false;
  }
  return remaining.size === 0;
}

/** Use persisted, unrefreshed native identities: matching names in refreshed plans cannot prove ownership. */
export function matchesTransferState(document: unknown, slot: Slot, evidence: TransferSlotEvidence): boolean {
  const rows = record(record(record(document)?.values)?.root_module)?.resources;
  if (!Array.isArray(rows)) return false;
  for (const address of Object.values(slot.addresses)) {
    const matches = rows.map(record).filter((row) => row?.address === address);
    if (matches.length !== Number(exists(address, slot, evidence))) return false;
    const row = matches[0];
    if (row && (!validRow(row, address) || !matchesResource(address, row.values, slot, evidence, true))) return false;
  }
  return true;
}
