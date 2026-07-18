import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeDatabase, SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { hashEnvValue, type ObservedState } from '../../ports/observe.port.js';
import { projectSpecSchema } from '../../spec/spec.schema.js';
import {
  parseDelegatedSecretBindings,
  planDelegatedSecrets,
  recordDelegatedSecretBindings,
} from '../delegated-secret.service.js';

const FRIEND_KEY = 'sk-ant-api03-friend-value';

function spec() {
  return projectSpecSchema.parse({
    version: 1,
    project: 'friend-app',
    secrets: {
      ANTHROPIC_API_KEY: {
        principal: 'github:alice',
        environments: ['production'],
      },
    },
    environments: {
      production: {
        hosting: { provider: 'railway' },
        services: { web: {} },
      },
    },
  });
}

function observed(hash?: string): ObservedState {
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    services: [{
      name: 'web',
      externalId: 'service-1',
      workloadKind: 'web',
      customDomains: [],
      config: {},
      envVarKeys: hash ? ['ANTHROPIC_API_KEY'] : [],
      envVarHashes: hash ? { ANTHROPIC_API_KEY: hash } : {},
      status: 'running',
    }],
    databases: [],
    partial: false,
    warnings: [],
  };
}

describe('delegated-secret.service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypervibe-delegated-secret-'));
    SqliteAdapter.resetInstance();
    initializeDatabase(path.join(tempDir, 'hypervibe.db'));
  });

  afterEach(() => {
    SqliteAdapter.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('requires explicit input for missing or unaccepted live values', () => {
    const missing = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observed(),
    });
    expect(missing.inputRequired).toEqual([
      expect.objectContaining({ key: 'ANTHROPIC_API_KEY', principal: 'github:alice' }),
    ]);
    expect(missing.actions[0]).toMatchObject({
      id: 'secret:ANTHROPIC_API_KEY',
      type: 'update',
      metadata: { inputRequired: true, inputProvided: false },
    });

    const unaccepted = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observed(hashEnvValue('some-other-live-key')),
    });
    expect(unaccepted.inputRequired[0]?.reason).toContain('has not been accepted');
    expect(unaccepted.warnings[0]).toContain('preserved');
  });

  it('treats an accepted matching hash as in sync and preserves drift', () => {
    const acceptedHash = hashEnvValue(FRIEND_KEY);
    const environment = {
      platformBindings: {
        delegatedEnvBindings: [{
          name: 'ANTHROPIC_API_KEY',
          principal: 'github:alice',
          valueHash: acceptedHash,
          source: 'delegated-plan-input',
          syncedAt: '2026-07-17T00:00:00.000Z',
          applyRunId: 'apply-1',
          actionId: 'secret:ANTHROPIC_API_KEY',
        }],
      },
    };

    const matching = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment,
      observed: observed(acceptedHash),
    });
    expect(matching.inputRequired).toEqual([]);
    expect(matching.actions[0]).toMatchObject({ type: 'noop', verified: true });

    const drifted = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment,
      observed: observed(hashEnvValue('changed-out-of-band')),
    });
    expect(drifted.actions[0]).toMatchObject({
      type: 'update',
      metadata: { inputRequired: true, driftPolicy: 'preserve' },
    });
    expect(drifted.inputRequired[0]?.reason).toContain('differs');
    expect(drifted.desiredEnvVars).toEqual({});
  });

  it('requires re-acceptance when the declared principal changes', () => {
    const acceptedHash = hashEnvValue(FRIEND_KEY);
    const changedPrincipalSpec = projectSpecSchema.parse({
      ...spec(),
      secrets: {
        ANTHROPIC_API_KEY: {
          principal: 'github:bob',
          environments: ['production'],
        },
      },
    });
    const planned = planDelegatedSecrets({
      spec: changedPrincipalSpec,
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: 'ANTHROPIC_API_KEY',
            principal: 'github:alice',
            valueHash: acceptedHash,
            source: 'delegated-plan-input',
            syncedAt: '2026-07-17T00:00:00.000Z',
            applyRunId: 'apply-1',
            actionId: 'secret:ANTHROPIC_API_KEY',
          }],
        },
      },
      observed: observed(acceptedHash),
    });

    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      metadata: { inputRequired: true, principal: 'github:bob' },
    });
    expect(planned.inputRequired[0]?.reason).toContain('must be re-accepted');
    expect(planned.desiredEnvVars).toEqual({});

    const unobservable = planDelegatedSecrets({
      spec: changedPrincipalSpec,
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: {
        platformBindings: {
          delegatedEnvBindings: [{
            name: 'ANTHROPIC_API_KEY',
            principal: 'github:alice',
            valueHash: acceptedHash,
            source: 'delegated-plan-input',
            syncedAt: '2026-07-17T00:00:00.000Z',
            applyRunId: 'apply-1',
            actionId: 'secret:ANTHROPIC_API_KEY',
          }],
        },
      },
      observed: null,
    });
    expect(unobservable.inputRequired[0]?.reason).toContain('must be re-accepted');
    expect(unobservable.actions[0]).toMatchObject({ type: 'update', verified: false });
  });

  it('uses a supplied value as desired input without exposing it in the action', () => {
    const planned = planDelegatedSecrets({
      spec: spec(),
      environmentName: 'production',
      hostingProvider: 'railway',
      environment: { platformBindings: {} },
      observed: observed(),
      suppliedValues: { ANTHROPIC_API_KEY: FRIEND_KEY },
    });
    expect(planned.inputRequired).toEqual([]);
    expect(planned.desiredEnvVars).toEqual({ ANTHROPIC_API_KEY: FRIEND_KEY });
    expect(planned.actions[0]).toMatchObject({
      type: 'update',
      metadata: { inputProvided: true, principal: 'github:alice' },
    });
    expect(JSON.stringify(planned.actions)).not.toContain(FRIEND_KEY);
  });

  it('records only an accepted hash after a succeeded action receipt', () => {
    const project = new ProjectRepository().create({ name: 'friend-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });

    const updated = recordDelegatedSecretBindings({
      environment,
      spec: spec(),
      environmentName: 'production',
      suppliedValues: { ANTHROPIC_API_KEY: FRIEND_KEY },
      applyRunId: 'apply-1',
      receipts: [{ actionId: 'secret:ANTHROPIC_API_KEY', status: 'succeeded' }],
      now: '2026-07-17T00:00:00.000Z',
    });

    expect(parseDelegatedSecretBindings(updated)).toEqual([{
      name: 'ANTHROPIC_API_KEY',
      principal: 'github:alice',
      valueHash: hashEnvValue(FRIEND_KEY),
      source: 'delegated-plan-input',
      syncedAt: '2026-07-17T00:00:00.000Z',
      applyRunId: 'apply-1',
      actionId: 'secret:ANTHROPIC_API_KEY',
    }]);
    expect(JSON.stringify(updated.platformBindings)).not.toContain(FRIEND_KEY);
  });

  it('does not record a value when its action receipt did not succeed', () => {
    const project = new ProjectRepository().create({ name: 'friend-app', defaultPlatform: 'railway' });
    const environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: { provider: 'railway' },
    });

    const unchanged = recordDelegatedSecretBindings({
      environment,
      spec: spec(),
      environmentName: 'production',
      suppliedValues: { ANTHROPIC_API_KEY: FRIEND_KEY },
      applyRunId: 'apply-1',
      receipts: [{ actionId: 'secret:ANTHROPIC_API_KEY', status: 'failed' }],
    });

    expect(parseDelegatedSecretBindings(unchanged)).toEqual([]);
    expect(JSON.stringify(unchanged.platformBindings)).not.toContain(FRIEND_KEY);
  });
});
