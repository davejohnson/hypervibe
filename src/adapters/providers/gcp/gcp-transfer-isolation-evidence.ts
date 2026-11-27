import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { railwayExportPrefix } from '../../../domain/services/railway-export-prefix.js';
import { GcpBootstrapClient } from './gcp-bootstrap.client.js';
import { TransferEvidenceError, type TransferSlotEvidence } from './gcp-transfer-slot-evidence.js';
import { transferSlot, type TransferSlotTarget } from './tofu/transfer-slot.js';
import { isolationGrants, isolationRecoveryRequired, type TransferIsolationEvidence, type TransferIsolationScope } from './tofu/transfer-isolation.js';
import { backupStorageRole, unpackBackupCondition } from './tofu/backup-archive-access.js';

function reject(reason: string): never { throw new TransferEvidenceError(reason); }

const condition = z.strictObject({
  title: z.string().min(1), expression: z.string().min(1), description: z.string().optional(), location: z.string().optional(),
});
const binding = z.strictObject({
  role: z.string().min(1), members: z.array(z.string().min(1)).min(1), condition: condition.optional(),
});
const policy = z.strictObject({
  version: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(),
  bindings: z.array(binding).default([]), etag: z.string().min(1).optional(),
});
type Binding = z.infer<typeof binding>;
const projectPolicy = policy.extend({ auditConfigs: z.array(z.unknown()).optional() });
const bucketPolicy = policy.extend({ kind: z.literal('storage#policy'), resourceId: z.string().min(1) });
const bucketMetadata = z.object({
  name: z.string(), projectNumber: z.string(), timeCreated: z.iso.datetime({ offset: true }),
  hierarchicalNamespace: z.object({ enabled: z.literal(false) }).optional(),
  location: z.literal('US'), labels: z.object({ 'managed-by': z.literal('hypervibe') }),
  iamConfiguration: z.object({ publicAccessPrevention: z.literal('enforced'), uniformBucketLevelAccess: z.object({ enabled: z.literal(true) }) }),
});
const roleMetadata = z.object({
  name: z.string(), includedPermissions: z.array(z.string().min(1)), deleted: z.literal(false).optional(),
});
const numericId = /^[1-9][0-9]*$/;
const accountIdPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

interface Target {
  target: TransferSlotTarget;
  targetEnvironmentName: string;
  runtimeEmail: string;
  slotEvidence: TransferSlotEvidence;
}

function requireOwnedSlot({ target, runtimeEmail, slotEvidence }: Target) {
  const expected = transferSlot(target);
  const { projectNumber, account, secret, directAccessor } = slotEvidence;
  if (!numericId.test(projectNumber) || !account || !numericId.test(account.uniqueId) || !secret || !directAccessor
      || runtimeEmail === expected.accountEmail || account.email !== expected.accountEmail
      || account.name !== 'projects/' + target.projectId + '/serviceAccounts/' + expected.accountEmail
      || account.description !== expected.description || secret.name !== 'projects/' + projectNumber + '/secrets/' + expected.secretId
      || !z.iso.datetime({ offset: true }).safeParse(secret.createTime).success
      || !Object.entries(expected.labels).every(([key, value]) => secret.labels[key] === value)) {
    reject('The prepared copy account, its empty transfer secret and its exact direct grant must match the selected migration.');
  }
  return { projectNumber, copyUniqueId: account.uniqueId, secretCreateTime: secret.createTime };
}

function validatePolicyVersion(observed: z.infer<typeof policy>) {
  if (observed.bindings.some(b => b.role.includes('_withcond_') || (b.condition && observed.version !== 3))) {
    reject('Google did not return a complete version-aware IAM policy.');
  }
}

function includesRuntimeOrPublic(member: string, scope: TransferIsolationScope): boolean {
  if (member === 'serviceAccount:' + scope.runtimeEmail || member === 'allUsers' || member === 'allAuthenticatedUsers') return true;
  if (member === 'principal://iam.googleapis.com/projects/-/serviceAccounts/' + scope.runtimeUniqueId) return true;
  // A folder/organization service-account set could contain this project's identity.
  const set = /^principalSet:\/\/cloudresourcemanager\.googleapis\.com\/(projects|folders|organizations)\/([^/]+)\/type\/ServiceAccount$/.exec(member);
  return !!set && (set[1] !== 'projects' || [scope.projectNumber, scope.target.projectId].includes(set[2]!));
}

function touchesTransfer(permission: string): boolean {
  if (permission === 'storage.objects.list') return false; // The reviewed project grant retains bucket listing.
  return permission === 'secretmanager.versions.access' || permission === 'secretmanager.secrets.setIamPolicy'
    || permission === 'storage.buckets.setIamPolicy' || permission === 'resourcemanager.projects.setIamPolicy'
    || permission === 'storage.managedFolders.setIamPolicy'
    || permission.startsWith('storage.objects.') || permission.startsWith('storage.multipartUploads.');
}

const missingFolder = Symbol('managed folder not found');
type ReadJson = (url: string, operation: string, mode?: 'projectPolicy' | 'folderMetadata') => Promise<unknown>;
const folderPage = z.strictObject({
  kind: z.literal('storage#managedFolders'), items: z.array(z.object({ name: z.string().min(1) })).optional(),
  nextPageToken: z.string().max(4096).optional(),
});

async function checkManagedFolders(bucketUrl: string, prefix: string, read: ReadJson) {
  // Each ancestor may carry an independent IAM policy that covers the export objects.
  for (let slash = prefix.indexOf('/'); slash < prefix.length - 1; slash = prefix.indexOf('/', slash + 1)) {
    const ancestor = encodeURIComponent(prefix.slice(0, slash + 1));
    const found = await read(bucketUrl + '/managedFolders/' + ancestor, 'parent managed folder', 'folderMetadata');
    if (found !== missingFolder) reject('A managed folder above the export prefix requires a separate IAM review.');
  }
  const url = new URL(bucketUrl + '/managedFolders');
  url.searchParams.set('prefix', prefix);
  // This endpoint rejects partial-response field masks. Filter on the server by prefix and stop on the first folder.
  url.searchParams.set('maxResults', '1');
  const pages = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const parsed = folderPage.safeParse(await read(url.href, 'managed folders beneath the export prefix'));
    if (!parsed.success) reject('Google returned an incomplete managed-folder inventory.');
    if (parsed.data.items?.length) reject('A managed folder within the export prefix requires a separate IAM review.');
    const token = parsed.data.nextPageToken;
    if (!token) return;
    if (pages.has(token)) reject('Google returned a repeated page in the managed-folder inventory.');
    pages.add(token);
    url.searchParams.set('pageToken', token);
  }
  reject('Google did not finish the managed-folder inventory within the page limit.');
}


async function inspectProjectBindings(bindings: Binding[], scope: TransferIsolationScope, read: ReadJson): Promise<TransferIsolationEvidence['grants']> {
  const expected = isolationGrants(scope);
  const states: TransferIsolationEvidence['grants'] = {};
  const otherRoles = new Set<string>();
  for (const b of bindings) {
    const relevant = b.members.filter(member => includesRuntimeOrPublic(member, scope));
    if (relevant.length === 0) continue;
    const grant = expected.find(g => g.role === b.role);
    if (!grant) {
      otherRoles.add(b.role);
      continue;
    }
    const baseCondition = b.role === backupStorageRole ? unpackBackupCondition(b.condition).base : b.condition;
    const state = baseCondition ? 'restricted' : 'broad';
    const previous = states[b.role];
    if (relevant.length !== 1 || relevant[0] !== grant.member || previous === state || (baseCondition && !isDeepStrictEqual(baseCondition, grant.condition))) {
      reject('The runtime has an additional or unrecognized project grant for the transfer secret or dump objects. Review the direct policy before changing it.');
    }
    if (previous) reject('Google still lists both the broad and restricted versions of the same app grant. ' + isolationRecoveryRequired);
    states[b.role] = state;
  }
  if (!expected.every(g => states[g.role])) reject('Google could not identify both existing runtime project grants.');

  for (const role of otherRoles) {
    if (!/^(?:(?:projects\/[a-z0-9-]+|organizations\/[0-9]+)\/)?roles\/[A-Za-z0-9._]+$/.test(role)) {
      reject('A direct project role could not be identified.');
    }
    const details = roleMetadata.safeParse(await read('https://iam.googleapis.com/v1/' + role + '?fields=name,includedPermissions,deleted', 'project role permissions'));
    if (!details.success || details.data.name !== role) reject('The permissions of a direct project role could not be verified.');
    if (['roles/owner', 'roles/editor', 'roles/viewer'].includes(role) || details.data.includedPermissions.some(touchesTransfer)) {
      reject('An additional direct project role can grant access to the transfer resources. Review it before changing the runtime grants.');
    }
  }
  return states;
}

function policyFingerprint(bindings: Binding[]) {
  return bindings.map(b => JSON.stringify([b.role, [...b.members].sort(), b.condition?.title, b.condition?.description,
    b.condition?.expression, b.condition?.location])).sort();
}

/** Direct project/bucket evidence; group membership, inherited access and live access decisions require separate verification. */
export async function readTransferIsolationEvidence(token: string, input: Target): Promise<TransferIsolationEvidence> {
  const { target, targetEnvironmentName, runtimeEmail, slotEvidence } = input;
  const { projectId } = target;
  const accountId = runtimeEmail.split('@')[0]!;
  if (!token.trim() || !accountIdPattern.test(projectId) || !accountIdPattern.test(accountId) || runtimeEmail !== accountId + '@' + projectId + '.iam.gserviceaccount.com') {
    reject('Select the original runtime service account from the transfer project.');
  }
  const identity = requireOwnedSlot(input);
  const bucket = projectId + '-hv-build-source';
  const signal = AbortSignal.timeout(60_000);
  const read: ReadJson = async (url, operation, mode) => {
    const post = mode === 'projectPolicy';
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + token, ...(post ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal,
      ...(post ? { method: 'POST', body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }) } : {}),
    });
    if (mode === 'folderMetadata' && response.status === 404) return missingFolder;
    if (!response.ok) reject('Google could not verify ' + operation + ' for runtime isolation.');
    return response.json();
  };

  try {
    const client = new GcpBootstrapClient({ accessToken: token, fetch: (url, init) => fetch(url, { ...init, signal, redirect: 'error' }),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    const bucketUrl = 'https://storage.googleapis.com/storage/v1/b/' + bucket;
    const [account, metadata, projectIam, bucketIam] = await Promise.all([
      client.getServiceAccount(projectId, accountId),
      read(bucketUrl + '?fields=name,projectNumber,timeCreated,location,labels,iamConfiguration,hierarchicalNamespace', 'managed build bucket'),
      read('https://cloudresourcemanager.googleapis.com/v3/projects/' + identity.projectNumber + ':getIamPolicy', 'direct project IAM policy', 'projectPolicy'),
      read(bucketUrl + '/iam?optionsRequestedPolicyVersion=3', 'direct build bucket IAM policy'),
    ]);
    if (!account || account.disabled || account.uniqueId === identity.copyUniqueId) reject('The original runtime service account is missing, disabled or shared with the copy job.');
    const observed = bucketMetadata.safeParse(metadata);
    if (!observed.success || observed.data.name !== bucket || observed.data.projectNumber !== identity.projectNumber) {
      reject('The managed build bucket must belong to the selected project and use a flat namespace with uniform private access.');
    }
    const scope = { target, targetEnvironmentName, ...identity, runtimeEmail, runtimeUniqueId: account.uniqueId, bucket, bucketTimeCreated: observed.data.timeCreated };
    const projectBindings = projectPolicy.safeParse(projectIam);
    const bucketBindings = bucketPolicy.safeParse(bucketIam);
    if (!projectBindings.success || !bucketBindings.success || bucketBindings.data.resourceId !== 'projects/_/buckets/' + bucket) {
      reject('Google did not return complete direct project and build bucket IAM policies for these resources.');
    }
    validatePolicyVersion(projectBindings.data);
    validatePolicyVersion(bucketBindings.data);
    if (bucketBindings.data.bindings.some(b => b.members.some(member => includesRuntimeOrPublic(member, scope)))) {
      reject('A direct build bucket grant includes the runtime, a service-account set or a public principal. Review that access separately.');
    }
    await checkManagedFolders(bucketUrl, railwayExportPrefix(targetEnvironmentName), read);
    const grants = await inspectProjectBindings(projectBindings.data.bindings, scope, read);
    // Project member status is compared separately so an expected apply does not invalidate identity evidence.
    const evidenceDigest = createHash('sha256').update(JSON.stringify([
      projectId, target.sourceEnvironmentId, target.sourceRailwayProjectId, target.sourceRailwayEnvironmentId, target.targetEnvironmentId,
      target.targetRegion, targetEnvironmentName, scope.projectNumber, runtimeEmail, scope.runtimeUniqueId, scope.copyUniqueId, scope.secretCreateTime,
      bucket, scope.bucketTimeCreated, policyFingerprint(bucketBindings.data.bindings),
    ])).digest('hex');
    return { slot: slotEvidence, scope, grants, evidenceDigest };
  } catch (error) {
    if (error instanceof TransferEvidenceError) throw error;
    throw new TransferEvidenceError('Google could not verify the runtime identity and direct project and bucket access. Preview again with metadata and IAM read access.');
  }
}
