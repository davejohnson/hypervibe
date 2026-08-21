import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import {
  parseRuntimeRolloutBindings,
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
    SqliteAdapter.resetInstance();
    rmSync(tempDir, { recursive: true, force: true });
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
