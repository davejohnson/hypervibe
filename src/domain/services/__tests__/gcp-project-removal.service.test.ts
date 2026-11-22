import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const environments: Array<{ name: string; platformBindings: Record<string, unknown> }> = [];
const connections: Array<{ id: string; provider: string; scope: string; credentialsEncrypted: string }> = [];
const policies: { value: Record<string, unknown> } = { value: {} };
const audits: Array<{ action: string }> = [];
vi.mock('../../../adapters/db/repositories/environment.repository.js', () => ({ EnvironmentRepository: class { findByProjectId() { return environments; } } }));
vi.mock('../../../adapters/db/repositories/project.repository.js', () => ({ ProjectRepository: class {
  findAll() { return [{ id: 'p1', name: 'demo', policies: policies.value }]; }
  updatePolicies(_id: string, change: (project: { policies: Record<string, unknown> }) => Record<string, unknown>) { policies.value = change({ policies: policies.value }); }
} }));
vi.mock('../../../adapters/db/repositories/connection.repository.js', () => ({ ConnectionRepository: class {
  findAllByProvider(provider: string) { return connections.filter((entry) => entry.provider === provider); }
  delete(id: string) { const index = connections.findIndex((entry) => entry.id === id); if (index < 0) return false; connections.splice(index, 1); return true; }
} }));
vi.mock('../../../adapters/db/repositories/audit.repository.js', () => ({ AuditRepository: class { create(entry: { action: string }) { audits.push(entry); } } }));
vi.mock('../../../adapters/secrets/secret-store.js', () => ({ getSecretStore: () => ({ decryptObject: (value: string) => JSON.parse(value) }) }));
vi.mock('../cloud-prepare.execute.js', () => ({ buildSourceBucketName: (id: string) => `${id}-hv-build-source`, getDefaultAdminAccessToken: vi.fn() }));
vi.mock('../gcp-project-setup.service.js', () => ({ readGcpBootstrappedProject: vi.fn() }));

const { runGcpProjectRemoval } = await import('../gcp-project-removal.service.js');
const { engineStatePaths } = await import('../../../adapters/engine/opentofu/workspace.js');

const GCP = 'hv-demo-12345678';
const project = { id: 'p1', name: 'demo', policies: {} } as never;
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
// Google's own answer for an API that was never switched on in the project.
const disabled = () => json(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });

let dataDir: string;
let now: number;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-removal-')); now = 1_000_000;
  environments.length = 0; connections.length = 0; audits.length = 0;
  connections.push({ id: 'c1', provider: 'cloudrun', scope: 'o/r', credentialsEncrypted: JSON.stringify({ projectId: GCP }) },
    { id: 'c2', provider: 'cloudsql', scope: 'o/r', credentialsEncrypted: JSON.stringify({ projectId: GCP }) },
    { id: 'c4', provider: 'cloudrun', scope: 'o/second-app', credentialsEncrypted: JSON.stringify({ projectId: GCP }) },
    { id: 'c3', provider: 'cloudrun', scope: 'o/other', credentialsEncrypted: JSON.stringify({ projectId: 'someone-elses' }) });
  policies.value = { cloudPreparation: { cloudrun: { gcpProjectId: GCP } }, gcpProjectPreparations: { [GCP]: { gcpProjectId: GCP }, 'another-project': { gcpProjectId: 'another-project' } } };
  const root = engineStatePaths({ provider: 'gcp', projectId: 'p1', environmentId: GCP, partition: 'project-shared' }, dataDir).root;
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'terraform.tfstate'), '{}');
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

interface Cloud { state: string; number: string; lists: Record<string, Response | (() => Response)>; deleteAnswer?: () => Response | never; calls: string[]; waits?: number; onWait?: () => void }
function google(overrides: Partial<Cloud> = {}): Cloud {
  const cloud: Cloud = { state: 'ACTIVE', number: '4242', lists: {}, calls: [], ...overrides };
  return cloud;
}
function run(cloud: Cloud, input: { previewId?: string; confirm?: boolean } = {}, created: unknown = { ok: true, created: true, projectNumber: '4242' }) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; cloud.calls.push(`${method} ${new URL(url).host}`);
    if (url.includes('cloudresourcemanager')) {
      if (method === 'DELETE') { const answer = (cloud.deleteAnswer ?? (() => { cloud.state = 'DELETE_REQUESTED'; return json(200, {}); }))(); return answer; }
      return json(200, { name: `projects/${cloud.number}`, projectId: GCP, state: cloud.state });
    }
    const match = Object.entries(cloud.lists).find(([part]) => url.includes(part));
    if (match) return typeof match[1] === 'function' ? match[1]() : match[1].clone();
    return url.includes('recaptcha') || url.includes('apikeys') || url.includes('redis') ? disabled() : json(200, {});
  });
  return runGcpProjectRemoval({ project, gcpProjectId: GCP, ...input }, {
    getDefaultAdminAccessToken: async () => 'token', fetch: fetchImpl as never, readCreatedProject: (async () => created) as never, now: () => now, sleep: async () => { cloud.waits = (cloud.waits ?? 0) + 1; cloud.onWait?.(); }, dataDir });
}
const untouched = (cloud: Cloud) => { expect(cloud.calls.filter((call) => call.startsWith('DELETE'))).toEqual([]); expect(connections).toHaveLength(4); };

describe('removing a Google project Hypervibe created', () => {
  it('previews an empty project without changing anything, then deletes it and forgets its access on confirm', async () => {
    const cloud = google({ lists: { 'storage.googleapis.com': json(200, { items: [{ name: `${GCP}-hv-build-source` }] }) } });
    const preview = await run(cloud);
    expect(preview).toMatchObject({ success: true, mode: 'preview', projectNumber: '4242', previewId: expect.any(String),
      notChecked: ['Redis caches', 'reCAPTCHA keys', 'API keys'], warnings: expect.arrayContaining([expect.stringContaining('Not checked')]) });
    untouched(cloud);

    const done = await run(cloud, { previewId: preview.previewId, confirm: true });
    expect(done).toMatchObject({ success: true, mode: 'confirm', removedConnections: ['cloudrun (o/r)', 'cloudrun (o/second-app)', 'cloudsql (o/r)'] });
    expect(cloud.calls.filter((call) => call.startsWith('DELETE'))).toEqual(['DELETE cloudresourcemanager.googleapis.com']);
    expect(connections.map((entry) => entry.id)).toEqual(['c3']);
    expect(policies.value).toEqual({ cloudPreparation: {}, gcpProjectPreparations: { 'another-project': { gcpProjectId: 'another-project' } } });
    const parent = path.dirname(engineStatePaths({ provider: 'gcp', projectId: 'p1', environmentId: GCP, partition: 'project-shared' }, dataDir).root);
    expect(fs.readdirSync(parent)).toEqual([`project-shared.removed-${now}`]);
    expect(audits.map((entry) => entry.action)).toContain('gcp.project.removed');
  });

  it('refuses a project Hypervibe did not create, without reading or deleting anything in it', async () => {
    const cloud = google();
    expect(await run(cloud, {}, { ok: true, created: false })).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('did not create') });
    expect(cloud.calls).toEqual([]);
  });

  it('refuses when the project with that id is not the one it created', async () => {
    const cloud = google({ number: '9999' });
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('project number differs') });
    untouched(cloud);
  });

  it('refuses while Hypervibe still records an environment there', async () => {
    environments.push({ name: 'staging', platformBindings: { projectId: GCP, services: { web: {} } } });
    // An environment emptied before teardown existed keeps empty lists; it must not block for ever.
    environments.push({ name: 'old', platformBindings: { projectId: GCP, services: {}, engine: { kind: 'opentofu', storage: [], secrets: [], secretMetadata: {} } } });
    const cloud = google();
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', found: ['environment demo/staging'] });
    untouched(cloud);
  });

  it.each([
    ['a service', 'serving.knative.dev', { items: [{ metadata: { name: 'web-1' } }] }, 'Cloud Run services: web-1'],
    ['a database', 'sqladmin', { items: [{ name: 'hv-db' }] }, 'databases: hv-db'],
    ['a bucket of its own', 'storage.googleapis.com', { items: [{ name: 'backups' }, { name: `${GCP}-hv-build-source` }] }, 'storage buckets: backups'],
    ['a secret', 'secretmanager', { secrets: [{ name: `projects/1/secrets/api-key` }] }, 'secrets: api-key'],
    ['a reCAPTCHA key a website may use', 'recaptcha', { keys: [{ name: 'projects/1/keys/k', displayName: 'example.com' }] }, 'reCAPTCHA keys: example.com'],
  ])('refuses while the project holds %s', async (_what, part, body, found) => {
    const cloud = google({ lists: { [part]: json(200, body) } });
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', found: [found] });
    untouched(cloud);
  });

  it.each([
    ['a refused read', json(403, { error: { status: 'PERMISSION_DENIED' } })],
    ['a server error', json(500)],
    ['regions Google could not reach', json(200, { items: [], unreachable: ['us-east7'] })],
    ['an empty first page with more to come', json(200, { items: [], nextPageToken: 'x' })],
    ['a list Google marks as partial', json(200, { items: [], warnings: [{ code: 'REGION_UNREACHABLE' }] })],
  ])('treats %s as unknown, never as empty', async (_what, answer) => {
    const cloud = google({ lists: { sqladmin: answer } });
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('unknown') });
    untouched(cloud);
  });

  it.each(['serving.knative.dev', '/jobs', '/workerpools', 'sqladmin', 'storage.googleapis.com', 'secretmanager', 'redis', '/topics', '/subscriptions', 'recaptcha', 'apikeys'])(
    'blocks when the list from %s fails', async (part) => {
      const cloud = google({ lists: { [part]: json(500) } });
      expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('unknown') });
      untouched(cloud);
    });

  it('does not take a first page holding only its own build bucket as the whole list', async () => {
    const cloud = google({ lists: { 'storage.googleapis.com': json(200, { items: [{ name: `${GCP}-hv-build-source` }], nextPageToken: 'more' }) } });
    expect(await run(cloud)).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('incomplete') });
    untouched(cloud);
  });

  it('keeps the administrator token out of what it returns', async () => {
    const cloud = google();
    const result = await run(cloud, {}, { ok: false, error: 'tofu failed with Bearer token in its output' });
    expect(JSON.stringify(result)).not.toContain('token in');
    expect(result).toMatchObject({ success: false, status: 'blocked' });
  });

  it('needs the reviewed preview even when the project is already being deleted', async () => {
    const cloud = google({ state: 'DELETE_REQUESTED' });
    const preview = await run(cloud);
    expect(preview).toMatchObject({ success: true, warnings: [expect.stringContaining('connections')] });
    expect(await run(cloud, { previewId: '00000000-0000-4000-8000-000000000000', confirm: true })).toMatchObject({ success: false, status: 'blocked' });
    expect(connections).toHaveLength(4);
    const again = await run(cloud);
    expect(await run(cloud, { previewId: again.previewId, confirm: true })).toMatchObject({ success: true });
    expect(connections.map((entry) => entry.id)).toEqual(['c3']);
  });

  it('checks everything again on confirm and refuses a project that gained a database after the preview', async () => {
    const cloud = google();
    const preview = await run(cloud);
    cloud.lists.sqladmin = json(200, { items: [{ name: 'new-db' }] });
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, status: 'blocked', found: ['databases: new-db'] });
    untouched(cloud);
  });

  it('refuses a wrong, reused or expired preview', async () => {
    const cloud = google();
    const preview = await run(cloud);
    expect(await run(cloud, { previewId: '00000000-0000-4000-8000-000000000000', confirm: true })).toMatchObject({ success: false, status: 'blocked' });
    now += 11 * 60_000;
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, status: 'blocked', error: expect.stringContaining('expired') });
    expect(await run(cloud, { confirm: true })).toMatchObject({ success: false, status: 'blocked' });
    untouched(cloud);
  });

  it('waits for the project to show as deleting, because Google answers the delete first', async () => {
    // Observed live on 2026-11-21: DELETE returned 200 and the next read still said ACTIVE.
    const cloud = google({ deleteAnswer: () => json(200, { name: 'operations/x' }) });
    cloud.onWait = () => { if (cloud.waits === 3) cloud.state = 'DELETE_REQUESTED'; };
    const preview = await run(cloud);
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: true });
    expect(cloud.waits).toBe(3);
  });

  it('says the outcome is unconfirmed when an accepted delete never shows', async () => {
    const cloud = google({ deleteAnswer: () => json(200, {}) });
    const preview = await run(cloud);
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, status: 'pending' });
    expect(connections).toHaveLength(4);
  });

  it('reports a refused deletion as unchanged and keeps its access', async () => {
    const cloud = google({ deleteAnswer: () => json(403) });
    const preview = await run(cloud);
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, error: expect.stringContaining('unchanged') });
    expect(connections).toHaveLength(4);
    // A preview is used once.
    cloud.deleteAnswer = undefined;
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, status: 'blocked' });
    untouched({ ...cloud, calls: cloud.calls.slice(cloud.calls.lastIndexOf('DELETE cloudresourcemanager.googleapis.com') + 1) });
  });

  it('says the outcome is unknown, and keeps its access, when neither the delete nor the read after it answers', async () => {
    const cloud = google();
    const preview = await run(cloud);
    cloud.deleteAnswer = () => { cloud.state = 'GONE'; throw new Error('socket hang up'); };
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: false, status: 'pending' });
    expect(connections).toHaveLength(4);
  });

  it('after a lost answer, finds the project already deleting and finishes without a second delete', async () => {
    const cloud = google({ deleteAnswer: () => { cloud.state = 'DELETE_REQUESTED'; throw new Error('socket hang up'); } });
    const preview = await run(cloud);
    expect(await run(cloud, { previewId: preview.previewId, confirm: true })).toMatchObject({ success: true });
    expect(connections.map((entry) => entry.id)).toEqual(['c3']);
  });
});
