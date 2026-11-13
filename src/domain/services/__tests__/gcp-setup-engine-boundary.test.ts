import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { runCloudPrepare } from '../cloud-prepare.execute.js';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-setup-boundary-'));
  vi.stubEnv('HYPERVIBE_DATA_DIR', directory);
  SqliteAdapter.resetInstance();
  initializeDatabase(path.join(directory, 'test.db'));
});
afterEach(() => {
  SqliteAdapter.resetInstance();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

it('requires a saved preparation preview before any infrastructure mutation', async () => {
  const project = new ProjectRepository().create({ name: 'setup-boundary', defaultPlatform: 'cloudrun' });
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push(url);
    if (url.endsWith(':enable')) return new Response(JSON.stringify({ name: 'operations/enable', done: true, response: { state: 'ENABLED' } }));
    if (url.includes('/services/')) return new Response(JSON.stringify({ name: `projects/123456/services/${url.split('/').at(-1)}`, parent: 'projects/123456', config: { name: url.split('/').at(-1) }, state: 'DISABLED' }));
    if (url.endsWith('/projects/setup-boundary')) return new Response(JSON.stringify({ name: 'projects/123456', projectId: 'setup-boundary', state: 'ACTIVE' }));
    return new Response('{}', { status: 403 });
  }));
  const result = await runCloudPrepare({ project, provider: 'cloudrun', gcpProjectId: 'setup-boundary',
    deployServiceAccountEmail: 'hypervibe-deploy@setup-boundary.iam.gserviceaccount.com', adminAccessToken: 'private-admin-token', confirm: true });
  expect(result.success).toBe(false);
  expect(writes).toEqual([]);
  expect(result.error).toMatch(/preview/i);
});
