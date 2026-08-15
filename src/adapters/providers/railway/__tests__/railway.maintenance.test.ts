import { describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../../../domain/entities/environment.entity.js';
import { RailwayAdapter } from '../railway.adapter.js';

describe('RailwayAdapter maintenance', () => {
  it('removes the exact deployment and restores replicas, sleep, cron, and deployment state', async () => {
    let deploymentStatus = 'SUCCESS';
    let deploymentId = 'deployment-before-maintenance';
    const updates: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (document: unknown, variables?: Record<string, unknown>) => {
      const operation = String(document);
      if (operation.includes('query GetServiceInstance')) {
        return {
          serviceInstance: {
            numReplicas: 3,
            sleepApplication: true,
            cronSchedule: '0 * * * *',
            latestDeployment: deploymentId
              ? { id: deploymentId, status: deploymentStatus }
              : null,
          },
        };
      }
      if (operation.includes('mutation ServiceInstanceUpdate')) {
        updates.push(variables?.input as Record<string, unknown>);
        return { serviceInstanceUpdate: true };
      }
      if (operation.includes('mutation DeploymentRemove')) {
        expect(variables).toEqual({ id: 'deployment-before-maintenance' });
        deploymentStatus = 'REMOVED';
        return { deploymentRemove: true };
      }
      if (operation.includes('mutation ServiceInstanceRedeploy')) {
        deploymentId = 'deployment-after-maintenance';
        deploymentStatus = 'SUCCESS';
        return { serviceInstanceRedeploy: true };
      }
      throw new Error(`Unexpected Railway operation: ${operation}`);
    });
    const adapter = new RailwayAdapter();
    (adapter as unknown as { client: { request: typeof request } }).client = { request };
    const now = new Date();
    const environment: Environment = {
      id: 'environment-1',
      projectId: 'project-1',
      name: 'production',
      platformBindings: {
        provider: 'railway',
        projectId: 'railway-project',
        environmentId: 'railway-environment',
        services: { cron: { serviceId: 'railway-service' } },
      },
      createdAt: now,
      updatedAt: now,
    };

    const snapshot = await adapter.observeMaintenanceWorkload(
      environment,
      'railway-service',
      'cron'
    );
    await expect(adapter.suspendMaintenanceWorkload(environment, snapshot)).resolves.toMatchObject({
      success: true,
      data: { applied: 1, skipped: 0 },
    });
    await expect(adapter.resumeMaintenanceWorkload(environment, snapshot)).resolves.toMatchObject({
      success: true,
      data: { applied: 1, skipped: 0 },
    });

    expect(updates).toEqual([
      { cronSchedule: null },
      { numReplicas: 3, sleepApplication: true },
      { cronSchedule: '0 * * * *' },
    ]);
    expect(deploymentStatus).toBe('SUCCESS');
  });
});
