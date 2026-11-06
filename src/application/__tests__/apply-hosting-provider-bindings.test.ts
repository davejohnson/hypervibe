import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../adapters/db/sqlite.adapter.js';
import type { IHostingAdapter } from '../../domain/ports/hosting.port.js';
import type { PlanAction } from '../../domain/plan/plan.types.js';
import { PlanService } from '../../domain/plan/plan.service.js';
import { adapterFactory } from '../../domain/services/adapter.factory.js';
import { projectSpecSchema } from '../../domain/spec/spec.schema.js';
import { executePlanApply } from '../apply-plan.js';
import { createCommandContext, type CommandContext } from '../context.js';
import '../providers.js';
import { providerRegistry } from '../../domain/registry/provider.registry.js';
import { z } from 'zod';

// Synthetic lifecycle owners exercise shared safety without restoring cloud CRUD.
for (const [name, teardownBoundary] of [['fixture-hosting', 'services'], ['fixture-project-hosting', 'project']] as const) {
  providerRegistry.register({
    metadata: {
      name, displayName: `Synthetic ${name}`, category: 'deployment', credentialsSchema: z.object({}),
      lifecycle: { hosting: { workloadKinds: ['web', 'worker', 'cron'], customDomains: 'unsupported', teardownBoundary } },
      maturity: { lifecycle: { hosting: { status: 'ready-for-live' } } },
    },
    inspection: {
      resources: ['environment'], defaultResource: 'environment',
      selectors: { environment: { mode: 'environment-forensics', optional: ['project', 'env', 'limit'], list: true } },
      inspect: async () => { throw new Error('Synthetic inventory requires explicit observations.'); },
    },
    factory: () => { throw new Error('Synthetic hosting requires an explicit test adapter.'); },
  });
}

describe('hosting project provider bindings', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    SqliteAdapter.resetInstance();
    const directory = mkdtempSync(path.join(tmpdir(), 'hypervibe-hosting-bindings-'));
    SqliteAdapter.getInstance(path.join(directory, 'test.db')).migrate();
    ctx = createCommandContext();
    vi.spyOn(PlanService.prototype, 'preflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'providerPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'projectPreflight').mockReturnValue([]);
    vi.spyOn(PlanService.prototype, 'observeEnvironment').mockResolvedValue({ observed: null, warnings: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SqliteAdapter.resetInstance();
  });

  it('persists safe provider-owned project identity beside canonical hosting fields', async () => {
    const project = ctx.repos.projects.create({ name: 'aws-network-app', defaultPlatform: 'fixture-project-hosting' });
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {},
    });
    const clusterArn = 'arn:aws:fixture-project-hosting:us-west-2:123456789012:cluster/hv-aws-network-app-production';
    const awsNetwork = {
      accountId: '123456789012',
      region: 'us-west-2',
      vpcId: 'vpc-default',
      subnetIds: ['subnet-a', 'subnet-b'],
      workloadSecurityGroupId: 'sg-workloads',
    };
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'fixture-project-hosting',
        ensureProject: vi.fn().mockResolvedValue({
          success: true,
          message: 'AWS project verified',
          data: {
            projectId: clusterArn,
            environmentId: clusterArn,
            created: true,
            providerBindings: { awsNetwork },
          },
        }),
      } as unknown as IHostingAdapter,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: {
        production: { hosting: { provider: 'fixture-project-hosting', region: 'us-west-2' }, services: {} },
      },
    });
    const action: PlanAction = {
      id: 'project:fixture-project-hosting',
      type: 'create',
      resource: { kind: 'project', name: 'production', provider: 'fixture-project-hosting' },
      verified: true,
      reason: 'No ECS project exists',
    };
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan',
        environmentName: 'production',
        specRevision: 1,
        observedFingerprint: null,
        actions: [action],
      },
    });

    const outcome = await executePlanApply(ctx, {
      project,
      spec,
      specRevision: 1,
      planId: plan.id,
      confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: true, receipts: [{ actionId: action.id, status: 'succeeded' }] },
    });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toMatchObject({
      provider: 'fixture-project-hosting',
      projectId: clusterArn,
      environmentId: clusterArn,
      services: {},
      awsNetwork,
    });
  });

  it.each([
    ['same provider, new region', { projectId: 'old-gcp-project', region: 'us-west1' }],
    ['same provider, new project', { projectId: 'new-gcp-project', region: 'us-east1' }],
    ['omitted returned scope', undefined],
  ])('retains old hosting identity during a %s apply', async (_label, nextScope) => {
    const oldScope = { projectId: 'old-gcp-project', region: 'us-east1' };
    const project = ctx.repos.projects.create({ name: 'scope-transition-app', defaultPlatform: 'fixture-hosting' });
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'fixture-hosting',
        projectId: 'logical-production',
        environmentId: 'us-east1',
        providerScope: oldScope,
        services: { web: { serviceId: 'old-web' } },
      },
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'fixture-hosting',
        ensureProject: vi.fn().mockResolvedValue({
          success: true,
          message: 'GCP scope verified',
          data: {
            projectId: 'logical-production',
            ...(nextScope
              ? { environmentId: nextScope.region, providerBindings: { providerScope: nextScope } }
              : {}),
          },
        }),
      } as unknown as IHostingAdapter,
    });
    const spec = projectSpecSchema.parse({
      version: 1,
      project: project.name,
      environments: { production: { hosting: { provider: 'fixture-hosting' }, services: {} } },
    });
    const action: PlanAction = {
      id: 'project:fixture-hosting',
      type: 'update',
      resource: { kind: 'project', name: 'production', provider: 'fixture-hosting' },
      verified: true,
      reason: 'Reconcile canonical provider scope',
    };
    const plan = ctx.repos.runs.create({
      projectId: project.id,
      environmentId: environment.id,
      type: 'plan',
      plan: {
        kind: 'hv_plan', environmentName: 'production', specRevision: 1,
        observedFingerprint: null, actions: [action],
      },
    });

    const outcome = await executePlanApply(ctx, {
      project, spec, specRevision: 1, planId: plan.id, confirmActions: [],
    });

    expect(outcome).toMatchObject({
      kind: 'executed',
      result: { success: true, receipts: [{ actionId: action.id, status: 'succeeded' }] },
    });
    expect(ctx.repos.environments.findById(environment.id)?.platformBindings).toEqual({
      provider: 'fixture-hosting',
      projectId: 'logical-production',
      ...(nextScope ? { environmentId: nextScope.region, providerScope: nextScope } : {}),
      services: {},
      previousHosting: {
        provider: 'fixture-hosting',
        projectId: 'logical-production',
        environmentId: 'us-east1',
        providerScope: oldScope,
        services: { web: { serviceId: 'old-web' } },
      },
    });
  });

  it('rehomes exact service-create recovery during a normal apply scope transition', async () => {
    const oldScope = { projectId: 'old-gcp-project', region: 'us-east1' };
    const recovery = {
      provider: 'fixture-hosting', operation: 'create' as const, resourceName: 'worker', providerScope: oldScope,
      state: 'identified' as const, serviceId: 'old-worker', returnedName: 'worker',
    };
    const project = ctx.repos.projects.create({ name: 'recovery-transition-app', defaultPlatform: 'fixture-hosting' });
    const environment = ctx.repos.environments.create({
      projectId: project.id,
      name: 'production',
      platformBindings: {
        provider: 'fixture-hosting', projectId: 'logical-production', environmentId: 'us-east1',
        providerScope: oldScope, services: {}, serviceCreateRecovery: { worker: recovery },
      },
    });
    vi.spyOn(adapterFactory, 'getHostingAdapter').mockResolvedValue({
      success: true,
      adapter: {
        name: 'fixture-hosting',
        ensureProject: vi.fn().mockResolvedValue({
          success: true,
          message: 'GCP scope verified',
          data: {
            projectId: 'logical-production', environmentId: 'us-west1',
            providerBindings: { providerScope: { projectId: 'old-gcp-project', region: 'us-west1' } },
          },
        }),
      } as unknown as IHostingAdapter,
    });
    const spec = projectSpecSchema.parse({
      version: 1, project: project.name,
      environments: { production: { hosting: { provider: 'fixture-hosting' }, services: {} } },
    });
    const action: PlanAction = {
      id: 'project:fixture-hosting', type: 'update',
      resource: { kind: 'project', name: 'production', provider: 'fixture-hosting' },
      verified: true, reason: 'Reconcile canonical provider scope',
    };
    const plan = ctx.repos.runs.create({
      projectId: project.id, environmentId: environment.id, type: 'plan',
      plan: { kind: 'hv_plan', environmentName: 'production', specRevision: 1, observedFingerprint: null, actions: [action] },
    });

    const outcome = await executePlanApply(ctx, { project, spec, specRevision: 1, planId: plan.id, confirmActions: [] });

    expect(outcome).toMatchObject({ kind: 'executed', result: { success: true } });
    const updated = ctx.repos.environments.findById(environment.id)?.platformBindings;
    expect(updated).not.toHaveProperty('serviceCreateRecovery');
    expect(updated).toMatchObject({
      previousHosting: {
        providerScope: oldScope,
        serviceCreateRecovery: { worker: recovery },
        services: { worker: { serviceId: 'old-worker', createRecovery: recovery } },
      },
    });
  });
});
