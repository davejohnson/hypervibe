import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../src/adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../src/adapters/db/repositories/project.repository.js';
import { runGcpSecretWriterPrepare } from '../../src/domain/services/gcp-secret-writer.prepare.js';

// Synthetic stateful REST evidence, not a live IAM acceptance run.
// Source contracts: docs/cloud-writer-onboarding.md. The fixture keeps native
// identity, empty policies, etag concurrency and omitted protobuf fields.
const projectId = 'test-project'; const projectNumber = '123456789012';
const token = 'synthetic-transient-admin-never-store';
const nonce = '445a6698-9f07-48cc-8840-d548bb386204';
const host = 'delivery@host-project.iam.gserviceaccount.com';
const secret = `projects/${projectNumber}/secrets/staging-flow`;
describe('scoped GCP writer preparation real HTTP and durable boundary', () => {
  let temp: string; let repository: ProjectRepository;
  beforeEach(() => { temp = mkdtempSync(join(tmpdir(), 'hv-writer-')); SqliteAdapter.resetInstance(); initializeDatabase(join(temp, 'test.db')); repository = new ProjectRepository(); });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(temp, { recursive: true, force: true }); });
  function fixture() {
    const project = repository.create({ name: 'app', gitRemoteUrl: 'https://github.com/acme/app', policies: { retained: 'yes' } });
    const params = { project, environmentName: 'staging', repository: 'acme/app', sourceRevision: 'a'.repeat(40), sourceDigest: 'b'.repeat(64),
      projectId, projectNumber, hostServiceAccountEmail: host, secretIds: ['staging-flow'], beforeWrite: vi.fn(async () => {}),
      defaultAdminAccessTokenProvider: vi.fn(async () => token), adminAuth: 'default' as const };
    const events: { url: string; method: string; body?: any }[] = [];
    const cloud = { projectId, account: null as Record<string, unknown> | null, roles: new Map<string, Record<string, unknown>>(),
      policies: new Map<string, any>(), accounts: new Map<string, Record<string, unknown>>(), apis: new Set(['iam.googleapis.com']), failCreateReply: false, hideCreatedAccount: false,
      foreign: false, missingSecret: false, failPolicyReply: false, rejectPolicyFor: '', rejectionStatus: 0, unresolvedApiEnable: false,
      differentCreateIdentity: false, policyWrites: 0, apiState: undefined as string | undefined, apiStateService: 'iam.googleapis.com' };
    const retained = { role: 'roles/viewer', members: ['user:other@example.test'], condition: { title: 'retained', expression: 'true' } };
    cloud.policies.set(`projects/${projectNumber}`, { version: 3, etag: 'old-project-etag', bindings: [retained], auditConfigs: [{ service: 'allServices' }] });
    const request: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input)); const method = init.method ?? 'GET'; const body = init.body ? JSON.parse(String(init.body)) : undefined;
      events.push({ url: url.href, method, ...(body ? { body } : {}) });
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
      expect(init.redirect).toBe('error'); expect(init.signal).toBeDefined();
      const resource = decodeURIComponent(url.pathname.replace(/^\/v[13]\//, ''));
      if (url.hostname === 'cloudresourcemanager.googleapis.com' && method === 'GET') return Response.json({ name: `projects/${projectNumber}`, projectId: cloud.projectId, state: 'ACTIVE' });
      if (url.hostname === 'secretmanager.googleapis.com' && method === 'GET' && !resource.endsWith(':getIamPolicy')) {
        return cloud.missingSecret || ![secret, `projects/${projectNumber}/secrets/production-flow`].includes(resource)
          ? Response.json({}, { status: 404 }) : Response.json({ name: resource, createTime: '2026-10-24T10:00:00Z', replication: { automatic: {} } });
      }
      if (url.hostname === 'serviceusage.googleapis.com') {
        if (resource.startsWith('operations/')) return cloud.unresolvedApiEnable ? Response.json({}, { status: 403 }) : Response.json({ name: resource, done: true, response: {} });
        const api = resource.split('/services/')[1].replace(/:enable$/, '');
        if (resource.endsWith(':enable')) { if (!cloud.unresolvedApiEnable) cloud.apis.add(api); return Response.json({ name: 'operations/api-enable' }); }
        return Response.json({ name: `projects/${projectNumber}/services/${api}`, parent: `projects/${projectNumber}`, config: { name: api },
          state: (api === cloud.apiStateService ? cloud.apiState : undefined) ?? (cloud.apis.has(api) ? 'ENABLED' : 'DISABLED') });
      }
      if (resource.endsWith(':getIamPolicy')) {
        const key = resource.replace(/:getIamPolicy$/, '');
        return Response.json(cloud.policies.get(key) ?? { etag: 'empty-etag' });
      }
      if (resource.endsWith(':setIamPolicy')) {
        const key = resource.replace(/:setIamPolicy$/, ''); const prior = cloud.policies.get(key) ?? { etag: 'empty-etag' };
        if (cloud.rejectPolicyFor === key) {
          if (cloud.rejectionStatus) return Response.json({ message: token }, { status: cloud.rejectionStatus });
          throw new Error(token);
        }
        expect(body.policy.etag).toBe(prior.etag);
        const result = { ...body.policy, etag: `etag-${++cloud.policyWrites}` }; cloud.policies.set(key, result);
        if (cloud.failPolicyReply) { cloud.failPolicyReply = false; throw new Error(token); }
        return Response.json(result);
      }
      if (resource.includes('/roles/')) return cloud.roles.has(resource) ? Response.json(cloud.roles.get(resource)) : Response.json({}, { status: 404 });
      if (resource.endsWith('/roles') && method === 'POST') {
        const result = { ...body.role, name: `projects/${projectId}/roles/${body.roleId}`, etag: 'role-etag' };
        cloud.roles.set(result.name, result); return Response.json(result);
      }
      if (resource.endsWith('/serviceAccounts') && method === 'POST') {
        const email = `${body.accountId}@${projectId}.iam.gserviceaccount.com`;
        cloud.account = { name: `projects/${projectId}/serviceAccounts/${email}`, projectId, email,
          uniqueId: cloud.accounts.size === 0 ? '101234567890123456789' : '101234567890123456790', ...body.serviceAccount };
        cloud.accounts.set(email, cloud.account);
        if (cloud.failCreateReply) throw new Error(token);
        return Response.json(cloud.differentCreateIdentity ? { ...cloud.account, uniqueId: '101234567890123456788' } : cloud.account);
      }
      if (resource.includes('/serviceAccounts/')) {
        if (cloud.foreign) return Response.json({ name: resource, email: resource.split('/').at(-1), projectId, uniqueId: '101234567890123456789', description: 'foreign owner' });
        const account = cloud.accounts.get(resource.split('/').at(-1)!);
        return account && !cloud.hideCreatedAccount ? Response.json(account) : Response.json({}, { status: 404 });
      }
      throw new Error(`Unexpected synthetic endpoint ${url.hostname}${url.pathname}`);
    };
    return { params, events, cloud, request, retained, deps: { fetch: request, randomUUID: () => nonce, sleep: async () => {} } };
  }
  async function prepare(f: ReturnType<typeof fixture>, changes = {}) {
    const preview = await runGcpSecretWriterPrepare({ ...f.params, ...changes }, f.deps);
    return runGcpSecretWriterPrepare({ ...f.params, ...changes, confirm: true, expectedPlanDigest: preview.planDigest }, f.deps);
  }
  it('pure preview binds exact targets and source; changed approval does not acquire credentials', async () => {
    const f = fixture(); const preview = await runGcpSecretWriterPrepare(f.params, f.deps);
    expect(preview.success).toBe(true); expect(f.events).toEqual([]); expect(f.params.defaultAdminAccessTokenProvider).not.toHaveBeenCalled();
    const result = await runGcpSecretWriterPrepare({ ...f.params, confirm: true, expectedPlanDigest: preview.planDigest, sourceDigest: 'c'.repeat(64) }, f.deps);
    expect(result).toMatchObject({ success: false, failureCode: 'review_changed' }); expect(f.events).toEqual([]);
  });
  it('creates only scoped writer IAM, preserves policies, and never retains admin values or creates keys/containers', async () => {
    const f = fixture(); const result = await prepare(f);
    expect(result).toMatchObject({ success: true, writerIdentity: { uniqueId: '101234567890123456789' } });
    const projectPolicy = f.cloud.policies.get(`projects/${projectNumber}`);
    expect(projectPolicy.bindings).toContainEqual(f.retained); expect(projectPolicy.auditConfigs).toEqual([{ service: 'allServices' }]);
    const member = `serviceAccount:${result.writerIdentity!.serviceAccountEmail}`;
    const projectRole = projectPolicy.bindings.find((b: any) => b.members.includes(member)).role;
    expect(f.cloud.roles.get(projectRole)!.includedPermissions).toEqual(['resourcemanager.projects.get']);
    const secretRole = f.cloud.policies.get(secret).bindings.find((b: any) => b.members.includes(member)).role;
    expect(f.cloud.roles.get(secretRole)!.includedPermissions).toEqual(['secretmanager.secrets.get', 'secretmanager.versions.add', 'secretmanager.versions.list']);
    expect(f.cloud.policies.get(`projects/${projectId}/serviceAccounts/101234567890123456789`).bindings).toEqual([
      { role: 'roles/iam.serviceAccountTokenCreator', members: [`serviceAccount:${host}`] }]);
    expect(f.cloud.apis.has('iamcredentials.googleapis.com')).toBe(true);
    expect(f.events.some(e => /\/keys|:addVersion|\/secrets$/.test(e.url))).toBe(false);
    expect(JSON.stringify(repository.findById(f.params.project.id))).not.toContain(token);
    expect(readFileSync(join(temp, 'test.db')).includes(Buffer.from(token))).toBe(false);
    expect(repository.findById(f.params.project.id)!.policies.retained).toBe('yes');
    const writes = f.events.filter(e => e.method === 'POST' && !e.url.endsWith(':getIamPolicy')).length;
    expect((await prepare(f)).success).toBe(true);
    expect(f.events.filter(e => e.method === 'POST' && !e.url.endsWith(':getIamPolicy'))).toHaveLength(writes);
  });
  it.each(['foreign', 'missingSecret', 'projectMismatch'] as const)('blocks %s before IAM mutations', async mode => {
    const f = fixture(); if (mode === 'projectMismatch') f.cloud.projectId = 'other-project'; else f.cloud[mode] = true;
    const result = await prepare(f); expect(result.success).toBe(false);
    expect(f.events.filter(e => e.method === 'POST' && !e.url.endsWith(':getIamPolicy'))).toEqual([]);
  });
  it.each(['iam.googleapis.com', 'iamcredentials.googleapis.com'])('rejects unknown %s state before recording or dispatching preparation work', async api => {
    const f = fixture(); f.cloud.apiState = 'STATE_UNSPECIFIED'; f.cloud.apiStateService = api;
    const result = await prepare(f); expect(result.success).toBe(false);
    expect(f.events.filter(event => event.method !== 'GET')).toEqual([]);
    expect(repository.findById(f.params.project.id)!.policies.secretWriterPreparation).toBeUndefined();
  });
  it('recovers uncertain creation only with persisted attempt marker and immutable unique ID', async () => {
    const f = fixture(); f.cloud.failCreateReply = true;
    expect((await prepare(f)).success).toBe(true);
    expect(f.events.filter(e => e.url.endsWith('/serviceAccounts') && e.method === 'POST')).toHaveLength(1);
  });
  it('does not authorize grants when successful creation and readback disagree on immutable identity', async () => {
    const f = fixture(); f.cloud.differentCreateIdentity = true;
    expect((await prepare(f)).success).toBe(false);
    expect(f.events.filter(e => e.url.endsWith(':setIamPolicy'))).toEqual([]);
  });
  it('never resends an unresolved create after restart, and emits only safe errors', async () => {
    const f = fixture(); f.cloud.failCreateReply = true; f.cloud.hideCreatedAccount = true;
    const first = await prepare(f); const second = await prepare(f);
    expect(first.success).toBe(false); expect(second.success).toBe(false);
    expect(JSON.stringify([first, second])).not.toContain(token);
    expect(f.events.filter(e => e.url.endsWith('/serviceAccounts') && e.method === 'POST')).toHaveLength(1);
  });
  it('rechecks source after preflight and rejects revoked authority without mutation', async () => {
    const f = fixture(); f.params.beforeWrite.mockRejectedValue(new Error(token));
    expect(await prepare(f)).toMatchObject({ success: false, failureCode: 'authorization_unconfirmed' });
    expect(f.events.filter(e => e.method === 'POST' && !e.url.endsWith(':getIamPolicy'))).toEqual([]);
  });
  it('identifies only the exact secret for the final secret-IAM authority check', async () => {
    const f = fixture(); expect((await prepare(f)).success).toBe(true);
    expect(f.params.beforeWrite.mock.calls.some(call => (call as unknown[])[0] && ((call as unknown[])[0] as any).secretId === 'staging-flow')).toBe(true);
  });
  it('does not reuse a replaced writer, modified custom role, or broadened scope', async () => {
    const f = fixture(); expect((await prepare(f)).success).toBe(true);
    f.cloud.account!.uniqueId = '101234567890123456788'; expect((await prepare(f)).success).toBe(false);
    f.cloud.account!.uniqueId = '101234567890123456789';
    f.cloud.roles.values().next().value!.includedPermissions = ['secretmanager.versions.access'];
    expect((await prepare(f)).success).toBe(false);
    expect((await prepare(f, { repository: 'foreign/app' })).success).toBe(false);
  });
  it('a disappeared bound writer is not silently recreated', async () => {
    const f = fixture(); expect((await prepare(f)).success).toBe(true); f.cloud.accounts.clear();
    expect((await prepare(f)).success).toBe(false);
    expect(f.events.filter(e => e.url.endsWith('/serviceAccounts') && e.method === 'POST')).toHaveLength(1);
  });
  it('recovers a lost IAM acknowledgment by exact readback without repeating its write', async () => {
    const f = fixture(); f.cloud.failPolicyReply = true; expect((await prepare(f)).success).toBe(true);
    expect(f.events.filter(e => e.url.endsWith(':setIamPolicy'))).toHaveLength(3);
  });
  it('keeps the full pending grant scope after interruption instead of forgetting an uncertain added secret', async () => {
    const f = fixture(); expect((await prepare(f)).success).toBe(true);
    f.cloud.rejectPolicyFor = `projects/${projectNumber}/secrets/production-flow`;
    expect((await prepare(f, { secretIds: ['staging-flow', 'production-flow'] })).success).toBe(false);
    expect(await prepare(f)).toMatchObject({ success: false, failureCode: 'scope_reduction_requires_review' });
  });
  it('preserves an already pinned declared secret while preparing new active slots, without granting new rights to retained-only slots', async () => {
    const f = fixture(); const first = await prepare(f); expect(first.success).toBe(true);
    const earlier = f.events.length;
    const second = await prepare(f, { secretIds: ['production-flow'], retainedSecretIds: ['staging-flow', 'externally-pinned'] });
    expect(second.success).toBe(true);
    expect(f.events.slice(earlier).some(event => event.url.includes('/secrets/staging-flow') || event.url.includes('/secrets/externally-pinned'))).toBe(false);
    const record = (repository.findById(f.params.project.id)!.policies.secretWriterPreparation as any).staging;
    expect(record.secretIds).toEqual(['production-flow', 'staging-flow']);
  });
  it('allows a separately confirmed retry after definite native rejection but never treats it as a successful grant', async () => {
    const f = fixture(); f.cloud.rejectPolicyFor = secret; f.cloud.rejectionStatus = 403;
    const denied = await prepare(f); expect(denied.success).toBe(false); expect(JSON.stringify(denied)).not.toContain(token);
    f.cloud.rejectPolicyFor = '';
    expect((await prepare(f)).success).toBe(true);
    expect(f.events.filter(event => event.url.endsWith(`${secret}:setIamPolicy`))).toHaveLength(2);
  });
  it('does not classify a rejected follow-up read as rejection of an accepted API-enable write', async () => {
    const f = fixture(); f.cloud.unresolvedApiEnable = true;
    expect((await prepare(f)).success).toBe(false); expect((await prepare(f)).success).toBe(false);
    expect(f.events.filter(event => event.url.endsWith(':enable'))).toHaveLength(1);
  });
  it('assigns distinct stable writer identities to two environments without copying source or secret scope', async () => {
    const f = fixture(); const a = await runGcpSecretWriterPrepare(f.params, f.deps);
    const b = await runGcpSecretWriterPrepare({ ...f.params, environmentName: 'production', secretIds: ['production-flow'] }, f.deps);
    const c = await runGcpSecretWriterPrepare({ ...f.params, sourceRevision: 'c'.repeat(40) }, f.deps);
    expect(a.plan!.serviceAccountEmail).not.toBe(b.plan!.serviceAccountEmail);
    expect(a.plan!.serviceAccountEmail).toBe(c.plan!.serviceAccountEmail);
  });
  it('two actual environment preparations retain isolated native principals and secret bindings', async () => {
    const f = fixture(); const staging = await prepare(f);
    const production = await prepare(f, { environmentName: 'production', secretIds: ['production-flow'] });
    expect(staging.success).toBe(true); expect(production.success).toBe(true);
    expect(staging.writerIdentity!.serviceAccountEmail).not.toBe(production.writerIdentity!.serviceAccountEmail);
    expect(f.cloud.policies.get(secret).bindings).toHaveLength(1);
    expect(f.cloud.policies.get(secret).bindings[0].members).toEqual([`serviceAccount:${staging.writerIdentity!.serviceAccountEmail}`]);
    expect(f.cloud.policies.get(`projects/${projectNumber}/secrets/production-flow`).bindings[0].members)
      .toEqual([`serviceAccount:${production.writerIdentity!.serviceAccountEmail}`]);
    expect((await prepare(f)).success).toBe(true);
  });
});
