import { vi } from 'vitest';
import type { Component } from '../../../domain/entities/component.entity.js';
import type { Environment } from '../../../domain/entities/environment.entity.js';
import type { ObservedState } from '../../../domain/ports/observe.port.js';
import { RailwayAdapter } from '../railway/railway.adapter.js';
import { createRailwayDatabaseAdapter } from '../railway/railway-database.factory.js';
import {
  runDatabaseProviderParityContract,
  type DatabaseLifecycleParityFixture,
  type DatabaseLifecycleParityScenario,
} from './database-lifecycle.contract.js';

const RESOURCE_NAME = 'invoice-perfect-production-postgres';
const EXTERNAL_IDS: [string, string] = [RESOURCE_NAME, 'invoice-perfect-production-postgres-duplicate'];

function makeEnvironment(
  platformBindings: Record<string, unknown> = {}
): Environment {
  const now = new Date();
  return {
    id: 'env-1',
    projectId: 'project-1',
    name: 'production',
    platformBindings,
    createdAt: now,
    updatedAt: now,
  };
}

function makeComponent(
  provider: string,
  externalId: string,
  bindings: Record<string, unknown> = {}
): Component {
  const now = new Date();
  return {
    id: 'component-1',
    environmentId: 'env-1',
    type: 'postgres',
    externalId,
    bindings: { provider, ...bindings },
    createdAt: now,
    updatedAt: now,
  };
}

function railwayObservedState(
  scenario: DatabaseLifecycleParityScenario
): ObservedState {
  const identityConflict = scenario === 'identity_conflict';
  return {
    provider: 'railway',
    observedAt: new Date().toISOString(),
    projectExists: true,
    projectId: 'rail-project',
    environmentId: 'rail-env',
    services: [],
    databases: identityConflict
      ? EXTERNAL_IDS.map((externalId) => ({
        provider: 'railway',
        engine: 'postgres',
        externalId,
        name: RESOURCE_NAME,
        status: 'running',
      }))
      : [],
    partial: scenario === 'observation_unknown',
    warnings: scenario === 'observation_unknown' ? ['database observation unavailable'] : [],
    completeness: {
      project: 'complete',
      environment: 'complete',
      services: 'complete',
      databases: scenario === 'observation_unknown' ? 'unknown' : 'complete',
    },
  };
}

async function setupRailway(
  scenario: DatabaseLifecycleParityScenario
): Promise<DatabaseLifecycleParityFixture> {
  const mutations: unknown[] = [];
  let observations = 0;
  let hostingAdapter: RailwayAdapter | Record<string, unknown>;

  if (scenario === 'observation_unknown' || scenario === 'identity_conflict') {
    hostingAdapter = {
      name: 'railway',
      capabilities: {
        supportedBuilders: ['nixpacks'],
        supportedComponents: ['postgres'],
        supportsAutoWiring: true,
        supportsHealthChecks: true,
      },
      observe: vi.fn(async () => {
        observations += 1;
        return railwayObservedState(scenario);
      }),
      ensureComponent: vi.fn(async () => {
        mutations.push('ensureComponent');
        throw new Error('Provisioning should be blocked by observation');
      }),
      ensureProject: vi.fn(),
      listPlugins: vi.fn(async () => []),
    };
  } else {
    const railway = new RailwayAdapter();
    let deleteAcknowledged = false;
    let postDeleteReads = 0;
    const request = vi.fn(async (
      document: unknown,
      variables: Record<string, unknown> = {}
    ) => {
      const operation = String(document);
      if (operation.includes('query GetServiceEnvironmentInstance')) {
        observations += 1;
        if (scenario === 'already_absent') {
          return { serviceInstance: null };
        }
        if (scenario === 'delete_observation_unknown') {
          throw new Error('Railway database observation unavailable');
        }
        if (deleteAcknowledged) {
          postDeleteReads += 1;
          if (postDeleteReads >= 2) {
            return { serviceInstance: null };
          }
        }
        return {
          serviceInstance: {
            id: 'rail-db-instance',
            serviceId: EXTERNAL_IDS[0],
            environmentId: 'rail-env',
            deletedAt: null,
          },
        };
      }
      if (operation.includes('query GetServiceInstanceInventory')) {
        observations += 1;
        return {
          service: {
            id: EXTERNAL_IDS[0],
            projectId: 'rail-project',
            serviceInstances: {
              edges: [{ node: { id: 'rail-db-instance', environmentId: 'rail-env' } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      if (operation.includes('mutation DeleteEnvironmentService')) {
        if (variables.id !== EXTERNAL_IDS[0] || variables.environmentId !== 'rail-env') {
          throw new Error('Expected exact environment-scoped Railway service deletion');
        }
        mutations.push({ document, variables });
        deleteAcknowledged = true;
        return { serviceDelete: true };
      }
      throw new Error(`Unexpected Railway request: ${operation}`);
    });
    (railway as unknown as { client: { request: typeof request } }).client = { request };
    hostingAdapter = railway;
  }

  vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_ATTEMPTS', '4');
  vi.stubEnv('HYPERVIBE_RAILWAY_DELETE_DELAY_MS', '0');
  const adapter = createRailwayDatabaseAdapter({
    hostingAdapter: hostingAdapter as never,
    envRepo: {
      findById: () => makeEnvironment({ projectId: 'rail-project', environmentId: 'rail-env' }),
    } as never,
  });
  return {
    adapter,
    mutations: () => mutations,
    observations: () => observations,
  };
}

const providers: Array<{
  displayName: string;
  provider: string;
  setup(scenario: DatabaseLifecycleParityScenario): Promise<DatabaseLifecycleParityFixture>;
  platformBindings?: Record<string, unknown>;
  componentBindings?: Record<string, unknown>;
}> = [
  {
    displayName: 'Railway',
    provider: 'railway',
    setup: setupRailway,
    platformBindings: { projectId: 'rail-project', environmentId: 'rail-env' },
    componentBindings: {
      providerScope: { projectId: 'rail-project' },
      resourceKind: 'service',
    },
  },
];

for (const provider of providers) {
  runDatabaseProviderParityContract({
    displayName: provider.displayName,
    externalIds: EXTERNAL_IDS,
    resourceName: RESOURCE_NAME,
    makeEnvironment: () => makeEnvironment(provider.platformBindings),
    makeComponent: (externalId) => makeComponent(
      provider.provider,
      externalId,
      provider.componentBindings
    ),
    setup: provider.setup,
  });
}
