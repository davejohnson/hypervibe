import { afterEach, describe, expect, it, vi } from 'vitest';
import { transferSlot } from '../tofu/transfer-slot.js';
import { isolationGrants } from '../tofu/transfer-isolation.js';
import { readTransferIsolationEvidence } from '../gcp-transfer-isolation-evidence.js';

// Reconstructed REST fixtures from:
// https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/getIamPolicy
// https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/getIamPolicy
// https://docs.cloud.google.com/storage/docs/json_api/v1/buckets
// https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/get
// https://docs.cloud.google.com/iam/docs/reference/rest/v1/roles/get
// https://docs.cloud.google.com/storage/docs/json_api/v1/managedFolder/list
// https://docs.cloud.google.com/storage/docs/json_api/v1/folders/rename
const projectId = 'transfer-project';
const projectNumber = '123456789012';
const target = { projectId, sourceEnvironmentId: 'source', sourceRailwayProjectId: 'rail-project',
  sourceRailwayEnvironmentId: 'rail-stage', targetRegion: 'us-central1', targetEnvironmentId: 'target' };
const slot = transferSlot(target);
const runtimeEmail = 'app-reader@' + projectId + '.iam.gserviceaccount.com';
const member = 'serviceAccount:' + runtimeEmail;
const runtimeUniqueId = '123456789012345678901';
const copyUniqueId = '123456789012345678902';
const bucket = projectId + '-hv-build-source';
const created = '2026-09-06T13:58:15.123Z';
const input = { target, targetEnvironmentName: 'staging', runtimeEmail, slotEvidence: {
  projectNumber, directAccessor: true,
  account: { name: 'projects/' + projectId + '/serviceAccounts/' + slot.accountEmail, email: slot.accountEmail,
    uniqueId: copyUniqueId, description: slot.description },
  secret: { name: 'projects/' + projectNumber + '/secrets/' + slot.secretId, createTime: created, labels: slot.labels },
} };
const account = { name: 'projects/' + projectId + '/serviceAccounts/' + runtimeEmail, email: runtimeEmail, projectId, uniqueId: runtimeUniqueId };
const metadata = { name: bucket, projectNumber, timeCreated: created, labels: { 'managed-by': 'hypervibe' }, location: 'US',
  iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' } };
const secretRole = 'roles/secretmanager.secretAccessor', storageRole = 'roles/storage.objectUser';
const other = 'serviceAccount:another@' + projectId + '.iam.gserviceaccount.com';
const broad = (role: string) => ({ role, members: [member, other] });
const broadGrants = [broad(secretRole), broad(storageRole)];
const scope = { target, targetEnvironmentName: 'staging', projectNumber, runtimeEmail, runtimeUniqueId,
  bucket, bucketTimeCreated: created, copyUniqueId, secretCreateTime: created };
const restrictedGrants = () => isolationGrants(scope).map(({ role, condition }) => ({ role, members: [member], condition }));
const bucketPolicy = { kind: 'storage#policy', resourceId: 'projects/_/buckets/' + bucket, version: 1, bindings: [
  { role: 'roles/storage.legacyBucketOwner', members: ['projectOwner:' + projectId, 'projectEditor:' + projectId] },
  { role: 'roles/storage.objectAdmin', members: [other] },
] };

function transport(options: { project?: unknown; bucket?: unknown; bucketPolicy?: unknown; account?: unknown; custom?: string[]; ancestorStatus?: number; folderPage?: (page: string | null) => Response } = {}) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input), path = decodeURIComponent(url.pathname);
    seen.push(path);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer example-token');
    expect(init.redirect).toBe('error');
    if (url.origin === 'https://cloudresourcemanager.googleapis.com' && path === '/v3/projects/' + projectNumber + ':getIamPolicy') {
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({ options: { requestedPolicyVersion: 3 } });
      return Response.json(options.project ?? { version: 1, bindings: broadGrants });
    }
    expect(init.method ?? 'GET').toBe('GET');
    if (url.origin === 'https://iam.googleapis.com' && path === '/v1/' + account.name) return Response.json(options.account ?? account);
    if (url.origin === 'https://iam.googleapis.com' && path === '/v1/projects/' + projectId + '/roles/custom') {
      return Response.json({ name: 'projects/' + projectId + '/roles/custom', includedPermissions: options.custom });
    }
    if (url.origin === 'https://storage.googleapis.com' && path === '/storage/v1/b/' + bucket) return Response.json(options.bucket ?? metadata);
    if (url.origin === 'https://storage.googleapis.com' && path === '/storage/v1/b/' + bucket + '/iam') {
      expect(url.searchParams.get('optionsRequestedPolicyVersion')).toBe('3');
      return Response.json(options.bucketPolicy ?? bucketPolicy);
    }
    if (url.origin === 'https://storage.googleapis.com' && path === '/storage/v1/b/' + bucket + '/managedFolders/migrations/') {
      return new Response(null, { status: options.ancestorStatus ?? 404 });
    }
    if (url.origin === 'https://storage.googleapis.com' && path === '/storage/v1/b/' + bucket + '/managedFolders') {
      expect(url.searchParams.get('prefix')).toBe('migrations/staging/');
      // The live JSON API rejects partial-response fields on this method, even fields in its discovery schema.
      if (url.searchParams.has('fields')) return Response.json({error: {code:400,
        message:'Invalid field selection kind', errors:[{reason:'invalidParameter'}]}}, {status:400});
      return options.folderPage?.(url.searchParams.get('pageToken')) ?? Response.json({ kind: 'storage#managedFolders' });
    }
    throw Error('Unexpected provider endpoint');
  });
  return seen;
}
const read = () => readTransferIsolationEvidence('example-token', input);
afterEach(() => vi.unstubAllGlobals());

describe('direct IAM evidence across the project and build bucket', () => {
  it('identifies the two exact shared project bindings from read-only version-aware APIs', async () => {
    const seen = transport();
    const result = await read();
    expect(result.scope).toEqual(scope);
    expect(result.grants).toEqual({ [secretRole]: 'broad', [storageRole]: 'broad' });
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(seen).toHaveLength(6);
  });

  it('accepts independent completed bindings and exact restrictions, without digesting policy etags or ordering', async () => {
    transport();
    const before = await read();
    const restricted = restrictedGrants();
    transport({ project: { version: 3, etag: 'after', bindings: [...restricted].reverse() },
      bucketPolicy: { ...bucketPolicy, etag: 'rotated', bindings: [...bucketPolicy.bindings].reverse() } });
    const after = await read();
    expect(after.grants).toEqual({ [secretRole]: 'restricted', [storageRole]: 'restricted' });
    expect(after.evidenceDigest).toBe(before.evidenceDigest);
    transport({ project: { version: 3, bindings: [broad(secretRole), restricted.find(b => b.role === storageRole)] } });
    expect((await read()).grants).toEqual({ [secretRole]: 'broad', [storageRole]: 'restricted' });
  });

  it.each([
    ['missing runtime grant', { version: 1, bindings: [broadGrants[0]] }],
    ['extra overlapping binding', { version: 3, bindings: [...broadGrants, { ...broad(secretRole), condition: { title: 'old', expression: 'true' } }] }],
    ['unrecognized condition', { version: 3, bindings: [broadGrants[0], { ...broad(storageRole), condition: { title: 'old', expression: 'true' } }] }],
    ['malformed discarded condition', { version: 3, bindings: [broadGrants[0], { ...broad(storageRole), conditions: [] }] }],
    ['extra public runtime permission', { version: 1, bindings: [...broadGrants, { role: storageRole, members: ['allAuthenticatedUsers'] }] }],
    ['partial policy envelope', { version: 1, bindings: broadGrants, nextPageToken: 'unseen' }],
  ])('rejects %s', async (_case, project) => {
    transport({ project });
    await expect(read()).rejects.toThrow();
  });

  it.each([false, true])('explains an interrupted grant replacement in either policy order (reversed=%s)', async reverse => {
    const overlap = [broad(secretRole), restrictedGrants().find(b => b.role === secretRole)!];
    transport({ project: { version: 3, bindings: [broad(storageRole), ...(reverse ? overlap.reverse() : overlap)] } });
    await expect(read()).rejects.toThrow(/both.*broad grant may still.*keep the transfer secret empty.*recover.*Hypervibe/i);
  });

  it('accepts independent bindings that apply only to other principals', async () => {
    transport({ project: { version: 3, bindings: [...broadGrants,
      { role: secretRole, members: [other], condition: { title: 'other', expression: 'true' } }] } });
    expect((await read()).grants[secretRole]).toBe('broad');
  });

  it('checks the permissions of other roles bound directly to the runtime rather than inferring them from a role name', async () => {
    const project = { version: 1, bindings: [...broadGrants, broad('projects/' + projectId + '/roles/custom')] };
    transport({ project, custom: ['storage.objects.get'] });
    await expect(read()).rejects.toThrow();
    transport({ project, custom: ['logging.logEntries.create', 'storage.objects.list', 'storage.managedFolders.list'] });
    expect((await read()).grants[secretRole]).toBe('broad');
  });

  it.each([
    ['account from another project', { account: { ...account, projectId: 'other-project' } }],
    ['disabled runtime account', { account: { ...account, disabled: true } }],
    ['shared copy identity', { account: { ...account, uniqueId: copyUniqueId } }],
    ['hierarchical namespace enables folder renames', { bucket: { ...metadata, hierarchicalNamespace: { enabled: true } } }],
    ['foreign bucket', { bucket: { ...metadata, projectNumber: '99999999' } }],
    ['legacy ACLs', { bucket: { ...metadata, iamConfiguration: { ...metadata.iamConfiguration, uniformBucketLevelAccess: { enabled: false } } } }],
    ['unenforced public prevention', { bucket: { ...metadata, iamConfiguration: { ...metadata.iamConfiguration, publicAccessPrevention: 'inherited' } } }],
    ['foreign bucket policy', { bucketPolicy: { ...bucketPolicy, resourceId: bucketPolicy.resourceId + '-other' } }],
    ['direct object read on bucket', { bucketPolicy: { ...bucketPolicy, bindings: [...bucketPolicy.bindings, broad(storageRole)] } }],
    ['public bucket role', { bucketPolicy: { ...bucketPolicy, bindings: [{ role: storageRole, members: ['allUsers'] }] } }],
  ])('blocks %s', async (_case, options) => {
    transport(options);
    await expect(read()).rejects.toThrow();
  });

  it.each([
    ['ancestor can have its own IAM', { ancestorStatus: 200 }],
    ['unreadable ancestor', { ancestorStatus: 403 }],
    ['unreadable folder listing', { folderPage: () => new Response(null, { status: 403 }) }],
    ['malformed response masquerading as an empty listing', { folderPage: () => Response.json({}) }],
    ['unrecognized collection', { folderPage: () => Response.json({kind:'storage#objects'}) }],
    ['repeated page', { folderPage: () => Response.json({kind:'storage#managedFolders',nextPageToken:'same'}) }],
    ['nested folder on a later page', { folderPage: (page: string | null) => Response.json(page
      ? { kind: 'storage#managedFolders', items:[{name:'migrations/staging/child/'}] }
      : { kind: 'storage#managedFolders', nextPageToken: 'a/==' }) }],
  ])('blocks %s without listing any dump objects', async (_case, options) => {
    const seen = transport(options);
    await expect(read()).rejects.toThrow();
    expect(seen.every(path => !path.endsWith('/o'))).toBe(true);
  });

  it('follows encoded managed-folder continuation tokens to verify a complete empty prefix', async () => {
    const seen = transport({folderPage: page => {
      if (page) expect(page).toBe('a/==');
      return Response.json(page ? {kind:'storage#managedFolders'} : {kind:'storage#managedFolders',nextPageToken:'a/=='});
    }});
    expect((await read()).grants[storageRole]).toBe('broad');
    expect(seen.filter(path => path.endsWith('/managedFolders'))).toHaveLength(2);
  });

  it('requires the owned empty slot with only the copy account directly granted', async () => {
    const calls = transport();
    await expect(readTransferIsolationEvidence('example-token', { ...input, slotEvidence: { ...input.slotEvidence, directAccessor: false } })).rejects.toThrow();
    await expect(readTransferIsolationEvidence('example-token', { ...input, slotEvidence: { ...input.slotEvidence, secret: { ...input.slotEvidence.secret, labels: {} } } })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
