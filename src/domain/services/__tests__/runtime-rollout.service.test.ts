import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EnvironmentRepository } from '../../../adapters/db/repositories/environment.repository.js';
import { ProjectRepository } from '../../../adapters/db/repositories/project.repository.js';
import { SqliteAdapter } from '../../../adapters/db/sqlite.adapter.js';
import type { Environment } from '../../entities/environment.entity.js';
import type { ActionReceipt } from '../../plan/converge.executor.js';
import type { PlanAction } from '../../plan/plan.types.js';
import type { ObservedState } from '../../ports/observe.port.js';
import { hashEnvValue } from '../../ports/observe.port.js';
import {
  parseRuntimeRolloutBindings,
  pendingCredentialOperations,
  acceptManagedCredentialActivation,
  recordRuntimeRolloutRequirements,
  runtimeRolloutRequirements,
} from '../runtime-rollout.service.js';

const action: PlanAction = {
  id: 'secret:ANTHROPIC_API_KEY',
  type: 'update',
  resource: { kind: 'secret', name: 'ANTHROPIC_API_KEY', provider: 'railway' },
  verified: true,
  reason: 'Converge delegated secret',
  metadata: {
    operation: 'delegatedSecretSync',
    principal: 'github:alice',
    services: ['worker'],
  },
};

const serviceAction: PlanAction = {
  id: 'service:worker',
  type: 'update',
  resource: { kind: 'service', name: 'worker', provider: 'railway' },
  verified: true,
  reason: 'Converge worker configuration',
};

function observed(deploymentId: string, status: 'running' | 'failed' = 'running'): ObservedState {
  return {
    provider: 'railway',
    observedAt: '2026-08-20T20:25:00.000Z',
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-environment',
    services: [{
      name: 'worker',
      externalId: 'rail-worker',
      workloadKind: 'worker',
      customDomains: [],
      config: { startCommand: 'npm run worker' },
      sourceState: 'disconnected',
      envVarKeys: ['ANTHROPIC_API_KEY'],
      envVarHashes: { ANTHROPIC_API_KEY: 'accepted-hash' },
      status,
      deployment: {
        id: deploymentId,
        status: status === 'running' ? 'SUCCESS' : 'FAILED',
      },
      maintenance: {
        state: status === 'running' ? 'running' : 'unknown',
        deploymentId,
        deploymentStatus: status === 'running' ? 'SUCCESS' : 'FAILED',
      },
    }],
    databases: [],
    completeness: { services: 'complete' },
    partial: false,
    warnings: [],
  };
}

describe('runtime rollout state', () => {
  let tempDir: string;
  let environment: Environment;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'hypervibe-runtime-rollout-'));
    SqliteAdapter.resetInstance();
    SqliteAdapter.getInstance(path.join(tempDir, 'hypervibe.db')).migrate();
    const project = new ProjectRepository().create({
      name: 'runtime-rollout-app',
      defaultPlatform: 'railway',
    });
    environment = new EnvironmentRepository().create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'rail-project',
        environmentId: 'rail-environment',
        services: { worker: { serviceId: 'rail-worker' } },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Independent requirement: deployment success and configured variables do not
  // establish the deployment snapshot's values or retirement of old processes.
  // Railway documents redeploy as reusing an earlier deployment's configuration:
  // https://docs.railway.com/deployments/deployment-actions
  const intendedHashes = { DATABASE_URL: hashEnvValue('synthetic-intended-url'), POSTGRES_DB_URL: hashEnvValue('synthetic-intended-url') };
  function strictRequirement(environment: Environment, before = observed('old'), applyRunId = 'db-change') {
    return recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: before,
      actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true } }], applyRunId,
      expectedConfiguration: { worker: { operationId: 'database-change-1', envVarHashes: intendedHashes } },
    });
  }

  function deployed(id: string, hashes: Record<string, string> = intendedHashes): ObservedState {
    const result = observed(id);
    result.services[0].envVarHashes = intendedHashes;
    Object.assign(result.services[0].deployment!, {
      activeDeploymentIds: [id], configurationState: 'resolved', envVarHashes: hashes,
    });
    return result;
  }

  function nativeRequirement(keys = Object.keys(intendedHashes)) {
    return recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: deployed('old'),
      actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, configurationUpdated: true, credentialValueEvidence: 'acknowledgement', credentialKeys: keys, deploymentId: 'native-replacement', credentialUpdateActivation: 'provider-rollout' } }], applyRunId: 'native-change',
      expectedConfiguration: { worker: { operationId: 'native-change', envVarHashes: intendedHashes } },
    });
  }

  it('binds native activation to the exact acknowledged deployment, even if another deployment has equal values', () => {
    const updated = nativeRequirement();
    expect(parseRuntimeRolloutBindings(updated)[0]).toMatchObject({ expectedDeploymentId: 'native-replacement', configurationAccepted: 'acknowledgement', configurationAcceptedKeys: Object.keys(intendedHashes).sort() });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: deployed('unrelated-newer') })).toHaveLength(1);
  });

  it('keeps exact acknowledged native deployment pending until instances retire', () => {
    const updated = nativeRequirement();
    const next = deployed('native-replacement');
    delete next.services[0].deployment!.envVarHashes;
    next.services[0].deployment!.configurationState = 'unknown';
    next.services[0].deployment!.activeDeploymentCoverage = 'traffic';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
    next.services[0].deployment!.configurationState = 'resolved';
    next.services[0].deployment!.envVarHashes = intendedHashes;
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
    next.services[0].deployment!.activeDeploymentCoverage = 'instances';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
    next.services[0].deployment!.activeDeploymentIds = ['old', 'native-replacement'];
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('does not add the acknowledged replacement to the old-instance baseline during readback', () => {
    const next = deployed('native-replacement'); next.services[0].deployment!.activeDeploymentCoverage = 'instances';
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: next,
      actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, configurationUpdated: true, credentialValueEvidence: 'readback', credentialKeys: Object.keys(intendedHashes), deploymentId: 'native-replacement', credentialUpdateActivation: 'provider-rollout', rolloutBaseline: { state: 'present', deploymentId: 'old' } } }], applyRunId: 'native-change',
      expectedConfiguration: { worker: { operationId: 'native-change', envVarHashes: intendedHashes } },
    });
    expect(parseRuntimeRolloutBindings(updated)[0].baselineDeployment.activeDeploymentIds ?? []).not.toContain('native-replacement');
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
  });

  it('accepts only the complete exact replacement instance set from the acknowledged rollout', () => {
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: deployed('old'),
      actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, configurationUpdated: true, credentialValueEvidence: 'acknowledgement', credentialKeys: Object.keys(intendedHashes), deploymentId: 'instance-a', deploymentIds: ['instance-a', 'instance-b'], credentialUpdateActivation: 'provider-rollout' } }], applyRunId: 'native-change',
      expectedConfiguration: { worker: { operationId: 'native-change', envVarHashes: intendedHashes } },
    });
    const next = deployed('instance-a'); delete next.services[0].deployment!.envVarHashes;
    Object.assign(next.services[0].deployment!, { configurationState: 'unknown', activeDeploymentCoverage: 'instances', activeDeploymentIds: ['instance-b', 'instance-a'] });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
    next.services[0].deployment!.id = 'instance-b';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
    next.services[0].deployment!.activeDeploymentIds = ['instance-a'];
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('accepts a completed cron execution with immutable new configuration after all old executions stop', () => {
    const updated = strictRequirement(environment);
    const next = deployed('new-execution'); next.services[0].workloadKind = 'cron';
    Object.assign(next.services[0].deployment!, { status: 'completed', activeDeploymentIds: [], activeDeploymentCoverage: 'instances' });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
    next.services[0].deployment!.activeDeploymentIds = ['old'];
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('proves a later immutable cron execution even when no prior execution was observable', () => {
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: null, actions: [action],
      receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, services: ['worker'], rolloutBaseline: { state: 'unknown' } } }],
      applyRunId: 'job-update', now: '2026-10-25T00:00:00Z', expectedConfiguration: { worker: { operationId: 'job-update', envVarHashes: intendedHashes } },
    });
    expect(parseRuntimeRolloutBindings(updated)[0].serviceExternalId).toBe('rail-worker');
    const next = deployed('new-execution'); next.services[0].workloadKind = 'cron';
    Object.assign(next.services[0].deployment!, { status: 'completed', createdAt: '2026-10-25T00:01:00Z', activeDeploymentIds: [], activeDeploymentCoverage: 'instances' });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
    next.services[0].deployment!.createdAt = '2026-10-24T23:59:00Z';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('retains the full provider receipt baseline before replacement rollout', () => {
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: null, actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, rolloutBaseline: { state: 'present', deploymentId: 'old', activeDeploymentIds: ['older', 'old'] } } }], applyRunId: 'configuration' });
    expect(parseRuntimeRolloutBindings(updated)[0].baselineDeployment.activeDeploymentIds).toEqual(['older', 'old']);
  });

  it('binds managed CI evidence to the exact accepted operation without publishing secret fingerprints', () => {
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: deployed('old'), actions: [action],
      receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, configurationUpdated: true, credentialValueEvidence: 'acknowledgement', credentialKeys: Object.keys(intendedHashes), credentialUpdateActivation: 'deferred', configurationVersion: 42 } }], applyRunId: 'managed-change', expectedConfiguration: { worker: { operationId: 'managed-change', envVarHashes: intendedHashes } } });
    const expectedOperations = pendingCredentialOperations(updated);
    expect(expectedOperations).toEqual({ worker: { operationId: 'managed-change', serviceId: 'rail-worker', configurationVersion: 42 } });
    const evidence = { version: 1, operations: [{ service: 'worker', serviceId: 'rail-worker', operationId: 'managed-change', deploymentIds: ['exact-ci-deployment'], configurationVersion: 42 }] };
    expect(() => acceptManagedCredentialActivation({ environment: updated, provider: 'railway', evidence: { ...evidence, operations: [{ ...evidence.operations[0], configurationVersion: 41 }] }, expectedOperations })).toThrow(/configuration version/);
    expect(acceptManagedCredentialActivation({ environment: updated, provider: 'railway', evidence, expectedOperations })).toEqual(evidence.operations);
    const after = new EnvironmentRepository().findById(environment.id)!;
    const deployedState = deployed('exact-ci-deployment'); delete deployedState.services[0].deployment!.envVarHashes;
    deployedState.services[0].deployment!.activeDeploymentCoverage = 'traffic';
    expect(runtimeRolloutRequirements({ environment: after, provider: 'railway', observed: deployedState })).toHaveLength(1);
    deployedState.services[0].deployment!.activeDeploymentCoverage = 'instances';
    expect(runtimeRolloutRequirements({ environment: after, provider: 'railway', observed: deployedState })).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain(intendedHashes.DATABASE_URL);
    expect(() => acceptManagedCredentialActivation({ environment: after, provider: 'railway', evidence: { ...evidence, operations: [{ ...evidence.operations[0], operationId: 'other-operation' }] }, expectedOperations })).toThrow(/different accepted/);
    expect(() => acceptManagedCredentialActivation({ environment: after, provider: 'railway', evidence: { ...evidence, operations: [{ ...evidence.operations[0], deploymentIds: ['old'] }] }, expectedOperations })).toThrow(/pre-rotation/);
  });

  it('does not certify all aliases from one successful native selected-key write', () => {
    const updated = nativeRequirement(['DATABASE_URL']);
    const next = deployed('native-replacement'); delete next.services[0].deployment!.envVarHashes;
    next.services[0].deployment!.configurationState = 'unknown';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('retains a credential rollout when successful replacement still has stale deployed credentials', () => {
    const updated = strictRequirement(environment);
    const replacement = deployed('successful-redeploy', { ...intendedHashes, POSTGRES_DB_URL: hashEnvValue('synthetic-old-url') });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: replacement }))
      .toEqual([expect.objectContaining({ reason: expect.stringContaining('intended configuration') })]);
    expect(JSON.stringify(updated.platformBindings)).not.toContain(intendedHashes.DATABASE_URL);
    expect(JSON.stringify(updated.platformBindings)).not.toContain('synthetic-intended-url');
  });

  it('requires exact scope and complete active deployment evidence even without a baseline inventory', () => {
    const updated = strictRequirement(environment);
    const next = deployed('new');
    delete next.services[0].deployment!.activeDeploymentIds;
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
    next.services[0].deployment!.activeDeploymentIds = ['new'];
    next.environmentId = 'different-environment';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
    next.environmentId = 'rail-environment';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
  });

  it('cannot substitute configured values for missing or unresolved deployment snapshot evidence', () => {
    const updated = strictRequirement(environment);
    for (const state of [undefined, 'unknown'] as const) {
      const next = deployed('new');
      Object.assign(next.services[0].deployment!, { configurationState: state });
      expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
    }
  });

  it('keeps an overlapping deployment pending even when it was absent from the baseline inventory', () => {
    const updated = strictRequirement(environment);
    const next = deployed('new'); next.services[0].deployment!.activeDeploymentIds = ['unobserved-old', 'new'];
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('keeps each affected workload pending independently after a partial rollout', () => {
    const before = observed('old');
    before.services.push({ ...before.services[0], name: 'web', externalId: 'rail-web' });
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: before,
      actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true, services: ['web', 'worker'] } }], applyRunId: 'partial',
      expectedConfiguration: Object.fromEntries(['web', 'worker'].map(name => [name, { operationId: 'partial', envVarHashes: intendedHashes }])),
    });
    const next = deployed('worker-new');
    next.services.push({ ...before.services[1], envVarHashes: intendedHashes });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next }).map(item => item.service)).toEqual(['web']);
    next.services[1] = { ...deployed('web-new').services[0], name: 'web', externalId: 'rail-web' };
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
  });

  it('preserves the original credential requirement and overlapping deployments across apply retries', () => {
    const before = observed('old'); before.services[0].deployment!.activeDeploymentIds = ['older', 'old'];
    const updated = strictRequirement(environment, before);
    const next = deployed('new'); next.services[0].deployment!.activeDeploymentIds = ['older', 'new'];
    const retried = strictRequirement(updated, next, 'retry-apply');
    expect(parseRuntimeRolloutBindings(retried)[0].baselineDeployment).toEqual({ state: 'present', id: 'old', activeDeploymentIds: ['older', 'old'] });
    expect(runtimeRolloutRequirements({ environment: retried, provider: 'railway', observed: next })).toHaveLength(1);
    next.services[0].deployment!.activeDeploymentIds = ['new'];
    expect(runtimeRolloutRequirements({ environment: retried, provider: 'railway', observed: next })).toEqual([]);
  });

  it.each(['non-array', 'missing-operation', 'missing-expectation', 'invalid-baseline', 'invalid-action-ids', 'duplicate-consumer'])('fails closed instead of discarding malformed %s rollout state', kind => {
    const updated = strictRequirement(environment);
    const retained = updated.platformBindings.runtimeRollouts as Array<Record<string, unknown>>;
    if (kind === 'non-array') updated.platformBindings.runtimeRollouts = {};
    if (kind === 'missing-operation') delete retained[0].operationId;
    if (kind === 'missing-expectation') delete retained[0].configurationExpectationEncrypted;
    if (kind === 'invalid-baseline') retained[0].baselineDeployment = { state: 'present' };
    if (kind === 'invalid-action-ids') retained[0].actionIds = [null];
    if (kind === 'duplicate-consumer') retained.push({ ...retained[0] });
    expect(() => runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: deployed('new') }))
      .toThrow(/rollout.*state|runtime.*state/i);
  });

  it.each(['null-result', 'misleading-success-result'])('does not acknowledge a credential requirement after %s without durable persistence', failure => {
    vi.spyOn(EnvironmentRepository.prototype, 'updatePlatformBindings').mockImplementation((_id, patch) => failure === 'null-result'
      ? null : { ...environment, platformBindings: { ...environment.platformBindings, ...patch } });
    expect(() => strictRequirement(environment)).toThrow(/persist|durable/i);
    expect(new EnvironmentRepository().findById(environment.id)!.platformBindings.runtimeRollouts).toBeUndefined();
  });

  it('checks durable credential requirements even when the supplied in-memory state appears unchanged', () => {
    const before = observed('old'); before.services[0].deployment!.activeDeploymentIds = ['old'];
    const updated = strictRequirement(environment, before);
    new EnvironmentRepository().updatePlatformBindings(environment.id, { runtimeRollouts: [] });
    expect(() => strictRequirement(updated, before)).toThrow(/persist|durable/i);
  });

  it('keeps rollout pending when an old deployment remains active after a new one succeeds', () => {
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: observed('old'), actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true } }], applyRunId: 'rotation' });
    const next = observed('new');
    Object.assign(next.services[0].deployment!, { activeDeploymentIds: ['old', 'new'] });
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([expect.objectContaining({ reason: expect.stringContaining('old deployment remains active') })]);
  });

  it('does not use a different service identity as activation evidence', () => {
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: observed('old'), actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true } }], applyRunId: 'rotation' });
    const next = observed('new'); next.services[0].externalId = 'unrelated-service';
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toHaveLength(1);
  });

  it('waits for every observed pre-rotation deployment, including older overlapping instances', () => {
    const before = observed('old-latest');
    before.services[0].deployment!.activeDeploymentIds = ['old-earlier', 'old-latest'];
    const updated = recordRuntimeRolloutRequirements({ environment, provider: 'railway', observed: before, actions: [action], receipts: [{ actionId: action.id, status: 'succeeded', data: { runtimeRolloutRequired: true } }], applyRunId: 'rotation' });
    const next = observed('new');
    next.services[0].deployment!.activeDeploymentIds = ['old-earlier', 'new'];
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([expect.objectContaining({ reason: expect.stringContaining('old deployment remains active') })]);
    next.services[0].deployment!.activeDeploymentIds = ['new'];
    expect(runtimeRolloutRequirements({ environment: updated, provider: 'railway', observed: next })).toEqual([]);
  });

  it('keeps deferred configuration restart_required until a newer deployment is running', () => {
    const receipt: ActionReceipt = {
      actionId: action.id,
      status: 'succeeded',
      data: {
        deploymentDeferred: true,
        runtimeRolloutRequired: true,
        services: ['worker'],
        rolloutBaselines: {
          worker: { state: 'present', deploymentId: 'deployment-2008' },
        },
      },
    };
    const updated = recordRuntimeRolloutRequirements({
      environment,
      provider: 'railway',
      observed: observed('deployment-before-plan'),
      actions: [action, serviceAction],
      receipts: [receipt, {
        actionId: serviceAction.id,
        status: 'succeeded',
        data: { deploymentDeferred: true, runtimeRolloutRequired: true },
      }],
      applyRunId: 'apply-2025',
      now: '2026-08-20T20:25:00.000Z',
    });

    expect(parseRuntimeRolloutBindings(updated)).toEqual([{
      service: 'worker',
      provider: 'railway',
      serviceExternalId: 'rail-worker',
      baselineDeployment: { state: 'present', id: 'deployment-2008' },
      requiredAt: '2026-08-20T20:25:00.000Z',
      applyRunId: 'apply-2025',
      actionIds: ['secret:ANTHROPIC_API_KEY', 'service:worker'],
    }]);
    expect(runtimeRolloutRequirements({
      environment: updated,
      provider: 'railway',
      observed: observed('deployment-2008'),
    })).toEqual([expect.objectContaining({
      service: 'worker',
      provider: 'railway',
      requiredSince: '2026-08-20T20:25:00.000Z',
      reason: expect.stringContaining('still running the deployment'),
    })]);

    expect(runtimeRolloutRequirements({
      environment: updated,
      provider: 'railway',
      observed: observed('deployment-2030'),
    })).toEqual([]);
    expect(runtimeRolloutRequirements({
      environment: updated,
      provider: 'railway',
      observed: observed('deployment-2030', 'failed'),
    })).toEqual([expect.objectContaining({
      service: 'worker',
      reason: expect.stringContaining('failed'),
    })]);
  });

  it('does not create rollout state without a succeeded runtime-rollout receipt', () => {
    for (const receipt of [
      {
        actionId: action.id,
        status: 'failed' as const,
        data: { deploymentDeferred: true, runtimeRolloutRequired: true },
      },
      {
        actionId: action.id,
        status: 'succeeded' as const,
        data: { deploymentDeferred: true },
      },
      { actionId: action.id, status: 'succeeded' as const },
    ]) {
      const updated = recordRuntimeRolloutRequirements({
        environment,
        provider: 'railway',
        observed: observed('deployment-2008'),
        actions: [action],
        receipts: [receipt],
        applyRunId: 'apply-2025',
      });
      expect(parseRuntimeRolloutBindings(updated)).toEqual([]);
    }
  });

  it('fails closed when the pre-apply deployment identity was unknown', () => {
    const updated = recordRuntimeRolloutRequirements({
      environment,
      provider: 'railway',
      observed: null,
      actions: [action],
      receipts: [{
        actionId: action.id,
        status: 'succeeded',
        data: {
          deploymentDeferred: true,
          runtimeRolloutRequired: true,
          services: ['worker'],
        },
      }],
      applyRunId: 'apply-2025',
    });

    expect(parseRuntimeRolloutBindings(updated)[0]?.baselineDeployment).toEqual({ state: 'unknown' });
    expect(runtimeRolloutRequirements({
      environment: updated,
      provider: 'railway',
      observed: observed('deployment-2030'),
    })[0]?.reason).toContain('could not prove');
  });
});
