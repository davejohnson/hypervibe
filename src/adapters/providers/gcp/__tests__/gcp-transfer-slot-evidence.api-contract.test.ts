import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTransferSlotEvidence } from '../gcp-transfer-slot-evidence.js';

// Reconstructed metadata-only HTTP responses, based on Google's REST v1:
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets.versions/list
// https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/getIamPolicy
// https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts
// https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects
const projectId = 'staging-transfer';
const projectNumber = '321098765432';
const accountEmail = 'job-transfer@staging-transfer.iam.gserviceaccount.com';
const secretId = 'transfer-credential';
const target = { projectId, accountEmail, secretId };
const project = { name: 'projects/' + projectNumber, projectId, state: 'ACTIVE' };
const account = { name: 'projects/' + projectId + '/serviceAccounts/' + accountEmail, projectId, email: accountEmail,
  uniqueId: '123456789012345678902', displayName: 'Staging transfer', description: 'Transfer job identity' };
const accountReceipt = { name: account.name, email: accountEmail, uniqueId: account.uniqueId,
  displayName: account.displayName, description: account.description };
const secret = { name: project.name + '/secrets/' + secretId, createTime: '2026-09-03T03:21:19.123456Z',
  labels: { 'managed-by': 'hypervibe', environment: 'staging' } };
const member = 'serviceAccount:' + accountEmail;
const grant = { role: 'roles/secretmanager.secretAccessor', members: [member] };
const projectUrl = 'https://cloudresourcemanager.googleapis.com/v3/projects/' + projectId;
const accountUrl = 'https://iam.googleapis.com/v1/' + account.name;
const secretUrl = 'https://secretmanager.googleapis.com/v1/' + secret.name;
const versionsUrl = secretUrl + '/versions';
const policyUrl = secretUrl + ':getIamPolicy';
type Override = (path: string, query: URLSearchParams) => Response | undefined;

function transport(override?: Override) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.origin + decodeURIComponent(url.pathname);
    calls.push(path);
    if ((init.method ?? 'GET') !== 'GET' || new Headers(init.headers).get('Authorization') !== 'Bearer test-token') {
      throw Error('A GET with the selected credential was required.');
    }
    const other = override?.(path, url.searchParams);
    if (other) return other;
    if (path === projectUrl) return Response.json(project);
    if (path === accountUrl) return Response.json(account);
    if (path === secretUrl) return Response.json(secret);
    if (path === policyUrl && url.searchParams.get('options.requestedPolicyVersion') === '3') {
      return Response.json({ version: 1, bindings: [grant] });
    }
    if (path === versionsUrl && !url.searchParams.has('filter')) return Response.json({});
    throw Error('Unexpected Google API operation');
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('dedicated transfer credential slot over Google REST', () => {
  it('checks all version metadata even when the latest alias is absent', async () => {
    const calls = transport((path, query) => {
      if (path.endsWith('/versions/latest')) return new Response(null, { status: 404 });
      if (path === versionsUrl) return Response.json(query.get('pageToken') === 'next'
        ? { versions: [{ name: secret.name + '/versions/1', state: 'DESTROYED' }] }
        : { nextPageToken: 'next' });
      if (path.endsWith('/secrets/' + secretId)) return Response.json(secret);
    });
    await expect(readTransferSlotEvidence('test-token', target)).rejects.toThrow(/already has a version/);
    expect(calls).not.toContain(versionsUrl + '/latest');
    expect(calls).toContain(versionsUrl);
  });

  const destroyed = {
    name: secret.name + '/versions/1', createTime: '2026-09-03T03:30:01Z', state: 'DESTROYED' as const,
    projectNumber, secretCreateTime: secret.createTime,
  };
  const tombstone = { name: destroyed.name, createTime: destroyed.createTime, state: destroyed.state };

  it('accepts only recorded native destroyed versions across the full unfiltered inventory', async () => {
    const second = { ...destroyed, name: secret.name + '/versions/2' };
    transport((path, query) => {
      if (path !== versionsUrl) return;
      expect(query.get('fields')).toContain('versions(name,createTime,state)');
      expect(query.has('filter')).toBe(false);
      return Response.json(query.has('pageToken') ? { versions: [tombstone], totalSize: 2 }
        : { versions: [{ ...tombstone, name: second.name }], totalSize: 2, nextPageToken: 'another' });
    });
    await expect(readTransferSlotEvidence('test-token', target, [destroyed, second])).resolves.toMatchObject({ secret });
  });

  it.each([
    ['an unrelated destroyed version', { ...tombstone, name: secret.name + '/versions/2' }, destroyed],
    ['a disabled version', { ...tombstone, state: 'DISABLED' }, destroyed],
    ['an enabled version', { ...tombstone, state: 'ENABLED' }, destroyed],
    ['a recreated version', { ...tombstone, createTime: '2026-10-01T00:00:00Z' }, destroyed],
    ['a recreated secret', tombstone, { ...destroyed, secretCreateTime: '2026-01-01T00:00:00Z' }],
    ['a different project number', tombstone, { ...destroyed, projectNumber: '9999' }],
    ['an alias', { ...tombstone, name: secret.name + '/versions/latest' }, { ...destroyed, name: secret.name + '/versions/latest' }],
  ] as const)('blocks %s even with a probe receipt', async (_case, version, proof) => {
    transport(path => path === versionsUrl ? Response.json({ versions: [version] }) : undefined);
    await expect(readTransferSlotEvidence('test-token', target, [proof])).rejects.toThrow();
  });

  it('requires all recorded versions to be present once and bound to an existing secret', async () => {
    for (const inventory of [{}, { versions: [tombstone, tombstone] }, { versions: [tombstone], totalSize: 2 }]) {
      transport(path => path === versionsUrl ? Response.json(inventory) : undefined);
      await expect(readTransferSlotEvidence('test-token', target, [destroyed])).rejects.toThrow();
    }
    transport(path => path === secretUrl ? new Response(null, { status: 404 }) : undefined);
    await expect(readTransferSlotEvidence('test-token', target, [destroyed])).rejects.toThrow();
  });

  it('binds exact project, account and secret identity, accepting omitted protobuf defaults', async () => {
    const calls = transport((path, query) => {
      if (path === secretUrl) return Response.json({ ...secret, name: 'projects/' + projectId + '/secrets/' + secretId });
      if (path === versionsUrl && !query.has('pageToken')) return Response.json({ nextPageToken: 'e/==' });
      if (path === versionsUrl && query.get('pageToken') !== 'e/==') throw Error('Bad pagination');
    });
    expect(await readTransferSlotEvidence('test-token', target)).toMatchObject({
      projectNumber, account: accountReceipt, secret, directAccessor: true,
    });
    expect(calls).toEqual([projectUrl, accountUrl, secretUrl, versionsUrl, versionsUrl, policyUrl]);
  });

  it('returns exact resource absence only from the two native 404s', async () => {
    const calls = transport(path => [accountUrl, secretUrl].includes(path) ? new Response(null, { status: 404 }) : undefined);
    expect(await readTransferSlotEvidence('test-token', target)).toEqual({ projectNumber, account: null, secret: null, directAccessor: false });
    expect(calls).toEqual([projectUrl, accountUrl, secretUrl]);
  });

  it('reads an existing empty secret with no direct policy or labels', async () => {
    transport(path => {
      if (path === policyUrl) return Response.json({});
      if (path === secretUrl) return Response.json({ name: secret.name, createTime: secret.createTime });
    });
    expect(await readTransferSlotEvidence('test-token', target)).toMatchObject({ projectNumber, account: accountReceipt, secret: { labels: {} }, directAccessor: false });
  });

  it.each([
    ['a project with the wrong ID', projectUrl, { ...project, projectId: 'different-project' }],
    ['a retail name in place of a project number', projectUrl, { ...project, name: 'projects/' + projectId }],
    ['a project pending deletion', projectUrl, { ...project, state: 'DELETE_REQUESTED' }],
    ['an unverified account ID', accountUrl, { ...account, uniqueId: 'unknown' }],
    ['a disabled account', accountUrl, { ...account, disabled: true }],
    ['an account from another project', accountUrl, { ...account, projectId: 'elsewhere' }],
    ['a different secret', secretUrl, { ...secret, name: secret.name + '-other' }],
    ['a missing creation time', secretUrl, { name: secret.name }],
    ['a contradictory positive count', versionsUrl, { totalSize: 1 }],
    ['an invalid version envelope', versionsUrl, { rows: [] }],
    ['a repeated continuation token', versionsUrl, { nextPageToken: 'loop' }],
    ['an additional direct principal', policyUrl, { bindings: [{ ...grant, members: [member, 'allUsers'] }] }],
    ['a different direct role', policyUrl, { bindings: [{ ...grant, role: 'roles/owner' }] }],
    ['an extra role for someone else', policyUrl, { bindings: [grant, { role: 'roles/viewer', members: ['allUsers'] }] }],
    ['a deleted account historical grant', policyUrl, { bindings: [{ ...grant, members: ['deleted:' + member + '?uid=123'] }] }],
    ['a conditional grant', policyUrl, { version: 3, bindings: [{ ...grant, condition: { expression: 'true' } }] }],
    ['a malformed conditional binding', policyUrl, { bindings: [{ ...grant, conditions: [{ expression: 'false' }] }] }],
    ['a repeated binding', policyUrl, { bindings: [grant, grant] }],
  ])('blocks %s', async (_case, endpoint, data) => {
    const calls = transport(path => path === endpoint ? Response.json(data) : undefined);
    await expect(readTransferSlotEvidence('test-token', target)).rejects.toThrow();
    expect(calls).toContain(endpoint);
  });

  it.each([projectUrl, accountUrl, secretUrl, versionsUrl, policyUrl])('never interprets a forbidden read as absent: %s', async endpoint => {
    const calls = transport(path => path === endpoint ? Response.json({ error: 'attempted secret leak' }, { status: 403 }) : undefined);
    await expect(readTransferSlotEvidence('test-token', target)).rejects.toThrow(/^((?!attempted secret leak).)*$/);
    expect(calls).toContain(endpoint);
  });

  it.each([projectUrl, versionsUrl, policyUrl])('blocks a 404 outside the account and secret identity reads: %s', async endpoint => {
    const calls = transport(path => path === endpoint ? new Response(null, { status: 404 }) : undefined);
    await expect(readTransferSlotEvidence('test-token', target)).rejects.toThrow();
    expect(calls).toContain(endpoint);
  });

  it('rejects a direct grant when the service account is missing', async () => {
    transport(path => path === accountUrl ? new Response(null, { status: 404 }) : undefined);
    await expect(readTransferSlotEvidence('test-token', target)).rejects.toThrow(/could not find/);
  });
});
