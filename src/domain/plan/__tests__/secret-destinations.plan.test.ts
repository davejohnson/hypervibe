import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import '../../../adapters/providers/gcp/cloudrun.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { RunRepository } from '../../../adapters/db/repositories/run.repository.js';
import { SpecStore } from '../../spec/spec.store.js';
import { adapterFactory } from '../../services/adapter.factory.js';
import { getSecretStore } from '../../../adapters/secrets/secret-store.js';
import { deriveHypervibeSecretValues } from '../../services/hypervibe-secret-value.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { fingerprintObservedState } from '../converge.executor.js';
import { resolvePlanActionAuthority } from '../action-authority.js';
import { actionRequiresBackupReadiness } from '../plan-stage.js';
import { PlanService } from '../plan.service.js';

const destination = { provider: 'gcp-secret-manager', projectId: 'synthetic-project',
  projectNumber: '123456789012', secretId: 'staging-session' };
const reference = { destination, version: '7' };
function observed(version = '7'): ObservedState {
  return { provider: 'cloudrun', observedAt: new Date().toISOString(), projectExists: true,
    projectId: 'synthetic-project', environmentId: 'staging', partial: false, warnings: [], databases: [],
    services: [{ name: 'web', externalId: 'web-id', workloadKind: 'web', status: 'running',
      customDomains: [], config: {}, envVarKeys: ['SESSION_SECRET'], envVarHashes: {},
      envVarSecretRefs: { SESSION_SECRET: { provider: 'gcp-secret-manager',
        resource: 'projects/123456789012/secrets/staging-session', version } } }] };
}

describe('native secret plan persistence and mutation admission', () => {
  let directory: string;
  let project: ReturnType<ProjectRepository['create']>;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-native-plan-'));
    SqliteAdapter.resetInstance(); initializeDatabase(path.join(directory, 'hypervibe.db'));
    project = new ProjectRepository().create({ name: 'synthetic-app', defaultPlatform: 'cloudrun' });
    new SpecStore().replace(project, { version: 1, project: project.name, secrets: { SESSION_SECRET: {
      ownership: 'hypervibe', generator: 'random-base64url-32-v1', environments: ['staging'],
    }, FLOW_KEY: { ownership: 'delegated', principal: 'email:owner@example.test', environments: ['staging'] } },
    environments: { staging: { hosting: { provider: 'cloudrun' }, services: { web: {} },
      secretDestinations: { SESSION_SECRET: reference, FLOW_KEY: { destination: { ...destination, secretId: 'staging-flow' } } },
    } } });
    new EnvironmentRepository().create({ projectId: project.id, name: 'staging', platformBindings: {
      provider: 'cloudrun', projectId: 'synthetic-project', region: 'us-west1',
      services: { web: { serviceId: 'web-id' } },
    } });
    vi.spyOn(adapterFactory, 'getProviderAdapter').mockResolvedValue({ success: true, adapter: {
      name: 'cloudrun', capabilities: { supportsObserve: true, runtimeSecretReferenceProviders: ['gcp-secret-manager'] },
      observe: vi.fn().mockResolvedValue(observed()),
    } as never });
  });
  afterEach(() => { vi.restoreAllMocks(); SqliteAdapter.resetInstance(); fs.rmSync(directory, { recursive: true, force: true }); });

  it('does not derive or persist generated plaintext for a native destination', async () => {
    const derive = vi.spyOn(getSecretStore(), 'deriveSecret');
    expect(deriveHypervibeSecretValues(new SpecStore().get(project)!.spec, 'staging')).toEqual({});
    const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false });
    if ('error' in result) throw new Error(result.error);
    expect(derive).not.toHaveBeenCalled();
    const document = new RunRepository().findById(result.planRunId)!.plan;
    expect(document).not.toHaveProperty('overrides.delegatedSecretVarsEncrypted');
    expect(result.actions.find(a => a.id === 'secret:SESSION_SECRET')).toMatchObject({ type: 'noop' });
  });

  it('rejects a legacy resolver reference before reading it for a native destination', async () => {
    const result = await new PlanService().plan(project, 'staging', { includeEnvFile: false,
      secretRefs: { FLOW_KEY: 'dotenv:/definitely-not-present-secret-fixture#FLOW_KEY' } });
    expect(result).toMatchObject({ error: expect.stringMatching(/direct.*secret manager/i) });
  });

  it('fingerprints native version drift even when names and literal hashes are unchanged', () => {
    expect(fingerprintObservedState(observed('7'))).not.toBe(fingerprintObservedState(observed('8')));
  });

  it('admits only a verified reference action and applies the workload backup gate', () => {
    const action = { id: 'secret:SESSION_SECRET', type: 'update' as const,
      resource: { kind: 'secret' as const, name: 'SESSION_SECRET', provider: 'cloudrun' }, verified: true,
      reason: 'Install native reference', metadata: { operation: 'secretReferenceSync', ownership: 'hypervibe',
        principal: 'hypervibe', services: ['web'], reference, generator: 'random-base64url-32-v1', generation: 1,
        replacementPolicy: 'confirm', conflictsWith: [] } };
    expect(resolvePlanActionAuthority(action)?.capability).toBe('hosting.secret-reference.sync');
    expect(actionRequiresBackupReadiness(action)).toBe(true);
    expect(resolvePlanActionAuthority({ ...action, verified: false })).toBeNull();
    expect(resolvePlanActionAuthority({ ...action, resource: { ...action.resource, kind: 'service' } })).toBeNull();
    expect(resolvePlanActionAuthority({ ...action, metadata: { ...action.metadata, reference: { ...reference, version: 'latest' } } })).toBeNull();
  });
});
