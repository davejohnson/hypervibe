import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { PlanService } from '../plan.service.js';
import type { ObservedState } from '../../ports/observe.port.js';

// Real persisted PlanService boundary with synthetic provider-port observation.
// Empty normalized inventory is creation intent, never native absence evidence.
// Exact native create-only guards are exercised by hosting HTTP/SDK regressions.
const reference = { destination: { provider: 'gcp-secret-manager', projectId: 'cloud-project', projectNumber: '123456789012', secretId: 'api-token' }, version: '7' };
describe('first deployment with immutable native references', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'hv-initial-native-ref-')); SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'state.db')); });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); rmSync(directory, { recursive: true, force: true }); });
  async function plan(options: { partial?: boolean; bound?: boolean } = {}) {
    const project = new ProjectRepository().create({ name: 'native-reference-app', defaultPlatform: 'cloudrun' });
    new SpecStore().replace(project, { version: 1, project: project.name,
      secrets: { API_TOKEN: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
      environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: { public: false } }, email: { enabled: false }, secretDestinations: { API_TOKEN: reference } } } });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: { provider: 'cloudrun', projectId: 'cloud-project', environmentId: 'us-central1', services: options.bound ? { web: { serviceId: 'missing-web' } } : {} } });
    const observed: ObservedState = { provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true, projectId: 'cloud-project', environmentId: 'us-central1', services: [], databases: [], partial: options.partial ?? false, warnings: [], completeness: { project: 'complete', environment: 'complete', services: options.partial ? 'unknown' : 'complete', databases: 'complete' } };
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: { name: 'cloudrun', capabilities: { supportsObserve: true }, observe: async () => observed } as never });
    const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    return result;
  }
  it('plans reference installation as explicit conditional creation intent, without inventing absence or a literal input', async () => {
    const result = await plan();
    expect(result).not.toHaveProperty('error');
    if ('error' in result) throw new Error(result.error);
    expect(result.actions.find(action => action.id === 'secret:API_TOKEN')).toMatchObject({ type: 'update', verified: true,
      metadata: { operation: 'secretReferenceSync', reference, creationOnlyServices: ['web'] } });
    expect(result.inputRequired).toEqual([]);
  });
  it.each([{ partial: true }, { bound: true }])('keeps unknown reads and stale bindings blocked: %j', async options => {
    const result = await plan(options);
    expect(result).toMatchObject({ error: expect.stringContaining('Cannot verify current runtime secret reference') });
  });
});
